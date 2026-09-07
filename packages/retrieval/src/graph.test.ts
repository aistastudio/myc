// Ограждения расширения выдачи по графу на 1–2 хопа (memory-1md1zhs0w8r0, §2.2).
//
// ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, кроме «функция ходит по рёбрам».
//
// 1. Глубина и затухание живут В КОНФИГЕ, а не в теле обхода: накладка
//    NO_GRAPH_OVERRIDES обязана убирать из выдачи ВСЕ узлы, найденные обходом,
//    а ONE_HOP_OVERRIDES — ровно узлы второго хопа. Пока это не так, «вынесено
//    в конфиг» — слова, и точку «расширение выключено» замерить нечем.
// 2. Обход не декоративен. Метрика на размеченном корпусе
//    (bench/graph-queries.json, 105 узлов, 60 рёбер, 25 запросов) считается
//    ТРИЖДЫ — без обхода, на одном хопе и на двух — и сверяется с записанным
//    замером bench/graph-eval.json.
// 3. Корпус наказывает обход там, где ему положено вредить (группа distractor)
//    и не даёт ему испортить то, что и так работало (группа lexical).
// 4. РАСШИРЕНИЕ ВХОДИТ В КЛЮЧ КЕША. Это не формальность: кеш, не знающий про
//    graphMaxHops, отдал бы на запрос С расширением выдачу БЕЗ него — тихо и
//    неотличимо (И2). Проверяется прямо, а не через «в ключе же весь конфиг».
// 5. Цена обхода ограничена КОНФИГОМ, а не данными: узел-хаб с сотней рёбер
//    не должен превращать один запрос в гидратацию сотен узлов.
//
// Корпус зафиксирован ДО первого замера и после него не правился.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateId } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import {
  DEFAULT_GRAPH_SETTINGS,
  graphSettingsFromToml,
} from "./boost-config.ts";
import { SearchResultCache, searchCacheKey } from "./cache.ts";
import type { FtsCaller } from "./fts.ts";
import {
  DEFAULT_GRAPH_DECAY_BY_HOP,
  DEFAULT_GRAPH_TYPE_WEIGHTS,
  DEFAULT_HYBRID_CONFIG,
  hybridSearch,
  NO_GRAPH_OVERRIDES,
  ONE_HOP_OVERRIDES,
  type HybridConfig,
  type HybridProfile,
  type HybridResult,
} from "./hybrid.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };
const NOW = Date.UTC(2026, 8, 7);
const LIMIT = 10;

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

function insertNode(db: SqliteDriver, title: string, body = "прочее"): string {
  const id = generateId();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          head_id, content_hash, acl, owner_id, team_id, agent_id,
                          created_at, updated_at)
       VALUES (?1, 'note', 1, 's1', ?2, ?3, ?4, 2, 'active', NULL, ?5, 'team', '', '', '', ?6, ?6)`,
    )
    .run(id, title, body, body.slice(0, 120), `hash-${id}`, NOW);
  return id;
}

function addEdge(
  db: SqliteDriver,
  src: string,
  dst: string,
  weight = 1.0,
  type = "relates",
): void {
  db.database
    .query(
      `INSERT INTO edges (src, type, dst, weight, add_tag, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .run(src, type, dst, weight, generateId(), NOW);
}

function search(db: SqliteDriver, text: string, config: Partial<HybridConfig> = {}): HybridResult {
  return hybridSearch(db, {
    text,
    scopes: ["s1"],
    caller: ANON,
    limit: LIMIT,
    now: NOW,
    vectorMode: "never",
    config,
  });
}

// ---------------------------------------------------------------------------
// 1. Глубина и затухание — из конфига
// ---------------------------------------------------------------------------

