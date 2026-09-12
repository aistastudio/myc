// Скрываемые статусы (memory-0p3d8n1efwtv): отозванная заметка, отменённая
// задача и заменённая версия не доезжают до выдачи ни одним путём ретривала —
// лексика, обход графа, векторная ветка, объяснение пустоты, ftsSearch,
// федерация. До этой задачи пути отсекали только `superseded`, и отозванная
// заметка уходила агенту наравне с живой, пока строка статуса её уже не
// считала.
//
// Каждый путь — отдельный тест, потому что терм стоит в КАЖДОМ запросе
// отдельно, и снятие любого одного обязано что-то уронить (мутации — у
// тестов). Сквозь CLI (recall, search, prime, строка статуса) —
// packages/cli/src/commands/review.test.ts.

import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generateId } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { federatedSearch } from "./federation.ts";
import { ftsSearch, type FtsCaller } from "./fts.ts";
import { hybridQueries, hybridSearch, type HybridVectorSource } from "./hybrid.ts";
import { HIDDEN_STATUSES, isHiddenStatus, liveStatusPredicate } from "./review.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

interface Seed {
  readonly title: string;
  readonly body?: string;
  readonly kind?: "note" | "task";
  readonly status?: string;
  readonly layer?: 0 | 1 | 2 | 3;
}

function insert(db: SqliteDriver, seed: Seed): string {
  const id = generateId();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          content_hash, acl, owner_id, team_id, agent_id, salience, attrs,
                          created_at, updated_at)
       VALUES (?1, ?2, ?3, 's1', ?4, ?5, ?6, 2, ?7, ?8, 'team', '', '', '', 1, '{}', 1, 1)`,
    )
    .run(
      id,
      seed.kind ?? "note",
      seed.layer ?? 2,
      seed.title,
      seed.body ?? null,
      (seed.body ?? seed.title).slice(0, 120),
      seed.status ?? (seed.kind === "task" ? "open" : "active"),
      `hash-${id}`,
    );
  return id;
}

function retracted(db: SqliteDriver, title: string, body?: string): string {
  return insert(db, { title, ...(body !== undefined ? { body } : {}), status: "retracted" });
}

function relate(db: SqliteDriver, src: string, dst: string): void {
  db.database
    .query(`INSERT INTO edges (src, type, dst, weight, add_tag, created_at) VALUES (?1, 'relates', ?2, 1.0, ?3, 1)`)
    .run(src, dst, generateId());
}

const ids = (hits: readonly { id: string }[]): string[] => hits.map((h) => h.id);

describe("список и предикат — одна таблица истинности", () => {
  test("список: заменённая, отозванная, отменённая — и только они", () => {
    expect([...HIDDEN_STATUSES].sort()).toEqual(["cancelled", "retracted", "superseded"]);
  });

  // Каждый статус ядра проверяется в SQL и в JS одним кейсом: разойдись
  // зеркало с предикатом — и show/review/remember решали бы иначе, чем выдача.
  const statuses = ["active", "open", "in_progress", "blocked", "closed", "stale", "lost", "fresh", ...HIDDEN_STATUSES];
  for (const status of statuses) {
    test(`статус ${status}`, () => {
      const db = freshDb();
      const id = insert(db, { title: status, status });
      const row = db.database
        .query<{ live: number }, [string]>(`SELECT ${liveStatusPredicate("n")} AS live FROM nodes n WHERE n.id = ?1`)
        .get(id)!;
      expect(row.live === 1).toBe(!isHiddenStatus(status));
    });
  }
});

describe("план не меняется: терм читает уже прочитанную строку", () => {
  // Цена терма — разбор короткой колонки у строки, которую путь и так читает
  // (ACL, attrs, title). Если бы терм сменил план (другой индекс, SCAN), это
  // был бы уже не терм, а другой запрос — и замер относился бы к нему.
  test("hybridLexicalPass, hybridHydrate и hybridCorpusSize: план с термом = план без него", () => {
    const db = freshDb();
    for (let i = 0; i < 50; i++) insert(db, { title: `заметка про оплог ${i}`, status: i % 5 === 0 ? "retracted" : "active" });
    db.database.exec("ANALYZE");
    const argsOf: Record<string, unknown[]> = {
      hybridLexicalPass: ['"оплог"', '["s1"]', 0, 3, "", "", "", "[]", 100, 15, 0.1, 5, 10],
      hybridHydrate: ['["x"]', '["s1"]', 0, 3, "", "", "", "[]"],
      hybridCorpusSize: ['["s1"]', 0, 3, "", "", "", "[]"],
    };
    for (const [name, args] of Object.entries(argsOf)) {
      const sql = (hybridQueries as Record<string, { sql: string }>)[name]!.sql;
      const without = sql.replaceAll(liveStatusPredicate("n"), "1");
      expect(without).not.toBe(sql);
      const plan = (text: string): string[] =>
        db.database
          .query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${text}`)
          .all(...(args as never[]))
          .map((r) => r.detail);
      expect(plan(sql)).toEqual(plan(without));
    }
  });
});

