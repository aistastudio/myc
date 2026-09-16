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

export interface ReadTranscriptOptions {
  /**
   * Учитывать только записи с `timestamp` не позже этого момента (unix ms).
   * Нужен пересчёту уже закрытой попытки: сессия исполнителя могла работать
   * и после приёмки (тот же терминал получил следующую задачу), а финиш читал
   * стенограмму такой, какой она была В МОМЕНТ финиша. Запись без
   * `timestamp` учитывается: время ей не приписать, а usage у неё не бывает.
   */
  readonly until?: number;
}

/** Время записи для среза `until`; нечитаемое — `undefined` (запись учитывается). */
function recordTime(rec: Record<string, unknown>): number | undefined {
  const ts = rec["timestamp"];
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Расход одной стенограммы. Бросает TranscriptError на любом расхождении
 * с ожидаемым форматом: тихого нуля здесь быть не может.
 *
 * ЦЕНА. Файл читается целиком: 96 МБ стенограммы координатора — 160 мс
 * (замер 2026-09-16, три прогона 177/161/160 мс). Автоматический расход
 * такую стенограмму больше не читает вовсе (сессия без диспетчера — не
 * исполнитель, attempt.ts), а стенограммы исполнителей — единицы мегабайт.
 * Потоковый разбор или отсев строк без `"usage"` сэкономили бы доли
 * секунды ценой второго, неточного пути подсчёта `records`, `startedAt` и
 * `endedAt` — не взято.
 */
export function readTranscriptUsage(path: string, options: ReadTranscriptOptions = {}): TranscriptUsage {
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
    if (options.until !== undefined) {
      const at = recordTime(rec);
      if (at !== undefined && at > options.until) continue;
    }
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

/**
 * Был ли расход `totals` прочитан из ЭТОЙ стенограммы — когда-нибудь, на
 * каком-то её префиксе. Нужен пересчёту (memory-1s8dcfkfz20r): доказать, что
 * записанный у попытки расход взят из сессии координатора, а не просто
 * похож на неё.
 *
 * ПОЧЕМУ ПРЕФИКС, А НЕ СРЕЗ ПО ВРЕМЕНИ ФИНИША. Финиш читал файл таким, каким
 * тот был в момент чтения, а ответ, чей вызов инструмента и запустил
 * `myc close`, в файл ещё не лёг: его записи пишутся позже, но с отметкой
 * времени ДО финиша. Замер на копии базы 2026-09-16: у att_696c6767c557
 * срез по finished_at больше записанного ровно на один ответ (+2 in, +837
 * out, +816 747 чтений кеша), а префикс, совпадающий до токена по всем
 * четырём полям, есть. Совпадение четырёх сумм по префиксу случайным не
 * бывает, и файл стенограммы только дописывается — префикс, который видел
 * финиш, в нём остался.
 *
 * Суммирование то же, что у readTranscriptUsage (склейка по message.id,
 * максимум поля по группе); записи, которые тот отверг бы, здесь просто
 * пропускаются — это сверка, а не чтение расхода. `null` — ни один префикс
 * не дал ровно этих чисел.
 */
export function findUsagePrefix(
  path: string,
  totals: TranscriptTotals,
): { readonly records: number; readonly at: string | null } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const same = (t: Record<TotalsKey, number>): boolean =>
    t.tokensIn === totals.tokensIn &&
    t.tokensOut === totals.tokensOut &&
    t.tokensCacheRead === totals.tokensCacheRead &&
    t.tokensCacheWrite === totals.tokensCacheWrite;
  const running: Record<TotalsKey, number> = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
  if (same(running)) return { records: 0, at: null };
  const groups = new Map<string, Partial<Record<TotalsKey, number>>>();
  let records = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(rec)) continue;
    records += 1;
    const msg = rec["message"];
    if (!isRecord(msg)) continue;
    const usage = msg["usage"];
    if (!isRecord(usage)) continue;
    const msgId = msg["id"];
    const reqId = rec["requestId"];
    const key = typeof msgId === "string" && msgId !== "" ? msgId : typeof reqId === "string" && reqId !== "" ? reqId : undefined;
    if (key === undefined) continue;
    const group = groups.get(key) ?? {};
    for (const [wire, field] of USAGE_FIELDS) {
      const v = usage[wire];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) continue;
      const prev = group[field] ?? 0;
      if (v > prev) {
        running[field] += v - prev;
        group[field] = v;
      }
    }
    groups.set(key, group);
    if (same(running)) {
      const ts = rec["timestamp"];
      return { records, at: typeof ts === "string" ? ts : null };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Где лежат стенограммы и какая из них чья
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Каталог, в котором Claude Code держит каталоги проектов:
 * `$CLAUDE_CONFIG_DIR/projects`, по умолчанию `~/.claude/projects`.
 */
export function transcriptRoot(env: Env = process.env): string {
  const config = env["CLAUDE_CONFIG_DIR"];
  return join(config !== undefined && config.trim() !== "" ? config : join(homedir(), ".claude"), "projects");
}

/**
 * Тот же слаг, что делает Claude Code: в пути проекта всё, кроме букв и
 * цифр, → '-'. Не только '/': worktree из `.claude/worktrees/x` лежит в
 * `…--claude-worktrees-x` (проверено по ~/.claude/projects 2026-09-16), и
 * прежний слаг «'/' → '-'» указывал для такого агента в несуществующий
 * каталог.
 */
export function transcriptDir(cwd: string, env: Env = process.env): string {
  const override = env["MYC_TRANSCRIPT_DIR"];
  if (override !== undefined && override.trim() !== "") return override;
  return join(transcriptRoot(env), cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * Стенограмма сессии по её uuid — где бы ни лежал каталог её проекта.
 *
 * Каталог стенограммы — это каталог, где работал ИСПОЛНИТЕЛЬ (его worktree,
 * вложенный репозиторий), а закрывает попытку обычно координатор из своего
 * каталога. Поиск только в `transcriptDir(cwd)` финиширующего поэтому
 * отвечал `notfound.session` на каждую попытку агента из worktree. uuid
 * сессии уникален на машине, поэтому после быстрого пути (каталог `cwd`)
 * смотрим `<uuid>.jsonl` в каждом каталоге проектов: ~170 stat, миллисекунды.
 *
 * `$MYC_TRANSCRIPT_DIR` — явный каталог: тогда только он, как и прежде.
 */
export function locateSessionTranscript(sessionId: string, cwd: string, env: Env = process.env): string {
  const override = env["MYC_TRANSCRIPT_DIR"];
  if (override !== undefined && override.trim() !== "") return findSessionTranscript(override, sessionId);
  const id = sessionId.endsWith(".jsonl") ? sessionId.slice(0, -".jsonl".length) : sessionId;
  const near = join(transcriptDir(cwd, env), `${id}.jsonl`);
  if (existsSync(near)) return near;
  const root = transcriptRoot(env);
  requireDir(root);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch (e) {
    throw new TranscriptError(
      "transcript.unreadable",
      `transcript directory ${root} is unreadable: ${(e as Error).message}`,
    );
  }
  for (const d of dirs.sort()) {
    const path = join(root, d, `${id}.jsonl`);
    if (existsSync(path)) return path;
  }
  throw new TranscriptError(
    "notfound.session",
    `session "${id}" not found in any project directory under ${root}`,
    "myc attempt finish … --from-transcript <file>",
  );
}

/** Сверка моделей стенограммы с моделью попытки. */
export interface TranscriptModelCheck {
  /** Все модели стенограммы (без служебных `<…>`) принадлежат модели попытки. */
  readonly ok: boolean;
  /** Модели стенограммы без служебных. */
  readonly seen: readonly string[];
  /** Те из них, что модели попытки не принадлежат. */
  readonly foreign: readonly string[];
}

function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}

function tokensWithin(needle: readonly string[], hay: ReadonlySet<string>): boolean {
  return needle.length > 0 && needle.every((t) => hay.has(t));
}

/**
 * Принадлежат ли модели стенограммы модели попытки. Имя модели в
 * стенограмме — провайдерское (`claude-sonnet-5`, `claude-opus-4-5-20251101`),
 * в ростере — своё (`sonnet`, семейство `claude-sonnet`). Совпадением
 * считается, когда все слова семейства (или последнего сегмента id модели)
 * есть среди слов имени из стенограммы: `claude-sonnet` ⊂ `claude-sonnet-5`,
 * но не ⊂ `claude-opus-5`.
 *
 * Служебная `<synthetic>` (так Claude Code помечает ответы, которых модель
 * не давала) в сверке не участвует. Стенограмма без единой модели — `ok:
 * false`: проверить, чей это расход, нечем.
 *
 * Зачем: у att_6289a214d584 записан sonnet, а в стенограмме только opus —
 * её токены легли по ставкам sonnet ($553.37 против медианы $7.78).
 */
export function checkTranscriptModels(
  models: readonly string[],
  attempt: { readonly modelId: string; readonly family: string },
): TranscriptModelCheck {
  const seen = models.filter((m) => !m.startsWith("<"));
  const family = nameTokens(attempt.family);
  const tail = nameTokens(attempt.modelId.split("/").pop() ?? attempt.modelId);
  const foreign = seen.filter((m) => {
    const hay = new Set(nameTokens(m));
    return !tokensWithin(family, hay) && !tokensWithin(tail, hay);
  });
  return { ok: seen.length > 0 && foreign.length === 0, seen, foreign };
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
