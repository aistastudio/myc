/**
 * Экран «граф»: узлы и рёбра одним пакетом.
 *
 * Лэйаут считается в браузере (решение S18 — до 25k узлов локально), поэтому
 * сервер отдаёт топологию, а не координаты. Если узлов больше лимита, берём
 * top-N по степени: обрезанный по степени подграф остаётся связным куском
 * графа, а обрезанный по id — россыпью точек.
 */

import type { GraphEdge, GraphNode, GraphPayload } from "./types.ts";
import type { ReadOnlyDb } from "./db.ts";

/** Потолок локального лэйаута (S18). */
export const DEFAULT_NODE_LIMIT = 25_000;

/** Выше этого рёбра перестают что-либо показывать и только жгут кадр. */
export const DEFAULT_EDGE_LIMIT = 60_000;

const EMPTY: GraphPayload = {
  nodes: [],
  edges: [],
  total_nodes: 0,
  total_edges: 0,
  truncated: false,
  limit: DEFAULT_NODE_LIMIT,
  took_ms: 0,
};

interface NodeRow {
  id: string;
  kind: string;
  status: string;
  layer: number;
  priority: number;
  title: string;
  updated_at: number;
  deg: number;
}

interface EdgeRow {
  src: string;
  type: string;
  dst: string;
}

/**
 * Степень считается одним проходом по живым рёбрам и джойнится к узлам через
 * временный CTE, а не подзапросом на строку: на 10k узлов это 12 мс против
 * полутора секунд.
 */
const NODES_SQL = `
WITH deg AS (
  SELECT src AS id, count(*) AS n FROM edges WHERE deleted_at IS NULL GROUP BY src
  UNION ALL
  SELECT dst AS id, count(*) AS n FROM edges WHERE deleted_at IS NULL GROUP BY dst
), degsum AS (
  SELECT id, sum(n) AS n FROM deg GROUP BY id
)
SELECT n.id, n.kind, n.status, n.layer, n.priority, n.title, n.updated_at,
       COALESCE(d.n, 0) AS deg
  FROM nodes n LEFT JOIN degsum d ON d.id = n.id
 WHERE n.deleted_at IS NULL
 ORDER BY deg DESC, n.updated_at DESC, n.id ASC
 LIMIT ?1`;

const EDGES_SQL = `
SELECT src, type, dst FROM edges WHERE deleted_at IS NULL LIMIT ?1`;

export interface GraphOptions {
  readonly nodeLimit?: number;
  readonly edgeLimit?: number;
}

export function buildGraph(db: ReadOnlyDb, opts: GraphOptions = {}): GraphPayload {
  const t0 = performance.now();
  const nodeLimit = opts.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const edgeLimit = opts.edgeLimit ?? DEFAULT_EDGE_LIMIT;
  if (!db.has("nodes") || !db.has("edges")) {
    return { ...EMPTY, limit: nodeLimit };
  }

  const totalNodes =
    db.one<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE deleted_at IS NULL")?.n ?? 0;
  const totalEdges =
    db.one<{ n: number }>("SELECT count(*) AS n FROM edges WHERE deleted_at IS NULL")?.n ?? 0;
  if (totalNodes === 0) {
    return { ...EMPTY, limit: nodeLimit, took_ms: Math.round(performance.now() - t0) };
  }

  const rows = db.all<NodeRow>(NODES_SQL, [nodeLimit]);
  const index = new Map<string, number>();
  const nodes: GraphNode[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    index.set(r.id, i);
    nodes[i] = {
      id: r.id,
      kind: r.kind,
      status: r.status,
      layer: r.layer,
      priority: r.priority,
      title: r.title,
      deg: r.deg,
      updated_at: r.updated_at,
    };
  }

  // Рёбра отдаём только между отданными узлами: висящий конец нечем рисовать.
  const edges: GraphEdge[] = [];
  for (const e of db.all<EdgeRow>(EDGES_SQL, [edgeLimit])) {
    const s = index.get(e.src);
    const d = index.get(e.dst);
    if (s === undefined || d === undefined) continue;
    edges.push({ s, d, t: e.type });
  }

  return {
    nodes,
    edges,
    total_nodes: totalNodes,
    total_edges: totalEdges,
    truncated: totalNodes > rows.length,
    limit: nodeLimit,
    took_ms: Math.round(performance.now() - t0),
  };
}
