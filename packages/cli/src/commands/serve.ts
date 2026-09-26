/**
 * `myc serve` — сервер команды (M4): HTTP, админка, Postgres.
 *
 * ЧЕМ ОН ОТЛИЧАЕТСЯ ОТ `myc viz`. viz — это личный просмотрщик ЛОКАЛЬНОЙ базы:
 * слушает 127.0.0.1, ничего не спрашивает, потому что спрашивать не у кого —
 * за клавиатурой тот же человек, чья это база. serve стоит в сети и служит
 * команде: у него Postgres, арендаторы и токены, и он закрыт по умолчанию.
 *
 * ТРИ РЕЖИМА В ОДНОЙ КОМАНДЕ, И ЭТО НАМЕРЕННО. Выдать токен, посмотреть
 * список, отозвать — действия администратора того же сервера, и отдельное
 * дерево команд (`myc token add/ls/rm`) означало бы новую поверхность ради
 * трёх глаголов. Здесь они флагами: команда что-то одно делает и выходит, а
 * без них — поднимает сервер и ждёт сигнала.
 *
 * СЕКРЕТ ПЕЧАТАЕТСЯ ОДИН РАЗ. В базе лежит только его хеш (auth.ts), и
 * повторно узнать токен нельзя — ни человеку, ни серверу. Поэтому вывод
 * `--add-token` говорит об этом прямо, а не оставляет догадываться.
 */

import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
// Схема едет ВНУТРИ бинаря: контейнеру иначе пришлось бы возить psql и копию
// файла, а «быстрый деплой» — это когда разворачивают одну вещь, а не три.
import POSTGRES_DDL from "../../../../db/schema.postgres.sql" with { type: "text" };
import { addToken, listTokens, revokeToken } from "@myc/server/auth";
import { startHttpServer } from "@myc/server";
import { CLI_VERSION } from "../index.ts";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

export interface ServeDeps {
  readonly write: (s: string) => void;
  /** Ожидание сигнала — тот же приём, что у viz: в тестах подменяется. */
  readonly wait: () => Promise<string>;
}

export interface ServeStopped {
  readonly url: string;
  readonly port: number;
  readonly pg: boolean;
  readonly signal: string;
  readonly uptime_ms: number;
}

export interface TokenAdded {
  readonly id: string;
  readonly tenant: string;
  readonly subject: string;
  /** Секрет. Печатается один раз — в базе его нет. */
  readonly token: string;
}

function waitForSignal(): Promise<string> {
  return new Promise((resolve) => {
    const done = (sig: string) => (): void => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(sig);
    };
    const onInt = done("SIGINT");
    const onTerm = done("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
  });
}

