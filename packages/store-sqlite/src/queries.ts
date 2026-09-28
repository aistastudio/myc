import * as A from "@myc/core";
/**
 * Реестр запросов и CRUD узлов и рёбер поверх оплога.
 *
 * Правило §8.4: единственное место в кодовой базе, где живёт текст SQL. Тексты
 * per-field собираются из белого списка NODE_FIELDS (@myc/core/graph) один раз
 * при загрузке модуля — конкатенации со значениями из ввода нет нигде.
 *
 * Каждая мутация — одна транзакция BEGIN IMMEDIATE, в которой лежат и правка
 * проекции (nodes/edges), и записи оплога. Половинчатого состояния не бывает
 * ни при каком падении: либо есть и узел, и его операции, либо нет ничего.
 *
 * Источники: docs/design/01-core-data-model.md §2, §4, §8.4, §9.3;
 * docs/design/ARCHITECTURE.md §10 (S3, S5, S25, S30).
 */

import {
  projectInc,
  projectSet,
  readHlc,
  edgeEntityId,
  LEASE_TTL_MS,
  newTally,
  parseEdgeEntityId,
  runSync,
  splitMemoryEdgeKey,
  META_LAST_SEQ,
  MEMORY_EDGE_SEPARATOR,
  NO_IDS,
  type ApplyResult,
  type ApplyCtx,
  type ApplyTally,
  type Eff,
  type EdgeAddRow,
  type EdgeClockRow,
  type IdentityDuplicate,
  type NodeHeadRow,
  type PendingRow,
  type ProjectOutcome,
  NODE_INSERT_COLUMNS,
  NODE_SET_QUERIES,
  Q,
  HlcClock,
  compareClock,
  compareHlc,
  defineQueries,
  packHlc,
  unpackHlc,
  type DbDriver,
  type EdgeAddOp,
  type EdgeDelOp,
  type EdgeKind,
  type Hlc,
  type IncOp,
  type JsonValue,
  type Op,
  type QueryDef,
  type SetOp,
} from "@myc/core";
import {
  EDGE_SEMANTICS,
  GraphError,
  NODE_FIELDS,
  OpFactory,
  assertEdgeEndpoints,
  assertEdgeKind,
  assertNodeField,
  assertNodeKind,
  attrKeyOf,
  coerceNodeFieldValue,
  contentHash,
  makeExcerpt,
  nodeInputFields,
  nodePatchFields,
  type EdgeRecord,
  type NodeInput,
  type NodePatch,
  type NodeRecord,
} from "@myc/core";
import { ancestorsOf, applyParentInsert, applyParentMove, applyParentRemove } from "./closure.ts";
import { checkEdgeAcyclic } from "./cycle.ts";

// ---------------------------------------------------------------------------
// Ключ ребра в SQL
// ---------------------------------------------------------------------------


// Сроки аренды переехали в ядро вместе с её правилом (packages/core/src/
// apply.ts): задачи берут и агенты через CLI, и люди через сервер.
export { LEASE_TTL_MS, LEASE_RENEW_MS } from "@myc/core";





// ---------------------------------------------------------------------------
// Точность HLC в SQLite
// ---------------------------------------------------------------------------

/**
 * packHlc — это `(ms << 16) | counter`, то есть около 1.2e17 при нынешних
 * датах, а Number.MAX_SAFE_INTEGER — 9.0e15. Прочитать колонку `hlc` как JS
 * number значит потерять младшие четыре бита счётчика: две записи в одну и ту
 * же миллисекунду сравнялись бы, и LWW перестал бы различать их порядок.
 *
 * Поэтому в базу часы уходят BigInt'ом (bun:sqlite связывает его точным
 * int64), а обратно читаются через CAST(hlc AS TEXT). Обе стороны проверены
 * на реальном рантайме; безопасного числового пути здесь нет.
 */
// ---------------------------------------------------------------------------
// Реестр запросов
// ---------------------------------------------------------------------------

// Реестр запросов и колонки узла живут в ядре (packages/core/src/queries.ts):
// их делит с этим движком будущий применитель операций, а `store-*` по
// правилу deps-check видят только ядро. Реэкспорт — чтобы вызывающие
// (`import { Q } from "@myc/store-sqlite"`) не переучивались ради переезда.
export {
  Q,
  NODE_SET_QUERIES,
  NODE_INSERT_COLUMNS,
  edgeEntityId,
  parseEdgeEntityId,
  EDGE_ENTITY_SEPARATOR,
  type ApplyResult,
  type IdentityDuplicate,
} from "@myc/core";


// ---------------------------------------------------------------------------
// Разбор строк
// ---------------------------------------------------------------------------

type RawRow = Record<string, unknown>;

function parseAttrs(raw: unknown): Record<string, JsonValue> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  return JSON.parse(raw) as Record<string, JsonValue>;
}

export function rowToNode(row: RawRow): NodeRecord {
  return { ...row, attrs: parseAttrs(row["attrs"]) } as unknown as NodeRecord;
}

export function rowToEdge(row: RawRow): EdgeRecord {
  return { ...row, attrs: parseAttrs(row["attrs"]) } as unknown as EdgeRecord;
}

// ---------------------------------------------------------------------------
// Хранилище графа
// ---------------------------------------------------------------------------

export interface GraphStoreOptions {
  /** Генератор ID узла — обычно generateId из @myc/core. */
  readonly newId: () => string;
  /** ID сайта. Если в myc_meta уже записан site_id, побеждает он. */
  readonly siteId?: string;
  /** Кто пишет: человек или агент. Уходит в oplog.actor и edges.actor. */
  readonly actor?: string;
  /** Часы. Для тестов детерминизма подменяются целиком. */
  readonly clock?: HlcClock;
  /** Источник физического времени (мс). По умолчанию Date.now. */
  readonly now?: () => number;
}



/** Ключ группы контента узла до правки в этой транзакции. */

/** Ключ группы внешней ссылки узла до правки в этой транзакции. */



/**
 * Поля, от которых зависит членство узла в ux_nodes_external. Текст узла
 * сюда не входит: идентичность ввезённого даёт ссылка на источник, а не
 * содержимое (миграция 9).
 */







/** Исход проекции одного LWW-поля или OR-Set-добавления. */

export interface AddEdgeOptions {
  readonly weight?: number;
  readonly attrs?: Readonly<Record<string, JsonValue>>;
}

interface ClockRow {
  readonly hlc: string;
  readonly site_id: string;
}


/** Одно добавление OR-Set ребра, прочитанное из оплога. */


interface EdgeRowState {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
}


/** Член группы идентичности: id плюс часы рождения (set(kind)). */



/** Строка узла в терминах ux_nodes_external. */

interface ClaimCloseRow {
  readonly id: string;
  readonly scope: string;
  readonly ts_ms: number;
  readonly value: string;
  readonly site_id: string;
}


export interface OplogRow {
  readonly seq: number;
  readonly op_id: string;
  readonly site_id: string;
  /** CAST(hlc AS TEXT): точное 64-битное значение, см. readHlc. */
  readonly hlc: string;
  readonly ts_ms: number;
  readonly actor: string;
  readonly op: string;
  readonly entity: string;
  readonly entity_id: string;
  readonly field: string | null;
  readonly value: string | null;
  readonly scope: string;
  readonly origin: number;
}

