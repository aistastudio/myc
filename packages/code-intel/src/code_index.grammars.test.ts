/**
 * ЧТО ДЕЛАЕТ ИНДЕКСАЦИЯ БЕЗ ГРАММАТИКИ — приёмка решения, а не деталей.
 *
 * Файл отдельный от `code_index.test.ts` СОЗНАТЕЛЬНО: здесь единственные в
 * пакете тесты, которым нужен НАСТОЯЩИЙ разбор (`opts.parse` не подменён) и
 * подменённый каталог грамматик. Подмена `parse` отключает проверку наличия —
 * она и есть разбор, — поэтому смешивать эти тесты с теми нельзя: половина
 * перестала бы проверять то, ради чего написана.
 *
 * Каталог грамматик подменяется через `MYC_TREE_SITTER_GRAMMAR_DIR`, куда
 * копируются НАСТОЯЩИЕ .wasm из node_modules. Не заглушки: разбор обязан
 * произойти по-настоящему, иначе «символы появились» ничего не значит.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { drainCodeIndex, scanCodeIndex, type DrainStats } from "./code_index.ts";
import { GRAMMARS, type GrammarName, findGrammar } from "./grammars.ts";

let repo: string;
let grammarDir: string;
let db: Database;
let savedEnv: string | undefined;

const OPTS = { repoId: "r", root: "" } as { repoId: string; root: string };

/**
 * Настоящий .wasm — источник для «загрузки» в подменный каталог.
 *
 * Пути берутся при ЗАГРУЗКЕ МОДУЛЯ, до того как `beforeEach` подменит
 * `MYC_TREE_SITTER_GRAMMAR_DIR`: иначе помощник искал бы файлы в том самом
 * пустом каталоге, который сам же и наполняет.
 */
const REAL_WASM: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const name of Object.keys(GRAMMARS) as GrammarName[]) {
    const src = findGrammar(GRAMMARS[name].langs[0]!, {});
    if (src === null) throw new Error(`нет tree-sitter-${name}.wasm: сначала bun install`);
    out[name] = src;
  }
  return out;
})();

function stage(name: GrammarName): void {
  copyFileSync(REAL_WASM[name]!, join(grammarDir, GRAMMARS[name].file));
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

async function index(): Promise<DrainStats> {
  scanCodeIndex(db, OPTS, true);
  return drainCodeIndex(db, OPTS, { holder: "t" });
}

function rows(table: string): Array<Record<string, unknown>> {
  return db.query(`SELECT * FROM ${table} WHERE repo_id = 'r'`).all() as Array<
    Record<string, unknown>
  >;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "gi-repo-"));
  grammarDir = mkdtempSync(join(tmpdir(), "gi-wasm-"));
  OPTS.root = repo;
  savedEnv = process.env.MYC_TREE_SITTER_GRAMMAR_DIR;
  process.env.MYC_TREE_SITTER_GRAMMAR_DIR = grammarDir;
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  await migrate(db, { migrations, writable: true });
  write("app.ts", "export function alpha(): number { return 1; }\n");
  write("tool.py", "class Dog:\n    def bark(self):\n        return 1\n");
});

afterEach(() => {
  db.close();
  if (savedEnv === undefined) delete process.env.MYC_TREE_SITTER_GRAMMAR_DIR;
  else process.env.MYC_TREE_SITTER_GRAMMAR_DIR = savedEnv;
  delete process.env.MYC_GRAMMAR_MUTATION;
  rmSync(repo, { recursive: true, force: true });
  rmSync(grammarDir, { recursive: true, force: true });
});

/**
 * Проверки честного пропуска — вынесены в функцию, потому что их роняет
 * мутация ниже, и ронять она обязана ИМЕННО ИХ, а не какой-то похожий набор.
 */
