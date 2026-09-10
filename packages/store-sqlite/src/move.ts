/**
 * Переезд задачи между воркспейсами (R4, memory-v2aht4p11vhm) — исполнение
 * над ДВУМЯ базами. Это перенос идентичности, а не копия: id тот же, оплог
 * тот же, op_id тот же.
 *
 * ЧТО ТАКОЕ ПЕРЕЕЗД В ОПЛОГЕ. Ровно две обычные LWW-записи на узел:
 *
 *     set(<id>, "scope",            "<слаг приёмника>")
 *     set(<id>, "attrs.moved_from", "<слаг источника>")
 *
 * Никакого нового вида операции не заводится, и это главное свойство. `scope`
 * — обычное поле NODE_FIELDS, а все scoped-поверхности (ready, prime, recall,
 * fts) фильтруют по нему в SQL. Значит смена `scope` И ЕСТЬ смена дома: в
 * источнике узел мгновенно перестаёт попадать в выдачу, в приёмнике начинает.
 * Третья сторона, реплицирующая обе базы в ОДНУ, получает каждую операцию
 * ровно один раз (op_id уникален), а конфликт разрешает тот же per-field LWW,
 * что и всегда, — сходимость даётся даром, потому что переезд не выходит за
 * рамки CRDT (S49: import идемпотентен = сходимость).
 *
 * Всю прежнюю историю узла приёмник получает ДОСЛОВНО: те же op_id, site_id и
 * hlc. Поэтому повторный ввоз — `duplicate`, а не вторая копия, и прерванный
 * переезд доигрывается простым повтором команды.
 *
 * ПОРЯДОК ФАЗ ВЫБРАН ПО ХУДШЕМУ ИСХОДУ, А НЕ ПО КРАСОТЕ:
 *
 *   1. приёмник ввозит историю        — узел уже в B, но со `scope` A: B его
 *                                       ещё не видит, A по-прежнему владеет;
 *   2. ИСТОЧНИК минтит две операции   — ТОЧКА ФИКСАЦИИ: A перестал видеть;
 *   3. приёмник применяет их же       — B увидел.
 *
 * Обрыв между 2 и 3 оставляет задачу невидимой в ОБЕИХ очередях. Обратный
 * порядок (минтить в приёмнике) оставил бы её видимой в обеих — двое агентов
 * на одной задаче. Из двух дыр выбрана та, где работа не делается дважды, и
 * она закрыта детектором `strandedArrivals()`: в приёмнике лежит узел с
 * чужим `scope`, и это состояние ни на что не похоже, кроме недоигранного
 * переезда. Повтор `myc move` его доигрывает — все три фазы идемпотентны.
 *
 * НАДГРОБИЕ, А НЕ ИСЧЕЗНОВЕНИЕ. Строка узла остаётся в источнике навсегда, с
 * чужим `scope`. Цена: база источника не уменьшается никогда, и каждая
 * scoped-поверхность обязана фильтровать по scope (сейчас фильтруют все).
 * Цена альтернативы больше и она молчаливая: `edges` ссылается на `nodes`
 * через ON DELETE CASCADE, поэтому физическое удаление узла унесло бы вместе
 * с ним ВСЕ оставшиеся в источнике рёбра — как раз те, которые мы намеренно
 * не повезли, — а `open_blockers` триггерами на жёсткий DELETE не ведётся
 * (прямое предупреждение в db/schema.sqlite.sql). Плюс удалить пришлось бы и
 * строки оплога, то есть нарушить append-only, после чего любая реплика,
 * ещё не видевшая удаления, воскресила бы узел при следующем импорте.
 */

import {
  collectVersions,
  GraphError,
  MOVED_FROM_KEY,
  planMoveSet,
  versionSourceOf,
  type MoveBlockEdge,
  type MoveNeighbors,
  type MoveSetPlan,
  type QueryDef,
  type DbDriver,
} from "@myc/core";
import { REPLICATED_OPS } from "./export.ts";
import { GraphStore, rowToOp, type OplogRow } from "./queries.ts";

const OPS_LIST = [...REPLICATED_OPS].sort().map((o) => `'${o}'`).join(",");

