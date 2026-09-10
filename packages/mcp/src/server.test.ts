import { describe, expect, test } from "bun:test";
import { McpServer, MCP_PROTOCOL_VERSION } from "./server.ts";
import { UnknownToolError, type CallToolResult } from "./dispatch.ts";
import { AGENT_TOOLS } from "./tools.ts";

function makeServer(
  dispatch: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
): McpServer {
  return new McpServer({
    tools: AGENT_TOOLS,
    dispatch,
    instructions: "правила теста",
  });
}

const okDispatch = async (): Promise<CallToolResult> => ({
  content: [{ type: "text", text: "ok\n" }],
  structuredContent: { meta: { took_ms: 1, degraded: [] } },
});

describe("MCP stdio: протокол", () => {
  test("initialize: protocolVersion, serverInfo, instructions с правилами", async () => {
    const s = makeServer(okDispatch);
    const out = await s.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    const r = JSON.parse(out!);
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(r.result.serverInfo.name).toBe("myc");
    expect(r.result.capabilities.tools).toEqual({});
    expect(r.result.instructions).toContain("правила теста");
  });

  test("tools/list: все 13 инструментов профиля agent", async () => {
    const s = makeServer(okDispatch);
    const out = await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const r = JSON.parse(out!);
    expect(r.result.tools).toHaveLength(13);
    expect(r.result.tools.map((t: { name: string }) => t.name)).toContain("myc_ready");
    expect(r.result.tools.map((t: { name: string }) => t.name)).toContain("myc_callers");
  });

  test("tools/call: аргументы доезжают до dispatch, результат — наружу", async () => {
    let seen: { name: string; args: Record<string, unknown> } | undefined;
    const s = makeServer(async (name, args) => {
      seen = { name, args };
      return okDispatch();
    });
    const out = await s.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "myc_prime", arguments: { budget: 500 } },
      }),
    );
    const r = JSON.parse(out!);
    expect(seen).toEqual({ name: "myc_prime", args: { budget: 500 } });
    expect(r.result.content[0].text).toBe("ok\n");
    expect(r.result.structuredContent.meta.took_ms).toBe(1);
  });

  test("unknown tool → JSON-RPC -32602, а не isError", async () => {
    const s = makeServer(async (name) => {
      throw new UnknownToolError(`unknown tool '${name}'`);
    });
    const out = await s.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "myc_nope", arguments: {} },
      }),
    );
    const r = JSON.parse(out!);
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toContain("myc_nope");
  });

  test("битый JSON → -32700; неизвестный метод → -32601", async () => {
    const s = makeServer(okDispatch);
    const bad = JSON.parse((await s.handleLine("{not json"))!);
    expect(bad.error.code).toBe(-32700);
    const unknown = JSON.parse(
      (await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/list" })))!,
    );
    expect(unknown.error.code).toBe(-32601);
  });

  test("уведомления не получают ответа", async () => {
    const s = makeServer(okDispatch);
    const out = await s.handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(out).toBeNull();
  });

  test("arguments не-объект → -32602; падение dispatch → -32603", async () => {
    const s = makeServer(okDispatch);
    const bad = JSON.parse(
      (await s.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "myc_prime", arguments: [1, 2] },
        }),
      ))!,
    );
    expect(bad.error.code).toBe(-32602);

    const crashing = makeServer(async () => {
      throw new Error("бум");
    });
    const crashed = JSON.parse(
      (await crashing.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "myc_prime", arguments: {} },
        }),
      ))!,
    );
    expect(crashed.error.code).toBe(-32603);
    expect(crashed.error.message).toContain("бум");
  });

  test("ping → пустой результат", async () => {
    const s = makeServer(okDispatch);
    const r = JSON.parse((await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" })))!);
    expect(r.result).toEqual({});
  });
});
