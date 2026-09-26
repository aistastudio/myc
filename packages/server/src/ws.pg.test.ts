/**
 * ПРИЁМКА memory-bjy6fq9kxj47: «два воркспейса в одном процессе не видят
 * данных друг друга».
 *
 * Границ здесь ДВЕ, и они разного происхождения, поэтому проверяются обе:
 *
 *  - арендатор закрыт RLS — это гарантия БАЗЫ, приложение её не обходит;
 *  - воркспейс закрыт `scope = ?` в каждом запросе — это гарантия КОДА, и
 *    забыть её легко.
 *
 * Посев устроен так, чтобы забытый фильтр было видно сразу: у двух
 * АРЕНДАТОРОВ одинаковые идентификаторы узлов и разные заголовки, а внутри
 * арендатора воркспейсы держат разные узлы. Пропал фильтр — тест получит
 * чужой заголовок или лишнюю строку, а не «вроде бы то же самое».
 *
 * Одинаковых id в двух воркспейсах ОДНОГО арендатора не бывает by design:
 * первичный ключ — (tenant_id, id), а id в myc и так несёт слаг проекта
 * (`cherry-0001`). Это свойство тоже проверяется ниже, а не принимается на
 * веру: схема должна отказать, а не завести второй узел.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { addToken } from "./auth.ts";
import { startHttpServer, type MycHttpServer } from "./index.ts";
import { boundedInt, parseWsPath, WS_LIMIT_MAX } from "./ws.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let srv: MycHttpServer | undefined;
let acme = "";
let globex = "";

/** Узел с одним и тем же id в разных воркспейсах и у разных арендаторов. */
const node = (id: string, scope: string, title: string, kind = "task", status = "open"): string =>
  `INSERT INTO nodes (id, kind, layer, scope, title, excerpt, content_hash, status, priority, created_at, updated_at)
   VALUES ('${id}','${kind}',1,'${scope}','${title}','срез ${id}','h-${scope}-${id}','${status}',2,10,20)`;

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  admin = new SQL(URL_ENV);
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  await admin.unsafe("INSERT INTO tenants (id, title, created_at) VALUES ('acme','Acme',1000), ('globex','',1000)");

  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  pg = openPostgres(u.toString());

  await pg.withTenant("acme", async (tx) => {
    await tx.raw(node("cherry-1", "cherry", "acme cherry первая"));
    await tx.raw(node("cherry-2", "cherry", "acme cherry вторая", "task", "closed"));
    await tx.raw(node("portal-1", "portal", "acme portal первая"));
    await tx.raw(node("portal-2", "portal", "acme portal заметка", "note", "active"));
    // Ребро МЕЖДУ воркспейсами: в выдаче узла оно появляться не должно.
    await tx.raw(
      `INSERT INTO edges (src, type, dst, add_tag, created_at)
       VALUES ('cherry-1','relates','portal-2','t',30)`,
    );
    await tx.raw(
      `INSERT INTO edges (src, type, dst, add_tag, created_at)
       VALUES ('cherry-1','blocks','cherry-2','t',31)`,
    );
  });
  // ТЕ ЖЕ id у другого арендатора — так видно, что изоляцию держит RLS, а не
  // случайная несовпадаемость идентификаторов.
  await pg.withTenant("globex", async (tx) => {
    await tx.raw(node("cherry-1", "cherry", "ГЛОБЕКС cherry первая"));
    await tx.raw(node("cherry-9", "cherry", "ГЛОБЕКС только своя"));
  });

  acme = (await addToken(pg, "acme", "dev-anna")).token;
  globex = (await addToken(pg, "globex", "dev-boris")).token;
  srv = startHttpServer({ port: 0, db: join(import.meta.dir, "no-such.db"), pg: u.toString() });
});

afterAll(async () => {
  srv?.stop();
  await pg?.close();
  await admin?.close();
});

