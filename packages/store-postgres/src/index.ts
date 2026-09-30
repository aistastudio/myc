/**
 * Драйвер Postgres (M4, memory-2xgh8mg2fs24).
 *
 * ПОЧЕМУ ОН АСИНХРОННЫЙ, А SQLITE — НЕТ. `DbDriver` ядра синхронен, и это не
 * недосмотр: на нём стоят бюджеты локальных команд (скан дайджеста prime —
 * 1.9 мс на 100k узлов), а bun:sqlite отвечает в том же стеке вызова. Postgres
 * отвечает по сети, и синхронным быть не может: либо вся база кода становится
 * асинхронной ради диалекта, которым локальная машина не пользуется, либо
 * запрос ждёт через мост процессов и платит сотни микросекунд на каждом
 * вызове. Ни то, ни другое не оправдано, поэтому границу провели по РОЛИ:
 * SQLite — локальная машина и синхронный `DbDriver`, Postgres — сервер
 * команды (M4 в ARCHITECTURE.md так и назван) и `AsyncDbDriver`. Тексты
 * запросов при этом общие: их даёт один реестр, диалект выбирает
 * `resolveQueryText`.
 *
 * АРЕНДАТОР — ЧАСТЬ СОЕДИНЕНИЯ, А НЕ ЗАПРОСА. Изоляцию держит RLS по
 * `myc_tenant()` (db/schema.postgres.sql), а значение приходит из
 * `SET LOCAL myc.tenant`. Поэтому единица работы здесь — `withTenant`:
 * транзакция, у которой арендатор назначен на входе и снят вместе с ней.
 * Забыть его нельзя: без него сессия не видит ни строки — это и есть fail
 * closed, а не тихое чтение чужого.
 */

import {
  type AsyncDbDriver as CoreAsyncDbDriver,
  resolveQueryText,
  validateQueryDef,
  type QueryDef,
  type TxMode,
} from "@myc/core";
import { SQL } from "bun";

/**
 * Тот же контракт, что у синхронного `DbDriver` ядра, но каждый ответ —
 * обещание. Имена и порядок параметров совпадают намеренно: код, который
 * умеет один, читается как код, который умеет другой.
 */
