/**
 * Кеши ретривала: результаты поиска и гидратация узлов (§2.6).
 *
 * Главная опасность кеша не в том, что он медленный, а в том, что
 * устаревший ответ ВНЕШНЕ НЕОТЛИЧИМ от свежего. Поэтому здесь почти нет
 * тестов «кеш ускоряет» и почти все — «кеш не врёт»: после записи (в том
 * числе из соседнего процесса) следующий запрос обязан увидеть её.
 *
 * Числа, ради которых задача существует, печатаются в конце файла:
 * во сколько раз дешевле попадание, доля попаданий на сценарии сессии
 * и сколько памяти держит полный кеш.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, type DbDriver } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import { hybridSearch, type HybridResult } from "./hybrid.ts";
import {
  DEFAULT_RESULT_TTL_MS,
  HYDRATION_INVALIDATE_CAP,
  NodeHydrationCache,
  SearchResultCache,
  DEFAULT_RESULT_CACHE_MAX,
  DEFAULT_HYDRATION_CACHE_MAX,
  readOplogSeq,
  searchCacheKey,
  normalizeCacheQuery,
} from "./cache.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

function freshDb(path = ":memory:"): SqliteDriver {
  const driver = openSqlite(path);
  driver.database.exec(migration001Init.sql);
  return driver;
}

interface NodeSeed {
  readonly id?: string;
  readonly scope?: string;
  readonly layer?: 0 | 1 | 2 | 3;
  readonly title?: string;
  readonly body?: string;
  readonly acl?: "private" | "team" | "restricted" | "agent";
  readonly ownerId?: string;
  readonly teamId?: string;
}

function insertNode(db: SqliteDriver, seed: NodeSeed = {}): string {
  const id = seed.id ?? generateId();
  const now = Date.now();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          head_id, content_hash, acl, owner_id, team_id, agent_id,
                          created_at, updated_at)
       VALUES (?1, 'note', ?2, ?3, ?4, ?5, ?6, 2, 'active', NULL, ?7, ?8, ?9, ?10, '', ?11, ?11)`,
    )
    .run(
      id,
      seed.layer ?? 1,
      seed.scope ?? "s1",
      seed.title ?? "",
      seed.body ?? "",
      (seed.body ?? "").slice(0, 120),
      `hash-${id}`,
      seed.acl ?? "team",
      seed.ownerId ?? "",
      seed.teamId ?? "",
      now,
    );
  return id;
}

/** Операция оплога — то, что двигает версию базы для всех кешей. */
let hlcTick = 1;
function writeOp(db: SqliteDriver, entityId: string, scope = "s1"): void {
  const now = Date.now();
  db.database
    .query(
      `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id,
                          field, value, scope, origin)
       VALUES (?1, 'test', ?2, ?3, 'test', 'set', 'node', ?4, 'title', '"x"', ?5, 1)`,
    )
    .run(`test:${hlcTick}:${entityId}`, hlcTick++, now, entityId, scope);
}

// ============================== ключ ========================================

describe("ключ кеша результатов", () => {
  const base = {
    text: "как объединять журнал операций",
    scopes: ["s1"],
    layerMin: 0,
    layerMax: 3,
    limit: 12,
    vectorMode: "auto",
    caller: ANON,
    config: { rrfK: 60 },
  };

  test("пробелы и порядок скоупов не значимы", () => {
    expect(searchCacheKey({ ...base, text: "  как  объединять журнал операций " })).toBe(
      searchCacheKey(base),
    );
    expect(searchCacheKey({ ...base, scopes: ["s1", "s2"] })).toBe(
      searchCacheKey({ ...base, scopes: ["s2", "s1"] }),
    );
  });

  test("регистр ЗНАЧИМ: форма токена решает, сработает ли триггер вектора", () => {
    // isAnchorToken разбирает форму: ENOENT — якорь, enoent — нет. Схлопни
    // здесь регистр (как это делает кеш эмбеддингов) — и два запроса с
    // разными решениями триггера поделили бы одну запись кеша.
    expect(normalizeCacheQuery("ENOENT")).not.toBe(normalizeCacheQuery("enoent"));
    expect(searchCacheKey({ ...base, text: "ENOENT" })).not.toBe(
      searchCacheKey({ ...base, text: "enoent" }),
    );
  });

  test("вызывающий входит в ключ: ACL меняет выдачу", () => {
    const other: FtsCaller = { ...ANON, ownerId: "u2" };
    expect(searchCacheKey({ ...base, caller: other })).not.toBe(searchCacheKey(base));
    const withGrant: FtsCaller = { ...ANON, principals: ["g1"] };
    expect(searchCacheKey({ ...base, caller: withGrant })).not.toBe(searchCacheKey(base));
  });

  test("конфиг входит в ключ целиком: смена весов = другой ответ", () => {
    expect(searchCacheKey({ ...base, config: { rrfK: 30 } })).not.toBe(searchCacheKey(base));
  });

  test("слои, лимит и режим вектора входят в ключ", () => {
    expect(searchCacheKey({ ...base, layerMax: 2 })).not.toBe(searchCacheKey(base));
    expect(searchCacheKey({ ...base, limit: 5 })).not.toBe(searchCacheKey(base));
    expect(searchCacheKey({ ...base, vectorMode: "never" })).not.toBe(searchCacheKey(base));
  });
});

