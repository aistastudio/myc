/**
 * ОБМЕН С СЕРВЕРОМ: ОДИН ПРОТОКОЛ, ОБЕ СТОРОНЫ (§9.5, §3.17).
 *
 * Клиент шлёт то, чего у сервера нет, и говорит, что у него уже есть; сервер
 * применяет присланное и отвечает тем, чего нет у клиента. Инициатор всегда
 * клиент: сервер — такой же сайт, а не источник истины, и ничего никому не
 * навязывает.
 *
 * `have` — РАЗРЕЖЕННЫЙ ВЕКТОР ВЫСОКИХ ВОД ПО САЙТАМ, а не векторные часы. Он
 * отвечает ровно на один вопрос — «что мне ещё прислать», — и не участвует в
 * упорядочивании: порядок задают сами часы операции. Отсюда и главное
 * свойство: сайт, которого в `have` нет, считается неизвестным пиру, и его
 * операции едут целиком. Умолчание «нет записи ⇒ ничего не слал» безопасно,
 * «нет записи ⇒ всё видел» потеряло бы историю молча.
 *
 * ПОРЯДОК ВЫДАЧИ — (hlc, site_id), тот же тотальный порядок, что у
 * `compareClock`. Колонки в ORDER BY НАЗВАНЫ С ТАБЛИЦЕЙ, и это не стиль:
 * в выборке есть `CAST(hlc AS TEXT) AS hlc`, и голое `ORDER BY hlc`
 * разрешается в ПСЕВДОНИМ — сортировку строк, где 13107200 меньше 6553600.
 * Пакет тогда уезжает в произвольном порядке, докачка не сходится, а
 * выглядит это как «иногда не доезжает». Это не украшение: пакет ограничен сверху (1000 операций и
 * 4 МБ), и клиент повторяет вызов, подняв свои воды. Порядок по seq (по
 * локальной нумерации хранилища) сошёлся бы у сервера и клиента в разное, и
 * докачка перестала бы сходиться.
 *
 * ПАКЕТ ПРИМЕНЯЕТСЯ ЦЕЛИКОМ ИЛИ НИКАК. Поэтому `accepted` — это все op_id
 * пакета, когда транзакция закоммитилась: отложенное (операция приехала
 * раньше своего узла) durable лежит в `oplog_pending` и будет применено, как
 * только приедет недостающее, — пиру его слать больше не нужно.
 */

import { defineQueries, toPgDialect, type QueryDef } from "./sql.ts";
import { all, one, run, type Eff } from "./effect.ts";
import {
  compareClock,
  packHlc,
  unpackHlc,
  type Hlc,
  type Op,
  type JsonValue,
  type SetOp,
  type IncOp,
  type EdgeAddOp,
  type EdgeDelOp,
} from "./oplog.ts";
import { readHlc, parseEdgeEntityId, MEMORY_EDGE_SEPARATOR } from "./apply.ts";
import { GraphError } from "./graph.ts";

/** Потолок одного пакета (§9.5). Больше — клиент повторяет с `more: true`. */
export const SYNC_MAX_OPS = 1000;
export const SYNC_MAX_BYTES = 4 * 1024 * 1024;

/** Строка оплога — то, что читается из базы и превращается в операцию. */
export interface OplogRow {
  readonly seq: number;
  readonly op_id: string;
  readonly site_id: string;
  /** CAST(hlc AS TEXT): точное 64-битное значение, см. readHlc. */
  readonly hlc: string;
  readonly ts_ms: number;
  readonly actor: string;
  readonly op: string;
  readonly entity: string;
  readonly entity_id: string;
  readonly field: string | null;
  readonly value: string | null;
  readonly scope: string;
  readonly origin: number;
}

/**
 * Строка оплога обратно в операцию — вход слияния и обмена.
 *
 * `seq` берётся из хвоста op_id, а не из колонки `seq`: колонка нумерует
 * строки ЭТОГО хранилища, а операции нужен её номер на сайте-источнике —
 * иначе у реплики та же операция получила бы другой seq и перестала быть
 * той же самой.
 */
