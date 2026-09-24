import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDriver } from "./index.ts";
import {
  ALREADY_LOADED_MESSAGE,
  BUNDLED_SQLITE_FILE,
  SQLITE_MIN_VERSION,
  SQLITE_OLD_BUG,
  SQLITE_RECOMMENDED_VERSION,
  buildLibCandidates,
  buildVecCandidates,
  compareSqliteVersions,
  ensureSqliteRuntime,
  getSqliteLibraryState,
  getSqliteRuntimeState,
  homebrewSqliteVersion,
  sqliteSupport,
  versionFromNumber,
  type SqliteRuntimeState,
} from "./runtime.ts";
import {
  BUNDLED_SQLITE_OUT_DIR as BUNDLED_OUT_DIR,
  SQLITE_RELEASES as RELEASES,
  sqliteStandDir as standDir,
} from "./bundled-sqlite.ts";

const RUNTIME_PATH = join(import.meta.dir, "runtime.ts");

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-runtime-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface FixtureResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runFixture(
  mode: string,
  env: Record<string, string | undefined> = {},
): Promise<FixtureResult> {
  const fixture = join(dir, `fixture-${mode}.ts`);
  writeFileSync(
    fixture,
    `
import { Database } from "bun:sqlite";
import { ensureSqliteLibrary, ensureSqliteRuntime } from ${JSON.stringify(RUNTIME_PATH)};
const mode = process.argv[2]!;
if (mode === "late-init") {
  new Database(":memory:");
}
try {
  if (mode === "candidates") {
    const libCandidates = JSON.parse(process.env.FIXTURE_CANDIDATES!);
    console.log("LIBRARY:" + JSON.stringify(ensureSqliteLibrary({ libCandidates })));
    process.exit(0);
  }
  const state =
    mode === "degraded"
      ? ensureSqliteRuntime({ libCandidates: [], vecCandidates: [] })
      : ensureSqliteRuntime();
  console.log("STATE:" + JSON.stringify(state));
  if (mode === "degraded") {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (x TEXT)");
    db.exec("INSERT INTO t VALUES ('works')");
    const n = db.query("SELECT count(*) AS n FROM t").get();
    console.log("BASIC:" + JSON.stringify(n));
    try {
      db.exec("CREATE VIRTUAL TABLE v USING vec0(id integer primary key, emb float32[4])");
      console.log("VECERR:none");
    } catch (error) {
      console.log("VECERR:" + (error as Error).message);
    }
    db.close();
  }
} catch (error) {
  console.error("FATAL:" + (error as Error).name + ":" + (error as Error).message);
  process.exit(1);
}
`,
  );
  const proc = Bun.spawn([process.execPath, "run", fixture, mode], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("ensureSqliteRuntime — инициализация", () => {
  test("идемпотентна: повторный вызов возвращает тот же замороженный объект", () => {
    const first = ensureSqliteRuntime();
    const second = ensureSqliteRuntime();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sqlite)).toBe(true);
    expect(Object.isFrozen(first.vec)).toBe(true);
  });

  test("безопасна после уже открытых соединений (инициализация уже случилась)", () => {
    const current = getSqliteRuntimeState();
    if (current === null) throw new Error("рантайм не инициализирован preload-ом");
    const db = new Database(":memory:");
    expect(db.query("select 1 as one").get()).toEqual({ one: 1 });
    db.close();
    expect(ensureSqliteRuntime()).toBe(current);
  });

  test("на машине с vec0: расширения работают, состояние полно и сериализуемо", () => {
    const state = ensureSqliteRuntime();
    if (!state.vec.loaded) {
      console.log(`[skip] vec0 на этой машине не загружен: ${state.vec.reason ?? state.sqlite.reason}`);
      return;
    }
    expect(state.sqlite.extensions).toBe(true);
    // Путь есть ровно у выбранной библиотеки: на macOS — своя/явная/Homebrew
    // (системная расширений не умеет), на Linux — null, работает встроенная.
    expect(state.sqlite.path === null).toBe(state.sqlite.source === "builtin");
    expect(state.sqlite.reason).toBeNull();
    expect(state.vec.loaded).toBe(true);
    expect(state.vec.path).not.toBeNull();
    expect(state.vec.version).toMatch(/^v?0\.\d+/);
    expect(state.vec.reason).toBeNull();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  test("openSqlite грузит vec0 в каждое новое соединение", () => {
    const state = ensureSqliteRuntime();
    if (!state.vec.loaded) {
      console.log(`[skip] vec0 недоступен: ${state.vec.reason}`);
      return;
    }
    const driver = openSqlite(join(dir, "apply.db"));
    try {
      const version = driver.database.query("select vec_version() as v").get() as {
        v: string;
      };
      expect(version.v).toMatch(/^v?0\.\d+/);
    } finally {
      driver.close();
    }
  });
});

describe("приёмка vec0: таблица создаётся, KNN работает", () => {
  test("vec0 int8[384] cosine: вставка через vec_int8, KNN-запрос возвращает ближайшего", () => {
    const state = ensureSqliteRuntime();
    if (!state.vec.loaded) {
      console.log(`[skip] vec0 недоступен: ${state.vec.reason}`);
      return;
    }
    const driver = openSqlite(join(dir, "knn.db"));
    try {
      const db = driver.database;
      db.exec(
        "CREATE VIRTUAL TABLE knn USING vec0(" +
          "id integer primary key, emb int8[384] distance_metric=cosine)",
      );
      const makeVec = (hotIndex: number): Buffer => {
        const bytes = Buffer.alloc(384);
        bytes[hotIndex] = 100;
        return bytes;
      };
      const insert = db.prepare("INSERT INTO knn(id, emb) VALUES (?1, vec_int8(?2))");
      insert.run(1, makeVec(0));
      insert.run(2, makeVec(1));

      const rows = db
        .query(
          "SELECT id, distance FROM knn WHERE emb MATCH vec_int8(?1) ORDER BY distance LIMIT 2",
        )
        .all(makeVec(0)) as Array<{ id: number; distance: number }>;
      expect(rows.length).toBe(2);
      expect(Number(rows[0]!.id)).toBe(1);
      expect(rows[0]!.distance).toBeCloseTo(0, 5);
    } finally {
      driver.close();
    }
  });
});

describe("громкая деградация и явные ошибки (субпроцессы)", () => {
  test("MYC_SQLITE на несуществующий путь — внятная ошибка, а не падение", async () => {
    const result = await runFixture("plain", { MYC_SQLITE: "/nonexistent/libsqlite3.dylib" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("MYC_SQLITE");
    expect(result.stderr).toContain("/nonexistent/libsqlite3.dylib");
  });

  test("MYC_SQLITE_VEC на несуществующий путь — внятная ошибка", async () => {
    const result = await runFixture("plain", {
      MYC_SQLITE_VEC: "/nonexistent/vec0.dylib",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("MYC_SQLITE_VEC");
    expect(result.stderr).toContain("/nonexistent/vec0.dylib");
  });

  test("без библиотек и расширений myc работает: деградация видна в состоянии, vec0 отсутствует честно", async () => {
    const result = await runFixture("degraded");
    expect(result.code).toBe(0);
    const stateLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("STATE:"));
    expect(stateLine).toBeDefined();
    const state = JSON.parse(stateLine!.slice("STATE:".length));
    expect(state.sqlite.path).toBeNull();
    expect(state.sqlite.source).toBe("builtin");
    expect(typeof state.sqlite.version).toBe("string");
    // Та SQLite, что Bun грузит сам, — разная по платформам, и это замер:
    // на macOS это системная, собранная с SQLITE_OMIT_LOAD_EXTENSION; на
    // Linux — встроенная в Bun, и loadExtension у неё работает (Bun 1.3.0,
    // 1.3.14, 1.4.2 в Docker: ошибка на отсутствующем файле — «cannot open
    // shared object file», а не «does not support dynamic extension loading»).
    if (process.platform === "darwin") {
      expect(state.sqlite.extensions).toBe(false);
      expect(state.sqlite.reason).toContain("not found");
    } else {
      expect(state.sqlite.extensions).toBe(true);
      expect(state.vec.reason).toContain("not found");
    }
    expect(state.vec.loaded).toBe(false);
    expect(state.vec.version).toBeNull();
    expect(state.vec.reason).not.toBeNull();

    const basicLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("BASIC:"));
    expect(JSON.parse(basicLine!.slice("BASIC:".length))).toEqual({ n: 1 });

    const vecErr = result.stdout
      .split("\n")
      .find((line) => line.startsWith("VECERR:"))
      ?.slice("VECERR:".length);
    expect(vecErr).toContain("no such module");
  });

  /**
   * Предпосылка теста — что кастомная libsqlite3 вообще НАЙДЕНА: без файла
   * `setCustomSQLite` не зовётся, бросать нечего, и фикстура честно выходит
   * нулём. На macOS с Homebrew она есть всегда, на голом раннере может не
   * быть — и там проверять нечего, а не «сломано».
   *
   * Поэтому предпосылка проверяется явно и по ней же решается судьба теста:
   * нет библиотеки — пропуск с названной причиной (И2: молчаливый зелёный
   * тест на непроверенном пути хуже отсутствующего). Ошибку формы «случилось
   * что-то другое» тест по-прежнему ловит.
   */
  /**
   * Поздний вызов `setCustomSQLite` на macOS бросает "SQLite already loaded":
   * переставить SQLite задним числом нельзя. На Linux кандидатов нет вовсе
   * (Bun там не применяет чужую библиотеку), и опаздывать некому.
   *
   * Опоздание — не ошибка программиста, за которую надо ронять команду: так
   * бывает в чужом процессе (соединение открыли мимо ensureSqliteLibrary), и
   * работать приходится на том, что загружено. Допустимых исходов два:
   * загруженная SQLite не ниже минимума — работаем, и опоздание НАЗВАНО в
   * состоянии (с исходным сообщением Bun и именем функции, которую надо было
   * позвать раньше); ниже минимума — громкий отказ с версией. Недопустима
   * молчаливая середина: нулевой выход, в котором не видно, что выбор не
   * состоялся.
   */
  test("соединение до инициализации: опоздание названо, а ниже минимума — отказ", async () => {
    const found = buildLibCandidates().filter((c) => existsSync(c.path));
    if (found.length === 0) {
      console.log(
        "[skip] соединение до инициализации: ни одного файла libsqlite3 из " +
          `${buildLibCandidates().length} кандидатов — setCustomSQLite не вызывается, ` +
          "ошибке взяться неоткуда",
      );
      return;
    }
    const result = await runFixture("late-init");
    if (result.code !== 0) {
      // Отказ — только по версии, и обязан назвать и её, и минимум.
      expect(result.stderr).toContain("SqliteUnsupportedError");
      expect(result.stderr).toContain(SQLITE_MIN_VERSION);
      expect(result.stderr).toContain("loaded in this process before myc could choose");
      return;
    }
    const state = result.stdout.match(/^STATE:(.*)$/m)?.[1];
    expect(state).toBeDefined();
    const parsed = JSON.parse(state!) as SqliteRuntimeState;
    // Выбор не состоялся — и это видно: путь не выдуман, причина названа.
    expect(parsed.sqlite.path).toBeNull();
    expect(parsed.sqlite.reason ?? "").toContain(ALREADY_LOADED_MESSAGE);
    expect(parsed.sqlite.reason ?? "").toContain("ensureSqliteLibrary");
    console.log(
      `[платформа ${process.platform}] поздняя инициализация: SQLite ${parsed.sqlite.version}, ` +
        `extensions=${parsed.sqlite.extensions}, vec0=${parsed.vec.loaded}`,
    );
  });
});

describe("порядок кандидатов libsqlite3", () => {
  test("MYC_SQLITE идёт первым", () => {
    const list = buildLibCandidates("darwin", "/exec", "/home/users", {
      MYC_SQLITE: "/env/libsqlite3.dylib",
    });
    expect(list[0]).toEqual({ path: "/env/libsqlite3.dylib", source: "env" });
  });

  test("darwin: своя из пакета → рядом с бинарём → Homebrew; системной нет — её Bun грузит сам", () => {
    const list = buildLibCandidates("darwin", "/exec", "/home/users", {}, "/pkg/dist");
    expect(list.map((c) => [c.path, c.source])).toEqual([
      [`/pkg/vendor/sqlite/${BUNDLED_SQLITE_FILE}`, "bundled"],
      [`/exec/${BUNDLED_SQLITE_FILE}`, "bundled"],
      ["/exec/libsqlite3.dylib", "binary-dir"],
      ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "homebrew"],
      ["/usr/local/opt/sqlite/lib/libsqlite3.dylib", "homebrew"],
    ]);
  });

  test("darwin: своя библиотека идёт сразу после MYC_SQLITE", () => {
    const list = buildLibCandidates("darwin", "/exec", "/home/users", { MYC_SQLITE: "/env/l.dylib" }, "/pkg/dist");
    expect(list.slice(0, 2).map((c) => c.source)).toEqual(["env", "bundled"]);
  });

  test("из исходников своя библиотека ищется там, куда её кладёт scripts/build-sqlite.ts", () => {
    const [bundled] = buildLibCandidates("darwin", "/exec", "/home/users", {});
    expect(bundled).toEqual({ path: join(BUNDLED_OUT_DIR, BUNDLED_SQLITE_FILE), source: "bundled" });
  });

  /**
   * Linux: Bun линкует SQLite статически, и setCustomSQLite возвращает true,
   * не меняя ничего (Docker, Bun 1.3.14: после setCustomSQLite(системная
   * 3.37.2 в Ubuntu 22.04, 3.40.1 в Debian 12, 3.45.1 в Ubuntu 24.04)
   * sqlite_version() — всё та же встроенная 3.53.0). Прежний список системных
   * путей давал состояние, называвшее системную библиотеку, пока работала
   * встроенная. Поэтому кандидат один — явная MYC_SQLITE, и её проверяют.
   */
  test("linux: кандидатов нет, кроме явной MYC_SQLITE", () => {
    expect(buildLibCandidates("linux", "/exec", "/home/users", {})).toEqual([]);
    expect(buildLibCandidates("linux", "/exec", "/home/users", { MYC_SQLITE: "/x.so" })).toEqual([
      { path: "/x.so", source: "env" },
    ]);
  });
});

describe("версия SQLite: минимум, рекомендованная, сравнение", () => {
  test("сравнение по компонентам, а не строкой", () => {
    expect(compareSqliteVersions("3.43.2", "3.44.0")).toBeLessThan(0);
    expect(compareSqliteVersions("3.44.0", "3.44.0")).toBe(0);
    expect(compareSqliteVersions("3.100.0", "3.53.4")).toBeGreaterThan(0);
    expect(compareSqliteVersions("3.9.0", "3.10.0")).toBeLessThan(0);
  });

  test("границы: ниже 3.50.4 — unsupported, до 3.51.2 — old, дальше — ok", () => {
    expect(SQLITE_MIN_VERSION).toBe("3.50.4");
    expect(SQLITE_RECOMMENDED_VERSION).toBe("3.51.2");
    expect(sqliteSupport("3.37.2")).toBe("unsupported");
    expect(sqliteSupport("3.43.2")).toBe("unsupported");
    expect(sqliteSupport("3.44.0")).toBe("unsupported");
    // Версии, на которых дубли работ очереди ИЗМЕРЕНЫ (memory-e82awcx1ms0b),
    // обязаны отказывать, а не предупреждать: работа выполняется дважды молча.
    expect(sqliteSupport("3.46.0")).toBe("unsupported");
    // 3.50.4 — SQLite минимально поддерживаемого Bun (engines: >= 1.3.0):
    // порог обязан её пускать, иначе поддерживаемый Linux не запустится вовсе.
    expect(sqliteSupport("3.50.4")).toBe("old");
    expect(sqliteSupport("3.51.0")).toBe("old");
    expect(sqliteSupport("3.51.2")).toBe("ok");
    expect(sqliteSupport("3.53.4")).toBe("ok");
  });


  test("своя библиотека пакета не ниже рекомендованной", () => {
    expect(sqliteSupport(RELEASES.bundled.version)).toBe("ok");
    expect(sqliteSupport(RELEASES.old.version)).toBe("unsupported");
  });

  test("версия Homebrew — из пути Cellar, с ревизией формулы и без", () => {
    expect(homebrewSqliteVersion("/opt/homebrew/Cellar/sqlite/3.53.4/lib/libsqlite3.3.53.4.dylib")).toBe("3.53.4");
    expect(homebrewSqliteVersion("/usr/local/Cellar/sqlite/3.43.1_1/lib/libsqlite3.dylib")).toBe("3.43.1");
    expect(homebrewSqliteVersion("/usr/lib/libsqlite3.dylib")).toBeNull();
  });

  test("SQLITE_VERSION_NUMBER → строка версии", () => {
    expect(versionFromNumber(3053004)).toBe("3.53.4");
    expect(versionFromNumber(3043002)).toBe("3.43.2");
  });
});

/**
 * Выбор на НАСТОЯЩИХ библиотеках, в подпроцессах: setCustomSQLite — один раз
 * на процесс. Стенд — SQLite 3.43.2 из официального амальгамата
 * (`bun scripts/build-sqlite.ts --old`), своя — `bun scripts/build-sqlite.ts`.
 * Без них проверять нечего, и тест говорит это вслух; вне macOS — тоже:
 * там Bun чужую библиотеку не применяет (см. «linux: кандидатов нет»).
 */
describe("выбор библиотеки: кандидат ниже минимума не берётся, явная старая — отказ", () => {
  const oldLib = join(standDir(), "libsqlite3.dylib");
  const bundled = join(BUNDLED_OUT_DIR, BUNDLED_SQLITE_FILE);
  const skip =
    process.platform !== "darwin"
      ? `${process.platform}: Bun линкует SQLite статически и setCustomSQLite не применяет`
      : !existsSync(oldLib)
        ? `нет стенда ${oldLib} (bun scripts/build-sqlite.ts --old)`
        : !existsSync(bundled)
          ? `нет своей библиотеки ${bundled} (bun scripts/build-sqlite.ts)`
          : null;

  test("старая перед своей: старую пропускает проверка ДО загрузки, берётся своя", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const result = await runFixture("candidates", {
      FIXTURE_CANDIDATES: JSON.stringify([
        { path: oldLib, source: "binary-dir" },
        { path: bundled, source: "bundled" },
      ]),
    });
    expect(result.stderr).toBe("");
    const lib = JSON.parse(result.stdout.match(/^LIBRARY:(.*)$/m)![1]!);
    expect(lib.version).toBe(RELEASES.bundled.version);
    expect(lib.source).toBe("bundled");
    expect(lib.path).toBe(bundled);
    expect(lib.support).toBe("ok");
    expect(lib.skipped.join("\n")).toContain(`${oldLib} — SQLite ${RELEASES.old.version}, below the minimum`);
  });

  test("только старая: она не выбирается, работает то, что Bun грузит сам", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const result = await runFixture("candidates", {
      FIXTURE_CANDIDATES: JSON.stringify([{ path: oldLib, source: "homebrew" }]),
    });
    if (result.code !== 0) {
      // Системная этой машины сама ниже минимума (macOS 14) — честный отказ.
      expect(result.stderr).toContain("SqliteUnsupportedError");
      return;
    }
    const lib = JSON.parse(result.stdout.match(/^LIBRARY:(.*)$/m)![1]!);
    expect(lib.source).toBe("builtin");
    expect(lib.version).not.toBe(RELEASES.old.version);
    expect(lib.skipped.join("\n")).toContain("below the minimum");
  });

  test("явная MYC_SQLITE ниже минимума — отказ с версией и лекарством, без тихого отката", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const result = await runFixture("plain", { MYC_SQLITE: oldLib });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("SqliteUnsupportedError");
    expect(result.stderr).toContain(`SQLite ${RELEASES.old.version} (MYC_SQLITE ${oldLib})`);
    expect(result.stderr).toContain(SQLITE_MIN_VERSION);
    // Отказ обязан назвать ОБЕ причины порога: запись FTS5 (ниже 3.44.0) и
    // измеренные дубли работ очереди (memory-e82awcx1ms0b) — иначе человек
    // прочтёт «старая SQLite» и решит, что дело в одной несовместимости.
    expect(result.stderr).toContain("unsafe use of virtual table nodes_fts");
    expect(result.stderr).toContain("two or three times");
    expect(result.stderr).toContain(SQLITE_OLD_BUG);
  });

  /**
   * Обратная сторона Linux: Bun принимает setCustomSQLite и не применяет его.
   * Явная MYC_SQLITE там не работает по устройству Bun — значит, по правилу
   * явной настройки, отказ вслух, а не состояние, называющее чужую
   * библиотеку. Проверяется системной libsqlite3.so.0 (на ubuntu-latest —
   * 3.45.1 при встроенной 3.53): её source_id не совпадёт с действующим.
   */
  test("linux: явная MYC_SQLITE, которую Bun не применит, — отказ, а не выдуманное состояние", async () => {
    const systemSo = ["/usr/lib/x86_64-linux-gnu/libsqlite3.so.0", "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0"].find(
      (p) => existsSync(p),
    );
    if (process.platform === "darwin" || systemSo === undefined) {
      return void console.log(`[skip] ${process.platform === "darwin" ? "macOS применяет setCustomSQLite" : "нет системной libsqlite3.so.0"}`);
    }
    const result = await runFixture("plain", { MYC_SQLITE: systemSo });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("SqliteConfigError");
    expect(result.stderr).toContain("ignores Database.setCustomSQLite");
  });

  test("в этом процессе (preload) выбрана не старая библиотека", () => {
    const lib = getSqliteLibraryState();
    expect(lib).not.toBeNull();
    expect(lib!.support).not.toBe("unsupported");
  });
});

