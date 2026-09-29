/**
 * ПРИМЕНЕНИЕ ОПЕРАЦИЙ — ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ.
 *
 * Правила слияния myc обязаны существовать в единственном экземпляре: у
 * SQLite и у Postgres может расходиться текст запроса (это видно и ловится
 * паритетом), но НЕ порядок проверки часов и не решение «применить, отбросить
 * или назвать столкновением». Две копии такого решения расходятся молча.
 *
 * Поэтому код здесь написан генератором (см. effect.ts): он выдаёт запрос и
 * получает строки, а гоняют его синхронный исполнитель CLI и асинхронный
 * исполнитель сервера. Читается как обычный последовательный код, только
 * вместо `await` стоит `yield*`.
 *
 * Переезд идёт по частям, снизу вверх: сначала листья (проекция одной
 * операции), затем всё, что их вызывает. Каждый шаг оставляет полный прогон
 * зелёным — иначе он не шаг.
 */

import {
  applyParentInsert,
  applyParentMove,
  applyParentRemove,
  ancestorsOf,
  attachParentRows,
  checkParentInsert,
  ClosureError,
} from "./closure.ts";
import { checkEdgeAcyclic } from "./cycle.ts";
import { EDGE_SEMANTICS, type EdgeKind } from "./index.ts";
import {
  assertNodeField,
  assertNodeKind,
  OpFactory,
  attrKeyOf,
  coerceNodeFieldValue,
  contentHash,
  makeExcerpt,
  GraphError,
} from "./graph.ts";
import {
  compareClock,
  compareHlc,
  packHlc,
  unpackHlc,
  type EdgeAddOp,
  type EdgeDelOp,
  type Hlc,
  type IncOp,
  type JsonValue,
  type Op,
  type SetOp,
} from "./oplog.ts";
import { all, one, run, type Eff } from "./effect.ts";
import { NODE_INSERT_COLUMNS, NODE_SET_QUERIES, Q } from "./queries.ts";
import type { QueryDef } from "./sql.ts";

/**
 * ЧИСЛО ИЗ СТРОКИ ТАБЛИЦЫ, А НЕ ИЗ ДРАЙВЕРА.
 *
 * bun:sqlite отдаёт целую колонку числом, Postgres — BIGINT СТРОКОЙ (иначе
 * потерялись бы биты у больших значений, и у `hlc` это обязательно). Поэтому
 * `row.depth === 1` истинно на одной базе и ложно на другой — молча: ветка
 * просто не выбирается. Поймано ws.pg.test.ts на `parent` — замыкание
 * говорило «родителя нет» там, где он был.
 *
 * Здесь приводится ТОЛЬКО то, что применитель сравнивает как число. Часы
 * (`hlc`) через это не проходят: они читаются `readHlc` из строки и остаются
 * точными.
 */
function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Часы из колонки: в базе они лежат упакованным целым. */
export function readHlc(text: string | number | bigint): Hlc {
  return unpackHlc(BigInt(text));
}

function parseAttrs(raw: unknown): Record<string, JsonValue> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  return JSON.parse(raw) as Record<string, JsonValue>;
}

/**
 * Счётчики, у которых есть материализующая колонка в nodes. Остальные
 * G-counter'ы живут только в таблице counters — колонки под них нет, и молча
 * писать их в никуда нельзя.
 */
const COUNTER_COLUMNS: Readonly<Record<string, QueryDef>> = Object.freeze({
  seen_count: Q.node_set_seen_count,
});

function nodeSetQuery(field: string): QueryDef {
  const def = NODE_SET_QUERIES[`node_set_${field}`];
  if (def === undefined) {
    throw new GraphError("graph.unknown_field", `no write query for field '${field}'`);
  }
  return def;
}

/** Что случилось с одной операцией поля. */
export type ProjectOutcome = "applied" | "stale" | "collided";

export type ClockRow = { readonly hlc: string | number | bigint; readonly site_id: string };
type RawRow = Record<string, unknown>;

/** Совпадает ли значение поля в строке узла с тем, что несёт операция. */
function* sameStoredValue(op: SetOp, spec: ReturnType<typeof assertNodeField>): Eff<boolean> {
  const row = yield* one<RawRow>(Q.node_get, [op.entity_id]);
  if (row === undefined) return false;
  if (spec === "attr") {
    const key = attrKeyOf(op.field)!;
    return JSON.stringify(parseAttrs(row["attrs"])[key] ?? null) === JSON.stringify(op.value ?? null);
  }
  const stored = row[spec.field] ?? null;
  return stored === coerceNodeFieldValue(spec, op.value);
}

/**
 * LWW по паре (hlc, site_id) с одной особенностью, ради которой это не просто
 * «кто позже, тот прав»: НИЧЬЯ ПРИ РАЗНЫХ ЗНАЧЕНИЯХ — столкновение, а не
 * решение. Совпали часы и сайт, а значение другое — значит две машины
 * назначили разное в одну миллисекунду, и молча выбрать одно из них означало
 * бы потерять второе без следа (S38).
 *
 * `beforeWrite` вызывается ТОЛЬКО когда запись действительно будет: вызывающий
 * вешает на него учёт идентичности, и делать его для отброшенной операции
 * значило бы считать то, чего не произошло.
 */
export function* projectSet(op: SetOp, beforeWrite?: () => Eff<void>): Eff<ProjectOutcome> {
  const spec = assertNodeField(op.field);
  const guard = yield* one<ClockRow>(Q.field_clock_get, [op.entity_id, op.field]);
  if (guard !== undefined) {
    const cmp = compareClock(op.hlc, op.site_id, readHlc(guard.hlc), guard.site_id);
    if (cmp < 0) return "stale";
    if (cmp === 0) {
      return (yield* sameStoredValue(op, spec)) ? "stale" : "collided";
    }
  }
  if (beforeWrite !== undefined) yield* beforeWrite();
  const hlc = packHlc(op.hlc);
  if (spec === "attr") {
    const key = attrKeyOf(op.field)!;
    yield* run(Q.node_set_attr, [
      op.entity_id,
      `$.${key}`,
      JSON.stringify(op.value),
      op.hlc.ts,
      hlc,
      op.site_id,
    ]);
  } else {
    yield* run(nodeSetQuery(spec.field), [
      op.entity_id,
      coerceNodeFieldValue(spec, op.value),
      op.hlc.ts,
      hlc,
      op.site_id,
    ]);
  }
  yield* run(Q.field_clock_set, [op.entity_id, op.field, hlc, op.site_id]);
  return "applied";
}

/** G-counter: поэлементный максимум по сайтам, колонка — их сумма. */
export function* projectInc(op: IncOp): Eff<void> {
  yield* run(Q.counter_set, [op.entity_id, op.field, op.site_id, op.value]);
  const column = COUNTER_COLUMNS[op.field];
  if (column === undefined) return;
  const total = (yield* one<{ total: number }>(Q.counter_sum, [op.entity_id, op.field]))?.total ?? 0;
  yield* run(column, [op.entity_id, total]);
}

// ---------------------------------------------------------------------------
// Ключ ребра
// ---------------------------------------------------------------------------

/** Разделитель ключа ребра в памяти — тот же NUL, что и в oplog.ts. */
export const MEMORY_EDGE_SEPARATOR = "\u0000";

/**
 * В памяти ключ ребра склеен через NUL (`edgeKey` в oplog.ts) — там это
 * безопасно. В TEXT-колонке SQLite NUL хранить нельзя: `length()` и сравнения
 * обрываются на нём, а часть драйверов молча режет строку. Поэтому в колонке
 * `oplog.entity_id` ключ хранится в виде `src|type|dst` (§8.1.10). Отображение
 * биективно: `|` не встречается ни в каноническом ID (§3.1: slug + Crockford
 * base32), ни в имени типа ребра.
 */
export const EDGE_ENTITY_SEPARATOR = "|";

export function edgeEntityId(src: string, type: string, dst: string): string {
  return `${src}${EDGE_ENTITY_SEPARATOR}${type}${EDGE_ENTITY_SEPARATOR}${dst}`;
}

export function parseEdgeEntityId(value: string): {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
} {
  const parts = value.split(EDGE_ENTITY_SEPARATOR);
  if (parts.length !== 3) {
    throw new GraphError("graph.edge_type", `malformed edge key in the oplog: ${JSON.stringify(value)}`);
  }
  return { src: parts[0]!, type: parts[1]!, dst: parts[2]! };
}

