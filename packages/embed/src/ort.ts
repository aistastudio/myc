/**
 * Связка с onnxruntime-web в режиме WASM внутри процесса Bun.
 *
 * Две неочевидные детали, найденные экспериментом (запирать нельзя):
 * 1. Экспорт "onnxruntime-web/wasm" под bun/node запрещён в exports map
 *    пакета ("node": null) — маппинг на dist-файл задаётся в tsconfig.json
 *    пакета (Bun уважает paths и в рантайме).
 * 2. ort грузит .wasm через fetch(), которому нельзя скармливать файловые
 *    пути — поэтому байты клеевого .wasm читаем сами и отдаём через
 *    env.wasm.wasmBinary; сама модель передаётся в сессию как Uint8Array.
 *
 * Модель на диске уже проверена по sha256 при fetch; здесь мы её читаем
 * с диска и не делаем ни одного сетевого вызова.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type OrtModule = typeof import("onnxruntime-web/wasm");

let ortPromise: Promise<OrtModule> | null = null;
let wasmBinarySet = false;

/** Каталог dist onnxruntime-web (переопределяется для собранного бинаря). */
export function ortDistDir(): string {
  const fromEnv = process.env.MYC_ORT_WASM_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  // Резолвим через node_modules (учитывает хоистинг и bun-стор).
  const pkgJson = Bun.resolveSync("onnxruntime-web/package.json", dirname(fileURLToPath(import.meta.url)));
  return join(dirname(pkgJson), "dist");
}

async function loadOrt(): Promise<OrtModule> {
  const ort = (await import("onnxruntime-web/wasm")) as OrtModule;
  if (!wasmBinarySet) {
    // Клеевой модуль ort импортирует сам; байты даём готовые.
    const ortAny = ort as unknown as {
      env: { wasm: { wasmPaths: string; numThreads: number; wasmBinary?: ArrayBuffer } };
    };
    ortAny.env.wasm.wasmPaths = `${ortDistDir()}/`;
    ortAny.env.wasm.wasmBinary = await Bun.file(
      join(ortDistDir(), "ort-wasm-simd-threaded.wasm"),
    ).arrayBuffer();
    wasmBinarySet = true;
  }
  return ort;
}

export interface SessionConfig {
  /** intra_op потоки query-сессии; по умолчанию 2 (§2.3), в воркерах 1. */
  readonly intraOpThreads?: number;
}

export interface LoadedSession {
  readonly session: import("onnxruntime-web/wasm").InferenceSession;
  readonly ort: OrtModule;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
}

/** ort-модуль для текущего контекста (главный поток/воркер), кэшируется. */
export function getOrt(): Promise<OrtModule> {
  if (ortPromise === null) ortPromise = loadOrt();
  return ortPromise;
}

export async function createSession(
  modelBytes: Uint8Array,
  config: SessionConfig = {},
): Promise<LoadedSession> {
  const ort = await getOrt();
  // Threads в JSC (Bun) на скорость этой модели не влияют, но остаются
  // по спеке: query-сессия 2, воркеры батчей 1.
  (ort as unknown as { env: { wasm: { numThreads: number } } }).env.wasm.numThreads =
    config.intraOpThreads ?? 2;
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return {
    session,
    ort,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
  };
}

/** Входы BertModel: input_ids/attention_mask/token_type_ids, все int64. */
export function buildFeeds(
  ort: OrtModule,
  inputIds: Int32Array,
  attentionMask: Int32Array,
  tokenTypeIds: Int32Array,
  batchSize: number,
  seqLen: number,
): Record<string, import("onnxruntime-web/wasm").Tensor> {
  const toI64 = (src: Int32Array): BigInt64Array => {
    const out = new BigInt64Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = BigInt(src[i]!);
    return out;
  };
  const tensor = (src: Int32Array) =>
    new ort.Tensor("int64", toI64(src), [batchSize, seqLen]);
  return {
    input_ids: tensor(inputIds),
    attention_mask: tensor(attentionMask),
    token_type_ids: tensor(tokenTypeIds),
  };
}
