/**
 * Строка статуса на НАСТОЯЩИХ процессах (правило manual:multiprocess): всё,
 * что здесь проверяется, живёт между процессами — передача stdin чужой
 * строке, отсоединение, отмена отрисовки хостом, две сессии одновременно,
 * курсор транскрипта между вызовами, wire/unwire и то, как Claude Code
 * исполняет записанную команду.
 *
 * «Чужая» строка — подделка orca: пишет свой stdin в файл, спит, отмечает
 * завершение. Команда в пользовательских настройках — ДОСЛОВНО команда orca
 * из настроек заказчика (statusline.orca-fixture.json): она ищет
 * `${HOME}/.orca/agent-hooks/claude-statusline.sh`, и во временном HOME там
 * лежит подделка.
 *
 * Окружение — cliTestEnv: без ORCA_* из окружения разработчика (иначе
 * настоящий скрипт orca слал бы в живую orca поддельные данные) и с
 * погашенным фоном.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { expectMsWithinBudget } from "@myc/bench";
import { cliTestEnv } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";
import { isOurStatusLineCommand } from "../statusline-config.ts";
import { MAX_SCAN_BYTES } from "../statusline-session.ts";
import type { StatuslineData } from "./statusline.ts";

/**
 * Лимит каждого теста файла — 30 с, потолок «зациклилось», а не бюджет. Здесь
 * настоящие процессы и настоящие сны подделки (до 3 с), а ожидания `waitFor`
 * стоят до 6 с — БОЛЬШЕ лимита по умолчанию (5 с): не дождавшись файла, тест
 * падал бы по лимиту раньше, чем назвал бы, чего не дождался.
 */
setDefaultTimeout(30_000);

const MAIN = resolve(import.meta.dir, "..", "main.ts");
const BUN = process.execPath;
const ORCA = (JSON.parse(readFileSync(join(import.meta.dir, "statusline.orca-fixture.json"), "utf8")) as {
  statusLine: { type: string; command: string };
}).statusLine;

const FAKE_ORCA = `#!/bin/sh
out="\${FAKE_OUT:?}"
cat > "$out.stdin.tmp" && mv "$out.stdin.tmp" "$out.stdin"
sleep "\${FAKE_SLEEP:-2}"
echo done > "$out.done"
if [ -n "$FAKE_PRINT" ]; then printf '%s\\n' "$FAKE_PRINT"; fi
exit "\${FAKE_RC:-0}"
`;

let root: string;
let ws: string;
let home: string;
let models: string;
let cache: string;
let bin: string;
let tag = 0;

