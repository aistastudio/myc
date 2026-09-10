import { join } from "node:path";
import { rm as rmDir, stat } from "node:fs/promises";
import {
  DEFAULT_MODEL_ID,
  FetchModelError,
  MODELS,
  fetchModel,
  getModelSpec,
  isModelPresent,
  modelDir,
  sha256File,
  type FetchModelResult,
  type FetchProgress,
  type ModelSpec,
} from "@myc/embed";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandResult } from "../registry.ts";

/**
 * `myc models …` — управление локально уложенными моделями эмбеддинга.
 *
 * Никакой сети при обычной работе: только `models fetch` её касается,
 * и то один раз на файл — целые файлы не перекачиваются (idempotent).
 * Проверка целостности берётся из @myc/embed как есть; здесь только
 * CLI-обвязка: конверт, коды выхода, прогресс на TTY.
 *
 * Обращения к @myc/embed идут через `EmbedDeps`, а не напрямую: реальные
 * хеши каталога моделей — это чужие большие бинарники, их byte-for-byte
 * offline не воспроизвести, поэтому тест подменяет весь набор функций.
 */

export interface EmbedDeps {
  readonly MODELS: Readonly<Record<string, ModelSpec>>;
  readonly DEFAULT_MODEL_ID: string;
  getModelSpec(modelId: string): ModelSpec;
  modelDir(modelId: string): string;
  sha256File(path: string): Promise<string>;
  isModelPresent(modelId: string): Promise<boolean>;
  fetchModel(options: {
    modelId: string;
    onProgress?: (p: FetchProgress) => void;
  }): Promise<FetchModelResult>;
}

const realDeps: EmbedDeps = {
  MODELS,
  DEFAULT_MODEL_ID,
  getModelSpec,
  modelDir: (id) => modelDir(id),
  sha256File,
  isModelPresent: (id) => isModelPresent(id),
  fetchModel: (options) => fetchModel(options),
};

type ModelStatus = "absent" | "corrupt" | "present";

