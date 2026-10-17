/**
 * Схема телеметрии на месте (P0 «Таблицы swarm_attempt, swarm_signal,
 * swarm_route_decision, приоры», memory-fxazm220dtsq; спека 04 §2.2).
 *
 * Сторож контракта спеки, а не повтор движения: движок и так обязан
 * показать каждый объект из `objects` (schema.ts), и «один оператор на
 * элемент» держит roster.test.ts. Здесь — то, что спека ОБЕЩАЕТ читателю:
 * шесть объектов016–021, связь сигнала с попыткой, ключ arm по составному
 * ключу и WITHOUT ROWID там, где спека его требует.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSwarmSchema } from "./schema.ts";

const EXPECTED: readonly string[] = [
  "swarm_signal",
  "swarm_signal_attempt",
  "swarm_signal_time",
  "swarm_route_decision",
  "swarm_route_task",
  "swarm_arm",
];

let db: Database;
let dir: string;

function fresh(): void {
  dir = mkdtempSync(join(tmpdir(), "myc-swarm-tel-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
}

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("телеметрия в схеме", () => {
  test("накат016–021 создаёт все объекты спеки", () => {
    fresh();
    ensureSwarmSchema(db);
    const names = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master")
        .all()
        .map((r) => r.name),
    );
    for (const n of EXPECTED) expect(names.has(n)).toBe(true);
  });

  test("сигнал связан с попыткой FK, а приоры — WITHOUT ROWID", () => {
    fresh();
    ensureSwarmSchema(db);
    const fks = db
      .query<{ from: string; table: string }, []>("PRAGMA foreign_key_list(swarm_signal)")
      .all();
    expect(fks.some((f) => f.from === "attempt_id" && f.table === "swarm_attempt")).toBe(true);
    // WITHOUT ROWID: sqlite_master хранит её в sql таблицы.
    const arm = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'swarm_arm'")
      .get();
    expect(arm?.sql).toContain("WITHOUT ROWID");
    // Решение роутера переживает чистку задач: FK на task_id быть не должно.
    const route = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'swarm_route_decision'")
      .get();
    expect(route?.sql).not.toContain("REFERENCES");
  });

  test("повторный накат холостой — набор уже применён", () => {
    fresh();
    ensureSwarmSchema(db);
    expect(() => ensureSwarmSchema(db)).not.toThrow();
  });
});
