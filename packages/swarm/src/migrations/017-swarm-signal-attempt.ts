import type { SwarmMigration } from "./types.ts";

/** Индекс сигнала по попытке: «что вообще известно об этой попытке» — путь пересчёта исхода. */
const SQL = `CREATE INDEX swarm_signal_attempt ON swarm_signal(attempt_id, kind)`;

export const migration017SwarmSignalAttempt: SwarmMigration = {
  version: 17,
  name: "swarm_signal_attempt",
  sql: SQL,
  objects: ["swarm_signal_attempt"],
};