/** Ключ ребра из Op.entity_id (NUL-форма) в форму колонки. */
export function splitMemoryEdgeKey(key: string): {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
} {
  const parts = key.split(MEMORY_EDGE_SEPARATOR);
  if (parts.length !== 3) {
    throw new GraphError("graph.edge_type", `malformed edge key: ${JSON.stringify(key)}`);
  }
  return { src: parts[0]!, type: parts[1]!, dst: parts[2]! };
}

/**
 * Производный хеш проигравшего дубликата. ':' в каноне (hex sha256) не
 * встречается, id уникален — значение уникально по построению, и UNIQUE
 * ux_nodes_content с ним столкнуться не может ни в какой момент транзакции.
 */
export function demotedContentHash(canon: string, id: string): string {
  return `${canon}:${id}`;
}

// ---------------------------------------------------------------------------
// Рёбра как OR-Set (§9.3)
// ---------------------------------------------------------------------------

/**
 * Состояние применителя, которое нельзя вывести из самой операции.
 *
 * `actor` попадает в строку ЛОКАЛЬНО созданного ребра, `now` даёт время
 * рождения узла, приехавшего по репликации. Оба приходят от движка: у CLI это
 * его часы и его пользователь, у сервера — его собственные.
 */
export interface ApplyCtx {
  readonly actor: string;
  /** Сайт этой машины: им подписаны все локальные операции. */
  readonly siteId: string;
  /** Фабрика операций и часы HLC — их поднимает движок, а не вызывающий (S38). */
  readonly ops: OpFactory;
  readonly now: () => number;
}

/**
 * Добавление ребра, ПРОЧИТАННОЕ из оплога для проекции. Не путать с `EdgeAdd`
 * из oplog.ts: та — модель операции в памяти, эта — то, что легло в строку
 * (тег, вес, часы, сайт) и участвует в выборе представителя.
 */
export interface EdgeAddRow {
  readonly tag: string;
  readonly weight: number;
  readonly hlc: Hlc;
  readonly site: string;
}

/** Старшинство добавления: часы, затем сайт, затем тег — тотальный порядок. */
export function compareEdgeAdd(a: EdgeAddRow, b: EdgeAddRow): number {
  const c = compareClock(a.hlc, a.site, b.hlc, b.site);
  if (c !== 0) return c;
  return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

export interface EdgeClockRow extends ClockRow {
  readonly add_tag: string;
  readonly deleted_at: number | null;
}

/** Добавления ребра из оплога (Q.edge_adds_of). */
export function* readEdgeAdds(entityId: string): Eff<EdgeAddRow[]> {
  const rows = yield* all<{ value: string; hlc: string; site_id: string }>(Q.edge_adds_of, [entityId]);
  return rows.map((row) => {
    const v = JSON.parse(row.value) as { tag: string; weight?: number };
    return { tag: v.tag, weight: v.weight ?? 1.0, hlc: readHlc(row.hlc), site: row.site_id };
  });
}

/** Живые теги ребра — всё, что обязано уйти в edge_del, чтобы удалить его сейчас. */
export function* liveEdgeTags(src: string, type: string, dst: string): Eff<string[]> {
  const tombs = yield* all<{ tag: string }>(Q.edge_tombstones_of, [src, type, dst]);
  const dead = new Set(tombs.map((t) => t.tag));
  const adds = yield* readEdgeAdds(edgeEntityId(src, type, dst));
  return adds
    .map((a) => a.tag)
    .filter((tag) => !dead.has(tag))
    .sort();
}

/**
 * Строка ребра из множества OR-Set — одна и та же на любой реплике с тем же
 * набором операций, в любом порядке их применения:
 *
 *   живо         ⇔ есть добавление, чей тег не покрыт тумбстоуном;
 *   представитель = старшее по (hlc, site_id, tag) среди живых добавлений,
 *                   а у мёртвого ребра — среди всех: его тег, вес и часы
 *                   идут в add_tag, weight, hlc/site_id;
 *   created_at   = самое раннее добавление;
 *   deleted_at   = у мёртвого — самое позднее удаление его тегов, иначе NULL.
 *
 * Добавлений ещё нет (удаление приехало раньше) — строки нет, лежат одни
 * тумбстоуны; они учтутся, когда добавление приедет.
 */
export function* reprojectEdge(
  ctx: ApplyCtx,
  src: string,
  type: string,
  dst: string,
  adds: readonly EdgeAddRow[],
  local?: { readonly actor: string; readonly attrs: string },
): Eff<void> {
  if (adds.length === 0) return;
  const tombs = new Map<string, number>();
  for (const t of yield* all<{ tag: string; hlc: string }>(Q.edge_tombstones_of, [src, type, dst])) {
    tombs.set(t.tag, readHlc(t.hlc).ts);
  }
  const live = adds.filter((a) => !tombs.has(a.tag));
  const pool = live.length > 0 ? live : adds;
  let rep = pool[0]!;
  for (const a of pool) if (compareEdgeAdd(a, rep) > 0) rep = a;
  let createdAt = adds[0]!.hlc.ts;
  for (const a of adds) if (a.hlc.ts < createdAt) createdAt = a.hlc.ts;
  let deletedAt: number | null = null;
  if (live.length === 0) {
    for (const a of adds) {
      const ts = tombs.get(a.tag)!;
      if (deletedAt === null || ts > deletedAt) deletedAt = ts;
    }
  }
  const hlc = packHlc(rep.hlc);
  if ((yield* one<EdgeClockRow>(Q.edge_clock_get, [src, type, dst])) === undefined) {
    yield* run(Q.edge_insert, [
      src,
      type,
      dst,
      rep.weight,
      rep.tag,
      local?.actor ?? ctx.actor,
      createdAt,
      hlc,
      rep.site,
      deletedAt,
      local?.attrs ?? "{}",
    ]);
    return;
  }
  yield* run(Q.edge_project, [src, type, dst, rep.weight, rep.tag, hlc, rep.site, createdAt, deletedAt]);
  if (local !== undefined) (yield* run(Q.edge_set_local, [src, type, dst, local.actor, local.attrs]));
}

/**
 * OR-Set add. Столкновением считается ничья часов при РАЗНЫХ тегах: две
 * машины добавили ребро в одну миллисекунду, и порядок между ними не
 * определён ничем — молча выбрать один значит потерять второй без следа.
 */
export function* projectEdgeAdd(
  ctx: ApplyCtx,
  op: EdgeAddOp,
  local?: { readonly actor: string; readonly attrs: string },
): Eff<ProjectOutcome> {
  const { src, type, dst } = splitMemoryEdgeKey(op.entity_id);
  const adds = yield* readEdgeAdds(edgeEntityId(src, type, dst));
  const collided = adds.some(
    (a) => a.tag !== op.value.tag && compareClock(a.hlc, a.site, op.hlc, op.site_id) === 0,
  );
  yield* reprojectEdge(ctx, src, type, dst, adds, local);
  return collided ? "collided" : "applied";
}

/**
 * OR-Set remove: тумбстоун на каждый увиденный тег, затем пересчёт. Ребро
 * гаснет, только когда не осталось ни одного живого добавления: добавление,
 * которого удаление не видело, его переживает (add wins).
 */
export function* projectEdgeDel(ctx: ApplyCtx, op: EdgeDelOp): Eff<void> {
  const { src, type, dst } = splitMemoryEdgeKey(op.entity_id);
  const hlc = packHlc(op.hlc);
  for (const tag of op.value.tags) {
    yield* run(Q.edge_tombstone_insert, [src, type, dst, tag, hlc, op.site_id]);
  }
  yield* reprojectEdge(ctx, src, type, dst, yield* readEdgeAdds(edgeEntityId(src, type, dst)));
}

/**
 * Строка узла, приехавшего по репликации. Без `kind` создать её нельзя
 * (NOT NULL + CHECK), и подставлять «какой-нибудь» kind недопустимо: узел с
 * выдуманным видом выглядел бы здоровым.
 */
export function* materializeNode(
  ctx: ApplyCtx,
  id: string,
  kind: string | undefined,
  scope = "",
): Eff<boolean> {
  if (kind === undefined) return false;
  assertNodeKind(kind);
  const ts = ctx.now();
  const row: Record<string, unknown> = {
    id,
    kind,
    layer: 1,
    // SCOPE БЕРЁТСЯ ИЗ ПАКЕТА, А НЕ СТАВИТСЯ ПУСТЫМ. Он приезжает своей
    // `set`-операцией, и рождать строку без него значит на короткое время
    // (до применения этой операции) иметь узел «ничьего» воркспейса — а в
    // оплог за это время успевают лечь ПЕРВЫЕ операции узла, и лечь со
    // scope ''. Обмен фильтрует оплог по воркспейсу, и такие операции в
    // пакет не попадают: узел приезжает пиру без `kind`, то есть не
    // приезжает вовсе (packages/cli/src/sync.pg.test.ts).
    scope,
    title: "",
    body: null,
    body_cold: 0,
    excerpt: "",
    status: "active",
    priority: 2,
    confidence: 1.0,
    salience: 1.0,
    seen_count: 0,
    head_id: null,
    // Уникальный по построению (см. demotedContentHash): узлы, рождённые в
    // одном пакете до своих title/body, не сталкиваются в ux_nodes_content.
    // Настоящий хеш ставит settleContent в конце транзакции.
    content_hash: demotedContentHash(contentHash(kind, "", null), id),
    acl: "team",
    owner_id: "",
    team_id: "",
    agent_id: "",
    assignee: "",
    actor: "",
    created_at: ts,
    updated_at: ts,
    accessed_at: 0,
    due_at: null,
    closed_at: null,
    compacted_at: null,
    deleted_at: null,
    hlc: 0,
    site_id: "",
    attrs: "{}",
  };
  yield* run(
    Q.node_insert,
    NODE_INSERT_COLUMNS.map((c) => row[c] ?? null),
  );
  // То же, что с content_hash строкой выше, и по той же причине: узел родился
  // без attrs, а `set attrs.external_ref` приедет следующей операцией этого же
  // пакета и внесёт его в ux_nodes_external. Держателем ссылки он становиться
  // не вправе, пока не выяснено, кто в группе старший, поэтому рождается
  // понижённым (ext_dup = id — уникально по построению). Настоящее значение
  // ставит settleExternal в конце транзакции: узлу, оставшемуся без ссылки,
  // оно вернёт ''.
  yield* run(Q.node_set_ext_dup, [id, id]);
  return true;
}

// ---------------------------------------------------------------------------
// Применение операций: учёт оплога, отложенные, идентичность
// ---------------------------------------------------------------------------

/** Счётчики одного вызова applyOps плюс рабочие очереди транзакции. */
export interface ApplyTally {
  applied: number;
  duplicate: number;
  stale: number;
  readonly deferred: string[];
  readonly released: string[];
  readonly collided: string[];
  readonly duplicates: IdentityDuplicate[];
  /**
   * Узлы, чьё членство в группе контента могло поменяться (title, body,
   * scope, deleted_at, attrs.external_ref, рождение): ключ группы ДО первой
   * правки, `null` — узел родился в этой транзакции. Пересчёт — settleContent.
   */
  readonly content: Map<string, ContentKey | null>;
  /**
   * То же для ux_nodes_external: узлы, чьё членство в группе внешней ссылки
   * могло поменяться (scope, deleted_at, attrs.external_ref, рождение).
   * Пересчёт — settleExternal.
   */
  readonly external: Map<string, ExternalKey | null>;
  /** В oplog_pending есть строки: применённую операцию надо из неё вычеркнуть. */
  pendingKnown: boolean;
}

/** Поля, от которых зависит членство узла в ux_nodes_content. */
export const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "body",
  "scope",
  "deleted_at",
  "attrs.external_ref",
]);

