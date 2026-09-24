import { Database } from "bun:sqlite";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Рантайм SQLite (docs/design/01a-ddl-validation.md, приложение К.1) — ДВЕ
// СТУПЕНИ, и у каждой своя цена и своё время.
//
// (а) БИБЛИОТЕКА — всегда, на любом пути открытия, до первого `new Database`
//     в процессе. Database.setCustomSQLite работает только до первого
//     соединения: после него Bun уже загрузил свою SQLite и отвечает
//     "SQLite already loaded". Ступень дешёвая: existsSync + dlopen, замер
//     2026-09-15 (macOS arm64, Bun 1.3.14, медиана 15 процессов) — открытие
//     со своей библиотекой 1.4–2.6 мс против 5.4 мс у системной SQLite, которую
//     Bun на macOS грузит сам. То есть выбор не стоит ничего, а часто экономит.
// (б) vec0 — лениво, только тем, кто просит вектор (решение S45): `show`,
//     `ready`, `close` его не грузят. Расширение грузится на соединение
//     (applySqliteRuntime), первое — ~0.4 мс, следующие ~0.06 мс.
//
// ПОЧЕМУ (а) ОБЯЗАНА БЫТЬ ВЕЗДЕ (GitHub issue #1, memory-yxzsp11cpv6x). Прежде
// библиотеку выбирал только путь с расширениями, а лёгкий путь CLI открывал
// то, что Bun грузит сам. На macOS это СИСТЕМНАЯ SQLite: на macOS 14 — 3.43.2,
// где FTS5 ещё не помечен innocuous, и триггеры, пишущие в nodes_fts, под
// `PRAGMA trusted_schema = OFF` запрещены — `remember` и `create` падали
// «unsafe use of virtual table "nodes_fts"», хотя Homebrew 3.53 стоял рядом, а
// явная MYC_SQLITE лёгким путём не читалась вовсе.
//
// ВЕРСИЯ — ДО ЗАГРУЗКИ: вторую библиотеку в процесс не поставишь. Своя
// библиотека из пакета (scripts/build-sqlite.ts) и явная MYC_SQLITE не
// проверяются заранее (своя собрана из зашитого амальгамата, явная — выбор
// человека); Homebrew — по realpath (`Cellar/sqlite/<версия>`, 0.04 мс);
// прочее — через bun:ffi `sqlite3_libversion_number` (7 мс медиана: первый
// dlopen через ffi поднимает TinyCC — дорого, поэтому только запасной путь).
// После загрузки действующая версия меряется в любом случае: решает она.
//
// LINUX. Bun там линкует SQLite статически (3.50.4 в Bun 1.3.0, 3.53.0 в
// 1.3.14, 3.53.2 в 1.4.2), встроенная умеет loadExtension, а setCustomSQLite
// возвращает true и НЕ МЕНЯЕТ НИЧЕГО — проверено в Docker на Debian 12,
// Ubuntu 22.04/24.04: после «успешного» setCustomSQLite(системная 3.37.2)
// работает та же 3.53.0. Прежний список кандидатов (системные libsqlite3.so.0)
// был поэтому фикцией: состояние называло системную библиотеку, а работала
// встроенная. Кандидатов на Linux нет, кроме явной MYC_SQLITE, — а её,
// раз Bun её не применит, приходится отвергать вслух.

export type SqliteRuntimeSource =
  | "env"
  | "bundled"
  | "binary-dir"
  | "bun-cache"
  | "homebrew"
  | "system"
  | "builtin";

/**
 * Минимум — 3.50.4, и у него ДВЕ причины, младшая из которых 3.44.0.
 *
 * 3.44.0: ниже FTS5 не innocuous и не пишется из триггера при
 * trusted_schema=OFF — падает всякая запись («unsafe use of virtual table
 * nodes_fts», issue #1).
 *
 * 3.50.4: на 3.43.2 и 3.46.0 ИЗМЕРЕНЫ дубли работ очереди — параллельные CLI
 * выполняли одну работу 2–3 раза, а fail ловил «database disk image is
 * malformed» (memory-e82awcx1ms0b, 2026-09-15). Причина не найдена, и потому
 * порог поставлен не по ней, а по тому, что ДОСТУПНО: 3.50.4 — SQLite
 * минимально поддерживаемого Bun (engines: bun >= 1.3.0; Bun 1.3.0 — 3.50.4,
 * 1.3.14 — 3.53.0, замер в образе 2026-09-24), а на macOS пакет несёт свою
 * 3.53.4. То есть ни одной поддерживаемой конфигурации порог не запирает:
 * ниже него библиотека берётся только из неподдерживаемого Bun или явной
 * MYC_SQLITE, а пускать туда, где дубли измерены, незачем — ремонта у такой
 * базы нет, а работа выполняется дважды молча.
 */
