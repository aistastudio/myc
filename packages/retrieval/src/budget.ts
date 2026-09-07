/**
 * Бюджетированный ретривал (docs/design/02-retrieval-and-performance.md §2.7).
 *
 * Урок TencentDB: «влить всё» убивает и латентность, и контекст окна агента.
 * Ответ ретривала ограничен ТРЕМЯ бюджетами — числом элементов, символами
 * контента и временем, — и обрезка обязана быть ВИДНА в ответе (И2):
 *
 *   limit        = 12     (max 100)     — узлов в ответе
 *   char_budget  = 12000  (max 64000)   — суммарный объём контента ответа
 *   timeout_ms   = 20                   — на стадии после эмбеддинга запроса
 *
 * Сборка двухпроходная и НЕ ЛОМАЕТ СМЫСЛ:
 *
 *   reserve = 0.10 × char_budget — под секцию рёбер/источников;
 *   pass 1: каждый кандидат окна включает crux (≤ 300 символов, граница —
 *           конец предложения); pass 1 дедлайном НЕ гасится никогда —
 *           ответ обязан состояться даже при исчерпанном времени;
 *   pass 2: пока бюджет не исчерпан, поднимаем top узлы crux → content
 *           ЦЕЛИКОМ. Узел либо входит целиком, либо остаётся crux —
 *           середины нет.
 *
 * Модуль НАМЕРЕННО чистый: ни БД, ни часов, ни эмбеддера. Часы
 * инжектируются, поэтому свойство «ответ ≤ бюджета И partial ⟺ что-то
 * отброшено» проверяется на сотнях случайных корпусов (budget.test.ts),
 * а не на трёх подобранных примерах.
 */

export const DEFAULT_CHAR_BUDGET = 12_000;
export const DEFAULT_ITEM_LIMIT = 12;
/** Дедлайн стадий ПОСЛЕ эмбеддинга запроса; первая жертва — граф-расширение (до этой сборки), вторая — pass 2. */
export const DEFAULT_TIMEOUT_MS = 20;
/** Доля char_budget, резервируемая под секцию рёбер/источников (§2.7). */
export const DEFAULT_RESERVE_RATIO = 0.10;
export const CRUX_MAX = 300;
/** Потолок char_budget из §2.7. */
export const MAX_CHAR_BUDGET = 64_000;

/** Стоимость строки в счётчике бюджета: текст + перевод строки. */
function cost(text: string): number {
  return text.length + 1;
}

/**
 * Crux: ≤ max символов, граница — конец предложения (§2.7 pass 1).
 * Предложение не нашлось — откат к границе слова, затем жёсткий край;
 * в обоих случаях ставится «…», чтобы обрезка была видна в самом тексте.
 * Режет по кодовым пунктам (как makeExcerpt в @myc/core), не разрывая
 * суррогатные пары.
 */
export function cruxOf(text: string | null | undefined, max: number = CRUX_MAX): string {
  if (text === null || text === undefined) return "";
  if (max < 1) return "";
  const normalized = text.replace(/\s+/gu, " ").trim();
  const points = [...normalized];
  if (points.length <= max) return normalized;

  const head = points.slice(0, max + 1).join("");
  // Предложение кончается терминатором, за которым пробел или край текста.
  const minCut = Math.floor(max * 0.6);
  let cut = -1;
  for (let i = head.length - 1; i >= minCut; i--) {
    const ch = head[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= head.length || head[i + 1] === " ")) {
      cut = i + 1;
      break;
    }
  }
  if (cut < 0) {
    const lastSpace = head.lastIndexOf(" ");
    cut = lastSpace >= minCut ? lastSpace : max - 1;
  }
  // Не разрываем суррогатную пару на краю.
  if (cut > 0) {
    const prev = head.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  }
  const out = head.slice(0, cut).trimEnd();
  return /[.!?…]$/.test(out) ? out : `${out}…`;
}

/** Текст — это КОНЕЦ контента (ничего не отрезано), сравнение по пробелам. */
function isWholeContent(text: string, content: string): boolean {
  return text === content.trim() || text === content.replace(/\s+/gu, " ").trim();
}

export interface BudgetAccess<I> {
  /** Доступ к полям кандидата — модуль не знает форму строк вызывающего. */
  readonly excerpt: (item: I) => string;
  /** Полный контент; undefined/null — тела нет (доступен только crux). */
  readonly content: (item: I) => string | null | undefined;
}

