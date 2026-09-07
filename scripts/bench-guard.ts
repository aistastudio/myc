/**
 * МЕТОДИКА БЮДЖЕТНЫХ ЗАМЕРОВ. Общая оснастка для бюджетных тестов
 * (packages/*\/src/**.test.ts) и для scripts/bench-latency.ts.
 *
 * Задача, из которой это выросло (memory-ws31ztqgh43c): за один день три
 * разных бюджетных теста упали в общем прогоне и оказались зелёными
 * изолированно — ready.repo-latency (p99 1.6 мс при бюджете 5), prime digest
 * (4.7 при 8), отчёт myc-dze.3 (7.1 с при лимите 5 с). Все три сообщили о
 * ЗАГРУЗКЕ МАШИНЫ, а не о коде. Ложная тревога дороже отсутствия теста: к
 * ней привыкают, а привыкнув — пропускают настоящую регрессию.
 *
 * ЧТО МЕРИМ. Одну операцию горячего пути за раз, тем же текстом запроса и
 * тем же кодом, что исполняет команда (не копией — копия расходится).
 *
 * ЧЕМ. `performance.now()` вокруг одного вызова; прогрев отбрасывается;
 * ITERS замеров; перцентили p50/p95/p99.
 *
 * ПРИ КАКИХ УСЛОВИЯХ. Стенное время без записанных условий — не замер, а
 * анекдот. Поэтому рядом с полезной операцией, ЧЕРЕДУЯСЬ с ней в одном
 * цикле, меряется ЭТАЛОН: чисто процессорный цикл, подогнанный под ту же
 * длительность, что и полезная операция. Эталон не ходит в базу, не
 * аллоцирует и не зависит от кода проекта — всё, что с ним происходит,
 * происходит от машины. Отношение `ref.p99 / ref.p50` (здесь — «дрожание»)
 * и есть измеренный ответ на вопрос «во сколько раз машина прямо сейчас
 * растягивает работу такой длительности».
 *
 * ЧТО СЧИТАЕТСЯ РЕГРЕССИЕЙ — три утверждения на замер, по убыванию силы:
 *
 *   1. СТРУКТУРНОЕ (план запроса использует индекс, фильтр реально отсеивает).
 *      Детерминированное, от машины не зависит вовсе. Всегда обязательное.
 *      Живёт в самих тестах, здесь для него ничего не нужно.
 *
 *   2. ОТНОСИТЕЛЬНОЕ: здоровый вариант против СОПЕРНИКА — заведомо
 *      деградировавшей версии той же операции (снятый индекс охвата, ранний
 *      выход, отсутствующий потолок источников), измеренного ЧЕРЕДУЯСЬ, в
 *      том же процессе, на тех же данных. Загрузка машины растягивает обоих
 *      одинаково, отношение её переживает. ВСЕГДА ОБЯЗАТЕЛЬНОЕ — именно оно
 *      ловит настоящую регрессию в общем прогоне.
 *
 *   3. АБСОЛЮТНОЕ (бюджет И1 в миллисекундах). Единственное, что зависит от
 *      загрузки, — и потому единственное, что здесь ослаблено: оно роняет
 *      сборку, только если дрожание эталона уложилось в JITTER_MAX, то есть
 *      если условия замера годны. Иначе печатается `НЕДОСТОВЕРНО` вместе с
 *      причиной (И2: не молчать и не врать). В ночном прогоне
 *      (MYC_BENCH_STRICT=1) абсолют обязателен безусловно — там машина
 *      незагружена по построению, и ослабление было бы дырой.
 *
 * Пропущенный из-за нагрузки абсолют — не потерянная проверка: регрессия,
 * ради которой бюджет и заводился, ловится пунктом 2 в том же прогоне, а
 * пункт 3 добирается ночью на чистой машине.
 *
 * КУДА ИДЁТ РЕЗУЛЬТАТ. Каждый замер печатает одну строку с числами И
 * условиями и, если задан MYC_BENCH_LOG, дописывает JSON-строку в этот файл
 * (.github/workflows/nightly-bench.yml собирает его в артефакт).
 */

import { appendFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";

// --------------------------------------------------------------------------
// Статистика
// --------------------------------------------------------------------------

export interface Stats {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function summarize(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// --------------------------------------------------------------------------
// Эталон: чисто процессорная работа известной длительности
// --------------------------------------------------------------------------

/** Копилка результата: без неё JIT имеет право выбросить цикл целиком. */
let sink = 0;

/** Линейный конгруэнтный шаг, `units` раз. Ни базы, ни аллокаций, ни ввода-вывода. */
function spin(units: number): void {
  let x = sink | 1;
  for (let i = 0; i < units; i++) x = (x * 1103515245 + 12345) % 2147483648;
  sink = x;
}

let unitNs = 0;

/**
 * Наносекунд на один шаг эталона на ЭТОЙ машине. Берётся минимум из
 * нескольких прогонов: минимум — единственная оценка, не испорченная
 * соседями по процессору.
 */
export function unitCostNs(): number {
  if (unitNs > 0) return unitNs;
  spin(200_000); // прогрев JIT
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    spin(200_000);
    const ns = ((performance.now() - t0) * 1e6) / 200_000;
    if (ns < best) best = ns;
  }
  unitNs = best > 0 ? best : 1;
  return unitNs;
}

// --------------------------------------------------------------------------
// Условия замера
// --------------------------------------------------------------------------

export interface Machine {
  readonly cpus: number;
  readonly load1: number;
  readonly load5: number;
}

export function machine(): Machine {
  const [l1 = 0, l5 = 0] = loadavg();
  return { cpus: cpus().length, load1: Number(l1.toFixed(2)), load5: Number(l5.toFixed(2)) };
}

/**
 * Потолок дрожания эталона, выше которого абсолютный бюджет не считается
 * измеренным. Число получено замером, а не на глаз (scripts/bench-jitter.ts,
 * тот же стенд, 10 ядер):
 *
 *   машина в покое (load1 1.5–2.5)          дрожание 1.02–1.31
 *   общий прогон `bun test` рядом (load1 8) дрожание 1.6–14.9
 *   16 занятых ядер (`yes` × 16, load1 20+) дрожание 3.1–40
 *
 * 2.5 лежит выше любого наблюдённого покоя и ниже почти всякой наблюдённой
 * нагрузки. Ошибка в сторону «условия годны» безопасна: абсолют тогда просто
 * проверяется как раньше, а страховкой служит относительное утверждение.
 */
export const JITTER_MAX = 2.5;

export function isStrict(): boolean {
  return process.env.MYC_BENCH_STRICT === "1";
}

// --------------------------------------------------------------------------
// Замер
// --------------------------------------------------------------------------

export type Verdict = "ok" | "over" | "unreliable" | "none";

export interface Measured {
  readonly label: string;
  readonly stats: Stats;
  /** эталон той же длительности, измеренный чередуясь с полезной операцией */
  readonly ref: Stats;
  /** ref.p99 / ref.p50 — во сколько раз машина растянула заведомо ровную работу */
  readonly jitter: number;
  /** годны ли условия для абсолютного утверждения */
  readonly quiet: boolean;
  readonly budgetMs: number | null;
  readonly verdict: Verdict;
  readonly machine: Machine;
  readonly strict: boolean;
  /** соперник — заведомо деградировавший вариант той же операции */
  readonly rival: Stats | null;
  /** во сколько раз соперник медленнее здорового по p50 */
  readonly slowdown: number | null;
  readonly rivalLabel: string | null;
}

export interface MeasureOptions {
  readonly warmup: number;
  readonly iters: number;
  /** абсолютный бюджет в мс; без него абсолютного утверждения нет вовсе */
  readonly budgetMs?: number;
  /** заведомо деградировавший вариант той же операции — см. пункт 2 методики */
  readonly rival?: () => void;
  readonly rivalLabel?: string;
}

/**
 * Один замер по методике: прогрев, ITERS чередующихся троек
 * (полезная операция → соперник → эталон), перцентили по каждому.
 *
 * Чередование, а не три отдельных цикла, — принципиально: соседний процесс
 * приходит и уходит за десятки миллисекунд, и три последовательных цикла
 * застали бы РАЗНЫЕ условия. Чередующиеся замеры делят условия поровну.
 */
export function measure(label: string, op: () => void, opts: MeasureOptions): Measured {
  const { warmup, iters, budgetMs = null, rival = null, rivalLabel = null } = opts;

  for (let i = 0; i < warmup; i++) {
    op();
    if (rival) rival();
  }

  // Длительность полезной операции — чтобы подогнать под неё эталон. Берётся
  // минимум коротких проб: он ближе всего к «цене без помех».
  let probe = Infinity;
  for (let i = 0; i < Math.max(3, Math.min(10, warmup)); i++) {
    const t0 = performance.now();
    op();
    const dt = performance.now() - t0;
    if (dt < probe) probe = dt;
  }
  const units = Math.max(64, Math.round((probe * 1e6) / unitCostNs()));
  spin(units); // прогрев эталона на подобранном размере

  const samples: number[] = [];
  const refs: number[] = [];
  const rivals: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    op();
    samples.push(performance.now() - t0);
    if (rival) {
      const t1 = performance.now();
      rival();
      rivals.push(performance.now() - t1);
    }
    const t2 = performance.now();
    spin(units);
    refs.push(performance.now() - t2);
  }

  const stats = summarize(samples);
  const ref = summarize(refs);
  const jitter = ref.p50 > 0 ? ref.p99 / ref.p50 : 1;
  const quiet = jitter <= JITTER_MAX;
  const strict = isStrict();
  const verdict: Verdict =
    budgetMs === null
      ? "none"
      : stats.p99 <= budgetMs
        ? "ok"
        : quiet || strict
          ? "over"
          : "unreliable";
  const rivalStats = rival ? summarize(rivals) : null;

  return {
    label,
    stats,
    ref,
    jitter,
    quiet,
    budgetMs,
    verdict,
    machine: machine(),
    strict,
    rival: rivalStats,
    slowdown: rivalStats && stats.p50 > 0 ? rivalStats.p50 / stats.p50 : null,
    rivalLabel,
  };
}

/**
 * Замер операции, которая не исполняется на месте, а ждёт (подпроцесс,
 * сетевой вызов): эталон крутится в этом же процессе МЕЖДУ вызовами, то есть
 * в тот же промежуток времени, но не отбирает процессор у измеряемого.
 * Асинхронный близнец `measure`.
 */
export async function measureAsync(
  label: string,
  op: () => Promise<number | void>,
  opts: MeasureOptions,
): Promise<Measured> {
  const { warmup, iters, budgetMs = null } = opts;
  const run = async (): Promise<number> => {
    const t0 = performance.now();
    const v = await op();
    return typeof v === "number" ? v : performance.now() - t0;
  };
  for (let i = 0; i < warmup; i++) await run();

  let probe = Infinity;
  for (let i = 0; i < Math.max(2, Math.min(5, warmup)); i++) {
    const dt = await run();
    if (dt < probe) probe = dt;
  }
  const units = Math.max(64, Math.round((probe * 1e6) / unitCostNs()));
  spin(units);

  const samples: number[] = [];
  const refs: number[] = [];
  for (let i = 0; i < iters; i++) {
    samples.push(await run());
    const t2 = performance.now();
    spin(units);
    refs.push(performance.now() - t2);
  }
  const stats = summarize(samples);
  const ref = summarize(refs);
  const jitter = ref.p50 > 0 ? ref.p99 / ref.p50 : 1;
  const quiet = jitter <= JITTER_MAX;
  const strict = isStrict();
  return {
    label,
    stats,
    ref,
    jitter,
    quiet,
    budgetMs,
    verdict:
      budgetMs === null
        ? "none"
        : stats.p99 <= budgetMs
          ? "ok"
          : quiet || strict
            ? "over"
            : "unreliable",
    machine: machine(),
    strict,
    rival: null,
    slowdown: null,
    rivalLabel: null,
  };
}

// --------------------------------------------------------------------------
// Отчёт
// --------------------------------------------------------------------------

function ms(n: number): string {
  return n >= 1 ? `${n.toFixed(3)}ms` : `${(n * 1000).toFixed(1)}мкс`;
}

/**
 * Одна строка на замер: числа И условия, при которых они получены. Условия в
 * той же строке, а не в шапке прогона, потому что читать их будут задним
 * числом из чужого лога, где шапки уже нет.
 */
export function report(m: Measured, extra?: string): void {
  const parts = [
    `[bench] ${m.label}:`,
    `p50=${ms(m.stats.p50)} p95=${ms(m.stats.p95)} p99=${ms(m.stats.p99)} n=${m.stats.n}`,
  ];
  if (m.budgetMs !== null) parts.push(`· бюджет p99<${m.budgetMs}мс → ${verdictWord(m)}`);
  if (m.rival !== null) {
    parts.push(
      `· соперник${m.rivalLabel ? ` «${m.rivalLabel}»` : ""} p50=${ms(m.rival.p50)} p99=${ms(m.rival.p99)}` +
        ` → медленнее ×${(m.slowdown ?? 0).toFixed(2)}`,
    );
  }
  parts.push(
    `· условия: ${m.machine.cpus} ядер, load1 ${m.machine.load1}, дрожание эталона ×${m.jitter.toFixed(2)}` +
      ` (порог ${JITTER_MAX})${m.strict ? ", строгий режим" : ""}`,
  );
  if (extra) parts.push(`· ${extra}`);
  console.log(parts.join(" "));

  const logPath = process.env.MYC_BENCH_LOG;
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        label: m.label,
        p50: m.stats.p50,
        p95: m.stats.p95,
        p99: m.stats.p99,
        n: m.stats.n,
        budget_ms: m.budgetMs,
        verdict: m.verdict,
        jitter: Number(m.jitter.toFixed(3)),
        ref_p50: m.ref.p50,
        rival_p50: m.rival?.p50 ?? null,
        slowdown: m.slowdown === null ? null : Number(m.slowdown.toFixed(3)),
        cpus: m.machine.cpus,
        load1: m.machine.load1,
        load5: m.machine.load5,
        strict: m.strict,
      })}\n`,
    );
  }
}

function verdictWord(m: Measured): string {
  switch (m.verdict) {
    case "ok":
      return "в бюджете";
    case "over":
      return "НАРУШЕН";
    case "unreliable":
      return "НЕДОСТОВЕРНО (машина занята, абсолют не проверяется)";
    default:
      return "нет бюджета";
  }
}

// --------------------------------------------------------------------------
// Утверждения
// --------------------------------------------------------------------------

/**
 * Абсолютный бюджет — пункт 3 методики. Роняет прогон только при годных
 * условиях (или в строгом режиме); при занятой машине печатает причину и
 * пропускает, потому что измерил не код, а соседа по процессору.
 */
export function expectWithinBudget(m: Measured): void {
  if (m.verdict !== "over") return;
  throw new Error(
    `бюджет нарушен: ${m.label} p99=${ms(m.stats.p99)} > ${m.budgetMs}мс ` +
      `(p50=${ms(m.stats.p50)}, n=${m.stats.n}); условия годны: дрожание эталона ` +
      `×${m.jitter.toFixed(2)} <= ${JITTER_MAX}, load1 ${m.machine.load1} на ${m.machine.cpus} ядрах` +
      `${m.strict ? " (строгий режим)" : ""} — это регрессия, а не загрузка машины`,
  );
}

/**
 * Относительное утверждение — пункт 2 методики и главная проверка. Здоровый
 * вариант обязан опережать соперника хотя бы в `minRatio` раз. Оба измерены
 * чередуясь, в одном процессе, на одних данных: загрузка машины растягивает
 * обоих и из отношения уходит.
 */
export function expectAheadOfRival(m: Measured, minRatio: number): void {
  if (m.rival === null || m.slowdown === null) {
    throw new Error(`${m.label}: соперник не измерен, относительное утверждение невозможно`);
  }
  if (m.slowdown >= minRatio) return;
  throw new Error(
    `относительная регрессия: ${m.label} p50=${ms(m.stats.p50)} против соперника` +
      `${m.rivalLabel ? ` «${m.rivalLabel}»` : ""} p50=${ms(m.rival.p50)} — ` +
      `быстрее лишь ×${m.slowdown.toFixed(2)} при требуемых ×${minRatio}. ` +
      `Отношение не зависит от загрузки машины (дрожание эталона ×${m.jitter.toFixed(2)}): ` +
      `здоровый путь потерял преимущество над заведомо деградировавшим`,
  );
}
