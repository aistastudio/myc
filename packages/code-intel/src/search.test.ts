/**
 * Приёмка КОРПУСА ПОИСКА и ранжирования (memory-5nvk1hwcene2).
 *
 * Что здесь обязано ловиться, помимо «находит ли»:
 *   — инкрементальность по хешу: второй прогон не трогает ничего, а правка
 *     одного файла перестраивает ровно его;
 *   — снятие единиц вместе с файлом: `path:line` в исчезнувший файл — ложь;
 *   — свёртка в файлы: файл, где совпало НЕСКОЛЬКО символов, обязан обходить
 *     файл с одним случайным совпадением. Это и есть решение, ради которого
 *     ранжирование написано, и снятие свёртки обязано ронять тест;
 *   — лестница: вопрос, где одно слово стоит не в той форме, обязан
 *     отвечаться, а не обнуляться (S44).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { buildSearchUnits, docAbove, fileHeader, searchCode, splitIdent } from "./search.ts";

const REACH = `/**
 * ОХВАТ ПАМЯТИ: у знания есть охват — сессия или проект.
 */

/** Личность текущей сессии; пустая строка — сессия неизвестна. */
export function resolveSession(explicit: string): string {
  return explicit.trim();
}

/** Видно ли знание в сессии. */
export function visibleInSession(a: string, b: string): boolean {
  return a === b;
}
`;

const NOISE = `// Совсем про другое: каталоги и пути.
export function findDir(start: string): string {
  // Из worktree резолвится в основное дерево; сессия тут ни при чём.
  return start;
}
`;

let work: string;
let dir: string;
let db: Database;

/** То же, что делает `myc code index`: разбор, а следом корпус поиска. */
async function index(): Promise<void> {
  await runCodeIndex(db, { repoId: "r", root: dir });
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "code-search-"));
  dir = join(work, "tree");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "reach.ts"), REACH);
  writeFileSync(join(dir, "src", "noise.ts"), NOISE);
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  await index();
  buildSearchUnits(db, "r", dir);
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

test("корпус строится из определений и шапок файлов", () => {
  const r = db.query("SELECT COUNT(*) AS n FROM code_units WHERE repo_id = 'r'").get() as {
    n: number;
  };
  expect(r.n).toBe(5);
  // Две шапки + resolveSession + visibleInSession + findDir.
  const kinds = db
    .query("SELECT unit, COUNT(*) AS n FROM code_units WHERE repo_id = 'r' GROUP BY unit")
    .all() as Array<{ unit: string; n: number }>;
  expect(kinds.find((k) => k.unit === "file")?.n).toBe(2);
  expect(kinds.find((k) => k.unit === "def")?.n).toBe(3);
});

test("второй прогон ничего не перестраивает: инкрементальность по хешу файла", () => {
  const again = buildSearchUnits(db, "r", dir);
  expect(again.rebuilt).toBe(0);
  expect(again.reused).toBe(2);
  expect(again.units).toBe(5);
});

test("правка файла перестраивает ровно его, и новый символ находится", async () => {
  writeFileSync(
    join(dir, "src", "reach.ts"),
    `${REACH}\n/** Отпечаток эпизода сжатия. */\nexport function episodeKey(id: string): string {\n  return id;\n}\n`,
  );
  await index();
  const r = buildSearchUnits(db, "r", dir);
  expect(r.rebuilt).toBe(1);
  expect(r.reused).toBe(1);
  const hit = searchCode(db, "r", "отпечаток эпизода сжатия").hits[0];
  expect(hit?.path).toBe("src/reach.ts");
  expect(hit?.units.some((u) => u.name === "episodeKey")).toBe(true);
});

test("исчезнувший файл уносит свои единицы: path:line в никуда не остаётся", async () => {
  rmSync(join(dir, "src", "noise.ts"));
  await index();
  const r = buildSearchUnits(db, "r", dir);
  expect(r.removed).toBeGreaterThanOrEqual(1);
  const left = db
    .query("SELECT COUNT(*) AS n FROM code_units WHERE repo_id = 'r' AND path = 'src/noise.ts'")
    .get() as { n: number };
  expect(left.n).toBe(0);
  // Строка FTS5 обязана уйти вместе со строкой единицы, иначе выдача будет
  // ссылаться на rowid, которого в code_units больше нет.
  const orphans = db
    .query("SELECT COUNT(*) AS n FROM code_fts f LEFT JOIN code_units u ON u.id = f.rowid WHERE u.id IS NULL")
    .get() as { n: number };
  expect(orphans.n).toBe(0);
});

test("свёртка в файлы: счёт файла — СУММА вкладов, а не лучший из них", () => {
  const res = searchCode(db, "r", "сессия охват знания");
  expect(res.hits.length).toBeGreaterThan(0);
  const top = res.hits[0]!;
  expect(top.path).toBe("src/reach.ts");
  // Совпало несколько единиц файла, и счёт СТРОГО больше лучшей из них: без
  // свёртки счёт равнялся бы максимуму, и файл с одним ярким совпадением
  // обходил бы файл, который весь про это. Ровно эта разница даёт
  // MRR 0.52 -> 0.66 на bench/code-search-queries.json.
  expect(top.units.length).toBeGreaterThan(1);
  // Счёт файла РАВЕН вкладу шапки плюс сумма вкладов единиц — то есть они
  // именно сложены. Замена `+=` на `Math.max` в свёртке роняет эту строку:
  // максимум строго меньше суммы, когда единиц больше одной.
  const sum = top.units.reduce((n, u) => n + u.score, 0);
  const best = Math.max(...top.units.map((u) => u.score), 0);
  expect(sum).toBeGreaterThan(best);
  expect(top.score).toBeCloseTo(top.headerScore + sum, 10);
  // Файл-шум тоже упоминает «сессия», но одним местом: он обязан быть ниже.
  const noise = res.hits.find((h) => h.path === "src/noise.ts");
  if (noise !== undefined) expect(top.score).toBeGreaterThan(noise.score);
});

test("потолок единиц на файл: --symbols 1 действительно режет свёртку", () => {
  const wide = searchCode(db, "r", "сессия охват знания");
  const narrow = searchCode(db, "r", "сессия охват знания", { unitsPerFile: 1 });
  const w = wide.hits.find((h) => h.path === "src/reach.ts")!;
  const n = narrow.hits.find((h) => h.path === "src/reach.ts")!;
  expect(n.units.length).toBe(1);
  expect(w.score).toBeGreaterThan(n.score);
});

test("ступени лестницы сливаются, а не выбирается первая: слово не в той форме не обнуляет выдачу", () => {
  const res = searchCode(db, "r", "как резолвится сессии охват");
  expect(res.stages.length).toBeGreaterThan(1);
  expect(res.hits.some((h) => h.path === "src/reach.ts")).toBe(true);
});

test("поиск по имени символа работает и без единого слова прозы", () => {
  const res = searchCode(db, "r", "resolveSession");
  expect(res.hits[0]?.path).toBe("src/reach.ts");
  expect(res.hits[0]?.units.some((u) => u.name === "resolveSession")).toBe(true);
});

test("camelCase развёрнут: вопрос по одному слову имени находит символ", () => {
  const res = searchCode(db, "r", "resolve");
  expect(res.hits.some((h) => h.units.some((u) => u.name === "resolveSession"))).toBe(true);
});

test("пустая выдача приезжает вместе с тем, что просмотрено", () => {
  const res = searchCode(db, "r", "квазистеллар");
  expect(res.hits).toEqual([]);
  expect(res.searched.units).toBe(5);
  expect(res.searched.files).toBe(2);
});

test("корпуса нет — выдача пуста и объём просмотра равен нулю, а не выдумке", () => {
  const res = searchCode(db, "other-repo", "сессия");
  expect(res.hits).toEqual([]);
  expect(res.searched.units).toBe(0);
});

test("извлечение: шапка файла, комментарий над символом, развёртка имени", () => {
  const lines = REACH.split("\n");
  expect(fileHeader(lines)).toContain("ОХВАТ ПАМЯТИ");
  // Комментарий над resolveSession (строка объявления — 6-я).
  expect(docAbove(lines, 6)).toContain("Личность текущей сессии");
  expect(splitIdent("resolveSession")).toBe("resolve Session");
  expect(splitIdent("code_index.ts")).toBe("code index ts");
  expect(splitIdent("HTTPServer")).toBe("HTTP Server");
});
