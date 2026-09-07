// Федерация чтения по N источникам (решения S41 + S59/R3, ARCHITECTURE.md §10).
//
// Каждый воркспейс — отдельный файл SQLite, поэтому его нельзя добавить как
// ветку ВНУТРИ hybridSearch (тот работает с одним db-драйвером за один SQL
// round-trip). Вместо второго механизма воркспейс — ЕЩЁ ОДИН ИСТОЧНИК ТОЙ ЖЕ
// ФОРМЫ, что fts/vector внутри hybridSearch: каждый источник даёт свой
// ранжированный список (свой вызов hybridSearch), а federatedSearch сливает
// эти списки тем же RRF (тот же k, тот же missingRank — §2.2), только по
// РАНГУ УЗЛА В ИСТОЧНИКЕ, а не по рангу в fts/vector.
//
// ПОЧЕМУ СПИСОК, А НЕ ДВА ИМЕНОВАННЫХ ПОЛЯ (R3). Экосистема ~/src/cherry —
// пятнадцать репозиториев, часть из которых публикуется отдельно и потому
// имеет свой воркспейс (S59). Чтение из корня обязано видеть и их знание, а
// пара `project`/`personal` закрывала интерфейс на двух. Само слияние было
// общим уже тогда — обобщался только вход.
//
// ЛЕНИВОСТЬ — ЗАБОТА ЭТОГО МОДУЛЯ (изменение против S41). Раньше решение
// «стоит ли открывать личный ярус» принимал вызывающий ДО вызова, и это
// работало на двух источниках. На шестнадцати так нельзя: открыть все базы,
// чтобы потом опросить пять, — та же цена, от которой уходили. Поэтому
// источник приходит сюда ОПИСАНИЕМ с ленивым `open()`, и открывается ровно
// то, что прошло отбор. `open()` непрошедших не зовётся ни разу.
//
// ПОТОЛОК (И1). recall держит p99 25 мс на 100k узлов. Замеры на этой машине
// (limit 36, vectorMode never, медиана 200 прогонов):
//
//   один источник, 100 000 узлов   p50 6.74  p95 8.20  p99 8.71 мс
//   один источник,  20 000 узлов   p50 1.42  p95 1.69  p99 1.84 мс
//   один источник,   5 000 узлов   p50 0.62  p95 0.66  p99 0.74 мс
//   один источник,   1 000 узлов   p50 0.34  p95 0.36  p99 0.42 мс
//
//   100k узлов экосистемы, размазанные по источникам:
//     1 x 100k    p50  7.69  p99  9.52 мс
//     4 x 25k     p50  7.82  p99  9.21 мс
//     8 x 12.5k   p50  9.60  p99 19.31 мс
//    16 x 6.25k   p50 13.05  p99 16.23 мс
//
//   худший случай — каждый источник сам по себе 100k:
//     2 x 100k    p50 22.78  p99 39.35 мс   ← бюджет уже пробит
//     4 x 100k    p50 38.85  p99 62.94 мс
//
// Из этих чисел два вывода. Первый: у источника есть ПОЛ стоимости ~0.35 мс
// независимо от размера (открытый запрос, разбор, RRF), поэтому шестнадцать
// источников стоят ~13 мс даже когда каждый крошечный — на гидратацию и
// сборку ответа (они идут ПОСЛЕ федерации, внутри тех же 25 мс) остаётся
// мало. Второй: счётный потолок сам по себе бюджета НЕ гарантирует — два
// источника по 100k пробивают его вдвоём. Поэтому потолков ДВА: счётный
// DEFAULT_MAX_SOURCES (детерминированный, работает в обычном случае) и
// дедлайн DEFAULT_DEADLINE_MS (страхует худший, когда источники большие).
//
// И2: ПРОПУСК НАЗВАН, А НЕ УМОЛЧАН. Каждый источник — опрошенный и
// пропущенный — лежит строкой в mode_used.sources со своей причиной, счётчики
// queried/skipped рядом. Молча опросить не всех и отдать результат как полный
// — ровно та болезнь, с которой борется И2; здесь это невозможно: выдача
// несёт список пропущенных всегда.

import type { DbDriver } from "@myc/core";
import {
  DEFAULT_HYBRID_CONFIG,
  hybridSearch,
  type HybridConfig,
  type HybridHit,
  type HybridModeUsed,
  type HybridSearchParams,
} from "./hybrid.ts";

/**
 * Род источника. Не имя: имён столько же, сколько воркспейсов, а родов три, и
 * поверхности рисуют их по-разному (`me` у личного, имя репозитория у
 * репозиторного, ничего у проектного).
 */
