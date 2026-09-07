/**
 * Разбор транскрипта агентской сессии (§6.2, шаги 1 и 4).
 *
 * Хук pre-compact вызывается ровно в тот момент, когда контекст гарантированно
 * теряется (D11), и у него на всё 8000 мс. Поэтому здесь нет ни одной попытки
 * «понять» текст: только один проход по строкам, регулярки на данных и жёсткие
 * потолки. Всё, что требует LLM, уходит в фоновую дистилляцию.
 *
 * Форматы транскриптов у хостов разные и меняются между версиями, поэтому
 * парсер намеренно терпимый: он пробует JSONL (Claude Code, Codex), а всё, что
 * не разобралось, не выбрасывает, а кладёт как текстовый ход. Потеря хода из-за
 * незнакомой схемы была бы ровно той тихой деградацией, которую запрещает И2.
 */

/** Роли, которые мы различаем; всё незнакомое схлопывается в "system". */
export type TurnRole = "user" | "assistant" | "tool" | "system";

export interface Turn {
  readonly role: TurnRole;
  /** Всё содержимое хода: проза, маркеры инструментов, результаты вызовов. */
  readonly text: string;
  /**
   * Только собственная речь модели или человека — блоки `type:"text"`.
   * Результаты инструментов сюда НЕ входят, и это принципиально: агент,
   * читающий проектную документацию, получает её текст как tool_result, и
   * без этого разделения «Берём: ready-очередь» из чужого файла попадает в
   * РЕШЕНО как решение, принятое в этой сессии.
   */
  readonly prose: string;
}

export interface Transcript {
  readonly format: "jsonl" | "text";
  readonly turns: readonly Turn[];
  /** Пути файлов из tool_use, с повторами — счётчик правок считается по ним. */
  readonly toolFiles: readonly string[];
  readonly bytes: number;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly model?: string;
  /** Транскрипт длиннее потолка разбора: сырьё сохранено целиком, разбор — нет. */
  readonly truncated: boolean;
}

/**
 * Потолок разбора. Сырой эпизод пишется целиком всегда; ограничение касается
 * только извлечения сигналов, где стоимость линейна по объёму, а польза после
 * первых мегабайт практически нулевая.
 */
const PARSE_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_TURNS = 5000;
/** Один ход длиннее этого режется: в сигналы всё равно попадают первые строки. */
const MAX_TURN_CHARS = 20_000;

function asRole(value: unknown): TurnRole {
  return value === "user" || value === "assistant" || value === "tool" || value === "system"
    ? value
    : "system";
}

function pushFile(out: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const path = value.trim();
  if (path.length === 0 || path.length > 512) return;
  out.push(path);
}

/** Инструменты, которые МЕНЯЮТ файл: только их пути идут в счётчик правок. */
const EDIT_TOOLS = /^(?:write|edit|multiedit|notebookedit|patch|apply_patch|str_replace\w*)$/i;

/** Пути из входа инструмента; имена полей — объединение Claude Code и opencode. */
function collectToolFiles(input: unknown, out: string[]): void {
  if (input === null || typeof input !== "object") return;
  const rec = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "notebook_path", "notebookPath"]) {
    pushFile(out, rec[key]);
  }
  const edits = rec["edits"];
  if (Array.isArray(edits)) for (const e of edits) collectToolFiles(e, out);
}

/**
 * Текст из `message.content`: строка либо массив блоков. Блоки tool_use дают
 * пути файлов (они же кандидаты якорей), tool_result — текст результата.
 */
interface Content {
  readonly all: string;
  readonly prose: string;
}

function contentText(content: unknown, files: string[]): Content {
  if (typeof content === "string") return { all: content, prose: content };
  if (!Array.isArray(content)) return { all: "", prose: "" };
  const parts: string[] = [];
  const prose: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      prose.push(block);
      continue;
    }
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b["type"];
    if (type === "text" && typeof b["text"] === "string") {
      parts.push(b["text"]);
      prose.push(b["text"]);
    } else if (type === "tool_use") {
      const name = typeof b["name"] === "string" ? b["name"] : "tool";
      // Файл считается тронутым, только если его ПРАВИЛИ. Иначе счётчик
      // «правлен 24×» набивает Read, и в пакет вместо двух реально изменённых
      // файлов попадают семнадцать прочитанных.
      if (EDIT_TOOLS.test(name)) collectToolFiles(b["input"], files);
      const cmd = (b["input"] as Record<string, unknown> | undefined)?.["command"];
      parts.push(typeof cmd === "string" ? `$ ${cmd}` : `[${name}]`);
    } else if (type === "tool_result") {
      const c = b["content"];
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) parts.push(contentText(c, files).all);
    }
  }
  return { all: parts.join("\n"), prose: prose.join("\n") };
}

