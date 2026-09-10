/**
 * Сколько обращений к myc в ТЕКУЩЕЙ сессии Claude Code было полезным — и из
 * скольких («7 из 9» честнее, чем «7»).
 *
 * ИСТОЧНИК — ТРАНСКРИПТ ХОСТА, а не учёт на стороне myc. Орка регулярно
 * запускает несколько агентов Claude в одном рабочем дереве одновременно, и
 * счётчик сессии A не имеет права включать вызовы сессии B. Транскрипт —
 * это файл ОДНОЙ сессии по построению: его путь приходит от хоста во вводе
 * строки (`transcript_path`), и вызовы другой сессии в нём не появятся ни при
 * каком порядке процессов. Учёт внутри myc требовал бы ключа сессии у каждого
 * вызова: у MCP-сервера его нет вовсе (сервер один на сессию, но myc об этом
 * не знает), у CLI через Bash — только если хост его передаёт, а доказать это
 * для каждого пути вызова нечем. Кроме того, транскрипт хранит ИСХОД каждого
 * вызова так, как его увидел агент: `is_error`, `mcpMeta.structuredContent`,
 * вывод Bash — классифицировать есть по чему.
 *
 * ФОРМА ТРАНСКРИПТА проверена на живых файлах Claude Code 2.1.267 (эта же
 * сессия звала mcp__myc__* и ./dist/myc нарочно):
 *   - вызов: строка `assistant`, блок `{type:"tool_use", id, name, input}`;
 *   - исход: строка `user`, блок `{type:"tool_result", tool_use_id, content,
 *     is_error?}`; `is_error` есть только при ошибке;
 *   - у MCP рядом с блоком — `mcpMeta.structuredContent` (тот же объект, что
 *     отдал сервер myc), у Bash — `toolUseResult: {stdout, stderr,
 *     interrupted}` при коде 0 и строка `"Error: Exit code N…"` при ненулевом;
 *   - вызовы субагентов лежат рядом: `<сессия>/subagents/agent-*.jsonl`.
 *
 * ЧТЕНИЕ ИНКРЕМЕНТАЛЬНОЕ. Строку статуса хост зовёт на каждую отрисовку, а
 * транскрипт длинной сессии — десятки мегабайт (62 МБ у координатора этого
 * проекта). Курсор — байтовое смещение конца последней ЦЕЛОЙ строки, по файлу,
 * в кеше на сессию; дочитывается только новое. За одну отрисовку читается не
 * больше MAX_SCAN_BYTES: первый проход по огромному транскрипту растягивается
 * на несколько отрисовок, а не делает одну из них медленной, и строка честно
 * помечает, что счёт ещё догоняет. Строки фильтруются по байтам (memmem) до
 * всякого JSON.parse: разбирается только то, где есть вызов myc или исход
 * ожидаемого вызова.
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { registerAll } from "./register.ts";
import { Registry } from "./registry.ts";

/** Исход одного обращения. Полезно только `useful`. */
export type CallOutcome = "useful" | "empty" | "refusal" | "error";

export interface CallCounts {
  total: number;
  useful: number;
  empty: number;
  refusal: number;
  error: number;
}

/** Вызов, чей исход ещё не пришёл. */
export interface PendingCall {
  readonly via: "mcp" | "cli";
  /** Команда myc: `recall`, `code search`, `update`… Пусто — `myc --help` и т.п. */
  readonly cmd: string;
}

export interface FileCursor {
  /** Байт после последней целой строки, которую мы разобрали. */
  offset: number;
  /** Инод: файл подменили (ротация, пересоздание) — считаем заново. */
  ino: number;
  pending: Record<string, PendingCall>;
  counts: CallCounts;
}

