import { describe, expect, test } from "bun:test";
import { WordPieceTokenizer } from "./tokenizer.ts";

// Синтетический словарь: базовые слова + ##-продолжения + спецтокены.
// Тесты не зависят ни от модели, ни от сети.
const SYNTH_VOCAB = [
  "[PAD]",
  "[UNK]",
  "[CLS]",
  "[SEP]",
  "[MASK]",
  "hello",
  "world",
  "!",
  "?",
  "embed",
  "##ding",
  "##s",
  "русское",
  "word",
  ".",
  ",",
];

function makeTokenizer(): WordPieceTokenizer {
  return WordPieceTokenizer.fromVocabList(SYNTH_VOCAB);
}

describe("WordPieceTokenizer", () => {
  test("спецтокены и размер словаря", () => {
    const tok = makeTokenizer();
    expect(tok.vocabSize).toBe(SYNTH_VOCAB.length);
    expect(tok.padId()).toBe(0);
  });

  test("нижний регистр и акценты", () => {
    const tok = makeTokenizer();
    expect(tok.tokenize("HÉLLO")).toEqual(["hello"]);
  });

  test("пунктуация отсекается посимвольно", () => {
    const tok = makeTokenizer();
    expect(tok.tokenize("hello, world!")).toEqual(["hello", ",", "world", "!"]);
  });

  test("wordpiece: продолжения через ##", () => {
    const tok = makeTokenizer();
    expect(tok.tokenize("embeddings")).toEqual(["embed", "##ding", "##s"]);
  });

  test("непокрываемое слово → [UNK] целиком", () => {
    const tok = makeTokenizer();
    expect(tok.tokenize("zzz")).toEqual(["[UNK]"]);
  });

  test("encode: [CLS] ... [SEP], маска из единиц", () => {
    const tok = makeTokenizer();
    const enc = tok.encode("hello world", 512);
    expect(enc.inputIds[0]).toBe(2); // [CLS]
    expect(enc.inputIds[enc.length - 1]).toBe(3); // [SEP] = 3
    expect(enc.length).toBe(4); // CLS + 2 + SEP
    for (let i = 0; i < enc.length; i++) expect(enc.attentionMask[i]).toBe(1);
    for (const x of enc.tokenTypeIds) expect(x).toBe(0);
  });

  test("обрезка до maxLen включая спецтокены", () => {
    const tok = makeTokenizer();
    const enc = tok.encode("hello world hello world hello world", 5);
    expect(enc.length).toBe(5);
    expect(enc.inputIds[0]).toBe(2);
    expect(enc.inputIds[4]).toBe(3);
  });

  test("пустая строка → [CLS][SEP]", () => {
    const tok = makeTokenizer();
    const enc = tok.encode("", 512);
    expect(enc.length).toBe(2);
  });

  test("битый словарь без [CLS] отвергается", () => {
    expect(() =>
      WordPieceTokenizer.fromVocabList(["[PAD]", "[UNK]", "hello"]),
    ).toThrow();
  });

  test("CJK разбивается посимвольно", () => {
    const tok = makeTokenizer();
    // В синтетическом словаре нет CJK — всё уйдёт в [UNK], но посимвольно:
    // два иероглифа = два UNK.
    expect(tok.tokenize("你好")).toEqual(["[UNK]", "[UNK]"]);
  });
});
