/**
 * Кеши горячего пути ретривала (docs/design/02-retrieval-and-performance.md §2.6):
 * результаты поиска и гидратация узлов. Кеш эмбеддингов запросов живёт в
 * @myc/embed (packages/embed/src/cache.ts) — там же, где вектор рождается.
 *
 * ЧЕМ ЭТО ОПАСНО. Кеш поиска — единственное место в проекте, где ответ
 * можно отдать, не посмотрев в базу. Устаревший ответ внешне неотличим от
 * свежего: пользователь получит вчерашнюю выдачу и не узнает об этом. Это
 * ровно тот молчаливый обман, который запрещает И2, и он хуже медленного
 * поиска. Поэтому весь модуль устроен вокруг ОДНОГО инварианта:
 *
 *     попадание в кеш обязано быть неотличимо от повторного запроса к базе.
 *
 * Из инварианта следуют все решения ниже, и каждое закрыто тестом в
 * cache.test.ts (мутация решения обязана ронять тест):
 *
 * 1. ВАЛИДАЦИЯ ПО oplog.seq, А НЕ ПО TTL. Каждая запись помнит seq, при
 *    котором посчитана. На запрос читается текущий `MAX(seq) FROM oplog` —
 *    один спуск по INTEGER PRIMARY KEY (rowid), сотни наносекунд. Не совпал —
 *    промах. Проверка идёт В БАЗУ, а не в память процесса, поэтому запись из
 *    СОСЕДНЕГО процесса (one-shot CLI пишет, MCP-сервер читает) инвалидирует
 *    кеш немедленно и без файловых локов (урок socraticode, S26).
 *    `MAX(seq)`, а не `myc_meta.last_seq`: last_seq — счётчик локального
 *    сайта, а реплицированная операция от другого сайта двигает оплог, и
 *    кеш обязан её увидеть тоже.
 *
 * 2. TTL 60 с СВЕРХ seq. Seq ловит записи, но не ход часов, а буст свежести
 *    считается от `now`. Без TTL запись, сделанная сутки назад в неизменной
 *    базе, отдавала бы порядок суточной давности. TTL — не замена
 *    seq-валидации, а второе, независимое условие: истекает ЛИБО seq, ЛИБО срок.
 *
 * 3. ВЫЗЫВАЮЩИЙ — ЧАСТЬ КЛЮЧА. Таблица §2.6 перечисляет в ключе
 *    norm_query + scopes + layers + profile + limit, и этого НЕ ХВАТАЕТ:
 *    hybridSearch фильтрует по ACL внутри SQL, значит один и тот же запрос
 *    от разных вызывающих даёт РАЗНЫЕ выдачи. В долгоживущем процессе
 *    (MCP-сервер, демон) это была бы утечка чужих узлов через кеш, а не
 *    промах производительности. Поэтому в ключ входит весь FtsCaller.
 *
 * 4. КЛЮЧ НЕ ПОНИЖАЕТ РЕГИСТР. Кеш эмбеддингов регистр схлопывает (вектор
 *    от него не зависит), а здесь — нельзя: `isAnchorToken` разбирает
 *    ФОРМУ токена (ENOENT, camelCase), то есть "ENOENT" и "enoent" ведут к
 *    разным решениям триггера и разным ответам. Нормализация ключа — только
 *    trim и схлопывание пробелов, которые на разбор запроса не влияют.
 *
 * 5. КЛЮЧ ВКЛЮЧАЕТ ВЕСЬ ЭФФЕКТИВНЫЙ КОНФИГ. Веса RRF, коэффициенты бустов,
 *    профиль, размер пула — всё это меняет порядок выдачи. Хешируется
 *    конфиг целиком (~40 полей, sha1 по ~600 символам ≈ 2 мкс), а не
 *    перечисленные руками поля: список полей ржавеет при добавлении нового
 *    параметра, и это ржавение молча портит выдачу.
 *
 * 6. ДЕГРАДИРОВАННЫЙ ОТВЕТ НЕ КЕШИРУЕТСЯ. Ответ, посчитанный без вектора
 *    (эмбеддер грузится) или с degraded-источником, — это временная правда.
 *    Заморозить её на 60 с значит продлить деградацию после того, как она
 *    кончилась. Такие ответы отдаются, но не сохраняются (И2).
 *
 * 7. ПОПАДАНИЕ И ПРОМАХ ВИДНЫ. `mode_used.cache` — "hit" | "miss" | "off",
 *    по образцу подвала `myc prime` ("cache hit"/"cache miss").
 *
 * ЧТО КЕШ НЕ ДЕЛАЕТ: не живёт между процессами (одиночный CLI-вызов
 * умирает раньше, чем окупил бы чтение файла кеша — то же обоснование, что
 * у кеша эмбеддингов) и не поллит базу по таймеру — проверка ровно одна, в
 * начале запроса.
 */

