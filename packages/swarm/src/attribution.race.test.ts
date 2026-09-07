import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Attribution, ensureSwarmSchema, Roster } from "./index.ts";

/**
 * Настоящая конкурентность: шесть процессов Bun.spawn одновременно
 * закрывают ОДНУ попытку и параллельно открывают свои. Два инварианта,
 * которые однопоточный тест не видит:
 *
 * 1. Исход попытки записывает ровно один процесс. Остальные получают
 *    conflict.finished, а не молча перетирают чужой вердикт — иначе
 *    атрибуция врёт именно там, где рой работает по-настоящему,
 *    параллельно.
 * 2. Параллельные старты не теряются: шесть попыток на месте.
 */

const PROCESSES = 6;
const T0 = Date.parse("2026-09-01T00:00:00Z");

let dir: string;
let dbPath: string;
let attemptId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-attr-race-"));
  dbPath = join(dir, "myc.db");
  // Режим журнала персистентен в файле и переключается под эксклюзивной
  // блокировкой мимо busy-handler: выставляем WAL до старта воркеров,
  // чтобы гонка шла на записи, а не на PRAGMA (как в roster.race.test.ts).
  const setup = new Database(dbPath, { create: true });
  setup.exec("PRAGMA journal_mode = WAL");
  setup.exec("PRAGMA foreign_keys = ON");
  ensureSwarmSchema(setup);
  new Roster(setup, () => T0).addModel({
    modelId: "p/race",
    family: "race",
    harness: "claude",
    price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: T0 },
  });
  attemptId = new Attribution(setup, () => T0).startAttempt({
    taskId: "shared",
    modelId: "p/race",
    taskClass: "fix:module",
  }).attemptId;
  setup.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface WorkerReport {
  worker: string;
  finished: boolean;
  code: string;
  started: string | null;
}

async function runWorker(name: string, retries: number): Promise<{ report: WorkerReport; code: number }> {
  const proc = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "attribution.race.worker.ts"),
      dbPath,
      name,
      attemptId,
      String(retries),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return { report: JSON.parse(line) as WorkerReport, code };
}

describe("гонка исхода (6 процессов Bun.spawn)", () => {
  test("исход записывает ровно один; остальные получают conflict, а не перетирают", async () => {
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, (_, i) => runWorker(`w${i}`, i + 1)),
    );
    expect(results.filter((r) => r.code !== 0)).toEqual([]);

    const winners = results.filter((r) => r.report.finished);
    const losers = results.filter((r) => !r.report.finished);
    expect(winners).toHaveLength(1);
    expect([...new Set(losers.map((l) => l.report.code))]).toEqual(["conflict.finished"]);

    const db = new Database(dbPath, { readonly: true });
    const shared = db
      .query("SELECT verdict, note, retries, cost_usd FROM swarm_attempt WHERE attempt_id = ?1")
      .get(attemptId) as { verdict: string; note: string; retries: number; cost_usd: number };
    // Записан исход победителя целиком, а не смесь из шести.
    expect(shared.verdict).toBe("accepted");
    expect(shared.note).toBe(winners[0]!.report.worker);
    expect(shared.retries).toBe(Number(winners[0]!.report.worker.slice(1)) + 1);
    expect(shared.cost_usd).toBeCloseTo(3, 12);

    // Параллельные старты не потерялись.
    const own = db
      .query("SELECT task_id FROM swarm_attempt WHERE task_id LIKE 'task-%' ORDER BY task_id")
      .all() as Array<{ task_id: string }>;
    expect(own.map((r) => r.task_id)).toEqual(
      Array.from({ length: PROCESSES }, (_, i) => `task-w${i}`),
    );

    const migrations = db
      .query("SELECT version FROM swarm_schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    db.close();
  }, 30_000);
});