export function rowToOp(row: OplogRow): Op {
  const hlc = readHlc(row.hlc);
  const seq = Number(row.op_id.slice(row.site_id.length + 1));
  const value = row.value === null ? null : (JSON.parse(row.value) as JsonValue);
  const entityId =
    row.entity === "edge"
      ? (() => {
          const e = parseEdgeEntityId(row.entity_id);
          return [e.src, e.type, e.dst].join(MEMORY_EDGE_SEPARATOR);
        })()
      : row.entity_id;
  const base = {
    op_id: row.op_id,
    seq: Number.isFinite(seq) ? seq : 0,
    hlc,
    site_id: row.site_id,
    entity_id: entityId,
    field: row.field ?? "",
  };

  switch (row.op) {
    case "set":
      return { ...base, op: "set", value } as SetOp;
    case "inc":
      return { ...base, op: "inc", value: Number(value) } as IncOp;
    case "edge_add":
      return { ...base, op: "edge_add", value: value as { tag: string; weight?: number } } as EdgeAddOp;
    case "edge_del":
      return { ...base, op: "edge_del", value: value as { tags: string[] } } as EdgeDelOp;
    default:
      throw new GraphError(
        "graph.unknown_field",
        `operation '${row.op}' does not project into an Op: claim and purge are separate tasks`,
      );
  }
}

// ---------------------------------------------------------------------------
// Форма обмена
// ---------------------------------------------------------------------------

/** Высокие воды по сайтам. Значение — упакованный hlc десятичной строкой. */
export type Watermarks = Readonly<Record<string, string>>;

export interface SyncRequest {
  /** Сайт клиента. Нужен для `sync_state`, но правами не является. */
  readonly site_id: string;
  readonly have: Watermarks;
  readonly ops: readonly Op[];
  /**
   * Прислать ли встречные операции. `false` — это `--push-only`, и он поле
   * протокола, а не выдумка клиента: «ничего мне не шли» иначе пришлось бы
   * изображать поддельными водами, а поддельные воды — это ложь о том, что
   * ты уже видел, и она пережила бы сам вызов, осев в `sync_state` пира.
   */
  readonly want?: boolean;
  /**
   * Примерка: ничего не применять, ничего не записывать, только сосчитать.
   * Тоже поле протокола — «сухой» прогон, который меняет состояние пира,
   * сухим не является.
   */
  readonly dry?: boolean;
}

export interface SyncAnswer {
  /** Сайт отвечающего: пир записывает по нему состояние обмена. */
  readonly site_id: string;
  readonly accepted: readonly string[];
  readonly ops: readonly Op[];
  readonly watermarks: Watermarks;
  /** true ⇒ у отвечающего осталось ещё: повтори вызов с поднятыми водами. */
  readonly more: boolean;
}

/** Воды из набора операций — то, чем клиент поднимает свой `have` после приёма. */
export function watermarksOf(ops: readonly Op[], base: Watermarks = {}): Watermarks {
  const out: Record<string, string> = { ...base };
  for (const op of ops) {
    const packed = packHlc(op.hlc);
    const seen = out[op.site_id];
    if (seen === undefined || BigInt(seen) < packed) out[op.site_id] = packed.toString();
  }
  return out;
}

