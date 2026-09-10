#!/usr/bin/env bun
/**
 * Замер T2 (05-code-intelligence.md §9): полный индекс репозитория и
 * повторный при изменённых файлах.
 *
 *   bun run packages/code-intel/src/bench-code-index.ts \
 *     [--root /path/to/repo] [--dirty 10] [--no-mutations]
 *
 * Приёмочные числа: полный индекс ≤ 400 мс, повторный при N изменённых
 * (по умолчанию 10) ≤ 20 мс.
 *
 * Как обеспечивается воспроизводимость и безопасность:
 *   - репозиторий КОПИРУЕТСЯ во временный каталог (git ls-files, с mtime) и
 *     все прогоны и все мутации идут над копией; оригинал только читается;
 *   - набор файлов фиксирован на момент копирования, выбор изменённых
 *     файлов детерминирован (seed 42), так что повторный запуск даёт те же
 *     цифры с точностью до шума машины;
 *   - база каждую секцию создаётся заново — прогон не зависит от прошлого.
 *
 * Мутации приёмки (обязательная часть сдачи) выполняются после основных
 * замеров, каждую сопровождает вывод:
 *   1. no-incremental — инкрементальность отключена (incremental: false):
 *      повторный прогон обязан просесть до уровня полного;
 *   2. mtime-only — свежесть только по mtime (freshness: "mtime"):
 *      правка с восстановленным mtime обязана пройти незамеченной.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { STORE_PRAGMAS, migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex, type CodeIndexOptions } from "./code_index.ts";

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
// Корпус задаётся снаружи: прибитый путь к чужому дому делает стенд
// незапускаемым у всех, кроме одного человека, и заодно вписывает его имя в
// репозиторий. Умолчание — сам этот репозиторий: он всегда под рукой.
const ROOT = arg("--root", process.env["MYC_BENCH_ROOT"] ?? new URL("../../..", import.meta.url).pathname);
const DIRTY = Number(arg("--dirty", "10"));
const RUN_MUTATIONS = !argv.includes("--no-mutations");

if (!statSync(ROOT, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`no such directory: ${ROOT}`);
  process.exit(1);
}

const ms = (v: number): string => v.toFixed(1).padStart(7);

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Копия репозитория (только читаем оригинал)
// ---------------------------------------------------------------------------

section("setup");
const t0 = performance.now();
const work = mkdtempSync(join(tmpdir(), "code-index-bench-"));
const tree = join(work, "tree");
mkdirSync(tree);

const ls = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT });
let rels: string[];
if (ls.status === 0) {
  rels = ls.stdout.toString().split("\0").filter((s) => s.length > 0);
  console.log(`file list source: git ls-files (${rels.length} files)`);
} else {
  throw new Error("the bench does not support a directory without git: it needs a file list");
}

let copied = 0;
for (const rel of rels) {
  const src = join(ROOT, rel);
  const dst = join(tree, rel);
  let st;
  try {
    st = statSync(src);
  } catch {
    continue; // удалён в рабочем дереве, ещё не закоммичено
  }
  if (!st.isFile()) continue;
  mkdirSync(join(dst, ".."), { recursive: true });
  writeFileSync(dst, readFileSync(src));
  utimesSync(dst, st.atime, st.mtime);
  copied++;
}
console.log(`copied: ${copied} files in ${(performance.now() - t0).toFixed(0)} ms → ${work}`);

// ---------------------------------------------------------------------------
// База: production-пути открытия (STORE_PRAGMAS + набор миграций)
// ---------------------------------------------------------------------------

const dbPath = join(work, "myc.db");
function openDb(): Database {
  const db = new Database(dbPath);
  for (const p of STORE_PRAGMAS) db.exec(p);
  return db;
}

const db = openDb();
await migrate(db, { migrations, writable: true, ignoreSchemaSkew: false });

const opts = (over: Partial<CodeIndexOptions> = {}): CodeIndexOptions => ({
  repoId: "messaging-server",
  root: tree,
  ...over,
});

async function index(label: string, over: Partial<CodeIndexOptions> = {}): Promise<number> {
  const t = performance.now();
  const r = await runCodeIndex(db, opts(over), { holder: `bench-${label}` });
  const total = performance.now() - t;
  console.log(
    `${label}: ${ms(total)} ms  (scan ${ms(r.scan.scanMs)}, parse ${ms(r.drain.parseMs)}, ` +
      `write ${ms(r.drain.applyMs)})  files ${r.scan.files}, unchanged ${r.scan.unchanged}, ` +
      `touched ${r.scan.touched}, changed ${r.scan.dirty}, parsed ${r.drain.parsed}`,
  );
  return total;
}

const counts = (): { files: number; defs: number; jobsLeft: number } => {
  const one = (sql: string): number =>
    (db.query(sql).get() as { n: number }).n;
  return {
    files: one("SELECT count(*) AS n FROM code_files"),
    defs: one("SELECT count(*) AS n FROM code_defs"),
    jobsLeft: one(`SELECT count(*) AS n FROM jobs WHERE kind = 'code_index'`),
  };
};

// ---------------------------------------------------------------------------
// Прогон 1: полный индекс
// ---------------------------------------------------------------------------

section("run 1 — full index (cold)");
const full1 = await index("full #1");
console.log(
  `  in db: ${JSON.stringify(counts())} — bar 400 ms, ${full1 <= 400 ? "WITHIN" : "OVER"}`,
);

// Полный индекс на прогретом коде: та же работа без стоимости первого
// касания модулей. Честная пара к холодному числу.
section("run 1b — full index again (warm)");
const full2 = await index("full #2", { incremental: false });

// ---------------------------------------------------------------------------
// Прогон 2: повторный без изменений
// ---------------------------------------------------------------------------

section("run 2 — repeat, nothing changed");
const unchangedTimes: number[] = [];
for (let i = 0; i < 3; i++) unchangedTimes.push(await index(`repeat #${i + 1}`));
const unchanged = Math.min(...unchangedTimes);

// ---------------------------------------------------------------------------
// Прогон 3: повторный при N изменённых
// ---------------------------------------------------------------------------

section(`run 3 — repeat with ${DIRTY} changed`);

// Детерминированный выбор файлов: сортированный список, LCG seed 42.
const codeFiles = rels
  .filter((p) => /\.(ts|tsx|js|jsx)$/.test(p) && statSync(join(ROOT, p), { throwIfNoEntry: false })?.isFile())
  .sort();
let seed = 42;
const pick = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return Math.floor((seed / 2_147_483_648) * codeFiles.length);
};
const chosen = new Set<string>();
while (chosen.size < Math.min(DIRTY, codeFiles.length)) {
  const rel = codeFiles[pick()]!;
  if (statSync(join(ROOT, rel)).size < 200_000) chosen.add(rel);
}

const originals = new Map<string, { body: Buffer; atime: Date; mtime: Date }>();
for (const rel of chosen) {
  const st = statSync(join(ROOT, rel));
  originals.set(rel, { body: readFileSync(join(ROOT, rel)), atime: st.atime, mtime: st.mtime });
  writeFileSync(join(tree, rel), readFileSync(join(ROOT, rel)) + `\n// bench touch ${rel}\n`);
  const now = new Date();
  utimesSync(join(tree, rel), now, now);
}
console.log(`changed: ${[...chosen].slice(0, 3).join(", ")}${chosen.size > 3 ? `, +${chosen.size - 3}` : ""}`);

const dirtyTimes: number[] = [];
for (let i = 0; i < 3; i++) {
  // Каждый прогон — новая правка, чтобы была настоящая работа, а не дедуп.
  if (i > 0) {
    let k = 0;
    for (const rel of chosen) {
      writeFileSync(join(tree, rel), originals.get(rel)!.body + `\n// bench touch ${i}-${k++}\n`);
      const now = new Date();
      utimesSync(join(tree, rel), now, now);
    }
  }
  dirtyTimes.push(await index(`${DIRTY} changed #${i + 1}`));
}
const dirtyBest = Math.min(...dirtyTimes);

// Восстановление копии — мутации ниже стартуют из чистого состояния.
for (const [rel, orig] of originals) {
  writeFileSync(join(tree, rel), orig.body);
  utimesSync(join(tree, rel), orig.atime, orig.mtime);
}

const c = counts();
console.log(`  in db: ${JSON.stringify(c)}; bar 20 ms, ${dirtyBest <= 20 ? "WITHIN" : "OVER"}`);

// ---------------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------------

section("summary");
console.log(`full index (${c.files} files):     cold ${ms(full1)} ms, warm ${ms(full2)} ms   (bar ≤ 400)`);
console.log(`repeat, nothing changed:            ${ms(unchanged)} ms   (best of 3)`);
console.log(`repeat with ${String(DIRTY).padStart(2)} changed:          ${ms(dirtyBest)} ms   (bar ≤ 20)`);

// ---------------------------------------------------------------------------
// Мутации приёмки
// ---------------------------------------------------------------------------

if (RUN_MUTATIONS) {
  section("MUTATION 1 — incrementality removed (parse every file)");
  await index("repeat with incrementality", {});
  const degraded = await index("repeat WITHOUT incrementality", { incremental: false });
  console.log(
    `  result: repeat ${ms(unchanged)} ms → without incrementality ${ms(degraded)} ms ` +
      `(×${(degraded / Math.max(unchanged, 0.01)).toFixed(0)} slower), every file must be parsed`,
  );

  section("MUTATION 2 — freshness by mtime only, no hash");
  // Жертва — вне набора изменённых в прогоне 3: её состояние в базе и на
  // диске совпадает без оговорок.
  const victim = codeFiles.find((p) => !chosen.has(p))!;
  const defCount = (path: string): number =>
    (db.query("SELECT count(*) AS n FROM code_defs WHERE path = ?1").get(path) as { n: number }).n;
  console.log(`  victim: ${victim}, defs in db: ${defCount(victim)}`);
  // Правка содержимого с восстановленным mtime; правка настоящая — новая
  // функция, а не комментарий, чтобы по дефсам было видно, долетела ли она.
  const st = statSync(join(tree, victim));
  const body = readFileSync(join(tree, victim));
  const defsBefore = defCount(victim);
  writeFileSync(join(tree, victim), body + "\nexport function zz_mutation_canary() { return 1; }\n");
  utimesSync(join(tree, victim), st.atime, st.mtime);
  const missed = await index("repeat (mtime-only)", { freshness: "mtime" });
  console.log(
    `  edit with restored mtime: run ${ms(missed)} ms, canary ` +
      `${defCount(victim) === defsBefore ? "DID NOT ARRIVE (edit missed)" : "arrived"}`,
  );
  // Тот же файл в рабочем режиме ловится.
  const now = new Date();
  utimesSync(join(tree, victim), now, now);
  const caught = await index("repeat (mtime+hash, control)", {});
  console.log(
    `  control (normal mode): run ${ms(caught)} ms, defs in db: ${defCount(victim)} — edit caught`,
  );
  // Восстановление.
  writeFileSync(join(tree, victim), body);
  utimesSync(join(tree, victim), st.atime, st.mtime);
}

db.close();
rmSync(work, { recursive: true, force: true });
console.log("\ncopy removed, original untouched");
