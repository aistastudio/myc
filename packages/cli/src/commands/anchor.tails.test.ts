/**
 * Хвосты вокруг якорей (memory-w5vh0x68fg4k, memory-nm92qfhm12ht и находка
 * приёмки M3 к коммиту 0403533). Каждый ломал честность одной поверхности:
 *
 *   1. `anchor add`/`task`/`remember --anchor` на каталог падали в
 *      internal.unexpected EISDIR — у task/remember уже ПОСЛЕ записи узла;
 *   2. `anchor of` отдавал отменённое, отозванное и кандидатов разбора;
 *   3. правило «worktree внутри дерева» жило в двух копиях, и копия якорей
 *      роняла команду на пути сквозь файл (ENOTDIR);
 *   5. справка `recall --anchor` описывала фильтр, которого уже нет;
 *   6. `show` задачи не печатал путь якоря вовсе — и переезд кода был не виден.
 *
 * Мутация, которая обязана ломать каждый блок, названа в его шапке; прогоны
 * мутаций — в отчёте задачи.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createCodeCommand } from "./code.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { createShowCommand } from "./show.ts";
import * as storeMod from "./store.ts";
import { createCreateCommand, createTaskCommand, createUpdateCommand } from "./tasks.ts";
import * as wsfindMod from "./wsfind.ts";

const FUSE = "export function fuse(a: number) {\n  return a;\n}\n";

let dir: string;
let home: string;
let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-anchor-tails-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "fuse.ts"), FUSE);
  // Бинарный: NUL во втором байте — ровно признак git (и `code grep`).
  writeFileSync(join(dir, "src", "logo.bin"), new Uint8Array([0x89, 0x00, 0x4e, 0x47, 0x0d, 0x0a]));
  // Секретный по имени, с содержимым обычного текста: решает ИМЯ, а не байты.
  writeFileSync(join(dir, "src", ".env"), "API_TOKEN=не-для-якоря\n");
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createAnchorCommand());
  registry.register(createTaskCommand());
  registry.register(createCreateCommand());
  registry.register(createUpdateCommand());
  registry.register(createShowCommand());
  registry.register(createCodeCommand());
  registry.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(from: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", from, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: RunResult["stdout"]): string {
  return typeof out === "string" ? out : [...out].join("");
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  warn?: Array<{ code: string; msg: string }>;
  error?: { code: string; msg: string };
}

async function json(from: string, ...args: string[]): Promise<{ code: number; env: Envelope }> {
  const r = await myc(from, ...args, "--json");
  return { code: r.code, env: JSON.parse(text(r.stdout)) as Envelope };
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const { env } = await json(dir, ...args);
  if (!env.ok) throw new Error(`${args.join(" ")}: ${JSON.stringify(env.error)}`);
  return env.data;
}

function count(sql: string, ...params: string[]): number {
  const d = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return (d.query(sql).get(...params) as { n: number }).n;
  } finally {
    d.close();
  }
}

function exec(sql: string, ...params: string[]): void {
  const d = new Database(join(dir, ".myc", "myc.db"));
  try {
    d.query(sql).run(...params);
  } finally {
    d.close();
  }
}

const NODES = "SELECT count(*) AS n FROM nodes";
const ANCHORS = "SELECT count(*) AS n FROM anchors";

// ---------------------------------------------------------------------------
// 1. Заведомо непривязываемое — понятный отказ ДО записи (memory-w5vh0x68fg4k)
//
// МУТАЦИИ: снять `if (!st.isFile())` в resolveAnchorFile — каталог уходит в
// notfound.file «cannot read …», а у task/remember узел записывается; снять
// вызов refuseNeverBindable в tasks.ts/remember.ts — узел записывается с
// якорем `refused`; снять проверку isSecretPath — `.env` привязывается.
// ---------------------------------------------------------------------------

/** Путь, выход и код отказа. `keys/deploy.pem` на диске НЕТ: секрет решает имя. */
const NEVER: ReadonlyArray<readonly [string, number, string]> = [
  ["src", ExitCode.USAGE, "usage.not_a_file"],
  ["src/logo.bin", ExitCode.USAGE, "usage.binary_file"],
  ["src/.env", ExitCode.DENIED, "denied.secret"],
  ["keys/deploy.pem:1-3", ExitCode.DENIED, "denied.secret"],
];

