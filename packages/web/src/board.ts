/**
 * Доска задач (W4, memory-mda8bk7q3v04) — колонки только читают то, что уже
 * вычислено в `nodes`. Ни один SQL здесь не пишет, поэтому у доски нет
 * своего пути мутации: она группирует то же самое, что `myc ready` и
 * `myc show`, и любое изменение состояния идёт через planOp (mutate.ts), не
 * через этот модуль (S54).
 *
 * blocked НЕ хранимый статус: это status='open' AND open_blockers>0, та же
 * арифметика, что у ready.ts BLOCKED_SQL — вычисление продублировано
 * умышленно, потому что доска и очередь читают одну и ту же колонку по
 * разным осям (очередь ранжирует «что взять», доска показывает «где всё»).
 */

import type { BoardColumn, BoardPayload, BoardRow, CardRef } from "./types.ts";
import type { ReadOnlyDb } from "./db.ts";

const COLUMNS: readonly BoardColumn[] = ["open", "blocked", "in_progress", "closed", "cancelled"];

interface RowSql {
  id: string;
  title: string;
  priority: number;
  assignee: string;
  attrs: string;
  updated_at: number;
}

function typeOf(attrsJson: string): string {
  try {
    const attrs = JSON.parse(attrsJson) as Record<string, unknown>;
    return typeof attrs["type"] === "string" ? (attrs["type"] as string) : "task";
  } catch {
    // битый attrs не роняет колонку — считаем как обычную задачу
    return "task";
  }
}

function toRow(r: RowSql): BoardRow {
  return {
    id: r.id,
    title: r.title,
    priority: r.priority,
    type: typeOf(r.attrs),
    assignee: r.assignee,
    updated_at: r.updated_at,
  };
}

const COLS = "id, title, priority, assignee, attrs, updated_at";

interface ParentEdgeRow {
  child_id: string;
  child_status: string;
  parent_id: string;
  parent_title: string;
}

/**
 * Обе стороны иерархии одним запросом (W5): у ребёнка — id и заголовок
 * родителя, у родителя — статусы всех детей, чтобы посчитать прогресс.
 * Ребро `parent` ведёт ОТ ребёнка К родителю — тот же разбор, что у
 * `myc show` и у card.ts, иначе доска расскажет другую историю иерархии.
 */
const PARENT_EDGES_SQL = `
SELECT c.id AS child_id, c.status AS child_status, p.id AS parent_id, p.title AS parent_title
  FROM edges e
  JOIN nodes c ON c.id = e.src
  JOIN nodes p ON p.id = e.dst
 WHERE e.type = 'parent' AND e.deleted_at IS NULL
   AND c.deleted_at IS NULL AND p.deleted_at IS NULL`;

interface Hierarchy {
  readonly parentOf: ReadonlyMap<string, { readonly id: string; readonly title: string }>;
  readonly progressOf: ReadonlyMap<string, { done: number; cancelled: number; total: number }>;
}

function loadHierarchy(db: ReadOnlyDb): Hierarchy {
  const parentOf = new Map<string, { id: string; title: string }>();
  const progressOf = new Map<string, { done: number; cancelled: number; total: number }>();
  if (!db.has("edges")) return { parentOf, progressOf };
  for (const r of db.all<ParentEdgeRow>(PARENT_EDGES_SQL)) {
    parentOf.set(r.child_id, { id: r.parent_id, title: r.parent_title });
    let p = progressOf.get(r.parent_id);
    if (p === undefined) {
      p = { done: 0, cancelled: 0, total: 0 };
      progressOf.set(r.parent_id, p);
    }
    p.total += 1;
    // Прогресс считается по closed, НЕ по «не открытым» (W5, S54): отменённая
    // задача — не сделанная работа и выводится отдельным числом, иначе эпик
    // выглядит более готовым, чем он есть.
    if (r.child_status === "closed") p.done += 1;
    else if (r.child_status === "cancelled") p.cancelled += 1;
  }
  return { parentOf, progressOf };
}

