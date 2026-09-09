import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, type Migration } from "../migrate.ts";
import {
  migrations,
  migrateVectors,
  vectorMigrations,
  VEC_DEGRADED_UNAVAILABLE,
  VEC_MIGRATIONS_TABLE,
} from "./index.ts";
import { migration001Init } from "./001-init.ts";
import { migration002OplogPending } from "./002-oplog-pending.ts";
import {
  migration003CodeFiles,
  migration004CodeDefs,
  migration005CodeRefs,
  migration006NodesReach,
  migration007NodesRepo,
  migration008DigestCache,
  migration011CodeRefSites,
} from "./index.ts";

let dir: string;
let store: Database;

// Соединение открывается напрямую, без openSqlite: набор миграций — это DDL,
// он не должен зависеть ни от подбора libsqlite3, ни от загрузки vec0
// (это забота рантайма, ../runtime.ts). PRAGMA из §8.1.0 — per-connection,
// здесь выставляются только те, что влияют на поведение самой схемы.
function open(): Database {
  const db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-schema-"));
});

afterEach(() => {
  try {
    store?.close();
  } catch {
    // соединение уже закрыто тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

function masterNames(db: Database): Map<string, string> {
  const rows = db
    .query("SELECT name, type FROM sqlite_master")
    .all() as Array<{ name: string; type: string }>;
  return new Map(rows.map((r) => [r.name, r.type]));
}

function insertNode(
  db: Database,
  id: string,
  overrides: Record<string, string | number | null> = {},
): void {
  const row = {
    id,
    kind: "task",
    scope: "s",
    status: "open",
    title: id,
    content_hash: `h-${id}`,
    priority: 2,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
  const cols = Object.keys(row);
  db
    .query(
      `INSERT INTO nodes (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`,
    )
    .run(...(Object.values(row) as Array<string | number | null>));
}

describe("миграция 1 — базовая схема", () => {
  test("чистая БД поднимается одной командой, все заявленные объекты в sqlite_master", async () => {
    store = open();
    const result = await migrate(store, { migrations, writable: true });
    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(result.pendingVersions).toEqual([]);
    expect(result.degraded).toEqual([]);

    const present = masterNames(store);
    const missing = migration001Init.objects.filter((name) => !present.has(name));
    expect(missing).toEqual([]);
    // Версия 2 (myc-qie.9): очередь отложенных операций репликации.
    expect(migration002OplogPending.objects.filter((n) => !present.has(n))).toEqual([]);
    expect(present.get("oplog_pending")).toBe("table");
    // Версии 3–5 (S52): таблицы код-интеллекта — по одной на миграцию.
    for (const m of [migration003CodeFiles, migration004CodeDefs, migration005CodeRefs]) {
      expect(m.objects.filter((n) => !present.has(n))).toEqual([]);
      expect(present.get(m.objects[0]!)).toBe("table");
    }
    // Версия 6 (S58): индекс охвата памяти — индекс, а не таблица.
    expect(migration006NodesReach.objects.filter((n) => !present.has(n))).toEqual([]);
    expect(present.get("ix_nodes_prime_reach")).toBe("index");
    // Версия 7 (S59): индекс охвата репозитория — тоже индекс, не таблица.
    expect(migration007NodesRepo.objects.filter((n) => !present.has(n))).toEqual([]);
    expect(present.get("ix_nodes_ready_repo")).toBe("index");
    // Версия 8 (S4): кеш дайджестов — таблица.
    expect(migration008DigestCache.objects.filter((n) => !present.has(n))).toEqual([]);
    expect(present.get("digest_cache")).toBe("table");
    // Версия 11 (memory-e34bfse29jdw): ссылки — таблица И индекс по имени.
    // Индекс здесь не украшение: без него «кто зовёт» это скан сотен тысяч
    // строк, и проверка его наличия — часть договора, а не косметика.
    expect(migration011CodeRefSites.objects.filter((n) => !present.has(n))).toEqual([]);
    expect(present.get("code_ref_sites")).toBe("table");
    expect(present.get("ix_code_ref_sites_name")).toBe("index");

    // Состав набора зафиксирован числом: молчаливая потеря объекта при правке
    // DDL — ровно то, что этот тест обязан ловить.
    const declared = migration001Init.objects;
    expect(declared.length).toBe(52);
    expect(declared.filter((n) => present.get(n) === "table").length).toBe(15);
    expect(declared.filter((n) => present.get(n) === "index").length).toBe(29);
    expect(declared.filter((n) => present.get(n) === "trigger").length).toBe(8);

    // FTS5 разворачивает shadow-таблицы — признак того, что виртуальная
    // таблица действительно создана, а не молча пропущена (01a §7).
    expect(present.has("nodes_fts_data")).toBe(true);
    expect(present.has("nodes_fts_idx")).toBe(true);
    expect(store.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
  });

  test("повторное открытие ничего не накатывает, checksum сходится", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    store.close();

    store = open();
    const again = await migrate(store, { migrations, writable: true });
    expect(again.appliedVersions).toEqual([]);
    expect(again.pendingVersions).toEqual([]);
  });

  test("nodes.excerpt: колонка есть, по умолчанию пустая, длиннее 300 символов не принимается", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });

    const columns = store.query("PRAGMA table_info(nodes)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const excerpt = columns.find((c) => c.name === "excerpt");
    expect(excerpt).toBeDefined();
    expect(excerpt!.type).toBe("TEXT");
    expect(excerpt!.notnull).toBe(1);

    insertNode(store, "n1");
    expect(
      store.query("SELECT excerpt FROM nodes WHERE id='n1'").get(),
    ).toEqual({ excerpt: "" });

    insertNode(store, "n2", { excerpt: "я".repeat(300) });
    expect(
      store.query("SELECT length(excerpt) AS n FROM nodes WHERE id='n2'").get(),
    ).toEqual({ n: 300 });

    expect(() => insertNode(store, "n3", { excerpt: "я".repeat(301) })).toThrow(
      /CHECK constraint failed/,
    );
  });

  test("CHECK-ограничения отвергают невалидные значения", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });

    expect(() => insertNode(store, "b1", { kind: "wat" })).toThrow(/CHECK constraint/);
    expect(() => insertNode(store, "b2", { layer: 9 })).toThrow(/CHECK constraint/);
    expect(() => insertNode(store, "b3", { priority: 7 })).toThrow(/CHECK constraint/);
    expect(() => insertNode(store, "b4", { acl: "world" })).toThrow(/CHECK constraint/);
    expect(() => insertNode(store, "b5", { confidence: 1.5 })).toThrow(/CHECK constraint/);

    insertNode(store, "ok1");
    expect(() =>
      store
        .query(
          "INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES (?1,?2,?3,?4,?5)",
        )
        .run("ok1", "blocks", "ok1", "t", 1),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("open_blockers", () => {
  // Детерминированный PRNG: тест обязан падать воспроизводимо, а не «иногда».
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mismatches(db: Database): Array<{ id: string; got: number; want: number }> {
    return db
      .query(
        `SELECT n.id AS id, n.open_blockers AS got,
                (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
                  WHERE e.dst = n.id AND e.type = 'blocks' AND e.deleted_at IS NULL
                    AND s.status NOT IN ('closed','cancelled','superseded','retracted')) AS want
           FROM nodes n
          WHERE n.open_blockers <> (
                SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
                 WHERE e.dst = n.id AND e.type = 'blocks' AND e.deleted_at IS NULL
                   AND s.status NOT IN ('closed','cancelled','superseded','retracted'))`,
      )
      .all() as Array<{ id: string; got: number; want: number }>;
  }

  test.each([1, 20260903])(
    "1000 случайных мутаций рёбер: счётчик сходится с пересчётом (seed %i)",
    async (seed) => {
      store = open();
      await migrate(store, { migrations, writable: true });

      const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
      for (const id of ids) insertNode(store, id);

      const db = store;
      const addEdge = db.query(
        "INSERT OR IGNORE INTO edges (src, type, dst, add_tag, created_at) VALUES (?1,'blocks',?2,?3,?4)",
      );
      const softDelete = db.query(
        "UPDATE edges SET deleted_at = ?1 WHERE src = ?2 AND dst = ?3 AND type='blocks' AND deleted_at IS NULL",
      );
      const restore = db.query(
        "UPDATE edges SET deleted_at = NULL WHERE src = ?1 AND dst = ?2 AND type='blocks' AND deleted_at IS NOT NULL",
      );
      const setStatus = db.query("UPDATE nodes SET status = ?1 WHERE id = ?2 AND status <> ?1");

      const rnd = mulberry32(seed);
      const pick = () => ids[Math.floor(rnd() * ids.length)]!;

      for (let step = 0; step < 1000; step++) {
        const src = pick();
        let dst = pick();
        while (dst === src) dst = pick();
        const op = Math.floor(rnd() * 5);
        if (op === 0) addEdge.run(src, dst, `tag-${step}`, step);
        else if (op === 1) softDelete.run(step, src, dst);
        else if (op === 2) restore.run(src, dst);
        else if (op === 3) setStatus.run("closed", src);
        else setStatus.run("open", src);
      }

      expect(mismatches(store)).toEqual([]);
      // Мутации должны были реально произойти, иначе тест сходится вхолостую.
      const edges = db.query("SELECT count(*) AS n FROM edges").get() as { n: number };
      expect(edges.n).toBeGreaterThan(20);
    },
  );

  test("add → soft-delete → restore: сценарий, на котором спека давала 0 против 1", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    insertNode(store, "A");
    insertNode(store, "B");
    const db = store;

    db.query(
      "INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES ('A','blocks','B','tag',1)",
    ).run();
    expect(db.query("SELECT open_blockers AS n FROM nodes WHERE id='B'").get()).toEqual({
      n: 1,
    });

    db.query("UPDATE edges SET deleted_at = 2 WHERE src='A' AND dst='B'").run();
    expect(db.query("SELECT open_blockers AS n FROM nodes WHERE id='B'").get()).toEqual({
      n: 0,
    });

    // trg_blk_res: без него здесь оставался 0 при пересчёте 1 (01a §2, вариант B).
    db.query("UPDATE edges SET deleted_at = NULL WHERE src='A' AND dst='B'").run();
    expect(db.query("SELECT open_blockers AS n FROM nodes WHERE id='B'").get()).toEqual({
      n: 1,
    });
    expect(mismatches(store)).toEqual([]);
  });
});

describe("план запроса ready", () => {
  const READY_SQL = `SELECT id, title, priority, updated_at
       FROM nodes
      WHERE scope = ?1 AND kind = 'task' AND status = 'open'
        AND open_blockers = 0 AND anc_blockers = 0 AND deleted_at IS NULL
        AND (lease_expires = 0 OR lease_expires < ?2)
      ORDER BY priority ASC, updated_at ASC
      LIMIT 20`;

  test("EXPLAIN QUERY PLAN выбирает частичный индекс ix_nodes_ready, а не скан", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    const db = store;

    // 200 целевых строк + 1300 шума: closed, заблокированные, удалённые,
    // чужой scope, заметки — стенд из 01a §5.
    const insert = db.query(
      `INSERT INTO nodes (id, kind, scope, status, title, content_hash, priority,
                          open_blockers, deleted_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)`,
    );
    db.exec("BEGIN");
    for (let i = 0; i < 200; i++) {
      insert.run(`ok${i}`, "task", "s", "open", `t${i}`, `h-ok${i}`, i % 4, 0, null, i);
    }
    for (let i = 0; i < 1300; i++) {
      const bucket = i % 5;
      const [kind, scope, status, blockers, deleted] =
        bucket === 0
          ? ["task", "s", "closed", 0, null]
          : bucket === 1
            ? ["task", "s", "open", 1, null]
            : bucket === 2
              ? ["task", "s", "open", 0, i]
              : bucket === 3
                ? ["task", "other", "open", 0, null]
                : ["note", "s", "active", 0, null];
      insert.run(
        `noise${i}`,
        kind as string,
        scope as string,
        status as string,
        `n${i}`,
        `h-noise${i}`,
        i % 4,
        blockers as number,
        deleted as number | null,
        i,
      );
    }
    db.exec("COMMIT");
    db.exec("ANALYZE");

    const plan = db.query(`EXPLAIN QUERY PLAN ${READY_SQL}`).all("s", 999999) as Array<{
      detail: string;
    }>;
    const details = plan.map((r) => r.detail);

    expect(details.join(" | ")).toMatch(/SEARCH nodes USING INDEX ix_nodes_ready/);
    // Тест обязан падать при деградации плана в скан — эта строка и есть проверка.
    expect(details.filter((d) => d.includes("SCAN"))).toEqual([]);

    const rows = db.query(READY_SQL).all("s", 999999) as Array<{ id: string }>;
    expect(rows.length).toBe(20);
  });
});

describe("дисциплина схемы", () => {
  // Урок vec_embed_meta (vec-004-embed-meta.ts): таблица, созданная прямо в
  // команде через CREATE TABLE IF NOT EXISTS, не видна ни версии схемы, ни
  // проверке объектов, ни db/schema.sqlite.sql — база молча расходится со
  // своим описанием. Этот тест — механический сторож того же правила:
  // CREATE TABLE в коде вне набора миграций обязан краснить набор, а не
  // ждать ревью.
  test("CREATE TABLE вне набора миграций не появляется", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, sep } = await import("node:path");

    // …/packages/store-sqlite/src/migrations → корень репозитория
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    const violations: string[] = [];
    // Собственная таблица учёта раннера — единственное законное исключение:
    // без неё не проверить, какие версии накатаны.
    const ALLOWED = new Set(["packages/store-sqlite/src/migrate.ts"]);

    // Срезаются комментарии: слова «CREATE VIRTUAL TABLE» в комментарии —
    // это проза, не DDL. СТРОКОВЫЕ ЛИТЕРАЛЫ НЕ СРЕЗАЮТСЯ: настоящая DDL
    // живёт в template-литералах, и вырезать её значило бы ослепить сторожа
    // ровно на тот случай, ради которого он стоит (урок vec_embed_meta).
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
          walk(p);
          continue;
        }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const rel = p.slice(repoRoot.length + 1);
        if (rel.includes(`${sep}migrations${sep}`) || ALLOWED.has(rel)) continue;
        if (/CREATE\s+(?:VIRTUAL\s+)?TABLE/i.test(stripComments(readFileSync(p, "utf8")))) {
          violations.push(rel);
        }
      }
    };
    walk(join(repoRoot, "packages"));

    expect(violations).toEqual([]);
  });

  test("набор держит один оператор на миграцию (версии 3–6)", () => {
    for (const m of [
      migration003CodeFiles,
      migration004CodeDefs,
      migration005CodeRefs,
      migration006NodesReach,
    ]) {
      const body = m.sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      expect(body).not.toContain(";");
    }
  });
});

