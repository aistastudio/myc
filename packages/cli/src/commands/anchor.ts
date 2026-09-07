/**
 * `myc anchor` — связь код↔знание (§3.16 docs/design/03-interfaces-and-integration.md).
 *
 * Здесь ВХОД в движок якорей. Движок (`@myc/code-intel/anchors`) и таблица
 * `anchors` существовали до этой команды, но позвать их было нечем: класс
 * задачи для роутинга считается по якорям и потому у всех задач был
 * `*:unknown`, а `myc wire` при каждой установке печатал, что хук post-edit не
 * поставлен — «команды `myc anchor` нет в этой сборке».
 *
 * МОДЕЛЬ ДАННЫХ — ТА, ЧТО УЖЕ ЧИТАЕТ ОЧЕРЕДЬ. Якорь это ОТДЕЛЬНЫЙ узел
 * `kind='anchor'` со статусом из четырёх (`fresh│drifted│stale│lost`), строка
 * в `anchors` с его id и ребро `touches` от задачи/памяти к нему. Не выдумано
 * здесь: ровно так его читает `ready` (ANCHOR_SUBQ: `edges.type='touches'` →
 * `nodes.kind='anchor'` → `status`), и первичный ключ `anchors.node_id`
 * допускает единственную строку на узел — то есть узел ЕСТЬ якорь. Привязать
 * второй якорь к задаче значит завести второй anchor-узел, а не вторую строку.
 *
 * ЦЕНА КАЖДОЙ ПОДКОМАНДЫ РАЗНАЯ, И ЭТО ГЛАВНОЕ В ФАЙЛЕ:
 *
 *   touch — ХОЛОДНЫЙ ПУТЬ РЕДАКТОРА. База не открывается вовсе: подъём к
 *           корню воркспейса и один `appendFileSync` в журнал грязных файлов.
 *           См. шапку `buildAnchorTouch` — там числа и то, что было отвергнуто.
 *   of    — горячий путь чтения: один индексный запрос, бюджет < 1 мс.
 *   add   — запись: узел, ребро и строка якоря.
 *   check — фон: лестница §7.2 по батчу.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. `myc anchor repair` (нечёткая ре-привязка winnowing и
 * запрос к graft, §7.3 шаги 2–3) — задача memory-5c03r9t5n472. Пока её нет,
 * `check` честно оставляет ненайденный текст в `stale` и НЕ выдумывает
 * `drifted`: состояние `drifted` означает «нашли в другом месте с известным
 * сходством», и ставить его без меры сходства значило бы врать числом.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { AnchorCheck, AnchorState, MaxLevel } from "@myc/code-intel/anchors";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import { findWorkspaceDb } from "./wsfind.ts";
import type { StoreDeps, StoreHandle } from "./store.ts";

/**
 * ТЯЖЁЛОЕ ЗАГРУЖАЕТСЯ ВНУТРИ ОБРАБОТЧИКА, А НЕ НАВЕРХУ ФАЙЛА, и это условие
 * бюджета хука, а не стиль. Реестр отложенный (register.ts), но отложен он
 * ДО КОМАНДЫ: вызвав `myc anchor touch`, хост подтягивает весь модуль
 * `anchor.ts` целиком, а с ним — всё, что тот импортирует статически.
 * Замерено на собранном бинаре, 500 вызовов подряд:
 *
 *   статический import store.ts + code-intel   p50 9.44 мс собственной работы
 *   те же импорты внутри обработчиков          p50 0.55 мс
 *
 * store.ts тянет @myc/core, @myc/store-sqlite и bun:sqlite; `touch` не
 * открывает базу вовсе, и платить за её граф модулей на каждой правке агента
 * значит вернуть ровно ту цену, ради ухода от которой хук и переписан.
 */
async function heavy(): Promise<typeof import("./store.ts")> {
  return import("./store.ts");
}

async function engine(): Promise<typeof import("@myc/code-intel/anchors")> {
  return import("@myc/code-intel/anchors");
}

