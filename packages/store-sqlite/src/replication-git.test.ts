/**
 * Сквозная репликация двух воркспейсов через НАСТОЯЩИЙ путь S42: export в
 * ветку git → мерж драйвером оплога → import на второй реплике. Здесь
 * встречаются четыре находки внешнего анализа (тег kimi) разом, как они
 * встречаются в жизни — в одной синхронизации:
 *
 *  - закрытие взятой задачи доезжает (memory-tvw65jjgaheh), в том числе
 *    закрытие, журналированное старым бинарём (бэкфилл экспортом);
 *  - конкурентные add/remove одного ребра сходятся (memory-86eqge02q8rd);
 *  - контент-дубликат с двух сайтов не ломает импорт (memory-0fs4rfa6xmha);
 *  - операция, отложенная ранней частичной доставкой, догоняется, когда её
 *    узел приходит импортом (memory-nvx51d0kgf2t).
 *
 * git — локальный бинарь, сети нет; всё во временном каталоге.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HlcClock,
  contentHash,
  emptyState,
  generateId,
  isEdgeAlive,
  merge,
  packHlc,
  type DbDriver,
  type Op,
  type OpFactory,
} from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, Q, rowToOp } from "./queries.ts";
import {
  exportGraph,
  lineToRow,
  readOplogFiles,
  renderProjectionFiles,
  splitLines,
  OPLOG_MERGE_DRIVER,
  type ExportResult,
} from "./export.ts";
import { importGraph, type ImportResult } from "./import.ts";

const T0 = 1_700_000_000_000;
const GRAPH_REL = join(".myc", "graph");

interface Site {
  readonly id: string;
  readonly driver: SqliteDriver;
  readonly store: GraphStore;
}

let root: string;
const sites: Site[] = [];

async function newSite(id: string, startMs: number): Promise<Site> {
  const dir = mkdtempSync(join(root, `site-${id}-`));
  const driver = openSqlite(join(dir, "myc.db"));
  await migrate(driver.database, { migrations, writable: true });
  let t = startMs;
  const store = new GraphStore(driver, {
    siteId: id,
    actor: `actor-${id}`,
    newId: () => generateId(),
    clock: new HlcClock({ now: () => (t += 1) }),
    now: () => startMs,
  });
  const site = { id, driver, store };
  sites.push(site);
  return site;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "myc-test",
  GIT_AUTHOR_EMAIL: "myc@test",
  GIT_COMMITTER_NAME: "myc-test",
  GIT_COMMITTER_EMAIL: "myc@test",
  GIT_TERMINAL_PROMPT: "0",
};

function gitOk(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} → ${r.status}\n${r.stdout}${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

function commitAll(repo: string, message: string): void {
  gitOk(repo, "add", "-A");
  gitOk(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** Шим драйвера слияния: bun запускает модуль этого пакета напрямую. */