describe("векторный набор (S26)", () => {
  test("базовая схема о векторах не знает", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    const present = masterNames(store);
    expect(present.has("nodes_vec")).toBe(false);
    expect(migration001Init.sql).not.toMatch(/vec0\s*\(/);
  });

  test("без vec0 набор пропускается целиком, деградация видна в результате", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });

    const result = await migrateVectors(store, {
      vec0Loaded: false,
      writable: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.appliedVersions).toEqual([]);
    expect(result.degraded).toEqual([VEC_DEGRADED_UNAVAILABLE]);

    // Ни объектов, ни таблицы учёта: база без расширения неотличима от базы,
    // которая о векторах не знает.
    const present = masterNames(store);
    expect(present.has("nodes_vec")).toBe(false);
    expect(present.has(VEC_MIGRATIONS_TABLE)).toBe(false);

    // И главное — базовая схема при этом полноценна.
    insertNode(store, "n1");
    expect(store.query("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 1 });
  });

  // Guard векторного набора проверяется на подставном наборе: vec0Loaded —
  // это флаг от рантайма, а не проверка наличия расширения, поэтому логика
  // учёта тестируется без расширения.
  const FAKE: Migration = {
    version: 1,
    name: "vec_fake",
    sql: "CREATE TABLE vec_fake (id INTEGER PRIMARY KEY)",
    objects: ["vec_fake"],
  };

  test("только чтение: неприменённые версии видны, но не накатываются", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    const result = await migrateVectors(store, {
      vec0Loaded: true,
      writable: false,
      migrations: [FAKE],
    });
    expect(result.skipped).toBe(false);
    expect(result.pendingVersions).toEqual([1]);
    expect(masterNames(store).has("vec_fake")).toBe(false);
  });

  test("изменённый текст миграции — schema.checksum, а не молчаливый повтор", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    await migrateVectors(store, { vec0Loaded: true, writable: true, migrations: [FAKE] });

    const tampered: Migration = { ...FAKE, sql: `${FAKE.sql} -- правка после наката` };
    await expect(
      migrateVectors(store, {
        vec0Loaded: true,
        writable: true,
        migrations: [tampered],
      }),
    ).rejects.toThrow(/изменилась после применения/);
  });

  test("БД новее бинаря — schema.newer", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    await migrateVectors(store, {
      vec0Loaded: true,
      writable: true,
      migrations: [{ ...FAKE, version: 2 }],
    });
    await expect(
      migrateVectors(store, { vec0Loaded: true, writable: true, migrations: [FAKE] }),
    ).rejects.toThrow(/новее известной бинарю/);
  });

  test("объект не создан после наката — накат падает, а не тихо проходит", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    await expect(
      migrateVectors(store, {
        vec0Loaded: true,
        writable: true,
        migrations: [{ ...FAKE, objects: ["vec_fake", "nodes_vec"] }],
      }),
    ).rejects.toThrow(/объекты не созданы после наката: nodes_vec/);
  });

  // Правка: набор объединяет объекты по признаку «нужны только когда
  // загружен vec0» (S26), а не по признаку «являются vec0-таблицами» —
  // vec_nodes_f32 (vec-002-rerank-f32.ts) обычная таблица, читается обычным
  // IN (...), а не MATCH, и ей намеренно не место среди vec0-объектов. Старая
  // версия этого теста требовала CREATE VIRTUAL TABLE от КАЖДОЙ миграции
  // набора — верно только пока набор состоял из одной vec0-миграции.
  test("каждая векторная миграция — ровно один оператор", () => {
    for (const migration of vectorMigrations) {
      const body = migration.sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      expect(body).not.toContain(";");
    }
  });

  test("vec0-миграции набора объявляют CREATE VIRTUAL TABLE", () => {
    const vec0Migrations = vectorMigrations.filter((m) => m.sql.includes("vec0("));
    expect(vec0Migrations.length).toBeGreaterThan(0);
    for (const migration of vec0Migrations) {
      expect(migration.sql).toMatch(/CREATE VIRTUAL TABLE/);
    }
  });

  // Настоящий инвариант накатки, ради которого писался прежний тест — «каждый
  // объект из `objects` появляется в sqlite_master после наката» — уже
  // проверяется рантаймом (assertObjectsPresent в ./vec.ts бросает при
  // расхождении) и покрыт для реального vec0 в ./vec.test.ts, где набор
  // накатывается с настоящим расширением в дочернем процессе (эта среда — без
  // vec0, см. комментарий выше про "Guard векторного набора").

  test("форма векторной таблицы соответствует решению S27", () => {
    const sql = vectorMigrations[0]!.sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).toMatch(/int8\[384\]\s+distance_metric=cosine/);
    expect(sql).toMatch(/scope\s+TEXT\s+partition key/);
    expect(sql).toMatch(/layer\s+INTEGER partition key/);
    // Отвергнутая форма §2.4: aux-колонки нельзя фильтровать в KNN.
    expect(sql).not.toMatch(/\+\s*scope/);
  });
});

