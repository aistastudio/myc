// Гибридный ретривал: слияние источников по RRF + УСЛОВНАЯ векторная ветка.
//
// Формула и константы — docs/design/02-retrieval-and-performance.md §2.2
// (k = 60, cut-off top-100, w_fts = w_vec = 1.0, отсутствие в источнике ->
// rank = 1000), бусты и профили слоёв оттуда же. Ничего своего не изобретаем.
//
// РЕШЕНИЕ S31 (ARCHITECTURE.md §10) — почему вектор здесь условный, а не
// обязательный. Замер на реальной модели: эмбеддинг одного запроса стоит
// p50 23.3 мс / p95 98.9 мс при бюджете гибридного поиска 25 мс (И1). При этом
// лексика на 100k стоит 0.38 мс, а векторный поиск при УЖЕ ГОТОВОМ векторе —
// 2.77 мс. То есть дорога не векторная ветка, а вектор запроса. Значит платить
// за него в каждом запросе нельзя: сначала отвечают лексика и обход графа,
// вектор подключается, только когда лексика дала мало.
//
// Гипотеза, на которой это стоит (проверена в ./hybrid.test.ts, набор из 44
// запросов двух видов): у запросов агента почти всегда есть точные якоря —
// идентификаторы, строки ошибок, имена файлов и символов, — и на них BM25
// сильнее вектора. Вектор нужен на перефразировках, где словарь запроса и
// целевого текста не пересекается.
//
// ИНВАРИАНТ И2 (громкая деградация). Молчаливое исключение вектора — это тот
// же тихий фолбэк, что и подмена эмбеддингов на TF-IDF у memora: выдача
// меняется, а пользователь не знает почему. Поэтому каждый ответ несёт
// `mode_used`: какие ветки участвовали, сработал ли триггер и по какому
// критерию, и список degraded-причин.
//
// ОДИН ПРОХОД ПО БАЗЕ. Лексический пул, обход графа на 1 хоп и гидратация
// узлов делаются ОДНИМ SQL-запросом (урок socraticode: три round-trip на
// запрос — это три раза открыть и прогреть один и тот же page cache).
// В лексическом режиме — ровно 1 round-trip; сколько их вышло на самом деле,
// пишется в mode_used.roundTrips, гадать не нужно.
//
// Чего здесь сознательно НЕТ:
//   * RRF внутри SQL, как в примере §2.2. Условная ветка означает, что решение
//     «звать ли вектор» принимается ПОСЛЕ того, как получена лексика, — слить
//     оба источника одним оператором принципиально невозможно. Слияние сотни
//     строк в TS стоит микросекунды, round-trip'ов не добавляет.
//   * вызова эмбеддера. S31: вектор приходит снаружи готовым, здесь только
//     ленивый колбэк, который НЕ вызывается, если триггер не сработал, — в этом
//     вся экономия.

import { defineQueries, historyClause, type DbDriver, type Layer } from "@myc/core";
import type { FtsCaller } from "./fts.ts";
import {
  readOplogSeq,
  searchCacheKey,
  type CacheDisposition,
  type SearchResultCache,
} from "./cache.ts";
import { analyzeFtsQuery } from "./fts.ts";
import { vectorSearch, type VectorSearchOutcome, type VectorSearchParams } from "./vector.ts";

// ============================ конфигурация ==================================

/**
 * Пороги вынесены числами и настраиваются. Обоснование каждого — рядом, а не
 * в коммит-сообщении: значение без причины через месяц крутит кто попало.
 */
export interface HybridConfig {
  // --- RRF (§2.2, менять только вместе с бенчем 2.10) ---
  /** k — константа сглаживания RRF. */
  readonly rrfK: number;
  /** Ранг-штраф за отсутствие узла в источнике. */
  readonly missingRank: number;
  /** Отсечение пула каждого источника. */
  readonly poolSize: number;
  /** Вес лексического источника. */
  readonly weightFts: number;
  /** Вес векторного источника. */
  readonly weightVec: number;

  // --- триггер векторной ветки ---
  /**
   * «Мало результатов»: лексика вернула меньше этого числа кандидатов.
   * 5 при limit 12 и метрике recall@10 — точка, ниже которой лексикой просто
   * нечем заполнить топ-10, и вектор добавляет, ничего не вытесняя.
   */
  readonly minLexicalHits: number;
  /**
   * «Все одинаково плохи»: относительный разрыв между лучшим и медианным
   * BM25 в пуле. 0.15 — лучший кандидат обязан быть хотя бы на 15% сильнее
   * медианы; иначе BM25 фактически ранжирует по популярности, а не по
   * релевантности, и порядок внутри пула ничего не значит.
   */
  readonly minBm25Spread: number;
  /** Минимум кандидатов, на котором разброс вообще осмысленно считать. */
  readonly spreadMinHits: number;
  /**
   * Найденный якорь отменяет критерий «мало результатов».
   *
   * НЕ УКРАШЕНИЕ, А ИСПРАВЛЕНИЕ ОШИБКИ, найденной на наборе из hybrid.test.ts.
   * Точный якорный запрос («hybridSearch», «ENOENT», «src/vector.ts») находит
   * РОВНО ОДИН документ — и это успех, а не провал. Без этой оговорки
   * критерий `few_results` срабатывал на 100% якорных запросов, то есть
   * условная ветка вырождалась в обязательную ровно на том виде запросов,
   * ради которого всё и затевалось. Условие: в запросе есть якорный терм И
   * лексика нашла хотя бы один документ.
   */
  readonly anchorHitSuppressesFewResults: boolean;
  /**
   * «Короткий запрос»: не больше стольких терминов. 2 — потому что один-два
   * общеупотребительных слова («как», «config», «ошибка») дают BM25 почти
   * нулевой сигнал, тогда как один якорный токен делает точным даже запрос
   * из одного слова.
   */
  readonly shortQueryTerms: number;

  // --- лексический откат (S44) ---
  /**
   * Порядок лексических проходов.
   *
   *   "and_then_fallback" — сначала строгое И; ступени отката выполняются,
   *                   ТОЛЬКО если И дало ноль кандидатов. Запросы, которые и
   *                   так работают, не выполняются повторно вовсе — их
   *                   точность не меняется ни на строку.
   *   "or_always"   — один проход сразу по ИЛИ. Второго round-trip'а нет, зато
   *                   КАЖДЫЙ запрос получает пул из объединения, а не
   *                   пересечения, и платит за это на всей нагрузке.
   *
   * Замер обоих — в ./hybrid.fallback.test.ts (40 заметок, 40 вопросов, плюс
   * тот же набор на 100k). Значение настраиваемое, чтобы решение можно было
   * перепроверить, а не поверить комментарию.
   */
  readonly lexicalMode: "and_then_fallback" | "or_always";
  /**
   * ЛЕСТНИЦА ОТКАТА: ступени в порядке применения, до первой непустой.
   *
   * Ступени различаются не «шириной», а ПРИЧИНОЙ, по которой строгое И дало
   * ноль, и стоят они разного:
   *
   *   prefix_and     — не совпала ФОРМА слова («сливать» против «сливается»).
   *                    Пересечение по префиксам: та же точность и та же цена,
   *                    что у строгого И.
   *   prefix_relaxed — в вопросе есть ЛИШНЕЕ слово, которого в тексте нет
   *                    («как», «почему»). Объединение пересечений «все кроме
   *                    одного»: каждое слагаемое селективно.
   *   prefix_or      — не совпало почти ничего. Плоское объединение; одно
   *                    частое слово тянет десятки тысяч кандидатов.
   *   or             — то же без префиксов.
   *
   * Дефолт обрывается ПЕРЕД плоским ИЛИ, и это не осторожность, а замер: на
   * 100k узлов плоское ИЛИ дало p95 62 мс при бюджете 25 (./hybrid.fallback.test.ts),
   * тогда как обе префиксные ступени укладываются в единицы миллисекунд и
   * находят те же документы. Кому нужна максимальная полнота ценой хвоста —
   * добавляет "prefix_or" сюда.
   */
  readonly fallbackStages: readonly LexicalStage[];
  /**
   * Минимум терминов, при котором откат вообще осмыслен. На одном термине
   * ступени вырождаются в копию первого прохода и стоили бы round-trip впустую;
   * префиксная ступень при этом осмысленна и на одном термине, поэтому проверка
   * стоит на каждой ступени отдельно, а не здесь.
   */
  readonly fallbackMinTerms: number;
  /**
   * Потолок числа терминов для ступени prefix_relaxed2.
   *
   * Ступень «все кроме любых двух» даёт C(n,2) слагаемых, то есть растёт
   * квадратично: при пяти терминах это уже десять пересечений, и если среди
   * терминов есть частое слово, объединение выходит за бюджет. ЗАМЕР на 100k
   * (./hybrid.fallback.test.ts): без потолка p95 = 43.7 мс при бюджете 25.
   * Потолок делает стоимость ступени ограниченной СОСТАВОМ ЗАПРОСА, а не
   * везением, — то есть решение остаётся детерминированным, в отличие от
   * отсечения по времени.
   */
  readonly relaxed2MaxTerms: number;
  /**
   * Буст полного совпадения на ИЛИ-пуле: сначала по числу покрытых терминов,
   * при равенстве — по bm25.
   *
   * ЗАЧЕМ. bm25 по ИЛИ-пулу уже суммирует вклад каждого совпавшего термина, но
   * один редкий термин легко перевешивает два-три частых: по IDF это верно, а
   * для вопроса пользователя — нет, потому что «совпало больше слов вопроса» и
   * есть то, что он считает более точным ответом. Сортировка лексикографическая,
   * а не взвешенная сумма: смешивать счётчик слов с логарифмической шкалой bm25
   * значило бы придумать ещё один коэффициент без данных.
   *
   * ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ ПО ЗАМЕРУ, а не из осторожности. На 100k узлов
   * дополнительный запрос покрытия поднял p95 отката с 62 до 333 мс —
   * COUNT(DISTINCT) идёт по полным постинг-листам каждого термина, — а MRR не
   * изменился ни на тысячную (./hybrid.fallback.test.ts). Механизм рабочий и
   * оставлен под ключом: на корпусе с другим распределением частот он может
   * окупиться, но платить за него по умолчанию не за что.
   */
  readonly orCoverageBoost: boolean;

