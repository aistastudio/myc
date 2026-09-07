/**
 * Таблица учёта миграций роя. Своя, отдельная от `schema_migrations`
 * основного движка (packages/store-sqlite/src/migrate.ts): ростер живёт в
 * той же базе `.myc/myc.db`, но версионируется независимо, чтобы набор
 * миграций swarm не пересекался с базовым ни номерами, ни чек-суммами.
 *
 * DDL вынесен в каталог migrations/ намеренно: механический сторож
 * (packages/store-sqlite/src/migrations/schema.test.ts, «CREATE TABLE вне
 * набора миграций не появляется») разрешает CREATE TABLE только здесь.
 */
export const BOOKKEEPING_TABLE = "swarm_schema_migrations";

export const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS ${BOOKKEEPING_TABLE} (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  checksum   TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
)`;
