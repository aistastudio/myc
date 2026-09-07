/**
 * Общая очередь фоновых работ поверх таблицы `jobs` (§8.1.7, решение S7).
 *
 * Одна таблица на все классы работ: эмбеддинги, absorb, дистилляция, проверка
 * якорей, checkpoint WAL, пересчёт приоров роя. Очередь эмбеддингов — класс
 * задач, а не свой механизм. Демона нет (решение S8): хвост очереди разгребает
 * следующий вызов CLI или живой MCP-процесс, поэтому все инварианты обязаны
 * держаться между НЕЗАВИСИМЫМИ ПРОЦЕССАМИ, а не внутри одного цикла событий.
 *
 * Отсюда главный инвариант и главный тест (jobs.test.ts, «аварийное
 * завершение»): **убитый посреди работы процесс не теряет и не дублирует
 * задачу**. Он держится на трёх вещах, и каждая проверена мутацией:
 *
 *  1. Захват — ОДИН стейтмент `UPDATE ... WHERE id IN (SELECT ...) RETURNING *`.
 *     Пара «SELECT кандидатов, потом UPDATE» в автокоммите даёт двойной захват:
 *     ровно этот дефект дважды стоил нам молчаливой потери записей (решения S38
 *     и S40, docs/design/ARCHITECTURE.md) и ни разу не был виден однопоточному
 *     тесту.
 *  2. Предикат захвата включает `lease_expires <= now`. Аренда — единственное,
 *     что мешает соседнему процессу забрать работу, которую кто-то уже делает.
 *  3. `fail` НЕ удаляет строку: исчерпавшая попытки работа остаётся в таблице
 *     с `last_error` — иначе диагностировать нечего, а `myc doctor` и
 *     /api/health показывают ноль вместо аварии.
 *
 * Состояния строки выражены колонками, отдельного `status` в схеме нет:
 *
 *   ждёт          attempts < max_attempts, lease_expires <= now, run_after <= now
 *   отложена      то же, но run_after > now (экспоненциальный откат после fail)
 *   в аренде      lease_holder <> '' и lease_expires > now
 *   мертва        attempts >= max_attempts  (терминальное; строка сохраняется)
 *   выполнена     строки нет (`complete` удаляет)
 *
 * Граница «мертва» = `attempts >= max_attempts` выбрана не нами: ровно так
 * packages/web/src/health.ts считает `jobs.failed` и `jobs.pending`, и так же
 * устроен `enqueueWarmJob` в CLI. Менять её нельзя, не сломав здоровье.
 *
 * Аренда, а не удаление-с-возвратом: работа остаётся в таблице всё время
 * выполнения, поэтому смерть процесса не теряет её — по истечении аренды
 * следующий `claim` (или `sweep`) забирает работу обратно.
 *
 * Функции принимают `Database` (bun:sqlite), а не `DbDriver`: так же устроены
 * частные помощники checkpoint.ts над этой же таблицей, а драйвер отдаёт
 * соединение как `driver.database`. `db.query()` в bun:sqlite кеширует
 * подготовленные стейтменты по тексту SQL — отдельный кеш здесь не нужен.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/**
 * Классы приоритета (решение S7): эмбеддинги > дистилляция > пересчёт приоров
 * роя. Меньшее число важнее. Числа согласованы с теми, что уже стоят в коде:
 * `embed` 3 (packages/cli/src/commands/remember.ts), `absorb` 5,
 * `anchor_check` 6, `compact` 7 (WAL_JOB_PRIORITY в ./checkpoint.ts).
 * Прогрев эмбеддера ставит себе 2 и обгоняет обычный embed — это осознанно.
 */
export const JOB_PRIORITY: Readonly<Record<string, number>> = {
  embed: 3,
  absorb: 5,
  distill: 5,
  anchor_check: 6,
  enrich: 6,
  compact: 7,
  export: 8,
  sync: 8,
  rescore: 9,
};

