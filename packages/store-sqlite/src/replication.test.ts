/**
 * Репликация между сайтами: myc-qie.7 (seq без полного прохода оплога),
 * myc-9ok (все поля узла доезжают до реплики), myc-qie.9 (пакет операций
 * в любом порядке, ребро раньше своих концов).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlcClock, NODE_FIELDS, generateId, type Op } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, Q, rowToOp } from "./queries.ts";

let dir: string;
const drivers: SqliteDriver[] = [];

function testClock(startMs: number): HlcClock {
  let t = startMs;
  return new HlcClock({ now: () => (t += 1) });
}

interface Site {
  readonly store: GraphStore;
  readonly driver: SqliteDriver;
}

async function openSite(siteId: string, actor: string, startMs = 1_700_000_000_000): Promise<Site> {
  const driver = openSqlite(join(dir, `${siteId}.db`));
  drivers.push(driver);
  await migrate(driver.database, { migrations, writable: true });
  const store = new GraphStore(driver, {
    siteId,
    actor,
    newId: () => generateId(),
    clock: testClock(startMs),
    now: () => startMs,
  });
  return { store, driver };
}

/** Все операции сайта в порядке журнала. */
function opsOf(site: Site): Op[] {
  return site.store.opsSince(0, 100_000).map(rowToOp);
}

