/**
 * Строка статуса пользовательского слоя (memory-6x0ag4p493pc):
 * `myc wire --scope user --status-line`, `myc statusline --scope user`,
 * `myc unwire --scope user`.
 *
 * Отрисовка — на НАСТОЯЩИХ процессах и так, как её исполняет Claude Code
 * 2.1.267: `sh -c <command>`, stdin — JSON и перевод строки, в окружении
 * CLAUDE_PROJECT_DIR; из слоёв берётся старший (local > project > user).
 *
 * Прежняя строка — подделка orca: команда ДОСЛОВНО из настроек заказчика
 * (statusline.orca-fixture.json) ищет `${HOME}/.orca/agent-hooks/claude-statusline.sh`,
 * а во временном HOME там лежит скрипт, который пишет полученный stdin в файл,
 * спит и отмечает завершение. В её команде `claude-statusline` — как у orca.
 *
 * НИКОГДА не настоящий HOME: у каждого теста свой; `claude` — заглушка.
 *
 * Мутации, на которых файл обязан краснеть (проверены на приёмке):
 *   «вшить прежнюю в нашу» — wire пишет `--then '<команда orca>'` в команду
 *       нашей строки: падает «классификатор orca» (для нашей записи — managed);
 *   «без передачи» — строка не берёт прежнюю из журнала: падает «наша строка
 *       печатает свой текст, прежняя получает тот же stdin»;
 *   «вне воркспейса — полная строка» — падает «три места: вне воркспейса».
 */

import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { cliTestEnv } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import { isOurStatusLineCommand } from "../statusline-config.ts";
import type { StatuslineData } from "./statusline.ts";
import { createUnwireCommand, createWireCommand, readUserJournal } from "./wire.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const BUN = process.execPath;
const ORCA = (JSON.parse(readFileSync(join(import.meta.dir, "statusline.orca-fixture.json"), "utf8")) as {
  statusLine: { type: string; command: string };
}).statusLine;

const FAKE_ORCA = `#!/bin/sh
out="\${FAKE_OUT:?}"
cat > "$out.stdin.tmp" && mv "$out.stdin.tmp" "$out.stdin"
sleep "\${FAKE_SLEEP:-2}"
echo done > "$out.done"
if [ -n "$FAKE_PRINT" ]; then printf '%s\\n' "$FAKE_PRINT"; fi
exit 0
`;

/** Заглушка claude: ведёт mcpServers в $HOME/.claude.json, как claude 2.1.268; исполняет её bun, node в PATH не нужен. */
const CLAUDE_STUB = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, ".claude.json");
let d = {};
try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const name = args[4];
if (args[0] === "mcp" && args[1] === "add") {
  d.mcpServers = d.mcpServers || {};
  if (d.mcpServers[name]) process.exit(1);
  const dash = args.indexOf("--");
  d.mcpServers[name] = { type: "stdio", command: args[dash + 1], args: args.slice(dash + 2), env: {} };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
} else if (args[0] === "mcp" && args[1] === "remove") {
  if (!d.mcpServers || !d.mcpServers[name]) process.exit(1);
  delete d.mcpServers[name];
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
}
`;

let root: string;
let home: string;
let ws: string;
let bin: string;
let shim: string;
let cache: string;
let models: string;
let tag = 0;

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

async function makeWorkspace(dir: string): Promise<void> {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-wu-sl-"));
  home = join(root, "home");
  ws = join(root, "ws");
  bin = join(root, "bin");
  cache = join(root, "cache");
  models = join(root, "models");
  await makeWorkspace(ws);
  write(join(home, ".orca", "agent-hooks", "claude-statusline.sh"), FAKE_ORCA, 0o755);
  write(join(models, "multilingual-e5-small-q8", "manifest.json"), "{}");
  // `myc` для записанных команд — тот же CLI из исходников; имя обязано быть
  // `myc`: по нему строка узнаётся своей.
  shim = join(bin, "myc");
  write(shim, `#!/bin/sh\nexec "${BUN}" "${MAIN}" "$@"\n`, 0o755);
  write(join(bin, "claude"), CLAUDE_STUB, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Окружение и команды
// ---------------------------------------------------------------------------

/** Окружение wire: временный HOME, заглушки впереди PATH, настоящий claude недосягаем. */
function wireEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, MYC_HOME: home, PATH: `${bin}:/usr/bin:/bin`, MYC_BIN: shim, ...extra };
}

