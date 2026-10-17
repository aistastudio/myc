import type { SwarmMigration } from "./types.ts";

/** Индекс сигнала по времени: путь decay/фоновой прокрутки и «что пришло за сутки». */
const SQL = `CREATE INDEX swarm_signal_time ON swarm_signal(observed_at)`;

export const migration018SwarmSignalTime: SwarmMigration = {
  version: 18,
  name: "swarm_signal_time",
  sql: SQL,
  objects: ["swarm_signal_time"],
};
