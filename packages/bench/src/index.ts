/**
 * @myc/bench — МЕТОДИКА БЮДЖЕТНЫХ ЗАМЕРОВ. Тестовая оснастка: её подключают
 * бюджетные тесты (packages/*\/src/**.test.ts, через devDependency),
 * scripts/bench-latency.ts и ночной прогон scripts/bench-nightly.ts.
 *
 * Отдельный пакет, а не файл в scripts/, по той же причине, по которой у
 * одиннадцати пакетов из тринадцати стоит rootDir=src: пакет не тянет код
 * снаружи себя. Общий код замера импортируют из двух пакетов сразу — значит
 * это библиотека, и жить она обязана там, где живут библиотеки.
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
  // Пустой набор — не ноль и не NaN, а честный ноль замеров: вызывающий
  // увидит n=0 и не примет отсутствие данных за мгновенную операцию.
  if (sorted.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
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
 * измеренным. Число получено замером, а не на глаз: scripts/bench-jitter.ts
 * на этом стенде (14 ядер), два прогона в каждом состоянии —
 *
 *   длительность | покой (load 5.9) | 20 занятых процессов (load 9–15)
 *   -------------|------------------|---------------------------------
 *   0.05 мс      | ×1.66  ×1.63     | ×4.09  ×2.29
 *   0.3 мс       | ×1.19  ×1.19     | ×2.31  ×1.39
 *   1 мс         | ×1.20  ×1.17     | ×6.64  ×23.84
 *   5 мс         | ×1.17  ×1.13     | ×10.25 ×10.58
 *   20 мс        | ×1.23  ×1.26     | ×3.07  ×4.79
 *
 * Покой держится в 1.13–1.26 на всех длительностях от 0.3 мс и выше (0.05 мс
 * шумит сильнее из-за разрешения таймера, но там и бюджеты на два-три
 * порядка выше замера). Нагрузка на тех же длительностях даёт 2.3–23.8.
 * 2.5 лежит выше всякого наблюдённого покоя и ниже почти всякой наблюдённой
 * нагрузки. Промахи бывают в обе стороны и обе безопасны: «условия годны»
 * при лёгкой нагрузке просто возвращает старое поведение (абсолют
 * проверяется, страховкой служит относительное утверждение), «условия
 * негодны» на чистой машине стоит одного пропущенного абсолюта, который
 * добирается ночным прогоном.
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
  /**
   * Сколько НЕЗАВИСИМЫХ прогонов усреднять. По каждому считаются свои
   * перцентили, наружу идёт их медиана.
   *
   * Не украшение и не осторожность: p99 по шестидесяти замерам — это
   * шестидесятый элемент, то есть один сосед по процессору (ровно тот довод,
   * по которому cold_start в scripts/bench-latency.ts сравнивается по p50).
   * Проверено: в общем прогоне здоровая очередь `ready` дала p50 1.33 мс и
   * p99 3.12 мс при пороге 3 — при дрожании эталона ×1.10, то есть машина
   * была свободна и проверка условий тут не спасала. Медиана трёх прогонов
   * убирает ровно этот случай: одинокий выброс перестаёт решать за всех.
   */
  readonly trials?: number;
}

/**
 * Один замер по методике: прогрев, ITERS чередующихся троек
 * (полезная операция → соперник → эталон), перцентили по каждому.
 *
 * Чередование, а не три отдельных цикла, — принципиально: соседний процесс
 * приходит и уходит за десятки миллисекунд, и три последовательных цикла
 * застали бы РАЗНЫЕ условия. Чередующиеся замеры делят условия поровну.
 */
/** Медиана перцентилей по независимым прогонам — см. `trials`. */
export function medianOfTrials(runs: readonly Stats[]): Stats {
  const med = (pick: (s: Stats) => number): number =>
    percentile(runs.map(pick).sort((a, b) => a - b), 50);
  return {
    n: runs.reduce((a, r) => a + r.n, 0),
    p50: med((r) => r.p50),
    p95: med((r) => r.p95),
    p99: med((r) => r.p99),
    min: Math.min(...runs.map((r) => r.min)),
    max: Math.max(...runs.map((r) => r.max)),
  };
}

