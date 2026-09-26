/**
 * ПАРИТЕТ ДИАЛЕКТОВ (приёмка memory-2xgh8mg2fs24: «тот же набор запросов
 * проходит на Postgres с теми же результатами»).
 *
 * Реестр запросов один на оба диалекта (§8.4): у записи есть текст SQLite и,
 * только при настоящем расхождении, оверрайд `pg`. Проверить это чтением
 * нельзя — расхождения прячутся в функциях (`json_extract`, `instr`), в типах
 * (BIGINT приходит строкой) и в пустяках вроде регистра имён колонок.
 * Поэтому здесь: ОДИН посев, исполненный обеими базами дословно, и ОДИН
 * список запросов, чьи ответы сравниваются строка в строку.
 *
 * ПОЧЕМУ В СЕРВЕРЕ. `deps-check` держит правило: пакет `store-*` зависит
 * только от ядра, поэтому ни один из двух хранилищ не вправе знать про
 * другой. Сервер — поверхность, и именно он в M4 обязан исполнять эти
 * запросы на Postgres; здесь стенд и живёт (store-sqlite у сервера в
 * devDependencies — в бинарь он не попадает).
 *
 * СРАВНЕНИЕ ЧЕРЕЗ НОРМАЛИЗАЦИЮ, И ЭТО СКАЗАНО ВСЛУХ. Драйверы отдают одно и
 * то же разными типами JS: bun:sqlite — number, Postgres — строку для BIGINT
 * и boolean для логических выражений. Сравнивать как есть значило бы ловить
 * не расхождение данных, а расхождение обёрток, поэтому значения приводятся к
 * строке (`normalize`), а `null` остаётся `null`. Всё, что нормализация
 * скрывает, названо здесь: тип числа и тип логического значения. Порядок
 * строк и их состав не скрывается ничем.
 *
 * Без `MYC_PG_URL` тест говорит об этом и пропускается (образ и команда — в
 * докстроке packages/store-postgres/src/schema.pg.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { Q, migrate, migrations, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { resolveQueryText, type QueryDef } from "@myc/core";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
const TENANT = "parity";
const SCOPE = "cherry";

/**
 * Посев, исполнимый ОБЕИМИ базами дословно: явные списки колонок (generated
 * колонки обеих схем в них не входят), числа вместо булевых, JSON строкой —
 * ровно то подмножество SQL, на котором диалекты совпадают by design.
 */
const SEED: readonly string[] = [
  `INSERT INTO myc_meta (key, value) VALUES ('site_id','siteA'), ('slug','${SCOPE}')`,
  `INSERT INTO nodes (id, kind, layer, scope, title, body, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-0001','task',1,'${SCOPE}','починить дренаж','тело первой задачи','open',1,'h-1','{"reach":"project","external_ref":"bd-42"}',10,10,100,'siteA')`,
  `INSERT INTO nodes (id, kind, layer, scope, title, body, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id, ext_dup)
   VALUES ('${SCOPE}-0002','task',1,'${SCOPE}','починить дренаж','тело первой задачи','open',2,'h-1:${SCOPE}-0002','{"reach":"project","external_ref":"bd-42"}',20,20,200,'siteA','${SCOPE}-0002')`,
  `INSERT INTO nodes (id, kind, layer, scope, title, body, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-0003','note',2,'${SCOPE}','решение про очередь','очередь разбирается по одному','active',2,'h-3','{"reach":"project"}',30,30,300,'siteA')`,
  `INSERT INTO edges (src, type, dst, add_tag, created_at, hlc, site_id)
   VALUES ('${SCOPE}-0001','blocks','${SCOPE}-0003','tag-1',40,400,'siteA')`,
  `INSERT INTO field_clock (entity_id, field, hlc, site_id) VALUES ('${SCOPE}-0001','kind',100,'siteA'), ('${SCOPE}-0002','kind',200,'siteA')`,
  `INSERT INTO counters (entity_id, field, site_id, value) VALUES ('${SCOPE}-0001','seen_count','siteA',3)`,
  `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id, field, value, scope, origin)
   VALUES ('siteA:1','siteA',100,10,'tester','set','node','${SCOPE}-0001','title','"починить дренаж"','${SCOPE}',1)`,
];