// ========================= SearchResultCache ================================

describe("SearchResultCache — seq и TTL", () => {
  test("попадание только при совпавшем seq", () => {
    const c = new SearchResultCache<string>();
    c.set("k", 10, 0, "v");
    expect(c.get("k", 10, 0)).toEqual({ outcome: "hit", value: "v" });
    c.set("k", 10, 0, "v");
    expect(c.get("k", 11, 0)).toEqual({ outcome: "miss", reason: "stale" });
    expect(c.staleDrops).toBe(1);
  });

  test("холодный промах отличается от протухшего и от устаревшего", () => {
    const c = new SearchResultCache<string>();
    expect(c.get("k", 1, 0)).toEqual({ outcome: "miss", reason: "cold" });
    c.set("k", 1, 0, "v");
    expect(c.get("k", 1, DEFAULT_RESULT_TTL_MS)).toEqual({
      outcome: "miss",
      reason: "expired",
    });
    expect(c.expiredDrops).toBe(1);
    expect(c.staleDrops).toBe(0);
  });

  test("TTL — второе условие сверх seq, не замена ему", () => {
    const c = new SearchResultCache<string>(512, 1000);
    c.set("k", 1, 0, "v");
    expect(c.get("k", 1, 999).outcome).toBe("hit");
    c.set("k", 1, 999, "v");
    expect(c.get("k", 1, 1999).outcome).toBe("miss");
  });

  test("LRU: вытесняется давно не читанное, а не давно записанное", () => {
    const c = new SearchResultCache<string>(2, 0);
    c.set("a", 1, 0, "a");
    c.set("b", 1, 0, "b");
    expect(c.get("a", 1, 0).outcome).toBe("hit"); // a освежён
    c.set("c", 1, 0, "c"); // вытесняет b
    expect(c.get("b", 1, 0).outcome).toBe("miss");
    expect(c.get("a", 1, 0).outcome).toBe("hit");
    expect(c.evictions).toBe(1);
    expect(c.size).toBe(2);
  });

  test("деградированный ответ не запоминается", () => {
    const c = new SearchResultCache<string>();
    c.set("k", 1, 0, "degraded", false);
    expect(c.get("k", 1, 0).outcome).toBe("miss");
    expect(c.rejected).toBe(1);
    expect(c.stored).toBe(0);
  });
});

// ========================= hybridSearch + кеш ===============================

function seededDb(): { db: SqliteDriver; ids: string[] } {
  const db = freshDb();
  const ids = [
    insertNode(db, { title: "журнал операций и слияние", body: "оплог, слияние, seq" }),
    insertNode(db, { title: "векторный поиск", body: "sqlite-vec, int8, rerank" }),
    insertNode(db, { title: "бюджет ответа", body: "char_budget и обрезка" }),
  ];
  writeOp(db, ids[0]!);
  return { db, ids };
}

function search(
  db: DbDriver,
  cache: SearchResultCache<HybridResult> | undefined,
  text = "журнал операций",
  extra: Partial<Parameters<typeof hybridSearch>[1]> = {},
): HybridResult {
  return hybridSearch(db, {
    text,
    scopes: ["s1"],
    caller: ANON,
    vectorMode: "never",
    cache,
    ...extra,
  });
}

