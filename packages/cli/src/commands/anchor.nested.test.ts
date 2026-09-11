/**
 * Якоря файла вложенного репозитория — под ОБОИМИ ключами, откуда бы ни
 * смотрели (memory-9s21yc2kshma).
 *
 * Воспроизведение cherry: корень воркспейса — git-репозиторий, внутри
 * независимый репозиторий `alpha`, у него worktree ВНЕ дерева (`wt-alpha`
 * рядом с воркспейсом) и два worktree ВНУТРИ дерева: `.claude/worktrees/in`
 * (так их кладёт Claude Code) и `alpha/.worktrees/w2`. Якорь, поставленный из
 * корня, лежит ключом `('', 'alpha/src/x.ts')`, из alpha — `('alpha',
 * 'src/x.ts')`. До исправления `code symbol` читал оба ключа, а `anchor
 * of/check/rm` и пометка хука — только ключ спросившего: из alpha не было
 * видно якорей корня, и наоборот.
 *
 * Все git-операции — НАСТОЯЩИЕ (`git init`, `git worktree add`): связь,
 * которую мы читаем, пишет сам git.
 *
 * МУТАЦИИ ПРИЁМКИ (проверены руками, числа — в отчёте задачи):
 *   «of читает один ключ»         — `queryAnchorsOfFile` спрашивает только
 *                                    `anchorKeysFor(...)[0]`: краснеет «of видит оба»;
 *   «check — охват по ключу»      — `SQL_SWEEP_BATCH` без отрезка корня под `R/`:
 *                                    краснеет «check из alpha помечает оба»;
 *   «журнал — один ключ файла»    — грязная половина батча ищет только
 *                                    `anchorKeysFor(p)[0]` или `from_dirty` считает
 *                                    по `path`: краснеют тесты touch (батч в 2);
 *   «корень строки — от вызова»   — старая строка без `repo_root` читается от
 *                                    корня спросившего: краснеет «строка без repo_root»;
 *   «нет worktree внутри дерева»  — `inTreeWorktree` отдаёт undefined: краснеют
 *                                    of/touch/add из `.claude/worktrees/in` и `alpha/.worktrees/w2`;
 *   «rm сравнивает строку path»   — краснеет «rm из alpha снимает якорь корня»;
 *   «перечень не пропускает worktree» — краснеет блок индекса.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand, wsPathOfFile } from "./anchor.ts";
import { createCodeCommand } from "./code.ts";
import { createTaskCommand } from "./tasks.ts";

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

/** Файл с функцией на строках 3-5 — достаточно, чтобы спан был не весь файл. */
function source(name: string): string {
  return `// ${name}
// второй комментарий
export function ${name}(a: number): number {
  return a + 1;
}

export const tail_${name} = 1;
`;
}

/** То же место, но тело переписано: якорь обязан стать stale. */
function rewritten(name: string): string {
  return `// ${name}
// второй комментарий
export function ${name}(a: number): number {
  const unrelated = [a, a, a].map((x) => x * 7).join("-");
  throw new Error(unrelated);
}

export const tail_${name} = 1;
`;
}

const FILES = ["core", "chk1", "chk2", "chk3", "old", "tch1", "tch2", "tch3", "tch4", "rm1", "addin"] as const;

let sandbox: string;
let ws: string;
let alpha: string;
let wtOut: string;
let wtIn: string;
let wtRepo: string;
let home: string;

