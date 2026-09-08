/**
 * Память запусков через CLI: `myc attempt start` записывает сессию,
 * диспетчера и pid, `myc attempt list --live` отвечает «что сейчас
 * работает», а завершённое-но-живое отличимо от работающего
 * (memory-v3f81y9vfrq0).
 *
 * ПОЧЕМУ ПРОБА ПОДДЕЛЬНАЯ. Настоящая спрашивает ядро о живости pid,
 * окружение — о сессии, оркестратор — о диспетчере. Тест с настоящей
 * пробой сходился бы только внутри агентского процесса, запущенного
 * оркестратором, то есть на машине автора и один раз. Ровно тот класс
 * проверки, из-за которого дефект и жил: «у меня работает».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import {
  createAttemptCommand,
  createReportCommand,
  realAttemptDeps,
  type LaunchProbe,
} from "./attempt.ts";
import { createModelCommand } from "./roster.ts";
import { createCloseCommand, createTaskCommand } from "./tasks.ts";

const SESSION = "b1b7b2cd-9322-4ad5-ad7f-adf39cbb68d6";
const TERMINAL = "term_7de4e77c-fa4d-4f25-b262-15d0e1ed6574";
const DISPATCH = "ctx_4deb47fc99e1";

let dir: string;
let registry: Registry;
let env: Record<string, string | undefined>;
let aliveSet: Set<number>;
let dispatchTable: Map<string, { dispatchId: string; runId: string | null }>;
let clock: number;

const probe: LaunchProbe = {
  env: () => env,
  alive: (pid) => (pid === null ? null : aliveSet.has(pid)),
  dispatchOf: (terminal) => dispatchTable.get(terminal) ?? null,
  gitHead: () => "0000000000000000000000000000000000000000",
  filesTouched: () => ["packages/swarm/src/launch.ts"],
  now: () => clock,
};

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-live-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  env = {
    CLAUDE_CODE_SESSION_ID: SESSION,
    CLAUDE_PID: "81610",
    ORCA_TERMINAL_HANDLE: TERMINAL,
    ORCA_PANE_KEY: "ab4038fc:6b78775f",
    AI_AGENT: "claude-code_2-1-263_agent",
  };
  aliveSet = new Set([81610]);
  dispatchTable = new Map([[TERMINAL, { dispatchId: DISPATCH, runId: "run_84a8843787ba" }]]);
  clock = Date.parse("2026-09-07T09:00:00Z");
  const deps = { ...realAttemptDeps, probe };
  registry = new Registry();
  registry.register(createTaskCommand());
  registry.register(createCloseCommand());
  registry.register(createModelCommand());
  registry.register(createAttemptCommand(deps));
  registry.register(createReportCommand(deps));
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_MODEL;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function json(...args: string[]): Promise<{ envelope: any; code: number }> {
  const r = await myc(...args, "--json");
  return { envelope: JSON.parse(r.stdout as string), code: r.code };
}

async function setup(): Promise<string> {
  const m = await json(
    "model", "add", "p/big", "--family", "big", "--harness", "claude",
    "--effort", "high", "--price-in", "3", "--price-out", "15",
    "--price-cache-read", "0.3", "--price-cache-write", "3.75",
    // Дата цены — раньше поддельных часов, иначе стоимость на момент
    // попытки честно не находится и проверялся бы не тот путь.
    "--price-date", "2026-01-01",
  );
  expect(m.code).toBe(ExitCode.OK);
  const t = await json("task", "Починить чтение оплога");
  expect(t.code).toBe(ExitCode.OK);
  return t.envelope.data.id as string;
}

describe("attempt start записывает запуск", () => {
  test("без единого флага: сессия, диспетчер и pid известны сразу", async () => {
    const id = await setup();
    const r = await json("attempt", "start", id, "--model", "p/big");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.run).toMatchObject({
      sessionId: SESSION,
      sessionSource: "env",
      agentPid: 81610,
      pidSource: "env",
      terminal: TERMINAL,
      dispatchId: DISPATCH,
      dispatchSource: "lookup",
      runId: "run_84a8843787ba",
      procState: "running",
    });
  });

  test("флаг перекрывает окружение и меняет источник на flag", async () => {
    const id = await setup();
    const r = await json(
      "attempt", "start", id, "--model", "p/big",
      "--session", "иная-сессия", "--dispatch", "ctx_другой",
    );
    expect(r.envelope.data.run).toMatchObject({
      sessionId: "иная-сессия",
      sessionSource: "flag",
      dispatchId: "ctx_другой",
      dispatchSource: "flag",
    });
  });

  test("сессии нет — предупреждение, а не тихая запись без связи", async () => {
    const id = await setup();
    env = { ORCA_TERMINAL_HANDLE: TERMINAL };
    const r = await json("attempt", "start", id, "--model", "p/big");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.run.sessionId).toBeNull();
    expect(JSON.stringify(r.envelope)).toContain("launch.no_session");
  });

  test("оркестратор не ответил — предупреждение о недостающем диспетчере", async () => {
    const id = await setup();
    dispatchTable = new Map();
    const r = await json("attempt", "start", id, "--model", "p/big");
    expect(r.envelope.data.run.dispatchId).toBeNull();
    expect(JSON.stringify(r.envelope)).toContain("launch.no_dispatch");
  });

  test("--no-orca не даёт спрашивать оркестратор", async () => {
    const id = await setup();
    let asked = 0;
    const counting: LaunchProbe = {
      ...probe,
      dispatchOf: (t) => {
        asked += 1;
        return dispatchTable.get(t) ?? null;
      },
    };
    const reg = new Registry();
    reg.register(createTaskCommand());
    reg.register(createModelCommand());
    reg.register(createAttemptCommand({ ...realAttemptDeps, probe: counting }));
    await run(["-C", dir, "attempt", "start", id, "--model", "p/big", "--no-orca", "--json"], {
      registry: reg,
    });
    expect(asked).toBe(0);
  });
});

describe("attempt list --live", () => {
  test("одна команда отвечает, что сейчас работает и сколько висит", async () => {
    const id = await setup();
    await json("attempt", "start", id, "--model", "p/big");
    clock += 7 * 60_000;
    const r = await json("attempt", "list", "--live");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data).toHaveLength(1);
    expect(r.envelope.data[0]).toMatchObject({ liveState: "working", ageMs: 7 * 60_000 });
    expect(r.envelope.data[0].afterFinishMs).toBeNull();
    expect(r.envelope.meta).toMatchObject({ count: 1, orphans: 0 });
  });

  test("ЗАВЕРШЁННОЕ, НО ЖИВОЕ отличимо от работающего и от завершённого", async () => {
    const id = await setup();
    await json("attempt", "start", id, "--model", "p/big");
    clock += 60_000;
    await json("attempt", "finish", "--task", id, "--verdict", "accepted");

    // Работа принята, а процесс жив — ровно те 6 ч 52 мин. Спрашивает о нём
    // ДРУГОЙ процесс (координатор из своего терминала, pid 6706) — не тот,
    // что записан агентским запуском (81610): настоящий сирота отличают
    // именно так, не подделанной записью на себя.
    env = { ...env, CLAUDE_PID: "6706" };
    clock += 6 * 3_600_000 + 52 * 60_000;
    const orphan = await json("attempt", "list", "--live");
    expect(orphan.envelope.data).toHaveLength(1);
    expect(orphan.envelope.data[0].liveState).toBe("orphan");
    expect(orphan.envelope.data[0].afterFinishMs).toBe(6 * 3_600_000 + 52 * 60_000);
    expect(orphan.envelope.meta.orphans).toBe(1);

    // Процесса не стало — строка уходит из живых, а не остаётся навсегда.
    aliveSet.delete(81610);
    const gone = await json("attempt", "list", "--live");
    expect(gone.envelope.data).toHaveLength(0);
    const shown = await json("attempt", "show", (orphan.envelope.data[0].attempt.attemptId));
    expect(shown.envelope.data.liveState).toBe("done");
  });

  test("человеческий вывод осиротевшего называет проблему и pid, но myc не снимает сам", async () => {
    const id = await setup();
    await json("attempt", "start", id, "--model", "p/big");
    await json("attempt", "finish", "--task", id, "--verdict", "accepted");
    // Спрашивает другой процесс — иначе это была бы запись координатором о
    // самом себе, а не настоящий сирота (memory-kgnyph7x367v).
    env = { ...env, CLAUDE_PID: "6706" };
    clock += 3_600_000;
    const r = await myc("attempt", "list", "--live");
    expect(r.stdout as string).toContain("ОСИРОТЕЛО 1");
    expect(r.stdout as string).toContain("kill 81610");
    expect(r.stdout as string).toContain("снимает тот, кто запускал");
  });

  test("ложный сирота memory-kgnyph7x367v: попытка, записанная координатором постфактум своим attempt start, не сирота", async () => {
    const id = await setup();
    // Оркестратор не подтвердил диспетчера — ровно то, что бывает, когда
    // координатор сам набирает `myc attempt start` из своей сессии уже
    // ПОСЛЕ того, как агент закончил: dispatchTable пуст → dispatchSource
    // "none". Pid в записи — pid координатора, и он же спрашивает --live.
    dispatchTable = new Map();
    env = { ...env, CLAUDE_PID: "6706" };
    aliveSet = new Set([6706]);
    await json("attempt", "start", id, "--model", "p/big");
    await json("attempt", "finish", "--task", id, "--verdict", "accepted");
    clock += 49 * 60_000; // как в инциденте: висело 49 минут в выдаче

    const r = await json("attempt", "list", "--live");
    expect(r.envelope.data).toHaveLength(0);
    expect(r.envelope.meta).toMatchObject({ count: 0, orphans: 0 });

    const human = await myc("attempt", "list", "--live");
    expect(human.stdout as string).not.toContain("ОСИРОТЕЛО");
    expect(human.stdout as string).not.toContain("kill 6706");
  });

  test("смерть процесса записывается: proc_state и время выхода", async () => {
    const id = await setup();
    const started = await json("attempt", "start", id, "--model", "p/big");
    const attemptId = started.envelope.data.attemptId as string;
    aliveSet.delete(81610);
    clock += 42 * 60_000;
    await json("attempt", "list", "--live");
    const shown = await json("attempt", "show", attemptId);
    expect(shown.envelope.data.run).toMatchObject({ procState: "exited" });
    expect(shown.envelope.data.run.procExitedAt).toBe(new Date(clock).toISOString());
    expect(shown.envelope.data.liveState).toBe("lost");
  });

  test("попытка без записанного pid не выдаётся за работающую", async () => {
    const id = await setup();
    env = { CLAUDE_CODE_SESSION_ID: SESSION };
    await json("attempt", "start", id, "--model", "p/big");
    const live = await json("attempt", "list", "--live");
    expect(live.envelope.data).toHaveLength(0);
    const list = await json("attempt", "list");
    expect(list.envelope.data).toHaveLength(1);
  });

  test("обычный list ничего не пишет о процессах", async () => {
    const id = await setup();
    const started = await json("attempt", "start", id, "--model", "p/big");
    aliveSet.delete(81610);
    await json("attempt", "list");
    const shown = await json("attempt", "show", started.envelope.data.attemptId);
    expect(shown.envelope.data.run.procState).toBe("running");
  });
});

describe("расход по записанной сессии", () => {
  /** Настоящая по форме стенограмма: две записи одного ответа. */
  function writeTranscript(sessionId: string, usage: Record<string, number>): string {
    const projects = join(dir, "projects");
    mkdirSync(projects, { recursive: true });
    const path = join(projects, `${sessionId}.jsonl`);
    const rec = (i: number) =>
      JSON.stringify({
        timestamp: "2026-09-07T09:00:0" + i + "Z",
        requestId: "req_1",
        message: { id: "msg_1", model: "p/big", usage },
      });
    writeFileSync(path, `${rec(0)}\n${rec(1)}\n`);
    return projects;
  }

  test("finish без флагов берёт расход по записанной сессии, а не перебором файлов", async () => {
    const id = await setup();
    process.env.MYC_TRANSCRIPT_DIR = writeTranscript(SESSION, {
      input_tokens: 100,
      output_tokens: 2000,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    });
    try {
      await json("attempt", "start", id, "--model", "p/big");
      const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted");
      expect(r.code).toBe(ExitCode.OK);
      expect(r.envelope.data.spendVia).toBe("recorded");
      expect(r.envelope.data.tokensIn).toBe(100);
      expect(r.envelope.data.tokensOut).toBe(2000);
      expect(r.envelope.data.costUsd).toBeCloseTo(
        (100 * 3 + 2000 * 15 + 50 * 0.3 + 10 * 3.75) / 1e6,
        9,
      );
      expect(r.envelope.data.costBasis).toBe("priced");
    } finally {
      delete process.env.MYC_TRANSCRIPT_DIR;
    }
  });

  test("сессии нет в записи — расход не выдумывается", async () => {
    const id = await setup();
    env = {};
    await json("attempt", "start", id, "--model", "p/big");
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted");
    expect(r.envelope.data.spendVia).toBe("none");
    expect(r.envelope.data.costBasis).toBe("no_tokens");
  });

  test("стенограмма записанной сессии не читается — WARN, но вердикт не теряется", async () => {
    const id = await setup();
    process.env.MYC_TRANSCRIPT_DIR = join(dir, "нет-такого-каталога");
    try {
      await json("attempt", "start", id, "--model", "p/big");
      const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted");
      expect(r.code).toBe(ExitCode.OK);
      expect(r.envelope.data.verdict).toBe("accepted");
      expect(r.envelope.data.spendVia).toBe("none");
      expect(JSON.stringify(r.envelope)).toContain("transcript.dir_missing");
    } finally {
      delete process.env.MYC_TRANSCRIPT_DIR;
    }
  });

  test("названные руками числа спорить с записью не дают: источник один", async () => {
    const id = await setup();
    process.env.MYC_TRANSCRIPT_DIR = writeTranscript(SESSION, {
      input_tokens: 100,
      output_tokens: 2000,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    });
    try {
      await json("attempt", "start", id, "--model", "p/big");
      const r = await json(
        "attempt", "finish", "--task", id, "--verdict", "accepted", "--tokens-in", "7",
      );
      expect(r.envelope.data.spendVia).toBe("flags");
      expect(r.envelope.data.tokensIn).toBe(7);
    } finally {
      delete process.env.MYC_TRANSCRIPT_DIR;
    }
  });

  test("myc close --verdict тоже считает по записанной сессии: закрытие остаётся одним флагом", async () => {
    const id = await setup();
    process.env.MYC_TRANSCRIPT_DIR = writeTranscript(SESSION, {
      input_tokens: 100,
      output_tokens: 2000,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    });
    try {
      await json("attempt", "start", id, "--model", "p/big");
      const r = await json("close", id, "--verdict", "accepted");
      expect(r.code).toBe(ExitCode.OK);
      expect(r.envelope.data.attribution).toMatchObject({
        recorded: true,
        spend_via: "recorded",
        cost_basis: "priced",
      });
    } finally {
      delete process.env.MYC_TRANSCRIPT_DIR;
    }
  });
});

