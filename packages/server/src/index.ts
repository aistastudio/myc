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
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { adminOverview, adminTenants, renderAdminPage } from "./admin.ts";
import { aclParams, type Viewer } from "@myc/core";
import {
  boundedInt,
  parseWsPath,
  renderNode,
  wsList,
  wsQueries,
  WS_LIMIT_DEFAULT,
  WS_LIMIT_MAX,
} from "./ws.ts";
import { primeDigest, readyQueue, READY_LIMIT_DEFAULT, READY_LIMIT_MAX } from "./ready.ts";
import {
  addEdge,
  claimTask,
  CLAIM_TTL_MS,
  createNode,
  removeEdge,
  updateNode,
  validateCreate,
  validateEdge,
  validateUpdate,
} from "./write.ts";
import {
  authenticate,
  clearCookie,
  isSecureRequest,
  sessionCookie,
  tokenOf,
  type Principal,
  can,
  seesWorkspace,
} from "./auth.ts";

export const SERVER_VERSION = "0.0.0";

export type ServerConfig = {
  readonly port: number;
  /** Умолчание 127.0.0.1: без аутентификации (myc-e4v) сервер не виден из сети. */
  readonly host?: string;
  /** Корень воркспейса; база ищется в <dir>/.myc/myc.db, если db не задан. */
  readonly dir?: string;
  /** Явный путь к базе — выигрывает у dir. */
  readonly db?: string;
  /**
   * Сервер команды (M4): строка подключения к Postgres. Задана — поднимается
   * админка `/v1/admin` и её JSON (см. admin.ts). Не задана — сервер остаётся
   * локальным health-срезом над SQLite, а маршруты админки честно отвечают
   * 404 с причиной, а не пустой страницей.
   */
  readonly pg?: string;
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

/**
 * Конверт данных — ТОТ ЖЕ, что у CLI (§2.3): ok, cmd, ws, ts, data, meta, warn.
 * Один формат на два входа стоит того: агент, научившийся читать вывод
 * `myc --json`, читает и ответ сервера без второго парсера.
 */
function envelope(
  cmd: string,
  ws: string,
  data: unknown,
  meta: Readonly<Record<string, unknown>> = {},
): Response {
  return json({
    ok: true,
    cmd,
    ws,
    ts: new Date().toISOString(),
    data,
    meta: { degraded: [], ...meta },
    warn: [],
  });
}

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
/** Страница входа: одно поле, один POST. Ни скриптов, ни внешних запросов. */
function loginPage(error: string | null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>myc — server sign-in</title>
<style>body{font:14px/1.5 ui-monospace,Menlo,monospace;margin:6rem auto;max-width:26rem}
 input{width:100%;padding:.5rem;font:inherit} button{margin-top:.5rem;padding:.5rem 1rem;font:inherit}
 .err{color:#b00;margin:.5rem 0}</style></head><body>
<h1>myc — server</h1>
${error === null ? "" : `<p class="err">${error}</p>`}
<form method="post" action="/v1/auth/session">
 <label>access token<input type="password" name="token" autofocus autocomplete="off"></label>
 <button type="submit">sign in</button>
</form>
<p>Ask whoever runs this server for a token: <code>myc serve --pg &lt;url&gt; --add-token &lt;tenant&gt;:&lt;name&gt;</code></p>
</body></html>`;
}

const noPg = (): Response =>
  json(
    {
      ok: false,
      error: { code: "precond.no_pg", msg: "this route needs a Postgres server: start with --pg <url>" },
    },
    404,
  );

export function startHttpServer(config: ServerConfig): MycHttpServer {
  const dbPath = dbPathOf(config);
  const startedAt = Date.now();

  const openDb = (): ReadDb => openReadOnly(dbPath);
  // Одно соединение на весь процесс: у драйвера свой пул, а открывать его на
  // каждый запрос значило бы платить рукопожатием за каждую страницу.
  const pg: PostgresDriver | undefined = config.pg === undefined ? undefined : openPostgres(config.pg);

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // liveness: процесс жив, базу не трогаем — 200 всегда
    if (url.pathname === "/v1/health" && req.method === "GET") {
      return json({
        ok: true,
        ver: SERVER_VERSION,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        pid: process.pid,
      });
    }

    // ВХОД БРАУЗЕРА. Единственный POST на сервере: страница админки — обычная
    // вкладка, и держать токен в адресной строке (журналы прокси, история,
    // «поделись ссылкой») нельзя. Форма отдаёт его один раз, дальше работает
    // кука: HttpOnly, SameSite=Strict, Secure за https.
    if (url.pathname === "/v1/auth/session") {
      if (pg === undefined) return noPg();
      if (req.method === "POST") {
        const form = await req.formData().catch(() => null);
        const token = typeof form?.get("token") === "string" ? String(form.get("token")) : null;
        const auth = await authenticate(pg, token);
        if (!auth.ok) {
          return new Response(loginPage("that token was not accepted"), {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: "/v1/admin",
            "set-cookie": sessionCookie(token!, isSecureRequest(req)),
          },
        });
      }
      if (req.method === "DELETE" || req.method === "GET") {
        // Выход: кука снимается, токен при этом жив — отзывает его владелец.
        return new Response(null, { status: 303, headers: { location: "/v1/admin", "set-cookie": clearCookie() } });
      }
    }

    // ЗАПИСЬ ИДЁТ ТОЛЬКО В ДАННЫЕ ВОРКСПЕЙСА и только после проверки токена
    // (она ниже). Всё остальное на сервере — чтение: отвечать «405 GET only»
    // честнее, чем делать вид, что метод поддержан и просто не сработал.
    if (req.method !== "GET" && parseWsPath(url.pathname) === null) {
      return json({ ok: false, error: { code: "usage.method", msg: "GET only" } }, 405);
    }

    // ДОСТУП. Закрыто всё, кроме пробы живости выше: сервер стоит в сети, и
    // health базы с составом деградаций — тоже сведения о системе. Без
    // Postgres токенов нет вовсе, и тогда сервер остаётся локальным срезом:
    // он слушает 127.0.0.1 по умолчанию, и закрывать его нечем и не от кого.
    let who: Principal | undefined;
    if (pg !== undefined) {
      const auth = await authenticate(pg, tokenOf(req));
      if (!auth.ok) {
        // Браузеру — страница входа, машине — 401 с кодом.
        const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
        if (wantsHtml) {
          return new Response(loginPage(auth.code === "denied.no_token" ? null : "that token was not accepted"), {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return json({ ok: false, error: { code: auth.code, msg: auth.msg } }, 401);
      }
      who = auth.principal;
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
          ? (db.one<{ v: number | null }>(
              // Версия — по обеим таблицам учёта: совместимые миграции
              // (store-sqlite migrate.ts, COMPAT_MIGRATIONS_TABLE) лежат не в
              // schema_migrations. Пакет не зависит от store-sqlite — текст здесь.
              db.has("schema_migrations_compat")
                ? `SELECT max(v) AS v FROM (SELECT max(version) AS v FROM schema_migrations
                                            UNION ALL SELECT max(version) FROM schema_migrations_compat)`
                : "SELECT max(version) AS v FROM schema_migrations",
            )?.v ?? null)
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

    // Админка сервера (M4): состояние сервера и арендаторы. Только чтение.
    if (url.pathname.startsWith("/v1/admin")) {
      if (pg === undefined) return noPg();
      // Админка показывает арендаторов и состояние сервера — это сведения о
      // системе, и смотреть их вправе не всякий, кому выдали токен.
      if (!can(who, "admin")) {
        return json(
          {
            ok: false,
            error: { code: "denied.scope", msg: "this token has no 'admin' scope" },
          },
          403,
        );
      }
      try {
        if (url.pathname === "/v1/admin/overview") {
          const o = await adminOverview(pg);
          return json({ ok: true, ...o, degraded: o.warn.map((w) => w.code) });
        }
        if (url.pathname === "/v1/admin/tenants") {
          return json({ ok: true, tenants: await adminTenants(pg) });
        }
        if (url.pathname === "/v1/admin" || url.pathname === "/v1/admin/") {
          const [o, tenants] = await Promise.all([adminOverview(pg), adminTenants(pg)]);
          return new Response(renderAdminPage(o, tenants, who), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: { code: "db.query", msg } }, 503);
      }
    }

    // ---- данные воркспейса: /v1/ws и /v1/ws/:ws/… (§8.1) --------------------
    if (url.pathname === "/v1/ws") {
      if (pg === undefined) return noPg();
      const t0 = performance.now();
      const list = await wsList(pg, who!.tenant, { owner: who!.subject, team: "", agent: "" });
      return envelope("ws", "", list, { took_ms: Math.round((performance.now() - t0) * 100) / 100, count: list.length });
    }

    const wsPath = parseWsPath(url.pathname);
    if (wsPath !== null) {
      if (pg === undefined) return noPg();
      const { ws, rest } = wsPath;
      const tenant = who!.tenant;
      // Токен, привязанный к одному проекту, о чужих не узнаёт даже
      // отказом: ответ тот же, что у несуществующего воркспейса.
      // Кто смотрит. Владелец — subject токена; команда и агент пока не
      // заводятся (их назначает выдача токена, §8.2), и пустые значения
      // означают «такой принадлежности нет», а не «любая».
      const viewer: Viewer = { owner: who?.subject ?? "", team: "", agent: "" };
      const acl = aclParams(viewer);
      if (!seesWorkspace(who, ws)) {
        return json(
          { ok: false, cmd: "ws", ws, error: { code: "notfound.ws", msg: `no workspace ${ws}` } },
          404,
        );
      }
      const t0 = performance.now();
      const took = (): number => Math.round((performance.now() - t0) * 100) / 100;

      try {
        const needs = (scope: "write" | "claim"): Response | undefined =>
          can(who, scope)
            ? undefined
            : json(
                {
                  ok: false,
                  cmd: "ws",
                  ws,
                  error: { code: "denied.scope", msg: `this token has no '${scope}' scope` },
                },
                403,
              );

        if ((rest === "/nodes" || rest === "/nodes/") && req.method === "POST") {
          const denied = needs("write");
          if (denied !== undefined) return denied;
          // Создание узла: сервер минтит операции и отдаёт их ТОМУ ЖЕ
          // применителю, что и CLI (packages/server/src/write.ts).
          const body = await req.json().catch(() => null);
          const parsed = validateCreate(body);
          if (!parsed.ok) {
            return json({ ok: false, cmd: "node", ws, error: parsed.error }, 400);
          }
          const created = await createNode(pg, tenant, ws, parsed.data, who!.subject);
          const [node] = await pg.withTenant(tenant, async (tx) => [
            await tx.one<Record<string, unknown>>(wsQueries.ws_node_get, [ws, created.id, ...acl]),
          ]);
          return envelope("node", ws, node === undefined ? { id: created.id } : renderNode(node), {
            took_ms: took(),
            applied: created.applied,
            collided: created.collided,
          });
        }

        if ((rest === "/prime" || rest === "/prime/") && req.method === "GET") {
          const q = url.searchParams;
          const answer = await primeDigest(
            pg,
            tenant,
            ws,
            q.get("session") ?? "",
            q.get("repo") ?? "",
            boundedInt(q.get("n"), READY_LIMIT_DEFAULT, READY_LIMIT_MAX),
            viewer,
          );
          return envelope("prime", ws, answer, { took_ms: took() });
        }

        if ((rest === "/ready" || rest === "/ready/") && req.method === "GET") {
          const q = url.searchParams;
          const limit = boundedInt(q.get("n"), READY_LIMIT_DEFAULT, READY_LIMIT_MAX);
          const queue = await readyQueue(pg, tenant, ws, limit, viewer, q.get("repo") ?? "");
          return envelope("ready", ws, queue.items, {
            took_ms: took(),
            count: queue.items.length,
            total: queue.total,
          });
        }

        if (rest === "/ready/claim" && req.method === "POST") {
          const denied = needs("claim");
          if (denied !== undefined) return denied;
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          const id = typeof body?.["id"] === "string" ? body["id"] : "";
          if (id === "") {
            return json(
              { ok: false, cmd: "claim", ws, error: { code: "usage.id", msg: "'id' is required" } },
              400,
            );
          }
          const minutes = body?.["lease_minutes"];
          const ttl = minutes === undefined ? CLAIM_TTL_MS : Number(minutes) * 60_000;
          // Держатель — владелец токена, а не поле запроса: иначе задачу можно
          // взять от чужого имени, и «кто держит» перестанет что-либо значить.
          const done = await claimTask(pg, tenant, ws, id, who!.subject, ttl);
          if (!done.ok) {
            const status =
              done.error.code === "notfound.node" ? 404 : done.error.code === "usage.lease" ? 400 : 409;
            return json({ ok: false, cmd: "claim", ws, error: done.error }, status);
          }
          return envelope("claim", ws, done.data, { took_ms: took() });
        }

        if (rest === "/edges" && (req.method === "POST" || req.method === "DELETE")) {
          const denied = needs("write");
          if (denied !== undefined) return denied;
          const body = await req.json().catch(() => null);
          const parsed = validateEdge(body);
          if (!parsed.ok) {
            return json({ ok: false, cmd: "edge", ws, error: parsed.error }, 400);
          }
          const done =
            req.method === "POST"
              ? await addEdge(pg, tenant, ws, parsed.data, who!.subject)
              : await removeEdge(pg, tenant, ws, parsed.data, who!.subject);
          if (!done.ok) {
            return json(
              { ok: false, cmd: "edge", ws, error: done.error },
              done.error.code.startsWith("notfound.") ? 404 : 409,
            );
          }
          return envelope("edge", ws, done.data, { took_ms: took() });
        }

        const onePath = /^\/nodes\/([^/]+)$/.exec(rest);
        if (onePath !== null && req.method === "PATCH") {
          const denied = needs("write");
          if (denied !== undefined) return denied;
          const body = await req.json().catch(() => null);
          const parsed = validateUpdate(body);
          if (!parsed.ok) {
            return json({ ok: false, cmd: "node", ws, error: parsed.error }, 400);
          }
          const id = decodeURIComponent(onePath[1]!);
          const done = await updateNode(pg, tenant, ws, id, parsed.data, who!.subject);
          if (!done.ok) {
            return json(
              { ok: false, cmd: "node", ws, error: done.error },
              done.error.code === "notfound.node" ? 404 : 400,
            );
          }
          const [node] = await pg.withTenant(tenant, async (tx) => [
            await tx.one<Record<string, unknown>>(wsQueries.ws_node_get, [ws, id, ...acl]),
          ]);
          return envelope("node", ws, node === undefined ? { id } : renderNode(node), {
            took_ms: took(),
            changed: done.data.changed,
          });
        }

        if (req.method !== "GET") {
          return json(
            {
              ok: false,
              cmd: "ws",
              ws,
              error: { code: "usage.method", msg: `${req.method} is not supported on ${url.pathname}` },
            },
            405,
          );
        }

        if (rest === "/nodes" || rest === "/nodes/") {
          const q = url.searchParams;
          const limit = boundedInt(q.get("limit"), WS_LIMIT_DEFAULT, WS_LIMIT_MAX);
          const offset = boundedInt(q.get("offset"), 0, Number.MAX_SAFE_INTEGER);
          const filters = [ws, q.get("kind") ?? "", q.get("status") ?? "", boundedInt(q.get("since"), 0, Number.MAX_SAFE_INTEGER)];
          const [rows, counted] = await pg.withTenant(tenant, async (tx) => [
            await tx.all<Record<string, unknown>>(wsQueries.ws_nodes_list, [...filters, limit, offset, ...acl]),
            await tx.one<{ n: string | number }>(wsQueries.ws_nodes_count, [...filters, ...acl]),
          ]);
          return envelope("nodes", ws, rows, {
            took_ms: took(),
            count: rows.length,
            total: Number(counted?.n ?? 0),
            limit,
            offset,
          });
        }

        if (onePath !== null) {
          const id = decodeURIComponent(onePath[1]!);
          const [node, edges] = await pg.withTenant(tenant, async (tx) => [
            await tx.one<Record<string, unknown>>(wsQueries.ws_node_get, [ws, id, ...acl]),
            await tx.all<Record<string, unknown>>(wsQueries.ws_node_edges, [ws, id]),
          ]);
          // Чужой воркспейс отвечает ТЕМ ЖЕ, что несуществующий узел: иначе
          // по разнице ответов перебирают, что есть у соседа.
          if (node === undefined) {
            return json(
              { ok: false, cmd: "node", ws, error: { code: "notfound.node", msg: `no node ${id} in workspace ${ws}` } },
              404,
            );
          }
          return envelope("node", ws, { ...renderNode(node), edges }, { took_ms: took() });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, cmd: "ws", ws, error: { code: "db.query", msg } }, 503);
      }

      return json(
        { ok: false, cmd: "ws", ws, error: { code: "notfound.route", msg: `no route ${url.pathname}` } },
        404,
      );
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
      void pg?.close();
      server.stop(true);
    },
  };
}