/** Никто не входит в группу этой транзакцией (holdExternal из createNode). */
export const NO_IDS: ReadonlySet<string> = new Set();

export const EXTERNAL_FIELDS: ReadonlySet<string> = new Set([
  "scope",
  "deleted_at",
  "attrs.external_ref",
]);

export function canonOf(stored: string): string {
  const at = stored.indexOf(":");
  return at < 0 ? stored : stored.slice(0, at);
}

/**
 * Старшинство в группе (и контентной, и по внешней ссылке): часы set(kind) —
 * момент создания узла, реплицируемый и одинаковый везде, — затем сайт,
 * затем id. Узел без часов kind (не бывает при целом оплоге) идёт последним.
 */
export function olderBorn(a: BornMember, b: BornMember): boolean {
  if (a.born_hlc !== null && b.born_hlc !== null) {
    const c = compareClock(
      readHlc(a.born_hlc),
      a.born_site ?? "",
      readHlc(b.born_hlc),
      b.born_site ?? "",
    );
    if (c !== 0) return c < 0;
  } else if (a.born_hlc !== null) {
    return true;
  } else if (b.born_hlc !== null) {
    return false;
  }
  return a.id < b.id;
}

export function newTally(): ApplyTally {
  return {
    applied: 0,
    duplicate: 0,
    stale: 0,
    deferred: [],
    released: [],
    collided: [],
    duplicates: [],
    content: new Map(),
    external: new Map(),
    pendingKnown: false,
  };
}

export interface PendingRow {
  readonly op_id: string;
  readonly needs: string;
  readonly origin: number;
  readonly op: string;
}

export interface ContentKey {
  readonly scope: string;
  readonly kind: string;
  readonly canon: string;
  /** Узел был в домене ux_nodes_content (живой, без external_ref). */
  readonly indexed: boolean;
  /** Держал пониженный хеш — был проигравшим дубликатом до транзакции. */
  readonly demoted: boolean;
}

export interface ExternalKey {
  readonly scope: string;
  readonly kind: string;
  readonly ref: string;
  /** Узел был в домене ux_nodes_external (живой, с external_ref). */
  readonly indexed: boolean;
  /** Был понижен — ссылку до транзакции держал кто-то другой. */
  readonly demoted: boolean;
}

export interface ContentRow {
  readonly kind: string;
  readonly scope: string;
  readonly title: string;
  readonly body: string | null;
  readonly content_hash: string;
  readonly indexed: number;
}

export interface ExternalRow {
  readonly kind: string;
  readonly scope: string;
  readonly ref: string | null;
  readonly ext_dup: string;
  readonly indexed: number;
}

export interface BornMember {
  readonly id: string;
  readonly born_hlc: string | null;
  readonly born_site: string | null;
}

export interface ContentMember extends BornMember {
  readonly content_hash: string;
}

export interface ExternalMember extends BornMember {
  readonly ext_dup: string;
}

export interface NodeHeadRow {
  readonly kind: string;
  readonly scope: string;
  readonly title: string;
  readonly body: string | null;
}

export interface IdentityDuplicate {
  /** Пониженный узел. */
  readonly id: string;
  /** Узел, держащий идентичность: канонический content_hash или ссылку. */
  readonly of: string;
  /**
   * Какая идентичность повторилась. `content` — (kind, title, body) в одном
   * scope у узлов, заведённых myc (ux_nodes_content); `external` — одна
   * `attrs.external_ref` у ввезённых (ux_nodes_external). Домены индексов
   * не пересекаются, поэтому один узел не может быть дубликатом обоих.
   */
  readonly by: "content" | "external";
}

export interface ApplyResult {
  /** Спроецированы на таблицы. */
  readonly applied: number;
  /** Отсечены дедупликацией по op_id — уже были применены. */
  readonly duplicate: number;
  /** Записаны в оплог, но проигнорированы LWW: наша версия новее. */
  readonly stale: number;
  /**
   * Не применены и НЕ записаны в оплог: зависимости не выполнены — узла нет,
   * а `kind` в пакете не пришёл, либо у ребра нет одного из концов. Запись
   * в оплог здесь была бы ловушкой — дедупликация по op_id навсегда закрыла
   * бы повторную попытку. Операции лежат в oplog_pending и применятся сами,
   * когда недостающий узел появится (myc-qie.9); молчать об этом всё равно
   * нельзя (инвариант И2), список уезжает наверх.
   */
  readonly deferred: readonly string[];
  /**
   * Отложены ранее (в этом или прошлом вызове) и применены СЕЙЧАС, потому
   * что их зависимости приехали этим пакетом. Уже учтены в `applied`;
   * список нужен вызывающему, который до этого показал их как deferred.
   */
  readonly released: readonly string[];
  /**
   * Записаны в оплог, но столкнулись с уже применённым полем по РАВНОЙ паре
   * (hlc, site_id) при ДРУГОМ значении. Разорвать такую ничью нечем: это не
   * решение LWW, а нарушение инварианта «один сайт — одна последовательность
   * часов». Тихого тай-брейка здесь нет — список обязан попасть в degraded
   * поверхности sync (И2). Локальная запись в той же ситуации бросает
   * GraphError graph.clock_collision.
   */
  readonly collided: readonly string[];
  /**
   * Контент-дубликаты (memory-0fs4rfa6xmha), затронутые этим пакетом: два
   * живых узла с одним (scope, kind, title, body) — обычно один и тот же
   * текст, записанный независимо на двух машинах. Уникальный индекс
   * ux_nodes_content такой пары не пускает, и раньше UNIQUE откатывал весь
   * пакет, а каждая следующая синхронизация падала тем же исключением.
   * Теперь канон остаётся у старшего узла (часы set(kind), одинаково на всех
   * репликах), у младшего производный content_hash понижен до `<канон>:<id>`,
   * данные обоих целы. `of` — узел, держащий канон. Молчать нельзя (И2):
   * список уезжает наверх, итог — в myc_health 'sync.duplicates' и
   * contentDuplicates().
   */
  readonly duplicates: readonly IdentityDuplicate[];
}

