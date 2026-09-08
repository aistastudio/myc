/**
 * `ensureSiteId` — шов между чистым решением (`decideSiteId`, покрыт
 * site-identity.test.ts) и настоящей базой. Здесь проверяется ровно то, что
 * добавляет шов и чего в чистой функции нет: КАКИЕ ключи `myc_meta` он трогает
 * при каждом исходе, СКОЛЬКО раз пишет и КОМУ говорит.
 *
 * Число записей — не косметика. Проверка стоит одного `statSync` только пока
 * она молчит на базе, открытой на своём месте; лишняя запись в `myc_meta` на
 * каждое открытие стоила бы транзакции на КАЖДЫЙ вызов CLI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  databaseMeta,
  driverMeta,
  ensureSiteId,
  META_LAST_SEQ,
  META_SITE_ID,
  META_SITE_INSTANCE,
  META_SITE_PREV,
  mintSiteId,
  observeInstance,
  renderInstance,
  type SiteMetaIo,
} from "./site-identity.ts";
import { GraphStore } from "./queries.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { openSqlite, type SqliteDriver } from "./index.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-ensure-site-"));
  dbPath = join(dir, "myc.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function freshDriver(): Promise<SqliteDriver> {
  const driver = openSqlite(dbPath);
  await migrate(driver.database, { migrations, writable: true });
  return driver;
}

/** Счётчик записей поверх настоящего io: сколько раз тронули myc_meta. */
function counting(io: SiteMetaIo): { io: SiteMetaIo; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    io: {
      read: io.read,
      write: (key, value) => {
        writes.push(key);
        io.write(key, value);
      },
    },
  };
}

