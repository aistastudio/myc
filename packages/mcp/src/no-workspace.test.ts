/**
 * `myc mcp` без воркспейса и сервер пользовательского слоя (memory-bh5pbp4nyjwk).
 *
 * Сервер из `claude mcp add --scope user` стартует в КАЖДОЙ сессии на машине.
 * Вне воркспейса он обязан отдать ноль инструментов и ни строки instructions —
 * иначе 13 инструментов с ws.not_initialized и правила myc попадали бы в
 * системный промпт каждого проекта человека. И обязан найти проект там, где
 * его называет Claude Code: сервер пользовательского слоя запускается с cwd =
 * `~/.claude`, а проект приходит в CLAUDE_PROJECT_DIR (code.claude.com/docs/en/mcp).
 *
 * Настоящий процесс `myc mcp` по stdio, временный HOME, никаких правок вне tmp.
 *
 * Мутации, на которых файл обязан краснеть (проверены на приёмке):
 *   «вне воркспейса — весь профиль» (ветка без воркспейса снята): падает
 *       «каталог без воркспейса: 0 инструментов, без instructions»;
 *   «CLAUDE_PROJECT_DIR не читается»: падает «сервер пользовательского слоя».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliTestEnv } from "@myc/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");

let root: string;
let env: Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myc-mcp-nows-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = cliTestEnv({ HOME: home, MYC_HOME: home, MYC_ACTOR: "nows-agent", MYC_DRAIN: "0" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function cli(...args: string[]): string {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`myc ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

interface Rpc {
  id: number;
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

/** Сервер как у хоста: cwd и окружение задаёт запускающий. */
class Session {
  #proc: Subprocess;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = "";
  #id = 0;

  constructor(cwd: string, extraEnv: Record<string, string> = {}) {
    this.#proc = Bun.spawn([process.execPath, CLI, "mcp"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, ...extraEnv },
    });
    this.#reader = (this.#proc.stdout as ReadableStream<Uint8Array>).getReader();
  }

  async request(method: string, params?: unknown): Promise<Rpc> {
    const id = ++this.#id;
    const sink = this.#proc.stdin as import("bun").FileSink;
    sink.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    sink.flush();
    const decoder = new TextDecoder();
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        return JSON.parse(line) as Rpc;
      }
      const { done, value } = await this.#reader.read();
      if (done) throw new Error("server closed stdout");
      this.#buffer += decoder.decode(value, { stream: true });
    }
  }

  initialize(): Promise<Rpc> {
    return this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nows", version: "0" } });
  }

  async close(): Promise<number> {
    try {
      (this.#proc.stdin as import("bun").FileSink).end();
    } catch {
      // уже закрыт
    }
    return this.#proc.exited;
  }
}

describe("myc mcp вне воркспейса", () => {
  test("каталог без воркспейса: 0 инструментов, без instructions, сервер жив", async () => {
    const plain = join(root, "tunnel");
    mkdirSync(plain, { recursive: true });
    const s = new Session(plain);
    try {
      const init = await s.initialize();
      expect(init.error).toBeUndefined();
      expect(init.result!["instructions"]).toBeUndefined();
      expect(init.result!["serverInfo"]["name"]).toBe("myc");
      expect((await s.request("tools/list")).result).toEqual({ tools: [] });
      // Вызов по имени — «нет такого инструмента», и сервер после него жив.
      const call = await s.request("tools/call", { name: "myc_prime", arguments: {} });
      expect(call.error?.code).toBe(-32602);
      expect((await s.request("ping")).result).toEqual({});
    } finally {
      expect(await s.close()).toBe(0);
    }
  }, 30_000);

  test("в воркспейсе — весь профиль: 13 инструментов и правила в instructions", async () => {
    const ws = join(root, "proj");
    mkdirSync(ws, { recursive: true });
    cli("-C", ws, "init");
    const s = new Session(ws);
    try {
      const init = await s.initialize();
      expect(String(init.result!["instructions"])).toContain("MYC BOOTSTRAP");
      expect(((await s.request("tools/list")).result!["tools"] as unknown[]).length).toBe(13);
    } finally {
      await s.close();
    }
  }, 30_000);

  test("сервер пользовательского слоя: cwd = ~/.claude, проект — git worktree вне дерева воркспейса", async () => {
    // ~/src/cherry с воркспейсом, репозиторий внутри, worktree orca снаружи.
    const ws = join(root, "cherry");
    const repo = join(ws, "collector");
    const wt = join(root, "orca", "workspaces", "collector", "feature");
    mkdirSync(repo, { recursive: true });
    cli("-C", ws, "init");
    git(repo, "init", "-q");
    writeFileSync(join(repo, "README.md"), "team repo\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const task = cli("-C", repo, "create", "Задача коллектора", "-p", "P1").split(/\s+/)[0]!;
    mkdirSync(dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", wt, "-b", "feature");

    const claudeDir = join(root, "home", ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const s = new Session(claudeDir, { CLAUDE_PROJECT_DIR: wt });
    try {
      const init = await s.initialize();
      expect(String(init.result!["instructions"])).toContain("ws=cherry");
      expect(((await s.request("tools/list")).result!["tools"] as unknown[]).length).toBe(13);
      const prime = await s.request("tools/call", { name: "myc_prime", arguments: {} });
      expect(prime.result!["isError"]).toBeUndefined();
      // Прямой стор (myc_link, заметки) открывается в найденном воркспейсе, а
      // не в `<worktree>/.myc`, которого нет.
      const note = await s.request("tools/call", { name: "myc_update", arguments: { id: task, op: "note", note: "из worktree" } });
      expect(note.result!["isError"]).toBeUndefined();
      const rem = await s.request("tools/call", { name: "myc_remember", arguments: { text: "факт из worktree orca" } });
      const noteId = String(rem.result!["structuredContent"]["id"]);
      const link = await s.request("tools/call", { name: "myc_link", arguments: { from: task, type: "relates-to", to: noteId } });
      expect(link.result!["isError"]).toBeUndefined();
    } finally {
      await s.close();
    }
  }, 60_000);
});
