/**
 * GitHub issue #1 (memory-yxzsp11cpv6x), сквозной: CLI в отдельных процессах
 * под «системной» SQLite 3.43.2 — той, что Bun на macOS 14 грузит сам.
 *
 * Симуляция macOS 14: DYLD_LIBRARY_PATH со стендом libsqlite3.dylib 3.43.2
 * (официальный амальгамат, `bun scripts/build-sqlite.ts --old`). dyld ищет по
 * последнему компоненту пути, поэтому стенд перехватывает и то, что Bun
 * грузит сам, и любую `…/libsqlite3.dylib` (Homebrew тоже), — но не нашу
 * `libmyc-sqlite3.dylib`: у неё своё имя ровно поэтому.
 *
 * CLI запускается из раскладки ПАКЕТА, а не из исходников: `<пакет>/dist/myc.js`
 * (бандл, как собирает scripts/pack-npm.ts) и `<пакет>/vendor/sqlite/` — так
 * проверяется настоящий путь поиска своей библиотеки, `../vendor/sqlite` от
 * бандла. Два пакета: со своей библиотекой и без неё.
 *
 *   со своей — init → remember → create → close → recall → show работают,
 *     `doctor` называет её;
 *   без неё — громкий отказ precond.sqlite_unsupported с лекарством, а не
 *     internal.unexpected; init не создаёт воркспейс, в который нельзя писать;
 *   явная MYC_SQLITE слышна на лёгком пути (create/show не просят vec0), а
 *     явная старая — тот же отказ с её именем.
 *
 * Вне macOS проверять нечего, и тест говорит это вслух: Bun на Linux линкует
 * SQLite статически, setCustomSQLite там не меняет ничего (Docker: Debian 12,
 * Ubuntu 22.04/24.04, Bun 1.3.0–1.4.2), системной библиотеке быть старой негде.
 * Нет стенда или своей библиотеки на macOS — пропуск с командой сборки; CI
 * (MYC_REQUIRE_SQLITE_STAND=1) пропуска не допускает.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLED_SQLITE_FILE, SQLITE_MIN_VERSION } from "@myc/store-sqlite";
import {
  BUNDLED_SQLITE_OUT_DIR as BUNDLED_OUT_DIR,
  SQLITE_RELEASES as RELEASES,
  sqliteStandDir as standDir,
} from "../../store-sqlite/src/bundled-sqlite.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const OLD_DIR = standDir();
const OLD_LIB = join(OLD_DIR, "libsqlite3.dylib");
const BUNDLED = join(BUNDLED_OUT_DIR, BUNDLED_SQLITE_FILE);

const SKIP =
  process.platform !== "darwin"
    ? `${process.platform}: bun:sqlite always runs the SQLite built into Bun — no system library to be old`
    : !existsSync(OLD_LIB)
      ? `no SQLite ${RELEASES.old.version} stand at ${OLD_LIB} (bun scripts/build-sqlite.ts --old)`
      : !existsSync(BUNDLED)
        ? `no bundled SQLite at ${BUNDLED} (bun scripts/build-sqlite.ts)`
        : null;

if (SKIP !== null && process.platform === "darwin" && process.env.MYC_REQUIRE_SQLITE_STAND === "1") {
  throw new Error(`MYC_REQUIRE_SQLITE_STAND=1, но ${SKIP}`);
}

let root = "";
let withPkg = "";
let withoutPkg = "";
let home = "";
let vec0: string | null = null;

interface Out {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly env?: {
    ok: boolean;
    data: any;
    warn: Array<{ code: string; msg: string }>;
    error?: { code: string; msg: string; hint?: string };
  };
}

function cli(pkg: string, cwd: string, args: readonly string[], extra: Record<string, string> = {}): Out {
  const r = Bun.spawnSync([process.execPath, join(pkg, "dist", "myc.js"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      MYC_HOME: home,
      MYC_ACTOR: "tester",
      // Боевой процесс: дренаж после команды — тоже запись, и тоже на этой SQLite.
      NODE_ENV: "production",
      DYLD_LIBRARY_PATH: OLD_DIR,
      ...(vec0 !== null ? { MYC_SQLITE_VEC: vec0 } : {}),
      ...extra,
    },
  });
  const stdout = r.stdout.toString();
  let env: Out["env"];
  try {
    env = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    env = undefined;
  }
  return { code: r.exitCode ?? -1, stdout, stderr: r.stderr.toString(), env };
}

function workspace(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

function explain(o: Out): string {
  return `exit ${o.code}\nstdout: ${o.stdout.slice(0, 1500)}\nstderr: ${o.stderr.slice(0, 1500)}`;
}

beforeAll(() => {
  if (SKIP !== null) return;
  // realpath: на macOS tmpdir — ссылка /var → /private/var, а бандл видит себя по настоящему пути.
  root = realpathSync(mkdtempSync(join(tmpdir(), "myc-sqlite-e2e-")));
  home = join(root, "home");
  mkdirSync(home);
  withPkg = join(root, "pkg-with");
  withoutPkg = join(root, "pkg-without");
  for (const pkg of [withPkg, withoutPkg]) mkdirSync(join(pkg, "dist"), { recursive: true });
  // Бандл — как scripts/pack-npm.ts. NODE_ENV сборки не наследуем: bun build
  // подставляет его в бандл, и под `bun test` дренаж был бы вырезан навсегда
  // (memory-h5zp5mqcdbay).
  const { NODE_ENV: _drop, ...buildEnv } = process.env;
  const built = Bun.spawnSync(
    [process.execPath, "build", "--target=bun", join(REPO, "packages/cli/src/main.ts"), "--outfile", join(withPkg, "dist", "myc.js")],
    { cwd: REPO, stdout: "pipe", stderr: "pipe", env: buildEnv },
  );
  if (built.exitCode !== 0) throw new Error(`bun build: ${built.stderr.toString()}`);
  copyFileSync(join(withPkg, "dist", "myc.js"), join(withoutPkg, "dist", "myc.js"));
  mkdirSync(join(withPkg, "vendor", "sqlite"), { recursive: true });
  copyFileSync(BUNDLED, join(withPkg, "vendor", "sqlite", BUNDLED_SQLITE_FILE));
  try {
    const vecPkg = dirname(Bun.resolveSync("sqlite-vec/package.json", join(REPO, "packages/store-sqlite")));
    vec0 = Bun.resolveSync(`sqlite-vec-darwin-${process.arch === "arm64" ? "arm64" : "x64"}/vec0.dylib`, vecPkg);
  } catch {
    vec0 = null;
  }
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("issue #1: CLI под системной SQLite 3.43.2 (симуляция macOS 14)", () => {
  test("стенд честен: без своей библиотеки Bun видит 3.43.2, и FTS5 в триггере падает", () => {
    if (SKIP !== null) return void console.log(`[skip] ${SKIP}`);
    const r = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { Database } from "bun:sqlite";
         const db = new Database(":memory:");
         console.log(db.query("select sqlite_version() v").get().v);
         db.exec("PRAGMA trusted_schema=OFF; CREATE TABLE n(id INTEGER PRIMARY KEY, t TEXT);" +
           "CREATE VIRTUAL TABLE f USING fts5(t, content='');" +
           "CREATE TRIGGER a AFTER INSERT ON n BEGIN INSERT INTO f(rowid,t) VALUES (new.rowid,new.t); END;");
         try { db.query("INSERT INTO n(t) VALUES ('x')").run(); console.log("ok"); } catch (e) { console.log(e.message); }`,
      ],
      { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", DYLD_LIBRARY_PATH: OLD_DIR } },
    );
    const [version, fts] = r.stdout.toString().trim().split("\n");
    expect(version).toBe(RELEASES.old.version);
    expect(fts).toContain('unsafe use of virtual table "f"');
  });

  test("своя библиотека в пакете: init → remember → create → close → recall → show, doctor её называет", () => {
    if (SKIP !== null) return void console.log(`[skip] ${SKIP}`);
    const ws = workspace("ws-with");

    const init = cli(withPkg, ws, ["--json", "init"]);
    expect(init.env?.ok, explain(init)).toBe(true);
    expect(init.env!.warn.map((w) => w.code)).not.toContain("degraded.sqlite_old");

    const remember = cli(withPkg, ws, ["--json", "remember", "diagnostic memory probe", "--reach", "project"]);
    expect(remember.env?.ok, explain(remember)).toBe(true);

    const create = cli(withPkg, ws, ["--json", "create", "diagnostic task"]);
    expect(create.env?.ok, explain(create)).toBe(true);
    const id = String(create.env!.data.id);

    const close = cli(withPkg, ws, ["--json", "close", id]);
    expect(close.env?.ok, explain(close)).toBe(true);

    const recall = cli(withPkg, ws, ["--json", "recall", "diagnostic memory probe"]);
    expect(recall.env?.ok, explain(recall)).toBe(true);
    expect(JSON.stringify(recall.env!.data)).toContain("diagnostic memory probe");

    const show = cli(withPkg, ws, ["--json", "show", id]);
    expect(show.env?.ok, explain(show)).toBe(true);
    expect(JSON.stringify(show.env!.data)).toContain("closed");

    const doctor = cli(withPkg, ws, ["doctor", "--schema"]);
    expect(doctor.code, explain(doctor)).toBe(0);
    const bundledHere = join(withPkg, "vendor", "sqlite", BUNDLED_SQLITE_FILE);
    expect(doctor.stdout).toContain(`SQLite ${RELEASES.bundled.version} — bundled with myc, ${bundledHere}`);
    // Бонус своей библиотеки: vec0 грузится без Homebrew.
    if (vec0 !== null) expect(doctor.stdout).toMatch(/ok +vec0: v0\.\d+/);
  }, 60_000);

  test("без своей библиотеки: громкий отказ с лекарством, а не internal.unexpected", () => {
    if (SKIP !== null) return void console.log(`[skip] ${SKIP}`);
    const fresh = workspace("ws-without");
    const init = cli(withoutPkg, fresh, ["--json", "init"]);
    expect(init.code, explain(init)).toBe(5);
    expect(init.env?.error?.code).toBe("precond.sqlite_unsupported");
    expect(init.env?.error?.msg).toContain(`SQLite ${RELEASES.old.version}`);
    expect(init.env?.error?.msg).toContain(SQLITE_MIN_VERSION);
    expect(init.env?.error?.hint).toContain("reinstall myc");
    // Воркспейс, в который нельзя писать, не создаётся.
    expect(existsSync(join(fresh, ".myc"))).toBe(false);

    // Воркспейс, созданный раньше (своей библиотекой), — те же отказы на каждой команде.
    const ws = join(root, "ws-with");
    for (const args of [
      ["remember", "after the bundled library is gone", "--reach", "project"],
      ["create", "after the bundled library is gone"],
      ["ready"],
    ]) {
      const r = cli(withoutPkg, ws, ["--json", ...args]);
      expect({ args, code: r.code, error: r.env?.error?.code }).toEqual({
        args,
        code: 5,
        error: "precond.sqlite_unsupported",
      });
      expect(r.stdout + r.stderr).not.toContain("internal.unexpected");
    }

    const doctor = cli(withoutPkg, ws, ["doctor", "--schema"]);
    expect(doctor.code, explain(doctor)).toBe(5);
    expect(doctor.stderr).toContain(`SQLite ${RELEASES.old.version}`);
    expect(doctor.stderr).toContain("fix:");
  }, 60_000);

  test("явная MYC_SQLITE слышна на лёгком пути; явная старая — отказ с её именем", () => {
    if (SKIP !== null) return void console.log(`[skip] ${SKIP}`);
    const ws = join(root, "ws-with");
    // Своё имя, как у библиотеки пакета: DYLD_LIBRARY_PATH её не перехватит.
    const custom = join(root, "custom", "libcustom-sqlite3.dylib");
    mkdirSync(dirname(custom), { recursive: true });
    copyFileSync(BUNDLED, custom);

    const create = cli(withoutPkg, ws, ["--json", "create", "via MYC_SQLITE"], { MYC_SQLITE: custom });
    expect(create.env?.ok, explain(create)).toBe(true);
    const show = cli(withoutPkg, ws, ["--json", "show", String(create.env!.data.id)], { MYC_SQLITE: custom });
    expect(show.env?.ok, explain(show)).toBe(true);
    const doctor = cli(withoutPkg, ws, ["doctor", "--schema"], { MYC_SQLITE: custom });
    expect(doctor.stdout).toContain(`SQLite ${RELEASES.bundled.version} — MYC_SQLITE ${custom}`);

    const old = cli(withoutPkg, ws, ["--json", "show", String(create.env!.data.id)], { MYC_SQLITE: OLD_LIB });
    expect(old.code, explain(old)).toBe(5);
    expect(old.env?.error?.code).toBe("precond.sqlite_unsupported");
    expect(old.env?.error?.msg).toContain(`MYC_SQLITE ${OLD_LIB}`);
    expect(old.env?.error?.hint).toContain("MYC_SQLITE=");
  }, 60_000);
});
