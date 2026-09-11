// Кандидаты на подтверждение (§6.2, memory-7j8zgjnd0bjz) не доезжают до
// выдачи ни одним путём ретривала: лексика, обход графа, векторная ветка,
// федерация, объяснение пустоты. Каждый путь — отдельный тест, потому что
// фильтр стоит в КАЖДОМ запросе отдельно, и снятие любого одного из них
// обязано что-то уронить (мутации перечислены у тестов).
//
// Кандидат здесь пишется так же, как его пишет хук сжатия
// (packages/cli/src/hooks/absorb-session.ts): note L2, salience 0, acl
// private, attrs.state = 'pending_review'. Путь «настоящий хук → recall/prime»
// проверяется в CLI (packages/cli/src/commands/pending-review.test.ts).

import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generateId } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { federatedSearch } from "./federation.ts";
import { ftsSearch } from "./fts.ts";
import type { FtsCaller } from "./fts.ts";
import { hybridSearch, type HybridVectorSource } from "./hybrid.ts";
import {
  PENDING_REVIEW,
  awaitingReviewPredicate,
  isPendingReview,
  notPendingPredicate,
} from "./review.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

interface Seed {
  readonly id?: string;
  readonly title: string;
  readonly body?: string;
  readonly layer?: 0 | 1 | 2 | 3;
  readonly acl?: "private" | "team";
  readonly status?: string;
  readonly attrs?: Record<string, unknown>;
}

