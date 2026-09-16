/**
 * Воркер гонки миграторов (memory-yc7np0eyy2s0): отдельный ПРОЦЕСС открывает
 * базу и накатывает миграции — ровно как CLI и MCP-сервер, которые два агента
 * запускают одновременно на свежем воркспейсе.
 *
 * Повтор — тот же, что у CLI (openWorkspaceAt в packages/cli/src/commands/store.ts):
 * до 50 попыток, и ТОЛЬКО на ошибках, чей текст подходит под /locked|busy/.
 * Всё прочее — отказ. Именно так «table … already exists» проходил мимо
 * регэкспа и ронял второй процесс.
 *
 * Печатает на stdout одну JSON-строку: { ok, error?, applied, attempts }.
 */

import { existsSync } from "node:fs";
import { openSqlite } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const argv = Bun.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const db = get("db");
const go = get("go");
if (db === undefined) throw new Error("--db is required");

// Барьер: все процессы стартуют к одному моменту, иначе гонки нет.
if (go !== undefined) {
  while (!existsSync(go)) await Bun.sleep(1);
}

let applied: readonly number[] = [];
let attempts = 0;
let failure: string | undefined;
for (; attempts < 50; attempts++) {
  try {
    const driver = openSqlite(db);
    try {
      applied = (await migrate(driver.database, { migrations, writable: true })).appliedVersions;
    } finally {
      driver.close();
    }
    failure = undefined;
    break;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failure = msg;
    if (!/locked|busy/i.test(msg)) break;
    await Bun.sleep(20);
  }
}

console.log(
  JSON.stringify(
    failure === undefined
      ? { ok: true, applied, attempts: attempts + 1 }
      : { ok: false, error: failure, applied, attempts: attempts + 1 },
  ),
);
