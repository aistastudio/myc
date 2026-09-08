/**
 * Поиск воркспейса на диске — и БОЛЬШЕ НИЧЕГО.
 *
 * Отдельный модуль не ради опрятности, а ради цены. Эти четыре функции жили в
 * `store.ts`, а тот тянет @myc/core, @myc/store-sqlite и bun:sqlite: в
 * собранном бинаре один только его импорт стоит ~9 мс. Хуку post-edit
 * (`myc anchor touch`) нужен из всего этого один подъём к каталогу `.myc`, а
 * платил бы он за граф модулей целиком — на КАЖДУЮ правку агента, сотни раз
 * за сессию. Замер до и после разделения — в шапке `buildAnchorTouch`.
 *
 * Правило модуля: сюда можно импортировать только `node:*`. Первый же импорт
 * из @myc/* вернёт ту самую цену обратно и молча.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

/** ~/.myc по умолчанию; MYC_HOME — явный override (тесты, контейнеры, S41). */
export function personalHome(): string {
  return process.env.MYC_HOME ?? homedir();
}

/**
 * Репозиторий экосистемы (S59) — каталог со СВОИМ `.git`. Файл `.git`
 * (submodule, worktree) считается наравне с каталогом: это тот же
 * самостоятельный репозиторий, просто с вынесенным служебным каталогом.
 */
export function isRepoDir(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Корень воркспейса по пути к базе — для явного `--db`, который поиск
 * каталога обходит. `<dir>/.myc/myc.db` даёт `<dir>`; любой другой путь
 * (тесты и бенчи открывают базу файлом где угодно) корня НЕ даёт, и охват
 * репозитория честно остаётся неопределённым вместо выдуманного общего.
 */
export function workspaceDirOfDb(dbPath: string): string | undefined {
  const mycDir = dirname(resolve(dbPath));
  if (mycDir.split("/").pop() !== ".myc") return undefined;
  return dirname(mycDir);
}

// ---------------------------------------------------------------------------
// git worktree (memory-6amwnpb7tbat)
// ---------------------------------------------------------------------------
//
// ПОЧЕМУ ЭТО ВООБЩЕ ЗДЕСЬ. Очередь и память — про ПРОЕКТ, а не про ветку:
// задача «починить поиск» не перестаёт существовать оттого, что её начали
// делать в отдельной ветке, и claim на неё обязан быть виден из любого
// checkout'а того же репозитория. Отдельный воркспейс на каждый worktree
// сделал бы claim бессмысленным (два агента на двух ветках не увидели бы
// друг друга) и расколол бы граф памяти надвое. Поэтому все worktree одного
// репозитория обслуживает ОДИН воркспейс основного дерева.
//
// ПОЧЕМУ ПОДЪЁМ ВВЕРХ ЭТОГО НЕ НАХОДИТ. Worktree — каталог-СОСЕД основного
// дерева (`git worktree add ../wt-feature`), а не вложенный в него. Подъём по
// родителям (R1) идёт вверх и до соседа не доходит никогда, сколько бы
// уровней ни прошёл. Связь между ними существует только в git — и её надо
// прочитать.
//
// ПОЧЕМУ ФАЙЛ, А НЕ `git rev-parse --git-common-dir`. Поиск воркспейса
// делается на КАЖДЫЙ запуск команды, а холодный старт целиком стоит 24 мс
// при потолке 60 (И1). Замер на этой машине, 60 вызовов:
//   git rev-parse --git-common-dir (подпроцесс)  p50 12.141  p99 14.665 мс
//   чтение файла .git + commondir                p50  0.019  p99  0.031 мс
// Подпроцесс — 12 мс, половина всего холодного старта и в 640 раз дороже
// двух read(). git читает ровно те же два файла; звать его незачем.

/** Связь worktree → основное дерево, разобранная из файлов, без вызова git. */
export interface WorktreeLink {
  /** Каталог worktree — тот, в котором лежит ФАЙЛ `.git`. */
  readonly worktreeDir: string;
  /** Служебный каталог этого worktree: `<основное>/.git/worktrees/<имя>`. */
  readonly gitDir: string;
  /** Корень основного дерева — каталог над общим `.git`. */
  readonly mainRoot: string;
}

/**
 * Разбор `<dir>/.git`, если это ФАЙЛ. Отдаёт ссылку только для worktree.
 *
 * Общий `.git` берётся из файла `commondir` внутри служебного каталога, а НЕ
 * выводится из формы пути `.../worktrees/<имя>`: worktree можно перенести
 * (`git worktree repair` переписывает именно `commondir`), и тогда путь врёт,
 * а `commondir` — нет. Это же условие отделяет worktree от submodule: у того
 * `.git` тоже файл и тоже ведёт в чужой каталог (`.git/modules/<имя>`), но
 * `commondir` в нём нет — submodule самостоятельный репозиторий, никакого
 * «основного дерева» у него не бывает.
 */
export function readWorktreeLink(dir: string): WorktreeLink | undefined {
  const dotGit = join(dir, ".git");
  try {
    if (!statSync(dotGit).isFile()) return undefined; // обычный репозиторий
  } catch {
    return undefined; // .git нет вовсе
  }
  let gitDir: string;
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (m === null) return undefined;
    gitDir = resolve(dir, m[1]!);
  } catch {
    return undefined; // нечитаемый .git — не наше дело чинить git
  }
  let commonDir: string;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    // Служебного каталога нет вовсе — основное дерево унесли ВМЕСТЕ с ним.
    // Ровно ради этого случая и нужна форма пути `<общий>/worktrees/<имя>`:
    // прочитать уже нечего, а причину отказа назвать обязаны.
    //
    // Требуются ОБА сегмента, и это не перестраховка: у submodule путь
    // `<общий>/.git/modules/<имя>`, и одной проверки «над ним лежит .git»
    // ему хватало бы — на нём и попался этот код (fixture repo.test.ts:75
    // пишет ровно такой `.git` без самого каталога modules).
    if (basename(dirname(gitDir)) !== "worktrees") return undefined;
    commonDir = dirname(dirname(gitDir));
    if (basename(commonDir) !== ".git") return undefined;
  }
  return { worktreeDir: resolve(dir), gitDir, mainRoot: dirname(commonDir) };
}

