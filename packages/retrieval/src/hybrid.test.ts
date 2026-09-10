// Тесты гибридного ретривала + эксперимент, проверяющий гипотезу о якорях.
//
// Эксперимент (describe «эксперимент») печатает таблицы, по которым принималось
// решение о порогах; он же — приёмка задачи myc-dze.3. Его выводы и границы
// применимости расписаны в шапке соответствующего describe: часть чисел
// получена на настоящем FTS5-индексе, часть — на симулированном эмбеддере,
// и смешивать их нельзя.

import { describe, expect, test } from "bun:test";
import { generateId, type DbDriver } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { expectWithinBudget, measure, report } from "@myc/bench";
import type { FtsCaller } from "./fts.ts";
import type { VectorSearchOutcome, VectorSearchParams } from "./vector.ts";
import {
  DEFAULT_HYBRID_CONFIG,
  bm25Spread,
  boostOf,
  evaluateTrigger,
  hybridSearch,
  isAnchorToken,
  rrfScore,
  tokenizeQuery,
  type HybridSearchParams,
  type HybridVectorSource,
} from "./hybrid.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

interface NodeSeed {
  readonly id?: string;
  readonly scope?: string;
  readonly layer?: 0 | 1 | 2 | 3;
  readonly kind?: string;
  readonly title?: string;
  readonly body?: string;
  readonly priority?: number;
  readonly updatedAt?: number;
  readonly acl?: "private" | "team" | "restricted" | "agent";
  readonly ownerId?: string;
  readonly teamId?: string;
}

function insertNode(db: SqliteDriver, seed: NodeSeed): string {
  const id = seed.id ?? generateId();
  const now = seed.updatedAt ?? Date.now();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          head_id, content_hash, acl, owner_id, team_id, agent_id,
                          created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', NULL, ?9, ?10, ?11, ?12, '', ?13, ?13)`,
    )
    .run(
      id,
      seed.kind ?? "note",
      seed.layer ?? 1,
      seed.scope ?? "s1",
      seed.title ?? "",
      seed.body ?? "",
      (seed.body ?? "").slice(0, 120),
      seed.priority ?? 2,
      `hash-${id}`,
      seed.acl ?? "team",
      seed.ownerId ?? "",
      seed.teamId ?? "",
      now,
    );
  return id;
}

function addEdge(db: SqliteDriver, src: string, dst: string, weight = 1.0): void {
  db.database
    .query(
      `INSERT INTO edges (src, type, dst, weight, add_tag, created_at) VALUES (?1, 'relates', ?2, ?3, ?4, ?5)`,
    )
    .run(src, dst, weight, generateId(), Date.now());
}

/** Драйвер-обёртка, считающая НАСТОЯЩИЕ обращения к базе. */
function counting(db: DbDriver): { db: DbDriver; calls: () => number } {
  let n = 0;
  const wrapped: DbDriver = {
    dialect: db.dialect,
    one: (q, p) => {
      n++;
      return db.one(q, p);
    },
    all: (q, p) => {
      n++;
      return db.all(q, p);
    },
    run: (q, p) => {
      n++;
      return db.run(q, p);
    },
    tx: (mode, fn) => db.tx(mode, fn),
  };
  return { db: wrapped, calls: () => n };
}

/** Векторный источник-заглушка с фиксированным списком id. */
function stubVector(ids: readonly string[], extra: Partial<VectorSearchOutcome> = {}) {
  const calls: VectorSearchParams[] = [];
  const source: HybridVectorSource = (_db, params) => {
    calls.push(params);
    return {
      hits: ids.map((id, i) => ({ id, rank: i + 1, distance: i * 0.01 })),
      degraded: false,
      reranked: false,
      candidates: ids.length,
      ...extra,
    };
  };
  return { source, calls };
}

/**
 * Векторный источник-заглушка с ПОЛНЫМ контролем над дистанцией каждого хита
 * и статистикой пула — для тестов myc-ye3.9 (confidence должна отражать
 * дистанцию относительно пула, а не место в топе).
 */
function stubVectorDist(
  entries: readonly { id: string; distance: number }[],
  poolStats: { distanceMean: number; distanceStd: number },
) {
  const source: HybridVectorSource = () => ({
    hits: entries.map((e, i) => ({ id: e.id, rank: i + 1, distance: e.distance })),
    degraded: false,
    reranked: true,
    candidates: entries.length,
    distanceMean: poolStats.distanceMean,
    distanceStd: poolStats.distanceStd,
  });
  return { source };
}

/**
 * Корпус, на котором лексика отвечает уверенно: один документ с терминами в
 * заголовке (вес поля 10) и десяток длинных, где те же термины утоплены в
 * шуме. Такой корпус даёт настоящий разброс BM25 — на равномерном корпусе
 * триггер срабатывает, и правильно делает.
 */
function seedConfidentLexicalCorpus(db: SqliteDriver): void {
  insertNode(db, { title: "alpha beta gamma delta", body: "alpha beta gamma delta" });
  const filler = "прочий текст наполнения без отношения к делу ".repeat(12);
  for (let i = 0; i < 11; i++) {
    insertNode(db, {
      title: `запись ${i}`,
      body: `${filler} alpha ${filler} beta ${filler} gamma ${filler} delta ${filler} ${i}`,
    });
  }
}

function search(db: DbDriver, overrides: Partial<HybridSearchParams> = {}) {
  return hybridSearch(db, {
    text: "alpha",
    scopes: ["s1"],
    caller: ANON,
    ...overrides,
  });
}

// ============================ формула RRF ===================================

describe("rrfScore — формула §2.2", () => {
  const cfg = DEFAULT_HYBRID_CONFIG;

  test("узел в обоих источниках: сумма двух слагаемых", () => {
    expect(rrfScore({ fts: 1, vec: 1 }, cfg)).toBeCloseTo(1 / 61 + 1 / 61, 12);
    expect(rrfScore({ fts: 1, vec: 3 }, cfg)).toBeCloseTo(1 / 61 + 1 / 63, 12);
  });

  test("отсутствие в источнике — штрафной ранг 1000, а не пропуск слагаемого", () => {
    // Пропуск дал бы 1/61 = 0.01639 и сравнял бы одиночную находку с двойной.
    expect(rrfScore({ fts: 1 }, cfg)).toBeCloseTo(1 / 61 + 1 / 1060, 12);
    expect(rrfScore({ fts: 1 }, cfg)).toBeLessThan(rrfScore({ fts: 1, vec: 1 }, cfg));
  });

  test("k = 60 сглаживает: разрыв 1-2 меньше, чем был бы при k = 0", () => {
    const gap60 = rrfScore({ fts: 1 }, cfg) - rrfScore({ fts: 2 }, cfg);
    const gap0 = rrfScore({ fts: 1 }, { ...cfg, rrfK: 0 }) - rrfScore({ fts: 2 }, { ...cfg, rrfK: 0 });
    expect(gap60).toBeLessThan(gap0);
  });

  test("веса источников — параметры, по умолчанию 1.0 и 1.0", () => {
    expect(cfg.weightFts).toBe(1.0);
    expect(cfg.weightVec).toBe(1.0);
    const onlyFts = { ...cfg, weightVec: 0 };
    expect(rrfScore({ fts: 1, vec: 1 }, onlyFts)).toBeCloseTo(1 / 61, 12);
    const heavyVec = { ...cfg, weightVec: 2.0 };
    expect(rrfScore({ fts: 1, vec: 1 }, heavyVec)).toBeCloseTo(1 / 61 + 2 / 61, 12);
  });

  test("константы соответствуют §2.2", () => {
    expect(cfg.rrfK).toBe(60);
    expect(cfg.poolSize).toBe(100);
    expect(cfg.missingRank).toBe(1000);
  });
});

