import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  EMPTY_LAUNCH,
  isEmptyLaunch,
  type DispatchSource,
  type LaunchContext,
  type LinkSource,
  type PidSource,
  type ProcState,
} from "./launch.ts";
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
  /**
   * Контекст запуска. Пишется В ТОЙ ЖЕ транзакции, что и сама попытка:
   * попытки без строки запуска быть можно (ретроспектива), а попытки
   * с ПОЛОВИНОЙ записанного запуска — нет.
   */
  readonly run?: RunInput;
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

// ---------------------------------------------------------------------------
// Запуск попытки: сессия, диспетчер, процесс
// ---------------------------------------------------------------------------

export interface RunInput {
  readonly launch: LaunchContext;
  /** Файл стенограммы, если он известен ТОЧНО, а не найден перебором. */
  readonly transcriptPath?: string | null;
  /** HEAD на момент старта — база для «какие файлы тронуты». */
  readonly gitHead?: string | null;
  readonly procState?: ProcState;
}

export interface RunRecord {
  readonly attemptId: string;
  readonly sessionId: string | null;
  readonly sessionSource: LinkSource;
  readonly transcriptPath: string | null;
  readonly dispatchId: string | null;
  readonly dispatchSource: DispatchSource;
  readonly runId: string | null;
  readonly terminal: string | null;
  readonly paneKey: string | null;
  readonly agentPid: number | null;
  readonly pidSource: PidSource;
  readonly harnessBuild: string | null;
  readonly procState: ProcState;
  readonly procCheckedAt: number | null;
  readonly procExitedAt: number | null;
  readonly gitHead: string | null;
  readonly filesTouched: readonly string[] | null;
  readonly recordedAt: number;
}

interface RunRow {
  attempt_id: string;
  session_id: string | null;
  session_source: string;
  transcript_path: string | null;
  dispatch_id: string | null;
  dispatch_source: string;
  run_id: string | null;
  terminal: string | null;
  pane_key: string | null;
  agent_pid: number | null;
  pid_source: string;
  harness_build: string | null;
  proc_state: string;
  proc_checked_at: number | null;
  proc_exited_at: number | null;
  git_head: string | null;
  files_touched: string | null;
  recorded_at: number;
}

function parseFiles(raw: string | null): readonly string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((f): f is string => typeof f === "string");
  } catch {
    return null;
  }
}

export function toRun(row: RunRow): RunRecord {
  return {
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    sessionSource: row.session_source as LinkSource,
    transcriptPath: row.transcript_path,
    dispatchId: row.dispatch_id,
    dispatchSource: row.dispatch_source as DispatchSource,
    runId: row.run_id,
    terminal: row.terminal,
    paneKey: row.pane_key,
    agentPid: row.agent_pid,
    pidSource: row.pid_source as PidSource,
    harnessBuild: row.harness_build,
    procState: row.proc_state as ProcState,
    procCheckedAt: row.proc_checked_at,
    procExitedAt: row.proc_exited_at,
    gitHead: row.git_head,
    filesTouched: parseFiles(row.files_touched),
    recordedAt: row.recorded_at,
  };
}