export const META_LAST_SEQ = "last_seq";


/** S3: myc_meta.last_seq — локальный порядок, на нём висит инвалидация. */
export function* persistSeq(ctx: ApplyCtx): Eff<void> {
  yield* run(Q.meta_set, [META_LAST_SEQ, String(ctx.ops.lastSeq)]);
}

/**
 * Ссылка — старшему живому узлу группы, остальным — понижение. Сначала
 * понижаются все, кроме победителя, и только потом он берёт ссылку: ни в
 * какой момент два узла не держат одну. `true` — в группе был или есть
 * дубликат: тогда пересчитывается myc_health. Понижённый на время этой
 * транзакции (touchExternal) дубликатом не считается — иначе полный проход
 * по nodes стоял бы в каждой правке ввезённого узла.
 */
export function* rebalanceExternal(
  ctx: ApplyCtx,
  g: { readonly scope: string; readonly kind: string; readonly ref: string },
  tally: ApplyTally,
): Eff<boolean> {
  const members = yield* all<ExternalMember>(Q.external_group, [g.scope, g.kind, g.ref]);
  if (members.length === 0) return false;
  let winner = members[0]!;
  for (const m of members) if (olderBorn(m, winner)) winner = m;
  const wasDemoted = (m: ExternalMember): boolean => {
    if (!tally.external.has(m.id)) return m.ext_dup !== "";
    return tally.external.get(m.id)?.demoted === true;
  };
  const touched = members.length > 1 || members.some(wasDemoted);
  for (const m of members) {
    if (m.id === winner.id) continue;
    if (m.ext_dup !== m.id) (yield* run(Q.node_set_ext_dup, [m.id, m.id]));
    if (!tally.duplicates.some((d) => d.id === m.id)) {
      tally.duplicates.push({ id: m.id, of: winner.id, by: "external" });
    }
  }
  if (winner.ext_dup !== "") (yield* run(Q.node_set_ext_dup, [winner.id, ""]));
  return touched;
}

/**
 * Своя запись входит в группу, где ссылку сейчас не держит никто, хотя
 * живые члены есть — все понижены. Так бывает, когда держатель ушёл той
 * же транзакцией, и когда его удалил бинарь 0.3.11–0.3.13: миграция 13
 * совместима, старый код пишет в эту базу, но групп не перебалансирует.
 * Не отдай здесь ссылку старшему из прежних членов, вошедший узел взял бы
 * её без UNIQUE, и своя запись завела бы второй узел с занятой ссылкой —
 * ровно то, что локально запрещено. Вошедшие этой транзакцией не
 * считаются: они ссылку ещё не держат, а только пробуют взять.
 */
/**
 * Канон группы — старшему живому узлу, остальным — пониженный хеш.
 * Сначала понижаются все, кроме победителя, и только потом он повышается:
 * ни в какой момент два узла не держат один канон. `true` — в группе был
 * или есть дубликат: тогда пересчитывается myc_health. Пониженный на время
 * этой транзакции (touchContent) дубликатом не считается — иначе полный
 * проход по nodes стоял бы в каждой правке заголовка.
 */
export function* rebalanceContent(
  ctx: ApplyCtx,
  g: { readonly scope: string; readonly kind: string; readonly canon: string },
  tally: ApplyTally,
): Eff<boolean> {
  const members = yield* all<ContentMember>(Q.content_group, [g.scope, g.kind, g.canon, `${g.canon};`]);
  if (members.length === 0) return false;
  let winner = members[0]!;
  for (const m of members) if (olderBorn(m, winner)) winner = m;
  const wasDemoted = (m: ContentMember): boolean => {
    if (!tally.content.has(m.id)) return m.content_hash !== g.canon;
    return tally.content.get(m.id)?.demoted === true;
  };
  const touched = members.length > 1 || members.some(wasDemoted);
  for (const m of members) {
    if (m.id === winner.id) continue;
    const want = demotedContentHash(g.canon, m.id);
    if (m.content_hash !== want) yield* run(Q.node_set_content_hash, [m.id, want]);
    if (!tally.duplicates.some((d) => d.id === m.id)) {
      tally.duplicates.push({ id: m.id, of: winner.id, by: "content" });
    }
  }
  if (winner.content_hash !== g.canon) yield* run(Q.node_set_content_hash, [winner.id, g.canon]);
  return touched;
}

export function* holdExternal(
  ctx: ApplyCtx,
  g: { readonly scope: string; readonly kind: string; readonly ref: string },
  joining: ReadonlySet<string>,
): Eff<void> {
  const group = yield* all<ExternalMember>(Q.external_group, [g.scope, g.kind, g.ref]);
  const members = group.filter((m) => !joining.has(m.id));
  if (members.length === 0 || members.some((m) => m.ext_dup === "")) return;
  let winner = members[0]!;
  for (const m of members) if (olderBorn(m, winner)) winner = m;
  yield* run(Q.node_set_ext_dup, [winner.id, ""]);
}

/**
 * Конец транзакции: кто держит внешнюю ссылку в каждой тронутой группе.
 * Зеркало settleContent, и `local` значит здесь то же самое: своя запись
 * не вправе завести второго держателя одной ссылки, поэтому вошедший в
 * чужую группу узел берёт `ext_dup = ''` прямой записью — занятая ссылка
 * даёт тот же UNIQUE, что и до правки. Прежние группы при этом
 * перебалансируются так же, как при репликации: иначе ссылка ушедшего
 * узла осталась бы здесь ничьей, а на реплике перешла бы к следующему —
 * расхождение того же класса.
 */
export function* settleExternal(
  ctx: ApplyCtx,
  tally: ApplyTally, local: boolean): Eff<boolean> {
  if (tally.external.size === 0) return false;
  const groups = new Map<string, { scope: string; kind: string; ref: string }>();
  const groupKey = (scope: string, kind: string, ref: string): string => {
    const key = `${scope}\u0000${kind}\u0000${ref}`;
    if (!groups.has(key)) groups.set(key, { scope, kind, ref });
    return key;
  };
  const joined: Array<{ id: string; key: string }> = [];
  let dupSeen = false;
  for (const [id, before] of tally.external) {
    const row = yield* one<ExternalRow>(Q.node_external_row, [id]);
    if (row === undefined) continue;
    const indexed = num(row.indexed) === 1;
    // Вне домена индекса разрешитель ни с кем не спорит и обязан быть
    // одинаков на всех репликах — значит пустой.
    if (!indexed && row.ext_dup !== "") (yield* run(Q.node_set_ext_dup, [id, ""]));
    if (before !== null && before.indexed) groupKey(before.scope, before.kind, before.ref);
    if (before?.demoted === true) dupSeen = true;
    if (!indexed) continue;
    const ref = row.ref ?? "";
    const key = groupKey(row.scope, row.kind, ref);
    const entered =
      before === null || !before.indexed || before.scope !== row.scope || before.ref !== ref;
    if (local && entered) joined.push({ id, key });
  }
  const joinedKeys = new Set(joined.map((j) => j.key));
  for (const [key, g] of groups) {
    if (joinedKeys.has(key)) continue;
    if (yield* rebalanceExternal(ctx, g, tally)) dupSeen = true;
  }
  const joinedIds = new Set(joined.map((j) => j.id));
  for (const j of joined) {
    yield* holdExternal(ctx, groups.get(j.key)!, joinedIds);
    yield* run(Q.node_set_ext_dup, [j.id, ""]);
    if (yield* rebalanceExternal(ctx, groups.get(j.key)!, tally)) dupSeen = true;
  }
  return dupSeen;
}

