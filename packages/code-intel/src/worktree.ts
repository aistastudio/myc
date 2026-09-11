/**
 * СОВПАДАЕТ ЛИ WORKTREE С ОСНОВНОЙ КОПИЕЙ (memory-m0md9fybwrdh).
 *
 * Код-индекс отражает ОСНОВНУЮ копию репозитория: отдельного индекса на
 * каждый git worktree нет и не будет (он удвоил бы базу на каждую ветку). Агент
 * же работает в worktree, на своей ветке, и перечень файлов, символы и спаны,
 * которые ему отдаёт индекс, сняты с чужого дерева. Пока ветки стоят на одном
 * коммите и в worktree нет правок — это одно и то же дерево. Как только нет —
 * ответ ОБЯЗАН сказать об этом вслух (И2): из какой копии и какой ветки он
 * взят, и что строки могут не совпасть.
 *
 * HEAD ЧИТАЕТСЯ ФАЙЛАМИ, А НЕ `git rev-parse` — по той же причине, что и связь
 * worktree → основное дерево в `wsfind.ts`: два read() против подпроцесса в
 * 12 мс. Подпроцесс остаётся ОДИН и только там, где без него нельзя: «есть ли
 * в worktree правки отслеживаемых файлов» знает лишь git (индекс и stat),
 * и спрашивается он, только когда коммиты совпали — при разных коммитах
 * расхождение уже установлено и ждать git незачем.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitSpawn } from "./langs.ts";

/** Что стоит в HEAD git-каталога. */
export interface GitHead {
  /** Ветка (`feature`), или null — HEAD отсоединён. */
  readonly branch: string | null;
  /** Коммит; null — ссылку разрешить не удалось (нерождённая ветка, битый git). */
  readonly sha: string | null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Общий git-каталог для каталога `gitDir`: у worktree — из его `commondir`, у
 * основного дерева — он сам.
 */
export function commonDirOf(gitDir: string): string {
  const rel = readText(join(gitDir, "commondir"));
  return rel === null ? gitDir : resolve(gitDir, rel.trim());
}

/** Ссылку (`refs/heads/x`) — в коммит: сначала отдельный файл, потом packed-refs. */
function resolveRef(commonDir: string, gitDir: string, ref: string): string | null {
  for (const dir of [gitDir, commonDir]) {
    const loose = readText(join(dir, ref));
    if (loose !== null && /^[0-9a-f]{40,64}\s*$/.test(loose)) return loose.trim();
  }
  const packed = readText(join(commonDir, "packed-refs"));
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const sp = line.indexOf(" ");
    if (sp > 0 && line.slice(sp + 1).trim() === ref) return line.slice(0, sp);
  }
  return null;
}

/** HEAD git-каталога (`<main>/.git` или `<main>/.git/worktrees/<имя>`). */
export function readGitHead(gitDir: string): GitHead {
  const head = readText(join(gitDir, "HEAD"));
  if (head === null) return { branch: null, sha: null };
  const m = /^ref:\s*(\S+)/.exec(head);
  if (m === null) {
    const sha = head.trim();
    return { branch: null, sha: /^[0-9a-f]{40,64}$/.test(sha) ? sha : null };
  }
  const ref = m[1]!;
  return {
    branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref,
    sha: resolveRef(commonDirOf(gitDir), gitDir, ref),
  };
}

/**
 * Есть ли в рабочем дереве правки ОТСЛЕЖИВАЕМЫХ файлов. `--no-optional-locks`
 * — чтобы вопрос не писал в чужой индекс git (status иначе его обновляет);
 * неотслеживаемые не считаются: индекс их не видел и не обещал. null — git не
 * ответил, и притворяться, что дерево чистое, нельзя.
 */
export function worktreeDirty(dir: string): boolean | null {
  const g = gitSpawn();
  if (g === null) return null;
  try {
    const r = Bun.spawnSync(
      [g.git, "--no-optional-locks", "status", "--porcelain", "--untracked-files=no"],
      { cwd: dir, env: g.env, stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) return null;
    return r.stdout.byteLength > 0;
  } catch {
    return null;
  }
}

/** Сравнение worktree с основной копией — всё, что нужно для WARN. */
export interface WorktreeDivergence {
  readonly worktree: GitHead;
  readonly main: GitHead;
  /** Правки отслеживаемых файлов в worktree; null — не спрашивали или git не ответил. */
  readonly dirty: boolean | null;
  /** Ответ индекса может не совпасть с файлами worktree. */
  readonly divergent: boolean;
  /** Цена сравнения — подпроцесс git в ней виден числом. */
  readonly tookMs: number;
}

/**
 * `gitDir` — служебный каталог worktree (`<main>/.git/worktrees/<имя>`),
 * `worktreeDir` — его рабочее дерево. Коммит, который разрешить не удалось,
 * считается расхождением: «не знаем» — не «совпадает».
 */
export function compareWorktree(gitDir: string, worktreeDir: string): WorktreeDivergence {
  const t0 = performance.now();
  const worktree = readGitHead(gitDir);
  const main = readGitHead(commonDirOf(gitDir));
  if (worktree.sha === null || main.sha === null || worktree.sha !== main.sha) {
    return { worktree, main, dirty: null, divergent: true, tookMs: performance.now() - t0 };
  }
  const dirty = worktreeDirty(worktreeDir);
  return { worktree, main, dirty, divergent: dirty !== false, tookMs: performance.now() - t0 };
}

/**
 * Игнорирует ли git каталога `dir` путь `rel` (`git check-ignore`). Нужно
 * одному вопросу: покроет ли индекс корня вложенный репозиторий, которого в
 * нём пока нет. Перечень корня (`listFiles`) берёт вложенный репозиторий
 * ровно тогда, когда git корня его НЕ игнорирует; тогда свой индекс у него —
 * будущий дубль, а правильный ответ — переиндексировать корень. null — git не
 * ответил (не репозиторий, нет git): перечень корня тогда — обход, и он
 * вложенный репозиторий тоже возьмёт.
 */
export function gitIgnores(dir: string, rel: string): boolean | null {
  const g = gitSpawn();
  if (g === null) return null;
  try {
    const r = Bun.spawnSync([g.git, "check-ignore", "-q", "--", rel], {
      cwd: dir,
      env: g.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode === 0) return true;
    if (r.exitCode === 1) return false;
    return null;
  } catch {
    return null;
  }
}

/** `feature @1a2b3c4` — ветка и короткий коммит для строки WARN. */
export function headLabel(h: GitHead): string {
  const sha = h.sha === null ? "unknown commit" : h.sha.slice(0, 7);
  return h.branch === null ? `detached @${sha}` : `${h.branch} @${sha}`;
}
