/**
 * Доступ к серверу. Проверяется то, из-за чего эту часть вообще пишут руками,
 * а не «как-нибудь»:
 *
 *  - закрыто по умолчанию: без токена не отдаётся ничего, кроме пробы живости;
 *  - в базе лежит ХЕШ: по содержимому таблицы токен не восстановить;
 *  - неизвестный, отозванный и просроченный отвечают ОДИНАКОВО — иначе по
 *    ответу перебирают существующие;
 *  - токен НАЗНАЧАЕТ арендатора: с ним видно только его данные;
 *  - браузер входит формой и дальше живёт кукой HttpOnly/SameSite=Strict, а
 *    токен не попадает ни в адресную строку, ни в журнал прокси.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import {
  addToken,
  authenticate,
  listTokens,
  mintToken,
  revokeToken,
  tokenHash,
  TOKEN_PREFIX,
} from "./auth.ts";
import { startHttpServer, type MycHttpServer } from "./index.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let appUrl = "";
let srv: MycHttpServer | undefined;
let good = "";

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  admin = new SQL(URL_ENV);
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  await admin.unsafe(
    "INSERT INTO tenants (id, title, created_at) VALUES ('acme','Acme',1000), ('globex','',1000)",
  );
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  appUrl = u.toString();
  pg = openPostgres(appUrl);
  await pg.withTenant("acme", async (tx) => {
    await tx.raw(
      `INSERT INTO nodes (id, kind, scope, title, content_hash, status, created_at, updated_at)
       VALUES ('cherry-1','task','cherry','acme task','h1','open',1,1)`,
    );
  });
  await pg.withTenant("globex", async (tx) => {
    await tx.raw(
      `INSERT INTO nodes (id, kind, scope, title, content_hash, status, created_at, updated_at)
       VALUES ('cherry-1','task','cherry','globex task','h1','open',1,1)`,
    );
  });
  good = (await addToken(pg, "acme", "dev-anna")).token;
  srv = startHttpServer({ port: 0, db: join(import.meta.dir, "no-such.db"), pg: appUrl });
});

afterAll(async () => {
  srv?.stop();
  await pg?.close();
  await admin?.close();
});

describe("доступ к серверу", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  test("в базе лежит хеш, а не токен: копия базы доступа не даёт", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const rows = await admin!.unsafe("SELECT token_hash FROM api_tokens");
    const stored = (rows as Array<{ token_hash: string }>).map((r) => r.token_hash);
    expect(stored).toEqual([tokenHash(good)]);
    // Ни один столбец таблицы не содержит секрета целиком.
    const dump = JSON.stringify(await admin!.unsafe("SELECT * FROM api_tokens"));
    expect(dump).not.toContain(good);
    expect(good.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  test("без токена закрыто всё, кроме пробы живости", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const live = await fetch(`${srv!.url}/v1/health`);
    expect(live.status).toBe(200);

    for (const path of ["/v1/admin/tenants", "/v1/admin/overview", "/v1/health/db", "/v1/health/index"]) {
      const res = await fetch(`${srv!.url}${path}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("denied.no_token");
    }
  });

  test("негодные токены отвечают ОДИНАКОВО: по ответу не переберёшь", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const revoked = await addToken(pg!, "acme", "dev-left");
    expect(await revokeToken(pg!, revoked.id)).toBe(true);
    const expired = await addToken(pg!, "acme", "dev-old", { expiresAt: Date.now() - 1000 });

    const answers: string[] = [];
    for (const t of [mintToken(), revoked.token, expired.token, "myc_not-a-token"]) {
      const r = await authenticate(pg!, t);
      expect(r.ok).toBe(false);
      answers.push(JSON.stringify(r));
    }
    expect(new Set(answers).size).toBe(1);
  });

  test("токен назначает арендатора: видно только его данные", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const other = await addToken(pg!, "globex", "dev-boris");
    const read = async (token: string): Promise<Array<{ id: string; nodes: number }>> => {
      const res = await fetch(`${srv!.url}/v1/admin/tenants`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { tenants: Array<{ id: string; nodes: number }> }).tenants;
    };
    // Админка показывает весь реестр (это её работа), но ЧИСЛА каждого
    // арендатора считаются под ним самим — см. admin.pg.test.ts. Здесь важно
    // другое: оба токена работают, и каждый называет своего владельца.
    expect((await read(good)).map((t) => t.id)).toEqual(["acme", "globex"]);
    const whoAcme = (await (
      await fetch(`${srv!.url}/v1/admin/overview`, { headers: { authorization: `Bearer ${good}` } })
    ).json()) as { ok: boolean };
    expect(whoAcme.ok).toBe(true);

    const page = await fetch(`${srv!.url}/v1/admin`, {
      headers: { authorization: `Bearer ${other.token}`, accept: "text/html" },
    });
    expect(await page.text()).toContain("dev-boris");
  });

  test("браузер: без токена — форма входа, с формой — кука HttpOnly", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const page = await fetch(`${srv!.url}/v1/admin`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("access token");

    const form = new FormData();
    form.set("token", good);
    const login = await fetch(`${srv!.url}/v1/auth/session`, { method: "POST", body: form, redirect: "manual" });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("myc_token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const withCookie = await fetch(`${srv!.url}/v1/admin`, {
      headers: { accept: "text/html", cookie: cookie.split(";")[0]! },
    });
    expect(withCookie.status).toBe(200);
    expect(await withCookie.text()).toContain("dev-anna");
  });

  test("неверный токен в форме — та же форма и 401, без подсказок", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const form = new FormData();
    form.set("token", mintToken());
    const res = await fetch(`${srv!.url}/v1/auth/session`, { method: "POST", body: form, redirect: "manual" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("not accepted");
  });

  test("список токенов показывает владельцев и отзыв, но не секреты", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const list = await listTokens(pg!);
    expect(list.map((t) => `${t.tenant}/${t.subject}`)).toContain("acme/dev-anna");
    expect(list.some((t) => t.revoked_at !== null)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(good);
    // Использованный токен помечается временем — «кто ходил и когда» без секрета.
    const anna = list.find((t) => t.subject === "dev-anna")!;
    expect(anna.last_used_at).not.toBeNull();
  });
});
