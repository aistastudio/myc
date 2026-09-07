import type { Database } from "bun:sqlite";
import {
  OUTCOME_VERSION,
  qualityOf,
  type Caveat,
  type CostBasis,
  type Verdict,
} from "./attribution.ts";
import { isTaskClass } from "./taskclass.ts";

/**
 * Вопрос приёмки W11 целиком: «какая модель НА КАКОМ КЛАССЕ ЗАДАЧ дешевле
 * ПРИ РАВНОМ РЕЗУЛЬТАТЕ». Три слова в нём одинаково важны, и каждое здесь
 * реализовано отдельно:
 *
 * - «на каком классе» — группировка по task_class (intent:scope), а не по
 *   всем задачам скопом: модель, дешёвая на доках, может быть разорительна
 *   на кросс-модульных правках.
 * - «при равном результате» — НЕ равенство средних. Среднее из трёх
 *   наблюдений — не факт, а слух. Качество руки — апостериор Beta(1+Σq,
 *   1+Σ(1−q)); «равный результат» = пересечение центральных интервалов
 *   доверия с лидером. Пока интервалы широки, дешёвая модель не
 *   объявляется победителем — отчёт говорит «мало наблюдений».
 * - «дешевле» — по ЗАМОРОЖЕННОЙ стоимости попыток (attribution.ts), и
 *   только по попыткам, где стоимость вообще посчиталась. Доля таких
 *   попыток печатается (costCoverage): «дешевле» по одной попытке из
 *   двадцати — это не ответ, и отчёт обязан это признать, а не усреднить.
 *   Отдельно считается coverage.costCacheUnpriced — попытки, замороженные
 *   по строке цены с нулевыми ставками кеша при ненулевых кеш-токенах.
 *   Их стоимость занижена, и занижена неравномерно (сильнее у той руки,
 *   что больше читала и меньше писала), поэтому число называется вслух.
 *
 * Ответ, который не опирается на данные, называется вслух: поле `answer`
 * различает ok / insufficient_attempts / no_cost_data / single_arm, а
 * `why` объясняет человеку, чего не хватило.
 */

/** Меньше этого числа наблюдений — рука в сравнении не участвует. */
export const DEFAULT_MIN_ATTEMPTS = 3;

/** Ширина интервала доверия по качеству. */
export const CREDIBLE_MASS = 0.9;

export interface CompareOptions {
  readonly taskClass?: string;
  readonly since?: number;
  readonly minAttempts?: number;
  readonly now?: number;
}

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

export interface ArmStat {
  /** Ключ руки: "<model_id>|<effort>". */
  readonly arm: string;
  readonly modelId: string;
  readonly effort: string;
  readonly harness: string;
  readonly attempts: number;
  readonly qualityMean: number;
  readonly quality: Interval;
  /** Средняя стоимость попытки; null — считать было не по чему. */
  readonly costUsdMean: number | null;
  readonly costUsdTotal: number;
  /** Сколько попыток руки имеют посчитанную стоимость. */
  readonly costedAttempts: number;
  readonly costCoverage: number;
  /** Доля принятых без единой оговорки. */
  readonly cleanRate: number;
  readonly caveatCounts: Readonly<Record<string, number>>;
  readonly verdictCounts: Readonly<Record<string, number>>;
  readonly enoughData: boolean;
}

export type AnswerCode = "ok" | "insufficient_attempts" | "no_cost_data" | "single_arm";

export interface ClassAnswer {
  readonly taskClass: string;
  readonly arms: readonly ArmStat[];
  /** Рука с лучшим средним качеством. */
  readonly qualityLeader: string | null;
  /** Руки, чей результат неотличим от лучшей: интервалы качества пересекаются. */
  readonly equalGroup: readonly string[];
  /** Самая дешёвая рука из группы равного результата; null — ответа нет. */
  readonly cheapest: string | null;
  /**
   * true, когда дешёвая рука попала в группу равных не потому, что она так
   * же хороша, а потому, что наблюдений пока не хватает, чтобы её отличить.
   * Разница средних есть, разделения — нет. Молчать об этом нельзя: иначе
   * отчёт выглядит как «дешевле при равном результате», а на деле говорит
   * «дешевле, и мы ещё не знаем, хуже ли».
   */
  readonly separationPending: boolean;
  readonly answer: AnswerCode;
  readonly why: string;
}