function write(path: string, text: string, mode?: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

async function makeWorkspace(dir: string): Promise<void> {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-sl-mp-"));
  ws = join(root, "ws");
  home = join(root, "home");
  models = join(root, "models");
  cache = join(root, "cache");
  await makeWorkspace(ws);
  write(join(home, ".orca", "agent-hooks", "claude-statusline.sh"), FAKE_ORCA, 0o755);
  write(join(home, ".claude", "settings.json"), `${JSON.stringify({ statusLine: ORCA }, null, 2)}\n`);
  write(join(models, "multilingual-e5-small-q8", "manifest.json"), "{}");
  // Бинарь `myc` для записанных команд: тот же CLI из исходников.
  bin = join(root, "bin", "myc");
  write(bin, `#!/bin/sh\nexec "${BUN}" "${MAIN}" "$@"\n`, 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return cliTestEnv({
    HOME: home,
    MYC_ACTOR: "tester",
    MYC_MODELS_DIR: models,
    MYC_STATUSLINE_CACHE: cache,
    MYC_SESSION_ID: "",
    ...extra,
  });
}

function payload(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    session_id: "sess-mp",
    transcript_path: join(root, "none.jsonl"),
    cwd: ws,
    model: { id: "claude-opus-5", display_name: "Opus 5" },
    workspace: { current_dir: ws, project_dir: ws, added_dirs: [] },
    version: "2.1.267",
    cost: { total_cost_usd: 0.42, total_duration_ms: 61234 },
    context_window: { total_input_tokens: 1234, context_window_size: 1000000, used_percentage: 1 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1789999999 } },
    ...extra,
  })}\n`;
}

interface Rendered {
  readonly out: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly ms: number;
  readonly pid: number;
  readonly data: StatuslineData | null;
}

/** `myc statusline` отдельным процессом, как его запускает хост: JSON на stdin. */
async function render(
  stdin: string,
  opts: { env?: Record<string, string>; args?: readonly string[]; json?: boolean; cwd?: string } = {},
): Promise<Rendered> {
  const t0 = performance.now();
  const proc = Bun.spawn([BUN, MAIN, "statusline", ...(opts.json === false ? [] : ["--json"]), ...(opts.args ?? [])], {
    cwd: opts.cwd ?? ws,
    env: env(opts.env),
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const ms = performance.now() - t0;
  let data: StatuslineData | null = null;
  if (opts.json !== false) {
    try {
      data = (JSON.parse(out) as { data: StatuslineData }).data;
    } catch {
      data = null;
    }
  }
  return { out, code: proc.exitCode, signal: proc.signalCode ?? null, ms, pid: proc.pid, data };
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (existsSync(path)) return true;
    await Bun.sleep(25);
  }
  return existsSync(path);
}

function fakeOut(): string {
  return join(root, `fake-${tag++}`);
}

// ---------------------------------------------------------------------------
// Передача ввода чужой строке
// ---------------------------------------------------------------------------

/** Отдельная сессия на тест: итог чужой строки хранится на сессию, и соседний тест его не видит. */
function session(): Record<string, unknown> {
  return { session_id: `s-${tag}`, transcript_path: join(root, `session-${tag++}.jsonl`) };
}

describe("чужая строка (orca) получает те же байты и не держит нашу", () => {
  /**
   * Худший случай orca: POST раз в ~15 с, curl до 1,5 с, и при этом НИ
   * СТРОЧКИ вывода. Отрисовка не ждёт её вовсе (прежнее окно в 100 мс
   * стоило 125–135 мс на каждой такой отрисовке ради пустоты), а orca
   * доходит до конца ПОСЛЕ нас и получает побайтно тот же stdin. Мутация
   * «снова ждать окно у молчащей» роняет этот тест по времени.
   */
  test("молчащая медленная (sleep 3): отрисовка её не ждёт, orca дошла до конца с тем же stdin", async () => {
    const out = fakeOut();
    const input = payload(session());
    // Сон чужой — 3 с, граница полного времени процесса ниже — 1 с: регрессия
    // «ждать чужую» дала бы ≥ 3 с, здоровая отрисовка — десятки мс (под
    // yes × 14 — до сотен). При прежнем сне в 1 с граница совпадала со сном, и
    // различение держалось на миллисекундах в обе стороны.
    const r = await render(input, { env: { FAKE_OUT: out, FAKE_SLEEP: "3" } });
    expect(r.code).toBe(0);
    // Структура «не ждали», от машины не зависящая: окна нет (window_ms 0),
    // текущий запуск не слушали (finished false). Мутация PASS_WINDOW_MS=100
    // роняет это сравнение на любом железе и при любой нагрузке.
    expect(r.data?.foreign).toMatchObject({ source: "user", started: true, finished: false, from: null, shown: false, window_ms: 0 });
    // На любом железе: трёхсекундный sleep чужой не ждали — ни наша отрисовка, ни
    // ожидание обёртки не подходят к нему (окна у молчащей нет: window_ms 0).
    expect(r.data!.foreign.waited_ms).toBeLessThan(500);
    expect(r.ms).toBeLessThan(1000);
    // Абсолютные бюджеты — только на откалиброванной (не MYC_BENCH_ABSOLUTE=0:
    // в CI 0.3.2 took_ms был 99.6 при границе 70 — медленный раннер) и
    // свободной машине (полный прогон рядом с агентами, load1 15–21: 123 мс).
    expectMsWithinBudget(r.data!.foreign.waited_ms, 25, "statusline: ожидание молчащей чужой");
    expectMsWithinBudget(r.data!.took_ms, 70, "statusline: отрисовка при молчащей чужой");
    // Мы вышли, а orca ещё спит: не дождались и не убили.
    expect(existsSync(`${out}.done`)).toBe(false);
    expect(await waitFor(`${out}.done`, 6000)).toBe(true);
    expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));
  });

  /**
   * Печатающая чужая: её вывод показывается из последнего ЗАВЕРШЁННОГО
   * запуска — со следующей отрисовки, если текущий не успел за нашу работу.
   */
  test("печатающая: вывод прошлого завершённого запуска — над нашей строкой со следующей отрисовки", async () => {
    const sess = session();
    const first = fakeOut();
    const r1 = await render(payload(sess), { env: { FAKE_OUT: first, FAKE_SLEEP: "0.4", FAKE_PRINT: "orca 42%" } });
    expect(r1.data?.foreign).toMatchObject({ from: null, shown: false });
    expect(r1.data?.lines).toEqual([r1.data!.line]);
    expect(await waitFor(`${first}.done`, 5000)).toBe(true);
    await Bun.sleep(200); // обёртка кладёт итог после выхода чужой

    const r2 = await render(payload(sess), { env: { FAKE_OUT: fakeOut(), FAKE_SLEEP: "0.4", FAKE_PRINT: "orca 43%" } });
    // Вывод прошлого запуска показан БЕЗ ожидания текущего — это структура:
    // окна нет, текущий не слушали, показан «previous». Прежде это стерегла
    // только граница took_ms < 70 без всякого гейта, и она роняла полный
    // прогон при load1 15–21 (123 мс), ничего не сказав о коде.
    expect(r2.data?.foreign).toMatchObject({ from: "previous", rc: 0, shown: true, finished: false, window_ms: 0 });
    expect(r2.data?.lines).toEqual(["orca 42%", r2.data!.line]);
    // Цена самой отрисовки — абсолют: относительного здесь нет, и это
    // проверено (memory-r98gw9etktzc): передача чужой — ДОБАВКА (запуск
    // обёртки: dash на Linux, bash на macOS), а не множитель, и отношение к
    // отрисовке без чужой мерило бы платформу. Поэтому — только на
    // откалиброванной свободной машине.
    expectMsWithinBudget(r2.data!.took_ms, 70, "statusline: вывод прошлого запуска чужой");

    // Третья отрисовка печатает то же, что вторая: на быстром Linux (обёртка на
    // dash) чужая с FAKE_SLEEP 0 успевает завершиться, пока myc делает свою
    // работу, и строка честно показывает ТЕКУЩИЙ вывод. Без FAKE_PRINT он пуст —
    // и тест проверял исход гонки, а не то, что человеческий вывод ставит
    // чужую строку над нашей (CI 0.3.1, ubuntu: пришла одна строка myc).
    // Теперь любой исход — текущий «orca 43%» или прошлый «orca 42%» — сверяем.
    const human = await render(payload(sess), {
      env: { FAKE_OUT: fakeOut(), FAKE_SLEEP: "0", FAKE_PRINT: "orca 43%" },
      json: false,
    });
    expect(human.out.split("\n")[0]).toMatch(/^orca 4[23]%$/);
    expect(human.out.split("\n")[1]!.startsWith("myc")).toBe(true);
  });

  /**
   * Отмена отрисовки хостом. Claude Code 2.1.267 (`AS`) убивает не группу, а
   * всё дерево потомков по `ps` — повторяем это буквально, пока наша строка
   * ещё жива (ждёт текущий запуск: --wait-ms 3000). POST orca обязан дойти:
   * подделка доживает до конца и получает весь stdin.
   */
  test("отмена хостом (SIGTERM группе и каждому потомку по ps) не обрывает orca", async () => {
    const out = fakeOut();
    const input = payload(session());
    const proc = Bun.spawn([BUN, MAIN, "statusline", "--wait-ms", "3000"], {
      cwd: ws,
      env: env({ FAKE_OUT: out, FAKE_SLEEP: "2" }),
      stdin: new TextEncoder().encode(input),
      stdout: "ignore",
      stderr: "ignore",
      detached: true, // так строку запускает сам хост: своя группа
    });
    expect(await waitFor(`${out}.stdin`, 5000)).toBe(true);
    await Bun.sleep(150);
    const killed = killTreeLikeClaude(proc.pid);
    await proc.exited;
    expect(proc.signalCode).toBe("SIGTERM");
    expect(killed).toBeGreaterThanOrEqual(0);
    expect(await waitFor(`${out}.done`, 6000)).toBe(true);
    expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));
  });

  test("--wait-ms: дождались текущий — его вывод; при ненулевом коде не показан (как у хоста)", async () => {
    const out = fakeOut();
    const r = await render(payload(session()), { env: { FAKE_OUT: out, FAKE_SLEEP: "0", FAKE_PRINT: "orca 42%" }, args: ["--wait-ms", "3000"] });
    expect(r.data?.foreign).toMatchObject({ finished: true, from: "current", rc: 0, shown: true });
    expect(r.data?.lines).toEqual(["orca 42%", r.data!.line]);

    const failed = await render(payload(session()), {
      env: { FAKE_OUT: fakeOut(), FAKE_SLEEP: "0", FAKE_PRINT: "не покажут", FAKE_RC: "3" },
      args: ["--wait-ms", "3000"],
    });
    expect(failed.data?.foreign).toMatchObject({ finished: true, rc: 3, shown: false });
    expect(failed.data?.lines).toEqual([failed.data!.line]);
  });

  test("падение чужой не ломает нашу: нет скрипта, код 127 — наша строка и код 0", async () => {
    const r = await render(payload(session()), { args: ["--then", "/нет/такого/скрипта --x", "--wait-ms", "3000"], json: false });
    expect(r.code).toBe(0);
    expect(r.out.startsWith("myc")).toBe(true);
  });

  test("падение нашей не ломает чужую: битая база — orca всё равно получила ввод и показана", async () => {
    const broken = join(root, "broken");
    mkdirSync(join(broken, ".myc"), { recursive: true });
    writeFileSync(join(broken, ".myc", "myc.db"), "это не база sqlite, а мусор ".repeat(100));
    const out = fakeOut();
    const input = payload({ ...session(), cwd: broken, workspace: { current_dir: broken } });
    const r = await render(input, {
      cwd: broken,
      env: { FAKE_OUT: out, FAKE_SLEEP: "0", FAKE_PRINT: "orca жива" },
      args: ["--wait-ms", "3000"],
      json: false,
    });
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toBe("orca жива");
    expect(lines[1]!.startsWith("myc")).toBe(true);
    expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));
  });

  /**
   * Никогда сам за себя. Пользовательская строка — обёртка, которая зовёт
   * `myc statusline` (по тексту команды не узнать, что это мы). Наша строка
   * отдаёт ей ввод, вложенная видит MYC_STATUSLINE_NESTED и не передаёт
   * дальше: обёртка отработала ровно один раз.
   */
  test("вложенный myc statusline не передаёт дальше: рекурсии нет", async () => {
    const counter = join(root, "wrap-count");
    const wrap = join(root, "wrap.sh");
    write(wrap, `#!/bin/sh\necho x >> "${counter}"\nexec "${bin}" statusline\n`, 0o755);
    const r = await render(payload(session()), { args: ["--then", `/bin/sh ${wrap}`, "--wait-ms", "5000"] });
    expect(r.code).toBe(0);
    // Обёртка отработала в окне; вложенная строка промолчала — строка myc одна.
    expect(r.data?.foreign).toMatchObject({ finished: true, rc: 0, shown: false });
    expect(r.data?.lines).toEqual([r.data!.line]);
    await Bun.sleep(1000);
    expect(readFileSync(counter, "utf8")).toBe("x\n");
    // И прямая ссылка на себя распознаётся по команде — даже не запускается.
    const self = await render(payload(session()), { args: ["--then", `${bin} statusline`] });
    expect(self.data?.foreign).toMatchObject({ started: false, skipped: "ours" });
  });
});