/** Попытка вместе со своим запуском — то, что читает `myc attempt list --live`. */
export interface AttemptWithRun {
  readonly attempt: AttemptRecord;
  readonly run: RunRecord | undefined;
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
      // В ТОЙ ЖЕ транзакции. Попытка, открытая без своей строки запуска
      // из-за отказа на второй вставке, — это ровно та потеря связи с
      // сессией, ради которой всё писалось: расход опять пришлось бы
      // искать перебором стенограмм.
      if (input.run !== undefined) this.#insertRun(attemptId, startedAt, input.run);
    });
    return this.getAttempt(attemptId)!;
  }

  /**
   * Строка запуска. Пустой контекст НЕ пишется: строка из одних NULL
   * говорит «мы записали» там, где не записано ничего, а `--live` показал
   * бы её как известную. Нечего сказать — молчим и это видно по
   * отсутствию строки.
   */
  #insertRun(attemptId: string, recordedAt: number, run: RunInput): void {
    const c = run.launch;
    if (isEmptyLaunch(c) && run.gitHead == null && run.transcriptPath == null) return;
    const procState: ProcState =
      run.procState ?? (c.agentPid === null ? "unknown" : "running");
    this.#db
      .query(
        `INSERT INTO swarm_attempt_run
           (attempt_id, session_id, session_source, transcript_path, dispatch_id,
            dispatch_source, run_id, terminal, pane_key, agent_pid, pid_source,
            harness_build, proc_state, proc_checked_at, git_head, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .run(
        attemptId,
        c.sessionId,
        c.sessionSource,
        run.transcriptPath ?? null,
        c.dispatchId,
        c.dispatchSource,
        c.runId,
        c.terminal,
        c.paneKey,
        c.agentPid,
        c.pidSource,
        c.harnessBuild,
        procState,
        c.agentPid === null ? null : recordedAt,
        run.gitHead ?? null,
        recordedAt,
      );
  }

  /**
   * Дописать запуск к уже открытой попытке: поздняя привязка (сессию
   * нашли перебором) и достройка ретроспективной попытки. Пишет только
   * НАЗВАННЫЕ поля — COALESCE тут был бы неправ: явный null «сессия
   * неизвестна» должен уметь стереть неверную привязку.
   */
  attachRun(attemptId: string, run: RunInput): RunRecord {
    const now = this.#now();
    this.#writeTx(() => {
      const exists = this.#db
        .query("SELECT attempt_id FROM swarm_attempt WHERE attempt_id = ?1")
        .get(attemptId);
      if (exists === null) {
        throw new AttributionError(
          "notfound.attempt",
          `попытка "${attemptId}" не найдена`,
        );
      }
      const had = this.#db
        .query("SELECT attempt_id FROM swarm_attempt_run WHERE attempt_id = ?1")
        .get(attemptId);
      if (had !== null) {
        this.#db.query("DELETE FROM swarm_attempt_run WHERE attempt_id = ?1").run(attemptId);
      }
      this.#insertRun(attemptId, now, run);
    });
    return this.getRun(attemptId)!;
  }

  getRun(attemptId: string): RunRecord | undefined {
    const row = this.#db
      .query("SELECT * FROM swarm_attempt_run WHERE attempt_id = ?1")
      .get(attemptId) as RunRow | null;
    return row === null ? undefined : toRun(row);
  }

  /**
   * Чья это сессия. Обратный вопрос к записи — он же замена перебору
   * файлов: расход считается по стенограмме, названной попыткой, а не по
   * той, где нашлась строка брифа.
   */
  attemptsBySession(sessionId: string): RunRecord[] {
    const rows = this.#db
      .query("SELECT * FROM swarm_attempt_run WHERE session_id = ?1")
      .all(sessionId) as RunRow[];
    return rows.map(toRun);
  }

  /**
   * Наблюдение за процессом. ТОЛЬКО в сторону exited: воскрешать запись
   * нельзя — pid переиспользуются, и «был мёртв, стал жив» означало бы,
   * что мы приняли чужой процесс за свой. Возвращает true, если запись
   * действительно изменилась.
   */
  markExited(attemptId: string, at: number = this.#now()): boolean {
    return (
      this.#writeTx(
        () =>
          this.#db
            .query(
              `UPDATE swarm_attempt_run
                  SET proc_state = 'exited', proc_exited_at = COALESCE(proc_exited_at, ?2),
                      proc_checked_at = ?2
                WHERE attempt_id = ?1 AND proc_state <> 'exited'`,
            )
            .run(attemptId, at).changes,
      ) > 0
    );
  }

  /** Отметить, что процесс видели живым: обновляет только время проверки. */
  markSeen(attemptId: string, at: number = this.#now()): void {
    this.#writeTx(() => {
      this.#db
        .query(
          `UPDATE swarm_attempt_run SET proc_checked_at = ?2
            WHERE attempt_id = ?1 AND proc_state = 'running'`,
        )
        .run(attemptId, at);
    });
  }

  /** Тронутые файлы попытки: считает их не этот пакет, а вызывающий. */
  recordFilesTouched(attemptId: string, files: readonly string[]): void {
    this.#writeTx(() => {
      this.#db
        .query("UPDATE swarm_attempt_run SET files_touched = ?2 WHERE attempt_id = ?1")
        .run(attemptId, JSON.stringify([...files]));
    });
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
   * Попытки вместе со строкой запуска. Одним запросом, LEFT JOIN: ответ
   * «что сейчас живо» обязан быть ОДНОЙ командой, а не списком попыток
   * плюс запрос запуска на каждую.
   *
   * Порядок — по времени старта по возрастанию: первым идёт то, что
   * висит дольше всех. Это и есть ответ на «сколько висит».
   */
  listWithRuns(
    options: {
      taskId?: string;
      modelId?: string;
      open?: boolean;
      withRun?: boolean;
      since?: number;
      limit?: number;
    } = {},
  ): AttemptWithRun[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.taskId !== undefined) {
      params.push(options.taskId);
      where.push(`a.task_id = ?${params.length}`);
    }
    if (options.modelId !== undefined) {
      params.push(options.modelId);
      where.push(`a.model_id = ?${params.length}`);
    }
    if (options.open === true) where.push("a.finished_at IS NULL");
    if (options.withRun === true) where.push("r.attempt_id IS NOT NULL");
    if (options.since !== undefined) {
      params.push(options.since);
      where.push(`a.started_at >= ?${params.length}`);
    }
    params.push(options.limit ?? 200);
    const rows = this.#db
      .query(
        `SELECT a.*, r.attempt_id AS r_attempt_id, r.session_id, r.session_source,
                r.transcript_path, r.dispatch_id, r.dispatch_source, r.run_id,
                r.terminal, r.pane_key, r.agent_pid, r.pid_source, r.harness_build,
                r.proc_state, r.proc_checked_at, r.proc_exited_at, r.git_head,
                r.files_touched, r.recorded_at
           FROM swarm_attempt a
           LEFT JOIN swarm_attempt_run r ON r.attempt_id = a.attempt_id
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY a.started_at ASC LIMIT ?${params.length}`,
      )
      .all(...params) as Array<AttemptRow & Partial<RunRow> & { r_attempt_id: string | null }>;
    return rows.map((row) => ({
      attempt: toAttempt(row),
      run:
        row.r_attempt_id === null || row.r_attempt_id === undefined
          ? undefined
          : toRun({ ...(row as unknown as RunRow), attempt_id: row.r_attempt_id }),
    }));
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
