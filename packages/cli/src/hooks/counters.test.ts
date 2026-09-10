/**
 * Отметка срабатывания хука (`.myc/hooks.json`) — и главное её свойство:
 * ОНА ОЗНАЧАЕТ РОВНО ТО, ЧТО НА НЕЙ НАПИСАНО.
 *
 * Хук старта сессии зовёт `myc prime` теми же аргументами, что человек в
 * терминале: `--format agent` — умолчание, `--session` берётся из окружения.
 * Значит отличить один вызов от другого можно только по объявлению
 * вызывающего. Счётчик `session-start`, тикающий и от ручного `prime`, означал
 * бы «кто-нибудь запускал prime» — и был бы ХУЖЕ отсутствия счётчика, потому
 * что на нём написано другое (memory-q9k2zxfx2mcm).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COUNTERS_FILE,
  HOOK_AGENT_ENV,
  HOOK_ENV,
  hookCaller,
  markHookCall,
  readCounters,
  SELF_REPORTING_HOOKS,
  UNKNOWN_AGENT,
} from "./counters.ts";
import {
  claudeHelper,
  codexHelper,
  HOOK_EVENTS,
  HOOK_SPECS,
  kimiHelper,
  opencodePlugin,
  type HookEvent,
} from "./templates.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-counters-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function counters(): Record<string, { count: number; last_status: string }> {
  return readCounters(dir).hooks as Record<string, { count: number; last_status: string }>;
}

describe("hookCaller: кто нас позвал", () => {
  test("без объявления — не хук", () => {
    expect(hookCaller({})).toBeNull();
    expect(hookCaller({ [HOOK_AGENT_ENV]: "claude" })).toBeNull();
  });

  test("чужое значение в переменной — тоже не хук", () => {
    expect(hookCaller({ [HOOK_ENV]: "opencode" })).toBeNull();
    expect(hookCaller({ [HOOK_ENV]: "" })).toBeNull();
  });

  test("объявленное событие названо, харнесс — если назван", () => {
    expect(hookCaller({ [HOOK_ENV]: "session-start", [HOOK_AGENT_ENV]: "kimi" })).toEqual({
      event: "session-start",
      agent: "kimi",
    });
    expect(hookCaller({ [HOOK_ENV]: "pre-compact" })).toEqual({
      event: "pre-compact",
      agent: UNKNOWN_AGENT,
    });
  });
});

describe("markHookCall: отметку ставит хук и не ставит человек", () => {
  test("без объявления файла счётчиков не появляется вовсе", () => {
    expect(markHookCall(dir, "session-start", 12, "ok", {})).toBe(false);
    expect(() => readFileSync(join(dir, COUNTERS_FILE), "utf8")).toThrow();
    expect(counters()).toEqual({});
  });

  test("объявленный вызов отмечается ключом «агент:событие»", () => {
    const env = { [HOOK_ENV]: "session-start", [HOOK_AGENT_ENV]: "claude" };
    expect(markHookCall(dir, "session-start", 12, "ok", env)).toBe(true);
    expect(markHookCall(dir, "session-start", 30, "no-session", env)).toBe(true);
    const c = counters()["claude:session-start"];
    expect(c?.count).toBe(2);
    expect(c?.last_status).toBe("no-session");
  });

  /**
   * Событие в переменной и событие обработчика должны СОВПАДАТЬ. Иначе один
   * хук отмечал бы чужое событие: `anchor touch`, позванный из хука старта
   * сессии, записал бы «post-edit срабатывал».
   */
  test("чужое событие в переменной отметки не даёт", () => {
    const env = { [HOOK_ENV]: "post-edit", [HOOK_AGENT_ENV]: "claude" };
    expect(markHookCall(dir, "session-start", 12, "ok", env)).toBe(false);
    expect(counters()).toEqual({});
  });
});

/**
 * Отметка невозможна без объявления, и объявляет его СГЕНЕРИРОВАННЫЙ ФАЙЛ.
 * Мутация, снимающая `MYC_HOOK` или `MYC_HOOK_AGENT` из любого шаблона, роняет
 * этот тест — иначе харнесс тихо перестал бы отмечаться, а `myc doctor --hooks`
 * начал бы отвечать «не срабатывал» про исправно работающий хук.
 */
describe("шаблоны объявляют вызывающего", () => {
  const events: readonly HookEvent[] = HOOK_EVENTS;
  const files: ReadonlyArray<readonly [string, string, string]> = [
    ["claude", claudeHelper({ events, hookOutput: "json" }), "claude"],
    ["codex", codexHelper({ events, hookOutput: "json" }), "codex"],
    ["kimi", kimiHelper({ events, hookOutput: "text" }), "kimi"],
    ["opencode", opencodePlugin({ events, hookOutput: "text" }), "opencode"],
  ];

  for (const [harness, text, agent] of files) {
    test(`${harness}: выставляет ${HOOK_ENV} и ${HOOK_AGENT_ENV}`, () => {
      expect(text).toContain(`${HOOK_ENV}:`);
      expect(text).toContain(`${HOOK_AGENT_ENV}: "${agent}"`);
    });
  }

  /**
   * У helper'ов Claude Code, Codex и Kimi событие — аргумент командной строки
   * (`EV`), и в переменную идёт он же. У плагина opencode обработчиков три, и
   * каждый обязан назвать СВОЁ событие: пока там стояло `MYC_HOOK: "opencode"`,
   * отметки старта сессии и сжатия были неотличимы друг от друга.
   */
  test("opencode называет каждое событие своим именем", () => {
    const text = opencodePlugin({ events, hookOutput: "text" });
    expect(text).toContain(`${HOOK_ENV}: ev`);
    for (const event of ["session-start", "pre-compact", "post-edit"]) {
      expect(text).toContain(`"${event}"`);
    }
    // Имя харнесса в переменной события — прежняя ошибка; в шапке шаблона она
    // названа словами, поэтому смотрим именно на строку env, а не на весь файл.
    expect(text).not.toContain(`env: { ...process.env, ${HOOK_ENV}: "opencode"`);
  });
});

describe("список самоотмечающихся событий", () => {
  test("в нём только события из таблицы хуков", () => {
    const known = new Set(HOOK_SPECS.map((s) => s.event as string));
    for (const event of SELF_REPORTING_HOOKS) expect(known.has(event)).toBe(true);
  });

  /**
   * `stop` вне списка не по забывчивости: команды `myc close-session` в сборке
   * нет, хук не ставится, и отмечать нечего. Попади он в список — doctor стал
   * бы утверждать «не срабатывал» про то, чего не существует.
   */
  test("stop в него не входит", () => {
    expect(SELF_REPORTING_HOOKS).not.toContain("stop");
  });
});
