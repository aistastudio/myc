import { describe, expect, test } from "bun:test";
import type { RetrievalQuery } from "./index.ts";

describe("retrieval (skeleton)", () => {
  test("RetrievalQuery accepts text and optional limit", () => {
    const query: RetrievalQuery = { text: "hello", limit: 10 };
    expect(query.text).toBe("hello");
  });
});
