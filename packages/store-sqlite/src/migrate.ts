import { Database } from "bun:sqlite";

// Коды выхода — источник истины packages/cli/src/exit.ts (§2.2
// docs/design/03-interfaces-and-integration.md). store-sqlite не может
// зависеть от CLI-пакета (см. scripts/deps-check.ts), поэтому значение
// PRECOND продублировано как константа.
const EXIT_PRECOND = 5;

/**
 * Одна миграция. `sql` наносится пооператорно (см. §7
 * docs/design/01a-ddl-validation.md — bun:sqlite молча пропускает
 * CREATE VIRTUAL TABLE с неизвестным модулем внутри Database.exec()).
 * `objects` перечисляет имена, которые обязаны появиться в sqlite_master
 * после наката — используется для сверки.
 */
/**
 * Что делать, когда база записана более новой версией myc.
 *
 * ЗДЕСЬ БЫЛ СОВЕТ `myc self-update`, И ТАКОЙ КОМАНДЫ НЕ СУЩЕСТВУЕТ. Сообщение
 * печаталось ровно в тот момент, когда человеку уже плохо: база не
 * открывается, работа стоит, — и советовало команду, которая отвечает
 * «unknown command 'self-update'» и предлагает вместо себя `model update`.
 * Совет, который не выполняется, хуже отсутствия совета: он тратит попытку и
 * подрывает доверие к остальному тексту.
 *
 * ПОЧЕМУ КОМАНДУ НЕ ЗАВЕЛИ, А СОВЕТ ЗАМЕНИЛИ. Самообновление здесь не
 * недоделка, а решение (см. докстрок packages/cli/src/update-check.ts, п. 3):
 * подмена бинаря под работающим агентом — смена поведения посреди сессии,
 * аренда задачи взята одной версией, а снимать её будет другая, и между ними
 * лежит ровно та миграция схемы, из-за которой это сообщение и печатается.
 * Поэтому печатается точная команда пакетного менеджера — та же, что и в
 * `myc version`, и она сверяется с ней тестом.
 *
 * Второй командой назван `myc version --check`: она честно скажет, есть ли в
 * реестре версия новее вашей, — потому что «обновитесь» бесполезно, когда
 * обновляться некуда, а сборка собрана из исходников и уже новее published.
 */
export const SCHEMA_UPGRADE_HINT =
  "Update the binary: `bun install -g @aistastudio/myc` " +
  "(`myc version --check` shows what exactly is published).";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly objects: readonly string[];
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

export type SchemaErrorCode = "schema.newer" | "schema.checksum" | "schema.pending";

export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly exit = EXIT_PRECOND;

  constructor(code: SchemaErrorCode, message: string) {
    super(message);
    this.name = "SchemaError";
    this.code = code;
  }
}

export interface MigrateOptions {
  /** Известные бинарю миграции, отсортированные или нет — сортируются внутри. */
  readonly migrations: readonly Migration[];
  /** true — открытие на запись (автоприменение); false — только чтение. */
  readonly writable: boolean;
  /**
   * Аварийный обход. Пропускает проверку "БД новее бинаря", НЕ пропускает
   * проверку checksum. По умолчанию читается из MYC_IGNORE_SCHEMA_SKEW=1
   * ({@link readIgnoreSchemaSkewEnv}) — передайте явно, чтобы отвязаться от
   * окружения (например в тестах).
   */
  readonly ignoreSchemaSkew?: boolean;
}

/** MYC_IGNORE_SCHEMA_SKEW=1 — единственное принимаемое значение обхода. */
export function readIgnoreSchemaSkewEnv(): boolean {
  return process.env.MYC_IGNORE_SCHEMA_SKEW === "1";
}

export interface MigrateResult {
  readonly appliedVersions: readonly number[];
  readonly pendingVersions: readonly number[];
  readonly degraded: readonly string[];
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ensureMigrationsTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT    NOT NULL,
       checksum   TEXT    NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
}