/**
 * Результат успешного CAS-захвата (§9.4). `epoch` монотонно растёт при каждом
 * захвате — держатель с устаревшей эпохой не владеет задачей ни в каком смысле.
 */
export interface ClaimReceipt {
  readonly id: string;
  readonly holder: string;
  readonly epoch: number;
  /** lease_expires, мс по шкале HLC: hlc.ts + TTL. */
  readonly expiresAt: number;
}

/** Срез lease-состояния узла — для чтения, не для решений о захвате. */
export interface NodeLease {
  readonly id: string;
  readonly status: string;
  readonly holder: string;
  readonly epoch: number;
  readonly expires: number;
}

interface ClaimedRow {
  readonly id: string;
  readonly scope: string;
  readonly lease_epoch: number;
  readonly lease_expires: number;
}

type ClaimAction = "claim" | "renew" | "release" | "close";

const META_SITE_ID = "site_id";
/** Строки рёбер пересобраны из множества OR-Set хотя бы раз (memory-86eqge02q8rd). */
export const META_EDGES_REPROJECTED = "edges_reprojected";

/** seq из op_id = `<site_id>:<seq>` (makeOpId); битый хвост читается как 0. */
function seqOfOpId(opId: string, siteId: string): number {
  const seq = Number(opId.slice(siteId.length + 1));
  return Number.isFinite(seq) ? seq : 0;
}

/** Ничья (hlc, site_id) при разных значениях — локально это ошибка, не выбор. */
function collisionError(op: Op, entityId: string): GraphError {
  return new GraphError(
    "graph.clock_collision",
    `field ${entityId}.${op.field}: the pair (hlc ${op.hlc.ts}:${op.hlc.ctr}, site ${op.site_id}) is already taken by a write with a different value — nothing can break the tie, write rejected`,
  );
}

/**
 * CRUD узлов и рёбер поверх оплога.
 *
 * Инвариант: любая мутация проходит через `journal()` — сначала запись в
 * oplog под UNIQUE(op_id), и только если она новая, применяется проекция.
 * Отсюда идемпотентность повтора и отсутствие расхождения между таблицами.
 */
export class GraphStore {
  readonly driver: DbDriver;
  readonly siteId: string;
  readonly actor: string;
  private readonly ops: OpFactory;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(driver: DbDriver, opts: GraphStoreOptions) {
    this.driver = driver;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId;

    const storedSite = driver.one<{ value: string }>(Q.meta_get, [
      META_SITE_ID,
    ])?.value;
    const siteId = storedSite ?? opts.siteId;
    if (siteId === undefined || siteId.length === 0) {
      throw new GraphError(
        "graph.range",
        "site_id is not set: neither in myc_meta nor in the GraphStore options",
      );
    }
    this.siteId = siteId;
    this.actor = opts.actor ?? "";

    // S3: seq монотонен на воркспейс и доступен как myc_meta.last_seq.
    // Подстраховка через оплог: myc_meta мог не пережить внешнюю правку базы,
    // а выдать второй раз тот же op_id нельзя ни при каких обстоятельствах.
    const metaSeq = Number(
      driver.one<{ value: string }>(Q.meta_get, [META_LAST_SEQ])?.value ?? 0,
    );
    const lastOwn = driver.one<{ op_id: string }>(Q.oplog_last_local_op_id, [
      siteId,
    ]);
    const logSeq = lastOwn === undefined ? 0 : seqOfOpId(lastOwn.op_id, siteId);
    this.ops = new OpFactory(siteId, {
      clock: this.seedClock(driver, siteId, opts.clock),
      lastSeq: Math.max(Number.isFinite(metaSeq) ? metaSeq : 0, logSeq),
    });
  }

  /**
   * S38: часы обязан поднимать движок, а не вызывающий. Новое соединение
   * стартует от последней своей записи в оплоге, иначе две записи одного
   * сайта в одну миллисекунду дают равную пару (hlc, site_id), и LWW молча
   * отбрасывает более позднюю. Оба чтения — хвост индекса и PK, O(log n).
   *
   * Переданные снаружи часы тоже поднимаются (через recv, как при приёме
   * чужой метки): забывший сидировать вызывающий не должен вернуть потерю.
   * Чужая запись в конце оплога подтягивает часы так же, как её сделал бы
   * applyOps в прошлом соединении — иначе следующая локальная правка
   * оказалась бы «старее» уже принятой чужой и отвалилась бы как stale.
   */
  private seedClock(
    driver: DbDriver,
    siteId: string,
    provided: HlcClock | undefined,
  ): HlcClock {
    const own = driver.one<{ hlc: string | null }>(Q.oplog_last_local_hlc, [
      siteId,
    ]);
    const ownHlc = own?.hlc == null ? undefined : readHlc(own.hlc);
    let clock: HlcClock;
    if (provided === undefined) {
      clock = new HlcClock({
        now: this.now,
        ...(ownHlc !== undefined ? { initial: ownHlc } : {}),
      });
    } else {
      clock = provided;
      if (ownHlc !== undefined && compareHlc(ownHlc, clock.state) > 0) {
        clock.recv(ownHlc);
      }
    }
    const last = driver.one<ClockRow>(Q.oplog_last_row_clock, []);
    if (last !== undefined && last.site_id !== siteId) {
      const lastHlc = readHlc(last.hlc);
      if (compareHlc(lastHlc, clock.state) > 0) clock.recv(lastHlc);
    }
    return clock;
  }



  // -------------------------------------------------------------------------
  // МОСТ К ПРИМЕНИТЕЛЮ ЯДРА
  //
  // Сами правила слияния живут в `@myc/core` (apply.ts) и написаны
  // генераторами: один алгоритм, который сервер прогонит асинхронным
  // исполнителем над Postgres. Здесь — только мост: подставить контекст
  // (кто пишет, какой сайт, чьи часы) и прогнать генератор синхронно, как
  // того требует bun:sqlite.
  //
  // Обёртки нарочно повторяют прежние сигнатуры методов: переезд алгоритма не
  // повод переписывать шестьдесят семь мест вызова внутри движка — это
  // сделало бы диф нечитаемым ровно там, где он должен читаться.
  // -------------------------------------------------------------------------

  /**
   * Состояние, которое применитель не выведет из операции. Собирается на
   * каждый вызов, а не хранится полем: `now` у движка подменяют тесты, и
   * замороженная копия врала бы им.
   */
  private applyCtx(): ApplyCtx {
    return { actor: this.actor, siteId: this.siteId, ops: this.ops, now: () => this.now() };
  }

  private syncTail(tx: DbDriver): void {
    runSync(A.syncTail(this.applyCtx()), tx);
  }

  private persistSeq(tx: DbDriver): void {
    runSync(A.persistSeq(this.applyCtx()), tx);
  }

  private journal(
    tx: DbDriver,
    op: Op,
    entity: "node" | "edge",
    entityId: string,
    scope: string,
    origin: 0 | 1,
  ): boolean {
    return runSync(A.journal(this.applyCtx(), op, entity, entityId, scope, origin), tx);
  }

  private journalLocal(tx: DbDriver, op: Op, entity: "node" | "edge", entityId: string, scope: string): void {
    runSync(A.journalLocal(this.applyCtx(), op, entity, entityId, scope), tx);
  }

