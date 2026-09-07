/**
 * Импорт из `.myc/graph/` после `git pull` или свежего клона (решение
 * S42): воспроизвести оплог в базу и пересобрать локальный кеш проекций.
 *
 * Мерж уже случился в git — объединением строк по op_id. Здесь остаётся
 * применить операции, которых в базе ещё нет, через тот же `applyOps`,
 * что принимает пакеты по sync: per-field LWW, OR-Set и G-counter
 * разрешают расхождения одинаково на любой реплике, в любом порядке.
 *
 * Идемпотентность: набор новых операций — разность множеств по op_id,
 * повторный импорт не находит ничего и ничего не меняет; кеш проекций —
 * функция от состояния, его перезапись даёт те же байты. В git кеш не
 * идёт (каталог игнорирует сам себя), поэтому после импорта рабочее
 * дерево остаётся чистым: коммитить после `myc import` нечего.
 *
 * Свои операции (site_id базы) применяются с origin=1: база, восстановленная
 * из git на той же машине, продолжает свою последовательность seq, а не
 * начинает её заново поверх занятых op_id.
 */

import { dirname, join } from "node:path";
import {
  isOplogPath,
  lineToRow,
  readOplogFiles,
  splitLines,
  writeProjectionCache,
  PROJECTION_CACHE_DIR,
  type GraphFiles,
  type ProjectionCacheResult,
} from "./export.ts";
import { rowToOp, type GraphStore, type OplogRow } from "./queries.ts";
import { defineQueries, type Op } from "@myc/core";

const QI = defineQueries({
  oplog_ids_of_site: {
    name: "oplog_ids_of_site",
    sql: "SELECT op_id FROM oplog WHERE site_id = ?1",
    params: ["site_id"],
  },
});

export interface ImportResult {
  readonly dir: string;
  /** файлов оплога прочитано */
  readonly files: number;
  /** строк прочитано */
  readonly read: number;
  /** операций, которых в базе не было */
  readonly fresh: number;
  readonly applied: number;
  readonly duplicate: number;
  readonly stale: number;
  /** операции, которые не удалось применить: узел без kind в логе */
  readonly deferred: string[];
  /** неразрешимые ничьи часов — нарушение инварианта, не конфликт LWW */
  readonly collided: string[];
  readonly sites: number;
  /** кеш проекций пересобран (undefined — не запрашивалось или dry-run) */
  readonly cache?: ProjectionCacheResult;
}

/** Строки всех файлов оплога каталога, с проверкой формата каждой. */
export function parseOplogFiles(files: GraphFiles): { rows: OplogRow[]; files: number } {
  const rows: OplogRow[] = [];
  let count = 0;
  for (const [rel, text] of files) {
    if (!isOplogPath(rel)) continue;
    count++;
    for (const line of splitLines(text)) {
      try {
        rows.push(lineToRow(line));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`${rel}: ${msg}`);
      }
    }
  }
  return { rows, files: count };
}

/**
 * Применить строки оплога, которых в базе ещё нет. Чужие сайты — origin 0,
 * свой — origin 1. Отложенные операции (узел без строки и без kind в
 * пакете) переигрываются, пока пакет уменьшается: kind мог прийти в
 * пакете другого сайта.
 */
