import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { RosterError, type Effort, type Harness } from "./roster.ts";
import { isTaskClass, type TaskClass } from "./taskclass.ts";

/**
 * Атрибуция исполнения (W11): кто выполнял задачу, чем и с каким
 * результатом. Домен поверх таблицы swarm_attempt (миграция 003).
 *
 * Три инварианта, на которых стоят тесты и мутации:
 *
 * 1. МОДЕЛЬ — ИЗ РОСТЕРА. `startAttempt` отвергает модель, которой нет в
 *    swarm_model, кодом notfound.model ДО записи. Это не формальность:
 *    цена (а значит и весь ответ «дешевле при равном результате») живёт в
 *    ростере, и запись исхода с моделью-самозванкой рвёт связь — исход
 *    есть, посчитать его нечем. Харнесс и уровень рассуждений при этом
 *    берутся ИЗ ростера, а не вводятся руками: одна названная модель
 *    вместо трёх флагов.
 * 2. ОГОВОРКИ НЕ БЕСПЛАТНЫ. «Принято, но координатор доделал сам» и
 *    «принято, но тест не ловит мутации» — не успех. qualityOf вычитает
 *    за каждую оговорку, и разница видна в ответе на вопрос, а не только
 *    в поле. Свести оговорки к успеху — научить рой рекомендовать
 *    модель, чьи работы каждый раз приходится дорабатывать.
 * 3. СТОИМОСТЬ ЗАМОРОЖЕНА. cost_usd считается на finish по строке
 *    swarm_model_price, действовавшей на started_at, и больше никогда не
 *    пересчитывается. Иначе обновление прайса задним числом меняет исход
 *    уже закрытых задач, и «стало дешевле» — артефакт правки цены.
 *
 * Формула качества версионируется OUTCOME_VERSION и живёт в коде, а не в
 * БД: отчёт обязан уметь сказать, по какой формуле считал (§2.3.1).
 */

export const VERDICTS = ["accepted", "rework", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Оговорки приёмки. Каждая — то, что реально происходило за день работы
 * координатора с роем, и то, что обязано различаться в данных.
 */
export const CAVEATS = [
  /** Принято, но часть доделал координатор. */
  "coordinator_fixed",
  /** Принято, но тесты проходят и на сломанной реализации. */
  "tests_weak",
  /** Принято, но сообщённая агентом находка не подтвердилась. */
  "report_inaccurate",
  /** Принято, но часть заявленного объёма не сделана. */
  "scope_missed",
] as const;
export type Caveat = (typeof CAVEATS)[number];

/** Версия формулы качества: меняется вместе с весами ниже. */
export const OUTCOME_VERSION = 1;

const VERDICT_BASE: Readonly<Record<Verdict, number>> = {
  accepted: 1,
  rework: 0.5,
  rejected: 0,
};

const CAVEAT_PENALTY: Readonly<Record<Caveat, number>> = {
  coordinator_fixed: 0.35,
  tests_weak: 0.4,
  report_inaccurate: 0.25,
  scope_missed: 0.3,
};

/** Пол для принятой работы: приёмка с оговорками — не полный провал. */
const ACCEPTED_FLOOR = 0.1;

/**
 * Качество попытки ∈ [0,1] из вердикта и оговорок. Отказ — ноль всегда:
 * оговорки к отказу ничего не добавляют. Принятая работа с оговорками
 * ОБЯЗАНА быть строго меньше единицы — на этом стоит первая мутация.
 */
export function qualityOf(verdict: Verdict, caveats: readonly Caveat[] = []): number {
  if (verdict === "rejected") return 0;
  const penalty = [...new Set(caveats)].reduce(
    (sum, c) => sum + (CAVEAT_PENALTY[c] ?? 0),
    0,
  );
  return Math.max(ACCEPTED_FLOOR, VERDICT_BASE[verdict] - penalty);
}

export type AttributionErrorCode =
  | "usage.input"
  | "usage.verdict"
  | "usage.caveat"
  | "usage.class"
  | "notfound.attempt"
  | "conflict.finished";

export class AttributionError extends Error {
  readonly code: AttributionErrorCode;

  constructor(code: AttributionErrorCode, message: string) {
    super(message);
    this.name = "AttributionError";
    this.code = code;
  }
}

export type CostBasis = "priced" | "no_price" | "no_tokens";

export interface TokenUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly tokensCacheRead?: number;
  readonly tokensCacheWrite?: number;
}