export const QMV: Record<string, QueryDef> = {
  /** Живые рёбра blocks, у которых узел — один из концов. */
  block_edges: {
    name: "mv_block_edges",
    sql: `SELECT src, dst FROM edges
           WHERE type='blocks' AND deleted_at IS NULL AND (src=?1 OR dst=?1)`,
    params: ["id"],
  },
  /**
   * Рёбра ЛЮБОГО типа, инцидентные узлу, включая мягко удалённые: их
   * оплог тоже часть истории, и OR-Set без своих тумбстоунов воскресит
   * ребро на приёмнике.
   */
  edges_incident: {
    name: "mv_edges_incident",
    sql: `SELECT src, type, dst FROM edges WHERE src=?1 OR dst=?1`,
    params: ["id"],
  },
  /** Реплицируемые операции одной сущности, в порядке записи. */
  ops_of_entity: {
    name: "mv_ops_of_entity",
    sql: `SELECT seq, op_id, site_id, CAST(hlc AS TEXT) AS hlc, ts_ms, actor,
                 op, entity, entity_id, field, value, scope, origin
            FROM oplog
           WHERE entity_id=?1 AND op IN (${OPS_LIST})
           ORDER BY seq`,
    params: ["entity_id"],
  },
  /** Приехавшие, но недоигранные переезды: узел с чужим для этой базы scope. */
  stranded: {
    name: "mv_stranded",
    sql: `SELECT id, scope FROM nodes
           WHERE scope <> ?1 AND deleted_at IS NULL
             AND json_extract(attrs,'$.${MOVED_FROM_KEY}') IS NULL
           ORDER BY id`,
    params: ["scope"],
  },
  /**
   * Предки узла по `parent`, держащие открытый блокер (миграция 10).
   * `anc_blockers` материализуется триггерами ВНУТРИ одной базы — ровно как
   * `open_blockers`, — поэтому уехавший из-под заблокированного эпика узел в
   * приёмнике насчитал бы ноль и попал в `ready` готовым. Это тот же класс
   * молчаливой лжи, что и `cross_boundary`, и закрывается он так же.
   */
  blocking_ancestors: {
    name: "mv_blocking_ancestors",
    sql: `SELECT pc.ancestor AS ancestor, a.open_blockers AS open_blockers
            FROM parent_closure pc JOIN nodes a ON a.id = pc.ancestor
           WHERE pc.descendant = ?1 AND a.open_blockers > 0
           ORDER BY pc.depth, pc.ancestor`,
    params: ["id"],
  },
  /** Аренда узла — она в NodeRecord не входит. */
  lease_of: {
    name: "mv_lease_of",
    sql: `SELECT lease_holder, lease_expires FROM nodes WHERE id=?1`,
    params: ["id"],
  },
};

// ---------------------------------------------------------------------------
// Планирование
// ---------------------------------------------------------------------------

/**
 * Бюджет чтения цепочки версий для переезда. Это НЕ бюджет показа: переезд
 * обязан взять цепочку ЦЕЛИКОМ, иначе половина истории останется в источнике
 * и «история цела» из приёмки станет ложью. Упёрлись в потолок — отказ
 * (`chain_truncated`), а не тихий обрез.
 */
export const MOVE_CHAIN_LIMIT = 4096;

/**
 * Оракул соседей поверх драйвера источника. Цепочку версий читает
 * `collectVersions` из ядра — тот же единственный обход, которым живут `show`
 * и `absorb`; своей копии здесь нет намеренно (history-predicate.test.ts
 * держит это как инвариант, и обе прошлые копии успели разойтись).
 */
export function moveNeighbors(
  source: { readonly driver: DbDriver; readonly store: GraphStore },
  onTruncated?: (id: string) => void,
  limit: number = MOVE_CHAIN_LIMIT,
): MoveNeighbors {
  const src = versionSourceOf(source.driver, source.store);
  return {
    versionChain(id: string): readonly string[] {
      const self = src.row(id);
      if (self === undefined) return [id];
      const collected = collectVersions(src, self, limit);
      if (collected.truncated) onTruncated?.(id);
      return collected.graph.chain(id);
    },
    blockLinks(id: string): readonly MoveBlockEdge[] {
      return source.driver.all<MoveBlockEdge>(QMV.block_edges!, [id]);
    },
  };
}

