#!/usr/bin/env bun
/**
 * Быстрый ручной замер холодного старта. Бинарь пересобирается рецептом
 * scripts/build.ts, а не берётся готовым: собранный вручную `dist/myc` без
 * `--bytecode` стартует на ~12 мс медленнее, и именно на таком артефакте
 * трое суток «уезжала» базовая линия cold_start (memory-21w8b5x63acn).
 */
import { buildBinary } from "./build.ts";

const BINARY = "./dist/myc";
const RUNS = 20;

async function run(): Promise<number> {
  const start = performance.now();
  const proc = Bun.spawn([BINARY, "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  return performance.now() - start;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)]!;
}

await buildBinary({ quiet: true });
const file = Bun.file(BINARY);
if (!(await file.exists())) {
  console.error(`${BINARY} не собрался`);
  process.exit(1);
}

const durations: number[] = [];
for (let i = 0; i < RUNS; i++) {
  durations.push(await run());
}

durations.sort((a, b) => a - b);

const p50 = percentile(durations, 50);
const p95 = percentile(durations, 95);
const p99 = percentile(durations, 99);

console.log(`runs: ${RUNS}`);
console.log(`p50: ${p50.toFixed(2)}ms`);
console.log(`p95: ${p95.toFixed(2)}ms`);
console.log(`p99: ${p99.toFixed(2)}ms`);
