/**
 * Паритет `db/schema.sqlite.sql` с набором миграций.
 *
 * Источник истины — миграции: только они выполняются в рабочей базе. Но файл
 * не мёртвый документ: его грузит `packages/core/src/memory.test.ts`, потому
 * что пакету core запрещено зависеть от store-sqlite (scripts/deps-check.ts).
 * Значит расхождение здесь не косметика — core проверялся бы против схемы,
 * которой в рабочей базе нет.
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

interface Obj {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/** Текст DDL без комментариев и различий в пробелах: сравниваем смысл, не вёрстку. */
function normalize(sql: string | null): string {
  return (sql ?? "").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

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

function objects(db: Database): Map<string, Obj> {
  const rows = db
    .query<Obj, []>(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  return new Map(rows.map((r) => [`${r.type}:${r.name}`, r]));
}

function columns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') ORDER BY name`)
    .all()
    .map((r) => r.name);
}

describe("db/schema.sqlite.sql в паритете с миграциями", () => {
  test("набор объектов совпадает в обе стороны", async () => {
    const file = objects(fromFile());
    const mig = objects(await fromMigrations());

    // Обе стороны, а не одна: объект, забытый в файле, ломает тест core;
    // объект, оставшийся в файле после удаления из миграций, вводит в
    // заблуждение читателя ровно так же.
    const missingInFile = [...mig.keys()].filter((k) => !file.has(k));
    const extraInFile = [...file.keys()].filter((k) => !mig.has(k));
    expect(missingInFile).toEqual([]);
    expect(extraInFile).toEqual([]);
    // Корпус непустой: пустые множества сошлись бы и при сломанном чтении.
    expect(file.size).toBeGreaterThan(50);
  });

  test("колонки таблиц совпадают, кроме перечисленных с причиной", async () => {
    const f = fromFile();
    const m = await fromMigrations();
    const tables = [...objects(f).values()].filter((o) => o.type === "table").map((o) => o.name);

    const unexplained: string[] = [];
    for (const t of tables) {
      const inFile = columns(f, t);
      const inMig = columns(m, t);
      for (const c of inMig) if (!inFile.includes(c)) unexplained.push(`${t}.${c} нет в файле`);
      for (const c of inFile) {
        if (inMig.includes(c)) continue;
        if (!ALLOWED_ONLY_IN_FILE.has(`${t}.${c}`)) unexplained.push(`${t}.${c} лишняя в файле`);
      }
    }
    expect(unexplained).toEqual([]);
  });

  test("текст DDL совпадает у общих объектов, кроме объявленных отличий", async () => {
    const file = objects(fromFile());
    const mig = objects(await fromMigrations());
    // Имя объекта, чьё отличие уже объяснено колонкой выше: сравнивать его
    // текст бессмысленно, он отличается именно этой колонкой.
    const explained = new Set([...ALLOWED_ONLY_IN_FILE.keys()].map((k) => `table:${k.split(".")[0]}`));

    const differing: string[] = [];
    for (const [key, a] of file) {
      const b = mig.get(key);
      if (b === undefined || explained.has(key)) continue;
      if (normalize(a.sql) !== normalize(b.sql)) differing.push(key);
    }
    expect(differing).toEqual([]);
  });
});