import { createHash } from "node:crypto";
import { defineQueries, type DbDriver } from "@myc/core";
import type { FtsCaller } from "./fts.ts";

/** Записей в LRU результатов поиска (§2.6). */
export const DEFAULT_RESULT_CACHE_MAX = 512;
/** Срок жизни записи результата, мс (§2.6): второе условие сверх seq. */
export const DEFAULT_RESULT_TTL_MS = 60_000;
/** Записей в LRU гидратации узлов (§2.6). */
export const DEFAULT_HYDRATION_CACHE_MAX = 4096;
/**
 * Потолок точечной инвалидации гидратации. Если с прошлой проверки оплог
 * вырос больше чем на столько операций, точечный список менявшихся узлов
 * дороже, чем просто выбросить кеш целиком (bulk-import, merge из сети).
 */
export const HYDRATION_INVALIDATE_CAP = 512;

/** Что случилось с кешем на этом запросе. Обязано быть видно (И2). */
export type CacheDisposition = "hit" | "miss" | "off";

export const cacheQueries = defineQueries({
  /**
   * Текущий хвост оплога. `seq` — INTEGER PRIMARY KEY AUTOINCREMENT, то есть
   * rowid: SQLite берёт MAX одним спуском по правому краю B-дерева, без
   * скана и без TEMP B-TREE (ср. `bd memories myc-sqlite-tail-query`).
   * NULL (пустой оплог) читается как 0.
   */
  cacheOplogSeq: {
    name: "cacheOplogSeq",
    sql: `SELECT MAX(seq) AS seq FROM oplog`,
    params: [],
  },
  /**
   * Какие узлы менялись после указанного seq. Нужен ТОЛЬКО кешу гидратации:
   * выбросить 4096 записей из-за одной правки — это промахи на ровном месте,
   * а список менявшихся узлов стоит один запрос по rowid-диапазону.
   */
  cacheNodesChangedSince: {
    name: "cacheNodesChangedSince",
    sql: `SELECT DISTINCT entity_id AS id
            FROM oplog
           WHERE seq > ?1 AND entity = 'node'
           LIMIT ?2`,
    params: ["sinceSeq", "cap"],
  },
});

/**
 * Хвост оплога = версия базы для кешей. Один statement, читается ИЗ БАЗЫ
 * (не из памяти) — на этом держится кросс-процессная инвалидация.
 */
export function readOplogSeq(db: DbDriver): number {
  const row = db.one<{ seq: number | null }>(cacheQueries.cacheOplogSeq, []);
  return row?.seq ?? 0;
}

