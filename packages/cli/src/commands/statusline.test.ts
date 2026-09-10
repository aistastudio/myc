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
import { createStatuslineCommand, statuslineCachePath, type StatuslineData } from "./statusline.ts";
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
