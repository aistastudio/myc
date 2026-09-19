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
  /**
   * Миграция СОВМЕСТИМА: бинарь, знающий схему `readableFrom`, продолжает
   * работать с базой после неё, самой миграции не зная. Такая миграция
   * учитывается в {@link COMPAT_MIGRATIONS_TABLE}, а не в schema_migrations,
   * — см. там, почему это единственный способ не сломать уже выпущенные
   * бинари. Все миграции между `readableFrom` и этой обязаны быть
   * совместимыми тоже: несовместимая между ними подняла бы schema_migrations
   * выше `readableFrom`, и обещание стало бы ложью (сверка в migrate).
   */
  readonly readableFrom?: number;
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
  /** null — запись schema_migrations; число — совместимая, см. Migration.readableFrom. */
  readonly readableFrom: number | null;
}

/**
 * Таблица учёта СОВМЕСТИМЫХ миграций базового набора (memory-gemeb3d8wj41).
 *
 * ЗАЧЕМ ВТОРАЯ ТАБЛИЦА. Выпущенный бинарь отказывает базе по одному правилу:
 * `max(version)` в schema_migrations больше известного ему (schema.newer
 * ниже). Правило верное — незнакомая схема может значить что угодно, — но
 * оно не различает «добавили колонку, которую старый код не видит» и
 * «переписали таблицу». Миграция 13 — первое: колонка с DEFAULT и индекс,
 * о которых старый код не знает и которых не касается. Запиши её в
 * schema_migrations — и каждый уже выпущенный бинарь на этой машине (агент
 * в соседней сессии, хук, MCP-сервер, запущенный до обновления) встанет с
 * precond.schema. Уже выпущенный код не поменять; поменять можно только то,
 * что он читает. Поэтому совместимая миграция пишется сюда, schema_migrations
 * остаётся на последней несовместимой, и старый бинарь видит знакомую ему
 * схему — ровно ту, с которой умеет работать.
 *
 * ЧТО ОБЕЩАЕТ `readable_from`. Число — схема, которую бинарь обязан знать,
 * чтобы работать с базой после этой миграции. Бинарь, читающий эту таблицу
 * (с 0.3.14), сверяет по нему незнакомые ему совместимые миграции будущих
 * версий: отказ только когда их `readable_from` выше известного ему.
 *
 * Версия схемы базы — максимум по ОБЕИМ таблицам ({@link appliedSchemaVersion});
 * порядок наката и сверка checksum общие.
 */
export const COMPAT_MIGRATIONS_TABLE = "schema_migrations_compat";

