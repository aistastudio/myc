/**
 * onnxruntime-node объявляет "types": "dist/index.d.ts", но .d.ts в npm-пакет
 * не входят (типы живут только в репозитории), а @types/onnxruntime-node не
 * существует. Это минимальное объявление покрывает ту часть API, которую
 * использует ort-native.ts; сигнатуры соответствуют lib/*.ts пакета 1.20.1.
 */
declare module "onnxruntime-node" {
  export namespace env {
    const versions: { readonly node: string };
  }

  export type TensorDataType = "int64" | "float32" | "int32" | string;

  export class Tensor {
    constructor(
      type: TensorDataType,
      data: BigInt64Array | Float32Array | Int32Array,
      dims: readonly number[],
    );
    readonly dims: readonly number[];
    readonly type: TensorDataType;
    readonly data: Float32Array | BigInt64Array | Int32Array;
  }

  export interface SessionOptions {
    executionProviders?: readonly string[];
    graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
    intraOpNumThreads?: number;
    interOpNumThreads?: number;
  }

  export class InferenceSession {
    static create(
      model: Uint8Array | string,
      options?: SessionOptions,
    ): Promise<InferenceSession>;
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    release(): Promise<void>;
  }
}
