/**
 * И1: фильтр кандидатов на подтверждение (§6.2, memory-7j8zgjnd0bjz) и его
 * счётчик не имеют права сломать бюджет `prime` — p99 30 мс.
 *
 * Исполняется ТОТ ЖЕ текст запросов, что в команде (`primeQueries`), —
 * замер своей копии SQL относился бы к копии.
 *
 * Индекса под `attrs.state` нет, и это решение, а не недосмотр: терм
 * проверяется по строке, которую скан дайджеста читает всё равно (ради
 * title/excerpt), а термы охвата покрыты ix_nodes_prime_reach и считаются
 * ДО похода в строку. Этот тест и есть проверка того, что так и осталось.
 *
 * Два стенда по 100 000 узлов, 5 % — L2/L3, из них 2 % — кандидаты СВОЕЙ
 * сессии с salience 1: они стоят в голове окна скана, и фильтр обязан их
 * перешагнуть (худший случай для фильтра; хук пишет salience 0).
 *
 *   A. 97 % L2/L3 — чужие сессии (стенд S58). Здесь видна цена потери порядка
 *      «сначала охват по индексу, потом строка»: отсеянное чужое пришлось бы
 *      читать из таблицы. На нём — относительные утверждения.
 *   B. всё L2/L3 видно (проектный охват) — худший случай для счётчика: строку
 *      читает каждый видимый узел. На нём — абсолютный бюджет.
 *
 * Утверждения, по убыванию силы: план (индекс, без SCAN nodes) и реальность
 * отсева; отношение к той же операции без фильтра; абсолютный бюджет при
 * годных условиях замера (@myc/bench).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { liveStatusPredicate, notPendingClause } from "@myc/retrieval";
import { expectCostAtMost, expectWithinBudget, measure, report } from "@myc/bench";
import { primeQueries } from "./prime.ts";

const N = 100_000;
const SCOPE = "bench";
const OWN = "S-own";
const PRIME_BUDGET_MS = 30;
/** Тот же подбюджет дайджеста, что в prime.reach-latency.test.ts. */
const DIGEST_BUDGET_MS = 3;
/**
 * Потолок цены фильтра в СКАНЕ дайджеста против того же скана без терма.
 * Измерено на стенде A: ×1.08 / ×1.09 (0.61 против 0.56 мс p50, машина
 * свободна). Порог 1.5: терм, который начал бы читать строку у каждой
 * отсеянной охватом записи (97 % окна), стоил бы кратно — ×4.4 разделяет
 * «из индекса» и «из строки» в соседнем замере S58.
 */
const SCAN_MAX_COST_RATIO = 1.5;
/**
 * Потолок цены СЧЁТЧИКА кандидатов против prime_reach_counts (тот живёт
 * одним индексом). Измерено на стенде A: ×0.78 (0.40 против 0.52 мс) —
 * счётчик читает строку только у прошедших охват. МУТАЦИЯ «счётчик без терма
 * охвата» читает строку у всех 5 000 L2/L3 и даёт ×4.7. Порог 2.0 между ними.
 */
const COUNT_MAX_COST_RATIO = 2.0;

type Stand = { dir: string; db: Database };

async function build(visible: "foreign97" | "all"): Promise<Stand> {
  const dir = mkdtempSync(join(tmpdir(), "myc-pending-lat-"));
  const db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });
  const ins = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        content_hash, acl, team_id, salience, attrs, created_at, updated_at)
     VALUES (?1,'note',?2,?3,?4,?5,?6,2,'active',?7,'team','',?8,?9,1,1)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    const layer = i < N * 0.002 ? 3 : i < N * 0.05 ? 2 : i < N * 0.4 ? 1 : 0;
    const pending = layer >= 2 && i % 50 === 7;
    const attrs = pending
      ? { state: "pending_review", extracted_by: "precompact", episode_id: `ep${i % 7}`, reach: "session", session_id: OWN }
      : visible === "all" || i % 40 === 0
        ? { reach: "project" }
        : { reach: "session", session_id: `s${i % 997}` };
    const title = `узел синтетического графа ${i}`;
    ins.run(`n${i}`, layer, SCOPE, title, `тело узла ${i}`, title.slice(0, 120), `h-${i}`,
      pending ? 1 : 0.99 - (i % 100) / 100, JSON.stringify(attrs));
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
  return { dir, db };
}

const scanSql = primeQueries.prime_digest_scan.sql;
const scanNoFilter = scanSql.replace(notPendingClause("nodes"), "");
/**
 * Тот же скан без терма скрываемых статусов (memory-0p3d8n1efwtv) — соперник
 * для цены этого терма. Он ложится на ту же уже прочитанную строку, что и
 * терм кандидатов, поэтому потолок — тот же SCAN_MAX_COST_RATIO.
 */
const scanNoStatus = scanSql.replace(`\n             AND ${liveStatusPredicate("nodes")}`, "");
const countSql = primeQueries.prime_pending_count.sql;
const countsSql = primeQueries.prime_reach_counts.sql;

let A: Stand;
let B: Stand;

beforeAll(async () => {
  A = await build("foreign97");
  B = await build("all");
  // Лимит хука — потолок «зациклилось», а не бюджет: стенды под нагрузкой
  // строятся секунды (см. prime.reach-latency.test.ts).
}, 240_000);

