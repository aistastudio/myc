/**
 * E2E: настоящий `myc mcp` процесс на stdio против временного воркспейса.
 * Первый сценарий прогоняет рукопожатие и каждый из 7 инструментов работы,
 * проверяет, что claim:true действительно берёт задачу за один вызов
 * (верификация снаружи, отдельным процессом `myc show --json`), и что
 * деградация доезжает до клиента. Второй — каждый из 6 инструментов кода: без
 * индекса они говорят, что выполнить, с индексом отвечают тем же текстом, что
 * команда в терминале, отдельным процессом.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CLI_VERSION } from "@myc/cli";
import { cliTestEnv } from "@myc/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const TEST_ENV: Record<string, string> = cliTestEnv({ MYC_ACTOR: "e2e-agent" });


async function cli(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, CLI, "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: TEST_ENV,
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

interface RpcResponse {
  id: number;
  result?: Record<string, unknown> & {
    content?: { text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

class McpSession {
  #proc: Subprocess;
  #reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  #buffer = "";
  #lines: string[] = [];
  #waiters: ((line: string) => void)[] = [];
  #nextId = 0;

  constructor(dir: string) {
    this.#proc = Bun.spawn([process.execPath, CLI, "-C", dir, "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: TEST_ENV,
    });
    this.#reader = (this.#proc.stdout as ReadableStream<Uint8Array>).getReader() as {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
    };
    void this.#pump();
  }

  async #pump(): Promise<void> {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await this.#reader.read();
      if (done) return;
      this.#buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(line);
        else this.#lines.push(line);
      }
    }
  }

  #nextLine(): Promise<string> {
    const buffered = this.#lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = ++this.#nextId;
    this.#stdin().write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    const line = await this.#nextLine();
    return JSON.parse(line) as RpcResponse;
  }

  #stdin(): import("bun").FileSink {
    return this.#proc.stdin as import("bun").FileSink;
  }

  async notify(method: string): Promise<void> {
    this.#stdin().write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async call(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    try {
      this.#stdin().end();
    } catch {
      // уже закрыт
    }
    await this.#proc.exited;
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-mcp-e2e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("myc mcp: stdio end-to-end", () => {
  test(
    "рукопожатие, все 7 инструментов работы, claim за один вызов, деградация до клиента",
    async () => {
      expect((await cli(dir, "init")).code).toBe(0);
      const t1 = (await cli(dir, "task", "Первая задача e2e", "-p", "P0")).out.split(/\s+/)[0]!;
      const t2 = (await cli(dir, "task", "Вторая задача e2e")).out.split(/\s+/)[0]!;

      const mcp = new McpSession(dir);
      try {
        // 1. initialize: правила и bootstrap в instructions — агент узнаёт их, не спрашивая
        const init = await mcp.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e", version: "0" },
        });
        expect(init.error).toBeUndefined();
        // serverInfo.version — единственное место, где клиент узнаёт версию
        // сервера. Сверяем с CLI_VERSION, а не с «не 0.0.0»: дефолт сервера
        // именно "0.0.0", и проверка на неравенство пропустила бы любую
        // другую неправду.
        const info = init.result!["serverInfo"] as Record<string, unknown>;
        expect(info["name"]).toBe("myc");
        expect(info["version"]).toBe(CLI_VERSION);
        const instructions = String(init.result!["instructions"] ?? "");
        expect(instructions).toContain("myc — this project's memory and tasks");
        expect(instructions).toContain("MYC BOOTSTRAP");
        await mcp.notify("notifications/initialized");

        // 2. tools/list: профиль agent целиком — 7 работы и 6 кода
        const list = await mcp.request("tools/list");
        expect((list.result!["tools"] as unknown[]).length).toBe(13);

        // 3. myc_prime
        const prime = await mcp.call("myc_prime", { budget: 800 });
        expect(prime.result!.isError).toBeUndefined();
        expect(prime.result!.content![0]!.text).toContain("MYC BOOTSTRAP");
        expect(prime.result!.structuredContent!["meta"]).toBeDefined();

        // 4. myc_ready списком: обе задачи видны
        const ready = await mcp.call("myc_ready", { n: 5 });
        expect(ready.result!.content![0]!.text).toContain(t1);
        expect(ready.result!.content![0]!.text).toContain(t2);

        // 5. myc_ready{claim:true}: ОДИН вызов — задача взята, контекст приложен.
        //    Верхняя по скору — P0 (t1).
        const claim = await mcp.call("myc_ready", { claim: true });
        expect(claim.result!.isError).toBeUndefined();
        const claimed = claim.result!.structuredContent!["claimed"] as {
          id: string;
          holder: string;
          lease_until: string;
          title: string;
          blocked_by: string[];
        };
        expect(claimed.id).toBe(t1);
        expect(claimed.holder).toBe("e2e-agent");
        expect(Date.parse(claimed.lease_until)).toBeGreaterThan(Date.now());
        expect(claim.result!.content![0]!.text).toContain(`claimed ${t1}`);
        // верификация снаружи, отдельным процессом: аренда и статус реальны
        const shown = JSON.parse((await cli(dir, "show", t1, "--json")).out) as {
          data: { status: string; lease?: { holder: string } };
        };
        expect(shown.data.status).toBe("in_progress");
        expect(shown.data.lease?.holder).toBe("e2e-agent");

        // 6. myc_remember + myc_recall: факт пишется и находится;
        //    деградация (нет chat-LLM / векторной ветки) видна клиенту
        const rem = await mcp.call("myc_remember", {
          text: "e2e: сервер myc по stdio отвечает на initialize и tools/list",
          tag: ["e2e"],
        });
        expect(rem.result!.isError).toBeUndefined();
        const remStructured = rem.result!.structuredContent!;
        const noteId = String(remStructured["id"]);
        expect(remStructured["written"]).toBe(true);
        const remMeta = remStructured["meta"] as { degraded: string[] };
        expect(remMeta.degraded).toContain("llm.chat.off");
        expect(rem.result!.content![0]!.text).toContain("WARN llm.chat.off");

        const recall = await mcp.call("myc_recall", { query: "stdio initialize" });
        expect(recall.result!.isError).toBeUndefined();
        expect(recall.result!.content![0]!.text).toContain(noteId);
        const recallMeta = recall.result!.structuredContent!["meta"] as { degraded: string[] };
        expect(recallMeta.degraded.length).toBeGreaterThan(0);

        // 7. myc_show батчем: два узла одним вызовом
        const show = await mcp.call("myc_show", { ids: [t1, noteId] });
        expect((show.result!.structuredContent!["nodes"] as unknown[]).length).toBe(2);

        // 8. myc_link: relates-to через прямой стор, потом blocks через dep
        const link = await mcp.call("myc_link", { from: t2, type: "relates-to", to: noteId });
        expect(link.result!.isError).toBeUndefined();
        const depLink = await mcp.call("myc_link", { from: t1, type: "blocks", to: t2 });
        expect(depLink.result!.isError).toBeUndefined();

        // 9. myc_update: заметка и закрытие с reason
        const note = await mcp.call("myc_update", { id: t1, op: "note", note: "промежуток готов" });
        expect(note.result!.isError).toBeUndefined();
        const close = await mcp.call("myc_update", { id: t1, op: "close", reason: "e2e пройден", verify: "tests" });
        expect(close.result!.isError).toBeUndefined();
        expect(close.result!.content![0]!.text).toContain(`closed ${t1}`);
        const closed = JSON.parse((await cli(dir, "show", t1, "--json")).out) as {
          data: { status: string };
        };
        expect(closed.data.status).toBe("closed");

        // 10. ошибка валидации — isError с кодом, а не падение сервера
        const bad = await mcp.call("myc_recall", {});
        expect(bad.result!.isError).toBe(true);
        expect(bad.result!.content![0]!.text).toContain("myc: usage.missing");
        const unknown = await mcp.call("myc_nope", {});
        expect(unknown.error?.code).toBe(-32602);
      } finally {
        await mcp.close();
      }
    },
    60_000,
  );

  test(
    "инструменты кода: без индекса — что выполнить; с индексом — тот же ответ, что в терминале",
    async () => {
      expect((await cli(dir, "init")).code).toBe(0);
      mkdirSync(join(dir, "src", "core"), { recursive: true });
      mkdirSync(join(dir, "src", "app"), { recursive: true });
      writeFileSync(
        join(dir, "src", "core", "chain.ts"),
        "export function leaf(n: number): number {\n  return n + 1;\n}\n\n" +
          "export function mid(n: number): number {\n  return leaf(leaf(n));\n}\n",
      );
      writeFileSync(
        join(dir, "src", "app", "use.ts"),
        'import { mid } from "../core/chain.ts";\n\nexport function useIt(): number {\n  return mid(1);\n}\n',
      );

      // Один и тот же вопрос в двух формах: вызов инструмента и argv терминала.
      const questions: { tool: string; args: Record<string, unknown>; argv: string[]; expect: string }[] = [
        { tool: "myc_code_search", args: { query: "leaf mid" }, argv: ["code", "search", "leaf", "mid"], expect: "src/core/chain.ts" },
        { tool: "myc_code_grep", args: { literal: "leaf(" }, argv: ["code", "grep", "leaf("], expect: "mid · function" },
        { tool: "myc_code_symbol", args: { name: "leaf" }, argv: ["code", "symbol", "leaf"], expect: "src/core/chain.ts:1-3" },
        { tool: "myc_callers", args: { name: "mid", direction: "in" }, argv: ["callers", "mid"], expect: "← useIt" },
        { tool: "myc_skeleton", args: { path: "src/core/chain.ts" }, argv: ["skeleton", "src/core/chain.ts"], expect: "export function mid(n: number): number" },
        { tool: "myc_code_map", args: {}, argv: ["code", "map"], expect: "src/core" },
      ];

      const mcp = new McpSession(dir);
      try {
        await mcp.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e", version: "0" },
        });
        await mcp.notify("notifications/initialized");
        const list = await mcp.request("tools/list");
        const names = (list.result!["tools"] as { name: string }[]).map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(questions.map((q) => q.tool)));

        // 1. Свежий воркспейс, индекса нет: каждый инструмент отказывает
        //    precond.no_index и называет команду — не пустая выдача и не падение.
        for (const q of questions) {
          const r = await mcp.call(q.tool, q.args);
          expect(r.error).toBeUndefined();
          expect({ tool: q.tool, isError: r.result!.isError }).toEqual({ tool: q.tool, isError: true });
          const t = r.result!.content![0]!.text;
          expect(t).toStartWith("myc: precond.no_index: ");
          expect(t).toEndWith("\nhint: myc code index");
        }

        // 2. Индекс построен отдельным процессом — сервер видит его без рестарта.
        expect((await cli(dir, "code", "index")).code).toBe(0);

        const norm = (s: string): string => s.replace(/\d+ (?:мс|ms)\b/g, "N ms").replace(/из кеша|from cache|\bcached\b/g, "N ms");
        for (const q of questions) {
          const r = await mcp.call(q.tool, q.args);
          expect({ tool: q.tool, isError: r.result!.isError }).toEqual({ tool: q.tool, isError: undefined });
          const t = r.result!.content![0]!.text;
          expect(t).toContain(q.expect);
          expect(r.result!.structuredContent!["meta"]).toBeDefined();
          // Тот же вопрос из терминала, отдельным процессом: текст тот же.
          const term = await cli(dir, ...q.argv);
          expect(term.code).toBe(0);
          expect({ tool: q.tool, text: norm(t) }).toEqual({ tool: q.tool, text: norm(term.out) });
        }
      } finally {
        await mcp.close();
      }
    },
    60_000,
  );
});