/**
 * Первая в транзакции правка поля, от которого зависит членство узла в
 * ux_nodes_external: запомнить группу ДО правки и сразу сделать узел
 * понижённым — тогда последующий UPDATE колонки (scope, deleted_at, attrs)
 * не упрётся в чужую ссылку. Кто держит ссылку, решит settleExternal.
 * `ext_dup = id` уникален по построению: id уникален, а всякий другой член
 * группы держит либо '', либо СВОЙ id.
 */
export function* touchExternal(
  ctx: ApplyCtx,
  id: string, tally: ApplyTally): Eff<void> {
  if (tally.external.has(id)) return;
  const row = yield* one<ExternalRow>(Q.node_external_row, [id]);
  if (row === undefined) return;
  tally.external.set(id, {
    scope: row.scope,
    kind: row.kind,
    ref: row.ref ?? "",
    indexed: num(row.indexed) === 1,
    demoted: row.ext_dup !== "",
  });
  if (row.ext_dup !== id) (yield* run(Q.node_set_ext_dup, [id, id]));
}

/**
 * Обе идентичности узла разом (§9.3): по содержимому для заведённого myc,
 * по ссылке на источник для ввезённого. Считаются они независимо — домены
 * индексов не пересекаются, — но здоровье пишется один раз: 'sync.duplicates'
 * называет одно число, которое человек и увидит.
 */
export function* settleIdentity(
  ctx: ApplyCtx,
  tally: ApplyTally,
  local: boolean,
): Eff<boolean> {
  const content = yield* settleContent(ctx, tally, local);
  const external = yield* settleExternal(ctx, tally, local);
  return content || external || tally.duplicates.length > 0;
}

/**
 * Конец транзакции: производные (excerpt, content_hash, решение S5) всех
 * тронутых узлов и перебалансировка их прежних и новых групп.
 *
 * `local` — своя запись: создать дубликат она не вправе, как и прежде.
 * Узел, ВОШЕДШИЙ в чужую группу (новый текст, новый scope, восстановление),
 * занимает канон прямой записью — занятый канон даёт тот же UNIQUE, что и
 * до правки. Прежние группы при этом перебалансируются так же, как при
 * репликации: иначе канон ушедшего узла остался бы ничьим здесь и
 * перешёл бы к следующему на реплике — расхождение того же класса.
 */
export function* settleContent(
  ctx: ApplyCtx,
  tally: ApplyTally, local: boolean): Eff<boolean> {
  if (tally.content.size === 0) return false;
  const groups = new Map<string, { scope: string; kind: string; canon: string }>();
  const groupKey = (scope: string, kind: string, canon: string): string => {
    const key = `${scope}\u0000${kind}\u0000${canon}`;
    if (!groups.has(key)) groups.set(key, { scope, kind, canon });
    return key;
  };
  const joined: Array<{ id: string; canon: string; key: string }> = [];
  let dupSeen = false;
  for (const [id, before] of tally.content) {
    const row = yield* one<ContentRow>(Q.node_content_row, [id]);
    if (row === undefined) continue;
    const canon = contentHash(row.kind, row.title, row.body);
    const indexed = num(row.indexed) === 1;
    // Вне домена индекса хеш канонический и ни с кем не сталкивается;
    // в домене — пока уникальный пониженный, решает перебалансировка.
    yield* run(Q.node_refresh_derived, [
      id,
      makeExcerpt(row.body),
      indexed ? demotedContentHash(canon, id) : canon,
    ]);
    if (before !== null && before.indexed) groupKey(before.scope, before.kind, before.canon);
    if (before?.demoted === true) dupSeen = true;
    if (!indexed) continue;
    const key = groupKey(row.scope, row.kind, canon);
    const entered =
      before === null || !before.indexed || before.scope !== row.scope || before.canon !== canon;
    if (local && entered) joined.push({ id, canon, key });
  }
  const joinedKeys = new Set(joined.map((j) => j.key));
  for (const [key, g] of groups) {
    if (joinedKeys.has(key)) continue;
    if (yield* rebalanceContent(ctx, g, tally)) dupSeen = true;
  }
  for (const j of joined) {
    yield* run(Q.node_set_content_hash, [j.id, j.canon]);
    if (yield* rebalanceContent(ctx, groups.get(j.key)!, tally)) dupSeen = true;
  }
  return dupSeen;
}

/**
 * Первая в транзакции правка поля, от которого зависит членство узла в
 * ux_nodes_content: запомнить группу ДО правки и сразу сделать хеш узла
 * уникальным — последующие UPDATE колонок (scope, deleted_at, attrs) уже
 * не могут упереться в UNIQUE. Окончательный хеш ставит settleContent.
 */
export function* touchContent(
  ctx: ApplyCtx,
  id: string, tally: ApplyTally): Eff<void> {
  if (tally.content.has(id)) return;
  const row = yield* one<ContentRow>(Q.node_content_row, [id]);
  if (row === undefined) return;
  const canon = canonOf(row.content_hash);
  tally.content.set(id, {
    scope: row.scope,
    kind: row.kind,
    canon,
    indexed: num(row.indexed) === 1,
    demoted: canon !== row.content_hash,
  });
  yield* run(Q.node_set_content_hash, [id, demotedContentHash(canon, id)]);
}

/**
 * Подготовка обоих уникальных индексов к правке одного поля. Узел держит
 * ДВЕ идентичности (§9.3), и поле `attrs.external_ref` меняет членство
 * сразу в обеих: пока оно NULL, узел спорит содержимым, как только
 * появилось — ссылкой. Поэтому оба «до записи» живут в одном месте:
 * забыть здесь один из них значит вернуть UNIQUE в середину транзакции.
 */
/**
 * Подготовка обоих уникальных индексов к правке одного поля. Узел держит ДВЕ
 * идентичности (§9.3), и поле `attrs.external_ref` меняет членство сразу в
 * обеих: пока оно NULL, узел спорит содержимым, как только появилось —
 * ссылкой. Поэтому оба «до записи» живут в одном месте: забыть здесь один из
 * них значит вернуть UNIQUE в середину транзакции.
 *
 * Возвращает НЕ действие, а фабрику эффекта: сам «до записи» ходит в базу, и
 * в мире генераторов обычное замыкание для этого не годится — его некому
 * прогнать.
 */
export function identityTouch(
  ctx: ApplyCtx,
  field: string,
  id: string,
  tally: ApplyTally,
): (() => Eff<void>) | undefined {
  const content = CONTENT_FIELDS.has(field);
  const external = EXTERNAL_FIELDS.has(field);
  if (!content && !external) return undefined;
  return function* touch(): Eff<void> {
    if (content) yield* touchContent(ctx, id, tally);
    if (external) yield* touchExternal(ctx, id, tally);
  };
}

/**
 * Журнал ЛОКАЛЬНОЙ операции. Её op_id только что выделен под блокировкой
 * записи (syncTail), поэтому «уже есть» — не повтор, а коллизия: другой
 * процесс этого же site_id выдал тот же seq. Молча пропустить нельзя (И2):
 * раньше именно так запись исчезала без следа (myc-4dy).
 */
export function* journalLocal(
  ctx: ApplyCtx,
  op: Op,
  entity: "node" | "edge",
  entityId: string,
  scope: string,
): Eff<void> {
  if (! (yield* journal(ctx, op, entity, entityId, scope, 1))) {
    throw new GraphError(
      "graph.clock_collision",
      `op_id ${op.op_id} is already in the oplog: two processes write under site_id ${op.site_id} with diverging seq — write rejected, not swallowed`,
    );
  }
}

/**
 * Записать операцию в оплог. `false` ⇒ op_id уже был: операция применена
 * ранее, и повторять проекцию нельзя. Это и есть дедупликация на SQL-слое,
 * которую чистая логика оплога оставила хранилищу.
 */
export function* journal(
  ctx: ApplyCtx,
  op: Op,
  entity: "node" | "edge",
  entityId: string,
  scope: string,
  origin: 0 | 1,
): Eff<boolean> {
  const result = yield* run(Q.oplog_insert, [
    op.op_id,
    op.site_id,
    packHlc(op.hlc),
    op.hlc.ts,
    ctx.actor,
    op.op,
    entity,
    entityId,
    op.field,
    JSON.stringify(op.value),
    scope,
    origin,
  ]);
  return result.changes > 0;
}

