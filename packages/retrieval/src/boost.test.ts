// Ограждения бустов ранжирования (memory-vhchz7wzfjh9, §2.2).
//
// ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, кроме «функция считает по формуле».
//
// 1. Коэффициенты §2.2 действительно живут в конфиге, а не в теле boostOf:
//    их обнуление обязано превращать boost(d) в единицу для ЛЮБОГО узла.
//    Пока это не так, «вынести в конфиг» — слова: поле есть, а читается
//    зашитая константа, и никто этого не замечает.
// 2. Бусты не декоративны. Метрика на размеченном корпусе
//    (bench/boost-queries.json, 75 узлов, 25 запросов) считается ДВАЖДЫ — без
//    бустов и с бустами — и сверяется с записанным замером
//    bench/boost-eval.json. Это та самая мутация «буст обнулён»: если она не
//    двигает метрику, бусты не работают, и тест обязан упасть.
// 3. Корпус наказывает бусты там, где им положено вредить (группа distractor:
//    правильный ответ старый, P2 и в нижнем слое). Проверяется, что это
//    падение сохранилось: сдвиг в плюс, полученный корпусом без единого
//    контрпримера, доказывал бы не бусты, а конструкцию корпуса.
//
// Корпус зафиксирован ДО первого замера и после него не правился; коэффициенты
// взяты из §2.2 как есть и не подбирались. См. bench/boost-eval.ts.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { boostSettingsFromToml, DEFAULT_BOOST_SETTINGS } from "./boost-config.ts";
import type { FtsCaller } from "./fts.ts";
import {
  boostOf,
  DEFAULT_HYBRID_CONFIG,
  DEFAULT_LAYER_WEIGHTS,
  hybridSearch,
  NO_BOOST_OVERRIDES,
  type HybridConfig,
  type HybridProfile,
} from "./hybrid.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };
const NOW = Date.UTC(2026, 8, 7);
const LIMIT = 10;

// ---------------------------------------------------------------------------
// 1. Коэффициенты — из конфига, а не из тела функции
// ---------------------------------------------------------------------------

