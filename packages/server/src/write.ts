/**
 * ЗАПИСЬ ЧЕРЕЗ СЕРВЕР (§8.1, шаг 4 решения §8.1.1).
 *
 * Сервер не пишет строки — он МИНТИТ ОПЕРАЦИИ и отдаёт их тому же
 * применителю, которым живёт CLI (`@myc/core`, apply.ts), только прогоняет их
 * асинхронным исполнителем. Второй реализации правил слияния нет, и появиться
 * ей неоткуда: этот файл не знает ни про часы полей, ни про разбор двойников.
 *
 * САЙТ СЕРВЕРА — ЧАСТЬ АРЕНДАТОРА, А НЕ ПРОЦЕССА. `site_id` участвует в
 * разрешении ничьих (S38), поэтому он обязан быть устойчивым между
 * перезапусками и РАЗНЫМ у разных арендаторов: два сервера с одним site_id
 * молча теряли бы записи друг друга. Он лежит в `myc_meta` арендатора и
 * заводится один раз, при первой записи.
 *
 * Узел рождается ровно так же, как приехавший по репликации: пакетом
 * `set`-операций, из которых применитель сам материализует строку. Никакого
 * «быстрого пути» с прямым INSERT здесь нет — он и был бы той самой второй
 * реализацией.
 */

import {
  applyOps,
  assertNodeKind,
  generateId,
  HlcClock,
  OpFactory,
  Q,
  runAsync,
  syncTail,
  type ApplyCtx,
  type JsonValue,
  type Op,
} from "@myc/core";
import type { PostgresDriver } from "@myc/store-postgres";
import type { AsyncDbDriver } from "@myc/core";

/** Поля, которые принимает создание узла. Остальное — не через эту дверь. */
export interface NodeCreate {
  readonly kind: string;
  readonly title: string;
  readonly body?: string;
  readonly priority?: number;
  readonly status?: string;
  readonly layer?: number;
  readonly assignee?: string;
  readonly attrs?: Readonly<Record<string, JsonValue>>;
}

export interface WriteFailure {
  readonly code: string;
  readonly msg: string;
}

export type WriteResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: WriteFailure };

const MAX_TITLE = 500;
const PRIORITIES = new Set([0, 1, 2, 3]);

/**
 * Проверка ВХОДА, а не данных в базе: сюда приходит чужой JSON из сети.
 * Отказ здесь дешевле отката транзакции и понятнее вызывающему.
 */
export function validateCreate(input: unknown): WriteResult<NodeCreate> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: { code: "usage.body", msg: "the body must be a JSON object" } };
  }
  const o = input as Record<string, unknown>;
  const title = typeof o["title"] === "string" ? o["title"].trim() : "";
  if (title.length === 0) {
    return { ok: false, error: { code: "usage.title", msg: "title must not be empty" } };
  }
  if (title.length > MAX_TITLE) {
    return { ok: false, error: { code: "usage.title", msg: `title must be at most ${MAX_TITLE} characters` } };
  }
  const kind = typeof o["kind"] === "string" ? o["kind"] : "";
  try {
    assertNodeKind(kind);
  } catch {
    return { ok: false, error: { code: "usage.kind", msg: `unknown node kind '${kind}'` } };
  }
  const priority = o["priority"] === undefined ? 2 : Number(o["priority"]);
  if (!PRIORITIES.has(priority)) {
    return { ok: false, error: { code: "usage.priority", msg: "priority must be 0, 1, 2 or 3" } };
  }
  const body = typeof o["body"] === "string" ? o["body"] : undefined;
  const assignee = typeof o["assignee"] === "string" ? o["assignee"] : undefined;
  const status = typeof o["status"] === "string" ? o["status"] : undefined;
  const attrs =
    typeof o["attrs"] === "object" && o["attrs"] !== null
      ? (o["attrs"] as Record<string, JsonValue>)
      : undefined;
  return { ok: true, data: { kind, title, body, priority, assignee, status, attrs } };
}

/**
 * Сайт арендатора: читается из `myc_meta`, заводится при первой записи.
 * Значение выдаётся тем же генератором идентификаторов — оно случайно и
 * ни с чьим другим не совпадёт.
 */
export async function tenantSite(tx: AsyncDbDriver, ws: string): Promise<string> {
  const row = await tx.one<{ value: string }>(Q.meta_get, ["site_id"]);
  if (row?.value !== undefined && row.value !== "") return row.value;
  const site = `srv-${generateId(ws).split("-").pop() ?? "0"}`;
  await tx.run(Q.meta_set, ["site_id", site]);
  return site;
}

/** Операции рождения узла — тот же набор, что приезжает по репликации. */
export function birthOps(f: OpFactory, id: string, ws: string, input: NodeCreate): Op[] {
  const ops: Op[] = [
    f.set(id, "kind", input.kind),
    f.set(id, "scope", ws),
    f.set(id, "title", input.title),
    f.set(id, "priority", input.priority ?? 2),
  ];
  if (input.body !== undefined) ops.push(f.set(id, "body", input.body));
  if (input.status !== undefined) ops.push(f.set(id, "status", input.status));
  if (input.assignee !== undefined) ops.push(f.set(id, "assignee", input.assignee));
  for (const [key, value] of Object.entries(input.attrs ?? {})) {
    ops.push(f.set(id, `attrs.${key}`, value));
  }
  // Счётчик просмотров — как у локального создания: узел, только что
  // рождённый, уже виден один раз.
  ops.push(f.inc(id, "seen_count", 1));
  return ops;
}

export interface CreatedNode {
  readonly id: string;
  readonly applied: number;
  readonly collided: readonly string[];
}

/**
 * Создать узел в воркспейсе арендатора. Одна транзакция на всё: `SET LOCAL
 * myc.tenant`, минт операций и их применение.
 *
 * ОПЕРАЦИИ МИНТЯТСЯ ВНУТРИ (`applyLocalOps` зовёт `mint` сам, после того как
 * поднял seq и часы от хвоста оплога). Сминтить их снаружи — это myc-4dy:
 * второй запрос выдал бы те же op_id, и весь пакет журналировался бы как
 * повтор. Поймано ws.pg.test.ts: второй созданный через HTTP узел не
 * записался ВООБЩЕ, а ответ был 200.
 */
export async function createNode(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  input: NodeCreate,
  actor: string,
): Promise<CreatedNode> {
  return pg.withTenant(tenant, async (tx) => {
    const site = await tenantSite(tx, ws);
    const f = new OpFactory(site, { clock: new HlcClock() });
    const id = generateId(ws);
    const ctx: ApplyCtx = { actor, siteId: site, ops: f, now: () => Date.now() };
    // ПОРЯДОК ЗДЕСЬ — ЧАСТЬ ПРАВИЛЬНОСТИ. Сначала часы и seq поднимаются от
    // хвоста оплога (`syncTail`), и только потом минтятся операции: иначе
    // второй запрос выдал бы те же op_id, и весь пакет журналировался бы как
    // повтор — молча (myc-4dy, поймано ws.pg.test.ts). `applyOps` повторит
    // syncTail изнутри; это два дешёвых чтения, а не риск.
    //
    // Узел рождается ПУТЁМ РЕПЛИКАЦИИ: `applyOps` материализует строку из
    // самого пакета. Отдельного «быстрого создания» на сервере нет — оно и
    // было бы второй реализацией правил.
    await runAsync(syncTail(ctx), tx);
    const ops = birthOps(f, id, ws, input);
    const result = await runAsync(applyOps(ctx, ops, 1), tx);
    return { id, applied: result.applied, collided: result.collided };
  });
}