export const SQLITE_MIN_VERSION = "3.50.4";
/**
 * Ниже — WARN `degraded.sqlite_old`: на 3.43.2 и 3.46.0 параллельные CLI
 * выполняют работы очереди по 2–3 раза, а fail ловит «database disk image is
 * malformed»; 3.51.2 — наименьшая версия, на которой это не воспроизвелось
 * (стенд memory-e82awcx1ms0b, 9 прогонов из 9).
 */
export const SQLITE_RECOMMENDED_VERSION = "3.51.2";
export const SQLITE_OLD_BUG = "memory-e82awcx1ms0b";
/**
 * Своя SQLite в пакете (scripts/build-sqlite.ts). Имя СВОЁ, а не
 * libsqlite3.dylib: dyld ищет в DYLD_LIBRARY_PATH по последнему компоненту
 * пути даже для абсолютного dlopen, и чужой libsqlite3.dylib оттуда подменил
 * бы нашу молча (проверено: setCustomSQLite(Homebrew) под DYLD_LIBRARY_PATH со
 * старой libsqlite3.dylib даёт 3.43.2, с уникальным именем — 3.53.4).
 */
export const BUNDLED_SQLITE_FILE = "libmyc-sqlite3.dylib";

export interface SqliteRuntimeCandidate {
  readonly path: string;
  readonly source: SqliteRuntimeSource;
}

/**
 * ok — не ниже SQLITE_RECOMMENDED_VERSION; old — работает, но ниже
 * рекомендованной (WARN); unsupported — ниже минимума, запись невозможна
 * (громкий отказ каждого пути открытия).
 */
export type SqliteSupport = "ok" | "old" | "unsupported";

/** Итог ступени (а): какая SQLite действует в этом процессе и почему. */
export interface SqliteLibraryState {
  /** Выбранная библиотека или null, если работает та, что Bun грузит сам. */
  readonly path: string | null;
  readonly source: SqliteRuntimeSource;
  /** Действующая версия — измеренная после загрузки, а не заявленная. */
  readonly version: string;
  readonly support: SqliteSupport;
  /** Пропущенные кандидаты с причиной — для `myc doctor`. */
  readonly skipped: readonly string[];
  /**
   * Выбор не состоялся: SQLite загрузил кто-то раньше (соединение, открытое
   * мимо ensureSqliteLibrary). null — выбор состоялся штатно.
   */
  readonly locked: string | null;
  /** Что не так (old/unsupported); null, если всё в порядке. */
  readonly problem: string | null;
  /** Что с этим сделать; null, если делать нечего. */
  readonly hint: string | null;
}

export interface SqliteRuntimeState {
  readonly sqlite: {
    /** Кастомная libsqlite3 или null, если работает та, что Bun грузит сам. */
    readonly path: string | null;
    readonly version: string;
    /** Загрузка расширений реально работает в этом процессе. */
    readonly extensions: boolean;
    readonly source: SqliteRuntimeSource | null;
    readonly support: SqliteSupport;
    /** Почему деградация (extensions = false); null, если деградации нет. */
    readonly reason: string | null;
  };
  readonly vec: {
    readonly loaded: boolean;
    readonly path: string | null;
    readonly version: string | null;
    readonly source: SqliteRuntimeSource | null;
    /** Почему векторный поиск недоступен; null, если vec0 загружен. */
    readonly reason: string | null;
  };
}

export interface SqliteRuntimeOptions {
  /** Полная замена списка кандидатов libsqlite3 (для тестов деградации). */
  readonly libCandidates?: readonly SqliteRuntimeCandidate[];
  /** Полная замена списка кандидатов vec0 (для тестов деградации). */
  readonly vecCandidates?: readonly SqliteRuntimeCandidate[];
}

/**
 * Явная настройка (MYC_SQLITE) не работает. Тихий откат к автопоиску
 * запрещён: человек назвал библиотеку и должен узнать, что получил не её.
 */
