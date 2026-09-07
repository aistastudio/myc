// Схема ID: docs/design/01-core-data-model.md §3

const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const BODY_LEN = 12;
const DEFAULT_SLUG = "myc";

const CHAR_TO_VALUE: Record<string, number> = {};
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  CHAR_TO_VALUE[CROCKFORD_ALPHABET[i] as string] = i;
}
// Crockford: I/L читаются как 1, O как 0 (регистронезависимо).
CHAR_TO_VALUE.i = 1;
CHAR_TO_VALUE.l = 1;
CHAR_TO_VALUE.o = 0;

export interface MycId {
  readonly slug: string;
  readonly body: string;
}

export type ParseIdError =
  | { readonly kind: "empty" }
  | { readonly kind: "missing_separator" }
  | { readonly kind: "invalid_slug" }
  | { readonly kind: "invalid_body_length"; readonly actual: number }
  | { readonly kind: "invalid_body_char"; readonly char: string };

export type ParseIdResult =
  | { readonly ok: true; readonly value: MycId }
  | { readonly ok: false; readonly error: ParseIdError };

const SLUG_RE = /^[a-z][a-z0-9]{1,7}$/;

/** Форматирует {slug, body} в каноническую строку `<slug>-<body>`, оба в нижнем регистре. */
export function formatId(id: MycId): string {
  return `${id.slug}-${id.body}`;
}

/** Генерирует новый канонический ID: `<slug>-<12 симв. Crockford base32>` (60 бит энтропии). */
export function generateId(slug: string = DEFAULT_SLUG): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const body = encodeBody(bytes);
  return `${slug}-${body}`;
}

function encodeBody(bytes: Uint8Array): string {
  // 8 байт = 64 бита; берём старшие 60 бит как 12 пятибитных групп.
  let bits = 0n;
  for (const b of bytes) {
    bits = (bits << 8n) | BigInt(b);
  }
  bits >>= 4n; // оставляем 60 старших бит из 64
  let out = "";
  for (let i = BODY_LEN - 1; i >= 0; i--) {
    const shift = BigInt(i * 5);
    const idx = Number((bits >> shift) & 0x1fn);
    out += CROCKFORD_ALPHABET[idx];
  }
  return out;
}

/**
 * Разбирает и валидирует строку ID. Не бросает исключений — горячий путь.
 * Регистр ввода не важен; I/l трактуются как 1, O как 0 (правило Crockford).
 */
export function parseId(input: string): ParseIdResult {
  if (input.length === 0) {
    return { ok: false, error: { kind: "empty" } };
  }
  const lower = input.toLowerCase();
  const sep = lower.indexOf("-");
  if (sep < 0) {
    return { ok: false, error: { kind: "missing_separator" } };
  }
  const slug = lower.slice(0, sep);
  const rawBody = lower.slice(sep + 1);
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: { kind: "invalid_slug" } };
  }
  if (rawBody.length !== BODY_LEN) {
    return {
      ok: false,
      error: { kind: "invalid_body_length", actual: rawBody.length },
    };
  }
  let body = "";
  for (const ch of rawBody) {
    const value = CHAR_TO_VALUE[ch];
    if (value === undefined) {
      return { ok: false, error: { kind: "invalid_body_char", char: ch } };
    }
    body += CROCKFORD_ALPHABET[value];
  }
  return { ok: true, value: { slug, body } };
}

export interface PrefixRange {
  /** Нижняя граница диапазона (включительно), пригодная для `id >= lower`. */
  readonly lower: string;
  /** Верхняя граница диапазона (исключительно), пригодная для `id < upper`. */
  readonly upper: string;
}

/**
 * Строит [lower, upper) для range-scan по PK, разрешающего короткий префикс.
 * upper — тот же префикс с инкрементом последнего символа по алфавиту Crockford,
 * с переносом через разряды. Если префикс — все `z` (последний символ алфавита),
 * upper переносится за пределы возможных ID (символ после алфавита), что всё равно
 * корректно ограничивает диапазон сверху.
 */
