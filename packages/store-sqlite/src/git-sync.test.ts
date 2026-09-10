/**
 * Приёмка решения S42 (myc-qie.8): обмен через git, оплог как предмет мержа.
 *
 * Две реплики (site A и site B) расходятся от общей базы, каждая делает по
 * 200 операций над ПЕРЕСЕКАЮЩИМИСЯ узлами, обе экспортируют в свои ветки
 * настоящего git-репозитория, ветки сливаются драйвером без ручного
 * вмешательства, `import` воспроизводит лог. Проверяется:
 *
 *  - в git идёт только оплог: ни одного производного файла в дереве
 *    коммита, рабочее дерево после `import` чистое (myc-qie.10);
 *  - итоговое состояние равно прямому применению всех операций в любом
 *    порядке (20 перестановок, случайные размеры пакетов);
 *  - конфликт по одному полю решается LWW одинаково на обеих сторонах;
 *  - свежий клон плюс `import` даёт то же состояние, что у реплики;
 *  - кеш проекций на обеих репликах побайтово одинаков;
 *  - повторный импорт идемпотентен.
 *
 * Теста на расхождение оплога и закоммиченных проекций больше нет:
 * проекции не коммитятся, расходиться нечему.
 *
 * git — локальный бинарь, сети нет; репозитории живут во временном каталоге.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, HlcClock, type EdgeKind, type Op } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, rowToOp } from "./queries.ts";
import {
  exportGraph,
  lineToRow,
  readOplogFiles,
  renderProjectionFiles,
  splitLines,
  OPLOG_FILE_OPS,
  OPLOG_MERGE_DRIVER,
  type GraphFiles,
} from "./export.ts";
import { defaultCacheDir, importGraph } from "./import.ts";
import { mergeOplogText } from "./merge-driver.ts";

// ---------------------------------------------------------------------------
// Инфраструктура
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const OPS_PER_BRANCH = 200;
const BASE_NODES = 40;
const PERMUTATIONS = 20;

interface Site {
  readonly id: string;
  readonly driver: SqliteDriver;
  readonly store: GraphStore;
  /** сдвинуть часы сайта вперёд — для управляемого исхода LWW */
  jump(ms: number): void;
}

let root: string;
const sites: Site[] = [];

async function newSite(id: string, startMs: number): Promise<Site> {
  const dir = mkdtempSync(join(root, `site-${id}-`));
  const driver = openSqlite(join(dir, "myc.db"));
  // GraphStore читает myc_meta в конструкторе, таблицы нужны раньше него.
  await migrate(driver.database, { migrations, writable: true });
  let t = startMs;
  const clock = new HlcClock({ now: () => (t += 1) });
  const store = new GraphStore(driver, {
    siteId: id,
    actor: `actor-${id}`,
    newId: () => generateId(),
    clock,
    now: () => T0,
  });
  const site: Site = {
    id,
    driver,
    store,
    jump: (ms) => {
      t += ms;
    },
  };
  sites.push(site);
  return site;
}

/** mulberry32 — детерминированный генератор для воспроизводимых сценариев. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
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

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} → ${r.code}\n${r.out}`);
  return r.out;
}

const GRAPH_REL = join(".myc", "graph");

/** Шим драйвера: bun запускает модуль этого пакета напрямую, без CLI. */
function writeDriverShim(dir: string): string {
  const shim = join(dir, "myc-merge-driver.ts");
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
  return shim;
}