export interface CompareReport {
  readonly outcomeVersion: number;
  readonly minAttempts: number;
  readonly credibleMass: number;
  readonly classes: readonly ClassAnswer[];
  readonly coverage: {
    readonly attempts: number;
    readonly finished: number;
    readonly withCost: number;
    /** Из withCost: посчитаны по нулевой цене кеша при ненулевом кеше. */
    readonly costCacheUnpriced: number;
    /**
     * Из withCost: замороженное значение не сходится со счётом по ТОЙ ЖЕ
     * строке цены. Значит, строку исправили после заморозки (типично —
     * дописали ставки кеша), а стоимость осталась старой. Пересчёт —
     * scripts/recost-attempts.ts; молчать нельзя, иначе отчёт показывает
     * числа, которых цена уже не подтверждает.
     */
    readonly costStale: number;
    readonly arms: number;
    readonly classes: number;
  };
}

// ---------------------------------------------------------------------------
// Beta-апостериор: интервал доверия по качеству
// ---------------------------------------------------------------------------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lnGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  const x = z - 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i]! / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Непрерывная дробь Лентца для неполной бета-функции. */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Регуляризованная неполная бета I_x(a,b) — функция распределения Beta. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Квантиль Beta делением пополам: 60 итераций дают точность ~1e-18. */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Центральный интервал апостериора Beta(1+Σq, 1+Σ(1−q)). Равномерный приор
 * Beta(1,1) выбран сознательно: он не притворяется знанием, которого нет,
 * и на трёх наблюдениях честно даёт широкий интервал.
 */
export function qualityInterval(
  qualities: readonly number[],
  mass: number = CREDIBLE_MASS,
): Interval {
  const sum = qualities.reduce((s, q) => s + q, 0);
  const alpha = 1 + sum;
  const beta = 1 + (qualities.length - sum);
  const tail = (1 - mass) / 2;
  return { lo: betaQuantile(tail, alpha, beta), hi: betaQuantile(1 - tail, alpha, beta) };
}

// ---------------------------------------------------------------------------
// Сборка отчёта
// ---------------------------------------------------------------------------

interface FinishedRow {
  model_id: string;
  effort: string;
  harness: string;
  task_class: string;
  verdict: string;
  caveats: string;
  cost_usd: number | null;
  cost_basis: string | null;
  cache_unpriced: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  usd_per_m_in: number | null;
  usd_per_m_out: number | null;
  usd_per_m_cache_read: number | null;
  usd_per_m_cache_write: number | null;
}

interface Bucket {
  modelId: string;
  effort: string;
  harness: string;
  qualities: number[];
  costs: number[];
  clean: number;
  caveatCounts: Record<string, number>;
  verdictCounts: Record<string, number>;
}

function parseCaveats(raw: string): Caveat[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Caveat[]) : [];
  } catch {
    return [];
  }
}

