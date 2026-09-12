/**
 * `myc absorb` — фоновая ступень A классификации памяти (§6.1–6.2).
 *
 *   myc absorb [<id>] [--limit N] [--dry-run] [--no-embed] [--embed-timeout <мс>]
 *
 * Разбирает очередь jobs(kind='absorb'), которую наполняет `myc remember`,
 * либо один явно названный узел. Для каждого узла:
 *
 *   1. текст узла (то же правило, что у scripts/reindex-vectors.ts);
 *   2. вектор: из nodes_vec (int8; косинус инвариантен к масштабу, ошибка
 *      против f32 по замеру ≤ 0.0003), иначе считается эмбеддером и кладётся
 *      в nodes_vec — работа embed для этого узла тем самым закрыта;
 *   3. кандидаты: kNN top-24 по вектору в (scope, layer 1..3) + FTS top-24
 *      по самым длинным словам текста; только тот же kind, только живые головы;
 *   4. вердикт — classifyAbsorb из @myc/core (детерминированно, $0);
 *   5. действия по классу (§6.2) через GraphStore — всё уходит в оплог:
 *        duplicate      duplicates: dup → canonical, canonical.seen_count++,
 *                       dup.status='superseded', dup.head_id=canonical
 *        update         supersedes: new → old, old и вся его цепочка получают
 *                       head_id=new, рёбра touches/mentions копируются на new
 *        contradiction  contradicts: new → old (одно ребро, читается
 *                       симметрично), confidence обоих × 0.7
 *        related        relates: new → target, weight = cos
 *        new            ничего
 *   6. в строку узла пишется attrs.absorb {class, target, cos, jac, quality,
 *      reason, at, by:'stage-a'}, а при работе без векторов — ещё и
 *      attrs.degraded_at.
 *
 * И1. Это НЕ горячий путь: запись (`remember`) уже прошла за свои 5 мс и
 * поставила работу в очередь. Здесь можно грузить ONNX и ходить в vec0.
 *
 * И2. ДЕГРАДАЦИЯ ГРОМКАЯ. Нет vec0, нет модели, эмбеддер не прогрелся —
 * кандидаты НЕ сливаются и НЕ выбрасываются: точный хеш по-прежнему даёт
 * duplicate, всё остальное в поясе похожести становится related, а узел
 * получает quality='lexical' и degraded_at, компонент absorb в myc_health
 * переходит в degraded, команда печатает WARN и meta.degraded[]. Никакого
 * «косинуса по TF-IDF» вместо векторов здесь нет — это ловушка memora.
 *
 * Эмбеддер подключается динамическим импортом @myc/embed только когда он
 * действительно нужен (нет вектора у узла), — ровно как в retrieve.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  NODE_STATUSES,
  absorbThresholdsFromToml,
  canonicalOf,
  classifyAbsorb,
  defineQueries,
  DEFAULT_ABSORB_THRESHOLDS,
  collectVersions,
  historyClause,
  supersessionPlan,
  VersionGraph,
  versionSourceOf,
  type AbsorbClass,
  type AbsorbText,
  type AbsorbThresholds,
  type AbsorbVerdict,
  type EdgeKind,
  type JsonValue,
  type NodeKind,
  type NodeRecord,
} from "@myc/core";
import {
  checkFingerprint,
  formatEmbedFingerprint,
  FingerprintMismatchError,
  type EmbedFingerprint,
} from "@myc/embed/fingerprint";
import { isAwaitingReview, isPendingReview, liveStatusPredicate, notPendingClause } from "@myc/retrieval/review";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext } from "../registry.ts";
import {
  flagBool,
  flagNum,
  graphFailure,
  realStoreDeps,
  resolveId,
  VECTOR_OPEN,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const KNN_LIMIT = 24;
const FTS_LIMIT = 24;
const FTS_WORDS = 12;
const EMBED_DIM = 384;
const DEFAULT_LIMIT = 50;
const LEASE_MS = 60_000;
const JOB_KIND = "absorb";

const Q = defineQueries({
  jobs_pull: {
    name: "jobs_pull",
    sql: `SELECT id, entity_id FROM jobs
           WHERE kind = ?1 AND entity_id IS NOT NULL
             AND run_after <= ?2 AND lease_expires < ?2 AND attempts < max_attempts
           ORDER BY priority, id LIMIT ?3`,
    params: ["kind", "now", "limit"],
  },
  job_lease: {
    name: "job_lease",
    sql: `UPDATE jobs SET lease_holder = ?1, lease_expires = ?2, attempts = attempts + 1
           WHERE id = ?3 AND lease_expires < ?4`,
    params: ["holder", "expires", "id", "now"],
  },
  job_done: {
    name: "job_done",
    sql: `DELETE FROM jobs WHERE id = ?1 AND lease_holder = ?2`,
    params: ["id", "holder"],
  },
  job_done_by_entity: {
    name: "job_done_by_entity",
    sql: `DELETE FROM jobs WHERE kind = ?1 AND entity_id = ?2`,
    params: ["kind", "entity_id"],
  },
  job_fail: {
    name: "job_fail",
    sql: `UPDATE jobs SET last_error = ?1, lease_holder = '', lease_expires = 0,
                          run_after = ?2
           WHERE id = ?3`,
    params: ["error", "run_after", "id"],
  },
  node_rowid: {
    name: "node_rowid",
    sql: `SELECT rowid AS rowid FROM nodes WHERE id = ?1`,
    params: ["id"],
  },
  vec_by_rowid: {
    name: "vec_by_rowid",
    sql: `SELECT embedding AS embedding FROM nodes_vec WHERE node_rowid = ?1`,
    params: ["rowid"],
  },
  vec_by_rowids: {
    name: "vec_by_rowids",
    sql: `SELECT node_rowid AS rowid, embedding AS embedding FROM nodes_vec
           WHERE node_rowid IN (SELECT value FROM json_each(?1))`,
    params: ["rowids"],
  },
  vec_delete: {
    name: "vec_delete",
    sql: `DELETE FROM nodes_vec WHERE node_rowid = ?1`,
    params: ["rowid"],
  },
  vec_insert: {
    name: "vec_insert",
    sql: `INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding)
           VALUES (?1, ?2, ?3, ?4, 1, vec_int8(?5))`,
    params: ["rowid", "scope", "layer", "kind", "embedding"],
  },
  // k — на каждую партицию (scope, layer); внешний LIMIT наводит общий порядок.
  //
  // КАНДИДАТ ХУКА СЖАТИЯ (`attrs.state = 'pending_review'`, §6.2) целью
  // классификации не бывает. Иначе класс duplicate сделал бы его каноническим
  // (он старше) и увёл бы в него новую, явно записанную заметку — status
  // superseded, head_id на кандидата, — а кандидат из выдачи исключён: факт
  // пропал бы из recall и prime целиком. Явная заметка остаётся
  // самостоятельной, кандидат ждёт разбора.
  // ОТОЗВАННАЯ ЗАМЕТКА (и отклонённый кандидат) — тоже не цель, по той же
  // причине: дубль уехал бы в неё `superseded`, а её саму выдача не отдаёт
  // (HIDDEN_STATUSES, @myc/retrieval review.ts) — явно записанное заново
  // пропало бы вместе с отозванным.
  knn: {
    name: "knn",
    sql: `WITH knn AS (
            SELECT node_rowid, distance FROM nodes_vec
             WHERE embedding MATCH vec_int8(?1) AND k = ?2
               AND scope = ?3 AND layer IN (1, 2, 3)
          )
          SELECT n.id AS id FROM knn JOIN nodes n ON n.rowid = knn.node_rowid
           WHERE n.id <> ?4 AND n.kind = ?5
             AND n.deleted_at IS NULL${historyClause("follow")} AND ${liveStatusPredicate("n")}${notPendingClause("n")}
           ORDER BY knn.distance ASC LIMIT ?2`,
    params: ["vector", "k", "scope", "self", "kind"],
  },
  fts: {
    name: "fts",
    sql: `SELECT n.id AS id FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
           WHERE nodes_fts MATCH ?1
             AND n.scope = ?2 AND n.id <> ?3 AND n.kind = ?4
             AND n.deleted_at IS NULL${historyClause("follow")} AND ${liveStatusPredicate("n")}${notPendingClause("n")}
           ORDER BY bm25(nodes_fts) LIMIT ?5`,
    params: ["match", "scope", "self", "kind", "limit"],
  },
  nodes_by_ids: {
    name: "nodes_by_ids",
    sql: `SELECT rowid AS rowid, id, title, body, excerpt, created_at, confidence
            FROM nodes WHERE id IN (SELECT value FROM json_each(?1))`,
    params: ["ids"],
  },
  meta_fp_get: {
    name: "meta_fp_get",
    sql: `SELECT value FROM myc_meta WHERE key = ?1`,
    params: ["key"],
  },
  meta_fp_set: {
    name: "meta_fp_set",
    sql: `INSERT INTO myc_meta (key, value) VALUES (?1, ?2)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    params: ["key", "value"],
  },
  health_set: {
    name: "health_set",
    sql: `INSERT INTO myc_health (component, state, reason, since, detail)
          VALUES ('absorb', ?1, ?2, ?3, ?4)
          ON CONFLICT(component) DO UPDATE SET
            state = excluded.state,
            reason = excluded.reason,
            since = CASE WHEN myc_health.state = excluded.state THEN myc_health.since ELSE excluded.since END,
            detail = excluded.detail`,
    params: ["state", "reason", "since", "detail"],
  },
});

/**
 * Запросы absorb — ради теста: проверять отбор кандидатов надо ТЕМ ЖЕ текстом,
 * что исполняет команда (тот же приём, что primeQueries в prime.ts).
 */
