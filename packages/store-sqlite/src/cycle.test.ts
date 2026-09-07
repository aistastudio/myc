/**
 * Ацикличность `blocks` (§4.3): цикл ЛЮБОЙ длины отклоняется, и в тексте
 * назван ПУТЬ, а не пара концов; предел глубины — отдельный код отказа.
 *
 * Почему длины 2, 3 и 10, а не «какой-нибудь цикл»: на длине 2 путь совпадает
 * с парой концов, и тест, проверяющий только её, зелен и при реализации,
 * которая путей не умеет. Длина 10 — там, где разница видна.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphError, HlcClock, generateId, OpFactory } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";
import { ClosureError } from "./closure.ts";
import {
  checkEdgeAcyclic,
  cycleQueries,
  MAX_BLOCKS_DEPTH,
  MAX_BLOCKS_REACH,
} from "./cycle.ts";

let dir: string;
let driver: SqliteDriver;
let store: GraphStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-cycle-"));
  driver = openSqlite(join(dir, "myc.db"));
  await migrate(driver.database, { migrations, writable: true });
  let t = 1_700_000_000_000;
  store = new GraphStore(driver, {
    siteId: "siteA",
    actor: "tester",
    newId: () => generateId(),
    clock: new HlcClock({ now: () => (t += 1) }),
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  try {
    driver?.close();
  } catch {
    // закрыт тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Цепочка n узлов, связанных blocks: n0 → n1 → … → n(len-1). */
function chain(len: number): string[] {
  const ids = Array.from(
    { length: len },
    (_, i) => store.createNode({ kind: "task", scope: "s", title: `звено ${i}` }).id,
  );
  for (let i = 0; i + 1 < len; i++) store.addEdge(ids[i]!, "blocks", ids[i + 1]!);
  return ids;
}

function catchClosure(fn: () => void): ClosureError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ClosureError) return e;
    throw e;
  }
  throw new Error("ожидался ClosureError, а вставка прошла");
}

// ---------------------------------------------------------------------------
// Цикл отклоняется, и назван путь
// ---------------------------------------------------------------------------