/**
 * Применить отложенное, чей недостающий узел уже есть в базе — как бы он
 * ни появился: родился в этой транзакции, создан локально с явным id,
 * приехал переездом, лежал в базе, где строка ожидания застряла при
 * прежнем коде. Прежний дренаж видел только узлы, рождённые в той же
 * транзакции applyOps, остальное ждало вечно (memory-nvx51d0kgf2t).
 * Круги повторяются, пока появляются узлы: цепочки (ребро ждало узел,
 * узел ждал kind) раскручиваются до конца. Операция, которой всё ещё
 * чего-то не хватает (второй конец ребра), перекладывается на новый
 * недостающий узел — которого нет, так что круг конечен.
 */
export function* drainPending(
  ctx: ApplyCtx,
tally: ApplyTally): Eff<void> {
  const none: ReadonlyMap<string, string> = new Map();
  for (;;) {
    const rows = yield* all<PendingRow>(Q.pending_ready, []);
    if (rows.length === 0) return;
    for (const row of rows) {
      yield* run(Q.pending_delete, [row.op_id]);
      const op = JSON.parse(row.op) as Op;
      const origin: 0 | 1 = num(row.origin) === 1 ? 1 : 0;
      ctx.ops.clock.recv(op.hlc);
      const needs = yield* applyOne(ctx, op, origin, none, tally);
      if (needs !== undefined) {
        // Один раз она уже в deferred этого или прошлого вызова; здесь
        // важна только смена ключа ожидания.
        yield* run(Q.pending_insert, [row.op_id, needs, origin, row.op, ctx.now()]);
        if (!tally.deferred.includes(row.op_id)) tally.deferred.push(row.op_id);
        continue;
      }
      const wasDeferredNow = tally.deferred.indexOf(row.op_id);
      if (wasDeferredNow >= 0) tally.deferred.splice(wasDeferredNow, 1);
      if (!tally.released.includes(row.op_id)) tally.released.push(row.op_id);
    }
  }
}

/**
 * Операция журналирована — её строка ожидания больше не нужна. Прежде она
 * оставалась, если операцию применила повторная доставка, а не дренаж:
 * фантом навсегда висел в pendingCount(). Применённая сейчас после
 * парковки в прошлом вызове — это `released`: вызывающий показывал её как
 * deferred. Повтор по op_id (`appliedNow = false`) — только уборка.
 */
export function* unpark(
  ctx: ApplyCtx,
opId: string, tally: ApplyTally, appliedNow: boolean): Eff<void> {
  if (!tally.pendingKnown) return;
  if ((yield* run(Q.pending_delete, [opId])).changes === 0 || !appliedNow) return;
  const i = tally.deferred.indexOf(opId);
  if (i >= 0) tally.deferred.splice(i, 1);
  if (!tally.released.includes(opId)) tally.released.push(opId);
}

/** Отложить операцию до появления узла `needs` (myc-qie.9). */
export function* park(
  ctx: ApplyCtx,
  op: Op,
  origin: 0 | 1,
  needs: string,
  tally: ApplyTally,
): Eff<void> {
  yield* run(Q.pending_insert, [
    op.op_id,
    needs,
    origin,
    JSON.stringify(op),
    ctx.now(),
  ]);
  tally.pendingKnown = true;
  tally.deferred.push(op.op_id);
}

/**
 * Одна операция внутри транзакции applyOps. Возвращает id узла, без
 * которого операцию применить нельзя, либо undefined — операция учтена
 * в `tally` (applied / duplicate / stale / collided).
 */
const EMPTY_HINT: ReadonlyMap<string, string> = new Map();

export function* applyOne(
  ctx: ApplyCtx,
  op: Op,
  origin: 0 | 1,
  kindHint: ReadonlyMap<string, string>,
  tally: ApplyTally,
  /** Воркспейс, который пакет назначает узлу: его `set scope`, если он в пакете. */
  scopeHint: ReadonlyMap<string, string> = EMPTY_HINT,
): Eff<string | undefined> {
  if (op.op === "edge_add" || op.op === "edge_del") {
    const { src, type, dst } = splitMemoryEdgeKey(op.entity_id);
    // Оба конца обязаны существовать: edges ссылается на nodes через
    // FOREIGN KEY, и вставка сироты откатила бы весь пакет.
    const srcHead = yield* one<NodeHeadRow>(Q.node_head, [src]);
    if (srcHead === undefined) return src;
    if ((yield* one<NodeHeadRow>(Q.node_head, [dst])) === undefined) return dst;
    const entityId = edgeEntityId(src, type, dst);
    if (! (yield* journal(ctx, op, "edge", entityId, srcHead.scope, origin))) {
      tally.duplicate++;
      yield* unpark(ctx, op.op_id, tally, false);
      return undefined;
    }
    if (op.op === "edge_add") {
      const outcome = yield* projectEdgeAdd(ctx, op);
      if (outcome === "collided") tally.collided.push(op.op_id);
      else {
        tally.applied++;
        // ЗАМЫКАНИЕ ВЕДЁТ ПРИМЕНИТЕЛЬ, И ВЕДЁТ ЕГО ЗДЕСЬ ТОЖЕ. Прежде этот
        // путь его не трогал вовсе: узел, перевешенный на другой машине,
        // приезжал ничьим потомком — блокеры родителя на него не
        // распространялись, и очередь считала его свободным. Молча
        // (memory-pw6mekaa15g4).
        if (op.field === "parent") {
          yield* applyParentEdgeMerged(ctx, src, dst, op.hlc, op.site_id);
        }
      }
    } else {
      yield* projectEdgeDel(ctx, op);
      tally.applied++;
      if (op.field === "parent") yield* applyParentEdgeMergedRemove(src, dst);
    }
    yield* unpark(ctx, op.op_id, tally, true);
    return undefined;
  }

  // set / inc: проекция невозможна, пока строки узла нет. Такую
  // операцию нельзя и журналировать — дедупликация по op_id закрыла бы
  // повторную попытку навсегда.
  let head = yield* one<NodeHeadRow>(Q.node_head, [op.entity_id]);
  if (head === undefined && op.op === "set") {
    const kind =
      op.field === "kind" && typeof op.value === "string"
        ? op.value
        : kindHint.get(op.entity_id);
    if (yield* materializeNode(ctx, op.entity_id, kind, scopeHint.get(op.entity_id) ?? "")) {
      // Родился в этой транзакции: прежних групп — ни контентной, ни по
      // внешней ссылке — у него нет.
      tally.content.set(op.entity_id, null);
      tally.external.set(op.entity_id, null);
      head = yield* one<NodeHeadRow>(Q.node_head, [op.entity_id]);
    }
  }
  if (head === undefined) return op.entity_id;
  if (! (yield* journal(ctx, op, "node", op.entity_id, head.scope, origin))) {
    tally.duplicate++;
    yield* unpark(ctx, op.op_id, tally, false);
    return undefined;
  }
  if (op.op === "set") {
    const outcome = yield* projectSet(op, identityTouch(ctx, op.field, op.entity_id, tally));
    if (outcome === "applied") {
      tally.applied++;
    } else if (outcome === "stale") {
      tally.stale++;
    } else {
      tally.collided.push(op.op_id);
    }
  } else {
    yield* projectInc(op);
    tally.applied++;
  }
  yield* unpark(ctx, op.op_id, tally, true);
  return undefined;
}

export function* syncTail(ctx: ApplyCtx): Eff<void> {
  const metaSeq = Number((yield* one<{ value: string }>(Q.meta_get, [META_LAST_SEQ]))?.value ?? 0);
  ctx.ops.advanceSeq(metaSeq);
  const clock = ctx.ops.clock;
  const own = yield* one<{ hlc: string | null }>(Q.oplog_last_local_hlc, [
    ctx.siteId,
  ]);
  if (own?.hlc != null) {
    const ownHlc = readHlc(own.hlc);
    if (compareHlc(ownHlc, clock.state) > 0) clock.recv(ownHlc);
  }
  const last = yield* one<ClockRow>(Q.oplog_last_row_clock, []);
  if (last !== undefined && last.site_id !== ctx.siteId) {
    const lastHlc = readHlc(last.hlc);
    if (compareHlc(lastHlc, clock.state) > 0) clock.recv(lastHlc);
  }
}

