/**
 * Права и таймауты, которые пишет `myc wire` в `.claude/settings.json`
 * (доработка memory-sj2h9k235rxs).
 *
 * ПРАВА. Прежнее `Bash(myc:*)` было обходом системы разрешений: `myc run -- X`
 * исполняет любую X, а правило совпадало с текстом всей команды — `myc run --
 * rm -rf …` проходил без вопроса. Теперь wire разрешает подкоманды из реестра
 * по одной, кроме тех, что исполняют переданную им команду или переписывают
 * права агента (ASK_SUBCOMMANDS). Проверяется это той же семантикой правил,
 * что у Claude Code 2.1.267 (`X:*` — `X` или `X …`), — функцией разбора хука,
 * у которой она сверена примерами в hooks/queue-hook.test.ts.
 *
 * ТАЙМАУТЫ. Claude Code читает `timeout` записи хука в СЕКУНДАХ (бинарь
 * 2.1.267: «Timeout in seconds for this specific command»,
 * `yn=e.timeout?e.timeout*1000:Yf`), а wire писал миллисекунды: 3000 у
 * session-start — 50 минут. Повторный wire переписывает наши записи, чужие
 * не трогает.
 *
 * Мутации, на которых этот файл обязан краснеть (проверены на приёмке):
 *   «широкое Bash(myc:*) вернулось» — mycPermissions снова отдаёт
 *       `Bash(myc:*)`: падает «агент сам вызывает myc run -- rm -rf …»;
 *   «таймаут в миллисекундах» — hostTimeoutSeconds отдаёт timeoutMs как есть:
 *       падают «секунды у всех наших хуков» и миграция.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import { QUEUE_CLASSIFIER_JS, queueClassifierConfig } from "../hooks/queue-hook.ts";
import { ASK_SUBCOMMANDS, createUnwireCommand, createWireCommand, mycPermissions, type WireDeps } from "./wire.ts";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myc-wire-perms-"));
  dir = join(root, "proj");
  mkdirSync(join(dir, ".myc"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Реестр как у настоящего CLI (registerAll), wire — с подменёнными зависимостями. */
function registry(overrides: Partial<WireDeps> = {}): Registry {
  const r = new Registry();
  registerAll(r);
  r.register(
    createWireCommand(r, {
      probeStatusLine: () => ({ ok: true }),
      probeQueue: () => ({ ok: true, bin: { command: "myc", source: "path" } }),
      env: { CLAUDE_CONFIG_DIR: join(root, "claude-config") },
      platform: "darwin",
      ...overrides,
    }),
  );
  r.register(createUnwireCommand());
  return r;
}

function myc(r: Registry, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry: r, env: { MYC_ACTOR: "tester", MYC_DRAIN: "0" } });
}

