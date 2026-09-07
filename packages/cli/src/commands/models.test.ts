import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID, FetchModelError, type ModelSpec } from "@myc/embed";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createModelsCommand, type EmbedDeps } from "./models.ts";

/**
 * Реальные хеши в @myc/embed фиксируют байты чужого HF-репозитория —
 * offline их не воспроизвести. Юнит-тесты подменяют @myc/embed через
 * EmbedDeps (DI, определённый в models.ts), не трогая сам пакет embed.
 * Отдельный блок ниже гоняет настоящий @myc/embed с подменённым сетевым
 * fetch — там, где преимидж не нужен (несовпадение чек-суммы гарантировано
 * для любого не-настоящего контента).
 */

function makeSpec(): ModelSpec {
  return {
    id: "test-model",
    dim: 4,
    maxPositionTokens: 8,
    tokenizer: "wordpiece",
    tokenizerFile: "vocab.txt",
    pooling: "cls",
    languages: "english",
    queryPrefix: "",
    passagePrefix: "",
    files: [
      { name: "model.onnx", url: "https://example.test/model.onnx", sha256: "onnx-hash", bytes: 10 },
      { name: "vocab.txt", url: "https://example.test/vocab.txt", sha256: "vocab-hash", bytes: 4 },
    ],
  };
}

function baseDeps(overrides: Partial<EmbedDeps> = {}): EmbedDeps {
  return {
    MODELS: { "test-model": makeSpec() },
    DEFAULT_MODEL_ID: "test-model",
    getModelSpec: () => makeSpec(),
    modelDir: () => "/fake/models/test-model",
    sha256File: async () => "fingerprint-hash",
    isModelPresent: async () => false,
    fetchModel: async () => {
      throw new Error("fetchModel should not be called in this test");
    },
    ...overrides,
  };
}

function registryWith(deps: EmbedDeps): Registry {
  const registry = new Registry();
  registry.register(createModelsCommand(deps));
  return registry;
}

async function jsonOf(argv: readonly string[], registry: Registry) {
  const result = await run(argv, { registry });
  return { envelope: JSON.parse(result.stdout as string), code: result.code };
}

describe("models list", () => {
  test("reports a present model with size and fingerprint (json)", async () => {
    const deps = baseDeps({ isModelPresent: async () => true });
    const { envelope, code } = await jsonOf(["models", "list", "--json"], registryWith(deps));
    expect(code).toBe(ExitCode.OK);
    expect(envelope).toMatchObject({ ok: true, cmd: "models list" });
    expect(envelope.data).toEqual([
      { id: "test-model", status: "present", dim: 4, size: "14B", fingerprint: "fingerprint-" },
    ]);
    expect(envelope.meta.count).toBe(1);
    expect(envelope.meta.degraded).toEqual([]);
    expect(envelope.warn).toEqual([]);
  });

  test("reports an absent model (nothing on disk)", async () => {
    const deps = baseDeps({ modelDir: () => "/nonexistent/models/test-model" });
    const { envelope } = await jsonOf(["models", "list", "--json"], registryWith(deps));
    expect(envelope.data).toEqual([
      { id: "test-model", status: "absent", dim: 4, size: "-", fingerprint: "-" },
    ]);
  });

  test("distinguishes corrupt (bytes on disk, hash mismatch) from absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myc-models-list-"));
    try {
      await writeFile(join(dir, "model.onnx"), "not the real bytes at all");
      const deps = baseDeps({ modelDir: () => dir, sha256File: async () => "does-not-match" });
      const { envelope } = await jsonOf(["models", "list", "--json"], registryWith(deps));
      expect(envelope.data[0].status).toBe("corrupt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("human mode renders a dense table", async () => {
    const deps = baseDeps({ isModelPresent: async () => true });
    const result = await run(["models", "list"], { registry: registryWith(deps) });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain("ID");
    expect(result.stdout).toContain("test-model");
    expect(result.stdout).toContain("present");
  });
});

describe("models fetch: unknown model", () => {
  test("exits NOTFOUND with a distinct error code", async () => {
    const deps = baseDeps();
    const { envelope, code } = await jsonOf(
      ["models", "fetch", "nope", "--json"],
      registryWith(deps),
    );
    expect(code).toBe(ExitCode.NOTFOUND);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("notfound.model");
  });
});

