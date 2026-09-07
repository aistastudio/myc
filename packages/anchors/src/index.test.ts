import { describe, expect, test } from "bun:test";
import type { Anchor } from "./index.ts";

describe("anchors (skeleton)", () => {
  test("Anchor requires repo and path", () => {
    const anchor: Anchor = { repo: "myc", path: "src/index.ts" };
    expect(anchor.repo).toBe("myc");
  });
});
