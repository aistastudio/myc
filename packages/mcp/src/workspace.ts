/**
 * Есть ли воркспейс myc там, куда смотрит сервер, и где он.
 *
 * Правило ТО ЖЕ, что у CLI (packages/cli/src/commands/wsfind.ts,
 * findWorkspaceDb): первый `.myc/myc.db` вверх по каталогам; домашний каталог
 * проверяется только стартовым (его `.myc` — личный ярус, не воркспейс
 * проекта); не нашлось, а старт внутри git worktree — тот же подъём от того
 * же места в основном дереве (`.git` — файл `gitdir: …`, в служебном каталоге —
 * `commondir`); основное дерево унесли — воркспейса нет.
 *
 * ПОЧЕМУ КОПИЯ, А НЕ ИМПОРТ. @myc/cli наружу отдаёт один run(), а
 * относительный импорт `../../cli/src/commands/wsfind.ts` tsc этого пакета
 * отвергает (TS6059: файл вне rootDir). Копия маленькая, без списков
 * проверенных путей (серверу нужен ответ «да, вот он» или «нет»), и её
 * расхождение с оригиналом ловит паритетный тест в @myc/cli
 * (commands/mcp-workspace.parity.test.ts) на тех же раскладках: обычный
 * каталог, вложенный, git worktree вне дерева, worktree без основного дерева,
 * submodule, граница домашнего каталога.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

function climb(startDir: string): { readonly hit: string | undefined; readonly dirs: readonly string[] } {
  const boundary = resolve(process.env.MYC_HOME ?? homedir());
  const dirs: string[] = [];
  let dir = resolve(startDir);
  let climbed = false;
  for (;;) {
    if (climbed && dir === boundary) break;
    dirs.push(dir);
    if (existsSync(join(dir, ".myc", "myc.db"))) return { hit: dir, dirs };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    climbed = true;
  }
  return { hit: undefined, dirs };
}

/** Корень основного дерева для git worktree в `dir`; undefined — `dir` не worktree. */
function worktreeMain(dir: string): string | undefined {
  const dotGit = join(dir, ".git");
  try {
    if (!statSync(dotGit).isFile()) return undefined;
  } catch {
    return undefined;
  }
  let gitDir: string;
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (m === null) return undefined;
    gitDir = resolve(dir, m[1]!);
  } catch {
    return undefined;
  }
  let commonDir: string;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    // Как в wsfind: без commondir worktree узнаётся только по форме пути
    // `<общий>/.git/worktrees/<имя>`; submodule (`.git/modules/<имя>`) — нет.
    if (basename(dirname(gitDir)) !== "worktrees") return undefined;
    commonDir = dirname(dirname(gitDir));
    if (basename(commonDir) !== ".git") return undefined;
  }
  return dirname(commonDir);
}

/** Каталог воркспейса (над `.myc`) или undefined. */
export function findMcpWorkspace(startDir: string): string | undefined {
  const local = climb(startDir);
  if (local.hit !== undefined) return local.hit;
  for (const dir of local.dirs) {
    const main = worktreeMain(dir);
    if (main === undefined) continue;
    if (!existsSync(main)) return undefined;
    const rest = relative(dir, resolve(startDir));
    const from = rest.startsWith("..") || rest.startsWith("/") ? resolve(startDir) : rest.length === 0 ? main : join(main, rest);
    return climb(from).hit;
  }
  return undefined;
}
