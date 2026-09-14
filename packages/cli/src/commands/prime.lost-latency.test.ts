/**
 * И1: фильтр знания с потерянным кодом (§7.3, memory-d81a4d4hn8ef) и его
 * счётчик не имеют права сломать бюджет `prime` — p99 30 мс.
 *
 * Исполняется ТОТ ЖЕ текст запросов, что в команде (`primeQueries`).
 *
 * Терм «все якоря lost» — коррелированный подзапрос (поиск по edges и anchors,
 * ~1 мкс на строку), а скан дайджеста сортирует каждую группу слоя ЦЕЛИКОМ:
 * порядок (layer DESC, salience DESC) индекс (layer ASC, salience DESC) не
 * даёт. Прямой терм во WHERE считался бы на каждой строке нужных групп, а там,
 * где L3 меньше окна (живая база: L3 39, L2 48), это вся L2. Поэтому терм
 * стоит снаружи сопрограммы, сортирующей только rowid, и считается лишь на
 * строках, дошедших до окна; счётчик идёт от потерянных якорей, а не от всех
 * L2/L3. Этот тест — проверка, что так и осталось.
 *
 * Два стенда по 100 000 узлов (5 % — L2/L3, всё видно, ~2 ребра на узел),
 * якорь у каждого пятого L2/L3 и каждого двадцатого L1, из них каждый седьмой
 * lost; 2 % L2/L3 с потерянным кодом и salience 1 — в голове окна (фильтр
 * обязан их перешагнуть), 2 % — кандидаты своей сессии (как в стенде
 * prime.pending-latency.test.ts):
 *
 *   B. L3 200 — окно заполняет группа L3 (как в стендах соседних тестов);
 *   C. L3 40  — окно добирает из группы L2 целиком (4 960 строк): худший
 *      случай для любого терма во внутреннем WHERE.
 *
 * Утверждения, по убыванию силы: план и реальность отсева (окно = оракулу,
 * счёт = счёту от узлов); отношения, измеренные чередуясь; абсолютный бюджет
 * при годных условиях замера (@myc/bench).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { historyClause, reachClause, reachColumns } from "@myc/core";
import { anchorsAlivePredicate, anchorsAllLostSql, liveStatusPredicate, notPendingClause } from "@myc/retrieval";
import { expectAheadOfRival, expectCostAtMost, expectWithinBudget, measure, report } from "@myc/bench";
import { primeQueries } from "./prime.ts";

const N = 100_000;
const SCOPE = "bench";
const OWN = "S-own";
const WINDOW = 60;
const PRIME_BUDGET_MS = 30;
/**
 * Подбюджет СКАНА С ТЕРМОМ и прежних счётчиков (охват + кандидаты) на стенде
 * B — тот же 3 мс, что в prime.pending-latency/reach-latency: новый терм
 * обязан в него уложиться сам.
 */
const DIGEST_BUDGET_MS = 3;
/**
 * Потолок ДАЙДЖЕСТА ЦЕЛИКОМ, со счётчиком потерянных, — половина бюджета
 * prime: вторая половина остаётся открытию, ready, in_progress и сборке
 * (prime с попаданием в кеш стоит ~3 мс на этих стендах). Трёх миллисекунд
 * здесь нет: счётчик — ~2–4 мкс на каждый lost-якорь базы (две трети из ~490
 * lost тут у L1, как и в живой базе: 32 из 43 якорей — у L1), и на стенде B
 * он добавляет ~2 мс. На C трёх нет и ДО этой задачи: окно добирается из L2
 * целиком, и скан читает строку каждой из 4 960 (терм кандидатов и статусов)
 * — дайджест без якорей уже 5.0 мс p50 / 5.7 p99. Замер 2026-09-14 (load1 7):
 * B 4.4 / 5.3 мс, C 7.5 / 9.0 мс (p50 / p99); `myc prime` целиком при промахе
 * кеша — B 5→7 мс p50, C 7→10 мс p50. Треть prime (10 мс) оставляла C запас
 * ×1.1 — абсолют мигал бы, а регрессию здесь ловят отношения выше.
 */
const DIGEST_FULL_BUDGET_MS = PRIME_BUDGET_MS / 2;
/**
 * Потолок цены терма в скане против того же скана без него — тот же 1.5, что
 * у термов кандидатов и статусов. Измерено: B ×1.31, C ×1.12. Прямой терм во
 * внутреннем WHERE: B ×1.77, C ×3.14 — порог их разделяет.
 */
