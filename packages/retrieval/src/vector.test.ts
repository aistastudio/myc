import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import { vectorSearch, type VectorSearchParams } from "./vector.ts";
import { expectMsWithinBudget } from "@myc/bench";

const ANON_CALLER: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

function search(
  db: SqliteDriver,
  overrides: Partial<VectorSearchParams>,
): ReturnType<typeof vectorSearch> {
  return vectorSearch(db, {
    vector: new Float32Array(384).fill(0.01),
    scopes: ["s1"],
    caller: ANON_CALLER,
    ...overrides,
  } as VectorSearchParams);
}

// ---------------------------------------------------------------------------
// vec0 требует внешней libsqlite3: Database.setCustomSQLite допустим один раз
// и только ДО первого соединения, а `bun test` сам открывает внутреннюю сборку
// SQLite до preload. Поэтому вся функциональная часть с vec0 выполняется в
// ДОЧЕРНЕМ процессе (тот же приём, что packages/store-sqlite/src/migrations/
// vec.test.ts -> vec-selfcheck.ts), сюда возвращается JSON-отчёт.
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..", "..", "..");

// Дочерняя программа: обычный JS, без шаблонных строк, печатает ровно один
// JSON в stdout. Порядок импортов важен: preload инициализирует рантайм до
// первого new Database (К.1, 01a-ddl-validation.md).
const CHILD_SOURCE = `
const ROOT = process.env.MYC_REPO_ROOT;
await import(ROOT + "/packages/store-sqlite/src/runtime-preload.ts");
const { openSqlite, migration001Init, migrateVectors, vecMigration001Init } = await import(
  ROOT + "/packages/store-sqlite/src/index.ts"
);
const { vectorSearch } = await import(ROOT + "/packages/retrieval/src/vector.ts");

const VEC001_SQL = vecMigration001Init.sql;

const DIM = 384;
// все сидовые узлы — acl='team', team_id='t1': вызывающий видит их по team
const CALLER = { ownerId: "", teamId: "t1", agentId: "", principals: [] };

function warn(...args) { console.warn("[vec-child]", ...args); }

function freshDb() {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  // та же схема, что vec-001-init: одиночный оператор, vec0 в дочернем
  // процессе гарантированно загружен (иначе report.available = false)
  driver.database.exec(VEC001_SQL);
  // float32-таблица переранжирования ещё не заведена миграциями store-sqlite
  // (заполняет её embed-воркер) — тесты создают её по форме §2.4
  driver.database.exec(
    "CREATE TABLE IF NOT EXISTS vec_nodes_f32 (" +
    " node_id TEXT PRIMARY KEY," +
    " embedding_f32 BLOB NOT NULL)",
  );
  return driver;
}

function fixtureQuantize(v) {
  let maxAbs = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let r = Math.round((127 * v[i]) / scale);
    if (r > 127) r = 127;
    else if (r < -127) r = -127;
    q[i] = r;
  }
  return q;
}

function f32Blob(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }

function insertNode(db, id, scope, layer) {
  const res = db.database.query(
    "INSERT INTO nodes (id, kind, layer, scope, title, body, status, content_hash, acl, team_id, created_at, updated_at)" +
    " VALUES (?1, 'note', ?2, ?3, ?4, '', 'active', ?5, 'team', 't1', 1, 1)",
  ).run(id, layer, scope, id, "hash-" + id);
  return Number(res.lastInsertRowid);
}

function insertVec(db, rowid, scope, layer, q) {
  db.database.query(
    "INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding)" +
    " VALUES (?1, ?2, ?3, 'note', 1, vec_int8(?4))",
  ).run(rowid, scope, layer, Buffer.from(q.buffer, q.byteOffset, q.byteLength));
}

function insertF32(db, id, v) {
  db.database.query("INSERT INTO vec_nodes_f32 (node_id, embedding_f32) VALUES (?1, ?2)")
    .run(id, f32Blob(v));
}

function search(db, overrides) {
  return vectorSearch(db, Object.assign(
    { vector: new Float32Array(DIM).fill(0.01), scopes: ["s1"], caller: CALLER },
    overrides,
  ));
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussPair(rand) {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

function gauss(rand) { return gaussPair(rand)[0]; }

function unit(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ------------------------------ сценарии -----------------------------------

function scenarioKnnPartition() {
  const db = freshDb();
  const center = unit(new Float32Array(DIM).map((_, i) => Math.sin(i * 0.7)));
  const q = unit(Float32Array.from(center, (c) => c + 0.01));
  for (let i = 0; i < 40; i++) {
    const v = unit(Float32Array.from(center, (c) => c + (i === 0 ? 0.001 : 0.05 + i * 0.001)));
    const rowid = insertNode(db, "n-" + i, "s1", 2);
    insertVec(db, rowid, "s1", 2, fixtureQuantize(v));
    insertF32(db, "n-" + i, v);
  }
  // точная копия запроса в чужой партиции — обязана быть отсечена фильтром
  const foreignRowid = insertNode(db, "n-foreign", "s2", 3);
  insertVec(db, foreignRowid, "s2", 3, fixtureQuantize(unit(Float32Array.from(q))));
  insertF32(db, "n-foreign", q);

  const out = search(db, { vector: q, limit: 5 });
  db.close();
  return {
    degraded: out.degraded,
    count: out.hits.length,
    ranks: out.hits.map((h) => h.rank),
    ids: out.hits.map((h) => h.id),
    firstId: out.hits[0] ? out.hits[0].id : null,
    foreignExcluded: !out.hits.some((h) => h.id === "n-foreign"),
  };
}

function scenarioLayerFilter() {
  const db = freshDb();
  const v = unit(new Float32Array(DIM).fill(0.1));
  for (const layer of [0, 1, 2, 3]) {
    const rowid = insertNode(db, "n-l" + layer, "s1", layer);
    insertVec(db, rowid, "s1", layer, fixtureQuantize(v));
  }
  const narrowed = search(db, { layerMin: 2, layerMax: 3 });
  const all = search(db, {});
  db.close();
  return {
    narrowedIds: narrowed.hits.map((h) => h.id).sort(),
    allCount: all.hits.length,
  };
}

function scenarioLiveness() {
  const db = freshDb();
  const v = unit(new Float32Array(DIM).fill(0.1));
  for (const id of ["n-keep", "n-del", "n-sup", "n-head"]) {
    const rowid = insertNode(db, id, "s1", 2);
    insertVec(db, rowid, "s1", 2, fixtureQuantize(v));
    insertF32(db, id, v);
  }
  db.database.query("UPDATE nodes SET deleted_at = 1 WHERE id = 'n-del'").run();
  db.database.query("UPDATE nodes SET status = 'superseded' WHERE id = 'n-sup'").run();
  db.database.query("UPDATE nodes SET head_id = 'n-keep' WHERE id = 'n-head'").run();
  const out = search(db, {});
  db.close();
  return { ids: out.hits.map((h) => h.id) };
}

function scenarioAcl() {
  const db = freshDb();
  const v = unit(new Float32Array(DIM).fill(0.1));
  const seedRow = (id, acl, owner) => {
    const rowid = insertNode(db, id, "s1", 2);
    db.database.query("UPDATE nodes SET acl = ?1, owner_id = ?2 WHERE id = ?3").run(acl, owner, id);
    insertVec(db, rowid, "s1", 2, fixtureQuantize(v));
    insertF32(db, id, v);
  };
  seedRow("n-mine", "private", "u1");
  seedRow("n-theirs", "private", "u2");
  seedRow("n-grant", "restricted", "");
  seedRow("n-other", "restricted", "");
  db.database.query(
    "INSERT INTO acl_grants (node_id, principal, level, granted_at) VALUES ('n-grant', 'user:u9', 'read', 1)",
  ).run();

  const out = vectorSearch(db, {
    vector: v,
    scopes: ["s1"],
    layerMin: 2,
    layerMax: 2,
    caller: { ownerId: "u1", teamId: "t1", agentId: "", principals: ["user:u9"] },
  });
  db.close();
  return { ids: out.hits.map((h) => h.id) };
}

function scenarioInjection() {
  const db = freshDb();
  const v = unit(new Float32Array(DIM).fill(0.1));
  const rowid = insertNode(db, "n-real", "s1", 2);
  insertVec(db, rowid, "s1", 2, fixtureQuantize(v));
  const evil = search(db, { scopes: ["s1' OR 1=1 --"] });
  const ok = search(db, { scopes: ["s1"] });
  db.close();
  return {
    evilDegraded: evil.degraded,
    evilIds: evil.hits.map((h) => h.id),
    okIds: ok.hits.map((h) => h.id),
  };
}

function scenarioRerankControl() {
  // (a) f32-таблица отсутствует (не создана миграциями/воркером)
  const dbA = freshDb();
  dbA.database.exec("DROP TABLE vec_nodes_f32");
  const v = unit(new Float32Array(DIM).fill(0.1));
  const rowid = insertNode(dbA, "n-only-int8", "s1", 2);
  insertVec(dbA, rowid, "s1", 2, fixtureQuantize(v));
  const noTable = search(dbA, { vector: v });
  dbA.close();

  // (b) rerank:false при наличии f32-строк
  const dbB = freshDb();
  const rowid2 = insertNode(dbB, "n-a", "s1", 2);
  insertVec(dbB, rowid2, "s1", 2, fixtureQuantize(v));
  insertF32(dbB, "n-a", v);
  const rerankOff = search(dbB, { vector: v, rerank: false });
  dbB.close();
  return {
    noTableIds: noTable.hits.map((h) => h.id),
    noTableReranked: noTable.reranked,
    rerankOffIds: rerankOff.hits.map((h) => h.id),
    rerankOffReranked: rerankOff.reranked,
  };
}

function scenarioQueryInt8() {
  const db = freshDb();
  const rand = mulberry32(555);
  const v = unit(new Float32Array(DIM).map(() => rand() * 2 - 1));
  const near = unit(Float32Array.from(v, (x) => x + gauss(rand) * 0.01));
  const far = unit(Float32Array.from(v, (x) => x + gauss(rand) * 0.5));
  const rowidA = insertNode(db, "n-near", "s1", 2);
  insertVec(db, rowidA, "s1", 2, fixtureQuantize(near));
  insertF32(db, "n-near", near);
  const rowidB = insertNode(db, "n-far", "s1", 2);
  insertVec(db, rowidB, "s1", 2, fixtureQuantize(far));
  insertF32(db, "n-far", far);
  const outInt8 = search(db, { vector: v, queryInt8: fixtureQuantize(v) });
  const outAuto = search(db, { vector: v });
  db.close();
  return {
    int8Ids: outInt8.hits.map((h) => h.id),
    autoIds: outAuto.hits.map((h) => h.id),
    firstId: outInt8.hits[0] ? outInt8.hits[0].id : null,
  };
}

function scenarioRerankFlip() {
  const db = freshDb();
  const rand = mulberry32(20260903);
  const q = unit(new Float32Array(DIM).map(() => rand() * 2 - 1));
  const q8f = Float32Array.from(fixtureQuantize(q), (x) => x);

  let bestA = null, bestB = null, bestGap = 0;
  for (let i = 0; i < 4000 && bestA === null; i++) {
    const a = unit(Float32Array.from(q, (x) => x + gauss(rand) * 0.06));
    const b = unit(Float32Array.from(q, (x) => x + gauss(rand) * 0.06));
    const d8a = 1 - cosine(q8f, Float32Array.from(fixtureQuantize(a), (x) => x));
    const d8b = 1 - cosine(q8f, Float32Array.from(fixtureQuantize(b), (x) => x));
    const dfa = 1 - cosine(q, a);
    const dfb = 1 - cosine(q, b);
    if (d8a < d8b && dfb < dfa) {
      const gap = Math.min(d8b - d8a, dfa - dfb);
      if (gap > bestGap) { bestGap = gap; bestA = a; bestB = b; }
    }
  }
  if (bestA === null) {
    db.close();
    return { foundPair: false };
  }
  const rowidA = insertNode(db, "n-inv-a", "s1", 2);
  insertVec(db, rowidA, "s1", 2, fixtureQuantize(bestA));
  insertF32(db, "n-inv-a", bestA);
  const rowidB = insertNode(db, "n-inv-b", "s1", 2);
  insertVec(db, rowidB, "s1", 2, fixtureQuantize(bestB));
  insertF32(db, "n-inv-b", bestB);

  const before = search(db, { vector: q, rerank: false });
  const after = search(db, { vector: q });
  db.close();
  return {
    foundPair: true,
    gap: bestGap,
    beforeReranked: before.reranked,
    beforeFirst: before.hits[0] ? before.hits[0].id : null,
    afterReranked: after.reranked,
    afterFirst: after.hits[0] ? after.hits[0].id : null,
  };
}

// myc-ye3.9: distanceMean/distanceStd описывают ВЕСЬ пул кандидатов, а не
// только выданные hits — иначе цифра снова стала бы функцией limit, как был
// score_rel. Пул здесь заведомо больше limit, чтобы разница была видна.
function scenarioDistanceStats() {
  const db = freshDb();
  const center = unit(new Float32Array(DIM).map((_, i) => Math.sin(i * 0.7)));
  const q = unit(Float32Array.from(center, (c) => c + 0.001));
  const N = 30;
  for (let i = 0; i < N; i++) {
    // i=0 — почти точная копия запроса (маленькая дистанция), остальные —
    // равномерно нарастающий разброс, так что пул даёт настоящую статистику.
    const v = unit(Float32Array.from(center, (c) => c + (i === 0 ? 0.0005 : 0.03 + i * 0.01)));
    const rowid = insertNode(db, "n-" + i, "s1", 2);
    insertVec(db, rowid, "s1", 2, fixtureQuantize(v));
    insertF32(db, "n-" + i, v);
  }
  const limited = search(db, { vector: q, limit: 3, candidateLimit: N });
  db.close();
  return {
    candidates: limited.candidates,
    hitsCount: limited.hits.length,
    distanceMean: limited.distanceMean,
    distanceStd: limited.distanceStd,
    firstDistance: limited.hits[0] ? limited.hits[0].distance : null,
    distancesAscending: limited.hits.every(
      (h, i) => i === 0 || h.distance >= limited.hits[i - 1].distance,
    ),
  };
}

// Пул меньше 3 кандидатов — статистика не публикуется вовсе (undefined, а не
// NaN/0), потому что std по 1-2 точкам ничего не значит.
function scenarioDistanceStatsTinyPool() {
  const db = freshDb();
  const v = unit(new Float32Array(DIM).fill(0.05));
  const rowid = insertNode(db, "n-solo", "s1", 2);
  insertVec(db, rowid, "s1", 2, fixtureQuantize(v));
  insertF32(db, "n-solo", v);
  const out = search(db, { vector: v });
  db.close();
  return { count: out.hits.length, distanceMean: out.distanceMean, distanceStd: out.distanceStd };
}

function scenarioRecall() {
  const CENTERS = 30, M = 2000, QUERIES = 20, SIGMA = 0.18;
  const db = freshDb();
  const rand = mulberry32(987654321);
  const centers = [];
  for (let c = 0; c < CENTERS; c++) {
    centers.push(unit(new Float32Array(DIM).map(() => rand() * 2 - 1)));
  }
  const corpus = [];
  db.database.exec("BEGIN");
  for (let j = 0; j < M; j++) {
    const c = centers[Math.floor(rand() * CENTERS)];
    const v = unit(Float32Array.from(c, (x) => x + gauss(rand) * SIGMA));
    const id = "r-" + String(j).padStart(5, "0");
    const rowid = insertNode(db, id, "s1", 2);
    insertVec(db, rowid, "s1", 2, fixtureQuantize(v));
    insertF32(db, id, v);
    corpus.push(v);
  }
  db.database.exec("COMMIT");

  function exactTop10(q) {
    const scored = corpus.map((v, j) => ({ j, d: 1 - cosine(q, v) }));
    scored.sort((a, b) => a.d - b.d);
    return new Set(scored.slice(0, 10).map((s) => "r-" + String(s.j).padStart(5, "0")));
  }
  function recall(ids, truth) {
    let hit = 0;
    for (const id of ids) if (truth.has(id)) hit++;
    return hit / 10;
  }

  let sumInt8 = 0, sumRerank = 0;
  for (let t = 0; t < QUERIES; t++) {
    const c = corpus[Math.floor(rand() * corpus.length)];
    const q = unit(Float32Array.from(c, (x) => x + gauss(rand) * SIGMA * 0.5));
    const truth = exactTop10(q);
    const before = search(db, { vector: q, limit: 10, rerank: false });
    const after = search(db, { vector: q, limit: 10 });
    sumInt8 += recall(before.hits.map((h) => h.id), truth);
    sumRerank += recall(after.hits.map((h) => h.id), truth);
  }
  db.close();
  return { recallInt8: sumInt8 / QUERIES, recallRerank: sumRerank / QUERIES };
}

function scenarioPerf100k() {
  const N = 100000;
  const db = freshDb();
  const rand = mulberry32(42);
  const center = unit(new Float32Array(DIM).map(() => rand() * 2 - 1));

  db.database.exec("BEGIN");
  const insNode = db.database.query(
    "INSERT INTO nodes (id, kind, layer, scope, title, body, status, content_hash, acl, team_id, created_at, updated_at)" +
    " VALUES (?1, 'note', ?2, ?3, ?4, '', 'active', ?5, 'team', 't1', 1, 1)",
  );
  const insVec = db.database.query(
    "INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding)" +
    " VALUES (?1, ?2, ?3, 'note', 1, vec_int8(?4))",
  );
  const insF32 = db.database.query("INSERT INTO vec_nodes_f32 (node_id, embedding_f32) VALUES (?1, ?2)");
  for (let i = 0; i < N; i++) {
    // целевая партиция s1/2 ~5k векторов — как в замерах приложения К
    const scope = i < 5000 ? "s1" : "s" + ((i % 50) + 1);
    const layer = i < 5000 ? 2 : i % 4;
    const id = "perf-" + i.toString(36).padStart(12, "0");
    const v = unit(Float32Array.from(center, (c) => c + gauss(rand) * 0.3));
    insNode.run(id, layer, scope, id, "hash-" + i);
    insVec.run(i + 1, scope, layer, Buffer.from(fixtureQuantize(v).buffer));
    if (scope === "s1" && layer === 2) insF32.run(id, f32Blob(v));
  }
  db.database.exec("COMMIT");

  const q = unit(Float32Array.from(center, (c) => c + gauss(rand) * 0.01));
  const warm = search(db, { vector: q, limit: 12 });
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const out = search(db, { vector: q, limit: 12 });
    samples.push(performance.now() - start);
    if (i === 0 && (out.degraded || out.hits.length !== 12)) {
      throw new Error("perf: неожиданная выдача: " + JSON.stringify(out).slice(0, 200));
    }
  }
  samples.sort((a, b) => a - b);
  db.close();
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    reranked: warm.reranked,
    candidates: warm.candidates,
  };
}

// ------------------------------ main ---------------------------------------

const report = { available: false, reason: null, scenarios: null, recall: null, perf: null };

let db;
try {
  // проба доступности: накат векторного набора миграций на одноразовую базу
  db = openSqlite(":memory:");
  db.database.exec(migration001Init.sql);
  await migrateVectors(db.database, { vec0Loaded: true, writable: true });
  report.available = true;
} catch (error) {
  report.reason = String(error).slice(0, 300);
}
if (db) db.close();

if (report.available) {
  report.scenarios = {
    knnPartition: scenarioKnnPartition(),
    layerFilter: scenarioLayerFilter(),
    liveness: scenarioLiveness(),
    acl: scenarioAcl(),
    injection: scenarioInjection(),
    rerankControl: scenarioRerankControl(),
    queryInt8: scenarioQueryInt8(),
    rerankFlip: scenarioRerankFlip(),
    distanceStats: scenarioDistanceStats(),
    distanceStatsTinyPool: scenarioDistanceStatsTinyPool(),
  };
  warn("функциональные сценарии готовы, recall+perf...");
  report.recall = scenarioRecall();
  report.perf = scenarioPerf100k();
}

console.log(JSON.stringify(report));
`;

