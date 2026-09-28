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
  applyLocalEdgeAdd,
  applyLocalEdgeDel,
  applyLocalOps,
  applyOps,
  assertEdgeKind,
  assertNodeKind,
  assertStatus,
  claimNode,
  ClosureError,
  DEFAULT_STATUS,
  generateId,
  GraphError,
  HlcClock,
  LEASE_TTL_MS,
  nodePatchFields,
  OpFactory,
  Q,
  runAsync,
  syncTail,
  type ApplyCtx,
  type ClaimReceipt,
  type EdgeKind,
  type JsonValue,
  type NodeHeadRow,
  type NodeKind,
  type NodePatch,
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

/** Поля, которые принимает правка. `attrs` мержится поключево, а не заменяет. */
const PATCHABLE = ["title", "body", "status", "priority", "assignee", "salience"] as const;

/**
 * Проверка правки. Принимается ТОЛЬКО перечисленное: `kind` неизменяем (§2.2),
 * `scope` — переезд между воркспейсами, а это отдельная операция со своими
 * правилами, и делать её незаметным полем в PATCH нельзя.
 *
 * Пустая правка — отказ, а не «успешно ничего не сделано»: клиент, пославший
 * пустое тело, ошибся, и молчаливое 200 спрячет его ошибку.
 */
export function validateUpdate(input: unknown): WriteResult<NodePatch> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: { code: "usage.body", msg: "the body must be a JSON object" } };
  }
  const o = input as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of PATCHABLE) {
    if (o[key] !== undefined) patch[key] = o[key];
  }
  if (typeof patch["title"] === "string") {
    const title = patch["title"].trim();
    if (title.length === 0) {
      return { ok: false, error: { code: "usage.title", msg: "title must not be empty" } };
    }
    if (title.length > MAX_TITLE) {
      return { ok: false, error: { code: "usage.title", msg: `title must be at most ${MAX_TITLE} characters` } };
    }
    patch["title"] = title;
  }
  if (patch["priority"] !== undefined && !PRIORITIES.has(Number(patch["priority"]))) {
    return { ok: false, error: { code: "usage.priority", msg: "priority must be 0, 1, 2 or 3" } };
  }
  if (typeof o["attrs"] === "object" && o["attrs"] !== null) patch["attrs"] = o["attrs"];
  const rejected = Object.keys(o).filter(
    (k) => k !== "attrs" && !(PATCHABLE as readonly string[]).includes(k),
  );
  if (rejected.length > 0) {
    return {
      ok: false,
      error: {
        code: "usage.field",
        msg: `these fields cannot be changed here: ${rejected.join(", ")}`,
      },
    };
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { code: "usage.empty", msg: "nothing to change" } };
  }
  return { ok: true, data: patch as NodePatch };
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
  // СТАТУС СТАВИТСЯ ВСЕГДА, и это не мелочь: применитель материализует
  // приехавший узел со статусом `active` (он не знает вида), а у задачи
  // начальный статус — `open`. Без явной операции задача рождалась бы
  // «активной», и CAS аренды не брал бы её вовсе — поймано ws.pg.test.ts.
  ops.push(f.set(id, "status", assertStatus(input.kind as NodeKind, input.status ?? DEFAULT_STATUS[input.kind as NodeKind])));
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

export interface UpdatedNode {
  readonly id: string;
  readonly changed: readonly string[];
}

/**
 * Правка узла — ЛОКАЛЬНАЯ запись, а не репликация: строка уже есть, и
 * применитель проецирует на неё `set`-операции. Поэтому здесь
 * `applyLocalOps`, у которого столкновение громкое: у своей записи не бывает
 * законной ничьей, она означает двух писателей под одним site_id.
 *
 * Узел ЧУЖОГО воркспейса отвечает как несуществующий — тем же, что и
 * выдуманный id (см. ws.ts): иначе по разнице ответов перебирают, что есть у
 * соседа.
 */
