// Векторный поиск по nodes_vec (sqlite-vec vec0). Схема таблицы — отдельный
// набор миграций packages/store-sqlite/src/migrations/vec-001-init.ts, этот
// модуль только запросы поверх готовой таблицы и не знает о рантайме.
//
// Две ступени точности (docs/design/02-retrieval-and-performance.md §2.2, §2.4):
//   1. KNN по int8[384] через vec0 с ОБЯЗАТЕЛЬНЫМ префильтром по partition key
//      (scope, layer) — пул из k' кандидатов;
//   2. переранжирование пула по float32-векторам из vec_nodes_f32 (обычная
//      BLOB-таблица, косинус в коде), срез до limit.
// int8-скан быстрый, но огрубляет (квантизация per-vector scale); на топе
// разница видна, поэтому финальный порядок считается по float32.
//
// РЕШЕНИЕ S27 (docs/design/ARCHITECTURE.md §10, замеры приложения К
// docs/design/01a-ddl-validation.md): запрос без фильтра по (scope, layer) —
// ОШИБКА, а не медленный путь (partition key без фильтра делает запрос в 4.5
// раза хуже его отсутствия: 29.95 мс против 6.62 мс на 100k). Поэтому фильтр
// здесь нельзя забыть и нельзя обойти: scopes — обязательное поле типа, пустой
// массив отвергается, диапазон слоёв всегда раскрывается в непустой IN-список,
// а SQL с MATCH строится только внутри этого модуля и всегда содержит оба
// условия по partition key.
//
// РЕШЕНИЕ S31 (ARCHITECTURE.md §10): эмбеддинг запроса стоит ~23 мс и не
// укладывается в бюджет поиска, поэтому вектор запроса приходит снаружи уже
// готовым. Этот модуль эмбеддер не вызывает — ни напрямую, ни косвенно.
//
// Отсутствие vec0 — не исключение (инвариант И2, S26): без расширения векторные
// миграции не применялись, nodes_vec нет, поиск возвращает пустую выдачу и
// состояние degraded с причиной. Молчать нельзя, падать тоже.
//
// Контракт выдачи {id, rank} — тот же, что у лексического поиска
// ./fts.ts (rank — целочисленная позиция, 1 = лучший): оба источника будет
// сливать RRF (myc-7yk), который комбинирует по рангам, а не по скорам.

import { defineQueries, historyClause, type DbDriver, type Layer } from "@myc/core";
import type { FtsCaller } from "./fts.ts";
import { notPendingClause } from "./review.ts";

export interface VectorSearchHit {
  readonly id: string;
  readonly rank: number;
  /** Косинусная дистанция (1 − cos), 0 = идентичны. Сырая величина, для машин. */
  readonly distance: number;
}

/**
 * Итог поиска: выдача плюс наблюдаемое состояние источника. `degraded` —
 * vec0 недоступен, `hits` пуст и `reason` объясняет причину; это не исключение.
 * `reranked` — выполнено ли float32-переранжирование (false, если таблица
 * vec_nodes_f32 ещё не заведена миграциями или rerank отключён).
 * `candidates` — размер пула после KNN и join, до среза до limit.
 *
 * `distanceMean`/`distanceStd` — среднее и стандартное отклонение дистанции
 * ПО ВСЕМУ ПУЛУ кандидатов (не только по выданным hits): нормировка «похоже
 * ли это на остальную выдачу этого запроса», а не на максимум в топе (myc-ye3.9).
 * undefined — пул меньше 3 кандидатов, статистика не имеет смысла.
 */
export interface VectorSearchOutcome {
  readonly hits: readonly VectorSearchHit[];
  readonly degraded: boolean;
  readonly reason?: string;
  readonly reranked: boolean;
  readonly candidates: number;
  readonly distanceMean?: number;
  readonly distanceStd?: number;
}