function insert(db: SqliteDriver, seed: Seed): string {
  const id = seed.id ?? generateId();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          content_hash, acl, owner_id, team_id, agent_id, salience, attrs,
                          created_at, updated_at)
       VALUES (?1, 'note', ?2, 's1', ?3, ?4, ?5, 2, ?6, ?7, ?8, '', '', '', ?9, ?10, 1, 1)`,
    )
    .run(
      id,
      seed.layer ?? 2,
      seed.title,
      seed.body ?? null,
      (seed.body ?? seed.title).slice(0, 120),
      seed.status ?? "active",
      `hash-${id}`,
      seed.acl ?? "team",
      seed.attrs?.["state"] === PENDING_REVIEW ? 0 : 0.5,
      JSON.stringify(seed.attrs ?? {}),
    );
  return id;
}

/** Кандидат в той форме, в какой его пишет writeCandidates хука сжатия. */
function candidate(db: SqliteDriver, title: string, id?: string): string {
  return insert(db, {
    ...(id !== undefined ? { id } : {}),
    title,
    acl: "private",
    attrs: {
      state: PENDING_REVIEW,
      extracted_by: "precompact",
      episode_id: "ep-1",
      agent: "claude",
      reach: "session",
      session_id: "S-1",
    },
  });
}

function relate(db: SqliteDriver, src: string, dst: string): void {
  db.database
    .query(
      `INSERT INTO edges (src, type, dst, weight, add_tag, created_at) VALUES (?1, 'relates', ?2, 1.0, ?3, 1)`,
    )
    .run(src, dst, generateId());
}

function confirm(db: SqliteDriver, id: string): void {
  // Подтверждение — смена attrs.state. Команды для него пока нет (дистиллятор
  // — заглушка), поэтому тест делает то, что сделает он: переписывает ключ.
  db.database
    .query(`UPDATE nodes SET attrs = json_set(attrs, '$.state', 'confirmed') WHERE id = ?1`)
    .run(id);
}

const ids = (hits: readonly { id: string }[]): string[] => hits.map((h) => h.id);

describe("предикат и его зеркало в JS — одна таблица истинности", () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ["состояния нет", {}],
    ["кандидат", { state: "pending_review" }],
    ["подтверждён", { state: "confirmed" }],
    ["state = null", { state: null }],
    ["слово в тегах, не в состоянии", { tags: ["pending_review"], note: "pending_review" }],
    ["другой регистр — другое значение", { state: "PENDING_REVIEW" }],
  ];
  for (const [label, attrs] of cases) {
    test(label, () => {
      const db = freshDb();
      const id = insert(db, { title: label, attrs });
      const row = db.database
        .query<{ visible: number }, [string]>(
          `SELECT ${notPendingPredicate("n")} AS visible FROM nodes n WHERE n.id = ?1`,
        )
        .get(id)!;
      expect(row.visible === 1).toBe(!isPendingReview(attrs));
    });
  }

  test("«ждёт разбора» — кандидат без решения; отклонённый разбор прошёл", () => {
    const db = freshDb();
    const waiting = candidate(db, "решили ждать");
    const rejected = insert(db, { title: "решили отклонить", status: "retracted", attrs: { state: PENDING_REVIEW } });
    const plain = insert(db, { title: "обычная заметка" });
    const awaiting = db.database
      .query<{ id: string }, []>(`SELECT n.id FROM nodes n WHERE ${awaitingReviewPredicate("n")}`)
      .all()
      .map((r) => r.id);
    expect(awaiting).toEqual([waiting]);
    expect(awaiting).not.toContain(rejected);
    expect(awaiting).not.toContain(plain);
  });
});

describe("hybridSearch: кандидат не отдаётся, обычная заметка с тем же текстом — да", () => {
  const TEXT = "решили держать константу сглаживания RRF равной шестидесяти";

  test("идеальное лексическое совпадение: кандидат скрыт, заметка видна", () => {
    const db = freshDb();
    const cand = candidate(db, TEXT);
    const note = insert(db, { title: TEXT, body: TEXT });
    const r = hybridSearch(db, { text: TEXT, scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(ids(r.hits)).toContain(note);
    expect(ids(r.hits)).not.toContain(cand);
  });

  test("после подтверждения кандидат отдаётся", () => {
    const db = freshDb();
    const cand = candidate(db, TEXT);
    const before = hybridSearch(db, { text: TEXT, scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(ids(before.hits)).not.toContain(cand);
    confirm(db, cand);
    const after = hybridSearch(db, { text: TEXT, scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(ids(after.hits)).toContain(cand);
  });

  // ОКНО СКАНА. Пул лексики — top-100 (poolSize). Сто кандидатов, у которых
  // терм стоит в заголовке (вес 10) дважды, по BM25 лучше обычной заметки, где
  // он один раз в теле. Фильтр ПОСЛЕ LIMIT отдал бы весь пул кандидатам и
  // выбросил их на гидратации — обычная заметка не доехала бы вовсе.
  // Мутация «снять фильтр из CTE matches в hybridLexicalPass» роняет этот тест.
  test("100 кандидатов с лучшим BM25 не вытесняют одну обычную заметку из пула", () => {
    const db = freshDb();
    for (let i = 0; i < 100; i++) candidate(db, `фьюжн фьюжн ${i}`);
    const note = insert(db, {
      title: "заметка про слияние выдачи",
      body: "в длинном теле этой заметки слово фьюжн встречается ровно один раз среди прочих слов",
    });
    const r = hybridSearch(db, {
      text: "фьюжн",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "never",
      limit: 12,
    });
    expect(ids(r.hits)).toEqual([note]);
    expect(r.mode_used.lexical.hits).toBe(1);
  });

  // ОБХОД ГРАФА входит через рёбра, а не через matches: кандидат, связанный с
  // найденной заметкой, приехал бы соседом. Мутация «снять фильтр из
  // финального WHERE hybridLexicalPass» роняет этот тест.
  test("кандидат-сосед найденной заметки не въезжает обходом графа", () => {
    const db = freshDb();
    const seed = insert(db, { title: "очередь готовых задач считается одним сканом индекса" });
    const cand = candidate(db, "решили оставить аренду на тридцать минут");
    const plain = insert(db, { title: "аренда продлевается агентом" });
    relate(db, seed, cand);
    relate(db, seed, plain);
    const r = hybridSearch(db, { text: "очередь индекса", scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(ids(r.hits)).toContain(seed);
    expect(ids(r.hits)).toContain(plain); // обход работает — иначе тест ничего не доказывал бы
    expect(ids(r.hits)).not.toContain(cand);
  });

  // ВЕКТОРНАЯ ВЕТКА приносит узлы, которых лексика не нашла, и они
  // гидратируются отдельным запросом. Мутация «снять фильтр из hybridHydrate»
  // роняет этот тест.
  test("кандидат из векторного источника не гидратируется в выдачу", () => {
    const db = freshDb();
    const cand = candidate(db, "договорились хранить вектор внутри базы");
    const plain = insert(db, { title: "векторное хранилище живёт рядом с графом" });
    const source: HybridVectorSource = () => ({
      hits: [
        { id: cand, rank: 1, distance: 0.01 },
        { id: plain, rank: 2, distance: 0.02 },
      ],
      degraded: false,
      reranked: false,
      candidates: 2,
    });
    const r = hybridSearch(db, {
      text: "где лежат эмбеддинги",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "always",
      embedQuery: () => new Float32Array(384),
      vectorSource: source,
    });
    expect(ids(r.hits)).toContain(plain);
    expect(ids(r.hits)).not.toContain(cand);
  });

  // ПУСТАЯ ВЫДАЧА объясняется размером ВИДИМОГО корпуса (И2): база из одних
  // кандидатов — «искать нечего», а не «ничего не совпало». Мутация «снять
  // фильтр из hybridCorpusSize» роняет этот тест.
  test("база из одних кандидатов — store_empty, а не no_match", () => {
    const db = freshDb();
    candidate(db, "решили писать кандидатов в L2");
    const r = hybridSearch(db, { text: "бюджет холодного старта", scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(r.hits).toEqual([]);
    expect(r.mode_used.emptyReason?.code).toBe("store_empty");
    expect(r.mode_used.emptyReason?.corpusSize).toBe(0);
  });
});

describe("ftsSearch и federatedSearch — тот же фильтр", () => {
  // Мутация «снять фильтр из ftsSearch» роняет этот тест.
  test("ftsSearch: кандидат скрыт, заметка с тем же заголовком видна", () => {
    const db = freshDb();
    const cand = candidate(db, "выбрали sqlite-vec вместо отдельного сервиса");
    const note = insert(db, { title: "выбрали sqlite-vec вместо отдельного сервиса", body: "и это решение записано" });
    const hits = ftsSearch(db, { text: "sqlite-vec сервиса", scopes: ["s1"], caller: ANON });
    expect(ids(hits)).toEqual([note]);
    expect(ids(hits)).not.toContain(cand);
  });

  test("федерация: кандидат соседнего воркспейса не доезжает, его заметка — да", async () => {
    const own = freshDb();
    const other = freshDb();
    insert(own, { title: "своя заметка про оплог" });
    const cand = candidate(other, "решили хранить оплог append-only");
    const note = insert(other, { title: "соседская заметка про оплог append-only" });
    const r = await federatedSearch({
      text: "оплог",
      caller: ANON,
      vectorMode: "never",
      sources: [
        { id: "project", kind: "project", scopes: ["s1"], open: () => own },
        { id: "neighbour", kind: "repo", scopes: ["s1"], open: () => other },
      ],
    });
    const found = r.hits.filter((h) => h.source === "neighbour").map((h) => h.id);
    expect(found).toContain(note);
    expect(found).not.toContain(cand);
  });
});

// ---------------------------------------------------------------------------
// vectorSearch на настоящем vec0. Расширение грузится только до первого
// соединения, а `bun test` открывает свою сборку SQLite раньше, — поэтому
// сценарий идёт в дочернем процессе (тот же приём, что ./vector.test.ts).
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..", "..", "..");

const CHILD_SOURCE = `
const ROOT = process.env.MYC_REPO_ROOT;
await import(ROOT + "/packages/store-sqlite/src/runtime-preload.ts");
const { openSqlite, migration001Init, migrateVectors, vecMigration001Init } = await import(
  ROOT + "/packages/store-sqlite/src/index.ts"
);
const { vectorSearch } = await import(ROOT + "/packages/retrieval/src/vector.ts");

