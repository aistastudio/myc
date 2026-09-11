/**
 * `myc viz` — локальный веб-интерфейс воркспейса (§3.20, §10, веха M7).
 *
 * Экраны — ровно те, что во вкладках клиента (TABS в @myc/web client/app.ts):
 * справка собирается из VIZ_SCREENS, а viz.test.ts сверяет этот список с
 * клиентом. Раньше справка обещала «четыре экрана» и «только чтение», когда
 * их было десять и появилась запись, — текст отстал от кода на целую веху.
 *
 * Команда долгоживущая, и это единственное её отличие от остальных: баннер
 * печатается сразу (иначе сервер молча висит), а рамка CLI получает конверт
 * с итогом уже на остановке. Останов — SIGINT/SIGTERM.
 *
 * Чтение идёт своим соединением, открытым ТОЛЬКО НА ЧТЕНИЕ (см. @myc/web
 * db.ts): просмотрщик может висеть часами и не мешает CLI писать. Правки
 * из интерфейса сервер сам не пишет: каждая уходит в тот же движок команд,
 * что обслуживает терминал (@myc/web mutate.ts) — оплог, ACL, часы полей.
 * read_only в итоге — то, что сервер сказал о себе (VizServer.writable).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startVizServer, VizDbError, type VizServer } from "@myc/web";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, ...(hint !== undefined ? { hint } : {}) };
}

function flagStr(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagNum(ctx: CommandContext, name: string): number | undefined {
  const v = ctx.flags[name];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Ждём сигнал; обработчики снимаются, чтобы повторный запуск в том же
 *  процессе (тесты, `myc serve` рядом) не копил слушателей. */
