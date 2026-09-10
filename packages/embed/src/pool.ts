/**
 * Батч-пул: N = clamp(floor(cores / 4), 1, 4) воркеров (§2.3), каждый
 * со своей сессией, intra_op = 1. Батчи ОБЯЗАНЫ идти вне главного
 * потока (дизайн запрещает блокировать MCP-цикл), поэтому фолбэка
 * «прогнать батч на главном потоке тихо» здесь нет: недоступность
 * пула — видимая деградация каждого элемента.
 */

import { cpus } from "node:os";
import type { CoreConfig } from "./core.ts";
import type { EmbedResult, EmbedRole } from "./types.ts";

/**
 * Ссылка на исходный Worker до загрузки ort: клеевой модуль ort при
 * numThreads > 1 подменяет глобальный Worker обёрткой без
 * addEventListener. Пул обязан жить при любом раскладе.
 */
const PristineWorker = globalThis.Worker;

export function batchPoolSize(): number {
  const cores = typeof cpus === "function" ? cpus().length : 1;
  return Math.max(1, Math.min(4, Math.floor(cores / 4)));
}

interface PendingRequest {
  resolve: (r: {
    vectors: (Float32Array | null)[];
    reasons: (string | undefined)[];
    ms: number;
  }) => void;
  reject: (e: unknown) => void;
}

interface WorkerSlot {
  worker: Worker;
  ready: Promise<void>;
  busy: boolean;
  pending: Map<number, PendingRequest>;
}

export class EmbedBatchPool {
  private readonly slots: WorkerSlot[] = [];
  private nextId = 1;
  private destroyed = false;
  private spawnFailure: string | null = null;

  constructor(
    private readonly options: {
      /** Конфигурация ядра целиком — воркер обязан получить ту же модель,
       * тот же токенизатор, тот же пулинг и те же префиксы, что и главный
       * поток; частичный набор полей уже приводил бы к двум пространствам. */
      readonly core: CoreConfig;
      readonly size?: number;
    },
  ) {}

  /** Ленивый старт: первый embedBatch поднимает пул. */
  private ensureStarted(): Promise<void> {
    if (this.spawnFailure !== null) return Promise.reject(new Error(this.spawnFailure));
    if (this.slots.length > 0) return Promise.resolve();
    const size = this.options.size ?? batchPoolSize();
    const workerUrl = new URL("./worker.ts", import.meta.url);
    for (let i = 0; i < size; i++) {
      let worker: Worker;
      try {
        worker = new PristineWorker(workerUrl, { type: "module" }) as Worker;
      } catch (cause) {
        this.spawnFailure = `pool worker failed to start: ${String(cause)}`;
        return Promise.reject(new Error(this.spawnFailure));
      }
      const slot: WorkerSlot = { worker, ready: null as never, busy: false, pending: new Map() };
      slot.ready = new Promise<void>((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
          const data = event.data as { type: string; reason?: string };
          if (data.type === "ready") {
            worker.removeEventListener("message", onMessage);
            worker.addEventListener(
              "message",
              (e: MessageEvent) => this.onWorkerMessage(slot, e),
            );
            // Воркер готов; смерть позже — reject всех ожидающих запросов.
            worker.addEventListener(
              "error",
              (e: ErrorEvent) => this.failSlot(slot, e.message),
            );
            resolve();
          } else if (data.type === "error") {
            worker.removeEventListener("message", onMessage);
            reject(new Error(data.reason ?? "load_error"));
          }
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener(
          "error",
          (e: ErrorEvent) => {
            worker.removeEventListener("message", onMessage);
            reject(new Error(e.message));
          },
          { once: true },
        );
      });
      slot.ready.catch(() => {
        // Неудачный воркер больше не участвует; пул деградирует целиком:
        // частичный пул дал бы непредсказуемую пропускную способность.
        this.spawnFailure ??= "pool worker failed to initialize";
      });
      slot.worker.postMessage({ type: "init", core: this.options.core });
      this.slots.push(slot);
    }
    return Promise.all(this.slots.map((s) => s.ready)).then(() => undefined);
  }