export type MoveRefusalCode =
  /** Узла нет в базе-источнике. */
  | "notfound"
  /** Узел под живой арендой: переезд разорвал бы claim. */
  | "leased"
  /** Живой blocks пересёк бы границу баз. */
  | "cross_boundary"
  /** Узел уезжает из-под заблокированного предка: наследование границу не переживёт. */
  | "cross_boundary_parent"
  /** Источник и приёмник — один и тот же воркспейс. */
  | "same_workspace"
  /** Цепочка версий длиннее бюджета чтения: половину истории увозить нельзя. */
  | "chain_truncated";

export interface MoveRefusal {
  readonly ok: false;
  readonly code: MoveRefusalCode;
  readonly msg: string;
  readonly crossing: readonly MoveBlockEdge[];
}

export interface MovePlan {
  readonly ok: true;
  /** Узлы, едущие вместе (цепочка версий, при --with-blockers — и блокеры). */
  readonly members: readonly string[];
  /** Рёбра, едущие вместе: оба конца в наборе. */
  readonly edges: readonly string[];
  /** Рёбра, остающиеся в источнике: второй конец не едет. */
  readonly staying: readonly string[];
  /** Реплицируемые операции набора, дословно из оплога источника. */
  readonly ops: readonly OplogRow[];
  /** Набор расширен закрытием по blocks. */
  readonly expanded: boolean;
  readonly from: string;
  readonly to: string;
}

export interface PlanOptions {
  readonly withBlockers?: boolean;
  readonly now?: number;
  /** Бюджет чтения цепочки версий; понижается только в тестах этой защиты. */
  readonly chainLimit?: number;
}

function edgeEntity(src: string, type: string, dst: string): string {
  return `${src}|${type}|${dst}`;
}

/**
 * Что именно переедет. Ничего не пишет — этим же планом живёт `--dry-run`.
 *
 * Отказы здесь, а не в CLI: приёмка требует, чтобы переезд НЕ МОГ оставить
 * ready в неверном состоянии, а команда — не единственная поверхность
 * (MCP-инструмент придёт следующим и обязан упереться в тот же отказ).
 */
