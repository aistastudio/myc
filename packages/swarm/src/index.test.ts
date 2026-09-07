import { describe, expect, test } from "bun:test";
import type { RoutingArm } from "./index.ts";

describe("swarm (skeleton)", () => {
  test("RoutingArm pairs a model id with an effort level", () => {
    const arm: RoutingArm = { modelId: "sonnet-5", effort: "medium" };
    expect(arm.modelId).toBe("sonnet-5");
  });
});