export class SqliteConfigError extends Error {
  readonly code = "precond.sqlite_config";
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "SqliteConfigError";
  }
}

/** Действующая SQLite ниже SQLITE_MIN_VERSION: запись в ней невозможна. */
export class SqliteUnsupportedError extends Error {
  readonly code = "precond.sqlite_unsupported";
  readonly hint: string;
  constructor(readonly state: SqliteLibraryState) {
    super(state.problem ?? `SQLite ${state.version} is older than ${SQLITE_MIN_VERSION}`);
    this.name = "SqliteUnsupportedError";
    this.hint = state.hint ?? "";
  }
}

interface ResolvedVec {
  readonly loaded: boolean;
  readonly path: string | null;
  readonly version: string | null;
  readonly source: SqliteRuntimeSource | null;
  readonly reason: string | null;
}

const EXTENSION_UNSUPPORTED = /does not support dynamic extension loading/i;
/**
 * Сообщение bun:sqlite при `setCustomSQLite` после первого соединения.
 * Экспортируется, чтобы тест сверялся С НЕЙ, а не со своей копией строки:
 * разойдясь, копия сделала бы тест зелёным на изменившемся поведении.
 */
export const ALREADY_LOADED_MESSAGE = "SQLite already loaded";
const ALREADY_LOADED = ALREADY_LOADED_MESSAGE;

let library: SqliteLibraryState | null = null;
let libraryError: SqliteConfigError | null = null;
let runtime: SqliteRuntimeState | null = null;

/**
 * Ступень (а) без проверки версии: выбрать библиотеку один раз на процесс.
 * Для мест, которым отказ по версии не нужен (чтение, диагностика) — отказ
 * им скажет следующий путь открытия. Бросает только SqliteConfigError
 * (нерабочая явная MYC_SQLITE), и бросает её при каждом вызове.
 */
export function selectSqliteLibrary(options: SqliteRuntimeOptions = {}): SqliteLibraryState {
  if (library !== null) return library;
  if (libraryError !== null) throw libraryError;
  try {
    library = Object.freeze(chooseLibrary(options.libCandidates ?? buildLibCandidates()));
  } catch (error) {
    if (error instanceof SqliteConfigError) libraryError = error;
    throw error;
  }
  return library;
}

/**
 * Ступень (а) с проверкой версии — её обязан звать КАЖДЫЙ путь открытия
 * базы до своего `new Database`. Идемпотентна и дешева после первого вызова.
 * Действующая SQLite ниже минимума — SqliteUnsupportedError при каждом
 * вызове: запись в такой базе невозможна, и человек должен узнать это из
 * отказа с лекарством, а не из `internal.unexpected` на первом триггере.
 */
export function ensureSqliteLibrary(options: SqliteRuntimeOptions = {}): SqliteLibraryState {
  const state = selectSqliteLibrary(options);
  if (state.support === "unsupported") throw new SqliteUnsupportedError(state);
  return state;
}

/** Итог ступени (а) или null до выбора; не бросает (для `myc doctor`). */
export function getSqliteLibraryState(): SqliteLibraryState | null {
  return library;
}

/**
 * Обе ступени: библиотека и vec0. Идемпотентна: следующие вызовы получают
 * закешированное состояние.
 *
 * - MYC_SQLITE / MYC_SQLITE_VEC заданы, но не работают — бросает понятную ошибку
 *   (явная конфигурация обязана работать, тихий фолбэк запрещён).
 * - Действующая SQLite ниже минимума — SqliteUnsupportedError.
 * - vec0 не найден или библиотека не умеет расширения — НЕ бросает: состояние
 *   деградации видно в возвращаемой структуре (инвариант И2), BM25, граф и
 *   задачи работают.
 */
export function ensureSqliteRuntime(options: SqliteRuntimeOptions = {}): SqliteRuntimeState {
  const lib = ensureSqliteLibrary(options);
  if (runtime !== null) return runtime;
  runtime = resolveVec(lib, options.vecCandidates ?? buildVecCandidates());
  return runtime;
}

/** Состояние рантайма или null до первой инициализации (для myc doctor). */
export function getSqliteRuntimeState(): SqliteRuntimeState | null {
  return runtime;
}

/**
 * Загружает vec0 в конкретное соединение (расширения в SQLite грузятся
 * на соединение). Вызывать после каждого `new Database`.
 */