describe("hybridSearch: отозванное не отдаётся, живое с тем же текстом — да", () => {
  const TEXT = "размер пула лексики гибрида держим равным сотне";

  // Мутация «вернуть в CTE matches hybridLexicalPass только <> 'superseded'»
  // роняет этот тест (отозванная приезжает первой — у неё тот же текст).
  test("идеальное лексическое совпадение: отозванная скрыта, живая видна", () => {
    const db = freshDb();
    const gone = retracted(db, TEXT, TEXT);
    const live = insert(db, { title: TEXT, body: `${TEXT}, записано после замера` });
    const r = hybridSearch(db, { text: TEXT, scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(ids(r.hits)).toContain(live);
    expect(ids(r.hits)).not.toContain(gone);
  });

  test("отменённая задача скрыта, закрытая — нет: закрытое — история, отменённое — нет", () => {
    const db = freshDb();
    const cancelled = insert(db, { kind: "task", title: "перевести оплог на protobuf", status: "cancelled", layer: 1 });
    const closed = insert(db, { kind: "task", title: "перевести оплог на jsonl", status: "closed", layer: 1 });
    const r = hybridSearch(db, { text: "перевести оплог", scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(ids(r.hits)).toContain(closed);
    expect(ids(r.hits)).not.toContain(cancelled);
  });

  // ОКНО СКАНА. Пул лексики — top-100. Сто отозванных с термом дважды в
  // заголовке (вес 10) по BM25 лучше живой заметки, где он один раз в теле:
  // терм ПОСЛЕ LIMIT отдал бы пул отозванным, живая не доехала бы вовсе.
  // Мутация «снять терм статуса из CTE matches» роняет этот тест.
  test("100 отозванных с лучшим BM25 не вытесняют одну живую заметку из пула", () => {
    const db = freshDb();
    for (let i = 0; i < 100; i++) retracted(db, `свёртка свёртка ${i}`);
    const live = insert(db, {
      title: "заметка про слияние выдачи",
      body: "в длинном теле этой заметки слово свёртка встречается ровно один раз среди прочих слов",
    });
    const r = hybridSearch(db, { text: "свёртка", scopes: ["s1"], caller: ANON, vectorMode: "never", limit: 12 });
    expect(ids(r.hits)).toEqual([live]);
    expect(r.mode_used.lexical.hits).toBe(1);
  });

  // Обход графа входит через рёбра, а не через matches. Мутация «снять терм
  // статуса из финального WHERE hybridLexicalPass» роняет этот тест.
  test("отозванный сосед найденной заметки не въезжает обходом графа", () => {
    const db = freshDb();
    const seed = insert(db, { title: "очередь готовых задач считается одним сканом индекса" });
    const gone = retracted(db, "аренда держится тридцать минут");
    const plain = insert(db, { title: "аренда продлевается агентом" });
    relate(db, seed, gone);
    relate(db, seed, plain);
    const r = hybridSearch(db, { text: "очередь индекса", scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(ids(r.hits)).toContain(seed);
    expect(ids(r.hits)).toContain(plain); // обход работает — иначе тест ничего не доказывал бы
    expect(ids(r.hits)).not.toContain(gone);
  });

  // Узлы только из векторной ветки гидратируются отдельным запросом. Мутация
  // «снять терм статуса из hybridHydrate» роняет этот тест.
  test("отозванная из векторного источника не гидратируется в выдачу", () => {
    const db = freshDb();
    const gone = retracted(db, "эмбеддинги держим рядом с графом");
    const plain = insert(db, { title: "векторное хранилище живёт рядом с графом" });
    const source: HybridVectorSource = () => ({
      hits: [
        { id: gone, rank: 1, distance: 0.01 },
        { id: plain, rank: 2, distance: 0.02 },
      ],
      degraded: false,
      reranked: false,
      candidates: 2,
    });
    const r = hybridSearch(db, {
      text: "где лежат векторы",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "always",
      embedQuery: () => new Float32Array(384),
      vectorSource: source,
    });
    expect(ids(r.hits)).toContain(plain);
    expect(ids(r.hits)).not.toContain(gone);
  });

  // Пустая выдача объясняется размером ВИДИМОГО корпуса (И2). Мутация «снять
  // терм статуса из hybridCorpusSize» роняет этот тест.
  test("база из одних отозванных — store_empty, а не no_match", () => {
    const db = freshDb();
    retracted(db, "решили писать кандидатов в L2");
    const r = hybridSearch(db, { text: "бюджет холодного старта", scopes: ["s1"], caller: ANON, vectorMode: "never" });
    expect(r.hits).toEqual([]);
    expect(r.mode_used.emptyReason?.code).toBe("store_empty");
    expect(r.mode_used.emptyReason?.corpusSize).toBe(0);
  });
});

describe("ftsSearch и federatedSearch — тот же терм", () => {
  // Мутация «вернуть в ftsSearch только <> 'superseded'» роняет этот тест.
  test("ftsSearch: отозванная скрыта, живая с тем же заголовком видна", () => {
    const db = freshDb();
    const gone = retracted(db, "выбрали sqlite-vec вместо отдельного сервиса");
    const live = insert(db, { title: "выбрали sqlite-vec вместо отдельного сервиса", body: "и это решение в силе" });
    const hits = ftsSearch(db, { text: "sqlite-vec сервиса", scopes: ["s1"], caller: ANON });
    expect(ids(hits)).toEqual([live]);
    expect(ids(hits)).not.toContain(gone);
  });

  test("федерация: отозванное соседнего воркспейса не доезжает, живое — да", async () => {
    const own = freshDb();
    const other = freshDb();
    insert(own, { title: "своя заметка про оплог" });
    const gone = retracted(other, "оплог храним в одном файле");
    const live = insert(other, { title: "соседская заметка про оплог append-only" });
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
    expect(found).toContain(live);
    expect(found).not.toContain(gone);
  });
});

// ---------------------------------------------------------------------------
// vectorSearch на настоящем vec0 — в дочернем процессе (приём ./review.test.ts:
// расширение грузится до первого соединения, а `bun test` открывает свою
// сборку SQLite раньше).
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..", "..", "..");

const CHILD_SOURCE = `
const ROOT = process.env.MYC_REPO_ROOT;
await import(ROOT + "/packages/store-sqlite/src/runtime-preload.ts");
const { openSqlite, migration001Init, migrateVectors } = await import(ROOT + "/packages/store-sqlite/src/index.ts");
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
  const near = new Int8Array(DIM).fill(1);
  const far = new Int8Array(DIM).fill(1);
  for (let i = 0; i < 40; i++) far[i] = -1;
  const put = (id, vec, status) => {
    const res = db.database.query(
      "INSERT INTO nodes (id, kind, layer, scope, title, body, status, content_hash, acl, team_id, attrs, created_at, updated_at)" +
      " VALUES (?1, 'note', 2, 's1', ?1, '', ?2, ?3, 'team', '', '{}', 1, 1)",
    ).run(id, status, "hash-" + id);
    db.database.query(
      "INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding) VALUES (?1, 's1', 2, 'note', 1, vec_int8(?2))",
    ).run(Number(res.lastInsertRowid), Buffer.from(vec.buffer));
  };
  // Двадцать отозванных ровно на векторе запроса и одна живая дальше: без
  // терма до LIMIT все пять мест выдачи заняли бы отозванные.
  for (let i = 0; i < 20; i++) put("gone-" + i, near, "retracted");
  put("plain", far, "active");
  const out = vectorSearch(db, {
    vector: new Float32Array(DIM).fill(0.1),
    queryInt8: new Int8Array(DIM).fill(1),
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
  console.warn(`[hidden-status] vectorSearch на vec0 ПРОПУЩЕН: ${vec.reason}`);
}

describe.skipIf(!vec.available)("vectorSearch на vec0", () => {
  // Мутация «вернуть в vectorKnn только <> 'superseded'» роняет этот тест.
  test("двадцать отозванных ближе запроса не занимают выдачу: живая найдена", () => {
    expect(vec.hits).toEqual(["plain"]);
  });
});
