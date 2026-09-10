#!/usr/bin/env bun
/**
 * Замер приёмки myc-dze.4 — НЕ часть `bun test` (медленно: 50k+ строк).
 * Запуск вручную:
 *
 *   MYC_SQLITE_LIB=<libsqlite3> MYC_SQLITE_VEC=<путь к vec0 без расширения> \
 *     bun run packages/store-sqlite/src/migrations/vec-f32-bench.ts
 *
 * Тот же приём поиска библиотек и того же дочернего процесса, что
 * ./vec-selfcheck.ts (см. его шапку) — здесь код не разделяется на модуль +
 * дочерний скрипт, потому что сам файл предназначен только для ручного
 * запуска, а не для `bun test`.
 *
 * Обе таблицы (nodes_vec, vec_nodes_f32) заводятся ТОЛЬКО через migrateVectors
 * из ./vec.ts — ни здесь, ни где-либо ещё нет ручного CREATE TABLE. Это и есть
 * доказательство критерия приёмки «recall@10 поднимается... без ручного
 * создания таблицы в тесте».
 *
 * Часть 1 (recall@10): повторяет сценарий packages/retrieval/src/vector.test.ts
 * scenarioRecall (30 центров, 2000 узлов, 20 запросов, sigma=0.18) той же
 * формулой, но своей SQL — импортировать vectorSearch из пакета retrieval
 * сюда нельзя (store-* пакеты зависят только от @myc/core, scripts/deps-check.ts).
 *
 * Часть 2 (место на диске): корпус 50 000+ узлов — int8 всегда, float32
 * либо для всех, либо только для горячего подмножества (потолок кеша из
 * vec-002-rerank-f32.ts) — числа для сравнения с приложением К.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../migrate.ts";
import { migrations } from "./index.ts";
import { migrateVectors } from "./vec.ts";

const DIM = 384;
const HOT_CAP = 10_000; // vec-002-rerank-f32.ts

const SQLITE_LIB_CANDIDATES = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
];
const VEC_GLOBS = [
  `${process.env.HOME ?? ""}/.bun/install/cache/sqlite-vec-*/vec0.*`,
  `${process.cwd()}/node_modules/sqlite-vec-*/vec0.*`,
];

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    if (path.length > 0 && (await Bun.file(path).exists())) return path;
  }
  return null;
}
async function findSqliteLib(): Promise<string | null> {
  const explicit = process.env.MYC_SQLITE_LIB;
  if (explicit) return (await Bun.file(explicit).exists()) ? explicit : null;
  return firstExisting(SQLITE_LIB_CANDIDATES);
}
async function findVec0(): Promise<string | null> {
  const explicit = process.env.MYC_SQLITE_VEC;
  if (explicit) return explicit;
  for (const pattern of VEC_GLOBS) {
    const slash = pattern.lastIndexOf("/", pattern.indexOf("*"));
    const root = pattern.slice(0, slash);
    const glob = new Bun.Glob(pattern.slice(slash + 1));
    for await (const hit of glob.scan({ cwd: root, absolute: true })) {
      return hit.replace(/\.(dylib|so|dll)$/, "");
    }
  }
  return null;
}

function mulberry32(seed: number) {
  let a = seed;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
function quantize(v: Float32Array): Int8Array {
  let maxAbs = 0;
  for (let i = 0; i < v.length; i++) maxAbs = Math.max(maxAbs, Math.abs(v[i]!));
  const scale = maxAbs > 0 ? maxAbs : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let r = Math.round((127 * v[i]!) / scale);
    r = Math.max(-127, Math.min(127, r));
    q[i] = r;
  }
  return q;
}
function i8Blob(q: Int8Array): Buffer {
  return Buffer.from(q.buffer, q.byteOffset, q.byteLength);
}
function f32Blob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

// Database.setCustomSQLite допустим ровно один раз за процесс и только ДО
// первого открытого соединения (приложение К, 01a-ddl-validation.md) — вызывается
// один раз в main(), сюда передаётся уже настроенный класс Database.
async function openMigrated(path: string, vecPath: string): Promise<Database> {
  const db = new Database(path, { create: true });
  db.loadExtension(vecPath);
  await migrate(db, { migrations, writable: true });
  await migrateVectors(db, { vec0Loaded: true, writable: true }); // ТОЛЬКО так, без ручного CREATE TABLE
  return db;
}

function insertNode(db: Database, id: string): number {
  const res = db
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, status, content_hash, acl, team_id, created_at, updated_at)
       VALUES (?1, 'note', 2, 's1', ?1, '', 'active', ?2, 'team', 't1', 1, 1)`,
    )
    .run(id, "h-" + id);
  return Number(res.lastInsertRowid);
}