export function prefixRange(prefix: string): PrefixRange {
  const lower = prefix.toLowerCase();
  const chars = lower.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] as string;
    const idx = CROCKFORD_ALPHABET.indexOf(ch);
    if (idx === -1) {
      // Не base32-символ (например, разделитель '-') — переносить через него
      // некуда, дальше влево карри не идёт. Падаем к сентинел-границе ниже.
      break;
    }
    if (idx < CROCKFORD_ALPHABET.length - 1) {
      chars[i] = CROCKFORD_ALPHABET[idx + 1] as string;
      return { lower, upper: chars.slice(0, i + 1).join("") };
    }
    // idx — последний символ алфавита ('z'): перенос в следующий разряд слева,
    // сам символ отбрасывается (усечение до i совпадает с инкрементом и переносом).
  }
  // Все base32-символы префикса были 'z' — успешного инкремента внутри алфавита
  // не существует. '{' в ASCII идёт сразу после 'z' и больше любого валидного
  // символа Crockford, поэтому lower + '{' — корректная строгая верхняя граница.
  return { lower, upper: `${lower}{` };
}

/**
 * Для набора ID из одной выдачи возвращает кратчайшую длину префикса body,
 * при которой каждый ID однозначен внутри набора, но не короче MIN_PREFIX_LEN.
 * Пересчитывается на каждую выдачу (как у git), в память не пишется.
 */
export const MIN_PREFIX_LEN = 4;

export function shortestUniquePrefixes(
  ids: readonly string[],
): ReadonlyMap<string, number> {
  const parsed: Array<{ raw: string; slug: string; body: string }> = [];
  for (const raw of ids) {
    const result = parseId(raw);
    if (result.ok) {
      parsed.push({ raw, slug: result.value.slug, body: result.value.body });
    }
  }

  const result = new Map<string, number>();
  for (const item of parsed) {
    let len = MIN_PREFIX_LEN;
    while (len < BODY_LEN) {
      const candidate = item.body.slice(0, len);
      const collides = parsed.some(
        (other) =>
          other !== item &&
          other.slug === item.slug &&
          other.body.slice(0, len) === candidate,
      );
      if (!collides) break;
      len++;
    }
    result.set(item.raw, len);
  }
  return result;
}

export interface DotPathSegment {
  /** Порядковый номер узла среди детей его родителя, считая с 1. */
  readonly ordinal: number;
}

/**
 * Вычисляет дотовый путь отображения из цепочки предков (от корня к листу,
 * корень не входит в цепочку — им является leafShortId) и порядковых номеров.
 * Дотовый путь — вычисляемый ярлык, никогда не хранится (см. §3.2 дизайн-документа).
 */
export function formatDotPath(
  rootShortId: string,
  ancestry: readonly DotPathSegment[],
): string {
  if (ancestry.length === 0) return rootShortId;
  const tail = ancestry.map((seg) => seg.ordinal).join(".");
  return `${rootShortId}.${tail}`;
}

export interface ParsedDotPath {
  readonly rootShortId: string;
  readonly ordinals: readonly number[];
}

/** Разбирает дотовый путь обратно на короткий ID корня и цепочку ординалов. */
export function parseDotPath(path: string): ParsedDotPath | null {
  const firstDot = path.indexOf(".");
  if (firstDot === -1) {
    return { rootShortId: path, ordinals: [] };
  }
  const rootShortId = path.slice(0, firstDot);
  const rest = path.slice(firstDot + 1);
  if (rootShortId.length === 0 || rest.length === 0) return null;
  const parts = rest.split(".");
  const ordinals: number[] = [];
  for (const part of parts) {
    if (!/^[1-9][0-9]*$/.test(part)) return null;
    ordinals.push(Number(part));
  }
  return { rootShortId, ordinals };
}
