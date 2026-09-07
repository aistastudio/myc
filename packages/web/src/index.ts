/**
 * `@myc/web` — просмотрщик графа и статистики (`myc viz`).
 *
 * Читает своим соединением, пишет чужим: поднимает локальный Bun-сервер,
 * открывает ту же SQLite в режиме readonly и показывает четыре экрана — граф,
 * очередь ready с раскрытием слагаемых S21, таймлайн оплога, здоровье и
 * деградации. Правка идёт POST-маршрутами, и каждая уходит в тот же движок
 * команд, что обслуживает терминал (mutate.ts) — своего слоя мутаций здесь
 * нет и быть не может.
 *
 * Ноль рантайм-зависимостей, ноль CDN: интерфейс вшит в бинарь (см. assets.ts).
 */

export { startVizServer, VIZ_VERSION, type VizServer, type VizServerOptions } from "./server.ts";
export {
  cliRunner,
  runWrite,
  planCreate,
  planUpdate,
  planOp,
  checkIfMatch,
  aclDenial,
  nodeClocks,
  readNodeView,
  principalOf,
  httpStatusFor,
  UPDATE_FIELDS,
  WRITE_OPS,
  type RunCli,
  type WriteOp,
  type WriteOutcome,
  type WritePlan,
} from "./mutate.ts";
export { openReadOnly, VizDbError, type ReadOnlyDb } from "./db.ts";
export { buildGraph, DEFAULT_NODE_LIMIT, DEFAULT_EDGE_LIMIT } from "./graph.ts";
export { buildKb, KB_KINDS, KB_LIMIT, type KbOptions } from "./kb.ts";
export { buildReady, anchorNorm, freshnessNorm, typeNorm, scoreRow } from "./ready.ts";
export { buildRouting, type RoutingOptions } from "./routing.ts";
export { buildTimeline } from "./timeline.ts";
export { buildHealth, WAL_SOFT_LIMIT_BYTES, WAL_HARD_LIMIT_BYTES } from "./health.ts";
export {
  loadWorkspace,
  parseWorkspaceToml,
  DEFAULT_READY_WEIGHTS,
  type WorkspaceConfig,
} from "./workspace.ts";
export { getAsset, assetPaths, assetBytes, type Asset } from "./assets.ts";
export type * from "./types.ts";