/**
 * ПРИМЕНИТЬ ПАКЕТ ОПЕРАЦИЙ — вход, которым пользуются обе стороны: движок
 * SQLite прогоняет его синхронно, сервер над Postgres — асинхронно. Здесь
 * ровно то, что относится к правилам, и ничего про транзакцию: её открывает
 * вызывающий, потому что она у каждого своя (`BEGIN IMMEDIATE` против MVCC).
 *
 * Порядок внутри пакета свой, а не тот, в котором операции приехали:
 * сортировка по (hlc, site_id) делает результат одинаковым на всех репликах.
 * `kind` берётся из самого пакета — строка узла без него не рождается
 * (NOT NULL + CHECK), а порядок операций произволен.
 *
 * Итог НЕ содержит здоровья дубликатов: пересчёт `myc_health` читает всю базу
 * и относится к хранилищу, поэтому его делает вызывающий, увидев `settled`.
 */
export function* applyOps(
  ctx: ApplyCtx,
  ops: readonly Op[],
  origin: 0 | 1 = 0,
): Eff<ApplyResult & { readonly settled: boolean }> {
  const sorted = [...ops].sort((a, b) => compareClock(a.hlc, a.site_id, b.hlc, b.site_id));
  for (const op of sorted) ctx.ops.clock.recv(op.hlc);

  const kindInBatch = new Map<string, string>();
  const scopeInBatch = new Map<string, string>();
  for (const op of sorted) {
    if (op.op === "set" && op.field === "kind" && typeof op.value === "string") {
      kindInBatch.set(op.entity_id, op.value);
    }
    if (op.op === "set" && op.field === "scope" && typeof op.value === "string") {
      scopeInBatch.set(op.entity_id, op.value);
    }
  }

  const tally = newTally();
  // Локальных op_id здесь не выдаём, но persistSeq в конце не имеет права
  // откатить myc_meta.last_seq ниже того, что уже зафиксировал соседний
  // процесс этого же site_id.
  yield* syncTail(ctx);
  if ((yield* one(Q.pending_any, [])) !== undefined) {
    tally.pendingKnown = true;
    // База, где строка ожидания пережила применение своей операции.
    yield* run(Q.pending_phantoms_delete, []);
  }
  for (const op of sorted) {
    const needs = yield* applyOne(ctx, op, origin, kindInBatch, tally, scopeInBatch);
    if (needs !== undefined) yield* park(ctx, op, origin, needs, tally);
  }
  if (tally.pendingKnown) yield* drainPending(ctx, tally);
  const settled = yield* settleIdentity(ctx, tally, false);
  yield* persistSeq(ctx);

  return {
    applied: tally.applied,
    duplicate: tally.duplicate,
    stale: tally.stale,
    deferred: tally.deferred,
    released: tally.released,
    collided: tally.collided,
    duplicates: tally.duplicates,
    settled,
  };
}

/**
 * ЛОКАЛЬНАЯ ЗАПИСЬ: минт операций и их применение в ОДНОЙ транзакции.
 *
 * `mint` вызывается ЗДЕСЬ, а не у вызывающего, и это не стиль, а условие
 * правильности (myc-4dy): op_id и часы выдаются от последнего, что видно в
 * оплоге, а увидеть его можно только под блокировкой записи — после
 * `syncTail`. Сминтив операции раньше, два процесса одного сайта (или два
 * запроса к серверу подряд) получают ОДИНАКОВЫЕ op_id, и второй пакет
 * журналируется как повтор: ни строки, ни ошибки. Поймано ws.pg.test.ts —
 * второй узел, созданный через HTTP, не записался вовсе.
 *
 * Столкновение здесь — исключение, а не «stale»: у локальной записи не бывает
 * законной ничьей, она означает двух писателей под одним site_id.
 */
export function* applyLocalOps(
  ctx: ApplyCtx,
  mint: () => readonly Op[],
  entityId: string,
  scope: string,
  onCollision: (op: Op) => Error,
): Eff<boolean> {
  yield* syncTail(ctx);
  const ops = mint();
  const tally = newTally();
  for (const op of ops) {
    yield* journalLocal(ctx, op, "node", entityId, scope);
    if (op.op === "set") {
      const touch = identityTouch(ctx, op.field, entityId, tally);
      if ((yield* projectSet(op, touch)) === "collided") throw onCollision(op);
    } else if (op.op === "inc") {
      yield* projectInc(op);
    }
  }
  const settled = yield* settleIdentity(ctx, tally, true);
  yield* persistSeq(ctx);
  return settled;
}

// ---------------------------------------------------------------------------
// Локальная запись ребра
// ---------------------------------------------------------------------------

/**
 * `parent` особенный: у него есть материализованное замыкание, и «уже потомок»
 * там стоит один спуск, а не обход. Остальные ацикличные типы (blocks)
 * проверяются обходом — cycle.ts.
 */
function* checkEdgeRules(src: string, type: EdgeKind, dst: string): Eff<void> {
  const semantics = EDGE_SEMANTICS[type];
  if (semantics.acyclic && type !== "parent") {
    yield* checkEdgeAcyclic(src, type, dst, semantics.maxDepth);
  }
}

/**
 * Поддержка дерева при добавлении ребра `parent(child → parent)`. У ребёнка
 * может УЖЕ быть родитель: тогда старое ребро гасится операцией (add-wins
 * OR-Set требует назвать все живые теги), и только потом поддерево
 * перевешивается — иначе `checkParentInsert` спотыкается о старую связь как о
 * ложный цикл.
 */
export function* applyParentEdgeAdd(ctx: ApplyCtx, child: string, parent: string): Eff<void> {
  const current = (yield* ancestorsOf(child)).find((a) => num(a.depth) === 1)?.ancestor;
  if (current === parent) return;
  if (current === undefined) {
    yield* applyParentInsert(child, parent);
    return;
  }
  const oldEdge = yield* one<EdgeClockRow>(Q.edge_clock_get, [child, "parent", current]);
  const oldTags = oldEdge?.deleted_at === null ? yield* liveEdgeTags(child, "parent", current) : [];
  if (oldTags.length > 0) {
    const scope = (yield* one<NodeHeadRow>(Q.node_head, [child]))?.scope ?? "";
    const delOp = ctx.ops.edgeDel(child, "parent", current, oldTags);
    yield* journalLocal(ctx, delOp, "edge", edgeEntityId(child, "parent", current), scope);
    yield* projectEdgeDel(ctx, delOp);
  }
  yield* applyParentMove(child, parent);
}

/**
 * Симметрично для удаления. `parent` не прямой родитель `child` в замыкании —
 * либо ребро не было материализовано, либо это тумбстоун старого тега поверх
 * ребра, которое add-wins уже пережил; в обоих случаях замыкание не трогаем,
 * чтобы не снести чужой живой parent.
 */
export function* applyParentEdgeRemove(child: string, parent: string): Eff<void> {
  const current = (yield* ancestorsOf(child)).find((a) => num(a.depth) === 1)?.ancestor;
  if (current !== parent) return;
  yield* applyParentRemove(child, parent);
}

/**
 * ДЕРЕВО ПРИ РЕБРЕ `parent`, ПРИЕХАВШЕМ ПО РЕПЛИКАЦИИ (§4.2, §4.3).
 *
 * Локальный путь (`applyParentEdgeAdd`) вправе ОТКАЗАТЬ: операции ещё нет,
 * отказ ничего не теряет. Здесь отказывать нельзя — операция уже принята на
 * своём сайте и, возможно, у половины команды. Поэтому материализация
 * идемпотентна и не бросает: она либо вешает поддерево, либо оставляет
 * дерево как есть и ПОМЕЧАЕТ ребро.
 *
 * ТРИ ИСХОДА, и каждый из них — решение, а не обработка ошибки:
 *
 *  - родитель уже тот же — ничего; повтор доставки не должен ничего менять;
 *  - родителя не было — вешаем. Если вставка создала бы ЦИКЛ или превысила
 *    глубину, дерево не трогаем, а на ребре ставим `attrs.cycle = 1` (§4.3:
 *    цикл, приехавший мержем, помечается, а не отвергается; разрывает
 *    человек);
 *  - родитель БЫЛ И ДРУГОЙ — две стороны перевесили узел независимо. Слот
 *    «мой родитель» односоставный (§3.2: `path(n)` знает одного), поэтому
 *    ничью решают часы ребра, как у любого поля: позднейшее (hlc, site_id)
 *    забирает слот. Оба ребра при этом остаются живыми в `edges` — там
 *    OR-Set, и стирать чужое добавление мы не вправе; расходится не
 *    состояние, а его прочтение, и назвать это должен `myc doctor`.
 */
