/**
 * ВТОРОЙ РУБЕЖ: `myc run`, запущенный МИМО флагов shebang (memory-6an5synt4mex).
 *
 * `bun …/myc.js` и `bun packages/cli/src/main.ts` флагов bin/myc.js не
 * получают, и Bun грузит .env* каталога запуска в process.env. Команда под
 * очередью обязана получить окружение ВЫЗЫВАЮЩЕГО: callerEnv отличает
 * подмешанное по environ процесса (getenv(3)) — Bun туда не пишет. Первый
 * рубеж (сам shebang и рецепт бинаря) — в ../launcher.test.ts.
 *
 * Подмес .env в тесте в процессе делается тем же способом, каким его делает
 * Bun: присваиванием в process.env, которое до environ не доходит. В
 * дочернем процессе — настоящим .env и настоящим запуском без --no-env-file.
 *
 * Мутация, на которой файл обязан краснеть (проверена на приёмке):
 *   callerEnv отдаёт process.env как есть — падают «подмешанное не
 *   передаётся» и «bun main.ts run в каталоге с .env» (команда печатает
 *   from-dotenv).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliTestEnv } from "@myc/core";
import { callerEnv } from "./run.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const PROBE = `MYC_RUN_DOTENV_PROBE_${process.pid}`;

let tmp: string;
let withDotenv: string;
let withoutDotenv: string;
let home: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "myc-run-env-"));
  withDotenv = join(tmp, "with");
  withoutDotenv = join(tmp, "without");
  home = join(tmp, "home");
  for (const d of [withDotenv, withoutDotenv, home]) mkdirSync(d);
  writeFileSync(
    join(withDotenv, ".env"),
    // SHARED есть и у вызывающего: .env его не перекрывает, и команда
    // обязана получить значение вызывающего. MYC_HEAVY_SLOTS — попытка .env
    // переназначить саму очередь.
    `${PROBE}=from-dotenv\nMYC_SHARED_PROBE=from-dotenv\nMYC_HEAVY_SLOTS=not-a-number\n`,
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("callerEnv", () => {
  test("имя, подмешанное в process.env после запуска, команде не передаётся", async () => {
    const injected = `MYC_INJECTED_PROBE_${process.pid}`;
    process.env[injected] = "from-dotenv";
    try {
      const caller = await callerEnv({ execArgv: [], cwd: withDotenv });
      expect(caller.dotenv).toEqual([".env"]);
      // null — установить не удалось: на macOS и Linux это отказ механизма.
      expect(caller.dropped).not.toBeNull();
      expect(caller.dropped).toContain(injected);
      expect(caller.env[injected]).toBeUndefined();
      // Унаследованное — на месте и с тем же значением.
      expect(caller.env.PATH).toBe(process.env.PATH);
      expect(caller.env.HOME).toBe(process.env.HOME);
    } finally {
      delete process.env[injected];
    }
  });

  test("запуск с --no-env-file: подмеса не было — окружение как есть", async () => {
    const caller = await callerEnv({ execArgv: ["--no-env-file"], cwd: withDotenv });
    expect(caller.dotenv).toEqual([]);
    expect(caller.dropped).toEqual([]);
    expect(caller.env).toBe(process.env);
  });

  test("в каталоге запуска нет .env-файлов — окружение как есть", async () => {
    const caller = await callerEnv({ execArgv: [], cwd: withoutDotenv });
    expect(caller.dotenv).toEqual([]);
    expect(caller.env).toBe(process.env);
  });
});

describe("`bun main.ts run` в каталоге с .env", () => {
  async function run(bunFlags: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    const script = `printf '%s|%s|%s' "\${${PROBE}:-nothing}" "\${MYC_SHARED_PROBE:-nothing}" "\${MYC_CALLER_PROBE:-nothing}"`;
    const proc = Bun.spawn([process.execPath, ...bunFlags, MAIN, "run", "--", "sh", "-c", script], {
      cwd: withDotenv,
      env: cliTestEnv({ MYC_HOME: home, MYC_CALLER_PROBE: "from-caller", MYC_SHARED_PROBE: "from-caller" }),
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

  test("без --no-env-file: команда получает окружение вызывающего, WARN называет подмешанное", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("nothing|from-caller|from-caller");
    expect(r.err).toContain("WARN run.dotenv");
    expect(r.err).toContain(PROBE);
    // .env не переназначил и очередь: MYC_HEAVY_SLOTS из него не прочитан.
    expect(r.err).not.toContain("run.slots_invalid");
  });

  test("с --no-env-file: подмеса нет, предупреждения нет", async () => {
    const r = await run(["--no-env-file"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("nothing|from-caller|from-caller");
    expect(r.err).not.toContain("WARN");
  });
});
