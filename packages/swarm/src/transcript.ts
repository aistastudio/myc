/**
 * Расход попытки из стенограммы агентской сессии (W11, ось цены).
 *
 * ЗАЧЕМ ЭТО ЗДЕСЬ. `myc report models` умеет отвечать «кто дешевле при
 * равном результате», но ось цены была пуста: 0 попыток со стоимостью из
 * 14. Причина не в отчёте — расход неоткуда взять. Оркестратор его не
 * отдаёт вовсе (проверено 2026-09-06: в `worker-show --json` и
 * `worker-list --json` слов token/cost/usage нет), а руками четыре числа
 * на каждую попытку никто не вводит — ровно та же причина, по которой до
 * W11 оставалась пустой схема исхода.
 *
 * Отдаёт расход сама сессия: у Claude Code каждый ответ модели записан в
 * ~/.claude/projects/<путь с '/' → '-'>/<uuid>.jsonl вместе с полем
 * `message.usage`.
 *
 * ЧУЖОЙ ФОРМАТ — ГРОМКИЙ РАЗБОР (И2). Стенограмма принадлежит не нам и
 * может смениться без предупреждения. Ноль здесь неотличим от «не смогли
 * прочитать», и именно так ось цены осталась бы пустой МОЛЧА: попытка
 * закрыта, cost_basis='no_tokens', отчёт по-прежнему пуст, и никто не
 * знает почему. Поэтому каждое несовпадение с ожидаемым форматом — отказ:
 *
 * - файла нет / не читается            → transcript.missing / .unreadable
 * - ни одной разобранной записи        → transcript.empty
 * - ни в одном сообщении нет usage     → transcript.no_usage
 * - usage есть, но без знакомых полей  → transcript.no_fields
 * - знакомое поле пропало (переименовали) → transcript.missing_field
 * - поле есть, но не целое число ≥ 0   → transcript.bad_field
 * - у записи с usage нет ключа склейки → transcript.no_key
 * - сумма не влезает в точные целые    → transcript.overflow
 * - разобрано, но суммарный расход 0   → transcript.no_tokens
 *
 * СКЛЕЙКА ПО message.id — НЕ ОПТИМИЗАЦИЯ, А ТОЧНОСТЬ. Один ответ модели
 * лежит в стенограмме несколькими записями (рассуждение, текст, вызовы
 * инструментов), и КАЖДАЯ несёт копию одного и того же usage. Замер по
 * 397 стенограммам этого проекта: 16827 записей с usage дают 9290
 * настоящих ответов, наивная сумма завышает расход в ~1.6 раза (на
 * memory-2shvpjay4nx6: out 119953 против 68803, чтения кеша 18.2 млн
 * против 11.7 млн). В 941 группе из 947 различающихся значения растут
 * монотонно — это частичные записи стриминга, поэтому по группе берётся
 * МАКСИМУМ поля, а не первое и не сумма.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TranscriptErrorCode =
  | "transcript.missing"
  | "transcript.unreadable"
  | "transcript.empty"
  | "transcript.no_usage"
  | "transcript.no_fields"
  | "transcript.missing_field"
  | "transcript.bad_field"
  | "transcript.exclude_miss"
  | "transcript.exclude_ambiguous"
  | "transcript.no_key"
  | "transcript.overflow"
  | "transcript.no_tokens"
  | "transcript.dir_missing"
  | "notfound.session"
  | "notfound.task_session"
  | "conflict.session";

export class TranscriptError extends Error {
  readonly code: TranscriptErrorCode;
  /** Что показать рядом с ошибкой: кандидаты, имя поля, номер строки. */
  readonly hint: string | undefined;

  constructor(code: TranscriptErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "TranscriptError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Имена полей чужого формата → наши. Каждое обязано встретиться хотя бы
 * раз: если переименуют одно (скажем, чтения кеша — самую крупную
 * статью), молчаливый ноль занизил бы стоимость в разы.
 */
export const USAGE_FIELDS = [
  ["input_tokens", "tokensIn"],
  ["output_tokens", "tokensOut"],
  ["cache_read_input_tokens", "tokensCacheRead"],
  ["cache_creation_input_tokens", "tokensCacheWrite"],
] as const;

type TotalsKey = (typeof USAGE_FIELDS)[number][1];

export interface TranscriptTotals {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheWrite: number;
}

export interface TranscriptUsage extends TranscriptTotals {
  /** Файл, из которого прочитано. */
  readonly path: string;
  readonly sessionId: string | null;
  /** Ответов модели после склейки по message.id. */
  readonly responses: number;
  /** Записей, нёсших usage, до склейки. */
  readonly usageRecords: number;
  /** Всего разобранных записей файла. */
  readonly records: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly models: readonly string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Складывает, не теряя точности молча. Расход бывает огромным — чтения
 * кеша доходят до 2 млрд токенов за сессию, — и хотя до 2^53 всё точно,
 * выход за эту границу обязан быть отказом, а не тихо округлённым числом.
 */
function addExact(total: number, add: number, field: string): number {
  const sum = total + add;
  if (!Number.isSafeInteger(sum)) {
    throw new TranscriptError(
      "transcript.overflow",
      `sum of ${field} exceeded exact integers (${sum}); the number read cannot be trusted`,
    );
  }
  return sum;
}

function requireCount(value: unknown, field: string, line: number, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TranscriptError(
      "transcript.bad_field",
      `${path}:${line}: usage.${field} = ${JSON.stringify(value)} — not an integer ≥ 0; ` +
        "unexpected transcript format, usage not read",
      "check the format or fill in usage with --tokens-in/--tokens-out",
    );
  }
  return value;
}

/**
 * Расход одной стенограммы. Бросает TranscriptError на любом расхождении
 * с ожидаемым форматом: тихого нуля здесь быть не может.
 */
export function readTranscriptUsage(path: string): TranscriptUsage {
  if (!existsSync(path)) {
    throw new TranscriptError(
      "transcript.missing",
      `no transcript: ${path}`,
      "myc attempt finish … --from-session <uuid> or manual usage flags",
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new TranscriptError(
      "transcript.unreadable",
      `transcript ${path} is unreadable: ${(e as Error).message}`,
    );
  }

  // По группам склейки (message.id) — максимум каждого поля.
  const groups = new Map<string, Partial<Record<TotalsKey, number>>>();
  const seenFields = new Set<string>();
  const models = new Set<string>();
  let records = 0;
  let usageRecords = 0;
  let recognized = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(raw);
    } catch {
      // Оборванный хвост живого файла — не повод падать: сессия ещё пишется.
      continue;
    }
    if (!isRecord(rec)) continue;
    records += 1;

    const ts = rec["timestamp"];
    if (typeof ts === "string") {
      if (startedAt === null) startedAt = ts;
      endedAt = ts;
    }

    const msg = rec["message"];
    if (!isRecord(msg)) continue;
    const usage = msg["usage"];
    if (!isRecord(usage)) continue;
    usageRecords += 1;

    const msgId = msg["id"];
    const reqId = rec["requestId"];
    const key =
      typeof msgId === "string" && msgId !== ""
        ? msgId
        : typeof reqId === "string" && reqId !== ""
          ? reqId
          : undefined;
    if (key === undefined) {
      throw new TranscriptError(
        "transcript.no_key",
        `${path}:${i + 1}: a record with usage has neither message.id nor requestId; ` +
          "there is nothing to merge copies of one response by, the sum would be inflated",
        "the transcript format changed — fill in usage with manual flags",
      );
    }

    const model = msg["model"];
    if (typeof model === "string" && model !== "") models.add(model);

    const group = groups.get(key) ?? {};
    let any = false;
    for (const [wire, key2] of USAGE_FIELDS) {
      if (!(wire in usage)) continue;
      seenFields.add(wire);
      any = true;
      const v = requireCount(usage[wire], wire, i + 1, path);
      const prev = group[key2];
      if (prev === undefined || v > prev) group[key2] = v;
    }
    if (any) recognized += 1;
    groups.set(key, group);
  }

  if (records === 0) {
    throw new TranscriptError(
      "transcript.empty",
      `not a single record parsed in transcript ${path}`,
    );
  }
  if (usageRecords === 0) {
    throw new TranscriptError(
      "transcript.no_usage",
      `none of the ${records} messages in ${path} has message.usage; ` +
        "usage not read — this is a refusal, not zero",
      "the transcript format changed; fill in usage with --tokens-in/--tokens-out",
    );
  }
  if (recognized === 0) {
    throw new TranscriptError(
      "transcript.no_fields",
      `usage present in ${usageRecords} messages of ${path}, but not a single known field ` +
        `(${USAGE_FIELDS.map(([w]) => w).join(", ")}); usage not read`,
      "the transcript format changed; fill in usage with manual flags",
    );
  }
  const lost = USAGE_FIELDS.filter(([wire]) => !seenFields.has(wire)).map(([w]) => w);
  if (lost.length > 0) {
    throw new TranscriptError(
      "transcript.missing_field",
      `field ${lost.join(", ")} never appears in transcript ${path}; ` +
        "silently recording zero for it would understate the cost",
      "the transcript format changed; fill in usage with manual flags",
    );
  }

  const totals: Record<TotalsKey, number> = {
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
  };
  for (const group of groups.values()) {
    for (const [, key] of USAGE_FIELDS) {
      totals[key] = addExact(totals[key], group[key] ?? 0, key);
    }
  }
  const sum = totals.tokensIn + totals.tokensOut + totals.tokensCacheRead + totals.tokensCacheWrite;
  if (sum === 0) {
    throw new TranscriptError(
      "transcript.no_tokens",
      `${path}: ${groups.size} model responses parsed, but total usage is 0; ` +
        "a real session never looks like this — nothing to read",
      "the transcript format changed; fill in usage with manual flags",
    );
  }

  const base = path.split("/").pop() ?? path;
  return {
    path,
    sessionId: base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : null,
    ...totals,
    responses: groups.size,
    usageRecords,
    records,
    startedAt,
    endedAt,
    models: [...models].sort(),
  };
}

