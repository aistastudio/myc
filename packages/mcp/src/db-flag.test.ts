/**
 * `myc --db <база> mcp` (memory-dyjt6fafz8j9): инструменты прямого стора
 * (myc_link, myc_update op=note/release/extend) пишут в ТУ базу, что названа
 * флагом, а не в базу воркспейса вокруг cwd.
 *
 * Прежде команды CLI сервер звал с `--db`, а прямой стор открывал
 * `<каталог>/.myc/myc.db` найденного по cwd воркспейса: заметка и связь
 * уезжали в чужую базу (или отказывали notfound, если узла там нет), а
 * instructions собирались со слагом того воркспейса, откуда запустили.
 * Правило то же, что у CLI: `--db` — это база и её воркспейс
 * (`workspace.toml` рядом с ней); открыть её нельзя — отказ вслух.
 *
 * Настоящий процесс `myc mcp` по stdio, всё во временном каталоге.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliTestEnv } from "@myc/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");

let root: string;
let env: Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myc-mcp-dbflag-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = cliTestEnv({ HOME: home, MYC_HOME: home, MYC_ACTOR: "dbflag-agent", MYC_DRAIN: "0" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function cli(...args: string[]): string {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`myc ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

interface Rpc {
  id: number;
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

class Session {
  #proc: Subprocess;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = "";
  #id = 0;

  constructor(cwd: string, argv: readonly string[]) {
    this.#proc = Bun.spawn([process.execPath, CLI, ...argv], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
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

  call(name: string, args: Record<string, unknown>): Promise<Rpc> {
    return this.request("tools/call", { name, arguments: args });
  }

  initialize(): Promise<Rpc> {
    return this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dbflag", version: "0" } });
  }

  async close(): Promise<{ code: number; stderr: string }> {
    try {
      (this.#proc.stdin as import("bun").FileSink).end();
    } catch {
      // уже закрыт
    }
    const code = await this.#proc.exited;
    const stderr = await new Response(this.#proc.stderr as ReadableStream<Uint8Array>).text();
    return { code, stderr };
  }
}

function count(dbPath: string, sql: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("myc --db … mcp", () => {
  test("прямой стор пишет в базу из --db, а не в воркспейс вокруг cwd", async () => {
    const cherry = join(root, "cherry");
    const local = join(root, "local");
    mkdirSync(cherry, { recursive: true });
    mkdirSync(local, { recursive: true });
    cli("-C", cherry, "init", "--slug", "cherry");
    cli("-C", local, "init", "--slug", "local");
    const task = cli("-C", cherry, "create", "Задача cherry", "-p", "P1").split(/\s+/)[0]!;
    const other = cli("-C", cherry, "create", "Вторая задача cherry").split(/\s+/)[0]!;
    const cherryDb = join(cherry, ".myc", "myc.db");
    const localDb = join(local, ".myc", "myc.db");
    const localNodes = count(localDb, "SELECT count(*) AS n FROM nodes");
    const localEdges = count(localDb, "SELECT count(*) AS n FROM edges");

    const s = new Session(local, ["--db", cherryDb, "mcp"]);
    try {
      const init = await s.initialize();
      expect(String(init.result!["instructions"])).toContain("ws=cherry");

      const note = await s.call("myc_update", { id: task, op: "note", note: "заметка через --db" });
      expect(note.result!["isError"], JSON.stringify(note.result)).toBeUndefined();
      const noteId = String(note.result!["structuredContent"]["note_id"] ?? note.result!["structuredContent"]["id"]);
      expect(noteId.startsWith("cherry-")).toBe(true);

      const link = await s.call("myc_link", { from: task, type: "relates-to", to: other });
      expect(link.result!["isError"]).toBeUndefined();

      const claim = await s.call("myc_ready", { claim: true, id: task });
      expect(claim.result!["isError"]).toBeUndefined();
      const extend = await s.call("myc_update", { id: task, op: "extend", lease_minutes: 60 });
      expect(extend.result!["isError"]).toBeUndefined();
      const release = await s.call("myc_update", { id: task, op: "release" });
      expect(release.result!["isError"]).toBeUndefined();
    } finally {
      await s.close();
    }
    // В базе из --db: заметка и связь есть; в базе cwd — ничего нового.
    expect(count(cherryDb, "SELECT count(*) AS n FROM edges WHERE type = 'relates' AND deleted_at IS NULL")).toBe(1);
    expect(count(cherryDb, "SELECT count(*) AS n FROM edges WHERE type = 'replies_to' AND deleted_at IS NULL")).toBe(1);
    expect(count(localDb, "SELECT count(*) AS n FROM nodes")).toBe(localNodes);
    expect(count(localDb, "SELECT count(*) AS n FROM edges")).toBe(localEdges);
  }, 60_000);

  test("копия базы файлом вне .myc: прямой стор пишет в неё, слаг — из workspace.toml рядом", async () => {
    const cherry = join(root, "cherry");
    const local = join(root, "local");
    const copyDir = join(root, "copy");
    mkdirSync(cherry, { recursive: true });
    mkdirSync(local, { recursive: true });
    mkdirSync(copyDir, { recursive: true });
    cli("-C", cherry, "init", "--slug", "cherry");
    cli("-C", local, "init", "--slug", "local");
    const task = cli("-C", cherry, "create", "Задача cherry", "-p", "P1").split(/\s+/)[0]!;
    const copy = join(copyDir, "copy.db");
    const src = new Database(join(cherry, ".myc", "myc.db"));
    src.exec(`VACUUM INTO '${copy}'`);
    src.close();
    writeFileSync(join(copyDir, "workspace.toml"), `slug = "cherry"\n`);

    const s = new Session(local, ["--db", copy, "mcp"]);
    try {
      await s.initialize();
      const note = await s.call("myc_update", { id: task, op: "note", note: "заметка в копию" });
      expect(note.result!["isError"], JSON.stringify(note.result)).toBeUndefined();
      expect(String(note.result!["structuredContent"]["note_id"]).startsWith("cherry-")).toBe(true);
    } finally {
      await s.close();
    }
    expect(count(copy, "SELECT count(*) AS n FROM edges WHERE type = 'replies_to' AND deleted_at IS NULL")).toBe(1);
    expect(count(join(cherry, ".myc", "myc.db"), "SELECT count(*) AS n FROM edges WHERE type = 'replies_to'")).toBe(0);
  }, 60_000);

  test("--db на несуществующий файл: ни одного инструмента и причина названа путём", async () => {
    const local = join(root, "local");
    mkdirSync(local, { recursive: true });
    cli("-C", local, "init", "--slug", "local");
    const missing = join(root, "нет", "myc.db");
    const s = new Session(local, ["--db", missing, "mcp"]);
    let stderr = "";
    try {
      const init = await s.initialize();
      expect(init.result!["instructions"]).toBeUndefined();
      expect((await s.request("tools/list")).result).toEqual({ tools: [] });
    } finally {
      stderr = (await s.close()).stderr;
    }
    expect(stderr).toContain(missing);
  }, 30_000);
});
