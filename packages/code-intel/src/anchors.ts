/**
 * Якоря код↔знание: привязка, детект протухания и запрос по `file:line`
 * (docs/design/01-core-data-model.md §7.1–7.2, задачи memory-3afmdwe7bwyp и
 * memory-ehmatz79210p).
 *
 * СОДЕРЖАТЕЛЬНОЕ ЯДРО ЯКОРЯ — ТЕКСТ, А НЕ НОМЕРА СТРОК. Номера протухают при
 * первом же рефакторинге: вставили импорт наверху — и все якоря файла врут.
 * Врущий якорь хуже отсутствующего: отсутствие видно, а `file:line`,
 * указывающий на чужой код, читается как факт. Поэтому рядом со спаном
 * хранится `crux_norm` — нормализованный текст головы спана, и именно он
 * переживает переезд кода по файлу (идея graft, решение D14).
 *
 * ТРИ УРОВНЯ ДЕТЕКТА, ВСЕ ЛОКАЛЬНЫЕ И БЕСПЛАТНЫЕ (§7.2). Уровни — это
 * лестница цены, а не три независимые проверки: каждый следующий стоит на
 * порядок дороже и берётся только тогда, когда предыдущий не дал ответа.
 *
 *   1. (mtime_ms, size_bytes) — один `stat`, файл не читается вовсе;
 *   2. wyhash содержимого — `touch` без правки не доходит до разбора;
 *   3. содержимое — нормализованный спан, а если он не совпал, поиск
 *      `crux_norm` по файлу: код переехал — якорь переезжает с ним.
 *
 * Снять любой из уровней — значит начать врать в одну из двух сторон, и
 * ровно это проверяют мутации в anchors.test.ts: без уровня 1 проверка
 * читает каждый файл (цена), без уровня 3 переформатирование файла делает
 * якорь протухшим, а переезд функции — молча указывающим на чужой код.
 *
 * НОРМАЛИЗАЦИЯ СЧИТАЕТСЯ ПО ЦЕЛОМУ ФАЙЛУ, НЕ ПО ФРАГМЕНТУ. Лексер
 * (`classifyCode`) обязан видеть тот же контекст при привязке и при
 * проверке: фрагмент, начинающийся внутри шаблонной строки, классифицируется
 * иначе, чем тот же текст внутри файла, и якорь протух бы на ровном месте.
 *
 * ХЕШ — wyhash (Bun.hash), а не blake3 из §7.1: ровно по мотиву миграции 003
 * (code_files.file_hash). Это проверка свежести, а не подпись; blake3
 * потребовал бы нативной зависимости в пути установки, а на файле в сотни
 * килобайт разница между wyhash и криптохешем — заметная часть бюджета.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Нечёткая ре-привязка (winnowing, §7.3 шаг 2) и запрос к
 * graft (§7.3 шаг 3) — это задача memory-5c03r9t5n472, и она отдельная не по
 * лени: у них разный ответ на вопрос «что делать, когда текст НЕ найден».
 * Здесь ответ честный и единственный — `stale`, «файл изменился, не нашли».
 * Поэтому колонка `anchors.fp` этим модулем не заполняется.
 */

import { readFileSync, statSync } from "node:fs";
import { classifyCode } from "./lex.ts";

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Класс работ пере-проверки якорей в общей очереди jobs (§7.2, §7.5). */
export const ANCHOR_CHECK_JOB_KIND = "anchor_check";

/** Крупнее — не крукс, а пересказ файла: §7.1 задаёт 400 символов / 24 строки. */
export const CRUX_MAX_LINES = 24;
export const CRUX_MAX_CHARS = 400;

/**
 * Языки, для которых нормализация снимает комментарии и строковые литералы.
 * Лексер в `lex.ts` — ts/js; гнать по нему python или markdown значит
 * получить ЧУЖУЮ нормализацию, которая молча разойдётся между привязкой и
 * проверкой. Для остальных языков нормализация честно сводится к схлопыванию
 * пробелов, и это записано в `normalizeLines`, а не подразумевается.
 */
export const NORMALIZABLE_LANGS: ReadonlySet<string> = new Set(["ts", "tsx", "js", "jsx"]);

/** Батч пере-проверки за один прогон (§7.5). */
export const ANCHOR_CHECK_BATCH = 256;

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/** Состояния из CHECK-ограничения таблицы `anchors` (§7.3). */
export type AnchorState = "fresh" | "drifted" | "stale" | "lost";

/**
 * На каком уровне лестницы остановилась проверка. 0 — файла нет на диске:
 * до уровня 1 дело не дошло, и это отдельная новость, а не «уровень 1 сказал
 * нет».
 */
