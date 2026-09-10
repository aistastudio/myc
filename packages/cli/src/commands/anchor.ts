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
import type {
  AnchorBinding,
  AnchorCheck,
  AnchorState,
  MaxLevel,
  StatLike,
} from "@myc/code-intel/anchors";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import { findWorkspaceDb, mapIntoMain, mapIntoWorktree, type WorktreeLink } from "./wsfind.ts";
import { markHookCall } from "../hooks/counters.ts";
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
export const ANCHOR_CHECK_BATCH_DEFAULT = 256;

/**
 * Дебаунс §7.5: файл, изменённый меньше двух секунд назад, фон НЕ трогает.
 * Причина не в экономии — в правдивости. Агент правит файл посимвольно, и
 * якорь, проверенный в середине правки, честно объявляется `stale` по
 * недописанному тексту; следующий прогон вернёт `fresh`, а между ними
 * `ready` понизит задачу и покажет плашку «требует проверки» на ровном
 * месте. Ручной `myc anchor check` дебаунса НЕ ЗНАЕТ: пользователь спросил
 * про СЕЙЧАС, и ответ про «две секунды назад» ему не нужен.
 */
export const ANCHOR_DEBOUNCE_MS = 2_000;

/**
 * ПОРОГ, ВЫШЕ КОТОРОГО ЗАПИСЬ НЕ НОРМАЛИЗУЕТ ФАЙЛ, А ОТКЛАДЫВАЕТ ЭТО В ФОН
 * (решение S66). Цена привязки линейна по размеру файла и почти вся сидит в
 * `normalizeStream`. Замер @myc/bench на этой машине (3 прогона по 60
 * итераций, синтетический ts, p50):
 *
 *   файл       bindAnchor   из него normalizeStream   hashText   split
 *   8.5 КБ     0.151 мс     0.112 мс                  0.001 мс   0.002 мс
 *   42.8 КБ    0.561 мс     0.560 мс                  0.005 мс   0.015 мс
 *   172.8 КБ   2.448 мс     2.357 мс                  0.021 мс   0.052 мс
 *
 * То есть ~14 мкс на килобайт, и 96 % из них — нормализация; хеш файла и
 * разбиение на строки не стоят ничего и потому НЕ откладываются. Бюджет
 * записи (И1) — 5 мс на всю команду, из которых сама запись узла занимает
 * ~1.2 мс; 32 КБ выбраны по правилу «нормализация съедает не больше 10 %
 * бюджета» (0.45 мс). Корпус этого репозитория: 364 исходника, медиана
 * 10.6 КБ, p90 29.9 КБ, порог переходят 32 файла (8.8 %). Типичный якорь
 * платит полную цену и получает точный crux сразу; редкий большой файл не
 * заставляет запись платить вдвое.
 */
export const ANCHOR_INLINE_MAX_BYTES = 32 * 1024;

/**
 * Порог с правом переопределения из окружения. Существует ради МУТАЦИЙ
 * приёмки, а не ради режимов работы: `off` — «порога нет», то есть в точности
 * поведение до S66, когда запись нормализовала файл любого размера.
 *
 * Читается ПРОЦЕССНОЕ окружение, а не `env` вызова, и по той же причине, что
 * `NODE_ENV` в drain.ts: до `bindAnchorAt` доходят три входа
 * (`anchor add`, `remember --anchor`, `task --anchor`), и два из них зовут
 * `attachAnchorFlag`, у которой окружения нет и добавлять его ради
 * переменной-мутации значило бы тащить его через две чужие команды. В боевом
 * CLI это одно и то же окружение; расходится оно только в тестовом харнессе,
 * который передаёт вызову белый список.
 */
export function anchorInlineMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYC_ANCHOR_INLINE_MAX_BYTES;
  if (raw === undefined) return ANCHOR_INLINE_MAX_BYTES;
  if (raw.trim() === "off") return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : ANCHOR_INLINE_MAX_BYTES;
}

