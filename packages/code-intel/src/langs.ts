/**
 * Языки, перечень файлов и обход дерева — общее для индекса (`code_index.ts`)
 * и для выбора реализации (`select.ts`).
 *
 * Вынесено из `code_index.ts` не ради красоты: `select.ts` зовёт `init`, а
 * `code_index.ts` тянет за собой `@myc/store-sqlite` и разбор определений.
 * Платить этим графом модулей за одну строку отчёта `init` нельзя (И1,
 * холодный старт), а знать «есть ли в этом дереве L1-файлы» ему
 * обязательно — иначе строка обещает символы репозиторию, в котором их не
 * будет никогда (§5, уровень L0).
 */

import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { isSecretName, isSecretPath } from "./secret-paths.ts";

/**
 * Языки уровня L1 (§5): определения разбираются только для них.
 *
 * СПИСОК ЖИВЁТ ЗДЕСЬ, А НЕ В `symbols.ts`, и именно из-за И1: `symbols.ts`
 * тянет `web-tree-sitter`, а этот модуль обязан оставаться дешёвым — его
 * грузит `select.ts` ради одной строки отчёта `init`. Обратной ссылки тоже
 * нет: `symbols.ts` импортирует список ОТСЮДА, а `symbols.test.ts` проверяет,
 * что таблица грамматик покрывает его ровно, без лишних и недостающих. Так
 * два места не разойдутся молча, и ни одно не платит за другое.
 *
 * `py` появился здесь вместе с переходом на tree-sitter: своего парсера
 * python у нас не было и быть не могло, а грамматика есть.
 */
export const L1_LANGS: ReadonlySet<string> = new Set(["ts", "tsx", "js", "jsx", "py"]);

/** Человекочитаемый список L1 для строк отчёта — один на весь продукт. */
export const L1_LANGS_LABEL: string = [...L1_LANGS].join("/");

export const LANG_BY_EXT: ReadonlyMap<string, string> = new Map([
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".jsx", "jsx"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".py", "py"],
]);

/**
 * Каталоги, в которые индекс не входит никогда.
 *
 * `.myc` здесь по той же причине, что `node_modules`: это состояние самого
 * myc, а не код репозитория, и в нём лежит база воркспейса — на этом
 * репозитории 41 МБ, которые скан читал бы и хешировал при каждом прогоне
 * ради строки реестра, меняющейся от любой записи в очередь.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".myc",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);

/**
 * Язык файла: L1-идентификатор или расширение без точки (L0).
 *
 * Расширение берётся только из ИМЕНИ файла. Раньше точка искалась по всему
 * пути, и файл без расширения под каталогом с точкой (`.dolt/noms/vvvv…`)
 * получал «язык» `dolt/noms/vvvv…` — строку, которая потом стояла в
 * `code_files.lang` и в разбивке по языкам. Ведущая точка имени
 * (`.gitignore`, `.env`) — тоже не расширение: так считает `extname` и так
 * же — `langOf` якорей (`anchor.ts`), одно правило на весь продукт.
 */
export function langOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/") + 1) return "";
  const ext = path.slice(dot).toLowerCase();
  return LANG_BY_EXT.get(ext) ?? ext.slice(1);
}

// ---------------------------------------------------------------------------
// Перечень файлов: git там, где он есть, обход — там, где его нет
// ---------------------------------------------------------------------------

/** Каталог, где .gitignore НЕ соблюдён: перечень там — обход дерева. */
export interface UnignoredDir {
  /** Путь от корня; "." — сам корень. */
  readonly dir: string;
  /** Почему не git: «не репозиторий», «git не найден», текст отказа git. */
  readonly reason: string;
}

