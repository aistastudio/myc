import { describe, expect, test } from "bun:test";
import type { DistillStage } from "./index.ts";

describe("distiller (skeleton)", () => {
  test("DistillStage accepts absorb", () => {
    const stage: DistillStage = "absorb";
    expect(stage).toBe("absorb");
  });
});