describe("models fetch: idempotent on an already-staged model", () => {
  test("does not call fetchModel at all", async () => {
    let fetchModelCalls = 0;
    const deps = baseDeps({
      isModelPresent: async () => true,
      fetchModel: async () => {
        fetchModelCalls++;
        throw new Error("must not be called when the model is already present");
      },
    });
    const { envelope, code } = await jsonOf(["models", "fetch", "--json"], registryWith(deps));
    expect(code).toBe(ExitCode.OK);
    expect(fetchModelCalls).toBe(0);
    expect(envelope.data.alreadyPresent).toBe(true);
    expect(envelope.data.downloaded).toEqual([]);
    expect(envelope.data.skipped).toEqual(["model.onnx", "vocab.txt"]);
  });
});

describe("models fetch: downloads when missing", () => {
  test("reports downloaded files (json)", async () => {
    const deps = baseDeps({
      isModelPresent: async () => false,
      fetchModel: async () => ({
        modelId: "test-model",
        dir: "/fake/models/test-model",
        files: {
          "model.onnx": { sha256: "onnx-hash", bytes: 10 },
          "vocab.txt": { sha256: "vocab-hash", bytes: 4 },
        },
        skipped: [],
      }),
    });
    const { envelope, code } = await jsonOf(["models", "fetch", "--json"], registryWith(deps));
    expect(code).toBe(ExitCode.OK);
    expect(envelope.data.alreadyPresent).toBe(false);
    expect(envelope.data.downloaded.sort()).toEqual(["model.onnx", "vocab.txt"]);
  });

  test("human mode reports the destination directory", async () => {
    const deps = baseDeps({
      isModelPresent: async () => false,
      fetchModel: async () => ({
        modelId: "test-model",
        dir: "/fake/models/test-model",
        files: { "model.onnx": { sha256: "onnx-hash", bytes: 10 } },
        skipped: [],
      }),
    });
    const result = await run(["models", "fetch"], { registry: registryWith(deps) });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain("/fake/models/test-model");
  });
});

describe("models fetch: error mapping has distinct machine codes", () => {
  const cases: readonly [FetchModelError["code"], string, ExitCode][] = [
    ["network_error", "internal.network", ExitCode.ERR],
    ["http_error", "internal.http", ExitCode.ERR],
    ["checksum_mismatch", "internal.checksum_mismatch", ExitCode.ERR],
    ["fs_error", "internal.fs", ExitCode.ERR],
  ];

  for (const [fetchErrorCode, envelopeCode, exit] of cases) {
    test(`${fetchErrorCode} -> ${envelopeCode}`, async () => {
      const deps = baseDeps({
        isModelPresent: async () => false,
        fetchModel: async () => {
          throw new FetchModelError(fetchErrorCode, `boom: ${fetchErrorCode}`);
        },
      });
      const { envelope, code } = await jsonOf(["models", "fetch", "--json"], registryWith(deps));
      expect(code).toBe(exit);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe(envelopeCode);
    });
  }

  test("network and checksum errors are never mapped to the same code", async () => {
    const network = baseDeps({
      isModelPresent: async () => false,
      fetchModel: async () => {
        throw new FetchModelError("network_error", "offline");
      },
    });
    const checksum = baseDeps({
      isModelPresent: async () => false,
      fetchModel: async () => {
        throw new FetchModelError("checksum_mismatch", "bad hash");
      },
    });
    const a = await jsonOf(["models", "fetch", "--json"], registryWith(network));
    const b = await jsonOf(["models", "fetch", "--json"], registryWith(checksum));
    expect(a.envelope.error.code).not.toBe(b.envelope.error.code);
  });
});

describe("models fetch: progress redraws only on a real TTY", () => {
  function progressDeps(): EmbedDeps {
    return baseDeps({
      isModelPresent: async () => false,
      fetchModel: async ({ onProgress }) => {
        onProgress?.({ file: "model.onnx", phase: "download", loadedBytes: 5, totalBytes: 10 });
        onProgress?.({ file: "model.onnx", phase: "done", loadedBytes: 10, totalBytes: 10 });
        return {
          modelId: "test-model",
          dir: "/fake/models/test-model",
          files: { "model.onnx": { sha256: "onnx-hash", bytes: 10 } },
          skipped: [],
        };
      },
    });
  }

  async function withCapturedWrites(isTTY: boolean, fn: () => Promise<void>): Promise<string[]> {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await fn();
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    }
    return writes;
  }

  test("TTY: writes a redrawable ANSI progress line", async () => {
    const registry = registryWith(progressDeps());
    const writes = await withCapturedWrites(true, async () => {
      await run(["models", "fetch"], { registry });
    });
    const joined = writes.join("");
    expect(joined).toContain("\x1b");
    expect(joined).toContain("model.onnx");
  });

  test("not a TTY (piped): no ANSI, no progress writes at all", async () => {
    const registry = registryWith(progressDeps());
    const writes = await withCapturedWrites(false, async () => {
      await run(["models", "fetch"], { registry });
    });
    expect(writes.join("")).toBe("");
  });

  test("--json suppresses progress even on a TTY", async () => {
    const registry = registryWith(progressDeps());
    const writes = await withCapturedWrites(true, async () => {
      await run(["models", "fetch", "--json"], { registry });
    });
    expect(writes.join("")).toBe("");
  });
});

