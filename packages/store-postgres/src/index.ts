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
export interface AsyncDbDriver {
  readonly dialect: "pg";
  one<T>(query: QueryDef, params: readonly unknown[]): Promise<T | undefined>;
  all<T>(query: QueryDef, params: readonly unknown[]): Promise<T[]>;
  run(query: QueryDef, params: readonly unknown[]): Promise<{ changes: number }>;
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
  close(): Promise<void>;
}

export interface PostgresOpenOptions {
  readonly url: string;
}

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
      const rows = (await sql.unsafe(text(query), [...params])) as Row[];
      // Драйвер Bun не отдаёт число затронутых строк отдельным полем, а
      // RETURNING есть не у каждого запроса: считаем то, что вернулось, и не
      // выдаём догадку за факт — вызывающему нужен признак «было/не было».
      return { changes: rows.length };
    },
    async raw<T>(sqlText: string, params: readonly unknown[] = []): Promise<T[]> {
      return ((await sql.unsafe(sqlText, [...params])) as Row[]).map(renderRow) as T[];
    },
  };
}

export function openPostgres(options: PostgresOpenOptions | string): PostgresDriver {
  const url = typeof options === "string" ? options : options.url;
  const sql = new SQL(url);
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
    async close(): Promise<void> {
      await sql.close();
    },
  };
}
