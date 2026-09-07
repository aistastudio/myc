/**
 * Кеш дайджестов: инвариант «попадание неотличимо от расчёта».
 *
 * Проверяется против НАСТОЯЩЕЙ схемы (db/schema.sqlite.sql) — core не может
 * зависеть от store-sqlite (scripts/deps-check.ts), поэтому здесь мини-драйвер
 * поверх bun:sqlite, как в memory.test.ts. Кросс-процессная половина приёмки
 * (два процесса видят инвалидацию друг друга) живёт отдельно, на настоящих
 * Bun.spawn: packages/cli/src/commands/digest-cache.multiprocess.test.ts —
 * однопоточным тестом она не проверяется в принципе.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIGEST_PROFILE_PRIME,
  DIGEST_PROFILE_READY,
  digestCacheQueries,
  digestCached,
  digestDropScope,
  digestLookup,
  digestStore,
} from "./digest-cache.ts";
import { resolveQueryText, type DbDriver, type QueryDef } from "./sql.ts";

// ---------------------------------------------------------------------------
// Мини-драйвер: ровно DbDriver поверх bun:sqlite, без единой строки логики
// кеша. Всё, что проверяется ниже, обязано лежать в digest-cache.ts.
// ---------------------------------------------------------------------------

function openSchema(): { db: Database; driver: DbDriver } {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../../../db/schema.sqlite.sql"), "utf8"));
  const text = (q: QueryDef): string => resolveQueryText(q, "sqlite");
  const driver: DbDriver = {
    dialect: "sqlite",
    one: <T,>(q: QueryDef, p: readonly unknown[]) =>
      db.query(text(q)).get(...(p as never[])) as T | undefined,
    all: <T,>(q: QueryDef, p: readonly unknown[]) =>
      db.query(text(q)).all(...(p as never[])) as T[],
    run: (q: QueryDef, p: readonly unknown[]) => {
      const r = db.query(text(q)).run(...(p as never[]));
      return { changes: Number(r.changes) };
    },
    tx: <T,>(_mode: unknown, fn: (tx: DbDriver) => T) => db.transaction(() => fn(driver))(),
  };
  return { db, driver };
}

/**
 * Строка оплога. `site` по умолчанию свой; чужой сайт — это операция,
 * приехавшая репликацией: она двигает oplog.seq и НЕ двигает myc_meta.last_seq.
 */
let hlc = 1;
function writeOp(db: Database, scope: string, site = "local"): number {
  hlc += 1;
  db.query(
    `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id,
                        field, value, scope, origin)
     VALUES (?1, ?2, ?3, ?4, 'tester', 'set', 'node', 'n1', 'title', '"t"', ?5, ?6)`,
  ).run(`${site}:${hlc}`, site, hlc, hlc, scope, site === "local" ? 1 : 0);
  return Number(
    (db.query(`SELECT max(seq) AS s FROM oplog`).get() as { s: number | null }).s ?? 0,
  );
}

interface Payload {
  readonly core: readonly string[];
}

const PRIME = { scope: "s1", profile: DIGEST_PROFILE_PRIME, variant: "" } as const;

