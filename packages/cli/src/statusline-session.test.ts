/**
 * «Полезное обращение к myc» — определение, которое держит этот файл.
 *
 * Обращение — один вызов инструмента в транскрипте сессии: MCP `mcp__myc__*`
 * или команда Bash, в которой myc стоит в командной позиции (`myc …`,
 * `./dist/myc …`, `bun …/cli/src/main.ts …`). Полезное = без ошибки И с
 * непустым результатом: поиск/recall с ≥1 попаданием, callers с ≥1
 * вызывающим, ready, отдавший задачу, запись, которая записала. Не полезное:
 * отказ (usage/notfound/precond/conflict/ws/denied), ошибка, пустой результат.
 * Признаки — машинные: is_error и код выхода, строка `myc: <код>:`, конверт
 * `--json`, structuredContent MCP; подвалы человеческого вывода — только там,
 * где агент не просил `--json`, и каждый сверен с живым CLI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expectMsWithinBudget } from "@myc/bench";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "./index.ts";
import { Registry } from "./registry.ts";
import { createCallersCommand } from "./commands/callers.ts";
import { createCodeCommand } from "./commands/code.ts";
import { createListCommand } from "./commands/list.ts";
import { createReadyCommand } from "./commands/ready.ts";
import { createRecallCommand } from "./commands/recall.ts";
import { createRememberCommand } from "./commands/remember.ts";
import { createTaskCommand } from "./commands/tasks.ts";
import * as classifier from "./statusline-session.ts";
import {
  CLASSIFIER_VERSION,
  classifyCli,
  classifyMcp,
  findMycInvocation,
  MAX_SCAN_BYTES,
  scanSession,
  type SessionState,
} from "./statusline-session.ts";
import { behaviorFingerprint } from "./statusline-session.samples.ts";

// ---------------------------------------------------------------------------
// Строки транскрипта в форме Claude Code 2.1.267 (сверено с живым файлом)
// ---------------------------------------------------------------------------

let seq = 0;
const nextId = (): string => `toolu_${(seq++).toString(36).padStart(8, "0")}`;

function useLine(id: string, name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    sessionId: "s",
  });
}

function mcpResult(id: string, text: string, opts: { error?: boolean; structured?: unknown } = {}): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: text, ...(opts.error === true ? { is_error: true } : {}) }],
    },
    toolUseResult: opts.error === true ? `Error: ${text}` : text,
    ...(opts.structured !== undefined ? { mcpMeta: { structuredContent: opts.structured } } : {}),
    sessionId: "s",
  });
}

function bashResult(id: string, stdout: string, code = 0, stderr = ""): string {
  const failed = code !== 0;
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: failed ? `Exit code ${code}\n${stdout}${stderr}` : stdout,
          ...(failed ? { is_error: true } : {}),
        },
      ],
    },
    toolUseResult: failed
      ? `Error: Exit code ${code}\n${stdout}${stderr}`
      : { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false },
    sessionId: "s",
  });
}

/** Пара строк одного MCP-вызова. */
function mcpCall(tool: string, text: string, opts: { error?: boolean; structured?: unknown } = {}): string {
  const id = nextId();
  return `${useLine(id, `mcp__myc__${tool}`, { q: 1 })}\n${mcpResult(id, text, opts)}\n`;
}

/** Пара строк одного вызова через Bash. */
function bashCall(command: string, stdout: string, code = 0, stderr = ""): string {
  const id = nextId();
  return `${useLine(id, "Bash", { command, description: "x" })}\n${bashResult(id, stdout, code, stderr)}\n`;
}

