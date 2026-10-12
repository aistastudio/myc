/**
 * Важное событие (§9.5): close/claim при sync="auto" ставит строку
 * `jobs(kind='sync')` с задержкой 2 с. Строка — а не обмен внутри команды:
 * сеть никогда не входит в горячем пути, а дедупликация по (kind, entity)
 * держит ровно одну строку на воркспейс.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations, openSqlite } from "@myc/store-sqlite";
import { openDriver, type CliDriver } from "./commands/store.ts";
import { SYNC_EVENT_DELAY_MS, scheduleBackgroundSync, syncPreconditionReason } from "./sync-bg.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Воркспейс с конфигом и мигрированной базой — то, что видит scheduleBackgroundSync. */
async function handle(
  lines: readonly string[] = [],
): Promise<{ driver: CliDriver; scope: string; wsDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "myc-syncbg-"));
  dirs.push(root);
  mkdirSync(join(root, ".myc"));
  writeFileSync(join(root, ".myc", "workspace.toml"), `${lines.join("\n")}\n`);
  const bare = openSqlite(join(root, ".myc", "myc.db"));
  await migrate(bare.database, { migrations, writable: true });
  bare.close();
  const driver = openDriver(join(root, ".myc", "myc.db"), undefined, { extensions: true });
  return { driver, scope: "ws", wsDir: root };
}

function eventRows(driver: CliDriver): { id: number; run_after: number }[] {
  return driver.database
    .query(`SELECT id, run_after FROM jobs WHERE kind = 'sync' ORDER BY id`)
    .all() as { id: number; run_after: number }[];
}

describe("scheduleBackgroundSync", () => {
  test("auto + сервер: строка ставится с задержкой 2 с (мутация-врата режима и срока)", async () => {
    const h = await handle(['slug = "ws"', 'sync = "auto"']);
    const now = 1_000_000;
    expect(scheduleBackgroundSync(h, { MYC_SERVER: "https://s.example/ws" }, now)).toBe(true);
    const rows = eventRows(h.driver);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_after).toBe(now + SYNC_EVENT_DELAY_MS);
  });

  test("manual: строки нет — событие ничего не ставит (мутация-врата режима)", async () => {
    const h = await handle(['slug = "ws"']);
    expect(scheduleBackgroundSync(h, { MYC_SERVER: "https://s.example/ws" }, 1_000_000)).toBe(false);
    expect(eventRows(h.driver)).toHaveLength(0);
  });

  test("auto без сервера в окружении и конфиге: ставить некуда", async () => {
    const h = await handle(['slug = "ws"', 'sync = "auto"']);
    expect(scheduleBackgroundSync(h, {}, 1_000_000)).toBe(false);
    expect(eventRows(h.driver)).toHaveLength(0);
  });

  test("сервер из КОНФИГА репозитория тоже будит событие (мультисерверный режим)", async () => {
    const h = await handle(['slug = "ws"', 'sync = "auto"', 'server = "https://a.example/ws"']);
    expect(scheduleBackgroundSync(h, {}, 1_000_000)).toBe(true);
    expect(eventRows(h.driver)).toHaveLength(1);
  });

  test("две close подряд — одна строка: дедупликация по (kind, entity)", async () => {
    const h = await handle(['slug = "ws"', 'sync = "auto"']);
    const env = { MYC_SERVER: "https://s.example/ws" };
    expect(scheduleBackgroundSync(h, env, 1_000_000)).toBe(true);
    expect(scheduleBackgroundSync(h, env, 1_001_000)).toBe(true);
    expect(eventRows(h.driver)).toHaveLength(1);
  });
});

describe("syncPreconditionReason", () => {
  test("всё на месте — тишина; нет цели или токена — названная причина", async () => {
    const h = await handle(['slug = "ws"']);
    const root = h.wsDir;
    expect(
      syncPreconditionReason(root, { MYC_SERVER: "https://s.example", MYC_TOKEN: "myc_t" }),
    ).toBeNull();
    expect(syncPreconditionReason(root, { MYC_TOKEN: "myc_t" })).toContain("no server");
    expect(syncPreconditionReason(root, { MYC_SERVER: "https://s.example" })).toContain("no token");
    // Токен файла репозитория заменяет профильный.
    writeFileSync(join(root, ".myc", "token"), "myc_file\n");
    expect(syncPreconditionReason(root, { MYC_SERVER: "https://s.example" })).toBeNull();
  });
});
