#!/usr/bin/env bun
/**
 * НОЧНОЙ ПРОГОН. Один вход для всего, что меряется на НЕЗАГРУЖЕННОЙ машине и
 * потому не может проверяться в общем прогоне тестов:
 *
 *   1. бюджетные тесты — каждый в своём процессе, по одному за раз; на
 *      откалиброванной и свободной машине — в строгом режиме
 *      (MYC_BENCH_STRICT=1, абсолютные бюджеты обязательны), иначе
 *      обязательны структурные и относительные утверждения (см. «РЕЖИМ»);
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
 * РЕЖИМ — ПЕРЕСЕЧЕНИЕ ДВУХ НЕЗАВИСИМЫХ ВОПРОСОВ, а не одна шкала:
 *   · СВОБОДНА ли машина — меряется (дрожание эталона, `readiness()` ниже);
 *   · ОТКАЛИБРОВАНА ли она под бюджеты И1 — объявляется: `MYC_BENCH_ABSOLUTE=0`
 *     говорит «нет» (@myc/bench, `absoluteEnabled()`).
 * Строгий режим — только при двух «да». Ночи 2026-09-08…11 показали, почему
 * одного первого мало: общий раннер GitHub (4 ядра x86) свободен — дрожание
 * ×1.29–1.54 при пороге 2.5, — прогон честно включал строгий режим и четыре
 * ночи подряд краснел на абсолютах, снятых на 14 ядрах arm64 (R3 федерация
 * p50 17.4–22.0 мс при бюджете p99 18; S59 ready p99 3.2 при 3; S44 гибрид
 * p95 25.7–26.3 при 25), хотя относительные утверждения тех же замеров
 * держались (×1.93–1.97, ×4.17–4.28, ×6.35–6.61). Мерилось железо, не код.
 *
 * ЗАПУСК:
 *   bun run scripts/bench-nightly.ts            # проверит условия и откажется
 *                                               # на занятой машине
 *   bun run scripts/bench-nightly.ts --force    # прогнать всё равно
 *   bun run scripts/bench-nightly.ts --check    # только проверка условий
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { absoluteEnabled, JITTER_MAX, machine, probeJitter } from "@myc/bench";

const ROOT = join(import.meta.dir, "..");
const FORCE = process.argv.includes("--force");
const CHECK_ONLY = process.argv.includes("--check");

// --------------------------------------------------------------------------
// 1. Годна ли машина
// --------------------------------------------------------------------------

/**
 * Та же проба, что внутри `measure`, но до всякой полезной работы: если
 * машина занята УЖЕ СЕЙЧАС, прогон бессмыслен — он измерит соседа. Проба
 * идёт на трёх длительностях, потому что дрожание зависит от того, работу
 * какого размера машина обязана не прерывать. Живёт в @myc/bench
 * (`probeJitter`): ею же абсолют без `measure` проверяет годность условий.
 */
const readiness = probeJitter;

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
 * Строгий режим (абсолютные бюджеты обязательны) — пересечение ИЗМЕРЕНИЯ и
 * ОБЪЯВЛЕНИЯ (см. «РЕЖИМ» в шапке): машина прошла проверку готовности И не
 * объявлена неоткалиброванной. Свободная машина — ещё не та машина, под
 * которую сняты бюджеты: проверка готовности меряет занятость, а не железо,
 * и на общем раннере GitHub она проходит (дрожание ×1.3–1.5).
 *
 * Вне строгого режима прогон всё равно снимает все числа (журнал
 * MYC_BENCH_LOG хранит p50/p99, бюджет и вердикт каждого замера) и роняет
 * ночь на структурных и относительных утверждениях, на регрессии
 * bench:latency к секции baseline ЭТОЙ машины и на сверках eval.
 * Абсолюты станут обязательными на откалиброванном выделенном раннере из
 * docs/design/02-retrieval-and-performance.md: там workflow просто не ставит
 * MYC_BENCH_ABSOLUTE=0, и строгий режим включится сам, когда машина свободна.
 */
const calibrated = absoluteEnabled();
const strict = quiet && calibrated;
const mode = strict ? "строгий" : !calibrated ? "без абсолютов" : "условный";
console.log(
  strict
    ? "режим: СТРОГИЙ — абсолютные бюджеты обязательны"
    : !calibrated
      ? "режим: без абсолютов — MYC_BENCH_ABSOLUTE=0: машина не откалибрована под бюджеты И1, " +
          "абсолютные числа печатаются и пишутся в журнал, но не роняют ночь; структурные и " +
          "относительные утверждения, регрессия к своей секции baseline и сверки eval обязательны"
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
    `режим ${mode}`,
);
console.log(`замеры: ${logPath}`);
if (failed.length > 0) {
  console.log(`ПРОВАЛЕНО ${failed.length} из ${steps.length}:`);
  for (const f of failed) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`всё ${steps.length} шагов зелёные.`);
