/**
 * ПЕРВЫЙ РУБЕЖ против .env и bunfig.toml ЧУЖОГО каталога (memory-6an5synt4mex).
 *
 * myc зовут хуки и MCP в каждом проекте пользователя, и cwd процесса — его
 * проект. Bun без флагов до первой строки кода грузит .env* этого каталога в
 * process.env и исполняет preload из его bunfig.toml. 2026-09-11 в cherry
 * `myc run -- bun test` отдал тесту 20 переменных EXPO_PUBLIC_* из .env
 * worktree, которых в оболочке агента не было.
 *
 * С 0.6.0 защита живёт в ДВУХ местах, и здесь проверяются ОБА:
 *   - бинарь собирается флагами `--no-compile-autoload-dotenv/--no-compile-autoload-bunfig`
 *     (BUILD_ARGS, scripts/build.ts): bun внутри него не читает .env/bunfig
 *     своего cwd вовсе — этим защищён и нативный путь, и `myc --compile`;
 *   - npm-лаунчик bin/myc.js на голом node: node .env чужого проекта не
 *     грузит, а бандл-фолбэк под Bun получает protective-флаги в argv
 *     (--no-env-file, --config=os.devNull) — как прежний shebang
 *     `env -S`, который на Windows не исполним ни одним шимом.
 *
 * Здесь проверяется ЗАПУСК, а не код: исполняемый файл запускает ядро так,
 * как после установки. Пакет раскладывается как в scripts/pack-npm.ts —
 * bin/myc.js рядом с dist/myc.js, собранным `bun build`; бинарь собирается
 * РЕЦЕПТОМ scripts/build.ts (BUILD_ARGS), только в свой каталог. Каталог
 * «проекта» лежит вне дерева репозитория, в нём .env, .env.local и bunfig.toml
 * с preload, который пишет файл-метку.
 *
 * Установленный myc не нужен: запускаются только собранные здесь файлы, а
 * `bun` для shebang берётся из process.execPath раннера.
 *
 * МУТАЦИИ — не только на приёмке, но и здесь же: лаунчик без protective-флагов,
 * лаунчик без --config, и бинарь, собранный БЕЗ --no-compile-autoload-*, — каждый
 * из них обязан пропустить .env или preload. Иначе зелёный результат не
 * отличал бы защиту от каталога, в котором защищать нечего.
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

async function launch(cmd: readonly string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([...cmd], {
    cwd: project,
    env: cliTestEnv({
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      MYC_HOME: home,
      MYC_CALLER_PROBE: "from-caller",
      ...extraEnv,
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
function runProbe(exe: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  const script = `printf '%s|%s|%s' "\${${PROBE}:-nothing}" "\${${PROBE_LOCAL}:-nothing}" "\${MYC_CALLER_PROBE:-nothing}"`;
  return launch([exe, "run", "--", "sh", "-c", script], extraEnv);
}

/** Копия лаунчера рядом с настоящей с подменённым фрагментом — для мутаций. */
function mutatedLauncher(name: string, from: string, to: string): string {
  const path = join(dirname(pkgBin), name);
  const text = readFileSync(BIN, "utf8");
  if (!text.includes(from)) throw new Error(`в лаунчере нет текста мутации: ${from}`);
  writeFileSync(path, text.replace(from, to));
  chmodSync(path, 0o755);
  return path;
}