describe("models rm", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "myc-models-rm-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("unknown model id -> notfound", async () => {
    const deps = baseDeps({ modelDir: () => dir });
    const { code, envelope } = await jsonOf(["models", "rm", "ghost", "--json"], registryWith(deps));
    expect(code).toBe(ExitCode.NOTFOUND);
    expect(envelope.error.code).toBe("notfound.model");
  });

  test("nothing staged -> idempotent no-op, exit OK", async () => {
    const empty = join(dir, "does-not-exist");
    const deps = baseDeps({ modelDir: () => empty });
    const { code, envelope } = await jsonOf(["models", "rm", "--json"], registryWith(deps));
    expect(code).toBe(ExitCode.OK);
    expect(envelope.data.removed).toBe(false);
  });

  test("removes a staged model directory from disk", async () => {
    const modelPath = join(dir, "test-model");
    await mkdir(modelPath, { recursive: true });
    await writeFile(join(modelPath, "model.onnx"), "bytes");
    const deps = baseDeps({ modelDir: () => modelPath });
    const { code, envelope } = await jsonOf(["models", "rm", "--json"], registryWith(deps));
    expect(code).toBe(ExitCode.OK);
    expect(envelope.data.removed).toBe(true);
    const stillThere = await readdir(dir).then((names) => names.includes("test-model"));
    expect(stillThere).toBe(false);
  });

  test("calling rm twice is idempotent", async () => {
    const modelPath = join(dir, "test-model");
    await mkdir(modelPath, { recursive: true });
    const deps = baseDeps({ modelDir: () => modelPath });
    const registry = registryWith(deps);
    const first = await jsonOf(["models", "rm", "--json"], registry);
    const second = await jsonOf(["models", "rm", "--json"], registry);
    expect(first.envelope.data.removed).toBe(true);
    expect(second.envelope.data.removed).toBe(false);
    expect(second.code).toBe(ExitCode.OK);
  });
});

/**
 * Ниже — реальный @myc/embed (без EmbedDeps-подмены), только сетевой
 * `fetch` подменён глобально: несовпадение чек-суммы гарантировано для
 * любого контента, не совпадающего с зашитым в каталоге хешем, так что
 * преимидж реального файла не нужен.
 */
describe("models fetch: real @myc/embed, network mocked", () => {
  let dir: string;
  let originalEnv: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "myc-models-cli-real-"));
    originalEnv = process.env.MYC_MODELS_DIR;
    process.env.MYC_MODELS_DIR = dir;
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.MYC_MODELS_DIR;
    else process.env.MYC_MODELS_DIR = originalEnv;
    await rm(dir, { recursive: true, force: true });
  });

  test("checksum mismatch is caught; no partial file survives", async () => {
    globalThis.fetch = (async () =>
      new Response("definitely not the real model bytes", {
        status: 200,
        headers: { "content-length": "37" },
      })) as unknown as typeof fetch;

    const registry = new Registry();
    registry.register(createModelsCommand());
    const result = await run(["models", "fetch", "--json"], { registry });
    const envelope = JSON.parse(result.stdout as string);

    expect(result.code).toBe(ExitCode.ERR);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("internal.checksum_mismatch");

    const entries = await readdir(join(dir, DEFAULT_MODEL_ID)).catch(() => [] as string[]);
    expect(entries.some((name) => name.endsWith(".part"))).toBe(false);
    expect(entries.includes("manifest.json")).toBe(false);
  });

  test("network failure is caught and mapped distinctly from a checksum failure", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;

    const registry = new Registry();
    registry.register(createModelsCommand());
    const result = await run(["models", "fetch", "--json"], { registry });
    const envelope = JSON.parse(result.stdout as string);

    expect(result.code).toBe(ExitCode.ERR);
    expect(envelope.error.code).toBe("internal.network");
    expect(envelope.error.code).not.toBe("internal.checksum_mismatch");
  });
});

describe("models: real subprocess, stdout redirected", () => {
  test("`myc models list` piped has no ANSI and no progress noise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myc-models-pipe-"));
    try {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "packages/cli/src/main.ts", "models", "list"],
        cwd: process.cwd(),
        env: { ...process.env, MYC_MODELS_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("\x1b[");
      expect(stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
