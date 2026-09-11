/**
 * Какие файлы попытка ФАКТИЧЕСКИ тронула (memory-1ax1pmk6mc3q) — источник
 * `touched` оси scope класса задачи (./taskclass.ts, SCOPE_SOURCES).
 *
 * ПОЧЕМУ СНИМОК, А НЕ `git diff <HEAD на старте>`. Наивный вариант стоял в
 * `attempt finish` с memory-v3f81y9vfrq0 и записал ровно то, что должен был:
 * всё грязное в дереве. ИЗМЕРЕНО на рабочей базе 2026-09-11: из четырёх
 * попыток с записанными файлами у ТРЁХ разных задач (memory-v3f81y9vfrq0,
 * memory-fqcxrktkqvcr, memory-3afmdwe7bwyp) один и тот же список из 46 файлов
 * — рабочее дерево координатора, в котором лежала несданная работа
 * нескольких агентов. Класс из такого списка — «cross» у всех, и это не факт,
 * а шум соседей. Три причины, и у каждой своё лечение здесь:
 *
 * 1. ГРЯЗЬ, КОТОРАЯ БЫЛА ДО СТАРТА. `git diff HEAD` не отличает правку этой
 *    попытки от несданной правки соседа, лежавшей в дереве ещё до неё.
 *    Поэтому на старте снимается не только HEAD, но и хеш содержимого
 *    каждого уже грязного файла; на финише такой файл засчитывается, только
 *    если его содержимое с тех пор изменилось.
 * 2. ДИФФ В ЧУЖОМ ДЕРЕВЕ. Финиш ставит координатор из своего каталога, а
 *    работа шла в worktree агента. Поэтому корень рабочего дерева
 *    записывается на старте, и дифф считается в НЁМ, откуда бы ни позвали
 *    финиш.
 * 3. ВЛОЖЕННЫЕ РЕПОЗИТОРИИ. В экосистеме (S59: корень плюс 15 своих git)
 *    правка `messaging-server/x.ts` из корня невидима git'у корня. Поэтому,
 *    если попытка стартует из основного дерева КОРНЯ, снимаются и все
 *    репозитории первого уровня под ним.
 *
 * Пути отдаются КЛЮЧАМИ `(prefix, path)` — той же парой, что у якоря
 * (`repo_id`, `path`): `prefix` — каталог основного дерева репозитория от
 * корня воркспейса ('' — сам корень), `path` — от корня репозитория. Путь от
 * корня воркспейса из ключа собирает вызывающий (`wsPathOfKey` в CLI), и
 * один файл даёт один путь, откуда бы его ни правили: из корня, из вложенного
 * репозитория или из его worktree.
 *
 * ЧЕГО ЭТО НЕ ЛЕЧИТ. Соседа, правящего то же дерево В ТО ЖЕ ВРЕМЯ: на уровне
 * git правка есть правка, чья она — не записано. Честный ответ на это —
 * worktree на агента, и тогда дифф чистый. Окно нулевой длины (координатор
 * открыл и закрыл попытку одной секундой) даёт пустой список — «данных
 * нет», а не `local`: пустота в источнике пропускается (pickScopePaths).
 *
 * Пути `.myc/` не считаются: это состояние самого myc (оплог `.myc/graph`
 * меняется от каждого `myc remember`), и засчитать его значило бы сделать
 * каждую попытку «cross» только за то, что агент вёл память.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Одно рабочее дерево на старте попытки. */
export interface CheckoutBase {
  /** Абсолютный корень рабочего дерева (у worktree — сам worktree). */
  readonly root: string;
  /** Каталог ОСНОВНОГО дерева репозитория от корня воркспейса; '' — корень. */
  readonly prefix: string;
  /** HEAD на старте; null — в репозитории ещё нет коммитов. */
  readonly head: string | null;
  /** Грязное на старте: путь от корня репозитория → хеш содержимого, '-' — удалён. */
  readonly dirty: Readonly<Record<string, string>>;
}

/** База диффа попытки. Первое дерево — то, где стояла попытка. */
export interface GitBase {
  readonly v: 1;
  readonly checkouts: readonly CheckoutBase[];
}

