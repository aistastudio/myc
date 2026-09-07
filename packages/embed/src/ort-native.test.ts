/**
 * Тесты нативного ORT-бэкенда (onnxruntime-node) на РЕАЛЬНОЙ модели.
 * Запускаются только если модель уложена в MYC_EMBED_TEST_MODELS_DIR
 * и onnxruntime-node установлен (optionalDependency) — иначе describe
 * молча пропускается, WASM остаётся единственным обязательным бэкендом.
 */

import { describe, expect, test } from "bun:test";
import { isModelPresent, resolveModelPaths } from "./fetch.ts";
import { DEFAULT_MODEL_ID, getModelSpec } from "./registry.ts";
import { loadTokenizer, poolLastHidden } from "./core.ts";
import { cosineSimilarity } from "./index.ts";
import {
  buildNativeFeeds,
  createNativeSession,
  getOrtNative,
} from "./ort-native.ts";
import { createSession, buildFeeds } from "./ort.ts";

const dir = process.env.MYC_EMBED_TEST_MODELS_DIR;
const ortAvailable = await getOrtNative()
  .then(() => true)
  .catch(() => false);
const modelReady =
  dir !== undefined &&
  dir !== "" &&
  (await isModelPresent(DEFAULT_MODEL_ID, dir));

const d = modelReady && ortAvailable ? describe : describe.skip;

async function loadInputs() {
  const spec = getModelSpec(DEFAULT_MODEL_ID);
  const paths = (await resolveModelPaths(DEFAULT_MODEL_ID, dir))!;
  const [tokenizer, modelBytes] = await Promise.all([
    loadTokenizer(spec.tokenizer, paths.tokenizerPath),
    Bun.file(paths.modelOnnx).arrayBuffer(),
  ]);
  return { spec, tokenizer, modelBytes: new Uint8Array(modelBytes) };
}

/** Пулинг ровно тот, что задан спецификацией модели (CLS у bge, mean у e5). */
function poolOne(
  hidden: { data: Float32Array; dims: readonly number[] },
  dim: number,
  seqLen: number,
  spec: ReturnType<typeof getModelSpec>,
  attentionMask: Int32Array,
): Float32Array {
  return poolLastHidden({ data: hidden.data }, 1, seqLen, dim, spec.pooling, attentionMask)[0]!;
}

d("нативный ORT-бэкенд на реальной модели", () => {
  test("сессия создаётся, входы/выходы BertModel на месте", async () => {
    const { modelBytes } = await loadInputs();
    const { session, inputNames, outputNames } = await createNativeSession(modelBytes);
    expect(inputNames).toEqual(["input_ids", "attention_mask", "token_type_ids"]);
    expect(outputNames).toEqual(["last_hidden_state"]);
    await session.release();
  });

  test("эмбеддинг 384 dim, нормализован, детерминирован", async () => {
    const { spec, tokenizer, modelBytes } = await loadInputs();
    const loaded = await createNativeSession(modelBytes);
    const run = async (text: string) => {
      const enc = tokenizer.encode(text, spec.maxPositionTokens);
      const out = await loaded.session.run(
        buildNativeFeeds(
          loaded.ort,
          enc.inputIds,
          enc.attentionMask,
          enc.tokenTypeIds,
          1,
          enc.length,
        ),
      );
      const hidden = out[loaded.outputNames[0]!]!;
      return poolOne(
        { data: hidden.data as Float32Array, dims: hidden.dims as readonly number[] },
        spec.dim,
        enc.length,
        spec,
        enc.attentionMask,
      );
    };
    const a = await run("sqlite vector search with int8 quantization");
    expect(a.length).toBe(384);
    let norm = 0;
    for (const x of a) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
    const b = await run("sqlite vector search with int8 quantization");
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.999999);
    await loaded.session.release();
  });

  test("вектор совпадает с WASM-бэкендом (та же модель, тот же текст)", async () => {
    const { spec, tokenizer, modelBytes } = await loadInputs();
    const text = "how does the vector store quantize embeddings to int8";
    const enc = tokenizer.encode(text, spec.maxPositionTokens);

    const native = await createNativeSession(modelBytes);
    const nativeOut = await native.session.run(
      buildNativeFeeds(
        native.ort,
        enc.inputIds,
        enc.attentionMask,
        enc.tokenTypeIds,
        1,
        enc.length,
      ),
    );
    const nativeHidden = nativeOut[native.outputNames[0]!]!;
    const nativeVec = poolOne(
      {
        data: nativeHidden.data as Float32Array,
        dims: nativeHidden.dims as readonly number[],
      },
      spec.dim,
      enc.length,
      spec,
      enc.attentionMask,
    );

    const wasm = await createSession(modelBytes, { intraOpThreads: 1 });
    const wasmOut = await wasm.session.run(
      buildFeeds(wasm.ort, enc.inputIds, enc.attentionMask, enc.tokenTypeIds, 1, enc.length),
    );
    const wasmHidden = wasmOut[wasm.outputNames[0]!]!;
    const wasmVec = poolOne(
      {
        data: wasmHidden.data as Float32Array,
        dims: wasmHidden.dims as readonly number[],
      },
      spec.dim,
      enc.length,
      spec,
      enc.attentionMask,
    );

    // Разные рантаймы, один файл модели: косинус практически 1.
    expect(cosineSimilarity(nativeVec, wasmVec)).toBeGreaterThan(0.9999);
    await native.session.release();
  });

  test("батч одним прогоном: паддинг, выравнивание по входу", async () => {
    const { spec, tokenizer, modelBytes } = await loadInputs();
    const loaded = await createNativeSession(modelBytes);
    const texts = ["first chunk", "second chunk is a bit longer than the first one"];
    const encoded = texts.map((t) => tokenizer.encode(t, spec.maxPositionTokens));
    const seqLen = encoded.reduce((m, e) => Math.max(m, e.length), 2);
    const pad = tokenizer.padId();
    const inputIds = new Int32Array(texts.length * seqLen).fill(pad);
    const attentionMask = new Int32Array(texts.length * seqLen);
    const tokenTypeIds = new Int32Array(texts.length * seqLen);
    for (let b = 0; b < texts.length; b++) {
      inputIds.set(encoded[b]!.inputIds, b * seqLen);
      attentionMask.set(encoded[b]!.attentionMask, b * seqLen);
    }
    const out = await loaded.session.run(
      buildNativeFeeds(loaded.ort, inputIds, attentionMask, tokenTypeIds, texts.length, seqLen),
    );
    const hidden = out[loaded.outputNames[0]!]!;
    expect(hidden.dims[0]).toBe(texts.length);
    expect(hidden.dims[hidden.dims.length - 1]).toBe(spec.dim);
    await loaded.session.release();
  });
});
