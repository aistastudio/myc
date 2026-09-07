import { Database } from "bun:sqlite";
import { Attribution, AttributionError, ensureSwarmSchema } from "./index.ts";

/**
 * Воркер гонки атрибуции. Отдельный процесс, а не поток: инвариант
 * «исход попытки записывает ровно один» живёт МЕЖДУ процессами, и
 * однопоточным тестом он не проверяется (уроки S38/S40).
 *
 * Аргументы: <dbPath> <имя> <attemptId> <retries>
 * Печатает одну строку JSON: {worker, finished, code, started}.
 */

const [dbPath, name, attemptId, retriesRaw] = process.argv.slice(2);

function report(payload: Record<string, unknown>): never {
  process.stdout.write(`${JSON.stringify({ worker: name, ...payload })}\n`);
  process.exit(0);
}

try {
  const db = new Database(dbPath!);
  // busy_timeout обязан идти ПЕРВЫМ: journal_mode=WAL требует эксклюзивной
  // блокировки и без таймаута падает с «database is locked» вместо ожидания
  // (тот же урок, что в roster.race.worker.ts — поймано этой же гонкой).
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSwarmSchema(db);
  const attribution = new Attribution(db);

  // Своя попытка по своей задаче: проверяем, что параллельные записи не
  // теряются. Общая попытка ниже: проверяем, что исход не перетирается.
  const own = attribution.startAttempt({
    taskId: `task-${name}`,
    modelId: "p/race",
    taskClass: "fix:module",
    actor: name!,
  });

  let finished = false;
  let code = "";
  try {
    attribution.finishAttempt(attemptId!, {
      verdict: "accepted",
      retries: Number(retriesRaw),
      note: name!,
      tokensIn: 1_000_000,
      tokensOut: 0,
    });
    finished = true;
  } catch (e) {
    code = e instanceof AttributionError ? e.code : `unexpected:${String(e)}`;
  }
  db.close();
  report({ finished, code, started: own.attemptId });
} catch (e) {
  report({ finished: false, code: `fatal:${String(e)}`, started: null });
}
