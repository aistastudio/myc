/**
 * `myc wire --scope user` / `myc unwire --scope user` (memory-bh5pbp4nyjwk).
 *
 * Пользовательский слой Claude Code — один на все проекты и все инструменты
 * человека, поэтому проверяются три свойства, и ни одно не про удобство:
 *   1. чужое в `~/.claude/settings.json` остаётся байт в байт — после wire
 *      файл равен исходному плюс ровно наши узлы, после unwire — исходному;
 *   2. helper этого слоя в проекте без myc не запускает myc вовсе, а в проекте
 *      со своей проводкой молчит (prime попадает в контекст один раз);
 *   3. из git worktree, лежащего вне дерева воркспейса, helper находит
 *      воркспейс основного дерева и отдаёт prime.
 *
 * НИКОГДА не настоящий HOME: каждый тест получает свой временный HOME, а
 * `claude` — заглушка в PATH, которая пишет свои аргументы в журнал и ведёт
 * `mcpServers` в `$HOME/.claude.json` так, как это делает claude 2.1.268
 * (проверено запуском на изолированном HOME: add → `{type:"stdio", command,
 * args, env:{}}`, повторный add — exit 1, remove отсутствующего — exit 1).
 *
 * Мутации, на которых файл обязан краснеть (проверены на приёмке):
 *   «нет проверки воркспейса» — сторож helper'а не смотрит `.myc/myc.db`:
 *       падает «каталог без воркспейса: myc не запускается»;
 *   «нет защиты от дубля» — сторож не смотрит проводку проекта: падает
 *       «проект со своей проводкой: prime ровно один раз»;
 *   «нет перехода в основное дерево» — сторож не читает `.git`-файл worktree:
 *       падает «git worktree вне дерева воркспейса».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import { createAbsorbSessionCommand } from "../hooks/absorb-session.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createPrimeCommand } from "./prime.ts";
import {
  createUnwireCommand,
  createWireCommand,
  mycPermissions,
  probeUserMcpBin,
  readUserJournal,
  type WireDeps,
} from "./wire.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");

let root: string;
let home: string;
let bin: string;
let claudeLog: string;
let mycLog: string;
let stubMyc: string;

/** Заглушка claude: пишет argv и ведёт mcpServers, как claude 2.1.268. */
const CLAUDE_STUB = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLAUDE_STUB_LOG, JSON.stringify(args) + "\\n");
const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, ".claude.json");
let d = {};
try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const name = args[4];
if (args[0] === "mcp" && args[1] === "add") {
  d.mcpServers = d.mcpServers || {};
  if (d.mcpServers[name]) { console.error("MCP server " + name + " already exists in user config"); process.exit(1); }
  const dash = args.indexOf("--");
  d.mcpServers[name] = { type: "stdio", command: args[dash + 1], args: args.slice(dash + 2), env: {} };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log("Added stdio MCP server " + name + " to user config");
} else if (args[0] === "mcp" && args[1] === "remove") {
  if (!d.mcpServers || !d.mcpServers[name]) { console.error('No MCP server named "' + name + '" in user scope'); process.exit(1); }
  delete d.mcpServers[name];
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log("Removed MCP server " + name + " from user config");
}
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myc-wire-user-"));
  home = join(root, "home");
  bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  claudeLog = join(root, "claude.log");
  mycLog = join(root, "myc.log");
  writeFileSync(join(bin, "claude"), CLAUDE_STUB);
  chmodSync(join(bin, "claude"), 0o755);
  // myc-заглушка: факт вызова (каталог и argv) — в журнал, на prime — метка.
  stubMyc = join(bin, "myc-stub");
  writeFileSync(stubMyc, `#!/bin/sh\necho "$PWD $*" >> "${mycLog}"\ncase "$1" in prime) echo "PRIME-FROM-STUB";; esac\nexit 0\n`);
  chmodSync(stubMyc, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Окружение wire: временный HOME, заглушки впереди PATH. */
function wireEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    MYC_HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    MYC_BIN: stubMyc,
    CLAUDE_STUB_LOG: claudeLog,
    ...extra,
  };
}

