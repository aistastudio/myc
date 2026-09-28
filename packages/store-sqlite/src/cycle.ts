/**
 * МОСТ К ПРОВЕРКЕ ЦИКЛОВ, КОТОРАЯ ЖИВЁТ В ЯДРЕ.
 *
 * Обход и его два предела — `packages/core/src/cycle.ts`: рёбра `blocks`
 * пишет и CLI, и сервер, а проверка, которую видит только один писатель, не
 * защищает ничего. Здесь остаётся синхронный прогон генератора и прежняя
 * сигнатура, чтобы вызывающие не переучивались.
 */

import { checkEdgeAcyclic as checkEff, cycleQueries, runSync, type DbDriver, type EdgeKind } from "@myc/core";

export { MAX_BLOCKS_DEPTH, MAX_BLOCKS_REACH, cycleQueries } from "@myc/core";

export function checkEdgeAcyclic(
  db: DbDriver,
  src: string,
  type: EdgeKind,
  dst: string,
  maxDepth?: number,
  maxReach?: number,
): void {
  runSync(checkEff(src, type, dst, maxDepth, maxReach), db);
}

/** @internal тестам плана нужен тот же текст запроса, что у обхода. */
export const queries = cycleQueries;