function registry(): Registry {
  const r = new Registry();
  r.register(createAnchorCommand());
  r.register(createTaskCommand());
  r.register(createCodeCommand());
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

async function text(dir: string, ...args: string[]): Promise<string> {
  const r = await run(["-C", dir, ...args], {
    registry: registry(),
    env: { MYC_ACTOR: "tester", MYC_HOME: home },
  });
  return typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
}

function db(): Database {
  return new Database(join(ws, ".myc", "myc.db"), { readonly: true });
}

function keyOf(anchorId: string): { repo_id: string; path: string } {
  const d = db();
  try {
    return d.query("SELECT repo_id, path FROM anchors WHERE node_id = ?1").get(anchorId) as {
      repo_id: string;
      path: string;
    };
  } finally {
    d.close();
  }
}

let taskSeq = 0;

/** Задача и якорь на неё; отдаёт id якоря. Заголовок уникален: одинаковый узел база не примет. */
async function anchorFrom(dir: string, target: string): Promise<string> {
  const id = (await ok(dir, "task", `якорь ${++taskSeq} на ${target} из ${dir}`)).data!["id"] as string;
  return (await ok(dir, "anchor", "add", id, target)).data!["anchor_id"] as string;
}

interface OfSpanLike {
  anchor_id: string;
  path: string;
  start: number;
  end: number;
}

async function anchorsOf(dir: string, target: string): Promise<OfSpanLike[]> {
  return (await ok(dir, "anchor", "of", target)).data!["spans"] as OfSpanLike[];
}

beforeAll(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-anchor-nested-")));
  ws = join(sandbox, "ws");
  home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, "README.md"), "ecosystem root\n");
  writeFileSync(join(ws, ".gitignore"), ".myc/\n");
  git(ws, "add", ".");
  git(ws, "commit", "-qm", "root");

  alpha = join(ws, "alpha");
  mkdirSync(join(alpha, "src"), { recursive: true });
  git(alpha, "init", "-q", "-b", "main");
  for (const f of FILES) writeFileSync(join(alpha, "src", `${f}.ts`), source(f));
  git(alpha, "add", ".");
  git(alpha, "commit", "-qm", "alpha");

  mkdirSync(join(ws, ".myc"));
  const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  // worktree ВНЕ дерева: его находит ссылка (`h.worktree`).
  wtOut = join(sandbox, "wt-alpha");
  git(alpha, "worktree", "add", "-q", wtOut, "-b", "feature");
  // worktree ВНУТРИ дерева: поиск воркспейса находит корень подъёмом,
  // и ссылки у хендла нет.
  wtIn = join(ws, ".claude", "worktrees", "in");
  git(alpha, "worktree", "add", "-q", wtIn, "-b", "in-tree");
  wtRepo = join(alpha, ".worktrees", "w2");
  git(alpha, "worktree", "add", "-q", wtRepo, "-b", "in-repo");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Схема ключа: два ключа в базе, запись не меняется
// ---------------------------------------------------------------------------

let fromRoot: string;
let fromRepo: string;

describe("один файл — два ключа, записанных как раньше", () => {
  test("якорь из корня лежит ключом корня, из alpha — ключом alpha; миграции нет", async () => {
    fromRoot = await anchorFrom(ws, "alpha/src/core.ts:3-5");
    fromRepo = await anchorFrom(alpha, "src/core.ts:4");
    expect(keyOf(fromRoot)).toEqual({ repo_id: "", path: "alpha/src/core.ts" });
    expect(keyOf(fromRepo)).toEqual({ repo_id: "alpha", path: "src/core.ts" });
  });
});

// ---------------------------------------------------------------------------
// anchor of — откуда бы ни звали
// ---------------------------------------------------------------------------

