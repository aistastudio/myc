import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Attribution, compareModels, ensureSwarmSchema, Roster } from "./index.ts";

/**
 * Цена кеша в счёте стоимости (memory-501fa4jp7xpw).
 *
 * Проверяется НЕ «стало дороже»: равномерное занижение прошло бы и на
 * сломанной формуле — при сравнении двух рук общий множитель сокращается,
 * и ответ «кто дешевле» не меняется. Проверяется ПЕРЕСТАНОВКА: две руки с
 * РАЗНОЙ долей кеша в объёме — одна много читала и мало писала, другая
 * наоборот. По выходным токенам первая дешевле, по полному счёту — дороже.
 * Любая мутация, обнуляющая ставки кеша (в цене, в формуле или в записи
 * ростера), возвращает ответ к первой — и роняет `перестановка` ниже.
 */

const T0 = Date.parse("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;

/** Один прайс на обе руки: разница в ответе — только от профиля расхода. */
const PRICE = {
  usdPerMIn: 3,
  usdPerMOut: 15,
  usdPerMCacheRead: 0.3,
  usdPerMCacheWrite: 3.75,
  validFrom: T0,
} as const;

/** Много читал, мало писал — тот профиль, что нынешняя формула хоронит. */
const READER = { tokensIn: 200, tokensOut: 20_000, cacheRead: 20_000_000, cacheWrite: 100_000 };
/** Много писал, мало читал. */
const WRITER = { tokensIn: 200, tokensOut: 120_000, cacheRead: 1_000_000, cacheWrite: 100_000 };

let dir: string;
let db: Database;
let roster: Roster;
let attribution: Attribution;
let clock: number;
let seq = 0;

function run(modelId: string, u: typeof READER): void {
  seq += 1;
  clock += HOUR;
  const a = attribution.startAttempt({
    taskId: `task-${seq}`,
    modelId,
    taskClass: "fix:module",
  });
  attribution.finishAttempt(a.attemptId, {
    verdict: "accepted",
    tokensIn: u.tokensIn,
    tokensOut: u.tokensOut,
    tokensCacheRead: u.cacheRead,
    tokensCacheWrite: u.cacheWrite,
  });
}

/** Стоимость по всем четырём ставкам, $. */
function full(u: typeof READER): number {
  return (
    (u.tokensIn * PRICE.usdPerMIn +
      u.tokensOut * PRICE.usdPerMOut +
      u.cacheRead * PRICE.usdPerMCacheRead +
      u.cacheWrite * PRICE.usdPerMCacheWrite) /
    1e6
  );
}

/** Стоимость так, как её считали до исправления: кеш по нулевой ставке. */
function withoutCache(u: typeof READER): number {
  return (u.tokensIn * PRICE.usdPerMIn + u.tokensOut * PRICE.usdPerMOut) / 1e6;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-cacheprice-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSwarmSchema(db);
  clock = T0;
  seq = 0;
  roster = new Roster(db, () => clock);
  attribution = new Attribution(db, () => clock);
  for (const id of ["p/reader", "p/writer"]) {
    roster.addModel({ modelId: id, family: id, harness: "claude", effort: "high", price: PRICE });
  }
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // уже закрыта
  }
  rmSync(dir, { recursive: true, force: true });
});

test("перестановка: с ценой кеша дешевле оказывается ДРУГАЯ рука", () => {
  // Без кеша дешевле «читатель», с кешем — «писатель». Тест на равномерное
  // занижение (одинаковый профиль у обеих рук) этого бы не увидел.
  expect(withoutCache(READER)).toBeLessThan(withoutCache(WRITER));
  expect(full(READER)).toBeGreaterThan(full(WRITER));

  for (let i = 0; i < 4; i++) {
    run("p/reader", READER);
    run("p/writer", WRITER);
  }

  const cls = compareModels(db).classes.find((c) => c.taskClass === "fix:module")!;
  expect(cls.answer).toBe("ok");
  expect([...cls.equalGroup].sort()).toEqual(["p/reader|high", "p/writer|high"]);
  expect(cls.cheapest).toBe("p/writer|high");

  const byArm = new Map(cls.arms.map((a) => [a.arm, a]));
  expect(byArm.get("p/reader|high")!.costUsdMean!).toBeCloseTo(full(READER), 6);
  expect(byArm.get("p/writer|high")!.costUsdMean!).toBeCloseTo(full(WRITER), 6);
});

test("равная доля кеша: ответ не переставляется — почему такой тест не годится", () => {
  // Обе руки с профилем READER: цена кеша меняет обе стоимости одинаково,
  // и «кто дешевле» остаётся прежним. Именно поэтому проверять нужно
  // перестановку, а не «стало дороже».
  for (let i = 0; i < 4; i++) {
    run("p/reader", READER);
    run("p/writer", { ...READER, tokensOut: READER.tokensOut * 2 });
  }
  const cls = compareModels(db).classes.find((c) => c.taskClass === "fix:module")!;
  expect(cls.cheapest).toBe("p/reader|high");
});

test("ставки кеша заведены — cacheUnpriced молчит; нулевые — говорит", () => {
  expect(roster.getModel("p/reader", clock)!.cacheUnpriced).toBe(false);
  roster.addModel({
    modelId: "p/zero",
    family: "p/zero",
    harness: "claude",
    effort: "high",
    price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: T0 },
  });
  const zero = roster.getModel("p/zero", clock)!;
  expect(zero.price!.usdPerMCacheRead).toBe(0);
  expect(zero.cacheUnpriced).toBe(true);
});

test("отчёт называет попытки, замороженные по нулевой цене кеша", () => {
  roster.addModel({
    modelId: "p/zero-price",
    family: "p/zero-price",
    harness: "claude",
    effort: "high",
    price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: T0 },
  });
  for (let i = 0; i < 3; i++) {
    run("p/reader", READER);
    run("p/zero-price", READER);
  }
  const report = compareModels(db);
  expect(report.coverage.withCost).toBe(6);
  // Три попытки «нулевой» руки — с кеш-токенами и без цены кеша.
  expect(report.coverage.costCacheUnpriced).toBe(3);
});

test("исправление цены после заморозки не проходит молча — costStale", () => {
  for (let i = 0; i < 3; i++) run("p/reader", READER);
  expect(compareModels(db).coverage.costStale).toBe(0);
  // Ту же строку цены дописали ставками кеша — замороженные числа устарели.
  db.query(
    `UPDATE swarm_model_price SET usd_per_m_cache_read = 0.6
      WHERE model_id = 'p/reader' AND valid_from = ?1`,
  ).run(T0);
  const report = compareModels(db);
  expect(report.coverage.costStale).toBe(3);
  expect(report.coverage.withCost).toBe(3);
});

test("отрицательная ставка кеша не записывается", () => {
  expect(() =>
    roster.addModel({
      modelId: "p/bad",
      family: "p/bad",
      harness: "claude",
      effort: "high",
      price: { ...PRICE, usdPerMCacheRead: -1 },
    }),
  ).toThrow(/usdPerMCacheRead/);
  expect(roster.getModel("p/bad", clock)).toBeUndefined();
});
