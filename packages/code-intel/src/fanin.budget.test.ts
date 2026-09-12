/**
 * Бюджет ЧТЕНИЯ fan_in (memory-g79mpkt53yn3, решение S9).
 *
 * S9 родился из того, что рою (отпечаток задачи) нужно число с таймаутом
 * 2 мс, а `callers` стоит от 40 мс. Теперь число лежит в `code_refs`, и
 * читатель — `storedFanIn` — это поиск по первичному ключу.
 *
 * Три утверждения по методике @myc/bench:
 *   структурное — план чтения идёт по первичному ключу (read.test.ts);
 *   относительное — чтение готового против СОПЕРНИКА «счёт по требованию»
 *     (прежний `fanIn` из read.ts дословно: регулярка по L1-корпусу), на том
 *     же индексе, чередуясь; это и есть «до/после» задачи;
 *   абсолютное — p99 чтения в бюджете S9 (2 мс), только при годных условиях.
 *
 * Стенд — реальный код: исходники этого пакета, скопированные во временное
 * дерево (≈50 файлов, ≈1 МБ, сотни имён).
 *
 * Замер на этом стенде (14 ядер, load1 6.3 — рядом работали другие агенты;
 * четыре прогона по 3×40): чтение p50 8.9–11.5 мкс, p99 70–90 мкс; соперник
 * p50 0.60 мс, p99 1.2 мс — ×57…×67 по p50. На всём этом репозитории
 * (504 L1-файла, 7.2 МБ) соперник стоит 13–64 мс на имя, так что стенд здесь
 * к сопернику ещё добр. Порог ×15 — почти вчетверо ниже худшего замера: он
 * не различает ×50 и ×70, но отделяет чтение колонки от любого прохода по
 * файлам при любой загрузке.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectAheadOfRival, expectWithinBudget, measure, report } from "@myc/bench";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { recountFanIn } from "./fanin.ts";
import { L1_LANGS } from "./langs.ts";
import { storedFanIn } from "./read.ts";

/** Таймаут, который рой просил у `callers` (S9): чтение обязано в него укладываться. */
const READ_BUDGET_MS = 2;
const READ_MIN_SLOWDOWN = 15;

let work: string;
let tree: string;
let db: Database;
let names: string[];

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "code-fanin-budget-"));
  tree = join(work, "tree");
  mkdirSync(tree, { recursive: true });
  for (const f of readdirSync(import.meta.dir)) {
    if (f.endsWith(".ts") && !f.endsWith(".test.ts")) copyFileSync(join(import.meta.dir, f), join(tree, f));
  }
  db = new Database(join(work, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });
  await runCodeIndex(db, { repoId: "r", root: tree });
  recountFanIn(db, { repoId: "r", root: tree });
  names = (db.query("SELECT DISTINCT name FROM code_defs WHERE repo_id = 'r' ORDER BY name").all() as Array<{
    name: string;
  }>).map((r) => r.name);
});

afterAll(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

/** СОПЕРНИК — прежний счёт по требованию (read.ts до этой задачи), без записи в кеш. */
function countOnDemand(name: string): number {
  const defLines = new Map<string, Set<number>>();
  for (const d of db.query("SELECT path, span_start FROM code_defs WHERE repo_id = 'r' AND name = ?1").all(name) as Array<{
    path: string;
    span_start: number;
  }>) {
    const s = defLines.get(d.path) ?? new Set<number>();
    s.add(d.span_start);
    defLines.set(d.path, s);
  }
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  let hits = 0;
  for (const p of db.query("SELECT path, lang FROM code_files WHERE repo_id = 'r'").all() as Array<{ path: string; lang: string }>) {
    if (!L1_LANGS.has(p.lang)) continue;
    const text = readFileSync(join(tree, p.path), "utf8");
    if (!text.includes(name)) continue;
    const skip = defLines.get(p.path);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (skip?.has(i + 1) === true) continue;
      word.lastIndex = 0;
      hits += (lines[i]!.match(word) ?? []).length;
    }
  }
  return hits;
}

test("чтение fan_in — колонка: в бюджете S9 и на порядки впереди счёта по требованию", () => {
  expect(names.length).toBeGreaterThan(300);
  let i = 0;
  let j = 0;
  const m = measure(
    "fan_in read (stored, code_refs PK)",
    () => {
      const f = storedFanIn(db, "r", names[i++ % names.length]!);
      if (f === null) throw new Error("fan_in not stored");
    },
    {
      warmup: 10,
      iters: 40,
      budgetMs: READ_BUDGET_MS,
      rival: () => void countOnDemand(names[j++ % names.length]!),
      rivalLabel: "count on demand (the pre-S9 reader)",
    },
  );
  report(m);
  expectAheadOfRival(m, READ_MIN_SLOWDOWN);
  expectWithinBudget(m);
});