  // --- бусты и граф (§2.2) ---
  readonly profile: HybridProfile;
  /**
   * Прибавка к бусту за P0. Числа §2.2 стоят ЗДЕСЬ, а не в теле boostOf, по
   * двум причинам, и обе проверяемы. Первая: без конфига точку «бусты
   * выключены» нельзя получить, не правя исходник, — то есть нельзя ИЗМЕРИТЬ,
   * что бусты вообще что-то делают (замер: bench/boost-eval.ts, результат
   * bench/boost-eval.json). Вторая: коэффициент, зашитый в выражение, через
   * месяц крутит кто попало без единого числа рядом.
   *
   * Перекалибровка — только вместе с bench/boost-eval.ts на bench/boost-queries.json.
   */
  readonly priorityBoostP0: number;
  /** Прибавка за P1 (§2.2: 0.15). */
  readonly priorityBoostP1: number;
  /** Штраф за P3 (§2.2: 0.10, ВЫЧИТАЕТСЯ). */
  readonly priorityPenaltyP3: number;
  /**
   * Амплитуда буста свежести (§2.2: 0.25). Свежесть — 1 + A·exp(−age/τ):
   * сегодняшний узел получает 1 + A, узел возрастом много τ — ровно 1. A = 0
   * выключает свежесть, не трогая остальные бусты.
   */
  readonly freshnessAmplitude: number;
  /** τ свежести в днях. */
  readonly freshnessTauDays: number;
  /**
   * layer_w по профилю запроса (§2.2), индекс массива = layer (L0..L3).
   *
   * СЛОЙ УЧАСТВУЕТ В РАНЖИРОВАНИИ, и это механика TencentDB: L2/L3 — сжатые
   * обобщения, они дают быстрый бутстрап контекста (профиль prime), а за
   * конкретным фактом надо падать в L1/L0 (профиль deep инвертирует веса).
   * balanced не трогает ничего — все веса 1.0.
   */
  readonly layerWeights: Readonly<Record<HybridProfile, readonly [number, number, number, number]>>;
  /** Сколько верхних лексических узлов идут сидами обхода графа. */
  readonly graphSeeds: number;
  /**
   * ГЛУБИНА ОБХОДА. 0 — расширение выключено целиком, 1 — только прямые соседи
   * сидов, 2 — соседи соседей. Больше двух не поддерживается сознательно:
   * веер растёт как степень средней степени узла, а третий хоп на графе задач
   * и памяти — это уже «всё, что связано хоть как-то», то есть шум по
   * построению. Значение вынесено в конфиг, потому что это ЕДИНСТВЕННЫЙ
   * способ снять точку «расширение отключено» на том же корпусе, не правя
   * исходник (замер: bench/graph-eval.ts).
   */
  readonly graphMaxHops: number;
  /**
   * ЗАТУХАНИЕ ПО ГЛУБИНЕ: множитель, который добавляет КАЖДЫЙ хоп; индекс
   * массива = глубина − 1. Затухание перемножается по пути, а не назначается
   * абсолютом на глубину: узел на втором хопе получает
   * score(сид) × d1 × w1 × t1 × d2 × w2 × t2, то есть цена пути честно
   * складывается из всех рёбер, по которым до него дошли, а не из одного
   * номера глубины. Хоп глубже длины массива не выполняется.
   *
   * Значения переопределяются из workspace.toml (./boost-config.ts,
   * graph_decay_by_hop), перекалибровка — bench/graph-eval.ts --sweep.
   */
  readonly graphDecayByHop: readonly number[];
  /** Минимальный вес ребра. */
  readonly graphMinEdgeWeight: number;
  /**
   * ПОТОЛОК ВЕЕРА ХОПА: сколько узлов оставляет за собой КАЖДЫЙ хоп, прежде
   * чем их гидратировать. Без него один хаб в окрестности (узел с сотнями
   * рёбер) заставляет запрос гидратировать тысячи узлов, из которых слияние
   * всё равно возьмёт не больше 2 × (сиды + сиды второго хопа) — то есть
   * платится за строки, которые заведомо будут выброшены. ЗАМЕР на 100k с
   * хабами (bench/graph-eval.ts --latency) — в шапке hybridLexicalPass.
   *
   * Отбор внутри хопа идёт по рангу сида и весу ребра, тем же порядком, каким
   * потом сортирует слияние; потолок берётся с запасом к графовому капу
   * слияния, чтобы не он решал, что попадёт в выдачу.
   */
  readonly graphHopFanout: number;
  /**
   * ПОТОЛОК ВЕЕРА ВТОРОГО ХОПА: сколько узлов первого хопа становятся сидами
   * второго. Это не оптимизация, а граница цены: без потолка стоимость
   * второго хопа определяется степенью самого связного узла в окрестности
   * (эпик с полусотней детей), то есть везением, а бюджет обхода — 1–3 мс
   * (приёмка memory-1md1zhs0w8r0). С потолком число seek'ов второго хопа
   * ограничено сверху конфигом, а не данными.
   */
  readonly graphHop2Seeds: number;
  /**
   * ВЕС ТИПА РЕБРА, множитель к весу пути. Типы рёбер — не украшение схемы:
   * `parent` и `blocks` означают «это про то же самое», а `mentions` и
   * `touches` — «здесь упомянуто имя», и на втором хопе разница между ними
   * решающая, потому что через упоминания граф связен почти весь.
   *
   * Тип, которого нет в таблице, идёт с graphTypeWeightDefault. Значения
   * подобраны замером (bench/graph-eval.ts, группа hub): по умолчанию все
   * единицы — то есть таблица НЕ меняет поведение, пока её не настроили, —
   * кроме двух упоминательных типов, которым замер дал понижение.
   */
  readonly graphTypeWeights: Readonly<Record<string, number>>;
  /** Вес типа ребра, которого нет в graphTypeWeights. */
  readonly graphTypeWeightDefault: number;
}

export type HybridProfile = "prime" | "deep" | "balanced";

/** Ступень лексического отката. Порядок задаётся конфигурацией, не типом. */
export type LexicalStage =
  | "prefix_and"
  | "prefix_relaxed"
  | "prefix_relaxed2"
  | "prefix_or"
  | "or";

/** Оператор, которым собран лексический пул: строгое И или ступень отката. */
export type LexicalOperator = "and" | LexicalStage;

/** layer_w по профилю запроса (§2.2), индекс = layer. Умолчание конфига. */
export const DEFAULT_LAYER_WEIGHTS: Readonly<
  Record<HybridProfile, readonly [number, number, number, number]>
> = Object.freeze({
  prime: [0.9, 1.0, 1.1, 1.2],
  deep: [1.15, 1.15, 1.0, 0.9],
  balanced: [1.0, 1.0, 1.0, 1.0],
});

/**
 * Затухание по глубине, индекс = глубина − 1 (умолчание конфига).
 *
 * d1 = 0.5 — из §2.2, стоит с первого дня обхода на один хоп.
 *
 * d2 = 0.5 — и вот здесь честный ответ такой: ПЕРЕБОР ЕГО НЕ РАЗДЕЛИЛ.
 * bench/graph-eval.ts --sweep даёт одинаковые MRR@10 = 0.422 на всём
 * диапазоне d2 от 0.1 до 0.7, потому что на этом корпусе узел второго хопа
 * ни в одном запросе не конкурирует с узлом первого — он либо единственный
 * кандидат на своё место, либо не нужен вовсе. Разделяется только d2 = 1.0
 * (MRR 0.435), но это «затухания по глубине нет», то есть отказ от самого
 * механизма: узел через два ребра получал бы ровно тот же вес, что через
 * одно. Поэтому взято d2 = d1 — равномерное геометрическое затухание, самое
 * простое из тех, что перебор не отверг, а не подогнанное число.
 */
export const DEFAULT_GRAPH_DECAY_BY_HOP: readonly number[] = Object.freeze([0.5, 0.5]);

/**
 * Веса типов рёбер (умолчание конфига). Единица = тип не влияет; типы, по
 * которым граф связен «почти весь», понижены — обоснование в комментарии к
 * graphTypeWeights и в группе hub замера.
 */
export const DEFAULT_GRAPH_TYPE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  mentions: 0.5,
  touches: 0.5,
});

export const DEFAULT_HYBRID_CONFIG: HybridConfig = {
  rrfK: 60,
  missingRank: 1000,
  poolSize: 100,
  weightFts: 1.0,
  weightVec: 1.0,

  minLexicalHits: 5,
  minBm25Spread: 0.15,
  spreadMinHits: 3,
  anchorHitSuppressesFewResults: true,
  shortQueryTerms: 2,

  lexicalMode: "and_then_fallback",
  fallbackStages: ["prefix_and", "prefix_relaxed"],
  fallbackMinTerms: 2,
  relaxed2MaxTerms: 4,
  orCoverageBoost: false,

  profile: "balanced",
  priorityBoostP0: 0.3,
  priorityBoostP1: 0.15,
  priorityPenaltyP3: 0.1,
  freshnessAmplitude: 0.25,
  freshnessTauDays: 90,
  layerWeights: DEFAULT_LAYER_WEIGHTS,
  graphSeeds: 15,
  graphMaxHops: 2,
  graphDecayByHop: DEFAULT_GRAPH_DECAY_BY_HOP,
  graphMinEdgeWeight: 0.3,
  graphHopFanout: 64,
  graphHop2Seeds: 12,
  graphTypeWeights: DEFAULT_GRAPH_TYPE_WEIGHTS,
  graphTypeWeightDefault: 1.0,
};

/**
 * «Расширение по графу выключено» одной накладкой — вторая точка замера
 * (bench/graph-eval.ts) и обязательная мутация приёмки: если метрика с этой
 * накладкой не меняется, обход не работает. Ровно тот же приём, что
 * NO_BOOST_OVERRIDES для бустов.
 */
export const NO_GRAPH_OVERRIDES: Partial<HybridConfig> = Object.freeze({
  graphMaxHops: 0,
});

/** Только первый хоп — поведение до memory-1md1zhs0w8r0. Третья точка замера. */
export const ONE_HOP_OVERRIDES: Partial<HybridConfig> = Object.freeze({
  graphMaxHops: 1,
});

// ============================ якорные токены ================================

