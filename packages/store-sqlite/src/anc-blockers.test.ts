/**
 * НАСЛЕДОВАНИЕ БЛОКЕРОВ ВНИЗ ПО `parent` (миграция 10, memory-atcm254ry6c7).
 *
 * `ready` = `open_blockers = 0 AND anc_blockers = 0`. Здесь проверяется вторая
 * половина: счётчик, который ведут триггеры `trg_anc_*`.
 *
 * Почему счётчик, а не подъём по предкам на выдачу, — в докстроке миграции
 * (замер: ×4.9, packages/cli/src/commands/ready.inherit-latency.test.ts).
 * Здесь важно другое: у материализации есть цена — она может РАЗЪЕХАТЬСЯ с
 * графом. Поэтому каждый тест ниже заканчивается сверкой с пересчётом
 * (`ancBlockersDrift()`), а не только ожидаемым числом: совпадение числа при
 * разъехавшемся счётчике — это совпадение, а не проверка.
 *
 * МУТАЦИИ, которыми выбраны утверждения, — в тестах с пометкой «мутация»:
 * снятый триггер обязан ронять их с НАЗВАННЫМ числом расхождения.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, HlcClock } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";
import { ClosureError } from "./closure.ts";

let dir: string;
let driver: SqliteDriver;
let store: GraphStore;

async function openStore(): Promise<GraphStore> {
  driver = openSqlite(join(dir, "myc.db"));
  await migrate(driver.database, { migrations, writable: true });
  let t = 1_700_000_000_000;
  return new GraphStore(driver, {
    siteId: "siteA",
    actor: "tester",
    newId: () => generateId(),
    clock: new HlcClock({ now: () => (t += 1) }),
    now: () => 1_700_000_000_000,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-anc-"));
  store = await openStore();
});

afterEach(() => {
  try {
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const task = (title: string): string =>
  store.createNode({ kind: "task", scope: "s", title }).id;

const anc = (id: string): number => store.getNode(id)!.anc_blockers;

/** Очередь ровно тем предикатом, которым её видит `myc ready`. */
function readyIds(): string[] {
  return driver.database
    .query(
      `SELECT id FROM nodes
        WHERE kind='task' AND status='open' AND open_blockers=0 AND anc_blockers=0
          AND deleted_at IS NULL ORDER BY id`,
    )
    .all()
    .map((r) => (r as { id: string }).id);
}

/** Та же очередь БЕЗ наследования — прежнее правило, оно же мутация. */
function readyIdsWithoutInheritance(): string[] {
  return driver.database
    .query(
      `SELECT id FROM nodes
        WHERE kind='task' AND status='open' AND open_blockers=0
          AND deleted_at IS NULL ORDER BY id`,
    )
    .all()
    .map((r) => (r as { id: string }).id);
}