describe("digest_cache: попадание неотличимо от расчёта", () => {
  test("холодный промах считает, попадание не считает, запись падает в profile='prime'", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    let computed = 0;
    const compute = (): Payload => {
      computed++;
      return { core: ["a"] };
    };

    const first = digestCached<Payload>(driver, PRIME, compute);
    expect(first.cache).toBe("miss");
    expect(first.reason).toBe("cold");
    expect(computed).toBe(1);

    const second = digestCached<Payload>(driver, PRIME, compute);
    expect(second.cache).toBe("hit");
    expect(second.payload).toEqual({ core: ["a"] });
    // Расчёта не было: попадание обязано быть попаданием, а не тихим пересчётом.
    expect(computed).toBe(1);

    // Стык S4: prime — это ЗНАЧЕНИЕ колонки profile, а не отдельная таблица.
    const row = db
      .query(`SELECT scope, profile, variant, seq, payload FROM digest_cache`)
      .all() as Array<{ scope: string; profile: string; variant: string; seq: number }>;
    expect(row.length).toBe(1);
    expect(row[0]!.profile).toBe("prime");
    expect(row[0]!.scope).toBe("s1");
    expect(row[0]!.seq).toBe(1);
  });

  test("запись в оплог делает попадание промахом (stale), и это ЕДИНСТВЕННОЕ условие", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    let computed = 0;
    const compute = (): Payload => ({ core: [`v${++computed}`] });

    expect(digestCached<Payload>(driver, PRIME, compute).cache).toBe("miss");
    expect(digestCached<Payload>(driver, PRIME, compute).cache).toBe("hit");

    writeOp(db, "s1");
    const after = digestCached<Payload>(driver, PRIME, compute);
    expect(after.cache).toBe("miss");
    expect(after.reason).toBe("stale");
    expect(after.payload).toEqual({ core: ["v2"] });
    expect(digestCached<Payload>(driver, PRIME, compute).cache).toBe("hit");
  });

  test("устаревший payload НЕ покидает SQLite: сравнение seq стоит в запросе", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    digestStore(driver, PRIME, 1, { core: ["старое"] });
    writeOp(db, "s1");

    // Прямой взгляд на тот самый единственный statement.
    const raw = db
      .query(resolveQueryText(digestCacheQueries.digest_lookup, "sqlite"))
      .get("s1", "prime", "") as {
      now_seq: number;
      entry_seq: number | null;
      payload: string | null;
    };
    expect(raw.now_seq).toBe(2);
    expect(raw.entry_seq).toBe(1);
    // Запись есть, но её содержимое из базы не выдано вовсе.
    expect(raw.payload).toBeNull();

    const found = digestLookup<Payload>(driver, PRIME);
    expect(found.cache).toBe("miss");
    expect(found.reason).toBe("stale");
    expect(found.payload).toBeUndefined();
    expect(found.seq).toBe(2);
  });

  test("операция ЧУЖОГО сайта инвалидирует кеш: источник версии — oplog, а не myc_meta.last_seq", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1", "local");
    // Локальный счётчик — то, что задача называла источником инвалидации.
    db.query(`INSERT INTO myc_meta (key, value) VALUES ('last_seq', '1')`).run();

    let computed = 0;
    const compute = (): Payload => ({ core: [`v${++computed}`] });
    expect(digestCached<Payload>(driver, PRIME, compute).cache).toBe("miss");
    expect(digestCached<Payload>(driver, PRIME, compute).cache).toBe("hit");

    // Приезд чужой операции (myc import / merge): оплог вырос, last_seq — нет.
    const seqAfter = writeOp(db, "s1", "remote-site");
    const lastSeq = (db.query(`SELECT value FROM myc_meta WHERE key='last_seq'`).get() as {
      value: string;
    }).value;
    expect(seqAfter).toBe(2);
    expect(lastSeq).toBe("1");

    // Кеш по last_seq здесь отдал бы вчерашний дайджест; кеш по oplog.seq — нет.
    const after = digestCached<Payload>(driver, PRIME, compute);
    expect(after.cache).toBe("miss");
    expect(after.reason).toBe("stale");
    expect(after.payload).toEqual({ core: ["v2"] });
  });

  test("seq берётся ДО расчёта: запись, случившаяся во время расчёта, не помечается свежей", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    // compute сам двигает оплог — так выглядит соседний процесс, успевший
    // записать между чтением версии и укладкой результата.
    const racy = digestCached<Payload>(driver, PRIME, () => {
      writeOp(db, "s1");
      return { core: ["посчитано на границе"] };
    });
    expect(racy.cache).toBe("miss");
    expect(racy.seq).toBe(1);

    const stored = db.query(`SELECT seq FROM digest_cache`).get() as { seq: number };
    expect(stored.seq).toBe(1);
    // Ярлык старый — значит следующий читатель пересчитает, а не получит
    // ответ, посчитанный неизвестно на какой версии базы.
    expect(digestLookup<Payload>(driver, PRIME).cache).toBe("miss");
  });
});