/** Разбор присланных вод: чужие данные, поэтому каждая проверяется. */
export function parseWatermarks(raw: unknown): Watermarks | undefined {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [site, value] of Object.entries(raw as Record<string, unknown>)) {
    if (site === "" || site.length > 64) return undefined;
    let packed: bigint;
    try {
      packed = typeof value === "string" || typeof value === "number" ? BigInt(value) : -1n;
    } catch {
      return undefined;
    }
    if (packed < 0n) return undefined;
    out[site] = packed.toString();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Запросы
// ---------------------------------------------------------------------------

const OPLOG_COLUMNS = `seq, op_id, site_id, CAST(hlc AS TEXT) AS hlc, ts_ms, actor,
                 op, entity, entity_id, field, value, scope, origin`;

export const syncQueries = defineQueries({
  /** Наши воды: по операции с наибольшими часами на каждый сайт. */
  sync_watermarks: {
    name: "sync_watermarks",
    sql: `SELECT site_id, CAST(max(hlc) AS TEXT) AS hlc
            FROM oplog WHERE scope = ?1 GROUP BY site_id`,
    params: ["scope"],
  },
  sync_state_get: {
    name: "sync_state_get",
    sql: `SELECT peer_site_id, CAST(last_hlc_seen AS TEXT) AS last_hlc_seen,
                 last_seq_sent, last_sync_at, endpoint
            FROM sync_state WHERE peer_site_id = ?1`,
    params: ["peer_site_id"],
  },
  sync_state_all: {
    name: "sync_state_all",
    sql: `SELECT peer_site_id, CAST(last_hlc_seen AS TEXT) AS last_hlc_seen,
                 last_seq_sent, last_sync_at, endpoint
            FROM sync_state ORDER BY peer_site_id`,
    params: [],
  },
  /**
   * Запись о пире. `last_hlc_seen` не откатывается назад: пакеты приходят
   * параллельно и не по порядку, и «забыть» уже принятое значило бы прислать
   * его ещё раз — лишний трафик там, где дедупликация и так по op_id, но и
   * бесконечный цикл там, где пир считает воды по нашему ответу.
   */
  sync_state_put: {
    name: "sync_state_put",
    sql: `INSERT INTO sync_state (peer_site_id, last_hlc_seen, last_seq_sent, last_sync_at, endpoint)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(peer_site_id) DO UPDATE SET
            last_hlc_seen = max(sync_state.last_hlc_seen, excluded.last_hlc_seen),
            last_seq_sent = max(sync_state.last_seq_sent, excluded.last_seq_sent),
            last_sync_at  = excluded.last_sync_at,
            endpoint      = excluded.endpoint`,
    params: ["peer_site_id", "last_hlc_seen", "last_seq_sent", "last_sync_at", "endpoint"],
    // Двухаргументный max у Postgres — greatest (§8.3 расхождений).
    pg: toPgDialect(
      `INSERT INTO sync_state (peer_site_id, last_hlc_seen, last_seq_sent, last_sync_at, endpoint)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(peer_site_id) DO UPDATE SET
            last_hlc_seen = greatest(sync_state.last_hlc_seen, excluded.last_hlc_seen),
            last_seq_sent = greatest(sync_state.last_seq_sent, excluded.last_seq_sent),
            last_sync_at  = excluded.last_sync_at,
            endpoint      = excluded.endpoint`,
    ),
  },
});

/**
 * Запрос «операции, которых у пира нет», построенный под РАЗМЕР его вектора
 * вод. Текст зависит от числа известных пиру сайтов, поэтому строится, а не
 * лежит в реестре готовым, — как варианты охвата репозитория и ACL. Каждый
 * построенный текст проходит ту же проверку нумерации плейсхолдеров:
 * `defineQueries` считает их и ловит несоответствие списку параметров.
 *
 * Сайтов на воркспейс — единицы (по одному на машину или клон), поэтому
 * кеш по арности покрывает всё, что бывает, одной-двумя записями.
 */
const peerSqlCache = new Map<number, QueryDef>();

export function opsForPeerQuery(siteCount: number): QueryDef {
  const cached = peerSqlCache.get(siteCount);
  if (cached !== undefined) return cached;

  const params = ["scope"];
  const terms: string[] = [];
  const known: string[] = [];
  for (let i = 0; i < siteCount; i++) {
    const site = 2 + i * 2;
    const hlc = site + 1;
    params.push(`site_${i}`, `hlc_${i}`);
    terms.push(`site_id = ?${site} AND hlc > ?${hlc}`);
    known.push(`?${site}`);
  }
  const limit = 2 + siteCount * 2;
  params.push("limit");
  // Сайт, которого в `have` нет, пир не видел вовсе — его операции едут все.
  const where =
    siteCount === 0
      ? ""
      : `\n   AND (${terms.map((t) => `(${t})`).join("\n     OR ")}\n     OR site_id NOT IN (${known.join(", ")}))`;
  const name = `sync_ops_for_peer_${siteCount}`;
  const built = defineQueries({
    [name]: {
      name,
      sql: `SELECT ${OPLOG_COLUMNS}
            FROM oplog
           WHERE scope = ?1${where}
           ORDER BY oplog.hlc, oplog.site_id
           LIMIT ?${limit}`,
      params,
    },
  });
  peerSqlCache.set(siteCount, built[name]!);
  return built[name]!;
}

// ---------------------------------------------------------------------------
// Чтение и приём
// ---------------------------------------------------------------------------

export interface Batch {
  readonly ops: readonly Op[];
  readonly more: boolean;
}

/**
 * Операции воркспейса, которых нет у пира, — не больше потолка пакета.
 *
 * Потолок по БАЙТАМ считается по фактическому JSON, а не по числу операций:
 * одно тело заметки бывает больше сотни `set`-ов статуса, и пакет из тысячи
 * таких не пролез бы в 4 МБ. Первая операция кладётся всегда, даже если она
 * одна больше потолка: иначе обмен встал бы навсегда на одной записи.
 */
export function* collectForPeer(
  scope: string,
  have: Watermarks,
  maxOps: number = SYNC_MAX_OPS,
  maxBytes: number = SYNC_MAX_BYTES,
): Eff<Batch> {
  const sites = Object.keys(have).sort();
  const q = opsForPeerQuery(sites.length);
  const args: unknown[] = [scope];
  for (const site of sites) args.push(site, BigInt(have[site]!));
  // Берём на одну больше потолка: лишняя строка и есть ответ на вопрос «есть ли ещё».
  args.push(maxOps + 1);
  const rows = yield* all<OplogRow>(q, args);

  const ops: Op[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, maxOps)) {
    const op = rowToOp(row);
    const size = JSON.stringify(op).length;
    if (ops.length > 0 && bytes + size > maxBytes) {
      return { ops, more: true };
    }
    ops.push(op);
    bytes += size;
  }
  return { ops, more: rows.length > maxOps };
}

