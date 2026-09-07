/**
 * R4: переезд задачи между воркспейсами — движок над двумя базами.
 *
 * Здесь проверяется то, что видно и в одном процессе: что именно уезжает,
 * что остаётся, идемпотентность повтора и четыре отказа. Инварианты МЕЖДУ
 * процессами (обрыв посреди переезда, два одновременных переезда) живут в
 * packages/cli/src/commands/move.multiprocess.test.ts на настоящих Bun.spawn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, MOVED_FROM_KEY } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";
import { executeMove, planMove, strandedArrivals } from "./move.ts";

interface Ws {
  readonly driver: SqliteDriver;
  readonly store: GraphStore;
  readonly scope: string;
}

let dir: string;
let open: SqliteDriver[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-move-"));
});

afterEach(() => {
  for (const d of open) {
    try {
      d.close();
    } catch {
      // уже закрыто
    }
  }
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

async function makeWs(name: string, scope: string): Promise<Ws> {
  const driver = openSqlite(join(dir, `${name}.db`));
  open.push(driver);
  await migrate(driver.database, { migrations, writable: true });
  const store = new GraphStore(driver, {
    siteId: `site-${name}`,
    actor: "tester",
    newId: () => generateId(scope === "" ? "myc" : scope),
  });
  return { driver, store, scope };
}

function task(ws: Ws, title: string, extra: Record<string, unknown> = {}): string {
  return ws.store.createNode({
    kind: "task",
    scope: ws.scope,
    title,
    status: "open",
    ...extra,
  }).id;
}

/** Что видит `ready` — тот же частичный индекс, что и боевой запрос. */
function readyIds(ws: Ws, scope = ws.scope): string[] {
  return ws.driver.database
    .query(
      `SELECT id FROM nodes
        WHERE scope = ? AND kind='task' AND status='open'
          AND open_blockers = 0 AND deleted_at IS NULL
        ORDER BY id`,
    )
    .all(scope)
    .map((r) => (r as { id: string }).id);
}

function opIds(ws: Ws, entity: string): string[] {
  return ws.driver.database
    .query(`SELECT op_id FROM oplog WHERE entity_id = ? ORDER BY seq`)
    .all(entity)
    .map((r) => (r as { op_id: string }).op_id);
}

describe("R4 переезд: идентичность и оплог", () => {
  test("после переезда ready в приёмнике видит её обычной задачей, а история цела", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "переезжающая");
    a.store.updateNode(id, { title: "переезжающая v2", priority: 1 });
    a.store.bumpCounter(id, "seen_count", 2);
    const sourceOps = opIds(a, id);

    const plan = planMove(a, id, a.scope, b.scope);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = executeMove(a, b, plan);

    // Задача в приёмнике — обычная: тот же id, та же голова, тот же счётчик.
    const moved = b.store.getNode(id);
    expect(moved).toBeDefined();
    expect(moved!.title).toBe("переезжающая v2");
    expect(moved!.priority).toBe(1);
    expect(moved!.scope).toBe("bbb");
    expect(moved!.seen_count).toBe(3);
    expect(readyIds(b)).toEqual([id]);

    // Источник её больше не видит, но строка на месте — надгробие.
    expect(readyIds(a)).toEqual([]);
    const tomb = a.store.getNode(id);
    expect(tomb).toBeDefined();
    expect(tomb!.scope).toBe("bbb");
    expect(tomb!.attrs[MOVED_FROM_KEY]).toBe("aaa");

    // Оплог перенесён ДОСЛОВНО: те же op_id, ни один не потерян.
    const targetOps = new Set(opIds(b, id));
    for (const op of sourceOps) expect(targetOps.has(op)).toBe(true);
    expect(result.applied).toBeGreaterThan(0);
    expect(result.minted).toBe(1);
    expect(result.resumed).toBe(false);
  });

  test("повтор ничего не меняет: op_id уникален, всё уходит в duplicate", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "дважды");

    const first = planMove(a, id, a.scope, b.scope);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    executeMove(a, b, first);
    const rowsAfterFirst = b.store.oplogCount();

    const second = planMove(a, id, a.scope, b.scope);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const again = executeMove(a, b, second);

    expect(again.applied).toBe(0);
    expect(again.minted).toBe(0);
    expect(again.resumed).toBe(true);
    expect(b.store.oplogCount()).toBe(rowsAfterFirst);
    expect(readyIds(b)).toEqual([id]);
  });

  test("цепочка версий едет целиком, спрошенная с любого звена", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const v1 = task(a, "версия 1");
    const v2 = task(a, "версия 2");
    a.store.addEdge(v2, "supersedes", v1);
    a.store.updateNode(v1, { head_id: v2 });

    const plan = planMove(a, v1, a.scope, b.scope);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.members).toEqual([v1, v2].sort());
    executeMove(a, b, plan);

    expect(b.store.getNode(v1)).toBeDefined();
    expect(b.store.getNode(v2)).toBeDefined();
    expect(b.store.getNode(v1)!.head_id).toBe(v2);
    expect(b.store.edgesFrom(v2, "supersedes").map((e) => e.dst)).toEqual([v1]);
  });

  test("рёбра, чей второй конец остался, держит надгробие, а в приёмник не едут", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "переезжает");
    const stays = task(a, "остаётся");
    a.store.addEdge(id, "relates", stays);

    const plan = planMove(a, id, a.scope, b.scope);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.staying).toEqual([`${id}|relates|${stays}`]);
    expect(plan.edges).toEqual([]);
    executeMove(a, b, plan);

    // В источнике ребро живо: оба его конца там есть (второй — надгробие).
    expect(a.store.edgesFrom(id, "relates").map((e) => e.dst)).toEqual([stays]);
    // В приёмнике второго конца нет, поэтому и ребра нет — и ничего не
    // повисло в отложенных.
    expect(b.store.edgesFrom(id, "relates")).toEqual([]);
    expect(b.store.pendingCount()).toBe(0);
  });
});

