import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MODEL_ID, defaultModelsDir, modelDir } from "./model-id.ts";
import {
  getModelSpec,
  type ModelFileSpec,
  type ModelSpec,
} from "./registry.ts";

// Каталог моделей и его путь живут в model-id.ts — том же лёгком модуле,
// который читает дешёвый привратник CLI. Здесь только реэкспорт, чтобы
// публичный API пакета не менялся и второй копии пути не появилось.
export { defaultModelsDir, modelDir } from "./model-id.ts";

/**
 * Загрузка модели: отдельная команда (`myc models fetch`), НЕ при
 * первом запуске. Качает файлы каталога, проверяет sha256, пишет
 * manifest.json последним (его наличие = модель целая). Частичные
 * скачивания не переживают сбой: файл пишется в `<name>.part`.
 *
 * Единственное место пакета, где есть сеть — и она никогда не
 * вызывается из Embedder.
 */

export interface FetchProgress {
  readonly file: string;
  readonly phase: "download" | "verify" | "done";
  readonly loadedBytes: number;
  readonly totalBytes: number | null;
}

export interface FetchedFileRecord {
  readonly sha256: string;
  readonly bytes: number;
}

export interface FetchModelResult {
  readonly modelId: string;
  readonly dir: string;
  /** Имя → запись по скачанным/проверенным файлам. */
  readonly files: Readonly<Record<string, FetchedFileRecord>>;
  /** Файлы, которые уже лежали целыми и не перекачивались. */
  readonly skipped: readonly string[];
}

export type FetchModelErrorCode =
  | "checksum_mismatch"
  | "network_error"
  | "http_error"
  | "fs_error"
  | "unknown_model";

export class FetchModelError extends Error {
  readonly code: FetchModelErrorCode;
  constructor(code: FetchModelErrorCode, message: string) {
    super(message);
    this.name = "FetchModelError";
    this.code = code;
  }
}

export interface FetchModelOptions {
  /** id из каталога MODELS; по умолчанию DEFAULT_MODEL_ID. */
  readonly modelId?: string;
  /** Каталог для модели; по умолчанию defaultModelsDir()/<modelId>. */
  readonly dir?: string;
  /** Подмена fetch (тесты). */
  readonly fetchImpl?: typeof fetch;
  /**
   * Подмена спецификации файлов с хешами — ТОЛЬКО для тестов; в
   * проде всегда зашитый каталог (иначе смысл фиксации хешей исчезает).
   */
  readonly expectedFiles?: readonly ModelFileSpec[];
  readonly onProgress?: (p: FetchProgress) => void;
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function joinDir(dir: string, name: string): string {
  return join(dir, name);
}

async function fileBytes(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** Цел ли файл: существует, размер совпадает, sha256 сходится. */
async function isFileIntact(
  path: string,
  spec: { sha256: string; bytes: number },
): Promise<boolean> {
  if ((await fileBytes(path)) !== spec.bytes) return false;
  try {
    return (await sha256File(path)) === spec.sha256;
  } catch {
    return false;
  }
}

interface Manifest {
  readonly modelId: string;
  readonly dim: number;
  readonly files: Record<string, FetchedFileRecord>;
  readonly fetchedAt: number;
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const text = await readFile(joinDir(dir, "manifest.json"), "utf8");
    return JSON.parse(text) as Manifest;
  } catch {
    return null;
  }
}

/** Модель целая и готова к работе? Ничего не качает, не бросает. */
export async function isModelPresent(
  modelId: string = DEFAULT_MODEL_ID,
  dir?: string,
): Promise<boolean> {
  let spec: ModelSpec;
  try {
    spec = getModelSpec(modelId);
  } catch {
    return false;
  }
  const target = modelDir(modelId, dir);
  const manifest = await readManifest(target);
  if (manifest === null || manifest.modelId !== modelId) return false;
  for (const f of spec.files) {
    const record = manifest.files[f.name];
    if (record === undefined || record.sha256 !== f.sha256) return false;
    if (!(await isFileIntact(joinDir(target, f.name), f))) return false;
  }
  return true;
}

async function download(
  url: string,
  destPart: string,
  fetchImpl: typeof fetch,
  spec: { sha256: string },
  report: (p: FetchProgress) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new FetchModelError(
      "network_error",
      `failed to download ${url}: ${String(cause)}`,
    );
  }
  if (!response.ok || response.body === null) {
    throw new FetchModelError(
      "http_error",
      `${url}: HTTP ${response.status} without a body`,
    );
  }
  const total = Number(response.headers.get("content-length") ?? "0") || null;
  const hash = createHash("sha256");
  let loaded = 0;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    hash.update(value);
    loaded += value.byteLength;
    report({ file: url, phase: "download", loadedBytes: loaded, totalBytes: total });
  }
  const digest = hash.digest("hex");
  if (digest !== spec.sha256) {
    await rm(destPart, { force: true });
    throw new FetchModelError(
      "checksum_mismatch",
      `sha256 mismatch for ${url}: expected ${spec.sha256}, got ${digest}`,
    );
  }
  await writeFile(destPart, Buffer.concat(chunks.map((c) => Buffer.from(c))));
  report({ file: url, phase: "verify", loadedBytes: loaded, totalBytes: total });
}

