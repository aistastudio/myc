/**
 * Писатель ДРУГОГО ПРОЦЕССА для cache.test.ts.
 *
 * Приёмка задачи звучит буквально «попадание в кеш не отдаёт устаревших
 * данных после мутации В СОСЕДНЕМ ПРОЦЕССЕ», и однопоточным тестом это не
 * проверяется в принципе: инвариант держится на том, что версия базы
 * читается ИЗ БАЗЫ (`MAX(seq) FROM oplog`), а не из памяти. Кеш,
 * инвалидирующийся только своими же записями, прошёл бы любой in-process
 * тест и молча отдавал бы вчерашнюю выдачу в MCP-сервере, пока рядом
 * пишет one-shot CLI.
 *
 * Пишет узел и операцию оплога в ОДНОЙ транзакции (так же, как это делает
 * настоящая запись: nodes + FTS + oplog атомарно) и печатает на stdout
 * одну JSON-строку: { ok: true, seq } | { ok: false, error }.
 *
 *   bun cache.race.worker.ts <db-path> <node-id> <scope> <title> <body>
 */

import { openSqlite } from "@myc/store-sqlite";

function main(): void {
  const [dbPath, id, scope, title, body] = process.argv.slice(2);
  if (
    dbPath === undefined ||
    id === undefined ||
    scope === undefined ||
    title === undefined ||
    body === undefined
  ) {
    throw new Error("нужны аргументы: <db-path> <node-id> <scope> <title> <body>");
  }
  const driver = openSqlite(dbPath);
  try {
    const now = Date.now();
    driver.database.transaction(() => {
      driver.database
        .query(
          `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                              head_id, content_hash, acl, owner_id, team_id, agent_id,
                              created_at, updated_at)
           VALUES (?1, 'note', 1, ?2, ?3, ?4, ?5, 2, 'active', NULL, ?6, 'team', '', '', '', ?7, ?7)`,
        )
        .run(id, scope, title, body, body.slice(0, 120), `hash-${id}`, now);
      driver.database
        .query(
          `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id,
                              field, value, scope, origin)
           VALUES (?1, 'writer', ?2, ?3, 'writer', 'set', 'node', ?4, 'title', ?5, ?6, 1)`,
        )
        .run(`writer:${now}:${id}`, now * 65_536, now, id, JSON.stringify(title), scope);
    })();
    const seq =
      driver.database.query(`SELECT MAX(seq) AS seq FROM oplog`).get() as { seq: number | null };
    process.stdout.write(`${JSON.stringify({ ok: true, seq: seq.seq })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: String(error) })}\n`,
    );
    process.exitCode = 1;
  } finally {
    driver.close();
  }
}

main();
