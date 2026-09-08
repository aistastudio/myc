/**
 * Тесты чистой логики бенчмарка бюджетов латентности (myc-noq): статистика,
 * вердикт по бюджету И1 и по регрессии к базовой линии. Сами измерения
 * (реальная БД на 100k узлов, спавн бинаря) намеренно не юнит-тестируются —
 * это интеграционный прогон `bun run bench:latency`, а не unit; здесь
 * проверяется только детерминированная арифметика вокруг них.
 */

import { describe, expect, test } from "bun:test";
import {
  BUDGETS,
  REGRESSION_METRIC,
  REGRESSION_PCT,
  fails,
  judge,
  percentile,
  summarize,
  type Baseline,
  type Timed,
} from "./bench-latency.ts";
import { JITTER_MAX } from "@myc/bench";

/**
 * Замер вместе с условием, при котором он получен. По умолчанию — «машина
 * была свободна» (дрожание эталона 1.0): в такой обстановке абсолютный
 * бюджет и проверяется.
 */
function timed(samples: readonly number[], jitter = 1): Timed {
  return { ...summarize(samples), jitter };
}

describe("percentile/summarize", () => {
  test("p50/p95/p99 на отсортированном наборе", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const s = summarize(samples);
    expect(s.n).toBe(100);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
  });

  test("не зависит от порядка входных данных", () => {
    const shuffled = [5, 1, 4, 2, 3];
    const s = summarize(shuffled);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.p50).toBe(3);
  });

  test("единственный образец — все перцентили равны ему", () => {
    const s = summarize([42]);
    expect(s.p50).toBe(42);
    expect(s.p95).toBe(42);
    expect(s.p99).toBe(42);
  });

  test("percentile никогда не выходит за границы массива", () => {
    const sorted = [1, 2, 3];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(3);
  });
});

describe("judge — бюджет", () => {
  test("укладывается в бюджет и без базовой линии — OK", () => {
    const stats = timed([1, 1, 1, 1, 1]);
    const v = judge("read", stats, {});
    expect(v.budgetMs).toBe(BUDGETS.read!.p99Ms);
    expect(v.budgetOk).toBe(true);
    expect(v.baselineValue).toBeNull();
    expect(v.regressionOk).toBe(true); // нет baseline — регрессию не с чем сравнивать
  });

  /**
   * Проверяются ОБЕ стороны калибровки, и окружение задаётся явно, а не
   * наследуется от прогона: в CI стоит `MYC_BENCH_ABSOLUTE=0`, и тест,
   * читавший внешнюю переменную, начал утверждать обратное тому, что
   * задумано, — покраснел там, где поведение было верным.
   */
  test("p99 выше бюджета — FAIL на откалиброванной машине, наблюдение на чужой", () => {
    const stats = timed(Array(100).fill(999)); // намного больше любого бюджета
    const v = judge("write", stats, {});
    expect(v.budgetOk).toBe(false);
    expect(v.quiet).toBe(true);

    const saved = process.env["MYC_BENCH_ABSOLUTE"];
    try {
      delete process.env["MYC_BENCH_ABSOLUTE"];
      expect(fails(v, false)).toBe(true);
      process.env["MYC_BENCH_ABSOLUTE"] = "0";
      // Машина не откалибрована: число печатается, сборка не падает.
      expect(fails(v, false)).toBe(false);
      process.env["MYC_BENCH_STRICT"] = "1";
      // Ночной стенд: абсолют обязателен, выключатель его не отменяет.
      expect(fails(v, false)).toBe(true);
    } finally {
      delete process.env["MYC_BENCH_STRICT"];
      if (saved === undefined) delete process.env["MYC_BENCH_ABSOLUTE"];
      else process.env["MYC_BENCH_ABSOLUTE"] = saved;
    }
  });

  /**
   * Ровно то, ради чего заводилась методика (memory-ws31ztqgh43c): нарушенный
   * бюджет на ЗАНЯТОЙ машине — не приговор коду, а сообщение о соседе по
   * процессору. Число печатается, прогон не падает; проверка добирается
   * ночным прогоном, где условия проверены заранее.
   */
  test("бюджет нарушен, но машина была занята — прогон не падает", () => {
    const stats = timed(Array(100).fill(999), JITTER_MAX + 0.5);
    const v = judge("write", stats, {});
    expect(v.budgetOk).toBe(false);
    expect(v.quiet).toBe(false);
    expect(fails(v, false)).toBe(false);
  });

  test("дрожание ровно на пороге ещё считается годными условиями", () => {
    const stats = timed(Array(100).fill(999), JITTER_MAX);
    expect(judge("write", stats, {}).quiet).toBe(true);
  });
});

