/**
 * `myc link` — связывание из терминала (memory-55ggwfrm68gp).
 *
 * Сверку с MCP делает link.parity.test.ts; здесь — то, чего у MCP нет:
 * грамматика argv, коды выхода и человеческий вывод. Первый тест намеренно
 * повторяет строку из SKILL.md ДОСЛОВНО: именно она полтора месяца была
 * указанием звать несуществующую команду, и если она перестанет исполняться,
 * упасть должно здесь, а не у агента в чужом проекте.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createLinkCommand } from "./link.ts";
import { createDepCommand } from "./dep.ts";
import { createTaskCommand } from "./tasks.ts";
import { createShowCommand } from "./show.ts";

let dir: string;
let registry: Registry;

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-link-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createLinkCommand());
  registry.register(createDepCommand());
  registry.register(createTaskCommand());
  registry.register(createShowCommand());
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function mycJson(...args: string[]): Promise<{
  code: number;
  ok: boolean;
  data: Record<string, unknown>;
  error?: { code: string; msg: string; hint?: string };
}> {
  const r = await myc(...args, "--json");
  const env = JSON.parse(text(r.stdout)) as {
    ok: boolean;
    data: Record<string, unknown> | null;
    error?: { code: string; msg: string; hint?: string };
  };
  return { code: r.code, ok: env.ok, data: env.data ?? {}, ...(env.error ? { error: env.error } : {}) };
}

async function task(title: string): Promise<string> {
  const r = await mycJson("task", title);
  expect(r.ok).toBe(true);
  return String(r.data["id"]);
}

/** Значение attrs узла прямо из базы: `show` этих полей не печатает. */
function attrOf(id: string, key: string): unknown {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    const row = db.query("SELECT attrs FROM nodes WHERE id=?1").get(id) as
      | { attrs: string }
      | undefined;
    return (JSON.parse(row!.attrs) as Record<string, unknown>)[key];
  } finally {
    db.close();
  }
}

/** Живые рёбра пары, как они лежат в базе. */
function edges(a: string, b: string): string[] {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return db
      .query("SELECT type FROM edges WHERE ((src=?1 AND dst=?2) OR (src=?2 AND dst=?1)) AND deleted_at IS NULL ORDER BY type")
      .all(a, b)
      .map((r) => (r as { type: string }).type);
  } finally {
    db.close();
  }
}

describe("myc link: строка из SKILL.md исполняется", () => {
  test("`myc link A supersedes B --reason \"...\"` — ребро есть, старый узел жив", async () => {
    const a = await task("новое понимание");
    const b = await task("прежнее понимание");
    const r = await mycJson("link", a, "supersedes", b, "--reason", "замерено на живой базе");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.data["from"]).toBe(a);
    expect(r.data["to"]).toBe(b);
    expect(edges(a, b)).toEqual(["supersedes"]);

    // Противоречие не затирает старое — ровно то, что обещает SKILL.md:
    // на старом узле появляется след, а сам он остаётся читаемым.
    expect(attrOf(b, "superseded_by")).toBe(a);
    const old = await mycJson("show", b);
    expect(old.ok).toBe(true);
    expect(old.data["title"]).toBe("прежнее понимание");
  });

  test("человеческий вывод называет следствие, а не только факт", async () => {
    const a = await task("новое");
    const b = await task("старое");
    const r = await myc("link", a, "supersedes", b, "--reason", "точнее");
    const out = text(r.stdout);
    expect(out).toContain(`${a} supersedes ${b}`);
    expect(out).toContain("superseded_by");
    expect(out).toContain("reason: точнее");
  });

  test("префикс ID разрешается так же, как у остальных команд", async () => {
    const a = await task("первый");
    const b = await task("второй");
    const short = a.slice(a.indexOf("-") + 1, a.indexOf("-") + 4);
    const r = await mycJson("link", short, "relates-to", b);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.data["from"]).toBe(a);
  });
});

describe("myc link: отказы называют причину и не оставляют следа", () => {
  test("без аргументов — usage с перечислением типов", async () => {
    const r = await mycJson("link");
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.error!.code).toBe("usage.invalid");
    expect(r.error!.hint).toContain("supersedes");
    expect(r.error!.hint).toContain("blocks");
  });

  test("неизвестный тип — usage, ребра нет", async () => {
    const a = await task("A");
    const b = await task("B");
    const r = await mycJson("link", a, "укрепляет", b);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.error!.code).toBe("usage.invalid");
    expect(edges(a, b)).toEqual([]);
  });

  test("supersedes без reason — отказ ДО записи, а не после", async () => {
    const a = await task("A");
    const b = await task("B");
    const r = await mycJson("link", a, "supersedes", b);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.error!.code).toBe("usage.missing");
    // Мутация «сначала пишем, потом проверяем» упала бы ровно здесь.
    expect(edges(a, b)).toEqual([]);
  });

  test("duplicates без reason — тот же отказ: правило одно на два типа", async () => {
    const a = await task("A");
    const b = await task("B");
    const r = await mycJson("link", a, "duplicates", b);
    expect(r.error!.code).toBe("usage.missing");
    expect(edges(a, b)).toEqual([]);
  });

  test("несуществующий узел — notfound, а не молчаливое ребро в пустоту", async () => {
    const a = await task("A");
    const r = await mycJson("link", a, "relates-to", "нет-такого");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.error!.code).toBe("notfound.node");
  });

  test("повтор — conflict (4), снятие несуществующего — notfound (3)", async () => {
    const a = await task("A");
    const b = await task("B");
    expect((await mycJson("link", a, "relates-to", b)).code).toBe(ExitCode.OK);
    const again = await mycJson("link", a, "relates-to", b);
    expect(again.code).toBe(ExitCode.CONFLICT);
    expect(again.error!.code).toBe("conflict.edge_exists");
    expect((await mycJson("link", a, "relates-to", b, "--remove")).code).toBe(ExitCode.OK);
    const gone = await mycJson("link", a, "relates-to", b, "--remove");
    expect(gone.code).toBe(ExitCode.NOTFOUND);
    expect(gone.error!.code).toBe("notfound.edge");
  });
});

describe("myc link: зависимости идут через движок dep, а не мимо него", () => {
  test("blocks кладёт то же ребро, что и dep add", async () => {
    const a = await task("A");
    const b = await task("B");
    const c = await task("C");
    expect((await mycJson("link", a, "blocks", b)).code).toBe(ExitCode.OK);
    expect((await mycJson("dep", "add", a, "blocks", c)).code).toBe(ExitCode.OK);
    expect(edges(a, b)).toEqual(edges(a, c));
    expect(edges(a, b)).toEqual(["blocks"]);
  });

  test("цикл ловится движком: conflict.dep_cycle, а не «уже есть»", async () => {
    const a = await task("A");
    const b = await task("B");
    expect((await mycJson("link", a, "blocks", b)).code).toBe(ExitCode.OK);
    const cycle = await mycJson("link", b, "blocks", a);
    expect(cycle.code).toBe(ExitCode.CONFLICT);
    expect(cycle.error!.code).toBe("conflict.dep_cycle");
  });

  test("эффект ready назван: задача ушла из очереди и вернулась в неё", async () => {
    const a = await task("A");
    const b = await task("B");
    const added = await mycJson("link", a, "blocks", b);
    expect(added.data["effects"]).toEqual([`${b} вышла из ready`]);
    const removed = await mycJson("link", a, "blocks", b, "--remove");
    expect(removed.data["effects"]).toEqual([`${b} снова ready`]);
    expect(removed.data["removed"]).toBe(true);
  });
});
