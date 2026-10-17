#!/usr/bin/env node
/**
 * Точка входа npm-пакета @aistastudio/myc — тонкий запускатель НАТИВНОГО
 * бинаря (модель esbuild): на машине клиента не нужен ни Bun, ни бандл.
 *
 * ПОЧЕМУ ТАК, А НЕ SHEBANG С ФЛАГАМИ (задача memory-vqmed67a0x8h).
 * Прежний лаунчик начинался с `#!/usr/bin/env -S bun --no-env-file
 * --config=/dev/null`: флаги защищали от подхвата `.env` и bunfig-preload
 * ЧУЖОГО проекта (инцидент в cherry, 2026-09-11: `myc run` унёс 20
 * EXPO_PUBLIC_* из .env worktree в тесты). Но одним shebangом двум платформам
 * не угодить: на Windows шим `bun add -g` берёт `-S` за программу
 * (`interpreter executable "-S" not found`), а `/dev/null` там не существует.
 *
 * ЗАЩИТА НЕ ПОТЕРЯНА, А ПЕРЕНЕСЕНА, и она теперь у обеих половин:
 *   - `env node` разбирают все шимы (npm cmdshim, bun, POSIX); node `.env`
 *     чужого проекта не грузит вообще (нет ни автозагрузки, ни bunfig-preload);
 *   - нативный бинарь собирается флагами `--no-compile-autoload-dotenv` и
 *     `--no-compile-autoload-bunfig` (общий рецепт scripts/build.ts) — bun
 *     внутри него не читает .env/bunfig СВОЕГО cwd ни при каких обстоятельствах;
 *   - фолбэк-бандл под Bun получает protective-флаги в argv
 *     (--no-env-file, --config=os.devNull) — как прежний shebang.
 *
 * ПОРЯДОК РЕЗОЛЮЦИИ ЗАПУСКА
 *   1. MYC_BINARY — явный путь к бинарю (тесты, крайние случаи), argv как есть;
 *   2. платформенный пакет @aistastudio/myc-<os>-<arch> — нативный путь;
 *   3. бандл dist/myc.js под Bun — фолбэк для экзотических платформ;
 *   4. честный отказ с причиной и что делать.
 *
 * Файл без единого `bun:`-импорта: его обязан уметь исполнить и node.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

/** Платформенный пакет для этой машины; null — нет официальной сборки. */
function platformPackage() {
  const os = { darwin: "darwin", linux: "linux", win32: "win-x64" };
  // win поддерживается только x64: arm64-сборку добавим, когда появится машина.
  if (process.platform === "win32") return process.arch === "x64" ? "@aistastudio/myc-win-x64" : null;
  const osId = os[process.platform];
  const cpu = { arm64: "arm64", x64: "x64" }[process.arch];
  if (osId === undefined || cpu === undefined) return null;
  const id = osId === "win-x64" ? osId : `${osId}-${cpu}`;
  return `@aistastudio/myc-${id}`;
}

const exeName = () => (process.platform === "win32" ? "myc.exe" : "myc");

/**
 * vec0 (sqlite-vec) — резолвится тем же путём, что и в бандле: из
 * node_modules зависимостей. Нет его — myc честно уйдёт на BM25, это не
 * отказ запуска.
 */
function resolveVec0() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const ext = { darwin: "dylib", linux: "so", win32: "dll" }[process.platform];
  const cpu = { arm64: "arm64", x64: "x64" }[process.arch];
  if (os === undefined || cpu === undefined) return null;
  try {
    return require_.resolve(`sqlite-vec-${os}-${cpu}/vec0.${ext}`);
  } catch {
    return null;
  }
}

