import { describe, expect, test } from "bun:test";
import { expectMsWithinBudget } from "@myc/bench";
import { generateId, type DbDriver } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { ftsSearch, prepareFtsQuery, type FtsCaller } from "./fts.ts";

const ANON_CALLER: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

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
  readonly status?: string;
  readonly headId?: string | null;
  readonly acl?: "private" | "team" | "restricted" | "agent";
  readonly ownerId?: string;
  readonly teamId?: string;
  readonly agentId?: string;
}

function insertNode(db: SqliteDriver, seed: NodeSeed): string {
  const id = seed.id ?? generateId();
  const now = Date.now();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, status, head_id, content_hash, acl, owner_id, team_id, agent_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
    )
    .run(
      id,
      seed.kind ?? "note",
      seed.layer ?? 1,
      seed.scope ?? "s1",
      seed.title ?? "",
      seed.body ?? "",
      seed.status ?? "active",
      seed.headId ?? null,
      `hash-${id}`,
      seed.acl ?? "team",
      seed.ownerId ?? "",
      seed.teamId ?? "",
      seed.agentId ?? "",
      now,
    );
  return id;
}

function grant(db: SqliteDriver, nodeId: string, principal: string, level = "read"): void {
  db.database
    .query(
      `INSERT INTO acl_grants (node_id, principal, level, granted_at) VALUES (?1, ?2, ?3, ?4)`,
    )
    .run(nodeId, principal, level, Date.now());
}

// --------------------------- prepareFtsQuery --------------------------------

describe("prepareFtsQuery", () => {
  test("пустая строка -> null", () => {
    expect(prepareFtsQuery("")).toBeNull();
    expect(prepareFtsQuery("   ")).toBeNull();
  });

  test("строка из одних спецсимволов FTS5 -> null (нет термов)", () => {
    expect(prepareFtsQuery("-- ** (( )) :: \"\"")).toBeNull();
    expect(prepareFtsQuery("OR AND NOT NEAR")).not.toBeNull(); // это слова, не операторы вне контекста
  });

  test("одно слово оборачивается в кавычки", () => {
    expect(prepareFtsQuery("hello")).toBe('"hello"');
  });

  test("несколько слов -> AND отдельных кавычных термов", () => {
    expect(prepareFtsQuery("hello world")).toBe('"hello" "world"');
  });

  test("явный префикс term* сохраняется как \"term\"*", () => {
    expect(prepareFtsQuery("distrib*")).toBe('"distrib"*');
  });

  test("фраза в кавычках остаётся фразой", () => {
    expect(prepareFtsQuery('"hello world"')).toBe('"hello world"');
  });

  test("незакрытая кавычка не ломает запрос: остаток строки становится одной буквальной фразой", () => {
    const out = prepareFtsQuery('foo" OR 1=1 --');
    // "foo" — отдельный терм; всё после непарной кавычки — один кавыченный
    // блок (OR внутри него — буквальное слово, не оператор).
    expect(out).toBe('"foo" "OR 1 1"');
  });

  test("операторы NEAR/OR/скобки не собираются в валидный FTS5-оператор", () => {
    const out = prepareFtsQuery("NEAR(foo, bar) OR baz*");
    expect(out).toBe('"NEAR" "foo" "bar" "OR" "baz"*');
  });

  test("дефис и точка внутри слова сохраняются одним термом (tokenchars)", () => {
    expect(prepareFtsQuery("foo-bar.baz")).toBe('"foo-bar.baz"');
  });
});

// --------------------------- ftsSearch: functional --------------------------