interface Meta {
  cwd?: string;
  sessionId?: string;
  model?: string;
}

function readMeta(rec: Record<string, unknown>, meta: Meta): void {
  if (meta.cwd === undefined && typeof rec["cwd"] === "string") meta.cwd = rec["cwd"];
  if (meta.sessionId === undefined && typeof rec["sessionId"] === "string") {
    meta.sessionId = rec["sessionId"];
  }
  if (meta.sessionId === undefined && typeof rec["session_id"] === "string") {
    meta.sessionId = rec["session_id"];
  }
  const message = rec["message"];
  if (meta.model === undefined && message !== null && typeof message === "object") {
    const m = (message as Record<string, unknown>)["model"];
    if (typeof m === "string") meta.model = m;
  }
}

/** Один ход из JSONL-строки; null — строка не наша (summary, meta, мусор). */
function lineToTurn(rec: Record<string, unknown>, files: string[]): Turn | null {
  const message = rec["message"];
  const source = message !== null && typeof message === "object" ? (message as Record<string, unknown>) : null;
  const content = source !== null ? contentText(source["content"], files) : contentText(rec["content"] ?? rec["text"], files);
  if (content.all.trim().length === 0) return null;
  const role = asRole((source?.["role"] ?? rec["role"] ?? rec["type"]) as unknown);
  return {
    role,
    text: content.all.slice(0, MAX_TURN_CHARS),
    prose: content.prose.slice(0, MAX_TURN_CHARS),
  };
}

export function parseTranscript(raw: string): Transcript {
  const bytes = Buffer.byteLength(raw, "utf8");
  const head = bytes > PARSE_LIMIT_BYTES ? raw.slice(0, PARSE_LIMIT_BYTES) : raw;
  const truncated = head.length < raw.length;

  const turns: Turn[] = [];
  const files: string[] = [];
  const meta: Meta = {};
  let jsonLines = 0;
  let totalLines = 0;

  for (const line of head.split("\n")) {
    if (turns.length >= MAX_TURNS) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    totalLines++;
    if (trimmed.startsWith("{")) {
      try {
        const rec = JSON.parse(trimmed) as unknown;
        if (rec !== null && typeof rec === "object") {
          jsonLines++;
          const asRec = rec as Record<string, unknown>;
          readMeta(asRec, meta);
          const turn = lineToTurn(asRec, files);
          if (turn) turns.push(turn);
          continue;
        }
      } catch {
        // не JSON — падаем в текстовую ветку ниже
      }
    }
    const plain = trimmed.slice(0, MAX_TURN_CHARS);
    turns.push({ role: "system", text: plain, prose: plain });
  }

  // Больше половины строк разобрались как JSON ⇒ считаем формат структурным.
  const format = totalLines > 0 && jsonLines * 2 >= totalLines ? "jsonl" : "text";
  return {
    format,
    turns,
    toolFiles: files,
    bytes,
    truncated,
    ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(meta.model !== undefined ? { model: meta.model } : {}),
  };
}

// ---------------------------------------------------------------------------
// Сигналы: дешёвая эвристическая экстракция без LLM (§6.2, шаг 4)
// ---------------------------------------------------------------------------

/**
 * Маркеры решения. Список — данные, а не код: он будет расти от языка к языку,
 * и каждая строка здесь дешевле любой попытки «понять» текст моделью.
 */
/**
 * Границы слова заданы через `\p{L}`, а не `\b`: `\b` в JS считает словом
 * только ASCII, поэтому «Решили:» ему границей не является и ни одно русское
 * решение не находится. Эту ошибку легко не заметить — детектор просто молча
 * возвращает пустой список.
 */
