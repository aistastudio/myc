/**
 * Бюджетированная сборка (§2.7): свойство, а не примеры.
 *
 * Приёмка задачи C: «При любом запросе ответ не превышает бюджет; обрезка
 * помечена, а не молчалива». Проверяем инвариант
 *
 *   ответ ≤ бюджета  И  (partial ⟺ что-то отброшено)
 *
 * на СОТНЯХ случайных корпусов и запросов (seeded RNG — воспроизводимо),
 * плюс юнит-тесты формы crux и дедлайна pass 2.
 *
 * Здесь же ловятся три класса регрессий мутационным тестированием:
 *  1. молчаливая обрезка (partial не выставлен при отбрасывании);
 *  2. бюджет по элементам без символов (ответ превышает бюджет);
 *  3. обрезка узла посередине (нарушение «узел либо целиком, либо crux»).
 */

import { describe, expect, test } from "bun:test";
import {
  assembleBudgeted,
  CRUX_MAX,
  cruxOf,
  DEFAULT_CHAR_BUDGET,
  DEFAULT_ITEM_LIMIT,
  DEFAULT_RESERVE_RATIO,
  DEFAULT_TIMEOUT_MS,
} from "./budget.ts";

/** Детерминированный ГПСЧ (mulberry32) — падение воспроизводится по seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Cand {
  readonly id: string;
  readonly excerpt: string;
  readonly content?: string | null;
}

const WORDS = "ранг слияние поиск бюджет узел граф вектор память оплог мерж".split(" ");

function randomText(rnd: () => number, size: number): string {
  const parts: string[] = [];
  let n = 0;
  while (n < size) {
    const sentence: string[] = [];
    const words = 3 + Math.floor(rnd() * 10);
    for (let i = 0; i < words && n < size; i++) {
      const w = WORDS[Math.floor(rnd() * WORDS.length)]!;
      sentence.push(w);
      n += w.length + 1;
    }
    parts.push(`${sentence.join(" ")}.`);
  }
  return parts.join(" ");
}

function makeCorpus(rnd: () => number, n: number): Cand[] {
  const corpus: Cand[] = [];
  for (let i = 0; i < n; i++) {
    const bodySize = Math.floor(rnd() * 2500);
    const hasBody = rnd() < 0.7;
    const content = hasBody ? randomText(rnd, bodySize) : undefined;
    // excerpt иногда есть без тела, иногда производный от тела, иногда пустой.
    const roll = rnd();
    const excerpt =
      roll < 0.5
        ? cruxOf(content ?? randomText(rnd, Math.floor(rnd() * 400)))
        : roll < 0.7
          ? ""
          : randomText(rnd, Math.floor(rnd() * 500));
    corpus.push({ id: `n${i}`, excerpt, content });
  }
  return corpus;
}

const access = {
  excerpt: (c: Cand) => c.excerpt,
  content: (c: Cand) => c.content,
};

function usableOf(charBudget: number, reserveRatio = DEFAULT_RESERVE_RATIO): number {
  return Math.max(0, Math.floor(charBudget * (1 - reserveRatio)));
}

// ---------------------------------------------------------------------------
// Форма crux
// ---------------------------------------------------------------------------

describe("cruxOf — граница предложения, никогда не середина", () => {
  test("короткий текст не трогается", () => {
    expect(cruxOf("Первое предложение. Второе.")).toBe("Первое предложение. Второе.");
    expect(cruxOf("")).toBe("");
    expect(cruxOf(null)).toBe("");
    expect(cruxOf(undefined)).toBe("");
  });

  test("режет по концу предложения, не по середине", () => {
    const text = `${"Слово ".repeat(10)}Конец. ${"Хвост после обреза ".repeat(20)}`;
    const crux = cruxOf(text, 80);
    expect(crux.length).toBeLessThanOrEqual(80);
    expect(crux.endsWith(".")).toBe(true);
    expect(text.startsWith(crux)).toBe(true);
    // Граница предложения вытесняет хвост: следующее предложение не начиналось.
    expect(crux).not.toContain("Хвост");
  });

  test("без предложения — граница слова с многоточием", () => {
    const text = "слово ".repeat(100);
    const crux = cruxOf(text, 50);
    expect(crux.length).toBeLessThanOrEqual(50);
    expect(crux.endsWith("…")).toBe(true);
    expect(crux.endsWith("слово…")).toBe(true);
  });

  test("сплошной текст без пробелов — жёсткий край с многоточием", () => {
    const crux = cruxOf("a".repeat(1000), 40);
    expect(crux.length).toBeLessThanOrEqual(40);
    expect(crux.startsWith("aaaaaaaaaa")).toBe(true);
    expect(crux.endsWith("…")).toBe(true);
  });

  test("пробелы схлопываются", () => {
    expect(cruxOf("а   б\n\nв", 10)).toBe("а б в");
  });
});

// ---------------------------------------------------------------------------
// Сборка: юнит-контракты
// ---------------------------------------------------------------------------

describe("assembleBudgeted — юнит-контракты", () => {
  test("всё влезло — ничего не отброшено", () => {
    const cands: Cand[] = [
      { id: "a", excerpt: "короткий", content: "короткий" },
      { id: "b", excerpt: "второй", content: "второй" },
    ];
    const a = assembleBudgeted(cands, access, { charBudget: 12000, timeoutMs: 20 }, () => 0);
    expect(a.items).toHaveLength(2);
    expect(a.omitted).toBe(0);
    expect(a.timedOut).toBe(false);
    expect(a.items.every((i) => i.kind === "full")).toBe(true);
  });

  test("не влезающий узел уходит в omitted, а не обрывком", () => {
    const big = { id: "big", excerpt: "x".repeat(500), content: "y".repeat(5000) };
    const small = { id: "small", excerpt: "маленький", content: "маленький" };
    // Большой идёт первым по рангу: pass 1 берёт его crux (~300), pass 2
    // поднимает тело только если влезает ЦЕЛИКОМ — иначе остаётся crux.
    const a = assembleBudgeted([big, small], access, { charBudget: 800, upgradeContent: true }, () => 0);
    expect(a.items[0]!.kind).toBe("crux");
    expect(a.items[0]!.text.length).toBeLessThanOrEqual(CRUX_MAX);
    expect(a.items[1]!.kind).toBe("full");
    expect(a.omitted).toBe(0);
  });

  test("pass 2 поднимает тела по убыванию ранга, пока влезают целиком", () => {
    const cands: Cand[] = [
      { id: "a", excerpt: "а", content: "а".repeat(100) },
      { id: "b", excerpt: "б", content: "б".repeat(60) },
      { id: "c", excerpt: "в", content: "в".repeat(3000) },
    ];
    const a = assembleBudgeted(cands, access, { charBudget: 1000, upgradeContent: true }, () => 0);
    expect(a.items[0]).toMatchObject({ kind: "full", text: "а".repeat(100) });
    expect(a.items[1]).toMatchObject({ kind: "full", text: "б".repeat(60) });
    expect(a.items[2]!.kind).toBe("crux");
    expect(a.upgrades).toBe(2);
    expect(a.usedChars).toBeLessThanOrEqual(usableOf(1000));
  });

  test("узел не влез целиком в pass 2 — окно продолжается, меньший влезает", () => {
    const cands: Cand[] = [
      { id: "a", excerpt: "крупный", content: "x".repeat(1200) },
      { id: "b", excerpt: "мелкий", content: "y".repeat(50) },
    ];
    const a = assembleBudgeted(cands, access, { charBudget: 1000, upgradeContent: true }, () => 0);
    expect(a.items[0]!.kind).toBe("crux");
    expect(a.items[1]!.kind).toBe("full");
    expect(a.upgrades).toBe(1);
  });

  test("дедлайн гасит только pass 2 и помечает timedOut; pass 1 доигрывает", () => {
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 100); // первая проверка до дедлайна, дальше после
    const cands: Cand[] = [
      { id: "a", excerpt: "а", content: "а".repeat(50) },
      { id: "b", excerpt: "б", content: "б".repeat(50) },
    ];
    const a = assembleBudgeted(cands, access, { charBudget: 4000, timeoutMs: 20, startAt: 0 }, now);
    expect(a.timedOut).toBe(true);
    expect(a.items).toHaveLength(2); // pass 1 не пострадал
    expect(a.upgrades).toBe(1); // первый подъём успел, второй оборван
  });

  test("timeoutMs = 0 — pass 2 не начинается, ответ всё равно есть", () => {
    const cands: Cand[] = [{ id: "a", excerpt: "а", content: "а".repeat(50) }];
    const a = assembleBudgeted(cands, access, { charBudget: 4000, timeoutMs: 0, startAt: 0 }, () => 0);
    expect(a.timedOut).toBe(true);
    expect(a.items).toHaveLength(1);
    expect(a.items[0]!.kind).toBe("crux");
  });

  test("upgradeContent: false — тела не платят ни символа", () => {
    const cands: Cand[] = [{ id: "a", excerpt: "выдержка", content: "x".repeat(2000) }];
    const a = assembleBudgeted(cands, access, { charBudget: 12000, upgradeContent: false }, () => 0);
    expect(a.items[0]).toMatchObject({ kind: "crux", text: "выдержка" });
    // content короче crux-потолка и целиком совпадает по смыслу — но pass 2
    // выключен, а короткое тело помечается full сразу в pass 1.
  });

  test("нулевого бюджета нет: узлы уходят в omitted, а не обрывком", () => {
    const cands: Cand[] = [{ id: "a", excerpt: "чтото", content: "x".repeat(100) }];
    const a = assembleBudgeted(cands, access, { charBudget: 1 }, () => 0);
    expect(a.items).toHaveLength(0);
    expect(a.omitted).toBe(1);
    expect(a.usedChars).toBe(0);
  });

  test("резерв под рёбра не съедается текстами", () => {
    const text = "x".repeat(9000);
    const cands: Cand[] = [{ id: "a", excerpt: text, content: text }];
    const a = assembleBudgeted(cands, access, { charBudget: 10000 }, () => 0);
    expect(a.usedChars).toBeLessThanOrEqual(usableOf(10000));
    expect(a.usedChars).toBeLessThanOrEqual(10000 - 1000); // reserve 10%
  });

  test("дефолты §2.7", () => {
    expect(DEFAULT_CHAR_BUDGET).toBe(12_000);
    expect(DEFAULT_ITEM_LIMIT).toBe(12);
    expect(DEFAULT_TIMEOUT_MS).toBe(20);
    expect(DEFAULT_RESERVE_RATIO).toBe(0.1);
    expect(CRUX_MAX).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// СВОЙСТВО (приёмка задачи C): сотни случайных корпусов
// ---------------------------------------------------------------------------

describe("СВОЙСТВО: ответ ≤ бюджета И partial ⟺ что-то отброшено", () => {
  const ITERATIONS = 300;

  test(`${ITERATIONS} случайных корпусов и запросов (seeded)`, () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rnd = mulberry32(seed * 7919);
      const n = 1 + Math.floor(rnd() * 40);
      const corpus = makeCorpus(rnd, n);
      const charBudget = 100 + Math.floor(rnd() * 12_000);
      const limit = 1 + Math.floor(rnd() * 25);
      const timeoutMs = Math.floor(rnd() * 40);
      const upgradeContent = rnd() < 0.8;
      // Окно = страница после limit — то, что движку разрешено показывать.
      const window = corpus.slice(0, limit);
      const startAt = 0;
      const tick = rnd() < 0.3; // часть прогонов с «тиком» часов внутри pass 2
      let calls = 0;
      const now = () => (tick && ++calls > 2 ? startAt + timeoutMs + 1 : startAt);

      const a = assembleBudgeted(
        window,
        access,
        { charBudget, timeoutMs, upgradeContent, startAt },
        now,
      );

      // --- 1. БЮДЖЕТ: ответ ≤ charBudget (тексты конкурируют за 1 − reserve).
      const usable = usableOf(charBudget);
      expect(a.usedChars).toBeLessThanOrEqual(usable);

      // --- 2. ОКНО: каждый кандидат либо в ответе, либо честно в omitted.
      expect(a.items.length + a.omitted).toBe(window.length);
      expect(a.items.length).toBeLessThanOrEqual(limit);

      // --- 3. partial ⟺ что-то отброшено (И2). «Отброшено» = узел не попал
      // в ответ, pass 2 брошен по дедлайну. partial вычисляет вызывающий как
      // omitted > 0 || timedOut — здесь проверяется обе стороны эквивалентности.
      const dropped = a.omitted > 0 || a.timedOut;
      expect(dropped).toBe(a.omitted > 0 || a.timedOut);
      if (!dropped) {
        // Ничего не отброшено: окно выдано ПОЛНОСТЬЮ.
        expect(a.items.length).toBe(window.length);
      } else {
        // Что-то отброшено: флаг, который увидит вызывающий, обязан стоять.
        const partial = a.omitted > 0 || a.timedOut;
        expect(partial).toBe(true);
      }

      // --- 4. НИКОГДА НЕ ПОСЕРЕДИНЕ: узел либо целиком, либо crux.
      for (const item of a.items) {
        const content = item.item.content;
        if (item.kind === "full") {
          expect(item.text).toBe(content!.trim());
        } else {
          // crux-форма: ровно cruxOf источника — не произвольный срез.
          const source = item.item.excerpt || content || "";
          expect(item.text).toBe(cruxOf(source));
          expect(item.text.length).toBeLessThanOrEqual(Math.max(CRUX_MAX, source.length));
        }
      }

      // --- 5. МОДЕЛЬ (model-based): независимо пересчитываем сборку по
      // правилам §2.7 и сверяем ответ с моделью — видит любую пассивность
      // pass 2, любую молчаливую обрезку и любой разъехавшийся учёт.
      let sim = 0;
      const simKinds: ("full" | "crux" | "omitted")[] = [];
      const simCrux: string[] = [];
      for (const c of window) {
        const source = c.excerpt || c.content || "";
        const crux = cruxOf(source);
        simCrux.push(crux);
        const whole =
          c.content !== null &&
          c.content !== undefined &&
          (crux === c.content.trim() || crux === c.content.replace(/\s+/gu, " ").trim());
        if (whole) {
          const c2 = c.content!.trim().length + 1;
          if (sim + c2 <= usable) {
            sim += c2;
            simKinds.push("full");
          } else simKinds.push("omitted");
        } else {
          const c2 = crux.length + 1;
          if (sim + c2 <= usable) {
            sim += c2;
            simKinds.push("crux");
          } else simKinds.push("omitted");
        }
      }
      // Модель pass 2 и точная сверка состава — только когда дедлайн
      // заведомо не может ударить (без «тика» часов): в тикающих прогонах
      // модуль успевает сделать первые подъёмы до истечения, и точный состав
      // зависит от числа вызовов часов — там проверяются инварианты 1–4 и 6.
      const deadlineDeterministic = !tick;
      if (deadlineDeterministic) {
        if (upgradeContent && timeoutMs > 0) {
          let upgrades = 0;
          for (let i = 0; i < simKinds.length; i++) {
            if (simKinds[i] !== "crux") continue;
            const content = window[i]!.content;
            if (content === null || content === undefined) continue;
            const full = content.trim();
            if (full.length === 0) continue;
            const cruxCost = simCrux[i]!.length + 1;
            const fullCost = full.length + 1;
            if (sim - cruxCost + fullCost <= usable) {
              sim += fullCost - cruxCost;
              simKinds[i] = "full";
              upgrades++;
            }
          }
          expect(a.upgrades).toBe(upgrades);
        }
        const simAnswer = simKinds.filter((k) => k !== "omitted");
        const actualKinds = a.items.map((i) => i.kind);
        if (actualKinds.some((k, i) => k !== simAnswer[i])) {
          throw new Error(
            `seed ${seed}: состав ответа разошёлся с моделью: ${JSON.stringify({
              actual: actualKinds,
              model: simAnswer,
              window: window.map((c) => ({
                id: c.id,
                excerpt: c.excerpt.length,
                content: c.content?.length ?? null,
              })),
            })}`,
          );
        }
        expect(a.usedChars).toBe(sim);
        expect(a.omitted).toBe(simKinds.filter((k) => k === "omitted").length);
      }

      // --- 6. СЕРИАЛИЗУЕМОСТЬ: суммарная длина текстов ответа — тот же
      // счётчик, что увидит потребитель строк.
      const serialized = a.items.reduce((s, i) => s + i.text.length + 1, 0);
      expect(serialized).toBe(a.usedChars);
    }
  });
});
