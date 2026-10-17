import type { SwarmMigration } from "./types.ts";
import { migration001SwarmModel } from "./001-swarm-model.ts";
import { migration002SwarmModelPrice } from "./002-swarm-model-price.ts";
import { migration003SwarmAttempt } from "./003-swarm-attempt.ts";
import { migration004SwarmAttemptTask } from "./004-swarm-attempt-task.ts";
import { migration005SwarmAttemptArm } from "./005-swarm-attempt-arm.ts";
import { migration006SwarmAttemptRun } from "./006-swarm-attempt-run.ts";
import { migration007SwarmAttemptRunSession } from "./007-swarm-attempt-run-session.ts";
import { migration008HarnessCodex } from "./008-harness-codex.ts";
import { migration009SwarmAttemptScope } from "./009-swarm-attempt-scope.ts";
import { migration010HarnessMcodeMimo } from "./010-harness-mcode-mimo.ts";
import { migration016SwarmSignal } from "./016-swarm-signal.ts";
import { migration017SwarmSignalAttempt } from "./017-swarm-signal-attempt.ts";
import { migration018SwarmSignalTime } from "./018-swarm-signal-time.ts";
import { migration019SwarmRouteDecision } from "./019-swarm-route-decision.ts";
import { migration020SwarmRouteTask } from "./020-swarm-route-task.ts";
import { migration021SwarmArm } from "./021-swarm-arm.ts";

/**
 * Набор миграций роя. Версии — отдельная нумерация от базовой схемы
 * (своя таблица учёта swarm_schema_migrations, см. 000-bookkeeping.ts):
 * базовый движок о таблицах swarm_* не знает и знать не должен.
 */
export const swarmMigrations: readonly SwarmMigration[] = [
  migration001SwarmModel,
  migration002SwarmModelPrice,
  migration003SwarmAttempt,
  migration004SwarmAttemptTask,
  migration005SwarmAttemptArm,
  migration006SwarmAttemptRun,
  migration007SwarmAttemptRunSession,
  migration008HarnessCodex,
  migration009SwarmAttemptScope,
  migration010HarnessMcodeMimo,
  // НУМЕРАЦИЯ С ПРОПУСКОМ011–015: эти номера заняты веткой ade-wave0
  // (011 ade-spawn-quota … 015 spawn-paused-state) — при слиянии наборы
  // объединяются, и конфликт по номеру был бы конфликтом по содержимому.
  // Цепочка не требует непрерывности: учёт — swarm_schema_migrations.
  migration016SwarmSignal,
  migration017SwarmSignalAttempt,
  migration018SwarmSignalTime,
  migration019SwarmRouteDecision,
  migration020SwarmRouteTask,
  migration021SwarmArm,
];

export { BOOKKEEPING_DDL, BOOKKEEPING_TABLE } from "./000-bookkeeping.ts";
export type { SwarmMigration } from "./types.ts";
export { migrationStatements, migrationText } from "./types.ts";
export { migration001SwarmModel } from "./001-swarm-model.ts";
export { migration002SwarmModelPrice } from "./002-swarm-model-price.ts";
export { migration003SwarmAttempt } from "./003-swarm-attempt.ts";
export { migration004SwarmAttemptTask } from "./004-swarm-attempt-task.ts";
export { migration005SwarmAttemptArm } from "./005-swarm-attempt-arm.ts";
export { migration006SwarmAttemptRun } from "./006-swarm-attempt-run.ts";
export { migration007SwarmAttemptRunSession } from "./007-swarm-attempt-run-session.ts";
export { migration008HarnessCodex } from "./008-harness-codex.ts";
export { migration009SwarmAttemptScope } from "./009-swarm-attempt-scope.ts";
export { migration010HarnessMcodeMimo } from "./010-harness-mcode-mimo.ts";
export { migration016SwarmSignal } from "./016-swarm-signal.ts";
export { migration017SwarmSignalAttempt } from "./017-swarm-signal-attempt.ts";
export { migration018SwarmSignalTime } from "./018-swarm-signal-time.ts";
export { migration019SwarmRouteDecision } from "./019-swarm-route-decision.ts";
export { migration020SwarmRouteTask } from "./020-swarm-route-task.ts";
export { migration021SwarmArm } from "./021-swarm-arm.ts";
