/**
 * Вывод в pipe не теряется на выходе (memory-vzst83nfmp3q).
 *
 * В 0.3.0 `main.ts` делал `process.stdout.write(вывод)` и сразу
 * `process.exit(код)`. Запись в pipe у Bun асинхронна: ядро берёт столько,
 * сколько влезает в буфер пайпа (64 КБ на macOS), остальное ждёт в очереди
 * процесса — и `exit` её выбрасывал. `myc code grep import --limit 5000` в
 * файл давал 226087 байт, через `| cat` — ровно 65536, код 0, ни слова.
 *
 * ПОЧЕМУ ЗДЕСЬ НАСТОЯЩИЙ ПАЙП ОБОЛОЧКИ, А НЕ `stdout: "pipe"` У Bun.spawn.
 * Родитель Bun читает такой пайп сам, в нативный буфер, не дожидаясь JS:
 * замер на бинаре 0.3.0 — через Bun.spawn приходят все 226086 байт при любой
 * задержке чтения (0, 300, 1000 мс). Тест на нём зеленел бы и на сломанном
 * main.ts. Медленный читатель — `{ sleep; cat; }` по ту сторону пайпа
 * оболочки: пока он спит, буфер пайпа полон, и потерю ничто не маскирует.
 *
 * МУТАЦИЯ «вернуть process.exit сразу после write» — краснеет первый тест:
 * вместо сотен КБ приходит 65536 байт.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { Database } from "bun:sqlite";
import { ExitCode } from "./exit.ts";
import { run } from "./index.ts";
import { Registry } from "./registry.ts";
import { createCodeCommand } from "./commands/code.ts";

const MAIN = resolve(import.meta.dir, "main.ts");
const INDEX = resolve(import.meta.dir, "index.ts");
const BUN = process.execPath;
/** Медленный читатель: полсекунды не читает ничего, потом забирает всё. */
const SLOW = "{ sleep 0.5; cat; }";

let root: string;
let repo: string;
let home: string;

/** Аргумент для sh в одинарных кавычках. */
function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function cli(...args: string[]): string {
  return [BUN, MAIN, "-C", repo, ...args].map(q).join(" ");
}

interface Piped {
  readonly out: Buffer;
  readonly err: string;
  /** Код выхода САМОГО myc (из обёртки), а не читателя. */
  readonly code: number;
  readonly ms: number;
}

/**
 * `sh -c '{ <команда>; echo $? >код; } 2>err | <читатель> >out'` — код выхода
 * берётся у команды, а не у последнего звена конвейера.
 */
async function piped(command: string, reader: string, timeoutMs = 20_000): Promise<Piped> {
  const tag = Math.random().toString(36).slice(2);
  const out = join(root, `${tag}.out`);
  const err = join(root, `${tag}.err`);
  const codeFile = join(root, `${tag}.code`);
  const t0 = performance.now();
  // stderr самой оболочки — не наш: унаследуй его sh, и повисший потомок
  // держал бы открытым вывод тест-раннера после его конца.
  const sh = Bun.spawn(
    ["sh", "-c", `{ ${command}; echo $? > ${q(codeFile)}; } 2> ${q(err)} | ${reader} > ${q(out)}`],
    { env: { ...process.env, MYC_HOME: home, MYC_ACTOR: "tester" }, stdout: "ignore", stderr: "ignore" },
  );
  const timer = setTimeout(() => {
    sh.kill(9);
    killStragglers();
  }, timeoutMs);
  await sh.exited;
  clearTimeout(timer);
  const ms = performance.now() - t0;
  const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    out: existsSync(out) ? readFileSync(out) : Buffer.alloc(0),
    err: read(err),
    // Нет файла кода — команда не дошла до `echo $?`: убита по таймауту.
    code: existsSync(codeFile) ? Number(read(codeFile).trim()) : Number.NaN,
    ms,
  };
}

/** Всё, что запущено из временного каталога теста и пережило свою оболочку. */
function killStragglers(): void {
  Bun.spawnSync(["pkill", "-9", "-f", root], { stdout: "ignore", stderr: "ignore" });
}