describe("ftsSearch", () => {
  test("находит по точному слову", () => {
    const db = freshDb();
    const id = insertNode(db, { title: "Distributed systems", body: "consensus and replication" });
    insertNode(db, { title: "Cooking", body: "pasta recipe" });

    const hits = ftsSearch(db, {
      text: "consensus",
      scopes: ["s1"],
      caller: ANON_CALLER,
    });

    expect(hits.map((h) => h.id)).toEqual([id]);
    expect(hits[0]!.rank).toBe(1);
    db.close();
  });

  test("находит по префиксу", () => {
    const db = freshDb();
    const id = insertNode(db, { title: "Distributed systems", body: "" });

    const hits = ftsSearch(db, {
      text: "distrib*",
      scopes: ["s1"],
      caller: ANON_CALLER,
    });

    expect(hits.map((h) => h.id)).toEqual([id]);
    db.close();
  });

  test("находит по фразе (порядок слов важен)", () => {
    const db = freshDb();
    const match = insertNode(db, { title: "", body: "hot memory cache warm" });
    const noMatch = insertNode(db, { title: "", body: "memory of a hot afternoon, cache warm" });

    const hits = ftsSearch(db, {
      text: '"hot memory"',
      scopes: ["s1"],
      caller: ANON_CALLER,
    });

    const ids = hits.map((h) => h.id);
    expect(ids).toContain(match);
    expect(ids).not.toContain(noMatch);
    db.close();
  });

  test("строка со спецсимволами FTS5 не ломает запрос и не расширяет выдачу", () => {
    const db = freshDb();
    insertNode(db, { title: "Alpha", body: "safe content" });
    insertNode(db, { title: "Beta", body: "other content" });

    expect(() =>
      ftsSearch(db, {
        text: 'alpha" OR 1=1 OR body MATCH \'*\'--',
        scopes: ["s1"],
        caller: ANON_CALLER,
      }),
    ).not.toThrow();

    const hits = ftsSearch(db, {
      text: 'alpha" OR 1=1 OR body MATCH \'*\'--',
      scopes: ["s1"],
      caller: ANON_CALLER,
    });
    // Инъекция не должна была протащить второй узел через "OR"/"MATCH '*'" как операторы —
    // каждый кусок стал буквальным кавыченным термом, поэтому ищем буквальные "alpha" и "or" и т.д.,
    // ни один узел с ними не пересекается -> пусто, не "все узлы".
    expect(hits.length).toBe(0);
    db.close();
  });

  test("пустая строка и строка из стоп-символов дают пустой результат, не ошибку", () => {
    const db = freshDb();
    insertNode(db, { title: "Alpha", body: "content" });

    expect(ftsSearch(db, { text: "", scopes: ["s1"], caller: ANON_CALLER })).toEqual([]);
    expect(
      ftsSearch(db, { text: "-- ** (( ))", scopes: ["s1"], caller: ANON_CALLER }),
    ).toEqual([]);
    db.close();
  });

  test("фильтр по scope реально сужает выдачу", () => {
    const db = freshDb();
    const inScope = insertNode(db, { scope: "s1", title: "shared term", body: "" });
    insertNode(db, { scope: "s2", title: "shared term", body: "" });

    const hits = ftsSearch(db, { text: "shared term", scopes: ["s1"], caller: ANON_CALLER });
    expect(hits.map((h) => h.id)).toEqual([inScope]);
    db.close();
  });

  test("фильтр по слою сужает выдачу", () => {
    const db = freshDb();
    const l2 = insertNode(db, { layer: 2, title: "layerword", body: "" });
    insertNode(db, { layer: 0, title: "layerword", body: "" });

    const hits = ftsSearch(db, {
      text: "layerword",
      scopes: ["s1"],
      layerMin: 2,
      layerMax: 3,
      caller: ANON_CALLER,
    });
    expect(hits.map((h) => h.id)).toEqual([l2]);
    db.close();
  });

  test("superseded (head_id задан) исключается", () => {
    const db = freshDb();
    const head = insertNode(db, { title: "versioned term", body: "" });
    insertNode(db, { title: "versioned term", body: "", headId: head });

    const hits = ftsSearch(db, { text: "versioned term", scopes: ["s1"], caller: ANON_CALLER });
    expect(hits.map((h) => h.id)).toEqual([head]);
    db.close();
  });

  test("status='superseded' исключается", () => {
    const db = freshDb();
    const active = insertNode(db, { title: "statusword", body: "" });
    insertNode(db, { title: "statusword", body: "", status: "superseded" });

    const hits = ftsSearch(db, { text: "statusword", scopes: ["s1"], caller: ANON_CALLER });
    expect(hits.map((h) => h.id)).toEqual([active]);
    db.close();
  });

  test("удалённые узлы (deleted_at) исключаются", () => {
    const db = freshDb();
    const id = insertNode(db, { title: "delword", body: "" });
    db.database.query(`UPDATE nodes SET deleted_at = ?1 WHERE id = ?2`).run(Date.now(), id);

    const hits = ftsSearch(db, { text: "delword", scopes: ["s1"], caller: ANON_CALLER });
    expect(hits).toEqual([]);
    db.close();
  });

  describe("ACL", () => {
    test("team: видно только своей команде", () => {
      const db = freshDb();
      const mine = insertNode(db, { title: "teamword", acl: "team", teamId: "t1" });
      insertNode(db, { title: "teamword", acl: "team", teamId: "t2" });

      const hits = ftsSearch(db, {
        text: "teamword",
        scopes: ["s1"],
        caller: { ownerId: "", teamId: "t1", agentId: "", principals: [] },
      });
      expect(hits.map((h) => h.id)).toEqual([mine]);
      db.close();
    });

    test("private: видно только владельцу", () => {
      const db = freshDb();
      const mine = insertNode(db, { title: "privword", acl: "private", ownerId: "u1" });
      insertNode(db, { title: "privword", acl: "private", ownerId: "u2" });

      const hits = ftsSearch(db, {
        text: "privword",
        scopes: ["s1"],
        caller: { ownerId: "u1", teamId: "", agentId: "", principals: [] },
      });
      expect(hits.map((h) => h.id)).toEqual([mine]);
      db.close();
    });

    test("agent: видно только своему агенту", () => {
      const db = freshDb();
      const mine = insertNode(db, { title: "agword", acl: "agent", agentId: "a1" });
      insertNode(db, { title: "agword", acl: "agent", agentId: "a2" });

      const hits = ftsSearch(db, {
        text: "agword",
        scopes: ["s1"],
        caller: { ownerId: "", teamId: "", agentId: "a1", principals: [] },
      });
      expect(hits.map((h) => h.id)).toEqual([mine]);
      db.close();
    });

    test("restricted: видно только тем, кому выдан grant", () => {
      const db = freshDb();
      const granted = insertNode(db, { title: "restword", acl: "restricted" });
      grant(db, granted, "user:u1");
      const notGranted = insertNode(db, { title: "restword", acl: "restricted" });
      grant(db, notGranted, "user:u2");

      const hits = ftsSearch(db, {
        text: "restword",
        scopes: ["s1"],
        caller: { ownerId: "", teamId: "", agentId: "", principals: ["user:u1"] },
      });
      expect(hits.map((h) => h.id)).toEqual([granted]);
      db.close();
    });
  });

  test("дубликаты убраны (уникальные id, даже если бы MATCH дал несколько попаданий)", () => {
    const db = freshDb();
    const id = insertNode(db, { title: "dupword dupword", body: "dupword" });

    const hits = ftsSearch(db, { text: "dupword", scopes: ["s1"], caller: ANON_CALLER });
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe(id);
    db.close();
  });

  test("limit ограничивает и клампится к [1, 100]", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) insertNode(db, { title: "limword", body: "" });

    expect(ftsSearch(db, { text: "limword", scopes: ["s1"], caller: ANON_CALLER, limit: 2 }).length).toBe(2);
    expect(
      ftsSearch(db, { text: "limword", scopes: ["s1"], caller: ANON_CALLER, limit: 100000 }).length,
    ).toBe(5);
  });
});

