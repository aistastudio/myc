/**
 * `myc viz` — просмотрщик графа и статистики (§3.20, §10).
 *
 * Ранняя урезанная версия того, что в M4 станет полноценной визуализацией:
 * четыре экрана (граф, очередь ready с раскрытием слагаемых S21, таймлайн
 * оплога, здоровье) и ничего сверх них.
 *
 * Команда долгоживущая, и это единственное её отличие от остальных: баннер
 * печатается сразу (иначе сервер молча висит), а рамка CLI получает конверт
 * с итогом уже на остановке. Останов — SIGINT/SIGTERM.
 *
 * База открывается ТОЛЬКО НА ЧТЕНИЕ (см. @myc/web db.ts): просмотрщик может
 * висеть часами, и он обязан не мешать CLI писать. Мутирующих маршрутов на
 * сервере не существует вовсе — прятать кнопки было бы удобством, а не
 * запретом.
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
  read_only: true;
}

export function createVizCommand(deps: VizDeps = realVizDeps): Command {
  return {
    name: "viz",
    summary: "read-only web viewer: graph, ready queue, oplog, health",
    help:
      "Поднимает локальный сервер и открывает базу ТОЛЬКО НА ЧТЕНИЕ: CLI может писать, " +
      "пока просмотрщик открыт. Четыре экрана — граф (Canvas2D, лэйаут в Web Worker), " +
      "очередь ready со слагаемыми S21, таймлайн оплога, здоровье и деградации. " +
      "Интерфейс вшит в бинарь: ни одного внешнего запроса.",
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
          `воркспейс не инициализирован: нет ${dbPath}`,
          ExitCode.NOWS,
          "myc init",
        );
      }

      const port = flagNum(ctx, "port") ?? 7788;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return failure("usage.invalid", `неверный порт '${port}'`, ExitCode.USAGE);
      }
      const limit = flagNum(ctx, "limit") ?? 25_000;
      if (!Number.isInteger(limit) || limit < 1) {
        return failure("usage.invalid", `неверный --limit '${limit}'`, ExitCode.USAGE);
      }
      if (limit > 25_000) {
        // Решение S18: выше 25k лэйаут в браузере не считается — честнее
        // сказать вслух, чем молча выдать неработающую страницу.
        ctx.warn(
          "viz.limit_capped",
          `--limit ${limit} выше потолка локального лэйаута 25000 (S18) — взято 25000`,
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
            `порт ${port} уже занят: ${msg}`,
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
          "в базе нет таблиц myc — экраны покажут «пусто»; проверьте myc init / myc doctor --schema",
        );
      }

      if (!ctx.globals.json && !ctx.globals.ndjson && !ctx.globals.quiet) {
        const kb = (server.assetBytes / 1024).toFixed(0);
        deps.write(
          `myc viz · ws=${server.workspace.slug} · ${boot.nodes} узлов / ${boot.edges} рёбер\n` +
            `база ${dbPath} · открыта только на чтение (CLI может писать)\n` +
            `интерфейс ${kb} КБ вшит в бинарь · ноль внешних запросов\n` +
            `${server.url}${ctx.flags["open"] === true ? "  (открыт в браузере)" : ""}\n` +
            `Ctrl-C — остановить\n`,
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
        read_only: true,
      };
      return { ok: true, data, meta: { requests: data.requests, uptime_ms: data.uptime_ms } };
    },
    renderHuman: (raw) => {
      const d = raw as VizStopped;
      return `viz остановлен (${d.signal}) · ${d.requests} запросов, ${d.errors} ошибок · ${Math.round(d.uptime_ms / 1000)}s\n`;
    },
  };
}