export async function updateNode(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  id: string,
  patch: NodePatch,
  actor: string,
): Promise<WriteResult<UpdatedNode>> {
  return pg.withTenant(tenant, async (tx) => {
    const head = await tx.one<NodeHeadRow>(Q.node_head, [id]);
    if (head === undefined || head.scope !== ws) {
      return {
        ok: false as const,
        error: { code: "notfound.node", msg: `no node ${id} in workspace ${ws}` },
      };
    }
    let fields: Array<readonly [string, JsonValue]>;
    try {
      // Проверка значений принадлежит ядру: `status` зависит от вида узла, а
      // диапазоны полей — от той же таблицы NODE_FIELDS, что у CLI.
      fields = nodePatchFields(head.kind as NodeKind, patch);
    } catch (e) {
      const msg = e instanceof GraphError ? e.message : String(e);
      return { ok: false as const, error: { code: "usage.value", msg } };
    }
    if (fields.length === 0) {
      return { ok: false as const, error: { code: "usage.empty", msg: "nothing to change" } };
    }
    const site = await tenantSite(tx, ws);
    const f = new OpFactory(site, { clock: new HlcClock() });
    const ctx: ApplyCtx = { actor, siteId: site, ops: f, now: () => Date.now() };
    // Минт ВНУТРИ, после подъёма часов от хвоста — та же причина, что у
    // создания (myc-4dy).
    await runAsync(
      applyLocalOps(
        ctx,
        () => fields.map(([field, value]) => f.set(id, field, value)),
        id,
        ws,
        (op) => new GraphError("graph.clock_collision", `concurrent write to ${id}.${op.field ?? op.op}`),
      ),
      tx,
    );
    return { ok: true as const, data: { id, changed: fields.map(([field]) => field) } };
  });
}

export interface EdgeRef {
  readonly from: string;
  readonly type: string;
  readonly to: string;
  readonly weight?: number;
  readonly attrs?: Readonly<Record<string, JsonValue>>;
}

/** Разбор тела запроса о ребре. Вид ребра проверяет ядро — список там один. */
export function validateEdge(input: unknown): WriteResult<EdgeRef> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: { code: "usage.body", msg: "the body must be a JSON object" } };
  }
  const o = input as Record<string, unknown>;
  const from = typeof o["from"] === "string" ? o["from"] : "";
  const to = typeof o["to"] === "string" ? o["to"] : "";
  const type = typeof o["type"] === "string" ? o["type"] : "";
  if (from === "" || to === "") {
    return { ok: false, error: { code: "usage.endpoints", msg: "both 'from' and 'to' are required" } };
  }
  if (from === to) {
    return { ok: false, error: { code: "usage.endpoints", msg: "an edge from a node to itself is not allowed" } };
  }
  try {
    assertEdgeKind(type);
  } catch {
    return { ok: false, error: { code: "usage.type", msg: `unknown edge type '${type}'` } };
  }
  const weight = o["weight"] === undefined ? undefined : Number(o["weight"]);
  if (weight !== undefined && !Number.isFinite(weight)) {
    return { ok: false, error: { code: "usage.weight", msg: "weight must be a number" } };
  }
  const attrs =
    typeof o["attrs"] === "object" && o["attrs"] !== null
      ? (o["attrs"] as Record<string, JsonValue>)
      : undefined;
  return { ok: true, data: { from, to, type, weight, attrs } };
}

/**
 * Оба конца обязаны жить В ЭТОМ воркспейсе. Проверка здесь, а не в базе:
 * внешний ключ поймал бы только несуществующий узел, а ребро в СОСЕДНИЙ
 * воркспейс он пропустил бы — арендатор-то тот же.
 */
async function endpointsInWorkspace(
  tx: AsyncDbDriver,
  ws: string,
  from: string,
  to: string,
): Promise<WriteFailure | undefined> {
  for (const id of [from, to]) {
    const head = await tx.one<NodeHeadRow>(Q.node_head, [id]);
    if (head === undefined || head.scope !== ws) {
      return { code: "notfound.node", msg: `no node ${id} in workspace ${ws}` };
    }
  }
  return undefined;
}