export const absorbQueries = Q;

// ---------------------------------------------------------------------------
// Текст узла и вектора
// ---------------------------------------------------------------------------

interface CandidateRow {
  readonly rowid: number;
  readonly id: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly excerpt: string | null;
  readonly created_at: number;
  readonly confidence: number;
}

/**
 * Текст узла для сравнения — ТОТ ЖЕ, что идёт в эмбеддинг у reindex-vectors:
 * у заметок заголовок — обрезок тела, и его удвоение перекосило бы и
 * вектор, и триграммы.
 */
export function absorbText(n: {
  readonly title: string | null;
  readonly body: string | null;
  readonly excerpt: string | null;
}): string {
  const head = (n.title ?? "").trim().replace(/[.…]+$/u, "").trim();
  const body = (n.body ?? n.excerpt ?? "").trim();
  if (head.length === 0) return body;
  if (body.length === 0) return head;
  if (body.startsWith(head)) return body;
  return `${head}\n${body}`;
}

/** int8 из nodes_vec → Float32Array без масштаба: косинусу масштаб не нужен. */
function dequantize(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength !== EMBED_DIM) return null;
  const q = new Int8Array(blob.buffer, blob.byteOffset, EMBED_DIM);
  const out = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = q[i]!;
  return out;
}

