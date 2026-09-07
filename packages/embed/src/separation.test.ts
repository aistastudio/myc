/**
 * ПОСТОЯННАЯ ПРОВЕРКА ЯЗЫКОВОГО КАЧЕСТВА (решение S46).
 *
 * Дефект, ради которого этот файл существует: модель по умолчанию была
 * англоязычной, на русском корпусе разделение близких и далёких пар
 * оказалось ОТРИЦАТЕЛЬНЫМ (−0.0064), и ни одна проверка этого не поймала.
 * Качество квантизации мерялось косинусом «до и после» — величина к языку
 * безразличная. recall@10 = 1.000 мерялся на синтетическом корпусе, где
 * перефразировку строил сам тест, а векторы давал оракул из теста.
 *
 * Поэтому здесь:
 *  · тексты РЕАЛЬНЫЕ и дословные (fixtures/separation-corpus.ts) — память
 *    проекта и справка CLI, ни одна строка не сочинена ради теста;
 *  · векторы даёт НАСТОЯЩАЯ модель, а не оракул;
 *  · метрика считается ОТДЕЛЬНО по каждому языку и сравнивается между
 *    языками — это и есть то единственное, что ловит языковую слепоту.
 *
 * Запускается, только если модель скачана (стандартный кеш или
 * MYC_EMBED_TEST_MODELS_DIR). Без модели describe пропускается — как и у
 * остальных тестов на реальной модели в этом пакете.
 */

import { describe, expect, test } from "bun:test";
import { isModelPresent } from "./fetch.ts";
import { DEFAULT_MODEL_ID, ENGLISH_MODEL_ID, getModelSpec } from "./registry.ts";
import { createLocalEmbedder } from "./local.ts";
import { cosineSimilarity } from "./quantize.ts";
import { CORPORA } from "./fixtures/separation-corpus.ts";
import { formatSeparation, measureSeparation, type SeparationReport } from "./separation.ts";

const envDir = process.env.MYC_EMBED_TEST_MODELS_DIR;
const dir = envDir !== undefined && envDir !== "" ? envDir : undefined;
const modelReady = await isModelPresent(DEFAULT_MODEL_ID, dir);

const d = modelReady ? describe : describe.skip;

/**
 * Пороги. Заданы с запасом к замеру (ru +0.0585 / en +0.0564, MRR 0.53/0.51
 * на 10 парах каждого языка), но так, чтобы англоязычная модель их не
 * прошла: у неё на русском разделение −0.115 и MRR 0.09.
 *
 * АБСОЛЮТНЫЕ ЗНАЧЕНИЯ РАЗДЕЛЕНИЯ У РАЗНЫХ МОДЕЛЕЙ НЕСРАВНИМЫ (см.
 * separation.ts): порог сторожит не «модель хороша», а «модель не слепа к
 * языку». Главное условие — ПОСЛЕДНЕЕ: перекос между языками.
 */
const MIN_SEPARATION = 0.03;
const MIN_MRR = 0.35;
const MIN_TOP3 = 0.5;
/** Худший язык обязан давать не меньше этой доли от лучшего. */
const MIN_LANGUAGE_RATIO = 0.6;

