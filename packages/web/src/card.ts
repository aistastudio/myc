/**
 * Карточка узла со связями — чтение, зеркалящее `myc show`.
 *
 * Иерархия здесь обязана читаться так же, как в терминале: у эпика —
 * «состав N из M закрыто» со списком детей, у задачи — «входит в <эпик>».
 * Ребро `parent` ведёт ОТ ребёнка К родителю, поэтому родитель ищется по
 * исходящим рёбрам, а состав — по входящим (packages/cli/src/commands/show.ts).
 *
 * Прогресс эпика считается по ЗАКРЫТЫМ, а не по «не открытым»: отменённая
 * задача — не сделанная работа, и складывать её в выполненную значило бы
 * показывать эпик более готовым, чем он есть. Поэтому отменённые выводятся
 * отдельным числом — ровно как строка «, отменено K» у show.
 *
 * Здесь нет ни одной записи: только SELECT по своему read-only соединению.
 */

import { readReach, readRepo } from "@myc/core";
import type {
  CardComment,
  CardLink,
  CardProgress,
  CardRef,
  CardView,
} from "./types.ts";
import type { ReadOnlyDb } from "./db.ts";

export type { CardComment, CardLink, CardProgress, CardRef, CardView };

/** Видимый тип узла — то же правило, что nodeType в CLI. */
export function visibleType(kind: string, attrs: Record<string, unknown>): string {
  if (kind === "task") {
    const t = attrs["type"];
    if (typeof t === "string" && t.length > 0) return t;
  }
  return kind;
}

interface NodeRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  priority: number;
  assignee: string;
  acl: string;
  attrs: string;
  layer: number;
  open_blockers: number;
  lease_holder: string;
  lease_expires: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface RefRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: number;
  attrs: string;
}

function toRef(r: RefRow): CardRef {
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(r.attrs) as Record<string, unknown>;
  } catch {
    // битый attrs не роняет карточку — тип станет kind
  }
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    type: visibleType(r.kind, attrs),
  };
}

/**
 * Живой связанный узел: рёбра к удалённым не рисуются. Имя колонки в SQL
 * не параметризуется, поэтому две стороны ребра — два подготовленных текста.
 */
const REFS_BY_DST = `
SELECT n.id, n.title, n.kind, n.status, n.priority, n.attrs
  FROM edges e JOIN nodes n ON n.id = e.src
 WHERE e.dst = ?1 AND e.type = ?2
   AND e.deleted_at IS NULL AND n.deleted_at IS NULL`;

const REFS_BY_SRC = `
SELECT n.id, n.title, n.kind, n.status, n.priority, n.attrs
  FROM edges e JOIN nodes n ON n.id = e.dst
 WHERE e.src = ?1 AND e.type = ?2
   AND e.deleted_at IS NULL AND n.deleted_at IS NULL`;

function refRows(db: ReadOnlyDb, incoming: boolean, id: string, type: string): CardRef[] {
  const rows = db.all<RefRow>(incoming ? REFS_BY_DST : REFS_BY_SRC, [id, type]);
  return rows.map(toRef);
}

interface CommentRow {
  id: string;
  title: string;
  body: string;
  assignee: string;
  attrs: string;
  created_at: number;
}

/**
 * Нить: kind='message' узлы с ребром replies_to на эту карточку (W13). Мягко
 * удалённые — ни ребро, ни узел — не попадают: тот же фильтр deleted_at IS
 * NULL, что и у всех остальных связей карточки.
 */
const COMMENTS_SQL = `
SELECT n.id, n.title, n.body, n.assignee, n.attrs, n.created_at
  FROM edges e JOIN nodes n ON n.id = e.src
 WHERE e.dst = ?1 AND e.type = 'replies_to' AND n.kind = 'message'
   AND e.deleted_at IS NULL AND n.deleted_at IS NULL
 ORDER BY n.created_at ASC, n.id ASC`;

