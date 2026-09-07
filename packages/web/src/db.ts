/**
 * Соединение просмотрщика с базой: строго только для чтения.
 *
 * Три уровня запрета, а не один:
 *   1. `new Database(path, { readonly: true })` — SQLite отвергает любую
 *      запись на уровне движка («attempt to write a readonly database»).
 *      НО: база в WAL, из которой писатель вышел начисто, остаётся без
 *      -wal/-shm, и readonly-соединение такой файл читать не умеет
 *      (SQLITE_CANTOPEN на первом prepare). Тогда соединение пересоздаётся
 *      читаемым handle-ом — см. проверку готовности в openReadOnly;
 *   2. `PRAGMA query_only = 1` — отвергает запись на уровне соединения;
 *   3. здесь нет ни одной пишущей SQL-конструкции, ни миграций, ни
 *      `PRAGMA journal_mode` — то есть ни одной операции, которая берёт
 *      RESERVED-блокировку.
 *
 * Почему это важно: `myc viz` живёт часами в фоне, а CLI в это время пишет.
 * В WAL читатели и писатель не мешают друг другу — но только пока читатель
 * не пытается писать сам и не держит долгую транзакцию. Каждый запрос здесь
 * автономен, длинных транзакций нет вовсе.
 */

import { Database } from "bun:sqlite";

/** Пробуем ждать чекпойнт, а не падать: 2 с с запасом на fsync большого WAL. */
const BUSY_TIMEOUT_MS = 2000;

const READ_PRAGMAS = [
  `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`,
  "PRAGMA query_only = 1",
  "PRAGMA cache_size = -32768",
  "PRAGMA mmap_size = 268435456",
  "PRAGMA temp_store = MEMORY",
] as const;

export class VizDbError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VizDbError";
  }
}

export interface ReadOnlyDb {
  readonly path: string;
  one<T>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  /** Существует ли таблица/вьюха — все запросы ниже проходят через эту проверку. */
  has(name: string): boolean;
  /** Значение из myc_meta или undefined; на ненакатанной схеме — undefined. */
  meta(key: string): string | undefined;
  journalMode(): string;
  /**
   * Голое соединение bun:sqlite — только для передачи в чужие read-only
   * функции, ожидающие тип `Database` (например `compareModels` из
   * @myc/swarm). Запрет на запись по-прежнему держат PRAGMA query_only и,
   * при пересозданном handle, проверка выше — сам этот геттер прав не даёт.
   */
  raw(): Database;
  close(): void;
}

/**
 * Кеш подготовленных выражений: экраны перезапрашиваются каждые пару секунд,
 * а prepare одного скана графа стоит дороже самого скана.
 */
export function openReadOnly(path: string): ReadOnlyDb {
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new VizDbError("db.open", `не удалось открыть базу только на чтение: ${msg}`);
  }

  // Проверка ГОТОВНОСТИ чтения, а не только открытия. База в WAL после
  // чистого выхода писателя остаётся БЕЗ -wal/-shm, и readonly-соединение
  // такой файл открыть не может: любой prepare падает с SQLITE_CANTOPEN.
  // Проглотить это здесь значило бы показать человеку пустой просмотрщик
  // вместо данных (ровно то, что запрещает И2), поэтому соединение
  // пересоздаётся читаемым, а от записи его по-прежнему держит query_only.
  let writableHandle = false;
  try {
    db.query("SELECT 1 FROM sqlite_master LIMIT 1").all();
  } catch {
    db.close();
    try {
      db = new Database(path); // handle читаемый: SQLite сможет создать -shm
      writableHandle = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new VizDbError("db.open", `не удалось открыть базу: ${msg}`);
    }
    db.exec("PRAGMA query_only = 1");
  }

  for (const pragma of READ_PRAGMAS) {
    try {
      db.exec(pragma);
    } catch {
      // query_only/mmap_size на старом SQLite могут отсутствовать — не повод
      // ронять просмотрщик: query_only выше и отсутствие пишет-вызовов
      // в этом модуле держат запрет.
    }
  }
  if (writableHandle) {
    // query_only мог не исполниться (см. catch выше) — тогда запрет держит
    // только дисциплина этого модуля; сказать об этом вслух, а не молчать.
    const enforced = db.query("PRAGMA query_only").get() as { query_only?: number } | null;
    if (enforced?.query_only !== 1) {
      db.close();
      throw new VizDbError("db.open", "база без -wal/-shm открыта читаемым handle-ом, но query_only не поддержан — читать небезопасно");
    }
  }

  // bun:sqlite типизирует привязки узким объединением; на входе у нас
  // всегда скаляры, поэтому сужаем один раз здесь, а не в каждом запросе.
  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const cache = new Map<string, ReturnType<Database["query"]>>();
  const stmt = (sql: string): ReturnType<Database["query"]> => {
    let s = cache.get(sql);
    if (s === undefined) {
      s = db.query(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const tables = new Set<string>();
  let tablesLoaded = false;
  const loadTables = (): void => {
    if (tablesLoaded) return;
    try {
      const rows = db
        .query("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all() as Array<{ name: string }>;
      for (const r of rows) tables.add(r.name);
    } catch {
      // база пуста или недоступна — множество остаётся пустым
    }
    tablesLoaded = true;
  };

  return {
    path,
    one<T>(sql: string, params: readonly unknown[] = []): T | undefined {
      const row = stmt(sql).get(...(params as Binding[]));
      return (row === null ? undefined : row) as T | undefined;
    },
    all<T>(sql: string, params: readonly unknown[] = []): T[] {
      return stmt(sql).all(...(params as Binding[])) as T[];
    },
    has(name: string): boolean {
      loadTables();
      return tables.has(name);
    },
    meta(key: string): string | undefined {
      loadTables();
      if (!tables.has("myc_meta")) return undefined;
      const row = this.one<{ value: string }>(
        "SELECT value FROM myc_meta WHERE key = ?1",
        [key],
      );
      return row?.value;
    },
    journalMode(): string {
      try {
        const row = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
        return row?.journal_mode ?? "unknown";
      } catch {
        return "unknown";
      }
    },
    raw(): Database {
      return db;
    },
    close(): void {
      cache.clear();
      db.close();
    },
  };
}
