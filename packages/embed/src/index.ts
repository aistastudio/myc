/**
 * @myc/embed — эмбеддинги: локальный ONNX (по умолчанию многоязычная
 * multilingual-e5-small-q8, INT8, 384 dim, офлайн и бесплатно) и
 * опциональные OpenAI-совместимые API.
 *
 * Контракт: { vec, state: ok|warming|degraded|missing }; при
 * state !== "ok" потребитель НЕ ждёт и НЕ падает — работает без
 * вектора (инвариант И2, docs/design/ARCHITECTURE.md).
 *
 * Выбор бэкенда — только явно: createEmbedder({ backend: "local" | "api" }).
 * Молчаливое переключение local↔api запрещено; отпечаток пространства
 * (fingerprint) отсекает смешивание на записи.
 */

import type { Embedder } from "./types.ts";
import { LocalEmbedder, type LocalEmbedderConfig } from "./local.ts";
import { ApiEmbedder, type ApiEmbedderConfig } from "./api.ts";
import { CachedEmbedder, EmbedQueryCache } from "./cache.ts";

export const EMBEDDING_DIMENSIONS = 384;

export type { EmbedState, EmbedStateReason, EmbedResult, EmbedRole, EmbedBatchResult, Embedder, EmbedFingerprint, FingerprintCheck } from "./types.ts";
export { EMBED_DIM, BGE_SMALL_DIM } from "./types.ts";
export { LocalEmbedder, createLocalEmbedder, type LocalEmbedderConfig } from "./local.ts";
export { ApiEmbedder, createApiEmbedder, type ApiEmbedderConfig } from "./api.ts";
export { EmbedBatchPool, batchPoolSize } from "./pool.ts";
export { WordPieceTokenizer, type EncodedText, type TextTokenizer } from "./tokenizer.ts";
export { UnigramTokenizer, normalizeUnigramInput } from "./tokenizer-unigram.ts";
export {
  quantizeInt8,
  dequantizeInt8,
  cosineSimilarity,
  normalizeInPlace,
  QuantizeError,
  type QuantizedVector,
} from "./quantize.ts";
export {
  formatEmbedFingerprint,
  parseEmbedFingerprint,
  checkFingerprint,
  ensureFingerprintCompatible,
  FingerprintMismatchError,
} from "./fingerprint.ts";
export {
  fetchModel,
  isModelPresent,
  resolveModelPaths,
  defaultModelsDir,
  modelDir,
  sha256File,
  FetchModelError,
  type FetchModelOptions,
  type FetchModelResult,
  type FetchProgress,
} from "./fetch.ts";
export {
  MODELS,
  DEFAULT_MODEL_ID,
  ENGLISH_MODEL_ID,
  getModelSpec,
  modelBytes,
  type ModelSpec,
  type ModelFileSpec,
  type TokenizerKind,
  type PoolingKind,
  type ModelLanguages,
} from "./registry.ts";
export { modelManifestPath } from "./model-id.ts";
export {
  CachedEmbedder,
  EmbedQueryCache,
  DEFAULT_EMBED_CACHE_MAX_ENTRIES,
  embedCacheKey,
  normalizeQueryText,
} from "./cache.ts";


/**
 * Кеш эмбеддингов запросов (§2.6). Умолчание — включён: вектор запроса
 * стоит 23 мс p50 под WASM и в бюджет поиска 25 мс не укладывается, так
 * что повторный запрос ОБЯЗАН обходиться бесплатно. Число — размер LRU;
 * false выключает обёртку целиком (например, в замерах самой модели, где
 * попадание испортило бы измерение).
 */
export type QueryCacheOption = boolean | number | EmbedQueryCache;

function wrapCache(inner: Embedder, option: QueryCacheOption | undefined): Embedder {
  if (option === false) return inner;
  if (option instanceof EmbedQueryCache) return new CachedEmbedder(inner, option);
  return new CachedEmbedder(inner, typeof option === "number" ? option : undefined);
}

/** Дискриминированный выбор бэкенда. Явный — поле обязательное. */
export type EmbedderConfig = { readonly queryCache?: QueryCacheOption } & (
  | ({ readonly backend: "local" } & LocalEmbedderConfig)
  | ({ readonly backend: "api" } & ApiEmbedderConfig)
);

/**
 * Единственная точка создания эмбеддера. Бэкенд задаёт конфигурация;
 * код потребителя переключать его самовольно не может.
 */
export function createEmbedder(config: EmbedderConfig): Embedder {
  if (config.backend === "api") {
    const { backend: _backend, queryCache, ...rest } = config;
    return wrapCache(new ApiEmbedder(rest), queryCache);
  }
  const { backend: _backend, queryCache, ...rest } = config;
  return wrapCache(new LocalEmbedder(rest), queryCache);
}