/** Размер файла для человеческой строки — одинаковый у всех трёх входов. */
function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} КБ`;
}


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

/**
 * Две стороны одного файла в git worktree.
 *
 * Якорь — это ПУТЬ В РЕПОЗИТОРИИ плюс СОДЕРЖИМОЕ по нему. В worktree они
 * расходятся: путь обязан быть тем же, что и из основного дерева (иначе в
 * общий граф лягут якоря вида `../wt-feature/src/x.ts`, не совпадающие ни с
 * одним настоящим), а читать надо файл, который агент правит прямо сейчас, —
 * он лежит в worktree и на другой ветке отличается по содержимому.
 *
 * Отсюда две функции: `mainCwd` для вычисления пути, `localFile` для чтения.
 * Вне worktree обе — тождество, ни одного лишнего вызова.
 */
export function mainCwdOf(h: StoreHandle, cwd: string): string {
  return h.worktree === undefined ? cwd : mapIntoMain(h.worktree, resolve(cwd));
}

function mainCwd(h: StoreHandle, ctx: CommandContext): string {
  return mainCwdOf(h, ctx.globals.directory ?? process.cwd());
}

function localFile(h: StoreHandle, absInMain: string): string {
  if (h.worktree === undefined) return absInMain;
  // Копия из worktree сильнее — это то, что агент правит. Но если её нет
  // (файл не приехал на эту ветку), берётся копия основного дерева, а не
  // выдаётся «файла нет»: путь-то в репозитории существует.
  const local = mapIntoWorktree(h.worktree, absInMain);
  return existsSync(local) ? local : absInMain;
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
function workspaceRoot(
  ctx: CommandContext,
): { wsDir: string; worktree: WorktreeLink | undefined } | undefined {
  const explicit = ctx.globals.db;
  if (explicit !== undefined) {
    const mycDir = dirname(resolve(explicit));
    if (mycDir.split(sep).pop() !== ".myc") return undefined;
    return { wsDir: dirname(mycDir), worktree: undefined };
  }
  const found = findWorkspaceDb(ctx.globals.directory ?? process.cwd());
  return "wsDir" in found ? { wsDir: found.wsDir, worktree: found.worktree } : undefined;
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
      const ws = workspaceRoot(ctx);
      if (ws === undefined) {
        // Не отказ: хук обязан быть безвредным вне воркспейса (§6.4).
        return { ok: true, data: done(0, "", "воркспейс не найден") };
      }
      const mycDir = join(ws.wsDir, ".myc");
      const log = join(mycDir, DIRTY_LOG);
      const cwd = ctx.globals.directory ?? process.cwd();
      let line = "";
      for (const p of paths) {
        // Путь ПЕРЕСЧИТАН в основное дерево: журнал лежит там, и `anchor
        // check` считает от его корня. Абсолютный путь worktree он молча
        // отбросил бы — пометка пропала бы, а хук отчитался бы об успехе.
        const abs = resolve(cwd, p);
        line += `${ws.worktree === undefined ? abs : mapIntoMain(ws.worktree, abs)}\n`;
      }
      // Отметка срабатывания — ТОЛЬКО для вызова из хука (см. markHookCall):
      // `myc anchor touch` руками отметку не создаёт, иначе она означала бы не
      // то, что на ней написано. База здесь по-прежнему не открывается, и это
      // главное. Замер на этой машине (2000 вызовов подряд):
      //
      //   appendFileSync в журнал (как было)   p50 0.017  p99 0.029 мс
      //   + markHookCall (отметка хука)        p50 0.141  p99 0.191 мс
      //   markHookCall без объявления (руками) p50 0.000  p99 0.001 мс
      //
      // То есть отметка стоит 0.16 мс поверх 0.02 мс при бюджете 2 мс, а
      // человеку, набравшему команду руками, не стоит ничего: без объявления
      // вызывающего функция выходит до всякого чтения файла.
      try {
        appendFileSync(log, line);
      } catch {
        markHookCall(mycDir, "post-edit", performance.now() - t0, "log-unwritable");
        return { ok: true, data: done(0, log, "журнал недоступен") };
      }
      markHookCall(mycDir, "post-edit", performance.now() - t0, "ok");
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
  /** Файл больше порога S66: crux снимет фон, а не эта команда. */
  deferred: boolean;
  size_bytes: number;
  took_ms: number;
}

// ---------------------------------------------------------------------------
// Привязка — ЕДИНСТВЕННЫЙ путь, которым якорь появляется в базе
// ---------------------------------------------------------------------------