describe("hybridSearch с кешем результатов", () => {
  test("без кеша поведение прежнее и это видно: cache = off", () => {
    const { db } = seededDb();
    const r = search(db, undefined);
    expect(r.mode_used.cache).toBe("off");
    expect(r.hits.length).toBeGreaterThan(0);
    db.close();
  });

  test("первый запрос — miss, второй — hit, выдача та же", () => {
    const { db } = seededDb();
    const cache = new SearchResultCache<HybridResult>();
    const first = search(db, cache);
    expect(first.mode_used.cache).toBe("miss");
    const second = search(db, cache);
    expect(second.mode_used.cache).toBe("hit");
    expect(second.hits.map((h) => h.id)).toEqual(first.hits.map((h) => h.id));
    expect(cache.hits).toBe(1);
    db.close();
  });

  test("попадание стоит РОВНО один statement — чтение хвоста оплога", () => {
    const { db } = seededDb();
    const cache = new SearchResultCache<HybridResult>();
    search(db, cache);
    const hit = search(db, cache);
    expect(hit.mode_used.cache).toBe("hit");
    expect(hit.mode_used.roundTrips).toBe(1);
    expect(hit.mode_used.vectorRoundTrips).toBe(0);
    db.close();
  });

  test("ЗАПИСЬ → СЛЕДУЮЩИЙ ЗАПРОС ВИДИТ ЕЁ (сердце задачи)", () => {
    const { db } = seededDb();
    const cache = new SearchResultCache<HybridResult>();
    const before = search(db, cache);
    expect(search(db, cache).mode_used.cache).toBe("hit");

    const fresh = insertNode(db, {
      title: "журнал операций: новая заметка",
      body: "добавлено после того, как ответ уже лежал в кеше",
    });
    writeOp(db, fresh);

    const after = search(db, cache);
    expect(after.mode_used.cache).toBe("miss");
    expect(after.hits.map((h) => h.id)).toContain(fresh);
    expect(before.hits.map((h) => h.id)).not.toContain(fresh);
    expect(cache.staleDrops).toBe(1);
    db.close();
  });

  test("удаление узла тоже видно сразу", () => {
    const { db, ids } = seededDb();
    const cache = new SearchResultCache<HybridResult>();
    search(db, cache);
    db.database.query(`DELETE FROM nodes WHERE id = ?1`).run(ids[0]!);
    writeOp(db, ids[0]!);
    const after = search(db, cache);
    expect(after.mode_used.cache).toBe("miss");
    expect(after.hits.map((h) => h.id)).not.toContain(ids[0]!);
    db.close();
  });

  test("разные вызывающие не делят запись: чужие узлы не текут через кеш", () => {
    const db = freshDb();
    const mine = insertNode(db, {
      title: "приватная заметка про оплог",
      body: "оплог",
      acl: "private",
      ownerId: "u1",
    });
    writeOp(db, mine);
    const cache = new SearchResultCache<HybridResult>();
    const owner = search(db, cache, "оплог", {
      caller: { ...ANON, ownerId: "u1" },
    });
    expect(owner.hits.map((h) => h.id)).toContain(mine);

    const stranger = search(db, cache, "оплог", {
      caller: { ...ANON, ownerId: "u2" },
    });
    expect(stranger.mode_used.cache).toBe("miss");
    expect(stranger.hits.map((h) => h.id)).not.toContain(mine);
    db.close();
  });

  test("TTL: запись старше 60 с не отдаётся даже при неизменном seq", () => {
    const { db } = seededDb();
    const cache = new SearchResultCache<HybridResult>();
    let clock = 1_000_000;
    const opts = { cacheClock: () => clock };
    expect(search(db, cache, "журнал операций", opts).mode_used.cache).toBe("miss");
    clock += DEFAULT_RESULT_TTL_MS - 1;
    expect(search(db, cache, "журнал операций", opts).mode_used.cache).toBe("hit");
    clock += DEFAULT_RESULT_TTL_MS;
    expect(search(db, cache, "журнал операций", opts).mode_used.cache).toBe("miss");
    expect(cache.expiredDrops).toBe(1);
    db.close();
  });

  test("деградированный ответ отдаётся, но не кешируется", () => {
    const { db } = seededDb();
    const cache = new SearchResultCache<HybridResult>();
    // Вектор обязателен, эмбеддинга нет → vector: "unavailable" (И2).
    const opts = {
      vectorMode: "always" as const,
      embedQuery: () => null,
    };
    const first = search(db, cache, "журнал операций", opts);
    expect(first.mode_used.vector).toBe("unavailable");
    expect(first.mode_used.cache).toBe("miss");
    const second = search(db, cache, "журнал операций", opts);
    expect(second.mode_used.cache).toBe("miss");
    expect(cache.rejected).toBe(2);
    expect(cache.size).toBe(0);
    db.close();
  });

  test("другой конфиг — другая запись, а не чужой ответ", () => {
    const { db } = seededDb();
    const cache = new SearchResultCache<HybridResult>();
    search(db, cache, "журнал операций", { config: { rrfK: 60 } });
    const other = search(db, cache, "журнал операций", { config: { rrfK: 5 } });
    expect(other.mode_used.cache).toBe("miss");
    expect(cache.size).toBe(2);
    db.close();
  });
});

