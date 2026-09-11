import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitBase, snapshotCheckouts, touchedSince, type TouchedKey } from "./touched.ts";

/**
 * Тронутые файлы попытки — на НАСТОЯЩЕМ git во временном каталоге. Подделка
 * git здесь проверяла бы подделку: всё, что может сломаться, живёт в том,
 * как git отвечает на `status`, `diff` и worktree.
 */

let base: string;

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
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
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function write(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

function repo(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  sh(root, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "init");
}

function keys(list: readonly TouchedKey[] | null): string[] | null {
  return list === null ? null : list.map((k) => (k.prefix === "" ? k.path : `${k.prefix}:${k.path}`));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myc-touched-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("одно дерево", () => {
  test("правка после старта засчитывается, грязь до старта — нет", async () => {
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n", "neighbour.ts": "n\n" });
    write(ws, "neighbour.ts", "чужая несданная правка\n");
    write(ws, "untracked-before.ts", "лежал до старта\n");

    const snap = await snapshotCheckouts(ws, ws);
    expect(snap?.checkouts.map((c) => [c.prefix, Object.keys(c.dirty)])).toEqual([
      ["", ["neighbour.ts", "untracked-before.ts"]],
    ]);

    write(ws, "a.ts", "a2\n");
    write(ws, "src/new.ts", "new\n");
    expect(keys(await touchedSince(snap!))).toEqual(["a.ts", "src/new.ts"]);

    // Грязный до старта файл, который попытка ТОЖЕ правила, — засчитывается.
    write(ws, "neighbour.ts", "а теперь и моя правка\n");
    expect(keys(await touchedSince(snap!))).toEqual(["a.ts", "neighbour.ts", "src/new.ts"]);
  });

  test("закоммиченное внутри попытки — тоже факт, а не пропажа", async () => {
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n" });
    const snap = await snapshotCheckouts(ws, ws);
    write(ws, "lib/b.ts", "b\n");
    sh(ws, "add", "-A");
    sh(ws, "commit", "-q", "-m", "b");
    expect(keys(await touchedSince(snap!))).toEqual(["lib/b.ts"]);
  });

  test("удаление файла — тоже правка", async () => {
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n", "gone.ts": "g\n" });
    const snap = await snapshotCheckouts(ws, ws);
    rmSync(join(ws, "gone.ts"));
    expect(keys(await touchedSince(snap!))).toEqual(["gone.ts"]);
  });

  test("окно нулевой длины — пустой список («ничего не изменилось»), а не null", async () => {
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n" });
    write(ws, "a.ts", "грязно до старта\n");
    const snap = await snapshotCheckouts(ws, ws);
    expect(await touchedSince(snap!)).toEqual([]);
  });

  test("состояние самого myc (.myc/) правкой попытки не считается", async () => {
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n", ".myc/workspace.toml": "slug='x'\n" });
    const snap = await snapshotCheckouts(ws, ws);
    write(ws, ".myc/graph/op.jsonl", "{}\n");
    write(ws, ".myc/anchor-dirty.log", "/x\n");
    write(ws, "a.ts", "a2\n");
    expect(keys(await touchedSince(snap!))).toEqual(["a.ts"]);
  });

  test("каталог не в git и не под корнем — снимка нет", async () => {
    const outside = join(base, "plain");
    mkdirSync(outside);
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n" });
    expect(await snapshotCheckouts(outside, ws)).toBeNull();
  });

  test("дерево, где стояла попытка, удалено — null, а не пустой ответ", async () => {
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n" });
    const snap = await snapshotCheckouts(ws, ws);
    rmSync(ws, { recursive: true, force: true });
    expect(await touchedSince(snap!)).toBeNull();
  });

  test("снимок переживает запись в базу: JSON туда и обратно", async () => {
    const ws = join(base, "ws");
    repo(ws, { "a.ts": "a\n" });
    const snap = await snapshotCheckouts(ws, ws);
    expect(parseGitBase(JSON.stringify(snap))).toEqual(snap);
    expect(parseGitBase("не json")).toBeNull();
    expect(parseGitBase(JSON.stringify({ v: 2, checkouts: [] }))).toBeNull();
  });
});

/**
 * ЭКОСИСТЕМА (S59): корень — свой git, внутри него самостоятельные
 * репозитории. Одна и та же правка обязана дать один и тот же КЛЮЧ, откуда бы
 * попытка ни стартовала: из корня, из вложенного репозитория или из его
 * worktree. Иначе scope одной задачи зависел бы от того, где стоял агент.
 */
describe("вложенные репозитории и worktree", () => {
  let ws: string;

  beforeEach(() => {
    ws = join(base, "eco");
    repo(ws, { "README.md": "root\n", ".gitignore": "svc/\napi/\n.worktrees/\n" });
    repo(join(ws, "svc"), { "x.ts": "x\n", "y.ts": "y\n" });
    repo(join(ws, "api"), { "h.ts": "h\n" });
  });

  test("из корня: снимаются корень и оба вложенных, правка ложится ключом репозитория", async () => {
    const snap = await snapshotCheckouts(ws, ws);
    expect(snap?.checkouts.map((c) => c.prefix)).toEqual(["", "api", "svc"]);
    write(join(ws, "svc"), "x.ts", "x2\n");
    write(join(ws, "api"), "h.ts", "h2\n");
    expect(keys(await touchedSince(snap!))).toEqual(["api:h.ts", "svc:x.ts"]);
  });

  test("из вложенного репозитория — тот же ключ, что из корня", async () => {
    const snap = await snapshotCheckouts(join(ws, "svc"), ws);
    expect(snap?.checkouts.map((c) => c.prefix)).toEqual(["svc"]);
    write(join(ws, "svc"), "x.ts", "x2\n");
    expect(keys(await touchedSince(snap!))).toEqual(["svc:x.ts"]);
  });

  test("из worktree вложенного репозитория вне дерева — тот же ключ, дифф в самом worktree", async () => {
    const wt = join(base, "svc-wt");
    sh(join(ws, "svc"), "worktree", "add", "-q", "-b", "feat", wt);
    const snap = await snapshotCheckouts(wt, ws);
    expect(snap?.checkouts.map((c) => c.prefix)).toEqual(["svc"]);
    write(wt, "x.ts", "правка в worktree\n");
    // Основное дерево в это время грязнят соседи — в дифф worktree это не попадает.
    write(join(ws, "svc"), "y.ts", "сосед в основном дереве\n");
    expect(keys(await touchedSince(snap!))).toEqual(["svc:x.ts"]);
  });

  test("из worktree корня внутри дерева — ключ корня, вложенные не снимаются", async () => {
    const wt = join(ws, ".worktrees", "w1");
    sh(ws, "worktree", "add", "-q", "-b", "feat", wt);
    const snap = await snapshotCheckouts(wt, ws);
    expect(snap?.checkouts.map((c) => c.prefix)).toEqual([""]);
    write(wt, "README.md", "правка в worktree корня\n");
    expect(keys(await touchedSince(snap!))).toEqual(["README.md"]);
  });

  test("worktree внутри дерева не принимается за вложенный репозиторий", async () => {
    sh(join(ws, "svc"), "worktree", "add", "-q", "-b", "feat", join(ws, "svc-wt"));
    const snap = await snapshotCheckouts(ws, ws);
    expect(snap?.checkouts.map((c) => c.prefix)).toEqual(["", "api", "svc"]);
  });
});