export function applySqliteRuntime(db: Database): void {
  if (!runtime) {
    throw new Error(
      "SQLite runtime not initialized: ensureSqliteRuntime() must be called before a connection is opened",
    );
  }
  if (!runtime.vec.loaded) return;
  db.loadExtension(runtime.vec.path!);
}

// ---------------------------------------------------------------------------
// Ступень (а): выбор библиотеки
// ---------------------------------------------------------------------------

function chooseLibrary(candidates: readonly SqliteRuntimeCandidate[]): SqliteLibraryState {
  const skipped: string[] = [];
  let chosen: SqliteRuntimeCandidate | null = null;
  let locked: string | null = null;

  for (const candidate of candidates) {
    const isEnv = candidate.source === "env";
    if (!existsSync(candidate.path)) {
      if (isEnv) {
        throw new SqliteConfigError(
          `MYC_SQLITE=${candidate.path}: the library is set explicitly, but the file does not exist ` +
            "(an explicit setting cannot silently fall back to auto-discovery)",
          "point MYC_SQLITE at an existing libsqlite3 or unset it",
        );
      }
      skipped.push(`${candidate.path} — no file`);
      continue;
    }
    // Своя из пакета собрана из зашитого амальгамата, явную выбрал человек:
    // их версию решает замер после загрузки. Остальные — до неё.
    if (!isEnv && candidate.source !== "bundled") {
      const known = probeCandidateVersion(candidate);
      if (known !== null && compareSqliteVersions(known, SQLITE_MIN_VERSION) < 0) {
        skipped.push(`${candidate.path} — SQLite ${known}, below the minimum ${SQLITE_MIN_VERSION}`);
        continue;
      }
    }
    let ok: boolean;
    try {
      ok = Database.setCustomSQLite(candidate.path);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes(ALREADY_LOADED)) {
        // Опоздали: соединение уже открыто мимо ensureSqliteLibrary. Чужой
        // процесс (MCP-сервер, тест) — не поломка воркспейса; работаем на
        // том, что загружено, и называем это. Решает всё равно версия ниже.
        locked =
          "SQLite was already loaded in this process before the library was chosen, so " +
          `${candidate.path} (${candidate.source}) could not apply: ensureSqliteLibrary() / ` +
          "ensureSqliteRuntime() must run before the first new Database. " +
          `Original error: ${message}`;
        if (isEnv) {
          throw new SqliteConfigError(
            `MYC_SQLITE=${candidate.path}: ${locked}`,
            "open the database through @myc/store-sqlite, which chooses the library first",
          );
        }
        break;
      }
      if (isEnv) {
        throw new SqliteConfigError(
          `MYC_SQLITE=${candidate.path}: the library is set explicitly, but it does not load: ${message}`,
          "point MYC_SQLITE at a working libsqlite3 for this CPU or unset it",
        );
      }
      skipped.push(`${candidate.path} — ${message}`);
      continue;
    }
    if (ok) {
      chosen = candidate;
      break;
    }
    if (isEnv) {
      throw new SqliteConfigError(
        `MYC_SQLITE=${candidate.path}: the library is set explicitly, but setCustomSQLite rejected it`,
        "point MYC_SQLITE at a working libsqlite3 or unset it",
      );
    }
    skipped.push(`${candidate.path} — setCustomSQLite returned false`);
  }

  // Действующая версия — единственная, что имеет значение. Меряется всегда:
  // заранее известная версия могла соврать (подмена через DYLD_LIBRARY_PATH).
  const probe = new Database(":memory:");
  let version: string;
  let sourceId: string;
  try {
    version = scalarText(probe, "select sqlite_version()");
    sourceId = scalarText(probe, "select sqlite_source_id()");
  } finally {
    probe.close();
  }

  // Bun со статической SQLite (Linux) принимает любой путь и не меняет ничего.
  // Проверяется только там и только для выбранной: dlopen через ffi дорог.
  if (chosen !== null && process.platform !== "darwin" && ffiSourceId(chosen.path) !== sourceId) {
    const why = `Bun on ${process.platform} runs the SQLite built into it and ignores Database.setCustomSQLite`;
    if (chosen.source === "env") {
      throw new SqliteConfigError(
        `MYC_SQLITE=${chosen.path}: ${why} — the library in MYC_SQLITE is not the one that runs ` +
          `(active: SQLite ${version}, built into Bun)`,
        "unset MYC_SQLITE: on this platform bun:sqlite always uses the SQLite built into Bun",
      );
    }
    skipped.push(`${chosen.path} — ${why}`);
    chosen = null;
  }

  const base = {
    path: chosen?.path ?? null,
    source: chosen?.source ?? ("builtin" as const),
    version,
    support: sqliteSupport(version),
    skipped: Object.freeze(skipped),
    locked,
  };
  return { ...base, ...describeSupport(base) };
}

