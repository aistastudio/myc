/**
 * Замеры эмбеддера (для приёмки и CI):
 *   MYC_EMBED_TEST_MODELS_DIR=<каталог> bun run packages/embed/src/bench.ts
 *
 * Печатает: p50/p95 одиночного запроса (токенизация + inference,
 * тёплая сессия), пропускную способность батчей (пул воркеров),
 * среднее расхождение косинуса до/после int8-квантизации.
 * Выход с кодом 1, если модель не уложена.
 */

import { createLocalEmbedder } from "./local.ts";
import { isModelPresent } from "./fetch.ts";
import { DEFAULT_MODEL_ID } from "./registry.ts";
import { cosineSimilarity, quantizeInt8, dequantizeInt8 } from "./index.ts";

const dir = process.env.MYC_EMBED_TEST_MODELS_DIR;

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function main(): Promise<number> {
  if (dir === undefined || !(await isModelPresent(DEFAULT_MODEL_ID, dir))) {
    console.error(
      "model not staged: set MYC_EMBED_TEST_MODELS_DIR and run bun run packages/embed/src/stage-model.ts",
    );
    return 1;
  }
  const embedder = createLocalEmbedder({ modelsDir: dir });
  const state = await embedder.warmup();
  if (state !== "ok") {
    console.error(`embedder not ready: state=${state}`);
    await embedder.destroy();
    return 1;
  }

  // 1. Одиночный запрос (~30 токенов, как в спеке).
  const query = "how does the vector store quantize embeddings to int8 and keep recall";
  for (let i = 0; i < 10; i++) await embedder.embed(query); // прогрев
  const single: number[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await embedder.embed(query);
    if (r.ms !== undefined) single.push(r.ms);
  }
  single.sort((a, b) => a - b);
  console.log(
    `single query (n=${single.length}): p50 = ${percentile(single, 50).toFixed(1)} ms, p95 = ${percentile(single, 95).toFixed(1)} ms (target 4–7 ms)`,
  );

  // 2. Пропускная способность батчей: 256 текстов ~ по 24 токена.
  const texts: string[] = [];
  for (let i = 0; i < 256; i++) {
    texts.push(
      `document chunk ${i}: the indexer batches texts and pads them to sixty four tokens before inference`,
    );
  }
  const batch = await embedder.embedBatch(texts);
  const rps = batch.ok / (batch.ms / 1000);
  console.log(
    `batch: ${batch.ok}/${texts.length} ok in ${batch.ms.toFixed(0)} ms → ${rps.toFixed(1)} texts/s`,
  );

  // 3. Квантизация: среднее |Δcos| float32 → int8 на реальных векторах.
  const sample = await embedder.embedBatch(texts.slice(0, 200));
  const vecs = sample.results.map((r) => r.vec!);
  let total = 0;
  let count = 0;
  let maxAbsDev = 0;
  for (let i = 0; i < vecs.length; i += 7) {
    for (let j = i + 1; j < vecs.length; j += 11) {
      const q1 = dequantizeInt8(quantizeInt8(vecs[i]!));
      const q2 = dequantizeInt8(quantizeInt8(vecs[j]!));
      const dev = Math.abs(cosineSimilarity(vecs[i]!, vecs[j]!) - cosineSimilarity(q1, q2));
      total += dev;
      count++;
      if (dev > maxAbsDev) maxAbsDev = dev;
    }
  }
  console.log(
    `int8 quantization: mean |Δcos| = ${(total / count).toExponential(3)}, max |Δcos| = ${maxAbsDev.toExponential(3)} (${count} pairs)`,
  );

  await embedder.destroy();
  return 0;
}

process.exitCode = await main();