export type SourceKind = "project" | "personal" | "repo";

/** Прежнее имя рода — S41 знал только два (packages/cli читает его до сих пор). */
export type WorkspaceTier = SourceKind;

export interface FederationSource {
  /**
   * Имя источника в выдаче: `project`, `me`, имя репозитория. Уникально в
   * пределах одного вызова — по нему хит и приписывается источнику.
   */
  readonly id: string;
  readonly kind: SourceKind;
  readonly scopes: readonly string[];
  /**
   * Вес источника в межисточниковом RRF; по умолчанию 1 — все равноправны.
   * Меньше 1 — источник участвует, но уступает при равном ранге.
   */
  readonly weight?: number;
  /**
   * Открытие источника — ЛЕНИВОЕ. Зовётся ровно один раз и ровно тогда, когда
   * источник прошёл отбор: не прошедший не открывается вовсе (И1). Вызывающий
   * отвечает за закрытие того, что было открыто, — что именно, видно по
   * mode_used.sources[].queried.
   *
   * Открытие базы — ввод-вывод, поэтому допускается Promise. Ради него весь
   * federatedSearch асинхронен: синхронная сигнатура заставляла бы вызывающего
   * открывать всё заранее, то есть ровно то, от чего уходит ленивость.
   */
  readonly open: () => DbDriver | Promise<DbDriver>;
}

export interface FederatedHit extends HybridHit {
  /** Источник, из которого взят факт — то самое «пометить источник» (S41/R3). */
  readonly source: string;
  /** Род источника: по нему поверхности решают, как его нарисовать. */
  readonly tier: SourceKind;
  /** Ранг узла ВНУТРИ своего источника до слияния (то, что участвовало в RRF). */
  readonly tierRank: number;
  /**
   * Все источники, где узел нашёлся, в порядке опроса. Первый из них и есть
   * `source`. Больше одного — узел синхронизирован между воркспейсами, и это
   * факт выдачи, а не деталь слияния (И2).
   */
  readonly foundIn: readonly string[];
}

export interface FederatedSourceReport {
  readonly id: string;
  readonly kind: SourceKind;
  readonly weight: number;
  /** Опрошен ли. false — смотри `skipped`, причина там всегда. */
  readonly queried: boolean;
  /** Почему НЕ опрошен; undefined ровно тогда, когда queried=true. */
  readonly skipped?: string;
  /** Отчёт гибрида по этому источнику; undefined — источник не опрашивался. */
  readonly mode?: HybridModeUsed;
  /** Сколько кандидатов дал источник ДО слияния. */
  readonly hits: number;
  /** Сколько миллисекунд стоил опрос; undefined — не опрашивался. */
  readonly took_ms?: number;
}

export interface FederatedModeUsed {
  /** ВСЕ источники, что были предложены: и опрошенные, и пропущенные (И2). */
  readonly sources: readonly FederatedSourceReport[];
  readonly queried: number;
  readonly skipped: number;
  /** Действующий счётный потолок. */
  readonly cap: number;
  /** Действующий дедлайн опроса, мс. */
  readonly deadlineMs: number;
  /** Сколько миллисекунд заняли все опросы вместе. */
  readonly took_ms: number;
  readonly why: string;

  // --- совместимость: два именованных яруса как ПРОИЗВОДНЫЕ виды -----------
  // packages/cli и packages/mcp читают эти поля с S41. Они не второй источник
  // правды: и то и другое — выборка из `sources` выше.
  /** Отчёт первого источника рода `project`. */
  readonly project: HybridModeUsed;
  /** Отчёт источника рода `personal`; undefined — он не опрашивался. */
  readonly personal?: HybridModeUsed;
  readonly personalQueried: boolean;
}

export interface FederatedResult {
  readonly hits: readonly FederatedHit[];
  readonly mode_used: FederatedModeUsed;
}

export interface FederatedSearchParams extends Omit<HybridSearchParams, "scopes"> {
  /**
   * Источники В ПОРЯДКЕ ПРИОРИТЕТА. Порядок значим дважды: потолок отсекает
   * хвост списка, и узел, найденный в нескольких источниках, приписывается
   * первому из них. Вызывающий ставит первым тот воркспейс, из которого
   * позвали.
   */
  readonly sources: readonly FederationSource[];
  /** Счётный потолок; по умолчанию DEFAULT_MAX_SOURCES. Меньше 1 не бывает. */
  readonly maxSources?: number;
  /**
   * Дедлайн на ВСЕ опросы вместе, мс; по умолчанию DEFAULT_DEADLINE_MS.
   * Проверяется ПЕРЕД каждым следующим источником — первый опрашивается
   * всегда, иначе выдача была бы пуста на медленной машине.
   */
  readonly deadlineMs?: number;
  /** Часы для дедлайна; подменяются в тестах. По умолчанию performance.now. */
  readonly clock?: () => number;
}