/** Добавить ребро. Правила (циклы, замыкание, оплог) — в ядре. */
export async function addEdge(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  edge: EdgeRef,
  actor: string,
): Promise<WriteResult<{ readonly from: string; readonly type: string; readonly to: string }>> {
  return pg.withTenant(tenant, async (tx) => {
    const missing = await endpointsInWorkspace(tx, ws, edge.from, edge.to);
    if (missing !== undefined) return { ok: false as const, error: missing };
    const site = await tenantSite(tx, ws);
    const f = new OpFactory(site, { clock: new HlcClock() });
    const ctx: ApplyCtx = { actor, siteId: site, ops: f, now: () => Date.now() };
    try {
      await runAsync(
        applyLocalEdgeAdd(
          ctx,
          edge.from,
          edge.type as EdgeKind,
          edge.to,
          ws,
          { weight: edge.weight, attrs: JSON.stringify(edge.attrs ?? {}) },
          (op) => new GraphError("graph.clock_collision", `concurrent write to edge ${op.entity_id}`),
        ),
        tx,
      );
    } catch (e) {
      // Цикл и предел обхода — ОТКАЗ ПО СУЩЕСТВУ, а не сбой: у них свои коды
      // (§4.3), и клиент обязан увидеть, что именно не так с его ребром.
      if (e instanceof ClosureError) {
        return { ok: false as const, error: { code: `precond.${e.code.replace("closure.", "")}`, msg: e.message } };
      }
      throw e;
    }
    return { ok: true as const, data: { from: edge.from, type: edge.type, to: edge.to } };
  });
}

/** Удалить ребро. `false` в данных — удалять было нечего. */
export async function removeEdge(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  edge: EdgeRef,
  actor: string,
): Promise<WriteResult<{ readonly removed: boolean }>> {
  return pg.withTenant(tenant, async (tx) => {
    const missing = await endpointsInWorkspace(tx, ws, edge.from, edge.to);
    if (missing !== undefined) return { ok: false as const, error: missing };
    const site = await tenantSite(tx, ws);
    const f = new OpFactory(site, { clock: new HlcClock() });
    const ctx: ApplyCtx = { actor, siteId: site, ops: f, now: () => Date.now() };
    const removed = await runAsync(
      applyLocalEdgeDel(ctx, edge.from, edge.type as EdgeKind, edge.to, ws),
      tx,
    );
    return { ok: true as const, data: { removed } };
  });
}

/** Умолчание аренды — то же, что у CLI: пятнадцать минут (§9.4). */
export const CLAIM_TTL_MS = LEASE_TTL_MS;
const CLAIM_TTL_MAX_MS = 8 * 60 * 60 * 1000;

/**
 * Взять задачу в работу. Кто успел — решает CAS в ядре, а не сервер: два
 * агента, пришедшие в одну миллисекунду, получат разные ответы, и второй
 * узнает об этом кодом, а не пустотой.
 *
 * `holder` — не поле запроса: держателем становится ВЛАДЕЛЕЦ ТОКЕНА. Иначе
 * любой мог бы взять задачу от чужого имени, и «кто держит» перестало бы
 * что-либо значить.
 */
export async function claimTask(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  id: string,
  holder: string,
  ttlMs: number,
): Promise<WriteResult<ClaimReceipt>> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > CLAIM_TTL_MAX_MS) {
    return {
      ok: false,
      error: { code: "usage.lease", msg: `lease must be between 1 ms and ${CLAIM_TTL_MAX_MS} ms` },
    };
  }
  return pg.withTenant(tenant, async (tx) => {
    const head = await tx.one<NodeHeadRow>(Q.node_head, [id]);
    if (head === undefined || head.scope !== ws) {
      return {
        ok: false as const,
        error: { code: "notfound.node", msg: `no node ${id} in workspace ${ws}` },
      };
    }
    const site = await tenantSite(tx, ws);
    const f = new OpFactory(site, { clock: new HlcClock() });
    const ctx: ApplyCtx = { actor: holder, siteId: site, ops: f, now: () => Date.now() };
    const receipt = await runAsync(claimNode(ctx, id, holder, ttlMs), tx);
    if (receipt === undefined) {
      return {
        ok: false as const,
        error: { code: "conflict.claimed", msg: `task ${id} is already taken or not open` },
      };
    }
    return { ok: true as const, data: receipt };
  });
}