/** q = round(127 × v / max|v|) — формула packages/embed/src/quantize.ts. */
function quantize(vec: Float32Array): Buffer {
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) maxAbs = Math.max(maxAbs, Math.abs(vec[i]!));
  const scale = maxAbs > 0 ? maxAbs : 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round((127 * vec[i]!) / scale)));
  }
  return Buffer.from(q.buffer, q.byteOffset, q.byteLength);
}

/**
 * MATCH-строка FTS: до FTS_WORDS самых длинных уникальных слов текста, ИЛИ.
 * Длинные слова — самые различающие (термины, идентификаторы); кавычки
 * снимают спецсимволы синтаксиса FTS5.
 */
export function ftsMatchOf(text: string): string | null {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const m of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu) ?? []) {
    const w = m.replace(/^[.-]+|[.-]+$/gu, "");
    if (w.length < 3 || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  if (words.length === 0) return null;
  words.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return words
    .slice(0, FTS_WORDS)
    .map((w) => `"${w.replace(/"/gu, "")}"`)
    .join(" OR ");
}

// ---------------------------------------------------------------------------
// Эмбеддер (динамически, только по потребности)
// ---------------------------------------------------------------------------

export interface AbsorbEmbedder {
  /** Отпечаток векторного пространства этого эмбеддера (backend:provider:model:dim:norm). */
  readonly fingerprint: EmbedFingerprint;
  embed(text: string): Promise<Float32Array | null>;
  destroy(): Promise<void>;
}

export type EmbedderResolution =
  | { readonly ok: true; readonly embedder: AbsorbEmbedder }
  | { readonly ok: false; readonly reason: string };

export async function resolveAbsorbEmbedder(timeoutMs: number): Promise<EmbedderResolution> {
  if (timeoutMs <= 0) {
    return { ok: false, reason: "embedder off (--no-embed / --embed-timeout 0)" };
  }
  try {
    const embed = await import("@myc/embed");
    if (!(await embed.isModelPresent(embed.DEFAULT_MODEL_ID))) {
      return { ok: false, reason: "embedding model not downloaded → myc models fetch" };
    }
    const embedder = embed.createEmbedder({ backend: "local" });
    const warmed = await Promise.race([
      embedder.warmup(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
    ]);
    if (warmed !== "ok") {
      void embedder.destroy();
      return {
        ok: false,
        reason:
          warmed === "timeout"
            ? `embedder did not warm up within ${timeoutMs} ms`
            : `embedder is in state ${warmed}`,
      };
    }
    return {
      ok: true,
      embedder: {
        fingerprint: embedder.fingerprint,
        // Документ, а не запрос: у e5 это разные префиксы (см. reindex-vectors).
        embed: async (text) => {
          const res = await embedder.embed(text, "passage");
          return res.state === "ok" ? res.vec : null;
        },
        destroy: () => embedder.destroy(),
      },
    };
  } catch (e) {
    return { ok: false, reason: `embedder failed to start: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Разбор одного узла
// ---------------------------------------------------------------------------

export interface AbsorbNodeResult {
  readonly id: string;
  readonly class: AbsorbClass;
  readonly target: string | null;
  readonly cos: number | null;
  readonly jac: number;
  readonly quality: "embedded" | "lexical";
  readonly reason: string;
  readonly candidates: number;
  readonly related: number;
  /** Что реально сделано в графе (пусто при --dry-run). */
  readonly actions: string[];
  readonly embedded_here: boolean;
  readonly error?: string;
  /**
   * Узел не классифицирован вовсе: это кандидат хука сжатия (см.
   * {@link CANDIDATE_SKIP}). class/quality тогда ничего не значат и в
   * счётчики прогона не входят.
   */
  readonly skipped?: "pending_review";
}

/**
 * КАНДИДАТ ХУКА СЖАТИЯ НЕ КЛАССИФИЦИРУЕТСЯ (§6.2, memory-79mq6fccg0jm).
 * Классификация — это решение, чья версия каноническая. Кандидат, названный
 * по id, старше найденного дубля, и `canonicalOf` отдал бы ему роль
 * канонического: явно записанная заметка ушла бы в него `superseded`, а сам
 * он из выдачи исключён — факт пропал бы целиком. Поэтому кандидат не бывает
 * ни целью (запросы `knn`/`fts` выше), ни источником: `myc absorb <id>`
 * отказывает громко, а работа очереди, если она у кандидата окажется, —
 * пропускается без записи. Подтверждённый кандидат (`myc review confirm`)
 * получает свою работу absorb заново — уже знанием.
 */
export const CANDIDATE_SKIP =
  "unconfirmed compaction candidate: not knowledge yet, not classified — `myc review confirm` queues absorb for it";

/**
 * Сессия разбора. Экспортирована для дренажа очереди (../drain.ts): он
 * исполняет absorb-работы инлайн через absorbOne, а не через команду —
 * иначе каждая работа платила бы открытием стора и обходом jobs.claim (S7).
 */
export interface Session {
  readonly h: StoreHandle;
  readonly thresholds: AbsorbThresholds;
  readonly dryRun: boolean;
  readonly now: number;
  /** null — эмбеддера нет; строка причины лежит в degradedReason. */
  embedder: AbsorbEmbedder | null;
  degradedReason: string | null;
  /**
   * Расхождение отпечатка векторного пространства (myc_meta.embed_fingerprint
   * против текущей модели) — если задано, запись отказана целиком (И2):
   * смешивать пространства нельзя, это порча индекса, которую не видно
   * месяцами. Не путать с degradedReason: там просто нет эмбеддера и узел
   * тихо переходит в lexical; здесь — громкий отказ писать.
   */
  fingerprintMismatch: FingerprintMismatchError | null;
  /** Ленивая инициализация эмбеддера — один раз на прогон. */
  resolveEmbedder(): Promise<AbsorbEmbedder | null>;
}

function nodeAsText(n: NodeRecord): string {
  return absorbText({ title: n.title, body: n.body, excerpt: n.excerpt });
}

function vectorOf(h: StoreHandle, rowid: number): Float32Array | null {
  if (!h.vec0) return null;
  try {
    const row = h.driver.one<{ embedding: Uint8Array }>(Q.vec_by_rowid, [rowid]);
    return dequantize(row?.embedding);
  } catch {
    return null; // nodes_vec нет — вектора нет; причина названа выше по vec0Reason
  }
}

async function ensureVector(
  s: Session,
  node: NodeRecord,
  rowid: number,
  text: string,
): Promise<{ vector: Float32Array | null; embeddedHere: boolean }> {
  const existing = vectorOf(s.h, rowid);
  if (existing !== null) return { vector: existing, embeddedHere: false };
  const embedder = await s.resolveEmbedder();
  if (embedder === null) return { vector: null, embeddedHere: false };
  const vec = await embedder.embed(text);
  if (vec === null) {
    s.degradedReason = s.degradedReason ?? "embedder returned no vector";
    return { vector: null, embeddedHere: false };
  }
  if (s.h.vec0 && !s.dryRun) {
    try {
      s.h.driver.tx("immediate", (tx) => {
        tx.run(Q.vec_delete, [rowid]);
        tx.run(Q.vec_insert, [rowid, node.scope, node.layer, node.kind, quantize(vec)]);
        tx.run(Q.job_done_by_entity, ["embed", node.id]);
      });
    } catch {
      /* индекс не обновился — сам вердикт от этого не зависит */
    }
  }
  return { vector: vec, embeddedHere: true };
}

function candidatesOf(
  s: Session,
  node: NodeRecord,
  text: string,
  vector: Float32Array | null,
): AbsorbText[] {
  const ids = new Set<string>();
  if (vector !== null && s.h.vec0) {
    try {
      for (const r of s.h.driver.all<{ id: string }>(Q.knn, [
        quantize(vector),
        KNN_LIMIT,
        node.scope,
        node.id,
        node.kind,
      ])) {
        ids.add(r.id);
      }
    } catch {
      /* без nodes_vec kNN нет — остаётся FTS */
    }
  }
  const match = ftsMatchOf(text);
  if (match !== null) {
    try {
      for (const r of s.h.driver.all<{ id: string }>(Q.fts, [
        match,
        node.scope,
        node.id,
        node.kind,
        FTS_LIMIT,
      ])) {
        ids.add(r.id);
      }
    } catch {
      /* синтаксис FTS не принял слово — кандидаты только по вектору */
    }
  }
  if (ids.size === 0) return [];
  const rows = s.h.driver.all<CandidateRow>(Q.nodes_by_ids, [JSON.stringify([...ids])]);
  const vecs = new Map<number, Float32Array>();
  if (s.h.vec0) {
    try {
      for (const v of s.h.driver.all<{ rowid: number; embedding: Uint8Array }>(Q.vec_by_rowids, [
        JSON.stringify(rows.map((r) => r.rowid)),
      ])) {
        const f = dequantize(v.embedding);
        if (f) vecs.set(Number(v.rowid), f);
      }
    } catch {
      /* см. выше */
    }
  }
  return rows.map((r) => ({
    id: r.id,
    text: absorbText(r),
    vector: vecs.get(r.rowid) ?? null,
    createdAt: r.created_at,
    confidence: r.confidence,
  }));
}

function canSupersede(kind: NodeKind): boolean {
  return NODE_STATUSES[kind].includes("superseded");
}

/**
 * Цепочка версий узла — ТЕМ ЖЕ обходом, что у `myc show` (§6.3).
 *
 * Здесь стояли две собственные копии: рекурсивный `headOf`, поднимавшийся по
 * `head_id` и бравший головой то, на что указывает последний указатель, и
 * запрос `chain_of` (`WHERE head_id = ?1`), который видел только прямых
 * потомков и не видел сам узел. Копии расходились с ядром дважды: на
 * развилке после слияния веток голову выбирал указатель, а не
 * детерминированное правило VersionGraph, и цепочка глубже одного звена
 * доставалась не целиком.
 */
function chainOf(h: StoreHandle, node: NodeRecord): VersionGraph {
  return collectVersions(versionSourceOf(h.driver, h.store), {
    id: node.id,
    head_id: node.head_id,
    hlc: node.hlc,
    site_id: node.site_id,
  }).graph;
}

function addEdgeOnce(
  h: StoreHandle,
  src: string,
  type: EdgeKind,
  dst: string,
  weight: number,
  actions: string[],
): void {
  if (src === dst) return;
  if (h.store.getEdge(src, type, dst) !== undefined) return;
  h.store.addEdge(src, type, dst, { weight });
  actions.push(`${type} ${src} → ${dst} (${weight.toFixed(3)})`);
}

function applyVerdict(
  s: Session,
  node: NodeRecord,
  verdict: AbsorbVerdict,
  actions: string[],
): void {
  const h = s.h;
  const weight = Math.min(1, Math.max(0, verdict.cos ?? verdict.jac));
  const target = verdict.targetId;

  if (verdict.class === "duplicate" && target !== null) {
    const other = h.store.getNode(target, true);
    if (other === undefined) return;
    const canonicalId = canonicalOf(
      { id: node.id, createdAt: node.created_at, confidence: node.confidence },
      { id: other.id, createdAt: other.created_at, confidence: other.confidence },
    );
    const dupId = canonicalId === node.id ? other.id : node.id;
    const canonicalNode = canonicalId === node.id ? node : other;
    const canonical = chainOf(h, canonicalNode).head(canonicalId);
    if (canonical === dupId) return;
    addEdgeOnce(h, dupId, "duplicates", canonical, 1, actions);
    h.store.bumpCounter(canonical, "seen_count");
    actions.push(`seen_count++ ${canonical}`);
    const dup = h.store.getNode(dupId, true)!;
    h.store.updateNode(dupId, {
      head_id: canonical,
      ...(canSupersede(dup.kind) ? { status: "superseded" } : {}),
    });
    actions.push(`${dupId}.head_id = ${canonical}`);
    return;
  }

  if (verdict.class === "update" && target !== null) {
    const old = h.store.getNode(target, true);
    if (old === undefined) return;
    addEdgeOnce(h, node.id, "supersedes", old.id, weight, actions);
    // Что переписать при классе update решает ядро (§6.2, §6.3): ребро уже
    // добавлено, поэтому цепочка собирается вместе с ним, а rehead — вся
    // цепочка заменяемой версии, а не только её прямые потомки.
    const plan = supersessionPlan(chainOf(h, old), old.id, node.id);
    for (const id of plan.rehead) {
      const n = h.store.getNode(id, true);
      if (n === undefined) continue;
      h.store.updateNode(id, {
        head_id: plan.head,
        ...(canSupersede(n.kind) ? { status: "superseded" } : {}),
      });
    }
    actions.push(
      `head_id = ${plan.head} on ${plan.rehead.length} ${plan.rehead.length === 1 ? "node" : "nodes"}`,
    );
    for (const type of ["touches", "mentions"] as const) {
      for (const e of h.store.edgesFrom(old.id, type)) {
        addEdgeOnce(h, node.id, type, e.dst, e.weight, actions);
      }
    }
  } else if (verdict.class === "contradiction" && target !== null) {
    const old = h.store.getNode(target, true);
    if (old === undefined) return;
    addEdgeOnce(h, node.id, "contradicts", old.id, weight, actions);
    const round = (x: number): number => Math.round(x * 0.7 * 1000) / 1000;
    h.store.updateNode(node.id, { confidence: round(node.confidence) });
    h.store.updateNode(old.id, { confidence: round(old.confidence) });
    actions.push(`confidence × 0.7: ${node.id}, ${old.id}`);
  } else if (verdict.class === "related" && target !== null) {
    addEdgeOnce(h, node.id, "relates", target, weight, actions);
  }

  // Остальные кандидаты пояса — relates: расширение выдачи на 1 хоп (§4.1).
  if (verdict.class !== "new") {
    for (const r of verdict.related) addEdgeOnce(h, node.id, "relates", r.id, r.weight, actions);
  }
}

export async function absorbOne(s: Session, id: string): Promise<AbsorbNodeResult> {
  const h = s.h;
  const node = h.store.getNode(id);
  if (node === undefined) throw new Error(`node ${id} not found or deleted`);
  if (isPendingReview(node.attrs)) {
    return {
      id: node.id,
      class: "new",
      target: null,
      cos: null,
      jac: 0,
      quality: "lexical",
      reason: CANDIDATE_SKIP,
      candidates: 0,
      related: 0,
      actions: [],
      embedded_here: false,
      skipped: "pending_review",
    };
  }
  const rowid = h.driver.one<{ rowid: number }>(Q.node_rowid, [id])?.rowid;
  if (rowid === undefined) throw new Error(`node ${id} has no rowid`);
  const text = nodeAsText(node);

  const { vector, embeddedHere } = await ensureVector(s, node, rowid, text);
  const incoming: AbsorbText = {
    id: node.id,
    text,
    vector,
    createdAt: node.created_at,
    confidence: node.confidence,
  };
  const candidates = candidatesOf(s, node, text, vector);
  const verdict = classifyAbsorb(incoming, candidates, s.thresholds);

  const actions: string[] = [];
  if (!s.dryRun) {
    try {
      applyVerdict(s, node, verdict, actions);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    const absorb: Record<string, JsonValue> = {
      by: "stage-a",
      at: s.now,
      class: verdict.class,
      target: verdict.targetId,
      cos: verdict.cos === null ? null : Math.round(verdict.cos * 10000) / 10000,
      jac: Math.round(verdict.jac * 10000) / 10000,
      quality: verdict.quality,
      reason: verdict.reason,
      candidates: verdict.considered,
    };
    const attrs: Record<string, JsonValue> = { absorb };
    if (verdict.quality === "lexical") {
      absorb["degraded"] = s.degradedReason ?? "vectors unavailable";
      attrs["degraded_at"] = s.now;
    }
    h.store.updateNode(node.id, { attrs });
  }

  return {
    id: node.id,
    class: verdict.class,
    target: verdict.targetId,
    cos: verdict.cos,
    jac: verdict.jac,
    quality: verdict.quality,
    reason: verdict.reason,
    candidates: verdict.considered,
    related: verdict.related.length,
    actions,
    embedded_here: embeddedHere,
  };
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

const ABSORB_FLAGS: readonly FlagSpec[] = [
  { name: "limit", value: "string", description: "how many queued jobs to process (default 50)" },
  { name: "dry-run", description: "classify and print, change nothing" },
  { name: "no-embed", description: "never load the embedder: lexical mode only (loud degradation)" },
  { name: "embed-timeout", value: "string", description: "embedder warmup budget, ms (default 8000)" },
];

export interface AbsorbData {
  processed: number;
  by_class: Record<AbsorbClass, number>;
  nodes: AbsorbNodeResult[];
  degraded: string | null;
  dry_run: boolean;
  thresholds: AbsorbThresholds;
  took_ms: number;
}

export interface AbsorbDeps extends StoreDeps {
  resolveEmbedder(timeoutMs: number): Promise<EmbedderResolution>;
  now(): number;
}

export const realAbsorbDeps: AbsorbDeps = {
  openStore: realStoreDeps.openStore,
  resolveEmbedder: resolveAbsorbEmbedder,
  now: () => Date.now(),
};

function loadThresholds(ctx: CommandContext): AbsorbThresholds {
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  const tomlPath = join(dir, ".myc", "workspace.toml");
  if (!existsSync(tomlPath)) return DEFAULT_ABSORB_THRESHOLDS;
  try {
    return absorbThresholdsFromToml(readFileSync(tomlPath, "utf8"));
  } catch {
    return DEFAULT_ABSORB_THRESHOLDS;
  }
}

function renderAbsorbHuman(raw: unknown): string {
  const d = raw as AbsorbData;
  const lines: string[] = [];
  if (d.degraded !== null) lines.push(`DEGRADED  absorb without vectors: ${d.degraded}`);
  for (const n of d.nodes) {
    if (n.skipped !== undefined) {
      lines.push(`${n.id}  skipped  ${n.reason}`);
      continue;
    }
    const sim =
      n.cos === null ? `jac ${n.jac.toFixed(3)} (lexical)` : `cos ${n.cos.toFixed(3)} jac ${n.jac.toFixed(3)}`;
    const target = n.target === null ? "" : ` → ${n.target}`;
    lines.push(`${n.id}  ${n.class}${target}  ${sim}  candidates ${n.candidates}${n.error ? `  ERROR ${n.error}` : ""}`);
    for (const a of n.actions) lines.push(`          ${a}`);
  }
  const counts = (Object.keys(d.by_class) as AbsorbClass[])
    .filter((c) => d.by_class[c] > 0)
    .map((c) => `${c} ${d.by_class[c]}`)
    .join(", ");
  lines.push(`${d.dry_run ? "dry-run: " : ""}processed ${d.processed}${counts ? ` (${counts})` : ""} · ${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

export function createAbsorbCommand(deps: AbsorbDeps = realAbsorbDeps): Command {
  return {
    name: "absorb",
    summary: "classify queued memory (stage A: hash, cosine, trigrams; no LLM)",
    flags: ABSORB_FLAGS,
    help:
      "Drains jobs(kind='absorb') queued by `myc remember`, or classifies one node by id. " +
      "Classes: duplicate, update, contradiction, related, new (§6.2). Thresholds live in " +
      "workspace.toml [absorb]. Without embeddings nothing is merged or dropped: candidates " +
      "become `relates` and the node row records quality='lexical' plus degraded_at.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const dryRun = flagBool(ctx, "dry-run");
      const limitRaw = flagNum(ctx, "limit");
      const limit = limitRaw !== undefined && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;
      const embedTimeout = flagBool(ctx, "no-embed")
        ? 0
        : (flagNum(ctx, "embed-timeout") ?? 8000);
      const positional = ctx.args[0];

      const opened = await deps.openStore(ctx, VECTOR_OPEN);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      const now = deps.now();
      const holder = `absorb:${process.pid}:${now}`;

      const s: Session = {
        h,
        thresholds: loadThresholds(ctx),
        dryRun,
        now,
        embedder: null,
        degradedReason: h.vec0 ? null : (h.vec0Reason ?? "vec0 not loaded — nodes_vec unavailable"),
        fingerprintMismatch: null,
        resolveEmbedder: async () => {
          // Расхождение уже обнаружено этим прогоном — второй раз эмбеддер
          // не поднимаем, просто повторяем отказ (одна и та же причина).
          if (s.fingerprintMismatch !== null) throw s.fingerprintMismatch;
          if (s.embedder !== null) return s.embedder;
          if (s.degradedReason !== null && !h.vec0) return null;
          if (embedTimeout <= 0) {
            s.degradedReason = "embedder off (--no-embed / --embed-timeout 0)";
            return null;
          }
          const r = await deps.resolveEmbedder(embedTimeout);
          if (!r.ok) {
            s.degradedReason = r.reason;
            return null;
          }
          // Сверка на старте векторной подсистемы (И2, D16): один раз на
          // прогон, ДО первой записи вектора этой моделью. Расхождение —
          // отказ писать, не деградация до lexical: продолжать значило бы
          // класть векторы новой модели рядом со старыми в одном индексе.
          const recorded = h.driver.one<{ value: string }>(Q.meta_fp_get, ["embed_fingerprint"])?.value;
          const check = checkFingerprint(recorded, r.embedder.fingerprint);
          if (!check.compatible) {
            await r.embedder.destroy();
            const err = new FingerprintMismatchError(check);
            s.fingerprintMismatch = err;
            throw err;
          }
          if (recorded === undefined) {
            h.driver.run(Q.meta_fp_set, ["embed_fingerprint", formatEmbedFingerprint(r.embedder.fingerprint)]);
          }
          s.embedder = r.embedder;
          return s.embedder;
        },
      };

      try {
        // Что разбирать: один узел или очередь.
        let targets: { id: string; jobId: number | null }[];
        if (positional !== undefined) {
          const resolved = resolveId(h, positional);
          if (!resolved.ok) return resolved.failure;
          // Кандидат по id — отказ, а не пропуск (CANDIDATE_SKIP): человек
          // назвал узел явно, и молча ответить «new» значило бы соврать ему.
          if (isPendingReview(resolved.node.attrs)) {
            const awaiting = isAwaitingReview(resolved.node.attrs, resolved.node.status);
            return {
              ok: false,
              code: "precond.pending_review",
              msg:
                `${resolved.node.id} is ${awaiting ? "an unconfirmed" : "a rejected"} compaction candidate: ` +
                "absorb classifies knowledge, and a candidate classified here could become the canonical " +
                "node of an explicit note",
              exit: ExitCode.PRECOND,
              hint: awaiting ? `myc review confirm ${resolved.node.id}` : "myc review",
            };
          }
          targets = [{ id: resolved.node.id, jobId: null }];
        } else {
          const rows = h.driver.all<{ id: number; entity_id: string }>(Q.jobs_pull, [
            JOB_KIND,
            now,
            limit,
          ]);
          targets = [];
          for (const r of rows) {
            if (dryRun) {
              targets.push({ id: r.entity_id, jobId: r.id });
              continue;
            }
            const leased = h.driver.run(Q.job_lease, [holder, now + LEASE_MS, r.id, now]);
            if (leased.changes === 1) targets.push({ id: r.entity_id, jobId: r.id });
          }
        }

        const byClass: Record<AbsorbClass, number> = {
          duplicate: 0,
          update: 0,
          contradiction: 0,
          related: 0,
          new: 0,
        };
        const nodes: AbsorbNodeResult[] = [];
        let fingerprintMismatch: FingerprintMismatchError | null = null;
        for (const t of targets) {
          try {
            const r = await absorbOne(s, t.id);
            nodes.push(r);
            if (r.skipped === undefined) byClass[r.class]++;
            if (t.jobId !== null && !dryRun) h.driver.run(Q.job_done, [t.jobId, holder]);
          } catch (e) {
            if (e instanceof FingerprintMismatchError) {
              // Не вина этого узла — вся подсистема отказалась писать.
              // Возвращаем работу в очередь немедленно (не через LEASE_MS):
              // как только пространство переиндексируют, она снова готова.
              if (t.jobId !== null && !dryRun) h.driver.run(Q.job_fail, [e.message, now, t.jobId]);
              fingerprintMismatch = e;
              break;
            }
            const msg = e instanceof Error ? e.message : String(e);
            nodes.push({
              id: t.id,
              class: "new",
              target: null,
              cos: null,
              jac: 0,
              quality: "lexical",
              reason: "",
              candidates: 0,
              related: 0,
              actions: [],
              embedded_here: false,
              error: msg,
            });
            if (t.jobId !== null && !dryRun) {
              // Повтор через минуту; attempts уже поднят арендой.
              h.driver.run(Q.job_fail, [msg, now + LEASE_MS, t.jobId]);
            }
            ctx.warn("absorb.failed", `${t.id}: ${msg}`);
          }
        }

        // И2: смена модели без reembed — громкий отказ, не деградация до
        // lexical. Продолжать значило бы класть векторы новой модели рядом
        // со старыми в один индекс — порчу, которую не видно месяцами.
        // Уже записанные векторы не трогаем; только останавливаем запись.
        if (fingerprintMismatch !== null) {
          ctx.warn("degraded.fingerprint_mismatch", fingerprintMismatch.message);
          if (!dryRun) {
            try {
              h.driver.run(Q.health_set, [
                "degraded",
                fingerprintMismatch.message,
                now,
                JSON.stringify({ processed: nodes.length, fingerprint_mismatch: true }),
              ]);
            } catch {
              /* myc_health — наблюдаемость, не запись; её отказ не роняет разбор */
            }
          }
          return {
            ok: false,
            code: fingerprintMismatch.code,
            msg: fingerprintMismatch.message,
            exit: ExitCode.PRECOND,
            hint: "vectors already in the index are intact; reindex the corpus with the current model: `bun run reindex:vectors --force`",
          };
        }

        // Деградация — вслух: строка узла (выше), myc_health и meta.degraded[].
        const degraded = nodes.some((n) => n.quality === "lexical" && n.error === undefined && n.skipped === undefined)
          ? (s.degradedReason ?? "vectors unavailable")
          : null;
        if (!dryRun && nodes.length > 0) {
          try {
            h.driver.run(Q.health_set, [
              degraded === null ? "ok" : "degraded",
              degraded ?? "",
              now,
              JSON.stringify({ processed: nodes.length, lexical: nodes.filter((n) => n.quality === "lexical").length }),
            ]);
          } catch {
            /* myc_health — наблюдаемость, не запись; её отказ не роняет разбор */
          }
        }
        if (degraded !== null) {
          ctx.warn("degraded.embed", `absorb without vectors: ${degraded} — candidates became relates, nothing merged`);
        }

        const data: AbsorbData = {
          processed: nodes.length,
          by_class: byClass,
          nodes,
          degraded,
          dry_run: dryRun,
          thresholds: s.thresholds,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return {
          ok: true,
          data,
          meta: { took_ms: data.took_ms, processed: data.processed, dry_run: dryRun },
        };
      } catch (e) {
        return graphFailure(e);
      } finally {
        if (s.embedder !== null) await s.embedder.destroy();
        h.close();
      }
    },
    renderHuman: renderAbsorbHuman,
  };
}

