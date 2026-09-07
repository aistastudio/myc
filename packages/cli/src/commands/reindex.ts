/**
 * `myc reindex` — индексация корпуса как класс работ `embed` общей очереди
 * `jobs` (решение S7, myc-yhx1j0cr0sdb). Это вторая половина векторной
 * записи: первая — одноразовый scripts/reindex-vectors.ts (полная перестройка
 * при смене пространства), эта — поточная досчётка за живым корпусом.
 *
 *   myc reindex [--batch N] [--dry-run] [--watch]
 *
 * УСТРОЙСТВО. Работа над узлом существует только как строка jobs(kind='embed',
 * entity_id=id узла): её ставит `remember` при записи, промах кеша
 * переранжирования (vec-002) — при чтении, а скан ниже — при старте прогона
 * для узлов, у которых вектора нет или текст сменился. Сам индексатор таблицу
 * узлов НЕ перебирает как источник работы — он берёт батчи через
 * `jobs.claim` (захват атомарен, проверен гонкой 8 процессов в jobs.test.ts).
 *
 * БАТЧ 50 + ЧЕКПОЙНТ. Батч — это гранularity ЗАХВАТА И ФИКСАЦИИ, а не
 * эмбеддинга: тексты кодируются по одному (замер в scripts/reindex-vectors.ts:
 * пакет из двух смещает вектор на косинус 0.9977, а у многоязычной модели
 * это сравнимо с зазором между кандидатами). После каждого батча — ОДНА
 * транзакция: векторы + content-hash + `jobs.complete`. Она и есть чекпойнт:
 * убитый посреди батча процесс откатывает только его, а по истечении аренды
 * батч подбирает следующий прогон — приёмка «убитая сборка догоняет без
 * повторной работы» держится именно на этом, и мутация «чекпойнт убран»
 * обязана краснеть в reindex.test.ts.
 *
 * ПРОПУСК НЕИЗМЕНЁННОГО. Хеш текста, который РЕАЛЬНО ушёл в индекс, лежит в
 * vec_embed_meta (таблица этого воркера; nodes.content_hash — хеш ТЕКУЩЕГО
 * содержимого, считается стором из kind+title+body). Совпал — эмбеддер не
 * зовётся. Тот же хеш работает и в обратную сторону: если ДРУГОЙ живой узел
 * с тем же content_hash уже имеет актуальный вектор, вектор копируется, а не
 * считается заново — переиспользование между ветками/скоупами бесплатно,
 * потому что вектор — функция текста, а не узла.
 *
 * СВЕРКА ОТПЕЧАТКА — ОБЯЗАТЕЛЬНА. Этот воркер — ВТОРОЙ путь записи векторов
 * после absorb.ts, и обходить защиту `checkFingerprint` здесь значит вернуть
 * смешанные векторные пространства, невидимые месяцами. Расхождение — ОТКАЗ
 * (код 5, PRECOND), не предупреждение; перестройка пространства остаётся за
 * scripts/reindex-vectors.ts --force.
 *
 * float32 (vec_nodes_f32) — горячий LRU-кеш переранжирования (vec-002):
 * пишется, когда работа его просит (payload.f32 / reason='rerank_miss') или
 * строка кеша уже есть и протухла вместе с вектором; целиком корпус в f32 не
 * раздувается. Хвост за потолком F32_CACHE_LIMIT срезается по accessed_at.
 *
 * WATCH. `--watch` после разгребания очереди следит за каталогом базы:
 * любая запись (WAL) взводит дебаунс 2 с, и прогон повторяется. Медленный
 * опрос (30 с) — страховка для работ, чья аренда истекает без записи в базу.
 *
 * ПЕРЕМЕННЫЕ (тесты): MYC_EMBED_FAKE=1 — детерминированный эмбеддер без
 * ONNX; MYC_EMBED_FAKE_LOG — путь, куда он пишет по строке на вызов (так
 * многопроцессный тест считает вызовы эмбеддера); MYC_EMBED_FAKE_DELAY_MS —
 * пауза на вызов (SIGKILL посреди батча); MYC_REINDEX_LEASE_MS — аренда
 * захвата; MYC_REINDEX_WATCH_DEBOUNCE_MS / MYC_REINDEX_WATCH_POLL_MS —
 * тайминги watch.
 */

