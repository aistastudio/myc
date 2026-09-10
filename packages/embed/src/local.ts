/**
 * Локальный ONNX-эмбеддер (по умолчанию multilingual-e5-small-q8,
 * 384 dim, INT8; английская bge-small-en-v1.5-q8 доступна явным modelId).
 *
 * Жизненный цикл: модель есть на диске → warming (сессия грузится в
 * фоне) → ok. Модели нет → missing("model_not_downloaded") навсегда,
 * НИКАКОЙ сети: загрузка модели — отдельная команда (myc models fetch),
 * функция fetchModel() живёт в этом пакете, но из эмбеддера не зовётся.
 *
 * query_session — на главном потоке, одиночные тексты (поиск);
 * embedBatch — через пул воркеров (батчи не блокируют главный поток).
 */

import { checkModelPresence } from "./fetch.ts";
import { DEFAULT_MODEL_ID, getModelSpec } from "./registry.ts";
import {
  embedOne,
  loadCore,
  loadTokenizer,
  poolLastHidden,
  prefixFor,
  type CoreConfig,
  type LoadedCore,
} from "./core.ts";
import { EmbedBatchPool } from "./pool.ts";
import { formatEmbedFingerprint } from "./fingerprint.ts";
import type { TextTokenizer } from "./tokenizer.ts";
import {
  buildNativeFeeds,
  createNativeSession,
  getOrtNative,
  type LoadedNativeSession,
} from "./ort-native.ts";
import type {
  EmbedBatchResult,
  Embedder,
  EmbedResult,
  EmbedRole,
  EmbedState,
  EmbedStateReason,
  EmbedFingerprint,
} from "./types.ts";

/**
 * Рантайм инференса ONNX. "wasm" (onnxruntime-web) — дефолт и
 * единственный обязательный, работает везде, $0, офлайн. "native"
 * (onnxruntime-node) — opt-in, optionalDependency, ~6x быстрее (см.
 * docs/design/02a-ort-native.md, ARCHITECTURE.md §10 S31/S33).
 * Переключение ТОЛЬКО явное — инвариант И2 запрещает молчаливый выбор
 * "что быстрее": это и есть тихая деградация/непредсказуемость, и оно
 * же сделало бы замеры невоспроизводимыми.
 */
export type OrtBackend = "wasm" | "native";

export interface LocalEmbedderConfig {
  /** id из каталога MODELS. */
  readonly modelId?: string;
  /** Каталог моделей; по умолчанию MYC_MODELS_DIR или ~/.cache/myc/models. */
  readonly modelsDir?: string;
  /** L2-нормализация выхода; по умолчанию true (bge-small contract). */
  readonly normalize?: boolean;
  /** intra_op потоки query-сессии; по умолчанию 2 (§2.3), у native — 1. */
  readonly intraOpThreads?: number;
  /** Рантайм ONNX: "wasm" (дефолт) или "native" (opt-in, см. OrtBackend). */
  readonly ortBackend?: OrtBackend;
}

const NOT_OK_STATES: ReadonlySet<EmbedState> = new Set(["warming", "degraded", "missing"]);

interface NativeCore {
  readonly tokenizer: TextTokenizer;
  readonly loaded: LoadedNativeSession;
  readonly config: CoreConfig;
}

interface EmbedOutcome {
  readonly vec: Float32Array | null;
  readonly ms: number;
  readonly reason?: EmbedStateReason;
}

interface EmbedBatchOutcome {
  readonly vectors: (Float32Array | null)[];
  readonly reasons: (EmbedStateReason | undefined)[];
  readonly ms: number;
}

