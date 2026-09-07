/**
 * absorb — ДЕТЕРМИНИРОВАННАЯ СТУПЕНЬ A (§6.1–6.2 01-core-data-model.md).
 *
 * Классификация входящего факта относительно уже известных БЕЗ LLM:
 *
 *   duplicate      тот же факт          → не плодим узел, seen_count у канонического
 *   update         тот же факт, новее   → цепочка supersedes, head_id у актуального
 *   contradiction  тот же предмет, но
 *                  утверждение обратное → ребро contradicts, оба узла живут
 *   related        тот же предмет       → ребро relates с весом = косинус
 *   new            другое               → обычная запись
 *
 * Три сигнала, все локальные и бесплатные:
 *   1. точный хеш нормализованного текста (NFKC, схлопнутые пробелы, без
 *      концевой пунктуации, lowercase; sha256 вместо blake3 — S25);
 *   2. косинус по уже посчитанным векторам (считает не этот модуль — ему
 *      отдают готовые Float32Array; без векторов косинуса просто нет);
 *   3. жаккар по символьным триграммам нормализованного текста.
 *
 * ПОРОГИ — НЕ ИЗ СПЕКИ, А ИЗ ЗАМЕРА. §6.1 называет cos ≥ 0.95 / 0.82; у
 * рабочей модели (multilingual-e5-small) косинусы лежат в узком поясе, и
 * разделение «своё / чужое» — около 0.06, а не 0.3. Взятые из спеки пороги
 * на таком сигнале дали бы либо всё в duplicate, либо ничего. Умолчания
 * ниже получены bench/absorb-calibrate.ts на размеченных парах из реальных
 * текстов воркспейса; переопределяются секцией [absorb] в workspace.toml.
 *
 * ДЕГРАДАЦИЯ ГРОМКАЯ (И2). Без векторов модуль НЕ сливает и НЕ выбрасывает
 * кандидатов: точный хеш по-прежнему даёт duplicate, всё остальное в поясе
 * похожести становится related, а вердикт несёт quality='lexical', чтобы
 * вызывающий записал это в строку узла. Никакого молчаливого «косинус по
 * TF-IDF» здесь нет и не появится.
 *
 * Модуль чистый: ни БД, ни сети, ни импорта других пакетов (core ни от кого
 * не зависит — scripts/deps-check.ts).
 */

import { createHash } from "node:crypto";
import type { EdgeKind } from "./index.ts";

// ---------------------------------------------------------------------------
// Классы и пороги
// ---------------------------------------------------------------------------

export type AbsorbClass = "duplicate" | "update" | "contradiction" | "related" | "new";

export const ABSORB_CLASSES: readonly AbsorbClass[] = [
  "duplicate",
  "update",
  "contradiction",
  "related",
  "new",
] as const;

/** Качество вердикта: были ли векторы. Пишется в строку узла (И2). */
export type AbsorbQuality = "embedded" | "lexical";

export interface AbsorbThresholds {
  /** duplicate: cos ≥ dup_cos И jac ≥ dup_jac. */
  readonly dup_cos: number;
  readonly dup_jac: number;
  /** Пояс «тот же предмет»: cos ≥ cand_cos ИЛИ jac ≥ cand_jac. */
  readonly cand_cos: number;
  readonly cand_jac: number;
  /** Без векторов: duplicate только при jac ≥ dup_jac_noembed (§6.6: порог поднимается). */
  readonly dup_jac_noembed: number;
  /** Без векторов: пояс похожести только по jac. */
  readonly cand_jac_noembed: number;
  /** Сколько дополнительных relates-рёбер ставить сверх целевого. */
  readonly max_related: number;
}

/**
 * Откалибровано bench/absorb-calibrate.ts на 68 размеченных парах
 * (bench/absorb-pairs.json) из реальных текстов воркспейса — 140 узлов,
 * модель multilingual-e5-small-q8. Замер распределений по меткам:
 *
 *   duplicate      cos 0.975…1.000   jac 0.70…1.00
 *   update         cos 0.959…0.992   jac 0.49…0.90
 *   contradiction  cos 0.924…0.992   jac 0.29…0.96
 *   related        cos 0.839…0.920   jac 0.06…0.22
 *   new            cos 0.765…0.855   jac 0.03…0.12
 *
 * Отсюда: duplicate/update/contradiction по косинусу НЕРАЗДЕЛИМЫ (0.96–0.99 у
 * всех трёх) — их разводят лексические признаки, а не порог; граница
 * related/new проходит около 0.845 и размыта (перекрытие 0.839–0.855: это
 * и есть разделение ~0.06 у модели, плато порога — одна точка сетки);
 * порог спеки 0.82 отправил бы в кандидаты почти все new. Итог калибровки
 * лежит в bench/absorb-calibration.json — числа здесь обязаны совпадать с
 * ним, тест absorb.test.ts это сверяет.
 */