/** Эталон: тот же вызов со stdout в ФАЙЛ — запись в файл синхронна. */
async function reference(...args: string[]): Promise<{ out: Buffer; code: number }> {
  const out = join(root, `ref-${Math.random().toString(36).slice(2)}.out`);
  const proc = Bun.spawn([BUN, MAIN, "-C", repo, ...args], {
    env: { ...process.env, MYC_HOME: home, MYC_ACTOR: "tester" },
    stdout: Bun.file(out),
    stderr: "inherit",
  });
  const code = await proc.exited;
  return { out: readFileSync(out), code };
}

/**
 * Последняя строка code grep — время в ms; от прогона к прогону оно разное.
 * Нормализация ОБЯЗАНА сработать: в 0.3.2 вывод перевели («мс» → «ms»), шаблон
 * молча перестал совпадать, и тест проходил лишь тогда, когда оба прогона
 * случайно укладывались в одинаковое число мс (локально — да, в CI 2 ≠ 3).
 * Промах шаблона — теперь падение с объяснением, а не мигание.
 */
function stable(b: Buffer): string {
  const text = b.toString("utf8");
  const out = text.replace(/\d+ ms\n$/u, "N ms\n");
  if (out === text) throw new Error(`нормализация времени не сработала — последняя строка: ${JSON.stringify(text.slice(-80))}`);
  return out;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-drain-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(join(repo, ".myc"), { recursive: true });
  mkdirSync(home, { recursive: true });
  // 6000 строк с литералом → ~450 КБ вывода `code grep`: в семь раз больше
  // буфера пайпа, так что потеря не может спрятаться в «почти влезло».
  const lines: string[] = [];
  for (let i = 0; i < 6000; i++) {
    lines.push(`needle ${String(i).padStart(5, "0")} ${"lorem ipsum dolor sit amet ".repeat(2)}`);
  }
  writeFileSync(join(repo, "notes.md"), `${lines.join("\n")}\n`);
  const raw = new Database(join(repo, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  const registry = new Registry();
  registry.register(createCodeCommand());
  const index = await run(["-C", repo, "code", "index"], {
    registry,
    env: { MYC_ACTOR: "tester", MYC_HOME: home },
  });
  expect(index.code).toBe(ExitCode.OK);
});

afterAll(() => {
  killStragglers();
  rmSync(root, { recursive: true, force: true });
});

describe("myc в pipe с медленным читателем", () => {
  test("байты те же, что в файл, код выхода тот же", async () => {
    const ref = await reference("code", "grep", "needle");
    expect(ref.code).toBe(ExitCode.OK);
    // Сторож фикстуры: вывод обязан быть заведомо больше буфера пайпа.
    expect(ref.out.byteLength).toBeGreaterThan(6 * 65_536);

    const got = await piped(cli("code", "grep", "needle"), SLOW);
    // Сравнение по байтам — с точностью до числа миллисекунд в последней
    // строке: оно своё у каждого прогона.
    const bytes = (b: Buffer): number => Buffer.byteLength(stable(b), "utf8");
    expect({ bytes: bytes(got.out), code: got.code }).toEqual({
      bytes: bytes(ref.out),
      code: ExitCode.OK,
    });
    expect(stable(got.out)).toBe(stable(ref.out));
    expect(got.err).toBe("");
  }, 20_000);

  test("отказ команды: её код доходит через pipe, сообщение — в stderr целиком", async () => {
    const got = await piped(cli("code", "symbol", "nosuchsymbol"), SLOW);
    expect(got.code).toBe(ExitCode.NOTFOUND);
    expect(got.out.byteLength).toBe(0);
    expect(got.err).toContain("notfound.symbol");
    expect(got.err).toContain("hint:");
  }, 20_000);

  test("MCP-сервер пишет мимо RunResult — его ответ тоже доходит целиком", async () => {
    // Запросы в stdin и EOF: сервер отвечает и возвращается, main выходит.
    // Ответ пишет сам сервер (serveStdio → process.stdout.write), и в 0.3.0
    // он обрывался так же — 65536 из 566010 байт на этом репозитории.
    const req = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "myc_code_grep", arguments: { literal: "needle", limit: 5000 } } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const input = join(root, "mcp-requests.jsonl");
    writeFileSync(input, `${req}\n`);
    const got = await piped(`${cli("mcp")} < ${q(input)}`, SLOW);
    const lines = got.out.toString("utf8").trim().split("\n");
    expect({ code: got.code, lines: lines.length }).toEqual({ code: ExitCode.OK, lines: 2 });
    const answer = JSON.parse(lines[1]!) as { id: number; result: { content: Array<{ text: string }> } };
    expect(answer.id).toBe(2);
    // Сторож: ответ заведомо больше буфера пайпа — иначе проверять нечего.
    expect(Buffer.byteLength(lines[1]!, "utf8")).toBeGreaterThan(4 * 65_536);
    expect(answer.result.content[0]!.text).toContain("needle 05999");
  }, 20_000);

  test("читатель ушёл рано (| head -1): код самой команды, stderr пуст", async () => {
    const ref = await reference("code", "grep", "needle");
    const got = await piped(cli("code", "grep", "needle"), "head -1");
    const firstLine = `${ref.out.toString("utf8").split("\n")[0]}\n`;
    expect(got.out.toString("utf8")).toBe(firstLine);
    // EPIPE — не ошибка команды: ни стека, ни кода сигнала, ни ожидания.
    expect({ code: got.code, err: got.err }).toEqual({ code: ExitCode.OK, err: "" });
  }, 20_000);
});