function toComment(r: CommentRow): CardComment {
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(r.attrs) as Record<string, unknown>;
  } catch {
    // битый attrs не роняет карточку — роль станет "agent"
  }
  const role = typeof attrs["role"] === "string" && attrs["role"].length > 0 ? attrs["role"] : "agent";
  // title всегда есть (обязателен у myc create); body — необязательное
  // продолжение markdown. Собираем обратно тем же правилом, что у
  // planCreateNote: заголовок первой строкой, тело — следом.
  const body = r.body.length > 0 ? `${r.title}\n${r.body}` : r.title;
  return {
    id: r.id,
    author: r.assignee.length > 0 ? r.assignee : "agent",
    role,
    body,
    created_at: r.created_at,
  };
}

function commentRows(db: ReadOnlyDb, id: string): CardComment[] {
  return db.all<CommentRow>(COMMENTS_SQL, [id]).map(toComment);
}

export function buildCard(db: ReadOnlyDb, id: string): CardView | undefined {
  if (!db.has("nodes") || !db.has("edges")) return undefined;
  const row = db.one<NodeRow>(
    `SELECT id, kind, title, body, status, priority, assignee, acl, attrs, layer,
            open_blockers, lease_holder, lease_expires, created_at, updated_at, closed_at
       FROM nodes WHERE id = ?1 AND deleted_at IS NULL`,
    [id],
  );
  if (row === undefined) return undefined;

  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(row.attrs) as Record<string, unknown>;
  } catch {
    // битый attrs не роняет карточку
  }
  const tags = Array.isArray(attrs["tags"])
    ? attrs["tags"].filter((t): t is string => typeof t === "string")
    : [];
  // Оси охвата (S58, S59) — из attrs, тем же разбором, что у prime/ready.
  const reachInfo = readReach(attrs as never);
  const repoInfo = readRepo(attrs as never);
  const estimate = attrs["estimate_min"];
  const lease =
    row.lease_holder.length > 0 && row.lease_expires !== null
      ? { holder: row.lease_holder, expires: row.lease_expires }
      : null;

  // Ребро parent ведёт от ребёнка к родителю: родитель — по исходящим,
  // состав — по входящим. Как в show.ts, иначе карточка и терминал
  // расскажут про одну и ту же базу разные истории.
  const parent = refRows(db, false, id, "parent")[0] ?? null;
  const children = refRows(db, true, id, "parent").sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );

  const done = children.filter((c) => c.status === "closed").length;
  const cancelled = children.filter((c) => c.status === "cancelled").length;
  const progress: CardProgress | null =
    children.length > 0 ? { done, cancelled, total: children.length } : null;

  const linkRows = db.all<{ type: string; id: string; title: string }>(
    `SELECT e.type AS type, n.id AS id, n.title AS title
       FROM edges e JOIN nodes n ON n.id = e.dst
      WHERE e.src = ?1 AND e.deleted_at IS NULL AND n.deleted_at IS NULL
        AND e.type IN ('relates','derived_from','duplicates','supersedes')`,
    [id],
  );
  const RENAMED: Record<string, string> = {
    relates: "relates-to",
    derived_from: "derived-from",
  };

  return {
    id: row.id,
    kind: row.kind,
    type: visibleType(row.kind, attrs),
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    acl: row.acl,
    tags,
    estimate_min: typeof estimate === "number" ? estimate : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    open_blockers: row.open_blockers,
    lease,
    layer: row.layer,
    // Обе оси охвата читаются ядром — тем же разбором, что у prime и ready:
    // карточка не вправе рассказывать про attrs другую историю, чем список.
    reach: reachInfo.reach,
    session: reachInfo.session,
    repo: repoInfo.repo,
    repo_state: repoInfo.state,
    parent,
    children,
    progress,
    blocked_by: refRows(db, true, id, "blocks"),
    blocks: refRows(db, false, id, "blocks"),
    links: linkRows.map((l) => ({ type: RENAMED[l.type] ?? l.type, id: l.id, title: l.title })),
    comments: commentRows(db, id),
  };
}