function str(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(ctx: CommandContext, name: string): number | undefined {
  const v = ctx.flags[name];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function createServeCommand(deps: ServeDeps = { write: (s) => process.stdout.write(s), wait: waitForSignal }): Command {
  return {
    name: "serve",
    summary: "run the team server: HTTP API and the admin page over Postgres",
    flags: [
      { name: "port", value: "number", description: "port (default 8080)" },
      { name: "host", value: "string", description: "bind address (default 127.0.0.1; use 0.0.0.0 behind a proxy)" },
      { name: "pg", value: "string", description: "Postgres URL; without it the server is a local health slice over SQLite" },
      { name: "add-tenant", value: "string", description: "register a tenant: <id>[:title]; tokens are issued under it" },
      { name: "add-token", value: "string", description: "mint an access token: <tenant>:<name>; the secret is printed once" },
      { name: "revoke-token", value: "string", description: "revoke a token by its id" },
      { name: "tokens", description: "list tokens: who holds them and when each was last used, never the secrets" },
      { name: "apply-schema", description: "create the schema in an EMPTY database and exit; an existing one is left alone" },
      { name: "health-probe", description: "ask a server already running on this host whether it is alive, and exit 0 or 1" },
    ],
    help:
      "The team server is closed by default: every route except the liveness probe (/v1/health) " +
      "needs an access token, and the admin page at /v1/admin asks for one in a form and then " +
      "keeps it in an HttpOnly, SameSite=Strict cookie.\n\n" +
      "A token is issued per person or agent under one tenant: `--add-token acme:anna` prints the " +
      "secret once and stores only its sha256 — a copy of the database gives no access, and " +
      "nobody can read the secret back. Revoking is one row: `--revoke-token tok_…`.\n\n" +
      "TLS is the deployment's job, not the server's: put it behind a reverse proxy and let it " +
      "set X-Forwarded-Proto, so the session cookie is issued with Secure.\n\n" +
      "Without --pg there are no tenants and no tokens: the server then serves the health trio " +
      "over the local SQLite workspace and binds 127.0.0.1, as `myc viz` does.",
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const port = num(ctx, "port") ?? Number(process.env["MYC_SERVE_PORT"] ?? 8080);

      // ПРОБА ЖИВОСТИ ДЛЯ КОНТЕЙНЕРА. В образе нет ни curl, ни wget — и не
      // должно быть: чем меньше в нём лежит, тем меньше в нём чинить. Пробу
      // делает сам бинарь, и спрашивает он единственный открытый маршрут,
      // ничего не зная о базе: упавший Postgres — не повод перезапускать
      // процесс, который честно отвечает «жив».
      if (ctx.flags["health-probe"] === true) {
        const at = `http://127.0.0.1:${port}/v1/health`;
        try {
          const res = await fetch(at, { signal: AbortSignal.timeout(2000) });
          if (!res.ok) {
            return failure("degraded.not_alive", `${at} answered ${res.status}`, ExitCode.DEGRADED);
          }
          const body = (await res.json()) as { ok?: boolean; uptime_s?: number };
          return { ok: true, data: { alive: body.ok === true, uptime_s: body.uptime_s ?? null, url: at } };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return failure("degraded.not_alive", `${at} did not answer: ${msg}`, ExitCode.DEGRADED);
        }
      }

      const pgUrl = str(ctx, "pg") ?? process.env["MYC_PG_URL"];
      const addTenant = str(ctx, "add-tenant");
      const addSpec = str(ctx, "add-token");
      const revokeId = str(ctx, "revoke-token");
      const wantList = ctx.flags["tokens"] === true;
      const applySchema = ctx.flags["apply-schema"] === true;

      if (
        (addSpec !== undefined || addTenant !== undefined || revokeId !== undefined || wantList || applySchema) &&
        pgUrl === undefined
      ) {
        return failure("precond.no_pg", "tokens live in Postgres: pass --pg <url> (or MYC_PG_URL)", ExitCode.PRECOND);
      }

      let pg: PostgresDriver | undefined;
      try {
        if (pgUrl !== undefined) pg = openPostgres(pgUrl);

        if (applySchema) {
          // Только на ПУСТОЙ базе. Накат поверх живой — это миграция, у неё
          // другие правила (порядок, проверки, откат), и делать её молча
          // «на всякий случай» при каждом старте контейнера нельзя.
          const [existing] = await pg!.raw<{ t: string | null }>("SELECT to_regclass('public.nodes')::text AS t");
          if (existing?.t !== null && existing?.t !== undefined) {
            return { ok: true, data: { applied: false, reason: "the database already has a schema" } };
          }
          // Кто накатил — в учёте миграций. set_config идёт ОДНОЙ строкой с
          // DDL, потому что это одно соединение пула: отдельным запросом
          // настройка досталась бы другому, и база записала бы «psql».
          await pg!.raw(`SELECT set_config('myc.by_version', '${CLI_VERSION.replace(/'/g, "''")}', false);\n${POSTGRES_DDL}`);
          // BIGINT приходит из Postgres СТРОКОЙ (64 бита не влезают в number
          // без потерь, и драйвер не угадывает). В JSON-ответе версия схемы —
          // число, как и везде в myc, поэтому приведение здесь явное.
          const [v] = await pg!.raw<{ v: string | null }>("SELECT max(version) AS v FROM schema_migrations");
          return { ok: true, data: { applied: true, schema: v?.v == null ? null : Number(v.v) } };
        }

        if (addTenant !== undefined) {
          const at = addTenant.indexOf(":");
          const id = at < 0 ? addTenant : addTenant.slice(0, at);
          const title = at < 0 ? "" : addTenant.slice(at + 1);
          if (id.length === 0) {
            return failure("usage.invalid", `--add-tenant expects <id>[:title], got '${addTenant}'`, ExitCode.USAGE);
          }
          const rows = await pg!.raw<{ id: string }>(
            `INSERT INTO tenants (id, title, created_at) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING RETURNING id`,
            [id, title, Date.now()],
          );
          return { ok: true, data: { tenant: id, title, created: rows.length > 0 } };
        }

        if (addSpec !== undefined) {
          const at = addSpec.indexOf(":");
          if (at <= 0 || at === addSpec.length - 1) {
            return failure("usage.invalid", `--add-token expects <tenant>:<name>, got '${addSpec}'`, ExitCode.USAGE);
          }
          const tenant = addSpec.slice(0, at);
          const subject = addSpec.slice(at + 1);
          // Незнакомый арендатор — ошибка человека, а не сбой: внешний ключ
          // скажет то же самое, но словами базы и кодом internal.unexpected.
          const known = await pg!.raw<{ id: string }>("SELECT id FROM tenants WHERE id = $1", [tenant]);
          if (known.length === 0) {
            return failure(
              "notfound.tenant",
              `no tenant '${tenant}' on this server`,
              ExitCode.NOTFOUND,
              `register it first: myc serve --pg <url> --add-tenant ${tenant}`,
            );
          }
          const minted = await addToken(pg!, tenant, subject);
          const data: TokenAdded = { id: minted.id, tenant, subject, token: minted.token };
          return { ok: true, data };
        }

        if (revokeId !== undefined) {
          const gone = await revokeToken(pg!, revokeId);
          if (!gone) {
            return failure("notfound.token", `no live token with id '${revokeId}'`, ExitCode.NOTFOUND);
          }
          return { ok: true, data: { id: revokeId, revoked: true } };
        }

        if (wantList) {
          return { ok: true, data: { tokens: await listTokens(pg!) } };
        }

        const t0 = Date.now();
        const server = startHttpServer({
          port,
          ...(str(ctx, "host") !== undefined ? { host: str(ctx, "host")! } : {}),
          ...(ctx.globals.directory !== undefined ? { dir: ctx.globals.directory } : {}),
          ...(ctx.globals.db !== undefined ? { db: ctx.globals.db } : {}),
          ...(pgUrl !== undefined ? { pg: pgUrl } : {}),
        });
        if (!ctx.globals.json && !ctx.globals.ndjson && !ctx.globals.quiet) {
          deps.write(
            `myc serve · ${pgUrl === undefined ? "sqlite (local health slice)" : "postgres (team server)"}\n` +
              `${server.url}${pgUrl === undefined ? "" : `  admin: ${server.url}/v1/admin`}\n` +
              // Куда идти агенту, а не человеку: данные лежат под /v1/ws/:ws/…
              // и пока только на чтение — об этом честнее сказать сразу, чем
              // дать узнать это кодом 405 в бою.
              `${pgUrl === undefined ? "" : `workspace data (read-only): ${server.url}/v1/ws\n`}` +
              `${pgUrl === undefined ? "no tokens: without --pg the server has no tenants and binds 127.0.0.1" : "every route but /v1/health needs a token: --add-token <tenant>:<name>"}\n` +
              "Ctrl-C to stop\n",
          );
        }
        const signal = await deps.wait();
        server.stop();
        const data: ServeStopped = {
          url: server.url,
          port: server.port,
          pg: pgUrl !== undefined,
          signal,
          uptime_ms: Date.now() - t0,
        };
        return { ok: true, data };
      } finally {
        await pg?.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as Record<string, unknown>;
      if (typeof d["token"] === "string") {
        const t = raw as TokenAdded;
        return (
          `token ${t.id} for ${t.subject} @ ${t.tenant}\n` +
          `${t.token}\n` +
          "This is the only time the secret is shown: the server keeps its sha256, not the token.\n"
        );
      }
      if (Array.isArray(d["tokens"])) {
        const list = d["tokens"] as Array<{
          id: string;
          tenant: string;
          subject: string;
          last_used_at: number | null;
          revoked_at: number | null;
        }>;
        if (list.length === 0) return "no tokens: nobody can reach this server yet\n";
        return (
          list
            .map(
              (t) =>
                `${t.id}  ${t.tenant}/${t.subject}  ` +
                `${t.revoked_at !== null ? "revoked" : t.last_used_at === null ? "never used" : `last used ${new Date(t.last_used_at).toISOString().slice(0, 16).replace("T", " ")}`}`,
            )
            .join("\n") + "\n"
        );
      }
      if (d["revoked"] === true) return `token ${String(d["id"])} revoked\n`;
      if (typeof d["created"] === "boolean") {
        return d["created"] === true
          ? `tenant ${String(d["tenant"])} registered\n`
          : `tenant ${String(d["tenant"])} already there\n`;
      }
      if (typeof d["alive"] === "boolean") {
        return `alive · uptime ${String(d["uptime_s"] ?? "?")}s\n`;
      }
      if (typeof d["applied"] === "boolean") {
        return d["applied"] === true
          ? "schema created\n"
          : `schema left alone: ${String(d["reason"])}\n`;
      }
      const s = raw as ServeStopped;
      return `stopped on ${s.signal} after ${Math.round(s.uptime_ms / 1000)}s\n`;
    },
  };
}
