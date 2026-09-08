/**
 * Экран «решения» (W8, memory-cx00fqk28pgv): дерево supersession-цепочек и
 * открытые противоречия.
 *
 * НЕ ПЕРЕСЧИТЫВАЕТ ИСТОРИЮ ВЕРСИЙ. Голова цепочки, развилки и порядок звеньев
 * — та же сборка, что у `myc show` и `absorb` (packages/core/src/graph.ts,
 * §6.3): `collectVersions` + `VersionGraph`. Вторая независимая реализация
 * обхода `head_id`/`supersedes` здесь означала бы третью копию правила
 * выбора головы после show.ts и absorb.ts — ровно ту ошибку, которую §6.3
 * уже один раз исправил, собрав обе копии в одну (см. `chainOf` в absorb.ts).
 * Этот модуль добавляет только порт чтения поверх `ReadOnlyDb` — тот же
 * контракт `VersionSource`, что `versionSourceOf` в core, но без GraphStore,
 * которого у read-only просмотрщика нет и не должно быть.
 *
 * Противоречия — ребро `contradicts`, 11-й тип, заведённый под класс
 * contradiction из absorb (см. myc-divergences в памяти проекта): это
 * единственное место, где противоречие видно человеку целиком, без запроса
 * в CLI (приёмка задачи). Ребро симметрично и хранится одним рядом — читается
 * в обе стороны, как в show.ts, иначе противоречие видно только с одной
 * стороны половины пар.
 *
 * ОСТОРОЖНО С РАЗРЕШЕНИЕМ. Экран показывает противоречия, а не решает их.
 * «Открытым» считается противоречие, где ОБЕ стороны ещё не закрыты обычным
 * путём (close/cancel через POST /api/nodes/:id/op, mutate.ts) — как только
 * один из узлов получил статус из CLOSED_STATUSES, пара выходит из списка
 * открытых, но ребро contradicts никуда не девается: история остаётся
 * читаемой через `myc show --chain`, и это не тихое погашение стороны, а
 * обычная запись с причиной.
 */

import {
  collectVersions,
  versionQueries,
  HISTORY_MAX_DEPTH,
  type VersionLink,
  type VersionNode,
  type VersionSource,
} from "@myc/core";
import type { ReadOnlyDb } from "./db.ts";
import type {
  DecisionChain,
  DecisionContradiction,
  DecisionLink,
  DecisionRef,
  Degradation,
  DecisionsPayload,
} from "./types.ts";

/** Совпадает с CLOSED_STATUSES в packages/cli/src/commands/show.ts. */
const CLOSED_STATUSES = new Set(["closed", "cancelled", "superseded", "retracted"]);

/** Предохранитель от аномально большого воркспейса — не тот бюджет, что HISTORY_MAX_DEPTH у одной цепочки. */
const DEFAULT_LIMIT = 2000;

interface DecisionRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly actor: string;
  readonly created_at: number;
  readonly head_id: string | null;
  readonly hlc: number;
  readonly site_id: string;
  readonly attrs: string;
}

/**
 * БЕЗ ОГРАНИЧЕНИЯ ПО kind. `list.ts`/`retrieve.ts` заводят decision как
 * `{kind:"note", type:"decision"}`, но на настоящей базе проекта все три
 * решения оказались `kind:"task"` c тем же `attrs.type='decision'` (проверено
 * живьём, myc-cx00fqk28pgv) — их завели как задачи с проставленным типом, а
 * не через задокументированный alias. Фильтр по kind='note' молча выкинул бы
 * их все: приёмка требует, чтобы экран совпадал с `myc show` по РЕАЛЬНЫМ
 * данным, а не по тому, как решения заводить «положено».
 */
const DECISION_ROW_SQL = `
SELECT id, title, status, actor, created_at, head_id, hlc, site_id, attrs
  FROM nodes WHERE deleted_at IS NULL`;

function nodeRow(db: ReadOnlyDb, id: string): DecisionRow | undefined {
  return db.one<DecisionRow>(
    `SELECT id, title, status, actor, created_at, head_id, hlc, site_id, attrs
       FROM nodes WHERE id = ?1 AND deleted_at IS NULL`,
    [id],
  );
}

function parseAttrs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // битый attrs не роняет экран — тип и причина станут неизвестны
  }
}

function isDecision(attrsJson: string): boolean {
  return parseAttrs(attrsJson)["type"] === "decision";
}

