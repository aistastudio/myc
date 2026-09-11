/**
 * ФОНОВОЕ ОБНОВЛЕНИЕ КОД-ИНДЕКСА (memory-es8qwd555cjt): одно место, где
 * названы класс работы, порог возраста, аренда исполнителя и то, как
 * состояние обновления читается.
 *
 * Читают его три стороны: шаг дренажа, который СТАВИТ работу (drain.ts);
 * `myc code index --job`, который её ИСПОЛНЯЕТ; и те, кто говорит агенту,
 * насколько индексу можно верить, — строка статуса и WARN у `myc code …`.
 * Три копии порога разъехались бы молча: строка говорила бы «свежий», а фон
 * считал бы индекс устаревшим, или наоборот.
 *
 * СХЕМА.
 *   ставит    — шаг дренажа после любой успешной команды myc, в том числе
 *               `prime` хука старта сессии и `anchor touch` хука правки: индекс
 *               (или хоть один якорь, §4.3) есть, а последний ЗАВЕРШЁННЫЙ
 *               прогон старше порога → `jobs.enqueue('code_refresh', '.')`.
 *               Строка одна на воркспейс по `ux_jobs_dedup(kind, entity_id)`:
 *               десять агентов ставят одну и ту же;
 *   исполняет — отсоединённый `myc code index --job <id> --holder <h>`: дренаж
 *               сначала ЗАХВАТЫВАЕТ строку арендой (`jobs.claim` — один
 *               стейтмент), и только выигравший захват поднимает процесс. Чужая
 *               живая аренда = «уже обновляется», второго исполнителя нет;
 *   отметка   — `myc_meta.code_indexed_at` пишет ТОЛЬКО завершившийся прогон.
 *               Прежде её ставил дренаж ДО запуска воркера: не завершившийся
 *               воркер ничем не отличался от отработавшего. В базе cherry
 *               2026-09-11 так и лежало — отметка дренажа 20:15:42, своей
 *               отметки воркер не записал, последняя запись реестра 12:12.
 *
 * Модуль лёгкий намеренно: строка статуса грузит его на каждой отрисовке, и
 * граф модулей индекса (tree-sitter, хранилище) ей не по карману — здесь
 * только `bun:sqlite`, и тот типами.
 */

import type { Database } from "bun:sqlite";

/** Класс работы в общей очереди jobs: «сверь индекс воркспейса с деревом». */
export const CODE_REFRESH_JOB_KIND = "code_refresh";

/**
 * Сущность строки — воркспейс целиком (`.` — его корень, как у перечня git).
 * Не пустая строка: `''` в `entity_id` читается как «сущности нет», а
 * дедупликация держится именно на непустом ключе.
 */
export const CODE_REFRESH_ENTITY = ".";

/**
 * Отметка последнего ЗАВЕРШЁННОГО прогона по индексу целиком (не по части
 * вложенного репозитория). Единственное определение строки: команда, дренаж и
 * строка статуса берут её отсюда (`commands/code.ts` реэкспортирует).
 */
export const CODE_INDEXED_AT_KEY = "code_indexed_at";

/**
 * ПОРОГ N — 15 минут с последнего завершённого прогона. Цена прогона по
 * неизменённому дереву — обход перечня git с `stat` каждого файла (cherry:
 * 70–140 мс на 4369 файлах, этот репозиторий: 13 мс на 630) плюс разбор
 * только изменённого; чаще — значит платить обходом ради символов, которые
 * меняются от правки, а не от времени. Реже — агент дольше видит вчерашние
 * спаны. `myc code index` руками обновляет сразу, и WARN это говорит.
 * Переопределение — MYC_CODE_INDEX_PERIOD_MS (тесты, замеры).
 */
export const CODE_REFRESH_AFTER_MS = 900_000;

/**
 * Аренда исполнителя — 5 минут. Прогон по cherry — секунды; аренда нужна на
 * случай, когда исполнитель УМЕР: его строку заберёт следующий дренаж (попытка
 * засчитана), и «refreshing» в строке статуса не проживёт дольше этого.
 */
export const CODE_REFRESH_LEASE_MS = 300_000;

/** Приоритет — уровнем с `code_index` (8): фон, не обгоняет embed и absorb. */
export const CODE_REFRESH_PRIORITY = 8;

export function refreshAfterMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.MYC_CODE_INDEX_PERIOD_MS;
  if (raw === undefined || raw.trim().length === 0) return CODE_REFRESH_AFTER_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CODE_REFRESH_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

/**
 * running — исполнитель держит живую аренду; queued — строка ждёт исполнителя;
 * retry — прошлая попытка упала, повтор после отката; failed — попытки
 * исчерпаны (или исчерпаются первой же выдачей): фон больше не возьмётся сам.
 */
export type RefreshState = "running" | "queued" | "retry" | "failed";