/** Строка-наполнитель: ход агента без вызова myc (как большая часть транскрипта). */
function filler(bytes: number): string {
  const text = "ход агента без myc. ".repeat(Math.max(1, Math.floor(bytes / 34)));
  return `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-sl-session-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Что считается вызовом myc
// ---------------------------------------------------------------------------

describe("вызов myc в команде Bash", () => {
  test.each([
    ["myc show x", "show"],
    ["./dist/myc ready 2>&1 | head -5", "ready"],
    ["cd /r && MYC_DRAIN=0 ./dist/myc code search foo --json", "code search"],
    ["for i in 1 2; do ./dist/myc recall q; done", "recall"],
    ['"${CLAUDE_PROJECT_DIR:-.}/dist/myc" -C /x --db a.db callers f', "callers"],
    ["bun packages/cli/src/main.ts remember 'факт'", "remember"],
  ])("%s → %s", (command, cmd) => {
    expect(findMycInvocation(command)).toEqual({ cmd });
  });

  test.each([
    ['git commit -m "fix; myc show x"'],
    ["grep -n myc file.ts"],
    ["cat .myc/myc.db | wc -c"],
    ["echo myc ready"],
    ["node .claude/helpers/myc-hooks.mjs session-start"],
    ["# myc show x — комментарий; myc show y\nls -la"],
  ])("%s — не вызов myc", (command) => {
    expect(findMycInvocation(command)).toBeNull();
  });

  /**
   * Тело heredoc — данные. На транскрипте координатора (4231 команда Bash)
   * без этого правила 101 «вызов» из 734 был строкой спеки или кода внутри
   * `cat > x <<'EOF'`; здесь в теле НАСТОЯЩИЕ подкоманды (`show`, `ready`),
   * так что пройти их не пускает только пропуск тела.
   */
  test.each([
    ["cat > spec.md <<'EOF'\n# Спека\nmyc show memory-x покажет задачу\n./dist/myc ready\nEOF\n"],
    ['cat > a.md <<"DOC"\nmyc show x\nDOC'],
    ["cat <<\\EOF > b.md\nmyc recall q\nEOF"],
    ["cat <<-\tEND\n\tmyc show y\n\tEND"],
    ["python3 - <<PY\nimport os\nos.system('myc show z')\nPY"],
    ["cat <<A <<B\nmyc show a\nA\nmyc show b\nB"],
  ])("тело heredoc — не вызов: %s", (command) => {
    expect(findMycInvocation(command)).toBeNull();
  });

  test.each([
    // Голова сегмента на строке с оператором — команды, тело — нет.
    ["cat <<EOF | ./dist/myc import -\n{\"id\":\"x\"}\nEOF", "import"],
    ["cd /Users/x/memory\n./dist/myc show x", "show"],
    ["cat > s.md <<'EOF'\nmyc show x\nEOF\n./dist/myc ready --json", "ready"],
    ["cat <<A <<B\nmyc show a\nA\nmyc show b\nB\n./dist/myc list", "list"],
    ["echo $(( 1 << 2 ))\n./dist/myc recall q", "recall"],
    ["./dist/myc \\\n  --json callers f", "callers"],
  ])("вызов рядом с heredoc и через строки: %s → %s", (command, cmd) => {
    expect(findMycInvocation(command)).toEqual({ cmd });
  });

  /**
   * Второй рубеж: подкоманда обязана быть в реестре (или её нет вовсе, как у
   * `myc --version`). Здесь разбор оболочки прав — строка прозы стоит в
   * командной позиции, — и отсекает её только сверка с реестром.
   */
  test("подкоманда — только из реестра; проза в командной позиции не проходит", () => {
    expect(findMycInvocation("cat notes.txt\nmyc стоит в горячем пути агента")).toBeNull();
    expect(findMycInvocation("myc — быстрый слой задач")).toBeNull();
    expect(findMycInvocation("myc --version")).toEqual({ cmd: "" });
    expect(findMycInvocation("myc -C /r --json statusline")).toEqual({ cmd: "statusline" });
  });
});

// ---------------------------------------------------------------------------
// Классификация исхода
// ---------------------------------------------------------------------------

describe("MCP: исход по is_error и structuredContent", () => {
  const ok = (cmd: string, structured: unknown): string => classifyMcp(cmd, { content: "{}" }, { mcpMeta: { structuredContent: structured } });

  test("recall с попаданием — полезно, пустой recall — НЕ полезно (S4)", () => {
    expect(ok("recall", { rows: [{ id: "a" }], shown: 1, total: 1 })).toBe("useful");
    expect(ok("recall", { rows: [], shown: 0, total: 0 })).toBe("empty");
  });

  test("callers: ≥1 вызывающий — полезно, ноль — пусто", () => {
    expect(ok("callers", { edges: [{ caller: "f" }], total_edges: 1 })).toBe("useful");
    expect(ok("callers", { edges: [], total_edges: 0 })).toBe("empty");
  });

  test("ready: отдал задачу или непустой список — полезно; пустая очередь — пусто", () => {
    expect(ok("ready", { claimed: { id: "t" } })).toBe("useful");
    expect(ok("ready", { items: [{ id: "t" }] })).toBe("useful");
    expect(ok("ready", { items: [], ready: 0 })).toBe("empty");
  });

  test("code search/grep/symbol, skeleton — по своим счётчикам", () => {
    expect(ok("code search", { hits: [] })).toBe("empty");
    expect(ok("code grep", { hits: 3 })).toBe("useful");
    expect(ok("code grep", { hits: 0 })).toBe("empty");
    expect(ok("code symbol", { defs: [] })).toBe("empty");
    expect(ok("skeleton", { entries: [{}] })).toBe("useful");
  });

  test("записи без ошибки — полезны: записали", () => {
    expect(ok("remember", { id: "m1", kind: "memory" })).toBe("useful");
    expect(ok("update", { id: "t", status: "closed" })).toBe("useful");
  });

  test("is_error: отказ по пространству кода, остальное — ошибка", () => {
    const err = (text: string): string => classifyMcp("show", { content: text, is_error: true }, {});
    expect(err("myc: notfound.node: узел x не найден")).toBe("refusal");
    expect(err("myc: precond.missing: нет условий")).toBe("refusal");
    expect(err("myc: usage.invalid: 'n' должен быть числом")).toBe("refusal");
    expect(err("myc: internal.unexpected: boom")).toBe("error");
    expect(err("MCP error -32602: unknown tool")).toBe("error");
  });

  test("без mcpMeta — счётчики из JSON-текста ответа", () => {
    expect(classifyMcp("recall", { content: '{"rows":[],"shown":0}' }, {})).toBe("empty");
  });
});

describe("Bash: код выхода → строка ошибки → конверт → подвал", () => {
  const call = (cmd: string, stdout: string, code = 0, stderr = ""): string => {
    const line = JSON.parse(bashResult("t", stdout, code, stderr)) as {
      message: { content: [{ is_error?: boolean; content: string }] };
      toolUseResult: unknown;
    };
    return classifyCli(cmd, line.message.content[0], line);
  };

  test("ненулевой код выхода с отказом myc — отказ, без него — ошибка", () => {
    expect(call("show", "", 3, "myc: notfound.node: узел x не найден\n")).toBe("refusal");
    expect(call("ready", "some output\n", 1)).toBe("error");
  });

  test("`| head` спрятал код выхода — отказ виден по строке myc", () => {
    expect(call("update", "myc: usage.invalid: unknown flag --claim\n")).toBe("refusal");
  });

  test("конверт --json: ok:false — отказ, ok:true с пустыми rows — пусто", () => {
    expect(call("claim", '{"ok":false,"cmd":"claim","data":null,"error":{"code":"conflict.claimed","msg":"x","exit":4}}\n')).toBe("refusal");
    expect(call("recall", '{"ok":true,"cmd":"recall","data":{"rows":[],"shown":0,"total":0}}\n')).toBe("empty");
    expect(call("recall", '{"ok":true,"cmd":"recall","data":{"rows":[{"id":"a"}],"shown":1}}\n')).toBe("useful");
  });

  test("прерванная хостом команда — ошибка", () => {
    const line = { message: { content: [{ content: "" }] }, toolUseResult: { stdout: "", stderr: "", interrupted: true } };
    expect(classifyCli("recall", line.message.content[0]!, line)).toBe("error");
  });

  // Подвал читается в ОБЕИХ формах: английской (текущий вывод CLI) и русской
  // (транскрипты сессий, начатых до перевода). Ноль — пусто, не ноль — польза;
  // без WARN-строки, чтобы решал именно счётчик подвала.
  test("подвалы шести команд: английские и русские, ноль и не ноль", () => {
    const cases: readonly (readonly [string, string, "empty" | "useful"])[] = [
      ["recall", "0 of 0 · 4 ms\n", "empty"],
      ["recall", "2 of 5 · 4 ms\n", "useful"],
      ["search", "0 of 0 · 3 ms\n", "empty"],
      ["search", "1 of 1 · 3 ms\n", "useful"],
      ["list", "0 of 0 · 6 ms\n", "empty"],
      ["list", "3 of 3 · 6 ms\n", "useful"],
      ["code grep", '"zz" — 0 occurrences in 0 symbols, files 0 (scanned 602)\n', "empty"],
      ["code grep", '"fooBar" — 1 occurrence in 1 symbol, files 1 (scanned 3)\n', "useful"],
      ["code search", "0 files · stages — · 2 ms\n", "empty"],
      ["code search", "1 file · stages bm25 · 2 ms\n", "useful"],
      ["callers", "symbols 1, groups 0, occurrences 0\n", "empty"],
      ["callers", "symbols 1, groups 2, occurrences 11  [call 10, import 1]\n", "useful"],
      ["recall", "0 из 0 · 4 мс\n", "empty"],
      ["list", "3 из 3 · 6 мс\n", "useful"],
      ["code grep", '"zz" — 0 вхождений в 0 символах, файлов 0 (просмотрено 602)\n', "empty"],
      ["code search", "0 файлов · ступени — · 2 мс\n", "empty"],
      ["code search", "2 файла · ступени bm25 · 2 мс\n", "useful"],
      ["callers", "символов 1, групп 0, вхождений 0\n", "empty"],
    ];
    for (const [cmd, out, want] of cases) expect({ cmd, out, got: call(cmd, out) }).toEqual({ cmd, out, got: want });
  });
});

/**
 * Подвалы человеческого вывода — счётчики, а не угадывание, НО только пока
 * их формат не поменялся. Здесь они берутся у НАСТОЯЩИХ команд в настоящем
 * воркспейсе: переписал кто-то подвал recall — краснеет этот тест, а не
 * тихо врёт строка статуса.
 */
describe("подвалы совпадают с живым CLI", () => {
  let ws: string;
  let registry: Registry;
  const cli = async (...args: string[]): Promise<string> => {
    const r = await run(["-C", ws, ...args], { registry });
    const out = typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
    return `${out}\n${r.stderr ?? ""}`;
  };

  beforeEach(async () => {
    ws = join(dir, "ws");
    mkdirSync(join(ws, ".myc"), { recursive: true });
    const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
    await migrate(raw, { migrations, writable: true });
    raw.close();
    writeFileSync(join(ws, "a.ts"), "export function fooBar(): number { return 1; }\nexport const x = fooBar();\n");
    registry = new Registry();
    for (const c of [
      createRecallCommand(),
      createRememberCommand(),
      createListCommand(),
      createReadyCommand(),
      createTaskCommand(),
      createCodeCommand(),
      createCallersCommand(),
    ]) {
      registry.register(c);
    }
    process.env.MYC_ACTOR = "tester";
  });
  afterEach(() => {
    delete process.env.MYC_ACTOR;
  });

  const human = (cmd: string, out: string): string =>
    classifyCli(cmd, { content: out }, { toolUseResult: { stdout: out, stderr: "", interrupted: false } });

  test("recall, list, ready: пусто и непусто", async () => {
    expect(human("recall", await cli("recall", "квазибессмыслица", "--mode", "bm25"))).toBe("empty");
    expect(human("list", await cli("list"))).toBe("empty");
    expect(human("ready", await cli("ready"))).toBe("empty");
    await cli("remember", "строка статуса считает полезные вызовы по транскрипту");
    await cli("task", "первая задача");
    expect(human("recall", await cli("recall", "строка статуса", "--mode", "bm25"))).toBe("useful");
    expect(human("list", await cli("list"))).toBe("useful");
    expect(human("ready", await cli("ready"))).toBe("useful");
  });

  test("code grep и callers: ноль и ≥1", async () => {
    await cli("code", "index");
    expect(human("code grep", await cli("code", "grep", "квазибессмыслица"))).toBe("empty");
    expect(human("code grep", await cli("code", "grep", "fooBar"))).toBe("useful");
    expect(human("callers", await cli("callers", "fooBar"))).toBe("useful");
  });
});

// ---------------------------------------------------------------------------
// Инкрементальный проход
// ---------------------------------------------------------------------------

describe("транскрипт читается с курсора, а не заново", () => {
  test("счёт по сессии: полезные, пустые, отказы — и из скольких", () => {
    const t = join(dir, "s.jsonl");
    writeFileSync(
      t,
      mcpCall("myc_recall", "{}", { structured: { rows: [{ id: "a" }], shown: 1 } }) +
        mcpCall("myc_recall", "{}", { structured: { rows: [], shown: 0 } }) +
        mcpCall("myc_show", "myc: notfound.node: нет", { error: true }) +
        bashCall("./dist/myc ready 2>&1 | head", "3 ready · 0 blocked\n") +
        bashCall("ls -la", "total 0\n") +
        mcpCall("myc_callers", "{}", { structured: { edges: [{}], total_edges: 1 } }),
    );
    const { report } = scanSession(null, t);
    expect(report.counts).toEqual({ total: 5, useful: 3, empty: 1, refusal: 1, error: 0 });
  });

  test("дочитывается только новое; незаконченная последняя строка ждёт", () => {
    const t = join(dir, "s.jsonl");
    writeFileSync(t, mcpCall("myc_recall", "{}", { structured: { rows: [{ id: "a" }] } }));
    const first = scanSession(null, t);
    expect(first.report.counts.total).toBe(1);

    // Хост дописывает вызов: сначала tool_use и половину строки результата.
    const id = nextId();
    const result = mcpResult(id, "{}", { structured: { rows: [] } });
    appendFileSync(t, `${useLine(id, "mcp__myc__myc_recall", {})}\n${result.slice(0, 20)}`);
    const second = scanSession(first.state, t);
    expect(second.report.counts.total).toBe(1);
    expect(second.report.pending).toBe(1);

    appendFileSync(t, `${result.slice(20)}\n`);
    const before = statSync(t).size;
    const third = scanSession(second.state, t);
    expect(third.report.counts).toMatchObject({ total: 2, useful: 1, empty: 1 });
    // Курсор стоял в начале недописанной строки: читается она целиком — и только она.
    expect(third.report.readBytes).toBe(Buffer.byteLength(result) + 1);
    expect(third.state.files[t]!.offset).toBe(before);

    const idle = scanSession(third.state, t);
    expect(idle.report.readBytes).toBe(0);
  });

  test("файл подменили — счёт с нуля, а не с чужого курсора", () => {
    const t = join(dir, "s.jsonl");
    writeFileSync(t, mcpCall("myc_recall", "{}", { structured: { rows: [{}] } }).repeat(3));
    const a = scanSession(null, t);
    expect(a.report.counts.total).toBe(3);
    rmSync(t);
    writeFileSync(t, mcpCall("myc_recall", "{}", { structured: { rows: [{}] } }));
    expect(scanSession(a.state, t).report.counts.total).toBe(1);
  });

  test("субагенты этой сессии считаются, соседние сессии — нет", () => {
    const t = join(dir, "sess-a.jsonl");
    writeFileSync(t, mcpCall("myc_recall", "{}", { structured: { rows: [{}] } }));
    const sub = join(dir, "sess-a", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-1.jsonl"), bashCall("myc show t", "t  task  P1\n").repeat(2));
    // Соседняя сессия того же проекта лежит в том же каталоге.
    writeFileSync(join(dir, "sess-b.jsonl"), mcpCall("myc_recall", "{}", { structured: { rows: [{}] } }).repeat(7));
    const { report } = scanSession(null, t);
    expect(report.counts.total).toBe(3);
    expect(report.files).toBe(2);
  });

  /**
   * Транскрипт на 20 МБ — без перечитывания на каждой отрисовке. Первый
   * проход идёт порциями по MAX_SCAN_BYTES (ни одна отрисовка не читает
   * больше), дальше каждая отрисовка читает только дописанное и укладывается
   * в миллисекунды.
   */
  test("20 МБ: догоняет порциями, потом читает только дописанное — со временем", () => {
    // Похоже на живой транскрипт: текст агента, чужие команды Bash (в том
    // числе со словом myc в пути — их tool_use приходится разбирать) и
    // вызовы myc с выводом в несколько килобайт.
    const t = join(dir, "big.jsonl");
    const chunks: string[] = [];
    const output = `${"memory-abc123  task  P1  заголовок задачи\n".repeat(80)}80 из 80 · 3 мс\n`;
    let size = 0;
    let i = 0;
    let expected = 0;
    while (size < 20 * 1024 * 1024) {
      let c = filler(6 * 1024) + bashCall("cat .myc/workspace.toml && ls packages", "slug = \"myc\"\n".repeat(20));
      if (i++ % 3 === 0) {
        c += bashCall("./dist/myc recall строка", output);
        expected++;
      }
      chunks.push(c);
      size += Buffer.byteLength(c);
    }
    writeFileSync(t, chunks.join(""));

    let state: SessionState | null = null;
    const rounds: { read: number; ms: number }[] = [];
    let behind = 1;
    while (behind > 0) {
      const r = scanSession(state, t);
      state = r.state;
      behind = r.report.behindBytes;
      rounds.push({ read: r.report.readBytes, ms: r.report.tookMs });
      expect(r.report.readBytes).toBeLessThanOrEqual(MAX_SCAN_BYTES);
    }
    expect(rounds.length).toBe(Math.ceil(size / MAX_SCAN_BYTES));
    expect(scanSession(state, t).report.counts.total).toBe(expected);

    // Хост дописал один вызов — читается ровно он, и быстро.
    const tail = mcpCall("myc_recall", "{}", { structured: { rows: [] } });
    appendFileSync(t, tail);
    const times: number[] = [];
    let last = scanSession(state, t);
    expect(last.report.readBytes).toBe(Buffer.byteLength(tail));
    expect(last.report.counts.total).toBe(expected + 1);
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      last = scanSession(last.state, t);
      times.push(performance.now() - t0);
      expect(last.report.readBytes).toBe(0);
    }
    const firstMs = rounds.reduce((s, r) => s + r.ms, 0);
    const idleMax = Math.max(...times);
    const idleMedian = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    // Число в лог: сколько стоил первый проход и сколько — отрисовка потом.
    console.log(`20 МБ: первый проход ${rounds.length} порции, ${firstMs.toFixed(1)} мс; потом отрисовка ≤ ${idleMax.toFixed(2)} мс`);
    // «Не перечитывает» доказано структурой выше (readBytes 0 на каждой из
    // двадцати). Отношение — по МЕДИАНЕ: максимум двадцати замеров — это один
    // сосед по процессору или одна сборка мусора после 20 МБ строк, и
    // отношение по нему мерило бы их, а не чтение (nearest-rank при n < 100).
    expect(idleMedian * 20).toBeLessThan(firstMs);
    // Потолок каждой отрисовки — абсолют: только на откалиброванной и
    // свободной машине.
    expectMsWithinBudget(idleMax, 5, "статус сессии: отрисовка без новых байт, максимум 20");
  });
});

// ---------------------------------------------------------------------------
// Версия логики подсчёта
// ---------------------------------------------------------------------------

/**
 * История «версия логики → отпечаток поведения» на образцах
 * statusline-session.samples.ts. Состояние сессии в кеше хранит счётчики
 * ОДНОЙ логики и продолжается, только пока совпадает CLASSIFIER_VERSION;
 * забыть её поднять — значит продолжить старые счётчики новой логикой (так
 * «полезных 687 из 741» пережили исправление heredoc вместо 588 из 641).
 * Отпечаток v1 снят с кода первой сдачи.
 */
const CLASSIFIER_HISTORY: readonly { readonly version: number; readonly fingerprint: string; readonly what: string }[] = [
  { version: 1, fingerprint: "926e2e816bb860c2", what: "первая сдача" },
  { version: 2, fingerprint: "c8c6a1ecdadc2a8d", what: "тела heredoc, комментарии, подкоманда из реестра" },
  { version: 3, fingerprint: "b33577519b460c4f", what: "английские подвалы шести команд рядом с русскими" },
];

describe("CLASSIFIER_VERSION держится отпечатком поведения", () => {
  test("поведение совпадает с последней записью истории, её версия — с CLASSIFIER_VERSION", () => {
    const actual = behaviorFingerprint(classifier);
    const last = CLASSIFIER_HISTORY[CLASSIFIER_HISTORY.length - 1]!;
    if (actual !== last.fingerprint || CLASSIFIER_VERSION !== last.version) {
      throw new Error(
        `классификатор строки статуса ведёт себя не так, как записано: отпечаток ${actual}, ` +
          `в истории v${last.version} = ${last.fingerprint}, CLASSIFIER_VERSION = ${CLASSIFIER_VERSION}. ` +
          `Поменял поведение нарочно — подними CLASSIFIER_VERSION в statusline-session.ts до ${last.version + 1} ` +
          `и ДОПИШИ в CLASSIFIER_HISTORY { version: ${last.version + 1}, fingerprint: "${actual}" }. ` +
          "Иначе кеши сессий продолжат счёт старой логикой.",
      );
    }
  });

  test("история монотонна: версии растут, отпечатки не повторяются", () => {
    const versions = CLASSIFIER_HISTORY.map((h) => h.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(new Set(CLASSIFIER_HISTORY.map((h) => h.fingerprint)).size).toBe(CLASSIFIER_HISTORY.length);
  });

  test("состояние другой логики или другой сборки не переиспользуется — счёт с нуля", () => {
    const t = join(dir, "s.jsonl");
    writeFileSync(
      t,
      bashCall("cat > spec.md <<'EOF'\nmyc show memory-x\nEOF", "") +
        mcpCall("myc_recall", "{}", { structured: { rows: [{ id: "a" }] } }) +
        mcpCall("myc_recall", "{}", { structured: { rows: [] } }),
    );
    const clean = scanSession(null, t, MAX_SCAN_BYTES, "build-A");
    expect(clean.report.counts).toEqual({ total: 2, useful: 1, empty: 1, refusal: 0, error: 0 });
    // Состояние, накопленное ДРУГОЙ логикой: курсор в конце файла, счётчики
    // с ложным срабатыванием на heredoc.
    const stale = (version: number | undefined, build: string | undefined): SessionState => ({
      v: 1,
      ...(version !== undefined ? { classifier: version } : {}),
      ...(build !== undefined ? { build } : {}),
      transcript: t,
      files: { [t]: { ...clean.state.files[t]!, counts: { total: 3, useful: 2, empty: 1, refusal: 0, error: 0 } } },
    });
    const size = statSync(t).size;
    for (const [version, build] of [
      [CLASSIFIER_VERSION - 1, "build-A"],
      [undefined, "build-A"], // состояние первой сдачи: поля не было
      [CLASSIFIER_VERSION, "build-B"],
      [CLASSIFIER_VERSION, undefined],
    ] as const) {
      const r = scanSession(stale(version, build), t, MAX_SCAN_BYTES, "build-A");
      expect(r.report.counts).toEqual(clean.report.counts);
      expect(r.report.readBytes).toBe(size);
      expect(r.state).toMatchObject({ classifier: CLASSIFIER_VERSION, build: "build-A" });
    }
    // Та же логика и та же сборка — продолжает с курсора, ничего не перечитывая.
    const same = scanSession(stale(CLASSIFIER_VERSION, "build-A"), t, MAX_SCAN_BYTES, "build-A");
    expect(same.report.readBytes).toBe(0);
    expect(same.report.counts.total).toBe(3);
  });
});
