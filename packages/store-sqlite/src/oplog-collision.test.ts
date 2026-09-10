/**
 * Приёмка S65: копия каталога воркспейса делит `site_id`, и `git merge`
 * молча терял операции.
 *
 * Сценарий, которым баг был найден живьём: `cp -R проект copyA`,
 * `cp -R проект copyB`, в каждой копии своя работа, export, commit, merge.
 * Обе базы продолжают нумеровать операции с одного `seq`, поэтому в хвосте
 * оплога у них ОДИНАКОВЫЕ op_id при РАЗНОМ содержимом. Объединение по op_id
 * оставляло первую строку и рапортовало «+0 строк» внутри успешного
 * `git merge` — операции второй копии исчезали, и обнаружить это было нечем.
 *
 * Здесь коллизия проверяется там, где она живёт: настоящие файлы, настоящий
 * `git merge`, настоящий драйвер как отдельный процесс. Плюс два защитных
 * теста в другую сторону — честные клоны и повтор одних и тех же строк
 * обязаны сливаться молча и без конфликта, иначе «громкость» съела бы
 * нормальный обмен.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, HlcClock } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";
import {
  exportGraph,
  lineToRow,
  readOplogFiles,
  rowToLine,
  splitLines,
  unionOplogText,
  OplogCollisionError,
  OPLOG_MERGE_DRIVER,
} from "./export.ts";
import { importGraph } from "./import.ts";
import { mergeOplogText, runMergeDriver } from "./merge-driver.ts";
import { decideSiteId, observeInstance, renderInstance } from "./site-identity.ts";

const T0 = 1_700_000_000_000;
const GRAPH_REL = join(".myc", "graph");
/** Тот же site_id, что унесла бы копия каталога: он записан в базе. */
const SHARED_SITE = "local-origin-ncross";

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

let root: string;
const opened: SqliteDriver[] = [];

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} → ${r.code}\n${r.out}`);
  return r.out;
}

/** Шим драйвера: bun запускает модуль пакета напрямую, как это делает git. */
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

function configureDriver(repo: string, shim: string): void {
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} %O %A %B %L %P`;
  gitOk(repo, "config", `merge.${OPLOG_MERGE_DRIVER}.driver`, cmd);
}

function commitAll(repo: string, message: string): void {
  gitOk(repo, "add", "-A");
  gitOk(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** То же, что пишет `myc init`: база и кеш — локальные, в git идёт оплог. */
function writeMycGitignore(dir: string): void {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  writeFileSync(
    join(dir, ".myc", ".gitignore"),
    "myc.db\nmyc.db-wal\nmyc.db-shm\nmyc.db-journal\nprojections/\nstate.json\n",
  );
}

interface Replica {
  readonly dir: string;
  readonly driver: SqliteDriver;
  readonly store: GraphStore;
}

/** Открыть базу воркспейса; site_id задаётся явно, как его читают из myc_meta. */
async function openReplica(dir: string, siteId: string, startMs: number): Promise<Replica> {
  const driver = openSqlite(join(dir, ".myc", "myc.db"));
  opened.push(driver);
  await migrate(driver.database, { migrations, writable: true });
  let t = startMs;
  const store = new GraphStore(driver, {
    siteId,
    actor: `actor-${siteId}`,
    newId: () => generateId(),
    clock: new HlcClock({ now: () => (t += 1) }),
    now: () => T0,
  });
  return { dir, driver, store };
}

function oplogPathOf(dir: string): string {
  const files = [...readOplogFiles(join(dir, GRAPH_REL)).keys()];
  expect(files.length).toBeGreaterThan(0);
  return `.myc/graph/${files[0]!}`;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "myc-collision-"));
});

