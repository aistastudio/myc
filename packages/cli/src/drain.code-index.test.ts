/**
 * Приёмка ФОНОВОГО ВХОДА код-индекса (memory-m30yh8swnm1d, часть 1) и его
 * обновления по возрасту (memory-es8qwd555cjt).
 *
 * Индекс `code_files/code_defs` строился только стендом замера: ни одна
 * команда не звала `runCodeIndex`, и в базе этого репозитория лежали нули.
 * Вход сделан по образцу дорогого класса `embed`: шаг дренажа НЕ ИНДЕКСИРУЕТ
 * САМ (обход дерева — сотни миллисекунд при бюджете 50 мс, И1), а ставит
 * работу `code_refresh` (одну на воркспейс), захватывает её арендой и
 * поднимает отсоединённый `myc code index --job`.
 *
 * Здесь — однопроцессная половина (drainQueueTail с подменённым спавном);
 * настоящие процессы (prime хука, гонка агентов, живой воркер) — в
 * code-refresh.multiprocess.test.ts.
 *
 * МУТАЦИИ, которые обязаны красить эти тесты:
 *   1. убрать вызов `runCodeIndexStep` из `drainQueueTail` — краснеет
 *      «индекс старше порога: работа поставлена, захвачена, воркер поднят»;
 *   2. снять условие §4.3 (якорь или индекс) — краснеет «ни якорей, ни
 *      индекса»;
 *   3. снять порог (повод есть всегда) — краснеет «свежий индекс — работы
 *      нет»;
 *   4. позвать индекс ИНЛАЙН вместо спавна — краснеет «дренаж не читает
 *      дерево сам»;
 *   5. снять дедупликацию (`entityId` не задан) — краснеет «два дренажа
 *      подряд: одна работа, один воркер» (две строки);
 *   6. поднимать воркер без захвата аренды — краснеет тот же тест (два
 *      воркера);
 *   7. вернуть отметку дренажу (ставить `code_indexed_at` ДО воркера) —
 *      краснеет «отметку ставит не дренаж».
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobs, migrate, migrations, openSqlite } from "@myc/store-sqlite";
import { CODE_INDEX_JOB_KIND } from "@myc/code-intel/code-index";
import {
  CODE_REFRESH_AFTER_MS,
  CODE_REFRESH_JOB_KIND,
  CODE_REFRESH_LEASE_MS,
  indexFreshness,
} from "@myc/code-intel/refresh";
import { CODE_INDEXED_AT_KEY } from "./commands/code.ts";
import { codeIndexEnabled, drainQueueTail, type ClaimedJob } from "./drain.ts";

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

function exec(dbPath: string, sql: string, ...params: Array<string | number>): void {
  const driver = openSqlite(dbPath);
  try {
    driver.database.prepare(sql).run(...params);
  } finally {
    driver.close();
  }
}

function seedAnchor(dbPath: string): void {
  const now = Date.now();
  exec(
    dbPath,
    `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, created_at, updated_at)
     VALUES ('a1', 'anchor', 1, '', 'src/a.ts:1-3', NULL, 'h-a1', ?1, ?1)`,
    now,
  );
  exec(
    dbPath,
    `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash,
                          crux, crux_norm, bound_at)
     VALUES ('a1', '', 'src/a.ts', 1, 3, 'h', 'h', 'c', 'c', ?1)`,
    now,
  );
}

/** Индекс «построен» (строка реестра) и сверен `at` назад. Якорей нет. */
function seedIndex(dbPath: string, refreshedAt: number): void {
  exec(
    dbPath,
    `INSERT INTO code_files (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at)
     VALUES ('', 'README.md', 'markdown', 0, 6, 'h', ?1)`,
    refreshedAt,
  );
  setStamp(dbPath, refreshedAt);
}