/** trim + схлопывание пробелов. Регистр НЕ трогается — см. п. 4 в шапке. */
export function normalizeCacheQuery(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/** Всё, что влияет на выдачу и потому обязано быть в ключе. */
export interface SearchCacheKeyParts {
  readonly text: string;
  readonly scopes: readonly string[];
  readonly layerMin: number;
  readonly layerMax: number;
  readonly limit: number;
  readonly vectorMode: string;
  /** ACL: разные вызывающие видят разные узлы — п. 3 в шапке. */
  readonly caller: FtsCaller;
  /** Эффективный конфиг целиком (после мержа с умолчаниями) — п. 5. */
  readonly config: unknown;
}

/**
 * Ключ записи. Скоупы и principals сортируются: порядок в списке на выдачу
 * не влияет, а без сортировки те же аргументы в другом порядке дали бы
 * промах.
 */
export function searchCacheKey(parts: SearchCacheKeyParts): string {
  const payload = JSON.stringify({
    q: normalizeCacheQuery(parts.text),
    s: [...parts.scopes].sort(),
    lo: parts.layerMin,
    hi: parts.layerMax,
    n: parts.limit,
    vm: parts.vectorMode,
    o: parts.caller.ownerId,
    t: parts.caller.teamId,
    a: parts.caller.agentId,
    p: [...parts.caller.principals].sort(),
    c: parts.config,
  });
  return createHash("sha1").update(payload).digest("hex");
}

/** Промах бывает разный, и разница видна в статистике. */
export type CacheMissReason = "cold" | "stale" | "expired";

export type SearchCacheLookup<V> =
  | { readonly outcome: "hit"; readonly value: V }
  | { readonly outcome: "miss"; readonly reason: CacheMissReason };

interface Entry<V> {
  readonly value: V;
  readonly seq: number;
  readonly storedAt: number;
}

/**
 * LRU результатов поиска со seq-валидацией и TTL. Форма API — по образцу
 * StatementCache (@myc/core sql.ts) и EmbedQueryCache (@myc/embed): один
 * стиль кешей в проекте, не три.
 */
export class SearchResultCache<V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly map = new Map<string, Entry<V>>();
  private hitCount = 0;
  private missCount = 0;
  private staleCount = 0;
  private expiredCount = 0;
  private evictionCount = 0;
  private storedCount = 0;
  private rejectedCount = 0;

  constructor(
    max: number = DEFAULT_RESULT_CACHE_MAX,
    ttlMs: number = DEFAULT_RESULT_TTL_MS,
  ) {
    this.max = Math.max(0, Math.floor(max));
    this.ttlMs = Math.max(0, ttlMs);
  }

  get size(): number {
    return this.map.size;
  }
  get hits(): number {
    return this.hitCount;
  }
  get misses(): number {
    return this.missCount;
  }
  /** Промахи именно из-за расхождения seq — цена записей в базу. */
  get staleDrops(): number {
    return this.staleCount;
  }
  /** Промахи именно из-за TTL. */
  get expiredDrops(): number {
    return this.expiredCount;
  }
  get evictions(): number {
    return this.evictionCount;
  }
  /** Сколько ответов реально положено (деградированные не кладутся). */
  get stored(): number {
    return this.storedCount;
  }
  /** Сколько ответов кеш отказался запоминать как деградированные. */
  get rejected(): number {
    return this.rejectedCount;
  }

  get(key: string, seq: number, nowMs: number): SearchCacheLookup<V> {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.missCount++;
      return { outcome: "miss", reason: "cold" };
    }
    // Порядок проверок значим: расхождение seq — более сильная новость, чем
    // истёкший срок, и в статистике они не должны сливаться.
    if (entry.seq !== seq) {
      this.map.delete(key);
      this.missCount++;
      this.staleCount++;
      return { outcome: "miss", reason: "stale" };
    }
    if (this.ttlMs > 0 && nowMs - entry.storedAt >= this.ttlMs) {
      this.map.delete(key);
      this.missCount++;
      this.expiredCount++;
      return { outcome: "miss", reason: "expired" };
    }
    this.hitCount++;
    this.map.delete(key);
    this.map.set(key, entry);
    return { outcome: "hit", value: entry.value };
  }

  /**
   * Положить ответ. `cacheable === false` — ответ деградированный: он
   * отдаётся вызывающему, но НЕ запоминается (п. 6 в шапке).
   */
  set(key: string, seq: number, nowMs: number, value: V, cacheable = true): void {
    if (!cacheable) {
      this.rejectedCount++;
      return;
    }
    if (this.max === 0) return;
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
        this.evictionCount++;
      }
    }
    this.map.set(key, { value, seq, storedAt: nowMs });
    this.storedCount++;
  }

  clear(): void {
    this.map.clear();
  }
}

/** Что сделала сверка кеша гидратации с оплогом. */
export interface HydrationRefresh {
  readonly seq: number;
  /** Сколько записей выброшено точечно. */
  readonly invalidated: number;
  /** Оплог ушёл слишком далеко — кеш сброшен целиком. */
  readonly cleared: boolean;
}

/**
 * LRU гидратации узлов (§2.6: ключ node_id, 4096 записей, инвалидация по
 * seq узла в оплоге).
 *
 * Точечность здесь принципиальна. Гидратация — это тела узлов, самая
 * дорогая часть ответа по объёму; сбрасывать все 4096 записей из-за одной
 * правки значит получить кеш, который в рабочей сессии (агент пишет и
 * читает вперемешку) никогда не попадает. Поэтому сверка спрашивает у
 * оплога СПИСОК менявшихся узлов после запомненного seq и выбрасывает
 * только их — один запрос по диапазону rowid. Полный сброс остаётся
 * запасным путём на случай, когда список слишком длинный
 * (HYDRATION_INVALIDATE_CAP): там дешевле выбросить всё, чем читать
 * тысячи id, и это честно видно в `cleared`.
 */
