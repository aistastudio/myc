#!/usr/bin/env bun
/**
 * Сравнение холодного старта нескольких бинарей ЧЕРЕДОВАНИЕМ.
 *
 * Зачем не «прогнать A, потом B»: на этой машине фон (браузеры, симулятор,
 * VM) даёт дрейф в десятки процентов за минуты, и последовательные прогоны
 * сравнивают не бинари, а моменты времени. Задача memory-21w8b5x63acn уже
 * дважды ловила на этом: «виноват reindex» и «виноват move» оба
 * опровергнуты именно так. Чередование round-robin (A,B,C,A,B,C,…) кладёт
 * соседние замеры разных бинарей в одно и то же окно фона, поэтому дрейф
 * попадает во все ряды одинаково и в разнице сокращается.
 *
 * Кроме сводных перцентилей печатается ПАРНАЯ разница: для каждого раунда
 * берётся (B_i - A_i), и по этому ряду считается медиана. Парная медиана
 * устойчива к выбросам, которые ломают p95 на 25 замерах.
 *
 * Использование:
 *   bun run bench/coldstart-ab.ts --runs 60 base=dist/myc lazy=dist-ab/myc-lazy
 */

import { cpus, loadavg } from "node:os";

interface Series {
  readonly label: string;
  readonly binary: string;
  readonly samples: number[];
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function stats(samples: readonly number[]): { p50: number; p95: number; p99: number; min: number; max: number; mean: number } {
  const s = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    min: s[0]!,
    max: s[s.length - 1]!,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

async function spawnOnce(binary: string, args: readonly string[]): Promise<number> {
  const t0 = performance.now();
  const proc = Bun.spawn([binary, ...args], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return performance.now() - t0;
}

function loadAvg(): string {
  return loadavg()
    .map((n) => n.toFixed(2))
    .join(" ");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let runs = 40;
  let cmdArgs = ["--version"];
  const series: Series[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--runs") { runs = Number(argv[++i]); continue; }
    if (a === "--args") { cmdArgs = argv[++i]!.split(" ").filter(Boolean); continue; }
    const eq = a.indexOf("=");
    if (eq <= 0) { console.error(`не понял аргумент: ${a}`); process.exit(2); }
    series.push({ label: a.slice(0, eq), binary: a.slice(eq + 1), samples: [] });
  }
  if (series.length === 0) { console.error("нужен хотя бы один label=path"); process.exit(2); }

  for (const s of series) {
    if (!(await Bun.file(s.binary).exists())) {
      console.error(`нет бинаря: ${s.binary}`);
      process.exit(1);
    }
  }

  console.log(`команда: myc ${cmdArgs.join(" ")} · раундов ${runs} · рядов ${series.length}`);
  console.log(`машина: ${cpus().length} ядер · load до: ${loadAvg()}`);

  // Прогрев: страницы бинаря в page cache, иначе первый замер каждого ряда
  // меряет чтение с диска, а не старт.
  for (let w = 0; w < 4; w++) for (const s of series) await spawnOnce(s.binary, cmdArgs);

  for (let r = 0; r < runs; r++) {
    // Порядок внутри раунда вращается: иначе первый ряд систематически платит
    // за «разогрев» планировщика в начале раунда, а последний — нет.
    for (let k = 0; k < series.length; k++) {
      const s = series[(r + k) % series.length]!;
      s.samples.push(await spawnOnce(s.binary, cmdArgs));
    }
  }

  console.log(`load после: ${loadAvg()}\n`);

  const f = (n: number): string => n.toFixed(2).padStart(6);
  console.log("ряд                p50     p95     p99     min     max    mean   n");
  for (const s of series) {
    const st = stats(s.samples);
    console.log(
      `${s.label.padEnd(16)}${f(st.p50)}  ${f(st.p95)}  ${f(st.p99)}  ${f(st.min)}  ${f(st.max)}  ${f(st.mean)}  ${s.samples.length}`,
    );
  }

  if (series.length > 1) {
    const base = series[0]!;
    console.log(`\nпарная разница относительно «${base.label}» (медиана поraundовых разностей, минус = быстрее):`);
    for (const s of series.slice(1)) {
      const diffs = s.samples.map((v, i) => v - base.samples[i]!).sort((a, b) => a - b);
      const med = percentile(diffs, 50);
      const lo = percentile(diffs, 25);
      const hi = percentile(diffs, 75);
      const pct = (med / stats(base.samples).p50) * 100;
      console.log(
        `  ${s.label.padEnd(16)} медиана ${med >= 0 ? "+" : ""}${med.toFixed(2)} мс (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%), межквартиль [${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
      );
    }
  }
}

await main();
