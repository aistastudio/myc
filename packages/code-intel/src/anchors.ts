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
 * РЕ-ПРИВЯЗКА §7.3 — ТРИ СТУПЕНИ, ДВЕ ИЗ НИХ ЗДЕСЬ (memory-5c03r9t5n472).
 * Ступени (1) точный crux и (2) нечёткое окно по отпечатку — локальные, им
 * нужен только файл. Ступень (3) — «код переехал в ДРУГОЙ файл» — живёт в
 * `./rebind.ts`: ей нужен код-индекс, то есть база, а этот модуль про базу не
 * знает. Отсюда она видна флагом `elsewhere` у результата проверки: файл
 * исчез, или ни одна локальная ступень его не нашла — искать дальше.
 *
 * ОТПЕЧАТОК — winnowing по нормализованному тексту спана (§7.1: k-грамм 5,
 * окно 4, 32×u32). Из выбранных winnowing'ом хешей хранятся 32 НАИМЕНЬШИХ
 * (bottom-k): это и есть «32×u32», и именно такая выборка даёт несмещённую
 * оценку Jaccard между двумя текстами по двум отпечаткам — без самих текстов,
 * которых у якоря после правки файла больше нет.
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

/** Отпечаток §7.1: k-грамма в символах нормализованного текста. */
export const FP_K = 5;
/** Отпечаток §7.1: окно winnowing'а в k-граммах. */
export const FP_W = 4;
/** Отпечаток §7.1: сколько хешей хранится (32×u32 — 128 байт в `anchors.fp`). */
export const FP_SIZE = 32;

/**
 * Порог локальной ре-привязки (§7.3 шаг 2, таблица порогов §11): окно в том
 * же файле, похожее на прежний спан меньше чем на 0.60, якорем не становится.
 */
export const REBIND_LOCAL_MIN = 0.6;

/** Высота окна шага 2: span_len ± 40 % (§7.3). */
export const REBIND_HEIGHT_SLACK = 0.4;

/**
 * НИЖЕ ЭТОЙ ДОЛИ КОДА ОКНО ПО ОТПЕЧАТКУ НЕ ПРИНИМАЕТСЯ, когда кроме отпечатка
 * улик нет (шаг 2 в том же файле, слова crux в шаге 3). Доля — длина
 * нормализованного текста окна к числу непробельных знаков в его строках.
 * Нормализация снимает комментарии и содержимое строк, и у функции, которая
 * почти вся — шаблонная строка, от отпечатка остаётся скелет
 * `function f(opts){return\`${A}${B}\`}`, похожий на любой другой такой же.
 * Пойман замером на истории (bench/rebind-eval.json): удалённый `codexNotify`
 * (доля кода 0.10) шагом 2 уехал на соседний шаблон `opencodePlugin` (0.07) со
 * сходством 0.688. У всех верных привязок замера доля ≥ 0.41.
 */
export const REBIND_MIN_CODE_SHARE = 0.25;

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/** Состояния из CHECK-ограничения таблицы `anchors` (§7.3). */
export type AnchorState = "fresh" | "drifted" | "stale" | "lost";

/**
 * На каком уровне лестницы остановилась проверка. 0 — файла нет на диске:
 * до уровня 1 дело не дошло, и это отдельная новость, а не «уровень 1 сказал
 * нет». 4 — ступень (3) §7.3: код найден в ДРУГОМ файле (`./rebind.ts`);
 * `checkAnchor` сам этот уровень не ставит, он только просит его флагом
 * `elsewhere`.
 */
export type CheckLevel = 0 | 1 | 2 | 3 | 4;

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
  /**
   * Отпечаток спана (§7.1). null — якорь поставлен до того, как отпечаток
   * начали считать: шаг 2 тогда идёт по отпечатку crux, а не всего спана.
   */
  readonly fp?: Uint32Array | null;
  /**
   * Состояние на момент проверки. Нужно ровно для одного: `stale` на
   * НЕИЗМЕНЁННОМ файле остаётся `stale` — уровни 1–2 говорят «файл тот же,
   * что при прошлой проверке», а в прошлый раз текста в нём не нашли.
   */
  readonly state?: AnchorState;
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
  /** Отпечаток спана; пустой — у отложенной привязки (S66), его снимет фон. */
  readonly fp: Uint32Array;
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
  /** Новый отпечаток спана; null — прежний остаётся как был. */
  readonly fp: Uint32Array | null;
  /**
   * Искать в ДРУГИХ файлах (ступень 3 §7.3): файла нет, или ни точный crux,
   * ни окно по отпечатку в нём не нашлись. Выставляется только вместе со
   * `stale` — это «здесь нет», а не «нигде нет».
   */
  readonly elsewhere: boolean;
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
 * Доля кода в строках [start, end]: длина нормализованного текста к числу
 * непробельных знаков исходника. Комментарии и строки нормализация снимает,
 * поэтому у шаблона или трактата в комментарии доля мала (см.
 * `REBIND_MIN_CODE_SHARE`). Пустые строки — доля 0.
 */