describe("boostOf — бусты §2.2", () => {
  const now = 1_700_000_000_000;
  const base = { priority: 2, layer: 1, updatedAt: now };

  test("P0 даёт +30%, P1 +15%, P3 −10%", () => {
    const b2 = boostOf(base, now, DEFAULT_HYBRID_CONFIG);
    expect(boostOf({ ...base, priority: 0 }, now, DEFAULT_HYBRID_CONFIG) / b2).toBeCloseTo(1.3, 9);
    expect(boostOf({ ...base, priority: 1 }, now, DEFAULT_HYBRID_CONFIG) / b2).toBeCloseTo(1.15, 9);
    expect(boostOf({ ...base, priority: 3 }, now, DEFAULT_HYBRID_CONFIG) / b2).toBeCloseTo(0.9, 9);
  });

  test("свежесть затухает с τ = 90 дней", () => {
    const fresh = boostOf(base, now, DEFAULT_HYBRID_CONFIG);
    const old = boostOf({ ...base, updatedAt: now - 90 * 86_400_000 }, now, DEFAULT_HYBRID_CONFIG);
    expect(fresh / old).toBeCloseTo(1.25 / (1 + 0.25 * Math.exp(-1)), 9);
  });

  test("профиль prime поднимает L3, deep — L0", () => {
    const prime = { ...DEFAULT_HYBRID_CONFIG, profile: "prime" as const };
    const deep = { ...DEFAULT_HYBRID_CONFIG, profile: "deep" as const };
    expect(boostOf({ ...base, layer: 3 }, now, prime)).toBeGreaterThan(
      boostOf({ ...base, layer: 0 }, now, prime),
    );
    expect(boostOf({ ...base, layer: 0 }, now, deep)).toBeGreaterThan(
      boostOf({ ...base, layer: 3 }, now, deep),
    );
  });
});

// ============================ якоря и разброс ===============================

describe("isAnchorToken", () => {
  test("якоря: идентификаторы, коды, пути, символы", () => {
    for (const t of [
      "myc-dze",
      "E1042",
      "ENOENT",
      "hybridSearch",
      "nodes_fts",
      "vector.ts",
      "src/retrieval",
      "a1b2c3d4e5f6",
      "SIGSEGV",
      "prepareFtsQuery",
    ]) {
      expect(isAnchorToken(t)).toBe(true);
    }
  });

  test("не якоря: обычные слова", () => {
    for (const t of [
      "как",
      "поиск",
      "config",
      "error",
      "почему",
      "медленно",
      "запрос",
      "восстановления", // длинное слово языка — НЕ якорь (правило длины только для ASCII)
      "инициализация",
    ]) {
      expect(isAnchorToken(t)).toBe(false);
    }
  });

  test("токенизация повторяет форму FTS-термов", () => {
    expect(tokenizeQuery("почему падает src/vector.ts при E1042?")).toEqual([
      "почему",
      "падает",
      "src/vector.ts",
      "при",
      "E1042",
    ]);
  });
});

describe("bm25Spread", () => {
  test("меньше spreadMinHits кандидатов -> NaN, триггерить нельзя", () => {
    expect(Number.isNaN(bm25Spread([-5, -4], 3))).toBe(true);
  });

  test("все одинаковые -> 0", () => {
    expect(bm25Spread([-3, -3, -3, -3], 3)).toBe(0);
  });

  test("выраженный лидер -> большой разброс", () => {
    expect(bm25Spread([-10, -2, -2, -2], 3)).toBeCloseTo(0.8, 9);
  });
});

// ============================ триггер =======================================

describe("evaluateTrigger — три критерия", () => {
  const cfg = DEFAULT_HYBRID_CONFIG;

  test("мало результатов (и без якоря) -> few_results", () => {
    const t = evaluateTrigger("описание процесса сбоя", [-9, -3], cfg);
    expect(t.checks.fewResults).toBe(true);
    expect(t.fired).toBe(true);
    expect(t.reasons).toContain("few_results");
  });

  test("ноль результатов -> всегда срабатывает, даже с якорем", () => {
    const t = evaluateTrigger("hybridSearch", [], cfg);
    expect(t.anchorHit).toBe(false);
    expect(t.checks.fewResults).toBe(true);
    expect(t.fired).toBe(true);
  });

  test("найденный якорь снимает few_results: один точный документ — это ответ", () => {
    const t = evaluateTrigger("prepareFtsQuery", [-12], cfg);
    expect(t.anchorHit).toBe(true);
    expect(t.checks.fewResults).toBe(false);
    expect(t.fired).toBe(false);
  });

  test("оговорку можно выключить конфигом — тогда критерий срабатывает", () => {
    const t = evaluateTrigger("prepareFtsQuery", [-12], {
      ...cfg,
      anchorHitSuppressesFewResults: false,
    });
    expect(t.checks.fewResults).toBe(true);
  });

  test("низкий разброс BM25 -> low_bm25_spread", () => {
    const flat = new Array(20).fill(-4.0);
    const t = evaluateTrigger("система обработки данных пользователя", flat, cfg);
    expect(t.metrics.bm25Spread).toBe(0);
    expect(t.checks.lowBm25Spread).toBe(true);
    expect(t.fired).toBe(true);
  });

  test("хороший разброс на длинном запросе -> не срабатывает", () => {
    const scores = [-20, -6, -5, -5, -4, -4, -4, -3];
    const t = evaluateTrigger("миграция схемы базы данных проекта", scores, cfg);
    expect(t.checks.lowBm25Spread).toBe(false);
    expect(t.fired).toBe(false);
  });

  test("короткий запрос без якорей -> short_query_no_anchor", () => {
    const scores = [-20, -6, -5, -5, -4, -4, -3];
    const t = evaluateTrigger("почему медленно", scores, cfg);
    expect(t.checks.shortQueryNoAnchor).toBe(true);
    expect(t.fired).toBe(true);
  });

  test("короткий запрос С якорем -> не срабатывает", () => {
    const scores = [-20, -6, -5, -5, -4, -4, -3];
    const t = evaluateTrigger("vec_nodes_f32", scores, cfg);
    expect(t.checks.shortQueryNoAnchor).toBe(false);
    expect(t.fired).toBe(false);
  });

  test("пороги настраиваются числами", () => {
    const scores = [-20, -6, -5];
    expect(evaluateTrigger("сборка индекса корпуса", scores, cfg).checks.fewResults).toBe(true);
    expect(
      evaluateTrigger("сборка индекса корпуса", scores, { ...cfg, minLexicalHits: 2 }).checks
        .fewResults,
    ).toBe(false);
  });
});

// ============================ поведение на живой базе ========================

describe("hybridSearch — лексический режим", () => {
  test("один SQL-оператор на весь лексический путь: пул + граф + гидратация", () => {
    const raw = freshDb();
    for (let i = 0; i < 12; i++) {
      insertNode(raw, { title: `alpha beta ${i}`, body: `общий текст про alpha номер ${i}` });
    }
    const { db, calls } = counting(raw);
    const res = hybridSearch(db, { text: "alpha beta", scopes: ["s1"], caller: ANON });

    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.mode_used.roundTrips).toBe(1);
    expect(calls()).toBe(1); // счётчик отчёта совпадает с реальностью
    expect(res.mode_used.vectorRoundTrips).toBe(0);
    raw.close();
  });

  test("mode_used присутствует и говорит правду: вектора не было", () => {
    const raw = freshDb();
    seedConfidentLexicalCorpus(raw);
    const spy = stubVector(["nope"]);
    const res = hybridSearch(raw, {
      text: "alpha beta gamma delta",
      scopes: ["s1"],
      caller: ANON,
      vectorSource: spy.source,
      embedQuery: () => new Float32Array(384),
    });

    expect(res.mode_used.vector).toBe("skipped");
    expect(res.mode_used.sources).not.toContain("vector");
    expect(spy.calls.length).toBe(0);
    for (const hit of res.hits) expect(hit.vecRank).toBeUndefined();
    raw.close();
  });

  test("эмбеддер НЕ вызывается, пока триггер не сработал — в этом вся экономия", () => {
    const raw = freshDb();
    seedConfidentLexicalCorpus(raw);
    let embedCalls = 0;
    const res = search(raw, {
      text: "alpha beta gamma delta",
      embedQuery: () => {
        embedCalls++;
        return new Float32Array(384);
      },
      vectorSource: stubVector([]).source,
    });
    expect(res.mode_used.trigger.fired).toBe(false);
    expect(embedCalls).toBe(0);
    raw.close();
  });

  test("vectorMode: always вызывает эмбеддер всегда — эталон для сравнения", () => {
    const raw = freshDb();
    for (let i = 0; i < 12; i++) insertNode(raw, { title: `t${i}`, body: `alpha beta ${i}` });
    let embedCalls = 0;
    const spy = stubVector([]);
    const res = search(raw, {
      text: "alpha beta",
      vectorMode: "always",
      embedQuery: () => {
        embedCalls++;
        return new Float32Array(384);
      },
      vectorSource: spy.source,
    });
    expect(embedCalls).toBe(1);
    expect(spy.calls.length).toBe(1);
    expect(res.mode_used.why).toContain("unconditionally");
    raw.close();
  });

  test("vectorMode: never выключает ветку явно и говорит об этом", () => {
    const raw = freshDb();
    insertNode(raw, { title: "one", body: "alpha" });
    let embedCalls = 0;
    const res = search(raw, {
      text: "alpha",
      vectorMode: "never",
      embedQuery: () => {
        embedCalls++;
        return new Float32Array(384);
      },
    });
    expect(res.mode_used.vector).toBe("disabled");
    expect(embedCalls).toBe(0);
    raw.close();
  });
});

