/**
 * Тесты самой методики (@myc/bench). Проверяется РЕШАЮЩАЯ ЛОГИКА,
 * а не замеры: когда абсолютный бюджет роняет прогон, когда только печатается,
 * и что относительные утверждения ловят вырождение здорового пути в
 * деградировавший. Сами числа приходят из реальных стендов в
 * packages/*\/src/**.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  JITTER_MAX,
  expectAheadOfRival,
  expectCostAtMost,
  expectWithinBudget,
  measure,
  percentile,
  summarize,
  type Measured,
  type Stats,
} from "./index.ts";

function stats(p50: number, p99 = p50): Stats {
  return { n: 100, p50, p95: (p50 + p99) / 2, p99, min: p50, max: p99 };
}

function measured(over: Partial<Measured> = {}): Measured {
  const s = over.stats ?? stats(1, 2);
  const ref = over.ref ?? stats(1, 1);
  const jitter = over.jitter ?? ref.p99 / ref.p50;
  const budgetMs = over.budgetMs ?? 1.5;
  const quiet = over.quiet ?? jitter <= JITTER_MAX;
  const strict = over.strict ?? false;
  const rival = over.rival ?? null;
  return {
    label: "проба",
    stats: s,
    ref,
    jitter,
    quiet,
    budgetMs,
    verdict:
      budgetMs === null
        ? "none"
        : s.p99 <= budgetMs
          ? "ok"
          : quiet || strict
            ? "over"
            : "unreliable",
    machine: { cpus: 8, load1: 1, load5: 1 },
    strict,
    rival,
    slowdown: rival ? rival.p50 / s.p50 : null,
    rivalLabel: over.rivalLabel ?? null,
    ...over,
  } as Measured;
}

describe("percentile/summarize", () => {
  test("перцентили считаются по той же формуле, что в bench-latency", () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
  });

  test("пустой набор не роняет summarize", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.p50).toBe(0);
  });
});

describe("абсолютный бюджет — пункт 3 методики", () => {
  test("в бюджете — молчит", () => {
    expect(() => expectWithinBudget(measured({ stats: stats(0.5, 1) }))).not.toThrow();
  });

  test("нарушен на свободной машине — падает и называет числа", () => {
    const m = measured({ stats: stats(3, 9), ref: stats(1, 1) });
    expect(m.verdict).toBe("over");
    expect(() => expectWithinBudget(m)).toThrow(/бюджет нарушен/);
    expect(() => expectWithinBudget(m)).toThrow(/это регрессия, а не загрузка машины/);
  });

  /**
   * Главный случай, ради которого всё затевалось: те же числа, но машина
   * дрожит. Прогон не падает — измерен сосед по процессору, а не код.
   */
  test("нарушен на занятой машине — НЕ падает", () => {
    const m = measured({ stats: stats(3, 9), ref: stats(1, JITTER_MAX + 1) });
    expect(m.verdict).toBe("unreliable");
    expect(() => expectWithinBudget(m)).not.toThrow();
  });

  test("строгий режим возвращает обязательность при любых условиях", () => {
    const m = measured({ stats: stats(3, 9), ref: stats(1, JITTER_MAX + 1), strict: true });
    expect(m.verdict).toBe("over");
    expect(() => expectWithinBudget(m)).toThrow(/строгий режим/);
  });

  test("дрожание ровно на пороге — условия ещё годны", () => {
    const m = measured({ stats: stats(3, 9), ref: stats(1, JITTER_MAX) });
    expect(m.quiet).toBe(true);
    expect(() => expectWithinBudget(m)).toThrow();
  });
});

describe("относительные утверждения — пункт 2 методики", () => {
  test("здоровый опережает соперника — молчит", () => {
    const m = measured({ stats: stats(1), rival: stats(4) });
    expect(() => expectAheadOfRival(m, 2)).not.toThrow();
  });

  /**
   * Вырождение: здоровый путь стал стоить как заведомо деградировавший.
   * Именно это происходит, когда теряется индекс охвата, — и это обязано
   * ронять прогон НЕЗАВИСИМО от загрузки машины.
   */
  test("здоровый выродился в соперника — падает даже при чудовищном дрожании", () => {
    const m = measured({
      stats: stats(4),
      rival: stats(4.1),
      ref: stats(1, 40),
      budgetMs: 100,
    });
    expect(m.verdict).toBe("ok"); // абсолют цел: бюджет большой
    expect(() => expectAheadOfRival(m, 2)).toThrow(/относительная регрессия/);
  });

  test("без соперника относительное утверждение невозможно и говорит об этом", () => {
    expect(() => expectAheadOfRival(measured(), 2)).toThrow(/соперник не измерен/);
  });

  test("цена относительно эталонной соседней операции — потолок сверху", () => {
    const cheap = measured({ stats: stats(3), rival: stats(1) });
    expect(() => expectCostAtMost(cheap, 5)).not.toThrow();
    expect(() => expectCostAtMost(cheap, 2)).toThrow(/дороже в ×3\.00/);
  });
});

describe("measure — чередование и условия", () => {
  test("меряет обе половины и заполняет условия", () => {
    let a = 0;
    let b = 0;
    const m = measure(
      "проба",
      () => {
        a++;
      },
      {
        warmup: 2,
        iters: 20,
        budgetMs: 1000,
        rival: () => {
          b++;
        },
        rivalLabel: "соперник",
      },
    );
    // n — сумма по трём независимым прогонам (trials по умолчанию 3),
    // перцентили при этом — медиана по ним, а не по всем 60 замерам разом.
    expect(m.stats.n).toBe(60);
    expect(m.rival?.n).toBe(60);
    // прогрев + проба длительности + сами замеры, и всё это трижды
    expect(a).toBeGreaterThan(60);
    expect(b).toBeGreaterThanOrEqual(60);
    expect(m.machine.cpus).toBeGreaterThan(0);
    expect(m.jitter).toBeGreaterThan(0);
    expect(m.verdict).toBe("ok");
  });

  test("число прогонов задаётся явно и умножает число замеров", () => {
    const one = measure("проба", () => {}, { warmup: 1, iters: 10, trials: 1 });
    const five = measure("проба", () => {}, { warmup: 1, iters: 10, trials: 5 });
    expect(one.stats.n).toBe(10);
    expect(five.stats.n).toBe(50);
  });

  test("без бюджета вердикт — «нет бюджета», и утверждать нечего", () => {
    const m = measure("проба", () => {}, { warmup: 1, iters: 5 });
    expect(m.verdict).toBe("none");
    expect(() => expectWithinBudget(m)).not.toThrow();
  });
});

describe("строгий режим читается из окружения", () => {
  const saved = process.env.MYC_BENCH_STRICT;
  afterEach(() => {
    if (saved === undefined) delete process.env.MYC_BENCH_STRICT;
    else process.env.MYC_BENCH_STRICT = saved;
  });

  test("MYC_BENCH_STRICT=1 делает абсолют обязательным в свежем замере", () => {
    process.env.MYC_BENCH_STRICT = "1";
    const m = measure("проба", () => Bun.nanoseconds(), { warmup: 1, iters: 5, budgetMs: 0 });
    expect(m.strict).toBe(true);
    expect(m.verdict).toBe("over");
  });
});
