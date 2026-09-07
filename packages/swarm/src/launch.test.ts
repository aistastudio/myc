/**
 * Контекст запуска и классификация процесса — чистые функции, поэтому
 * проверяются без базы, без агента и без живых процессов.
 *
 * Здесь стоят два ограждения, каждое из которых существует потому, что
 * без него уже было плохо:
 *
 * - «завершено, но живо» ОБЯЗАНО отличаться от «завершено»: 2026-09-07
 *   три процесса провисели 6 ч 52 мин именно потому, что эти два случая
 *   были одним;
 * - источник связи с сессией ОБЯЗАН храниться рядом со связью: связь,
 *   выведенная перебором стенограмм, ломается молча, и отличить её от
 *   записанной надо ДО того, как по ней посчитают деньги.
 */

import { describe, expect, test } from "bun:test";
import {
  EMPTY_LAUNCH,
  isAlive,
  isEmptyLaunch,
  launchContext,
  LIVE_STATES,
  liveStateOf,
  overrideLaunch,
  parsePid,
  pidAlive,
} from "./launch.ts";

/** Окружение настоящего агентского процесса, снятое 2026-09-07. */
const REAL_ENV = {
  CLAUDE_CODE_SESSION_ID: "b1b7b2cd-9322-4ad5-ad7f-adf39cbb68d6",
  CLAUDE_PID: "81610",
  ORCA_TERMINAL_HANDLE: "term_7de4e77c-fa4d-4f25-b262-15d0e1ed6574",
  ORCA_PANE_KEY: "ab4038fc-1b32-47ca-a814-9fa5ff4aca1e:6b78775f-e1c9-4a0d-a0b4-dc22bf04731b",
  AI_AGENT: "claude-code_2-1-263_agent",
} as const;

describe("launchContext", () => {
  test("настоящее окружение агента даёт сессию, pid и терминал без единого поиска", () => {
    const c = launchContext(REAL_ENV);
    expect(c.sessionId).toBe("b1b7b2cd-9322-4ad5-ad7f-adf39cbb68d6");
    expect(c.sessionSource).toBe("env");
    expect(c.agentPid).toBe(81610);
    expect(c.pidSource).toBe("env");
    expect(c.terminal).toBe("term_7de4e77c-fa4d-4f25-b262-15d0e1ed6574");
    expect(c.paneKey).toContain(":");
    expect(c.harnessBuild).toBe("claude-code_2-1-263_agent");
  });

  test("диспетчера в окружении нет — и это записано как 'none', а не выдумано", () => {
    const c = launchContext(REAL_ENV);
    expect(c.dispatchId).toBeNull();
    expect(c.dispatchSource).toBe("none");
  });

  test("пустое окружение — ни одной выдуманной связи", () => {
    expect(launchContext({})).toEqual(EMPTY_LAUNCH);
    expect(isEmptyLaunch(launchContext({}))).toBe(true);
    expect(isEmptyLaunch(launchContext(REAL_ENV))).toBe(false);
  });

  test("MYC_SESSION_ID перекрывает харнесс: у двух харнессов из трёх автоопределения нет", () => {
    const c = launchContext({ ...REAL_ENV, MYC_SESSION_ID: "manual-uuid" });
    expect(c.sessionId).toBe("manual-uuid");
    expect(c.sessionSource).toBe("env");
  });

  test("пробелы вокруг значения не делают связь, которой нет", () => {
    expect(launchContext({ CLAUDE_CODE_SESSION_ID: "   " }).sessionId).toBeNull();
    expect(launchContext({ CLAUDE_CODE_SESSION_ID: " x " }).sessionId).toBe("x");
  });
});

describe("parsePid", () => {
  test("мусор — это null, а не ноль", () => {
    for (const bad of ["", "0", "-1", "12.5", "abc", "1e5", " 12"]) {
      expect(parsePid(bad)).toBeNull();
    }
    expect(parsePid("81610")).toBe(81610);
  });

  test("pid 0 не проходит: kill(0, 0) бьёт по всей группе процессов", () => {
    expect(launchContext({ CLAUDE_PID: "0" }).agentPid).toBeNull();
    expect(launchContext({ CLAUDE_PID: "0" }).pidSource).toBe("none");
  });
});

describe("overrideLaunch", () => {
  test("названное явно побеждает и МЕНЯЕТ источник: flag ≠ env", () => {
    const c = overrideLaunch(launchContext(REAL_ENV), {
      sessionId: "other",
      dispatchId: "ctx_4deb47fc99e1",
    });
    expect(c.sessionId).toBe("other");
    expect(c.sessionSource).toBe("flag");
    expect(c.dispatchId).toBe("ctx_4deb47fc99e1");
    expect(c.dispatchSource).toBe("flag");
    // Не названное осталось из окружения — вместе со своим источником.
    expect(c.agentPid).toBe(81610);
    expect(c.pidSource).toBe("env");
  });

  test("найденное перебором помечается 'search' и отличимо от записанного", () => {
    const c = overrideLaunch(EMPTY_LAUNCH, {
      sessionId: "found-by-needle",
      sessionSource: "search",
    });
    expect(c.sessionSource).toBe("search");
  });
});

describe("liveStateOf", () => {
  const open = { finishedAt: null };
  const closed = { finishedAt: 1 };

  test("живой процесс закрытой попытки — orphan, а не done", () => {
    expect(liveStateOf(closed, true)).toBe("orphan");
    expect(liveStateOf(closed, false)).toBe("done");
  });

  test("живой процесс открытой попытки — работает", () => {
    expect(liveStateOf(open, true)).toBe("working");
  });

  test("процесса нет, а работа не закрыта — lost, а не done", () => {
    expect(liveStateOf(open, false)).toBe("lost");
  });

  test("pid не записан — unknown, а не тихое 'всё в порядке'", () => {
    expect(liveStateOf(open, null)).toBe("unknown");
    expect(liveStateOf(closed, null)).toBe("unknown");
  });

  test("занимают машину ровно working и orphan", () => {
    const alive = LIVE_STATES.filter(isAlive);
    expect(alive).toEqual(["working", "orphan"]);
  });

  test("четыре наблюдаемых случая различимы попарно", () => {
    const states = [
      liveStateOf(open, true),
      liveStateOf(closed, true),
      liveStateOf(open, false),
      liveStateOf(closed, false),
    ];
    expect(new Set(states).size).toBe(4);
  });
});

describe("pidAlive", () => {
  test("свой процесс жив", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("заведомо мёртвый pid — false, а не исключение", () => {
    // Максимальный pid + 1: такого процесса нет ни на одной системе.
    expect(pidAlive(0x7fffffff)).toBe(false);
  });

  test("нет pid — нечего спрашивать: null, не false", () => {
    expect(pidAlive(null)).toBeNull();
    expect(pidAlive(0)).toBeNull();
  });

  test("чужой процесс (EPERM) считается живым: pid 1 есть всегда", () => {
    expect(pidAlive(1)).toBe(true);
  });
});
