/**
 * ДОПУЩЕНИЯ МЕХАНИЧЕСКОГО ПЕРЕВОДА — ПРОВЕРЯЮТСЯ, А НЕ ПОДРАЗУМЕВАЮТСЯ.
 *
 * `toPgDialect` (packages/core/src/sql.ts) снимает `INDEXED BY` и переводит
 * `json_extract(x,'$.k')` в `x->>'k'` по всему тексту запроса. Это работает,
 * пока в реестрах выполняются два условия, и оба легко нарушить правкой,
 * которая сама по себе выглядит безобидно:
 *
 *  1) ни один запрос не содержит этих слов ВНУТРИ строкового литерала — иначе
 *     перевод испортит данные, а не запрос;
 *  2) все пути json — ровно один ключ верхнего уровня. Путь посложнее
 *     переводчик не трогает СОЗНАТЕЛЬНО, и Postgres узнает об этом только в
 *     бою: json_extract там просто нет.
 *
 * Поэтому здесь сторож по ВСЕМ реестрам сразу: пакет cli — единственное
 * место, откуда видны все четыре (ready, prime, bootstrap, mcp) плюс общий Q.
 */

import { describe, expect, test } from "bun:test";
import type { QueryDef } from "@myc/core";
import { Q } from "@myc/store-sqlite";
import { mcpQueries } from "@myc/mcp";
import { bootstrapQueries } from "./commands/bootstrap.ts";
import { primeQueries } from "./commands/prime.ts";
import { readyQueries } from "./commands/ready.ts";

const REGISTRIES: ReadonlyArray<readonly [string, Readonly<Record<string, QueryDef>>]> = [
  ["Q", Q],
  ["ready", readyQueries],
  ["prime", primeQueries],
  ["bootstrap", bootstrapQueries],
  ["mcp", mcpQueries],
];

/** Куски внутри одинарных кавычек — то, что переводчику трогать нельзя. */
function literals(sql: string): string[] {
  return (sql.match(/'(?:[^']|'')*'/g) ?? []).map((s) => s);
}

describe("реестры запросов и механический перевод диалекта", () => {
  test("в реестрах есть что проверять (сторож не остался без работы)", () => {
    // Циклы ниже проходят и по ПУСТОМУ реестру: сломайся импорт — они
    // «зазеленеют», ничего не проверив. Порог заметно ниже сегодняшних 97,
    // чтобы удаление запроса не роняло чужой тест, но не ноль.
    const total = REGISTRIES.reduce((n, [, r]) => n + Object.keys(r).length, 0);
    expect(total).toBeGreaterThan(80);
  });

  for (const [reg, queries] of REGISTRIES) {
    test(`${reg}: ни json_extract, ни INDEXED BY не прячутся в строковом литерале`, () => {
      for (const def of Object.values(queries)) {
        for (const lit of literals(def.sql)) {
          expect(`${reg}.${def.name}: ${lit}`).not.toMatch(/json_extract|INDEXED\s+BY/i);
        }
      }
    });

    test(`${reg}: все пути json — один ключ, иначе нужен оверрайд pg`, () => {
      for (const def of Object.values(queries)) {
        for (const m of def.sql.matchAll(/json_extract\s*\(([^)]*)\)/gi)) {
          const path = /,\s*'([^']*)'/.exec(m[1] ?? "")?.[1] ?? "";
          // Сообщение несёт имя запроса: сторож по 150 запросам обязан
          // называть виновника, а не факт.
          expect(`${reg}.${def.name} ${path}`).toMatch(/\$\.[A-Za-z_][A-Za-z0-9_]*$/);
        }
      }
    });
  }
});
