/**
 * Контракт эмбеддера. Владелец контракта — @myc/embed; потребители:
 * ретривал и подсистема роя (стык S10).
 *
 * Инвариант И2 (docs/design/ARCHITECTURE.md): потребитель при
 * state !== "ok" НЕ ждёт и НЕ падает — он работает без вектора.
 * Поэтому embed()/embedBatch() никогда не бросают исключений по
 * причинам состояния и не блокируются на загрузке модели.
 */

/** Состояние эмбеддера. `warming` — модель есть, сессия ещё грузится. */
export type EmbedState = "ok" | "warming" | "degraded" | "missing";

/**
 * Причины не-ok состояний. Первые четыре — из §2.3
 * (02-retrieval-and-performance.md, «Громкая деградация»).
 */
export type EmbedStateReason =
  | "model_not_downloaded"
  | "backend_unreachable"
  | "dimension_mismatch"
  | "load_error"
  | "inference_error"
  | "pool_unavailable"
  | "api_not_configured"
  | "invalid_config"
  /** LocalEmbedderConfig.ortBackend === "native", но onnxruntime-node
   * (optionalDependency) не установлен или не загрузился под текущую
   * платформу. WASM остаётся дефолтом и работает независимо от этого. */
  | "native_unavailable";

/**
 * Роль текста в векторном пространстве: запрос или документ. Живёт в
 * контракте эмбеддера, потому что у e5-моделей запрос и документ имеют
 * разные обучающие префиксы (см. registry.ts).
 */
export type EmbedRole = "query" | "passage";

/** Результат одиночного эмбеддинга. */
export interface EmbedResult {
  /**
   * Вектор только при state === "ok"; иначе null.
   * Размерность равна fingerprint.dim (проверяется перед выдачей).
   */
  readonly vec: Float32Array | null;
  readonly state: EmbedState;
  /** Отсутствует при state === "ok". */
  readonly reason?: EmbedStateReason;
  /** Сколько занял сам эмбеддинг (токенизация + inference), мс. */
  readonly ms?: number;
  /**
   * Вектор отдан из кеша запросов (cache.ts), а не посчитан. undefined —
   * эмбеддер без кеша. Попадание обязано быть ВИДНО (И2, тот же образец,
   * что "cache hit"/"cache miss" в подвале `myc prime`): при попадании
   * `ms` равен нулю не потому, что модель стала быстрой.
   */
  readonly cached?: boolean;
}

/** Результат пакетного эмбеддинга: выравнен по индексам входа. */
export interface EmbedBatchResult {
  readonly results: readonly EmbedResult[];
  /** Сколько текстов реально ушло в вектор (state === "ok"). */
  readonly ok: number;
  readonly ms: number;
}

/** Отпечаток векторного пространства: backend + provider + model + dim + normalize. */
export interface EmbedFingerprint {
  readonly backend: "local" | "api";
  readonly provider: string;
  readonly model: string;
  readonly dim: number;
  readonly normalize: boolean;
}

/** Проверка записанного отпечатка против ожидаемого. */
export interface FingerprintCheck {
  readonly compatible: boolean;
  /** Не пусто, только если compatible === false. */
  readonly mismatch?: string;
}

/**
 * Интерфейс эмбеддера. Реализации: локальный ONNX и API-бэкенд.
 * Переключение — только явной конфигурацией (createEmbedder),
 * никакого молчаливого фолбэка между бэкендами.
 */
export interface Embedder {
  readonly fingerprint: EmbedFingerprint;
  /** Текущее состояние (последнее известное, без обращения к модели). */
  readonly state: EmbedState;
  /** Причина текущего не-ok состояния; undefined при "ok". */
  readonly stateReason: EmbedStateReason | undefined;
  /**
   * Один текст. Никогда не бросает по состоянию; не ждёт загрузки модели.
   * `role` — как кодировать текст: запрос или документ. У многоязычных
   * моделей семейства e5 это РАЗНЫЕ префиксы, и перепутать их — тихая
   * потеря качества, поэтому роль часть контракта, а не деталь реализации.
   * Умолчание "query": одиночный текст в проекте всегда запрос.
   */
  embed(text: string, role?: EmbedRole): Promise<EmbedResult>;
  /** Пакет текстов. Выравнен по входу, никогда не бросает по состоянию.
   * Умолчание роли — "passage": батч это индексация корпуса. */
  embedBatch(texts: readonly string[], role?: EmbedRole): Promise<EmbedBatchResult>;
  /**
   * Явное ожидание готовности. Для хостов, которым НАДО дождаться
   * (one-shot CLI показывает холодную загрузку честно); потребитель
   * ретривала этот метод вызывать не обязан.
   */
  warmup(): Promise<EmbedState>;
  /** Освободить сессии и воркеров. Повторные вызовы безопасны. */
  destroy(): Promise<void>;
}

/**
 * Размерность вектора, общая для обеих моделей каталога
 * (bge-small-en-v1.5 и multilingual-e5-small): схема nodes_vec от смены
 * модели по умолчанию не меняется, миграция не нужна — меняется отпечаток.
 */
export const EMBED_DIM = 384;

/** @deprecated имя привязано к одной модели; используй EMBED_DIM. */
export const BGE_SMALL_DIM = EMBED_DIM;