describe("judge — регрессия к базовой линии", () => {
  const baseline: Baseline = {
    search: { p50: 5, p95: 10, p99: 12, updated_at: "2026-01-01T00:00:00.000Z" },
  };

  test("рост p95 меньше порога — не регрессия", () => {
    // +14% от baseline p95=10 → 11.4, ниже порога REGRESSION_PCT=15%
    const stats = timed(Array(20).fill(11.3));
    const v = judge("search", stats, baseline);
    expect(v.regressionPct).toBeLessThan(REGRESSION_PCT);
    expect(v.regressionOk).toBe(true);
  });

  test("рост p95 больше порога — регрессия", () => {
    // +50% от baseline p95=10 → 15
    const stats = timed(Array(20).fill(15));
    const v = judge("search", stats, baseline);
    expect(v.regressionPct).toBeGreaterThan(REGRESSION_PCT);
    expect(v.regressionOk).toBe(false);
  });

  test("улучшение (p95 ниже baseline) — не регрессия", () => {
    const stats = timed(Array(20).fill(1));
    const v = judge("search", stats, baseline);
    expect(v.regressionPct).toBeLessThan(0);
    expect(v.regressionOk).toBe(true);
  });

  test("граница порога ровно REGRESSION_PCT — ещё OK (<=)", () => {
    const target = 10 * (1 + REGRESSION_PCT / 100);
    const stats = timed(Array(20).fill(target));
    const v = judge("search", stats, baseline);
    expect(v.regressionOk).toBe(true);
  });
});

/**
 * cold_start сравнивается по p50, а не по p95 (REGRESSION_METRIC): 25 спавнов
 * процесса дают p95, гуляющий на 4 мс от соседей по машине при p50,
 * устойчивом в пределах 1.3 мс. Проверка поведенческая: если правило снять,
 * набор ниже перестанет быть регрессией — на нём p50 вырос вдвое, а p95
 * остался прежним.
 */
describe("judge — cold_start сравнивается по p50", () => {
  const baseline: Baseline = {
    cold_start: { p50: 20, p95: 40, p99: 45, updated_at: "2026-01-01T00:00:00.000Z" },
    search: { p50: 5, p95: 10, p99: 12, updated_at: "2026-01-01T00:00:00.000Z" },
  };

  test("метрика объявлена явно", () => {
    expect(REGRESSION_METRIC.cold_start).toBe("p50");
    expect(REGRESSION_METRIC.search).toBeUndefined(); // умолчание — p95
  });

  test("вырос p50 при неизменном p95 — это регрессия", () => {
    // 19 замеров по 40 мс и один 40: p50=40 (вдвое выше линии), p95=40 (как линия).
    const stats = timed(Array(20).fill(40));
    const v = judge("cold_start", stats, baseline);
    expect(v.metric).toBe("p50");
    expect(v.baselineValue).toBe(20);
    expect(v.currentValue).toBe(40);
    expect(v.regressionOk).toBe(false);
  });

  test("одинокий выброс в хвосте не роняет сборку", () => {
    // p50=20 (ровно линия), но пара замеров по 100 мс задирает p95 до 100.
    const samples = [...Array(18).fill(20), 100, 100];
    const stats = timed(samples);
    const v = judge("cold_start", stats, baseline);
    expect(stats.p95).toBeGreaterThan(40);
    expect(v.regressionOk).toBe(true);
  });

  test("бюджет И1 по-прежнему считается по p99, а не по метрике сравнения", () => {
    const stats = timed([...Array(24).fill(10), 999]);
    const v = judge("cold_start", stats, baseline);
    expect(v.metric).toBe("p50");
    expect(v.budgetOk).toBe(false); // p99=999 > 60
  });
});