const SCAN_MAX_COST_RATIO = 1.5;
/**
 * Сопрограмма обязана опережать прямой терм на C: измерено ×1.69–2.4 по
 * прогонам; мутация «терм во внутренний WHERE» делает их одним запросом (×1.0).
 */
const SCAN_MIN_LEAD_OVER_DIRECT = 1.3;
/**
 * Потолок цены счётчика против prime_pending_count (соседний счётчик того же
 * дайджеста). Измерено ×1.52–1.56 от якорей; счёт от всех видимых L2/L3
 * (мутация) — ×4.2: порог между ними.
 */
const COUNT_MAX_COST_RATIO = 2.5;
/** Счёт от якорей обязан опережать счёт от узлов на B: измерено ×2.65. */
const COUNT_MIN_LEAD_OVER_NODES = 2.0;

type Stand = { dir: string; db: Database; l3: number };

async function build(l3: number): Promise<Stand> {
  const dir = mkdtempSync(join(tmpdir(), "myc-lost-lat-"));
  const db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });
  const ins = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        content_hash, acl, team_id, salience, attrs, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,2,?8,?9,'team','',?10,?11,1,1)`,
  );
  const insA = db.prepare(
    `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash, crux, crux_norm,
                          state, drift, bound_at, checked_at)
     VALUES (?1, '', ?2, 1, 5, 'h', 'h', ?3, ?3, ?4, 1.0, 1, ?5)`,
  );
  const insE = db.prepare(
    `INSERT OR IGNORE INTO edges (src, type, dst, weight, add_tag, created_at) VALUES (?1, ?2, ?3, 1.0, ?4, 1)`,
  );
  const layerOf = (i: number): number => (i < l3 ? 3 : i < N * 0.05 ? 2 : i < N * 0.4 ? 1 : 0);
  const lostHead = (i: number): boolean => layerOf(i) >= 2 && i % 50 === 11;
  const crux = "export function fuse(a: number[], b: number[]): number[] { return a.concat(b) }";
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    const layer = layerOf(i);
    const pending = layer >= 2 && i % 50 === 7;
    const attrs = pending
      ? { state: "pending_review", episode_id: `ep${i % 7}`, reach: "session", session_id: OWN }
      : { reach: "project" };
    const title = `узел синтетического графа ${i}`;
    ins.run(`n${i}`, "note", layer, SCOPE, title, `тело узла ${i}`, title, "active", `h-${i}`,
      pending || lostHead(i) ? 1 : 0.99 - (i % 100) / 100, JSON.stringify(attrs));
    // Граф вокруг: ребро touches ищется в ТОЙ ЖЕ таблице edges, что и все
    // остальные рёбра, и цена поиска — это глубина её дерева, а не число якорей.
    insE.run(`n${i}`, "relates", `n${(i * 7 + 13) % N}`, `r${i}`);
    insE.run(`n${i}`, "mentions", `n${(i * 11 + 29) % N}`, `m${i}`);
  }
  for (let i = 0; i < N * 0.4; i++) {
    const layer = layerOf(i);
    if (!(lostHead(i) || (layer >= 2 ? i % 5 === 0 : i % 20 === 0))) continue;
    const a = `a${i}`;
    const state = lostHead(i) || i % 7 === 0 ? "lost" : "fresh";
    ins.run(a, "anchor", 1, SCOPE, `src/f${i}.ts:1-5`, crux, "", state, `h-${a}`, 0.5, "{}");
    insA.run(a, `src/f${i}.ts`, crux, state, i);
    insE.run(`n${i}`, "touches", a, `t${i}`);
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
  return { dir, db, l3 };
}

const scanSql = primeQueries.prime_digest_scan.sql;
/** Тот же скан без терма якорей — соперник для цены терма. */
const scanNoLost = scanSql.replace(`\n           WHERE ${anchorsAlivePredicate("n")}`, "");
/**
 * Прямой терм во внутреннем WHERE под ORDER BY — ОРАКУЛ окна (порядок в нём
 * задан явно) и соперник: так выглядит «терм вернулся в общий WHERE».
 */
const scanDirect = `SELECT nodes.id, nodes.layer, nodes.title, nodes.excerpt, nodes.updated_at, ${reachColumns("nodes")}
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 3)}${notPendingClause("nodes")}
             AND ${liveStatusPredicate("nodes")} AND ${anchorsAlivePredicate("nodes")}
           ORDER BY nodes.layer DESC, nodes.salience DESC LIMIT ?2`;
const lostSql = primeQueries.prime_lost_count.sql;
/** Счёт от всех видимых L2/L3 — соперник счётчика от якорей и его оракул. */
const lostFromNodes = `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 2)}${notPendingClause("nodes")}
             AND ${liveStatusPredicate("nodes")} AND ${anchorsAllLostSql("nodes")} = 1`;
const countsSql = primeQueries.prime_reach_counts.sql;
const pendingSql = primeQueries.prime_pending_count.sql;

let B: Stand;
let C: Stand;

beforeAll(async () => {
  B = await build(200);
  C = await build(40);
  // Лимит хука — потолок «зациклилось», а не бюджет (см. prime.reach-latency.test.ts).
}, 240_000);

afterAll(() => {
  for (const s of [B, C]) {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

const isLostHead = (id: string): boolean => Number(id.slice(1)) % 50 === 11;

describe("структура", () => {
  test("мутант собран: снятый терм действительно убран из текста", () => {
    expect(scanNoLost).not.toBe(scanSql);
    expect(scanNoLost).not.toContain("min(an.state");
  });

  test("скан: сортировка по индексу в сопрограмме, терм — снаружи, после окна; скана таблицы нет", () => {
    for (const s of [B, C]) {
      const plan = s.db
        .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${scanSql}`)
        .all(SCOPE, WINDOW, OWN)
        .map((r) => r.detail);
      const at = (re: RegExp): number => plan.findIndex((d) => re.test(d));
      expect(at(/^CO-ROUTINE w$/)).toBeGreaterThanOrEqual(0);
      expect(at(/SEARCH nodes USING INDEX ix_nodes_prime_reach/)).toBeGreaterThan(at(/^CO-ROUTINE w$/));
      expect(at(/^SCAN w$/)).toBeGreaterThan(at(/SEARCH nodes USING INDEX ix_nodes_prime_reach/));
      expect(plan.some((d) => /SEARCH n USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(d))).toBe(true);
      // Подзапрос якорей — во внешнем цикле, то есть ПОСЛЕ сортировки.
      expect(at(/CORRELATED SCALAR SUBQUERY/)).toBeGreaterThan(at(/^SCAN w$/));
      expect(plan.filter((d) => /SCAN nodes/.test(d))).toEqual([]);
    }
  });

  test("счётчик: от lost-якорей по ix_anchors_check и ix_edges_dst, узлы — по ключу; от всех L2/L3 не идёт", () => {
    for (const s of [B, C]) {
      const plan = s.db
        .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${lostSql}`)
        .all(SCOPE, OWN)
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toMatch(/SEARCH an USING (COVERING )?INDEX ix_anchors_check \(state=\?\)/);
      expect(plan).toMatch(/SEARCH t USING (COVERING )?INDEX ix_edges_dst \(dst=\? AND type=\?\)/);
      expect(plan).toMatch(/SEARCH nodes USING INDEX sqlite_autoindex_nodes_1 \(id=\?\)/);
      expect(plan).not.toMatch(/ix_nodes_prime/);
      expect(plan).not.toMatch(/SCAN (nodes|anchors|edges|an|t)\b/);
    }
  });

  test("отсев реален: без терма окно берут потерянные; с термом — нет, и окно = оракулу", () => {
    for (const s of [B, C]) {
      const healthy = s.db.query<{ id: string; layer: number }, [string, number, string]>(scanSql).all(SCOPE, WINDOW, OWN);
      const mutant = s.db.query<{ id: string }, [string, number, string]>(scanNoLost).all(SCOPE, WINDOW, OWN);
      const oracle = s.db.query<{ id: string }, [string, number, string]>(scanDirect).all(SCOPE, WINDOW, OWN);
      expect(healthy.length).toBe(WINDOW);
      expect(healthy.filter((r) => isLostHead(r.id))).toEqual([]);
      expect(mutant.filter((r) => isLostHead(r.id)).length).toBeGreaterThan(0);
      // Порядок сопрограммы без внешнего ORDER BY — ровно порядок оракула.
      expect(healthy.map((r) => r.id)).toEqual(oracle.map((r) => r.id));
      // На C окно добирается из L2: там и работает фильтр.
      if (s === C) expect(healthy.some((r) => r.layer === 2)).toBe(true);
      const n = s.db.query<{ n: number }, [string, string]>(lostSql).get(SCOPE, OWN)!.n;
      expect(n).toBe(s.db.query<{ n: number }, [string, string]>(lostFromNodes).get(SCOPE, OWN)!.n);
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe("отношения (чередуясь, не зависят от загрузки)", () => {
  for (const which of ["B", "C"] as const) {
    test(`${which}: цена терма в скане — против того же скана без него`, () => {
      const s = which === "B" ? B : C;
      const q = s.db.query(scanSql);
      const q0 = s.db.query(scanNoLost);
      const m = measure(
        `lost: скан дайджеста @${N}, L3 ${s.l3}`,
        () => { q.all(SCOPE, WINDOW, OWN); },
        { warmup: 30, iters: 100, rival: () => { q0.all(SCOPE, WINDOW, OWN); }, rivalLabel: "тот же скан без терма якорей" },
      );
      report(m);
      expectCostAtMost(m, SCAN_MAX_COST_RATIO);
    }, 120_000);

    test(`${which}: счётчик от якорей — против prime_pending_count`, () => {
      const s = which === "B" ? B : C;
      const c = s.db.query(lostSql);
      const p = s.db.query(pendingSql);
      const m = measure(
        `lost: счётчик скрытого @${N}, L3 ${s.l3}`,
        () => { c.all(SCOPE, OWN); },
        { warmup: 30, iters: 100, rival: () => { p.all(SCOPE, OWN); }, rivalLabel: "prime_pending_count" },
      );
      report(m);
      expectCostAtMost(m, COUNT_MAX_COST_RATIO);
    }, 120_000);
  }

  test("C: сопрограмма опережает прямой терм во внутреннем WHERE", () => {
    const q = C.db.query(scanSql);
    const d = C.db.query(scanDirect);
    const m = measure(
      `lost: скан дайджеста @${N}, L3 40 — сопрограмма`,
      () => { q.all(SCOPE, WINDOW, OWN); },
      { warmup: 30, iters: 100, rival: () => { d.all(SCOPE, WINDOW, OWN); }, rivalLabel: "прямой терм во WHERE под ORDER BY" },
    );
    report(m);
    expectAheadOfRival(m, SCAN_MIN_LEAD_OVER_DIRECT);
  }, 120_000);

  test("B: счётчик от якорей опережает счёт от всех видимых L2/L3", () => {
    const c = B.db.query(lostSql);
    const a = B.db.query(lostFromNodes);
    const m = measure(
      `lost: счётчик скрытого @${N}, L3 200 — от якорей`,
      () => { c.all(SCOPE, OWN); },
      { warmup: 30, iters: 100, rival: () => { a.all(SCOPE, OWN); }, rivalLabel: "тот же счёт от всех видимых L2/L3" },
    );
    report(m);
    expectAheadOfRival(m, COUNT_MIN_LEAD_OVER_NODES);
  }, 120_000);
});

describe(`бюджет (И1, prime p99 ${PRIME_BUDGET_MS} мс)`, () => {
  /** Дайджест как в scanDigest; `lost` — со счётчиком потерянных или без него. */
  const digest = (s: Stand, label: string, budgetMs: number, lost: boolean) => {
    const q = s.db.query(scanSql);
    const r = s.db.query(countsSql);
    const p = s.db.query(pendingSql);
    const l = s.db.query(lostSql);
    const q0 = s.db.query(scanNoLost);
    const m = measure(
      label,
      () => {
        q.all(SCOPE, WINDOW, OWN);
        r.all(SCOPE, OWN);
        p.all(SCOPE, OWN);
        if (lost) l.all(SCOPE, OWN);
      },
      {
        warmup: 30,
        iters: 100,
        budgetMs,
        rival: () => { q0.all(SCOPE, WINDOW, OWN); r.all(SCOPE, OWN); p.all(SCOPE, OWN); },
        rivalLabel: "дайджест до задачи: скан без терма + счётчики охвата и кандидатов",
      },
    );
    report(m);
    expectWithinBudget(m);
  };

  test("B: скан с термом + счётчики охвата и кандидатов — в прежнем подбюджете", () => {
    digest(B, `lost: скан с термом + прежние счётчики @${N}, L3 200`, DIGEST_BUDGET_MS, false);
    expect(DIGEST_BUDGET_MS).toBeLessThan(PRIME_BUDGET_MS);
  }, 120_000);

  for (const which of ["B", "C"] as const) {
    test(`${which}: дайджест целиком (скан + охват + кандидаты + потерянные) — не больше половины prime`, () => {
      const s = which === "B" ? B : C;
      digest(s, `lost: дайджест целиком @${N}, L3 ${s.l3}`, DIGEST_FULL_BUDGET_MS, true);
      expect(DIGEST_FULL_BUDGET_MS).toBeLessThan(PRIME_BUDGET_MS);
    }, 120_000);
  }
});
