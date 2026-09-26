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
 * ПОЧЕМУ В CLI. `deps-check` держит правило: пакет `store-*` зависит только от
 * ядра, поэтому ни одно из двух хранилищ не вправе знать про другое. Реестры
 * запросов при этом разбросаны: общий Q — в store-sqlite, `ready` и `prime` —
 * в командах cli, свой — в mcp. Пакет cli единственный видит их все сразу
 * (и store-postgres у него в зависимостях), а обратная дорога закрыта: cli
 * зависит от server, значит server импортировать cli не вправе. Поэтому посев
 * ОДИН и живёт здесь, а не растекается копиями по пакетам.
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
import { primeQueries } from "./commands/prime.ts";
import { readyQueries } from "./commands/ready.ts";

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
  // --- поверхность очереди ready -------------------------------------------
  // Свой репозиторий и тип bug: приоритет 0, чтобы порядок не зависел от id.
  `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-0004','task',1,'${SCOPE}','поднять сервер','open',0,'h-4','{"repo":"myc","type":"bug"}',40,40,400,'siteA')`,
  // Чужой репозиторий — его видит ready_repo_foreign и не видит ready_candidates.
  `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-0005','task',1,'${SCOPE}','чужая задача','open',2,'h-5','{"repo":"other"}',50,50,500,'siteA')`,
  // Без repo вовсе: ready_repo_unknown считает именно такие.
  `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-0006','task',1,'${SCOPE}','задача без репозитория','open',1,'h-6','{}',60,60,600,'siteA')`,
  // В работе с ПРОСРОЧЕННОЙ арендой: ready_expired_candidates.
  `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id, lease_holder, lease_expires)
   VALUES ('${SCOPE}-0007','task',1,'${SCOPE}','брошенная задача','in_progress',1,'h-7','{"repo":"myc"}',70,70,700,'siteA','anna',50)`,
  // Якорь и ребро touches: ready_touches_exist и ready_anchor_states.
  `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-a1','anchor',1,'${SCOPE}','src/app.ts','stale',2,'h-a1','{}',80,80,800,'siteA')`,
  `INSERT INTO edges (src, type, dst, add_tag, created_at, hlc, site_id)
   VALUES ('${SCOPE}-0004','touches','${SCOPE}-a1','tag-2',90,900,'siteA')`,
  // Блокер: счётчики open_blockers ведут ТРИГГЕРЫ обеих схем, и паритет
  // проверяет заодно их согласие — задача 0006 становится заблокированной.
  `INSERT INTO edges (src, type, dst, add_tag, created_at, hlc, site_id)
   VALUES ('${SCOPE}-0004','blocks','${SCOPE}-0006','tag-3',95,950,'siteA')`,
  // --- двойники СВОЕГО происхождения ---------------------------------------
  // У 0001/0002 есть external_ref, и запросы про содержимое их не смотрят
  // (у них своя ветка — external_*). Без этой пары content_group и
  // content_duplicates сравнивали бы пустоту с пустотой.
  `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-0008','task',1,'${SCOPE}','свой двойник','open',2,'h-9','{}',96,96,960,'siteA')`,
  `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, content_hash, attrs, created_at, updated_at, hlc, site_id)
   VALUES ('${SCOPE}-0009','task',1,'${SCOPE}','свой двойник','open',2,'h-9:${SCOPE}-0009','{}',97,97,970,'siteA')`,
  // Отложенная операция: pending_count и pending_any иначе тоже пусты.
  // `op` — целая операция в JSON (в SQLite это стережёт CHECK json_valid).
  `INSERT INTO oplog_pending (op_id, needs, origin, op, parked_at)
   VALUES ('siteA:2','${SCOPE}-0099',1,'{"op":"set"}',98)`,
];

/** Случай паритета: запрос реестра и параметры к нему. */
interface Case {
  readonly q: QueryDef;
  readonly params: readonly unknown[];
  /** Отличает два прогона одного запроса с разными параметрами. */
  readonly label?: string;
  /**
   * Запрос БЕЗ `ORDER BY` порядка не обещает, и требовать его от двух разных
   * планировщиков — значит проверять совпадение планов, а не данных. Для таких
   * строки сортируются перед сравнением, и здесь это сказано вслух.
   */
  readonly unordered?: boolean;
}