export function measure(label: string, op: () => void, opts: MeasureOptions): Measured {
  const { warmup, iters, budgetMs = null, rival = null, rivalLabel = null, trials = 3 } = opts;

  const runs: Stats[] = [];
  const rivalRuns: Stats[] = [];
  const refRuns: Stats[] = [];

  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < warmup; i++) {
      op();
      if (rival) rival();
    }

    // Длительность полезной операции — чтобы подогнать под неё эталон.
    // Берётся минимум коротких проб: он ближе всего к «цене без помех».
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
    runs.push(summarize(samples));
    refRuns.push(summarize(refs));
    if (rival) rivalRuns.push(summarize(rivals));
  }

  const stats = medianOfTrials(runs);
  const ref = medianOfTrials(refRuns);
  // Дрожание — ХУДШЕЕ по прогонам, а не медианное: если машина была занята
  // хоть в одном из них, условия замера негодны, и молчать об этом нельзя.
  const jitter = Math.max(...refRuns.map((r) => (r.p50 > 0 ? r.p99 / r.p50 : 1)));
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
  const rivalStats = rival ? medianOfTrials(rivalRuns) : null;

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
export interface MeasureAsyncOptions {
  readonly warmup: number;
  readonly iters: number;
  readonly budgetMs?: number;
  readonly rival?: () => Promise<number | void>;
  readonly rivalLabel?: string;
  /** см. `MeasureOptions.trials` */
  readonly trials?: number;
}

export async function measureAsync(
  label: string,
  op: () => Promise<number | void>,
  opts: MeasureAsyncOptions,
): Promise<Measured> {
  const { warmup, iters, budgetMs = null, rival = null, rivalLabel = null, trials = 3 } = opts;
  const timed = async (fn: () => Promise<number | void>): Promise<number> => {
    const t0 = performance.now();
    const v = await fn();
    return typeof v === "number" ? v : performance.now() - t0;
  };

  const runs: Stats[] = [];
  const rivalRuns: Stats[] = [];
  const refRuns: Stats[] = [];
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < warmup; i++) {
      await timed(op);
      if (rival) await timed(rival);
    }

    let probe = Infinity;
    for (let i = 0; i < Math.max(2, Math.min(5, warmup)); i++) {
      const dt = await timed(op);
      if (dt < probe) probe = dt;
    }
    const units = Math.max(64, Math.round((probe * 1e6) / unitCostNs()));
    spin(units);

    const samples: number[] = [];
    const refs: number[] = [];
    const rivals: number[] = [];
    for (let i = 0; i < iters; i++) {
      samples.push(await timed(op));
      if (rival) rivals.push(await timed(rival));
      const t2 = performance.now();
      spin(units);
      refs.push(performance.now() - t2);
    }
    runs.push(summarize(samples));
    refRuns.push(summarize(refs));
    if (rival) rivalRuns.push(summarize(rivals));
  }
  const stats = medianOfTrials(runs);
  const ref = medianOfTrials(refRuns);
  const jitter = Math.max(...refRuns.map((r) => (r.p50 > 0 ? r.p99 / r.p50 : 1)));
  const quiet = jitter <= JITTER_MAX;
  const strict = isStrict();
  const rivalStats = rival ? medianOfTrials(rivalRuns) : null;
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
    rival: rivalStats,
    slowdown: rivalStats && stats.p50 > 0 ? rivalStats.p50 / stats.p50 : null,
    rivalLabel,
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
    const k = m.slowdown ?? 0;
    // Направление отношения печатается словами: у мутанта смысл «здоровый
    // быстрее во столько-то раз», у эталонной соседней операции — «дороже».
    const rel = k >= 1 ? `быстрее ×${k.toFixed(2)}` : `ДОРОЖЕ ×${(1 / k).toFixed(2)}`;
    parts.push(
      `· против${m.rivalLabel ? ` «${m.rivalLabel}»` : " соперника"} p50=${ms(m.rival.p50)} p99=${ms(m.rival.p99)}` +
        ` → ${rel}`,
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
 * Второй вид относительного утверждения — для путей, у которых
 * деградировавшего близнеца не существует (нет индекса, который можно было бы
 * потерять). Тогда соперник — не мутант, а ЭТАЛОННАЯ СОСЕДНЯЯ ОПЕРАЦИЯ, цена
 * которой известна и которая заведомо дешевле: тот же дайджест без фильтра,
 * тот же поиск без федерации. Утверждается потолок отношения: «дополнение
 * стоит не больше чем в `maxRatio` раз дороже базовой операции». Отношение
 * измерено чередуясь и потому не зависит от загрузки машины, в отличие от
 * абсолютного бюджета, который это же и пытается сказать.
 */
export function expectCostAtMost(m: Measured, maxRatio: number): void {
  if (m.rival === null || m.rival.p50 <= 0) {
    throw new Error(`${m.label}: эталонная операция не измерена, отношение невозможно`);
  }
  const ratio = m.stats.p50 / m.rival.p50;
  if (ratio <= maxRatio) return;
  throw new Error(
    `относительная регрессия: ${m.label} p50=${ms(m.stats.p50)} против эталона` +
      `${m.rivalLabel ? ` «${m.rivalLabel}»` : ""} p50=${ms(m.rival.p50)} — ` +
      `дороже в ×${ratio.toFixed(2)} при допустимых ×${maxRatio}. ` +
      `Отношение не зависит от загрузки машины (дрожание эталона ×${m.jitter.toFixed(2)})`,
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