/**
 * Версия ЛОГИКИ подсчёта — распознавания вызова myc в команде и классификации
 * исхода. Состояние сессии хранит курсор и счётчики, накопленные ЭТОЙ
 * логикой; продолжать их другой нельзя: исправленный разбор heredoc, найдя
 * в кеше состояние прошлой сборки, показывал «полезных 687 из 741» вместо
 * честных 588 из 641 — сотня ложных срабатываний старой логики переехала в
 * новую. Тот же класс, что memory-bn4cs836df52 (версия в отпечатке кеша).
 *
 * Поднимать при ЛЮБОМ изменении поведения. Забыть не даст тест: он сворачивает
 * классификацию фиксированного набора образцов в отпечаток и держит историю
 * «версия → отпечаток» (statusline-session.test.ts, «отпечаток поведения»).
 *
 * 1 — первая сдача; 2 — тела heredoc, комментарии и сверка подкоманды с реестром;
 * 3 — английские подвалы шести команд рядом с русскими (вывод CLI переведён).
 */
export const CLASSIFIER_VERSION = 3;

export interface SessionState {
  readonly v: 1;
  /** Какой логикой посчитано; нет поля — первая версия (до её появления). */
  readonly classifier?: number;
  /** Какой сборкой: сменилась сборка — пересчёт, ему одна отрисовка на сессию. */
  readonly build?: string;
  readonly transcript: string;
  files: Record<string, FileCursor>;
}

export interface ScanReport {
  readonly counts: CallCounts;
  /** Вызовов без исхода (идут прямо сейчас). */
  readonly pending: number;
  readonly readBytes: number;
  /** Сколько байт осталось непрочитанными из-за потолка отрисовки. */
  readonly behindBytes: number;
  readonly files: number;
  readonly missing: boolean;
  readonly tookMs: number;
}

/**
 * Потолок чтения за одну отрисовку. 8 МБ на этой машине — ~15 мс фильтра по
 * байтам; транскрипт в 20 МБ догоняется за три отрисовки, и ни одна не
 * выходит из бюджета.
 */
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Сколько вызовов без исхода держим: оборванный вызов не должен копиться вечно. */
const MAX_PENDING = 64;

const MCP_PREFIX = "mcp__myc__";
const NEEDLE_TOOL_USE = Buffer.from('"tool_use"');
const NEEDLE_MCP = Buffer.from(MCP_PREFIX);
const NEEDLE_MYC = Buffer.from("myc");
const NEEDLE_RESULT = Buffer.from('"tool_result"');

export function emptyCounts(): CallCounts {
  return { total: 0, useful: 0, empty: 0, refusal: 0, error: 0 };
}

// ---------------------------------------------------------------------------
// Распознавание вызова myc в команде Bash
// ---------------------------------------------------------------------------

/**
 * Простые команды строки оболочки: разбиение по `; && || | & ( ) { } \``,
 * `$(` и переводу строки ВНЕ кавычек, слова — без кавычек. Не полный разбор
 * sh, а ровно столько, чтобы `git commit -m "…; myc show"` не считался
 * вызовом myc, а `cd x && MYC_DRAIN=0 ./dist/myc ready` — считался.
 *
 * ТЕЛО HEREDOC — НЕ КОМАНДЫ. `cat > spec.md <<'EOF'` … `EOF`: строки между
 * оператором и терминатором — данные, и строка текста «myc стоит в горячем
 * пути» не вызов myc. На транскрипте координатора (4231 команда Bash) без
 * этого правила 100 «вызовов» из 734 были строками прозы в heredoc. Тело
 * начинается со строки ПОСЛЕ оператора (сама строка с `<<EOF | ./dist/myc
 * import -` — команды) и кончается строкой, равной слову; у `<<-` перед
 * терминатором и в теле допустимы табы. Так же пропускаются комментарии
 * (`# …` до конца строки) и арифметика `$(( a << 2 ))`.
 */
