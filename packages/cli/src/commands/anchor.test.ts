/**
 * Приёмка `myc anchor`: привязка, обратный ход код→узлы, журнал грязных
 * файлов и связь с роутингом (memory-3afmdwe7bwyp, memory-rw885z6nvatt).
 *
 * ЗАЧЕМ ТУТ РОУТИНГ. Смысл якорей не в самой таблице: класс задачи для
 * роутинга (swarm/taskclass.ts) считается ПО ЯКОРЯМ, и без них `scope`
 * остаётся `unknown` у каждой задачи разом. Поэтому здесь стоит тест,
 * который спрашивает класс ДО привязки и ПОСЛЕ, — если связь порвётся,
 * упадёт он, а не только тесты таблицы.
 *
 * Латентность запроса по `file:line` и цена хука меряются отдельно —
 * anchor.latency.test.ts: там нужен стенд на 50 000 якорей и методика
 * @myc/bench, здесь — поведение.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand, DIRTY_LOG, drainDirtyLog, parseTarget } from "./anchor.ts";
import { anchorPathsOf, taskClassOf } from "./attempt.ts";
import { readCounters } from "../hooks/counters.ts";
import { createTaskCommand } from "./tasks.ts";

const FUSE = `// заголовок файла
import { x } from "./x.ts";

export function fuseRRF(a: number[], b: number[], k = 60): number[] {
  const out: number[] = [];
  for (const v of a) out.push(v / (k + 1));
  for (const v of b) out.push(v / (k + 1));
  return out;
}

export function other(): void {
  console.log("other");
}
`;

let dir: string;
let home: string;
let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-anchor-cli-"));
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const r = await myc(...args, "--json");
  const env = JSON.parse(r.stdout as string) as { ok: boolean; data: Record<string, unknown> };
  expect(env.ok).toBe(true);
  return env.data;
}

async function newTask(title: string): Promise<string> {
  return (await data("task", title))["id"] as string;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"));
}

// ---------------------------------------------------------------------------
// Разбор file:line
// ---------------------------------------------------------------------------

describe("parseTarget", () => {
  test("file, file:12 и file:12-40 — три разные просьбы", () => {
    expect(parseTarget("a/b.ts")).toEqual({ path: "a/b.ts", start: 1, end: 1, whole: true });
    expect(parseTarget("a/b.ts:12")).toEqual({ path: "a/b.ts", start: 12, end: 12, whole: false });
    expect(parseTarget("a/b.ts:12-40")).toEqual({ path: "a/b.ts", start: 12, end: 40, whole: false });
  });

  test("перевёрнутый и нулевой спан отвергаются, а не приводятся молча", () => {
    expect(parseTarget("a.ts:40-12")).toBeUndefined();
    expect(parseTarget("a.ts:0")).toBeUndefined();
    expect(parseTarget("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// add / of / rm
// ---------------------------------------------------------------------------

describe("add и of: две стороны одной связи", () => {
  test("add записывает узел якоря, строку anchors и ребро touches", async () => {
    const task = await newTask("Гибридный поиск: RRF одним SQL-проходом");
    const added = await data("anchor", "add", task, "src/fuse.ts:4-9");
    expect(added["state"]).toBe("fresh");
    expect(added["path"]).toBe("src/fuse.ts");
    expect(added["crux_lines"]).toBeGreaterThan(1);

    const d = db();
    const row = d
      .query<{ path: string; span_start: number; crux_norm: string; state: string }, [string]>(
        "SELECT path, span_start, crux_norm, state FROM anchors WHERE node_id = ?1",
      )
      .get(added["anchor_id"] as string);
    expect(row?.path).toBe("src/fuse.ts");
    expect(row?.span_start).toBe(4);
    expect(row?.state).toBe("fresh");
    expect(row?.crux_norm).toContain("fuseRRF");

    const kind = d
      .query<{ kind: string; status: string }, [string]>("SELECT kind, status FROM nodes WHERE id = ?1")
      .get(added["anchor_id"] as string);
    expect(kind).toEqual({ kind: "anchor", status: "fresh" });

    const edge = d
      .query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM edges WHERE src = ?1 AND dst = ?2 AND type = 'touches'",
      )
      .get(task, added["anchor_id"] as string);
    expect(edge?.n).toBe(1);
    d.close();
  });

  test("of <file>:<line> отдаёт спан и входящие узлы", async () => {
    const task = await newTask("Гибридный поиск: RRF одним SQL-проходом");
    await data("anchor", "add", task, "src/fuse.ts:4-9");
    const d = await data("anchor", "of", "src/fuse.ts:6");
    const spans = d["spans"] as Array<{ start: number; end: number; nodes: Array<{ id: string }> }>;
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(4);
    expect(spans[0]!.nodes.map((n) => n.id)).toEqual([task]);
  });

  test("of по строке ВНЕ спана не выдумывает попадания", async () => {
    const task = await newTask("Гибридный поиск");
    await data("anchor", "add", task, "src/fuse.ts:4-9");
    const d = await data("anchor", "of", "src/fuse.ts:12");
    expect(d["spans"]).toHaveLength(0);
    expect(d["nodes"]).toBe(0);
  });

  test("вложенные спаны отдаются от самого узкого к широкому", async () => {
    const outer = await newTask("весь файл");
    const inner = await newTask("одна функция");
    await data("anchor", "add", outer, "src/fuse.ts:1-13");
    await data("anchor", "add", inner, "src/fuse.ts:4-9");
    const d = await data("anchor", "of", "src/fuse.ts:6");
    const spans = d["spans"] as Array<{ start: number; end: number }>;
    expect(spans.map((s) => `${s.start}-${s.end}`)).toEqual(["4-9", "1-13"]);
  });

  test("of без строки перечисляет все якоря файла", async () => {
    const a = await newTask("первая");
    const b = await newTask("вторая");
    await data("anchor", "add", a, "src/fuse.ts:4-9");
    await data("anchor", "add", b, "src/fuse.ts:11-13");
    const d = await data("anchor", "of", "src/fuse.ts");
    expect((d["spans"] as unknown[]).length).toBe(2);
    expect(d["line"]).toBeNull();
  });

  test("add на несуществующий файл — отказ, а не якорь в пустоту", async () => {
    const task = await newTask("задача");
    const r = await myc("anchor", "add", task, "src/нет-такого.ts");
    expect(r.code).toBe(ExitCode.NOTFOUND);
  });

  test("rm снимает и строку, и узел, и ребро", async () => {
    const task = await newTask("задача");
    const added = await data("anchor", "add", task, "src/fuse.ts:4-9");
    await data("anchor", "rm", task, "src/fuse.ts");
    const d = db();
    expect(
      d.query<{ n: number }, [string]>("SELECT count(*) AS n FROM anchors WHERE node_id = ?1")
        .get(added["anchor_id"] as string)?.n,
    ).toBe(0);
    d.close();
    const of = await data("anchor", "of", "src/fuse.ts:6");
    expect(of["spans"]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// touch — журнал грязных файлов
// ---------------------------------------------------------------------------

describe("touch: пометить и выйти", () => {
  test("пишет строку в журнал и НЕ трогает базу", async () => {
    const dbFile = join(dir, ".myc", "myc.db");
    const before = readFileSync(dbFile);
    const d = await data("anchor", "touch", "src/fuse.ts");
    expect(d["marked"]).toBe(1);
    expect(readFileSync(join(dir, ".myc", DIRTY_LOG), "utf8")).toContain("src/fuse.ts");
    // Байт в байт: открытие базы на запись меняет её даже без вставок.
    expect(readFileSync(dbFile).equals(before)).toBe(true);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
  });

  test("несколько путей за один вызов — по строке на каждый", async () => {
    const d = await data("anchor", "touch", "src/fuse.ts", "src/other.ts");
    expect(d["marked"]).toBe(2);
    expect(readFileSync(join(dir, ".myc", DIRTY_LOG), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("вне воркспейса — не отказ, а пустая пометка: хук не имеет права падать", async () => {
    const outside = mkdtempSync(join(tmpdir(), "myc-no-ws-"));
    try {
      const r = await run(["-C", outside, "anchor", "touch", "a.ts", "--json"], {
        registry,
        env: { MYC_ACTOR: "tester", MYC_HOME: join(outside, "home") },
      });
      expect(r.code).toBe(ExitCode.OK);
      const env = JSON.parse(r.stdout as string) as { data: { marked: number; skipped: string } };
      expect(env.data.marked).toBe(0);
      expect(env.data.skipped).toContain("workspace");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("500 правок подряд: журнал полон, база не тронута", async () => {
    const dbFile = join(dir, ".myc", "myc.db");
    const before = readFileSync(dbFile);
    for (let i = 0; i < 500; i++) await data("anchor", "touch", `src/f${i % 20}.ts`);
    const lines = readFileSync(join(dir, ".myc", DIRTY_LOG), "utf8").trim().split("\n");
    expect(lines).toHaveLength(500);
    expect(readFileSync(dbFile).equals(before)).toBe(true);
    // Потребитель сводит 500 строк к 20 файлам — дедупликация на его стороне,
    // а не в хуке: в хуке она стоила бы чтения журнала на каждую правку.
    expect(drainDirtyLog(dir)).toHaveLength(20);
  }, 60_000);

  test("drain снимает журнал целиком: повторный вызов пуст", async () => {
    await data("anchor", "touch", "src/fuse.ts");
    expect(drainDirtyLog(dir)).toHaveLength(1);
    expect(drainDirtyLog(dir)).toHaveLength(0);
    expect(existsSync(join(dir, ".myc", DIRTY_LOG))).toBe(false);
  });

  /**
   * Отметка срабатывания хука правки (memory-q9k2zxfx2mcm). Условие то же, что
   * у старта сессии: `myc anchor touch`, набранный руками, отметки НЕ создаёт —
   * иначе счётчик `post-edit` означал бы «кто-нибудь звал anchor touch».
   * И база здесь по-прежнему не открывается: отметка — файл рядом с журналом.
   */
  test("отметку post-edit ставит только вызов из хука", async () => {
    const dbFile = join(dir, ".myc", "myc.db");
    const before = readFileSync(dbFile);
    const hooksJson = join(dir, ".myc", "hooks.json");

    await data("anchor", "touch", "src/fuse.ts");
    expect(existsSync(hooksJson)).toBe(false);

    process.env.MYC_HOOK = "post-edit";
    process.env.MYC_HOOK_AGENT = "claude";
    try {
      await data("anchor", "touch", "src/fuse.ts");
      await data("anchor", "touch", "src/other.ts");
    } finally {
      delete process.env.MYC_HOOK;
      delete process.env.MYC_HOOK_AGENT;
    }
    const c = readCounters(join(dir, ".myc")).hooks["claude:post-edit"];
    expect(c?.count).toBe(2);
    expect(c?.last_status).toBe("ok");
    expect(readFileSync(dbFile).equals(before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe("check: лестница уровней через CLI", () => {
  test("нетронутый файл — уровень 1, файл не читается", async () => {
    const task = await newTask("задача");
    await data("anchor", "add", task, "src/fuse.ts:4-9");
    const d = await data("anchor", "check");
    expect(d["checked"]).toBe(1);
    expect(d["fresh"]).toBe(1);
    expect((d["by_level"] as Record<string, number>)["1"]).toBe(1);
  });

  test("настоящее переформатирование — якорь остаётся fresh и переезжает", async () => {
    const task = await newTask("задача");
    await data("anchor", "add", task, "src/fuse.ts:4-9");
    writeFileSync(
      join(dir, "src", "fuse.ts"),
      FUSE.replace(
        "export function fuseRRF(a: number[], b: number[], k = 60): number[] {",
        "/** док */\nexport function fuseRRF(\n    a: number[],\n    b: number[],\n    k = 60,\n): number[] {",
      ),
    );
    const d = await data("anchor", "check");
    expect(d["fresh"]).toBe(1);
    expect(d["moved"]).toBe(1);
    const of = await data("anchor", "of", "src/fuse.ts:6");
    expect((of["spans"] as Array<{ start: number }>)[0]!.start).toBe(5);
  });

  test("тело переписано — stale, WARN и понижение статуса узла якоря", async () => {
    const task = await newTask("задача");
    const added = await data("anchor", "add", task, "src/fuse.ts:4-9");
    writeFileSync(
      join(dir, "src", "fuse.ts"),
      FUSE.replace(
        "  const out: number[] = [];\n  for (const v of a) out.push(v / (k + 1));\n  for (const v of b) out.push(v / (k + 1));\n  return out;",
        "  const acc = new Map<string, number>();\n  for (const v of a) acc.set(String(v), v);\n  return [...acc.values()];",
      ),
    );
    const r = await myc("anchor", "check", "--json");
    const env = JSON.parse(r.stdout as string) as {
      data: { stale: number };
      warn: Array<{ code: string }>;
    };
    expect(env.data.stale).toBe(1);
    expect(env.warn.map((w) => w.code)).toContain("anchor.stale");
    const d = db();
    expect(
      d.query<{ status: string }, [string]>("SELECT status FROM nodes WHERE id = ?1").get(
        added["anchor_id"] as string,
      )?.status,
    ).toBe("stale");
    d.close();
  });

  test("--dry-run ничего не пишет: состояние в базе остаётся прежним", async () => {
    const task = await newTask("задача");
    const added = await data("anchor", "add", task, "src/fuse.ts:4-9");
    writeFileSync(join(dir, "src", "fuse.ts"), "export const nothing = 1;\n");
    const d = await data("anchor", "check", "--dry-run");
    expect(d["stale"]).toBe(1);
    const raw = db();
    expect(
      raw.query<{ state: string }, [string]>("SELECT state FROM anchors WHERE node_id = ?1").get(
        added["anchor_id"] as string,
      )?.state,
    ).toBe("fresh");
    raw.close();
  });

  test("грязные файлы из журнала идут первыми и считаются отдельно", async () => {
    const a = await newTask("первая");
    const b = await newTask("вторая");
    await data("anchor", "add", a, "src/fuse.ts:4-9");
    writeFileSync(join(dir, "src", "other.ts"), FUSE);
    await data("anchor", "add", b, "src/other.ts:4-9");
    await data("anchor", "touch", "src/other.ts");
    const d = await data("anchor", "check", "--limit", "1");
    expect(d["checked"]).toBe(1);
    expect(d["from_dirty"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Связь с роутингом
// ---------------------------------------------------------------------------

describe("СВЯЗЬ С РОУТИНГОМ: класс задачи перестаёт быть unknown", () => {
  test("до привязки scope=unknown, после — local", async () => {
    const task = await newTask("Гибридный поиск: RRF одним SQL-проходом");
    const d = db();
    const node = d
      .query<{ title: string; attrs: string }, [string]>("SELECT title, attrs FROM nodes WHERE id = ?1")
      .get(task)!;
    const like = { title: node.title, attrs: JSON.parse(node.attrs) as Record<string, never> };

    expect(anchorPathsOf(like, d, task)).toEqual([]);
    const before = taskClassOf(like, d, task);
    expect(before.endsWith(":unknown")).toBe(true);
    d.close();

    await data("anchor", "add", task, "src/fuse.ts:4-9");

    const d2 = db();
    expect(anchorPathsOf(like, d2, task)).toEqual(["src/fuse.ts"]);
    const after = taskClassOf(like, d2, task);
    d2.close();
    expect(after.endsWith(":unknown")).toBe(false);
    expect(after.endsWith(":local")).toBe(true);
    // Намерение не менялось — изменился ровно scope, и именно он был unknown.
    expect(after.split(":")[0]).toBe(before.split(":")[0]);
  });

  test("якоря в разных каталогах верхнего уровня дают cross, а не local", async () => {
    const task = await newTask("задача про две подсистемы");
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg", "b.ts"), FUSE);
    await data("anchor", "add", task, "src/fuse.ts:4-9");
    await data("anchor", "add", task, "pkg/b.ts:4-9");
    const d = db();
    const node = d
      .query<{ title: string; attrs: string }, [string]>("SELECT title, attrs FROM nodes WHERE id = ?1")
      .get(task)!;
    const cls = taskClassOf(
      { title: node.title, attrs: JSON.parse(node.attrs) as Record<string, never> },
      d,
      task,
    );
    d.close();
    expect(cls.endsWith(":cross")).toBe(true);
  });

  test("МУТАЦИЯ: выборка якорей по node_id вместо ребра touches — класс снова unknown", async () => {
    const task = await newTask("Гибридный поиск: RRF одним SQL-проходом");
    await data("anchor", "add", task, "src/fuse.ts:4-9");
    const d = db();
    // Ровно тот запрос, что стоял в anchorPathsOf до починки.
    const mutated = d
      .query<{ path: string }, [string]>("SELECT path FROM anchors WHERE node_id = ?1")
      .all(task);
    d.close();
    expect(mutated).toEqual([]);
  });
});
