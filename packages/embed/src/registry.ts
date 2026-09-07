/**
 * Каталог моделей. Чек-суммы зафиксированы: `myc models fetch` качает
 * ровно эти байты (sha256 проверяется), во время работы обращения к
 * сети нет ни при каком раскладе.
 *
 * ДВЕ МОДЕЛИ, ОДНА РАЗМЕРНОСТЬ (решение S46). По умолчанию —
 * multilingual-e5-small: 384 измерения, схема nodes_vec не меняется,
 * миграция не нужна. Английская bge-small-en-v1.5 остаётся в каталоге
 * как осознанный выбор для англоязычного корпуса, но не как дефолт:
 * на русском она не отличала перефразировку от постороннего текста
 * вовсе (разделение −0.0064 при 0.1935 на английском).
 *
 * Различия моделей вынесены в спецификацию, а не в код: токенизатор
 * (WordPiece против Unigram), пулинг (CLS против среднего по маске) и
 * префиксы запроса/документа. Ветвлений «если модель называется так-то»
 * в пайплайне нет — иначе третья модель снова потребует правок в пяти
 * местах.
 */

import { DEFAULT_MODEL_ID, ENGLISH_MODEL_ID } from "./model-id.ts";

export { DEFAULT_MODEL_ID, ENGLISH_MODEL_ID } from "./model-id.ts";

export interface ModelFileSpec {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Алгоритм токенизации: BERT WordPiece или SentencePiece/Unigram (XLM-R). */
export type TokenizerKind = "wordpiece" | "unigram";

/**
 * Пулинг последнего слоя. CLS — скрытое состояние первого токена
 * (контракт bge). mean — среднее по токенам под маской внимания
 * (контракт e5; CLS на e5 даёт заметно худшее качество, это не
 * взаимозаменяемые варианты).
 */
export type PoolingKind = "cls" | "mean";

/** Языковой охват — показывается в `myc models`, влияет на выбор человека. */
export type ModelLanguages = "multilingual" | "english";

export interface ModelSpec {
  readonly id: string;
  readonly dim: number;
  readonly maxPositionTokens: number;
  readonly tokenizer: TokenizerKind;
  /** Имя файла токенизатора внутри каталога модели. */
  readonly tokenizerFile: string;
  readonly pooling: PoolingKind;
  readonly languages: ModelLanguages;
  /**
   * Префиксы e5. Модель обучена с ними, и без них теряется заметная часть
   * качества — а выглядит это как «модель так себе», то есть ровно как
   * молчаливая деградация, запрещённая инвариантом И2. Поэтому префиксы
   * живут в спецификации модели, а не в коде вызывающего.
   */
  readonly queryPrefix: string;
  readonly passagePrefix: string;
  readonly files: readonly ModelFileSpec[];
}

export const MODELS: Readonly<Record<string, ModelSpec>> = {
  /**
   * Источник — Xenova/multilingual-e5-small (ONNX-экспорт
   * intfloat/multilingual-e5-small, dynamic int8, BertModel со словарём
   * XLM-R на 250 002 куска, hidden 384, max_position 512).
   */
  "multilingual-e5-small-q8": {
    id: "multilingual-e5-small-q8",
    dim: 384,
    maxPositionTokens: 512,
    tokenizer: "unigram",
    tokenizerFile: "tokenizer.json",
    pooling: "mean",
    languages: "multilingual",
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    files: [
      {
        name: "model.onnx",
        url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx",
        sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
        bytes: 118_308_185,
      },
      {
        name: "tokenizer.json",
        url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/tokenizer.json",
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
        bytes: 17_082_730,
      },
      {
        name: "config.json",
        url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/config.json",
        sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
        bytes: 658,
      },
    ],
  },

  /**
   * Источник — Xenova/bge-small-en-v1.5 (ONNX-экспорт BAAI/bge-small-en-v1.5,
   * dynamic int8-квантизация, BertModel, hidden 384, max_position 512).
   */
  "bge-small-en-v1.5-q8": {
    id: "bge-small-en-v1.5-q8",
    dim: 384,
    maxPositionTokens: 512,
    tokenizer: "wordpiece",
    tokenizerFile: "vocab.txt",
    pooling: "cls",
    languages: "english",
    queryPrefix: "",
    passagePrefix: "",
    files: [
      {
        name: "model.onnx",
        url: "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx",
        sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
        bytes: 34_014_426,
      },
      {
        name: "vocab.txt",
        url: "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/vocab.txt",
        sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
        bytes: 231_508,
      },
      {
        name: "config.json",
        url: "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/config.json",
        sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
        bytes: 683,
      },
    ],
  },
};

export function getModelSpec(modelId: string = DEFAULT_MODEL_ID): ModelSpec {
  const spec = MODELS[modelId];
  if (spec === undefined) {
    throw new Error(
      `неизвестная модель "${modelId}"; известно: ${Object.keys(MODELS).join(", ")}`,
    );
  }
  return spec;
}

/** Суммарный вес модели на диске — `myc models` показывает цену загрузки. */
export function modelBytes(spec: ModelSpec): number {
  return spec.files.reduce((sum, f) => sum + f.bytes, 0);
}

/** Проверка целостности каталога: дефолт обязан существовать. */
if (MODELS[DEFAULT_MODEL_ID] === undefined || MODELS[ENGLISH_MODEL_ID] === undefined) {
  throw new Error("реестр моделей не содержит модель по умолчанию");
}