function registry(env: Record<string, string> = wireEnv()): Registry {
  const r = new Registry();
  registerAll(r);
  r.register(
    createWireCommand(r, {
      probeMcp: () => ({ ok: true }),
      probeQueue: () => ({ ok: true, bin: { command: "myc", source: "path" } }),
      env,
      platform: "darwin",
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

/**
 * `myc` отдельным процессом — для проектного wire: он выбирает бинарь по
 * окружению процесса (resolveMycBin), и в процессе тестов это было бы
 * окружение разработчика, а не временный HOME.
 */
async function cli(dir: string, ...args: string[]): Promise<{ code: number | null; data: Record<string, any> | null }> {
  const proc = Bun.spawn([BUN, MAIN, "-C", dir, ...args, "--json"], {
    cwd: dir,
    env: cliTestEnv({ ...wireEnv(), MYC_ACTOR: "tester" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  let data: Record<string, any> | null = null;
  try {
    data = (JSON.parse(out) as { data: Record<string, any> }).data;
  } catch {
    data = null;
  }
  return { code: proc.exitCode, data };
}

/** Окружение сессии, в которой Claude Code исполняет строку. */
function sessionEnv(extra: Record<string, string> = {}): Record<string, string> {
  return cliTestEnv({
    HOME: home,
    MYC_HOME: home,
    MYC_ACTOR: "tester",
    MYC_MODELS_DIR: models,
    MYC_STATUSLINE_CACHE: cache,
    MYC_SESSION_ID: "",
    ...extra,
  });
}

const settingsPath = (): string => join(home, ".claude", "settings.json");
const readText = (p: string): string => readFileSync(p, "utf8");
const journalPath = (): string => join(home, ".myc", "wire-user.json");

/** Пользовательские настройки как у заказчика: orca-строка и orca-хуки. */
const CUSTOMER_USER = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: 'if [ -z "${HOME-}" ]; then exit 0; fi; orca-hook session' }] }],
    Stop: [{ hooks: [{ type: "command", command: "orca-hook stop" }] }],
  },
  statusLine: ORCA,
  enabledPlugins: { "superpowers@market": true },
};

function writeUser(value: Record<string, unknown>): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  write(settingsPath(), text);
  return text;
}

function userStatusLine(): Record<string, unknown> | undefined {
  return (JSON.parse(readText(settingsPath())) as Record<string, any>).statusLine;
}

function payload(dir: string, extra: Record<string, unknown> = {}): string {
  const n = tag++;
  return `${JSON.stringify({
    session_id: `s-${n}`,
    transcript_path: join(root, `session-${n}.jsonl`),
    cwd: dir,
    model: { id: "claude-opus-5", display_name: "Opus 5" },
    workspace: { current_dir: dir, project_dir: dir, added_dirs: [] },
    version: "2.1.267",
    cost: { total_cost_usd: 0.42, total_duration_ms: 61234 },
    context_window: { total_input_tokens: 1234, context_window_size: 1000000, used_percentage: 3 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1789999999 } },
    ...extra,
  })}\n`;
}

/** Команда строки, которую Claude Code выберет в этом проекте: local > project > user. */
function effectiveCommand(project: string): string {
  for (const file of [join(project, ".claude", "settings.local.json"), join(project, ".claude", "settings.json"), settingsPath()]) {
    if (!existsSync(file)) continue;
    const sl = (JSON.parse(readText(file)) as Record<string, any>).statusLine;
    if (sl?.type === "command" && typeof sl.command === "string") return sl.command as string;
  }
  throw new Error(`no statusLine for ${project}`);
}

interface HostRender {
  readonly out: string;
  readonly code: number | null;
  readonly ms: number;
}

/** Ровно как Claude Code 2.1.267 исполняет statusLine: `sh -c`, JSON на stdin, своя группа. */
async function hostRender(project: string, input: string, extra: Record<string, string> = {}, suffix = ""): Promise<HostRender> {
  const t0 = performance.now();
  const proc = Bun.spawn(["/bin/sh", "-c", `${effectiveCommand(project)}${suffix}`], {
    cwd: project,
    env: sessionEnv({ CLAUDE_PROJECT_DIR: project, ...extra }),
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { out, code: proc.exitCode, ms: performance.now() - t0 };
}

/** Та же отрисовка с `--json`: что строка решила и сколько это стоило ей самой. */
async function hostData(project: string, input: string, extra: Record<string, string> = {}): Promise<StatuslineData> {
  const r = await hostRender(project, input, extra, " --json");
  expect(r.code).toBe(0);
  return (JSON.parse(r.out) as { data: StatuslineData }).data;
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (existsSync(path)) return true;
    await Bun.sleep(25);
  }
  return existsSync(path);
}

function fakeOut(): string {
  return join(root, `fake-${tag++}`);
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

// ---------------------------------------------------------------------------
// Классификатор orca — перенос, а не пересказ
// ---------------------------------------------------------------------------
//
// Orca.app (2026-09-09), out/main/chunks/managed-agent-hook-controls-*.js:
// `$t` — классификация statusLine, `tn` — установка своей строки (зовётся из
// `installManagedStatusLine`), `nn` — снятие (из `remove`). Матчер `C` — из
// managed-home-shell-preflight-*.js (экспорт `dt`). Имя скрипта — `E(T)`:
// `scriptBaseName` `claude-hook` → `claude-statusline` + `.sh`.

const ORCA_SCRIPT = "claude-statusline.sh";

function orcaMatcher(e: string): (cmd: string) => boolean {
  const t = e.replace(/\.(?:cmd|ps1|sh)$/, "");
  const n = [`agent-hooks/${e}`, `agent-hooks/${t}.cmd`, `agent-hooks/${t}.ps1`, `agent-hooks/${t}.sh`];
  return (cmd) => {
    if (!cmd) return false;
    const m = cmd.match(/\s-EncodedCommand\s+(\S+)/i);
    let decoded: string | null = null;
    if (m) {
      try {
        decoded = Buffer.from(m[1]!, "base64").toString("utf16le");
      } catch {
        decoded = null;
      }
    }
    const r = (decoded ? `${cmd}\n${decoded}` : cmd).replaceAll("\\", "/");
    return n.some((x) => r.includes(x));
  };
}

function orcaCommandOf(config: Record<string, unknown>): string | null {
  const i = config["statusLine"] as Record<string, unknown> | undefined;
  return i !== null && typeof i === "object" && !Array.isArray(i) && typeof i["command"] === "string" ? (i["command"] as string) : null;
}

/** `$t`. */
function orcaClassify(config: Record<string, unknown>): "managed" | "user" | "empty" {
  const a = orcaCommandOf(config);
  return a ? (orcaMatcher(ORCA_SCRIPT)(a) ? "managed" : "user") : "empty";
}

/** `tn`: при `user` конфиг возвращается как есть. */
function orcaInstall(config: Record<string, unknown>, command: string): Record<string, unknown> {
  return orcaClassify(config) === "user" ? config : { ...config, statusLine: { type: "command", command } };
}

/** `nn`: снимает только свою. */
function orcaRemove(config: Record<string, unknown>): { config: Record<string, unknown>; changed: boolean } {
  const a = orcaCommandOf(config);
  if (!a || !orcaMatcher(ORCA_SCRIPT)(a)) return { config, changed: false };
  const o = { ...config };
  delete o["statusLine"];
  return { config: o, changed: true };
}

const ORCA_CHUNKS = "/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/main/chunks";

describe("классификатор orca", () => {
  /**
   * Правило, ради которого прежняя строка живёт в журнале, а не в нашей
   * команде: будь в команде `claude-statusline`, orca сочла бы нашу строку
   * своей (`managed`) и при снятии удалила бы её. Мутация «вшить прежнюю
   * через --then» роняет этот тест.
   */
  test("нашей записи orca даёт user: её установка строку не трогает, снятие — тоже", async () => {
    writeUser(CUSTOMER_USER);
    expect(orcaClassify(CUSTOMER_USER)).toBe("managed"); // контроль: подделка — как у orca

    const r = registry();
    const res = await json(r, "wire", "--scope", "user", "--status-line");
    expect(res.code).toBe(0);
    const config = JSON.parse(readText(settingsPath())) as Record<string, unknown>;
    expect(orcaClassify(config)).toBe("user");
    expect(orcaInstall(config, ORCA.command)).toBe(config);
    expect(orcaRemove(config).changed).toBe(false);
    expect(orcaClassify({})).toBe("empty");

    const command = orcaCommandOf(config)!;
    expect(command).toBe(`${shim} statusline --scope user`);
    expect(command).not.toContain("claude-statusline");
    expect(isOurStatusLineCommand(command)).toBe(true);
  });

  /**
   * Перенос сверяется с тем кодом orca, что стоит на машине: сменит orca
   * правило — тест здесь покраснеет раньше, чем сломается строка у заказчика.
   * Нет Orca.app (CI) — пропуск: переносу тогда верить на слово приёмки.
   */
  test.skipIf(!existsSync(ORCA_CHUNKS))("перенос совпадает с установленным кодом orca", () => {
    const files = readdirSync(ORCA_CHUNKS);
    const ctl = files.find((f) => /^managed-agent-hook-controls-.*\.js$/.test(f));
    const pre = files.find((f) => /^managed-home-shell-preflight-.*\.js$/.test(f));
    expect(ctl).toBeDefined();
    expect(pre).toBeDefined();
    const c = readText(join(ORCA_CHUNKS, ctl!));
    const p = readText(join(ORCA_CHUNKS, pre!));
    expect(c).toMatch(/return (\w+)\?(\w+)\(\1\)\?`managed`:`user`:`empty`/);
    expect(c).toMatch(/===`user`\?(\w+):\{\.\.\.\1,statusLine:\{type:`command`,command:\w+\}\}/);
    expect(c).toMatch(/if\(!(\w+)\|\|!(\w+)\(\1\)\)return\{config:(\w+),changed:!1\};let (\w+)=\{\.\.\.\3\};return delete \4\.statusLine/);
    expect(c).toMatch(/scriptBaseName:`claude-hook`/);
    expect(c).toMatch(/replace\(\/-hook\$\/,`-statusline`\)/);
    expect(p).toMatch(/\[`agent-hooks\/\$\{(\w+)\}`,`agent-hooks\/\$\{(\w+)\}\.cmd`,`agent-hooks\/\$\{\2\}\.ps1`,`agent-hooks\/\$\{\2\}\.sh`\]/);
    expect(p).toMatch(/replaceAll\(`\\\\`,`\/`\);return \w+\.some\(\w+=>\w+\.includes\(\w+\)\)/);
  });
});

// ---------------------------------------------------------------------------
// wire / unwire
// ---------------------------------------------------------------------------

describe("wire --scope user --status-line / unwire", () => {
  test("наша строка, orca — прежняя в журнале; повтор — unchanged; unwire — исходный файл байт в байт", async () => {
    const original = writeUser(CUSTOMER_USER);
    const r = registry();
    const first = await json(r, "wire", "--scope", "user", "--status-line");
    expect(first.code).toBe(0);
    expect(userStatusLine()).toEqual({ type: "command", command: `${shim} statusline --scope user` });
    // Прежняя — в журнале дословно, а не в нашей команде.
    expect(readUserJournal(journalPath())?.status_line).toEqual({ previous: ORCA });
    expect((first.env.data.notes as string[]).join("\n")).toContain("gets the same stdin on every redraw");
    // Чужие узлы файла на месте: хуки orca первыми, плагины как были.
    const wired = JSON.parse(readText(settingsPath())) as Record<string, any>;
    expect(wired.hooks.Stop).toEqual(CUSTOMER_USER.hooks.Stop);
    expect(wired.hooks.SessionStart[0]).toEqual(CUSTOMER_USER.hooks.SessionStart[0]);
    expect(wired.enabledPlugins).toEqual(CUSTOMER_USER.enabledPlugins);

    const wiredText = readText(settingsPath());
    const again = await json(r, "wire", "--scope", "user", "--status-line");
    expect(again.code).toBe(0);
    expect(again.env.data.changed).toBe(0);
    expect(readText(settingsPath())).toBe(wiredText);
    expect(readUserJournal(journalPath())?.status_line).toEqual({ previous: ORCA });

    // Обычный wire (обновить helper'ы) строку не снимает и запись не теряет.
    expect((await myc(r, "wire", "--scope", "user")).code).toBe(0);
    expect(readText(settingsPath())).toBe(wiredText);
    expect(readUserJournal(journalPath())?.status_line).toEqual({ previous: ORCA });

    const off = await json(r, "unwire", "--scope", "user");
    expect(off.code).toBe(0);
    expect(off.env.data.kept).toEqual([]);
    expect((off.env.data.removed as string[]).join("\n")).toContain("statusLine (previous restored)");
    expect(readText(settingsPath())).toBe(original);
  });

  test("прежней строки не было: ставится наша, передавать некому; unwire снимает ключ", async () => {
    const plain = { ...CUSTOMER_USER } as Record<string, unknown>;
    delete plain["statusLine"];
    const original = writeUser(plain);
    const r = registry();
    const res = await json(r, "wire", "--scope", "user", "--status-line");
    expect(res.code).toBe(0);
    expect(readUserJournal(journalPath())?.status_line).toEqual({ previous: null });
    expect((res.env.data.notes as string[]).join("\n")).toContain("there was no previous line");
    const d = await hostData(ws, payload(ws));
    expect(d.foreign).toMatchObject({ source: null, started: false, skipped: "none" });
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
    expect(readText(settingsPath())).toBe(original);
  });

  /**
   * Страж от перезаписи. После wire строку заменили (orca поставила свою
   * заново, человек — свою). Повторный wire с флагом ставит нашу обратно, и
   * НОВАЯ чужая становится прежней — она не теряется и получает ввод; unwire
   * возвращает именно её. Обычный wire заменённую не трогает и забывает нашу.
   */
  test("строку заменили после wire: обычный wire её не трогает; wire --status-line — наша обратно, новая чужая — прежняя", async () => {
    writeUser(CUSTOMER_USER);
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--status-line")).code).toBe(0);
    const replacement = { type: "command", command: `/bin/sh "\${HOME}/.orca/agent-hooks/claude-statusline.sh" --v2` };
    const s = JSON.parse(readText(settingsPath())) as Record<string, unknown>;
    s["statusLine"] = replacement;
    const replacedText = `${JSON.stringify(s, null, 2)}\n`;
    writeFileSync(settingsPath(), replacedText);

    const plainRun = await json(r, "wire", "--scope", "user");
    expect(plainRun.code).toBe(0);
    expect(readText(settingsPath())).toBe(replacedText);
    expect((plainRun.env.data.notes as string[]).join("\n")).toContain("replaced after wire by");
    expect((plainRun.env.data.notes as string[]).join("\n")).toContain("(orca's line)");
    expect(readUserJournal(journalPath())?.status_line).toBeUndefined();

    const fix = await json(r, "wire", "--scope", "user", "--status-line");
    expect(fix.code).toBe(0);
    expect(userStatusLine()?.["command"]).toBe(`${shim} statusline --scope user`);
    expect(readUserJournal(journalPath())?.status_line).toEqual({ previous: replacement });

    // Новая чужая получает ввод от нашей строки.
    const out = fakeOut();
    const input = payload(ws);
    await hostRender(ws, input, { FAKE_OUT: out, FAKE_SLEEP: "0" });
    expect(await waitFor(`${out}.stdin`, 6000)).toBe(true);
    expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));

    // unwire возвращает новую, а не ту, что была до первого wire.
    expect((await myc(r, "unwire", "--scope", "user")).code).toBe(0);
    expect(userStatusLine()).toEqual(replacement);
  });

  test("то же без обычного wire между: wire --status-line сразу делает новую чужую прежней", async () => {
    writeUser(CUSTOMER_USER);
    const r = registry();
    expect((await myc(r, "wire", "--scope", "user", "--status-line")).code).toBe(0);
    const replacement = { type: "command", command: "/usr/local/bin/my-own-line" };
    const s = JSON.parse(readText(settingsPath())) as Record<string, unknown>;
    s["statusLine"] = replacement;
    writeFileSync(settingsPath(), `${JSON.stringify(s, null, 2)}\n`);
    const fix = await json(r, "wire", "--scope", "user", "--status-line");
    expect(fix.code).toBe(0);
    expect((fix.env.data.notes as string[]).join("\n")).toContain("becomes the previous one");
    expect(readUserJournal(journalPath())?.status_line).toEqual({ previous: replacement });
  });

  test("myc без `statusline --scope user` — отказ до записи, ничего не записано", async () => {
    const original = writeUser(CUSTOMER_USER);
    // Старая сборка: неизвестный флаг — выход 2, как у настоящей 0.3.5.
    const old = join(root, "old", "myc");
    write(old, `#!/bin/sh\necho "unknown flag --scope" >&2\nexit 2\n`, 0o755);
    const r = registry(wireEnv({ MYC_BIN: old }));
    const res = await myc(r, "wire", "--scope", "user", "--status-line");
    expect(res.code).toBe(5);
    expect(String(res.stderr)).toContain("statusline --scope user --no-pass: exit 2");
    expect(readText(settingsPath())).toBe(original);
    expect(existsSync(join(home, ".claude", "helpers"))).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
  });

  test("бинарь с `claude-statusline` в пути или не по имени myc — отказ: такую строку не отличить", async () => {
    const original = writeUser(CUSTOMER_USER);
    const inOrcaDir = join(root, "claude-statusline", "myc");
    write(inOrcaDir, `#!/bin/sh\nexec "${BUN}" "${MAIN}" "$@"\n`, 0o755);
    const a = await myc(registry(wireEnv({ MYC_BIN: inOrcaDir })), "wire", "--scope", "user", "--status-line");
    expect(a.code).toBe(4);
    expect(String(a.stderr)).toContain("orca would take it for its own line");
    expect(readText(settingsPath())).toBe(original);

    const renamed = join(root, "other", "myc-build");
    write(renamed, `#!/bin/sh\nexec "${BUN}" "${MAIN}" "$@"\n`, 0o755);
    const b = await myc(registry(wireEnv({ MYC_BIN: renamed })), "wire", "--scope", "user", "--status-line");
    expect(b.code).toBe(4);
    expect(String(b.stderr)).toContain("is not named myc");
    expect(readText(settingsPath())).toBe(original);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Отрисовка: как Claude Code исполняет строку
// ---------------------------------------------------------------------------

describe("отрисовка строки пользовательского слоя", () => {
  /**
   * Главная проверка. Наша строка печатает свой текст, orca получает те же
   * байты stdin, а её двух секунд сна никто не ждёт. Мутация «без передачи»
   * роняет сравнение stdin.
   */
  test("наша строка печатает свой текст, прежняя получает тот же stdin и не держит нашу", async () => {
    writeUser(CUSTOMER_USER);
    expect((await myc(registry(), "wire", "--scope", "user", "--status-line")).code).toBe(0);

    const out = fakeOut();
    const input = payload(ws);
    const r = await hostRender(ws, input, { FAKE_OUT: out, FAKE_SLEEP: "2" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^myc │ ctx 3% │ \d+ ready · \d+ blocked │ /);
    // Двухсекундный сон прежней не ждали — ни на каком железе.
    expect(r.ms).toBeLessThan(1500);
    expect(existsSync(`${out}.done`)).toBe(false);
    expect(await waitFor(`${out}.done`, 8000)).toBe(true);
    expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));

    // Что решила строка и сколько стоила она сама — тем же путём, с --json.
    // Пять отрисовок одной сессии, как у хоста (кеш сессии тёплый со второй),
    // и медиана: один замер на машине, где рядом гоняют тесты другие агенты,
    // мерил бы соседа (у заказчика load1 ≈ 10 на 14 ядрах — обычное дело).
    const sess = { session_id: "budget", transcript_path: join(root, "budget.jsonl") };
    const runs: StatuslineData[] = [];
    for (let i = 0; i < 5; i++) runs.push(await hostData(ws, payload(ws, sess), { FAKE_OUT: fakeOut(), FAKE_SLEEP: "2" }));
    for (const d of runs) {
      expect(d.scope).toBe("user");
      expect(d.foreign).toMatchObject({ source: "user-previous", started: true, finished: false });
      expect(d.foreign.waited_ms).toBeLessThan(500);
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const absolute = process.env["MYC_BENCH_ABSOLUTE"] !== "0" || process.env["MYC_BENCH_STRICT"] === "1";
    if (absolute) {
      expect(median(runs.map((d) => d.foreign.waited_ms))).toBeLessThan(25);
      expect(median(runs.map((d) => d.took_ms))).toBeLessThan(70);
    }
  }, 60_000);

  describe("три места", () => {
    /**
     * Вне воркспейса строка пользовательского слоя не печатает ничего своего
     * — только то, что печатала прежняя (orca — ничего), — но ввод отдаёт.
     * Мутация «вне воркспейса — полная строка» роняет этот тест.
     */
    test("вне воркспейса: пусто, код 0, orca всё равно получила ввод", async () => {
      writeUser(CUSTOMER_USER);
      expect((await myc(registry(), "wire", "--scope", "user", "--status-line")).code).toBe(0);
      const plain = join(root, "plain-project");
      mkdirSync(plain, { recursive: true });
      const out = fakeOut();
      const input = payload(plain);
      const r = await hostRender(plain, input, { FAKE_OUT: out, FAKE_SLEEP: "0.2" });
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(await waitFor(`${out}.stdin`, 6000)).toBe(true);
      expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));

      const d = await hostData(plain, payload(plain), { FAKE_OUT: fakeOut(), FAKE_SLEEP: "0" });
      expect(d).toMatchObject({ scope: "user", silent: "no-workspace", line: "", workspace: null, session: null });
      expect(d.foreign.started).toBe(true);
      // Печатающая прежняя — вне воркспейса видна только она.
      const sess = { session_id: "print-1", transcript_path: join(root, "print-1.jsonl") };
      const first = fakeOut();
      await hostRender(plain, payload(plain, sess), { FAKE_OUT: first, FAKE_SLEEP: "0", FAKE_PRINT: "orca 12%" });
      expect(await waitFor(`${first}.done`, 6000)).toBe(true);
      await Bun.sleep(200);
      const shown = await hostRender(plain, payload(plain, sess), { FAKE_OUT: fakeOut(), FAKE_SLEEP: "0", FAKE_PRINT: "orca 12%" });
      expect(shown.out).toBe("orca 12%\n");
    }, 30_000);

    test("git worktree воркспейса вне его дерева (как у orca): полная строка, orca получила ввод", async () => {
      writeUser(CUSTOMER_USER);
      const repo = join(ws, "messaging-server");
      mkdirSync(repo, { recursive: true });
      git(repo, "init", "-q");
      writeFileSync(join(repo, "README.md"), "team repo\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "init");
      const wt = join(root, "orca", "workspaces", "messaging-server", "feature");
      mkdirSync(dirname(wt), { recursive: true });
      git(repo, "worktree", "add", "-q", wt, "-b", "feature");
      expect(existsSync(join(wt, ".myc"))).toBe(false);
      expect((await myc(registry(), "wire", "--scope", "user", "--status-line")).code).toBe(0);

      const out = fakeOut();
      const input = payload(wt);
      const r = await hostRender(wt, input, { FAKE_OUT: out, FAKE_SLEEP: "0.2" });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^myc │ ctx 3% │ \d+ ready · \d+ blocked │ /);
      expect(await waitFor(`${out}.stdin`, 6000)).toBe(true);
      expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));
      const d = await hostData(wt, payload(wt), { FAKE_OUT: fakeOut(), FAKE_SLEEP: "0" });
      expect(d.workspace).toBe(realpathSync(ws));
      expect(d.silent).toBeUndefined();
    }, 30_000);

    /**
     * Проект со своей строкой myc (как cherry): Claude Code берёт проектную,
     * наша пользовательская не исполняется вовсе. Но проектная раньше отдавала
     * ввод пользовательской — orca; теперь пользовательская наша, и orca
     * получает ввод от проектной через журнал пользовательского слоя.
     */
    test("проект со своей строкой myc: печатает проектная, orca получает ввод через журнал", async () => {
      writeUser(CUSTOMER_USER);
      const project = join(root, "cherry");
      await makeWorkspace(project);
      const r = registry();
      // Проектная строка поставлена ДО пользовательской — как у заказчика.
      expect((await cli(project, "wire", "--agents", "claude", "--status-line")).code).toBe(0);
      expect(effectiveCommand(project)).not.toContain("--scope user");
      expect((await myc(r, "wire", "--scope", "user", "--status-line")).code).toBe(0);
      expect(effectiveCommand(project)).not.toContain("--scope user");

      const out = fakeOut();
      const input = payload(project);
      const shown = await hostRender(project, input, { FAKE_OUT: out, FAKE_SLEEP: "0.2" });
      expect(shown.code).toBe(0);
      expect(shown.out).toMatch(/^myc │ ctx 3% │ \d+ ready · \d+ blocked │ /);
      expect(await waitFor(`${out}.stdin`, 6000)).toBe(true);
      expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));
      const d = await hostData(project, payload(project), { FAKE_OUT: fakeOut(), FAKE_SLEEP: "0" });
      expect(d.scope).toBe("project");
      expect(d.foreign.source).toBe("user-previous");

      // И проектный wire ПОСЛЕ пользовательского говорит, кому уйдёт ввод.
      const other = join(root, "ooo-flow");
      await makeWorkspace(other);
      const late = await cli(other, "wire", "--agents", "claude", "--status-line");
      expect(late.code).toBe(0);
      expect((late.data?.["notes"] as string[]).join("\n")).toContain("the user line is myc's too");
    }, 30_000);
  });
});
