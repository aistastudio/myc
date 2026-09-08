/**
 * `myc export` — оплог в `.myc/graph/` для коммита (решение S42).
 *
 * В git идёт ТОЛЬКО оплог (oplog/<site>/<NNNNN>.jsonl, по 1000 операций в
 * файле) плюс meta.json и .gitattributes с единственным драйвером слияния.
 * Проекции узлов и рёбер — локальный кеш `.myc/projections/`, его
 * пересобирает `myc import`; в репозиторий он не попадает. Экспорт
 * детерминирован и монотонен: чужие файлы оплога не трогаются, свой файл
 * только растёт, совпадающие файлы не переписываются, а проекции,
 * оставшиеся в каталоге от первой редакции S42, удаляются. Логика —
 * @myc/store-sqlite/export.ts; здесь только грамматика и вывод.
 */

import { resolve, join } from "node:path";
import {
  exportGraph,
  OplogCollisionError,
  OPLOG_FILE_OPS,
  OPLOG_MERGE_DRIVER,
  PROJECTION_CACHE_DIR,
  type ExportResult,
} from "@myc/store-sqlite";
import type { Command, CommandContext } from "../registry.ts";
import { ExitCode } from "../exit.ts";
import { flagStr, type StoreDeps, realStoreDeps } from "./store.ts";

export const GRAPH_DIR = join(".myc", "graph");
/** Кеш проекций — рядом с базой, не коммитится (каталог игнорирует сам себя). */
export const CACHE_DIR = join(".myc", PROJECTION_CACHE_DIR);

/** Каталог графа: --out, иначе <workspace>/.myc/graph. */
export function resolveGraphDir(ctx: CommandContext, flag = "out"): string {
  const explicit = flagStr(ctx, flag);
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  return explicit !== undefined ? resolve(dir, explicit) : join(dir, GRAPH_DIR);
}

/** Каталог кеша проекций: --cache, иначе <workspace>/.myc/projections. */
export function resolveCacheDir(ctx: CommandContext, flag = "cache"): string {
  const explicit = flagStr(ctx, flag);
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  return explicit !== undefined ? resolve(dir, explicit) : join(dir, CACHE_DIR);
}

export const GIT_SETUP_HINT = `git config merge.${OPLOG_MERGE_DRIVER}.driver "myc merge-driver %O %A %B %L %P"`;

interface ExportData extends ExportResult {
  took_ms: number;
}

function renderExportHuman(raw: unknown): string {
  const d = raw as ExportData;
  const lines = [
    `${d.dir}: ${d.ops} операций (${d.sites} сайт${d.sites === 1 ? "" : "ов"}, по ${OPLOG_FILE_OPS} в файле)`,
    `  записано ${d.files.written.length}, без изменений ${d.files.unchanged.length}` +
      (d.files.removed.length > 0 ? `, удалено проекций ${d.files.removed.length}` : ""),
  ];
  if (d.pendingImport > 0) {
    lines.push(`  ! в файлах ${d.pendingImport} операций, которых нет в базе — myc import`);
  }
  lines.push(`готово за ${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

export function createExportCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "export",
    summary: "write the oplog to .myc/graph for git (nothing derived is committed)",
    flags: [
      { name: "out", value: "string", description: "target directory (default .myc/graph)" },
    ],
    help:
      "S42: only the oplog goes to git and it is merged by union on op_id (no text merge). " +
      "Node/edge projections are a local cache in .myc/projections, rebuilt by `myc import` " +
      "and never committed. Export never deletes or truncates oplog files; projection files " +
      "left in .myc/graph by the old format are removed. Register the one merge driver once " +
      "per clone:\n  " +
      GIT_SETUP_HINT,
    handler: async (ctx) => {
      const t0 = performance.now();
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        let result: ExportResult;
        try {
          result = exportGraph(h.driver, resolveGraphDir(ctx));
        } catch (e) {
          // Коллизия op_id — не сбой программы, а состояние каталога, которое
          // человек может разобрать (S65). Общий обработчик выдавал за неё
          // `internal.unexpected`, то есть «myc сломался» вместо «две базы
          // делят site_id». Код тот же, что у драйвера слияния на том же
          // событии: расходиться им незачем.
          if (e instanceof OplogCollisionError) {
            return {
              ok: false,
              code: "conflict.op_id",
              msg: e.message,
              exit: ExitCode.CONFLICT,
              hint: "две живые базы под одним site_id — обычно копия каталога воркспейса (cp -R/rsync), а не клон; см. S65 в docs/design/ARCHITECTURE.md",
            };
          }
          throw e;
        }
        if (result.pendingImport > 0) {
          ctx.warn(
            "export.pending_import",
            `${result.pendingImport} операций из ${result.dir} ещё не в базе — выполните myc import`,
          );
        }
        const data: ExportData = { ...result, took_ms: Math.round(performance.now() - t0) };
        return { ok: true, data };
      } finally {
        h.close();
      }
    },
    renderHuman: renderExportHuman,
  };
}
