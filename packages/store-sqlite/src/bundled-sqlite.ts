/**
 * Какую SQLite везёт пакет и где лежит стенд старой (memory-yxzsp11cpv6x) —
 * одно место для scripts/build-sqlite.ts, scripts/pack-npm.ts и тестов.
 *
 * Рантайм этот модуль не импортирует: он ищет библиотеку по имени файла
 * (BUNDLED_SQLITE_FILE в ./runtime.ts), а версия, хеши и флаги нужны только
 * сборке и её проверкам.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface SqliteRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  /** Опубликован на sqlite.org/download.html рядом со ссылкой — сверяется глазами. */
  readonly sha3_256: string;
}

export const SQLITE_RELEASES = {
  /** Своя библиотека пакета. Не ниже SQLITE_RECOMMENDED_VERSION — сверяется при сборке и тестом. */
  bundled: {
    version: "3.53.4",
    url: "https://sqlite.org/2026/sqlite-amalgamation-3530400.zip",
    sha256: "1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d",
    sha3_256: "628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e",
  },
  /** Системная SQLite macOS 14 (и 15: SDK MacOSX15.sdk) — стенд сквозного теста и шага CI. */
  old: {
    version: "3.43.2",
    url: "https://sqlite.org/2023/sqlite-amalgamation-3430200.zip",
    sha256: "a17ac8792f57266847d57651c5259001d1e4e4b46be96ec0d985c953925b2a1c",
    sha3_256: "af02b88cc922e7506c6659737560c0756deee24e4e7741d4b315af341edd8b40",
  },
} as const satisfies Record<string, SqliteRelease>;

/**
 * Флаги — те же, что у SQLite, встроенной в Bun на Linux (снято
 * `pragma compile_options` у Bun 1.3.14): на macOS и Linux работает одна
 * конфигурация движка, и тесты CI (Linux) проверяют то же, что получит
 * пользователь macOS. Сверх неё: HAVE_USLEEP (без него обработчик
 * busy_timeout спит целыми секундами) и USE_URI (было у системной и у
 * Homebrew). Загрузка расширений в амальгамате включена по умолчанию (нет
 * SQLITE_OMIT_LOAD_EXTENSION) — сборка проверяет её загрузкой vec0.
 */
export const SQLITE_COMPILE_FLAGS = [
  "-O2",
  "-DSQLITE_THREADSAFE=1",
  "-DHAVE_USLEEP=1",
  "-DSQLITE_ENABLE_FTS5",
  "-DSQLITE_ENABLE_FTS3",
  "-DSQLITE_ENABLE_FTS3_PARENTHESIS",
  "-DSQLITE_ENABLE_RTREE",
  "-DSQLITE_ENABLE_MATH_FUNCTIONS",
  "-DSQLITE_ENABLE_COLUMN_METADATA",
  "-DSQLITE_MAX_VARIABLE_NUMBER=250000",
  "-DSQLITE_USE_URI=1",
] as const;

/**
 * Куда сборка кладёт свою библиотеку: packages/store-sqlite/vendor/sqlite.
 * Тот же путь рантайм находит ОТ ИСХОДНИКОВ (`<src>/../vendor/sqlite`), а
 * в пакете — от бандла (`dist/../vendor/sqlite`), куда её копирует pack-npm.
 */
export const BUNDLED_SQLITE_OUT_DIR = join(import.meta.dir, "..", "vendor", "sqlite");

/** Кеш архивов амальгамата: MYC_SQLITE_CACHE, иначе ~/.cache/myc/sqlite (CI держит его в actions/cache). */
export function sqliteCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MYC_SQLITE_CACHE;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".cache", "myc", "sqlite");
}

/** Стенд старой SQLite: здесь его ищет сквозной тест, сюда его кладёт CI. */
export function sqliteStandDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(sqliteCacheDir(env), `stand-${SQLITE_RELEASES.old.version}`);
}