const report = { available: false, reason: null, hits: null };
let db;
try {
  db = openSqlite(":memory:");
  db.database.exec(migration001Init.sql);
  await migrateVectors(db.database, { vec0Loaded: true, writable: true });
  report.available = true;
} catch (error) {
  report.reason = String(error).slice(0, 300);
}
if (report.available) {
  const DIM = 384;
  const q = new Int8Array(DIM).fill(1);
  const near = new Int8Array(DIM).fill(1);
  const far = new Int8Array(DIM).fill(1);
  for (let i = 0; i < 40; i++) far[i] = -1;
  const put = (id, vec, attrs) => {
    const res = db.database.query(
      "INSERT INTO nodes (id, kind, layer, scope, title, body, status, content_hash, acl, team_id, attrs, created_at, updated_at)" +
      " VALUES (?1, 'note', 2, 's1', ?1, '', 'active', ?2, 'team', '', ?3, 1, 1)",
    ).run(id, "hash-" + id, JSON.stringify(attrs));
    db.database.query(
      "INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding) VALUES (?1, 's1', 2, 'note', 1, vec_int8(?2))",
    ).run(Number(res.lastInsertRowid), Buffer.from(vec.buffer));
  };
  // Двадцать кандидатов ровно на векторе запроса и одна обычная заметка
  // дальше: без фильтра до LIMIT все пять мест выдачи заняли бы кандидаты.
  for (let i = 0; i < 20; i++) put("cand-" + i, near, { state: "pending_review", episode_id: "ep" });
  put("plain", far, {});
  const out = vectorSearch(db, {
    vector: new Float32Array(DIM).fill(0.1),
    queryInt8: q,
    scopes: ["s1"],
    caller: { ownerId: "", teamId: "", agentId: "", principals: [] },
    limit: 5,
    rerank: false,
  });
  report.hits = out.hits.map((h) => h.id);
}
if (db) db.close();
console.log(JSON.stringify(report));
`;

const child = Bun.spawnSync(["bun", "-e", CHILD_SOURCE], {
  cwd: ROOT,
  env: { ...process.env, MYC_REPO_ROOT: ROOT },
  stdout: "pipe",
  stderr: "pipe",
});
const childOut = child.stdout.toString().trim();
const vec: { available: boolean; reason: string | null; hits: string[] | null } =
  child.success && childOut.length > 0
    ? (JSON.parse(childOut) as { available: boolean; reason: string | null; hits: string[] | null })
    : { available: false, reason: `дочерний процесс упал: ${child.stderr.toString().slice(0, 300)}`, hits: null };
if (!vec.available) {
  console.warn(`[review] vectorSearch на vec0 ПРОПУЩЕН: ${vec.reason}`);
}

describe.skipIf(!vec.available)("vectorSearch на vec0", () => {
  // Мутация «снять фильтр из vectorKnn» роняет этот тест: пять мест выдачи
  // занимают кандидаты, обычная заметка не доезжает.
  test("двадцать кандидатов ближе запроса не занимают выдачу: обычная заметка найдена", () => {
    expect(vec.hits).toEqual(["plain"]);
  });
});
