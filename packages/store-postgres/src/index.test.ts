/**
 * Драйвер Postgres: что можно проверить без базы — проверяется без базы,
 * остальное идёт к живой (см. schema.pg.test.ts про MYC_PG_URL и образ).
 */

import { describe, expect, test } from "bun:test";
import { defineQueries, resolveQueryText } from "@myc/core";
import { openPostgres, renderRow } from "./index.ts";

const Q = defineQueries({
  node_get: {
    name: "node_get",
    sql: "SELECT id, title FROM nodes WHERE id = ?1 AND scope = ?2",
    params: ["id", "scope"],
  },
  ready_reach: {
    name: "ready_reach",
    // Текст SQLite с json_extract и его pg-оверрайд: ровно та развилка, ради
    // которой в QueryDef есть поле `pg` (§8.4).
    sql: "SELECT id FROM nodes WHERE json_extract(attrs,'$.reach') = ?1",
    pg: "SELECT id FROM nodes WHERE attrs->>'reach' = $1",
    params: ["reach"],
  },
});

describe("текст запроса под диалект", () => {
  test("плейсхолдеры переписываются ?N → $N, а оверрайд берётся как есть", () => {
    expect(resolveQueryText(Q.node_get, "pg")).toBe(
      "SELECT id, title FROM nodes WHERE id = $1 AND scope = $2",
    );
    expect(resolveQueryText(Q.ready_reach, "pg")).toBe(Q.ready_reach.pg);
    // SQLite при этом читает свой текст без изменений — один реестр на два
    // диалекта, и ни один не переписывает другой.
    expect(resolveQueryText(Q.node_get, "sqlite")).toBe(Q.node_get.sql);
  });
});

describe("арендатор — часть соединения", () => {
  test("пустой арендатор отвергается до запроса: иначе сессия не видит ничего молча", async () => {
    const db = openPostgres("postgres://user:pass@127.0.0.1:1/none");
    await expect(db.withTenant("", async () => 1)).rejects.toThrow(/tenant must not be empty/);
    await db.close();
  });

  test("драйвер объявляет диалект pg — по нему выбирается текст запроса", () => {
    const db = openPostgres({ url: "postgres://user:pass@127.0.0.1:1/none" });
    expect(db.dialect).toBe("pg");
    void db.close();
  });
});

describe("JSONB возвращается текстом", () => {
  test("объект становится JSON-строкой, остальное не трогается", () => {
    const row = renderRow({
      id: "cherry-1",
      attrs: { reach: "project", external_ref: "bd-42" },
      hlc: 100,
      body: null,
      fp: new Uint8Array([1, 2, 3]),
    });
    // Модель читает attrs как JSON-текст (rowToNode делает JSON.parse) — иначе
    // один и тот же код не смог бы читать обе базы.
    expect(row["attrs"]).toBe('{"reach":"project","external_ref":"bd-42"}');
    expect(row["id"]).toBe("cherry-1");
    expect(row["hlc"]).toBe(100);
    expect(row["body"]).toBeNull();
    // Двоичное поле (отпечаток якоря) — не JSON и остаётся собой.
    expect(row["fp"]).toBeInstanceOf(Uint8Array);
  });

  test("строка без объектов возвращается той же ссылкой — лишних копий нет", () => {
    const row = { id: "x", n: 1 };
    expect(renderRow(row)).toBe(row);
  });
});
