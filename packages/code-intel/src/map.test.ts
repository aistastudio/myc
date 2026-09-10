/**
 * Приёмка КАРТЫ РЕПОЗИТОРИЯ (memory-5nvk1hwcene2).
 *
 * Главное, что здесь стережётся, — не «печатается ли карта», а ЧЕСТНОСТЬ
 * рёбер. Карта считается по `code_ref_sites`, где лежит синтаксическое
 * вхождение имени, а не разрешённая ссылка. Два дефекта возможны и оба
 * молчаливы:
 *   — локальная переменная с именем чужой функции превращается в «ребро», и
 *     хабом репозитория становится счётчик цикла;
 *   — одноимённое определение в двух файлах приписывает импорт не тому
 *     каталогу.
 * Оба закрыты фильтрами, и снятие любого из них обязано ронять тест.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { repoMap } from "./map.ts";

const CORE = `export function openStore(): number {
  return 1;
}
export function helper(): number {
  return 2;
}
`;

// Локальная переменная с именем чужой функции: приманка для «ребра по любому
// вхождению». Импорта здесь НЕТ.
const NOISE = `export function unrelated(): number {
  const openStore = 5;
  const helper = openStore + 1;
  return helper + openStore + helper + openStore;
}
`;

const APP_A = `import { openStore } from "../core/store.ts";
export function runA(): number {
  return openStore();
}
`;

const APP_B = `import { openStore } from "../core/store.ts";
export function runB(): number {
  return openStore();
}
`;

let work: string;
let dir: string;
let db: Database;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "code-map-"));
  dir = join(work, "tree");
  mkdirSync(join(dir, "core"), { recursive: true });
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "core", "store.ts"), CORE);
  writeFileSync(join(dir, "app", "noise.ts"), NOISE);
  writeFileSync(join(dir, "app", "a.ts"), APP_A);
  writeFileSync(join(dir, "app", "b.ts"), APP_B);
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  await runCodeIndex(db, { repoId: "r", root: dir });
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

test("итоги считаются по индексу, а не пересчитываются заново", () => {
  const m = repoMap(db, "r", { depth: 1 });
  expect(m.files).toBe(4);
  expect(m.defs).toBe(5);
  expect(m.refs).toBeGreaterThan(m.imports);
  expect(m.imports).toBe(2);
  expect(m.dirs).toBe(2);
  expect(m.langs.find((l) => l.lang === "ts")?.files).toBe(4);
});

test("хаб считается по import, а не по любому вхождению имени", () => {
  const m = repoMap(db, "r", { depth: 1 });
  const core = m.clusters.find((c) => c.dir === "core")!;
  expect(core.hubs[0]?.name).toBe("openStore");
  // Два импорта, и НЕ шесть: локальные `openStore`/`helper` в noise.ts —
  // переменные, а не обращения к этим функциям. Именно эта строка ломается,
  // если из запроса убрать `kind = 'import'`.
  expect(core.hubs[0]?.refs).toBe(2);
  // `helper` не импортируют нигде — хабом он быть не может, сколько бы раз
  // это слово ни встретилось в чужом файле.
  expect(core.hubs.some((h) => h.name === "helper")).toBe(false);
});

test("связность: кто из какого каталога импортирует", () => {
  const m = repoMap(db, "r", { depth: 1 });
  const core = m.clusters.find((c) => c.dir === "core")!;
  expect(core.usedBy).toEqual([{ dir: "app", refs: 2 }]);
  const app = m.clusters.find((c) => c.dir === "app")!;
  expect(app.usedBy).toEqual([]);
  expect(m.crossEdges).toBe(2);
});

test("одноимённое определение выбывает из рёбер и попадает в счётчик", async () => {
  writeFileSync(
    join(dir, "app", "dup.ts"),
    `export function openStore(): number {\n  return 3;\n}\n`,
  );
  await runCodeIndex(db, { repoId: "r", root: dir });
  const m = repoMap(db, "r", { depth: 1 });
  expect(m.ambiguousEdges).toBe(2);
  expect(m.crossEdges).toBe(0);
  const core = m.clusters.find((c) => c.dir === "core")!;
  expect(core.hubs).toEqual([]);
});

test("срез по top виден как срез: всего каталогов названо отдельно", () => {
  const m = repoMap(db, "r", { depth: 1, top: 1 });
  expect(m.clusters.length).toBe(1);
  expect(m.dirs).toBe(2);
});

test("пустой репозиторий — нули, а не выдумка", () => {
  const m = repoMap(db, "other", { depth: 1 });
  expect(m.files).toBe(0);
  expect(m.defs).toBe(0);
  expect(m.clusters).toEqual([]);
  expect(m.crossEdges).toBe(0);
});
