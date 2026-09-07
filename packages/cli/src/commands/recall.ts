/**
 * `myc recall` — агентский поиск (§3.10). Обёртка над общим движком
 * ./retrieve.ts (решение D6): своей логики поиска здесь нет ни строки, только
 * агентский UX — бюджет символов, дедуп и свёрнутый вывод.
 *
 *   myc recall <запрос> [-n <k>] [--budget <chars>] [--kind ...] [--tag ...]
 *              [--layer L0..L3] [--since <dur>] [--anchor <file>]
 *              [--mode hybrid|vec|bm25] [--why]
 *
 * БЮДЖЕТ СИМВОЛОВ ПРЕДСКАЗУЕМ И ГРОМОК. Строки берутся строго по порядку
 * ранга; когда полная карточка не влезает, она СНАЧАЛА сворачивается в одну
 * строку и только потом, если не влезает и она, отбрасывается. Ни одна
 * строка не выкидывается молча: футер печатает и потраченные символы, и
 * число свёрнутых, и число не показанных. Порядок никогда не меняется, то
 * есть один и тот же запрос с одним и тем же бюджетом даёт один и тот же
 * вывод.
 *
 * И2. Футер всегда называет ветки, реально давшие выдачу (`bm25 only`,
 * `vec+bm25 rrf(k=60)`), а каждая причина деградации приходит WARN-строкой
 * из движка. Под --strict это exit 6.
 *
 * ОХВАТ (S58) ВИДЕН В КАЖДОЙ СТРОКЕ. `prj` — проектное, `ses` — своей сессии,
 * `ses*` — ЧУЖОЙ сессии (в `prime` его не будет, здесь оно находится),
 * `?` — охват не записан. Без `--reach` выдаются все: сессионная память не
 * испаряется, она просто вне контекста по умолчанию, и явный поиск обязан её
 * доставать. `--reach`/`--session` сужают выдачу до нужного охвата.
 *
 * ИСТОЧНИК (R3) — СУФФИКС СЛОЯ, ЧЕТВЁРТАЯ ОСЬ. `L1` — свой воркспейс,
 * `L1·me` — личный ярус (S41), `L1@collector` — воркспейс репозитория
 * collector. Читая из корня экосистемы, recall опрашивает и репозиторные
 * воркспейсы (решение S59), поэтому строка обязана говорить, ОТКУДА она
 * прочитана. Это не то же, что колонка охвата репозитория ниже: та говорит,
 * ПРО ЧТО знание, а суффикс — из какой базы оно взято. Узел про collector
 * может лежать в корневом воркспейсе, и наоборот.
 *
 * ПОДВАЛ НАЗЫВАЕТ ЧИСЛО ИСТОЧНИКОВ И ПРОПУСКИ. Источников до шестнадцати, а
 * бюджет один (И1, p99 25 мс), поэтому опрашиваются не все: `5 из 9
 * источников` плюс `4 источника пропущено: потолок 8`. Молча опросить не всех
 * и отдать выдачу как полную — ровно та болезнь, с которой борется И2.
 *
 * ОХВАТ РЕПОЗИТОРИЯ (S59) — СВОЯ КОЛОНКА, ТРЕТЬЯ ОСЬ. `все` — узел про всю
 * экосистему, имя репозитория — узел этого репозитория, `?` — охват не
 * записан. По умолчанию выдача сужена до репозитория, из которого позвали
 * (плюс общее и неопределённое, они видны отовсюду); `--repo <имя>` берёт
 * чужой, `--repo all` снимает фильтр. Число строк без охвата репозитория
 * стоит в подвале: невыведенный охват обязан быть виден, а не выглядеть
 * общим (И2).
 */

import { REACH_VALUES, reachTag, repoTag, resolveSession } from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandFailure } from "../registry.ts";
import { flagNum, flagStr, fmtDate, parseDuration, realStoreDeps, type StoreDeps } from "./store.ts";
import {
  KIND_NAMES,
  parseKinds,
  parseLayerRange,
  personalTierExists,
  embedTimeoutFromEnv,
  realRetrieveExtras,
  retrieve,
  whyLines,
  type DropCounts,
  type FederationSummary,
  type RetrieveDeps,
  type RetrieveMode,
  type RetrieveRow,
} from "./retrieve.ts";