import { createHash } from "node:crypto";
import { appendFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { historyClause } from "@myc/core";
import { jobs } from "@myc/store-sqlite";
import {
  checkFingerprint,
  formatEmbedFingerprint,
  parseEmbedFingerprint,
  type EmbedFingerprint,
} from "@myc/embed/fingerprint";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import {
  VECTOR_OPEN,
  flagBool,
  flagNum,
  realStoreDeps,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Константы и окружение
// ---------------------------------------------------------------------------

/** Узлов в батче захвата/чекпойнта. НЕ размер пакета эмбеддера — см. шапку. */
export const REINDEX_BATCH_SIZE = 50;

/** Дебаунс watch: столько тишины после последней записи в базу. */
export const WATCH_DEBOUNCE_MS = 2_000;

/** Страховочный опрос в watch: аренды мёртвых воркеров сами себя не разбудят. */
export const WATCH_POLL_MS = 30_000;

/** Аренда батча: 50 узлов по одному эмбеддингу — единицы секунд на CPU. */
export const REINDEX_LEASE_MS = 60_000;

/** Потолок float32-кеша переранжирования (vec-002). */
export const F32_CACHE_LIMIT = 10_000;

const EMBED_DIM = 384;

/** Отпечаток заглушки: парсится общей грамматикой, стабилен между прогонами. */
const FAKE_FINGERPRINT = "local:onnx:fake-embed:384:l2";

function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------
// Эмбеддер: настоящий (динамический импорт — ONNX не тащим статически) и фейк
// ---------------------------------------------------------------------------

interface IndexEmbedder {
  readonly fingerprint: EmbedFingerprint;
  embed(text: string): Promise<Float32Array | null>;
  destroy(): Promise<void>;
}

/**
 * Детерминированный эмбеддер для тестов: вектор — функция текста (sha256,
 * L2-нормировка), поэтому content-hash пропуски и копирование между ветками
 * видны по СЧЁТЧИКУ вызовов, а не по содержимому векторов. Каждый вызов
 * пишется в MYC_EMBED_FAKE_LOG — считать строки файла может и другой процесс.
 */
function fakeEmbedderFromEnv(env: NodeJS.ProcessEnv): IndexEmbedder | null {
  if (env.MYC_EMBED_FAKE !== "1") return null;
  const logPath = env.MYC_EMBED_FAKE_LOG;
  const delayMs = Math.max(0, Number(env.MYC_EMBED_FAKE_DELAY_MS ?? 0) || 0);
  return {
    fingerprint: parseEmbedFingerprint(FAKE_FINGERPRINT)!,
    async embed(text: string): Promise<Float32Array> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      // Пауза ДО записи в лог: строка в логе означает «вызов завершён», и
      // тест, увидевший N строк, знает, что (N+1)-й узел ещё в работе.
      if (logPath !== undefined && logPath.length > 0) {
        appendFileSync(logPath, `${JSON.stringify({ text })}\n`);
      }
      const digest = createHash("sha256").update(text).digest();
      const vec = new Float32Array(EMBED_DIM);
      let norm = 0;
      for (let i = 0; i < EMBED_DIM; i++) {
        const b = digest[(i * 7 + Math.floor(i / 32)) % 32]! ^ ((i * 31) & 0xff);
        const v = (b / 255) * 2 - 1;
        vec[i] = v;
        norm += v * v;
      }
      const inv = 1 / Math.sqrt(norm > 0 ? norm : 1);
      for (let i = 0; i < EMBED_DIM; i++) vec[i] = vec[i]! * inv;
      return vec;
    },
    destroy: () => Promise.resolve(),
  };
}

type EmbedderResult =
  | { readonly ok: true; readonly embedder: IndexEmbedder }
  | { readonly ok: false; readonly failure: CommandFailure };

async function realEmbedder(): Promise<EmbedderResult> {
  try {
    const embed = await import("@myc/embed");
    if (!(await embed.isModelPresent(embed.DEFAULT_MODEL_ID))) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "precond.model_absent",
          msg: `модель ${embed.DEFAULT_MODEL_ID} не скачана`,
          exit: ExitCode.PRECOND,
          hint: "myc models fetch",
        },
      };
    }
    const e = embed.createLocalEmbedder({});
    const state = await e.warmup();
    if (state !== "ok") {
      await e.destroy();
      return {
        ok: false,
        failure: {
          ok: false,
          code: "embed.warmup_failed",
          msg: `эмбеддер в состоянии ${state} — индексация отменена`,
          exit: ExitCode.PRECOND,
        },
      };
    }
    return {
      ok: true,
      embedder: {
        fingerprint: e.fingerprint,
        // Роль "passage": документ, не запрос — у e5 это разные префиксы.
        embed: async (text) => (await e.embed(text, "passage")).vec,
        destroy: () => e.destroy(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "embed.load_failed",
        msg: `эмбеддер не загрузился: ${error instanceof Error ? error.message : String(error)}`,
        exit: ExitCode.ERR,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Текст узла и квантование — те же правила, что у scripts/reindex-vectors.ts
// ---------------------------------------------------------------------------

interface NodeRow {
  readonly rowid: number;
  readonly id: string;
  readonly scope: string;
  readonly layer: number;
  readonly kind: string;
  readonly title: string | null;
  readonly excerpt: string | null;
  readonly body: string | null;
  readonly content_hash: string;
  readonly deleted_at: number | null;
  readonly head_id: string | null;
  readonly status: string;
}

/**
 * Текст узла для эмбеддинга. Правило НЕ придумано здесь — оно повторяет
 * scripts/reindex-vectors.ts nodeText (и absorb.ts): заголовок-обрезок заметки
 * отбрасывается, чтобы не удваивать начало тела в усреднённом векторе.
 */
function nodeText(n: NodeRow): string {
  const head = (n.title ?? "").trim().replace(/[.…]+$/u, "").trim();
  const body = (n.body ?? n.excerpt ?? "").trim();
  if (head.length === 0) return body;
  if (body.length === 0) return head;
  if (body.startsWith(head)) return body;
  return `${head}\n${body}`;
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

function f32Blob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SQL = {
  metaTableExists: `SELECT name FROM sqlite_master WHERE type='table' AND name='vec_embed_meta'`,
  fpGet: `SELECT value FROM myc_meta WHERE key = 'embed_fingerprint'`,
  fpSet: `INSERT INTO myc_meta (key, value) VALUES ('embed_fingerprint', ?1)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  eligible: `SELECT rowid, id, scope, layer, kind, title, excerpt, body, content_hash,
                    deleted_at, head_id, status
               FROM nodes
              ORDER BY rowid`,
  vecRowids: `SELECT node_rowid AS r FROM nodes_vec`,
  metaAll: `SELECT node_id AS id, content_hash AS h FROM vec_embed_meta`,
  nodeById: `SELECT rowid, id, scope, layer, kind, title, excerpt, body, content_hash,
                    deleted_at, head_id, status
               FROM nodes WHERE id = ?1`,
  hasVec: `SELECT 1 AS x FROM nodes_vec WHERE node_rowid = ?1`,
  vecDelete: `DELETE FROM nodes_vec WHERE node_rowid = ?1`,
  vecInsert: `INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding)
              VALUES (?1, ?2, ?3, ?4, 1, vec_int8(?5))`,
  metaUpsert: `INSERT INTO vec_embed_meta (node_id, content_hash, embedded_at)
               VALUES (?1, ?2, ?3)
               ON CONFLICT(node_id) DO UPDATE SET content_hash = excluded.content_hash,
                                                  embedded_at  = excluded.embedded_at`,
  metaDelete: `DELETE FROM vec_embed_meta WHERE node_id = ?1`,
  f32Get: `SELECT embedding_f32 AS f32 FROM vec_nodes_f32 WHERE node_id = ?1`,
  f32Upsert: `INSERT INTO vec_nodes_f32 (node_id, embedding_f32, accessed_at)
              VALUES (?1, ?2, ?3)
              ON CONFLICT(node_id) DO UPDATE SET embedding_f32 = excluded.embedding_f32,
                                                 accessed_at   = excluded.accessed_at`,
  f32Delete: `DELETE FROM vec_nodes_f32 WHERE node_id = ?1`,
  f32Count: `SELECT count(*) AS n FROM vec_nodes_f32`,
  f32Evict: `DELETE FROM vec_nodes_f32 WHERE node_id IN (
               SELECT node_id FROM vec_nodes_f32 ORDER BY accessed_at ASC LIMIT ?1)`,
  // Актуальный вектор-ДОНОР: живой узел с тем же content_hash, чей записанный
  // хеш совпадает с текущим (то есть его вектор не протух). Ветка/скоуп донора
  // не важны — вектор функция текста.
  donorVec: `SELECT v.embedding AS embedding
               FROM nodes n2
               JOIN vec_embed_meta m ON m.node_id = n2.id AND m.content_hash = n2.content_hash
               JOIN nodes_vec v ON v.node_rowid = n2.rowid
              WHERE n2.content_hash = ?1 AND n2.id <> ?2
                AND n2.deleted_at IS NULL${historyClause("follow", "n2")} AND n2.status <> 'superseded'
              LIMIT 1`,
  donorF32: `SELECT f.embedding_f32 AS f32
               FROM nodes n2
               JOIN vec_embed_meta m ON m.node_id = n2.id AND m.content_hash = n2.content_hash
               JOIN vec_nodes_f32 f ON f.node_id = n2.id
              WHERE n2.content_hash = ?1 AND n2.id <> ?2
                AND n2.deleted_at IS NULL${historyClause("follow", "n2")} AND n2.status <> 'superseded'
              LIMIT 1`,
  earliestLease: `SELECT min(lease_expires) AS t FROM jobs
                   WHERE kind = 'embed' AND lease_expires > ?1 AND attempts < max_attempts`,
  vecCount: `SELECT count(*) AS n FROM nodes_vec`,
} as const;

type Db = StoreHandle["driver"]["database"];

// ---------------------------------------------------------------------------
// Постановка: скан пополняет очередь, но НЕ является источником работы
// ---------------------------------------------------------------------------

function metaTablePresent(db: Db): boolean {
  return db.query(SQL.metaTableExists).get() !== null;
}

interface ScanResult {
  readonly candidates: number;
  readonly enqueued: number;
}

/**
 * Узел в работу, если вектора нет ИЛИ записанный хеш текста расходится с
 * текущим. Постановка идемпотентна (ux_jobs_dedup на kind+entity_id), поэтому
 * скан безопасен к повтору и к гонке с `remember`.
 */
function scanEnqueue(db: Db, write: boolean): ScanResult {
  const rows = db.query(SQL.eligible).all() as NodeRow[];
  const vecSet = new Set<number>(
    (db.query(SQL.vecRowids).all() as { r: number }[]).map((x) => Number(x.r)),
  );
  const meta = new Map<string, string>();
  if (metaTablePresent(db)) {
    for (const r of db.query(SQL.metaAll).all() as { id: string; h: string }[]) {
      meta.set(r.id, r.h);
    }
  }
  let candidates = 0;
  let enqueued = 0;
  const todo = rows.filter(
    (r) =>
      r.deleted_at === null &&
      r.head_id === null &&
      r.status !== "superseded" &&
      r.layer >= 1 &&
      nodeText(r).length > 0 &&
      (!vecSet.has(r.rowid) || meta.get(r.id) !== r.content_hash),
  );
  candidates = todo.length;
  if (write && todo.length > 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of todo) {
        const res = jobs.enqueue(db, "embed", {
          entityId: r.id,
          scope: r.scope,
          payload: { reason: vecSet.has(r.rowid) ? "changed" : "missing" },
        });
        if (res.inserted) enqueued++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { candidates, enqueued };
}

// ---------------------------------------------------------------------------
// Разбор одной работы
// ---------------------------------------------------------------------------

interface JobPayload {
  readonly reason?: string;
  readonly f32?: boolean;
}

function payloadOf(job: jobs.JobRow): JobPayload {
  try {
    const p = JSON.parse(job.payload) as JobPayload;
    return typeof p === "object" && p !== null ? p : {};
  } catch {
    return {};
  }
}

/** Просит ли работа float32-кеш (промах переранжирования, vec-002). */
function wantsF32(payload: JobPayload): boolean {
  return payload.f32 === true || payload.reason === "rerank_miss";
}

type Plan =
  | { readonly kind: "complete"; readonly job: jobs.JobRow }
  | { readonly kind: "cleanup"; readonly job: jobs.JobRow; readonly node: NodeRow }
  | { readonly kind: "fail"; readonly job: jobs.JobRow; readonly error: string }
  | {
      readonly kind: "write";
      readonly job: jobs.JobRow;
      readonly node: NodeRow;
      /** int8-квант: свежий или скопированный у донора; null — nodes_vec не трогаем. */
      readonly int8: Buffer | null;
      /** float32 для кеша переранжирования; null — кеш не трогаем. */
      readonly f32: Buffer | null;
      /** Чем получен вектор: вызовом эмбеддера или копией по хешу содержимого. */
      readonly via: "embed" | "donor";
    };

interface DrainStats {
  claimed: number;
  embedded: number;
  copied: number;
  skipped: number;
  cleaned: number;
  failed: number;
  batches: number;
}

async function planJob(
  db: Db,
  embedder: IndexEmbedder,
  job: jobs.JobRow,
): Promise<Plan> {
  const entity = job.entity_id;
  if (entity === null) return { kind: "complete", job };
  const node = db.query(SQL.nodeById).get(entity) as NodeRow | null;
  if (node === null) return { kind: "complete", job };

  const gone = node.deleted_at !== null || node.status === "superseded";
  const indexable =
    !gone && node.head_id === null && node.layer >= 1 && nodeText(node).length > 0;
  if (!indexable) {
    // Узла в индексе быть не должно: убираем и вектор, и хеш, и кеш. Для
    // никогда не индексировавшихся (слой 0, пустой текст) удаления — no-op.
    return { kind: "cleanup", job, node };
  }

  const recordedHash = metaTablePresent(db)
    ? (db.query(`SELECT content_hash AS h FROM vec_embed_meta WHERE node_id = ?1`).get(node.id) as
        | { h: string }
        | null)?.h
    : undefined;
  const hasVec = db.query(SQL.hasVec).get(node.rowid) !== null;
  const unchanged = hasVec && recordedHash === node.content_hash;
  const payload = payloadOf(job);
  const f32Row = db.query(SQL.f32Get).get(node.id) as { f32: Uint8Array } | null;
  const needVec = !unchanged;
  const needF32 = wantsF32(payload) && f32Row === null;

  // Пропуск неизменённого: ни вектор, ни запрошенный кеш не требуют работы.
  if (!needVec && !needF32) return { kind: "complete", job };

  // Переиспользование по хешу содержимого (между ветками тоже): донор с тем
  // же текстом и актуальным вектором избавляет от вызова эмбеддера.
  const donorF32Row =
    (needF32 || (needVec && f32Row !== null))
      ? (db.query(SQL.donorF32).get(node.content_hash, node.id) as { f32: Uint8Array } | null)
      : null;
  const donorF32 =
    donorF32Row === null
      ? null
      : Buffer.from(donorF32Row.f32.buffer, donorF32Row.f32.byteOffset, donorF32Row.f32.byteLength);

  if (!needVec) {
    // Вектор актуален, нужен только кеш переранжирования.
    if (donorF32 !== null) return { kind: "write", job, node, int8: null, f32: donorF32, via: "donor" };
    const vec = await embedder.embed(nodeText(node));
    if (vec === null) return { kind: "fail", job, error: "эмбеддер не вернул вектор" };
    return { kind: "write", job, node, int8: null, f32: f32Blob(vec), via: "embed" };
  }

  const donor = db.query(SQL.donorVec).get(node.content_hash, node.id) as
    | { embedding: Uint8Array }
    | null;
  // Копия решает и int8, и (при наличии у донора) f32. Если кеш нужен, а у
  // донора его нет — один вызов эмбеддера закрывает обе потребности сразу.
  if (donor !== null && !(needF32 && donorF32 === null)) {
    return {
      kind: "write",
      job,
      node,
      int8: Buffer.from(donor.embedding.buffer, donor.embedding.byteOffset, donor.embedding.byteLength),
      f32: donorF32,
      via: "donor",
    };
  }

  const vec = await embedder.embed(nodeText(node));
  if (vec === null) return { kind: "fail", job, error: "эмбеддер не вернул вектор" };
  // f32 пишем, только если его просили или строка кеша уже существует и
  // протухла вместе с вектором: раздувать кеш на весь корпус нельзя (vec-002).
  const f32 = needF32 || f32Row !== null ? f32Blob(vec) : null;
  return { kind: "write", job, node, int8: quantize(vec), f32, via: "embed" };
}

// ---------------------------------------------------------------------------
// Дренаж очереди: батчи по REINDEX_BATCH_SIZE, чекпойнт после каждого
// ---------------------------------------------------------------------------

function applyBatch(db: Db, holder: string, plans: readonly Plan[], now: number): void {
  const vecDelete = db.prepare(SQL.vecDelete);
  const vecInsert = db.prepare(SQL.vecInsert);
  const metaUpsert = db.prepare(SQL.metaUpsert);
  const metaDelete = db.prepare(SQL.metaDelete);
  const f32Upsert = db.prepare(SQL.f32Upsert);
  const f32Delete = db.prepare(SQL.f32Delete);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const p of plans) {
      switch (p.kind) {
        case "complete":
          jobs.complete(db, p.job.id, holder);
          break;
        case "cleanup":
          vecDelete.run(p.node.rowid);
          metaDelete.run(p.node.id);
          f32Delete.run(p.node.id);
          jobs.complete(db, p.job.id, holder);
          break;
        case "fail":
          jobs.fail(db, p.job.id, p.error, { holder });
          break;
        case "write":
          if (p.int8 !== null) {
            vecDelete.run(p.node.rowid);
            vecInsert.run(
              p.node.rowid,
              p.node.scope,
              p.node.layer,
              p.node.kind,
              p.int8,
            );
            metaUpsert.run(p.node.id, p.node.content_hash, now);
          }
          if (p.f32 !== null) f32Upsert.run(p.node.id, p.f32, now);
          // Чекпойнт: работа снимается В ТОЙ ЖЕ транзакции, что и запись
          // вектора. Убитый процесс не оставляет ни сирот-векторов, ни
          // вечно висящих работ — батч либо весь случился, либо весь нет.
          jobs.complete(db, p.job.id, holder);
          break;
      }
    }
    // LRU-срез кеша переранжирования за потолком (vec-002/vec-003).
    const f32n = Number((db.query(SQL.f32Count).get() as { n: number }).n);
    if (f32n > F32_CACHE_LIMIT) db.query(SQL.f32Evict).run(f32n - F32_CACHE_LIMIT);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface DrainOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly holder: string;
}

async function drain(
  db: Db,
  embedder: IndexEmbedder,
  opts: DrainOptions,
): Promise<DrainStats> {
  const stats: DrainStats = {
    claimed: 0,
    embedded: 0,
    copied: 0,
    skipped: 0,
    cleaned: 0,
    failed: 0,
    batches: 0,
  };
  let waitedMs = 0;
  for (;;) {
    let batch = jobs.claim(db, ["embed"], opts.holder, {
      leaseMs: opts.leaseMs,
      limit: opts.batchSize,
    });
    if (batch.length === 0) {
      // Пустая выдача не всегда «работы нет»: батч убитого воркера ещё под
      // арендой. Ждём ближайшее истечение и пробуем снова — иначе прогон,
      // поднятый сразу после SIGKILL соседа, честно вышел бы с недоделанной
      // очередью. Ожидание ограничено двумя арендами: дольше — значит сосед
      // жив и разгребает сам, а дублировать его незачем (complete ограждён
      // holder, запись вектора идемпотентна по содержимому).
      const next = (db.query(SQL.earliestLease).get(Date.now()) as { t: number | null }).t;
      if (next === null || waitedMs > 2 * opts.leaseMs) break;
      const wait = Math.max(0, Number(next) - Date.now()) + 50;
      waitedMs += wait;
      await new Promise((r) => setTimeout(r, wait));
      batch = jobs.claim(db, ["embed"], opts.holder, {
        leaseMs: opts.leaseMs,
        limit: opts.batchSize,
      });
      if (batch.length === 0) continue;
    }
    waitedMs = 0;
    stats.claimed += batch.length;
    const plans: Plan[] = [];
    for (const job of batch) {
      plans.push(await planJob(db, embedder, job));
    }
    applyBatch(db, opts.holder, plans, Date.now());
    stats.batches++;
    for (const p of plans) {
      if (p.kind === "write") {
        if (p.via === "embed") stats.embedded++;
        else stats.copied++;
      } else if (p.kind === "complete") stats.skipped++;
      else if (p.kind === "cleanup") stats.cleaned++;
      else if (p.kind === "fail") stats.failed++;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

async function watchLoop(
  dbPath: string,
  debounceMs: number,
  pollMs: number,
  run: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  const fire = async (): Promise<void> => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      await run();
    } finally {
      running = false;
      if (dirty) {
        dirty = false;
        kick();
      }
    }
  };
  const kick = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void fire(), debounceMs);
  };
  const watcher: FSWatcher = fsWatch(dirname(dbPath), () => kick());
  const poll = setInterval(() => void fire(), pollMs);
  try {
    await new Promise<void>((res) => {
      process.once("SIGTERM", res);
      process.once("SIGINT", res);
    });
  } finally {
    watcher.close();
    clearInterval(poll);
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, ...(hint !== undefined ? { hint } : {}) };
}

function dbPathOf(ctx: CommandContext): string {
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  return ctx.globals.db ?? join(dir, ".myc", "myc.db");
}

const REINDEX_FLAGS: readonly FlagSpec[] = [
  { name: "batch", value: "number", description: `jobs per claim/checkpoint (default ${REINDEX_BATCH_SIZE})` },
  { name: "dry-run", description: "count what would be enqueued and done, write nothing" },
  { name: "watch", description: "keep running: re-drain 2s after each db write" },
];

export function createReindexCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "reindex",
    summary: "index the corpus via the shared jobs queue: batches of 50, checkpoints, content-hash skip",
    flags: REINDEX_FLAGS,
    help:
      "Turns corpus indexing into the `embed` job class of the shared jobs queue (S7): " +
      "a scan enqueues nodes whose vector is missing or whose text changed, then batches of " +
      "50 are taken via jobs.claim and committed per batch — a killed run resumes from the " +
      "last checkpoint instead of the beginning. Nodes whose content hash is unchanged are " +
      "never re-embedded, and a node whose text matches an already-indexed node (any branch) " +
      "reuses that vector. The embed_fingerprint check is mandatory: a mismatch is a refusal " +
      "(exit 5), not a warning — full space rebuilds stay with scripts/reindex-vectors.ts --force. " +
      "--watch keeps the worker alive, re-draining 2s after each write to the db.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const opened = await deps.openStore(ctx, VECTOR_OPEN);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        if (!h.vec0) {
          return failure(
            "precond.vec0_unavailable",
            `vec0 не загружен — векторный индекс недоступен (${h.vec0Reason ?? "причина не названа"})`,
            ExitCode.NOTFOUND,
            "myc doctor",
          );
        }
        const db = h.driver.database;
        try {
          db.query(SQL.vecCount).get();
        } catch {
          return failure(
            "precond.vec_schema",
            "векторная схема не накатывалась: нет nodes_vec",
            ExitCode.PRECOND,
            "myc doctor",
          );
        }

        const fake = fakeEmbedderFromEnv(process.env);
        let embedder: IndexEmbedder;
        if (fake !== null) {
          embedder = fake;
        } else {
          const r = await realEmbedder();
          if (!r.ok) return r.failure;
          embedder = r.embedder;
        }

        try {
          // Сверка отпечатка — ДО любой записи вектора этим прогоном.
          // Расхождение — отказ (PRECOND), не предупреждение: молчаливое
          // смешивание пространств видно месяцами, и ради его запрета вся
          // защита и ставилась.
          const recorded = (
            db.query(SQL.fpGet).get() as { value: string } | null
          )?.value;
          const check = checkFingerprint(recorded, embedder.fingerprint);
          if (!check.compatible) {
            return failure(
              "embed.fingerprint_mismatch",
              check.mismatch ?? "отпечаток векторного пространства не совпадает",
              ExitCode.PRECOND,
              "полная перестройка: bun run scripts/reindex-vectors.ts --force",
            );
          }

          const dryRun = flagBool(ctx, "dry-run");
          if (dryRun) {
            const scan = scanEnqueue(db, false);
            return {
              ok: true,
              data: {
                dry_run: true,
                candidates: scan.candidates,
                fingerprint: formatEmbedFingerprint(embedder.fingerprint),
              },
            };
          }

          const leaseMs = envMs(process.env, "MYC_REINDEX_LEASE_MS", REINDEX_LEASE_MS);
          const batchRaw = flagNum(ctx, "batch");
          const batchSize =
            batchRaw !== undefined && Number.isFinite(batchRaw) && batchRaw > 0
              ? Math.floor(batchRaw)
              : REINDEX_BATCH_SIZE;
          const holder = `reindex-${process.pid}`;

          const totals = {
            scans: 0,
            enqueued: 0,
            claimed: 0,
            embedded: 0,
            copied: 0,
            skipped: 0,
            cleaned: 0,
            failed: 0,
            batches: 0,
          };
          const pass = async (): Promise<void> => {
            const scan = scanEnqueue(db, true);
            const d = await drain(db, embedder, { batchSize, leaseMs, holder });
            totals.scans++;
            totals.enqueued += scan.enqueued;
            totals.claimed += d.claimed;
            totals.embedded += d.embedded;
            totals.copied += d.copied;
            totals.skipped += d.skipped;
            totals.cleaned += d.cleaned;
            totals.failed += d.failed;
            totals.batches += d.batches;
          };

          await pass();

          // Отпечаток фиксируется по факту успешного прогона (как у скрипта):
          // отказанный прогон базу не маркирует.
          db.prepare(SQL.fpSet).run(formatEmbedFingerprint(embedder.fingerprint));

          if (flagBool(ctx, "watch")) {
            const debounceMs = envMs(
              process.env,
              "MYC_REINDEX_WATCH_DEBOUNCE_MS",
              WATCH_DEBOUNCE_MS,
            );
            const pollMs = envMs(process.env, "MYC_REINDEX_WATCH_POLL_MS", WATCH_POLL_MS);
            await watchLoop(dbPathOf(ctx), debounceMs, pollMs, pass);
          }

          const total = Number((db.query(SQL.vecCount).get() as { n: number }).n);
          return {
            ok: true,
            data: {
              ...totals,
              vectors: total,
              fingerprint: formatEmbedFingerprint(embedder.fingerprint),
              took_ms: Math.round(performance.now() - t0),
            },
            ...(totals.failed > 0
              ? { meta: { degraded: [`отказов эмбеддера: ${totals.failed}`] } }
              : {}),
          };
        } finally {
          await embedder.destroy();
        }
      } finally {
        h.close();
      }
    },
  };
}