/** Приоритет для класса, которого нет в таблице выше (= DEFAULT схемы). */
export const DEFAULT_JOB_PRIORITY = 5;

/** Умолчание `max_attempts` — совпадает с DEFAULT схемы §8.1.7. */
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;

/**
 * Аренда по умолчанию — 60 с. Компромисс: длиннее оставляет работу мёртвого
 * процесса лежать дольше, короче рискует отобрать работу у живого, но
 * медленного (батч эмбеддингов в 50 узлов на CPU — единицы секунд).
 * Долгие работы обязаны просить аренду явно.
 */
export const DEFAULT_JOB_LEASE_MS = 60_000;

/** Первый откат после провала: 1 с, дальше вдвое на каждую попытку. */
export const JOB_BACKOFF_BASE_MS = 1_000;

/** Потолок отката: 5 минут. */
export const JOB_BACKOFF_CAP_MS = 300_000;

/** `last_error`, который ставит `sweep` брошенной работе. */
export const LEASE_EXPIRED_ERROR = "lease expired";

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/** Строка `jobs` как она лежит в базе (§8.1.7). */
export interface JobRow {
  readonly id: number;
  readonly kind: string;
  readonly entity_id: string | null;
  readonly scope: string;
  readonly priority: number;
  readonly run_after: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly lease_holder: string;
  readonly lease_expires: number;
  readonly payload: string;
  readonly last_error: string | null;
  readonly created_at: number;
}

export interface EnqueueOptions {
  /** Сущность, к которой привязана работа. Задан — постановка идемпотентна. */
  readonly entityId?: string | null;
  readonly scope?: string;
  /** По умолчанию — класс из JOB_PRIORITY, иначе DEFAULT_JOB_PRIORITY. */
  readonly priority?: number;
  /** Не раньше этого момента; по умолчанию — сейчас. */
  readonly runAfter?: number;
  /** Объект (будет сериализован) или готовая JSON-строка. */
  readonly payload?: string | Readonly<Record<string, unknown>>;
  readonly maxAttempts?: number;
  readonly now?: number;
}

export interface EnqueueResult {
  readonly id: number;
  /** false — работа уже стояла в очереди (сработал `ux_jobs_dedup`). */
  readonly inserted: boolean;
  /** Строка очереди: новая при inserted, иначе та, что уже лежала. */
  readonly row: JobRow;
}

export interface ClaimOptions {
  readonly leaseMs?: number;
  readonly limit?: number;
  readonly now?: number;
}

export interface FailResult {
  readonly id: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Попытки исчерпаны: строка осталась в таблице, но её больше не выдадут. */
  readonly dead: boolean;
  readonly runAfter: number;
}

export interface SweepResult {
  /** Сколько брошенных аренд вернулось в очередь. */
  readonly released: number;
  /** Сколько из них при этом исчерпало попытки. */
  readonly dead: number;
  readonly ids: readonly number[];
}

export interface JobKindStats {
  readonly kind: string;
  readonly total: number;
  /** Ждёт исполнителя (включая отложенные откатом). */
  readonly waiting: number;
  /** Из них готовы прямо сейчас: `run_after <= now`. */
  readonly ready: number;
  /** В работе под живой арендой. */
  readonly leased: number;
  /** Исчерпали попытки. Строки сохранены для диагностики. */
  readonly dead: number;
}

