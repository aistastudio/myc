/**
 * Приёмка ИСЧЕРПЫВАЮЩЕГО поиска литерала (memory-5nvk1hwcene2).
 *
 * Главное свойство здесь — «ни одного вхождения не потеряно», и проверяется
 * оно тем, что найти обязано БОЛЬШЕ, чем знает индекс: строковую константу,
 * markdown и слово внутри комментария. Если бы `grep` читал `code_ref_sites`
 * вместо файлов, эти три случая молча исчезли бы — и выдача выглядела бы
 * полной.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { grepCode } from "./grep.ts";

const A = `// needle в комментарии верхнего уровня
export function alpha(): string {
  const s = "needle внутри строковой константы";
  return s + "needle";
}

export function beta(): number {
  return 1;
}
`;

const B = `export class Gamma {
  run(): string {
    return "NEEDLE в верхнем регистре";
  }
}
`;

const MD = "# Заметка\n\nneedle упомянут в markdown, который парсер не разбирает.\n";

let work: string;
let dir: string;
let db: Database;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "code-grep-"));
  dir = join(work, "tree");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), A);
  writeFileSync(join(dir, "src", "b.ts"), B);
  writeFileSync(join(dir, "NOTES.md"), MD);
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  await runCodeIndex(db, { repoId: "r", root: dir });
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

test("находит ВСЕ вхождения, включая те, которых нет в индексе символов", () => {
  const r = grepCode(db, "r", dir, "needle");
  // 1 комментарий + 2 в строковых константах (одна строка с двумя — считается
  // по вхождениям) + 1 в markdown. Регистр по умолчанию учитывается, поэтому
  // NEEDLE из b.ts сюда не входит.
  expect(r.hits).toBe(4);
  expect(r.files).toBe(2);
  expect(r.searched).toBe(3);
  const paths = r.groups.map((g) => g.path).sort();
  expect(paths).toEqual(["NOTES.md", "src/a.ts", "src/a.ts"]);
});

test("вхождение относится к охватывающему символу, а не просто к файлу", () => {
  const r = grepCode(db, "r", dir, "needle");
  const inAlpha = r.groups.find((g) => g.symbol === "alpha");
  expect(inAlpha).toBeDefined();
  expect(inAlpha!.kind).toBe("function");
  expect(inAlpha!.hits.map((h) => h.line)).toEqual([3, 4]);
  // Комментарий верхнего уровня не принадлежит ни одному определению, и
  // приписывать его соседней функции нельзя.
  const top = r.groups.find((g) => g.path === "src/a.ts" && g.symbol === "");
  expect(top).toBeDefined();
  expect(top!.hits.map((h) => h.line)).toEqual([1]);
});

test("две одинаковых подстроки в одной строке считаются обе", () => {
  const r = grepCode(db, "r", dir, "needle");
  const line4 = r.groups.flatMap((g) => g.hits).find((h) => h.line === 4);
  expect(line4?.count).toBe(1);
  const line3 = r.groups.flatMap((g) => g.hits).find((h) => h.line === 3);
  expect(line3?.count).toBe(1);
  const two = grepCode(db, "r", dir, "e");
  expect(two.hits).toBeGreaterThan(two.groups.flatMap((g) => g.hits).length);
});

test("--ignore-case добавляет ровно верхний регистр, и это видно числом", () => {
  const strict = grepCode(db, "r", dir, "needle");
  const loose = grepCode(db, "r", dir, "needle", { ignoreCase: true });
  expect(loose.hits).toBe(strict.hits + 1);
  expect(loose.groups.some((g) => g.path === "src/b.ts" && g.symbol === "run")).toBe(true);
});

test("--lang сужает просмотр, и объём просмотра называется", () => {
  const all = grepCode(db, "r", dir, "needle");
  const tsOnly = grepCode(db, "r", dir, "needle", { langs: ["ts"] });
  expect(tsOnly.searched).toBe(2);
  expect(all.searched).toBe(3);
  expect(tsOnly.groups.some((g) => g.path === "NOTES.md")).toBe(false);
});

test("файл сверх потолка размера ПРОПУСКАЕТСЯ ПОИМЁННО, а не молча", () => {
  const r = grepCode(db, "r", dir, "needle", { maxFileBytes: 10 });
  expect(r.hits).toBe(0);
  expect(r.skipped.length).toBe(3);
  expect(r.skipped.map((s) => s.path).sort()).toEqual(["NOTES.md", "src/a.ts", "src/b.ts"]);
});

test("файл исчез с диска — он посчитан как отставший индекс, а не как ноль вхождений", () => {
  rmSync(join(dir, "src", "a.ts"));
  const r = grepCode(db, "r", dir, "needle");
  expect(r.missing).toBe(1);
  expect(r.searched).toBe(2);
  expect(r.hits).toBe(1);
});

test("литерала нет — ноль вхождений и просмотр названный", () => {
  const r = grepCode(db, "r", dir, "квазистеллар");
  expect(r.hits).toBe(0);
  expect(r.groups).toEqual([]);
  expect(r.searched).toBe(3);
});

test("потолок групп режет ВЫДАЧУ, но не счёт: обрыв виден", () => {
  const r = grepCode(db, "r", dir, "needle", { limit: 1 });
  expect(r.truncated).toBe(true);
  expect(r.groups.length).toBe(1);
  expect(r.hits).toBe(4);
});