/** Версия кандидата до его загрузки; null — узнать не удалось. */
export function probeCandidateVersion(candidate: SqliteRuntimeCandidate): string | null {
  if (candidate.source === "homebrew") {
    try {
      const fromCellar = homebrewSqliteVersion(realpathSync(candidate.path));
      if (fromCellar !== null) return fromCellar;
    } catch {
      // битая ссылка — спросим саму библиотеку
    }
  }
  return ffiLibraryVersion(candidate.path);
}

/** `/opt/homebrew/Cellar/sqlite/3.53.4_1/lib/…` → "3.53.4". */
export function homebrewSqliteVersion(realPath: string): string | null {
  return /\/Cellar\/sqlite\/(\d+\.\d+\.\d+)/.exec(realPath)?.[1] ?? null;
}

interface FfiSqliteSymbols {
  readonly sqlite3_libversion_number: () => number;
  readonly sqlite3_sourceid: () => unknown;
}

function withFfiSqlite<T>(path: string, read: (symbols: FfiSqliteSymbols) => T): T | null {
  try {
    // Лениво: bun:ffi нужен только запасному пути, импорт на старте не нужен никому.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const lib = ffi.dlopen(path, {
      sqlite3_libversion_number: { args: [], returns: ffi.FFIType.i32 },
      sqlite3_sourceid: { args: [], returns: ffi.FFIType.cstring },
    });
    try {
      return read(lib.symbols as unknown as FfiSqliteSymbols);
    } finally {
      lib.close();
    }
  } catch {
    return null;
  }
}

function ffiLibraryVersion(path: string): string | null {
  return withFfiSqlite(path, (s) => versionFromNumber(s.sqlite3_libversion_number()));
}

function ffiSourceId(path: string): string | null {
  return withFfiSqlite(path, (s) => String(s.sqlite3_sourceid()));
}

/** 3053004 → "3.53.4" (формат SQLITE_VERSION_NUMBER). */
export function versionFromNumber(n: number): string {
  return `${Math.floor(n / 1_000_000)}.${Math.floor(n / 1000) % 1000}.${n % 1000}`;
}

/** Сравнение версий SQLite по компонентам: <0, 0, >0. */
export function compareSqliteVersions(a: string, b: string): number {
  return compareVersions(a, b);
}

export function sqliteSupport(version: string): SqliteSupport {
  if (compareSqliteVersions(version, SQLITE_MIN_VERSION) < 0) return "unsupported";
  if (compareSqliteVersions(version, SQLITE_RECOMMENDED_VERSION) < 0) return "old";
  return "ok";
}

/** Откуда действующая SQLite — одной фразой, для отказов и `myc doctor`. */
export function sqliteSourceLabel(
  state: Pick<SqliteLibraryState, "path" | "source" | "locked">,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (state.source) {
    case "env":
      return `MYC_SQLITE ${state.path}`;
    case "bundled":
      return `bundled with myc, ${state.path}`;
    case "binary-dir":
      return `next to the binary, ${state.path}`;
    case "homebrew":
      return `Homebrew, ${state.path}`;
    default:
      if (state.locked !== null) return "loaded in this process before myc could choose";
      return platform === "darwin"
        ? "the macOS system library Bun loads by default"
        : "built into Bun";
  }
}

