/**
 * Прямой доступ к стору для операций, которых у CLI нет команды:
 * не-dep рёбра (myc_link), release/extend аренды и заметки (op=note/reopen).
 *
 * PRAGMA и предохранитель WAL — ровно STORE_PRAGMAS/createWalGuard из
 * store-sqlite, не свой список (решение S43, myc-ahy; регрессия myc-qie.12):
 * все пути открытия базы имеют право отличаться только загрузкой рантайма
 * расширений — она здесь есть и включается тем же параметром открытия, что
 * и в CLI (решение S45, продолжение в S46). Остальное (HLC-подсадка, разбор workspace.toml) повторяет
 * packages/cli/src/commands/store.ts осознанно — cli экспортирует только
 * run(), а его commands/* недоступны по границе пакета. Бизнес-логика
 * (движок GraphStore/Claims) не дублируется. store.parity.test.ts сравнивает
 * живое поведение всех путей, поэтому комментарий не может снова разойтись с
 * кодом незамеченным.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { generateId, prefixRange, HlcClock, unpackHlc } from "@myc/core";
import type { DbDriver, EdgeKind, NodeRecord, QueryDef, TxMode } from "@myc/core";
import {
  migrate,
  migrations,
  migrateVectors,
  vectorMigrations,
  GraphStore,
  Claims,
  SchemaError,
  STORE_PRAGMAS,
  createWalGuard,
  driverMeta,
  ensureSiteId,
  ensureSqliteRuntime,
  applySqliteRuntime,
  getSqliteRuntimeState,
  mintSiteId,
  type WalGuard,
  type WalGuardOptions,
} from "@myc/store-sqlite";

export interface McpDriver extends DbDriver {
  readonly database: Database;
  readonly wal: WalGuard;
  /** Загружен ли vec0 в ЭТОМ соединении: факт, а не намерение (S45). */
  readonly vec0: boolean;
  /**
   * Почему расширения ПРОСИЛИ, но не получили. `undefined` — не просили
   * вовсе или получили. Отказ подъёма не имеет права убивать инструмент
   * (И2): причина доезжает до degraded-строки ответа.
   */
  readonly vec0Reason: string | undefined;
  close(): void;
}

/**
 * Ленивость рантайма расширений как параметр открытия — тот же контракт,
 * что у CLI (решение S45). Умолчание `false`: платит только тот, кому
 * вектор нужен.
 */
export interface OpenOptions {
  /**
   * Поднять рантайм расширений (кастомная libsqlite3 + vec0) для этого
   * соединения. ~4-7 мс на процесс, дальше бесплатно.
   *
   * ОГРАНИЧЕНИЕ ДВИЖКА: `Database.setCustomSQLite` обязан выполниться до
   * первого `new Database` в процессе. В долгоживущем MCP-сервере это
   * значит «до первого открытия базы кем угодно в процессе, включая
   * команды CLI, которые сервер прогоняет сам» — см. ensureVectorRuntime
   * в command.ts.
   */
  readonly extensions?: boolean;
}

/** @internal тест паритета (store.parity.test.ts) открывает через wal-опции свои пороги */
export function openDriver(
  path: string,
  walOptions?: WalGuardOptions,
  options?: OpenOptions,
): McpDriver {
  const wantExtensions = options?.extensions === true;
  let vec0Reason: string | undefined;
  if (wantExtensions) {
    try {
      ensureSqliteRuntime();
    } catch (error) {
      // Опоздавший setCustomSQLite — не поломка воркспейса, а порядок
      // открытия в этом процессе. Инструмент обязан отработать без
      // вектора и СКАЗАТЬ почему, а не упасть.
      vec0Reason = error instanceof Error ? error.message : String(error);
    }
  }
  const db = new Database(path, { create: true });
  try {
    // Расширения грузятся НА СОЕДИНЕНИЕ, поэтому после каждого открытия.
    if (wantExtensions && vec0Reason === undefined) applySqliteRuntime(db);
    for (const pragma of STORE_PRAGMAS) db.exec(pragma);
  } catch (error) {
    db.close();
    throw error;
  }
  const vec0 =
    wantExtensions && vec0Reason === undefined && getSqliteRuntimeState()?.vec.loaded === true;
  const wal = createWalGuard(db, walOptions);
  const cache = new Map<string, Statement>();
  const stmt = (query: QueryDef): Statement => {
    let s = cache.get(query.name);
    if (s === undefined) {
      s = db.prepare(query.sql);
      cache.set(query.name, s);
    }
    return s;
  };
  let txDepth = 0;
  const driver: McpDriver = {
    dialect: "sqlite",
    database: db,
    wal,
    vec0,
    vec0Reason,
    one<T>(query: QueryDef, params: readonly unknown[]): T | undefined {
      const row = stmt(query).get(...params);
      return (row === null ? undefined : row) as T | undefined;
    },
    all<T>(query: QueryDef, params: readonly unknown[]): T[] {
      return stmt(query).all(...params) as T[];
    },
    run(query: QueryDef, params: readonly unknown[]): { changes: number } {
      const result = stmt(query).run(...params);
      if (txDepth === 0) wal.afterCommit();
      return { changes: Number(result.changes) };
    },
    tx<T>(mode: TxMode, fn: (tx: DbDriver) => T): T {
      if (txDepth > 0) throw new Error("nested transactions are not supported");
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
          // соединение уже откатилось само
        }
        throw error;
      } finally {
        txDepth--;
      }
    },
    close(): void {
      cache.clear();
      db.close();
    },
  };
  return driver;
}

