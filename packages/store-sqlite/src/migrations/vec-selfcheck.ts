#!/usr/bin/env bun
/**
 * Проверка векторного набора миграций в ОТДЕЛЬНОМ процессе.
 *
 * Почему отдельный процесс: чтобы загрузить vec0, Bun обязан работать на
 * внешней libsqlite3 (`Database.setCustomSQLite`, приложение К
 * docs/design/01a-ddl-validation.md), а этот вызов допустим ровно один раз и
 * только ДО открытия первого соединения. `bun test` гоняет все файлы в одном
 * процессе, поэтому из теста напрямую его звать нельзя — vec.test.ts запускает
 * этот файл дочерним процессом и разбирает JSON из stdout.
 *
 * Поиск библиотек здесь — только для проверки. В проде vec0 подключает рантайм
 * (packages/store-sqlite/src/runtime.ts, задача myc-qie.2); этот модуль о нём
 * ничего не знает и знать не должен.
 */
import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";
import { migrations } from "./index.ts";
import { migrateVectors, VEC_MIGRATIONS_TABLE, vectorMigrations } from "./vec.ts";

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

/** Путь к vec0 БЕЗ расширения файла — loadExtension дописывает его сам. */
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

export interface VecSelfCheckReport {
  readonly available: boolean;
  readonly reason?: string;
  readonly sqliteVersion?: string;
  readonly vecVersion?: string;
  readonly appliedVersions?: readonly number[];
  readonly skipped?: boolean;
  readonly objects?: readonly string[];
  readonly bookkeeping?: ReadonlyArray<{ version: number; name: string }>;
  /** KNN с обязательным фильтром по (scope, layer) — решение S27. */
  readonly filteredKnn?: ReadonlyArray<{ node_rowid: number; distance: number }>;
  /** Сырой BLOB обязан быть отвергнут: vec0 читает его как float32. */
  readonly rawBlobRejected?: boolean;
  readonly rawBlobError?: string;
  /** vec_nodes_f32 (vec-002) — обычная таблица, IN(...) вместо MATCH. */
  readonly f32RoundTrip?: ReadonlyArray<{ node_id: string; matches: boolean }>;
}

async function run(): Promise<VecSelfCheckReport> {
  const lib = await findSqliteLib();
  if (lib === null) {
    return { available: false, reason: "no libsqlite3 with extension support" };
  }
  const vecPath = await findVec0();
  if (vecPath === null) {
    return { available: false, reason: "sqlite-vec extension (vec0) not found" };
  }

  try {
    Database.setCustomSQLite(lib);
  } catch (error) {
    return { available: false, reason: `setCustomSQLite: ${String(error)}` };
  }

  const db = new Database(":memory:");
  try {
    db.loadExtension(vecPath);
  } catch (error) {
    db.close();
    return { available: false, reason: `loadExtension: ${String(error)}` };
  }

  await migrate(db, { migrations, writable: true });
  const result = await migrateVectors(db, { vec0Loaded: true, writable: true });

  const vector = new Int8Array(384);
  for (let i = 0; i < 384; i++) vector[i] = ((i * 7) % 127) - 63;
  const blob = Buffer.from(vector.buffer);

  const insert = db.query(
    `INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding)
     VALUES (?1, ?2, ?3, ?4, ?5, vec_int8(?6))`,
  );
  for (let rowid = 1; rowid <= 5; rowid++) {
    const shifted = Int8Array.from(vector, (v, i) => (i < rowid ? -v : v));
    insert.run(rowid, "s1", 2, "note", 1, Buffer.from(shifted.buffer));
  }
  // Чужая партиция: обязана быть отсечена фильтром, а не отранжирована.
  insert.run(99, "s2", 3, "note", 1, blob);

  const filteredKnn = db
    .query(
      `SELECT node_rowid, distance FROM nodes_vec
        WHERE embedding MATCH vec_int8(?1) AND k = 3 AND scope = ?2 AND layer = ?3`,
    )
    .all(blob, "s1", 2) as Array<{ node_rowid: number; distance: number }>;

  let rawBlobRejected = false;
  let rawBlobError = "";
  try {
    db.query(
      `SELECT node_rowid FROM nodes_vec
        WHERE embedding MATCH ?1 AND k = 3 AND scope = ?2 AND layer = ?3`,
    ).all(blob, "s1", 2);
  } catch (error) {
    rawBlobRejected = true;
    rawBlobError = String(error);
  }

  // vec_nodes_f32 (vec-002-rerank-f32.ts) — обычная таблица, round-trip
  // обычным INSERT/SELECT, без vec_int8()/MATCH.
  const insertF32 = db.query(
    `INSERT INTO vec_nodes_f32 (node_id, embedding_f32, accessed_at) VALUES (?1, ?2, ?3)`,
  );
  const f32Vector = new Float32Array(384);
  for (let i = 0; i < 384; i++) f32Vector[i] = i / 384;
  const f32Blob = Buffer.from(f32Vector.buffer, f32Vector.byteOffset, f32Vector.byteLength);
  insertF32.run("node-f32-1", f32Blob, Date.now());
  const f32Row = db
    .query(`SELECT node_id, embedding_f32 FROM vec_nodes_f32 WHERE node_id = ?1`)
    .get("node-f32-1") as { node_id: string; embedding_f32: Uint8Array } | null;
  const f32Readback =
    f32Row === null
      ? new Float32Array(0)
      : new Float32Array(
          f32Row.embedding_f32.buffer,
          f32Row.embedding_f32.byteOffset,
          384,
        );
  const f32RoundTrip = [
    {
      node_id: "node-f32-1",
      matches: f32Row !== null && f32Readback.every((v, i) => v === f32Vector[i]),
    },
  ];

  const objects = (
    db.query("SELECT name FROM sqlite_master").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const bookkeeping = db
    .query(`SELECT version, name FROM ${VEC_MIGRATIONS_TABLE} ORDER BY version`)
    .all() as Array<{ version: number; name: string }>;
  const versions = db.query("SELECT sqlite_version() AS s, vec_version() AS v").get() as {
    s: string;
    v: string;
  };
  db.close();

  return {
    available: true,
    sqliteVersion: versions.s,
    vecVersion: versions.v,
    appliedVersions: result.appliedVersions,
    skipped: result.skipped,
    objects,
    bookkeeping,
    filteredKnn,
    rawBlobRejected,
    rawBlobError,
    f32RoundTrip,
  };
}

export const VECTOR_MIGRATION_COUNT = vectorMigrations.length;

if (import.meta.main) {
  console.log(JSON.stringify(await run(), null, 2));
}