describe("attempt link — запасной путь", () => {
  test("находка перебором записывается как 'search' и отличима от записанной при старте", async () => {
    const id = await setup();
    env = {};
    const started = await json("attempt", "start", id, "--model", "p/big");
    const attemptId = started.envelope.data.attemptId as string;

    const r = await json(
      "attempt", "link", "--task", id, "--session", SESSION, "--found", "--no-orca",
    );
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.run).toMatchObject({
      sessionId: SESSION,
      sessionSource: "search",
    });
    const shown = await json("attempt", "show", attemptId);
    expect(shown.envelope.data.run.sessionSource).toBe("search");
  });

  test("дописать диспетчера не значит стереть сессию", async () => {
    const id = await setup();
    dispatchTable = new Map();
    await json("attempt", "start", id, "--model", "p/big");
    env = {};
    const r = await json("attempt", "link", "--task", id, "--dispatch", DISPATCH, "--no-orca");
    expect(r.envelope.data.run).toMatchObject({
      sessionId: SESSION,
      sessionSource: "env",
      dispatchId: DISPATCH,
      dispatchSource: "flag",
      agentPid: 81610,
    });
  });

  test("привязка к несуществующей попытке — отказ", async () => {
    await setup();
    const r = await json("attempt", "link", "att_000000000000", "--session", "x", "--no-orca");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.envelope.error.code).toBe("notfound.attempt");
  });
});

describe("тронутые файлы", () => {
  test("finish записывает файлы, изменившиеся с HEAD на старте", async () => {
    const id = await setup();
    await json("attempt", "start", id, "--model", "p/big");
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted");
    expect(r.envelope.data.run).toMatchObject({
      gitHead: "0000000000000000000000000000000000000000",
      filesTouched: ["packages/swarm/src/launch.ts"],
    });
  });
});
