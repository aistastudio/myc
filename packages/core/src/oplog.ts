/**
 * Оплог: гибридные логические часы, per-field LWW, add-wins OR-Set, G-counter.
 *
 * Чистая логика без SQL. Персистентность (таблицы oplog / field_clock /
 * counters / edge_tombstones) подключается отдельно; здесь только то, что
 * должно сходиться между сайтами. Спека: docs/design/01-core-data-model.md §9.
 *
 * Два разных порядка, которые нельзя путать:
 *   - `seq`  — ЛОКАЛЬНЫЙ монотонный номер записи на воркспейс. На нём висят
 *              инвалидация кешей, Last-Event-ID в SSE и `sync --since`.
 *              Между сайтами seq несравним.
 *   - `hlc`  — порядок для разрешения конфликтов. Сравнение всегда по паре
 *              (hlc, site_id): site_id — детерминированный разрыв ничьей.
 */

// ---------------------------------------------------------------------------
// HLC
// ---------------------------------------------------------------------------

/** Гибридные логические часы: физическое время в мс и счётчик внутри мс. */
export interface Hlc {
  readonly ts: number;
  readonly ctr: number;
}

/** 16 бит на счётчик (§9.2). */
export const HLC_CTR_MAX = 0xffff;
/** 48 бит на физическое время (§9.2). */
export const HLC_TS_MAX = 2 ** 48 - 1;
/** Порог расхождения чужих часов, после которого операция отвергается. */
/**
 * Порог расхождения чужих часов — docs/design/01-core-data-model.md §9.2.
 * При превышении операция ВСЁ РАВНО принимается, но наши часы не подтягиваются
 * за чужими дальше порога, а расхождение попадает в отчёт как громкая
 * деградация (инвариант И2). Отказ здесь был бы хуже: отвергнутая операция —
 * это расхождение реплик, которое уже никогда не срастётся само.
 */
export const HLC_MAX_SKEW_MS = 300_000;

export class ClockSkewError extends Error {
  readonly remoteTs: number;
  readonly localTs: number;
  readonly skewMs: number;

  constructor(remoteTs: number, localTs: number, maxSkewMs: number) {
    const skewMs = remoteTs - localTs;
    super(
      `peer clock is ${skewMs} ms ahead of local (limit ${maxSkewMs} ms); ` +
        `refusing to accept: this is a broken clock, not a slow network`,
    );
    this.name = "ClockSkewError";
    this.remoteTs = remoteTs;
    this.localTs = localTs;
    this.skewMs = skewMs;
  }
}

export class HlcOverflowError extends Error {
  constructor(ts: number) {
    super(`HLC counter overflow at ts=${ts}: more than ${HLC_CTR_MAX + 1} ops in one ms`);
    this.name = "HlcOverflowError";
  }
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.ctr !== b.ctr) return a.ctr < b.ctr ? -1 : 1;
  return 0;
}

/**
 * Порядок разрешения конфликтов: (hlc, site_id). site_id сравнивается
 * лексикографически по кодовым единицам, без локали — одинаково на всех машинах.
 */
export function compareClock(
  aHlc: Hlc,
  aSite: string,
  bHlc: Hlc,
  bSite: string,
): number {
  const c = compareHlc(aHlc, bHlc);
  if (c !== 0) return c;
  if (aSite === bSite) return 0;
  return aSite < bSite ? -1 : 1;
}

/** Упаковка в 64-битное целое `(ts_ms << 16) | counter` (§9.2). */
export function packHlc(h: Hlc): bigint {
  return (BigInt(h.ts) << 16n) | BigInt(h.ctr);
}

export function unpackHlc(packed: bigint): Hlc {
  return { ts: Number(packed >> 16n), ctr: Number(packed & 0xffffn) };
}

/**
 * Явная проверка расхождения: чужое время дальше `maxSkewMs` вперёд от
 * локального — ошибка, а не молчаливое принятие.
 */
export function assertClockSkew(
  remote: Hlc,
  physMs: number,
  maxSkewMs: number = HLC_MAX_SKEW_MS,
): void {
  if (remote.ts > physMs + maxSkewMs) {
    throw new ClockSkewError(remote.ts, physMs, maxSkewMs);
  }
}