/** Почему основное дерево worktree не дало воркспейса. */
export type WorktreeMiss =
  /** Каталога основного дерева нет: его перенесли или удалили. */
  | "main-missing"
  /** Основное дерево на месте, но воркспейса нет и там. */
  | "main-no-workspace";

export interface WorkspaceFound {
  readonly dbPath: string;
  readonly wsDir: string;
  /** Непусто, если воркспейс нашёлся через основное дерево worktree. */
  readonly worktree?: WorktreeLink;
}

export interface WorkspaceNotFound {
  readonly searched: readonly string[];
  /** Непусто, если старт был внутри worktree: причина обязана быть названа. */
  readonly worktree?: WorktreeLink;
  readonly worktreeMiss?: WorktreeMiss;
}

/**
 * Один подъём по родителям: список проверенных путей и первый найденный.
 * Домашний каталог САМ проверяется, только если это стартовый каталог; при
 * подъёме СНИЗУ он из проверки исключается — иначе личный ярус молча подменил
 * бы проектный.
 */
function climb(startDir: string): {
  readonly hit: { readonly dbPath: string; readonly wsDir: string } | undefined;
  readonly searched: readonly string[];
  readonly dirs: readonly string[];
} {
  const boundary = resolve(personalHome());
  const searched: string[] = [];
  const dirs: string[] = [];
  let dir = resolve(startDir);
  let climbed = false;
  for (;;) {
    if (climbed && dir === boundary) break;
    dirs.push(dir);
    const dbPath = join(dir, ".myc", "myc.db");
    searched.push(dbPath);
    if (existsSync(dbPath)) return { hit: { dbPath, wsDir: dir }, searched, dirs };
    const parent = dirname(dir);
    if (parent === dir) break; // корень ФС — дальше подниматься некуда
    dir = parent;
    climbed = true;
  }
  return { hit: undefined, searched, dirs };
}

