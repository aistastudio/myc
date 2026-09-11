/**
 * `myc code` — вход и читатель встроенного код-индекса (S52, §4.3
 * docs/design/05-code-intelligence.md).
 *
 * ЗАЧЕМ КОМАНДА ВООБЩЕ. Индекс `code_files/code_defs/code_refs` был написан,
 * покрыт тестами и мёртв: `runCodeIndex` звал только стенд замера, а таблицы
 * не читал НИКТО (memory-m30yh8swnm1d). При этом `myc init` печатал «символы и
 * fan_in по тексту» — обещание, которого не выполнял никто. Здесь обе
 * половины: `myc code index` строит, `myc code symbol` читает.
 *
 * ПОЧЕМУ НЕ `myc reindex --code`. `reindex` — про ВЕКТОРНОЕ пространство: он
 * отказывает без vec0 (exit 3), поднимает эмбеддер и сверяет отпечаток
 * пространства ДО первой записи. Код-индексу не нужно ничего из этого: он
 * работает там, где модель не скачана вовсе, и обязан работать — иначе символы
 * репозитория стали бы заложником наличия ONNX-модели. Собрать их в одну
 * команду значит либо провести код-индекс мимо этих проверок (и получить
 * команду, половина флагов которой падает по чужой причине), либо отказывать в
 * символах без модели.
 *
 * ГОРЯЧИЙ ПУТЬ (И1). Команда синхронная и стоит СЕКУНДЫ на большом дереве —
 * поэтому её никто не зовёт из чужого вызова. Фон поднимает её ОТСОЕДИНЁННЫМ
 * процессом (`drain.ts`, шаг `code_index`), ровно как `myc reindex` для класса
 * `embed`: команда, ради которой случился дренаж, не ждёт ничего.
 *
 * ЧИТАТЕЛЬ. `myc code symbol <name>` отвечает на вопрос, которого без индекса
 * задать было нельзя: где определён символ И КАКОЕ ЗНАНИЕ К НЕМУ ПРИВЯЗАНО.
 * Второе — стык, которого нет ни у graft, ни у grep: якорь хранит `file:span`,
 * индекс — `symbol → span`, и пересечение спанов превращает «строки 507-644» в
 * «функция drainQueueTail, и вот три записи про неё».
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
// Статически — только список языков и вид: `langs.ts` не тянет ни tree-sitter,
// ни хранилище (он тот же, что грузит `select.ts` ради строки `init`), а
// `view.ts` не импортирует ничего вовсе. Всё тяжёлое ниже по-прежнему
// динамическим `import()`.
import { L1_LANGS_LABEL } from "@myc/code-intel/langs";
import { type CodeView, coveringAncestor, coveringIndex, SQL_HAS_ROWS } from "@myc/code-intel/view";
// Ближайший индекс живёт в view.ts: его спрашивает и строка статуса, которой
// тянуть весь этот модуль на каждой перерисовке незачем.
export { coveringAncestor, coveringIndex };
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import {
  flagBool,
  flagNum,
  flagStr,
  realStoreDeps,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";
import { mapIntoWorktree, readWorktreeLink, type WorktreeLink } from "./wsfind.ts";

/**
 * Ключ отметки последнего прогона код-индекса в `myc_meta`. Живёт здесь, у
 * команды, которая её обновляет; фоновый шаг дренажа читает ЭТУ константу, а
 * не свою копию строки — разъехавшиеся копии означали бы период, действующий
 * в одну сторону и не действующий в другую.
 */
export const CODE_INDEXED_AT_KEY = "code_indexed_at";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

/** «2.3 MB» — тот же формат, что у самого код-интеллекта; одна реализация. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** `1 file`, `2 files` — число и существительное в человеческой строке. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Ошибка «нет ресурса» — или null, если это что-то другое. Опознаётся по
 * КЛАССУ из @myc/code-intel, а не по тексту сообщения: строку кто-нибудь
 * когда-нибудь перепишет, и опознание сломается молча.
 */
async function missingResource(e: unknown): Promise<{ message: string; hint: string } | null> {
  const { MissingResourceError } = await import("@myc/code-intel/symbols");
  if (e instanceof MissingResourceError) return { message: e.message, hint: e.hint };
  return null;
}

/**
 * Репозиторий и его корень на диске — те же правила, что у якорей (S59,
 * `anchorRepo`): `repo_root` машинозависим и выводится из каталога вызова, а
 * не приезжает из базы. Дублировать логику нельзя: индекс и якоря обязаны
 * писать ОДИН И ТОТ ЖЕ `repo_id`, иначе `defsInSpan` не найдёт ничего.
 */
export async function codeRepo(
  h: StoreHandle,
  explicit: string | undefined,
): Promise<{ repoId: string; repoRoot: string }> {
  const { anchorRepo } = await import("./anchor.ts");
  const derived = anchorRepo(h);
  if (explicit === undefined || explicit.trim().length === 0) return derived;
  const repoId = explicit.trim();
  return { repoId, repoRoot: repoId.length === 0 ? h.wsDir : join(h.wsDir, repoId) };
}

// ---------------------------------------------------------------------------
// Откуда отвечать: свой индекс, часть индекса корня, основная копия worktree
// (memory-m0md9fybwrdh)
// ---------------------------------------------------------------------------
//
// ЗАЧЕМ. В экосистеме (S59) индекс строят из КОРНЯ: одна строка на файл,
// `repo_id = ''`, пути вида `messaging-server/server/src/x.ts`. Агент стоит во
// вложенном репозитории или в его git worktree, и `codeRepo` выводит ему
// `messaging-server` — ключ, под которым строк нет. До этого места каждый
// читатель отвечал `precond.no_index` и советовал `myc code index`, то есть
// вторую копию тех же файлов под другим ключом (база cherry — уже 185 МБ).
//
// ПРАВИЛО — БЛИЖАЙШИЙ ИНДЕКС. Есть строки под своим `repo_id` — отвечает свой
// (прежнее поведение, байт в байт). Нет — отвечает ближайший предок, чей
// индекс покрывает путь репозитория: для `messaging-server` это корень с
// префиксом `messaging-server/`. Пути в выдаче — от корня репозитория, где
// стоит агент, как и у собственного индекса. Ключи в базе не меняются, ничего
// не переписывается; почему не «переключить ключ на репозиторий» — в README и
// в шапке `@myc/code-intel/view`.
//
// WORKTREE. Индекс — это основная копия репозитория: отдельного индекса на
// ветку нет. Перечень, символы и спаны берутся из него. Файлы читаются по
// правилу «текст обязан сходиться с тем, что к нему приложено»:
//   code grep — из worktree (вхождения и номера строк — файлов агента;
//               файла нет на ветке — из основной копии, и это названо);
//   skeleton  — из worktree, если его копия совпала с тем, что видел индекс,
//               иначе из основной копии с WARN `skeleton.main_copy`: сигнатуры,
//               нарезанные спанами основной копии из файла ветки, — мусор;
//   callers   — строки вхождений из основной копии: номера — её;
//   fan_in    — по основной копии: это статистика индекса, и кеш её общий.
// Коммит worktree не тот, что у основной копии, или в нём правки
// отслеживаемых файлов — WARN `code_index.worktree_divergent` с обеими
// ветками у КАЖДОГО читателя: строки и спаны могут не совпасть.

/** Состояние git worktree, из которого позвали, против основной копии. */
export interface CodeWorktree {
  /** Рабочее дерево worktree. */
  readonly dir: string;
  /** Корень ОСНОВНОЙ копии того же репозитория — с неё снят индекс. */
  readonly mainRoot: string;
  /** `feature @1a2b3c4` */
  readonly branch: string;
  readonly mainBranch: string;
  /** Правки отслеживаемых файлов в worktree; null — не спрашивали или git не ответил. */
  readonly dirty: boolean | null;
  /** Коммиты worktree и основной копии совпали (и оба известны). */
  readonly sameCommit: boolean;
  readonly divergent: boolean;
  readonly tookMs: number;
}

/** Откуда отвечает код-запрос — одно решение на все читатели. */
export interface CodeTarget {
  /** Репозиторий вопроса (S59): его пути — в выдаче. */
  readonly repoId: string;
  /** Его корень в основной копии. */
  readonly repoRoot: string;
  /** Чей индекс и какая его часть. */
  readonly view: CodeView;
  /** Ответ из части индекса предка, а не из своего. */
  readonly borrowed: boolean;
  /** Индекса нет ни у репозитория, ни у предков. */
  readonly missing: boolean;
  /** Где читать файлы по путям выдачи: в worktree — его копия репозитория. */
  readonly fileRoot: string;
  /** Где читать файл, которого нет под `fileRoot`: основная копия. Вне worktree — нет. */
  readonly fallbackRoot?: string;
  readonly worktree?: CodeWorktree;
  /** Корень воркспейса — для подсказки «строить отсюда». */
  readonly wsDir: string;
}