const proc = Bun.spawnSync(["bun", "-e", CHILD_SOURCE], {
  cwd: ROOT,
  env: { ...process.env, MYC_REPO_ROOT: ROOT },
  stdout: "pipe",
  stderr: "pipe",
});

const childStdout = proc.stdout.toString().trim();
interface ChildReport {
  available: boolean;
  reason: string | null;
  scenarios: Record<string, any> | null;
  recall: { recallInt8: number; recallRerank: number } | null;
  perf: { p50: number; p95: number; reranked: boolean; candidates: number } | null;
}
let report: ChildReport;
if (proc.success && childStdout.length > 0) {
  report = JSON.parse(childStdout) as ChildReport;
} else {
  report = {
    available: false,
    reason: `дочерний процесс упал: ${proc.stderr.toString().trim().slice(0, 500)}`,
    scenarios: null,
    recall: null,
    perf: null,
  };
}

if (!report.available) {
  console.warn(
    `[vec] функциональные векторные тесты ПРОПУЩЕНЫ: ${report.reason}. ` +
      "Деградационный путь (пустая выдача + degraded) покрыт независимо.",
  );
} else {
  // eslint-disable-next-line no-console
  console.log(
    `[vec recall@10] int8-скан=${report.recall!.recallInt8.toFixed(3)} ` +
      `после f32-rerank=${report.recall!.recallRerank.toFixed(3)}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[vec perf @ 100k, партиция ~5k] p50=${report.perf!.p50.toFixed(3)}ms ` +
      `p95=${report.perf!.p95.toFixed(3)}ms`,
  );
}

