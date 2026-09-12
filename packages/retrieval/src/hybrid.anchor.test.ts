/**
 * Знание с подозрительным якорем в выдаче (docs/design/01 §7.3, приёмка M3):
 * якорь `lost` — ×0.2, `stale` — ×0.5, `drifted` — ×drift; узел находится,
 * помечен состоянием якоря и стоит НИЖЕ живого аналога.
 *
 * МУТАЦИИ:
 *   NO_ANCHOR_WEIGHT_OVERRIDES (состояние не влияет на ранг) — краснеет
 *     «ниже живого аналога»: два одинаковых узла снова вровень;
 *   «худший якорь решает» вместо лучшего — краснеет «несколько якорей»;
 *   скан `edges` в подзапросе (снять условие на `src`) — краснеет план.
 *
 * Бюджет: подзапрос состояний — на каждую строку результата; его цена
 * меряется против того же лексического прохода без колонки, чередуясь
 * (@myc/bench), и против бюджета И1 на весь гибридный поиск (25 мс).
 */

import { describe, expect, test } from "bun:test";
import { generateId } from "@myc/core";
import { expectCostAtMost, expectWithinBudget, measure, report } from "@myc/bench";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import {
  anchorStatesSql,
  anchorWeightOf,
  DEFAULT_HYBRID_CONFIG,
  hybridQueries,
  hybridSearch,
  NO_ANCHOR_WEIGHT_OVERRIDES,
  type HybridConfig,
} from "./hybrid.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

