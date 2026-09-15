#!/usr/bin/env bun
/**
 * Своя SQLite для пакета на macOS (memory-yxzsp11cpv6x, GitHub issue #1).
 *
 * ЗАЧЕМ. Bun на macOS не несёт SQLite — грузит системную, а она у Apple
 * отстаёт: на macOS 14 это 3.43.2, где FTS5 ещё не innocuous и триггеры,
 * пишущие в nodes_fts под `trusted_schema = OFF`, запрещены — `remember` и
 * `create` падают. Ослабить trusted_schema нельзя: на 3.43.2 и 3.46.0
 * параллельные CLI выполняют работы очереди по 2–3 раза, а fail ловит
 * «database disk image is malformed» (memory-e82awcx1ms0b). Поэтому пакет
 * везёт свою библиотеку, и рантайм (packages/store-sqlite/src/runtime.ts)
 * выбирает её сразу после явной MYC_SQLITE на всех путях открытия.
 *
 * ВОСПРОИЗВОДИМО. Версия, оба хеша амальгамата (sha256 и SHA3-256 — второй
 * опубликован на sqlite.org/download.html) и флаги компиляции зашиты в
 * packages/store-sqlite/src/bundled-sqlite.ts — там же, почему флаги именно
 * такие. Скачанный архив кешируется (MYC_SQLITE_CACHE, иначе
 * ~/.cache/myc/sqlite) — CI держит этот каталог в actions/cache. Две сборки
 * одним тулчейном дают побайтно одинаковый файл (sha256 совпал).
 *
 *   bun scripts/build-sqlite.ts            своя: 3.53.4, arm64+x86_64 →
 *                                          packages/store-sqlite/vendor/sqlite/
 *   bun scripts/build-sqlite.ts --old [DIR] стенд: 3.43.2 (системная macOS 14),
 *                                          libsqlite3.dylib под текущую
 *                                          архитектуру → DIR (по умолчанию
 *                                          <кеш>/stand-3.43.2 — там его
 *                                          ищет сквозной тест)
 *
 * Подпись: ad-hoc на оба среза (`codesign --sign -`); проверка ниже грузит
 * результат в bun через setCustomSQLite — именно так, как это сделает myc.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUNDLED_SQLITE_FILE,
  SQLITE_MIN_VERSION,
  SQLITE_RECOMMENDED_VERSION,
  compareSqliteVersions,
} from "../packages/store-sqlite/src/runtime.ts";
import {
  BUNDLED_SQLITE_OUT_DIR,
  SQLITE_COMPILE_FLAGS as COMPILE_FLAGS,
  SQLITE_RELEASES as RELEASES,
  sqliteCacheDir as cacheDir,
  sqliteStandDir as standDir,
  type SqliteRelease as Release,
} from "../packages/store-sqlite/src/bundled-sqlite.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** Самая старая macOS, на которой библиотека обязана грузиться. */
const MACOS_MIN = "11.0";

function hex(algorithm: "sha256" | "sha3-256", bytes: Uint8Array): string {
  return new Bun.CryptoHasher(algorithm).update(bytes).digest("hex");
}

/** Архив амальгамата: из кеша, иначе с sqlite.org; оба хеша сверяются всегда. */
async function fetchAmalgamation(release: Release): Promise<string> {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, release.url.split("/").at(-1)!);
  if (!existsSync(zip)) {
    const res = await fetch(release.url);
    if (!res.ok) throw new Error(`${release.url}: HTTP ${res.status}`);
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = readFileSync(zip);
  const got = { sha256: hex("sha256", bytes), sha3_256: hex("sha3-256", bytes) };
  if (got.sha256 !== release.sha256 || got.sha3_256 !== release.sha3_256) {
    rmSync(zip, { force: true });
    throw new Error(
      `${zip}: хеш не совпал (sha256 ${got.sha256}, sha3-256 ${got.sha3_256}; ` +
        `ожидались ${release.sha256} и ${release.sha3_256}) — архив удалён`,
    );
  }
  return zip;
}

