/**
 * Экран «база знаний»: виды note, doc, fragment, entity, skill — всё, что не
 * задача. Чтение своим read-only соединением, записи здесь нет вовсе.
 *
 * ДВЕ ОСИ ОХВАТА, обе приняты решениями и обе обязаны быть видны (S58, S59):
 *
 *   охват сессии (attrs.reach)        — «нужно ли это в контексте другой
 *                                       крупной задачи»; session по умолчанию,
 *                                       project по явному решению;
 *   охват репозитория (attrs.repo)    — «про какую часть экосистемы это».
 *
 * Оси НЕЗАВИСИМЫ друг от друга и от яруса (S41), поэтому в каждой строке они
 * два разных поля, а не одно: сведение — это выбор, какой из двух признаков
 * потерять (repo.ts). Заметка без охвата — ОБЫЧНОЕ СОСТОЯНИЕ рабочей базы:
 * она остаётся в списке с пометкой «без охвата» и попадает в счётчик подвала,
 * а не прячется (И2 — молча уводить из виду то, чей охват не знаем, значит
 * терять память старых баз).
 *
 * Разбор attrs идёт функциями ядра (@myc/core), а не зеркалом: расхождение
 * между тем, как охват читает prime/ready, и тем, как его показывает
 * интерфейс, было бы второй реализацией одного правила.
 */

import { readReach, readRepo } from "@myc/core";
import type { ReadOnlyDb } from "./db.ts";
import type { CountRow, KbCounts, KbPayload, KbReachState, KbRepoState, KbRow } from "./types.ts";

/** Виды базы знаний: девять видов ядра минус задачи и служебные (session,
 *  message, anchor живут своими экранами и в список знаний не заходят). */
export const KB_KINDS: readonly string[] = ["note", "doc", "fragment", "entity", "skill"];

/**
 * Состояние кандидата хука сжатия (§6.2). Совпадает с PENDING_REVIEW в
 * @myc/retrieval (review.ts), где живёт фильтр выдачи; у веба зависимости от
 * retrieval нет, поэтому здесь копия строки, а не импорт.
 */
const PENDING_REVIEW = "pending_review";
/** Разбор кандидата закончен — отклонён или заменён; в «ждёт» не входит. */
const REVIEWED_STATUSES = new Set(["retracted", "superseded"]);

const ROWS_SQL = `
SELECT id, kind, title, status, layer, acl, attrs, updated_at
  FROM nodes
 WHERE deleted_at IS NULL AND kind IN ('note','doc','fragment','entity','skill')
 ORDER BY updated_at DESC, id ASC`;

interface RawRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  layer: number;
  acl: string;
  attrs: string;
  updated_at: number;
}

function parseAttrs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // битый attrs не роняет список — оси честно станут unknown
  }
}

function tagsOf(attrs: Record<string, unknown>): string[] {
  return Array.isArray(attrs["tags"])
    ? attrs["tags"].filter((t): t is string => typeof t === "string")
    : [];
}

/** Одна строка списка. Оси читаются ядром — тем же кодом, что у prime/ready. */
function toRow(r: RawRow): KbRow {
  const attrs = parseAttrs(r.attrs);
  const reach = readReach(attrs as never);
  const repo = readRepo(attrs as never);
  const subtype = typeof attrs["type"] === "string" && attrs["type"].length > 0
    ? (attrs["type"] as string)
    : null;
  return {
    id: r.id,
    kind: r.kind,
    subtype,
    title: r.title,
    status: r.status,
    layer: r.layer,
    acl: r.acl,
    tags: tagsOf(attrs),
    reach: reach.reach as KbReachState,
    session: reach.session,
    repo: repo.repo,
    repo_state: repo.state as KbRepoState,
    review: attrs["state"] === PENDING_REVIEW ? PENDING_REVIEW : null,
    updated_at: r.updated_at,
  };
}

function topCounts(map: Map<string, number>): CountRow[] {
  return [...map.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/** Счётчики по ВСЕМУ списку знаний, без фильтров: подвал описывает базу,
 *  а не выборку — иначе скрытое фильтром было бы видно только ему. */
function countsOf(rows: readonly KbRow[]): KbCounts {
  const byKind = new Map<string, number>();
  const byLayer = new Map<string, number>();
  const reach = { project: 0, session: 0, unknown: 0 };
  const repo = { root: 0, unknown: 0, by_repo: new Map<string, number>() };
  let pending = 0;
  for (const r of rows) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    const l = `L${r.layer}`;
    byLayer.set(l, (byLayer.get(l) ?? 0) + 1);
    reach[r.reach] += 1;
    if (r.repo_state === "root") repo.root += 1;
    else if (r.repo_state === "unknown") repo.unknown += 1;
    else repo.by_repo.set(r.repo, (repo.by_repo.get(r.repo) ?? 0) + 1);
    if (r.review !== null && !REVIEWED_STATUSES.has(r.status)) pending += 1;
  }
  return {
    by_kind: topCounts(byKind),
    by_layer: topCounts(byLayer),
    reach,
    pending_review: pending,
    repo: { ...repo, by_repo: topCounts(repo.by_repo) },
  };
}

export interface KbOptions {
  /** Виды через запятую; пусто — все виды базы знаний. */
  readonly kinds?: string | undefined;
  /** Фильтр слоя: 0..3. */
  readonly layer?: number | undefined;
  /** Фильтр охвата сессии: session | project | unknown. */
  readonly reach?: string | undefined;
  /** Фильтр охвата репозитория: имя, "root", "unknown". */
  readonly repo?: string | undefined;
  /** Подстрока по id, заголовку и тегам. */
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
}

export const KB_LIMIT = 2000;

export function buildKb(db: ReadOnlyDb, opts: KbOptions = {}): KbPayload {
  const t0 = performance.now();
  if (!db.has("nodes")) {
    return {
      rows: [],
      total: 0,
      shown: 0,
      counts: {
        by_kind: [],
        by_layer: [],
        reach: { project: 0, session: 0, unknown: 0 },
        pending_review: 0,
        repo: { root: 0, unknown: 0, by_repo: [] },
      },
      took_ms: Math.round(performance.now() - t0),
    };
  }

  const all = db.all<RawRow>(ROWS_SQL).map(toRow);
  const counts = countsOf(all);

  const kinds = new Set(
    (opts.kinds ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => KB_KINDS.includes(k)),
  );
  const q = (opts.q ?? "").trim().toLowerCase();
  const filtered = all.filter((r) => {
    if (kinds.size > 0 && !kinds.has(r.kind)) return false;
    if (opts.layer !== undefined && r.layer !== opts.layer) return false;
    if (opts.reach !== undefined && opts.reach !== "" && r.reach !== opts.reach) return false;
    if (opts.repo !== undefined && opts.repo !== "" && r.repo_state !== opts.repo && r.repo !== opts.repo) {
      return false;
    }
    if (q.length > 0) {
      const hay = `${r.id} ${r.title} ${r.tags.join(" ")} ${r.subtype ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const limit = Math.max(1, Math.min(opts.limit ?? KB_LIMIT, KB_LIMIT));
  return {
    rows: filtered.slice(0, limit),
    total: all.length,
    shown: Math.min(filtered.length, limit),
    counts,
    took_ms: Math.round(performance.now() - t0),
  };
}