export type CheckLevel = 0 | 1 | 2 | 3;

/** Поля якоря, которых достаточно для проверки. Полная строка — в CLI. */
export interface AnchorLike {
  readonly path: string;
  readonly lang: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly fileHash: string;
  readonly spanHash: string;
  readonly cruxNorm: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/** Что привязка кладёт в строку `anchors`. */
export interface AnchorBinding {
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly fileHash: string;
  readonly spanHash: string;
  readonly crux: string;
  readonly cruxNorm: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

export interface AnchorCheck {
  readonly state: AnchorState;
  readonly level: CheckLevel;
  /** Спан переехал: текст найден, но в другом месте файла. */
  readonly moved: boolean;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly drift: number;
  readonly fileHash: string;
  readonly spanHash: string;
  readonly crux: string;
  readonly cruxNorm: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  /** Человеческая причина — она попадает в вывод `myc anchor check`. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Хеш и нормализация
// ---------------------------------------------------------------------------

/** Тот же формат, что у code_files.file_hash: 'wy:' + hex (миграция 003). */
export function hashText(text: string): string {
  return `wy:${Bun.hash(text).toString(16)}`;
}

function collapse(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/**
 * НОРМАЛИЗОВАННЫЙ ПОТОК ФАЙЛА — текст без комментариев, без содержимого
 * строковых литералов и БЕЗ ПЕРЕНОСОВ СТРОК, плюс отображение каждого
 * символа обратно в номер строки исходника.
 *
 * Построчная нормализация тут не годится, и это выяснилось замером, а не
 * рассуждением: настоящее переформатирование (`prettier --print-width`)
 * разносит одну сигнатуру на пять строк, и построчное сравнение объявляет
 * якорь протухшим на файле, где не изменилась ни одна инструкция. Приёмка
 * задачи требует ровно обратного — «после переформатирования якорь остаётся
 * валидным», — поэтому границы строк из ключа сравнения убраны совсем.
 *
 * Правило пробела: пробел остаётся ТОЛЬКО между двумя словесными символами.
 * `const x` остаётся `const x` (склеить их значило бы спутать два токена с
 * одним), а `f( a , b )` сводится к `f(a,b)` — то есть съедается ровно то,
 * чем переформатирование и отличается. Пробел ставится и на стыке строк:
 * без него `return\n  x` склеилось бы в `returnx` и разошлось с `return x`.
 *
 * Висячая запятая перед закрывающей скобкой снимается: `k = 60,\n)` против
 * `k = 60)` — это тот же код, и различить их означало бы ломать якорь на
 * каждом переносе аргументов.
 */
export interface NormStream {
  /** Нормализованный текст всего файла одной строкой. */
  readonly text: string;
  /** Номер строки исходника для каждого символа `text` (1-based). */
  readonly line: Int32Array;
  /** Номера строк, у которых нормализованное содержимое не пусто. */
  readonly codeLines: readonly number[];
}

const WORD_RE = /[A-Za-z0-9_$\u0080-\uffff]/u;

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD_RE.test(ch);
}

export function normalizeStream(source: string, lang: string): NormStream {
  const lines = source.split("\n");
  const mask = NORMALIZABLE_LANGS.has(lang) ? classifyCode(source).code : undefined;

  // Шаг 1: код каждой строки, пробелы схлопнуты, края обрезаны.
  const chars: string[] = [];
  const lineOf: number[] = [];
  const codeLines: number[] = [];
  let pos = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!;
    const before = chars.length;
    let pending = false;
    for (let i = 0; i < line.length; i++) {
      if (mask !== undefined && mask[pos + i] !== 1) continue;
      const ch = line[i]!;
      if (ch === " " || ch === "\t" || ch === "\r") {
        pending = chars.length > before;
        continue;
      }
      if (pending) {
        chars.push(" ");
        lineOf.push(ln + 1);
        pending = false;
      }
      chars.push(ch);
      lineOf.push(ln + 1);
    }
    pos += line.length + 1;
    if (chars.length > before) {
      codeLines.push(ln + 1);
      // Шаг 2: стык строк — такой же пробел, как внутри строки.
      chars.push(" ");
      lineOf.push(ln + 1);
    }
  }

  // Шаг 3: пробел выживает только между двумя словесными символами.
  // Шаг 4: висячая запятая перед закрывающей скобкой снимается.
  const outChars: string[] = [];
  const outLine: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === " ") {
      const prev = outChars[outChars.length - 1];
      let j = i + 1;
      while (j < chars.length && chars[j] === " ") j++;
      const next = chars[j];
      if (!isWord(prev) || !isWord(next)) continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      let k = outChars.length - 1;
      while (k >= 0 && outChars[k] === " ") k--;
      if (k >= 0 && outChars[k] === ",") {
        outChars.length = k;
        outLine.length = k;
      }
    }
    outChars.push(ch);
    outLine.push(lineOf[i]!);
  }
  while (outChars.length > 0 && outChars[outChars.length - 1] === " ") {
    outChars.pop();
    outLine.pop();
  }