export interface StartAttemptInput extends TokenUsage {
  readonly taskId: string;
  readonly modelId: string;
  readonly taskClass: string;
  readonly classSource?: "derived" | "declared";
  /** Не указан — берётся из ростера: модель уже знает свой уровень. */
  readonly effort?: Effort;
  /** Не указан — берётся из ростера: модель уже знает свой харнесс. */
  readonly harness?: Harness;
  readonly actor?: string;
  readonly startedAt?: number;
  readonly source?: string;
  readonly note?: string;
}

export interface FinishAttemptInput extends TokenUsage {
  readonly verdict: string;
  readonly caveats?: readonly string[];
  readonly retries?: number;
  readonly finishedAt?: number;
  readonly note?: string;
}

export interface AttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly modelId: string;
  readonly effort: Effort;
  readonly harness: Harness;
  readonly actor: string;
  readonly taskClass: TaskClass;
  readonly classSource: "derived" | "declared";
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly verdict: Verdict | null;
  readonly caveats: readonly Caveat[];
  readonly retries: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheWrite: number;
  /** Заморожен на finish; null — посчитать было нечем. */
  readonly costUsd: number | null;
  /** Какая строка цены применена — счёт можно перепроверить. */
  readonly priceValidFrom: number | null;
  readonly costBasis: CostBasis | null;
  readonly source: string;
  readonly note: string | null;
  /** Формула, а не колонка: считается из verdict и caveats. */
  readonly quality: number | null;
  readonly wallMs: number | null;
}

interface AttemptRow {
  attempt_id: string;
  task_id: string;
  model_id: string;
  effort: string;
  harness: string;
  actor: string;
  task_class: string;
  class_source: string;
  started_at: number;
  finished_at: number | null;
  verdict: string | null;
  caveats: string;
  retries: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number | null;
  price_valid_from: number | null;
  cost_basis: string | null;
  source: string;
  note: string | null;
}

function parseCaveats(raw: string): Caveat[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((c): c is Caveat => (CAVEATS as readonly unknown[]).includes(c));
}

export function toAttempt(row: AttemptRow): AttemptRecord {
  const verdict = row.verdict === null ? null : (row.verdict as Verdict);
  const caveats = parseCaveats(row.caveats);
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    modelId: row.model_id,
    effort: row.effort as Effort,
    harness: row.harness as Harness,
    actor: row.actor,
    taskClass: row.task_class as TaskClass,
    classSource: row.class_source as "derived" | "declared",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    verdict,
    caveats,
    retries: row.retries,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCacheRead: row.tokens_cache_read,
    tokensCacheWrite: row.tokens_cache_write,
    costUsd: row.cost_usd,
    priceValidFrom: row.price_valid_from,
    costBasis: row.cost_basis as CostBasis | null,
    source: row.source,
    note: row.note,
    quality: verdict === null ? null : qualityOf(verdict, caveats),
    wallMs: row.finished_at === null ? null : row.finished_at - row.started_at,
  };
}

export function newAttemptId(): string {
  return `att_${randomBytes(6).toString("hex")}`;
}

function requireVerdict(value: string): Verdict {
  if ((VERDICTS as readonly string[]).includes(value)) return value as Verdict;
  throw new AttributionError(
    "usage.verdict",
    `неизвестный вердикт "${value}"; известно: ${VERDICTS.join(", ")}`,
  );
}

function requireCaveats(values: readonly string[]): Caveat[] {
  const out: Caveat[] = [];
  for (const value of values) {
    if (!(CAVEATS as readonly string[]).includes(value)) {
      throw new AttributionError(
        "usage.caveat",
        `неизвестная оговорка "${value}"; известно: ${CAVEATS.join(", ")}`,
      );
    }
    if (!out.includes(value as Caveat)) out.push(value as Caveat);
  }
  return out;
}