// --------------------------- perf: 100k nodes -------------------------------

const WORDS = [
  "memory", "consensus", "replication", "vector", "index", "graph", "search",
  "cache", "session", "fragment", "entity", "anchor", "skill", "task", "note",
  "layer", "scope", "acl", "distributed", "system", "cold", "hot", "warm",
  "prime", "salience", "priority", "score", "rank", "hybrid", "retrieval",
];

function randomBody(rand: () => number, wordCount: number): string {
  const out: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    out.push(WORDS[Math.floor(rand() * WORDS.length)]!);
  }
  return out.join(" ");
}

// xorshift32 — детерминированный, без зависимостей.
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

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

describe("ftsSearch perf @ 100k nodes", () => {
  test("p50/p95 замер", () => {
    const db = freshDb();
    const rand = mulberry32(42);
    const N = 100_000;

    db.database.exec("BEGIN");
    const stmt = db.database.query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, status, content_hash, acl, team_id, created_at, updated_at)
       VALUES (?1, 'note', ?2, ?3, ?4, ?5, 'active', ?6, 'team', ?7, ?8, ?8)`,
    );
    const now = Date.now();
    // "needle" примешивается к ~1 из 500 узлов (≈200 из 100k) — реалистичная
    // селективность полнотекстового запроса. Без этого случайный корпус из
    // маленького словаря делает почти каждый документ совпадением, и замер
    // мерил бы не поиск, а сортировку почти всей таблицы.
    for (let i = 0; i < N; i++) {
      const scope = i % 20 === 0 ? "target" : `s${i % 50}`;
      const body = i % 500 === 0 ? `needle ${randomBody(rand, 39)}` : randomBody(rand, 40);
      stmt.run(
        `perf-${i.toString(36).padStart(12, "0")}`,
        (i % 4) as 0 | 1 | 2 | 3,
        scope,
        `Node ${i}`,
        body,
        `hash-perf-${i}`,
        "t1",
        now,
      );
    }
    db.database.exec("COMMIT");

    const runs = 200;
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      ftsSearch(db, {
        text: "needle",
        scopes: ["target", "s1", "s2", "s3"],
        caller: { ownerId: "", teamId: "t1", agentId: "", principals: [] },
        limit: 12,
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);

    // eslint-disable-next-line no-console
    console.log(`[fts perf @ 100k] p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);

    // Бюджет спеки — 2-4мс. Не подгоняем: если больше, тест явно упадёт
    // с фактическими числами в выводе выше, а не молча зазеленеет — на
    // откалиброванной (не MYC_BENCH_ABSOLUTE=0) и свободной машине. Прежде
    // граница стояла голой: под yes × 14 (load1 30) p95 вырос с 0.38 до
    // 2.07 мс при неизменном коде, запас к 4 мс — вдвое; раннер CI (4 ядра
    // x86) медленнее этой машины на тех же операциях в 1.2–2 раза.
    expectMsWithinBudget(p95, 4, "fts @100k, p95");

    db.close();
  }, 60_000);
});
