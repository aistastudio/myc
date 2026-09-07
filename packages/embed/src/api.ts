/**
 * API-бэкенд эмбеддингов (OpenAI-совместимый /v1/embeddings).
 *
 * Правила те же, что у локального: контракт Embedder, никаких
 * исключений по состоянию. Отличия: сеть — часть его работы (он и
 * есть сетевой), недоступность — degraded("backend_unreachable"),
 * неполная конфигурация — missing("api_not_configured").
 *
 * НИКАКОГО молчаливого переключения на локальную модель и обратно:
 * выбор бэкенда происходит один раз, явно, в createEmbedder();
 * отпечаток backend:"api" отличается, смешивание пространств
 * отсекается на записи (checkFingerprint).
 */

import { normalizeInPlace } from "./quantize.ts";
import { formatEmbedFingerprint } from "./fingerprint.ts";
import type {
  EmbedBatchResult,
  Embedder,
  EmbedResult,
  EmbedRole,
  EmbedState,
  EmbedStateReason,
  EmbedFingerprint,
} from "./types.ts";

export interface ApiEmbedderConfig {
  /** Например https://api.openai.com/v1 */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Ожидаемая размерность; вектор иного размера НЕ выдаётся. */
  readonly dim: number;
  /** Нормализовать вектор у нас; по умолчанию false. */
  readonly normalize?: boolean;
  readonly timeoutMs?: number;
  /** Подмена fetch (тесты). */
  readonly fetchImpl?: typeof fetch;
}

interface ApiEmbeddingsResponse {
  readonly data?: readonly { readonly embedding?: readonly number[] }[];
}

export class ApiEmbedder implements Embedder {
  private readonly fetchImpl: typeof fetch;
  private readonly normalize: boolean;
  private readonly timeoutMs: number;
  readonly fingerprint: EmbedFingerprint;
  private readonly complete: boolean;

  constructor(readonly config: ApiEmbedderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.normalize = config.normalize ?? false;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.complete =
      config.baseUrl.trim() !== "" &&
      config.apiKey.trim() !== "" &&
      config.model.trim() !== "" &&
      Number.isFinite(config.dim) &&
      config.dim > 0;
    this.fingerprint = {
      backend: "api",
      provider: "openai-compatible",
      model: config.model,
      dim: config.dim,
      normalize: this.normalize,
    };
  }

  get state(): EmbedState {
    return this.complete ? "ok" : "missing";
  }

  get stateReason(): EmbedStateReason | undefined {
    return this.complete ? undefined : "api_not_configured";
  }

  get fingerprintString(): string {
    return formatEmbedFingerprint(this.fingerprint);
  }

  async warmup(): Promise<EmbedState> {
    return this.state;
  }

  private finish(vec: Float32Array | null, reason: EmbedStateReason | undefined, ms: number): EmbedResult {
    if (vec === null) return { vec: null, state: reason === "api_not_configured" ? "missing" : "degraded", reason, ms };
    return { vec, state: "ok", ms };
  }

  /**
   * `role` контрактом принимается, но API-моделям не нужен: у
   * text-embedding-3 и совместимых нет обучающих префиксов запроса и
   * документа. Игнорируем осознанно, а не по забывчивости.
   */
  async embed(text: string, _role?: EmbedRole): Promise<EmbedResult> {
    const started = performance.now();
    if (!this.complete) {
      return { vec: null, state: "missing", reason: "api_not_configured", ms: 0 };
    }
    const raw = await this.requestOne([text], started);
    return raw;
  }

  async embedBatch(
    texts: readonly string[],
    _role?: EmbedRole,
  ): Promise<EmbedBatchResult> {
    const started = performance.now();
    if (!this.complete) {
      return {
        results: texts.map(() => ({ vec: null, state: "missing" as const, reason: "api_not_configured" as const })),
        ok: 0,
        ms: 0,
      };
    }
    if (texts.length === 0) return { results: [], ok: 0, ms: 0 };
    // OpenAI-совместимый API принимает массив input одним запросом.
    const response = await this.call(texts);
    if (!Array.isArray(response)) {
      return {
        results: texts.map(() => ({
          vec: null,
          state: "degraded" as const,
          reason: response,
        })),
        ok: 0,
        ms: performance.now() - started,
      };
    }
    const ok = response.filter((v) => v !== null).length;
    return {
      results: response.map((v) =>
        v !== null
          ? { vec: v, state: "ok" as const }
          : { vec: null, state: "degraded" as const, reason: "dimension_mismatch" as const },
      ),
      ok,
      ms: performance.now() - started,
    };
  }

  private async requestOne(input: readonly string[], started: number): Promise<EmbedResult> {
    const response = await this.call(input);
    if (!Array.isArray(response)) {
      return this.finish(null, response, performance.now() - started);
    }
    const vec = response[0] ?? null;
    if (vec === null) return this.finish(null, "dimension_mismatch", performance.now() - started);
    return this.finish(vec, undefined, performance.now() - started);
  }

  /** EmbedStateReason = причина деградации; Float32Array[] = готовые векторы. */
  private async call(
    input: readonly string[],
  ): Promise<EmbedStateReason | Float32Array[]> {
    let response: Response;
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/embeddings`;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model: this.config.model, input: [...input] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return "backend_unreachable";
    }
    if (!response.ok) return "backend_unreachable";
    let parsed: ApiEmbeddingsResponse;
    try {
      parsed = (await response.json()) as ApiEmbeddingsResponse;
    } catch {
      return "backend_unreachable";
    }
    const data = parsed.data;
    if (data === undefined || data.length !== input.length) return "backend_unreachable";
    const out: Float32Array[] = [];
    for (const item of data) {
      const emb = item.embedding;
      if (emb === undefined || emb.length !== this.config.dim) {
        return "dimension_mismatch";
      }
      const vec = Float32Array.from(emb);
      out.push(this.normalize ? normalizeInPlace(vec) : vec);
    }
    return out;
  }

  async destroy(): Promise<void> {
    // Нечего освобождать: без сохранённых сессий и соединений.
  }
}

export function createApiEmbedder(config: ApiEmbedderConfig): ApiEmbedder {
  return new ApiEmbedder(config);
}