async function embedOneNative(
  core: NativeCore,
  text: string,
  role: EmbedRole,
): Promise<EmbedOutcome> {
  const started = performance.now();
  const { tokenizer, loaded, config } = core;
  const { dim, maxLenTokens } = config;
  const enc = tokenizer.encode(prefixFor(config, role) + text, maxLenTokens);
  const feeds = buildNativeFeeds(
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
  const outDim = dims[dims.length - 1]!;
  if (outDim !== dim) {
    return { vec: null, ms: performance.now() - started, reason: "dimension_mismatch" };
  }
  const pooled = poolLastHidden(
    { data: hidden.data as Float32Array },
    1,
    enc.length,
    outDim,
    config.pooling,
    enc.attentionMask,
  );
  return { vec: pooled[0] ?? null, ms: performance.now() - started };
}

/** Батч одним прогоном на native-сессии; отдельного пула воркеров нет —
 * native не блокирует главный JS-поток так, как WASM под JSC (см.
 * bench-ort-native.ts). */
async function embedManyNative(
  core: NativeCore,
  texts: readonly string[],
  role: EmbedRole,
): Promise<EmbedBatchOutcome> {
  const started = performance.now();
  const { tokenizer, loaded, config } = core;
  const { dim, maxLenTokens } = config;
  const prefix = prefixFor(config, role);
  const encoded = texts.map((t) => tokenizer.encode(prefix + t, maxLenTokens));
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

  const feeds = buildNativeFeeds(loaded.ort, inputIds, attentionMask, tokenTypeIds, batch, seqLen);
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
  const outDim = dims[dims.length - 1]!;
  if (outDim !== dim) {
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
    outDim,
    config.pooling,
    attentionMask,
  );
  return { vectors, reasons: texts.map(() => undefined), ms: performance.now() - started };
}

export class LocalEmbedder implements Embedder {
  private readonly spec: ReturnType<typeof getModelSpec>;
  private readonly normalize: boolean;
  /** Рантайм, выбранный явно конфигурацией (не переопределяется автоматикой). */
  readonly ortBackend: OrtBackend;
  private _state: EmbedState = "missing";
  private _reason: EmbedStateReason | undefined = "model_not_downloaded";
  private core: LoadedCore | null = null;
  private nativeCore: NativeCore | null = null;
  private pool: EmbedBatchPool | null = null;
  private initPromise: Promise<void> | null = null;
  private initDone = false;
  private destroyed = false;
  readonly fingerprint: EmbedFingerprint;

  constructor(config: LocalEmbedderConfig = {}) {
    this.spec = getModelSpec(config.modelId ?? DEFAULT_MODEL_ID);
    this.normalize = config.normalize ?? true;
    this.ortBackend = config.ortBackend ?? "wasm";
    this.fingerprint = {
      backend: "local",
      // "onnx-wasm"/"onnx-native": векторы разных рантаймов почти совпадают
      // (косинус измерен > 0.99999, не ровно 1.0 — см. ort-native.test.ts),
      // поэтому смешивать их в одном пространстве нельзя, отпечаток обязан
      // их различать.
      provider: `onnx-${this.ortBackend}`,
      model: this.spec.id,
      dim: this.spec.dim,
      normalize: this.normalize,
    };
    this.initPromise = this.init(config).finally(() => {
      this.initDone = true;
    });
  }

  private async init(config: LocalEmbedderConfig): Promise<void> {
    if (this.ortBackend === "native") {
      try {
        await getOrtNative();
      } catch (cause) {
        // Явный запрос native без установленного onnxruntime-node: внятная
        // ошибка с указанием, что поставить, а не падение по стеку —
        // сообщение уже собрано в getOrtNative().
        this._state = "degraded";
        this._reason = "native_unavailable";
        console.warn(String(cause));
        return;
      }
    }
    const presence = await checkModelPresence(this.spec.id, config.modelsDir);
    if (presence.status === "absent") {
      this._state = "missing";
      this._reason = "model_not_downloaded";
      return;
    }
    if (presence.status === "corrupt") {
      // Скачана, но байты не сходятся: деградация с внятной причиной,
      // лечится повторным `myc models fetch`.
      this._state = "degraded";
      this._reason = "load_error";
      console.warn(
        `[embed] model files do not match their checksums (${presence.badFiles.join(", ")}); run myc models fetch again, embeddings disabled`,
      );
      return;
    }
    this._state = "warming";
    this._reason = undefined;
    const coreConfig: CoreConfig = {
      modelOnnxPath: presence.modelOnnx,
      tokenizerPath: presence.tokenizerPath,
      tokenizerKind: this.spec.tokenizer,
      pooling: this.spec.pooling,
      queryPrefix: this.spec.queryPrefix,
      passagePrefix: this.spec.passagePrefix,
      dim: this.spec.dim,
      maxLenTokens: this.spec.maxPositionTokens,
      // Отклонение от §2.3 (query intra_op=2), обоснованное замером: в
      // JSC (Bun) потоки ort не ускоряют эту модель вовсе, а инициализация
      // threads подменяет глобальный Worker и ломает батч-пул. Поэтому 1.
      intraOpThreads: config.intraOpThreads ?? 1,
    };
    if (this.ortBackend === "native") {
      try {
        const [tokenizer, modelBytes] = await Promise.all([
          loadTokenizer(this.spec.tokenizer, presence.tokenizerPath),
          Bun.file(presence.modelOnnx).arrayBuffer(),
        ]);
        const loaded = await createNativeSession(new Uint8Array(modelBytes), {
          intraOpThreads: config.intraOpThreads ?? 1,
        });
        this.nativeCore = { tokenizer, loaded, config: coreConfig };
      } catch (cause) {
        this._state = "degraded";
        this._reason = "load_error";
        this.nativeCore = null;
        console.warn(
          `[embed] native model failed to load (${String(cause)}); embeddings disabled, BM25 and graph still work`,
        );
        return;
      }
      this._state = "ok";
      this._reason = undefined;
      return;
    }
    try {
      this.core = await loadCore(coreConfig);
    } catch (cause) {
      this._state = "degraded";
      this._reason = "load_error";
      this.core = null;
      console.warn(
        `[embed] local model failed to load (${String(cause)}); embeddings disabled, BM25 and graph still work`,
      );
      return;
    }
    this._state = "ok";
    this._reason = undefined;
  }

  get state(): EmbedState {
    return this._state;
  }

  get stateReason(): EmbedStateReason | undefined {
    return this._reason;
  }

  get fingerprintString(): string {
    return formatEmbedFingerprint(this.fingerprint);
  }

  async warmup(): Promise<EmbedState> {
    await this.initPromise;
    return this._state;
  }


  /**
   * Одиночный текст. Роль по умолчанию — "query": все живые вызовы
   * embed() в проекте кодируют запрос пользователя, а не документ.
   * Индексация корпуса идёт через embedBatch (роль "passage").
   */
  async embed(text: string, role: EmbedRole = "query"): Promise<EmbedResult> {
    if (this.destroyed) {
      return { vec: null, state: "degraded", reason: "load_error" };
    }
    if (!this.initDone) {
      // Инвариант И2: потребитель не ждёт — пока сессия грузится, он
      // работает без вектора. Явное ожидание — только warmup().
      return { vec: null, state: "warming" };
    }
    if (this.ortBackend === "native") {
      if (this._state !== "ok" || this.nativeCore === null) {
        return { vec: null, state: this._state, reason: this._reason };
      }
      const outcome = await embedOneNative(this.nativeCore, text, role);
      if (outcome.vec === null) {
        return { vec: null, state: "degraded", reason: outcome.reason, ms: outcome.ms };
      }
      return { vec: outcome.vec, state: "ok", ms: outcome.ms };
    }
    if (this._state !== "ok" || this.core === null) {
      return { vec: null, state: this._state, reason: this._reason };
    }
    const outcome = await embedOne(this.core, text, role);
    if (outcome.vec === null) {
      return { vec: null, state: "degraded", reason: outcome.reason, ms: outcome.ms };
    }
    return { vec: outcome.vec, state: "ok", ms: outcome.ms };
  }

  /** Пакет текстов. Роль по умолчанию — "passage": батч это индексация. */
  async embedBatch(
    texts: readonly string[],
    role: EmbedRole = "passage",
  ): Promise<EmbedBatchResult> {
    if (this.destroyed) {
      return this.allDegraded(texts.length, "load_error", 0);
    }
    if (!this.initDone) {
      return this.allWarming(texts.length);
    }
    if (this.ortBackend === "native") {
      if (this._state !== "ok" || this.nativeCore === null) {
        return this.allDegraded(texts.length, this._reason, 0);
      }
      const outcome = await embedManyNative(this.nativeCore, texts, role);
      const results: EmbedResult[] = texts.map((_, i) => {
        const vec = outcome.vectors[i] ?? null;
        if (vec === null) {
          return {
            vec: null,
            state: "degraded",
            reason: outcome.reasons[i] ?? "inference_error",
            ms: outcome.ms,
          };
        }
        return { vec, state: "ok", ms: outcome.ms };
      });
      const ok = results.filter((r) => r.state === "ok").length;
      return { results, ok, ms: outcome.ms };
    }
    if (this._state !== "ok" || this.core === null) {
      return this.allDegraded(texts.length, this._reason, 0);
    }
    if (this.pool === null) {
      this.pool = new EmbedBatchPool({ core: this.core.config });
    }
    const started = performance.now();
    const results = await this.pool.embedBatch(texts, role);
    const ok = results.filter((r) => r.state === "ok").length;
    return { results, ok, ms: performance.now() - started };
  }

  private allWarming(n: number): EmbedBatchResult {
    return {
      results: Array.from({ length: n }, () => ({
        vec: null,
        state: "warming" as const,
        ms: 0,
      })),
      ok: 0,
      ms: 0,
    };
  }

  private allDegraded(
    n: number,
    reason: EmbedStateReason | undefined,
    ms: number,
  ): EmbedBatchResult {
    return {
      results: Array.from({ length: n }, () => ({
        vec: null,
        state: NOT_OK_STATES.has(this._state) ? this._state : "degraded",
        reason: reason ?? "load_error",
        ms,
      })),
      ok: 0,
      ms,
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    try {
      await this.initPromise;
    } catch {
      // init уже зафиксировал состояние; освобождаем что есть.
    }
    if (this.pool !== null) await this.pool.destroy();
    if (this.core !== null) {
      await this.core.loaded.session.release().catch(() => {});
      this.core = null;
    }
    if (this.nativeCore !== null) {
      await this.nativeCore.loaded.session.release().catch(() => {});
      this.nativeCore = null;
    }
  }
}

export function createLocalEmbedder(config: LocalEmbedderConfig = {}): LocalEmbedder {
  return new LocalEmbedder(config);
}