const DEFAULT_LIMIT = 12;
/** Бюджет по умолчанию — 2000 символов, как в примере §3.10. */
const DEFAULT_BUDGET = 2000;
/** Потолок символьного бюджета из §2.7 (char_budget max 64000). */
const MAX_BUDGET = 64_000;
/** Ширина строки выдержки: две строки по 92 символа читаются агентом целиком. */
const EXCERPT_WIDTH = 92;
const EXCERPT_LINES = 2;

const RECALL_FLAGS: readonly FlagSpec[] = [
  { name: "limit", short: "n", value: "number", description: `max hits (default ${DEFAULT_LIMIT})` },
  { name: "offset", value: "number", description: "skip N rows (continues a previous page's cursor)" },
  { name: "budget", value: "number", description: `output character budget (default ${DEFAULT_BUDGET})` },
  { name: "kind", value: "string", description: `comma-separated kinds: ${KIND_NAMES.join(",")}` },
  { name: "tag", value: "string", description: "comma-separated tags (any match)" },
  { name: "layer", value: "string", description: "L0..L3 or a range like L1..L3" },
  { name: "since", value: "string", description: "only nodes updated within, e.g. 30d, 12h" },
  { name: "anchor", value: "string", description: "only nodes anchored at this path" },
  { name: "mode", value: "string", description: "hybrid (default) | vec | bm25" },
  { name: "why", description: "print why each retrieval branch was or was not used" },
  { name: "reach", value: "string", description: "comma-separated: session,project,unknown (S58)" },
  {
    name: "repo",
    value: "string",
    description: "repository scope (S59): a repo name, or `all` to drop the filter",
  },
  {
    name: "session",
    value: "string",
    description: "session identity: marks own rows as `ses`, filters with --reach session",
  },
  {
    name: "embed-timeout",
    value: "number",
    description: "ms to wait for the embedder to warm up (default 0 = skip the vector branch)",
  },
  {
    name: "sources",
    value: "number",
    description: "max workspaces to query (R3); higher raises latency, the footer names the skipped",
  },
];

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

function parseMode(raw: string | undefined): RetrieveMode | undefined {
  if (raw === undefined) return "hybrid";
  if (raw === "hybrid" || raw === "vec" || raw === "bm25") return raw;
  return undefined;
}

// ---------------------------------------------------------------------------
// Свёртка строк
// ---------------------------------------------------------------------------

/** Мягкий перенос по словам; длинное слово режется, а не ломает ширину. */
function wrap(text: string, width: number, maxLines: number): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return [];
  const out: string[] = [];
  let rest = flat;
  while (rest.length > 0 && out.length < maxLines) {
    if (rest.length <= width) {
      out.push(rest);
      rest = "";
      break;
    }
    const slice = rest.slice(0, width + 1);
    const cut = slice.lastIndexOf(" ");
    const at = cut > width * 0.5 ? cut : width;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0 && out.length > 0) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
  }
  return out;
}

/**
 * Векторная confidence, если у хита вообще есть векторный сигнал; иначе "·" —
 * не "0.00" (нуль читался бы как измеренное низкое качество, а сигнала нет
 * вовсе, это разные новости — И2, myc-ye3.9).
 */
function confidenceCell(row: RetrieveRow): string {
  return row.confidence === undefined ? "   ·" : row.confidence.toFixed(2).padStart(4);
}

/** Ширина колонки охвата репозитория: имена длиннее режутся, строка не едет. */
const REPO_CELL = 12;

/** Ширина имени источника в суффиксе слоя: длиннее — обрезается, строка не едет. */
const SOURCE_CELL = 10;

/**
 * Суффикс слоя — источник строки (R3). Свой воркспейс не подписывается: он
 * умолчание и подпись на каждой строке была бы шумом. Личный ярус остаётся
 * `·me` (S41, так его читают и глаза, и тесты), репозиторный воркспейс —
 * `@имя`: разные знаки, потому что это разные роды источника, а не длина
 * одного и того же имени.
 */
function sourceSuffix(row: RetrieveRow): string {
  if (row.tier === "personal") return "·me";
  if (row.tier === "repo") return `@${row.source.slice(0, SOURCE_CELL)}`;
  return "";
}

/**
 * Всё, кроме заголовка: ранг, confidence, id, тип, слой (+источник), охват
 * сессии, охват репозитория, дата.
 */