  return { text: outChars.join(""), line: Int32Array.from(outLine), codeLines };
}

/** Границы среза потока, покрывающего строки [start, end]. */
function sliceOf(s: NormStream, start: number, end: number): { from: number; to: number } {
  let from = 0;
  while (from < s.line.length && s.line[from]! < start) from++;
  let to = from;
  while (to < s.line.length && s.line[to]! <= end) to++;
  // Хвостовой пробел стыка в срез не входит: он служебный.
  while (to > from && s.text[to - 1] === " ") to--;
  return { from, to };
}

/** Нормализованный текст спана — то, от чего берётся `span_hash`. */
export function spanNormText(s: NormStream, start: number, end: number): string {
  const { from, to } = sliceOf(s, start, end);
  return s.text.slice(from, to);
}

/**
 * Голова спана в пределах §7.1: до 24 непустых строк и до 400 символов
 * нормализованного текста. Возвращает последнюю строку крукса — сырой crux и
 * нормализованный обязаны браться из одного набора строк, иначе то, что
 * показано человеку, и то, по чему идёт поиск, разъедутся.
 */
function cruxEndLine(s: NormStream, start: number, end: number): number {
  const inSpan = s.codeLines.filter((ln) => ln >= start && ln <= end);
  if (inSpan.length === 0) return start - 1;
  let last = inSpan[0]!;
  for (let i = 0; i < inSpan.length && i < CRUX_MAX_LINES; i++) {
    const ln = inSpan[i]!;
    if (i > 0 && spanNormText(s, start, ln).length > CRUX_MAX_CHARS) break;
    last = ln;
  }
  return last;
}

