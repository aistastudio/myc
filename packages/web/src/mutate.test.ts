/**
 * Два списка операций `POST /api/nodes/<id>/op` — WRITE_OPS (переходы задачи)
 * и REVIEW_OPS (разбор кандидата) — и почему их два (memory-nm92qfhm12ht п.3,
 * шапка REVIEW_OPS в mutate.ts). Сливать нечего, но держать раздельно можно
 * только пока каждое имя уходит в свою ветку `planOp`.
 *
 * МУТАЦИЯ: добавить "confirm" в WRITE_OPS — падают первые два теста (имя в
 * обоих списках `planOp` молча отдаёт разбору, и ветка переходов его не видит).
 */

import { describe, expect, test } from "bun:test";
import { planOp, REVIEW_OPS, WRITE_OPS, type WritePlan } from "./mutate.ts";

/** Тело, которого хватает любой операции: причина, исполнитель, приоритет. */
const BODY = { reason: "причина", assignee: "agent", priority: 1 };

function argvOf(op: string): readonly string[] | undefined {
  const r = planOp("myc-1", { ...BODY, op });
  return "argv" in r ? (r as WritePlan).argv : undefined;
}

describe("операции POST /op: два списка, две ветки", () => {
  test("списки не пересекаются", () => {
    const both = WRITE_OPS.filter((op) => (REVIEW_OPS as readonly string[]).includes(op));
    expect(both).toEqual([]);
  });

  test("каждая операция разбора уходит в myc review, каждый переход — мимо него", () => {
    for (const op of REVIEW_OPS) expect([op, argvOf(op)?.slice(0, 2)]).toEqual([op, ["review", op]]);
    for (const op of WRITE_OPS) {
      const argv = argvOf(op);
      expect([op, argv !== undefined]).toEqual([op, true]);
      expect([op, argv![0]]).not.toEqual([op, "review"]);
    }
  });

  test("неизвестная операция называет обе группы", () => {
    const r = planOp("myc-1", { op: "nope" });
    expect("argv" in r).toBe(false);
    const hint = (r as { hint?: string }).hint ?? "";
    for (const op of [...WRITE_OPS, ...REVIEW_OPS]) expect(hint).toContain(op);
  });
});