async function build(args: readonly string[]): Promise<void> {
  const proc = Bun.spawn([...args], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(" ")} … провалилась (код ${code}): ${err}`);
}

/** BUILD_ARGS с выходом в outfile; drop — флаги, которые мутация выбрасывает. */
function recipe(outfile: string, drop: readonly string[] = []): string[] {
  const args = BUILD_ARGS.filter((a) => !drop.includes(a));
  const at = args.indexOf("--outfile");
  if (at < 0) throw new Error("в BUILD_ARGS нет --outfile");
  args[at + 1] = outfile;
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

describe("лаунчик и рецепт: где живёт защита", () => {
  test("shebang bin/myc.js — env node: разбирают все шимы, включая Windows", () => {
    expect(SHEBANG).toBe("#!/usr/bin/env node");
  });

  test("бандл-фолбэк лаунчера сохраняет protective-флаги — наследие shebang", () => {
    const text = readFileSync(BIN, "utf8");
    expect(text).toContain("--no-env-file");
    expect(text).toContain("--config=");
  });

  test("рецепт бинаря отключает автозагрузку .env и bunfig.toml", () => {
    expect(BUILD_ARGS).toContain("--no-compile-autoload-dotenv");
    expect(BUILD_ARGS).toContain("--no-compile-autoload-bunfig");
  });
});

describe("npm-пакет: лаунчер запускает ядро, чужой каталог не читается", () => {
  test("myc run: команда получает окружение вызывающего и ничего из .env", async () => {
    const run = await runProbe(pkgBin);
    expect(run.code).toBe(0);
    expect(run.out).toBe("nothing|nothing|from-caller");
    expect(run.err).not.toContain("run.dotenv");
    expect(preloadRan()).toBe(false);
  });

  test("myc --version: preload из ./bunfig.toml не исполняется", async () => {
    const run = await launch([pkgBin, "--version"]);
    expect(run.code).toBe(0);
    expect(run.out).toStartWith("myc ");
    expect(preloadRan()).toBe(false);
  });

  test("мутация: бандл-фолбэк без --no-env-file — Bun грузит .env, и это НАЗВАНО", async () => {
    const mutant = mutatedLauncher(
      "mutant-dotenv.js",
      'return ["--no-env-file", `--config=${devNull}`];',
      "return [`--config=${devNull}`];",
    );
    const run = await runProbe(mutant);
    expect(run.code).toBe(0);
    // .env в процессе myc, и второй рубеж это видит и называет...
    expect(run.err).toContain("WARN run.dotenv");
    expect(run.err).toContain(PROBE);
    // ...а команде его всё равно не отдаёт.
    expect(run.out).toBe("nothing|nothing|from-caller");
  });

  test("мутация: бандл-фолбэк без --config — preload проекта исполняется в myc", async () => {
    const mutant = mutatedLauncher(
      "mutant-bunfig.js",
      'return ["--no-env-file", `--config=${devNull}`];',
      'return ["--no-env-file"];',
    );
    const run = await launch([mutant, "--version"]);
    expect(run.code).toBe(0);
    expect(preloadRan()).toBe(true);
  });
});

describe("собранный бинарь: рецепт scripts/build.ts", () => {
  test("MYC_BINARY: myc run получает окружение вызывающего и ничего из .env", async () => {
    const run = await runProbe(pkgBin, { MYC_BINARY: binary });
    expect(run.code).toBe(0);
    expect(run.out).toBe("nothing|nothing|from-caller");
    expect(run.err).not.toContain("WARN");
    expect(preloadRan()).toBe(false);
  });

  test("MYC_BINARY: preload из ./bunfig.toml не исполняется", async () => {
    const run = await launch([pkgBin, "--version"], { MYC_BINARY: binary });
    expect(run.code).toBe(0);
    expect(run.out).toStartWith("myc ");
    expect(preloadRan()).toBe(false);
  });

  test("мутация: бинарь без двух флагов — отдаёт .env команде и исполняет preload", async () => {
    // Это и есть доказательство, что --no-compile-autoload-* — не украшение:
    // собранный БЕЗ них бинарь воспроизводит инцидент из cherry.
    const run = await runProbe(pkgBin, { MYC_BINARY: mutantBinary });
    expect(run.code).toBe(0);
    expect(run.out).toBe("from-dotenv|from-dotenv-local|from-caller");
    expect(preloadRan()).toBe(true);
  });

  test("код выхода бинаря доходит до вызвавшего без искажений", async () => {
    const run = await launch([pkgBin, "run", "--", "sh", "-c", "exit 7"], { MYC_BINARY: binary });
    expect(run.code).toBe(7);
  });
});

describe("bin/*.js: что видит человек, когда запускать нечего", () => {
  async function bareNode(argv: readonly string[], env: Record<string, string> = {}): Promise<Run> {
    const emptyBin = join(tmp, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const proc = Bun.spawn([process.execPath, ...argv], {
      cwd: tmp,
      // PATH без bun: проверяем отказ, а не фолбэк.
      env: cliTestEnv({ PATH: emptyBin, ...env }),
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

  test("ни бинаря, ни бандла: код 1, по-английски, с причиной и что делать", async () => {
    // Каталог без пакета рядом: лаунчер лежит в repo packages/cli/bin, где
    // нет ни dist/myc.js, ни @aistastudio/myc-*.
    const run = await bareNode([BIN, "--version"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("found nothing to run");
    expect(run.err).toContain("npm install -g @aistastudio/myc --force");
  });

  test("на Windows отказывает про WSL — той же рамкой, что preflight", async () => {
    const fake = join(tmp, "fake-win.js");
    writeFileSync(fake, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
    const run = await bareNode(["--preload", fake, BIN, "--version"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("wsl --install");
  });

  test("настоящий node разбирает лаунчер и печатает английский отказ", async () => {
    const run = await bareNode([BIN, "--version"]);
    expect(run.out + run.err).toContain("myc");
    expect(run.err).not.toMatch(/[а-яё]/i);
  });
});

describe("preflight (postinstall)", () => {
  async function preflight(platform: string | null, withPackage: boolean): Promise<Run> {
    const dir = join(tmp, `preflight-${platform ?? "native"}-${withPackage}`);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "preflight.js"), readFileSync(PREFLIGHT));
    if (withPackage) {
      // Фейковый платформенный пакет рядом — резолвер лаунчера его находит.
      const pkgRoot = join(dir, "node_modules", "@aistastudio", "myc-darwin-arm64");
      mkdirSync(join(pkgRoot, "bin"), { recursive: true });
      writeFileSync(join(pkgRoot, "package.json"), '{"name":"@aistastudio/myc-darwin-arm64"}');
      writeFileSync(join(pkgRoot, "bin", "myc"), "");
    }
    const fake = join(dir, "fake-platform.js");
    writeFileSync(fake, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`);
    const proc = Bun.spawn(
      [process.execPath, ...(platform === null ? [] : ["--preload", fake]), join(dir, "bin", "preflight.js")],
      { cwd: dir, env: cliTestEnv(), stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }

  test("на Windows без нативного бинаря: говорит про WSL и установку не роняет", async () => {
    const run = await preflight("win32", false);
    expect(run.code).toBe(0);
    expect(run.err).toContain("did not install");
    expect(run.err).toContain("wsl --install");
  });

  test("бинарь на месте — молчит", async () => {
    const run = await preflight(null, true);
    expect(run.code).toBe(0);
    expect(run.err).toBe("");
  });
});
