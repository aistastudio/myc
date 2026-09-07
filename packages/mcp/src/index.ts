// Публичный API @myc/mcp: команда `myc mcp` для реестра CLI и сервер для тестов.
export type { McpProfile, McpToolDef } from "./tools.ts";
export { AGENT_TOOLS, toolsForProfile } from "./tools.ts";
export {
  DESCRIPTION_TOKEN_BUDGET,
  estimateTokens,
  profileDescriptionTokens,
  toolDescriptionChars,
} from "./tokens.ts";
export { createDispatcher, UnknownToolError } from "./dispatch.ts";
export type { CallToolResult, CliOutcome, Dispatch, DispatchDeps, RunCli } from "./dispatch.ts";
export { McpServer, serveStdio, MCP_PROTOCOL_VERSION } from "./server.ts";
export { createMcpCommand } from "./command.ts";
export { openMcpStore, resolveNode } from "./store.ts";
/** @internal используется только store.parity.test.ts в @myc/cli (myc-qie.12) */
export { openDriver as internalOpenDriver, type McpDriver } from "./store.ts";
