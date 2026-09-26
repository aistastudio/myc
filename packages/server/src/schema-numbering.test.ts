/**
 * Один ряд номеров схемы на два диалекта.
 *
 * `db/schema.postgres.sql` — не «пустая база», а слепок состояния, которое
 * SQLite получает после последней своей миграции, и он записывает об этом
 * строку в `schema_migrations`. Номер в этой строке обязан совпадать с
 * последней миграцией SQLite: разъехавшись, два ряда перестают сравниваться, и
 * миграция «014» будет означать разное в зависимости от того, куда смотришь.
 *
 * Тест НЕ ТРЕБУЕТ базы: он читает текст DDL и список миграций. Именно поэтому
 * он и живёт отдельно от *.pg.test.ts — на CI Postgres нет, а разъезд номеров
 * там же, где и везде.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrations } from "@myc/store-sqlite";

const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");

describe("нумерация схемы", () => {
  test("базовая строка Postgres несёт номер последней миграции SQLite", () => {
    const m = /INSERT INTO schema_migrations[\s\S]*?SELECT\s+(\d+),\s*'postgres-baseline'/.exec(DDL);
    expect(m).not.toBeNull();
    const baseline = Number(m![1]);
    const latest = Math.max(...migrations.map((x) => x.version));
    // Разошлось — это не «поправить число в тесте». Либо у Postgres появилась
    // своя миграция (тогда её надо написать и завести ей ряд), либо слепок
    // отстал от SQLite (тогда его надо догнать).
    expect(baseline).toBe(latest);
  });

  test("строка учёта попадает в DDL один раз и не переписывает чужую", () => {
    const inserts = DDL.match(/INSERT INTO schema_migrations\b/g) ?? [];
    expect(inserts.length).toBe(1);
    // Повторный накат на живой базе не должен подменять запись о первом.
    expect(DDL).toContain("ON CONFLICT (version) DO NOTHING");
  });
});
