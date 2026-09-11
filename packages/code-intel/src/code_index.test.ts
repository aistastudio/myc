import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { jobs, migrate, migrations } from "@myc/store-sqlite";
import {
  CODE_INDEX_JOB_KIND,
  drainCodeIndex,
  langOf,
  runCodeIndex,
  scanCodeIndex,
  type CodeIndexOptions,
} from "./code_index.ts";
import { listDefsAndRefs } from "./refs.ts";

let dir: string;
let db: Database;
let parseCalls = 0;

function baseOpts(): CodeIndexOptions {
  return {
    repoId: "test-repo",
    root: dir,
    now: 1_000_000,
    parse: (source, lang) => {
      parseCalls++;
      return listDefsAndRefs(source, lang);
    },
  };
}

function write(path: string, content: string): void {
  const abs = join(dir, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function defNames(path: string): string[] {
  return (
    db
      .query("SELECT name FROM code_defs WHERE repo_id = 'test-repo' AND path = ?1 ORDER BY name")
      .all(path) as Array<{ name: string }>
  ).map((r) => r.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-code-index-"));
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function freshDb(): Promise<void> {
  await migrate(db, { migrations, writable: true });
}

describe("полный индекс", () => {
  test("дефсы с точными спанами, очередь снята, L0 в реестре без дефсов", async () => {
    await freshDb();
    write(
      "a.ts",
      [
        "export interface Shape {",
        "  area(): number;",
        "}",
        "",
        "export class Circle implements Shape {",
        "  area(): number {",
        "    return 1;",
        "  }",
        "}",
        "",
        "export function areaOf(s: Shape): number {",
        "  return s.area();",
        "}",
      ].join("\n"),
    );
    write("README.md", "# readme\n");

    const { scan, drain } = await runCodeIndex(db, baseOpts());

    expect(scan.files).toBe(2);
    expect(scan.l0Written).toBe(1);
    expect(scan.enqueued).toBe(1);
    expect(drain.parsed).toBe(1);
    expect(drain.failed).toBe(0);
    // Общая очередь: класс code_index, после разбора — пусто.
    const stats = jobs.stats(db, 1_000_000);
    const kind = stats.byKind.find((k) => k.kind === CODE_INDEX_JOB_KIND);
    expect(kind?.total ?? 0).toBe(0);

    // Реестр файлов: и L0-файл лежит рядом с кодом (§5 — доля языков).
    const files = db
      .query("SELECT path, lang FROM code_files WHERE repo_id = 'test-repo' ORDER BY path")
      .all() as Array<{ path: string; lang: string }>;
    expect(files).toEqual([
      { path: "README.md", lang: "md" },
      { path: "a.ts", lang: "ts" },
    ]);

    // Спаны — ровно то, что даёт разбор (один разбор — один источник истины).
    const src = readFileSync(join(dir, "a.ts"), "utf8");
    expect(defNames("a.ts")).toEqual(
      listDefsAndRefs(src, "ts").defs.map((d) => d.name).sort(),
    );
    const circle = (
      db
        .query(
          "SELECT span_start, span_end FROM code_defs WHERE repo_id='test-repo' AND path='a.ts' AND name='Circle'",
        )
        .get() as { span_start: number; span_end: number }
    );
    const lines = src.split("\n");
    expect(lines[circle.span_start - 1]).toContain("class Circle");
    expect(lines[circle.span_end - 1]).toContain("}");
  });

  test("mtime-тач без изменения содержимого не переразбирает (уровень 2 — хеш)", async () => {
    await freshDb();
    write("a.ts", "export function one() { return 1; }\n");
    await runCodeIndex(db, baseOpts());

    // Тач: mtime вперёд, содержимое то же.
    utimesSync(join(dir, "a.ts"), new Date(), new Date(2_000_000));
    const second = await runCodeIndex(db, baseOpts());
    expect(second.scan.touched).toBe(1);
    expect(second.scan.dirty).toBe(0);
    expect(second.drain.parsed).toBe(0);
    // Реестр запомнил новый mtime — следующий прогон снова уровень 1.
    const row = db
      .query("SELECT mtime_ms FROM code_files WHERE repo_id='test-repo' AND path='a.ts'")
      .get() as { mtime_ms: number };
    expect(row.mtime_ms).toBe(2_000_000);
  });

  test("правка одного файла: переразбор ровно одного, дефсы обновлены", async () => {
    await freshDb();
    write("a.ts", "export function one() { return 1; }\n");
    write("b.ts", "export function two() { return 2; }\n");
    await runCodeIndex(db, baseOpts());

    write("b.ts", "export function two() { return 22; }\nexport function three() { return 3; }\n");
    const second = await runCodeIndex(db, baseOpts());
    expect(second.scan.unchanged).toBe(1);
    expect(second.scan.dirty).toBe(1);
    expect(second.drain.parsed).toBe(1);
    expect(defNames("b.ts").sort()).toEqual(["three", "two"]);
  });

  test("удалённый файл: реестр и дефсы убраны", async () => {
    await freshDb();
    write("a.ts", "export function gone() {}\n");
    write("keep.ts", "export function kept() {}\n");
    await runCodeIndex(db, baseOpts());

    rmSync(join(dir, "a.ts"));
    const second = await runCodeIndex(db, baseOpts());
    expect(second.scan.removed).toBe(1);
    expect(defNames("a.ts")).toEqual([]);
    expect(defNames("keep.ts")).toEqual(["kept"]);
  });
});

describe("мутации приёмки", () => {
  test("мутация 2: freshness=mtime — правка с восстановленным mtime проходит мимо", async () => {
    await freshDb();
    // mtime выравнивается до целых миллисекунд: utimesSync принимает Date
    // (точность 1 мс), а statSync на APFS отдаёт доли миллисекунды — без
    // выравнивания восстановление не было бы точным.
    const before = "export function canary() { return 1; }\n";
    write("a.ts", before);
    utimesSync(join(dir, "a.ts"), new Date(1), new Date(2_000_000));
    await runCodeIndex(db, baseOpts());

    // Правка содержимого при сохранённом mtime (и размере — для чистоты опыта).
    const keep = (await import("node:fs")).statSync(join(dir, "a.ts"));
    const after = "export function canaryRenamed() { return 2; }\n";
    write("a.ts", after);
    utimesSync(join(dir, "a.ts"), keep.atime, keep.mtime);

    const run = await runCodeIndex(db, { ...baseOpts(), freshness: "mtime" });
    expect(run.scan.unchanged).toBe(1);
    expect(run.drain.parsed).toBe(0);
    // Канарейка не долетела: дефсы всё ещё про старое имя.
    expect(defNames("a.ts")).toEqual(["canary"]);

    // Рабочий режим тот же прогон ловит: размер разошёлся → грязный → разбор.
    const caught = await runCodeIndex(db, baseOpts());
    expect(caught.scan.dirty).toBe(1);
    expect(caught.drain.parsed).toBe(1);
    expect(defNames("a.ts")).toEqual(["canaryRenamed"]);
  });

  test("мутация 2б: freshness=mtime — тач приводит к разбору, hash-режим нет", async () => {
    await freshDb();
    // Два независимых файла: у каждого свой тач и свой режим сверки.
    write("hashmode.ts", "export function one() {}\n");
    write("mtimemode.ts", "export function two() {}\n");
    await runCodeIndex(db, baseOpts());

    utimesSync(join(dir, "hashmode.ts"), new Date(), new Date(5_000_000));
    const withHash = await runCodeIndex(db, baseOpts());
    expect(withHash.scan.touched).toBe(1);
    expect(withHash.drain.parsed).toBe(0);

    utimesSync(join(dir, "mtimemode.ts"), new Date(), new Date(6_000_000));
    const mtimeOnly = await runCodeIndex(db, { ...baseOpts(), freshness: "mtime" });
    expect(mtimeOnly.scan.dirty).toBe(1);
    expect(mtimeOnly.drain.parsed).toBe(1);
  });

  test("мутация 1: incremental=false — в работу становится каждый файл", async () => {
    await freshDb();
    write("a.ts", "export function one() {}\n");
    write("b.ts", "export function two() {}\n");
    await runCodeIndex(db, baseOpts());

    const noIncr = await runCodeIndex(db, { ...baseOpts(), incremental: false });
    expect(noIncr.scan.unchanged).toBe(0);
    expect(noIncr.scan.dirty).toBe(2);
    expect(noIncr.scan.enqueued).toBe(2);
    expect(noIncr.drain.parsed).toBe(2);
  });
});

describe("очередь и отказы", () => {
  test("скан без разбора: работа в общей очереди, повторный скан дедупом отсечён", async () => {
    await freshDb();
    write("a.ts", "export function one() {}\n");
    const first = await scanCodeIndex(db, baseOpts());
    expect(first.enqueued).toBe(1);

    const row = (
      db.query("SELECT kind, entity_id, scope, priority FROM jobs").get() as {
        kind: string;
        entity_id: string;
        scope: string;
        priority: number;
      }
    );
    expect(row.kind).toBe(CODE_INDEX_JOB_KIND);
    expect(row.entity_id).toBe("a.ts");
    expect(row.scope).toBe("test-repo");
    expect(row.priority).toBe(8);

    const second = await scanCodeIndex(db, baseOpts());
    expect(second.enqueued).toBe(0);

    const drained = await drainCodeIndex(db, baseOpts());
    expect(drained.claimed).toBe(1);
    expect(defNames("a.ts")).toEqual(["one"]);
  });

  test("работа мёртвого воркера: файл, исчезнувший к разбору, чистит строки", async () => {
    await freshDb();
    write("a.ts", "export function one() {}\n");
    await scanCodeIndex(db, baseOpts());
    rmSync(join(dir, "a.ts"));

    const drained = await drainCodeIndex(db, baseOpts());
    expect(drained.cleaned).toBe(1);
    expect(drained.parsed).toBe(0);
    expect(
      (db.query("SELECT count(*) AS n FROM code_files WHERE path='a.ts'").get() as { n: number }).n,
    ).toBe(0);
  });

  test("падение разбора: попытка засчитана, работа не потеряна, last_error виден", async () => {
    await freshDb();
    write("a.ts", "export function one() {}\n");
    await scanCodeIndex(db, baseOpts());

    const boom = (source: string): never => {
      throw new Error("парсер сломался");
    };
    const drained = await drainCodeIndex(db, { ...baseOpts(), parse: boom as never });
    expect(drained.failed).toBe(1);

    const row = db
      .query("SELECT attempts, last_error, lease_holder FROM jobs WHERE kind = ?1")
      .get(CODE_INDEX_JOB_KIND) as { attempts: number; last_error: string; lease_holder: string };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("парсер сломался");
    expect(row.lease_holder).toBe("");
  });

  test("пул разбора: большой батч через воркеров даёт тот же индекс", async () => {
    await freshDb();
    for (let i = 0; i < 20; i++) {
      write(`f${i}.ts`, `export function fn${i}() { return ${i}; }\n`);
    }
    // poolMinFiles: 1 заставляет пул включиться на маленьком дереве.
    const { scan, drain } = await runCodeIndex(
      db,
      { repoId: "test-repo", root: dir, now: 1_000_000 },
      { poolMinFiles: 1 },
    );
    expect(scan.enqueued).toBe(20);
    expect(drain.parsed).toBe(20);
    expect(drain.failed).toBe(0);
    const defs = (db.query("SELECT count(*) AS n FROM code_defs").get() as { n: number }).n;
    expect(defs).toBe(20);
    expect((jobs.stats(db, 1_000_000).byKind.find((k) => k.kind === CODE_INDEX_JOB_KIND)?.total ?? 0)).toBe(0);

    // Инкрементальный прогон: разборов нет ни в пуле, ни без него.
    const second = await runCodeIndex(db, { repoId: "test-repo", root: dir, now: 1_000_000 });
    expect(second.drain.parsed).toBe(0);
  });

  test("инвалидация fan_in: строки изменённых символов убираются из code_refs", async () => {
    await freshDb();
    write("a.ts", "export function stale() {}\n");
    await runCodeIndex(db, baseOpts());

    // Кеш fan_in, посчитанный кем-то (T5) раньше правки.
    db.query("INSERT INTO code_refs (repo_id, name, n_files, n_hits, computed_at) VALUES ('test-repo', 'stale', 3, 7, 1)")
      .run();

    write("a.ts", "export function fresh() {}\n");
    // mtime принудительно вперёд: две записи в одну миллисекунду при равном
    // размере — легитимный «неизменённый файл», разбора не будет.
    utimesSync(join(dir, "a.ts"), new Date(), new Date(9_000_000));
    await runCodeIndex(db, baseOpts());

    const names = (
      db.query("SELECT name FROM code_refs WHERE repo_id='test-repo'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toEqual([]);
  });
});

describe("langOf", () => {
  test("L1 и расширения", () => {
    expect(langOf("a.ts")).toBe("ts");
    expect(langOf("b.tsx")).toBe("tsx");
    expect(langOf("c.mjs")).toBe("js");
    expect(langOf("d.json")).toBe("json");
    // Без расширения языка нет — L0 с пустой меткой.
    expect(langOf("e")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Перечень: реестр git-репозитория — это его `git ls-files` (memory-rda12hcf2dt1)
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function registry(): Array<{ path: string; lang: string }> {
  return db
    .query("SELECT path, lang FROM code_files WHERE repo_id = 'test-repo' ORDER BY path")
    .all() as Array<{ path: string; lang: string }>;
}

describe("перечень", () => {
  // Глобальный ~/.config/git/ignore пользователя не должен решать исход теста.
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"]) saved[k] = process.env[k];
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.XDG_CONFIG_HOME = join(tmpdir(), "myc-code-index-no-xdg");
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("git-репозиторий: игнорируемое не в реестре, а попавшее туда раньше — убрано", async () => {
    await freshDb();
    git(dir, "init", "-q");
    write("a.ts", "export function one() {}\n");
    write("keys/worker-1.json", '{"secret":"SECRET-KEY-MATERIAL"}\n');
    git(dir, "add", "a.ts");
    git(dir, "commit", "-qm", "a");

    // Пока ключи никто не игнорирует, git их перечисляет (неотслеживаемый файл).
    const before = await runCodeIndex(db, baseOpts());
    expect(before.scan.gitRepos).toEqual(["."]);
    expect(before.scan.unignored).toEqual([]);
    expect(registry().map((r) => r.path)).toEqual(["a.ts", "keys/worker-1.json"]);

    // Игнор появился — строка уходит из реестра первым же прогоном. Ровно так
    // очищается реестр, собранный прежним обходом дерева.
    write(".gitignore", "keys/\n");
    const after = await runCodeIndex(db, baseOpts());
    expect(after.scan.removed).toBe(1);
    expect(after.scan.files).toBe(2);
    expect(registry().map((r) => r.path)).toEqual([".gitignore", "a.ts"]);
  });

  test("не-git: реестр — обход дерева, и ScanStats называет это с причиной", async () => {
    await freshDb();
    write("a.ts", "export function one() {}\n");
    const { scan } = await runCodeIndex(db, baseOpts());
    expect(scan.gitRepos).toEqual([]);
    expect(scan.unignored).toEqual([{ dir: ".", reason: "not a git repository" }]);
    expect(scan.files).toBe(1);
  });

  test("язык, записанный прежним langOf, исправляется без правки файла", async () => {
    await freshDb();
    write(".hooks/pre-commit", "#!/bin/sh\n");
    write("x/.ts", "export function ghost() {}\n");
    await runCodeIndex(db, baseOpts());
    expect(registry()).toEqual([
      { path: ".hooks/pre-commit", lang: "" },
      { path: "x/.ts", lang: "" },
    ]);

    // Так строки выглядели после прежнего langOf: «язык» из пути каталога и
    // L1-язык у файла по имени `.ts` — с определениями от его разбора.
    db.query("UPDATE code_files SET lang = 'hooks/pre-commit' WHERE path = '.hooks/pre-commit'").run();
    db.query("UPDATE code_files SET lang = 'ts' WHERE path = 'x/.ts'").run();
    db.query(
      "INSERT INTO code_defs (repo_id, path, name, kind, span_start, span_end) VALUES ('test-repo', 'x/.ts', 'ghost', 'function', 1, 1)",
    ).run();

    const { scan } = await runCodeIndex(db, baseOpts());
    expect(scan.unchanged).toBe(2);
    expect(scan.relabeled).toBe(2);
    expect(scan.dirty).toBe(0);
    expect(registry()).toEqual([
      { path: ".hooks/pre-commit", lang: "" },
      { path: "x/.ts", lang: "" },
    ]);
    // Разбора у L0-файла не будет — и определений от старого тоже.
    expect(defNames("x/.ts")).toEqual([]);

    // Исправленное не переписывается снова.
    const again = await runCodeIndex(db, baseOpts());
    expect(again.scan.relabeled).toBe(0);
  });
});
