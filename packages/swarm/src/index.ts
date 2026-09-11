// TODO(myc-6j9): implement swarm_signal / swarm_route_decision tables and
// Thompson-sampling priors for model routing. Атрибуция исполнения (W11) —
// ./attribution.ts, вопрос к ней — ./compare.ts.
export type RoutingArm = {
  readonly modelId: string;
  readonly effort: string;
};

export {
  EFFORTS,
  HARNESSES,
  isCacheUnpriced,
  isPriceStale,
  PRICE_STALE_MS,
  Roster,
  RosterError,
  type AddModelInput,
  type Effort,
  type Harness,
  type ModelPrice,
  type PriceInput,
  type RosterEntry,
  type RosterErrorCode,
  type RosterModel,
  type UpdateModelInput,
} from "./roster.ts";
export {
  Attribution,
  AttributionError,
  CAVEATS,
  newAttemptId,
  OUTCOME_VERSION,
  qualityOf,
  VERDICTS,
  type AttemptRecord,
  type AttemptWithRun,
  type AttributionErrorCode,
  type Caveat,
  type CostBasis,
  type FinishAttemptInput,
  type RunInput,
  type RunRecord,
  type StartAttemptInput,
  type TokenUsage,
  type Verdict,
} from "./attribution.ts";
export {
  DISPATCH_SOURCES,
  EMPTY_LAUNCH,
  isAlive,
  isEmptyLaunch,
  isSelfAttributed,
  launchContext,
  LINK_SOURCES,
  LIVE_STATE_MEANING,
  LIVE_STATES,
  liveStateOf,
  overrideLaunch,
  parsePid,
  PID_SOURCES,
  pidAlive,
  PROC_STATES,
  type DispatchSource,
  type LaunchContext,
  type LinkSource,
  type LiveState,
  type OrphanContext,
  type PidSource,
  type ProcState,
} from "./launch.ts";
export {
  betaCdf,
  betaQuantile,
  compareModels,
  CREDIBLE_MASS,
  DEFAULT_MIN_ATTEMPTS,
  qualityInterval,
  type AnswerCode,
  type ArmStat,
  type ClassAnswer,
  type CompareOptions,
  type CompareReport,
  type Interval,
} from "./compare.ts";
export {
  classifyTask,
  computeScope,
  computeTaskClass,
  FP_VERSION,
  INTENTS,
  isTaskClass,
  pathsInText,
  pickScopePaths,
  SCOPE_SOURCES,
  SCOPES,
  type ClassifyInput,
  type ClassifyResult,
  type Intent,
  type Scope,
  type ScopePathSources,
  type ScopeSource,
  type TaskClass,
  type TaskClassInput,
  type TaskClassResult,
} from "./taskclass.ts";
export {
  GIT_TIMEOUT_MS,
  parseGitBase,
  snapshotCheckouts,
  touchedSince,
  type CheckoutBase,
  type GitBase,
  type TouchedKey,
} from "./touched.ts";
export { ensureSwarmSchema, SwarmSchemaError, type SwarmSchemaErrorCode } from "./schema.ts";
// BOOKKEEPING_TABLE публично затем, что `myc doctor --schema` обязан назвать
// ТРИ версии схемы, а не одну: у swarm свой набор и своя таблица учёта, и
// без неё его таблицы читались бы как «лишние объекты» в базовой сверке.
export {
  swarmMigrations,
  BOOKKEEPING_TABLE,
  migrationStatements,
  migrationText,
  type SwarmMigration,
} from "./migrations/index.ts";
export {
  findSessionTranscript,
  findTaskTranscripts,
  readTranscriptUsage,
  taskNeedle,
  transcriptDir,
  TranscriptError,
  USAGE_FIELDS,
  type TranscriptErrorCode,
  type TranscriptTotals,
  type TranscriptUsage,
} from "./transcript.ts";