const COMPAT_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS ${COMPAT_MIGRATIONS_TABLE} (
       version       INTEGER PRIMARY KEY,
       name          TEXT    NOT NULL,
       checksum      TEXT    NOT NULL,
       applied_at    INTEGER NOT NULL,
       readable_from INTEGER NOT NULL
     )`;

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name) !== null;
}

/**
 * Версия схемы базы: максимум по schema_migrations и таблице совместимых
 * миграций. `null` — ни одной записи учёта (схема не накатывалась). Этим, а
 * не `max(version) FROM schema_migrations`, обязан читать версию всякий, кто
 * сравнивает её с известной бинарю: иначе база после совместимой миграции
 * казалась бы вечно отстающей.
 */
export function appliedSchemaVersion(db: Database): number | null {
  let base: number | null = null;
  try {
    base = (db.query("SELECT max(version) AS v FROM schema_migrations").get() as { v: number | null } | null)?.v ?? null;
  } catch {
    return null; // таблицы учёта нет — схема не накатывалась вовсе
  }
  if (!hasTable(db, COMPAT_MIGRATIONS_TABLE)) return base;
  const compat =
    (db.query(`SELECT max(version) AS v FROM ${COMPAT_MIGRATIONS_TABLE}`).get() as { v: number | null } | null)?.v ??
    null;
  return compat === null ? base : Math.max(base ?? 0, compat);
}

/**
 * Все записи учёта базового набора по обеим таблицам — для doctor. `null` —
 * таблицы schema_migrations нет (схема не накатывалась).
 */
export function readSchemaLedger(db: Database): MigrationRecord[] | null {
  if (!hasTable(db, "schema_migrations")) return null;
  return readAppliedMigrations(db);
}

/**
 * Тот же ответ для поверхностей со своим драйвером (web, сервер): текст
 * запроса версии по тому, есть ли в базе таблица совместимых миграций.
 */
export function schemaVersionSql(hasCompatTable: boolean): string {
  return hasCompatTable
    ? `SELECT max(v) AS v FROM (SELECT max(version) AS v FROM schema_migrations
                                UNION ALL SELECT max(version) FROM ${COMPAT_MIGRATIONS_TABLE})`
    : "SELECT max(version) AS v FROM schema_migrations";
}

/**
 * Сверка набора: совместимая миграция обещает, что бинарь, знающий
 * `readableFrom`, базу откроет, — значит всё между `readableFrom` и ею
 * тоже совместимо. Ошибка здесь — ошибка сборки, а не данных.
 */
function checkCompatChain(known: readonly Migration[]): void {
  for (const m of known) {
    if (m.readableFrom === undefined) continue;
    if (!(m.readableFrom < m.version)) {
      throw new Error(`migration ${m.version} '${m.name}': readableFrom ${m.readableFrom} must be below its version`);
    }
    const breaking = known.find(
      (x) => x.version > m.readableFrom! && x.version < m.version && x.readableFrom === undefined,
    );
    if (breaking !== undefined) {
      throw new Error(
        `migration ${m.version} '${m.name}': readableFrom ${m.readableFrom} is a lie — ` +
          `migration ${breaking.version} between them is not compatible`,
      );
    }
  }
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
  const compat = hasTable(db, COMPAT_MIGRATIONS_TABLE);
  const rows = db
    .query(
      "SELECT version, name, checksum, applied_at, NULL AS readable_from FROM schema_migrations" +
        (compat
          ? ` UNION ALL SELECT version, name, checksum, applied_at, readable_from FROM ${COMPAT_MIGRATIONS_TABLE}`
          : "") +
        " ORDER BY version ASC",
    )
    .all() as Array<{
    version: number;
    name: string;
    checksum: string;
    applied_at: number;
    readable_from: number | null;
  }>;
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
    readableFrom: r.readable_from,
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
 *   - schema.newer    — в БД есть незнакомая бинарю миграция, и она либо
 *                       несовместима, либо совместима только со схемой новее
 *                       известной бинарю (COMPAT_MIGRATIONS_TABLE)
 *   - schema.checksum — checksum применённой миграции разошёлся с текстом в бинаре
 *   - schema.pending   — есть неприменённые миграции и открытие только на чтение
 */
export async function migrate(
  db: Database,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const degraded: string[] = [];
  const known = [...options.migrations].sort((a, b) => a.version - b.version);
  checkCompatChain(known);
  const maxKnown = known.reduce((m, mig) => Math.max(m, mig.version), 0);
  const byVersion = new Map(known.map((m) => [m.version, m]));

  ensureMigrationsTable(db);
  const applied = readAppliedMigrations(db);
  const maxApplied = applied.reduce((m, r) => Math.max(m, r.version), 0);
  // Незнакомая бинарю миграция мешает, только если она несовместима или
  // обещает совместимость со схемой новее той, что бинарь знает.
  const blocking = applied.filter(
    (r) => r.version > maxKnown && (r.readableFrom === null || r.readableFrom > maxKnown),
  );

  const skewIgnored = options.ignoreSchemaSkew ?? readIgnoreSchemaSkewEnv();
  if (blocking.length > 0) {
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

  // memory-yc7np0eyy2s0: список pending выше прочитан БЕЗ блокировки. Два
  // процесса на свежей базе (два агента стартуют разом) оба видят пустой
  // schema_migrations и оба решают накатывать с первой миграции; второй ждёт
  // write-lock первого и, дождавшись, накатывал бы миграцию повторно —
  // «table … already exists», мимо регэкспа ретрая /locked|busy/ у вызывающих.
  // Решение принимается там же, где пишется: под BEGIN IMMEDIATE версия
  // перечитывается, и накатанная соседом пропускается (с той же сверкой
  // checksum, что и для применённых раньше).
  const appliedNow: number[] = [];
  for (const migration of pending) {
    const checksum = await sha256Hex(migration.sql);
    const compat = migration.readableFrom !== undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (compat) db.exec(COMPAT_MIGRATIONS_DDL);
      // Сосед мог записать её в любую из двух таблиц: сборка, где эта
      // миграция ещё не была совместимой, писала в schema_migrations.
      const done = db
        .query(
          "SELECT checksum FROM schema_migrations WHERE version = ?1" +
            (compat || hasTable(db, COMPAT_MIGRATIONS_TABLE)
              ? ` UNION ALL SELECT checksum FROM ${COMPAT_MIGRATIONS_TABLE} WHERE version = ?1`
              : ""),
        )
        .get(migration.version) as { checksum: string } | null;
      if (done !== null) {
        if (done.checksum !== checksum) {
          throw new SchemaError(
            "schema.checksum",
            `migration ${migration.version} changed after it was applied — the database and the binary diverged. ` +
              "`myc doctor --schema` shows the difference.",
          );
        }
        db.exec("COMMIT");
        continue;
      }
      applyMigrationStatementByStatement(db, migration);
      if (compat) {
        db.query(
          `INSERT INTO ${COMPAT_MIGRATIONS_TABLE} (version, name, checksum, applied_at, readable_from) VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).run(migration.version, migration.name, checksum, Date.now(), migration.readableFrom!);
      } else {
        db.query(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
        ).run(migration.version, migration.name, checksum, Date.now());
      }
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
