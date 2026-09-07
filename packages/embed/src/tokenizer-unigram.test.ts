/**
 * Соответствие Unigram-токенизатора эталону.
 *
 * Эталон — быстрый токенизатор HF на том же `tokenizer.json`: id, снятые
 * им, зафиксированы в fixtures/unigram-reference.json (как они получены,
 * написано в шапке фикстуры). Своя реализация обязана давать те же id
 * ДОСЛОВНО: расхождение в токенизации не падает и не логируется — оно
 * просто тихо портит векторы, то есть ровно то, что запрещает И2.
 *
 * Тексты фикстуры — настоящие: заметки из памяти проекта, справка CLI и
 * набор краевых случаев (пустая строка, кратные пробелы, переводы строк,
 * эмодзи и суррогатные пары, смешанный русско-английский текст).
 */

import { describe, expect, test } from "bun:test";
import { isModelPresent, resolveModelPaths } from "./fetch.ts";
import { DEFAULT_MODEL_ID, getModelSpec } from "./registry.ts";
import { UnigramTokenizer, normalizeUnigramInput } from "./tokenizer-unigram.ts";
import reference from "./fixtures/unigram-reference.json" with { type: "json" };

const envDir = process.env.MYC_EMBED_TEST_MODELS_DIR;
const dir = envDir !== undefined && envDir !== "" ? envDir : undefined;
const spec = getModelSpec(DEFAULT_MODEL_ID);
const modelReady =
  spec.tokenizer === "unigram" && (await isModelPresent(DEFAULT_MODEL_ID, dir));

const d = modelReady ? describe : describe.skip;

describe("нормализация входа Unigram", () => {
  test("пробелы, управляющие символы и NFKC — как у эталона", () => {
    // Значения сняты с быстрого токенизатора HF (см. шапку файла):
    // нулевая ширина и метки направления схлопываются в ПРОБЕЛ,
    // вертикальная табуляция удаляется, U+0085 остаётся символом.
    expect(normalizeUnigramInput("a\u200bb")).toBe("a b");
    expect(normalizeUnigramInput("a\ufeffb")).toBe("a b");
    expect(normalizeUnigramInput("a\u000bb")).toBe("ab");
    expect(normalizeUnigramInput("a\u0007b")).toBe("ab");
    expect(normalizeUnigramInput("a\tb\nc")).toBe("a b c");
    expect(normalizeUnigramInput("два   пробела")).toBe("два пробела");
    expect(normalizeUnigramInput("a\u00a0b")).toBe("a b");
    // NFKC складывает совместимые формы; ё — не диакритика NFD, остаётся ё.
    expect(normalizeUnigramInput("\ufb01le")).toBe("file");
    expect(normalizeUnigramInput("ёжик")).toBe("ёжик");
  });
});

d("Unigram против эталона HF на реальных текстах", () => {
  const load = async () => {
    const paths = (await resolveModelPaths(DEFAULT_MODEL_ID, dir))!;
    return UnigramTokenizer.fromTokenizerJsonText(await Bun.file(paths.tokenizerPath).text());
  };

  test("словарь разобран целиком", async () => {
    const tok = await load();
    expect(tok.vocabSize).toBe(250002);
    expect(tok.padId()).toBe(1);
  });

  test("id совпадают с эталоном дословно на каждом тексте", async () => {
    const tok = await load();
    const mismatched: string[] = [];
    for (const item of reference.cases) {
      const mine = [...tok.encode(item.text, 512).inputIds];
      if (mine.length !== item.ids.length || mine.some((v, i) => v !== item.ids[i])) {
        mismatched.push(`${JSON.stringify(item.text.slice(0, 70))}: ${item.ids} ≠ ${mine}`);
      }
    }
    expect(mismatched).toEqual([]);
    expect(reference.cases.length).toBeGreaterThan(20);
  });

  test("обрезка длинного текста: ровно maxLen позиций с закрывающим токеном", async () => {
    const tok = await load();
    const long = "оплог сливается объединением по op_id, ".repeat(400);
    const enc = tok.encode(long, 512);
    expect(enc.length).toBe(512);
    expect(enc.inputIds[0]).toBe(0); // <s>
    expect(enc.inputIds[511]).toBe(2); // </s>
    expect(enc.attentionMask.every((v) => v === 1)).toBe(true);
  });

  test("пустой вход не ломается", async () => {
    const tok = await load();
    for (const text of ["", "   ", "\n"]) {
      const enc = tok.encode(text, 512);
      expect(enc.length).toBeGreaterThanOrEqual(2);
      expect(enc.inputIds[0]).toBe(0);
      expect(enc.inputIds[enc.length - 1]).toBe(2);
    }
  });
});