function headPrefix(row: RetrieveRow, session: string): string {
  const conf = confidenceCell(row);
  const layer = `L${row.layer}${sourceSuffix(row)}`;
  // Четыре оси. Источник (S41/R3) едет суффиксом слоя, охват сессии (S58) и
  // охват репозитория (S59) стоят каждый своей колонкой: склеить любые две
  // значило бы потерять одну из них.
  const reach = reachTag({ reach: row.reach, session: row.reach_session, by: row.reach_by }, session)
    .padEnd(4);
  const repo = repoTag({ repo: row.repo, state: row.repo_state, by: "recorded" })
    .slice(0, REPO_CELL)
    .padEnd(4);
  return `${row.rank}. ${conf} ${row.id} ${row.type} ${layer} ${reach} ${repo} ${fmtDate(row.updated_at)}  `;
}

function headLine(row: RetrieveRow, session: string): string {
  return `${headPrefix(row, session)}${row.title}`;
}

const COLLAPSED_SUFFIX = " (свёрнуто)";
/**
 * Ниже этого заголовок обрезать бессмысленно — строка перестаёт что-либо
 * говорить, и честнее не показать её вовсе, объявив в футере.
 */
const MIN_TITLE_CHARS = 24;

/**
 * Свёрнутая строка: заголовок урезается ПОД ОСТАТОК БЮДЖЕТА, а не до
 * фиксированной длины. Иначе один длинный заголовок выбивал бы весь хит из
 * выдачи, хотя место под него ещё было, — а для агента обрезанный заголовок
 * с id несравнимо полезнее отсутствующей строки.
 */
function collapsedLine(row: RetrieveRow, room: number, session: string): string | null {
  const prefix = headPrefix(row, session);
  const fixed = prefix.length + COLLAPSED_SUFFIX.length + 1; // +1 — перевод строки
  const full = `${prefix}${row.title}${COLLAPSED_SUFFIX}`;
  if (full.length + 1 <= room) return full;
  const titleRoom = room - fixed - 1; // -1 — место под многоточие
  if (titleRoom < MIN_TITLE_CHARS) return null;
  return `${prefix}${row.title.slice(0, titleRoom).trimEnd()}…${COLLAPSED_SUFFIX}`;
}

/**
 * Выдержка без повтора заголовка. `excerpt` считается движком из body (S5), а
 * body заметки начинается той же строкой, что и заголовок, — печатать её
 * дважды значит платить токенами агента за то, что он уже прочитал.
 */
function excerptBody(row: RetrieveRow): string {
  const excerpt = row.excerpt.trim();
  const title = row.title.trim();
  if (title.length > 0 && excerpt.startsWith(title)) {
    return excerpt.slice(title.length).trim();
  }
  return excerpt;
}

function cost(lines: readonly string[]): number {
  let n = 0;
  for (const l of lines) n += l.length + 1;
  return n;
}

export interface RecallData {
  query: string;
  rows: RetrieveRow[];
  /** Индексы строк (в rows), напечатанных в свёрнутом виде. */
  collapsed: string[];
  /** Строки, не показанные из-за бюджета. */
  dropped: string[];
  shown: number;
  total: number;
  pool_exhausted: boolean;
  deduped: number;
  budget: number;
  used_chars: number;
  mode: string;
  mode_used: unknown;
  tiers: { project: boolean; personal: boolean };
  /** Федерация по N воркспейсам (R3): опрошенные, пропущенные и причины. */
  federation: FederationSummary;
  personal_available: boolean;
  /** Ключ текущей сессии: им отличается `ses` от `ses*`. */
  session: string;
  /** Сколько строк выдачи принадлежит ЧУЖИМ сессиям (S58, И2). */
  foreign: number;
  /** Сколько строк выдачи без записанного охвата. */
  unknown_reach: number;
  /** Целевой репозиторий фильтра; пусто — фильтра не было (S59). */
  repo: string;
  /** Сколько строк выдачи без записанного охвата репозитория (S59, И2). */
  unknown_repo: number;
  /**
   * Отсев ПО ПРИЧИНАМ (И2). Подвал советует ОДНУ ручку — самую весомую;
   * здесь лежат все числа, которыми этот совет проверяется. Агент, которому
   * подвал коротковат, читает причину отсюда, а не гадает по тексту.
   */
  drops: DropCounts;
  why: string[] | undefined;
  took_ms: number;
  // --- бюджетированный ретривал (§2.7): обрезка помечена, а не молчалива ---
  /** true — получено не всё: узлы сверх бюджета, таймаут сборки или есть продолжение. */
  partial: boolean;
  /** Кандидаты страницы, не влезшие в символьный бюджет движка. */
  omitted: number;
  /** Продолжение выдачи: следующий --offset; undefined — выдача исчерпана. */
  cursor: string | undefined;
  /** Pass 2 (подъём crux → тело) оборван дедлайном 20 мс. */
  budget_timed_out: boolean;
}

