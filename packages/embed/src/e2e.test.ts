/**
 * E2E-тесты локального эмбеддера на РЕАЛЬНОЙ модели. Запускаются
 * только если модель уложена в каталог из MYC_EMBED_TEST_MODELS_DIR
 * (или стандартный кеш) — без сети. В CI без модели весь describe
 * молча пропускается.
 *
 * Подготовка каталога: bun run packages/embed/src/stage-model.ts
 */

import { describe, expect, test } from "bun:test";
import { isModelPresent, resolveModelPaths } from "./fetch.ts";
import { DEFAULT_MODEL_ID } from "./registry.ts";
import { createLocalEmbedder } from "./local.ts";
import { cosineSimilarity, quantizeInt8, dequantizeInt8 } from "./index.ts";

const dir = process.env.MYC_EMBED_TEST_MODELS_DIR;
const modelReady =
  dir !== undefined &&
  dir !== "" &&
  (await isModelPresent(DEFAULT_MODEL_ID, dir));

const d = modelReady ? describe : describe.skip;

d("локальный эмбеддер на реальной модели", () => {
  test("модель на месте", async () => {
    const paths = await resolveModelPaths(DEFAULT_MODEL_ID, dir);
    expect(paths).not.toBeNull();
  });

  test("warmup → ok, эмбеддинг 384 dim, нормализован, детерминирован", async () => {
    const embedder = createLocalEmbedder({ modelsDir: dir });
    expect(await embedder.warmup()).toBe("ok");
    const a1 = await embedder.embed("sqlite vector search with int8 quantization");
    expect(a1.state).toBe("ok");
    expect(a1.vec?.length).toBe(384);
    let norm = 0;
    for (const x of a1.vec!) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
    const a2 = await embedder.embed("sqlite vector search with int8 quantization");
    expect(cosineSimilarity(a1.vec!, a2.vec!)).toBeGreaterThan(0.999999);
    await embedder.destroy();
  });

  test("смысловая близость: связанные тексты ближе несвязанных", async () => {
    const embedder = createLocalEmbedder({ modelsDir: dir });
    await embedder.warmup();
    const code = await embedder.embed("how to migrate the sqlite schema");
    const code2 = await embedder.embed("run the database migration for the vector table");
    const weather = await embedder.embed("the weather in barcelona is sunny today");
    const simRelated = cosineSimilarity(code.vec!, code2.vec!);
    const simUnrelated = cosineSimilarity(code.vec!, weather.vec!);
    expect(simRelated).toBeGreaterThan(simUnrelated);
    await embedder.destroy();
  });

  test("батч через пул воркеров: все ок, размерность сходится", async () => {
    const embedder = createLocalEmbedder({ modelsDir: dir });
    await embedder.warmup();
    const texts = [
      "первый текст",
      "second text",
      "vector index maintenance",
      "graph edges and anchors",
      "another one",
      "и ещё один",
    ];
    const batch = await embedder.embedBatch(texts);
    expect(batch.ok).toBe(texts.length);
    for (const r of batch.results) {
      expect(r.state).toBe("ok");
      expect(r.vec?.length).toBe(384);
    }
    await embedder.destroy();
  });

  test("квантизация int8: среднее расхождение косинуса на реальных текстах", async () => {
    const embedder = createLocalEmbedder({ modelsDir: dir });
    await embedder.warmup();
    const corpus = [
      "embedding model warmup and session lifecycle",
      "vector store uses int8 quantization per vector",
      "the migration checksum must match the applied schema",
      "background indexing batches text through workers",
      "search latency budget is 25 milliseconds p99",
      "cosine similarity between query and document vectors",
      "the tokenizer splits unknown words into subword pieces",
      "fingerprint mismatch must refuse writes to the index",
      "worker pool size clamps to four threads maximum",
      "the graph walker collects anchors around the node",
      "bm25 full text search works without embeddings",
      "quantized vectors keep cosine close to float32",
      "database vacuum reduces the size after deletes",
      "the cli prints degraded embedder state loudly",
      "queue depth metric tracks pending embed jobs",
      "sha256 checksums pin the downloaded model files",
      "normalization projects vectors onto the unit sphere",
      "the swarm learns routing weights from outcomes",
      "nodes and edges form the memory graph",
      "cold start loads the onnx session lazily",
    ];
    const batch = await embedder.embedBatch(corpus);
    expect(batch.ok).toBe(corpus.length);
    const vecs = batch.results.map((r) => r.vec!);

    // Все пары (i<j): косинус float32 против косинуса после int8-кв.
    let total = 0;
    let count = 0;
    let maxAbsDev = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        const q1 = dequantizeInt8(quantizeInt8(vecs[i]!));
        const q2 = dequantizeInt8(quantizeInt8(vecs[j]!));
        const f32 = cosineSimilarity(vecs[i]!, vecs[j]!);
        const i8 = cosineSimilarity(q1, q2);
        const dev = Math.abs(f32 - i8);
        total += dev;
        count++;
        if (dev > maxAbsDev) maxAbsDev = dev;
      }
    }
    const mean = total / count;
    // Порог мягкий, но осмысленный: int8-квантизация unit-векторов 384 dim
    // обязана держать косинус в пределах ~2e-3. Рост сверх — тревога.
    expect(mean).toBeLessThan(2e-3);
    console.log(
      `[embed] int8 vs f32: mean|Δcos| = ${mean.toExponential(3)}, max|Δcos| = ${maxAbsDev.toExponential(3)} (${count} пар)`,
    );
    await embedder.destroy();
  });

  test("латентность одиночного запроса (информативно)", async () => {
    const embedder = createLocalEmbedder({ modelsDir: dir });
    await embedder.warmup();
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await embedder.embed("quick vector search query about embeddings");
      if (r.ms !== undefined) times.push(r.ms);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    console.log(
      `[embed] одиночный запрос: p50 = ${p50.toFixed(1)} мс, p95 = ${p95.toFixed(1)} мс (цель спеки 4–7 мс)`,
    );
    await embedder.destroy();
  });
});