describe("hybridSearch — векторная ветка", () => {
  test("триггер сработал -> вектор участвует, RRF сливает оба источника", () => {
    const raw = freshDb();
    const lex = insertNode(raw, { title: "alpha", body: "alpha один" });
    const vecOnly = insertNode(raw, { title: "омоним", body: "совсем другой текст" });
    const spy = stubVector([vecOnly, lex]);

    const res = search(raw, {
      text: "alpha",
      embedQuery: () => new Float32Array(384).fill(0.1),
      vectorSource: spy.source,
    });

    expect(res.mode_used.trigger.fired).toBe(true);
    expect(res.mode_used.vector).toBe("used");
    expect(spy.calls.length).toBe(1);
    expect(res.mode_used.sources).toContain("vector");

    const byId = new Map(res.hits.map((h) => [h.id, h]));
    // lex найден обоими источниками (fts rank 1, vec rank 2), vecOnly — одним.
    expect(byId.get(lex)!.ftsRank).toBe(1);
    expect(byId.get(lex)!.vecRank).toBe(2);
    expect(byId.get(vecOnly)!.ftsRank).toBeUndefined();
    expect(byId.get(vecOnly)!.vecRank).toBe(1);
    expect(byId.get(lex)!.rrf).toBeGreaterThan(byId.get(vecOnly)!.rrf);
    raw.close();
  });

  test("вектор передаётся source'у, срез пула — poolSize", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha", body: "alpha" });
    const spy = stubVector([]);
    const vec = new Float32Array(384).fill(0.25);
    search(raw, { text: "alpha", embedQuery: () => vec, vectorSource: spy.source });
    expect(spy.calls[0]!.vector).toBe(vec);
    expect(spy.calls[0]!.limit).toBe(DEFAULT_HYBRID_CONFIG.poolSize);
    expect(spy.calls[0]!.scopes).toEqual(["s1"]);
    raw.close();
  });

  test("узлы, найденные только вектором, гидратируются вторым запросом", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha", body: "alpha" });
    const vecOnly = insertNode(raw, { title: "заголовок вектора", body: "тело" });
    const { db, calls } = counting(raw);
    const res = hybridSearch(db, {
      text: "alpha",
      scopes: ["s1"],
      caller: ANON,
      embedQuery: () => new Float32Array(384),
      vectorSource: stubVector([vecOnly]).source,
    });
    expect(calls()).toBe(2); // лексический проход + гидратация вектор-онли
    expect(res.mode_used.roundTrips).toBe(2);
    expect(res.hits.find((h) => h.id === vecOnly)!.title).toBe("заголовок вектора");
    raw.close();
  });

  test("вектор-онли узел вне ACL вызывающего в выдачу не попадает", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha", body: "alpha" });
    const secret = insertNode(raw, { title: "секрет", body: "чужое", acl: "private", ownerId: "u2" });
    const res = search(raw, {
      text: "alpha",
      embedQuery: () => new Float32Array(384),
      vectorSource: stubVector([secret]).source,
    });
    expect(res.hits.map((h) => h.id)).not.toContain(secret);
    raw.close();
  });
});

describe("hybridSearch — vecConfidence: myc-ye3.9 (score в выдаче выглядел уверенностью, но ей не был)", () => {
  test("верхний хит НЕ получает искусственную 1.00 — confidence считается от дистанции в пуле, не от ранга", () => {
    const raw = freshDb();
    // Ни один термин запроса не встречается в текстах — лексика молчит, оба
    // узла найдены только вектором. Именно этот случай воспроизводит баг:
    // прежний score_rel делил score на максимум ВНУТРИ ЭТОЙ ЖЕ выдачи и
    // верхний хит всегда получал 1.00, даже когда это был обычный, ничем не
    // выделяющийся сосед по пулу.
    const strong = insertNode(raw, { title: "strong", body: "нет пересечения слов" });
    const weak = insertNode(raw, { title: "weak", body: "тоже нет пересечения слов" });
    const spy = stubVectorDist(
      [
        { id: strong, distance: 0.05 }, // заметно ближе среднего пула
        { id: weak, distance: 0.2 }, // ровно на среднем — обычный сосед
      ],
      { distanceMean: 0.2, distanceStd: 0.05 },
    );

    const res = hybridSearch(raw, {
      text: "нечто постороннее",
      scopes: ["s1"],
      caller: ANON,
      embedQuery: () => new Float32Array(384).fill(0.1),
      vectorMode: "always",
      vectorSource: spy.source,
    });

    const byId = new Map(res.hits.map((h) => [h.id, h]));
    // (0.20 − 0.05) / 0.05 = 3: заметно выделяется на фоне пула.
    expect(byId.get(strong)!.vecConfidence).toBeCloseTo(3, 5);
    // (0.20 − 0.20) / 0.05 = 0: неотличим от среднего соседа, несмотря на то
    // что это ВТОРОЙ по рангу хит с ненулевым RRF-score.
    expect(byId.get(weak)!.vecConfidence).toBeCloseTo(0, 5);
    // Верхний хит по рангу — strong, и его confidence СИЛЬНО выше, а не 1.00
    // «просто потому что он первый»: разница целиком объясняется дистанцией.
    expect(res.hits[0]!.id).toBe(strong);
    expect(res.hits[0]!.vecConfidence).toBeGreaterThan(res.hits[1]!.vecConfidence!);
    raw.close();
  });

  test("пул меньше 3 кандидатов — confidence не выдумывается, а честно undefined", () => {
    const raw = freshDb();
    const only = insertNode(raw, { title: "alpha", body: "alpha один" });
    // Пул < 3: vector.ts сам не публикует distanceMean/distanceStd в этом
    // случае (см. vector.ts) — outcome без них, и vecConfidence обязан
    // остаться undefined, а не превратиться в NaN/Infinity в выдаче.
    const source: HybridVectorSource = () => ({
      hits: [{ id: only, rank: 1, distance: 0.1 }],
      degraded: false,
      reranked: false,
      candidates: 1,
    });
    const res = hybridSearch(raw, {
      text: "нечто постороннее",
      scopes: ["s1"],
      caller: ANON,
      embedQuery: () => new Float32Array(384).fill(0.1),
      vectorMode: "always",
      vectorSource: source,
    });
    expect(res.hits[0]!.vecDistance).toBe(0.1);
    expect(res.hits[0]!.vecConfidence).toBeUndefined();
    raw.close();
  });

  test("fts-only хит без вектора не несёт vecConfidence вовсе", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha", body: "alpha один" });
    const res = hybridSearch(raw, {
      text: "alpha",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "never",
    });
    expect(res.hits[0]!.vecConfidence).toBeUndefined();
    expect(res.hits[0]!.vecDistance).toBeUndefined();
    raw.close();
  });
});