export interface VectorSearchParams {
  /** Готовый эмбеддинг запроса (S31: снаружи, ~23 мс на эмбеддинг не тратим). */
  readonly vector: Float32Array;
  /**
   * Готовый int8 для MATCH, если квантизацию выполнил владелец пайплайна.
   * Иначе квантизуем здесь — ровно по формуле packages/embed/src/quantize.ts.
   */
  readonly queryInt8?: Int8Array;
  /**
   * Обязательный непустой список скоупов — половина partition key. Пустой
   * массив — программная ошибка (S27: запрос без фильтра невыразим).
   */
  readonly scopes: readonly string[];
  /** Диапазон слоёв — вторая половина partition key; раскрывается в IN 0..3. */
  readonly layerMin?: Layer;
  readonly layerMax?: Layer;
  /** Личность вызывающего для ACL-фильтра — тот же контракт, что у fts. */
  readonly caller: FtsCaller;
  readonly limit?: number;
  /** k' — размер пула кандидатов до переранжирования (§2.2: топ-200). */
  readonly candidateLimit?: number;
  /** Отключить ступень 2 (переранжирование float32). По умолчанию включена. */
  readonly rerank?: boolean;
}

const EMBED_DIM = 384;
const F32_BLOB_BYTES = EMBED_DIM * 4;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
const DEFAULT_CANDIDATES = 200;
const MAX_CANDIDATES = 1000;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * Диапазон слоёв -> непустой список целых. Достаточно clampa внутрь 0..3:
 * Layer — это 0|1|2|3, поэтому любой диапазон сворачивается к конечному
 * IN-списку, и "пустого фильтра" не существует даже при layerMin > layerMax —
 * такой диапазон отвергается как программная ошибка.
 */
function expandLayers(layerMin: Layer | undefined, layerMax: Layer | undefined): number[] {
  const min = layerMin ?? 0;
  const max = layerMax ?? 3;
  if (min > max) {
    throw new TypeError(
      `vectorSearch: layerMin (${min}) > layerMax (${max}) — the layer filter cannot be empty (S27)`,
    );
  }
  const out: number[] = [];
  for (let l = Math.max(0, min); l <= Math.min(3, max); l++) out.push(l);
  return out;
}

/**
 * Квантизация запроса к int8 — дословно семантика
 * packages/embed/src/quantize.ts: q = round(127 × v / max|v|), 0-вектор
 * даёт scale = 1. Схема обязана совпадать с той, которой корпус вектора
 * пишутся в nodes_vec, иначе int8-косинус искажается.
 */
function quantizeQuery(vec: Float32Array): Buffer {
  if (vec.length !== EMBED_DIM) {
    throw new TypeError(
      `vectorSearch: expected a vector of length ${EMBED_DIM}, got ${vec.length}`,
    );
  }
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    if (!Number.isFinite(v)) {
      throw new TypeError(
        `vectorSearch: query vector component ${i} is not finite (${v})`,
      );
    }
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs : 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let r = Math.round((127 * vec[i]!) / scale);
    if (r > 127) r = 127;
    else if (r < -127) r = -127;
    q[i] = r;
  }
  return Buffer.from(q.buffer, q.byteOffset, q.byteLength);
}