export function shellSegments(command: string): string[][] {
  const segs: string[][] = [];
  let cur: string[] = [];
  let tok = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  /** Heredoc'и, объявленные на текущей строке: тела идут после её конца. */
  const pending: { word: string; tabs: boolean }[] = [];
  const n = command.length;
  const pushTok = (): void => {
    if (has) cur.push(tok);
    tok = "";
    has = false;
  };
  const pushSeg = (): void => {
    pushTok();
    if (cur.length > 0) segs.push(cur);
    cur = [];
  };
  for (let i = 0; i < n; i++) {
    const c = command[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < n) tok += command[++i];
      else tok += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      // `\` + перевод строки — продолжение строки, не символ.
      if (command[i + 1] !== "\n") tok += command[i + 1];
      i++;
      has = has || command[i] !== "\n";
      continue;
    }
    if (c === " " || c === "\t") {
      pushTok();
      continue;
    }
    if (c === "#" && !has) {
      // Комментарий — только в начале слова, как у sh.
      const nl = command.indexOf("\n", i);
      i = (nl === -1 ? n : nl) - 1;
      continue;
    }
    if (c === "\n") {
      pushSeg();
      if (pending.length > 0) {
        i = skipHeredocBodies(command, i + 1, pending) - 1;
        pending.length = 0;
      }
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        // here-string `<<<` — слово-аргумент, тела нет.
        tok += "<<<";
        has = true;
        i += 2;
        continue;
      }
      pushTok();
      const doc = heredocWord(command, i + 2);
      if (doc.word.length > 0) pending.push({ word: doc.word, tabs: doc.tabs });
      i = doc.end - 1;
      continue;
    }
    if (c === "$" && command[i + 1] === "(" && command[i + 2] === "(") {
      const close = command.indexOf("))", i + 3);
      const stop = close === -1 ? n : close + 2;
      tok += command.slice(i, stop);
      has = true;
      i = stop - 1;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      pushSeg();
      i++;
      continue;
    }
    if (";|&(){}`".includes(c)) {
      pushSeg();
      continue;
    }
    tok += c;
    has = true;
  }
  pushSeg();
  return segs;
}

/**
 * Слово-терминатор heredoc после `<<`: `EOF`, `'EOF'`, `"EOF"`, `\EOF`,
 * `-EOF` (табы), с пробелами перед словом. Кавычки из слова снимаются — так
 * его сравнивает и сам sh.
 */
function heredocWord(s: string, from: number): { word: string; tabs: boolean; end: number } {
  let j = from;
  let tabs = false;
  if (s[j] === "-") {
    tabs = true;
    j++;
  }
  while (s[j] === " " || s[j] === "\t") j++;
  let word = "";
  while (j < s.length) {
    const d = s[j]!;
    if (d === "'" || d === '"') {
      const close = s.indexOf(d, j + 1);
      if (close === -1) {
        word += s.slice(j + 1);
        j = s.length;
        break;
      }
      word += s.slice(j + 1, close);
      j = close + 1;
      continue;
    }
    if (d === "\\" && j + 1 < s.length) {
      word += s[j + 1];
      j += 2;
      continue;
    }
    if (" \t\n;|&()<>".includes(d)) break;
    word += d;
    j++;
  }
  return { word, tabs, end: j };
}

