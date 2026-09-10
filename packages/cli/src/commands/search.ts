/**
 * `myc search` — человеческий поиск (§3.11). Тот же движок, что у
 * `myc recall` (./retrieve.ts, решение D6), другой UX: полные поля,
 * фильтры, сортировки, постраничность.
 *
 *   myc search <запрос> [--kind] [--tag] [--author] [--since/--until]
 *              [--acl] [--sort score|updated|created] [--fields <list>]
 *              [--limit <n>] [--offset <n>] [--full] [--mode] [--why]
 *
 * Отличие от recall — только в форме вывода и наборе фильтров: ни одного
 * своего обращения к ретривалу, ни одного своего SQL. Ровно это и требует
 * D6 («дублировать логику нельзя, дублировать UX нужно»).
 *
 * И2. Пример в §3.11 показывает футер `4 из 4 · 12 мс`; здесь между ними
 * стоит ещё и ярлык веток (`bm25 only`). Это сознательное расширение
 * примера: инвариант И2 требует, чтобы состав веток был виден на КАЖДОЙ
 * поверхности, а не только в recall, иначе выключенный вектор в `search`
 * оказывается тем самым молчаливым фолбэком.
 */

import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import { renderTable } from "../render.ts";
import { flagNum, flagStr, fmtDate, parseDuration, realStoreDeps } from "./store.ts";
import {
  KIND_NAMES,
  parseKinds,
  parseLayerRange,
  embedTimeoutFromEnv,
  realRetrieveExtras,
  retrieve,
  whyLines,
  type RetrieveDeps,
  type RetrieveMode,
  type RetrieveRow,
} from "./retrieve.ts";

const DEFAULT_LIMIT = 20;
const DEFAULT_FIELDS = ["id", "kind", "updated", "acl", "title"] as const;

/** Колонки: имя в --fields → заголовок и как достать значение из строки. */
const FIELDS: Readonly<Record<string, (r: RetrieveRow) => string>> = {
  id: (r) => r.id,
  score: (r) => (r.confidence === undefined ? "·" : r.confidence.toFixed(2)),
  rank: (r) => String(r.rank),
  kind: (r) => r.type,
  layer: (r) => `L${r.layer}`,
  tier: (r) => r.tier,
  updated: (r) => fmtDate(r.updated_at),
  created: (r) => (r.created_at !== undefined ? fmtDate(r.created_at) : ""),
  acl: (r) => r.acl ?? "",
  author: (r) => r.author ?? "",
  status: (r) => r.status ?? "",
  tags: (r) => (r.tags ?? []).join(","),
  anchors: (r) => (r.anchors ?? []).join(" "),
  sources: (r) => r.sources.join("+"),
  title: (r) => r.title,
  excerpt: (r) => r.excerpt,
};

export const FIELD_NAMES: readonly string[] = Object.keys(FIELDS);

const SEARCH_FLAGS: readonly FlagSpec[] = [
  { name: "kind", value: "string", description: `comma-separated kinds: ${KIND_NAMES.join(",")}` },
  { name: "tag", value: "string", description: "comma-separated tags (any match)" },
  { name: "author", value: "string", description: "actor that recorded the node" },
  { name: "acl", value: "string", description: "comma-separated acl modes" },
  { name: "layer", value: "string", description: "L0..L3 or a range like L1..L3" },
  { name: "since", value: "string", description: "updated within, e.g. 30d, 12h" },
  { name: "until", value: "string", description: "updated no later than, e.g. 1d" },
  { name: "sort", value: "string", description: "score (default) | updated | created" },
  { name: "fields", value: "string", description: `columns: ${Object.keys(FIELDS).join(",")}` },
  { name: "limit", value: "number", description: `page size (default ${DEFAULT_LIMIT})` },
  { name: "offset", value: "number", description: "skip N rows" },
  { name: "full", description: "print title, excerpt and anchors per row instead of a table" },
  { name: "mode", value: "string", description: "hybrid (default) | vec | bm25" },
  { name: "why", description: "print why each retrieval branch was or was not used" },
  {
    name: "embed-timeout",
    value: "number",
    description: "ms to wait for the embedder to warm up (default 0 = skip the vector branch)",
  },
];

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

