import { describe, expect, test } from "bun:test";
import { EDGE_KINDS, NODE_KINDS, SCHEMA_VERSION } from "./index.ts";

describe("core", () => {
  test("SCHEMA_VERSION is a positive integer", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  test("NODE_KINDS has nine distinct kinds", () => {
    expect(NODE_KINDS.length).toBe(9);
    expect(new Set(NODE_KINDS).size).toBe(9);
  });

  test("EDGE_KINDS has eleven distinct kinds", () => {
    expect(EDGE_KINDS.length).toBe(11);
    expect(new Set(EDGE_KINDS).size).toBe(11);
  });
});
