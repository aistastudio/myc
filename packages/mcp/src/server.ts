/**
 * MCP-сервер по stdio: newline-delimited JSON-RPC 2.0.
 *
 * SDK (@modelcontextprotocol/*) в проекте нет и тащить его за семью методами
 * незачем: initialize, notifications/initialized, ping, tools/list, tools/call.
 * Внешних зависимостей ноль — холодный старт это тоже бюджет (§4.14).
 *
 * Коды: -32700 parse, -32600 invalid request, -32601 method not found,
 * -32602 invalid params (включая unknown tool). Ошибки ВНУТРИ тула — не
 * JSON-RPC ошибки, а результат isError:true (§4.3).
 */

import type { CallToolResult, Dispatch } from "./dispatch.ts";
import { UnknownToolError } from "./dispatch.ts";
import type { McpToolDef } from "./tools.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerOptions {
  readonly name?: string;
  readonly version?: string;
  readonly tools: readonly McpToolDef[];
  readonly dispatch: Dispatch;
  /** Правила работы + вывод bootstrap — агент узнает их при рукопожатии, не спрашивая. */
  readonly instructions?: string | (() => Promise<string>);
}

type RpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

function reply(id: RpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function replyError(id: RpcId, error: RpcError): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`;
}

export class McpServer {
  #instructions: string | undefined;

  constructor(private readonly opts: McpServerOptions) {}

  async #resolveInstructions(): Promise<string | undefined> {
    if (this.#instructions !== undefined) return this.#instructions;
    const src = this.opts.instructions;
    if (src === undefined) return undefined;
    const value = typeof src === "function" ? await src() : src;
    this.#instructions = value;
    return value;
  }

  /** Одна строка запроса → строка ответа; null для уведомлений. */
  async handleLine(line: string): Promise<string | null> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return replyError(null, { code: -32700, message: "parse error: not JSON" });
    }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
      return replyError(null, { code: -32600, message: "invalid request: single object expected" });
    }
    const req = msg as Record<string, unknown>;
    const id = (req["id"] ?? null) as RpcId;
    const method = req["method"];
    if (typeof method !== "string") {
      return replyError(id, { code: -32600, message: "invalid request: no method" });
    }
    const isNotification = req["id"] === undefined;

    try {
      const result = await this.#dispatchMethod(method, req["params"], isNotification);
      if (isNotification) return null;
      if (result === undefined) return reply(id, {});
      return reply(id, result);
    } catch (e) {
      if (isNotification) return null;
      if (e instanceof UnknownToolError) {
        return replyError(id, { code: -32602, message: e.message });
      }
      if (e instanceof RpcMethodError) {
        return replyError(id, { code: e.code, message: e.message });
      }
      return replyError(id, {
        code: -32603,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async #dispatchMethod(method: string, params: unknown, isNotification: boolean): Promise<unknown> {
    switch (method) {
      case "initialize": {
        if (isNotification) return undefined;
        const instructions = await this.#resolveInstructions();
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: this.opts.name ?? "myc",
            version: this.opts.version ?? "0.0.0",
          },
          ...(instructions !== undefined ? { instructions } : {}),
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.opts.tools };
      case "tools/call": {
        if (typeof params !== "object" || params === null) {
          throw new RpcMethodError(-32602, "tools/call: params required");
        }
        const p = params as Record<string, unknown>;
        const name = p["name"];
        if (typeof name !== "string") {
          throw new RpcMethodError(-32602, "tools/call: 'name' required");
        }
        const args = p["arguments"];
        if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
          throw new RpcMethodError(-32602, "tools/call: 'arguments' must be an object");
        }
        const result: CallToolResult = await this.opts.dispatch(
          name,
          (args ?? {}) as Record<string, unknown>,
        );
        return result;
      }
      default:
        if (method.startsWith("notifications/")) return undefined;
        throw new RpcMethodError(-32601, `method not found: ${method}`);
    }
  }
}

class RpcMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Цикл stdio: читаем построчно до EOF, ответы пишем по одной строке.
 * Возвращается, когда stdin закрылся (хост завершил сессию).
 */
export async function serveStdio(
  server: McpServer,
  input: ReadableStream<Uint8Array>,
  write: (chunk: string) => void,
): Promise<void> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        // последовательно: claim двух задач «параллельно» не должен гоняться
        // за один стор, а клиент ждёт ответы по одному
        const out = await server.handleLine(line);
        if (out !== null) write(out);
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      const out = await server.handleLine(tail);
      if (out !== null) write(out);
    }
  } finally {
    reader.releaseLock();
  }
}
