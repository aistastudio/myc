/**
 * Приёмка ФОНОВОГО ВХОДА код-индекса (memory-m30yh8swnm1d, часть 1).
 *
 * Индекс `code_files/code_defs` строился только стендом замера: ни одна
 * команда не звала `runCodeIndex`, и в базе этого репозитория лежали нули.
 * Вход сделан по образцу дорогого класса `embed`: шаг дренажа НЕ ИНДЕКСИРУЕТ
 * САМ (обход дерева — сотни миллисекунд при бюджете 50 мс, И1), а поднимает
 * отсоединённый `myc code index`.
 *
 * МУТАЦИИ, которые обязаны красить эти тесты:
 *   1. убрать вызов `runCodeIndexStep` из `drainQueueTail` — краснеет
 *      «дренаж поднимает воркер»;
 *   2. снять условие §4.3 (якорь в базе) — краснеет «воркспейс без якорей»;
 *   3. снять проверку периода — краснеет «второй вызов подряд воркера не
 *      поднимает»;
 *   4. позвать индекс ИНЛАЙН вместо спавна — краснеет «дренаж не читает
 *      дерево сам»: код-индекс появился бы в базе без всякого воркера, и
 *      бюджет вызова уехал бы на секунды.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobs, migrate, migrations, openSqlite } from "@myc/store-sqlite";
import { CODE_INDEX_JOB_KIND } from "@myc/code-intel/code-index";
import { CODE_INDEXED_AT_KEY } from "./commands/code.ts";
import { codeIndexEnabled, drainQueueTail } from "./drain.ts";

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "myc-code-drain-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Воркспейс с деревом: `.myc/myc.db` рядом с настоящими файлами. */
async function makeWorkspace(): Promise<{ dir: string; dbPath: string }> {
  const dir = scratch();
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export function alpha(): number {\n  return 1;\n}\n");
  // L0-файл нужен именно здесь: скан пишет его строку в `code_files` СРАЗУ,
  // без очереди, — значит любая индексация внутри процесса дренажа станет
  // видна как ненулевой реестр.
  writeFileSync(join(dir, "README.md"), "alpha\n");
  const dbPath = join(dir, ".myc", "myc.db");
  const driver = openSqlite(dbPath);
  await migrate(driver.database, { migrations, writable: true });
  driver.close();
  return { dir, dbPath };
}