/** Наши воды по воркспейсу — то, что уходит пиру в ответе. */
export function* localWatermarks(scope: string): Eff<Watermarks> {
  const rows = yield* all<{ site_id: string; hlc: string | null }>(syncQueries.sync_watermarks, [
    scope,
  ]);
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.hlc !== null) out[row.site_id] = BigInt(row.hlc).toString();
  }
  return out;
}

export interface PeerState {
  readonly peer_site_id: string;
  readonly last_hlc_seen: string;
  readonly last_seq_sent: number;
  readonly last_sync_at: number;
  readonly endpoint: string;
}

export function* readPeer(peer: string): Eff<PeerState | undefined> {
  const row = yield* one<PeerState>(syncQueries.sync_state_get, [peer]);
  return row;
}

export function* recordPeer(
  peer: string,
  seen: Watermarks,
  sentSeq: number,
  now: number,
  endpoint = "",
): Eff<void> {
  // Высшая вода принятого от пира — максимум по всему, что он о себе сказал:
  // его собственный сайт плюс всё, что он уже видел от остальных.
  let top = 0n;
  for (const value of Object.values(seen)) {
    const packed = BigInt(value);
    if (packed > top) top = packed;
  }
  yield* run(syncQueries.sync_state_put, [peer, top, sentSeq, now, endpoint]);
}

/** Порядок применения — тот же тотальный порядок, что у слияния. */
export function sortOps(ops: readonly Op[]): Op[] {
  return [...ops].sort((a, b) => compareClock(a.hlc, a.site_id, b.hlc, b.site_id));
}

/** Разбор присланной операции: всё, что пришло по сети, проверяется. */
export function parseOp(raw: unknown): Op | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r["op"];
  if (kind !== "set" && kind !== "inc" && kind !== "edge_add" && kind !== "edge_del") {
    return undefined;
  }
  const opId = r["op_id"];
  const siteId = r["site_id"];
  const entityId = r["entity_id"];
  const field = r["field"];
  if (typeof opId !== "string" || opId === "") return undefined;
  if (typeof siteId !== "string" || siteId === "") return undefined;
  if (typeof entityId !== "string" || entityId === "") return undefined;
  if (typeof field !== "string") return undefined;
  const hlcRaw = r["hlc"];
  if (typeof hlcRaw !== "object" || hlcRaw === null) return undefined;
  const { ts, ctr } = hlcRaw as Record<string, unknown>;
  if (typeof ts !== "number" || typeof ctr !== "number") return undefined;
  if (!Number.isInteger(ts) || !Number.isInteger(ctr) || ts < 0 || ctr < 0) return undefined;
  const hlc: Hlc = { ts, ctr };
  // op_id детерминирован от (site_id, seq) — подделать пару нельзя молча:
  // расхождение означает, что ключ идемпотентности не тот, за кого себя выдаёт.
  const seq = Number(r["seq"]);
  if (!Number.isInteger(seq) || seq < 0) return undefined;
  if (opId !== `${siteId}:${seq}`) return undefined;
  const base = { op_id: opId, seq, hlc, site_id: siteId, entity_id: entityId, field };
  const value = r["value"];
  switch (kind) {
    case "set":
      return { ...base, op: "set", value: value as JsonValue };
    case "inc":
      return typeof value === "number" ? { ...base, op: "inc", value } : undefined;
    case "edge_add": {
      const v = value as Record<string, unknown> | null;
      if (typeof v !== "object" || v === null || typeof v["tag"] !== "string") return undefined;
      const weight = v["weight"];
      return {
        ...base,
        op: "edge_add",
        value: typeof weight === "number" ? { tag: v["tag"], weight } : { tag: v["tag"] },
      };
    }
    case "edge_del": {
      const v = value as Record<string, unknown> | null;
      const tags = v?.["tags"];
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) return undefined;
      return { ...base, op: "edge_del", value: { tags: tags as string[] } };
    }
  }
}

/** Часы из упакованной строки — для показа и сравнения вод. */
export function unpackWatermark(value: string): Hlc {
  return unpackHlc(BigInt(value));
}
