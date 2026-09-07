import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEmbedder } from "./local.ts";
import { createApiEmbedder } from "./api.ts";
import { createEmbedder, formatEmbedFingerprint } from "./index.ts";
import { DEFAULT_MODEL_ID, getModelSpec } from "./registry.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "myc-embed-local-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalEmbedder без модели", () => {
  test("state = missing, ни одного исключения, ни одного обращения в сеть", async () => {
    const embedder = createLocalEmbedder({ modelsDir: dir });
    // Контракт И2: вызов до завершения init отвечает warming мгновенно.
    const immediate = await embedder.embed("привет, мир");
    expect(immediate.state).toBe("warming");
    expect(immediate.vec).toBeNull();
    await embedder.warmup();
    const seen = await embedder.embed("привет, мир");
    expect(seen.state).toBe("missing");
    expect(seen.reason).toBe("model_not_downloaded");
    expect(seen.vec).toBeNull();

    const batch = await embedder.embedBatch(["a", "b", "c"]);
    expect(batch.results.length).toBe(3);
    expect(batch.ok).toBe(0);
    for (const r of batch.results) {
      expect(r.state).toBe("missing");
      expect(r.vec).toBeNull();
    }

    expect(await embedder.warmup()).toBe("missing");
    // Отпечаток собирается из реестра, а не из литерала: копия имени
    // модели в тесте разошлась бы с реестром при первой же смене (S46).
    expect(embedder.fingerprintString).toBe(
      `local:onnx-wasm:${DEFAULT_MODEL_ID}:384:l2`,
    );
    await embedder.destroy();
  });

  test("битые файлы модели → degraded(load_error), не исключение", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    // Имя каталога и состав файлов берём из реестра модели по умолчанию —
    // иначе тест перестал бы что-либо проверять при смене модели, молча.
    const spec = getModelSpec(DEFAULT_MODEL_ID);
    const sub = join(dir, DEFAULT_MODEL_ID);
    await mkdir(sub, { recursive: true });
    // manifest валиден по форме → проходит isModelPresent, но сами файлы — мусор.
    const { createHash } = await import("node:crypto");
    const manifestFiles: Record<string, { sha256: string; bytes: number }> = {};
    for (const f of spec.files) {
      const body = "мусор";
      await writeFile(join(sub, f.name), body);
      manifestFiles[f.name] = {
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.length,
      };
    }
    await writeFile(
      join(sub, "manifest.json"),
      JSON.stringify({ modelId: DEFAULT_MODEL_ID, dim: spec.dim, files: manifestFiles, fetchedAt: 0 }),
    );
    const embedder = createLocalEmbedder({ modelsDir: dir });
    await embedder.warmup();
    const r = await embedder.embed("hello");
    expect(r.state).toBe("degraded");
    expect(r.reason).toBe("load_error");
    expect(r.vec).toBeNull();
    await embedder.destroy();
  });
});

describe("выбор бэкенда", () => {
  test("createEmbedder требует явного backend", () => {
    const local = createEmbedder({ backend: "local", modelsDir: dir });
    expect(local.fingerprint.backend).toBe("local");
    const api = createEmbedder({
      backend: "api",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
      model: "text-embedding-3-small",
      dim: 1536,
    });
    expect(api.fingerprint.backend).toBe("api");
    // Пространства не смешиваются: отпечатки разные.
    expect(formatEmbedFingerprint(local.fingerprint)).not.toBe(
      formatEmbedFingerprint(api.fingerprint),
    );
    return Promise.all([local.destroy(), api.destroy()]);
  });
});

describe("ApiEmbedder", () => {
  function makeApi(opts: { dim?: number; embLen?: number } = {}) {
    const dim = opts.dim ?? 4;
    const embLen = opts.embLen ?? dim;
    let calls = 0;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((t) => ({
            embedding: Array.from({ length: embLen }, (_, i) => t.length + i),
          })),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const api = createApiEmbedder({
      baseUrl: "https://api.test/v1",
      apiKey: "key",
      model: "text-embedding-3-small",
      dim,
      fetchImpl: impl,
    });
    return { api, getCalls: () => calls };
  }

  test("успешный путь: вектор, state ok", async () => {
    const { api } = makeApi();
    const r = await api.embed("hello");
    expect(r.state).toBe("ok");
    expect(r.vec?.length).toBe(4);
    await api.destroy();
  });

  test("сетевой сбой → degraded(backend_unreachable), не исключение", async () => {
    const api = createApiEmbedder({
      baseUrl: "https://api.test/v1",
      apiKey: "key",
      model: "m",
      dim: 4,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const r = await api.embed("hello");
    expect(r.state).toBe("degraded");
    expect(r.reason).toBe("backend_unreachable");
    expect(r.vec).toBeNull();
    await api.destroy();
  });

  test("HTTP 500 → degraded(backend_unreachable)", async () => {
    const api = createApiEmbedder({
      baseUrl: "https://api.test/v1",
      apiKey: "key",
      model: "m",
      dim: 4,
      fetchImpl: (async () => new Response("x", { status: 500 })) as unknown as typeof fetch,
    });
    const r = await api.embed("hello");
    expect(r.state).toBe("degraded");
    expect(r.reason).toBe("backend_unreachable");
    await api.destroy();
  });

  test("чужая размерность → dimension_mismatch, вектор НЕ выдаётся", async () => {
    const { api } = makeApi({ dim: 4, embLen: 9 });
    const r = await api.embed("hello");
    expect(r.state).toBe("degraded");
    expect(r.reason).toBe("dimension_mismatch");
    expect(r.vec).toBeNull();
    await api.destroy();
  });

  test("неполная конфигурация → missing(api_not_configured), сети нет", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const api = createApiEmbedder({
      baseUrl: "https://api.test/v1",
      apiKey: "",
      model: "text-embedding-3-small",
      dim: 4,
      fetchImpl: impl,
    });
    expect(api.state).toBe("missing");
    const r = await api.embed("hello");
    expect(r.state).toBe("missing");
    expect(r.reason).toBe("api_not_configured");
    expect(calls).toBe(0);
    await api.destroy();
  });

  test("батч одним запросом, выравнен по индексам", async () => {
    const { api } = makeApi();
    const batch = await api.embedBatch(["a", "bb", "ccc"]);
    expect(batch.ok).toBe(3);
    expect(batch.results.length).toBe(3);
    expect(batch.results[0]!.vec?.length).toBe(4);
    await api.destroy();
  });
});
