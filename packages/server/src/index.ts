/**
 * `myc serve` — HTTP API (docs/design/03-interfaces-and-integration.md §8).
 *
 * Здесь M0-срез: health-тройка `/v1/health`, `/v1/health/db`,
 * `/v1/health/index`. Аутентификация, воркспейсы в пути и data-эндпоинты —
 * задача myc-e4v; форма ответов уже сейчас следует §8.4, чтобы контракт не
 * пришлось ломать потом.
 *
 * И2 — ГРОМКАЯ ДЕГРАДАЦИЯ НА ТРЕТЬЕЙ ПОВЕРХНОСТИ. CLI несёт деградацию в
 * meta.degraded[] конверта, MCP — в structuredContent.meta.degraded; HTTP
 * обязан показывать её же, иначе о третьей поверхности инвариант молчит.
 * Источник истины — база: пишущий процесс (absorb, reindex) кладёт состояние
 * компонентов в myc_health, а `/v1/health/index` отдаёт его наружу как
 * `degraded[]` + `warn[]` с причиной и следствием — по тому же образцу, что
 * WARN degraded.embeddings у `myc recall`. Деградация видна ЗАПРОСОМ,
 * а не только в doctor.
 *
 * Соединение с базой — строго readonly (тот же подход, что у просмотрщика
 * packages/web/src/db.ts): health-эндпоинты не имеют права блокировать
 * писателя ни одной транзакцией.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export const SERVER_VERSION = "0.0.0";

export type ServerConfig = {
  readonly port: number;
  /** Умолчание 127.0.0.1: без аутентификации (myc-e4v) сервер не виден из сети. */
  readonly host?: string;
  /** Корень воркспейса; база ищется в <dir>/.myc/myc.db, если db не задан. */
  readonly dir?: string;
  /** Явный путь к базе — выигрывает у dir. */
  readonly db?: string;
};

export interface MycHttpServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  stop(): void;
}

// ---------------------------------------------------------------------------
// readonly-доступ к базе
// ---------------------------------------------------------------------------

export class HttpDbError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpDbError";
  }
}

interface ReadDb {
  one<T>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  has(name: string): boolean;
  meta(key: string): string | undefined;
  close(): void;
}

type Binding = string | number | bigint | boolean | null | Uint8Array;

/** Пробуем дождаться чекпойнт писателя, а не падать на BUSY. */
const BUSY_TIMEOUT_MS = 2000;