// ========================= гидратация =======================================

describe("NodeHydrationCache", () => {
  test("точечная инвалидация: выброшен только менявшийся узел", () => {
    const db = freshDb();
    const a = insertNode(db, { title: "a" });
    const b = insertNode(db, { title: "b" });
    const cache = new NodeHydrationCache<string>();
    cache.refresh(db);
    cache.set(a, "a-body");
    cache.set(b, "b-body");

    writeOp(db, a);
    const r = cache.refresh(db);
    expect(r.invalidated).toBe(1);
    expect(r.cleared).toBe(false);
    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toBe("b-body");
    db.close();
  });

  test("hydrate: недостающее берётся ОДНИМ вызовом, попадания не берутся вовсе", () => {
    const db = freshDb();
    const ids = [insertNode(db), insertNode(db), insertNode(db)];
    const cache = new NodeHydrationCache<string>();
    const calls: string[][] = [];
    const fetch = (missing: readonly string[]) => {
      calls.push([...missing]);
      return missing.map((id) => [id, `body-${id}`] as const);
    };

    const first = cache.hydrate(db, ids, fetch);
    expect(first.hits).toBe(0);
    expect(first.misses).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(ids);

    const second = cache.hydrate(db, ids, fetch);
    expect(second.hits).toBe(3);
    expect(second.misses).toBe(0);
    expect(calls).toHaveLength(1); // второго обращения к базе не было вовсе
    expect(second.values.get(ids[0]!)).toBe(`body-${ids[0]}`);
    db.close();
  });

  test("после записи в узел hydrate перечитывает ИМЕННО его", () => {
    const db = freshDb();
    const ids = [insertNode(db), insertNode(db)];
    const cache = new NodeHydrationCache<string>();
    let version = 1;
    const fetch = (missing: readonly string[]) =>
      missing.map((id) => [id, `v${version}-${id}`] as const);

    cache.hydrate(db, ids, fetch);
    version = 2;
    writeOp(db, ids[0]!);
    const after = cache.hydrate(db, ids, fetch);
    expect(after.values.get(ids[0]!)).toBe(`v2-${ids[0]}`);
    expect(after.values.get(ids[1]!)).toBe(`v1-${ids[1]}`);
    expect(after.hits).toBe(1);
    expect(after.misses).toBe(1);
    db.close();
  });

  test("оплог ушёл дальше потолка — кеш сбрасывается целиком и это видно", () => {
    const db = freshDb();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(insertNode(db));
    const cache = new NodeHydrationCache<string>();
    cache.refresh(db);
    for (const id of ids) cache.set(id, `body-${id}`);

    for (let i = 0; i <= HYDRATION_INVALIDATE_CAP; i++) writeOp(db, `other-${i}`);
    const r = cache.refresh(db);
    expect(r.cleared).toBe(true);
    expect(cache.size).toBe(0);
    expect(cache.clears).toBe(1);
    db.close();
  });

  test("seq уехал назад (компакция/восстановление) — сброс целиком", () => {
    const db = freshDb();
    const a = insertNode(db);
    writeOp(db, a);
    writeOp(db, a);
    const cache = new NodeHydrationCache<string>();
    cache.refresh(db);
    cache.set(a, "body");
    db.database.exec(`DELETE FROM oplog`);
    const r = cache.refresh(db);
    expect(r.cleared).toBe(true);
    expect(cache.size).toBe(0);
    db.close();
  });

  test("LRU 4096: вытеснение считается", () => {
    const db = freshDb();
    const cache = new NodeHydrationCache<string>(2);
    cache.refresh(db);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.evictions).toBe(1);
    db.close();
  });
});