// ---------------------------------------------------------------------------
// Где лежат стенограммы и какая из них чья
// ---------------------------------------------------------------------------

/** Тот же слаг, что делает Claude Code: путь проекта с '/' → '-'. */
export function transcriptDir(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env["MYC_TRANSCRIPT_DIR"];
  if (override !== undefined && override.trim() !== "") return override;
  return join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
}

function requireDir(dir: string): void {
  if (!existsSync(dir)) {
    throw new TranscriptError(
      "transcript.dir_missing",
      `no transcript directory: ${dir}`,
      "give a file with --from-transcript or a directory with $MYC_TRANSCRIPT_DIR",
    );
  }
}

/** Файл сессии по её uuid. Нет такого — отказ, а не пустой расход. */
export function findSessionTranscript(dir: string, sessionId: string): string {
  requireDir(dir);
  const id = sessionId.endsWith(".jsonl") ? sessionId.slice(0, -".jsonl".length) : sessionId;
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) {
    throw new TranscriptError(
      "notfound.session",
      `session "${id}" not found in ${dir}`,
      "myc attempt finish … --from-transcript <file>",
    );
  }
  return path;
}

/** Строка брифа, по которой сессия исполнителя опознаётся в стенограмме. */
export function taskNeedle(taskId: string): string {
  return `Задача myc: ${taskId}`;
}

