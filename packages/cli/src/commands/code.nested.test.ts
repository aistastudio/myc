/**
 * Код-запросы из вложенного репозитория и из git worktree (memory-m0md9fybwrdh).
 *
 * Воспроизведение cherry: корень воркспейса — git-репозиторий, внутри два
 * НЕЗАВИСИМЫХ git-репозитория (не подмодули), индекс построен из корня
 * (`repo_id = ''`, пути `alpha/src/core.ts`), а один из репозиториев вынесен
 * git worktree ВНЕ дерева воркспейса, на свою ветку с изменённым файлом. До
 * исправления из `alpha` и из worktree каждый читатель отвечал
 * `precond.no_index` и советовал `myc code index` — вторую копию тех же файлов.
 *
 * Все git-операции — НАСТОЯЩИЕ (`git init`, `git worktree add`): связь, которую
 * мы читаем, пишет сам git, и подделка проверяла бы наше представление о ней.
 *
 * МУТАЦИИ ПРИЁМКИ (проверены руками, см. отчёт задачи):
 *   «нет подстановки предка» — `coveringIndex` отдаёт только свой индекс:
 *     краснеют все тесты блока «из вложенного репозитория» и «из worktree»;
 *   «нет WARN» — `warnWorktree` ничего не пишет: краснеет «из worktree:
 *     расхождение ветки названо».
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createCallersCommand } from "./callers.ts";
import { createCodeCommand } from "./code.ts";
import { createSkeletonCommand } from "./skeleton.ts";
import { createTaskCommand } from "./tasks.ts";
import { createStatuslineCommand } from "./statusline.ts";

function git(cwd: string, ...args: string[]): void {
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
}

const CORE_TS = `// ядро идентичности
export interface Identity {
  readonly id: string;
}

export function resolveIdentity(raw: string): Identity {
  return { id: raw.trim() };
}

export class AppIdentityResolver {
  resolve(raw: string): Identity {
    return resolveIdentity(raw);
  }
}
`;

const USE_TS = `import { resolveIdentity } from "./core.ts";

export function useIdentity(): string {
  return resolveIdentity(" x ").id;
}
`;

const BETA_TS = `// другой репозиторий зовёт то же имя
export function betaWork(): string {
  return resolveIdentity("b").id;
}

function resolveIdentity(raw: string): { id: string } {
  return { id: raw };
}
`;

let sandbox: string;
let ws: string;
let alpha: string;
let beta: string;
let wt: string;
let wtSame: string;
let home: string;

function registry(): Registry {
  const r = new Registry();
  r.register(createCodeCommand());
  r.register(createCallersCommand());
  r.register(createSkeletonCommand());
  r.register(createAnchorCommand());
  r.register(createTaskCommand());
  return r;
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown> | null;
  warn: { code: string; msg: string }[];
  error?: { code: string; msg: string; hint?: string };
}

async function myc(dir: string, ...args: string[]): Promise<{ exit: number; env: Envelope }> {
  const r = await run(["-C", dir, ...args, "--json"], {
    registry: registry(),
    env: { MYC_ACTOR: "tester", MYC_HOME: home },
  });
  const out = typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
  return { exit: r.code, env: JSON.parse(out) as Envelope };
}

async function ok(dir: string, ...args: string[]): Promise<Envelope> {
  const r = await myc(dir, ...args);
  if (!r.env.ok) throw new Error(`${args.join(" ")} from ${dir}: ${JSON.stringify(r.env.error)}`);
  return r.env;
}

function rows(sql: string, ...params: string[]): number {
  const d = new Database(join(ws, ".myc", "myc.db"), { readonly: true });
  try {
    return Number((d.query(sql).get(...params) as { n: number }).n);
  } finally {
    d.close();
  }
}

const codeFiles = (): number => rows("SELECT count(*) AS n FROM code_files");
const codeFilesOf = (repo: string): number =>
  rows("SELECT count(*) AS n FROM code_files WHERE repo_id = ?1", repo);

function warnCodes(e: Envelope): string[] {
  return e.warn.map((w) => w.code);
}

beforeAll(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-nested-")));
  ws = join(sandbox, "ws");
  home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(ws, "tools"), { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, "README.md"), "ecosystem root: resolveIdentity lives in alpha\n");
  writeFileSync(join(ws, "tools", "build.ts"), "export function buildAll(): number {\n  return 1;\n}\n");
  writeFileSync(join(ws, ".gitignore"), ".myc/\n");
  git(ws, "add", ".");
  git(ws, "commit", "-qm", "root");

  alpha = join(ws, "alpha");
  mkdirSync(join(alpha, "src"), { recursive: true });
  git(alpha, "init", "-q", "-b", "main");
  writeFileSync(join(alpha, "src", "core.ts"), CORE_TS);
  writeFileSync(join(alpha, "src", "use.ts"), USE_TS);
  git(alpha, "add", ".");
  git(alpha, "commit", "-qm", "alpha");

  beta = join(ws, "beta");
  mkdirSync(join(beta, "lib"), { recursive: true });
  git(beta, "init", "-q", "-b", "main");
  writeFileSync(join(beta, "lib", "beta.ts"), BETA_TS);
  git(beta, "add", ".");
  git(beta, "commit", "-qm", "beta");

  mkdirSync(join(ws, ".myc"));
  const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  // Worktree ВНЕ дерева воркспейса, на своей ветке: файл сдвинут на три строки.
  wt = join(sandbox, "wt-alpha");
  git(alpha, "worktree", "add", "-q", wt, "-b", "feature");
  writeFileSync(join(wt, "src", "core.ts"), `// feature\n// сдвиг\n// ещё\n${CORE_TS}`);
  git(wt, "commit", "-qam", "feature shift");
  // Второй worktree — на ТОМ ЖЕ коммите, что основная копия, и чистый.
  wtSame = join(sandbox, "wt-same");
  git(alpha, "worktree", "add", "-q", wtSame, "-b", "same");

  await ok(ws, "code", "index");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Из корня — как раньше
// ---------------------------------------------------------------------------

describe("из корня воркспейса ответ прежний", () => {
  test("индекс корня: одна строка на файл, все под repo_id ''", () => {
    expect(codeFiles()).toBe(6); // .gitignore, README.md, tools/build.ts, alpha×2, beta×1
    expect(codeFilesOf("")).toBe(6);
  });

  test("grep/symbol/callers/skeleton/map/search: пути с префиксом репозитория, поля source нет", async () => {
    const grep = await ok(ws, "code", "grep", "resolveIdentity");
    const paths = new Set((grep.data!["groups"] as Array<{ path: string }>).map((g) => g.path));
    expect([...paths].sort()).toEqual(["README.md", "alpha/src/core.ts", "alpha/src/use.ts", "beta/lib/beta.ts"]);
    expect(grep.data!["hits"]).toBe(7);

    const sym = await ok(ws, "code", "symbol", "resolveIdentity");
    expect((sym.data!["defs"] as Array<{ path: string }>).map((d) => d.path)).toEqual([
      "alpha/src/core.ts",
      "beta/lib/beta.ts",
    ]);

    const callers = await ok(ws, "callers", "resolveIdentity");
    expect(callers.data!["total_edges"]).toBe(4);

    const sk = await ok(ws, "skeleton", "alpha/src/core.ts");
    expect((sk.data!["entries"] as unknown[]).length).toBe(4);

    const map = await ok(ws, "code", "map");
    expect(map.data!["files"]).toBe(6);

    const search = await ok(ws, "code", "search", "resolve identity");
    expect((search.data!["hits"] as Array<{ path: string }>)[0]!.path).toBe("alpha/src/core.ts");

    for (const e of [grep, sym, callers, sk, map, search]) {
      expect(e.data!["source"]).toBeUndefined();
      expect(warnCodes(e)).not.toContain("code_index.worktree_divergent");
    }
  });
});

// ---------------------------------------------------------------------------
// Из вложенного репозитория — часть индекса корня
// ---------------------------------------------------------------------------

describe("из вложенного репозитория: ответ из индекса корня, пути от репозитория", () => {
  test("grep отвечает только файлами alpha, без префикса", async () => {
    const before = codeFiles();
    const e = await ok(alpha, "code", "grep", "resolveIdentity");
    const paths = [...new Set((e.data!["groups"] as Array<{ path: string }>).map((g) => g.path))].sort();
    expect(paths).toEqual(["src/core.ts", "src/use.ts"]);
    expect(e.data!["hits"]).toBe(4);
    expect(e.data!["repo"]).toBe("alpha");
    const src = e.data!["source"] as { index: { repo: string; prefix: string } };
    expect(src.index).toMatchObject({ repo: "", prefix: "alpha/" });
    // Ни одной строки не добавилось: ответ из того же индекса, дубля нет.
    expect(codeFiles()).toBe(before);
    expect(codeFilesOf("alpha")).toBe(0);
  });

  test("grep --in — путь от корня репозитория", async () => {
    const e = await ok(alpha, "code", "grep", "resolveIdentity", "--in", "src/use.ts");
    expect(e.data!["scope"]).toEqual(["src/use.ts"]);
    expect(e.data!["hits"]).toBe(2);
  });

  test("symbol, callers, skeleton, map, search — пути от alpha, чужой репозиторий не виден", async () => {
    const sym = await ok(alpha, "code", "symbol", "resolveIdentity");
    expect((sym.data!["defs"] as Array<{ path: string }>).map((d) => d.path)).toEqual(["src/core.ts"]);

    const callers = await ok(alpha, "callers", "resolveIdentity");
    const edges = callers.data!["edges"] as Array<{ path: string; caller: string }>;
    expect(edges.map((x) => `${x.caller}@${x.path}`).sort()).toEqual([
      "@src/use.ts",
      "resolve@src/core.ts",
      "useIdentity@src/use.ts",
    ]);

    const sk = await ok(alpha, "skeleton", "src/core.ts");
    expect(sk.data!["path"]).toBe("src/core.ts");
    expect(sk.data!["stale"]).toBe(false);
    expect((sk.data!["entries"] as Array<{ signature: string }>)[1]!.signature).toBe(
      "export function resolveIdentity(raw: string): Identity",
    );

    const map = await ok(alpha, "code", "map");
    expect(map.data!["repo"]).toBe("alpha");
    expect(map.data!["files"]).toBe(2);
    expect((map.data!["clusters"] as Array<{ dir: string }>).map((c) => c.dir)).toEqual(["src"]);

    const search = await ok(alpha, "code", "search", "resolve identity");
    const hitPaths = (search.data!["hits"] as Array<{ path: string }>).map((x) => x.path);
    expect(hitPaths).toContain("src/core.ts");
    expect(hitPaths.every((p) => !p.startsWith("alpha/") && !p.startsWith("beta/"))).toBe(true);

    // Из подкаталога репозитория — тот же ответ: охват выводится по репозиторию.
    const deep = await ok(join(alpha, "src"), "code", "symbol", "resolveIdentity");
    expect((deep.data!["defs"] as Array<{ path: string }>).map((d) => d.path)).toEqual(["src/core.ts"]);
  });

  test("fan_in части кешируется под своим ключом и не портит счёт корня", async () => {
    const part = await ok(alpha, "code", "symbol", "resolveIdentity");
    const whole = await ok(ws, "code", "symbol", "resolveIdentity");
    const fp = part.data!["fan_in"] as { n: number; files: number };
    const fw = whole.data!["fan_in"] as { n: number; files: number };
    expect(fp.files).toBe(2); // core.ts (вызов в resolve) + use.ts
    expect(fw.files).toBe(3); // плюс beta.ts
    // Повтор — из кеша, и число то же.
    const again = await ok(alpha, "code", "symbol", "resolveIdentity");
    expect((again.data!["fan_in"] as { cached: boolean; n: number }).cached).toBe(true);
    expect((again.data!["fan_in"] as { n: number }).n).toBe(fp.n);
  });
});

// ---------------------------------------------------------------------------
// Из git worktree — индекс основной копии, расхождение названо
// ---------------------------------------------------------------------------

describe("из worktree: индекс основной копии и громкое расхождение", () => {
  test("все шесть читателей отвечают; расхождение ветки названо (И2)", async () => {
    const before = codeFiles();
    const answers = [
      await ok(wt, "code", "grep", "resolveIdentity"),
      await ok(wt, "code", "symbol", "resolveIdentity"),
      await ok(wt, "callers", "resolveIdentity"),
      await ok(wt, "skeleton", "src/core.ts"),
      await ok(wt, "code", "map"),
      await ok(wt, "code", "search", "resolve identity"),
    ];
    for (const e of answers) {
      expect(warnCodes(e)).toContain("code_index.worktree_divergent");
      const w = e.warn.find((x) => x.code === "code_index.worktree_divergent")!;
      expect(w.msg).toContain("main @");
      expect(w.msg).toContain("feature @");
      expect(w.msg).toContain(join(ws, "alpha"));
      const src = e.data!["source"] as { worktree: { divergent: boolean; branch: string; main_branch: string } };
      expect(src.worktree.divergent).toBe(true);
      expect(src.worktree.branch.startsWith("feature @")).toBe(true);
      expect(src.worktree.main_branch.startsWith("main @")).toBe(true);
    }
    expect(codeFiles()).toBe(before);
  });

  test("grep читает файлы worktree: номера строк — ветки агента", async () => {
    const e = await ok(wt, "code", "grep", "export function resolveIdentity");
    const g = (e.data!["groups"] as Array<{ path: string; hits: Array<{ line: number }> }>)[0]!;
    expect(g.path).toBe("src/core.ts");
    expect(g.hits[0]!.line).toBe(9); // в основной копии это строка 6
    expect((e.data!["source"] as { files: string }).files).toBe(wt);
  });

  test("skeleton показывает основную копию и называет это, а не режет файл ветки чужими спанами", async () => {
    const e = await ok(wt, "skeleton", "src/core.ts");
    expect(warnCodes(e)).toContain("skeleton.main_copy");
    expect((e.data!["entries"] as Array<{ signature: string }>)[1]!.signature).toBe(
      "export function resolveIdentity(raw: string): Identity",
    );
    expect((e.data!["source"] as { files: string }).files).toBe(join(ws, "alpha"));
  });

  test("тот же коммит и чистое дерево — WARN нет; правка отслеживаемого файла — есть", async () => {
    const clean = await ok(wtSame, "code", "symbol", "resolveIdentity");
    expect(warnCodes(clean)).not.toContain("code_index.worktree_divergent");
    expect((clean.data!["source"] as { worktree: { divergent: boolean } }).worktree.divergent).toBe(false);

    writeFileSync(join(wtSame, "src", "use.ts"), `${USE_TS}// правка\n`);
    try {
      const dirty = await ok(wtSame, "code", "symbol", "resolveIdentity");
      expect(warnCodes(dirty)).toContain("code_index.worktree_divergent");
      expect(dirty.warn.find((x) => x.code === "code_index.worktree_divergent")!.msg).toContain(
        "uncommitted changes",
      );
    } finally {
      git(wtSame, "checkout", "--", "src/use.ts");
    }
  });
});

// ---------------------------------------------------------------------------
// Якоря: один файл, два ключа — видны с обеих сторон
// ---------------------------------------------------------------------------

describe("якоря из корня, из репозитория и из worktree сходятся в code symbol", () => {
  test("три якоря на resolveIdentity видны из корня, из alpha и из worktree", async () => {
    const fromRoot = (await ok(ws, "task", "якорь из корня")).data!["id"] as string;
    await ok(ws, "anchor", "add", fromRoot, "alpha/src/core.ts:6-8");
    const fromRepo = (await ok(alpha, "task", "якорь из alpha")).data!["id"] as string;
    await ok(alpha, "anchor", "add", fromRepo, "src/core.ts:7");
    const fromWt = (await ok(wt, "task", "якорь из worktree")).data!["id"] as string;
    // В worktree функция на строке 9-11 — но якорь пишется путём репозитория.
    await ok(wt, "anchor", "add", fromWt, "src/core.ts:6-8");

    for (const dir of [ws, alpha, wt]) {
      const e = await ok(dir, "code", "symbol", "resolveIdentity");
      const def = (e.data!["defs"] as Array<{ path: string; knowledge: Array<{ id: string; anchor: string }> }>).find(
        (d) => d.path.endsWith("src/core.ts"),
      )!;
      const ids = def.knowledge.map((k) => k.id).sort();
      expect(ids).toEqual([fromRoot, fromRepo, fromWt].sort());
      // Путь якоря — в терминах спросившего.
      for (const k of def.knowledge) expect(k.anchor.startsWith(`${def.path}:`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// myc code index во вложенном репозитории — часть индекса корня, не дубль
// ---------------------------------------------------------------------------

describe("code index из вложенного репозитория обновляет свою часть индекса корня", () => {
  test("новая функция в alpha видна из корня; строк под repo_id 'alpha' нет; beta не тронута", async () => {
    const beforeTotal = codeFiles();
    writeFileSync(join(alpha, "src", "extra.ts"), "export function freshlyAdded(): number {\n  return 2;\n}\n");
    try {
      const e = await ok(alpha, "code", "index");
      expect(e.data!["into"]).toMatchObject({ repo: "", prefix: "alpha/", root: ws });
      expect(e.data!["files"]).toBe(3); // часть alpha/ после прогона
      expect(codeFilesOf("alpha")).toBe(0);
      expect(codeFiles()).toBe(beforeTotal + 1);
      const fromRoot = await ok(ws, "code", "symbol", "freshlyAdded");
      expect((fromRoot.data!["defs"] as Array<{ path: string }>)[0]!.path).toBe("alpha/src/extra.ts");
      const fromAlpha = await ok(alpha, "code", "search", "freshly added");
      expect((fromAlpha.data!["hits"] as Array<{ path: string }>)[0]!.path).toBe("src/extra.ts");
    } finally {
      rmSync(join(alpha, "src", "extra.ts"));
    }
    // Удаление видит только часть alpha/: файлы beta и корня не «исчезают».
    const e2 = await ok(alpha, "code", "index");
    expect((e2.data!["scan"] as { removed: number }).removed).toBe(1);
    expect(codeFiles()).toBe(beforeTotal);
    expect(codeFilesOf("")).toBe(beforeTotal);
  });

  test("из worktree code index обновляет часть основной копии и говорит, что проиндексировал не worktree", async () => {
    const before = codeFiles();
    const e = await ok(wt, "code", "index");
    expect(e.data!["into"]).toMatchObject({ prefix: "alpha/" });
    const w = e.warn.find((x) => x.code === "code_index.worktree_divergent");
    expect(w?.msg).toContain("indexed the main copy");
    expect(codeFiles()).toBe(before);
    // Спан основной копии, а не сдвинутый файл ветки.
    const sym = await ok(ws, "code", "symbol", "resolveIdentity");
    expect((sym.data!["defs"] as Array<{ span_start: number }>)[0]!.span_start).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Совет «строить» больше не строит дубль
// ---------------------------------------------------------------------------

describe("precond.no_index советует то, что не создаст дубля", () => {
  test("индекса нет нигде — строить из корня воркспейса, путь напечатан", async () => {
    const s2 = realpathSync(mkdtempSync(join(tmpdir(), "myc-nested-empty-")));
    try {
      const w2 = join(s2, "ws");
      mkdirSync(join(w2, "gamma", "src"), { recursive: true });
      git(w2, "init", "-q", "-b", "main");
      git(join(w2, "gamma"), "init", "-q", "-b", "main");
      writeFileSync(join(w2, "gamma", "src", "g.ts"), "export const g = 1;\n");
      mkdirSync(join(w2, ".myc"));
      const raw = new Database(join(w2, ".myc", "myc.db"), { create: true });
      await migrate(raw, { migrations, writable: true });
      raw.close();
      for (const args of [
        ["code", "grep", "g"],
        ["code", "symbol", "g"],
        ["code", "search", "g"],
        ["code", "map"],
        ["callers", "g"],
        ["skeleton", "src/g.ts"],
      ]) {
        const r = await myc(join(w2, "gamma"), ...args);
        expect(r.env.error?.code).toBe("precond.no_index");
        expect(r.env.error?.hint).toContain(`myc -C ${w2} code index`);
      }
    } finally {
      rmSync(s2, { recursive: true, force: true });
    }
  });

  test("индекс корня старше нового репозитория — переиндексировать корень, а не строить свой", async () => {
    mkdirSync(join(ws, "fresh", "src"), { recursive: true });
    git(join(ws, "fresh"), "init", "-q", "-b", "main");
    writeFileSync(join(ws, "fresh", "src", "f.ts"), "export function freshRepoFn(): number {\n  return 3;\n}\n");
    try {
      const r = await myc(join(ws, "fresh"), "code", "grep", "freshRepoFn");
      expect(r.env.error?.code).toBe("precond.no_index");
      expect(r.env.error?.hint).toContain(`myc -C ${ws} code index`);
      // И `code index` отсюда кладёт его в индекс корня, а не заводит свой.
      const e = await ok(join(ws, "fresh"), "code", "index");
      expect(e.data!["into"]).toMatchObject({ repo: "", prefix: "fresh/" });
      expect(codeFilesOf("fresh")).toBe(0);
      const sym = await ok(ws, "code", "symbol", "freshRepoFn");
      expect((sym.data!["defs"] as Array<{ path: string }>)[0]!.path).toBe("fresh/src/f.ts");
    } finally {
      rmSync(join(ws, "fresh"), { recursive: true, force: true });
      await ok(ws, "code", "index"); // вернуть индекс корня к фикстуре
    }
  });

  test("git корня игнорирует репозиторий — индекс корня его не возьмёт, свой индекс не дубль", async () => {
    writeFileSync(join(ws, ".gitignore"), ".myc/\nhidden/\n");
    mkdirSync(join(ws, "hidden", "src"), { recursive: true });
    git(join(ws, "hidden"), "init", "-q", "-b", "main");
    writeFileSync(join(ws, "hidden", "src", "h.ts"), "export const h = 1;\n");
    try {
      const r = await myc(join(ws, "hidden"), "code", "grep", "h");
      expect(r.env.error?.code).toBe("precond.no_index");
      expect(r.env.error?.hint).toContain(`myc -C ${join(ws, "hidden")} code index`);
      expect(r.env.error?.msg).toContain("ignores hidden/");
    } finally {
      rmSync(join(ws, "hidden"), { recursive: true, force: true });
      writeFileSync(join(ws, ".gitignore"), ".myc/\n");
    }
  });
});

// ---------------------------------------------------------------------------
// Worktree ВНУТРИ дерева воркспейса (вторая форма: wt-beta рядом с beta)
// ---------------------------------------------------------------------------

describe("worktree внутри дерева воркспейса", () => {
  test("охват — основное дерево, ответ из его части индекса, расхождение названо", async () => {
    const inTree = join(ws, "wt-beta");
    git(beta, "worktree", "add", "-q", inTree, "-b", "wtb");
    writeFileSync(join(inTree, "lib", "beta.ts"), `// ветка wtb\n${BETA_TS}`);
    git(inTree, "commit", "-qam", "wtb shift");
    try {
      const e = await ok(inTree, "code", "grep", "betaWork");
      expect(e.data!["repo"]).toBe("beta");
      const g = (e.data!["groups"] as Array<{ path: string; hits: Array<{ line: number }> }>)[0]!;
      expect(g.path).toBe("lib/beta.ts");
      expect(g.hits[0]!.line).toBe(3); // строка файла ветки: в основной копии — 2
      const src = e.data!["source"] as { index: { prefix: string }; worktree: { dir: string } };
      expect(src.index.prefix).toBe("beta/");
      expect(src.worktree.dir).toBe(inTree);
      expect(warnCodes(e)).toContain("code_index.worktree_divergent");
    } finally {
      git(beta, "worktree", "remove", "--force", inTree);
    }
  });

  /**
   * memory-5vcctcvga6k0: worktree глубже первого уровня (`.claude/worktrees/x`
   * — так их заводят агенты). Охват — основное дерево (`beta`), и файлы
   * читаются в самом worktree, а не в основной копии: охват и чтение обязаны
   * согласиться, что это worktree. МУТАЦИЯ: `worktreeOf` по одному первому
   * сегменту (прежнее правило) — строка 2 основной копии вместо 3 ветки и нет
   * `source.worktree`; `deriveRepoAcrossWorktrees` только первого уровня —
   * охват `''`.
   */
  test("worktree в .claude/worktrees: охват — основное дерево, файлы — из worktree", async () => {
    const deep = join(ws, ".claude", "worktrees", "agent-b");
    git(beta, "worktree", "add", "-q", deep, "-b", "wtdeep");
    writeFileSync(join(deep, "lib", "beta.ts"), `// ветка wtdeep\n${BETA_TS}`);
    git(deep, "commit", "-qam", "wtdeep shift");
    try {
      const e = await ok(join(deep, "lib"), "code", "grep", "betaWork");
      expect(e.data!["repo"]).toBe("beta");
      const g = (e.data!["groups"] as Array<{ path: string; hits: Array<{ line: number }> }>)[0]!;
      expect(g.path).toBe("lib/beta.ts");
      expect(g.hits[0]!.line).toBe(3); // строка файла ветки: в основной копии — 2
      const src = e.data!["source"] as { index: { prefix: string }; worktree: { dir: string } };
      expect(src.index.prefix).toBe("beta/");
      expect(src.worktree.dir).toBe(deep);
    } finally {
      git(beta, "worktree", "remove", "--force", deep);
      rmSync(join(ws, ".claude"), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Дубль, построенный до правила, назван вслух
// ---------------------------------------------------------------------------

describe("свой индекс вложенного репозитория поверх части корня — code_index.duplicate", () => {
  test("code index из beta со старым своим индексом предупреждает о двух копиях", async () => {
    const d = new Database(join(ws, ".myc", "myc.db"));
    try {
      // Строка своего индекса beta — как её оставил бы прогон до этого правила.
      d.query(
        "INSERT INTO code_files (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at) VALUES ('beta', 'lib/beta.ts', 'ts', 0, 0, '', 0)",
      ).run();
    } finally {
      d.close();
    }
    try {
      const e = await ok(beta, "code", "index");
      expect(e.data!["into"]).toBeUndefined();
      expect(warnCodes(e)).toContain("code_index.duplicate");
      // Запрос отсюда берёт свой (ближайший) индекс — поля source нет.
      const sym = await ok(beta, "code", "symbol", "betaWork");
      expect(sym.data!["source"]).toBeUndefined();
    } finally {
      const x = new Database(join(ws, ".myc", "myc.db"));
      try {
        x.query("DELETE FROM code_fts WHERE rowid IN (SELECT id FROM code_units WHERE repo_id = 'beta')").run();
        for (const t of ["code_units", "code_ref_sites", "code_defs", "code_files", "code_refs"]) {
          x.query(`DELETE FROM ${t} WHERE repo_id = 'beta'`).run();
        }
      } finally {
        x.close();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Строка статуса — тот же ближайший индекс
// ---------------------------------------------------------------------------

describe("строка статуса из вложенного репозитория и worktree", () => {
  // Раньше сегмент кода считался по своему repo_id и из вложенного репо
  // говорил «no code index» — там, где код-команды уже отвечают.
  async function codeSegment(dir: string, tag: string): Promise<{ state: string; files: number }> {
    const r = new Registry();
    r.register(
      createStatuslineCommand({
        selfExit: false,
        readStdin: () =>
          new TextEncoder().encode(`${JSON.stringify({ session_id: `sl-${tag}`, cwd: dir, workspace: { current_dir: dir } })}\n`),
        cacheDir: join(sandbox, `sl-cache-${tag}`),
        env: { CLAUDE_CONFIG_DIR: join(sandbox, "sl-cfg"), MYC_MODELS_DIR: join(sandbox, "sl-models") },
      }),
    );
    const out = await run(["-C", dir, "statusline", "--json"], { registry: r, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
    expect(out.code).toBe(0);
    const code = (JSON.parse(out.stdout as string) as { data: { code: { state: string; files: number } } }).data.code;
    return { state: code.state, files: code.files };
  }

  test("вложенный репозиторий: его часть индекса корня (2 файла alpha), а не «none»", async () => {
    expect(await codeSegment(alpha, "alpha")).toEqual({ state: "ok", files: 2 });
  });

  test("worktree вне дерева: та же часть основной копии", async () => {
    expect(await codeSegment(wt, "wt")).toEqual({ state: "ok", files: 2 });
  });

  test("корень: весь индекс, как раньше", async () => {
    expect(await codeSegment(ws, "root")).toEqual({ state: "ok", files: 6 });
  });
});
