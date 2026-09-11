import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbDriver } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import {
  ClosureError,
  MAX_PARENT_DEPTH,
  ancestorsOf,
  applyParentInsert,
  checkParentInsert,
  deleteNodeClosure,
  descendantsOf,
  dumpParentClosure,
  insertParentEdge,
  moveParentEdge,
  rebuildParentClosure,
  removeParentEdge,
  type ClosureRow,
} from "./closure.ts";

let dir: string;
let driver: SqliteDriver;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-closure-"));
  driver = openSqlite(join(dir, "myc.db"));
  await migrate(driver.database, { migrations, writable: true });
});

afterEach(() => {
  try {
    driver?.close();
  } catch {
    // соединение уже закрыто тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Помощники: детерминированный PRNG, деревья, эталон замыкания «в лоб»
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Эталон: замыкание, посчитанное прямым обходом карты «ребёнок → родитель» — независимо от SQL. */
function bruteForceClosure(parentOf: ReadonlyMap<string, string>): ClosureRow[] {
  const rows: ClosureRow[] = [];
  for (const child of parentOf.keys()) {
    let cur = parentOf.get(child);
    let depth = 1;
    while (cur !== undefined) {
      rows.push({ ancestor: cur, descendant: child, depth });
      cur = parentOf.get(cur);
      depth++;
    }
  }
  return sortRows(rows);
}

function sortRows(rows: readonly ClosureRow[]): ClosureRow[] {
  return [...rows].sort((a, b) =>
    a.ancestor === b.ancestor
      ? a.descendant < b.descendant
        ? -1
        : a.descendant > b.descendant
          ? 1
          : 0
      : a.ancestor < b.ancestor
        ? -1
        : 1,
  );
}

/**
 * Растит поддерево под уже существующим `rootId`, смещая выбор родителя к
 * началу списка (rng() * rng()), чтобы дерево оставалось развесистым, а не
 * вырождалось в цепочку — иначе случайное дерево на нескольких сотнях узлов
 * с ненулевой вероятностью упёрлось бы в MAX_PARENT_DEPTH.
 */
function growTree(
  tx: DbDriver,
  parentOf: Map<string, string>,
  rootId: string,
  count: number,
  rng: () => number,
  namePrefix: string,
): string[] {
  const ids = [rootId];
  for (let i = 1; i < count; i++) {
    const id = `${namePrefix}${i}`;
    const idx = Math.floor(rng() * rng() * ids.length);
    const parent = ids[idx]!;
    applyParentInsert(tx, id, parent);
    parentOf.set(id, parent);
    ids.push(id);
  }
  return ids;
}

/** Дерево фиксированной глубины: узел уровня d получает случайного родителя строго с уровня d-1. */
function buildLeveledTree(
  count: number,
  maxDepth: number,
  rng: () => number,
): { edges: Array<{ child: string; parent: string }>; parentOf: Map<string, string>; root: string } {
  const buckets: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const root = "n0";
  buckets[0]!.push(root);
  const parentOf = new Map<string, string>();
  const edges: Array<{ child: string; parent: string }> = [];
  for (let i = 1; i < count; i++) {
    const depth = ((i - 1) % maxDepth) + 1;
    const candidates = buckets[depth - 1]!;
    const parent = candidates[Math.floor(rng() * candidates.length)]!;
    const id = `n${i}`;
    buckets[depth]!.push(id);
    parentOf.set(id, parent);
    edges.push({ child: id, parent });
  }
  return { edges, parentOf, root };
}

function insertNodeRaw(db: SqliteDriver, id: string): void {
  db.database
    .query(
      `INSERT INTO nodes (id, kind, content_hash, created_at, updated_at) VALUES (?, 'task', ?, 1, 1)`,
    )
    .run(id, id);
}

function insertParentEdgeRaw(db: SqliteDriver, child: string, parent: string, tag: string): void {
  db.database
    .query(
      `INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES (?, 'parent', ?, ?, 1)`,
    )
    .run(child, parent, tag);
}

// ---------------------------------------------------------------------------
// Базовая материализация: вставка
// ---------------------------------------------------------------------------

describe("insertParentEdge", () => {
  test("одно ребро — одна строка глубины 1", () => {
    insertParentEdge(driver, "child", "parent");
    expect(dumpParentClosure(driver)).toEqual([
      { ancestor: "parent", descendant: "child", depth: 1 },
    ]);
  });

  test("цепочка из трёх рёбер даёт полное транзитивное замыкание", () => {
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "b", "a");
    insertParentEdge(driver, "c", "b");
    expect(dumpParentClosure(driver)).toEqual(
      sortRows([
        { ancestor: "root", descendant: "a", depth: 1 },
        { ancestor: "root", descendant: "b", depth: 2 },
        { ancestor: "root", descendant: "c", depth: 3 },
        { ancestor: "a", descendant: "b", depth: 1 },
        { ancestor: "a", descendant: "c", depth: 2 },
        { ancestor: "b", descendant: "c", depth: 1 },
      ]),
    );
  });

  test("ветвление: у сиблингов нет перекрёстных строк", () => {
    insertParentEdge(driver, "left", "root");
    insertParentEdge(driver, "right", "root");
    insertParentEdge(driver, "left.child", "left");
    const rows = dumpParentClosure(driver);
    expect(rows).toEqual(
      sortRows([
        { ancestor: "root", descendant: "left", depth: 1 },
        { ancestor: "root", descendant: "right", depth: 1 },
        { ancestor: "root", descendant: "left.child", depth: 2 },
        { ancestor: "left", descendant: "left.child", depth: 1 },
      ]),
    );
    expect(rows.find((r) => r.ancestor === "right")).toBeUndefined();
  });

  test("вставка ребра под несуществующим родителем начинает новую ветку без предков", () => {
    insertParentEdge(driver, "orphan-child", "orphan-parent");
    expect(ancestorsOf(driver, "orphan-child")).toEqual([
      { ancestor: "orphan-parent", depth: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ацикличность и предел глубины (§4.3)
// ---------------------------------------------------------------------------

describe("checkParentInsert / ацикличность / глубина", () => {
  test("узел не может быть родителем самому себе", () => {
    expect(() => insertParentEdge(driver, "x", "x")).toThrow(ClosureError);
    try {
      insertParentEdge(driver, "x", "x");
    } catch (e) {
      expect((e as ClosureError).code).toBe("closure.cycle");
    }
  });

  test("вставка, замыкающая цикл, отклоняется и не пишет строк", () => {
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "b", "a");
    expect(() => insertParentEdge(driver, "root", "b")).toThrow(ClosureError);
    let code: string | undefined;
    try {
      insertParentEdge(driver, "root", "b");
    } catch (e) {
      code = (e as ClosureError).code;
    }
    expect(code).toBe("closure.cycle");
    // Отказ ничего не должен был записать — ни при первой, ни при второй попытке.
    expect(dumpParentClosure(driver)).toEqual(
      sortRows([
        { ancestor: "root", descendant: "a", depth: 1 },
        { ancestor: "root", descendant: "b", depth: 2 },
        { ancestor: "a", descendant: "b", depth: 1 },
      ]),
    );
  });

  test("цикл длины 5 назван ПУТЁМ, а не парой концов", () => {
    // root ← a ← b ← c ← d (стрелка «ребёнок → родитель»).
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "b", "a");
    insertParentEdge(driver, "c", "b");
    insertParentEdge(driver, "d", "c");
    let err: ClosureError | undefined;
    try {
      insertParentEdge(driver, "root", "d");
    } catch (e) {
      err = e as ClosureError;
    }
    expect(err?.code).toBe("closure.cycle");
    // Пара концов (root, d) не говорит, какое из четырёх рёбер лишнее.
    expect(err?.path).toEqual(["d", "c", "b", "a", "root", "d"]);
    expect(err?.message).toContain("d → c → b → a → root → d");
  });

  test("checkParentInsert можно звать отдельно как чистую проверку", () => {
    insertParentEdge(driver, "a", "root");
    expect(() => checkParentInsert(driver, "root", "a")).toThrow(ClosureError);
    expect(() => checkParentInsert(driver, "b", "a")).not.toThrow();
    // Проверка ничего не пишет.
    expect(dumpParentClosure(driver)).toEqual([
      { ancestor: "root", descendant: "a", depth: 1 },
    ]);
  });

  test("ровно 32 уровня — успех, 33-й — отказ E_DEPTH с внятным сообщением", () => {
    let prev = "d0";
    for (let i = 1; i <= MAX_PARENT_DEPTH; i++) {
      const id = `d${i}`;
      insertParentEdge(driver, id, prev);
      prev = id;
    }
    // Сама длинная цепочка (d0..d32) — глубина 32, разрешено.
    expect(ancestorsOf(driver, `d${MAX_PARENT_DEPTH}`)).toHaveLength(MAX_PARENT_DEPTH);

    let thrown: ClosureError | undefined;
    try {
      insertParentEdge(driver, "d33", prev);
    } catch (e) {
      thrown = e as ClosureError;
    }
    expect(thrown).toBeInstanceOf(ClosureError);
    expect(thrown?.code).toBe("closure.depth");
    expect(thrown?.message).toContain(String(MAX_PARENT_DEPTH));
    expect(thrown?.message).toContain("33");
    // Отказ не должен был просочиться в таблицу.
    expect(dumpParentClosure(driver).some((r) => r.descendant === "d33")).toBe(false);
  });

  test("глубина считает от обоих концов: длинная цепочка + попытка приклеить поддерево", () => {
    // 20-уровневая цепочка сверху.
    let prev = "top0";
    for (let i = 1; i <= 20; i++) {
      insertParentEdge(driver, `top${i}`, prev);
      prev = `top${i}`;
    }
    // 15-уровневая цепочка снизу (отдельная, пока не подключена).
    let leaf = "bot0";
    for (let i = 1; i <= 14; i++) {
      insertParentEdge(driver, `bot${i}`, leaf);
      leaf = `bot${i}`;
    }
    // Подключение bot0 под top20 дало бы глубину 20 + 1 + 14 = 35 > 32.
    expect(() => insertParentEdge(driver, "bot0", "top20")).toThrow(ClosureError);
  });

  test("узел с уже существующим родителем нельзя вставить повторно без переноса", () => {
    insertParentEdge(driver, "child", "parentA");
    let code: string | undefined;
    try {
      insertParentEdge(driver, "child", "parentB");
    } catch (e) {
      code = (e as ClosureError).code;
    }
    expect(code).toBe("closure.multiple_parents");
  });
});

// ---------------------------------------------------------------------------
// Удаление ребра
// ---------------------------------------------------------------------------

describe("removeParentEdge", () => {
  test("удаление листового ребра снимает ровно одну строку", () => {
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "leaf", "a");
    removeParentEdge(driver, "leaf", "a");
    expect(dumpParentClosure(driver)).toEqual([
      { ancestor: "root", descendant: "a", depth: 1 },
    ]);
  });

  test("удаление несуществующего ребра — явная ошибка, не молчаливый no-op", () => {
    insertParentEdge(driver, "a", "root");
    let code: string | undefined;
    try {
      removeParentEdge(driver, "a", "wrong-parent");
    } catch (e) {
      code = (e as ClosureError).code;
    }
    expect(code).toBe("closure.no_edge");
    // Состояние не изменилось.
    expect(dumpParentClosure(driver)).toEqual([
      { ancestor: "root", descendant: "a", depth: 1 },
    ]);
  });

  test("удаление ребра в середине дерева режет строго прямоугольник предки×потомки, не больше и не меньше", () => {
    // root -> a -> b -> c, и параллельная ветка root -> other.
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "b", "a");
    insertParentEdge(driver, "c", "b");
    insertParentEdge(driver, "other", "root");

    removeParentEdge(driver, "a", "root");

    const rows = dumpParentClosure(driver);
    // root теряет всякую связь с a/b/c (но не с внутренними рёбрами их поддерева)...
    expect(
      rows.some(
        (r) => r.ancestor === "root" && (r.descendant === "a" || r.descendant === "b" || r.descendant === "c"),
      ),
    ).toBe(false);
    // ...но внутренняя структура поддерева a остаётся нетронутой (a — новый корень)...
    expect(rows).toEqual(
      expect.arrayContaining([
        { ancestor: "a", descendant: "b", depth: 1 },
        { ancestor: "a", descendant: "c", depth: 2 },
        { ancestor: "b", descendant: "c", depth: 1 },
      ]),
    );
    // ...и несвязанная ветка root->other не задета.
    expect(rows).toEqual(
      expect.arrayContaining([{ ancestor: "root", descendant: "other", depth: 1 }]),
    );
    expect(rows).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Перенос (moveParentEdge) — самый опасный случай
// ---------------------------------------------------------------------------

describe("moveParentEdge", () => {
  test("перевешивание листа между двумя корнями", () => {
    insertParentEdge(driver, "x", "rootA");
    moveParentEdge(driver, "x", "rootB");
    expect(dumpParentClosure(driver)).toEqual([
      { ancestor: "rootB", descendant: "x", depth: 1 },
    ]);
  });

  test("перевешивание узла с детьми перестраивает замыкание всего поддерева, а не только узла", () => {
    // rootA -> mid -> leaf1, leaf2 (поддерево из 3 узлов под mid)
    insertParentEdge(driver, "mid", "rootA");
    insertParentEdge(driver, "leaf1", "mid");
    insertParentEdge(driver, "leaf2", "mid");
    // rootB существует отдельно, с собственным потомком.
    insertParentEdge(driver, "other", "rootB");

    moveParentEdge(driver, "mid", "rootB");

    const rows = dumpParentClosure(driver);
    const parentOf = new Map([
      ["mid", "rootB"],
      ["leaf1", "mid"],
      ["leaf2", "mid"],
      ["other", "rootB"],
    ]);
    expect(rows).toEqual(bruteForceClosure(parentOf));
    // В частности: rootA полностью потерял связь с mid/leaf1/leaf2...
    expect(rows.some((r) => r.ancestor === "rootA")).toBe(false);
    // ...а rootB видит их все, включая транзитивные leaf1/leaf2 на глубине 2.
    expect(rows).toEqual(
      expect.arrayContaining([
        { ancestor: "rootB", descendant: "leaf1", depth: 2 },
        { ancestor: "rootB", descendant: "leaf2", depth: 2 },
      ]),
    );
  });

  test("перенос поддерева из 500 узлов сходится с независимым пересчётом «в лоб», расхождений ноль", () => {
    const rng = mulberry32(42);
    const parentOf = new Map<string, string>();

    driver.tx("immediate", (tx) => {
      // Ветка A: 300 узлов, включая корень поддерева, которое будем переносить.
      growTree(tx, parentOf, "rootA", 301, rng, "a");
      applyParentInsert(tx, "subtreeRoot", "a1");
      parentOf.set("subtreeRoot", "a1");
      growTree(tx, parentOf, "subtreeRoot", 500, rng, "s");
      // Независимая ветка B, куда переносим поддерево.
      growTree(tx, parentOf, "rootB", 50, rng, "b");
    });

    const before = dumpParentClosure(driver);
    expect(before).toEqual(bruteForceClosure(parentOf));

    const start = performance.now();
    moveParentEdge(driver, "subtreeRoot", "b1");
    const moveMs = performance.now() - start;

    parentOf.set("subtreeRoot", "b1");
    const after = dumpParentClosure(driver);
    const expected = bruteForceClosure(parentOf);
    expect(after).toEqual(expected);
    expect(after.length).toBe(expected.length);

    // eslint-disable-next-line no-console
    console.log(`[closure] перенос поддерева 500 узлов: ${moveMs.toFixed(3)} мс, строк замыкания: ${after.length}`);
  });

  test("перенос под собственного потомка отклоняется как цикл, состояние не меняется", () => {
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "b", "a");
    const before = dumpParentClosure(driver);
    expect(() => moveParentEdge(driver, "root", "b")).toThrow(ClosureError);
    expect(dumpParentClosure(driver)).toEqual(before);
  });

  test("перенос узла без текущего родителя эквивалентен вставке", () => {
    moveParentEdge(driver, "fresh", "root");
    expect(dumpParentClosure(driver)).toEqual([
      { ancestor: "root", descendant: "fresh", depth: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Удаление узла целиком
// ---------------------------------------------------------------------------

describe("deleteNodeClosure", () => {
  test("удаление узла в середине дерева не оставляет висячих строк", () => {
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "b", "a");
    insertParentEdge(driver, "c", "b");
    insertParentEdge(driver, "sibling", "root");

    deleteNodeClosure(driver, "a");

    const rows = dumpParentClosure(driver);
    // Ни в ancestor, ни в descendant не должно остаться "a".
    expect(rows.some((r) => r.ancestor === "a" || r.descendant === "a")).toBe(false);
    // root -> sibling не задет.
    expect(rows).toEqual(
      expect.arrayContaining([{ ancestor: "root", descendant: "sibling", depth: 1 }]),
    );
    // b остаётся корнем своего бывшего поддерева (реюз родителя a — вне зоны ответственности closure.ts).
    expect(rows).toEqual(expect.arrayContaining([{ ancestor: "b", descendant: "c", depth: 1 }]));
    expect(rows.some((r) => r.descendant === "b" && r.ancestor === "root")).toBe(false);
  });

  test("удаление корня (без родителя) снимает только его связи с потомками", () => {
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "b", "a");
    deleteNodeClosure(driver, "root");
    expect(dumpParentClosure(driver)).toEqual([{ ancestor: "a", descendant: "b", depth: 1 }]);
  });

  test("удаление листа не задевает остальное дерево", () => {
    insertParentEdge(driver, "a", "root");
    insertParentEdge(driver, "leaf", "a");
    deleteNodeClosure(driver, "leaf");
    expect(dumpParentClosure(driver)).toEqual([{ ancestor: "root", descendant: "a", depth: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Пересчёт с нуля и сверка с рёбрами (нужны настоящие nodes/edges — FK)
// ---------------------------------------------------------------------------

describe("rebuildParentClosure", () => {
  test("пересчёт из edges даёт тот же результат, что и накопленная материализация", () => {
    const rng = mulberry32(7);
    const parentOf = new Map<string, string>();
    const tagOf = new Map<string, string>();

    insertNodeRaw(driver, "root");
    driver.tx("immediate", (tx) => {
      const ids = growTree(tx, parentOf, "root", 1500, rng, "n");
      for (const id of ids) if (id !== "root") insertNodeRaw(driver, id);
    });
    let tagSeq = 0;
    for (const [child, parent] of parentOf) {
      const tag = `t${tagSeq++}`;
      tagOf.set(child, tag);
      insertParentEdgeRaw(driver, child, parent, tag);
    }

    const beforeRebuild = dumpParentClosure(driver);
    const { rows } = rebuildParentClosure(driver);
    const afterRebuild = dumpParentClosure(driver);

    expect(afterRebuild).toEqual(beforeRebuild);
    expect(rows).toBe(afterRebuild.length);
    expect(afterRebuild).toEqual(bruteForceClosure(parentOf));
  });

  test("recount с нуля тоже ловит намеренно испорченное замыкание (детектор регрессии)", () => {
    insertNodeRaw(driver, "root");
    insertNodeRaw(driver, "child");
    insertParentEdgeRaw(driver, "child", "root", "tag1");
    insertParentEdge(driver, "child", "root");

    // Портим материализацию руками, будто триггер поддержки не сработал.
    driver.database.exec("DELETE FROM parent_closure");
    expect(dumpParentClosure(driver)).toEqual([]);

    rebuildParentClosure(driver);
    expect(dumpParentClosure(driver)).toEqual([
      { ancestor: "root", descendant: "child", depth: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Производительность: 10 000 узлов, глубина 10 (числа приёмки)
// ---------------------------------------------------------------------------

describe("производительность на 10 000 узлов / глубина 10", () => {
  test("построение замыкания и запрос поддерева укладываются в разумные бюджеты", () => {
    const rng = mulberry32(1234);
    const { edges, parentOf, root } = buildLeveledTree(10_000, 10, rng);
    expect(parentOf.size).toBe(9_999);

    // --- вариант 1: инкрементальная материализация по мере вставки рёбер ---
    const incrStart = performance.now();
    driver.tx("immediate", (tx) => {
      for (const e of edges) applyParentInsert(tx, e.child, e.parent);
    });
    const incrementalMs = performance.now() - incrStart;
    expect(dumpParentClosure(driver)).toEqual(bruteForceClosure(parentOf));

    // --- вариант 2: пересчёт с нуля из настоящих edges/nodes (рельсы doctor --recount) ---
    driver.database.exec("DELETE FROM parent_closure");
    insertNodeRaw(driver, root);
    let tagSeq = 0;
    driver.database.exec("BEGIN");
    try {
      for (const e of edges) {
        insertNodeRaw(driver, e.child);
        insertParentEdgeRaw(driver, e.child, e.parent, `t${tagSeq++}`);
      }
      driver.database.exec("COMMIT");
    } catch (err) {
      driver.database.exec("ROLLBACK");
      throw err;
    }

    const buildStart = performance.now();
    const { rows } = rebuildParentClosure(driver);
    const buildMs = performance.now() - buildStart;

    const queryStart = performance.now();
    const subtree = descendantsOf(driver, root);
    const queryMs = performance.now() - queryStart;

    expect(rows).toBe(parentOf.size === 0 ? 0 : dumpParentClosure(driver).length);
    expect(subtree.length).toBe(9_999); // все узлы, кроме root, — его потомки

    // eslint-disable-next-line no-console
    console.log(
      `[closure] 10000 узлов, глубина 10 — инкрементальная вставка: ${incrementalMs.toFixed(3)} мс; ` +
        `построение с нуля (recount): ${buildMs.toFixed(3)} мс (${rows} строк); ` +
        `запрос поддерева от корня: ${queryMs.toFixed(3)} мс (${subtree.length} строк)`,
    );

    // Мягкие бюджеты — не §12 «горячего пути» (это фоновая материализация/recount),
    // но достаточно тесные, чтобы поймать случайную деградацию до O(n²).
    // Это ПОТОЛКИ класса сложности, а не калиброванные бюджеты, и потому без
    // гейта MYC_BENCH_ABSOLUTE: замер 2026-09-11 — 159 / 119 / 2.7 мс, то есть
    // запас ×31 / ×42 / ×74, под yes × 14 (load1 30) — 241 / 187 / 4.1 мс;
    // квадратичная вставка на 10 000 узлах (~2.75·10⁸ посещений строк
    // замыкания) стоила бы десятки секунд. Наблюдённое худшее растяжение
    // машиной — ×13 (id.test.ts, load1 15–21) — оставляет потолкам запас ×2.
    expect(incrementalMs).toBeLessThan(5_000);
    expect(buildMs).toBeLessThan(5_000);
    expect(queryMs).toBeLessThan(200);
    // Лимит теста 60 с — потолок «зациклилось»: весь тест обычно 0.5 с, но
    // при растяжении ×13 уже не укладывался бы в лимит по умолчанию (5 с).
  }, 60_000);
});