afterAll(() => {
  for (const s of [A, B]) {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

describe("структура", () => {
  test("мутант собран: снятый терм действительно убран из текста", () => {
    expect(scanNoFilter).not.toBe(scanSql);
  });

  test("скан и счётчик идут по ix_nodes_prime_reach, таблицу не сканируют", () => {
    for (const [sql, args] of [
      [scanSql, [SCOPE, 60, OWN]],
      [countSql, [SCOPE, OWN]],
    ] as const) {
      const plan = A.db
        .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...args)
        .map((r) => r.detail);
      expect(plan.join(" | ")).toMatch(/USING INDEX ix_nodes_prime_reach/);
      expect(plan.filter((d) => /SCAN nodes/.test(d))).toEqual([]);
    }
  });

  test("фильтр реально отсеивает: без терма окно занимают кандидаты", () => {
    for (const s of [A, B]) {
      const pendingIds = new Set(
        s.db
          .query<{ id: string }, []>("SELECT id FROM nodes WHERE json_extract(attrs,'$.state')='pending_review'")
          .all()
          .map((r) => r.id),
      );
      const healthy = s.db.query<{ id: string }, [string, number, string]>(scanSql).all(SCOPE, 60, OWN);
      const mutant = s.db.query<{ id: string }, [string, number, string]>(scanNoFilter).all(SCOPE, 60, OWN);
      expect(healthy.length).toBe(60);
      expect(healthy.filter((r) => pendingIds.has(r.id))).toEqual([]);
      // Кандидаты стоят в голове своего слоя: без терма они в окне.
      expect(mutant.filter((r) => pendingIds.has(r.id)).length).toBeGreaterThan(0);
      const n = s.db.query<{ n: number }, [string, string]>(countSql).get(SCOPE, OWN)!.n;
      expect(n).toBe(pendingIds.size);
    }
  });
});

describe("терм скрываемых статусов (memory-0p3d8n1efwtv)", () => {
  test("мутант собран, и план скана с термом и без него один и тот же", () => {
    expect(scanNoStatus).not.toBe(scanSql);
    const planOf = (sql: string): string[] =>
      A.db
        .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(SCOPE, 60, OWN)
        .map((r) => r.detail);
    expect(planOf(scanSql)).toEqual(planOf(scanNoStatus));
  });

  test("A: цена терма статуса в скане — против того же скана без него", () => {
    const q = A.db.query(scanSql);
    const q0 = A.db.query(scanNoStatus);
    const m = measure(
      `status: скан дайджеста @${N}, 97% чужих`,
      () => { q.all(SCOPE, 60, OWN); },
      { warmup: 30, iters: 100, rival: () => { q0.all(SCOPE, 60, OWN); }, rivalLabel: "тот же скан без терма status" },
    );
    report(m);
    expectCostAtMost(m, SCAN_MAX_COST_RATIO);
  }, 120_000);

  test("B, видно всё: цена терма статуса в скане", () => {
    const q = B.db.query(scanSql);
    const q0 = B.db.query(scanNoStatus);
    const m = measure(
      `status: скан дайджеста @${N}, всё L2/L3 видно`,
      () => { q.all(SCOPE, 60, OWN); },
      { warmup: 30, iters: 100, rival: () => { q0.all(SCOPE, 60, OWN); }, rivalLabel: "тот же скан без терма status" },
    );
    report(m);
    expectCostAtMost(m, SCAN_MAX_COST_RATIO);
  }, 120_000);
});

describe(`бюджет (И1, prime p99 ${PRIME_BUDGET_MS} мс)`, () => {
  test("A, 97 % чужих сессий: скан с фильтром против того же скана без терма", () => {
    const q = A.db.query(scanSql);
    const q0 = A.db.query(scanNoFilter);
    const m = measure(
      `pending: скан дайджеста @${N}, 97% чужих, 2% своих кандидатов в голове окна`,
      () => { q.all(SCOPE, 60, OWN); },
      { warmup: 30, iters: 100, rival: () => { q0.all(SCOPE, 60, OWN); }, rivalLabel: "тот же скан без терма state" },
    );
    report(m);
    expectCostAtMost(m, SCAN_MAX_COST_RATIO);
  }, 120_000);

  test("A: счётчик кандидатов против prime_reach_counts", () => {
    const c = A.db.query(countSql);
    const r = A.db.query(countsSql);
    const m = measure(
      `pending: счётчик кандидатов @${N}, 97% чужих`,
      () => { c.all(SCOPE, OWN); },
      { warmup: 30, iters: 100, rival: () => { r.all(SCOPE, OWN); }, rivalLabel: "prime_reach_counts (одним индексом)" },
    );
    report(m);
    expectCostAtMost(m, COUNT_MAX_COST_RATIO);
  }, 120_000);

  test("B, видно всё: дайджест целиком (скан + счётчики охвата + кандидаты) в подбюджете", () => {
    const q = B.db.query(scanSql);
    const r = B.db.query(countsSql);
    const c = B.db.query(countSql);
    const q0 = B.db.query(scanNoFilter);
    const m = measure(
      `pending: дайджест @${N}, всё L2/L3 видно`,
      () => { q.all(SCOPE, 60, OWN); r.all(SCOPE, OWN); c.all(SCOPE, OWN); },
      {
        warmup: 30,
        iters: 100,
        budgetMs: DIGEST_BUDGET_MS,
        rival: () => { q0.all(SCOPE, 60, OWN); r.all(SCOPE, OWN); },
        rivalLabel: "дайджест до фильтра: скан без терма + счётчики охвата",
      },
    );
    report(m);
    expectWithinBudget(m);
    expect(DIGEST_BUDGET_MS).toBeLessThan(PRIME_BUDGET_MS);
  }, 120_000);
});