  private applyOne(
    tx: DbDriver,
    op: Op,
    origin: 0 | 1,
    kindHint: ReadonlyMap<string, string>,
    tally: ApplyTally,
  ): string | undefined {
    return runSync(A.applyOne(this.applyCtx(), op, origin, kindHint, tally), tx);
  }

  private park(tx: DbDriver, op: Op, origin: 0 | 1, needs: string, tally: ApplyTally): void {
    runSync(A.park(this.applyCtx(), op, origin, needs, tally), tx);
  }

  private unpark(tx: DbDriver, opId: string, tally: ApplyTally, appliedNow: boolean): void {
    runSync(A.unpark(this.applyCtx(), opId, tally, appliedNow), tx);
  }

  private drainPending(tx: DbDriver, tally: ApplyTally): void {
    runSync(A.drainPending(this.applyCtx(), tally), tx);
  }

  private identityTouch(
    tx: DbDriver,
    field: string,
    id: string,
    tally: ApplyTally,
  ): (() => Eff<void>) | undefined {
    return A.identityTouch(this.applyCtx(), field, id, tally);
  }

  private touchContent(tx: DbDriver, id: string, tally: ApplyTally): void {
    runSync(A.touchContent(this.applyCtx(), id, tally), tx);
  }

  private touchExternal(tx: DbDriver, id: string, tally: ApplyTally): void {
    runSync(A.touchExternal(this.applyCtx(), id, tally), tx);
  }

  private settleContent(tx: DbDriver, tally: ApplyTally, local: boolean): boolean {
    return runSync(A.settleContent(this.applyCtx(), tally, local), tx);
  }

  private settleExternal(tx: DbDriver, tally: ApplyTally, local: boolean): boolean {
    return runSync(A.settleExternal(this.applyCtx(), tally, local), tx);
  }

  /**
   * Свести идентичность и, если что-то поменялось, пересчитать здоровье
   * дубликатов. Сам пересчёт остаётся ЗДЕСЬ: он читает всю базу и относится к
   * хранилищу, а не к правилам слияния.
   */
  private settleIdentity(tx: DbDriver, tally: ApplyTally, local: boolean): void {
    if (runSync(A.settleIdentity(this.applyCtx(), tally, local), tx)) {
      this.recordDuplicatesHealth(tx);
    }
  }

  private holdExternal(
    tx: DbDriver,
    g: { readonly scope: string; readonly kind: string; readonly ref: string },
    joining: ReadonlySet<string>,
  ): void {
    runSync(A.holdExternal(this.applyCtx(), g, joining), tx);
  }

  private rebalanceContent(
    tx: DbDriver,
    g: { readonly scope: string; readonly kind: string; readonly canon: string },
    tally: ApplyTally,
  ): boolean {
    return runSync(A.rebalanceContent(this.applyCtx(), g, tally), tx);
  }

  private rebalanceExternal(
    tx: DbDriver,
    g: { readonly scope: string; readonly kind: string; readonly ref: string },
    tally: ApplyTally,
  ): boolean {
    return runSync(A.rebalanceExternal(this.applyCtx(), g, tally), tx);
  }

  private materializeNode(tx: DbDriver, id: string, kind: string | undefined): boolean {
    return runSync(A.materializeNode(this.applyCtx(), id, kind), tx);
  }

  private projectEdgeAdd(
    tx: DbDriver,
    op: EdgeAddOp,
    local?: { readonly actor: string; readonly attrs: string },
  ): ProjectOutcome {
    return runSync(A.projectEdgeAdd(this.applyCtx(), op, local), tx);
  }

  private projectEdgeDel(tx: DbDriver, op: EdgeDelOp): void {
    runSync(A.projectEdgeDel(this.applyCtx(), op), tx);
  }

  private readEdgeAdds(tx: DbDriver, entityId: string): EdgeAddRow[] {
    return runSync(A.readEdgeAdds(entityId), tx);
  }

  private liveEdgeTags(tx: DbDriver, src: string, type: string, dst: string): string[] {
    return runSync(A.liveEdgeTags(src, type, dst), tx);
  }

  private reprojectEdge(
    tx: DbDriver,
    src: string,
    type: string,
    dst: string,
    adds: readonly EdgeAddRow[],
    local?: { readonly actor: string; readonly attrs: string },
  ): void {
    runSync(A.reprojectEdge(this.applyCtx(), src, type, dst, adds, local), tx);
  }

  /** Часы сайта — их skew обязан попасть в отчёт sync как degraded (S30). */
  get clock(): HlcClock {
    return this.ops.clock;
  }

  get lastSeq(): number {
    return this.ops.lastSeq;
  }

  // -------------------------------------------------------------------------
  // Чтение
  // -------------------------------------------------------------------------

  getNode(id: string, includeDeleted = false): NodeRecord | undefined {
    const row = this.driver.one<RawRow>(
      includeDeleted ? Q.node_get : Q.node_get_live,
      [id],
    );
    return row === undefined ? undefined : rowToNode(row);
  }

  listNodes(scope: string, kind: string, limit = 100): NodeRecord[] {
    return this.driver
      .all<RawRow>(Q.node_list_by_kind, [scope, assertNodeKind(kind), limit])
      .map(rowToNode);
  }

  getEdge(src: string, type: EdgeKind, dst: string): EdgeRecord | undefined {
    const row = this.driver.one<RawRow>(Q.edge_get, [
      src,
      assertEdgeKind(type),
      dst,
    ]);
    return row === undefined ? undefined : rowToEdge(row);
  }

  /** Исходящие рёбра: прямое направление, как оно и хранится. */
  edgesFrom(src: string, type?: EdgeKind): EdgeRecord[] {
    const rows =
      type === undefined
        ? this.driver.all<RawRow>(Q.edges_from, [src])
        : this.driver.all<RawRow>(Q.edges_from_typed, [
            src,
            assertEdgeKind(type),
          ]);
    return rows.map(rowToEdge);
  }

  /**
   * Входящие рёбра — это и есть обратное отношение из §4.1 (`blocked_by`,
   * `children`, `superseded_by`, …). Обратное ребро виртуально: в базе
   * всегда лежит только прямая тройка.
   */
  edgesTo(dst: string, type?: EdgeKind): EdgeRecord[] {
    const rows =
      type === undefined
        ? this.driver.all<RawRow>(Q.edges_to, [dst])
        : this.driver.all<RawRow>(Q.edges_to_typed, [
            dst,
            assertEdgeKind(type),
          ]);
    return rows.map(rowToEdge);
  }

  /** Операции с seq > since — то, что уходит по `sync --since` и в SSE (S3). */
  opsSince(seq: number, limit = 1000): OplogRow[] {
    return this.driver.all<OplogRow>(Q.oplog_since, [seq, limit]);
  }