export function codeShare(s: NormStream, lines: readonly string[], start: number, end: number): number {
  let raw = 0;
  for (let ln = Math.max(1, start); ln <= Math.min(end, lines.length); ln++) {
    raw += (lines[ln - 1] ?? "").replace(/\s+/g, "").length;
  }
  return raw === 0 ? 0 : spanNormText(s, start, end).length / raw;
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
// Отпечаток: winnowing (k=5, w=4) и 32 наименьших хеша (§7.1)
// ---------------------------------------------------------------------------

/**
 * Хеш k-граммы, начинающейся в `i`: FNV-1a по кодовым единицам и финальное
 * перемешивание murmur3. Перемешивание не украшение: у FNV на пяти символах
 * старшие биты зависят в основном от последних символов, а отпечаток держит
 * НАИМЕНЬШИЕ хеши — без него «наименьшие» были бы просто k-граммами на `a`.
 */
function kgramHash(text: string, i: number): number {
  let h = 0x811c9dc5;
  for (let j = 0; j < FP_K; j++) {
    h ^= text.charCodeAt(i + j);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Winnowing (Schleimer, Wilkerson, Aiken 2003): в каждом окне из `FP_W`
 * подряд идущих k-грамм выбирается наименьший хеш (при равенстве — правый),
 * соседние окна, выбравшие ту же позицию, дают её один раз. Возвращает
 * выбранные хеши и позиции их k-грамм в тексте.
 */
export function winnow(text: string): { readonly hash: Uint32Array; readonly pos: Int32Array } {
  const n = text.length - FP_K + 1;
  if (n <= 0) return { hash: new Uint32Array(0), pos: new Int32Array(0) };
  const h = new Uint32Array(n);
  for (let i = 0; i < n; i++) h[i] = kgramHash(text, i);
  // Типизированные массивы с запасом на худший случай (выбрана каждая
  // позиция) и срез в конце: на файле в десятки килобайт `push` в обычный
  // массив стоил столько же, сколько сами хеши.
  const outH = new Uint32Array(n);
  const outP = new Int32Array(n);
  let k = 0;
  const w = Math.min(FP_W, n);
  let last = -1;
  for (let s = 0; s + w <= n; s++) {
    let m = s;
    for (let j = s + 1; j < s + w; j++) if (h[j]! <= h[m]!) m = j;
    if (m !== last) {
      outH[k] = h[m]!;
      outP[k] = m;
      k++;
      last = m;
    }
  }
  return { hash: outH.subarray(0, k), pos: outP.subarray(0, k) };
}

/**
 * 32 наименьших различных хеша из набора, по возрастанию. Держится
 * отсортированный буфер из 32: хеш не меньше его максимума отбрасывается одним
 * сравнением, и на длинном тексте так отбрасывается почти всё — без `Set` и
 * сортировки десятков тысяч чисел. Замер (p50 по 40 прогонам, якорь на весь
 * файл ready.ts, 35 КБ): через `Set` и сортировку — 0.55 мс, так — 0.17 мс
 * при нормализации того же файла 0.74 мс; якорь на 40 строк — 0.02 мс.
 */
function bottomK(hashes: ArrayLike<number>): Uint32Array {
  const buf = new Uint32Array(FP_SIZE);
  let size = 0;
  for (let i = 0; i < hashes.length; i++) {
    const x = hashes[i]! >>> 0;
    if (size === FP_SIZE && x >= buf[FP_SIZE - 1]!) continue;
    // Позиция вставки и проверка на повтор — линейно по 32 элементам.
    let at = 0;
    while (at < size && buf[at]! < x) at++;
    if (at < size && buf[at] === x) continue;
    const end = size < FP_SIZE ? size : FP_SIZE - 1;
    for (let j = end; j > at; j--) buf[j] = buf[j - 1]!;
    buf[at] = x;
    if (size < FP_SIZE) size++;
  }
  return buf.slice(0, size);
}

/** Отпечаток нормализованного текста: winnowing, затем 32 наименьших (§7.1). */
export function fingerprint(normText: string): Uint32Array {
  return bottomK(winnow(normText).hash);
}

/**
 * Оценка Jaccard двух текстов по их отпечаткам (bottom-k): берутся 32
 * наименьших хеша объединения, и считается доля тех, что есть в ОБОИХ.
 * Оценка честна, потому что у каждого отпечатка нет «дыр» ниже его
 * максимума: хеш из объединения, меньший максимума отпечатка, либо в нём, либо
 * отсутствует в тексте вообще. Пустой отпечаток (текст короче k-граммы) ни с
 * чем не сходится — сходство 0, а не деление на ноль.
 */
export function jaccardFp(a: Uint32Array, b: Uint32Array): number {
  if (a.length === 0 || b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let taken = 0;
  let both = 0;
  while (taken < FP_SIZE && (i < a.length || j < b.length)) {
    const x = i < a.length ? a[i]! : Number.POSITIVE_INFINITY;
    const y = j < b.length ? b[j]! : Number.POSITIVE_INFINITY;
    if (x === y) {
      both++;
      i++;
      j++;
    } else if (x < y) {
      i++;
    } else {
      j++;
    }
    taken++;
  }
  return taken === 0 ? 0 : both / taken;
}

/** `anchors.fp` — 32×u32 little-endian, до 128 байт. */
export function fpToBlob(fp: Uint32Array): Uint8Array {
  const out = new Uint8Array(fp.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < fp.length; i++) view.setUint32(i * 4, fp[i]!, true);
  return out;
}

/** Обратное к `fpToBlob`; null — отпечатка нет (якорь до этой задачи) или он битый. */
export function fpFromBlob(blob: Uint8Array | ArrayBuffer | null | undefined): Uint32Array | null {
  if (blob === null || blob === undefined) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

// ---------------------------------------------------------------------------
// Окно по отпечатку (§7.3 шаг 2; им же проверяются кандидаты шага 3)
// ---------------------------------------------------------------------------

export interface WindowHit {
  readonly start: number;
  readonly end: number;
  /** Jaccard отпечатка окна с отпечатком якоря — точный, по тексту окна. */
  readonly score: number;
}

/** Сколько лучших окон грубой оценки проверяется точным отпечатком. */
const WINDOW_VERIFY = 3;
/** Сколько высот окна перебирается внутри ± 40 % (плюс сама высота спана). */
const WINDOW_HEIGHTS = 16;

/**
 * ЛУЧШЕЕ ОКНО ФАЙЛА по отпечатку якоря: высота `height ± 40 %` строк, начало —
 * любая строка. Перебор окон «в лоб» стоил бы отпечаток на окно; здесь он
 * линеен по файлу на каждую высоту.
 *
 * Как. Отпечаток якоря — 32 наименьших хеша его текста; значит, всё, что у
 * текста якоря есть НИЖЕ его максимума `τ`, в отпечатке уже лежит. Тогда
 * у файла достаточно взять хеши winnowing'а не выше `τ` — их единицы на
 * тысячу, — и Jaccard окна оценивается по этой выборке: доля общих среди
 * объединения выборок. Окно сдвигается по строкам, и хеш входит в окно, когда
 * его k-грамма целиком внутри, выходит — когда её начало осталось позади;
 * счётчики поддерживаются за O(1) на событие.
 *
 * Грубая оценка только РАНЖИРУЕТ: `WINDOW_VERIFY` лучших окон пересчитываются
 * точным отпечатком по их собственному тексту, и порог сравнивается с ним.
 * При равенстве выигрывает окно ближе к `near`, потом — высотой ближе к
 * исходной: из двух одинаковых копий берётся та, что на прежнем месте.
 */
export function bestWindow(
  s: NormStream,
  lineCount: number,
  fp: Uint32Array,
  height: number,
  near: number,
): WindowHit | null {
  if (fp.length === 0 || lineCount <= 0 || s.text.length < FP_K) return null;
  const tau = fp.length >= FP_SIZE ? fp[fp.length - 1]! : 0xffffffff;
  const inA = new Set<number>(fp);

  // Выборка файла: хеши winnowing'а не выше τ, с первой и последней строкой k-граммы.
  const win = winnow(s.text);
  const ids = new Map<number, number>();
  const itemId: number[] = [];
  const itemA: number[] = [];
  const itemB: number[] = [];
  const isA: boolean[] = [];
  for (let i = 0; i < win.hash.length; i++) {
    const hv = win.hash[i]!;
    if (hv > tau) continue;
    const p = win.pos[i]!;
    let id = ids.get(hv);
    if (id === undefined) {
      id = ids.size;
      ids.set(hv, id);
      isA.push(inA.has(hv));
    }
    itemId.push(id);
    itemA.push(s.line[p] ?? 1);
    itemB.push(s.line[Math.min(p + FP_K - 1, s.line.length - 1)] ?? 1);
  }
  if (itemId.length === 0) return null;

  // Высоты — целые строго внутри ± 40 % (3 строки → 2..4), и окно обязано
  // начинаться и кончаться строкой КОДА. Без второго условия окно «добирало»
  // бы высоту пустыми строками и комментариями и выбрасывало переписанную
  // часть: у функции из трёх строк с переписанным телом окно «комментарий над
  // ней + сигнатура» набирало 0.72 и уводило якорь на одну строку сигнатуры.
  const isCode = new Uint8Array(lineCount + 2);
  for (const ln of s.codeLines) if (ln <= lineCount) isCode[ln] = 1;
  const hMin = Math.max(1, Math.ceil(height * (1 - REBIND_HEIGHT_SLACK) - 1e-9));
  const hMax = Math.min(lineCount, Math.max(hMin, Math.floor(height * (1 + REBIND_HEIGHT_SLACK) + 1e-9)));
  const heights = new Set<number>([Math.min(Math.max(height, hMin), hMax)]);
  const step = Math.max(1, Math.floor((hMax - hMin) / WINDOW_HEIGHTS));
  for (let h = hMin; h <= hMax; h += step) heights.add(h);
  heights.add(hMax);

  type Rough = { start: number; h: number; j: number };
  const top: Rough[] = [];
  const better = (x: Rough, y: Rough): boolean =>
    x.j !== y.j
      ? x.j > y.j
      : Math.abs(x.start - near) !== Math.abs(y.start - near)
        ? Math.abs(x.start - near) < Math.abs(y.start - near)
        : Math.abs(x.h - height) < Math.abs(y.h - height);
  const offer = (r: Rough): void => {
    top.push(r);
    top.sort((x, y) => (better(x, y) ? -1 : better(y, x) ? 1 : 0));
    if (top.length > WINDOW_VERIFY) top.length = WINDOW_VERIFY;
  };

  const count = new Int32Array(ids.size);
  for (const h of heights) {
    const last = lineCount - h + 1;
    if (last < 1) continue;
    const enter: number[][] = Array.from({ length: last + 2 }, () => []);
    const leave: number[][] = Array.from({ length: last + 2 }, () => []);
    for (let k = 0; k < itemId.length; k++) {
      const from = Math.max(1, itemB[k]! - h + 1);
      const until = itemA[k]!; // окно [s, s+h-1] держит k-грамму, пока s <= начала
      if (from > until || from > last) continue;
      enter[from]!.push(k);
      if (until + 1 <= last) leave[until + 1]!.push(k);
    }
    count.fill(0);
    let distinct = 0;
    let inter = 0;
    for (let st = 1; st <= last; st++) {
      for (const k of leave[st]!) {
        const id = itemId[k]!;
        if (--count[id]! === 0) {
          distinct--;
          if (isA[id]) inter--;
        }
      }
      for (const k of enter[st]!) {
        const id = itemId[k]!;
        if (count[id]!++ === 0) {
          distinct++;
          if (isA[id]) inter++;
        }
      }
      if (inter === 0 || isCode[st] === 0 || isCode[st + h - 1] === 0) continue;
      offer({ start: st, h, j: inter / (fp.length + distinct - inter) });
    }
  }

  let best: WindowHit | null = null;
  for (const r of top) {
    const end = r.start + r.h - 1;
    const score = jaccardFp(fingerprint(spanNormText(s, r.start, end)), fp);
    if (
      best === null ||
      score > best.score ||
      (score === best.score && Math.abs(r.start - near) < Math.abs(best.start - near))
    ) {
      best = { start: r.start, end, score };
    }
  }
  return best;
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
  return bindingAt(source, source.split("\n"), normalizeStream(source, lang), spanStart, spanEnd, st);
}

/**
 * Привязка по уже нормализованному файлу — общая у `bindAnchor` и у
 * ре-привязки: переснять crux, хеш и отпечаток найденного места, не
 * нормализуя файл второй раз.
 */
export function bindingAt(
  source: string,
  lines: readonly string[],
  s: NormStream,
  spanStart: number,
  spanEnd: number,
  st: StatLike,
): AnchorBinding {
  const start = Math.max(1, Math.min(spanStart, lines.length));
  const end = Math.max(start, Math.min(spanEnd, lines.length));
  const cruxEnd = cruxEndLine(s, start, end);
  const spanText = spanNormText(s, start, end);
  return {
    spanStart: start,
    spanEnd: end,
    fileHash: hashText(source),
    spanHash: hashText(spanText),
    crux: rawCrux(s, lines, start, cruxEnd),
    cruxNorm: spanNormText(s, start, cruxEnd),
    mtimeMs: Math.floor(st.mtimeMs),
    sizeBytes: st.size,
    fp: fingerprint(spanText),
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
 * детект по содержимому», `3` — «сняли поиск в других файлах» (ступень 3
 * §7.3, её делает `./rebind.ts`; сама `checkAnchor` 3 и 4 не различает). По
 * умолчанию — все.
 */
export type MaxLevel = 1 | 2 | 3 | 4;

export interface CheckOptions {
  /**
   * Порог шага 2; по умолчанию `REBIND_LOCAL_MIN` (0.60). Переопределяется
   * ради мутаций приёмки: порог 0 — «любое окно становится якорем».
   */
  readonly localMin?: number;
  /** Доля кода в окне шага 2; по умолчанию `REBIND_MIN_CODE_SHARE`. Мутация: 0 — правила нет. */
  readonly minCodeShare?: number;
}

/** Сходство в выводе и в `anchors.drift`: три знака — точнее оценка по 32 хешам не бывает. */
function roundDrift(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Лестница §7.2 целиком. `absPath` — уже собранный путь: якорь знает
 * `repo_root`, а модуль про репозитории ничего не знает и знать не должен.
 */
export function checkAnchor(
  a: AnchorLike,
  absPath: string,
  io: CheckIo = realCheckIo,
  maxLevel: MaxLevel = 4,
  opts: CheckOptions = {},
): AnchorCheck {
  const fpA = a.fp !== undefined && a.fp !== null && a.fp.length > 0 ? a.fp : null;
  // Искать дальше есть что, только если у якоря есть текст: пустой crux и
  // пустой отпечаток нашлись бы где угодно.
  const searchable = a.cruxNorm.length > 0 || fpA !== null;
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
    fp: null,
    elsewhere: false,
    reason,
    ...over,
  });

  // Уровень 0: файла нет. Отличается от «изменился»: код мог переехать, и
  // ответ здесь — «в этом файле нет», а искать дальше — ступень 3 (§7.3).
  const st = io.stat(absPath);
  if (st === undefined) return keep("stale", 0, "file not found", { elsewhere: searchable });

  // Якорь уже `stale`, а файл с прошлой проверки не менялся: вердикт «здесь
  // текста нет» остаётся в силе. Раньше уровни 1–2 объявляли такой якорь
  // `fresh` — `stale` записывал текущие mtime и размер, и следующий же прогон
  // совпадал с ними. Искать в других файлах при этом смысл есть: индекс и
  // соседние файлы могли измениться.
  const wasStale = a.state === "stale";

  // Уровень 1: метаданные. Один stat, файл не читается.
  if (Math.floor(st.mtimeMs) === a.mtimeMs && st.size === a.sizeBytes) {
    if (wasStale) {
      return keep("stale", 1, "file unchanged since the text went missing", { elsewhere: searchable });
    }
    return keep("fresh", 1, "mtime and size match");
  }
  if (maxLevel < 2) {
    return keep("stale", 1, "MUTATION: levels 2 and 3 removed");
  }

  // Уровень 2: хеш содержимого. touch без правки не идёт дальше.
  let source: string;
  try {
    source = io.read(absPath);
  } catch {
    return keep("stale", 0, "file unreadable");
  }
  const fileHash = hashText(source);
  const touched = { mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size };
  if (fileHash === a.fileHash) {
    if (wasStale) {
      return keep("stale", 2, "content unchanged since the text went missing", {
        ...touched,
        elsewhere: searchable,
      });
    }
    return keep("fresh", 2, "content unchanged (mtime touch)", touched);
  }
  if (maxLevel < 3) {
    return keep("stale", 2, "MUTATION: level 3 removed", touched);
  }

  // Уровень 3: содержимое. Сначала спан на прежних строках — правка в другом
  // конце файла не должна стоить поиска по всему файлу.
  const lines = source.split("\n");
  const stream = normalizeStream(source, a.lang);
  const rebound = (
    state: "fresh" | "drifted",
    start: number,
    end: number,
    drift: number,
    reason: string,
  ): AnchorCheck => {
    const b = bindingAt(source, lines, stream, start, end, st);
    return {
      state,
      level: 3,
      moved: b.spanStart !== a.spanStart || b.spanEnd !== a.spanEnd,
      spanStart: b.spanStart,
      spanEnd: b.spanEnd,
      drift: roundDrift(drift),
      fileHash: b.fileHash,
      spanHash: b.spanHash,
      crux: b.crux,
      cruxNorm: b.cruxNorm,
      mtimeMs: b.mtimeMs,
      sizeBytes: b.sizeBytes,
      fp: b.fp,
      elsewhere: false,
      reason,
    };
  };

  if (hashText(spanNormText(stream, a.spanStart, a.spanEnd)) === a.spanHash) {
    return rebound("fresh", a.spanStart, a.spanEnd, 1, "span in place, another part of the file changed");
  }

  // Спан не совпал — ищем его текст по файлу. Пустой crux искать нельзя:
  // пустая игла нашлась бы где угодно и утащила бы якорь в случайное место.
  if (!searchable) {
    return keep("stale", 3, "span changed, crux is empty — nothing to search for", { ...touched, fileHash });
  }

  // (1) Точный нормализованный crux — самый частый случай: код переехал по
  // файлу или переформатирован.
  const height = a.spanEnd - a.spanStart + 1;
  const hit = findNormalized(stream, a.cruxNorm, a.spanStart);
  if (hit !== 0) {
    const end = Math.min(lines.length, hit + height - 1);
    return rebound("fresh", hit, end, 1, hit !== a.spanStart ? `crux found at :${hit}` : "span reformatted, same text");
  }

  // (2) Нечёткое: окно высоты span_len ± 40 % с отпечатком, похожим не меньше
  // чем на 0.60. Якорь без отпечатка (поставлен до этой задачи) сравнивается
  // по отпечатку своего crux — головы спана, — и окно тогда той же высоты,
  // что голова, а новый спан — прежней высоты от найденного начала.
  // Окно, в котором кода меньше четверти (шаблон, трактат в комментарии),
  // якорем не становится: его отпечаток — скелет, похожий на любой такой же.
  const localMin = opts.localMin ?? REBIND_LOCAL_MIN;
  const minShare = opts.minCodeShare ?? REBIND_MIN_CODE_SHARE;
  let weak = "";
  const informative = (start: number, end: number): boolean => {
    const share = codeShare(stream, lines, start, end);
    if (share >= minShare) return true;
    weak = `; the most similar window :${start}-${end} is mostly strings/comments (code share ${roundDrift(share)} < ${minShare})`;
    return false;
  };
  if (fpA !== null) {
    const w = bestWindow(stream, lines.length, fpA, height, a.spanStart);
    if (w !== null && w.score >= localMin && informative(w.start, w.end)) {
      return rebound("drifted", w.start, w.end, w.score, `similar code at :${w.start} (similarity ${roundDrift(w.score)})`);
    }
  } else {
    const w = bestWindow(stream, lines.length, fingerprint(a.cruxNorm), Math.min(height, CRUX_MAX_LINES), a.spanStart);
    if (w !== null && w.score >= localMin) {
      const end = Math.min(lines.length, w.start + height - 1);
      if (informative(w.start, end)) {
        return rebound(
          "drifted",
          w.start,
          end,
          w.score,
          `similar crux at :${w.start} (similarity ${roundDrift(w.score)}, no span fingerprint)`,
        );
      }
    }
  }

  return keep("stale", 3, `span changed, its text is not in the file${weak}`, { ...touched, fileHash, elsewhere: true });
}