/**
 * ОДНА ФУНКЦИЯ НА ВСЕ ВХОДЫ, И ЭТО ГЛАВНОЕ ЗДЕСЬ. Якорь ставили тремя
 * способами, и совпадал из них один: `myc anchor add` заводил узел, строку и
 * ребро, а `myc remember --anchor` и `myc task --anchor` писали в `attrs`
 * запись `state:'pending'` и печатали «якорь отложен». Отложен он был
 * навсегда: разобрать `attrs.anchors` не умеет ничто, `anchor of` такого
 * якоря не находит, лестница §7.2 его не проверяет, а `ready` (ANCHOR_SUBQ
 * идёт по рёбрам `touches` к узлам `kind='anchor'`) не видит вовсе.
 *
 * Поэтому «отложенного» пути больше нет: `--anchor` зовёт ЭТУ функцию, и
 * мутация в ней обязана ломать все три входа сразу. Расхождение трёх копий
 * одного правила — тот же класс дефекта, что S43 (PRAGMA в трёх местах) и
 * S64 (комментарий в двух видах), и лечится он так же — сведением в одну.
 *
 * Цена — чтение файла и нормализация спана: это уровень 3 лестницы, ~14 мкс
 * на килобайт файла. Она платится ТОЛЬКО когда назван `--anchor`, и ровно её
 * раньше «откладывали», не получая взамен ничего.
 *
 * НО НЕ ЛЮБОЙ ЦЕНОЙ (S66). На файле в 173 КБ нормализация стоит 2.4 мс при
 * бюджете записи 5 мс — то есть редкий большой файл молча пробивал бюджет,
 * ничего об этом не говоря. Выше `ANCHOR_INLINE_MAX_BYTES` нормализация
 * уходит в фон: строка якоря пишется сразу и честно (спан, хеш файла, mtime,
 * размер), `span_hash` остаётся пустым как метка недовязанности,
 * `checked_at = 0` ставит якорь первым в очередь §7.5, а вывод команды
 * ГОВОРИТ ВСЛУХ, что crux снимет фон. Точность догоняет, бюджет цел.
 */
export interface BoundAnchor {
  readonly anchorId: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly state: AnchorState;
  readonly cruxLines: number;
  readonly fileHash: string;
  /** Файл больше порога: crux снимет фон (§7.5), а не запись — S66. */
  readonly deferred: boolean;
  /** Размер файла — то самое число, по которому принято решение. */
  readonly sizeBytes: number;
}

export type BindResult =
  | { readonly ok: true; readonly anchor: BoundAnchor }
  | {
      readonly ok: false;
      readonly code: "notfound.file" | "outside.repo" | "store.error";
      readonly msg: string;
      readonly cause?: unknown;
    };

const SQL_ANCHOR_INSERT = `INSERT INTO anchors (node_id, repo_id, repo_root, path, lang, symbol,
                      span_start, span_end, file_hash, span_hash, crux, crux_norm,
                      state, drift, mtime_ms, size_bytes, bound_at, checked_at)
 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'fresh',1.0,?13,?14,?15,?16)`;

/**
 * ПРИВЯЗКА БЕЗ НОРМАЛИЗАЦИИ — та же строка якоря, минус crux (S66).
 * Записывается всё, что известно точно и даром: спан, приведённый к границам
 * файла, хеш содержимого, mtime и размер. Отложена ровно нормализация, то
 * есть 96 % цены.
 *
 * `span_hash` остаётся ПУСТЫМ, и это не недосмотр, а МЕТКА. Настоящая
 * привязка кладёт туда `wy:…` ВСЕГДА — даже у пустого спана, потому что
 * `hashText('')` возвращает непустую строку, — поэтому пустой `span_hash` не
 * может появиться никаким другим путём: ни привязкой, ни проверкой, ни
 * ввозом чужой строки. По нему фон отличает «привязку не довели» от «якорь
 * пора проверить» (`isDeferredBind`), и второй метки для этого не нужно.
 */
function deferredBinding(
  hashText: (text: string) => string,
  source: string,
  lineCount: number,
  spanStart: number,
  spanEnd: number,
  st: StatLike,
): AnchorBinding {
  const start = Math.max(1, Math.min(spanStart, lineCount));
  const end = Math.max(start, Math.min(spanEnd, lineCount));
  return {
    spanStart: start,
    spanEnd: end,
    fileHash: hashText(source),
    spanHash: "",
    crux: "",
    cruxNorm: "",
    mtimeMs: Math.floor(st.mtimeMs),
    sizeBytes: st.size,
  };
}

