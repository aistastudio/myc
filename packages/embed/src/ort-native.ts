/**
 * Нативный ORT-бэкенд на onnxruntime-node (N-API биндинг к libonnxruntime).
 *
 * Opt-in: дефолтом остаётся WASM (ort.ts) — он не требует нативных
 * зависимостей и работает везде, где работает Bun. Нативный бэкенд
 * включается явно и никогда не становится обязательной зависимостью:
 * onnxruntime-node объявлен optionalDependency, поэтому его отсутствие
 * (npm install --no-optional, неподдерживаемая платформа) не ломает
 * установку — loadOrtNative() вернёт понятную ошибку только при явном
 * запросе нативного бэкенда.
 *
 * Проверено экспериментом (замер в docs/design/02a-ort-native.md):
 * onnxruntime-node@1.20.1 загружается и исполняет модель под Bun 1.3
 * (N-API поддерживается). На bge-small INT8 384 нативный CPU-EP даёт
 * выигрыш против WASM по одиночному запросу и по батчам.
 */

// Пакеты друг у друга импортируют сырые .ts (exports указывает на
// ./src/index.ts, без сборки), поэтому чужой tsconfig типизирует этот файл
// своими глазами и не видит ort-node.d.ts (тот включён только через
// tsconfig самого @myc/embed). Без явной ссылки любой пакет, транзитивно
// тянущий @myc/embed, падает на "Could not find a declaration file for
// module 'onnxruntime-node'" — независимо от того, установлен ли сам пакет.
/// <reference path="./ort-node.d.ts" />
type OrtNodeModule = typeof import("onnxruntime-node");

let ortPromise: Promise<OrtNodeModule> | null = null;

/** ort-модуль нативного бэкенда, кэшируется. Бросает, если пакет недоступен. */
export function getOrtNative(): Promise<OrtNodeModule> {
  if (ortPromise === null) {
    ortPromise = import("onnxruntime-node").catch((cause: unknown) => {
      ortPromise = null;
      throw new Error(
        "нативный бэкенд недоступен: onnxruntime-node не загрузился " +
          `(${String(cause)}). Установи его (optionalDependency @myc/embed) ` +
          "или используй WASM-бэкенд по умолчанию",
      );
    });
  }
  return ortPromise;
}

export interface NativeSessionConfig {
  /** intra_op потоки; нативный рантайм их реально использует (в отличие от WASM под JSC). */
  readonly intraOpThreads?: number;
}

export interface LoadedNativeSession {
  readonly session: import("onnxruntime-node").InferenceSession;
  readonly ort: OrtNodeModule;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
}

export async function createNativeSession(
  modelBytes: Uint8Array,
  config: NativeSessionConfig = {},
): Promise<LoadedNativeSession> {
  const ort = await getOrtNative();
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    ...(config.intraOpThreads !== undefined
      ? { intraOpNumThreads: config.intraOpThreads }
      : {}),
  });
  return {
    session,
    ort,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
  };
}

/** Входы BertModel: input_ids/attention_mask/token_type_ids, все int64. */
export function buildNativeFeeds(
  ort: OrtNodeModule,
  inputIds: Int32Array,
  attentionMask: Int32Array,
  tokenTypeIds: Int32Array,
  batchSize: number,
  seqLen: number,
): Record<string, import("onnxruntime-node").Tensor> {
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
