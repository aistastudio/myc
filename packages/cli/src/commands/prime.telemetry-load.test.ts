/**
 * ПРИЁМКА P0 «Таблицы swarm_attempt, swarm_signal, swarm_route_decision,
 * приоры» (memory-fxazm220dtsq): сутки нагрузочной записи не влияют на
 * бюджеты основных запросов.
 *
 * Два одинаковых стенда по 50 000 узлов (тот же сид, что в
 * prime.pending-latency.test.ts): на второй после графа вливается СУТОЧНАЯ
 * нагрузка телеметрии по спеке 04 §2.2 — «десятки тысяч строк в сутки»:
 * 20 000 попыток, 60 000 сигналов, 5 000 решений роутера (~85 000 строк),
 * затем ANALYZE, чтобы статистика читала новые таблицы честно.
 *
 * Утверждения:
 *  1. ПЛАН: дайджест не упоминает таблицы swarm_ — телеметрия не входит в
 *     запрос (сторож будущего JOIN: читатель сигналов в горячем пути обязан
 *     покраснеть здесь);
 *  2. БЮДЖЕТ: дайджест на нагруженном стенде внутри подбюджета3 мс и не
 *     дороже чистого стенда в пределах ×1.5 — порог «не влияет с запасом на
 *     шум хоста»: сама телеметрия в запросы не входит, и ×4 и выше означало
 *     бы, что нагрузка начала читаться.
 * Мутация на приёмке: подзапрос count(*) из swarm_signal в текст скана —
 * тест обязан упасть на цене (ratio), а не пройти.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { ensureSwarmSchema } from "@myc/swarm";
import { expectCostAtMost, expectWithinBudget, measure, report } from "@myc/bench";
import { primeQueries } from "./prime.ts";

const N = 50_000;
const SCOPE = "bench";
const OWN = "S-own";
/** Подбюджет дайджеста — тот же, что в prime.pending-latency.test.ts (prime p99 < 30 мс). */
const DIGEST_BUDGET_MS = 3;
/**
 * Потолок «не влияет»: телеметрия не входит в запросы prime, ожидание — ×≈1.
 * 1.5 — «не влияет» с запасом на шум хоста; JOIN на swarm_ в скане обязан
 * стоить кратно и ронять тест (мутация на приёмке).
 */
const LOAD_MAX_COST_RATIO = 1.5;
/** Суточная нагрузка по спеке: «десятки тысяч строк в сутки». */
const ATTEMPTS = 20_000;
const SIGNALS = 60_000;
const ROUTES = 5_000;

type Stand = { dir: string; db: Database };

function build(): Stand {
  const dir = mkdtempSync(join(tmpdir(), "myc-tel-load-"));
  const db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return { dir, db };
}

async function seedGraph(db: Database): Promise<void> {
  await migrate(db, { migrations, writable: true });
  const ins = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        content_hash, acl, team_id, salience, attrs, created_at, updated_at)
     VALUES (?1,'note',?2,?3,?4,?5,?6,2,'active',?7,'team','',0.99,?8,1,1)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    const layer = i < N * 0.05 ? 2 : i < N * 0.4 ? 1 : 0;
    const attrs = i % 40 === 0 ? { reach: "project" } : { reach: "session", session_id: `s${i % 997}` };
    const title = `узел синтетического графа ${i}`;
    ins.run(`n${i}`, layer, SCOPE, title, `тело узла ${i}`, title.slice(0, 120), `h-${i}`,
      JSON.stringify(attrs));
  }
  db.exec("COMMIT");
}

/** Сутки телеметрии: ровно той кардинальности, что декларирует §2.2. */
function seedTelemetry(db: Database): void {
  ensureSwarmSchema(db);
  const model = db.prepare(
    "INSERT INTO swarm_model (model_id, family, version, harness, created_at, updated_at) VALUES ('bench/model','bench','1','claude',1,1)",
  );
  const att = db.prepare(
    `INSERT INTO swarm_attempt (attempt_id, task_id, model_id, harness, task_class, started_at)
     VALUES (?1, ?2, 'bench/model', 'claude', 'do:code', ?3)`,
  );
  const sig = db.prepare(
    `INSERT INTO swarm_signal (signal_id, attempt_id, kind, value, weight, source, observed_at, latency_ms)
     VALUES (?1, ?2, 'tests', 1.0, 1.0, 'hook:ci', ?3, 1000)`,
  );
  const route = db.prepare(
    `INSERT INTO swarm_route_decision (route_id, task_id, at, fingerprint, task_class, profile,
       weights, candidates, chosen_arm, mode, prior_snapshot)
     VALUES (?1, ?2, ?3, 'fp', 'do:code', 'default', '{"q":1,"c":0,"l":0}',
             '[{"arm":"bench/model|medium","propensity":1}]', 'bench/model|medium', 'exploit', 'snap1')`,
  );
  model.run();
  db.exec("BEGIN");
  for (let i = 0; i < ATTEMPTS; i++) att.run(`att_${i}`, `n${i % N}`, 1_000_000 + i);
  for (let i = 0; i < SIGNALS; i++) sig.run(`sig_${i}`, `att_${i % ATTEMPTS}`, 2_000_000 + i);
  for (let i = 0; i < ROUTES; i++) route.run(`rt_${i}`, `n${i % N}`, 3_000_000 + i);
  db.exec("COMMIT");
  db.exec("ANALYZE");
}

const scanSql = primeQueries.prime_digest_scan.sql;
const countSql = primeQueries.prime_pending_count.sql;
const countsSql = primeQueries.prime_reach_counts.sql;
const digest = (db: Database) => () => {
  db.query(scanSql).all(SCOPE, 60, OWN);
  db.query(countsSql).all(SCOPE, OWN);
  db.query(countSql).all(SCOPE, OWN);
};

let clean: Stand;
let loaded: Stand;

beforeAll(async () => {
  clean = build();
  loaded = build();
  await seedGraph(clean.db);
  await seedGraph(loaded.db);
  seedTelemetry(loaded.db);
  clean.db.exec("ANALYZE");
}, 300_000);

afterAll(() => {
  for (const s of [clean, loaded]) {
    if (s === undefined) continue;
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

describe("сутки телеметрии не влияют на бюджет основного запроса", () => {
  test("план дайджеста не упоминает таблицы swarm_", () => {
    const plan = loaded.db
      .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${scanSql}`)
      .all(SCOPE, 60, OWN)
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).not.toContain("swarm_");
  });

  test("дайджест после85 000 строк телеметрии: в подбюджете и не дороже чистого стенда", () => {
    const m = measure(
      `telemetry: дайджест @${N} после суток нагрузки (попытки+сигналы+решения)`,
      digest(loaded.db),
      {
        warmup: 30,
        iters: 100,
        budgetMs: DIGEST_BUDGET_MS,
        rival: digest(clean.db),
        rivalLabel: "тот же дайджест без телеметрии",
      },
    );
    report(m);
    expectWithinBudget(m);
    expectCostAtMost(m, LOAD_MAX_COST_RATIO);
  }, 300_000);
});