export interface RefreshJob {
  readonly id: number;
  readonly state: RefreshState;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** null — упавший исполнитель не успел ничего сказать (умер, аренда истекла). */
  readonly lastError: string | null;
  /** running — когда истекает аренда; retry — когда повтор; иначе 0. */
  readonly until: number;
  readonly createdAt: number;
}

interface JobLike {
  id: number;
  attempts: number;
  max_attempts: number;
  lease_holder: string;
  lease_expires: number;
  run_after: number;
  last_error: string | null;
  created_at: number;
}

const SQL_REFRESH_ROW = `SELECT id, attempts, max_attempts, lease_holder, lease_expires, run_after, last_error, created_at
  FROM jobs WHERE kind = ?1 ORDER BY id LIMIT 1`;

/**
 * Состояние строки — выражением колонок, как в jobs.ts. Одна тонкость:
 * истёкшая аренда засчитывается попыткой при СЛЕДУЮЩЕЙ выдаче, поэтому строка
 * с `attempts + 1 >= max_attempts` и истёкшей арендой уже не будет выдана —
 * для читателя она мертва, хотя `attempts < max_attempts`.
 */
export function refreshStateOf(row: JobLike, now: number): RefreshState {
  if (attemptsOf(row, now) >= row.max_attempts) return "failed";
  if (row.lease_expires > now) return "running";
  if (row.run_after > now) return "retry";
  return "queued";
}

/**
 * Попытки с учётом той, что засчитается при следующей выдаче: исполнитель,
 * чья аренда истекла, умер, не успев ничего сказать, — это тоже попытка.
 */
export function attemptsOf(row: JobLike, now: number): number {
  return row.attempts + (row.lease_holder !== "" && row.lease_expires <= now ? 1 : 0);
}

/** Строка фонового обновления воркспейса; null — её нет (не нужна или уже выполнена). */
export function refreshJob(db: Database, now: number): RefreshJob | null {
  const row = db.query(SQL_REFRESH_ROW).get(CODE_REFRESH_JOB_KIND) as JobLike | null;
  if (row === null) return null;
  const state = refreshStateOf(row, now);
  return {
    id: row.id,
    state,
    attempts: attemptsOf(row, now),
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    until: state === "running" ? row.lease_expires : state === "retry" ? row.run_after : 0,
    createdAt: row.created_at,
  };
}

export interface IndexFreshness {
  /** Когда индекс в последний раз был сверен с деревом ЦЕЛИКОМ; 0 — неизвестно. */
  readonly refreshedAt: number;
  /**
   * run — отметка завершённого прогона; write — у базы без отметки (индекс
   * строила старая сборка или библиотека) последняя запись строки реестра;
   * none — ни того ни другого.
   */
  readonly source: "run" | "write" | "none";
  readonly ageMs: number;
  readonly thresholdMs: number;
  /** Старше порога. «Обновляется» — отдельно, в `job`. */
  readonly stale: boolean;
  readonly job: RefreshJob | null;
}

/**
 * Насколько индексу можно верить — одна функция на строку статуса и на WARN
 * код-команд. Цена: поиск по первичному ключу `myc_meta` и по индексу
 * `ix_jobs_pull(kind, …)`; скан `code_files` — только у базы без отметки.
 */
export function indexFreshness(db: Database, now: number, thresholdMs: number): IndexFreshness {
  const raw = (db.query("SELECT value FROM myc_meta WHERE key = ?1").get(CODE_INDEXED_AT_KEY) as { value: string } | null)
    ?.value;
  let refreshedAt = Number(raw ?? 0);
  let source: IndexFreshness["source"] = "run";
  if (!Number.isFinite(refreshedAt) || refreshedAt <= 0) {
    const w = db.query("SELECT max(indexed_at) AS at FROM code_files").get() as { at: number | null } | null;
    refreshedAt = Number(w?.at ?? 0);
    source = refreshedAt > 0 ? "write" : "none";
  }
  const ageMs = refreshedAt > 0 ? Math.max(0, now - refreshedAt) : Number.POSITIVE_INFINITY;
  return {
    refreshedAt,
    source,
    ageMs,
    thresholdMs,
    stale: ageMs >= thresholdMs,
    job: refreshJob(db, now),
  };
}

/**
 * Индексы воркспейса — различные `repo_id` в `code_files`. Скачками по
 * первичному ключу `(repo_id, path)`: шаг — `min(repo_id) > предыдущего`,
 * то есть O(k·log n) вместо прохода по всем строкам реестра.
 */
export function indexRepos(db: Database): string[] {
  const rows = db
    .query(
      `WITH RECURSIVE r(id) AS (
         SELECT (SELECT min(repo_id) FROM code_files)
         UNION ALL
         SELECT (SELECT min(repo_id) FROM code_files WHERE repo_id > r.id) FROM r WHERE r.id IS NOT NULL
       ) SELECT id FROM r WHERE id IS NOT NULL`,
    )
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
