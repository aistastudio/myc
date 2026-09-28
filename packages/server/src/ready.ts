/**
 * ОЧЕРЕДЬ READY НА СЕРВЕРЕ (§8.1).
 *
 * Считается ТЕМ ЖЕ реестром и ТЕМИ ЖЕ весами, что у CLI
 * (`packages/core/src/ready-queries.ts`): «что брать следующим» обязано быть
 * одним ответом, кто бы ни спросил — человек в терминале или агент по HTTP.
 * Второй формулы здесь нет и быть не может: этот файл не знает ни одного
 * слагаемого, он только выбирает запрос и подставляет веса.
 *
 * ВЫБОР ЗАПРОСА — ЧАСТЬ ФОРМУЛЫ, А НЕ ОПТИМИЗАЦИЯ. Якорное слагаемое стоит
 * подзапроса на каждого кандидата, и когда в базе нет ни одного ребра
 * `touches`, оно заведомо равно 0.5 у всех: тогда берётся вариант без него.
 * Ровно так же выбирает CLI.
 */

import {
  DEFAULT_READY_WEIGHTS,
  readyQueries,
  type ReadyWeights,
} from "@myc/core";
import type { PostgresDriver } from "@myc/store-postgres";

/** Сколько строк отдаём по умолчанию и максимум — потолок как у списка узлов. */
export const READY_LIMIT_DEFAULT = 10;
export const READY_LIMIT_MAX = 100;

export interface ReadyRow {
  readonly id: string;
  readonly priority: number;
  readonly status: string;
  readonly assignee: string;
  readonly title: string;
  readonly updated_at: number;
  readonly created_at: number;
  readonly score: number;
  readonly unblocks: number;
}

export interface ReadyAnswer {
  readonly items: readonly ReadyRow[];
  /** Сколько всего готовых задач в воркспейсе — не длина выдачи (И2). */
  readonly total: number;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

/**
 * Очередь воркспейса. `repo` пустой — фильтра нет: сузить выдачу по
 * неизвестному охвату значило бы молча спрятать работу.
 */
export async function readyQueue(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  limit: number,
  repo = "",
  weights: ReadyWeights = DEFAULT_READY_WEIGHTS,
  now: number = Date.now(),
): Promise<ReadyAnswer> {
  return pg.withTenant(tenant, async (tx) => {
    const hasTouches = (await tx.one(readyQueries.ready_touches_exist, [])) !== undefined;
    const withRepo = repo.length > 0;
    const query = withRepo
      ? hasTouches
        ? readyQueries.ready_top_anchors_repo
        : readyQueries.ready_top_noanchors_repo
      : hasTouches
        ? readyQueries.ready_top_anchors
        : readyQueries.ready_top_noanchors;
    const args: unknown[] = [
      ws,
      weights.priority,
      weights.unblocks,
      weights.freshness,
      weights.anchors,
      weights.type,
      limit,
      now,
    ];
    const rows = await tx.all<Record<string, unknown>>(query, withRepo ? [...args, repo] : args);
    const items: ReadyRow[] = [];
    for (const row of rows) {
      const id = String(row["id"]);
      const unblocks = await tx.one<{ n: number | string }>(readyQueries.ready_unblocks_one, [id]);
      items.push({
        id,
        priority: num(row["priority"]),
        status: String(row["status"] ?? ""),
        assignee: String(row["assignee"] ?? ""),
        title: String(row["title"] ?? ""),
        updated_at: num(row["updated_at"]),
        created_at: num(row["created_at"]),
        score: num(row["score"]),
        unblocks: num(unblocks?.n),
      });
    }
    // `total_ready` считает оконная функция того же запроса: сколько готовых
    // ВСЕГО, а не сколько поместилось в выдачу. Пустая выдача — ноль.
    const total = rows.length > 0 ? num(rows[0]!["total_ready"]) : 0;
    return { items, total };
  });
}