const DEFAULT_LIMIT = 12;
// Просим у каждого источника чуть больше кандидатов, чем итоговый limit: иначе
// слияние по рангу вырождается в «первые limit первого источника», потому что
// остальные не успевают предъявить конкурентов за пределами топ-limit.
const TIER_POOL_MULTIPLIER = 3;

/**
 * Счётный потолок по умолчанию. Восемь, а не шестнадцать: замер выше говорит,
 * что шестнадцать источников стоят ~13 мс p50 даже на мелких базах — больше
 * половины бюджета 25 мс ещё до гидратации и сборки. На восьми пол стоимости
 * ~9.6 мс p50, и остаток бюджета покрывает всё, что идёт после.
 */
export const DEFAULT_MAX_SOURCES = 8;

/**
 * Дедлайн опроса по умолчанию. 18 мс из 25 мс бюджета recall: остальное —
 * гидратация страницы, фильтры и бюджетированная сборка ответа, у которой
 * свой дедлайн (§2.7). Страхует случай, которого счётный потолок не ловит, —
 * несколько БОЛЬШИХ источников: два по 100k пробивают бюджет вдвоём.
 */
export const DEFAULT_DEADLINE_MS = 18;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), 100);
}

function clampCap(cap: number | undefined): number {
  if (cap === undefined || !Number.isFinite(cap)) return DEFAULT_MAX_SOURCES;
  return Math.max(1, Math.floor(cap));
}

function clampDeadline(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return DEFAULT_DEADLINE_MS;
  return ms;
}

/** Одна строка отчёта на весь вызов — то, что печатают поверхности. */
function whyOf(
  reports: readonly FederatedSourceReport[],
  cap: number,
  deadlineMs: number,
  hasPersonalSource: boolean,
): string {
  const queried = reports.filter((r) => r.queried);
  const skipped = reports.filter((r) => !r.queried);
  const parts = [
    `опрошено ${queried.length} из ${reports.length}: ${queried.map((r) => r.id).join(", ")}`,
  ];
  if (skipped.length > 0) {
    // Причина у каждого своя и названа поимённо: «пропущено 11» без имён —
    // ровно то молчание, которое запрещает И2.
    parts.push(`пропущено ${skipped.length}: ${skipped.map((r) => `${r.id} (${r.skipped})`).join(", ")}`);
  }
  parts.push(`потолок ${cap}, дедлайн ${deadlineMs} мс`);
  if (!hasPersonalSource) {
    // Дословно прежняя формулировка S41: личного яруса нет на диске, значит
    // второго запроса к БД не делалось вовсе.
    parts.push("личный ярус не открыт — второй запрос к БД не выполнялся (И1, S41)");
  }
  return parts.join("; ");
}

