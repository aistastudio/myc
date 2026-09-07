#!/usr/bin/env bun
/**
 * Калибровка порога годности условий (JITTER_MAX в @myc/bench (packages/bench/src/index.ts)).
 *
 * Мерит ровно то, что мерит эталон внутри `measure`: чисто процессорную
 * работу заданной длительности, много раз, и печатает дрожание p99/p50 —
 * во сколько раз машина растягивает заведомо ровную работу. Полезной
 * операции здесь нет вовсе: всё, что видно в числах, принадлежит машине.
 *
 * Запускать в трёх состояниях и сравнивать:
 *   bun run scripts/bench-jitter.ts                       # машина в покое
 *   bun test & bun run scripts/bench-jitter.ts            # рядом общий прогон
 *   for i in $(seq 16); do yes >/dev/null & done; bun run scripts/bench-jitter.ts
 */

import { cpus, loadavg } from "node:os";
import { summarize, unitCostNs } from "@myc/bench";

let sink = 0;
function spin(units: number): void {
  let x = sink | 1;
  for (let i = 0; i < units; i++) x = (x * 1103515245 + 12345) % 2147483648;
  sink = x;
}

const DURATIONS_MS = [0.05, 0.3, 1, 5, 20];
const ITERS = 200;

const ns = unitCostNs();
console.log(
  `машина: ${cpus().length} ядер, load ${loadavg().map((n) => n.toFixed(2)).join(" ")}, ` +
    `шаг эталона ${ns.toFixed(2)} нс`,
);
console.log("длительность | p50      | p95      | p99      | дрожание p99/p50");
console.log("-------------|----------|----------|----------|-----------------");
for (const target of DURATIONS_MS) {
  const units = Math.max(64, Math.round((target * 1e6) / ns));
  spin(units);
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    spin(units);
    samples.push(performance.now() - t0);
  }
  const s = summarize(samples);
  console.log(
    `${`${target} мс`.padEnd(12)} | ${s.p50.toFixed(3).padStart(8)} | ${s.p95.toFixed(3).padStart(8)} | ` +
      `${s.p99.toFixed(3).padStart(8)} | ×${(s.p99 / s.p50).toFixed(2)}`,
  );
}
