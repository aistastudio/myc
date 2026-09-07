#!/usr/bin/env bun
/**
 * НОЧНОЙ ПРОГОН. Один вход для всего, что меряется на НЕЗАГРУЖЕННОЙ машине и
 * потому не может проверяться в общем прогоне тестов:
 *
 *   1. бюджетные тесты — каждый в своём процессе, по одному за раз, со
 *      строгим режимом (MYC_BENCH_STRICT=1): абсолютные бюджеты обязательны;
 *   2. scripts/bench-latency.ts — пять операций горячего пути против
 *      bench/baseline.json, порог регрессии 15 %;
 *   3. bench/boost-eval.ts и bench/graph-eval.ts — recall/MRR на размеченных
 *      корпусах против записанных чисел (обе падают сами при расхождении).
 *
 * ПОЧЕМУ ОТДЕЛЬНО ОТ .github/workflows/ci.yml:
 *   · абсолютный бюджет требует незагруженной машины, а в ci.yml бюджетные
 *     тесты идут внутри `bun test` вместе с остальными двумя тысячами;
 *   · прогон стоит минуты (стенды по 100k узлов строятся заново в каждом
 *     файле) — платить это на каждом коммите в PR не за что;
 *   · семантика падения разная: красный PR блокирует слияние, красный ночной
 *     прогон заводит разбор и не мешает работать;
 *   · числа для README и для базовой линии берутся ИЗ ЭТОГО прогона, а не из
 *     головы, и потому должны сниматься в одинаковых условиях, а не в тех,
 *     какие достались коммиту.
 *
 * ЧТО ДЕЛАТЬ С РЕЗУЛЬТАТОМ. Каждый замер дописывает JSON-строку в файл из
 * MYC_BENCH_LOG (по умолчанию bench/nightly-<дата>.jsonl) вместе с условиями:
 * load1, число ядер, дрожание эталона, строгий ли режим. Файл — артефакт
 * прогона; расхождение с прошлой ночью читается по нему, а не по памяти.
 * Базовая линия НЕ обновляется автоматически: сдвиг линии — решение человека
 * (`bun run bench:latency:update-baseline --note="почему"`).
 *
 * ЗАПУСК:
 *   bun run scripts/bench-nightly.ts            # проверит условия и откажется
 *                                               # на занятой машине
 *   bun run scripts/bench-nightly.ts --force    # прогнать всё равно
 *   bun run scripts/bench-nightly.ts --check    # только проверка условий
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { JITTER_MAX, machine, summarize, unitCostNs } from "@myc/bench";

const ROOT = join(import.meta.dir, "..");
const FORCE = process.argv.includes("--force");
const CHECK_ONLY = process.argv.includes("--check");

// --------------------------------------------------------------------------
// 1. Годна ли машина
// --------------------------------------------------------------------------

let sink = 0;
function spin(units: number): void {
  let x = sink | 1;
  for (let i = 0; i < units; i++) x = (x * 1103515245 + 12345) % 2147483648;
  sink = x;
}

/**
 * Та же проба, что внутри `measure`, но до всякой полезной работы: если
 * машина занята УЖЕ СЕЙЧАС, прогон бессмыслен — он измерит соседа. Проба
 * идёт на трёх длительностях, потому что дрожание зависит от того, работу
 * какого размера машина обязана не прерывать.
 */
function readiness(): { jitter: number; detail: string } {
  const ns = unitCostNs();
  const rows: string[] = [];
  let worst = 0;
  for (const target of [0.3, 1, 5]) {
    const units = Math.max(64, Math.round((target * 1e6) / ns));
    spin(units);
    const samples: number[] = [];
    for (let i = 0; i < 120; i++) {
      const t0 = performance.now();
      spin(units);
      samples.push(performance.now() - t0);
    }
    const s = summarize(samples);
    const j = s.p99 / s.p50;
    if (j > worst) worst = j;
    rows.push(`${target} мс → ×${j.toFixed(2)}`);
  }
  return { jitter: worst, detail: rows.join(", ") };
}

// --------------------------------------------------------------------------
// 2. Что гонять
// --------------------------------------------------------------------------

/**
 * Бюджетные тесты НЕ перечислены списком: список забывают пополнять, и это
 * ровно та цена, из-за которой «вынести бюджеты в отдельную цель» —
 * недостаточное решение само по себе. Вместо списка — признак: файл теста,
 * который импортирует @myc/bench, и есть бюджетный тест.
 */
