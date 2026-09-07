/**
 * Кеш дайджестов: одна таблица `digest_cache(scope, profile, variant, seq,
 * payload)` и одна инвалидация — по `oplog.seq`, читаемому ИЗ БАЗЫ (S4,
 * ARCHITECTURE.md; задача memory-eb91mperrr2k). `prime` — это
 * profile='prime', счётчики очереди — profile='ready'.
 *
 * ЧЕМ ЭТО ОПАСНО. Кеш дайджеста — место, где ответ отдаётся, не посмотрев на
 * узлы. Устаревший дайджест внешне неотличим от свежего: агент получит
 * вчерашний CORE/DECISIONS и очередь, которой уже нет, и НЕ УЗНАЕТ об этом.
 * Это не медленный ответ, а молчаливая ложь, запрещённая И2. Поэтому модуль
 * держит ровно один инвариант:
 *
 *     попадание в кеш обязано быть неотличимо от повторного расчёта.
 *
 * Отсюда всё остальное; каждое решение закрыто тестом, и мутация решения
 * обязана ронять тест (digest-cache.test.ts, digest-cache.multiprocess.test.ts).
 *
 * 1. ВЕРСИЯ БАЗЫ — `max(oplog.seq)` СКОУПА, А НЕ `myc_meta.last_seq`.
 *    Описание задачи называет last_seq; это неверный источник, и вот
 *    почему. `last_seq` — счётчик ЛОКАЛЬНОГО сайта (`OpFactory.lastSeq`,
 *    пишется `persistSeq`): применение чужих операций (`applyOps` при
 *    `myc import`, merge, репликации) наполняет оплог, но локальный счётчик
 *    не двигает — он и не должен, это порядок СВОИХ операций. Кеш,
 *    привязанный к нему, пережил бы приезд чужих узлов и продолжил отдавать
 *    дайджест без них. `oplog.seq` — INTEGER PRIMARY KEY AUTOINCREMENT,
 *    растёт на ЛЮБОЙ строке оплога, чьей бы она ни была.
 *
 * 2. ПРОВЕРКА ИДЁТ В БАЗУ, А НЕ В ПАМЯТЬ ПРОЦЕССА. На этом держится
 *    кросс-процессность: one-shot CLI пишет, MCP-сервер читает, и второй
 *    видит инвалидацию первого немедленно — без файловых локов, которыми ту
 *    же задачу решает socraticode (S26). Кеш, инвалидирующийся только
 *    своими же записями, прошёл бы любой однопроцессный тест.
 *
 * 3. СРАВНЕНИЕ SEQ СТОИТ В SQL, В ТОМ ЖЕ ЕДИНСТВЕННОМ STATEMENT.
 *    {@link DIGEST_LOOKUP} читает хвост оплога и запись кеша ОДНИМ
 *    запросом и отдаёт `payload` только при совпадении seq: устаревший
 *    payload физически не покидает SQLite. Разложи это на два запроса и
 *    ветку `if` — и появится место, где вчерашний дайджест уже в памяти
 *    процесса и его отделяет от выдачи одно условие.
 *
 * 4. SEQ ЧИТАЕТСЯ ДО РАСЧЁТА, А НЕ ПОСЛЕ. Порядок — не стиль, а
 *    правильность. Между чтением базы и записью кеша соседний процесс
 *    успевает записать; ярлык, поставленный ПОСЛЕ расчёта, пометил бы
 *    старый payload новым seq — и следующий читатель получил бы устаревший
 *    дайджест как свежий. Ярлык, поставленный ДО, в худшем случае стоит
 *    лишнего промаха. Поэтому порядок зашит в {@link digestCached}
 *    структурой, а не дисциплиной вызывающего.
 *
 * 5. ВАРИАНТ — ЧАСТЬ КЛЮЧА. Один профиль в одном скоупе законно ветвится
 *    тем, что меняет ВЫДАЧУ, а не базу: у `prime` это сессия (S58) и
 *    репозиторий (S59). Без варианта дайджест сессии A отдавался бы сессии
 *    B при том же seq — фильтр охвата обходился бы попаданием в кеш, то
 *    есть это утечка, а не промах производительности.
 *
 * 6. ПОПАДАНИЕ И ПРОМАХ ВИДНЫ. {@link DigestLookup.cache} — "hit" | "miss",
 *    и промах различает `cold` (записи нет) и `stale` (база ушла вперёд).
 *    Подвал `myc prime` печатает это словом ("cache hit"/"cache miss") — по
 *    тому же образцу, что `mode_used.cache` у кеша поиска
 *    (packages/retrieval/src/cache.ts).
 *
 * ЧЕГО ЗДЕСЬ НЕТ. TTL: у кеша поиска он стоит СВЕРХ seq, потому что туда
 * входит буст свежести от `now`; дайджест же — чистая функция от (база,
 * scope, вариант) и часов не касается вовсе. TTL был бы мёртвой веткой,
 * которая никогда не срабатывает первой и чей отказ ничем не виден.
 * Обоснование целиком — в докстроке миграции 008.
 */

