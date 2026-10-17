/**
 * Мастер `myc init` (memory-43q5mmra1cfg): вопросы — только терминал или
 * `--interactive`; без терминала init остаётся «zero questions» — от этого
 * свойства зависят агенты и все скрипты, запускающие init без stdin.
 *
 * Две среды, один код: в терминале отвечает readline, в тестах — очередь
 * строк через `ask`. E2E ниже гоняет НАСТОЯЩИЙ init --interactive под
 * пайпом: это единственная проверка readline-пути.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID } from "@myc/embed";
import type { CommandContext, CommandResult } from "../registry.ts";
import {
  applyWizardPlan,
  runInitWizard,
  wizardEnabled,
  type Ask,
  type WizardDeps,
  type WizardPlan,
} from "./init-wizard.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mycDir(): string {
  const d = mkdtempSync(join(tmpdir(), "myc-wiz-"));
  dirs.push(d);
  return d;
}

function ctx(flags: Record<string, string | boolean> = {}, globals: Partial<CommandContext["globals"]> = {}): CommandContext {
  return {
    args: [],
    flags,
    globals: { json: false, ndjson: false, strict: false, quiet: false, color: false, ...globals },
    warn: () => {},
    diagnostics: { add: () => {} } as unknown as CommandContext["diagnostics"],
  };
}

function scripted(answers: readonly string[]): { ask: Ask; asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const ask: Ask = async (q) => {
    asked.push(q);
    return queue.shift() ?? "";
  };
  return { ask, asked };
}

const ALL = ["claude", "codex", "opencode", "kimi", "mcode", "mimo"];

describe("wizardEnabled: терминал решает, не привычка", () => {
  test("без терминала и без флага — выключен (агенты и скрипты не зависают)", () => {
    // В bun test stdin/stdout — не TTY.
    expect(wizardEnabled(ctx())).toBe(false);
  });

  test("--interactive включает; --json/--ndjson выключают даже его", () => {
    expect(wizardEnabled(ctx({ interactive: true }))).toBe(true);
    expect(wizardEnabled(ctx({ interactive: true }, { json: true }))).toBe(false);
    expect(wizardEnabled(ctx({ interactive: true }, { ndjson: true }))).toBe(false);
  });

  test("--interactive сильнее quiet: явный запрос важнее фонового шума", () => {
    // quiet без интерактива в тестах и так выключен (stdin не TTY); флаг же —
    // явное «отвечай», и он побеждает.
    expect(wizardEnabled(ctx({ interactive: true }, { quiet: true }))).toBe(true);
  });
});

describe("runInitWizard: план по ответам", () => {
  const input = (answers: readonly string[], over: Partial<Parameters<typeof runInitWizard>[0]> = {}) => {
    const { ask, asked } = scripted(answers);
    return {
      asked,
      run: () =>
        runInitWizard({
          ask,
          askSlug: true,
          defaultSlug: "defname",
          askCodeIntel: true,
          graftFound: false,
          ...over,
        }),
    };
  };

  test("свежий воркспейс: всё по цепочке, каждое поле по явному выбору", async () => {
    const i = input([
      "myslug", // slug
      "2", // code intel = auto
      "1", // модель: первая в списке = DEFAULT (multilingual)
      "y", // грамматики
      "myc.example.com/ws", // сервер (без схемы — допишется)
      "myc_token", // токен
      "", // фоновый обмен: Enter = дефолт Y = auto
      "2", // wire: choose
      "claude,codex,нет-такого", // агенты: мусор отфильтруется
      "y", // AGENTS.md
      "n", // statusline
      "y", // queue hook
    ]);
    const plan = await i.run();
    expect(plan).toEqual({
      slug: "myslug",
      codeIntel: "auto",
      embedModel: DEFAULT_MODEL_ID,
      grammars: true,
      server: { url: "https://myc.example.com/ws", token: "myc_token" },
      sync: "auto",
      agents: ["claude", "codex"],
      agentsMd: true,
      statusline: false,
      queueHook: true,
    });
  });

  test("всё по Enter — безопасные умолчания: ни сети, ни файлов, ни хуков", async () => {
    const i = input(["", "", "", "", "", "", ""]);
    const plan = await i.run();
    expect(plan).toEqual({ slug: "defname", codeIntel: "builtin" });
  });

  test("существующий воркспейс: о слаге и code_intel не спрашивают", async () => {
    const i = input(["0", "n", "", "3"], { askSlug: false, askCodeIntel: false, graftFound: true });
    const plan = await i.run();
    expect(plan).toEqual({});
    for (const q of i.asked) {
      expect(q).not.toContain("Slug");
      expect(q).not.toContain("Code intelligence");
    }
  });

  test("мусорный слаг пере-спрашивается, после трёх попыток — умолчание", async () => {
    const bad = input(["BAD", "тоже-нет", "!!!", "", "", "", "", ""]);
    expect((await bad.run()).slug).toBe("defname");
    const ok = input(["BAD", "good1", "", "", "", "", "", ""]);
    expect((await ok.run()).slug).toBe("good1");
  });

  test("code intel off подавляет вопрос о грамматиках", async () => {
    const i = input(["slug1", "off", "0", "", "", "3"]);
    const plan = await i.run();
    expect(plan.codeIntel).toBe("off");
    expect(plan.grammars).toBeUndefined();
    expect(i.asked.some((q) => q.includes("grammars"))).toBe(false);
  });

  test("сервер без схемы получает https://; пустой токен — без файла", async () => {
    const i = input(["slug1", "1", "0", "n", "myc.host.example/ws", "", "n", "3"]);
    const plan = await i.run();
    expect(plan.server).toEqual({ url: "https://myc.host.example/ws" });
    expect(plan.sync).toBe("manual");
  });
});

describe("applyWizardPlan: записывает и зовёт, ничего не роняя", () => {
  const okResult: CommandResult = { ok: true, data: null };
  const deps = (over: Partial<WizardDeps> = {}): { deps: WizardDeps; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        runModelsFetch: async (_c, id) => (calls.push(`model:${id}`), okResult),
        runCodeFetch: async () => (calls.push("grammars"), okResult),
        runWire: async (_c, f) => (calls.push(`wire:${JSON.stringify(f)}`), okResult),
        ...over,
      },
    };
  };

  test("сервер и токен — в конфиг и в .myc/token; sync — рядом", async () => {
    const dir = mycDir();
    const { deps: d } = deps();
    const plan: WizardPlan = {
      server: { url: "https://s.example/ws", token: "myc_t" },
      sync: "auto",
    };
    const r = await applyWizardPlan(ctx(), plan, { mycDir: dir }, d);
    expect(readFileSync(join(dir, "workspace.toml"), "utf8")).toContain('server = "https://s.example/ws"');
    expect(readFileSync(join(dir, "workspace.toml"), "utf8")).toContain('sync = "auto"');
    expect(readFileSync(join(dir, "token"), "utf8")).toBe("myc_t\n");
    expect(r.applied).toEqual(['server = "https://s.example/ws"', ".myc/token", 'sync = "auto"']);
    expect(r.next).toContain("myc sync");
    expect(r.warnings).toEqual([]);
  });

  test("без токена — WARN, а не отказ: воркспейс уже создан", async () => {
    const dir = mycDir();
    const { deps: d } = deps();
    const r = await applyWizardPlan(ctx(), { server: { url: "https://s.example" } }, { mycDir: dir }, d);
    expect(r.warnings.map((w) => w.code)).toEqual(["wizard.token"]);
    expect(readFileSync(join(dir, "workspace.toml"), "utf8")).toContain("server");
  });

  test("модель, грамматики и wire зовутся теми же обработчиками, с правильными флагами", async () => {
    const dir = mycDir();
    const { deps: d, calls } = deps();
    const plan: WizardPlan = {
      embedModel: "bge-small-en-v1.5-q8",
      grammars: true,
      agents: ["claude", "opencode"],
      agentsMd: true,
      queueHook: true,
    };
    const r = await applyWizardPlan(ctx(), plan, { mycDir: dir }, d);
    expect(calls[0]).toBe("model:bge-small-en-v1.5-q8");
    expect(calls[1]).toBe("grammars");
    expect(JSON.parse(calls[2]!.slice(5))).toEqual({
      agents: "claude,opencode",
      "agents-md": true,
      "queue-hook": true,
    });
    expect(r.applied).toContain("wired: claude,opencode");
    expect(r.next).toContain("myc ready");
  });

  test("сбой пост-шага — в warnings, applied его не содержит, init не падает", async () => {
    const dir = mycDir();
    const fail: CommandResult = { ok: false, code: "usage.invalid", msg: "нет сети", exit: 2 };
    const { deps: d } = deps({ runModelsFetch: async () => fail });
    const r = await applyWizardPlan(ctx(), { embedModel: DEFAULT_MODEL_ID }, { mycDir: dir }, d);
    expect(r.warnings.map((w) => w.code)).toEqual(["wizard.model"]);
    expect(r.applied).toEqual([]);
  });

  test("пустой план — тишина", async () => {
    const { deps: d, calls } = deps();
    const r = await applyWizardPlan(ctx(), {}, { mycDir: mycDir() }, d);
    expect(calls).toEqual([]);
    expect(r).toEqual({ applied: [], next: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// E2E: настоящий init --interactive под пайпом (проверяет readline-путь)
// ---------------------------------------------------------------------------

const CLI_ENTRY = join(import.meta.dir, "..", "main.ts");

function spawnEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    NO_COLOR: "1",
    MYC_SERVER: "",
    MYC_TOKEN: "",
  };
}

async function runInit(dir: string, argv: readonly string[], answers?: string): Promise<number> {
  const child = Bun.spawn([process.execPath, CLI_ENTRY, ...argv], {
    cwd: dir,
    env: spawnEnv(),
    stdin: answers === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (answers !== undefined) {
    const input = child.stdin;
    if (input !== null && input !== undefined) {
      input.write(answers);
      input.end();
    }
  }
  return await child.exited;
}

describe("E2E: init --interactive под пайпом", () => {
  test("мастер отвечает через stdin и создаёт воркспейс по ответам", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myc-wiz-e2e-"));
    dirs.push(dir);
    // slug, code intel, модель, грамматики, сервер (пропуск), wire (пропуск)
    const code = await runInit(dir, ["init", "--interactive"], "e2eslug\n1\n0\nn\n\n3\n");
    expect(code).toBe(0);
    const toml = readFileSync(join(dir, ".myc", "workspace.toml"), "utf8");
    expect(toml).toContain('slug = "e2eslug"');
    expect(toml).toContain('code_intel = "builtin"');
  }, 30_000);

  test("без --interactive и без терминала init задаёт ноль вопросов", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myc-wiz-e2e-"));
    dirs.push(dir);
    // stdin закрыт, ответов нет: если бы init ждал ответ — он бы завис и упал по таймауту.
    const code = await runInit(dir, ["init"]);
    expect(code).toBe(0);
    const toml = readFileSync(join(dir, ".myc", "workspace.toml"), "utf8");
    expect(toml).toContain("code_intel");
  }, 30_000);
});