function run(cmd: readonly string[], cwd?: string): string {
  const r = Bun.spawnSync([...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} → ${r.exitCode}\n${r.stderr.toString()}${r.stdout.toString()}`);
  }
  return r.stdout.toString();
}

/** Достаёт sqlite3.c во временный каталог рядом с архивом. */
function extractSource(zip: string, release: Release): string {
  const work = join(dirname(zip), `src-${release.version}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  run(["unzip", "-q", "-o", zip, "-d", work]);
  const base = release.url.split("/").at(-1)!.replace(/\.zip$/, "");
  const source = join(work, base, "sqlite3.c");
  if (!existsSync(source)) throw new Error(`в ${zip} нет ${base}/sqlite3.c`);
  return source;
}

interface Probe {
  readonly version: string;
  readonly sourceId: string;
  readonly options: string[];
  readonly ftsTrigger: string;
  readonly vec: string | null;
}

/**
 * Грузит библиотеку в bun так, как это делает myc (setCustomSQLite), и
 * снимает то, ради чего она собрана: версию, FTS5 в триггере под
 * trusted_schema=OFF, загрузку расширений.
 */
function probe(lib: string, vec0: string | null): Probe {
  const script = `
    import { Database } from "bun:sqlite";
    if (!Database.setCustomSQLite(${JSON.stringify(lib)})) throw new Error("setCustomSQLite returned false");
    const db = new Database(":memory:");
    const one = (sql) => Object.values(db.query(sql).get())[0];
    const out = {
      version: one("select sqlite_version()"),
      sourceId: one("select sqlite_source_id()"),
      options: db.query("pragma compile_options").all().map((r) => r.compile_options),
      ftsTrigger: "ok",
      vec: null,
    };
    try {
      db.exec("PRAGMA trusted_schema = OFF; CREATE TABLE n(id INTEGER PRIMARY KEY, t TEXT);" +
        "CREATE VIRTUAL TABLE f USING fts5(t, content='');" +
        "CREATE TRIGGER a AFTER INSERT ON n BEGIN INSERT INTO f(rowid, t) VALUES (new.rowid, new.t); END;");
      db.query("INSERT INTO n(t) VALUES ('probe')").run();
    } catch (e) { out.ftsTrigger = String(e.message); }
    const vec0 = ${JSON.stringify(vec0)};
    if (vec0 !== null) { db.loadExtension(vec0); out.vec = one("select vec_version()"); }
    console.log(JSON.stringify(out));
  `;
  // Чистое окружение: DYLD_* и MYC_SQLITE вызывающего не должны подменить то, что проверяем.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() };
  const r = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`bun не загрузил ${lib}:\n${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Probe;
}

/** vec0 из зависимости sqlite-vec — проверка «расширения грузятся без Homebrew». */
function findVec0(): string | null {
  const cpu = process.arch === "arm64" ? "arm64" : "x64";
  try {
    // Платформенный пакет — зависимость sqlite-vec, резолвим от него: при
    // изолированной установке Bun наверх он не поднимается.
    const vecPkg = dirname(Bun.resolveSync("sqlite-vec/package.json", join(ROOT, "packages/store-sqlite")));
    return Bun.resolveSync(`sqlite-vec-darwin-${cpu}/vec0.dylib`, vecPkg);
  } catch {
    return null;
  }
}

async function buildBundled(outDir: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(
      "своя SQLite собирается только на macOS (cc -arch arm64 -arch x86_64): на Linux Bun " +
        "линкует SQLite статически и чужую библиотеку не применяет",
    );
  }
  const release: Release = RELEASES.bundled;
  if (compareSqliteVersions(release.version, SQLITE_RECOMMENDED_VERSION) < 0) {
    throw new Error(`своя SQLite ${release.version} ниже рекомендованной ${SQLITE_RECOMMENDED_VERSION}`);
  }
  const zip = await fetchAmalgamation(release);
  const source = extractSource(zip, release);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, BUNDLED_SQLITE_FILE);
  const t0 = performance.now();
  run([
    "cc",
    "-dynamiclib",
    "-arch", "arm64",
    "-arch", "x86_64",
    `-mmacosx-version-min=${MACOS_MIN}`,
    "-install_name", `@rpath/${BUNDLED_SQLITE_FILE}`,
    ...COMPILE_FLAGS,
    source,
    "-o", out,
  ]);
  const took = ((performance.now() - t0) / 1000).toFixed(1);

  const archs = run(["lipo", "-archs", out]).trim().split(/\s+/).sort();
  if (archs.join(" ") !== "arm64 x86_64") throw new Error(`${out}: архитектуры ${archs.join(" ")}, нужны arm64 x86_64`);
  // Локальные символы пакету не нужны: −150 КБ из 3.3 МБ, API (sqlite3_*) на месте.
  run(["strip", "-x", out]);
  // ld64 подписывает ad-hoc только arm64-срез (linker-signed), x86_64 уходит
  // без подписи, и `codesign --verify` на универсальном файле отказывает
  // (strip к тому же ломает и ту подпись). Подписываем оба среза явно —
  // ad-hoc, без сертификата.
  run(["codesign", "--force", "--sign", "-", out]);
  run(["codesign", "--verify", out]);

  const vec0 = findVec0();
  const p = probe(out, vec0);
  if (p.version !== release.version) throw new Error(`${out}: bun видит SQLite ${p.version}, собиралась ${release.version}`);
  if (p.ftsTrigger !== "ok") throw new Error(`${out}: FTS5 в триггере под trusted_schema=OFF: ${p.ftsTrigger}`);
  for (const need of ["ENABLE_FTS5", "THREADSAFE=1"]) {
    if (!p.options.includes(need)) throw new Error(`${out}: нет ${need} в compile_options`);
  }
  if (p.options.includes("OMIT_LOAD_EXTENSION")) throw new Error(`${out}: собрана без загрузки расширений`);

  const bytes = readFileSync(out);
  const manifest = {
    file: BUNDLED_SQLITE_FILE,
    version: release.version,
    sourceId: p.sourceId,
    amalgamation: { url: release.url, sha256: release.sha256, sha3_256: release.sha3_256 },
    flags: [...COMPILE_FLAGS],
    macosMin: MACOS_MIN,
    archs,
    sha256: hex("sha256", bytes),
    bytes: bytes.length,
  };
  writeFileSync(join(outDir, "libmyc-sqlite3.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outDir, "README-sqlite.txt"),
    [
      `${BUNDLED_SQLITE_FILE} — SQLite ${release.version}, собранная из официального амальгамата`,
      `${release.url} (SHA3-256 ${release.sha3_256}) скриптом scripts/build-sqlite.ts`,
      "репозитория myc. SQLite — общественное достояние (public domain): https://sqlite.org/copyright.html",
      "",
    ].join("\n"),
  );
  // Сборка не принадлежит репозиторию: каталог игнорирует сам себя.
  if (outDir === BUNDLED_SQLITE_OUT_DIR) writeFileSync(join(outDir, ".gitignore"), "*\n");

  console.log(`SQLite ${p.version} → ${out}`);
  console.log(`  ${archs.join("+")}, ${(bytes.length / 1_048_576).toFixed(2)} МБ, sha256 ${manifest.sha256.slice(0, 16)}…, cc ${took} с`);
  console.log(`  FTS5 в триггере (trusted_schema=OFF): ${p.ftsTrigger}; vec0: ${p.vec ?? "не найден, не проверен"}`);
}

async function buildOld(outDir: string): Promise<void> {
  const release: Release = RELEASES.old;
  if (compareSqliteVersions(release.version, SQLITE_MIN_VERSION) >= 0) {
    throw new Error(`стенд обязан быть ниже минимума ${SQLITE_MIN_VERSION}, а он ${release.version}`);
  }
  const zip = await fetchAmalgamation(release);
  const source = extractSource(zip, release);
  mkdirSync(outDir, { recursive: true });
  // Имя — как у системной: стенд подставляется через DYLD_LIBRARY_PATH и
  // обязан перехватить именно `libsqlite3.dylib`, который Bun грузит сам.
  const darwin = process.platform === "darwin";
  const out = join(outDir, darwin ? "libsqlite3.dylib" : "libsqlite3.so");
  run(["cc", ...(darwin ? ["-dynamiclib"] : ["-shared", "-fPIC"]), ...COMPILE_FLAGS, source, "-o", out]);
  if (darwin) {
    const p = probe(out, null);
    if (p.version !== release.version) throw new Error(`${out}: bun видит ${p.version}`);
    // Стенд честен, только если воспроизводит дефект.
    if (!p.ftsTrigger.includes("unsafe use of virtual table")) {
      throw new Error(`${out}: стенд не воспроизводит дефект FTS5 (${p.ftsTrigger})`);
    }
  }
  console.log(`SQLite ${release.version} (стенд) → ${out}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const oldAt = args.indexOf("--old");
  if (oldAt >= 0) {
    const dir = args[oldAt + 1];
    await buildOld(dir !== undefined && !dir.startsWith("--") ? dir : standDir());
  } else {
    const outAt = args.indexOf("--out");
    await buildBundled(outAt >= 0 && args[outAt + 1] !== undefined ? args[outAt + 1]! : BUNDLED_SQLITE_OUT_DIR);
  }
}
