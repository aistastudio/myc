/**
 * Замер языкового качества эмбеддера: насколько модель отличает
 * относящийся к делу текст от постороннего — ОТДЕЛЬНО ПО КАЖДОМУ ЯЗЫКУ.
 *
 * Это единственная метрика, которая поймала бы S46, и она вынесена в
 * отдельный модуль (а не спрятана в тест), потому что её считает и
 * постоянный тест, и отчёт `bun run packages/embed/src/bench-separation.ts`.
 *
 * ДВЕ ВЕЛИЧИНЫ, И ОБЕ НУЖНЫ.
 *
 * `separation` = средний косинус близких пар минус средний косинус к
 * посторонним текстам. Прямая величина, сравнимая с исходным замером
 * дефекта (английская модель: en 0.1935, ru −0.0064). Но она ЗАВИСИТ ОТ
 * МАСШТАБА модели: у e5 все косинусы лежат в узком поясе 0.75…0.85, у
 * bge разброс шире, поэтому одно и то же качество даёт разные числа.
 * Сравнивать separation РАЗНЫХ моделей между собой нельзя, сравнивать
 * языки внутри одной модели — можно и нужно.
 *
 * `mrr`/`top1`/`top3` — ранговые, к масштабу равнодушны: где стоит нужный
 * документ, когда все документы корпуса и все посторонние тексты
 * соревнуются за место. Именно они говорят, работает ли поиск.
 */

import { cosineSimilarity } from "./quantize.ts";
import type { LanguageCorpus } from "./fixtures/separation-corpus.ts";

export interface SeparationReport {
  readonly lang: string;
  /** Средний косинус запрос↔свой документ. */
  readonly close: number;
  /** Средний косинус запрос↔посторонний бытовой текст. */
  readonly unrelated: number;
  /** close − unrelated: метрика дефекта S46. */
  readonly separation: number;
  /** Средний косинус запрос↔чужой документ того же корпуса. */
  readonly otherDocs: number;
  readonly top1: number;
  readonly top3: number;
  readonly mrr: number;
  readonly pairs: number;
}

export type EmbedFn = (text: string, role: "query" | "passage") => Promise<Float32Array>;

/**
 * Замер по одному языку. Векторы даёт ВЫЗЫВАЮЩИЙ — настоящая модель, а не
 * оракул из теста: иначе метрика проверяла бы тест, а не систему (S46).
 */
export async function measureSeparation(
  corpus: LanguageCorpus,
  embed: EmbedFn,
): Promise<SeparationReport> {
  const queries: Float32Array[] = [];
  const docs: Float32Array[] = [];
  const unrelated: Float32Array[] = [];
  // Последовательно: одна ONNX-сессия не реентерабельна.
  for (const p of corpus.pairs) queries.push(await embed(p.query, "query"));
  for (const p of corpus.pairs) docs.push(await embed(p.doc, "passage"));
  for (const t of corpus.unrelated) unrelated.push(await embed(t, "passage"));

  const n = corpus.pairs.length;
  let closeSum = 0;
  let unrelatedSum = 0;
  let unrelatedN = 0;
  let otherSum = 0;
  let otherN = 0;
  let top1 = 0;
  let top3 = 0;
  let mrr = 0;

  for (let i = 0; i < n; i++) {
    const q = queries[i]!;
    closeSum += cosineSimilarity(q, docs[i]!);
    for (const u of unrelated) {
      unrelatedSum += cosineSimilarity(q, u);
      unrelatedN++;
    }
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      otherSum += cosineSimilarity(q, docs[j]!);
      otherN++;
    }
    // Ранг своего документа среди ВСЕХ документов и всех посторонних.
    const own = cosineSimilarity(q, docs[i]!);
    let rank = 1;
    for (let j = 0; j < n; j++) {
      if (j !== i && cosineSimilarity(q, docs[j]!) > own) rank++;
    }
    for (const u of unrelated) if (cosineSimilarity(q, u) > own) rank++;
    mrr += 1 / rank;
    if (rank === 1) top1++;
    if (rank <= 3) top3++;
  }

  const close = closeSum / n;
  const unrelatedAvg = unrelatedSum / unrelatedN;
  return {
    lang: corpus.lang,
    close,
    unrelated: unrelatedAvg,
    separation: close - unrelatedAvg,
    otherDocs: otherSum / otherN,
    top1: top1 / n,
    top3: top3 / n,
    mrr: mrr / n,
    pairs: n,
  };
}

export function formatSeparation(r: SeparationReport): string {
  return (
    `${r.lang}: разделение ${r.separation >= 0 ? "+" : ""}${r.separation.toFixed(4)} ` +
    `(близкие ${r.close.toFixed(3)}, посторонние ${r.unrelated.toFixed(3)}, ` +
    `чужие документы ${r.otherDocs.toFixed(3)}) | ` +
    `top1 ${(r.top1 * 100).toFixed(0)}% top3 ${(r.top3 * 100).toFixed(0)}% MRR ${r.mrr.toFixed(3)} ` +
    `на ${r.pairs} парах`
  );
}