export const vectorQueries = defineQueries({
  // KNN с префильтром по partition key через json_each (vec0 применяет
  // constraint на partition key и внутри подзапроса — проверено на 100k,
  // латентность равна литеральному IN, полный скан даёт ~30 мс, тут ~2 мс).
  // k — на КАЖДУЮ затронутую партицию: при P партициях vec0 вернёт до P×k
  // строк, глобальный порядок наводит внешний ORDER BY + LIMIT.
  // Живость и ACL — тот же предикат, что у ftsSearch: RRF сольёт оба
  // источника в одну выдачу, разные наборы видимости в неё попадать не должны.
  // Отсюда же фильтр кандидатов на подтверждение (./review.ts): он стоит до
  // LIMIT, иначе векторный пул отдавался бы кандидатам, а гидратация гибрида
  // выбросила бы их уже после отбора.
  vectorKnn: {
    name: "vectorKnn",
    sql: `
      WITH knn AS (
        SELECT node_rowid, distance
        FROM nodes_vec
        WHERE embedding MATCH vec_int8(?1)
          AND k = ?2
          AND scope IN (SELECT value FROM json_each(?3))
          AND layer IN (SELECT value FROM json_each(?4))
      )
      SELECT knn.distance AS distance, n.id AS id
      FROM knn
      JOIN nodes n ON n.rowid = knn.node_rowid
      WHERE n.deleted_at IS NULL
       ${historyClause("follow")}
        AND n.status <> 'superseded'
        AND (
          (n.acl = 'private' AND n.owner_id = ?5)
          OR (n.acl = 'team' AND n.team_id = ?6)
          OR (n.acl = 'agent' AND n.agent_id = ?7)
          OR (n.acl = 'restricted' AND EXISTS (
                SELECT 1 FROM acl_grants g
                WHERE g.node_id = n.id
                  AND g.principal IN (SELECT value FROM json_each(?8))
              ))
        )${notPendingClause("n")}
      ORDER BY knn.distance ASC
      LIMIT ?9
    `,
    params: [
      "vector",
      "k",
      "scopes",
      "layers",
      "owner_id",
      "team_id",
      "agent_id",
      "principals",
      "limit",
    ],
  },
  tableExists: {
    name: "tableExists",
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1`,
    params: ["name"],
  },
  f32ByNodeIds: {
    name: "f32ByNodeIds",
    sql: `
      SELECT node_id AS node_id, embedding_f32 AS embedding_f32
      FROM vec_nodes_f32
      WHERE node_id IN (SELECT value FROM json_each(?1))
    `,
    params: ["ids"],
  },
});

interface KnnRow {
  readonly distance: number;
  readonly id: string;
}

interface F32Row {
  readonly node_id: string;
  readonly embedding_f32: Uint8Array;
}

function degradedOutcome(reason: string): VectorSearchOutcome {
  return { hits: [], degraded: true, reason, reranked: false, candidates: 0 };
}

/**
 * Векторный поиск: int8-KNN по партиции (scope, layer) + float32-переранжирование.
 * Никогда не эмбеддит запрос (S31) и никогда не выполняет KNN без фильтра по
 * partition key (S27). vec0 отсутствует -> пустая выдача + degraded, без
 * исключений. Программные ошибки контракта (пустой scopes, не та размерность)
 * — громкие TypeError, их маскировать нельзя.
 */
export function vectorSearch(db: DbDriver, params: VectorSearchParams): VectorSearchOutcome {
  if (params.scopes.length === 0) {
    throw new TypeError(
      "vectorSearch: scopes is empty — a vector query without a (scope, layer) filter " +
        "is an error, not a slow path (S27)",
    );
  }
  const vector = params.vector;
  if (!(vector instanceof Float32Array)) {
    throw new TypeError(
      `vectorSearch: vector must be Float32Array[${EMBED_DIM}], got ${typeof vector}`,
    );
  }
  if (vector.length !== EMBED_DIM) {
    throw new TypeError(
      `vectorSearch: expected a vector of length ${EMBED_DIM}, got ${vector.length}`,
    );
  }
  if (params.queryInt8 !== undefined && params.queryInt8.length !== EMBED_DIM) {
    throw new TypeError(
      `vectorSearch: expected queryInt8 of length ${EMBED_DIM}, got ${params.queryInt8.length}`,
    );
  }
  // Контракт фильтра и квантизация проверяются ДО деградации: программная
  // ошибка обязана быть громкой независимо от доступности vec0.
  const layers = expandLayers(params.layerMin, params.layerMax);
  const int8Blob = params.queryInt8
    ? Buffer.from(params.queryInt8.buffer, params.queryInt8.byteOffset, params.queryInt8.byteLength)
    : quantizeQuery(vector);

  // S26: без vec0 векторные миграции не применялись — nodes_vec нет. Это
  // наблюдаемое на соединении состояние, оно же покрывает файл, записанный
  // другим процессом без модуля: ошибка "no such module: vec0" ниже.
  const hasVecTable =
    db.one<{ name: string }>(vectorQueries.tableExists, ["nodes_vec"]) !== undefined;
  if (!hasVecTable) {
    return degradedOutcome(
      "nodes_vec is missing — vec0 is not loaded in the runtime, vector migrations were not applied (S26)",
    );
  }

  const limit = clampLimit(params.limit);
  const k = Math.min(
    Math.max(limit, params.candidateLimit ?? DEFAULT_CANDIDATES, 1),
    MAX_CANDIDATES,
  );

  let knn: KnnRow[];
  try {
    knn = db.all<KnnRow>(vectorQueries.vectorKnn, [
      int8Blob,
      k,
      JSON.stringify([...params.scopes]),
      JSON.stringify(layers),
      params.caller.ownerId,
      params.caller.teamId,
      params.caller.agentId,
      JSON.stringify(params.caller.principals),
      k,
    ]);
  } catch (error) {
    const message = String((error as Error).message);
    if (message.includes("no such module: vec0")) {
      return degradedOutcome(
        `nodes_vec exists, but the vec0 module is not loaded on this connection: ${message}`,
      );
    }
    throw error;
  }

  if (knn.length === 0) {
    return { hits: [], degraded: false, reranked: false, candidates: 0 };
  }

  let reranked = false;
  let candidates = knn;

  const wantRerank = params.rerank !== false;
  const hasF32Table =
    wantRerank &&
    db.one<{ name: string }>(vectorQueries.tableExists, ["vec_nodes_f32"]) !== undefined;

  if (wantRerank && hasF32Table) {
    // Пул после подмены: у покрытых f32 — точный косинус, у остальных —
    // int8-дистанс vec0 (1 - cos), шкалы сравнимы. Это лучшая доступная
    // оценка для строк, которые embed-воркер ещё не дотянул до f32.
    const byId = new Map<string, number>();
    for (const row of knn) byId.set(row.id, row.distance);

    const f32Rows = db.all<F32Row>(vectorQueries.f32ByNodeIds, [
      JSON.stringify(knn.map((r) => r.id)),
    ]);
    for (const row of f32Rows) {
      const blob = row.embedding_f32;
      if (blob.byteLength !== F32_BLOB_BYTES) continue; // чужая размерность — строка протухла
      if (blob.byteOffset % 4 !== 0) continue; // невыровненный буфер нельзя трактовать как float32
      const f32 = new Float32Array(blob.buffer, blob.byteOffset, EMBED_DIM);
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < EMBED_DIM; i++) {
        dot += vector[i]! * f32[i]!;
        na += vector[i]! * vector[i]!;
        nb += f32[i]! * f32[i]!;
      }
      const cos = na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
      byId.set(row.node_id, 1 - cos);
      reranked = true;
    }

    candidates = [...byId].map(([id, distance]) => ({ id, distance }));
    candidates.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  }

  const hits: VectorSearchHit[] = [];
  for (let i = 0; i < candidates.length && hits.length < limit; i++) {
    const c = candidates[i]!;
    hits.push({ id: c.id, rank: hits.length + 1, distance: c.distance });
  }

  // Статистика по ВСЕМУ пулу (до среза до limit), не по выданным hits: иначе
  // самый близкий кандидат неизбежно оказался бы «на много сигм лучше среднего
  // топ-limit», и цифра снова стала бы функцией размера limit, а не запроса.
  let distanceMean: number | undefined;
  let distanceStd: number | undefined;
  if (candidates.length >= 3) {
    const ds = candidates.map((c) => c.distance);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const variance = ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length;
    distanceMean = mean;
    distanceStd = Math.sqrt(variance);
  }

  return {
    hits,
    degraded: false,
    reranked,
    candidates: knn.length,
    ...(distanceMean !== undefined ? { distanceMean, distanceStd } : {}),
  };
}
