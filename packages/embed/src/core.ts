/**
 * Ядро локального эмбеддера, общее для query-сессии (главный поток) и
 * воркеров пула: префикс роли → токенизация → inference → пулинг →
 * L2-нормализация → проверка размерности. Никакой сети, никаких
 * исключений наружу — ошибки возвращаются как {state, reason}.
 *
 * Всё, чем модели отличаются друг от друга (алгоритм токенизации, вид
 * пулинга, префиксы запроса и документа), приходит сюда СПЕЦИФИКАЦИЕЙ из
 * реестра. Ветвлений «если модель называется так-то» здесь нет: иначе
 * третья модель потребовала бы правок в пяти местах, а четвёртая — в
 * восьми, и одно из них забыли бы, причём молча.
 */

import type { EmbedRole, EmbedStateReason } from "./types.ts";
import { normalizeInPlace } from "./quantize.ts";
import { buildFeeds, createSession, type LoadedSession } from "./ort.ts";
import { WordPieceTokenizer, type TextTokenizer } from "./tokenizer.ts";
import { UnigramTokenizer } from "./tokenizer-unigram.ts";
import type { PoolingKind, TokenizerKind } from "./registry.ts";

export type { EmbedRole } from "./types.ts";

export interface CoreConfig {
  readonly modelOnnxPath: string;
  /** vocab.txt у WordPiece, tokenizer.json у Unigram. */
  readonly tokenizerPath: string;
  readonly tokenizerKind: TokenizerKind;
  readonly pooling: PoolingKind;
  readonly queryPrefix: string;
  readonly passagePrefix: string;
  readonly dim: number;
  readonly maxLenTokens: number;
  readonly intraOpThreads: number;
}

export interface EmbedOneOutcome {
  readonly vec: Float32Array | null;
  readonly ms: number;
  readonly reason?: EmbedStateReason;
}

export interface EmbedBatchOutcome {
  readonly vectors: (Float32Array | null)[];
  readonly reasons: (EmbedStateReason | undefined)[];
  readonly ms: number;
}

export interface LoadedCore {
  readonly tokenizer: TextTokenizer;
  readonly loaded: LoadedSession;
  readonly config: CoreConfig;
}

export function prefixFor(config: CoreConfig, role: EmbedRole): string {
  return role === "query" ? config.queryPrefix : config.passagePrefix;
}

/** Токенизатор по виду из спецификации; файл уже проверен по sha256. */
export async function loadTokenizer(
  kind: TokenizerKind,
  path: string,
): Promise<TextTokenizer> {
  const text = await Bun.file(path).text();
  return kind === "unigram"
    ? UnigramTokenizer.fromTokenizerJsonText(text)
    : WordPieceTokenizer.fromVocabText(text);
}

export async function loadCore(config: CoreConfig): Promise<LoadedCore> {
  const [tokenizer, modelBytes] = await Promise.all([
    loadTokenizer(config.tokenizerKind, config.tokenizerPath),
    Bun.file(config.modelOnnxPath).arrayBuffer(),
  ]);
  const loaded = await createSession(new Uint8Array(modelBytes), {
    intraOpThreads: config.intraOpThreads,
  });
  return { tokenizer, loaded, config };
}

/**
 * Пулинг последнего слоя в вектор на строку батча.
 *
 * `cls` — скрытое состояние первого токена (контракт bge).
 * `mean` — среднее по токенам ПОД МАСКОЙ ВНИМАНИЯ (контракт e5): паддинг
 * в среднее не входит, иначе длина соседа по батчу меняла бы вектор.
 * Затем L2 — векторное пространство единичной сферы, как ждёт квантизация.
 */