export class NodeHydrationCache<V> {
  private readonly max: number;
  private readonly map = new Map<string, V>();
  private seq = -1;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private invalidatedCount = 0;
  private clearCount = 0;

  constructor(max: number = DEFAULT_HYDRATION_CACHE_MAX) {
    this.max = Math.max(0, Math.floor(max));
  }

  get size(): number {
    return this.map.size;
  }
  get hits(): number {
    return this.hitCount;
  }
  get misses(): number {
    return this.missCount;
  }
  get evictions(): number {
    return this.evictionCount;
  }
  /** Сколько записей выброшено точечно по оплогу. */
  get invalidated(): number {
    return this.invalidatedCount;
  }
  /** Сколько раз кеш пришлось сбросить целиком. */
  get clears(): number {
    return this.clearCount;
  }
  /** Seq, на котором кеш признан актуальным; -1 — сверки ещё не было. */
  get validAtSeq(): number {
    return this.seq;
  }

  /**
   * Сверить кеш с оплогом. Обязана вызываться ДО чтения — иначе кеш отдаёт
   * тела, переписанные соседним процессом. Возвращает то, что сделала.
   */
  refresh(db: DbDriver, seqNow?: number): HydrationRefresh {
    const seq = seqNow ?? readOplogSeq(db);
    if (seq === this.seq) return { seq, invalidated: 0, cleared: false };
    if (this.seq < 0 || this.map.size === 0) {
      this.seq = seq;
      return { seq, invalidated: 0, cleared: false };
    }
    // seq уехал назад (компакция оплога, восстановление из бэкапа): что
    // именно менялось, восстановить нечем — сбрасываем целиком.
    if (seq < this.seq) {
      this.map.clear();
      this.clearCount++;
      this.seq = seq;
      return { seq, invalidated: 0, cleared: true };
    }
    const rows = db.all<{ id: string }>(cacheQueries.cacheNodesChangedSince, [
      this.seq,
      HYDRATION_INVALIDATE_CAP + 1,
    ]);
    if (rows.length > HYDRATION_INVALIDATE_CAP) {
      this.map.clear();
      this.clearCount++;
      this.seq = seq;
      return { seq, invalidated: 0, cleared: true };
    }
    let invalidated = 0;
    for (const row of rows) {
      if (this.map.delete(row.id)) invalidated++;
    }
    this.invalidatedCount += invalidated;
    this.seq = seq;
    return { seq, invalidated, cleared: false };
  }

  get(id: string): V | undefined {
    const value = this.map.get(id);
    if (value === undefined) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    this.map.delete(id);
    this.map.set(id, value);
    return value;
  }

  set(id: string, value: V): void {
    if (this.max === 0) return;
    if (this.map.has(id)) {
      this.map.delete(id);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
        this.evictionCount++;
      }
    }
    this.map.set(id, value);
  }

  clear(): void {
    this.map.clear();
    this.seq = -1;
  }

  /**
   * Готовый горячий путь: сверка с оплогом, отбор недостающих id, ОДИН
   * вызов `fetch` на всё недостающее (не N запросов), запись в кеш.
   * `fetch` получает только те id, которых нет; пустой список — запроса нет
   * вовсе, то есть полное попадание стоит один `MAX(seq)`.
   */
  hydrate(
    db: DbDriver,
    ids: readonly string[],
    fetch: (missing: readonly string[]) => Iterable<readonly [string, V]>,
    seqNow?: number,
  ): { values: Map<string, V>; hits: number; misses: number; refresh: HydrationRefresh } {
    const refresh = this.refresh(db, seqNow);
    const values = new Map<string, V>();
    const missing: string[] = [];
    let hits = 0;
    for (const id of ids) {
      const cached = this.get(id);
      if (cached === undefined) {
        missing.push(id);
        continue;
      }
      hits++;
      values.set(id, cached);
    }
    if (missing.length > 0) {
      for (const [id, value] of fetch(missing)) {
        this.set(id, value);
        values.set(id, value);
      }
    }
    return { values, hits, misses: missing.length, refresh };
  }
}
