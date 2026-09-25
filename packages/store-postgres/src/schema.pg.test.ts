/**
 * СХЕМА POSTGRES НА ЖИВОЙ БАЗЕ (M4, memory-2xgh8mg2fs24).
 *
 * `db/schema.postgres.sql` — рукописный DDL второго диалекта (§8.2), и
 * проверять его чтением бессмысленно: он либо применяется к настоящему
 * Postgres с pgvector и делает обещанное, либо нет. Этот тест применяет его
 * целиком и проверяет ровно то, ради чего он такой, а не иначе:
 *
 *  - изоляция арендаторов при СОВПАДАЮЩИХ слаге проекта и id узла — ради неё
 *    tenant_id ведущая колонка каждого ключа (решение memory-khj49brcr0q7);
 *  - сессия без арендатора не видит ничего и не пишет ничего (fail closed);
 *  - полнотекст (tsvector вместо FTS5) и косинусный поиск (halfvec + HNSW
 *    вместо vec0) работают на тех же данных;
 *  - триггеры счётчика блокеров ведут себя как в SQLite;
 *  - якорь без git-идентичности отвергается (решение memory-6fv6xbbfcb9g);
 *  - внешний ключ несёт арендатора: ребро на чужой узел невозможно.
 *
 * ПОЧЕМУ ПОД ОТДЕЛЬНОЙ РОЛЬЮ. Суперпользователь Postgres RLS не соблюдает
 * вовсе — ни ENABLE, ни FORCE на него не действуют. Первый прогон этого
 * смока шёл под `postgres` и «доказал» изоляцию, которой не было; поэтому
 * тест заводит боевую роль `myc_app` и работает под ней, как сервер.
 *
 * БЕЗ БАЗЫ ТЕСТ ГОВОРИТ ОБ ЭТОМ ВСЛУХ и не падает: Postgres есть не на всякой
 * машине. Поднять локально:
 *
 *   docker run -d --name myc-pg -e POSTGRES_PASSWORD=myc -e POSTGRES_DB=myc \
 *     -p 55432:5432 pgvector/pgvector:pg17
 *   MYC_PG_URL=postgres://postgres:myc@127.0.0.1:55432/myc bun test packages/store-postgres
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
/** Вектор нужной длины литералом halfvec: `[0.01,0.01,…]`. */
const VEC = `[${Array.from({ length: 384 }, () => "0.01").join(",")}]`;

let admin: SQL | undefined;
let app: SQL | undefined;

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  admin = new SQL(URL_ENV);
  // Чистая схема на каждый прогон: DDL обязан применяться с нуля, а не
  // «поверх того, что осталось с прошлого раза».
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  app = new SQL(u.toString());
});

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

/** Один запрос под ролью приложения с назначенным арендатором. */
async function as<T = unknown>(tenant: string | null, sqlText: string): Promise<T[]> {
  const db = app!;
  await db.unsafe(tenant === null ? "RESET myc.tenant" : `SET myc.tenant = '${tenant}'`);
  return (await db.unsafe(sqlText)) as T[];
}

const NODE = (id: string, title: string, body = "", hash = ""): string =>
  `INSERT INTO nodes (id, kind, scope, title, body, content_hash, created_at, updated_at)
   VALUES ('${id}','note','cherry','${title}','${body}','${hash === "" ? `h-${title}` : hash}',1,1)`;

