/**
 * Админка сервера на живой базе (M4). Проверяется не вёрстка, а три вещи, из-за
 * которых она вообще написана:
 *
 *  - числа арендатора считаются ПОД ЕГО арендатором, то есть через ту же RLS,
 *    что обслуживает боевой запрос: чужие строки в его счётчики не попадают;
 *  - отсутствие изоляции названо вслух (И2). Подключение суперпользователем
 *    даёт `degraded.rls_bypassed` — потому что RLS на него не действует вовсе,
 *    и молча показать зелёную страницу было бы ложью;
 *  - без Postgres маршрут отвечает причиной, а не пустотой.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { adminOverview, adminTenants, renderAdminPage } from "./admin.ts";
import { addToken } from "./auth.ts";
import { startHttpServer } from "./index.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");

let admin: SQL | undefined;
let app: PostgresDriver | undefined;
let appUrl = "";
/** Админка закрыта наравне со всем остальным — см. auth.pg.test.ts. */
let token = "";

const node = (id: string, scope: string, status: string, kind = "task"): string =>
  `INSERT INTO nodes (id, kind, scope, title, content_hash, status, created_at, updated_at)
   VALUES ('${id}','${kind}','${scope}','${id}','h-${id}','${status}',10,20)`;

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  admin = new SQL(URL_ENV);
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  await admin.unsafe(
    `INSERT INTO tenants (id, title, created_at) VALUES ('acme','Acme Corp',1000), ('globex','',2000)`,
  );
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  appUrl = u.toString();
  app = openPostgres(appUrl);

  await app.withTenant("acme", async (tx) => {
    await tx.raw(node("cherry-1", "cherry", "open"));
    await tx.raw(node("cherry-2", "cherry", "closed"));
    await tx.raw(node("portal-1", "portal", "open"));
  });
  await app.withTenant("globex", async (tx) => {
    // ТОТ ЖЕ слаг проекта и ТЕ ЖЕ id: если счёт идёт мимо изоляции, числа
    // acme вырастут вдвое, и тест это увидит.
    await tx.raw(node("cherry-1", "cherry", "open"));
    await tx.raw(node("cherry-2", "cherry", "open"));
  });
  token = (await addToken(app, "acme", "dev-admin")).token;
});

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

describe("админка сервера", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  test("числа арендатора — только его: одинаковые слаги и id не смешиваются", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const tenants = await adminTenants(app!);
    expect(tenants.map((t) => t.id)).toEqual(["acme", "globex"]);

    const acme = tenants[0]!;
    expect(acme.title).toBe("Acme Corp");
    expect(acme.nodes).toBe(3);
    expect(acme.projects.map((p) => [p.scope, p.nodes, p.open_tasks])).toEqual([
      ["cherry", 2, 1],
      ["portal", 1, 1],
    ]);

    const globex = tenants[1]!;
    expect(globex.nodes).toBe(2);
    expect(globex.projects.map((p) => [p.scope, p.nodes, p.open_tasks])).toEqual([["cherry", 2, 2]]);
  });

  test("под боевой ролью изоляция в силе, и страница про это молчит", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const o = await adminOverview(app!);
    expect(o.role).toBe("myc_app");
    expect(o.superuser).toBe(false);
    expect(o.bypass_rls).toBe(false);
    expect(o.warn.map((w) => w.code)).toEqual([]);
    // Покрытие политиками — то же число, что у смока схемы: политика на каждой
    // таблице с арендатором, и у каждой из них FORCE.
    expect(o.rls.with_policy).toBeGreaterThanOrEqual(20);
    expect(o.rls.forced).toBe(o.rls.with_policy);
    expect(o.pgvector).not.toBeNull();
  });

  test("подключение суперпользователем — деградация названа, а не скрыта", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const su = openPostgres(URL_ENV!);
    try {
      const o = await adminOverview(su);
      expect(o.superuser).toBe(true);
      expect(o.warn.map((w) => w.code)).toContain("degraded.rls_bypassed");
      // И на странице это первое, что видно.
      const html = renderAdminPage(o, []);
      expect(html).toContain("degraded.rls_bypassed");
      expect(html.indexOf("degraded.rls_bypassed")).toBeLessThan(html.indexOf("no tenants"));
    } finally {
      await su.close();
    }
  });

  test("страница отдаётся целиком, без единого внешнего запроса", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const [o, tenants] = await Promise.all([adminOverview(app!), adminTenants(app!)]);
    const html = renderAdminPage(o, tenants);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Acme Corp");
    expect(html).toContain("portal");
    // Ни одной внешней ссылки: ни скриптов, ни стилей, ни шрифтов.
    expect(html).not.toMatch(/src="https?:|href="https?:|@import/);
  });

  test("HTTP: /v1/admin отдаёт страницу, JSON-маршруты — числа", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const srv = startHttpServer({ port: 0, db: join(import.meta.dir, "no-such.db"), pg: appUrl });
    // Каждый заход с токеном: сервер закрыт по умолчанию, и этот файл проверяет
    // ЧИСЛА админки, а не доступ к ней.
    const auth = { headers: { authorization: `Bearer ${token}` } };
    try {
      const page = await fetch(`${srv.url}/v1/admin`, auth);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("Acme Corp");

      const tenants = (await (await fetch(`${srv.url}/v1/admin/tenants`, auth)).json()) as {
        ok: boolean;
        tenants: Array<{ id: string; nodes: number }>;
      };
      expect(tenants.ok).toBe(true);
      expect(tenants.tenants.map((t) => [t.id, t.nodes])).toEqual([
        ["acme", 3],
        ["globex", 2],
      ]);

      const overview = (await (await fetch(`${srv.url}/v1/admin/overview`, auth)).json()) as {
        ok: boolean;
        role: string;
        degraded: string[];
      };
      expect(overview.ok).toBe(true);
      expect(overview.role).toBe("myc_app");
      expect(overview.degraded).toEqual([]);
    } finally {
      srv.stop();
    }
  });

  test("без Postgres маршрут называет причину, а не отдаёт пустую страницу", async () => {
    const srv = startHttpServer({ port: 0, db: join(import.meta.dir, "no-such.db") });
    try {
      const res = await fetch(`${srv.url}/v1/admin`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; msg: string } };
      expect(body.error.code).toBe("precond.no_pg");
      expect(body.error.msg).toContain("--pg");
    } finally {
      srv.stop();
    }
  });
});
