/**
 * `myc ready` — очередь готовой работы (§3.3): открытые задачи без открытых
 * блокеров. Порядок — взвешенная формула S21 (веса из workspace.toml,
 * [ready]); --why печатает слагаемые реальными числами, --claim атомарно
 * берёт верхнюю через CAS-движок claim.ts (своего захвата здесь нет).
 *
 * Горячий путь — три SQL-запроса и скоринг в памяти: кандидаты (частичный
 * индекс по open/open_blockers), агрегат unblocks по живым blocks-рёбрам,
 * состояния якорей по touches-рёбрам. Бюджет — 5 мс на 100k узлов.
 */

import {
  DIGEST_PROFILE_READY,
  defineQueries,
  digestCached,
  repoClause,
  repoPredicate,
  repoReasonText,
} from "@myc/core";
import { freshnessClock, freshnessClockSql } from "@myc/retrieval";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import {
  flagNum,
  flagStr,
  fmtAge,
  fmtClock,
  fmtEstimate,
  fmtPriority,
  parseDuration,
  parsePriority,
  type ReadyWeights,
  repoTarget,
  type StoreDeps,
  type StoreHandle,
  DEFAULT_LEASE_MS,
  realStoreDeps,
} from "./store.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

const CLOSED = "('closed','cancelled','superseded','retracted')";

// Слагаемые формулы S21 — в SQL: score считается для всех кандидатов одним
// сканом частичного индекса ix_nodes_ready, через мост уходят только top-k
// строк. Слагаемые округлены до сотых ДО суммы — как и в JS-скоринге ниже,
// поэтому напечатанный score всегда равен сумме напечатанных слагаемых.
const UNBLOCKS_SUBQ = `(SELECT count(*) FROM edges e JOIN nodes d ON d.id = e.dst
      WHERE e.src = n.id AND e.type = 'blocks' AND e.deleted_at IS NULL
        AND d.deleted_at IS NULL AND d.status NOT IN ${CLOSED})`;

const ANCHOR_SUBQ = `COALESCE((SELECT CASE
        WHEN count(*) = 0 THEN 0.5
        WHEN sum(CASE WHEN a.status <> 'fresh' THEN 1 ELSE 0 END) = 0 THEN 1.0
        WHEN sum(CASE WHEN a.status IN ('stale','lost') THEN 1 ELSE 0 END) > 0 THEN 0.2
        ELSE 0.6 END
      FROM edges e JOIN nodes a ON a.id = e.dst
      WHERE e.src = n.id AND e.type = 'touches' AND e.deleted_at IS NULL
        AND a.kind = 'anchor' AND a.deleted_at IS NULL), 0.5)`;

/**
 * ОХВАТ РЕПОЗИТОРИЯ В ИСТОЧНИКЕ (S59, И1). Фильтр стоит в SQL, а не над
 * выдачей: score считается для ВСЕХ кандидатов, а top-k режется уже после
 * сортировки, поэтому отсев в JS пришёл бы после LIMIT и выдавал бы неполную
 * очередь. Вариант с фильтром пинится к ix_nodes_ready_repo (миграция 007):
 * выражение `json_extract(attrs,'$.repo')` лежит там второй колонкой, и
 * SQLite отбрасывает чужой репозиторий, не читая строку таблицы. Вариант без
 * фильтра остаётся на более коротком ix_nodes_ready — за то, чего не просили,
 * платить не надо.
 */
/**
 * Слагаемое свежести S21 по ЧАСАМ СВЕЖЕСТИ (freshnessClockSql, @myc/retrieval) —
 * тем же, что у выдачи и show; у ввезённой и не тронутой в myc задачи
 * updated_at — день ввоза, и по нему она была бы свежей (memory-khny4xb612m6).
 *
 * Часы вычисляются ОДИН раз на кандидата: база `CASE x WHEN …` считается
 * однажды, а ступени 1/3/7 суток — это целые сутки возраста 0 | 1–2 | 3–6 | 7+.
 * Три `WHEN ?8 - часы < …` вычисляли бы выражение трижды: на стенде, где все
 * 4000 готовых задач ввезены, это +70 % к скорингу.
 */
function freshnessTermSql(): string {
  return `CASE min(7, max(0, CAST((?8 - ${freshnessClockSql("n")}) / 86400000 AS INTEGER)))
                         WHEN 0 THEN 1.0 WHEN 1 THEN 0.7 WHEN 2 THEN 0.7 WHEN 7 THEN 0.15 ELSE 0.4 END`;
}