describe("порядок кандидатов vec0", () => {
  test("MYC_SQLITE_VEC идёт первой", () => {
    const list = buildVecCandidates("darwin", "/exec", "/home/users", {
      MYC_SQLITE_VEC: "/env/vec0.dylib",
    });
    expect(list[0]).toEqual({ path: "/env/vec0.dylib", source: "env" });
  });

  test("кеш bun: vec0 из каталогов sqlite-vec-*, свежая версия первой", () => {
    const home = mkdtempSync(join(tmpdir(), "myc-bunhome-"));
    try {
      const cache = join(home, ".bun", "install", "cache");
      for (const name of [
        "sqlite-vec-darwin-arm64@0.1.6@@@1",
        "sqlite-vec-darwin-arm64@0.1.9@@@1",
        "sqlite-vec@0.1.9@@@1",
      ]) {
        mkdirSync(join(cache, name), { recursive: true });
        writeFileSync(join(cache, name, "vec0.dylib"), "stub");
      }
      const list = buildVecCandidates("darwin", "/exec", home, {});
      const cacheEntries = list.filter((c) => c.source === "bun-cache");
      expect(cacheEntries.length).toBe(2);
      expect(cacheEntries[0]!.path).toContain("0.1.9");
      expect(cacheEntries[0]!.path.endsWith("vec0.dylib")).toBe(true);
      expect(list[0]).toEqual({ path: "/exec/vec0.dylib", source: "binary-dir" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("без кеша bun список кандидатов не падает", () => {
    const list = buildVecCandidates("linux", "/exec", join(dir, "no-such-home"), {});
    expect(list[0]).toEqual({ path: "/exec/vec0.so", source: "binary-dir" });
    expect(list.filter((c) => c.source === "bun-cache")).toEqual([]);
  });
});

describe("MYC_SQLITE_VEC указывает на реальный vec0", () => {
  test("env-кандидат побеждает и загружается", async () => {
    const candidates = buildVecCandidates();
    const existing = candidates.find((c) => existsSync(c.path));
    if (!existing) {
      console.log("[skip] на этой машине нет доступного vec0");
      return;
    }
    const result = await runFixture("plain", { MYC_SQLITE_VEC: existing.path });
    expect(result.code).toBe(0);
    const state = JSON.parse(
      result.stdout
        .split("\n")
        .find((line) => line.startsWith("STATE:"))!
        .slice("STATE:".length),
    );
    expect(state.vec.loaded).toBe(true);
    expect(state.vec.path).toBe(existing.path);
    expect(state.vec.source).toBe("env");
  });
});