export interface HlcClockOptions {
  /** Источник физического времени в мс. По умолчанию Date.now. */
  readonly now?: () => number;
  /** Порог расхождения чужих часов. По умолчанию HLC_MAX_SKEW_MS. */
  readonly maxSkewMs?: number;
  /** Начальное состояние (например, восстановленное из myc_meta). */
  readonly initial?: Hlc;
}

/** Состояние HLC одного сайта. Не потокобезопасно: один экземпляр на реплику. */
export class HlcClock {
  private ts: number;
  private ctr: number;
  private readonly nowFn: () => number;
  readonly maxSkewMs: number;
  private skewCount = 0;
  private maxSkewObservedMs = 0;

  constructor(opts: HlcClockOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
    this.maxSkewMs = opts.maxSkewMs ?? HLC_MAX_SKEW_MS;
    this.ts = opts.initial?.ts ?? 0;
    this.ctr = opts.initial?.ctr ?? 0;
  }

  /** Текущее состояние без продвижения. */
  get state(): Hlc {
    return { ts: this.ts, ctr: this.ctr };
  }

  /** Локальное событие (send). */
  now(): Hlc {
    const phys = this.nowFn();
    if (phys > this.ts) {
      this.ts = phys;
      this.ctr = 0;
    } else {
      this.ctr += 1;
    }
    if (this.ctr > HLC_CTR_MAX) throw new HlcOverflowError(this.ts);
    return { ts: this.ts, ctr: this.ctr };
  }

  /**
   * Отчёт о расхождении часов пиров. `count > 0` означает, что sync обязан
   * доложить `degraded` — молчать здесь нельзя (инвариант И2).
   */
  get skew(): { readonly count: number; readonly maxObservedMs: number } {
    return { count: this.skewCount, maxObservedMs: this.maxSkewObservedMs };
  }

  /** Строгая проверка для режима --strict. Бросает ClockSkewError. */
  assertSkew(remote: Hlc): void {
    assertClockSkew(remote, this.nowFn(), this.maxSkewMs);
  }

  /**
   * Приём чужой метки (receive). Операция принимается всегда. Если чужое время
   * ушло вперёд дальше порога, наши часы подтягиваются лишь до
   * `phys + maxSkewMs` — чтобы съехавшие часы одного пира не разъехали весь
   * рой — а величина расхождения копится в {@link skew} для отчёта.
   */
  recv(remote: Hlc): Hlc {
    const phys = this.nowFn();
    const skewMs = remote.ts - phys;
    let effectiveTs = remote.ts;
    if (skewMs > this.maxSkewMs) {
      effectiveTs = phys + this.maxSkewMs;
      this.skewCount += 1;
      if (skewMs > this.maxSkewObservedMs) this.maxSkewObservedMs = skewMs;
    }
    remote = { ts: effectiveTs, ctr: remote.ctr };
    const m = Math.max(this.ts, remote.ts, phys);
    if (m === this.ts && m === remote.ts) {
      this.ctr = Math.max(this.ctr, remote.ctr) + 1;
    } else if (m === this.ts) {
      this.ctr += 1;
    } else if (m === remote.ts) {
      this.ctr = remote.ctr + 1;
    } else {
      this.ctr = 0;
    }
    this.ts = m;
    if (this.ctr > HLC_CTR_MAX) throw new HlcOverflowError(this.ts);
    return { ts: this.ts, ctr: this.ctr };
  }
}

// ---------------------------------------------------------------------------
// Записи оплога
// ---------------------------------------------------------------------------

export type OpKind = "set" | "inc" | "edge_add" | "edge_del";

/** Скалярное значение поля: то, что уместится в JSON. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

interface OpBase {
  /** Глобально уникальный идентификатор операции — ключ идемпотентности. */
  readonly op_id: string;
  /** Локальный монотонный номер на сайте-источнике. */
  readonly seq: number;
  readonly hlc: Hlc;
  readonly site_id: string;
  readonly entity_id: string;
  readonly field: string;
}