/** slug из .myc/workspace.toml (см. store.ts в cli — тот же подset TOML). */
function workspaceSlug(dir: string): string {
  const tomlPath = join(dir, ".myc", "workspace.toml");
  if (!existsSync(tomlPath)) return "myc";
  try {
    for (const rawLine of readFileSync(tomlPath, "utf8").split("\n")) {
      const m = /^slug\s*=\s*"([a-z][a-z0-9]{1,7})"/.exec(rawLine.trim());
      if (m) return m[1]!;
    }
  } catch {
    // битый конфиг — дефолт
  }
  return "myc";
}

export interface McpStoreHandle {
  readonly driver: McpDriver;
  /** Загружен ли vec0 в соединение стора — для degraded-строк ответа. */
  readonly vec0: boolean;
  readonly vec0Reason: string | undefined;
  readonly store: GraphStore;
  readonly claims: Claims;
  readonly actor: string;
  readonly scope: string;
  readonly slug: string;
  close(): void;
}

export type McpStoreFailure = {
  readonly code: string;
  readonly msg: string;
  readonly hint?: string;
};

export type OpenMcpStoreResult =
  | { readonly ok: true; readonly handle: McpStoreHandle }
  | { readonly ok: false; readonly failure: McpStoreFailure };

const QL = {
  oplog_last_hlc: {
    name: "oplog_last_hlc",
    sql: "SELECT CAST(hlc AS TEXT) AS hlc FROM oplog ORDER BY seq DESC LIMIT 1",
    params: [],
  },
  id_prefix: {
    name: "id_prefix",
    sql: `SELECT id FROM nodes
           WHERE id >= ?1 AND id < ?2 AND deleted_at IS NULL
           ORDER BY id LIMIT 4`,
    params: ["lower", "upper"],
  },
} as const satisfies Record<string, QueryDef>;

/**
 * Накат векторного набора с терпимостью к ОДНОВРЕМЕННОМУ первому открытию —
 * та же механика, что в CLI (S45). Векторные миграции идут БЕЗ транзакции
 * (откат CREATE VIRTUAL TABLE с теневыми таблицами vec0 движок не
 * гарантирует), поэтому «версия отстаёт» и сам накат не атомарны. Проигравший
 * в гонке не пострадавший: набор применит победитель, достаточно перечитать
 * таблицу учёта. SchemaError — не гонка, пробрасывается сразу.
 *
 * Без этого шага загруженный vec0 не давал ничего: расширение в соединении
 * есть, а `nodes_vec` не создаётся никогда — вторая половина дефекта myc-6lc.
 */