/** Алгоритм отмены Claude Code 2.1.267 (`AS` → `g`): дерево по ps, SIGTERM группе и каждому. */
function killTreeLikeClaude(pid: number): number {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="]);
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const list = children.get(Number(m[2])) ?? [];
    list.push(Number(m[1]));
    children.set(Number(m[2]), list);
  }
  const found = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (c > 1 && c !== pid && !found.has(c)) {
        found.add(c);
        queue.push(c);
      }
    }
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  for (const c of found) {
    try {
      process.kill(c, "SIGTERM");
    } catch {
      /* уже нет */
    }
  }
  return found.size;
}

// ---------------------------------------------------------------------------
// Привязка к сессии и цена транскрипта
// ---------------------------------------------------------------------------

let callSeq = 0;
function call(kind: "useful" | "empty" | "refusal"): string {
  const id = `toolu_mp_${callSeq++}`;
  const use = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__myc__myc_recall", input: { query: "q" } }] } });
  const block =
    kind === "refusal"
      ? { type: "tool_result", tool_use_id: id, content: "myc: usage.invalid: нужен параметр 'query'", is_error: true }
      : { type: "tool_result", tool_use_id: id, content: "{}" };
  const res = JSON.stringify({
    type: "user",
    message: { content: [block] },
    ...(kind === "refusal" ? {} : { mcpMeta: { structuredContent: { rows: kind === "useful" ? [{ id: "a" }] : [] } } }),
  });
  return `${use}\n${res}\n`;
}