export interface AsyncDbDriver extends CoreAsyncDbDriver {
  /** Сырой текст — для DDL и административных запросов, не из реестра. */
  raw<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface PostgresDriver extends AsyncDbDriver {
  /**
   * Работа от имени арендатора: одна транзакция, `SET LOCAL myc.tenant` на
   * входе. Режим транзакции взят из того же перечисления, что у SQLite;
   * `immediate` в Postgres смысла не имеет (MVCC) и игнорируется — так же,
   * как сказано в §8.3 таблицы расхождений.
   */
  withTenant<T>(tenant: string, fn: (tx: AsyncDbDriver) => Promise<T>, mode?: TxMode): Promise<T>;
  /**
   * Одна транзакция БЕЗ арендатора — для того, что арендаторов не касается:
   * схема и её учёт. Отдельно от `withTenant`, потому что `SET LOCAL
   * myc.tenant` здесь означал бы, что у DDL есть владелец, а его нет.
   *
   * Нужна именно транзакция, а не несколько `raw` подряд: у пула каждый
   * вызов вправе взять СВОЁ соединение, и `BEGIN` одним запросом, а
   * `COMMIT` другим не связывают ничего. Bun это и говорит вслух — «Only
   * use sql.begin, sql.reserved or max: 1».
   */
  withTransaction<T>(fn: (tx: AsyncDbDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresOpenOptions {
  readonly url: string;
  /**
   * Потолок соединений пула. Умолчание 10 — верхняя граница стыка S17
   * (задача memory-bjy6fq9kxj47: «один пул на 2–10 соединений»).
   *
   * Потолок нужен не серверу, а БАЗЕ: Postgres держит по процессу на
   * соединение, `max_connections` у управляемых баз обычно 25–100, и один
   * процесс, открывающий столько, сколько ему захотелось, отбирает их у
   * соседей и у самого администратора. Пул здесь ОДИН на процесс: арендатор
   * задаётся `SET LOCAL` внутри транзакции, поэтому разделять соединения по
   * арендаторам не нужно и нечем.
   */
  readonly max?: number;
}

/** Умолчание и потолок размера пула — см. {@link PostgresOpenOptions.max}. */
export const POOL_MAX_DEFAULT = 10;

/** Строка ответа Postgres: драйвер Bun отдаёт обычные объекты. */
type Row = Record<string, unknown>;

/**
 * JSONB ПРИХОДИТ ОБЪЕКТОМ, А МОДЕЛЬ ЖДЁТ ТЕКСТ. В SQLite `attrs` — колонка
 * TEXT, и весь код выше читает её как JSON-строку (`JSON.parse(row.attrs)`).
 * Postgres отдаёт JSONB уже разобранным, и это единственное расхождение,
 * которое нельзя выразить оверрайдом текста запроса дёшево: `attrs` читают
 * шестнадцать SELECT-ов реестра, и `::text` пришлось бы дописать в каждый,
 * а забытый — падал бы не здесь, а у вызывающего.
 *
 * Поэтому сглаживание живёт в ОДНОМ месте — здесь, — и названо: объект,
 * пришедший из JSONB, возвращается текстом. Массивы в модели не
 * используются by design (§8.3), дат в схеме нет (время — BIGINT мс), так
 * что под правило не попадает ничего, кроме JSON-колонок.
 */
export function renderRow(row: Row): Row {
  let copy: Row | undefined;
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) {
      copy ??= { ...row };
      copy[k] = JSON.stringify(v);
    }
  }
  return copy ?? row;
}

function driverOn(sql: SQL): AsyncDbDriver {
  const text = (query: QueryDef): string => {
    validateQueryDef(query);
    return resolveQueryText(query, "pg");
  };
  return {
    dialect: "pg",
    async one<T>(query: QueryDef, params: readonly unknown[]): Promise<T | undefined> {
      const rows = (await sql.unsafe(text(query), [...params])) as Row[];
      return rows[0] === undefined ? undefined : (renderRow(rows[0]) as T);
    },
    async all<T>(query: QueryDef, params: readonly unknown[]): Promise<T[]> {
      return ((await sql.unsafe(text(query), [...params])) as Row[]).map(renderRow) as T[];
    },
    async run(query: QueryDef, params: readonly unknown[]): Promise<{ changes: number }> {
      const rows = (await sql.unsafe(text(query), [...params])) as Row[] & { count?: number };
      // ЧИСЛО ЗАТРОНУТЫХ СТРОК — ИЗ `count`, А НЕ ИЗ ДЛИНЫ ОТВЕТА. У INSERT
      // без RETURNING ответ пуст всегда, и `rows.length` означал бы «ничего не
      // записалось» при каждой записи. На этом признаке держится применитель:
      // `journal` отличает новую операцию от повтора ровно по нему, и с нулём
      // весь пакет тихо считался дубликатом — ни строки в базе, ни ошибки
      // (поймано apply.pg.test.ts). Bun отдаёт `count` (и `affectedRows`) на
      // результате команды; длина остаётся запасным вариантом для SELECT.
      return { changes: rows.count ?? rows.length };
    },
    async raw<T>(sqlText: string, params: readonly unknown[] = []): Promise<T[]> {
      return ((await sql.unsafe(sqlText, [...params])) as Row[]).map(renderRow) as T[];
    },
  };
}

/**
 * Имя приложения в соединении. Его видно в `pg_stat_activity`, и это
 * единственный способ ответить администратору «кто держит эти десять
 * соединений» — без него в списке одна безымянная роль. Заданное в самой
 * строке подключения имя уважается: у развёртывания могут быть свои правила.
 */
export const APP_NAME = "myc";

function labelled(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.get("application_name") === null) {
      u.searchParams.set("application_name", APP_NAME);
    }
    return u.toString();
  } catch {
    // Непарсимую строку отдаём как есть: разбирать её — дело драйвера, и
    // падать здесь ради метки было бы обменом нужного на приятное.
    return url;
  }
}

export function openPostgres(options: PostgresOpenOptions | string): PostgresDriver {
  const url = labelled(typeof options === "string" ? options : options.url);
  const max = typeof options === "string" ? POOL_MAX_DEFAULT : (options.max ?? POOL_MAX_DEFAULT);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`postgres: pool size must be a positive integer, got ${String(max)}`);
  }
  const sql = new SQL({ url, max });
  const base = driverOn(sql);
  return {
    ...base,
    async withTenant<T>(tenant: string, fn: (tx: AsyncDbDriver) => Promise<T>): Promise<T> {
      if (tenant.length === 0) {
        throw new Error("postgres: tenant must not be empty — an empty tenant sees nothing (RLS fails closed)");
      }
      return (await sql.begin(async (tx: SQL) => {
        // SET LOCAL живёт до конца транзакции: соединение возвращается в пул
        // без арендатора, и следующий, кто его возьмёт, не унаследует чужого.
        await tx.unsafe("SELECT set_config('myc.tenant', $1, true)", [tenant]);
        return await fn(driverOn(tx));
      })) as T;
    },
    async withTransaction<T>(fn: (tx: AsyncDbDriver) => Promise<T>): Promise<T> {
      return (await sql.begin(async (tx: SQL) => fn(driverOn(tx)))) as T;
    },
    async close(): Promise<void> {
      await sql.close();
    },
  };
}