afterAll(() => {
  for (const d of opened) {
    try {
      d.close();
    } catch {
      // уже закрыт
    }
  }
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Ядро: одна операция, два содержимого
// ---------------------------------------------------------------------------

describe("unionOplogText: op_id — идентичность, а не ключ дедупликации", () => {
  /** Две строки с одним op_id и разными сущностями — то, что даёт копия. */
  function pair(): { a: string; b: string } {
    const mk = (entity: string, title: string): string =>
      JSON.stringify({
        op_id: `${SHARED_SITE}:1825`,
        hlc: [T0, 0],
        op: "set",
        entity: "node",
        entity_id: entity,
        field: "title",
        value: title,
      });
    return { a: mk("myc-aaaaaaaaaaaa", "узел copyA"), b: mk("myc-bbbbbbbbbbbb", "узел copyB") };
  }

  test("одинаковые строки — повтор: объединение молчит и не растёт", () => {
    const { a } = pair();
    const r = unionOplogText(`${a}\n`, `${a}\n`);
    expect(splitLines(r.text)).toEqual([a]);
    expect(r.added).toBe(0);
  });

  test("тот же op_id с ДРУГИМ содержимым — OplogCollisionError, а не тихий пропуск", () => {
    const { a, b } = pair();
    expect(() => unionOplogText(`${a}\n`, `${b}\n`)).toThrow(OplogCollisionError);
    let err: unknown;
    try {
      unionOplogText(`${a}\n`, `${b}\n`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OplogCollisionError);
    const c = err as OplogCollisionError;
    expect(c.opId).toBe(`${SHARED_SITE}:1825`);
    // Обе строки целы в ошибке: потерянного нет даже в диагностике.
    expect(c.kept).toBe(a);
    expect(c.dropped).toBe(b);
    expect(c.message).toContain(`${SHARED_SITE}:1825`);
  });

  test("коллизия ловится и внутри одной стороны, и в любом порядке сторон", () => {
    const { a, b } = pair();
    expect(() => unionOplogText(`${a}\n${b}\n`, "")).toThrow(OplogCollisionError);
    expect(() => unionOplogText("", `${a}\n${b}\n`)).toThrow(OplogCollisionError);
    expect(() => unionOplogText(`${b}\n`, `${a}\n`)).toThrow(OplogCollisionError);
  });

  test("различие ЛЮБОГО поля записи — коллизия: сравнивается запись, а не op_id", () => {
    const base = {
      op_id: `${SHARED_SITE}:1825`,
      hlc: [T0, 0],
      op: "set",
      entity: "node",
      entity_id: "myc-aaaaaaaaaaaa",
      field: "title",
      value: "т",
    };
    const a = JSON.stringify(base);
    for (const patch of [
      { value: "другое" },
      { field: "body" },
      { entity_id: "myc-bbbbbbbbbbbb" },
      { op: "del" },
      { entity: "edge" },
      { hlc: [T0 + 1, 0] },
    ]) {
      const b = JSON.stringify({ ...base, ...patch });
      expect(() => unionOplogText(`${a}\n`, `${b}\n`)).toThrow(OplogCollisionError);
    }
  });

  test("порядок ключей и лишние поля коллизией НЕ считаются: сравнение канонично", () => {
    const a = JSON.stringify({
      op_id: `${SHARED_SITE}:1825`,
      hlc: [T0, 0],
      op: "set",
      entity: "node",
      entity_id: "myc-aaaaaaaaaaaa",
      field: "title",
      value: { z: 1, a: 2 },
    });
    // Тот же смысл, другой порядок ключей верхнего уровня + чужое поле.
    const b = JSON.stringify({
      entity_id: "myc-aaaaaaaaaaaa",
      value: { z: 1, a: 2 },
      field: "title",
      entity: "node",
      op: "set",
      hlc: [T0, 0],
      op_id: `${SHARED_SITE}:1825`,
      actor: "кто-то",
    });
    expect(a).not.toBe(b);
    const r = unionOplogText(`${a}\n`, `${b}\n`);
    expect(splitLines(r.text).length).toBe(1);
    expect(r.added).toBe(0);
    // Канонический вид — то, на чём держится это сравнение.
    expect(rowToLine(lineToRow(b))).toBe(rowToLine(lineToRow(a)));
  });

  test("mergeOplogText и runMergeDriver не глотают коллизию", () => {
    const { a, b } = pair();
    expect(() => mergeOplogText(`${a}\n`, `${b}\n`)).toThrow(OplogCollisionError);

    const dir = mkdtempSync(join(root, "files-"));
    const paths = {
      base: join(dir, "base.jsonl"),
      ours: join(dir, "ours.jsonl"),
      theirs: join(dir, "theirs.jsonl"),
      path: ".myc/graph/oplog/site/00001.jsonl",
    };
    writeFileSync(paths.base, "");
    writeFileSync(paths.ours, `${a}\n`);
    writeFileSync(paths.theirs, `${b}\n`);
    const run = runMergeDriver(paths);
    expect(run.code).not.toBe(0);
    expect(run.reason).toBe("collision");
    expect(run.opId).toBe(`${SHARED_SITE}:1825`);
    expect(run.message).toContain(`${SHARED_SITE}:1825`);
    expect(run.message).toContain(paths.path);
    expect(run.outcome).toBeUndefined();
    // %A не переписан: git получает конфликт, а не «слитый» файл.
    expect(readFileSync(paths.ours, "utf8")).toBe(`${a}\n`);
  });

  test("нечитаемая строка остаётся отдельной причиной отказа", () => {
    const dir = mkdtempSync(join(root, "broken-"));
    const paths = { base: join(dir, "b"), ours: join(dir, "o"), theirs: join(dir, "t") };
    writeFileSync(paths.base, "");
    writeFileSync(paths.ours, "не json\n");
    writeFileSync(paths.theirs, "");
    const run = runMergeDriver(paths);
    expect(run.code).not.toBe(0);
    expect(run.reason).toBe("parse");
    expect(run.opId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Сценарий копии: настоящий cp -R, настоящий git merge
// ---------------------------------------------------------------------------

describe("S65: cp -R каталога воркспейса и git merge", () => {
  let copyA: string;
  let copyB: string;
  let merge: { code: number; out: string };
  let oplogRel: string;
  let titleA: string;
  let titleB: string;

  beforeAll(async () => {
    const proj = join(root, "proj");
    mkdirSync(join(proj, ".myc"), { recursive: true });
    gitOk(root, "init", "-q", "-b", "main", proj);
    writeMycGitignore(proj);
    const origin = await openReplica(proj, SHARED_SITE, T0);
    for (let i = 0; i < 5; i++) {
      origin.store.createNode({ kind: "task", title: `база ${i}` });
    }
    exportGraph(origin.driver, join(proj, GRAPH_REL));
    commitAll(proj, "база");
    origin.driver.close();

    // Ровно то, что делает человек: копия каталога вместе с .git и базой.
    copyA = join(root, "copyA");
    copyB = join(root, "copyB");
    cpSync(proj, copyA, { recursive: true });
    cpSync(proj, copyB, { recursive: true });

    // В каждой копии — своя работа. site_id один и тот же, seq продолжается
    // с одного места, значит op_id совпадут при разном содержимом.
    const a = await openReplica(copyA, SHARED_SITE, T0 + 100);
    const b = await openReplica(copyB, SHARED_SITE, T0 + 200);
    titleA = "copyA узел";
    titleB = "copyB узел";
    for (let i = 0; i < 3; i++) a.store.createNode({ kind: "task", title: `${titleA} ${i}` });
    for (let i = 0; i < 3; i++) b.store.createNode({ kind: "task", title: `${titleB} ${i}` });
    exportGraph(a.driver, join(copyA, GRAPH_REL));
    exportGraph(b.driver, join(copyB, GRAPH_REL));
    commitAll(copyA, "работа в copyA");
    commitAll(copyB, "работа в copyB");

    oplogRel = oplogPathOf(copyA);
    configureDriver(copyA, writeDriverShim(root));
    gitOk(copyA, "remote", "add", "b", copyB);
    gitOk(copyA, "fetch", "-q", "b");
    merge = git(copyA, "-c", "commit.gpgsign=false", "merge", "--no-edit", "b/main");
  });

  test("оплог копий действительно столкнулся по op_id — предпосылка сценария", () => {
    const ours = readOplogFiles(join(copyA, GRAPH_REL));
    const theirs = readOplogFiles(join(copyB, GRAPH_REL));
    const byId = new Map(
      [...ours.values()].flatMap((t) => splitLines(t)).map((l) => [lineToRow(l).op_id, l] as const),
    );
    const clashes = [...theirs.values()]
      .flatMap((t) => splitLines(t))
      .filter((l) => {
        const mine = byId.get(lineToRow(l).op_id);
        return mine !== undefined && mine !== l;
      });
    expect(clashes.length).toBeGreaterThan(0);
    // И обе стороны пишут в ОДИН файл — иначе git не позвал бы драйвер.
    expect([...ours.keys()]).toEqual([...theirs.keys()]);
  });

  test("git merge завершается ненулевым кодом, а не «+0 строк»", () => {
    expect(merge.code).not.toBe(0);
    expect(merge.out).not.toContain("+0 lines");
    expect(merge.out).toContain("op_id COLLISION");
    // Сообщение называет и op_id, и файл — человеку должно быть понятно, что случилось.
    expect(merge.out).toMatch(new RegExp(`op_id COLLISION ${SHARED_SITE}:\\d+`));
    expect(merge.out).toContain(oplogRel);
    expect(merge.out).toContain("S65");
  });

  test("конфликт оставлен человеку, и ни одна операция не потеряна", () => {
    expect(gitOk(copyA, "diff", "--name-only", "--diff-filter=U").trim()).toContain(oplogRel);
    // Обе версии файла целы в индексе: их и предлагает разобрать сообщение.
    const stage2 = gitOk(copyA, "show", `:2:${oplogRel}`);
    const stage3 = gitOk(copyA, "show", `:3:${oplogRel}`);
    expect(stage2).toContain(titleA);
    expect(stage3).toContain(titleB);
    // Драйвер не переписал %A: в рабочем дереве — наша версия целиком.
    expect(readFileSync(join(copyA, oplogRel), "utf8")).toBe(stage2);
    // Ни одна операция copyB не исчезла: все её op_id живы в :3:.
    const theirOps = [...readOplogFiles(join(copyB, GRAPH_REL)).values()]
      .flatMap((t) => splitLines(t))
      .map((l) => lineToRow(l).op_id);
    const inStage3 = new Set(splitLines(stage3).map((l) => lineToRow(l).op_id));
    expect(theirOps.filter((id) => !inStage3.has(id))).toEqual([]);
  });

  test("экспорт видит ту же коллизию и падает ДО записи файлов", async () => {
    // copyB экспортирует в каталог, где уже лежит оплог copyA — ровно то,
    // что бывает после `git pull` до `myc import`.
    const dir = mkdtempSync(join(root, "export-into-"));
    mkdirSync(join(dir, ".myc"), { recursive: true });
    cpSync(join(copyA, GRAPH_REL), join(dir, GRAPH_REL), { recursive: true });
    const before = readOplogFiles(join(dir, GRAPH_REL));

    const b = await openReplica(copyB, SHARED_SITE, T0 + 900);
    let err: unknown;
    try {
      exportGraph(b.driver, join(dir, GRAPH_REL));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OplogCollisionError);
    const c = err as OplogCollisionError;
    expect(c.path).toBeDefined();
    expect(c.message).toContain(c.path!);
    expect(c.message).toContain(c.opId);
    // Каталог не тронут: ни один файл не переписан.
    const after = readOplogFiles(join(dir, GRAPH_REL));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(after.get(k)).toBe(v);
  });
});

// ---------------------------------------------------------------------------
// Корень: перевыпуск site_id закрывает сам сценарий
// ---------------------------------------------------------------------------

describe("S65: копия с перевыпущенным site_id сливается без коллизий", () => {
  test("тот же cp -R, но копия минтит под своим site_id: merge чист, 5+3+3 узлов", async () => {
    const scope = mkdtempSync(join(root, "reissue-"));
    const proj = join(scope, "proj");
    mkdirSync(join(proj, ".myc"), { recursive: true });
    gitOk(scope, "init", "-q", "-b", "main", proj);
    writeMycGitignore(proj);
    const origin = await openReplica(proj, SHARED_SITE, T0);
    for (let i = 0; i < 5; i++) origin.store.createNode({ kind: "task", title: `база ${i}` });
    exportGraph(origin.driver, join(proj, GRAPH_REL));
    commitAll(proj, "база");
    const originInstance = observeInstance(join(proj, ".myc", "myc.db"));
    origin.driver.close();

    const copyA = join(scope, "copyA");
    const copyB = join(scope, "copyB");
    cpSync(proj, copyA, { recursive: true });
    cpSync(proj, copyB, { recursive: true });

    // Ровно то, что сделал бы путь открытия базы, если бы решение было
    // подключено: физический экземпляр другой — site_id перевыпускается,
    // прежний уходит в предшественники, УЖЕ ЗАПИСАННЫЕ операции не трогаются.
    let n = 0;
    const siteOf = (dir: string): string => {
      const d = decideSiteId({
        stored: SHARED_SITE,
        storedInstance: renderInstance(originInstance),
        observed: observeInstance(join(dir, ".myc", "myc.db")),
        mint: () => `local-origin-reissued${++n}`,
      });
      expect(d.origin).toBe("reissued");
      expect(JSON.parse(d.predecessors!)).toEqual([SHARED_SITE]);
      return d.siteId;
    };
    const siteA = siteOf(copyA);
    const siteB = siteOf(copyB);
    expect(siteA).not.toBe(siteB);

    for (const [dir, site, ms, mark] of [
      [copyA, siteA, T0 + 100, "copyA"],
      [copyB, siteB, T0 + 200, "copyB"],
    ] as const) {
      const r = await openReplica(dir, site, ms);
      for (let i = 0; i < 3; i++) r.store.createNode({ kind: "task", title: `${mark} узел ${i}` });
      exportGraph(r.driver, join(dir, GRAPH_REL));
      commitAll(dir, `работа ${mark}`);
    }

    configureDriver(copyA, writeDriverShim(scope));
    gitOk(copyA, "remote", "add", "b", copyB);
    gitOk(copyA, "fetch", "-q", "b");
    const merged = git(copyA, "-c", "commit.gpgsign=false", "merge", "--no-edit", "b/main");
    expect(merged.code).toBe(0);
    expect(merged.out).not.toContain("COLLISION");
    expect(gitOk(copyA, "diff", "--name-only", "--diff-filter=U").trim()).toBe("");

    // Общий префикс истории лежит под ПРЕЖНИМ site_id и побайтово одинаков в
    // обеих копиях: перевыпуск не переписывает уже выписанные операции, он
    // лишь разводит то, что пишется дальше.
    const filesA = readOplogFiles(join(copyA, GRAPH_REL));
    const filesB = readOplogFiles(join(copyB, GRAPH_REL));
    const sharedRel = [...filesA.keys()].find((k) => k.includes(SHARED_SITE))!;
    expect(sharedRel).toBeDefined();
    expect(filesB.get(sharedRel)).toBe(filesA.get(sharedRel));

    const verify = mkdtempSync(join(scope, "verify-"));
    mkdirSync(join(verify, ".myc"), { recursive: true });
    const check = await openReplica(verify, "siteV", T0 + 9000);
    const r = importGraph(check.store, join(copyA, GRAPH_REL));
    expect(r.collided).toEqual([]);
    expect(r.deferred).toEqual([]);
    const nodes = check.driver.database.query("SELECT count(*) AS n FROM nodes").get() as {
      n: number;
    };
    expect(nodes.n).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Защита в другую сторону: честный обмен обязан остаться бесшумным
// ---------------------------------------------------------------------------

describe("честные клоны сливаются как раньше", () => {
  test("два git clone с разными site_id: merge без конфликта, все узлы на месте", async () => {
    const scope = mkdtempSync(join(root, "clones-"));
    const origin = join(scope, "origin.git");
    gitOk(scope, "init", "-q", "--bare", "-b", "main", origin);

    const seed = join(scope, "seed");
    gitOk(scope, "clone", "-q", origin, seed);
    writeMycGitignore(seed);
    const s = await openReplica(seed, "siteSeed", T0);
    for (let i = 0; i < 5; i++) s.store.createNode({ kind: "task", title: `база ${i}` });
    exportGraph(s.driver, join(seed, GRAPH_REL));
    commitAll(seed, "база");
    gitOk(seed, "push", "-q", "origin", "main");

    const shim = writeDriverShim(scope);
    const clones: string[] = [];
    for (const [name, site, ms] of [
      ["cloneA", "siteA", T0 + 1000],
      ["cloneB", "siteB", T0 + 2000],
    ] as const) {
      const dir = join(scope, name);
      gitOk(scope, "clone", "-q", origin, dir);
      configureDriver(dir, shim);
      const r = await openReplica(dir, site, ms);
      const imported = importGraph(r.store, join(dir, GRAPH_REL));
      expect(imported.collided).toEqual([]);
      for (let i = 0; i < 20; i++) r.store.createNode({ kind: "task", title: `${site} ${i}` });
      exportGraph(r.driver, join(dir, GRAPH_REL));
      commitAll(dir, `работа ${site}`);
      clones.push(dir);
    }

    const [ca, cb] = clones as [string, string];
    gitOk(ca, "remote", "add", "peer", cb);
    gitOk(ca, "fetch", "-q", "peer");
    const merged = git(ca, "-c", "commit.gpgsign=false", "merge", "--no-edit", "peer/main");
    expect(merged.code).toBe(0);
    expect(merged.out).not.toContain("CONFLICT");
    expect(merged.out).not.toContain("COLLISION");
    expect(gitOk(ca, "diff", "--name-only", "--diff-filter=U").trim()).toBe("");

    // 5 + 20 + 20: ни одного узла не потеряно и ни одного лишнего.
    const verify = mkdtempSync(join(scope, "verify-"));
    mkdirSync(join(verify, ".myc"), { recursive: true });
    const check = await openReplica(verify, "siteV", T0 + 5000);
    const r = importGraph(check.store, join(ca, GRAPH_REL));
    expect(r.collided).toEqual([]);
    expect(r.deferred).toEqual([]);
    const nodes = check.driver.database
      .query("SELECT count(*) AS n FROM nodes")
      .get() as { n: number };
    expect(nodes.n).toBe(45);
  });

  test("один сайт, два экспорта одного файла: объединение по-прежнему молчит", async () => {
    const dir = mkdtempSync(join(root, "same-site-"));
    mkdirSync(join(dir, ".myc"), { recursive: true });
    const r = await openReplica(dir, "siteOne", T0 + 7000);
    for (let i = 0; i < 10; i++) r.store.createNode({ kind: "task", title: `узел ${i}` });
    const early = mkdtempSync(join(root, "early-"));
    exportGraph(r.driver, early);
    const oursText = [...readOplogFiles(early).values()][0]!;

    for (let i = 0; i < 10; i++) r.store.createNode({ kind: "task", title: `ещё ${i}` });
    const late = mkdtempSync(join(root, "late-"));
    exportGraph(r.driver, late);
    const theirsText = [...readOplogFiles(late).values()][0]!;

    // Надмножество поверх подмножества: все совпадающие строки — повторы.
    const union = unionOplogText(oursText, theirsText);
    expect(splitLines(union.text).length).toBe(splitLines(theirsText).length);
    expect(union.added).toBe(
      splitLines(theirsText).length - splitLines(oursText).length,
    );
    expect(union.text).toBe(theirsText);
  });
});