/** Случай паритета: запрос реестра и параметры к нему. */
interface Case {
  readonly q: QueryDef;
  readonly params: readonly unknown[];
}

const CASES: readonly Case[] = [
  { q: Q.meta_get, params: ["site_id"] },
  { q: Q.node_head, params: [`${SCOPE}-0001`] },
  { q: Q.node_content_row, params: [`${SCOPE}-0001`] },
  { q: Q.node_external_row, params: [`${SCOPE}-0001`] },
  { q: Q.content_group, params: [SCOPE, "task", "h-1", "h-1;"] },
  { q: Q.external_group, params: [SCOPE, "task", "bd-42"] },
  { q: Q.external_duplicates, params: [] },
  { q: Q.external_duplicates_count, params: [] },
  { q: Q.content_duplicates_count, params: [] },
  { q: Q.field_clock_get, params: [`${SCOPE}-0001`, "kind"] },
  { q: Q.counter_sum, params: [`${SCOPE}-0001`, "seen_count"] },
  { q: Q.oplog_count, params: [] },
  { q: Q.oplog_for_entity, params: [`${SCOPE}-0001`] },
  { q: Q.oplog_since, params: [0, 10] },
  { q: Q.oplog_last_local_hlc, params: ["siteA"] },
  { q: Q.oplog_last_row_clock, params: [] },
  { q: Q.oplog_last_local_op_id, params: ["siteA"] },
  { q: Q.counter_get, params: [`${SCOPE}-0001`, "seen_count", "siteA"] },
  { q: Q.pending_count, params: [] },
  { q: Q.pending_any, params: [] },
  { q: Q.node_get, params: [`${SCOPE}-0001`] },
  { q: Q.node_get_live, params: [`${SCOPE}-0002`] },
  { q: Q.content_duplicates, params: [] },
];

/** Типы обёрток стираются, данные — нет (см. докстроку файла). */
function normalize(rows: readonly unknown[]): unknown[] {
  return rows.map((row) => {
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      out[k.toLowerCase()] =
        v === null || v === undefined
          ? null
          : typeof v === "boolean"
            ? v ? "1" : "0"
            : v instanceof Uint8Array
              ? `bytes:${v.length}`
              : String(v);
    }
    return out;
  });
}

let lite: SqliteDriver | undefined;
let pg: PostgresDriver | undefined;
let admin: SQL | undefined;

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

  for (const stmt of SEED) lite.database.exec(stmt);
  await pg.withTenant(TENANT, async (tx) => {
    for (const stmt of SEED) await tx.raw(stmt);
  });
});

afterAll(async () => {
  lite?.close();
  await pg?.close();
  await admin?.close();
});

describe("паритет диалектов на одном посеве", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  for (const c of CASES) {
    test(`${c.q.name}: SQLite и Postgres отвечают одинаково`, async () => {
      if (skip !== null) return void console.log(`[skip] ${skip}`);
      const fromLite = normalize(lite!.all(c.q, c.params));
      const fromPg = normalize(await pg!.withTenant(TENANT, async (tx) => tx.all(c.q, c.params)));
      // Текст запроса печатается при расхождении: разбирать паритет по голому
      // «не равно» — то же самое, что разбирать его вслепую.
      if (JSON.stringify(fromLite) !== JSON.stringify(fromPg)) {
        console.log(
          `[паритет] ${c.q.name}\n  sqlite: ${c.q.sql.replace(/\s+/g, " ")}\n` +
            `  pg:     ${resolveQueryText(c.q, "pg").replace(/\s+/g, " ")}\n` +
            `  sqlite → ${JSON.stringify(fromLite)}\n  pg     → ${JSON.stringify(fromPg)}`,
        );
      }
      expect(fromPg).toEqual(fromLite);
    });
  }
});