/**
 * Число контекста приходит в том же stdin, что хост отдаёт процессу строки
 * (`context_window.used_percentage`), — здесь оно проходит путь целиком:
 * настоящий процесс, настоящий stdin, человеческий вывод.
 */
describe("ctx из настоящего stdin процесса", () => {
  test("хост дал used_percentage — сегмент в строке; не дал — сегмента нет", async () => {
    const withCtx = await render(payload(session()), { json: false, args: ["--no-pass"] });
    expect(withCtx.code).toBe(0);
    expect(withCtx.out).toMatch(/^myc │ ctx 1% │ \d+ ready · \d+ blocked │ /);
    const old = await render(payload({ ...session(), context_window: undefined }), { json: false, args: ["--no-pass"] });
    expect(old.code).toBe(0);
    expect(old.out).toMatch(/^myc │ \d+ ready · \d+ blocked │ /);
    expect(old.out).not.toContain("ctx");
  });
});

describe("две сессии одновременно — счётчики не смешиваются", () => {
  /**
   * Орка запускает несколько агентов Claude в одном рабочем дереве: общий
   * воркспейс, общий каталог кеша, транскрипты в ОДНОМ каталоге проекта (как
   * у хоста: ~/.claude/projects/<проект>/<сессия>.jsonl). Отрисовки двух
   * сессий идут параллельно, а транскрипты растут между ними. Мутация S3
   * «считать все транскрипты проекта» роняет каждое сравнение.
   */
  test("A и B рисуются параллельно шесть раз — у каждой ровно свои вызовы", async () => {
    const proj = join(root, "projects", "-ws");
    mkdirSync(proj, { recursive: true });
    const ta = join(proj, "aaaa-session.jsonl");
    const tb = join(proj, "bbbb-session.jsonl");
    writeFileSync(ta, call("useful") + call("useful") + call("useful") + call("empty"));
    writeFileSync(tb, call("useful") + call("refusal"));
    mkdirSync(join(proj, "aaaa-session", "subagents"), { recursive: true });
    writeFileSync(join(proj, "aaaa-session", "subagents", "agent-1.jsonl"), call("useful"));

    let a = { useful: 4, total: 5 };
    let b = { useful: 1, total: 2 };
    for (let round = 0; round < 6; round++) {
      const [ra, rb] = await Promise.all([
        render(payload({ session_id: "aaaa", transcript_path: ta })),
        render(payload({ session_id: "bbbb", transcript_path: tb })),
      ]);
      expect(ra.data?.session?.counts).toMatchObject(a);
      expect(rb.data?.session?.counts).toMatchObject(b);
      expect(ra.data!.line.endsWith(`${a.useful}/${a.total} useful calls`)).toBe(true);
      expect(rb.data!.line.endsWith(`${b.useful}/${b.total} useful calls`)).toBe(true);
      appendFileSync(ta, call("useful"));
      appendFileSync(tb, call("refusal"));
      a = { useful: a.useful + 1, total: a.total + 1 };
      b = { useful: b.useful, total: b.total + 1 };
    }
  });
});