/** Вендор → переменные, которые читает рантайм. Для бандла — свой набор. */
function setVendorEnv(root) {
  const ort = join(root, "vendor", "ort");
  if (existsSync(ort) && !process.env.MYC_ORT_WASM_DIR) process.env.MYC_ORT_WASM_DIR = ort;
  if (process.platform === "darwin") {
    const sqlite = join(root, "vendor", "sqlite", "libmyc-sqlite3.dylib");
    if (existsSync(sqlite) && !process.env.MYC_SQLITE) process.env.MYC_SQLITE = sqlite;
  }
  if (!process.env.MYC_SQLITE_VEC) {
    const vec = resolveVec0();
    if (vec !== null) process.env.MYC_SQLITE_VEC = vec;
  }
}

/**
 * Protective-флаги — ТОЛЬКО для бандла-под-Bun: там bun читает их до первой
 * строки. Нативный бинарь их отвергает как аргументы приложения — его защита
 * запечена в рецепт сборки (--no-compile-autoload-*), а не передаётся при
 * запуске. os.devNull — NUL на Windows, /dev/null на POSIX.
 */
function protectiveArgs() {
  return ["--no-env-file", `--config=${devNull}`];
}

function spawn(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) {
    process.stderr.write(`\n  myc: cannot start ${cmd}: ${r.error.message}\n\n`);
    process.exit(1);
  }
  process.exit(r.status === null ? 1 : r.status);
}

// 1. Явный путь — тесты и ручные раскладки. Protective-флаги НЕ добавляются:
// бинарь их отвергает как аргументы приложения (проверено эмпирически).
if (process.env.MYC_BINARY !== undefined && process.env.MYC_BINARY !== "") {
  setVendorEnv(dirname(dirname(process.env.MYC_BINARY)));
  spawn(process.env.MYC_BINARY, process.argv.slice(2));
}

// 2. Нативный бинарь из платформенного пакета — защищённый по построению
//    (рецепт сборки гасит автозагрузку .env и bunfig его cwd).
{
  const pkg = platformPackage();
  if (pkg !== null) {
    try {
      const root = dirname(require_.resolve(`${pkg}/package.json`));
      const binary = join(root, "bin", exeName());
      if (existsSync(binary)) {
        setVendorEnv(root);
        spawn(binary, process.argv.slice(2));
      }
    } catch {
      // пакет не установлен — фолбэк ниже
    }
  }
}

// 3. Фолбэк: бандл под Bun (экзотические платформы, окно между релизами).
const bundle = join(here, "..", "dist", "myc.js");
const hasBun = (() => {
  const r = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
})();
if (existsSync(bundle) && hasBun) {
  if (!process.env.MYC_ORT_WASM_DIR) {
    const ort = join(here, "..", "vendor", "ort");
    if (existsSync(ort)) process.env.MYC_ORT_WASM_DIR = ort;
  }
  if (!process.env.MYC_SQLITE_VEC) {
    const vec = resolveVec0();
    if (vec !== null) process.env.MYC_SQLITE_VEC = vec;
  }
  spawn("bun", [...protectiveArgs(), bundle, ...process.argv.slice(2)]);
}

// 4. Честный отказ: ни бинаря, ни бандла.
{
  const node = process.versions.node;
  const lines = [
    "",
    "  myc found nothing to run: no native binary for this platform and no bundle fallback.",
    "",
    `  platform: ${process.platform}/${process.arch}   node: ${node}`,
    "",
  ];
  if (process.platform === "win32") {
    lines.push(
      "  Native Windows: reinstall so the platform package installs —",
      "      npm install -g @aistastudio/myc",
      "  (or remove the global myc and add it again). Without it, use WSL:",
      "      wsl --install",
      "  then, inside WSL: install Bun and @aistastudio/myc there.",
      "",
    );
  } else {
    lines.push(
      "  Reinstall the package — the platform binary comes as an optional",
      "  dependency and can be skipped by a broken npm configuration:",
      "      npm install -g @aistastudio/myc --force",
      "",
      "  Or install Bun (>= 1.3.0) — with Bun the package can run from its",
      "  bundled JS instead of the native binary:",
      "      curl -fsSL https://bun.sh/install | bash",
      "",
    );
  }
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}