export interface FileListing {
  /** Обычные файлы (не симлинки) относительными POSIX-путями, по возрастанию. */
  readonly files: readonly string[];
  /** Репозитории, перечисленные СВОИМ git: ".", "messaging-server", … */
  readonly gitRepos: readonly string[];
  /** Где перечень — обход без .gitignore. Пусто — весь перечень от git. */
  readonly unignored: readonly UnignoredDir[];
  /**
   * Файлов, НЕ взятых в перечень по секретному имени (`secret-paths.ts`), —
   * числом, без имён: имя секрета в выводе команды тоже лишнее.
   */
  readonly secretSkipped: number;
}

export interface ListOptions {
  /** Бинарь git. Подмена — для проверки «git недоступен». */
  readonly git?: string;
}

/**
 * Отслеживаемые + неотслеживаемые, но НЕ игнорируемые (.gitignore всех
 * уровней, .git/info/exclude, core.excludesFile). `-z` — пути как есть, без
 * кавычек core.quotePath.
 */
const GIT_LS_FILES = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"] as const;

/**
 * Переменные, которыми окружение привязывает git к КОНКРЕТНОМУ репозиторию, —
 * ровно список `git rev-parse --local-env-vars`, и ровно их git сам снимает,
 * спускаясь в подмодуль. Без этого myc, запущенный из git-хука (GIT_DIR
 * выставлен), перечислил бы каждый вложенный репозиторий индексом внешнего.
 */
const GIT_LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of GIT_LOCAL_ENV) delete env[k];
  return env;
}

/** Ответ одного `git ls-files` — записи как есть или причина отказа. */
type GitRun =
  | { readonly ok: true; readonly entries: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly noGit: boolean };

function settleGit(code: number | null, stdout: Uint8Array, stderr: string): GitRun {
  if (code === 0) {
    const text = new TextDecoder().decode(stdout);
    const entries = text.split("\0");
    entries.pop(); // за последним NUL — пустой хвост
    return { ok: true, entries };
  }
  const first = stderr.trim().split("\n")[0] ?? "";
  if (/not a git repository/i.test(first)) {
    return { ok: false, reason: "not a git repository", noGit: false };
  }
  return { ok: false, reason: `git ls-files failed (exit ${code ?? "signal"}): ${first}`, noGit: false };
}

/**
 * Запуск упал до git: бинаря нет — или нет каталога, в котором его звали
 * (вложенный репозиторий исчез между волнами). Второе — не повод считать git
 * недоступным для всего дерева.
 */
function spawnFailed(git: string, cwd: string, e: unknown): GitRun {
  const msg = e instanceof Error ? e.message : String(e);
  if (!existsSync(cwd)) return { ok: false, reason: `directory vanished: ${msg}`, noGit: false };
  return { ok: false, reason: `git not runnable (${git}): ${msg}`, noGit: true };
}

function runGitSync(git: string, cwd: string, env: Record<string, string | undefined>): GitRun {
  try {
    const r = Bun.spawnSync([git, ...GIT_LS_FILES], { cwd, env, stdout: "pipe", stderr: "pipe" });
    return settleGit(r.exitCode, r.stdout, r.stderr.toString());
  } catch (e) {
    return spawnFailed(git, cwd, e);
  }
}

