/**
 * Ссылки в БАЗЕ: что индексатор пишет в `code_ref_sites`, как это читается
 * (`read.ts`) и почему повторный прогон не делает работу заново
 * (memory-e34bfse29jdw).
 *
 * Отдельный файл, а не набор внутри code_index.test.ts: тот проверяет
 * определения и очередь, и смешивать с ним сотню строк про рёбра — значит
 * получить файл, в котором падение ничего не локализует.
 *
 * `poolMinFiles: 0` везде: пул воркеров тут не проверяется (у него свой
 * набор), а на трёх файлах он только добавил бы неопределённость порядка.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex, type CodeIndexOptions } from "./code_index.ts";
import { listDefsAndRefs } from "./refs.ts";
import { loadLangs } from "./symbols.ts";
import { refsFrom, refsIndexed, refsTo } from "./read.ts";

let dir: string;
let db: Database;
let parseCalls = 0;

function opts(): CodeIndexOptions {
  return {
    repoId: "r",
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

const LIB = [
  "export function helper(n: number): number {", // 1
  "  return n + 1;", // 2
  "}", // 3
].join("\n");

const APP = [
  'import { helper } from "./lib.ts";', // 1
  "export function outer(n: number): number {", // 2
  "  function inner() {", // 3
  "    return helper(n);", // 4
  "  }", // 5
  "  return inner() + helper(1);", // 6
  "}", // 7
].join("\n");

beforeEach(async () => {
  await loadLangs(["ts"]);
  dir = mkdtempSync(join(tmpdir(), "myc-refs-"));
  db = new Database(":memory:");
  await migrate(db, { migrations, writable: true });
  parseCalls = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("индексатор пишет ссылки с местом и владельцем", () => {
  test("у каждой ссылки есть файл, строка и охватывающий символ", async () => {
    write("lib.ts", LIB);
    write("app.ts", APP);
    const res = await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(res.drain.written).toBe(2);
    expect(res.drain.refs).toBeGreaterThan(0);

    expect(
      refsTo(db, "r", "helper").map((r) => [r.path, r.line, r.kind, r.from]),
    ).toEqual([
      ["app.ts", 1, "import", ""],
      ["app.ts", 4, "call", "inner"],
      ["app.ts", 6, "call", "outer"],
    ]);
  });

  test("владелец ссылки — существующая строка code_defs", async () => {
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    const orphans = db
      .query(
        `SELECT r.name, r.line, r.from_name FROM code_ref_sites r
         WHERE r.repo_id = 'r' AND r.from_name <> ''
           AND NOT EXISTS (
             SELECT 1 FROM code_defs d
             WHERE d.repo_id = r.repo_id AND d.path = r.path
               AND d.name = r.from_name AND d.span_start = r.from_start)`,
      )
      .all();
    expect(orphans).toEqual([]);
  });

  test("обратное направление: что зовёт сам символ", async () => {
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    // `outer` содержит вызовы inner и helper на строке 6; `inner` — свой
    // вызов на строке 4, и он принадлежит ЕМУ, а не outer.
    expect(refsFrom(db, "r", "inner").map((r) => [r.line, r.name, r.kind])).toEqual([
      [4, "helper", "call"],
      [4, "n", "read"],
    ]);
    // Порядок внутри строки — по ключу таблицы (line, name), а не по тексту:
    // ответ обязан быть воспроизводимым, а не зависеть от порядка обхода.
    expect(refsFrom(db, "r", "outer").map((r) => [r.line, r.name, r.kind])).toEqual([
      [6, "helper", "call"],
      [6, "inner", "call"],
    ]);
  });

  test("refsIndexed отличает «никто не зовёт» от «ссылок ещё нет»", async () => {
    expect(refsIndexed(db, "r")).toBe(0);
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(refsIndexed(db, "r")).toBeGreaterThan(0);
    expect(refsTo(db, "r", "неведомое")).toEqual([]);
  });

  test("фильтр по виду: вызовы отдельно от импортов", async () => {
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(refsTo(db, "r", "helper", { kinds: ["call"] }).map((r) => r.line)).toEqual([4, 6]);
    expect(refsTo(db, "r", "helper", { kinds: ["import"] }).map((r) => r.line)).toEqual([1]);
  });
});

describe("инкрементальность", () => {
  test("повторный прогон без изменений не разбирает и не трогает ссылки", async () => {
    write("lib.ts", LIB);
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    const before = refsIndexed(db, "r");
    expect(before).toBeGreaterThan(0);
    const calls = parseCalls;

    parseCalls = 0;
    const second = await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(parseCalls).toBe(0);
    expect(second.drain.parsed).toBe(0);
    expect(second.drain.refs).toBe(0);
    expect(refsIndexed(db, "r")).toBe(before);
    expect(calls).toBe(2);
  });

  test("МУТАЦИЯ incremental:false: те же файлы разбираются заново", async () => {
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    const before = refsIndexed(db, "r");

    parseCalls = 0;
    await runCodeIndex(db, { ...opts(), incremental: false }, { poolMinFiles: 0 });
    expect(parseCalls).toBe(1);
    // Ссылки не удвоились: строки файла заменяются целиком.
    expect(refsIndexed(db, "r")).toBe(before);
  });

  test("правка файла заменяет его ссылки, а не дописывает вторые", async () => {
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(refsTo(db, "r", "helper").length).toBe(3);

    write(
      "app.ts",
      ['import { helper } from "./lib.ts";', "export function outer() {", "  return 1;", "}"].join(
        "\n",
      ),
    );
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(refsTo(db, "r", "helper").map((r) => [r.line, r.kind])).toEqual([[1, "import"]]);
  });

  test("исчезнувший файл уносит свои ссылки", async () => {
    write("lib.ts", LIB);
    write("app.ts", APP);
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(refsTo(db, "r", "helper").length).toBe(3);

    rmSync(join(dir, "app.ts"));
    await runCodeIndex(db, opts(), { poolMinFiles: 0 });
    expect(refsTo(db, "r", "helper")).toEqual([]);
    // Уцелевшие строки — только из живого файла: чистка идёт по префиксу
    // ключа (repo_id, path), а не по имени символа.
    const paths = db
      .query("SELECT DISTINCT path FROM code_ref_sites WHERE repo_id = 'r'")
      .all() as Array<{ path: string }>;
    expect(paths.map((p) => p.path)).toEqual(["lib.ts"]);
  });
});

describe("пул воркеров отдаёт ссылки так же, как главный поток", () => {
  test("разбор в воркере и разбор здесь дают один результат", async () => {
    // Пул включается с первого файла (poolMinFiles: 1) и работает только
    // когда разбор НЕ подменён — поэтому opts() здесь без `parse`.
    for (let i = 0; i < 4; i++) write(`m${i}.ts`, APP);
    const pooled = new Database(":memory:");
    await migrate(pooled, { migrations, writable: true });
    const res = await runCodeIndex(
      pooled,
      { repoId: "r", root: dir, now: 1_000_000 },
      { poolMinFiles: 1 },
    );
    // Пул может не завестись (мало ядер) — тогда разбор идёт здесь же, и
    // ответ обязан быть тем же. Проверяем результат, а не путь.
    expect(res.drain.written).toBe(4);
    const rows = refsTo(pooled, "r", "helper").map((r) => [r.path, r.line, r.kind, r.from]);
    expect(rows.length).toBe(12);
    expect(rows.filter((r) => r[0] === "m0.ts")).toEqual([
      ["m0.ts", 1, "import", ""],
      ["m0.ts", 4, "call", "inner"],
      ["m0.ts", 6, "call", "outer"],
    ]);
    pooled.close();
  });
});
