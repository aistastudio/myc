import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineQueries } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";

const Q = defineQueries({
  node_insert: {
    name: "node_insert",
    sql: `INSERT INTO nodes
            (id, scope, kind, status, title, priority, open_blockers,
             assignee, lease_expires, deleted_at, updated_at, meta)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    params: [
      "id", "scope", "kind", "status", "title", "priority",
      "open_blockers", "assignee", "lease_expires", "deleted_at",
      "updated_at", "meta",
    ],
  },
  node_get: {
    name: "node_get",
    sql: "SELECT id, title, status FROM nodes WHERE id = ?1 AND deleted_at IS NULL",
    params: ["id"],
  },
  node_prefix: {
    name: "node_prefix",
    sql: `SELECT id FROM nodes
           WHERE id >= ?1 AND id < ?2 AND deleted_at IS NULL
           ORDER BY id LIMIT ?3`,
    params: ["from", "to", "limit"],
  },
  ready: {
    name: "ready",
    sql: `SELECT id, title, priority, updated_at
            FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND deleted_at IS NULL
             AND (lease_expires = 0 OR lease_expires < ?2)
           ORDER BY priority ASC, updated_at ASC
           LIMIT ?3`,
    params: ["scope", "nowMs", "limit"],
  },
  node_upsert: {
    name: "node_upsert",
    sql: `INSERT INTO nodes (id, scope, kind, status, title, updated_at, meta)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}')
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
          RETURNING id, title`,
    params: ["id", "scope", "kind", "status", "title", "updated_at"],
  },
  node_soft_delete: {
    name: "node_soft_delete",
    sql: "UPDATE nodes SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
    params: ["id", "deletedAt"],
  },
  status_counts: {
    name: "status_counts",
    sql: `SELECT status, count(*) AS n FROM nodes
           WHERE scope = ?1 AND deleted_at IS NULL
           GROUP BY status ORDER BY status`,
    params: ["scope"],
  },
  search_title: {
    name: "search_title",
    sql: `SELECT id FROM nodes
           WHERE title LIKE ?1 ESCAPE '\\' AND deleted_at IS NULL
           ORDER BY title LIMIT ?2`,
    params: ["pattern", "limit"],
  },
  json_meta_get: {
    name: "json_meta_get",
    sql: "SELECT json_extract(meta, ?2) AS v FROM nodes WHERE id = ?1",
    params: ["id", "path"],
  },
  edge_insert: {
    name: "edge_insert",
    sql: "INSERT INTO edges (src, dst, kind) VALUES (?1, ?2, ?3)",
    params: ["src", "dst", "kind"],
  },
  edge_blockers: {
    name: "edge_blockers",
    sql: `SELECT count(*) AS n FROM edges e
            JOIN nodes b ON b.id = e.src
           WHERE e.dst = ?1 AND e.kind = 'blocks'
             AND b.status = 'open' AND b.deleted_at IS NULL`,
    params: ["id"],
  },
  edges_closure: {
    name: "edges_closure",
    sql: `WITH RECURSIVE closure(id, depth) AS (
            SELECT ?2, 0
            UNION ALL
            SELECT e.dst, closure.depth + 1
              FROM edges e JOIN closure ON e.src = closure.id
             WHERE closure.depth < ?3
          )
          SELECT c.id, c.depth FROM closure c
            JOIN nodes n ON n.id = c.id
           WHERE n.scope = ?1 AND n.deleted_at IS NULL AND c.depth > 0
           ORDER BY c.depth, c.id`,
    params: ["scope", "root", "maxDepth"],
  },
  explain_ready: {
    name: "explain_ready",
    sql: `EXPLAIN QUERY PLAN
          SELECT id FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND deleted_at IS NULL`,
    params: ["scope"],
  },
  override_probe: {
    name: "override_probe",
    sql: "SELECT 'shared' AS v, ?1 AS p",
    params: ["p"],
    pg: "SELECT 'pg-override' AS v, $1 AS p",
  },
});

interface NodeRow {
  id: string;
  title: string;
  status: string;
}

const NOW = 1_700_000_000_000;

let driver: SqliteDriver;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-store-sqlite-"));
  driver = openSqlite({ path: join(dir, "test.db") });
  driver.database.exec(`
    CREATE TABLE nodes (
      id            TEXT PRIMARY KEY,
      scope         TEXT NOT NULL,
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      title         TEXT NOT NULL,
      priority      INTEGER NOT NULL DEFAULT 0,
      open_blockers INTEGER NOT NULL DEFAULT 0,
      assignee      TEXT,
      lease_expires INTEGER NOT NULL DEFAULT 0,
      deleted_at    INTEGER,
      updated_at    INTEGER NOT NULL,
      meta          TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX nodes_ready_idx ON nodes(scope, kind, status, priority);
    CREATE INDEX nodes_prefix_idx ON nodes(scope, id);
    CREATE TABLE edges (
      src  TEXT NOT NULL,
      dst  TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (src, dst, kind)
    );
    ANALYZE;
  `);
});

afterAll(() => {
  driver?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function insertNode(over: Partial<Record<string, unknown>> = {}): string {
  const row = {
    id: over.id as string,
    scope: "proj",
    kind: "task",
    status: "open",
    title: `task ${over.id}`,
    priority: 0,
    open_blockers: 0,
    assignee: null,
    lease_expires: 0,
    deleted_at: null,
    updated_at: NOW,
    meta: "{}",
    ...over,
  };
  driver.run(Q.node_insert, [
    row.id, row.scope, row.kind, row.status, row.title, row.priority,
    row.open_blockers, row.assignee, row.lease_expires, row.deleted_at,
    row.updated_at, row.meta,
  ]);
  return row.id as string;
}

describe("openSqlite", () => {
  test("applies the §8.1.0 pragmas on open", () => {
    const db = driver.database;
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(Number((db.query("PRAGMA mmap_size").get() as { mmap_size: number }).mmap_size)).toBe(268435456);
    expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
  });
});

describe("representative query suite through the driver", () => {
  test("registry exposes at least 12 representative queries", () => {
    expect(Object.keys(Q).length).toBeGreaterThanOrEqual(12);
  });

  test("node_insert / run reports changes", () => {
    for (const id of ["n1", "n2", "n3", "n4"]) {
      const over: Record<string, unknown> = { id };
      if (id === "n2") over.priority = 5;
      if (id === "n3") {
        over.status = "done";
        over.priority = 1;
      }
      if (id === "n4") {
        over.open_blockers = 2;
        over.priority = -1;
        over.lease_expires = NOW + 60_000;
      }
      expect(insertNode(over)).toBe(id);
    }
    expect(driver.database.query("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 4 });
  });

  test("node_get returns the row", () => {
    const row = driver.one<NodeRow>(Q.node_get, ["n1"]);
    expect(row).toEqual({ id: "n1", title: "task n1", status: "open" });
    expect(driver.one(Q.node_get, ["missing"])).toBeUndefined();
  });

  test("node_prefix scans a range with limit", () => {
    expect(driver.all(Q.node_prefix, ["n", "o", 10])).toEqual([
      { id: "n1" }, { id: "n2" }, { id: "n3" }, { id: "n4" },
    ]);
    expect(driver.all(Q.node_prefix, ["n", "o", 2])).toEqual([{ id: "n1" }, { id: "n2" }]);
  });

  test("ready filters blocked, done and leased nodes, orders by priority", () => {
    driver.run(Q.node_insert, [
      "n5", "proj", "task", "open", "task n5", 0, 1, null, 0, null, NOW, "{}",
    ]);
    expect(driver.all(Q.ready, ["proj", NOW, 10]).map((r) => (r as { id: string }).id)).toEqual([
      "n1", "n2",
    ]);
  });

  test("node_upsert inserts or updates and returns RETURNING rows", () => {
    const inserted = driver.one<{ id: string; title: string }>(Q.node_upsert, [
      "u1", "proj", "note", "open", "first", NOW,
    ]);
    expect(inserted).toEqual({ id: "u1", title: "first" });
    const updated = driver.one<{ id: string; title: string }>(Q.node_upsert, [
      "u1", "proj", "note", "open", "second", NOW + 1,
    ]);
    expect(updated).toEqual({ id: "u1", title: "second" });
  });

  test("node_soft_delete hides the row from node_get", () => {
    insertNode({ id: "d1" });
    expect(driver.run(Q.node_soft_delete, ["d1", NOW + 5]).changes).toBe(1);
    expect(driver.one(Q.node_get, ["d1"])).toBeUndefined();
  });

  test("status_counts groups by status", () => {
    expect(driver.all(Q.status_counts, ["proj"])).toEqual([
      { status: "done", n: 1 },
      { status: "open", n: 5 },
    ]);
  });

  test("search_title uses LIKE with an escape character", () => {
    insertNode({ id: "l1", title: "50% off" });
    expect(driver.all(Q.search_title, ["task%", 10]).length).toBeGreaterThanOrEqual(4);
    expect(driver.all(Q.search_title, ["50\\% off", 10]).map((r) => (r as { id: string }).id)).toEqual(["l1"]);
  });

  test("json_meta_get reads a JSON path", () => {
    insertNode({ id: "j1", meta: '{"tags":["a","b"]}' });
    expect(driver.one<{ v: string }>(Q.json_meta_get, ["j1", "$.tags[1]"])).toEqual({ v: "b" });
  });

  test("edge_insert / edge_blockers join counts open blockers", () => {
    driver.run(Q.edge_insert, ["n5", "n1", "blocks"]);
    expect(driver.one<{ n: number }>(Q.edge_blockers, ["n1"])).toEqual({ n: 1 });
    expect(driver.one<{ n: number }>(Q.edge_blockers, ["n2"])).toEqual({ n: 0 });
  });

  test("edges_closure walks a recursive CTE", () => {
    driver.run(Q.edge_insert, ["n1", "n2", "parent"]);
    driver.run(Q.edge_insert, ["n2", "n3", "parent"]);
    expect(driver.all(Q.edges_closure, ["proj", "n1", 5])).toEqual([
      { id: "n2", depth: 1 },
      { id: "n3", depth: 2 },
    ]);
  });

  test("sqlite ignores the pg override and uses the shared text", () => {
    expect(driver.one<{ v: string; p: string }>(Q.override_probe, ["x"])).toEqual({
      v: "shared",
      p: "x",
    });
  });

  test("explain_ready plans through the index", () => {
    const plan = driver.all<{ detail: string }>(Q.explain_ready, ["proj"]);
    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/USING INDEX nodes_ready_idx/);
  });
});

describe("prepared statement cache", () => {
  test("reuses one prepared statement per query name", () => {
    const before = driver.stats();
    const q1 = { name: "cache_probe_a", sql: "SELECT ?1 AS v", params: ["v"] };
    const q2 = { name: "cache_probe_b", sql: "SELECT 1 AS one", params: [] };
    driver.one(q1, [1]);
    driver.one(q1, [2]);
    driver.all(q1, [3]);
    driver.one(q2, []);
    const after = driver.stats();
    expect(after.prepares - before.prepares).toBe(2);
    expect(after.hits - before.hits).toBe(2);
    expect(after.misses - before.misses).toBe(2);
  });

  test("cache respects the 64-entry LRU bound", () => {
    for (let i = 0; i < 70; i++) {
      driver.one({ name: `probe_${i}`, sql: `SELECT ${i}`, params: [] }, []);
    }
    expect(driver.stats().cacheSize).toBe(64);
  });
});

describe("transactions", () => {
  test("immediate transaction takes the write lock and commits atomically", () => {
    const second = new Database(driver.database.filename);
    second.exec("PRAGMA busy_timeout = 30");
    const out = driver.tx("immediate", (tx) => {
      tx.run(Q.node_soft_delete, ["n3", NOW + 10]);
      expect(() =>
        second.exec("UPDATE nodes SET deleted_at = 1 WHERE id = 'n2'"),
      ).toThrow(/locked|BUSY/);
      return tx.one<NodeRow>(Q.node_get, ["n3"]);
    });
    second.close();
    expect(out).toBeUndefined();
    expect(driver.one(Q.node_get, ["n3"])).toBeUndefined();
    expect(driver.run(Q.node_soft_delete, ["n3", 0]).changes).toBe(0);
  });

  test("a thrown error rolls the transaction back", () => {
    expect(() =>
      driver.tx("immediate", (tx) => {
        tx.run(Q.node_soft_delete, ["n2", NOW + 20]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(driver.one<NodeRow>(Q.node_get, ["n2"])).toEqual({
      id: "n2",
      title: "task n2",
      status: "open",
    });
  });

  test("nested transactions are rejected", () => {
    expect(() =>
      driver.tx("deferred", () => driver.tx("immediate", () => 1)),
    ).toThrow(/nested/);
  });
});

describe("wrapper overhead", () => {
  test("driver.one vs direct bun:sqlite on a simple SELECT, 1000 iterations", () => {
    const rawStmt = driver.database.prepare(Q.node_get.sql);
    const ids = ["n1", "n2", "n4", "u1"];

    for (let i = 0; i < 200; i++) {
      rawStmt.get(ids[i % ids.length]!);
      driver.one(Q.node_get, [ids[i % ids.length]!]);
    }

    const ITERS = 1000;
    const ROUNDS = 5;
    const rawMs: number[] = [];
    const wrapMs: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      let t0 = performance.now();
      for (let i = 0; i < ITERS; i++) rawStmt.get(ids[i % ids.length]!);
      rawMs.push(performance.now() - t0);

      t0 = performance.now();
      for (let i = 0; i < ITERS; i++) driver.one(Q.node_get, [ids[i % ids.length]!]);
      wrapMs.push(performance.now() - t0);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const rawUs = (median(rawMs) * 1000) / ITERS;
    const wrapUs = (median(wrapMs) * 1000) / ITERS;
    const overheadUs = wrapUs - rawUs;
    console.log(
      `[bench] прямой bun:sqlite: ${rawUs.toFixed(3)} мкс/оп | через driver.one: ` +
        `${wrapUs.toFixed(3)} мкс/оп | накладные расходы слоя: ${overheadUs.toFixed(3)} мкс/оп ` +
        `(${ITERS} итераций, медиана ${ROUNDS} раундов) | отношение ×${(wrapUs / rawUs).toFixed(2)}`,
    );
    // ОТНОСИТЕЛЬНОЕ утверждение вместо прежнего абсолютного «накладные < 2 мкс»:
    // обе половины меряются чередуясь по раундам, одним запросом на одних
    // данных, и загрузка с железом из отношения уходят, а 2 мкс — число этой
    // машины (под yes × 14 прямой вызов сам вырос 0.70 → 0.94 мкс). Замер:
    // ×1.33 в покое, ×1.03 под нагрузкой; мутация «кеш выражений выключен»
    // (prepare на каждый вызов) даёт кратно больше. Потолок 3 здесь строже
    // прежнего абсолюта (2 мкс при прямом 0.70 — это ×3.86) и переносим.
    expect(wrapUs / rawUs).toBeLessThan(3);
  });
});
