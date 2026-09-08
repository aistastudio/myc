/**
 * S45 (myc-ye3.8): рантайм расширений грузится ЛЕНИВО И ПО ПОТРЕБНОСТИ КОМАНДЫ.
 *
 * Дефект, который здесь заперт, не был ошибкой ни в одном из двух решений,
 * его породивших. Лёгкий драйвер CLI намеренно не поднимал рантайм (S43:
 * `show` обязан укладываться в 3 мс, vec0 стоит 4-7 мс на процесс), а
 * векторные миграции по S26 применяются только при загруженном vec0 (база
 * без расширения обязана быть полноценной). Вместе: vec0 из CLI не грузился
 * НИКОГДА, `nodes_vec` не создавалась НИКОГДА, и векторная ветка `recall`
 * была недостижима ни при каких настройках. Ни один тест этого не ловил,
 * потому что каждый проверял свою половину и обе половины были верны.
 *
 * Поэтому тесты ниже проверяют не половины, а СТЫК — наблюдаемое состояние
 * базы после реальных команд:
 *   - команды с бюджетом 3 мс (`show`, `ready`, `claim`) не создают ни одного
 *     векторного объекта и держат соединение без vec0;
 *   - `recall` создаёт их на СУЩЕСТВУЮЩЕЙ базе, созданной без расширения, —
 *     без пересоздания базы и без потери данных;
 *   - повторный `recall` не накатывает набор второй раз.
 *
 * Среда без sqlite-vec — не пропуск теста, а второй проверяемый исход: там
 * обязан держаться инвариант S26 (никаких векторных объектов вообще), и
 * утверждения ниже это разделение делают явным.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations, ensureSqliteRuntime, vectorMigrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand, createClaimCommand } from "./tasks.ts";
import { createShowCommand } from "./show.ts";
import { createReadyCommand } from "./ready.ts";
import { createRecallCommand } from "./recall.ts";
import { openStore, VECTOR_OPEN } from "./store.ts";
import type { CommandContext } from "../registry.ts";

/** Факт среды, а не догадка: тот же источник, которым пользуется продукт. */
const VEC0 = ensureSqliteRuntime().vec.loaded;

let projectDir: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  r.register(createClaimCommand());
  r.register(createShowCommand());
  r.register(createRecallCommand());
  return r;
}

