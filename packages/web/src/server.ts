/**
 * HTTP-сервер просмотрщика: чтение своим соединением, запись — чужим.
 *
 * Читающее соединение по-прежнему открыто СТРОГО НА ЧТЕНИЕ (db.ts): ни один
 * GET не берёт RESERVED-блокировку и не мешает писателю. Мутирующие маршруты
 * теперь есть, но они не пишут в это соединение и вообще не пишут сами —
 * каждая правка уходит в тот же движок команд, что обслуживает терминал
 * (mutate.ts). Разница принципиальная: запрет «просмотрщик не пишет»
 * заменён на «просмотрщик не знает, КАК писать», и знать это по-прежнему
 * может только общий путь записи с оплогом, HLC и охраной статусов.
 *
 * Слушаем 127.0.0.1: локальный просмотрщик по умолчанию не виден из сети.
 * Заголовки запрещают странице ходить куда-либо наружу — CSP `default-src
 * 'self'` делает требование «ноль CDN» проверяемым, а не декларативным.
 */

import { existsSync } from "node:fs";
import { assetBytes, getAsset } from "./assets.ts";
import { buildBoard, releasePreview } from "./board.ts";
import {
  loadBootstrapBlocks,
  loadBootstrapHistory,
  loadBootstrapPreview,
  planBootstrapRm,
  planBootstrapSet,
} from "./bootstrap.ts";
import { buildCard } from "./card.ts";
import { buildDecisions } from "./decisions.ts";
import { openReadOnly, VizDbError, type ReadOnlyDb } from "./db.ts";
import { buildGraph, DEFAULT_EDGE_LIMIT, DEFAULT_NODE_LIMIT } from "./graph.ts";
import { buildHealth } from "./health.ts";
import { buildKb, KB_LIMIT } from "./kb.ts";
import { buildReady } from "./ready.ts";
import { buildRouting } from "./routing.ts";
import { buildTimeline } from "./timeline.ts";
import {
  aclDenial,
  checkIfMatch,
  cliRunner,
  planCreate,
  planOp,
  planUpdate,
  principalOf,
  readNodeView,
  runWrite,
  nodeClocks,
  UPDATE_FIELDS,
  WRITE_OPS,
  type RunCli,
  type WriteOutcome,
  type WritePlan,
} from "./mutate.ts";
import { loadSearch } from "./search.ts";
import { loadWorkspace, tierOf, type WorkspaceConfig } from "./workspace.ts";
import type { BootPayload, WorkspaceTier } from "./types.ts";

export const VIZ_VERSION = "0.0.0";

const SECURITY_HEADERS: Record<string, string> = {
  // Ни одного внешнего источника: скрипты, стили, шрифты и соединения — только
  // свои. Любая попытка подтянуть CDN будет заблокирована браузером.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export interface VizServerOptions {
  readonly dbPath: string;
  /** Корень воркспейса — из него читается .myc/workspace.toml. */
  readonly dir: string;
  readonly port?: number;
  readonly hostname?: string;
  /** Потолок узлов локального лэйаута (решение S18). */
  readonly nodeLimit?: number;
  readonly edgeLimit?: number;
  /**
   * Путь записи. По умолчанию — `run()` из @myc/cli, то есть буквально тот
   * же движок команд, что и в терминале. Подменяется в тестах настоящим
   * процессом `myc`, чтобы приёмка сравнивала оплог с оплогом, а не с
   * подделкой.
   */
  readonly runCli?: RunCli;
  /** Поднять просмотрщик без записи: POST отвечает 405, как раньше. */
  readonly readOnly?: boolean;
  /**
   * HOME для определения яруса (S41). По умолчанию — окружение процесса;
   * тесты личного яруса подставляют свой корень, не трогая реальный HOME.
   */
  readonly homeDir?: string;
}

