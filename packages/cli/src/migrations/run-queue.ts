/**
 * Миграции `~/.myc/queue.db` — базы очереди `myc run` (memory-n2r3krccqyj6).
 *
 * Это ОТДЕЛЬНАЯ база, не воркспейс: ни оплога, ни графа, ни GraphStore. Её
 * схема не входит в набор packages/store-sqlite/src/migrations и в
 * db/schema.sqlite.sql — те описывают базу проекта. Но дисциплина та же
 * (schema.test.ts, «CREATE TABLE вне набора миграций»): таблица не создаётся
 * в команде по месту, а объявлена версией здесь; применённая версия видна как
 * `PRAGMA user_version`. Выпущенную миграцию не правят — следующая меняет
 * схему новой записью в конце списка.
 */

export interface QueueMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const QUEUE_MIGRATIONS: readonly QueueMigration[] = [
  {
    version: 1,
    name: "run-queue",
    sql: `
CREATE TABLE IF NOT EXISTS run_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lane          TEXT    NOT NULL,
  holder        TEXT    NOT NULL,
  pid           INTEGER NOT NULL,
  host          TEXT    NOT NULL,
  state         TEXT    NOT NULL CHECK (state IN ('waiting', 'running')),
  enqueued_at   INTEGER NOT NULL,
  started_at    INTEGER,
  lease_ms      INTEGER NOT NULL,
  lease_expires INTEGER NOT NULL,
  renewed_at    INTEGER NOT NULL,
  argv          TEXT    NOT NULL,
  cwd           TEXT    NOT NULL,
  session       TEXT    NOT NULL DEFAULT '',
  terminal      TEXT    NOT NULL DEFAULT '',
  agent_pid     INTEGER,
  actor         TEXT    NOT NULL DEFAULT '',
  child_pid     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_run_queue_lane ON run_queue (lane, id);
`,
  },
];
