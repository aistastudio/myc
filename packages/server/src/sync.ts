/**
 * ОБМЕН С ПИРОМ НА СЕРВЕРЕ (§9.5, `POST /v1/ws/:ws/sync`).
 *
 * Сервер — такой же сайт, а не источник истины: он принимает присланные
 * операции ТЕМ ЖЕ применителем, что и всё остальное (`applyOps`, origin = 0),
 * и отдаёт свои тем же чтением, что и клиент (`collectForPeer` в ядре).
 * Второй реализации протокола здесь нет — только транзакция вокруг неё.
 *
 * ВСЁ В ОДНОЙ ТРАНЗАКЦИИ, И ЭТО НЕ УДОБСТВО. Приём и выдача под одной
 * транзакцией дают пиру ответ, согласованный сам с собой: воды в ответе
 * описывают ровно то состояние, из которого выбраны операции. Разъедини их —
 * и параллельный пир, успевший записать между двумя транзакциями, окажется
 * «уже учтённым» в водах, но его операции в пакет не попадут, и клиент
 * пропустит их навсегда.
 */

import {
  applyOps,
  collectForPeer,
  HlcClock,
  localWatermarks,
  OpFactory,
  parseOp,
  parseWatermarks,
  recordPeer,
  runAsync,
  SYNC_MAX_OPS,
  type ApplyCtx,
  type Op,
  type SyncAnswer,
  type SyncRequest,
  type Watermarks,
} from "@myc/core";
import type { PostgresDriver } from "@myc/store-postgres";
import { tenantSite } from "./write.ts";

export interface SyncError {
  readonly code: string;
  readonly msg: string;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; error: SyncError };

/**
 * Разбор запроса. Всё пришло по сети, поэтому проверяется каждое поле, а
 * отказ называет ПЕРВУЮ негодную операцию по индексу: «ops[7] is malformed»
 * чинится, «bad request» — нет.
 */
export function validateSync(body: unknown): Parsed<SyncRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: { code: "usage.body", msg: "body must be a JSON object" } };
  }
  const b = body as Record<string, unknown>;
  const site = b["site_id"];
  if (typeof site !== "string" || site === "" || site.length > 64) {
    return { ok: false, error: { code: "usage.site_id", msg: "'site_id' is required" } };
  }
  const have = parseWatermarks(b["have"]);
  if (have === undefined) {
    return {
      ok: false,
      error: { code: "usage.have", msg: "'have' must map site ids to non-negative clocks" },
    };
  }
  const rawOps = b["ops"] ?? [];
  if (!Array.isArray(rawOps)) {
    return { ok: false, error: { code: "usage.ops", msg: "'ops' must be an array" } };
  }
  if (rawOps.length > SYNC_MAX_OPS) {
    return {
      ok: false,
      error: {
        code: "usage.ops",
        msg: `a batch carries at most ${SYNC_MAX_OPS} operations, got ${rawOps.length}`,
      },
    };
  }
  const ops: Op[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    const op = parseOp(rawOps[i]);
    if (op === undefined) {
      return { ok: false, error: { code: "usage.ops", msg: `ops[${i}] is malformed` } };
    }
    ops.push(op);
  }
  const want = b["want"];
  const dry = b["dry"];
  if (want !== undefined && typeof want !== "boolean") {
    return { ok: false, error: { code: "usage.want", msg: "'want' must be a boolean" } };
  }
  if (dry !== undefined && typeof dry !== "boolean") {
    return { ok: false, error: { code: "usage.dry", msg: "'dry' must be a boolean" } };
  }
  // ПРИМЕРКА С ОПЕРАЦИЯМИ — ПРОТИВОРЕЧИЕ, и разрешать его нельзя. Пакет
  // применяется целиком или не применяется вовсе; «прислал, но понарошку»
  // означало бы, что отправитель считает их доставленными, а получатель —
  // нет, и расхождение всплыло бы как потерянная запись, а не как отказ.
  if (dry === true && Array.isArray(rawOps) && rawOps.length > 0) {
    return {
      ok: false,
      error: { code: "usage.dry", msg: "a dry run carries no operations: it changes nothing by definition" },
    };
  }
  return { ok: true, data: { site_id: site, have, ops, want: want !== false, dry: dry === true } };
}

export async function syncExchange(
  pg: PostgresDriver,
  tenant: string,
  ws: string,
  req: SyncRequest,
  actor: string,
  now: number = Date.now(),
): Promise<SyncAnswer> {
  return pg.withTenant(tenant, async (tx) => {
    const site = await tenantSite(tx, ws);
    const ctx: ApplyCtx = {
      actor,
      siteId: site,
      ops: new OpFactory(site, { clock: new HlcClock() }),
      now: () => now,
    };
    // Присланное — ЧУЖИЕ операции (origin = 0): их op_id и часы уже выданы
    // на сайте-источнике, и сервер их не перевыдаёт. Пакет применяется
    // целиком: то, что приехало раньше своего узла, durable ложится в
    // oplog_pending и применится, когда недостающее приедет.
    // Примерка не записывает о пире ничего: прогон, меняющий его состояние,
    // сухим не является. Операций в ней не бывает вовсе — разбор их не
    // принимает (validateSync), поэтому здесь нет и ветки «применить, но не
    // совсем».
    const dry = req.dry === true;
    if (req.ops.length > 0) await runAsync(applyOps(ctx, req.ops, 0), tx);
    const batch =
      req.want === false
        ? { ops: [] as readonly Op[], more: false }
        : await runAsync(collectForPeer(ws, req.have), tx);
    const watermarks: Watermarks = await runAsync(localWatermarks(ws), tx);
    if (!dry) await runAsync(recordPeer(req.site_id, req.have, 0, now), tx);
    return {
      site_id: site,
      // Пакет применён целиком или транзакция не закоммитилась вовсе —
      // значит принято всё, что приехало, и повторять его пиру не нужно.
      // При примерке не принято ничего, и говорить иначе нельзя.
      accepted: dry ? [] : req.ops.map((o) => o.op_id),
      ops: batch.ops,
      watermarks,
      more: batch.more,
    };
  });
}
