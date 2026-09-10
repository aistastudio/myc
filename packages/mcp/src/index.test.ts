import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS, CODE_TOOLS, WORK_TOOLS, toolsForProfile } from "./tools.ts";
import {
  AGENT_PROFILE_TOKEN_BUDGET,
  CODE_DESCRIPTION_TOKEN_BUDGET,
  DESCRIPTION_TOKEN_BUDGET,
  GRAFT_TOOLS_TOKENS,
  profileDescriptionTokens,
  toolDescriptionChars,
  estimateTokens,
} from "./tokens.ts";
import { createDispatcher, UnknownToolError } from "./dispatch.ts";

describe("профиль agent: состав и бюджет описаний", () => {
  test("7 инструментов работы, состав по §4.2", () => {
    expect(WORK_TOOLS.map((t) => t.name)).toEqual([
      "myc_prime",
      "myc_ready",
      "myc_update",
      "myc_recall",
      "myc_remember",
      "myc_show",
      "myc_link",
    ]);
  });

  test("6 инструментов кода — по одному на вопрос, ради которого стоял graft", () => {
    expect(CODE_TOOLS.map((t) => t.name)).toEqual([
      "myc_code_search",
      "myc_code_grep",
      "myc_code_symbol",
      "myc_callers",
      "myc_skeleton",
      "myc_code_map",
    ]);
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([...WORK_TOOLS, ...CODE_TOOLS].map((t) => t.name));
    expect(new Set(AGENT_TOOLS.map((t) => t.name)).size).toBe(13);
  });

  // mcp.profile.agent.description_tokens <= 1100: ломает сборку при превышении
  test(`описания инструментов работы <= ${DESCRIPTION_TOKEN_BUDGET} токенов`, () => {
    expect(profileDescriptionTokens(WORK_TOOLS)).toBeLessThanOrEqual(DESCRIPTION_TOKEN_BUDGET);
  });

  // Потолок кода = замер graft, которого эти инструменты заменяют: снятие
  // graft обязано удешевить сессию, а не удорожить её.
  test(`описания инструментов кода <= ${CODE_DESCRIPTION_TOKEN_BUDGET} токенов (graft стоил ${GRAFT_TOOLS_TOKENS})`, () => {
    expect(CODE_DESCRIPTION_TOKEN_BUDGET).toBe(GRAFT_TOOLS_TOKENS);
    expect(profileDescriptionTokens(CODE_TOOLS)).toBeLessThanOrEqual(CODE_DESCRIPTION_TOKEN_BUDGET);
    expect(profileDescriptionTokens(AGENT_TOOLS)).toBeLessThanOrEqual(AGENT_PROFILE_TOKEN_BUDGET);
  });

  test("у каждого инструмента кода описание говорит, КОГДА его брать, а не только что он делает", () => {
    // Описание — инструкция выбора. Соседи названы по имени там, где агент
    // мог бы перепутать инструменты: поиск ↔ grep ↔ symbol, map → куда дальше.
    const by = new Map(CODE_TOOLS.map((t) => [t.name, t.description]));
    expect(by.get("myc_code_search")).toContain("myc_code_grep");
    expect(by.get("myc_code_search")).toContain("myc_code_symbol");
    expect(by.get("myc_code_map")).toContain("myc_code_search");
    expect(by.get("myc_callers")).toContain("ДО переименования");
    expect(by.get("myc_callers")).toContain("WARN callers.ambiguous");
    expect(by.get("myc_skeleton")).toContain("WARN skeleton.stale");
    for (const t of CODE_TOOLS) expect(t.needsVector).toBeUndefined();
  });

  test("оценщик консервативен: пустая строка — 0, 3 символа — 1", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(toolDescriptionChars(AGENT_TOOLS[0]!)).toBeGreaterThan(0);
  });

  test("leader/full пока не реализованы (myc-zdk)", () => {
    expect(() => toolsForProfile("leader")).toThrow(/myc-zdk/);
    expect(toolsForProfile("agent")).toHaveLength(13);
  });

  test("у каждого объявленного инструмента есть обработчик", async () => {
    // Объявленный, но не подключённый тул агент увидит в tools/list и получит
    // -32602 на вызове — отказ, который этот репозиторий уже ловил у команд.
    const dispatch = createDispatcher({
      runCli: async () => ({ code: 2, stdout: "{}" }),
    });
    for (const t of AGENT_TOOLS) {
      let unknown = false;
      try {
        await dispatch(t.name, {});
      } catch (e) {
        unknown = e instanceof UnknownToolError;
      }
      expect({ tool: t.name, unknown }).toEqual({ tool: t.name, unknown: false });
    }
  });
});
