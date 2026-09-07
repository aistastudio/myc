/**
 * Модульные проверки формата экспорта (S42): строка оплога туда-обратно,
 * корзины по seq и по ID, монотонность экспорта, кеш проекций вне git.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, HlcClock } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, rowToOp, type OplogRow } from "./queries.ts";
import {
  canonicalJson,
  exportGraph,
  lineToRow,
  oplogBucket,
  oplogFilePath,
  projectionBucket,
  renderOplogFiles,
  rowToLine,
  splitOpId,
  writeProjectionCache,
  OPLOG_FILE_OPS,
  OPLOG_MERGE_DRIVER,
} from "./export.ts";
import { defaultCacheDir, importGraph } from "./import.ts";

let dir: string;
let driver: SqliteDriver;
let store: GraphStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-export-"));
  driver = openSqlite(join(dir, "myc.db"));
  await migrate(driver.database, { migrations, writable: true });
  let t = 1_700_000_000_000;
  store = new GraphStore(driver, {
    siteId: "s1",
    actor: "tester",
    newId: () => generateId(),
    clock: new HlcClock({ now: () => (t += 1) }),
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  driver.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("формат строки", () => {
  test("rowToLine → lineToRow → rowToOp сохраняет операцию", () => {
    const node = store.createNode({ kind: "task", title: "т", body: "тело\nс переводом" });
    store.addEdge(node.id, "relates", store.createNode({ kind: "note", title: "n" }).id);
    for (const row of store.opsSince(0)) {
      const back = lineToRow(rowToLine(row));
      expect(back.op_id).toBe(row.op_id);
      expect(back.hlc).toBe(row.hlc);
      expect(back.site_id).toBe(row.site_id);
      expect(back.entity_id).toBe(row.entity_id);
      expect(back.field).toBe(row.field);
      expect(JSON.stringify(rowToOp(back))).toBe(JSON.stringify(rowToOp(row)));
    }
  });

  test("splitOpId переживает двоеточия в site_id", () => {
    expect(splitOpId("local:host:7")).toEqual({ siteId: "local:host", seq: 7 });
    expect(() => splitOpId("nocolon")).toThrow();
    expect(() => splitOpId("s:0")).toThrow();
  });

  test("корзины оплога — по диапазону seq, по OPLOG_FILE_OPS в файле", () => {
    expect(oplogBucket(1)).toBe(0);
    expect(oplogBucket(OPLOG_FILE_OPS)).toBe(0);
    expect(oplogBucket(OPLOG_FILE_OPS + 1)).toBe(1);
    expect(oplogFilePath("siteA", 1)).toBe("oplog/siteA/00000.jsonl");
    expect(oplogFilePath("local/x y", 2001)).toBe("oplog/local_x_y/00002.jsonl");
  });

  test("корзины проекций — первый символ тела ID", () => {
    expect(projectionBucket("myc-a3f8k2mq7xz1")).toBe("a");
    expect(projectionBucket("proj-0abc")).toBe("0");
    expect(projectionBucket("myc-Z")).toBe("z");
    expect(projectionBucket("myc-i")).toBe("_");
  });

  test("canonicalJson сортирует ключи рекурсивно", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("exportGraph", () => {
  test("claim-записи не экспортируются, set/inc/edge_* — да", () => {
    const n = store.createNode({ kind: "task", title: "t", status: "open" });
    store.claimNode(n.id, "me");
    const files = renderOplogFiles(driver);
    const lines = [...files.values()].flatMap((t) => t.trim().split("\n"));
    const ops = new Set(lines.map((l) => (JSON.parse(l) as { op: string }).op));
    expect(ops.has("claim")).toBe(false);
    expect(ops.has("set")).toBe(true);
    expect(ops.has("inc")).toBe(true);
    expect(store.opsSince(0).some((r) => r.op === "claim")).toBe(true);
  });

  test("экспорт монотонен: чужие файлы не удаляет, свой не усекает", () => {
    const out = join(dir, "graph");
    store.createNode({ kind: "task", title: "a" });
    exportGraph(driver, out);
    const own = join(out, "oplog", "s1", "00000.jsonl");
    const before = readFileSync(own, "utf8");

    // Чужой сайт положил файл (git pull), плюс в нашем файле строка,
    // которой в базе ещё нет (другая ветка той же машины).
    mkdirSync(join(out, "oplog", "s2"), { recursive: true });
    const foreignLine = JSON.stringify({
      op_id: "s2:1",
      hlc: [1_700_000_000_500, 0],
      op: "set",
      entity: "node",
      entity_id: "myc-zzzzzzzzzzzz",
      field: "kind",
      value: "note",
    });
    writeFileSync(join(out, "oplog", "s2", "00000.jsonl"), `${foreignLine}\n`);
    const extraOwn = JSON.stringify({
      op_id: "s1:999",
      hlc: [1_700_000_000_900, 0],
      op: "set",
      entity: "node",
      entity_id: "myc-zzzzzzzzzzzz",
      field: "title",
      value: "x",
    });
    writeFileSync(own, `${before}${extraOwn}\n`);

    const r = exportGraph(driver, out);
    expect(r.pendingImport).toBe(2);
    expect(existsSync(join(out, "oplog", "s2", "00000.jsonl"))).toBe(true);
    expect(readFileSync(own, "utf8")).toBe(`${before}${extraOwn}\n`);

    // После импорта база знает обе, и экспорт больше ничего не переписывает.
    const imp = importGraph(store, out);
    expect(imp.fresh).toBe(2);
    expect(imp.deferred).toEqual([]);
    const r2 = exportGraph(driver, out);
    expect(r2.pendingImport).toBe(0);
    expect(r2.files.written).toEqual([]);
    expect(store.getNode("myc-zzzzzzzzzzzz", true)?.title).toBe("x");
  });

  test("в каталог графа идут только оплог, meta.json и .gitattributes с одним драйвером", () => {
    const out = join(dir, "graph");
    const n = store.createNode({ kind: "task", title: "a" });
    store.addEdge(n.id, "relates", store.createNode({ kind: "note", title: "b" }).id);
    const r = exportGraph(driver, out);
    expect(r.files.written.sort()).toEqual([".gitattributes", "meta.json", "oplog/s1/00000.jsonl"]);
    expect(readdirSync(out).sort()).toEqual([".gitattributes", "meta.json", "oplog"]);
    const attrs = readFileSync(join(out, ".gitattributes"), "utf8");
    const rules = attrs.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(rules).toEqual([`oplog/**/*.jsonl merge=${OPLOG_MERGE_DRIVER}`]);
  });

  test("проекции — кеш рядом с базой, сам себя игнорирует; пустые корзины удаляются", () => {
    const out = join(dir, "graph");
    const n = store.createNode({ kind: "task", title: "a" });
    exportGraph(driver, out);
    const cache = defaultCacheDir(out);
    expect(cache).toBe(join(dir, "projections"));
    const r1 = writeProjectionCache(driver, cache);
    const bucket = `nodes-${projectionBucket(n.id)}.jsonl`;
    expect(r1.nodes).toBe(1);
    expect(r1.edges).toBe(0);
    expect(r1.files.written.sort()).toEqual([".gitignore", bucket]);
    expect(readFileSync(join(cache, ".gitignore"), "utf8")).toMatch(/^(#.*\n)?\*\n$/);
    // Подложим пустую корзину «из прошлого» — пересборка её уберёт.
    writeFileSync(join(cache, "nodes-_.jsonl"), "");
    const r2 = writeProjectionCache(driver, cache);
    expect(r2.files.removed).toEqual(["nodes-_.jsonl"]);
    expect(r2.files.written).toEqual([]);
    // Каталог графа кеш не трогает.
    expect(existsSync(join(out, bucket))).toBe(false);
    expect(existsSync(join(out, "oplog", "s1", "00000.jsonl"))).toBe(true);
  });

  test("проекции первой редакции S42 в каталоге графа удаляются экспортом, оплог — никогда", () => {
    const out = join(dir, "graph");
    store.createNode({ kind: "task", title: "a" });
    exportGraph(driver, out);
    writeFileSync(join(out, "nodes-a.jsonl"), "{}\n");
    writeFileSync(join(out, "edges-0.jsonl"), "");
    const r = exportGraph(driver, out);
    expect(r.files.removed.sort()).toEqual(["edges-0.jsonl", "nodes-a.jsonl"]);
    expect(existsSync(join(out, "oplog", "s1", "00000.jsonl"))).toBe(true);
    // import пишет кеш в соседний каталог, а не обратно в граф.
    const imp = importGraph(store, out);
    expect(imp.cache?.dir).toBe(join(dir, "projections"));
    expect(readdirSync(out).sort()).toEqual([".gitattributes", "meta.json", "oplog"]);
  });

  test("файл оплога переполняется на границе OPLOG_FILE_OPS", () => {
    const rows: OplogRow[] = [];
    for (let seq = 1; seq <= OPLOG_FILE_OPS + 1; seq++) {
      rows.push({
        seq,
        op_id: `s9:${seq}`,
        site_id: "s9",
        hlc: ((BigInt(1_700_000_000_000 + seq) << 16n) | 0n).toString(),
        ts_ms: 1_700_000_000_000 + seq,
        actor: "",
        op: "inc",
        entity: "node",
        entity_id: "myc-x",
        field: "seen_count",
        value: "1",
        scope: "",
        origin: 0,
      });
    }
    const paths = new Set(rows.map((r) => oplogFilePath(r.site_id, r.seq)));
    expect([...paths]).toEqual(["oplog/s9/00000.jsonl", "oplog/s9/00001.jsonl"]);
  });
});