async function runGit(git: string, cwd: string, env: Record<string, string | undefined>): Promise<GitRun> {
  let proc;
  try {
    proc = Bun.spawn([git, ...GIT_LS_FILES], { cwd, env, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return spawnFailed(git, cwd, e);
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return settleGit(code, new Uint8Array(out), err);
}

/** Есть ли в пути каталог из SKIP_DIRS. `dir` — путь сам каталог, проверяется и последний сегмент. */
function underSkipDir(path: string, dir: boolean): boolean {
  const parts = path.split("/");
  const n = dir ? parts.length : parts.length - 1;
  for (let i = 0; i < n; i++) if (SKIP_DIRS.has(parts[i]!)) return true;
  return false;
}

function joinRel(dir: string, name: string): string {
  return dir.length === 0 ? name : `${dir}/${name}`;
}

/**
 * Сам перечень — генератор, который ОТДАЁТ наружу каталоги для `git ls-files`
 * и получает обратно их ответы. Алгоритм один, а исполнителей два:
 * асинхронный (`listFiles`) запускает git всей волны РАЗОМ — на корне cherry
 * (15 репозиториев) перечень стоит 45 мс против 115 подряд, — синхронный
 * (`walkFiles`) по очереди, для тех, кому ждать нечем.
 *
 * Ответ git корня называет вложенные репозитории (`sub/` для независимого,
 * каталог-gitlink для подмодуля), и каждый перечисляет СВОЙ git: у корня
 * cherry их файлов в `git ls-files` нет вовсе, а игнор у каждого свой.
 * Репозиторий глубже, чем тот, что его назвал, уходит следующей волной;
 * первый уровень под корнем спрашивается сразу, вместе с корнем.
 *
 * Обход (не git, git упал, git не найден) — прежний, с SKIP_DIRS, и каждый
 * такой каталог записывается в `unignored` с причиной: перечень без
 * .gitignore обязан быть назван, а не выглядеть обычным (И2). Встретив по
 * дороге каталог с `.git` (папка или файл-указатель worktree), обход отдаёт
 * его git, а не идёт внутрь сам.
 *
 * Симлинки не входят ни в какой перечень: git их перечисляет, но файл по
 * ссылке может лежать за корнем, а скан и grep читают по пути.
 *
 * Секретные по имени файлы (`.env`, ключи, учётные данные — `secret-paths.ts`)
 * не входят тоже, и на обеих ветках: чужой .gitignore их может не закрывать,
 * а отслеживаемый `.env` от этого не перестаёт быть секретом. Считаются
 * числом (`secretSkipped`), чтобы запрет был виден, а не молчалив.
 */
function* listing(root: string, absent: string | null): Generator<string[], FileListing, GitRun[]> {
  const files: string[] = [];
  const gitRepos: string[] = [];
  const unignored: UnignoredDir[] = [];
  let secretSkipped = 0;
  // Бинаря git нет — спрашивать его о каждом вложенном репозитории незачем.
  let noGit: string | null = absent;
  let wave: Array<{ rel: string; how: "git" | "walk" }> = [{ rel: "", how: "git" }];

  const walk = (start: string, next: typeof wave): void => {
    const stack = [start];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        continue; // каталог исчез до обхода — не наша гонка
      }
      if (dir !== start && noGit === null && entries.some((e) => e.name === ".git")) {
        next.push({ rel: dir, how: "git" });
        continue;
      }
      for (const e of entries) {
        // `.git` — каталог репозитория или файл-указатель worktree; не код.
        if (e.name === ".git") continue;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(joinRel(dir, e.name));
          continue;
        }
        if (!e.isFile()) continue;
        if (isSecretName(e.name)) secretSkipped++;
        else files.push(joinRel(dir, e.name));
      }
    }
  };

  // Ответы git, полученные РАНЬШЕ, чем до репозитория дошла очередь. Корень и
  // вложенные репозитории первого уровня спрашиваются одной волной: иначе
  // вторая волна ждала бы первую, а на корне cherry это 15 мс сверху к 50.
  // Ответ ребёнка, которого корень не назвал (он им проигнорирован), просто
  // выбрасывается — перечень от этого не меняется, меняется только время.
  const early = new Map<string, GitRun>();
  let first = true;

  while (wave.length > 0) {
    const next: typeof wave = [];
    const viaGit = wave.filter((t) => t.how === "git");
    const ask = viaGit.filter((t) => !early.has(t.rel)).map((t) => t.rel);
    if (first) {
      first = false;
      for (const rel of childRepos(root)) if (!ask.includes(rel)) ask.push(rel);
    }
    if (ask.length > 0) {
      const gone = noGit;
      const runs: GitRun[] =
        gone !== null
          ? ask.map((): GitRun => ({ ok: false, reason: gone, noGit: true }))
          : yield ask.map((rel) => join(root, rel));
      ask.forEach((rel, i) => early.set(rel, runs[i]!));
    }
    for (const t of viaGit) {
      let run = early.get(t.rel)!;
      early.delete(t.rel);
      // Корень без своего .git, по которому git не перечислил НИЧЕГО, — это
      // каталог, который игнорирует объемлющий репозиторий (домашний
      // dotfiles с `*` в .gitignore). Пустой реестр там был бы молчаливой
      // пустотой; честнее обход с предупреждением.
      if (run.ok && t.rel === "" && run.entries.length === 0 && !existsSync(join(root, ".git"))) {
        run = {
          ok: false,
          reason: "the enclosing git repository lists no files here (it ignores this directory)",
          noGit: false,
        };
      }
      if (!run.ok) {
        if (run.noGit) noGit ??= run.reason;
        unignored.push({ dir: t.rel.length === 0 ? "." : t.rel, reason: run.reason });
        next.push({ rel: t.rel, how: "walk" });
        continue;
      }
      gitRepos.push(t.rel.length === 0 ? "." : t.rel);
      for (const entry of run.entries) {
        if (entry.endsWith("/")) {
          // Неотслеживаемый каталог с собственным .git — независимый репозиторий.
          const sub = joinRel(t.rel, entry.slice(0, -1));
          if (!underSkipDir(sub, true)) next.push({ rel: sub, how: "git" });
          continue;
        }
        const path = joinRel(t.rel, entry);
        if (underSkipDir(path, false)) continue;
        let st;
        try {
          st = lstatSync(join(root, path));
        } catch {
          continue; // отслеживается, но удалён из рабочего дерева
        }
        if (st.isFile()) {
          if (isSecretPath(path)) secretSkipped++;
          else files.push(path);
        } else if (st.isDirectory() && existsSync(join(root, path, ".git"))) {
          // gitlink в индексе — подмодуль (или вложенный репозиторий, добавленный
          // `git add`): его файлы перечисляет его git. Не извлечённый подмодуль
          // (пустой каталог без .git) перечислять нечем — и нечего.
          if (!underSkipDir(path, true)) next.push({ rel: path, how: "git" });
        }
      }
    }
    for (const t of wave) if (t.how === "walk") walk(t.rel, next);
    wave = next;
  }

  files.sort();
  return { files, gitRepos, unignored, secretSkipped };
}

