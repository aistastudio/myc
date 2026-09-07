/**
 * Воркер очереди для конкурентных прогонов jobs.test.ts.
 *
 * Запускается ОТДЕЛЬНЫМ ПРОЦЕССОМ (Bun.spawn) против общей базы: инварианты
 * очереди живут между процессами (демона нет, решение S8), и однопоточный тест
 * их не проверяет — дважды это стоило нам молчаливой потери записей (S38, S40).
 *
 * Каждое событие дописывается в общий журнал через appendFileSync — настоящий
 * write(2) без буфера, поэтому то, что попало в файл, пережило бы SIGKILL:
 *   `<ts> <event> <id> <holder> <attempts> <deleted> <lease_expires>`
 *   claim — работа выдана этому процессу (== одно исполнение);
 *   stall — выдана и процесс намеренно завис под живой арендой (жертва);
 *   done  — исполнена; deleted=1, если снятие с очереди прошло по аренде.
 *
 * Дубли считаются по `claim`, а НЕ по `done`: снятие огорожено арендой и
 * молча вернуло бы false у второго исполнителя — то есть спрятало бы ровно тот
 * дефект, ради которого тест написан.
 */

import { appendFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { openSqlite } from "./index.ts";
import * as jobs from "./jobs.ts";

const argv = Bun.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dbPath = get("db");
const logPath = get("log");
const goPath = get("go");
if (dbPath === undefined || logPath === undefined || goPath === undefined) {
  throw new Error("нужны --db PATH --log PATH --go PATH");
}
const holder = get("holder") ?? "w";
const leaseMs = Number(get("lease-ms") ?? 10_000);
const batch = Number(get("batch") ?? 1);
const workMs = Number(get("work-ms") ?? 0);
const stallAt = Number(get("stall-at") ?? 0); // 0 — не зависать
const deadlineMs = Number(get("deadline-ms") ?? 60_000);
const kinds = (get("kinds") ?? "").split(",").filter((s) => s.length > 0);

const driver = openSqlite(dbPath);
const db = driver.database;

const log = (event: string, row: { id: number; attempts: number; lease_expires: number }, deleted = 0): void => {
  appendFileSync(
    logPath,
    `${Date.now()} ${event} ${row.id} ${holder} ${row.attempts} ${deleted} ${row.lease_expires}\n`,
  );
};

// Барьер старта: все процессы выходят на дорожку до первого захвата, иначе
// горка запуска перекашивает конкуренцию и гонки просто не случаются.
const startDeadline = Date.now() + 30_000;
while (!existsSync(goPath)) {
  if (Date.now() > startDeadline) {
    console.error("барьер старта не открыт за 30 с");
    process.exit(1);
  }
  await Bun.sleep(2);
}

let claimed = 0;
let done = 0;
const deadline = Date.now() + deadlineMs;

while (Date.now() < deadline) {
  const rows = jobs.claim(db, kinds, holder, { leaseMs, limit: batch });
  if (rows.length === 0) {
    // Пусто — но очередь могла быть не пуста: чья-то аренда ещё жива (или
    // брошена и ждёт истечения). Выходим, только когда выдавать больше нечего.
    const s = jobs.stats(db);
    if (s.waiting + s.leased === 0) break;
    await Bun.sleep(5);
    continue;
  }
  for (const row of rows) {
    claimed += 1;
    if (stallAt > 0 && claimed === stallAt) {
      log("stall", row);
      // Живая аренда + мёртвый процесс: ровно та ситуация, ради которой
      // существует и предикат lease_expires, и sweep. Ждём SIGKILL.
      for (;;) await Bun.sleep(50);
    }
    log("claim", row);
    if (workMs > 0) await Bun.sleep(workMs);
    const deleted = jobs.complete(db, row.id, holder);
    done += 1;
    log("done", row, deleted ? 1 : 0);
  }
}

driver.close();
console.log(JSON.stringify({ holder, claimed, done }));
