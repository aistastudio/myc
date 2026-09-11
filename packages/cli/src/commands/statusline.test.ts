/**
 * `myc statusline` в процессе: что показывает строка и откуда берёт числа.
 * Передача ввода чужой строке и её итог, две сессии одновременно и большой
 * транскрипт на настоящих процессах — в statusline.multiprocess.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createCodeCommand } from "./code.ts";
import { createDepCommand } from "./dep.ts";
import { createRememberCommand } from "./remember.ts";
import { createStatuslineCommand, renderLine, statuslineCachePath, type StatuslineData } from "./statusline.ts";
import { CLASSIFIER_VERSION } from "../statusline-session.ts";
import { createClaimCommand, createCommentCommand, createCreateCommand, createTaskCommand } from "./tasks.ts";

let root: string;
let ws: string;
let cfg: string;
let models: string;
let cache: string;
let registry: Registry;
let stdin: string;

function payload(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    session_id: "sess-1",
    cwd: ws,
    workspace: { current_dir: ws, project_dir: ws, added_dirs: [] },
    version: "2.1.267",
    model: { id: "claude-opus-5", display_name: "Opus 5" },
    ...extra,
  })}\n`;
}

function register(env: NodeJS.ProcessEnv = {}): void {
  registry = new Registry();
  for (const c of [
    createTaskCommand(),
    createCreateCommand(),
    createClaimCommand(),
    createDepCommand(),
    createCommentCommand(),
    createRememberCommand(),
    createCodeCommand(),
    createStatuslineCommand({
      selfExit: false,
      readStdin: () => new TextEncoder().encode(stdin),
      cacheDir: cache,
      env: { CLAUDE_CONFIG_DIR: cfg, MYC_MODELS_DIR: models, ...env },
    }),
  ]) {
    registry.register(c);
  }
}

async function myc(...args: string[]): Promise<string> {
  const r = await run(["-C", ws, ...args], { registry });
  if (r.code !== 0) throw new Error(`myc ${args.join(" ")}: ${r.code} ${r.stderr}`);
  return typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
}

async function line(): Promise<StatuslineData> {
  const r = await run(["-C", ws, "statusline", "--json"], { registry });
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout as string) as { data: StatuslineData }).data;
}

const idOf = (out: string): string => out.split(/\s+/)[0]!;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-sl-"));
  ws = join(root, "ws");
  cfg = join(root, "claude-config");
  models = join(root, "models");
  cache = join(root, "cache");
  mkdirSync(join(ws, ".myc"), { recursive: true });
  mkdirSync(cfg, { recursive: true });
  // Модель «скачана»: манифест на месте — деградации эмбеддера нет.
  mkdirSync(join(models, "multilingual-e5-small-q8"), { recursive: true });
  writeFileSync(join(models, "multilingual-e5-small-q8", "manifest.json"), "{}");
  const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  stdin = payload();
  process.env.MYC_ACTOR = "tester";
  // Сессия агента = сессия строки: `remember` берёт её из окружения (у
  // Claude Code это CLAUDE_CODE_SESSION_ID — и в окружении тест-раннера,
  // запущенного из сессии, он ЧУЖОЙ). MYC_SESSION_ID старше.
  savedSession = process.env.MYC_SESSION_ID;
  process.env.MYC_SESSION_ID = "sess-1";
  register();
});

let savedSession: string | undefined;

afterEach(() => {
  delete process.env.MYC_ACTOR;
  if (savedSession === undefined) delete process.env.MYC_SESSION_ID;
  else process.env.MYC_SESSION_ID = savedSession;
  rmSync(root, { recursive: true, force: true });
});

describe("что показывает строка", () => {
  test("очередь, код, память, сессия — одной строкой, без маркера деградации", async () => {
    const a = idOf(await myc("task", "первая"));
    const b = idOf(await myc("task", "заблокированная"));
    const c = idOf(await myc("task", "в работе"));
    await myc("dep", "add", a, "blocks", b);
    await myc("claim", c);
    await myc("remember", "строка статуса считает полезные вызовы по транскрипту");
    await myc("remember", "окно ожидания чужой строки — сто миллисекунд");
    await myc("create", "решение: транскрипт — источник привязки к сессии", "--kind", "decision");
    await myc("comment", a, "реплика в нити — не узел знания");
    writeFileSync(join(ws, "a.ts"), "export function alpha(): number { return 1; }\nexport const beta = alpha();\n");
    await myc("code", "index");

    const d = await line();
    expect(d.queue).toEqual({ ready: 1, in_progress: 1, blocked: 1, blocked_by_ancestor: 0 });
    expect(d.memory).toBe(3); // два факта и решение; комментарий не считается
    expect(d.code).toMatchObject({ state: "ok", files: 1 });
    expect(d.code!.symbols).toBeGreaterThan(0);
    expect(d.degraded).toEqual([]);
    expect(d.line).toMatch(
      /^myc │ 1 ready · 1 in progress · 1 blocked │ 1 file · \d+ symbols? · \d+s ago │ 3 notes │ no session$/,
    );
    expect(d.line).not.toContain("⚠");
    expect(d.lines).toEqual([d.line]);
  });

  test("память — в охвате этой сессии: сессионное чужой сессии не считается", async () => {
    await myc("remember", "факт этой сессии про строку статуса");
    process.env.MYC_SESSION_ID = "другая-сессия";
    await myc("remember", "факт другой сессии про что-то своё");
    process.env.MYC_SESSION_ID = "sess-1";
    expect((await line()).memory).toBe(1);
  });

  test("индекса нет — так и сказано, а не нули", async () => {
    const d = await line();
    expect(d.code?.state).toBe("none");
    expect(d.line).toContain("no code index");
    expect(d.line).not.toContain("0 files");
  });

  test("идёт фоновая индексация — сказано словом", async () => {
    const db = new Database(join(ws, ".myc", "myc.db"));
    db.run(
      "INSERT INTO jobs(kind, entity_id, run_after, lease_holder, lease_expires, created_at) VALUES ('code_index', 'a.ts', 0, 'code-index-1', ?1, 0)",
      [Date.now() + 60_000],
    );
    db.close();
    const d = await line();
    expect(d.code?.state).toBe("indexing");
    expect(d.line).toContain("· indexing");
  });

  test("нет модели эмбеддингов — маркер ⚠ сразу после myc", async () => {
    register({ MYC_MODELS_DIR: join(root, "нет-моделей") });
    const d = await line();
    expect(d.degraded).toEqual(["no embedding model"]);
    expect(d.line.startsWith("myc ⚠ no embedding model │ ")).toBe(true);
  });

  test("нет воркспейса — строка об этом, сессия всё равно считается", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare);
    const t = join(root, "t.jsonl");
    writeFileSync(t, "");
    stdin = `${JSON.stringify({ session_id: "s", transcript_path: t, cwd: bare, workspace: { current_dir: bare } })}\n`;
    const r = await run(["statusline", "--json"], { registry });
    const d = (JSON.parse(r.stdout as string) as { data: StatuslineData }).data;
    expect(d.workspace).toBeNull();
    expect(d.line).toBe("myc │ no myc workspace — run myc init │ 0/0 useful calls");
  });

  test("полезных N из M — из транскрипта этой сессии", async () => {
    const t = join(root, "sess.jsonl");
    const use = (id: string, name: string, input: unknown): string =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const res = (id: string, extra: Record<string, unknown>, block: Record<string, unknown> = {}): string =>
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "x", ...block }] }, ...extra });
    writeFileSync(
      t,
      [
        use("1", "mcp__myc__myc_recall", { query: "q" }),
        res("1", { mcpMeta: { structuredContent: { rows: [{ id: "a" }] } } }),
        use("2", "mcp__myc__myc_recall", { query: "q" }),
        res("2", { mcpMeta: { structuredContent: { rows: [] } } }),
        use("3", "Bash", { command: "./dist/myc show x" }),
        res("3", { toolUseResult: { stdout: "x  task  P1\n", stderr: "", interrupted: false } }),
        "",
      ].join("\n"),
    );
    stdin = payload({ transcript_path: t });
    const d = await line();
    expect(d.session?.counts).toEqual({ total: 3, useful: 2, empty: 1, refusal: 0, error: 0 });
    expect(d.line.endsWith("│ 2/3 useful calls")).toBe(true);
  });
});

/**
 * Возраст индекса и фоновое обновление (memory-es8qwd555cjt). В cherry
 * строка говорила «9h ago» — давность ПОСЛЕДНЕЙ ЗАПИСИ файла в реестр, и не
 * говорила ничего о том, обновляется ли индекс вообще. Теперь давность —
 * последней сверки с деревом, а состояние фона названо словом.
 */