import { defineQueries, type DbDriver } from "./sql.ts";

/**
 * Профили дайджеста. Стык S4: лейны называли одну и ту же вещь двумя
 * именами (`prime_cache` и `digest_cache`) — имя одно, таблица одна, а
 * `prime` это ЗНАЧЕНИЕ колонки, а не отдельный механизм.
 */
export const DIGEST_PROFILE_PRIME = "prime";
/** Счётчики подвала очереди (`blocked`/`in_progress`/охват репозитория). */
export const DIGEST_PROFILE_READY = "ready";

export const DIGEST_PROFILES = [DIGEST_PROFILE_PRIME, DIGEST_PROFILE_READY] as const;
export type DigestProfile = (typeof DIGEST_PROFILES)[number];

export const digestCacheQueries = defineQueries({
  /**
   * ОДИН statement: хвост оплога скоупа + запись кеша + решение о её
   * годности. `payload` возвращается ТОЛЬКО при совпадении seq — иначе
   * NULL, и устаревшее значение не покидает базу (п. 3 в шапке).
   *
   * `FROM (SELECT max(...) ...)` — агрегат без GROUP BY, ровно одна строка
   * всегда, поэтому LEFT JOIN отдаёт `now_seq` и при отсутствующей записи
   * кеша: класть payload будет с чем. `max(seq) ... WHERE scope=?` берётся
   * одним спуском по ix_oplog_scope(scope, seq) — SEARCH ... USING COVERING
   * INDEX, без TEMP B-TREE (ловушка `bd memories myc-sqlite-tail-query`).
   */
  digest_lookup: {
    name: "digest_lookup",
    sql: `SELECT s.now_seq AS now_seq,
                 c.seq     AS entry_seq,
                 CASE WHEN c.seq = s.now_seq THEN c.payload END AS payload
            FROM (SELECT coalesce(max(seq), 0) AS now_seq FROM oplog WHERE scope = ?1) s
            LEFT JOIN digest_cache c
              ON c.scope = ?1 AND c.profile = ?2 AND c.variant = ?3`,
    params: ["scope", "profile", "variant"],
  },
  /** Положить/перезаписать запись профиля. Upsert по полному ключу. */
  digest_put: {
    name: "digest_put",
    sql: `INSERT INTO digest_cache (scope, profile, variant, seq, payload)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(scope, profile, variant)
          DO UPDATE SET seq = excluded.seq, payload = excluded.payload`,
    params: ["scope", "profile", "variant", "seq", "payload"],
  },
  /**
   * Выбросить кеш скоупа целиком. Нужен обслуживанию (`myc doctor`,
   * восстановление базы), а не горячему пути: обычная инвалидация — это
   * несовпадение seq, и она не требует записи вовсе.
   */
  digest_drop_scope: {
    name: "digest_drop_scope",
    sql: `DELETE FROM digest_cache WHERE scope = ?1`,
    params: ["scope"],
  },
});

/** Что случилось с кешем на этом вызове. Обязано быть видно (И2). */
export type DigestDisposition = "hit" | "miss";