describe("ensureSiteId: что записывается при каждом исходе", () => {
  test("пустая база — minted: site_id и экземпляр, больше ничего", async () => {
    const driver = await freshDriver();
    try {
      const c = counting(driverMeta(driver));
      const warns: string[] = [];
      const r = ensureSiteId({
        meta: c.io,
        dbPath,
        mint: () => mintSiteId("proj"),
        warn: (l) => warns.push(l),
      });
      expect(r.origin).toBe("minted");
      expect(r.siteId.startsWith("local-proj-")).toBe(true);
      expect(c.writes.sort()).toEqual([META_SITE_ID, META_SITE_INSTANCE].sort());
      expect(warns).toEqual([]);
      // Записанный экземпляр — про ЭТОТ файл, а не про какой-нибудь.
      const stored = JSON.parse(c.io.read(META_SITE_INSTANCE)!) as { ino: number };
      expect(stored.ino).toBe(Number(statSync(dbPath).ino));
    } finally {
      driver.close();
    }
  });

  test("повторное открытие на месте — existing: НИ ОДНОЙ записи", async () => {
    const driver = await freshDriver();
    try {
      ensureSiteId({ meta: driverMeta(driver), dbPath, mint: () => mintSiteId("proj") });
      const c = counting(driverMeta(driver));
      const r = ensureSiteId({ meta: c.io, dbPath, mint: () => mintSiteId("proj") });
      expect(r.origin).toBe("existing");
      expect(c.writes).toEqual([]);
    } finally {
      driver.close();
    }
  });

  test("база старше S65 (экземпляра нет) — adopted: site_id НЕ меняется", async () => {
    const driver = await freshDriver();
    try {
      driver.database
        .query("INSERT INTO myc_meta (key, value) VALUES (?1, ?2)")
        .run(META_SITE_ID, "local-legacy-aaa");
      const c = counting(driverMeta(driver));
      const warns: string[] = [];
      const r = ensureSiteId({
        meta: c.io,
        dbPath,
        mint: () => mintSiteId("proj"),
        warn: (l) => warns.push(l),
      });
      // Перевыпуск наугад раздробил бы site_id у всех воркспейсов, живших до
      // перехода, включая нескопированные, — поэтому усыновление, не минт.
      expect(r.origin).toBe("adopted");
      expect(r.siteId).toBe("local-legacy-aaa");
      expect(c.writes).toEqual([META_SITE_INSTANCE]);
      expect(warns).toEqual([]);
    } finally {
      driver.close();
    }
  });

  test("чужой экземпляр — reissued: новый site_id, prev, last_seq=0 и WARN", async () => {
    const driver = await freshDriver();
    try {
      const first = ensureSiteId({
        meta: driverMeta(driver),
        dbPath,
        mint: () => mintSiteId("proj"),
      });
      // Копия: та же база, но запись говорит про ДРУГОЙ инод.
      const alien = { ...observeInstance(dbPath), ino: 999_999_999 };
      driver.database
        .query("INSERT INTO myc_meta (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(META_SITE_INSTANCE, renderInstance(alien));
      driver.database
        .query("INSERT INTO myc_meta (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(META_LAST_SEQ, "1825");

      const c = counting(driverMeta(driver));
      const warns: string[] = [];
      const r = ensureSiteId({
        meta: c.io,
        dbPath,
        mint: () => mintSiteId("proj"),
        warn: (l) => warns.push(l),
      });

      expect(r.origin).toBe("reissued");
      expect(r.siteId).not.toBe(first.siteId);
      expect(r.reissuedFrom).toBe(first.siteId);
      expect(c.writes.sort()).toEqual(
        [META_SITE_ID, META_SITE_INSTANCE, META_SITE_PREV, META_LAST_SEQ].sort(),
      );
      expect(c.io.read(META_LAST_SEQ)).toBe("0");
      expect(JSON.parse(c.io.read(META_SITE_PREV)!)).toEqual([first.siteId]);

      expect(warns.length).toBe(1);
      expect(warns[0]).toContain("WARN");
      expect(warns[0]).toContain(first.siteId);
      expect(warns[0]).toContain(r.siteId);
      expect(r.warning).toBe(warns[0]!);
    } finally {
      driver.close();
    }
  });

  test("умолчание громкое: без warn перевыпуск уходит в stderr", async () => {
    const driver = await freshDriver();
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      ensureSiteId({ meta: driverMeta(driver), dbPath, mint: () => mintSiteId("proj") });
      const alien = { ...observeInstance(dbPath), ino: 12_345 };
      driver.database
        .query("INSERT INTO myc_meta (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(META_SITE_INSTANCE, renderInstance(alien));
      ensureSiteId({ meta: driverMeta(driver), dbPath, mint: () => mintSiteId("proj") });
    } finally {
      (process.stderr as unknown as { write: unknown }).write = real;
      driver.close();
    }
    expect(written.join("")).toContain("site_id перевыпущен");
  });
});

describe("ensureSiteId: обнулённый last_seq — тот самый ключ, которым живёт GraphStore", () => {
  /**
   * Ключ `last_seq` продублирован из queries.ts (там он приватный). Разъехаться
   * он может молча, поэтому проверяется не строкой, а поведением: после
   * перевыпуска первая же операция обязана получить seq 1.
   */
  test("после перевыпуска первая операция нового сайта — seq 1", async () => {
    const driver = await freshDriver();
    try {
      ensureSiteId({ meta: driverMeta(driver), dbPath, mint: () => mintSiteId("proj") });
      const before = new GraphStore(driver, { newId: () => `proj-${Math.random()}`, actor: "t" });
      for (let i = 0; i < 5; i++) {
        before.createNode({ kind: "note", scope: "s", title: `у ${i}`, body: "тело" });
      }
      const seqBefore = Number(
        (driver.database.query("SELECT value FROM myc_meta WHERE key=?1").get(META_LAST_SEQ) as {
          value: string;
        }).value,
      );
      expect(seqBefore).toBeGreaterThan(0);

      const alien = { ...observeInstance(dbPath), ino: 777 };
      driver.database
        .query("INSERT INTO myc_meta (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(META_SITE_INSTANCE, renderInstance(alien));
      const r = ensureSiteId({
        meta: driverMeta(driver),
        dbPath,
        mint: () => mintSiteId("proj"),
        warn: () => {},
      });
      expect(r.origin).toBe("reissued");

      const after = new GraphStore(driver, { newId: () => `proj-${Math.random()}`, actor: "t" });
      expect(after.siteId).toBe(r.siteId);
      after.createNode({ kind: "note", scope: "s", title: "первая своя", body: "тело" });
      const rows = driver.database
        .query("SELECT op_id FROM oplog WHERE site_id = ?1 ORDER BY seq")
        .all(r.siteId) as { op_id: string }[];
      expect(rows[0]!.op_id).toBe(`${r.siteId}:1`);
      // История прежнего сайта на месте — перевыпуск её не трогает.
      const old = driver.database
        .query("SELECT count(*) AS n FROM oplog WHERE site_id = ?1")
        .get(r.reissuedFrom!) as { n: number };
      expect(old.n).toBeGreaterThan(0);
    } finally {
      driver.close();
    }
  });
});

describe("адаптеры myc_meta", () => {
  test("databaseMeta и driverMeta видят одну и ту же таблицу", async () => {
    const driver = await freshDriver();
    try {
      const viaDriver = driverMeta(driver);
      viaDriver.write("проба", "значение");
      const viaDb = databaseMeta(driver.database);
      expect(viaDb.read("проба")).toBe("значение");
      viaDb.write("проба", "другое");
      expect(viaDriver.read("проба")).toBe("другое");
      expect(viaDb.read("нет-такого")).toBeUndefined();
    } finally {
      driver.close();
    }
  });

  test("голое соединение: минт через databaseMeta записывает обе строки", async () => {
    const db = new Database(dbPath, { create: true });
    try {
      await migrate(db, { migrations, writable: true });
      const r = ensureSiteId({ meta: databaseMeta(db), dbPath, mint: () => mintSiteId("me") });
      expect(r.origin).toBe("minted");
      const rows = db
        .query("SELECT key, value FROM myc_meta WHERE key IN (?1, ?2)")
        .all(META_SITE_ID, META_SITE_INSTANCE) as { key: string; value: string }[];
      expect(rows.length).toBe(2);
    } finally {
      db.close();
    }
  });
});