/** `dir` лежит под `root` (или совпадает) — по строке, а при симлинках по realpath. */
function under(root: string, dir: string): boolean {
  const inside = (a: string, b: string): boolean => {
    const rel = relative(a, b);
    return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (inside(root, dir)) return true;
  try {
    return inside(realpathSync(root), realpathSync(dir));
  } catch {
    return false;
  }
}

/**
 * Ссылка worktree для код-запроса. Первая форма — worktree ВНЕ воркспейса:
 * её уже нашёл поиск воркспейса (`h.worktree`). Вторая — worktree ВНУТРИ
 * дерева экосистемы (`wt-collector` рядом с `collector`): подъём нашёл
 * воркспейс сам, ссылки в хендле нет, а охват уже переименован в основное
 * дерево (`deriveRepoAcrossWorktrees`) — значит, файлы надо читать не там,
 * куда указывает охват. Одна `stat` первого сегмента, и только когда он не
 * совпал с именем репозитория.
 *
 * Годится лишь ссылка, чьё основное дерево СОДЕРЖИТ корень репозитория
 * вопроса: иначе индекс снят с самого этого дерева, и сравнивать не с чем.
 */
function worktreeOf(h: StoreHandle, cwd: string, repoId: string, repoRoot: string): WorktreeLink | undefined {
  let link = h.worktree;
  if (link === undefined) {
    const rel = relative(h.wsDir, resolve(cwd));
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const first = rel.split(sep)[0]!;
    if (first === repoId.split("/")[0]) return undefined; // обычный вложенный репозиторий
    link = readWorktreeLink(join(h.wsDir, first));
  }
  if (link === undefined || !under(link.mainRoot, repoRoot)) return undefined;
  return link;
}

/**
 * Цель код-запроса: `codeRepo` плюс ближайший покрывающий индекс плюс
 * worktree. Git спрашивается только из worktree (см. `compareWorktree`).
 */
export async function codeTarget(
  h: StoreHandle,
  explicit: string | undefined,
  cwd: string,
): Promise<CodeTarget> {
  const { repoId, repoRoot } = await codeRepo(h, explicit);
  const cover = coveringIndex(h.driver.database, repoId);
  const view: CodeView = cover ?? { repoId, prefix: "" };
  const base = {
    repoId,
    repoRoot,
    view,
    borrowed: cover !== null && (cover.repoId !== repoId || cover.prefix.length > 0),
    missing: cover === null,
    wsDir: h.wsDir,
  };
  const link = worktreeOf(h, cwd, repoId, repoRoot);
  if (link === undefined) return { ...base, fileRoot: repoRoot };
  const { compareWorktree, headLabel } = await import("@myc/code-intel/worktree");
  const cmp = compareWorktree(link.gitDir, link.worktreeDir);
  let fileRoot = mapIntoWorktree(link, repoRoot);
  if (fileRoot === repoRoot) {
    // Пути пришли через разные симлинки (/tmp против /private/tmp): тот же
    // перенос по realpath.
    try {
      fileRoot = mapIntoWorktree(link, realpathSync(repoRoot));
    } catch {
      /* корня нет на диске — читать будет нечего в любом случае */
    }
  }
  return {
    ...base,
    fileRoot,
    fallbackRoot: repoRoot,
    worktree: {
      dir: link.worktreeDir,
      mainRoot: link.mainRoot,
      branch: headLabel(cmp.worktree),
      mainBranch: headLabel(cmp.main),
      dirty: cmp.dirty,
      sameCommit: cmp.worktree.sha !== null && cmp.worktree.sha === cmp.main.sha,
      divergent: cmp.divergent,
      tookMs: cmp.tookMs,
    },
  };
}

/** Что попадает в `--json` о происхождении ответа. Поля нет — ответ из своего индекса вне worktree. */
export interface SourceData {
  /** Чей индекс ответил: `repo` и префикс части в нём, корень на диске. */
  index: { repo: string; prefix: string; root: string };
  /** Где прочитаны файлы; null — команда файлов не читает (search, map). */
  files: string | null;
  worktree?: {
    dir: string;
    branch: string;
    main_root: string;
    main_branch: string;
    dirty: boolean | null;
    divergent: boolean;
    took_ms: number;
  };
}

/**
 * Поле `source` ответа — только когда ответ НЕ из собственного индекса или
 * позван из worktree. Для запроса из корня (и из репозитория со своим
 * индексом) выдача остаётся прежней байт в байт.
 */
export function sourceData(t: CodeTarget, files: string | null = t.fileRoot): SourceData | undefined {
  if (!t.borrowed && t.worktree === undefined) return undefined;
  const indexRoot = t.view.repoId.length === 0 ? t.wsDir : join(t.wsDir, t.view.repoId);
  const out: SourceData = {
    index: { repo: t.view.repoId, prefix: t.view.prefix, root: indexRoot },
    files,
  };
  if (t.worktree !== undefined) {
    out.worktree = {
      dir: t.worktree.dir,
      branch: t.worktree.branch,
      main_root: t.worktree.mainRoot,
      main_branch: t.worktree.mainBranch,
      dirty: t.worktree.dirty,
      divergent: t.worktree.divergent,
      took_ms: Math.round(t.worktree.tookMs),
    };
  }
  return out;
}

/** Строки человеческой выдачи про происхождение ответа; пусто — ответ из своего индекса. */
export function sourceLines(s: SourceData | undefined): string[] {
  if (s === undefined) return [];
  const out: string[] = [];
  if (s.index.prefix.length > 0) {
    out.push(
      `index     ${s.index.repo.length > 0 ? `repo ${s.index.repo}` : "workspace root"} ${s.index.root}, ` +
        `part ${s.index.prefix} — paths above are relative to that part`,
    );
  }
  if (s.worktree !== undefined) {
    const from =
      s.files === null
        ? ""
        : `; files read from ${s.files === s.worktree.main_root ? "the main copy" : s.files === s.worktree.dir ? "the worktree" : s.files}`;
    out.push(
      `worktree  ${s.worktree.dir} (${s.worktree.branch}${s.worktree.dirty === true ? ", uncommitted changes" : ""}) — ` +
        `index of the main copy ${s.worktree.main_root} (${s.worktree.main_branch})${from}`,
    );
  }
  return out;
}

/**
 * WARN расхождения worktree с основной копией (И2). Один текст на все
 * читатели: из какой копии и ветки ответ, где стоит агент, и что может не
 * совпасть.
 */
export function warnWorktree(ctx: CommandContext, t: CodeTarget, reads?: string): void {
  const w = t.worktree;
  if (w === undefined || !w.divergent) return;
  const why = !w.sameCommit
    ? "it is on another commit"
    : w.dirty === true
      ? "it has uncommitted changes to tracked files"
      : "git did not say whether it has uncommitted changes";
  ctx.warn(
    "code_index.worktree_divergent",
    `answer from the code index of the MAIN copy ${w.mainRoot} (${w.mainBranch}), not from your worktree ` +
      `${w.dir} (${w.branch}) — ${why}: the file list, symbols and spans are the main copy's, so lines and ` +
      `spans may not match your files${reads === undefined ? "" : ` (${reads})`}`,
  );
}

/**
 * Покроет ли индекс КОРНЯ этот вложенный репозиторий, когда корень
 * переиндексируют: есть индекс корня, и git корня каталог не игнорирует
 * (перечень корня берёт вложенный репозиторий ровно тогда). Тогда свой
 * индекс у репозитория — будущий дубль, а правильное действие — корень.
 * Git спрашивается только здесь, на пути отказа и первого индекса.
 */
async function rootWouldCover(db: Database, ws: string, repoId: string): Promise<{ indexed: boolean; ignored: boolean | null }> {
  const indexed = db.query(SQL_HAS_ROWS).get("") !== null;
  if (!indexed || repoId.length === 0) return { indexed, ignored: null };
  const { gitIgnores } = await import("@myc/code-intel/worktree");
  return { indexed, ignored: gitIgnores(ws, repoId.split("/")[0]!) };
}

/**
 * Отказ «индекса нет» с советом, который НЕ строит дубль. Случаи и подсказки:
 * репозиторий — сам корень, или индекса нет нигде — строить из корня
 * воркспейса (путь печатается: одна команда на все вложенные репозитории);
 * индекс корня есть, но этого репозитория в нём нет, и git корня его не
 * игнорирует — индекс корня просто старше репозитория, переиндексировать
 * корень; git корня его игнорирует — корень его не возьмёт никогда, и
 * собственный индекс репозитория дублем не будет.
 */
export async function noIndexFailure(
  h: StoreHandle,
  t: CodeTarget,
  tail: string,
  /**
   * Прежний текст отказа корня — для вопроса из самого корня он не меняется
   * ни на слово: `myc code index` оттуда и так строит индекс корня, а
   * одинаковость текста CLI и MCP стережёт code.parity.test.ts.
   */
  rootMsg: string,
): Promise<CommandFailure> {
  const ws = t.wsDir;
  if (t.repoId.length === 0) {
    return failure("precond.no_index", rootMsg, ExitCode.PRECOND, "myc code index");
  }
  const root = await rootWouldCover(h.driver.database, ws, t.repoId);
  if (root.indexed && root.ignored === true) {
    return failure(
      "precond.no_index",
      `no code index covers ${t.repoId}: it has no index of its own, and the workspace-root index (${ws}) ` +
        `never will — the root's git ignores ${t.repoId}/ — ${tail}`,
      ExitCode.PRECOND,
      `myc -C ${t.repoRoot} code index   # not a duplicate: the root index does not cover ${t.repoId}`,
    );
  }
  if (root.indexed) {
    return failure(
      "precond.no_index",
      `no code index covers ${t.repoId} yet: the workspace-root index (${ws}) has no files under ` +
        `${t.repoId}/ — it was built before this repo appeared — ${tail}`,
      ExitCode.PRECOND,
      `myc -C ${ws} code index   # adds ${t.repoId}/ to the root index; incremental, the rest is not re-read`,
    );
  }
  return failure(
    "precond.no_index",
    `no code index covers ${t.repoId}: neither its own nor the workspace-root index (${ws}) is built — ${tail}`,
    ExitCode.PRECOND,
    `myc -C ${ws} code index   # one index for the workspace root and every nested repo`,
  );
}

// ---------------------------------------------------------------------------
// myc code index — вход
// ---------------------------------------------------------------------------

interface CodeIndexData {
  repo: string;
  root: string;
  /**
   * Прогон обновил ЧАСТЬ индекса предка, а не свой (memory-m0md9fybwrdh):
   * чей индекс, какой префикс, где его корень. Поля нет — индекс свой.
   */
  into?: { repo: string; prefix: string; root: string };
  dry_run: boolean;
  scan: {
    files: number;
    /** Репозитории, перечисленные своим `git ls-files` (с .gitignore). */
    git_repos: string[];
    /** Каталоги, где перечень — обход БЕЗ .gitignore, и почему. Пусто — всё от git. */
    unignored: { dir: string; reason: string }[];
    /** Не взято в перечень по секретному имени (.env, ключи, учётные данные) — числом, без имён. */
    secret_skipped: number;
    /** git worktree репозиториев этого дерева, не взятые в перечень: вторая копия файлов основного дерева. */
    worktrees_skipped: number;
    /** Они же по каталогам: `dir` — путь от корня индекса, `main` — основное дерево того же репозитория. */
    skipped_worktrees: { dir: string; main: string }[];
    unchanged: number;
    touched: number;
    dirty: number;
    enqueued: number;
    removed: number;
    excluded: number;
    scan_ms: number;
  };
  drain: {
    claimed: number;
    parsed: number;
    written: number;
    cleaned: number;
    failed: number;
    batches: number;
    /**
     * Разобрано ПУЛОМ воркеров (остальное — в этом же потоке). Число здесь не
     * для красоты: пул, который молча не завёлся, от пула, который отработал,
     * по `parsed` неотличим — и ровно так он год не работал в бинаре.
     */
    pooled: number;
    /** Файлы, пропущенные из-за отсутствующей грамматики (символов не будет). */
    skipped: number;
    parse_ms: number;
    drain_ms: number;
  };
  /**
   * Каких грамматик не хватило. Поле есть ВСЕГДА (пустым списком), а не
   * появляется при беде: потребитель `--json` не должен угадывать, значит ли
   * его отсутствие «всё хорошо» или «старая версия myc».
   */
  missing_grammars: { grammar: string; langs: string[]; bytes: number; files: number; fetch: string }[];
  /**
   * Корпус поиска (`code search`). Строится ЗДЕСЬ, а не отдельной командой,
   * потому что иначе он расходился бы с индексом молча: индекс обновил фон,
   * корпус остался вчерашним, и `code search` отвечал бы про удалённый код.
   */
  search: {
    rebuilt: number;
    reused: number;
    removed: number;
    units: number;
    bytes: number;
    took_ms: number;
  };
  /** Состояние индекса ПОСЛЕ прогона — то, ради чего команда и звалась. */
  files: number;
  defs: number;
  langs: { lang: string; files: number }[];
  took_ms: number;
}

const INDEX_FLAGS: readonly FlagSpec[] = [
  { name: "dry-run", description: "count what would be indexed, write nothing" },
  { name: "batch", value: "number", description: "jobs per claim/transaction (default 256)" },
  { name: "repo", value: "string", description: "repo id to index (default: derived from cwd)" },
];

function buildCodeIndex(deps: StoreDeps): Command {
  return {
    name: "index",
    summary: "build the code index of this repo: files, symbols, spans",
    help:
      "Walks the repo, enqueues changed files as jobs(kind='code_index') and drains them into " +
      "code_files/code_defs. Incremental on two levels — (mtime,size), then content hash — so a " +
      "repeat run over an unchanged tree reads nothing. Costs seconds on a large tree: this is a " +
      "background job class, and the drain step spawns this very command detached rather than " +
      `running it inline (I1). Symbols are parsed for ${L1_LANGS_LABEL} (L1); every other file is ` +
      "registered by path, language and hash (L0) and gets no symbols. A L1 language whose " +
      "tree-sitter grammar is not staged is SKIPPED and NAMED — indexing never goes to the " +
      "network, not even in the background; `myc code fetch` does, and only when a human asks. " +
      "Secret-named files (.env and .env.* except templates, *.pem, *.key, keystores, private SSH " +
      "keys, .npmrc/.netrc and other credentials) are never indexed, whatever .gitignore says: " +
      "the scan line counts them as 'secret-named skipped', and rows left from an older index are removed.",
    flags: INDEX_FLAGS,
    handler: async (ctx) => {
      const t0 = performance.now();
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        // ВЛОЖЕННЫЙ РЕПОЗИТОРИЙ, КОТОРЫЙ УЖЕ ПОКРЫТ ИНДЕКСОМ КОРНЯ, не строит
        // свою копию (memory-m0md9fybwrdh): прогон обновляет ЕГО ЧАСТЬ индекса
        // корня — перечень его git, строки под ключом корня с префиксом, и
        // удаление исчезнувшего только под этим префиксом. Отказ с командой
        // для корня был бы проще, но фон (`drain.ts`) поднимает этот же
        // прогон из каталога, где работает агент, — отказ там значил бы, что
        // индекс корня не освежается никогда, пока все сидят во вложенных
        // репозиториях и worktree.
        let t = await codeTarget(h, flagStr(ctx, "repo"), ctx.globals.directory ?? process.cwd());
        const { repoId, repoRoot } = t;
        const db = h.driver.database;
        if (t.missing && repoId.length > 0 && !repoId.includes("/")) {
          // Первый индекс репозитория, которого в индексе корня ещё нет. Если
          // корень проиндексирован и его git этот каталог не игнорирует —
          // следующий прогон корня всё равно его возьмёт, и свой индекс здесь
          // стал бы дублем. Поэтому часть корня — сразу. Индекса корня нет
          // вовсе — прежнее поведение: частичный индекс корня отвечал бы из
          // корня про один репозиторий, не говоря об этом.
          const root = await rootWouldCover(db, h.wsDir, repoId);
          if (root.indexed && root.ignored !== true) {
            t = { ...t, view: { repoId: "", prefix: `${repoId}/` }, borrowed: true, missing: false };
          }
        }
        const { scanCodeIndex, drainCodeIndex } = await import("@myc/code-intel/code-index");
        const { indexScope } = await import("@myc/code-intel/read");
        const part = t.borrowed ? t.view.prefix : "";
        const indexRoot = t.view.repoId.length === 0 ? h.wsDir : join(h.wsDir, t.view.repoId);
        const opts = t.borrowed
          ? { repoId: t.view.repoId, root: indexRoot, subtree: part.slice(0, -1) }
          : { repoId, root: repoRoot };
        const dryRun = flagBool(ctx, "dry-run");
        const scan = await scanCodeIndex(db, opts, !dryRun);
        const batchRaw = flagNum(ctx, "batch");
        let drain;
        try {
          drain = dryRun
            ? { claimed: 0, parsed: 0, written: 0, cleaned: 0, failed: 0, batches: 0, pooled: 0, skipped: 0, missing: [], parseMs: 0, drainMs: 0 }
            : await drainCodeIndex(db, opts, {
                holder: `code-index-${process.pid}`,
                ...(batchRaw !== undefined && batchRaw > 0 ? { batch: Math.floor(batchRaw) } : {}),
              });
        } catch (e) {
          // Нехватка РЕСУРСА — не сбой программы. Раньше рантайм, которого нет
          // в опубликованном пакете, доезжал сюда голым Error и печатался как
          // `internal.unexpected`: агент, ветвящийся на коде, читал это как
          // «myc сломан», а сломан был не myc, а установка.
          const miss = await missingResource(e);
          if (miss !== null) {
            return failure("precond.runtime_missing", miss.message, ExitCode.PRECOND, miss.hint);
          }
          throw e;
        }
        // Корпус поиска — после разбора и в том же прогоне: см. поле `search`.
        const { buildSearchUnits } = await import("@myc/code-intel/search");
        const search = dryRun
          ? { rebuilt: 0, reused: 0, removed: 0, units: 0, bytes: 0, tookMs: 0, missing: 0 }
          : buildSearchUnits(db, opts.repoId, opts.root, part);
        const scope = indexScope(db, t.borrowed ? t.view : repoId);
        const data: CodeIndexData = {
          repo: repoId,
          root: repoRoot,
          ...(t.borrowed ? { into: { repo: t.view.repoId, prefix: part, root: indexRoot } } : {}),
          dry_run: dryRun,
          scan: {
            files: scan.files,
            git_repos: [...scan.gitRepos],
            unignored: scan.unignored.map((u) => ({ dir: u.dir, reason: u.reason })),
            secret_skipped: scan.secretSkipped,
            worktrees_skipped: scan.worktreesSkipped.length,
            skipped_worktrees: scan.worktreesSkipped.map((w) => ({ dir: w.dir, main: w.main })),
            unchanged: scan.unchanged,
            touched: scan.touched,
            dirty: scan.dirty,
            enqueued: scan.enqueued,
            removed: scan.removed,
            excluded: scan.excluded,
            scan_ms: Math.round(scan.scanMs),
          },
          drain: {
            claimed: drain.claimed,
            parsed: drain.parsed,
            written: drain.written,
            cleaned: drain.cleaned,
            failed: drain.failed,
            batches: drain.batches,
            pooled: drain.pooled,
            skipped: drain.skipped,
            parse_ms: Math.round(drain.parseMs),
            drain_ms: Math.round(drain.drainMs),
          },
          missing_grammars: drain.missing.map((m) => ({
            grammar: m.grammar,
            langs: [...m.langs],
            bytes: m.bytes,
            files: m.files,
            fetch: `myc code fetch ${m.langs[0] ?? m.grammar}`,
          })),
          search: {
            rebuilt: search.rebuilt,
            reused: search.reused,
            removed: search.removed,
            units: search.units,
            bytes: search.bytes,
            took_ms: Math.round(search.tookMs),
          },
          files: scope.files,
          defs: scope.defs,
          langs: scope.langs.slice(0, 8).map((l) => ({ lang: l.lang, files: l.files })),
          took_ms: Math.round(performance.now() - t0),
        };
        // Отметка «индекс этого воркспейса свежий» — её же читает фоновый шаг
        // дренажа, чтобы не поднимать воркер чаще периода.
        if (!dryRun) {
          try {
            const { Q } = await import("@myc/store-sqlite");
            h.driver.run(Q.meta_set, [CODE_INDEXED_AT_KEY, String(Date.now())]);
          } catch {
            // Отметка не записалась — фон просто прогонит снова.
          }
        }
        if (drain.failed > 0) {
          ctx.warn("code_index.failed", `files not parsed: ${drain.failed} (see jobs.last_error)`);
        }
        // Из worktree индексируется ОСНОВНАЯ копия — своего индекса у ветки
        // нет; разошлись они — сказать, что построено не то, что правит агент.
        warnWorktree(ctx, t, "this run indexed the main copy, not the worktree");
        if (!t.borrowed && !t.missing && repoId.length > 0) {
          // Две копии одних файлов: свой индекс, построенный до этого правила,
          // и часть индекса корня. Запросы отсюда берут свой (ближайший);
          // молча держать обе — ровно то, от чего правило заведено.
          const anc = coveringAncestor(db, repoId);
          if (anc !== null) {
            ctx.warn(
              "code_index.duplicate",
              `${repoId} has its own code index AND the ${anc.repoId.length > 0 ? `index of ${anc.repoId}` : "workspace-root index"} ` +
                `covers ${anc.prefix} — two copies of the same files; queries from ${repoId} use its own`,
            );
          }
        }
        if (scan.unignored.length > 0) {
          // Перечень без .gitignore — не обычный перечень: в реестр попало
          // игнорируемое, и `code grep` его покажет (И2). Причины сгруппированы:
          // «git не найден» у пятнадцати репозиториев — одна строка, не пятнадцать.
          const byReason = new Map<string, string[]>();
          for (const u of scan.unignored) {
            const dirs = byReason.get(u.reason) ?? [];
            dirs.push(u.dir);
            byReason.set(u.reason, dirs);
          }
          const named = [...byReason]
            .map(([reason, dirs]) => {
              const more = dirs.length > 5 ? ` +${dirs.length - 5}` : "";
              return `${dirs.slice(0, 5).join(", ")}${more} (${reason})`;
            })
            .join("; ");
          ctx.warn(
            "code_index.gitignore_off",
            `.gitignore NOT applied in ${named}: the file list there is a directory walk minus ` +
              "node_modules/.git/dist/…, so ignored files (keys, data, caches) are indexed and visible to code grep",
          );
        }
        if (data.missing_grammars.length > 0) {
          const total = data.missing_grammars.reduce((n, m) => n + m.files, 0);
          const named = data.missing_grammars
            .map((m) => `${m.langs.join("/")} (${count(m.files, "file")}, ${fmtBytes(m.bytes)})`)
            .join("; ");
          // Ни одного символа И были пропуски — команда не выполнила того, о
          // чём её просили, и говорить «готово» здесь нельзя.
          if (scope.defs === 0) {
            return failure(
              "precond.grammar_missing",
              `no tree-sitter grammars: ${named}. Files skipped: ${total}, ` +
                `symbols in the index: 0. The file registry is built (${scope.files})`,
              ExitCode.PRECOND,
              data.missing_grammars.map((m) => m.fetch).join(" && "),
            );
          }
          ctx.warn(
            "code_index.grammar_missing",
            `skipped ${count(total, "file")} — missing grammars: ${named}. Get them: ` +
              data.missing_grammars.map((m) => m.fetch).join(", "),
          );
        }
        if (scope.l1Files === 0 && data.missing_grammars.length === 0) {
          ctx.warn(
            "code_index.no_l1",
            `no ${L1_LANGS_LABEL} files — no symbols; the file registry is built (${scope.files})`,
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as CodeIndexData;
      const langs = d.langs.map((l) => `${l.lang} ${l.files}`).join(", ");
      const lines = [
        `repo      ${d.repo.length > 0 ? d.repo : "(workspace root)"}  ${d.root}` +
          (d.into !== undefined
            ? `  → its part ${d.into.prefix} of the ${d.into.repo.length > 0 ? `index of ${d.into.repo}` : "workspace-root index"} ${d.into.root}`
            : ""),
        `scan      files ${d.scan.files}, unchanged ${d.scan.unchanged}, touched ${d.scan.touched}, ` +
          `queued ${d.scan.enqueued}, removed ${d.scan.removed}, ` +
          `secret-named skipped ${d.scan.secret_skipped}, worktrees skipped ${d.scan.worktrees_skipped}  ${d.scan.scan_ms} ms` +
          `${d.scan.git_repos.length > 0 ? `  [git: ${count(d.scan.git_repos.length, "repo")}]` : ""}`,
        ...(d.scan.skipped_worktrees.length > 0
          ? [
              `worktrees ${d.scan.skipped_worktrees.map((w) => `${w.dir} → ${w.main}`).join(", ")}  ` +
                `(not indexed: a second copy of a repo already in this index)`,
            ]
          : []),
        `parse     claimed ${d.drain.claimed}, parsed ${d.drain.parsed} (pool ${d.drain.pooled}), ` +
          `written ${d.drain.written}, skipped ${d.drain.skipped}, failed ${d.drain.failed}  ` +
          `${d.drain.drain_ms} ms`,
        ...d.missing_grammars.map(
          (m) =>
            `no grammar  ${m.langs.join("/")}: ${count(m.files, "file")} not parsed ` +
            `(${fmtBytes(m.bytes)}) — \`${m.fetch}\``,
        ),
        `corpus    units ${d.search.units}, files rebuilt ${d.search.rebuilt}, ` +
          `unchanged ${d.search.reused}, removed ${d.search.removed}, text ` +
          `${fmtBytes(d.search.bytes)}  ${d.search.took_ms} ms`,
        `index     ${count(d.files, "file")}, ${count(d.defs, "symbol")}${langs.length > 0 ? `  [${langs}]` : ""}`,
        `${d.dry_run ? "dry-run: nothing written  " : ""}${d.took_ms} ms`,
      ];
      return `${lines.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// myc code symbol — читатель
// ---------------------------------------------------------------------------

interface SymbolData {
  repo: string;
  name: string;
  defs: {
    path: string;
    kind: string;
    lang: string;
    span_start: number;
    span_end: number;
    exported: boolean;
    /** Узлы, чьи якоря пересекают спан этого определения. */
    knowledge: { id: string; kind: string; status: string; title: string; anchor: string; state: string }[];
  }[];
  fan_in?: { n: number; files: number; source: string; cached: boolean; took_ms: number };
  /** Что просмотрено — §6.3: пустой выдачи без причины не бывает. */
  searched: { files: number; l1_files: number; defs: number; langs: string[] };
  took_ms: number;
  /** Чей индекс ответил и где прочитаны файлы — только если не свой индекс вне worktree. */
  source?: SourceData;
}

const SQL_ANCHORS_IN_SPAN = `
SELECT a.node_id AS node_id, a.path AS path, a.span_start AS s, a.span_end AS e, a.state AS state
  FROM anchors a
 WHERE a.repo_id = ?1 AND a.path = ?2 AND a.span_start <= ?4 AND a.span_end >= ?3
 ORDER BY (a.span_end - a.span_start), a.span_start`;

const SQL_ANCHOR_OWNERS = `
SELECT g.src AS id, n.kind AS kind, n.title AS title, n.status AS status
  FROM edges g JOIN nodes n ON n.id = g.src
 WHERE g.dst = ?1 AND g.type = 'touches' AND g.deleted_at IS NULL AND n.deleted_at IS NULL
 ORDER BY n.priority, n.id`;

const SYMBOL_FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id to search (default: derived from cwd)" },
  { name: "no-fan-in", description: "skip the text fan_in count (it reads the L1 corpus)" },
];

function buildCodeSymbol(deps: StoreDeps): Command {
  return {
    name: "symbol",
    summary: "where a symbol is defined and what knowledge is anchored to it: code symbol <name>",
    help:
      "Reads code_defs built by `myc code index`: every definition of <name> in this repo with its " +
      "path, kind and span — and, for each span, the tasks and memories whose anchors fall inside it. " +
      "That last part is the answer no code index alone can give: anchors know file:span, the index " +
      "knows symbol→span, and the overlap turns 'lines 507-644' into 'function drainQueueTail, and " +
      "here is what is known about it'. fan_in is a TEXT count (upper bound, `\\bNAME\\b` over the L1 " +
      "corpus minus the definition lines) and is always labelled with its source; it is computed on " +
      "demand and cached in code_refs until the indexer invalidates it.",
    flags: SYMBOL_FLAGS,
    handler: async (ctx) => {
      const t0 = performance.now();
      const name = ctx.args[0];
      if (name === undefined || name.trim().length === 0) {
        return failure("usage.invalid", "usage: myc code symbol <name>", ExitCode.USAGE);
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const t = await codeTarget(h, flagStr(ctx, "repo"), ctx.globals.directory ?? process.cwd());
        const { repoId, view } = t;
        const { symbolDefs, indexScope, fanIn } = await import("@myc/code-intel/read");
        const { anchorKeysFor } = await import("./anchor.ts");
        const db = h.driver.database;
        const scope = indexScope(db, view);
        if (t.missing || scope.files === 0) {
          return await noIndexFailure(
            h,
            t,
            "nowhere to look for a symbol",
            "the code index of this repo (workspace root) is not built: code_files has zero rows — nowhere to look for a symbol",
          );
        }
        warnWorktree(ctx, t);
        const defs = symbolDefs(db, view, name.trim());
        const anchorsQ = db.query(SQL_ANCHORS_IN_SPAN);
        const ownersQ = db.query(SQL_ANCHOR_OWNERS);
        // Путь определения от корня ВОРКСПЕЙСА — из него оба ключа якоря
        // (`anchorKeysFor`): поставленный из корня и поставленный изнутри
        // вложенного репозитория (или его worktree) видны с обеих сторон.
        const wsPathOf = (p: string): string => {
          const full = view.prefix + p;
          return view.repoId.length === 0 ? full : `${view.repoId}/${full}`;
        };
        const data: SymbolData = {
          repo: repoId,
          name: name.trim(),
          defs: defs.map((d) => {
            const knowledge: SymbolData["defs"][number]["knowledge"] = [];
            type AnchorRow = { node_id: string; path: string; s: number; e: number; state: string };
            const rows: AnchorRow[] = [];
            for (const k of anchorKeysFor(wsPathOf(d.path))) {
              rows.push(...(anchorsQ.all(k.repoId, k.path, d.spanStart, d.spanEnd) as AnchorRow[]));
            }
            // Порядок SQL (самый тесный спан первым) — поверх ОБОИХ ключей;
            // сортировка устойчива, и при одном ключе порядок прежний.
            rows.sort((a, b) => a.e - a.s - (b.e - b.s) || a.s - b.s);
            for (const a of rows) {
              for (const o of ownersQ.all(a.node_id) as Array<{
                id: string;
                kind: string;
                title: string;
                status: string;
              }>) {
                knowledge.push({
                  id: o.id,
                  kind: o.kind,
                  status: o.status,
                  title: o.title,
                  // Путь — в терминах спросившего (тот же файл, что у
                  // определения): якорь, записанный другим ключом, иначе
                  // печатался бы чужим путём.
                  anchor: `${d.path}:${a.s}-${a.e}`,
                  state: a.state,
                });
              }
            }
            return {
              path: d.path,
              kind: d.kind,
              lang: d.lang,
              span_start: d.spanStart,
              span_end: d.spanEnd,
              exported: d.exported,
              knowledge,
            };
          }),
          searched: {
            files: scope.files,
            l1_files: scope.l1Files,
            defs: scope.defs,
            langs: scope.langs.slice(0, 6).map((l) => l.lang),
          },
          took_ms: 0,
        };
        if (defs.length > 0 && !flagBool(ctx, "no-fan-in")) {
          // Счёт — по ОСНОВНОЙ копии, а не по worktree: fan_in — статистика
          // индекса и кешируется в нём (`code_refs`), а кеш общий для всех,
          // кто спрашивает этот индекс, в том числе из основной копии.
          const f = fanIn(db, view, name.trim(), t.repoRoot);
          data.fan_in = {
            n: f.n,
            files: f.files,
            source: f.source,
            cached: f.cached,
            took_ms: Math.round(f.tookMs),
          };
        }
        data.took_ms = Math.round(performance.now() - t0);
        const src = sourceData(t, data.fan_in !== undefined && !data.fan_in.cached ? t.repoRoot : null);
        if (src !== undefined) data.source = src;
        if (defs.length === 0) {
          return failure(
            "notfound.symbol",
            `symbol ${name.trim()} is not in the index: scanned ${count(scope.files, "file")} ` +
              `(${scope.l1Files} with definitions, ${count(scope.defs, "symbol")}), languages ${data.searched.langs.join(", ")}`,
            ExitCode.NOTFOUND,
            scope.l1Files === 0
              ? `the repo has no ${L1_LANGS_LABEL} files — no symbols`
              : "the index may be behind: myc code index",
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as SymbolData;
      const out: string[] = [];
      for (const def of d.defs) {
        const flags = [def.kind, def.lang, def.exported ? "exported" : ""].filter((s) => s.length > 0);
        out.push(`${def.path}:${def.span_start}-${def.span_end}  ${flags.join(" ")}`);
        for (const k of def.knowledge) {
          out.push(`    ${k.id}  ${k.kind}  ${k.status}  ${k.title}  [${k.anchor} ${k.state}]`);
        }
        if (def.knowledge.length === 0) out.push("    no knowledge anchored here");
      }
      if (d.fan_in !== undefined) {
        out.push(
          `fan_in ${d.fan_in.n} (${d.fan_in.source}, ${count(d.fan_in.files, "file")}` +
            `${d.fan_in.cached ? ", from cache" : `, ${d.fan_in.took_ms} ms`})`,
        );
      }
      out.push(
        `scanned ${count(d.searched.files, "file")}, ${count(d.searched.defs, "symbol")}  ${d.took_ms} ms`,
      );
      out.push(...sourceLines(d.source));
      return `${out.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// myc code fetch / myc code grammars — грамматики по требованию
// ---------------------------------------------------------------------------

/**
 * ПОЧЕМУ ОТДЕЛЬНАЯ КОМАНДА, А НЕ `myc models fetch <грамматика>`.
 *
 * Механизм у них общий (url + sha256 + идемпотентный кеш), а НАМЕЧЕННОЕ —
 * разное, и именно намеченное видит человек. `myc models` объявлен как
 * «manage local embedding models», его идентификаторы выглядят как
 * `multilingual-e5-small-q8`, а `models list` печатает размерность вектора,
 * которой у грамматики нет. Всунуть туда `python` значит завести в одной
 * команде два вида сущностей с разными полями — то есть ту самую «одну
 * поверхность, два ответа», которую этот репозиторий ловил шесть раз.
 *
 * Против общей команды `myc fetch <что угодно>` довод тот же и ещё один:
 * грамматика нужна ровно тому, кто зовёт `myc code index`, и отказ этой
 * команды должен называть команду СОСЕДНЮЮ, на расстоянии одного слова, а не
 * из другого раздела справки. `myc code index` -> `myc code fetch` читается
 * без справки вовсе.
 *
 * Общим остаётся МЕХАНИЗМ, и его дублирование — временное: одинаковые по
 * смыслу `packages/embed/src/fetch.ts` и `packages/code-intel/src/grammars.ts`
 * должны сойтись в `@myc/core`. Границы этой задачи в `@myc/core` не пускают,
 * поэтому здесь честная вторая реализация того же контракта, а не
 * притворство, что её нет.
 */

interface FetchData {
  requested: string[];
  fetched: { grammar: string; langs: string[]; bytes: number; ms: number; already: boolean }[];
  dir: string;
  downloaded_bytes: number;
  took_ms: number;
}

const FETCH_FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id to scan for languages (default: from cwd)" },
];

function buildCodeFetch(deps: StoreDeps): Command {
  return {
    name: "fetch",
    summary: "download tree-sitter grammars for this repo's languages (sha256-verified, idempotent)",
    help:
      "Grammars are NOT shipped in the package: all 36 weigh 49MB against a 12MB package, and a " +
      "given repo needs two of them. `myc code fetch` with no arguments walks the repo and " +
      "downloads exactly the grammars its L1 files need; with arguments it takes language ids " +
      `(${L1_LANGS_LABEL}) or grammar names (typescript, tsx, javascript, python). Repeating ` +
      "the call touches no network: an intact file is not re-downloaded. This is the ONLY place " +
      "in the code index that opens a socket — indexing never does (see `myc code index`).",
    flags: FETCH_FLAGS,
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const {
        GRAMMARS,
        GRAMMAR_BY_LANG,
        FetchGrammarError,
        fetchGrammar,
        grammarsCacheDir,
      } = await import("@myc/code-intel/grammars");
      type GName = keyof typeof GRAMMARS;

      const wanted = new Set<GName>();
      const requested: string[] = [];
      for (const raw of ctx.args) {
        const a = raw.trim().toLowerCase();
        if (a.length === 0) continue;
        requested.push(a);
        if (a === "all") {
          for (const g of Object.keys(GRAMMARS) as GName[]) wanted.add(g);
          continue;
        }
        const byLang = (GRAMMAR_BY_LANG as Record<string, GName | undefined>)[a];
        if (byLang !== undefined) {
          wanted.add(byLang);
          continue;
        }
        if (a in GRAMMARS) {
          wanted.add(a as GName);
          continue;
        }
        return failure(
          "usage.invalid",
          `unknown language or grammar "${raw}"; languages: ${Object.keys(GRAMMAR_BY_LANG).join(", ")}; ` +
            `grammars: ${Object.keys(GRAMMARS).join(", ")}`,
          ExitCode.USAGE,
          "myc code fetch      # no arguments: the languages of this repo",
        );
      }

      // Без аргументов — по ЯЗЫКАМ РЕПОЗИТОРИЯ, а не «все 36». Дерево читается
      // напрямую, а не из реестра code_files: файла, чья грамматика не
      // скачана, в реестре нет по построению (см. drainBatch), и спросить у
      // индекса, каких языков ему не хватает, было бы замкнутым кругом.
      if (wanted.size === 0) {
        const opened = await deps.openStore(ctx);
        if (!opened.ok) return opened.failure;
        const h = opened.handle;
        try {
          const { repoRoot } = await codeRepo(h, flagStr(ctx, "repo"));
          const { L1_LANGS, langOf, walkFiles } = await import("@myc/code-intel/langs");
          for (const rel of walkFiles(repoRoot)) {
            const lang = langOf(rel);
            if (!L1_LANGS.has(lang)) continue;
            const g = (GRAMMAR_BY_LANG as Record<string, GName | undefined>)[lang];
            if (g !== undefined) wanted.add(g);
          }
        } finally {
          h.close();
        }
        if (wanted.size === 0) {
          return failure(
            "notfound.lang",
            `this repo has no ${L1_LANGS_LABEL} files — it needs no grammar`,
            ExitCode.NOTFOUND,
            "myc code fetch ts   # for a specific one",
          );
        }
      }

      const showProgress =
        process.stdout.isTTY === true && !ctx.globals.json && !ctx.globals.ndjson && !ctx.globals.quiet;
      const data: FetchData = {
        requested,
        fetched: [],
        dir: grammarsCacheDir(),
        downloaded_bytes: 0,
        took_ms: 0,
      };
      for (const name of [...wanted].sort()) {
        try {
          const r = await fetchGrammar(name, {
            onProgress: showProgress
              ? (p) => {
                  const pct =
                    p.totalBytes !== null
                      ? ` ${Math.min(100, Math.round((p.loadedBytes / p.totalBytes) * 100))}%`
                      : "";
                  process.stdout.write(`\r${p.grammar}${pct} ${fmtBytes(p.loadedBytes)}\x1b[K`);
                }
              : undefined,
          });
          if (showProgress) process.stdout.write("\r\x1b[K");
          data.fetched.push({
            grammar: r.grammar,
            langs: [...GRAMMARS[name].langs],
            bytes: r.bytes,
            ms: Math.round(r.tookMs),
            already: r.alreadyPresent,
          });
          if (!r.alreadyPresent) data.downloaded_bytes += r.bytes;
        } catch (e) {
          if (showProgress) process.stdout.write("\r\x1b[K");
          if (e instanceof FetchGrammarError) {
            return failure(
              FETCH_GRAMMAR_CODE[e.code] ?? "internal.unexpected",
              e.message,
              e.code === "unknown_grammar" ? ExitCode.NOTFOUND : ExitCode.ERR,
              e.code === "network_error"
                ? "needs access to cdn.jsdelivr.net; on an air-gapped network put the .wasm files in MYC_GRAMMARS_DIR"
                : undefined,
            );
          }
          throw e;
        }
      }
      data.took_ms = Math.round(performance.now() - t0);
      return { ok: true, data, meta: { took_ms: data.took_ms } };
    },
    renderHuman: (data) => {
      const d = data as FetchData;
      const lines = d.fetched.map(
        (f) =>
          `${f.already ? "present " : "fetched "}${f.grammar} (${f.langs.join("/")})  ` +
          `${fmtBytes(f.bytes)}  ${f.ms} ms`,
      );
      lines.push(
        `dir     ${d.dir}`,
        `${d.downloaded_bytes > 0 ? `downloaded ${fmtBytes(d.downloaded_bytes)}  ` : "no network used  "}${d.took_ms} ms`,
      );
      return `${lines.join("\n")}\n`;
    },
  };
}

/** Коды отказа загрузки — отражение FetchGrammarErrorCode в словарь myc. */
const FETCH_GRAMMAR_CODE: Record<string, string> = {
  checksum_mismatch: "internal.checksum_mismatch",
  network_error: "internal.network",
  http_error: "internal.http",
  fs_error: "internal.fs",
  unknown_grammar: "notfound.grammar",
};

interface GrammarsData {
  runtime: { file: string; path: string | null; status: string };
  grammars: { grammar: string; langs: string[]; status: string; size: string; path: string | null }[];
  cache_dir: string;
  search_path: string[];
}

function buildCodeGrammars(): Command {
  return {
    name: "grammars",
    summary: "which tree-sitter grammars are staged locally, and where",
    help:
      "Reports the runtime (tree-sitter.wasm, shipped inside the package) and every grammar in the " +
      "catalogue: present, corrupt (on disk but the bytes disagree with the pinned sha256) or " +
      "absent. corrupt is not absent — a half-written file has to name itself rather than look " +
      "like something nobody downloaded yet.",
    handler: async (): Promise<CommandResult> => {
      const { RUNTIME_WASM, findRuntime, formatBytes, grammarSearchPath, grammarStates, grammarsCacheDir } =
        await import("@myc/code-intel/grammars");
      const runtimePath = findRuntime();
      const states = await grammarStates();
      const data: GrammarsData = {
        runtime: {
          file: RUNTIME_WASM,
          path: runtimePath,
          status: runtimePath === null ? "absent" : "present",
        },
        grammars: states.map((g) => ({
          grammar: g.grammar,
          langs: [...g.langs],
          status: g.status,
          size: formatBytes(g.bytes),
          path: g.path,
        })),
        cache_dir: grammarsCacheDir(),
        search_path: grammarSearchPath(),
      };
      return { ok: true, data, meta: { count: data.grammars.length } };
    },
    renderHuman: (data) => {
      const d = data as GrammarsData;
      const out = [`runtime   ${d.runtime.file}  ${d.runtime.status}  ${d.runtime.path ?? "-"}`];
      for (const g of d.grammars) {
        out.push(
          `${g.status.padEnd(8)}  ${g.grammar.padEnd(11)} ${g.langs.join("/").padEnd(7)} ${g.size.padStart(9)}  ${g.path ?? "-"}`,
        );
      }
      out.push(`cache     ${d.cache_dir}`);
      const absent = d.grammars.filter((g) => g.status !== "present");
      if (absent.length > 0) {
        out.push(`get       myc code fetch ${absent.map((g) => g.langs[0]).join(" ")}`);
      }
      return `${out.join("\n")}\n`;
    },
  };
}


// ---------------------------------------------------------------------------
// myc code search — ранжированный поиск по коду
// ---------------------------------------------------------------------------

interface SearchData {
  repo: string;
  query: string;
  hits: {
    path: string;
    lang: string;
    score: number;
    header: boolean;
    /** Из чего сложился score: вклад шапки, остальное — сумма по единицам. */
    header_score: number;
    units: { name: string; kind: string; line: number; end: number }[];
  }[];
  stages: string[];
  searched: { units: number; files: number };
  took_ms: number;
  source?: SourceData;
}

const SEARCH_FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id to search (default: derived from cwd)" },
  { name: "limit", value: "number", description: "files to return (default 10)" },
  { name: "symbols", value: "number", description: "matched symbols per file (default 8)" },
];

function buildCodeSearch(deps: StoreDeps): Command {
  return {
    name: "search",
    summary: "ranked search over the code by meaning of the question: code search <question>",
    help:
      "Answers the question `code symbol` could not: it does not need the NAME. Ranks a corpus of " +
      "definitions and file headers (built by `myc code index`) and returns FILES with the symbols " +
      "that matched inside them, so the answer stays path:line. LEXICAL, not semantic — there is " +
      "no vector here and it will not be called one: the query ladder is the same one memory uses " +
      "(S44), and stages are fused by RRF instead of first-wins because on a code corpus one " +
      "accidental strict hit would otherwise shut the door on the real answer (measured: MRR 0.43 " +
      "vs 0.66 on bench/code-search-queries.json). For an EXHAUSTIVE answer over a literal — every " +
      "occurrence, not the best ones — use `myc code grep`.",
    flags: SEARCH_FLAGS,
    handler: async (ctx) => {
      const query = ctx.args.join(" ").trim();
      if (query.length === 0) {
        return failure("usage.invalid", "usage: myc code search <question>", ExitCode.USAGE);
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const t = await codeTarget(h, flagStr(ctx, "repo"), ctx.globals.directory ?? process.cwd());
        const { repoId } = t;
        if (t.missing) {
          return await noIndexFailure(
            h,
            t,
            "the code search corpus is empty",
            "the code search corpus is empty: code_units has zero units for repo (workspace root)",
          );
        }
        warnWorktree(ctx, t);
        const { searchCode } = await import("@myc/code-intel/search");
        const limit = flagNum(ctx, "limit");
        const symbols = flagNum(ctx, "symbols");
        const res = searchCode(h.driver.database, t.view, query, {
          ...(limit !== undefined && limit > 0 ? { limit: Math.floor(limit) } : {}),
          ...(symbols !== undefined && symbols > 0 ? { unitsPerFile: Math.floor(symbols) } : {}),
        });
        if (res.searched.units === 0) {
          return failure(
            "precond.no_index",
            `the code search corpus is empty: code_units has zero units for repo ` +
              `${repoId.length > 0 ? repoId : "(workspace root)"}`,
            ExitCode.PRECOND,
            "myc code index",
          );
        }
        const data: SearchData = {
          repo: repoId,
          query,
          hits: res.hits.map((hit) => ({
            path: hit.path,
            lang: hit.lang,
            score: Number(hit.score.toFixed(4)),
            header: hit.headerMatched,
            header_score: Number(hit.headerScore.toFixed(4)),
            units: hit.units.map((u) => ({
              name: u.name,
              kind: u.kind,
              line: u.spanStart,
              end: u.spanEnd,
            })),
          })),
          stages: [...res.stages],
          searched: { units: res.searched.units, files: res.searched.files },
          took_ms: Math.round(res.tookMs),
        };
        const src = sourceData(t, null);
        if (src !== undefined) data.source = src;
        if (data.hits.length === 0) {
          // §6.3: пустой выдачи без причины не бывает. Что просмотрено —
          // обязано приехать вместе с пустотой, иначе она неотличима от сбоя.
          ctx.warn(
            "code_search.empty",
            `no stage found anything: scanned ${count(data.searched.units, "unit")} ` +
              `in ${count(data.searched.files, "file")}. Exhaustive fallback: myc code grep <literal>`,
          );
        }
        return { ok: true, data, meta: { count: data.hits.length, took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as SearchData;
      const out: string[] = [];
      for (const hit of d.hits) {
        const head = hit.header ? "  [file header]" : "";
        out.push(`${hit.score.toFixed(4)}  ${hit.path}${head}`);
        for (const u of hit.units) {
          out.push(`          ${hit.path}:${u.line}-${u.end}  ${u.kind} ${u.name}`);
        }
      }
      out.push(
        `${count(d.hits.length, "file")} · stages ${d.stages.length > 0 ? d.stages.join(">") : "—"} · ` +
          `scanned ${count(d.searched.units, "unit")} in ${count(d.searched.files, "file")} · ${d.took_ms} ms`,
      );
      out.push(...sourceLines(d.source));
      return `${out.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// myc code grep — исчерпывающий поиск литерала
// ---------------------------------------------------------------------------

interface GrepData {
  repo: string;
  literal: string;
  /** Область, к которой ответ сужен (`--in`); null — весь репозиторий. */
  scope: string[] | null;
  groups: {
    path: string;
    symbol: string;
    kind: string;
    span_start: number;
    span_end: number;
    hits: { line: number; text: string; count: number }[];
  }[];
  hits: number;
  files: number;
  searched: number;
  skipped: { path: string; bytes: number }[];
  /** Бинарных файлов пропущено (NUL в начале) — в `searched` не входят. */
  binary: number;
  missing: number;
  truncated: boolean;
  took_ms: number;
  /** Из worktree: файлов, прочитанных из основной копии, потому что в worktree их нет. */
  from_main?: number;
  source?: SourceData;
}

const GREP_FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id to search (default: derived from cwd)" },
  { name: "ignore-case", description: "case-insensitive match" },
  { name: "lang", value: "string", description: "limit to these languages, comma-separated (ts,py,md)" },
  {
    name: "in",
    value: "string",
    description: "only under these paths from the repo root, comma-separated (dirs or files)",
  },
  { name: "limit", value: "number", description: "symbol groups to print (default 60); the count is always exhaustive" },
];

/**
 * Отказ разбора `--in` → код выхода: нет пути или файлов под ним — NOTFOUND,
 * файл с секретным именем — DENIED, остальное — USAGE.
 */
const GREP_SCOPE_EXIT: Readonly<Record<string, ExitCode>> = {
  "usage.invalid": ExitCode.USAGE,
  "usage.outside_repo": ExitCode.USAGE,
  "notfound.path": ExitCode.NOTFOUND,
  "notfound.scope": ExitCode.NOTFOUND,
  "denied.secret": ExitCode.DENIED,
};

function buildCodeGrep(deps: StoreDeps): Command {
  return {
    name: "grep",
    summary: "every occurrence of a literal, with its place and its owner: code grep <literal>",
    help:
      "The exhaustive fallback the ranked search deliberately is not. Reads the FILES, not the " +
      "index — so a string constant, a piece of SQL, a config key, anything the parser never " +
      "turned into a symbol is found too, and the answer cannot lag behind the code. The index " +
      "supplies exactly two things: the file list (the same directory exclusions indexing uses) " +
      "and the enclosing definition of every hit, which is what turns `grep -n` into 'here is what " +
      "you will have to edit'. Files above 2 MB are skipped and NAMED; binary files (a NUL in the " +
      "first 8000 bytes, the git rule) are skipped and COUNTED; nothing is dropped silently. " +
      "`--in` narrows the search to paths from the repo root — the same paths the output prints — " +
      "and the answer names the scope; a path that does not exist, lies outside the repo or has no " +
      "indexed files under it is refused, not answered with zero hits. Secret-named files (.env, " +
      "keys, credentials) are never read: `--in` to one is refused with denied.secret.",
    flags: GREP_FLAGS,
    handler: async (ctx) => {
      const literal = ctx.args.join(" ");
      if (literal.length === 0) {
        return failure("usage.invalid", "usage: myc code grep <literal>", ExitCode.USAGE);
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const t = await codeTarget(h, flagStr(ctx, "repo"), ctx.globals.directory ?? process.cwd());
        const { repoId, view } = t;
        const { grepCode, resolveGrepScope } = await import("@myc/code-intel/grep");
        const { indexScope } = await import("@myc/code-intel/read");
        const db = h.driver.database;
        const scope = indexScope(db, view);
        if (t.missing || scope.files === 0) {
          return await noIndexFailure(
            h,
            t,
            "nothing to grep",
            "this repo has no file registry: code_files has zero rows — nothing to grep",
          );
        }
        warnWorktree(ctx, t, "occurrences and line numbers are read from the worktree files, their owners from the index");
        // `--in` через запятую, как `--lang`. Повтор флага разбор argv
        // схлопывает в последнее значение ещё до обработчика — поэтому
        // несколько областей пишутся одним флагом.
        const inRaw = flagStr(ctx, "in");
        const inScope =
          inRaw === undefined
            ? undefined
            : resolveGrepScope(db, view, t.fileRoot, inRaw.split(","), ctx.globals.directory ?? process.cwd());
        if (inScope !== undefined && !inScope.ok) {
          return failure(inScope.code, inScope.msg, GREP_SCOPE_EXIT[inScope.code] ?? ExitCode.USAGE, inScope.hint);
        }
        const langsRaw = flagStr(ctx, "lang");
        const limit = flagNum(ctx, "limit");
        // Файлы — там, где стоит агент (`fileRoot`, в worktree — его копия),
        // перечень и владельцы — из индекса вида.
        const res = grepCode(db, view, t.fileRoot, literal, {
          ...(t.fallbackRoot !== undefined ? { fallbackRoot: t.fallbackRoot } : {}),
          ignoreCase: flagBool(ctx, "ignore-case"),
          ...(langsRaw !== undefined
            ? { langs: langsRaw.split(",").map((x) => x.trim()).filter((x) => x.length > 0) }
            : {}),
          ...(inScope !== undefined ? { scopes: inScope.scopes } : {}),
          ...(limit !== undefined && limit > 0 ? { limit: Math.floor(limit) } : {}),
        });
        const data: GrepData = {
          repo: repoId,
          literal: res.literal,
          scope: res.scope === null ? null : [...res.scope],
          groups: res.groups.map((g) => ({
            path: g.path,
            symbol: g.symbol,
            kind: g.kind,
            span_start: g.spanStart,
            span_end: g.spanEnd,
            hits: g.hits.map((x) => ({ line: x.line, text: x.text, count: x.count })),
          })),
          hits: res.hits,
          files: res.files,
          searched: res.searched,
          skipped: res.skipped.map((x) => ({ path: x.path, bytes: x.bytes })),
          binary: res.binary,
          missing: res.missing,
          truncated: res.truncated,
          took_ms: Math.round(res.tookMs),
        };
        if (t.worktree !== undefined) data.from_main = res.fallback;
        const src = sourceData(t);
        if (src !== undefined) data.source = src;
        if (res.fallback > 0) {
          ctx.warn(
            "code_grep.from_main",
            `${count(res.fallback, "indexed file")} not in the worktree ${t.worktree?.dir ?? t.fileRoot} ` +
              `(deleted or never checked out on this branch) — read from the main copy ${t.fallbackRoot}`,
          );
        }
        if (data.skipped.length > 0) {
          ctx.warn(
            "code_grep.skipped",
            `files skipped by the size cap: ${data.skipped.length} — ` +
              data.skipped
                .slice(0, 4)
                .map((x) => `${x.path} (${fmtBytes(x.bytes)})`)
                .join(", "),
          );
        }
        if (data.missing > 0) {
          ctx.warn(
            "code_grep.missing",
            `indexed files missing on disk: ${data.missing} — the index is behind, myc code index`,
          );
        }
        if (data.truncated) {
          ctx.warn(
            "code_grep.truncated",
            `more groups than the cap: shown ${data.groups.length}, occurrences in total ${data.hits} — --limit`,
          );
        }
        return { ok: true, data, meta: { count: data.hits, took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as GrepData;
      const where = d.scope === null ? "" : ` in ${d.scope.join(", ")}`;
      const binary = d.binary > 0 ? `, binary skipped ${d.binary}` : "";
      const out = [
        `"${d.literal}"${where} — ${count(d.hits, "occurrence")} in ${count(d.groups.length, "symbol")}, ` +
          `files ${d.files} (scanned ${d.searched}${binary})`,
      ];
      for (const g of d.groups) {
        out.push("");
        out.push(
          g.symbol.length > 0
            ? `${g.symbol} · ${g.kind} · ${g.path}:${g.span_start}-${g.span_end}`
            : `${g.path} (file top level)`,
        );
        for (const hit of g.hits) out.push(`  ${hit.line}: ${hit.text}`);
      }
      out.push("");
      out.push(`${d.took_ms} ms`);
      out.push(...sourceLines(d.source));
      return `${out.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// myc code map — карта репозитория
// ---------------------------------------------------------------------------

interface MapData {
  repo: string;
  files: number;
  defs: number;
  refs: number;
  imports: number;
  dirs: number;
  langs: { lang: string; files: number }[];
  clusters: {
    dir: string;
    files: number;
    defs: number;
    hubs: { name: string; path: string; refs: number }[];
    used_by: { dir: string; refs: number }[];
  }[];
  ambiguous_edges: number;
  cross_edges: number;
  /** Знаков в человекочитаемой выдаче — бюджет контекста, названный числом. */
  render_bytes: number;
  took_ms: number;
  source?: SourceData;
}

const MAP_FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id to map (default: derived from cwd)" },
  { name: "top", value: "number", description: "directories to show (default 14)" },
  { name: "hubs", value: "number", description: "hub symbols per directory (default 3)" },
  { name: "links", value: "number", description: "dependent directories per directory (default 3)" },
  { name: "depth", value: "number", description: "path segments per cluster (default 3: packages/x/src)" },
];

function renderMap(d: MapData): string {
  const langs = d.langs
    .slice(0, 6)
    .map((l) => `${l.lang} ${l.files}`)
    .join(", ");
  const out = [
    `${d.repo.length > 0 ? d.repo : "(workspace root)"}  ${count(d.files, "file")} · ${count(d.defs, "symbol")} · ` +
      `${count(d.refs, "reference")} (${count(d.imports, "import")}) · ${count(d.dirs, "directory", "directories")}`,
    `languages ${langs}`,
    "",
  ];
  for (const c of d.clusters) {
    out.push(`${c.dir}  ${count(c.files, "file")}, ${count(c.defs, "symbol")}`);
    if (c.hubs.length > 0) {
      out.push(`  hubs    ${c.hubs.map((x) => `${x.name} (${x.refs})`).join(", ")}`);
    }
    if (c.used_by.length > 0) {
      out.push(`  used by ${c.used_by.map((x) => `${x.dir} (${x.refs})`).join(", ")}`);
    }
  }
  out.push("");
  out.push(
    `edges     ${d.cross_edges} cross-directory via import; ${d.ambiguous_edges} dropped — ` +
      `the name is defined more than once in the repo`,
  );
  out.push(...sourceLines(d.source));
  return `${out.join("\n")}\n`;
}

function buildCodeMap(deps: StoreDeps): Command {
  return {
    name: "map",
    summary: "orientation in this repo: directory clusters, their hubs and who depends on them",
    help:
      "For someone who is seeing this tree for the first time. Three layers: totals, directory " +
      "clusters ordered by weight with their HUB symbols, and coupling — which directories import " +
      "from which. Costs no storage at all: it is an aggregate over code_files/code_defs/" +
      "code_ref_sites, which already exist for `callers`. Edges are counted from `import` " +
      "occurrences ONLY, and that is a measurement: over all occurrence kinds the top hubs of this " +
      "repo come out as `id(2050) d(1047) path(588)` — loop counters, not subsystems. A name " +
      "defined more than once in the repo is dropped from the edges and the drop is counted. The " +
      "last line names how many characters the answer weighed: a map that does not fit the context " +
      "budget is not a map.",
    flags: MAP_FLAGS,
    handler: async (ctx) => {
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const t = await codeTarget(h, flagStr(ctx, "repo"), ctx.globals.directory ?? process.cwd());
        const mapMsg = "this repo has no file registry: code_files has zero rows — nothing to build the map from";
        if (t.missing) return await noIndexFailure(h, t, "nothing to build the map from", mapMsg);
        warnWorktree(ctx, t);
        const { repoMap } = await import("@myc/code-intel/map");
        const num = (name: string): number | undefined => {
          const v = flagNum(ctx, name);
          return v !== undefined && v >= 0 ? Math.floor(v) : undefined;
        };
        const top = num("top");
        const hubs = num("hubs");
        const links = num("links");
        const depth = num("depth");
        const m = repoMap(h.driver.database, t.view, {
          ...(top !== undefined ? { top } : {}),
          ...(hubs !== undefined ? { hubs } : {}),
          ...(links !== undefined ? { links } : {}),
          ...(depth !== undefined ? { depth } : {}),
        });
        if (m.files === 0) return await noIndexFailure(h, t, "nothing to build the map from", mapMsg);
        const data: MapData = {
          // Репозиторий ВОПРОСА: у части индекса корня `m.repo` — это корень.
          repo: t.repoId,
          files: m.files,
          defs: m.defs,
          refs: m.refs,
          imports: m.imports,
          dirs: m.dirs,
          langs: m.langs.map((l) => ({ lang: l.lang, files: l.files })),
          clusters: m.clusters.map((c) => ({
            dir: c.dir,
            files: c.files,
            defs: c.defs,
            hubs: c.hubs.map((x) => ({ name: x.name, path: x.path, refs: x.refs })),
            used_by: c.usedBy.map((x) => ({ dir: x.dir, refs: x.refs })),
          })),
          ambiguous_edges: m.ambiguousEdges,
          cross_edges: m.crossEdges,
          render_bytes: 0,
          took_ms: Math.round(m.tookMs),
        };
        const src = sourceData(t, null);
        if (src !== undefined) data.source = src;
        data.render_bytes = Buffer.byteLength(renderMap(data), "utf8");
        if (m.defs === 0) {
          ctx.warn(
            "code_map.no_defs",
            `the index has no symbols — the map shows files only: no hubs or edges`,
          );
        }
        return { ok: true, data, meta: { count: data.clusters.length, took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as MapData;
      return `${renderMap(d)}map       ${count(d.render_bytes, "char")} · ${d.took_ms} ms\n`;
    },
  };
}

export function createCodeCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "code",
    summary:
      "built-in code index: build it (code index), ask it (code search, code grep, code map, code symbol), stage grammars (code fetch)",
    subcommands: [
      buildCodeIndex(deps),
      buildCodeSymbol(deps),
      buildCodeSearch(deps),
      buildCodeGrep(deps),
      buildCodeMap(deps),
      buildCodeFetch(deps),
      buildCodeGrammars(),
    ],
  };
}