describe("anchor of видит оба ключа отовсюду", () => {
  const cases = (): Array<[string, string, string]> => [
    ["корень", ws, "alpha/src/core.ts"],
    ["alpha", alpha, "src/core.ts"],
    ["worktree вне дерева", wtOut, "src/core.ts"],
    ["worktree в .claude/worktrees", wtIn, "src/core.ts"],
    ["worktree внутри alpha", wtRepo, "src/core.ts"],
  ];

  test("of <file> — оба якоря, путь в терминах спросившего", async () => {
    for (const [label, dir, target] of cases()) {
      const spans = await anchorsOf(dir, target);
      expect({ label, ids: spans.map((s) => s.anchor_id).sort() }).toEqual({
        label,
        ids: [fromRoot, fromRepo].sort(),
      });
      // Один файл — одно имя в выдаче, какой бы ключ ни лежал в строке.
      expect(new Set(spans.map((s) => s.path)).size).toBe(1);
    }
    expect((await anchorsOf(alpha, "src/core.ts"))[0]!.path).toBe("src/core.ts");
    expect((await anchorsOf(ws, "alpha/src/core.ts"))[0]!.path).toBe("alpha/src/core.ts");
  });

  test("of <file>:<line> — оба, самый тесный спан первым", async () => {
    for (const [, dir, target] of cases()) {
      const spans = await anchorsOf(dir, `${target}:4`);
      expect(spans.map((s) => s.anchor_id)).toEqual([fromRepo, fromRoot]);
    }
  });

  test("of по абсолютному пути внутри worktree (так зовёт хук) — тоже оба", async () => {
    for (const dir of [wtOut, wtIn, wtRepo]) {
      const spans = await anchorsOf(dir, join(dir, "src", "core.ts"));
      expect(spans.map((s) => s.anchor_id).sort()).toEqual([fromRoot, fromRepo].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// anchor add из worktree внутри дерева — ключ основного дерева
// ---------------------------------------------------------------------------

describe("anchor add из worktree внутри дерева", () => {
  test("ключ — путь основного дерева, а не .claude/worktrees/…; виден из корня и из alpha", async () => {
    const a = await anchorFrom(wtIn, "src/addin.ts:3-5");
    const b = await anchorFrom(wtRepo, "src/addin.ts:3");
    expect(keyOf(a)).toEqual({ repo_id: "", path: "alpha/src/addin.ts" });
    expect(keyOf(b)).toEqual({ repo_id: "alpha", path: "src/addin.ts" });
    for (const [dir, target] of [
      [ws, "alpha/src/addin.ts"],
      [alpha, "src/addin.ts"],
    ] as const) {
      expect((await anchorsOf(dir, target)).map((s) => s.anchor_id).sort()).toEqual([a, b].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// anchor check — правка файла помечает оба
// ---------------------------------------------------------------------------

describe("anchor check помечает оба якоря файла при его правке", () => {
  const checkMarksBoth = async (file: string, from: string): Promise<void> => {
    const a = await anchorFrom(ws, `alpha/src/${file}.ts:3-5`);
    const b = await anchorFrom(alpha, `src/${file}.ts:3-5`);
    writeFileSync(join(alpha, "src", `${file}.ts`), rewritten(file));
    const d = (await myc(from, "anchor", "check")).env.data!;
    const changed = (d["changed"] as Array<{ anchor_id: string; state: string }>).filter(
      (c) => c.anchor_id === a || c.anchor_id === b,
    );
    expect(changed.map((c) => c.anchor_id).sort()).toEqual([a, b].sort());
    for (const c of changed) expect(c.state).toBe("stale");
  };

  test("check из alpha: якорь корня тоже в охвате alpha", async () => {
    await checkMarksBoth("chk1", alpha);
  });

  test("check из корня", async () => {
    await checkMarksBoth("chk2", ws);
  });

  test("check из worktree вне дерева", async () => {
    await checkMarksBoth("chk3", wtOut);
  });

  test("строка без repo_root (запись старой сборки) читается от корня СВОЕГО ключа, а не спросившего", async () => {
    const a = await anchorFrom(ws, "alpha/src/old.ts:3-5");
    const w = new Database(join(ws, ".myc", "myc.db"));
    try {
      w.query("UPDATE anchors SET repo_root = '' WHERE node_id = ?1").run(a);
    } finally {
      w.close();
    }
    writeFileSync(join(alpha, "src", "old.ts"), rewritten("old"));
    const d = (await ok(alpha, "anchor", "check")).data!;
    const line = (d["changed"] as Array<{ anchor_id: string; state: string; level: number }>).find(
      (c) => c.anchor_id === a,
    );
    // Файл НАЙДЕН и прочитан (уровень 3), а не объявлен пропавшим (уровень 0):
    // корень alpha + `alpha/src/old.ts` дал бы несуществующий путь.
    expect(line).toMatchObject({ state: "stale", level: 3 });
  });
});

// ---------------------------------------------------------------------------
// anchor touch — пометка из любого места видна всем
// ---------------------------------------------------------------------------

describe("touch из любого места ставит пометку, которую видит check отовсюду", () => {
  // Батч в ДВА якоря, и оба якоря файла — самые новые в охвате (старшие
  // поставлены тестами выше): без пометки `checked_at ASC` взял бы старые.
  // Поэтому «оба из журнала» здесь проверяет и счёт `from_dirty`, и сам
  // запрос грязной половины батча — пометка, сравнённая с одним ключом,
  // отдала бы ему один якорь, а второе место занял бы чужой старый.
  const touchSeenBy = async (file: string, touchFrom: string, touchArg: string, checkFrom: string): Promise<void> => {
    await anchorFrom(ws, `alpha/src/${file}.ts:3-5`);
    await anchorFrom(alpha, `src/${file}.ts:3-5`);
    await ok(touchFrom, "anchor", "touch", touchArg);
    const d = (await ok(checkFrom, "anchor", "check", "--limit", "2")).data!;
    expect(d["checked"]).toBe(2);
    expect(d["from_dirty"]).toBe(2);
    // Правки не было — оба свежие; сами они в `changed` не попадают, но и
    // чужих в батче нет: проверено ровно два, и оба — из журнала.
    expect((d["changed"] as unknown[]).length).toBe(0);
  };

  test("touch из worktree в .claude/worktrees → check из корня", async () => {
    await touchSeenBy("tch1", wtIn, "src/tch1.ts", ws);
  });

  test("touch из worktree вне дерева (абсолютный путь, как у хука) → check из alpha", async () => {
    await touchSeenBy("tch2", wtOut, join(wtOut, "src", "tch2.ts"), alpha);
  });

  test("touch из корня → check из worktree внутри alpha", async () => {
    await touchSeenBy("tch3", ws, "alpha/src/tch3.ts", wtRepo);
  });

  test("touch из alpha → check из worktree вне дерева", async () => {
    await touchSeenBy("tch4", alpha, "src/tch4.ts", wtOut);
  });

  test("wsPathOfFile: путь worktree внутри дерева — в основное дерево, вне воркспейса — null", () => {
    expect(wsPathOfFile(ws, join(wtIn, "src", "x.ts"))).toBe("alpha/src/x.ts");
    expect(wsPathOfFile(ws, join(wtRepo, "src", "x.ts"))).toBe("alpha/src/x.ts");
    expect(wsPathOfFile(ws, join(alpha, "src", "x.ts"))).toBe("alpha/src/x.ts");
    expect(wsPathOfFile(ws, join(ws, "README.md"))).toBe("README.md");
    expect(wsPathOfFile(ws, join(sandbox, "elsewhere.ts"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// anchor rm — по личности файла
// ---------------------------------------------------------------------------

describe("anchor rm сравнивает файл, а не строку одного ключа", () => {
  test("rm из alpha снимает якорь, поставленный из корня, и называет его путём alpha", async () => {
    const id = (await ok(ws, "task", "rm-якорь")).data!["id"] as string;
    await ok(ws, "anchor", "add", id, "alpha/src/rm1.ts:3-5");
    const e = await ok(alpha, "anchor", "rm", id, "src/rm1.ts");
    expect(e.data!["removed"]).toEqual(["src/rm1.ts:3-5"]);
    expect(await anchorsOf(ws, "alpha/src/rm1.ts")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Индекс из корня: worktree внутри дерева — не вторая копия
// ---------------------------------------------------------------------------

describe("code index из корня не берёт worktree внутри дерева", () => {
  const codePaths = (): string[] => {
    const d = db();
    try {
      return (d.query("SELECT path FROM code_files ORDER BY path").all() as Array<{ path: string }>).map((r) => r.path);
    } finally {
      d.close();
    }
  };

  test("строк worktree в code_files нет; пропущенные посчитаны и названы", async () => {
    const e = await ok(ws, "code", "index");
    const paths = codePaths();
    expect(paths.filter((p) => p.startsWith(".claude/") || p.includes("/.worktrees/"))).toEqual([]);
    // Настоящий вложенный репозиторий на месте — выброшен только worktree.
    expect(paths).toContain("alpha/src/core.ts");
    expect(paths.filter((p) => p.endsWith("/core.ts"))).toEqual(["alpha/src/core.ts"]);
    const scan = e.data!["scan"] as { worktrees_skipped: number; skipped_worktrees: Array<{ dir: string; main: string }> };
    expect(scan.worktrees_skipped).toBe(2);
    expect(scan.skipped_worktrees).toEqual([
      { dir: ".claude/worktrees/in", main: "alpha" },
      { dir: "alpha/.worktrees/w2", main: "alpha" },
    ]);
  });

  test("вывод index называет пропуск вслух", async () => {
    const out = await text(ws, "code", "index");
    expect(out).toMatch(/^scan .*worktrees skipped 2/m);
    expect(out).toContain(".claude/worktrees/in → alpha");
  });

  test("code symbol (второй читатель якорей по файлу) видит оба якоря и из worktree внутри дерева — и одно определение", async () => {
    for (const dir of [ws, alpha, wtOut, wtIn, wtRepo]) {
      const e = await ok(dir, "code", "symbol", "core");
      const defs = e.data!["defs"] as Array<{ path: string; knowledge: Array<{ id: string }> }>;
      // Одно определение: копия из worktree в индекс не легла.
      expect(defs.length).toBe(1);
      const ids = defs[0]!.knowledge.map((k) => k.id);
      expect(ids.length).toBe(2);
    }
  });

  test("index из alpha (часть индекса корня) пропускает свой worktree так же — строки не мигают", async () => {
    const before = codePaths();
    const e = await ok(alpha, "code", "index");
    const scan = e.data!["scan"] as { worktrees_skipped: number; removed: number };
    expect(scan.worktrees_skipped).toBe(1);
    expect(scan.removed).toBe(0);
    expect(codePaths()).toEqual(before);
  });
});
