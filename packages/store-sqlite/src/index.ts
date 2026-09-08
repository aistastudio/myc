import { Database, type Statement } from "bun:sqlite";
import { applySqliteRuntime, ensureSqliteRuntime } from "./runtime.ts";
import {
  createWalGuard,
  type WalGuard,
  type WalGuardOptions,
  type WalGuardStats,
} from "./checkpoint.ts";
import {
  StatementCache,
  resolveQueryText,
  type DbDriver,
  type QueryDef,
  type TxMode,
  type SCHEMA_VERSION,
} from "@myc/core";

// PRAGMA (при каждом открытии) — docs/design/01-core-data-model.md §8.1.0
//
// Единственный источник этого списка (решение S43, myc-ahy): любой путь
// открытия базы — этот файл или CLI-драйвер в packages/cli/src/commands/store.ts —
// обязан применять ровно STORE_PRAGMAS и подключать createWalGuard. Пути имеют
// право отличаться только тем, ради чего разделились изначально — загрузкой
// рантайма расширений (ensureSqliteRuntime/applySqliteRuntime, только здесь).
export const STORE_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA cache_size = -65536",
  "PRAGMA mmap_size = 268435456",
  "PRAGMA temp_store = MEMORY",
  // Авточекпойнт выключен: синхронный checkpoint при synchronous=NORMAL делает
  // fsync основного файла и съедает весь бюджет записи (решение S35, myc-443).
  // Работу забрал класс `compact` очереди `jobs`, а от неограниченного роста
  // WAL страхует предохранитель в ./checkpoint.ts.
  "PRAGMA wal_autocheckpoint = 0",
  // Без усечения файл WAL переиспользуется и его размер навсегда залипает на
  // достигнутом максимуме — именно поэтому дефект и не был виден по размеру.
  // С нулевым лимитом размер файла = живой WAL, и предохранителю есть что мерить.
  "PRAGMA journal_size_limit = 0",
  "PRAGMA analysis_limit = 400",
  "PRAGMA trusted_schema = OFF",
] as const;

export type SqliteStore = {
  readonly dialect: "sqlite";
  readonly schemaVersion: typeof SCHEMA_VERSION;
};

export interface SqliteOpenOptions {
  readonly path: string;
  /** Пороги предохранителя WAL; по умолчанию — потолок из ./checkpoint.ts. */
  readonly wal?: WalGuardOptions;
}

export interface SqliteDriverStats {
  readonly prepares: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly cacheSize: number;
}

export interface SqliteDriver extends DbDriver {
  readonly dialect: "sqlite";
  readonly database: Database;
  /** Предохранитель роста WAL и фоновый checkpoint (решение S35). */
  readonly wal: WalGuard;
  stats(): SqliteDriverStats;
  walStats(): WalGuardStats;
  close(): void;
}

