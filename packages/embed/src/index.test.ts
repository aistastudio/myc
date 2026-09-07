import { describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS } from "./index.ts";

describe("embed (skeleton)", () => {
  test("EMBEDDING_DIMENSIONS matches bge-small-en-v1.5", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384);
  });
});