describe("R4 защиты", () => {
  test("живой blocks через границу — отказ (иначе приёмник покажет задачу готовой)", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const blocker = task(a, "блокер");
    const blocked = task(a, "заблокированная");
    a.store.addEdge(blocker, "blocks", blocked);
    expect(a.store.getNode(blocked)!.open_blockers).toBe(1);

    const plan = planMove(a, blocked, a.scope, b.scope);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("cross_boundary");
    expect(plan.crossing).toEqual([{ src: blocker, dst: blocked }]);
    // Приёмник не тронут.
    expect(b.store.getNode(blocked)).toBeUndefined();
  });

  test("ВРЕД, который снимает эта защита: приёмник показал бы задачу готовой", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const blocker = task(a, "блокер остаётся дома");
    const blocked = task(a, "уехала одна");
    a.store.addEdge(blocker, "blocks", blocked);

    // План, каким он был бы БЕЗ отказа: едет только названный узел.
    const full = planMove(a, blocked, a.scope, b.scope, { withBlockers: true });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const solo = {
      ...full,
      members: [blocked],
      edges: [],
      staying: [`${blocker}|blocks|${blocked}`],
      ops: full.ops.filter((r) => r.entity_id === blocked),
    };
    executeMove(a, b, solo);

    // Блокер жив и открыт в источнике, а приёмник считает задачу готовой:
    // ребро blocks через границу не считается нигде.
    expect(a.store.getNode(blocker)!.status).toBe("open");
    expect(b.store.getNode(blocked)!.open_blockers).toBe(0);
    expect(readyIds(b)).toEqual([blocked]);
  });

  test("--with-blockers увозит связный кусок, и open_blockers в приёмнике сходится", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const blocker = task(a, "блокер");
    const blocked = task(a, "заблокированная");
    a.store.addEdge(blocker, "blocks", blocked);

    const plan = planMove(a, blocked, a.scope, b.scope, { withBlockers: true });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.members.slice().sort()).toEqual([blocker, blocked].sort());
    executeMove(a, b, plan);

    expect(b.store.getNode(blocked)!.open_blockers).toBe(1);
    expect(readyIds(b)).toEqual([blocker]);
    expect(b.store.openBlockersDrift()).toEqual([]);
  });

  test("узел под живой арендой не переезжает: аренда не реплицируется", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "в работе");
    expect(a.store.claimNode(id, "agent-1", 600_000)).toBeDefined();

    const plan = planMove(a, id, a.scope, b.scope);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("leased");
    expect(b.store.getNode(id)).toBeUndefined();
  });

  test("аренда проверяется по ВСЕМУ набору, а не только по названному узлу", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const blocker = task(a, "блокер в работе");
    const blocked = task(a, "заблокированная");
    a.store.addEdge(blocker, "blocks", blocked);
    a.store.claimNode(blocker, "agent-2", 600_000);

    const plan = planMove(a, blocked, a.scope, b.scope, { withBlockers: true });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("leased");
  });

  test("истёкшая аренда переезду не мешает", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "аренда протухла");
    a.store.claimNode(id, "agent-3", 1);

    const plan = planMove(a, id, a.scope, b.scope, { now: Date.now() + 60_000 });
    expect(plan.ok).toBe(true);
  });

  test("один и тот же воркспейс — отказ, а не холостая перезапись scope", async () => {
    const a = await makeWs("a", "aaa");
    const id = task(a, "никуда");
    const plan = planMove(a, id, a.scope, a.scope);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("same_workspace");
  });

  test("узла нет — отказ notfound, приёмник не тронут", async () => {
    const a = await makeWs("a", "aaa");
    const plan = planMove(a, "aaa-нетакого", a.scope, "bbb");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("notfound");
  });

  test("цепочка версий длиннее бюджета чтения — отказ, а не увоз половины истории", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const v1 = task(a, "версия 1");
    const v2 = task(a, "версия 2");
    const v3 = task(a, "версия 3");
    a.store.addEdge(v2, "supersedes", v1);
    a.store.addEdge(v3, "supersedes", v2);

    // Бюджет ниже длины цепочки: собрать её целиком нечем.
    const plan = planMove(a, v1, a.scope, b.scope, { chainLimit: 2 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("chain_truncated");
    expect(b.store.getNode(v1)).toBeUndefined();

    // С полным бюджетом та же цепочка едет целиком.
    const full = planMove(a, v1, a.scope, b.scope);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.members.slice().sort()).toEqual([v1, v2, v3].sort());
  });

  test("приёмник, не взявший историю целиком, владения не получает", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "с дырой в истории");
    const plan = planMove(a, id, a.scope, b.scope);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // Вырезаем set(kind) — узел в приёмнике материализоваться не сможет,
    // и applyOps отложит операции вместо того, чтобы применить их.
    const holed = {
      ...plan,
      ops: plan.ops.filter((r) => r.field !== "kind"),
    };
    expect(() => executeMove(a, b, holed)).toThrow(/не взял историю целиком/);
    // Источник по-прежнему владеет: фаза фиксации не начиналась.
    expect(a.store.getNode(id)!.scope).toBe("aaa");
    expect(readyIds(a)).toEqual([id]);
  });
});