export interface JobStats {
  readonly now: number;
  readonly total: number;
  readonly waiting: number;
  readonly ready: number;
  readonly leased: number;
  readonly dead: number;
  readonly byKind: readonly JobKindStats[];
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// `INSERT ... ON CONFLICT DO NOTHING` с целью-частичным индексом, а не
// `INSERT OR IGNORE`: последний проглотил бы ЛЮБОЕ нарушение (NOT NULL, тип),
// то есть превратил бы ошибку вызывающего в тихую пустоту.
const SQL_ENQUEUE = `
INSERT INTO jobs (kind, entity_id, scope, priority, run_after, attempts,
                  max_attempts, lease_holder, lease_expires, payload, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, '', 0, ?7, ?8)
ON CONFLICT (kind, entity_id) WHERE entity_id IS NOT NULL DO NOTHING
RETURNING *`;

const SQL_FIND_DEDUP = `SELECT * FROM jobs WHERE kind = ?1 AND entity_id = ?2`;

// Захват одним стейтментом. Три вещи, которые нельзя разнимать:
//
//  * подзапрос кандидатов и запись живут в ОДНОМ стейтменте, то есть в одной
//    неявной транзакции записи; между ними нет окна, в которое влезет сосед;
//  * `lease_expires <= ?1` — единственное, что не даёт забрать чужую работу;
//    ноль в этой колонке означает «не в аренде», поэтому один предикат
//    покрывает и свободные строки, и брошенные;
//  * `(lease_holder <> '')` в SQLite даёт 1/0. Отбирая ПРОСРОЧЕННУЮ аренду, мы
//    засчитываем предыдущую выдачу как неудачную попытку — иначе работа,
//    которая убивает процесс, каталась бы по кругу вечно; `max_attempts`
//    проверяется по значению ПОСЛЕ этого инкремента, чтобы при max_attempts=1
//    выдача была ровно одна.
const SQL_CLAIM_HEAD = `
UPDATE jobs
   SET lease_holder  = ?2,
       lease_expires = ?1 + ?3,
       attempts      = attempts + (lease_holder <> '')
 WHERE id IN (
   SELECT id FROM jobs
    WHERE `;
const SQL_CLAIM_TAIL = `
      AND run_after <= ?1
      AND lease_expires <= ?1
      AND attempts + (lease_holder <> '') < max_attempts
    ORDER BY priority, run_after, id
    LIMIT ?4
 )
RETURNING *`;

const SQL_CLAIM_ANY = `${SQL_CLAIM_HEAD}1${SQL_CLAIM_TAIL}`;
const SQL_CLAIM_KINDS = `${SQL_CLAIM_HEAD}kind IN (SELECT value FROM json_each(?5))${SQL_CLAIM_TAIL}`;

const SQL_COMPLETE = `DELETE FROM jobs WHERE id = ?1`;
const SQL_COMPLETE_FENCED = `DELETE FROM jobs WHERE id = ?1 AND lease_holder = ?2`;

// Откат: base * 2^attempts, но не больше потолка. `attempts` внутри SET — это
// значение ДО инкремента (SQL так и определён), поэтому первый провал даёт
// ровно base. Сдвиг ограничен 20 битами, иначе int64 переполнится.
const BACKOFF_SQL = `?3 + min(?4, ?5 * (1 << min(attempts, 20)))`;

const SQL_FAIL = `
UPDATE jobs
   SET attempts      = attempts + 1,
       last_error    = ?2,
       lease_holder  = '',
       lease_expires = 0,
       run_after     = ${BACKOFF_SQL}
 WHERE id = ?1
RETURNING id, attempts, max_attempts, run_after`;

const SQL_FAIL_FENCED = `
UPDATE jobs
   SET attempts      = attempts + 1,
       last_error    = ?2,
       lease_holder  = '',
       lease_expires = 0,
       run_after     = ${BACKOFF_SQL}
 WHERE id = ?1 AND lease_holder = ?6
RETURNING id, attempts, max_attempts, run_after`;

const SQL_SWEEP = `
UPDATE jobs
   SET attempts      = attempts + 1,
       last_error    = ?2,
       lease_holder  = '',
       lease_expires = 0,
       run_after     = ?1 + min(?3, ?4 * (1 << min(attempts, 20)))
 WHERE lease_holder <> '' AND lease_expires <= ?1
RETURNING id, attempts, max_attempts`;

const SQL_STATS = `
SELECT kind,
       count(*) AS total,
       sum(attempts >= max_attempts)                                        AS dead,
       sum(attempts <  max_attempts AND lease_expires >  ?1)                AS leased,
       sum(attempts <  max_attempts AND lease_expires <= ?1)                AS waiting,
       sum(attempts <  max_attempts AND lease_expires <= ?1 AND run_after <= ?1) AS ready
  FROM jobs
 GROUP BY kind
 ORDER BY kind`;

const SQL_GET = `SELECT * FROM jobs WHERE id = ?1`;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Ставит работу в очередь. При заданном `entityId` постановка ИДЕМПОТЕНТНА:
 * частичный уникальный индекс `ux_jobs_dedup(kind, entity_id)` держит ровно
 * одну строку на пару, повторный вызов возвращает `inserted: false` и уже
 * лежащую строку (в том числе мёртвую — вызывающий видит её `attempts` и
 * `last_error` и решает сам). Без `entityId` дедупликации нет: индекс частичный
 * и NULL в него не попадает.
 */
export function enqueue(db: Database, kind: string, options: EnqueueOptions = {}): EnqueueResult {
  const now = options.now ?? Date.now();
  const entityId = options.entityId ?? null;
  const payload =
    options.payload === undefined
      ? "{}"
      : typeof options.payload === "string"
        ? options.payload
        : JSON.stringify(options.payload);
  const inserted = db
    .query(SQL_ENQUEUE)
    .get(
      kind,
      entityId,
      options.scope ?? "",
      options.priority ?? JOB_PRIORITY[kind] ?? DEFAULT_JOB_PRIORITY,
      options.runAfter ?? now,
      options.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
      payload,
      now,
    ) as JobRow | null;
  if (inserted !== null) return { id: inserted.id, inserted: true, row: inserted };

  // DO NOTHING сработал — значит строка на эту пару уже есть.
  const existing = db.query(SQL_FIND_DEDUP).get(kind, entityId) as JobRow | null;
  if (existing === null) {
    throw new Error(`jobs.enqueue: конфликт по (${kind}, ${String(entityId)}) без строки-владельца`);
  }
  return { id: existing.id, inserted: false, row: existing };
}

/**
 * Атомарно забирает до `limit` работ под аренду `holder`. Пустой список видов
 * означает «любой вид». Возвращает строки уже с проставленной арендой,
 * в порядке приоритета.
 *
 * Один стейтмент — не стилистика, а условие корректности: см. шапку файла и
 * мутацию 1 в jobs.test.ts.
 */
export function claim(
  db: Database,
  kinds: readonly string[],
  holder: string,
  options: ClaimOptions = {},
): JobRow[] {
  if (holder.length === 0) throw new Error("jobs.claim: holder не может быть пустым");
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  const limit = options.limit ?? 1;
  if (limit <= 0) return [];
  const rows =
    kinds.length === 0
      ? (db.query(SQL_CLAIM_ANY).all(now, holder, leaseMs, limit) as JobRow[])
      : (db
          .query(SQL_CLAIM_KINDS)
          .all(now, holder, leaseMs, limit, JSON.stringify([...kinds])) as JobRow[]);
  // RETURNING отдаёт строки в порядке обхода UPDATE, а не в порядке ORDER BY
  // подзапроса; вызывающему нужен порядок приоритета.
  return rows.sort(
    (a, b) => a.priority - b.priority || a.run_after - b.run_after || a.id - b.id,
  );
}

/**
 * Работа сделана — строка снимается с очереди. `holder` (если передан)
 * ограждает от зомби: процесс, у которого аренду уже отобрали, не должен
 * закрывать работу, которую в этот момент делает кто-то другой.
 * Возвращает false, если снимать было нечего.
 */
export function complete(db: Database, id: number, holder?: string): boolean {
  const res =
    holder === undefined
      ? db.query(SQL_COMPLETE).run(id)
      : db.query(SQL_COMPLETE_FENCED).run(id, holder);
  return Number(res.changes) > 0;
}

/**
 * Работа провалилась: попытка засчитана, аренда снята, следующая выдача
 * отложена экспоненциальным откатом. Исчерпав `max_attempts`, строка переходит
 * в терминальное состояние и БОЛЬШЕ НЕ ВЫДАЁТСЯ — но остаётся в таблице с
 * `last_error`: это единственный след аварии для `myc doctor` и /api/health.
 *
 * Возвращает undefined, если строки нет или аренда уже не за `holder`.
 */
export function fail(
  db: Database,
  id: number,
  error: string,
  options: { readonly holder?: string; readonly now?: number } = {},
): FailResult | undefined {
  const now = options.now ?? Date.now();
  const row = (
    options.holder === undefined
      ? db
          .query(SQL_FAIL)
          .get(id, error, now, JOB_BACKOFF_CAP_MS, JOB_BACKOFF_BASE_MS)
      : db
          .query(SQL_FAIL_FENCED)
          .get(id, error, now, JOB_BACKOFF_CAP_MS, JOB_BACKOFF_BASE_MS, options.holder)
  ) as { id: number; attempts: number; max_attempts: number; run_after: number } | null;
  if (row === null) return undefined;
  return {
    id: row.id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    dead: row.attempts >= row.max_attempts,
    runAfter: row.run_after,
  };
}

/**
 * Возвращает в очередь работы с просроченной арендой — тех, кого убили посреди
 * дела. Просрочка засчитывается как неудачная попытка, иначе работа, роняющая
 * процесс, ходила бы по кругу вечно.
 *
 * `claim` и без sweep поднимет просроченную работу (у него тот же предикат по
 * `lease_expires`); sweep нужен там, где важно СОСТОЯНИЕ таблицы, а не выдача:
 * `myc doctor`, health и отчётность о мёртвых работах.
 */
export function sweep(db: Database, nowMs: number = Date.now()): SweepResult {
  const rows = db
    .query(SQL_SWEEP)
    .all(nowMs, LEASE_EXPIRED_ERROR, JOB_BACKOFF_CAP_MS, JOB_BACKOFF_BASE_MS) as Array<{
    id: number;
    attempts: number;
    max_attempts: number;
  }>;
  return {
    released: rows.length,
    dead: rows.filter((r) => r.attempts >= r.max_attempts).length,
    ids: rows.map((r) => r.id),
  };
}

/**
 * Срез очереди по видам работ: сколько ждёт, сколько в аренде, сколько мёртвых.
 * Для `myc doctor` и /api/health (там своя, более грубая сводка по той же
 * границе `attempts >= max_attempts`).
 */
export function stats(db: Database, nowMs: number = Date.now()): JobStats {
  const rows = db.query(SQL_STATS).all(nowMs) as Array<{
    kind: string;
    total: number;
    dead: number;
    leased: number;
    waiting: number;
    ready: number;
  }>;
  const byKind: JobKindStats[] = rows.map((r) => ({
    kind: r.kind,
    total: Number(r.total),
    waiting: Number(r.waiting),
    ready: Number(r.ready),
    leased: Number(r.leased),
    dead: Number(r.dead),
  }));
  const sum = (pick: (k: JobKindStats) => number): number =>
    byKind.reduce((acc, k) => acc + pick(k), 0);
  return {
    now: nowMs,
    total: sum((k) => k.total),
    waiting: sum((k) => k.waiting),
    ready: sum((k) => k.ready),
    leased: sum((k) => k.leased),
    dead: sum((k) => k.dead),
    byKind,
  };
}

/** Строка очереди по id. Для диагностики и тестов. */
export function get(db: Database, id: number): JobRow | undefined {
  return (db.query(SQL_GET).get(id) as JobRow | null) ?? undefined;
}