describe("digest_cache: ключ", () => {
  test("вариант разделяет сессии: дайджест A не отдаётся B при том же seq", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    digestStore(driver, { ...PRIME, variant: "v3:sessionA:" }, 1, { core: ["A"] });

    const b = digestLookup<Payload>(driver, { ...PRIME, variant: "v3:sessionB:" });
    expect(b.cache).toBe("miss");
    expect(b.reason).toBe("cold");
    const a = digestLookup<Payload>(driver, { ...PRIME, variant: "v3:sessionA:" });
    expect(a.payload).toEqual({ core: ["A"] });
  });

  test("вариант разделяет репозитории, скоуп — воркспейсы, профиль — prime и ready", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    writeOp(db, "s2");
    digestStore(driver, { ...PRIME, variant: "v3::collector" }, 1, { core: ["collector"] });
    digestStore(driver, { ...PRIME, variant: "v3::messaging" }, 1, { core: ["messaging"] });
    digestStore(driver, { scope: "s2", profile: DIGEST_PROFILE_PRIME }, 2, { core: ["s2"] });
    digestStore(driver, { scope: "s1", profile: DIGEST_PROFILE_READY }, 1, { core: ["ready"] });

    expect(
      digestLookup<Payload>(driver, { ...PRIME, variant: "v3::collector" }).payload,
    ).toEqual({ core: ["collector"] });
    expect(
      digestLookup<Payload>(driver, { ...PRIME, variant: "v3::messaging" }).payload,
    ).toEqual({ core: ["messaging"] });
    expect(digestLookup<Payload>(driver, { scope: "s2", profile: DIGEST_PROFILE_PRIME }).payload)
      .toEqual({ core: ["s2"] });
    expect(digestLookup<Payload>(driver, { scope: "s1", profile: DIGEST_PROFILE_READY }).payload)
      .toEqual({ core: ["ready"] });
    // Профили не смешиваются: один и тот же (scope, variant) — разные записи.
    expect(digestLookup<Payload>(driver, PRIME).cache).toBe("miss");
  });

  test("умолчание варианта — РОВНО пустая строка схемы, и одно на запись и чтение", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    // Записано без варианта — прочитано с явным пустым: это обязано быть
    // одно и то же. Мутация «умолчание в коде другое, чем DEFAULT '' в DDL»
    // ловится именно здесь: пока обе стороны берут одно и то же умолчание
    // из одной строки кода, подмена согласована и не видна ничем другим.
    digestStore(driver, { scope: "s1", profile: DIGEST_PROFILE_PRIME }, 1, { core: ["без"] });
    const stored = db.query(`SELECT variant FROM digest_cache`).all() as Array<{
      variant: string;
    }>;
    expect(stored.map((r) => r.variant)).toEqual([""]);

    const explicit = digestLookup<Payload>(driver, {
      scope: "s1",
      profile: DIGEST_PROFILE_PRIME,
      variant: "",
    });
    expect(explicit.cache).toBe("hit");
    expect(explicit.payload).toEqual({ core: ["без"] });

    // И обратно: положили с явным пустым — читается без варианта вовсе.
    digestStore(driver, { scope: "s1", profile: DIGEST_PROFILE_READY, variant: "" }, 1, {
      core: ["явно"],
    });
    const implicit = digestLookup<Payload>(driver, {
      scope: "s1",
      profile: DIGEST_PROFILE_READY,
    });
    expect(implicit.cache).toBe("hit");
    expect(implicit.payload).toEqual({ core: ["явно"] });
  });

  test("скоупы инвалидируются независимо: запись в s2 не трогает кеш s1", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    digestStore(driver, PRIME, 1, { core: ["s1"] });
    writeOp(db, "s2");
    expect(digestLookup<Payload>(driver, PRIME).cache).toBe("hit");
  });
});

describe("digest_cache: отказы", () => {
  test("битая запись — это промах, а не исключение посреди prime", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    db.query(
      `INSERT INTO digest_cache (scope, profile, variant, seq, payload)
       VALUES ('s1', 'prime', '', 1, 'не json')`,
    ).run();
    const found = digestLookup<Payload>(driver, PRIME);
    expect(found.cache).toBe("miss");
    expect(found.payload).toBeUndefined();

    const again = digestCached<Payload>(driver, PRIME, () => ({ core: ["пересчитано"] }));
    expect(again.payload).toEqual({ core: ["пересчитано"] });
    expect(digestLookup<Payload>(driver, PRIME).payload).toEqual({ core: ["пересчитано"] });
  });

  test("пустой оплог: seq=0, кеш работает и на нём", () => {
    const { driver } = openSchema();
    const first = digestCached<Payload>(driver, PRIME, () => ({ core: ["пусто"] }));
    expect(first.seq).toBe(0);
    expect(first.cache).toBe("miss");
    expect(digestCached<Payload>(driver, PRIME, () => ({ core: ["другое"] })).cache).toBe("hit");
  });

  test("digestDropScope выбрасывает только свой скоуп", () => {
    const { db, driver } = openSchema();
    writeOp(db, "s1");
    writeOp(db, "s2");
    digestStore(driver, PRIME, 1, { core: ["s1"] });
    digestStore(driver, { scope: "s1", profile: DIGEST_PROFILE_READY }, 1, { core: ["s1r"] });
    digestStore(driver, { scope: "s2", profile: DIGEST_PROFILE_PRIME }, 2, { core: ["s2"] });

    expect(digestDropScope(driver, "s1")).toBe(2);
    expect(digestLookup<Payload>(driver, PRIME).cache).toBe("miss");
    expect(digestLookup<Payload>(driver, { scope: "s2", profile: DIGEST_PROFILE_PRIME }).cache)
      .toBe("hit");
  });
});

describe("digest_cache: цена проверки", () => {
  test("один statement, план без TEMP B-TREE: хвост оплога — спуск по ix_oplog_scope", () => {
    const { db } = openSchema();
    for (let i = 0; i < 2000; i++) writeOp(db, i % 2 === 0 ? "s1" : "s2");
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN ${resolveQueryText(digestCacheQueries.digest_lookup, "sqlite")}`,
      )
      .all("s1", "prime", "") as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join(" | ");
    // Ловушка `bd memories myc-sqlite-tail-query`: хвост индекса, прочитанный
    // сортировкой, стоит миллисекунды на большом оплоге.
    expect(text).not.toContain("TEMP B-TREE");
    expect(text).not.toContain("SCAN oplog");
    expect(text).toContain("ix_oplog_scope");
    expect(text).toContain("SEARCH c USING PRIMARY KEY");
  });
});
