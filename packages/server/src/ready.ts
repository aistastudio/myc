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
  digestScan,
  primeQueries,
  aclParams,
  readyQueries,
  readyQueriesAcl,
  runAsync,
  type DigestPayload,
  type ReadyWeights,
  type Viewer,
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
  /**
   * Подтип задачи из `attrs.type` (task/bug/epic) и оценка — их печатает
   * каждая строка выдачи, и без них клиент вынужден был придумывать колонку.
   * Запрос очереди `attrs` уже выбирает — цена ответа не растёт.
   */
  readonly type: string;
  readonly estimate_min?: number;
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
  viewer: Viewer,
  repo = "",
  weights: ReadyWeights = DEFAULT_READY_WEIGHTS,
  now: number = Date.now(),
): Promise<ReadyAnswer> {
  return pg.withTenant(tenant, async (tx) => {
    const hasTouches = (await tx.one(readyQueries.ready_touches_exist, [])) !== undefined;
    const withRepo = repo.length > 0;
    // ВАРИАНТ С ACL — ЕДИНСТВЕННЫЙ, которым сервер вправе считать очередь:
    // чужая приватная задача не должна ни занимать место в top-k, ни
    // попадать в число готовых.
    const query = withRepo
      ? hasTouches
        ? readyQueriesAcl.ready_top_anchors_repo_acl
        : readyQueriesAcl.ready_top_noanchors_repo_acl
      : hasTouches
        ? readyQueriesAcl.ready_top_anchors_acl
        : readyQueriesAcl.ready_top_noanchors_acl;
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
    const acl = aclParams(viewer);
    const rows = await tx.all<Record<string, unknown>>(
      query,
      withRepo ? [...args, repo, ...acl] : [...args, ...acl],
    );
    const items: ReadyRow[] = [];
    for (const row of rows) {
      const id = String(row["id"]);
      const unblocks = await tx.one<{ n: number | string }>(readyQueries.ready_unblocks_one, [id]);
      // attrs драйвер отдаёт текстом (паритет с SQLite); битый JSON не должен
      // валить очередь — подтип уходит в умолчание.
      let attrs: Record<string, unknown> = {};
      try {
        const raw = row["attrs"];
        attrs = typeof raw === "string" && raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        attrs = {};
      }
      const type = typeof attrs["type"] === "string" ? (attrs["type"] as string) : "task";
      const est = typeof attrs["estimate_min"] === "number" ? (attrs["estimate_min"] as number) : undefined;
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
        type,
        ...(est !== undefined ? { estimate_min: est } : {}),
      });
    }
    // `total_ready` считает оконная функция того же запроса: сколько готовых
    // ВСЕГО, а не сколько поместилось в выдачу. Пустая выдача — ноль.
    const total = rows.length > 0 ? num(rows[0]!["total_ready"]) : 0;
    return { items, total };
  });
}

/**
 * ДАЙДЖЕСТ ПАМЯТИ (§8.1, `prime`). Считается тем же сканом, что у CLI
 * (`digestScan` в ядре), и здесь нет ни одного правила отбора — только
 * запуск и счётчики рядом.
 *
 * СБОРКУ СЕКЦИЙ СЕРВЕР НЕ ДЕЛАЕТ. Бюджет, порядок и человеческий вид — дело
 * поверхности: у CLI своя ширина терминала, у другого клиента будет своя.
 * Сервер отдаёт данные, из которых контекст собирается.
 */
export interface PrimeAnswer {
  readonly digest: DigestPayload;
  readonly in_progress: readonly InProgressRow[];
  readonly ready: readonly ReadyRow[];
  readonly total_ready: number;
  readonly nodes: number;
}

/**
 * Строка «в работе» для prime: ровно то, что печатает эта секция CLI —
 * держатель и срок аренды. Раньше сюда подставлялась ReadyRow, и срок
 * прятался в `updated_at`, а держатель выбрасывался вовсе: карточка
 * печатала «unassigned» для чужой работы и теряла срок.
 */
export interface InProgressRow {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly assignee: string;
  readonly lease_holder: string;
  readonly lease_expires: number;
}

export async function primeDigest(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  session: string,
  repo: string,
  readyLimit: number,
  viewer: Viewer,
): Promise<PrimeAnswer> {
  const queue = await readyQueue(pg, tenant, ws, readyLimit, viewer, repo);
  return pg.withTenant(tenant, async (tx) => {
    const digest = await runAsync(digestScan(ws, "project", undefined, session, repo, viewer), tx);
    const nodes = await tx.one<{ n: number | string }>(primeQueries.prime_node_count, [ws]);
    const running = await tx.all<Record<string, unknown>>(primeQueries.prime_inprogress, [ws, 10]);
    return {
      digest,
      in_progress: running.map((r) => ({
        id: String(r["id"]),
        title: String(r["title"] ?? ""),
        priority: num(r["priority"]),
        assignee: String(r["assignee"] ?? ""),
        lease_holder: String(r["lease_holder"] ?? ""),
        lease_expires: num(r["lease_expires"]),
      })),
      ready: queue.items,
      total_ready: queue.total,
      nodes: num(nodes?.n),
    };
  });
}
