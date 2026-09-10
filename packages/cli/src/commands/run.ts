/**
 * `myc run -- <cmd>` и `myc queue` — общая для машины очередь тяжёлых команд
 * (эпик memory-14qyv1gmacef, MVP memory-n2r3krccqyj6).
 *
 * ЗАЧЕМ. На одной машине параллельно работают несколько агентов, и каждый
 * гоняет тяжёлое: полный bun test (~4 мин на все ядра), сборки, бенчмарки.
 * 2026-09-10 при загрузке 6–7 падали замеры бюджетов И1, а прогоны шли вдвое
 * дольше. `myc run` ставит команду в очередь, ждёт слот и выполняет её с
 * унаследованными stdin/stdout/stderr; `myc queue` показывает, кто
 * выполняется и кто ждёт. Хранилище, слоты и живость — ../run-queue.ts.
 *
 * STDOUT ПРИНАДЛЕЖИТ КОМАНДЕ. myc в человеческом режиме в stdout не пишет
 * ничего: ожидание, передача слота и потеря аренды идут в stderr, блок WARN —
 * тоже (`machineStdout`: так каркас уводит его из stdout). Иначе
 * `myc run -- cat x > y` получил бы в файл хвост от myc.
 *
 * КОД ВЫХОДА — КОД КОМАНДЫ. Коды myc (§2.2) здесь пересекаются с кодами
 * команды неизбежно, как у `env`/`timeout`: 0..255 команды отдаются как есть,
 * смерть от сигнала — 128+номер (130 SIGINT, 143 SIGTERM), команда не найдена
 * — 127, не исполняема — 126. Собственные отказы myc — 2 (usage) и 9
 * (слот не получен за --max-wait).
 *
 * --max-wait ПО УМОЛЧАНИЮ 5 МИНУТ. Агент зовёт тяжёлое Bash-инструментом
 * Claude Code: тот обрывает команду через 2 мин по умолчанию и через 10 мин
 * максимум, и обрывает ВСЁ — ожидание вместе с работой. Полный bun test сам
 * по себе ~4 мин, то есть под умолчанием инструмента не помещается вовсе, и
 * агент, запускающий тяжёлое, уже просит таймаут 10 мин. Тогда 10 − 4 − 1
 * (запас на нагрузку и хвост) = 5 мин ожидания — самое длинное, после
 * которого команда ещё успевает отработать внутри того же вызова. Дольше —
 * инструмент убьёт уже начавшуюся работу, потратив слот впустую; короче —
 * второй агент за полным прогоном первого получал бы отказ почти всегда. Под
 * умолчанием инструмента (2 мин) раньше сработает он — но строки ожидания в
 * stderr уже скажут, чего ждали и за кем.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { constants, homedir, hostname } from "node:os";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import {
  DEFAULT_LANE,
  enqueue,
  heartbeatMs,
  heldLanes,
  isValidLane,
  liveness,
  listLane,
  mintHolder,
  openQueue,
  openQueueIfExists,
  queueDbPath,
  reap,
  release,
  renew,
  setChild,
  slotsEnvName,
  slotsFor,
  StaleWatch,
  ticketInput,
  timingsFromEnv,
  tryGrant,
  withHeldLane,
  type RemovedTicket,
  type TicketRow,
} from "../run-queue.ts";

/** Умолчание --max-wait — обоснование в шапке файла. */
export const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

/** Строка ожидания в stderr — раз в 10 с (первая — сразу при постановке). */
export const DEFAULT_PROGRESS_MS = 10_000;

/** Сигналы, которые `myc run` пересылает команде. */
const RELAYED: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

type Env = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------

/** 90s, 5m, 1.5h, 500ms; голое число — секунды. undefined — не длительность. */
export function parseWait(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * mult);
}