/** Каталоги первого уровня со своим `.git` — кандидаты в первую волну. */
function childRepos(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".git" || SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(root, e.name, ".git"))) out.push(e.name);
  }
  return out;
}

/**
 * Какой git звать; null — git не установлен.
 *
 * На macOS `/usr/bin/git` — не git, а шим xcrun: при КАЖДОМ вызове он заново
 * ищет инструменты разработчика и стоит ~7 мс сверху (замер: `git --version`
 * 11 мс через шим против 4 мс напрямую). На корне cherry это 50 мс перечня
 * против 80. Каталог инструментов ищется в том же порядке, что у xcrun:
 * DEVELOPER_DIR, выбор `xcode-select` (/var/db/xcode_select_link), Xcode.app,
 * Command Line Tools. Не нашёлся ни один — инструментов нет, а шим вместо
 * ответа открыл бы окно их установки, и из фонового индекса тоже. Поэтому
 * тогда git считается не установленным: обход с предупреждением.
 *
 * git не из /usr/bin (Homebrew и прочие) — настоящий, берётся по PATH как есть.
 */
function resolveGit(): string | null {
  if (process.platform !== "darwin" || Bun.which("git") !== "/usr/bin/git") return "git";
  let selected: string | undefined;
  try {
    selected = readlinkSync("/var/db/xcode_select_link");
  } catch {
    selected = undefined;
  }
  const dirs = [
    process.env.DEVELOPER_DIR,
    selected,
    "/Applications/Xcode.app/Contents/Developer",
    "/Library/Developer/CommandLineTools",
  ];
  for (const d of dirs) {
    if (d === undefined || d.length === 0) continue;
    const bin = join(d, "usr", "bin", "git");
    if (existsSync(bin)) return bin;
  }
  return null;
}

