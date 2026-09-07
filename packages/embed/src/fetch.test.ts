import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchModel,
  isModelPresent,
  FetchModelError,
} from "./fetch.ts";
import { getModelSpec, type ModelFileSpec } from "./registry.ts";

const CONTENT: Record<string, string> = {
  "model.onnx": "fake-onnx-bytes",
  "vocab.txt": "fake-vocab\nlines\n",
  "config.json": '{"model_type":"bert"}',
};

function specs(): ModelFileSpec[] {
  return Object.entries(CONTENT).map(([name, body]) => ({
    name,
    url: `https://models.test/${name}`,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
  }));
}

function stubFetchFor(files: Record<string, string>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const key = String(url);
    calls.push(key);
    const body = files[key];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(body.length) },
    });
  }) as typeof fetch;
  return { impl, calls };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "myc-embed-fetch-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fetchModel", () => {
  test("скачивает, проверяет sha256, пишет manifest", async () => {
    const { impl, calls } = stubFetchFor(
      Object.fromEntries(specs().map((f) => [f.url, CONTENT[f.name]!])),
    );
    const result = await fetchModel({ dir, fetchImpl: impl, expectedFiles: specs() });
    expect(Object.keys(result.files).sort()).toEqual(
      specs().map((f) => f.name).sort(),
    );
    expect(result.skipped).toEqual([]);
    expect(calls.length).toBe(specs().length);
    // isModelPresent сверяет с зашитым каталогом хешей, а не с подменёнными.
    expect(await isModelPresent("bge-small-en-v1.5-q8", dir)).toBe(false);
  });

  test("битые байты → checksum_mismatch, manifest не пишется", async () => {
    const files: Record<string, string> = {};
    for (const f of specs()) files[f.url] = `НЕ те байты (${f.name})`;
    const { impl } = stubFetchFor(files);
    try {
      await fetchModel({ dir, fetchImpl: impl, expectedFiles: specs() });
      expect.unreachable();
    } catch (e) {
      expect((e as FetchModelError).code).toBe("checksum_mismatch");
    }
    expect(await readFileMaybe(join(dir, "manifest.json"))).toBeNull();
  });

  test("частичное скачивание не оставляет .part после сбоя", async () => {
    const all = specs();
    const files: Record<string, string> = {};
    for (const f of all) files[f.url] = CONTENT[f.name]!;
    files[all[1]!.url] = "испорчено";
    const { impl } = stubFetchFor(files);
    try {
      await fetchModel({ dir, fetchImpl: impl, expectedFiles: all });
      expect.unreachable();
    } catch (e) {
      expect((e as FetchModelError).code).toBe("checksum_mismatch");
    }
    const parts = await Array.fromAsync(new Bun.Glob("**/*.part").scan({ cwd: dir }));
    expect(parts).toEqual([]);
  });

  test("HTTP 500 → http_error", async () => {
    const impl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    try {
      await fetchModel({ dir, fetchImpl: impl, expectedFiles: specs() });
      expect.unreachable();
    } catch (e) {
      expect((e as FetchModelError).code).toBe("http_error");
    }
  });

  test("сеть недоступна → network_error", async () => {
    const impl = (async () => {
      throw new Error("EHOSTUNREACH");
    }) as unknown as typeof fetch;
    try {
      await fetchModel({ dir, fetchImpl: impl, expectedFiles: specs() });
      expect.unreachable();
    } catch (e) {
      expect((e as FetchModelError).code).toBe("network_error");
    }
  });

  test("идемпотентность: целые файлы не перекачиваются", async () => {
    const all = specs();
    const files: Record<string, string> = {};
    for (const f of all) files[f.url] = CONTENT[f.name]!;
    const { impl, calls } = stubFetchFor(files);
    const first = await fetchModel({ dir, fetchImpl: impl, expectedFiles: all });
    expect(first.skipped).toEqual([]);
    const second = await fetchModel({ dir, fetchImpl: impl, expectedFiles: all });
    expect([...second.skipped].sort()).toEqual(all.map((f) => f.name).sort());
    expect(calls.length).toBe(all.length);
  });

  test("прод-спецификация по умолчанию: синтетика всегда отвергается", async () => {
    // Гарантия фиксации: без expectedFiles хеши сверяются с зашитыми.
    const files: Record<string, string> = {};
    for (const f of getModelSpec().files) files[f.url] = `content-of-${f.name}`;
    const { impl } = stubFetchFor(files);
    try {
      await fetchModel({ dir, fetchImpl: impl });
      expect.unreachable();
    } catch (e) {
      expect((e as FetchModelError).code).toBe("checksum_mismatch");
    }
  });

  test("неизвестная модель → ошибка с пояснением", async () => {
    try {
      await fetchModel({ modelId: "no-such-model", dir, fetchImpl: fetch });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("неизвестная модель");
    }
  });
});

async function readFileMaybe(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}