function splitList(text: string | undefined): string[] {
  if (text === undefined) return [];
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseMode(raw: string | undefined): RetrieveMode | undefined {
  if (raw === undefined) return "hybrid";
  if (raw === "hybrid" || raw === "vec" || raw === "bm25") return raw;
  return undefined;
}

type SortKey = "score" | "updated" | "created";

function parseSort(raw: string | undefined): SortKey | undefined {
  if (raw === undefined) return "score";
  if (raw === "score" || raw === "updated" || raw === "created") return raw;
  return undefined;
}

export interface SearchData {
  query: string;
  rows: RetrieveRow[];
  fields: string[];
  full: boolean;
  shown: number;
  total: number;
  offset: number;
  pool_exhausted: boolean;
  deduped: number;
  mode: string;
  mode_used: unknown;
  tiers: { project: boolean; personal: boolean };
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

function renderSearchHuman(raw: unknown, ctx: CommandContext): string {
  const d = raw as SearchData;
  const lines: string[] = [];

  if (d.full) {
    for (const r of d.rows) {
      const tier = r.tier === "personal" ? " ·me" : "";
      lines.push(`${r.id}  ${r.type}  L${r.layer}${tier}  ${fmtDate(r.updated_at)}  ${r.title}`);
      const meta: string[] = [];
      if ((r.tags ?? []).length > 0) meta.push(`tags ${(r.tags ?? []).join(",")}`);
      if (r.acl !== undefined) meta.push(`acl ${r.acl}`);
      if ((r.author ?? "").length > 0) meta.push(`by ${r.author}`);
      meta.push(`src ${r.sources.join("+")}`);
      lines.push(`  ${meta.join(" · ")}`);
      // И2: тело, срезанное бюджетом сборки (§2.7), помечено прямо у строки —
      // напечатан crux, и агент/человек видит, что это не весь узел.
      if (r.content_kind === "crux") lines.push("  (truncated by budget)");
      // Тело заметки начинается той же строкой, что и заголовок (splitFact в
      // remember.ts кладёт в body весь факт целиком) — печатать её второй раз
      // сразу под заголовком незачем.
      let body = (r.body ?? r.excerpt).trim();
      const title = r.title.trim();
      if (title.length > 0 && body.startsWith(title)) body = body.slice(title.length).trim();
      if (body.length > 0) lines.push(`  ${body.replace(/\n/g, "\n  ")}`);
      for (const a of r.anchors ?? []) lines.push(`  ⌖ ${a}`);
    }
  } else {
    const header = d.fields;
    const rows = d.rows.map((r) => d.fields.map((f) => (FIELDS[f] ?? (() => ""))(r)));
    if (rows.length > 0) lines.push(renderTable(header, rows, ctx.globals.color).trimEnd());
  }

  const footer: string[] = [`${d.shown} of ${d.total}`, d.mode, `${d.took_ms} ms`];
  if (d.offset > 0) footer.push(`offset ${d.offset}`);
  if (d.tiers.personal) footer.push("2 tiers");
  if (d.deduped > 0) footer.push(`${d.deduped} ${d.deduped === 1 ? "duplicate" : "duplicates"} collapsed`);
  if (d.partial) {
    const why: string[] = [];
    if (d.omitted > 0) why.push(`${d.omitted} over budget`);
    if (d.budget_timed_out) why.push("assembly timeout");
    footer.push(`partial: ${why.length > 0 ? why.join(", ") : "not everything returned"}`);
  }
  if (d.cursor !== undefined) footer.push(`next: --offset ${d.cursor}`);
  if (d.pool_exhausted) footer.push("pool exhausted, total is a lower bound");
  lines.push(footer.join(" · "));
  if (d.why !== undefined) lines.push(...d.why);
  return `${lines.join("\n")}\n`;
}

export const realSearchDeps: RetrieveDeps = {
  openStore: realStoreDeps.openStore,
  ...realRetrieveExtras,
};

export function createSearchCommand(deps: RetrieveDeps = realSearchDeps): Command {
  return {
    name: "search",
    summary: "human-facing memory search: full fields, filters, sorting, paging",
    flags: SEARCH_FLAGS,
    help:
      "Same engine as `myc recall` (decision D6), different UX. Reads BOTH tiers through " +
      "federatedSearch; the `tier` column marks where a hit came from. The footer names the " +
      "retrieval branches that actually produced the output.",
    handler: async (ctx) => {
      const text = ctx.args.join(" ").trim();
      if (text.length === 0) {
        return failure("usage.invalid", "query required: myc search <text>", ExitCode.USAGE);
      }

      const mode = parseMode(flagStr(ctx, "mode"));
      if (mode === undefined) {
        return failure(
          "usage.invalid",
          `invalid --mode '${flagStr(ctx, "mode")}'; allowed: hybrid, vec, bm25`,
          ExitCode.USAGE,
        );
      }

      const sort = parseSort(flagStr(ctx, "sort"));
      if (sort === undefined) {
        return failure(
          "usage.invalid",
          `invalid --sort '${flagStr(ctx, "sort")}'; allowed: score, updated, created`,
          ExitCode.USAGE,
        );
      }

      const kinds = parseKinds(flagStr(ctx, "kind"));
      if (!kinds.ok) {
        return failure(
          "usage.invalid",
          `unknown --kind '${kinds.bad}'; allowed: ${KIND_NAMES.join(", ")}`,
          ExitCode.USAGE,
        );
      }

      const layers = parseLayerRange(flagStr(ctx, "layer"));
      if (!layers.ok) {
        return failure(
          "usage.invalid",
          `invalid --layer '${flagStr(ctx, "layer")}'; format: L1 or L1..L3`,
          ExitCode.USAGE,
        );
      }

      const fields = splitList(flagStr(ctx, "fields"));
      const useFields = fields.length > 0 ? fields : [...DEFAULT_FIELDS];
      for (const f of useFields) {
        if (FIELDS[f] === undefined) {
          return failure(
            "usage.invalid",
            `unknown field '${f}'; allowed: ${Object.keys(FIELDS).join(", ")}`,
            ExitCode.USAGE,
          );
        }
      }

      let since: number | undefined;
      const sinceRaw = flagStr(ctx, "since");
      if (sinceRaw !== undefined) {
        const dur = parseDuration(sinceRaw);
        if (dur === undefined) {
          return failure("usage.invalid", `invalid --since '${sinceRaw}'`, ExitCode.USAGE);
        }
        since = Date.now() - dur;
      }
      let until: number | undefined;
      const untilRaw = flagStr(ctx, "until");
      if (untilRaw !== undefined) {
        const dur = parseDuration(untilRaw);
        if (dur === undefined) {
          return failure("usage.invalid", `invalid --until '${untilRaw}'`, ExitCode.USAGE);
        }
        until = Date.now() - dur;
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

      const tags = splitList(flagStr(ctx, "tag"));
      const acl = splitList(flagStr(ctx, "acl"));
      const author = flagStr(ctx, "author");

      // Прогрев эмбеддера — явный и с дедлайном: по умолчанию 0, то есть
      // векторная ветка в одноразовом процессе не звалась, и об этом
      // говорит WARN, а не молчание (см. retrieve.ts).
      const embedTimeoutRaw = flagNum(ctx, "embed-timeout");
      const embedTimeoutMs =
        embedTimeoutRaw !== undefined && Number.isFinite(embedTimeoutRaw) && embedTimeoutRaw >= 0
          ? Math.floor(embedTimeoutRaw)
          : embedTimeoutFromEnv();

      const result = await retrieve(ctx, deps, {
        text,
        limit,
        offset,
        mode,
        // Человеческий UX всегда показывает полные поля — гидратация обязательна.
        fullFields: true,
        embedTimeoutMs,
        // См. recall: список ручек — это FlagSpec[] самой команды. У `search`
        // нет `--repo`, поэтому совет про охват репозитория здесь честно
        // говорит про запуск из корня, а не про несуществующий флаг.
        knobs: SEARCH_FLAGS.map((s) => s.name),
        filters: {
          ...(kinds.kinds.length > 0 ? { kinds: kinds.kinds } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(acl.length > 0 ? { acl } : {}),
          ...(author !== undefined ? { author } : {}),
          ...(layers.min !== undefined ? { layerMin: layers.min } : {}),
          ...(layers.max !== undefined ? { layerMax: layers.max } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
        },
      });
      if (!result.ok) return result.failure;
      const o = result.outcome;

      // Сортировка — только внутри уже отобранной страницы: движок ранжирует
      // по релевантности, --sort меняет ПОРЯДОК ПОКАЗА, а не то, что нашлось.
      const rows = [...o.rows];
      if (sort === "updated") rows.sort((a, b) => b.updated_at - a.updated_at);
      else if (sort === "created") rows.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

      const data: SearchData = {
        query: text,
        rows,
        fields: useFields,
        full: ctx.flags["full"] === true,
        shown: rows.length,
        total: o.total,
        offset,
        pool_exhausted: o.poolExhausted,
        deduped: o.deduped,
        mode: o.modeLabel,
        mode_used: o.mode_used,
        tiers: o.tiers,
        why: ctx.flags["why"] === true ? whyLines(o.mode_used) : undefined,
        took_ms: o.took_ms,
        partial: o.partial,
        omitted: o.omitted,
        cursor: o.cursor,
        budget_timed_out: o.budgetTimedOut,
      };
      return {
        ok: true,
        data,
        meta: {
          took_ms: o.took_ms,
          mode: o.modeLabel,
          mode_used: o.mode_used,
          sort,
          offset,
          partial: o.partial,
          omitted: o.omitted,
          ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
          budget_timed_out: o.budgetTimedOut,
        },
      };
    },
    renderHuman: renderSearchHuman,
  };
}