let resolvedGit: string | null | undefined;

/** Бинарь git и причина его отсутствия — одно решение на процесс. */
function gitBinary(opts: ListOptions): { readonly git: string; readonly absent: string | null } {
  if (opts.git !== undefined) return { git: opts.git, absent: null };
  if (resolvedGit === undefined) resolvedGit = resolveGit();
  return resolvedGit === null
    ? { git: "git", absent: "git is not installed (macOS: no Xcode or Command Line Tools)" }
    : { git: resolvedGit, absent: null };
}

/**
 * Как звать git из код-интеллекта ВНЕ перечня (`worktree.ts`): тот же бинарь
 * мимо шима xcrun и то же окружение без привязки к чужому репозиторию. null —
 * git не установлен, и спрашивать его не о чем.
 */
export function gitSpawn(): { readonly git: string; readonly env: Record<string, string | undefined> } | null {
  const { git, absent } = gitBinary({});
  return absent === null ? { git, env: gitEnv() } : null;
}

/**
 * Перечень файлов дерева — ЕДИНСТВЕННЫЙ источник реестра `code_files`, а через
 * него — и `code grep`, и `code search`, и карты. git-репозиторий (и каждый
 * вложенный) перечисляется `git ls-files`, то есть с .gitignore; не-git —
 * обходом с SKIP_DIRS и записью в `unignored`. SKIP_DIRS действует поверх
 * git тоже: `.myc` и `node_modules` не индексируются, даже если их никто не
 * игнорирует. Так же поверх любого перечня — запрет по секретному имени
 * (`secret-paths.ts`): `.env`, ключи и учётные данные не индексируются, что
 * бы ни говорил .gitignore.
 */
export async function listFiles(root: string, opts: ListOptions = {}): Promise<FileListing> {
  const { git, absent } = gitBinary(opts);
  const env = gitEnv();
  const gen = listing(root, absent);
  let step = gen.next();
  while (!step.done) {
    step = gen.next(await Promise.all(step.value.map((cwd) => runGit(git, cwd, env))));
  }
  return step.value;
}

/** Тот же перечень синхронно: git вложенных репозиториев — по очереди. */
export function listFilesSync(root: string, opts: ListOptions = {}): FileListing {
  const { git, absent } = gitBinary(opts);
  const env = gitEnv();
  const gen = listing(root, absent);
  let step = gen.next();
  while (!step.done) {
    step = gen.next(step.value.map((cwd) => runGitSync(git, cwd, env)));
  }
  return step.value;
}

/** Файлы перечня (см. `listFiles`) — для тех, кому нужен только список путей. */
export function walkFiles(root: string): string[] {
  return [...listFilesSync(root).files];
}

/**
 * Есть ли в дереве хоть один файл уровня L1 — и какие расширения встретились
 * по дороге. Не скан индекса: обход обрывается на ПЕРВОМ L1-файле, а в дереве
 * без них ограничен потолком записей, чтобы строка `init` не стоила прохода
 * по чужому монорепозиторию.
 *
 * `langs` заполняется только до обрыва: это подсказка «на чём тут пишут»,
 * а не статистика (её считает `code_files`, §5).
 */
export function probeL1Files(
  root: string,
  maxEntries = 4_000,
): { readonly found: boolean; readonly seen: number; readonly langs: readonly string[]; readonly capped: boolean } {
  const langs = new Set<string>();
  const stack: string[] = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      const lang = langOf(e.name);
      if (L1_LANGS.has(lang)) return { found: true, seen, langs: [...langs, lang], capped: false };
      if (lang.length > 0 && langs.size < 12) langs.add(lang);
      if (seen >= maxEntries) {
        return { found: false, seen, langs: [...langs], capped: true };
      }
    }
  }
  return { found: false, seen, langs: [...langs], capped: false };
}
