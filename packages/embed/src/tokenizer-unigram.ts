/**
 * Unigram/SentencePiece-токенизатор XLM-RoBERTa (multilingual-e5-small:
 * словарь 250 002 куска, unk_id=3, metaspace `▁`, обрамление `<s> … </s>`).
 *
 * ЗАЧЕМ ВТОРАЯ РЕАЛИЗАЦИЯ. WordPiece из tokenizer.ts обслуживает BERT-модели
 * (bge-small-en). Многоязычные модели размерности 384 все построены на
 * XLM-R, а он использует Unigram — это не вариант настройки WordPiece, а
 * другой алгоритм: не жадный longest-match по префиксам, а Витерби по
 * логарифмическим вероятностям кусков. Цена многоязычности (решение S46).
 *
 * Ссылка соответствия — быстрый токенизатор HF (`tokenizer.json` той же
 * модели): нормализатор Precompiled(nmt_nfkc) + схлопывание пробелов,
 * пре-токенизатор Metaspace, модель Unigram, пост-процессор
 * TemplateProcessing. Совпадение по id проверяется на реальном корпусе
 * (tokenizer-unigram.test.ts), а не на выдуманных строках.
 */

import type { EncodedText } from "./tokenizer.ts";

const METASPACE = "▁";
/** Штраф неизвестного куска: min(score) − 10 (правило sentencepiece/HF). */
const UNK_PENALTY = 10;

/**
 * Классификация кодовых точек нормализатором nmt_nfkc — снята с эталона
 * (быстрый токенизатор HF на этом же tokenizer.json), а не выписана из
 * головы: интуиция здесь ошибается. Так, U+200B ZERO WIDTH SPACE
 * СХЛОПЫВАЕТСЯ В ПРОБЕЛ, а не удаляется, тогда как U+0B удаляется;
 * U+0085 и U+00AD остаются как есть. Расхождение здесь не падает и не
 * логируется — оно молча портит векторы.
 */
const TO_SPACE = new Set<number>([
  0x09, 0x0a, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000, 0xfeff,
]);

function isSpace(cp: number): boolean {
  if (TO_SPACE.has(cp)) return true;
  if (cp >= 0x2000 && cp <= 0x200a) return true;
  // U+200B…U+200F: нулевая ширина и метки направления — в пробел.
  if (cp >= 0x200b && cp <= 0x200f) return true;
  return false;
}

/** Управляющие кодовые точки, которые nmt_nfkc удаляет целиком. */
function isRemoved(cp: number): boolean {
  if (cp >= 0x01 && cp <= 0x08) return true;
  if (cp === 0x0b) return true;
  if (cp >= 0x0e && cp <= 0x1f) return true;
  if (cp === 0x7f || cp === 0x8f || cp === 0x9f) return true;
  return false;
}

/**
 * Нормализация входа: NFKC → пробелы/управляющие → схлопывание пробелов.
 * Обрезки краёв нет — её нет и у HF, а «▁» в начале ставит пре-токенизатор.
 */
export function normalizeUnigramInput(text: string): string {
  const nfkc = text.normalize("NFKC");
  let mapped = "";
  for (const ch of nfkc) {
    const cp = ch.codePointAt(0)!;
    if (isRemoved(cp)) continue;
    mapped += isSpace(cp) ? " " : ch;
  }
  // Нормализатор Replace из tokenizer.json: / {2,}/ → " ".
  return mapped.replace(/ {2,}/g, " ");
}

/** Разбор `tokenizer.json`: нужны только словарь и unk_id. */
export interface UnigramVocabEntry {
  readonly piece: string;
  readonly score: number;
}

interface ParsedTokenizerJson {
  readonly model?: {
    readonly type?: string;
    readonly unk_id?: number;
    readonly vocab?: unknown;
  };
}

export class UnigramTokenizer {
  private readonly ids: Map<string, number>;
  private readonly scores: Float64Array;
  private readonly unkId: number;
  private readonly unkScore: number;
  private readonly maxPieceLen: number;
  private readonly bosId: number;
  private readonly eosId: number;
  private readonly padTokenId: number;
  readonly vocabSize: number;