export function* applyParentEdgeMerged(
  ctx: ApplyCtx,
  child: string,
  parent: string,
  hlc: Hlc,
  site: string,
): Eff<void> {
  const current = (yield* ancestorsOf(child)).find((a) => num(a.depth) === 1)?.ancestor;
  if (current === parent) return;
  if (current !== undefined) {
    const cur = yield* one<EdgeClockRow>(Q.edge_clock_get, [child, "parent", current]);
    // Часов у текущего ребра нет (замыкание старше рёбер) — не спорим.
    if (cur === undefined) return;
    if (compareClock(hlc, site, readHlc(cur.hlc), cur.site_id) <= 0) return;
    yield* applyParentRemove(child, current);
  }
  try {
    yield* checkParentInsert(child, parent);
  } catch (e) {
    if (!(e instanceof ClosureError)) throw e;
    // Дерево оставляем как было: снятый выше родитель возвращается, иначе
    // приехавший цикл ещё и осиротил бы узел.
    if (current !== undefined) yield* attachParentRows(child, current);
    yield* markEdgeCycle(child, "parent", parent);
    return;
  }
  yield* attachParentRows(child, parent);
}

/**
 * Снятие ребра `parent`, приехавшее по репликации. Ребро могло ПЕРЕЖИТЬ
 * снятие (add-wins: добавление с тегом, которого удаление не видело), и
 * тогда дерево трогать нельзя — иначе узел осиротеет при живом ребре.
 */
export function* applyParentEdgeMergedRemove(child: string, parent: string): Eff<void> {
  const row = yield* one<EdgeClockRow>(Q.edge_clock_get, [child, "parent", parent]);
  if (row !== undefined && row.deleted_at === null) return;
  const current = (yield* ancestorsOf(child)).find((a) => num(a.depth) === 1)?.ancestor;
  if (current !== parent) return;
  yield* applyParentRemove(child, parent);
}

/** Пометка §4.3 на ребре. Идемпотентна: второй раз ничего не пишет. */
export function* markEdgeCycle(src: string, type: string, dst: string): Eff<void> {
  const row = yield* one<{ attrs: string | null }>(Q.edge_attrs_get, [src, type, dst]);
  if (row === undefined) return;
  const attrs = parseAttrs(row.attrs) as Record<string, JsonValue>;
  if (attrs["cycle"] === 1) return;
  attrs["cycle"] = 1;
  yield* run(Q.edge_set_attrs, [src, type, dst, JSON.stringify(attrs)]);
}

/**
 * ДОБАВИТЬ РЕБРО ЛОКАЛЬНО: правила целиком, без транзакции (её открывает
 * вызывающий — у SQLite это `BEGIN IMMEDIATE`, у сервера `withTenant`).
 *
 * Порядок не переставляется: сначала часы поднимаются от хвоста, потом
 * проверяются правила типа ребра, и только потом минтится операция. Сминтить
 * раньше — это myc-4dy; проверить позже — значит записать в оплог то, что
 * будет отвергнуто.
 */
export function* applyLocalEdgeAdd(
  ctx: ApplyCtx,
  src: string,
  type: EdgeKind,
  dst: string,
  scope: string,
  opts: { readonly weight?: number; readonly attrs?: string },
  onCollision: (op: Op) => Error,
): Eff<void> {
  yield* syncTail(ctx);
  yield* checkEdgeRules(src, type, dst);
  const op = ctx.ops.edgeAdd(src, type, dst, opts.weight);
  yield* journalLocal(ctx, op, "edge", edgeEntityId(src, type, dst), scope);
  const outcome = yield* projectEdgeAdd(ctx, op, { actor: ctx.actor, attrs: opts.attrs ?? "{}" });
  if (outcome === "collided") throw onCollision(op);
  if (type === "parent") yield* applyParentEdgeAdd(ctx, src, dst);
  yield* persistSeq(ctx);
}

/**
 * УДАЛИТЬ РЕБРО ЛОКАЛЬНО. В операцию попадают ВСЕ живые на этот момент теги:
 * добавление, которого этот сайт не видел, удаление переживает (add-wins).
 * `false` — удалять было нечего.
 */
export function* applyLocalEdgeDel(
  ctx: ApplyCtx,
  src: string,
  type: EdgeKind,
  dst: string,
  scope: string,
): Eff<boolean> {
  yield* syncTail(ctx);
  const tags = yield* liveEdgeTags(src, type, dst);
  if (tags.length === 0) return false;
  const op = ctx.ops.edgeDel(src, type, dst, tags);
  yield* journalLocal(ctx, op, "edge", edgeEntityId(src, type, dst), scope);
  yield* projectEdgeDel(ctx, op);
  if (type === "parent") yield* applyParentEdgeRemove(src, dst);
  yield* persistSeq(ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Аренда задачи (§9.4)
// ---------------------------------------------------------------------------

/**
 * Lease задачи: TTL аренды и каденция продления (§9.4). Держатель обязан
 * продлевать аренду heartbeat'ом каждые 300 с; просроченная аренда в любом
 * случае не блокирует других — условие `lease_expires < now` в CAS открывает
 * задачу заново, отдельного сборщика не нужно.
 */
export const LEASE_TTL_MS = 900_000;
export const LEASE_RENEW_MS = 300_000;

export type ClaimAction = "claim" | "renew" | "release" | "close";

export interface ClaimReceipt {
  readonly id: string;
  readonly holder: string;
  readonly epoch: number;
  readonly expiresAt: number;
}

interface ClaimedRow {
  readonly scope: string;
  readonly lease_epoch: number | string;
  readonly lease_expires: number | string;
}

/**
 * Операция аренды в оплоге. Повтор op_id здесь — не «уже применено», а
 * коллизия: два процесса под одним site_id выдали один номер, и молча
 * пропустить значило бы потерять захват (myc-4dy).
 */
export function* journalClaim(
  ctx: ApplyCtx,
  meta: SetOp,
  entityId: string,
  scope: string,
  action: ClaimAction,
  holder: string,
  epoch: number,
  expires: number,
): Eff<void> {
  const inserted = yield* run(Q.oplog_insert, [
    meta.op_id,
    meta.site_id,
    packHlc(meta.hlc),
    meta.hlc.ts,
    ctx.actor,
    "claim",
    "node",
    entityId,
    "lease",
    JSON.stringify({ action, holder, epoch, expires }),
    scope,
    1,
  ]);
  if (inserted.changes !== 1) {
    throw new GraphError(
      "graph.clock_collision",
      `operation ${meta.op_id} is already in the oplog — a repeated journal claim is not allowed`,
    );
  }
}

/**
 * ЗАХВАТИТЬ ЗАДАЧУ. Взаимное исключение — не LWW: офлайновый агент с более
 * поздними часами не должен «украсть» чужую работу. Роль LWW здесь играет
 * CAS-предикат в ОДНОМ операторе плюс монотонная эпоха аренды; окна между
 * чтением и записью нет вовсе.
 *
 * `undefined` — задачу уже забрали или она не открыта: вызывающий берёт
 * следующую из очереди, а не ждёт.
 */
export function* claimNode(
  ctx: ApplyCtx,
  id: string,
  holder: string,
  ttlMs: number,
): Eff<ClaimReceipt | undefined> {
  yield* syncTail(ctx);
  const meta = ctx.ops.set(id, "lease", { action: "claim", holder });
  const expiresAt = meta.hlc.ts + ttlMs;
  const claimed = yield* one<ClaimedRow>(Q.claim_node, [
    id,
    holder,
    expiresAt,
    meta.hlc.ts,
    packHlc(meta.hlc),
    ctx.siteId,
  ]);
  if (claimed === undefined) return undefined;
  const epoch = num(claimed.lease_epoch);
  yield* journalClaim(ctx, meta, id, claimed.scope, "claim", holder, epoch, expiresAt);
  yield* persistSeq(ctx);
  return { id, holder, epoch, expiresAt: num(claimed.lease_expires) };
}
