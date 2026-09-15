/**
 * `myc wire --scope user --agents opencode` / `myc unwire --scope user`
 * (memory-n1tt0dy8t4e9): пользовательский слой opencode.
 *
 * opencode, запущенный orca в git worktree командного репозитория, видит
 * только файлы команды: проектной проводки myc там нет. Этот слой — `mcp.myc` в
 * глобальном конфиге opencode и плагин `plugin/myc.ts` рядом с ним. Здесь
 * проверяется то же, что у слоя Claude Code, и ни одно свойство не про удобство:
 *   1. чужое в конфиге остаётся байт в байт — после wire файл равен исходному
 *      плюс ровно `mcp.myc`, после unwire — исходному, и в JSONC с
 *      комментариями и висячими запятыми тоже;
 *   2. конфиг — тот, что читает opencode: `$XDG_CONFIG_HOME/opencode`, без
 *      переменной — `~/.config/opencode`, файл — тот, что opencode считает своим;
 *   3. плагин вне воркспейса не запускает myc вовсе, из git worktree находит
 *      воркспейс основного дерева, а в проекте со своей проводкой молчит.
 *
 * НИКОГДА не настоящий HOME и не настоящий ~/.config/opencode: у каждого теста
 * свой временный HOME и свой XDG_CONFIG_HOME, myc и claude — заглушки.
 *
 * Мутации, на которых файл обязан краснеть (проверены на приёмке):
 *   «нет проверки воркспейса» — сторож плагина не смотрит `.myc/myc.db`;
 *   «нет защиты от дубля» — сторож не смотрит проводку opencode в проекте;
 *   «не тот путь конфига» — XDG_CONFIG_HOME не учитывается / не тот файл.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import { createAbsorbSessionCommand } from "../hooks/absorb-session.ts";
import { HOOK_EVENTS, opencodePlugin } from "../hooks/templates.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createDoctorCommand, type Check, type DoctorData } from "./doctor.ts";
import { createPrimeCommand } from "./prime.ts";
import { createUnwireCommand, createWireCommand, readUserJournal, wireHash, type WireDeps } from "./wire.ts";

const BUN = process.execPath;

let root: string;
let home: string;
let xdg: string;
let bin: string;
let claudeLog: string;
let mycLog: string;
let stubMyc: string;

beforeEach(() => {
  // Настоящий путь: $PWD у заглушки myc — без симлинков (/var → /private/var на macOS).
  root = realpathSync(mkdtempSync(join(tmpdir(), "myc-wire-opencode-")));
  home = join(root, "home");
  xdg = join(root, "xdg");
  bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  claudeLog = join(root, "claude.log");
  mycLog = join(root, "myc.log");
  // claude-заглушка: слою opencode её звать не за чем — любой вызов виден в журнале.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${claudeLog}"\nexit 0\n`);
  chmodSync(join(bin, "claude"), 0o755);
  // myc-заглушка: каталог, argv и stdin — в журнал; на prime и absorb-session — метки.
  stubMyc = join(bin, "myc-stub");
  writeFileSync(
    stubMyc,
    `#!/bin/sh\necho "$PWD $*" >> "${mycLog}"\ncase "$1" in\n  prime) echo "PRIME-FROM-STUB";;\n  absorb-session) echo "stdin: $(cat)" >> "${mycLog}"; echo "PACKET-FROM-STUB";;\nesac\nexit 0\n`,
  );
  chmodSync(stubMyc, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function wireEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    MYC_HOME: home,
    XDG_CONFIG_HOME: xdg,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    MYC_BIN: stubMyc,
    ...extra,
  };
}

function registry(env: Record<string, string> = wireEnv(), overrides: Partial<WireDeps> = {}): Registry {
  const r = new Registry();
  r.register(createPrimeCommand());
  r.register(createAbsorbSessionCommand());
  r.register(createAnchorCommand());
  r.register(
    createWireCommand(r, {
      probeMcp: () => ({ ok: true }),
      probeQueue: () => ({ ok: true, bin: { command: "myc", source: "path" } }),
      probeUserStatusLine: () => ({ ok: true }),
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

const readText = (p: string): string => readFileSync(p, "utf8");
const configPath = (name = "opencode.json"): string => join(xdg, "opencode", name);
const pluginPath = (): string => join(xdg, "opencode", "plugin", "myc.ts");
const journalPath = (): string => join(home, ".myc", "wire-user.json");
const mycCalls = (): string[] => (existsSync(mycLog) ? readText(mycLog).trim().split("\n").filter(Boolean) : []);
const ourServer = (): Record<string, unknown> => ({ type: "local", command: [stubMyc, "mcp", "--profile", "agent"], enabled: true });

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

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Глобальный конфиг как у заказчика: чужой MCP, провайдеры; каноническая запись без перевода строки в конце — так пишет opencode. */
const FOREIGN_OC = {
  $schema: "https://opencode.ai/config.json",
  mcp: {
    pencil: {
      command: ["/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64", "--app", "desktop", "--agent", "openCodeCLI"],
      enabled: true,
      type: "local",
    },
  },
  disabled_providers: ["omlx"],
  provider: {
    bankofai: {
      name: "Bank Of Ai",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://api.example/v1" },
      models: { "glm-5.3-flash": { name: "glm-5.3-flash" } },
    },
  },
};