// --------------------------- Часть 1: recall@10 -----------------------------

async function benchRecall(vecPath: string) {
  const dir = mkdtempSync(join(tmpdir(), "myc-vec-recall-"));
  const db = await openMigrated(join(dir, "recall.db"), vecPath);

  const CENTERS = 30,
    M = 2000,
    QUERIES = 20,
    SIGMA = 0.18,
    K_CANDIDATES = 200;
  const rand = mulberry32(987654321);
  const centers: Float32Array[] = [];
  for (let c = 0; c < CENTERS; c++) {
    centers.push(unit(new Float32Array(DIM).map(() => rand() * 2 - 1)));
  }
  const corpus: Float32Array[] = [];
  const insertVec = db.query(
    `INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding) VALUES (?1, 's1', 2, 'note', 1, vec_int8(?2))`,
  );
  const insertF32 = db.query(
    `INSERT INTO vec_nodes_f32 (node_id, embedding_f32, accessed_at) VALUES (?1, ?2, ?3)`,
  );
  db.exec("BEGIN");
  for (let j = 0; j < M; j++) {
    const c = centers[Math.floor(rand() * CENTERS)]!;
    const v = unit(Float32Array.from(c, (x) => x + gauss(rand) * SIGMA));
    const id = "r-" + String(j).padStart(5, "0");
    const rowid = insertNode(db, id);
    insertVec.run(rowid, i8Blob(quantize(v)));
    insertF32.run(id, f32Blob(v), Date.now());
    corpus.push(v);
  }
  db.exec("COMMIT");

  const knnStmt = db.query(
    `SELECT node_rowid, distance FROM nodes_vec WHERE embedding MATCH vec_int8(?1) AND k = ?2 AND scope = 's1' AND layer = 2`,
  );
  const f32Stmt = db.query(
    `SELECT node_id, embedding_f32 FROM vec_nodes_f32 WHERE node_id IN (SELECT value FROM json_each(?1))`,
  );
  const rowidToId = db.query(`SELECT rowid, id FROM nodes WHERE rowid = ?1`);

  function exactTop10(q: Float32Array): Set<string> {
    const scored = corpus.map((v, j) => ({ j, d: 1 - cosine(q, v) }));
    scored.sort((a, b) => a.d - b.d);
    return new Set(scored.slice(0, 10).map((s) => "r-" + String(s.j).padStart(5, "0")));
  }
  function recallOf(ids: string[], truth: Set<string>): number {
    let hit = 0;
    for (const id of ids) if (truth.has(id)) hit++;
    return hit / 10;
  }

  let sumInt8 = 0,
    sumRerank = 0;
  for (let i = 0; i < QUERIES; i++) {
    const c = centers[i % CENTERS]!;
    const q = unit(Float32Array.from(c, (x) => x + gauss(rand) * SIGMA));
    const truth = exactTop10(q);

    const knn = knnStmt.all(i8Blob(quantize(q)), K_CANDIDATES) as Array<{
      node_rowid: number;
      distance: number;
    }>;
    const idOf = (rowid: number) =>
      (rowidToId.get(rowid) as { id: string } | null)?.id ?? "";
    const int8Top10 = knn.slice(0, 10).map((r) => idOf(r.node_rowid));
    sumInt8 += recallOf(int8Top10, truth);

    const byId = new Map<string, number>();
    for (const r of knn) byId.set(idOf(r.node_rowid), r.distance);
    const f32Rows = f32Stmt.all(JSON.stringify(knn.map((r) => idOf(r.node_rowid)))) as Array<{
      node_id: string;
      embedding_f32: Uint8Array;
    }>;
    for (const row of f32Rows) {
      const f32 = new Float32Array(row.embedding_f32.buffer, row.embedding_f32.byteOffset, DIM);
      byId.set(row.node_id, 1 - cosine(q, f32));
    }
    const reranked = [...byId].sort((a, b) => a[1] - b[1]).slice(0, 10).map(([id]) => id);
    sumRerank += recallOf(reranked, truth);
  }

  db.close();
  rmSync(dir, { recursive: true, force: true });
  return { recallInt8: sumInt8 / QUERIES, recallRerank: sumRerank / QUERIES, corpus: M };
}