/** Тронутый файл ключом репозитория — как у якоря. */
export interface TouchedKey {
  readonly prefix: string;
  readonly path: string;
}

/** Потолок на один вызов git: снимок — путь записи, но не бесконечный. */
export const GIT_TIMEOUT_MS = 10_000;

/** Метка удалённого файла в карте грязного. */
const GONE = "-";

async function git(root: string, args: readonly string[], input?: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "--no-optional-locks", "-C", root, ...args], {
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function nulList(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

/** Состояние самого myc и каталоги вложенных репозиториев — не файлы попытки. */
function countable(path: string): boolean {
  return !path.endsWith("/") && path.split("/")[0] !== ".myc" && !path.includes("\n");
}

/**
 * Хеши содержимого, один вызов git на все файлы. Отсутствующий — '-';
 * каталог (gitlink, вложенный репозиторий) не хешируется вовсе и не
 * попадает в ответ: hash-object по каталогу уронил бы весь вызов.
 */
async function hashes(root: string, paths: readonly string[]): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  const files: string[] = [];
  for (const p of paths) {
    let st;
    try {
      st = statSync(join(root, p));
    } catch {
      out.set(p, GONE);
      continue;
    }
    if (st.isFile()) files.push(p);
  }
  if (files.length === 0) return out;
  const raw = await git(root, ["hash-object", "--stdin-paths"], `${files.join("\n")}\n`);
  if (raw === null) return null;
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length !== files.length) return null;
  files.forEach((p, i) => out.set(p, lines[i]!));
  return out;
}

/** Корень рабочего дерева и корень его ОСНОВНОГО дерева (у worktree они разные). */
async function checkoutOf(dir: string): Promise<{ root: string; mainRoot: string } | null> {
  const out = await git(dir, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (out === null) return null;
  const [top, common] = out.split("\n");
  if (top === undefined || top === "" || common === undefined || common === "") return null;
  const root = real(top);
  const commonAbs = real(resolve(dir, common));
  // Общий git-каталог основного дерева — `<основное>/.git`. У submodule он
  // `<супер>/.git/modules/<имя>`: основного дерева «над ним» нет, и корнем
  // остаётся само рабочее дерево.
  const mainRoot = basename(commonAbs) === ".git" ? dirname(commonAbs) : root;
  return { root, mainRoot };
}

function prefixOf(wsRoot: string, mainRoot: string): string | null {
  const rel = relative(wsRoot, mainRoot);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Репозитории первого уровня под корнем воркспейса. worktree ВНУТРИ дерева
 * (`.git`-файл со ссылкой в `…/worktrees/…`) — копия чужого checkout'а, а не
 * репозиторий: его пропускаем, как пропускает его индекс корня (4caa93f).
 */
function nestedRepos(wsRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(wsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".git" || e.name === ".myc" || e.name === "node_modules") {
      continue;
    }
    const dotGit = join(wsRoot, e.name, ".git");
    let st;
    try {
      st = statSync(dotGit);
    } catch {
      continue;
    }
    if (st.isFile()) {
      let text = "";
      try {
        text = readFileSync(dotGit, "utf8");
      } catch {
        continue;
      }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (m === null || m[1]!.split(/[\\/]/).includes("worktrees")) continue;
    }
    out.push(e.name);
  }
  return out.sort();
}

async function snapshot(root: string, prefix: string): Promise<CheckoutBase | null> {
  const [headOut, status] = await Promise.all([
    git(root, ["rev-parse", "-q", "--verify", "HEAD"]),
    git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=all",
    ]),
  ]);
  if (status === null) return null;
  const dirtyPaths = nulList(status)
    .map((entry) => entry.slice(3))
    .filter(countable);
  const hashed = await hashes(root, dirtyPaths);
  if (hashed === null) return null;
  const dirty: Record<string, string> = {};
  for (const [p, h] of [...hashed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    dirty[p] = h;
  }
  const head = headOut === null ? null : headOut.trim() || null;
  return { root, prefix, head, dirty };
}