export const DEFAULT_ABSORB_THRESHOLDS: AbsorbThresholds = Object.freeze({
  dup_cos: 0.99,
  dup_jac: 0.7,
  cand_cos: 0.845,
  cand_jac: 0.2,
  dup_jac_noembed: 0.9,
  cand_jac_noembed: 0.2,
  max_related: 3,
});

const THRESHOLD_KEYS: readonly (keyof AbsorbThresholds)[] = [
  "dup_cos",
  "dup_jac",
  "cand_cos",
  "cand_jac",
  "dup_jac_noembed",
  "cand_jac_noembed",
  "max_related",
];

/**
 * Секция [absorb] из workspace.toml. Разбор нарочно крошечный и в том же
 * духе, что parseWorkspaceToml в CLI: `ключ = число`, всё прочее
 * игнорируется. Неверное значение не роняет запись — остаётся умолчание.
 */
export function absorbThresholdsFromToml(
  text: string,
  base: AbsorbThresholds = DEFAULT_ABSORB_THRESHOLDS,
): AbsorbThresholds {
  const out: Record<keyof AbsorbThresholds, number> = { ...base };
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sec = /^\[([a-z_]+)\]$/i.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    if (section !== "absorb") continue;
    const kv = /^([a-z_]+)\s*=\s*([^#]+)/.exec(line);
    if (!kv) continue;
    const key = kv[1]! as keyof AbsorbThresholds;
    if (!THRESHOLD_KEYS.includes(key)) continue;
    const n = Number(kv[2]!.trim());
    if (!Number.isFinite(n) || n < 0) continue;
    if (key === "max_related") {
      out[key] = Math.floor(n);
    } else if (n <= 1) {
      out[key] = n;
    }
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Нормализация, хеш, триграммы, косинус
// ---------------------------------------------------------------------------

/**
 * Нормализация для absorb-хеша (§6.1): NFKC, схлопывание пробелов, обрезка
 * концевой пунктуации, lowercase. Это ДРУГАЯ нормализация, чем у
 * contentHash из graph.ts (та — только пробелы: на ней стоит уникальный
 * индекс, и менять её нельзя без миграции). Здесь цель обратная — склеить
 * «Тот же факт.» и «тот же факт», которые индекс считает разными.
 */
export function normalizeAbsorbText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.,;:!?…]+$/u, "")
    .toLowerCase();
}

/** sha256 нормализованного текста, hex. Пустой текст даёт хеш пустой строки. */
export function absorbHash(text: string): string {
  return createHash("sha256").update(normalizeAbsorbText(text), "utf8").digest("hex");
}

/**
 * Символьные триграммы нормализованного текста с обрамлением пробелами —
 * так граничные символы слов участвуют наравне с внутренними.
 */