function registry(env: Record<string, string> = wireEnv(), overrides: Partial<WireDeps> = {}, full = false): Registry {
  const r = new Registry();
  if (full) registerAll(r);
  else {
    r.register(createPrimeCommand());
    r.register(createAbsorbSessionCommand());
    r.register(createAnchorCommand());
  }
  r.register(
    createWireCommand(r, {
      probeMcp: () => ({ ok: true }),
      probeQueue: () => ({ ok: true, bin: { command: "myc", source: "path" } }),
      env,
      platform: "darwin",
      ...overrides,
    }),
  );
  r.register(createUnwireCommand({ env }));
  return r;
}

function myc(r: Registry, ...args: string[]): Promise<RunResult> {
  return run(args, { registry: r, env: { MYC_ACTOR: "tester", MYC_DRAIN: "0" } });
}

async function json(r: Registry, ...args: string[]): Promise<{ code: number; env: Record<string, any> }> {
  const res = await myc(r, ...args, "--json");
  return { code: res.code, env: JSON.parse(res.stdout as string) as Record<string, any> };
}

const settingsPath = (): string => join(home, ".claude", "settings.json");
const helperPath = (): string => join(home, ".claude", "helpers", "myc-hooks.mjs");
const readText = (p: string): string => readFileSync(p, "utf8");
const claudeCalls = (): string[][] =>
  existsSync(claudeLog) ? readText(claudeLog).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
const mycCalls = (): string[] => (existsSync(mycLog) ? readText(mycLog).trim().split("\n").filter(Boolean) : []);

/** Все файлы дерева — относительными путями, по алфавиту. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        out.push(`${relative(dir, p)}/`);
        walk(p);
      } else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Пользовательские настройки как у человека с orca, herdr и agent-flow. */
const FOREIGN_USER = {
  permissions: { allow: ["Bash(git status:*)", "Bash(myc prime:*)"], deny: ["Bash(rm -rf:*)"] },
  model: "opus",
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "/opt/homebrew/bin/node /Users/u/.agent-flow/hook.js session", timeout: 5 }] },
      { matcher: "startup", hooks: [{ type: "command", command: "bash '/Users/u/.herdr/session-start.sh'" }] },
    ],
    PreToolUse: [{ hooks: [{ type: "command", command: 'if [ -z "${HOME-}" ]; then exit 0; fi; orca-hook pre' }] }],
    PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "orca-hook post" }] }],
    Stop: [{ hooks: [{ type: "command", command: "orca-hook stop" }] }],
  },
  statusLine: { type: "command", command: '/bin/sh "${HOME}/.orca/agent-hooks/claude-statusline.sh"', padding: 0 },
  enabledPlugins: { "superpowers@market": true },
};

function writeForeign(): string {
  const text = `${JSON.stringify(FOREIGN_USER, null, 2)}\n`;
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), text);
  return text;
}

const isOurs = (entry: unknown): boolean => JSON.stringify(entry).includes(join(home, ".claude", "helpers"));

