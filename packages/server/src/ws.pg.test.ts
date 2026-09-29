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

  const made200 = (r: { status: number; body: any }): boolean => r.status === 200 && r.body.error === undefined;

  const post = async (path: string, token: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${srv!.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test("создание узла: он появляется в СВОЁМ воркспейсе и больше нигде", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const made = await post("/v1/ws/cherry/nodes", acme, {
      kind: "task",
      title: "через сервер",
      priority: 1,
      attrs: { repo: "myc" },
    });
    expect(made.status).toBe(200);
    expect(made.body.ok).toBe(true);
    expect(made.body.data.title).toBe("через сервер");
    expect(made.body.data.scope).toBe("cherry");
    expect(made.body.meta.applied).toBeGreaterThan(0);
    const id = made.body.data.id as string;
    // Идентификатор несёт слаг воркспейса — как у всех узлов myc.
    expect(id.startsWith("cherry-")).toBe(true);

    // Виден в своём воркспейсе...
    const own = await get(`/v1/ws/cherry/nodes/${id}`, acme);
    expect(own.status).toBe(200);
    expect(own.body.data.attrs).toEqual({ repo: "myc" });
    // ...и не виден ни в соседнем, ни у соседа по серверу.
    expect((await get(`/v1/ws/portal/nodes/${id}`, acme)).status).toBe(404);
    expect((await get(`/v1/ws/cherry/nodes/${id}`, globex)).status).toBe(404);
  });

  test("запись прошла ОПЛОГОМ, а не прямой вставкой", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const made = await post("/v1/ws/cherry/nodes", acme, { kind: "note", title: "с оплогом" });
    expect([made.status, made.body.error ?? null]).toEqual([200, null]);
    const id = made.body.data.id as string;
    // Узел, записанный мимо оплога, не доедет ни до одной реплики. Проверяем
    // именно это: строки операций и часы полей на месте.
    const rows = await pg!.withTenant("acme", async (tx) =>
      tx.raw<{ field: string }>("SELECT field FROM oplog WHERE entity_id = $1 ORDER BY field", [id]),
    );
    expect(rows.map((r) => r.field)).toEqual([
      "actor",
      "kind",
      "owner_id",
      "priority",
      "scope",
      "seen_count",
      "status",
      "title",
    ]);
    const clocks = await pg!.withTenant("acme", async (tx) =>
      tx.raw<{ n: string }>("SELECT count(*) AS n FROM field_clock WHERE entity_id = $1", [id]),
    );
    expect(Number(clocks[0]!.n)).toBeGreaterThan(0);
  });

  test("две записи подряд доезжают обе: op_id берутся от хвоста оплога", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // Это регрессия класса myc-4dy, и она была здесь живой: операции
    // минтились ДО транзакции, второй запрос выдавал те же op_id, весь пакет
    // журналировался как повтор — ответ 200, в базе ничего.
    const a = await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "подряд один" });
    const b = await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "подряд два" });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.id).not.toBe(b.body.data.id);
    for (const r of [a, b]) {
      expect([r.body.data.title, r.body.meta.applied > 0]).toEqual([r.body.data.title, true]);
      const back = await get(`/v1/ws/cherry/nodes/${r.body.data.id}`, acme);
      expect([r.body.data.title, back.status]).toEqual([r.body.data.title, 200]);
      expect(back.body.data.title).toBe(r.body.data.title);
    }
  });

  const patch = async (path: string, token: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${srv!.url}${path}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test("правка узла: меняется названное, остальное на месте", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const made = await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "до правки" });
    const id = made.body.data.id as string;

    const done = await patch(`/v1/ws/cherry/nodes/${id}`, acme, {
      title: "после правки",
      priority: 0,
      attrs: { repo: "myc" },
    });
    expect(done.status).toBe(200);
    expect(done.body.data.title).toBe("после правки");
    expect(done.body.data.priority).toBe(0);
    expect(done.body.data.attrs).toEqual({ repo: "myc" });
    expect(done.body.meta.changed.sort()).toEqual(["attrs.repo", "priority", "title"]);
    // Вид узла правкой не меняется и не теряется.
    expect(done.body.data.kind).toBe("task");
  });

  test("правка идёт оплогом: у изменённого поля новые часы", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const made = await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "часы" });
    const id = made.body.data.id as string;
    const before = await pg!.withTenant("acme", async (tx) =>
      tx.raw<{ hlc: string }>("SELECT hlc FROM field_clock WHERE entity_id = $1 AND field = 'title'", [id]),
    );
    await patch(`/v1/ws/cherry/nodes/${id}`, acme, { title: "часы сдвинулись" });
    const after = await pg!.withTenant("acme", async (tx) =>
      tx.raw<{ hlc: string }>("SELECT hlc FROM field_clock WHERE entity_id = $1 AND field = 'title'", [id]),
    );
    expect(BigInt(after[0]!.hlc) > BigInt(before[0]!.hlc)).toBe(true);
    const ops = await pg!.withTenant("acme", async (tx) =>
      tx.raw<{ n: string }>("SELECT count(*) AS n FROM oplog WHERE entity_id = $1 AND field = 'title'", [id]),
    );
    expect(Number(ops[0]!.n)).toBe(2);
  });

  test("правка чужого воркспейса неотличима от несуществующего узла", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const foreign = await patch("/v1/ws/cherry/nodes/portal-2", acme, { title: "нельзя" });
    const invented = await patch("/v1/ws/cherry/nodes/нет-такого", acme, { title: "нельзя" });
    expect([foreign.status, invented.status]).toEqual([404, 404]);
    expect(foreign.body.error.code).toBe(invented.body.error.code);
    // И у соседа по серверу — тоже: id тот же, арендатор другой.
    expect((await patch("/v1/ws/cherry/nodes/cherry-2", globex, { title: "нельзя" })).status).toBe(404);
  });

  test("правка неизменяемого и пустая правка отвергаются по-разному", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    for (const [body, code] of [
      [{ kind: "note" }, "usage.field"],
      [{ scope: "portal" }, "usage.field"],
      [{}, "usage.empty"],
      [{ priority: 7 }, "usage.priority"],
      [{ title: "  " }, "usage.title"],
    ] as const) {
      const res = await patch("/v1/ws/cherry/nodes/cherry-1", acme, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect(res.body.error.code).toBe(code);
    }
  });

  const send = async (
    method: "POST" | "DELETE",
    path: string,
    token: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${srv!.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test("ребро: добавляется, видно у узла, удаляется", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const a = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "ребро А" })).body.data
      .id as string;
    const b = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "ребро Б" })).body.data
      .id as string;

    const made = await send("POST", "/v1/ws/cherry/edges", acme, { from: a, type: "blocks", to: b });
    expect(made.status).toBe(200);
    const node = await get(`/v1/ws/cherry/nodes/${a}`, acme);
    expect(node.body.data.edges.map((e: { type: string; dst: string }) => `${e.type}→${e.dst}`)).toEqual([
      `blocks→${b}`,
    ]);

    const gone = await send("DELETE", "/v1/ws/cherry/edges", acme, { from: a, type: "blocks", to: b });
    expect(gone.status).toBe(200);
    expect(gone.body.data.removed).toBe(true);
    const after = await get(`/v1/ws/cherry/nodes/${a}`, acme);
    expect(after.body.data.edges).toEqual([]);
  });

  test("цикл blocks отвергается с причиной, а не «ошибкой базы»", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const a = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "цикл А" })).body.data
      .id as string;
    const b = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "цикл Б" })).body.data
      .id as string;
    expect((await send("POST", "/v1/ws/cherry/edges", acme, { from: a, type: "blocks", to: b })).status).toBe(200);

    const loop = await send("POST", "/v1/ws/cherry/edges", acme, { from: b, type: "blocks", to: a });
    expect(loop.status).toBe(409);
    expect(loop.body.error.code).toBe("precond.cycle");
    // В сообщении — ПУТЬ, а не факт кольца: иначе непонятно, какое звено лишнее.
    expect(loop.body.error.msg).toContain(a);
    expect(loop.body.error.msg).toContain(b);
  });

  test("parent через сервер ведёт замыкание, а не только строку ребра", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // Эпик в myc — это `attrs.type`, а не вид узла: вид остаётся task.
    const parent = (
      await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "эпик", attrs: { type: "epic" } })
    ).body.data.id as string;
    const child = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "в эпике" })).body.data
      .id as string;
    const put = await send("POST", "/v1/ws/cherry/edges", acme, { from: child, type: "parent", to: parent });
    expect([put.status, put.body.error ?? null]).toEqual([200, null]);
    // Замыкание — то, чем живут наследование и запрос «чей это потомок».
    const closure = await pg!.withTenant("acme", async (tx) =>
      tx.raw<{ ancestor: string; depth: string }>(
        "SELECT ancestor, depth FROM parent_closure WHERE descendant = $1 ORDER BY depth",
        [child],
      ),
    );
    expect(closure.map((r) => [r.ancestor, Number(r.depth)])).toEqual([[parent, 1]]);
  });

  test("ребро за границу воркспейса не заводится", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const own = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "свой" })).body.data
      .id as string;
    const foreign = await send("POST", "/v1/ws/cherry/edges", acme, {
      from: own,
      type: "relates",
      to: "portal-1",
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("notfound.node");
  });

  test("негодное ребро отвергается до базы", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    for (const [body, code] of [
      [{ from: "cherry-1", type: "blocks" }, "usage.endpoints"],
      [{ from: "cherry-1", type: "blocks", to: "cherry-1" }, "usage.endpoints"],
      [{ from: "cherry-1", type: "выдумка", to: "cherry-2" }, "usage.type"],
    ] as const) {
      const res = await send("POST", "/v1/ws/cherry/edges", acme, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect(res.body.error.code).toBe(code);
    }
  });

  test("взятие задачи: первый получает аренду, второй — отказ с причиной", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const id = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "кто успел" })).body.data
      .id as string;

    const first = await post(`/v1/ws/cherry/ready/claim`, acme, { id, lease_minutes: 5 });
    expect([first.status, first.body.error ?? null]).toEqual([200, null]);
    expect(first.body.data.holder).toBe("dev-anna");
    expect(first.body.data.expiresAt).toBeGreaterThan(Date.now());

    // Второй приходит к уже взятой задаче — и узнаёт об этом кодом, а не пустотой.
    const second = await post(`/v1/ws/cherry/ready/claim`, acme, { id });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict.claimed");

    // Держатель виден в самом узле.
    const node = await get(`/v1/ws/cherry/nodes/${id}`, acme);
    expect(node.body.data.status).toBe("in_progress");
  });

  test("держателем становится владелец токена, а не то, что прислали", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const id = (await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "чужое имя" })).body.data
      .id as string;
    const taken = await post(`/v1/ws/cherry/ready/claim`, acme, { id, holder: "не-я" });
    expect(taken.status).toBe(200);
    expect(taken.body.data.holder).toBe("dev-anna");
  });

  test("взятие чужой задачи и негодная аренда отвечают по-разному", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    expect((await post("/v1/ws/cherry/ready/claim", acme, { id: "portal-1" })).status).toBe(404);
    expect((await post("/v1/ws/cherry/ready/claim", acme, {})).status).toBe(400);
    const tooLong = await post("/v1/ws/cherry/ready/claim", acme, { id: "cherry-1", lease_minutes: 10_000 });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("usage.lease");
  });

  test("дайджест сервера: проектное знание в CORE, чужое сессионное — нет", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    await pg!.withTenant("acme", async (tx) => {
      await tx.raw(
        `INSERT INTO nodes (id, kind, layer, scope, title, excerpt, content_hash, status, priority, attrs, salience, created_at, updated_at)
         VALUES ('cherry-core','note',3,'cherry','правило','суть правила','h-core','active',2,'{"reach":"project"}',9.0,1,1)`,
      );
      await tx.raw(
        `INSERT INTO nodes (id, kind, layer, scope, title, excerpt, content_hash, status, priority, attrs, salience, created_at, updated_at)
         VALUES ('cherry-mine','note',3,'cherry','моё','суть моего','h-mine','active',2,'{"reach":"session","session_id":"sess-1"}',8.0,1,1)`,
      );
      await tx.raw(
        `INSERT INTO nodes (id, kind, layer, scope, title, excerpt, content_hash, status, priority, attrs, salience, created_at, updated_at)
         VALUES ('cherry-alien','note',3,'cherry','чужое','суть чужого','h-alien','active',2,'{"reach":"session","session_id":"sess-9"}',7.0,1,1)`,
      );
    });

    const mine = await get("/v1/ws/cherry/prime?session=sess-1", acme);
    expect(mine.status).toBe(200);
    const core = mine.body.data.digest.core.map((i: { id: string }) => i.id);
    expect(core).toContain("cherry-core");
    expect(core).toContain("cherry-mine");
    // Чужое сессионное в контекст не попадает — и названо числом (И2).
    expect(core).not.toContain("cherry-alien");
    expect(mine.body.data.digest.reach.hidden).toBeGreaterThan(0);

    // Без сессии видно только проектное, а скрытого становится больше.
    const anon = await get("/v1/ws/cherry/prime", acme);
    const anonCore = anon.body.data.digest.core.map((i: { id: string }) => i.id);
    expect(anonCore).toContain("cherry-core");
    expect(anonCore).not.toContain("cherry-mine");
    expect(anon.body.data.digest.reach.hidden).toBeGreaterThan(mine.body.data.digest.reach.hidden);
  });

  test("приватный узел соседа не виден: ни в списке, ни в числе, ни по id", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const boris = (await addToken(pg!, "acme", "dev-boris")).token;

    // Аня заводит приватную заметку.
    const mine = await post("/v1/ws/cherry/nodes", acme, {
      kind: "note",
      title: "моё приватное",
      acl: "private",
    });
    expect(made200(mine)).toBe(true);
    const id = mine.body.data.id as string;

    // Себе она видна.
    expect((await get(`/v1/ws/cherry/nodes/${id}`, acme)).status).toBe(200);

    // Борису — нет, и ТЕМ ЖЕ отказом, что у несуществующего узла.
    const foreign = await get(`/v1/ws/cherry/nodes/${id}`, boris);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("notfound.node");

    // Ни в списке...
    const listed = await get("/v1/ws/cherry/nodes?limit=500", boris);
    expect((listed.body.data as Array<{ id: string }>).map((n) => n.id)).not.toContain(id);

    // ...НИ В ЧИСЛЕ: «всего 12» при одиннадцати видимых — та же утечка,
    // только в одну цифру (приёмка memory-w0r3vhgkxmsw).
    const mineList = await get("/v1/ws/cherry/nodes?limit=500", acme);
    expect(listed.body.meta.total).toBeLessThan(mineList.body.meta.total);
    expect(listed.body.meta.total).toBe((listed.body.data as unknown[]).length);
  });

  test("узел команды виден обоим, приватный — только своему", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const boris = (await addToken(pg!, "acme", "dev-boris")).token;
    const shared = await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "общее дело" });
    const secret = await post("/v1/ws/cherry/nodes", acme, {
      kind: "task",
      title: "только моё",
      acl: "private",
    });
    const sharedId = shared.body.data.id as string;
    const secretId = secret.body.data.id as string;

    const seen = (await get("/v1/ws/cherry/nodes?limit=500", boris)).body.data as Array<{ id: string }>;
    const ids = seen.map((n) => n.id);
    expect(ids).toContain(sharedId);
    expect(ids).not.toContain(secretId);
  });

  test("приватное не попадает ни в очередь, ни в контекст соседа", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const boris = (await addToken(pg!, "acme", "dev-boris")).token;
    // Приватная ЗАДАЧА высшего приоритета: в чужой очереди её быть не должно
    // ни строкой, ни местом в top-k.
    const task = await post("/v1/ws/cherry/nodes", acme, {
      kind: "task",
      title: "срочное и приватное",
      priority: 0,
      acl: "private",
    });
    const taskId = task.body.data.id as string;
    // Приватное ЗНАНИЕ: в чужой контекст оно не поедет.
    await pg!.withTenant("acme", async (tx) => {
      await tx.raw(
        `INSERT INTO nodes (id, kind, layer, scope, title, excerpt, content_hash, status, priority,
                            attrs, acl, owner_id, salience, created_at, updated_at)
         VALUES ('cherry-secret','note',3,'cherry','секрет','суть секрета','h-secret','active',2,
                 '{"reach":"project"}','private','dev-anna',9.5,1,1)`,
      );
    });

    const mineQueue = await get("/v1/ws/cherry/ready?n=50", acme);
    expect((mineQueue.body.data as Array<{ id: string }>).map((r) => r.id)).toContain(taskId);

    const theirQueue = await get("/v1/ws/cherry/ready?n=50", boris);
    const theirIds = (theirQueue.body.data as Array<{ id: string }>).map((r) => r.id);
    expect(theirIds).not.toContain(taskId);
    // И число готовых у соседа меньше — иначе утечка одной цифрой.
    expect(theirQueue.body.meta.total).toBeLessThan(mineQueue.body.meta.total);

    const mineCtx = await get("/v1/ws/cherry/prime", acme);
    const theirCtx = await get("/v1/ws/cherry/prime", boris);
    const coreOf = (r: { body: any }): string[] =>
      r.body.data.digest.core.map((i: { id: string }) => i.id);
    expect(coreOf(mineCtx)).toContain("cherry-secret");
    expect(coreOf(theirCtx)).not.toContain("cherry-secret");
  });

  test("негодный уровень доступа отвергается до базы", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const bad = await post("/v1/ws/cherry/nodes", acme, { kind: "task", title: "х", acl: "секретно" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("usage.acl");
  });

  test("негодный вход отвергается ДО базы и говорит, что не так", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    for (const [body, code] of [
      [{ kind: "task", title: "   " }, "usage.title"],
      [{ kind: "выдумка", title: "есть" }, "usage.kind"],
      [{ kind: "task", title: "есть", priority: 9 }, "usage.priority"],
    ] as const) {
      const res = await post("/v1/ws/cherry/nodes", acme, body);
      expect([code, res.status]).toEqual([code, 400]);
      expect(res.body.error.code).toBe(code);
    }
  });

  test("неподдержанный метод называет себя, а не «GET only»", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const res = await fetch(`${srv!.url}/v1/ws/cherry/nodes/cherry-1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${acme}` },
    });
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: { msg: string } }).error.msg).toContain("DELETE");
  });
});
