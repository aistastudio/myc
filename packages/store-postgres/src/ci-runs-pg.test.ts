/**
 * ПРОГОН, КОТОРЫЙ ПРОПУСКАЕТ СЕБЯ, НИЧЕГО НЕ ПРОВЕРЯЕТ.
 *
 * Десять файлов `*.pg.test.ts` — весь серверный слой, обмен и RLS — честно
 * печатают «нет MYC_PG_URL» и проходят. Это правильно на машине без
 * Postgres и КАТАСТРОФА на раннере: до 2026-09-30 в `.github/workflows/ci.yml`
 * не было ни службы Postgres, ни переменной, и 160 тестов сервера не
 * выполнялись там ни разу — зелёный прогон говорил о сервере ровно ничего.
 *
 * Этот тест Postgres не нужен: он читает сам рецепт CI. Убрать службу или
 * переменную теперь нельзя молча — оно покраснеет здесь.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CI = join(import.meta.dir, "..", "..", "..", ".github", "workflows", "ci.yml");
const recipe = readFileSync(CI, "utf8");

describe("CI действительно гоняет тесты Postgres", () => {
  test("в рецепте есть MYC_PG_URL, и адрес совпадает с портом службы", () => {
    const url = /MYC_PG_URL:\s*(\S+)/.exec(recipe)?.[1];
    expect(url).toBeDefined();
    const port = /ports:\s*\n\s*-\s*(\d+):5432/.exec(recipe)?.[1];
    expect(port).toBeDefined();
    // Переменная, указывающая мимо поднятой службы, — та же тишина, только
    // дороже: тесты не пропустятся, а упадут на подключении.
    expect(url).toContain(`:${port}/`);
  });

  test("служба — тот же образ, что у compose: схеме нужны halfvec и HNSW", () => {
    expect(/image:\s*pgvector\/pgvector:pg17/.test(recipe)).toBe(true);
    const compose = readFileSync(
      join(import.meta.dir, "..", "..", "..", "deploy", "compose.yml"),
      "utf8",
    );
    const ci = /image:\s*(pgvector\/pgvector:\S+)/.exec(recipe)?.[1];
    const dep = /image:\s*(pgvector\/pgvector:\S+)/.exec(compose)?.[1];
    expect([ci, dep]).toEqual([dep, dep]);
  });
});