  private constructor(entries: readonly UnigramVocabEntry[], unkId: number) {
    const ids = new Map<string, number>();
    const scores = new Float64Array(entries.length);
    let maxLen = 1;
    let minScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < entries.length; i++) {
      const { piece, score } = entries[i]!;
      if (!ids.has(piece)) ids.set(piece, i);
      scores[i] = score;
      if (piece.length > maxLen) maxLen = piece.length;
      if (score < minScore) minScore = score;
    }
    this.ids = ids;
    this.scores = scores;
    this.unkId = unkId;
    this.unkScore = minScore - UNK_PENALTY;
    this.maxPieceLen = maxLen;
    this.vocabSize = entries.length;
    const bos = ids.get("<s>");
    const eos = ids.get("</s>");
    const pad = ids.get("<pad>");
    if (bos === undefined || eos === undefined || pad === undefined) {
      throw new Error("vocabulary lacks <s>/</s>/<pad> — this is not an XLM-R tokenizer.json");
    }
    this.bosId = bos;
    this.eosId = eos;
    this.padTokenId = pad;
  }

  static fromEntries(
    entries: readonly UnigramVocabEntry[],
    unkId: number,
  ): UnigramTokenizer {
    if (entries.length === 0) throw new Error("empty Unigram vocabulary");
    if (unkId < 0 || unkId >= entries.length) {
      throw new Error(`unk_id=${unkId} is outside a vocabulary of length ${entries.length}`);
    }
    return new UnigramTokenizer(entries, unkId);
  }

  static fromTokenizerJsonText(text: string): UnigramTokenizer {
    let parsed: ParsedTokenizerJson;
    try {
      parsed = JSON.parse(text) as ParsedTokenizerJson;
    } catch (cause) {
      throw new Error(`tokenizer.json does not parse: ${String(cause)}`);
    }
    const model = parsed.model;
    if (model === undefined || model.type !== "Unigram") {
      throw new Error(
        `tokenizer.json: expected a Unigram model, got ${String(model?.type)}`,
      );
    }
    const raw = model.vocab;
    if (!Array.isArray(raw)) throw new Error("tokenizer.json: model.vocab is not an array");
    const entries: UnigramVocabEntry[] = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i] as [string, number];
      entries[i] = { piece: row[0], score: row[1] };
    }
    return UnigramTokenizer.fromEntries(entries, model.unk_id ?? 3);
  }

  /**
   * Витерби по одному куску пре-токенизации. Возвращает id кусков.
   * Границы кандидатов — кодовые точки (суррогатная пара неделима),
   * длина куска словаря ограничена maxPieceLen, поэтому проход линеен.
   */
  private viterbi(word: string, out: number[]): void {
    const n = word.length;
    if (n === 0) return;
    // best[i] — лучший путь, заканчивающийся ровно на позиции i (в единицах UTF-16).
    const bestScore = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY);
    const bestStart = new Int32Array(n + 1).fill(-1);
    const bestId = new Int32Array(n + 1).fill(-1);
    bestScore[0] = 0;

    for (let start = 0; start < n; ) {
      const cp = word.codePointAt(start)!;
      const charLen = cp > 0xffff ? 2 : 1;
      const till = bestScore[start]!;
      if (till === Number.NEGATIVE_INFINITY) {
        start += charLen;
        continue;
      }
      let hasSingleChar = false;
      const limit = Math.min(this.maxPieceLen, n - start);
      for (let len = 1; len <= limit; len++) {
        const end = start + len;
        // Не резать суррогатную пару пополам.
        if (end < n && isLowSurrogate(word.charCodeAt(end))) continue;
        const id = this.ids.get(word.slice(start, end));
        if (id === undefined) continue;
        const candidate = till + this.scores[id]!;
        if (candidate > bestScore[end]!) {
          bestScore[end] = candidate;
          bestStart[end] = start;
          bestId[end] = id;
        }
        if (len === charLen) hasSingleChar = true;
      }
      if (!hasSingleChar) {
        const end = start + charLen;
        const candidate = till + this.unkScore;
        if (candidate > bestScore[end]!) {
          bestScore[end] = candidate;
          bestStart[end] = start;
          bestId[end] = this.unkId;
        }
      }
      start += charLen;
    }

    // Обратный проход; путь всегда существует — одиночный символ всегда
    // покрыт либо словарём, либо [unk].
    const rev: number[] = [];
    let pos = n;
    while (pos > 0) {
      const id = bestId[pos]!;
      const prev = bestStart[pos]!;
      if (prev < 0) break;
      rev.push(id);
      pos = prev;
    }
    for (let i = rev.length - 1; i >= 0; i--) out.push(rev[i]!);
  }

  /** Куски (id) без обрамления; отдельный метод ради тестов соответствия. */
  pieceIds(text: string): number[] {
    const normalized = normalizeUnigramInput(text);
    if (normalized.length === 0) return [];
    // Metaspace: пробел → «▁», префиксный «▁», затем разрез по «▁»
    // с присоединением к следующему куску (MergedWithNext у HF).
    const spaced = normalized.replaceAll(" ", METASPACE);
    const withPrefix = spaced.startsWith(METASPACE) ? spaced : METASPACE + spaced;
    const out: number[] = [];
    let cursor = 0;
    while (cursor < withPrefix.length) {
      let next = withPrefix.indexOf(METASPACE, cursor + 1);
      if (next === -1) next = withPrefix.length;
      this.viterbi(withPrefix.slice(cursor, next), out);
      cursor = next;
    }
    return out;
  }

  /**
   * Кодирование до maxLen позиций ВКЛЮЧАЯ `<s>`/`</s>`; длинные тексты
   * обрезаются. Контракт совпадает с WordPieceTokenizer.encode.
   */
  encode(text: string, maxLen = 512): EncodedText {
    if (maxLen < 2) throw new Error("maxLen < 2");
    const pieces = this.pieceIds(text).slice(0, maxLen - 2);
    const length = pieces.length + 2;
    const inputIds = new Int32Array(length);
    const attentionMask = new Int32Array(length);
    const tokenTypeIds = new Int32Array(length);
    inputIds[0] = this.bosId;
    for (let i = 0; i < pieces.length; i++) inputIds[i + 1] = pieces[i]!;
    inputIds[length - 1] = this.eosId;
    attentionMask.fill(1);
    return { inputIds, attentionMask, tokenTypeIds, length };
  }

  padId(): number {
    return this.padTokenId;
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