  oplogCount(): number {
    return this.driver.one<{ n: number }>(Q.oplog_count, [])?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // Запись
  // -------------------------------------------------------------------------

  /**
   * Создать узел. Одна транзакция: записи оплога, строка узла, часы полей
   * и стартовое значение G-counter'а `seen_count`.
   *
   * `excerpt` и `content_hash` считаются здесь же, детерминированно из body
   * и title (решение S5): ретривал обязан собрать первый проход выдачи, ни
   * разу не прочитав body.
   */
  createNode(input: NodeInput): NodeRecord {
    const id = input.id ?? this.newId();
    const kind = assertNodeKind(input.kind);
    const fields = nodeInputFields(input);
    // myc-9ok: `actor` — реплицируемое поле (NODE_FIELDS), а не колонка
    // журнала. Локально строка получала this.actor без операции в оплоге,
    // и реплика материализовала узел с actor = '' — колонка расходилась
    // между машинами. Ровно одна set-операция на узел, как у любого поля.
    if (!fields.some(([field]) => field === "actor")) {
      fields.push(["actor", this.actor]);
    }
    const ts = this.now();
    const scope = String(input.scope ?? "");

    const columns = new Map<string, string | number | null>();
    const attrs: Record<string, JsonValue> = {};
    for (const [field, value] of fields) {
      const key = attrKeyOf(field);
      if (key !== undefined) {
        attrs[key] = value;
        continue;
      }
      const spec = assertNodeField(field);
      if (spec === "attr") continue;
      columns.set(field, coerceNodeFieldValue(spec, value));
    }

    const title = String(columns.get("title") ?? "");
    const body = (columns.get("body") ?? null) as string | null;

    const row: Record<string, unknown> = {
      id,
      kind,
      layer: columns.get("layer"),
      scope,
      title,
      body,
      body_cold: 0,
      excerpt: makeExcerpt(body),
      status: columns.get("status"),
      priority: columns.get("priority") ?? 2,
      confidence: columns.get("confidence") ?? 1.0,
      salience: columns.get("salience") ?? 1.0,
      seen_count: 1,
      head_id: columns.get("head_id") ?? null,
      content_hash: contentHash(kind, title, body),
      acl: columns.get("acl") ?? "team",
      owner_id: columns.get("owner_id") ?? "",
      team_id: columns.get("team_id") ?? "",
      agent_id: columns.get("agent_id") ?? "",
      assignee: columns.get("assignee") ?? "",
      actor: columns.get("actor") ?? this.actor,
      created_at: ts,
      updated_at: ts,
      accessed_at: 0,
      due_at: columns.get("due_at") ?? null,
      closed_at: columns.get("closed_at") ?? null,
      compacted_at: null,
      deleted_at: null,
      hlc: 0,
      site_id: this.siteId,
      attrs: JSON.stringify(attrs),
    };

    return this.driver.tx("immediate", (tx) => {
      // Операции минтятся под блокировкой записи (myc-4dy), не раньше.
      this.syncTail(tx);
      const setOps = fields.map(([field, value]) =>
        this.ops.set(id, field, value),
      );
      const incOp = this.ops.inc(id, "seen_count", 1);
      row.hlc = packHlc(setOps[0]!.hlc);
      const bound = NODE_INSERT_COLUMNS.map((c) => row[c] ?? null);

      for (const op of setOps) this.journalLocal(tx, op, "node", id, scope);
      this.journalLocal(tx, incOp, "node", id, scope);
      // Новый узел рождается держателем (ext_dup = '') и держится правилом
      // одним UNIQUE. Группа без держателя (holdExternal) его бы пропустила:
      // сначала ссылка достаётся её старшему живому члену.
      const ref = attrs["external_ref"];
      if (typeof ref === "string") this.holdExternal(tx, { scope, kind, ref }, NO_IDS);
      tx.run(Q.node_insert, bound);

      for (const op of setOps) {
        tx.run(Q.field_clock_set, [
          id,
          op.field,
          packHlc(op.hlc),
          op.site_id,
        ]);
      }
      tx.run(Q.counter_set, [id, "seen_count", this.siteId, 1]);
      // memory-nvx51d0kgf2t: узел с явным id мог быть нужен отложенной чужой
      // операции. Её зависимость выполнена здесь и сейчас, а не «когда-нибудь
      // при следующем applyOps» — пустая таблица стоит одного спуска.
      if (tx.one(Q.pending_any, []) !== undefined) {
        const tally = newTally();
        tally.pendingKnown = true;
        this.drainPending(tx, tally);
        this.settleIdentity(tx, tally, false);
      }
      this.persistSeq(tx);

      const created = tx.one<RawRow>(Q.node_get, [id]);
      if (created === undefined) {
        throw new GraphError("graph.not_found", `node ${id} was not written`);
      }
      return rowToNode(created);
    });
  }

  /**
   * Обновить узел. В оплог уходят только реально изменившиеся поля: запись
   * «то же значение» не несёт информации, но стоит строки в оплоге и сдвига
   * часов поля, из-за которого чужая правка потом молча проиграет LWW.
   */
  updateNode(id: string, patch: NodePatch): NodeRecord {
    const current = this.getNode(id, true);
    if (current === undefined) {
      throw new GraphError("graph.not_found", `node ${id} not found`);
    }
    const kind = assertNodeKind(current.kind);
    const changed = nodePatchFields(kind, patch).filter(([field, value]) => {
      const key = attrKeyOf(field);
      if (key !== undefined) {
        return JSON.stringify(current.attrs[key]) !== JSON.stringify(value);
      }
      return (current as unknown as Record<string, unknown>)[field] !== value;
    });
    if (changed.length === 0) return current;

    this.applyLocal(
      () => changed.map(([field, value]) => this.ops.set(id, field, value)),
      id,
      current.scope,
    );
    const after = this.getNode(id, true);
    if (after === undefined) {
      throw new GraphError("graph.not_found", `node ${id} vanished during the write`);
    }
    return after;
  }

  /**
   * Мягкое удаление: одно LWW-поле `deleted_at`. Строка остаётся — на неё
   * ссылаются рёбра и оплог, а FTS-строку снимает триггер trg_fts_au.
   */
  deleteNode(id: string, at?: number): boolean {
    const current = this.getNode(id, true);
    if (current === undefined || current.deleted_at !== null) return false;
    this.applyLocal(
      () => [this.ops.set(id, "deleted_at", at ?? this.now())],
      id,
      current.scope,
    );
    return true;
  }

  /** Обратная операция: узел снова виден. */
  restoreNode(id: string): boolean {
    const current = this.getNode(id, true);
    if (current === undefined || current.deleted_at === null) return false;
    this.applyLocal(() => [this.ops.set(id, "deleted_at", null)], id, current.scope);
    return true;
  }

  /**
   * G-counter: подтверждение факта (§2.2, `seen_count`). В оплог уходит новое
   * накопленное значение ЭТОГО сайта, колонка пересчитывается как сумма по
   * всем сайтам — сложение остаётся идемпотентным и коммутативным.
   */
  bumpCounter(id: string, field: string, delta = 1): number {
    if (!Number.isInteger(delta) || delta <= 0) {
      throw new GraphError(
        "graph.range",
        `G-counter increment must be a positive integer, got ${delta}`,
      );
    }
    const current = this.getNode(id, true);
    if (current === undefined) {
      throw new GraphError("graph.not_found", `node ${id} not found`);
    }
    // Накопленное значение сайта читается под той же блокировкой, что и
    // запись: соседний процесс того же site_id мог поднять его между чтением
    // и записью, и поэлементный максимум G-counter'а потерял бы его дельту.
    this.applyLocal(
      (tx) => {
        const mine =
          tx.one<{ value: number }>(Q.counter_get, [id, field, this.siteId])
            ?.value ?? 0;
        return [this.ops.inc(id, field, mine + delta)];
      },
      id,
      current.scope,
    );
    return (
      this.driver.one<{ total: number }>(Q.counter_sum, [id, field])?.total ?? 0
    );
  }

  /**
   * Добавить ребро. Тип обязан быть одним из одиннадцати (§4.1); семантика
   * типов не взаимозаменяема, поэтому подстановки «похожего» типа здесь нет.
   *
   * Ацикличность (§4.3) проверяется ЗДЕСЬ, до записи в оплог, и по-разному у
   * двух ацикличных типов: `parent` ловится замыканием внутри
   * `applyParentEdgeAdd` (у него есть таблица `parent_closure`), `blocks` —
   * обходом с пределом глубины (cycle.ts), потому что транзитивной таблицы
   * у него нет. Оба отказа бросают до `journalLocal`/`projectEdgeAdd`, то
   * есть транзакция не оставляет следа ни в проекции, ни в оплоге.
   *
   * Чужие операции (`applyOps`) сюда не заходят и проверке не подлежат:
   * §4.3 требует цикл, собранный мержем, помечать, а не отвергать.
   */
  addEdge(
    src: string,
    type: EdgeKind,
    dst: string,
    opts: AddEdgeOptions = {},
  ): EdgeRecord {
    const edgeType = assertEdgeKind(type);
    assertEdgeEndpoints(src, dst);
    const source = this.getNode(src, true);
    if (source === undefined) {
      throw new GraphError("graph.not_found", `src node ${src} not found`);
    }
    if (this.getNode(dst, true) === undefined) {
      throw new GraphError("graph.not_found", `dst node ${dst} not found`);
    }
    const entityId = edgeEntityId(src, edgeType, dst);
    const attrs = JSON.stringify(opts.attrs ?? {});

    this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      // `parent` проверяется ниже, замыканием: там факт «dst уже потомок src»
      // стоит один спуск по parent_closure, а обход был бы лишней работой.
      if (EDGE_SEMANTICS[edgeType].acyclic && edgeType !== "parent") {
        checkEdgeAcyclic(tx, src, edgeType, dst, EDGE_SEMANTICS[edgeType].maxDepth);
      }
      const op = this.ops.edgeAdd(src, edgeType, dst, opts.weight);
      this.journalLocal(tx, op, "edge", entityId, source.scope);
      if (this.projectEdgeAdd(tx, op, { actor: this.actor, attrs }) === "collided") {
        throw collisionError(op, entityId);
      }
      if (edgeType === "parent") this.applyParentEdgeAdd(tx, src, dst);
      this.persistSeq(tx);
    });