/** LWW-запись скалярного поля. */
export interface SetOp extends OpBase {
  readonly op: "set";
  readonly value: JsonValue;
}

/**
 * G-counter: `value` — накопленное значение счётчика НА ЭТОМ САЙТЕ, не дельта.
 * Так слияние сводится к поэлементному максимуму и остаётся идемпотентным.
 */
export interface IncOp extends OpBase {
  readonly op: "inc";
  readonly value: number;
}

/** OR-Set add: `field` — тип ребра, `entity_id` — ключ (src, type, dst). */
export interface EdgeAddOp extends OpBase {
  readonly op: "edge_add";
  readonly value: { readonly tag: string; readonly weight?: number };
}

/** OR-Set remove: удаляет только те добавления, чьи теги видел. */
export interface EdgeDelOp extends OpBase {
  readonly op: "edge_del";
  readonly value: { readonly tags: readonly string[] };
}

export type Op = SetOp | IncOp | EdgeAddOp | EdgeDelOp;

/** Ключ ребра для entity_id. Разделитель NUL невозможен в ID и в типе ребра. */
export function edgeKey(src: string, type: string, dst: string): string {
  return `${src}\u0000${type}\u0000${dst}`;
}

export function parseEdgeKey(key: string): {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
} {
  const parts = key.split("\u0000");
  if (parts.length !== 3) throw new Error(`malformed edge key: ${JSON.stringify(key)}`);
  return { src: parts[0]!, type: parts[1]!, dst: parts[2]! };
}

/** op_id детерминирован от (site_id, seq): повторный экспорт даёт тот же ключ. */
export function makeOpId(siteId: string, seq: number): string {
  return `${siteId}:${seq}`;
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

export interface FieldClock {
  readonly hlc: Hlc;
  readonly site_id: string;
}

export interface FieldEntry {
  readonly value: JsonValue;
  readonly clock: FieldClock;
}

export interface EdgeAdd {
  readonly hlc: Hlc;
  readonly site_id: string;
  readonly weight: number | undefined;
}

export interface EdgeState {
  /** add_tag → метаданные добавления. */
  readonly adds: ReadonlyMap<string, EdgeAdd>;
  /** Теги, которые видело хотя бы одно удаление. */
  readonly tombstones: ReadonlySet<string>;
}

/**
 * Полное сходимое состояние. Неизменяемое снаружи: `merge` возвращает новый
 * объект и не трогает переданный.
 */
export interface OplogState {
  /** entity_id → field → значение с часами. */
  readonly fields: ReadonlyMap<string, ReadonlyMap<string, FieldEntry>>;
  /** entity_id → field → site_id → значение. */
  readonly counters: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<string, number>>
  >;
  /** edgeKey → OR-Set. */
  readonly edges: ReadonlyMap<string, EdgeState>;
  /** Применённые op_id — идемпотентность. */
  readonly applied: ReadonlySet<string>;
}

interface MutableEdgeState {
  adds: Map<string, EdgeAdd>;
  tombstones: Set<string>;
}

interface MutableState {
  fields: Map<string, Map<string, FieldEntry>>;
  counters: Map<string, Map<string, Map<string, number>>>;
  edges: Map<string, MutableEdgeState>;
  applied: Set<string>;
}

export function emptyState(): OplogState {
  return {
    fields: new Map(),
    counters: new Map(),
    edges: new Map(),
    applied: new Set(),
  };
}

function cloneState(s: OplogState): MutableState {
  const fields = new Map<string, Map<string, FieldEntry>>();
  for (const [e, fs] of s.fields) fields.set(e, new Map(fs));
  const counters = new Map<string, Map<string, Map<string, number>>>();
  for (const [e, fs] of s.counters) {
    const inner = new Map<string, Map<string, number>>();
    for (const [f, sites] of fs) inner.set(f, new Map(sites));
    counters.set(e, inner);
  }
  const edges = new Map<string, MutableEdgeState>();
  for (const [k, es] of s.edges) {
    edges.set(k, { adds: new Map(es.adds), tombstones: new Set(es.tombstones) });
  }
  return { fields, counters, edges, applied: new Set(s.applied) };
}

function getOrCreate<K, V>(m: Map<K, V>, k: K, make: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    v = make();
    m.set(k, v);
  }
  return v;
}