describe("параметры обхода вынесены в конфиг", () => {
  test("умолчания — те числа, которые описаны рядом", () => {
    expect(DEFAULT_HYBRID_CONFIG.graphMaxHops).toBe(2);
    expect(DEFAULT_HYBRID_CONFIG.graphDecayByHop).toEqual([0.5, 0.5]);
    expect(DEFAULT_GRAPH_DECAY_BY_HOP).toEqual([0.5, 0.5]);
    expect(DEFAULT_HYBRID_CONFIG.graphSeeds).toBe(15);
    expect(DEFAULT_HYBRID_CONFIG.graphHopFanout).toBe(64);
    expect(DEFAULT_HYBRID_CONFIG.graphHop2Seeds).toBe(12);
    expect(DEFAULT_HYBRID_CONFIG.graphTypeWeights).toEqual(DEFAULT_GRAPH_TYPE_WEIGHTS);
    expect(DEFAULT_HYBRID_CONFIG.graphTypeWeightDefault).toBe(1.0);
    // Потолок веера обязан быть НЕ МЕНЬШЕ графового капа слияния
    // (2 × (сиды + сиды второго хопа)) — иначе выдачу решал бы он, а не скор.
    expect(DEFAULT_HYBRID_CONFIG.graphHopFanout).toBeGreaterThanOrEqual(
      2 * (DEFAULT_HYBRID_CONFIG.graphSeeds + DEFAULT_HYBRID_CONFIG.graphHop2Seeds),
    );
  });

  test("МУТАЦИЯ «расширение отключено»: ни одного узла из обхода", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const far = insertNode(db, "сосед второго хопа");
    addEdge(db, seed, near);
    addEdge(db, near, far);

    const on = search(db, "alpha");
    expect(on.hits.map((h) => h.id)).toEqual([seed, near, far]);

    const off = search(db, "alpha", NO_GRAPH_OVERRIDES);
    expect(off.hits.map((h) => h.id)).toEqual([seed]);
    expect(off.mode_used.graph.maxHops).toBe(0);
    expect(off.mode_used.graph.byDepth).toEqual([]);
    expect(off.mode_used.graph.inHits).toBe(0);
    expect(off.mode_used.sources).not.toContain("graph");
    // Выключение — это ноль сидов в SQL, а не фильтр в памяти: round-trip
    // остаётся один, лишних запросов выключение не добавляет.
    expect(off.mode_used.roundTrips).toBe(1);
    db.close();
  });

  test("МУТАЦИЯ «только один хоп»: второй хоп исчезает, первый остаётся", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const far = insertNode(db, "сосед второго хопа");
    addEdge(db, seed, near);
    addEdge(db, near, far);

    const one = search(db, "alpha", ONE_HOP_OVERRIDES);
    expect(one.hits.map((h) => h.id)).toEqual([seed, near]);
    expect(one.mode_used.graph.maxHops).toBe(1);
    expect(one.mode_used.graph.byDepth).toEqual([1]);
    db.close();
  });

  test("затухание короче глубины: второй хоп не выполняется даже при maxHops 2", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const far = insertNode(db, "сосед второго хопа");
    addEdge(db, seed, near);
    addEdge(db, near, far);

    const res = search(db, "alpha", { graphDecayByHop: [0.5] });
    expect(res.hits.map((h) => h.id)).toEqual([seed, near]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Затухание по глубине — перемножением по пути
// ---------------------------------------------------------------------------

describe("затухание по глубине", () => {
  test("узел второго хопа = сид × d1 × w1 × d2 × w2 и ниже узла первого", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const far = insertNode(db, "сосед второго хопа");
    addEdge(db, seed, near, 0.8);
    addEdge(db, near, far, 0.6);

    const res = search(db, "alpha");
    const s = res.hits.find((h) => h.id === seed)!;
    const n = res.hits.find((h) => h.id === near)!;
    const f = res.hits.find((h) => h.id === far)!;

    const [d1, d2] = DEFAULT_HYBRID_CONFIG.graphDecayByHop as [number, number];
    expect(n.score / s.score).toBeCloseTo(d1 * 0.8, 9);
    expect(f.score / s.score).toBeCloseTo(d1 * 0.8 * d2 * 0.6, 9);
    expect(f.score).toBeLessThan(n.score);
    expect(n.score).toBeLessThan(s.score);
    db.close();
  });

  test("глубина видна в самом хите и в mode_used", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const far = insertNode(db, "сосед второго хопа");
    addEdge(db, seed, near);
    addEdge(db, near, far);

    const res = search(db, "alpha");
    expect(res.hits.find((h) => h.id === seed)!.graphDepth).toBeUndefined();
    expect(res.hits.find((h) => h.id === near)!.graphDepth).toBe(1);
    expect(res.hits.find((h) => h.id === far)!.graphDepth).toBe(2);
    expect(res.mode_used.graph.byDepth).toEqual([1, 1]);
    expect(res.mode_used.graph.inHits).toBe(2);
    expect(res.mode_used.sources).toContain("graph");
    db.close();
  });

  test("два пути до одного узла — берётся лучший, узел не дублируется", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const both = insertNode(db, "виден и с первого и со второго");
    addEdge(db, seed, near, 1.0);
    addEdge(db, near, both, 1.0); // второй хоп: 0.25 от сида
    addEdge(db, seed, both, 0.9); // первый хоп: 0.45 от сида — лучше

    const res = search(db, "alpha");
    const hit = res.hits.filter((h) => h.id === both);
    expect(hit.length).toBe(1);
    expect(hit[0]!.graphDepth).toBe(1);
    const s = res.hits.find((h) => h.id === seed)!;
    expect(hit[0]!.score / s.score).toBeCloseTo(0.5 * 0.9, 9);
    db.close();
  });

  test("узел, уже найденный лексикой, обходом не переоценивается", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha первый");
    const also = insertNode(db, "alpha второй");
    addEdge(db, seed, also);
    const res = search(db, "alpha");
    expect(res.hits.find((h) => h.id === also)!.graphDepth).toBeUndefined();
    expect(res.mode_used.graph.inHits).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Типы рёбер
// ---------------------------------------------------------------------------

describe("веса типов рёбер", () => {
  test("mentions весит вдвое меньше parent при равном весе ребра", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const kid = insertNode(db, "ребёнок по parent");
    const mention = insertNode(db, "упомянутый хаб");
    addEdge(db, seed, kid, 1.0, "parent");
    addEdge(db, seed, mention, 1.0, "mentions");

    const res = search(db, "alpha");
    const k = res.hits.find((h) => h.id === kid)!;
    const m = res.hits.find((h) => h.id === mention)!;
    expect(m.score / k.score).toBeCloseTo(DEFAULT_GRAPH_TYPE_WEIGHTS.mentions!, 9);

    // МУТАЦИЯ: таблица типов пуста -> оба типа идут по graphTypeWeightDefault.
    const flat = search(db, "alpha", { graphTypeWeights: {} });
    const k2 = flat.hits.find((h) => h.id === kid)!;
    const m2 = flat.hits.find((h) => h.id === mention)!;
    expect(m2.score / k2.score).toBeCloseTo(1, 9);
    db.close();
  });

  test("неизвестный тип идёт по graphTypeWeightDefault, а не выпадает", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед по evidence");
    addEdge(db, seed, near, 1.0, "evidence");
    const res = search(db, "alpha", { graphTypeWeightDefault: 0.25 });
    const s = res.hits.find((h) => h.id === seed)!;
    const n = res.hits.find((h) => h.id === near)!;
    expect(n.score / s.score).toBeCloseTo(0.5 * 0.25, 9);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Цена обхода ограничена конфигом, а не данными
// ---------------------------------------------------------------------------

describe("потолки веера", () => {
  test("хаб не тащит за собой всю окрестность: веер ограничен graphHopFanout", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    for (let i = 0; i < 200; i++) addEdge(db, seed, insertNode(db, `сосед ${i}`));

    const capped = search(db, "alpha", { graphHopFanout: 5, graphMaxHops: 1 });
    expect(capped.mode_used.graph.byDepth).toEqual([5]);

    const wide = search(db, "alpha", { graphHopFanout: 1000, graphMaxHops: 1 });
    expect(wide.mode_used.graph.byDepth).toEqual([200]);
    db.close();
  });

  test("сиды второго хопа ограничены graphHop2Seeds, и это видно в mode_used", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near: string[] = [];
    for (let i = 0; i < 20; i++) {
      const n = insertNode(db, `сосед ${i}`);
      near.push(n);
      addEdge(db, seed, n);
      addEdge(db, n, insertNode(db, `внук ${i}`));
    }
    const tight = search(db, "alpha", { graphHop2Seeds: 3 });
    expect(tight.mode_used.graph.byDepth[0]).toBe(20);
    expect(tight.mode_used.graph.byDepth[1]).toBe(3);
    expect(tight.mode_used.graph.hop2Capped).toBe(true);

    const wide = search(db, "alpha", { graphHop2Seeds: 50 });
    expect(wide.mode_used.graph.byDepth[1]).toBe(20);
    expect(wide.mode_used.graph.hop2Capped).toBe(false);
    db.close();
  });

  test("ребро легче порога не расширяет ни на первом хопе, ни на втором", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const weak = insertNode(db, "за слабым ребром");
    addEdge(db, seed, near, 1.0);
    addEdge(db, near, weak, 0.1);
    const res = search(db, "alpha");
    expect(res.hits.map((h) => h.id)).not.toContain(weak);
    db.close();
  });

  test("обход не добавляет round-trip'ов: 1–2 хопа тем же одним оператором", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    addEdge(db, seed, near);
    addEdge(db, near, insertNode(db, "сосед второго хопа"));
    expect(search(db, "alpha").mode_used.roundTrips).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Кеш: расширение обязано входить в ключ (И2)
// ---------------------------------------------------------------------------

describe("расширение по графу и кеш результатов", () => {
  const keyParts = {
    text: "alpha",
    scopes: ["s1"],
    layerMin: 0,
    layerMax: 3,
    limit: LIMIT,
    vectorMode: "never",
    caller: ANON,
  };
  const keyOf = (overrides: Partial<HybridConfig>): string =>
    searchCacheKey({ ...keyParts, config: { ...DEFAULT_HYBRID_CONFIG, ...overrides } });

  test("разная глубина, затухание и веса типов дают РАЗНЫЕ ключи", () => {
    const base = keyOf({});
    expect(keyOf(NO_GRAPH_OVERRIDES)).not.toBe(base);
    expect(keyOf(ONE_HOP_OVERRIDES)).not.toBe(base);
    expect(keyOf({ graphDecayByHop: [0.5, 0.2] })).not.toBe(base);
    expect(keyOf({ graphTypeWeights: {} })).not.toBe(base);
    expect(keyOf({ graphHopFanout: 8 })).not.toBe(base);
    expect(keyOf({ graphHop2Seeds: 3 })).not.toBe(base);
    // Тот же конфиг — тот же ключ: иначе кеш не попадал бы никогда.
    expect(keyOf({})).toBe(base);
  });

  test("кеш не отдаёт выдачу БЕЗ расширения на запрос С расширением", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const far = insertNode(db, "сосед второго хопа");
    addEdge(db, seed, near);
    addEdge(db, near, far);

    const cache = new SearchResultCache<HybridResult>();
    const ask = (config: Partial<HybridConfig>): HybridResult =>
      hybridSearch(db, {
        text: "alpha",
        scopes: ["s1"],
        caller: ANON,
        limit: LIMIT,
        now: NOW,
        vectorMode: "never",
        config,
        cache,
      });

    // Прогреваем кеш выдачей БЕЗ обхода, затем спрашиваем С обходом.
    const off = ask(NO_GRAPH_OVERRIDES);
    expect(off.hits.map((h) => h.id)).toEqual([seed]);
    const on = ask({});
    expect(on.mode_used.cache).toBe("miss"); // ключ другой — попадания быть не может
    expect(on.hits.map((h) => h.id)).toEqual([seed, near, far]);

    // И наоборот: повтор каждого варианта попадает в СВОЮ запись.
    expect(ask(NO_GRAPH_OVERRIDES).hits.map((h) => h.id)).toEqual([seed]);
    expect(ask({}).hits.map((h) => h.id)).toEqual([seed, near, far]);
    expect(cache.hits).toBe(2);
    expect(cache.misses).toBe(2);
    db.close();
  });

  test("новое ребро инвалидирует кеш через хвост оплога", () => {
    const db = freshDb();
    const seed = insertNode(db, "alpha якорь");
    const near = insertNode(db, "сосед первого хопа");
    const cache = new SearchResultCache<HybridResult>();
    const ask = (): HybridResult =>
      hybridSearch(db, {
        text: "alpha",
        scopes: ["s1"],
        caller: ANON,
        limit: LIMIT,
        now: NOW,
        vectorMode: "never",
        cache,
      });
    expect(ask().hits.map((h) => h.id)).toEqual([seed]);
    addEdge(db, seed, near);
    db.database
      .query(
        `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id, scope)
         VALUES (?1, 's', 1, ?2, 'a', 'edge_add', 'edge', ?3, 's1')`,
      )
      .run(generateId(), NOW, seed);
    expect(ask().hits.map((h) => h.id)).toEqual([seed, near]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Настройки обхода из workspace.toml
// ---------------------------------------------------------------------------

describe("graphSettingsFromToml", () => {
  test("пустой текст — умолчания", () => {
    expect(graphSettingsFromToml("")).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  test("значения из секции [retrieval] переопределяют умолчания", () => {
    const cfg = graphSettingsFromToml(`
[retrieval]
graph_max_hops = 1
graph_decay_by_hop = [0.4, 0.2]
graph_hop_fanout = 32
graph_type_weights = { mentions = 0.25, touches = 0.3 }
`);
    expect(cfg.graphMaxHops).toBe(1);
    expect(cfg.graphDecayByHop).toEqual([0.4, 0.2]);
    expect(cfg.graphHopFanout).toBe(32);
    expect(cfg.graphTypeWeights).toEqual({ mentions: 0.25, touches: 0.3 });
    // Незатронутое остаётся умолчанием.
    expect(cfg.graphSeeds).toBe(DEFAULT_GRAPH_SETTINGS.graphSeeds);
  });

  test("чужая секция игнорируется", () => {
    expect(graphSettingsFromToml("[absorb]\ngraph_max_hops = 0\n").graphMaxHops).toBe(
      DEFAULT_GRAPH_SETTINGS.graphMaxHops,
    );
  });

  test("мусор не роняет поиск: остаётся умолчание", () => {
    const cfg = graphSettingsFromToml(`
[retrieval]
graph_max_hops = два
graph_decay_by_hop = [0, 0.5]
graph_hop_fanout = 12.5
graph_type_weights = mentions
`);
    expect(cfg).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  test("затухание больше единицы отвергается — это уже не затухание", () => {
    expect(graphSettingsFromToml("[retrieval]\ngraph_decay_by_hop = [0.5, 1.5]\n")).toEqual(
      DEFAULT_GRAPH_SETTINGS,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Замер на bench/graph-queries.json: три числа и разницы между ними
// ---------------------------------------------------------------------------

interface CorpusNode {
  readonly id: string;
  readonly layer: number;
  readonly priority: number;
  readonly ageDays: number;
  readonly title: string;
  readonly body: string;
}
interface CorpusEdge {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
  readonly weight: number;
}
interface CorpusQuery {
  readonly q: string;
  readonly group: string;
  readonly profile: HybridProfile;
  readonly relevant: string;
}
interface Corpus {
  readonly nodes: readonly CorpusNode[];
  readonly edges: readonly CorpusEdge[];
  readonly queries: readonly CorpusQuery[];
}

function benchPath(name: string): string {
  return join(import.meta.dir, "..", "..", "..", "bench", name);
}

/** Тот же детерминированный id, что в bench/graph-eval.ts. */
function corpusIdOf(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 24);
}

function buildCorpusDb(corpus: Corpus): { db: SqliteDriver; idOf: Map<string, string> } {
  const db = freshDb();
  const idOf = new Map<string, string>();
  const insert = db.database.query(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        head_id, content_hash, acl, owner_id, team_id, agent_id,
                        created_at, updated_at)
     VALUES (?1, 'note', ?2, 's1', ?3, ?4, ?5, ?6, 'active', NULL, ?7, 'team', '', '', '', ?8, ?8)`,
  );
  for (const n of corpus.nodes) {
    const id = corpusIdOf(n.id);
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
  const insEdge = db.database.query(
    `INSERT INTO edges (src, type, dst, weight, add_tag, actor, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'bench', ?6)`,
  );
  for (const [i, e] of corpus.edges.entries()) {
    insEdge.run(idOf.get(e.src)!, e.type, idOf.get(e.dst)!, e.weight, `tag-${i}`, NOW);
  }
  return { db, idOf };
}

interface Measured {
  readonly mrr: number;
  readonly p1: number;
  readonly found: number;
  readonly byGroup: Record<string, number>;
}

function measureCorpus(
  corpus: Corpus,
  db: SqliteDriver,
  idOf: Map<string, string>,
  overrides: Partial<HybridConfig>,
): Measured {
  let mrrSum = 0;
  let first = 0;
  let found = 0;
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
    const hit = result.hits.find((h) => h.id === idOf.get(query.relevant)!);
    const rr = hit === undefined ? 0 : 1 / hit.rank;
    mrrSum += rr;
    if (hit !== undefined) found += 1;
    if (hit?.rank === 1) first += 1;
    const g = groups.get(query.group) ?? { sum: 0, total: 0 };
    g.sum += rr;
    g.total += 1;
    groups.set(query.group, g);
  }
  const byGroup: Record<string, number> = {};
  for (const [name, g] of groups) byGroup[name] = g.sum / g.total;
  return {
    mrr: mrrSum / corpus.queries.length,
    p1: first / corpus.queries.length,
    found,
    byGroup,
  };
}

describe("замер на bench/graph-queries.json", () => {
  const corpus = JSON.parse(readFileSync(benchPath("graph-queries.json"), "utf8")) as Corpus;
  const { db, idOf } = buildCorpusDb(corpus);
  const off = measureCorpus(corpus, db, idOf, NO_GRAPH_OVERRIDES);
  const hop1 = measureCorpus(corpus, db, idOf, ONE_HOP_OVERRIDES);
  const hop2 = measureCorpus(corpus, db, idOf, {});

  test("МУТАЦИЯ «расширение отключено» двигает метрику — обход не декоративен", () => {
    expect(hop2.mrr).toBeGreaterThan(off.mrr);
    // Записанный замер: 0.193 -> 0.422, то есть +0.229. Не «на тысячную».
    expect(hop2.mrr - off.mrr).toBeGreaterThan(0.15);
    // Без обхода треть корпуса не находится ВООБЩЕ: ответ лежит за ребром.
    expect(off.found).toBeLessThan(hop2.found);
    expect(hop2.found).toBe(corpus.queries.length);
  });

  test("ВТОРОЙ ХОП — отдельный вклад, а не удвоение первого", () => {
    expect(hop2.mrr).toBeGreaterThan(hop1.mrr);
    // Группа hop2 недостижима одним хопом по построению корпуса.
    expect(hop1.byGroup.hop2!).toBe(0);
    expect(hop2.byGroup.hop2!).toBeGreaterThan(0);
  });

  test("КОНТРОЛЬ: на группе distractor обход вредит, и это не спрятано", () => {
    expect(hop2.byGroup.distractor!).toBeLessThan(off.byGroup.distractor!);
    // При этом группы, ради которых обход и заведён, выигрывают все три.
    for (const group of ["hop1", "hop2", "typed"]) {
      expect(hop2.byGroup[group]!).toBeGreaterThan(off.byGroup[group]!);
    }
  });

  test("КОНТРОЛЬ: то, что находилось лексикой, обход не сдвинул", () => {
    expect(hop2.byGroup.lexical!).toBeCloseTo(off.byGroup.lexical!, 9);
  });

  test("веса типов рёбер не декоративны: группа typed без них проседает", () => {
    const flat = measureCorpus(corpus, db, idOf, { graphTypeWeights: {} });
    expect(flat.byGroup.typed!).toBeLessThan(hop2.byGroup.typed!);
    expect(flat.mrr).toBeLessThan(hop2.mrr);
  });

  test("числа совпадают с записанным замером bench/graph-eval.json", () => {
    const report = JSON.parse(readFileSync(benchPath("graph-eval.json"), "utf8")) as {
      corpus: { nodes: number; edges: number; queries: number };
      shift: { mrr: { off: number; hop1: number; hop2: number; delta: number }; p1: { off: number; hop2: number } };
      cache: { keysDistinct: boolean; rankMismatches: number };
      variants: readonly { variant: string; mrr: number; byGroup: Record<string, { mrr: number }> }[];
    };
    expect(report.corpus.nodes).toBe(corpus.nodes.length);
    expect(report.corpus.edges).toBe(corpus.edges.length);
    expect(report.corpus.queries).toBe(corpus.queries.length);
    expect(report.shift.mrr.off).toBeCloseTo(off.mrr, 9);
    expect(report.shift.mrr.hop1).toBeCloseTo(hop1.mrr, 9);
    expect(report.shift.mrr.hop2).toBeCloseTo(hop2.mrr, 9);
    expect(report.shift.mrr.delta).toBeCloseTo(hop2.mrr - off.mrr, 9);
    expect(report.cache.keysDistinct).toBe(true);
    expect(report.cache.rankMismatches).toBe(0);
    const mine: Record<string, Measured> = { off, hop1, hop2 };
    for (const variant of report.variants) {
      for (const [group, value] of Object.entries(variant.byGroup)) {
        expect(value.mrr).toBeCloseTo(mine[variant.variant]!.byGroup[group]!, 9);
      }
    }
  });
});
