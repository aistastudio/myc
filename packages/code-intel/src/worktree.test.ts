/**
 * Сравнение git worktree с основной копией (memory-m0md9fybwrdh, `worktree.ts`).
 * Настоящий git: HEAD читается файлами, и проверять это надо на файлах,
 * которые пишет git, — loose ref, packed-refs, отсоединённый HEAD.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonDirOf, compareWorktree, gitIgnores, headLabel, readGitHead } from "./worktree.ts";

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (!p.success) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let sandbox: string;
let main: string;
let wt: string;
let wtGitDir: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "code-wt-")));
  main = join(sandbox, "main");
  Bun.spawnSync(["mkdir", "-p", main]);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "one");
  wt = join(sandbox, "wt");
  git(main, "worktree", "add", "-q", wt, "-b", "feature");
  wtGitDir = git(wt, "rev-parse", "--absolute-git-dir");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("HEAD без подпроцесса", () => {
  test("ветка и коммит совпадают с git rev-parse — у основной копии и у worktree", () => {
    const m = readGitHead(join(main, ".git"));
    expect(m.branch).toBe("main");
    expect(m.sha).toBe(git(main, "rev-parse", "HEAD"));
    const w = readGitHead(wtGitDir);
    expect(w.branch).toBe("feature");
    expect(w.sha).toBe(git(wt, "rev-parse", "HEAD"));
    expect(commonDirOf(wtGitDir)).toBe(join(main, ".git"));
    expect(headLabel(w)).toBe(`feature @${w.sha!.slice(0, 7)}`);
  });

  test("packed-refs и отсоединённый HEAD", () => {
    git(main, "pack-refs", "--all");
    expect(readGitHead(join(main, ".git")).sha).toBe(git(main, "rev-parse", "HEAD"));
    git(wt, "checkout", "-q", "--detach");
    const w = readGitHead(wtGitDir);
    expect(w.branch).toBeNull();
    expect(w.sha).toBe(git(wt, "rev-parse", "HEAD"));
    expect(headLabel(w).startsWith("detached @")).toBe(true);
  });
});

describe("расхождение worktree с основной копией", () => {
  test("тот же коммит и чистое дерево — не расходятся", () => {
    const c = compareWorktree(wtGitDir, wt);
    expect(c.divergent).toBe(false);
    expect(c.dirty).toBe(false);
  });

  test("правка отслеживаемого файла — расходятся; неотслеживаемый файл — нет", () => {
    writeFileSync(join(wt, "untracked.ts"), "x\n");
    expect(compareWorktree(wtGitDir, wt).divergent).toBe(false);
    writeFileSync(join(wt, "a.ts"), "export const a = 2;\n");
    const c = compareWorktree(wtGitDir, wt);
    expect(c.divergent).toBe(true);
    expect(c.dirty).toBe(true);
  });

  test("другой коммит — расходятся без вопроса к git о правках", () => {
    writeFileSync(join(wt, "a.ts"), "export const a = 3;\n");
    git(wt, "commit", "-qam", "two");
    const c = compareWorktree(wtGitDir, wt);
    expect(c.divergent).toBe(true);
    expect(c.dirty).toBeNull();
    expect(c.worktree.sha).not.toBe(c.main.sha);
  });
});

test("gitIgnores: игнорируемый каталог, неигнорируемый, не-репозиторий", () => {
  writeFileSync(join(main, ".gitignore"), "hidden/\n");
  Bun.spawnSync(["mkdir", "-p", join(main, "hidden"), join(main, "open")]);
  expect(gitIgnores(main, "hidden")).toBe(true);
  expect(gitIgnores(main, "open")).toBe(false);
  expect(gitIgnores(sandbox, "main")).toBeNull();
});