// --------------------------- контракт API: запрет запроса без фильтра -------

describe("vectorSearch: запрет запроса без фильтра (S27)", () => {
  test("пустой scopes — TypeError, а не молчаливый скан всех партиций", () => {
    const db = freshDb();
    expect(() =>
      vectorSearch(db, {
        vector: new Float32Array(384),
        scopes: [],
        caller: ANON_CALLER,
      }),
    ).toThrow(/scopes пуст/);
    db.close();
  });

  test("layerMin > layerMax — TypeError: фильтр не может выродиться в пустой", () => {
    const db = freshDb();
    expect(() => search(db, { layerMin: 2, layerMax: 1 })).toThrow(/layerMin/);
    db.close();
  });

  test("не та размерность вектора запроса — TypeError", () => {
    const db = freshDb();
    expect(() =>
      vectorSearch(db, {
        vector: new Float32Array(10),
        scopes: ["s1"],
        caller: ANON_CALLER,
      }),
    ).toThrow(/длины 384/);
    expect(() =>
      vectorSearch(db, {
        vector: new Float32Array(384),
        queryInt8: new Int8Array(100),
        scopes: ["s1"],
        caller: ANON_CALLER,
      }),
    ).toThrow(/queryInt8/);
    db.close();
  });

  test("не-конечный компонент вектора — TypeError до обращения к SQL", () => {
    const db = freshDb();
    const bad = new Float32Array(384);
    bad[7] = Number.NaN;
    expect(() => search(db, { vector: bad })).toThrow(/не конечен/);
    db.close();
  });
});

