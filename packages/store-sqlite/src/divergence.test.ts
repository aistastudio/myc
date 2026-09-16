/**
 * Молчаливое расхождение реплик — класс S38/S40. Четыре находки внешнего
 * анализа (тег kimi), каждая сначала воспроизведена здесь на коде ДО правки:
 *
 *  - memory-86eqge02q8rd — OR-Set рёбер хранил одного представителя вместо
 *    множества add-тегов: один набор операций в двух порядках давал два
 *    состояния, а дедупликация по op_id делала расхождение необратимым;
 *  - memory-tvw65jjgaheh — закрытие взятой задачи журналировалось только
 *    строкой op='claim', которая не экспортируется: на реплике задача open
 *    и берётся в работу повторно;
 *  - memory-0fs4rfa6xmha — два узла с одинаковым текстом с двух сайтов:
 *    UNIQUE ux_nodes_content откатывал весь applyOps, и каждая следующая
 *    синхронизация падала тем же исключением;
 *  - memory-nvx51d0kgf2t — oplog_pending: park() не upsert, дренаж только
 *    для узлов, рождённых внутри applyOps, фантомы в pendingCount().
 *
 * Гонка миграторов (memory-yc7np0eyy2s0) живёт между процессами и
 * проверяется в migrate.race.test.ts; сквозной путь export → git → import —
 * в replication-git.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HlcClock,
  contentHash,
  emptyState,
  generateId,
  isEdgeAlive,
  merge,
  packHlc,
  type DbDriver,
  type EdgeKind,
  type Op,
  type OpFactory,
} from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, Q, rowToOp } from "./queries.ts";
import { REPLICATED_OPS, exportGraph, renderProjectionFiles } from "./export.ts";
import { importGraph } from "./import.ts";
import { executeMove, planMove } from "./move.ts";

const T0 = 1_700_000_000_000;

let dir: string;
const drivers: SqliteDriver[] = [];

interface Site {
  readonly id: string;
  readonly store: GraphStore;
  readonly driver: SqliteDriver;
}

let opened = 0;

async function openSite(id: string, startMs = T0): Promise<Site> {
  const driver = openSqlite(join(dir, `${id}-${opened++}.db`));
  drivers.push(driver);
  await migrate(driver.database, { migrations, writable: true });
  let t = startMs;
  const store = new GraphStore(driver, {
    siteId: id,
    actor: `actor-${id}`,
    newId: () => generateId(),
    clock: new HlcClock({ now: () => (t += 1) }),
    now: () => startMs,
  });
  return { id, store, driver };
}

/** Ровно то, что уходит в git: реплицируемые виды операций в порядке журнала. */
function opsOf(site: Site): Op[] {
  return site.store
    .opsSince(0, 1_000_000)
    .filter((row) => REPLICATED_OPS.has(row.op))
    .map(rowToOp);
}

function isEdgeOp(op: Op): boolean {
  return op.op === "edge_add" || op.op === "edge_del";
}

function uniqueOps(ops: readonly Op[]): Op[] {
  const byId = new Map<string, Op>();
  for (const op of ops) byId.set(op.op_id, op);
  return [...byId.values()];
}

/** mulberry32 — воспроизводимый генератор. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/**
 * Проекция рёбер целиком: строки edges (все реплицируемые колонки и
 * created_at), тумбстоуны и материализованный open_blockers. Локальные
 * колонки (actor, attrs) не входят — они не реплицируются по построению.
 */
function edgeSnapshot(site: Site): string {
  const edges = site.driver.all(
    {
      name: "t_edges",
      sql: `SELECT src, type, dst, weight, add_tag, CAST(hlc AS TEXT) AS hlc, site_id,
                   deleted_at, created_at
              FROM edges ORDER BY src, type, dst`,
      params: [],
    },
    [],
  );
  const tombs = site.driver.all(
    {
      name: "t_tombs",
      sql: `SELECT src, type, dst, tag, CAST(hlc AS TEXT) AS hlc, site_id
              FROM edge_tombstones ORDER BY src, type, dst, tag`,
      params: [],
    },
    [],
  );
  const blockers = site.driver.all(
    { name: "t_blk", sql: "SELECT id, open_blockers FROM nodes ORDER BY id", params: [] },
    [],
  );
  return JSON.stringify({ edges, tombs, blockers });
}

function liveKeys(site: Site): string[] {
  return site.driver
    .all<{ k: string }>(
      {
        name: "t_live",
        sql: "SELECT src || char(0) || type || char(0) || dst AS k FROM edges WHERE deleted_at IS NULL ORDER BY k",
        params: [],
      },
      [],
    )
    .map((r) => r.k);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-divergence-"));
});

