/**
 * ПОТОЛОК ПУЛА — НЕ НАСТРОЙКА, А ОБЕЩАНИЕ БАЗЕ (стык S17, memory-bjy6fq9kxj47:
 * «один пул на 2–10 соединений»).
 *
 * Проверять его чтением кода бессмысленно: значение можно передать и не
 * применить. Поэтому тест смотрит на базу со стороны — считает живые backend'ы
 * роли myc_app в `pg_stat_activity`, пока драйвер держит больше запросов, чем
 * у него соединений. Postgres держит ПРОЦЕСС на соединение, и процесс,
 * открывающий их без счёта, отбирает их у соседей по кластеру.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { openPostgres, POOL_MAX_DEFAULT, type PostgresDriver } from "./index.ts";

const URL_ENV = process.env.MYC_PG_URL;
const POOL = 3;
const CONCURRENT = 12;

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let appUrl = "";

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  admin = new SQL(URL_ENV);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'").catch(() => undefined);
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  appUrl = u.toString();
});

afterAll(async () => {
  await pg?.close();
  await admin?.close();
});

describe("пул соединений", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  test("умолчание — верхняя граница стыка, а не «сколько получится»", () => {
    expect(POOL_MAX_DEFAULT).toBe(10);
  });

  test("нецелый или нулевой потолок — отказ на открытии, а не молча", () => {
    expect(() => openPostgres({ url: "postgres://x/y", max: 0 })).toThrow(/positive integer/);
    expect(() => openPostgres({ url: "postgres://x/y", max: 2.5 })).toThrow(/positive integer/);
  });

  test("двенадцать запросов сразу не открывают двенадцати соединений", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    pg = openPostgres({ url: appUrl, max: POOL });

    // Пока двенадцать запросов спят, пул обязан держать не больше POOL
    // соединений: остальные ждут своей очереди, а не заводят свою.
    const busy = Promise.all(
      Array.from({ length: CONCURRENT }, async () => pg!.raw("SELECT pg_sleep(0.25) AS s")),
    );
    // Дать драйверу открыть всё, что он собирался, и посмотреть в середине.
    await new Promise((r) => setTimeout(r, 120));
    const [seen] = (await admin!.unsafe(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE usename = 'myc_app' AND state IS NOT NULL AND pid <> pg_backend_pid()`,
    )) as Array<{ n: string | number }>;
    const open = Number(seen?.n ?? 0);
    await busy;

    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThanOrEqual(POOL);
  });
});