export function openSqlite(options: SqliteOpenOptions | string): SqliteDriver {
  const path = typeof options === "string" ? options : options.path;
  const walOptions = typeof options === "string" ? undefined : options.wal;
  // setCustomSQLite обязан выполниться до первого new Database в процессе —
  // включая соединения, которые открывают тесты (docs/design/01a-ddl-validation.md, К.1).
  ensureSqliteRuntime();
  const db = new Database(path, { create: true });
  try {
    applySqliteRuntime(db);
    for (const pragma of STORE_PRAGMAS) db.exec(pragma);
  } catch (error) {
    db.close();
    throw error;
  }

  const wal = createWalGuard(db, walOptions);
  const cache = new StatementCache<Statement>(64);
  let prepares = 0;

  const prepareStatement = (query: QueryDef): Statement => {
    const key = `${query.name}|sqlite`;
    let stmt = cache.get(key);
    if (stmt === undefined) {
      prepares++;
      stmt = db.prepare(resolveQueryText(query, "sqlite"));
      cache.set(key, stmt);
    }
    return stmt;
  };

  const checkArity = (query: QueryDef, params: readonly unknown[]): void => {
    if (params.length !== query.params.length) {
      throw new Error(
        `query '${query.name}': expected ${query.params.length} params, got ${params.length}`,
      );
    }
  };

  let txDepth = 0;

  const driver: SqliteDriver = {
    dialect: "sqlite",
    database: db,
    wal,

    one<T>(query: QueryDef, params: readonly unknown[]): T | undefined {
      checkArity(query, params);
      const row = prepareStatement(query).get(...params);
      return (row === null ? undefined : row) as T | undefined;
    },

    all<T>(query: QueryDef, params: readonly unknown[]): T[] {
      checkArity(query, params);
      return prepareStatement(query).all(...params) as T[];
    },

    run(query: QueryDef, params: readonly unknown[]): { changes: number } {
      checkArity(query, params);
      const result = prepareStatement(query).run(...params);
      // Внутри транзакции коммита ещё не было — WAL проверяем только на выходе.
      if (txDepth === 0) wal.afterCommit();
      return { changes: Number(result.changes) };
    },

    tx<T>(mode: TxMode, fn: (tx: DbDriver) => T): T {
      if (txDepth > 0) {
        throw new Error("nested transactions are not supported");
      }
      txDepth++;
      db.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const out = fn(driver);
        db.exec("COMMIT");
        wal.afterCommit();
        return out;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // connection-level failure already unwound the transaction
        }
        throw error;
      } finally {
        txDepth--;
      }
    },

    walStats(): WalGuardStats {
      return wal.stats();
    },

    stats(): SqliteDriverStats {
      return {
        prepares,
        hits: cache.hits,
        misses: cache.misses,
        evictions: cache.evictions,
        cacheSize: cache.size,
      };
    },

    close(): void {
      cache.clear();
      db.close();
    },
  };

  return driver;
}

// Наборы миграций (myc-u94). Базовый набор — вся схема §8.1 версией 1;
// векторные объекты вынесены в отдельный набор со своей таблицей учёта
// (решение S26) и применяются только при загруженном vec0.
export {
  createWalGuard,
  dropWalCheckpointJob,
  enqueueWalCheckpointJob,
  runWalCheckpointJob,
  walCheckpoint,
  walCheckpointJobPending,
  walPath,
  walSizeBytes,
  COMPACT_JOB_KIND,
  WAL_HARD_LIMIT_BYTES,
  WAL_JOB_ENTITY,
  WAL_JOB_PRIORITY,
  WAL_REARM_BYTES,
  WAL_SOFT_LIMIT_BYTES,
  type CheckpointMode,
  type CheckpointResult,
  type WalGuard,
  type WalGuardOptions,
  type WalGuardStats,
} from "./checkpoint.ts";

// Рантайм расширений — публично, потому что его поднимает не только этот
// файл. Лёгкие драйверы поверхностей (CLI, MCP) открывают базу без него по
// умолчанию (решение S43), но обязаны уметь поднять его ПО ПОТРЕБНОСТИ
// КОМАНДЫ: без этого векторная ветка недостижима с основной поверхности
// (решение S45, myc-ye3.8). Порядок вызова прежний и обязателен:
// ensureSqliteRuntime() до первого `new Database` в процессе,
// applySqliteRuntime(db) после каждого открытия соединения.
export {
  ensureSqliteRuntime,
  applySqliteRuntime,
  getSqliteRuntimeState,
  type SqliteRuntimeState,
  type SqliteRuntimeOptions,
  type SqliteRuntimeSource,
  type SqliteRuntimeCandidate,
} from "./runtime.ts";

export { migrations, migration001Init, vecMigration001Init } from "./migrations/index.ts";
export {
  migrateVectors,
  vectorMigrations,
  VEC_MIGRATIONS_TABLE,
  VEC_DEGRADED_UNAVAILABLE,
  type VectorMigrateOptions,
  type VectorMigrateResult,
} from "./migrations/index.ts";

// Публичный API графа и claim для поверхностей (cli/mcp/server).
// Чистый реэкспорт — движок и его поведение живут в queries.ts/claim.ts.
export { GraphStore, Q, LEASE_TTL_MS, LEASE_RENEW_MS } from "./queries.ts";
export type {
  GraphStoreOptions,
  ClaimReceipt,
  NodeLease,
} from "./queries.ts";
// Общая очередь фоновых работ поверх таблицы `jobs` (решение S7). Экспорт
// пространством имён: `enqueue`/`claim`/`complete`/`fail`/`sweep`/`stats` —
// имена, которые в плоском корне пакета столкнулись бы с чем угодно.
export * as jobs from "./jobs.ts";
export { Claims, ClaimTicket } from "./claim.ts";
export type { ClaimsOptions } from "./claim.ts";
export { migrate, SchemaError, SCHEMA_UPGRADE_HINT } from "./migrate.ts";
export type { MigrateOptions, MigrateResult } from "./migrate.ts";