    const created = this.getEdge(src, edgeType, dst);
    if (created === undefined) {
      throw new GraphError("graph.not_found", `edge ${entityId} was not written`);
    }
    return created;
  }

  /**
   * Мягкое удаление ребра. В операцию попадают ВСЕ теги, живые в базе НА
   * МОМЕНТ удаления, — добавления, которых этот сайт не видел, переживут
   * удаление. Это add-wins из OR-Set, а не «удалить всё, что похоже».
   * Прежде уходил один тег представителя: второе живое добавление, уже
   * увиденное этим сайтом, удаление переживало, и ребро воскресало на
   * реплике, применившей операции в другом порядке (memory-86eqge02q8rd).
   * Теги читаются под блокировкой записи: соседний процесс мог добавить.
   */
  removeEdge(src: string, type: EdgeKind, dst: string): boolean {
    const edgeType = assertEdgeKind(type);
    const edge = this.getEdge(src, edgeType, dst);
    if (edge === undefined || edge.deleted_at !== null) return false;
    const scope = this.getNode(src, true)?.scope ?? "";
    const entityId = edgeEntityId(src, edgeType, dst);

    // Правила — в ядре (A.applyLocalEdgeDel): все живые теги в операцию
    // (add-wins), гашение проекции и поддержка замыкания у `parent`.
    return this.driver.tx("immediate", (tx) =>
      runSync(A.applyLocalEdgeDel(this.applyCtx(), src, edgeType, dst, scope), tx),
    );
  }

  /**
   * Материализовать parent_closure для addEdge(type='parent') внутри той же
   * транзакции. `dst` уже прямой родитель `src` — переигранное (OR-Set) или
   * дублирующее добавление того же ребра, замыкание уже верное, трогать
   * нечего. Другой прямой родитель есть — это перенос поддерева одним
   * публичным вызовом: старое ребро `child→current` обязано погаснуть на
   * уровне edges/oplog в той же транзакции (иначе у ребёнка осталось бы два
   * живых родительских ребра, и `rebuildParentClosure` разошёлся бы с
   * `applyParentMove`), а замыкание переносится одним вызовом
   * applyParentMove, а не парой insert/remove — см. докстрок applyParentMove
   * в closure.ts про то, почему это не два отдельных шага.
   */
  private applyParentEdgeAdd(tx: DbDriver, child: string, parent: string): void {
    const current = ancestorsOf(tx, child).find((a) => a.depth === 1)?.ancestor;
    if (current === parent) return;
    if (current === undefined) {
      applyParentInsert(tx, child, parent);
      return;
    }
    const oldEdge = tx.one<EdgeClockRow>(Q.edge_clock_get, [child, "parent", current]);
    const oldTags = oldEdge?.deleted_at === null ? this.liveEdgeTags(tx, child, "parent", current) : [];
    if (oldTags.length > 0) {
      const scope = tx.one<NodeHeadRow>(Q.node_head, [child])?.scope ?? "";
      const delOp = this.ops.edgeDel(child, "parent", current, oldTags);
      const oldEntityId = edgeEntityId(child, "parent", current);
      this.journalLocal(tx, delOp, "edge", oldEntityId, scope);
      this.projectEdgeDel(tx, delOp);
    }
    applyParentMove(tx, child, parent);
  }

  /**
   * Симметрично applyParentEdgeAdd для removeEdge(type='parent'). `parent` не
   * прямой родитель `child` в замыкании — либо ребро уже небыло материализовано
   * (не должно случаться при консистентном состоянии), либо это тумбстоун
   * старого add_tag поверх edge, который add-wins уже пережил; в обоих случаях
   * замыкание не трогаем, чтобы не снести чужой живой parent.
   */
  private applyParentEdgeRemove(tx: DbDriver, child: string, parent: string): void {
    const current = ancestorsOf(tx, child).find((a) => a.depth === 1)?.ancestor;
    if (current !== parent) return;
    applyParentRemove(tx, child, parent);
  }

  // -------------------------------------------------------------------------
  // Приём чужих операций
  // -------------------------------------------------------------------------

  /**
   * Применить пакет операций (пришедших по sync или перечитанных из оплога).
   *
   * Порядок внутри пакета — по (hlc, site_id) возрастанию (§9.3); каузальная
   * доставка не требуется: LWW, OR-Set и G-counter коммутативны. Часы
   * подтягиваются через recv, который зажимает съехавшую метку порогом,
   * а не отвергает операцию (решение S30).
   *
   * Порядок МЕЖДУ пакетами не гарантирован в принципе (myc-qie.9): ребро
   * может приехать раньше своих концов, `set(title)` — раньше `set(kind)`.
   * Такая операция не падает и не теряется: она паркуется в oplog_pending
   * с именем недостающего узла и применяется в первой транзакции, где этот
   * узел уже есть, — как бы он ни появился (memory-nvx51d0kgf2t). Итог не
   * зависит от нарезки на пакеты: тот же набор операций в любом порядке
   * даёт то же состояние, что и упорядоченный.
   *
   * Контент-дубликат одного узла не роняет пакет (memory-0fs4rfa6xmha): он
   * разрешается детерминированно и попадает в `duplicates`.
   */
  applyOps(ops: readonly Op[], origin: 0 | 1 = 0): ApplyResult {
    // Транзакция — дело хранилища (у SQLite это BEGIN IMMEDIATE), правила —
    // дело ядра. Здоровье дубликатов пересчитывается здесь же: оно читает всю
    // базу и к правилам слияния не относится.
    const result = this.driver.tx("immediate", (tx) => {
      const r = runSync(A.applyOps(this.applyCtx(), ops, origin), tx);
      if (r.settled) this.recordDuplicatesHealth(tx);
      return r;
    });
    const { settled: _settled, ...rest } = result;
    return rest;
  }





  /**
   * Сколько операций ждёт своих зависимостей — для doctor и sync (И2).
   * Честно: уже журналированная операция не ждёт ничего, даже если её
   * строка ожидания пережила применение.
   */
  pendingCount(): number {
    return this.driver.one<{ n: number }>(Q.pending_count, [])?.n ?? 0;
  }

  /** Отложенные операции с именем недостающего узла. */
  pendingOps(limit = 1000): Array<{ readonly op: Op; readonly needs: string; readonly origin: 0 | 1 }> {
    return this.driver.all<PendingRow>(Q.pending_list, [limit]).map((row) => ({
      op: JSON.parse(row.op) as Op,
      needs: row.needs,
      origin: row.origin === 1 ? 1 : 0,
    }));
  }

  /**
   * Живые контент-дубликаты с их каноническим узлом (memory-0fs4rfa6xmha) —
   * для doctor и web. Пусто ⇒ дубликатов нет. Полный проход по nodes: это
   * диагностика, не горячий путь.
   */
  contentDuplicates(): Array<{ readonly id: string; readonly of: string; readonly scope: string; readonly kind: string }> {
    return this.driver.all(Q.content_duplicates, []);
  }

  /**
   * Живые ввезённые дубликаты с их держателем ссылки (memory-gemeb3d8wj41) —
   * для doctor и web. `ref` назван явно: две машины, ввёзшие одну запись
   * beads, — это вопрос к источнику, и человеку нужен именно его id.
   */
  externalDuplicates(): Array<{
    readonly id: string;
    readonly of: string;
    readonly scope: string;
    readonly kind: string;
    readonly ref: string;
  }> {
    return this.driver.all(Q.external_duplicates, []);
  }

  /**
   * Пересчитать open_blockers по рёбрам и статусам. Триггеры ведут счётчик
   * при мягких мутациях; жёсткое удаление (purge, ON DELETE CASCADE) ими
   * не покрыто by design, и после него счётчик восстанавливается отсюда.
   * Возвращает число узлов, у которых он до пересчёта расходился.
   */
  recountOpenBlockers(): number {
    return this.driver.tx("immediate", (tx) => {
      // Оба расхождения меряются ДО любого ремонта: пересчёт open_blockers
      // пересекает нули и будит trg_anc_*, и замер после него не увидел бы
      // наследованного расхождения вовсе.
      const drift = tx.all<{ id: string }>(Q.open_blockers_drift, []).length;
      const ancDrift = tx.all<{ id: string }>(Q.anc_blockers_drift, []).length;
      tx.run(Q.recount_open_blockers, []);
      // Наследование пишется ПОСЛЕ и в той же транзакции: оно читает уже
      // исправленные open_blockers предков и перезаписывает счётчик целиком,
      // а не досчитывает то, что успели натворить триггеры.
      tx.run(Q.recount_anc_blockers, []);
      return drift + ancDrift;
    });
  }

  /** Узлы, у которых счётчик разошёлся с пересчётом. Пусто ⇒ сходится. */
  openBlockersDrift(): Array<{ id: string; stored: number; actual: number }> {
    return this.driver.all(Q.open_blockers_drift, []);
  }

  /**
   * То же для наследованного счётчика (миграция 10): узлы, у которых
   * `anc_blockers` разошёлся с пересчётом по `parent_closure`. Пусто ⇒ сходится.
   */
  ancBlockersDrift(): Array<{ id: string; stored: number; actual: number }> {
    return this.driver.all(Q.anc_blockers_drift, []);
  }

  /**
   * Предки узла по `parent`, держащие открытый блокер, ближний первым.
   * Ровно те, из-за кого `anc_blockers > 0` и задача не в очереди.
   */
  blockingAncestors(
    id: string,
  ): Array<{ id: string; title: string; status: string; open_blockers: number; depth: number }> {
    return this.driver.all(Q.anc_blocking, [id]);
  }

  // -------------------------------------------------------------------------
  // Claim: атомарный захват задачи (§9.4, решение S35)
  //
  // Lease-поля не входят в NODE_FIELDS и не идут через per-field LWW:
  // взаимное исключение — не LWW-задача, офлайновый агент с более поздними
  // часами не должен «украсть» задачу. Роль LWW здесь играет CAS-предикат
  // в одном UPDATE плюс монотонный lease_epoch. Операции не теряют оплог:
  // каждая пишется строкой op='claim' (CHECK в DDL разрешает этот kind),
  // значение — {action, holder, epoch, expires}. Проекция чужих claim-операций
  // при синхронизации — правило merge_claim (§9.4), отдельная задача sync.
  // -------------------------------------------------------------------------

  /**
   * Захватить задачу. Один стейтмент: условие и запись атомарны, между
   * чтением и записью окна нет. CAS сначала, journal после: проигравший гонку
   * не должен оставить строку в оплоге, а внутри одной BEGIN IMMEDIATE обе
   * записи коммитятся атомарно — половинчатого состояния не бывает.
   * `undefined` — задачу забрали (или она не открыта): брать следующую из ready.
   */
  claimNode(id: string, holder?: string, ttlMs: number = LEASE_TTL_MS): ClaimReceipt | undefined {
    // Правило (CAS, эпоха, строка оплога) — в ядре: задачи берут и агенты
    // через CLI, и люди через сервер, и «кто успел» обязано решаться одинаково.
    const who = holder ?? this.actor;
    return this.driver.tx("immediate", (tx) =>
      runSync(A.claimNode(this.applyCtx(), id, who, ttlMs), tx),
    );
  }

  /**
   * Продлить аренду. Пишет только текущий держатель с текущей эпохой:
   * воскресший держатель (пока он спал, задачу успели перезахватить и эпоха
   * ушла вперёд) получает `undefined` и не продлевает ничего.
   */
  renewLease(
    id: string,
    holder: string,
    epoch: number,
    ttlMs: number = LEASE_TTL_MS,
  ): number | undefined {
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const meta = this.ops.set(id, "lease", { action: "renew", holder, epoch });
      const expiresAt = meta.hlc.ts + ttlMs;
      const row = tx.one<{ scope: string }>(Q.lease_renew, [
        id,
        holder,
        epoch,
        expiresAt,
        meta.hlc.ts,
        packHlc(meta.hlc),
        this.siteId,
      ]);
      if (row === undefined) return undefined;
      this.journalClaim(tx, meta, id, row.scope, "renew", holder, epoch, expiresAt);
      this.persistSeq(tx);
      return expiresAt;
    });
  }

  /**
   * Явное освобождение: задача возвращается в open с пустым lease. Как и
   * продление — только у текущего держателя с текущей эпохой.
   */
  releaseLease(id: string, holder: string, epoch: number): boolean {
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const meta = this.ops.set(id, "lease", { action: "release", holder, epoch });
      const row = tx.one<{ scope: string }>(Q.lease_release, [
        id,
        holder,
        epoch,
        meta.hlc.ts,
        packHlc(meta.hlc),
        this.siteId,
      ]);
      if (row === undefined) return false;
      this.journalClaim(tx, meta, id, row.scope, "release", holder, epoch, 0);
      this.persistSeq(tx);
      return true;
    });
  }

  /**
   * Закрыть взятую задачу: status='closed' (шкала статусов task, §2.2) плюс
   * очистка lease одним CAS-стейтментом. Задача, перехваченная другим агентом,
   * у воскресшего держателя не закроется — эпоха уже не его.
   *
   * memory-tvw65jjgaheh: закрытие — не аренда, а конец задачи, и обязано
   * доехать до реплик. Строка op='claim' локальна (не реплицируется, см.
   * REPLICATED_OPS), а CAS писал status и closed_at мимо field_clock. Итог:
   * на другой машине задача оставалась open и бралась в работу повторно, а
   * здесь любая чужая правка статуса, старшая записи создания, молча
   * переписывала 'closed'. Поэтому в той же транзакции закрытие выражается
   * обычными LWW-записями — status, closed_at и assignee (кто закрыл; claim
   * писал его в колонку без операции) — и реплицируется как любая правка.
   */
  closeClaimed(id: string, holder: string, epoch: number): boolean {
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const meta = this.ops.set(id, "lease", { action: "close", holder, epoch });
      const row = tx.one<{ scope: string }>(Q.lease_close, [
        id,
        holder,
        epoch,
        meta.hlc.ts,
        meta.hlc.ts,
        packHlc(meta.hlc),
        this.siteId,
      ]);
      if (row === undefined) return false;
      this.journalClaim(tx, meta, id, row.scope, "close", holder, epoch, 0);
      this.expressClose(tx, id, row.scope, meta.hlc.ts, holder);
      this.persistSeq(tx);
      return true;
    });
  }

  /**
   * Закрытие как LWW-записи: status='closed', closed_at, assignee. Операции
   * минтятся здесь, под той же блокировкой записи (myc-4dy).
   */
  private expressClose(
    tx: DbDriver,
    id: string,
    scope: string,
    closedAt: number,
    holder: string,
  ): void {
    const sets: SetOp[] = [
      this.ops.set(id, "status", "closed"),
      this.ops.set(id, "closed_at", closedAt),
    ];
    if (holder.length > 0) sets.push(this.ops.set(id, "assignee", holder));
    for (const op of sets) {
      this.journalLocal(tx, op, "node", id, scope);
      if (runSync(projectSet(op), tx) === "collided") throw collisionError(op, id);
    }
  }

  /**
   * Бэкфилл закрытий, журналированных до правки memory-tvw65jjgaheh только
   * строкой op='claim': такие закрытия не доехали ни до одной реплики. Для
   * каждого узла, где последнее закрытие через claim новее любой LWW-записи
   * статуса (см. Q.claim_close_unexpressed), закрытие выражается сейчас —
   * теми же тремя set, что пишет closeClaimed; closed_at и assignee берутся
   * из самой строки claim. Часы у новых операций свежие, а не часы исходного
   * закрытия: выдать старую метку под новым seq значило бы сломать
   * инвариант «seq и hlc сайта растут вместе» (восстановление seq из хвоста
   * оплога). Цена — окно: чужая правка статуса, сделанная между исходным
   * закрытием и бэкфиллом и ещё не импортированная сюда, проиграет ему.
   *
   * Идемпотентно: после бэкфилла field_clock статуса новее строки claim,
   * второй вызов не находит ничего. `ids` — ограничить узлами (переезд).
   * Возвращает узлы, чьи закрытия выражены.
   */
  backfillClaimCloses(ids?: readonly string[]): string[] {
    const only = ids === undefined ? undefined : new Set(ids);
    const pick = (rows: readonly ClaimCloseRow[]): ClaimCloseRow[] =>
      only === undefined ? [...rows] : rows.filter((r) => only.has(r.id));
    if (pick(this.driver.all<ClaimCloseRow>(Q.claim_close_unexpressed, [])).length === 0) return [];
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      // Перечитать под блокировкой: соседний процесс мог успеть сам.
      const rows = pick(tx.all<ClaimCloseRow>(Q.claim_close_unexpressed, []));
      const done: string[] = [];
      for (const row of rows) {
        let holder = "";
        try {
          const v = JSON.parse(row.value) as { holder?: unknown };
          if (typeof v.holder === "string") holder = v.holder;
        } catch {
          // значение строки claim битое — закрываем без assignee
        }
        this.expressClose(tx, row.id, row.scope, row.ts_ms, holder);
        done.push(row.id);
      }
      this.persistSeq(tx);
      return done;
    });
  }

  /**
   * Пересобрать строки всех рёбер из множества OR-Set (оплог + тумбстоуны) —
   * ремонт реплик, разошедшихся при прежней проекции (memory-86eqge02q8rd).
   * Новые операции чинят только свой ключ; ключ, который больше никто не
   * тронет, остался бы разошедшимся навсегда — дедупликация по op_id
   * переиграть его не даст. Одна транзакция, полный проход по edges: это
   * ремонт (doctor), не горячий путь. open_blockers ведут триггеры на
   * deleted_at. Возвращает, сколько строк отличалось от пересчёта.
   */
  reprojectEdges(): number {
    return this.driver.tx("immediate", (tx) => {
      tx.run(Q.meta_set, [META_EDGES_REPROJECTED, "1"]);
      const before = tx.all<EdgeRowState>(Q.edges_state, []);
      for (const e of before) {
        this.reprojectEdge(tx, e.src, e.type, e.dst, this.readEdgeAdds(tx, edgeEntityId(e.src, e.type, e.dst)));
      }
      const after = new Map(
        tx.all<EdgeRowState>(Q.edges_state, []).map((e) => [`${e.src}|${e.type}|${e.dst}`, JSON.stringify(e)]),
      );
      let changed = 0;
      for (const e of before) {
        if (after.get(`${e.src}|${e.type}|${e.dst}`) !== JSON.stringify(e)) changed++;
      }
      return changed;
    });
  }

  /**
   * Одноразовый ремонт (см. reprojectEdges) для базы, где он ещё не шёл:
   * флаг в myc_meta, не миграция схемы. Зовёт importGraph — точка, где
   * реплика и так сверяется с остальными. `undefined` — ремонт уже был.
   */
  reprojectEdgesOnce(): number | undefined {
    if (this.driver.one<{ value: string }>(Q.meta_get, [META_EDGES_REPROJECTED])?.value === "1") {
      return undefined;
    }
    return this.reprojectEdges();
  }

  /** Срез lease-состояния. Для наблюдения; решения о захвате принимает только CAS. */
  leaseOf(id: string): NodeLease | undefined {
    return this.driver.one(Q.lease_get, [id]);
  }

  /**
   * Оплог-запись lease-мутации — тот же oplog_insert, что у journal(), но с
   * op='claim': lease-поля вне NODE_FIELDS, отдельного типа Op у них нет до
   * задачи sync (rowToOp на 'claim' падает намеренно). Дедуп по op_id здесь
   * недостижим (seq выделен под блокировкой записи от хвоста, syncTail),
   * поэтому changes != 1 — коллизия часов, транзакция откатывается целиком.
   */
  private journalClaim(
    tx: DbDriver,
    meta: SetOp,
    entityId: string,
    scope: string,
    action: ClaimAction,
    holder: string,
    epoch: number,
    expires: number,
  ): void {
    const inserted = tx.run(Q.oplog_insert, [
      meta.op_id,
      meta.site_id,
      packHlc(meta.hlc),
      meta.hlc.ts,
      this.actor,
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

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------



  /**
   * Одна транзакция на пакет локальных операций над одним узлом. Операции
   * минтит `mint` уже внутри транзакции — после syncTail, иначе их op_id и
   * hlc могли оказаться занятыми соседним процессом (myc-4dy).
   */
  private applyLocal(
    mint: (tx: DbDriver) => readonly Op[],
    entityId: string,
    scope: string,
  ): void {
    this.driver.tx("immediate", (tx) => {
      const settled = runSync(
        A.applyLocalOps(this.applyCtx(), () => mint(tx), entityId, scope, (op) =>
          collisionError(op, entityId),
        ),
        tx,
      );
      if (settled) this.recordDuplicatesHealth(tx);
    });
  }







  // -------------------------------------------------------------------------
  // Контент-дубликаты (memory-0fs4rfa6xmha)
  //
  // ux_nodes_content запрещает два живых узла с одним (scope, kind,
  // content_hash). Локально это правило верно и остаётся: createNode и правка
  // текста в дубликат по-прежнему падают. Но два сайта вправе НЕЗАВИСИМО
  // записать один и тот же текст (два агента запомнили один факт, два якоря
  // на одном участке кода), и мерж CRDT не может такую пару отвергнуть.
  // Раньше refreshDerived упирался в UNIQUE и откатывал весь пакет, а каждая
  // следующая синхронизация падала тем же исключением.
  //
  // Правило (одно на всех репликах): в группе живых узлов одного канона
  // канонический content_hash держит СТАРШИЙ — по часам set(kind), то есть по
  // моменту создания, при равенстве по id; остальные держат пониженный
  // `<канон>:<id>`. content_hash — производная, не реплицируемое поле, так
  // что понижение ничего не пишет в оплог и не трогает данных узла. Уходит
  // победитель (удалён, правлен, переехал) — канон переходит к следующему.
  // -------------------------------------------------------------------------






  // -------------------------------------------------------------------------
  // Ввезённые дубликаты (memory-gemeb3d8wj41)
  //
  // Ровно тот же класс, что контент-дубликат выше, и разводится тем же
  // правилом — но понижать здесь нечего. Ключ ux_nodes_content, content_hash,
  // производный: его можно заменить на `<канон>:<id>`, ничего не сказав
  // оплогу. Ключ ux_nodes_external — сама `attrs.external_ref`, значение
  // РЕПЛИЦИРУЕМОЕ: подменив его, мы соврали бы о том, какую запись источника
  // представляет узел, и разослали бы эту ложь дальше. Поэтому миграция 13
  // завела производную колонку-разрешитель `ext_dup` — четвёртую в индексе:
  // '' у держателя ссылки, собственный id у понижённого.
  //
  // Правило (одно на всех репликах): в группе живых узлов одной ссылки
  // (scope, kind, external_ref) ссылку держит СТАРШИЙ — по часам set(kind),
  // при равенстве по id; остальные понижены. Уходит держатель (удалён,
  // сменил scope или ссылку) — ссылка переходит к следующему.
  // -------------------------------------------------------------------------





  /**
   * myc_health 'sync.duplicates': сколько живых узлов сейчас понижено — по
   * содержимому и по внешней ссылке. Компонент один на оба случая: человек
   * читает одно число «столько узлов повторяют чужую идентичность», а чем
   * именно — говорят detail и списки contentDuplicates/externalDuplicates.
   */
  private recordDuplicatesHealth(tx: DbDriver): void {
    const content = tx.one<{ n: number }>(Q.content_duplicates_count, [])?.n ?? 0;
    const external = tx.one<{ n: number }>(Q.external_duplicates_count, [])?.n ?? 0;
    const n = content + external;
    const why: string[] = [];
    if (content > 0) {
      why.push(
        `${content} ${content === 1 ? "node repeats" : "nodes repeat"} another node's kind, title and body in the same scope ` +
          "(written independently on two sites); the older node keeps the canonical content_hash",
      );
    }
    if (external > 0) {
      why.push(
        `${external} imported ${external === 1 ? "node repeats" : "nodes repeat"} another node's attrs.external_ref ` +
          "(the same source record imported on two machines); the older node holds the reference",
      );
    }
    tx.run(Q.health_set, [
      "sync.duplicates",
      n > 0 ? "degraded" : "ok",
      why.join("; "),
      this.now(),
      JSON.stringify({ duplicates: n, content, external }),
    ]);
  }

}

/** Строка оплога обратно в операцию — вход merge() и sync. */
export function rowToOp(row: OplogRow): Op {
  const hlc = readHlc(row.hlc);
  const seq = Number(row.op_id.slice(row.site_id.length + 1));
  const value = row.value === null ? null : (JSON.parse(row.value) as JsonValue);
  const entityId =
    row.entity === "edge"
      ? (() => {
          const e = parseEdgeEntityId(row.entity_id);
          return [e.src, e.type, e.dst].join(MEMORY_EDGE_SEPARATOR);
        })()
      : row.entity_id;
  const base = {
    op_id: row.op_id,
    seq: Number.isFinite(seq) ? seq : 0,
    hlc,
    site_id: row.site_id,
    entity_id: entityId,
    field: row.field ?? "",
  };

  switch (row.op) {
    case "set":
      return { ...base, op: "set", value } as SetOp;
    case "inc":
      return { ...base, op: "inc", value: Number(value) } as IncOp;
    case "edge_add":
      return {
        ...base,
        op: "edge_add",
        value: value as { tag: string; weight?: number },
      } as EdgeAddOp;
    case "edge_del":
      return {
        ...base,
        op: "edge_del",
        value: value as { tags: string[] },
      } as EdgeDelOp;
    default:
      throw new GraphError(
        "graph.unknown_field",
        `operation '${row.op}' does not project into an Op: claim and purge are separate tasks`,
      );
  }
}