describe("заведомо непривязываемый якорь — отказ до записи", () => {
  test("anchor add: код отказа вместо internal.unexpected EISDIR, якоря нет", async () => {
    const task = (await data("task", "Задача под якорь"))["id"] as string;
    const nodes = count(NODES);
    for (const [target, exit, code] of NEVER) {
      const r = await json(dir, "anchor", "add", task, target);
      expect([target, r.code, r.env.error?.code]).toEqual([target, exit, code]);
    }
    expect(count(ANCHORS)).toBe(0);
    // Ни узла якоря, ни ребра: отказ пришёл раньше createNode.
    expect(count(NODES)).toBe(nodes);
    expect(count("SELECT count(*) AS n FROM edges WHERE src = ?1 AND type = 'touches'", task)).toBe(0);
  });

  test("task --anchor: задача НЕ записана — ни узла, ни якоря", async () => {
    const nodes = count(NODES);
    for (const [target, exit, code] of NEVER) {
      const r = await json(dir, "task", `Задача с якорем на ${target}`, "--anchor", target);
      expect([target, r.code, r.env.error?.code]).toEqual([target, exit, code]);
      expect(r.env.error?.msg).toContain("nothing written");
    }
    expect(count(NODES)).toBe(nodes);
    expect(count(ANCHORS)).toBe(0);
  });

  test("remember --anchor: факт НЕ записан, и точный повтор не наращивает seen_count", async () => {
    const first = await data("remember", "факт про слияние");
    const nodes = count(NODES);
    for (const [target, exit, code] of NEVER) {
      const r = await json(dir, "remember", "факт про слияние", "--anchor", target);
      expect([target, r.code, r.env.error?.code]).toEqual([target, exit, code]);
    }
    const fresh = await json(dir, "remember", "новый факт", "--anchor", "src");
    expect(fresh.env.error?.code).toBe("usage.not_a_file");
    expect(count(NODES)).toBe(nodes);
    // Отказ стоит ДО поиска дубликата: повтор с кривым якорем — не «виден ещё раз».
    const seen = (): number => count("SELECT seen_count AS n FROM nodes WHERE id = ?1", first["id"] as string);
    const before = seen();
    // Ограждение самой проверки: точный повтор БЕЗ якоря счётчик наращивает.
    await data("remember", "факт про слияние");
    expect(seen()).toBe(before + 1);
    for (const [target] of NEVER) await json(dir, "remember", "факт про слияние", "--anchor", target);
    expect(seen()).toBe(before + 1);
  });

  test("человеку отказ говорит, что не записано ничего, и как поправить каталог", async () => {
    const r = await myc(dir, "task", "Задача на каталог", "--anchor", "src");
    expect(r.code).toBe(ExitCode.USAGE);
    const err = r.stderr ?? "";
    expect(err).toContain("usage.not_a_file");
    expect(err).toContain("nothing written");
    expect(err).toContain("src is a directory");
    expect(err).toContain("src/<file>");
  });

  test("граница правила: нет файла — по-прежнему намерение, узел записан (не отказ)", async () => {
    const r = await json(dir, "task", "Файл ещё не написан", "--anchor", "src/new.ts:1-2");
    expect(r.code).toBe(ExitCode.OK);
    expect((r.env.data["anchors"] as Array<{ state: string }>)[0]!.state).toBe("pending");
    expect((r.env.warn ?? []).map((w) => w.code)).toContain("anchor.unbound");
  });
});

// ---------------------------------------------------------------------------
// 2. `anchor of` — без скрываемых статусов (memory-nm92qfhm12ht п.1)
//
// МУТАЦИЯ: убрать liveStatusPredicate/notPendingPredicate из sqlOfOwners —
// отменённое, отозванное и кандидат возвращаются в выдачу.
// ---------------------------------------------------------------------------

