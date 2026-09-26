/**
 * ОДИН ПРИМЕНИТЕЛЬ, ДВЕ БАЗЫ — приёмка выноса правил слияния в ядро
 * (решение 03-interfaces-and-integration.md §8.1.1).
 *
 * Тот же пакет операций применяется к SQLite синхронным исполнителем и к
 * Postgres асинхронным, после чего сравниваются ПОСЛЕДСТВИЯ: строки узлов,
 * рёбер, часов полей, счётчиков и оплога. Расхождение здесь означает ровно то,
 * ради предотвращения чего затевался вынос, — правила разошлись.
 *
 * Почему не хватает тестов движка: они гоняют применитель ТОЛЬКО синхронно.
 * Асинхронный путь — тот, которым сервер пишет в общую базу команды, и
 * непроверенным он стоит дороже всего.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import {
  applyOps,
  HlcClock,
  OpFactory,
  runAsync,
  runSync,
  type ApplyCtx,
  type Op,
} from "@myc/core";
import { migrate, migrations, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
const TENANT = "apply";
const SCOPE = "cherry";
const SITE = "siteB";

let lite: SqliteDriver | undefined;
let pg: PostgresDriver | undefined;
let admin: SQL | undefined;

/** Контекст применителя: у обеих сторон он одинаков, кроме драйвера. */
function ctx(): ApplyCtx {
  const ops = new OpFactory(SITE, { clock: new HlcClock() });
  return { actor: "tester", siteId: SITE, ops, now: () => 1_000 };
}

/**
 * Пакет операций, покрывающий то, на чём диалекты расходятся: рождение узла,
 * обычное поле, поле внутри attrs (json), счётчик и ребро.
 */
function batch(): readonly Op[] {
  const f = new OpFactory(SITE, { clock: new HlcClock() });
  const id = `${SCOPE}-0001`;
  const other = `${SCOPE}-0002`;
  return [
    f.set(id, "kind", "task"),
    f.set(id, "scope", SCOPE),
    f.set(id, "title", "починить дренаж"),
    f.set(id, "attrs.external_ref", "bd-42"),
    f.inc(id, "seen_count", 1),
    f.set(other, "kind", "task"),
    f.set(other, "scope", SCOPE),
    f.set(other, "title", "вторая"),
    f.edgeAdd(id, "blocks", other, 1.0),
  ];
}

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  lite = openSqlite(":memory:");
  await migrate(lite.database, { migrations, writable: true });

  admin = new SQL(URL_ENV);
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  pg = openPostgres(u.toString());
});

afterAll(async () => {
  lite?.close();
  await pg?.close();
  await admin?.close();
});

/** Типы обёрток стираются, данные — нет (как в parity.pg.test.ts). */
function normalize(rows: readonly unknown[]): unknown[] {
  return rows.map((row) => {
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      out[k.toLowerCase()] =
        v === null || v === undefined
          ? null
          : typeof v === "boolean"
            ? v ? "1" : "0"
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v);
    }
    return out;
  });
}

describe("применитель: синхронно и асинхронно — одинаково", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  test("пакет операций даёт одни и те же строки на обеих базах", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const ops = batch();

    const fromLite = lite!.tx("immediate", (tx) => runSync(applyOps(ctx(), ops), tx));
    const fromPg = await pg!.withTenant(TENANT, async (tx) => runAsync(applyOps(ctx(), ops), tx));

    // Сначала ИТОГ применения: он и есть ответ вызывающему.
    expect({ ...fromPg, duplicates: fromPg.duplicates.length }).toEqual({
      ...fromLite,
      duplicates: fromLite.duplicates.length,
    });

    // Затем последствия в таблицах — по ним видно расхождение правил.
    const tables: ReadonlyArray<readonly [string, string]> = [
      ["nodes", "SELECT id, kind, scope, title, status, seen_count, attrs FROM nodes ORDER BY id"],
      ["edges", "SELECT src, type, dst, add_tag, weight, deleted_at FROM edges ORDER BY src, type, dst"],
      ["field_clock", "SELECT entity_id, field, site_id FROM field_clock ORDER BY entity_id, field"],
      ["counters", "SELECT entity_id, field, site_id, value FROM counters ORDER BY entity_id, field"],
      ["oplog", "SELECT op, entity, entity_id, field, scope, origin FROM oplog ORDER BY op_id"],
    ];
    for (const [name, sql] of tables) {
      const a = normalize(lite!.database.query(sql).all() as unknown[]);
      const b = normalize(await pg!.withTenant(TENANT, async (tx) => tx.raw(sql)));
      expect([name, b]).toEqual([name, a]);
    }
  });
});
