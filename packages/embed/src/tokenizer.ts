/**
 * WordPiece-токенизатор BERT (bge-small-en-v1.5: do_lower_case=true,
 * strip_accents, max 512 позиций). Своя реализация — без обращения к
 * сети и без зависимости от tokenizers-байндингов.
 *
 * Соответствует reference-логике BertTokenizer (clean, CJK, punctuation,
 * greedy longest-match-first, [UNK] для слов длиннее 100 символов).
 */

const CLS = "[CLS]";
const SEP = "[SEP]";
const UNK = "[UNK]";
const MAX_CHARS_PER_WORD = 100;

/**
 * Общий контракт токенизатора для ядра эмбеддера: WordPiece (BERT) и
 * Unigram (XLM-R) взаимозаменяемы на этом уровне, разница живёт в
 * спецификации модели, а не в ветвлениях пайплайна.
 */
export interface TextTokenizer {
  encode(text: string, maxLen?: number): EncodedText;
  /** ID паддинга — нужен пакетному пути. */
  padId(): number;
}

export interface EncodedText {
  readonly inputIds: Int32Array;
  readonly attentionMask: Int32Array;
  readonly tokenTypeIds: Int32Array;
  /** Число реальных токенов (без паддинга), включая [CLS]/[SEP]. */
  readonly length: number;
}

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u008F\u009F]/g;
const WS_RE = /\s+/g;
const MARK_RE = /\p{M}/gu;
const PUNCT_RE = /\p{P}/u;

function isBasicPunct(cp: number): boolean {
  return (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  );
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b920 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function basicTokenize(text: string): string[] {
  let cleaned = text.replace(CONTROL_RE, "");
  cleaned = cleaned.normalize("NFD").replace(MARK_RE, "").normalize("NFC");
  cleaned = cleaned.toLowerCase();

  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) {
      out.push(current);
      current = "";
    }
  };

  for (const ch of cleaned) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) {
      flush();
      out.push(ch);
    } else if (ch === " ") {
      flush();
    } else if (cp < 33 || PUNCT_RE.test(ch) || isBasicPunct(cp)) {
      flush();
      out.push(ch);
    } else {
      current += ch;
    }
  }
  flush();
  return out;
}

export class WordPieceTokenizer implements TextTokenizer {
  private readonly vocab: Map<string, number>;
  readonly vocabSize: number;

  private constructor(vocab: Map<string, number>) {
    this.vocab = vocab;
    this.vocabSize = vocab.size;
  }

  static fromVocabList(lines: readonly string[]): WordPieceTokenizer {
    const vocab = new Map<string, number>();
    for (const raw of lines) {
      const tok = raw.replace(/\r$/, "");
      // Пустые строки (в т.ч. хвост после финального \n) в словарь не входят.
      if (tok.length === 0) continue;
      if (!vocab.has(tok)) vocab.set(tok, vocab.size);
    }
    if (!vocab.has(CLS) || !vocab.has(SEP) || !vocab.has(UNK)) {
      throw new Error("vocabulary lacks [CLS]/[SEP]/[UNK] — this is not a BERT vocab.txt");
    }
    return new WordPieceTokenizer(vocab);
  }

  static fromVocabText(text: string): WordPieceTokenizer {
    return WordPieceTokenizer.fromVocabList(text.split("\n"));
  }

  /** Сегменты слова через greedy longest-match; null — слово не покрывается. */
  private wordPieces(word: string): string[] | null {
    if (word.length > MAX_CHARS_PER_WORD) return null;
    const pieces: string[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let match: string | null = null;
      while (start < end) {
        const candidate =
          start === 0 ? word.slice(0, end) : `##${word.slice(start, end)}`;
        if (this.vocab.has(candidate)) {
          match = candidate;
          break;
        }
        end--;
      }
      if (match === null) return null;
      pieces.push(match);
      start = end;
    }
    return pieces;
  }

  /** Пьесы без спецтокенов; для тестов и отладки. */
  tokenize(text: string): string[] {
    const pieces: string[] = [];
    for (const word of basicTokenize(text)) {
      if (word === CLS || word === SEP) {
        pieces.push(word);
        continue;
      }
      const wp = this.wordPieces(word);
      if (wp === null) pieces.push(UNK);
      else pieces.push(...wp);
    }
    return pieces;
  }

  /**
   * Кодирование до maxLen позиций ВКЛЮЧАЯ [CLS]/[SEP]; длинные тексты
   * обрезаются. Паддинга до maxLen нет — массив длиной length.
   */
  encode(text: string, maxLen = 512): EncodedText {
    if (maxLen < 2) throw new Error("maxLen < 2");
    const pieces = this.tokenize(text).slice(0, maxLen - 2);
    const length = pieces.length + 2;
    const inputIds = new Int32Array(length);
    const attentionMask = new Int32Array(length);
    const tokenTypeIds = new Int32Array(length);
    inputIds[0] = this.vocab.get(CLS)!;
    for (let i = 0; i < pieces.length; i++) {
      inputIds[i + 1] = this.vocab.get(pieces[i]!)!;
    }
    inputIds[length - 1] = this.vocab.get(SEP)!;
    attentionMask.fill(1);
    return { inputIds, attentionMask, tokenTypeIds, length };
  }

  /** ID спецтокенов — нужны пайплайну паддинга. */
  padId(): number {
    return this.vocab.get("[PAD]") ?? 0;
  }
}
