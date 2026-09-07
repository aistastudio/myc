/**
 * Кеш эмбеддингов запросов (S31, docs/design/ARCHITECTURE.md §10).
 *
 * Причина: bge-small INT8 через onnxruntime-web WASM под Bun/JSC даёт
 * p50 23.3 мс / p95 98.9 мс на один запрос вместо заявленных 4-7 мс —
 * дело в WASM-движке, не в модели (замерено координатором). Раз вектор
 * запроса не укладывается в бюджет, повторный запрос обязан обходиться
 * бесплатно — это и есть данный кеш, а не опциональная оптимизация.
 *
 * Ключ = sha1(нормализованный текст) + embed_fingerprint. Отпечаток в
 * ключе обязателен: если он не совпадает, ключ просто не совпадёт с
 * прежним — старые вектора остаются в map, но недостижимы ни одним
 * новым запросом и вымываются политикой LRU естественным образом, без
 * явного clear(). Смешивание векторных пространств из разных моделей
 * (та самая тихая порча индекса) невозможно в принципе, а не "запрещено
 * по конвенции" — ровно то, ради чего в fingerprint.ts есть проверка.
 *
 * Нормализация перед хешированием: trim + схлопывание пробелов + lower-case.
 * Выбор — намеренно консервативный:
 *   - "  What is  Foo?  "  и  "what is foo?"      -> склеиваются (нужно:
 *     разный регистр/пробелы — тот же запрос, тот же вектор).
 *   - "Foo?" и "Foo"                              -> НЕ склеиваются (пунктуация
 *     сохранена: в запросах агента она часто значима — код, сообщения об
 *     ошибках, точные подстроки типа `foo()` vs `foo`).
 *   - "auth.ts" и "auth ts"                       -> НЕ склеиваются (более
 *     агрессивная нормализация — например, вырезание пунктуации —
 *     слепила бы разные идентификаторы файлов; это дороже, чем
 *     недополученное попадание в кеш).
 * Слишком слабая нормализация (без trim/lower-case) обнулила бы попадания
 * на самом частом случае — тот же вопрос, другой регистр или случайный
 * пробел на конце от CLI/MCP клиента.
 *
 * Размер по умолчанию: 1000 записей. Вектор bge-small — 384 × float32 =
 * 1536 байт; 1000 × 1536 байт = 1 536 000 байт (~1.46 MiB) на сами
 * вектора, плюс ключи (sha1 hex 40 симв. + отпечаток ~35-45 симв. ≈
 * 80 байт строки + служебные поля Map) — ещё ~150-200 КБ. Итого около
 * 1.6-1.7 МиБ на процесс. Обоснование числа: это не одиночный CLI-вызов
 * (там кеш бесполезен, см. ниже), а долгоживущий процесс — MCP-сервер
 * или ретривал внутри сессии; агентская сессия реально повторяет
 * десятки-сотни, не тысячи, различных формулировок запроса, так что
 * 1000 покрывает даже длинную сессию с большим запасом, а ~1.7 МиБ —
 * пренебрежимо против бюджета холодного старта 60 мс и обычного RSS
 * процесса на десятки МБ (И1, `bd memories myc-i1-speed`).
 *
 * Персистентность на диск сознательно не сделана: одиночный вызов CLI
 * живёт десятки миллисекунд — процесс завершается раньше, чем успел бы
 * прочитать файл кеша с диска, а чтение+десериализация сотен векторов
 * (сотни КБ - единицы МБ) на каждый холодный старт съело бы ровно то
 * время, которое кеш должен сэкономить. Кеш живёт только в памяти
 * процесса; в долгоживущих процессах (MCP-сервер) этого достаточно.
 */

import { createHash } from "node:crypto";
import { formatEmbedFingerprint } from "./fingerprint.ts";
import type {
  EmbedBatchResult,
  EmbedFingerprint,
  EmbedResult,
  EmbedRole,
  EmbedState,
  EmbedStateReason,
  Embedder,
} from "./types.ts";

/** См. обоснование числа в комментарии к файлу. */
export const DEFAULT_EMBED_CACHE_MAX_ENTRIES = 1000;

/**
 * trim + схлопывание пробелов + lower-case. Пунктуация и символы не
 * трогаются — см. обоснование в комментарии к файлу.
 */
