/**
 * ПЕРВЫЙ РУБЕЖ против .env и bunfig.toml ЧУЖОГО каталога (memory-6an5synt4mex).
 *
 * myc зовут хуки и MCP в каждом проекте пользователя, и cwd процесса — его
 * проект. Bun без флагов до первой строки кода грузит .env* этого каталога в
 * process.env и исполняет preload из его bunfig.toml. 2026-09-11 в cherry
 * `myc run -- bun test` отдал тесту 20 переменных EXPO_PUBLIC_* из .env
 * worktree, которых в оболочке агента не было.
 *
 * Здесь проверяется ЗАПУСК, а не код: исполняемый файл запускает ядро по
 * shebang, как после `bun add -g` (симлинк в ~/.bun/bin) и `npm i -g`. Пакет
 * раскладывается так же, как в scripts/pack-npm.ts — bin/myc.js рядом с
 * dist/myc.js, собранным `bun build --target=bun --minify`; бинарь собирается
 * РЕЦЕПТОМ scripts/build.ts (BUILD_ARGS), только в свой каталог, чтобы не
 * трогать dist/myc, которым пользуется хук очереди. Каталог «проекта» лежит
 * вне дерева репозитория, в нём .env, .env.local и bunfig.toml с preload,
 * который пишет файл-метку.
 *
 * Установленный myc не нужен (урок e6252ea): запускаются только собранные
 * здесь файлы, а `bun` для shebang берётся из process.execPath раннера.
 *
 * Мутации — не только на приёмке, но и здесь же, отдельными тестами: копия
 * bin/myc.js без одного из флагов и бинарь по рецепту без двух флагов обязаны
 * пропустить .env / preload. Иначе зелёный результат не отличал бы защиту от
 * каталога, в котором защищать нечего.
 *
 * ЦЕНА. Две сборки бинаря по ~0.3 с и одна бандла ~0.1 с, дюжина запусков.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliTestEnv } from "@myc/core";
import { BUILD_ARGS } from "../../../scripts/build.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const BIN = join(import.meta.dir, "..", "bin", "myc.js");
const PREFLIGHT = join(import.meta.dir, "..", "bin", "preflight.js");
const SHEBANG = readFileSync(BIN, "utf8").split("\n")[0] ?? "";

/** Уникальные имена: совпадение с чем-то в окружении раннера исключено. */
const PROBE = `MYC_DOTENV_PROBE_${process.pid}`;
const PROBE_LOCAL = `MYC_DOTENV_LOCAL_PROBE_${process.pid}`;