const CASES: readonly Case[] = [
  { q: Q.meta_get, params: ["site_id"] },
  { q: Q.node_head, params: [`${SCOPE}-0001`] },
  { q: Q.node_content_row, params: [`${SCOPE}-0001`] },
  { q: Q.node_external_row, params: [`${SCOPE}-0001`] },
  { q: Q.content_group, params: [SCOPE, "task", "h-9", "h-9;"] },
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

/**
 * Параметры реестров `ready` и `prime` собираются ПО ИМЕНАМ: у каждой записи
 * реестра они объявлены (`params: ["scope","repo",…]`). Выписывать позиции
 * руками для двадцати с лишним запросов — верный способ проверить не тот
 * запрос; здесь же неизвестное имя параметра роняет стенд с внятной причиной.
 */
const NOW = 1_000_000;
const NAMED: Readonly<Record<string, unknown>> = {
  scope: SCOPE,
  repo: "myc",
  now: NOW,
  lim: 5,
  id: `${SCOPE}-0004`,
  session: "sess-1",
  w_pri: 0.4,
  w_unb: 0.2,
  w_fresh: 0.2,
  w_anch: 0.1,
  w_type: 0.1,
};

function named(q: QueryDef, over: Readonly<Record<string, unknown>> = {}): unknown[] {
  return q.params.map((p) => {
    const v = p in over ? over[p] : NAMED[p];
    if (v === undefined) throw new Error(`паритет: нет значения для параметра '${p}' запроса ${q.name}`);
    return v;
  });
}

const R = readyQueries;

/**
 * Реестр очереди ready. Здесь ТОЛЬКО те запросы, которым хватает механического
 * перевода (`toPgDialect`: снять INDEXED BY, json_extract одного ключа → ->>).
 * Четыре скоринговых `ready_top_*` сюда не входят СОЗНАТЕЛЬНО: в них json_type,
 * сравнение чисел из JSON и instr — это не перевод, а другой текст запроса, и
 * он пишется генератором, знающим диалект (следующий шаг задачи).
 */
const READY_CASES: readonly Case[] = [
  { q: R.ready_touches_exist, params: [] },
  { q: R.ready_unblocks_one, params: named(R.ready_unblocks_one) },
  { q: R.ready_anchor_states_one, params: named(R.ready_anchor_states_one) },
  { q: R.ready_stats_blocked, params: named(R.ready_stats_blocked), label: "repo=myc" },
  { q: R.ready_stats_blocked, params: named(R.ready_stats_blocked, { repo: "" }), label: "repo=любой" },
  { q: R.ready_stats_blocked_anc, params: named(R.ready_stats_blocked_anc) },
  { q: R.ready_stats_in_progress, params: named(R.ready_stats_in_progress), label: "repo=myc" },
  { q: R.ready_stats_in_progress, params: named(R.ready_stats_in_progress, { repo: "" }), label: "repo=любой" },
  { q: R.ready_repo_unknown, params: named(R.ready_repo_unknown) },
  { q: R.ready_repo_foreign, params: named(R.ready_repo_foreign) },
  // Без ORDER BY: сравниваются множества строк (см. поле unordered).
  { q: R.ready_candidates, params: named(R.ready_candidates), label: "repo=myc", unordered: true },
  { q: R.ready_candidates, params: named(R.ready_candidates, { repo: "" }), label: "repo=любой", unordered: true },
  { q: R.ready_expired_candidates, params: named(R.ready_expired_candidates), unordered: true },
  { q: R.ready_unblocks, params: [], unordered: true },
  { q: R.ready_anchor_states, params: [], unordered: true },
  { q: R.ready_top_blocker, params: [] },
  { q: primeQueries.prime_node_count, params: named(primeQueries.prime_node_count) },
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

  const sorted = (rows: unknown[]): unknown[] =>
    [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  for (const c of [...CASES, ...READY_CASES]) {
    const title = c.label === undefined ? c.q.name : `${c.q.name} (${c.label})`;
    test(`${title}: SQLite и Postgres отвечают одинаково`, async () => {
      if (skip !== null) return void console.log(`[skip] ${skip}`);
      const order = (rows: unknown[]): unknown[] => (c.unordered === true ? sorted(rows) : rows);
      const fromLite = order(normalize(lite!.all(c.q, c.params)));
      const fromPg = order(normalize(await pg!.withTenant(TENANT, async (tx) => tx.all(c.q, c.params))));
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
      // ПУСТОЕ РАВНО ПУСТОМУ — НЕ ПАРИТЕТ. Случай, не вернувший ни строки,
      // проверяет только то, что обе базы согласны молчать; такой посев ловится
      // здесь, а не через год, когда запрос поменяют и никто не заметит.
      expect(fromLite.length).toBeGreaterThan(0);
    });
  }
});
