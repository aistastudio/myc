import type { SwarmMigration } from "./types.ts";
import { migration001SwarmModel } from "./001-swarm-model.ts";
import { migration002SwarmModelPrice } from "./002-swarm-model-price.ts";
import { migration003SwarmAttempt } from "./003-swarm-attempt.ts";
import { migration004SwarmAttemptTask } from "./004-swarm-attempt-task.ts";
import { migration005SwarmAttemptArm } from "./005-swarm-attempt-arm.ts";
import { migration006SwarmAttemptRun } from "./006-swarm-attempt-run.ts";
import { migration007SwarmAttemptRunSession } from "./007-swarm-attempt-run-session.ts";

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
];

export { BOOKKEEPING_DDL, BOOKKEEPING_TABLE } from "./000-bookkeeping.ts";
export type { SwarmMigration } from "./types.ts";
export { migration001SwarmModel } from "./001-swarm-model.ts";
export { migration002SwarmModelPrice } from "./002-swarm-model-price.ts";
export { migration003SwarmAttempt } from "./003-swarm-attempt.ts";
export { migration004SwarmAttemptTask } from "./004-swarm-attempt-task.ts";
export { migration005SwarmAttemptArm } from "./005-swarm-attempt-arm.ts";
export { migration006SwarmAttemptRun } from "./006-swarm-attempt-run.ts";
export { migration007SwarmAttemptRunSession } from "./007-swarm-attempt-run-session.ts";
