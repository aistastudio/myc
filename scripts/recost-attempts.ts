/**
 * Пересчёт замороженной стоимости попыток, посчитанных по НУЛЕВОЙ цене
 * кеша (memory-501fa4jp7xpw).
 *
 * Стоимость попытки замораживается на finish и по построению не
 * пересчитывается: иначе правка прайса задним числом меняла бы исход уже
 * закрытых задач. Этот скрипт — не обход инварианта, а разовое исправление
 * ОШИБКИ ВВОДА: строка цены была записана без ставок кеша, счёт по ней
 * занижен в разы и занижен неравномерно. Поэтому:
 *
 * - пересчёт идёт по ТОЙ ЖЕ строке цены (attempt.price_valid_from), а не
 *   по текущей — «цена на момент попытки» остаётся в силе;
 * - трогаются только попытки, где кеш-токены ненулевые, а сама попытка
 *   посчитана (cost_basis='priced'), — остальные не меняются;
 * - по умолчанию сухой прогон: пишет только --apply.
 *
 *   bun run scripts/recost-attempts.ts [--db <path>] [-C <dir>] [--apply]
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

interface Row {
  attempt_id: string;
  task_id: string;
  model_id: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number;
  usd_per_m_in: number;
  usd_per_m_out: number;
  usd_per_m_cache_read: number;
  usd_per_m_cache_write: number;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

if (import.meta.main) {
  const dir = resolve(flag("C") ?? process.cwd());
  const dbPath = flag("db") ?? join(dir, ".myc", "myc.db");
  if (!existsSync(dbPath)) {
    process.stderr.write(`нет базы: ${dbPath}\n`);
    process.exit(7);
  }
  const apply = process.argv.includes("--apply");
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");

  const rows = db
    .query(
      `SELECT a.attempt_id, a.task_id, a.model_id, a.tokens_in, a.tokens_out,
              a.tokens_cache_read, a.tokens_cache_write, a.cost_usd,
              p.usd_per_m_in, p.usd_per_m_out,
              p.usd_per_m_cache_read, p.usd_per_m_cache_write
         FROM swarm_attempt a
         JOIN swarm_model_price p
           ON p.model_id = a.model_id AND p.valid_from = a.price_valid_from
        WHERE a.cost_basis = 'priced'
          AND a.tokens_cache_read + a.tokens_cache_write > 0
        ORDER BY a.started_at`,
    )
    .all() as Row[];

  let was = 0;
  let now = 0;
  const changed: Array<{ id: string; from: number; to: number }> = [];
  for (const r of rows) {
    const fresh =
      (r.tokens_in * r.usd_per_m_in +
        r.tokens_out * r.usd_per_m_out +
        r.tokens_cache_read * r.usd_per_m_cache_read +
        r.tokens_cache_write * r.usd_per_m_cache_write) /
      1e6;
    was += r.cost_usd;
    now += fresh;
    const delta = Math.abs(fresh - r.cost_usd);
    const mark = delta > 1e-9 ? "→" : " ";
    process.stdout.write(
      `${mark} ${r.attempt_id}  ${r.task_id.padEnd(22)} ${r.model_id.padEnd(10)} ` +
        `${usd(r.cost_usd)} → ${usd(fresh)}  ×${(fresh / (r.cost_usd || fresh)).toFixed(1)}\n`,
    );
    if (delta > 1e-9) changed.push({ id: r.attempt_id, from: r.cost_usd, to: fresh });
  }
  process.stdout.write(
    `\nпопыток ${rows.length}, к правке ${changed.length}; ` +
      `итого ${usd(was)} → ${usd(now)} (×${was === 0 ? 0 : (now / was).toFixed(1)})\n`,
  );

  if (!apply) {
    process.stdout.write("сухой прогон: ничего не записано, повторите с --apply\n");
    db.close();
    process.exit(0);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = db.query("UPDATE swarm_attempt SET cost_usd = ?1 WHERE attempt_id = ?2");
    for (const c of changed) stmt.run(c.to, c.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  process.stdout.write(`записано: ${changed.length} попыток\n`);
  db.close();
}