/**
 * Сессии, работавшие над задачей: бриф начинается строкой
 * `Задача myc: <id>`, и она попадает в первое сообщение сессии. Сессия
 * координатора содержит ту же строку (он бриф и писал), поэтому
 * исключается по своему uuid — `exclude`.
 *
 * Порядок — по времени последней записи: первая попытка раньше переделки.
 */
export function findTaskTranscripts(
  dir: string,
  taskId: string,
  options: { readonly exclude?: string } = {},
): string[] {
  requireDir(dir);
  const needle = taskNeedle(taskId);
  const excludeRaw = options.exclude?.replace(/\.jsonl$/, "");
  const names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));

  // `exclude` принимается ПРЕФИКСОМ: uuid сессии длинный, и набирать его
  // целиком руками — приглашение к опечатке. Но промах и неоднозначность —
  // ОТКАЗ, а не тихое «никого не исключили»: невключённая сессия координатора
  // добавляет к расходу задачи весь его день (замерено: 1.2 млрд чтений кеша
  // против 20 млн у агента), то есть ответ был бы не приблизительным, а
  // бессмысленным — и молча.
  let exclude: string | undefined;
  if (excludeRaw !== undefined && excludeRaw !== "") {
    const hits = names.filter((n) => n.slice(0, -".jsonl".length).startsWith(excludeRaw));
    if (hits.length === 0) {
      throw new TranscriptError(
        "transcript.exclude_miss",
        `nothing to exclude: no transcript in ${dir} starts with '${excludeRaw}'`,
        "check the session uuid; without the exclusion another session's usage gets counted",
      );
    }
    if (hits.length > 1) {
      throw new TranscriptError(
        "transcript.exclude_ambiguous",
        `'${excludeRaw}' matches ${hits.length} transcripts: ${hits.join(", ")}`,
        "extend the uuid until it is unambiguous",
      );
    }
    exclude = hits[0]!.slice(0, -".jsonl".length);
  }

  const out: string[] = [];
  for (const name of names) {
    if (exclude !== undefined && name.slice(0, -".jsonl".length) === exclude) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes(needle)) out.push(path);
  }
  return out.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}
