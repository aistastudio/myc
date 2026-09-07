import { describe, expect, test } from "bun:test";
import { MOVED_FROM_KEY, planMoveSet, type MoveBlockEdge, type MoveNeighbors } from "./move.ts";

/**
 * Оракул из двух списков: звенья версий и живые blocks. `versionChain` в
 * контракте — уже ЗАМЫКАНИЕ (в бою его считает collectVersions), поэтому
 * здесь оно тоже считается замыканием, а не списком смежных.
 */
function oracle(
  versions: readonly (readonly [string, string])[],
  blocks: readonly (readonly [string, string])[],
): MoveNeighbors {
  return {
    versionChain(id: string): readonly string[] {
      const seen = new Set<string>([id]);
      const queue = [id];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const [a, b] of versions) {
          const other = a === cur ? b : b === cur ? a : undefined;
          if (other === undefined || seen.has(other)) continue;
          seen.add(other);
          queue.push(other);
        }
      }
      return [...seen];
    },
    blockLinks(id): readonly MoveBlockEdge[] {
      return blocks
        .filter(([s, d]) => s === id || d === id)
        .map(([src, dst]) => ({ src, dst }));
    },
  };
}

describe("R4 набор переезда", () => {
  test("одинокий узел едет один и границу не рвёт", () => {
    const plan = planMoveSet(["a"], oracle([], []));
    expect(plan.members).toEqual(["a"]);
    expect(plan.crossing).toEqual([]);
    expect(plan.expanded).toBe(false);
  });

  test("цепочка версий едет всегда и без спроса", () => {
    // v1 → v2 → v3, спрошен средний
    const plan = planMoveSet(["v2"], oracle([["v1", "v2"], ["v2", "v3"]], []));
    expect(plan.members).toEqual(["v1", "v2", "v3"]);
  });

  test("живой blocks через границу — отказ, а не молчаливый переезд", () => {
    const plan = planMoveSet(["x"], oracle([], [["y", "x"]]));
    expect(plan.members).toEqual(["x"]);
    expect(plan.crossing).toEqual([{ src: "y", dst: "x" }]);
  });

  test("blocks внутри набора границу не рвёт", () => {
    const plan = planMoveSet(["x"], oracle([["x", "y"]], [["y", "x"]]));
    expect(plan.members).toEqual(["x", "y"]);
    expect(plan.crossing).toEqual([]);
  });

  test("--with-blockers втягивает связный кусок в обе стороны", () => {
    // b блокирует x, x блокирует c
    const plan = planMoveSet(["x"], oracle([], [["b", "x"], ["x", "c"]]), {
      withBlockers: true,
    });
    expect(plan.members).toEqual(["b", "c", "x"]);
    expect(plan.crossing).toEqual([]);
    expect(plan.expanded).toBe(true);
  });

  test("втянутый блокер приносит СВОЮ цепочку версий, и её blocks тоже рассматриваются", () => {
    // x блокируется b; у b есть версия b0; b0 блокируется z.
    // Наивная реализация (одна волна) увезла бы b0 и не заметила z.
    const plan = planMoveSet(
      ["x"],
      oracle([["b", "b0"]], [["b", "x"], ["z", "b0"]]),
      { withBlockers: true },
    );
    expect(plan.members).toEqual(["b", "b0", "x", "z"]);
    expect(plan.crossing).toEqual([]);
  });

  test("замыкание сходится на цикле blocks и не зацикливается", () => {
    const plan = planMoveSet(["a"], oracle([], [["a", "b"], ["b", "c"], ["c", "a"]]), {
      withBlockers: true,
    });
    expect(plan.members).toEqual(["a", "b", "c"]);
  });

  test("пересечения дедуплицируются и упорядочены", () => {
    const plan = planMoveSet(["m"], oracle([], [["q", "m"], ["m", "p"], ["q", "m"]]));
    expect(plan.crossing).toEqual([
      { src: "m", dst: "p" },
      { src: "q", dst: "m" },
    ]);
  });

  test("ключ прежнего дома — валидный ключ attrs", () => {
    expect(MOVED_FROM_KEY).toBe("moved_from");
    expect(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(MOVED_FROM_KEY)).toBe(true);
  });
});