function setStamp(dbPath: string, at: number): void {
  exec(
    dbPath,
    `INSERT INTO myc_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    CODE_INDEXED_AT_KEY,
    String(at),
  );
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

const refreshRows = (dbPath: string): number =>
  countRows(dbPath, `SELECT count(*) AS n FROM jobs WHERE kind = '${CODE_REFRESH_JOB_KIND}'`);

/** Заглушка спавна: копит захваченные работы, воркер не поднимается. */
function recorder(): { spawned: Array<{ db: string; job: ClaimedJob }>; spawn: (db: string, job: ClaimedJob) => void } {
  const spawned: Array<{ db: string; job: ClaimedJob }> = [];
  return { spawned, spawn: (db, job) => void spawned.push({ db, job }) };
}

const HOUR = 3_600_000;

describe("выключатель", () => {
  test("под тестом фон погашен, MYC_CODE_INDEX=0 гасит и вне теста", () => {
    expect(codeIndexEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(codeIndexEnabled({ MYC_CODE_INDEX: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(codeIndexEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("шаг код-индекса в дренаже", () => {
  test("индекс старше порога: работа поставлена, захвачена, воркер поднят (мутация 1)", async () => {
    const { dbPath } = await makeWorkspace();
    const old = Date.now() - 9 * HOUR;
    seedIndex(dbPath, old);
    const rec = recorder();

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });

    expect(r.codeIndex).not.toBeNull();
    expect(r.codeIndex!.spawned).toBe(true);
    expect(r.codeIndex!.queued).toBe(true);
    expect(r.codeIndex!.triggered).toBe("period");
    expect(rec.spawned.map((s) => s.db)).toEqual([dbPath]);
    expect(refreshRows(dbPath)).toBe(1);
    // Воркер получил ту самую строку, и она под его арендой — «refreshing».
    const driver = openSqlite(dbPath);
    const row = jobs.get(driver.database, rec.spawned[0]!.job.id)!;
    const fresh = indexFreshness(driver.database, Date.now(), CODE_REFRESH_AFTER_MS);
    driver.close();
    expect(row.kind).toBe(CODE_REFRESH_JOB_KIND);
    expect(row.lease_holder).toBe(rec.spawned[0]!.job.holder);
    expect(row.lease_expires).toBeGreaterThan(Date.now());
    expect(fresh.job?.state).toBe("running");
    expect(fresh.stale).toBe(true);
  });

  test("отметку ставит не дренаж, а завершённый прогон (мутация 7)", async () => {
    const { dbPath } = await makeWorkspace();
    const old = Date.now() - 9 * HOUR;
    seedIndex(dbPath, old);

    await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: recorder().spawn });

    // Воркер-заглушка не отработал — индекс по-прежнему девятичасовой, и
    // строка статуса обязана это видеть, а не «0s ago» от отметки дренажа.
    expect(meta(dbPath, CODE_INDEXED_AT_KEY)).toBe(String(old));
  });

  test("два дренажа подряд (два агента): одна работа, один воркер (мутации 5, 6)", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 9 * HOUR);
    const rec = recorder();

    const first = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });
    const second = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });

    expect(first.codeIndex?.spawned).toBe(true);
    expect(second.codeIndex?.spawned).toBe(false);
    expect(second.codeIndex?.queued).toBe(false);
    expect(second.codeIndex?.job).toBe(first.codeIndex!.job);
    expect(second.codeIndex?.reason).toContain("already running");
    expect(refreshRows(dbPath)).toBe(1);
    expect(rec.spawned.length).toBe(1);
  });

  test("свежий индекс — работы нет, шаг не запускался (мутация 3)", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 60_000);
    const rec = recorder();

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });

    expect(r.codeIndex).toBeNull();
    expect(refreshRows(dbPath)).toBe(0);
    expect(rec.spawned).toEqual([]);
  });

  test("порог — MYC_CODE_INDEX_PERIOD_MS: минутный индекс при пороге 30 с уже устарел", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 60_000);
    const rec = recorder();

    const r = await drainQueueTail({ dbPath, env: { MYC_CODE_INDEX_PERIOD_MS: "30000" }, spawnCodeIndex: rec.spawn });

    expect(r.codeIndex?.spawned).toBe(true);
    expect(rec.spawned.length).toBe(1);
  });

  test("индекс без якорей обновляется: его построил человек, и он не должен отставать", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 2 * HOUR);
    const rec = recorder();

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });

    expect(r.codeIndex?.anchors).toBe(0);
    expect(r.codeIndex?.spawned).toBe(true);
  });

  test("якорь без индекса — тоже повод (§4.3): работа на весь воркспейс", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const rec = recorder();

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });

    expect(r.codeIndex?.spawned).toBe(true);
    expect(r.codeIndex?.anchors).toBe(1);
  });

  test("дренаж НЕ читает дерево сам: индекс появляется только от воркера (мутация 4)", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);

    await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: () => {} });

    // Воркер подменён пустышкой — значит всё, что могло записать строки, это
    // сам дренаж. Ноль здесь и есть доказательство, что он этого не делает:
    // ни реестра файлов (его пишет скан), ни работ разбора (их ставит он же),
    // ни определений (их пишет разбор). Строка `code_refresh` — постановка.
    expect(countRows(dbPath, "SELECT count(*) AS n FROM code_files")).toBe(0);
    expect(countRows(dbPath, "SELECT count(*) AS n FROM code_defs")).toBe(0);
    expect(
      countRows(dbPath, `SELECT count(*) AS n FROM jobs WHERE kind = '${CODE_INDEX_JOB_KIND}'`),
    ).toBe(0);
    expect(refreshRows(dbPath)).toBe(1);
  });

  test("ни якорей, ни индекса: не строится, и причина названа (мутация 2)", async () => {
    const { dbPath } = await makeWorkspace();
    const rec = recorder();

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });

    expect(r.codeIndex?.spawned).toBe(false);
    expect(r.codeIndex?.anchors).toBe(0);
    expect(r.codeIndex?.reason).toContain("no anchors");
    expect(rec.spawned).toEqual([]);
    expect(refreshRows(dbPath)).toBe(0);
  });

  test("воркер умер: аренда истекла — следующий дренаж забирает ту же работу, попытка засчитана", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 9 * HOUR);
    const rec = recorder();

    await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });
    const later = Date.now() + CODE_REFRESH_LEASE_MS + 1_000;
    const again = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn, now: () => later });

    expect(again.codeIndex?.spawned).toBe(true);
    expect(rec.spawned.length).toBe(2);
    expect(rec.spawned[1]!.job.id).toBe(rec.spawned[0]!.job.id);
    expect(rec.spawned[1]!.job.holder).not.toBe(rec.spawned[0]!.job.holder);
    const driver = openSqlite(dbPath);
    expect(jobs.get(driver.database, rec.spawned[0]!.job.id)!.attempts).toBe(1);
    driver.close();
  });

  test("пять смертей подряд — фон бросает, воркер больше не поднимается, причина названа", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 9 * HOUR);
    const rec = recorder();

    let t = Date.now();
    let last = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn, now: () => t });
    for (let i = 0; i < 6; i++) {
      t += CODE_REFRESH_LEASE_MS + 1_000;
      last = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn, now: () => t });
    }

    expect(rec.spawned.length).toBe(5);
    expect(last.codeIndex?.spawned).toBe(false);
    // Пятая смерть засчитывается уже при взгляде на строку: иначе «4 attempts»
    // при пяти поднятых и умерших воркерах.
    expect(last.codeIndex?.reason).toContain("gave up after 5 attempts (the worker died without a word)");
    const driver = openSqlite(dbPath);
    const job = indexFreshness(driver.database, t, CODE_REFRESH_AFTER_MS).job;
    driver.close();
    expect(job?.state).toBe("failed");
    expect(job?.attempts).toBe(5);
  });

  test("строки code_index в очереди — тоже повод, даже когда индекс свежий", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 60_000);
    const driver = openSqlite(dbPath);
    jobs.enqueue(driver.database, CODE_INDEX_JOB_KIND, { entityId: "src/a.ts", scope: "" });
    driver.close();
    const rec = recorder();

    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });
    expect(r.codeIndex?.triggered).toBe("jobs");
    expect(r.codeIndex?.spawned).toBe(true);
    expect(rec.spawned.length).toBe(1);
  });

  test("чужая аренда code_index (идёт ручной `myc code index`): второго воркера не поднимаем", async () => {
    const { dbPath } = await makeWorkspace();
    seedAnchor(dbPath);
    const driver = openSqlite(dbPath);
    jobs.enqueue(driver.database, CODE_INDEX_JOB_KIND, { entityId: "src/a.ts", scope: "" });
    jobs.claim(driver.database, [CODE_INDEX_JOB_KIND], "сосед", { leaseMs: 60_000 });
    driver.close();

    const rec = recorder();
    const r = await drainQueueTail({ dbPath, env: {}, spawnCodeIndex: rec.spawn });

    expect(r.codeIndex?.spawned).toBe(false);
    expect(r.codeIndex?.reason).toContain("lease");
    expect(rec.spawned).toEqual([]);
  });

  test("MYC_CODE_INDEX=0: шага нет вовсе", async () => {
    const { dbPath } = await makeWorkspace();
    seedIndex(dbPath, Date.now() - 9 * HOUR);
    const rec = recorder();

    const r = await drainQueueTail({
      dbPath,
      env: { MYC_CODE_INDEX: "0" },
      spawnCodeIndex: rec.spawn,
    });

    expect(r.codeIndex).toBeNull();
    expect(rec.spawned).toEqual([]);
    expect(refreshRows(dbPath)).toBe(0);
  });
});
