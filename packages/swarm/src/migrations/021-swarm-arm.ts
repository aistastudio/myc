import type { SwarmMigration } from "./types.ts";

/**
 * Приоры по рукам (спека: docs/design/04-swarm-learning-and-routing.md §2.2
 * «swarm_arm») — ЕДИНСТВЕННАЯ таблица, которую читает горячий путь route:
 * ~500 строк, целиком в кеше процесса. Материализация из сигналов:
 * alpha/beta — взвешенные псевдо-успехи/провалы (§2.3.2), n_eff —
 * эффективное число наблюдений с вычетом априори.
 *
 * WITHOUT ROWID — как в спеке: таблица ключуется составным (level,
 * model_id, effort, task_class), строк почти нет, а кластеризация по
 * ключу читает соседей одним куском.
 *
 * Один оператор — один элемент (roster.test.ts проверяет каждый).
 */
const SQL = `CREATE TABLE swarm_arm (
  model_id        TEXT NOT NULL,
  effort          TEXT NOT NULL,
  task_class      TEXT NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('local','team','global')),
  alpha           REAL NOT NULL,
  beta            REAL NOT NULL,
  n_eff           REAL NOT NULL,
  cost_mean_usd   REAL,
  cost_log_var    REAL,
  lat_mean_ms     REAL,
  lat_log_var     REAL,
  last_obs_at     INTEGER,
  snapshot_id     TEXT NOT NULL,
  computed_at     INTEGER NOT NULL,
  PRIMARY KEY (level, model_id, effort, task_class)
) WITHOUT ROWID`;

export const migration021SwarmArm: SwarmMigration = {
  version: 21,
  name: "swarm_arm",
  sql: SQL,
  objects: ["swarm_arm"],
};
