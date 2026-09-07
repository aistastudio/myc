#!/usr/bin/env bun
/**
 * Отчёт по языковому качеству эмбеддера на реальных текстах проекта.
 *
 *   bun run packages/embed/src/bench-separation.ts [modelId ...]
 *
 * Без аргументов меряет модель по умолчанию. Несколько id — сравнение
 * (только внутри одного языка: separation зависит от масштаба модели,
 * см. separation.ts; между моделями сравнивать нужно MRR).
 */

import { CORPORA } from "./fixtures/separation-corpus.ts";
import { formatSeparation, measureSeparation } from "./separation.ts";
import { createLocalEmbedder } from "./local.ts";
import { DEFAULT_MODEL_ID, getModelSpec, MODELS } from "./registry.ts";
import { isModelPresent } from "./fetch.ts";

const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const models = ids.length > 0 ? ids : [DEFAULT_MODEL_ID];

for (const modelId of models) {
  if (MODELS[modelId] === undefined) {
    console.error(`неизвестная модель ${modelId}; известно: ${Object.keys(MODELS).join(", ")}`);
    process.exitCode = 2;
    continue;
  }
  if (!(await isModelPresent(modelId))) {
    console.error(`${modelId}: не скачана → myc models fetch --model ${modelId}`);
    process.exitCode = 2;
    continue;
  }
  const spec = getModelSpec(modelId);
  const embedder = createLocalEmbedder({ modelId });
  const state = await embedder.warmup();
  if (state !== "ok") {
    console.error(`${modelId}: эмбеддер в состоянии ${state}`);
    await embedder.destroy();
    process.exitCode = 2;
    continue;
  }
  console.log(`\n${modelId} (${spec.languages}, пулинг ${spec.pooling}, токенизатор ${spec.tokenizer})`);
  for (const corpus of CORPORA) {
    const report = await measureSeparation(corpus, async (text, role) => {
      const r = await embedder.embed(text, role);
      if (r.vec === null) throw new Error(`эмбеддер вернул ${r.state}/${r.reason}`);
      return r.vec;
    });
    console.log("  " + formatSeparation(report));
  }
  await embedder.destroy();
}
