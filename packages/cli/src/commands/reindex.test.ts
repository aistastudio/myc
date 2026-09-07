/**
 * Приёмка `myc reindex` — «убитая посреди индексации сборка догоняет без
 * повторной работы». Тесты МНОГОПРОЦЕССНЫЕ: настоящий процесс через
 * Bun.spawn того же main.ts, что в бою, SIGKILL посреди батча, повторный
 * запуск. В этом репозитории гонки между процессами дважды давали молчаливую
 * потерю записей (решения S38, S40), и оба раза однопоточный тест этого не
 * видел — поэтому однопоточного варианта здесь нет и быть не должно.
 *
 * Эмбеддер — детерминированная заглушка (MYC_EMBED_FAKE=1): вектор — функция
 * текста, а каждый вызов пишется строкой в MYC_EMBED_FAKE_LOG. Считая строки
 * лога между прогонами, тест знает ТОЧНО, сколько раз вызывался эмбеддер в
 * каждом процессе, — это и есть измеритель «повторной работы».
 *
 * Мутации, которые эти тесты обязаны ловить (проверяются при сдаче):
 *   1. убран чекпойнт после батча (jobs.complete в транзакции батча);
 *   2. убран пропуск неизменённого по content-hash;
 *   3. отказ при расхождении отпечатка заменён предупреждением.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSqliteRuntime,
  migrate,
  migrateVectors,
  migrations,
  openSqlite,
} from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { REINDEX_BATCH_SIZE, WATCH_DEBOUNCE_MS } from "./reindex.ts";

const VEC0 = ensureSqliteRuntime().vec.loaded;
const CLI_ENTRY = join(import.meta.dir, "..", "main.ts");

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "myc-reindex-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Воркспейс
// ---------------------------------------------------------------------------

async function makeDb(dbPath: string): Promise<void> {
  const driver = openSqlite(dbPath);
  await migrate(driver.database, { migrations, writable: true });
  await migrateVectors(driver.database, { vec0Loaded: true, writable: true });
  driver.close();
}

function seedNodes(
  dbPath: string,
  ids: readonly string[],
  opts: { readonly scope?: string; readonly hashSuffix?: string } = {},
): void {
  const driver = openSqlite(dbPath);
  const ins = driver.database.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, created_at, updated_at)
     VALUES (?1, 'note', 1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  );
  const now = Date.now();
  for (const id of ids) {
    ins.run(
      id,
      opts.scope ?? "",
      `заголовок ${id}`,
      `тело узла ${id}: несколько слов о памяти проекта`,
      `h-${id}-${opts.hashSuffix ?? "v1"}`,
      now,
    );
  }
  driver.close();
}

function countRows(dbPath: string, sql: string): number {
  const driver = openSqlite(dbPath);
  try {
    return Number((driver.database.query(sql).get() as { n: number }).n);
  } finally {
    driver.close();
  }
}

function vecCount(dbPath: string): number {
  return countRows(dbPath, `SELECT count(*) AS n FROM nodes_vec`);
}

function pendingJobs(dbPath: string): number {
  return countRows(dbPath, `SELECT count(*) AS n FROM jobs WHERE kind = 'embed'`);
}

function metaCount(dbPath: string): number {
  const driver = openSqlite(dbPath);
  try {
    const t = driver.database
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='vec_embed_meta'`)
      .get();
    if (t === null) return 0;
    return Number(
      (driver.database.query(`SELECT count(*) AS n FROM vec_embed_meta`).get() as { n: number }).n,
    );
  } finally {
    driver.close();
  }
}

function vecBlobOf(dbPath: string, id: string): Uint8Array | null {
  const driver = openSqlite(dbPath);
  try {
    const row = driver.database
      .query(
        `SELECT v.embedding AS e FROM nodes_vec v
         JOIN nodes n ON n.rowid = v.node_rowid WHERE n.id = ?1`,
      )
      .get(id) as { e: Uint8Array } | null;
    return row?.e ?? null;
  } finally {
    driver.close();
  }
}

function logLines(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? 0 : text.trimEnd().split("\n").length;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`таймаут ожидания: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface CliOut {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function fakeEnv(log: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MYC_EMBED_FAKE: "1",
    MYC_EMBED_FAKE_LOG: log,
    MYC_REINDEX_LEASE_MS: "800",
    ...extra,
  };
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

const range = (n: number): string[] => Array.from({ length: n }, (_, i) => `n${i}`);

// ---------------------------------------------------------------------------
// Приёмка: SIGKILL посреди батча
// ---------------------------------------------------------------------------

describe("myc reindex — убитая сборка догоняет без повторной работы", () => {
  test("SIGKILL посреди второго батча: догон с чекпойнта, без повторов и потерь", async () => {
    if (!VEC0) return; // без vec0 векторной записи нет — как в absorb.test.ts
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const log = join(dir, "embed.log");
    await makeDb(dbPath);
    // 120 узлов = два полных батча по 50 + хвост; задержка 25 мс на вызов —
    // батч ≈ 1.3 с, окно SIGKILL в середине второго батча широкое.
    seedNodes(dbPath, range(120));

    const p1 = Bun.spawn([process.execPath, CLI_ENTRY, "reindex", "--db", dbPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: fakeEnv(log, { MYC_EMBED_FAKE_DELAY_MS: "25" }),
    });
    await waitFor(() => logLines(log) >= 60, 15_000, "первый прогон дошёл до середины батча");
    p1.kill("SIGKILL");
    await p1.exited;
    const linesAfterKill = logLines(log);
    expect(linesAfterKill).toBeGreaterThanOrEqual(60);
    expect(linesAfterKill).toBeLessThan(100); // второй батч НЕ зафиксирован

    // (а) чекпойнт первого батча пережил SIGKILL: ровно 50 узлов записаны.
    expect(metaCount(dbPath)).toBe(50);
    expect(vecCount(dbPath)).toBe(50);

    // Второй прогон — без задержки; аренда брошенного батча (800 мс) при
    // необходимости дожидается внутри дренажа.
    const r2 = await runCli(["--json", "reindex", "--db", dbPath], fakeEnv(log));
    expect(r2.code).toBe(0);

    // (в) ни один узел не потерян.
    expect(vecCount(dbPath)).toBe(120);
    expect(metaCount(dbPath)).toBe(120);
    expect(pendingJobs(dbPath)).toBe(0);

    // (б) повторной работы нет: второй прогон вызвал эмбеддер ровно для
    // незафиксированных 70 узлов. Эмбеддинги недоеденного батча первого
    // прогона (строки 51..kill) НЕ засчитываются как повтор: их транзакция
    // откатилась вместе со смертью процесса.
    const run2Calls = logLines(log) - linesAfterKill;
    expect(run2Calls).toBe(70);

    // (а′) продолжение идёт С ЧЕКПОЙНТА, а не с начала: второй прогон забрал
    // из очереди ровно 70 незакрытых работ. Убранный чекпойнт это ловит даже
    // когда пропуск по хешу замаскировал бы повторные эмбеддинги: работы
    // первого батча остались бы в очереди и были бы захвачены заново.
    const envelope = JSON.parse(r2.stdout) as { data: { claimed: number } };
    expect(envelope.data.claimed).toBe(70);
  }, 60_000);

  test("неизменённое не переэмбеддится; изменённое — один вызов; ветка с тем же текстом копирует", async () => {
    if (!VEC0) return;
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const log = join(dir, "embed.log");
    await makeDb(dbPath);
    seedNodes(dbPath, range(30));

    const r1 = await runCli(["reindex", "--db", dbPath], fakeEnv(log));
    expect(r1.code).toBe(0);
    expect(logLines(log)).toBe(30);
    expect(vecCount(dbPath)).toBe(30);

    // Повторный прогон по неизменённому корпусу: НОЛЬ вызовов эмбеддера.
    const r2 = await runCli(["reindex", "--db", dbPath], fakeEnv(log));
    expect(r2.code).toBe(0);
    expect(logLines(log)).toBe(30);

    // Правка одного узла (текст + content_hash, как делает стор) — ровно
    // один новый вызов.
    {
      const driver = openSqlite(dbPath);
      driver.database
        .query(`UPDATE nodes SET body = 'совсем другой текст', content_hash = 'h-n5-v2' WHERE id = 'n5'`)
        .run();
      driver.close();
    }
    const r3 = await runCli(["reindex", "--db", dbPath], fakeEnv(log));
    expect(r3.code).toBe(0);
    expect(logLines(log)).toBe(31);

    // Другая ветка (scope) с ТЕМ ЖЕ текстом и хешом, что у n7: вектор
    // копируется, эмбеддер не зовётся.
    {
      const driver = openSqlite(dbPath);
      driver.database
        .query(
          `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, created_at, updated_at)
           SELECT 'n7-fork', kind, layer, 'branch-x', title, body, content_hash, ?1, ?1
             FROM nodes WHERE id = 'n7' AND scope = ''`,
        )
        .run(Date.now());
      driver.close();
    }
    const r4 = await runCli(["reindex", "--db", dbPath], fakeEnv(log));
    expect(r4.code).toBe(0);
    expect(logLines(log)).toBe(31);
    const main = vecBlobOf(dbPath, "n7");
    const fork = vecBlobOf(dbPath, "n7-fork");
    expect(main).not.toBeNull();
    expect(fork).not.toBeNull();
    expect(Buffer.from(fork!).equals(Buffer.from(main!))).toBe(true);
  }, 60_000);

  test("расхождение отпечатка — ОТКАЗ (код 5), а не предупреждение; ничего не записано", async () => {
    if (!VEC0) return;
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const log = join(dir, "embed.log");
    await makeDb(dbPath);
    seedNodes(dbPath, range(10));
    {
      const driver = openSqlite(dbPath);
      driver.database
        .query(
          `INSERT INTO myc_meta (key, value) VALUES ('embed_fingerprint', 'local:onnx:other-model:384:l2')`,
        )
        .run();
      driver.close();
    }

    const r = await runCli(["reindex", "--db", dbPath], fakeEnv(log));
    expect(r.code).toBe(ExitCode.PRECOND);
    // Ни один вектор не записан, очередь не расходована, эмбеддер не звался.
    expect(vecCount(dbPath)).toBe(0);
    expect(pendingJobs(dbPath)).toBe(0);
    expect(logLines(log)).toBe(0);
  }, 60_000);

  test("watch: запись в базу будит воркера, новые узлы доэмбеддятся сами", async () => {
    if (!VEC0) return;
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const log = join(dir, "embed.log");
    await makeDb(dbPath);
    seedNodes(dbPath, range(5));

    const proc = Bun.spawn([process.execPath, CLI_ENTRY, "reindex", "--db", dbPath, "--watch"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: fakeEnv(log, {
        MYC_REINDEX_WATCH_DEBOUNCE_MS: "300",
        MYC_REINDEX_WATCH_POLL_MS: "600000",
      }),
    });
    try {
      await waitFor(() => vecCount(dbPath) === 5, 15_000, "первичный прогон watch");
      expect(logLines(log)).toBe(5);

      // Запись из ДРУГОГО процесса (этого теста) — воркер обязан проснуться
      // по событию ФС и доэмбеддить новые узлы без команды.
      seedNodes(dbPath, ["w1", "w2", "w3"]);
      await waitFor(() => vecCount(dbPath) === 8, 15_000, "watch доэмбеддил новые узлы");
      expect(logLines(log)).toBe(8);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 60_000);

  test("константы приёмки: батч 50, дебаунс watch 2 с", () => {
    expect(REINDEX_BATCH_SIZE).toBe(50);
    expect(WATCH_DEBOUNCE_MS).toBe(2_000);
  });
});
