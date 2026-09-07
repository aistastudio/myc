/**
 * Запись запуска: попытка ↔ сессия ↔ диспетчер ↔ процесс.
 *
 * Ограждения, которые здесь стоят (каждое — с мутацией в отчёте):
 *
 * 1. Связь попытки с сессией пишется В ТОЙ ЖЕ транзакции, что и попытка.
 *    Попытка без строки запуска — законна (ретроспектива), попытка с
 *    ПОЛОВИНОЙ запуска — нет.
 * 2. Источник связи хранится вместе со связью: env/flag ≠ search.
 * 3. Внешний ключ — барьер: запуск без попытки не пишется даже прямым
 *    INSERT (PRAGMA foreign_keys = ON).
 * 4. Наблюдение за процессом правится только в сторону exited.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  Attribution,
  AttributionError,
  ensureSwarmSchema,
  EMPTY_LAUNCH,
  launchContext,
  liveStateOf,
  overrideLaunch,
  Roster,
  type LaunchContext,
} from "./index.ts";

const T0 = Date.parse("2026-09-07T09:00:00Z");
const MIN = 60_000;

let dir: string;
let db: Database;
let attribution: Attribution;
let now: number;

const AGENT_ENV = {
  CLAUDE_CODE_SESSION_ID: "b1b7b2cd-9322-4ad5-ad7f-adf39cbb68d6",
  CLAUDE_PID: "81610",
  ORCA_TERMINAL_HANDLE: "term_7de4e77c-fa4d-4f25-b262-15d0e1ed6574",
  ORCA_PANE_KEY: "ab4038fc:6b78775f",
  AI_AGENT: "claude-code_2-1-263_agent",
} as const;

function start(over: Partial<{ taskId: string; launch: LaunchContext }> = {}) {
  return attribution.startAttempt({
    taskId: over.taskId ?? "memory-aaaa",
    modelId: "p/big",
    taskClass: "fix:module",
    run: { launch: over.launch ?? launchContext(AGENT_ENV) },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-run-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSwarmSchema(db);
  now = T0;
  new Roster(db, () => now).addModel({
    modelId: "p/big",
    family: "big",
    harness: "claude",
    effort: "high",
    price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: T0 },
  });
  attribution = new Attribution(db, () => now);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("attempt start записывает запуск", () => {
  test("сессия, диспетчер и pid известны сразу после старта — без единого поиска", () => {
    const a = start({
      launch: overrideLaunch(launchContext(AGENT_ENV), { dispatchId: "ctx_4deb47fc99e1" }),
    });
    const run = attribution.getRun(a.attemptId)!;
    expect(run.sessionId).toBe("b1b7b2cd-9322-4ad5-ad7f-adf39cbb68d6");
    expect(run.agentPid).toBe(81610);
    expect(run.dispatchId).toBe("ctx_4deb47fc99e1");
    expect(run.terminal).toBe("term_7de4e77c-fa4d-4f25-b262-15d0e1ed6574");
    expect(run.paneKey).toBe("ab4038fc:6b78775f");
    expect(run.harnessBuild).toBe("claude-code_2-1-263_agent");
  });

  test("источник каждой связи записан: env для окружения, flag для флага", () => {
    const a = start({
      launch: overrideLaunch(launchContext(AGENT_ENV), { dispatchId: "ctx_1" }),
    });
    const run = attribution.getRun(a.attemptId)!;
    expect(run.sessionSource).toBe("env");
    expect(run.pidSource).toBe("env");
    expect(run.dispatchSource).toBe("flag");
  });

  test("процесс с pid считается запущенным, без pid — неизвестным", () => {
    expect(attribution.getRun(start().attemptId)!.procState).toBe("running");
    const noPid = start({
      taskId: "memory-bbbb",
      launch: { ...launchContext(AGENT_ENV), agentPid: null, pidSource: "none" },
    });
    expect(attribution.getRun(noPid.attemptId)!.procState).toBe("unknown");
  });

  test("нечего записать — строки запуска нет вовсе, а не строка из NULL", () => {
    const a = attribution.startAttempt({
      taskId: "memory-cccc",
      modelId: "p/big",
      taskClass: "fix:module",
      run: { launch: EMPTY_LAUNCH },
    });
    expect(attribution.getRun(a.attemptId)).toBeUndefined();
  });

  test("ретроспективная попытка без запуска законна", () => {
    const a = attribution.startAttempt({
      taskId: "memory-dddd",
      modelId: "p/big",
      taskClass: "fix:module",
      source: "close",
    });
    expect(attribution.getRun(a.attemptId)).toBeUndefined();
  });
});

describe("связь не теряется", () => {
  test("запуск и попытка пишутся одной транзакцией: половины не бывает", () => {
    // Ломаем вторую вставку прицельно: строка запуска нарушает CHECK по
    // источнику. Транзакция обязана откатить И попытку — иначе в базе
    // осталась бы попытка, чей расход опять пришлось бы искать перебором.
    const before = db.query("SELECT count(*) n FROM swarm_attempt").get() as { n: number };
    expect(() =>
      attribution.startAttempt({
        taskId: "memory-eeee",
        modelId: "p/big",
        taskClass: "fix:module",
        run: {
          launch: { ...launchContext(AGENT_ENV), sessionSource: "выдумка" as never },
        },
      }),
    ).toThrow();
    const after = db.query("SELECT count(*) n FROM swarm_attempt").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(
      (db.query("SELECT count(*) n FROM swarm_attempt_run").get() as { n: number }).n,
    ).toBe(0);
  });

  test("запуск без попытки не записывается даже прямым INSERT", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO swarm_attempt_run (attempt_id, session_id, session_source, recorded_at)
           VALUES ('att_ffffffffffff', 'sess', 'env', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  test("сессия ищется обратно: по uuid находится попытка, а не файл", () => {
    const a = start();
    const hits = attribution.attemptsBySession("b1b7b2cd-9322-4ad5-ad7f-adf39cbb68d6");
    expect(hits.map((r) => r.attemptId)).toEqual([a.attemptId]);
    expect(attribution.attemptsBySession("нет такой")).toEqual([]);
  });

  test("поздняя привязка перезаписывает запуск и помечает источник search", () => {
    const a = attribution.startAttempt({
      taskId: "memory-gggg",
      modelId: "p/big",
      taskClass: "fix:module",
    });
    expect(attribution.getRun(a.attemptId)).toBeUndefined();
    const run = attribution.attachRun(a.attemptId, {
      launch: overrideLaunch(EMPTY_LAUNCH, { sessionId: "uuid-1", sessionSource: "search" }),
      transcriptPath: "/tmp/uuid-1.jsonl",
    });
    expect(run.sessionId).toBe("uuid-1");
    expect(run.sessionSource).toBe("search");
    expect(run.transcriptPath).toBe("/tmp/uuid-1.jsonl");
  });

  test("привязка к несуществующей попытке — отказ, а не тихая запись", () => {
    expect(() =>
      attribution.attachRun("att_000000000000", {
        launch: overrideLaunch(EMPTY_LAUNCH, { sessionId: "x" }),
      }),
    ).toThrow(AttributionError);
  });
});

describe("жизненный цикл процесса", () => {
  test("завершённая попытка с живым процессом — orphan; та же попытка с мёртвым — done", () => {
    const a = start();
    now = T0 + 5 * MIN;
    attribution.finishAttempt(a.attemptId, { verdict: "accepted" });
    const closed = attribution.getAttempt(a.attemptId)!;
    expect(liveStateOf(closed, true)).toBe("orphan");
    expect(liveStateOf(closed, false)).toBe("done");
  });

  test("markExited проставляет время смерти один раз и не воскрешает", () => {
    const a = start();
    now = T0 + 10 * MIN;
    expect(attribution.markExited(a.attemptId)).toBe(true);
    const run = attribution.getRun(a.attemptId)!;
    expect(run.procState).toBe("exited");
    expect(run.procExitedAt).toBe(T0 + 10 * MIN);

    now = T0 + 20 * MIN;
    expect(attribution.markExited(a.attemptId)).toBe(false);
    expect(attribution.getRun(a.attemptId)!.procExitedAt).toBe(T0 + 10 * MIN);
  });

  test("markSeen не оживляет мёртвую запись", () => {
    const a = start();
    attribution.markExited(a.attemptId, T0 + MIN);
    now = T0 + 30 * MIN;
    attribution.markSeen(a.attemptId);
    const run = attribution.getRun(a.attemptId)!;
    expect(run.procState).toBe("exited");
    expect(run.procCheckedAt).toBe(T0 + MIN);
  });

  test("тронутые файлы дописываются к запуску", () => {
    const a = start();
    attribution.recordFilesTouched(a.attemptId, ["packages/swarm/src/launch.ts"]);
    expect(attribution.getRun(a.attemptId)!.filesTouched).toEqual([
      "packages/swarm/src/launch.ts",
    ]);
  });
});

describe("listWithRuns", () => {
  test("одним запросом: попытка и её запуск вместе, старейшее первым", () => {
    const a = start({ taskId: "memory-1" });
    now = T0 + MIN;
    const b = start({ taskId: "memory-2" });
    now = T0 + 2 * MIN;
    attribution.startAttempt({ taskId: "memory-3", modelId: "p/big", taskClass: "fix:module" });

    const rows = attribution.listWithRuns();
    expect(rows.map((r) => r.attempt.attemptId)).toEqual([
      a.attemptId,
      b.attemptId,
      rows[2]!.attempt.attemptId,
    ]);
    expect(rows[0]!.run?.sessionId).toBe("b1b7b2cd-9322-4ad5-ad7f-adf39cbb68d6");
    expect(rows[2]!.run).toBeUndefined();
  });

  test("withRun отбрасывает попытки без запуска", () => {
    start({ taskId: "memory-1" });
    attribution.startAttempt({ taskId: "memory-2", modelId: "p/big", taskClass: "fix:module" });
    expect(attribution.listWithRuns({ withRun: true })).toHaveLength(1);
    expect(attribution.listWithRuns()).toHaveLength(2);
  });

  test("поля попытки и поля запуска не путаются между собой", () => {
    const a = start();
    now = T0 + MIN;
    attribution.finishAttempt(a.attemptId, { verdict: "rework", tokensIn: 10, tokensOut: 20 });
    const [row] = attribution.listWithRuns();
    expect(row!.attempt.verdict).toBe("rework");
    expect(row!.attempt.startedAt).toBe(T0);
    expect(row!.attempt.finishedAt).toBe(T0 + MIN);
    expect(row!.run!.attemptId).toBe(a.attemptId);
    expect(row!.run!.recordedAt).toBe(T0);
    expect(row!.run!.agentPid).toBe(81610);
  });
});