function describeSupport(
  state: Pick<SqliteLibraryState, "path" | "source" | "version" | "support" | "locked">,
): { problem: string | null; hint: string | null } {
  if (state.support === "ok") return { problem: null, hint: null };
  const label = sqliteSourceLabel(state);
  const hint = remedy(state);
  if (state.support === "unsupported") {
    return {
      problem:
        `SQLite ${state.version} (${label}) is older than ${SQLITE_MIN_VERSION}, the minimum myc supports: ` +
        "below 3.44.0 FTS5 cannot be written from triggers under trusted_schema=OFF, so every write " +
        'fails with "unsafe use of virtual table nodes_fts"; and on 3.43.2 and 3.46.0 parallel myc ' +
        'processes were measured running one background job two or three times, with a failing job ' +
        `reporting "database disk image is malformed" (${SQLITE_OLD_BUG}). ` +
        `Every supported setup has ${SQLITE_MIN_VERSION} or newer: Bun 1.3.0 carries it, and on macOS myc ships its own`,
      hint,
    };
  }
  return {
    problem:
      `SQLite ${state.version} (${label}) is older than ${SQLITE_RECOMMENDED_VERSION}: parallel myc processes ` +
      'may run one background job 2-3 times, and a failing job may report "database disk image is ' +
      `malformed" (${SQLITE_OLD_BUG})`,
    hint,
  };
}

function remedy(state: Pick<SqliteLibraryState, "path" | "source">): string {
  const want = `SQLite >= ${SQLITE_RECOMMENDED_VERSION}`;
  if (state.source === "env") return `MYC_SQLITE=${state.path}: point it at ${want} or unset it`;
  if (process.platform !== "darwin") {
    return `upgrade Bun (bun upgrade): on ${process.platform} bun:sqlite always runs the SQLite built into Bun`;
  }
  return (
    `reinstall myc — its package ships ${want} (vendor/sqlite/${BUNDLED_SQLITE_FILE}), missing from this ` +
    `install; or brew install sqlite; or MYC_SQLITE=/path/to/libsqlite3.dylib (${want})`
  );
}

// ---------------------------------------------------------------------------
// Ступень (б): vec0
// ---------------------------------------------------------------------------

function resolveVec(
  lib: SqliteLibraryState,
  vecCandidates: readonly SqliteRuntimeCandidate[],
): SqliteRuntimeState {
  const probe = new Database(":memory:");
  try {
    const sqlite = {
      path: lib.path,
      version: lib.version,
      source: lib.source,
      support: lib.support,
    };

    // Сначала — умеет ли библиотека расширения вообще. Системная SQLite macOS
    // собрана с SQLITE_OMIT_LOAD_EXTENSION, и перебирать vec0 под ней незачем:
    // MYC_SQLITE_VEC при этом не «сломан» — не умеет библиотека.
    if (!supportsExtensionLoading(probe)) {
      return freezeState({
        sqlite: {
          ...sqlite,
          extensions: false,
          reason:
            lib.locked ??
            `libsqlite3 with extension loading support not found — SQLite ${lib.version} ` +
              `(${sqliteSourceLabel(lib)}) is built without it, so sqlite-vec does not load. ` +
              `Tried: ${lib.skipped.join("; ") || "—"}`,
        },
        vec: {
          loaded: false,
          path: null,
          version: null,
          source: null,
          reason: "the library has no extension loading support — vec0 does not load",
        },
      });
    }

    const triedVecs: string[] = [];
    let vec: ResolvedVec | null = null;
    for (const candidate of vecCandidates) {
      if (!existsSync(candidate.path)) {
        if (candidate.source === "env") {
          throw new Error(
            `MYC_SQLITE_VEC=${candidate.path}: the extension is set explicitly, but the file does not exist ` +
              "(an explicit setting cannot silently fall back to auto-discovery)",
          );
        }
        triedVecs.push(`${candidate.path} — no file`);
        continue;
      }
      try {
        probe.loadExtension(candidate.path);
        const version = scalarText(probe, "select vec_version()");
        vec = { loaded: true, path: candidate.path, version, source: candidate.source, reason: null };
        break;
      } catch (error) {
        const message = (error as Error).message;
        if (candidate.source === "env") {
          throw new Error(
            `MYC_SQLITE_VEC=${candidate.path}: the extension is set explicitly, but it does not load: ${message}`,
          );
        }
        triedVecs.push(`${candidate.path} — ${message}`);
      }
    }

    return freezeState({
      sqlite: { ...sqlite, extensions: true, reason: null },
      vec: vec ?? {
        loaded: false,
        path: null,
        version: null,
        source: null,
        reason: "vec0 not found or failed to load. Tried: " + (triedVecs.join("; ") || "—"),
      },
    });
  } finally {
    probe.close();
  }
}

function supportsExtensionLoading(probe: Database): boolean {
  try {
    probe.loadExtension("__myc_capability_probe_missing_ext__");
    return true;
  } catch (error) {
    return !EXTENSION_UNSUPPORTED.test((error as Error).message);
  }
}