/** Всё, что sqlite_master знает о векторных объектах: таблицы, тени, индексы. */
function vecObjects(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name LIKE '%vec%' OR name = 'schema_migrations_vec' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

function appliedVecVersions(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.query("SELECT version FROM schema_migrations_vec ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function nodeCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM nodes").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function fakeCtx(dir: string): CommandContext {
  return {
    args: [],
    flags: {},
    globals: { json: false, ndjson: false, strict: false, quiet: false, color: false, directory: dir },
    warn: () => {},
    diagnostics: { warnings: [] } as never,
  };
}

let dbPath: string;

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  projectDir = mkdtempSync(join(tmpdir(), "myc-vec-lazy-"));
  mkdirSync(join(projectDir, ".myc"));
  dbPath = join(projectDir, ".myc", "myc.db");
  // База создаётся РОВНО базовым набором — так же, как её создал `myc init`
  // до этой правки: ни одного векторного объекта в ней нет.
  const raw = new Database(dbPath, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(projectDir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", projectDir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

describe("S45: рантайм расширений — по потребности команды", () => {
  test("show/ready/claim не поднимают vec0 и не создают ни одного векторного объекта", async () => {
    expect(vecObjects(dbPath)).toEqual([]);

    const task = await myc("task", "задача для замера", "-p", "P1");
    expect(task.code).toBe(0);
    const id = (task.stdout as string).split(/\s+/)[0]!;

    expect((await myc("ready")).code).toBe(0);
    expect((await myc("claim", id)).code).toBe(0);
    expect((await myc("show", id)).code).toBe(0);

    // Наблюдаемое состояние базы, а не рассуждение по коду.
    expect(vecObjects(dbPath)).toEqual([]);

    // И само соединение этих команд — без расширений, даже там, где vec0 есть.
    const opened = await openStore(fakeCtx(projectDir));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.handle.vec0).toBe(false);
      expect(opened.handle.driver.vec0).toBe(false);
      opened.handle.close();
    }
  });

  test("openStore(VECTOR_OPEN) поднимает рантайм: vec0 виден в соединении ровно тогда, когда он есть в среде", async () => {
    const opened = await openStore(fakeCtx(projectDir), VECTOR_OPEN);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.handle.vec0).toBe(VEC0);
    opened.handle.close();
  });

  test("recall на СУЩЕСТВУЮЩЕЙ базе без vec0: векторные миграции доезжают, база не пересоздаётся", async () => {
    const created = await myc("task", "узел, который обязан пережить накат", "-p", "P2");
    expect(created.code).toBe(0);
    const before = nodeCount(dbPath);
    expect(before).toBeGreaterThan(0);
    expect(vecObjects(dbPath)).toEqual([]);

    const recalled = await myc("recall", "накат векторного набора");
    expect(recalled.code).toBe(0);

    if (VEC0) {
      const objects = vecObjects(dbPath);
      expect(objects).toContain("nodes_vec");
      expect(objects).toContain("vec_nodes_f32");
      expect(objects).toContain("schema_migrations_vec");
      // Набор доехал ЦЕЛИКОМ, а не первой миграцией.
      expect(appliedVecVersions(dbPath)).toEqual(
        [...vectorMigrations].map((m) => m.version).sort((a, b) => a - b),
      );
    } else {
      // S26 без расширения: база обязана остаться такой, будто о векторах не
      // знает вовсе — включая таблицу учёта.
      expect(vecObjects(dbPath)).toEqual([]);
    }

    // Ни пересоздания, ни потери данных: те же узлы на месте.
    expect(nodeCount(dbPath)).toBe(before);
  });

  /**
   * Регрессия, найденная прогоном e2e MCP (packages/mcp/src/e2e.test.ts):
   * MCP-сервер — ДОЛГОЖИВУЩИЙ процесс. Он открывает свой стор на старте, а
   * `myc_recall` исполняет CLI-команду `recall` ЭТИМ ЖЕ процессом. К моменту
   * подъёма рантайма соединение уже открыто, и Database.setCustomSQLite
   * отказывает по определению — переставить SQLite задним числом нельзя.
   *
   * Правильное поведение — не падение: вектора в таком процессе не будет
   * (ровно как до S45), но `recall` обязан отдать лексическую выдачу и
   * НАЗВАТЬ причину. Проверяется в отдельном процессе, потому что в самом
   * прогоне тестов рантайм уже поднят препладом и отказать не может.
   */
  test("процесс, где соединение открыто раньше: recall не падает, а называет причину", async () => {
    const script = join(projectDir, "late-runtime.ts");
    await Bun.write(
      script,
      [
        'import { Database } from "bun:sqlite";',
        // Соединение ДО любого подъёма рантайма — как у MCP-сервера.
        `const first = new Database(${JSON.stringify(dbPath)});`,
        'first.query("SELECT 1").get();',
        `const { run } = await import(${JSON.stringify(join(import.meta.dir, "..", "index.ts"))});`,
        `const { Registry } = await import(${JSON.stringify(join(import.meta.dir, "..", "registry.ts"))});`,
        `const { createRecallCommand } = await import(${JSON.stringify(join(import.meta.dir, "recall.ts"))});`,
        "const registry = new Registry();",
        "registry.register(createRecallCommand());",
        `const r = await run(["-C", ${JSON.stringify(projectDir)}, "recall", "поздний рантайм"], { registry, env: { MYC_ACTOR: "tester" } });`,
        'const text = [String(r.stdout ?? ""), String(r.stderr ?? "")].join(" ");',
        "console.log(JSON.stringify({ code: r.code, text }));",
      ].join("\n"),
    );
    const proc = Bun.spawnSync([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    });
    const out = proc.stdout.toString().trim().split("\n").at(-1) ?? "";
    // Диагностика на случай, когда подпроцесс не дожил до своей печати: без
    // неё падение выглядит как голое `JSON.parse` на пустой строке и не
    // говорит НИЧЕГО о причине — а причина живёт в другом процессе и на
    // другой платформе, где её иначе не увидеть.
    let parsed: { code: number; text: string };
    try {
      parsed = JSON.parse(out) as { code: number; text: string };
    } catch {
      throw new Error(
        "подпроцесс не напечатал JSON.\n" +
          `код выхода: ${proc.exitCode}\n` +
          `stdout: ${proc.stdout.toString().slice(0, 800)}\n` +
          `stderr: ${proc.stderr.toString().slice(0, 800)}`,
      );
    }
    if (parsed.code !== 0) {
      console.log(`[диагностика] recall вернул ${parsed.code}, текст: ${parsed.text.slice(0, 600)}`);
    }
    expect(parsed.code).toBe(0);
    if (VEC0) {
      // Именно названная деградация, а не молчание и не падение.
      expect(parsed.text).toContain("degraded.vector_runtime");
    }
  }, 20_000);

  /**
   * Гонка первого открытия. Векторные миграции идут БЕЗ транзакции (vec.ts:
   * откат CREATE VIRTUAL TABLE с shadow-таблицами vec0 не гарантирован),
   * поэтому проверка «версия отстаёт» и сам накат не атомарны. Пока набор
   * звали только тесты, это ничего не стоило; с S45 его зовёт `recall`,
   * который агенты запускают параллельно. Замер до правки: 15 отказов
   * `table nodes_vec already exists` на 36 одновременных recall.
   *
   * Настоящие процессы, а не имитация: гонка живёт между процессами.
   */
  test("двенадцать одновременных recall на свежей базе: ни одного отказа, набор накатан один раз", async () => {
    const CLI = join(import.meta.dir, "..", "main.ts");
    const WORKERS = 12;
    const workers = Array.from({ length: WORKERS }, () =>
      Bun.spawn([process.execPath, CLI, "-C", projectDir, "recall", "гонка первого открытия"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_ENV: "test", MYC_ACTOR: "tester" },
      }),
    );
    const codes = await Promise.all(workers.map((w) => w.exited));
    const errors = await Promise.all(workers.map((w) => new Response(w.stderr).text()));
    expect(errors.filter((e) => e.includes("already exists"))).toEqual([]);
    expect(codes).toEqual(Array.from({ length: WORKERS }, () => 0));

    if (VEC0) {
      // Ровно один комплект записей учёта: победитель накатил, проигравшие
      // дождались и перечитали, а не накатили поверх.
      expect(appliedVecVersions(dbPath)).toEqual(
        [...vectorMigrations].map((m) => m.version).sort((a, b) => a - b),
      );
    }
  }, 60_000);

  test("повторный recall не накатывает векторный набор второй раз", async () => {
    expect((await myc("recall", "первый запрос")).code).toBe(0);
    const first = appliedVecVersions(dbPath);
    expect((await myc("recall", "второй запрос")).code).toBe(0);
    expect(appliedVecVersions(dbPath)).toEqual(first);
    if (VEC0) expect(first.length).toBe(vectorMigrations.length);
  });
});
