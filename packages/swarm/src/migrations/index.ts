import type { SwarmMigration } from "./types.ts";
import { migration001SwarmModel } from "./001-swarm-model.ts";
import { migration002SwarmModelPrice } from "./002-swarm-model-price.ts";
import { migration003SwarmAttempt } from "./003-swarm-attempt.ts";
import { migration004SwarmAttemptTask } from "./004-swarm-attempt-task.ts";
import { migration005SwarmAttemptArm } from "./005-swarm-attempt-arm.ts";

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
];

export { BOOKKEEPING_DDL, BOOKKEEPING_TABLE } from "./000-bookkeeping.ts";
export type { SwarmMigration } from "./types.ts";
export { migration001SwarmModel } from "./001-swarm-model.ts";
export { migration002SwarmModelPrice } from "./002-swarm-model-price.ts";
export { migration003SwarmAttempt } from "./003-swarm-attempt.ts";
export { migration004SwarmAttemptTask } from "./004-swarm-attempt-task.ts";
export { migration005SwarmAttemptArm } from "./005-swarm-attempt-arm.ts";