function scoredTopSql(anchorTerm: string, withRepo: boolean): string {
  return `SELECT n.id, n.priority, n.status, n.assignee, n.title,
            n.updated_at, n.created_at, n.attrs,
       round(?2 * CASE n.priority WHEN 0 THEN 1.0 WHEN 1 THEN 0.6667 WHEN 2 THEN 0.3333 ELSE 0.0 END, 2)
     + round(?3 * min(COALESCE(${UNBLOCKS_SUBQ}, 0), 3) / 3.0, 2)
     + round(?4 * ${freshnessTermSql()}, 2)
     + round(?5 * ${anchorTerm}, 2)
     + round(?6 * CASE COALESCE(json_extract(n.attrs,'$.type'),'task')
                       WHEN 'bug' THEN 1.0 WHEN 'task' THEN 0.5 ELSE 0.25 END, 2)
       AS score,
       count(*) OVER () AS total_ready
    FROM nodes AS n INDEXED BY ${withRepo ? "ix_nodes_ready_repo" : "ix_nodes_ready"}
   WHERE n.scope = ?1 AND n.kind = 'task' AND n.status = 'open'
     AND n.open_blockers = 0 AND n.anc_blockers = 0
     AND n.deleted_at IS NULL${withRepo ? repoClause("n", 9) : ""}
   ORDER BY score DESC, n.priority ASC, n.id ASC
   LIMIT ?7`;
}

const TOP_PARAMS = ["scope", "w_pri", "w_unb", "w_fresh", "w_anch", "w_type", "lim", "now"] as const;
const TOP_PARAMS_REPO = [...TOP_PARAMS, "repo"] as const;

/** Экспортировано для теста бюджета (ready.repo-latency.test.ts): замер обязан
 * идти по ТОМУ ЖЕ тексту SQL, что и горячий путь, а не по его копии. */