/** attrs.absorb.reason у ЭТОГО узла — почему он заменил/оспорил предыдущий. */
function absorbReason(attrsJson: string): string | undefined {
  const absorb = parseAttrs(attrsJson)["absorb"];
  if (typeof absorb !== "object" || absorb === null || Array.isArray(absorb)) return undefined;
  const reason = (absorb as Record<string, unknown>)["reason"];
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

function refOf(row: DecisionRow): DecisionRef {
  return { id: row.id, title: row.title, status: row.status, author: row.actor, created_at: row.created_at };
}

/**
 * Порт к хранилищу для `collectVersions` — тот же контракт, что
 * `versionSourceOf` (@myc/core, поверх GraphStore), но поверх `ReadOnlyDb`:
 * просмотрщик не поднимает store на запись, только читает те же таблицы.
 * SQL для `rows` НЕ копируется, а берётся из `versionQueries.version_rows`:
 * копия текста разошлась бы молча, и сторож
 * packages/core/src/history-predicate.test.ts требует, чтобы предикат
 * актуальной версии жил в ОДНОМ месте. Он же и поймал эту копию.
 */
function versionSourceOf(db: ReadOnlyDb): VersionSource {
  return {
    rows: (seed, limit) =>
      db.all<VersionNode>(versionQueries.version_rows.sql, [seed, limit]),
    row: (id) =>
      db.one<VersionNode>(
        `SELECT id, head_id, hlc, site_id FROM nodes WHERE id = ?1 AND deleted_at IS NULL`,
        [id],
      ),
    supersedes: (id) => {
      const out: VersionLink[] = [];
      for (const e of db.all<{ src: string; dst: string }>(
        `SELECT src, dst FROM edges WHERE type = 'supersedes' AND deleted_at IS NULL AND src = ?1`,
        [id],
      )) {
        out.push({ newer: e.src, older: e.dst });
      }
      for (const e of db.all<{ src: string; dst: string }>(
        `SELECT src, dst FROM edges WHERE type = 'supersedes' AND deleted_at IS NULL AND dst = ?1`,
        [id],
      )) {
        out.push({ newer: e.src, older: e.dst });
      }
      return out;
    },
  };
}

export interface DecisionsOptions {
  readonly limit?: number;
}

export function buildDecisions(db: ReadOnlyDb, opts: DecisionsOptions = {}): DecisionsPayload {
  const t0 = performance.now();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const degraded: Degradation[] = [];

  if (!db.has("nodes") || !db.has("edges")) {
    return { chains: [], contradictions: [], total_decisions: 0, degraded, took_ms: Math.round(performance.now() - t0) };
  }

  const rows = db.all<DecisionRow>(DECISION_ROW_SQL).filter((r) => isDecision(r.attrs));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const src = versionSourceOf(db);

  const chains: DecisionChain[] = [];
  const visited = new Set<string>();
  let anyTruncated = false;

  for (const row of rows) {
    if (visited.has(row.id)) continue;
    const { graph, truncated } = collectVersions(
      src,
      { id: row.id, head_id: row.head_id, hlc: row.hlc, site_id: row.site_id },
      HISTORY_MAX_DEPTH + 1,
    );
    if (truncated) anyTruncated = true;

    const members = graph.chain(row.id);
    const head = graph.head(row.id);
    const forks = graph.heads(row.id);
    for (const m of members) visited.add(m);

    const links: DecisionLink[] = [];
    for (const id of members) {
      const n = byId.get(id) ?? nodeRow(db, id);
      if (n === undefined) continue;
      links.push({
        ...refOf(n),
        current: id === head,
        ...(absorbReason(n.attrs) !== undefined ? { reason: absorbReason(n.attrs) } : {}),
      });
    }
    if (links.length === 0) continue;
    chains.push({ head, links, ...(forks.length > 1 ? { forked: forks } : {}) });
  }

  if (anyTruncated) {
    degraded.push({
      code: "decisions.chain_truncated",
      msg: "у части цепочек версий больше бюджета чтения — показаны не целиком",
    });
  }

  let clipped = chains;
  if (chains.length > limit) {
    degraded.push({
      code: "decisions.limit",
      msg: `решений больше лимита чтения (${limit}) — часть цепочек не показана`,
    });
    clipped = chains.slice(0, limit);
  }

  // Свежие головы — сверху: решение, которое действует прямо сейчас, важнее
  // старой замены, погребённой десятком версий назад.
  clipped = [...clipped].sort((a, b) => {
    const ha = a.links.find((l) => l.current);
    const hb = b.links.find((l) => l.current);
    return (hb?.created_at ?? 0) - (ha?.created_at ?? 0);
  });

  // Противоречия: ребро contradicts среди решений, симметрично, обе стороны.
  const contraRows = db.all<{ src: string; dst: string }>(
    `SELECT src, dst FROM edges WHERE type = 'contradicts' AND deleted_at IS NULL`,
  );
  const seenPair = new Set<string>();
  const contradictions: DecisionContradiction[] = [];
  for (const e of contraRows) {
    const a = byId.get(e.src);
    const b = byId.get(e.dst);
    if (a === undefined || b === undefined) continue; // одна из сторон — не решение, вне этого экрана
    const key = a.id < b.id ? `${a.id} ${b.id}` : `${b.id} ${a.id}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    // Закрыто обычным путём (close/cancel) — это уже не ОТКРЫТОЕ противоречие,
    // а разрешённое: след остаётся в статусе и причине узла, ребро не тронуто.
    if (CLOSED_STATUSES.has(a.status) || CLOSED_STATUSES.has(b.status)) continue;
    contradictions.push({
      a: refOf(a),
      b: refOf(b),
      ...((absorbReason(a.attrs) ?? absorbReason(b.attrs)) !== undefined
        ? { reason: absorbReason(a.attrs) ?? absorbReason(b.attrs) }
        : {}),
    });
  }
  contradictions.sort((x, y) => (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0));

  return {
    chains: clipped,
    contradictions,
    total_decisions: rows.length,
    degraded,
    took_ms: Math.round(performance.now() - t0),
  };
}