/** Промах бывает разный, и разница видна вызывающему и тестам. */
export type DigestMissReason = "cold" | "stale";

export interface DigestKey {
  /** Воркспейс. Пустая строка — корневой скоуп, это законное значение. */
  readonly scope: string;
  readonly profile: DigestProfile;
  /** Чем профиль законно ветвится (сессия, репозиторий); "" — не ветвится. */
  readonly variant?: string;
}

export interface DigestLookup<T> {
  /** Версия базы СЕЙЧАС. С ней же и класть результат расчёта. */
  readonly seq: number;
  readonly cache: DigestDisposition;
  /** Почему промах; у попадания — undefined. */
  readonly reason: DigestMissReason | undefined;
  /** Значение только при попадании. */
  readonly payload: T | undefined;
}

interface LookupRow {
  readonly now_seq: number | null;
  readonly entry_seq: number | null;
  readonly payload: string | null;
}

/**
 * Прочитать кеш и версию базы ОДНИМ запросом.
 *
 * Разбор JSON отделён от решения о годности: битая запись (ручная правка
 * базы, оборванная запись старого формата) — это промах, а не исключение
 * посреди `myc prime`; она будет перезаписана расчётом.
 */
export function digestLookup<T>(db: DbDriver, key: DigestKey): DigestLookup<T> {
  const row = db.one<LookupRow>(digestCacheQueries.digest_lookup, [
    key.scope,
    key.profile,
    key.variant ?? "",
  ]);
  const seq = row?.now_seq ?? 0;
  if (row === undefined || row.entry_seq === null) {
    return { seq, cache: "miss", reason: "cold", payload: undefined };
  }
  if (row.payload === null) {
    return { seq, cache: "miss", reason: "stale", payload: undefined };
  }
  try {
    return { seq, cache: "hit", reason: undefined, payload: JSON.parse(row.payload) as T };
  } catch {
    return { seq, cache: "miss", reason: "stale", payload: undefined };
  }
}

/**
 * Положить результат, посчитанный при версии базы `seq`.
 *
 * `seq` — параметр, а не «текущий хвост»: он обязан быть тем, что прочитано
 * ДО расчёта (п. 4 в шапке). Читать хвост здесь значило бы пометить старый
 * payload новым seq, если соседний процесс успел записать за время расчёта.
 */
export function digestStore(db: DbDriver, key: DigestKey, seq: number, payload: unknown): void {
  db.run(digestCacheQueries.digest_put, [
    key.scope,
    key.profile,
    key.variant ?? "",
    seq,
    JSON.stringify(payload),
  ]);
}

/** Выбросить весь кеш скоупа. Возвращает число удалённых записей. */
export function digestDropScope(db: DbDriver, scope: string): number {
  return db.run(digestCacheQueries.digest_drop_scope, [scope]).changes;
}

export interface DigestResult<T> {
  readonly payload: T;
  readonly cache: DigestDisposition;
  readonly reason: DigestMissReason | undefined;
  /** Версия базы, при которой ответ верен. */
  readonly seq: number;
}

/**
 * Полный цикл: прочитать → при промахе посчитать → положить.
 *
 * ПОРЯДОК ЗАШИТ ЗДЕСЬ НАМЕРЕННО. Вызывающему не оставлено возможности
 * прочитать seq после расчёта: версия базы берётся тем же запросом, что и
 * запись кеша, то есть строго ДО `compute()`, и ею же помечается результат
 * (п. 4 в шапке). Пока эта функция — единственный путь к таблице в горячем
 * пути, порядок нельзя нарушить забывчивостью.
 */
export function digestCached<T>(
  db: DbDriver,
  key: DigestKey,
  compute: () => T,
): DigestResult<T> {
  const found = digestLookup<T>(db, key);
  if (found.cache === "hit" && found.payload !== undefined) {
    return { payload: found.payload, cache: "hit", reason: undefined, seq: found.seq };
  }
  const payload = compute();
  digestStore(db, key, found.seq, payload);
  return { payload, cache: "miss", reason: found.reason, seq: found.seq };
}