describe("код-индекс: давность сверки и фоновое обновление", () => {
  const HOUR = 3_600_000;

  function sql(text: string, ...params: Array<string | number>): void {
    const db = new Database(join(ws, ".myc", "myc.db"));
    try {
      db.prepare(text).run(...params);
    } finally {
      db.close();
    }
  }
  const stamp = (at: number): void =>
    sql("INSERT INTO myc_meta (key, value) VALUES ('code_indexed_at', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(at));
  const refreshRow = (lease: number, attempts = 0): void =>
    sql(
      "INSERT INTO jobs(kind, entity_id, run_after, attempts, lease_holder, lease_expires, created_at) VALUES ('code_refresh', '.', 0, ?1, ?2, ?3, 0)",
      attempts,
      lease > 0 ? "code-refresh-1" : "",
      lease,
    );

  beforeEach(async () => {
    writeFileSync(join(ws, "a.ts"), "export function alpha(): number { return 1; }\n");
    await myc("code", "index");
  });

  test("старше порога и обновления нет — «stale»", async () => {
    stamp(Date.now() - 9 * HOUR);
    const d = await line();
    expect(d.code).toMatchObject({ stale: true, refresh: null });
    expect(d.line).toContain("· 9h ago · stale");
  });

  test("обновление стоит в очереди / идёт / бросило — сказано словом", async () => {
    stamp(Date.now() - 9 * HOUR);
    refreshRow(0);
    expect((await line()).line).toContain("· 9h ago · refresh queued");

    sql("DELETE FROM jobs WHERE kind = 'code_refresh'");
    refreshRow(Date.now() + 60_000);
    const running = await line();
    expect(running.code?.refresh).toBe("running");
    expect(running.line).toContain("· 9h ago · refreshing");

    sql("DELETE FROM jobs WHERE kind = 'code_refresh'");
    refreshRow(0, 5);
    // Мёртвую строку маркер ⚠ назовёт «1 failed job», когда истечёт кеш
    // счётчиков (30 с); сегмент кода говорит это сразу — он мимо кеша.
    expect((await line()).line).toContain("· 9h ago · refresh failed");
  });

  test("давность — сверки, а не последней записи: прогон без изменений ничего не пишет", async () => {
    // Реестр писался 9 часов назад, сверка была минуту назад — индекс свежий.
    sql("UPDATE code_files SET indexed_at = ?1", Date.now() - 9 * HOUR);
    stamp(Date.now() - 60_000);
    const d = await line();
    expect(d.code).toMatchObject({ stale: false, refresh: null });
    expect(d.line).toContain("· 1m ago │");
    expect(d.code!.indexed_at).toBeLessThan(Date.now() - 8 * HOUR);
  });
});

/**
 * Заполнение контекста — число ХОСТА: `context_window.used_percentage` (схема
 * из бинаря Claude Code 2.1.267: целое 0..100 или null до первого ответа).
 * Сегмент стоит сразу после `myc` и его маркера. Нет числа — нет сегмента:
 * старый хост и терминал — не деградация myc, и «ctx ?» было бы шумом.
 */
describe("ctx: заполнение окна контекста от хоста", () => {
  const ctxWindow = (used: unknown): Record<string, unknown> => ({
    context_window: {
      total_input_tokens: 84_000,
      total_output_tokens: 1_200,
      context_window_size: 200_000,
      current_usage: { input_tokens: 10, output_tokens: 1_200, cache_creation_input_tokens: 500, cache_read_input_tokens: 83_490 },
      used_percentage: used,
      remaining_percentage: typeof used === "number" ? 100 - used : used,
    },
  });

  test("поле есть — «ctx N%» сразу после myc, до задач", async () => {
    await myc("task", "одна");
    stdin = payload(ctxWindow(42));
    const d = await line();
    expect(d.context_pct).toBe(42);
    expect(d.line).toBe("myc │ ctx 42% │ 1 ready · 0 blocked │ no code index │ 0 notes │ no session");
  });

  test("поля нет — сегмента нет вовсе, не «ctx ?» и не деградация", async () => {
    stdin = payload(); // старый хост: context_window нет
    const d = await line();
    expect(d.context_pct).toBeNull();
    expect(d.line).toBe("myc │ 0 ready · 0 blocked │ no code index │ 0 notes │ no session");
    expect(d.degraded).toEqual([]);
  });

  test("null до первого ответа и не-число — тоже без сегмента", async () => {
    for (const used of [null, "42", true, {}]) {
      stdin = payload(ctxWindow(used));
      const d = await line();
      expect({ used, pct: d.context_pct, ctx: d.line.includes("ctx") }).toEqual({ used, pct: null, ctx: false });
    }
    stdin = payload({ context_window: null });
    expect((await line()).context_pct).toBeNull();
  });

  test("0 и 100 — числа, а не пустота", async () => {
    stdin = payload(ctxWindow(0));
    const zero = await line();
    expect(zero.context_pct).toBe(0);
    expect(zero.line.startsWith("myc │ ctx 0% │ 0 ready")).toBe(true);
    stdin = payload(ctxWindow(100));
    expect((await line()).line.startsWith("myc │ ctx 100% │ 0 ready")).toBe(true);
  });

  test("дробное округляется, выход за 0..100 зажат — как считает сам хост", async () => {
    const cases: readonly (readonly [number, number])[] = [
      [41.5, 42],
      [41.49, 41],
      [0.4, 0],
      [99.6, 100],
      [104.2, 100],
      [-3, 0],
    ];
    for (const [used, want] of cases) {
      stdin = payload(ctxWindow(used));
      const d = await line();
      expect({ used, pct: d.context_pct, head: d.line.split(" │ ")[1] }).toEqual({ used, pct: want, head: `ctx ${want}%` });
    }
  });

  test("маркер деградации остаётся при myc, ctx — следом", async () => {
    register({ MYC_MODELS_DIR: join(root, "нет-моделей") });
    stdin = payload(ctxWindow(42));
    expect((await line()).line).toBe("myc ⚠ no embedding model │ ctx 42% │ 0 ready · 0 blocked │ no code index │ 0 notes │ no session");
  });

  test("без воркспейса ctx всё равно виден: он про сессию хоста, а не про myc", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare);
    stdin = `${JSON.stringify({ session_id: "s", cwd: bare, workspace: { current_dir: bare }, ...ctxWindow(7) })}\n`;
    const r = await run(["statusline", "--json"], { registry });
    const d = (JSON.parse(r.stdout as string) as { data: StatuslineData }).data;
    expect(d.line).toBe("myc │ ctx 7% │ no myc workspace — run myc init │ no session");
  });

  test("пример из задачи: длина строки и цена сегмента", () => {
    const base: Omit<StatuslineData, "line" | "lines" | "took_ms" | "context_pct" | "scope"> = {
      workspace: "/ws",
      repo: "",
      queue: { ready: 61, in_progress: 0, blocked: 34, blocked_by_ancestor: 0 },
      code: { state: "ok", files: 612, symbols: 4268, indexed_at: 1, refreshed_at: 1, age: "1h", stale: false, refresh: null, queued: 0 },
      memory: 101,
      degraded: [],
      session: {
        transcript: "t.jsonl",
        counts: { total: 653, useful: 600, empty: 50, refusal: 2, error: 1 },
        pending: 0,
        read_bytes: 0,
        behind_bytes: 0,
        files: 1,
        took_ms: 1,
      },
      foreign: { source: null, started: false, finished: false, from: null, rc: null, shown: false, waited_ms: 0, window_ms: 0 },
      cache: { stats: "hit", code: "hit" },
    };
    const withCtx = renderLine({ ...base, context_pct: 42 });
    expect(withCtx).toBe(
      "myc │ ctx 42% │ 61 ready · 34 blocked │ 612 files · 4268 symbols · 1h ago │ 101 notes │ 600/653 useful calls",
    );
    expect(withCtx.length).toBe(108);
    // Сегмент стоит ровно 10 знаков («ctx 42% │ »), в худшем случае — 11.
    expect(renderLine({ ...base, context_pct: null }).length).toBe(98);
    expect(renderLine({ ...base, context_pct: 100 }).length).toBe(109);
  });
});