/**
 * Счётчик токенов. Граница — БЕЗОПАСНОЕ целое, а не просто целое: чтения
 * кеша доходят до 2 млрд за сессию, и хотя до 2^53 всё точно и в JS, и в
 * INTEGER SQLite, за этой границей число уже округлено — записать его
 * значит сохранить неправду молча.
 */
function count(value: number | undefined, name: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AttributionError(
      "usage.input",
      `${name} обязан быть целым ≥ 0 и не больше ${Number.MAX_SAFE_INTEGER}`,
    );
  }
  return value;
}

interface PriceRow {
  valid_from: number;
  usd_per_m_in: number;
  usd_per_m_out: number;
  usd_per_m_cache_read: number;
  usd_per_m_cache_write: number;
}

export class Attribution {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Та же дисциплина, что у ростера: запись только в BEGIN IMMEDIATE. */
  #writeTx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Открыть попытку. Модель обязана быть в ростере — иначе notfound.model
   * ДО записи; харнесс и effort по умолчанию наследуются оттуда же.
   */
  startAttempt(input: StartAttemptInput): AttemptRecord {
    if (input.taskId.trim() === "") {
      throw new AttributionError("usage.input", "taskId обязан быть непустым");
    }
    if (!isTaskClass(input.taskClass)) {
      throw new AttributionError(
        "usage.class",
        `класс задачи "${input.taskClass}" не из таксономии intent:scope`,
      );
    }
    const model = this.#db
      .query(
        "SELECT model_id, harness, effort FROM swarm_model WHERE model_id = ?1",
      )
      .get(input.modelId) as { model_id: string; harness: string; effort: string } | null;
    if (model === null) {
      throw new RosterError(
        "notfound.model",
        `модель "${input.modelId}" не найдена в ростере; заведите её: myc model add`,
      );
    }

    const attemptId = newAttemptId();
    const startedAt = input.startedAt ?? this.#now();
    this.#writeTx(() => {
      this.#db
        .query(
          `INSERT INTO swarm_attempt
             (attempt_id, task_id, model_id, effort, harness, actor, task_class,
              class_source, started_at, tokens_in, tokens_out, tokens_cache_read,
              tokens_cache_write, source, note)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
        )
        .run(
          attemptId,
          input.taskId,
          input.modelId,
          input.effort ?? model.effort,
          input.harness ?? model.harness,
          input.actor ?? "",
          input.taskClass,
          input.classSource ?? "derived",
          startedAt,
          count(input.tokensIn, "tokensIn"),
          count(input.tokensOut, "tokensOut"),
          count(input.tokensCacheRead, "tokensCacheRead"),
          count(input.tokensCacheWrite, "tokensCacheWrite"),
          input.source ?? "cli",
          input.note ?? null,
        );
    });
    return this.getAttempt(attemptId)!;
  }

  /**
   * Закрыть попытку исходом. Победитель гонки ровно один: UPDATE идёт по
   * `finished_at IS NULL`, второй процесс получает conflict.finished, а не
   * молча перетирает чужой вердикт.
   */
  finishAttempt(attemptId: string, input: FinishAttemptInput): AttemptRecord {
    const verdict = requireVerdict(input.verdict);
    const caveats = requireCaveats(input.caveats ?? []);
    const retries = count(input.retries, "retries");
    const finishedAt = input.finishedAt ?? this.#now();

    const changed = this.#writeTx(() => {
      const row = this.#db
        .query("SELECT * FROM swarm_attempt WHERE attempt_id = ?1")
        .get(attemptId) as AttemptRow | null;
      if (row === null) {
        throw new AttributionError(
          "notfound.attempt",
          `попытка "${attemptId}" не найдена`,
        );
      }
      const tokensIn = count(input.tokensIn ?? row.tokens_in, "tokensIn");
      const tokensOut = count(input.tokensOut ?? row.tokens_out, "tokensOut");
      const cacheRead = count(input.tokensCacheRead ?? row.tokens_cache_read, "tokensCacheRead");
      const cacheWrite = count(
        input.tokensCacheWrite ?? row.tokens_cache_write,
        "tokensCacheWrite",
      );
      const cost = this.#freezeCost(row.model_id, row.started_at, {
        tokensIn,
        tokensOut,
        tokensCacheRead: cacheRead,
        tokensCacheWrite: cacheWrite,
      });

      const result = this.#db
        .query(
          `UPDATE swarm_attempt
              SET finished_at = ?1, verdict = ?2, caveats = ?3, retries = ?4,
                  tokens_in = ?5, tokens_out = ?6, tokens_cache_read = ?7,
                  tokens_cache_write = ?8, cost_usd = ?9, price_valid_from = ?10,
                  cost_basis = ?11, note = COALESCE(?12, note)
            WHERE attempt_id = ?13 AND finished_at IS NULL`,
        )
        .run(
          finishedAt,
          verdict,
          JSON.stringify(caveats),
          retries,
          tokensIn,
          tokensOut,
          cacheRead,
          cacheWrite,
          cost.costUsd,
          cost.priceValidFrom,
          cost.basis,
          input.note ?? null,
          attemptId,
        );
      return result.changes;
    });

    if (changed === 0) {
      throw new AttributionError(
        "conflict.finished",
        `попытка "${attemptId}" уже закрыта; исход переписать нельзя`,
      );
    }
    return this.getAttempt(attemptId)!;
  }

  getAttempt(attemptId: string): AttemptRecord | undefined {
    const row = this.#db
      .query("SELECT * FROM swarm_attempt WHERE attempt_id = ?1")
      .get(attemptId) as AttemptRow | null;
    return row === null ? undefined : toAttempt(row);
  }

  /** Последняя открытая попытка по задаче — её и закрывает `myc close`. */
  openAttemptForTask(taskId: string): AttemptRecord | undefined {
    const row = this.#db
      .query(
        `SELECT * FROM swarm_attempt
          WHERE task_id = ?1 AND finished_at IS NULL
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(taskId) as AttemptRow | null;
    return row === null ? undefined : toAttempt(row);
  }

  listAttempts(
    options: {
      taskId?: string;
      modelId?: string;
      open?: boolean;
      since?: number;
      limit?: number;
    } = {},
  ): AttemptRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.taskId !== undefined) {
      params.push(options.taskId);
      where.push(`task_id = ?${params.length}`);
    }
    if (options.modelId !== undefined) {
      params.push(options.modelId);
      where.push(`model_id = ?${params.length}`);
    }
    if (options.open === true) where.push("finished_at IS NULL");
    if (options.since !== undefined) {
      params.push(options.since);
      where.push(`started_at >= ?${params.length}`);
    }
    params.push(options.limit ?? 200);
    const rows = this.#db
      .query(
        `SELECT * FROM swarm_attempt
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY started_at DESC LIMIT ?${params.length}`,
      )
      .all(...params) as AttemptRow[];
    return rows.map(toAttempt);
  }

  /**
   * Стоимость по цене, действовавшей на started_at — и только на него.
   * Ни `now`, ни «последняя известная цена»: исход закрытой задачи не
   * имеет права меняться от того, что кто-то обновил прайс.
   */
  #freezeCost(
    modelId: string,
    startedAt: number,
    usage: Required<TokenUsage>,
  ): { costUsd: number | null; priceValidFrom: number | null; basis: CostBasis } {
    const total =
      usage.tokensIn + usage.tokensOut + usage.tokensCacheRead + usage.tokensCacheWrite;
    if (total === 0) return { costUsd: null, priceValidFrom: null, basis: "no_tokens" };
    const price = this.#db
      .query(
        `SELECT valid_from, usd_per_m_in, usd_per_m_out,
                usd_per_m_cache_read, usd_per_m_cache_write
           FROM swarm_model_price
          WHERE model_id = ?1 AND valid_from <= ?2
          ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(modelId, startedAt) as PriceRow | null;
    if (price === null) return { costUsd: null, priceValidFrom: null, basis: "no_price" };
    const costUsd =
      (usage.tokensIn * price.usd_per_m_in +
        usage.tokensOut * price.usd_per_m_out +
        usage.tokensCacheRead * price.usd_per_m_cache_read +
        usage.tokensCacheWrite * price.usd_per_m_cache_write) /
      1e6;
    return { costUsd, priceValidFrom: price.valid_from, basis: "priced" };
  }
}
