/**
 * Укладывает РЕАЛЬНУЮ модель в каталог для e2e-тестов и замеров.
 * Использует уже скачанные файлы (или качает через fetchModel — это
 * единственный шаг со сетью, и он здесь явный).
 *
 *   MYC_EMBED_SRC_DIR=/путь/с/model.onnx+vocab.txt bun run packages/embed/src/stage-model.ts
 *
 * После: MYC_EMBED_TEST_MODELS_DIR=<каталог> bun test packages/embed
 */

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchModel, modelDir, DEFAULT_MODEL_ID, getModelSpec } from "./index.ts";

const src = process.env.MYC_EMBED_SRC_DIR;
const base = process.env.MYC_EMBED_TEST_MODELS_DIR;
const target = modelDir(DEFAULT_MODEL_ID, base);

async function main(): Promise<void> {
  await mkdir(target, { recursive: true });
  const spec = getModelSpec(DEFAULT_MODEL_ID);
  const names = spec.files.map((f) => f.name);
  // Ожидаем реальные имена как в каталоге: model.onnx, vocab.txt, config.json.
  for (const name of names) {
    if (src === undefined) break;
    const source = join(src, name);
    try {
      await copyFile(source, join(target, name));
      console.log(`скопирован ${name} из ${source}`);
    } catch {
      console.warn(`в ${src} нет ${name} — попробую fetchModel`);
    }
  }
  const result = await fetchModel({ modelId: DEFAULT_MODEL_ID, dir: base });
  console.log(`модель готова: ${result.dir}`);
  console.log(`пропущено (уже целые): ${result.skipped.join(", ") || "нет"}`);
}

await main();
