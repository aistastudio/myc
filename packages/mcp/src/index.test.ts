import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS, toolsForProfile } from "./tools.ts";
import {
  DESCRIPTION_TOKEN_BUDGET,
  profileDescriptionTokens,
  toolDescriptionChars,
  estimateTokens,
} from "./tokens.ts";

describe("профиль agent: бюджет описаний", () => {
  test("ровно 7 инструментов, состав по §4.2", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      "myc_prime",
      "myc_ready",
      "myc_update",
      "myc_recall",
      "myc_remember",
      "myc_show",
      "myc_link",
    ]);
  });

  // mcp.profile.agent.description_tokens <= 1100: ломает сборку при превышении
  test(`суммарные описания <= ${DESCRIPTION_TOKEN_BUDGET} токенов`, () => {
    const total = profileDescriptionTokens(AGENT_TOOLS);
    expect(total).toBeLessThanOrEqual(DESCRIPTION_TOKEN_BUDGET);
  });

  test("оценщик консервативен: пустая строка — 0, 3 символа — 1", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(toolDescriptionChars(AGENT_TOOLS[0]!)).toBeGreaterThan(0);
  });

  test("leader/full пока не реализованы (myc-zdk)", () => {
    expect(() => toolsForProfile("leader")).toThrow(/myc-zdk/);
    expect(toolsForProfile("agent")).toHaveLength(7);
  });
});