/**
 * Применить одну операцию к изменяемому состоянию. Каждая ветка — join
 * полурешётки: коммутативна, ассоциативна, идемпотентна сама по себе, поэтому
 * порядок применения внутри пакета не важен.
 */
function applyOp(s: MutableState, op: Op): void {
  if (s.applied.has(op.op_id)) return;
  s.applied.add(op.op_id);

  switch (op.op) {
    case "set": {
      const fs = getOrCreate(s.fields, op.entity_id, () => new Map<string, FieldEntry>());
      const cur = fs.get(op.field);
      if (
        cur === undefined ||
        compareClock(op.hlc, op.site_id, cur.clock.hlc, cur.clock.site_id) > 0
      ) {
        fs.set(op.field, {
          value: op.value,
          clock: { hlc: op.hlc, site_id: op.site_id },
        });
      }
      return;
    }
    case "inc": {
      const fs = getOrCreate(
        s.counters,
        op.entity_id,
        () => new Map<string, Map<string, number>>(),
      );
      const sites = getOrCreate(fs, op.field, () => new Map<string, number>());
      const cur = sites.get(op.site_id) ?? 0;
      if (op.value > cur) sites.set(op.site_id, op.value);
      return;
    }
    case "edge_add": {
      const es = getOrCreate(s.edges, op.entity_id, () => ({
        adds: new Map<string, EdgeAdd>(),
        tombstones: new Set<string>(),
      }));
      // Тег уникален для одного добавления; повтор с тем же тегом — та же операция.
      if (!es.adds.has(op.value.tag)) {
        es.adds.set(op.value.tag, {
          hlc: op.hlc,
          site_id: op.site_id,
          weight: op.value.weight,
        });
      }
      return;
    }
    case "edge_del": {
      const es = getOrCreate(s.edges, op.entity_id, () => ({
        adds: new Map<string, EdgeAdd>(),
        tombstones: new Set<string>(),
      }));
      for (const t of op.value.tags) es.tombstones.add(t);
      return;
    }
  }
}

export interface MergeOptions {
  /**
   * Часы принимающего сайта. Если переданы, каждая чужая метка проходит через
   * `recv`, и расхождение больше порога отвергает ВЕСЬ пакет до изменения
   * состояния.
   */
  readonly clock?: HlcClock;
}

/**
 * merge(локальное состояние, чужие записи) → новое состояние.
 * Коммутативна, ассоциативна, идемпотентна; исходное состояние не изменяется.
 */
export function merge(
  local: OplogState,
  ops: Iterable<Op>,
  opts: MergeOptions = {},
): OplogState {
  const list = Array.isArray(ops) ? (ops as readonly Op[]) : [...ops];
  if (opts.clock) {
    // Пакет применяется целиком. Метка со съехавших часов не отвергается, а
    // зажимается порогом внутри recv: расхождение реплик, вызванное отказом,
    // не срастётся само, а зажатая метка сойдётся. Факт расхождения виден
    // через clock.skew и обязан попасть в отчёт sync как degraded.
    for (const op of list) opts.clock.recv(op.hlc);
  }
  const next = cloneState(local);
  for (const op of list) applyOp(next, op);
  return next;
}

