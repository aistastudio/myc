import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDriver } from "./index.ts";
import {
  ALREADY_LOADED_MESSAGE,
  buildLibCandidates,
  buildVecCandidates,
  ensureSqliteRuntime,
  getSqliteRuntimeState,
  type SqliteRuntimeState,
} from "./runtime.ts";

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
import { ensureSqliteRuntime } from ${JSON.stringify(RUNTIME_PATH)};
const mode = process.argv[2]!;
if (mode === "late-init") {
  new Database(":memory:");
}
try {
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
  console.error("FATAL:" + (error as Error).message);
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

  test("на машине с библиотекой: расширения работают, состояние полно и сериализуемо", () => {
    const state = ensureSqliteRuntime();
    if (!state.sqlite.extensions) {
      console.log(`[skip] на этой машине нет libsqlite3 с расширениями: ${state.sqlite.reason}`);
      return;
    }
    expect(state.sqlite.extensions).toBe(true);
    expect(state.sqlite.path).not.toBeNull();
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
    expect(state.sqlite.extensions).toBe(false);
    expect(state.sqlite.source).toBe("builtin");
    expect(typeof state.sqlite.version).toBe("string");
    expect(state.sqlite.reason).toContain("не найдена");
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
   * Поздний вызов `setCustomSQLite` — РАЗНОЕ поведение на разных платформах,
   * и это установлено замером, а не предположением.
   *
   *   macOS (arm64, Homebrew libsqlite3): бросает "SQLite already loaded" —
   *     переставить SQLite задним числом нельзя, и наша обёртка превращает
   *     это в названную ошибку программиста;
   *   Linux (ubuntu-latest, /usr/lib/x86_64-linux-gnu/libsqlite3.so.0):
   *     НЕ бросает. Диагностика из прошлого прогона CI показала полное
   *     состояние: path выставлен, extensions=true, vec0 загружен —
   *     то есть поздняя инициализация там просто удаётся.
   *
   * Тест поэтому проверяет не «должно упасть», а «одно из двух, и оба
   * исхода осмысленны»: либо громкая ошибка с обоими опознавательными
   * признаками, либо рантайм поднялся полностью. Что НЕ допускается ни на
   * одной платформе — это молчаливая середина: нулевой выход без рабочего
   * рантайма. Раньше тест кодировал поведение одной платформы как
   * единственно верное и потому был красным на другой, ничего не проверив.
   */
  test("соединение до инициализации: либо громкая ошибка, либо рабочий рантайм", async () => {
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
      // Отказ обязан называть и виновника, и исходную причину.
      expect(result.stderr).toContain("ensureSqliteRuntime");
      expect(result.stderr).toContain(ALREADY_LOADED_MESSAGE);
      return;
    }
    // Успех обязан быть НАСТОЯЩИМ: рантайм поднят, а не пропущен молча.
    const state = result.stdout.match(/^STATE:(.*)$/m)?.[1];
    expect(state).toBeDefined();
    const parsed = JSON.parse(state!) as SqliteRuntimeState;
    expect(parsed.sqlite.path).not.toBeNull();
    console.log(
      `[платформа ${process.platform}] поздняя инициализация допустима: ` +
        `${parsed.sqlite.path}, extensions=${parsed.sqlite.extensions}, vec0=${parsed.vec.loaded}`,
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

  test("darwin: binary-dir → Homebrew (/opt, /usr/local) → системный", () => {
    const list = buildLibCandidates("darwin", "/exec", "/home/users", {});
    expect(list.map((c) => [c.path, c.source])).toEqual([
      ["/exec/libsqlite3.dylib", "binary-dir"],
      ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "homebrew"],
      ["/usr/local/opt/sqlite/lib/libsqlite3.dylib", "homebrew"],
      ["/usr/lib/libsqlite3.dylib", "system"],
    ]);
  });

  test("linux: binary-dir (libsqlite3.so, .so.0) → стандартные пути с libsqlite3.so.0", () => {
    const list = buildLibCandidates("linux", "/exec", "/home/users", {});
    expect(list[0]).toEqual({ path: "/exec/libsqlite3.so", source: "binary-dir" });
    expect(list[1]).toEqual({ path: "/exec/libsqlite3.so.0", source: "binary-dir" });
    const sources = new Set(list.map((c) => c.source));
    expect(sources).toEqual(new Set(["binary-dir", "system"]));
    for (const candidate of list.slice(2)) {
      expect(candidate.path.endsWith("libsqlite3.so.0") ||
        candidate.path.endsWith("libsqlite3.so")).toBe(true);
    }
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
