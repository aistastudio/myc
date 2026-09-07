#!/usr/bin/env bun
/**
 * Точка входа npm-пакета @myc/cli.
 *
 * Файл СОЗНАТЕЛЬНО написан на голом JS без единого `bun:`-импорта и без TS:
 * его обязан уметь разобрать и выполнить Node. Иначе отказ выглядел бы как
 * `Cannot find module 'bun:sqlite'` из глубины бандла — стек вместо причины
 * (И2: деградация обязана быть громкой И понятной).
 *
 * Порядок важен: сначала проверка рантайма, и только потом ДИНАМИЧЕСКИЙ
 * импорт бандла. Статический импорт Node разрешил бы до первой строки тела
 * модуля — и мы бы снова упали на `bun:sqlite`, не успев ничего сказать.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

if (typeof process.versions.bun !== "string") {
  process.stderr.write(refusal());
  process.exit(1);
}

// Файлы ONNX-рантайма лежат внутри пакета: JS-часть ort вшита в бандл, а .wasm
// грузится с диска по этому пути. Явное значение пользователя не трогаем.
const wasmDir = process.env.MYC_ORT_WASM_DIR;
if (typeof wasmDir !== "string" || wasmDir === "") {
  process.env.MYC_ORT_WASM_DIR = join(here, "..", "vendor", "ort");
}

// vec0 (sqlite-vec) — векторный индекс. Автопоиск в @myc/store-sqlite смотрит
// рядом с process.execPath (у нас это bun, не пакет) и в кеш `bun install`,
// которого при установке через npm нет. Отдаём точный путь из зависимости.
// Явно заданный пользователем MYC_SQLITE_VEC не трогаем.
const vecEnv = process.env.MYC_SQLITE_VEC;
if (typeof vecEnv !== "string" || vecEnv === "") {
  const vec = resolveVec0();
  if (vec !== null) process.env.MYC_SQLITE_VEC = vec;
}

await import("../dist/myc.js");

/**
 * Путь к vec0 внутри платформенного пакета sqlite-vec-<os>-<arch>. null —
 * не нашли: тогда работает штатный автопоиск, а без него myc честно скажет
 * `vec0 не загружен` и уйдёт на BM25.
 */
function resolveVec0() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const ext = { darwin: "dylib", linux: "so", win32: "dll" }[process.platform];
  const cpu = { arm64: "arm64", x64: "x64" }[process.arch];
  if (os === undefined || cpu === undefined) return null;
  const file = `sqlite-vec-${os}-${cpu}/vec0.${ext}`;
  try {
    return createRequire(import.meta.url).resolve(file);
  } catch {
    return null;
  }
}

function refusal() {
  const node = process.versions.node;
  const lines = [
    "",
    "  myc requires Bun — it cannot run on Node.",
    "",
    `  myc запущен под Node ${node}, а он работает только на Bun: хранилище`,
    "  построено на встроенном в Bun `bun:sqlite`, которого в Node нет.",
    "",
  ];
  if (bunOnPath()) {
    lines.push(
      "  Bun у вас установлен — запускайте через него:",
      "      bun x myc <команда>",
      "  либо переустановите пакет средствами bun:",
      "      bun add -g @myc/cli",
      "",
    );
  } else {
    lines.push(
      "  Установите Bun (>= 1.3.0) и повторите:",
      "      curl -fsSL https://bun.sh/install | bash        # macOS, Linux, WSL",
      '      powershell -c "irm bun.sh/install.ps1 | iex"    # Windows',
      "",
      "  После установки: myc --version",
      "",
    );
  }
  return lines.join("\n");
}

/** Только для текста отказа: лишний spawn на нормальном пути не делается. */
function bunOnPath() {
  try {
    const r = spawnSync("bun", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}