describe("hybridSearch — vectorOnly: выдача целиком на слабом векторе видна в mode_used (myc-ye3.9)", () => {
  test("лексика дала 0, вектор дал хиты -> vectorOnly=true и громкая degraded-строка", () => {
    const raw = freshDb();
    const hit = insertNode(raw, { title: "омоним", body: "совсем другой текст без пересечений" });
    const res = hybridSearch(raw, {
      text: "нечто постороннее",
      scopes: ["s1"],
      caller: ANON,
      embedQuery: () => new Float32Array(384).fill(0.1),
      vectorMode: "always",
      vectorSource: stubVector([hit]).source,
    });
    expect(res.mode_used.lexical.hits).toBe(0);
    expect(res.mode_used.vectorOnly).toBe(true);
    expect(res.mode_used.degraded.some((d) => d.startsWith("vector-only:"))).toBe(true);
    raw.close();
  });

  test("лексика тоже нашла -> vectorOnly=false, даже когда вектор участвовал", () => {
    const raw = freshDb();
    const lex = insertNode(raw, { title: "alpha", body: "alpha один" });
    const res = hybridSearch(raw, {
      text: "alpha",
      scopes: ["s1"],
      caller: ANON,
      embedQuery: () => new Float32Array(384).fill(0.1),
      vectorMode: "always",
      vectorSource: stubVector([lex]).source,
    });
    expect(res.mode_used.lexical.hits).toBeGreaterThan(0);
    expect(res.mode_used.vectorOnly).toBe(false);
    expect(res.mode_used.degraded.some((d) => d.startsWith("vector-only:"))).toBe(false);
    raw.close();
  });

  test("выдача пуста -> vectorOnly=false (нечего помечать)", () => {
    const raw = freshDb();
    const res = hybridSearch(raw, {
      text: "нечто постороннее",
      scopes: ["s1"],
      caller: ANON,
      embedQuery: () => new Float32Array(384).fill(0.1),
      vectorMode: "always",
      vectorSource: stubVector([]).source,
    });
    expect(res.hits.length).toBe(0);
    expect(res.mode_used.vectorOnly).toBe(false);
    raw.close();
  });
});

describe("hybridSearch — И2: деградация громкая", () => {
  test("нет эмбеддинга запроса -> vector: unavailable + degraded[], а не тишина", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha", body: "alpha" });
    const res = search(raw, { text: "alpha", embedQuery: () => null });
    expect(res.mode_used.trigger.fired).toBe(true);
    expect(res.mode_used.vector).toBe("unavailable");
    expect(res.mode_used.degraded.length).toBe(1);
    expect(res.mode_used.degraded[0]).toContain("query embedding unavailable");
    expect(res.mode_used.why).toContain("only from lexical");
    raw.close();
  });

  test("эмбеддера нет вовсе -> то же самое, ветка не притворяется отработавшей", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha", body: "alpha" });
    const res = search(raw, { text: "alpha" });
    expect(res.mode_used.vector).toBe("unavailable");
    expect(res.mode_used.degraded.length).toBe(1);
    raw.close();
  });

  test("настоящий vectorSearch без vec0 -> degraded с причиной, без исключения", () => {
    const raw = freshDb(); // миграция vec-001 не применялась: nodes_vec нет
    insertNode(raw, { title: "alpha", body: "alpha" });
    const { db, calls } = counting(raw);
    const res = hybridSearch(db, {
      text: "alpha",
      scopes: ["s1"],
      caller: ANON,
      embedQuery: () => new Float32Array(384).fill(0.01),
    });
    expect(res.mode_used.vector).toBe("degraded");
    expect(res.mode_used.degraded[0]).toContain("nodes_vec");
    expect(res.mode_used.vectorRoundTrips).toBe(1);
    expect(calls()).toBe(2); // 1 наш + 1 tableExists внутри vectorSearch
    expect(res.hits.length).toBeGreaterThan(0); // лексика всё равно ответила
    raw.close();
  });

  test("векторный источник отработал, но пуст -> vector: empty, degraded пуст", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha", body: "alpha" });
    const res = search(raw, {
      text: "alpha",
      embedQuery: () => new Float32Array(384),
      vectorSource: stubVector([]).source,
    });
    expect(res.mode_used.vector).toBe("empty");
    expect(res.mode_used.degraded).toEqual([]);
    raw.close();
  });

  test("mode_used есть даже у пустого ответа", () => {
    const raw = freshDb();
    const empty = search(raw, { text: "   " });
    expect(empty.hits).toEqual([]);
    expect(empty.mode_used.why).toContain("empty query");
    // Один round-trip — это счёт видимого корпуса ради объяснения пустоты
    // (S44): лексического запроса не было, но «искать нечего» и «не нашлось»
    // без этого числа неразличимы.
    expect(empty.mode_used.roundTrips).toBe(1);
    expect(empty.mode_used.emptyReason?.code).toBe("empty_query");

    const noScope = search(raw, { text: "alpha", scopes: [] });
    expect(noScope.mode_used.why).toContain("scope");
    expect(noScope.mode_used.emptyReason?.code).toBe("no_scopes");
    // Скоупов нет — считать корпус не по чему, лишнего запроса не делаем.
    expect(noScope.mode_used.roundTrips).toBe(0);
    raw.close();
  });
});

describe("hybridSearch — обход графа", () => {
  test("сосед лексического сида попадает в выдачу с источником graph", () => {
    const raw = freshDb();
    const seed = insertNode(raw, { title: "alpha", body: "alpha якорь" });
    const neighbour = insertNode(raw, { title: "сосед", body: "ни одного общего слова" });
    addEdge(raw, seed, neighbour, 0.9);

    const res = search(raw, { text: "alpha", vectorMode: "never" });
    const hit = res.hits.find((h) => h.id === neighbour);
    expect(hit).toBeDefined();
    expect(hit!.sources).toEqual(["graph"]);
    expect(hit!.ftsRank).toBeUndefined();
    expect(res.mode_used.sources).toContain("graph");
    expect(res.mode_used.graphSeeds).toBe("lexical");
    raw.close();
  });

  test("ребро легче порога не расширяет, всё так же один round-trip", () => {
    const raw = freshDb();
    const seed = insertNode(raw, { title: "alpha", body: "alpha" });
    const weak = insertNode(raw, { title: "слабый", body: "текст" });
    addEdge(raw, seed, weak, 0.1);
    const { db, calls } = counting(raw);
    const res = hybridSearch(db, {
      text: "alpha",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "never",
    });
    expect(res.hits.map((h) => h.id)).not.toContain(weak);
    expect(calls()).toBe(1);
    raw.close();
  });

  test("сосед по входящему ребру тоже находится (оба направления)", () => {
    const raw = freshDb();
    const seed = insertNode(raw, { title: "alpha", body: "alpha" });
    const inbound = insertNode(raw, { title: "входящий", body: "прочее" });
    addEdge(raw, inbound, seed, 0.8);
    const res = search(raw, { text: "alpha", vectorMode: "never" });
    expect(res.hits.map((h) => h.id)).toContain(inbound);
    raw.close();
  });

  test("граф-сосед ранжируется ниже своего сида (decay × вес ребра)", () => {
    const raw = freshDb();
    const seed = insertNode(raw, { title: "alpha", body: "alpha" });
    const neighbour = insertNode(raw, { title: "сосед", body: "прочее" });
    addEdge(raw, seed, neighbour, 1.0);
    const res = search(raw, { text: "alpha", vectorMode: "never" });
    const s = res.hits.find((h) => h.id === seed)!;
    const n = res.hits.find((h) => h.id === neighbour)!;
    expect(n.score).toBeLessThan(s.score);
    expect(n.score / s.score).toBeCloseTo(DEFAULT_HYBRID_CONFIG.graphDecayByHop[0]!, 6);
    raw.close();
  });
});