describe("R4 недоигранный переезд обнаружим", () => {
  test("узел с чужим scope и без moved_from — это оборванный переезд", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "оборвётся");
    const plan = planMove(a, id, a.scope, b.scope);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // Обрыв ровно между фазой 1 (история в приёмнике) и фазой 2.
    let killed = false;
    expect(() =>
      executeMove(a, b, plan, {
        breakpoint: "after-ingest",
        onBreakpoint: () => {
          killed = true;
          throw new Error("STOP");
        },
      }),
    ).toThrow("STOP");
    expect(killed).toBe(true);

    expect(strandedArrivals(b.driver, b.scope).map((r) => r.id)).toEqual([id]);
    // Источник ещё владеет — обрыв до точки фиксации ничего не отдал.
    expect(readyIds(a)).toEqual([id]);

    // Повтор доигрывает.
    const again = planMove(a, id, a.scope, b.scope);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    executeMove(a, b, again);
    expect(strandedArrivals(b.driver, b.scope)).toEqual([]);
    expect(readyIds(b)).toEqual([id]);
    expect(readyIds(a)).toEqual([]);
  });

  test("обрыв ПОСЛЕ точки фиксации: задача не видна нигде, и это видно", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const id = task(a, "в щели между фазами");
    const plan = planMove(a, id, a.scope, b.scope);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(() =>
      executeMove(a, b, plan, {
        breakpoint: "after-commit",
        onBreakpoint: () => {
          throw new Error("STOP");
        },
      }),
    ).toThrow("STOP");

    // Дыра выбрана осознанно: невидима в обеих очередях, а не видна в обеих.
    expect(readyIds(a)).toEqual([]);
    expect(readyIds(b)).toEqual([]);
    // И она обнаружима именно там, где узел лежит.
    expect(strandedArrivals(b.driver, b.scope).map((r) => r.id)).toEqual([id]);

    const again = planMove(a, id, a.scope, b.scope);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const r = executeMove(a, b, again);
    expect(r.resumed).toBe(true);
    expect(readyIds(b)).toEqual([id]);
    expect(strandedArrivals(b.driver, b.scope)).toEqual([]);
  });
});

describe("R4 сходимость у третьей стороны (S49)", () => {
  test("третья база, импортировавшая ОБА оплога, приходит к тому же дому", async () => {
    const a = await makeWs("a", "aaa");
    const b = await makeWs("b", "bbb");
    const c = await makeWs("c", "ccc");
    const id = task(a, "общая");
    a.store.updateNode(id, { title: "общая v2" });

    const plan = planMove(a, id, a.scope, b.scope);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    executeMove(a, b, plan);

    // Третья сторона видит один и тот же лог в любом порядке приезда.
    const rowsOf = (ws: Ws): unknown[] =>
      ws.driver.database
        .query(
          `SELECT op_id, site_id, CAST(hlc AS TEXT) AS hlc, ts_ms, actor, op, entity,
                  entity_id, field, value, scope, origin, 0 AS seq
             FROM oplog WHERE op IN ('set','inc','edge_add','edge_del') ORDER BY op_id`,
        )
        .all();
    const { rowToOp } = await import("./queries.ts");
    const all = [...rowsOf(a), ...rowsOf(b)] as Parameters<typeof rowToOp>[0][];
    // Задом наперёд: порядок приезда не имеет права влиять на итог.
    c.store.applyOps([...all].reverse().map(rowToOp), 0);
    c.store.applyOps(all.map(rowToOp), 0);

    const seen = c.store.getNode(id);
    expect(seen).toBeDefined();
    expect(seen!.scope).toBe("bbb");
    expect(seen!.title).toBe("общая v2");
    expect(seen!.attrs[MOVED_FROM_KEY]).toBe("aaa");
    expect(c.store.pendingCount()).toBe(0);
  });
});