function budgetTests(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".test.ts")) {
        if (readFileSync(p, "utf8").includes("@myc/bench")) out.push(relative(ROOT, p));
      }
    }
  };
  walk(join(ROOT, "packages"));
  return out.sort();
}

interface Step {
  readonly name: string;
  readonly cmd: readonly string[];
}

async function run(step: Step, env: Record<string, string>): Promise<boolean> {
  const t0 = performance.now();
  console.log(`\n──── ${step.name}\n$ ${step.cmd.join(" ")}`);
  const proc = Bun.spawn(step.cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`──── ${step.name}: ${code === 0 ? "ok" : `КОД ${code}`} за ${secs} с`);
  return code === 0;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

const m = machine();
const ready = readiness();
console.log(
  `машина: ${m.cpus} ядер, load1 ${m.load1}, load5 ${m.load5}\n` +
    `готовность: дрожание эталона ${ready.detail} → худшее ×${ready.jitter.toFixed(2)} ` +
    `(порог ${JITTER_MAX})`,
);

const quiet = ready.jitter <= JITTER_MAX;
if (!quiet && !FORCE && !CHECK_ONLY) {
  console.error(
    `\nмашина занята: дрожание эталона ×${ready.jitter.toFixed(2)} выше порога ${JITTER_MAX}.\n` +
      "Ночной прогон на такой машине измерит соседа по процессору, а не код.\n" +
      "Освободите машину или запустите с --force, приняв, что абсолютные числа условны.",
  );
  process.exit(2);
}
if (CHECK_ONLY) {
  process.exit(quiet ? 0 : 2);
}

/**
 * Строгий режим (абсолютные бюджеты обязательны) включается ИЗМЕРЕНИЕМ, а не
 * флагом: он осмыслен ровно тогда, когда машина прошла проверку готовности.
 * На общем раннере GitHub (2 общих ядра) проверка обычно не проходит — и
 * тогда прогон всё равно снимает числа и ловит относительные регрессии, но
 * не роняет ночную сборку из-за абсолютов, которых он не смог измерить.
 * Обязательными они станут на выделенном раннере из
 * docs/design/02-retrieval-and-performance.md, когда такой появится.
 */
const strict = quiet;
console.log(
  strict
    ? "режим: СТРОГИЙ — абсолютные бюджеты обязательны"
    : "режим: условный — машина занята, абсолютные бюджеты только печатаются; " +
        "относительные утверждения и сверки с записанными числами обязательны как всегда",
);

const stamp = new Date().toISOString().slice(0, 10);
const logPath = process.env.MYC_BENCH_LOG ?? join(ROOT, "bench", `nightly-${stamp}.jsonl`);
const env = { MYC_BENCH_LOG: logPath, ...(strict ? { MYC_BENCH_STRICT: "1" } : {}) };

const tests = budgetTests();
console.log(`\nбюджетных тестов найдено: ${tests.length}\n  ${tests.join("\n  ")}`);

const steps: Step[] = [
  // По одному файлу за процесс: два стенда по 100k узлов в одном процессе
  // делят память и страничный кеш, и замер второго зависел бы от первого.
  ...tests.map((t) => ({ name: `бюджетный тест ${t}`, cmd: ["bun", "test", t] })),
  { name: "bench:latency (бюджеты И1 + регрессия к baseline)", cmd: ["bun", "run", "scripts/bench-latency.ts"] },
  { name: "boost-eval (MRR/recall бустов против записанных чисел)", cmd: ["bun", "run", "bench/boost-eval.ts"] },
  { name: "graph-eval (recall обхода графа против записанных чисел)", cmd: ["bun", "run", "bench/graph-eval.ts"] },
];

const failed: string[] = [];
for (const step of steps) {
  if (!(await run(step, env))) failed.push(step.name);
}

console.log(`\n════ итог ночного прогона ${stamp}`);
console.log(
  `условия: ${m.cpus} ядер, load1 ${m.load1}, дрожание ×${ready.jitter.toFixed(2)}, ` +
    `режим ${strict ? "строгий" : "условный"}`,
);
console.log(`замеры: ${logPath}`);
if (failed.length > 0) {
  console.log(`ПРОВАЛЕНО ${failed.length} из ${steps.length}:`);
  for (const f of failed) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`всё ${steps.length} шагов зелёные.`);
