// Публичный API @myc/mcp: команда `myc mcp` для реестра CLI и сервер для тестов.
export type { McpProfile, McpToolDef } from "./tools.ts";
export { AGENT_TOOLS, CODE_REF_KINDS, CODE_TOOLS, WORK_TOOLS, toolsForProfile } from "./tools.ts";
export {
  AGENT_PROFILE_TOKEN_BUDGET,
  CODE_DESCRIPTION_TOKEN_BUDGET,
  DESCRIPTION_TOKEN_BUDGET,
  GRAFT_TOOLS_TOKENS,
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