describe("наследование блокеров по parent", () => {
  test("блокер на эпике убирает из очереди всё поддерево, снятие возвращает", () => {
    const epic = task("эпик");
    const kid = task("подзадача");
    const grandKid = task("подподзадача");
    const blocker = task("предусловие");
    store.addEdge(kid, "parent", epic);
    store.addEdge(grandKid, "parent", kid);

    // до блокера готовы все четверо
    expect(readyIds()).toEqual([blocker, epic, grandKid, kid].sort());

    store.addEdge(blocker, "blocks", epic);
    expect(store.getNode(epic)!.open_blockers).toBe(1);
    expect(anc(kid)).toBe(1);
    expect(anc(grandKid)).toBe(1);
    expect(anc(epic)).toBe(0);
    expect(readyIds()).toEqual([blocker]);
    expect(store.ancBlockersDrift()).toEqual([]);

    // МУТАЦИЯ «наследования нет» — прежнее правило. Числом: очередь снова
    // предлагает обе подзадачи, то есть терм anc_blockers и делает работу.
    expect(readyIdsWithoutInheritance().sort()).toEqual([blocker, grandKid, kid].sort());
    expect(readyIdsWithoutInheritance().length - readyIds().length).toBe(2);

    // закрытие блокера возвращает поддерево
    store.updateNode(blocker, { status: "closed" });
    expect(anc(kid)).toBe(0);
    expect(anc(grandKid)).toBe(0);
    expect(readyIds()).toEqual([epic, grandKid, kid].sort());
    expect(store.ancBlockersDrift()).toEqual([]);
  });

  test("два заблокированных предка — счётчик 2, снятие одного не открывает", () => {
    const root = task("веха");
    const epic = task("эпик");
    const kid = task("подзадача");
    const b1 = task("предусловие вехи");
    const b2 = task("предусловие эпика");
    store.addEdge(epic, "parent", root);
    store.addEdge(kid, "parent", epic);

    store.addEdge(b1, "blocks", root);
    store.addEdge(b2, "blocks", epic);
    expect(anc(kid)).toBe(2);
    expect(anc(epic)).toBe(1);

    store.updateNode(b2, { status: "closed" });
    expect(anc(kid)).toBe(1);
    expect(readyIds()).not.toContain(kid);

    store.updateNode(b1, { status: "closed" });
    expect(anc(kid)).toBe(0);
    expect(readyIds()).toContain(kid);
    expect(store.ancBlockersDrift()).toEqual([]);
  });

  test("ребро parent, поставленное ПОСЛЕ блокировки, наследует сразу", () => {
    const epic = task("эпик");
    const blocker = task("предусловие");
    const kid = task("подзадача");
    store.addEdge(blocker, "blocks", epic);
    expect(anc(kid)).toBe(0);

    store.addEdge(kid, "parent", epic);
    expect(anc(kid)).toBe(1);
    expect(readyIds()).not.toContain(kid);
    expect(store.ancBlockersDrift()).toEqual([]);

    // снятие ребра выводит задачу из-под эпика
    store.removeEdge(kid, "parent", epic);
    expect(anc(kid)).toBe(0);
    expect(readyIds()).toContain(kid);
    expect(store.ancBlockersDrift()).toEqual([]);
  });

  test("перенос поддерева между эпиками переносит и наследование", () => {
    const blockedEpic = task("заблокированный эпик");
    const freeEpic = task("свободный эпик");
    const blocker = task("предусловие");
    const kid = task("подзадача");
    const grandKid = task("подподзадача");
    store.addEdge(grandKid, "parent", kid);
    store.addEdge(blocker, "blocks", blockedEpic);

    store.addEdge(kid, "parent", blockedEpic);
    expect([anc(kid), anc(grandKid)]).toEqual([1, 1]);

    // перенос: снять и поставить заново — как это делает applyParentMove
    store.removeEdge(kid, "parent", blockedEpic);
    store.addEdge(kid, "parent", freeEpic);
    expect([anc(kid), anc(grandKid)]).toEqual([0, 0]);
    expect(readyIds()).toContain(grandKid);
    expect(store.ancBlockersDrift()).toEqual([]);
  });

  test("сходится после 400 случайных мутаций над деревом и блокерами", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => task(`узел ${i}`));
    let refused = 0;
    let parents = 0;
    let seed = 987654;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let i = 0; i < 400; i++) {
      const a = nodes[rnd(nodes.length)]!;
      const b = nodes[rnd(nodes.length)]!;
      if (a === b) continue;
      const action = rnd(5);
      try {
        if (action === 0) {
          store.addEdge(a, "parent", b);
          parents++;
        } else if (action === 1) {
          store.removeEdge(a, "parent", b);
        } else if (action === 2) {
          store.addEdge(a, "blocks", b);
        } else if (action === 3) {
          store.removeEdge(a, "blocks", b);
        } else {
          const cur = store.getNode(a)!;
          store.updateNode(a, { status: cur.status === "open" ? "closed" : "open" });
        }
      } catch (e) {
        if (!(e instanceof ClosureError)) throw e;
        refused++;
      }
    }

    // Фаззер обязан был напороться и на циклы, и на «у ребёнка уже есть
    // родитель» — иначе он не трогал дерево и проверка ниже пустая.
    expect(refused).toBeGreaterThan(0);
    expect(parents).toBeGreaterThan(0);
    expect(store.ancBlockersDrift()).toEqual([]);
    expect(store.openBlockersDrift()).toEqual([]);
    const min = driver.database
      .query("SELECT min(anc_blockers) AS m FROM nodes")
      .get() as { m: number };
    expect(min.m).toBeGreaterThanOrEqual(0);
  });

  test("МУТАЦИЯ: снятый триггер trg_anc_block разъезжает счётчик на 2 узла", () => {
    const epic = task("эпик");
    const kid = task("подзадача");
    const grandKid = task("подподзадача");
    const blocker = task("предусловие");
    store.addEdge(kid, "parent", epic);
    store.addEdge(grandKid, "parent", kid);

    driver.database.exec("DROP TRIGGER trg_anc_block");
    store.addEdge(blocker, "blocks", epic);

    // Без триггера счётчик остался нулём, и очередь предлагает обе подзадачи
    // заблокированного эпика — ровно тот дефект, ради которого он заведён.
    expect(anc(kid)).toBe(0);
    expect(readyIds()).toEqual([blocker, grandKid, kid].sort());
    const drift = store.ancBlockersDrift();
    expect(drift).toHaveLength(2);
    expect(drift.map((d) => d.actual)).toEqual([1, 1]);
  });

  test("recount чинит счётчик после жёсткого удаления, как и у open_blockers", () => {
    const epic = task("эпик");
    const kid = task("подзадача");
    const blocker = task("предусловие");
    store.addEdge(kid, "parent", epic);
    store.addEdge(blocker, "blocks", epic);
    expect(anc(kid)).toBe(1);

    // жёсткий DELETE ребра blocks триггерами не покрыт by design (§8.1.11)
    driver.database.exec(`DELETE FROM edges WHERE dst = '${epic}' AND type='blocks'`);
    expect(anc(kid)).toBe(1);
    expect(store.ancBlockersDrift()).toHaveLength(1);
    // recountOpenBlockers чинит ОБА счётчика одной транзакцией: 1 узел с
    // разъехавшимся open_blockers плюс 1 с разъехавшимся anc_blockers.
    expect(store.recountOpenBlockers()).toBe(2);
    expect(anc(kid)).toBe(0);
    expect(store.ancBlockersDrift()).toEqual([]);
    expect(store.openBlockersDrift()).toEqual([]);
  });

  test("ГРАНИЦА ВОРКСПЕЙСА: предка нет в этой базе — наследования нет", () => {
    // Ребро parent между базами существовать не может (edges живут в одной
    // базе), поэтому «предок в чужом воркспейсе» выглядит здесь как строка
    // parent_closure без узла. Счётчик обязан остаться нулём, а не считать
    // отсутствующего предка заблокированным.
    const kid = task("подзадача");
    driver.database.exec(
      `INSERT INTO parent_closure (ancestor, descendant, depth) VALUES ('чужой-эпик','${kid}',1)`,
    );
    expect(anc(kid)).toBe(0);
    expect(readyIds()).toContain(kid);
    expect(store.ancBlockersDrift()).toEqual([]);
  });
});
