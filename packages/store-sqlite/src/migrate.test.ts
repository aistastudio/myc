import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appliedSchemaVersion, COMPAT_MIGRATIONS_TABLE, migrate, SchemaError, type Migration } from "./migrate.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-migrate-"));
  dbPath = join(dir, "test.db");
});

afterEach(() => {
  delete process.env.MYC_IGNORE_SCHEMA_SKEW;
  rmSync(dir, { recursive: true, force: true });
});

const M1: Migration = {
  version: 1,
  name: "init",
  sql: "CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT)",
  objects: ["a"],
};

const M2: Migration = {
  version: 2,
  name: "add_b",
  sql: "CREATE TABLE b (id INTEGER PRIMARY KEY, y TEXT)",
  objects: ["b"],
};

const M3: Migration = {
  version: 3,
  name: "add_c",
  sql: "CREATE TABLE c (id INTEGER PRIMARY KEY, z TEXT)",
  objects: ["c"],
};

describe("migrate", () => {
  test("чистая БД поднимается до текущей версии одной командой", async () => {
    const db = new Database(dbPath, { create: true });
    const result = await migrate(db, { migrations: [M1, M2, M3], writable: true });
    expect(result.appliedVersions).toEqual([1, 2, 3]);
    expect(result.pendingVersions).toEqual([]);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toContain("c");

    const rows = db
      .query("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    expect(rows).toEqual([
      { version: 1, name: "init" },
      { version: 2, name: "add_b" },
      { version: 3, name: "add_c" },
    ]);
    db.close();
  });

  test("повторный вызов на уже мигрированной БД ничего не делает", async () => {
    const db = new Database(dbPath, { create: true });
    await migrate(db, { migrations: [M1, M2], writable: true });
    const result = await migrate(db, { migrations: [M1, M2], writable: true });
    expect(result.appliedVersions).toEqual([]);
    expect(result.pendingVersions).toEqual([]);
    db.close();
  });

  test("открытие только на чтение сообщает о неприменённых миграциях, но не применяет их", async () => {
    const db = new Database(dbPath, { create: true });
    const result = await migrate(db, { migrations: [M1, M2], writable: false });
    expect(result.pendingVersions).toEqual([1, 2]);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("a");
    db.close();
  });

  test("БД с версией из будущего отвергается с schema.newer / PRECOND(5)", async () => {
    const db = new Database(dbPath, { create: true });
    await migrate(db, { migrations: [M1, M2, M3], writable: true });
    db.close();

    const db2 = new Database(dbPath, { create: true });
    let caught: unknown;
    try {
      // Бинарь знает только про M1 — в БД уже применены 1..3.
      await migrate(db2, { migrations: [M1], writable: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    const err = caught as SchemaError;
    expect(err.code).toBe("schema.newer");
    expect(err.exit).toBe(5);
    db2.close();
  });

  test("MYC_IGNORE_SCHEMA_SKEW=1 пропускает проверку новизны и пишет в degraded", async () => {
    const db = new Database(dbPath, { create: true });
    await migrate(db, { migrations: [M1, M2, M3], writable: true });
    db.close();

    const db2 = new Database(dbPath, { create: true });
    const result = await migrate(db2, {
      migrations: [M1],
      writable: true,
      ignoreSchemaSkew: true,
    });
    expect(result.degraded.length).toBeGreaterThan(0);
    expect(result.degraded[0]).toContain("schema.newer");
    db2.close();
  });

  test("MYC_IGNORE_SCHEMA_SKEW=1 читается из окружения, если опция не передана", async () => {
    const db = new Database(dbPath, { create: true });
    await migrate(db, { migrations: [M1, M2], writable: true });
    db.close();

    process.env.MYC_IGNORE_SCHEMA_SKEW = "1";
    const db2 = new Database(dbPath, { create: true });
    const result = await migrate(db2, { migrations: [M1], writable: true });
    expect(result.degraded.length).toBe(1);
    db2.close();
  });

  test("подменённый текст применённой миграции ловится checksum и обход его не лечит", async () => {
    const db = new Database(dbPath, { create: true });
    await migrate(db, { migrations: [M1, M2], writable: true });
    db.close();

    const tampered: Migration = { ...M1, sql: "CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT, extra TEXT)" };

    const db2 = new Database(dbPath, { create: true });
    let caught: unknown;
    try {
      await migrate(db2, {
        migrations: [tampered, M2],
        writable: true,
        ignoreSchemaSkew: true, // обход новизны не должен лечить checksum
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).code).toBe("schema.checksum");
    expect((caught as SchemaError).exit).toBe(5);
    db2.close();
  });

  test("прерывание посередине наката не оставляет частичного состояния", async () => {
    const db = new Database(dbPath, { create: true });

    const boom: Migration = {
      version: 2,
      name: "boom",
      sql: "CREATE TABLE b (id INTEGER PRIMARY KEY); this is not valid sql;",
      objects: ["b"],
    };

    let caught: unknown;
    try {
      await migrate(db, { migrations: [M1, boom], writable: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();

    // M1 применилась и закоммитилась в своей собственной транзакции,
    // а вот boom (версия 2) не должна была оставить ни таблицы b, ни записи
    // в schema_migrations — транзакция second-migration откатилась целиком.
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("a");
    expect(tables.map((t) => t.name)).not.toContain("b");

    const rows = db
      .query("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual([1]);
    db.close();
  });

  test("пооператорный накат ловит несозданный объект (молчаливый пропуск CREATE VIRTUAL TABLE)", async () => {
    const db = new Database(dbPath, { create: true });

    // Симулирует поведение bun:sqlite: CREATE VIRTUAL TABLE с неизвестным
    // модулем не бросает исключение внутри Database.exec(), а просто
    // не создаёт объект — здесь эмулируем это через объект, которого
    // заведомо не будет в sqlite_master после наката валидного DDL.
    const sneaky: Migration = {
      version: 1,
      name: "sneaky",
      sql: "CREATE TABLE real_table (id INTEGER PRIMARY KEY)",
      objects: ["real_table", "ghost_table"],
    };

    let caught: unknown;
    try {
      await migrate(db, { migrations: [sneaky], writable: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("ghost_table");

    // И транзакция должна откатиться целиком: даже real_table не остаётся.
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("real_table");
    db.close();
  });

  test("накат CREATE VIRTUAL TABLE с неизвестным модулем действительно ловится (реальный bun:sqlite)", async () => {
    const db = new Database(dbPath, { create: true });
    const virtualModule: Migration = {
      version: 1,
      name: "virtual",
      sql: "CREATE TABLE ok(id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE v USING no_such_module_xyz(e);",
      objects: ["ok", "v"],
    };
    let caught: unknown;
    try {
      await migrate(db, { migrations: [virtualModule], writable: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    db.close();
  });
});

describe("splitStatements через накат", () => {
  test("точка с запятой внутри тела триггера не режет оператор", async () => {
    const db = new Database(dbPath, { create: true });
    const withTrigger: Migration = {
      version: 1,
      name: "trigger",
      sql: `CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE log (id INTEGER PRIMARY KEY, msg TEXT);
            CREATE TRIGGER trg_t AFTER INSERT ON t BEGIN
              INSERT INTO log (msg) VALUES ('ins');
              UPDATE t SET n = n + CASE WHEN new.id > 0 THEN 1 ELSE 0 END WHERE id = new.id;
            END;
            CREATE INDEX ix_t ON t(n);`,
      objects: ["t", "log", "trg_t", "ix_t"],
    };

    const result = await migrate(db, { migrations: [withTrigger], writable: true });
    expect(result.appliedVersions).toEqual([1]);

    db.query("INSERT INTO t (id) VALUES (1)").run();
    expect(db.query("SELECT msg FROM log").all()).toEqual([{ msg: "ins" }]);
    expect(db.query("SELECT n FROM t WHERE id = 1").get()).toEqual({ n: 1 });
    db.close();
  });
});

/**
 * Совместимые миграции (Migration.readableFrom, COMPAT_MIGRATIONS_TABLE):
 * бинарь, знающий схему readableFrom, открывает базу после них, их не зная.
 * Выпущенные бинари читают только schema_migrations — поэтому совместимая
 * туда не пишется; следующие бинари читают обе таблицы и сверяют обещание.
 */
describe("совместимые миграции", () => {
  const C3: Migration = { ...M3, readableFrom: 2 };
  const C4: Migration = {
    version: 4,
    name: "add_a_col",
    sql: "ALTER TABLE a ADD COLUMN w TEXT NOT NULL DEFAULT ''",
    objects: ["a"],
    readableFrom: 3,
  };

  test("пишется не в schema_migrations: старый бинарь видит знакомую схему", async () => {
    const db = new Database(dbPath, { create: true });
    const r = await migrate(db, { migrations: [M1, M2, C3], writable: true });
    expect(r.appliedVersions).toEqual([1, 2, 3]);
    expect((db.query("SELECT max(version) AS v FROM schema_migrations").get() as { v: number }).v).toBe(2);
    expect(
      db.query(`SELECT version, name, readable_from FROM ${COMPAT_MIGRATIONS_TABLE}`).all(),
    ).toEqual([{ version: 3, name: "add_c", readable_from: 2 }]);
    expect(appliedSchemaVersion(db)).toBe(3);
    // Повторное открытие тем же набором — холостое: версия читается по обеим таблицам.
    expect((await migrate(db, { migrations: [M1, M2, C3], writable: true })).appliedVersions).toEqual([]);
    db.close();
  });

  test("незнакомая совместимая открывается, пока её обещание не выше известного бинарю", async () => {
    const db = new Database(dbPath, { create: true });
    await migrate(db, { migrations: [M1, M2, C3, C4], writable: true });
    // Знает 3: C4 обещает совместимость с 3 — открывает, ничего не наносит.
    const r = await migrate(db, { migrations: [M1, M2, C3], writable: true });
    expect(r.appliedVersions).toEqual([]);
    expect(r.degraded).toEqual([]);
    // Знает 2: C3 ему по силам, а C4 требует знать 3 — отказ, как у несовместимой.
    const err = await migrate(db, { migrations: [M1, M2], writable: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaError);
    expect((err as SchemaError).code).toBe("schema.newer");
    expect((err as Error).message).toContain("schema 4, this binary knows 2");
    db.close();
  });

  test("checksum совместимой сверяется так же, как у любой применённой", async () => {
    const db = new Database(dbPath, { create: true });
    await migrate(db, { migrations: [M1, M2, C3], writable: true });
    const tampered: Migration = { ...C3, sql: "CREATE TABLE c (id INTEGER PRIMARY KEY, z TEXT, extra TEXT)" };
    const err = await migrate(db, { migrations: [M1, M2, tampered], writable: true }).catch((e: unknown) => e);
    expect((err as SchemaError).code).toBe("schema.checksum");
    db.close();
  });

  test("обещание, которое нарушает несовместимая миграция между ними, отвергается до наката", async () => {
    const db = new Database(dbPath, { create: true });
    // C4 обещает «знающий 1 откроет», но M2 и M3 между ними несовместимы.
    const lying: Migration = { ...C4, readableFrom: 1 };
    await expect(migrate(db, { migrations: [M1, M2, M3, lying], writable: true })).rejects.toThrow(/is a lie/);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeNull();
    db.close();
  });
});