describe("выход после слива не ждёт живых handle'ов", () => {
  /** Скрипт: живой setInterval (как воркер или таймер фона) и 400 КБ вывода. */
  function script(mode: "finish" | "exitCode" | "stderr"): string {
    const path = join(root, `handle-${mode}.ts`);
    writeFileSync(
      path,
      [
        `import { finish, guardStdio } from ${JSON.stringify(INDEX)};`,
        "guardStdio();",
        "setInterval(() => {}, 1000); // живой handle: сам процесс не кончится",
        'const big = "h".repeat(99).concat("\\n").repeat(4000);',
        mode === "finish"
          ? "void finish({ code: 3, stdout: big });"
          : mode === "stderr"
            ? "void finish({ code: 4, stdout: \"ok\\n\", stderr: big });"
            : "process.stdout.write(big); process.exitCode = 3;",
        "",
      ].join("\n"),
    );
    return path;
  }

  test("finish: процесс завершается сам, с кодом и всеми байтами", async () => {
    const got = await piped([BUN, script("finish")].map(q).join(" "), SLOW, 6_000);
    expect({ code: got.code, bytes: got.out.byteLength }).toEqual({ code: 3, bytes: 400_000 });
    expect(got.ms).toBeLessThan(5_000);
  }, 10_000);

  // Добавлено на приёмке: мутация «не ждать слива stderr» выживала — все
  // прочие тесты пишут в stderr строку короче буфера пайпа, а `piped` уводит
  // stderr в файл, где запись синхронна. Здесь stderr идёт в медленный пайп.
  test("finish: большой stderr тоже уходит целиком, а не режется на буфере", async () => {
    const got = await piped(`${[BUN, script("stderr")].map(q).join(" ")} 2>&1 1>/dev/null`, SLOW, 6_000);
    expect({ code: got.code, bytes: got.out.byteLength }).toEqual({ code: 4, bytes: 400_000 });
  }, 10_000);

  test("контроль: exitCode без exit при том же handle висит — потому и exit", async () => {
    // Без этого контроля «завершился сам» ничего бы не значило: вдруг
    // setInterval в скрипте процесс и не держит.
    const proc = Bun.spawn([BUN, script("exitCode")], { stdout: "ignore", stderr: "ignore" });
    const exitedByItself = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(1_500).then(() => false),
    ]);
    proc.kill(9);
    await proc.exited;
    expect(exitedByItself).toBe(false);
  }, 10_000);
});
