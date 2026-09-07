/**
 * Экран «очередь»: те же кандидаты, что печатает `myc ready`, и — главное —
 * те же слагаемые формулы S21 разобранными на множители.
 *
 * score = 0.40·P + 0.27·U + 0.14·F + 0.10·A + 0.09·T
 *
 * Слагаемые округляются до сотых ДО суммы — ровно как в CLI, иначе
 * напечатанный score перестаёт быть суммой напечатанных слагаемых, и весь
 * смысл экрана («почему эта задача сверху») пропадает.
 *
 * Скоринг повторён здесь, а не импортирован из CLI, потому что в CLI он
 * живёт внутри команды, а не в переиспользуемом модуле; расхождение ловит
 * тест ready.test.ts, который сверяет числа с эталоном S21.
 */

import type { ReadyPayload, ReadyRow, ReadyTerm, ReadyWeights } from "./types.ts";
import type { ReadOnlyDb } from "./db.ts";

const CLOSED = "('closed','cancelled','superseded','retracted')";

const PRIORITY_NORM = [1, 2 / 3, 1 / 3, 0] as const;
const UNBLOCKS_CAP = 3;

const CANDIDATES_SQL = `
SELECT id, priority, status, assignee, title, updated_at, attrs
  FROM nodes
 WHERE scope = ?1 AND kind = 'task' AND status = 'open'
   AND open_blockers = 0 AND deleted_at IS NULL`;

const UNBLOCKS_SQL = `
SELECT e.src AS id, count(*) AS n
  FROM edges e JOIN nodes d ON d.id = e.dst
 WHERE e.type = 'blocks' AND e.deleted_at IS NULL
   AND d.deleted_at IS NULL AND d.status NOT IN ${CLOSED}
 GROUP BY e.src`;

const ANCHOR_STATES_SQL = `
SELECT e.src AS id, n.status AS st
  FROM edges e JOIN nodes n ON n.id = e.dst
 WHERE e.type = 'touches' AND e.deleted_at IS NULL
   AND n.kind = 'anchor' AND n.deleted_at IS NULL`;

const BLOCKED_SQL = `
SELECT count(*) AS n FROM nodes
 WHERE scope = ?1 AND kind = 'task' AND status = 'open'
   AND open_blockers > 0 AND deleted_at IS NULL`;

const IN_PROGRESS_SQL = `
SELECT count(*) AS n FROM nodes
 WHERE scope = ?1 AND kind = 'task' AND status = 'in_progress'
   AND deleted_at IS NULL`;

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function freshnessNorm(ageMs: number): number {
  const day = 86_400_000;
  if (ageMs < day) return 1.0;
  if (ageMs < 3 * day) return 0.7;
  if (ageMs < 7 * day) return 0.4;
  return 0.15;
}

export function anchorNorm(states: readonly string[] | undefined): {
  norm: number;
  label: string;
} {
  if (states === undefined || states.length === 0) return { norm: 0.5, label: "нет якорей" };
  if (states.every((s) => s === "fresh")) return { norm: 1.0, label: "fresh" };
  if (states.some((s) => s === "stale" || s === "lost")) return { norm: 0.2, label: "stale" };
  return { norm: 0.6, label: "drifted" };
}

export function typeNorm(type: string): number {
  switch (type) {
    case "bug":
      return 1.0;
    case "task":
      return 0.5;
    default:
      return 0.25;
  }
}

/** Возраст компактно: 38m, 6h, 2d — как в CLI. */
export function fmtAge(ms: number): string {
  const abs = Math.max(0, ms);
  const m = Math.floor(abs / 60_000);
  if (m < 1) return `${Math.floor(abs / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface CandidateRow {
  id: string;
  priority: number;
  status: string;
  assignee: string;
  title: string;
  updated_at: number;
  attrs: string;
}

export function scoreRow(
  row: CandidateRow,
  unblocks: number,
  states: readonly string[] | undefined,
  weights: ReadyWeights,
  now: number,
): ReadyRow {
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(row.attrs) as Record<string, unknown>;
  } catch {
    // битый attrs не должен выбрасывать задачу из очереди — считаем как task
  }
  const type = typeof attrs["type"] === "string" ? (attrs["type"] as string) : "task";
  const age = Math.max(0, now - row.updated_at);
  const anchor = anchorNorm(states);

  const nPri = PRIORITY_NORM[row.priority] ?? 0;
  const nUnb = Math.min(unblocks, UNBLOCKS_CAP) / UNBLOCKS_CAP;
  const nFresh = freshnessNorm(age);
  const nType = typeNorm(type);

  const terms: ReadyTerm[] = [
    { key: "priority", label: `P${row.priority}`, weight: weights.priority, norm: nPri, value: r2(weights.priority * nPri) },
    { key: "unblocks", label: `unblocks ${unblocks}`, weight: weights.unblocks, norm: nUnb, value: r2(weights.unblocks * nUnb) },
    { key: "freshness", label: `свежесть ${fmtAge(age)}`, weight: weights.freshness, norm: nFresh, value: r2(weights.freshness * nFresh) },
    { key: "anchors", label: `якоря ${anchor.label}`, weight: weights.anchors, norm: anchor.norm, value: r2(weights.anchors * anchor.norm) },
    { key: "type", label: type, weight: weights.type, norm: nType, value: r2(weights.type * nType) },
  ];

  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    type,
    assignee: row.assignee,
    unblocks,
    age_ms: age,
    anchors: anchor.label,
    score: r2(terms.reduce((sum, t) => sum + t.value, 0)),
    terms,
  };
}

export interface ReadyOptions {
  readonly scope: string;
  readonly weights: ReadyWeights;
  readonly limit?: number;
  readonly now?: number;
}

export function buildReady(db: ReadOnlyDb, opts: ReadyOptions): ReadyPayload {
  const t0 = performance.now();
  const limit = opts.limit ?? 50;
  const empty: ReadyPayload = {
    rows: [],
    ready: 0,
    blocked: 0,
    in_progress: 0,
    weights: opts.weights,
    took_ms: 0,
  };
  if (!db.has("nodes") || !db.has("edges")) return empty;

  const now = opts.now ?? Date.now();
  const rows = db.all<CandidateRow>(CANDIDATES_SQL, [opts.scope]);

  const unblocks = new Map<string, number>();
  for (const r of db.all<{ id: string; n: number }>(UNBLOCKS_SQL)) unblocks.set(r.id, r.n);

  const anchorStates = new Map<string, string[]>();
  for (const r of db.all<{ id: string; st: string }>(ANCHOR_STATES_SQL)) {
    const list = anchorStates.get(r.id);
    if (list === undefined) anchorStates.set(r.id, [r.st]);
    else list.push(r.st);
  }

  const scored = rows.map((row) =>
    scoreRow(row, unblocks.get(row.id) ?? 0, anchorStates.get(row.id), opts.weights, now),
  );
  scored.sort((a, b) => b.score - a.score || a.priority - b.priority || a.id.localeCompare(b.id));

  return {
    rows: scored.slice(0, limit),
    ready: scored.length,
    blocked: db.one<{ n: number }>(BLOCKED_SQL, [opts.scope])?.n ?? 0,
    in_progress: db.one<{ n: number }>(IN_PROGRESS_SQL, [opts.scope])?.n ?? 0,
    weights: opts.weights,
    took_ms: Math.round(performance.now() - t0),
  };
}