/** Драйвер один — регистрируется одна строка конфига. */
function configureDrivers(repo: string, shim: string): void {
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} %O %A %B %L %P`;
  gitOk(repo, "config", `merge.${OPLOG_MERGE_DRIVER}.driver`, cmd);
}

/** Пути дерева коммита; всё, что не оплог/meta/.gitattributes, — производное. */
function committedPaths(repo: string, rev = "HEAD"): string[] {
  return gitOk(repo, "ls-tree", "-r", "--name-only", rev)
    .trim()
    .split("\n")
    .filter((x) => x.length > 0);
}

function derivedPaths(repo: string, rev = "HEAD"): string[] {
  const allowed = /^\.myc\/graph\/(oplog\/[^/]+\/\d{5}\.jsonl|meta\.json|\.gitattributes)$/;
  return committedPaths(repo, rev).filter((p) => !allowed.test(p));
}

/** Кеш проекций клона — сосед каталога графа. */
function cacheOf(clone: string): string {
  return defaultCacheDir(join(clone, GRAPH_REL));
}

function commitAll(repo: string, message: string): void {
  gitOk(repo, "add", "-A");
  gitOk(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function filesEqual(a: GraphFiles, b: GraphFiles): boolean {
  if (a.size !== b.size) {
    console.log(`[S42] наборов файлов: ${a.size} против ${b.size}`);
    return false;
  }
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w !== v) {
      const la = splitLines(v);
      const lb = splitLines(w ?? "");
      const i = la.findIndex((line, idx) => line !== lb[idx]);
      console.log(`[S42] расхождение в ${k}, строка ${i}:\n  ${la[i]}\n  ${lb[i]}`);
      return false;
    }
  }
  return true;
}

function diskProjections(dir: string): GraphFiles {
  const out: GraphFiles = new Map();
  for (const name of readdirSyncSorted(dir)) {
    if (/^(nodes|edges)-[0-9a-z_]\.jsonl$/.test(name)) {
      out.set(name, readFileSync(join(dir, name), "utf8"));
    }
  }
  return out;
}

function readdirSyncSorted(dir: string): string[] {
  const r = spawnSync("ls", ["-1", dir], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").filter((x) => x.length > 0).sort();
}

/** Все реплицируемые операции реплики в виде Op — вход прямого применения. */
function allOps(site: Site): Op[] {
  const ops: Op[] = [];
  for (const text of renderFromDb(site).values()) {
    for (const line of splitLines(text)) ops.push(rowToOp(lineToRow(line)));
  }
  return ops;
}

function renderFromDb(site: Site): GraphFiles {
  const dir = mkdtempSync(join(root, "render-"));
  exportGraph(site.driver, dir);
  return readOplogFiles(dir);
}

/**
 * Прямое применение в произвольном порядке: пакеты случайного размера,
 * отложенные операции переигрываются, пока не применятся все.
 */
function applyShuffled(site: Site, ops: readonly Op[], r: () => number): void {
  let pending = shuffle(r, ops);
  for (let round = 0; pending.length > 0; round++) {
    if (round > 50) throw new Error(`операции не применяются: ${pending.length} осталось`);
    const byId = new Map(pending.map((op) => [op.op_id, op] as const));
    const deferred: string[] = [];
    let i = 0;
    while (i < pending.length) {
      const size = 1 + Math.floor(r() * 25);
      const batch = pending.slice(i, i + size);
      i += size;
      try {
        const res = site.store.applyOps(batch, 0);
        expect(res.collided).toEqual([]);
        deferred.push(...res.deferred);
      } catch (error) {
        // Ребро раньше своих узлов: FOREIGN KEY откатывает пакет целиком —
        // пакет уходит на следующий круг, как и отложенные операции.
        if (!/FOREIGN KEY/.test(error instanceof Error ? error.message : String(error))) throw error;
        deferred.push(...batch.map((op) => op.op_id));
      }
    }
    pending = deferred.map((id) => byId.get(id)!);
  }
}

// ---------------------------------------------------------------------------
// Сценарий: общая база → две ветки по 200 операций → мерж → импорт
// ---------------------------------------------------------------------------

const EDGE_TYPES: readonly EdgeKind[] = ["relates", "mentions", "touches"];
const STATUSES = ["open", "in_progress", "closed"] as const;

/** 200 операций над общими узлами; каждая — ровно одна запись оплога. */
function churn(site: Site, ids: readonly string[], seed: number): number {
  const r = rng(seed);
  const before = site.store.oplogCount();
  let n = 0;
  while (site.store.oplogCount() - before < OPS_PER_BRANCH) {
    const id = pick(r, ids);
    const roll = r();
    n++;
    if (roll < 0.3) {
      site.store.updateNode(id, { title: `${site.id}-title-${n}` });
    } else if (roll < 0.42) {
      site.store.updateNode(id, { body: `${site.id} body ${n}\nвторая строка` });
    } else if (roll < 0.52) {
      site.store.updateNode(id, { status: pick(r, STATUSES) });
    } else if (roll < 0.6) {
      site.store.updateNode(id, { priority: Math.floor(r() * 4) });
    } else if (roll < 0.7) {
      site.store.updateNode(id, { attrs: { [`k${Math.floor(r() * 5)}`]: `${site.id}-${n}` } });
    } else if (roll < 0.85) {
      const dst = pick(r, ids);
      if (dst === id) continue;
      const type = pick(r, EDGE_TYPES);
      if (site.store.getEdge(id, type, dst)?.deleted_at === null) {
        site.store.removeEdge(id, type, dst);
      } else {
        site.store.addEdge(id, type, dst, { weight: Math.round(r() * 10) / 10 });
      }
    } else if (roll < 0.93) {
      site.store.bumpCounter(id, "seen_count", 1);
    } else {
      const node = site.store.getNode(id, true)!;
      if (node.deleted_at === null) site.store.deleteNode(id);
      else site.store.restoreNode(id);
    }
  }
  return site.store.oplogCount() - before;
}

interface Scenario {
  readonly a: Site;
  readonly b: Site;
  readonly ids: string[];
  readonly origin: string;
  readonly cloneA: string;
  readonly cloneB: string;
  readonly shim: string;
  readonly lwwNode: string;
  readonly lwwNodeAWins: string;
}

let sc: Scenario;
let mergeLogA = "";
let mergeLogB = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-git-sync-"));
  const shim = writeDriverShim(root);

  // Сайт A строит общую базу и публикует её в origin/main.
  const a = await newSite("siteA", T0);
  const ids: string[] = [];
  for (let i = 0; i < BASE_NODES; i++) {
    ids.push(
      a.store.createNode({
        kind: "task",
        title: `base ${i}`,
        body: i % 2 === 0 ? `тело ${i}` : undefined,
        attrs: { k0: `init-${i}` },
      }).id,
    );
  }
  for (let i = 0; i + 1 < ids.length; i += 4) {
    a.store.addEdge(ids[i]!, "relates", ids[i + 1]!);
  }

  const origin = join(root, "origin.git");
  gitOk(root, "init", "-q", "--bare", "-b", "main", origin);
  const cloneA = join(root, "cloneA");
  gitOk(root, "clone", "-q", origin, cloneA);
  mkdirSync(join(cloneA, ".myc"), { recursive: true });
  exportGraph(a.driver, join(cloneA, GRAPH_REL));
  commitAll(cloneA, "base graph");
  gitOk(cloneA, "push", "-q", "origin", "main");

  // Сайт B клонирует и импортирует базу.
  const cloneB = join(root, "cloneB");
  gitOk(root, "clone", "-q", origin, cloneB);
  const b = await newSite("siteB", T0 + 300);
  const imported = importGraph(b.store, join(cloneB, GRAPH_REL));
  expect(imported.deferred).toEqual([]);
  expect(imported.collided).toEqual([]);
  expect(b.store.oplogCount()).toBe(a.store.oplogCount());

  // Конфликт по одному полю в обе стороны: B по часам позже A (+300 мс),
  // на lwwNode побеждает B; на lwwNodeAWins A делает запись, прыгнув на
  // секунду вперёд, — побеждает A. Обе реплики обязаны сойтись одинаково.
  const lwwNode = ids[0]!;
  const lwwNodeAWins = ids[1]!;
  a.store.updateNode(lwwNode, { title: "A wrote this" });
  b.store.updateNode(lwwNode, { title: "B wrote this" });
  b.store.updateNode(lwwNodeAWins, { title: "B wrote this too" });
  a.jump(1000);
  a.store.updateNode(lwwNodeAWins, { title: "A wrote this later" });

  // Ветки: по 200 операций над одними и теми же узлами.
  const countA = churn(a, ids, 1);
  const countB = churn(b, ids, 2);
  expect(countA).toBe(OPS_PER_BRANCH);
  expect(countB).toBe(OPS_PER_BRANCH);

  gitOk(cloneA, "checkout", "-q", "-b", "a");
  exportGraph(a.driver, join(cloneA, GRAPH_REL));
  commitAll(cloneA, "branch a: 200 ops");
  gitOk(cloneA, "push", "-q", "origin", "a");

  gitOk(cloneB, "checkout", "-q", "-b", "b");
  exportGraph(b.driver, join(cloneB, GRAPH_REL));
  commitAll(cloneB, "branch b: 200 ops");
  gitOk(cloneB, "push", "-q", "origin", "b");

  // Мерж без ручного вмешательства, на обеих сторонах.
  configureDrivers(cloneA, shim);
  configureDrivers(cloneB, shim);
  gitOk(cloneA, "fetch", "-q", "origin");
  gitOk(cloneB, "fetch", "-q", "origin");
  mergeLogA = gitOk(cloneA, "-c", "commit.gpgsign=false", "merge", "--no-edit", "origin/b");
  mergeLogB = gitOk(cloneB, "-c", "commit.gpgsign=false", "merge", "--no-edit", "origin/a");

  sc = { a, b, ids, origin, cloneA, cloneB, shim, lwwNode, lwwNodeAWins };
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

describe("S42: оплог как предмет мержа", () => {
  test("в git — только оплог: ни одного производного файла ни в одном коммите", () => {
    for (const clone of [sc.cloneA, sc.cloneB]) {
      for (const rev of ["main", "origin/a", "origin/b", "HEAD"]) {
        expect(derivedPaths(clone, rev)).toEqual([]);
      }
      const paths = committedPaths(clone);
      expect(paths).toContain(".myc/graph/.gitattributes");
      expect(paths).toContain(".myc/graph/meta.json");
      expect(paths.filter((p) => p.includes("/oplog/")).length).toBeGreaterThan(0);
      expect(gitOk(clone, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    }
    // B импортировал в beforeAll: кеш проекций лежит на диске рядом с базой,
    // но git не видит его даже как untracked.
    expect(readdirSyncSorted(cacheOf(sc.cloneB)).some((n) => /^nodes-/.test(n))).toBe(true);
    expect(gitOk(sc.cloneB, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    expect(gitOk(sc.cloneB, "status", "--porcelain", "--ignored").trim()).toContain("!! .myc/projections/");
    // .gitattributes — один драйвер, только для оплога.
    const attrs = readFileSync(join(sc.cloneA, GRAPH_REL, ".gitattributes"), "utf8");
    const rules = splitLines(attrs).filter((l) => !l.startsWith("#"));
    expect(rules).toEqual([`oplog/**/*.jsonl merge=${OPLOG_MERGE_DRIVER}`]);
    expect(attrs).not.toContain("myc-projection");
  });

  test("мерж двух веток по 200 операций проходит без конфликтов", () => {
    for (const clone of [sc.cloneA, sc.cloneB]) {
      expect(gitOk(clone, "diff", "--name-only", "--diff-filter=U").trim()).toBe("");
      expect(gitOk(clone, "status", "--porcelain").trim()).toBe("");
    }
    // Файл оплога siteB на ветке a не существовал, git добавил его без
    // вызова драйвера — пересечения нет, и драйверу нечего было делать.
    expect(mergeLogA).not.toContain("CONFLICT");
    expect(mergeLogA).not.toContain("projection");
    // Оба сайта писали в разные файлы оплога: пересечение по файлам — ноль.
    const changedA = gitOk(sc.cloneA, "diff", "--name-only", "main", "origin/a").trim().split("\n");
    const changedB = gitOk(sc.cloneA, "diff", "--name-only", "main", "origin/b").trim().split("\n");
    const oplogA = changedA.filter((p) => p.includes("/oplog/"));
    const oplogB = changedB.filter((p) => p.includes("/oplog/"));
    expect(oplogA.length).toBeGreaterThan(0);
    expect(oplogB.length).toBeGreaterThan(0);
    expect(oplogA.filter((p) => oplogB.includes(p))).toEqual([]);
  });

  test("после import обе реплики сходятся к одному состоянию", () => {
    const ra = importGraph(sc.a.store, join(sc.cloneA, GRAPH_REL));
    const rb = importGraph(sc.b.store, join(sc.cloneB, GRAPH_REL));
    expect(ra.fresh).toBe(OPS_PER_BRANCH + 2);
    expect(rb.fresh).toBe(OPS_PER_BRANCH + 2);
    expect(ra.deferred).toEqual([]);
    expect(rb.deferred).toEqual([]);
    expect(ra.collided).toEqual([]);
    expect(rb.collided).toEqual([]);
    expect(sc.a.store.oplogCount()).toBe(sc.b.store.oplogCount());

    const pa = renderProjectionFiles(sc.a.driver);
    const pb = renderProjectionFiles(sc.b.driver);
    expect(filesEqual(pa, pb)).toBe(true);
    // Кеш на диске после import — те же байты, и сам себя игнорирует.
    expect(ra.cache?.dir).toBe(cacheOf(sc.cloneA));
    expect(filesEqual(diskProjections(cacheOf(sc.cloneA)), pa)).toBe(true);
    expect(filesEqual(diskProjections(cacheOf(sc.cloneB)), pb)).toBe(true);
    expect(readFileSync(join(cacheOf(sc.cloneA), ".gitignore"), "utf8")).toContain("\n*\n");
    // После импорта коммитить нечего: в git ушёл только оплог, кеш невидим.
    expect(gitOk(sc.cloneA, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    expect(gitOk(sc.cloneB, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    // Мерж-коммиты на обеих машинах одинаковы по содержимому дерева —
    // без всякого «коммита после импорта».
    const treeA = gitOk(sc.cloneA, "rev-parse", "HEAD^{tree}").trim();
    const treeB = gitOk(sc.cloneB, "rev-parse", "HEAD^{tree}").trim();
    expect(treeA).toBe(treeB);
  });

  test("конфликт по одному полю решается LWW одинаково на обеих сторонах", () => {
    const aWon = sc.a.store.getNode(sc.lwwNode, true)!;
    const bWon = sc.b.store.getNode(sc.lwwNode, true)!;
    expect(aWon.title).toBe(bWon.title);
    const a2 = sc.a.store.getNode(sc.lwwNodeAWins, true)!;
    const b2 = sc.b.store.getNode(sc.lwwNodeAWins, true)!;
    expect(a2.title).toBe(b2.title);
    // Победители — по часам, а не по тому, кто мержил: на lwwNode это B,
    // на lwwNodeAWins — A; но churn мог переписать title позже — проверяем
    // через журнал: последняя по (hlc, site) запись поля и есть значение.
    for (const id of [sc.lwwNode, sc.lwwNodeAWins]) {
      const rows = sc.a.driver.database
        .query(
          "SELECT value, site_id, hlc FROM oplog WHERE entity_id = ? AND field = 'title' ORDER BY hlc DESC, site_id DESC LIMIT 1",
        )
        .all(id) as Array<{ value: string; site_id: string }>;
      expect(JSON.parse(rows[0]!.value)).toBe(sc.a.store.getNode(id, true)!.title);
    }
  });

  test(`итог равен прямому применению всех операций в ${PERMUTATIONS} перестановках`, async () => {
    const ops = allOps(sc.a);
    expect(ops.length).toBe(sc.a.store.oplogCount());
    const expected = renderProjectionFiles(sc.a.driver);
    for (let i = 0; i < PERMUTATIONS; i++) {
      const ref = await newSite(`ref${i}`, T0 + 5000);
      applyShuffled(ref, ops, rng(100 + i));
      expect(ref.store.oplogCount()).toBe(ops.length);
      const got = renderProjectionFiles(ref.driver);
      if (!filesEqual(got, expected)) {
        for (const [k, v] of expected) {
          expect(got.get(k)).toBe(v);
        }
      }
      expect(filesEqual(got, expected)).toBe(true);
      ref.driver.close();
    }
  });

  test("свежий клон плюс import даёт то же состояние, что у реплики", async () => {
    const cloneFresh = join(root, "cloneFresh");
    gitOk(root, "clone", "-q", sc.cloneA, cloneFresh);
    expect(derivedPaths(cloneFresh)).toEqual([]);
    const fresh = await newSite("fresh", T0 + 9000);
    const r = importGraph(fresh.store, join(cloneFresh, GRAPH_REL));
    expect(r.deferred).toEqual([]);
    expect(r.collided).toEqual([]);
    expect(fresh.store.oplogCount()).toBe(sc.a.store.oplogCount());
    // Состояние — то же: кеш свежей реплики побайтово равен кешу A.
    const rebuilt = renderProjectionFiles(fresh.driver);
    expect(filesEqual(rebuilt, renderProjectionFiles(sc.a.driver))).toBe(true);
    expect(filesEqual(diskProjections(cacheOf(cloneFresh)), rebuilt)).toBe(true);
    // Кеш лежит рядом с базой, а не в каталоге графа.
    expect(diskProjections(join(cloneFresh, GRAPH_REL)).size).toBe(0);
    // Экспорт с этой реплики не меняет ни одного файла в дереве, git чист.
    const ex = exportGraph(fresh.driver, join(cloneFresh, GRAPH_REL));
    expect(ex.files.written).toEqual([]);
    expect(ex.pendingImport).toBe(0);
    expect(gitOk(cloneFresh, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    fresh.driver.close();
  });

  test("повторный импорт идемпотентен", () => {
    const before = sc.a.store.oplogCount();
    const r = importGraph(sc.a.store, join(sc.cloneA, GRAPH_REL));
    expect(r.fresh).toBe(0);
    expect(r.applied).toBe(0);
    expect(r.cache?.files.written).toEqual([]);
    expect(r.cache?.files.removed).toEqual([]);
    expect(sc.a.store.oplogCount()).toBe(before);
    expect(gitOk(sc.cloneA, "status", "--porcelain").trim()).toBe("");
  });

  test("старые проекции в каталоге графа экспорт удаляет — git видит удаление", () => {
    // Клон смёрженной ветки A, где первая редакция S42 успела закоммитить
    // проекции (база A уже содержит ровно этот оплог — см. тест выше).
    const legacy = join(root, "cloneLegacy");
    gitOk(root, "clone", "-q", sc.cloneA, legacy);
    for (const [name, text] of renderProjectionFiles(sc.a.driver)) {
      writeFileSync(join(legacy, GRAPH_REL, name), text);
    }
    commitAll(legacy, "legacy: committed projections");
    expect(derivedPaths(legacy).length).toBeGreaterThan(0);

    const ex = exportGraph(sc.a.driver, join(legacy, GRAPH_REL));
    expect(ex.files.removed.length).toBe(derivedPaths(legacy).length);
    expect(diskProjections(join(legacy, GRAPH_REL)).size).toBe(0);
    const status = gitOk(legacy, "status", "--porcelain").trim().split("\n");
    expect(status.every((l) => l.startsWith(" D ") || l.startsWith("D "))).toBe(true);
    commitAll(legacy, "drop projections from git");
    expect(derivedPaths(legacy)).toEqual([]);
  });

  test("файлы оплога: размер строки и корзины в цифрах", () => {
    const files = readOplogFiles(join(sc.cloneA, GRAPH_REL));
    let lines = 0;
    let bytes = 0;
    for (const text of files.values()) {
      lines += splitLines(text).length;
      bytes += Buffer.byteLength(text);
    }
    const avg = bytes / lines;
    // ~120–220 байт на операцию: корзина в 1000 строк остаётся ≤ ~250 КБ,
    // ниже порога 500 КБ, после которого GitHub не рендерит дифф.
    expect(avg).toBeGreaterThan(80);
    expect(avg).toBeLessThan(260);
    expect(OPLOG_FILE_OPS * avg).toBeLessThan(500 * 1024);
    for (const text of files.values()) {
      expect(splitLines(text).length).toBeLessThanOrEqual(OPLOG_FILE_OPS);
    }
    writeFileSync(
      join(root, "size-report.json"),
      JSON.stringify({ files: files.size, lines, bytes, avgLineBytes: Math.round(avg) }),
    );
    // Полезно видеть цифры в выводе bun test.
    console.log(
      `[S42] файлов оплога ${files.size}, строк ${lines}, байт ${bytes}, средняя строка ${Math.round(avg)} Б, корзина ${OPLOG_FILE_OPS} ≈ ${Math.round((OPLOG_FILE_OPS * avg) / 1024)} КБ`,
    );
  });
});

describe("хвостовой файл одного сайта с двух веток", () => {
  test("драйвер объединяет по op_id, текстовый мерж того же файла конфликтует", () => {
    const base = gitOk(sc.cloneA, "rev-parse", "HEAD").trim();
    // Ветка a: +3 операции сайта A.
    for (let i = 0; i < 3; i++) sc.a.store.updateNode(sc.ids[i]!, { title: `tail-a-${i}` });
    exportGraph(sc.a.driver, join(sc.cloneA, GRAPH_REL));
    commitAll(sc.cloneA, "tail: 3 ops on a");
    // Ветка a2 от того же основания: те же 3 плюс ещё 2 — одна машина,
    // одна база, два рабочих дерева.
    const cloneA2 = join(root, "cloneA2");
    gitOk(root, "clone", "-q", sc.cloneA, cloneA2);
    gitOk(cloneA2, "checkout", "-q", "-b", "a2", base);
    for (let i = 3; i < 5; i++) sc.a.store.updateNode(sc.ids[i]!, { title: `tail-a2-${i}` });
    exportGraph(sc.a.driver, join(cloneA2, GRAPH_REL));
    commitAll(cloneA2, "tail: 5 ops on a2");

    // Текстовый мерж (мутант): обе стороны дописали разный хвост в один файл.
    const mutant = join(root, "cloneA2-text");
    gitOk(root, "clone", "-q", cloneA2, mutant);
    gitOk(mutant, "checkout", "-q", "a2");
    const textMerge = git(mutant, "-c", "commit.gpgsign=false", "merge", "--no-edit", "origin/a");
    const tail = join(GRAPH_REL, "oplog", "siteA", "00000.jsonl");
    const expected = renderFromDb(sc.a).get("oplog/siteA/00000.jsonl")!;
    const textResult = readFileSync(join(mutant, tail), "utf8");
    expect(textMerge.code !== 0 || textResult !== expected).toBe(true);

    // Драйвер: объединение, ни одного конфликта, файл равен экспорту базы.
    configureDrivers(cloneA2, sc.shim);
    const log = gitOk(cloneA2, "-c", "commit.gpgsign=false", "merge", "--no-edit", "origin/a");
    expect(log).toContain("union by op_id");
    expect(gitOk(cloneA2, "diff", "--name-only", "--diff-filter=U").trim()).toBe("");
    expect(readFileSync(join(cloneA2, tail), "utf8")).toBe(expected);
    // Импорт после такого мержа для базы-источника — пустой; кеш в новом
    // клоне пишется один раз, повтор — идемпотентен.
    const r = importGraph(sc.a.store, join(cloneA2, GRAPH_REL));
    expect(r.fresh).toBe(0);
    expect(r.cache?.files.written.length).toBeGreaterThan(0);
    const again = importGraph(sc.a.store, join(cloneA2, GRAPH_REL));
    expect(again.cache?.files.written).toEqual([]);
    expect(gitOk(cloneA2, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
  });
});

describe("драйвер слияния оплога", () => {
  test("объединение: конкатенация, дедупликация по op_id, порядок по seq", () => {
    const l = (seq: number, v: string): string =>
      JSON.stringify({
        op_id: `s:${seq}`,
        hlc: [T0 + seq, 0],
        op: "set",
        entity: "node",
        entity_id: "myc-x",
        field: "title",
        value: v,
      });
    const ours = `${l(1, "a")}\n${l(2, "b")}\n${l(3, "c")}\n`;
    const theirs = `${l(1, "a")}\n${l(2, "b")}\n${l(5, "e")}\n${l(4, "d")}\n`;
    const r = mergeOplogText(ours, theirs, ours);
    expect(r.added).toBe(2);
    expect(r.lines).toBe(5);
    expect(splitLines(r.text).map((x) => (JSON.parse(x) as { op_id: string }).op_id)).toEqual([
      "s:1",
      "s:2",
      "s:3",
      "s:4",
      "s:5",
    ]);
    // Коммутативно.
    expect(mergeOplogText(theirs, ours).text).toBe(r.text);
    // Идемпотентно.
    expect(mergeOplogText(r.text, theirs).text).toBe(r.text);
  });

  test("битая строка не выбрасывается молча", () => {
    expect(() => mergeOplogText('{"op_id":"s:1"}\n', "")).toThrow(/incomplete/);
    expect(() => mergeOplogText("not json\n", "")).toThrow(/not JSON/);
  });
});
