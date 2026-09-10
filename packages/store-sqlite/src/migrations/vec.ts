import type { Database } from "bun:sqlite";
import { SchemaError, SCHEMA_UPGRADE_HINT, type Migration } from "../migrate.ts";
import { vecMigration001Init } from "./vec-001-init.ts";
import { vecMigration002RerankF32 } from "./vec-002-rerank-f32.ts";
import { vecMigration003RerankF32LruIndex } from "./vec-003-rerank-f32-lru-index.ts";
import { vecMigration004EmbedMeta } from "./vec-004-embed-meta.ts";

/**
 * Учёт векторных миграций ведётся отдельно от schema_migrations (решение S26,
 * ARCHITECTURE.md §10): обычные миграции сверяются по checksum и обязаны быть
 * детерминированными, поэтому условное создание объектов в них ломает саму
 * идею. Векторный набор применяется только когда рантайм сообщил, что vec0
 * загружен; без расширения база полноценна — теряется только векторный поиск.
 */
export const VEC_MIGRATIONS_TABLE = "schema_migrations_vec";

/** Векторный набор миграций. Порядок значения не имеет — сортируется внутри. */
export const vectorMigrations: readonly Migration[] = [
  vecMigration001Init,
  vecMigration002RerankF32,
  vecMigration003RerankF32LruIndex,
  vecMigration004EmbedMeta,
];

/** Машинный код деградации для meta.degraded[] всех поверхностей (инвариант И2). */
export const VEC_DEGRADED_UNAVAILABLE =
  "vector.unavailable: the sqlite-vec extension (vec0) is not loaded — vector search is off, " +
  "the other surfaces work";

export interface VectorMigrateOptions {
  /** Загружен ли vec0. Факт от рантайма, а не догадка этого модуля. */
  readonly vec0Loaded: boolean;
  /** true — открытие на запись (автоприменение); false — только чтение. */
  readonly writable: boolean;
  /** Подмена набора (тесты). По умолчанию {@link vectorMigrations}. */
  readonly migrations?: readonly Migration[];
}

export interface VectorMigrateResult {
  readonly appliedVersions: readonly number[];
  readonly pendingVersions: readonly number[];
  /** true — набор не применялся вовсе, потому что vec0 недоступен. */
  readonly skipped: boolean;
  readonly degraded: readonly string[];
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ensureVecMigrationsTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${VEC_MIGRATIONS_TABLE} (
       version    INTEGER PRIMARY KEY,
       name       TEXT    NOT NULL,
       checksum   TEXT    NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
}

function readApplied(db: Database): Array<{ version: number; checksum: string }> {
  return db
    .query(`SELECT version, checksum FROM ${VEC_MIGRATIONS_TABLE} ORDER BY version ASC`)
    .all() as Array<{ version: number; checksum: string }>;
}

function assertObjectsPresent(db: Database, migration: Migration): void {
  const present = new Set(
    (db.query("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const missing = migration.objects.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `vec migration ${migration.version} '${migration.name}': objects not created after applying: ${missing.join(", ")} ` +
        "(bun:sqlite silently skips CREATE VIRTUAL TABLE with an unknown module — see docs/design/01a-ddl-validation.md §7)",
    );
  }
}

/**
 * Накат векторного набора. Зеркалит guard из {@link migrate}, но по своей
 * таблице учёта и с одним дополнительным исходом — «пропущено, vec0 нет».
 *
 * Отказные случаи те же (exit=PRECOND(5), решение S24):
 *   - schema.newer    — в БД векторная версия старше известной бинарю
 *   - schema.checksum — текст применённой миграции разошёлся с бинарём
 *   - schema.pending  — есть неприменённые и открытие только на чтение
 *
 * `ignoreSchemaSkew` здесь намеренно нет: векторный индекс — производная,
 * его всегда можно пересобрать, поэтому аварийный обход не нужен.
 *
 * НЕ АТОМАРНА ОТНОСИТЕЛЬНО ДРУГИХ ПРОЦЕССОВ — это контракт, а не оплошность.
 * Накат идёт без BEGIN (см. комментарий у db.exec ниже), поэтому чтение
 * таблицы учёта и создание объектов разнесены во времени: два процесса,
 * открывшие свежую базу одновременно, оба увидят «набор не применён», и
 * проигравший получит `table nodes_vec already exists`. Это не гипотеза —
 * замер на CLI после S45 (myc-ye3.8): 15 отказов на 36 одновременных
 * `recall`. Ждать и перечитывать обязан ВЫЗЫВАЮЩИЙ, там же, где он уже ждёт
 * чужой write-lock при открытии (packages/cli/src/commands/store.ts,
 * ensureVectorSchema). Следующая поверхность, которая позовёт этот набор
 * (MCP — myc-6lc), обязана сделать то же самое.
 */
export async function migrateVectors(
  db: Database,
  options: VectorMigrateOptions,
): Promise<VectorMigrateResult> {
  if (!options.vec0Loaded) {
    // Ни одного оператора, включая таблицу учёта: база без расширения не
    // должна отличаться от базы, которая о векторах не знает (S26).
    return {
      appliedVersions: [],
      pendingVersions: [],
      skipped: true,
      degraded: [VEC_DEGRADED_UNAVAILABLE],
    };
  }

  const known = [...(options.migrations ?? vectorMigrations)].sort(
    (a, b) => a.version - b.version,
  );
  const maxKnown = known.reduce((m, mig) => Math.max(m, mig.version), 0);
  const byVersion = new Map(known.map((m) => [m.version, m]));

  ensureVecMigrationsTable(db);
  const applied = readApplied(db);
  const maxApplied = applied.reduce((m, r) => Math.max(m, r.version), 0);

  if (maxApplied > maxKnown) {
    throw new SchemaError(
      "schema.newer",
      `the database vector schema (${maxApplied}) is newer than this binary knows (${maxKnown}). ` +
        SCHEMA_UPGRADE_HINT,
    );
  }

  for (const record of applied) {
    const migration = byVersion.get(record.version);
    if (migration === undefined) continue;
    if ((await sha256Hex(migration.sql)) !== record.checksum) {
      throw new SchemaError(
        "schema.checksum",
        `vector migration ${record.version} changed after it was applied — the database and the binary diverged. ` +
          "`myc doctor --schema` shows the difference.",
      );
    }
  }

  const appliedSet = new Set(applied.map((r) => r.version));
  const pending = known.filter((m) => !appliedSet.has(m.version));

  if (pending.length === 0) {
    return { appliedVersions: [], pendingVersions: [], skipped: false, degraded: [] };
  }
  if (!options.writable) {
    return {
      appliedVersions: [],
      pendingVersions: pending.map((m) => m.version),
      skipped: false,
      degraded: [],
    };
  }

  const appliedNow: number[] = [];
  for (const migration of pending) {
    const checksum = await sha256Hex(migration.sql);
    // Без BEGIN: vec0 создаёт свои shadow-таблицы, а откат CREATE VIRTUAL TABLE
    // внутри явной транзакции движок расширения не гарантирует. Набор из одного
    // оператора на миграцию делает транзакцию ненужной — либо объект создан,
    // либо exec бросил.
    db.exec(migration.sql);
    assertObjectsPresent(db, migration);
    db.query(
      `INSERT INTO ${VEC_MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)`,
    ).run(migration.version, migration.name, checksum, Date.now());
    appliedNow.push(migration.version);
  }

  return {
    appliedVersions: appliedNow,
    pendingVersions: [],
    skipped: false,
    degraded: [],
  };
}