export interface VizServer {
  readonly url: string;
  readonly port: number;
  readonly hostname: string;
  readonly dbPath: string;
  readonly workspace: WorkspaceConfig;
  /** Ярус открытой базы (S41): личный ~/.myc или проектный .myc/. */
  readonly tier: WorkspaceTier;
  readonly assetBytes: number;
  /** Принимает ли эта сборка запись (см. VizServerOptions.readOnly). */
  readonly writable: boolean;
  /** Счётчики для тестов и для строки статуса CLI. */
  readonly stats: { requests: number; errors: number };
  stop(): void;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function fail(status: number, error: string, msg: string): Response {
  return json({ error, msg }, status);
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function startVizServer(opts: VizServerOptions): VizServer {
  if (!existsSync(opts.dbPath)) {
    throw new VizDbError("db.missing", `нет файла базы: ${opts.dbPath}`);
  }
  const workspace = loadWorkspace(opts.dir);
  // Ярус (S41) — свойство пути базы, считается один раз на старте.
  const tier = tierOf(opts.dbPath, opts.homeDir ?? process.env.HOME);
  const nodeLimit = opts.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const edgeLimit = opts.edgeLimit ?? DEFAULT_EDGE_LIMIT;

  // Одно соединение на процесс: bun:sqlite сериализует запросы сам, а
  // просмотрщик по определению однопользовательский. Открытие проверяем
  // сразу, чтобы `myc viz` падал на старте, а не первым запросом браузера.
  let db: ReadOnlyDb = openReadOnly(opts.dbPath);
  const stats = { requests: 0, errors: 0 };

  const writable = opts.readOnly !== true;
  const runCli: RunCli = opts.runCli ?? cliRunner(opts.dir, opts.dbPath);

  /** Ответ мутации: успех и отказ несут одинаковый конверт (И2). */
  const writeResponse = (
    outcome: WriteOutcome,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (!outcome.ok) {
      stats.errors++;
      return json(
        {
          ok: false,
          error: {
            code: outcome.code,
            msg: outcome.msg,
            ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
          },
          meta: { degraded: outcome.degraded },
          warn: outcome.warn,
          ...(outcome.extra ?? {}),
        },
        outcome.status,
      );
    }
    return json({
      ok: true,
      data: outcome.data,
      meta: { degraded: outcome.degraded },
      warn: outcome.warn,
      ...extra,
    });
  };

  /**
   * Один порядок для всех мутаций: разобрать тело, собрать план, проверить
   * ACL и часы полей, отдать план общему пути записи. Ни одна ветка не
   * возвращает 200 без записи.
   */
  const write = async (
    request: Request,
    plan: (body: Record<string, unknown>) => WritePlan | WriteOutcome,
    target?: string,
  ): Promise<Response> => {
    if (!writable) {
      stats.errors++;
      return fail(405, "method.not_allowed", "просмотрщик поднят только на чтение");
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("тело — JSON-объект");
      }
      body = parsed as Record<string, unknown>;
    } catch (e) {
      stats.errors++;
      return fail(400, "usage.body", `тело запроса не разобрано: ${e instanceof Error ? e.message : String(e)}`);
    }

    const built = plan(body);
    if (!("argv" in built)) return writeResponse(built);

    if (target !== undefined) {
      const denied = aclDenial(db, target, principalOf());
      if (denied !== undefined) return writeResponse(denied);
      const conflict = checkIfMatch(db, target, built, body["if_match"]);
      if (conflict !== undefined) return writeResponse(conflict);
    }

    const outcome = await runWrite(runCli, built.argv);
    if (!outcome.ok) return writeResponse(outcome);

    const planWarn = built.warn ?? [];
    const merged: WriteOutcome = {
      ...outcome,
      warn: [...outcome.warn, ...planWarn],
      degraded: [...outcome.degraded, ...planWarn.map((w) => w.code)],
    };
    const id = target ?? (typeof outcome.data["id"] === "string" ? outcome.data["id"] : undefined);
    return writeResponse(merged, id !== undefined ? { clk: nodeClocks(db, id) } : {});
  };

  const handle = async (request: Request): Promise<Response> => {
    stats.requests++;
    const url = new URL(request.url);
    const nodeWithOp = /^\/api\/nodes\/([^/]+)(\/op|\/card)?$/.exec(url.pathname);
    const releaseMatch = /^\/api\/nodes\/([^/]+)\/release-preview$/.exec(url.pathname);
    // Форма маршрутов — та же, что у /api/nodes/<id> и /api/nodes/<id>/op:
    // ключ вместо id узла, потому что личный ярус (S41) знает блок по ключу,
    // а не по id (readPersonalBlocks его вообще не отдаёт).
    const bootstrapKey = /^\/api\/bootstrap\/([^/]+)(\/op)?$/.exec(url.pathname);
    const bootstrapHistory = /^\/api\/bootstrap\/blocks\/([^/]+)\/history$/.exec(url.pathname);

    if (request.method === "POST") {
      if (url.pathname === "/api/nodes") return write(request, planCreate);
      if (nodeWithOp !== null && nodeWithOp[2] !== "/card") {
        const node = nodeWithOp;
        const id = decodeURIComponent(node[1]!);
        return node[2] === undefined
          ? write(request, (body) => planUpdate(id, body), id)
          : write(request, (body) => planOp(id, body), id);
      }
      // "blocks" — синтаксически валидный ключ (KEY_RE), поэтому различие с
      // GET /api/bootstrap/blocks — только в методе, не в пути: у GET и POST
      // разные ветки диспетчера, коллизии между ними нет.
      if (bootstrapKey !== null) {
        const key = decodeURIComponent(bootstrapKey[1]!);
        return bootstrapKey[2] === undefined
          ? write(request, (body) => planBootstrapSet(key, body))
          : write(request, (body) => planBootstrapRm(key, body));
      }
      stats.errors++;
      return fail(404, "notfound", `нет маршрута POST ${url.pathname}`);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      stats.errors++;
      return fail(405, "method.not_allowed", `метод ${request.method} не обслуживается`);
    }

    try {
      if (releaseMatch !== null) {
        const id = decodeURIComponent(releaseMatch[1]!);
        return json({ released: releasePreview(db, id) });
      }
      if (nodeWithOp !== null) {
        const id = decodeURIComponent(nodeWithOp[1]!);
        if (nodeWithOp[2] === "/card") {
          const card = buildCard(db, id);
          if (card === undefined) {
            stats.errors++;
            return fail(404, "notfound.node", `нет узла ${nodeWithOp[1]}`);
          }
          return json(card);
        }
        if (nodeWithOp[2] === undefined) {
          const view = readNodeView(db, id);
          if (view === undefined) {
            stats.errors++;
            return fail(404, "notfound.node", `нет узла ${nodeWithOp[1]}`);
          }
          return json(view);
        }
      }
      if (bootstrapHistory !== null) {
        const id = decodeURIComponent(bootstrapHistory[1]!);
        const rows = loadBootstrapHistory(db, id, intParam(url, "limit", 20, 200));
        return json({ rows });
      }
      if (url.pathname === "/api/bootstrap") {
        const budgetRaw = url.searchParams.get("budget");
        const budget = budgetRaw !== null && Number.isFinite(Number(budgetRaw)) ? Number(budgetRaw) : undefined;
        const outcome = await loadBootstrapPreview(runCli, budget);
        return writeResponse(outcome);
      }
      if (url.pathname === "/api/bootstrap/blocks") {
        const outcome = await loadBootstrapBlocks(runCli);
        if (!outcome.ok) return writeResponse(outcome);
        const rows = Array.isArray(outcome.data) ? outcome.data : [];
        return writeResponse({ ...outcome, data: { rows } });
      }
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        if (q.trim().length === 0) {
          return fail(400, "usage.invalid", "нужен запрос: /api/search?q=<текст>");
        }
        const strParam = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
        const numParam = (name: string): number | undefined => {
          const raw = url.searchParams.get(name);
          if (raw === null) return undefined;
          const n = Number(raw);
          return Number.isFinite(n) ? n : undefined;
        };
        const outcome = await loadSearch(runCli, q, {
          limit: numParam("n"),
          offset: numParam("offset"),
          budget: numParam("budget"),
          kind: strParam("kind"),
          tag: strParam("tag"),
          layer: strParam("layer"),
          since: strParam("since"),
          anchor: strParam("anchor"),
          mode: strParam("mode"),
          why: url.searchParams.get("why") !== null,
          reach: strParam("reach"),
          repo: strParam("repo"),
          session: strParam("session"),
          embedTimeoutMs: numParam("embed-timeout"),
          sources: numParam("sources"),
        });
        return writeResponse(outcome);
      }
      switch (url.pathname) {
        case "/api/boot": {
          const schemaReady = db.has("nodes") && db.has("edges") && db.has("oplog");
          const payload: BootPayload = {
            slug: workspace.slug,
            db_path: opts.dbPath,
            tier,
            nodes: schemaReady
              ? (db.one<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE deleted_at IS NULL")?.n ?? 0)
              : 0,
            edges: schemaReady
              ? (db.one<{ n: number }>("SELECT count(*) AS n FROM edges WHERE deleted_at IS NULL")?.n ?? 0)
              : 0,
            node_limit: nodeLimit,
            read_only: !writable,
            write_ops: WRITE_OPS,
            write_fields: UPDATE_FIELDS,
            schema_ready: schemaReady,
            version: VIZ_VERSION,
          };
          return json(payload);
        }
        case "/api/graph":
          return json(
            buildGraph(db, {
              nodeLimit: intParam(url, "limit", nodeLimit, nodeLimit),
              edgeLimit,
            }),
          );
        case "/api/ready":
          return json(
            buildReady(db, {
              scope: workspace.scope,
              weights: workspace.weights,
              limit: intParam(url, "n", 50, 500),
            }),
          );
        case "/api/board":
          return json(buildBoard(db, { scope: workspace.scope }));
        case "/api/oplog":
          return json(buildTimeline(db, { limit: intParam(url, "n", 100, 1000) }));
        case "/api/kb": {
          const layerRaw = url.searchParams.get("layer");
          const layer =
            layerRaw !== null && /^[0-3]$/.test(layerRaw) ? Number(layerRaw) : undefined;
          return json(
            buildKb(db, {
              kinds: url.searchParams.get("kind") ?? undefined,
              layer,
              reach: url.searchParams.get("reach") ?? undefined,
              repo: url.searchParams.get("repo") ?? undefined,
              q: url.searchParams.get("q") ?? undefined,
              limit: intParam(url, "limit", KB_LIMIT, KB_LIMIT),
            }),
          );
        }
        case "/api/health":
          return json(buildHealth(db, { slug: workspace.slug, dbPath: opts.dbPath }));
        case "/api/routing":
          return json(buildRouting(db));
        case "/api/decisions":
          return json(buildDecisions(db));
        default:
          break;
      }

      const asset = getAsset(url.pathname);
      if (asset !== undefined) {
        return new Response(asset.body, {
          headers: {
            "content-type": asset.type,
            // Ассеты вшиты в бинарь и меняются только вместе с ним; в дороге
            // между localhost и браузером кешировать их незачем.
            "cache-control": "no-store",
            ...SECURITY_HEADERS,
          },
        });
      }
      stats.errors++;
      return fail(404, "notfound", `нет маршрута ${url.pathname}`);
    } catch (error) {
      stats.errors++;
      const msg = error instanceof Error ? error.message : String(error);
      return fail(500, "internal", msg);
    }
  };

  const server = Bun.serve({
    port: opts.port ?? 7788,
    hostname: opts.hostname ?? "127.0.0.1",
    development: false,
    fetch: handle,
  });

  const hostname = server.hostname ?? "127.0.0.1";
  const port = server.port ?? (opts.port ?? 7788);
  return {
    url: `http://${hostname}:${port}/`,
    port,
    hostname,
    dbPath: opts.dbPath,
    workspace,
    tier,
    assetBytes: assetBytes(),
    writable,
    stats,
    stop(): void {
      server.stop(true);
      db.close();
    },
  };
}