describe("схема Postgres на живой базе", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят (см. докстроку)" : null;

  test("DDL применяется целиком: таблицы, индексы, триггеры, политики", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const tables = (await admin!.unsafe(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    )) as Array<{ n: number }>;
    const policies = (await admin!.unsafe(
      "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'",
    )) as Array<{ n: number }>;
    // 23 логические таблицы SQLite минус теневые FTS5, плюс два журнала учёта.
    expect(tables[0]!.n).toBeGreaterThanOrEqual(20);
    // Политика на каждой таблице с арендатором.
    expect(policies[0]!.n).toBeGreaterThanOrEqual(20);
    const forced = (await admin!.unsafe(
      "SELECT count(*)::int AS n FROM pg_class WHERE relrowsecurity AND relforcerowsecurity",
    )) as Array<{ n: number }>;
    expect(forced[0]!.n).toBe(policies[0]!.n);
  });

  test("два арендатора с ОДИНАКОВЫМИ слагом, id и содержимым не видят друг друга", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // Совпадает ВСЁ, чем узел опознаётся: слаг проекта, id и content_hash.
    // Так проверяется и политика, и то, что арендатор стоит ведущей колонкой
    // в ux_nodes_content: без него вторая вставка упёрлась бы в чужую строку.
    await as("acme", NODE("cherry-0001", "заметка", "очередь ретраев падает", "same-hash"));
    await as("globex", NODE("cherry-0001", "заметка", "очередь ретраев падает", "same-hash"));

    const acme = await as<{ id: string }>("acme", "SELECT id FROM nodes");
    const globex = await as<{ id: string }>("globex", "SELECT id FROM nodes");
    expect(acme.map((r) => r.id)).toEqual(["cherry-0001"]);
    expect(globex.map((r) => r.id)).toEqual(["cherry-0001"]);
  });

  test("сессия без арендатора не видит ничего и не пишет ничего", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const rows = await as("acme", "SELECT 1 AS x FROM nodes");
    expect(rows.length).toBeGreaterThan(0); // база не пуста — значит проверка ниже про политику, а не про пустоту
    // RESET, а не «переменная не ставилась»: в пуле соединений это обычное
    // состояние, и current_setting отдаёт тогда ПУСТУЮ СТРОКУ, а не NULL —
    // из-за чего первая версия myc_tenant() пускала такую сессию как ''.
    expect(await as(null, "SELECT 1 AS x FROM nodes")).toEqual([]);
    await expect(as(null, NODE("cherry-9999", "нельзя"))).rejects.toThrow();
  });

  test("полнотекст и косинусный поиск работают на тех же данных", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const found = await as<{ id: string }>(
      "acme",
      "SELECT id FROM nodes WHERE tsv @@ plainto_tsquery('simple','ретраев')",
    );
    expect(found.map((r) => r.id)).toEqual(["cherry-0001"]);

    await as("acme", `UPDATE nodes SET embedding = '${VEC}'::halfvec(384) WHERE id = 'cherry-0001'`);
    const near = await as<{ id: string }>(
      "acme",
      `SELECT id FROM nodes WHERE embedding IS NOT NULL ORDER BY embedding <=> '${VEC}'::halfvec(384) LIMIT 5`,
    );
    expect(near.map((r) => r.id)).toEqual(["cherry-0001"]);
  });

  test("триггеры блокеров считают так же, как в SQLite", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    await as("acme", NODE("cherry-0002", "блокер"));
    await as("acme", NODE("cherry-0003", "заблокированная"));
    await as(
      "acme",
      "INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES ('cherry-0002','blocks','cherry-0003','t1',1)",
    );
    const blocked = await as<{ open_blockers: number }>(
      "acme",
      "SELECT open_blockers FROM nodes WHERE id = 'cherry-0003'",
    );
    expect(Number(blocked[0]!.open_blockers)).toBe(1);

    await as("acme", "UPDATE nodes SET status = 'closed' WHERE id = 'cherry-0002'");
    const freed = await as<{ open_blockers: number }>(
      "acme",
      "SELECT open_blockers FROM nodes WHERE id = 'cherry-0003'",
    );
    expect(Number(freed[0]!.open_blockers)).toBe(0);
  });

  test("якорь без git-идентичности сервер не принимает, с ней — принимает", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const anchor = (ref: string): string =>
      `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash, crux, crux_norm, bound_at, git_ref)
       VALUES ('cherry-0001','messaging-server','src/a.ts',1,5,'fh','sh','c','c',1,'${ref}')`;
    await expect(as("acme", anchor(""))).rejects.toThrow();
    await as("acme", anchor("blob:1a2b3c"));
    const rows = await as<{ git_ref: string }>("acme", "SELECT git_ref FROM anchors");
    expect(rows.map((r) => r.git_ref)).toEqual(["blob:1a2b3c"]);
  });

  test("внешний ключ несёт арендатора: ребро на чужой узел невозможно", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // У globex есть свой cherry-0001, но нет cherry-0002 — он у acme.
    await expect(
      as(
        "globex",
        "INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES ('cherry-0001','relates','cherry-0002','t2',1)",
      ),
    ).rejects.toThrow();
  });
});