// Обмен через git (решение S42): в git только оплог, проекции — локальный кеш.
export {
  exportGraph,
  writeProjectionCache,
  renderOplogFiles,
  renderProjectionFiles,
  renderMeta,
  readOplogFiles,
  writeGraphFiles,
  unionOplogText,
  OplogCollisionError,
  rowToLine,
  lineToRow,
  splitOpId,
  oplogFilePath,
  oplogBucket,
  projectionBucket,
  isOplogPath,
  isProjectionFile,
  canonicalJson,
  fileSize,
  OPLOG_FILE_OPS,
  GRAPH_FORMAT,
  OPLOG_DIR,
  META_FILE,
  GITATTRIBUTES,
  GITATTRIBUTES_FILE,
  GITIGNORE_FILE,
  PROJECTION_CACHE_DIR,
  PROJECTION_CACHE_GITIGNORE,
  OPLOG_MERGE_DRIVER,
  REPLICATED_OPS,
  type ExportResult,
  type ProjectionCacheResult,
  type GraphFiles,
  type OplogLine,
  type WriteResult,
} from "./export.ts";
export {
  importGraph,
  importOplogRows,
  parseOplogFiles,
  defaultCacheDir,
  type ImportOptions,
  type ImportResult,
} from "./import.ts";
// Переезд задачи между воркспейсами (R4): перенос идентичности и оплога,
// а не копия. Отказы (аренда, blocks через границу) — часть движка, а не CLI.
export {
  planMove,
  executeMove,
  moveNeighbors,
  strandedArrivals,
  MOVE_CHAIN_LIMIT,
  QMV,
  type MovePlan,
  type MoveRefusal,
  type MoveRefusalCode,
  type MoveResult,
  type MoveBreakpoint,
  type PlanOptions as MovePlanOptions,
  type ExecuteOptions as MoveExecuteOptions,
} from "./move.ts";
export {
  mergeOplogText,
  parseMergeDriverArgs,
  runMergeDriver,
  type MergeDriverArgs,
  type MergeDriverRun,
  type MergeOutcome,
  type MergeRefusal,
} from "./merge-driver.ts";
// Идентичность реплики привязана к физическому экземпляру базы (решение S65).
// `ensureSiteId` — единственная форма подключения: все пути открытия базы
// (cli/commands/store.ts, cli/drain.ts, cli/commands/init.ts, mcp/store.ts)
// решают вопрос про `site_id` через неё, и полноту этого стережёт
// ./site-identity.wiring.test.ts.
export {
  databaseMeta,
  decideSiteId,
  driverMeta,
  ensureSiteId,
  machineId,
  mintSiteId,
  observeInstance,
  parseInstance,
  renderInstance,
  sameInstance,
  META_LAST_SEQ,
  META_SITE_ID,
  META_SITE_INSTANCE,
  META_SITE_PREV,
  type EnsureSiteIdOptions,
  type EnsureSiteIdResult,
  type SiteIdDecision,
  type SiteIdInput,
  type SiteIdOrigin,
  type SiteInstance,
  type SiteMetaIo,
} from "./site-identity.ts";
export {
  ClosureError,
  MAX_PARENT_DEPTH,
  applyRebuild,
  dumpParentClosure,
  type ClosureErrorCode,
  type ClosureRow,
} from "./closure.ts";
// Сравнение схем — общее у schema-parity.test.ts (файл против миграций) и
// у `myc doctor --schema` (рабочая база против миграций). Одна арифметика на
// оба вопроса: две копии нормализации DDL разъехались бы молча.
export {
  diffColumns,
  diffSchema,
  normalizeDdl,
  schemaConverges,
  schemaObjects,
  tableColumns,
  type ColumnDiff,
  type DiffOptions,
  type SchemaDiff,
  type SchemaObject,
} from "./schema-diff.ts";
export {
  checkEdgeAcyclic,
  cycleQueries,
  MAX_BLOCKS_DEPTH,
} from "./cycle.ts";
