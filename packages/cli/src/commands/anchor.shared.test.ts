/**
 * Общий якорь (memory-s32xpa09ytpb) и символ якоря в `show` (memory-nv6hzkg6t28j).
 *
 * До этой правки второй владелец того же участка кода падал на
 * `ux_nodes_content`: `anchor add` — internal.unexpected UNIQUE, а `task` и
 * `remember --anchor` оставляли намерение `pending` с советом, который падал
 * так же. Якорь — это КОД, и у одного участка владельцев сколько угодно:
 * один узел якоря, по ребру `touches` от каждого.
 *
 * Мутация, которая обязана ломать каждый блок, названа в его шапке; прогоны —
 * в отчёте задачи.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliTestEnv } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";
import { drainQueueTail } from "../drain.ts";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { ANCHOR_INTENTS_SWEPT_KEY, createAnchorCommand } from "./anchor.ts";
import { createCodeCommand } from "./code.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { createShowCommand } from "./show.ts";
import { realStoreDeps, type StoreDeps } from "./store.ts";
import { createCreateCommand, createTaskCommand, createUpdateCommand } from "./tasks.ts";

const FUSE = "export function fuse(a: number) {\n  return a;\n}\n";

let dir: string;
let home: string;
let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-anchor-shared-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "fuse.ts"), FUSE);
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

async function dataFrom(from: string, ...args: string[]): Promise<Record<string, unknown>> {
  const { env } = await json(from, ...args);
  if (!env.ok) throw new Error(`${args.join(" ")}: ${JSON.stringify(env.error)}`);
  return env.data;
}

function data(...args: string[]): Promise<Record<string, unknown>> {
  return dataFrom(dir, ...args);
}

function db<T>(fn: (d: Database) => T): T {
  const d = new Database(join(dir, ".myc", "myc.db"));
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

function n(sql: string, ...params: string[]): number {
  return db((d) => (d.query(sql).get(...params) as { n: number }).n);
}

function exec(sql: string, ...params: Array<string | number>): void {
  db((d) => d.query(sql).run(...params));
}

const ROWS = "SELECT count(*) AS n FROM anchors";
const LIVE_ANCHORS = "SELECT count(*) AS n FROM nodes WHERE kind = 'anchor' AND deleted_at IS NULL";
const EDGES_TO = "SELECT count(*) AS n FROM edges WHERE dst = ?1 AND type = 'touches' AND deleted_at IS NULL";
const SUSPECT_TO = `SELECT count(*) AS n FROM edges
  WHERE dst = ?1 AND type = 'touches' AND deleted_at IS NULL AND json_extract(attrs, '$.suspect') = 1`;
const OPLOG = "SELECT count(*) AS n FROM oplog";

async function task(title: string): Promise<string> {
  return (await data("task", title))["id"] as string;
}

async function add(id: string, target: string, ...flags: string[]): Promise<Record<string, unknown>> {
  return data("anchor", "add", id, target, ...flags);
}

type AnchorView = { path?: string; start?: number; end?: number; symbol?: string; state: string; node_id?: string };

async function anchorsOfShow(id: string): Promise<AnchorView[]> {
  return (await data("show", id))["anchors"] as AnchorView[];
}

async function ownersOf(target: string): Promise<string[][]> {
  const of = await data("anchor", "of", target);
  return (of["spans"] as Array<{ nodes: Array<{ id: string }> }>).map((s) => s.nodes.map((x) => x.id).sort());
}

// ---------------------------------------------------------------------------
// 1. Два владельца одного участка: один узел якоря, два ребра
//
// МУТАЦИЯ: в bindAnchorAt снять `samePlace` и `settleClash` (всегда
// createNode, как было) — второй `anchor add` снова internal.unexpected
// UNIQUE, `task --anchor` снова `pending` с WARN anchor.unbound.
// ---------------------------------------------------------------------------

describe("общий якорь: второй владелец того же участка", () => {
  test("anchor add: тот же узел якоря, одна строка, два ребра — не UNIQUE", async () => {
    const a = await task("Баг в fuse");
    const b = await task("Решение про fuse");
    const first = await add(a, "src/fuse.ts:1-3");
    expect([first["reused"], first["owners"]]).toEqual([false, 1]);

    const r = await json(dir, "anchor", "add", b, "src/fuse.ts:1-3");
    expect([r.code, r.env.error?.code]).toEqual([ExitCode.OK, undefined]);
    expect(r.env.data["anchor_id"]).toBe(first["anchor_id"]);
    expect([r.env.data["reused"], r.env.data["owners"], r.env.data["state"]]).toEqual([true, 2, "fresh"]);

    const anchor = first["anchor_id"] as string;
    expect([n(ROWS), n(LIVE_ANCHORS), n(EDGES_TO, anchor)]).toEqual([1, 1, 2]);
    expect(await ownersOf("src/fuse.ts")).toEqual([[a, b].sort()]);
  });

  test("человеку второй add говорит, что якорь общий", async () => {
    const a = await task("Баг в fuse");
    const b = await task("Решение про fuse");
    await add(a, "src/fuse.ts:1-3");
    const out = text((await myc(dir, "anchor", "add", b, "src/fuse.ts:1-3")).stdout);
    expect(out).toContain(`touches   ${b} · shared anchor, 2 owners`);
  });

  test("task и remember --anchor на тот же участок: привязаны сразу, без намерения и WARN", async () => {
    const a = await task("Баг в fuse");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;

    const t = await json(dir, "task", "Решение про fuse", "--anchor", "src/fuse.ts:1-3");
    expect(t.code).toBe(ExitCode.OK);
    expect((t.env.warn ?? []).map((w) => w.code)).not.toContain("anchor.unbound");
    expect(t.env.data["anchors"]).toEqual([
      { path: "src/fuse.ts", start: 1, end: 3, anchor_id: anchor, state: "fresh", owners: 2 },
    ]);
    // Намерения в attrs нет: якорь настоящий.
    expect(n("SELECT count(*) AS n FROM nodes WHERE id = ?1 AND json_extract(attrs, '$.anchors') IS NULL", t.env.data["id"] as string)).toBe(1);

    const human = text((await myc(dir, "remember", "fuse возвращает аргумент как есть", "--anchor", "src/fuse.ts:1-3")).stdout);
    expect(human).toContain(`anchor    src/fuse.ts:1-3 → ${anchor} fresh · shared anchor, 3 owners`);
    expect([n(ROWS), n(LIVE_ANCHORS), n(EDGES_TO, anchor)]).toEqual([1, 1, 3]);
  });

  test("update --anchor на занятый участок — тот же якорь", async () => {
    const a = await task("Баг в fuse");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    const b = await task("Решение про fuse");
    const u = await data("update", b, "--anchor", "src/fuse.ts:1-3");
    expect((u["anchors"] as Array<{ anchor_id: string; owners: number }>)[0]).toMatchObject({ anchor_id: anchor, owners: 2 });
  });

  test("повтор той же привязки тем же узлом — ни ребра, ни операции оплога", async () => {
    const a = await task("Баг в fuse");
    const first = await add(a, "src/fuse.ts:1-3");
    const ops = n(OPLOG);
    const again = await add(a, "src/fuse.ts:1-3");
    expect([again["anchor_id"], again["owners"]]).toEqual([first["anchor_id"], 1]);
    expect(n(OPLOG)).toBe(ops);
    expect(n(EDGES_TO, first["anchor_id"] as string)).toBe(1);
  });

  test("тот же участок из корня и из вложенного репозитория — один якорь, оба ключа видят обоих", async () => {
    mkdirSync(join(dir, "svc", ".git"), { recursive: true });
    writeFileSync(join(dir, "svc", "x.ts"), "export const x = 1;\nexport const y = 2;\n");
    const a = await task("Из корня");
    const b = (await dataFrom(join(dir, "svc"), "task", "Изнутри svc"))["id"] as string;
    const fromRoot = (await add(a, "svc/x.ts:1-2"))["anchor_id"];
    const inner = await dataFrom(join(dir, "svc"), "anchor", "add", b, "x.ts:1-2");
    expect([inner["anchor_id"], inner["owners"]]).toEqual([fromRoot, 2]);
    expect(await ownersOf("svc/x.ts")).toEqual([[a, b].sort()]);
    const ofInner = await dataFrom(join(dir, "svc"), "anchor", "of", "x.ts");
    expect((ofInner["spans"] as Array<{ nodes: Array<{ id: string }> }>).map((s) => s.nodes.map((x) => x.id).sort())).toEqual([
      [a, b].sort(),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. rm одного владельца
//
// МУТАЦИЯ: в buildAnchorRm удалять узел и строку безусловно (как было) —
// у второго владельца якорь пропадает: show пуст, строки нет.
// ---------------------------------------------------------------------------

describe("anchor rm: снимается ребро, якорь — с последним владельцем", () => {
  test("rm у одной — у второй якорь жив и проверяется; rm у второй — узел и строка сняты", async () => {
    const a = await task("Баг в fuse");
    const b = await task("Решение про fuse");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    await add(b, "src/fuse.ts:1-3");

    const rmA = await data("anchor", "rm", a, "src/fuse.ts:1-3");
    expect(rmA["removed"]).toEqual(["src/fuse.ts:1-3"]);
    expect(rmA["kept"]).toEqual([{ anchor_id: anchor, owners: 1 }]);
    expect(await anchorsOfShow(a)).toEqual([]);
    expect(await anchorsOfShow(b)).toEqual([{ path: "src/fuse.ts", start: 1, end: 3, state: "fresh", node_id: anchor }]);
    expect([n(ROWS), n(LIVE_ANCHORS), n(EDGES_TO, anchor)]).toEqual([1, 1, 1]);
    expect(await ownersOf("src/fuse.ts")).toEqual([[b]]);
    // Якорь не осиротел: лестница его по-прежнему ведёт.
    expect((await data("anchor", "check"))["checked"]).toBe(1);

    const rmB = await data("anchor", "rm", b);
    expect(rmB["kept"]).toEqual([]);
    expect([n(ROWS), n(LIVE_ANCHORS), n(EDGES_TO, anchor)]).toEqual([0, 0, 0]);
  });

  test("человеку rm называет оставленный якорь", async () => {
    const a = await task("Баг в fuse");
    const b = await task("Решение про fuse");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    await add(b, "src/fuse.ts:1-3");
    const out = text((await myc(dir, "anchor", "rm", a)).stdout);
    expect(out).toContain("unbound 1: src/fuse.ts:1-3");
    expect(out).toContain(`kept      ${anchor}: 1 other owner still bound`);
  });

  test("удалённый из графа узел владельцем не считается", async () => {
    const a = await task("Баг в fuse");
    const b = await task("Удалённая задача");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    await add(b, "src/fuse.ts:1-3");
    exec("UPDATE nodes SET deleted_at = 1 WHERE id = ?1", b);
    expect((await data("anchor", "rm", a))["kept"]).toEqual([]);
    expect(n(LIVE_ANCHORS)).toBe(0);
    expect(n(ROWS)).toBe(0);
    expect(n(EDGES_TO, anchor)).toBe(1); // ребро удалённого узла — его история, не владение
  });
});

// ---------------------------------------------------------------------------
// 3. Переезд кода — оба владельца видят новое место
//
// МУТАЦИЯ: заводить второму владельцу свой узел якоря (как до правки — тогда
// второй `--anchor` вовсе не привязывался): show второго не видит переезда.
// ---------------------------------------------------------------------------

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

describe("переезд кода в другой файл: владельцы едут вместе", () => {
  test("show обоих — новое место, символ и откуда; anchor of и code symbol — оба владельца", async () => {
    writeFileSync(join(dir, "src", "rank.ts"), `// Ранжирование выдачи.\n\n${FUSE_FN}\n\n${TOP_FN}\n`);
    await data("code", "index");
    const span = `3-${3 + FUSE_FN.split("\n").length - 1}`;
    const t = await data("task", "Слияние ранжированных списков", "--anchor", `src/rank.ts:${span}`);
    const m = await data("remember", "fuseRanked — это RRF с k=60", "--anchor", `src/rank.ts:${span}`);
    const anchor = (t["anchors"] as Array<{ anchor_id: string }>)[0]!.anchor_id;
    expect((m["anchors"] as Array<{ anchor_id: string }>)[0]!.anchor_id).toBe(anchor);

    writeFileSync(join(dir, "src", "rank.ts"), `// Ранжирование выдачи.\nexport { fuseRanked } from "./fuse.ts";\n\n${TOP_FN}\n`);
    writeFileSync(join(dir, "src", "fuse.ts"), `// Слияние (RRF).\n\n${FUSE_FN}\n`);
    await data("code", "index");
    const check = await data("anchor", "check");
    // Одна строка — одна проверка, сколько бы владельцев у неё ни было.
    expect([check["checked"], check["moved"]]).toEqual([1, 1]);

    const line = `anchors   src/fuse.ts:${span} (fuseRanked) drifted 1.00 · ${anchor} · moved from src/rank.ts:${span}`;
    for (const owner of [t["id"] as string, m["id"] as string]) {
      expect(text((await myc(dir, "show", owner)).stdout)).toContain(line);
    }
    expect(await ownersOf("src/fuse.ts")).toEqual([[t["id"] as string, m["id"] as string].sort()]);
    expect(await ownersOf("src/rank.ts")).toEqual([]);
    const sym = await data("code", "symbol", "fuseRanked");
    const knowledge = (sym["defs"] as Array<{ knowledge: Array<{ id: string; anchor: string }> }>).flatMap((d) => d.knowledge);
    expect(knowledge.map((k) => k.id).sort()).toEqual([t["id"] as string, m["id"] as string].sort());
    // Оба — под одним местом: `anchor` у code symbol — путь:спан якоря.
    expect(new Set(knowledge.map((k) => k.anchor))).toEqual(new Set([`src/fuse.ts:${span}`]));
  });
});

// ---------------------------------------------------------------------------
// 4. suspect: пометка на каждом ребре, вердикт — у якоря
//
// МУТАЦИИ: в joinAnchor снять applyCheck — присоединение к stale якорю с
// вернувшимся текстом оставляет stale и пометку у всех; снять markSuspect —
// пометка у старых рёбер остаётся на свежем якоре.
// ---------------------------------------------------------------------------

describe("suspect у общего якоря", () => {
  test("stale помечает рёбра всех владельцев; новый владелец на вернувшемся тексте снимает пометку у всех", async () => {
    const a = await task("Баг в fuse");
    const b = await task("Решение про fuse");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    await add(b, "src/fuse.ts:1-3");

    writeFileSync(join(dir, "src", "fuse.ts"), "const unrelated = [1, 2, 3];\nthrow new Error(String(unrelated));\n// конец\n");
    await data("anchor", "check");
    expect(n("SELECT count(*) AS n FROM anchors WHERE state = 'stale'")).toBe(1);
    expect(n(SUSPECT_TO, anchor)).toBe(2);

    writeFileSync(join(dir, "src", "fuse.ts"), FUSE);
    const c = await data("task", "Третий про fuse", "--anchor", "src/fuse.ts:1-3");
    expect((c["anchors"] as Array<{ anchor_id: string; state: string }>)[0]).toMatchObject({ anchor_id: anchor, state: "fresh" });
    expect(n("SELECT count(*) AS n FROM anchors WHERE node_id = ?1 AND state = 'fresh'", anchor)).toBe(1);
    expect(n("SELECT count(*) AS n FROM nodes WHERE id = ?1 AND status = 'fresh'", anchor)).toBe(1);
    expect([n(EDGES_TO, anchor), n(SUSPECT_TO, anchor)]).toEqual([3, 0]);
  });

  test("другой текст на том же месте — отдельный якорь: вердикт старого не переходит к новому владельцу", async () => {
    const a = await task("Баг в старом fuse");
    const old = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    writeFileSync(join(dir, "src", "fuse.ts"), "const unrelated = [1, 2, 3];\nthrow new Error(String(unrelated));\n// конец\n");
    await data("anchor", "check");
    expect(n(SUSPECT_TO, old)).toBe(1);

    const b = await task("Про новый код");
    const fresh = (await add(b, "src/fuse.ts:1-3"))["anchor_id"] as string;
    expect(fresh).not.toBe(old);
    expect([n(ROWS), n(SUSPECT_TO, old), n(EDGES_TO, fresh), n(SUSPECT_TO, fresh)]).toEqual([2, 1, 1, 0]);
  });

  test("отложенная привязка (S66): stale недовязанный якорь, привязанный заново, свеж у всех владельцев", async () => {
    // Порог 0 — любая привязка отложена. Процессное окружение: `run()` его не
    // передаёт, до `anchorInlineMaxBytes` доходит только process.env.
    const prev = process.env.MYC_ANCHOR_INLINE_MAX_BYTES;
    process.env.MYC_ANCHOR_INLINE_MAX_BYTES = "0";
    try {
      const a = await task("Баг в fuse");
      const first = await add(a, "src/fuse.ts:1-3");
      expect(first["deferred"]).toBe(true);
      const anchor = first["anchor_id"] as string;
      // Второй на неизменённом файле — тот же недовязанный якорь.
      const c = await task("Ещё про fuse");
      expect((await add(c, "src/fuse.ts:1-3"))["anchor_id"]).toBe(anchor);

      // Файл поменялся раньше фона — фон честно отказывается доводить: stale.
      writeFileSync(join(dir, "src", "fuse.ts"), "export function fuse(a: number) {\n  return a + 1;\n}\n");
      await data("anchor", "check");
      expect(n("SELECT count(*) AS n FROM anchors WHERE node_id = ?1 AND state = 'stale'", anchor)).toBe(1);
      expect(n(SUSPECT_TO, anchor)).toBe(2);

      // «Поставьте якорь заново» — новый владелец это и делает.
      const b = await task("Решение про fuse");
      const again = await add(b, "src/fuse.ts:1-3");
      expect([again["anchor_id"], again["owners"], again["state"], again["deferred"]]).toEqual([anchor, 3, "fresh", true]);
      expect([n(EDGES_TO, anchor), n(SUSPECT_TO, anchor)]).toEqual([3, 0]);
      // Работа фона на этот якорь стоит (очередь сводит повтор на ту же пару в одну строку).
      expect(n("SELECT count(*) AS n FROM jobs WHERE kind = 'anchor_check' AND entity_id = ?1", anchor)).toBe(1);

      const check = await data("anchor", "check");
      expect([check["bound"], check["stale"]]).toEqual([1, 0]);
      expect(n("SELECT count(*) AS n FROM nodes WHERE id = ?1 AND body LIKE '%return a + 1%'", anchor)).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.MYC_ANCHOR_INLINE_MAX_BYTES;
      else process.env.MYC_ANCHOR_INLINE_MAX_BYTES = prev;
    }
  });

  test("тело поправили до проверки, голова та же — тот же якорь, и его хеш спана — новый текст", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `  const v${i} = a * ${i} + ${i * 7};`).join("\n");
    const src = (tail: string): string => `export function wide(a: number): number {\n${body}\n  return ${tail};\n}\n`;
    writeFileSync(join(dir, "src", "wide.ts"), src("a"));
    const a = await task("Баг в wide");
    const first = await add(a, "src/wide.ts:1-33");
    const hash = (): string =>
      db((d) => (d.query("SELECT span_hash AS h FROM anchors WHERE node_id = ?1").get(first["anchor_id"] as string) as { h: string }).h);
    const before = hash();

    writeFileSync(join(dir, "src", "wide.ts"), src("a + v29"));
    const b = await task("Решение про wide");
    const second = await add(b, "src/wide.ts:1-33");
    expect([second["anchor_id"], second["owners"], second["state"]]).toEqual([first["anchor_id"], 2, "fresh"]);
    expect(hash()).not.toBe(before);
    // Лестница согласна с привязкой: якорь свеж, и ни один не stale.
    const check = await data("anchor", "check");
    expect([check["stale"], check["fresh"]]).toEqual([0, 1]);
  });

  test("код ушёл по файлу (заголовок узла отстал), потом правили тело — новый владелец находит якорь по голове", async () => {
    // Здесь совпадение (title, crux) не поможет: заголовок узла — старое место
    // 1-33, а привязка идёт на 3-35. Найти общий якорь можно только по строке.
    const body = Array.from({ length: 30 }, (_, i) => `  const v${i} = a * ${i} + ${i * 7};`).join("\n");
    const src = (tail: string): string => `export function wide(a: number): number {\n${body}\n  return ${tail};\n}\n`;
    writeFileSync(join(dir, "src", "wide.ts"), src("a"));
    const a = await task("Баг в wide");
    const first = (await add(a, "src/wide.ts:1-33"))["anchor_id"] as string;
    writeFileSync(join(dir, "src", "wide.ts"), `// шапка\n\n${src("a")}`);
    await data("anchor", "check");
    expect(n("SELECT count(*) AS n FROM anchors WHERE node_id = ?1 AND span_start = 3", first)).toBe(1);

    writeFileSync(join(dir, "src", "wide.ts"), `// шапка\n\n${src("a + v29")}`);
    const b = await task("Решение про wide");
    const second = await add(b, "src/wide.ts:3-35");
    expect([second["anchor_id"], second["owners"]]).toEqual([first, 2]);
    expect([n(ROWS), n(LIVE_ANCHORS)]).toEqual([1, 1]);
  });
});

// ---------------------------------------------------------------------------
// 5. Символ якоря в show (memory-nv6hzkg6t28j)
//
// МУТАЦИЯ: убрать `symbol` из SQL_ANCHOR_ROW / AnchorRef — текст и JSON без
// символа.
// ---------------------------------------------------------------------------

describe("show называет символ, к которому привязано знание", () => {
  test("символ по код-индексу: в строке якоря и в JSON", async () => {
    await data("code", "index");
    const created = await data("task", "Слияние", "--anchor", "src/fuse.ts:1-3");
    const anchor = (created["anchors"] as Array<{ anchor_id: string }>)[0]!.anchor_id;
    const human = text((await myc(dir, "show", created["id"] as string)).stdout);
    expect(human).toContain(`anchors   src/fuse.ts:1-3 (fuse) fresh · ${anchor}`);
    expect(await anchorsOfShow(created["id"] as string)).toEqual([
      { path: "src/fuse.ts", start: 1, end: 3, symbol: "fuse", state: "fresh", node_id: anchor },
    ]);
  });

  test("символ, названный --symbol, сильнее индекса — и у второго владельца тот же", async () => {
    await data("code", "index");
    const a = await task("Баг в fuse");
    await add(a, "src/fuse.ts:1-3", "--symbol", "fuseEntry");
    const m = await data("remember", "fuse — точка входа слияния", "--anchor", "src/fuse.ts:1-3");
    expect(text((await myc(dir, "show", m["id"] as string)).stdout)).toContain("anchors   src/fuse.ts:1-3 (fuseEntry) fresh");
  });

  test("индекса не было — символ не выдумывается: ни поля, ни скобок", async () => {
    const created = await data("task", "Слияние", "--anchor", "src/fuse.ts:1-3");
    const view = await anchorsOfShow(created["id"] as string);
    expect("symbol" in view[0]!).toBe(false);
    expect(text((await myc(dir, "show", created["id"] as string)).stdout)).toMatch(/anchors {3}src\/fuse\.ts:1-3 fresh · /);
  });
});

// ---------------------------------------------------------------------------
// 6. Намерения
//
// МУТАЦИИ: снять dropIntents — после `anchor add` show печатает и якорь, и
// строку pending; снять `created_at <=` в SQL_ANCHOR_BY_TITLE — намерение
// довязывается к якорю, поставленному ПОСЛЕ него; снять отметку
// ANCHOR_INTENTS_SWEPT_KEY — фон довязывает на каждом прогоне.
// ---------------------------------------------------------------------------

function pendingIntent(id: string, path: string, start: number, end: number): void {
  exec(
    "UPDATE nodes SET attrs = json_set(attrs, '$.anchors', json(?2)) WHERE id = ?1",
    id,
    JSON.stringify([{ path, start, end, state: "pending" }]),
  );
}

describe("намерения якоря", () => {
  test("anchor add исполняет намерение того же файла: у show нет строки pending", async () => {
    const t = await json(dir, "task", "Файл ещё не написан", "--anchor", "src/new.ts:1-2");
    const id = t.env.data["id"] as string;
    expect((t.env.data["anchors"] as Array<{ state: string }>)[0]!.state).toBe("pending");
    writeFileSync(join(dir, "src", "new.ts"), "export const a = 1;\nexport const b = 2;\n");
    const anchor = (await add(id, "src/new.ts:1-2"))["anchor_id"] as string;
    expect(await anchorsOfShow(id)).toEqual([{ path: "src/new.ts", start: 1, end: 2, state: "fresh", node_id: anchor }]);
    expect(text((await myc(dir, "show", id)).stdout)).not.toContain("@—");
  });

  test("намерение, оставленное UNIQUE, довязывается к якорю, стоявшему на месте раньше", async () => {
    const a = await task("Первый владелец");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    const b = await task("Второй владелец, упавший на UNIQUE");
    pendingIntent(b, "src/fuse.ts", 1, 3);
    exec("UPDATE nodes SET created_at = (SELECT created_at + 1 FROM nodes WHERE id = ?2) WHERE id = ?1", b, anchor);

    const check = await data("anchor", "check");
    expect(check["intents_bound"]).toBe(1);
    expect(await anchorsOfShow(b)).toEqual([{ path: "src/fuse.ts", start: 1, end: 3, state: "fresh", node_id: anchor }]);
    expect(n(EDGES_TO, anchor)).toBe(2);
    expect(text((await myc(dir, "anchor", "check")).stdout)).not.toContain("intents bound");
  });

  test("якорь, поставленный ПОСЛЕ намерения, к нему не довязывается — код мог быть другой", async () => {
    const b = await task("Намерение раньше якоря");
    pendingIntent(b, "src/fuse.ts", 1, 3);
    const a = await task("Якорь позже");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    exec("UPDATE nodes SET created_at = (SELECT created_at - 1 FROM nodes WHERE id = ?2) WHERE id = ?1", b, anchor);
    expect((await data("anchor", "check"))["intents_bound"]).toBe(0);
    expect(await anchorsOfShow(b)).toEqual([{ path: "src/fuse.ts", start: 1, end: 3, state: "pending" }]);
    expect(n(EDGES_TO, anchor)).toBe(1);
  });

  test("фон довязывает один раз на базу (отметка в myc_meta), ручной check — всегда", async () => {
    const a = await task("Первый владелец");
    const anchor = (await add(a, "src/fuse.ts:1-3"))["anchor_id"] as string;
    const later = async (title: string): Promise<string> => {
      const id = await task(title);
      pendingIntent(id, "src/fuse.ts", 1, 3);
      exec("UPDATE nodes SET created_at = (SELECT created_at + 1 FROM nodes WHERE id = ?2) WHERE id = ?1", id, anchor);
      return id;
    };
    const dbPath = join(dir, ".myc", "myc.db");
    const env = cliTestEnv({ NODE_ENV: "production", MYC_ANCHOR_CHECK: "1" });
    const b = await later("Намерение до первого прогона фона");
    const first = await drainQueueTail({ dbPath, env });
    expect(first.anchor).not.toBeNull();
    expect(n("SELECT count(*) AS n FROM myc_meta WHERE key = ?1", ANCHOR_INTENTS_SWEPT_KEY)).toBe(1);
    expect(n(EDGES_TO, anchor)).toBe(2);
    expect((await anchorsOfShow(b)).map((x) => x.state)).toEqual(["fresh"]);

    const c = await later("Намерение после отметки");
    exec("DELETE FROM myc_meta WHERE key = 'anchor_swept_at'"); // период §7.5 — пусть фон снова пройдёт
    const second = await drainQueueTail({ dbPath, env });
    expect(second.anchor).not.toBeNull();
    expect((await anchorsOfShow(c)).map((x) => x.state)).toEqual(["pending"]);
    expect((await data("anchor", "check"))["intents_bound"]).toBe(1);
    expect((await anchorsOfShow(c)).map((x) => x.state)).toEqual(["fresh"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Совпавшая личность на ДРУГОМ месте — отдельный якорь, не чужой
//
// МУТАЦИИ: в settleClash присоединяться к узлу без сверки места — знание
// уезжает на чужой файл (случай вложенного репозитория) и на ушедший по
// файлу код (случай дубля головы); снять переименование — дубль головы
// получает conflict.anchor вместо якоря.
// ---------------------------------------------------------------------------

describe("тот же (title, crux) у якоря на другом месте", () => {
  test("x.ts корня и x.ts вложенного репозитория с одинаковым текстом — два якоря, каждый на своём файле", async () => {
    const same = "export const same = 1;\nexport const also = 2;\n";
    writeFileSync(join(dir, "x.ts"), same);
    mkdirSync(join(dir, "alpha", ".git"), { recursive: true });
    writeFileSync(join(dir, "alpha", "x.ts"), same);
    const a = await task("Про корневой x.ts");
    const b = (await dataFrom(join(dir, "alpha"), "task", "Про alpha/x.ts"))["id"] as string;
    const rootAnchor = (await add(a, "x.ts:1-2"))["anchor_id"] as string;
    const inner = await dataFrom(join(dir, "alpha"), "anchor", "add", b, "x.ts:1-2");
    expect(inner["anchor_id"]).not.toBe(rootAnchor);
    expect(inner["owners"]).toBe(1);
    const keys = db((d) => d.query("SELECT node_id, repo_id, path FROM anchors ORDER BY repo_id").all()) as Array<{
      node_id: string;
      repo_id: string;
      path: string;
    }>;
    expect(keys).toEqual([
      { node_id: rootAnchor, repo_id: "", path: "x.ts" },
      { node_id: inner["anchor_id"] as string, repo_id: "alpha", path: "x.ts" },
    ]);
    expect(await ownersOf("x.ts")).toEqual([[a]]);
    expect(await ownersOf("alpha/x.ts")).toEqual([[b]]);
  });

  test("дубль головы: код ушёл по файлу, его копия встала на старое место — у копии свой якорь", async () => {
    const f = "export function twin(a: number) {\n  return a * 2;\n}\n";
    writeFileSync(join(dir, "src", "dup.ts"), `${f}\nexport const tail = 1;\n`);
    const a = await task("Про twin");
    const first = (await add(a, "src/dup.ts:1-3"))["anchor_id"] as string;
    // Четыре строки сверху — лестница уводит якорь на 5-7, заголовок узла остаётся 1-3.
    writeFileSync(join(dir, "src", "dup.ts"), `// 1\n// 2\n// 3\n\n${f}\nexport const tail = 1;\n`);
    await data("anchor", "check");
    expect(n("SELECT count(*) AS n FROM anchors WHERE node_id = ?1 AND span_start = 5", first)).toBe(1);
    // На старое место встаёт копия той же функции.
    writeFileSync(join(dir, "src", "dup.ts"), `${f}\n${f}\nexport const tail = 1;\n`);
    await data("anchor", "check");
    const b = await task("Про копию twin");
    const second = await add(b, "src/dup.ts:1-3");
    expect(second["anchor_id"]).not.toBe(first);
    expect(second["owners"]).toBe(1);
    expect(n("SELECT count(*) AS n FROM nodes WHERE id = ?1 AND title = 'src/dup.ts:5-7'", first)).toBe(1);
    const spans = (await data("anchor", "of", "src/dup.ts"))["spans"] as Array<{ start: number; nodes: Array<{ id: string }> }>;
    expect(spans.map((s) => [s.start, s.nodes.map((x) => x.id)])).toEqual([
      [1, [b]],
      [5, [a]],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. Несколько процессов на один участок (инвариант живёт между процессами)
//
// МУТАЦИЯ: в bindAnchorAt снять второй проход разбора после отказа createNode
// (гонка между поиском и записью) — падает детерминированная половина
// (подменённый createNode). Восемь настоящих процессов в окно гонки почти не
// попадают и эту мутацию обычно НЕ ловят: они стерегут инвариант «один узел,
// N рёбер, ни одного отказа» целиком, а не само окно.
// ---------------------------------------------------------------------------

describe("процессы наперегонки", () => {
  test("чужой узел якоря записан между поиском и createNode — присоединение к нему, не UNIQUE", async () => {
    // Детерминированная половина гонки: окно между `clashOf` и `createNode`
    // — доли миллисекунды, и восемь настоящих процессов (тест ниже) в него
    // почти не попадают. Подмена ставит «выигравший процесс» ровно в окно:
    // его узел записан, строки якоря у него ещё нет.
    let raced: string | undefined;
    const racing: StoreDeps = {
      async openStore(ctx, options) {
        const opened = await realStoreDeps.openStore(ctx, options);
        if (!opened.ok) return opened;
        const store = opened.handle.store;
        const create = store.createNode.bind(store);
        store.createNode = (input) => {
          if (input.kind === "anchor" && raced === undefined) raced = create(input).id;
          return create(input);
        };
        return opened;
      },
    };
    const reg = new Registry();
    reg.register(createAnchorCommand(racing));
    const b = await task("Опоздавший");
    const r = await run(["-C", dir, "anchor", "add", b, "src/fuse.ts:1-3", "--json"], {
      registry: reg,
      env: { MYC_ACTOR: "tester", MYC_HOME: home },
    });
    const env = JSON.parse(text(r.stdout)) as Envelope;
    expect([r.code, env.error?.code]).toEqual([ExitCode.OK, undefined]);
    expect(raced).toBeDefined();
    expect([env.data["anchor_id"], env.data["reused"]]).toEqual([raced, true]);
    expect([n(ROWS), n(LIVE_ANCHORS), n(EDGES_TO, raced!)]).toEqual([1, 1, 1]);
  });

  test(
    "8 процессов привязывают 8 задач к одному участку разом — один узел, 8 рёбер, ни одного отказа",
    async () => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(await task(`Гонка ${i}`));
      const main = join(import.meta.dir, "..", "main.ts");
      const env = cliTestEnv({ MYC_ACTOR: "racer", MYC_HOME: home });
      const procs = ids.map((id) =>
        Bun.spawn([process.execPath, main, "-C", dir, "anchor", "add", id, "src/fuse.ts:1-3", "--json"], {
          stdout: "pipe",
          stderr: "pipe",
          env,
        }),
      );
      const outs = await Promise.all(
        procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })),
      );
      expect(outs.filter((o) => o.code !== 0).map((o) => o.err || o.out)).toEqual([]);
      const anchors = new Set(outs.map((o) => (JSON.parse(o.out) as Envelope).data["anchor_id"]));
      expect(anchors.size).toBe(1);
      const anchor = [...anchors][0] as string;
      expect([n(ROWS), n(LIVE_ANCHORS), n(EDGES_TO, anchor)]).toEqual([1, 1, 8]);
    },
    60_000,
  );
});