  private failSlot(slot: WorkerSlot, message: string): void {
    this.spawnFailure ??= `pool worker crashed: ${message}`;
    for (const [, pending] of slot.pending) {
      pending.reject(new Error(this.spawnFailure));
    }
    slot.pending.clear();
    slot.busy = false;
  }

  private onWorkerMessage(slot: WorkerSlot, event: MessageEvent): void {
    const data = event.data as {
      type: string;
      id: number;
      vectors?: (Float32Array | null)[];
      reasons?: (string | undefined)[];
      ms?: number;
    };
    if (data.type !== "result") return;
    const pending = slot.pending.get(data.id);
    if (pending === undefined) return;
    slot.pending.delete(data.id);
    slot.busy = false;
    pending.resolve({
      vectors: data.vectors ?? [],
      reasons: data.reasons ?? [],
      ms: data.ms ?? 0,
    });
  }

  get size(): number {
    return this.slots.length;
  }

  async embedBatch(
    texts: readonly string[],
    role: EmbedRole = "passage",
  ): Promise<EmbedResult[]> {
    if (this.destroyed) {
      return texts.map(() => ({
        vec: null,
        state: "degraded" as const,
        reason: "pool_unavailable" as const,
      }));
    }
    let started: Promise<void>;
    try {
      started = this.ensureStarted();
      await started;
    } catch (cause) {
      void cause;
      return texts.map(() => ({
        vec: null,
        state: "degraded" as const,
        reason: "pool_unavailable" as const,
      }));
    }

    // Крупные непрерывные куски: меньше переключений, ровный паддинг внутри куска.
    const chunkCount = Math.min(this.slots.length, texts.length);
    const chunkSize = Math.ceil(texts.length / chunkCount);
    const chunks: { start: number; texts: string[] }[] = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
      chunks.push({ start: i, texts: texts.slice(i, i + chunkSize) as string[] });
    }

    // Смерть воркера посреди батча — деградация элементов куска, не исключение.
    const settled = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const slot = this.slots.find((s) => !s.busy) ?? this.slots[0]!;
        slot.busy = true;
        const id = this.nextId++;
        return new Promise<{ start: number; results: EmbedResult[] }>((resolve, reject) => {
          slot.pending.set(id, { resolve: (r) => {
            const results: EmbedResult[] = chunk.texts.map((_, i) => {
              const vec = r.vectors[i] ?? null;
              const reason = r.reasons[i];
              return vec !== null
                ? { vec, state: "ok" as const, ms: r.ms / chunk.texts.length }
                : {
                    vec: null,
                    state: "degraded" as const,
                    reason: (reason as EmbedResult["reason"]) ?? "inference_error",
                  };
            });
            resolve({ start: chunk.start, results });
          }, reject });
          slot.worker.postMessage({ type: "embed", id, texts: chunk.texts, role });
        });
      }),
    );

    const results: EmbedResult[] = new Array(texts.length);
    for (const outcome of settled) {
      if (outcome.status === "rejected") continue;
      const part = outcome.value;
      for (let i = 0; i < part.results.length; i++) {
        results[part.start + i] = part.results[i]!;
      }
    }
    // Куски, чей воркер умер, остаются незаполненными — заполняем деградацией.
    for (let i = 0; i < results.length; i++) {
      results[i] ??= {
        vec: null,
        state: "degraded",
        reason: "pool_unavailable",
      };
    }
    return results;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all(
      this.slots.map(
        (slot) =>
          new Promise<void>((resolve) => {
            const worker = slot.worker;
            const onDone = () => {
              worker.terminate();
              resolve();
            };
            worker.addEventListener("message", (e: MessageEvent) => {
              if ((e.data as { type: string }).type === "destroyed") onDone();
            });
            worker.addEventListener("error", onDone, { once: true });
            try {
              worker.postMessage({ type: "destroy" });
            } catch {
              onDone();
            }
            setTimeout(onDone, 2000);
          }),
      ),
    );
    this.slots.length = 0;
  }
}
