/**
 * ДАННЫЕ ВОРКСПЕЙСА ПО HTTP (§8.1, задача memory-bjy6fq9kxj47).
 *
 * Воркспейс стоит В ПУТИ — `/v1/ws/:ws/…`, — а не в теле и не в заголовке:
 * так он виден в журнале прокси, кешируется отдельно и не теряется при
 * копировании ссылки. Внутри он и есть `scope` узла (решение S17,
 * memory-khj49brcr0q7: арендатор — единица сервера, воркспейс — проект
 * внутри него).
 *
 * ДВЕ ГРАНИЦЫ, А НЕ ОДНА. Арендатора закрывает RLS: сессия без
 * `SET LOCAL myc.tenant` не видит ни строки, и обойти это приложение не
 * может. Воркспейс закрывает `scope = ?` в каждом запросе — обычный фильтр,
 * который приложение как раз может забыть. Поэтому запросы собраны РЕЕСТРОМ:
 * забыть фильтр в реестре заметнее, чем в теле обработчика, и паритет гоняет
 * их наравне с остальными (packages/cli/src/parity.pg.test.ts).
 *
 * Только чтение. Запись через сервер — отдельное решение (у Postgres нет
 * асинхронного двойника GraphStore, а CRDT-логика живёт в синхронном классе),
 * и пока её нет, сервер честно отвечает на запись кодом, а не молчанием.
 */

import { aclClause, aclParams, defineQueries, type JsonValue, type Viewer } from "@myc/core";
import type { PostgresDriver } from "@myc/store-postgres";

/** Сколько узлов отдаём за раз, если не попросили иначе, и потолок просьбы. */
export const WS_LIMIT_DEFAULT = 50;
export const WS_LIMIT_MAX = 500;

/**
 * Хвост ACL и его параметры. Сервер ВСЕГДА знает смотрящего, поэтому у
 * серверных запросов вариант один — с предикатом; отдельного «без ACL» здесь
 * нет и быть не должно, иначе однажды позовут не тот.
 */
const ACL = (alias: string, first: number): string => aclClause(alias, first);

export const wsQueries = defineQueries({
  // Список узлов воркспейса. Фильтры необязательные: пустая строка значит
  // «любой» — так один текст обслуживает все сочетания, и план у него один
  // (иначе реестр распухает на каждую ось фильтрации).
  ws_nodes_list: {
    name: "ws_nodes_list",
    sql: `SELECT id, kind, layer, scope, title, excerpt, status, priority,
                 assignee, created_at, updated_at
            FROM nodes
           WHERE scope = ?1
             AND deleted_at IS NULL
             AND (?2 = '' OR kind = ?2)
             AND (?3 = '' OR status = ?3)
             AND (?4 = 0 OR updated_at >= ?4)${ACL("nodes", 7)}
           ORDER BY updated_at DESC, id ASC
           LIMIT ?5 OFFSET ?6`,
    params: ["scope", "kind", "status", "since", "limit", "offset", "owner", "team", "agent"],
  },
  // СЧЁТЧИК ВИДИТ ТО ЖЕ, ЧТО И СПИСОК. «Всего 12» при трёх видимых — утечка
  // через число: по нему узнают, что чужое есть, и сколько его.
  ws_nodes_count: {
    name: "ws_nodes_count",
    sql: `SELECT count(*) AS n
            FROM nodes
           WHERE scope = ?1
             AND deleted_at IS NULL
             AND (?2 = '' OR kind = ?2)
             AND (?3 = '' OR status = ?3)
             AND (?4 = 0 OR updated_at >= ?4)${ACL("nodes", 5)}`,
    params: ["scope", "kind", "status", "since", "owner", "team", "agent"],
  },
  // Узел по id — ОБЯЗАТЕЛЬНО с фильтром воркспейса: без него сосед по
  // арендатору читал бы чужой проект, зная один лишь идентификатор.
  ws_node_get: {
    name: "ws_node_get",
    sql: `SELECT id, kind, layer, scope, title, body, excerpt, status, priority,
                 assignee, actor, acl, attrs, created_at, updated_at, closed_at
            FROM nodes
           WHERE scope = ?1 AND id = ?2 AND deleted_at IS NULL${ACL("nodes", 3)}`,
    params: ["scope", "id", "owner", "team", "agent"],
  },
  // Рёбра узла в обе стороны — чем он блокирует и чем блокируется.
  ws_node_edges: {
    name: "ws_node_edges",
    sql: `SELECT e.src AS src, e.type AS type, e.dst AS dst
            FROM edges e
            JOIN nodes s ON s.id = e.src
            JOIN nodes d ON d.id = e.dst
           WHERE (e.src = ?2 OR e.dst = ?2)
             AND e.deleted_at IS NULL
             AND s.scope = ?1 AND d.scope = ?1
           ORDER BY e.src, e.type, e.dst`,
    params: ["scope", "id"],
  },
  // Какие воркспейсы вообще есть у арендатора — ответ на /v1/ws.
  ws_list: {
    name: "ws_list",
    sql: `SELECT scope AS ws, count(*) AS nodes, max(updated_at) AS updated_at
            FROM nodes
           WHERE deleted_at IS NULL AND scope <> ''${ACL("nodes", 1)}
           GROUP BY scope
           ORDER BY scope`,
    params: ["owner", "team", "agent"],
  },
});

/** Разбор `/v1/ws/:ws/<хвост>`; `null` — путь не про воркспейс. */
export function parseWsPath(pathname: string): { ws: string; rest: string } | null {
  const m = /^\/v1\/ws\/([^/]+)(\/.*)?$/.exec(pathname);
  if (m === null) return null;
  return { ws: decodeURIComponent(m[1]!), rest: m[2] ?? "" };
}

/** Число из строки запроса с потолком и умолчанием — чужой ?limit=1e9 не пройдёт. */
export function boundedInt(raw: string | null, def: number, max: number): number {
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.floor(n), max);
}

export interface WsNodeRow {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly title: string;
  readonly status: string;
  readonly [k: string]: JsonValue | undefined;
}

export interface WsListEntry {
  readonly ws: string;
  readonly nodes: number;
  readonly updated_at: number;
}

/**
 * Строка узла для HTTP. `attrs` в ответ уходит ОБЪЕКТОМ, а не строкой: драйвер
 * Postgres приводит jsonb к тексту ради паритета с SQLite (там колонка TEXT),
 * но это подробность хранения, и в конверте она означала бы, что клиент обязан
 * разбирать JSON внутри JSON. CLI отдаёт объект — сервер отдаёт то же самое.
 */
export function renderNode(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row["attrs"];
  if (typeof raw !== "string") return row;
  try {
    return { ...row, attrs: JSON.parse(raw) as unknown };
  } catch {
    // Неразбираемое значение лучше отдать как есть, чем уронить ответ: это
    // повод чинить данные, а не прятать их от того, кто их увидит.
    return row;
  }
}

/** Воркспейсы арендатора: считаются ПОД ним, то есть через ту же RLS. */
export async function wsList(
  pg: PostgresDriver,
  tenant: string,
  viewer: Viewer,
): Promise<WsListEntry[]> {
  const rows = await pg.withTenant(tenant, async (tx) =>
    tx.all<Record<string, unknown>>(wsQueries.ws_list, aclParams(viewer)),
  );
  return rows.map((r) => ({
    ws: String(r["ws"] ?? ""),
    nodes: Number(r["nodes"] ?? 0),
    updated_at: Number(r["updated_at"] ?? 0),
  }));
}
