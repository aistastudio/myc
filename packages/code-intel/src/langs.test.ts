/**
 * Перечень файлов индекса (memory-rda12hcf2dt1): git там, где он есть, обход —
 * там, где его нет, и НАЗВАННЫЙ обход, а не молчаливый.
 *
 * Фикстура повторяет устройство cherry: корень — git-репозиторий, внутри —
 * независимый вложенный репозиторий (для корня это `?? nested/`), подмодуль,
 * worktree (`.git` — файл-указатель) и репозиторий второго уровня. В корне —
 * игнорируемое, ради которого задача и заведена: ключи, карточки graft, .data.
 * git здесь настоящий, `git init` во временном каталоге; глобальные настройки
 * пользователя отрезаны — его `~/.config/git/ignore` не должен решать исход.
 *
 * Три мутации приёмки обязаны ронять этот файл:
 *   «.gitignore не соблюдается»        — ключи попадают в перечень;
 *   «вложенный репозиторий не обходится» — его файлы пропадают;
 *   «git упал → пустота без обхода»     — перечень пуст и без предупреждения.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { langOf, listFiles, listFilesSync, walkFiles } from "./langs.ts";

const HERMETIC = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: "",
} as const;
const saved: Record<string, string | undefined> = {};
let xdg: string;

beforeAll(() => {
  xdg = mkdtempSync(join(tmpdir(), "myc-list-xdg-"));
  for (const [k, v] of Object.entries(HERMETIC)) {
    saved[k] = process.env[k];
    process.env[k] = k === "XDG_CONFIG_HOME" ? xdg : v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(xdg, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    [
      "git",
      "-c", "user.name=t",
      "-c", "user.email=t@t",
      "-c", "commit.gpgsign=false",
      "-c", "init.defaultBranch=main",
      "-c", "protocol.file.allow=always",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function put(base: string, rel: string, content = `${rel}\n`): void {
  const abs = join(base, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

let work: string;
let root: string;

/** Корень cherry в миниатюре; перечень, который обязан получиться, — EXPECTED. */
function buildFixture(): void {
  work = mkdtempSync(join(tmpdir(), "myc-list-"));
  root = join(work, "root");
  put(work, "outside.txt", "за корнем\n");

  // Источник подмодуля — вне дерева.
  const subsrc = join(work, "subsrc");
  mkdirSync(subsrc);
  git(subsrc, "init", "-q");
  put(subsrc, "s.ts", "export const s = 1;\n");
  git(subsrc, "add", ".");
  git(subsrc, "commit", "-qm", "s");

  mkdirSync(root);
  git(root, "init", "-q");
  put(root, ".gitignore", "keys/\ngraft/\n.data/\n");
  put(root, "src/a.ts", "export const tracked = 'NEEDLE-TRACKED';\n");
  put(root, "src/gone.ts", "export const gone = 1;\n");
  symlinkSync("../../outside.txt", join(root, "src", "tracked-link.ts"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "root");
  rmSync(join(root, "src", "gone.ts")); // отслеживается, но удалён из рабочего дерева

  // Игнорируемое корнем — то, чего в перечне быть не должно.
  put(root, "keys/worker-1.json", '{"secret":"SECRET-KEY-MATERIAL"}\n');
  put(root, "graft/card.md", "# карточка graft\n");
  put(root, ".data/blob.json", "{}\n");
  // Неотслеживаемое, но не игнорируемое — в перечне.
  put(root, "notes.txt");
  put(root, "plain/p.txt");
  // Никем не игнорируемое, но это состояние, а не код: SKIP_DIRS поверх git.
  put(root, "node_modules/dep.js");
  put(root, ".myc/state.json");
  // Симлинк за корень: git его перечисляет, перечень — нет.
  symlinkSync("../outside.txt", join(root, "link-out.txt"));
  symlinkSync(work, join(root, "dir-out"));

  // Независимый вложенный репозиторий: для корня это `?? nested/`.
  const nested = join(root, "nested");
  mkdirSync(nested);
  git(nested, "init", "-q");
  put(nested, ".gitignore", "secrets/\n");
  put(nested, "n.ts", "export const n = 1;\n");
  // Корень игнорирует `graft/` на любой глубине — но внутри nested решает ЕГО git.
  put(nested, "graft/card2.md", "# своя карточка\n");
  // Отслеживаемый файл под игнорируемым каталогом: git перечисляет его всё
  // равно — но только СВОИМ индексом. Чужой индекс (GIT_DIR корня) его не знает.
  put(nested, "secrets/README.md");
  git(nested, "add", ".");
  git(nested, "add", "-f", "secrets/README.md");
  git(nested, "commit", "-qm", "n");
  put(nested, "draft.md");
  put(nested, "secrets/deploy.pem");

  // Подмодуль: gitlink в индексе корня, `.git` — файл-указатель.
  git(root, "submodule", "add", "-q", subsrc, "sub");
  git(root, "commit", "-qm", "sub");

  // Worktree вложенного репозитория, лежащий внутри корня: `.git` — файл.
  git(nested, "worktree", "add", "-q", join(root, "wt"));

  // Репозиторий второго уровня: его называет ответ git корня, а не первая волна.
  const inner = join(root, "libs", "inner");
  mkdirSync(inner, { recursive: true });
  git(inner, "init", "-q");
  put(inner, "i.ts", "export const i = 1;\n");
  git(inner, "add", ".");
  git(inner, "commit", "-qm", "i");
}

const EXPECTED = [
  ".gitignore",
  ".gitmodules",
  "libs/inner/i.ts",
  "nested/.gitignore",
  "nested/draft.md",
  "nested/graft/card2.md",
  "nested/n.ts",
  "nested/secrets/README.md",
  "notes.txt",
  "plain/p.txt",
  "src/a.ts",
  "sub/s.ts",
  "wt/.gitignore",
  "wt/graft/card2.md",
  "wt/n.ts",
  "wt/secrets/README.md",
];

describe("перечень git-дерева", () => {
  beforeEach(buildFixture);
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  test("ровно ожидаемый набор: без игнорируемого, со всеми вложенными репозиториями", async () => {
    const l = await listFiles(root);
    expect([...l.files]).toEqual(EXPECTED);
    expect([...l.gitRepos].sort()).toEqual([".", "libs/inner", "nested", "sub", "wt"]);
    expect(l.unignored).toEqual([]);
  });

  test("игнорируемое корнем не просачивается ни одним путём", async () => {
    const l = await listFiles(root);
    const leaked = l.files.filter(
      (p) => p.startsWith("keys/") || p.startsWith("graft/") || p.startsWith(".data/"),
    );
    expect(leaked).toEqual([]);
    // Игнор вложенного репозитория — его собственный.
    expect(l.files).not.toContain("nested/secrets/deploy.pem");
  });

  test("GIT_DIR из окружения (myc из git-хука) не уводит вложенные репозитории в чужой индекс", async () => {
    const was = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, ".git");
    try {
      const l = await listFiles(root);
      expect([...l.files]).toEqual(EXPECTED);
    } finally {
      if (was === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = was;
    }
  });

  test("синхронный перечень совпадает с асинхронным, walkFiles — с его файлами", async () => {
    const a = await listFiles(root);
    const s = listFilesSync(root);
    expect(s).toEqual(a);
    expect(walkFiles(root)).toEqual([...a.files]);
  });

  test("git упал (битый индекс корня): обход с предупреждением, не пустота", async () => {
    writeFileSync(join(root, ".git", "index"), "это не индекс git");
    const l = await listFiles(root);
    expect(l.unignored.length).toBe(1);
    expect(l.unignored[0]!.dir).toBe(".");
    expect(l.unignored[0]!.reason).toMatch(/git ls-files failed \(exit 128\)/);
    // Обход не знает .gitignore — и это названо выше, а не спрятано.
    expect(l.files).toContain("src/a.ts");
    expect(l.files).toContain("keys/worker-1.json");
    // Вложенные репозитории исправны — их перечисляет их git и дальше.
    expect([...l.gitRepos].sort()).toEqual(["libs/inner", "nested", "sub", "wt"]);
    expect(l.files).toContain("nested/n.ts");
    expect(l.files).not.toContain("nested/secrets/deploy.pem");
    // Симлинки и SKIP_DIRS обход не берёт так же, как не брал.
    expect(l.files).not.toContain("link-out.txt");
    expect(l.files.some((p) => p.startsWith("node_modules/") || p.startsWith(".myc/"))).toBe(false);
  });

  test("git не запускается: одно предупреждение на всё дерево и полный обход", async () => {
    const l = await listFiles(root, { git: join(work, "no-such-git") });
    expect(l.unignored.length).toBe(1);
    expect(l.unignored[0]!.dir).toBe(".");
    expect(l.unignored[0]!.reason).toMatch(/git not runnable/);
    expect(l.gitRepos).toEqual([]);
    expect(l.files).toContain("nested/secrets/deploy.pem");
    expect(l.files).toContain("keys/worker-1.json");
    expect(l.files).not.toContain("nested/.git");
  });
});

describe("перечень не-git дерева", () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "myc-list-plain-"));
    root = join(work, "tree");
    put(root, "a.ts");
    put(root, ".gitignore", "keys/\n");
    put(root, "keys/k.json");
    put(root, "node_modules/x.js");
    put(root, ".myc/s.json");
    const inner = join(root, "inner");
    mkdirSync(inner);
    git(inner, "init", "-q");
    put(inner, ".gitignore", "tmp/\n");
    put(inner, "i.ts");
    git(inner, "add", ".");
    git(inner, "commit", "-qm", "i");
    put(inner, "tmp/t.js");
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  test("обход с SKIP_DIRS, корень назван в unignored, вложенный репозиторий — своим git", async () => {
    const l = await listFiles(root);
    expect([...l.files]).toEqual([".gitignore", "a.ts", "inner/.gitignore", "inner/i.ts", "keys/k.json"]);
    expect(l.unignored).toEqual([{ dir: ".", reason: "not a git repository" }]);
    expect(l.gitRepos).toEqual(["inner"]);
  });
});

describe("langOf", () => {
  test("расширение — только из имени файла", () => {
    expect(langOf("src/a.ts")).toBe("ts");
    expect(langOf("a.TSX")).toBe("tsx");
    expect(langOf("lib/x.cjs")).toBe("js");
    expect(langOf("docs/r.md")).toBe("md");
    // Точка в каталоге пути — не расширение: раньше это давало «язык»
    // `dolt/noms/vvvv…`.
    expect(langOf(".beads/embeddeddolt/memory/.dolt/noms/vvvvvvvvvvvvvvvv")).toBe("");
    expect(langOf(".beads/hooks/pre-commit")).toBe("");
    expect(langOf("dir.d/file")).toBe("");
    // Ведущая точка имени — тоже нет, как у extname и у `langOf` якорей.
    expect(langOf(".gitignore")).toBe("");
    expect(langOf("src/.env")).toBe("");
    expect(langOf("x/.ts")).toBe("");
    expect(langOf("Makefile")).toBe("");
    expect(langOf("file.")).toBe("");
  });
});