// ==================== кросс-процессная инвалидация ==========================

describe("инвалидация записью ИЗ СОСЕДНЕГО ПРОЦЕССА", () => {
  test("MCP-процесс с горячим кешем видит запись one-shot CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "myc-cache-"));
    const dbPath = join(dir, "graph.db");
    try {
      const seed = freshDb(dbPath);
      const known = insertNode(seed, {
        title: "журнал операций и слияние",
        body: "оплог",
      });
      writeOp(seed, known);
      seed.close();

      // «Долгоживущий процесс»: своё соединение, свой кеш, ответ уже горячий.
      const reader = openSqlite(dbPath);
      const cache = new SearchResultCache<HybridResult>();
      expect(search(reader, cache).mode_used.cache).toBe("miss");
      expect(search(reader, cache).mode_used.cache).toBe("hit");
      const seqBefore = readOplogSeq(reader);

      // Настоящий второй процесс пишет в ту же базу.
      const proc = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "cache.race.worker.ts"),
          dbPath,
          "outsider-node",
          "s1",
          "журнал операций из другого процесса",
          "эта запись сделана параллельным процессом",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const report = JSON.parse(proc.stdout.toString().trim()) as {
        ok: boolean;
        seq?: number;
        error?: string;
      };
      expect(report.error ?? "").toBe("");
      expect(report.ok).toBe(true);
      expect(report.seq).toBeGreaterThan(seqBefore);

      // Тот же кеш, то же соединение, тот же запрос — и всё же промах.
      const after = search(reader, cache);
      expect(after.mode_used.cache).toBe("miss");
      expect(after.hits.map((h) => h.id)).toContain("outsider-node");
      expect(cache.staleDrops).toBe(1);
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================== числа =======================================

describe("числа", () => {
  test("цена попадания против промаха, доля попаданий, память", () => {
    const db = freshDb();
    const words = ["оплог", "вектор", "бюджет", "слияние", "ретривал", "кеш", "граф", "индекс"];
    for (let i = 0; i < 2000; i++) {
      insertNode(db, {
        title: `${words[i % words.length]} узел ${i}`,
        body: `${words[(i + 3) % words.length]} тело узла ${i} про ${words[(i + 5) % words.length]}`,
      });
    }
    writeOp(db, "seed");

    const queries = words.map((w) => `${w} узел`);
    const cache = new SearchResultCache<HybridResult>();

    // Прогрев: обе ветки исполнены хотя бы раз (JIT), кеш наполнен.
    for (const q of queries) {
      search(db, undefined, q);
      search(db, cache, q);
    }

    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) search(db, undefined, queries[i % queries.length]!);
    const missMs = (performance.now() - t0) / N;

    const t1 = performance.now();
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (search(db, cache, queries[i % queries.length]!).mode_used.cache === "hit") hits++;
    }
    const hitMs = (performance.now() - t1) / N;
    expect(hits).toBe(N);

    // Сценарий сессии агента. Два режима, потому что они дают РАЗНЫЕ числа
    // и второе без первого хвастовство, а первое без второго — самообман.
    const runSession = (writeEvery: number): { hits: number; stale: number } => {
      const c = new SearchResultCache<HybridResult>();
      let h = 0;
      for (let i = 0; i < 60; i++) {
        // Каждый пятый запрос — новая формулировка (холодный промах),
        // остальные повторяют уже спрошенное.
        const q =
          i % 5 === 0 ? `${words[i % words.length]} узел ${i}` : queries[i % queries.length]!;
        if (search(db, c, q).mode_used.cache === "hit") h++;
        if (writeEvery > 0 && i % writeEvery === writeEvery - 1) writeOp(db, `session-${i}`);
      }
      return { hits: h, stale: c.staleDrops };
    };
    const readMostly = runSession(0);
    const mixed = runSession(20);

    // Память: полный кеш из 512 ответов по 12 узлов. heapUsed под JSC не
    // двигается (проверено: константа), поэтому меряется heapTotal.
    const sample = search(db, undefined, queries[0]!);
    const heap = (): number => {
      Bun.gc(true);
      return process.memoryUsage().heapTotal;
    };
    const full = new SearchResultCache<HybridResult>();
    const before = heap();
    for (let i = 0; i < 512; i++) {
      full.set(`key-${i}`, 1, 0, {
        hits: sample.hits.map((h) => ({ ...h, id: `${h.id}-${i}` })),
        mode_used: { ...sample.mode_used },
      });
    }
    const bytes = heap() - before;
    expect(full.size).toBe(512);

    console.log(
      `[кеш результатов] промах ${missMs.toFixed(3)} мс · попадание ${hitMs.toFixed(4)} мс · ` +
        `дешевле в ${(missMs / hitMs).toFixed(0)} раз (корпус 2000 узлов)\n` +
        `[кеш результатов] сессия 60 запросов без записей: попаданий ${readMostly.hits}/60 ` +
        `(${((readMostly.hits / 60) * 100).toFixed(0)}%)\n` +
        `[кеш результатов] та же сессия с записью каждые 20 запросов: попаданий ` +
        `${mixed.hits}/60 (${((mixed.hits / 60) * 100).toFixed(0)}%), ` +
        `устаревших сброшено ${mixed.stale}\n` +
        `[кеш результатов] 512 ответов по ${sample.hits.length} узлов = ` +
        `${(bytes / 1024 / 1024).toFixed(2)} МиБ (${Math.round(bytes / 512)} Б/запись)`,
    );

    expect(missMs / hitMs).toBeGreaterThan(5);
    // 60 запросов = 12 новых формулировок + 8 первых (холодных) из цикла +
    // 40 повторов. Без записей КАЖДЫЙ повтор обязан быть попаданием.
    expect(readMostly.hits).toBe(40);
    expect(mixed.hits).toBeLessThan(readMostly.hits);
    db.close();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Умолчания сроков закреплены: тесты задают СВОЙ ttl и молчат о значении
// ---------------------------------------------------------------------------

describe("умолчания кеша закреплены числом", () => {
  test("срок жизни результата — минута, и он ПРИМЕНЯЕТСЯ конструктором без аргумента", () => {
    // Механизм истечения покрыт выше, но каждый такой тест передаёт ttlMs
    // явно. Поэтому поднять умолчание — скажем, до одиннадцати суток —
    // можно было незаметно: ни один тест не падал. Между тем срок здесь не
    // косметика: буст свежести считается от now, и запись суточной давности
    // в неизменной базе отдавала бы порядок суточной давности.
    expect(DEFAULT_RESULT_TTL_MS).toBe(60_000);

    // Значение мало объявить — оно обязано ДОЙТИ до поведения. Кеш без
    // явного ttl держит запись 59.999 с и отпускает на 60-й.
    const c = new SearchResultCache<number>(8);
    c.set("k", 1, 0, 7);
    expect(c.get("k", 1, 59_999).outcome).toBe("hit");

    const c2 = new SearchResultCache<number>(8);
    c2.set("k", 1, 0, 7);
    const late = c2.get("k", 1, 60_000);
    expect(late.outcome).toBe("miss");
    // Сузить тип по outcome: причина есть только у промаха, и проверять её
    // надо именно как причину промаха, а не как поле «чего-нибудь».
    if (late.outcome !== "miss") throw new Error("ожидался промах по сроку");
    expect(late.reason).toBe("expired");
  });

  test("вместимости LRU тоже закреплены", () => {
    // Тот же класс: увеличение потолка меняет расход памяти, уменьшение —
    // долю попаданий, и ни то ни другое не заметно без числа в тесте.
    expect(DEFAULT_RESULT_CACHE_MAX).toBe(512);
    expect(DEFAULT_HYDRATION_CACHE_MAX).toBe(4096);
  });
});
