/**
 * `myc doctor --hooks`: пользовательский слой Claude Code (memory-qnyz6bawx19v).
 *
 * `myc wire --scope user` ставит в `~/.claude` то, что правят ещё orca, Claude
 * Code и человек. Здесь проверяется, что doctor видит четыре поломки и на
 * каждую говорит, что делать: наши записи хуков сняли руками; helper записан
 * прежней сборкой (или правлен); строку статуса заменили; MCP-сервер пропал.
 * И обратная сторона — свежая установка даёт «ok» по каждому пункту, а
 * непроведённый слой не портит код выхода.
 *
 * НИКОГДА не настоящий HOME: у каждого теста свой, `claude` — заглушка.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import { createDoctorCommand, type Check, type DoctorData } from "./doctor.ts";
import { createUnwireCommand, createWireCommand, readUserJournal, wireHash } from "./wire.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const BUN = process.execPath;

const CLAUDE_STUB = `#!${BUN}
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

const ORCA_LINE = { type: "command", command: '/bin/sh "${HOME}/.orca/agent-hooks/claude-statusline.sh"' };

let root: string;
let home: string;
let ws: string;
let bin: string;
let shim: string;
let registry: Registry;

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

function env(): Record<string, string> {
  return { HOME: home, MYC_HOME: home, PATH: `${bin}:/usr/bin:/bin`, MYC_BIN: shim };
}

function makeRegistry(): Registry {
  const r = new Registry();
  registerAll(r);
  r.register(
    createWireCommand(r, {
      probeMcp: () => ({ ok: true }),
      probeQueue: () => ({ ok: true, bin: { command: "myc", source: "path" } }),
      // Строку ставит проверенный myc: проба запуском — в wire-user.statusline.test.ts.
      probeUserStatusLine: () => ({ ok: true }),
      env: env(),
      platform: "darwin",
    }),
  );
  r.register(createUnwireCommand({ env: env() }));
  r.register(createDoctorCommand(r, { env: env() }));
  return r;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-doctor-user-"));
  home = join(root, "home");
  ws = join(root, "ws");
  bin = join(root, "bin");
  mkdirSync(join(ws, ".myc"), { recursive: true });
  const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  shim = join(bin, "myc");
  write(shim, `#!/bin/sh\nexec "${BUN}" "${MAIN}" "$@"\n`, 0o755);
  write(join(bin, "claude"), CLAUDE_STUB, 0o755);
  write(join(home, ".claude", "settings.json"), `${JSON.stringify({ statusLine: ORCA_LINE, model: "opus" }, null, 2)}\n`);
  registry = makeRegistry();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", ws, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_DRAIN: "0" } });
}

interface Envelope {
  readonly ok: boolean;
  readonly data?: DoctorData;
  readonly error?: { code: string; msg: string };
}

async function doctor(): Promise<{ code: number; env: Envelope }> {
  const res = await myc("doctor", "--hooks", "--json");
  return { code: res.code, env: JSON.parse(String(res.stdout)) as Envelope };
}

/** Пункт пользовательского слоя — из конверта успеха или из текста отказа (рендер один). */
function userLine(e: Envelope, name: string): string {
  const c = e.data?.hooks?.user.checks.find((x: Check) => x.name === name);
  if (c !== undefined) return `${c.verdict}|${c.detail}`;
  return (e.error?.msg ?? "").split("\n").find((l) => l.includes(`${name}:`)) ?? "";
}

const settingsPath = (): string => join(home, ".claude", "settings.json");
const helperPath = (): string => join(home, ".claude", "helpers", "myc-hooks.mjs");
const journalPath = (): string => join(home, ".myc", "wire-user.json");
const readJson = (p: string): Record<string, any> => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
const writeJson = (p: string, v: unknown): void => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

async function wireUser(...flags: string[]): Promise<void> {
  const res = await myc("wire", "--scope", "user", ...flags);
  expect(res.code).toBe(0);
}