function readAppliedMigrations(db: Database): MigrationRecord[] {
  const rows = db
    .query(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
    )
    .all() as Array<{
    version: number;
    name: string;
    checksum: string;
    applied_at: number;
  }>;
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

/**
 * Разбор на операторы. Точка с запятой внутри тела триггера
 * (`CREATE TRIGGER ... BEGIN ...; ...; END;`) оператор НЕ завершает — иначе
 * триггер режется пополам и накат падает с `incomplete input`. Глубина тела
 * считается по ключевым словам: `BEGIN` после `CREATE TRIGGER` открывает тело,
 * `CASE` внутри тела углубляет, `END` закрывает — так `CASE ... END` в теле
 * не принимается за его конец.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = sql.length;
  let start = 0;
  let sawCreateTrigger = false;
  let bodyDepth = 0;
  const isWordChar = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  while (i < n) {
    const c = sql[i]!;
    if (/[A-Za-z_]/.test(c) && !isWordChar(sql[i - 1])) {
      let j = i;
      while (j < n && isWordChar(sql[j])) j++;
      const word = sql.slice(i, j).toUpperCase();
      if (word === "TRIGGER") sawCreateTrigger = true;
      else if (word === "BEGIN" && sawCreateTrigger && bodyDepth === 0) bodyDepth = 1;
      else if (word === "CASE" && bodyDepth > 0) bodyDepth++;
      else if (word === "END" && bodyDepth > 0) bodyDepth--;
      i = j;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === ";" && bodyDepth === 0) {
      const stmt = sql.slice(start, i).trim();
      if (stmt.length > 0) out.push(stmt);
      i++;
      start = i;
      sawCreateTrigger = false;
      continue;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

function sqliteMasterNames(db: Database): Set<string> {
  const rows = db.query("SELECT name FROM sqlite_master").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function applyMigrationStatementByStatement(db: Database, migration: Migration): void {
  const statements = splitStatements(migration.sql);
  for (const stmt of statements) {
    db.exec(stmt);
  }
  const present = sqliteMasterNames(db);
  const missing = migration.objects.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `migration ${migration.version} '${migration.name}': objects not created after applying: ${missing.join(", ")} ` +
        `(bun:sqlite silently skips CREATE VIRTUAL TABLE with an unknown module — see docs/design/01a-ddl-validation.md §7)`,
    );
  }
}

/**
 * GUARD версии схемы + forward-only накат миграций.
 * Три отказных случая (docs/design/03-interfaces-and-integration.md §2.2,
 * exit=PRECOND(5)):
 *   - schema.newer    — max(version) в БД больше максимально известной бинарю
 *   - schema.checksum — checksum применённой миграции разошёлся с текстом в бинаре
 *   - schema.pending   — есть неприменённые миграции и открытие только на чтение
 */
export async function migrate(
  db: Database,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const degraded: string[] = [];
  const known = [...options.migrations].sort((a, b) => a.version - b.version);
  const maxKnown = known.reduce((m, mig) => Math.max(m, mig.version), 0);
  const byVersion = new Map(known.map((m) => [m.version, m]));

  ensureMigrationsTable(db);
  const applied = readAppliedMigrations(db);
  const maxApplied = applied.reduce((m, r) => Math.max(m, r.version), 0);

  const skewIgnored = options.ignoreSchemaSkew ?? readIgnoreSchemaSkewEnv();
  if (maxApplied > maxKnown) {
    if (!skewIgnored) {
      throw new SchemaError(
        "schema.newer",
        `the database was written by a newer myc (schema ${maxApplied}, this binary knows ${maxKnown}). ` +
          `${SCHEMA_UPGRADE_HINT} Schema downgrade is not supported.`,
      );
    }
    degraded.push(
      `schema.newer: the database schema (${maxApplied}) is newer than this binary knows (${maxKnown}) — ` +
        "check skipped via MYC_IGNORE_SCHEMA_SKEW=1",
    );
  }

  for (const record of applied) {
    const migration = byVersion.get(record.version);
    // Может отсутствовать, если сама миграция моложе бинаря (уже покрыто
    // проверкой schema.newer выше) — тогда сверять нечего.
    if (migration === undefined) continue;
    const checksum = await sha256Hex(migration.sql);
    if (checksum !== record.checksum) {
      throw new SchemaError(
        "schema.checksum",
        `migration ${record.version} changed after it was applied — the database and the binary diverged. ` +
          "`myc doctor --schema` shows the difference.",
      );
    }
  }

  const appliedVersions = new Set(applied.map((r) => r.version));
  const pending = known.filter((m) => !appliedVersions.has(m.version));

  if (pending.length === 0) {
    return { appliedVersions: [], pendingVersions: [], degraded };
  }

  if (!options.writable) {
    return {
      appliedVersions: [],
      pendingVersions: pending.map((m) => m.version),
      degraded,
    };
  }

  const appliedNow: number[] = [];
  for (const migration of pending) {
    const checksum = await sha256Hex(migration.sql);
    db.exec("BEGIN IMMEDIATE");
    try {
      applyMigrationStatementByStatement(db, migration);
      db.query(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
      ).run(migration.version, migration.name, checksum, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // соединение уже развалилось — транзакция и так отменена
      }
      throw error;
    }
    appliedNow.push(migration.version);
  }

  return { appliedVersions: appliedNow, pendingVersions: [], degraded };
}