export async function federatedSearch(params: FederatedSearchParams): Promise<FederatedResult> {
  const cfg: HybridConfig = { ...DEFAULT_HYBRID_CONFIG, ...params.config };
  const limit = clampLimit(params.limit);
  const perSourceLimit = Math.min(100, limit * TIER_POOL_MULTIPLIER);
  const cap = clampCap(params.maxSources);
  const deadlineMs = clampDeadline(params.deadlineMs);
  const clock = params.clock ?? (() => performance.now());

  const { sources, maxSources: _cap, deadlineMs: _dl, clock: _clock, ...shared } = params;

  if (sources.length === 0) {
    throw new Error("federatedSearch: нужен хотя бы один источник");
  }

  interface Queried {
    readonly source: FederationSource;
    readonly hits: readonly HybridHit[];
    readonly mode: HybridModeUsed;
  }

  const reports: FederatedSourceReport[] = [];
  const queriedSources: Queried[] = [];
  const t0 = clock();

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    const weight = src.weight ?? 1.0;

    if (i >= cap) {
      reports.push({
        id: src.id,
        kind: src.kind,
        weight,
        queried: false,
        skipped: `сверх потолка ${cap} источников (И1: бюджет recall 25 мс)`,
        hits: 0,
      });
      continue;
    }

    const elapsed = clock() - t0;
    // Первый источник опрашивается ВСЕГДА: пустая выдача из-за дедлайна была
    // бы хуже просроченного бюджета — она выглядит как «ничего не найдено».
    if (i > 0 && elapsed >= deadlineMs) {
      reports.push({
        id: src.id,
        kind: src.kind,
        weight,
        queried: false,
        skipped: `дедлайн ${deadlineMs} мс исчерпан на ${i}-м источнике (потрачено ${Math.round(elapsed * 10) / 10} мс)`,
        hits: 0,
      });
      continue;
    }

    // Открытие — ровно здесь и ровно для прошедших отбор (И1).
    const tSrc = clock();
    let result;
    try {
      const db = await src.open();
      result = hybridSearch(db, {
        ...shared,
        scopes: src.scopes,
        limit: perSourceLimit,
      });
    } catch (e) {
      // ПЕРВЫЙ источник — воркспейс, из которого позвали: без него команда
      // не имеет смысла, и ошибка обязана дойти до вызывающего целиком.
      // Остальные — необязательные соседи: сломанный чужой воркспейс не имеет
      // права ронять чтение своего, но и молчать о нём нельзя (И2).
      if (i === 0) throw e;
      reports.push({
        id: src.id,
        kind: src.kind,
        weight,
        queried: false,
        skipped: `не открылся: ${e instanceof Error ? e.message : String(e)}`,
        hits: 0,
      });
      continue;
    }
    const took = clock() - tSrc;

    reports.push({
      id: src.id,
      kind: src.kind,
      weight,
      queried: true,
      mode: result.mode_used,
      hits: result.hits.length,
      took_ms: Math.round(took * 10) / 10,
    });
    queriedSources.push({ source: src, hits: result.hits, mode: result.mode_used });
  }

  // --- слияние: тот же RRF, что внутри яруса, только по рангу в источнике ---
  interface Entry {
    hit: HybridHit;
    /** sourceId -> ранг узла в этом источнике. */
    readonly ranks: Map<string, number>;
    /** Порядок опроса первого источника, где узел нашёлся, — для приписывания. */
    firstOrder: number;
  }
  const byId = new Map<string, Entry>();
  for (let order = 0; order < queriedSources.length; order++) {
    const q = queriedSources[order]!;
    for (const h of q.hits) {
      const existing = byId.get(h.id);
      if (existing === undefined) {
        byId.set(h.id, { hit: h, ranks: new Map([[q.source.id, h.rank]]), firstOrder: order });
      } else {
        existing.ranks.set(q.source.id, h.rank);
      }
    }
  }

  const fused = [...byId.values()].map((entry) => {
    // Отсутствующие ранги дают ОДИНАКОВУЮ добавку каждому узлу только при
    // равном числе источников — оно тут и равно, поэтому формула честная и
    // совпадает со старой двухъярусной при двух источниках.
    let score = 0;
    for (const q of queriedSources) {
      const weight = q.source.weight ?? 1.0;
      const rank = entry.ranks.get(q.source.id) ?? cfg.missingRank;
      score += weight / (cfg.rrfK + rank);
    }
    // Узел, найденный в нескольких источниках, приписывается ПЕРВОМУ по
    // порядку опроса: проектный воркспейс главнее личного и репозиторных —
    // задачи и якоря живут только в нём (S41).
    const owner = queriedSources[entry.firstOrder]!.source;
    const foundIn = queriedSources
      .filter((q) => entry.ranks.has(q.source.id))
      .map((q) => q.source.id);
    return {
      entry,
      source: owner.id,
      tier: owner.kind,
      tierRank: entry.ranks.get(owner.id)!,
      foundIn,
      score,
    };
  });
  fused.sort((a, b) => b.score - a.score || (a.entry.hit.id < b.entry.hit.id ? -1 : 1));

  const hits: FederatedHit[] = fused.slice(0, limit).map((f, i) => ({
    ...f.entry.hit,
    rank: i + 1,
    source: f.source,
    tier: f.tier,
    tierRank: f.tierRank,
    foundIn: f.foundIn,
  }));

  const queriedCount = reports.filter((r) => r.queried).length;
  const projectReport = reports.find((r) => r.kind === "project" && r.queried);
  const personalReport = reports.find((r) => r.kind === "personal" && r.queried);
  const hasPersonalSource = sources.some((s) => s.kind === "personal");

  return {
    hits,
    mode_used: {
      sources: reports,
      queried: queriedCount,
      skipped: reports.length - queriedCount,
      cap,
      deadlineMs,
      took_ms: Math.round((clock() - t0) * 10) / 10,
      why: whyOf(reports, cap, deadlineMs, hasPersonalSource),
      // Первый опрошенный источник — проектный, если он есть; иначе просто
      // первый опрошенный: поверхности S41 ждут здесь непустой отчёт.
      project: (projectReport ?? reports.find((r) => r.queried))!.mode!,
      ...(personalReport !== undefined ? { personal: personalReport.mode! } : {}),
      personalQueried: personalReport !== undefined,
    },
  };
}
