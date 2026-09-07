/**
 * Приёмка дренажа очереди (S8): после `myc remember` и обычных вызовов CLI
 * очередь уменьшается сама, без ручного `reindex`/`absorb`.
 *
 * Тесты МНОГОПРОЦЕССНЫЕ там, где проверяется гонка: настоящие процессы через
 * Bun.spawn того же main.ts, что в бою. В этом репозитории гонки между
 * процессами дважды давали молчаливую потерю записей (решения S38, S40), и
 * оба раза однопоточный тест этого не видел — параллельный прогон здесь
 * обязателен по постановке задачи.
 *
 * Исполнитель в гоночных тестах — заглушка MYC_DRAIN_FAKE=1 (тот же приём,
 * что MYC_EMBED_FAKE в reindex.test.ts): очередь боевая (claim с арендой,
 * complete/fail), тело работы пишется строкой в MYC_DRAIN_FAKE_LOG. Двойное
 * выполнение видно как повторный id в логе, потеря — как отсутствующий.
 *
 * Мутации, которые эти тесты обязаны ловить (проверяются при сдаче):
 *   1. убрана проверка остатка бюджета (разбор до конца очереди) —
 *      краснеть обязан тест «бюджет прекращает разбор»;
 *   2. embed разбирается инлайн — краснеть обязан тест «embed инлайн не
 *      разбирается» (и латентность любого CLI-вызова с embed в очереди);
 *   3. убрана аренда при захвате — краснеть обязана многопроцессная гонка
 *      (повторные id в логе).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSqliteRuntime,
  jobs,
  migrate,
  migrateVectors,
  migrations,
  openSqlite,
} from "@myc/store-sqlite";
import { drainQueueTail, queueDrainEnabled, drainBudgetFromEnv, DEFAULT_DRAIN_BUDGET_MS } from "./drain.ts";

const VEC0 = ensureSqliteRuntime().vec.loaded;
const CLI_ENTRY = join(import.meta.dir, "main.ts");

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "myc-drain-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Оснастка
// ---------------------------------------------------------------------------

async function makeDb(dbPath: string): Promise<void> {
  const driver = openSqlite(dbPath);
  await migrate(driver.database, { migrations, writable: true });
  if (VEC0) await migrateVectors(driver.database, { vec0Loaded: true, writable: true });
  driver.close();
}

function seedNode(dbPath: string, id: string, text: string): void {
  const driver = openSqlite(dbPath);
  const now = Date.now();
  driver.database
    .prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, created_at, updated_at)
       VALUES (?1, 'note', 1, '', ?2, ?3, ?4, ?5, ?5)`,
    )
    .run(id, text.slice(0, 60), text, `h-${id}`, now);
  driver.close();
}

function seedJob(dbPath: string, kind: string, entityId: string): number {
  const driver = openSqlite(dbPath);
  const r = jobs.enqueue(driver.database, kind, { entityId });
  driver.close();
  return r.id;
}

function countRows(dbPath: string, sql: string): number {
  const driver = openSqlite(dbPath);
  try {
    return Number((driver.database.query(sql).get() as { n: number }).n);
  } finally {
    driver.close();
  }
}

function readyJobs(dbPath: string, kind: string): number {
  return countRows(
    dbPath,
    `SELECT count(*) AS n FROM jobs
      WHERE kind = '${kind}' AND attempts < max_attempts
        AND lease_expires <= ${Date.now()} AND run_after <= ${Date.now()}`,
  );
}

function nodeAttrs(dbPath: string, id: string): Record<string, unknown> {
  const driver = openSqlite(dbPath);
  try {
    const row = driver.database
      .query(`SELECT attrs AS a FROM nodes WHERE id = ?1`)
      .get(id) as { a: string } | null;
    return row === null ? {} : (JSON.parse(row.a) as Record<string, unknown>);
  } finally {
    driver.close();
  }
}

interface LogLine {
  readonly kind: string;
  readonly id: number;
  readonly pid: number;
}

function readLog(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((l) => JSON.parse(l) as LogLine);
}

interface CliOut {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Окружение spawned-процессов. NODE_ENV убирается из наследства намеренно:
 * под `bun test` он равен "test", а это выключает дренаж (queueDrainEnabled) —
 * боевой процесс CLI никогда такого значения не имеет.
 */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, NODE_ENV: "production", ...extra };
  return env;
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliOut> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`таймаут ожидания: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Гейты окружения
// ---------------------------------------------------------------------------

describe("гейты окружения", () => {
  test("queueDrainEnabled: под тестом выключен, MYC_DRAIN=0 выключает, по умолчанию включён", () => {
    expect(queueDrainEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(queueDrainEnabled({ MYC_DRAIN: "0" })).toBe(false);
    expect(queueDrainEnabled({ MYC_DRAIN: "off" })).toBe(false);
    expect(queueDrainEnabled({})).toBe(true);
  });

  test("drainBudgetFromEnv: дефолт 50 мс (§12.2), override из env", () => {
    expect(drainBudgetFromEnv({})).toBe(DEFAULT_DRAIN_BUDGET_MS);
    expect(drainBudgetFromEnv({ MYC_DRAIN_BUDGET_MS: "120" })).toBe(120);
    expect(drainBudgetFromEnv({ MYC_DRAIN_BUDGET_MS: "бред" })).toBe(DEFAULT_DRAIN_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// Бюджет: разбор по остатку времени, а не до конца очереди (мутация 1)
// ---------------------------------------------------------------------------

describe("бюджет дренажа", () => {
  test("разбор прекращается по остатку бюджета, хвост очереди остаётся", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const log = join(dir, "drain.log");
    await makeDb(dbPath);
    const TOTAL = 30;
    for (let i = 0; i < TOTAL; i++) seedJob(dbPath, "absorb", `n${i}`);

    const r = await drainQueueTail({
      dbPath,
      budgetMs: 35,
      env: { MYC_DRAIN_FAKE: "1", MYC_DRAIN_FAKE_LOG: log, MYC_DRAIN_FAKE_DELAY_MS: "5" },
    });

    // 35 мс при 5 мс на работу — несколько работ, но точно не вся очередь.
    expect(r.completed).toBeGreaterThanOrEqual(2);
    expect(r.completed).toBeLessThan(TOTAL);
    expect(r.claimed).toBe(r.completed);
    expect(r.failed).toBe(0);
    // Хвост не потерян: ждёт следующего вызова.
    expect(readyJobs(dbPath, "absorb")).toBe(TOTAL - r.completed);
    expect(readLog(log).length).toBe(r.completed);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Инлайн-исполнители
// ---------------------------------------------------------------------------

describe("инлайн-исполнители", () => {
  test("absorb: работа закрыта, узел размечен классом (lexical без вектора — И2)", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    await makeDb(dbPath);
    seedNode(dbPath, "n1", "дренаж очереди подхватывает следующий вызов CLI");
    seedJob(dbPath, "absorb", "n1");

    const r = await drainQueueTail({ dbPath, budgetMs: 500, env: {} });

    expect(r.completed).toBe(1);
    expect(r.byKind["absorb"]).toBe(1);
    expect(readyJobs(dbPath, "absorb")).toBe(0);
    const absorb = nodeAttrs(dbPath, "n1")["absorb"] as Record<string, unknown> | undefined;
    expect(absorb).toBeDefined();
    expect(absorb!["by"]).toBe("stage-a");
    // Вектора в nodes_vec нет — штатная громкая деградация: класс записан,
    // quality честно lexical, ничего не слито и не выброшено.
    expect(absorb!["quality"]).toBe("lexical");
  }, 15_000);

  test("compact: checkpoint выполнен, работа снята", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    await makeDb(dbPath);
    seedJob(dbPath, "compact", "wal");

    const r = await drainQueueTail({ dbPath, budgetMs: 500, env: {} });

    expect(r.completed).toBe(1);
    expect(countRows(dbPath, `SELECT count(*) AS n FROM jobs WHERE kind = 'compact'`)).toBe(0);
  }, 15_000);

  test("embed инлайн НЕ разбирается: поднимается воркер, работа остаётся в очереди (мутация 2)", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    await makeDb(dbPath);
    seedNode(dbPath, "n1", "узел, ждущий вектора");
    seedJob(dbPath, "embed", "n1");
    const spawned: string[] = [];

    const r = await drainQueueTail({
      dbPath,
      budgetMs: 500,
      env: { MYC_EMBED_FAKE: "1" }, // фейк-модель: привратник наличия модели пройден
      spawnWorker: (p) => spawned.push(p),
    });

    expect(spawned).toEqual([dbPath]);
    expect(r.embedWorkerSpawned).toBe(true);
    expect(r.claimed).toBe(0); // инлайн не взял ничего
    expect(readyJobs(dbPath, "embed")).toBe(1); // работа дожидается воркера

    // Живая аренда на embed — сигнал «разбирается»: второй воркер не плодится.
    const driver = openSqlite(dbPath);
    jobs.claim(driver.database, ["embed"], "someone-else", { leaseMs: 60_000 });
    driver.close();
    const spawned2: string[] = [];
    const r2 = await drainQueueTail({
      dbPath,
      budgetMs: 500,
      env: { MYC_EMBED_FAKE: "1" },
      spawnWorker: (p) => spawned2.push(p),
    });
    expect(spawned2).toEqual([]);
    expect(r2.embedWorkerSpawned).toBe(false);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Гонка: параллельные вызовы CLI не дублируют и не теряют работы (мутация 3)
// ---------------------------------------------------------------------------

describe("гонка процессов", () => {
  test("8 параллельных CLI: 40 работ — ни одной дважды, ни одной потерянной", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const log = join(dir, "drain.log");
    await makeDb(dbPath);
    const TOTAL = 40;
    const ids: number[] = [];
    for (let i = 0; i < TOTAL; i++) ids.push(seedJob(dbPath, "absorb", `n${i}`));

    const env = cliEnv({
      MYC_DRAIN_FAKE: "1",
      MYC_DRAIN_FAKE_LOG: log,
      MYC_DRAIN_FAKE_DELAY_MS: "3",
      MYC_DRAIN_BUDGET_MS: "4000",
    });
    const PROCS = 8;
    const wave = await Promise.all(
      Array.from({ length: PROCS }, () => runCli(["--json", "list", "--db", dbPath], env)),
    );
    for (const [i, out] of wave.entries()) {
      expect(out.code, `процесс ${i}: ${out.stderr}`).toBe(0);
    }

    // Добор хвоста (откаты после fail на гонке — до 1 с): ещё вызовы, пока
    // очередь не сойдёт. Это и есть обещание S8 — хвост подхватывают вызовы.
    for (let i = 0; i < 10 && readyJobs(dbPath, "absorb") > 0; i++) {
      const out = await runCli(["--json", "list", "--db", dbPath], env);
      expect(out.code).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
    }

    const lines = readLog(log);
    const seen = lines.map((l) => l.id);
    // НИ ОДНОЙ работы дважды: аренда делает захват эксклюзивным.
    expect(new Set(seen).size, `повторные выполнения: ${JSON.stringify(lines)}`).toBe(seen.length);
    // НИ ОДНОЙ потерянной: все seeded id выполнены ровно по разу.
    expect([...new Set(seen)].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    // Очередь сошла до конца.
    expect(readyJobs(dbPath, "absorb")).toBe(0);
    expect(countRows(dbPath, `SELECT count(*) AS n FROM jobs WHERE kind = 'absorb'`)).toBe(0);
    // Работу делало больше одного процесса — гонка состоялась, а не прошла мимо.
    expect(new Set(lines.map((l) => l.pid)).size).toBeGreaterThan(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Приёмка e2e: remember → обычные вызовы → очередь пуста, вектор записан
// ---------------------------------------------------------------------------

describe("приёмка S8 end-to-end", () => {
  test("remember + обычные вызовы CLI: очередь разобрана без ручного reindex, recall находит записанное", async () => {
    if (!VEC0) return; // без vec0 векторной записи нет — как в reindex.test.ts
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const embedLog = join(dir, "embed.log");
    await makeDb(dbPath);
    const env = cliEnv({
      MYC_EMBED_FAKE: "1",
      MYC_EMBED_FAKE_LOG: embedLog,
      MYC_DRAIN_BUDGET_MS: "200",
    });

    const fact = "хвост очереди подхватывает следующий вызов командной строки";
    const r1 = await runCli(["--json", "remember", fact, "--db", dbPath], env);
    expect(r1.code, r1.stderr).toBe(0);
    const nodeId = (JSON.parse(r1.stdout) as { data: { id: string } }).data.id;

    // Несколько обычных вызовов CLI — никаких absorb/reindex вручную.
    await waitFor(
      () => readLog(embedLog).length >= 1,
      30_000,
      "фоновый воркер записал вектор",
    );
    for (let i = 0; i < 3; i++) {
      const out = await runCli(["--json", "list", "--db", dbPath], env);
      expect(out.code, out.stderr).toBe(0);
    }
    await waitFor(
      () => countRows(dbPath, `SELECT count(*) AS n FROM jobs`) === 0,
      30_000,
      "очередь разобрана до конца",
    );

    // Вектор записан воркером, absorb исполнен, узел находится recall'ом.
    expect(countRows(dbPath, `SELECT count(*) AS n FROM nodes_vec`)).toBe(1);
    expect(nodeAttrs(dbPath, nodeId)["absorb"]).toBeDefined();
    const r2 = await runCli(["--json", "recall", "очереди", "--db", dbPath], env);
    expect(r2.code, r2.stderr).toBe(0);
    expect(r2.stdout).toContain(nodeId);
  }, 90_000);
});