export interface BudgetParams {
  /** Символьный потолок контента ответа (§2.7 char_budget). */
  readonly charBudget: number;
  /** Дедлайн стадий после эмбеддинга, мс; 0 — pass 2 не начинается. */
  readonly timeoutMs?: number;
  /** Доля бюджета под рёбра/источники; по умолчанию 0.10 (§2.7). */
  readonly reserveRatio?: number;
  /** Потолок crux; по умолчанию 300. */
  readonly cruxMax?: number;
  /**
   * Поднимать ли crux → content (pass 2). Выключено у поверхностей, которые
   * тела всё равно не показывают (табличный search): тогда pass 2 не платит
   * ни символа сверх crux.
   */
  readonly upgradeContent?: boolean;
  /** performance.now() на старте пост-эмбеддинг стадий (гидратация до сборки тоже в дедлайне). */
  readonly startAt?: number;
}

export interface BudgetedItem<I> {
  readonly item: I;
  /** "full" — text есть ЦЕЛЫЙ контент; "crux" — текст усечён (И2: видно в самой строке). */
  readonly kind: "full" | "crux";
  readonly text: string;
}

export interface BudgetedAnswer<I> {
  readonly items: readonly BudgetedItem<I>[];
  /** Кандидаты окна, не влезшие в бюджет. Не молча: число уходит в ответ. */
  readonly omitted: number;
  /** Pass 2 оборван дедлайном — бюджет символов остался, времени не осталось. */
  readonly timedOut: boolean;
  /** Символов контента фактически вошло в ответ (считается ДО reserve-границы). */
  readonly usedChars: number;
  /** Сколько узлов поднято crux → content. */
  readonly upgrades: number;
}

export function assembleBudgeted<I>(
  window: readonly I[],
  access: BudgetAccess<I>,
  params: BudgetParams,
  now: () => number = performance.now,
): BudgetedAnswer<I> {
  const charBudget =
    Number.isFinite(params.charBudget) && params.charBudget > 0
      ? Math.floor(params.charBudget)
      : 0;
  const reserve = Math.min(Math.max(params.reserveRatio ?? DEFAULT_RESERVE_RATIO, 0), 0.9);
  // Reserve остаётся под рёбра/источники, которых сам ответ не печатает:
  // тексты конкурируют только за (1 − reserve) часть.
  const usable = Math.max(0, Math.floor(charBudget * (1 - reserve)));
  const cruxMax = params.cruxMax ?? CRUX_MAX;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startAt = params.startAt ?? now();
  const deadlineAt = startAt + Math.max(0, timeoutMs);

  // ---- pass 1: crux каждому, по убыванию ранга. Дедлайном не гасится:
  // ---- пустота вместо ответа запрещена (И2), pass 1 — чистый in-memory.
  const items: BudgetedItem<I>[] = [];
  let used = 0;
  let omitted = 0;
  for (const item of window) {
    const content = access.content(item);
    const source = access.excerpt(item) || content || "";
    const crux = cruxOf(source, cruxMax);
    // Тело есть, но целиком помещается в crux-потолок — это уже «целиком»,
    // середины нет и не будет: помечаем full сразу, pass 2 его не трогает.
    if (content !== null && content !== undefined && isWholeContent(crux, content)) {
      const c = cost(content.trim());
      if (used + c <= usable) {
        items.push({ item, kind: "full", text: content.trim() });
        used += c;
        continue;
      }
      omitted++;
      continue;
    }
    const c = cost(crux);
    if (used + c <= usable) {
      items.push({ item, kind: "crux", text: crux });
      used += c;
    } else {
      omitted++;
    }
  }

  // ---- pass 2: поднимаем top узлы crux → content ЦЕЛИКОМ, сверху вниз по
  // ---- рангу. Узел не влез целиком — остаётся crux (середины нет), окно
  // ---- продолжаем: у следующего тело может быть короче. Первая же проверка
  // ---- дедлайна после исчерпания времени останавливает pass 2 с timedOut.
  let timedOut = false;
  let upgrades = 0;
  if (params.upgradeContent ?? true) {
    for (let i = 0; i < items.length; i++) {
      const entry = items[i]!;
      if (now() >= deadlineAt) {
        timedOut = true;
        break;
      }
      if (entry.kind === "full") continue;
      const content = access.content(entry.item);
      if (content === null || content === undefined) continue;
      const fullText = content.trim();
      if (fullText.length === 0) continue;
      const cruxCost = cost(entry.text);
      const fullCost = cost(fullText);
      if (used - cruxCost + fullCost <= usable) {
        items[i] = { item: entry.item, kind: "full", text: fullText };
        used += fullCost - cruxCost;
        upgrades++;
      }
    }
  }

  return { items, omitted, timedOut, usedChars: used, upgrades };
}