interface ModelDescription {
  readonly id: string;
  readonly status: ModelStatus;
  readonly dim: number;
  readonly expectedBytes: number;
  readonly localBytes: number;
  readonly fingerprint: string | null;
  readonly badFiles: readonly string[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)}${units[i]}`;
}

/**
 * Статус модели без сети: "present" через isModelPresent (manifest +
 * побайтовая проверка); иначе смотрим файлы напрямую, чтобы отличить
 * "ничего не лежит" от "лежит, но побито".
 */
async function describeModel(deps: EmbedDeps, modelId: string): Promise<ModelDescription> {
  const spec = deps.getModelSpec(modelId);
  const expectedBytes = spec.files.reduce((sum, f) => sum + f.bytes, 0);
  const dir = deps.modelDir(modelId);

  if (await deps.isModelPresent(modelId)) {
    const primary = spec.files[0];
    const fingerprint = primary
      ? (await deps.sha256File(join(dir, primary.name))).slice(0, 12)
      : null;
    return {
      id: modelId,
      status: "present",
      dim: spec.dim,
      expectedBytes,
      localBytes: expectedBytes,
      fingerprint,
      badFiles: [],
    };
  }

  let anyOnDisk = false;
  let localBytes = 0;
  const badFiles: string[] = [];
  for (const f of spec.files) {
    const path = join(dir, f.name);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      continue;
    }
    anyOnDisk = true;
    localBytes += size;
    const actual = await deps.sha256File(path).catch(() => null);
    if (size !== f.bytes || actual !== f.sha256) badFiles.push(f.name);
  }

  return {
    id: modelId,
    status: anyOnDisk ? "corrupt" : "absent",
    dim: spec.dim,
    expectedBytes,
    localBytes,
    fingerprint: null,
    badFiles,
  };
}

function resolveModelId(ctx: CommandContext, deps: EmbedDeps): string {
  return ctx.args[0] ?? deps.DEFAULT_MODEL_ID;
}

function unknownModel(deps: EmbedDeps, modelId: string): CommandResult {
  return {
    ok: false,
    code: "notfound.model",
    msg: `unknown model "${modelId}"; known: ${Object.keys(deps.MODELS).join(", ")}`,
    exit: ExitCode.NOTFOUND,
  };
}

/** Прогресс только на реальном терминале: пайп и файл читает модель. */
function progressAllowed(ctx: CommandContext): boolean {
  return (
    process.stdout.isTTY === true &&
    !ctx.globals.json &&
    !ctx.globals.ndjson &&
    !ctx.globals.quiet
  );
}

function progressLine(p: FetchProgress): string {
  const pct =
    p.totalBytes !== null
      ? ` ${Math.min(100, Math.round((p.loadedBytes / p.totalBytes) * 100))}%`
      : "";
  const size =
    p.totalBytes !== null
      ? `${formatBytes(p.loadedBytes)}/${formatBytes(p.totalBytes)}`
      : formatBytes(p.loadedBytes);
  // \x1b[K стирает хвост предыдущей (более длинной) строки при перерисовке.
  return `\r${p.file}${pct} ${size}\x1b[K`;
}

const FETCH_ERROR_CODE: Record<string, string> = {
  checksum_mismatch: "internal.checksum_mismatch",
  network_error: "internal.network",
  http_error: "internal.http",
  fs_error: "internal.fs",
  unknown_model: "notfound.model",
};

function buildListCommand(deps: EmbedDeps): Command {
  return {
    name: "list",
    summary: "known models: staged locally or not, size, fingerprint",
    handler: async () => {
      const descriptions = await Promise.all(
        Object.keys(deps.MODELS).map((id) => describeModel(deps, id)),
      );
      return {
        ok: true,
        data: descriptions.map((d) => ({
          id: d.id,
          status: d.status,
          dim: d.dim,
          size: d.status === "absent" ? "-" : formatBytes(d.localBytes),
          fingerprint: d.fingerprint ?? "-",
        })),
        meta: { count: descriptions.length },
      };
    },
  };
}

function buildFetchCommand(deps: EmbedDeps): Command {
  return {
    name: "fetch",
    summary: "download a model with sha256 verification (idempotent)",
    help: "Calling it again for a model that is already installed downloads nothing.",
    handler: async (ctx): Promise<CommandResult> => {
      const modelId = resolveModelId(ctx, deps);
      if (!(modelId in deps.MODELS)) return unknownModel(deps, modelId);

      if (await deps.isModelPresent(modelId)) {
        const spec = deps.getModelSpec(modelId);
        return {
          ok: true,
          data: {
            modelId,
            dir: deps.modelDir(modelId),
            downloaded: [],
            skipped: spec.files.map((f) => f.name),
            alreadyPresent: true,
          },
          meta: { note: "model already installed, the network was not used" },
        };
      }

      const showProgress = progressAllowed(ctx);
      let lastLineLength = 0;
      const onProgress = showProgress
        ? (p: FetchProgress) => {
            const line = progressLine(p);
            lastLineLength = line.length;
            process.stdout.write(line);
          }
        : undefined;

      try {
        const result: FetchModelResult = await deps.fetchModel({ modelId, onProgress });
        if (showProgress && lastLineLength > 0) process.stdout.write("\r\x1b[K");
        const downloaded = Object.keys(result.files).filter(
          (name) => !result.skipped.includes(name),
        );
        return {
          ok: true,
          data: {
            modelId: result.modelId,
            dir: result.dir,
            downloaded,
            skipped: result.skipped,
            alreadyPresent: false,
          },
        };
      } catch (e) {
        if (showProgress && lastLineLength > 0) process.stdout.write("\r\x1b[K");
        if (e instanceof FetchModelError) {
          return {
            ok: false,
            code: FETCH_ERROR_CODE[e.code] ?? "internal.unexpected",
            msg: e.message,
            exit: e.code === "unknown_model" ? ExitCode.NOTFOUND : ExitCode.ERR,
          };
        }
        throw e;
      }
    },
  };
}

function buildRmCommand(deps: EmbedDeps): Command {
  return {
    name: "rm",
    summary: "remove a locally staged model",
    handler: async (ctx): Promise<CommandResult> => {
      const modelId = resolveModelId(ctx, deps);
      if (!(modelId in deps.MODELS)) return unknownModel(deps, modelId);

      const dir = deps.modelDir(modelId);
      let existed = true;
      try {
        await stat(dir);
      } catch {
        existed = false;
      }
      if (!existed) {
        return { ok: true, data: { modelId, dir, removed: false } };
      }
      await rmDir(dir, { recursive: true, force: true });
      return { ok: true, data: { modelId, dir, removed: true } };
    },
  };
}

export function createModelsCommand(deps: EmbedDeps = realDeps): Command {
  return {
    name: "models",
    summary: "manage local embedding models",
    subcommands: [buildListCommand(deps), buildFetchCommand(deps), buildRmCommand(deps)],
  };
}

export const modelsCommand: Command = createModelsCommand();
