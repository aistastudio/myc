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
      `сумма ${field} вышла за точные целые (${sum}); прочитанному числу верить нельзя`,
    );
  }
  return sum;
}

function requireCount(value: unknown, field: string, line: number, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TranscriptError(
      "transcript.bad_field",
      `${path}:${line}: usage.${field} = ${JSON.stringify(value)} — не целое число ≥ 0; ` +
        "формат стенограммы не тот, расход не прочитан",
      "перепроверьте формат или заполните расход флагами --tokens-in/--tokens-out",
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
      `стенограммы нет: ${path}`,
      "myc attempt finish … --from-session <uuid> или флаги расхода вручную",
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new TranscriptError(
      "transcript.unreadable",
      `стенограмма ${path} не читается: ${(e as Error).message}`,
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
        `${path}:${i + 1}: у записи с usage нет ни message.id, ни requestId; ` +
          "склеить копии одного ответа нечем, сумма была бы завышена",
        "формат стенограммы сменился — заполните расход флагами вручную",
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
      `в стенограмме ${path} не разобрано ни одной записи`,
    );
  }
  if (usageRecords === 0) {
    throw new TranscriptError(
      "transcript.no_usage",
      `ни в одном из ${records} сообщений ${path} нет message.usage; ` +
        "расход не прочитан — это отказ, а не ноль",
      "формат стенограммы сменился; заполните расход флагами --tokens-in/--tokens-out",
    );
  }
  if (recognized === 0) {
    throw new TranscriptError(
      "transcript.no_fields",
      `usage есть в ${usageRecords} сообщениях ${path}, но ни одного знакомого поля ` +
        `(${USAGE_FIELDS.map(([w]) => w).join(", ")}); расход не прочитан`,
      "формат стенограммы сменился; заполните расход флагами вручную",
    );
  }
  const lost = USAGE_FIELDS.filter(([wire]) => !seenFields.has(wire)).map(([w]) => w);
  if (lost.length > 0) {
    throw new TranscriptError(
      "transcript.missing_field",
      `в стенограмме ${path} ни разу не встретилось поле ${lost.join(", ")}; ` +
        "молча записать по нему ноль значит занизить стоимость",
      "формат стенограммы сменился; заполните расход флагами вручную",
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
      `в ${path} разобрано ${groups.size} ответов модели, а суммарный расход 0; ` +
        "у настоящей сессии так не бывает — читать нечего",
      "формат стенограммы сменился; заполните расход флагами вручную",
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
      `каталога стенограмм нет: ${dir}`,
      "укажите файл через --from-transcript или каталог через $MYC_TRANSCRIPT_DIR",
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
      `сессии "${id}" нет в ${dir}`,
      "myc attempt finish … --from-transcript <файл>",
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
        `исключать нечего: в ${dir} нет стенограммы, начинающейся с '${excludeRaw}'`,
        "проверьте uuid сессии; без исключения в расход попадёт чужая сессия",
      );
    }
    if (hits.length > 1) {
      throw new TranscriptError(
        "transcript.exclude_ambiguous",
        `'${excludeRaw}' подходит ${hits.length} стенограммам: ${hits.join(", ")}`,
        "уточните uuid до однозначного",
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
