import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { swarmMigrations } from "./index.ts";

/**
 * Настоящая конкурентность: инвариант «миграции накатываются ровно один раз,
 * записи не теряются» живёт МЕЖДУ процессами и однопоточным тестом не
 * проверяется (уроки S38/S40). Здесь 6 процессов Bun.spawn одновременно
 * открывают свежую базу, каждый накатывает схему и пишет свою модель.
 */

const PROCESSES = 6;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-swarm-race-"));
  dbPath = join(dir, "myc.db");
  // journal_mode переключается под эксклюзивной блокировкой мимо busy-handler:
  // шесть процессов, одновременно делающих PRAGMA journal_mode=WAL на свежем
  // файле, падают с «database is locked» немедленно. Режим журнала персистентен
  // в файле, поэтому WAL выставляет родитель до старта — гонка воркеров идёт
  // на накат схемы и записи, а не на переключение журнала.
  const setup = new Database(dbPath, { create: true });
  setup.exec("PRAGMA journal_mode = WAL");
  setup.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface WorkerReport {
  worker: string;
  ok: boolean;
  error?: string;
}

async function runWorker(name: string): Promise<{ report: WorkerReport; code: number }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "roster.race.worker.ts"), dbPath, name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return { report: JSON.parse(line) as WorkerReport, code };
}

describe("гонка миграций и записей (6 процессов Bun.spawn)", () => {
  test("все процессы успешны, все модели на месте, учёт миграций без дублей", async () => {
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, (_, i) => runWorker(`w${i}`)),
    );

    const failures = results.filter((r) => r.code !== 0 || !r.report.ok);
    expect(failures.map((f) => f.report.error ?? `exit ${f.code}`)).toEqual([]);

    const db = new Database(dbPath, { readonly: true });
    const models = db
      .query("SELECT model_id FROM swarm_model ORDER BY model_id")
      .all() as Array<{ model_id: string }>;
    expect(models.map((m) => m.model_id)).toEqual(
      Array.from({ length: PROCESSES }, (_, i) => `p/model-w${i}`),
    );

    const migrations = db
      .query("SELECT version FROM swarm_schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    // Список версий берётся из набора, а не переписывается руками на
    // каждую миграцию: проверяется «применены все и ровно по разу», а не
    // конкретное их число.
    expect(migrations.map((m) => m.version)).toEqual(
      [...swarmMigrations].map((m) => m.version).sort((a, b) => a - b),
    );

    const prices = db
      .query("SELECT count(*) AS n FROM swarm_model_price")
      .get() as { n: number };
    expect(prices.n).toBe(PROCESSES);
    db.close();
  }, 30_000);
});