describe("кеш счётчиков базы", () => {
  test("вторая отрисовка — из кеша; запись в оплог — пересчёт", async () => {
    await myc("task", "одна");
    expect((await line()).cache.stats).toBe("miss");
    const again = await line();
    expect(again.cache.stats).toBe("hit");
    expect(again.queue?.ready).toBe(1);
    await myc("task", "вторая");
    const after = await line();
    expect(after.cache.stats).toBe("miss");
    expect(after.queue?.ready).toBe(2);
  });
});

/**
 * Ключ кеша — сессия (её транскрипт). Будь он общим, две чередующиеся сессии
 * сбрасывали бы курсор друг друга на каждой отрисовке (состояние чужого
 * транскрипта не применяется — смешения нет), и при потолке чтения ни одна
 * не догнала бы свой транскрипт: «…» навсегда. Потолок здесь маленький,
 * чтобы догон шёл многими отрисовками.
 */
describe("две сессии вперемешку при малом потолке чтения", () => {
  test("обе догоняют свой транскрипт до полного счёта", async () => {
    const call = (i: number, useful: boolean): string =>
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "mcp__myc__myc_recall", input: { query: "x".repeat(300) } }] } })}\n` +
      `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "{}" }] }, mcpMeta: { structuredContent: { rows: useful ? [{ id: "a" }] : [] } } })}\n`;
    const ta = join(root, "a.jsonl");
    const tb = join(root, "b.jsonl");
    writeFileSync(ta, Array.from({ length: 40 }, (_, i) => call(i, true)).join(""));
    writeFileSync(tb, Array.from({ length: 30 }, (_, i) => call(100 + i, i % 2 === 0)).join(""));
    const reg = new Registry();
    reg.register(
      createStatuslineCommand({
        selfExit: false,
        readStdin: () => new TextEncoder().encode(stdin),
        cacheDir: cache,
        env: { CLAUDE_CONFIG_DIR: cfg, MYC_MODELS_DIR: models },
        scanBytes: 4096,
      }),
    );
    const renderAs = async (t: string): Promise<StatuslineData> => {
      stdin = payload({ session_id: t, transcript_path: t });
      const r = await run(["-C", ws, "statusline", "--json"], { registry: reg });
      return (JSON.parse(r.stdout as string) as { data: StatuslineData }).data;
    };
    let a: StatuslineData | null = null;
    let b: StatuslineData | null = null;
    for (let i = 0; i < 30; i++) {
      a = await renderAs(ta);
      b = await renderAs(tb);
      if (a.session!.behind_bytes === 0 && b.session!.behind_bytes === 0) break;
    }
    expect(a!.session).toMatchObject({ behind_bytes: 0, counts: { total: 40, useful: 40 } });
    expect(b!.session).toMatchObject({ behind_bytes: 0, counts: { total: 30, useful: 15, empty: 15 } });
    expect(a!.line.endsWith("40/40 useful calls")).toBe(true);
  });
});

/**
 * Кеш сессии переживает смену логики — ровно так «полезных 687 из 741»
 * пережили исправление heredoc: состояние прошлой сборки продолжалось новой.
 * Теперь документ кеша несёт формат и сборку, состояние сессии — версию
 * классификатора; любое расхождение — пересчёт с нуля, и число совпадает с
 * посчитанным на пустом кеше.
 */
describe("кеш прошлой логики не переиспользуется", () => {
  const t = (): string => join(root, "stale.jsonl");
  const call = (i: number, useful: boolean): string =>
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `s${i}`, name: "mcp__myc__myc_recall", input: { query: "q" } }] } })}\n` +
    `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `s${i}`, content: "{}" }] }, mcpMeta: { structuredContent: { rows: useful ? [{ id: "a" }] : [] } } })}\n`;

  function registerBuild(build: string): Registry {
    const reg = new Registry();
    reg.register(
      createStatuslineCommand({
        selfExit: false,
        readStdin: () => new TextEncoder().encode(stdin),
        cacheDir: cache,
        env: { CLAUDE_CONFIG_DIR: cfg, MYC_MODELS_DIR: models },
        build,
      }),
    );
    return reg;
  }

  async function renderWith(reg: Registry): Promise<StatuslineData> {
    stdin = payload({ transcript_path: t() });
    const r = await run(["-C", ws, "statusline", "--json"], { registry: reg });
    return (JSON.parse(r.stdout as string) as { data: StatuslineData }).data;
  }

  /** Подсунуть в кеш состояние, где курсор в конце файла, а счётчики — чужие. */
  function plant(doc: Record<string, unknown>): void {
    mkdirSync(cache, { recursive: true });
    writeFileSync(statuslineCachePath(cache, t()), JSON.stringify(doc));
  }

  test("документ нового формата, но состояние другой версии классификатора — пересчёт", async () => {
    writeFileSync(t(), call(1, true) + call(2, false));
    const size = statSync(t()).size;
    const reg = registerBuild("build-X");
    const cursor = (counts: Record<string, number>) => ({
      [t()]: { offset: size, ino: statSync(t()).ino, pending: {}, counts },
    });
    plant({
      v: 2,
      build: "build-X",
      session: { v: 1, classifier: CLASSIFIER_VERSION - 1, build: "build-X", transcript: t(), files: cursor({ total: 3, useful: 3, empty: 0, refusal: 0, error: 0 }) },
    });
    const d = await renderWith(reg);
    expect(d.session?.counts).toEqual({ total: 2, useful: 1, empty: 1, refusal: 0, error: 0 });
    expect(d.session?.read_bytes).toBe(size);
    expect(d.line.endsWith("1/2 useful calls")).toBe(true);
  });

  test("документ первой сдачи (v: 1, без сборки) — выброшен целиком", async () => {
    writeFileSync(t(), call(1, true) + call(2, false));
    const size = statSync(t()).size;
    plant({
      v: 1,
      session: { v: 1, transcript: t(), files: { [t()]: { offset: size, ino: statSync(t()).ino, pending: {}, counts: { total: 9, useful: 9, empty: 0, refusal: 0, error: 0 } } } },
    });
    const d = await renderWith(registerBuild("build-X"));
    expect(d.session?.counts.total).toBe(2);
    expect(d.session?.counts.useful).toBe(1);
  });

  test("другая сборка — тоже пересчёт; та же — продолжение без перечитывания", async () => {
    writeFileSync(t(), call(1, true));
    const first = await renderWith(registerBuild("build-X"));
    expect(first.session?.counts.total).toBe(1);
    const again = await renderWith(registerBuild("build-X"));
    expect(again.session?.read_bytes).toBe(0);
    const other = await renderWith(registerBuild("build-Y"));
    expect(other.session?.read_bytes).toBe(statSync(t()).size);
    expect(other.session?.counts.total).toBe(1);
  });
});

