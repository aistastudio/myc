import type { SwarmMigration } from "./types.ts";

/**
 * Индекс по задаче, версия 4. Закрытие задачи ищет открытую попытку
 * (`task_id = ? AND finished_at IS NULL`) на каждом `myc close` — без
 * индекса это скан таблицы попыток в пути записи. Порядок колонок
 * (task_id, started_at DESC) обслуживает и «последняя попытка по задаче».
 *
 * Один оператор на миграцию.
 */
const SQL = `CREATE INDEX swarm_attempt_task ON swarm_attempt (task_id, started_at DESC)`;

export const migration004SwarmAttemptTask: SwarmMigration = {
  version: 4,
  name: "swarm_attempt_task",
  sql: SQL,
  objects: ["swarm_attempt_task"],
};