describe("hybridSearch — фильтры и границы", () => {
  test("скоуп и слой фильтруют внутри источника, до ранжирования", () => {
    const raw = freshDb();
    insertNode(raw, { title: "alpha свой", body: "alpha", scope: "s1", layer: 1 });
    insertNode(raw, { title: "alpha чужой", body: "alpha", scope: "s2", layer: 1 });
    insertNode(raw, { title: "alpha другой слой", body: "alpha", scope: "s1", layer: 3 });
    const res = search(raw, { text: "alpha", layerMin: 1, layerMax: 1, vectorMode: "never" });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.title).toBe("alpha свой");
    raw.close();
  });

  test("limit режет выдачу, ранги идут подряд с 1", () => {
    const raw = freshDb();
    for (let i = 0; i < 30; i++) insertNode(raw, { title: `alpha ${i}`, body: "alpha текст" });
    const res = search(raw, { text: "alpha", limit: 5, vectorMode: "never" });
    expect(res.hits.length).toBe(5);
    expect(res.hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
    raw.close();
  });

  test("пул источника режется poolSize", () => {
    const raw = freshDb();
    for (let i = 0; i < 40; i++) insertNode(raw, { title: `alpha ${i}`, body: "alpha текст" });
    const res = search(raw, {
      text: "alpha",
      limit: 100,
      vectorMode: "never",
      config: { poolSize: 7 },
    });
    expect(res.hits.length).toBe(7);
    raw.close();
  });

  test("выдача детерминирована при равных скорах", () => {
    const raw = freshDb();
    for (let i = 0; i < 10; i++) {
      insertNode(raw, { id: `n${i}`, title: "alpha", body: "alpha", updatedAt: 1_700_000_000_000 });
    }
    const opts = { text: "alpha", vectorMode: "never" as const, now: 1_700_000_000_000 };
    expect(search(raw, opts).hits.map((h) => h.id)).toEqual(search(raw, opts).hits.map((h) => h.id));
    raw.close();
  });
});

// ===========================================================================
// ЭКСПЕРИМЕНТ — приёмка myc-dze.3
// ===========================================================================
//
// Проверяется утверждение из постановки: «у запросов агента почти всегда есть
// точные якоря, по которым лексика работает лучше вектора; вектор нужен на
// перефразировках».
//
// ЧТО ЗДЕСЬ НАСТОЯЩЕЕ, А ЧТО СИМУЛЯЦИЯ — граница проходит ровно посередине, и
// путать эти две половины нельзя:
//
//   НАСТОЯЩЕЕ. Корпус лежит в настоящем SQLite с настоящим индексом FTS5,
//   BM25 считает fts5, запросы идут через настоящий hybridSearch. Значит
//   ЧАСТОТА СРАБАТЫВАНИЯ ТРИГГЕРА — а это и есть то решение, которое код
//   принимает в проде, — измерена без единого допущения.
//
//   СИМУЛЯЦИЯ. Векторного индекса в тестовом процессе нет (vec0 требует
//   внешней libsqlite3 и грузится только в дочернем процессе — см.
//   vector.test.ts), поэтому источник подменён оракулом с синтетическим
//   эмбеддером. Из этого следует, что recall@10 — величина направления, а не
//   абсолюта.
//
//   ДОПУЩЕНИЕ ОРАКУЛА, вынесенное в ручку ANCHOR_WEIGHTS вместо того, чтобы
//   быть спрятанным: плотный энкодер видит семантику и почти не видит точные
//   редкие строки (идентификатор дробится на сабворды и растворяется). Вес
//   якорного токена в эмбеддинге — параметр, эксперимент прогоняется на трёх
//   его значениях: 0.0 (энкодер якорь не видит вовсе), 0.25 (видит слабо,
//   ожидаемая реальность) и 1.0 (видит наравне со словами — заведомо в пользу
//   вектора). Если вывод держится на всех трёх, он не держится на допущении.

const EMBED_DIM = 384;

/** Детерминированный unit-вектор по строке (xorshift от FNV-хеша). */
function hashVec(word: string): Float32Array {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const v = new Float32Array(EMBED_DIM);
  let x = (h || 1) >>> 0;
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    const val = (x / 4294967296) * 2 - 1;
    v[i] = val;
    norm += val * val;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) v[i]! *= inv;
  return v;
}

const VEC_CACHE = new Map<string, Float32Array>();
function vecOf(key: string): Float32Array {
  let v = VEC_CACHE.get(key);
  if (v === undefined) {
    v = hashVec(key);
    VEC_CACHE.set(key, v);
  }
  return v;
}

interface Topic {
  /** Точный якорь: идентификатор, код ошибки, имя файла или символа. */
  readonly anchor: string;
  /** Словарь целевого документа. */
  readonly doc: readonly string[];
  /** Словарь перефразировки — НИ ОДНОГО общего слова с doc (проверяется тестом). */
  readonly para: readonly string[];
  /**
   * «Широкая» тема: якорь упоминается ещё в 18 коротких документах, а
   * определяющий документ длинный, поэтому BM25 ставит его НЕ первым. Так
   * выглядит часто цитируемый символ в настоящем корпусе. Плюс 12 соседей по
   * концепту — чтобы и перефразировка не попадала в топ-10 даром.
   * Без таких тем набор мерил бы только то, насколько легко устроен корпус.
   */
  readonly wide?: boolean;
}

// 22 темы × 2 вида запроса = 44 запроса (требование: не менее 40).
const TOPICS: readonly Topic[] = [
  { anchor: "vec_nodes_f32", doc: ["переранжирование", "косинус", "квантизация"], para: ["уточнить", "порядок", "дробными"] },
  { anchor: "prepareFtsQuery", doc: ["экранирование", "кавычки", "инъекция"], para: ["обезвредить", "ввод", "подстановку"] },
  { anchor: "ENOENT", doc: ["каталог", "открытие", "путь"], para: ["папка", "отсутствует", "адресу"] },
  { anchor: "oplog.seq", doc: ["журнал", "операций", "инвалидация"], para: ["лента", "изменений", "сбрасывает"] },
  { anchor: "digest_cache", doc: ["дайджест", "предвычисление", "скоуп"], para: ["сводка", "заранее", "области"] },
  { wide: true, anchor: "bm25", doc: ["лексический", "ранжирование", "термина"], para: ["классическая", "формула", "слов"] },
  { anchor: "HNSW", doc: ["приближённый", "сосед", "навигация"], para: ["быстрый", "подбор", "похожих"] },
  { anchor: "SIGSEGV", doc: ["сегментация", "падение", "стек"], para: ["аварийное", "завершение", "адресация"] },
  { wide: true, anchor: "acl_grants", doc: ["принципал", "выдача", "доступа"], para: ["кому", "разрешено", "читать"] },
  { anchor: "parent_closure", doc: ["предок", "замыкание", "глубина"], para: ["иерархия", "вложенность", "уровней"] },
  { anchor: "E1042", doc: ["таймаут", "соединения", "повтор"], para: ["связь", "оборвалась", "попытка"] },
  { anchor: "migrateVectors", doc: ["миграция", "векторной", "схемы"], para: ["перенос", "структуры", "эмбеддингов"] },
  { wide: true, anchor: "src/hybrid.ts", doc: ["слияние", "источников", "гибридный"], para: ["объединение", "нескольких", "поисков"] },
  { wide: true, anchor: "WAL", doc: ["журналирование", "фиксация", "долговечность"], para: ["запись", "переживает", "выключение"] },
  { anchor: "openSqlite", doc: ["соединение", "инициализировать", "драйвер"], para: ["подключиться", "хранилищу", "локально"] },
  { anchor: "content_hash", doc: ["дедупликация", "отпечаток", "совпадение"], para: ["одинаковые", "записи", "убираются"] },
  { anchor: "lease_expires", doc: ["аренда", "истекает", "захват"], para: ["блокировка", "протухает", "перехват"] },
  { anchor: "OOM", doc: ["память", "исчерпана", "процесс"], para: ["не", "хватило", "оперативной"] },
  { wide: true, anchor: "json_each", doc: ["развернуть", "массив", "строки"], para: ["превратить", "список", "набор"] },
  { anchor: "EAGAIN", doc: ["ресурс", "занят", "неблокирующий"], para: ["попробуйте", "позже", "готовности"] },
  { anchor: "quantizeQuery", doc: ["сжатие", "байтовое", "масштаб"], para: ["упаковка", "целыми", "коэффициент"] },
  { wide: true, anchor: "graph_expand", doc: ["обход", "рёбер", "хоп"], para: ["прогулка", "связям", "шаг"] },
];

const FILLER = [
  "система", "данные", "проект", "модуль", "работа", "текст", "значение",
  "результат", "процесс", "версия", "набор", "уровень",
];