/**
 * Миграция 9: у узла ДВА способа быть уникальным, и выбирает его
 * происхождение узла, а не kind.
 *
 * Правило «одинаковый текст — один и тот же факт» написано под память и там
 * верно. У записи чужого трекера идентичность даёт его id: в beads две
 * разные задачи имеют право на дословно одинаковые заголовок и тело — на
 * настоящих данных ~/src/cherry это `cherry-ys5o` (in_progress) и
 * `cherry-xxc9` (open), плюс 108 повторяющихся заметок `bd note`.
 */
describe("миграция 9 — идентичность: содержимое у своих, external_ref у ввезённых", () => {
  const EXT = (ref: string): Record<string, string> => ({ attrs: JSON.stringify({ external_ref: ref }) });

  test("свои узлы: точный дубликат по содержимому по-прежнему невозможен", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    insertNode(store, "own1", { content_hash: "same" });
    expect(() => insertNode(store, "own2", { content_hash: "same" })).toThrow(/UNIQUE constraint/);
    // другой kind — другая ячейка индекса, столкновения нет
    insertNode(store, "own3", { content_hash: "same", kind: "note" });
  });

  test("ввезённые узлы: одинаковое содержимое разрешено, повтор external_ref — нет", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    insertNode(store, "imp1", { content_hash: "same", ...EXT("cherry-ys5o") });
    insertNode(store, "imp2", { content_hash: "same", ...EXT("cherry-xxc9") });
    expect(
      store.query("SELECT count(*) AS n FROM nodes WHERE content_hash='same'").get(),
    ).toEqual({ n: 2 });
    // на external_ref стоит идемпотентность повторного импорта
    expect(() => insertNode(store, "imp3", { content_hash: "other", ...EXT("cherry-ys5o") })).toThrow(
      /UNIQUE constraint/,
    );
  });

  test("свой и ввезённый узлы с одним содержимым не мешают друг другу", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    insertNode(store, "own", { content_hash: "same" });
    insertNode(store, "imported", { content_hash: "same", ...EXT("cherry-1") });
    expect(store.query("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 2 });
  });

  test("удалённый узел освобождает обе ячейки: индексы частичные по deleted_at", async () => {
    store = open();
    await migrate(store, { migrations, writable: true });
    insertNode(store, "gone", { content_hash: "same", deleted_at: 1, ...EXT("cherry-1") });
    insertNode(store, "live", { content_hash: "same", ...EXT("cherry-1") });
    insertNode(store, "own", { content_hash: "same" });
    expect(store.query("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 3 });
  });
});