// ----------------------- Часть 2: прирост места на диске ---------------------

function fileBytes(path: string): number {
  return statSync(path).size;
}

async function benchStorage(vecPath: string) {
  const CORPUS = 50_000;
  const dir = mkdtempSync(join(tmpdir(), "myc-vec-storage-"));

  // (a) только int8 (базовая стоимость, всегда присутствует)
  const dbPath = join(dir, "storage.db");
  const db = await openMigrated(dbPath, vecPath);
  const insertVec = db.query(
    `INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding) VALUES (?1, 's1', 2, 'note', 1, vec_int8(?2))`,
  );
  const rand = mulberry32(42);
  db.exec("BEGIN");
  for (let j = 0; j < CORPUS; j++) {
    const v = unit(new Float32Array(DIM).map(() => rand() * 2 - 1));
    const rowid = insertNode(db, "s-" + String(j).padStart(6, "0"));
    insertVec.run(rowid, i8Blob(quantize(v)));
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytesInt8Only = fileBytes(dbPath);

  // (b) + float32 для ГОРЯЧЕГО подмножества (HOT_CAP строк — потолок кеша)
  const insertF32 = db.query(
    `INSERT INTO vec_nodes_f32 (node_id, embedding_f32, accessed_at) VALUES (?1, ?2, ?3)`,
  );
  const rand2 = mulberry32(42); // тот же поток векторов, что и (a), для честного сравнения
  db.exec("BEGIN");
  for (let j = 0; j < CORPUS; j++) {
    const v = unit(new Float32Array(DIM).map(() => rand2() * 2 - 1));
    if (j < HOT_CAP) {
      insertF32.run("s-" + String(j).padStart(6, "0"), f32Blob(v), Date.now());
    }
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytesHotSubset = fileBytes(dbPath);

  // (c) + float32 для ВСЕХ узлов корпуса (гипотетическая цена «для всех»)
  const rand3 = mulberry32(42);
  db.exec("BEGIN");
  for (let j = 0; j < CORPUS; j++) {
    const v = unit(new Float32Array(DIM).map(() => rand3() * 2 - 1));
    if (j >= HOT_CAP) {
      insertF32.run("s-" + String(j).padStart(6, "0"), f32Blob(v), Date.now());
    }
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytesFullF32 = fileBytes(dbPath);

  db.close();
  rmSync(dir, { recursive: true, force: true });

  const mb = (n: number) => n / (1024 * 1024);
  return {
    corpus: CORPUS,
    hotCap: HOT_CAP,
    mbInt8Only: mb(bytesInt8Only),
    mbInt8PlusHotF32: mb(bytesHotSubset),
    mbInt8PlusFullF32: mb(bytesFullF32),
    mbHotOverheadOverInt8: mb(bytesHotSubset - bytesInt8Only),
    mbFullOverheadOverInt8: mb(bytesFullF32 - bytesInt8Only),
    savingsPct:
      bytesFullF32 - bytesInt8Only > 0
        ? (1 - (bytesHotSubset - bytesInt8Only) / (bytesFullF32 - bytesInt8Only)) * 100
        : 0,
  };
}

async function main() {
  const lib = await findSqliteLib();
  const vecPath = await findVec0();
  if (lib === null || vecPath === null) {
    console.log(
      JSON.stringify({
        available: false,
        reason: lib === null ? "no libsqlite3 with extension support" : "no sqlite-vec (vec0)",
      }),
    );
    return;
  }
  Database.setCustomSQLite(lib);
  const recall = await benchRecall(vecPath);
  const storage = await benchStorage(vecPath);
  console.log(JSON.stringify({ available: true, recall, storage }, null, 2));
}

if (import.meta.main) {
  await main();
}
