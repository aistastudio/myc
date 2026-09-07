/**
 * CLI атрибуции: `myc attempt …`, `myc close --verdict …`, `myc report models`
 * против настоящей базы во временном каталоге, через публичный run().
 *
 * Проверяется главное обещание W11: чтобы данные появились, координатору
 * достаточно ОДНОГО флага на закрытие, а исполнителю — команды без флагов.
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
  inertProbe,
  realAttemptDeps,
} from "./attempt.ts";
import { createModelCommand } from "./roster.ts";
import { createCloseCommand, createTaskCommand, createClaimCommand } from "./tasks.ts";

let dir: string;
let registry: Registry;

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  delete process.env.MYC_MODEL;
  delete process.env.MYC_TOKENS_IN;
  delete process.env.MYC_TOKENS_OUT;
  dir = mkdtempSync(join(tmpdir(), "myc-attempt-cli-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createTaskCommand());
  registry.register(createClaimCommand());
  registry.register(createCloseCommand());
  registry.register(createModelCommand());
  // Проба ИНЕРТНАЯ: иначе `attempt start` в тесте записал бы сессию и pid
  // того агента, который запустил тест, и сходился бы только у него.
  const deps = { ...realAttemptDeps, probe: inertProbe };
  registry.register(createAttemptCommand(deps));
  registry.register(createReportCommand(deps));
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_MODEL;
  delete process.env.MYC_TOKENS_IN;
  delete process.env.MYC_TOKENS_OUT;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function json(...args: string[]): Promise<{ envelope: any; code: number }> {
  const r = await myc(...args, "--json");
  return { envelope: JSON.parse(r.stdout as string), code: r.code };
}

async function addModel(id: string, priceIn: string, priceOut: string): Promise<void> {
  const r = await json(
    "model", "add", id,
    "--family", id.split("/").at(-1)!,
    "--harness", "claude",
    "--effort", "high",
    "--price-in", priceIn,
    "--price-out", priceOut,
  );
  expect(r.code).toBe(ExitCode.OK);
}

async function newTask(title: string, ...extra: string[]): Promise<string> {
  const r = await json("task", title, ...extra);
  expect(r.code).toBe(ExitCode.OK);
  return r.envelope.data.id as string;
}

describe("attempt start", () => {
  test("без флагов вообще: модель из окружения, харнесс и уровень из ростера, класс из задачи", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Исправить падение импорта");
    process.env.MYC_MODEL = "p/big";
    const r = await json("attempt", "start", id);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data).toMatchObject({
      taskId: id,
      modelId: "p/big",
      harness: "claude",
      effort: "high",
      taskClass: "fix:unknown",
      verdict: null,
    });
  });

  test("класс считается из якорей задачи, а не выдумывается", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Починить чтение", "--anchor", "packages/core/src/oplog.ts:1-20");
    const r = await json("attempt", "start", id, "--model", "p/big");
    expect(r.envelope.data.taskClass).toBe("fix:local");
  });

  test("модель не названа — ошибка с указанием, где её взять, а не догадка", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Что-то сделать");
    const r = await json("attempt", "start", id);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.envelope.error.code).toBe("usage.model");
    expect(r.envelope.error.hint).toContain("MYC_MODEL");
  });

  test("модель мимо ростера — notfound.model, попытки не появляется (мутация 2)", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Что-то сделать");
    const r = await json("attempt", "start", id, "--model", "p/самозванец");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.envelope.error.code).toBe("notfound.model");
    const list = await json("attempt", "list");
    expect(list.envelope.data).toHaveLength(0);
  });

  test("неоднозначная часть id — конфликт со списком кандидатов, а не первый попавшийся", async () => {
    await addModel("p/sonnet-5", "3", "15");
    await addModel("p/sonnet-4", "3", "15");
    const id = await newTask("Что-то сделать");
    const r = await json("attempt", "start", id, "--model", "sonnet");
    expect(r.code).toBe(ExitCode.CONFLICT);
    expect(r.envelope.error.msg).toContain("p/sonnet-4");
    expect(r.envelope.error.msg).toContain("p/sonnet-5");
  });
});

describe("close --verdict: один флаг на закрытие", () => {
  test("вердикт закрывает открытую попытку; модель, класс и токены уже там", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Исправить падение импорта");
    await json("attempt", "start", id, "--model", "p/big", "--tokens-in", "1000000", "--tokens-out", "100000");
    const r = await json("close", id, "--verdict", "accepted");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.attribution).toMatchObject({
      recorded: true,
      model_id: "p/big",
      task_class: "fix:unknown",
      verdict: "accepted",
      quality: 1,
      cost_basis: "priced",
    });
    expect(r.envelope.data.attribution.cost_usd).toBeCloseTo(4.5, 9);
  });

  test("оговорки записываются и снижают качество", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Исправить падение импорта");
    await json("attempt", "start", id, "--model", "p/big");
    const r = await json("close", id, "--verdict", "accepted", "--caveat", "tests-weak,coordinator-fixed");
    expect(r.envelope.data.attribution.caveats).toEqual(["tests_weak", "coordinator_fixed"]);
    expect(r.envelope.data.attribution.quality).toBeCloseTo(0.25, 9);
  });

  test("без открытой попытки достаточно --model: попытка заводится и закрывается разом", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Обновить зависимости");
    const r = await json("close", id, "--verdict", "rework", "--model", "p/big", "--retries", "2");
    expect(r.envelope.data.attribution).toMatchObject({
      recorded: true,
      model_id: "p/big",
      task_class: "config:unknown",
      verdict: "rework",
    });
    const list = await json("attempt", "list", "--task", id);
    expect(list.envelope.data[0]).toMatchObject({ retries: 2, source: "close" });
  });

  test("вердикт без модели и без попытки: закрытие проходит, но молчания нет", async () => {
    const id = await newTask("Что-то сделать");
    const r = await myc("close", id, "--verdict", "accepted");
    expect(r.code).toBe(ExitCode.OK);
    const parsed = await json("attempt", "list");
    expect(parsed.envelope.data).toHaveLength(0);
    expect(r.stdout as string).toContain("атрибуция НЕ записана");
  });

  test("модель мимо ростера на закрытии: задача НЕ закрывается (мутация 2)", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Что-то сделать");
    const r = await json("close", id, "--verdict", "accepted", "--model", "p/самозванец");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.envelope.error.code).toBe("notfound.model");
    const still = await json("close", id, "--verdict", "accepted", "--model", "p/big");
    expect(still.envelope.data.status).toBe("closed");
    expect(still.envelope.data.already).toBeUndefined();
  });

  test("закрытие без вердикта при открытой попытке предупреждает вслух", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Что-то сделать");
    await json("attempt", "start", id, "--model", "p/big");
    const r = await json("close", id);
    expect(r.envelope.warn.map((w: { code: string }) => w.code)).toContain("attribution.open");
    expect(r.envelope.data.attribution.recorded).toBe(false);
  });

  test("$MYC_MODEL мимо ростера не мешает закрыть задачу, но кричит", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Что-то сделать");
    process.env.MYC_MODEL = "p/из-другого-воркспейса";
    const r = await json("close", id, "--verdict", "accepted");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.status).toBe("closed");
    expect(r.envelope.warn.map((w: { code: string }) => w.code)).toContain(
      "attribution.env_model",
    );
    expect(r.envelope.data.attribution.recorded).toBe(false);
  });

  test("$MYC_MODEL без вердикта закрытию не мешает вовсе", async () => {
    const id = await newTask("Что-то сделать");
    process.env.MYC_MODEL = "p/из-другого-воркспейса";
    const r = await json("close", id);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.attribution).toBeUndefined();
  });

  test("вторая попытка по задаче не перетирает исход первой", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Что-то сделать");
    const started = await json("attempt", "start", id, "--model", "p/big");
    await json(
      "attempt", "finish", started.envelope.data.attemptId, "--verdict", "rejected",
    );
    const r = await json("close", id, "--verdict", "accepted", "--model", "p/big");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.attribution.recorded).toBe(true);
    expect(r.envelope.data.attribution.verdict).toBe("accepted");
    // Первая попытка своего вердикта не потеряла.
    const list = await json("attempt", "list", "--task", id);
    expect(list.envelope.data.map((a: { verdict: string }) => a.verdict).sort()).toEqual([
      "accepted",
      "rejected",
    ]);
  });

  test("исход не записался ПОСЛЕ закрытия — громкая деградация, а не мнимая ошибка", async () => {
    // Задача к этому моменту уже закрыта; сказать «ничего не произошло»
    // значило бы соврать. Триггер — отрицательное число кругов доработки:
    // домен отвергает его уже после смены статуса.
    await addModel("p/big", "3", "15");
    const id = await newTask("Что-то сделать");
    await json("attempt", "start", id, "--model", "p/big");
    const r = await json("close", id, "--verdict", "accepted", "--retries", "-1");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.status).toBe("closed");
    expect(r.envelope.warn.map((w: { code: string }) => w.code)).toContain(
      "attribution.failed",
    );
    expect(r.envelope.data.attribution.recorded).toBe(false);
    // Попытка осталась открытой: исход не записан, и это видно.
    const open = await json("attempt", "list", "--open");
    expect(open.envelope.data).toHaveLength(1);
  });

  test("опечатка в вердикте не закрывает задачу", async () => {
    const id = await newTask("Что-то сделать");
    const r = await json("close", id, "--verdict", "успех");
    expect(r.code).toBe(ExitCode.USAGE);
    const list = await json("attempt", "list");
    expect(list.envelope.data).toHaveLength(0);
  });

  test("оговорка без вердикта — ошибка, а не тихая потеря", async () => {
    const id = await newTask("Что-то сделать");
    const r = await json("close", id, "--caveat", "tests-weak");
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.envelope.error.code).toBe("usage.verdict");
  });
});

describe("человеческий вывод", () => {
  test("список — одна плотная строка на попытку, а не таблица в 21 колонку", async () => {
    await addModel("p/big", "3", "15");
    const id = await newTask("Исправить падение импорта");
    await json("attempt", "start", id, "--model", "p/big");
    await json("close", id, "--verdict", "accepted", "--caveat", "tests-weak");
    const r = await myc("attempt", "list");
    const lines = (r.stdout as string).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("accepted(tests_weak)");
    expect(lines[0]).toContain("q=0.60");
    expect(lines[0]).not.toContain("TOKENSCACHEREAD");
  });

  test("пустой список говорит словами, а не пустой таблицей", async () => {
    const r = await myc("attempt", "list");
    expect((r.stdout as string).trim()).toBe("попыток нет");
  });
});

describe("report models", () => {
  async function closed(
    title: string,
    model: string,
    verdict: string,
    caveat: string | null,
    tokensIn: string,
  ): Promise<void> {
    const id = await newTask(title);
    await json("attempt", "start", id, "--model", model, "--tokens-in", tokensIn, "--tokens-out", "0");
    const args = ["close", id, "--verdict", verdict];
    if (caveat !== null) args.push("--caveat", caveat);
    const r = await json(...args);
    expect(r.code).toBe(ExitCode.OK);
  }

  test("отвечает на вопрос: дешевле при равном результате", async () => {
    await addModel("p/cheap", "0.1", "0.4");
    await addModel("p/pricey", "3", "15");
    for (let i = 0; i < 4; i++) {
      await closed(`Исправить падение ${i}`, "p/cheap", "accepted", null, "1000000");
      await closed(`Исправить сбой ${i}`, "p/pricey", "accepted", null, "1000000");
    }
    const r = await json("report", "models", "--class", "fix:unknown");
    expect(r.code).toBe(ExitCode.OK);
    const cls = r.envelope.data.classes[0];
    expect(cls.answer).toBe("ok");
    expect(cls.cheapest).toBe("p/cheap|high");
    expect(r.envelope.data.tasksAttributed).toBe(8);
  });

  test("та же дешёвая модель с оговорками ответ НЕ выигрывает", async () => {
    await addModel("p/cheap", "0.1", "0.4");
    await addModel("p/pricey", "3", "15");
    for (let i = 0; i < 6; i++) {
      await closed(`Исправить падение ${i}`, "p/cheap", "accepted", "tests-weak,coordinator-fixed", "1000000");
      await closed(`Исправить сбой ${i}`, "p/pricey", "accepted", null, "1000000");
    }
    const r = await json("report", "models", "--class", "fix:unknown");
    const cls = r.envelope.data.classes[0];
    expect(cls.cheapest).toBe("p/pricey|high");
    expect(cls.equalGroup).toEqual(["p/pricey|high"]);
    const human = await myc("report", "models", "--class", "fix:unknown");
    expect(human.stdout as string).toContain("не имеет равных");
  });

  test("пустой воркспейс: отчёт признаёт отсутствие данных, а не выдумывает", async () => {
    const r = await myc("report", "models");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.stdout as string).toContain("атрибуции нет");
    expect(r.stdout as string).toContain("с атрибуцией 0");
  });

  test("--class мимо таксономии — ошибка", async () => {
    const r = await json("report", "models", "--class", "почти:local");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

describe("attempt finish --from-transcript: расход из стенограммы", () => {
  const SESSION = "510bfdf4-258b-45bd-9695-cd99f153dfc8";
  let transcripts: string;

  beforeEach(() => {
    transcripts = mkdtempSync(join(tmpdir(), "myc-transcripts-"));
    process.env.MYC_TRANSCRIPT_DIR = transcripts;
  });

  afterEach(() => {
    delete process.env.MYC_TRANSCRIPT_DIR;
    rmSync(transcripts, { recursive: true, force: true });
  });

  /** Запись стенограммы ровно того вида, что пишет Claude Code. */
  function line(msgId: string, u: Record<string, unknown> | undefined): string {
    const message: Record<string, unknown> = {
      model: "claude-opus-5",
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "…" }],
    };
    if (u !== undefined) message["usage"] = u;
    return JSON.stringify({
      type: "assistant",
      requestId: `req_${msgId}`,
      timestamp: "2026-09-06T18:02:27.702Z",
      message,
    });
  }

  function usage(i: number, o: number, r: number, w: number): Record<string, unknown> {
    return {
      input_tokens: i,
      output_tokens: o,
      cache_read_input_tokens: r,
      cache_creation_input_tokens: w,
    };
  }

  function transcript(name: string, lines: readonly string[]): string {
    const path = join(transcripts, name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  async function openAttempt(): Promise<string> {
    await addModel("p/big", "3", "15");
    const id = await newTask("Исправить падение импорта");
    const r = await json("attempt", "start", id, "--model", "p/big");
    expect(r.code).toBe(ExitCode.OK);
    return id;
  }

  test("--from-transcript заполняет четыре числа и считает стоимость", async () => {
    const id = await openAttempt();
    const path = transcript("t.jsonl", [
      line("msg_1", usage(1_000_000, 100_000, 26_443, 50_980)),
      // копии одного ответа: три записи, один message.id — расход один
      line("msg_2", usage(2, 243, 10, 5)),
      line("msg_2", usage(2, 243, 10, 5)),
    ]);
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-transcript", path);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data).toMatchObject({
      tokensIn: 1_000_002,
      tokensOut: 100_243,
      tokensCacheRead: 26_453,
      tokensCacheWrite: 50_985,
      costBasis: "priced",
    });
    // Все четыре ставки: 1000002*3 + 100243*15 + 26453*0.3 + 50985*3.75, /1e6.
    // Ставки кеша — умолчание `myc model add` (10%/125% от --price-in=3).
    expect(r.envelope.data.costUsd).toBeCloseTo(4.70278065, 6);
    expect(r.envelope.data.transcript).toMatchObject({ responses: 2, usageRecords: 3 });
  });

  test("--from-session находит файл по uuid в каталоге стенограмм", async () => {
    const id = await openAttempt();
    transcript(`${SESSION}.jsonl`, [line("msg_1", usage(10, 20, 30, 40))]);
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-session", SESSION);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data).toMatchObject({ tokensIn: 10, tokensOut: 20 });
    expect(r.envelope.data.transcript.sessionId).toBe(SESSION);
  });

  test("огромный расход доезжает до базы и обратно без потери точности", async () => {
    const id = await openAttempt();
    const path = transcript("huge.jsonl", [
      line("msg_1", usage(0, 161_221, 18_583_227, 393_908)),
      line("msg_2", usage(0, 1, 2_053_192_236, 0)),
    ]);
    await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-transcript", path);
    const shown = await json("attempt", "list", "--task", id);
    expect(shown.envelope.data[0].tokensCacheRead).toBe(2_071_775_463);
    expect(shown.envelope.data[0].tokensOut).toBe(161_222);
  });

  test("стенограмма без usage — ОТКАЗ, а не нулевой расход; попытка остаётся открытой", async () => {
    const id = await openAttempt();
    const path = transcript("nousage.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "привет" } }),
      line("msg_1", undefined),
    ]);
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-transcript", path);
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.envelope.error.code).toBe("transcript.no_usage");
    expect(r.envelope.error.msg).toContain("не ноль");
    const open = await json("attempt", "list", "--task", id, "--open");
    expect(open.envelope.data).toHaveLength(1);
    expect(open.envelope.data[0].costBasis).toBeNull();
  });

  test("пропало одно поле usage — отказ, а не заниженная стоимость", async () => {
    const id = await openAttempt();
    const path = transcript("lost.jsonl", [
      line("msg_1", { input_tokens: 2, output_tokens: 243, cache_creation_input_tokens: 5 }),
    ]);
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-transcript", path);
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.envelope.error.code).toBe("transcript.missing_field");
  });

  test("файла нет — отказ notfound, попытка не закрывается", async () => {
    const id = await openAttempt();
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-transcript", join(transcripts, "нет.jsonl"));
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.envelope.error.code).toBe("transcript.missing");
    expect((await json("attempt", "list", "--task", id, "--open")).envelope.data).toHaveLength(1);
  });

  test("сессии с таким uuid нет — отказ, а не тихий ноль", async () => {
    const id = await openAttempt();
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-session", "нет-такой-сессии");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.envelope.error.code).toBe("notfound.session");
  });

  test("источник расхода один: стенограмма и флаги вместе — отказ", async () => {
    const id = await openAttempt();
    const path = transcript("t.jsonl", [line("msg_1", usage(1, 2, 3, 4))]);
    const both = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-transcript", path, "--tokens-out", "999");
    expect(both.code).toBe(ExitCode.USAGE);
    expect(both.envelope.error.code).toBe("usage.token_source");
    expect(both.envelope.error.msg).toContain("--tokens-out");

    const two = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--from-transcript", path, "--from-session", SESSION);
    expect(two.code).toBe(ExitCode.USAGE);
    expect(two.envelope.error.code).toBe("usage.token_source");
  });

  test("без флагов источника всё работает как раньше: расход из --tokens-*", async () => {
    const id = await openAttempt();
    const r = await json("attempt", "finish", "--task", id, "--verdict", "accepted",
      "--tokens-in", "1000000", "--tokens-out", "100000");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.envelope.data.costUsd).toBeCloseTo(4.5, 9);
    expect(r.envelope.data.transcript).toBeUndefined();
  });
});
