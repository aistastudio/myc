#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Точка входа npm-пакета @aistastudio/myc.
 *
 * Файл СОЗНАТЕЛЬНО написан на голом JS без единого `bun:`-импорта и без TS:
 * его обязан уметь разобрать и выполнить Node. Иначе отказ выглядел бы как
 * `Cannot find module 'bun:sqlite'` из глубины бандла — стек вместо причины
 * (И2: деградация обязана быть громкой И понятной).
 *
 * Порядок важен: сначала проверка рантайма, и только потом ДИНАМИЧЕСКИЙ
 * импорт бандла. Статический импорт Node разрешил бы до первой строки тела
 * модуля — и мы бы снова упали на `bun:sqlite`, не успев ничего сказать.
 *
 * SHEBANG. Оба флага — про ЧУЖОЙ каталог: myc зовут хуки и MCP в каждом
 * проекте пользователя, и cwd — это его проект. Без них Bun ДО первой строки
 * этого файла грузит .env, .env.local, .env.<NODE_ENV> каталога в process.env
 * (а `myc run` отдавал их команде: 2026-09-11 в cherry `bun test` получил
 * 20 переменных EXPO_PUBLIC_* из .env worktree, которых в оболочке агента не
 * было) и исполняет preload из ./bunfig.toml — happy-dom и моки тестов
 * проекта внутри myc.
 *   --no-env-file       .env* не грузятся;
 *   --config=/dev/null  пустой конфиг вместо ./bunfig.toml. «Без конфига» у
 *                       Bun нет: `--config=` (пусто) молча возвращает
 *                       ./bunfig.toml, несуществующий путь — фатальная ошибка
 *                       до старта, а /dev/null есть на любой POSIX. Глобальный
 *                       ~/.bunfig.toml Bun читает по-прежнему: он не проектный.
 * `env -S` нужен, чтобы флаги дошли до bun раздельно: ядро Linux отдаёт всё
 * после интерпретатора ОДНИМ аргументом. -S есть в GNU coreutils ≥ 8.30 и в
 * env macOS/BSD. На Windows такой shebang не исполним: шим `bun add -g` берёт
 * `-S` за программу, а cmd-shim npm -S понимает, но Bun на Windows не
 * открывает /dev/null — myc там только через WSL (говорят preflight.js и
 * refusal() ниже, если этот файл всё же запустили под Node).
 * Запуск МИМО shebang (`bun …/myc.js`) флагов не получает; второй рубеж для
 * `myc run` — callerEnv в src/commands/run.ts.
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

/**
 * Текст отказа — по-английски, как весь вывод CLI (эпик memory-rc2s0m1e9kpz).
 * На Windows совет «поставьте Bun» был бы ложным: shebang там не исполним и с
 * Bun (см. шапку и preflight.js), поэтому совет там один — WSL, тем же текстом,
 * что в рамке preflight.js.
 */
function refusal() {
  const node = process.versions.node;
  const lines = [
    "",
    "  myc requires Bun — it cannot run on Node.",
    "",
    `  This is Node ${node}, and myc runs only on Bun: its storage is built`,
    "  on Bun's built-in `bun:sqlite`, which Node does not have.",
    "",
  ];
  if (process.platform === "win32") {
    lines.push(
      "  myc runs on macOS and Linux; on Windows use WSL.",
      "  The `myc` launcher will not start in cmd or PowerShell, with or without Bun.",
      "      wsl --install",
      "  Then, inside WSL: install Bun and @aistastudio/myc there.",
      "",
    );
  } else if (bunOnPath()) {
    lines.push(
      "  Bun is installed — run myc through it:",
      "      bun x myc <command>",
      "  or reinstall the package with bun:",
      "      bun add -g @aistastudio/myc",
      "",
    );
  } else {
    lines.push(
      "  Install Bun (>= 1.3.0) and try again:",
      "      curl -fsSL https://bun.sh/install | bash        # macOS, Linux, WSL",
      "",
      "  Then: myc --version",
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
