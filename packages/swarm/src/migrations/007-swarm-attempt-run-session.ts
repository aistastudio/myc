import type { SwarmMigration } from "./types.ts";

/**
 * Индекс по сессии, версия 7. Обратный вопрос — «чья это стенограмма» —
 * задаётся ровно там, где раньше стоял перебор файлов: разбирая расход,
 * надо знать, не посчитан ли он уже, и какой попытке он принадлежит.
 * Индекс частичный: строки без сессии в нём не нужны, а их большинство
 * у ретроспективных попыток.
 *
 * Один оператор на миграцию.
 */
const SQL = `CREATE INDEX swarm_attempt_run_session
  ON swarm_attempt_run (session_id)
  WHERE session_id IS NOT NULL`;

export const migration007SwarmAttemptRunSession: SwarmMigration = {
  version: 7,
  name: "swarm_attempt_run_session",
  sql: SQL,
  objects: ["swarm_attempt_run_session"],
};