/** Батч пере-проверки за один прогон (§7.5). Дублировать нельзя — только читать. */
const ANCHOR_CHECK_BATCH_DEFAULT = 256;

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

// ---------------------------------------------------------------------------
// Общее: репозиторий, путь, разбор file:line
// ---------------------------------------------------------------------------

/** Имя журнала грязных файлов внутри `.myc/`. */
export const DIRTY_LOG = "anchor-dirty.log";

/**
 * Репозиторий якоря (S59) и его корень на диске. `repo_root` не
 * реплицируется — он машинозависим (§7.1), поэтому и выводится локально из
 * каталога вызова, а не приезжает из базы.
 */
export function anchorRepo(h: StoreHandle): { repoId: string; repoRoot: string } {
  const repoId = h.repo.repo ?? "";
  return { repoId, repoRoot: repoId.length === 0 ? h.wsDir : join(h.wsDir, repoId) };
}

/** Путь в базе — всегда относительный от корня репозитория и POSIX-слэшами. */
export function repoRelative(repoRoot: string, input: string, cwd: string): string {
  const abs = isAbsolute(input) ? input : resolve(cwd, input);
  const rel = relative(repoRoot, abs);
  return rel.split(sep).join("/");
}

export interface AnchorTarget {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** Строка не названа: `of file` без `:line` — весь файл. */
  readonly whole: boolean;
}

/** `file`, `file:12`, `file:12-40`. Разбор общий у `add` и у `of`. */
export function parseTarget(text: string): AnchorTarget | undefined {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(text.trim());
  if (!m || m[1] === undefined || m[1].length === 0) return undefined;
  if (m[2] === undefined) return { path: m[1], start: 1, end: 1, whole: true };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1 || end < start) return undefined;
  return { path: m[1], start, end, whole: false };
}

function langOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// touch — «пометить и выйти»
// ---------------------------------------------------------------------------

/**
 * Корень воркспейса без открытия базы. `findWorkspaceDb` — подъём с
 * `existsSync` на каждом уровне, ничего тяжелее.
 */
function workspaceRoot(ctx: CommandContext): string | undefined {
  const explicit = ctx.globals.db;
  if (explicit !== undefined) {
    const mycDir = dirname(resolve(explicit));
    return mycDir.split(sep).pop() === ".myc" ? dirname(mycDir) : undefined;
  }
  const found = findWorkspaceDb(ctx.globals.directory ?? process.cwd());
  return "wsDir" in found ? found.wsDir : undefined;
}

export interface TouchData {
  marked: number;
  log: string;
  skipped: string;
  took_ms: number;
}

/**
 * ПОМЕТИТЬ И ВЫЙТИ. Хук post-edit стоит в горячем пути редактирования: он
 * срабатывает на КАЖДУЮ правку агента, то есть сотни раз за сессию, и любая
 * работа внутри него умножается на это число. Вчера по этой причине сняли
 * хук graft — он стоил 2.7 с процессорного времени на правку.
 *
 * Поэтому здесь не открывается база. Замерено на этой машине, 500 вызовов
 * подряд (bench/anchor-touch.ts):
 *
 *   открыть базу + jobs.enqueue + закрыть   p50 1.045  p99 19.511  max 37.219 мс
 *   appendFileSync в журнал                 p50 0.023  p99  0.123  max 12.702 мс
 *
 * p99 первого варианта — 19.5 мс, то есть в четыре раза больше ВСЕГО бюджета
 * записи (И1, 5 мс) и вдесятеро больше бюджета этой задачи (2 мс). Дело не в
 * самой вставке (она 0.03 мс), а в открытии соединения: WAL, схема, PRAGMA —
 * и всё это в процессе, который живёт одну строчку. Плюс запись в базу берёт
 * писательский замок и встаёт в очередь к absorb'у и эмбеддеру, которые
 * работают ровно в тот же момент.
 *
 * ВТОРОЙ ОЧЕРЕДИ ЭТО НЕ ЗАВОДИТ. Журнал — не очередь работ, а БУФЕР ГРЯЗНЫХ
 * ПОМЕТОК: у него единственный потребитель (`anchor check`), он не хранит
 * состояния, не знает ни аренды, ни приоритетов, и его содержимое — это
 * подсказка «посмотри сюда раньше», а не источник истины. Источник истины —
 * `anchors.checked_at`: потеряв журнал целиком, система теряет очерёдность и
 * ничего больше, потому что `check` и без него обходит якоря по `checked_at`.
 *
 * Дозапись в конец файла атомарна на уровне ядра (O_APPEND), поэтому
 * параллельные хуки не рвут строки друг друга и никакой блокировки не нужно.
 */