function scalarText(db: Database, sql: string): string {
  const row = db.query(`${sql} as v`).get() as { v: unknown } | null;
  return String(row?.v ?? "");
}

function freezeState(state: SqliteRuntimeState): SqliteRuntimeState {
  return Object.freeze({
    sqlite: Object.freeze(state.sqlite),
    vec: Object.freeze(state.vec),
  });
}

// ---------------------------------------------------------------------------
// Кандидаты
// ---------------------------------------------------------------------------

/**
 * Кандидаты libsqlite3 в порядке приоритета. Первая пригодная берётся,
 * остальные не трогаются.
 *
 * macOS: MYC_SQLITE → своя из пакета (`<пакет>/vendor/sqlite`, а у
 * скомпилированного бинаря — рядом с ним) → libsqlite3.dylib рядом с
 * бинарём → Homebrew. Системной в списке нет: это ровно та SQLite, которую
 * Bun грузит сам, если не выбран никто.
 * Прочие платформы: только MYC_SQLITE — Bun там линкует SQLite статически
 * и чужую библиотеку не применяет (см. шапку файла).
 * @internal для тестов
 */
export function buildLibCandidates(
  platform: NodeJS.Platform = process.platform,
  execDir: string = dirname(process.execPath),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = import.meta.dir,
): SqliteRuntimeCandidate[] {
  const out: SqliteRuntimeCandidate[] = [];
  if (env.MYC_SQLITE) out.push({ path: env.MYC_SQLITE, source: "env" });

  if (platform === "darwin") {
    // Бандл пакета — dist/myc.js, и `..` от него ведёт в корень пакета; из
    // исходников тот же путь ведёт в packages/store-sqlite/vendor/sqlite,
    // куда кладёт сборку scripts/build-sqlite.ts.
    const bundled = [
      join(moduleDir, "..", "vendor", "sqlite", BUNDLED_SQLITE_FILE),
      join(execDir, BUNDLED_SQLITE_FILE),
    ];
    for (const path of new Set(bundled)) out.push({ path, source: "bundled" });
    out.push(
      { path: join(execDir, "libsqlite3.dylib"), source: "binary-dir" },
      { path: "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", source: "homebrew" },
      { path: "/usr/local/opt/sqlite/lib/libsqlite3.dylib", source: "homebrew" },
    );
  }
  void home;
  return out;
}

/**
 * Кандидаты vec0 в порядке приоритета: MYC_SQLITE_VEC → рядом с бинарём →
 * кеш bun (~/.bun/install/cache/sqlite-vec-*) → Homebrew.
 * @internal для тестов
 */
export function buildVecCandidates(
  platform: NodeJS.Platform = process.platform,
  execDir: string = dirname(process.execPath),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SqliteRuntimeCandidate[] {
  const file = platform === "darwin" ? "vec0.dylib" : "vec0.so";
  const out: SqliteRuntimeCandidate[] = [];
  if (env.MYC_SQLITE_VEC) out.push({ path: env.MYC_SQLITE_VEC, source: "env" });
  out.push({ path: join(execDir, file), source: "binary-dir" });

  const cacheDir = join(home, ".bun", "install", "cache");
  try {
    const dirs = readdirSync(cacheDir)
      .filter((name) => name.startsWith("sqlite-vec-"))
      .sort(compareVecCacheNames);
    for (const dir of dirs) {
      out.push({ path: join(cacheDir, dir, file), source: "bun-cache" });
    }
  } catch {
    // нет кеша bun — кандидатов из него просто не будет
  }

  if (platform === "darwin") {
    out.push(
      { path: "/opt/homebrew/opt/sqlite-vec/lib/vec0.dylib", source: "homebrew" },
      { path: "/usr/local/opt/sqlite-vec/lib/vec0.dylib", source: "homebrew" },
    );
  }
  return out;
}

/** Свежая версия выше: sqlite-vec-darwin-arm64@0.1.9@@@1 → 0.1.9. */
function compareVecCacheNames(a: string, b: string): number {
  const va = a.match(/@(\d+(?:\.\d+)+)/)?.[1];
  const vb = b.match(/@(\d+(?:\.\d+)+)/)?.[1];
  if (va && vb && va !== vb) return compareVersions(vb, va);
  return b.localeCompare(a);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