let tmp: string;
let project: string;
let marker: string;
let home: string;
let pkgBin: string;
let binary: string;
let mutantBinary: string;

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function launch(cmd: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([...cmd], {
    cwd: project,
    env: cliTestEnv({
      // shebang ищет bun в PATH: первым — тот, что гоняет тесты.
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      MYC_HOME: home,
      MYC_CALLER_PROBE: "from-caller",
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** `myc run` команды, которая печатает, что из .env и от вызывающего до неё дошло. */
function runProbe(exe: string): Promise<Run> {
  const script = `printf '%s|%s|%s' "\${${PROBE}:-nothing}" "\${${PROBE_LOCAL}:-nothing}" "\${MYC_CALLER_PROBE:-nothing}"`;
  return launch([exe, "run", "--", "sh", "-c", script]);
}

/** Копия bin/myc.js рядом с настоящей (тот же ../dist/myc.js) с другим shebang. */
function binWithShebang(name: string, shebang: string): string {
  const path = join(dirname(pkgBin), name);
  writeFileSync(path, readFileSync(BIN, "utf8").replace(SHEBANG, shebang));
  chmodSync(path, 0o755);
  return path;
}

async function build(args: readonly string[]): Promise<void> {
  const proc = Bun.spawn([...args], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(" ")} … провалилась (код ${code}): ${err}`);
}

/** BUILD_ARGS с выходом в outfile вместо dist/myc; drop — флаги, которые мутация выбрасывает. */
function recipe(outfile: string, drop: readonly string[] = []): string[] {
  const args = BUILD_ARGS.filter((a) => !drop.includes(a));
  const at = args.indexOf("--outfile");
  if (at < 0) throw new Error("в BUILD_ARGS нет --outfile");
  args[at + 1] = outfile;
  // Тот bun, что гоняет тесты, а не первый в PATH.
  if (args[0] === "bun") args[0] = process.execPath;
  return args;
}

function preloadRan(): boolean {
  return existsSync(marker);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "myc-launcher-"));
  project = join(tmp, "project");
  home = join(tmp, "home");
  mkdirSync(project);
  mkdirSync(home);
  marker = join(project, "preload-ran");
  writeFileSync(join(project, ".env"), `${PROBE}=from-dotenv\n`);
  writeFileSync(join(project, ".env.local"), `${PROBE_LOCAL}=from-dotenv-local\n`);
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./pre.js"]\n');
  writeFileSync(
    join(project, "pre.js"),
    'import { appendFileSync } from "node:fs";\nappendFileSync(new URL("./preload-ran", import.meta.url), "x");\n',
  );

  const pkg = join(tmp, "pkg");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  pkgBin = join(pkg, "bin", "myc.js");
  writeFileSync(pkgBin, readFileSync(BIN));
  chmodSync(pkgBin, 0o755);
  binary = join(tmp, "myc");
  mutantBinary = join(tmp, "myc-autoload");
  // Два `bun build --compile` подряд, а не разом: 2026-09-12 под нагрузкой
  // один из двух параллельных вернул код 0, а бинаря-мутанта на месте не
  // оказалось — тест мутации упал на ENOENT, соседи на обычном бинаре прошли.
  await build([process.execPath, "build", "--target=bun", "--minify", "packages/cli/src/main.ts", "--outfile", join(pkg, "dist", "myc.js")]);
  await build(recipe(binary));
  await build(recipe(mutantBinary, ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"]));
  for (const out of [join(pkg, "dist", "myc.js"), binary, mutantBinary]) {
    if (!existsSync(out)) throw new Error(`сборка вернула 0, а ${out} нет — дальше тесты мерили бы пустое место`);
  }
}, 300_000);

// Метка preload — от каждого запуска своя: упавший тест не подкрашивает соседей.
beforeEach(() => {
  if (marker !== undefined) rmSync(marker, { force: true });
});

afterAll(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
});

describe("флаги запуска", () => {
  test("shebang bin/myc.js: bun без .env и без ./bunfig.toml, флаги раздельно через env -S", () => {
    expect(SHEBANG.startsWith("#!/usr/bin/env -S bun ")).toBe(true);
    const flags = SHEBANG.split(/\s+/).slice(3);
    expect(flags).toContain("--no-env-file");
    expect(flags).toContain("--config=/dev/null");
  });

  test("рецепт бинаря отключает автозагрузку .env и bunfig.toml", () => {
    expect(BUILD_ARGS).toContain("--no-compile-autoload-dotenv");
    expect(BUILD_ARGS).toContain("--no-compile-autoload-bunfig");
  });
});

describe("npm-пакет: bin/myc.js запускает ядро по shebang", () => {
  test("myc run: команда получает окружение вызывающего и ничего из .env", async () => {
    const run = await runProbe(pkgBin);
    expect(run.code).toBe(0);
    expect(run.out).toBe("nothing|nothing|from-caller");
    // Второй рубеж молчит — значит .env не попал и в сам процесс myc.
    expect(run.err).not.toContain("run.dotenv");
    expect(preloadRan()).toBe(false);
  });

  test("myc --version: preload из ./bunfig.toml не исполняется", async () => {
    const run = await launch([pkgBin, "--version"]);
    expect(run.code).toBe(0);
    expect(run.out).toStartWith("myc ");
    expect(preloadRan()).toBe(false);
  });

  test("мутация: shebang без --no-env-file — Bun грузит .env в процесс myc", async () => {
    const mutant = binWithShebang("mutant-dotenv.js", "#!/usr/bin/env -S bun --config=/dev/null");
    const run = await runProbe(mutant);
    expect(run.code).toBe(0);
    // .env в процессе myc, и второй рубеж это видит и называет...
    expect(run.err).toContain("WARN run.dotenv");
    expect(run.err).toContain(PROBE);
    // ...а команде его всё равно не отдаёт.
    expect(run.out).toBe("nothing|nothing|from-caller");
  });

  test("мутация: shebang без --config=/dev/null — preload проекта исполняется в myc", async () => {
    const mutant = binWithShebang("mutant-bunfig.js", "#!/usr/bin/env -S bun --no-env-file");
    const run = await launch([mutant, "--version"]);
    expect(run.code).toBe(0);
    expect(preloadRan()).toBe(true);
  });
});

describe("собранный бинарь: рецепт scripts/build.ts", () => {
  test("myc run: команда получает окружение вызывающего и ничего из .env", async () => {
    const run = await runProbe(binary);
    expect(run.code).toBe(0);
    expect(run.out).toBe("nothing|nothing|from-caller");
    expect(run.err).not.toContain("WARN");
    expect(preloadRan()).toBe(false);
  });

  test("myc --version: preload из ./bunfig.toml не исполняется", async () => {
    const run = await launch([binary, "--version"]);
    expect(run.code).toBe(0);
    expect(run.out).toStartWith("myc ");
    expect(preloadRan()).toBe(false);
  });

  test("мутация: рецепт без двух флагов — бинарь отдаёт .env команде и исполняет preload", async () => {
    const run = await runProbe(mutantBinary);
    expect(run.code).toBe(0);
    expect(run.out).toBe("from-dotenv|from-dotenv-local|from-caller");
    expect(preloadRan()).toBe(true);
  });
});

describe("preflight (postinstall)", () => {
  async function preflight(platform: string | null): Promise<Run> {
    const fake = join(tmp, "fake-platform.js");
    writeFileSync(fake, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`);
    const proc = Bun.spawn(
      [process.execPath, ...(platform === null ? [] : ["--preload", fake]), PREFLIGHT],
      { cwd: tmp, env: cliTestEnv(), stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }

  test("на Windows говорит, что myc там только через WSL, и установку не роняет", async () => {
    // Shebang с `env -S` и /dev/null Windows не исполнит ни шимом bun, ни
    // cmd-shim npm — сказать можно только на установке.
    const run = await preflight("win32");
    expect(run.code).toBe(0);
    expect(run.err).toContain("Windows is not supported");
    expect(run.err).toContain("myc runs on macOS and Linux; on Windows use WSL.");
  });

  test("на POSIX под Bun молчит", async () => {
    const run = await preflight(null);
    expect(run.code).toBe(0);
    expect(run.err).toBe("");
  });
});
