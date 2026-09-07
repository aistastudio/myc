/**
 * `myc import` — после `git clone`/`git pull`/`git merge`: воспроизвести
 * оплог из `.myc/graph/` в базу и пересобрать локальный кеш проекций
 * `.myc/projections/` (решение S42). Кеш в git не идёт, так что после
 * импорта коммитить нечего.
 *
 * Первый import в свежем клоне поднимает базу сам (memory-hnh8r8304s27):
 * `.myc/workspace.toml` приехал из git, `myc.db` в `.gitignore` — не хватает
 * ровно того, что и так создаётся из этого конфига. Это безопасно, потому
 * что личность НЕ ВЫДУМЫВАЕТСЯ: слаг берётся из приехавшего конфига, сам
 * конфиг не переписывается, и без него (каталог графа есть, а конфига нет)
 * автоподъёма не происходит вовсе — остаётся прежняя ошибка и `myc init`.
 * Раньше подсказка всё равно вела в `init`, а `init` на этом шаге и ломал
 * обмен, переписывая общий слаг именем каталога.
 *
 * Применяются только операции, которых в базе нет (разность по op_id);
 * расхождения разрешает CRDT в applyOps — LWW, OR-Set, G-counter. Повторный
 * вызов ничего не находит и ничего не меняет. Отложенные и коллизионные
 * операции — громкая деградация (И2): WARN в человеческом выводе,
 * meta.degraded[] в конверте, при --strict код 7.
 */

import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { importGraph, type ImportResult } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import { adoptWorkspaceDb } from "./init.ts";
import { flagBool, type StoreDeps, realStoreDeps } from "./store.ts";
import { resolveCacheDir, resolveGraphDir } from "./export.ts";

interface ImportData extends ImportResult {
  dry_run: boolean;
  /** База поднята этим же вызовом (свежий клон), под слагом из конфига. */
  initialized?: { db: string; slug: string; site_id: string };
  took_ms: number;
}

function renderImportHuman(raw: unknown): string {
  const d = raw as ImportData;
  const lines: string[] = [];
  const head = d.dry_run ? "dry-run: " : "";
  lines.push(
    `${head}${d.dir}: файлов ${d.files}, строк ${d.read}, новых ${d.fresh}` +
      (d.dry_run ? "" : `, применено ${d.applied}, устаревших ${d.stale}, повторов ${d.duplicate}`),
  );
  if (d.initialized !== undefined) {
    lines.push(
      `  · ${d.initialized.db} создана под slug=${d.initialized.slug} из .myc/workspace.toml ` +
        `(site_id ${d.initialized.site_id})`,
    );
  }
  if (d.cache !== undefined) {
    lines.push(
      `  кеш ${d.cache.dir}: ${d.cache.nodes} узлов, ${d.cache.edges} рёбер; ` +
        `переписано ${d.cache.files.written.length}, без изменений ${d.cache.files.unchanged.length}` +
        (d.cache.files.removed.length > 0 ? `, удалено пустых ${d.cache.files.removed.length}` : ""),
    );
  }
  if (d.deferred.length > 0) lines.push(`  ! не применено ${d.deferred.length}: узел без kind в логе`);
  if (d.collided.length > 0) lines.push(`  ! коллизий часов ${d.collided.length}`);
  lines.push(`готово за ${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

/**
 * Свежий клон: каталог графа есть, базы рядом с ним нет. Поднимаем базу под
 * слаг из того же `.myc/`, куда её и положит `myc init`, — тогда `openStore`
 * (он ищет с того же каталога, что и resolveGraphDir) найдёт именно её.
 *
 * Границы узкие намеренно: `--dry-run` обещает не менять ничего и не
 * меняет (в клоне он по-прежнему упрётся в `ws.not_initialized`), явный
 * `--db` отменяет автоподъём (пользователь назвал файл — значит, знает,
 * какой), и каталог графа обязан лежать в `.myc/` (иначе `--from` откуда
 * угодно создавал бы базы в чужих местах).
 */
async function autoInit(
  ctx: CommandContext,
  graphDir: string,
): Promise<{ db: string; slug: string; site_id: string } | undefined> {
  if (ctx.globals.db !== undefined || flagBool(ctx, "dry-run")) return undefined;
  const mycDir = dirname(graphDir);
  if (basename(mycDir) !== ".myc") return undefined;
  const adopted = await adoptWorkspaceDb(mycDir);
  if (adopted === undefined) return undefined;
  return { db: adopted.dbPath, slug: adopted.slug, site_id: adopted.siteId };
}

export function createImportCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "import",
    summary: "replay .myc/graph oplog into the db and rebuild the local projection cache",
    flags: [
      { name: "from", value: "string", description: "graph directory (default .myc/graph)" },
      { name: "cache", value: "string", description: "projection cache directory (default .myc/projections)" },
      { name: "dry-run", description: "count new operations, change nothing" },
      { name: "no-cache", description: "do not rebuild the node/edge projection cache" },
    ],
    help:
      "Idempotent: only operations missing from the local oplog are applied, through the " +
      "same CRDT path as sync (per-field LWW, add-wins edges, G-counters). The projection " +
      "cache is a pure function of the merged log and is never committed (its directory " +
      "ignores itself), so nothing needs to be committed after an import. In a fresh clone " +
      "the local db is created here from the committed .myc/workspace.toml (its slug is " +
      "taken as is, the file is never rewritten); without that config nothing is created " +
      "and `myc init` stays the answer.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const dir = resolveGraphDir(ctx, "from");
      if (!existsSync(dir)) {
        return failure(
          "notfound.graph_dir",
          `каталог графа не найден: ${dir}`,
          ExitCode.NOTFOUND,
          "myc export создаёт его",
        );
      }
      const initialized = await autoInit(ctx, dir);
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const dryRun = flagBool(ctx, "dry-run");
        let result: ImportResult;
        try {
          result = importGraph(h.store, dir, {
            dryRun,
            rebuildCache: !flagBool(ctx, "no-cache"),
            cacheDir: resolveCacheDir(ctx),
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return failure("precond.graph_format", `файл оплога не разбирается: ${msg}`, ExitCode.PRECOND);
        }
        if (result.deferred.length > 0) {
          ctx.warn(
            "import.deferred",
            `${result.deferred.length} операций не применены: узел без kind в логе (${result.deferred.slice(0, 3).join(", ")}…)`,
          );
        }
        if (result.collided.length > 0) {
          ctx.warn(
            "import.clock_collision",
            `${result.collided.length} операций с неразрешимой ничьёй часов (${result.collided.slice(0, 3).join(", ")}…)`,
          );
        }
        const data: ImportData = {
          ...result,
          dry_run: dryRun,
          ...(initialized !== undefined ? { initialized } : {}),
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data };
      } finally {
        h.close();
      }
    },
    renderHuman: renderImportHuman,
  };
}
