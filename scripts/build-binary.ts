#!/usr/bin/env bun
/**
 * Нативные бинари myc: `bun build --compile` под пять платформ и
 * платформенные пакеты `@aistastudio/myc-<id>` в тарболах.
 *
 * ЗАЧЕМ (задача memory-vqmed67a0x8h). Один shebang не может угодить двум
 * платформам: `#!/usr/bin/env -S bun --no-env-file --config=/dev/null` на
 * POSIX — защита от подхвата `.env` и bunfig-preload чужого проекта
 * (инцидент в cherry, 2026-09-11), а на Windows шим `bun add -g` берёт `-S`
 * за программу (`interpreter executable "-S" not found`), и даже починенный
 * upstream (#44968, ещё не в релизе) упрётся в `--config=/dev/null`,
 * которого на Windows нет. Нативный бинарь снимает обе стены разом:
 * shebang лаунчера становится `#!/usr/bin/env node` (npm понимает его
 * везде), флаги уходят в argv спавна и считаются по платформе
 * (`os.devNull` — NUL на Windows, /dev/null на POSIX), а Bun на машине
 * клиента не нужен вовсе — только здесь, при сборке.
 *
 * ПОРЯДОК СБОРКИ
 *   bun scripts/build-sqlite.ts   # macOS: своя SQLite, иначе пакет не строится
 *   bun run pack:npm              # мета-пакет: бандл, vendor/ort — общий источник вендора
 *   bun scripts/build-binary.ts   # этот скрипт → dist/binaries/*.tgz
 *
 * ЧТО ВЕЗЁТ ПЛАТФОРМЕННЫЙ ПАКЕТ
 *   bin/myc(.exe)   — bun runtime + весь myc одним файлом (bun build --compile)
 *   vendor/ort/     — .wasm ONNX: грузится с диска, лаунчер выставляет MYC_ORT_WASM_DIR
 *   vendor/sqlite/  — только macOS: своя SQLite (3.43 системной недостаточно),
 *                     лаунчер выставляет MYC_SQLITE
 *   LICENSE         — MIT
 * vec0 НЕ везётся: его даёт зависимость `sqlite-vec` мета-пакета, и лаунчер
 * резолвит его тем же путём, что и для бандла.
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_SQLITE_FILE } from "../packages/store-sqlite/src/runtime.ts";
import { BUNDLED_SQLITE_OUT_DIR } from "../packages/store-sqlite/src/bundled-sqlite.ts";
import { recipeArgs } from "./build.ts";

const ROOT = join(import.meta.dir, "..");
const VERSION = JSON.parse(await readFile(join(ROOT, "packages/cli/package.json"), "utf8")).version as string;
const OUT = join(ROOT, "dist", "binaries");
const ORT_DIST = join(ROOT, "packages/embed/node_modules/onnxruntime-web/dist");
const ORT_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];

type Target = {
  readonly id: string; // @aistastudio/myc-<id>
  readonly target: string; // bun-<os>-<arch>
  readonly bin: string; // имя файла бинаря
  readonly os: readonly string[]; // поле os платформенного пакета
  readonly cpu: readonly string[]; // поле cpu
  readonly sqlite: boolean; // везём ли своя SQLite (macOS)
};

const TARGETS: readonly Target[] = [
  { id: "win-x64", target: "bun-windows-x64", bin: "myc.exe", os: ["win32"], cpu: ["x64"], sqlite: false },
  { id: "darwin-arm64", target: "bun-darwin-arm64", bin: "myc", os: ["darwin"], cpu: ["arm64"], sqlite: true },
  { id: "darwin-x64", target: "bun-darwin-x64", bin: "myc", os: ["darwin"], cpu: ["x64"], sqlite: true },
  { id: "linux-x64", target: "bun-linux-x64", bin: "myc", os: ["linux"], cpu: ["x64"], sqlite: false },
  { id: "linux-aarch64", target: "bun-linux-aarch64", bin: "myc", os: ["linux"], cpu: ["arm64"], sqlite: false },
];

function run(argv: readonly string[]): void {
  const r = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`не собралось: ${argv.join(" ")}`);
}

async function main(): Promise<void> {
  if (VERSION === "") throw new Error("нет версии в packages/cli/package.json");
  // macOS без своей SQLite — пакет, который молча пишет в системную 3.43.2:
  // ровно тот дефект, ради которого своя SQLite и собирается.
  const sqliteLib = join(BUNDLED_SQLITE_OUT_DIR, BUNDLED_SQLITE_FILE);
  for (const t of TARGETS) {
    if (t.sqlite && !existsSync(sqliteLib)) {
      throw new Error(`нет ${sqliteLib}: сначала bun scripts/build-sqlite.ts`);
    }
  }
  for (const f of ORT_FILES) {
    if (!existsSync(join(ORT_DIST, f))) throw new Error(`нет ${ORT_DIST}/${f}: сначала bun install`);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const t of TARGETS) {
    const pkgName = `@aistastudio/myc-${t.id}`;
    const dir = join(OUT, t.id);
    await mkdir(join(dir, "bin"), { recursive: true });
    await mkdir(join(dir, "vendor", "ort"), { recursive: true });

    // Кросс-компиляция: bun собирает ЛЮБУЮ из перечисленных целей с любой
    // хостовой машины — рантайм целевой платформы скачивается и вшивается.
    // РЕЦЕПТ — общий с scripts/build.ts (recipeArgs): бинарь по умолчанию сам
    // грузит .env* и bunfig.toml своего cwd (проверено пробником 2026-10-17),
    // и защита от этого — `--no-compile-autoload-dotenv/--no-compile-autoload-bunfig`
    // — приезжает сюда вместе с --bytecode и --define NODE_ENV. Своя сборка
    // мимо recipeArgs дала бы бинарь, который подхватывает .env чужого
    // проекта ровно так, как подхватывала его старая сборка.
    process.stdout.write(`\n── ${pkgName} (${t.target})\n`);
    run([...recipeArgs(join(dir, "bin", t.bin)), `--target=${t.target}`]);

    for (const f of ORT_FILES) await cp(join(ORT_DIST, f), join(dir, "vendor", "ort", f));
    if (t.sqlite) {
      await mkdir(join(dir, "vendor", "sqlite"), { recursive: true });
      await cp(sqliteLib, join(dir, "vendor", "sqlite", BUNDLED_SQLITE_FILE));
    }
    if (existsSync(join(ROOT, "LICENSE"))) await cp(join(ROOT, "LICENSE"), join(dir, "LICENSE"));

    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: pkgName,
          version: VERSION,
          description: `Native myc binary for ${t.os.join("/")} ${t.cpu.join("/")}`,
          license: "MIT",
          os: t.os,
          cpu: t.cpu,
          repository: { type: "git", url: "git+https://github.com/aistastudio/myc.git" },
          files: ["bin", "vendor", "LICENSE"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const packed = spawnSync("npm", ["pack", "--pack-destination", OUT], { cwd: dir, encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`npm pack не собрал ${pkgName}: ${packed.stderr}`);
    process.stdout.write(`тарбол ${packed.stdout.trim().split("\n").pop()}\n`);
  }

  const sizes = TARGETS.map((t) => {
    const p = join(dir0(t), "bin", t.bin);
    return `${t.id}: ${existsSync(p) ? "✓" : "✗"}`;
  });
  process.stdout.write(`\nбинари: ${sizes.join(", ")}\n`);
  process.stdout.write(
    `тарболы: ${OUT}/myc-<id>-<версия>.tgz — публикуются все вместе с мета-пакетом @aistastudio/myc\n`,
  );
}

function dir0(t: Target): string {
  return join(OUT, t.id);
}

await main();