function buildAnchorTouch(): Command {
  return {
    name: "touch",
    summary: "mark files dirty for the anchor checker (post-edit hook)",
    help:
      "Fire-and-forget: appends one line per file to .myc/" +
      DIRTY_LOG +
      " and exits. Opens no database, computes no hashes, re-binds nothing — " +
      "everything expensive is left to `myc anchor check`.",
    handler: (ctx) => {
      const t0 = performance.now();
      const paths = ctx.args.filter((a) => a.trim().length > 0);
      const done = (marked: number, log: string, skipped: string): TouchData => ({
        marked,
        log,
        skipped,
        took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
      });
      if (paths.length === 0) {
        return { ok: true, data: done(0, "", "путь не назван") };
      }
      const wsDir = workspaceRoot(ctx);
      if (wsDir === undefined) {
        // Не отказ: хук обязан быть безвредным вне воркспейса (§6.4).
        return { ok: true, data: done(0, "", "воркспейс не найден") };
      }
      const log = join(wsDir, ".myc", DIRTY_LOG);
      const cwd = ctx.globals.directory ?? process.cwd();
      let line = "";
      for (const p of paths) {
        line += `${resolve(cwd, p)}\n`;
      }
      try {
        appendFileSync(log, line);
      } catch {
        return { ok: true, data: done(0, log, "журнал недоступен") };
      }
      return { ok: true, data: done(paths.length, log, "") };
    },
    renderHuman: (raw) => {
      const d = raw as TouchData;
      if (d.marked === 0) return `помечено 0 (${d.skipped}) · ${d.took_ms} мс\n`;
      return `помечено ${d.marked} · ${d.took_ms} мс\n`;
    },
  };
}

/**
 * Снять журнал целиком: переименовать (атомарно), прочитать, удалить. Хуки,
 * дозаписавшие в тот же момент, попадут либо в снятый файл, либо в новый —
 * потерять строку нельзя, а перепроверить якорь дважды не вредно.
 */
