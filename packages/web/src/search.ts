/**
 * Экран «поиск» (W6, memory-c7075t2s0nj6): гибридный поиск с бюджетом и
 * уверенностью — прямо в интерфейсе.
 *
 * ЗДЕСЬ НЕТ НИ ОДНОЙ СТРОКИ ПОИСКА. Запрос уходит в тот же движок команд,
 * что обслуживает терминал (`run()` из @myc/cli, `runCli` из mutate.ts) —
 * буквально `myc recall <query> --json`. Причина не в экономии кода: BM25 +
 * вектор + расширение по графу, слияние RRF, z-оценка уверенности (S47),
 * бюджет символов (§2.7) и федерация по воркспейсам (R3) — вся эта логика
 * живёт в packages/cli/src/commands/retrieve.ts ровно один раз, и пересчитать
 * её здесь заново значило бы завести вторую реализацию поиска рядом с первой
 * — ту самую ошибку, из-за которой mutate.ts запрещает второй путь записи
 * (S38/S40). Для чтения довод тот же.
 *
 * ЧЕСТНОСТЬ, А НЕ ПОЛНОТА (И2). `RecallData` из конверта команды несёт z-score
 * уверенности каждой строки (`confidence`), пометку обрезки по бюджету
 * (`partial`/`cursor`/`omitted`) и предупреждения деградации — они приходят
 * ДВУМЯ путями конверта: `env.warn[]` (код + человеческий текст) и
 * `env.meta.degraded[]` (те же коды, для машин). `runWrite` (mutate.ts)
 * переносит оба поля в `WriteOutcome` без изменений — сервер и клиент обязаны
 * показать их, а не потерять при передаче.
 */

import { runWrite, type RunCli, type WriteOutcome } from "./mutate.ts";

export interface SearchOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly budget?: number;
  readonly kind?: string;
  readonly tag?: string;
  readonly layer?: string;
  readonly since?: string;
  readonly anchor?: string;
  readonly mode?: string;
  readonly why?: boolean;
  readonly reach?: string;
  readonly repo?: string;
  readonly session?: string;
  readonly embedTimeoutMs?: number;
  readonly sources?: number;
}

/**
 * argv строится ИМЕНАМИ ФЛАГОВ RECALL_FLAGS (packages/cli/src/commands/recall.ts)
 * — те же строки, что читает `myc recall`, а не их копия. Расхождение
 * названия здесь с названием там означало бы, что часть параметров интерфейса
 * молча не долетает до движка.
 */
export function searchArgv(query: string, opts: SearchOptions = {}): string[] {
  const argv = ["recall", query];
  if (opts.limit !== undefined) argv.push("-n", String(opts.limit));
  if (opts.offset !== undefined) argv.push("--offset", String(opts.offset));
  if (opts.budget !== undefined) argv.push("--budget", String(opts.budget));
  if (opts.kind !== undefined && opts.kind.length > 0) argv.push("--kind", opts.kind);
  if (opts.tag !== undefined && opts.tag.length > 0) argv.push("--tag", opts.tag);
  if (opts.layer !== undefined && opts.layer.length > 0) argv.push("--layer", opts.layer);
  if (opts.since !== undefined && opts.since.length > 0) argv.push("--since", opts.since);
  if (opts.anchor !== undefined && opts.anchor.length > 0) argv.push("--anchor", opts.anchor);
  if (opts.mode !== undefined && opts.mode.length > 0) argv.push("--mode", opts.mode);
  if (opts.why === true) argv.push("--why");
  if (opts.reach !== undefined && opts.reach.length > 0) argv.push("--reach", opts.reach);
  if (opts.repo !== undefined && opts.repo.length > 0) argv.push("--repo", opts.repo);
  if (opts.session !== undefined && opts.session.length > 0) argv.push("--session", opts.session);
  if (opts.embedTimeoutMs !== undefined) argv.push("--embed-timeout", String(opts.embedTimeoutMs));
  if (opts.sources !== undefined) argv.push("--sources", String(opts.sources));
  return argv;
}

/** `myc recall <query> --json` — та же команда, тот же конверт, ноль пересчёта. */
export async function loadSearch(
  runCli: RunCli,
  query: string,
  opts: SearchOptions = {},
): Promise<WriteOutcome> {
  return runWrite(runCli, searchArgv(query, opts));
}
