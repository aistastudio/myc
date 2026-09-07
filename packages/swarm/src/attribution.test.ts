import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  Attribution,
  AttributionError,
  CAVEATS,
  ensureSwarmSchema,
  qualityOf,
  Roster,
  RosterError,
} from "./index.ts";

/**
 * Атрибуция исполнения. Часы подменяются: заморозка стоимости и
 * «цена на момент попытки» проверяются детерминированно.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

let dir: string;
let db: Database;
let roster: Roster;
let attribution: Attribution;
let now: number;

function addModel(modelId: string, over: Partial<{ harness: string; effort: string; in: number; out: number }> = {}): void {
  roster.addModel({
    modelId,
    family: modelId.split("/").at(-1)!,
    harness: (over.harness ?? "claude") as "claude",
    effort: (over.effort ?? "high") as "high",
    price: { usdPerMIn: over.in ?? 3, usdPerMOut: over.out ?? 15, validFrom: T0 },
  });
}

function start(over: Partial<{ taskId: string; modelId: string; taskClass: string }> = {}) {
  return attribution.startAttempt({
    taskId: over.taskId ?? "memory-aaaa",
    modelId: over.modelId ?? "p/big",
    taskClass: over.taskClass ?? "fix:module",
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-attr-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSwarmSchema(db);
  now = T0;
  roster = new Roster(db, () => now);
  attribution = new Attribution(db, () => now);
  addModel("p/big");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // уже закрыта тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("связь с ростером", () => {
  test("харнесс и уровень наследуются из ростера: одна модель вместо трёх флагов", () => {
    addModel("p/oc", { harness: "opencode", effort: "low" });
    const a = attribution.startAttempt({
      taskId: "t1",
      modelId: "p/oc",
      taskClass: "docs:local",
    });
    expect(a.harness).toBe("opencode");
    expect(a.effort).toBe("low");
  });

  test("модель мимо ростера отвергается ДО записи, призрака не остаётся", () => {
    let code = "";
    try {
      attribution.startAttempt({ taskId: "t1", modelId: "p/самозванец", taskClass: "fix:local" });
    } catch (e) {
      code = (e as RosterError).code;
    }
    expect(code).toBe("notfound.model");
    const rows = db.query("SELECT count(*) AS n FROM swarm_attempt").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("барьер дублируется схемой: прямой INSERT мимо ростера не проходит", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO swarm_attempt (attempt_id, task_id, model_id, harness, task_class, started_at)
           VALUES ('att_x', 't1', 'p/самозванец', 'claude', 'fix:local', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  test("выключенная модель остаётся пригодной для атрибуции: история переживает disable", () => {
    roster.disableModel("p/big");
    expect(start().modelId).toBe("p/big");
  });
});

describe("вердикт и оговорки", () => {
  test("принято без оговорок — единица", () => {
    expect(qualityOf("accepted")).toBe(1);
  });

  test.each([...CAVEATS])("принято с оговоркой %s — строго меньше единицы", (caveat) => {
    expect(qualityOf("accepted", [caveat])).toBeLessThan(1);
  });

  test("оговорки складываются, но не проваливают ниже пола", () => {
    expect(qualityOf("accepted", [...CAVEATS])).toBe(0.1);
    expect(qualityOf("accepted", ["tests_weak"])).toBeGreaterThan(
      qualityOf("accepted", ["tests_weak", "coordinator_fixed"]),
    );
  });

  test("повтор одной оговорки не штрафует дважды", () => {
    expect(qualityOf("accepted", ["tests_weak", "tests_weak"])).toBe(
      qualityOf("accepted", ["tests_weak"]),
    );
  });

  test("возврат на доработку ниже чистой приёмки, отказ — ноль при любых оговорках", () => {
    expect(qualityOf("rework")).toBeLessThan(qualityOf("accepted"));
    expect(qualityOf("rejected", ["tests_weak"])).toBe(0);
  });

  test("качество не колонка, а формула: читается вместе с попыткой", () => {
    const a = attribution.startAttempt({ taskId: "t1", modelId: "p/big", taskClass: "fix:local" });
    const done = attribution.finishAttempt(a.attemptId, {
      verdict: "accepted",
      caveats: ["tests_weak", "report_inaccurate"],
    });
    expect(done.quality).toBeCloseTo(qualityOf("accepted", ["tests_weak", "report_inaccurate"]), 12);
    expect(done.caveats).toEqual(["tests_weak", "report_inaccurate"]);
    const cols = db.query("PRAGMA table_info(swarm_attempt)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("quality");
  });

  test("неизвестный вердикт и неизвестная оговорка отвергаются, попытка остаётся открытой", () => {
    const a = start();
    expect(() => attribution.finishAttempt(a.attemptId, { verdict: "успех" })).toThrow(
      AttributionError,
    );
    expect(() =>
      attribution.finishAttempt(a.attemptId, { verdict: "accepted", caveats: ["почти"] }),
    ).toThrow(AttributionError);
    expect(attribution.getAttempt(a.attemptId)!.finishedAt).toBeNull();
  });

  test("класс мимо таксономии не записывается", () => {
    expect(() =>
      attribution.startAttempt({ taskId: "t1", modelId: "p/big", taskClass: "почти:local" }),
    ).toThrow(AttributionError);
  });
});

describe("заморозка стоимости", () => {
  test("считается по цене на момент старта и не меняется от правки прайса", () => {
    const a = attribution.startAttempt({
      taskId: "t1",
      modelId: "p/big",
      taskClass: "fix:local",
    });
    now = T0 + DAY;
    const done = attribution.finishAttempt(a.attemptId, {
      verdict: "accepted",
      tokensIn: 1_000_000,
      tokensOut: 100_000,
    });
    expect(done.costUsd).toBeCloseTo(3 + 1.5, 12);
    expect(done.priceValidFrom).toBe(T0);
    expect(done.costBasis).toBe("priced");

    // Цена выросла втрое — уже закрытая попытка обязана остаться прежней.
    now = T0 + 2 * DAY;
    roster.updateModel("p/big", {
      price: { usdPerMIn: 9, usdPerMOut: 45, validFrom: T0 + 2 * DAY },
    });
    expect(attribution.getAttempt(a.attemptId)!.costUsd).toBeCloseTo(4.5, 12);
  });

  test("цена, начавшая действовать ПОСЛЕ старта, к попытке не применяется", () => {
    roster.updateModel("p/big", {
      price: { usdPerMIn: 100, usdPerMOut: 100, validFrom: T0 + 10 * DAY },
    });
    const a = attribution.startAttempt({
      taskId: "t1",
      modelId: "p/big",
      taskClass: "fix:local",
      startedAt: T0 + DAY,
    });
    const done = attribution.finishAttempt(a.attemptId, {
      verdict: "accepted",
      tokensIn: 1_000_000,
      tokensOut: 0,
    });
    expect(done.costUsd).toBeCloseTo(3, 12);
    expect(done.priceValidFrom).toBe(T0);
  });

  test("нет токенов — стоимость null и причина названа, а не ноль", () => {
    const done = attribution.finishAttempt(start().attemptId, { verdict: "accepted" });
    expect(done.costUsd).toBeNull();
    expect(done.costBasis).toBe("no_tokens");
  });

  test("нет цены на момент старта — no_price, а не молчаливый ноль", () => {
    const a = attribution.startAttempt({
      taskId: "t1",
      modelId: "p/big",
      taskClass: "fix:local",
      startedAt: T0 - 10 * DAY,
    });
    const done = attribution.finishAttempt(a.attemptId, {
      verdict: "accepted",
      tokensIn: 1000,
      tokensOut: 1000,
    });
    expect(done.costUsd).toBeNull();
    expect(done.costBasis).toBe("no_price");
  });

  test("кеш-токены входят в счёт по своим ставкам, а не по входным", () => {
    roster.addModel({
      modelId: "p/cached",
      family: "cached",
      harness: "claude",
      price: {
        usdPerMIn: 3,
        usdPerMOut: 15,
        usdPerMCacheRead: 0.3,
        usdPerMCacheWrite: 3.75,
        validFrom: T0,
      },
    });
    const a = attribution.startAttempt({
      taskId: "t1",
      modelId: "p/cached",
      taskClass: "fix:local",
    });
    const done = attribution.finishAttempt(a.attemptId, {
      verdict: "accepted",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      tokensCacheRead: 1_000_000,
      tokensCacheWrite: 1_000_000,
    });
    expect(done.costUsd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 12);
  });
});

describe("расход бывает огромным", () => {
  test("миллиарды токенов кеша доезжают до базы и обратно без потери", () => {
    const a = attribution.startAttempt({
      taskId: "t1",
      modelId: "p/big",
      taskClass: "fix:local",
    });
    const done = attribution.finishAttempt(a.attemptId, {
      verdict: "accepted",
      tokensCacheRead: 2_053_192_236,
      tokensCacheWrite: 27_989_067,
    });
    expect(done.tokensCacheRead).toBe(2_053_192_236);
    expect(attribution.getAttempt(a.attemptId)!.tokensCacheRead).toBe(2_053_192_236);
  });

  test("число за пределом точных целых отвергается, а не округляется молча", () => {
    const a = attribution.startAttempt({
      taskId: "t1",
      modelId: "p/big",
      taskClass: "fix:local",
    });
    // 2^53 — целое, но уже неточное: соседние значения неразличимы, и
    // записанное число не равно тому, что померили.
    expect(() =>
      attribution.finishAttempt(a.attemptId, { verdict: "accepted", tokensCacheRead: 2 ** 53 }),
    ).toThrow(AttributionError);
    expect(attribution.getAttempt(a.attemptId)!.finishedAt).toBeNull();
  });
});

describe("схема на пути чтения", () => {
  test("накатанный набор не открывает транзакцию записи: проходит на readonly-соединении", () => {
    // Прямое наблюдение вместо счётчика: любая запись на readonly-базе
    // падает. Раз накат проходит — быстрый путь ensureSwarmSchema не
    // пишет, и читающие команды (report/list/close без вердикта) не берут
    // блокировку записи на ровном месте.
    const path = join(dir, "myc.db");
    db.close();
    const ro = new Database(path, { readonly: true });
    expect(() => ensureSwarmSchema(ro)).not.toThrow();
    // Контроль: медленный путь начинается с CREATE TABLE, и он на этом
    // соединении падает — значит быстрый путь до записи не доходил.
    expect(() => ro.exec("CREATE TABLE probe_readonly (x)")).toThrow(/readonly/i);
    ro.close();
    db = new Database(path);
  });
});

describe("жизненный цикл", () => {
  test("открытая попытка находится по задаче и закрывается один раз", () => {
    const a = start({ taskId: "t7" });
    expect(attribution.openAttemptForTask("t7")!.attemptId).toBe(a.attemptId);
    attribution.finishAttempt(a.attemptId, { verdict: "accepted" });
    expect(attribution.openAttemptForTask("t7")).toBeUndefined();
    let code = "";
    try {
      attribution.finishAttempt(a.attemptId, { verdict: "rejected" });
    } catch (e) {
      code = (e as AttributionError).code;
    }
    expect(code).toBe("conflict.finished");
    expect(attribution.getAttempt(a.attemptId)!.verdict).toBe("accepted");
  });

  test("несуществующая попытка — notfound.attempt", () => {
    let code = "";
    try {
      attribution.finishAttempt("att_000000000000", { verdict: "accepted" });
    } catch (e) {
      code = (e as AttributionError).code;
    }
    expect(code).toBe("notfound.attempt");
  });

  test("список фильтруется по задаче и по открытости", () => {
    const a = start({ taskId: "t1" });
    start({ taskId: "t2" });
    attribution.finishAttempt(a.attemptId, { verdict: "accepted" });
    expect(attribution.listAttempts({ taskId: "t1" })).toHaveLength(1);
    expect(attribution.listAttempts({ open: true }).map((x) => x.taskId)).toEqual(["t2"]);
  });
});