export function normalizeQueryText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Ключ кеша: sha1(нормализованный текст) + отпечаток пространства. */
export function embedCacheKey(
  text: string,
  fingerprint: EmbedFingerprint | string,
): string {
  const fp =
    typeof fingerprint === "string"
      ? fingerprint
      : formatEmbedFingerprint(fingerprint);
  const hash = createHash("sha1")
    .update(normalizeQueryText(text))
    .digest("hex");
  return `${hash}:${fp}`;
}

/**
 * LRU-кеш вектор эмбеддинга запроса. Метрики и форма API — по образцу
 * StatementCache (packages/core/src/sql.ts), см. S31: один стиль
 * кешей в проекте, не два.
 */
export class EmbedQueryCache {
  private readonly max: number;
  private readonly map = new Map<string, Float32Array>();
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(max: number = DEFAULT_EMBED_CACHE_MAX_ENTRIES) {
    this.max = max;
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

  get(text: string, fingerprint: EmbedFingerprint): Float32Array | undefined {
    const key = embedCacheKey(text, fingerprint);
    const value = this.map.get(key);
    if (value === undefined) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(text: string, fingerprint: EmbedFingerprint, vec: Float32Array): void {
    const key = embedCacheKey(text, fingerprint);
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
        this.evictionCount++;
      }
    }
    this.map.set(key, vec);
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Эмбеддер с кешем запросов. Обёртка, а не поле внутри LocalEmbedder:
 * кеш нужен ОБОИМ бэкендам (у API-бэкенда попадание экономит сетевой
 * round-trip, а не 23 мс WASM), а логика у него одна.
 *
 * ЧТО КЕШИРУЕТСЯ. Только role="query". Роль "passage" — это индексация
 * корпуса: каждый текст встречается один раз, попаданий там не бывает по
 * построению, а место в LRU они бы вытеснили. embedBatch проходит насквозь
 * без изменений.
 *
 * ЧТО НЕ КЕШИРУЕТСЯ. Всё, кроме state === "ok": "warming" (модель ещё
 * грузится), "degraded", "missing". Запомнить их значило бы заморозить
 * деградацию после того, как она кончилась — прямой запрет И2.
 *
 * ВЕКТОР ОТДАЁТСЯ КОПИЕЙ. Потребители нормализуют и квантуют вектор на
 * месте (normalizeInPlace, quantizeInt8); отдай мы ссылку на хранимый
 * массив — первая же такая правка испортила бы кеш для всех последующих
 * запросов, причём молча. Копия 384×4 = 1536 байт стоит доли микросекунды
 * против 23 мс промаха.
 */
export class CachedEmbedder implements Embedder {
  readonly cache: EmbedQueryCache;
  /**
   * Кеш создан здесь, а не передан снаружи. Важно для destroy(): чужой
   * (процессный) кеш переживает конкретный эмбеддер — его чистит владелец.
   * Одноразовый эмбеддер, чистящий общий кеш, обнулял бы попадания ровно
   * там, ради чего кеш и заведён (долгоживущий MCP-процесс).
   */
  private readonly ownsCache: boolean;

  constructor(
    private readonly inner: Embedder,
    cache?: EmbedQueryCache | number,
  ) {
    this.ownsCache = !(cache instanceof EmbedQueryCache);
    this.cache =
      cache instanceof EmbedQueryCache
        ? cache
        : new EmbedQueryCache(cache ?? DEFAULT_EMBED_CACHE_MAX_ENTRIES);
  }

  get fingerprint(): EmbedFingerprint {
    return this.inner.fingerprint;
  }

  get state(): EmbedState {
    return this.inner.state;
  }

  get stateReason(): EmbedStateReason | undefined {
    return this.inner.stateReason;
  }

  async embed(text: string, role: EmbedRole = "query"): Promise<EmbedResult> {
    if (role !== "query") return this.inner.embed(text, role);
    const fp = this.inner.fingerprint;
    const hit = this.cache.get(text, fp);
    if (hit !== undefined) {
      return { vec: new Float32Array(hit), state: "ok", ms: 0, cached: true };
    }
    const result = await this.inner.embed(text, role);
    if (result.state === "ok" && result.vec !== null) {
      this.cache.set(text, fp, new Float32Array(result.vec));
    }
    return { ...result, cached: false };
  }

  embedBatch(texts: readonly string[], role?: EmbedRole): Promise<EmbedBatchResult> {
    return this.inner.embedBatch(texts, role);
  }

  warmup(): Promise<EmbedState> {
    return this.inner.warmup();
  }

  async destroy(): Promise<void> {
    if (this.ownsCache) this.cache.clear();
    await this.inner.destroy();
  }
}