afterEach(() => {
  for (const d of drivers.splice(0)) {
    try {
      d.close();
    } catch {
      // уже закрыт тестом
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// memory-86eqge02q8rd — OR-Set рёбер
// ---------------------------------------------------------------------------

describe("memory-86eqge02q8rd: OR-Set рёбер сходится в любом порядке", () => {
  test("два конкурентных add и remove, видевший одно из них: все 6 порядков — одно состояние, ребро живо", async () => {
    const a = await openSite("siteA", T0);
    // Часы B заметно позже: удалённый тег — самый свежий add, ровно тот
    // случай, где представитель «самый свежий живой» терял старшее add.
    const b = await openSite("siteB", T0 + 1000);
    const n1 = a.store.createNode({ kind: "note", title: "n1" }).id;
    const n2 = a.store.createNode({ kind: "note", title: "n2" }).id;
    const base = opsOf(a);
    b.store.applyOps(base);

    a.store.addEdge(n1, "relates", n2); // тег a
    b.store.addEdge(n1, "relates", n2); // тег b
    expect(b.store.removeEdge(n1, "relates", n2)).toBe(true); // видел только b
    const edgeOps = uniqueOps([...opsOf(a), ...opsOf(b)]).filter(isEdgeOp);
    expect(edgeOps.map((op) => op.op).sort()).toEqual(["edge_add", "edge_add", "edge_del"]);

    // Эталон — чистая CRDT-семантика ядра: add-тег a никто не удалял.
    const oracle = merge(emptyState(), edgeOps);
    expect(isEdgeAlive(oracle, edgeOps[0]!.entity_id)).toBe(true);

    const states = new Set<string>();
    const alive = new Set<boolean>();
    let i = 0;
    for (const order of permutations(edgeOps)) {
      const r = await openSite(`perm${i++}`, T0 + 5000);
      r.store.applyOps(base);
      // Каждая операция — отдельный пакет: порядок между пакетами произволен
      // (внутри пакета applyOps всё равно сортирует по часам).
      for (const op of order) r.store.applyOps([op]);
      states.add(edgeSnapshot(r));
      alive.add(r.store.getEdge(n1, "relates", n2)?.deleted_at === null);
    }
    expect([...alive]).toEqual([true]);
    expect(states.size).toBe(1);
  });

  /**
   * Свойство: три сайта конкурентно добавляют и удаляют рёбра на трёх
   * ключах, видя друг друга лишь частично (случайные подмножества операций
   * доставляются случайным сайтам). Весь набор операций затем применяется к
   * свежим репликам в случайных перестановках и случайной нарезке на пакеты.
   * Все реплики обязаны прийти к одной проекции, и живость каждого ребра —
   * к эталону ядра (merge/isEdgeAlive). Сами сайты после полной доставки —
   * к ней же.
   */
  test("свойство: 3 сайта × частичная доставка, 3 сценария × 40 перестановок — одна проекция, живость = эталон ядра", async () => {
    for (const seed of [11, 23, 37]) {
      const r = rng(seed);
      const sites = [
        await openSite(`sA${seed}`, T0),
        await openSite(`sB${seed}`, T0 + 7),
        await openSite(`sC${seed}`, T0 + 13),
      ];
      const [a] = sites;
      const n = [0, 1, 2].map((i) => a!.store.createNode({ kind: "task", title: `n${i}-${seed}` }).id);
      const base = opsOf(a!);
      for (const s of sites.slice(1)) s.store.applyOps(base);
      const keys: Array<[string, EdgeKind, string]> = [
        [n[0]!, "relates", n[1]!],
        [n[1]!, "relates", n[2]!],
        [n[0]!, "blocks", n[2]!],
      ];

      for (let step = 0; step < 45; step++) {
        const s = sites[Math.floor(r() * sites.length)]!;
        const [src, type, dst] = keys[Math.floor(r() * keys.length)]!;
        const roll = r();
        if (roll < 0.4) {
          s.store.addEdge(src, type, dst, { weight: Math.round(r() * 10) / 10 });
        } else if (roll < 0.75) {
          s.store.removeEdge(src, type, dst);
        } else {
          // Частичная доставка: случайное подмножество чужих рёберных операций.
          const from = sites[Math.floor(r() * sites.length)]!;
          if (from === s) continue;
          const subset = opsOf(from).filter((op) => isEdgeOp(op) && r() < 0.5);
          if (subset.length > 0) s.store.applyOps(subset);
        }
      }

      const all = uniqueOps(sites.flatMap(opsOf));
      const edgeOps = all.filter(isEdgeOp);
      expect(edgeOps.length).toBeGreaterThan(10);
      const oracle = merge(emptyState(), all);
      const expectedLive = keys
        .map(([src, type, dst]) => `${src}\u0000${type}\u0000${dst}`)
        .filter((k) => isEdgeAlive(oracle, k))
        .sort();

      const states = new Set<string>();
      for (let p = 0; p < 40; p++) {
        const rep = await openSite(`rep${seed}-${p}`, T0 + 9000);
        rep.store.applyOps(base);
        const order = shuffle(r, edgeOps);
        for (let i = 0; i < order.length; ) {
          const size = 1 + Math.floor(r() * 4);
          rep.store.applyOps(order.slice(i, i + size));
          i += size;
        }
        expect(liveKeys(rep)).toEqual(expectedLive);
        states.add(edgeSnapshot(rep));
        rep.driver.close();
      }
      expect(states.size).toBe(1);

      // Сами сайты после полной доставки приходят туда же.
      for (const s of sites) {
        s.store.applyOps(edgeOps);
        expect(liveKeys(s)).toEqual(expectedLive);
        expect(edgeSnapshot(s)).toBe([...states][0]!);
      }
    }
  });

  test("два конкурентных удаления одного тега: тумбстоун и deleted_at одинаковы во всех 6 порядках", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const n1 = a.store.createNode({ kind: "note", title: "n1" }).id;
    const n2 = a.store.createNode({ kind: "note", title: "n2" }).id;
    a.store.addEdge(n1, "relates", n2);
    const base = opsOf(a).filter((op) => !isEdgeOp(op));
    b.store.applyOps(opsOf(a));
    // Оба видели одно и то же добавление и оба удалили его — в разное время.
    expect(a.store.removeEdge(n1, "relates", n2)).toBe(true);
    expect(b.store.removeEdge(n1, "relates", n2)).toBe(true);
    const edgeOps = uniqueOps([...opsOf(a), ...opsOf(b)]).filter(isEdgeOp);
    expect(edgeOps.map((op) => op.op).sort()).toEqual(["edge_add", "edge_del", "edge_del"]);
    const states = new Set<string>();
    let i = 0;
    for (const order of permutations(edgeOps)) {
      const r = await openSite(`tomb${i++}`, T0 + 5000);
      r.store.applyOps(base);
      for (const op of order) r.store.applyOps([op]);
      expect(r.store.getEdge(n1, "relates", n2)?.deleted_at).not.toBeNull();
      states.add(edgeSnapshot(r));
    }
    expect(states.size).toBe(1);
  });

  test("реплика, разошедшаяся при прежней проекции, чинится один раз при импорте: строка снова функция множества", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const n1 = a.store.createNode({ kind: "note", title: "n1" }).id;
    const n2 = a.store.createNode({ kind: "note", title: "n2" }).id;
    b.store.applyOps(opsOf(a));
    a.store.addEdge(n1, "relates", n2);
    b.store.addEdge(n1, "relates", n2);
    b.store.removeEdge(n1, "relates", n2);
    a.store.applyOps(opsOf(b));
    const good = edgeSnapshot(a);
    expect(a.store.getEdge(n1, "relates", n2)?.deleted_at).toBeNull();
    // Состояние, которое оставил прежний код в порядке «a, b, del[b]»:
    // ребро мёртвое, представитель — удалённый тег b.
    const tagB = opsOf(b).find((op) => op.op === "edge_add")!.op_id;
    a.driver.run(
      {
        name: "t_old_state",
        sql: "UPDATE edges SET deleted_at = ?1, add_tag = ?2 WHERE src = ?3 AND dst = ?4",
        params: ["d", "t", "s", "x"],
      },
      [T0, tagB, n1, n2],
    );
    expect(edgeSnapshot(a)).not.toBe(good);

    const graph = join(dir, "graph");
    exportGraph(b.driver, graph);
    const first = importGraph(a.store, graph, { rebuildCache: false });
    expect(first.reprojected).toBe(1);
    expect(edgeSnapshot(a)).toBe(good);
    // Флаг в myc_meta: второй импорт ремонт не повторяет.
    expect(importGraph(a.store, graph, { rebuildCache: false }).reprojected).toBeUndefined();
    expect(a.store.reprojectEdges()).toBe(0);
  });

  test("removeEdge снимает ВСЕ наблюдённые add-теги: после удаления ребро мертво на любой реплике", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const n1 = a.store.createNode({ kind: "note", title: "n1" }).id;
    const n2 = a.store.createNode({ kind: "note", title: "n2" }).id;
    b.store.applyOps(opsOf(a));
    a.store.addEdge(n1, "relates", n2);
    b.store.addEdge(n1, "relates", n2);
    // A видел оба add и удаляет ребро целиком.
    a.store.applyOps(opsOf(b));
    expect(a.store.removeEdge(n1, "relates", n2)).toBe(true);
    const del = opsOf(a).filter((op) => op.op === "edge_del");
    expect(del.length).toBe(1);
    expect((del[0]!.value as { tags: string[] }).tags.length).toBe(2);
    b.store.applyOps(opsOf(a));
    expect(a.store.getEdge(n1, "relates", n2)?.deleted_at).not.toBeNull();
    expect(b.store.getEdge(n1, "relates", n2)?.deleted_at).not.toBeNull();
    expect(edgeSnapshot(a)).toBe(edgeSnapshot(b));
  });
});

// ---------------------------------------------------------------------------
// memory-tvw65jjgaheh — закрытие взятой задачи
// ---------------------------------------------------------------------------

/**
 * closeClaimed в редакции ДО правки — дословно: CAS-стейтмент и строка
 * op='claim', и больше ничего. Так закрыты все задачи, взятые через claim,
 * в уже существующих базах; бэкфилл обязан их догнать.
 */
function legacyCloseClaimed(store: GraphStore, id: string, holder: string, epoch: number): boolean {
  const s = store as unknown as {
    readonly ops: OpFactory;
    readonly siteId: string;
    syncTail(tx: DbDriver): void;
    journalClaim(
      tx: DbDriver,
      meta: ReturnType<OpFactory["set"]>,
      entityId: string,
      scope: string,
      action: string,
      holder: string,
      epoch: number,
      expires: number,
    ): void;
    persistSeq(tx: DbDriver): void;
  };
  return store.driver.tx("immediate", (tx) => {
    s.syncTail(tx);
    const meta = s.ops.set(id, "lease", { action: "close", holder, epoch });
    const row = tx.one<{ scope: string }>(Q.lease_close, [
      id,
      holder,
      epoch,
      meta.hlc.ts,
      meta.hlc.ts,
      packHlc(meta.hlc),
      s.siteId,
    ]);
    if (row === undefined) return false;
    s.journalClaim(tx, meta, id, row.scope, "close", holder, epoch, 0);
    s.persistSeq(tx);
    return true;
  });
}

describe("memory-tvw65jjgaheh: закрытие взятой задачи реплицируется", () => {
  test("claim → closeClaimed на A, export → import на B: на B задача closed и повторно не берётся", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const t = a.store.createNode({ kind: "task", title: "взятая и закрытая", status: "open" }).id;
    const receipt = a.store.claimNode(t, "alice")!;
    expect(a.store.closeClaimed(t, "alice", receipt.epoch)).toBe(true);

    const graph = join(dir, "graph");
    exportGraph(a.driver, graph);
    const imp = importGraph(b.store, graph, { rebuildCache: false });
    expect(imp.deferred).toEqual([]);
    expect(imp.collided).toEqual([]);

    const onB = b.store.getNode(t)!;
    expect(onB.status).toBe("closed");
    expect(onB.closed_at).toBe(a.store.getNode(t)!.closed_at);
    expect(onB.assignee).toBe("alice");
    expect(b.store.claimNode(t, "bob")).toBeUndefined();
    // Кеш проекций — функция от CRDT-состояния: побайтово равен на обеих.
    expect(renderProjectionFiles(b.driver)).toEqual(renderProjectionFiles(a.driver));
  });

  test("закрытие — LWW-запись status: более старая чужая правка статуса его не перетирает", async () => {
    const a = await openSite("siteA", T0 + 1000);
    const b = await openSite("siteB", T0);
    const t = a.store.createNode({ kind: "task", title: "t", status: "open" }).id;
    b.store.applyOps(opsOf(a));
    // B переоткрывает «в прошлом» по часам (его часы отстают), A закрывает позже.
    b.store.updateNode(t, { status: "blocked" });
    const receipt = a.store.claimNode(t, "alice")!;
    expect(a.store.closeClaimed(t, "alice", receipt.epoch)).toBe(true);
    a.store.applyOps(opsOf(b));
    b.store.applyOps(opsOf(a));
    expect(a.store.getNode(t)!.status).toBe("closed");
    expect(b.store.getNode(t)!.status).toBe("closed");
  });

  test("аренда локальна по решению: взятая, но не закрытая задача на реплике остаётся open", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const t = a.store.createNode({ kind: "task", title: "в работе", status: "open" }).id;
    expect(a.store.claimNode(t, "alice")).toBeDefined();
    expect(a.store.opsSince(0).some((row) => row.op === "claim")).toBe(true);
    const graph = join(dir, "graph");
    exportGraph(a.driver, graph);
    importGraph(b.store, graph, { rebuildCache: false });
    expect(b.store.opsSince(0).some((row) => row.op === "claim")).toBe(false);
    expect(b.store.getNode(t)!.status).toBe("open");
    expect(b.store.leaseOf(t)!.holder).toBe("");
  });

  test("бэкфилл: закрытие, журналированное старым путём (только op='claim'), догоняется экспортом", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const t = a.store.createNode({ kind: "task", title: "закрыта старым бинарём", status: "open" }).id;
    const other = a.store.createNode({ kind: "task", title: "закрыта и переоткрыта", status: "open" }).id;
    const r1 = a.store.claimNode(t, "alice")!;
    expect(legacyCloseClaimed(a.store, t, "alice", r1.epoch)).toBe(true);
    const r2 = a.store.claimNode(other, "alice")!;
    expect(legacyCloseClaimed(a.store, other, "alice", r2.epoch)).toBe(true);
    // Переоткрыта обычной LWW-правкой ПОСЛЕ закрытия: догонять нечего.
    a.store.updateNode(other, { status: "open" });
    expect(a.store.getNode(t)!.status).toBe("closed");

    const graph = join(dir, "graph");
    const ex = exportGraph(a.driver, graph, { store: a.store });
    expect(ex.backfilled).toEqual([t]);
    expect(ex.unexpressedCloses).toEqual([]);
    importGraph(b.store, graph, { rebuildCache: false });
    expect(b.store.getNode(t)!.status).toBe("closed");
    expect(b.store.getNode(t)!.closed_at).toBe(a.store.getNode(t)!.closed_at);
    expect(b.store.getNode(other)!.status).toBe("open");
    expect(b.store.claimNode(t, "bob")).toBeUndefined();

    // Идемпотентно: второй экспорт не догоняет ничего и не меняет файлов.
    const again = exportGraph(a.driver, graph, { store: a.store });
    expect(again.backfilled).toEqual([]);
    expect(again.files.written).toEqual([]);
  });

  test("бэкфилл на пути CLI как он есть: экспорт без движка называет закрытие, импорт его выражает, следующий экспорт везёт", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const t = a.store.createNode({ kind: "task", title: "закрыта старым бинарём", status: "open" }).id;
    const r = a.store.claimNode(t, "alice")!;
    expect(legacyCloseClaimed(a.store, t, "alice", r.epoch)).toBe(true);
    const graph = join(dir, "graph");

    // `myc export` зовёт exportGraph(h.driver, dir): движка нет — не промолчать.
    const first = exportGraph(a.driver, graph);
    expect(first.backfilled).toEqual([]);
    expect(first.unexpressedCloses).toEqual([t]);
    importGraph(b.store, graph, { rebuildCache: false });
    expect(b.store.getNode(t)!.status).toBe("open");

    // `myc import` на закрывшей машине (pull → import) выражает закрытие…
    const imp = importGraph(a.store, graph, { rebuildCache: false });
    expect(imp.backfilled).toEqual([t]);
    // …и следующий `myc export` везёт его на реплику.
    const second = exportGraph(a.driver, graph);
    expect(second.unexpressedCloses).toEqual([]);
    importGraph(b.store, graph, { rebuildCache: false });
    expect(b.store.getNode(t)!.status).toBe("closed");
    expect(b.store.claimNode(t, "bob")).toBeUndefined();
    expect(importGraph(a.store, graph, { rebuildCache: false }).backfilled).toEqual([]);
  });
});