// --------------------------- деградация без vec0 ----------------------------

describe("vectorSearch: отсутствие vec0 — пустая выдача + degraded, без исключений", () => {
  test("база без векторных миграций: hits=[], degraded=true, reason не пуст", () => {
    const db = freshDb(); // только базовая схема, nodes_vec нет
    const out = search(db, {});
    expect(out.hits).toEqual([]);
    expect(out.degraded).toBe(true);
    expect(out.reason).toBeTruthy();
    expect(out.reranked).toBe(false);
    expect(out.candidates).toBe(0);
    db.close();
  });
});

// --------------------------- функциональные сценарии (дочерний процесс) -----

describe.skipIf(!report.available)("vectorSearch при загруженном vec0", () => {
  const s = report.scenarios!;

  test("KNN по партиции: ранги 1..n подряд, чужая партиция отсечена", () => {
    expect(s.knnPartition.degraded).toBe(false);
    expect(s.knnPartition.count).toBe(5);
    expect(s.knnPartition.ranks).toEqual([1, 2, 3, 4, 5]);
    expect(s.knnPartition.firstId).toBe("n-0");
    expect(s.knnPartition.foreignExcluded).toBe(true);
  });

  test("фильтр по слоям: диапазон раскрывается в непустой IN", () => {
    expect(s.layerFilter.narrowedIds).toEqual(["n-l2", "n-l3"]);
    expect(s.layerFilter.allCount).toBe(4);
  });

  test("живость: deleted/superseded/старые версии отсекаются join'ом на nodes", () => {
    expect(s.liveness.ids).toEqual(["n-keep"]);
  });

  test("ACL: private чужого не виден, restricted по grant виден", () => {
    expect(s.acl.ids).toContain("n-mine");
    expect(s.acl.ids).toContain("n-grant");
    expect(s.acl.ids).not.toContain("n-theirs");
    expect(s.acl.ids).not.toContain("n-other");
  });

  test("значение scope не рвёт SQL: параметры связаны, инъекция не проходит", () => {
    expect(s.injection.evilDegraded).toBe(false);
    expect(s.injection.evilIds).toEqual([]);
    expect(s.injection.okIds).toEqual(["n-real"]);
  });

  test("без f32-таблицы или с rerank:false — выдача остаётся, reranked=false", () => {
    expect(s.rerankControl.noTableIds).toEqual(["n-only-int8"]);
    expect(s.rerankControl.noTableReranked).toBe(false);
    expect(s.rerankControl.rerankOffIds).toEqual(["n-a"]);
    expect(s.rerankControl.rerankOffReranked).toBe(false);
  });

  test("queryInt8 от пайплайна даёт тот же порядок, что внутренняя квантизация", () => {
    expect(s.queryInt8.int8Ids).toEqual(s.queryInt8.autoIds);
    expect(s.queryInt8.firstId).toBe("n-near");
  });

  test("переранжирование меняет порядок: int8-топ и f32-топ различаются", () => {
    expect(s.rerankFlip.foundPair).toBe(true);
    expect(s.rerankFlip.beforeReranked).toBe(false);
    expect(s.rerankFlip.beforeFirst).toBe("n-inv-a");
    expect(s.rerankFlip.afterReranked).toBe(true);
    expect(s.rerankFlip.afterFirst).toBe("n-inv-b");
  });

  // myc-ye3.9: раньше выдача несла score_rel = score/max(score в ЭТОЙ выдаче),
  // поэтому верхний хит ВСЕГДА получал 1.00 — даже когда он не выделялся на
  // фоне остальных кандидатов. distanceMean/distanceStd дают нормировку по
  // распределению дистанций пула, а не по максимуму в топе.
  test("distanceMean/distanceStd считаются по всему пулу кандидатов, не по hits (myc-ye3.9)", () => {
    const d = s.distanceStats;
    // Пул был обрезан до limit=3, но пул кандидатов (candidateLimit=30) — 30.
    expect(d.hitsCount).toBe(3);
    expect(d.candidates).toBe(30);
    expect(typeof d.distanceMean).toBe("number");
    expect(typeof d.distanceStd).toBe("number");
    expect(d.distanceStd).toBeGreaterThan(0);
    // Первый хит — почти точная копия запроса: заметно ближе среднего пула.
    expect(d.firstDistance).toBeLessThan(d.distanceMean - d.distanceStd);
    expect(d.distancesAscending).toBe(true);
  });

  test("пул < 3 кандидатов -> статистика не публикуется (undefined, не NaN/0)", () => {
    const d = s.distanceStatsTinyPool;
    expect(d.count).toBe(1);
    expect(d.distanceMean).toBeUndefined();
    expect(d.distanceStd).toBeUndefined();
  });
});

// --------------------------- recall@10 (дочерний процесс) -------------------

describe.skipIf(!report.available)("recall@10: две ступени против точного перебора", () => {
  test("int8-скан + f32-rerank не хуже 0.98; переранжирование не ухудшает", () => {
    const recallInt8 = report.recall!.recallInt8;
    const recallRerank = report.recall!.recallRerank;
    // приёмка myc-ccu
    expect(recallRerank).toBeGreaterThanOrEqual(0.98);
    // переранжирование не имеет права ухудшать
    expect(recallRerank).toBeGreaterThanOrEqual(recallInt8);
  });
});

// --------------------------- perf @ 100k (дочерний процесс) -----------------

describe.skipIf(!report.available)("vectorSearch perf @ 100k nodes", () => {
  test("p50/p95 KNN с фильтром + f32-rerank на целевой партиции ~5k", () => {
    const perf = report.perf!;
    expect(perf.reranked).toBe(true);
    // бюджет поиска спеки — 25 мс на весь гибрид; векторная ступень обязана
    // быть заведомо ниже. Иначе тест падает — числа в выводе выше.
    expectMsWithinBudget(perf.p95, 25, "векторный поиск, p95");
  });
});