function waitForSignal(): Promise<string> {
  return new Promise((resolveSignal) => {
    const done = (sig: string) => (): void => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolveSignal(sig);
    };
    const onInt = done("SIGINT");
    const onTerm = done("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // нет чем открыть — не повод считать команду неуспешной, URL напечатан
  }
}

export interface VizDeps {
  start(options: {
    dbPath: string;
    dir: string;
    port: number;
    hostname: string;
    nodeLimit: number;
  }): VizServer;
  /** Разрешается на остановке; тесты подставляют мгновенную. */
  wait(): Promise<string>;
  open(url: string): void;
  write(text: string): void;
}

export const realVizDeps: VizDeps = {
  start: (o) =>
    startVizServer({
      dbPath: o.dbPath,
      dir: o.dir,
      port: o.port,
      hostname: o.hostname,
      nodeLimit: o.nodeLimit,
    }),
  wait: waitForSignal,
  open: openBrowser,
  write: (text) => {
    process.stdout.write(text);
  },
};

interface VizStopped {
  url: string;
  port: number;
  db: string;
  slug: string;
  nodes: number;
  edges: number;
  requests: number;
  errors: number;
  uptime_ms: number;
  signal: string;
  /** Сервер отказывал в записи (POST → 405). По умолчанию запись включена. */
  read_only: boolean;
}

/**
 * Экраны интерфейса в порядке вкладок: [id вкладки в клиенте, как её назвать
 * в справке]. Новая вкладка без строки здесь роняет viz.test.ts.
 */
export const VIZ_SCREENS: readonly (readonly [tab: string, help: string])[] = [
  ["graph", "graph (Canvas2D, layout in a Web Worker)"],
  ["ready", "ready queue with the S21 score terms"],
  ["board", "board"],
  ["kb", "knowledge base"],
  ["timeline", "oplog timeline"],
  ["search", "search"],
  ["routing", "model routing"],
  ["decisions", "decisions"],
  ["bootstrap", "bootstrap blocks"],
  ["health", "health and degradations"],
];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

export function createVizCommand(deps: VizDeps = realVizDeps): Command {
  const count = NUMBER_WORDS[VIZ_SCREENS.length] ?? String(VIZ_SCREENS.length);
  return {
    name: "viz",
    summary: "local web interface: graph, queue, board, cards, search, health — edits go through the CLI",
    help:
      `Starts a local server (127.0.0.1 unless --host) with the web interface. ` +
      `${count[0]!.toUpperCase()}${count.slice(1)} screens — ${VIZ_SCREENS.map(([, h]) => h).join(", ")}; ` +
      "a task opens as a card with its thread. " +
      "Reads go through a connection opened READ-ONLY, so the CLI keeps writing while the page is open. " +
      "Edits from the page — create a task or a note, change its fields, claim, release, close, reopen, assign, " +
      "priority, extend, cancel, set or remove a bootstrap block — are not written by the server itself: " +
      "each runs through the same command engine as the terminal (oplog, ACL, field clocks), and an edit " +
      "made against a stale copy is refused, not merged. " +
      "The UI is embedded in the binary: zero external requests.",
    flags: [
      { name: "port", short: "p", value: "number", description: "port (default 7788)" },
      { name: "host", value: "string", description: "bind address (default 127.0.0.1)" },
      { name: "open", description: "open the page in the default browser" },
      { name: "limit", value: "number", description: "node cap for local layout (default 25000)" },
    ],
    handler: async (ctx) => {
      const dir = resolve(ctx.globals.directory ?? process.cwd());
      const dbPath = ctx.globals.db ?? join(dir, ".myc", "myc.db");
      if (!existsSync(dbPath)) {
        return failure(
          "ws.not_initialized",
          `workspace not initialized: no ${dbPath}`,
          ExitCode.NOWS,
          "myc init",
        );
      }

      const port = flagNum(ctx, "port") ?? 7788;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return failure("usage.invalid", `invalid port '${port}'`, ExitCode.USAGE);
      }
      const limit = flagNum(ctx, "limit") ?? 25_000;
      if (!Number.isInteger(limit) || limit < 1) {
        return failure("usage.invalid", `invalid --limit '${limit}'`, ExitCode.USAGE);
      }
      if (limit > 25_000) {
        // Решение S18: выше 25k лэйаут в браузере не считается — честнее
        // сказать вслух, чем молча выдать неработающую страницу.
        ctx.warn(
          "viz.limit_capped",
          `--limit ${limit} is above the local layout cap of 25000 (S18) — using 25000`,
        );
      }
      const hostname = flagStr(ctx, "host") ?? "127.0.0.1";

      const t0 = Date.now();
      let server: VizServer;
      try {
        server = deps.start({
          dbPath,
          dir,
          port,
          hostname,
          nodeLimit: Math.min(limit, 25_000),
        });
      } catch (error) {
        if (error instanceof VizDbError) {
          return failure("db.readonly_open", error.message, ExitCode.ERR, "myc doctor");
        }
        const msg = error instanceof Error ? error.message : String(error);
        if (/EADDRINUSE|address already in use/i.test(msg)) {
          return failure(
            "conflict.port",
            `port ${port} is already in use: ${msg}`,
            ExitCode.CONFLICT,
            "myc viz --port 7789",
          );
        }
        return failure("internal.unexpected", msg, ExitCode.ERR);
      }

      const boot = (await fetch(`${server.url}api/boot`).then((r) => r.json())) as {
        nodes: number;
        edges: number;
        schema_ready: boolean;
      };
      if (!boot.schema_ready) {
        ctx.warn(
          "schema.missing",
          "the database has no myc tables — screens will show 'empty'; check myc init / myc doctor --schema",
        );
      }

      if (!ctx.globals.json && !ctx.globals.ndjson && !ctx.globals.quiet) {
        const kb = (server.assetBytes / 1024).toFixed(0);
        deps.write(
          `myc viz · ws=${server.workspace.slug} · ${boot.nodes} nodes / ${boot.edges} edges\n` +
            `db ${dbPath} · read-only connection for reads (the CLI can still write)` +
            `${server.writable ? "; edits go through the CLI's write path" : "; edits are off"}\n` +
            `UI ${kb} KB embedded in the binary · zero external requests\n` +
            `${server.url}${ctx.flags["open"] === true ? "  (opened in the browser)" : ""}\n` +
            `Ctrl-C to stop\n`,
        );
      }
      if (ctx.flags["open"] === true) deps.open(server.url);

      const signal = await deps.wait();
      server.stop();

      const data: VizStopped = {
        url: server.url,
        port: server.port,
        db: dbPath,
        slug: server.workspace.slug,
        nodes: boot.nodes,
        edges: boot.edges,
        requests: server.stats.requests,
        errors: server.stats.errors,
        uptime_ms: Date.now() - t0,
        signal,
        read_only: !server.writable,
      };
      return { ok: true, data, meta: { requests: data.requests, uptime_ms: data.uptime_ms } };
    },
    renderHuman: (raw) => {
      const d = raw as VizStopped;
      return `viz stopped (${d.signal}) · ${d.requests} ${d.requests === 1 ? "request" : "requests"}, ${d.errors} ${d.errors === 1 ? "error" : "errors"} · ${Math.round(d.uptime_ms / 1000)}s\n`;
    },
  };
}