/** Пропустить тела heredoc'ов по порядку; вернуть позицию после последнего терминатора. */
function skipHeredocBodies(s: string, from: number, docs: readonly { word: string; tabs: boolean }[]): number {
  let pos = from;
  for (const d of docs) {
    while (pos < s.length) {
      const nl = s.indexOf("\n", pos);
      const end = nl === -1 ? s.length : nl;
      const line = d.tabs ? s.slice(pos, end).replace(/^\t+/, "") : s.slice(pos, end);
      pos = nl === -1 ? s.length : nl + 1;
      if (line === d.word) break;
    }
  }
  return pos;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Слова перед командой: обёртки и ключевые слова sh (`for …; do myc …`). */
const WRAPPERS = new Set([
  "time", "command", "exec", "nohup", "env", "caffeinate",
  "do", "then", "else", "elif", "if", "while", "until", "!",
]);
const GLOBAL_VALUE_FLAGS = new Set(["-C", "--directory", "--db"]);

function isMycBinary(word: string): boolean {
  const base = word.slice(word.lastIndexOf("/") + 1);
  return base === "myc" || base === "myc.exe";
}

/**
 * Имена команд myc — из того же реестра, что разбирает argv (`registerAll`),
 * а не второй список: разъехались бы молча. Регистрация отложенная, модули
 * команд здесь не грузятся — только имена.
 */
let commandNames: ReadonlySet<string> | null = null;
export function mycCommandNames(): ReadonlySet<string> {
  if (commandNames === null) {
    const registry = new Registry();
    registerAll(registry);
    commandNames = new Set(registry.top.map((c) => c.name));
  }
  return commandNames;
}

/**
 * Первый вызов myc в команде Bash и его подкоманда. Узнаются `myc …`,
 * `./dist/myc …`, путь к `myc` с переменными (`"${CLAUDE_PROJECT_DIR}/dist/myc"`)
 * и запуск из исходников `bun [run] …/cli/src/main.ts …`. Одна команда Bash —
 * одно обращение, сколько бы вызовов myc в ней ни было: хост отдаёт ОДИН код
 * выхода и ОДИН вывод на всю команду, и делить их между вызовами нечем.
 *
 * Обращение — только НАСТОЯЩАЯ подкоманда (имя из реестра) или один `myc` с
 * глобальными флагами (`myc --version`). Второй рубеж после разбора оболочки:
 * где разбор ошибётся, «myc стоит в горячем пути» всё равно не пройдёт.
 */
export function findMycInvocation(
  command: string,
  commands: ReadonlySet<string> = mycCommandNames(),
): { readonly cmd: string } | null {
  for (const seg of shellSegments(command)) {
    let i = 0;
    while (i < seg.length && (ENV_ASSIGN.test(seg[i]!) || WRAPPERS.has(seg[i]!))) i++;
    const head = seg[i];
    if (head === undefined) continue;
    if (!isMycBinary(head)) {
      if (head !== "bun" && !head.endsWith("/bun")) continue;
      let j = i + 1;
      if (seg[j] === "run") j++;
      if (seg[j] === undefined || !/(?:^|\/)cli\/src\/main\.ts$/.test(seg[j]!)) continue;
      i = j;
    }
    const pos: string[] = [];
    for (let k = i + 1; k < seg.length && pos.length < 2; k++) {
      const t = seg[k]!;
      if (GLOBAL_VALUE_FLAGS.has(t)) {
        k++;
        continue;
      }
      if (t.startsWith("-") || /^\d*[<>]/.test(t)) continue;
      pos.push(t);
    }
    const top = pos[0] ?? "";
    if (top !== "" && !commands.has(top)) continue;
    return { cmd: top === "code" && pos[1] !== undefined ? `code ${pos[1]}` : top };
  }
  return null;
}

/** `mcp__myc__myc_code_search` → `code search`, `mcp__myc__myc_recall` → `recall`. */
export function mcpCommand(toolName: string): string {
  const bare = toolName.slice(MCP_PREFIX.length).replace(/^myc_/, "");
  return bare.startsWith("code_") ? `code ${bare.slice(5)}` : bare;
}

// ---------------------------------------------------------------------------
// Классификация исхода — по машинным признакам
// ---------------------------------------------------------------------------

/**
 * Отказ — это «myc понял и отказал»: не то, неверно спросили, нет условий.
 * Остальные пространства кодов (internal, io, timeout…) — ошибка. Оба не
 * полезны; различаются только в разбивке `--json`.
 */
const REFUSAL_NS = new Set(["usage", "notfound", "precond", "conflict", "ws", "denied"]);

// Цвет у ошибки бывает только на TTY, но агенту могли дать и его.
const ANSI = /\x1b\[[0-9;]*m/g;
const FAILURE_LINE = /(?:^|\n)myc: ([a-z]+)\.[a-z0-9_.]+: /;
const FAILURE_ENVELOPE = /(?:^|\n)(\{"ok":false,.*)/;
const OK_ENVELOPE = /(?:^|\n)(\{"ok":true,.*)/;

function outcomeOfCode(code: string): CallOutcome {
  const ns = code.split(".", 1)[0] ?? "";
  return REFUSAL_NS.has(ns) ? "refusal" : "error";
}

/** Отказ/ошибка по строке `myc: <код>: …` или по конверту `{"ok":false…}`. */
export function failureIn(text: string): CallOutcome | null {
  const plain = text.replace(ANSI, "");
  const line = FAILURE_LINE.exec(plain);
  if (line !== null) return outcomeOfCode(`${line[1]}.`);
  const env = FAILURE_ENVELOPE.exec(plain);
  if (env !== null) {
    try {
      const code = (JSON.parse(env[1]!) as { error?: { code?: unknown } }).error?.code;
      return typeof code === "string" ? outcomeOfCode(code) : "error";
    } catch {
      return "error";
    }
  }
  return null;
}

function count(v: unknown): number | undefined {
  if (Array.isArray(v)) return v.length;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Пуст ли результат команды — по счётчикам её `data` (конверт `--json`) или
 * `structuredContent` (MCP: там тот же `data`). `undefined` — у команды нет
 * понятия «пусто» (show, записи): успех без ошибки и есть польза.
 */
export function emptyData(cmd: string, data: unknown): boolean | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const zero = (v: unknown): boolean | undefined => {
    const n = count(v);
    return n === undefined ? undefined : n === 0;
  };
  switch (cmd) {
    case "recall":
    case "search":
    case "list":
      return zero(d["rows"] ?? d["shown"]);
    case "code search":
    case "code grep":
      return zero(d["hits"]);
    case "code symbol":
      return zero(d["defs"]);
    case "callers":
      return zero(d["edges"] ?? d["total_edges"]);
    case "ready":
      // «ready, отдавший задачу»: взятая задача — польза; иначе — непустой список.
      if (d["claimed"] !== undefined && d["claimed"] !== null) return false;
      return zero(d["items"]);
    case "skeleton":
      return zero(d["entries"]);
    case "code map":
      return zero(d["files"]);
    case "prime":
      return d["empty"] === true;
    default:
      return undefined;
  }
}

/**
 * Счётчики человеческого вывода — ЕДИНСТВЕННЫЙ признак пустоты, когда агент
 * не просил `--json`. Это не угадывание по смыслу, а числа из подвалов
 * команд, и каждое сверено тестом с настоящим выводом CLI
 * (statusline-session.test.ts, «подвалы совпадают с живым CLI»): формат
 * поменяется — покраснеет тест, а не молча соврёт строка.
 *
 * Словарь разбора, а не вывод: у каждой команды две формы подвала — русская
 * (транскрипты сессий, начатых до перевода CLI, и старые сборки) и английская
 * (текущий вывод). Русскую не убирать, пока такие транскрипты читаются.
 */
const HUMAN_COUNTERS: Readonly<Record<string, RegExp>> = {
  recall: /^(\d+) (?:из|of) \d+/m,
  search: /^(\d+) (?:из|of) \d+/m,
  list: /^(\d+) (?:из|of) \d+/m,
  ready: /^(\d+) ready\b/m,
  "code search": /^(\d+) (?:файл|file)/m,
  "code grep": /— (\d+) (?:вхожден|occurrence)/,
  callers: /(?:групп|groups) (\d+)/,
};

/** Машинный код пустоты в WARN-строке. */
const EMPTY_WARN = /(?:^|\n)WARN [a-z_]+\.empty: /;

export function humanOutcome(cmd: string, text: string): CallOutcome {
  const plain = text.replace(ANSI, "");
  if (EMPTY_WARN.test(plain)) return "empty";
  const re = HUMAN_COUNTERS[cmd];
  if (re !== undefined) {
    const m = re.exec(plain);
    if (m !== null) return Number(m[1]) === 0 ? "empty" : "useful";
  }
  return "useful";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}

function tryJson(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith("{")) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/** Исход MCP-вызова: `is_error` → код ошибки; иначе счётчики structuredContent. */
export function classifyMcp(
  cmd: string,
  block: { readonly is_error?: unknown; readonly content?: unknown },
  entry: { readonly mcpMeta?: unknown },
): CallOutcome {
  const text = contentText(block.content);
  if (block.is_error === true) return failureIn(text) ?? "error";
  const meta = entry.mcpMeta;
  const structured =
    meta !== null && typeof meta === "object" && "structuredContent" in meta
      ? (meta as { structuredContent: unknown }).structuredContent
      : tryJson(text);
  return emptyData(cmd, structured) === true ? "empty" : "useful";
}

/**
 * Исход вызова через Bash. Порядок признаков — от самого машинного:
 * прерван хостом → код выхода (is_error) → строка ошибки myc (ловит и
 * случай, когда `| head` спрятал код) → конверт `--json` → подвал.
 */
export function classifyCli(
  cmd: string,
  block: { readonly is_error?: unknown; readonly content?: unknown },
  entry: { readonly toolUseResult?: unknown },
): CallOutcome {
  const tur = entry.toolUseResult;
  let text: string;
  if (tur !== null && typeof tur === "object") {
    const r = tur as { stdout?: unknown; stderr?: unknown; interrupted?: unknown };
    if (r.interrupted === true) return "error";
    text = `${typeof r.stdout === "string" ? r.stdout : ""}\n${typeof r.stderr === "string" ? r.stderr : ""}`;
  } else {
    text = typeof tur === "string" ? tur : contentText(block.content);
  }
  const failure = failureIn(text);
  if (block.is_error === true) return failure ?? "error";
  if (failure !== null) return failure;
  const env = OK_ENVELOPE.exec(text.replace(ANSI, ""));
  if (env !== null) {
    try {
      const parsed = JSON.parse(env[1]!) as { data?: unknown };
      return emptyData(cmd, parsed.data) === true ? "empty" : "useful";
    } catch {
      // Конверт обрезан (`| head -c`): признака нет — дальше по подвалу.
    }
  }
  return humanOutcome(cmd, text);
}

// ---------------------------------------------------------------------------
// Инкрементальный проход по транскрипту
// ---------------------------------------------------------------------------

interface Block {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly is_error?: unknown;
  readonly content?: unknown;
}

function blocksOf(entry: unknown): Block[] {
  if (entry === null || typeof entry !== "object") return [];
  const msg = (entry as { message?: unknown }).message;
  if (msg === null || typeof msg !== "object") return [];
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function addOutcome(counts: CallCounts, outcome: CallOutcome): void {
  counts.total++;
  counts[outcome]++;
}

function trimPending(pending: Record<string, PendingCall>): void {
  const ids = Object.keys(pending);
  for (let i = 0; i < ids.length - MAX_PENDING; i++) delete pending[ids[i]!];
}

/** Разобрать одну целую строку транскрипта. */
function scanLine(line: Buffer, cur: FileCursor): void {
  const hasUse =
    line.indexOf(NEEDLE_TOOL_USE) !== -1 &&
    (line.indexOf(NEEDLE_MCP) !== -1 || line.indexOf(NEEDLE_MYC) !== -1);
  let hasResult = false;
  if (line.indexOf(NEEDLE_RESULT) !== -1) {
    for (const id of Object.keys(cur.pending)) {
      if (line.indexOf(id) !== -1) {
        hasResult = true;
        break;
      }
    }
  }
  if (!hasUse && !hasResult) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return; // битая строка — не наша забота, но и не повод падать
  }
  for (const b of blocksOf(entry)) {
    if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      if (b.name.startsWith(MCP_PREFIX)) {
        cur.pending[b.id] = { via: "mcp", cmd: mcpCommand(b.name) };
      } else if (b.name === "Bash") {
        const cmd = (b.input as { command?: unknown } | undefined)?.command;
        const inv = typeof cmd === "string" ? findMycInvocation(cmd) : null;
        if (inv !== null) cur.pending[b.id] = { via: "cli", cmd: inv.cmd };
      }
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const call = cur.pending[b.tool_use_id];
      if (call === undefined) continue;
      delete cur.pending[b.tool_use_id];
      const e = entry as { mcpMeta?: unknown; toolUseResult?: unknown };
      addOutcome(cur.counts, call.via === "mcp" ? classifyMcp(call.cmd, b, e) : classifyCli(call.cmd, b, e));
    }
  }
  trimPending(cur.pending);
}

function freshCursor(ino: number): FileCursor {
  return { offset: 0, ino, pending: {}, counts: emptyCounts() };
}

/** Дочитать один файл не дальше `budget` байт. */
function scanFile(
  path: string,
  prev: FileCursor | undefined,
  budget: number,
): { cur: FileCursor | undefined; read: number; behind: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { cur: prev, read: 0, behind: 0 };
  }
  try {
    const st = fstatSync(fd);
    const ino = Number(st.ino);
    // Подмена файла или усечение — прежний курсор ничего не значит.
    const cur = prev !== undefined && prev.ino === ino && prev.offset <= st.size ? prev : freshCursor(ino);
    const avail = st.size - cur.offset;
    if (avail <= 0 || budget <= 0) return { cur, read: 0, behind: Math.max(0, avail) };
    let want = Math.min(avail, budget);
    let buf = Buffer.allocUnsafe(want);
    let got = readSync(fd, buf, 0, want, cur.offset);
    let end = buf.subarray(0, got).lastIndexOf(10);
    // Одна строка длиннее потолка (вставленный файл, огромный вывод) —
    // дочитываем её целиком: застрять на ней навсегда хуже, чем раз превысить.
    while (end === -1 && want < avail) {
      want = Math.min(avail, want * 2);
      buf = Buffer.allocUnsafe(want);
      got = readSync(fd, buf, 0, want, cur.offset);
      end = buf.subarray(0, got).lastIndexOf(10);
    }
    if (end === -1) return { cur, read: 0, behind: avail }; // последняя строка ещё пишется
    let start = 0;
    while (start <= end) {
      const nl = buf.indexOf(10, start);
      const stop = nl === -1 || nl > end ? end : nl;
      if (stop > start) scanLine(buf.subarray(start, stop), cur);
      start = stop + 1;
    }
    cur.offset += end + 1;
    return { cur, read: end + 1, behind: avail - (end + 1) };
  } finally {
    closeSync(fd);
  }
}

/** Транскрипты субагентов этой сессии: `<сессия>/subagents/*.jsonl`. */
export function subagentTranscripts(transcript: string): string[] {
  const dir = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Можно ли продолжать сохранённое состояние: тот же транскрипт, та же логика
 * подсчёта, та же сборка. Любое «нет» — счёт с нуля: курсор без счётчиков
 * бессмыслен, а счётчики чужой логики — неправда.
 */
function sameLogic(state: SessionState | null, transcript: string, build: string): boolean {
  return (
    state !== null &&
    state.v === 1 &&
    state.transcript === transcript &&
    (state.classifier ?? 1) === CLASSIFIER_VERSION &&
    (state.build ?? "") === build
  );
}

/**
 * Дочитать транскрипт сессии (и её субагентов) от сохранённых курсоров.
 * `state` другого транскрипта не используется: курсор принадлежит файлу.
 */
export function scanSession(
  state: SessionState | null,
  transcript: string,
  maxBytes: number = MAX_SCAN_BYTES,
  build = "",
): { readonly state: SessionState; readonly report: ScanReport } {
  const t0 = performance.now();
  const fresh: SessionState = { v: 1, classifier: CLASSIFIER_VERSION, build, transcript, files: {} };
  const next: SessionState = sameLogic(state, transcript, build) ? { ...fresh, files: { ...state!.files } } : fresh;
  const missing = !existsSync(transcript);
  let budget = maxBytes;
  let read = 0;
  let behind = 0;
  for (const path of missing ? [] : [transcript, ...subagentTranscripts(transcript)]) {
    const r = scanFile(path, next.files[path], budget);
    if (r.cur !== undefined) next.files[path] = r.cur;
    read += r.read;
    behind += r.behind;
    budget -= r.read;
  }
  const counts = emptyCounts();
  let pending = 0;
  for (const cur of Object.values(next.files)) {
    counts.total += cur.counts.total;
    counts.useful += cur.counts.useful;
    counts.empty += cur.counts.empty;
    counts.refusal += cur.counts.refusal;
    counts.error += cur.counts.error;
    pending += Object.keys(cur.pending).length;
  }
  return {
    state: next,
    report: {
      counts,
      pending,
      readBytes: read,
      behindBytes: behind,
      files: Object.keys(next.files).length,
      missing,
      tookMs: Math.round((performance.now() - t0) * 10) / 10,
    },
  };
}
