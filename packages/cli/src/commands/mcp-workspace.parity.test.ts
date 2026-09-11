/**
 * Паритет поиска воркспейса: сервер MCP (packages/mcp/src/workspace.ts) против
 * CLI (commands/wsfind.ts, findWorkspaceDb).
 *
 * У сервера — копия: @myc/cli наружу отдаёт один run(), а относительный
 * импорт wsfind.ts из @myc/mcp tsc отвергает (TS6059, rootDir). Копия, которая
 * разошлась с оригиналом, значила бы, что сервер пользовательского слоя видит
 * воркспейс там, где его не видит CLI (или наоборот), — и 13 инструментов
 * отказывали бы на каждом вызове, или ноль инструментов стоял бы там, где myc
 * работает. Раскладки — все ветки оригинала: обычный каталог, вложенный,
 * git worktree вне дерева, worktree с унесённым основным деревом, submodule,
 * граница домашнего каталога.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMcpWorkspace } from "@myc/mcp";
import { findWorkspaceDb } from "./wsfind.ts";

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myc-ws-parity-"));
  savedHome = process.env.MYC_HOME;
  process.env.MYC_HOME = join(root, "home");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MYC_HOME;
  else process.env.MYC_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function ws(dir: string): void {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  writeFileSync(join(dir, ".myc", "myc.db"), "");
}

/** `.git`-файл worktree и служебный каталог основного дерева — как их пишет git. */
function worktree(main: string, wt: string, name: string, commondir = true): void {
  const gitDir = join(main, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  if (commondir) writeFileSync(join(gitDir, "commondir"), "../..\n");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
}

function cliAnswer(dir: string): string | undefined {
  const found = findWorkspaceDb(dir);
  return "dbPath" in found ? found.wsDir : undefined;
}

describe("поиск воркспейса: MCP = CLI", () => {
  test("все ветки подъёма и worktree дают один и тот же ответ", () => {
    const home = join(root, "home");
    ws(home); // личный ярус: снизу вверх его не видит никто
    const eco = join(home, "src", "cherry");
    ws(eco);
    mkdirSync(join(eco, "collector", ".git"), { recursive: true });
    mkdirSync(join(eco, "collector", "src", "deep"), { recursive: true });
    // worktree вложенного репозитория снаружи экосистемы
    worktree(join(eco, "collector"), join(root, "orca", "collector", "feature"), "feature");
    mkdirSync(join(root, "orca", "collector", "feature", "src"), { recursive: true });
    // worktree, у которого унесли основное дерево (служебного каталога нет)
    mkdirSync(join(root, "lost"), { recursive: true });
    writeFileSync(join(root, "lost", ".git"), `gitdir: ${join(root, "gone", ".git", "worktrees", "x")}\n`);
    // worktree без commondir, но с формой пути .../.git/worktrees/<имя>
    worktree(join(root, "main2"), join(root, "wt2"), "y", false);
    ws(join(root, "main2"));
    // submodule: .git-файл в .git/modules, commondir нет
    mkdirSync(join(root, "super", ".git", "modules", "sub"), { recursive: true });
    mkdirSync(join(root, "super", "sub"), { recursive: true });
    writeFileSync(join(root, "super", "sub", ".git"), `gitdir: ${join(root, "super", ".git", "modules", "sub")}\n`);
    mkdirSync(join(home, "plain"), { recursive: true });

    const cases = [
      eco,
      join(eco, "collector"),
      join(eco, "collector", "src", "deep"),
      join(root, "orca", "collector", "feature"),
      join(root, "orca", "collector", "feature", "src"),
      join(root, "lost"),
      join(root, "wt2"),
      join(root, "super", "sub"),
      join(home, "plain"),
      home,
      root,
    ];
    const answers = cases.map((dir) => ({ dir, mcp: findMcpWorkspace(dir), cli: cliAnswer(dir) }));
    for (const a of answers) expect({ dir: a.dir, mcp: a.mcp }).toEqual({ dir: a.dir, mcp: a.cli });
    // И ответы не тривиальны: ветки действительно разные.
    expect(answers.map((a) => a.cli)).toEqual([
      eco,
      eco,
      eco,
      eco,
      eco,
      undefined,
      join(root, "main2"),
      undefined,
      undefined,
      home,
      undefined,
    ]);
  });
});