describe("документ кеша: формат и сборка — отпечаток всего документа", () => {
  test("другой формат или другая сборка — выброшены и счётчики базы, а не только сессия", async () => {
    const stats = {
      key: `${join(ws, ".myc")}|||sess-1`,
      seq: 0,
      at: Date.now(),
      queue: { ready: 999, in_progress: 0, blocked: 0, blocked_by_ancestor: 0 },
      memory: 999,
      anchors_stale: 0,
      jobs_dead: 0,
    };
    const reg = new Registry();
    reg.register(
      createStatuslineCommand({
        selfExit: false,
        readStdin: () => new TextEncoder().encode(stdin),
        cacheDir: cache,
        env: { CLAUDE_CONFIG_DIR: cfg, MYC_MODELS_DIR: models },
        build: "build-X",
      }),
    );
    const t = join(root, "doc.jsonl");
    writeFileSync(t, "");
    stdin = payload({ transcript_path: t });
    const renderData = async (): Promise<StatuslineData> =>
      (JSON.parse((await run(["-C", ws, "statusline", "--json"], { registry: reg })).stdout as string) as { data: StatuslineData }).data;
    mkdirSync(cache, { recursive: true });

    // Сначала убеждаемся, что подложенные счётчики ВООБЩЕ читаются, когда
    // отпечаток совпал: иначе тест ниже доказывал бы не то.
    writeFileSync(statuslineCachePath(cache, t), JSON.stringify({ v: 2, build: "build-X", stats }));
    expect((await renderData()).queue?.ready).toBe(999);

    for (const doc of [{ v: 1, stats }, { v: 2, build: "build-OLD", stats }]) {
      writeFileSync(statuslineCachePath(cache, t), JSON.stringify(doc));
      const d = await renderData();
      expect(d.queue?.ready).toBe(0);
      expect(d.memory).toBe(0);
      expect(d.cache.stats).toBe("miss");
    }
  });
});