function write(rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");
const settings = (): Record<string, any> => JSON.parse(read(".claude/settings.json")) as Record<string, any>;
const allow = (): string[] => (settings()["permissions"]?.["allow"] ?? []) as string[];

/** Сравнение правила с командой — семантикой Claude Code (та же функция, что в хуке). */
const claude = (new Function(`${QUEUE_CLASSIFIER_JS}\nreturn makeQueueClassifier;`)() as (
  o: unknown,
  host: unknown,
) => { ruleOf(c: string): unknown; matchRule(r: unknown, t: string): boolean })(queueClassifierConfig(), {});

/** Какое allow-правило пропустило бы команду без вопроса; null — никакое. */
function approvedBy(rules: readonly string[], command: string): string | null {
  for (const rule of rules) {
    if (rule === "Bash") return rule;
    const m = /^Bash\(([\s\S]*)\)$/.exec(rule);
    if (m !== null && claude.matchRule(claude.ruleOf(m[1]!), command)) return rule;
  }
  return null;
}

describe("права: myc не обход системы разрешений", () => {
  test("агент сам вызывает myc run -- rm -rf … — ни одно правило wire его не пропускает", async () => {
    const r = registry();
    expect((await myc(r, "wire", "--agents", "claude")).code).toBe(0);
    const rules = allow();
    const target = join(root, "victim");
    for (const command of [
      `myc run -- rm -rf ${target}`,
      `myc run --max-wait 1m -- rm -rf ${target}`,
      `myc statusline --then 'rm -rf ${target}'`,
      "myc wire --hook-mode replace",
      "myc unwire",
    ]) {
      expect([command, approvedBy(rules, command)]).toEqual([command, null]);
    }
    // А обычная работа агента с myc вопросов не вызывает.
    for (const command of ["myc prime", "myc ready --claim", "myc recall 'how retrieval works'", "myc queue", "myc close x --reason y"]) {
      expect([command, approvedBy(rules, command) !== null]).toEqual([command, true]);
    }
  });

  test("разрешения — из реестра: каждая команда, кроме исполняющих чужое и переписывающих права", async () => {
    const r = registry();
    await myc(r, "wire", "--agents", "claude");
    const names = r.top.map((c) => c.name);
    for (const name of ASK_SUBCOMMANDS.keys()) expect([name, names.includes(name)]).toEqual([name, true]);
    const expected = names.filter((n) => !ASK_SUBCOMMANDS.has(n)).sort().map((n) => `Bash(myc ${n}:*)`);
    expect(mycPermissions(r)).toEqual(expected);
    expect(allow()).toEqual(expected);
    expect(allow()).not.toContain("Bash(myc:*)");
  });

  test("прежнее Bash(myc:*) в файле нашего журнала wire снимает сам и говорит об этом", async () => {
    const r = registry();
    await myc(r, "wire", "--agents", "claude");
    // Так файл выглядел после wire прежней версии: широкое правило рядом с нашими.
    const old = settings();
    old["permissions"]["allow"] = ["Bash(git status)", "Bash(myc:*)"];
    write(".claude/settings.json", `${JSON.stringify(old, null, 2)}\n`);
    const res = await myc(r, "wire", "--agents", "claude", "--json");
    expect(allow()).not.toContain("Bash(myc:*)");
    expect(allow()[0]).toBe("Bash(git status)");
    expect((JSON.parse(res.stdout as string).data as { notes: string[] }).notes.join("\n")).toContain(
      "removed the old permissions.allow[Bash(myc:*)]",
    );
  });

  test("чужое Bash(myc:*) (файл не из нашего журнала) не трогается, но сказано вслух", async () => {
    write(".claude/settings.json", `${JSON.stringify({ permissions: { allow: ["Bash(myc:*)"] } }, null, 2)}\n`);
    const res = await myc(registry(), "wire", "--agents", "claude", "--json");
    expect(allow()).toContain("Bash(myc:*)");
    expect((JSON.parse(res.stdout as string).data as { notes: string[] }).notes.join("\n")).toContain(
      "wire did not write it and leaves it alone",
    );
  });

  test("широкое правило в пользовательском слое — wire его не пишет, но предупреждает", async () => {
    const cfg = join(root, "claude-config");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(myc:*)"] } }));
    const res = await myc(registry(), "wire", "--agents", "claude", "--json");
    expect((JSON.parse(res.stdout as string).data as { notes: string[] }).notes.join("\n")).toContain(
      "runs without asking in every project",
    );
  });

  test("unwire снимает новые правила побайтно: чужой allow и файл — как были", async () => {
    const original = `${JSON.stringify({ permissions: { allow: ["Bash(git status)"], deny: ["Read(./.env)"] }, env: { A: "1" } }, null, 2)}\n`;
    write(".claude/settings.json", original);
    const r = registry();
    expect((await myc(r, "wire", "--agents", "claude", "--queue-hook")).code).toBe(0);
    expect(allow().length).toBeGreaterThan(10);
    expect((await myc(r, "wire", "--agents", "claude", "--queue-hook")).code).toBe(0); // повторный — тот же итог
    expect((await myc(r, "unwire")).code).toBe(0);
    expect(read(".claude/settings.json")).toBe(original);
  });

  test("файл без allow до wire — после unwire allow нет", async () => {
    const original = `${JSON.stringify({ env: { A: "1" } }, null, 2)}\n`;
    write(".claude/settings.json", original);
    const r = registry();
    await myc(r, "wire", "--agents", "claude");
    await myc(r, "unwire");
    expect(read(".claude/settings.json")).toBe(original);
  });
});

describe("таймауты хуков Claude Code — секунды", () => {
  test("секунды у всех наших хуков, включая PreToolUse очереди", async () => {
    expect((await myc(registry(), "wire", "--agents", "claude", "--queue-hook")).code).toBe(0);
    const hooks = settings()["hooks"] as Record<string, any[]>;
    const timeouts = Object.fromEntries(Object.entries(hooks).map(([event, list]) => [event, list[0].hooks[0].timeout]));
    expect(timeouts).toMatchObject({ SessionStart: 3, PreCompact: 8, PostToolUse: 2, PreToolUse: 5 });
    for (const t of Object.values(timeouts)) expect(t as number).toBeLessThanOrEqual(10);
  });

  /**
   * Миграция: так выглядел settings.json после wire прежних версий — наши
   * записи с миллисекундами — и чужие хуки рядом (на другом событии и на том же).
   * Повторный wire переписывает только наши; чужие 3000 остаются чужими 3000.
   */
  test("повторный wire переписывает наши записи с миллисекундами, чужие не трогает", async () => {
    const ours = (event: string, ms: number, matcher?: string): Record<string, unknown> => ({
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{ type: "command", command: `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs" ${event}`, timeout: ms }],
    });
    const foreign = { hooks: [{ type: "command", command: "other-tool notify", timeout: 3000 }] };
    const sameEvent = { hooks: [{ type: "command", command: "bd prime --hook-json", timeout: 3000 }] };
    write(
      ".claude/settings.json",
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [sameEvent, ours("session-start", 3000)],
            PreCompact: [ours("pre-compact", 8000, "manual|auto")],
            PostToolUse: [ours("post-edit", 1500, "Write|Edit|MultiEdit|NotebookEdit")],
            Notification: [foreign],
          },
          permissions: { allow: ["Bash(myc:*)"] },
        },
        null,
        2,
      )}\n`,
    );
    expect((await myc(registry(), "wire", "--agents", "claude", "--hook-mode", "append")).code).toBe(0);
    const hooks = settings()["hooks"] as Record<string, any[]>;
    expect(hooks["SessionStart"]!.map((e) => e.hooks[0].timeout)).toEqual([3000, 3]);
    expect(hooks["SessionStart"]![0].hooks[0].command).toBe("bd prime --hook-json");
    expect(hooks["PreCompact"]![0].hooks[0].timeout).toBe(8);
    expect(hooks["PostToolUse"]![0].hooks[0].timeout).toBe(2);
    expect(hooks["Notification"]).toEqual([foreign]);
  });
});

describe("проверка у настоящего CLI", () => {
  test("wire из реестра CLI не пишет правило на run ни в каком виде", async () => {
    const r = registry();
    await myc(r, "wire", "--agents", "claude");
    expect(allow().filter((rule) => /myc (run|statusline|wire|unwire)\b|Bash\(myc:\*\)/.test(rule))).toEqual([]);
    expect(existsSync(join(dir, ".claude/settings.json"))).toBe(true);
  });
});