function openReadOnly(path: string): ReadDb {
  if (!existsSync(path)) {
    throw new HttpDbError("db.missing", `no database file: ${path}`);
  }
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new HttpDbError("db.open", `could not open the database read-only: ${msg}`);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA query_only = 1");
  } catch {
    // readonly-флаг соединения уже держит запрет записи; PRAGMA — второй слой
  }

  const tables = new Set<string>();
  let tablesLoaded = false;
  const loadTables = (): void => {
    if (tablesLoaded) return;
    try {
      for (const r of db
        .query("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all() as Array<{ name: string }>) {
        tables.add(r.name);
      }
    } catch {
      // база пуста или бита — множество остаётся пустым, has() ответит честно
    }
    tablesLoaded = true;
  };

  return {
    one<T>(sql: string, params: readonly unknown[] = []): T | undefined {
      const row = db.query(sql).get(...(params as Binding[]));
      return (row === null ? undefined : row) as T | undefined;
    },
    all<T>(sql: string, params: readonly unknown[] = []): T[] {
      return db.query(sql).all(...(params as Binding[])) as T[];
    },
    has(name: string): boolean {
      loadTables();
      return tables.has(name);
    },
    meta(key: string): string | undefined {
      loadTables();
      if (!tables.has("myc_meta")) return undefined;
      const row = this.one<{ value: string }>("SELECT value FROM myc_meta WHERE key = ?1", [key]);
      return row?.value;
    },
    close(): void {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// /v1/health/index: деградация — часть ответа (И2)
// ---------------------------------------------------------------------------

export interface IndexDegradation {
  readonly code: string;
  readonly msg: string;
}

export interface IndexHealth {
  /** false, если degraded[] непуст — качество индекса урезано. */
  readonly ok: boolean;
  /** Машинные коды — тот же слот, что meta.degraded[] конверта CLI. */
  readonly degraded: readonly string[];
  /** Причина и следствие по каждому коду — образец WARN у `myc recall`. */
  readonly warn: readonly IndexDegradation[];
  readonly nodes: number;
  readonly vectors: number;
  readonly queue: number;
  readonly failed: number;
  readonly fts: "ok" | "missing";
  readonly vec: "ok" | "unavailable";
  readonly embed_fingerprint: string | null;
  readonly components: readonly {
    component: string;
    state: string;
    reason: string;
    since: number;
  }[];
}

function count(db: ReadDb, sql: string): number {
  return db.one<{ n: number }>(sql)?.n ?? 0;
}

/**
 * Сводка качества индекса. Источники: myc_health (что записал пишущий
 * процесс), myc_meta (отпечаток векторного пространства), факт наката
 * векторных миграций (решение S26), очередь jobs.
 */
export function buildIndexHealth(db: ReadDb): IndexHealth {
  const warn: IndexDegradation[] = [];

  // Компоненты, записанные пишущим процессом: absorb при работе без векторов
  // кладёт state='degraded' и причину — это и есть громкий канал И2.
  const components = db.has("myc_health")
    ? db
        .all<{ component: string; state: string; reason: string; since: number }>(
          "SELECT component, state, reason, since FROM myc_health ORDER BY component",
        )
        .map((r) => ({
          component: String(r.component),
          state: String(r.state),
          reason: String(r.reason ?? ""),
          since: Number(r.since ?? 0),
        }))
    : [];
  for (const c of components) {
    if (c.state === "ok") continue;
    warn.push({
      code: `health.${c.component}`,
      msg: `${c.component}: ${c.state}${c.reason.length > 0 ? ` — ${c.reason}` : ""}`,
    });
  }

  const nodes = db.has("nodes")
    ? count(db, "SELECT count(*) AS n FROM nodes WHERE deleted_at IS NULL")
    : 0;

  // Отпечаток векторного пространства появляется при первой успешной записи
  // вектора (absorb/reindex). Его отсутствие = векторная ветка не работала
  // ни разу: семантика урезана до полнотекста, и это говорится вслух.
  const fingerprint = db.meta("embed_fingerprint") ?? null;
  if (fingerprint === null) {
    warn.push({
      code: "embeddings.off",
      msg: "the embedding model has never written a vector (myc_meta.embed_fingerprint is empty) — " +
        "the vector branch of search and the absorb cosine are unavailable, semantics cut down to FTS",
    });
  }

  // Векторный набор миграций накатывается только когда vec0 загружен (S26).
  const vecApplied = db.has("schema_migrations_vec") && count(db, "SELECT count(*) AS n FROM schema_migrations_vec") > 0;
  if (!vecApplied) {
    warn.push({
      code: "vector.unavailable",
      msg: "the sqlite-vec extension (vec0) was never loaded: vector migrations are not applied — " +
        "vector search is off, the other surfaces work",
    });
  }

  let vectors = 0;
  if (db.has("nodes_vec")) {
    try {
      vectors = count(db, "SELECT count(*) AS n FROM nodes_vec");
    } catch {
      // 'no such module: vec0' в этом процессе — схема есть, считать нечем
    }
  }

  const queue = db.has("jobs")
    ? count(db, "SELECT count(*) AS n FROM jobs WHERE attempts < max_attempts")
    : 0;
  const failed = db.has("jobs")
    ? count(db, "SELECT count(*) AS n FROM jobs WHERE attempts >= max_attempts")
    : 0;
  if (failed > 0) {
    warn.push({
      code: "jobs.failed",
      msg: `${failed} background jobs ran out of attempts — some nodes will stay unprocessed`,
    });
  }

  return {
    ok: warn.length === 0,
    degraded: warn.map((w) => w.code),
    warn,
    nodes,
    vectors,
    queue,
    failed,
    fts: db.has("nodes_fts") ? "ok" : "missing",
    vec: vecApplied ? "ok" : "unavailable",
    embed_fingerprint: fingerprint,
    components,
  };
}

// ---------------------------------------------------------------------------
// сервер
// ---------------------------------------------------------------------------

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function dbPathOf(config: ServerConfig): string {
  if (config.db !== undefined) return config.db;
  return join(config.dir ?? process.cwd(), ".myc", "myc.db");
}

/**
 * Поднимает HTTP API. Порт 0 — эфемерный (тесты). Деградация базы не мешает
 * старту: `/v1/health` отвечает всегда, состояние БД — у двух других
 * эндпоинтов (разделение liveness/readiness/quality, §8.4).
 */
export function startHttpServer(config: ServerConfig): MycHttpServer {
  const dbPath = dbPathOf(config);
  const startedAt = Date.now();

  const openDb = (): ReadDb => openReadOnly(dbPath);

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "GET") {
      return json({ ok: false, error: { code: "usage.method", msg: "GET only" } }, 405);
    }

    // liveness: процесс жив, базу не трогаем — 200 всегда
    if (url.pathname === "/v1/health") {
      return json({
        ok: true,
        ver: SERVER_VERSION,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        pid: process.pid,
      });
    }

    // readiness: соединение, версия схемы, латентность — 503 при недоступной БД
    if (url.pathname === "/v1/health/db") {
      let db: ReadDb;
      try {
        db = openDb();
      } catch (e) {
        const err = e instanceof HttpDbError ? e : new HttpDbError("db.open", String(e));
        return json({ ok: false, error: { code: err.code, msg: err.message } }, 503);
      }
      try {
        const t0 = performance.now();
        db.one<{ v: number }>("SELECT 1 AS v");
        const latency = Math.round((performance.now() - t0) * 100) / 100;
        const schema = db.has("schema_migrations")
          ? (db.one<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations")?.v ?? null)
          : null;
        return json({
          ok: true,
          db: "sqlite",
          latency_ms: latency,
          schema: schema === null ? null : `v${schema}`,
          migrations_pending: 0,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: { code: "db.query", msg } }, 503);
      } finally {
        db.close();
      }
    }

    // качество индекса: 200 + degraded[] при WARN, 503 при FAIL (§8.4)
    if (url.pathname === "/v1/health/index") {
      let db: ReadDb;
      try {
        db = openDb();
      } catch (e) {
        const err = e instanceof HttpDbError ? e : new HttpDbError("db.open", String(e));
        return json(
          { ok: false, degraded: [err.code], warn: [{ code: err.code, msg: err.message }] },
          503,
        );
      }
      try {
        return json(buildIndexHealth(db));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json(
          { ok: false, degraded: ["db.query"], warn: [{ code: "db.query", msg }] },
          503,
        );
      } finally {
        db.close();
      }
    }

    return json(
      { ok: false, error: { code: "notfound.route", msg: `no route ${url.pathname}` } },
      404,
    );
  };

  const server = Bun.serve({
    port: config.port,
    hostname: config.host ?? "127.0.0.1",
    development: false,
    fetch,
  });

  const host = server.hostname ?? "127.0.0.1";
  const port = server.port ?? config.port;
  return {
    url: `http://${host}:${port}`,
    port,
    host,
    dbPath,
    stop(): void {
      server.stop(true);
    },
  };
}
