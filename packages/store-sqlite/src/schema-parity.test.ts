/**
 * Паритет `db/schema.sqlite.sql` с набором миграций.
 *
 * Источник истины — миграции: только они выполняются в рабочей базе. Но файл
 * не мёртвый документ: его грузит `packages/core/src/memory.test.ts`, потому
 * что пакету core запрещено зависеть от store-sqlite (scripts/deps-check.ts).
 * Значит расхождение здесь не косметика — core проверялся бы против схемы,
 * которой в рабочей базе нет.
 *
 * СРАВНЕНИЕ ЖИВЁТ НЕ ЗДЕСЬ. Ту же арифметику (набор объектов, колонки,
 * нормализованный текст DDL) спрашивает `myc doctor --schema` — только у него
 * вторая сторона не файл, а рабочая база пользователя. Обе стороны обязаны
 * называть расхождением одно и то же, поэтому логика вынесена в
 * ./schema-diff.ts, а этот тест — один из двух её вызывающих.
 *
 * Так уже было: миграция 001 добавила `nodes.excerpt` (S5), в файле его не
 * появилось, и полгода никто не знал; заодно разошлись два покрывающих индекса
 * (S58, S59) и три таблицы код-интеллекта (S52). Заголовок файла при этом
 * утверждал «провалидирован» и называл точное число объектов — то есть читатель
 * строил неверную модель и не мог об этом узнать. Числа из заголовка убраны:
 * они устаревают молча, а этот тест — нет.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, migrations } from "./index.ts";
import { diffColumns, diffSchema, schemaObjects } from "./schema-diff.ts";

const SCHEMA_FILE = join(import.meta.dir, "../../../db/schema.sqlite.sql");

/**
 * Отличия, оставленные СОЗНАТЕЛЬНО. Каждое — с причиной прямо здесь: список
 * без причин через месяц становится списком забытого.
 *
 * `schema_migrations.by_version` — в файле есть, раннеру не нужна: версию он
 * держит в собственной структуре, и лишняя колонка в рабочей базе означала бы
 * мёртвое поле, которое некому заполнять (см. докстрок 001-init.ts).
 */
const ALLOWED_ONLY_IN_FILE = new Map<string, string>([
  ["schema_migrations.by_version", "раннер держит версию сам; колонка в базе была бы мёртвой"],
]);

function fromFile(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_FILE, "utf8"));
  return db;
}

async function fromMigrations(): Promise<Database> {
  const db = new Database(":memory:");
  await migrate(db, { migrations, writable: true });
  return db;
}

describe("db/schema.sqlite.sql в паритете с миграциями", () => {
  // Имя объекта, чьё отличие уже объяснено колонкой в ALLOWED_ONLY_IN_FILE:
  // сравнивать его текст бессмысленно, он отличается именно этой колонкой.
  const EXPLAINED_TEXT = new Set(
    [...ALLOWED_ONLY_IN_FILE.keys()].map((k) => `table:${k.split(".")[0]}`),
  );

  test("набор объектов совпадает в обе стороны", async () => {
    const file = schemaObjects(fromFile());
    const mig = schemaObjects(await fromMigrations());

    // Обе стороны, а не одна: объект, забытый в файле, ломает тест core;
    // объект, оставшийся в файле после удаления из миграций, вводит в
    // заблуждение читателя ровно так же.
    const diff = diffSchema(mig, file, { ignoreText: EXPLAINED_TEXT });
    expect(diff.missing).toEqual([]); // есть в миграциях, нет в файле
    expect(diff.extra).toEqual([]); // есть в файле, нет в миграциях
    // Корпус непустой: пустые множества сошлись бы и при сломанном чтении.
    expect(file.size).toBeGreaterThan(50);
  });

  test("колонки таблиц совпадают, кроме перечисленных с причиной", async () => {
    const f = fromFile();
    const m = await fromMigrations();
    const tables = [...schemaObjects(f).values()]
      .filter((o) => o.type === "table")
      .map((o) => o.name);

    expect(diffColumns(m, f, tables, ALLOWED_ONLY_IN_FILE).unexplained).toEqual([]);
    expect(tables.length).toBeGreaterThan(10);
  });

  test("текст DDL совпадает у общих объектов, кроме объявленных отличий", async () => {
    const file = schemaObjects(fromFile());
    const mig = schemaObjects(await fromMigrations());
    expect(diffSchema(mig, file, { ignoreText: EXPLAINED_TEXT }).differing).toEqual([]);
  });
});