describe("--scope user --agents opencode: глобальный конфиг", () => {
  test("чужое байт в байт, mcp.myc — ровно один узел; повтор — unchanged; unwire — исходный файл и исходное дерево", async () => {
    const original = JSON.stringify(FOREIGN_OC, null, 2);
    write(configPath(), original);
    const beforeXdg = tree(xdg);
    const beforeHome = tree(home);
    const r = registry();

    const first = await json(r, "wire", "--scope", "user", "--agents", "opencode");
    expect(first.code).toBe(0);
    expect(first.env.data.agents).toEqual(["opencode"]);
    expect(first.env.data.opencode.mcp.state).toBe("add");
    // Файл = исходный + ровно mcp.myc, в той же записи (и без перевода строки в конце).
    const expected = structuredClone(FOREIGN_OC) as Record<string, any>;
    expected.mcp.myc = ourServer();
    expect(readText(configPath())).toBe(JSON.stringify(expected, null, 2));
    expect(readText(`${configPath()}.myc.bak`)).toBe(original);
    // Плагин — со своим myc; Claude Code не тронут вовсе.
    expect(readText(pluginPath())).toContain(`const WIRED_BIN = ${JSON.stringify(stubMyc)};`);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(claudeLog)).toBe(false);
    const j = readUserJournal(journalPath());
    expect(j?.settings).toBeNull();
    expect(j?.mcp).toBeNull();
    expect(j?.opencode?.config).toBe(configPath());
    expect(j?.opencode?.mcp?.command).toEqual([stubMyc, "mcp", "--profile", "agent"]);

    // Повтор — ни одного изменения, файлы байт в байт.
    const wiredText = readText(configPath());
    const pluginText = readText(pluginPath());
    const second = await json(r, "wire", "--scope", "user", "--agents", "opencode");
    expect(second.env.data.changed).toBe(0);
    expect(second.env.data.opencode.mcp.state).toBe("unchanged");
    expect(readText(configPath())).toBe(wiredText);
    expect(readText(pluginPath())).toBe(pluginText);

    const off = await json(r, "unwire", "--scope", "user");
    expect(off.code).toBe(0);
    expect(off.env.data.kept).toEqual([]);
    expect(readText(configPath())).toBe(original);
    expect(tree(xdg)).toEqual(beforeXdg);
    expect(tree(home)).toEqual(beforeHome);
  });

  test("XDG_CONFIG_HOME задана — пишется туда; не задана — в ~/.config/opencode, как у opencode", async () => {
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    expect(existsSync(configPath())).toBe(true);
    expect(existsSync(pluginPath())).toBe(true);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);

    // Без переменной — и с пустой: opencode считает пустую незаданной (`XDG_CONFIG_HOME || ~/.config`).
    const env = wireEnv();
    delete env.XDG_CONFIG_HOME;
    for (const variant of [env, { ...env, XDG_CONFIG_HOME: "" }]) {
      rmSync(join(home, ".config"), { recursive: true, force: true });
      rmSync(join(home, ".myc"), { recursive: true, force: true });
      const plain = registry(variant);
      expect((await myc(plain, "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
      const cfg = join(home, ".config", "opencode", "opencode.json");
      expect((Bun.JSONC.parse(readText(cfg)) as Record<string, any>).mcp.myc).toEqual(ourServer());
      expect(existsSync(join(home, ".config", "opencode", "plugin", "myc.ts"))).toBe(true);
    }
    expect(existsSync(join(xdg, "opencode", "opencode.json"))).toBe(false);
  });

  test("конфига нет — opencode.json со $schema (иначе opencode сам перепишет файл); unwire снимает его и созданные каталоги", async () => {
    mkdirSync(xdg, { recursive: true });
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    expect(JSON.parse(readText(configPath()))).toEqual({ $schema: "https://opencode.ai/config.json", mcp: { myc: ourServer() } });
    expect(readUserJournal(journalPath())?.opencode?.created).toBe(true);
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
    expect(tree(xdg)).toEqual([]);
    expect(tree(home)).toEqual([]);
  });

  test("JSONC: комментарии, табы и висячие запятые на месте; unwire — исходные байты", async () => {
    const original = [
      "{",
      "\t// opencode config, edited by hand",
      '\t"$schema": "https://opencode.ai/config.json",',
      '\t"mcp": {',
      "\t\t/* pencil first */",
      '\t\t"pencil": { "type": "local", "command": ["pencil-mcp"], "enabled": true }, // inline',
      "\t},",
      '\t"theme": "dark", // trailing comma follows',
      "}",
      "",
    ].join("\n");
    write(configPath(), original);
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    const wired = readText(configPath());
    expect(Bun.JSONC.parse(wired)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { pencil: { type: "local", command: ["pencil-mcp"], enabled: true }, myc: ourServer() },
      theme: "dark",
    });
    // Каждая исходная строка на месте, наш узел — табами, как соседи.
    for (const line of original.split("\n")) expect(wired).toContain(line);
    expect(wired).toContain('\t\t"myc": {\n\t\t\t"type": "local",');
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
    expect(readText(configPath())).toBe(original);
  });

  test("mcp пуст или его нет — узел встаёт, unwire возвращает файл байт в байт (пустой mcp остаётся, созданный — уходит)", async () => {
    for (const original of ['{\n  "mcp": {},\n  // tail\n  "theme": "dark"\n}\n', '{\n  "theme": "dark"\n}\n', "{}"]) {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(join(home, ".myc"), { recursive: true, force: true });
      write(configPath(), original);
      const r = registry();
      expect({ original, code: (await myc(r, "wire", "--scope", "user", "--agents", "opencode")).code }).toEqual({ original, code: 0 });
      expect((Bun.JSONC.parse(readText(configPath())) as Record<string, any>).mcp.myc).toEqual(ourServer());
      expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
      expect({ original, after: readText(configPath()) }).toEqual({ original, after: original });
    }
  });

  test("файл opencode — первый существующий из opencode.jsonc, opencode.json; повтор — туда же, куда писал прошлый wire", async () => {
    write(configPath("opencode.json"), '{\n  "theme": "dark"\n}');
    write(configPath("opencode.jsonc"), '{\n  // mine\n  "model": "a/b"\n}');
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    expect(readText(configPath("opencode.json"))).toBe('{\n  "theme": "dark"\n}');
    expect((Bun.JSONC.parse(readText(configPath("opencode.jsonc"))) as Record<string, any>).mcp.myc).toEqual(ourServer());
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);

    // Прошлый wire писал в opencode.json; появившийся потом opencode.jsonc запись не уводит.
    rmSync(configPath("opencode.jsonc"));
    expect((await myc(r, "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    write(configPath("opencode.jsonc"), '{\n  "model": "a/b"\n}');
    const again = await json(r, "wire", "--scope", "user", "--agents", "opencode");
    expect(again.env.data.opencode.config).toBe(configPath("opencode.json"));
    expect(again.env.data.changed).toBe(0);
    expect(readText(configPath("opencode.jsonc"))).toBe('{\n  "model": "a/b"\n}');
  });

  test("--dry-run: план с узлом и плагином, ни одного файла", async () => {
    const original = JSON.stringify(FOREIGN_OC, null, 2);
    write(configPath(), original);
    const before = tree(root);
    const r = registry();
    const res = await myc(r, "wire", "--scope", "user", "--agents", "opencode", "--dry-run");
    expect(res.code).toBe(0);
    expect(String(res.stdout)).toContain("+1 node: mcp.myc");
    expect(String(res.stdout)).toContain("nothing written (--dry-run)");
    expect(readText(configPath())).toBe(original);
    expect(tree(root)).toEqual(before);
  });

  test("mcp.myc поставлен не wire — чужой: не трогается ни wire, ни unwire", async () => {
    const text = JSON.stringify({ mcp: { myc: { type: "local", command: ["/opt/other/myc", "mcp"] } } }, null, 2);
    write(configPath(), text);
    const r = registry();
    const res = await json(r, "wire", "--scope", "user", "--agents", "opencode");
    expect(res.code).toBe(0);
    expect(res.env.data.opencode.mcp.state).toBe("foreign");
    expect(readText(configPath())).toBe(text);
    expect(existsSync(pluginPath())).toBe(true);
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
    expect(readText(configPath())).toBe(text);
    expect(existsSync(pluginPath())).toBe(false);
  });

  test("битый JSONC или mcp не объект — отказ, не записано НИЧЕГО (и плагин тоже)", async () => {
    for (const bad of ['{ "mcp": { "pencil": } }', '{ "mcp": [] }', "[1, 2]"]) {
      write(configPath(), bad);
      const r = registry();
      const res = await myc(r, "wire", "--scope", "user", "--agents", "opencode");
      expect({ bad, code: res.code }).toEqual({ bad, code: 4 });
      expect(readText(configPath())).toBe(bad);
      expect(existsSync(pluginPath())).toBe(false);
      expect(existsSync(join(home, ".myc"))).toBe(false);
    }
  });

  test("проба myc отказала — mcp.myc не пишется, плагин стоит, в предупреждении готовый узел", async () => {
    const original = JSON.stringify(FOREIGN_OC, null, 2);
    write(configPath(), original);
    const r = registry(wireEnv(), { probeMcp: () => ({ ok: false, why: "an older build" }) });
    const res = await json(r, "wire", "--scope", "user", "--agents", "opencode");
    expect(res.code).toBe(0);
    expect(res.env.data.opencode.mcp.state).toBe("refused");
    expect(readText(configPath())).toBe(original);
    expect(existsSync(pluginPath())).toBe(true);
    const warn = (res.env.warn as { code: string; msg: string }[]).find((w) => w.code === "degraded.opencode_mcp_unwritten");
    expect(warn?.msg).toContain("an older build");
    expect(warn?.msg).toContain(JSON.stringify(ourServer()));
    expect(readUserJournal(journalPath())?.opencode?.mcp).toBeNull();
  });

  test("--agents claude,opencode — оба слоя; потом --agents opencode не забывает Claude Code; unwire снимает оба", async () => {
    const settings = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;
    write(join(home, ".claude", "settings.json"), settings);
    const original = JSON.stringify(FOREIGN_OC, null, 2);
    write(configPath(), original);
    const r = registry();
    const both = await json(r, "wire", "--scope", "user", "--agents", "claude,opencode");
    expect(both.code).toBe(0);
    expect(both.env.data.agents).toEqual(["claude", "opencode"]);
    expect(String((await myc(r, "wire", "--scope", "user", "--agents", "claude,opencode", "--dry-run")).stdout)).toContain(
      "user layer of Claude Code and opencode",
    );
    expect(existsSync(join(home, ".claude", "helpers", "myc-hooks.mjs"))).toBe(true);
    expect(readText(claudeLog)).toContain("mcp add --scope user myc");

    const only = await json(r, "wire", "--scope", "user", "--agents", "opencode");
    expect(only.env.data.changed).toBe(0);
    const j = readUserJournal(journalPath());
    expect(j?.settings?.path).toBe(join(home, ".claude", "settings.json"));
    expect(j?.events?.length).toBeGreaterThan(0);
    expect(j?.opencode?.mcp).not.toBeNull();

    const off = await json(r, "unwire", "--scope", "user");
    expect(off.env.data.kept).toEqual([]);
    expect(readText(join(home, ".claude", "settings.json"))).toBe(settings);
    expect(readText(configPath())).toBe(original);
    expect(existsSync(pluginPath())).toBe(false);
  });

  test("отказы остаются: codex и kimi в пользовательском слое не проводятся", async () => {
    const r = registry();
    const res = await myc(r, "wire", "--scope", "user", "--agents", "opencode,kimi");
    expect(res.code).toBe(2);
    expect(String(res.stderr)).toContain("Claude Code and opencode only");
    expect(tree(root).filter((p) => !p.startsWith("bin"))).toEqual(["home/"]);
  });
});

// ---------------------------------------------------------------------------
// Плагин — так, как его зовёт opencode: импорт модуля в Bun и вызов каждого
// экспорта с {client, directory, worktree}; cwd процесса — чужой.
// ---------------------------------------------------------------------------

const RUNNER = `
const [plugin, directory, worktree] = process.argv.slice(2);
const mod = await import(plugin);
if (Object.values(mod).some((v) => typeof v !== "function")) throw new Error("a non-function export: opencode refuses the plugin");
const client = { session: { messages: async () => [{ info: { role: "user", modelID: "m" }, parts: [{ type: "text", text: "hello" }] }] } };
const out = {};
for (const fn of Object.values(mod)) {
  const hooks = await fn({ client, directory, worktree: worktree || undefined, project: {}, $: undefined });
  out.keys = Object.keys(hooks);
  const sys = { system: [] };
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "s1" }, sys);
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "s1" }, { system: [] });
  out.system = sys.system;
  await hooks["tool.execute.after"]?.({ tool: "edit", args: { filePath: directory + "/a.ts" } });
  const ctx = { context: [] };
  await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, ctx);
  out.context = ctx.context;
}
console.log(JSON.stringify(out));
`;

interface PluginRun {
  readonly keys: string[];
  readonly system: string[];
  readonly context: string[];
}

function runPlugin(plugin: string, directory: string, worktree = ""): PluginRun {
  const runner = join(root, "runner.ts");
  if (!existsSync(runner)) writeFileSync(runner, RUNNER);
  const r = Bun.spawnSync([BUN, runner, plugin, directory, worktree], {
    cwd: root,
    env: { HOME: home, MYC_HOME: home, PATH: process.env.PATH ?? "", MYC_BIN: stubMyc },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  if (r.exitCode !== 0) throw new Error(`plugin run: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString()) as PluginRun;
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function workspace(dir: string): void {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  writeFileSync(join(dir, ".myc", "myc.db"), "");
}

const ALL_HOOKS = ["experimental.session.compacting", "event", "experimental.chat.system.transform", "tool.execute.after"];

describe("плагин пользовательского слоя opencode: как его зовёт opencode", () => {
  test("каталог без воркспейса: ни одного хука, myc не запускается", async () => {
    expect((await myc(registry(), "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    const plain = join(root, "tunnel", "deep");
    mkdirSync(plain, { recursive: true });
    expect(runPlugin(pluginPath(), plain, join(root, "tunnel"))).toEqual({ keys: [], system: [], context: [] });
    expect(mycCalls()).toEqual([]);
  });

  test("git worktree вне дерева воркспейса: хуки есть, myc зовётся в каталоге worktree, prime — один раз, в system", async () => {
    expect((await myc(registry(), "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    const ws = join(root, "cherry");
    const repo = join(ws, "messaging-server");
    const wt = join(root, "orca", "workspaces", "messaging-server", "feature");
    workspace(ws);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, "README.md"), "team repo\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    mkdirSync(dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", wt, "-b", "feature");
    expect(existsSync(join(wt, ".myc"))).toBe(false);
    const sub = join(wt, "src");
    mkdirSync(sub, { recursive: true });

    const out = runPlugin(pluginPath(), sub, wt);
    expect(out.keys).toEqual(ALL_HOOKS);
    expect(out.system).toEqual(["PRIME-FROM-STUB\n"]);
    expect(out.context).toEqual(["PACKET-FROM-STUB\n"]);
    const calls = mycCalls();
    // prime — ровно один раз на сессию, хоть хук и позван дважды; все вызовы — из каталога инстанса.
    expect(calls.filter((c) => c.includes(" prime "))).toEqual([`${sub} prime --budget 2000 --format agent --session s1`]);
    expect(calls).toContain(`${sub} anchor touch ${sub}/a.ts`);
    expect(calls.some((c) => c.startsWith(`${sub} absorb-session --reason compact --transcript - `))).toBe(true);
    expect(calls.find((c) => c.startsWith("stdin: "))).toContain('"text":"hello"');
  });

  test("проект со своей проводкой opencode — плагин молчит: настоящий `myc wire --agents opencode`, только mcp.myc, только плагин", async () => {
    expect((await myc(registry(), "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    const wired = join(root, "wired");
    workspace(wired);
    expect((await myc(registry(), "-C", wired, "wire", "--agents", "opencode")).code).toBe(0);
    expect(existsSync(join(wired, ".opencode", "plugin", "myc.ts"))).toBe(true);

    const mcpOnly = join(root, "mcp-only");
    workspace(mcpOnly);
    write(join(mcpOnly, "opencode.jsonc"), '{\n  // the team wires myc itself\n  "mcp": { "myc": { "type": "local", "command": ["myc", "mcp"] } },\n}\n');

    const pluginOnly = join(root, "plugin-only");
    workspace(pluginOnly);
    write(join(pluginOnly, ".opencode", "plugins", "myc.js"), "export const P = async () => ({});\n");

    for (const dir of [wired, mcpOnly, pluginOnly]) {
      const sub = join(dir, "pkg");
      mkdirSync(sub, { recursive: true });
      expect({ dir, ...runPlugin(pluginPath(), sub, dir) }).toEqual({ dir, keys: [], system: [], context: [] });
    }
    expect(mycCalls()).toEqual([]);

    // Контроль: соседний проект без своей проводки — пользовательский слой работает.
    const bare = join(root, "bare");
    workspace(bare);
    expect(runPlugin(pluginPath(), bare, bare).system).toEqual(["PRIME-FROM-STUB\n"]);
  });

  test("паритет с проектным плагином: те же вызовы myc с теми же аргументами и тем же stdin", async () => {
    expect((await myc(registry(), "wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    const proj = join(root, "proj");
    workspace(proj);
    const projectPlugin = join(root, "project-plugin", "myc.ts");
    write(projectPlugin, opencodePlugin({ events: HOOK_EVENTS, hookOutput: "json" }));

    const user = runPlugin(pluginPath(), proj, proj);
    const userCalls = mycCalls();
    rmSync(mycLog);
    const project = runPlugin(projectPlugin, proj, proj);
    const projectCalls = mycCalls();
    expect(user).toEqual(project);
    expect(userCalls).toEqual(projectCalls);
    expect(userCalls.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// myc doctor --hooks: слой opencode
// ---------------------------------------------------------------------------

describe("myc doctor --hooks: слой opencode", () => {
  let ws: string;
  let full: Registry;

  beforeEach(async () => {
    ws = join(root, "ws");
    mkdirSync(join(ws, ".myc"), { recursive: true });
    const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
    await migrate(raw, { migrations, writable: true });
    raw.close();
    const env = wireEnv({ PATH: `${bin}:/usr/bin:/bin` });
    full = new Registry();
    registerAll(full);
    full.register(
      createWireCommand(full, {
        probeMcp: () => ({ ok: true }),
        probeQueue: () => ({ ok: true, bin: { command: "myc", source: "path" } }),
        probeUserStatusLine: () => ({ ok: true }),
        env,
        platform: "darwin",
      }),
    );
    full.register(createUnwireCommand({ env }));
    full.register(createDoctorCommand(full, { env }));
  });

  const cli = (...args: string[]): Promise<RunResult> => run(args, { registry: full, env: { MYC_ACTOR: "tester", MYC_DRAIN: "0" } });

  /** doctor --hooks: при 0 — данные, при расхождении — конверт отказа, находки в warn[]. */
  async function doctor(): Promise<{ code: number; data?: DoctorData; warn: { code: string; msg: string }[] }> {
    const res = await cli("-C", ws, "doctor", "--hooks", "--json");
    const envl = JSON.parse(String(res.stdout)) as { data?: DoctorData; warn?: { code: string; msg: string }[] };
    return { code: res.code, ...(envl.data !== undefined ? { data: envl.data } : {}), warn: envl.warn ?? [] };
  }

  test("свежая проводка — ok по плагину и mcp.myc; слой Claude Code — n/a, код выхода 0", async () => {
    write(configPath(), JSON.stringify(FOREIGN_OC, null, 2));
    expect((await cli("wire", "--scope", "user", "--agents", "opencode")).code).toBe(0);
    const d = await doctor();
    expect(d.code).toBe(0);
    const oc = (d.data?.hooks?.user.opencode ?? []) as Check[];
    expect(oc.map((c) => [c.name.includes("plugin/myc.ts") ? "plugin" : c.name, c.verdict])).toEqual([
      ["plugin", "ok"],
      ["user:opencode:mcp", "ok"],
    ]);
    expect(d.data?.hooks?.user.checks.map((c) => c.verdict)).toEqual(["n/a"]);
  });

  test("mcp.myc сняли руками, плагин правили — два расхождения, каждое с командой, что делать", async () => {
    write(configPath(), JSON.stringify(FOREIGN_OC, null, 2));
    await cli("wire", "--scope", "user", "--agents", "opencode");
    write(configPath(), JSON.stringify(FOREIGN_OC, null, 2));
    writeFileSync(pluginPath(), `${readText(pluginPath())}// edited\n`);
    const d = await doctor();
    expect(d.code).not.toBe(0);
    const drift = d.warn.filter((w) => w.code === "doctor.drift").map((w) => w.msg);
    expect(drift.some((m) => m.startsWith("user:opencode:mcp: gone") && m.includes("myc wire --scope user --agents opencode"))).toBe(true);
    expect(drift.some((m) => m.includes("plugin/myc.ts: changed after we wrote it"))).toBe(true);
  });

  test("плагин записан прежней сборкой — «stale» с именем сборки; myc сервера пропал — «not there»", async () => {
    await cli("wire", "--scope", "user", "--agents", "opencode");
    const old = `${readText(pluginPath())}// written by an older myc\n`;
    writeFileSync(pluginPath(), old);
    const j = JSON.parse(readText(journalPath())) as Record<string, any>;
    j.files = (j.files as { path: string; hash: string }[]).map((f) => (f.path === pluginPath() ? { ...f, hash: wireHash(old) } : f));
    j.opencode.version = "0.3.9";
    writeFileSync(journalPath(), JSON.stringify(j, null, 2));
    rmSync(stubMyc);
    const drift = (await doctor()).warn.filter((w) => w.code === "doctor.drift").map((w) => w.msg);
    expect(drift.some((m) => m.includes("plugin/myc.ts: stale") && m.includes("myc 0.3.9"))).toBe(true);
    expect(drift.some((m) => m.startsWith("user:opencode:mcp:") && m.includes(`${stubMyc}, which is not there`))).toBe(true);
  });
});
