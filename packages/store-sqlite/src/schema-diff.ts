/**
 * Сравнение схем двух баз: набор объектов, колонки таблиц, текст DDL.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ. Одну и ту же арифметику спрашивают ДВА разных
 * вопроса, и ответы обязаны совпадать: schema-parity.test.ts спрашивает
 * «совпадает ли `db/schema.sqlite.sql` с набором миграций» (расхождение ловится
 * в CI), а `myc doctor --schema` — «совпадает ли РАБОЧАЯ база с тем, что знает
 * этот бинарь» (расхождение ловится у пользователя). Две копии нормализации
 * DDL разъехались бы молча, и одна из сторон начала бы называть «ok» то, что
 * другая считает расхождением.
 *
 * Модуль ничего не мигрирует и ничего не чинит: он только читает sqlite_master
 * и pragma_table_info. Обе базы для него равноправны — кто «эталон», решает
 * вызывающий, называя стороны в {@link diffSchema}.
 */

import type { Database } from "bun:sqlite";

export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/**
 * Текст DDL без комментариев и различий в пробелах: сравниваем смысл, не
 * вёрстку. Регистр тоже снимается — SQLite хранит DDL ровно так, как его
 * написали, и `NOT NULL` против `not null` не расхождение схемы.
 */
export function normalizeDdl(sql: string | null): string {
  return (sql ?? "").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Объекты базы, ключ — `тип:имя`. Служебные `sqlite_*` (autoindex, sequence)
 * не наши: их заводит движок, и в схеме их никто не объявлял.
 */
export function schemaObjects(db: Database): Map<string, SchemaObject> {
  const rows = db
    .query<SchemaObject, []>(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  return new Map(rows.map((r) => [`${r.type}:${r.name}`, r]));
}

/** Колонки таблицы по алфавиту. Порядок объявления для сравнения не важен. */
export function tableColumns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') ORDER BY name`)
    .all()
    .map((r) => r.name);
}

export interface SchemaDiff {
  /** Есть у `expected`, нет у `actual`. */
  readonly missing: string[];
  /** Есть у `actual`, нет у `expected`. */
  readonly extra: string[];
  /** Есть у обоих, но текст DDL разный. */
  readonly differing: string[];
}

export interface DiffOptions {
  /**
   * Ключи (`тип:имя`), которые не сравниваются вовсе, — с причиной в значении.
   * Причина хранится рядом не для красоты: список исключений без причин через
   * месяц становится списком забытого.
   */
  readonly ignore?: ReadonlyMap<string, string>;
  /**
   * Ключи, у которых сравнивается только НАЛИЧИЕ, но не текст DDL. Нужно там,
   * где отличие уже объяснено на уровне колонок.
   */
  readonly ignoreText?: ReadonlySet<string>;
}

/**
 * Расхождение в обе стороны. Одной мало: объект, забытый в `actual`, и объект,
 * доживший в `actual` после удаления из `expected`, — разные поломки, и вторая
 * так же вводит в заблуждение, как первая.
 */
export function diffSchema(
  expected: ReadonlyMap<string, SchemaObject>,
  actual: ReadonlyMap<string, SchemaObject>,
  options: DiffOptions = {},
): SchemaDiff {
  const ignore = options.ignore ?? new Map<string, string>();
  const ignoreText = options.ignoreText ?? new Set<string>();

  const missing: string[] = [];
  const extra: string[] = [];
  const differing: string[] = [];

  for (const key of expected.keys()) {
    if (ignore.has(key)) continue;
    if (!actual.has(key)) missing.push(key);
  }
  for (const key of actual.keys()) {
    if (ignore.has(key)) continue;
    if (!expected.has(key)) extra.push(key);
  }
  for (const [key, a] of expected) {
    if (ignore.has(key) || ignoreText.has(key)) continue;
    const b = actual.get(key);
    if (b === undefined) continue;
    if (normalizeDdl(a.sql) !== normalizeDdl(b.sql)) differing.push(key);
  }
  return { missing, extra, differing };
}

/** Пусто ⇒ схемы сошлись. Одна проверка вместо трёх у каждого вызывающего. */
export function schemaConverges(diff: SchemaDiff): boolean {
  return diff.missing.length === 0 && diff.extra.length === 0 && diff.differing.length === 0;
}

export interface ColumnDiff {
  /** Человекочитаемые строки вида `nodes.excerpt нет в базе`. */
  readonly unexplained: string[];
}

/**
 * Колонки общих таблиц. `allowedOnlyInActual` — колонки, которым позволено быть
 * лишними у `actual`, ключ `таблица.колонка`, значение — причина.
 */
export function diffColumns(
  expected: Database,
  actual: Database,
  tables: readonly string[],
  allowedOnlyInActual: ReadonlyMap<string, string> = new Map(),
): ColumnDiff {
  const unexplained: string[] = [];
  for (const t of tables) {
    const inExpected = tableColumns(expected, t);
    const inActual = tableColumns(actual, t);
    for (const c of inExpected) if (!inActual.includes(c)) unexplained.push(`${t}.${c} нет`);
    for (const c of inActual) {
      if (inExpected.includes(c)) continue;
      if (!allowedOnlyInActual.has(`${t}.${c}`)) unexplained.push(`${t}.${c} лишняя`);
    }
  }
  return { unexplained };
}