function node(db: SqliteDriver, id: string, title: string, body: string, kind = "note"): void {
  const now = Date.now();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status, content_hash, acl,
                          owner_id, team_id, agent_id, created_at, updated_at)
       VALUES (?1, ?2, 1, 's1', ?3, ?4, ?5, 2, 'active', ?6, 'team', '', '', '', ?7, ?7)`,
    )
    .run(id, kind, title, body, body.slice(0, 120), `hash-${id}`, now);
}

/** Узел-якорь, строка `anchors` в состоянии `state` и ребро `touches` от знания к нему. */
function anchor(db: SqliteDriver, owner: string, state: string, drift = 1): string {
  const id = `anc-${generateId()}`;
  const now = Date.now();
  node(db, id, "src/x.ts:1-5", "", "anchor");
  db.database
    .query(
      `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash, crux, crux_norm,
                            state, drift, bound_at)
       VALUES (?1, '', 'src/x.ts', 1, 5, 'h', 'h', 'c', 'c', ?2, ?3, ?4)`,
    )
    .run(id, state, drift, now);
  db.database
    .query(
      `INSERT INTO edges (src, type, dst, weight, add_tag, created_at, attrs) VALUES (?1, 'touches', ?2, 1.0, ?3, ?4, ?5)`,
    )
    .run(owner, id, generateId(), now, state === "stale" || state === "lost" ? '{"suspect":1}' : "{}");
  return id;
}

function search(db: SqliteDriver, text: string, config: Partial<HybridConfig> = {}) {
  return hybridSearch(db, { text, scopes: ["s1"], caller: ANON, limit: 12, vectorMode: "never", config });
}

/** Два узла-близнеца: одинаковый текст — одинаковая лексика, разница только в якоре. */
function twins(db: SqliteDriver): void {
  const body = "Слияние ранжированных списков RRF: константа сглаживания шестьдесят";
  node(db, "live", "Решение про fuseRanked", body);
  node(db, "gone", "Решение про fuseRanked", body);
}

describe("знание с подозрительным якорем: найдено, помечено, ниже живого аналога", () => {
  test("якорь lost — узел в выдаче, помечен lost, ×0.2 и ниже близнеца со свежим якорем", () => {
    const db = freshDb();
    twins(db);
    anchor(db, "live", "fresh");
    anchor(db, "gone", "lost");
    const r = search(db, "fuseRanked RRF");
    const ids = r.hits.filter((h) => h.kind !== "anchor").map((h) => h.id);
    expect(ids).toEqual(["live", "gone"]);
    const gone = r.hits.find((h) => h.id === "gone")!;
    const live = r.hits.find((h) => h.id === "live")!;
    expect(gone.anchorState).toBe("lost");
    expect(gone.anchorWeight).toBe(0.2);
    expect(live.anchorState).toBeUndefined();
    expect(live.anchorWeight).toBeUndefined();
    expect(gone.score).toBeCloseTo(live.score * 0.2, 12);
    db.close();
  });

  test("id подобран так, что без понижения подозрительный стоял бы ПЕРВЫМ (тайбрейк по id)", () => {
    // Тот же стенд, но подозрительный узел — лексически «раньше» по id: при
    // равном счёте сортировка ставит его первым, и понижение обязано это
    // перевернуть. Иначе тест выше зеленел бы и без понижения.
    const db = freshDb();
    const body = "Слияние ранжированных списков RRF: константа сглаживания шестьдесят";
    node(db, "a-gone", "Решение про fuseRanked", body);
    node(db, "b-live", "Решение про fuseRanked", body);
    anchor(db, "a-gone", "lost");
    anchor(db, "b-live", "fresh");
    expect(search(db, "fuseRanked RRF").hits.filter((h) => h.kind !== "anchor").map((h) => h.id)).toEqual([
      "b-live",
      "a-gone",
    ]);
    // МУТАЦИЯ: состояние не влияет на ранг — близнецы вровень, первым встаёт по id.
    const flat = search(db, "fuseRanked RRF", NO_ANCHOR_WEIGHT_OVERRIDES).hits.filter((h) => h.kind !== "anchor");
    expect(flat.map((h) => h.id)).toEqual(["a-gone", "b-live"]);
    expect(flat[0]!.score).toBe(flat[1]!.score);
    db.close();
  });

  test("stale ×0.5, drifted ×drift, без якоря ×1 — таблица §7.3", () => {
    const db = freshDb();
    const body = "Порог сходства ступени три: пятьдесят сотых";
    for (const id of ["n-fresh", "n-drift", "n-stale", "n-none"]) node(db, id, "Порог rebind", body);
    anchor(db, "n-fresh", "fresh");
    anchor(db, "n-drift", "drifted", 0.8);
    anchor(db, "n-stale", "stale");
    const hits = search(db, "rebind порог").hits.filter((h) => h.kind !== "anchor");
    const by = new Map(hits.map((h) => [h.id, h]));
    const base = by.get("n-fresh")!.score;
    expect(by.get("n-none")!.score).toBeCloseTo(base, 12);
    expect(by.get("n-drift")!.score).toBeCloseTo(base * 0.8, 12);
    expect(by.get("n-drift")!.anchorState).toBe("drifted");
    expect(by.get("n-stale")!.score).toBeCloseTo(base * 0.5, 12);
    expect(by.get("n-stale")!.anchorState).toBe("stale");
    expect(hits.map((h) => h.id).slice(-2)).toEqual(["n-drift", "n-stale"]);
    db.close();
  });

  test("несколько якорей — решает лучший: один удалённый из двух не делает знание подозрительным", () => {
    const db = freshDb();
    twins(db);
    anchor(db, "live", "fresh");
    anchor(db, "gone", "lost");
    anchor(db, "gone", "fresh");
    const hits = search(db, "fuseRanked RRF").hits;
    const gone = hits.find((h) => h.id === "gone")!;
    expect(gone.anchorWeight).toBeUndefined();
    expect(gone.anchorState).toBeUndefined();
    expect(gone.score).toBeCloseTo(hits.find((h) => h.id === "live")!.score, 12);
    db.close();
  });

  test("узел-якорь сам по себе: lost — ×0.2 (он тоже знание о коде, которого нет)", () => {
    const a = anchorWeightOf("lost:0.3", DEFAULT_HYBRID_CONFIG);
    expect(a).toEqual({ weight: 0.2, state: "lost" });
    expect(anchorWeightOf(null, DEFAULT_HYBRID_CONFIG)).toEqual({ weight: 1, state: null });
    expect(anchorWeightOf("fresh:1.0,drifted:1.0", DEFAULT_HYBRID_CONFIG)).toEqual({ weight: 1, state: null });
    expect(anchorWeightOf("drifted:0.64", DEFAULT_HYBRID_CONFIG)).toEqual({ weight: 0.64, state: "drifted" });
  });
});

describe("цена колонки состояний", () => {
  test("план: рёбра — по первичному ключу (src, type), якорь — по node_id; скана нет", () => {
    const db = freshDb();
    const plan = (
      db.database
        .query(`EXPLAIN QUERY PLAN SELECT ${anchorStatesSql("n")} AS a FROM nodes n WHERE n.id = ?1`)
        .all("x") as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toMatch(/SEARCH t USING (PRIMARY KEY|INDEX sqlite_autoindex_edges_1) \(src=\? AND type=\?\)/);
    expect(plan).toMatch(/SEARCH an USING INDEX sqlite_autoindex_anchors_1 \(node_id=\?\)/);
    expect(plan).not.toMatch(/SCAN (t|an|edges|anchors)\b/);
    db.close();
  });

  test("лексический проход с колонкой состояний — в бюджете И1 и не дороже прохода без неё больше чем в ×1.5", () => {
    // 20k узлов, у каждого пятого — якорь (4k якорей, треть из них lost):
    // выдача почти целиком из узлов с якорями, то есть подзапрос платится на
    // каждой строке пула — худший для него случай.
    const db = freshDb();
    const N = 20_000;
    const now = Date.now();
    const words = "ранг слияние поиск бюджет узел граф вектор память оплог мерж якорь символ".split(" ");
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    db.database.exec("BEGIN");
    const ins = db.database.query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, status, content_hash, acl, team_id, created_at, updated_at)
       VALUES (?1, ?2, 1, 's1', ?3, ?4, '', 'active', ?5, 'team', '', ?6, ?6)`,
    );
    const insA = db.database.query(
      `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash, crux, crux_norm, state, drift, bound_at)
       VALUES (?1, '', ?2, 1, 5, 'h', 'h', 'c', 'c', ?3, 1.0, ?4)`,
    );
    const insE = db.database.query(
      `INSERT INTO edges (src, type, dst, weight, add_tag, created_at) VALUES (?1, 'touches', ?2, 1.0, ?3, ?4)`,
    );
    for (let i = 0; i < N; i++) {
      const w: string[] = [];
      for (let k = 0; k < 30; k++) w.push(words[Math.floor(rnd() * words.length)]!);
      const id = `k-${i}`;
      ins.run(id, "note", `Узел ${i}`, i % 100 === 0 ? `needle ${w.join(" ")}` : w.join(" "), `h-${id}`, now);
      if (i % 5 === 0) {
        const a = `a-${i}`;
        ins.run(a, "anchor", `src/f${i}.ts:1-5`, "", `h-${a}`, now);
        insA.run(a, `src/f${i}.ts`, i % 3 === 0 ? "lost" : "fresh", now);
        insE.run(id, a, `t-${i}`, now);
      }
    }
    db.database.exec("COMMIT");

    const withCol = hybridQueries.hybridLexicalPass;
    const without = { ...withCol, sql: withCol.sql.replace(anchorStatesSql("n"), "NULL") };
    expect(without.sql).not.toBe(withCol.sql);
    const params = ['"needle"', JSON.stringify(["s1"]), 0, 3, "", "", "", "[]", 100, 15, 0.3, 12, 64];
    const args = (q: typeof withCol) => (): void => {
      db.all(q, params);
    };
    // Пул целиком из узлов с якорями — колонка заполнена, и треть в нём lost.
    const pool = db.all<{ anchors: string | null; depth: number }>(withCol, params);
    const lex = pool.filter((r) => r.depth === 0);
    expect(lex.length).toBe(100);
    expect(lex.every((r) => r.anchors !== null)).toBe(true);
    expect(lex.some((r) => r.anchors?.startsWith("lost") === true)).toBe(true);
    // Обход дошёл и до самих узлов-якорей (ребро touches): у них — своя строка.
    expect(pool.some((r) => r.depth > 0 && r.anchors !== null)).toBe(true);
    // И выдача: подозрительные ниже — в топ-12 из двухсот одинаковых по
    // лексике узлов не попал ни один lost.
    expect(search(db, "needle").hits.some((h) => h.anchorState === "lost")).toBe(false);

    const m = measure("hybridLexicalPass + anchor states @20k/4k anchors", args(withCol), {
      warmup: 10,
      iters: 60,
      budgetMs: 25,
      rival: args(without),
      rivalLabel: "the same pass without the anchor-state column",
    });
    report(m, "И1: 25 мс на весь гибридный поиск");
    expectCostAtMost(m, 1.5);
    expectWithinBudget(m);
    db.close();
  }, 60_000);
});