export function planMove(
  source: { readonly driver: DbDriver; readonly store: GraphStore },
  id: string,
  from: string,
  to: string,
  opts: PlanOptions = {},
): MovePlan | MoveRefusal {
  if (from === to) {
    return {
      ok: false,
      code: "same_workspace",
      msg: `source and target are the same workspace (scope '${from}'): nowhere to move`,
      crossing: [],
    };
  }
  const node = source.store.getNode(id, true);
  if (node === undefined) {
    return { ok: false, code: "notfound", msg: `node ${id} not found in the source`, crossing: [] };
  }

  const now = opts.now ?? Date.now();
  const truncated: string[] = [];
  const set: MoveSetPlan = planMoveSet(
    [id],
    moveNeighbors(source, (who) => truncated.push(who), opts.chainLimit ?? MOVE_CHAIN_LIMIT),
    { withBlockers: opts.withBlockers === true },
  );
  if (truncated.length > 0) {
    return {
      ok: false,
      code: "chain_truncated",
      msg:
        `version chain of ${truncated[0]} is longer than the read budget ${opts.chainLimit ?? MOVE_CHAIN_LIMIT}: ` +
        `the move would take only part of it and cut the history`,
      crossing: [],
    };
  }

  // Аренда проверяется по ВСЕМУ набору, а не по стартовому узлу: с
  // `--with-blockers` вместе с задачей уезжает чужая, и она может быть
  // взята в работу. Операции 'claim' не реплицируются вовсе (их нет в
  // REPLICATED_OPS, rowToOp на них падает намеренно), поэтому увезённая
  // аренда просто исчезает — и второй агент берёт ту же задачу в приёмнике,
  // пока первый её делает. Это ровно тот класс потери, ради которого
  // заведён claim, и молча допускать его нельзя.
  for (const member of set.members) {
    const lease = source.driver.one<{ lease_holder: string; lease_expires: number }>(
      QMV.lease_of!,
      [member],
    );
    if (lease !== undefined && lease.lease_holder !== "" && lease.lease_expires > now) {
      return {
        ok: false,
        code: "leased",
        msg:
          `${member} is under a live lease by ${lease.lease_holder} until ` +
          `${new Date(lease.lease_expires).toISOString()}: leases do not replicate, and the move would lose it`,
        crossing: [],
      };
    }
  }

  if (set.crossing.length > 0) {
    return {
      ok: false,
      code: "cross_boundary",
      msg:
        `${set.crossing.length} live blocks ${set.crossing.length === 1 ? "edge" : "edges"} ` +
        `would cross the workspace boundary; ` +
        `open_blockers is maintained by triggers inside one database, and in the target the task ` +
        `would show up in ready as unblocked`,
      crossing: set.crossing,
    };
  }

  // Наследованная блокировка границу не переживает — по той же причине, что и
  // прямая: `anc_blockers` ведут триггеры в ОДНОЙ базе, а `parent` на переезде
  // остаётся в источнике. Уехавший потомок заблокированного эпика насчитал бы
  // в приёмнике ноль и встал бы в очередь готовым. Проверяется по ВСЕМУ
  // набору и НЕ снимается флагом --with-blockers: тот расширяет набор по
  // `blocks`, а утащить сам эпик значило бы разорвать наследование у ОСТАВШИХСЯ
  // его детей — то есть поменять одну молчаливую ложь на другую.
  for (const member of set.members) {
    const anc = source.driver.all<{ ancestor: string; open_blockers: number }>(
      QMV.blocking_ancestors!,
      [member],
    );
    const staying = anc.filter((a) => !set.members.includes(a.ancestor));
    if (staying.length > 0) {
      const a = staying[0]!;
      return {
        ok: false,
        code: "cross_boundary_parent",
        msg:
          `${member} would leave its blocked ancestor ${a.ancestor} behind ` +
          `(${a.open_blockers} open ${a.open_blockers === 1 ? "blocker" : "blockers"}): inheritance is maintained ` +
          `by triggers inside one database, and in the target the task would show up in ready as unblocked`,
        crossing: [],
      };
    }
  }

  const members = new Set(set.members);
  const edges = new Set<string>();
  const staying = new Set<string>();
  for (const member of set.members) {
    for (const e of source.driver.all<{ src: string; type: string; dst: string }>(
      QMV.edges_incident!,
      [member],
    )) {
      const key = edgeEntity(e.src, e.type, e.dst);
      if (members.has(e.src) && members.has(e.dst)) edges.add(key);
      else staying.add(key);
    }
  }

  const ops: OplogRow[] = [];
  for (const entity of [...set.members, ...[...edges].sort()]) {
    ops.push(...source.driver.all<OplogRow>(QMV.ops_of_entity!, [entity]));
  }
  ops.sort((a, b) => a.seq - b.seq);

  return {
    ok: true,
    members: set.members,
    edges: [...edges].sort(),
    staying: [...staying].sort(),
    ops,
    expanded: set.expanded,
    from,
    to,
  };
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

export interface MoveResult {
  readonly members: readonly string[];
  readonly edges: readonly string[];
  readonly staying: readonly string[];
  /** Строк истории, предъявленных приёмнику. */
  readonly ops: number;
  /** Из них применено впервые (0 при повторе — переезд уже был). */
  readonly applied: number;
  /** Из них уже были в приёмнике: повтор безопасен по построению. */
  readonly duplicate: number;
  /** Операций переезда, отчеканенных источником (0 — фаза уже была). */
  readonly minted: number;
  /** Переезд доигран после обрыва, а не начат с нуля. */
  readonly resumed: boolean;
  readonly from: string;
  readonly to: string;
}

/** Точка обрыва для теста на настоящих процессах; в бою всегда undefined. */
export type MoveBreakpoint = "after-ingest" | "after-commit";

export interface ExecuteOptions {
  /** Убить процесс после названной фазы (только тесты). */
  readonly breakpoint?: MoveBreakpoint;
  readonly onBreakpoint?: (phase: MoveBreakpoint) => void;
  /**
   * Мутанты для мутационного контроля защит. В бою — "none".
   *  - `ignore-deferred`: не проверять, что приёмник взял историю целиком.
   */
  readonly mutant?: "none" | "ignore-deferred";
}

/**
 * Ввоз истории в приёмник. Идемпотентен: повтор даёт `duplicate`, а не
 * вторую копию, потому что op_id уникален глобально.
 *
 * ЗАЩИТА: `deferred`/`collided` непусты — приёмник историю НЕ взял целиком
 * (ребру не хватило конца, часы столкнулись). Отдать после этого владение
 * значило бы оставить задачу с дырявой историей и без старого дома. Поэтому
 * здесь исключение, а не WARN: фаза 2 не должна начаться (И2).
 */
function ingest(
  target: GraphStore,
  ops: readonly OplogRow[],
  mutant: ExecuteOptions["mutant"],
): { applied: number; duplicate: number } {
  if (ops.length === 0) return { applied: 0, duplicate: 0 };
  const r = target.applyOps(ops.map(rowToOp), 0);
  if (mutant !== "ignore-deferred" && (r.deferred.length > 0 || r.collided.length > 0)) {
    throw new GraphError(
      "graph.clock_collision",
      `the target did not take the whole history: deferred ${r.deferred.length}, collided ${r.collided.length}` +
        ` (${[...r.deferred, ...r.collided].slice(0, 3).join(", ")}) — move stopped before the commit point`,
    );
  }
  return { applied: r.applied, duplicate: r.duplicate };
}

/**
 * Переезд. Три фазы, каждая идемпотентна по отдельности, поэтому повтор
 * команды после любого обрыва доигрывает ровно недостающее.
 */
export function executeMove(
  source: { readonly driver: DbDriver; readonly store: GraphStore },
  target: { readonly driver: DbDriver; readonly store: GraphStore },
  plan: MovePlan,
  opts: ExecuteOptions = {},
): MoveResult {
  const brk = (phase: MoveBreakpoint): void => {
    if (opts.breakpoint === phase) opts.onBreakpoint?.(phase);
  };

  // Фаза 1 — история в приёмник. Владения ещё не передаём.
  const ingested = ingest(target.store, plan.ops, opts.mutant);
  brk("after-ingest");

  // Фаза 2 — точка фиксации: источник минтит переезд.
  const mintedIds: string[] = [];
  let resumed = true;
  for (const member of plan.members) {
    const before = source.store.getNode(member, true);
    if (before === undefined) continue;
    const seqBefore = source.store.lastSeq;
    source.store.updateNode(member, {
      scope: plan.to,
      attrs: { [MOVED_FROM_KEY]: plan.from },
    });
    if (source.store.lastSeq !== seqBefore) resumed = false;
    mintedIds.push(member);
  }
  brk("after-commit");

  // Фаза 3 — те же операции в приёмник. Читаем из оплога источника, а не
  // из возвращённого updateNode: в оплоге они уже в канонической форме и
  // их же увидит любая третья сторона.
  const tail: OplogRow[] = [];
  for (const member of mintedIds) {
    for (const row of source.driver.all<OplogRow>(QMV.ops_of_entity!, [member])) {
      if (row.field === "scope" || row.field === `attrs.${MOVED_FROM_KEY}`) tail.push(row);
    }
  }
  tail.sort((a, b) => a.seq - b.seq);
  const shipped = ingest(target.store, tail, opts.mutant);

  return {
    members: plan.members,
    edges: plan.edges,
    staying: plan.staying,
    ops: plan.ops.length + tail.length,
    applied: ingested.applied + shipped.applied,
    duplicate: ingested.duplicate + shipped.duplicate,
    minted: resumed ? 0 : mintedIds.length,
    resumed,
    from: plan.from,
    to: plan.to,
  };
}

/**
 * Недоигранные переезды в ЭТОЙ базе: узел приехал (история есть), но
 * операции смены дома до неё не дошли — обрыв между фазами 2 и 3. Такой узел
 * не виден ни здесь (чужой scope), ни в источнике (там он уже переехал),
 * поэтому обнаружить его обязана база-приёмник, и молчать об этом нельзя.
 */
export function strandedArrivals(
  driver: DbDriver,
  scope: string,
): Array<{ readonly id: string; readonly scope: string }> {
  return driver.all<{ id: string; scope: string }>(QMV.stranded!, [scope]);
}
