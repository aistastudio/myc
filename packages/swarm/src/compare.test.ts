import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  Attribution,
  compareModels,
  ensureSwarmSchema,
  qualityInterval,
  Roster,
  type Caveat,
} from "./index.ts";

/**
 * Ответ на вопрос приёмки W11. Проверяется не «числа считаются», а то, что
 * ОТВЕТ МЕНЯЕТСЯ там, где обязан меняться, и что там, где данных нет,
 * отчёт молчит вслух, а не усредняет пустоту.
 */

const T0 = Date.parse("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;

let dir: string;
let db: Database;
let roster: Roster;
let attribution: Attribution;
let clock: number;

/** $ за 1M: дешёвая модель против дорогой. */
function model(id: string, usdIn: number, usdOut: number): void {
  roster.addModel({
    modelId: id,
    family: id,
    harness: "claude",
    effort: "high",
    price: { usdPerMIn: usdIn, usdPerMOut: usdOut, validFrom: T0 },
  });
}

interface Run {
  readonly modelId: string;
  readonly taskClass?: string;
  readonly verdict?: "accepted" | "rework" | "rejected";
  readonly caveats?: readonly Caveat[];
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

let seq = 0;

function run(input: Run): void {
  seq += 1;
  clock += HOUR;
  const a = attribution.startAttempt({
    taskId: `task-${seq}`,
    modelId: input.modelId,
    taskClass: input.taskClass ?? "fix:module",
  });
  attribution.finishAttempt(a.attemptId, {
    verdict: input.verdict ?? "accepted",
    caveats: input.caveats ?? [],
    tokensIn: input.tokensIn ?? 1_000_000,
    tokensOut: input.tokensOut ?? 100_000,
  });
}

function times(n: number, input: Run): void {
  for (let i = 0; i < n; i++) run(input);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-compare-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSwarmSchema(db);
  clock = T0;
  seq = 0;
  roster = new Roster(db, () => clock);
  attribution = new Attribution(db, () => clock);
  model("p/cheap", 0.1, 0.4);
  model("p/pricey", 3, 15);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // уже закрыта тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

function answer(taskClass = "fix:module") {
  const report = compareModels(db);
  const cls = report.classes.find((c) => c.taskClass === taskClass);
  expect(cls).toBeDefined();
  return cls!;
}

describe("вопрос отвечается", () => {
  test("при равном результате побеждает дешёвая рука", () => {
    times(6, { modelId: "p/cheap" });
    times(6, { modelId: "p/pricey" });
    const cls = answer();
    expect(cls.answer).toBe("ok");
    expect([...cls.equalGroup].sort()).toEqual(["p/cheap|high", "p/pricey|high"]);
    expect(cls.cheapest).toBe("p/cheap|high");
    // Результат действительно равный, а не «ещё не различили».
    expect(cls.separationPending).toBe(false);
  });

  test("ответ даётся ПО КЛАССАМ: на другом классе побеждает другая рука", () => {
    times(6, { modelId: "p/cheap", taskClass: "docs:local" });
    times(6, { modelId: "p/pricey", taskClass: "docs:local" });
    times(6, { modelId: "p/cheap", taskClass: "fix:cross", verdict: "rejected" });
    times(6, { modelId: "p/pricey", taskClass: "fix:cross" });
    expect(answer("docs:local").cheapest).toBe("p/cheap|high");
    expect(answer("fix:cross").cheapest).toBe("p/pricey|high");
  });

  test("дороже, но лучше: дешёвая рука с провалами не попадает в группу равных", () => {
    times(6, { modelId: "p/cheap", verdict: "rejected" });
    times(6, { modelId: "p/pricey" });
    const cls = answer();
    expect(cls.equalGroup).toEqual(["p/pricey|high"]);
    expect(cls.cheapest).toBe("p/pricey|high");
  });
});

describe("оговорки меняют ответ (мутация 1)", () => {
  /**
   * Живой случай координатора: дешёвая модель сдаёт работу, которую каждый
   * раз приходится доделывать, а тесты не ловят мутации. Если «принято с
   * оговорками» = успех, ответ переворачивается на неё.
   */
  const dirty: readonly Caveat[] = ["coordinator_fixed", "tests_weak"];

  test("честный учёт: рука с оговорками выбывает из равных, побеждает дорогая", () => {
    times(6, { modelId: "p/cheap", caveats: dirty });
    times(6, { modelId: "p/pricey" });
    const cls = answer();
    expect(cls.arms.find((a) => a.modelId === "p/cheap")!.qualityMean).toBeCloseTo(0.25, 12);
    expect(cls.arms.find((a) => a.modelId === "p/cheap")!.cleanRate).toBe(0);
    expect(cls.equalGroup).toEqual(["p/pricey|high"]);
    expect(cls.cheapest).toBe("p/pricey|high");
  });

  test("мало наблюдений: дешёвая рука побеждает, но отчёт признаёт, что не различил", () => {
    times(3, { modelId: "p/cheap", caveats: dirty });
    times(3, { modelId: "p/pricey" });
    const cls = answer();
    expect(cls.cheapest).toBe("p/cheap|high");
    expect(cls.qualityLeader).toBe("p/pricey|high");
    expect(cls.separationPending).toBe(true);
    expect(cls.why).toContain("not enough observations");
  });

  test("если оговорки свести к успеху, ответ переворачивается на дешёвую руку", () => {
    times(6, { modelId: "p/cheap", caveats: dirty });
    times(6, { modelId: "p/pricey" });
    // Ровно то, что делает мутация: стираем оговорки, оставляя вердикт.
    db.query("UPDATE swarm_attempt SET caveats = '[]'").run();
    const cls = answer();
    expect(cls.cheapest).toBe("p/cheap|high");
  });

  test("оговорки видны поимённо, а не одним числом", () => {
    times(4, { modelId: "p/cheap", caveats: ["tests_weak"] });
    times(2, { modelId: "p/cheap", caveats: ["report_inaccurate"] });
    const arm = answer().arms.find((a) => a.modelId === "p/cheap")!;
    expect(arm.caveatCounts).toEqual({ tests_weak: 4, report_inaccurate: 2 });
  });
});

describe("отчёт молчит вслух", () => {
  test("мало наблюдений — insufficient_attempts, а не победитель по двум попыткам", () => {
    times(2, { modelId: "p/cheap" });
    times(2, { modelId: "p/pricey" });
    const cls = answer();
    expect(cls.answer).toBe("insufficient_attempts");
    expect(cls.cheapest).toBeNull();
  });

  test("одна рука — single_arm, а не «дешевле всех»", () => {
    times(6, { modelId: "p/cheap" });
    const cls = answer();
    expect(cls.answer).toBe("single_arm");
    expect(cls.cheapest).toBeNull();
  });

  test("нет токенов — no_cost_data и видимая доля покрытия", () => {
    times(6, { modelId: "p/cheap", tokensIn: 0, tokensOut: 0 });
    times(6, { modelId: "p/pricey", tokensIn: 0, tokensOut: 0 });
    const cls = answer();
    expect(cls.answer).toBe("no_cost_data");
    expect(cls.cheapest).toBeNull();
    expect(cls.arms.every((a) => a.costCoverage === 0)).toBe(true);
  });

  test("покрытие стоимости частично — видно, по скольким попыткам считали", () => {
    times(3, { modelId: "p/cheap" });
    times(3, { modelId: "p/cheap", tokensIn: 0, tokensOut: 0 });
    const arm = answer().arms.find((a) => a.modelId === "p/cheap")!;
    expect(arm.attempts).toBe(6);
    expect(arm.costedAttempts).toBe(3);
    expect(arm.costCoverage).toBeCloseTo(0.5, 12);
  });

  test("пустая база даёт пустой ответ без выдуманных классов", () => {
    const report = compareModels(db);
    expect(report.classes).toEqual([]);
    expect(report.coverage).toMatchObject({ attempts: 0, finished: 0, withCost: 0 });
  });

  test("открытые попытки в ответ не входят", () => {
    times(6, { modelId: "p/cheap" });
    attribution.startAttempt({
      taskId: "open-1",
      modelId: "p/pricey",
      taskClass: "fix:module",
    });
    const report = compareModels(db);
    expect(report.coverage.attempts).toBe(7);
    expect(report.coverage.finished).toBe(6);
    expect(answer().arms.map((a) => a.modelId)).toEqual(["p/cheap"]);
  });
});

describe("интервал доверия", () => {
  test("три единицы дают широкий интервал, тридцать — узкий", () => {
    const few = qualityInterval([1, 1, 1]);
    const many = qualityInterval(Array.from({ length: 30 }, () => 1));
    expect(few.hi - few.lo).toBeGreaterThan(many.hi - many.lo);
    expect(few.lo).toBeLessThan(0.7);
    expect(many.lo).toBeGreaterThan(0.85);
  });

  test("интервал накрывает среднее и лежит в [0,1]", () => {
    const iv = qualityInterval([1, 0.5, 0.25, 0.75]);
    expect(iv.lo).toBeGreaterThanOrEqual(0);
    expect(iv.hi).toBeLessThanOrEqual(1);
    expect(iv.lo).toBeLessThan(0.625);
    expect(iv.hi).toBeGreaterThan(0.625);
  });
});

describe("стоимость в ответе — замороженная (мутация 3)", () => {
  test("правка прайса после закрытия не двигает ответ", () => {
    times(6, { modelId: "p/cheap" });
    times(6, { modelId: "p/pricey" });
    const before = answer();
    // Дешёвая модель подорожала в сто раз ПОСЛЕ того, как задачи закрыты.
    clock += 24 * HOUR;
    roster.updateModel("p/cheap", {
      price: { usdPerMIn: 300, usdPerMOut: 1500, validFrom: clock },
    });
    const after = answer();
    expect(after.cheapest).toBe(before.cheapest);
    expect(after.arms.find((a) => a.modelId === "p/cheap")!.costUsdMean).toBeCloseTo(
      before.arms.find((a) => a.modelId === "p/cheap")!.costUsdMean!,
      12,
    );
  });
});