describe("транскрипт на 20 МБ не перечитывается от отрисовки к отрисовке", () => {
  test("догоняет порциями по потолку, дальше читает только дописанное — со временем", async () => {
    const t = join(root, "big-session.jsonl");
    const filler = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ход агента. ".repeat(600) }] } })}\n`;
    const parts: string[] = [];
    let size = 0;
    let expected = 0;
    while (size < 20 * 1024 * 1024) {
      const c = filler + (expected < 1_000_000 && parts.length % 4 === 0 ? call("useful") : "");
      if (parts.length % 4 === 0) expected++;
      parts.push(c);
      size += Buffer.byteLength(c);
    }
    writeFileSync(t, parts.join(""));
    const input = payload({ session_id: "big", transcript_path: t });

    let renders = 0;
    let last: Rendered;
    do {
      last = await render(input);
      renders++;
      expect(last.data!.session!.read_bytes).toBeLessThanOrEqual(MAX_SCAN_BYTES);
    } while (last.data!.session!.behind_bytes > 0 && renders < 10);
    expect(renders).toBe(Math.ceil(size / MAX_SCAN_BYTES));
    const firstMs = last.data!.session!.took_ms;
    expect(last.data!.session!.counts.total).toBe(expected);

    const tail = call("empty");
    appendFileSync(t, tail);
    const next = await render(input);
    expect(next.data!.session!.read_bytes).toBe(Buffer.byteLength(tail));
    expect(next.data!.session!.counts).toMatchObject({ total: expected + 1, empty: 1 });
    const idle = await render(input);
    expect(idle.data!.session!.read_bytes).toBe(0);
    console.log(
      `20 МБ через процессы: ${renders} отрисовки на догон (последняя ${firstMs} мс транскрипта), ` +
        `потом ${next.data!.session!.took_ms} мс и ${idle.data!.session!.took_ms} мс; вся отрисовка ${idle.data!.took_ms} мс`,
    );
    // «Не перечитывает» доказано выше структурой (read_bytes: ровно дописанное,
    // потом ноль) — на любой машине. Цена чтения — абсолют, только на
    // откалиброванной свободной машине.
    expectMsWithinBudget(idle.data!.session!.took_ms, 5, "statusline: транскрипт без новых байт");
    expectMsWithinBudget(next.data!.session!.took_ms, 5, "statusline: транскрипт, дописан один вызов");
  });
});

