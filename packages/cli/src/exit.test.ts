import { describe, expect, test } from "bun:test";
import { ExitCode } from "./exit.ts";

describe("ExitCode", () => {
  // Источник истины — docs/design/03-interfaces-and-integration.md §2.2.
  // Проверяем состав и значения поимённо, а не количество: тест на длину
  // проходит и на неверном наборе.
  const contract: ReadonlyArray<readonly [keyof typeof ExitCode, number]> = [
    ["OK", 0],
    ["ERR", 1],
    ["USAGE", 2],
    ["NOTFOUND", 3],
    ["CONFLICT", 4],
    ["PRECOND", 5],
    ["DEGRADED", 6],
    ["NOWS", 7],
    ["DENIED", 8],
    ["TIMEOUT", 9],
  ];

  test.each(contract)("%s = %i", (name, code) => {
    expect(ExitCode[name]).toBe(code);
  });

  test("состав enum совпадает с контрактом целиком", () => {
    const names = Object.keys(ExitCode).filter((k) => Number.isNaN(Number(k)));
    expect(names.sort()).toEqual(contract.map(([n]) => n).sort());
  });

  test("значения уникальны и лежат в 0-9", () => {
    const values = Object.values(ExitCode).filter(
      (v): v is number => typeof v === "number",
    );
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(9);
    }
  });
});