function withHierarchy(row: BoardRow, h: Hierarchy): BoardRow {
  const parent = h.parentOf.get(row.id);
  const progress = h.progressOf.get(row.id);
  if (parent === undefined && progress === undefined) return row;
  return {
    ...row,
    ...(parent !== undefined ? { parent } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}

// closed/cancelled растут неограниченно — последние 100 по времени правки,
// как у kb.ts; open/blocked/in_progress на практике малы (это открытая работа).
const SQL: Record<BoardColumn, string> = {
  open: `SELECT ${COLS} FROM nodes
          WHERE scope=?1 AND kind='task' AND status='open' AND open_blockers=0 AND deleted_at IS NULL`,
  blocked: `SELECT ${COLS} FROM nodes
          WHERE scope=?1 AND kind='task' AND status='open' AND open_blockers>0 AND deleted_at IS NULL`,
  in_progress: `SELECT ${COLS} FROM nodes
          WHERE scope=?1 AND kind='task' AND status='in_progress' AND deleted_at IS NULL`,
  closed: `SELECT ${COLS} FROM nodes
          WHERE scope=?1 AND kind='task' AND status='closed' AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT 100`,
  cancelled: `SELECT ${COLS} FROM nodes
          WHERE scope=?1 AND kind='task' AND status='cancelled' AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT 100`,
};

export interface BoardOptions {
  readonly scope: string;
}

export function buildBoard(db: ReadOnlyDb, opts: BoardOptions): BoardPayload {
  const t0 = performance.now();
  const empty: BoardPayload = {
    columns: Object.fromEntries(COLUMNS.map((c) => [c, []])) as unknown as BoardPayload["columns"],
    took_ms: 0,
  };
  if (!db.has("nodes")) return empty;

  const hierarchy = loadHierarchy(db);
  const columns = {} as Record<BoardColumn, BoardRow[]>;
  for (const col of COLUMNS) {
    const rows = db.all<RowSql>(SQL[col], [opts.scope]).map(toRow).map((r) => withHierarchy(r, hierarchy));
    rows.sort((a, b) => a.priority - b.priority || b.updated_at - a.updated_at);
    columns[col] = rows;
  }
  return { columns, took_ms: Math.round(performance.now() - t0) };
}

interface RefSql {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: number;
  attrs: string;
}

const RELEASE_SQL = `
SELECT n.id AS id, n.title AS title, n.kind AS kind, n.status AS status,
       n.priority AS priority, n.attrs AS attrs
  FROM edges e JOIN nodes n ON n.id = e.dst
 WHERE e.src = ?1 AND e.type = 'blocks' AND e.deleted_at IS NULL
   AND n.deleted_at IS NULL AND n.status = 'open' AND n.open_blockers = 1`;

/**
 * Задачи, у которых узел `id` — ЕДИНСТВЕННЫЙ открытый блокер: close ИЛИ
 * cancel этого узла прямо сейчас освободит их в ready. trg_st_close
 * (миграция 001) считает терминальными closed/cancelled/superseded/retracted
 * ОДИНАКОВО, поэтому предпросмотр общий для close и cancel, а не только для
 * отмены — задача этой доски явно требует показывать его в обоих диалогах.
 */
export function releasePreview(db: ReadOnlyDb, id: string): readonly CardRef[] {
  if (!db.has("nodes") || !db.has("edges")) return [];
  return db.all<RefSql>(RELEASE_SQL, [id]).map((r) => {
    let attrs: Record<string, unknown> = {};
    try {
      attrs = JSON.parse(r.attrs) as Record<string, unknown>;
    } catch {
      // битый attrs не роняет предпросмотр
    }
    const type = typeof attrs["type"] === "string" ? (attrs["type"] as string) : r.kind;
    return { id: r.id, title: r.title, kind: r.kind, status: r.status, priority: r.priority, type };
  });
}
