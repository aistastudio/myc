/**
 * Воркер конкурентного прогона ростера (roster.race.test.ts).
 *
 * Запускается отдельным ПРОЦЕССОМ (Bun.spawn): несколько воркеров одновременно
 * открывают одну базу, накатывают схему (гонка миграций — главный риск) и
 * пишут по одной модели. Печатает на stdout одну JSON-строку:
 *   { worker, ok: true } | { worker, ok: false, error: string }
 */

import { Database } from "bun:sqlite";
import { ensureSwarmSchema, Roster } from "./index.ts";

const STORE_PRAGMAS = [
  // busy_timeout обязан идти ПЕРВЫМ: journal_mode=WAL требует эксклюзивной
  // блокировки, и без таймаута конкурентное открытие падает с «database is
  // locked» вместо ожидания (поймано гонкой в roster.race.test.ts).
  "PRAGMA busy_timeout = 10000",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
] as const;

function main(): void {
  const dbPath = process.argv[2];
  const worker = process.argv[3];
  if (dbPath === undefined || worker === undefined) {
    throw new Error("arguments required: <db-path> <worker-name>");
  }
  try {
    const db = new Database(dbPath, { create: true });
    for (const pragma of STORE_PRAGMAS) db.exec(pragma);
    ensureSwarmSchema(db);
    const roster = new Roster(db);
    roster.addModel({
      modelId: `p/model-${worker}`,
      family: "race",
      harness: "kimi",
      price: { usdPerMIn: 1, usdPerMOut: 2, validFrom: Date.now() },
    });
    db.close();
    process.stdout.write(JSON.stringify({ worker, ok: true }) + "\n");
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ worker, ok: false, error: String(e) }) + "\n",
    );
    process.exit(1);
  }
}

main();
