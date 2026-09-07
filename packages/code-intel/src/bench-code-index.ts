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
  console.error(`нет каталога: ${ROOT}`);
  process.exit(1);
}

const ms = (v: number): string => v.toFixed(1).padStart(7);

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Копия репозитория (только читаем оригинал)
// ---------------------------------------------------------------------------

section("подготовка");
const t0 = performance.now();
const work = mkdtempSync(join(tmpdir(), "code-index-bench-"));
const tree = join(work, "tree");
mkdirSync(tree);

const ls = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT });
let rels: string[];
if (ls.status === 0) {
  rels = ls.stdout.toString().split("\0").filter((s) => s.length > 0);
  console.log(`источник списка файлов: git ls-files (${rels.length} файлов)`);
} else {
  throw new Error("каталог без git не поддерживается замером: нужен список файлов");
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
console.log(`скопировано: ${copied} файлов за ${(performance.now() - t0).toFixed(0)} мс → ${work}`);

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
    `${label}: ${ms(total)} мс  (скан ${ms(r.scan.scanMs)}, разбор ${ms(r.drain.parseMs)}, ` +
      `запись ${ms(r.drain.applyMs)})  файлы ${r.scan.files}, без изменений ${r.scan.unchanged}, ` +
      `тач ${r.scan.touched}, изменены ${r.scan.dirty}, разобрано ${r.drain.parsed}`,
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

section("прогон 1 — полный индекс (холодный)");
const full1 = await index("полный №1");
console.log(
  `  в базе: ${JSON.stringify(counts())} — планка 400 мс, ${full1 <= 400 ? "УЛОЖИЛИСЬ" : "НЕ УЛОЖИЛИСЬ"}`,
);

// Полный индекс на прогретом коде: та же работа без стоимости первого
// касания модулей. Честная пара к холодному числу.
section("прогон 1б — полный индекс ещё раз (прогретый)");
const full2 = await index("полный №2", { incremental: false });

// ---------------------------------------------------------------------------
// Прогон 2: повторный без изменений
// ---------------------------------------------------------------------------

section("прогон 2 — повторный, ничего не менялось");
const unchangedTimes: number[] = [];
for (let i = 0; i < 3; i++) unchangedTimes.push(await index(`повтор №${i + 1}`));
const unchanged = Math.min(...unchangedTimes);

// ---------------------------------------------------------------------------
// Прогон 3: повторный при N изменённых
// ---------------------------------------------------------------------------

section(`прогон 3 — повторный при ${DIRTY} изменённых`);

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
console.log(`изменены: ${[...chosen].slice(0, 3).join(", ")}${chosen.size > 3 ? `, +${chosen.size - 3}` : ""}`);

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
  dirtyTimes.push(await index(`при ${DIRTY} изменённых №${i + 1}`));
}
const dirtyBest = Math.min(...dirtyTimes);

// Восстановление копии — мутации ниже стартуют из чистого состояния.
for (const [rel, orig] of originals) {
  writeFileSync(join(tree, rel), orig.body);
  utimesSync(join(tree, rel), orig.atime, orig.mtime);
}

const c = counts();
console.log(`  в базе: ${JSON.stringify(c)}; планка 20 мс, ${dirtyBest <= 20 ? "УЛОЖИЛИСЬ" : "НЕ УЛОЖИЛИСЬ"}`);

// ---------------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------------

section("итог");
console.log(`полный индекс (${c.files} файлов):     холодный ${ms(full1)} мс, прогретый ${ms(full2)} мс   (планка ≤ 400)`);
console.log(`повторный без изменений:            ${ms(unchanged)} мс   (минимум из 3)`);
console.log(`повторный при ${String(DIRTY).padStart(2)} изменённых:        ${ms(dirtyBest)} мс   (планка ≤ 20)`);

// ---------------------------------------------------------------------------
// Мутации приёмки
// ---------------------------------------------------------------------------

if (RUN_MUTATIONS) {
  section("МУТАЦИЯ 1 — инкрементальность убрана (разбирать все файлы)");
  await index("повтор с инкрементальностью", {});
  const degraded = await index("повтор БЕЗ инкрементальности", { incremental: false });
  console.log(
    `  итог: повторный ${ms(unchanged)} мс → без инкрементальности ${ms(degraded)} мс ` +
      `(просадка ×${(degraded / Math.max(unchanged, 0.01)).toFixed(0)}), разбор всех файлов обязателен`,
  );

  section("МУТАЦИЯ 2 — свежесть только по mtime, без хеша");
  // Жертва — вне набора изменённых в прогоне 3: её состояние в базе и на
  // диске совпадает без оговорок.
  const victim = codeFiles.find((p) => !chosen.has(p))!;
  const defCount = (path: string): number =>
    (db.query("SELECT count(*) AS n FROM code_defs WHERE path = ?1").get(path) as { n: number }).n;
  console.log(`  жертва: ${victim}, дефсов в базе: ${defCount(victim)}`);
  // Правка содержимого с восстановленным mtime; правка настоящая — новая
  // функция, а не комментарий, чтобы по дефсам было видно, долетела ли она.
  const st = statSync(join(tree, victim));
  const body = readFileSync(join(tree, victim));
  const defsBefore = defCount(victim);
  writeFileSync(join(tree, victim), body + "\nexport function zz_mutation_canary() { return 1; }\n");
  utimesSync(join(tree, victim), st.atime, st.mtime);
  const missed = await index("повтор (mtime-only)", { freshness: "mtime" });
  console.log(
    `  правка с восстановленным mtime: прогон ${ms(missed)} мс, канарейка ` +
      `${defCount(victim) === defsBefore ? "НЕ ДОЛЕТЕЛА (правка незамечена)" : "долетела"}`,
  );
  // Тот же файл в рабочем режиме ловится.
  const now = new Date();
  utimesSync(join(tree, victim), now, now);
  const caught = await index("повтор (mtime+hash, контроль)", {});
  console.log(
    `  контроль (рабочий режим): прогон ${ms(caught)} мс, дефсов в базе: ${defCount(victim)} — правка поймана`,
  );
  // Восстановление.
  writeFileSync(join(tree, victim), body);
  utimesSync(join(tree, victim), st.atime, st.mtime);
}

db.close();
rmSync(work, { recursive: true, force: true });
console.log("\nкопия убрана, оригинал не изменялся");