describe("anchor of: владельцы — только живое знание", () => {
  test("отменённое, отозванное и кандидат не отдаются; закрытое — отдаётся", async () => {
    // Спаны у владельцев РАЗНЫЕ: второй узел на тот же file:span сейчас падает
    // на ux_nodes_content — отдельный дефект memory-s32xpa09ytpb.
    const id = async (span: string, ...args: string[]): Promise<string> => {
      const d = await data(...args);
      await data("anchor", "add", d["id"] as string, `src/fuse.ts:${span}`);
      return d["id"] as string;
    };
    const open = await id("1", "task", "Живая задача");
    const closed = await id("2", "task", "Сделанная задача");
    const cancelled = await id("3", "task", "Отменённая задача");
    const retracted = await id("1-2", "create", "Отозванный факт", "--kind", "memory");
    const candidate = await id("2-3", "create", "Кандидат хука сжатия", "--kind", "memory");
    exec("UPDATE nodes SET status = 'closed' WHERE id = ?1", closed);
    exec("UPDATE nodes SET status = 'cancelled' WHERE id = ?1", cancelled);
    exec("UPDATE nodes SET status = 'retracted' WHERE id = ?1", retracted);
    exec("UPDATE nodes SET attrs = json_set(attrs, '$.state', 'pending_review') WHERE id = ?1", candidate);

    const of = await data("anchor", "of", "src/fuse.ts");
    const owners = (of["spans"] as Array<{ nodes: Array<{ id: string }> }>).flatMap((s) => s.nodes.map((n) => n.id));
    expect(owners.sort()).toEqual([open, closed].sort());
    expect(of["nodes"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Одно правило «worktree внутри дерева» (memory-nm92qfhm12ht п.2)
//
// МУТАЦИИ: wsfind.inTreeWorktreeLink всегда undefined — падают ОБЕ стороны
// (якорь из worktree внутри дерева в anchor.nested.test.ts и охват из него в
// store.worktree.test.ts); вернуть в anchor.ts копию без try вокруг stat —
// путь сквозь файл снова internal.unexpected ENOTDIR.
// ---------------------------------------------------------------------------

describe("worktree внутри дерева: одна функция на охват и якорь", () => {
  test("store.ts отдаёт ту же функцию, что wsfind.ts, и своей копии не держит ни он, ни anchor.ts", () => {
    expect(storeMod.inTreeWorktreeLink).toBe(wsfindMod.inTreeWorktreeLink);
    const src = (f: string): string => readFileSync(join(import.meta.dir, f), "utf8");
    expect(src("anchor.ts")).not.toMatch(/function inTreeWorktree\b|function inside\(/);
    expect(src("store.ts")).not.toMatch(/function inTreeWorktreeLink|function relUnder/);
    expect(src("wsfind.ts")).toMatch(/export function inTreeWorktreeLink/);
  });

  test("wsfind.ts по-прежнему импортирует только node:* (цена хука)", () => {
    const src = readFileSync(join(import.meta.dir, "wsfind.ts"), "utf8");
    const specs = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  test("путь сквозь файл (src/fuse.ts/x): anchor add — notfound.file, task — намерение, не ENOTDIR", async () => {
    const task = (await data("task", "Путь сквозь файл"))["id"] as string;
    const add = await json(dir, "anchor", "add", task, "src/fuse.ts/x.ts:1");
    expect([add.code, add.env.error?.code]).toEqual([ExitCode.NOTFOUND, "notfound.file"]);
    const created = await json(dir, "task", "Путь сквозь файл при создании", "--anchor", "src/fuse.ts/x.ts:1");
    expect(created.code).toBe(ExitCode.OK);
    expect((created.env.data["anchors"] as Array<{ state: string }>)[0]!.state).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 5. Справка recall --anchor (memory-nm92qfhm12ht п.4)
//
// МУТАЦИЯ: вернуть прежнее «only nodes anchored at this path».
// ---------------------------------------------------------------------------

describe("recall --anchor: справка описывает то, что фильтр делает", () => {
  test("file или file:line от каталога вызова, настоящий якорь с любой стороны, плюс намерения", () => {
    const flag = (createRecallCommand().flags ?? []).find((f) => f.name === "anchor");
    const d = flag?.description ?? "";
    expect(d).toContain("<file>:<line>");
    expect(d).toContain("current directory");
    expect(d).toContain("real anchor");
    expect(d).toContain("worktree");
    expect(d).toContain("pending");
  });
});

// ---------------------------------------------------------------------------
// 6. show задачи — путь якоря, состояние и откуда переехал (находка M3)
//
// МУТАЦИИ: ветка touches без anchorOf (как было: только id и статус) —
// падают первые три теста; без moved_from — падает тест переезда.
// ---------------------------------------------------------------------------

describe("show: якоря задачи — место, состояние, переезд", () => {
  test("привязанный якорь: путь:спан, состояние и id узла якоря — человеку и в JSON", async () => {
    const created = await data("task", "Слияние", "--anchor", "src/fuse.ts:1-3");
    const task = created["id"] as string;
    const anchor = (created["anchors"] as Array<{ anchor_id: string }>)[0]!.anchor_id;

    const human = text((await myc(dir, "show", task)).stdout);
    expect(human).toContain(`anchors   src/fuse.ts:1-3 fresh · ${anchor}`);
    const view = await data("show", task);
    expect(view["anchors"]).toEqual([{ path: "src/fuse.ts", start: 1, end: 3, state: "fresh", node_id: anchor }]);
  });

  test("--source читает код привязанного якоря по месту строки — и из подкаталога", async () => {
    const task = (await data("task", "Слияние", "--anchor", "src/fuse.ts:1-3"))["id"] as string;
    const { env } = await json(join(dir, "src"), "show", task, "--source");
    const sources = env.data["sources"] as Array<{ path: string; start: number; end: number; text: string }>;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.path).toBe("src/fuse.ts");
    expect(sources[0]!.text).toContain("export function fuse(a: number)");
  });

  test("строки anchors на машине нет (узел якоря приехал с оплогом) — место из заголовка, это сказано", async () => {
    const created = await data("task", "Слияние", "--anchor", "src/fuse.ts:1-3");
    const anchor = (created["anchors"] as Array<{ anchor_id: string }>)[0]!.anchor_id;
    exec("DELETE FROM anchors WHERE node_id = ?1", anchor);
    const human = text((await myc(dir, "show", created["id"] as string)).stdout);
    expect(human).toContain(`anchors   src/fuse.ts:1-3 fresh · ${anchor} · not tracked on this machine`);
  });

  test("путь — в терминах спросившего: якорь из корня, show из вложенного репозитория", async () => {
    mkdirSync(join(dir, "svc", ".git"), { recursive: true });
    writeFileSync(join(dir, "svc", "x.ts"), "export const x = 1;\n");
    const task = (await data("task", "Во вложенном", "--anchor", "svc/x.ts:1"))["id"] as string;
    expect(text((await myc(dir, "show", task)).stdout)).toContain("anchors   svc/x.ts:1 fresh");
    expect(text((await myc(join(dir, "svc"), "show", task)).stdout)).toContain("anchors   x.ts:1 fresh");
  });
});

/** Вынос функции в другой файл — тот же сценарий, что anchor.rebind.test.ts. */
const FUSE_FN = `export function fuseRanked(lists: number[][], k = 60): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      const prev = score.get(id) ?? 0;
      score.set(id, prev + 1 / (k + rank + 1));
    });
  }
  return score;
}`;
const TOP_FN = `export function topN(score: Map<number, number>, n: number): number[] {
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}`;

describe("show: переезд кода в другой файл виден у задачи", () => {
  test("drifted с мерой, id якоря и «moved from» старое место — человеку и в JSON", async () => {
    const rank = `// Ранжирование выдачи.\n\n${FUSE_FN}\n\n${TOP_FN}\n`;
    writeFileSync(join(dir, "src", "rank.ts"), rank);
    await data("code", "index");
    const span = `3-${3 + FUSE_FN.split("\n").length - 1}`;
    const created = await data("task", "Слияние ранжированных списков", "--anchor", `src/rank.ts:${span}`);
    const task = created["id"] as string;
    const anchor = (created["anchors"] as Array<{ anchor_id: string }>)[0]!.anchor_id;

    writeFileSync(join(dir, "src", "rank.ts"), `// Ранжирование выдачи.\nexport { fuseRanked } from "./fuse.ts";\n\n${TOP_FN}\n`);
    writeFileSync(join(dir, "src", "fuse.ts"), `// Слияние (RRF).\n\n${FUSE_FN}\n`);
    await data("code", "index");
    await data("anchor", "check");

    const fuseSpan = `3-${3 + FUSE_FN.split("\n").length - 1}`;
    const human = text((await myc(dir, "show", task)).stdout);
    expect(human).toContain(`anchors   src/fuse.ts:${fuseSpan} drifted 1.00 · ${anchor} · moved from src/rank.ts:${span}`);
    const view = await data("show", task);
    expect(view["anchors"]).toEqual([
      {
        path: "src/fuse.ts",
        start: 3,
        end: 3 + FUSE_FN.split("\n").length - 1,
        state: "drifted",
        node_id: anchor,
        drift: 1,
        moved_from: `src/rank.ts:${span}`,
      },
    ]);
  });
});
