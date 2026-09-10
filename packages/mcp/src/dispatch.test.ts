/**
 * Тесты диспетчера с подменным runCli: проверяем грамматику argv, сборку
 * текстового блока, structuredContent и доезжание деградации — без SQLite.
 * Прямой стор (link/release/extend/note) — в store.test.ts против настоящей базы.
 */

import { describe, expect, test } from "bun:test";
import { createDispatcher, type CliOutcome, type Dispatch, type RunCli } from "./dispatch.ts";

function okEnvelope(data: Record<string, unknown>, meta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    cmd: "test",
    data,
    meta: { took_ms: 1, degraded: [], ...meta },
    warn: [],
  });
}

function errEnvelope(code: string, msg: string, hint?: string): string {
  return JSON.stringify({
    ok: false,
    cmd: "test",
    data: null,
    meta: { degraded: [] },
    warn: [],
    error: { code, msg, exit: 4, ...(hint !== undefined ? { hint } : {}) },
  });
}

interface Fake {
  runCli: RunCli;
  calls: string[][];
}

function fakeCli(handler: (argv: readonly string[], json: boolean) => CliOutcome): Fake {
  const calls: string[][] = [];
  return {
    calls,
    runCli: async (argv) => {
      calls.push([...argv]);
      return handler(argv, argv.includes("--json"));
    },
  };
}

function dispatchWith(handler: (argv: readonly string[], json: boolean) => CliOutcome): { d: Dispatch; fake: Fake } {
  const fake = fakeCli(handler);
  return { d: createDispatcher({ runCli: fake.runCli }), fake };
}

const text = (r: { content: readonly { text: string }[] }): string => r.content[0]!.text;