function vecSchemaVersion(db: Database): number {
  try {
    const row = db
      .query("SELECT max(version) AS v FROM schema_migrations_vec")
      .get() as { v: number | null } | null;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

async function ensureVectorSchema(db: Database): Promise<void> {
  const maxKnown = vectorMigrations.reduce((m, mig) => Math.max(m, mig.version), 0);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (vecSchemaVersion(db) === maxKnown) return;
    try {
      await migrateVectors(db, { vec0Loaded: true, writable: true });
      return;
    } catch (e) {
      if (e instanceof SchemaError) throw e;
      if (attempt === 49) throw e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

export function resolveActor(): string {
  return process.env.MYC_ACTOR ?? process.env.USER ?? "agent";
}

export async function openMcpStore(
  directory?: string,
  options?: OpenOptions,
): Promise<OpenMcpStoreResult> {
  const dir = resolve(directory ?? process.cwd());
  const dbPath = join(dir, ".myc", "myc.db");
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      failure: {
        code: "ws.not_initialized",
        msg: `воркспейс не инициализирован: нет ${dbPath}`,
        hint: "myc init",
      },
    };
  }

  const slug = workspaceSlug(dir);
  const maxKnown = migrations.reduce((m, mig) => Math.max(m, mig.version), 0);
  let driver: McpDriver;
  try {
    driver = openDriver(dbPath, undefined, options);
    let appliedVersion: number | null = null;
    try {
      const row = driver.database
        .query("SELECT max(version) AS v FROM schema_migrations")
        .get() as { v: number | null } | null;
      appliedVersion = row?.v ?? null;
    } catch {
      appliedVersion = null;
    }
    if (appliedVersion !== maxKnown) {
      await migrate(driver.database, { migrations, writable: true });
    }
    // Векторный набор — только когда vec0 реально загружен в это соединение
    // (S26: база без расширения обязана быть полноценной).
    if (driver.vec0) await ensureVectorSchema(driver.database);
  } catch (e) {
    if (e instanceof SchemaError) {
      return {
        ok: false,
        failure: { code: "precond.schema", msg: e.message, hint: "myc doctor --schema" },
      };
    }
    return {
      ok: false,
      failure: {
        code: "conflict.busy",
        msg: `база недоступна: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  try {
    // S65: те же правила, что в cli/commands/store.ts. Долгоживущий
    // MCP-сервер — самый вероятный первый читатель скопированного каталога,
    // и WARN о перевыпуске уходит на stderr, где он не мешает JSON-RPC.
    const { siteId } = ensureSiteId({
      meta: driverMeta(driver),
      dbPath,
      mint: () => mintSiteId(slug),
    });
    let clock: HlcClock | undefined;
    const lastOp = driver.one<{ hlc: string }>(QL.oplog_last_hlc, []);
    if (lastOp !== undefined) {
      const { ts, ctr } = unpackHlc(BigInt(lastOp.hlc));
      clock = new HlcClock({ initial: { ts, ctr } });
    }
    const actor = resolveActor();
    const store = new GraphStore(driver, {
      newId: () => generateId(slug),
      actor,
      siteId,
      ...(clock !== undefined ? { clock } : {}),
    });
    return {
      ok: true,
      handle: {
        driver,
        vec0: driver.vec0,
        vec0Reason: driver.vec0Reason,
        store,
        claims: new Claims(store, { holder: actor }),
        actor,
        scope: slug === "myc" ? "" : slug,
        slug,
        close: () => driver.close(),
      },
    };
  } catch (e) {
    driver.close();
    return {
      ok: false,
      failure: { code: "internal.store", msg: e instanceof Error ? e.message : String(e) },
    };
  }
}

export type ResolveNodeResult =
  | { readonly ok: true; readonly node: NodeRecord }
  | { readonly ok: false; readonly failure: McpStoreFailure };

/** Полный id или однозначный префикс (та же грамматика, что §2.4 CLI). */
export function resolveNode(h: McpStoreHandle, input: string): ResolveNodeResult {
  const exact = h.store.getNode(input);
  if (exact !== undefined) return { ok: true, node: exact };

  const range = prefixRange(input);
  let candidates = h.driver
    .all<{ id: string }>(QL.id_prefix, [range.lower, range.upper])
    .map((r) => r.id);
  if (candidates.length === 0 && !input.includes("-")) {
    const scoped = prefixRange(`${h.slug}-${input}`);
    candidates = h.driver
      .all<{ id: string }>(QL.id_prefix, [scoped.lower, scoped.upper])
      .map((r) => r.id);
  }
  if (candidates.length === 0) {
    return { ok: false, failure: { code: "notfound.node", msg: `узел ${input} не найден` } };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      failure: {
        code: "usage.ambiguous_id",
        msg: `префикс '${input}' неоднозначен: ${candidates.join(", ")}`,
        hint: "уточните префикс",
      },
    };
  }
  const node = h.store.getNode(candidates[0]!);
  if (node === undefined) {
    return { ok: false, failure: { code: "notfound.node", msg: `узел ${input} не найден` } };
  }
  return { ok: true, node };
}

/** MCP-тип связи → EdgeKind ядра; blocks/blocked-by сюда не доходят (уходят в dep). */
export const LINK_EDGE_KINDS = {
  "relates-to": "relates",
  duplicates: "duplicates",
  supersedes: "supersedes",
  contradicts: "contradicts",
  "replies-to": "replies_to",
  "derived-from": "derived_from",
  "part-of": "parent",
} as const satisfies Record<string, EdgeKind>;