describe("blocks: цикл любой длины", () => {
  test("самопетля отклоняется движком раньше обхода", () => {
    const a = store.createNode({ kind: "task", scope: "s", title: "a" }).id;
    // На этом уровне петлю ловит assertEdgeEndpoints (и CHECK src <> dst в
    // DDL); проверка §4.3 всё равно обязана назвать её циклом при прямом
    // вызове — иначе обход остался бы без базового случая.
    expect(() => store.addEdge(a, "blocks", a)).toThrow(GraphError);
    const e = catchClosure(() => checkEdgeAcyclic(driver, a, "blocks", a));
    expect(e.code).toBe("closure.cycle");
    expect(e.path).toEqual([a, a]);
  });

  for (const len of [2, 3, 10]) {
    test(`цикл длины ${len} отклоняется и сообщение называет весь путь`, () => {
      const ids = chain(len);
      const last = ids[len - 1]!;
      const first = ids[0]!;
      // Замыкающее ребро: последний блокирует первого.
      const e = catchClosure(() => store.addEdge(last, "blocks", first));
      expect(e.code).toBe("closure.cycle");
      // Путь целиком: существующая цепочка n0 → … → last, потом замыкающее
      // её ребро last → n0. Всего len + 1 звеньев.
      expect(e.path).toEqual([...ids, first]);
      expect(e.message).toContain([...ids, first].join(" → "));
      // Пара концов — это НЕ путь: на длине 10 в сообщении обязаны быть
      // и середины тоже.
      for (const mid of ids.slice(1, -1)) expect(e.message).toContain(mid);
    });
  }

  test("отказ не оставляет следа ни в проекции, ни в оплоге", () => {
    const ids = chain(4);
    const last = ids[3]!;
    const first = ids[0]!;
    const oplogBefore = driver.database
      .query("SELECT count(*) AS n FROM oplog")
      .get() as { n: number };
    const blockersBefore = store.getNode(first)!.open_blockers;

    expect(() => store.addEdge(last, "blocks", first)).toThrow(ClosureError);

    expect(store.getEdge(last, "blocks", first)).toBeUndefined();
    expect(store.getNode(first)!.open_blockers).toBe(blockersBefore);
    const oplogAfter = driver.database
      .query("SELECT count(*) AS n FROM oplog")
      .get() as { n: number };
    expect(oplogAfter.n).toBe(oplogBefore.n);
    expect(store.openBlockersDrift()).toEqual([]);
  });

  test("встречное ребро в обход цикла (разные ветки) проходит", () => {
    const ids = chain(3);
    const side = store.createNode({ kind: "task", scope: "s", title: "сбоку" }).id;
    // side блокирует середину — это не цикл, вставка обязана пройти.
    expect(() => store.addEdge(side, "blocks", ids[1]!)).not.toThrow();
    expect(store.getEdge(side, "blocks", ids[1]!)).toBeDefined();
  });

  test("удалённое ребро не считается: снятие цикла разрешает вставку", () => {
    const ids = chain(3);
    const e = catchClosure(() => store.addEdge(ids[2]!, "blocks", ids[0]!));
    expect(e.code).toBe("closure.cycle");
    store.removeEdge(ids[0]!, "blocks", ids[1]!);
    expect(() => store.addEdge(ids[2]!, "blocks", ids[0]!)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Предел глубины — ОТДЕЛЬНАЯ новость (И2)
// ---------------------------------------------------------------------------

describe("blocks: предел глубины", () => {
  test("цепочка глубже предела отклоняется кодом closure.depth, а не cycle", () => {
    // MAX_BLOCKS_DEPTH + 2 узла: из dst достижима глубина ровно предела,
    // то есть обход упирается, не доказав ацикличности.
    const ids = chain(MAX_BLOCKS_DEPTH + 2);
    const head = store.createNode({ kind: "task", scope: "s", title: "новый" }).id;
    const e = catchClosure(() => store.addEdge(head, "blocks", ids[0]!));
    expect(e.code).toBe("closure.depth");
    expect(e.path).toEqual([]);
    expect(e.message).toContain(String(MAX_BLOCKS_DEPTH));
    expect(e.message).toContain("предела глубины");
    // Отказ по глубине не притворяется циклом (И2: разные новости).
    expect(e.message).not.toContain("создало бы цикл");
    expect(e.message).toContain("не проверена");
  });

  test("на границе предела вставка ещё проходит", () => {
    const ids = chain(MAX_BLOCKS_DEPTH);
    const head = store.createNode({ kind: "task", scope: "s", title: "новый" }).id;
    expect(() => store.addEdge(head, "blocks", ids[0]!)).not.toThrow();
  });

  test("предел взят из семантики ребра, а не из числа в этом файле", () => {
    expect(MAX_BLOCKS_DEPTH).toBe(64);
  });

  test("широкий узел отклоняется по бюджету обхода, и это тоже не цикл", () => {
    // Веер шире бюджета: обход упирается в число посещённых, а не в глубину.
    const hub = store.createNode({ kind: "task", scope: "s", title: "хаб" }).id;
    for (let i = 0; i <= MAX_BLOCKS_REACH; i++) {
      const leaf = store.createNode({ kind: "task", scope: "s", title: `лист ${i}` }).id;
      store.addEdge(hub, "blocks", leaf);
    }
    const head = store.createNode({ kind: "task", scope: "s", title: "новый" }).id;
    const e = catchClosure(() => store.addEdge(head, "blocks", hub));
    expect(e.code).toBe("closure.depth");
    expect(e.message).toContain(String(MAX_BLOCKS_REACH));
    expect(e.message).toContain("предел обхода");
    expect(e.message).not.toContain("создало бы цикл");
  });

  test("checkEdgeAcyclic зовётся отдельно как чистая проверка", () => {
    const ids = chain(3);
    expect(() => checkEdgeAcyclic(driver, ids[2]!, "blocks", ids[0]!)).toThrow(ClosureError);
    expect(() => checkEdgeAcyclic(driver, ids[0]!, "blocks", ids[2]!)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Репликация: §4.3 требует ПОМЕТИТЬ, а не отвергнуть
// ---------------------------------------------------------------------------

test("цикл, приехавший по репликации, не отвергается (§4.3)", () => {
  const ids = chain(3);
  let rt = 1_700_000_100_000;
  const ops = new OpFactory("siteB", { clock: new HlcClock({ now: () => (rt += 1) }) });
  const res = store.applyOps([ops.edgeAdd(ids[2]!, "blocks", ids[0]!)]);
  expect(res.applied).toBe(1);
  expect(store.getEdge(ids[2]!, "blocks", ids[0]!)).toBeDefined();
  // …и локальная вставка после этого всё ещё видит цикл как цикл.
  const e = catchClosure(() => checkEdgeAcyclic(driver, ids[1]!, "blocks", ids[0]!));
  expect(e.code).toBe("closure.cycle");
});

// ---------------------------------------------------------------------------
// План запроса: без индекса проверка становится сканом
// ---------------------------------------------------------------------------

test("шаг обхода идёт по индексу, а не сканом edges", () => {
  chain(3);
  const plan = driver.database
    .query<{ detail: string }, [string, string]>(
      `EXPLAIN QUERY PLAN ${cycleQueries.edge_out!.sql}`,
    )
    .all("x", "blocks")
    .map((r) => r.detail);
  // Скан таблицы на каждом шаге обхода превратил бы проверку цикла в
  // проход по всем рёбрам графа — ровно то, чего §4.3 избегает.
  expect(plan.join(" | ")).toMatch(/USING (INDEX|PRIMARY KEY|COVERING INDEX)/);
  expect(plan.filter((d) => /SCAN edges/.test(d))).toEqual([]);
});