export const readyQueries = defineQueries({
  // Горячий путь: без якорных подзапросов, когда touches-рёбер нет вовсе
  // (проверяется один раз за вызов) — типичный случай.
  ready_top_noanchors: {
    name: "ready_top_noanchors",
    sql: scoredTopSql("0.5", false),
    params: [...TOP_PARAMS],
  },
  ready_top_anchors: {
    name: "ready_top_anchors",
    sql: scoredTopSql(ANCHOR_SUBQ, false),
    params: [...TOP_PARAMS],
  },
  ready_top_noanchors_repo: {
    name: "ready_top_noanchors_repo",
    sql: scoredTopSql("0.5", true),
    params: [...TOP_PARAMS_REPO],
  },
  ready_top_anchors_repo: {
    name: "ready_top_anchors_repo",
    sql: scoredTopSql(ANCHOR_SUBQ, true),
    params: [...TOP_PARAMS_REPO],
  },
  ready_touches_exist: {
    name: "ready_touches_exist",
    sql: `SELECT 1 AS x FROM edges WHERE type = 'touches' AND deleted_at IS NULL LIMIT 1`,
    params: [],
  },
  ready_unblocks_one: {
    name: "ready_unblocks_one",
    sql: `SELECT count(*) AS n FROM edges e JOIN nodes d ON d.id = e.dst
           WHERE e.src = ?1 AND e.type = 'blocks' AND e.deleted_at IS NULL
             AND d.deleted_at IS NULL AND d.status NOT IN ${CLOSED}`,
    params: ["id"],
  },
  ready_anchor_states_one: {
    name: "ready_anchor_states_one",
    sql: `SELECT n.status AS st FROM edges e JOIN nodes n ON n.id = e.dst
           WHERE e.src = ?1 AND e.type = 'touches' AND e.deleted_at IS NULL
             AND n.kind = 'anchor' AND n.deleted_at IS NULL`,
    params: ["id"],
  },
  ready_stats_blocked: {
    name: "ready_stats_blocked",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers > 0 AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  // И2: задачи, ушедшие из очереди ТОЛЬКО по наследованию (миграция 10).
  // Считаются отдельно от blocked, потому что пользователь ищет их у себя в
  // deps и не находит: блокер висит на эпике, а не на самой задаче.
  ready_stats_blocked_anc: {
    name: "ready_stats_blocked_anc",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers > 0 AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  ready_stats_in_progress: {
    name: "ready_stats_in_progress",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_lease
           WHERE status = 'in_progress' AND scope = ?1 AND kind = 'task'
             AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  // И2: два числа, которые обязаны быть НАЗВАНЫ, а не подразумеваться, —
  // сколько готовых задач без записанного охвата репозитория (старше S59
  // либо путь вывести не удалось) и сколько скрыто фильтром как чужое.
  // Оба считаются по тому же частичному индексу, что и сама очередь, и
  // живут в том же кеше футера — на вызов приходится ноль лишних сканов.
  ready_repo_unknown: {
    name: "ready_repo_unknown",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_ready_repo
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers = 0 AND deleted_at IS NULL
             AND json_extract(nodes.attrs,'$.repo') IS NULL`,
    params: ["scope"],
  },
  ready_repo_foreign: {
    name: "ready_repo_foreign",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_ready_repo
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers = 0 AND deleted_at IS NULL
             AND NOT ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  ready_candidates: {
    name: "ready_candidates",
    sql: `SELECT id, priority, status, assignee, title, updated_at, created_at, attrs
            FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers = 0 AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  // Задачи, брошенные с истёкшей арендой (§9.4): тот же предикат re-open,
  // что и в claim_node/claim_candidates (queries.ts) — движок и очередь
  // обязаны видеть одно и то же "свободна". Отдельный запрос, а не UNION
  // с ready_candidates/ready_top_*: ix_nodes_lease (status='in_progress')
  // и ix_nodes_ready (status='open') — разные частичные индексы, слияние
  // одним SQL сломало бы план по ix_nodes_ready (см. schema.test.ts).
  ready_expired_candidates: {
    name: "ready_expired_candidates",
    sql: `SELECT id, priority, status, assignee, title, updated_at, created_at, attrs,
                 lease_holder, lease_expires
            FROM nodes INDEXED BY ix_nodes_lease
           WHERE status = 'in_progress' AND lease_expires > 0 AND lease_expires < ?2
             AND scope = ?1 AND kind = 'task' AND open_blockers = 0 AND anc_blockers = 0
             AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 3)}`,
    params: ["scope", "now", "repo"],
  },
  ready_unblocks: {
    name: "ready_unblocks",
    sql: `SELECT e.src AS id, count(*) AS n
            FROM edges e JOIN nodes d ON d.id = e.dst
           WHERE e.type = 'blocks' AND e.deleted_at IS NULL
             AND d.deleted_at IS NULL AND d.status NOT IN ${CLOSED}
           GROUP BY e.src`,
    params: [],
  },
  ready_anchor_states: {
    name: "ready_anchor_states",
    sql: `SELECT e.src AS id, n.status AS st
            FROM edges e JOIN nodes n ON n.id = e.dst
           WHERE e.type = 'touches' AND e.deleted_at IS NULL
             AND n.kind = 'anchor' AND n.deleted_at IS NULL`,
    params: [],
  },
  ready_top_blocker: {
    name: "ready_top_blocker",
    sql: `SELECT e.src AS id, count(*) AS n
            FROM edges e
            JOIN nodes s ON s.id = e.src
            JOIN nodes d ON d.id = e.dst
           WHERE e.type = 'blocks' AND e.deleted_at IS NULL
             AND s.deleted_at IS NULL AND s.status NOT IN ${CLOSED}
             AND d.deleted_at IS NULL AND d.status = 'open'
           GROUP BY e.src ORDER BY n DESC, e.src LIMIT 1`,
    params: [],
  },
});

const QR = readyQueries;

// ---------------------------------------------------------------------------
// Скоринг (S21)
// ---------------------------------------------------------------------------

const PRIORITY_NORM = [1, 2 / 3, 1 / 3, 0] as const;
const UNBLOCKS_CAP = 3;

function freshnessNorm(ageMs: number): number {
  const day = 86_400_000;
  if (ageMs < day) return 1.0;
  if (ageMs < 3 * day) return 0.7;
  if (ageMs < 7 * day) return 0.4;
  return 0.15;
}

function anchorNorm(states: readonly string[] | undefined): { norm: number; label: string } {
  if (states === undefined || states.length === 0) return { norm: 0.5, label: "none" };
  if (states.every((s) => s === "fresh")) return { norm: 1.0, label: "fresh" };
  if (states.some((s) => s === "stale" || s === "lost")) return { norm: 0.2, label: "stale" };
  return { norm: 0.6, label: "drifted" };
}

function typeNorm(type: string): number {
  switch (type) {
    case "bug": return 1.0;
    case "task": return 0.5;
    case "epic": return 0.25;
    default: return 0.25;
  }
}

interface CandidateRow {
  id: string;
  priority: number;
  status: string;
  assignee: string;
  title: string;
  updated_at: number;
  created_at: number;
  attrs: string;
}

/** Строка из ready_expired_candidates: брошенная in_progress-задача. */
interface ExpiredCandidateRow extends CandidateRow {
  lease_holder: string;
  lease_expires: number;
}

function isExpiredRow(row: CandidateRow): row is ExpiredCandidateRow {
  return "lease_holder" in row;
}

export interface ReadyItem {
  id: string;
  priority: number;
  type: string;
  title: string;
  status: string;
  assignee: string;
  unblocks: number;
  estimate_min?: number;
  /**
   * Задача не свободна, а брошена: захвачена, аренда истекла. Отличие от
   * "free" критично для роя (myc-qie.13) — на второй задаче кто-то уже мог
   * что-то сделать, это не то же самое, что никем не тронутая работа.
   */
  expired_lease?: { holder: string; expires_at: number };
  score: number;
  terms: {
    priority: number;
    unblocks: number;
    freshness: number;
    anchors: number;
    type: number;
  };
  /** подписи для --why */
  why: {
    priority: string;
    unblocks: string;
    freshness: string;
    anchors: string;
    type: string;
  };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function buildItem(
  row: CandidateRow,
  unblocksN: number,
  states: readonly string[] | undefined,
  weights: ReadyWeights,
  now: number,
  scoreOverride?: number,
): ReadyItem {
  const expired = isExpiredRow(row)
    ? { holder: row.lease_holder, expires_at: row.lease_expires }
    : undefined;
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(row.attrs) as Record<string, unknown>;
  } catch {
    // битый attrs не должен валить очередь — считаем без подтипа
  }
  const type = typeof attrs["type"] === "string" ? (attrs["type"] as string) : "task";
  const est = typeof attrs["estimate_min"] === "number" ? (attrs["estimate_min"] as number) : undefined;

  // Возраст — по часам свежести, а не по updated_at: у ввезённой и не
  // тронутой в myc задачи updated_at — день ввоза (memory-khny4xb612m6). Та
  // же функция, что в SQL скоринга, — их равенство сверяет тест retrieval.
  const age = Math.max(0, now - freshnessClock({ updated_at: row.updated_at, attrs }));
  const anchor = anchorNorm(states);

  // Слагаемые округляем до сотых ДО суммы: напечатанный score обязан
  // быть в точности суммой напечатанных слагаемых (приёмка --why).
  const tPri = r2(weights.priority * (PRIORITY_NORM[row.priority] ?? 0));
  const tUnb = r2((weights.unblocks * Math.min(unblocksN, UNBLOCKS_CAP)) / UNBLOCKS_CAP);
  const tFresh = r2(weights.freshness * freshnessNorm(age));
  const tAnch = r2(weights.anchors * anchor.norm);
  const tType = r2(weights.type * typeNorm(type));
  const score = scoreOverride ?? r2(tPri + tUnb + tFresh + tAnch + tType);

  return {
    id: row.id,
    priority: row.priority,
    type,
    title: row.title,
    status: row.status,
    assignee: row.assignee,
    unblocks: unblocksN,
    ...(est !== undefined ? { estimate_min: est } : {}),
    ...(expired !== undefined ? { expired_lease: expired } : {}),
    score,
    terms: { priority: tPri, unblocks: tUnb, freshness: tFresh, anchors: tAnch, type: tType },
    why: {
      priority: fmtPriority(row.priority),
      unblocks: `unblocks ${unblocksN}`,
      freshness: `freshness ${fmtAge(age)}`,
      anchors: `anchors ${anchor.label}`,
      type,
    },
  };
}

interface ScoredRow extends CandidateRow {
  score: number;
  total_ready: number;
}



/**
 * Горячий путь: score посчитан в SQL одним сканом ix_nodes_ready, через мост
 * пришли только top-`limit` строк. Для них добираем unblocks и состояния
 * якорей по одному индексному пробу на строку.
 */
/**
 * Экспортировано для `myc prime` (§3.2): та же очередь, короткий срез.
 *
 * Фильтр по репозиторию (S59) выключен ПО УМОЛЧАНИЮ и включается только тем,
 * кто о нём знает и умеет о нём сказать. `myc ready` передаёт цель явно и
 * печатает её в подвале; `prime` про эту ось пока не рассказывает, и молча
 * сузить ему выдачу значило бы спрятать работу без единого слова — ровно то,
 * что запрещает И2. Умолчание здесь — «не фильтровать», а не «как у ready».
 */
export function collectTop(
  h: StoreHandle,
  limit: number,
  now: number,
  repo = "",
): { items: ReadyItem[]; total: number } {
  const hasTouches =
    h.driver.one<{ x: number }>(QR.ready_touches_exist, []) !== undefined;
  const withRepo = repo.length > 0;
  const query = withRepo
    ? hasTouches
      ? QR.ready_top_anchors_repo
      : QR.ready_top_noanchors_repo
    : hasTouches
      ? QR.ready_top_anchors
      : QR.ready_top_noanchors;
  const w = h.weights;
  const args = [
    h.scope,
    w.priority,
    w.unblocks,
    w.freshness,
    w.anchors,
    w.type,
    limit,
    now,
  ];
  const rows = h.driver.all<ScoredRow>(query, withRepo ? [...args, repo] : args);
  const openItems = rows.map((row) => {
    const unblocksN =
      h.driver.one<{ n: number }>(QR.ready_unblocks_one, [row.id])?.n ?? 0;
    const states = hasTouches
      ? h.driver.all<{ st: string }>(QR.ready_anchor_states_one, [row.id]).map((r) => r.st)
      : undefined;
    return buildItem(row, unblocksN, states, w, now, r2(row.score));
  });

  // Брошенные задачи (лизинг протух) — отдельный, обычно короткий скан по
  // ix_nodes_lease (myc-qie.13): не в формуле SQL-скоринга выше, считаем
  // их score в JS тем же buildItem и подмешиваем в общую сортировку.
  const expiredRows = h.driver.all<ExpiredCandidateRow>(QR.ready_expired_candidates, [
    h.scope,
    now,
    repo,
  ]);
  const expiredItems = expiredRows.map((row) => {
    const unblocksN =
      h.driver.one<{ n: number }>(QR.ready_unblocks_one, [row.id])?.n ?? 0;
    const states = hasTouches
      ? h.driver.all<{ st: string }>(QR.ready_anchor_states_one, [row.id]).map((r) => r.st)
      : undefined;
    return buildItem(row, unblocksN, states, w, now);
  });

  const items = [...openItems, ...expiredItems].sort(
    (a, b) => b.score - a.score || a.priority - b.priority || a.id.localeCompare(b.id),
  );
  const total = (rows[0]?.total_ready ?? 0) + expiredRows.length;
  return { items: items.slice(0, limit), total };
}

function scoreCandidates(
  rows: readonly (CandidateRow | ExpiredCandidateRow)[],
  unblocks: ReadonlyMap<string, number>,
  anchorStates: ReadonlyMap<string, string[]>,
  weights: ReadyWeights,
  now: number,
): ReadyItem[] {
  const items = rows.map((row) =>
    buildItem(row, unblocks.get(row.id) ?? 0, anchorStates.get(row.id), weights, now),
  );
  items.sort(
    (a, b) =>
      b.score - a.score ||
      a.priority - b.priority ||
      a.id.localeCompare(b.id),
  );
  return items;
}

// ---------------------------------------------------------------------------
// Вывод
// ---------------------------------------------------------------------------

interface ReadyData {
  items: ReadyItem[];
  ready: number;
  blocked: number;
  /** Скрыто наследованием: свой блокер пуст, открытый висит на предке. */
  blocked_by_ancestor: number;
  in_progress: number;
  top_blocker?: { id: string; priority: number; title: string; assignee: string; blocks: number };
  claimed?: {
    id: string;
    holder: string;
    lease_expires: number;
    lease_ttl_ms: number;
    type: string;
    priority: number;
    title: string;
    body: string | null;
    blocked_by: string[];
  };
  /** Целевой репозиторий очереди; пусто — фильтра нет (S59). */
  repo: string;
  /** `true` — охват вывести не удалось, фильтра нет и об этом надо сказать. */
  repo_undetermined: boolean;
  /** Почему не удалось. Пусто — удалось. */
  repo_reason: string;
  /** Готовых задач без записанного охвата репозитория. */
  repo_unknown: number;
  /** Готовых задач, скрытых фильтром как чужой репозиторий. */
  repo_foreign: number;
  took_ms: number;
}

function fmtTerm(n: number): string {
  return n.toFixed(2);
}

function ownerLabel(it: ReadyItem): string {
  if (it.expired_lease !== undefined) {
    const ago = fmtAge(Math.max(0, Date.now() - it.expired_lease.expires_at));
    return `EXPIRED @${it.expired_lease.holder} (${ago} ago)`;
  }
  return it.assignee.length > 0 ? `@${it.assignee}` : "free";
}

function renderItems(items: readonly ReadyItem[], why: boolean): string[] {
  const lines: string[] = [];
  const cells = items.map((it) => [
    it.id,
    fmtPriority(it.priority),
    it.type,
    it.title,
    `unblocks ${it.unblocks}`,
    it.estimate_min !== undefined ? fmtEstimate(it.estimate_min) : "—",
    ownerLabel(it),
  ]);
  const widths = [0, 0, 0, 0, 0, 0];
  for (const row of cells) {
    row.forEach((c, i) => {
      if (i < widths.length) widths[i] = Math.max(widths[i]!, c.length);
    });
  }
  cells.forEach((row, i) => {
    lines.push(
      row.map((c, j) => (j === row.length - 1 ? c : c.padEnd(widths[j]!))).join("  ").trimEnd(),
    );
    if (why) {
      const it = items[i]!;
      lines.push(
        `  score ${fmtTerm(it.score)} = ${it.why.priority}(${fmtTerm(it.terms.priority)}) + ` +
          `${it.why.unblocks}(${fmtTerm(it.terms.unblocks)}) + ${it.why.freshness}(${fmtTerm(it.terms.freshness)}) + ` +
          `${it.why.anchors}(${fmtTerm(it.terms.anchors)}) + ${it.why.type}(${fmtTerm(it.terms.type)})`,
      );
    }
  });
  return lines;
}

/**
 * Хвост подвала про охват репозитория (S59, И2). Пустой, когда сказать
 * нечего: фильтра нет, охват выведен, всё видно. Как только что-то скрыто
 * или не определено — это НАЗЫВАЕТСЯ числом, а не подразумевается.
 */
function repoFooter(d: ReadyData): string[] {
  const out: string[] = [];
  if (d.repo.length > 0) out.push(`repo ${d.repo}`);
  if (d.repo_undetermined) out.push(`repo reach undetermined: ${d.repo_reason}`);
  if (d.repo_foreign > 0) out.push(`${d.repo_foreign} from other repos hidden`);
  if (d.repo_unknown > 0) out.push(`${d.repo_unknown} without repo reach`);
  return out;
}

function renderReadyHuman(raw: unknown): string {
  const d = raw as ReadyData;
  const lines: string[] = [];

  if (d.claimed !== undefined) {
    const c = d.claimed;
    lines.push(`claimed ${c.id} by ${c.holder} · lease ${fmtAge(c.lease_ttl_ms)} until ${fmtClock(c.lease_expires)}`);
    lines.push(`${fmtPriority(c.priority)} ${c.type} · ${c.title}`);
    if (c.body !== null && c.body.trim().length > 0) {
      lines.push("description");
      for (const l of c.body.trimEnd().split("\n")) lines.push(`  ${l}`);
    }
    if (c.blocked_by.length > 0) lines.push(`deps      blocked-by ${c.blocked_by.join(", ")}`);
    lines.push(`${d.took_ms} ms`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(...renderItems(d.items, false));
  lines.push(
    [
      `${d.ready} ready`,
      blockedFooter(d),
      `${d.in_progress} in_progress`,
      `${d.took_ms} ms`,
      ...repoFooter(d),
    ].join(" · "),
  );
  if (d.ready === 0 && d.blocked > 0 && d.top_blocker !== undefined) {
    const b = d.top_blocker;
    lines.push("all open tasks are blocked. top blocker:");
    const who = b.assignee.length > 0 ? `@${b.assignee}` : "free";
    lines.push(`  ${b.id} ${fmtPriority(b.priority)} ${b.title}  ${who} (blocks ${b.blocks})`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * И2: наследование обязано быть НАЗВАНО, а не подразумеваться. Задача, у
 * которой блокер висит на эпике, исчезает из очереди, и в её собственных
 * `deps` этому нет никакого следа — подвал единственное место, где число
 * видно без запроса. Поэтому `blocked` и «через предка» стоят рядом:
 * `144 ready · 62 blocked (51 через предка)`.
 */
function blockedFooter(d: ReadyData): string {
  const anc = d.blocked_by_ancestor;
  return anc > 0
    ? `${d.blocked + anc} blocked (${anc} via ancestor)`
    : `${d.blocked} blocked`;
}

function renderReadyWhyHuman(raw: unknown): string {
  const d = raw as ReadyData;
  if (d.claimed !== undefined) return renderReadyHuman(raw);
  const lines = renderItems(d.items, true);
  lines.push(
    [
      `${d.ready} ready`,
      blockedFooter(d),
      `${d.in_progress} in_progress`,
      `${d.took_ms} ms`,
      ...repoFooter(d),
    ].join(" · "),
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

function parseFilters(ctx: CommandContext): CommandFailure | undefined {
  if (ctx.flags["assignee"] !== undefined && ctx.flags["free"] === true) {
    return failure("usage.invalid", "--assignee and --free are mutually exclusive", ExitCode.USAGE);
  }
  const pRaw = flagStr(ctx, "priority");
  if (pRaw !== undefined && parsePriority(pRaw) === undefined) {
    return failure("usage.invalid", `invalid priority '${pRaw}'; allowed: P0..P3 or 0..3`, ExitCode.USAGE);
  }
  const kind = flagStr(ctx, "kind");
  if (kind !== undefined && !["task", "bug", "epic", "chore"].includes(kind)) {
    return failure("usage.invalid", `invalid --kind '${kind}'; allowed: task, bug, epic, chore`, ExitCode.USAGE);
  }
  return undefined;
}

function collectFiltered(h: StoreHandle, ctx: CommandContext, repo: string): ReadyItem[] {
  const rows = h.driver.all<CandidateRow>(QR.ready_candidates, [h.scope, repo]);
  const expiredRows = h.driver.all<ExpiredCandidateRow>(QR.ready_expired_candidates, [
    h.scope,
    Date.now(),
    repo,
  ]);
  const allRows: readonly (CandidateRow | ExpiredCandidateRow)[] = [...rows, ...expiredRows];
  const unblocks = new Map<string, number>();
  for (const r of h.driver.all<{ id: string; n: number }>(QR.ready_unblocks, [])) {
    unblocks.set(r.id, r.n);
  }
  const anchorStates = new Map<string, string[]>();
  for (const r of h.driver.all<{ id: string; st: string }>(QR.ready_anchor_states, [])) {
    const list = anchorStates.get(r.id);
    if (list === undefined) anchorStates.set(r.id, [r.st]);
    else list.push(r.st);
  }
  const items = scoreCandidates(allRows, unblocks, anchorStates, h.weights, Date.now());

  const kind = flagStr(ctx, "kind");
  const priRaw = flagStr(ctx, "priority");
  const pri = priRaw !== undefined ? parsePriority(priRaw) : undefined;
  const tag = flagStr(ctx, "tag");
  const assignee = flagStr(ctx, "assignee");
  const freeOnly = ctx.flags["free"] === true;
  const tagRows = tag !== undefined ? new Set(
    allRows
      .filter((r) => r.attrs.includes(`"${tag}"`))
      .map((r) => r.id),
  ) : undefined;

  return items.filter((it) => {
    if (kind !== undefined && it.type !== kind) return false;
    if (pri !== undefined && it.priority !== pri) return false;
    if (assignee !== undefined && it.assignee !== assignee) return false;
    if (freeOnly && it.assignee.length > 0) return false;
    if (tagRows !== undefined && !tagRows.has(it.id)) return false;
    return true;
  });
}

function hasFilters(ctx: CommandContext): boolean {
  return (
    flagStr(ctx, "kind") !== undefined ||
    flagStr(ctx, "priority") !== undefined ||
    flagStr(ctx, "tag") !== undefined ||
    flagStr(ctx, "assignee") !== undefined ||
    ctx.flags["free"] === true
  );
}

/**
 * Счётчики футера с кешем в `digest_cache`, профиль 'ready' (S4): точный
 * count blocked стоит скан задач скоупа, а любая запись двигает
 * `max(oplog.seq)` — поэтому считаем один раз на версию базы, а не на
 * каждый вызов ready. Механизм — общий с `prime` (@myc/core
 * digest-cache.ts): одна таблица, один statement, одна инвалидация.
 *
 * Почему `oplog.seq`, а не `myc_meta.last_seq`, которым описана задача:
 * last_seq — счётчик ЛОКАЛЬНОГО сайта, приезд чужих операций его не
 * двигает, и подвал застыл бы на числах, посчитанных до `myc import`.
 * Подробности и мутация — в докстроке @myc/core digest-cache.ts.
 */
/**
 * Экспортировано для `myc prime` (§3.2): те же счётчики, тот же кеш.
 * Фильтр по репозиторию выключен по умолчанию — по той же причине, что и в
 * {@link collectTop}: подвал `prime` про эту ось пока не говорит.
 */
export interface ReadyStats {
  readonly blocked: number;
  /**
   * Открытые задачи БЕЗ своего блокера, ушедшие из очереди по наследованию
   * (блокер на предке, миграция 10). Отдельное число, а не слагаемое
   * `blocked`: искать его пользователь будет в `deps` самой задачи и не
   * найдёт, поэтому подвал обязан назвать его словом «через предка» (И2).
   */
  readonly blockedByAncestor: number;
  readonly inProgress: number;
  /** Готовых задач без записанного охвата репозитория (S59, И2). */
  readonly repoUnknown: number;
  /** Готовых задач, скрытых фильтром как чужой репозиторий (S59, И2). */
  readonly repoForeign: number;
}

export function readyStats(h: StoreHandle, repo = ""): ReadyStats {
  // Вариант кеша несёт репозиторий: blocked/in_progress считаются под тем же
  // фильтром, что и очередь, и одна запись на все репозитории выдавала бы
  // чужие числа в подвале. v3 — версия формы payload (см. digestVariant в
  // prime.ts: версия живёт в варианте, а не в имени профиля).
  return digestCached<ReadyStats>(
    h.driver,
    { scope: h.scope, profile: DIGEST_PROFILE_READY, variant: `v4:${repo}` },
    () => ({
      blocked: h.driver.one<{ n: number }>(QR.ready_stats_blocked, [h.scope, repo])?.n ?? 0,
      blockedByAncestor:
        h.driver.one<{ n: number }>(QR.ready_stats_blocked_anc, [h.scope, repo])?.n ?? 0,
      inProgress:
        h.driver.one<{ n: number }>(QR.ready_stats_in_progress, [h.scope, repo])?.n ?? 0,
      repoUnknown: h.driver.one<{ n: number }>(QR.ready_repo_unknown, [h.scope])?.n ?? 0,
      repoForeign:
        repo.length === 0
          ? 0
          : (h.driver.one<{ n: number }>(QR.ready_repo_foreign, [h.scope, repo])?.n ?? 0),
    }),
  ).payload;
}

export function createReadyCommand(deps: StoreDeps = realStoreDeps): Command {
  const render = (raw: unknown, ctx: CommandContext): string =>
    ctx.flags["why"] === true ? renderReadyWhyHuman(raw) : renderReadyHuman(raw);
  return {
    name: "ready",
    summary: "ready queue: open tasks without open blockers",
    flags: [
      { name: "n", short: "n", value: "number", description: "limit rows (default 10)" },
      { name: "kind", value: "string", description: "task|bug|epic|chore" },
      { name: "priority", value: "string", description: "P0|P1|P2|P3 or 0|1|2|3" },
      { name: "tag", value: "string", description: "must carry this tag" },
      { name: "assignee", value: "string", description: "only this assignee" },
      { name: "free", description: "only unassigned" },
      { name: "claim", description: "atomically claim the top task" },
      { name: "why", description: "print score terms for every row" },
      { name: "lease", value: "string", description: "lease TTL for --claim (default 30m)" },
      { name: "as", value: "string", description: "actor for --claim (default $MYC_ACTOR/$USER)" },
      {
        name: "repo",
        value: "string",
        description: "repository scope (S59): a repo name, or `all` to drop the filter",
      },
    ],
    help:
      "Score = w_priority·P + w_unblocks·U + w_freshness·F + w_anchors·A + w_type·T, " +
      "weights from workspace.toml [ready] (S21 defaults 0.40/0.27/0.14/0.10/0.09). " +
      "--why prints the real terms; --claim takes the top task atomically.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const badFlags = parseFilters(ctx);
      if (badFlags !== undefined) return badFlags;

      let ttl = DEFAULT_LEASE_MS;
      const leaseRaw = flagStr(ctx, "lease");
      if (leaseRaw !== undefined) {
        const dur = parseDuration(leaseRaw);
        if (dur === undefined) {
          return failure("usage.invalid", `invalid lease '${leaseRaw}'; format: 30m, 2h`, ExitCode.USAGE);
        }
        ttl = dur;
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const repo = repoTarget(h, flagStr(ctx, "repo"));
        const stats = readyStats(h, repo);
        const { blocked, blockedByAncestor, inProgress } = stats;
        const repoFields = {
          repo,
          repo_undetermined: h.repo.repo === undefined,
          repo_reason: repoReasonText(h.repo),
          repo_unknown: stats.repoUnknown,
          repo_foreign: stats.repoForeign,
        };
        const limit = flagNum(ctx, "n") ?? 10;
        const filtered = hasFilters(ctx);
        const collected = filtered
          ? { items: collectFiltered(h, ctx, repo), total: -1 }
          : collectTop(
              h,
              ctx.flags["claim"] === true ? Math.max(limit, 50) : limit,
              Date.now(),
              repo,
            );
        const items = collected.items;
        const readyTotal = filtered ? items.length : collected.total;

        if (ctx.flags["claim"] === true) {
          for (const it of items) {
            const ticket = h.claims.claim(it.id, ttl);
            if (ticket === undefined) continue; // гонку проиграли — следующая
            const node = h.store.getNode(it.id)!;
            const blockedBy = h.store
              .edgesTo(it.id, "blocks")
              .map((e) => {
                const s = h.store.getNode(e.src);
                return s !== undefined && s.status === "closed" && s.closed_at !== null
                  ? `${e.src} (closed ${new Date(s.closed_at).toISOString().slice(0, 10)})`
                  : `${e.src} (${s?.status ?? "?"})`;
              });
            const data: ReadyData = {
              items: [],
              ready: readyTotal,
              blocked,
              blocked_by_ancestor: blockedByAncestor,
              in_progress: inProgress,
              ...repoFields,
              claimed: {
                id: it.id,
                holder: h.actor,
                lease_expires: ticket.expiresAt,
                lease_ttl_ms: ttl,
                type: it.type,
                priority: it.priority,
                title: it.title,
                body: node.body,
                blocked_by: blockedBy,
              },
              took_ms: Math.round(performance.now() - t0),
            };
            return { ok: true, data, meta: { took_ms: data.took_ms } };
          }
          // очередь пуста или всё ушло под носом — осмысленный ответ, не сбой
          const data: ReadyData = {
            items: [],
            ready: 0,
            blocked,
            blocked_by_ancestor: blockedByAncestor,
            in_progress: inProgress,
            ...repoFields,
            took_ms: Math.round(performance.now() - t0),
          };
          return { ok: true, data, meta: { took_ms: data.took_ms } };
        }

        let topBlocker: ReadyData["top_blocker"];
        if (items.length === 0 && blocked > 0) {
          const top = h.driver.one<{ id: string; n: number }>(QR.ready_top_blocker, []);
          if (top !== undefined) {
            const node = h.store.getNode(top.id);
            if (node !== undefined) {
              topBlocker = {
                id: node.id,
                priority: node.priority,
                title: node.title,
                assignee: node.assignee,
                blocks: top.n,
              };
            }
          }
        }

        const data: ReadyData = {
          items: filtered ? items.slice(0, limit) : items,
          ready: readyTotal,
          blocked,
          blocked_by_ancestor: blockedByAncestor,
          in_progress: inProgress,
          ...repoFields,
          ...(topBlocker !== undefined ? { top_blocker: topBlocker } : {}),
          took_ms: Math.round(performance.now() - t0),
        };
        return {
          ok: true,
          data,
          meta: {
            took_ms: data.took_ms,
            count: data.items.length,
            repo: repo.length > 0 ? repo : null,
            repo_unknown: stats.repoUnknown,
            repo_foreign: stats.repoForeign,
          },
        };
      } finally {
        h.close();
      }
    },
    renderHuman: render,
  };
}
