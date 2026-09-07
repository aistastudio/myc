import type { SwarmMigration } from "./types.ts";

/**
 * Индекс руки, версия 5. Вопрос приёмки W11 — «какая модель на каком
 * классе задач дешевле при равном результате» — группирует закрытые
 * попытки по (task_class, model_id, effort). Этот же порядок колонок
 * читает будущий роутер (§2.5), поэтому индекс заводится сразу здесь, а
 * не когда отчёт начнёт тормозить.
 *
 * Один оператор на миграцию.
 */
const SQL = `CREATE INDEX swarm_attempt_arm
  ON swarm_attempt (task_class, model_id, effort, finished_at)`;

export const migration005SwarmAttemptArm: SwarmMigration = {
  version: 5,
  name: "swarm_attempt_arm",
  sql: SQL,
  objects: ["swarm_attempt_arm"],
};
