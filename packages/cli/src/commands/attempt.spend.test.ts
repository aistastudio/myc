/**
 * Чей расход ложится в попытку (memory-1s8dcfkfz20r, ревизия M5 §4.3).
 *
 * Сценарий аудита: три строки `swarm_attempt_run` записаны с сессией
 * координатора (`session_source='env'`, `dispatch_source='none'`) — его
 * стенограмма 88 МБ, только opus, — и две из трёх стоимостей оказались его
 * расходом ($2665.49 у opus, $553.37 у sonnet: токены opus по ставкам sonnet).
 * `myc report models` из-за одной такой строки отвечал наоборот.
 *
 * Здесь та же форма мира во временном каталоге:
 *   - исполнитель работает из worktree ВНУТРИ воркспейса (`.claude/worktrees/x`),
 *     его стенограмма лежит в каталоге проекта worktree, модель — sonnet;
 *   - координатор — в корне воркспейса, своя сессия, стенограмма opus с
 *     огромным расходом, диспетчера у его терминала нет.
 * Каталог стенограмм — `$CLAUDE_CONFIG_DIR/projects`, как у Claude Code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { Attribution, ensureSwarmSchema, launchContext, readTranscriptUsage } from "@myc/swarm";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAttemptCommand, createReportCommand, realAttemptDeps, type LaunchProbe } from "./attempt.ts";
import { createModelCommand } from "./roster.ts";
import { createCloseCommand, createTaskCommand } from "./tasks.ts";

const EXEC = "0e1a4c33-5b7d-4a7e-9d61-2f3b8c9d0a11"; // сессия исполнителя
const COORD = "a4814339-819f-40fd-964f-9f054a508e43"; // сессия координатора
const TERM_EXEC = "term_exec";
const TERM_COORD = "term_coord";

let root: string;
let main: string; // корень воркспейса — здесь сидит координатор
let wt: string; // worktree исполнителя внутри воркспейса
let projects: string; // $CLAUDE_CONFIG_DIR/projects
let registry: Registry;
let env: Record<string, string | undefined>;
let dispatchTable: Map<string, { dispatchId: string; runId: string | null }>;
let clock: number;

const probe: LaunchProbe = {
  env: () => env,
  alive: () => null,
  dispatchOf: (terminal) => dispatchTable.get(terminal) ?? null,
  gitBase: async () => null,
  touchedSince: async () => null,
  now: () => clock,
};

/** Каталог проекта Claude Code: путь, где всё не буквенно-цифровое → '-'. */
function projectDir(cwd: string): string {
  return join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

interface Usage {
  readonly i: number;
  readonly o: number;
  readonly r: number;
  readonly w: number;
}

/** Стенограмма той формы, что пишет Claude Code: по записи на ответ. */
function writeTranscript(
  cwd: string,
  session: string,
  model: string,
  responses: ReadonlyArray<Usage & { readonly at?: string }>,
): string {
  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  const lines = responses.map((u, n) =>
    JSON.stringify({
      type: "assistant",
      requestId: `req_${session.slice(0, 4)}_${n}`,
      timestamp: u.at ?? "2026-09-07T09:00:00.000Z",
      message: {
        id: `msg_${session.slice(0, 4)}_${n}`,
        model,
        usage: {
          input_tokens: u.i,
          output_tokens: u.o,
          cache_read_input_tokens: u.r,
          cache_creation_input_tokens: u.w,
        },
      },
    }),
  );
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const EXEC_USAGE: Usage = { i: 1_000, o: 20_000, r: 3_000_000, w: 100_000 };
const COORD_USAGE: Usage = { i: 50_000, o: 900_000, r: 1_516_787_486, w: 8_000_000 };

/** Цена sonnet: 3/15/0.3/3.75 за 1M. */
function sonnetCost(u: Usage): number {
  return (u.i * 3 + u.o * 15 + u.r * 0.3 + u.w * 3.75) / 1e6;
}

function asExecutor(): void {
  env = { CLAUDE_CODE_SESSION_ID: EXEC, CLAUDE_PID: "1001", ORCA_TERMINAL_HANDLE: TERM_EXEC };
}

function asCoordinator(): void {
  env = { CLAUDE_CODE_SESSION_ID: COORD, CLAUDE_PID: "2002", ORCA_TERMINAL_HANDLE: TERM_COORD };
}

function myc(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", cwd, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function json(cwd: string, ...args: string[]): Promise<{ envelope: any; code: number }> {
  const r = await myc(cwd, ...args, "--json");
  return { envelope: JSON.parse(r.stdout as string), code: r.code };
}

function warnCodes(envelope: { warn?: { code: string }[] }): string[] {
  return (envelope.warn ?? []).map((w) => w.code);
}

function warnText(envelope: { warn?: { code: string; msg: string }[] }, code: string): string {
  return (envelope.warn ?? []).find((w) => w.code === code)?.msg ?? "";
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  delete process.env.MYC_TRANSCRIPT_DIR;
  delete process.env.MYC_MODEL;
  root = mkdtempSync(join(tmpdir(), "myc-spend-"));
  main = join(root, "main");
  wt = join(main, ".claude", "worktrees", "feature");
  mkdirSync(join(main, ".myc"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  const raw = new Database(join(main, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  projects = join(root, "claude", "projects");
  mkdirSync(projects, { recursive: true });

  asCoordinator();
  dispatchTable = new Map([[TERM_EXEC, { dispatchId: "ctx_exec", runId: "run_1" }]]);
  clock = Date.parse("2026-09-07T08:00:00Z");
  const deps = { ...realAttemptDeps, probe };
  registry = new Registry();
  registry.register(createTaskCommand());
  registry.register(createCloseCommand(realAttemptDeps.store, probe));
  registry.register(createModelCommand());
  registry.register(createAttemptCommand(deps));
  registry.register(createReportCommand(deps));

  for (const [id, family, pin, pout] of [
    ["sonnet", "claude-sonnet", "3", "15"],
    ["opus", "claude-opus", "15", "75"],
  ] as const) {
    const m = await json(
      main, "model", "add", id, "--family", family, "--harness", "claude", "--effort", "high",
      "--price-in", pin, "--price-out", pout, "--price-date", "2026-01-01",
    );
    expect(m.code).toBe(ExitCode.OK);
  }
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.MYC_TRANSCRIPT_DIR;
  rmSync(root, { recursive: true, force: true });
});

async function newTask(title: string): Promise<string> {
  const r = await json(main, "task", title);
  expect(r.code).toBe(ExitCode.OK);
  return r.envelope.data.id as string;
}

describe("расход попытки — только исполнителя", () => {
  test("сценарий аудита: координатор закрывает попытку исполнителя из worktree — расход исполнителя, координатору ничего", async () => {
    const task = await newTask("Модуль отчёта по моделям");
    writeTranscript(wt, EXEC, "claude-sonnet-5", [EXEC_USAGE]);
    writeTranscript(main, COORD, "claude-opus-5", [COORD_USAGE]);

    asExecutor();
    const started = await json(wt, "attempt", "start", task, "--model", "sonnet");
    expect(started.code).toBe(ExitCode.OK);
    // Путь стенограммы исполнителя записан НА СТАРТЕ, а не угадывается на финише.
    expect(started.envelope.data.run).toMatchObject({
      sessionId: EXEC,
      dispatchSource: "lookup",
      transcriptPath: join(projectDir(wt), `${EXEC}.jsonl`),
    });

    asCoordinator();
    const closed = await json(main, "close", task, "--verdict", "accepted");
    expect(closed.code).toBe(ExitCode.OK);
    expect(closed.envelope.data.attribution).toMatchObject({
      recorded: true,
      spend_via: "recorded",
      cost_basis: "priced",
    });
    expect(closed.envelope.data.attribution.cost_usd).toBeCloseTo(sonnetCost(EXEC_USAGE), 9);
    const [a] = (await json(main, "attempt", "list", "--task", task)).envelope.data;
    expect(a).toMatchObject({
      tokensIn: EXEC_USAGE.i,
      tokensOut: EXEC_USAGE.o,
      tokensCacheRead: EXEC_USAGE.r,
      tokensCacheWrite: EXEC_USAGE.w,
    });
  });

  test("путь на старте не записан: на финише стенограмма ищется по сессии во всех каталогах, а не по cwd финиширующего", async () => {
    const task = await newTask("Починить чтение");
    asExecutor();
    // Стенограммы ещё нет — старт её не находит, строка запуска без пути.
    const started = await json(wt, "attempt", "start", task, "--model", "sonnet");
    expect(started.envelope.data.run.transcriptPath).toBeNull();
    writeTranscript(wt, EXEC, "claude-sonnet-5", [EXEC_USAGE]);

    asCoordinator();
    const r = await json(main, "attempt", "finish", "--task", task, "--verdict", "accepted");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.spendVia).toBe("recorded");
    expect(r.envelope.data.tokensCacheRead).toBe(EXEC_USAGE.r);
    expect(warnCodes(r.envelope)).not.toContain("notfound.session");
  });

  test("попытку завёл сам координатор (dispatch_source none): расход его сессии не берётся — WARN с подсказкой", async () => {
    const task = await newTask("Ретро-запись");
    writeTranscript(main, COORD, "claude-opus-5", [COORD_USAGE]);
    // Явный каталог стенограмм — тот, где стенограмма координатора лежит
    // рядом: так прежний код находил её сам и клал её расход в попытку.
    process.env.MYC_TRANSCRIPT_DIR = projectDir(main);
    asCoordinator();
    const started = await json(main, "attempt", "start", task, "--model", "sonnet");
    expect(started.envelope.data.run).toMatchObject({ sessionId: COORD, dispatchSource: "none" });
    const closed = await json(main, "close", task, "--verdict", "accepted");
    expect(closed.code).toBe(ExitCode.OK);
    expect(closed.envelope.data.attribution).toMatchObject({
      recorded: true,
      spend_via: "none",
      cost_basis: "no_tokens",
      cost_usd: null,
    });
    expect(warnCodes(closed.envelope)).toContain("spend.not_executor");
    expect(warnText(closed.envelope, "spend.not_executor")).toContain("--from-session");
    const [a] = (await json(main, "attempt", "list", "--task", task)).envelope.data;
    expect(a.tokensCacheRead).toBe(0);
  });

  test("сессия названа явно при старте (--session) — это привязка, расход берётся и без диспетчера", async () => {
    const task = await newTask("Явная привязка");
    writeTranscript(wt, EXEC, "claude-sonnet-5", [EXEC_USAGE]);
    asCoordinator();
    await json(main, "attempt", "start", task, "--model", "sonnet", "--session", EXEC);
    const closed = await json(main, "close", task, "--verdict", "accepted");
    expect(closed.envelope.data.attribution).toMatchObject({ spend_via: "recorded" });
    expect(closed.envelope.data.attribution.cost_usd).toBeCloseTo(sonnetCost(EXEC_USAGE), 9);
  });

  test("стенограмма с чужой моделью не берётся: WARN, а не токены opus по ставкам sonnet", async () => {
    const task = await newTask("Чужая модель");
    writeTranscript(wt, EXEC, "claude-opus-5", [COORD_USAGE]);
    process.env.MYC_TRANSCRIPT_DIR = projectDir(wt);
    asExecutor();
    await json(wt, "attempt", "start", task, "--model", "sonnet");
    asCoordinator();
    const closed = await json(main, "close", task, "--verdict", "accepted");
    expect(closed.code).toBe(ExitCode.OK);
    expect(closed.envelope.data.attribution).toMatchObject({ spend_via: "none", cost_basis: "no_tokens" });
    expect(warnCodes(closed.envelope)).toContain("spend.model_mismatch");
    const msg = warnText(closed.envelope, "spend.model_mismatch");
    expect(msg).toContain("claude-opus-5");
    expect(msg).toContain("sonnet");
  });

  test("служебная модель <synthetic> сверку не ломает", async () => {
    const task = await newTask("С синтетикой");
    const path = writeTranscript(wt, EXEC, "claude-sonnet-5", [EXEC_USAGE]);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "assistant",
        requestId: "req_syn",
        timestamp: "2026-09-07T09:00:01.000Z",
        message: {
          id: "msg_syn",
          model: "<synthetic>",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })}\n`,
      { flag: "a" },
    );
    asExecutor();
    await json(wt, "attempt", "start", task, "--model", "sonnet");
    asCoordinator();
    const closed = await json(main, "close", task, "--verdict", "accepted");
    expect(closed.envelope.data.attribution.spend_via).toBe("recorded");
  });

  test("явный --from-session тоже находит стенограмму исполнителя вне каталога cwd", async () => {
    const task = await newTask("Явная сессия");
    writeTranscript(wt, EXEC, "claude-sonnet-5", [EXEC_USAGE]);
    asCoordinator();
    await json(main, "attempt", "start", task, "--model", "sonnet", "--no-orca");
    const r = await json(main, "attempt", "finish", "--task", task, "--verdict", "accepted", "--from-session", EXEC);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.tokensCacheRead).toBe(EXEC_USAGE.r);
  });

  test("attempt link с другой сессией не оставляет путь стенограммы прежней", async () => {
    const task = await newTask("Перепривязка");
    writeTranscript(main, COORD, "claude-opus-5", [COORD_USAGE]);
    writeTranscript(wt, EXEC, "claude-sonnet-5", [EXEC_USAGE]);
    asCoordinator();
    const started = await json(main, "attempt", "start", task, "--model", "sonnet");
    expect(started.envelope.data.run.transcriptPath).toBe(join(projectDir(main), `${COORD}.jsonl`));
    const linked = await json(main, "attempt", "link", "--task", task, "--session", EXEC, "--no-orca");
    expect(linked.envelope.data.run).toMatchObject({
      sessionId: EXEC,
      transcriptPath: join(projectDir(wt), `${EXEC}.jsonl`),
    });
    const closed = await json(main, "close", task, "--verdict", "accepted");
    expect(closed.envelope.data.attribution.cost_usd).toBeCloseTo(sonnetCost(EXEC_USAGE), 9);
  });
});

/**
 * Пересчёт уже записанного (`myc attempt recost`). По умолчанию — только
 * показать; писать — `--apply`. Стенограмму исполнителя не нашли — отказ по
 * строке, а не ноль и не догадка.
 */
describe("attempt recost", () => {
  /**
   * Попытка, закрытая СТАРЫМ кодом: расход взят из стенограммы записанной
   * сессии как есть. Пишется напрямую доменом — ровно так лежат строки аудита.
   */
  function legacyAttempt(opts: {
    task: string;
    model: string;
    session: string;
    dispatch: boolean;
    transcriptPath: string | null;
    spend: Usage | null;
    finishedAt: number;
  }): string {
    const db = new Database(join(main, ".myc", "myc.db"));
    try {
      ensureSwarmSchema(db);
      const att = new Attribution(db, () => opts.finishedAt - 60_000);
      const launch = launchContext({
        CLAUDE_CODE_SESSION_ID: opts.session,
        ...(opts.dispatch ? { MYC_DISPATCH_ID: "ctx_exec" } : {}),
      });
      const rec = att.startAttempt({
        taskId: opts.task,
        modelId: opts.model,
        taskClass: "feature:module",
        classSource: "declared",
        run: { launch, transcriptPath: opts.transcriptPath },
      });
      att.finishAttempt(rec.attemptId, {
        verdict: "accepted",
        finishedAt: opts.finishedAt,
        ...(opts.spend !== null
          ? {
              tokensIn: opts.spend.i,
              tokensOut: opts.spend.o,
              tokensCacheRead: opts.spend.r,
              tokensCacheWrite: opts.spend.w,
            }
          : {}),
      });
      return rec.attemptId;
    } finally {
      db.close();
    }
  }

  function tokensOf(attemptId: string): { r: number; cost: number | null; basis: string | null } {
    const db = new Database(join(main, ".myc", "myc.db"), { readonly: true });
    try {
      const row = db
        .query("SELECT tokens_cache_read AS r, cost_usd AS cost, cost_basis AS basis FROM swarm_attempt WHERE attempt_id = ?1")
        .get(attemptId) as { r: number; cost: number | null; basis: string | null };
      return row;
    } finally {
      db.close();
    }
  }

  const FINISHED = Date.parse("2026-09-07T10:00:00Z");

  test("dry-run показывает, --apply пишет; чужой расход снимается только явным --clear-foreign", async () => {
    // Ответ «в полёте»: тот, чей вызов инструмента и запустил финиш. В файл
    // он лёг ПОСЛЕ чтения, но с отметкой времени до финиша — поэтому
    // записанный расход равен префиксу стенограммы, а не срезу по времени
    // (att_696c6767c557 на копии базы: ровно один такой ответ).
    const coordPath = writeTranscript(main, COORD, "claude-opus-5", [
      COORD_USAGE,
      { i: 2, o: 837, r: 816_747, w: 861, at: "2026-09-07T09:59:59.000Z" },
    ]);
    // Исполнитель продолжал работать ПОСЛЕ приёмки: поздний ответ в пересчёт не идёт.
    const execPath = writeTranscript(wt, EXEC, "claude-sonnet-5", [
      { ...EXEC_USAGE, at: "2026-09-07T09:30:00.000Z" },
      { i: 7, o: 7, r: 7_000_000, w: 7, at: "2026-09-07T11:00:00.000Z" },
    ]);
    const t1 = await newTask("Строка аудита: сессия координатора");
    const t2 = await newTask("Исполнитель, расход не нашёлся");
    const t3 = await newTask("Исполнитель, стенограммы нет");
    const t4 = await newTask("Сессия координатора, но числа руками");
    const foreign = legacyAttempt({
      task: t1, model: "sonnet", session: COORD, dispatch: false,
      transcriptPath: null, spend: COORD_USAGE, finishedAt: FINISHED,
    });
    const missed = legacyAttempt({
      task: t2, model: "sonnet", session: EXEC, dispatch: true,
      transcriptPath: null, spend: null, finishedAt: FINISHED,
    });
    const lost = legacyAttempt({
      task: t3, model: "sonnet", session: "ffffffff-0000-0000-0000-000000000000", dispatch: true,
      transcriptPath: null, spend: null, finishedAt: FINISHED,
    });
    const manual = legacyAttempt({
      task: t4, model: "sonnet", session: COORD, dispatch: false,
      transcriptPath: null, spend: { i: 10, o: 10, r: 10, w: 10 }, finishedAt: FINISHED,
    });
    expect(readTranscriptUsage(coordPath, { until: FINISHED }).tokensCacheRead).toBe(COORD_USAGE.r + 816_747);
    expect(readTranscriptUsage(execPath).tokensCacheRead).toBe(EXEC_USAGE.r + 7_000_000);

    const dry = await json(main, "attempt", "recost");
    expect(dry.code).toBe(ExitCode.OK);
    const rows = dry.envelope.data.rows as Array<{ attemptId: string; action: string; after: any; written: boolean }>;
    const by = new Map(rows.map((r) => [r.attemptId, r]));
    expect(by.get(foreign)!.action).toBe("foreign");
    expect(by.get(missed)!.action).toBe("recost");
    expect(by.get(missed)!.after.tokensCacheRead).toBe(EXEC_USAGE.r);
    expect(by.get(missed)!.after.costUsd).toBeCloseTo(sonnetCost(EXEC_USAGE), 9);
    expect(by.get(lost)!.action).toBe("refused");
    expect(by.get(manual)!.action).toBe("skipped");
    expect(rows.every((r) => !r.written)).toBe(true);
    expect(dry.envelope.data.applied).toBe(false);
    expect(warnCodes(dry.envelope)).toContain("recost.refused");
    // dry-run ничего не записал
    expect(tokensOf(missed).r).toBe(0);
    expect(tokensOf(foreign).r).toBe(COORD_USAGE.r);

    const applied = await json(main, "attempt", "recost", "--apply");
    expect(applied.code).toBe(ExitCode.OK);
    expect(tokensOf(missed)).toMatchObject({ r: EXEC_USAGE.r, basis: "priced" });
    expect(tokensOf(missed).cost).toBeCloseTo(sonnetCost(EXEC_USAGE), 9);
    // чужой расход без явного флага не тронут, ручные числа — тоже
    expect(tokensOf(foreign).r).toBe(COORD_USAGE.r);
    expect(tokensOf(manual).r).toBe(10);

    const cleared = await json(main, "attempt", "recost", "--apply", "--clear-foreign");
    expect(cleared.code).toBe(ExitCode.OK);
    expect(tokensOf(foreign)).toEqual({ r: 0, cost: null, basis: "no_tokens" });
    expect(tokensOf(manual).r).toBe(10);
    // повтор — ничего нового: всё уже на месте
    const again = await json(main, "attempt", "recost", missed);
    expect(again.envelope.data.rows[0].action).toBe("unchanged");
  });

  test("одна названная попытка: стенограмму исполнителя не найти — отказ команды", async () => {
    const t = await newTask("Без стенограммы");
    const att = legacyAttempt({
      task: t, model: "sonnet", session: EXEC, dispatch: true,
      transcriptPath: null, spend: null, finishedAt: FINISHED,
    });
    const r = await json(main, "attempt", "recost", att);
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.envelope.error.code).toBe("notfound.session");
  });

  test("явная сессия исполнителя чинит строку координатора", async () => {
    writeTranscript(main, COORD, "claude-opus-5", [COORD_USAGE]);
    writeTranscript(wt, EXEC, "claude-sonnet-5", [{ ...EXEC_USAGE, at: "2026-09-07T09:30:00.000Z" }]);
    const t = await newTask("Строка аудита");
    const att = legacyAttempt({
      task: t, model: "sonnet", session: COORD, dispatch: false,
      transcriptPath: null, spend: COORD_USAGE, finishedAt: FINISHED,
    });
    const r = await json(main, "attempt", "recost", att, "--from-session", EXEC, "--apply");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.rows[0]).toMatchObject({ action: "recost", written: true });
    expect(tokensOf(att).r).toBe(EXEC_USAGE.r);
  });
});