export function poolLastHidden(
  lastHidden: /* dims [batch, seq, dim] */ { data: Float32Array },
  batch: number,
  seqLen: number,
  dim: number,
  pooling: PoolingKind,
  attentionMask: Int32Array,
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    const vec = new Float32Array(dim);
    const base = b * seqLen * dim;
    if (pooling === "cls") {
      for (let d = 0; d < dim; d++) vec[d] = lastHidden.data[base + d]!;
    } else {
      let tokens = 0;
      for (let t = 0; t < seqLen; t++) {
        if (attentionMask[b * seqLen + t] === 0) continue;
        tokens++;
        const off = base + t * dim;
        for (let d = 0; d < dim; d++) vec[d] = vec[d]! + lastHidden.data[off + d]!;
      }
      if (tokens > 0) for (let d = 0; d < dim; d++) vec[d] = vec[d]! / tokens;
    }
    out.push(normalizeInPlace(vec));
  }
  return out;
}

export async function embedOne(
  core: LoadedCore,
  text: string,
  role: EmbedRole = "query",
): Promise<EmbedOneOutcome> {
  const started = performance.now();
  const { tokenizer, loaded, config } = core;
  const enc = tokenizer.encode(prefixFor(config, role) + text, config.maxLenTokens);
  const feeds = buildFeeds(
    loaded.ort,
    enc.inputIds,
    enc.attentionMask,
    enc.tokenTypeIds,
    1,
    enc.length,
  );
  let output;
  try {
    output = await loaded.session.run(feeds);
  } catch {
    return { vec: null, ms: performance.now() - started, reason: "inference_error" };
  }
  const hidden = output[loaded.outputNames[0]!];
  if (hidden === undefined) {
    return { vec: null, ms: performance.now() - started, reason: "inference_error" };
  }
  const dims = hidden.dims as readonly number[];
  const dim = dims[dims.length - 1]!;
  if (dim !== config.dim) {
    return {
      vec: null,
      ms: performance.now() - started,
      reason: "dimension_mismatch",
    };
  }
  const pooled = poolLastHidden(
    { data: hidden.data as Float32Array },
    1,
    enc.length,
    dim,
    config.pooling,
    enc.attentionMask,
  );
  return { vec: pooled[0] ?? null, ms: performance.now() - started };
}

/** Батч одним прогоном: паддинг до максимума батча. */
export async function embedManyInSession(
  core: LoadedCore,
  texts: readonly string[],
  role: EmbedRole = "passage",
): Promise<EmbedBatchOutcome> {
  const started = performance.now();
  const { tokenizer, loaded, config } = core;
  const prefix = prefixFor(config, role);
  const encoded = texts.map((t) => tokenizer.encode(prefix + t, config.maxLenTokens));
  const seqLen = encoded.reduce((m, e) => Math.max(m, e.length), 2);
  const batch = encoded.length;
  const pad = tokenizer.padId();

  const inputIds = new Int32Array(batch * seqLen).fill(pad);
  const attentionMask = new Int32Array(batch * seqLen);
  const tokenTypeIds = new Int32Array(batch * seqLen);
  for (let b = 0; b < batch; b++) {
    const e = encoded[b]!;
    inputIds.set(e.inputIds, b * seqLen);
    attentionMask.set(e.attentionMask, b * seqLen);
    tokenTypeIds.set(e.tokenTypeIds, b * seqLen);
  }

  const feeds = buildFeeds(loaded.ort, inputIds, attentionMask, tokenTypeIds, batch, seqLen);
  let output;
  try {
    output = await loaded.session.run(feeds);
  } catch {
    const ms = performance.now() - started;
    return {
      vectors: texts.map(() => null),
      reasons: texts.map(() => "inference_error" as const),
      ms,
    };
  }
  const hidden = output[loaded.outputNames[0]!];
  if (hidden === undefined) {
    const ms = performance.now() - started;
    return {
      vectors: texts.map(() => null),
      reasons: texts.map(() => "inference_error" as const),
      ms,
    };
  }
  const dims = hidden.dims as readonly number[];
  const dim = dims[dims.length - 1]!;
  if (dim !== config.dim) {
    const ms = performance.now() - started;
    return {
      vectors: texts.map(() => null),
      reasons: texts.map(() => "dimension_mismatch" as const),
      ms,
    };
  }
  const vectors = poolLastHidden(
    { data: hidden.data as Float32Array },
    batch,
    seqLen,
    dim,
    config.pooling,
    attentionMask,
  );
  return { vectors, reasons: texts.map(() => undefined), ms: performance.now() - started };
}