describe("myc doctor --hooks: пользовательский слой", () => {
  test("свежая установка: каждый пункт — ok, и сказано, что именно видно", async () => {
    await wireUser("--status-line");
    const { code, env: e } = await doctor();
    expect(code).toBe(ExitCode.OK);
    const checks = e.data!.hooks!.user.checks;
    expect(checks.map((c) => c.name)).toEqual([
      "user:hooks",
      "user:permissions",
      "user:~/.claude/helpers/myc-hooks.mjs",
      "user:~/.claude/skills/myc/SKILL.md",
      "user:statusLine",
      "user:mcp",
    ]);
    for (const c of checks) expect({ name: c.name, verdict: c.verdict }).toEqual({ name: c.name, verdict: "ok" });
    expect(userLine(e, "user:hooks")).toContain("SessionStart, PreCompact, PostToolUse");
    expect(userLine(e, "user:statusLine")).toContain("(orca's line) gets the same input");
    expect(e.data!.hooks!.user.journal).toBe(journalPath());
  });

  test("слой не проведён — одна строка «н/д», код выхода не страдает", async () => {
    const { code, env: e } = await doctor();
    expect(code).toBe(ExitCode.OK);
    expect(e.data!.hooks!.user.checks).toEqual([
      expect.objectContaining({ name: "user layer", verdict: "n/a" }),
    ]);
    expect(e.data!.hooks!.user.journal).toBeNull();
  });

  /** Наши записи сняли руками: doctor называет события и советует wire. */
  test("записи хуков сняты руками — расхождение с именами событий; wire их возвращает", async () => {
    await wireUser();
    const s = readJson(settingsPath());
    delete s["hooks"]["SessionStart"];
    delete s["hooks"]["PreCompact"];
    writeJson(settingsPath(), s);
    const broken = await doctor();
    expect(broken.code).toBe(ExitCode.PRECOND);
    const line = userLine(broken.env, "user:hooks");
    expect(line).toContain("hooks.SessionStart, hooks.PreCompact");
    expect(line).toContain("`myc wire --scope user` puts them back");

    await wireUser();
    expect(userLine((await doctor()).env, "user:hooks")).toStartWith("ok|");
  });

  /**
   * «Версия helper'а = версии бинаря»: файл ровно тот, что записал wire
   * прежней сборки (0.3.4), а эта пишет другой. Сверка по содержимому, а не по
   * номеру: номер совпал бы у двух сборок из разных коммитов.
   */
  test("helper записан прежней сборкой — «устарел», названа сборка и совет перезапустить wire", async () => {
    await wireUser();
    const old = readFileSync(helperPath(), "utf8").replace('"--session"', "");
    writeFileSync(helperPath(), old);
    const j = readJson(journalPath());
    j["version"] = "0.3.4";
    j["files"] = (j["files"] as { path: string; hash: string }[]).map((f) => (f.path === helperPath() ? { ...f, hash: wireHash(old) } : f));
    writeJson(journalPath(), j);

    const stale = await doctor();
    expect(stale.code).toBe(ExitCode.PRECOND);
    const line = userLine(stale.env, "user:~/.claude/helpers/myc-hooks.mjs");
    expect(line).toContain("stale");
    expect(line).toContain("myc 0.3.4");
    expect(line).toContain("rerun `myc wire --scope user`");

    // Правленный руками — не «устарел», а «изменён», и сказано про .myc.bak.
    writeFileSync(helperPath(), "// чужая правка\n");
    const edited = userLine((await doctor()).env, "user:~/.claude/helpers/myc-hooks.mjs");
    expect(edited).toContain("changed after we wrote it");
    expect(edited).not.toContain("stale");

    await wireUser();
    expect(userLine((await doctor()).env, "user:~/.claude/helpers/myc-hooks.mjs")).toStartWith("ok|");
  });

  /** Страж от перезаписи строки: doctor видит замену и говорит оба выхода. */
  test("строку статуса заменили после wire — расхождение; wire --status-line чинит, новая чужая становится прежней", async () => {
    await wireUser("--status-line");
    const s = readJson(settingsPath());
    const replacement = { type: "command", command: '/bin/sh "${HOME}/.orca/agent-hooks/claude-statusline.sh" --v2' };
    s["statusLine"] = replacement;
    writeJson(settingsPath(), s);

    const replaced = await doctor();
    expect(replaced.code).toBe(ExitCode.PRECOND);
    const line = userLine(replaced.env, "user:statusLine");
    expect(line).toContain("no longer myc's");
    expect(line).toContain("(orca's line)");
    expect(line).toContain("`myc wire --scope user --status-line` puts ours back");

    await wireUser("--status-line");
    expect(userLine((await doctor()).env, "user:statusLine")).toStartWith("ok|");
    expect(readUserJournal(journalPath())?.status_line).toEqual({ previous: replacement });

    // Строку сняли вовсе — тоже расхождение, не «ок».
    const t = readJson(settingsPath());
    delete t["statusLine"];
    writeJson(settingsPath(), t);
    expect(userLine((await doctor()).env, "user:statusLine")).toContain("gone:");
  });

  test("myc нашей строки исчез — строка пуста и прежняя без ввода: расхождение", async () => {
    await wireUser("--status-line");
    rmSync(shim);
    const res = await doctor();
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(userLine(res.env, "user:statusLine")).toContain(`runs ${shim}, which is not there`);
  });

  test("MCP-сервер снят после wire — расхождение с готовым советом", async () => {
    await wireUser();
    const claudeJson = join(home, ".claude.json");
    const c = readJson(claudeJson);
    delete c["mcpServers"]["myc"];
    writeJson(claudeJson, c);
    const res = await doctor();
    expect(res.code).toBe(ExitCode.PRECOND);
    const line = userLine(res.env, "user:mcp");
    expect(line).toContain("gone:");
    expect(line).toContain("myc wire --scope user");
  });
});