// Токенизация повторяет WORD_RE из ./fts.ts (тот её не экспортирует, а лезть
// в чужой модуль ради регулярки — худший вариант, чем одна строка здесь).
const WORD_RE = /[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*/gu;

/**
 * Детектор «якорного» (редкого) токена — по форме, БЕЗ обращения к базе.
 *
 * Это и есть проверяемая гипотеза в исполняемом виде: у запросов агента
 * якоря — идентификаторы, коды ошибок, пути, имена символов. Считать
 * настоящий document frequency было бы точнее, но это +N round-trip'ов на
 * запрос — ровно та цена, которую вся задача и снимает. Форма токена даёт
 * тот же ответ за 0 мс; насколько хорошо — измерено в hybrid.test.ts.
 */
export function isAnchorToken(token: string): boolean {
  if (token.length === 0) return false;
  if (/\d/.test(token)) return true; // E1042, v2, sha1, 0x7f
  if (/[_./\-]/.test(token)) return true; // snake_case, path/to/file.ts, kebab-case
  if (/[a-z][A-Z]/.test(token)) return true; // camelCase, PascalCase
  if (token.length >= 3 && token === token.toUpperCase() && /[A-Z]/.test(token)) return true; // ENOENT
  // Длинный ASCII-токен — почти всегда идентификатор или хеш. Ограничение на
  // ASCII здесь существенно: без него любое длинное слово естественного языка
  // («восстановления», «инициализация») считалось бы якорем и глушило триггер
  // на ровно тех перефразировках, ради которых вектор и нужен.
  if (token.length >= 12 && /^[A-Za-z0-9]+$/.test(token)) return true;
  return false;
}

export function tokenizeQuery(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

// ============================ контракт выдачи ===============================

export type HybridSource = "fts" | "vector" | "graph";

/** Одно ребро обхода, как его вернул лексический проход. */
interface GraphEdgeRow {
  readonly id: string;
  readonly viaId: string;
  readonly weight: number;
  readonly type: string;
  readonly depth: number;
}

/**
 * ЧТО СДЕЛАЛ ОБХОД — часть mode_used, а не отладка (И2). Расширение по графу
 * добавляет в выдачу узлы, в которых НЕТ НИ ОДНОГО СЛОВА ЗАПРОСА: пользователь
 * обязан видеть, что смотрит на связанное, а не на найденное, и на какой
 * глубине это связанное лежит.
 */
export interface HybridGraph {
  /** Глубина, разрешённая конфигом. 0 — расширение выключено. */
  readonly maxHops: number;
  /** Сколько узлов дал каждый хоп; индекс = глубина − 1. */
  readonly byDepth: readonly number[];
  /**
   * Веер первого хопа не поместился в graphHop2Seeds, часть окрестности во
   * второй хоп не пошла. Не ошибка, но и не мелочь: выдача зависит от
   * потолка, и это должно быть видно, а не выясняться замером.
   */
  readonly hop2Capped: boolean;
  /** Сколько узлов из обхода реально дошло до выдачи. */
  readonly inHits: number;
}

export interface HybridHit {
  readonly id: string;
  /** Позиция в итоговой выдаче, 1 = лучший. */
  readonly rank: number;
  /** final(d) = score_rrf(d) × boost(d). */
  readonly score: number;
  /** Чистый RRF до бустов. */
  readonly rrf: number;
  /** Источники, в которых узел встретился. */
  readonly sources: readonly HybridSource[];
  /**
   * Глубина обхода, на которой узел найден: 1 — сосед лексического сида,
   * 2 — сосед соседа. undefined — узел найден лексикой или вектором, а не
   * обходом.
   */
  readonly graphDepth?: number;
  /** Ранг в лексическом источнике (undefined — не найден). */
  readonly ftsRank?: number;
  /** Ранг в векторном источнике (undefined — ветка не звалась или не нашла). */
  readonly vecRank?: number;
  /** Косинусная дистанция векторного хита (undefined — вектор не участвовал). */
  readonly vecDistance?: number;
  /**
   * НАСКОЛЬКО этот хит ближе среднего кандидата векторного пула этого же
   * запроса, в стандартных отклонениях: (poolMean − distance) / poolStd.
   * Положительное и большое — хит выделяется на фоне остальной выдачи,
   * около нуля — неотличим от случайного соседа (myc-ye3.9, S47: разделение
   * близких/далёких пар на этой модели ~0.058 — сигнал слабый, поэтому и
   * значение обычно скромное). undefined — вектор не участвовал или пул
   * кандидатов был меньше 3.
   */
  readonly vecConfidence?: number;
  readonly kind: string;
  readonly layer: number;
  readonly priority: number;
  readonly updatedAt: number;
  readonly title: string;
  readonly excerpt: string;
}

/** Что именно проверил триггер — целиком, а не только сработавшее. */
export interface HybridTrigger {
  readonly fired: boolean;
  /** Коды: few_results | low_bm25_spread | short_query_no_anchor | lexical_fallback. */
  readonly reasons: readonly string[];
  readonly checks: {
    readonly fewResults: boolean;
    readonly lowBm25Spread: boolean;
    readonly shortQueryNoAnchor: boolean;
    /**
     * Строгое И дало ноль и пул собран откатом на ИЛИ. Это самый сильный из
     * четырёх сигналов и добавлен вместе с самим откатом (S44): пустое И
     * означает, что слово запроса не встретилось в тексте дословно, а вектор
     * заведён ровно для такого случая — S32 показал recall@10 = 0 на
     * перефразировках без него. Без этого критерия откат бы ЗАГЛУШИЛ вектор:
     * ИЛИ почти всегда набирает больше minLexicalHits, и `few_results` после
     * него не срабатывает никогда.
     */
    readonly lexicalFallback: boolean;
  };
  /** Сработала ли оговорка про найденный якорь (см. anchorHitSuppressesFewResults). */
  readonly anchorHit: boolean;
  readonly metrics: {
    readonly lexicalHits: number;
    /** (best − median) / best по модулю BM25; NaN — кандидатов меньше spreadMinHits. */
    readonly bm25Spread: number;
    readonly queryTerms: number;
    readonly anchorTerms: number;
  };
}

export type VectorDisposition =
  | "used" // ветка отработала и дала кандидатов
  | "empty" // ветка отработала, но кандидатов нет
  | "skipped" // триггер не сработал — вектор намеренно не звали
  | "disabled" // явный vectorMode: "never"
  | "unavailable" // вектор нужен был, но эмбеддинга нет (нет кеша/эмбеддера)
  | "degraded"; // источник вернул degraded (нет vec0 и т. п.)

/**
 * Какой лексический оператор реально дал пул. Часть mode_used, а не деталь
 * реализации: выдача по ИЛИ шире выдачи по И, и пользователь обязан видеть,
 * что смотрит на расширенный набор (S44, И2).
 */
export interface HybridLexical {
  /** Чем собран пул: строгое И или одна из ступеней отката (S44). */
  readonly operator: LexicalOperator;
  /** ИЛИ выполнено как ОТКАТ после пустого И (а не как режим or_always). */
  readonly fallbackUsed: boolean;
  /** Сколько кандидатов дало строгое И (0 — ровно тот случай, ради которого откат). */
  readonly andHits: number;
  /** Сколько кандидатов в итоговом лексическом пуле. */
  readonly hits: number;
  /** Число терминов после разбора запроса. */
  readonly terms: number;
  /** Сколько ступеней отката было выполнено (0 — строгое И справилось само). */
  readonly stagesTried: number;
  /** Ранжирование ИЛИ-пула учло покрытие терминов (буст полного совпадения). */
  readonly coverageApplied: boolean;
}

/**
 * ПОЧЕМУ ВЫДАЧА ПУСТА. И2 в чистом виде: «ничего не нашлось» и «ветка, которая
 * могла бы найти, не участвовала» и «база пуста» — три разные новости, и
 * пользователь обязан их различать. undefined — выдача непуста.
 */
export interface HybridEmptyReason {
  readonly code:
    | "empty_query" // после разбора не осталось ни одного терма
    | "no_scopes" // запрос без partition key
    | "store_empty" // в ярусе нет ни одного видимого узла
    | "no_match"; // база непуста, но ни один узел не совпал
  readonly text: string;
  /**
   * Сколько узлов вообще видно вызывающему в этом ярусе (с учётом скоупа, слоёв
   * и ACL). Считается ОДНИМ дополнительным запросом и ТОЛЬКО когда выдача
   * пуста: в этот момент горячий путь уже ничего не делает, а без этого числа
   * «не нашлось» неотличимо от «нечего было находить». Потолок счёта — 1000
   * (см. hybridCorpusSize), выше отдаётся `atLeast: true`.
   */
  readonly corpusSize: number;
  readonly corpusAtLeast: boolean;
}

/**
 * Честный отчёт о режиме. Обязателен в каждом ответе (И2): пользователь не
 * должен гадать, почему выдача изменилась.
 */
export interface HybridModeUsed {
  readonly sources: readonly HybridSource[];
  readonly vector: VectorDisposition;
  /** Каким оператором собран лексический пул (S44). */
  readonly lexical: HybridLexical;
  /**
   * Лексика дала ноль кандидатов и вся непустая выдача держится на одном
   * слабом векторе, без единого лексического подтверждения (myc-ye3.9, И2:
   * это должно быть видно, а не выводиться из сопоставления lexical.hits и
   * sources). false и когда выдача пуста.
   */
  readonly vectorOnly: boolean;
  /** Заполнено ровно тогда, когда hits пуст. */
  readonly emptyReason?: HybridEmptyReason;
  /** Одной строкой, для CLI/MCP и логов. */
  readonly why: string;
  readonly trigger: HybridTrigger;
  /**
   * Точный счётчик SQL-операторов, которые выпустил САМ hybridSearch.
   * В лексическом режиме всегда 1: пул, обход графа и гидратация — один
   * оператор. Это не оценка, это счётчик.
   */
  readonly roundTrips: number;
  /**
   * ОЦЕНКА числа запросов делегированного векторного источника (сам он их не
   * возвращает; форма outcome позволяет их восстановить). Помечено оценкой
   * честно: если источник подменён, число к нему не относится.
   */
  readonly vectorRoundTrips: number;
  /** Причины деградации (И2). Пустой массив — деградации не было. */
  readonly degraded: readonly string[];
  /**
   * Откуда взяты сиды обхода графа. Всегда "lexical": граф идёт в том же
   * round-trip, что и лексика, то есть до решения о векторе.
   */
  readonly graphSeeds: "lexical";
  /** Что сделал обход графа: глубина, сколько узлов дал каждый хоп (И2). */
  readonly graph: HybridGraph;
  /**
   * Кеш результатов (./cache.ts, §2.6): "hit" — ответ отдан из памяти
   * процесса, "miss" — посчитан и положен в кеш, "off" — кеш не передан.
   * Обязано быть видно (И2, тот же образец, что "cache hit"/"cache miss"
   * в подвале `myc prime`): попадание в кеш меняет цену ответа на два
   * порядка, и пользователь не должен об этом гадать.
   *
   * При "hit" `sources`, `vector`, `lexical`, `trigger` описывают ОТВЕТ
   * (как он был посчитан), а `roundTrips`/`vectorRoundTrips` — ЭТОТ вызов:
   * он выпустил ровно один statement, чтение хвоста оплога.
   */
  readonly cache: CacheDisposition;
}

export interface HybridResult {
  readonly hits: readonly HybridHit[];
  readonly mode_used: HybridModeUsed;
}

/** Подменяемый векторный источник — по умолчанию ./vector.ts:vectorSearch. */
export type HybridVectorSource = (db: DbDriver, params: VectorSearchParams) => VectorSearchOutcome;

export interface HybridSearchParams {
  readonly text: string;
  readonly scopes: readonly string[];
  readonly layerMin?: Layer;
  readonly layerMax?: Layer;
  readonly caller: FtsCaller;
  readonly limit?: number;
  readonly now?: number;
  readonly config?: Partial<HybridConfig>;
  /**
   * Ленивый поставщик эмбеддинга запроса (S31: вектор приходит снаружи).
   * ВЫЗЫВАЕТСЯ ТОЛЬКО ЕСЛИ СРАБОТАЛ ТРИГГЕР — здесь и экономятся 23 мс.
   * Возвращает null, если эмбеддинга нет (нет ключа/кеша/модели): это
   * деградация, она попадает в mode_used, а не глушится.
   */
  readonly embedQuery?: () => Float32Array | null;
  /** "auto" (по умолчанию) | "always" — обязательный вектор | "never". */
  readonly vectorMode?: "auto" | "always" | "never";
  /** Подмена источника (тесты, бенч). */
  readonly vectorSource?: HybridVectorSource;
  /**
   * LRU результатов (./cache.ts). Передан — попадание отдаётся за одно
   * чтение хвоста оплога; не передан — кеша нет и `mode_used.cache` = "off".
   * Владеет кешем ВЫЗЫВАЮЩИЙ: он живёт столько же, сколько процесс, а
   * hybridSearch — функция без состояния.
   */
  readonly cache?: SearchResultCache<HybridResult>;
  /** Часы для TTL кеша; по умолчанию Date.now. Инжектируются тестами. */
  readonly cacheClock?: () => number;
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

// ============================ SQL ===========================================

// Фильтр ACL повторяется дословно в обоих запросах — он обязан быть ВНУТРИ
// источника, до ранжирования (§2.2, урок TencentDB), иначе top-100 вымывается
// фильтром уже после отбора.
const ACL_PREDICATE = `
      (
        (n.acl = 'private' AND n.owner_id = ?5)
        OR (n.acl = 'team' AND n.team_id = ?6)
        OR (n.acl = 'agent' AND n.agent_id = ?7)
        OR (n.acl = 'restricted' AND EXISTS (
              SELECT 1 FROM acl_grants g
              WHERE g.node_id = n.id
                AND g.principal IN (SELECT value FROM json_each(?8))
            ))
      )`;

/**
 * Тот же предикат с другой нумерацией плейсхолдеров. Нужен потому, что
 * validateQueryDef требует СПЛОШНОЙ нумерации 1..N в каждом запросе: запрос с
 * другим числом ведущих параметров не может переиспользовать ACL_PREDICATE
 * дословно, а копия предиката — ровно тот способ, которым ACL расходится между
 * запросами и появляется дыра.
 */
function aclPredicate(owner: number): string {
  return `
      (
        (n.acl = 'private' AND n.owner_id = ?${owner})
        OR (n.acl = 'team' AND n.team_id = ?${owner + 1})
        OR (n.acl = 'agent' AND n.agent_id = ?${owner + 2})
        OR (n.acl = 'restricted' AND EXISTS (
              SELECT 1 FROM acl_grants g
              WHERE g.node_id = n.id
                AND g.principal IN (SELECT value FROM json_each(?${owner + 3}))
            ))
      )`;
}

export const hybridQueries = defineQueries({
  // Один оператор = один round-trip: лексический пул + ранг + BM25-скор
  // (нужен триггеру, поэтому отдаём его, а не только ранг) + обход графа на
  // 1–2 хопа от лексических сидов + гидратация всех найденных узлов.
  //
  // ЦЕНА ОБХОДА, замер bench/graph-eval.ts --latency (100k узлов, 320k рёбер,
  // средняя степень ~3 плюс 100 хабов по 200 рёбер, 200 итераций):
  //
  //   вариант             p50      p95      p99    надбавка к «выключено»
  //   выключен          5.01 мс  8.84 мс  9.38 мс          —
  //   1 хоп             5.09 мс 10.15 мс 10.68 мс   p95 +1.31, p99 +1.30
  //   1–2 хопа          5.12 мс 10.55 мс 11.09 мс   p95 +1.71, p99 +1.70
  //   1–2 без потолков  5.25 мс 32.26 мс 34.94 мс   p95 +23.42, p99 +25.55
  //
  // Последняя строка — не иллюстрация, а причина существования двух LIMIT'ов
  // ниже: без них цену обхода назначает самый связный узел окрестности, и
  // бюджет поиска в 25 мс (И1) пробивается на ровном месте.
  hybridLexicalPass: {
    name: "hybridLexicalPass",
    sql: `
      WITH matches AS MATERIALIZED (
        SELECT n.id AS node_id,
               bm25(nodes_fts, 10.0, 1.0, 1.0) AS bm25_score
        FROM nodes_fts f
        JOIN nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ?1
          AND n.deleted_at IS NULL
         ${historyClause("follow")}
          AND n.status <> 'superseded'
          AND n.scope IN (SELECT value FROM json_each(?2))
          AND n.layer BETWEEN ?3 AND ?4
          AND ${ACL_PREDICATE}
      ),
      pool AS (
        SELECT node_id, MIN(bm25_score) AS bm25_score
        FROM matches
        GROUP BY node_id
        ORDER BY bm25_score ASC
        LIMIT ?9
      ),
      -- MATERIALIZED IS REQUIRED, and not "just in case". lex is read in
      -- four places (seeds, first-hop anti-join, second-hop anti-join, the
      -- final union), and without the hint SQLite recomputes the CTE on
      -- EVERY reference: GROUP BY + ORDER BY over the whole matches pool
      -- again, which on the OR fallback holds tens of thousands of rows.
      -- Measured at 100k (./hybrid.fallback.test.ts): without the hint, adding
      -- the second hop raised p95 from 14.4 to 26.7 ms — the cost was not the
      -- walk, it was the fourth re-sort of the pool.
      lex AS MATERIALIZED (
        SELECT node_id, bm25_score, RANK() OVER (ORDER BY bm25_score ASC) AS r
        FROM pool
      ),
      seeds AS (
        SELECT node_id, r FROM lex WHERE r <= ?10
      ),
      hop1_raw AS (
        -- CROSS JOIN here is not a cartesian product but an order hint
        -- (SQLite guarantees the left table is the outer one). Without it the
        -- planner enters from edges and SCANS them whole instead of taking
        -- 15 seeds and doing 15 PK seeks. On a 100k corpus that cost 4.7 ms
        -- versus 0.8 ms — EXPLAIN QUERY PLAN showed "SCAN e" instead of
        -- "SEARCH e USING PRIMARY KEY (src=?)".
        SELECT e.dst AS node_id, s.node_id AS via_id, s.r AS via_rank,
               e.weight AS w, e.type AS etype
        FROM seeds s CROSS JOIN edges e ON e.src = s.node_id
        WHERE e.deleted_at IS NULL AND e.weight >= ?11
        UNION ALL
        SELECT e.src AS node_id, s.node_id AS via_id, s.r AS via_rank,
               e.weight AS w, e.type AS etype
        FROM seeds s CROSS JOIN edges e ON e.dst = s.node_id
        WHERE e.deleted_at IS NULL AND e.weight >= ?11
      ),
      hop1_ranked AS (
        SELECT node_id, via_id, via_rank, w, etype,
               ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY via_rank ASC, w DESC) AS rn
        FROM hop1_raw
        WHERE node_id NOT IN (SELECT node_id FROM lex)
      ),
      -- MATERIALIZED is required: hop1 is read three times (second-hop seeds,
      -- second-hop anti-join, the final union). Without the hint SQLite
      -- recomputes the CTE on every reference, i.e. walks the first hop
      -- three times instead of once.
      hop1 AS MATERIALIZED (
        SELECT node_id, via_id, via_rank, w, etype FROM hop1_ranked WHERE rn = 1
        ORDER BY via_rank ASC, w DESC, node_id ASC
        LIMIT ?13
      ),
      -- THE SECOND-HOP FAN-OUT IS CAPPED BY CONFIG (?12), not by the data:
      -- otherwise the walk costs the degree of the best-connected nearby node.
      -- ?12 = 0 (graphMaxHops < 2) gives LIMIT 0, and the whole second hop
      -- collapses to an empty set before edges is even touched.
      hop2_seeds AS MATERIALIZED (
        SELECT node_id, via_rank FROM hop1
        ORDER BY via_rank ASC, w DESC, node_id ASC
        LIMIT ?12
      ),
      hop2_raw AS (
        SELECT e.dst AS node_id, s.node_id AS via_id, s.via_rank AS via_rank,
               e.weight AS w, e.type AS etype
        FROM hop2_seeds s CROSS JOIN edges e ON e.src = s.node_id
        WHERE e.deleted_at IS NULL AND e.weight >= ?11
        UNION ALL
        SELECT e.src AS node_id, s.node_id AS via_id, s.via_rank AS via_rank,
               e.weight AS w, e.type AS etype
        FROM hop2_seeds s CROSS JOIN edges e ON e.dst = s.node_id
        WHERE e.deleted_at IS NULL AND e.weight >= ?11
      ),
      hop2_ranked AS (
        -- The anti-join with hop1 is a COST limit, not a correctness one: a node
        -- reachable in one hop and in two is kept once anyway, by the best
        -- path, when merging (see expandedById). The mutation "drop this
        -- line" fails no test — it hurts cost: without it the same node is
        -- hydrated twice. Written down here so the line is not removed as
        -- dead code.
        SELECT node_id, via_id, via_rank, w, etype,
               ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY via_rank ASC, w DESC) AS rn
        FROM hop2_raw
        WHERE node_id NOT IN (SELECT node_id FROM lex)
          AND node_id NOT IN (SELECT node_id FROM hop1)
      ),
      hop2 AS (
        SELECT node_id, via_id, via_rank, w, etype FROM hop2_ranked WHERE rn = 1
        ORDER BY via_rank ASC, w DESC, node_id ASC
        LIMIT ?13
      ),
      merged AS (
        SELECT node_id, bm25_score, r AS fts_rank,
               NULL AS via_id, NULL AS edge_weight, NULL AS edge_type, 0 AS depth
        FROM lex
        UNION ALL
        SELECT node_id, NULL AS bm25_score, NULL AS fts_rank,
               via_id, w AS edge_weight, etype AS edge_type, 1 AS depth
        FROM hop1
        UNION ALL
        SELECT node_id, NULL AS bm25_score, NULL AS fts_rank,
               via_id, w AS edge_weight, etype AS edge_type, 2 AS depth
        FROM hop2
      )
      SELECT m.node_id     AS id,
             m.fts_rank    AS fts_rank,
             m.bm25_score  AS bm25,
             m.via_id      AS via_id,
             m.edge_weight AS edge_weight,
             m.edge_type   AS edge_type,
             m.depth       AS depth,
             n.kind        AS kind,
             n.layer       AS layer,
             n.priority    AS priority,
             n.updated_at  AS updated_at,
             n.title       AS title,
             n.excerpt     AS excerpt
      -- CROSS JOIN is required here too: nodes has an index on scope, and
      -- the planner is tempted to enter from nodes, reading thousands of the
      -- scope's rows only to look them up in merged. The order "merged first
      -- (a hundred rows), then seek by id" is an order of magnitude faster.
      FROM merged m
      CROSS JOIN nodes n ON n.id = m.node_id
      WHERE n.deleted_at IS NULL
       ${historyClause("follow")}
        AND n.status <> 'superseded'
        AND n.scope IN (SELECT value FROM json_each(?2))
        AND n.layer BETWEEN ?3 AND ?4
        AND ${ACL_PREDICATE}
      ORDER BY (m.fts_rank IS NULL), m.fts_rank ASC, m.node_id ASC
    `,
    params: [
      "q",
      "scopes",
      "layer_min",
      "layer_max",
      "owner_id",
      "team_id",
      "agent_id",
      "principals",
      "pool",
      "seeds",
      "min_edge_weight",
      "hop2_seeds",
      "hop_fanout",
    ],
  },

  // Покрытие терминов на ИЛИ-пуле (S44): сколько РАЗНЫХ терминов запроса
  // встретилось в каждом узле пула. Выполняется только на откате и только при
  // orCoverageWeight > 0.
  //
  // Почему отдельным запросом, а не колонкой в самом ИЛИ-проходе: bm25() в
  // FTS5 нельзя вызвать, когда строка MATCH приходит из внешнего цикла
  // (`unable to use function bm25 in the requested context` — проверено), а
  // без bm25 ранжировать нечем. Поэтому счёт покрытия и счёт релевантности —
  // два запроса: первый даёт скор, второй — покрытие, слияние в TS.
  //
  // Ограничение пула по id обязательно: без него COUNT(DISTINCT) считался бы
  // по всем постинг-листам целиком, а нужен он ровно на сотне кандидатов,
  // которые уже отобраны.
  hybridOrCoverage: {
    name: "hybridOrCoverage",
    sql: `
      WITH t AS (SELECT value AS q FROM json_each(?1)),
           ids AS (SELECT value AS id FROM json_each(?2))
      SELECT n.id AS id, COUNT(DISTINCT t.q) AS cov
      FROM t
      JOIN nodes_fts f ON nodes_fts MATCH t.q
      JOIN nodes n ON n.rowid = f.rowid
      JOIN ids ON ids.id = n.id
      GROUP BY n.id
    `,
    params: ["terms", "ids"],
  },

  // Сколько узлов вообще видно вызывающему — для объяснения ПУСТОЙ выдачи
  // (И2). Считается только когда выдача пуста, и с потолком 1000: точное
  // число нужно лишь около нуля («база пуста» против «не нашлось»), а выше
  // достаточно знать, что узлов много.
  hybridCorpusSize: {
    name: "hybridCorpusSize",
    sql: `
      SELECT count(*) AS n FROM (
        SELECT 1
        FROM nodes n
        WHERE n.deleted_at IS NULL
         ${historyClause("follow")}
          AND n.status <> 'superseded'
          AND n.scope IN (SELECT value FROM json_each(?1))
          AND n.layer BETWEEN ?2 AND ?3
          AND ${aclPredicate(4)}
        LIMIT 1001
      )
    `,
    params: ["scopes", "layer_min", "layer_max", "owner_id", "team_id", "agent_id", "principals"],
  },

  // Гидратация узлов, которые нашлись ТОЛЬКО вектором. Единственный запрос,
  // который добавляет условная ветка сверх своей собственной стоимости.
  hybridHydrate: {
    name: "hybridHydrate",
    sql: `
      SELECT n.id       AS id,
             n.kind     AS kind,
             n.layer    AS layer,
             n.priority AS priority,
             n.updated_at AS updated_at,
             n.title    AS title,
             n.excerpt  AS excerpt
      FROM nodes n
      WHERE n.id IN (SELECT value FROM json_each(?1))
        AND n.deleted_at IS NULL
       ${historyClause("follow")}
        AND n.status <> 'superseded'
        AND n.scope IN (SELECT value FROM json_each(?2))
        AND n.layer BETWEEN ?3 AND ?4
        AND ${ACL_PREDICATE}
    `,
    params: [
      "ids",
      "scopes",
      "layer_min",
      "layer_max",
      "owner_id",
      "team_id",
      "agent_id",
      "principals",
    ],
  },
});

interface LexicalRow {
  readonly id: string;
  readonly fts_rank: number | null;
  readonly bm25: number | null;
  readonly via_id: string | null;
  readonly edge_weight: number | null;
  readonly edge_type: string | null;
  /** 0 — лексический хит, 1 и 2 — глубина обхода. */
  readonly depth: number;
  readonly kind: string;
  readonly layer: number;
  readonly priority: number;
  readonly updated_at: number;
  readonly title: string;
  readonly excerpt: string;
}

interface NodeRow {
  readonly id: string;
  readonly kind: string;
  readonly layer: number;
  readonly priority: number;
  readonly updated_at: number;
  readonly title: string;
  readonly excerpt: string;
}

// ============================ RRF и бусты ===================================

/**
 * RRF ровно по §2.2: score = Σ_i w_i / (k + rank_i), отсутствие в источнике —
 * не пропуск слагаемого, а штрафной ранг missingRank. Разница существенная:
 * при пропуске узел, найденный одним источником, получал бы столько же, сколько
 * найденный обоими, и слияние переставало бы что-либо значить.
 */
export function rrfScore(
  ranks: { readonly fts?: number; readonly vec?: number },
  cfg: Pick<HybridConfig, "rrfK" | "missingRank" | "weightFts" | "weightVec">,
): number {
  const rf = ranks.fts ?? cfg.missingRank;
  const rv = ranks.vec ?? cfg.missingRank;
  return cfg.weightFts / (cfg.rrfK + rf) + cfg.weightVec / (cfg.rrfK + rv);
}

/**
 * Квант свежести: сутки. Свежесть — единственный множитель boost(d), который
 * зависит от ЧАСОВ, и её разрешение обязано совпадать с её же смыслом.
 *
 * Без кванта `ageDays` — непрерывная величина миллисекундного разрешения под
 * кривой с постоянной времени `freshnessTauDays` (умолчание 90 суток). Разница
 * в 1 мс даёт относительную поправку к счёту порядка 1e-11 — величину, которая
 * ничего не значит для «свежести», но ПОЛНОСТЬЮ решает порядок выдачи: две
 * одинаково релевантные строки никогда не получают ТОЧНО равный score, и
 * детерминированный тайбрейк по id (сортировка ниже) не срабатывает никогда.
 *
 * Следствие, ради которого квант и введён (memory-tf9rgg0rkp6h): любая запись в
 * узел двигает `nodes.updated_at` на wall-clock, поэтому ФОНОВАЯ служебная
 * запись — классификация absorb в хвосте дренажа — молча переставляла строки
 * местами. Два агента, спросившие одно и то же с разницей в секунду, получали
 * разный ответ, и в выдаче этому не было объяснения. С квантом сутки такая
 * запись не меняет ни счёт, ни порядок: она не выводит узел из его суток.
 *
 * Тем же квантом снимается вторая нестабильность — дрожание счёта от движения
 * САМОГО `now` между двумя вызовами на неизменной базе.
 *
 * Цена честная и мала: внутри суток свежесть перестаёт различать узлы. При
 * tau = 90 суток вся разница за сутки — 0.25·(1 − e^(−1/90)) ≈ 0.0028, то есть
 * ~0.28 % буста; это заведомо ниже шага RRF между соседними рангами, поэтому
 * квант выбрасывает шум, а не сигнал.
 */
export const FRESHNESS_QUANTUM_MS = 86_400_000;

/**
 * boost(d) из §2.2: приоритет × свежесть × вес слоя.
 *
 * Все три множителя берутся ИЗ КОНФИГА, ни одного числа в теле функции.
 * Обнулить любой из них (или все три сразу — NO_BOOST_OVERRIDES) можно, не
 * трогая код: именно это и делает замер bench/boost-eval.ts, снимая точку
 * «без бустов» на том же корпусе, что и точку «с бустами».
 *
 * Возраст квантуется сутками — см. FRESHNESS_QUANTUM_MS. Это не тюнинг
 * (амплитуда и tau по-прежнему из конфига), а разрешение самой величины.
 */
export type BoostConfig = Pick<
  HybridConfig,
  | "profile"
  | "priorityBoostP0"
  | "priorityBoostP1"
  | "priorityPenaltyP3"
  | "freshnessAmplitude"
  | "freshnessTauDays"
  | "layerWeights"
>;

export function boostOf(
  node: { readonly priority: number; readonly layer: number; readonly updatedAt: number },
  now: number,
  cfg: BoostConfig,
): number {
  const p = node.priority;
  const priority =
    1 +
    (p === 0 ? cfg.priorityBoostP0 : 0) +
    (p === 1 ? cfg.priorityBoostP1 : 0) -
    (p === 3 ? cfg.priorityPenaltyP3 : 0);
  // floor, а не деление: возраст округляется ВНИЗ до целых суток, поэтому
  // мелкое движение updated_at (или now) не выводит узел из его кванта.
  const ageDays = Math.max(0, Math.floor((now - node.updatedAt) / FRESHNESS_QUANTUM_MS));
  const freshness = 1 + cfg.freshnessAmplitude * Math.exp(-ageDays / cfg.freshnessTauDays);
  const weights = cfg.layerWeights[cfg.profile] ?? DEFAULT_LAYER_WEIGHTS[cfg.profile];
  const layerW = weights[Math.min(3, Math.max(0, node.layer)) as 0 | 1 | 2 | 3];
  return priority * freshness * layerW;
}

/**
 * Полное обнуление бустов одним объектом: boost(d) ≡ 1 при любом узле.
 *
 * Это не «режим для тестов», а вторая точка замера (bench/boost-eval.ts) и
 * мутация, которой проверяется, что бусты не декоративны: если метрика с
 * этими накладками не меняется, значит бусты не работают.
 */
export const NO_BOOST_OVERRIDES: Partial<HybridConfig> = Object.freeze({
  priorityBoostP0: 0,
  priorityBoostP1: 0,
  priorityPenaltyP3: 0,
  freshnessAmplitude: 0,
  layerWeights: Object.freeze({
    prime: [1, 1, 1, 1],
    deep: [1, 1, 1, 1],
    balanced: [1, 1, 1, 1],
  }) as Readonly<Record<HybridProfile, readonly [number, number, number, number]>>,
});

/**
 * Относительный разброс BM25 в пуле. fts5 возвращает отрицательные скоры
 * (чем меньше, тем лучше), поэтому работаем с модулями: m = −score.
 * Возвращает NaN, если кандидатов меньше spreadMinHits — на двух точках
 * «разброс» ничего не значит и триггерить по нему нельзя.
 */
export function bm25Spread(scores: readonly number[], minHits: number): number {
  if (scores.length < minHits) return Number.NaN;
  const m = scores.map((s) => -s).sort((a, b) => b - a);
  const top = m[0]!;
  const median = m[Math.floor(m.length / 2)]!;
  if (!(top > 0)) return 0;
  return (top - median) / top;
}

// ============================ триггер =======================================

/**
 * Решение «звать ли вектор» по трём независимым критериям. Любой сработавший
 * включает ветку — критерии описывают разные способы, которыми лексика может
 * не справиться, и складывать их в один скор значило бы придумать четвёртый
 * порог без данных.
 */
export function evaluateTrigger(
  text: string,
  bm25Scores: readonly number[],
  cfg: HybridConfig,
  lexicalFallback = false,
): HybridTrigger {
  const terms = tokenizeQuery(text);
  const anchors = terms.filter(isAnchorToken).length;
  const spread = bm25Spread(bm25Scores, cfg.spreadMinHits);

  const anchorHit = anchors > 0 && bm25Scores.length > 0;
  const fewResults =
    bm25Scores.length < cfg.minLexicalHits &&
    !(cfg.anchorHitSuppressesFewResults && anchorHit);
  const lowBm25Spread = Number.isFinite(spread) && spread < cfg.minBm25Spread;
  const shortQueryNoAnchor = terms.length <= cfg.shortQueryTerms && anchors === 0;

  const reasons: string[] = [];
  if (fewResults) reasons.push("few_results");
  if (lowBm25Spread) reasons.push("low_bm25_spread");
  if (shortQueryNoAnchor) reasons.push("short_query_no_anchor");
  if (lexicalFallback) reasons.push("lexical_fallback");

  return {
    fired: reasons.length > 0,
    reasons,
    checks: { fewResults, lowBm25Spread, shortQueryNoAnchor, lexicalFallback },
    anchorHit,
    metrics: {
      lexicalHits: bm25Scores.length,
      bm25Spread: spread,
      queryTerms: terms.length,
      anchorTerms: anchors,
    },
  };
}

// ============================ поиск =========================================

interface Candidate {
  id: string;
  ftsRank?: number;
  vecRank?: number;
  /** Косинусная дистанция до запроса — сырой сигнал качества векторного хита. */
  vecDistance?: number;
  graphScore?: number;
  node: NodeRow;
  sources: Set<HybridSource>;
}

/** Обхода не было — но поле обязано быть, чтобы «не искали» и «не нашли» различались. */
const EMPTY_GRAPH: HybridGraph = Object.freeze({
  maxHops: 0,
  byDepth: Object.freeze([]) as readonly number[],
  hop2Capped: false,
  inHits: 0,
});

const EMPTY_TRIGGER: HybridTrigger = {
  fired: false,
  reasons: [],
  checks: {
    fewResults: true,
    lowBm25Spread: false,
    shortQueryNoAnchor: false,
    lexicalFallback: false,
  },
  anchorHit: false,
  metrics: { lexicalHits: 0, bm25Spread: Number.NaN, queryTerms: 0, anchorTerms: 0 },
};

const EMPTY_LEXICAL: HybridLexical = {
  operator: "and",
  fallbackUsed: false,
  andHits: 0,
  hits: 0,
  terms: 0,
  stagesTried: 0,
  coverageApplied: false,
};

function emptyResult(
  why: string,
  roundTrips: number,
  emptyReason: HybridEmptyReason,
  degraded: string[] = [],
): HybridResult {
  return {
    hits: [],
    mode_used: {
      sources: [],
      vector: "skipped",
      lexical: EMPTY_LEXICAL,
      vectorOnly: false,
      emptyReason,
      why,
      trigger: EMPTY_TRIGGER,
      roundTrips,
      vectorRoundTrips: 0,
      degraded,
      graphSeeds: "lexical",
      graph: EMPTY_GRAPH,
      cache: "off",
    },
  };
}

/**
 * Годится ли ответ в кеш. Деградированный — НЕТ: он верен ровно сейчас
 * (эмбеддер грузится, vec0 не подключён), и заморозить его на TTL значит
 * продлить деградацию после того, как она кончилась (И2, п. 6 ./cache.ts).
 */
function isCacheable(result: HybridResult): boolean {
  const m = result.mode_used;
  if (m.degraded.length > 0) return false;
  return m.vector !== "unavailable" && m.vector !== "degraded";
}

/** Тот же ответ с проставленным полем cache (и честными счётчиками на hit). */
function withCache(
  result: HybridResult,
  disposition: CacheDisposition,
  roundTrips?: number,
): HybridResult {
  return {
    hits: result.hits,
    mode_used: {
      ...result.mode_used,
      cache: disposition,
      ...(roundTrips === undefined
        ? {}
        : { roundTrips, vectorRoundTrips: 0 }),
    },
  };
}

/**
 * Гибридный поиск с кешем результатов (§2.6). Без `params.cache` —
 * поведение прежнее, один в один: кеш подключается вызывающим, а не
 * появляется сам.
 *
 * ПОЧЕМУ ХВОСТ ОПЛОГА ЧИТАЕТСЯ ДО ВСЕГО. Валидация кеша обязана видеть
 * запись СОСЕДНЕГО процесса, поэтому версия базы берётся из базы одним
 * statement (`MAX(seq) FROM oplog`, спуск по rowid) на каждый запрос, а не
 * из памяти. Это единственная плата за кеш на промахе.
 */
export function hybridSearch(db: DbDriver, params: HybridSearchParams): HybridResult {
  const cache = params.cache;
  if (cache === undefined) return withCache(runHybrid(db, params), "off");

  const seq = readOplogSeq(db);
  const key = searchCacheKey({
    text: params.text,
    scopes: params.scopes,
    layerMin: params.layerMin ?? 0,
    layerMax: params.layerMax ?? 3,
    limit: clampLimit(params.limit),
    vectorMode: params.vectorMode ?? "auto",
    caller: params.caller,
    config: { ...DEFAULT_HYBRID_CONFIG, ...params.config },
  });
  const nowMs = (params.cacheClock ?? Date.now)();

  const found = cache.get(key, seq, nowMs);
  if (found.outcome === "hit") return withCache(found.value, "hit", 1);

  const result = runHybrid(db, params);
  cache.set(key, seq, nowMs, result, isCacheable(result));
  return withCache(result, "miss", result.mode_used.roundTrips + 1);
}

function runHybrid(db: DbDriver, params: HybridSearchParams): HybridResult {
  const cfg: HybridConfig = { ...DEFAULT_HYBRID_CONFIG, ...params.config };
  const limit = clampLimit(params.limit);
  const now = params.now ?? Date.now();
  const layerMin = params.layerMin ?? 0;
  const layerMax = params.layerMax ?? 3;
  const degraded: string[] = [];
  let roundTrips = 0;
  let vectorRoundTrips = 0;

  const parsed = analyzeFtsQuery(params.text);
  const aclArgs = [
    params.caller.ownerId,
    params.caller.teamId,
    params.caller.agentId,
    JSON.stringify(params.caller.principals),
  ];
  const scopesJson = JSON.stringify([...params.scopes]);

  /**
   * Размер видимого корпуса — только для объяснения пустоты (И2). Стоит один
   * запрос и делается ИСКЛЮЧИТЕЛЬНО когда выдача уже пуста, то есть никогда не
   * попадает в горячий путь успешного поиска.
   */
  const corpus = (): { size: number; atLeast: boolean } => {
    if (params.scopes.length === 0) return { size: 0, atLeast: false };
    roundTrips++;
    const n =
      db.all<{ n: number }>(hybridQueries.hybridCorpusSize, [
        scopesJson,
        layerMin,
        layerMax,
        ...aclArgs,
      ])[0]?.n ?? 0;
    return { size: Math.min(n, 1000), atLeast: n > 1000 };
  };

  if (parsed === null) {
    const c = corpus();
    return emptyResult("empty query: no terms left after parsing", roundTrips, {
      code: "empty_query",
      text:
        "query contains no words: no terms left after parsing — " +
        "nothing to search for, the database is not the cause",
      corpusSize: c.size,
      corpusAtLeast: c.atLeast,
    });
  }
  if (params.scopes.length === 0) {
    return emptyResult(
      "empty scope list: a query without a partition key is not run (S27)",
      roundTrips,
      {
        code: "no_scopes",
        text: "a query without a partition key (empty scope list) is not run — S27",
        corpusSize: 0,
        corpusAtLeast: false,
      },
    );
  }

  // ГЛУБИНА ОБХОДА -> ПАРАМЕТРЫ SQL. Выключение расширения и ограничение
  // одним хопом делаются НЕ ветвлением в TS, а нулями в аргументах запроса:
  // ноль сидов -> пустой хоп -> обхода нет вовсе. Иначе «расширение
  // отключено» стоило бы ту же цену, что включённое, и мутация не измеряла бы
  // ничего, кроме сортировки в памяти.
  const hopSeeds = cfg.graphMaxHops >= 1 ? cfg.graphSeeds : 0;
  const hop2Seeds =
    cfg.graphMaxHops >= 2 && cfg.graphDecayByHop.length >= 2 ? cfg.graphHop2Seeds : 0;

  // ---- проход 1: лексика + граф + гидратация, ОДИН round-trip --------------
  //
  // S44. Проход выделен в функцию, потому что выполняется дважды: строгим И и,
  // если И дало ноль, тем же оператором по строке ИЛИ. Второй вызов — это не
  // «ещё один режим», а буквально тот же SQL с другой строкой MATCH.
  const lexicalPass = (
    match: string,
  ): {
    byId: Map<string, Candidate>;
    bm25: number[];
    bm25ById: Map<string, number>;
    graphRaw: GraphEdgeRow[];
  } => {
    const rows = db.all<LexicalRow>(hybridQueries.hybridLexicalPass, [
      match,
      scopesJson,
      layerMin,
      layerMax,
      ...aclArgs,
      cfg.poolSize,
      hopSeeds,
      cfg.graphMinEdgeWeight,
      hop2Seeds,
      cfg.graphHopFanout,
    ]);
    roundTrips++;

    const map = new Map<string, Candidate>();
    const scores: number[] = [];
    const scoreById = new Map<string, number>();
    const graph: GraphEdgeRow[] = [];
    for (const row of rows) {
      const node: NodeRow = {
        id: row.id,
        kind: row.kind,
        layer: row.layer,
        priority: row.priority,
        updated_at: row.updated_at,
        title: row.title,
        excerpt: row.excerpt,
      };
      const cand: Candidate = map.get(row.id) ?? { id: row.id, node, sources: new Set() };
      if (row.fts_rank !== null) {
        cand.ftsRank = row.fts_rank;
        cand.sources.add("fts");
        if (row.bm25 !== null) {
          scores.push(row.bm25);
          scoreById.set(row.id, row.bm25);
        }
      } else if (row.via_id !== null) {
        graph.push({
          id: row.id,
          viaId: row.via_id,
          weight: row.edge_weight ?? 0,
          type: row.edge_type ?? "",
          depth: row.depth,
        });
        cand.sources.add("graph");
      }
      map.set(row.id, cand);
    }
    return { byId: map, bm25: scores, bm25ById: scoreById, graphRaw: graph };
  };

  // Строка MATCH для каждой ступени. Пустая строка — ступень неприменима к
  // этому запросу (нечего ослаблять) и просто пропускается.
  const stageMatch: Readonly<Record<LexicalStage, string>> = {
    prefix_and: parsed.prefixAnd === parsed.and ? "" : parsed.prefixAnd,
    prefix_relaxed: parsed.terms.length >= cfg.fallbackMinTerms ? parsed.prefixRelaxed : "",
    prefix_relaxed2:
      parsed.terms.length >= cfg.fallbackMinTerms &&
      parsed.terms.length <= cfg.relaxed2MaxTerms
        ? parsed.prefixRelaxed2
        : "",
    prefix_or:
      parsed.terms.length >= cfg.fallbackMinTerms || parsed.prefixOr !== parsed.and
        ? parsed.prefixOr
        : "",
    or: parsed.terms.length >= cfg.fallbackMinTerms ? parsed.or : "",
  };

  const orAlways = cfg.lexicalMode === "or_always" && stageMatch.or !== "";
  let pass = lexicalPass(orAlways ? parsed.or : parsed.and);
  const andHits = orAlways ? 0 : pass.bm25.length;
  let operator: LexicalOperator = orAlways ? "or" : "and";
  let fallbackUsed = false;
  let coverageApplied = false;
  let stagesTried = 0;

  // ---- проход 1б: ЛЕСТНИЦА ОТКАТА, если строгое И не дало ничего (S44) -----
  //
  // Ступени идут от самой точной к самой широкой и обрываются на первой,
  // которая что-то нашла. Каждая — один лексический запрос, и платятся они
  // ТОЛЬКО здесь: запрос, который строгое И отработало, второй раз не
  // выполняется вовсе.
  if (cfg.lexicalMode === "and_then_fallback" && pass.bm25.length === 0) {
    for (const stage of cfg.fallbackStages) {
      const match = stageMatch[stage];
      if (match === "" || match === parsed.and) continue;
      stagesTried++;
      const attempt = lexicalPass(match);
      if (attempt.bm25.length > 0) {
        pass = attempt;
        operator = stage;
        fallbackUsed = true;
        break;
      }
    }
  }

  // Буст полного совпадения: ИЛИ-пул переранжируется по числу покрытых
  // терминов, при равенстве — по bm25. Ранги пересчитываются с 1, потому что
  // именно ранг, а не скор, уходит в RRF (§2.2).
  const unionStage = operator !== "and" && operator !== "prefix_and";
  if (unionStage && cfg.orCoverageBoost && pass.bm25.length > 1) {
    const ids = [...pass.bm25ById.keys()];
    const cov = new Map<string, number>();
    for (const row of db.all<{ id: string; cov: number }>(hybridQueries.hybridOrCoverage, [
      JSON.stringify(operator === "or" ? [...parsed.terms] : [...parsed.terms].map(asPrefix)),
      JSON.stringify(ids),
    ])) {
      cov.set(row.id, row.cov);
    }
    roundTrips++;
    if (cov.size > 0) {
      coverageApplied = true;
      const ordered = ids.slice().sort((a, b) => {
        const dc = (cov.get(b) ?? 0) - (cov.get(a) ?? 0);
        if (dc !== 0) return dc;
        const db_ = (pass.bm25ById.get(a) ?? 0) - (pass.bm25ById.get(b) ?? 0);
        if (db_ !== 0) return db_; // bm25 в fts5 отрицателен: меньше = лучше
        return a < b ? -1 : 1;
      });
      ordered.forEach((id, i) => {
        const cand = pass.byId.get(id);
        if (cand !== undefined) cand.ftsRank = i + 1;
      });
    }
  }

  const byId = pass.byId;
  const bm25Scores = pass.bm25;
  const graphRaw = pass.graphRaw;
  const lexical: HybridLexical = {
    operator,
    fallbackUsed,
    andHits,
    hits: bm25Scores.length,
    terms: parsed.terms.length,
    stagesTried,
    coverageApplied,
  };

  // ---- решение о векторной ветке ------------------------------------------
  const mode = params.vectorMode ?? "auto";
  const trigger = evaluateTrigger(params.text, bm25Scores, cfg, fallbackUsed);

  let disposition: VectorDisposition;
  let why: string;
  let wantVector: boolean;
  // Распределение дистанций по векторному пулу ЭТОГО запроса (не выдачи) —
  // нормировка confidence идёт по нему, а не по максимуму топа (myc-ye3.9).
  let vectorDistanceMean: number | undefined;
  let vectorDistanceStd: number | undefined;

  if (mode === "never") {
    wantVector = false;
    disposition = "disabled";
    why = "vector branch explicitly off (vectorMode: never)";
  } else if (mode === "always") {
    wantVector = true;
    disposition = "used";
    why = "vector branch unconditionally on (vectorMode: always) — the reference for comparison";
  } else if (trigger.fired) {
    wantVector = true;
    disposition = "used";
    why = `lexical fell short: ${trigger.reasons.join(", ")}`;
  } else {
    wantVector = false;
    disposition = "skipped";
    why =
      `lexical is enough (${trigger.metrics.lexicalHits} candidates, ` +
      `BM25 spread ${fmt(trigger.metrics.bm25Spread)}, ` +
      `anchor terms ${trigger.metrics.anchorTerms}/${trigger.metrics.queryTerms}) — ` +
      `query embedding not computed, ~23 ms saved (S31)`;
  }

  // ---- проход 2: вектор, только если решили его звать ----------------------
  if (wantVector) {
    // Колбэк вызывается ЗДЕСЬ и только здесь: пока триггер не сработал, за
    // эмбеддинг никто не платит.
    const vector = params.embedQuery ? params.embedQuery() : null;
    if (vector === null) {
      disposition = "unavailable";
      why = `${why}; but there is no query embedding — results only from lexical and graph`;
      degraded.push(
        "vector-branch: query embedding unavailable (no embedder or cache) — " +
          "the vector branch did not take part",
      );
    } else {
      const source = params.vectorSource ?? vectorSearch;
      const outcome = source(db, {
        vector,
        scopes: params.scopes,
        layerMin: params.layerMin,
        layerMax: params.layerMax,
        caller: params.caller,
        limit: cfg.poolSize,
        candidateLimit: 200,
      });
      // Чужие запросы восстанавливаем по форме outcome: vectorSearch делает
      // tableExists + KNN (+ tableExists + f32 при переранжировании). Это
      // оценка, и она лежит в отдельном поле, не смешиваясь со счётчиком.
      vectorRoundTrips += outcome.degraded ? 1 : outcome.reranked ? 4 : 2;

      if (outcome.degraded) {
        disposition = "degraded";
        why = `${why}; vector source degraded: ${outcome.reason ?? "no reason given"}`;
        degraded.push(`vector-source: ${outcome.reason ?? "degraded"}`);
      } else if (outcome.hits.length === 0) {
        disposition = "empty";
        why = `${why}; the vector branch ran but gave no candidates`;
      } else {
        vectorDistanceMean = outcome.distanceMean;
        vectorDistanceStd = outcome.distanceStd;
        const distanceById = new Map(outcome.hits.map((h) => [h.id, h.distance]));
        const missing: string[] = [];
        for (const hit of outcome.hits) {
          const cand = byId.get(hit.id);
          if (cand === undefined) {
            missing.push(hit.id);
          } else {
            cand.vecRank = hit.rank;
            cand.vecDistance = hit.distance;
            cand.sources.add("vector");
          }
        }
        if (missing.length > 0) {
          const hydrated = db.all<NodeRow>(hybridQueries.hybridHydrate, [
            JSON.stringify(missing),
            scopesJson,
            layerMin,
            layerMax,
            ...aclArgs,
          ]);
          roundTrips++;
          const byNodeId = new Map(hydrated.map((n) => [n.id, n]));
          for (const hit of outcome.hits) {
            if (byId.has(hit.id)) continue;
            const node = byNodeId.get(hit.id);
            if (node === undefined) continue; // отфильтрован ACL/скоупом — молча пропускаем
            byId.set(hit.id, {
              id: hit.id,
              node,
              vecRank: hit.rank,
              vecDistance: distanceById.get(hit.id),
              sources: new Set<HybridSource>(["vector"]),
            });
          }
        }
      }
    }
  }

  // ---- слияние: RRF -> бусты -> граф-расширение ----------------------------
  const scored = new Map<string, number>();
  const fused: { cand: Candidate; rrf: number; score: number }[] = [];

  for (const cand of byId.values()) {
    if (cand.ftsRank === undefined && cand.vecRank === undefined) continue; // чистый граф — ниже
    const rrf = rrfScore({ fts: cand.ftsRank, vec: cand.vecRank }, cfg);
    const score =
      rrf *
      boostOf(
        { priority: cand.node.priority, layer: cand.node.layer, updatedAt: cand.node.updated_at },
        now,
        cfg,
      );
    scored.set(cand.id, score);
    fused.push({ cand, rrf, score });
  }

  // ГРАФ-РАСШИРЕНИЕ НА 1–2 ХОПА (§2.2 + memory-1md1zhs0w8r0).
  //
  //   score(узел) = score(того, через кого пришли) × decay[глубина] ×
  //                 вес ребра × вес типа ребра
  //
  // Затухание перемножается ПО ПУТИ, а не назначается абсолютом на глубину:
  // узел второго хопа платит за оба ребра, по которым до него дошли. Отсюда
  // и порядок обработки — строго по возрастанию глубины: второй хоп читает
  // уже посчитанный счёт своего соседа с первого, а не пересчитывает путь.
  //
  // Сиды — лексические: обход шёл в том же round-trip, что и лексика, то есть
  // ДО решения о векторе. Это записано в mode_used.graphSeeds.
  const graphCap = 2 * (hopSeeds + hop2Seeds);
  const expandedById = new Map<string, { cand: Candidate; rrf: number; score: number; depth: number }>();
  // Счёт узла, ЧЕРЕЗ который может идти следующий хоп: лексические сиды плюс
  // уже посчитанные узлы предыдущей глубины.
  const pathScore = new Map<string, number>(scored);
  const byDepthCount: number[] = [];
  for (const g of [...graphRaw].sort((a, b) => a.depth - b.depth)) {
    if (g.depth > cfg.graphMaxHops) continue;
    const decay = cfg.graphDecayByHop[g.depth - 1];
    if (decay === undefined) continue; // глубже, чем описано затухание — не идём
    const viaScore = pathScore.get(g.viaId);
    if (viaScore === undefined) continue;
    const cand = byId.get(g.id);
    if (cand === undefined) continue;
    if (cand.ftsRank !== undefined || cand.vecRank !== undefined) continue;
    const typeWeight = cfg.graphTypeWeights[g.type] ?? cfg.graphTypeWeightDefault;
    const score = viaScore * decay * g.weight * typeWeight;
    const prev = expandedById.get(g.id);
    if (prev === undefined) {
      expandedById.set(g.id, { cand, rrf: 0, score, depth: g.depth });
      byDepthCount[g.depth - 1] = (byDepthCount[g.depth - 1] ?? 0) + 1;
      pathScore.set(g.id, score);
    } else if (score > prev.score) {
      prev.score = score;
      prev.depth = g.depth;
      pathScore.set(g.id, score);
    }
  }
  const expanded = [...expandedById.values()];
  expanded.sort((a, b) => b.score - a.score || (a.cand.id < b.cand.id ? -1 : 1));

  const hop1Found = graphRaw.reduce((n, g) => (g.depth === 1 ? n + 1 : n), 0);
  const graphInfo: HybridGraph = {
    maxHops: cfg.graphMaxHops,
    byDepth: Array.from({ length: Math.max(0, Math.min(cfg.graphMaxHops, 2)) }, (_, i) => byDepthCount[i] ?? 0),
    hop2Capped: hop2Seeds > 0 && hop1Found > hop2Seeds,
    inHits: 0,
  };

  const all: { cand: Candidate; rrf: number; score: number; depth?: number }[] = [
    ...fused,
    ...expanded.slice(0, graphCap),
  ];
  all.sort((a, b) => b.score - a.score || (a.cand.id < b.cand.id ? -1 : 1));

  const hits: HybridHit[] = all.slice(0, limit).map((entry, i) => {
    const vecConfidence =
      entry.cand.vecDistance !== undefined &&
      vectorDistanceMean !== undefined &&
      vectorDistanceStd !== undefined &&
      vectorDistanceStd > 0
        ? (vectorDistanceMean - entry.cand.vecDistance) / vectorDistanceStd
        : undefined;
    return {
      id: entry.cand.id,
      rank: i + 1,
      score: entry.score,
      rrf: entry.rrf,
      sources: [...entry.cand.sources],
      ...(entry.cand.ftsRank !== undefined ? { ftsRank: entry.cand.ftsRank } : {}),
      ...(entry.cand.vecRank !== undefined ? { vecRank: entry.cand.vecRank } : {}),
      ...(entry.cand.vecDistance !== undefined ? { vecDistance: entry.cand.vecDistance } : {}),
      ...(vecConfidence !== undefined ? { vecConfidence } : {}),
      ...(entry.depth !== undefined ? { graphDepth: entry.depth } : {}),
      kind: entry.cand.node.kind,
      layer: entry.cand.node.layer,
      priority: entry.cand.node.priority,
      updatedAt: entry.cand.node.updated_at,
      title: entry.cand.node.title,
      excerpt: entry.cand.node.excerpt,
    };
  });

  const graph: HybridGraph = {
    ...graphInfo,
    inHits: hits.reduce((n, h) => (h.graphDepth !== undefined ? n + 1 : n), 0),
  };

  // sources отчёта — то, что реально попало в выдачу, а не то, что мы звали.
  const usedSources = new Set<HybridSource>();
  for (const hit of hits) for (const s of hit.sources) usedSources.add(s);

  // Лексика дала ноль, а непустая выдача целиком держится на векторе — самый
  // тихий из всех случаев деградации (И2, myc-ye3.9): каждый источник по
  // отдельности выглядит штатно, только их СОЧЕТАНИЕ и выдаёт слабость.
  const vectorOnly = hits.length > 0 && lexical.hits === 0 && usedSources.has("vector");
  if (vectorOnly) {
    degraded.push(
      "vector-only: lexical gave no candidates — the whole result rests on " +
        "a single weak vector with no confirmation (S47: MRR ~0.24 on this model)",
    );
  }

  // Откат объявляется вслух и в `why`: выдача по ИЛИ шире выдачи по И, и это
  // ровно тот случай, когда пользователь должен понимать, что смотрит на
  // расширенный набор, а не на точное совпадение (И2, S44).
  if (fallbackUsed) {
    why =
      `strict AND gave no candidates (${parsed.terms.length} ${parsed.terms.length === 1 ? "term" : "terms"}) — ` +
      `the pool was built by fallback stage '${operator}' (${STAGE_WHY[operator] ?? "fallback"})` +
      `${coverageApplied ? " with a full-match boost" : ""}, BM25 ranking; ${why}`;
  }

  // ПУСТАЯ ВЫДАЧА ОБЯЗАНА ОБЪЯСНИТЬСЯ (И2, S44). «Не нашлось», «ветка не
  // участвовала» и «база пуста» — три разные новости, и различает их только
  // размер видимого корпуса, поэтому он и считается здесь.
  let emptyReason: HybridEmptyReason | undefined;
  if (hits.length === 0) {
    const c = corpus();
    if (c.size === 0) {
      emptyReason = {
        code: "store_empty",
        text: "this tier has no visible nodes — there is nothing to search, which is not 'not found'",
        corpusSize: 0,
        corpusAtLeast: false,
      };
    } else {
      const sizeText = c.atLeast ? "1000+" : String(c.size);
      const branch =
        disposition === "used" || disposition === "empty"
          ? "lexical and vector both ran"
          : `the vector branch did not take part (${disposition})`;
      const terms = `${parsed.terms.length} ${parsed.terms.length === 1 ? "term" : "terms"}`;
      const how =
        stagesTried === 0
          ? `strict AND, ${terms}`
          : fallbackUsed
            ? `fallback stage '${operator}', ${terms}`
            : `strict AND and ${stagesTried} fallback ${stagesTried === 1 ? "stage" : "stages"}, ` +
              `${terms} — no match at any`;
      emptyReason = {
        code: "no_match",
        text: `none of the ${sizeText} visible nodes matched the query (${how}); ${branch}`,
        corpusSize: c.size,
        corpusAtLeast: c.atLeast,
      };
    }
  }

  return {
    hits,
    mode_used: {
      sources: [...usedSources].sort(),
      vector: disposition,
      lexical,
      vectorOnly,
      ...(emptyReason !== undefined ? { emptyReason } : {}),
      why,
      trigger,
      roundTrips,
      vectorRoundTrips,
      degraded,
      graphSeeds: "lexical",
      graph,
      cache: "off",
    },
  };
}

/** Человеческое объяснение ступени — для mode_used.why. */
const STAGE_WHY: Readonly<Record<string, string>> = {
  prefix_and: "word forms differ, intersection by prefixes",
  prefix_relaxed: "an extra word in the question, all terms but one",
  prefix_relaxed2: "two extra words, all terms but any two",
  prefix_or: "union of prefixes",
  or: "flat union of terms",
};

/**
 * Префиксная форма терма для запроса покрытия. Повторяет prefixTerm из
 * ./fts.ts по той же причине, по которой там повторена WORD_RE: экспортировать
 * приватную деталь ради одной строки хуже, чем повторить правило рядом с
 * местом применения — а расхождение ловит тест на равенство форм.
 */
function asPrefix(quoted: string): string {
  if (quoted.endsWith("*")) return quoted;
  const inner = quoted.slice(1, -1);
  if (inner.includes(" ") || inner.includes('""') || inner.length < 6) return quoted;
  return `"${inner.slice(0, Math.max(5, inner.length - 3))}"*`;
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(3) : "n/a";
}
