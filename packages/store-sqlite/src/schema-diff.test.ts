/**
 * Сравнение схем — прямо, на синтетических базах.
 *
 * ПОЧЕМУ ОТДЕЛЬНО ОТ schema-parity.test.ts. Тот сравнивает две базы, которые
 * ДОЛЖНЫ совпадать, и потому доказывает только «расхождений нет». Мутация это
 * показала: если сделать normalizeDdl тождественно пустой строкой, все тексты
 * DDL станут равны, differing останется пустым — и паритет пройдёт зелёным на
 * полностью мёртвом сравнении. Значит нужен второй тест, который проверяет,
 * что сравнение УМЕЕТ ВИДЕТЬ разницу, а не только не видеть её.
 *
 * Тот же модуль отвечает на вопрос `myc doctor --schema`, где вторая сторона —
 * рабочая база пользователя, и цена мёртвого сравнения там выше: команда
 * напечатает «объекты сходятся» про базу, в которой не хватает таблицы.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  diffColumns,
  diffSchema,
  normalizeDdl,
  schemaConverges,
  schemaObjects,
  tableColumns,
} from "./schema-diff.ts";

function db(...ddl: string[]): Database {
  const d = new Database(":memory:");
  for (const s of ddl) d.exec(s);
  return d;
}

const A = "CREATE TABLE a (id TEXT PRIMARY KEY, x INTEGER NOT NULL)";
const B = "CREATE TABLE b (id TEXT PRIMARY KEY)";

describe("normalizeDdl снимает вёрстку, но не смысл", () => {
  test("комментарии, пробелы и регистр не считаются различием", () => {
    expect(normalizeDdl("CREATE  TABLE a (id TEXT) -- комментарий")).toBe(
      normalizeDdl("create table a\n(id text)"),
    );
  });

  test("разные DDL остаются разными — иначе сравнение мертво", () => {
    expect(normalizeDdl(A)).not.toBe(normalizeDdl(B));
    // И не пустой строкой: тождественно пустая нормализация уравнивает всё.
    expect(normalizeDdl(A)).not.toBe("");
    expect(normalizeDdl(null)).toBe("");
  });
});

describe("diffSchema видит расхождение в обе стороны", () => {
  test("совпадающие схемы сходятся", () => {
    const diff = diffSchema(schemaObjects(db(A, B)), schemaObjects(db(A, B)));
    expect(schemaConverges(diff)).toBe(true);
  });

  test("объект, которого нет у второй стороны, назван поимённо", () => {
    const diff = diffSchema(schemaObjects(db(A, B)), schemaObjects(db(A)));
    expect(diff.missing).toEqual(["table:b"]);
    expect(diff.extra).toEqual([]);
    expect(schemaConverges(diff)).toBe(false);
  });

  test("лишний объект у второй стороны тоже назван", () => {
    const diff = diffSchema(schemaObjects(db(A)), schemaObjects(db(A, B)));
    expect(diff.extra).toEqual(["table:b"]);
  });

  test("одно имя, разный текст — это differing, а не missing", () => {
    const diff = diffSchema(
      schemaObjects(db("CREATE TABLE a (id TEXT)")),
      schemaObjects(db("CREATE TABLE a (id TEXT, extra INTEGER)")),
    );
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(diff.differing).toEqual(["table:a"]);
  });

  test("ignore выключает объект целиком, ignoreText — только сверку текста", () => {
    const left = schemaObjects(db("CREATE TABLE a (id TEXT)"));
    const right = schemaObjects(db("CREATE TABLE a (id TEXT, extra INTEGER)", B));

    const ignored = diffSchema(left, right, {
      ignore: new Map([
        ["table:a", "причина"],
        ["table:b", "причина"],
      ]),
    });
    expect(schemaConverges(ignored)).toBe(true);

    const textOnly = diffSchema(left, right, { ignoreText: new Set(["table:a"]) });
    expect(textOnly.differing).toEqual([]);
    expect(textOnly.extra).toEqual(["table:b"]); // наличие всё ещё сверяется
  });

  test("служебные sqlite_* в сравнение не попадают", () => {
    const objects = schemaObjects(db("CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT)"));
    expect([...objects.keys()].some((k) => k.includes("sqlite_"))).toBe(false);
  });
});

describe("diffColumns", () => {
  test("колонка, которой нет, и колонка лишняя — обе названы", () => {
    const expected = db("CREATE TABLE a (id TEXT, only_left INTEGER)");
    const actual = db("CREATE TABLE a (id TEXT, only_right INTEGER)");
    const diff = diffColumns(expected, actual, ["a"]);
    expect(diff.unexplained.sort()).toEqual(["a.only_left нет", "a.only_right лишняя"]);
  });

  test("объявленное с причиной отличие не считается расхождением", () => {
    const expected = db("CREATE TABLE a (id TEXT)");
    const actual = db("CREATE TABLE a (id TEXT, legacy INTEGER)");
    const diff = diffColumns(expected, actual, ["a"], new Map([["a.legacy", "историческая"]]));
    expect(diff.unexplained).toEqual([]);
  });

  test("tableColumns читает колонки, а не выдумывает их", () => {
    expect(tableColumns(db(A), "a")).toEqual(["id", "x"]);
  });
});