const DECISION_RE =
  /(?<![\p{L}\p{N}])(?:реш(?:или|ено|ил|аем)|выбрал[иа]|выбираем|берём|берем|остановились на|оставляем|отказал(?:ись|ся)|отказываемся|не тянем|договорились|потому что|decided|we chose|chose|going with|settled on)(?![\p{L}\p{N}])/iu;

const OPEN_RE =
  /(?<![\p{L}\p{N}])(?:TODO|FIXME|не прогнан|не прогоняли|не сделан|не доделан|осталось|остаётся|остается|падает|не работает|надо ещё|надо еще|открытый вопрос|open question|still failing|blocked on)(?![\p{L}\p{N}])/iu;

/**
 * Вызовы myc из транскрипта — уже готовые атомы, их не надо угадывать. Но
 * искать их можно только в КОМАНДНОМ контексте: строка должна начинаться с
 * команды или идти после `$`/`&&`/`;`. Иначе документация проекта, приехавшая
 * в транскрипт как tool_result, отдаёт свой собственный список команд, и
 * «myc close` — закрыть» из таблицы §3 становится решением этой сессии.
 */
const MYC_CALL_RE =
  /(?:^|\$\s|&&\s|;\s|\|\s)(myc\s+(?:remember|absorb|close|link|create|task|bug|epic|claim|update|dep)\s+[^\n`]{1,200})/gim;

/** Заголовки диффов — второй источник имён файлов помимо tool_use. */
const DIFF_FILE_RE = /^(?:\+\+\+|---)\s+[ab]\/(\S+)/gm;

export interface FileTouch {
  readonly path: string;
  readonly count: number;
}

export interface Signals {
  readonly decisions: readonly string[];
  readonly mycCalls: readonly string[];
  readonly files: readonly FileTouch[];
  readonly open: readonly string[];
}

const MAX_DECISIONS = 40;
const MAX_OPEN = 20;
const MAX_FILES = 30;
const MAX_MYC_CALLS = 40;
const MAX_LINE_CHARS = 240;

function cleanLine(line: string): string {
  const text = line
    .replace(/^[\s>#*\-•·]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

/** Ключ дедупликации: без регистра и пунктуации — один вывод не должен войти дважды. */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

class Bag {
  #seen = new Set<string>();
  #items: string[] = [];
  constructor(private readonly limit: number) {}
  add(text: string): void {
    if (this.#items.length >= this.limit) return;
    const clean = cleanLine(text);
    if (clean.length < 8) return;
    const key = dedupeKey(clean);
    if (key.length === 0 || this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#items.push(clean);
  }
  get items(): string[] {
    return this.#items;
  }
}

export function extractSignals(transcript: Transcript): Signals {
  const decisions = new Bag(MAX_DECISIONS);
  const open = new Bag(MAX_OPEN);
  const mycCalls = new Bag(MAX_MYC_CALLS);
  const fileCounts = new Map<string, number>();

  for (const path of transcript.toolFiles) {
    fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
  }

  for (const turn of transcript.turns) {
    for (const match of turn.text.matchAll(MYC_CALL_RE)) {
      if (match[1] !== undefined) mycCalls.add(match[1]);
    }
    for (const match of turn.text.matchAll(DIFF_FILE_RE)) {
      const path = match[1];
      if (path !== undefined) fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
    }
    // Решения ищем ТОЛЬКО в собственной речи: вывод инструментов — чужие логи
    // и чужие документы, и решением этой сессии он не является.
    if (turn.role !== "assistant" && turn.role !== "user") continue;
    for (const line of turn.prose.split("\n")) {
      if (line.length < 8) continue;
      // Строка `$ cmd` — это команда, а не рассуждение; вызовы myc из неё уже
      // сняты выше, а всё прочее в РЕШЕНО только шумит.
      if (line.startsWith("$ ")) continue;
      if (DECISION_RE.test(line)) decisions.add(line);
      else if (OPEN_RE.test(line)) open.add(line);
    }
  }

  const files = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_FILES)
    .map(([path, count]) => ({ path, count }));

  return { decisions: decisions.items, open: open.items, mycCalls: mycCalls.items, files };
}
