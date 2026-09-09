#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import {
  PARSE_WORKER_ENTRY_NAMING,
  PARSE_WORKER_SOURCE,
} from "../packages/code-intel/src/parse_worker_entry.ts";

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
  // ВТОРОЙ ВХОД — воркер пула разбора. Без него в бинаре воркера НЕТ: `bun
  // build` конструкцию `new Worker(new URL(...))` не видит и ничего по ней не
  // вшивает, а сохранённый в бандле `import.meta.url` ведёт на .ts сборочной
  // машины. Отдельным входом воркер попадает в bunfs самодостаточным бандлом,
  // с web-tree-sitter внутри. Путь берётся из `parse_worker_entry.ts` — оттуда
  // же рантайм берёт имя, под которым его искать.
  PARSE_WORKER_SOURCE,
  // Имя воркера в bunfs — не то, что вычислит бандлер по общему предку входов,
  // а то, что рантайм пойдёт искать. Без этой строки имя зависит от места
  // ДРУГОГО входа, и любой переезд гасит пул молча.
  "--entry-naming",
  PARSE_WORKER_ENTRY_NAMING,
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
