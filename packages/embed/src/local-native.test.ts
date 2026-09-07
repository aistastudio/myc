/**
 * Тесты переключателя ortBackend в LocalEmbedder (myc-dze.5).
 *
 * Часть тестов не требует ни модели, ни onnxruntime-node (отпечаток
 * различает бэкенды детерминированно, до всякой загрузки). Часть требует
 * реальную модель + onnxruntime-node — пропускается молча, если их нет
 * (как e2e.test.ts / ort-native.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isModelPresent } from "./fetch.ts";
import { DEFAULT_MODEL_ID } from "./registry.ts";
import { createLocalEmbedder } from "./local.ts";
import { cosineSimilarity } from "./index.ts";
import { getOrtNative } from "./ort-native.ts";

describe("ortBackend: переключение явное, отпечаток различает бэкенды", () => {
  let dir: string;

  test("дефолт — wasm", async () => {
    dir = await mkdtemp(join(tmpdir(), "myc-embed-ortbackend-"));
    const embedder = createLocalEmbedder({ modelsDir: dir });
    expect(embedder.ortBackend).toBe("wasm");
    expect(embedder.fingerprint.provider).toBe("onnx-wasm");
    await embedder.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  test("wasm и native дают разные отпечатки — смешивать пространства нельзя", async () => {
    dir = await mkdtemp(join(tmpdir(), "myc-embed-ortbackend-"));
    const wasm = createLocalEmbedder({ modelsDir: dir, ortBackend: "wasm" });
    const native = createLocalEmbedder({ modelsDir: dir, ortBackend: "native" });
    expect(wasm.ortBackend).toBe("wasm");
    expect(native.ortBackend).toBe("native");
    expect(wasm.fingerprintString).not.toBe(native.fingerprintString);
    expect(wasm.fingerprint.dim).toBe(native.fingerprint.dim);
    await Promise.all([wasm.destroy(), native.destroy()]);
    await rm(dir, { recursive: true, force: true });
  });
});

const modelDir = process.env.MYC_EMBED_TEST_MODELS_DIR;
const ortAvailable = await getOrtNative()
  .then(() => true)
  .catch(() => false);
const modelReady =
  modelDir !== undefined &&
  modelDir !== "" &&
  (await isModelPresent(DEFAULT_MODEL_ID, modelDir));

const dBoth = modelReady && ortAvailable ? describe : describe.skip;

dBoth("ortBackend: native рядом с wasm на реальной модели", () => {
  test("оба бэкенда включаются в обе стороны, оба ok", async () => {
    const wasm = createLocalEmbedder({ modelsDir: modelDir, ortBackend: "wasm" });
    const native = createLocalEmbedder({ modelsDir: modelDir, ortBackend: "native" });
    expect(await wasm.warmup()).toBe("ok");
    expect(await native.warmup()).toBe("ok");
    await Promise.all([wasm.destroy(), native.destroy()]);
  });

  test("вектор одного текста: native и wasm сравнимы, но не смешиваются", async () => {
    const wasm = createLocalEmbedder({ modelsDir: modelDir, ortBackend: "wasm" });
    const native = createLocalEmbedder({ modelsDir: modelDir, ortBackend: "native" });
    await wasm.warmup();
    await native.warmup();
    const text = "how does the vector store quantize embeddings to int8";
    const rw = await wasm.embed(text);
    const rn = await native.embed(text);
    expect(rw.state).toBe("ok");
    expect(rn.state).toBe("ok");
    expect(rw.vec?.length).toBe(384);
    expect(rn.vec?.length).toBe(384);
    const cos = cosineSimilarity(rw.vec!, rn.vec!);
    console.log(`[embed] wasm vs native, cos(${JSON.stringify(text)}) = ${cos.toFixed(10)}`);
    // Сравнимы (тот же файл модели), но НЕ гарантированно ровно 1.0 —
    // разные рантаймы дают разный float32-шум; отпечаток обязан их
    // различать (см. вышестоящий describe), а не полагаться на cos === 1.
    expect(cos).toBeGreaterThan(0.999);
    expect(wasm.fingerprintString).not.toBe(native.fingerprintString);
    await Promise.all([wasm.destroy(), native.destroy()]);
  });

  test("батч на native: без пула воркеров, всё ok, размерность сходится", async () => {
    const native = createLocalEmbedder({ modelsDir: modelDir, ortBackend: "native" });
    await native.warmup();
    const texts = ["first chunk", "second chunk is a bit longer", "третий текст"];
    const batch = await native.embedBatch(texts);
    expect(batch.ok).toBe(texts.length);
    for (const r of batch.results) {
      expect(r.state).toBe("ok");
      expect(r.vec?.length).toBe(384);
    }
    await native.destroy();
  });

  test("латентность одиночного запроса (информативно): native заметно быстрее wasm", async () => {
    const wasm = createLocalEmbedder({ modelsDir: modelDir, ortBackend: "wasm" });
    const native = createLocalEmbedder({ modelsDir: modelDir, ortBackend: "native" });
    await wasm.warmup();
    await native.warmup();
    const query = "quick vector search query about embeddings";
    const measure = async (embedder: typeof wasm): Promise<number> => {
      for (let i = 0; i < 5; i++) await embedder.embed(query);
      const times: number[] = [];
      for (let i = 0; i < 30; i++) {
        const r = await embedder.embed(query);
        if (r.ms !== undefined) times.push(r.ms);
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)]!;
    };
    const p50Wasm = await measure(wasm);
    const p50Native = await measure(native);
    console.log(
      `[embed] p50 wasm = ${p50Wasm.toFixed(1)} мс, p50 native = ${p50Native.toFixed(1)} мс (цель 4–7 мс)`,
    );
    await Promise.all([wasm.destroy(), native.destroy()]);
  });
});

// Пропускается молча, если onnxruntime-node установлен (нет способа
// снять зависимость только для этого файла) — реально исполняется при
// ручной проверке "удали optionalDependency, прогони тесты" из приёмки.
const dNativeAbsent = ortAvailable ? describe.skip : describe;

dNativeAbsent("ortBackend: native запрошен явно, onnxruntime-node недоступен", () => {
  test("degraded(native_unavailable), внятное сообщение, без падения по стеку", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myc-embed-ortbackend-absent-"));
    const embedder = createLocalEmbedder({ modelsDir: dir, ortBackend: "native" });
    await embedder.warmup();
    expect(embedder.state).toBe("degraded");
    expect(embedder.stateReason).toBe("native_unavailable");
    const r = await embedder.embed("hello");
    expect(r.state).toBe("degraded");
    expect(r.reason).toBe("native_unavailable");
    expect(r.vec).toBeNull();
    await embedder.destroy();
    await rm(dir, { recursive: true, force: true });
  });
});