/**
 * Скачать и проверить модель. Идемпотентна: целые файлы не
 * перекачиваются (перекачка только битых/отсутствующих).
 */
export async function fetchModel(
  options: FetchModelOptions = {},
): Promise<FetchModelResult> {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const spec = getModelSpec(modelId);
  const target = modelDir(modelId, options.dir);
  const fetchImpl = options.fetchImpl ?? fetch;
  const report = options.onProgress ?? (() => {});
  const expected: readonly ModelFileSpec[] = options.expectedFiles ?? spec.files;
  const skipped: string[] = [];
  const files: Record<string, FetchedFileRecord> = {};

  try {
    await mkdir(target, { recursive: true });
  } catch (cause) {
    throw new FetchModelError("fs_error", `cannot create ${target}: ${String(cause)}`);
  }

  for (const f of expected) {
    const dest = joinDir(target, f.name);
    if (await isFileIntact(dest, f)) {
      skipped.push(f.name);
      files[f.name] = { sha256: f.sha256, bytes: f.bytes };
      report({ file: f.name, phase: "done", loadedBytes: f.bytes, totalBytes: f.bytes });
      continue;
    }
    const part = `${dest}.part`;
    await download(f.url, part, fetchImpl, f, (p) =>
      report({ ...p, file: f.name }),
    );
    const actual = await sha256File(part);
    if (actual !== f.sha256) {
      await rm(part, { force: true });
      throw new FetchModelError(
        "checksum_mismatch",
        `sha256 of the written ${f.name} does not match: ${actual}`,
      );
    }
    await rename(part, dest);
    files[f.name] = { sha256: f.sha256, bytes: f.bytes };
    report({ file: f.name, phase: "done", loadedBytes: f.bytes, totalBytes: f.bytes });
  }

  const manifest: Manifest = {
    modelId,
    dim: spec.dim,
    files,
    fetchedAt: Date.now(),
  };
  // Manifest пишется последним: его валидность = модель целиком на месте.
  await writeFile(joinDir(target, "manifest.json"), JSON.stringify(manifest));
  return { modelId, dir: target, files, skipped };
}

/** Пути файлов модели, если она целая; иначе null. Ничего не качает. */
export async function resolveModelPaths(
  modelId: string = DEFAULT_MODEL_ID,
  dir?: string,
): Promise<{ modelOnnx: string; tokenizerPath: string; dir: string } | null> {
  if (!(await isModelPresent(modelId, dir))) return null;
  const target = modelDir(modelId, dir);
  return {
    modelOnnx: joinDir(target, "model.onnx"),
    tokenizerPath: joinDir(target, getModelSpec(modelId).tokenizerFile),
    dir: target,
  };
}

/**
 * Трёхсостоянийная проверка: модели нет ("absent"), модель скачана,
 * но байты не сходятся с зафиксированными чек-суммами ("corrupt"),
 * или всё цело ("present"). corrupt ≠ absent: побитую модель надо
 * честно показывать как деградацию, а не как «не скачано».
 */
export type ModelPresence =
  | { readonly status: "absent" }
  | { readonly status: "corrupt"; readonly badFiles: readonly string[] }
  | {
      readonly status: "present";
      readonly modelOnnx: string;
      /** Файл токенизатора: vocab.txt у WordPiece, tokenizer.json у Unigram. */
      readonly tokenizerPath: string;
      readonly dir: string;
    };

export async function checkModelPresence(
  modelId: string = DEFAULT_MODEL_ID,
  dir?: string,
): Promise<ModelPresence> {
  const spec = getModelSpec(modelId);
  const target = modelDir(modelId, dir);
  const manifest = await readManifest(target);
  if (manifest === null || manifest.modelId !== modelId) {
    return { status: "absent" };
  }
  const badFiles: string[] = [];
  for (const f of spec.files) {
    const record = manifest.files[f.name];
    if (record === undefined || record.sha256 !== f.sha256) {
      badFiles.push(f.name);
      continue;
    }
    if (!(await isFileIntact(joinDir(target, f.name), f))) badFiles.push(f.name);
  }
  if (badFiles.length > 0) return { status: "corrupt", badFiles };
  return {
    status: "present",
    modelOnnx: joinDir(target, "model.onnx"),
    tokenizerPath: joinDir(target, spec.tokenizerFile),
    dir: target,
  };
}