describe("memory-tvw65jjgaheh: переезд задачи, закрытой старым путём", () => {
  test("закрытие одной строкой claim едет с историей: в приёмнике задача закрыта, повтор идемпотентен", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    const t = a.store.createNode({ kind: "task", scope: "aaa", title: "переезжает закрытой", status: "open" }).id;
    const r = a.store.claimNode(t, "alice")!;
    expect(legacyCloseClaimed(a.store, t, "alice", r.epoch)).toBe(true);
    const plan = planMove(a, t, "aaa", "bbb");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    executeMove(a, b, plan);
    expect(b.store.getNode(t)!.status).toBe("closed");
    expect(b.store.getNode(t)!.closed_at).toBe(a.store.getNode(t)!.closed_at);
    expect(a.store.backfillClaimCloses()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// memory-0fs4rfa6xmha — контент-дубликат
// ---------------------------------------------------------------------------

describe("memory-0fs4rfa6xmha: контент-дубликат не ломает синхронизацию", () => {
  async function twoSitesWithSameText(): Promise<{ a: Site; b: Site; na: string; nb: string; other: string }> {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    // Старший узел нарочно с БОЛЬШИМ id: правило «канон у меньшего id» было
    // бы детерминированным, но другим, и тест обязан его отличить.
    const na = a.store.createNode({ id: "myc-zzzzzzzzzzz1", kind: "note", scope: "s", title: "одинаковый факт", body: "тело" }).id;
    const other = a.store.createNode({ kind: "note", scope: "s", title: "другой факт" }).id;
    const nb = b.store.createNode({ id: "myc-000000000001", kind: "note", scope: "s", title: "одинаковый факт", body: "тело" }).id;
    return { a, b, na, nb, other };
  }

  test("один и тот же текст на двух сайтах: applyOps не падает, остальное применяется, победитель один на обеих", async () => {
    const { a, b, na, nb, other } = await twoSitesWithSameText();
    const opsA = opsOf(a);
    const opsB = opsOf(b);
    const rb = b.store.applyOps(opsA);
    const ra = a.store.applyOps(opsB);
    for (const s of [a, b]) {
      expect(s.store.getNode(na)).toBeDefined();
      expect(s.store.getNode(nb)).toBeDefined();
      expect(s.store.getNode(other)).toBeDefined();
    }
    const canon = contentHash("note", "одинаковый факт", "тело");
    const hashes = (s: Site): string[] => [na, nb].map((id) => s.store.getNode(id)!.content_hash);
    expect(hashes(a)).toEqual(hashes(b));
    // Каноническим остаётся узел, созданный раньше (часы set(kind)): na.
    expect(hashes(a)[0]).toBe(canon);
    expect(hashes(a)[1]).not.toBe(canon);
    // Громко: в результате применения и в запросе для doctor.
    expect(rb.duplicates).toEqual([{ id: nb, of: na }]);
    expect(ra.duplicates).toEqual([{ id: nb, of: na }]);
    expect(b.store.contentDuplicates()).toEqual([{ id: nb, of: na, scope: "s", kind: "note" }]);
  });

  test("повторная синхронизация после дубликата не падает (раньше каждый следующий import падал тем же исключением)", async () => {
    const { a, b, na, nb } = await twoSitesWithSameText();
    const graph = join(dir, "graph");
    exportGraph(a.driver, graph);
    const first = importGraph(b.store, graph, { rebuildCache: false });
    expect(first.duplicates).toEqual([{ id: nb, of: na }]);
    const second = importGraph(b.store, graph, { rebuildCache: false });
    expect(second.fresh).toBe(0);
    expect(b.store.getNode(na)).toBeDefined();
  });

  test("победитель удалён — канон переходит к следующему одинаково на всех репликах, в любом порядке", async () => {
    const { a, b, na, nb } = await twoSitesWithSameText();
    const c = await openSite("siteC", T0 + 2000);
    const nc = c.store.createNode({ id: "myc-000000000000", kind: "note", scope: "s", title: "одинаковый факт", body: "тело" }).id;
    b.store.applyOps(opsOf(a));
    b.store.deleteNode(na);
    const all = uniqueOps([...opsOf(a), ...opsOf(b), ...opsOf(c)]);
    const canon = contentHash("note", "одинаковый факт", "тело");
    const states = new Set<string>();
    for (let p = 0; p < 12; p++) {
      const rep = await openSite(`dup${p}`, T0 + 9000);
      const order = shuffle(rng(p + 1), all);
      for (let i = 0; i < order.length; i += 3) rep.store.applyOps(order.slice(i, i + 3));
      const got = [na, nb, nc].map((id) => rep.store.getNode(id, true)!.content_hash);
      states.add(JSON.stringify(got));
      // na удалён, среди живых nb старше nc — канон у nb.
      expect(got[1]).toBe(canon);
      expect(got[2]).not.toBe(canon);
      rep.driver.close();
    }
    expect(states.size).toBe(1);
  });

  test("восстановление узла в занятую группу приезжает отдельным пакетом: UPDATE колонки не упирается в UNIQUE", async () => {
    const a = await openSite("siteA", T0);
    const b = await openSite("siteB", T0 + 1000);
    // B первым записал текст; A — тот же текст, удалил и потом восстановил.
    const y = b.store.createNode({ id: "myc-000000000001", kind: "note", scope: "s", title: "одинаковый факт", body: "тело" }).id;
    const x = a.store.createNode({ id: "myc-zzzzzzzzzzz1", kind: "note", scope: "s", title: "одинаковый факт", body: "тело" }).id;
    a.store.deleteNode(x);
    const beforeRestore = opsOf(a);
    a.store.restoreNode(x);
    const restore = opsOf(a).filter((op) => !beforeRestore.some((o) => o.op_id === op.op_id));
    expect(restore.map((op) => op.field)).toEqual(["deleted_at"]);

    // Пакет 1: создание и удаление — x вне индекса, держит канон, как и y.
    b.store.applyOps(beforeRestore);
    expect(b.store.getNode(x, true)!.deleted_at).not.toBeNull();
    // Пакет 2: восстановление — x входит в группу, где канон у y.
    const r = b.store.applyOps(restore);
    expect(r.applied).toBe(1);
    const canon = contentHash("note", "одинаковый факт", "тело");
    // x старше (часы A раньше) — канон переходит к нему, y понижен.
    expect(b.store.getNode(x)!.content_hash).toBe(canon);
    expect(b.store.getNode(y)!.content_hash).not.toBe(canon);
    expect(r.duplicates).toEqual([{ id: y, of: x }]);
  });

  test("myc_health 'sync.duplicates': degraded при дубликате, ok после разрешения; правка без дубликатов его не пишет", async () => {
    const { a, b, na, nb } = await twoSitesWithSameText();
    const health = (s: Site): { state: string; detail: string } | undefined =>
      s.driver.one(
        {
          name: "t_health",
          sql: "SELECT state, detail FROM myc_health WHERE component = 'sync.duplicates'",
          params: [],
        },
        [],
      );
    // Обычная правка текста на базе без дубликатов строку здоровья не заводит:
    // полный проход по nodes не имеет права стоять в каждой записи.
    const solo = a.store.createNode({ kind: "note", scope: "s", title: "один" }).id;
    a.store.updateNode(solo, { title: "один, правка" });
    a.store.deleteNode(solo);
    a.store.restoreNode(solo);
    expect(health(a)).toBeUndefined();

    b.store.applyOps(opsOf(a));
    expect(health(b)).toMatchObject({ state: "degraded", detail: JSON.stringify({ duplicates: 1 }) });
    // Проигравший удалён — дубликата больше нет, и это тоже видно.
    b.store.deleteNode(nb);
    expect(health(b)).toMatchObject({ state: "ok", detail: JSON.stringify({ duplicates: 0 }) });
    expect(b.store.contentDuplicates()).toEqual([]);
    expect(b.store.getNode(na)!.content_hash).toBe(contentHash("note", "одинаковый факт", "тело"));
  });

  test("группа контента и добавления ребра читаются по индексам, без SCAN", async () => {
    const a = await openSite("siteA", T0);
    const plan = (sql: string, ...params: string[]): string =>
      (a.driver.database.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");
    const group = plan(Q.content_group.sql, "s", "note", "a", "b");
    expect(group).toContain("ux_nodes_content");
    expect(group).not.toMatch(/SCAN n\b/);
    const adds = plan(Q.edge_adds_of.sql, "x|relates|y");
    expect(adds).toContain("ix_oplog_entity");
    expect(adds).not.toMatch(/\bSCAN\b/);
  });

  test("локальная правка, дающая дубликат, по-прежнему отвергается — локальный запрет не ослаблен", async () => {
    const a = await openSite("siteA", T0);
    a.store.createNode({ kind: "note", scope: "s", title: "x", body: "тело" });
    const y = a.store.createNode({ kind: "note", scope: "s", title: "y", body: "тело" }).id;
    expect(() => a.store.updateNode(y, { title: "x" })).toThrow(/UNIQUE|duplicate/);
    expect(a.store.getNode(y)!.title).toBe("y");
  });
});

// ---------------------------------------------------------------------------
// memory-nvx51d0kgf2t — oplog_pending
// ---------------------------------------------------------------------------

describe("memory-nvx51d0kgf2t: отложенная операция не застревает", () => {
  async function corpus(): Promise<{ a: Site; n: string; m: string; edge: Op; nodeOps: (id: string) => Op[] }> {
    const a = await openSite("siteA", T0);
    const n = a.store.createNode({ kind: "task", title: "n" }).id;
    const m = a.store.createNode({ kind: "note", title: "m" }).id;
    a.store.addEdge(n, "relates", m);
    const ops = opsOf(a);
    const edge = ops.find((op) => op.op === "edge_add")!;
    return { a, n, m, edge, nodeOps: (id) => ops.filter((op) => op.entity_id === id) };
  }

  test("узел пришёл не через applyOps: отложенное ребро перекладывается и применяется, когда придёт второй конец", async () => {
    const { n, m, edge, nodeOps } = await corpus();
    const b = await openSite("siteB", T0 + 1000);
    expect(b.store.applyOps([edge]).deferred).toEqual([edge.op_id]);
    expect(b.store.pendingOps()[0]).toMatchObject({ needs: n });

    // Конец n появляется ЛОКАЛЬНО (любой путь, кроме applyOps).
    b.store.createNode({ id: n, kind: "task", title: "n" });
    expect(b.store.pendingOps().map((p) => p.needs)).toEqual([m]);

    // Повторная доставка ребра — ключ ожидания обязан обновиться, а не залипнуть.
    b.store.applyOps([edge]);
    expect(b.store.pendingOps().map((p) => p.needs)).toEqual([m]);

    const r = b.store.applyOps(nodeOps(m));
    expect(r.released).toEqual([edge.op_id]);
    expect(b.store.pendingCount()).toBe(0);
    expect(b.store.getEdge(n, "relates", m)?.deleted_at).toBeNull();
  });

  test("операция, применённая повторной доставкой, не остаётся фантомом в pendingCount", async () => {
    const { n, m, edge, nodeOps } = await corpus();
    const b = await openSite("siteB", T0 + 1000);
    b.store.applyOps(nodeOps(m));
    expect(b.store.applyOps([edge]).deferred).toEqual([edge.op_id]);
    // Узел n — локально, мимо applyOps; затем ребро доставлено ещё раз.
    b.store.createNode({ id: n, kind: "task", title: "n" });
    b.store.applyOps([edge]);
    expect(b.store.getEdge(n, "relates", m)?.deleted_at).toBeNull();
    expect(b.store.pendingCount()).toBe(0);
    expect(b.store.pendingOps()).toEqual([]);
  });

  test("фантом (операция уже в оплоге) не считается ни pendingCount, ни pendingOps — ещё до всякого applyOps", async () => {
    const { n, m, edge, nodeOps } = await corpus();
    const b = await openSite("siteB", T0 + 1000);
    b.store.applyOps([...nodeOps(n), ...nodeOps(m), edge]);
    expect(b.store.getEdge(n, "relates", m)?.deleted_at).toBeNull();
    // Строка ожидания, пережившая применение своей операции (база старого
    // кода), с ключом узла, которого нет: дренаж её не отпустит никогда.
    b.driver.run(Q.pending_insert, [edge.op_id, "myc-nosuchnode0", 0, JSON.stringify(edge), T0]);
    expect(b.store.pendingCount()).toBe(0);
    expect(b.store.pendingOps()).toEqual([]);
    // Первый же applyOps её вычищает, повторного применения нет.
    const r = b.store.applyOps([]);
    expect(r.applied).toBe(0);
    expect(b.driver.one<{ n: number }>({ name: "t_pc", sql: "SELECT count(*) AS n FROM oplog_pending", params: [] }, [])?.n).toBe(0);
  });

  test("повторная доставка отложенной операции, чей узел уже есть: применена один раз и отпущена, повтором не посчитана", async () => {
    const { n, m, edge, nodeOps } = await corpus();
    const b = await openSite("siteB", T0 + 1000);
    b.store.applyOps([...nodeOps(n), ...nodeOps(m)]);
    b.driver.run(Q.pending_insert, [edge.op_id, n, 0, JSON.stringify(edge), T0]);
    const r = b.store.applyOps([edge]);
    expect(r.applied).toBe(1);
    expect(r.duplicate).toBe(0);
    expect(r.released).toEqual([edge.op_id]);
    expect(r.deferred).toEqual([]);
    expect(b.store.pendingCount()).toBe(0);
  });

  test("база с уже застрявшей строкой (узел давно есть) лечится первым же applyOps", async () => {
    const { n, m, edge, nodeOps } = await corpus();
    const b = await openSite("siteB", T0 + 1000);
    b.store.applyOps([...nodeOps(n), ...nodeOps(m)]);
    // Строка, оставленная прежним кодом: узлы на месте, операция всё ждёт.
    b.driver.run(Q.pending_insert, [edge.op_id, n, 0, JSON.stringify(edge), T0]);
    expect(b.store.getEdge(n, "relates", m)).toBeUndefined();
    const r = b.store.applyOps([]);
    expect(r.released).toEqual([edge.op_id]);
    expect(b.store.pendingCount()).toBe(0);
    expect(b.store.getEdge(n, "relates", m)?.deleted_at).toBeNull();
  });
});