/** 0.4s, 12s, 4m10s, 1h02m. */
export function fmtDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${(v / 1000).toFixed(1)}s`;
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Длинный путь в аргументе — `…/имя`: в строке ожидания агенту нужно, ЧТО
 * запущено (`bun …/build.ts`), а не каталог временных файлов. Полный argv
 * остаётся в `--json` у `myc queue`.
 */
function compactArg(arg: string, index: number): string {
  const slash = arg.lastIndexOf("/");
  if (slash < 0 || arg.endsWith("/")) return arg;
  if (index === 0) return arg.slice(slash + 1);
  return arg.length > 24 && !arg.startsWith("-") ? `…/${arg.slice(slash + 1)}` : arg;
}

/** argv одной строкой, как её набрали бы в шелле; длинное — с многоточием. */
export function commandLine(argv: readonly string[], max = 80): string {
  const text = argv
    .map(compactArg)
    .map((a) => (/^[\w@%+=:,./…-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))
    .join(" ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function argvOf(row: TicketRow): string[] {
  try {
    const v = JSON.parse(row.argv) as unknown;
    return Array.isArray(v) ? v.map(String) : [row.argv];
  } catch {
    return [row.argv];
  }
}

/** Кто это: команда, каталог, сессия, терминал оркестратора, pid, сколько идёт. */
export function describeTicket(row: TicketRow, now: number): string {
  const parts = [`'${commandLine(argvOf(row), 60)}' in ${tildify(row.cwd)}`];
  if (row.session !== "") parts.push(`session ${row.session.slice(0, 8)}`);
  if (row.terminal !== "") parts.push(`orca ${row.terminal.slice(0, 13)}`);
  parts.push(`pid ${row.pid}`);
  parts.push(
    row.state === "running" && row.started_at !== null
      ? `running ${fmtDuration(now - row.started_at)}`
      : `waiting ${fmtDuration(now - row.enqueued_at)}`,
  );
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Сигналы
// ---------------------------------------------------------------------------

/**
 * Пересылка сигналов. Пока команды нет (ждём слот), сигнал будит ожидание и
 * отменяет его; когда она есть — уходит ей, а `myc run` ждёт её выхода и
 * отдаёт ЕЁ код. Команда остаётся в группе процессов myc (без setsid): иначе
 * у неё отнимается терминал, и интерактивная команда встанет на SIGTTIN.
 * Цена — Ctrl+C в терминале доходит до команды и напрямую, и пересылкой;
 * для тяжёлых команд (тесты, сборки) первый SIGINT и так их завершает.
 */
class SignalRelay {
  received: NodeJS.Signals | null = null;
  child: Subprocess | null = null;
  #wake: (() => void) | null = null;
  readonly #handlers = new Map<NodeJS.Signals, () => void>();

  constructor() {
    for (const sig of RELAYED) {
      const handler = (): void => this.#on(sig);
      this.#handlers.set(sig, handler);
      process.on(sig, handler);
    }
  }

  #on(sig: NodeJS.Signals): void {
    this.received ??= sig;
    const child = this.child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig);
      } catch {
        // уже вышла — нечего пересылать
      }
    }
    this.#wake?.();
  }

  /** Сон ожидания, который сигнал обрывает сразу, а не через такт опроса. */
  sleep(ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        done();
      }, Math.max(1, ms));
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        done();
      };
    });
  }

  dispose(): void {
    for (const [sig, handler] of this.#handlers) process.off(sig, handler);
    this.#handlers.clear();
  }
}

function signalNumber(sig: string): number {
  return (constants.signals as Record<string, number | undefined>)[sig] ?? 1;
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export interface RunData {
  readonly lane: string;
  readonly command: string;
  readonly exit: number;
  /** id билета; null — вложенный запуск в слоте предка. */
  readonly ticket: number | null;
  readonly slots: number;
  /** Ждал ли слота вообще (была ли очередь). */
  readonly queued: boolean;
  readonly waited_ms: number;
  readonly ran_ms: number;
  /** Вложенный `myc run` той же полосы: исполнен сразу, в слоте предка. */
  readonly reentrant: boolean;
}

function usage(msg: string, hint?: string): CommandFailure {
  return { ok: false, code: "usage.run", msg, exit: ExitCode.USAGE, ...(hint !== undefined ? { hint } : {}) };
}

function stderrLine(text: string): void {
  process.stderr.write(`myc run: ${text}\n`);
}

interface Outcome {
  readonly exit: number;
  readonly signal: string | null;
  readonly ranMs: number;
  /** Команду не удалось запустить: ENOENT, EACCES. */
  readonly spawnError?: string;
}

async function execChild(
  argv: readonly string[],
  cwd: string,
  env: Env,
  relay: SignalRelay,
  onSpawn?: (pid: number) => void,
): Promise<Outcome> {
  const t0 = performance.now();
  let proc: Subprocess;
  try {
    proc = Bun.spawn({
      cmd: [...argv],
      cwd,
      env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
      stdio: ["inherit", "inherit", "inherit"],
    });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return {
      exit: e.code === "EACCES" ? 126 : 127,
      signal: null,
      ranMs: performance.now() - t0,
      spawnError: e.message,
    };
  }
  relay.child = proc;
  onSpawn?.(proc.pid);
  // Сигнал мог прийти между выдачей слота и запуском: переслать сейчас.
  if (relay.received !== null) {
    try {
      proc.kill(relay.received);
    } catch {
      // уже вышла
    }
  }
  await proc.exited;
  relay.child = null;
  const signal = proc.signalCode ?? null;
  return {
    exit: signal !== null ? 128 + signalNumber(signal) : (proc.exitCode ?? 1),
    signal,
    ranMs: performance.now() - t0,
  };
}

function outcomeResult(
  argv: readonly string[],
  outcome: Outcome,
  data: Omit<RunData, "exit" | "ran_ms">,
): CommandResult {
  const cmd = commandLine(argv, 60);
  if (outcome.spawnError !== undefined) {
    return {
      ok: false,
      code: outcome.exit === 126 ? "run.not_executable" : "run.not_found",
      msg: `cannot start '${cmd}': ${outcome.spawnError}`,
      exit: outcome.exit as ExitCode,
    };
  }
  if (outcome.signal !== null) {
    return {
      ok: false,
      code: "run.signal",
      msg: `'${cmd}' was killed by ${outcome.signal} after ${fmtDuration(outcome.ranMs)}`,
      exit: outcome.exit as ExitCode,
    };
  }
  if (outcome.exit !== 0) {
    return {
      ok: false,
      code: "run.exit",
      msg: `'${cmd}' exited with code ${outcome.exit} after ${fmtDuration(outcome.ranMs)}`,
      exit: outcome.exit as ExitCode,
    };
  }
  const full: RunData = { ...data, exit: 0, ran_ms: Math.round(outcome.ranMs) };
  return { ok: true, data: full };
}

type Acquired =
  | { readonly kind: "slot"; readonly ticket: TicketRow; readonly waitedMs: number; readonly queued: boolean }
  | { readonly kind: "timeout"; readonly waitedMs: number; readonly ahead: TicketRow[] }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals; readonly waitedMs: number };

interface AcquireOptions {
  readonly lane: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Env;
  readonly slots: number;
  readonly maxWaitMs: number;
  readonly progressMs: number;
  readonly relay: SignalRelay;
}

/**
 * Встать в очередь и дождаться слота. Такт опроса: убрать мёртвых (и
 * досмотренных устаревших), попробовать выдачу одним стейтментом, продлить
 * свою аренду, раз в progressMs сказать в stderr, чего ждём и за кем.
 */
async function acquire(db: Database, o: AcquireOptions): Promise<Acquired> {
  const { leaseMs, pollMs } = timingsFromEnv(o.env);
  const host = hostname();
  const input = ticketInput(o.lane, o.argv, o.cwd, o.env);
  const watch = new StaleWatch();
  const beat = heartbeatMs(leaseMs);
  // Снятый держатель, чья команда жива, — нагрузка вне очереди: сказать.
  const warnOrphans = (removed: readonly RemovedTicket[]): void => {
    for (const r of removed) {
      if (!r.orphan) continue;
      stderrLine(
        `the previous holder of the '${o.lane}' slot (pid ${r.pid}) is gone, but its command ` +
          `'${commandLine(argvOf(r), 60)}' (pid ${r.child_pid}) is still running outside the queue`,
      );
    }
  };

  warnOrphans(reap(db, o.lane, { host, watch }).removed);
  let ticket = enqueue(db, input, mintHolder(host, process.pid), o.slots, leaseMs);
  if (ticket.state === "running") return { kind: "slot", ticket, waitedMs: 0, queued: false };

  const t0 = performance.now();
  let lastRenew = Date.now();
  let nextProgress = t0;
  // Сказали ли уже, что ждём: тогда и о полученном слоте надо сказать —
  // иначе в выводе агента ожидание обрывается без развязки.
  let announced = false;
  for (;;) {
    const waited = performance.now() - t0;
    if (o.relay.received !== null) {
      release(db, ticket);
      return { kind: "signal", signal: o.relay.received, waitedMs: waited };
    }
    const now = Date.now();
    const { rows, removed } = reap(db, o.lane, { now, host, watch, selfId: ticket.id });
    warnOrphans(removed);
    const granted = tryGrant(db, ticket, o.slots, leaseMs, now);
    if (granted !== undefined) {
      const total = performance.now() - t0;
      if (announced) stderrLine(`slot acquired after ${fmtDuration(total)}; starting '${commandLine(o.argv, 60)}'`);
      return { kind: "slot", ticket: granted, waitedMs: total, queued: true };
    }
    if (!rows.some((r) => r.id === ticket.id)) {
      // Наш билет сняли как устаревший: процесс стоял (SIGSTOP, сон) дольше
      // аренды. Место потеряно честно — встаём в хвост заново.
      stderrLine("this process was stalled past its lease and lost its place; re-queued at the tail");
      ticket = enqueue(db, input, mintHolder(host, process.pid), o.slots, leaseMs, now);
      if (ticket.state === "running") return { kind: "slot", ticket, waitedMs: waited, queued: true };
      lastRenew = now;
    } else if (now - lastRenew >= beat) {
      renew(db, ticket, now);
      lastRenew = now;
    }

    if (waited >= o.maxWaitMs) {
      const ahead = listLane(db, o.lane).filter((r) => r.id !== ticket.id && (r.state === "running" || r.id < ticket.id));
      release(db, ticket);
      return { kind: "timeout", waitedMs: waited, ahead };
    }
    if (performance.now() >= nextProgress) {
      const running = rows.filter((r) => r.state === "running");
      const ahead = rows.filter((r) => r.state === "waiting" && r.id < ticket.id).length;
      const holders = running.map((r) => describeTicket(r, now)).join("; ");
      stderrLine(
        `waiting for a '${o.lane}' slot (${running.length}/${o.slots} busy, ${ahead} waiting ahead), ` +
          `waited ${fmtDuration(waited)} of max ${fmtDuration(o.maxWaitMs)}` +
          (holders !== "" ? ` — held by ${holders}` : ""),
      );
      announced = true;
      // От «сейчас», а не от прошлой отметки: после сна машины догонялка
      // выдала бы пачку строк подряд.
      nextProgress = performance.now() + o.progressMs;
    }
    await o.relay.sleep(Math.min(pollMs, Math.max(1, o.maxWaitMs - waited)));
  }
}

async function runHandler(ctx: CommandContext): Promise<CommandResult> {
  const env: Env = process.env;
  const argv = ctx.args;
  if (argv.length === 0) {
    return usage(
      "no command to run",
      "myc run [--lane heavy] [--max-wait 5m] -- <command> [args...]",
    );
  }
  const laneFlag = ctx.flags.lane;
  const lane = typeof laneFlag === "string" ? laneFlag.trim() : DEFAULT_LANE;
  if (!isValidLane(lane)) {
    return usage(`bad lane '${lane}'`, "a lane is a lowercase name: letters, digits, '-', up to 32 chars");
  }
  const waitFlag = ctx.flags["max-wait"];
  const maxWaitMs = typeof waitFlag === "string" ? parseWait(waitFlag) : DEFAULT_MAX_WAIT_MS;
  if (maxWaitMs === undefined) {
    return usage(`bad --max-wait '${String(waitFlag)}'`, "a duration: 90s, 5m, 1h, 500ms; a bare number is seconds; 0 = do not wait");
  }
  const cwd = resolve(ctx.globals.directory ?? process.cwd());
  if (!existsSync(cwd)) {
    return { ok: false, code: "notfound.dir", msg: `directory does not exist: ${cwd}`, exit: ExitCode.NOTFOUND };
  }
  const setting = slotsFor(lane, env);
  if (setting.invalid !== undefined) {
    ctx.warn("run.slots_invalid", `${setting.invalid} is not a whole number 1..256 — using ${setting.slots} slot`);
  }
  const progressRaw = Number((env.MYC_RUN_PROGRESS_MS ?? "").trim());
  const progressMs = Number.isFinite(progressRaw) && progressRaw > 0 ? progressRaw : DEFAULT_PROGRESS_MS;

  const relay = new SignalRelay();
  try {
    // Вложенный `myc run` той же полосы: слот держит предок — исполнить сразу.
    if (heldLanes(env).has(lane)) {
      const outcome = await execChild(argv, cwd, env, relay);
      return outcomeResult(argv, outcome, {
        lane,
        command: commandLine(argv),
        ticket: null,
        slots: setting.slots,
        queued: false,
        waited_ms: 0,
        reentrant: true,
      });
    }

    const path = queueDbPath();
    let db: Database;
    try {
      db = openQueue(path);
    } catch (error) {
      return {
        ok: false,
        code: "run.queue_unavailable",
        msg: `the queue at ${path} cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
        hint: "the command was NOT started; run it directly, or fix or remove the queue file when no `myc run` is active",
        exit: ExitCode.ERR,
      };
    }
    try {
      const got = await acquire(db, { lane, argv, cwd, env, slots: setting.slots, maxWaitMs, progressMs, relay });
      if (got.kind === "signal") {
        return {
          ok: false,
          code: "run.interrupted",
          msg: `${got.signal} while waiting for a '${lane}' slot (waited ${fmtDuration(got.waitedMs)}); the command was not started`,
          exit: (128 + signalNumber(got.signal)) as ExitCode,
        };
      }
      if (got.kind === "timeout") {
        const now = Date.now();
        const list = got.ahead.map((r) => `#${r.id} ${describeTicket(r, now)}`).join("; ");
        return {
          ok: false,
          code: "timeout.queue",
          msg:
            `no '${lane}' slot within ${fmtDuration(maxWaitMs)}; ${got.ahead.length} ahead` +
            (list !== "" ? `: ${list}` : ""),
          hint: `retry later, raise --max-wait (e.g. --max-wait 15m), or see the queue: myc queue`,
          exit: ExitCode.TIMEOUT,
        };
      }

      const ticket = got.ticket;
      let lost = false;
      let renewError: string | null = null;
      const { leaseMs } = timingsFromEnv(env);
      // Пока команда работает, НИЧТО в этом процессе не имеет права бросить:
      // исключение из таймера роняет процесс, команда остаётся сиротой, а
      // слот уходит следующему — ровно та гонка за ядра, от которой очередь.
      // Поэтому продление, запись pid и снятие — под try, с громким следом.
      const heartbeat = setInterval(() => {
        if (lost) return;
        try {
          if (!renew(db, ticket)) {
            lost = true;
            const msg =
              "the slot lease was lost (this process was stalled past it and a waiter took the slot); " +
              "the command keeps running outside the queue";
            stderrLine(msg);
            ctx.warn("run.slot_lost", msg);
          }
        } catch (error) {
          if (renewError === null) {
            renewError = error instanceof Error ? error.message : String(error);
            stderrLine(`cannot renew the slot lease (${renewError}); will retry`);
            ctx.warn("run.renew_failed", `cannot renew the slot lease: ${renewError}`);
          }
        }
      }, heartbeatMs(leaseMs));
      const quietly = (what: string, fn: () => unknown): void => {
        try {
          fn();
        } catch (error) {
          ctx.warn("run.queue_write_failed", `${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      let outcome: Outcome;
      try {
        outcome = await execChild(argv, cwd, withHeldLane(env, lane), relay, (pid) =>
          quietly("recording the command pid", () => setChild(db, ticket, pid)),
        );
      } finally {
        clearInterval(heartbeat);
        // Не снялся — не беда: процесс сейчас выйдет, и первый ждущий снимет
        // билет по мёртвому pid.
        quietly("releasing the slot", () => release(db, ticket));
      }
      return outcomeResult(argv, outcome, {
        lane,
        command: commandLine(argv),
        ticket: ticket.id,
        slots: setting.slots,
        queued: got.queued,
        waited_ms: Math.round(got.waitedMs),
        reentrant: false,
      });
    } finally {
      db.close();
    }
  } finally {
    relay.dispose();
  }
}

export function createRunCommand(): Command {
  return {
    name: "run",
    summary: "run a heavy command through the machine-wide queue: wait for a slot, then run it",
    flags: [
      {
        name: "lane",
        value: "string",
        description: `queue lane (default ${DEFAULT_LANE}); slots per lane: MYC_<LANE>_SLOTS, default 1`,
      },
      {
        name: "max-wait",
        value: "string",
        description: "give up waiting after this long: 90s, 5m, 1h; 0 = do not wait (default 5m)",
      },
    ],
    help:
      "Usage: myc run [--lane heavy] [--max-wait 5m] -- <command> [args...]\n\n" +
      "Several agents on one machine running full test suites, builds and benchmarks at once slow " +
      "each other down and break latency budgets. `myc run` puts the command into a queue shared by " +
      "every repository and agent of this machine user (~/.myc/queue.db), waits for a free slot " +
      "(first come, first served), then runs it with inherited stdin/stdout/stderr and exits with ITS " +
      "exit code. SIGINT/SIGTERM/SIGHUP are forwarded to the command. The slot is released on any " +
      "outcome: exit, signal, crash.\n\n" +
      "Slots: 1 per lane by default; MYC_HEAVY_SLOTS=2 (MYC_<LANE>_SLOTS) overrides it.\n\n" +
      "A holder that dies (even by SIGKILL) frees its slot at the next poll of a waiter: tickets carry " +
      "the pid and a lease renewed every 5s; a ticket whose lease expired is removed only after a " +
      "waiter saw it not renewing for 10s (a laptop waking from sleep is not a dead holder).\n\n" +
      "While waiting, a line on stderr every 10s says how many are ahead and who holds the slot " +
      "(command, directory, session, orca terminal, pid, for how long). After --max-wait (default 5m: " +
      "a 10-minute agent tool timeout minus a ~4-minute full test run minus a margin) it gives up " +
      "with exit code 9 and names what is ahead.\n\n" +
      "Exit codes: the command's own; 128+N when it died of signal N; 127 not found; 126 not " +
      "executable; 2 usage; 9 no slot within --max-wait. A `myc run` nested inside a command that " +
      "already holds the lane runs at once in its parent's slot (MYC_RUN_HELD).\n\n" +
      "Tuning (tests): MYC_RUN_LEASE_MS (30000), MYC_RUN_POLL_MS (200), MYC_RUN_PROGRESS_MS (10000).\n\n" +
      "See also: myc queue.",
    // stdout принадлежит команде: блок WARN каркас уводит в stderr.
    machineStdout: () => true,
    handler: runHandler,
    renderHuman: () => "",
  };
}

// ---------------------------------------------------------------------------
// myc queue
// ---------------------------------------------------------------------------

export interface QueueEntry {
  readonly id: number;
  readonly lane: string;
  readonly state: "running" | "waiting";
  /** alive — жив; stale — аренда просрочена, смерть не доказана; dead — снят этим вызовом. */
  readonly liveness: "alive" | "stale" | "dead";
  /** Место среди ждущих полосы, с 1; у выполняющихся null. */
  readonly position: number | null;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly pid: number;
  readonly host: string;
  readonly session: string;
  readonly terminal: string;
  readonly agent_pid: number | null;
  readonly actor: string;
  /** pid запущенной команды (у выполняющихся). */
  readonly child_pid: number | null;
  /** Снятый мёртвый держатель, чья команда ещё жива (см. RemovedTicket). */
  readonly orphan: boolean;
  readonly enqueued_at: number;
  readonly started_at: number | null;
  readonly waited_ms: number;
  readonly running_ms: number | null;
  /** Сколько назад держатель последний раз продлил аренду. */
  readonly heartbeat_ms: number;
}

export interface QueueLane {
  readonly lane: string;
  readonly slots: number;
  readonly running: number;
  readonly waiting: number;
  readonly entries: readonly QueueEntry[];
}

export interface QueueData {
  readonly db: string;
  readonly exists: boolean;
  readonly lanes: readonly QueueLane[];
  /** Мёртвые билеты (процесса нет), снятые этим вызовом. */
  readonly removed: readonly QueueEntry[];
}

function entryOf(
  row: TicketRow,
  now: number,
  state: QueueEntry["liveness"],
  position: number | null,
  orphan = false,
): QueueEntry {
  const argv = argvOf(row);
  return {
    id: row.id,
    lane: row.lane,
    state: row.state,
    liveness: state,
    position,
    command: commandLine(argv),
    argv,
    cwd: row.cwd,
    pid: row.pid,
    host: row.host,
    session: row.session,
    terminal: row.terminal,
    agent_pid: row.agent_pid,
    actor: row.actor,
    child_pid: row.child_pid,
    orphan,
    enqueued_at: row.enqueued_at,
    started_at: row.started_at,
    waited_ms: Math.max(0, (row.started_at ?? now) - row.enqueued_at),
    running_ms: row.started_at !== null ? Math.max(0, now - row.started_at) : null,
    heartbeat_ms: Math.max(0, now - row.renewed_at),
  };
}

function queueHandler(ctx: CommandContext): CommandResult {
  const env: Env = process.env;
  const laneFlag = ctx.flags.lane;
  const only = typeof laneFlag === "string" ? laneFlag.trim() : undefined;
  if (only !== undefined && !isValidLane(only)) {
    return usage(`bad lane '${only}'`, "a lane is a lowercase name: letters, digits, '-', up to 32 chars");
  }
  const path = queueDbPath();
  const db = openQueueIfExists(path);
  if (db === undefined) {
    return { ok: true, data: { db: path, exists: false, lanes: [], removed: [] } satisfies QueueData };
  }
  try {
    const now = Date.now();
    const host = hostname();
    // Один взгляд, без наблюдателя: снимаются только доказанно мёртвые
    // (процесса нет), устаревшие показываются как stale — их снимет ждущий.
    const { rows, removed } = reap(db, only, { now, host });
    const byLane = new Map<string, TicketRow[]>();
    for (const row of rows) byLane.set(row.lane, [...(byLane.get(row.lane) ?? []), row]);
    const lanes: QueueLane[] = [...byLane.entries()].map(([lane, laneRows]) => {
      let position = 0;
      const entries = laneRows.map((row) =>
        entryOf(row, now, liveness(row, now, host), row.state === "waiting" ? ++position : null),
      );
      return {
        lane,
        slots: slotsFor(lane, env).slots,
        running: entries.filter((e) => e.state === "running").length,
        waiting: entries.filter((e) => e.state === "waiting").length,
        entries,
      };
    });
    const data: QueueData = {
      db: path,
      exists: true,
      lanes,
      removed: removed.map((row) => entryOf(row, now, "dead", null, row.orphan)),
    };
    return { ok: true, data };
  } finally {
    db.close();
  }
}

function renderEntry(e: QueueEntry): string {
  const age = e.state === "running" ? fmtDuration(e.running_ms ?? 0) : fmtDuration(e.waited_ms);
  const who = [
    e.session !== "" ? `session ${e.session.slice(0, 8)}` : "",
    e.terminal !== "" ? `orca ${e.terminal.slice(0, 13)}` : "",
    `pid ${e.pid}`,
    e.child_pid !== null ? `command pid ${e.child_pid}` : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
  const pos = e.position !== null ? ` (#${e.position} in line)` : "";
  const stale =
    e.liveness === "stale" ? `  STALE: no heartbeat for ${fmtDuration(e.heartbeat_ms)}, process still exists` : "";
  return `  ${e.state.padEnd(7)} #${e.id}  ${age.padStart(6)}  ${commandLine(e.argv, 50)}  ${tildify(e.cwd)}  ${who}${pos}${stale}`;
}

function renderQueue(raw: unknown): string {
  const d = raw as QueueData;
  const lines: string[] = [];
  if (d.lanes.length === 0) {
    lines.push(`queue is empty · ${tildify(d.db)}`);
  } else {
    for (const lane of d.lanes) {
      lines.push(`${lane.lane} · slots ${lane.slots} · ${lane.running} running · ${lane.waiting} waiting · ${tildify(d.db)}`);
      for (const e of lane.entries) lines.push(renderEntry(e));
    }
  }
  for (const e of d.removed) {
    lines.push(
      `removed dead #${e.id} '${commandLine(e.argv, 50)}' in ${tildify(e.cwd)}, pid ${e.pid}: the process is gone` +
        (e.orphan ? `; its command (pid ${e.child_pid}) is still running outside the queue` : ""),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function createQueueCommand(): Command {
  return {
    name: "queue",
    summary: "who runs and who waits in the machine-wide queue of myc run",
    flags: [{ name: "lane", value: "string", description: "only this lane (default: all lanes)" }],
    help:
      "Shows the queue of `myc run` shared by this machine user (~/.myc/queue.db): per lane, the " +
      "running commands and the waiting ones in line order, with directory, session, orca terminal, " +
      "pid and how long each has run or waited. Tickets whose process is gone are shown as removed " +
      `and deleted. A ticket whose lease expired while its process still exists is marked STALE; a ` +
      `waiting \`myc run\` removes it after watching it not renew. Slots per lane: ${slotsEnvName(DEFAULT_LANE)} ` +
      "(MYC_<LANE>_SLOTS), default 1. --json for machines.",
    handler: queueHandler,
    renderHuman: renderQueue,
  };
}