d("языковое качество эмбеддера на реальных текстах", () => {
  const reports = new Map<string, SeparationReport>();

  test("разделение близких и далёких пар положительно на обоих языках", async () => {
    const embedder = createLocalEmbedder(dir !== undefined ? { modelsDir: dir } : {});
    expect(await embedder.warmup()).toBe("ok");
    for (const corpus of CORPORA) {
      const report = await measureSeparation(corpus, async (text, role) => {
        const r = await embedder.embed(text, role);
        expect(r.state).toBe("ok");
        return r.vec!;
      });
      reports.set(corpus.lang, report);
      // Числа печатаются всегда: регрессия качества обязана быть видимой
      // в выводе, а не только в падении assert'а.
      console.log("  " + formatSeparation(report));
      expect(report.separation).toBeGreaterThan(MIN_SEPARATION);
      expect(report.mrr).toBeGreaterThan(MIN_MRR);
      expect(report.top3).toBeGreaterThanOrEqual(MIN_TOP3);
    }
    await embedder.destroy();
  }, 120_000);

  test("модель по умолчанию не перекошена по языку", () => {
    const ru = reports.get("ru")!;
    const en = reports.get("en")!;
    expect(ru).toBeDefined();
    expect(en).toBeDefined();
    // Ровно та проверка, которой не было: язык интерфейса разработки не
    // обязан быть языком, на котором модель случайно умеет.
    const ratioSep = Math.min(ru.separation, en.separation) / Math.max(ru.separation, en.separation);
    const ratioMrr = Math.min(ru.mrr, en.mrr) / Math.max(ru.mrr, en.mrr);
    expect(ratioSep).toBeGreaterThan(MIN_LANGUAGE_RATIO);
    expect(ratioMrr).toBeGreaterThan(MIN_LANGUAGE_RATIO);
  });

  test("модель по умолчанию объявлена многоязычной", () => {
    expect(getModelSpec(DEFAULT_MODEL_ID).languages).toBe("multilingual");
  });

  test("контрольная пара из отчёта о дефекте: борщ дальше оплога", async () => {
    // Дословно тот случай, на котором дефект был виден глазами: у
    // англоязычной модели «рецепт борща» оказался БЛИЖЕ к тексту про
    // слияние оплога, чем русский вопрос о том же самом.
    const embedder = createLocalEmbedder(dir !== undefined ? { modelsDir: dir } : {});
    await embedder.warmup();
    const doc = await embedder.embed(
      "Оплог сливается объединением по op_id: одинаковые операции идемпотентны, порядок задают гибридные логические часы.",
      "passage",
    );
    const question = await embedder.embed("как соединять журналы операций", "query");
    const borscht = await embedder.embed(
      "Рецепт борща: свёклу натереть на крупной тёрке, обжарить с томатной пастой, подавать со сметаной и пампушками.",
      "query",
    );
    const near = cosineSimilarity(doc.vec!, question.vec!);
    const far = cosineSimilarity(doc.vec!, borscht.vec!);
    console.log(`  вопрос ${near.toFixed(4)} против борща ${far.toFixed(4)}`);
    expect(near).toBeGreaterThan(far);
    await embedder.destroy();
  }, 60_000);

  test("пороги различают модели: англоязычная их НЕ проходит", async () => {
    // Гарантия против слишком мягких порогов. Проверка обязана падать на
    // модели, из-за которой она написана; иначе она снова ничего не ловит.
    if (!(await isModelPresent(ENGLISH_MODEL_ID, dir))) return;
    const english = createLocalEmbedder({
      modelId: ENGLISH_MODEL_ID,
      ...(dir !== undefined ? { modelsDir: dir } : {}),
    });
    expect(await english.warmup()).toBe("ok");
    const ru = await measureSeparation(CORPORA[0]!, async (text, role) => {
      const r = await english.embed(text, role);
      return r.vec!;
    });
    console.log(`  англоязычная на русском: ${formatSeparation(ru)}`);
    // Хотя бы одно из условий обязано нарушиться — и нарушается разом всё.
    const passes =
      ru.separation > MIN_SEPARATION && ru.mrr > MIN_MRR && ru.top3 >= MIN_TOP3;
    expect(passes).toBe(false);
    await english.destroy();
  }, 120_000);

  test("префиксы ролей реально применяются", async () => {
    // Забытый префикс e5 не ломает ничего видимо — он просто тихо снижает
    // качество. Поэтому проверяем не качество, а факт: у модели с
    // непустыми префиксами один и тот же текст в роли запроса и в роли
    // документа даёт РАЗНЫЕ векторы.
    const spec = getModelSpec(DEFAULT_MODEL_ID);
    const embedder = createLocalEmbedder(dir !== undefined ? { modelsDir: dir } : {});
    await embedder.warmup();
    const asQuery = await embedder.embed("оплог сливается объединением по op_id", "query");
    const asPassage = await embedder.embed("оплог сливается объединением по op_id", "passage");
    const same = cosineSimilarity(asQuery.vec!, asPassage.vec!);
    if (spec.queryPrefix !== spec.passagePrefix) {
      expect(same).toBeLessThan(0.999);
    } else {
      expect(same).toBeGreaterThan(0.999999);
    }
    await embedder.destroy();
  }, 60_000);
});
