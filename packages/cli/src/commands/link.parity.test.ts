/**
 * memory-55ggwfrm68gp: `myc link` (терминал) и `myc_link` (MCP) — одна связь,
 * две двери. Тест гоняет ОДИН сценарий через обе двери и сверяет три вещи:
 * ответ, эффекты и ИТОГОВЫЙ ГРАФ.
 *
 * ЗАЧЕМ ИМЕННО ТАК. Совпадение поверхностей раньше обещалось комментарием
 * («тот же набор»), и ровно так же трижды разъезжалось: PRAGMA (S43),
 * комментарии (S64), теперь связи. Сравнение таблиц типов «на глаз» ловит
 * только переименование; сценарий на живой базе ловит и разницу в EdgeKind,
 * и разный код отказа, и забытый `superseded_by`. Поэтому сверяются НЕ
 * объявления, а строки в `edges` после одинаковых действий.
 *
 * ПОЧЕМУ ОДНА БАЗА, А НЕ ДВЕ. ID генерируются, в двух воркспейсах они разные,
 * и сравнение пришлось бы делать «примерно». Здесь пары узлов две в одной
 * базе: (a1,b1) для CLI, (a2,b2) для MCP; в ответах ID заменяются на SRC/DST,
 * и сравнение становится точным.
 *
 * Реестр берётся боевой (registerAll): тест обязан упасть и в том случае,
 * если команда написана, но не подключена, — этот отказ здесь уже случался.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { createDispatcher, openMcpStore, AGENT_TOOLS, type Dispatch } from "@myc/mcp";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import { LINK_TYPES, LINK_EDGE_KINDS } from "./link.ts";

let dir: string;
let registry: Registry;
let mcp: Dispatch;

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "parity";
  dir = mkdtempSync(join(tmpdir(), "myc-link-parity-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registerAll(registry);
  mcp = createDispatcher({
    runCli: async (argv) => {
      const r = await run(["-C", dir, ...argv], { registry, env: { MYC_ACTOR: "parity" } });
      return { code: r.code, stdout: text(r.stdout) };
    },
    openStore: () => openMcpStore(dir),
  });
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Сценарий: один список шагов, исполняемый обеими поверхностями
// ---------------------------------------------------------------------------

interface Step {
  readonly what: string;
  readonly type: string;
  readonly reason?: string;
  readonly remove?: boolean;
}

/** Нормализованный ответ: без ID, без времени — только то, что обязано совпасть. */
interface Outcome {
  readonly what: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly msg?: string;
  readonly edge?: { from: string; type: string; to: string };
  readonly effects?: string[];
}

/** Все девять типов и оба отказа контракта — в одном списке. */
function scenario(): Step[] {
  const steps: Step[] = [];
  for (const type of Object.keys(LINK_EDGE_KINDS)) {
    const reason = { reason: "почему именно так" };
    const needsReason = type === "supersedes" || type === "duplicates";
    steps.push({ what: `${type}: создать`, type, ...(needsReason ? reason : {}) });
    steps.push({ what: `${type}: повтор — конфликт`, type, ...(needsReason ? reason : {}) });
    steps.push({ what: `${type}: снять`, type, remove: true, ...(needsReason ? reason : {}) });
    steps.push({
      what: `${type}: снять снова — нечего`,
      type,
      remove: true,
      ...(needsReason ? reason : {}),
    });
  }
  // Зависимости: у них свой движок (ready-очередь), и эффект обязан совпасть.
  steps.push({ what: "blocks: создать", type: "blocks" });
  steps.push({ what: "blocks: снять", type: "blocks", remove: true });
  steps.push({ what: "blocked-by: создать", type: "blocked-by" });
  steps.push({ what: "blocked-by: снять", type: "blocked-by", remove: true });
  // Отказы контракта.
  steps.push({ what: "неизвестный тип", type: "укрепляет" });
  steps.push({ what: "supersedes без reason", type: "supersedes" });
  return steps;
}

function normalize(value: string, src: string, dst: string): string {
  return value.split(src).join("SRC").split(dst).join("DST");
}

async function viaCli(src: string, dst: string, step: Step): Promise<Outcome> {
  const argv = ["-C", dir, "link", src, step.type, dst, "--json"];
  if (step.reason !== undefined) argv.push("--reason", step.reason);
  if (step.remove === true) argv.push("--remove");
  const r = await run(argv, { registry, env: { MYC_ACTOR: "parity" } });
  const env = JSON.parse(text(r.stdout)) as {
    ok: boolean;
    data: { from: string; type: string; to: string; effects: string[] } | null;
    error?: { code: string; msg: string };
  };
  if (!env.ok) {
    return {
      what: step.what,
      ok: false,
      code: env.error!.code,
      msg: normalize(env.error!.msg, src, dst),
    };
  }
  const d = env.data!;
  return {
    what: step.what,
    ok: true,
    edge: { from: normalize(d.from, src, dst), type: d.type, to: normalize(d.to, src, dst) },
    effects: d.effects.map((e) => normalize(e, src, dst)),
  };
}