function expectHonestSkip(drain: DrainStats): void {
  // Язык НАЗВАН, и назван вместе с ценой и командой.
  expect(drain.missing).toHaveLength(1);
  expect(drain.missing[0]!.grammar).toBe("python");
  expect([...drain.missing[0]!.langs]).toEqual(["py"]);
  expect(drain.missing[0]!.files).toBe(1);
  expect(drain.missing[0]!.bytes).toBe(GRAMMARS.python.bytes);
  // Пропуск посчитан отдельно от разбора: индекс без питона неотличим от
  // полного, если смотреть только на parsed.
  expect(drain.skipped).toBe(1);
  expect(drain.failed).toBe(0);
}

describe("грамматики нет: файл пропущен, язык назван", () => {
  test("ts разобран, py пропущен и назван, работа не провалена", async () => {
    stage("typescript");
    const drain = await index();
    expectHonestSkip(drain);
    expect(drain.parsed).toBe(1);
    expect(rows("code_defs").map((r) => r.name)).toEqual(["alpha"]);
  });

  test("файл без грамматики НЕ попадает в реестр — иначе он не вернётся", async () => {
    stage("typescript");
    await index();
    // Строка реестра означала бы «файл разобран»: следующий скан признал бы
    // его неизменившимся, и после загрузки грамматики символов бы не
    // появилось никогда. Здесь его нет — и он вернётся сам.
    expect(rows("code_files").map((r) => r.path).sort()).toEqual(["app.ts"]);
  });

  test("повторный прогон снова называет язык, а не замолкает", async () => {
    stage("typescript");
    await index();
    const second = await index();
    expectHonestSkip(second);
  });

  test("после загрузки грамматики индексация даёт символы БЕЗ единого флага", async () => {
    stage("typescript");
    const before = await index();
    expect(before.skipped).toBe(1);

    stage("python"); // ровно то, что делает `myc code fetch py`
    const after = await index();

    expect(after.missing).toEqual([]);
    expect(after.skipped).toBe(0);
    expect(after.parsed).toBe(1);
    expect(rows("code_defs").map((r) => r.name).sort()).toEqual(["alpha", "bark", "Dog"].sort());
    expect(rows("code_files").map((r) => r.path).sort()).toEqual(["app.ts", "tool.py"]);
  });

  test("уже собранные символы не стираются, когда грамматика пропала", async () => {
    stage("typescript");
    stage("python");
    await index();
    expect(rows("code_defs")).toHaveLength(3);

    // Кеш вычистили (или сменили машину): грамматики питона больше нет.
    rmSync(join(grammarDir, GRAMMARS.python.file));
    const after = await index();

    // Файл не менялся — скан признал его неизменившимся, в очередь он не
    // попал, и стирать его дефсы не за что. Пустой каталог кеша не должен
    // обнулять уже собранный индекс.
    expect(after.skipped).toBe(0);
    expect(rows("code_defs")).toHaveLength(3);
  });

  test("сети индексация не касается ни разу", async () => {
    stage("typescript");
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      calls++;
      return real(...a);
    }) as typeof fetch;
    try {
      await index();
    } finally {
      globalThis.fetch = real;
    }
    // Это и есть выбранное решение: пропустить и назвать, а не скачать.
    // Индексация поднимается фоном из чужого вызова — сети здесь не место.
    expect(calls).toBe(0);
  });
});

describe("мутация приёмки", () => {
  test("снятая проверка наличия грамматики роняет проверки пропуска", async () => {
    stage("typescript");
    process.env.MYC_GRAMMAR_MUTATION = "assume-present";

    // Разбор питона без грамматики либо упадёт, либо (если грамматика уже
    // загружена этим процессом раньше) пройдёт молча — но ни в одном из
    // исходов честного пропуска не будет. Именно это и проверяется.
    let drain: DrainStats | null = null;
    try {
      drain = await index();
    } catch {
      drain = null;
    }

    if (drain === null) {
      expect(true).toBe(true); // упал на загрузке — пропуска тем более нет
      return;
    }
    expect(() => expectHonestSkip(drain!)).toThrow();
    expect(drain.missing).toEqual([]);
    expect(drain.skipped).toBe(0);
  });
});
