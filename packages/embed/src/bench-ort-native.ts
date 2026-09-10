/**
 * Замер нативного ORT-бэкенда, сравнимый с bench.ts (WASM):
 *   MYC_EMBED_TEST_MODELS_DIR=<каталог> bun run packages/embed/src/bench-ort-native.ts
 *
 * Тот же одиночный запрос (~30 токенов), тот же набор из 256 текстов
 * батча, та же область замера (токенизация + inference + CLS-pool + L2).
 * Нативная сессия одна, тёплая; пул воркеров не используется — в нативном
 * рантайме батч и так идёт через CPU-EP с потоками.
 * Потоки intra_op задаёт MYC_ORT_THREADS (по умолчанию 1 — как query-сессия
 * WASM-бэкенда, чтобы числа были сравнимы с bench.ts).
 * Выход с кодом 1, если модель не уложена или onnxruntime-node недоступен.
 */

import { join } from "node:path";
import { WordPieceTokenizer } from "./tokenizer.ts";
import { normalizeInPlace } from "./quantize.ts";
import { buildNativeFeeds, createNativeSession } from "./ort-native.ts";
import { DEFAULT_MODEL_ID, getModelSpec } from "./registry.ts";

const dir = process.env.MYC_EMBED_TEST_MODELS_DIR;

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function main(): Promise<number> {
  if (dir === undefined) {
    console.error("set MYC_EMBED_TEST_MODELS_DIR (see bench.ts)");
    return 1;
  }
  const spec = getModelSpec(DEFAULT_MODEL_ID);
  const modelDir = join(dir, spec.id);
  const [vocabText, modelBytes] = await Promise.all([
    Bun.file(join(modelDir, "vocab.txt")).text(),
    Bun.file(join(modelDir, "model.onnx")).arrayBuffer(),
  ]);
  const tokenizer = WordPieceTokenizer.fromVocabText(vocabText);

  let loaded;
  try {
    loaded = await createNativeSession(new Uint8Array(modelBytes), { intraOpThreads: Number(process.env.MYC_ORT_THREADS ?? 1) });
  } catch (cause) {
    console.error(String(cause));
    return 1;
  }
  const { session, ort, outputNames } = loaded;

  const embedOne = async (text: string): Promise<number> => {
    const started = performance.now();
    const enc = tokenizer.encode(text, spec.maxPositionTokens);
    const feeds = buildNativeFeeds(
      ort,
      enc.inputIds,
      enc.attentionMask,
      enc.tokenTypeIds,
      1,
      enc.length,
    );
    const output = await session.run(feeds);
    const hidden = output[outputNames[0]!]!;
    const vec = new Float32Array(spec.dim);
    for (let d = 0; d < spec.dim; d++) vec[d] = (hidden.data as Float32Array)[d]!;
    normalizeInPlace(vec);
    return performance.now() - started;
  };

  // 1. Одиночный запрос (~30 токенов, как в спеке) — тот же текст, что в bench.ts.
  const query = "how does the vector store quantize embeddings to int8 and keep recall";
  for (let i = 0; i < 10; i++) await embedOne(query); // прогрев
  const single: number[] = [];
  for (let i = 0; i < 100; i++) single.push(await embedOne(query));
  single.sort((a, b) => a - b);
  console.log(
    `single query (n=${single.length}): p50 = ${percentile(single, 50).toFixed(1)} ms, p95 = ${percentile(single, 95).toFixed(1)} ms (target 4–7 ms)`,
  );

  // 2. Батч: те же 256 текстов, один прогон с паддингом до максимума батча.
  const texts: string[] = [];
  for (let i = 0; i < 256; i++) {
    texts.push(
      `document chunk ${i}: the indexer batches texts and pads them to sixty four tokens before inference`,
    );
  }
  const started = performance.now();
  const encoded = texts.map((t) => tokenizer.encode(t, spec.maxPositionTokens));
  const seqLen = encoded.reduce((m, e) => Math.max(m, e.length), 2);
  const pad = tokenizer.padId();
  const inputIds = new Int32Array(texts.length * seqLen).fill(pad);
  const attentionMask = new Int32Array(texts.length * seqLen);
  const tokenTypeIds = new Int32Array(texts.length * seqLen);
  for (let b = 0; b < texts.length; b++) {
    const e = encoded[b]!;
    inputIds.set(e.inputIds, b * seqLen);
    attentionMask.set(e.attentionMask, b * seqLen);
    tokenTypeIds.set(e.tokenTypeIds, b * seqLen);
  }
  const output = await session.run(
    buildNativeFeeds(ort, inputIds, attentionMask, tokenTypeIds, texts.length, seqLen),
  );
  const ms = performance.now() - started;
  void output;
  console.log(
    `batch: ${texts.length}/${texts.length} ok in ${ms.toFixed(0)} ms → ${((texts.length / ms) * 1000).toFixed(1)} texts/s`,
  );

  return 0;
}

process.exitCode = await main();