/** Сырой текст строк [start, end], непустых в нормализованном виде. */
function rawCrux(s: NormStream, lines: readonly string[], start: number, end: number): string {
  return s.codeLines
    .filter((ln) => ln >= start && ln <= end)
    .map((ln) => lines[ln - 1] ?? "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Привязка
// ---------------------------------------------------------------------------

export interface StatLike {
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * Всё, что якорь запоминает о коде на момент привязки. Спан приводится к
 * границам файла: якорь на строку 900 в файле из 40 строк — это ошибка ввода,
 * а не повод записать заведомо протухший спан.
 */
export function bindAnchor(
  source: string,
  lang: string,
  spanStart: number,
  spanEnd: number,
  st: StatLike,
): AnchorBinding {
  const lines = source.split("\n");
  const start = Math.max(1, Math.min(spanStart, lines.length));
  const end = Math.max(start, Math.min(spanEnd, lines.length));
  const s = normalizeStream(source, lang);
  const cruxEnd = cruxEndLine(s, start, end);
  return {
    spanStart: start,
    spanEnd: end,
    fileHash: hashText(source),
    spanHash: hashText(spanNormText(s, start, end)),
    crux: rawCrux(s, lines, start, cruxEnd),
    cruxNorm: spanNormText(s, start, cruxEnd),
    mtimeMs: Math.floor(st.mtimeMs),
    sizeBytes: st.size,
  };
}

// ---------------------------------------------------------------------------
// Поиск переехавшего спана (уровень 3)
// ---------------------------------------------------------------------------

/**
 * Где в файле лежит нормализованный текст `needle`. Возвращает номер строки
 * начала совпадения или 0.
 *
 * Из нескольких совпадений выбирается БЛИЖАЙШЕЕ к прежнему началу спана.
 * Дубли в коде обычны (два одинаковых guard-блока), и «первое сверху»
 * утащило бы якорь через весь файл на ровном месте.
 */
export function findNormalized(s: NormStream, needle: string, near: number): number {
  if (needle.length === 0) return 0;
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let at = s.text.indexOf(needle); at !== -1; at = s.text.indexOf(needle, at + 1)) {
    const line = s.line[at] ?? 0;
    if (line === 0) continue;
    const dist = Math.abs(line - near);
    if (dist < bestDist) {
      best = line;
      bestDist = dist;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Детект протухания
// ---------------------------------------------------------------------------

export interface CheckIo {
  stat(path: string): StatLike | undefined;
  read(path: string): string;
}

export const realCheckIo: CheckIo = {
  stat(path) {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return undefined;
    }
  },
  read(path) {
    return readFileSync(path, "utf8");
  },
};

/**
 * Уровни, которые проверка имеет право пройти. Существует ради МУТАЦИЙ
 * приёмки, а не ради режимов работы: `1` — «сняли уровни 2 и 3», `2` — «сняли
 * детект по содержимому». По умолчанию все три.
 */
export type MaxLevel = 1 | 2 | 3;

/**
 * Лестница §7.2 целиком. `absPath` — уже собранный путь: якорь знает
 * `repo_root`, а модуль про репозитории ничего не знает и знать не должен.
 */
export function checkAnchor(
  a: AnchorLike,
  absPath: string,
  io: CheckIo = realCheckIo,
  maxLevel: MaxLevel = 3,
): AnchorCheck {
  const keep = (
    state: AnchorState,
    level: CheckLevel,
    reason: string,
    over: Partial<AnchorCheck> = {},
  ): AnchorCheck => ({
    state,
    level,
    moved: false,
    spanStart: a.spanStart,
    spanEnd: a.spanEnd,
    drift: state === "fresh" ? 1 : 0,
    fileHash: a.fileHash,
    spanHash: a.spanHash,
    crux: "",
    cruxNorm: a.cruxNorm,
    mtimeMs: a.mtimeMs,
    sizeBytes: a.sizeBytes,
    reason,
    ...over,
  });

  // Уровень 0: файла нет. Отличается от «изменился» — и `stale` здесь честнее
  // `lost`: без graft мы не знаем, удалён файл или переехал (§7.3).
  const st = io.stat(absPath);
  if (st === undefined) return keep("stale", 0, "файл не найден");

  // Уровень 1: метаданные. Один stat, файл не читается.
  if (Math.floor(st.mtimeMs) === a.mtimeMs && st.size === a.sizeBytes) {
    return keep("fresh", 1, "mtime и размер совпали");
  }
  if (maxLevel < 2) {
    return keep("stale", 1, "МУТАЦИЯ: уровни 2 и 3 сняты");
  }

  // Уровень 2: хеш содержимого. touch без правки не идёт дальше.
  let source: string;
  try {
    source = io.read(absPath);
  } catch {
    return keep("stale", 0, "файл не читается");
  }
  const fileHash = hashText(source);
  if (fileHash === a.fileHash) {
    return keep("fresh", 2, "содержимое не изменилось (mtime-тач)", {
      mtimeMs: Math.floor(st.mtimeMs),
      sizeBytes: st.size,
    });
  }
  if (maxLevel < 3) {
    return keep("stale", 2, "МУТАЦИЯ: уровень 3 снят", {
      mtimeMs: Math.floor(st.mtimeMs),
      sizeBytes: st.size,
    });
  }

  // Уровень 3: содержимое. Сначала спан на прежних строках — правка в другом
  // конце файла не должна стоить поиска по всему файлу.
  const lines = source.split("\n");
  const stream = normalizeStream(source, a.lang);
  const rebound = (start: number, end: number, moved: boolean, reason: string): AnchorCheck => {
    const cruxEnd = cruxEndLine(stream, start, end);
    return {
      state: "fresh",
      level: 3,
      moved,
      spanStart: start,
      spanEnd: end,
      drift: 1,
      fileHash,
      spanHash: hashText(spanNormText(stream, start, end)),
      crux: rawCrux(stream, lines, start, cruxEnd),
      cruxNorm: spanNormText(stream, start, cruxEnd),
      mtimeMs: Math.floor(st.mtimeMs),
      sizeBytes: st.size,
      reason,
    };
  };

  if (hashText(spanNormText(stream, a.spanStart, a.spanEnd)) === a.spanHash) {
    return rebound(a.spanStart, a.spanEnd, false, "спан на месте, изменился другой участок файла");
  }

  // Спан не совпал — ищем его текст по файлу. Пустой crux искать нельзя:
  // пустая игла нашлась бы где угодно и утащила бы якорь в случайное место.
  if (a.cruxNorm.length === 0) {
    return keep("stale", 3, "спан изменился, crux пуст — искать нечего", {
      mtimeMs: Math.floor(st.mtimeMs),
      sizeBytes: st.size,
      fileHash,
    });
  }
  const hit = findNormalized(stream, a.cruxNorm, a.spanStart);
  if (hit === 0) {
    return keep("stale", 3, "спан изменился, crux в файле не найден", {
      mtimeMs: Math.floor(st.mtimeMs),
      sizeBytes: st.size,
      fileHash,
    });
  }
  const height = a.spanEnd - a.spanStart;
  const end = Math.min(lines.length, hit + height);
  const moved = hit !== a.spanStart;
  return rebound(
    hit,
    end,
    moved,
    moved ? `crux найден на :${hit}` : "спан переформатирован, текст тот же",
  );
}