async function viaMcp(src: string, dst: string, step: Step): Promise<Outcome> {
  const args: Record<string, unknown> = { from: src, type: step.type, to: dst };
  if (step.reason !== undefined) args["reason"] = step.reason;
  if (step.remove === true) args["remove"] = true;
  const r = await mcp("myc_link", args);
  if (r.isError === true) {
    const raw = r.content[0]!.text;
    const m = /^myc: ([^:]+): ([\s\S]*)$/.exec(raw.split("\nhint:")[0]!);
    return {
      what: step.what,
      ok: false,
      code: m![1]!,
      msg: normalize(m![2]!, src, dst),
    };
  }
  const s = r.structuredContent as {
    edge: { from: string; type: string; to: string };
    effects: string[];
  };
  return {
    what: step.what,
    ok: true,
    edge: {
      from: normalize(s.edge.from, src, dst),
      type: s.edge.type,
      to: normalize(s.edge.to, src, dst),
    },
    effects: s.effects.map((e) => normalize(e, src, dst)),
  };
}

async function makeTask(title: string): Promise<string> {
  const r = await run(["-C", dir, "task", title, "--json"], {
    registry,
    env: { MYC_ACTOR: "parity" },
  });
  const env = JSON.parse(text(r.stdout)) as { ok: boolean; data: { id: string } };
  expect(env.ok).toBe(true);
  return env.data.id;
}

/** Рёбра пары, как они лежат в базе: тип ядра и живость тумбстоуна. */
function edgesOf(src: string, dst: string): { type: string; alive: boolean }[] {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return db
      .query("SELECT type, deleted_at FROM edges WHERE (src=?1 AND dst=?2) OR (src=?2 AND dst=?1) ORDER BY type")
      .all(src, dst)
      .map((r) => {
        const row = r as { type: string; deleted_at: number | null };
        return { type: row.type, alive: row.deleted_at === null };
      });
  } finally {
    db.close();
  }
}

function supersededBy(id: string, src: string, dst: string): string | undefined {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    const row = db.query("SELECT attrs FROM nodes WHERE id=?1").get(id) as
      | { attrs: string }
      | undefined;
    const attrs = JSON.parse(row!.attrs) as Record<string, unknown>;
    const value = attrs["superseded_by"];
    return typeof value === "string" ? normalize(value, src, dst) : undefined;
  } finally {
    db.close();
  }
}

describe("myc link и myc_link: одна связь на две поверхности", () => {
  test("один сценарий, оба прогона: ответы, эффекты и граф совпадают", async () => {
    const steps = scenario();
    // Пара для терминала и пара для MCP — в одной базе, чтобы сравнение было
    // точным, а не «примерно похожим».
    const a1 = await makeTask("узел A (cli)");
    const b1 = await makeTask("узел B (cli)");
    const a2 = await makeTask("узел A (mcp)");
    const b2 = await makeTask("узел B (mcp)");

    const cli: Outcome[] = [];
    for (const step of steps) cli.push(await viaCli(a1, b1, step));
    const viaTool: Outcome[] = [];
    for (const step of steps) viaTool.push(await viaMcp(a2, b2, step));

    expect(cli).toEqual(viaTool);
    // Сценарий обязан быть непустым и содержать оба исхода: список из одних
    // отказов сошёлся бы точно так же и ничего бы не доказал.
    expect(steps.length).toBe(4 * Object.keys(LINK_EDGE_KINDS).length + 6);
    expect(cli.filter((o) => o.ok).length).toBeGreaterThan(0);
    expect(cli.filter((o) => !o.ok).length).toBeGreaterThan(0);

    // Итоговый граф: те же типы рёбер ядра, то же состояние тумбстоунов.
    expect(edgesOf(a1, b1)).toEqual(edgesOf(a2, b2));
    expect(edgesOf(a1, b1).length).toBeGreaterThan(0);
    // supersedes оставил след на СТАРОМ узле, и на обеих поверхностях один.
    expect(supersededBy(b1, a1, b1)).toBe("SRC");
    expect(supersededBy(b2, a2, b2)).toBe("SRC");
  });

  test("список типов у команды и у MCP-схемы совпадает поэлементно", () => {
    const tool = AGENT_TOOLS.find((t) => t.name === "myc_link");
    const props = (tool!.inputSchema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(props["type"]!.enum).toEqual([...LINK_TYPES]);
    // Обязательность reason названа в описании инструмента и проверяется
    // командой — расхождение здесь означало бы разный контракт при одинаковых
    // именах типов.
    expect(tool!.description).toContain("supersedes and duplicates require a reason");
  });
});