export async function bindAnchorAt(
  h: StoreHandle,
  nodeId: string,
  target: AnchorTarget,
  cwd: string,
  opts: {
    readonly symbol?: string;
    readonly actor?: string;
    readonly now?: number;
    /** Порог S66; по умолчанию — `anchorInlineMaxBytes()`. */
    readonly inlineMaxBytes?: number;
  } = {},
): Promise<BindResult> {
  const { repoId, repoRoot } = anchorRepo(h);
  const path = repoRelative(repoRoot, target.path, mainCwdOf(h, cwd));
  // ПУТЬ ОБЯЗАН ЛЕЖАТЬ В КОРНЕ. Иначе в `anchors` уезжает строка вида
  // `../demo/src/fuse.ts` — она резолвится только на этой машине и только из
  // этого каталога, а `anchor of` по ней не найдётся никогда (запрос идёт по
  // паре repo_id+path). Ловится это в первую очередь личным ярусом: `myc
  // remember --global --anchor` открывает воркспейс ~/.myc, у которого код
  // репозитория не лежит нигде.
  if (path.startsWith("../")) {
    return {
      ok: false,
      code: "outside.repo",
      msg: `файл вне корня ${repoRoot}: ${path} — якорь такому пути привязать нельзя`,
    };
  }
  const abs = localFile(h, join(repoRoot, path));
  // Один stat вместо existsSync + statSync: строке якоря он нужен всё равно,
  // а его `size` — то единственное, что требуется знать ДО чтения файла.
  let st: StatLike;
  try {
    st = statSync(abs);
  } catch {
    return {
      ok: false,
      code: "notfound.file",
      msg: `файла нет: ${path} (корень репозитория ${repoRoot})`,
    };
  }

  const deferred = st.size > (opts.inlineMaxBytes ?? anchorInlineMaxBytes());
  const source = readFileSync(abs, "utf8");
  const lang = langOf(path);
  const lines = source.split("\n").length;
  const end = target.whole ? lines : target.end;
  const E = await engine();
  const b = deferred
    ? deferredBinding(E.hashText, source, lines, target.start, end, st)
    : E.bindAnchor(source, lang, target.start, end, st);

  const now = opts.now ?? Date.now();
  const symbol = opts.symbol ?? "";
  try {
    const anchorNode = h.store.createNode({
      kind: "anchor",
      scope: h.scope,
      status: "fresh",
      title: `${path}:${spanLabel(b.spanStart, b.spanEnd)}`,
      body: b.crux.length > 0 ? b.crux : null,
      actor: opts.actor ?? h.actor,
    });
    h.driver.database
      .query(SQL_ANCHOR_INSERT)
      .run(
        anchorNode.id,
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
        // `checked_at = 0` у отложенной привязки — не украшение: порядок
        // §7.5 идёт по `checked_at ASC`, и недовязанный якорь встаёт первым
        // в очередь фона сам, без отдельного признака приоритета.
        deferred ? 0 : now,
      );
    h.store.addEdge(nodeId, "touches", anchorNode.id);
    if (deferred) {
      // Работа в очереди — чтобы фон случился на СЛЕДУЮЩЕЙ команде, а не
      // через период §7.5 (300 с). Потеря очереди привязку не теряет:
      // `checked_at = 0` доведёт её периодом, просто позже.
      //
      // `run_after` СДВИНУТ НА ДЕБАУНС ФАЙЛА, и это не осторожность, а
      // наблюдение живьём: якорь обычно ставят на файл, который агент правит
      // прямо сейчас, а фон такой файл не трогает (§7.5, дебаунс 2 с). Работа
      // при этом СНИМАЛАСЬ БЫ ВСЁ РАВНО — строки очереди завершаются после
      // прогона независимо от того, что он успел, — и подсказка сгорала бы в
      // прогоне, который заведомо не мог её выполнить: привязка ждала бы
      // периода 300 с. Сдвиг ровно на окно дебаунса от mtime ФАЙЛА, а не от
      // «сейчас»: на давно не менявшемся файле он равен нулю и ничего не
      // откладывает.
      try {
        const { jobs } = await import("@myc/store-sqlite");
        jobs.enqueue(h.driver.database, "anchor_check", {
          entityId: anchorNode.id,
          scope: h.scope,
          payload: { path },
          now,
          runAfter: Math.max(now, Math.floor(st.mtimeMs) + ANCHOR_DEBOUNCE_MS),
        });
      } catch {
        /* очередь недоступна — см. выше, привязку доведёт период */
      }
    }
    return {
      ok: true,
      anchor: {
        anchorId: anchorNode.id,
        path,
        start: b.spanStart,
        end: b.spanEnd,
        state: "fresh",
        cruxLines: b.crux.length === 0 ? 0 : b.crux.split("\n").length,
        fileHash: b.fileHash,
        deferred,
        sizeBytes: b.sizeBytes,
      },
    };
  } catch (e) {
    return {
      ok: false,
      code: "store.error",
      msg: e instanceof Error ? e.message : String(e),
      cause: e,
    };
  }
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

        const { repoId } = anchorRepo(h);
        const symbol = S.flagStr(ctx, "symbol") ?? "";
        const bound = await bindAnchorAt(h, node.id, target, ctx.globals.directory ?? process.cwd(), {
          symbol,
          ...(S.flagStr(ctx, "as") !== undefined ? { actor: S.flagStr(ctx, "as")! } : {}),
        });
        if (!bound.ok) {
          if (bound.code === "notfound.file") {
            return failure("notfound.file", bound.msg, ExitCode.NOTFOUND);
          }
          if (bound.code === "outside.repo") {
            return failure("usage.outside_repo", bound.msg, ExitCode.USAGE);
          }
          return S.graphFailure(bound.cause);
        }
        const a = bound.anchor;

        const data: AddData = {
          anchor_id: a.anchorId,
          node_id: node.id,
          repo: repoId,
          path: a.path,
          start: a.start,
          end: a.end,
          symbol,
          state: a.state,
          crux_lines: a.cruxLines,
          file_hash: a.fileHash,
          deferred: a.deferred,
          size_bytes: a.sizeBytes,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        if (a.deferred) {
          ctx.warn(
            "anchor.deferred",
            `crux отложен в фон: ${kb(a.sizeBytes)} больше порога ${kb(anchorInlineMaxBytes())} — ` +
              `запись осталась в бюджете, точность догонит фоновая проверка (myc anchor check)`,
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as AddData;
      const sym = d.symbol.length > 0 ? ` (${d.symbol})` : "";
      const crux = d.deferred
        ? `crux      отложен в фон: ${kb(d.size_bytes)} > ${kb(anchorInlineMaxBytes())} · ${d.file_hash}`
        : `crux      ${d.crux_lines} строк · ${d.file_hash}`;
      return (
        `${d.anchor_id} anchor fresh · ${d.path}:${spanLabel(d.start, d.end)}${sym}\n` +
        `touches   ${d.node_id}\n` +
        `${crux}\n` +
        `${d.took_ms} мс\n`
      );
    },
  };
}

// ---------------------------------------------------------------------------
// `--anchor` у remember и task: тот же путь, что `anchor add`
// ---------------------------------------------------------------------------

/**
 * Строка якоря в выводе `remember`/`task`. Раньше здесь всегда стояло
 * «якорь отложен до myc anchor bind» — фраза неверная дважды: откладывать
 * больше нечего, а команды `myc anchor bind` не существует (она `add`).
 */
export interface AnchorFlagResult {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  /** Узел якоря; отсутствует — привязать не удалось. */
  readonly anchor_id?: string;
  readonly state: string;
  /** Почему не привязан. Пусто — привязан. */
  readonly reason?: string;
  /** Привязан, но crux снимет фон: файл больше порога S66. */
  readonly deferred?: boolean;
  /** Размер файла в байтах — число, по которому принято решение. */
  readonly size_bytes?: number;
}

/**
 * ПРИВЯЗАТЬ ИЛИ СКАЗАТЬ ВСЛУХ, ПОЧЕМУ НЕТ. Отказать целиком нельзя: узел уже
 * записан, и уронить запись из-за опечатки в пути значило бы потерять текст,
 * который агент только что сформулировал. Поэтому неудача — это громкая
 * деградация (И2): намерение остаётся в `attrs.anchors` со `state='pending'`
 * (оттуда его читает `anchorPathsOf`, и класс задачи не теряет ось scope),
 * а причина уходит в WARN и в строку вывода.
 *
 * При УСПЕХЕ `attrs.anchors` НЕ ПИШЕТСЯ: якорь есть в базе настоящий, и
 * вторая его копия в attrs дала бы `show` две строки об одном якоре, а
 * `anchorPathsOf` — один и тот же путь дважды.
 */
export async function attachAnchorFlag(
  h: StoreHandle,
  nodeId: string,
  target: AnchorTarget,
  cwd: string,
  warn: (code: string, msg: string) => void,
): Promise<AnchorFlagResult> {
  const bound = await bindAnchorAt(h, nodeId, target, cwd);
  if (bound.ok) {
    const a = bound.anchor;
    if (a.deferred) {
      // И2: заплатить меньше и промолчать об этом — то же, что заплатить
      // больше и промолчать. Цена названа числом, и названо, кто её доплатит.
      warn(
        "anchor.deferred",
        `crux отложен в фон: ${kb(a.sizeBytes)} больше порога ${kb(anchorInlineMaxBytes())} — ` +
          `запись осталась в бюджете, точность догонит фоновая проверка (myc anchor check)`,
      );
    }
    return {
      path: a.path,
      start: a.start,
      end: a.end,
      anchor_id: a.anchorId,
      state: a.state,
      ...(a.deferred ? { deferred: true, size_bytes: a.sizeBytes } : {}),
    };
  }
  const end = target.whole ? target.start : target.end;
  const pending = { path: target.path, start: target.start, end, state: "pending" };
  try {
    h.store.updateNode(nodeId, { attrs: { anchors: [pending] } });
  } catch {
    // Узел записан, намерение — нет. Причина всё равно прозвучит в WARN.
  }
  warn(
    "anchor.unbound",
    `якорь не привязан: ${bound.msg}; узел записан, привязка осталась намерением — ` +
      `myc anchor add ${nodeId} ${target.path}`,
  );
  return { path: target.path, start: target.start, end, state: "pending", reason: bound.msg };
}

/** Строка вывода. Одна на `remember` и `task` — расходиться им больше нечем. */
export function anchorFlagLine(a: AnchorFlagResult): string {
  const span = a.start === a.end ? `${a.start}` : `${a.start}-${a.end}`;
  if (a.anchor_id !== undefined) {
    const later =
      a.deferred === true
        ? ` · crux отложен в фон (${kb(a.size_bytes ?? 0)} > ${kb(anchorInlineMaxBytes())})`
        : "";
    return `anchor    ${a.path}:${span} → ${a.anchor_id} ${a.state}${later}`;
  }
  return `anchor    ${a.path}:${span} @— не привязан: ${a.reason ?? "причина не названа"} (myc anchor add)`;
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
        const wantPath =
          target === undefined ? undefined : repoRelative(repoRoot, target.path, mainCwd(h, ctx));

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
        const path = repoRelative(repoRoot, target.path, mainCwd(h, ctx));
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
  /** Отложено дебаунсом §7.5: файл правится прямо сейчас. */
  skipped_debounce: number;
  /** Доведено отложенных привязок (S66): crux снят фоном, а не записью. */
  bound: number;
  /** Прогон упёрся в бюджет и батч разобран не весь (фон). */
  budget_hit: boolean;
  changed: CheckLine[];
  dry_run: boolean;
  took_ms: number;
}

/**
 * НЕДОВЯЗАННЫЙ ЯКОРЬ — тот, у которого пустой `span_hash` (S66). Настоящая
 * привязка и любая проверка кладут туда `wy:…` всегда, поэтому предикат
 * однозначен и не зависит ни от `state`, ни от `checked_at`: строка, ввезённая
 * извне или засеянная тестом, под него не попадает — у неё хеш есть.
 */
export function isDeferredBind(row: { readonly span_hash: string }): boolean {
  return row.span_hash.length === 0;
}

/**
 * ДОВЕСТИ ОТЛОЖЕННУЮ ПРИВЯЗКУ — не лестница, а та самая нормализация, за
 * которую запись отказалась платить. Лестницу тут звать нельзя, и это не
 * вкусовщина: уровень 1 сравнил бы mtime и размер, увидел совпадение (файл с
 * момента записи не менялся — обычный случай) и объявил якорь свежим, НЕ
 * посчитав crux. Якорь остался бы без текста навсегда, то есть не пережил бы
 * ни одного рефакторинга — ровно та точность, ради которой crux и заведён.
 *
 * Результат отдаётся в форме `AnchorCheck`, чтобы писала его та же
 * `applyCheck`: две разные записи одной строки — это два места, где можно
 * разойтись.
 */
function finishBind(
  row: AnchorRow,
  abs: string,
  bind: typeof import("@myc/code-intel/anchors").bindAnchor,
): AnchorCheck {
  let source: string;
  let st: StatLike;
  try {
    st = statSync(abs);
    source = readFileSync(abs, "utf8");
  } catch {
    // Файл исчез между записью и фоном. `span_hash` остаётся пустым — якорь
    // остаётся недовязанным, и следующий прогон попробует снова, если файл
    // вернётся. Врать про `fresh` на пропавшем файле нельзя.
    return {
      state: "stale",
      level: 0,
      moved: false,
      spanStart: row.span_start,
      spanEnd: row.span_end,
      drift: 0,
      fileHash: row.file_hash,
      spanHash: "",
      crux: "",
      cruxNorm: "",
      mtimeMs: row.mtime_ms,
      sizeBytes: row.size_bytes,
      reason: "привязку не довести: файл не найден",
    };
  }
  const b = bind(source, row.lang, row.span_start, row.span_end, st);
  return {
    state: "fresh",
    level: 3,
    moved: false,
    spanStart: b.spanStart,
    spanEnd: b.spanEnd,
    drift: 1,
    fileHash: b.fileHash,
    spanHash: b.spanHash,
    crux: b.crux,
    cruxNorm: b.cruxNorm,
    mtimeMs: b.mtimeMs,
    sizeBytes: b.sizeBytes,
    reason: "привязка довязана: crux снят с файла",
  };
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

/**
 * ПРОГОН ЛЕСТНИЦЫ ПО БАТЧУ — общее тело ручного `myc anchor check` и фонового
 * потребителя `jobs(kind='anchor_check')` (drain.ts). Разница между ними —
 * ТОЛЬКО в аргументах: фон приходит с дебаунсом 2 с и бюджетом времени,
 * человек — без обоих и, как правило, с охватом одного репозитория.
 *
 * ПОРЯДОК §7.5: `checked_at ASC` среди `state <> 'lost'`, батч ≤ 256. Грязные
 * пути (журнал хука post-edit плюс payload работ очереди) идут ПЕРВЫМИ, и
 * берутся они ОТДЕЛЬНЫМ запросом, а не сортировкой прочитанной таблицы:
 * `.all()` по всей `anchors` стоил бы 50k прочитанных строк на репозиторий с
 * 50k якорей, тогда как приёмка §7.5 обещает батч, а не скан.
 *
 * БЮДЖЕТ ПРОВЕРЯЕТСЯ ПЕРЕД КАЖДЫМ ЯКОРЕМ, и недоразобранный батч — это норма,
 * а не потеря: следующий прогон возьмёт те же строки, потому что их
 * `checked_at` не сдвинулся, и порядок `checked_at ASC` ставит их первыми.
 *
 * ДВЕ РАБОТЫ, А НЕ ОДНА (S66). Строка с пустым `span_hash` — это не «якорь,
 * который надо проверить», а «привязка, которую запись не довела»: ей нужна
 * нормализация файла, а не лестница. Обе живут в одном батче и в одном
 * порядке (`checked_at = 0` ставит недовязанные первыми), но идут разными
 * путями и считаются раздельно — `bound` против `checked`.
 */
export interface SweepOptions {
  /** Охват одного репозитория; пусто — все репозитории воркспейса (фон). */
  readonly repoId?: string;
  /** Корень для строк со старым пустым `repo_root`. */
  readonly repoRoot: string;
  /** Корень воркспейса — там лежит `.myc/anchor-dirty.log`. */
  readonly wsDir: string;
  readonly limit?: number;
  readonly pathPrefix?: string;
  readonly dryRun?: boolean;
  readonly maxLevel?: MaxLevel;
  /** Дебаунс §7.5; 0 — проверять всё (ручной вызов). */
  readonly debounceMs?: number;
  /** Потолок времени на прогон; 0 — без потолка (ручной вызов). */
  readonly budgetMs?: number;
  /** Пути-подсказки поверх журнала: payload работ `anchor_check`. */
  readonly hintPaths?: readonly string[];
  readonly now?: number;
}

/**
 * Один запрос на обе половины батча. `?3 = 1` — только грязные пути,
 * `?3 = 0` — все; фильтры репозитория и префикса выключаются пустой строкой,
 * чтобы у ручного и фонового вызова был ОДИН план, а не два похожих.
 */
export const SQL_SWEEP_BATCH = `SELECT * FROM anchors
 WHERE state <> 'lost'
   AND (?1 = '' OR repo_id = ?1)
   AND (?2 = '' OR path LIKE ?2)
   AND (?3 = 0 OR path IN (SELECT value FROM json_each(?4)))
 ORDER BY checked_at ASC, node_id ASC
 LIMIT ?5`;

export async function sweepAnchors(h: StoreHandle, opts: SweepOptions): Promise<CheckData> {
  const t0 = performance.now();
  const { bindAnchor, checkAnchor } = await engine();
  const db = h.driver.database;
  const limit = opts.limit ?? ANCHOR_CHECK_BATCH_DEFAULT;
  const repoId = opts.repoId ?? "";
  const like = opts.pathPrefix === undefined ? "" : `${opts.pathPrefix}%`;
  const debounceMs = opts.debounceMs ?? 0;
  const budgetMs = opts.budgetMs ?? 0;
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const maxLevel = opts.maxLevel ?? 3;

  // Журнал грязных файлов — подсказка «сюда раньше», не источник истины:
  // потеряв его целиком, система теряет очерёдность и ничего больше.
  const dirty = new Set(
    drainDirtyLog(opts.wsDir).map((abs) => repoRelative(opts.repoRoot, abs, opts.repoRoot)),
  );
  for (const p of opts.hintPaths ?? []) if (p.length > 0) dirty.add(p);
  const dirtyJson = JSON.stringify([...dirty]);

  const q = db.query(SQL_SWEEP_BATCH);
  const batch: AnchorRow[] = [];
  const taken = new Set<string>();
  if (dirty.size > 0) {
    for (const r of q.all(repoId, like, 1, dirtyJson, limit) as AnchorRow[]) {
      batch.push(r);
      taken.add(r.node_id);
    }
  }
  if (batch.length < limit) {
    for (const r of q.all(repoId, like, 0, "[]", limit) as AnchorRow[]) {
      if (taken.has(r.node_id)) continue;
      batch.push(r);
      if (batch.length >= limit) break;
    }
  }

  const data: CheckData = {
    checked: 0,
    fresh: 0,
    drifted: 0,
    stale: 0,
    lost: 0,
    moved: 0,
    from_dirty: batch.filter((r) => dirty.has(r.path)).length,
    by_level: { "0": 0, "1": 0, "2": 0, "3": 0 },
    skipped_debounce: 0,
    bound: 0,
    budget_hit: false,
    changed: [],
    dry_run: dryRun,
    took_ms: 0,
  };

  for (const row of batch) {
    if (budgetMs > 0 && performance.now() - t0 >= budgetMs) {
      data.budget_hit = true;
      break;
    }
    const root = row.repo_root.length > 0 ? row.repo_root : opts.repoRoot;
    const abs = join(root, row.path);
    // Дебаунс: файл, изменённый только что, честнее не трогать вовсе, чем
    // объявить `stale` по недописанному тексту. Один stat — та же цена, что
    // уровень 1 лестницы, и платится он только фоном (debounceMs > 0).
    if (debounceMs > 0) {
      try {
        if (now - statSync(abs).mtimeMs < debounceMs) {
          data.skipped_debounce++;
          continue;
        }
      } catch {
        // Файла нет — это работа лестницы (уровень 0), не дебаунса.
      }
    }
    const deferred = isDeferredBind(row);
    const r = deferred
      ? finishBind(row, abs, bindAnchor)
      : checkAnchor(toAnchorLike(row), abs, undefined, maxLevel);
    data.checked++;
    if (deferred && r.state === "fresh") data.bound++;
    data[r.state]++;
    data.by_level[String(r.level)] = (data.by_level[String(r.level)] ?? 0) + 1;
    if (r.moved) data.moved++;
    // Довязанный якорь попадает в список изменённых, даже когда состояние не
    // сдвинулось (`fresh` → `fresh`): без строки вывод сообщал бы «довязано 1»,
    // не называя, какой именно, — счётчик без имени нечем проверить.
    if (r.state !== row.state || r.moved || deferred) {
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
    if (!dryRun) {
      applyCheck(db, h, row, r, now);
      // Тело anchor-узла — это crux; у отложенной привязки его не было вовсе
      // (`null`), и `applyCheck` про узлы знает только статус. Без этой
      // строки `show` и `recall` показывали бы пустой якорь навсегда.
      if (deferred && r.crux.length > 0) {
        try {
          h.store.updateNode(row.node_id, { body: r.crux });
        } catch {
          // Узел якоря мог быть удалён вручную: строка обновлена, тело — нет.
        }
      }
    }
  }

  data.took_ms = Math.round((performance.now() - t0) * 10) / 10;
  return data;
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
      const S = await heavy();
      const opened = await (deps ?? S.realStoreDeps).openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const { repoId, repoRoot } = anchorRepo(h);
        const levelRaw = S.flagNum(ctx, "level");
        // Ручной вызов — БЕЗ дебаунса и БЕЗ бюджета: спросили про сейчас.
        const data = await sweepAnchors(h, {
          repoId,
          repoRoot,
          wsDir: h.wsDir,
          limit: S.flagNum(ctx, "limit") ?? ANCHOR_CHECK_BATCH_DEFAULT,
          ...(S.flagStr(ctx, "path") !== undefined
            ? { pathPrefix: S.flagStr(ctx, "path")! }
            : {}),
          dryRun: ctx.flags["dry-run"] === true,
          maxLevel: (levelRaw === 1 || levelRaw === 2 ? levelRaw : 3) as MaxLevel,
        });

        if (data.stale > 0 || data.lost > 0) {
          ctx.warn(
            "anchor.stale",
            `${data.stale + data.lost} якорей протухло — привязка больше не указывает на живой код`,
          );
        }
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
        `уровни: 1 ${d.by_level["1"] ?? 0} · 2 ${d.by_level["2"] ?? 0} · 3 ${d.by_level["3"] ?? 0} · нет файла ${d.by_level["0"] ?? 0} · из журнала ${d.from_dirty}` +
          (d.bound > 0 ? ` · довязано ${d.bound}` : "") +
          (d.skipped_debounce > 0 ? ` · отложено дебаунсом ${d.skipped_debounce}` : "") +
          (d.budget_hit ? " · упёрлось в бюджет" : ""),
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