/** Счёт по строке цены, к которой попытка привязана. */
function frozenDiffers(row: FinishedRow): boolean {
  if (row.cost_usd === null || row.usd_per_m_in === null) return false;
  const fresh =
    (row.tokens_in * row.usd_per_m_in +
      row.tokens_out * (row.usd_per_m_out ?? 0) +
      row.tokens_cache_read * (row.usd_per_m_cache_read ?? 0) +
      row.tokens_cache_write * (row.usd_per_m_cache_write ?? 0)) /
    1e6;
  return Math.abs(fresh - row.cost_usd) > 1e-9;
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function armStat(bucket: Bucket, minAttempts: number): ArmStat {
  const attempts = bucket.qualities.length;
  return {
    arm: `${bucket.modelId}|${bucket.effort}`,
    modelId: bucket.modelId,
    effort: bucket.effort,
    harness: bucket.harness,
    attempts,
    qualityMean: mean(bucket.qualities),
    quality: qualityInterval(bucket.qualities),
    costUsdMean: bucket.costs.length === 0 ? null : mean(bucket.costs),
    costUsdTotal: bucket.costs.reduce((s, v) => s + v, 0),
    costedAttempts: bucket.costs.length,
    costCoverage: bucket.costs.length / attempts,
    cleanRate: bucket.clean / attempts,
    caveatCounts: bucket.caveatCounts,
    verdictCounts: bucket.verdictCounts,
    enoughData: attempts >= minAttempts,
  };
}

interface Decision {
  readonly qualityLeader: string | null;
  readonly equalGroup: string[];
  readonly cheapest: string | null;
  readonly separationPending: boolean;
  readonly answer: AnswerCode;
  readonly why: string;
}

function answerFor(arms: readonly ArmStat[]): Decision {
  const eligible = arms.filter((a) => a.enoughData);
  if (eligible.length === 0) {
    return {
      qualityLeader: null,
      equalGroup: [],
      cheapest: null,
      separationPending: false,
      answer: "insufficient_attempts",
      why: `ни у одной руки нет нужного числа закрытых попыток (максимум ${Math.max(
        0,
        ...arms.map((a) => a.attempts),
      )})`,
    };
  }
  if (eligible.length === 1) {
    return {
      qualityLeader: eligible[0]!.arm,
      equalGroup: [eligible[0]!.arm],
      cheapest: null,
      separationPending: false,
      answer: "single_arm",
      why: `наблюдения есть только у ${eligible[0]!.arm}; сравнивать не с чем`,
    };
  }

  // Лидер — рука с лучшим средним качеством. «Равный результат» —
  // пересечение интервалов доверия с лидером, а не равенство средних:
  // на трёх наблюдениях среднее не отличает 1.0 от 0.8.
  const leader = eligible.reduce((best, a) => (a.qualityMean > best.qualityMean ? a : best));
  const equal = eligible.filter(
    (a) => a.quality.hi >= leader.quality.lo && leader.quality.hi >= a.quality.lo,
  );
  const priced = equal.filter((a) => a.costUsdMean !== null);
  if (priced.length === 0) {
    return {
      qualityLeader: leader.arm,
      equalGroup: equal.map((a) => a.arm),
      cheapest: null,
      separationPending: false,
      answer: "no_cost_data",
      why: "результат сравним, но стоимость не посчитана ни у одной руки: нет токенов или нет цены на момент попытки",
    };
  }
  const cheapest = priced.reduce((best, a) => (a.costUsdMean! < best.costUsdMean! ? a : best));
  const separationPending = cheapest.qualityMean < leader.qualityMean - 1e-9;
  let why: string;
  if (equal.length === 1) {
    why = `по результату ${leader.arm} не имеет равных (интервалы остальных не пересекаются), брать его`;
  } else {
    why =
      `${equal.length} рук неотличимы по результату, из них дешевле ${cheapest.arm} ` +
      `($${cheapest.costUsdMean!.toFixed(4)} против $${Math.max(
        ...priced.map((a) => a.costUsdMean!),
      ).toFixed(4)} за попытку)`;
    if (separationPending) {
      why +=
        `; ВНИМАНИЕ: среднее качество ${cheapest.arm} ниже (${cheapest.qualityMean.toFixed(2)} ` +
        `против ${leader.qualityMean.toFixed(2)}), интервалы ещё пересекаются — ` +
        "наблюдений не хватает, чтобы отличить";
    }
  }
  return {
    qualityLeader: leader.arm,
    equalGroup: equal.map((a) => a.arm),
    cheapest: cheapest.arm,
    separationPending,
    answer: "ok",
    why,
  };
}

/**
 * Ответ на вопрос по закрытым попыткам. Читает только swarm_attempt:
 * стоимость там уже заморожена, пересчёт по текущей цене здесь невозможен
 * ПО ПОСТРОЕНИЮ — цену эта функция не открывает вовсе.
 */
export function compareModels(db: Database, options: CompareOptions = {}): CompareReport {
  const minAttempts = options.minAttempts ?? DEFAULT_MIN_ATTEMPTS;
  if (options.taskClass !== undefined && !isTaskClass(options.taskClass)) {
    throw new Error(`класс задачи "${options.taskClass}" не из таксономии intent:scope`);
  }

  const where = ["a.finished_at IS NOT NULL", "a.verdict IS NOT NULL"];
  const params: Array<string | number> = [];
  if (options.taskClass !== undefined) {
    params.push(options.taskClass);
    where.push(`a.task_class = ?${params.length}`);
  }
  if (options.since !== undefined) {
    params.push(options.since);
    where.push(`a.finished_at >= ?${params.length}`);
  }
  // Цена открывается ровно для одного: сказать, что попытку заморозили по
  // нулевой ставке кеша. В стоимость она не входит и пересчёта не даёт —
  // берётся ТА строка (price_valid_from), по которой уже посчитано.
  const rows = db
    .query(
      `SELECT a.model_id, a.effort, a.harness, a.task_class, a.verdict, a.caveats,
              a.cost_usd, a.cost_basis,
              CASE WHEN a.tokens_cache_read + a.tokens_cache_write > 0
                    AND coalesce(p.usd_per_m_cache_read, 0) = 0
                    AND coalesce(p.usd_per_m_cache_write, 0) = 0
                   THEN 1 ELSE 0 END AS cache_unpriced,
              a.tokens_in, a.tokens_out, a.tokens_cache_read, a.tokens_cache_write,
              p.usd_per_m_in, p.usd_per_m_out,
              p.usd_per_m_cache_read, p.usd_per_m_cache_write
         FROM swarm_attempt a
         LEFT JOIN swarm_model_price p
                ON p.model_id = a.model_id AND p.valid_from = a.price_valid_from
        WHERE ${where.join(" AND ")}`,
    )
    .all(...params) as FinishedRow[];

  const byClass = new Map<string, Map<string, Bucket>>();
  let withCost = 0;
  let costCacheUnpriced = 0;
  let costStale = 0;
  for (const row of rows) {
    const caveats = parseCaveats(row.caveats);
    const quality = qualityOf(row.verdict as Verdict, caveats);
    const armKey = `${row.model_id}|${row.effort}`;
    let arms = byClass.get(row.task_class);
    if (arms === undefined) {
      arms = new Map();
      byClass.set(row.task_class, arms);
    }
    let bucket = arms.get(armKey);
    if (bucket === undefined) {
      bucket = {
        modelId: row.model_id,
        effort: row.effort,
        harness: row.harness,
        qualities: [],
        costs: [],
        clean: 0,
        caveatCounts: {},
        verdictCounts: {},
      };
      arms.set(armKey, bucket);
    }
    bucket.qualities.push(quality);
    bucket.verdictCounts[row.verdict] = (bucket.verdictCounts[row.verdict] ?? 0) + 1;
    if (row.verdict === "accepted" && caveats.length === 0) bucket.clean += 1;
    for (const c of caveats) bucket.caveatCounts[c] = (bucket.caveatCounts[c] ?? 0) + 1;
    if (row.cost_usd !== null && (row.cost_basis as CostBasis | null) === "priced") {
      bucket.costs.push(row.cost_usd);
      withCost += 1;
      if (row.cache_unpriced === 1) costCacheUnpriced += 1;
      if (frozenDiffers(row)) costStale += 1;
    }
  }

  const classes: ClassAnswer[] = [];
  let armCount = 0;
  for (const [taskClass, arms] of [...byClass.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const stats = [...arms.values()]
      .map((b) => armStat(b, minAttempts))
      .sort((a, b) => b.qualityMean - a.qualityMean || a.arm.localeCompare(b.arm));
    armCount += stats.length;
    classes.push({ taskClass, arms: stats, ...answerFor(stats) });
  }

  const totals = db
    .query(
      "SELECT count(*) AS n, sum(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS f FROM swarm_attempt",
    )
    .get() as { n: number; f: number | null };

  return {
    outcomeVersion: OUTCOME_VERSION,
    minAttempts,
    credibleMass: CREDIBLE_MASS,
    classes,
    coverage: {
      attempts: totals.n,
      finished: totals.f ?? 0,
      withCost,
      costCacheUnpriced,
      costStale,
      arms: armCount,
      classes: classes.length,
    },
  };
}