function configureDriver(repo: string): void {
  const shim = join(root, "myc-merge-driver.ts");
  const mod = join(import.meta.dir, "merge-driver.ts");
  writeFileSync(
    shim,
    [
      `import { parseMergeDriverArgs, runMergeDriver } from ${JSON.stringify(mod)};`,
      "const a = parseMergeDriverArgs(process.argv.slice(2));",
      'if (typeof a === "string") { console.error(a); process.exit(2); }',
      "const r = runMergeDriver(a);",
      "console.log(r.message);",
      "process.exit(r.code);",
      "",
    ].join("\n"),
  );
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} %O %A %B %L %P`;
  gitOk(repo, "config", `merge.${OPLOG_MERGE_DRIVER}.driver`, cmd);
}

/** Операции каталога графа — ровно то, что лежит в git. */
function graphOps(clone: string): Op[] {
  const ops: Op[] = [];
  for (const text of readOplogFiles(join(clone, GRAPH_REL)).values()) {
    for (const line of splitLines(text)) ops.push(rowToOp(lineToRow(line)));
  }
  return ops;
}

/** closeClaimed ДО правки: CAS и строка op='claim', больше ничего. */
function legacyCloseClaimed(store: GraphStore, id: string, holder: string, epoch: number): void {
  const s = store as unknown as {
    readonly ops: OpFactory;
    readonly siteId: string;
    syncTail(tx: DbDriver): void;
    journalClaim(
      tx: DbDriver,
      meta: ReturnType<OpFactory["set"]>,
      entityId: string,
      scope: string,
      action: string,
      holder: string,
      epoch: number,
      expires: number,
    ): void;
    persistSeq(tx: DbDriver): void;
  };
  store.driver.tx("immediate", (tx) => {
    s.syncTail(tx);
    const meta = s.ops.set(id, "lease", { action: "close", holder, epoch });
    const row = tx.one<{ scope: string }>(Q.lease_close, [
      id,
      holder,
      epoch,
      meta.hlc.ts,
      meta.hlc.ts,
      packHlc(meta.hlc),
      s.siteId,
    ]);
    if (row === undefined) throw new Error("legacy close refused");
    s.journalClaim(tx, meta, id, row.scope, "close", holder, epoch, 0);
    s.persistSeq(tx);
  });
}

interface Scenario {
  readonly a: Site;
  readonly b: Site;
  readonly cloneA: string;
  readonly cloneB: string;
  readonly origin: string;
  readonly closed: string;
  readonly legacyClosed: string;
  readonly n: readonly string[];
  readonly dupA: string;
  readonly dupB: string;
  readonly late: string;
  readonly lateEdge: Op;
  readonly exportA: ExportResult;
  readonly importA0: ImportResult;
  readonly importA: ImportResult;
  readonly importB: ImportResult;
  readonly deferredBefore: number;
}

let sc: Scenario;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-repl-git-"));

  // Воркспейс A: общая база, опубликованная в origin/main.
  const a = await newSite("siteA", T0);
  const closed = a.store.createNode({ kind: "task", title: "взять и закрыть", scope: "s", status: "open" }).id;
  const legacyClosed = a.store.createNode({ kind: "task", title: "закрыта старым бинарём", scope: "s", status: "open" }).id;
  const n = [0, 1, 2].map((i) => a.store.createNode({ kind: "note", title: `узел ${i}`, scope: "s" }).id);

  const origin = join(root, "origin.git");
  gitOk(root, "init", "-q", "--bare", "-b", "main", origin);
  const cloneA = join(root, "cloneA");
  gitOk(root, "clone", "-q", origin, cloneA);
  mkdirSync(join(cloneA, ".myc"), { recursive: true });
  exportGraph(a.driver, join(cloneA, GRAPH_REL));
  commitAll(cloneA, "base");
  gitOk(cloneA, "push", "-q", "origin", "main");

  // Воркспейс B: клон и импорт базы.
  const cloneB = join(root, "cloneB");
  gitOk(root, "clone", "-q", origin, cloneB);
  const b = await newSite("siteB", T0 + 1000);
  importGraph(b.store, join(cloneB, GRAPH_REL), { rebuildCache: false });

  // --- Конкурентная работа ---------------------------------------------
  // Закрытие взятой задачи новым кодом и старым (строка claim без set).
  const r1 = a.store.claimNode(closed, "alice")!;
  expect(a.store.closeClaimed(closed, "alice", r1.epoch)).toBe(true);
  const r2 = a.store.claimNode(legacyClosed, "alice")!;
  legacyCloseClaimed(a.store, legacyClosed, "alice", r2.epoch);

  // Одно ребро: A добавляет, B добавляет позже и удаляет, видя только своё.
  a.store.addEdge(n[0]!, "relates", n[1]!);
  b.store.addEdge(n[0]!, "relates", n[1]!);
  b.store.removeEdge(n[0]!, "relates", n[1]!);
  // И blocks: A добавляет и удаляет, B добавляет, не видя удаления.
  a.store.addEdge(n[1]!, "blocks", closed);
  b.store.addEdge(n[1]!, "blocks", closed);
  a.store.removeEdge(n[1]!, "blocks", closed);

  // Один и тот же текст, созданный независимо на обоих сайтах.
  const dupA = a.store.createNode({ kind: "note", title: "одинаковый факт", body: "тело", scope: "s" }).id;
  const dupB = b.store.createNode({ kind: "note", title: "одинаковый факт", body: "тело", scope: "s" }).id;

  // Ребро на узел, которого B ещё не видел, приехало к B раньше узла
  // (частичная доставка вне git — sync-файл, перенос): оно отложено.
  const late = a.store.createNode({ kind: "task", title: "поздний узел", scope: "s" }).id;
  a.store.addEdge(n[2]!, "relates", late);
  const lateEdge = a.store
    .opsSince(0, 100_000)
    .filter((r) => r.op === "edge_add" && r.entity_id.includes(late))
    .map(rowToOp)[0]!;
  b.store.applyOps([lateEdge]);
  const deferredBefore = b.store.pendingCount();

  // --- Ветки, мерж, импорт ---------------------------------------------
  // Поток CLI как он есть: pull → `myc import` → работа → `myc export`.
  // Экспорт зовётся без движка (exportGraph(h.driver, dir)), закрытие старого
  // бинаря выражает импорт на этой же машине.
  const importA0 = importGraph(a.store, join(cloneA, GRAPH_REL), { rebuildCache: false });
  gitOk(cloneA, "checkout", "-q", "-b", "a");
  const exportA = exportGraph(a.driver, join(cloneA, GRAPH_REL));
  commitAll(cloneA, "a");
  gitOk(cloneA, "push", "-q", "origin", "a");

  gitOk(cloneB, "checkout", "-q", "-b", "b");
  exportGraph(b.driver, join(cloneB, GRAPH_REL));
  commitAll(cloneB, "b");
  gitOk(cloneB, "push", "-q", "origin", "b");

  configureDriver(cloneA);
  configureDriver(cloneB);
  gitOk(cloneA, "fetch", "-q", "origin");
  gitOk(cloneB, "fetch", "-q", "origin");
  gitOk(cloneA, "-c", "commit.gpgsign=false", "merge", "--no-edit", "origin/b");
  gitOk(cloneB, "-c", "commit.gpgsign=false", "merge", "--no-edit", "origin/a");

  const importA = importGraph(a.store, join(cloneA, GRAPH_REL));
  const importB = importGraph(b.store, join(cloneB, GRAPH_REL));

  sc = {
    a,
    b,
    cloneA,
    cloneB,
    origin,
    closed,
    legacyClosed,
    n,
    dupA,
    dupB,
    late,
    lateEdge,
    exportA,
    importA0,
    importA,
    importB,
    deferredBefore,
  };
});

afterAll(() => {
  for (const s of sites) {
    try {
      s.driver.close();
    } catch {
      // уже закрыт
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe("сквозная репликация export → git → import", () => {
  test("закрытие взятой задачи доезжает; закрытие старого бинаря догнано экспортом", () => {
    expect(sc.importA0.backfilled).toEqual([sc.legacyClosed]);
    expect(sc.exportA.unexpressedCloses).toEqual([]);
    for (const id of [sc.closed, sc.legacyClosed]) {
      const onB = sc.b.store.getNode(id)!;
      expect(onB.status).toBe("closed");
      expect(onB.closed_at).toBe(sc.a.store.getNode(id)!.closed_at);
      expect(sc.b.store.claimNode(id, "bob")).toBeUndefined();
    }
  });

  test("конкурентные рёбра сходятся к эталону ядра на обеих репликах", () => {
    const ops = graphOps(sc.cloneA);
    const oracle = merge(emptyState(), ops);
    const relates = `${sc.n[0]}\u0000relates\u0000${sc.n[1]}`;
    const blocks = `${sc.n[1]}\u0000blocks\u0000${sc.closed}`;
    // A's add не видело удаление B, B's add не видело удаление A: оба живы.
    expect(isEdgeAlive(oracle, relates)).toBe(true);
    expect(isEdgeAlive(oracle, blocks)).toBe(true);
    for (const s of [sc.a, sc.b]) {
      expect(s.store.getEdge(sc.n[0]!, "relates", sc.n[1]!)?.deleted_at).toBeNull();
      expect(s.store.getEdge(sc.n[1]!, "blocks", sc.closed)?.deleted_at).toBeNull();
      expect(s.store.openBlockersDrift()).toEqual([]);
    }
  });

  test("контент-дубликат не ломает импорт и разрешён одинаково на обеих репликах", () => {
    expect(sc.importB.duplicates).toEqual([{ id: sc.dupB, of: sc.dupA }]);
    expect(sc.importA.duplicates).toEqual([{ id: sc.dupB, of: sc.dupA }]);
    const canon = contentHash("note", "одинаковый факт", "тело");
    for (const s of [sc.a, sc.b]) {
      expect(s.store.getNode(sc.dupA)!.content_hash).toBe(canon);
      expect(s.store.getNode(sc.dupB)!.content_hash).not.toBe(canon);
      expect(s.store.contentDuplicates()).toEqual([{ id: sc.dupB, of: sc.dupA, scope: "s", kind: "note" }]);
    }
  });

  test("отложенная ранней доставкой операция догоняется импортом", () => {
    expect(sc.deferredBefore).toBe(1);
    expect(sc.importB.deferred).toEqual([]);
    expect(sc.b.store.pendingCount()).toBe(0);
    expect(sc.b.store.getEdge(sc.n[2]!, "relates", sc.late)?.deleted_at).toBeNull();
  });

  test("две реплики и свежий клон: кеш проекций побайтово один", async () => {
    const pa = renderProjectionFiles(sc.a.driver);
    const pb = renderProjectionFiles(sc.b.driver);
    expect(pb).toEqual(pa);
    expect(sc.a.store.oplogCount() - sc.a.store.opsSince(0, 100_000).filter((r) => r.op === "claim").length).toBe(
      sc.b.store.oplogCount(),
    );

    const fresh = join(root, "cloneFresh");
    gitOk(root, "clone", "-q", sc.cloneA, fresh);
    const c = await newSite("siteC", T0 + 9000);
    const r = importGraph(c.store, join(fresh, GRAPH_REL), { rebuildCache: false });
    expect(r.deferred).toEqual([]);
    expect(r.collided).toEqual([]);
    expect(renderProjectionFiles(c.driver)).toEqual(pa);
  });

  test("повторный импорт идемпотентен, git чист", () => {
    for (const [s, clone] of [
      [sc.a, sc.cloneA],
      [sc.b, sc.cloneB],
    ] as const) {
      const again = importGraph(s.store, join(clone, GRAPH_REL));
      expect(again.fresh).toBe(0);
      expect(again.applied).toBe(0);
      expect(gitOk(clone, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    }
  });
});
