#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";

/**
 * ЕДИНСТВЕННОЕ место, где записан рецепт сборки бинаря. Импортируется теми,
 * кто его меряет (scripts/bench-latency.ts, scripts/coldstart.ts), — чтобы
 * измеряемый артефакт был заведомо тем же, что поставляемый.
 *
 * Почему это отдельная функция, а не просто скрипт: `dist/myc`, собранный
 * ВРУЧНУЮ без `--bytecode`, стартует на ~12 мс медленнее (35.7 против 24.1 мс
 * p50, чередующийся A/B на 45 раундов) — половина холодного старта. Бенчмарк
 * мерил такой бинарь трое суток, и сдвиг базовой линии 19 → 35 мс списывали
 * то на reindex, то на команду move, то на шум хоста. Артефакт, о котором
 * никто не может сказать, каким рецептом он собран, мерить нельзя.
 */
export const BUILD_ARGS: readonly string[] = [
  "bun",
  "build",
  "--compile",
  "--minify",
  // --bytecode: JS компилируется в байт-код на сборке, а не при каждом старте.
  // Без него каждый запуск платит за разбор всего бандла — те самые ~12 мс.
  "--bytecode",
  "packages/cli/src/main.ts",
  "--outfile",
  "dist/myc",
];

export async function buildBinary(opts: { quiet?: boolean } = {}): Promise<void> {
  await mkdir("dist", { recursive: true });
  const io = opts.quiet === true ? "ignore" : "inherit";
  const proc = Bun.spawn([...BUILD_ARGS], { stdout: io, stderr: io });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`сборка dist/myc провалилась (код ${exitCode})`);
  }
}

if (import.meta.main) {
  await buildBinary();
  console.log("built dist/myc");
}
