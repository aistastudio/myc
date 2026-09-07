/**
 * Экран «таймлайн»: хвост оплога — что менялось, кем и когда.
 *
 * Оплог append-only и упорядочен по seq, поэтому хвост — это индексный
 * проход с конца, а не скан. Значения усекаются здесь, на сервере: в ленту
 * не должны уезжать тела заметок целиком (одна запись `set body` — это
 * килобайты, а лента показывает сто записей).
 */

import type { OpRow, TimelinePayload } from "./types.ts";
import type { ReadOnlyDb } from "./db.ts";

/** Столько символов значения достаточно, чтобы понять, что произошло. */
const VALUE_CLIP = 160;

const TAIL_SQL = `
SELECT o.seq, o.ts_ms, o.actor, o.op, o.entity, o.entity_id,
       o.field, o.value, o.scope, o.origin,
       (SELECT n.title FROM nodes n WHERE n.id = o.entity_id) AS title
  FROM oplog o
 ORDER BY o.seq DESC
 LIMIT ?1`;

/** То же, но без джойна к nodes: база без таблицы узлов — тоже база. */
const TAIL_BARE_SQL = `
SELECT seq, ts_ms, actor, op, entity, entity_id, field, value, scope, origin,
       NULL AS title
  FROM oplog
 ORDER BY seq DESC
 LIMIT ?1`;

function clip(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  return text.length > VALUE_CLIP ? `${text.slice(0, VALUE_CLIP)}…` : text;
}

export interface TimelineOptions {
  readonly limit?: number;
}

export function buildTimeline(db: ReadOnlyDb, opts: TimelineOptions = {}): TimelinePayload {
  const t0 = performance.now();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  if (!db.has("oplog")) {
    return { rows: [], total: 0, last_seq: 0, took_ms: 0 };
  }

  const sql = db.has("nodes") ? TAIL_SQL : TAIL_BARE_SQL;
  const raw = db.all<Record<string, unknown>>(sql, [limit]);
  const rows: OpRow[] = raw.map((r) => ({
    seq: Number(r["seq"] ?? 0),
    ts_ms: Number(r["ts_ms"] ?? 0),
    actor: String(r["actor"] ?? ""),
    op: String(r["op"] ?? ""),
    entity: String(r["entity"] ?? ""),
    entity_id: String(r["entity_id"] ?? ""),
    field: r["field"] === null || r["field"] === undefined ? null : String(r["field"]),
    value: clip(r["value"]),
    scope: String(r["scope"] ?? ""),
    origin: Number(r["origin"] ?? 1),
    title: r["title"] === null || r["title"] === undefined ? null : String(r["title"]),
  }));

  const total = db.one<{ n: number }>("SELECT count(*) AS n FROM oplog")?.n ?? 0;
  return {
    rows,
    total,
    last_seq: rows[0]?.seq ?? 0,
    took_ms: Math.round(performance.now() - t0),
  };
}