/** Сравнимый срез состояния: реплицируемые поля узлов, счётчик, живые рёбра. */
function snapshot(site: Site): string {
  const nodes = site.driver
    .all<Record<string, unknown>>(
      { name: "t_nodes", sql: "SELECT * FROM nodes ORDER BY id", params: [] },
      [],
    )
    .map((row) => {
      const out: Record<string, unknown> = { id: row.id, seen_count: row.seen_count, attrs: row.attrs };
      for (const spec of NODE_FIELDS) out[spec.field] = row[spec.column];
      return out;
    });
  const edges = site.driver.all<Record<string, unknown>>(
    {
      name: "t_edges",
      sql: "SELECT src, type, dst, weight, add_tag, deleted_at FROM edges ORDER BY src, type, dst",
      params: [],
    },
    [],
  );
  return JSON.stringify({ nodes, edges });
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let x = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-repl-"));
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
// myc-qie.7 — последний seq сайта без полного прохода оплога
// ---------------------------------------------------------------------------

describe("myc-qie.7: последний seq сайта", () => {
  test("план запроса — спуск по индексу, без SCAN и TEMP B-TREE", async () => {
    const a = await openSite("siteA", "alice");
    const plan = a.driver.database
      .query(`EXPLAIN QUERY PLAN ${Q.oplog_last_local_op_id.sql}`)
      .all("siteA") as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join(" | ");
    expect(text).toContain("ix_oplog_site");
    expect(text).not.toMatch(/\bSCAN\b/);
    expect(text).not.toContain("TEMP B-TREE");
  });

  test("конструктор восстанавливает seq из оплога, когда myc_meta.last_seq потерян", async () => {
    let a = await openSite("siteA", "alice");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(a.store.createNode({ kind: "note", title: `узел ${i}` }).id);
    a.store.addEdge(ids[0]!, "relates", ids[1]!);
    const trueSeq = a.store.lastSeq;
    expect(trueSeq).toBeGreaterThan(30);

    // Чужие операции с более поздними часами seq сайта не двигают.
    const b = await openSite("siteB", "bob", 1_900_000_000_000);
    b.store.createNode({ kind: "note", title: "чужой" });
    a.store.applyOps(opsOf(b));
    expect(a.store.lastSeq).toBe(trueSeq);

    // Внешняя правка базы снесла myc_meta.last_seq.
    a.driver.database.exec("DELETE FROM myc_meta WHERE key = 'last_seq'");
    a.driver.close();
    a = await openSite("siteA", "alice");
    expect(a.store.lastSeq).toBe(trueSeq);
    // и следующий op_id не сталкивается с уже записанным
    const node = a.store.createNode({ kind: "note", title: "после потери meta" });
    expect(a.store.getNode(node.id)?.title).toBe("после потери meta");
    expect(a.store.lastSeq).toBeGreaterThan(trueSeq);
  });

  test("собственная операция, вернувшаяся чужим путём (origin=0), тоже занимает seq", async () => {
    const a = await openSite("siteA", "alice");
    a.store.createNode({ kind: "note", title: "локально" });
    const own = a.store.lastSeq;
    // Как при импорте своего же лога с другой машины: ops сайта A c origin=0.
    const b = await openSite("siteA", "alice", 1_800_000_000_000);
    b.store.createNode({ kind: "note", title: "на другой машине под тем же site_id" });
    const returned = opsOf(b).filter((op) => op.seq > own);
    // seq у b начинались с 0, поэтому сдвигаем их за хвост a вручную:
    const shifted = returned.map((op) => ({
      ...op,
      seq: op.seq + own,
      op_id: `siteA:${op.seq + own}`,
    })) as Op[];
    a.store.applyOps(shifted, 0);
    a.driver.database.exec("DELETE FROM myc_meta WHERE key = 'last_seq'");
    a.driver.close();
    const again = await openSite("siteA", "alice");
    expect(again.store.lastSeq).toBe(own + returned.length);
  });
});

// ---------------------------------------------------------------------------
// myc-9ok — все поля узла доезжают до реплики
// ---------------------------------------------------------------------------

describe("myc-9ok: репликация полей узла", () => {
  test("узел с умолчаниями и узел с явными полями равны на реплике по всем NODE_FIELDS, attrs и seen_count", async () => {
    const a = await openSite("siteA", "alice");
    const b = await openSite("siteB", "bob", 1_800_000_000_000);
    a.store.createNode({ kind: "note", title: "по умолчанию" });
    a.store.createNode({
      kind: "task",
      title: "явные поля",
      body: "тело",
      scope: "proj",
      status: "open",
      priority: 1,
      confidence: 0.5,
      salience: 0.7,
      acl: "private",
      owner_id: "u1",
      team_id: "t1",
      agent_id: "ag1",
      assignee: "carol",
      actor: "explicit-actor",
      due_at: 42,
      attrs: { topic: "x" },
    });
    const r = b.store.applyOps(opsOf(a));
    expect(r.deferred).toEqual([]);
    expect(r.collided).toEqual([]);
    expect(snapshot(b)).toBe(snapshot(a));

    // Точечно: actor у узла без явного actor — это actor создателя, не пустая строка.
    const rows = b.driver.all<{ title: string; actor: string }>(
      { name: "t_actor", sql: "SELECT title, actor FROM nodes ORDER BY title", params: [] },
      [],
    );
    expect(rows).toEqual([
      { title: "по умолчанию", actor: "alice" },
      { title: "явные поля", actor: "explicit-actor" },
    ]);
  });

  test("createNode минтит ровно одну set(actor) на узел", async () => {
    const a = await openSite("siteA", "alice");
    a.store.createNode({ kind: "note", title: "раз" });
    a.store.createNode({ kind: "note", title: "два", actor: "явный" });
    const actorOps = opsOf(a).filter((op) => op.op === "set" && op.field === "actor");
    expect(actorOps.map((op) => op.value)).toEqual(["alice", "явный"]);
  });

  test("actor участвует в LWW как обычное поле: чужая более поздняя правка побеждает", async () => {
    const a = await openSite("siteA", "alice");
    const b = await openSite("siteB", "bob", 1_800_000_000_000);
    const node = a.store.createNode({ kind: "note", title: "n" });
    b.store.applyOps(opsOf(a));
    b.store.updateNode(node.id, { actor: "bob-later" });
    a.store.applyOps(opsOf(b));
    expect(a.store.getNode(node.id)?.actor).toBe("bob-later");
  });
});

// ---------------------------------------------------------------------------
// myc-qie.9 — пакет в любом порядке, ребро раньше своих концов
// ---------------------------------------------------------------------------

describe("myc-qie.9: порядок операций между пакетами", () => {
  async function corpus(): Promise<{ a: Site; ops: Op[]; ids: string[] }> {
    const a = await openSite("siteA", "alice");
    const ids = [
      a.store.createNode({ kind: "task", title: "t1", scope: "s" }).id,
      a.store.createNode({ kind: "task", title: "t2", scope: "s" }).id,
      a.store.createNode({ kind: "note", title: "n3", scope: "s", body: "тело" }).id,
    ];
    a.store.addEdge(ids[0]!, "blocks", ids[1]!);
    a.store.addEdge(ids[2]!, "relates", ids[0]!, { weight: 0.5 });
    a.store.updateNode(ids[1]!, { title: "t2 переименован" });
    a.store.removeEdge(ids[2]!, "relates", ids[0]!);
    a.store.bumpCounter(ids[0]!, "seen_count");
    return { a, ops: opsOf(a), ids };
  }

  test("ребро первым в одном пакете: без ошибки, состояние равно упорядоченному", async () => {
    const { a, ops } = await corpus();
    const isEdge = (op: Op): boolean => op.op === "edge_add" || op.op === "edge_del";
    const edgesFirst = [...ops.filter(isEdge), ...ops.filter((op) => !isEdge(op))];
    const b = await openSite("siteB", "bob", 1_800_000_000_000);
    const r = b.store.applyOps(edgesFirst);
    expect(r.deferred).toEqual([]);
    expect(r.applied).toBe(ops.length);
    expect(b.store.pendingCount()).toBe(0);
    expect(snapshot(b)).toBe(snapshot(a));
  });

  test("20 случайных перестановок, каждая нарезана на пакеты по 3: итог одинаков, отложенное не теряется", async () => {
    const { a, ops } = await corpus();
    const expected = snapshot(a);
    for (let seed = 1; seed <= 20; seed++) {
      const b = await openSite(`siteB${seed}`, "bob", 1_800_000_000_000);
      const order = shuffle(ops, seed);
      // Более старая правка того же поля, пришедшая позже, — stale по LWW:
      // это не потеря, итоговое состояние то же.
      let applied = 0;
      const deferredSeen = new Set<string>();
      const released = new Set<string>();
      for (let i = 0; i < order.length; i += 3) {
        const r = b.store.applyOps(order.slice(i, i + 3));
        applied += r.applied + r.stale;
        for (const id of r.deferred) deferredSeen.add(id);
        for (const id of r.released) released.add(id);
        expect(r.collided).toEqual([]);
      }
      expect(applied).toBe(ops.length);
      expect(b.store.pendingCount()).toBe(0);
      // Всё, что откладывалось, потом было отпущено — и видно в результате.
      for (const id of deferredSeen) expect(released.has(id)).toBe(true);
      expect(snapshot(b)).toBe(expected);
    }
  });

  test("ребро в пакете раньше узлов из следующего пакета: паркуется, видно в pendingOps, применяется при появлении концов", async () => {
    const { a, ops, ids } = await corpus();
    const b = await openSite("siteB", "bob", 1_800_000_000_000);
    const edgeAdd = ops.find((op) => op.op === "edge_add" && op.entity_id.includes(ids[1]!))!;

    const first = b.store.applyOps([edgeAdd]);
    expect(first.applied).toBe(0);
    expect(first.deferred).toEqual([edgeAdd.op_id]);
    expect(b.store.oplogCount()).toBe(0);
    expect(b.store.pendingCount()).toBe(1);
    expect(b.store.pendingOps()[0]).toMatchObject({ needs: ids[0], origin: 0 });

    // Первый конец приехал — ребро перекладывается на второй.
    const n0 = ops.filter((op) => op.entity_id === ids[0]);
    const second = b.store.applyOps(n0);
    expect(second.released).toEqual([]);
    expect(b.store.pendingOps()[0]).toMatchObject({ needs: ids[1] });

    // Второй конец — ребро применяется в той же транзакции и отпускается.
    const n1 = ops.filter((op) => op.entity_id === ids[1]);
    const third = b.store.applyOps(n1);
    expect(third.released).toEqual([edgeAdd.op_id]);
    expect(third.applied).toBe(n1.length + 1);
    expect(b.store.pendingCount()).toBe(0);
    expect(b.store.getEdge(ids[0]!, "blocks", ids[1]!)).toBeDefined();
    expect(b.store.getNode(ids[1]!)?.open_blockers).toBe(1);
    void a;
  });

  test("цепочка: ребро ждёт узел, узел ждёт kind — раскручивается одним пакетом", async () => {
    const { ops, ids } = await corpus();
    const b = await openSite("siteB", "bob", 1_800_000_000_000);
    const edgeAdd = ops.find((op) => op.op === "edge_add" && op.entity_id.includes(ids[1]!))!;
    const kindOf = (id: string): Op => ops.find((op) => op.entity_id === id && op.field === "kind")!;
    const restOf = (id: string): Op[] =>
      ops.filter((op) => op.entity_id === id && op.field !== "kind" && op.op !== "edge_add" && op.op !== "edge_del");

    const r1 = b.store.applyOps([edgeAdd, ...restOf(ids[0]!), ...restOf(ids[1]!)]);
    expect(r1.applied).toBe(0);
    expect(new Set(r1.deferred).size).toBe(1 + restOf(ids[0]!).length + restOf(ids[1]!).length);
    expect(b.store.pendingCount()).toBe(r1.deferred.length);

    const r2 = b.store.applyOps([kindOf(ids[0]!), kindOf(ids[1]!)]);
    expect(r2.applied).toBe(2 + r1.deferred.length);
    expect(new Set(r2.released)).toEqual(new Set(r1.deferred));
    expect(b.store.pendingCount()).toBe(0);
    expect(b.store.getNode(ids[1]!)?.title).toBe("t2 переименован");
    expect(b.store.getEdge(ids[0]!, "blocks", ids[1]!)).toBeDefined();
  });

  test("отложенное переживает переоткрытие базы и повтор доставки не дублирует его", async () => {
    const { ops, ids } = await corpus();
    let b = await openSite("siteB", "bob", 1_800_000_000_000);
    const edgeAdd = ops.find((op) => op.op === "edge_add" && op.entity_id.includes(ids[1]!))!;
    b.store.applyOps([edgeAdd]);
    b.store.applyOps([edgeAdd]);
    expect(b.store.pendingCount()).toBe(1);
    b.driver.close();

    b = await openSite("siteB", "bob", 1_800_000_000_000);
    expect(b.store.pendingCount()).toBe(1);
    const nodes = ops.filter((op) => op.op !== "edge_add" && op.op !== "edge_del");
    const r = b.store.applyOps(nodes);
    expect(r.released).toEqual([edgeAdd.op_id]);
    expect(b.store.pendingCount()).toBe(0);
    expect(b.store.getEdge(ids[0]!, "blocks", ids[1]!)).toBeDefined();
    // повтор — уже дубликат по op_id, не второе применение
    const again = b.store.applyOps([edgeAdd]);
    expect(again.duplicate).toBe(1);
    expect(again.applied).toBe(0);
  });

  test("[мутационная проверка] без парковки ребро-сирота роняло бы весь пакет по FOREIGN KEY", async () => {
    const { ops, ids } = await corpus();
    const b = await openSite("siteB", "bob", 1_800_000_000_000);
    const edgeAdd = ops.find((op) => op.op === "edge_add")!;
    // Прямая вставка сироты — так падала старая версия applyOps.
    expect(() =>
      b.driver.run(Q.edge_insert, [ids[0], "blocks", ids[1], 1, edgeAdd.op_id, "", 0, 0, "siteA", null, "{}"]),
    ).toThrow(/FOREIGN KEY/);
    // Через applyOps — не падает и не теряется.
    expect(() => b.store.applyOps([edgeAdd])).not.toThrow();
    expect(b.store.pendingCount()).toBe(1);
  });
});