describe("данные воркспейса по HTTP", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  const get = async (path: string, token: string): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${srv!.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };

  test("разбор пути и потолок limit — до всякой базы", () => {
    expect(parseWsPath("/v1/ws/cherry/nodes")).toEqual({ ws: "cherry", rest: "/nodes" });
    expect(parseWsPath("/v1/ws/cherry")).toEqual({ ws: "cherry", rest: "" });
    expect(parseWsPath("/v1/admin")).toBeNull();
    // Чужой ?limit=1e9 не должен уносить процесс: потолок стоит до запроса.
    expect(boundedInt("1000000", 50, WS_LIMIT_MAX)).toBe(WS_LIMIT_MAX);
    expect(boundedInt(null, 50, WS_LIMIT_MAX)).toBe(50);
    expect(boundedInt("-3", 50, WS_LIMIT_MAX)).toBe(50);
  });

  test("список узлов: только свой воркспейс, и заголовки свои", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const { status, body } = await get("/v1/ws/cherry/nodes", acme);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ws).toBe("cherry");
    const titles = body.data.map((n: { title: string }) => n.title).sort();
    expect(titles).toEqual(["acme cherry вторая", "acme cherry первая"]);
    expect(body.meta.total).toBe(2);
  });

  test("каждый воркспейс отдаёт свой узел, и id арендатора уникален поверх них", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const cherry = await get("/v1/ws/cherry/nodes/cherry-1", acme);
    const portal = await get("/v1/ws/portal/nodes/portal-1", acme);
    expect(cherry.body.data.title).toBe("acme cherry первая");
    expect(portal.body.data.title).toBe("acme portal первая");

    // И то, на чём это держится: тот же id во втором воркспейсе одного
    // арендатора схема НЕ примет (PK (tenant_id, id)). Иначе «узел по id»
    // был бы неоднозначен, а изоляция воркспейсов — вопросом везения.
    await expect(
      pg!.withTenant("acme", async (tx) => {
        await tx.raw(node("cherry-1", "portal", "подмена"));
      }),
    ).rejects.toThrow();
  });

  test("чужой воркспейс отвечает как несуществующий узел, а не «нельзя»", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // portal-2 живёт в portal; из cherry он обязан быть неотличим от выдуманного.
    const foreign = await get("/v1/ws/cherry/nodes/portal-2", acme);
    const invented = await get("/v1/ws/cherry/nodes/нет-такого", acme);
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(foreign.body.error.code).toBe(invented.body.error.code);
  });

  test("рёбра не пересекают границу воркспейса", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const { body } = await get("/v1/ws/cherry/nodes/cherry-1", acme);
    const kinds = body.data.edges.map((e: { type: string; dst: string }) => `${e.type}→${e.dst}`);
    // blocks→cherry-2 свой, relates→portal-2 уходит в portal и показан быть не должен.
    expect(kinds).toEqual(["blocks→cherry-2"]);
  });

  test("два арендатора: один воркспейс, одни id, разные данные", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const mine = await get("/v1/ws/cherry/nodes", acme);
    const theirs = await get("/v1/ws/cherry/nodes", globex);
    expect(mine.body.data.map((n: { title: string }) => n.title).sort()).toEqual([
      "acme cherry вторая",
      "acme cherry первая",
    ]);
    expect(theirs.body.data.map((n: { title: string }) => n.title).sort()).toEqual([
      "ГЛОБЕКС cherry первая",
      "ГЛОБЕКС только своя",
    ]);
    const one = await get("/v1/ws/cherry/nodes/cherry-1", globex);
    expect(one.body.data.title).toBe("ГЛОБЕКС cherry первая");
  });

  test("список воркспейсов — тоже под своим арендатором", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const mine = await get("/v1/ws", acme);
    const theirs = await get("/v1/ws", globex);
    expect(mine.body.data.map((w: { ws: string; nodes: number }) => [w.ws, w.nodes])).toEqual([
      ["cherry", 2],
      ["portal", 2],
    ]);
    expect(theirs.body.data.map((w: { ws: string }) => w.ws)).toEqual(["cherry"]);
  });

  test("фильтры и потолок выдачи работают на живой базе", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const open = await get("/v1/ws/cherry/nodes?status=open", acme);
    expect(open.body.data.map((n: { id: string }) => n.id)).toEqual(["cherry-1"]);
    const capped = await get("/v1/ws/cherry/nodes?limit=1000000", acme);
    expect(capped.body.meta.limit).toBe(WS_LIMIT_MAX);
    const page = await get("/v1/ws/cherry/nodes?limit=1&offset=1", acme);
    expect(page.body.data.length).toBe(1);
    expect(page.body.meta.total).toBe(2);
  });

  test("без токена данные воркспейса закрыты так же, как всё остальное", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const res = await fetch(`${srv!.url}/v1/ws/cherry/nodes`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("denied.no_token");
  });

  test("запись отвечает причиной, а не «GET only»", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const res = await fetch(`${srv!.url}/v1/ws/cherry/nodes`, {
      method: "POST",
      headers: { authorization: `Bearer ${acme}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "task", title: "новая" }),
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string; msg: string } };
    expect(body.error.code).toBe("unimpl.write");
    expect(body.error.msg).toContain("read-only");
  });
});