// ---------------------------------------------------------------------------
// wire → как исполняет Claude Code → unwire, на конфиге заказчика
// ---------------------------------------------------------------------------

/** Проектные настройки заказчика БЕЗ узлов myc: хук bd, никакой statusLine. */
const CUSTOMER_PROJECT = `${JSON.stringify(
  {
    hooks: {
      SessionStart: [{ hooks: [{ command: "bd prime --hook-json", type: "command" }], matcher: "" }],
    },
  },
  null,
  2,
)}\n`;

async function cli(dir: string, args: readonly string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const proc = Bun.spawn([BUN, MAIN, "-C", dir, ...args], {
    cwd: dir,
    env: env({ MYC_BIN: bin, ...extra }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode, out, err };
}

/**
 * Ровно как Claude Code 2.1.267 исполняет statusLine: `sh -c <command>`,
 * stdin — JSON и перевод строки, в окружении CLAUDE_PROJECT_DIR.
 */
async function hostRender(project: string, input: string, extra: Record<string, string>): Promise<string> {
  const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8")) as {
    statusLine: { command: string };
  };
  const proc = Bun.spawn(["/bin/sh", "-c", settings.statusLine.command], {
    cwd: project,
    env: env({ CLAUDE_PROJECT_DIR: project, ...extra }),
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(proc.exitCode).toBe(0);
  return out;
}

describe("wire --status-line / unwire на конфиге заказчика", () => {
  test("пользовательская orca: наша строка, orca получает ввод, unwire — побайтный круг", async () => {
    const project = join(root, "customer");
    await makeWorkspace(project);
    write(join(project, ".claude", "settings.json"), CUSTOMER_PROJECT);
    const userBefore = readFileSync(join(home, ".claude", "settings.json"));
    const userMtime = statSync(join(home, ".claude", "settings.json")).mtimeMs;

    const wired = await cli(project, ["wire", "--agents", "claude", "--status-line", "--hook-mode", "append"]);
    expect(wired.code).toBe(0);
    const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8")) as {
      statusLine: { type: string; command: string };
    };
    expect(isOurStatusLineCommand(settings.statusLine.command)).toBe(true);
    expect(settings.statusLine.command).not.toContain("--then");
    expect(wired.out).toContain("gets the same stdin");

    const out = fakeOut();
    const input = payload({ cwd: project, workspace: { current_dir: project, project_dir: project } });
    const shown = await hostRender(project, input, { FAKE_OUT: out, FAKE_SLEEP: "0.3" });
    expect(shown.startsWith("myc")).toBe(true);
    expect(await waitFor(`${out}.done`, 6000)).toBe(true);
    expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));

    const again = await cli(project, ["wire", "--agents", "claude", "--status-line", "--hook-mode", "append"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("everything already in place");

    const un = await cli(project, ["unwire"]);
    expect(un.code).toBe(0);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(CUSTOMER_PROJECT);
    expect(readFileSync(join(home, ".claude", "settings.json"))).toEqual(userBefore);
    expect(statSync(join(home, ".claude", "settings.json")).mtimeMs).toBe(userMtime);
  });

  test("проектная чужая строка: уезжает в --then, получает ввод, unwire возвращает её байт в байт", async () => {
    const project = join(root, "own-line");
    await makeWorkspace(project);
    const foreign = `/bin/sh ${join(home, ".orca", "agent-hooks", "claude-statusline.sh")}`;
    const original = `${JSON.stringify({ statusLine: { type: "command", command: foreign, padding: 1 } }, null, 2)}\n`;
    write(join(project, ".claude", "settings.json"), original);

    const wired = await cli(project, ["wire", "--agents", "claude", "--status-line"]);
    expect(wired.code).toBe(0);
    const sl = (JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8")) as {
      statusLine: { command: string; padding?: number };
    }).statusLine;
    expect(sl.command).toContain("--then");
    expect(sl.padding).toBe(1);

    const out = fakeOut();
    const input = payload({ cwd: project, workspace: { current_dir: project, project_dir: project } });
    await hostRender(project, input, { FAKE_OUT: out, FAKE_SLEEP: "0.3" });
    expect(await waitFor(`${out}.done`, 6000)).toBe(true);
    expect(readFileSync(`${out}.stdin`)).toEqual(Buffer.from(input));

    // Обычный wire после — строку не трогает, запись о прежней не теряет.
    expect((await cli(project, ["wire", "--agents", "claude"])).code).toBe(0);
    expect((await cli(project, ["unwire"])).code).toBe(0);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(original);
  });
});