describe("коэффициенты бустов вынесены в конфиг", () => {
  const base = { priority: 2, layer: 1, updatedAt: NOW };

  test("умолчания равны числам §2.2", () => {
    expect(DEFAULT_HYBRID_CONFIG.priorityBoostP0).toBe(0.3);
    expect(DEFAULT_HYBRID_CONFIG.priorityBoostP1).toBe(0.15);
    expect(DEFAULT_HYBRID_CONFIG.priorityPenaltyP3).toBe(0.1);
    expect(DEFAULT_HYBRID_CONFIG.freshnessAmplitude).toBe(0.25);
    expect(DEFAULT_HYBRID_CONFIG.freshnessTauDays).toBe(90);
    expect(DEFAULT_HYBRID_CONFIG.layerWeights).toEqual(DEFAULT_LAYER_WEIGHTS);
    expect(DEFAULT_LAYER_WEIGHTS.prime).toEqual([0.9, 1.0, 1.1, 1.2]);
    expect(DEFAULT_LAYER_WEIGHTS.deep).toEqual([1.15, 1.15, 1.0, 0.9]);
    expect(DEFAULT_LAYER_WEIGHTS.balanced).toEqual([1.0, 1.0, 1.0, 1.0]);
  });

  test("NO_BOOST_OVERRIDES обнуляет boost(d) до 1 на любом узле и профиле", () => {
    const off = { ...DEFAULT_HYBRID_CONFIG, ...NO_BOOST_OVERRIDES } as HybridConfig;
    for (const profile of ["prime", "deep", "balanced"] as const) {
      for (const priority of [0, 1, 2, 3]) {
        for (const layer of [0, 1, 2, 3]) {
          for (const ageDays of [0, 45, 900]) {
            const b = boostOf(
              { priority, layer, updatedAt: NOW - ageDays * 86_400_000 },
              NOW,
              { ...off, profile },
            );
            expect(b).toBeCloseTo(1, 12);
          }
        }
      }
    }
  });

  test("другое число в конфиге даёт другой буст — константа не зашита", () => {
    const doubled = { ...DEFAULT_HYBRID_CONFIG, priorityBoostP0: 0.6 };
    const p0Default = boostOf({ ...base, priority: 0 }, NOW, DEFAULT_HYBRID_CONFIG);
    const p0Doubled = boostOf({ ...base, priority: 0 }, NOW, doubled);
    expect(p0Doubled / p0Default).toBeCloseTo(1.6 / 1.3, 12);

    const flatFreshness = { ...DEFAULT_HYBRID_CONFIG, freshnessAmplitude: 0 };
    expect(boostOf({ ...base, updatedAt: NOW }, NOW, flatFreshness)).toBeCloseTo(
      boostOf({ ...base, updatedAt: NOW - 900 * 86_400_000 }, NOW, flatFreshness),
      12,
    );

    const flippedLayers: HybridConfig = {
      ...DEFAULT_HYBRID_CONFIG,
      profile: "prime",
      layerWeights: { ...DEFAULT_LAYER_WEIGHTS, prime: [2, 1, 1, 0.5] },
    };
    expect(boostOf({ ...base, layer: 0 }, NOW, flippedLayers)).toBeGreaterThan(
      boostOf({ ...base, layer: 3 }, NOW, flippedLayers),
    );
  });

  test("слой участвует в ранжировании: prime вверх, deep вниз, balanced ровно", () => {
    const prime = { ...DEFAULT_HYBRID_CONFIG, profile: "prime" as const };
    const deep = { ...DEFAULT_HYBRID_CONFIG, profile: "deep" as const };
    const balanced = { ...DEFAULT_HYBRID_CONFIG, profile: "balanced" as const };
    expect(boostOf({ ...base, layer: 3 }, NOW, prime)).toBeGreaterThan(
      boostOf({ ...base, layer: 0 }, NOW, prime),
    );
    expect(boostOf({ ...base, layer: 0 }, NOW, deep)).toBeGreaterThan(
      boostOf({ ...base, layer: 3 }, NOW, deep),
    );
    for (const layer of [0, 1, 2, 3]) {
      expect(boostOf({ ...base, layer }, NOW, balanced)).toBeCloseTo(
        boostOf({ ...base, layer: 1 }, NOW, balanced),
        12,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Разбор [retrieval] из workspace.toml
// ---------------------------------------------------------------------------

describe("boostSettingsFromToml", () => {
  test("пустой текст оставляет умолчания", () => {
    expect(boostSettingsFromToml("")).toEqual(DEFAULT_BOOST_SETTINGS);
  });

  test("скаляры и веса слоёв переопределяются", () => {
    const cfg = boostSettingsFromToml(`
[retrieval]
priority_boost_p0 = 0.5
freshness_amplitude = 0.4   # с комментарием
freshness_tau_days = 30
layer_weights_deep = [1.5, 1.2, 1.0, 0.5]
`);
    expect(cfg.priorityBoostP0).toBe(0.5);
    expect(cfg.freshnessAmplitude).toBe(0.4);
    expect(cfg.freshnessTauDays).toBe(30);
    expect(cfg.layerWeights.deep).toEqual([1.5, 1.2, 1.0, 0.5]);
    // не названное в файле не меняется
    expect(cfg.priorityBoostP1).toBe(DEFAULT_BOOST_SETTINGS.priorityBoostP1);
    expect(cfg.layerWeights.prime).toEqual(DEFAULT_BOOST_SETTINGS.layerWeights.prime);
  });

  test("чужая секция игнорируется", () => {
    const cfg = boostSettingsFromToml("[absorb]\npriority_boost_p0 = 0.9\n");
    expect(cfg.priorityBoostP0).toBe(DEFAULT_BOOST_SETTINGS.priorityBoostP0);
  });

  test("мусор не роняет разбор и не портит умолчания", () => {
    const cfg = boostSettingsFromToml(`
[retrieval]
priority_boost_p0 = не число
freshness_tau_days = 0
priority_boost_p1 = -1
layer_weights_prime = [1, 2]
layer_weights_balanced = [1, 1, -1, 1]
неизвестный_ключ = 5
`);
    expect(cfg).toEqual(DEFAULT_BOOST_SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// 3. Замер на размеченном корпусе: два числа и разница между ними
// ---------------------------------------------------------------------------

interface CorpusNode {
  readonly id: string;
  readonly layer: number;
  readonly priority: number;
  readonly ageDays: number;
  readonly title: string;
  readonly body: string;
}
interface CorpusQuery {
  readonly q: string;
  readonly group: string;
  readonly profile: HybridProfile;
  readonly relevant: string;
}
interface Corpus {
  readonly nodes: readonly CorpusNode[];
  readonly queries: readonly CorpusQuery[];
}

function benchPath(name: string): string {
  return join(import.meta.dir, "..", "..", "..", "bench", name);
}

function loadCorpus(): Corpus {
  return JSON.parse(readFileSync(benchPath("boost-queries.json"), "utf8")) as Corpus;
}

/** Тот же детерминированный id, что в bench/boost-eval.ts — иначе тай-брейк
 * по id развёл бы числа теста и записанного замера (комментарий там же). */
function nodeIdOf(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 24);
}

function buildDb(corpus: Corpus): { db: SqliteDriver; idOf: Map<string, string> } {
  const db = openSqlite(":memory:");
  db.database.exec(migration001Init.sql);
  const idOf = new Map<string, string>();
  const insert = db.database.query(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        head_id, content_hash, acl, owner_id, team_id, agent_id,
                        created_at, updated_at)
     VALUES (?1, 'note', ?2, 's1', ?3, ?4, ?5, ?6, 'active', NULL, ?7, 'team', '', '', '', ?8, ?8)`,
  );
  for (const n of corpus.nodes) {
    const id = nodeIdOf(n.id);
    idOf.set(n.id, id);
    insert.run(
      id,
      n.layer,
      n.title,
      n.body,
      n.body.slice(0, 120),
      n.priority,
      `hash-${id}`,
      NOW - n.ageDays * 86_400_000,
    );
  }
  return { db, idOf };
}

interface Measured {
  readonly mrr: number;
  readonly p1: number;
  readonly byGroup: Record<string, number>;
}

function measure(
  corpus: Corpus,
  db: SqliteDriver,
  idOf: Map<string, string>,
  overrides: Partial<HybridConfig>,
): Measured {
  let mrrSum = 0;
  let first = 0;
  const groups = new Map<string, { sum: number; total: number }>();
  for (const query of corpus.queries) {
    const result = hybridSearch(db, {
      text: query.q,
      scopes: ["s1"],
      caller: ANON,
      limit: LIMIT,
      now: NOW,
      vectorMode: "never",
      config: { ...overrides, profile: query.profile },
    });
    const target = idOf.get(query.relevant)!;
    const hit = result.hits.find((h) => h.id === target);
    const rr = hit === undefined ? 0 : 1 / hit.rank;
    mrrSum += rr;
    if (hit?.rank === 1) first += 1;
    const g = groups.get(query.group) ?? { sum: 0, total: 0 };
    g.sum += rr;
    g.total += 1;
    groups.set(query.group, g);
  }
  const byGroup: Record<string, number> = {};
  for (const [name, g] of groups) byGroup[name] = g.sum / g.total;
  return { mrr: mrrSum / corpus.queries.length, p1: first / corpus.queries.length, byGroup };
}

describe("замер на bench/boost-queries.json", () => {
  const corpus = loadCorpus();
  const { db, idOf } = buildDb(corpus);
  const off = measure(corpus, db, idOf, NO_BOOST_OVERRIDES);
  const on = measure(corpus, db, idOf, {});

  test("МУТАЦИЯ «буст обнулён» двигает метрику — бусты не декоративны", () => {
    // Если бы boostOf игнорировал конфиг (или бусты не влияли на порядок),
    // эти два числа совпали бы и тест упал бы здесь.
    expect(on.mrr).toBeGreaterThan(off.mrr);
    expect(on.p1).toBeGreaterThan(off.p1);
    // Сдвиг не «на тысячную»: записанный замер — +0.327 MRR и +0.56 P@1.
    expect(on.mrr - off.mrr).toBeGreaterThan(0.2);
    expect(on.p1 - off.p1).toBeGreaterThan(0.4);
  });

  test("числа совпадают с записанным замером bench/boost-eval.json", () => {
    const report = JSON.parse(readFileSync(benchPath("boost-eval.json"), "utf8")) as {
      corpus: { nodes: number; queries: number };
      shift: { mrr: { off: number; on: number; delta: number }; p1: { off: number; on: number } };
      variants: readonly { variant: string; mrr: number; p1: number; byGroup: Record<string, { mrr: number }> }[];
    };
    expect(report.corpus.nodes).toBe(corpus.nodes.length);
    expect(report.corpus.queries).toBe(corpus.queries.length);
    expect(report.shift.mrr.off).toBeCloseTo(off.mrr, 9);
    expect(report.shift.mrr.on).toBeCloseTo(on.mrr, 9);
    expect(report.shift.p1.off).toBeCloseTo(off.p1, 9);
    expect(report.shift.p1.on).toBeCloseTo(on.p1, 9);
    expect(report.shift.mrr.delta).toBeCloseTo(on.mrr - off.mrr, 9);
    for (const variant of report.variants) {
      const mine = variant.variant === "off" ? off : on;
      for (const [group, value] of Object.entries(variant.byGroup)) {
        expect(value.mrr).toBeCloseTo(mine.byGroup[group]!, 9);
      }
    }
  });

  test("КОНТРОЛЬ: на группе distractor бусты вредят, и это не спрятано", () => {
    // Правильный ответ там старый, P2 и в нижнем слое; шум — свежий, P0, L3.
    // Сдвиг в плюс, полученный корпусом без единого такого случая, доказывал
    // бы конструкцию корпуса, а не бусты.
    expect(on.byGroup.distractor!).toBeLessThan(off.byGroup.distractor!);
    // При этом группы, ради которых бусты и заведены, выигрывают все четыре.
    for (const group of ["freshness", "priority", "layer_prime", "layer_deep"]) {
      expect(on.byGroup[group]!).toBeGreaterThan(off.byGroup[group]!);
    }
  });

  test("слой решает исход на бутстрапе и на конкретном факте", () => {
    // Те же запросы под balanced (слой не участвует) против своего профиля.
    const flat = measure(
      corpus,
      db,
      idOf,
      { layerWeights: { prime: [1, 1, 1, 1], deep: [1, 1, 1, 1], balanced: [1, 1, 1, 1] } },
    );
    expect(on.byGroup.layer_prime!).toBeGreaterThan(flat.byGroup.layer_prime!);
    expect(on.byGroup.layer_deep!).toBeGreaterThan(flat.byGroup.layer_deep!);
  });
});
