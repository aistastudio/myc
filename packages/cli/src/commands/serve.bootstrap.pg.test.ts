/**
 * ПРИЁМКА memory-3n0svbkbjaew: «docker compose up даёт рабочий сервер без
 * ручных шагов».
 *
 * Поднятый контейнер без этого — пустая коробка: схемы нет, арендаторов нет,
 * войти нечем. Схему на пустом томе накатывает сам Postgres (её файл подан
 * ему в docker-entrypoint-initdb.d), а первого арендатора и первый токен
 * заводит сервер из окружения — вот это и проверяется здесь, на живой базе.
 *
 * ГЛАВНОЕ СВОЙСТВО — ИДЕМПОТЕНТНОСТЬ. Контейнер перезапускают, и если
 * bootstrap минтит токен каждый раз, в журнале копятся секреты по числу
 * рестартов, а у арендатора — стопка живых токенов, которые никто не
 * отзывал. Поэтому второй вызов обязан молчать.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { bootstrapTenant } from "./serve.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "db", "schema.postgres.sql"), "utf8");

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;

beforeAll(async () => {
  if (URL_ENV === undefined) return;
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
  await pg?.close();
  await admin?.close();
});

describe("первый арендатор и первый токен из окружения", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  const tenants = async (): Promise<number> =>
    Number((await pg!.raw<{ n: string }>("SELECT count(*) AS n FROM tenants"))[0]?.n ?? 0);
  const tokens = async (): Promise<number> =>
    Number(
      (await pg!.raw<{ n: string }>("SELECT count(*) AS n FROM api_tokens WHERE revoked_at IS NULL"))[0]?.n ?? 0,
    );

  test("без переменных не делается ничего и не говорится ничего", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    expect(await bootstrapTenant(pg!, {})).toBeUndefined();
    expect(await tenants()).toBe(0);
  });

  test("первый старт заводит арендатора и токен и печатает секрет один раз", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const out = await bootstrapTenant(pg!, {
      MYC_BOOTSTRAP_TENANT: "acme",
      MYC_BOOTSTRAP_TOKEN: "anna",
    });
    expect(out).toBeDefined();
    expect(out).toContain("bootstrap tenant acme registered");
    expect(out).toContain("bootstrap token ");
    // Секрет в журнале — это решение, и оно названо вслух рядом с ним.
    expect(out).toContain("a real install drops MYC_BOOTSTRAP_*");
    expect(await tenants()).toBe(1);
    expect(await tokens()).toBe(1);
  });

  test("второй старт МОЛЧИТ: секреты не копятся по числу перезапусков", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const again = await bootstrapTenant(pg!, {
      MYC_BOOTSTRAP_TENANT: "acme",
      MYC_BOOTSTRAP_TOKEN: "anna",
    });
    expect(again).toBeUndefined();
    expect(await tenants()).toBe(1);
    expect(await tokens()).toBe(1);
  });

  test("арендатор без имени токена заводится, токен не минтится", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const out = await bootstrapTenant(pg!, { MYC_BOOTSTRAP_TENANT: "globex" });
    expect(out).toContain("bootstrap tenant globex registered");
    expect(out).not.toContain("bootstrap token");
    expect(await tokens()).toBe(1);
  });
});
