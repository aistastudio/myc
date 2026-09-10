#!/usr/bin/env bun
/**
 * ЗАМЕР ВХОДА код-индекса (memory-m30yh8swnm1d): сколько стоит прогон и
 * почему он не в горячем пути.
 *
 *   bun run packages/code-intel/src/bench-code-index-entry.ts [--root <repo>]
 *
 * Методика — @myc/bench (`measureAsync`/`report`): прогрев, независимые
 * прогоны, перцентили, эталонная операция рядом и условия машины в той же
 * строке. Свой цикл здесь не пишется: он не считает дрожание и врёт ровно
 * тогда, когда рядом идёт сборка.
 *
 * Меряются ТРИ разные величины, и путать их нельзя:
 *   1. `full` — первая сборка индекса на копии репозитория. Это цена,
 *      названная в И1 «секунды»: она и есть довод, почему вход отсоединённый.
 *   2. `incremental` — повторный прогон по неизменённому дереву: скан без
 *      чтения файлов, разбора нет вовсе.
 *   3. `drain-step` — то, что ДЕЙСТВИТЕЛЬНО платит вызвавшая команда: шаг
 *      дренажа, который решает, поднимать ли воркер. Его бюджет — 50 мс на
 *      весь дренаж, и относительно него меряется всё остальное.
 *
 * Дерево КОПИРУЕТСЯ (git ls-files, с mtime), все прогоны идут над копией:
 * оригинал только читается, а числа воспроизводятся.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { machine, measureAsync, report } from "@myc/bench";
import { STORE_PRAGMAS, migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { indexScope } from "./read.ts";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const ROOT = arg("--root", process.env["MYC_BENCH_ROOT"] ?? new URL("../../..", import.meta.url).pathname);

const m = machine();
console.log(`[bench] code index: root ${ROOT}, ${m.cpus} cores, load1 ${m.load1}`);

// ---------------------------------------------------------------------------
// Копия дерева
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "code-index-entry-"));
const tree = join(work, "tree");
mkdirSync(tree);
const ls = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT });
if (ls.status !== 0) throw new Error("needs a git repository: the file list comes from git ls-files");
const rels = ls.stdout.toString().split("\0").filter((s) => s.length > 0);
let copied = 0;
let bytes = 0;
for (const rel of rels) {
  let st;
  try {
    st = statSync(join(ROOT, rel));
  } catch {
    continue;
  }
  if (!st.isFile()) continue;
  const dst = join(tree, rel);
  mkdirSync(join(dst, ".."), { recursive: true });
  writeFileSync(dst, readFileSync(join(ROOT, rel)));
  utimesSync(dst, st.atime, st.mtime);
  copied++;
  bytes += st.size;
}
console.log(`[bench] tree: ${copied} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);

function freshDb(): Database {
  const path = join(work, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(path);
  for (const p of STORE_PRAGMAS) db.exec(p);
  return db;
}

// ---------------------------------------------------------------------------
// 1. Полная сборка: каждый прогон — своя пустая база
// ---------------------------------------------------------------------------

const dbs: Database[] = [];
const full = await measureAsync(
  "code-index full (empty db, whole tree)",
  async () => {
    const db = freshDb();
    await migrate(db, { migrations, writable: true, ignoreSchemaSkew: false });
    const t0 = performance.now();
    await runCodeIndex(db, { repoId: "bench", root: tree });
    const took = performance.now() - t0;
    dbs.push(db);
    return took;
  },
  { warmup: 1, iters: 3, trials: 1 },
);
report(full, `index: ${(() => {
  const s = indexScope(dbs[dbs.length - 1]!, "bench");
  return `${s.files} files, ${s.defs} symbols, ${s.l1Files} L1`;
})()}`);

// ---------------------------------------------------------------------------
// 2. Повторный прогон по неизменённому дереву
// ---------------------------------------------------------------------------

const warm = dbs[dbs.length - 1]!;
const incr = await measureAsync(
  "code-index repeat (tree unchanged)",
  async () => {
    const t0 = performance.now();
    await runCodeIndex(warm, { repoId: "bench", root: tree });
    return performance.now() - t0;
  },
  { warmup: 2, iters: 8, trials: 3 },
);
report(incr);

// ---------------------------------------------------------------------------
// 3. То, что платит вызвавшая команда: решение «поднимать ли воркер»
// ---------------------------------------------------------------------------

const stepDb = freshDb();
await migrate(stepDb, { migrations, writable: true, ignoreSchemaSkew: false });
stepDb
  .query("INSERT INTO myc_meta (key, value) VALUES ('code_indexed_at', ?1)")
  .run(String(Date.now()));
const step = await measureAsync(
  "drain step: worker decision (what the command pays)",
  async () => {
    const t0 = performance.now();
    const stamp = stepDb.query("SELECT value FROM myc_meta WHERE key = 'code_indexed_at'").get() as
      | { value: string }
      | null;
    const due = Date.now() - Number(stamp?.value ?? 0) >= 900_000;
    if (due) stepDb.query("SELECT 1 FROM anchors LIMIT 1").get();
    return performance.now() - t0;
  },
  { warmup: 20, iters: 200, trials: 3, budgetMs: 1 },
);
report(step, "whole drain budget — 50 ms (DEFAULT_DRAIN_BUDGET_MS)");

console.log(
  `[bench] VERDICT: full build p50=${(full.stats.p50 / 1000).toFixed(2)} s — ` +
    `${(full.stats.p50 / 50).toFixed(0)} drain budgets; it will never run inline (I1). ` +
    `The command pays only the step: p99=${step.stats.p99.toFixed(3)} ms.`,
);

for (const db of dbs) db.close();
stepDb.close();
rmSync(work, { recursive: true, force: true });