export function trigramSet(text: string): Set<string> {
  const norm = ` ${normalizeAbsorbText(text)} `;
  const points = [...norm];
  const out = new Set<string>();
  if (points.length < 3) {
    if (norm.trim().length > 0) out.add(norm);
    return out;
  }
  for (let i = 0; i + 3 <= points.length; i++) {
    out.add(points[i]! + points[i + 1]! + points[i + 2]!);
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function trigramJaccard(a: string, b: string): number {
  return jaccard(trigramSet(a), trigramSet(b));
}

/** Косинус; нулевые векторы дают 0; несовпадение размерностей — ошибка вызова. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) {
    throw new RangeError(`cosine: размерности не совпадают (${a.length} ≠ ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Лексические сигналы: слова, числа, полярность, маркеры обновления
// ---------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}_]+/gu;
const NUMBER_RE = /\d+(?:[.,]\d+)?/gu;

/**
 * Отрицания. Список короткий и осознанно грубый: задача ступени A — поймать
 * полярный переворот «X» → «не X» без модели, а не разобрать грамматику.
 * Префиксные стоят ПЕРЕД отрицаемым словом, постфиксные — ПОСЛЕ («валидатора
 * нет»). Сравнивается не наличие «не» в тексте (оно есть почти в любом
 * русском абзаце), а множество ОТРИЦАЕМЫХ слов: переворот — это слово,
 * которое в одном тексте стоит под отрицанием, а в другом — без него.
 */
const NEGATION_PREFIX = new Set([
  "не",
  "нельзя",
  "никогда",
  "никакой",
  "без",
  "вне",
  "not",
  "no",
  "never",
  "cannot",
  "dont",
  "doesnt",
  "isnt",
  "without",
]);
const NEGATION_POSTFIX = new Set(["нет", "отсутствует", "отсутствуют"]);
/** Служебные слова, отрицание которых ничего не значит («не в», «не и»). */
const FUNCTION_WORDS = new Set([
  "и", "в", "во", "на", "с", "со", "к", "по", "а", "но", "же", "ли", "бы", "то", "что",
  "это", "как", "для", "от", "до", "из", "о", "об", "у", "за", "the", "a", "an", "of",
  "to", "in", "on", "at", "is", "are", "be", "it", "this", "that", "and", "or",
]);

/**
 * Грубая основа слова: первые пять букв. Русская флексия живёт в конце
 * («проверяем / проверка», «оплог / оплога»), а полноценный стеммер ступени
 * A не положен — она обязана оставаться крошечной и детерминированной.
 */
function stem(w: string): string {
  return w.length > 5 ? w.slice(0, 5) : w;
}

/** Основы слов текста под отрицанием и без него. */
function polarity(tokens: readonly string[]): { negated: Set<string>; plain: Set<string> } {
  const negated = new Set<string>();
  const plain = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!;
    if (NEGATION_PREFIX.has(w) || NEGATION_POSTFIX.has(w) || FUNCTION_WORDS.has(w)) continue;
    const prev = i > 0 ? tokens[i - 1]! : "";
    const next = i + 1 < tokens.length ? tokens[i + 1]! : "";
    if (NEGATION_PREFIX.has(prev) || NEGATION_POSTFIX.has(next)) negated.add(stem(w));
    else plain.add(stem(w));
  }
  return { negated, plain };
}

/**
 * Пары-антонимы по началу слова (stem): переворот одного из них между
 * текстами — противоречие. Проверяется по словам, которые есть только в
 * одном из текстов, поэтому «включён … выключен» в одном тексте не считается.
 */
const ANTONYM_STEMS: readonly (readonly [string, string])[] = [
  ["включ", "выключ"],
  ["включ", "отключ"],
  ["enable", "disable"],
  ["разреш", "запрещ"],
  ["allow", "forbid"],
  ["allow", "deny"],
  ["всегда", "никогда"],
  ["always", "never"],
  ["синхрон", "асинхрон"],
  ["sync", "async"],
  ["обязател", "опционал"],
  ["required", "optional"],
  ["true", "false"],
  ["можно", "нельзя"],
  ["верно", "неверно"],
  ["быстр", "медлен"],
  ["fast", "slow"],
  ["безопас", "опас"],
  ["дёшев", "дорог"],
  ["дешев", "дорог"],
  ["cheap", "expensive"],
  ["увелич", "уменьш"],
  ["increase", "decrease"],
  ["больше", "меньше"],
  ["more", "less"],
  ["выше", "ниже"],
  ["above", "below"],
  ["до", "после"],
  ["before", "after"],
  ["внутри", "снаружи"],
  ["явно", "автомат"],
  ["explicit", "automatic"],
];

/**
 * Маркеры обновления в НОВОМ тексте: автор сам говорит, что это замена
 * прежнего. Только явные слова — без них ступень A обновление не объявляет:
 * ложный update прячет старую голову из режима active, а ложный
 * contradiction всего лишь показывает оба узла с пометкой. Второе безопаснее.
 */
/**
 * `\b` в JS — граница ASCII-слова даже с флагом u: для кириллицы он не
 * срабатывает никогда. Поэтому границы задаются явно через \p{L}\p{N}.
 */
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const marker = (core: string, open = false): RegExp =>
  new RegExp(`${B}${core}${open ? "" : E}`, "u");

const UPDATE_MARKERS: readonly RegExp[] = [
  marker("теперь"),
  marker("больше не"),
  marker("отныне"),
  marker("обновл", true),
  marker("замен(?:ён|ен|ил|яет|или)", true),
  marker("вместо"),
  marker("с версии"),
  marker("устарел", true),
  marker("пересмотр", true),
  marker("поправк", true),
  marker("уточнени", true),
  marker("исправлен", true),
  marker("измен(?:ен[ыоа]?|ён)"),
  marker("now"),
  marker("no longer"),
  marker("updated?"),
  marker("replaced?"),
  marker("instead"),
  marker("as of"),
  marker("changed"),
  marker("deprecated"),
  marker("supersed", true),
  marker("correct(?:ion|ed)"),
  marker("revised"),
];

/**
 * Разошедшиеся числа и переворот полярности считаются противоречием только
 * у структурно той же фразы (доля слов старого текста, найденных в новом):
 * у двух РАЗНЫХ фактов на одну тему числа расходятся всегда, а «не» найдётся
 * в любом абзаце, и без этого порога любая пара related уходила бы в
 * contradiction. Значение — из замера bench/absorb-calibrate.ts: у пар
 * related coverage ≤ 0.23, у переписанных противоречий ≥ 0.38.
 */
const STRUCTURAL_MIN_COVERAGE = 0.35;

function words(text: string): string[] {
  const norm = normalizeAbsorbText(text).replace(/['’]/gu, "");
  return norm.match(WORD_RE) ?? [];
}

function numbersOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize("NFKC").match(NUMBER_RE) ?? []) {
    out.add(m.replace(",", "."));
  }
  return out;
}

export interface LexicalSignals {
  /** Слова, которые есть только в старом / только в новом тексте. */
  readonly onlyOld: readonly string[];
  readonly onlyNew: readonly string[];
  /** Доля слов старого текста, присутствующих в новом. */
  readonly coverage: number;
  /** Отношение длин в словах new/old. */
  readonly growth: number;
  /** Переворот полярности: отрицание или антоним только на одной стороне. */
  readonly polarityFlip: boolean;
  /** Новый текст явно объявляет себя заменой. */
  readonly updateMarker: boolean;
  /** Числа разошлись: у обоих есть числа, множества не совпадают. */
  readonly numberDrift: boolean;
}

export function lexicalSignals(oldText: string, newText: string): LexicalSignals {
  const oldWords = words(oldText);
  const newWords = words(newText);
  const oldSet = new Set(oldWords);
  const newSet = new Set(newWords);
  const onlyOld = [...oldSet].filter((w) => !newSet.has(w));
  const onlyNew = [...newSet].filter((w) => !oldSet.has(w));

  let covered = 0;
  for (const w of oldSet) if (newSet.has(w)) covered++;
  const coverage = oldSet.size === 0 ? 1 : covered / oldSet.size;
  const growth = oldWords.length === 0 ? 1 : newWords.length / oldWords.length;

  // Маркер считается, только если он появился в НОВОМ тексте: «при
  // обновлении якоря» в обоих текстах — часть факта, а не сигнал о замене.
  const oldNorm = normalizeAbsorbText(oldText);
  const newNorm = normalizeAbsorbText(newText);
  const updateMarker = UPDATE_MARKERS.some((re) => re.test(newNorm) && !re.test(oldNorm));

  // «X» под отрицанием в одном тексте и без отрицания в другом.
  const po = polarity(oldWords);
  const pn = polarity(newWords);
  let polarityFlip = false;
  for (const w of po.negated) {
    if (pn.plain.has(w) && !pn.negated.has(w)) polarityFlip = true;
  }
  for (const w of pn.negated) {
    if (po.plain.has(w) && !po.negated.has(w)) polarityFlip = true;
  }
  if (!polarityFlip) {
    const hasStem = (side: readonly string[], stem: string): boolean =>
      side.some((w) => w.startsWith(stem));
    for (const [a, b] of ANTONYM_STEMS) {
      if (
        (hasStem(onlyOld, a) && hasStem(onlyNew, b)) ||
        (hasStem(onlyOld, b) && hasStem(onlyNew, a))
      ) {
        polarityFlip = true;
        break;
      }
    }
  }

  const numOld = numbersOf(oldText);
  const numNew = numbersOf(newText);
  let numberDrift = false;
  if (numOld.size > 0 && numNew.size > 0) {
    for (const n of numOld) if (!numNew.has(n)) numberDrift = true;
    for (const n of numNew) if (!numOld.has(n)) numberDrift = true;
  }

  return { onlyOld, onlyNew, coverage, growth, polarityFlip, updateMarker, numberDrift };
}

// ---------------------------------------------------------------------------
// Классификация пары
// ---------------------------------------------------------------------------

export interface AbsorbText {
  readonly id?: string;
  readonly text: string;
  /** Готовый вектор; null — вектора нет (эмбеддинги недоступны или ещё не посчитаны). */
  readonly vector: Float32Array | null;
  readonly createdAt?: number;
  readonly confidence?: number;
}

export interface PairFeatures {
  readonly hashEqual: boolean;
  /** null — у одной из сторон не было вектора. */
  readonly cos: number | null;
  readonly jac: number;
  readonly signals: LexicalSignals;
}

export interface PairVerdict extends PairFeatures {
  readonly class: AbsorbClass;
  readonly quality: AbsorbQuality;
  readonly reason: string;
}

const f = (x: number): string => x.toFixed(3);

/**
 * Признаки пары считаются один раз и отдельно от порогов: калибровка
 * перебирает тысячи комбинаций порогов на одних и тех же признаках, а
 * воркер absorb сравнивает входящий факт с двумя дюжинами кандидатов.
 */
export function pairFeatures(oldText: AbsorbText, newText: AbsorbText): PairFeatures {
  const hashEqual = absorbHash(oldText.text) === absorbHash(newText.text);
  const jac = trigramJaccard(oldText.text, newText.text);
  const hasVectors = oldText.vector !== null && newText.vector !== null;
  const cos = hasVectors ? cosine(oldText.vector!, newText.vector!) : null;
  return { hashEqual, cos, jac, signals: lexicalSignals(oldText.text, newText.text) };
}

/**
 * Вердикт по признакам пары (старый факт, новый факт). Порядок правил важен:
 *
 *   1. хеш совпал                         → duplicate (векторы не нужны)
 *   2. векторов нет                       → duplicate только при очень высоком
 *                                            jac И без лексических признаков
 *                                            изменения; иначе related / new.
 *                                            Ни update, ни contradiction без
 *                                            векторов не объявляются (И2)
 *   3. cos ≥ dup_cos ∧ jac ≥ dup_jac       → duplicate — но ТОЛЬКО если новый
 *                                            текст не объявляет замену, числа
 *                                            не разошлись и полярность та же:
 *                                            по замеру update и duplicate
 *                                            перекрываются и по cos, и по jac,
 *                                            а ложный duplicate — единственный
 *                                            класс, который молча теряет знание
 *   4. вне пояса похожести                → new
 *   5. в поясе: маркер обновления         → update
 *              переворот полярности       → contradiction
 *              разошлись числа            → contradiction (без маркера
 *                                            автор не сказал, что это замена)
 *              новый ⊇ старого и длиннее  → update (уточнение того же факта)
 *              иначе                      → related
 */
export function verdictFromFeatures(
  x: PairFeatures,
  t: AbsorbThresholds = DEFAULT_ABSORB_THRESHOLDS,
): PairVerdict {
  const { hashEqual, cos, jac, signals: s } = x;
  const quality: AbsorbQuality = cos === null ? "lexical" : "embedded";
  const done = (cls: AbsorbClass, reason: string): PairVerdict => ({
    ...x,
    class: cls,
    quality,
    reason,
  });
  // Любой из этих признаков говорит, что новый текст НЕ тот же факт, как бы
  // ни были близки векторы.
  const structural = s.coverage >= STRUCTURAL_MIN_COVERAGE;
  const changed = s.updateMarker || (structural && (s.polarityFlip || s.numberDrift));

  if (hashEqual) return done("duplicate", "hash: нормализованный текст совпал");

  if (cos === null) {
    if (jac >= t.dup_jac_noembed && !changed) {
      return done("duplicate", `lexical: jac ${f(jac)} ≥ ${f(t.dup_jac_noembed)} (без векторов)`);
    }
    if (jac >= t.cand_jac_noembed) {
      return done(
        "related",
        `lexical: jac ${f(jac)} в поясе похожести, без векторов класс не уточняется`,
      );
    }
    return done("new", `lexical: jac ${f(jac)} < ${f(t.cand_jac_noembed)} (без векторов)`);
  }

  if (cos >= t.dup_cos && jac >= t.dup_jac && !changed) {
    return done("duplicate", `cos ${f(cos)} ≥ ${f(t.dup_cos)} ∧ jac ${f(jac)} ≥ ${f(t.dup_jac)}`);
  }

  const inBand = cos >= t.cand_cos || jac >= t.cand_jac;
  if (!inBand) {
    return done("new", `cos ${f(cos)} < ${f(t.cand_cos)} ∧ jac ${f(jac)} < ${f(t.cand_jac)}`);
  }

  const base = `cos ${f(cos)}, jac ${f(jac)}`;
  // Маркер замены значим только у структурно той же фразы: «теперь» в
  // соседней по теме, но другой задаче — не обновление, а совпадение слов.
  // Ложный update прячет старую голову из active, поэтому ворота здесь те же,
  // что у противоречия.
  if (structural && s.updateMarker) return done("update", `${base}; новый текст объявляет замену`);
  if (structural && s.polarityFlip) {
    return done(
      "contradiction",
      `${base}; переворот полярности: −[${s.onlyOld.slice(0, 4).join(" ")}] +[${s.onlyNew.slice(0, 4).join(" ")}]`,
    );
  }
  if (structural && s.numberDrift) {
    return done("contradiction", `${base}; числа разошлись без маркера обновления`);
  }
  if (s.coverage >= 0.9 && s.growth >= 1.2) {
    return done(
      "update",
      `${base}; новый текст содержит старый (${f(s.coverage)}) и длиннее в ${s.growth.toFixed(2)}`,
    );
  }
  return done("related", `${base}; тот же предмет, утверждение другое`);
}

export function classifyPair(
  oldText: AbsorbText,
  newText: AbsorbText,
  t: AbsorbThresholds = DEFAULT_ABSORB_THRESHOLDS,
): PairVerdict {
  return verdictFromFeatures(pairFeatures(oldText, newText), t);
}

// ---------------------------------------------------------------------------
// Классификация против набора кандидатов
// ---------------------------------------------------------------------------

export interface AbsorbRelation {
  readonly id: string;
  readonly weight: number;
  readonly cos: number | null;
  readonly jac: number;
}

export interface AbsorbVerdict {
  readonly class: AbsorbClass;
  /** Целевой узел для duplicate/update/contradiction/related; null у new. */
  readonly targetId: string | null;
  readonly cos: number | null;
  readonly jac: number;
  readonly quality: AbsorbQuality;
  readonly reason: string;
  /** Остальные кандидаты в поясе похожести — под relates-рёбра (не больше max_related). */
  readonly related: readonly AbsorbRelation[];
  /** Сколько кандидатов рассмотрено. */
  readonly considered: number;
}

const CLASS_RANK: Readonly<Record<AbsorbClass, number>> = {
  duplicate: 0,
  update: 1,
  contradiction: 2,
  related: 3,
  new: 4,
};

/**
 * Вес relates-ребра = косинус (§6.2). Без векторов — жаккар, и это видно
 * по quality вердикта, а не спрятано в числе.
 */
function relationWeight(v: PairVerdict): number {
  const w = v.cos ?? v.jac;
  return Math.min(1, Math.max(0, w));
}

/**
 * Вердикт против набора кандидатов. Самый сильный класс побеждает; внутри
 * класса — кандидат с наибольшим косинусом (без векторов — жаккаром).
 * Канонический дубликат — более ранний по created_at, при равенстве — с
 * большим confidence (§6.2): это решается ВЫЗЫВАЮЩИМ по targetId, здесь
 * лишь выбирается, с кем именно совпало.
 */
export function classifyAbsorb(
  incoming: AbsorbText,
  candidates: readonly AbsorbText[],
  t: AbsorbThresholds = DEFAULT_ABSORB_THRESHOLDS,
): AbsorbVerdict {
  let best: { verdict: PairVerdict; id: string } | null = null;
  const inBand: { verdict: PairVerdict; id: string }[] = [];

  for (const c of candidates) {
    if (c.id === undefined || c.id === incoming.id) continue;
    const v = classifyPair(c, incoming, t);
    if (v.class === "new") continue;
    inBand.push({ verdict: v, id: c.id });
    if (best === null) {
      best = { verdict: v, id: c.id };
      continue;
    }
    const ra = CLASS_RANK[v.class];
    const rb = CLASS_RANK[best.verdict.class];
    if (ra < rb) {
      best = { verdict: v, id: c.id };
    } else if (ra === rb && relationWeight(v) > relationWeight(best.verdict)) {
      best = { verdict: v, id: c.id };
    }
  }

  // Качество — по вектору входящего и по паре, давшей вердикт: один кандидат
  // без вектора не роняет качество всего решения, но если решающая пара была
  // лексической — это честно видно.
  const quality: AbsorbQuality =
    incoming.vector === null ? "lexical" : (best?.verdict.quality ?? "embedded");

  if (best === null) {
    return {
      class: "new",
      targetId: null,
      cos: null,
      jac: 0,
      quality,
      reason:
        candidates.length === 0
          ? "кандидатов нет"
          : `ни один из ${candidates.length} кандидатов не в поясе похожести`,
      related: [],
      considered: candidates.length,
    };
  }

  const related = inBand
    .filter((x) => x.id !== best!.id)
    .sort((a, b) => relationWeight(b.verdict) - relationWeight(a.verdict))
    .slice(0, Math.max(0, t.max_related))
    .map((x) => ({
      id: x.id,
      weight: relationWeight(x.verdict),
      cos: x.verdict.cos,
      jac: x.verdict.jac,
    }));

  return {
    class: best.verdict.class,
    targetId: best.id,
    cos: best.verdict.cos,
    jac: best.verdict.jac,
    quality: best.verdict.quality,
    reason: best.verdict.reason,
    related,
    considered: candidates.length,
  };
}

/**
 * Кто из пары канонический при duplicate (§6.2): более ранний по created_at,
 * при равенстве — с большим confidence, при полном равенстве — меньший id
 * (детерминизм между сайтами).
 */
export function canonicalOf(
  a: { readonly id: string; readonly createdAt: number; readonly confidence: number },
  b: { readonly id: string; readonly createdAt: number; readonly confidence: number },
): string {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a.id : b.id;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a.id : b.id;
  return a.id < b.id ? a.id : b.id;
}

// ---------------------------------------------------------------------------
// Класс → ребро (§6.2)
// ---------------------------------------------------------------------------

/**
 * Какое ребро обязан записать каждый класс. Таблица, а не пять веток `if` в
 * применяющем коде: у memora класс «противоречие» только помечает узел и
 * повисает без связи — вторую сторону конфликта потом нечем найти. У нас
 * `contradiction` — это РЕБРО `contradicts` (одиннадцатый тип, добавленный
 * ровно под этот класс), иначе экран решений не может показать противоречие
 * целиком, а `myc doctor --conflicts` не может его собрать.
 *
 * Направление всегда «новый узел → цель». `contradicts` и `relates`
 * симметричны (EDGE_SEMANTICS), поэтому хранится одно ребро, а читаются они
 * в обе стороны.
 */
export const ABSORB_EDGE: Readonly<Record<AbsorbClass, EdgeKind | null>> =
  Object.freeze({
    duplicate: "duplicates",
    update: "supersedes",
    contradiction: "contradicts",
    related: "relates",
    new: null,
  });

/** Ребро для класса; null только у `new` — ему писать нечего. */
export function absorbEdgeFor(cls: AbsorbClass): EdgeKind | null {
  return ABSORB_EDGE[cls];
}

/** Одно ребро, которое absorb обязан записать по вердикту. */
export interface AbsorbEdge {
  readonly src: string;
  readonly type: EdgeKind;
  readonly dst: string;
  readonly weight: number;
}

/**
 * Рёбра вердикта: главное (по классу) плюс relates на остальных кандидатов
 * пояса. Чистая функция — ни БД, ни порядка применения; вызывающему остаётся
 * записать их идемпотентно.
 */
export function absorbEdges(nodeId: string, verdict: AbsorbVerdict): AbsorbEdge[] {
  const out: AbsorbEdge[] = [];
  const main = ABSORB_EDGE[verdict.class];
  if (main !== null && verdict.targetId !== null && verdict.targetId !== nodeId) {
    const w = verdict.cos ?? verdict.jac;
    out.push({
      src: nodeId,
      type: main,
      dst: verdict.targetId,
      weight: Math.min(1, Math.max(0, w)),
    });
  }
  if (verdict.class !== "new") {
    for (const r of verdict.related) {
      if (r.id === nodeId || r.id === verdict.targetId) continue;
      out.push({ src: nodeId, type: "relates", dst: r.id, weight: r.weight });
    }
  }
  return out;
}