/**
 * Снимок на старте попытки из каталога `cwd` в воркспейсе `wsDir`.
 *
 * null — снимать нечего: каталог не в git и не в корне воркспейса, или git
 * не ответил. Это не отказ старта: попытка открывается, а класс потом
 * возьмётся из следующего источника.
 */
export async function snapshotCheckouts(cwd: string, wsDir: string): Promise<GitBase | null> {
  const wsRoot = real(wsDir);
  const at = real(cwd);
  const primary = await checkoutOf(at);
  const checkouts: Array<{ root: string; prefix: string }> = [];
  if (primary !== null) {
    const prefix = prefixOf(wsRoot, primary.mainRoot);
    if (prefix !== null) checkouts.push({ root: primary.root, prefix });
  }
  // Из ОСНОВНОГО дерева корня (или из корня, который сам не git) агент
  // правит любой вложенный репозиторий, и git корня этих правок не видит.
  const fromRoot =
    primary === null ? prefixOf(wsRoot, at) !== null : primary.root === wsRoot && primary.mainRoot === wsRoot;
  if (fromRoot) {
    for (const name of nestedRepos(wsRoot)) {
      const root = join(wsRoot, name);
      if (checkouts.some((c) => c.root === root)) continue;
      checkouts.push({ root, prefix: name });
    }
  }
  if (checkouts.length === 0) return null;
  const snaps = await Promise.all(checkouts.map((c) => snapshot(c.root, c.prefix)));
  // Первое дерево — то, где стоит попытка: без него снимка нет. Вложенный
  // репозиторий, на котором git не ответил, выпадает из снимка, а не роняет
  // его целиком.
  if (primary !== null && checkouts[0]!.root === primary.root && snaps[0] === null) return null;
  const ok = snaps.filter((s): s is CheckoutBase => s !== null);
  return ok.length === 0 ? null : { v: 1, checkouts: ok };
}

async function touchedIn(c: CheckoutBase): Promise<TouchedKey[] | null> {
  if (!existsSync(c.root)) return null;
  const [changedOut, untrackedOut] = await Promise.all([
    c.head === null
      ? git(c.root, ["ls-files", "-z"])
      : git(c.root, ["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=all", c.head]),
    git(c.root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  if (changedOut === null || untrackedOut === null) return null;
  const differs = new Set([...nulList(changedOut), ...nulList(untrackedOut)].filter(countable));
  const before = Object.keys(c.dirty);
  const now = await hashes(c.root, before);
  if (now === null) return null;
  const out = new Set<string>();
  for (const p of differs) if (!(p in c.dirty)) out.add(p);
  // Было грязным до старта — засчитывается, только если содержимое сменилось.
  for (const p of before) {
    const h = now.get(p);
    if (h !== undefined && h !== c.dirty[p]) out.add(p);
  }
  return [...out].sort().map((path) => ({ prefix: c.prefix, path }));
}

/**
 * Что изменилось за попытку по снимку `base`, ключами `(prefix, path)`.
 *
 * null — посчитать нечем: дерева, где стояла попытка, больше нет (worktree
 * удалили до финиша) или git не ответил. Пустой список — посчитано, и за
 * попытку не изменилось ничего.
 */
export async function touchedSince(base: GitBase): Promise<TouchedKey[] | null> {
  if (base.checkouts.length === 0) return null;
  const parts = await Promise.all(base.checkouts.map(touchedIn));
  if (parts[0] === null) return null;
  return parts.flatMap((p) => p ?? []);
}

/** Разбор записанного снимка: чужая форма — не снимок, а null. */
export function parseGitBase(raw: string | null): GitBase | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<GitBase>;
    if (v.v !== 1 || !Array.isArray(v.checkouts)) return null;
    const checkouts = v.checkouts.filter(
      (c): c is CheckoutBase =>
        c !== null &&
        typeof c === "object" &&
        typeof c.root === "string" &&
        typeof c.prefix === "string" &&
        (c.head === null || typeof c.head === "string") &&
        c.dirty !== null &&
        typeof c.dirty === "object",
    );
    return checkouts.length === 0 ? null : { v: 1, checkouts };
  } catch {
    return null;
  }
}
