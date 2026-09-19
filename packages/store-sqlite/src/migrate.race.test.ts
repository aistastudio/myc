/**
 * memory-yc7np0eyy2s0: гонка двух миграторов на свежей базе.
 *
 * Сценарий из жизни: два агента стартуют одновременно на свежем воркспейсе,
 * оба процесса открывают одну ещё пустую базу. Оба прочитали пустой
 * schema_migrations, оба решили накатывать с первой миграции; второй ждал
 * write-lock первого и, дождавшись, накатывал миграцию 1 повторно —
 * «table … already exists», мимо регэкспа ретрая /locked|busy/.
 *
 * Инвариант живёт между процессами — поэтому процессы настоящие (Bun.spawn),
 * а не соединения в одном потоке. Проверяется: все N процессов успешны,
 * каждая версия записана ровно один раз, и схема побайтово та же, что у
 * базы, мигрированной одним процессом.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openSqlite } from "./index.ts";
import { COMPAT_MIGRATIONS_TABLE, migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const PROCESSES = 8;
const ROUNDS = 4;

interface Report {
  readonly ok: boolean;
  readonly error?: string;
  readonly applied: readonly number[];
  readonly attempts: number;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-migrate-race-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function schemaOf(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

function versionsOf(path: string): number[] {
  const db = new Database(path, { readonly: true });
  try {
    // Обе таблицы учёта: совместимая миграция (13) лежит не в schema_migrations.
    return (db
      .query(
        `SELECT version FROM schema_migrations UNION ALL SELECT version FROM ${COMPAT_MIGRATIONS_TABLE} ORDER BY version`,
      )
      .all() as Array<{ version: number }>).map((r) => r.version);
  } finally {
    db.close();
  }
}

async function race(dbPath: string, processes: number): Promise<Report[]> {
  const go = `${dbPath}.go`;
  const procs = Array.from({ length: processes }, () =>
    Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "migrate.race.worker.ts"), "--db", dbPath, "--go", go],
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  // Дать всем процессам загрузиться и встать на барьер.
  await Bun.sleep(400);
  writeFileSync(go, "");
  return Promise.all(
    procs.map(async (p) => {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      const line = out.trim().split("\n").at(-1) ?? "";
      try {
        return JSON.parse(line) as Report;
      } catch {
        return { ok: false, error: `exit ${p.exitCode}: ${err.slice(0, 300)}`, applied: [], attempts: 0 };
      }
    }),
  );
}

describe("memory-yc7np0eyy2s0: одновременное первое открытие свежей базы", () => {
  test(`${PROCESSES} процессов × ${ROUNDS} свежих баз: все успешны, каждая версия ровно одна, схема как у одиночного наката`, async () => {
    const reference = join(dir, "reference.db");
    const d = openSqlite(reference);
    await migrate(d.database, { migrations, writable: true });
    d.close();
    const expectedSchema = schemaOf(reference);
    const expectedVersions = migrations.map((m) => m.version).sort((a, b) => a - b);

    const failures: string[] = [];
    let appliedTotal = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const dbPath = join(dir, `fresh-${round}.db`);
      const reports = await race(dbPath, PROCESSES);
      for (const r of reports) {
        if (!r.ok) failures.push(r.error ?? "?");
        appliedTotal += r.applied.length;
      }
      expect(versionsOf(dbPath)).toEqual(expectedVersions);
      expect(schemaOf(dbPath)).toBe(expectedSchema);
    }
    console.log(
      `[migrate race] процессов ${PROCESSES} × баз ${ROUNDS}: отказов ${failures.length}, ` +
        `накатов версий ${appliedTotal} (ожидается ${ROUNDS * expectedVersions.length})` +
        (failures.length > 0 ? `; первый отказ: ${failures[0]}` : ""),
    );
    expect(failures).toEqual([]);
    // Каждая версия накатана ровно одним процессом на базу — не «успели все».
    expect(appliedTotal).toBe(ROUNDS * expectedVersions.length);
  }, 120_000);
});
