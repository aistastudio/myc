/**
 * Отказы лаунчера — по-английски, как весь вывод CLI (эпик memory-rc2s0m1e9kpz,
 * баг memory-8t6r1xk2ft41).
 *
 * bin/myc.js и bin/preflight.js — голый JS, и сторожа english-output (зоны A и
 * B) их не видят: те разбирают .ts. А это первое, что видит человек без Bun, —
 * и до 0.3.6 он видел это по-русски. Здесь два рубежа:
 *
 *   1. статический — ни один строковый, шаблонный или regex-литерал в bin/*.js
 *      не содержит кириллицы (разбор компилятором TypeScript как JS;
 *      комментарии не в счёт — они не печатаются);
 *   2. поведенческий — тот текст, который человек видит на самом деле:
 *      bin/myc.js «под Node» (preload стирает process.versions.bun) с Bun в
 *      PATH и без него и на Windows, bin/preflight.js без Bun. Где в PATH есть
 *      настоящий node, myc.js запускается и им: файл обязан разбираться Node.
 *
 * Сторож доказывает, что видит: детектор проверен на синтетическом исходнике
 * (строка, шаблон, regex — видны; комментарий — нет), а корпус ограничен снизу
 * числом файлов и литералов. Пустой скан не выдаёт себя за чистоту.
 *
 * Мутации, на которых тест обязан падать (проверены на приёмке): русская
 * строка в refusal() или в рамке preflight.js; ветка win32 в refusal() убрана
 * (совет «поставьте Bun» на Windows вместо WSL).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { cliTestEnv } from "@myc/core";

const BIN_DIR = join(import.meta.dir, "..", "bin");
const MYC_JS = join(BIN_DIR, "myc.js");
const PREFLIGHT = join(BIN_DIR, "preflight.js");
const CYRILLIC = /[Ѐ-ӿ]/;

interface Hit {
  readonly line: number;
  readonly text: string;
}

/** Литералы с кириллицей: строки, шаблоны (голова, середины, хвост), regex. */
function cyrillicLiterals(file: string, source: string): { hits: Hit[]; literals: number } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hits: Hit[] = [];
  let literals = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      literals++;
      if (CYRILLIC.test(node.text)) {
        hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { hits, literals };
}

describe("bin/*.js: статический сторож", () => {
  test("детектор видит строку, шаблон и regex и не видит комментарий", () => {
    const synthetic = [
      "// комментарий не печатается",
      'const a = "строка";',
      "const b = `шаблон ${a} хвост`;",
      "const c = /регулярка/;",
      'const d = "plain english";',
    ].join("\n");
    const { hits, literals } = cyrillicLiterals("synthetic.js", synthetic);
    // Голова и хвост шаблона — два литерала, оба с кириллицей.
    expect(hits.map((h) => h.line)).toEqual([2, 3, 3, 4]);
    expect(literals).toBe(5);
  });

  test("ни одного литерала с кириллицей в bin/*.js", () => {
    const files = readdirSync(BIN_DIR).filter((f) => f.endsWith(".js")).sort();
    // Корпус снизу: оба файла на месте, и литералов в них не горстка.
    expect(files).toEqual(expect.arrayContaining(["myc.js", "preflight.js"]));
    let total = 0;
    const found: string[] = [];
    for (const f of files) {
      const { hits, literals } = cyrillicLiterals(f, readFileSync(join(BIN_DIR, f), "utf8"));
      total += literals;
      for (const h of hits) found.push(`packages/cli/bin/${f}:${h.line} ${JSON.stringify(h.text)}`);
    }
    expect(total).toBeGreaterThanOrEqual(40);
    expect(found).toEqual([]);
  });
});

describe("bin/*.js: что видит человек без Bun", () => {
  let tmp: string;
  let emptyBin: string;
  let fakeNode: string;
  let fakeWin: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "myc-launcher-en-"));
    emptyBin = join(tmp, "empty-bin");
    mkdirSync(emptyBin);
    fakeNode = join(tmp, "fake-node.js");
    fakeWin = join(tmp, "fake-win.js");
    // Под Bun process.versions.bun — строка; стёртая, она делает запуск «Node».
    writeFileSync(fakeNode, 'Object.defineProperty(process.versions, "bun", { value: undefined, configurable: true });\n');
    writeFileSync(fakeWin, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
  });

  afterAll(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  });

  async function launch(args: readonly string[], path: string): Promise<{ code: number; err: string }> {
    const proc = Bun.spawn([...args], { cwd: tmp, env: cliTestEnv({ PATH: path }), stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, err };
  }

  /** Bun в PATH: каталог того bun, что гоняет тесты. */
  const withBun = (): string => `${dirname(process.execPath)}:/usr/bin:/bin`;

  function english(err: string): void {
    expect(err.trim().length).toBeGreaterThan(0);
    expect(err).not.toMatch(CYRILLIC);
  }

  test("myc.js под Node без Bun в PATH: код 1, по-английски, совет поставить Bun", async () => {
    const run = await launch([process.execPath, "--preload", fakeNode, MYC_JS, "--version"], emptyBin);
    expect(run.code).toBe(1);
    english(run.err);
    expect(run.err).toContain("myc requires Bun — it cannot run on Node.");
    expect(run.err).toContain("Install Bun (>= 1.3.0) and try again:");
    expect(run.err).toContain("curl -fsSL https://bun.sh/install | bash");
    // Совета ставить Bun под Windows нет: myc там только в WSL.
    expect(run.err).not.toContain("powershell");
  });

  test("myc.js под Node с Bun в PATH: код 1, по-английски, запуск через bun", async () => {
    const run = await launch([process.execPath, "--preload", fakeNode, MYC_JS], withBun());
    expect(run.code).toBe(1);
    english(run.err);
    expect(run.err).toContain("Bun is installed — run myc through it:");
    expect(run.err).toContain("bun x myc <command>");
  });

  test("myc.js под Node на Windows: только WSL, как в рамке preflight.js", async () => {
    const run = await launch([process.execPath, "--preload", fakeNode, "--preload", fakeWin, MYC_JS], withBun());
    expect(run.code).toBe(1);
    english(run.err);
    expect(run.err).toContain("myc runs on macOS and Linux; on Windows use WSL.");
    expect(run.err).toContain("wsl --install");
    // С Bun в PATH на Windows совет «запускайте через bun» был бы ложным.
    expect(run.err).not.toContain("bun x myc");
  });

  test("preflight.js без Bun: рамка по-английски, установку не роняет", async () => {
    const run = await launch([process.execPath, "--preload", fakeNode, PREFLIGHT], emptyBin);
    expect(run.code).toBe(0);
    english(run.err);
    expect(run.err).toContain("@aistastudio/myc is installed, but it will not start yet");
    expect(run.err).toContain("Bun was not found on this system.");
  });

  const node = Bun.which("node");
  test.skipIf(node === null)("настоящий node разбирает myc.js и печатает английский отказ", async () => {
    const run = await launch([node!, MYC_JS, "--version"], emptyBin);
    expect(run.code).toBe(1);
    english(run.err);
    expect(run.err).toMatch(/This is Node \d+\.\d+\.\d+, and myc runs only on Bun/);
    expect(run.err).toContain("myc requires Bun — it cannot run on Node.");
  });
});