describe("--scope user: ~/.claude/settings.json", () => {
  test("чужое байт в байт, наши узлы добавлены, statusLine не тронут; повтор — unchanged; unwire — исходный файл", async () => {
    const original = writeForeign();
    const before = tree(home);
    const r = registry();

    const first = await json(r, "wire", "--scope", "user");
    expect(first.code).toBe(0);
    const wired = JSON.parse(readText(settingsPath())) as Record<string, any>;

    // Наши записи — ровно в конце массивов своих событий; PreCompact — новый ключ.
    expect(isOurs(wired.hooks.SessionStart.at(-1))).toBe(true);
    expect(isOurs(wired.hooks.PostToolUse.at(-1))).toBe(true);
    expect(wired.hooks.PreCompact.length).toBe(1);
    expect(isOurs(wired.hooks.PreCompact[0])).toBe(true);
    // Таймауты — секунды, те же, что у проектной проводки.
    expect(wired.hooks.SessionStart.at(-1).hooks[0].timeout).toBe(3);
    expect(wired.hooks.PreCompact[0].hooks[0].timeout).toBe(8);
    expect(wired.hooks.PreCompact[0].matcher).toBe("manual|auto");
    expect(wired.hooks.PostToolUse.at(-1).hooks[0].timeout).toBe(2);
    // Команда — абсолютный путь helper'а.
    expect(wired.hooks.SessionStart.at(-1).hooks[0].command).toContain(helperPath());

    // Файл = исходный + ровно наши узлы, в той же канонической записи: значит,
    // ни один чужой байт не сдвинулся и не переписался.
    const expected = structuredClone(FOREIGN_USER) as Record<string, any>;
    expected.hooks.SessionStart.push(wired.hooks.SessionStart.at(-1));
    expected.hooks.PostToolUse.push(wired.hooks.PostToolUse.at(-1));
    expected.hooks.PreCompact = wired.hooks.PreCompact;
    expected.permissions.allow.push("Bash(myc absorb-session:*)", "Bash(myc anchor:*)");
    expect(readText(settingsPath())).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(wired.statusLine).toEqual(FOREIGN_USER.statusLine);
    // Правило, стоявшее до нас, не продублировано.
    expect((wired.permissions.allow as string[]).filter((a) => a === "Bash(myc prime:*)")).toHaveLength(1);

    // Скилл — тот же текст, что у проекта; MCP — через claude mcp add.
    expect(existsSync(join(home, ".claude", "skills", "myc", "SKILL.md"))).toBe(true);
    expect(claudeCalls()).toEqual([["mcp", "add", "--scope", "user", "myc", "--", stubMyc, "mcp", "--profile", "agent"]]);
    const claudeJson = JSON.parse(readText(join(home, ".claude.json"))) as Record<string, any>;
    expect(claudeJson.mcpServers.myc).toEqual({ type: "stdio", command: stubMyc, args: ["mcp", "--profile", "agent"], env: {} });
    expect(existsSync(`${settingsPath()}.myc.bak`)).toBe(true);
    expect(readText(`${settingsPath()}.myc.bak`)).toBe(original);

    // Повтор — ничего не меняется и claude не зовётся.
    const wiredText = readText(settingsPath());
    const helperText = readText(helperPath());
    const second = await json(r, "wire", "--scope", "user");
    expect(second.code).toBe(0);
    expect(second.env.data.changed).toBe(0);
    expect(second.env.data.mcp.state).toBe("unchanged");
    expect(readText(settingsPath())).toBe(wiredText);
    expect(readText(helperPath())).toBe(helperText);
    expect(claudeCalls()).toHaveLength(1);

    // unwire — исходный файл байт в байт, созданное снято, MCP снят.
    const off = await json(r, "unwire", "--scope", "user");
    expect(off.code).toBe(0);
    expect(off.env.data.kept).toEqual([]);
    expect(readText(settingsPath())).toBe(original);
    expect(claudeCalls().at(-1)).toEqual(["mcp", "remove", "--scope", "user", "myc"]);
    // Дерево HOME — как до wire; .claude.json — файл самого claude, в нём пусто.
    expect(tree(home).filter((p) => p !== ".claude.json")).toEqual(before);
    expect((JSON.parse(readText(join(home, ".claude.json"))) as Record<string, any>).mcpServers).toEqual({});
  });

  test("HOME без ~/.claude: всё, что создал wire, unwire снимает целиком", async () => {
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user")).code).toBe(0);
    expect(existsSync(settingsPath())).toBe(true);
    expect(readUserJournal(join(home, ".myc", "wire-user.json"))?.settings?.created).toBe(true);
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
    // Остаётся только файл claude; ни ~/.claude, ни ~/.myc wire не оставил.
    expect(tree(home)).toEqual([".claude.json"]);
  });

  test("раскладка не каноническая — отказ, не записано НИЧЕГО", async () => {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    const odd = '{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "orca-hook"}]}]}}\n';
    writeFileSync(settingsPath(), odd);
    const r = registry();
    const res = await myc(r, "wire", "--scope", "user");
    expect(res.code).not.toBe(0);
    expect(String(res.stderr)).toContain("not laid out the way JSON.stringify writes it");
    expect(readText(settingsPath())).toBe(odd);
    expect(existsSync(helperPath())).toBe(false);
    expect(existsSync(join(home, ".myc"))).toBe(false);
    expect(claudeCalls()).toEqual([]);
  });

  test("--dry-run: план с командой claude, ни одного файла и ни одного вызова claude", async () => {
    const original = writeForeign();
    const r = registry();
    const res = await myc(r, "wire", "--scope", "user", "--dry-run");
    expect(res.code).toBe(0);
    expect(String(res.stdout)).toContain(`claude mcp add --scope user myc -- ${stubMyc} mcp --profile agent`);
    expect(String(res.stdout)).toContain("nothing written (--dry-run)");
    expect(readText(settingsPath())).toBe(original);
    expect(tree(home)).toEqual([".claude/", ".claude/settings.json"]);
    expect(claudeCalls()).toEqual([]);
  });

  // --status-line больше не отказ (memory-6x0ag4p493pc): его проверки — в
  // wire-user.statusline.test.ts.
  test("отказы: --hook-mode replace, --agents codex, --agents-md — и ничего не записано", async () => {
    const original = writeForeign();
    const r = registry();
    const cases: [string[], string][] = [
      [["--hook-mode", "replace"], "evict other tools' hooks"],
      [["--agents", "claude,codex"], "Claude Code only"],
      [["--agents-md"], "AGENTS.md is a project file"],
    ];
    for (const [flags, why] of cases) {
      const res = await myc(r, "wire", "--scope", "user", ...flags);
      expect({ flags, code: res.code }).toEqual({ flags, code: 2 });
      expect(String(res.stderr)).toContain(why);
    }
    expect(readText(settingsPath())).toBe(original);
    expect(existsSync(helperPath())).toBe(false);
    expect(claudeCalls()).toEqual([]);
  });

  test("--hook-mode skip: событие с чужим хуком остаётся без нашего, остальные ставятся", async () => {
    writeForeign();
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--hook-mode", "skip")).code).toBe(0);
    const s = JSON.parse(readText(settingsPath())) as Record<string, any>;
    expect(s.hooks.SessionStart).toEqual(FOREIGN_USER.hooks.SessionStart);
    expect(s.hooks.PostToolUse).toEqual(FOREIGN_USER.hooks.PostToolUse);
    expect(isOurs(s.hooks.PreCompact[0])).toBe(true);
  });

  test("чужой инструмент дописал свой хук ПОСЛЕ нашего — повторный wire наш не переставляет", async () => {
    writeForeign();
    const r = registry();
    await myc(r, "wire", "--scope", "user");
    const s = JSON.parse(readText(settingsPath())) as Record<string, any>;
    s.hooks.SessionStart.push({ hooks: [{ type: "command", command: "orca-hook late" }] });
    const edited = `${JSON.stringify(s, null, 2)}\n`;
    writeFileSync(settingsPath(), edited);
    const again = await json(r, "wire", "--scope", "user");
    expect(again.env.data.changed).toBe(0);
    expect(readText(settingsPath())).toBe(edited);
  });

  test("после wire файл правили другие (orca): unwire снимает только наше, новое чужое остаётся", async () => {
    writeForeign();
    const r = registry();
    await myc(r, "wire", "--scope", "user");
    const s = JSON.parse(readText(settingsPath())) as Record<string, any>;
    s.hooks.PreCompact.unshift({ hooks: [{ type: "command", command: "orca-hook compact" }] });
    s.theme = "dark";
    writeFileSync(settingsPath(), `${JSON.stringify(s, null, 2)}\n`);
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
    const expected = structuredClone(FOREIGN_USER) as Record<string, any>;
    expected.hooks.PreCompact = [{ hooks: [{ type: "command", command: "orca-hook compact" }] }];
    expected.theme = "dark";
    expect(readText(settingsPath())).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  test("правила — те же, что у проекта: подкоманды по одной, без run/statusline/wire/unwire и без Bash(myc:*)", async () => {
    const r = registry(wireEnv(), {}, true);
    expect((await myc(r, "wire", "--scope", "user")).code).toBe(0);
    const allow = (JSON.parse(readText(settingsPath())) as Record<string, any>).permissions.allow as string[];
    expect(allow).toEqual(mycPermissions(r));
    // 44 — с `review` (разбор кандидатов, memory-79mq6fccg0jm): новая команда
    // получает правило сама, если её нет в ASK_SUBCOMMANDS (wire.ts).
    expect(allow).toHaveLength(44);
    for (const banned of ["Bash(myc:*)", "Bash(myc run:*)", "Bash(myc statusline:*)", "Bash(myc wire:*)", "Bash(myc unwire:*)"]) {
      expect(allow).not.toContain(banned);
    }
  });

  test("MYC_BIN — абсолютный путь в MCP и в helper'е", async () => {
    const r = registry();
    const res = await json(r, "wire", "--scope", "user");
    expect(res.env.data.mcp.command).toContain(stubMyc);
    expect(readText(helperPath())).toContain(`const WIRED_BIN = ${JSON.stringify(stubMyc)};`);
  });
});

describe("--scope user: MCP", () => {
  test("claude нет в PATH — хуки стоят, MCP не зарегистрирован, готовая команда в предупреждении", async () => {
    const env = wireEnv({ PATH: "/usr/bin:/bin" });
    const r = registry(env);
    const res = await json(r, "wire", "--scope", "user");
    expect(res.code).toBe(0);
    const warn = (res.env.warn as { code: string; msg: string }[]).find((w) => w.code === "degraded.mcp_unregistered");
    expect(warn?.msg).toContain("claude is not on PATH");
    expect(warn?.msg).toContain(`claude mcp add --scope user myc -- ${stubMyc} mcp --profile agent`);
    expect(existsSync(helperPath())).toBe(true);
    expect(readUserJournal(join(home, ".myc", "wire-user.json"))?.mcp).toBeNull();
    // unwire без MCP в журнале claude не ищет вовсе и снимает всё остальное.
    const off = await json(r, "unwire", "--scope", "user");
    expect(off.env.data.kept).toEqual([]);
    expect(tree(home)).toEqual([]);
  });

  test("сервер myc, поставленный не wire, — чужой: не трогается ни wire, ни unwire", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { myc: { type: "stdio", command: "/opt/other/myc", args: ["mcp"], env: {} } } }, null, 2),
    );
    const r = registry();
    const res = await json(r, "wire", "--scope", "user");
    expect(res.env.data.mcp.state).toBe("foreign");
    expect(claudeCalls()).toEqual([]);
    await myc(r, "unwire", "--scope", "user");
    expect(claudeCalls()).toEqual([]);
    const after = JSON.parse(readText(join(home, ".claude.json"))) as Record<string, any>;
    expect(after.mcpServers.myc.command).toBe("/opt/other/myc");
  });

  test("проба: старая сборка (инструменты вне воркспейса) — отказ; сборка из исходников — годится", async () => {
    // Старая сборка: на tools/list отвечает непустым списком и отдаёт instructions.
    const old = join(bin, "myc-old");
    writeFileSync(
      old,
      `#!/usr/bin/env node
const lines = require("fs").readFileSync(0, "utf8").split("\\n").filter(Boolean);
for (const l of lines) {
  const m = JSON.parse(l);
  const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, instructions: "myc — this project's memory" } : { tools: [{ name: "myc_prime" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
}
`,
    );
    chmodSync(old, 0o755);
    const env = wireEnv();
    const verdict = probeUserMcpBin({ command: old, source: "env" }, env);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.why).toContain("still serves 1 tools and its instructions");

    const shim = join(bin, "myc-src");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${MAIN}" "$@"\n`);
    chmodSync(shim, 0o755);
    expect(probeUserMcpBin({ command: shim, source: "env" }, env)).toEqual({ ok: true });

    // Отказ пробы доезжает до wire: MCP не регистрируется, хуки стоят.
    const r = registry(wireEnv({ MYC_BIN: old }), { probeMcp: probeUserMcpBin });
    const res = await json(r, "wire", "--scope", "user");
    expect(res.env.data.mcp.state).toBe("refused");
    expect(claudeCalls()).toEqual([]);
    expect(existsSync(helperPath())).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Helper пользовательского слоя — так, как его запускает Claude Code
// ---------------------------------------------------------------------------

interface HookRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Команда записи хука через shell, с payload на stdin и CLAUDE_PROJECT_DIR — как у хоста. */
function runHook(command: string, projectDir: string, payload: Record<string, unknown>, env: Record<string, string>): HookRun {
  const r = Bun.spawnSync(["/bin/sh", "-c", command], {
    cwd: projectDir,
    env: { ...env, CLAUDE_PROJECT_DIR: projectDir },
    stdin: Buffer.from(`${JSON.stringify(payload)}\n`),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** Команды всех записей события из файла настроек (матчеры SessionStart у нас пустые). */
function commandsOf(settingsFile: string, event: string): string[] {
  const s = JSON.parse(readText(settingsFile)) as Record<string, any>;
  return ((s.hooks?.[event] ?? []) as any[]).flatMap((e) => (e.hooks as any[]).map((h) => h.command as string));
}

/** Окружение сессии: тот же HOME, node в PATH, myc — заглушка. */
function sessionEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, MYC_HOME: home, PATH: process.env.PATH ?? "", ...extra };
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

describe("helper пользовательского слоя: как его запускает Claude Code", () => {
  test("каталог без воркспейса: myc не запускается, вывод пуст, выход 0 — на каждом событии", async () => {
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user")).code).toBe(0);
    const plain = join(root, "tunnel");
    mkdirSync(plain, { recursive: true });
    const events: [string, Record<string, unknown>][] = [
      ["SessionStart", { hook_event_name: "SessionStart", session_id: "s1", source: "startup" }],
      ["PreCompact", { hook_event_name: "PreCompact", session_id: "s1", trigger: "auto", transcript_path: "/nope.jsonl" }],
      ["PostToolUse", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(plain, "a.ts") } }],
    ];
    for (const [event, payload] of events) {
      const ours = commandsOf(settingsPath(), event).filter((c) => c.includes(helperPath()));
      expect(ours).toHaveLength(1);
      const out = runHook(ours[0]!, plain, payload, sessionEnv({ MYC_BIN: stubMyc }));
      expect({ event, ...out }).toEqual({ event, code: 0, stdout: "", stderr: "" });
    }
    expect(mycCalls()).toEqual([]);
  });

  test("тот же helper в каталоге с воркспейсом зовёт myc (контроль к предыдущему)", async () => {
    const r = registry();
    await myc(r, "wire", "--scope", "user");
    const proj = join(root, "proj");
    mkdirSync(join(proj, ".myc"), { recursive: true });
    writeFileSync(join(proj, ".myc", "myc.db"), "");
    const cmd = commandsOf(settingsPath(), "SessionStart").find((c) => c.includes(helperPath()))!;
    const out = runHook(cmd, proj, { hook_event_name: "SessionStart", session_id: "s1" }, sessionEnv({ MYC_BIN: stubMyc }));
    expect(out.stdout).toBe("PRIME-FROM-STUB\n");
    expect(mycCalls()).toHaveLength(1);
  });

  test("git worktree вне дерева воркспейса: helper находит воркспейс основного дерева, prime в выводе", async () => {
    // Настоящий myc из исходников: воркспейс, репозиторий внутри, worktree снаружи.
    const shim = join(bin, "myc-src");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${MAIN}" "$@"\n`);
    chmodSync(shim, 0o755);
    const cliEnv = { ...sessionEnv(), MYC_ACTOR: "tester", MYC_DRAIN: "0", NO_COLOR: "1" };
    const ws = join(root, "cherry");
    const repo = join(ws, "messaging-server");
    const wt = join(root, "orca", "workspaces", "messaging-server", "feature");
    mkdirSync(repo, { recursive: true });
    const cli = (...args: string[]): string => {
      const p = Bun.spawnSync([shim, ...args], { env: cliEnv, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`myc ${args.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString();
    };
    cli("-C", ws, "init");
    git(repo, "init", "-q");
    writeFileSync(join(repo, "README.md"), "team repo\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    cli("-C", repo, "create", "Задача из основного дерева", "-p", "P1");
    mkdirSync(dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", wt, "-b", "feature");
    expect(existsSync(join(wt, ".myc"))).toBe(false);
    expect(readText(join(wt, ".git"))).toStartWith("gitdir:");

    const r = registry(wireEnv({ MYC_BIN: shim }));
    expect((await myc(r, "wire", "--scope", "user")).code).toBe(0);
    const cmd = commandsOf(settingsPath(), "SessionStart").find((c) => c.includes(helperPath()))!;
    const out = runHook(cmd, wt, { hook_event_name: "SessionStart", session_id: "s-wt" }, sessionEnv());
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("ws=cherry");
    expect(out.stdout).toContain("Задача из основного дерева");
  }, 60_000);

  test("проект со своей проводкой + пользовательская: SessionStart даёт prime ровно один раз", async () => {
    const proj = join(root, "proj");
    mkdirSync(join(proj, ".myc"), { recursive: true });
    writeFileSync(join(proj, ".myc", "myc.db"), "");
    // Проводка проекта — настоящим `myc wire`, как у ~/src/cherry.
    const r = registry();
    expect((await myc(r, "-C", proj, "wire", "--agents", "claude")).code).toBe(0);
    expect((await myc(r, "wire", "--scope", "user")).code).toBe(0);
    const payload = { hook_event_name: "SessionStart", session_id: "s1", source: "startup" };
    // Claude Code запускает записи обоих слоёв (одинаковые команды схлопывает,
    // наши разные) — запускаем их все.
    const commands = [...commandsOf(settingsPath(), "SessionStart"), ...commandsOf(join(proj, ".claude", "settings.json"), "SessionStart")];
    expect(commands).toHaveLength(2);
    const outputs = commands.map((c) => runHook(c, proj, payload, sessionEnv({ MYC_BIN: stubMyc })));
    for (const o of outputs) expect(o.code).toBe(0);
    expect(outputs.map((o) => o.stdout).join("").match(/PRIME-FROM-STUB/g) ?? []).toHaveLength(1);
    expect(mycCalls()).toHaveLength(1);

    // Контроль: у соседнего проекта своей проводки нет — prime даёт пользовательский слой.
    const bare = join(root, "bare");
    mkdirSync(join(bare, ".myc"), { recursive: true });
    writeFileSync(join(bare, ".myc", "myc.db"), "");
    const alone = commandsOf(settingsPath(), "SessionStart").map((c) => runHook(c, bare, payload, sessionEnv({ MYC_BIN: stubMyc })));
    expect(alone.map((o) => o.stdout).join("")).toBe("PRIME-FROM-STUB\n");
  });

  test("helper удалён руками: хук выходит 0 молча, а не ошибкой в каждой сессии", async () => {
    const r = registry();
    await myc(r, "wire", "--scope", "user");
    rmSync(helperPath());
    const cmd = commandsOf(settingsPath(), "SessionStart").find((c) => c.includes(helperPath()))!;
    const out = runHook(cmd, root, { hook_event_name: "SessionStart" }, sessionEnv());
    expect(out).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("хук очереди: вне воркспейса молчит, в воркспейсе переписывает, при своём хуке проекта молчит", async () => {
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--queue-hook")).code).toBe(0);
    const queueHelper = join(home, ".claude", "helpers", "myc-queue.mjs");
    const cmd = commandsOf(settingsPath(), "PreToolUse").find((c) => c.includes(queueHelper));
    expect(cmd).toBeDefined();
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bun test", description: "all tests" } };

    const plain = join(root, "docs");
    mkdirSync(plain, { recursive: true });
    expect(runHook(cmd!, plain, payload, sessionEnv())).toEqual({ code: 0, stdout: "", stderr: "" });

    const proj = join(root, "proj");
    mkdirSync(join(proj, ".myc"), { recursive: true });
    writeFileSync(join(proj, ".myc", "myc.db"), "");
    // Хук очереди записан со словом `myc` (PATH): на машине разработчика оно
    // находилось в ~/.bun/bin, на раннере CI — нет, и хук честно говорил «myc
    // is not found». Здесь `myc` — заглушка, первая в PATH сессии.
    symlinkSync(stubMyc, join(bin, "myc"));
    const withMyc = sessionEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` });
    const rewritten = runHook(cmd!, proj, payload, withMyc);
    expect(rewritten.code).toBe(0);
    expect(rewritten.stdout).toContain("myc run -- bun test");

    // Свой хук очереди у проекта — пользовательский молчит.
    expect((await myc(r, "-C", proj, "wire", "--agents", "claude", "--queue-hook")).code).toBe(0);
    expect(runHook(cmd!, proj, payload, withMyc).stdout).toBe("");
  });
});