/**
 * Отрисовка и подсчёт бюджета — одна функция: иначе напечатанное и
 * посчитанное разъезжаются, и «641 симв из 2000» становится враньём.
 */
function layout(d: RecallData): { lines: string[]; used: number; collapsed: string[]; dropped: string[] } {
  const lines: string[] = [];
  const collapsed: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const row of d.rows) {
    const full = [
      headLine(row, d.session),
      ...wrap(excerptBody(row), EXCERPT_WIDTH, EXCERPT_LINES).map((l) => `     ${l}`),
    ];
    if (used + cost(full) <= d.budget) {
      lines.push(...full);
      used += cost(full);
      continue;
    }
    const short = collapsedLine(row, d.budget - used, d.session);
    if (short !== null) {
      lines.push(short);
      used += short.length + 1;
      collapsed.push(row.id);
    } else {
      dropped.push(row.id);
    }
  }
  return { lines, used, collapsed, dropped };
}

function renderRecallHuman(raw: unknown): string {
  const d = raw as RecallData;
  const { lines, used, collapsed, dropped } = layout(d);
  const footer: string[] = [
    `${d.shown} из ${d.total}`,
    d.mode,
    `${d.took_ms} мс`,
    `${used} симв из ${d.budget}`,
  ];
  if (d.tiers.personal) footer.push("2 яруса");
  // И2: сколько воркспейсов реально опрошено и сколько пропущено — числом и с
  // причиной. Один источник — говорить не о чем, федерации не было.
  if (d.federation.total > 1) {
    footer.push(`${d.federation.queried.length} из ${d.federation.total} источников`);
  }
  if (d.federation.skipped.length > 0) {
    // Причины схлопываются по тексту: «потолок 8» одинаков у всех отсечённых,
    // печатать его одиннадцать раз — шум, а не честность.
    const byWhy = new Map<string, string[]>();
    for (const s of d.federation.skipped) {
      const list = byWhy.get(s.why);
      if (list === undefined) byWhy.set(s.why, [s.id]);
      else list.push(s.id);
    }
    for (const [why, ids] of byWhy) {
      footer.push(`${ids.length} источник(ов) пропущено (${ids.join(", ")}): ${why}`);
    }
  }
  // И2: чужое сессионное и неопределённое обязаны быть названы числом —
  // иначе метки в строках можно и не заметить в длинной выдаче.
  if (d.foreign > 0) footer.push(`${d.foreign} из чужих сессий`);
  if (d.unknown_reach > 0) footer.push(`${d.unknown_reach} без охвата`);
  if (d.repo.length > 0) footer.push(`repo ${d.repo}`);
  if (d.unknown_repo > 0) footer.push(`${d.unknown_repo} без охвата репозитория`);
  if (d.deduped > 0) footer.push(`${d.deduped} дублей свёрнуто`);
  if (collapsed.length > 0) footer.push(`${collapsed.length} свёрнуто по бюджету`);
  if (dropped.length > 0) footer.push(`${dropped.length} не показано (бюджет)`);
  if (d.partial) {
    const why: string[] = [];
    if (d.omitted > 0) why.push(`${d.omitted} сверх бюджета`);
    if (d.budget_timed_out) why.push("таймаут сборки");
    footer.push(`partial: ${why.length > 0 ? why.join(", ") : "выдано не всё"}`);
  }
  if (d.cursor !== undefined) footer.push(`дальше --offset ${d.cursor}`);
  if (d.pool_exhausted) footer.push("пул исчерпан, total — нижняя оценка");
  lines.push(footer.join(" · "));
  if (d.why !== undefined) lines.push(...d.why);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export const realRecallDeps: RetrieveDeps = {
  openStore: realStoreDeps.openStore,
  ...realRetrieveExtras,
};

export function createRecallCommand(deps: RetrieveDeps = realRecallDeps): Command {
  return {
    name: "recall",
    summary: "agent-facing memory search: character budget, dedup, collapsed output",
    flags: RECALL_FLAGS,
    help:
      "Same engine as `myc search`, different UX (decision D6). Reads BOTH tiers through " +
      "federatedSearch and marks the personal tier as `me`. The footer always names the " +
      "retrieval branches that actually produced the output; degradation is a WARN line, " +
      "and exit 6 under --strict.",
    handler: async (ctx) => {
      const text = ctx.args.join(" ").trim();
      if (text.length === 0) {
        return failure("usage.invalid", "нужен запрос: myc recall <текст>", ExitCode.USAGE);
      }

      const mode = parseMode(flagStr(ctx, "mode"));
      if (mode === undefined) {
        return failure(
          "usage.invalid",
          `неверный --mode '${flagStr(ctx, "mode")}'; допустимы hybrid, vec, bm25`,
          ExitCode.USAGE,
        );
      }

      const kinds = parseKinds(flagStr(ctx, "kind"));
      if (!kinds.ok) {
        return failure(
          "usage.invalid",
          `неизвестный --kind '${kinds.bad}'; допустимы ${KIND_NAMES.join(", ")}`,
          ExitCode.USAGE,
        );
      }

      const layers = parseLayerRange(flagStr(ctx, "layer"));
      if (!layers.ok) {
        return failure(
          "usage.invalid",
          `неверный --layer '${flagStr(ctx, "layer")}'; формат L1 или L1..L3`,
          ExitCode.USAGE,
        );
      }

      let since: number | undefined;
      const sinceRaw = flagStr(ctx, "since");
      if (sinceRaw !== undefined) {
        const dur = parseDuration(sinceRaw);
        if (dur === undefined) {
          return failure(
            "usage.invalid",
            `неверный --since '${sinceRaw}'; формат 30d, 12h, 90m`,
            ExitCode.USAGE,
          );
        }
        since = Date.now() - dur;
      }

      const limitRaw = flagNum(ctx, "limit");
      const limit =
        limitRaw !== undefined && Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(Math.floor(limitRaw), 100)
          : DEFAULT_LIMIT;
      const offsetRaw = flagNum(ctx, "offset");
      const offset =
        offsetRaw !== undefined && Number.isFinite(offsetRaw) && offsetRaw > 0
          ? Math.floor(offsetRaw)
          : 0;
      const budgetRaw = flagNum(ctx, "budget");
      const budget =
        budgetRaw !== undefined && Number.isFinite(budgetRaw) && budgetRaw > 0
          ? Math.min(Math.floor(budgetRaw), MAX_BUDGET)
          : DEFAULT_BUDGET;

      // ОХВАТ (S58): без --reach выдаются все — сессионное не испаряется, оно
      // просто вне контекста по умолчанию и обязано находиться явным поиском.
      const reachRaw = flagStr(ctx, "reach");
      const reachFilter = (reachRaw ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
      const allowedReach = [...REACH_VALUES, "unknown"];
      const badReach = reachFilter.find((x) => !allowedReach.includes(x));
      if (badReach !== undefined) {
        return failure(
          "usage.invalid",
          `неверный --reach '${badReach}'; допустимы ${allowedReach.join(", ")}`,
          ExitCode.USAGE,
        );
      }
      const session = resolveSession(flagStr(ctx, "session"));

      const tags = (flagStr(ctx, "tag") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // Прогрев эмбеддера — явный и с дедлайном: по умолчанию 0, то есть
      // векторная ветка в одноразовом процессе не звалась, и об этом
      // говорит WARN, а не молчание (см. retrieve.ts).
      const embedTimeoutRaw = flagNum(ctx, "embed-timeout");
      const embedTimeoutMs =
        embedTimeoutRaw !== undefined && Number.isFinite(embedTimeoutRaw) && embedTimeoutRaw >= 0
          ? Math.floor(embedTimeoutRaw)
          : embedTimeoutFromEnv();

      const sourcesRaw = flagNum(ctx, "sources");
      const maxSources =
        sourcesRaw !== undefined && Number.isFinite(sourcesRaw) && sourcesRaw >= 1
          ? Math.floor(sourcesRaw)
          : undefined;

      const result = await retrieve(ctx, deps, {
        text,
        limit,
        offset,
        mode,
        fullFields: false,
        // --budget — бюджет ОТВЕТА: движок применяет его к текстам узлов
        // (§2.7, узел либо целиком, либо crux), рендер — к напечатанным
        // строкам. Двойной учёт сходится в футере. Pass 2 (подъём crux →
        // тело) выключен: агентская карточка печатает выдержку, платить
        // бюджетом за невидимые здесь тела — значит резать число карточек.
        charBudget: budget,
        upgradeContent: false,
        embedTimeoutMs,
        // Потолок источников — явный рычаг, а не константа в коде (R3): цена
        // его подъёма измерима и названа в подвале, поэтому пусть его двигает
        // тот, кому знание соседей важнее миллисекунд.
        ...(maxSources !== undefined ? { maxSources } : {}),
        // Ручки берутся из СПЕЦИФИКАЦИИ этой же команды, а не переписываются
        // рядом строкой: совет при пустой выдаче называет только те флаги,
        // которые здесь действительно есть, и переименование флага меняет
        // совет само (S59, И2).
        knobs: RECALL_FLAGS.map((s) => s.name),
        filters: {
          ...(kinds.kinds.length > 0 ? { kinds: kinds.kinds } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(layers.min !== undefined ? { layerMin: layers.min } : {}),
          ...(layers.max !== undefined ? { layerMax: layers.max } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(flagStr(ctx, "anchor") !== undefined ? { anchor: flagStr(ctx, "anchor")! } : {}),
          ...(reachFilter.length > 0 ? { reach: reachFilter } : {}),
          // Сессия сужает выдачу ТОЛЬКО вместе с `--reach session`: сама по
          // себе она нужна для метки `ses` против `ses*`, и молча резать по
          // ней всю выдачу значило бы прятать проектное знание.
          ...(reachFilter.includes("session") && session.length > 0
            ? { reachSession: session }
            : {}),
          // Умолчание фильтра — каталог вызова; разбор и снятие (`all`)
          // живут в repoTarget (store.ts), общем с `myc ready`.
          ...(flagStr(ctx, "repo") !== undefined ? { repo: flagStr(ctx, "repo")! } : {}),
        },
      });
      if (!result.ok) return result.failure;
      const o = result.outcome;

      const base: RecallData = {
        query: text,
        rows: [...o.rows],
        collapsed: [],
        dropped: [],
        shown: o.rows.length,
        total: o.total,
        pool_exhausted: o.poolExhausted,
        deduped: o.deduped,
        budget,
        used_chars: 0,
        mode: o.modeLabel,
        mode_used: o.mode_used,
        tiers: o.tiers,
        federation: o.federation,
        personal_available: o.tiers.personal || personalTierExists(),
        session,
        foreign: o.rows.filter((r) => r.reach === "session" && r.reach_session !== session).length,
        unknown_reach: o.rows.filter((r) => r.reach === "unknown").length,
        repo: o.repo,
        unknown_repo: o.rows.filter((r) => r.repo_state === "unknown").length,
        drops: o.drops,
        why: ctx.flags["why"] === true ? whyLines(o.mode_used) : undefined,
        took_ms: o.took_ms,
        partial: o.partial,
        omitted: o.omitted,
        cursor: o.cursor,
        budget_timed_out: o.budgetTimedOut,
      };
      // Бюджет считается один раз здесь, чтобы --json нёс ровно те же числа,
      // что печатает человеческий рендер: он их не пересчитывает, а читает.
      const measured = layout(base);
      const data: RecallData = {
        ...base,
        collapsed: measured.collapsed,
        dropped: measured.dropped,
        shown: o.rows.length - measured.dropped.length,
        used_chars: measured.used,
      };

      return {
        ok: true,
        data,
        meta: {
          took_ms: o.took_ms,
          mode: o.modeLabel,
          mode_used: o.mode_used,
          budget,
          used_chars: measured.used,
          session: session.length > 0 ? session : null,
          foreign: base.foreign,
          unknown_reach: base.unknown_reach,
          repo: o.repo.length > 0 ? o.repo : null,
          federation: o.federation,
          unknown_repo: base.unknown_repo,
          partial: o.partial,
          omitted: o.omitted,
          ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
          budget_timed_out: o.budgetTimedOut,
          budget_chars: o.budgetChars,
          engine_used_chars: o.usedChars,
        },
      };
    },
    renderHuman: renderRecallHuman,
  };
}