function seedAnchor(dbPath: string): void {
  const driver = openSqlite(dbPath);
  const now = Date.now();
  driver.database
    .prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, created_at, updated_at)
       VALUES ('a1', 'anchor', 1, '', 'src/a.ts:1-3', NULL, 'h-a1', ?1, ?1)`,
    )
    .run(now);
  driver.database
    .prepare(
      `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash,
                            crux, crux_norm, bound_at)
       VALUES ('a1', '', 'src/a.ts', 1, 3, 'h', 'h', 'c', 'c', ?1)`,
    )
    .run(now);
  driver.close();
}

function meta(dbPath: string, key: string): string | null {
  const driver = openSqlite(dbPath);
  try {
    const row = driver.database
      .query("SELECT value FROM myc_meta WHERE key = ?1")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  } finally {
    driver.close();
  }
}

function countRows(dbPath: string, sql: string): number {
  const driver = openSqlite(dbPath);
  try {
    return Number((driver.database.query(sql).get() as { n: number }).n);
  } finally {
    driver.close();
  }
}

describe("выключатель", () => {
  test("под тестом фон погашен, MYC_CODE_INDEX=0 гасит и вне теста", () => {
    expect(codeIndexEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(codeIndexEnabled({ MYC_CODE_INDEX: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(codeIndexEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("шаг код-индекса в дренаже", () => {
  test("дренаж поднимает воркер и ставит отметку (мутация 1)", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const spawned: string[] = [];

    const r = await drainQueueTail({
      dbPath,
      env: {},
      spawnCodeIndex: (p) => spawned.push(p),
    });

    expect(r.codeIndex).not.toBeNull();
    expect(r.codeIndex!.spawned).toBe(true);
    expect(r.codeIndex!.triggered).toBe("period");
    expect(spawned).toEqual([dbPath]);
    expect(meta(dbPath, CODE_INDEXED_AT_KEY)).not.toBeNull();
  });

  test("дренаж НЕ читает дерево сам: индекс появляется только от воркера (мутация 4)", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);

    await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: () => {} });

    // Воркер подменён пустышкой — значит всё, что могло записать строки, это
    // сам дренаж. Ноль здесь и есть доказательство, что он этого не делает:
    // ни реестра файлов (его пишет скан), ни работ в очереди (их ставит он же),
    // ни определений (их пишет разбор).
    expect(countRows(dbPath, "SELECT count(*) AS n FROM code_files")).toBe(0);
    expect(countRows(dbPath, "SELECT count(*) AS n FROM code_defs")).toBe(0);
    expect(
      countRows(dbPath, `SELECT count(*) AS n FROM jobs WHERE kind = '${CODE_INDEX_JOB_KIND}'`),
    ).toBe(0);
  });

  test("второй вызов подряд воркера не поднимает: период (мутация 3)", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const spawned: string[] = [];
    const spawn = (p: string): void => void spawned.push(p);

    const first = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: spawn });
    const second = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: spawn });

    expect(first.codeIndex?.spawned).toBe(true);
    expect(second.codeIndex).toBeNull();
    expect(spawned.length).toBe(1);
  });

  test("короткий период — воркер поднимается снова", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const spawned: string[] = [];
    const spawn = (p: string): void => void spawned.push(p);
    const env = { MYC_CODE_INDEX_PERIOD_MS: "0" };

    await drainQueueTail({ dbPath, env, spawnCodeIndex: spawn });
    await drainQueueTail({ dbPath, env, spawnCodeIndex: spawn });

    expect(spawned.length).toBe(2);
  });

  test("воркспейс без якорей: индекс не строится, и причина названа (мутация 2)", async () => {
    const { dbPath } = await makeWorkspace();
    const spawned: string[] = [];

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: (p) => spawned.push(p) });

    expect(r.codeIndex?.spawned).toBe(false);
    expect(r.codeIndex?.anchors).toBe(0);
    expect(r.codeIndex?.reason).toContain("anchor");
    expect(spawned).toEqual([]);
  });

  test("строки code_index в очереди — тоже повод, даже когда период не наступил", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const spawned: string[] = [];
    const spawn = (p: string): void => void spawned.push(p);

    await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: spawn }); // отметка поставлена
    const driver = openSqlite(dbPath);
    jobs.enqueue(driver.database, CODE_INDEX_JOB_KIND, { entityId: "src/a.ts", scope: "" });
    driver.close();

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: spawn });
    expect(r.codeIndex?.triggered).toBe("jobs");
    expect(r.codeIndex?.spawned).toBe(true);
    expect(spawned.length).toBe(2);
  });

  test("чужая аренда: второго воркера не поднимаем", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const driver = openSqlite(dbPath);
    jobs.enqueue(driver.database, CODE_INDEX_JOB_KIND, { entityId: "src/a.ts", scope: "" });
    jobs.claim(driver.database, [CODE_INDEX_JOB_KIND], "сосед", { leaseMs: 60_000 });
    driver.close();

    const spawned: string[] = [];
    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: (p) => spawned.push(p) });

    expect(r.codeIndex?.spawned).toBe(false);
    expect(r.codeIndex?.reason).toContain("lease");
    expect(spawned).toEqual([]);
  });

  test("MYC_CODE_INDEX=0: шага нет вовсе", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const spawned: string[] = [];

    const r = await drainQueueTail({
      dbPath,
      env: { MYC_CODE_INDEX: "0" },
      spawnCodeIndex: (p) => spawned.push(p),
    });

    expect(r.codeIndex).toBeNull();
    expect(spawned).toEqual([]);
  });
});
