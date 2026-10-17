import type { SwarmMigration } from "./types.ts";

/** Путь «все решения по задаче» — ретроспектива и переигрывание. */
const SQL = `CREATE INDEX swarm_route_task ON swarm_route_decision(task_id, at)`;

export const migration020SwarmRouteTask: SwarmMigration = {
  version: 20,
  name: "swarm_route_task",
  sql: SQL,
  objects: ["swarm_route_task"],
};