export function drainDirtyLog(wsDir: string): string[] {
  const log = join(wsDir, ".myc", DIRTY_LOG);
  if (!existsSync(log)) return [];
  const taken = `${log}.${process.pid}.taken`;
  try {
    renameSync(log, taken);
  } catch {
    return [];
  }
  let text = "";
  try {
    text = readFileSync(taken, "utf8");
  } catch {
    /* журнал пропал между rename и чтением — считаем пустым */
  }
  rmSync(taken, { force: true });
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const p = raw.trim();
    if (p.length > 0) out.add(p);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Строка якоря
// ---------------------------------------------------------------------------

interface AnchorRow {
  node_id: string;
  repo_id: string;
  repo_root: string;
  path: string;
  lang: string;
  symbol: string;
  span_start: number;
  span_end: number;
  file_hash: string;
  span_hash: string;
  crux: string;
  crux_norm: string;
  state: string;
  drift: number;
  mtime_ms: number;
  size_bytes: number;
  bound_at: number;
  checked_at: number;
  git_ref: string;
}

function toAnchorLike(r: AnchorRow): import("@myc/code-intel/anchors").AnchorLike {
  return {
    path: r.path,
    lang: r.lang,
    spanStart: r.span_start,
    spanEnd: r.span_end,
    fileHash: r.file_hash,
    spanHash: r.span_hash,
    cruxNorm: r.crux_norm,
    mtimeMs: r.mtime_ms,
    sizeBytes: r.size_bytes,
  };
}

function spanLabel(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

const ADD_FLAGS: readonly FlagSpec[] = [
  { name: "symbol", value: "string", description: "symbol name recorded with the anchor" },
  { name: "as", value: "string", description: "actor for the record (default $MYC_ACTOR/$USER)" },
];

export interface AddData {
  anchor_id: string;
  node_id: string;
  repo: string;
  path: string;
  start: number;
  end: number;
  symbol: string;
  state: AnchorState;
  crux_lines: number;
  file_hash: string;
  took_ms: number;
}

function buildAnchorAdd(deps: StoreDeps | undefined): Command {
  return {
    name: "add",
    summary: "bind a node to code: anchor add <id> <file>[:<a>-<b>]",
    flags: ADD_FLAGS,
    help:
      "Creates an anchor node (kind=anchor), the anchors row with its span, file hash and " +
      "normalized crux, and a `touches` edge from <id> to it. The crux is what survives a " +
      "refactor: line numbers are re-derived from it, not trusted.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      const targetInput = ctx.args[1];
      if (idInput === undefined || targetInput === undefined) {
        return failure(
          "usage.invalid",
          "нужно: myc anchor add <id> <file>[:<a>-<b>]",
          ExitCode.USAGE,
        );
      }
      const target = parseTarget(targetInput);
      if (target === undefined) {
        return failure(
          "usage.invalid",
          `неверный якорь '${targetInput}'; формат file[:<a>-<b>]`,
          ExitCode.USAGE,
        );
      }

      const S = await heavy();
      const opened = await (deps ?? S.realStoreDeps).openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = S.resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;

        const { repoId, repoRoot } = anchorRepo(h);
        const cwd = ctx.globals.directory ?? process.cwd();
        const path = repoRelative(repoRoot, target.path, cwd);
        const abs = join(repoRoot, path);
        if (!existsSync(abs)) {
          return failure(
            "notfound.file",
            `файла нет: ${path} (корень репозитория ${repoRoot})`,
            ExitCode.NOTFOUND,
          );
        }

        const source = readFileSync(abs, "utf8");
        const lang = langOf(path);
        const lines = source.split("\n").length;
        const end = target.whole ? lines : target.end;
        const b = (await engine()).bindAnchor(source, lang, target.start, end, statSync(abs));

        const now = Date.now();
        const symbol = S.flagStr(ctx, "symbol") ?? "";
        let anchorId: string;
        try {
          const anchorNode = h.store.createNode({
            kind: "anchor",
            scope: h.scope,
            status: "fresh",
            title: `${path}:${spanLabel(b.spanStart, b.spanEnd)}`,
            body: b.crux.length > 0 ? b.crux : null,
            actor: S.flagStr(ctx, "as") ?? h.actor,
          });
          anchorId = anchorNode.id;
          h.driver.database
            .query(
              `INSERT INTO anchors (node_id, repo_id, repo_root, path, lang, symbol,
                                    span_start, span_end, file_hash, span_hash, crux, crux_norm,
                                    state, drift, mtime_ms, size_bytes, bound_at, checked_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'fresh',1.0,?13,?14,?15,?15)`,
            )
            .run(
              anchorId,
              repoId,
              repoRoot,
              path,
              lang,
              symbol,
              b.spanStart,
              b.spanEnd,
              b.fileHash,
              b.spanHash,
              b.crux,
              b.cruxNorm,
              b.mtimeMs,
              b.sizeBytes,
              now,
            );
          h.store.addEdge(node.id, "touches", anchorId);
        } catch (e) {
          return S.graphFailure(e);
        }

        const data: AddData = {
          anchor_id: anchorId,
          node_id: node.id,
          repo: repoId,
          path,
          start: b.spanStart,
          end: b.spanEnd,
          symbol,
          state: "fresh",
          crux_lines: b.crux.length === 0 ? 0 : b.crux.split("\n").length,
          file_hash: b.fileHash,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as AddData;
      const sym = d.symbol.length > 0 ? ` (${d.symbol})` : "";
      return (
        `${d.anchor_id} anchor fresh · ${d.path}:${spanLabel(d.start, d.end)}${sym}\n` +
        `touches   ${d.node_id}\n` +
        `crux      ${d.crux_lines} строк · ${d.file_hash}\n` +
        `${d.took_ms} мс\n`
      );
    },
  };
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

export interface RmData {
  removed: string[];
  node_id: string;
  took_ms: number;
}

function buildAnchorRm(deps: StoreDeps | undefined): Command {
  return {
    name: "rm",
    summary: "unbind: anchor rm <id> [<file>[:<a>-<b>]]",
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return failure("usage.invalid", "нужно: myc anchor rm <id> [<file>]", ExitCode.USAGE);
      }
      const target = ctx.args[1] === undefined ? undefined : parseTarget(ctx.args[1]);
      if (ctx.args[1] !== undefined && target === undefined) {
        return failure("usage.invalid", `неверный якорь '${ctx.args[1]}'`, ExitCode.USAGE);
      }

      const S = await heavy();
      const opened = await (deps ?? S.realStoreDeps).openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = S.resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;
        const { repoRoot } = anchorRepo(h);
        const cwd = ctx.globals.directory ?? process.cwd();
        const wantPath = target === undefined ? undefined : repoRelative(repoRoot, target.path, cwd);

        const db = h.driver.database;
        const rows = db
          .query(
            `SELECT a.node_id AS node_id, a.path AS path, a.span_start AS s, a.span_end AS e
               FROM edges g JOIN anchors a ON a.node_id = g.dst
              WHERE g.src = ?1 AND g.type = 'touches' AND g.deleted_at IS NULL`,
          )
          .all(node.id) as Array<{ node_id: string; path: string; s: number; e: number }>;

        const removed: string[] = [];
        for (const r of rows) {
          if (wantPath !== undefined && r.path !== wantPath) continue;
          if (target !== undefined && !target.whole && (r.s !== target.start || r.e !== target.end)) {
            continue;
          }
          h.store.removeEdge(node.id, "touches", r.node_id);
          h.store.deleteNode(r.node_id);
          db.query("DELETE FROM anchors WHERE node_id = ?1").run(r.node_id);
          removed.push(`${r.path}:${spanLabel(r.s, r.e)}`);
        }
        if (removed.length === 0) {
          return failure("notfound.anchor", `у ${node.id} нет такого якоря`, ExitCode.NOTFOUND);
        }
        const data: RmData = {
          removed,
          node_id: node.id,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } catch (e) {
        return S.graphFailure(e);
      } finally {
        h.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as RmData;
      return `отвязано ${d.removed.length}: ${d.removed.join(", ")} · ${d.took_ms} мс\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// of — обратный ход код → узлы
// ---------------------------------------------------------------------------

/**
 * ЗАПРОС ПО ПОЗИЦИИ (§7.5, приёмка задачи: 50k якорей, < 1 мс). Индекс
 * `ix_anchors_file(repo_id, path, span_start)` покрывает первые две колонки
 * равенством, а третью — диапазоном `span_start <= line`; `span_end >= line`
 * остаётся фильтром по уже суженному набору. Ключевое здесь то, что путь
 * стоит В ИНДЕКСЕ: без него запрос стал бы полным сканом таблицы, и 50k
 * якорей превратились бы в 50k прочитанных строк на каждый `file:line`.
 */
export const SQL_OF_LINE = `
SELECT a.node_id AS node_id, a.path AS path, a.span_start AS s, a.span_end AS e,
       a.state AS state, a.drift AS drift, a.symbol AS symbol
  FROM anchors a
 WHERE a.repo_id = ?1 AND a.path = ?2 AND a.span_start <= ?3 AND a.span_end >= ?3
 ORDER BY (a.span_end - a.span_start), a.span_start`;

export const SQL_OF_FILE = `
SELECT a.node_id AS node_id, a.path AS path, a.span_start AS s, a.span_end AS e,
       a.state AS state, a.drift AS drift, a.symbol AS symbol
  FROM anchors a
 WHERE a.repo_id = ?1 AND a.path = ?2
 ORDER BY a.span_start, a.span_end`;

const SQL_OF_OWNERS = `
SELECT g.src AS id, n.kind AS kind, n.title AS title, n.status AS status, n.priority AS priority,
       json_extract(n.attrs,'$.type') AS type
  FROM edges g JOIN nodes n ON n.id = g.src
 WHERE g.dst = ?1 AND g.type = 'touches' AND g.deleted_at IS NULL AND n.deleted_at IS NULL
 ORDER BY n.priority, n.id`;

interface OwnerRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  priority: number;
  type: string | null;
}

export interface OfSpan {
  anchor_id: string;
  path: string;
  start: number;
  end: number;
  state: string;
  drift: number;
  symbol: string;
  nodes: OwnerRow[];
}

export interface OfData {
  repo: string;
  path: string;
  line: number | null;
  spans: OfSpan[];
  nodes: number;
  /** Чистое время индексного запроса, без сборки владельцев (приёмка < 1 мс). */
  query_ms: number;
  took_ms: number;
}

export function queryAnchorsAt(
  db: Database,
  repoId: string,
  path: string,
  line: number | null,
): Array<{ node_id: string; path: string; s: number; e: number; state: string; drift: number; symbol: string }> {
  return (
    line === null
      ? db.query(SQL_OF_FILE).all(repoId, path)
      : db.query(SQL_OF_LINE).all(repoId, path, line)
  ) as Array<{
    node_id: string;
    path: string;
    s: number;
    e: number;
    state: string;
    drift: number;
    symbol: string;
  }>;
}

function buildAnchorOf(deps: StoreDeps | undefined): Command {
  return {
    name: "of",
    summary: "which nodes are bound here: anchor of <file>[:<line>]",
    help:
      "The code → knowledge direction. Without :<line> it lists every anchor of the file; " +
      "with a line, only spans covering it, innermost first.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const input = ctx.args[0];
      if (input === undefined) {
        return failure("usage.invalid", "нужно: myc anchor of <file>[:<line>]", ExitCode.USAGE);
      }
      const target = parseTarget(input);
      if (target === undefined) {
        return failure("usage.invalid", `неверная позиция '${input}'`, ExitCode.USAGE);
      }

      const S = await heavy();
      const opened = await (deps ?? S.realStoreDeps).openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const { repoId, repoRoot } = anchorRepo(h);
        const cwd = ctx.globals.directory ?? process.cwd();
        const path = repoRelative(repoRoot, target.path, cwd);
        const line = target.whole ? null : target.start;

        const db = h.driver.database;
        const q0 = performance.now();
        const rows = queryAnchorsAt(db, repoId, path, line);
        const queryMs = performance.now() - q0;

        const owners = db.query(SQL_OF_OWNERS);
        let nodes = 0;
        const spans: OfSpan[] = rows.map((r) => {
          const list = owners.all(r.node_id) as OwnerRow[];
          nodes += list.length;
          return {
            anchor_id: r.node_id,
            path: r.path,
            start: r.s,
            end: r.e,
            state: r.state,
            drift: r.drift,
            symbol: r.symbol,
            nodes: list,
          };
        });

        const data: OfData = {
          repo: repoId,
          path,
          line,
          spans,
          nodes,
          query_ms: Math.round(queryMs * 1000) / 1000,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return { ok: true, data, meta: { took_ms: data.took_ms, query_ms: data.query_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as OfData;
      if (d.spans.length === 0) {
        const where = d.line === null ? d.path : `${d.path}:${d.line}`;
        return `якорей нет: ${where} · запрос ${d.query_ms} мс\n`;
      }
      const lines: string[] = [];
      for (const s of d.spans) {
        const st = s.state === "fresh" ? "" : ` [${s.state}]`;
        const sym = s.symbol.length > 0 ? ` (${s.symbol})` : "";
        lines.push(`${s.path}:${spanLabel(s.start, s.end)}${sym}${st}`);
        for (const n of s.nodes) {
          const kind = n.type ?? n.kind;
          lines.push(`  ${n.id}  ${kind} ${n.status}  ${n.title}`);
        }
        if (s.nodes.length === 0) lines.push("  (нет входящих узлов)");
      }
      lines.push(`${d.nodes} узл(ов) · запрос ${d.query_ms} мс · ${d.took_ms} мс`);
      return `${lines.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// check — лестница §7.2
// ---------------------------------------------------------------------------

const CHECK_FLAGS: readonly FlagSpec[] = [
  { name: "path", value: "string", description: "only anchors whose path starts with this prefix" },
  { name: "limit", value: "number", description: `batch size (default ${ANCHOR_CHECK_BATCH_DEFAULT})` },
  { name: "dry-run", description: "report only: do not write states back" },
  {
    name: "level",
    value: "number",
    description: "МУТАЦИЯ приёмки: highest freshness level allowed (1|2|3, default 3)",
  },
];

export interface CheckLine {
  anchor_id: string;
  path: string;
  from: string;
  to: string;
  state: AnchorState;
  was: string;
  level: number;
  moved: boolean;
  reason: string;
}

export interface CheckData {
  checked: number;
  fresh: number;
  drifted: number;
  stale: number;
  lost: number;
  moved: number;
  /** Сколько якорей взято из журнала грязных файлов (хук post-edit). */
  from_dirty: number;
  /** На каком уровне лестницы остановилась проверка — цена в одной строке. */
  by_level: Record<string, number>;
  changed: CheckLine[];
  dry_run: boolean;
  took_ms: number;
}

function applyCheck(
  db: Database,
  h: StoreHandle,
  row: AnchorRow,
  r: AnchorCheck,
  now: number,
): void {
  db.query(
    `UPDATE anchors
        SET span_start = ?2, span_end = ?3, file_hash = ?4, span_hash = ?5,
            crux = CASE WHEN ?6 = '' THEN crux ELSE ?6 END,
            crux_norm = CASE WHEN ?6 = '' THEN crux_norm ELSE ?7 END,
            state = ?8, drift = ?9, mtime_ms = ?10, size_bytes = ?11, checked_at = ?12
      WHERE node_id = ?1`,
  ).run(
    row.node_id,
    r.spanStart,
    r.spanEnd,
    r.fileHash,
    r.spanHash,
    r.crux,
    r.cruxNorm,
    r.state,
    r.drift,
    r.mtimeMs,
    r.sizeBytes,
    now,
  );
  if (r.state !== row.state) {
    try {
      h.store.updateNode(row.node_id, { status: r.state });
    } catch {
      // Узел якоря мог быть удалён вручную: строка обновлена, статус — нет.
    }
  }
}

function buildAnchorCheck(deps: StoreDeps | undefined): Command {
  return {
    name: "check",
    summary: "three-level staleness check over a batch of anchors",
    flags: CHECK_FLAGS,
    help:
      "Level 1 is (mtime, size) — one stat, the file is not read. Level 2 is the content hash: " +
      "a touch that changed nothing stops here. Level 3 compares the normalized span and, if it " +
      "moved, finds it by its crux text and re-points the anchor. Files marked by the post-edit " +
      "hook are checked first.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const S = await heavy();
      const { checkAnchor } = await engine();
      const opened = await (deps ?? S.realStoreDeps).openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const db = h.driver.database;
        const { repoId, repoRoot } = anchorRepo(h);
        const limit = S.flagNum(ctx, "limit") ?? ANCHOR_CHECK_BATCH_DEFAULT;
        const dryRun = ctx.flags["dry-run"] === true;
        const levelRaw = S.flagNum(ctx, "level");
        const maxLevel = (levelRaw === 1 || levelRaw === 2 ? levelRaw : 3) as MaxLevel;
        const prefix = S.flagStr(ctx, "path");

        // Журнал грязных файлов — подсказка «сюда раньше», не источник истины.
        const dirty = drainDirtyLog(h.wsDir).map((abs) => repoRelative(repoRoot, abs, repoRoot));
        const dirtySet = new Set(dirty);

        const all = db
          .query(
            `SELECT * FROM anchors
              WHERE repo_id = ?1 AND state <> 'lost'
              ORDER BY checked_at ASC, node_id ASC`,
          )
          .all(repoId) as AnchorRow[];

        const wanted = all.filter(
          (r) => prefix === undefined || r.path.startsWith(prefix),
        );
        // Грязные вперёд, остальные по checked_at — порядок §7.5.
        wanted.sort((a, b) => Number(dirtySet.has(b.path)) - Number(dirtySet.has(a.path)));
        const batch = wanted.slice(0, limit);

        const now = Date.now();
        const data: CheckData = {
          checked: 0,
          fresh: 0,
          drifted: 0,
          stale: 0,
          lost: 0,
          moved: 0,
          from_dirty: batch.filter((r) => dirtySet.has(r.path)).length,
          by_level: { "0": 0, "1": 0, "2": 0, "3": 0 },
          changed: [],
          dry_run: dryRun,
          took_ms: 0,
        };

        for (const row of batch) {
          const root = row.repo_root.length > 0 ? row.repo_root : repoRoot;
          const r = checkAnchor(toAnchorLike(row), join(root, row.path), undefined, maxLevel);
          data.checked++;
          data[r.state]++;
          data.by_level[String(r.level)] = (data.by_level[String(r.level)] ?? 0) + 1;
          if (r.moved) data.moved++;
          if (r.state !== row.state || r.moved) {
            data.changed.push({
              anchor_id: row.node_id,
              path: row.path,
              from: spanLabel(row.span_start, row.span_end),
              to: spanLabel(r.spanStart, r.spanEnd),
              state: r.state,
              was: row.state,
              level: r.level,
              moved: r.moved,
              reason: r.reason,
            });
          }
          if (!dryRun) applyCheck(db, h, row, r, now);
        }

        if (data.stale > 0 || data.lost > 0) {
          ctx.warn(
            "anchor.stale",
            `${data.stale + data.lost} якорей протухло — привязка больше не указывает на живой код`,
          );
        }

        data.took_ms = Math.round((performance.now() - t0) * 10) / 10;
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as CheckData;
      const lines: string[] = [];
      const dry = d.dry_run ? " · dry-run" : "";
      lines.push(
        `${d.checked} якорей · fresh ${d.fresh} · drifted ${d.drifted} · stale ${d.stale} · lost ${d.lost}${dry}`,
      );
      lines.push(
        `уровни: 1 ${d.by_level["1"] ?? 0} · 2 ${d.by_level["2"] ?? 0} · 3 ${d.by_level["3"] ?? 0} · нет файла ${d.by_level["0"] ?? 0} · из журнала ${d.from_dirty}`,
      );
      for (const c of d.changed) {
        const span = c.from === c.to ? c.from : `${c.from} → ${c.to}`;
        lines.push(`${c.anchor_id}  ${c.path}:${span}  ${c.was}→${c.state}  ${c.reason}`);
      }
      lines.push(`${d.took_ms} мс`);
      return `${lines.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export function createAnchorCommand(deps?: StoreDeps): Command {
  return {
    name: "anchor",
    summary: "code anchors: add, rm, of, check, touch",
    subcommands: [
      buildAnchorAdd(deps),
      buildAnchorRm(deps),
      buildAnchorOf(deps),
      buildAnchorCheck(deps),
      buildAnchorTouch(),
    ],
  };
}