/**
 * Каталог без проектной проводки при исправном пользовательском слое
 * (memory-qya8z12f3yae). Так выглядит каждый worktree orca и каждый вложенный
 * репозиторий: `.claude` там командный, и хуки myc ставит пользовательский
 * слой. Прежде doctor печатал «unknown: журнала wire.json нет» и WARN
 * doctor.unknown — тревогу на норме. Проверяется на НАСТОЯЩЕМ `git worktree
 * add`, а не на подделанных путях.
 */
describe("myc doctor --hooks: проектной проводки здесь нет, пользовательский слой исправен", () => {
  function git(cwd: string, ...args: string[]): void {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }

  /** Хуки срабатывали: счётчик лежит у базы (он общий для всех деревьев воркспейса). */
  function fired(): void {
    const at = Date.now() - 60_000;
    const c = (count: number) => ({ count, last_at: at, last_ms: 5, last_status: "ok" });
    writeJson(join(ws, ".myc", "hooks.json"), {
      v: 1,
      hooks: { "claude:session-start": c(43), "claude:post-edit": c(507), "claude:pre-compact": c(1) },
    });
  }

  async function doctorAt(dir: string): Promise<{ code: number; env: Envelope & { warn?: Array<{ code: string; msg: string }> } }> {
    const res = await run(["-C", dir, "doctor", "--hooks", "--json"], { registry, env: { MYC_ACTOR: "tester", MYC_DRAIN: "0" } });
    return { code: res.code, env: JSON.parse(String(res.stdout)) as Envelope & { warn?: Array<{ code: string; msg: string }> } };
  }

  function worktree(): string {
    writeFileSync(join(ws, "README.md"), "ws\n");
    git(ws, "init", "-q", "-b", "main");
    git(ws, "add", "README.md");
    git(ws, "commit", "-q", "-m", "init");
    const wt = join(root, "wt-feature");
    git(ws, "worktree", "add", "-q", "-b", "feature", wt);
    return wt;
  }

  test("git worktree с одной пользовательской проводкой: ни одного WARN, строка project layer", async () => {
    await wireUser("--status-line");
    fired();
    const wt = worktree();

    const { code, env: e } = await doctorAt(wt);

    expect(code).toBe(ExitCode.OK);
    expect(e.warn ?? []).toEqual([]);
    const checks = e.data!.hooks!.checks;
    const project = checks.find((c) => c.name === "project layer");
    expect(project).toBeDefined();
    expect(project!.verdict).toBe("n/a");
    expect(project!.detail).toStartWith("not wired here (user layer: ok)");
    expect(checks.some((c) => c.name === "wire.json")).toBe(false);
    expect(e.data!.hooks!.layer).toBe("user");
    // Источник назван: счётчик — у базы основного дерева, установка — слой пользователя.
    expect(checks.find((c) => c.name === "sources")?.detail).toContain("installation from the user layer");
    for (const h of e.data!.hooks!.hooks) expect({ event: h.event, verdict: h.verdict }).toMatchObject({ verdict: expect.stringMatching(/^(ok|n\/a)$/) });
  });

  test("вложенный репозиторий без проводки — то же самое", async () => {
    await wireUser();
    fired();
    const nested = join(ws, "nested");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q", "-b", "main");

    const { code, env: e } = await doctorAt(nested);

    expect(code).toBe(ExitCode.OK);
    expect(e.warn ?? []).toEqual([]);
    expect(e.data!.hooks!.checks.find((c) => c.name === "project layer")?.detail).toContain("not wired here (user layer: ok)");
  });

  test("пользовательский слой неисправен — прежнее «не знаю», а не «not wired here»", async () => {
    await wireUser();
    fired();
    const s = readJson(settingsPath());
    delete s["hooks"]["PreCompact"];
    writeJson(settingsPath(), s);
    const wt = worktree();

    const { env: e } = await doctorAt(wt);
    const all = [...(e.warn ?? []).map((w) => w.msg), e.error?.msg ?? ""].join("\n");

    expect(all).toContain("wire.json");
    expect(all).not.toContain("not wired here (user layer: ok)");
  });

  test("пользовательского слоя нет вовсе — прежнее «не знаю»", async () => {
    fired();
    const wt = worktree();

    const { code, env: e } = await doctorAt(wt);

    expect(code).toBe(ExitCode.OK);
    expect((e.warn ?? []).map((w) => w.code)).toContain("doctor.unknown");
    expect(e.data!.hooks!.layer).toBeUndefined();
  });
});