/**
 * Подъём от стартового каталога к первому `.myc/myc.db`, а если его нет —
 * тот же подъём в основном дереве, когда стартовали внутри git worktree.
 *
 * ПОРЯДОК ИМЕННО ТАКОЙ. Подъём по каталогам (R1) идёт первым и не меняется
 * ни на байт: git тут не обязателен, воркспейс живёт и вне репозитория, и
 * старое поведение обязано остаться прежним. Переход по ссылке worktree —
 * ТОЛЬКО ветка отказа: на успешном пути (а это все запуски в обычном
 * репозитории) не появляется ни одного лишнего системного вызова.
 *
 * Внутри основного дерева поиск начинается не с его корня, а с ТОГО ЖЕ
 * относительного места: worktree — это тот же самый рабочий каталог на другой
 * ветке, и `packages/cli` в нём соответствует `packages/cli` в основном.
 * Для одиночного воркспейса в корне разницы нет, для экосистемы (S59) есть.
 */
export function findWorkspaceDb(startDir: string): WorkspaceFound | WorkspaceNotFound {
  const local = climb(startDir);
  if (local.hit !== undefined) return local.hit;

  const link = firstWorktreeLink(local.dirs);
  if (link !== undefined) {
    if (!existsSync(link.mainRoot)) {
      return { searched: local.searched, worktree: link, worktreeMiss: "main-missing" };
    }
    const inMain = climb(mapIntoMain(link, resolve(startDir)));
    if (inMain.hit !== undefined) return { ...inMain.hit, worktree: link };
    return {
      searched: [...local.searched, ...inMain.searched],
      worktree: link,
      worktreeMiss: "main-no-workspace",
    };
  }
  return { searched: local.searched };
}

/** Первая ссылка worktree по списку каталогов снизу вверх. */
function firstWorktreeLink(dirs: readonly string[]): WorktreeLink | undefined {
  for (const dir of dirs) {
    const link = readWorktreeLink(dir);
    if (link !== undefined) return link;
  }
  return undefined;
}

/**
 * «Мы внутри git worktree?» — ближайший вверх каталог с файлом `.git`.
 *
 * Отдельно от поиска воркспейса, потому что нужна `myc init`: там ответ надо
 * знать ДО создания чего бы то ни было. Именно чтением файлов, а не через
 * `git rev-parse`: у сломанного worktree (основное дерево унесли) git падает
 * и не отвечает вовсе — а это ровно тот случай, когда init обязан отказать, а
 * не завести второй воркспейс в ветке.
 */
export function findWorktreeLink(startDir: string): WorktreeLink | undefined {
  return firstWorktreeLink(climb(startDir).dirs);
}

/**
 * Тот же путь, но в основном дереве: `<worktree>/packages/cli` →
 * `<основное>/packages/cli`. Путь вне worktree отдаётся как есть.
 *
 * Нужно двум местам сразу — поиску воркспейса и выводу охвата репозитория
 * (S59). Охват выводится из пути ОТНОСИТЕЛЬНО корня воркспейса, а путь внутри
 * worktree лежит вне этого корня; без пересчёта охват уехал бы в
 * `outside-workspace`, и узлы, заведённые из worktree, стали бы невидимы из
 * основного дерева — то есть раскол графа вернулся бы с другой стороны.
 */
export function mapIntoMain(link: WorktreeLink, path: string): string {
  return remap(link.worktreeDir, link.mainRoot, path);
}

/**
 * Обратное отображение: путь основного дерева → тот же файл В ЭТОМ worktree.
 *
 * Нужно там, где путь и содержимое расходятся: якорь ЗАПИСЫВАЕТСЯ логическим
 * путём репозитория (общим для всех веток), а ЧИТАЕТСЯ файл, который агент
 * прямо сейчас правит, — а он лежит в worktree и на другой ветке отличается.
 */
export function mapIntoWorktree(link: WorktreeLink, path: string): string {
  return remap(link.mainRoot, link.worktreeDir, path);
}

/** Путь под `from` — тот же путь под `to`; всё остальное как есть. */
function remap(from: string, to: string, path: string): string {
  const rest = relative(from, resolve(path));
  if (rest.startsWith("..") || rest.startsWith("/")) return resolve(path);
  return rest.length === 0 ? to : join(to, rest);
}
