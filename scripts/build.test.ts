/**
 * СБОРКА ЗАВИСИТ ТОЛЬКО ОТ РЕЦЕПТА, И ФОН В ЕЁ АРТЕФАКТЕ ЖИВ
 * (memory-h5zp5mqcdbay).
 *
 * Дефект, ради которого это здесь: `bun build` запекает в бандл NODE_ENV из
 * окружения сборки, и бинарь, собранный под `bun test`, получал сторож
 * тестового режима в drainAfterCommand свёрнутым в безусловный return — ни
 * absorb, ни прогона якорей, ни code_refresh после команд, и ни один тест
 * этого не видел: тесты гоняют исходники. Защит три, и каждая пригвождена
 * своим тестом:
 *
 *  1. рецепт называет NODE_ENV сам (NODE_ENV_DEFINE), и окружение сборки на
 *     бандл не влияет;
 *  2. собственный код не читает NODE_ENV так, чтобы бандлер мог свернуть, —
 *     здесь это доказано на артефакте: бинарь, собранный БЕЗ define рецепта
 *     и ПОД NODE_ENV=test (худший случай), делает фон (исходники сторожит
 *     packages/cli/src/node-env-fold.test.ts);
 *  3. сборка сама проверяет артефакт смоуком фона и не ставит на место
 *     красный.
 *
 * Мутации: снять NODE_ENV_DEFINE из BUILD_ARGS — краснеют первые два теста;
 * вернуть литерал `process.env.NODE_ENV` в drainAfterCommand — краснеет
 * третий (свёрнутый return), а заодно node-env-fold.test.ts; смоук без фона
 * (MYC_DRAIN=0 — снаружи неотличимо от свёрнутого сторожа) обязан краснеть
 * — четвёртый и пятый.
 *
 * ЦЕНА ~4 с: три сборки бинаря по ~1 с (без define — одна на тесты 3–4,
 * две — красная и зелёная — в пятом), четыре смоука по 0,15–1 с (первый
 * запуск свежего бинаря дорог), две сборки-пробы бандлом по ~0,1 с.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ARGS, NODE_ENV_DEFINE, buildBinary, recipeArgs, smokeBinary } from "./build.ts";
import { BUNDLED_SQLITE_FILE } from "../packages/store-sqlite/src/runtime.ts";

const ROOT = join(import.meta.dir, "..");

let tmp: string;
/** Рецепт без NODE_ENV_DEFINE, собранный под NODE_ENV=test: худший случай для п. 2. */
let unpinned: string;

async function spawnOk(args: readonly string[], env: Record<string, string | undefined>, cwd = ROOT): Promise<string> {
  const proc = Bun.spawn([...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(" ")} … вернул ${code}: ${err}`);
  return out;
}

/** Окружение вызывающего с заданным NODE_ENV (undefined — без него). */
function withNodeEnv(value: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_ENV;
  if (value !== undefined) env.NODE_ENV = value;
  return env;
}

/** Пара `--define …` из рецепта — ровно та, что стоит в BUILD_ARGS, а не копия. */
function recipeDefine(): string[] {
  const at = BUILD_ARGS.indexOf("--define");
  return at < 0 ? [] : BUILD_ARGS.slice(at, at + 2);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "myc-build-test-"));
  unpinned = join(tmp, "myc-unpinned");
  await spawnOk(recipeArgs(unpinned, NODE_ENV_DEFINE), withNodeEnv("test"));
  if (!existsSync(unpinned)) throw new Error(`сборка вернула 0, а ${unpinned} нет`);
}, 300_000);

afterAll(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
});

describe("п. 1: NODE_ENV бандла назван рецептом", () => {
  test("BUILD_ARGS несёт define NODE_ENV=production парой", () => {
    expect(recipeDefine()).toEqual([...NODE_ENV_DEFINE]);
    expect(NODE_ENV_DEFINE).toEqual(["--define", 'process.env.NODE_ENV="production"']);
  });

  test("define рецепта сильнее окружения сборки: под NODE_ENV=test бандл печёт production", async () => {
    const probe = join(tmp, "probe.ts");
    writeFileSync(probe, "console.log(String(process.env.NODE_ENV));\n");
    const bundle = async (name: string, define: readonly string[]): Promise<string> => {
      const out = join(tmp, `${name}.js`);
      await spawnOk([process.execPath, "build", "--target=bun", "--minify", ...define, probe, "--outfile", out], withNodeEnv("test"));
      // Запуск с другим NODE_ENV: запечённое значение его не видит, чтение в рантайме — видит.
      return (await spawnOk([process.execPath, out], withNodeEnv("runtime"), tmp)).trim();
    };
    // Контроль: без define проба действительно видит подстановку из окружения
    // сборки — иначе зелёный результат ниже ничего бы не доказывал.
    expect(await bundle("probe-bare", [])).toBe("test");
    expect(await bundle("probe-recipe", recipeDefine())).toBe("production");
  }, 60_000);
});

describe("п. 2 на артефакте: без define и под NODE_ENV=test бинарь делает фон", () => {
  test("смоук зелёный: вторая команда сдвигает anchor_swept_at", async () => {
    const r = await smokeBinary(unpinned);
    expect(r.sweptAfter).not.toBeNull();
    if (r.sweptBefore !== null) expect(r.sweptAfter!).toBeGreaterThan(r.sweptBefore);
  }, 60_000);
});

describe("п. 3: смоук ловит бинарь без фона, и сборка его не ставит", () => {
  test("фон погашен (MYC_DRAIN=0 — снаружи то же, что свёрнутый сторож): смоук красный", async () => {
    await expect(smokeBinary(unpinned, { MYC_DRAIN: "0" })).rejects.toThrow("anchor_swept_at не сдвинулся");
  }, 60_000);

  test("красная сборка не трогает прежний артефакт, зелёная — ставит новый", async () => {
    const dir = join(tmp, "dist");
    mkdirSync(dir);
    const target = join(dir, "myc");
    writeFileSync(target, "previous artifact\n");

    await expect(buildBinary({ quiet: true, outfile: target, smokeEnv: { MYC_DRAIN: "0" } })).rejects.toThrow(
      "артефакт не заменён",
    );
    expect(readFileSync(target, "utf8")).toBe("previous artifact\n");
    // Ни полусобранного файла, ни временного рядом с целью.
    expect(readdirSync(dir)).toEqual(["myc"]);

    const ok = await buildBinary({ quiet: true, outfile: target });
    expect(ok.binary).toBe(target);
    expect(statSync(target).size).toBeGreaterThan(1_000_000);
    // Зелёная сборка кладёт рядом свою SQLite (issue #1), если она собрана:
    // скомпилированный myc ищет её в своём каталоге.
    const bundled = join(import.meta.dir, "..", "packages", "store-sqlite", "vendor", "sqlite", BUNDLED_SQLITE_FILE);
    const companion = process.platform === "darwin" && existsSync(bundled);
    expect(readdirSync(dir).sort()).toEqual(companion ? [BUNDLED_SQLITE_FILE, "myc"].sort() : ["myc"]);
    expect((await spawnOk([target, "--version"], withNodeEnv(undefined), tmp)).trim()).toStartWith("myc ");
  }, 300_000);
});