/** Слияние двух состояний целиком (join полурешётки). */
export function joinStates(a: OplogState, b: OplogState): OplogState {
  const next = cloneState(a);
  for (const [e, fs] of b.fields) {
    const target = getOrCreate(next.fields, e, () => new Map<string, FieldEntry>());
    for (const [f, entry] of fs) {
      const cur = target.get(f);
      if (
        cur === undefined ||
        compareClock(
          entry.clock.hlc,
          entry.clock.site_id,
          cur.clock.hlc,
          cur.clock.site_id,
        ) > 0
      ) {
        target.set(f, entry);
      }
    }
  }
  for (const [e, fs] of b.counters) {
    const target = getOrCreate(
      next.counters,
      e,
      () => new Map<string, Map<string, number>>(),
    );
    for (const [f, sites] of fs) {
      const ts = getOrCreate(target, f, () => new Map<string, number>());
      for (const [site, v] of sites) {
        if (v > (ts.get(site) ?? 0)) ts.set(site, v);
      }
    }
  }
  for (const [k, es] of b.edges) {
    const target = getOrCreate(next.edges, k, () => ({
      adds: new Map<string, EdgeAdd>(),
      tombstones: new Set<string>(),
    }));
    for (const [tag, add] of es.adds) if (!target.adds.has(tag)) target.adds.set(tag, add);
    for (const t of es.tombstones) target.tombstones.add(t);
  }
  for (const id of b.applied) next.applied.add(id);
  return next;
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

export function readField(
  s: OplogState,
  entityId: string,
  field: string,
): FieldEntry | undefined {
  return s.fields.get(entityId)?.get(field);
}

/** G-counter: сумма по сайтам. */
export function readCounter(s: OplogState, entityId: string, field: string): number {
  const sites = s.counters.get(entityId)?.get(field);
  if (!sites) return 0;
  let sum = 0;
  for (const v of sites.values()) sum += v;
  return sum;
}

/** Ребро живо, если есть добавление, чей тег не покрыт ни одним удалением. */
export function isEdgeAlive(s: OplogState, key: string): boolean {
  const es = s.edges.get(key);
  if (!es) return false;
  for (const tag of es.adds.keys()) if (!es.tombstones.has(tag)) return true;
  return false;
}

/** Живые теги ребра — то, что должно уйти в edge_del, чтобы удалить его сейчас. */
export function liveTags(s: OplogState, key: string): string[] {
  const es = s.edges.get(key);
  if (!es) return [];
  const out: string[] = [];
  for (const tag of es.adds.keys()) if (!es.tombstones.has(tag)) out.push(tag);
  return out.sort();
}

export function liveEdges(s: OplogState): string[] {
  const out: string[] = [];
  for (const key of s.edges.keys()) if (isEdgeAlive(s, key)) out.push(key);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Канонический снимок: побайтно одинаков для одинаковых состояний
// ---------------------------------------------------------------------------

function sortedEntries<V>(m: ReadonlyMap<string, V>): [string, V][] {
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function canonicalJson(v: JsonValue): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${(v as readonly JsonValue[]).map(canonicalJson).join(",")}]`;
  const obj = v as { readonly [k: string]: JsonValue };
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k]!)}`).join(",")}}`;
}

/**
 * Детерминированная строка, описывающая всё состояние: значения, часы полей,
 * счётчики по сайтам, теги и тумбстоуны рёбер, применённые op_id.
 * Два состояния сошлись тогда и только тогда, когда их снимки равны.
 */
export function snapshot(s: OplogState): string {
  const lines: string[] = [];
  for (const [e, fs] of sortedEntries(s.fields)) {
    for (const [f, entry] of sortedEntries(fs)) {
      lines.push(
        `F ${e} ${f} ${entry.clock.hlc.ts}.${entry.clock.hlc.ctr} ${entry.clock.site_id} ${canonicalJson(entry.value)}`,
      );
    }
  }
  for (const [e, fs] of sortedEntries(s.counters)) {
    for (const [f, sites] of sortedEntries(fs)) {
      const parts = sortedEntries(sites).map(([site, v]) => `${site}=${v}`);
      lines.push(`C ${e} ${f} ${parts.join(",")}`);
    }
  }
  for (const [k, es] of sortedEntries(s.edges)) {
    const adds = sortedEntries(es.adds).map(
      ([tag, a]) => `${tag}@${a.hlc.ts}.${a.hlc.ctr}/${a.site_id}/${a.weight ?? ""}`,
    );
    const tombs = [...es.tombstones].sort();
    lines.push(`E ${k.replaceAll("\u0000", "|")} adds=${adds.join(",")} del=${tombs.join(",")}`);
  }
  lines.push(`A ${[...s.applied].sort().join(",")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Локальный сайт: генерация операций
// ---------------------------------------------------------------------------

export interface SiteOptions {
  readonly clock?: HlcClock;
  /** Последний известный seq (например, myc_meta.last_seq). Новые начнутся с +1. */
  readonly lastSeq?: number;
  /** Генератор тегов OR-Set. По умолчанию `${site_id}:${seq}`. */
  readonly tag?: (siteId: string, seq: number) => string;
}

/**
 * Один сайт: держит свои часы, монотонный seq, локальный оплог и своё
 * сходимое состояние. Локальные операции применяются к состоянию сразу.
 */
export class Site {
  readonly siteId: string;
  readonly clock: HlcClock;
  private seq: number;
  private readonly log: Op[] = [];
  private current: OplogState = emptyState();
  private readonly tagFn: (siteId: string, seq: number) => string;

  constructor(siteId: string, opts: SiteOptions = {}) {
    this.siteId = siteId;
    this.clock = opts.clock ?? new HlcClock();
    this.seq = opts.lastSeq ?? 0;
    this.tagFn = opts.tag ?? makeOpId;
  }

  /** myc_meta.last_seq */
  get lastSeq(): number {
    return this.seq;
  }

  get state(): OplogState {
    return this.current;
  }

  /** Локальный оплог целиком, в порядке seq. */
  get ops(): readonly Op[] {
    return this.log;
  }

  /** Записи с seq > since — то, что уходит по `sync --since` и SSE. */
  since(seq: number): Op[] {
    return this.log.filter((o) => o.seq > seq);
  }

  private next(): { seq: number; hlc: Hlc; op_id: string } {
    const hlc = this.clock.now();
    const seq = this.seq + 1;
    this.seq = seq;
    return { seq, hlc, op_id: makeOpId(this.siteId, seq) };
  }

  private commit(op: Op): Op {
    this.log.push(op);
    const next = cloneState(this.current);
    applyOp(next, op);
    this.current = next;
    return op;
  }

  set(entityId: string, field: string, value: JsonValue): SetOp {
    const op: SetOp = {
      op: "set",
      ...this.next(),
      site_id: this.siteId,
      entity_id: entityId,
      field,
      value,
    };
    return this.commit(op) as SetOp;
  }

  /** Инкремент G-counter на delta; в оплог уходит новое накопленное значение сайта. */
  inc(entityId: string, field: string, delta = 1): IncOp {
    if (!(delta > 0)) throw new Error(`G-counter increment must be positive, got ${delta}`);
    const cur = this.current.counters.get(entityId)?.get(field)?.get(this.siteId) ?? 0;
    const op: IncOp = {
      op: "inc",
      ...this.next(),
      site_id: this.siteId,
      entity_id: entityId,
      field,
      value: cur + delta,
    };
    return this.commit(op) as IncOp;
  }

  edgeAdd(src: string, type: string, dst: string, weight?: number): EdgeAddOp {
    const meta = this.next();
    const op: EdgeAddOp = {
      op: "edge_add",
      ...meta,
      site_id: this.siteId,
      entity_id: edgeKey(src, type, dst),
      field: type,
      value: weight === undefined
        ? { tag: this.tagFn(this.siteId, meta.seq) }
        : { tag: this.tagFn(this.siteId, meta.seq), weight },
    };
    return this.commit(op) as EdgeAddOp;
  }

  /**
   * Удалить ребро: в операцию попадают только теги, живые в ЛОКАЛЬНОМ
   * состоянии на момент удаления. Добавления, которых сайт не видел, переживут
   * это удаление — это и есть add-wins.
   */
  edgeDel(src: string, type: string, dst: string): EdgeDelOp {
    const key = edgeKey(src, type, dst);
    const op: EdgeDelOp = {
      op: "edge_del",
      ...this.next(),
      site_id: this.siteId,
      entity_id: key,
      field: type,
      value: { tags: liveTags(this.current, key) },
    };
    return this.commit(op) as EdgeDelOp;
  }

  /** Принять чужие записи: часы продвигаются через recv, состояние сливается. */
  receive(ops: Iterable<Op>): void {
    this.current = merge(this.current, ops, { clock: this.clock });
  }
}
