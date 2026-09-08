import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Рантайм SQLite с поддержкой расширений (docs/design/01a-ddl-validation.md, приложение К.1).
//
// Встроенная в Bun сборка SQLite собрана без SQLITE_ENABLE_LOAD_EXTENSION, поэтому
// sqlite-vec из коробки не грузится. Обход: Database.setCustomSQLite(<путь к
// libsqlite3 с поддержкой расширений>) — обязан вызываться ДО открытия первого
// соединения в процессе (включая соединения, которые открывают тесты):
// после первого `new Database` Bun автозагружает встроенный SQLite, и
// setCustomSQLite падает с "SQLite already loaded".

export type SqliteRuntimeSource =
  | "env"
  | "binary-dir"
  | "bun-cache"
  | "homebrew"
  | "system"
  | "builtin";

export interface SqliteRuntimeCandidate {
  readonly path: string;
  readonly source: SqliteRuntimeSource;
}

export interface SqliteRuntimeState {
  readonly sqlite: {
    /** Кастомная libsqlite3 или null, если работает встроенная в Bun сборка. */
    readonly path: string | null;
    readonly version: string;
    /** Загрузка расширений реально работает в этом процессе. */
    readonly extensions: boolean;
    readonly source: SqliteRuntimeSource | null;
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

let cached: SqliteRuntimeState | null = null;

/**
 * Однократная идемпотентная инициализация рантайма SQLite.
 * Вызывается перед первым `new Database` (openSqlite делает это сам).
 *
 * - MYC_SQLITE / MYC_SQLITE_VEC заданы, но не работают — бросает понятную ошибку
 *   (явная конфигурация обязана работать, тихий фолбэк запрещён).
 * - Пригодная libsqlite3 / vec0 не найдены — НЕ бросает: состояние деградации
 *   видно в возвращаемой структуре (инвариант И2), BM25, граф и задачи работают.
 *
 * Если в процессе уже открыто соединение, а пригодная библиотека нашлась —
 * бросает громкую ошибку программиста: setCustomSQLite опоздал.
 */
export function ensureSqliteRuntime(
  options: SqliteRuntimeOptions = {},
): SqliteRuntimeState {
  if (cached) return cached;
  cached = initRuntime(options);
  return cached;
}

/** Состояние рантайма или null до первой инициализации (для myc doctor). */
export function getSqliteRuntimeState(): SqliteRuntimeState | null {
  return cached;
}

/**
 * Загружает vec0 в конкретное соединение (расширения в SQLite грузятся
 * на соединение). Вызывать после каждого `new Database`.
 */
export function applySqliteRuntime(db: Database): void {
  if (!cached) {
    throw new Error(
      "runtime SQLite не инициализирован: ensureSqliteRuntime() обязан вызываться до открытия соединения",
    );
  }
  if (!cached.vec.loaded) return;
  db.loadExtension(cached.vec.path!);
}

function initRuntime(options: SqliteRuntimeOptions): SqliteRuntimeState {
  const libCandidates =
    options.libCandidates ?? buildLibCandidates();
  const triedLibs: string[] = [];

  let lib: SqliteRuntimeCandidate | null = null;
  for (const candidate of libCandidates) {
    if (!existsSync(candidate.path)) {
      if (candidate.source === "env") {
        throw new Error(
          `MYC_SQLITE=${candidate.path}: библиотека задана явно, но файла нет ` +
            "(явная конфигурация не может молча откатываться на автопоиск)",
        );
      }
      triedLibs.push(`${candidate.path} — нет файла`);
      continue;
    }
    let ok: boolean;
    try {
      ok = Database.setCustomSQLite(candidate.path);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes(ALREADY_LOADED)) {
        throw new Error(
          "ensureSqliteRuntime() вызван после открытия первого соединения: " +
            "Database.setCustomSQLite обязан выполняться до первого new Database " +
            "(включая соединения, которые открывают тесты). " +
            `Исходная ошибка: ${message}`,
        );
      }
      if (candidate.source === "env") {
        throw new Error(
          `MYC_SQLITE=${candidate.path}: библиотека задана явно, но не загружается: ${message}`,
        );
      }
      triedLibs.push(`${candidate.path} — ${message}`);
      continue;
    }
    if (ok) {
      lib = candidate;
      break;
    }
    if (candidate.source === "env") {
      throw new Error(
        `MYC_SQLITE=${candidate.path}: библиотека задана явно, но setCustomSQLite её не принял`,
      );
    }
    triedLibs.push(`${candidate.path} — setCustomSQLite вернул false`);
  }

  const probe = new Database(":memory:");
  try {
    const sqliteVersion = scalarText(probe, "select sqlite_version()");

    if (!lib) {
      return freezeState({
        sqlite: {
          path: null,
          version: sqliteVersion,
          extensions: false,
          source: "builtin",
          reason:
            "libsqlite3 с поддержкой загрузки расширений не найдена — используется встроенная в Bun сборка " +
            "(без неё sqlite-vec не грузится). Проверяли: " +
            (triedLibs.join("; ") || "—"),
        },
        vec: {
          loaded: false,
          path: null,
          version: null,
          source: null,
          reason: "нет libsqlite3 с поддержкой загрузки расширений — vec0 не загружается",
        },
      });
    }

    const vecCandidates =
      options.vecCandidates ?? buildVecCandidates();
    const triedVecs: string[] = [];
    let vec: ResolvedVec | null = null;

    for (const candidate of vecCandidates) {
      if (!existsSync(candidate.path)) {
        if (candidate.source === "env") {
          throw new Error(
            `MYC_SQLITE_VEC=${candidate.path}: расширение задано явно, но файла нет ` +
              "(явная конфигурация не может молча откатываться на автопоиск)",
          );
        }
        triedVecs.push(`${candidate.path} — нет файла`);
        continue;
      }
      try {
        probe.loadExtension(candidate.path);
        const version = scalarText(probe, "select vec_version()");
        vec = {
          loaded: true,
          path: candidate.path,
          version,
          source: candidate.source,
          reason: null,
        };
        break;
      } catch (error) {
        const message = (error as Error).message;
        if (candidate.source === "env") {
          throw new Error(
            `MYC_SQLITE_VEC=${candidate.path}: расширение задано явно, но не загружается: ${message}`,
          );
        }
        triedVecs.push(`${candidate.path} — ${message}`);
      }
    }

    if (vec) {
      return freezeState({
        sqlite: {
          path: lib.path,
          version: sqliteVersion,
          extensions: true,
          source: lib.source,
          reason: null,
        },
        vec,
      });
    }

    // vec0 не загрузился: различаем «библиотека без поддержки расширений»
    // и «библиотека умеет, расширение не нашлось/не грузится».
    if (!supportsExtensionLoading(probe)) {
      return freezeState({
        sqlite: {
          path: lib.path,
          version: sqliteVersion,
          extensions: false,
          source: lib.source,
          reason:
            `библиотека ${lib.path} не поддерживает загрузку расширений ` +
            "(нет SQLITE_ENABLE_LOAD_EXTENSION)",
        },
        vec: {
          loaded: false,
          path: null,
          version: null,
          source: null,
          reason: "библиотека без поддержки загрузки расширений — vec0 не загружается",
        },
      });
    }

    return freezeState({
      sqlite: {
        path: lib.path,
        version: sqliteVersion,
        extensions: true,
        source: lib.source,
        reason: null,
      },
      vec: {
        loaded: false,
        path: null,
        version: null,
        source: null,
        reason:
          "vec0 не найден или не загрузился. Проверяли: " +
          (triedVecs.join("; ") || "—"),
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

/**
 * Кандидаты libsqlite3 в порядке приоритета: MYC_SQLITE → рядом с бинарём →
 * Homebrew → системные пути. Первая пригодная берётся, остальные не трогаются.
 * @internal для тестов
 */
export function buildLibCandidates(
  platform: NodeJS.Platform = process.platform,
  execDir: string = dirname(process.execPath),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SqliteRuntimeCandidate[] {
  const out: SqliteRuntimeCandidate[] = [];
  if (env.MYC_SQLITE) out.push({ path: env.MYC_SQLITE, source: "env" });

  if (platform === "darwin") {
    out.push(
      { path: join(execDir, "libsqlite3.dylib"), source: "binary-dir" },
      { path: "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", source: "homebrew" },
      { path: "/usr/local/opt/sqlite/lib/libsqlite3.dylib", source: "homebrew" },
      { path: "/usr/lib/libsqlite3.dylib", source: "system" },
    );
  } else {
    for (const name of ["libsqlite3.so", "libsqlite3.so.0"]) {
      out.push({ path: join(execDir, name), source: "binary-dir" });
    }
    for (const dir of [
      "/usr/lib/x86_64-linux-gnu",
      "/lib/x86_64-linux-gnu",
      "/usr/lib/aarch64-linux-gnu",
      "/lib/aarch64-linux-gnu",
    ]) {
      out.push({ path: join(dir, "libsqlite3.so.0"), source: "system" });
    }
    for (const dir of ["/usr/lib", "/lib"]) {
      for (const name of ["libsqlite3.so.0", "libsqlite3.so"]) {
        out.push({ path: join(dir, name), source: "system" });
      }
    }
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
