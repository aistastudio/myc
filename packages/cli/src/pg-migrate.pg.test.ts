/**
 * ПРИЁМКА memory-rjb0vk556j8e: база, созданная прошлым релизом, ДОГОНЯЕТ.
 *
 * Стенд строит ровно то состояние, которое оставлял прошлый релиз: тот же
 * слепок `db/schema.postgres.sql`, но с номером базовой строки на единицу
 * меньше. Подделки здесь нет — слепок и есть способ, которым та версия
 * создавала базу; меняется только номер, под которым она о себе записала.
 *
 * Мутации, которые этот файл обязан ловить (обе проверены прогоном):
 *   1) считать отставшие РАЗНОСТЬЮ МНОЖЕСТВ, а не «номер больше
 *      максимального» — 2 падения: на слепке лежит одна строка учёта, и
 *      разность объявит отставшими все миграции до неё, то есть накатит на
 *      готовую схему первую попавшуюся;
 *   2) снять предусловие о правах — 1 падение: прикладная роль под RLS
 *      меняет ноль строк, МОЛЧА, и всё равно записывает новый номер.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { migrations } from "@myc/store-sqlite";
import { canBypassRls, knownSchemaVersion, migratePostgres, pgSchemaVersion } from "./pg-migrate.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
const KNOWN = knownSchemaVersion();

/** Слепок, каким его писала версия с номером `version`. */
function baselineAt(version: number): string {
  const at = DDL.replace(
    /(INSERT INTO schema_migrations[\s\S]*?SELECT\s+)\d+(,\s*'postgres-baseline')/,
    `$1${version}$2`,
  );
  if (at === DDL) throw new Error("стенд: базовая строка слепка не найдена — проверьте db/schema.postgres.sql");
  return at;
}

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let app: PostgresDriver | undefined;

afterAll(async () => {
  await pg?.close();
  await app?.close();
  await admin?.close();
});

describe("Postgres догоняет: слепок прошлой версии → нынешняя схема", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  beforeEach(async () => {
    if (URL_ENV === undefined) return;
    await pg?.close();
    await app?.close();
    admin ??= new SQL(URL_ENV);
    await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    // Состояние прошлого релиза: та же схема, номер на единицу меньше.
    await admin.unsafe(baselineAt(KNOWN - 1));
    await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
    await admin.unsafe("GRANT USAGE ON SCHEMA public TO myc_app; GRANT ALL ON ALL TABLES IN SCHEMA public TO myc_app;");
    pg = openPostgres(URL_ENV);
    const u = new URL(URL_ENV);
    u.username = "myc_app";
    u.password = "myc_app_test";
    app = openPostgres(u.toString());
  });

  test("отставание видно по учёту, и накат доводит до нынешнего номера", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    expect(await pgSchemaVersion(pg!)).toBe(KNOWN - 1);

    const first = await migratePostgres(pg!);
    expect(first.from).toBe(KNOWN - 1);
    expect(first.to).toBe(KNOWN);
    expect(first.appliedVersions).toEqual([KNOWN]);

    // ПОВТОР НИЧЕГО НЕ МЕНЯЕТ: иначе контейнер, перезапущенный дважды,
    // накатывал бы одно и то же и падал на второй попытке.
    const again = await migratePostgres(pg!);
    expect(again.appliedVersions).toEqual([]);
    expect([again.from, again.to]).toEqual([KNOWN, KNOWN]);
  });

  test("миграция данных ДОХОДИТ ДО СТРОК, а не только до учёта", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // Узел ровно того вида, который чинит миграция 16: приватный, с автором
    // и без владельца.
    await admin!.unsafe(`
      INSERT INTO tenants (id, title, created_at) VALUES ('acme','Acme',1);
      SET myc.tenant = 'acme';
      INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, acl, actor, owner_id, created_at, updated_at)
      VALUES ('n1','note',1,'acme','приватная','active',2,'h1','private','anna','',1,1);
    `);

    await migratePostgres(pg!);

    const [row] = await pg!.withTenant("acme", async (tx) =>
      tx.all<{ owner_id: string }>(
        { name: "own", sql: "SELECT owner_id FROM nodes WHERE id = ?1", params: ["id"] },
        ["n1"],
      ),
    );
    // Учёт без данных — худший исход из возможных: номер новый, поведение
    // старое, и заметить это нечем. Ровно так вело себя первое рабочее
    // решение, пока миграция шла под прикладной ролью.
    expect(row?.owner_id).toBe("anna");
  });

  test("прикладная роль не мигрирует: под RLS она не видит чужих строк", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    expect(await canBypassRls(pg!)).toBe(true);
    expect(await canBypassRls(app!)).toBe(false);
    await expect(migratePostgres(app!)).rejects.toThrow(/superuser|BYPASSRLS/);
    // И главное: отказ случился ДО записи в учёт.
    expect(await pgSchemaVersion(app!)).toBe(KNOWN - 1);
  });

  test("список миграций один: у каждой есть текст для Postgres", () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // Не «все переведены заранее», а «перевод существует»: явный `pg` или
    // механический. Пустая строка — законный ответ «здесь делать нечего».
    for (const m of migrations) {
      expect(typeof (m.pg ?? m.sql)).toBe("string");
    }
  });
});