/** Слово -> концепт темы. Строится из TOPICS; уникальность проверяется тестом. */
function buildLexicon(): Map<string, string> {
  const lex = new Map<string, string>();
  TOPICS.forEach((t, i) => {
    for (const w of [...t.doc, ...t.para]) lex.set(w, `concept:${i}`);
  });
  return lex;
}
const LEXICON = buildLexicon();

/**
 * Синтетический эмбеддер: нормированная сумма векторов «концептов» слов.
 * Слова темы и её перефразировки указывают на ОДИН концепт — так плотный
 * энкодер и перекрывает разрыв в словаре. Якорные токены концепта не имеют и
 * входят с весом anchorWeight (ручка допущения, см. шапку).
 */
function embedText(text: string, anchorWeight: number): Float32Array | null {
  const out = new Float32Array(EMBED_DIM);
  for (const raw of tokenizeQuery(text)) {
    const token = raw.toLowerCase();
    const concept = LEXICON.get(token);
    const w = concept !== undefined ? 1.0 : isAnchorToken(raw) ? anchorWeight : 0.35;
    if (w === 0) continue;
    const v = vecOf(concept ?? token);
    for (let i = 0; i < EMBED_DIM; i++) out[i]! += w * v[i]!;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += out[i]! * out[i]!;
  // Вырожденный вектор (все токены запроса имеют нулевой вес) — это НЕ
  // «эмбеддинг из нулей», по которому потом честно ранжировать: любая выдача
  // на нём была бы случайной и завышала recall. Честно вернуть null: у
  // hybridSearch для этого есть ветка vector: "unavailable" + degraded.
  if (norm === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) out[i]! *= inv;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < EMBED_DIM; i++) dot += a[i]! * b[i]!;
  return dot;
}

interface Corpus {
  readonly db: SqliteDriver;
  /** id -> эмбеддинг документа (оракул). */
  readonly vectors: ReadonlyMap<string, Float32Array>;
  /** индекс темы -> id целевого документа. */
  readonly targets: readonly string[];
}

function buildCorpus(anchorWeight: number): Corpus {
  const db = freshDb();
  const vectors = new Map<string, Float32Array>();
  const targets: string[] = [];
  const at = 1_700_000_000_000;
  const longFiller = FILLER.join(" ").repeat(6);

  const add = (title: string, body: string): string => {
    const id = insertNode(db, { title, body, updatedAt: at });
    const v = embedText(`${title} ${body}`, anchorWeight);
    if (v === null) throw new Error(`фикстура: документ ${id} дал вырожденный эмбеддинг`);
    vectors.set(id, v);
    return id;
  };

  TOPICS.forEach((t, ti) => {
    const siblings = t.wide ? 12 : 2;

    if (t.wide === true) {
      // определяющий документ: якорь утоплен в длинном теле, в заголовке его
      // нет — BM25 поставит его НИЖЕ коротких упоминаний
      targets.push(
        add(
          `${t.doc[0]} ${t.doc[1]}`,
          `${t.doc.join(" ")} ${longFiller} ${t.anchor} ${longFiller} ${FILLER[ti % FILLER.length]}`,
        ),
      );
      // 18 коротких упоминаний того же якоря из чужих тем
      for (let k = 0; k < 18; k++) {
        add(`${t.anchor} упоминание${k}`, `ссылка ${t.anchor} ${FILLER[(ti + k) % FILLER.length]}`);
      }
    } else {
      targets.push(
        add(
          `${t.anchor} ${t.doc[0]} ${t.doc[1]}`,
          `${t.doc.join(" ")} ${FILLER[ti % FILLER.length]} ${FILLER[(ti + 3) % FILLER.length]}`,
        ),
      );
    }

    // соседи по концепту БЕЗ якоря: вектор обязан их путать с целевым, иначе
    // задача была бы искусственно лёгкой для векторной ветки
    for (let k = 0; k < siblings; k++) {
      add(
        `${t.doc[1]} ${t.doc[2]}`,
        `${t.doc.join(" ")} ${FILLER[(ti + k + 1) % FILLER.length]} побочная заметка ${k}`,
      );
    }
  });

  // общий шум: документы без отношения к темам
  for (let i = 0; i < 60; i++) {
    const words = [FILLER[i % FILLER.length]!, FILLER[(i * 5 + 2) % FILLER.length]!, `шум${i}`];
    add(words.join(" "), `${words.join(" ")} служебная запись номер ${i}`);
  }

  return { db, vectors, targets };
}

type QueryKind = "anchor" | "paraphrase";
interface BenchQuery {
  readonly kind: QueryKind;
  readonly text: string;
  readonly targetIndex: number;
}

function buildQueries(): BenchQuery[] {
  const out: BenchQuery[] = [];
  TOPICS.forEach((t, i) => {
    // вид 1 — точный якорь: половина голых, половина с одним словом контекста
    out.push({
      kind: "anchor",
      text: i % 2 === 0 ? t.anchor : `${t.anchor} ${t.doc[0]}`,
      targetIndex: i,
    });
    // вид 2 — перефразировка: ни одного общего слова с целевым документом
    out.push({ kind: "paraphrase", text: t.para.join(" "), targetIndex: i });
  });
  return out;
}

/** Оракул: косинус по эмбеддингам корпуса, топ-N. Базу не трогает. */
function oracleSource(corpus: Corpus): HybridVectorSource {
  return (_db, params: VectorSearchParams): VectorSearchOutcome => {
    const scored: { id: string; s: number }[] = [];
    for (const [id, v] of corpus.vectors) scored.push({ id, s: cosine(params.vector, v) });
    scored.sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
    const limit = params.limit ?? 12;
    return {
      hits: scored.slice(0, limit).map((r, i) => ({ id: r.id, rank: i + 1, distance: 1 - r.s })),
      degraded: false,
      reranked: true,
      candidates: scored.length,
    };
  };
}