export function importOplogRows(store: GraphStore, rows: readonly OplogRow[]): Omit<ImportResult, "dir" | "files" | "cache"> {
  const bySite = new Map<string, OplogRow[]>();
  for (const row of rows) {
    let list = bySite.get(row.site_id);
    if (list === undefined) {
      list = [];
      bySite.set(row.site_id, list);
    }
    list.push(row);
  }

  const foreign: Op[] = [];
  const own: Op[] = [];
  let fresh = 0;
  for (const [siteId, list] of bySite) {
    const known = new Set(
      store.driver.all<{ op_id: string }>(QI.oplog_ids_of_site, [siteId]).map((r) => r.op_id),
    );
    const target = siteId === store.siteId ? own : foreign;
    for (const row of list) {
      if (known.has(row.op_id)) continue;
      fresh++;
      target.push(rowToOp(row));
    }
  }

  let applied = 0;
  let duplicate = 0;
  let stale = 0;
  const collided: string[] = [];
  let deferred: string[] = [];
  const byId = new Map<string, Op>();
  for (const op of foreign) byId.set(op.op_id, op);
  for (const op of own) byId.set(op.op_id, op);

  const run = (ops: readonly Op[], origin: 0 | 1): void => {
    if (ops.length === 0) return;
    const r = store.applyOps(ops, origin);
    applied += r.applied;
    duplicate += r.duplicate;
    stale += r.stale;
    collided.push(...r.collided);
    // Отложенное прошлым вызовом applyOps сам применяет, когда приезжают
    // зависимости (myc-qie.9): такие операции выбывают из deferred.
    if (r.released.length > 0) {
      const released = new Set(r.released);
      deferred = deferred.filter((id) => !released.has(id));
    }
    deferred.push(...r.deferred);
  };

  // Сначала узлы (set/inc), потом рёбра: ребро ссылается на строки узлов
  // (FOREIGN KEY), а порядок по часам гарантирует «узел раньше ребра» лишь
  // при монотонных часах; после зажатого skew (S30) он может нарушиться,
  // и тогда вся транзакция откатилась бы. CRDT коммутативен — фазы безопасны.
  const isEdge = (op: Op): boolean => op.op === "edge_add" || op.op === "edge_del";
  run(foreign.filter((op) => !isEdge(op)), 0);
  run(own.filter((op) => !isEdge(op)), 1);
  run(foreign.filter(isEdge), 0);
  run(own.filter(isEdge), 1);

  // Переигрывание отложенных, пока есть прогресс.
  for (let round = 0; deferred.length > 0 && round < 8; round++) {
    const retry = deferred;
    deferred = [];
    const again = retry.map((id) => byId.get(id)).filter((op): op is Op => op !== undefined);
    run(
      again.filter((op) => op.site_id !== store.siteId),
      0,
    );
    run(
      again.filter((op) => op.site_id === store.siteId),
      1,
    );
    if (deferred.length >= retry.length) break;
  }

  return {
    read: rows.length,
    fresh,
    applied,
    duplicate,
    stale,
    deferred,
    collided,
    sites: bySite.size,
  };
}

export interface ImportOptions {
  /** пересобрать кеш проекций из базы после применения; по умолчанию да */
  readonly rebuildCache?: boolean;
  /** каталог кеша; по умолчанию — сосед каталога графа `../projections` */
  readonly cacheDir?: string;
  /** только посчитать, ничего не применять и не писать */
  readonly dryRun?: boolean;
}

/** Каталог кеша проекций по умолчанию: рядом с каталогом графа, т.е. с базой. */
export function defaultCacheDir(graphDir: string): string {
  return join(dirname(graphDir), PROJECTION_CACHE_DIR);
}

/** Импорт каталога `.myc/graph` целиком: оплог → база → кеш проекций. */
export function importGraph(
  store: GraphStore,
  dir: string,
  opts: ImportOptions = {},
): ImportResult {
  const files = readOplogFiles(dir);
  const parsed = parseOplogFiles(files);

  if (opts.dryRun === true) {
    const bySite = new Map<string, Set<string>>();
    let fresh = 0;
    for (const row of parsed.rows) {
      let known = bySite.get(row.site_id);
      if (known === undefined) {
        known = new Set(
          store.driver
            .all<{ op_id: string }>(QI.oplog_ids_of_site, [row.site_id])
            .map((r) => r.op_id),
        );
        bySite.set(row.site_id, known);
      }
      if (!known.has(row.op_id)) fresh++;
    }
    return {
      dir,
      files: parsed.files,
      read: parsed.rows.length,
      fresh,
      applied: 0,
      duplicate: 0,
      stale: 0,
      deferred: [],
      collided: [],
      sites: bySite.size,
    };
  }

  const result = importOplogRows(store, parsed.rows);
  let cache: ProjectionCacheResult | undefined;
  if (opts.rebuildCache !== false) {
    cache = writeProjectionCache(store.driver, opts.cacheDir ?? defaultCacheDir(dir));
  }
  return {
    dir,
    files: parsed.files,
    ...result,
    ...(cache !== undefined ? { cache } : {}),
  };
}
