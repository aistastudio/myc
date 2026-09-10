import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  BOOKKEEPING_DDL,
  BOOKKEEPING_TABLE,
  migrationStatements,
  migrationText,
  swarmMigrations,
  type SwarmMigration,
} from "./migrations/index.ts";

/**
 * Накат миграций ростера. Свой мини-движок, а не migrate() из пакета
 * store-sqlite: deps-check разрешает swarm зависеть только от @myc/core. Семантика повторяет основной движок там, где это важно:
 *
 * - накат в ОДНОЙ транзакции BEGIN IMMEDIATE на весь отстающий хвост —
 *   проверка «что применено» и применение сериализованы, поэтому гонка
 *   двух процессов (`myc model add` из двух терминалов) не даёт ни
 *   двойного CREATE TABLE, ни потерянной версии: второй процесс ждёт на
 *   busy_timeout и видит уже применённый набор;
 * - каждый объект из `objects` обязан появиться в sqlite_master —
 *   молчаливый пропуск DDL невозможен;
 * - текст применённой миграции фиксируется чек-суммой: правка DDL задним
 *   числом — schema.checksum, а не молчаливое расхождение баз со схемой;
 * - база новее бинаря — schema.newer (коды те же, что у основного движка).
 */

export type SwarmSchemaErrorCode = "schema.newer" | "schema.checksum" | "schema.objects";

export class SwarmSchemaError extends Error {
  readonly code: SwarmSchemaErrorCode;

  constructor(code: SwarmSchemaErrorCode, message: string) {
    super(message);
    this.name = "SwarmSchemaError";
    this.code = code;
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

interface AppliedRow {
  readonly version: number;
  readonly checksum: string;
}

/**
 * Быстрый путь: набор уже накатан целиком и чек-суммы сходятся. Нужен,
 * потому что схему роя трогают и ЧИТАЮЩИЕ команды (`myc report models`,
 * `myc attempt list`, `myc close` без вердикта). Без него каждое такое
 * чтение открывало бы BEGIN IMMEDIATE — блокировку записи на ровном месте,
 * прямо в бюджете записи И1. Расхождение любого рода возвращает false, и
 * дальше работает медленный путь со всеми его проверками.
 */
function alreadyApplied(db: Database, sorted: readonly SwarmMigration[]): boolean {
  const present = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
    .get(BOOKKEEPING_TABLE);
  if (present === null) return false;
  const applied = new Map<number, string>(
    (
      db.query(`SELECT version, checksum FROM ${BOOKKEEPING_TABLE}`).all() as AppliedRow[]
    ).map((r) => [r.version, r.checksum]),
  );
  if (applied.size !== sorted.length) return false;
  return sorted.every((m) => applied.get(m.version) === checksum(migrationText(m)));
}

export function ensureSwarmSchema(
  db: Database,
  migrations: readonly SwarmMigration[] = swarmMigrations,
): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const maxKnown = sorted.reduce((m, mig) => Math.max(m, mig.version), 0);
  if (alreadyApplied(db, sorted)) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(BOOKKEEPING_DDL);
    const applied = new Map<number, string>(
      (
        db
          .query(`SELECT version, checksum FROM ${BOOKKEEPING_TABLE}`)
          .all() as AppliedRow[]
      ).map((r) => [r.version, r.checksum]),
    );

    for (const version of applied.keys()) {
      if (version > maxKnown) {
        throw new SwarmSchemaError(
          "schema.newer",
          `database is newer than the swarm schema version this binary knows: ${version} > ${maxKnown}`,
        );
      }
    }

    const now = Date.now();
    for (const migration of sorted) {
      const appliedChecksum = applied.get(migration.version);
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== checksum(migrationText(migration))) {
          throw new SwarmSchemaError(
            "schema.checksum",
            `migration ${migration.version} (${migration.name}) changed after it was applied`,
          );
        }
        continue;
      }

      for (const statement of migrationStatements(migration)) db.exec(statement);
      const present = new Set(
        (
          db.query("SELECT name FROM sqlite_master").all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      const missing = migration.objects.filter((name) => !present.has(name));
      if (missing.length > 0) {
        throw new SwarmSchemaError(
          "schema.objects",
          `objects not created after applying ${migration.name}: ${missing.join(", ")}`,
        );
      }
      db.query(
        `INSERT INTO ${BOOKKEEPING_TABLE} (version, name, checksum, applied_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).run(migration.version, migration.name, checksum(migrationText(migration)), now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