function pct(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

interface QueryOutcome {
  readonly found: boolean;
  readonly usedVector: boolean;
  readonly ms: number;
}

interface RunStats {
  readonly per: readonly QueryOutcome[];
  readonly retrieval: readonly number[];
}

function runMode(
  corpus: Corpus,
  queries: readonly BenchQuery[],
  mode: "auto" | "always" | "never",
  anchorWeight: number,
  repeats: number,
): RunStats {
  const source = oracleSource(corpus);
  const per: QueryOutcome[] = [];
  const retrieval: number[] = [];

  for (let r = 0; r < repeats; r++) {
    queries.forEach((q, qi) => {
      const t0 = Bun.nanoseconds();
      const res = hybridSearch(corpus.db, {
        text: q.text,
        scopes: ["s1"],
        caller: ANON,
        limit: 10,
        now: 1_700_000_000_000,
        vectorMode: mode,
        embedQuery: () => embedText(q.text, anchorWeight),
        vectorSource: source,
      });
      const ms = (Bun.nanoseconds() - t0) / 1e6;
      retrieval.push(ms);
      if (r === 0) {
        per[qi] = {
          found: res.hits.some((h) => h.id === corpus.targets[q.targetIndex]),
          // «подключился» = эмбеддинг реально считался. unavailable/degraded
          // тоже платят за попытку, но вектора в выдаче не дают.
          usedVector: res.mode_used.vector === "used" || res.mode_used.vector === "empty",
          ms,
        };
      }
    });
  }
  return { per, retrieval };
}

function share(per: readonly QueryOutcome[], pick: (o: QueryOutcome) => boolean): number {
  return per.length === 0 ? 0 : per.filter(pick).length / per.length;
}

// Замер координатора (S31): эмбеддинг одного запроса на реальной модели.
const EMBED_P50_MS = 23.3;
const EMBED_P95_MS = 98.9;

const P = (x: number) => `${(x * 100).toFixed(1)}%`;
const MS = (x: number) => `${x.toFixed(2)} мс`;

describe("эксперимент myc-dze.3 — якоря против перефразировок", () => {
  const queries = buildQueries();

  test("набор корректен: 44 запроса двух видов, словари не пересекаются", () => {
    expect(queries.length).toBe(44);
    expect(queries.filter((q) => q.kind === "anchor").length).toBe(22);
    expect(queries.filter((q) => q.kind === "paraphrase").length).toBe(22);

    // ни одно слово не принадлежит двум темам — иначе оракул склеил бы концепты
    const seen = new Set<string>();
    for (const t of TOPICS) {
      for (const w of [...t.doc, ...t.para]) {
        expect(seen.has(w)).toBe(false);
        seen.add(w);
      }
    }
    // перефразировка не делит НИ ОДНОГО слова с целевым документом
    for (const t of TOPICS) {
      const docWords = new Set([t.anchor.toLowerCase(), ...t.doc]);
      for (const w of t.para) expect(docWords.has(w)).toBe(false);
    }
    for (const t of TOPICS) expect(isAnchorToken(t.anchor)).toBe(true);
  });

  const ANCHOR_WEIGHTS = [0.0, 0.25, 1.0];
  /**
   * Сколько раз прогоняется каждый запрос. На ИСХОДЫ (нашлось / подключился ли
   * вектор) повторы не влияют вовсе — `runMode` заполняет `per` только на
   * первом проходе; повторы нужны исключительно распределению ВРЕМЕНИ в
   * отчётной таблице. Поэтому утверждения гоняются с одним повтором и
   * укладываются в обычный лимит, а отчёт — с пятнадцатью и со своим.
   */
  const REPORT_REPEATS = 15;

  const anchorIdx = queries.map((q, i) => (q.kind === "anchor" ? i : -1)).filter((i) => i >= 0);
  const paraIdx = queries.map((q, i) => (q.kind === "paraphrase" ? i : -1)).filter((i) => i >= 0);
  const pickBy = (st: RunStats, idx: readonly number[]) => idx.map((i) => st.per[i]!);

  interface Collected {
    w: number;
    corpusSize: number;
    auto: RunStats;
    always: RunStats;
    never: RunStats;
  }

  function collect(repeats: number): Collected[] {
    const out: Collected[] = [];
    for (const w of ANCHOR_WEIGHTS) {
      const corpus = buildCorpus(w);
      out.push({
        w,
        corpusSize: corpus.vectors.size,
        auto: runMode(corpus, queries, "auto", w, repeats),
        always: runMode(corpus, queries, "always", w, repeats),
        never: runMode(corpus, queries, "never", w, repeats),
      });
      corpus.db.close();
    }
    return out;
  }

  /**
   * УТВЕРЖДЕНИЯ. Отделены от отчёта не из аккуратности, а потому что отчёт
   * падал по таймауту: 7.06–7.46 с при лимите 5 с, причём с graphMaxHops=0 и
   * =2 одинаково — то есть тест сообщал о загрузке машины, а не о коде
   * (memory-ws31ztqgh43c). Печать таблицы не имеет права ронять сборку;
   * проверять выводы эксперимента — имеет, и здесь это делается за один
   * повтор вместо пятнадцати.
   */
  test("выводы myc-dze.3: условный режим не теряет recall и дешевле обязательного", () => {
    const collected = collect(1);
    const mid = collected[1]!; // anchorWeight = 0.25 — ожидаемая реальность
    const shareAnchor = share(pickBy(mid.auto, anchorIdx), (o) => o.usedVector);
    const sharePara = share(pickBy(mid.auto, paraIdx), (o) => o.usedVector);

    for (const c of collected) {
      const rAlways = share(c.always.per, (o) => o.found);
      const rAuto = share(c.auto.per, (o) => o.found);
      // условный режим не теряет recall относительно обязательного
      expect(rAuto).toBeGreaterThanOrEqual(rAlways - 1e-9);
      // и не дороже него
      expect(share(c.auto.per, (o) => o.usedVector)).toBeLessThanOrEqual(
        share(c.always.per, (o) => o.usedVector),
      );
    }
    // главный вывод: на перефразировках вектор нужен, на якорях — почти никогда
    expect(sharePara).toBeGreaterThan(shareAnchor);
    expect(sharePara).toBeGreaterThan(0.9);
    expect(shareAnchor).toBeLessThan(0.25);
    // без вектора перефразировки не находятся вовсе, якорные — находятся
    expect(share(pickBy(mid.never, paraIdx), (o) => o.found)).toBeLessThan(0.1);
    expect(share(pickBy(mid.never, anchorIdx), (o) => o.found)).toBeGreaterThan(0.8);
  });

  /**
   * ОТЧЁТ. Ничего не утверждает — печатает таблицы, ради которых эксперимент
   * и ставился. Лимит 120 с назван честно: это НЕ бюджет и не проверка, а
   * потолок «что-то зациклилось». Измеренная цена — 7.1–7.5 с на тёплой
   * машине под общим прогоном.
   */
  test("ОТЧЁТ: recall@10, доля вектора, время — по видам запросов", () => {
    const REPEATS = REPORT_REPEATS;
    const lines: string[] = [];
    const collected = collect(REPEATS);
    const mid = collected[1]!; // anchorWeight = 0.25 — ожидаемая реальность

    lines.push("");
    lines.push("=== myc-dze.3 — условная векторная ветка ===");
    lines.push(`Набор: 44 запроса (22 с точным якорем + 22 перефразировки без общих слов).`);
    lines.push(`Корпус: ${mid.corpusSize} узлов в настоящем SQLite/FTS5. Вектор — оракул (см. шапку файла).`);
    lines.push("");

    // --- 1. частота срабатывания: НАСТОЯЩИЕ числа, от допущения не зависят
    const shareAnchor = share(pickBy(mid.auto, anchorIdx), (o) => o.usedVector);
    const sharePara = share(pickBy(mid.auto, paraIdx), (o) => o.usedVector);
    const shareAll = share(mid.auto.per, (o) => o.usedVector);
    lines.push("1. Доля запросов, где подключился вектор (условный режим).");
    lines.push("   Решение принимает настоящий BM25 настоящего FTS5 — допущений оракула здесь нет.");
    lines.push(`   якорные запросы:   ${P(shareAnchor)}`);
    lines.push(`   перефразировки:    ${P(sharePara)}`);
    lines.push(`   весь набор:        ${P(shareAll)}`);
    lines.push("");

    // --- 2. recall@10
    lines.push("2. recall@10 — обязательный вектор против условного против «без вектора».");
    lines.push("   anchorWeight — вес якорного токена в синтетическом эмбеддере (ручка допущения).");
    lines.push("");
    lines.push("   anchorWeight | вид            | всегда | условно | без вектора | вектор спас");
    lines.push("   -------------|----------------|--------|---------|-------------|------------");
    for (const c of collected) {
      const rows: [string, readonly number[]][] = [
        ["якорь", anchorIdx],
        ["перефразировка", paraIdx],
        ["весь набор", queries.map((_, i) => i)],
      ];
      for (const [name, idx] of rows) {
        const rAlways = share(pickBy(c.always, idx), (o) => o.found);
        const rAuto = share(pickBy(c.auto, idx), (o) => o.found);
        const rNever = share(pickBy(c.never, idx), (o) => o.found);
        // «спас» — запросов, где без вектора цель не нашлась, а с условным нашлась
        const rescued = idx.filter((i) => !c.never.per[i]!.found && c.auto.per[i]!.found).length;
        lines.push(
          `   ${(name === "якорь" ? c.w.toFixed(2) : "").padEnd(12)} | ${name.padEnd(14)} | ` +
            `${P(rAlways).padStart(6)} | ${P(rAuto).padStart(7)} | ${P(rNever).padStart(11)} | ` +
            `${String(rescued).padStart(11)}`,
        );
      }
      lines.push("   -------------|----------------|--------|---------|-------------|------------");
    }
    // цена ложных срабатываний: вектор подключили, а выдача не улучшилась
    const firedIdx = queries.map((_, i) => i).filter((i) => mid.auto.per[i]!.usedVector);
    const wasted = firedIdx.filter((i) => mid.never.per[i]!.found === mid.auto.per[i]!.found);
    lines.push(
      `   впустую: из ${firedIdx.length} подключений вектора ${wasted.length} не изменили выдачу ` +
        `(${wasted.filter((i) => queries[i]!.kind === "anchor").length} из них — якорные запросы).`,
    );
    lines.push("");

    // --- 3. время
    lines.push("3. Время. «Ретривал» измерен здесь; «полное» = ретривал + стоимость эмбеддинга по");
    lines.push(`   S31 (p50 ${EMBED_P50_MS} мс / p95 ${EMBED_P95_MS} мс) в тех запросах, где ветка подключалась.`);
    lines.push("");
    const totals = (st: RunStats, cost: number) => st.per.map((o) => o.ms + (o.usedVector ? cost : 0));
    lines.push("   режим          | ретривал p50 | ретривал p95 | полное p50 | полное p90 | полное p95");
    lines.push("   ---------------|--------------|--------------|------------|------------|------------");
    for (const [name, st] of [
      ["вектор всегда", mid.always],
      ["вектор условно", mid.auto],
      ["вектора нет", mid.never],
    ] as const) {
      const t50 = totals(st, EMBED_P50_MS);
      const t95 = totals(st, EMBED_P95_MS);
      lines.push(
        `   ${name.padEnd(14)} | ${MS(pct(st.retrieval, 50)).padStart(12)} | ${MS(pct(st.retrieval, 95)).padStart(12)} | ` +
          `${MS(pct(t50, 50)).padStart(10)} | ${MS(pct(t50, 90)).padStart(10)} | ${MS(pct(t95, 95)).padStart(10)}`,
      );
    }
    lines.push("");

    // --- 4. экономия как функция состава нагрузки. Тестовый набор 50/50 задан
    //     требованием задачи и НЕ является оценкой частот в проде.
    lines.push("4. Экономия зависит от состава нагрузки, а не от набора. Ожидаемая стоимость");
    lines.push("   эмбеддинга на запрос = (доля якорных × 13.6% + доля перефразировок × 100%) × 23.3 мс.");
    lines.push("");
    lines.push("   состав (якорь/перефразировка) | доля вектора | эмбеддинг на запрос | экономия против «всегда»");
    lines.push("   ------------------------------|--------------|---------------------|-------------------------");
    for (const [a, b] of [
      [50, 50],
      [70, 30],
      [80, 20],
      [90, 10],
      [95, 5],
    ] as const) {
      const rate = (a / 100) * shareAnchor + (b / 100) * sharePara;
      const cost = rate * EMBED_P50_MS;
      lines.push(
        `   ${`${a}/${b}`.padEnd(29)} | ${P(rate).padStart(12)} | ${MS(cost).padStart(19)} | ${MS(EMBED_P50_MS - cost).padStart(24)}`,
      );
    }
    lines.push("");
    lines.push("   p95 отдельная история: он перестаёт определяться эмбеддингом только когда доля");
    lines.push("   вектора падает ниже 5%. При любой правдоподобной нагрузке условный режим");
    lines.push("   выигрывает медиану, а хвост оставляет прежним. Это не отговорка, а следствие");
    lines.push("   того, что перефразировки вектор всё-таки требуют.");
    lines.push("");
    console.log(lines.join("\n"));
    // Утверждений здесь нет намеренно — они в тесте выше и стоят один повтор.
  }, 120_000);

  test("mode_used не врёт ни в одном из 44 запросов", () => {
    const corpus = buildCorpus(0.25);
    const source = oracleSource(corpus);
    for (const q of buildQueries()) {
      const { db, calls } = counting(corpus.db);
      const res = hybridSearch(db, {
        text: q.text,
        scopes: ["s1"],
        caller: ANON,
        limit: 10,
        vectorMode: "auto",
        embedQuery: () => embedText(q.text, 0.25),
        vectorSource: source,
      });
      // счётчик round-trip'ов — не оценка: оракул к базе не ходит,
      // значит все обращения принадлежат hybridSearch
      expect(res.mode_used.roundTrips).toBe(calls());
      // объявленные источники совпадают с фактическими рангами в выдаче
      const declared = new Set(res.mode_used.sources);
      const actual = new Set(res.hits.flatMap((h) => h.sources));
      expect([...declared].sort()).toEqual([...actual].sort());
      // вектор объявлен использованным <=> у кого-то есть vecRank
      const anyVecRank = res.hits.some((h) => h.vecRank !== undefined);
      if (anyVecRank) expect(res.mode_used.vector).toBe("used");
      if (res.mode_used.vector === "skipped") {
        expect(res.mode_used.trigger.fired).toBe(false);
        expect(anyVecRank).toBe(false);
      }
      expect(res.mode_used.why.length).toBeGreaterThan(10);
    }
    corpus.db.close();
  });
});

// --------------------------- perf: 100k узлов --------------------------------
//
// Бюджет И1 — 25 мс на гибридный поиск при 100k узлов, ПРИ ГОТОВОМ ВЕКТОРЕ
// (S31(а)). Здесь мерится лексический путь целиком — пул, обход графа и
// гидратация в одном операторе, — то есть ровно то, что видит запрос, когда
// триггер не сработал. Это и есть большинство запросов агента.

const PERF_WORDS = [
  "memory", "consensus", "replication", "vector", "index", "graph", "search",
  "cache", "session", "fragment", "entity", "anchor", "skill", "task", "note",
  "layer", "scope", "acl", "distributed", "system", "cold", "hot", "warm",
  "prime", "salience", "priority", "score", "rank", "hybrid", "retrieval",
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("hybridSearch perf @ 100k узлов", () => {
  test("лексический путь укладывается в бюджет И1", () => {
    const db = freshDb();
    const rand = mulberry32(4242);
    const N = 100_000;
    const now = Date.now();

    db.database.exec("BEGIN");
    const stmt = db.database.query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, status, content_hash, acl, team_id, created_at, updated_at)
       VALUES (?1, 'note', ?2, ?3, ?4, ?5, '', 'active', ?6, 'team', ?7, ?8, ?8)`,
    );
    for (let i = 0; i < N; i++) {
      const words: string[] = [];
      for (let k = 0; k < 40; k++) words.push(PERF_WORDS[Math.floor(rand() * PERF_WORDS.length)]!);
      // селективность ~1/500, как в замере fts: иначе меряли бы сортировку
      // почти всей таблицы, а не поиск
      const body = i % 500 === 0 ? `needle ${words.slice(1).join(" ")}` : words.join(" ");
      stmt.run(
        `hp-${i.toString(36).padStart(12, "0")}`,
        (i % 4) as 0 | 1 | 2 | 3,
        i % 20 === 0 ? "target" : `s${i % 50}`,
        `Node ${i}`,
        body,
        `hash-hp-${i}`,
        "t1",
        now,
      );
    }
    // рёбра между соседними узлами: обход графа в том же операторе должен
    // мериться вместе с лексикой, а не отдельно
    const edgeStmt = db.database.query(
      `INSERT INTO edges (src, type, dst, weight, add_tag, created_at) VALUES (?1, 'relates', ?2, 0.8, ?3, ?4)`,
    );
    for (let i = 0; i < N; i += 500) {
      const src = `hp-${i.toString(36).padStart(12, "0")}`;
      const dst = `hp-${(i + 1).toString(36).padStart(12, "0")}`;
      edgeStmt.run(src, dst, `tag-${i}`, now);
    }
    db.database.exec("COMMIT");

    const caller: FtsCaller = { ownerId: "", teamId: "t1", agentId: "", principals: [] };
    const once = () =>
      hybridSearch(db, {
        text: "needle",
        scopes: ["target", "s1", "s2", "s3"],
        caller,
        limit: 12,
        vectorMode: "never",
      });
    const first = once();
    expect(first.hits.length).toBeGreaterThan(0);
    expect(first.mode_used.roundTrips).toBe(1);

    // Порог 5 мс — не бюджет И1 (тот 25 мс на весь гибридный поиск), а сторож
    // против регрессии планировщика: без CROSS JOIN-подсказок SQLite заходил
    // со стороны nodes/edges и путь стоил 4.7 мс вместо 0.8. Абсолют
    // проверяется только при годных условиях замера (@myc/bench (packages/bench/src/index.ts)):
    // запас всего ×2 от наблюдаемых p95, а стенное время зависит от загрузки
    // машины — это ровно тот класс, что дал три ложные тревоги за день
    // (memory-ws31ztqgh43c).
    const m = measure("hybrid perf @ 100k, лексический путь", () => void once(), {
      warmup: 20,
      iters: 200,
      budgetMs: 5,
    });
    report(m, "бюджет И1 на весь гибридный поиск — 25 мс");
    expectWithinBudget(m);
    db.close();
  }, 60_000);
});