describe("dispatch: грамматика и формат ответа", () => {
  test("myc_prime: текст — готовый блок bootstrap, структура — data + meta", async () => {
    const { d, fake } = dispatchWith((_argv, json) => {
      expect(json).toBe(true);
      return { code: 0, stdout: okEnvelope({ text: "# MYC BOOTSTRAP\nблок", chars: 20, took_ms: 1 }) };
    });
    const r = await d("myc_prime", { budget: 900 });
    expect(fake.calls[0]).toEqual(["bootstrap", "--budget", "900", "--json"]);
    expect(text(r)).toBe("# MYC BOOTSTRAP\nблок");
    const sc = r.structuredContent as { chars: number; meta: { degraded: string[] } };
    expect(sc.chars).toBe(20);
    expect(sc.meta.degraded).toEqual([]);
  });

  test("myc_ready список: два прогона (human+json), текст дословно из CLI", async () => {
    const { d, fake } = dispatchWith((_argv, json) =>
      json
        ? { code: 0, stdout: okEnvelope({ items: [{ id: "myc-1" }], ready: 1, blocked: 0, in_progress: 0, took_ms: 2 }) }
        : { code: 0, stdout: "myc-1  P0  task  дело\n1 ready · 0 blocked · 0 in_progress · 2 мс\n" },
    );
    const r = await d("myc_ready", { n: 3, kind: ["task"] });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toEqual(["ready", "--n", "3", "--kind", "task"]);
    expect(fake.calls[1]).toEqual(["ready", "--n", "3", "--kind", "task", "--json"]);
    expect(text(r)).toContain("myc-1  P0  task  дело");
    const sc = r.structuredContent as { ready: number; meta: { took_ms: number } };
    expect(sc.ready).toBe(1);
  });

  test("myc_ready{claim:true}: ОДИН мутирующий прогон, задача взята, lease_until ISO", async () => {
    const claimed = {
      id: "myc-9",
      holder: "agent",
      lease_expires: 1_800_000_000_000,
      lease_ttl_ms: 1_800_000,
      type: "task",
      priority: 0,
      title: "сделать",
      body: "подробности",
      blocked_by: ["myc-3 (open)"],
    };
    const { d, fake } = dispatchWith(() => ({
      code: 0,
      stdout: okEnvelope({ items: [], ready: 1, blocked: 0, in_progress: 0, claimed, took_ms: 2 }),
    }));
    const r = await d("myc_ready", { claim: true, lease_minutes: 45 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual(["ready", "--claim", "--lease", "45m", "--json"]);
    expect(text(r)).toContain("claimed myc-9 by agent");
    expect(text(r)).toContain("deps      blocked-by myc-3 (open)");
    const sc = r.structuredContent as { claimed: { id: string; lease_until: string }; counts: { ready: number } };
    expect(sc.claimed.id).toBe("myc-9");
    expect(sc.claimed.lease_until).toBe(new Date(1_800_000_000_000).toISOString());
    expect(sc.counts.ready).toBe(1);
  });

  test("myc_ready{claim:true,id}: claim + контекст из show одним намерением", async () => {
    const { d, fake } = dispatchWith((argv, json) => {
      if (argv[0] === "claim") {
        return {
          code: 0,
          stdout: okEnvelope({
            id: "myc-9", holder: "agent", epoch: 1, lease_expires: 1_800_000_000_000,
            lease_ttl_ms: 1_800_000, status: "in_progress", prev_status: "open",
            type: "task", priority: 1, took_ms: 1,
          }),
        };
      }
      // show
      return json
        ? { code: 0, stdout: okEnvelope({ id: "myc-9", title: "сделать", body: "тело", blocked_by: [], anchors: [{ path: "a.ts", start: 1, end: 2, state: "fresh" }], links: [], took_ms: 1 }) }
        : { code: 0, stdout: "myc-9  task  P1  in_progress\nсделать\n" };
    });
    const r = await d("myc_ready", { claim: true, id: "myc-9" });
    expect(fake.calls.map((c) => c[0])).toEqual(["claim", "show", "show"]);
    expect(text(r)).toContain("claimed myc-9");
    expect(text(r)).toContain("myc-9  task  P1  in_progress");
    const sc = r.structuredContent as { claimed: { body: string; anchors: unknown[] } };
    expect(sc.claimed.body).toBe("тело");
    expect(sc.claimed.anchors).toHaveLength(1);
  });

  test("гонка claim: isError conflict.claimed + следующая свободная задача в ready", async () => {
    const { d } = dispatchWith((argv) => {
      if (argv[0] === "claim") {
        return { code: 4, stdout: errEnvelope("conflict.claimed", "myc-9 уже взята bob", "дождаться") };
      }
      return { code: 0, stdout: okEnvelope({ items: [{ id: "myc-10" }], ready: 1, blocked: 0, in_progress: 1, took_ms: 1 }) };
    });
    const r = await d("myc_update", { id: "myc-9", op: "claim" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("myc: conflict.claimed: myc-9 уже взята bob");
    expect(text(r)).toContain("hint: дождаться");
    const sc = r.structuredContent as { ready: { id: string }[] };
    expect(sc.ready[0]!.id).toBe("myc-10");
  });

  test("myc_update close: reason/outcome/verify/cost маппятся во флаги", async () => {
    const { d, fake } = dispatchWith(() => ({
      code: 0,
      stdout: okEnvelope({ id: "myc-9", status: "closed", closed_by: "agent", unblocked: ["myc-11"], took_ms: 1 }),
    }));
    const r = await d("myc_update", {
      id: "myc-9", op: "close", reason: "готово", outcome: "done", verify: "tests",
      cost: { tokens_in: 100, tokens_out: 50, model: "m1", retries: 1 },
    });
    expect(fake.calls[0]).toEqual([
      "close", "myc-9", "--reason", "готово", "--outcome", "done", "--verify", "tests",
      "--cost-in", "100", "--cost-out", "50", "--model", "m1", "--retries", "1", "--json",
    ]);
    expect(text(r)).toContain("closed myc-9");
    expect(text(r)).toContain("unblocked myc-11");
  });

  test("myc_update close без reason — usage.missing до похода в движок", async () => {
    const { d, fake } = dispatchWith(() => ({ code: 0, stdout: "{}" }));
    const r = await d("myc_update", { id: "myc-9", op: "close" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("myc: usage.missing");
    expect(fake.calls).toHaveLength(0);
  });

  test("myc_remember: absorb=false → --no-absorb; эвристика → degraded llm.chat.off + WARN", async () => {
    const rememberData = {
      id: "myc-f1", kind: "note", tier: "project", layer: 1, acl: "team",
      tags: ["x"], anchors: [], queue: ["embed", "absorb"], absorb_heuristic: true, took_ms: 1,
    };
    const { d, fake } = dispatchWith(() => ({ code: 0, stdout: okEnvelope(rememberData) }));
    const r = await d("myc_remember", { text: "факт достаточной длины", tag: ["x"], layer: "L2" });
    expect(fake.calls[0]).toEqual(["remember", "факт достаточной длины", "--tag", "x", "--layer", "L2", "--json"]);
    expect(text(r)).toContain("WARN llm.chat.off");
    const sc = r.structuredContent as { verdict_source: string; meta: { degraded: string[] } };
    expect(sc.verdict_source).toBe("heuristic");
    expect(sc.meta.degraded).toContain("llm.chat.off");

    const r2 = await d("myc_remember", { text: "ещё один факт длины", absorb: false });
    expect(fake.calls[1]).toContain("--no-absorb");
    expect((r2.structuredContent as { verdict_source: string }).verdict_source).toBe("skipped");
  });

  test("myc_recall: фильтры маппятся, деградация доезжает в meta и WARN-строках", async () => {
    const { d, fake } = dispatchWith((_argv, json) =>
      json
        ? { code: 0, stdout: okEnvelope(
            { query: "q", rows: [], total: 0, took_ms: 1 },
            { degraded: ["degraded.retrieval"], mode_used: { vector: "unavailable" } },
          ) }
        : { code: 0, stdout: "0 из 0 · пусто\nWARN degraded.retrieval: векторная ветка не участвовала\n" },
    );
    const r = await d("myc_recall", { query: "что с recall", kind: ["memory", "decision"], layer: ["L1", "L3"], mode: "bm25", since: "7d" });
    expect(fake.calls[0]).toEqual([
      "recall", "что с recall", "--limit", "6", "--budget", "2000",
      "--kind", "memory,decision", "--layer", "L1..L3", "--since", "7d", "--mode", "bm25",
    ]);
    expect(text(r)).toContain("WARN degraded.retrieval");
    const sc = r.structuredContent as { meta: { degraded: string[] } };
    expect(sc.meta.degraded).toContain("degraded.retrieval");
  });

  test("myc_show: ids склеиваются, одиночный узел нормализуется в nodes[]", async () => {
    const { d, fake } = dispatchWith((_argv, json) =>
      json
        ? { code: 0, stdout: okEnvelope({ id: "myc-1", kind: "task", title: "один", took_ms: 1 }) }
        : { code: 0, stdout: "myc-1  task  open\nодин\n" },
    );
    const r = await d("myc_show", { ids: ["myc-1"], depth: 1 });
    expect(fake.calls[0]).toEqual(["show", "myc-1", "--depth", "1"]);
    const sc = r.structuredContent as { nodes: { id: string }[] };
    expect(sc.nodes).toHaveLength(1);
    expect(sc.nodes[0]!.id).toBe("myc-1");
  });

  test("myc_link blocks → dep add; remove → dep rm", async () => {
    const { d, fake } = dispatchWith(() => ({
      code: 0,
      stdout: okEnvelope({ src: "myc-1", dst: "myc-2", type: "blocks", from_label: "myc-1", left_ready: true, left_ready_id: "myc-2", took_ms: 1 }),
    }));
    const r = await d("myc_link", { from: "myc-1", type: "blocks", to: "myc-2" });
    expect(fake.calls[0]).toEqual(["dep", "add", "myc-1", "blocks", "myc-2", "--json"]);
    expect(text(r)).toContain("myc-1 blocks myc-2");
    const sc = r.structuredContent as { effects: string[] };
    expect(sc.effects[0]).toContain("вышла из ready");

    await d("myc_link", { from: "myc-1", type: "blocks", to: "myc-2", remove: true });
    expect(fake.calls[1]).toEqual(["dep", "rm", "myc-1", "blocks", "myc-2", "--json"]);
  });

  test("myc_link supersedes без reason — usage.missing до движка", async () => {
    const { d, fake } = dispatchWith(() => ({ code: 0, stdout: "{}" }));
    const r = await d("myc_link", { from: "myc-1", type: "supersedes", to: "myc-2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("myc: usage.missing");
    expect(fake.calls).toHaveLength(0);
  });

  test("массивы длиной > 1 для однозначных флагов — честная ошибка, не молчаливый срез", async () => {
    const { d } = dispatchWith(() => ({ code: 0, stdout: "{}" }));
    const r = await d("myc_ready", { kind: ["task", "bug"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("usage.invalid");
  });
});

// ---------------------------------------------------------------------------
// Паритет поверхностей: намеренно человеческие операции
// ---------------------------------------------------------------------------

describe("myc_update: операции, не выданные агенту", () => {
  test("cancel отвергается ОБЪЯСНЕНИЕМ, а не 'неверный op'", async () => {
    // Разница между «нет операции» и «операция человеческая» для агента
    // невидима, если отвечать одним usage.invalid: он не отличит недосмотр от
    // решения и начнёт искать обход. Ровно так появился P0 с арендой — там
    // асимметрия была зеркальной: release у агента был, у человека нет.
    const { d, fake } = dispatchWith(() => ({ code: 0, stdout: okEnvelope({}) }));
    const r = await d("myc_update", { id: "x", op: "cancel" });
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toContain("precond.human_only");
    // Отказ обязан назвать ПРИЧИНУ и дать выход, иначе он ничем не лучше молчания.
    expect(t).toContain("человеческое суждение");
    expect(t).toContain("myc update");
    // И ни одной команды CLI выполнено не было.
    expect(fake.calls.length).toBe(0);
  });

  test("неизвестная операция остаётся обычной ошибкой ввода", async () => {
    const { d } = dispatchWith(() => ({ code: 0, stdout: okEnvelope({}) }));
    const r = await d("myc_update", { id: "x", op: "выдумка" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("usage.invalid");
  });

  test("схема инструмента предупреждает об отсутствии cancel заранее", async () => {
    // Узнать о решении на отказе — уже поздно: агент потратил вызов и,
    // возможно, решил, что myc сломан. Причина обязана быть в описании.
    const { AGENT_TOOLS } = await import("./tools.ts");
    const update = AGENT_TOOLS.find((t) => t.name === "myc_update");
    const schema = JSON.stringify(update?.inputSchema ?? {});
    expect(schema).toContain("cancel");
    expect(schema).toContain("человеческое суждение");
  });
});

// ---------------------------------------------------------------------------
// Инструменты кода: аргументы → флаги той же команды CLI
// ---------------------------------------------------------------------------

describe("инструменты кода: argv — та же команда, что набрал бы человек", () => {
  const ok = (_argv: readonly string[], json: boolean): CliOutcome =>
    json ? { code: 0, stdout: okEnvelope({ hits: [], took_ms: 1 }) } : { code: 0, stdout: "ответ\n" };

  test("myc_code_grep: флаги до `--`, литерал после, --json ДО разделителя", async () => {
    const { d, fake } = dispatchWith(ok);
    const r = await d("myc_code_grep", { literal: "--limit", ignore_case: true, lang: ["ts", "md"], limit: 5 });
    expect(r.isError).toBeUndefined();
    // Литерал, похожий на флаг, — позиционный: без `--` его съел бы разбор
    // флагов, и grep искал бы не то, о чём спросили.
    expect(fake.calls).toEqual([
      ["code", "grep", "--ignore-case", "--lang", "ts,md", "--limit", "5", "--", "--limit"],
      ["code", "grep", "--ignore-case", "--lang", "ts,md", "--limit", "5", "--json", "--", "--limit"],
    ]);
    expect(text(r)).toBe("ответ\n");
  });

  test("myc_code_grep: пробелы литерала — часть вопроса, trim их не съедает", async () => {
    const { d, fake } = dispatchWith(ok);
    await d("myc_code_grep", { literal: "  x = " });
    expect(fake.calls[0]).toEqual(["code", "grep", "--", "  x = "]);
  });

  test("myc_callers: direction/depth/kind/limit — флагами, проверку ведёт команда", async () => {
    const { d, fake } = dispatchWith(ok);
    await d("myc_callers", { name: "leaf", direction: "out", depth: "all", kind: ["call", "new"], limit: 3 });
    expect(fake.calls[0]).toEqual([
      "callers", "--direction", "out", "--depth", "all", "--kind", "call,new", "--limit", "3", "--", "leaf",
    ]);
    await d("myc_callers", { name: "leaf", depth: 2 });
    expect(fake.calls[2]).toEqual(["callers", "--depth", "2", "--", "leaf"]);
  });

  test("myc_code_search, myc_code_symbol, myc_skeleton, myc_code_map", async () => {
    const { d, fake } = dispatchWith(ok);
    await d("myc_code_search", { query: "очередь заданий", limit: 4 });
    await d("myc_code_symbol", { name: "drainAfterCommand" });
    await d("myc_skeleton", { path: "src/a.ts", exported: true });
    await d("myc_code_map", { top: 2 });
    await d("myc_code_map", {});
    const human = fake.calls.filter((c) => !c.includes("--json"));
    expect(human).toEqual([
      ["code", "search", "--limit", "4", "--", "очередь заданий"],
      ["code", "symbol", "--", "drainAfterCommand"],
      ["skeleton", "--exported", "--", "src/a.ts"],
      ["code", "map", "--top", "2"],
      ["code", "map"],
    ]);
    expect(fake.calls.filter((c) => c.includes("--json"))).toHaveLength(5);
  });

  test("мусор во входе — usage до похода в движок; лимит не зажимается молча", async () => {
    const { d, fake } = dispatchWith(ok);
    for (const [tool, args] of [
      ["myc_code_grep", {}],
      ["myc_code_grep", { literal: "" }],
      ["myc_code_symbol", { name: "  " }],
      ["myc_callers", { name: "x", depth: { n: 2 } }],
      ["myc_code_search", { query: "x", limit: 0 }],
      ["myc_code_map", { top: 2.5 }],
      ["myc_code_grep", { literal: "x", lang: "ts" }],
    ] as const) {
      const r = await d(tool, args as Record<string, unknown>);
      expect({ tool, isError: r.isError, code: /^myc: (usage\.[a-z]+):/.exec(text(r))?.[1] !== undefined }).toEqual({
        tool,
        isError: true,
        code: true,
      });
    }
    expect(fake.calls).toHaveLength(0);
  });

  test("индекса нет — отказ команды доезжает кодом и командой, а не пустой выдачей", async () => {
    const { d } = dispatchWith(() => ({
      code: 5,
      stdout: errEnvelope("precond.no_index", "код-индекс этого репозитория не построен", "myc code index"),
    }));
    for (const [tool, args] of [
      ["myc_code_search", { query: "q" }],
      ["myc_code_grep", { literal: "q" }],
      ["myc_code_symbol", { name: "q" }],
      ["myc_callers", { name: "q" }],
      ["myc_skeleton", { path: "q.ts" }],
      ["myc_code_map", {}],
    ] as const) {
      const r = await d(tool, args as Record<string, unknown>);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("myc: precond.no_index: код-индекс этого репозитория не построен\nhint: myc code index");
    }
  });
});
