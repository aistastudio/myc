/**
 * Хук очереди НАСТОЯЩИМИ процессами — так, как его зовёт Claude Code
 * (правило manual:multiprocess): команда из `.claude/settings.json`,
 * записанного настоящим `myc wire --queue-hook`, исполняется shell'ом хоста
 * (`$SHELL -c`, в 2.1.267 это bash/zsh/sh пользователя), на stdin — одна
 * строка JSON и перевод строки, как пишет хост.
 *
 *   (a) тяжёлая / лёгкая / уже обёрнутая / вложенная (MYC_RUN_HELD) / фоновая
 *       команда — в каждом доступном shell;
 *   (b) переписанная команда, исполненная shell'ом, действительно проходит
 *       через `myc run`: `bun test` внутри видит MYC_RUN_HELD=heavy, а
 *       очередь в MYC_HOME заведена; сам хук при этом базы не касается;
 *   (c) хук, запущенный ВНУТРИ настоящего `myc run` (вложенный запуск), ничего
 *       не переписывает;
 *   (d) структура цены: лёгкая команда не запускает ни bun, ни node —
 *       предфильтр на shell отвечает сам; замер p50/p99 против хука без
 *       предфильтра и бюджет prime-хука 30 мс p99.
 *
 * Мутации (проверены на приёмке): «точечный bun test тяжёлый» роняет (a) на
 * `bun test path/file.test.ts`; «двойное оборачивание» — (a) на уже
 * обёрнутой; «предфильтр снят» (case пропускает всё) — (d), и структурный, и
 * относительный.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliTestEnv } from "@myc/core";
import { expectAheadOfRival, expectWithinBudget, measureAsync, report } from "@myc/bench";
import { queueDbPath } from "../run-queue.ts";
import { QUEUE_HELPER_REL } from "./queue-hook.ts";

const BUN = process.execPath;
const MAIN = join(import.meta.dir, "..", "main.ts");
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"].filter((s) => existsSync(s));
const HOST_SHELL = process.env.SHELL !== undefined && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh";

let root: string;
let dir: string;
let home: string;
let wrapper: string;
let hookCommand: string;

/**
 * Окружение хоста: PATH с bun, проект, изолированная очередь и СВОЙ каталог
 * настроек Claude Code: хук читает правила пользователя, и настоящий
 * ~/.claude/settings.json (на этой машине там `Bash` целиком) решал бы за тест.
 */
function hostEnv(extra: Record<string, string> = {}): Record<string, string> {
  return cliTestEnv({
    PATH: `${dirname(BUN)}:/usr/bin:/bin`,
    CLAUDE_PROJECT_DIR: dir,
    CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    MYC_HOME: home,
    MYC_ACTOR: "tester",
    ...extra,
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "myc-queue-hook-mp-"));
  dir = join(root, "proj");
  home = join(root, "home");
  mkdirSync(join(dir, ".myc"), { recursive: true });
  mkdirSync(home, { recursive: true });
  // myc этого дерева исходников — им хук и будет оборачивать.
  wrapper = join(root, "bin", "myc");
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, `#!/bin/sh\nexec "${BUN}" "${MAIN}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  // Настоящий wire отдельным процессом: он же проверяет `<myc> run --help`.
  const wired = Bun.spawnSync([BUN, MAIN, "-C", dir, "wire", "--agents", "claude", "--queue-hook"], {
    cwd: dir,
    env: hostEnv({ MYC_BIN: wrapper }),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (wired.exitCode !== 0) throw new Error(`wire failed: ${wired.stderr.toString()}`);
  const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  hookCommand = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Вход хука, как его пишет хост: JSON.stringify одной строкой и "\n". */
function payload(toolInput: Record<string, unknown>): string {
  return `${JSON.stringify({
    session_id: "0b5c2e9a-1111-2222-3333-444455556666",
    transcript_path: join(root, "transcript.jsonl"),
    cwd: dir,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: toolInput,
    tool_use_id: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
  })}\n`;
}

interface HookRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runHook(shell: string, command: string, input: string, env = hostEnv()): Promise<HookRun> {
  const p = Bun.spawn([shell, "-c", command], { cwd: dir, env, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

function rewritten(out: HookRun): string | null {
  if (out.stdout.trim() === "") return null;
  const parsed = JSON.parse(out.stdout) as { hookSpecificOutput?: { updatedInput?: { command?: string } } };
  return parsed.hookSpecificOutput?.updatedInput?.command ?? null;
}

describe("(a) хук как его зовёт хост", () => {
  test("команда записи — та, что указывает на helper очереди и проверенный myc", () => {
    expect(hookCommand).toContain(QUEUE_HELPER_REL);
    expect(hookCommand.endsWith(` ${wrapper}`)).toBe(true);
  });

  for (const shell of SHELLS) {
    describe(shell, () => {
      test("тяжёлая: bun test → <myc> run -- bun test, остальной ввод цел", async () => {
        const out = await runHook(shell, hookCommand, payload({ command: "bun test", timeout: 600000, description: "Run all tests" }));
        expect(out.code).toBe(0);
        const parsed = JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, unknown> };
        expect(parsed.hookSpecificOutput).toEqual({
          hookEventName: "PreToolUse",
          updatedInput: { command: `${wrapper} run -- bun test`, timeout: 600000, description: "Run all tests" },
        });
      });

      test("тяжёлая в цепочке: встаёт перед своей командой, cd и хвост на месте", async () => {
        const out = await runHook(shell, hookCommand, payload({ command: "cd packages/cli && make -j8 2>&1 | tail -20" }));
        expect(rewritten(out)).toBe(`cd packages/cli && ${wrapper} run -- make -j8 2>&1 | tail -20`);
      });

      test.each([
        ["лёгкая", "ls -la"],
        ["лёгкая со словом из предфильтра", "git diff packages/cli/src/commands/wire.test.ts"],
        ["точечный прогон", "bun test packages/cli/src/hooks/queue-hook.test.ts"],
        ["уже обёрнутая", "myc run -- bun test"],
        ["уже обёрнутая путём", `${wrapper} run -- cargo build`],
      ])("%s: пустой вывод, код 0", async (_what, command) => {
        const out = await runHook(shell, hookCommand, payload({ command, description: "Run the test suite" }));
        expect([out.code, out.stdout, out.stderr]).toEqual([0, "", ""]);
      });

      test("вложенная: MYC_RUN_HELD=heavy в окружении хоста — не трогается", async () => {
        const out = await runHook(shell, hookCommand, payload({ command: "bun test" }), hostEnv({ MYC_RUN_HELD: "heavy" }));
        expect([out.code, out.stdout]).toEqual([0, ""]);
      });

      test("фоновая: run_in_background — не трогается", async () => {
        const out = await runHook(shell, hookCommand, payload({ command: "bun test", run_in_background: true }));
        expect([out.code, out.stdout]).toEqual([0, ""]);
      });
    });
  }

  test("хук сам в базу не ходит: после тяжёлой команды очереди в MYC_HOME ещё нет", async () => {
    const fresh = join(root, "home-untouched");
    mkdirSync(fresh, { recursive: true });
    const out = await runHook(HOST_SHELL, hookCommand, payload({ command: "bun test" }), hostEnv({ MYC_HOME: fresh }));
    expect(rewritten(out)).not.toBeNull();
    expect(existsSync(queueDbPath(fresh))).toBe(false);
  });
});

describe("(b, c) переписанная команда действительно идёт через myc run", () => {
  test(
    "bun test внутри видит MYC_RUN_HELD=heavy, очередь заведена",
    async () => {
      const marker = join(root, "held.txt");
      writeFileSync(
        join(dir, "probe.test.ts"),
        `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\n` +
          `test("probe", () => { writeFileSync(${JSON.stringify(marker)}, process.env.MYC_RUN_HELD ?? "none"); });\n`,
      );
      const out = await runHook(HOST_SHELL, hookCommand, payload({ command: "bun test" }));
      const command = rewritten(out)!;
      expect(command).toBe(`${wrapper} run -- bun test`);

      const ran = Bun.spawnSync(["/bin/sh", "-c", command], { cwd: dir, env: hostEnv(), stdout: "pipe", stderr: "pipe" });
      expect([ran.exitCode, ran.stderr.toString().includes("1 pass")]).toEqual([0, true]);
      expect(readFileSync(marker, "utf8")).toBe("heavy");
      expect(existsSync(queueDbPath(home))).toBe(true);
    },
    60_000,
  );

  test(
    "хук внутри настоящего myc run (вложенный запуск) ничего не переписывает",
    async () => {
      const input = join(root, "payload.json");
      writeFileSync(input, payload({ command: "bun test" }));
      const nested = Bun.spawnSync([wrapper, "run", "--", HOST_SHELL, "-c", hookCommand], {
        cwd: dir,
        env: hostEnv(),
        stdin: Bun.file(input),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect([nested.exitCode, nested.stdout.toString()]).toEqual([0, ""]);
      // Контроль: тот же вход без предка переписывается.
      expect(rewritten(await runHook(HOST_SHELL, hookCommand, readFileSync(input, "utf8")))).not.toBeNull();
    },
    60_000,
  );
});

/**
 * (e) Права — настоящим хуком. Правила пользователя лежат там, где их читает
 * Claude Code (свой CLAUDE_CONFIG_DIR на каждый случай), проектные — те, что
 * записал настоящий wire в beforeAll.
 */
describe("(e) права: без вопроса — только то, что прошло бы и без myc", () => {
  let seq = 0;
  function userRules(perms: Record<string, string[]>): Record<string, string> {
    const cfg = join(root, `cfg-${++seq}`);
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ permissions: perms }));
    return hostEnv({ CLAUDE_CONFIG_DIR: cfg });
  }
  function decision(out: HookRun): { decision?: string; reason?: string; command?: string } {
    if (out.stdout.trim() === "") return {};
    const h = (JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, any> }).hookSpecificOutput;
    return { decision: h["permissionDecision"], reason: h["permissionDecisionReason"], command: h["updatedInput"]?.["command"] };
  }

  test("переписанный bun test при правиле Bash(bun test:*) — allow", async () => {
    const out = await runHook(HOST_SHELL, hookCommand, payload({ command: "bun test" }), userRules({ allow: ["Bash(bun test:*)"] }));
    expect(decision(out)).toMatchObject({ decision: "allow", command: `${wrapper} run -- bun test` });
  });

  test("переписанная тяжёлая без правила — без решения: вопрос задаст Claude Code, исходная команда в нём видна", async () => {
    const out = await runHook(HOST_SHELL, hookCommand, payload({ command: "make -j8" }), userRules({}));
    const d = decision(out);
    expect(d.decision).toBeUndefined();
    expect(d.command).toBe(`${wrapper} run -- make -j8`);
  });

  test("агент сам вызывает myc run -- rm -rf <tmp>: не одобрено; при широком правиле — вопрос с этой командой", async () => {
    const victim = join(root, "victim");
    const typed = payload({ command: `myc run -- rm -rf ${victim}` });
    expect(decision(await runHook(HOST_SHELL, hookCommand, typed, userRules({})))).toEqual({});
    const broad = decision(await runHook(HOST_SHELL, hookCommand, typed, userRules({ allow: ["Bash(myc:*)"] })));
    expect(broad.decision).toBe("ask");
    expect(broad.reason).toContain(`'rm -rf ${victim}'`);
    const denied = decision(await runHook(HOST_SHELL, hookCommand, typed, userRules({ deny: ["Bash(rm:*)"] })));
    expect(denied.decision).toBe("deny");
  });
});

describe("(d) цена: лёгкая команда не запускает JS", () => {
  /**
   * Структура, от машины не зависящая: вместо bun и node в PATH — заглушки,
   * которые только отмечаются в файле. Лёгкая команда не должна оставить ни
   * одной отметки: её отпускает предфильтр на shell хоста.
   */
  test("лёгкая — ни bun, ни node; со словом предфильтра — helper запущен; с MYC_QUEUE_HEAVY — всегда", async () => {
    const stubs = join(root, "stubs");
    const log = join(root, "runtime.log");
    mkdirSync(stubs, { recursive: true });
    for (const name of ["bun", "node"]) {
      writeFileSync(join(stubs, name), `#!/bin/sh\ncat >/dev/null\necho ${name} >> "${log}"\n`);
      chmodSync(join(stubs, name), 0o755);
    }
    const env = (extra: Record<string, string> = {}): Record<string, string> =>
      hostEnv({ PATH: `${stubs}:/usr/bin:/bin`, ...extra });
    const starts = (): number => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);

    for (const command of ["ls -la", "git status", "cat README.md | head -5"]) {
      await runHook(HOST_SHELL, hookCommand, payload({ command, description: "Run the test suite" }), env());
    }
    expect(starts()).toBe(0);
    await runHook(HOST_SHELL, hookCommand, payload({ command: "bun test" }), env());
    expect(starts()).toBe(1);
    await runHook(HOST_SHELL, hookCommand, payload({ command: "ls -la" }), env({ MYC_QUEUE_HEAVY: "+just ci" }));
    expect(starts()).toBe(2);
  });

  test(
    "замер: лёгкая против хука без предфильтра; бюджет prime-хука 30 мс p99",
    async () => {
      // Соперник — тот же хук, у которого предфильтр пропускает всё: JS на каждом вызове.
      const rivalCommand = hookCommand.replace(/case \$\{c%%'","'\*\} in [^)]*\)/, "case x in *)");
      expect(rivalCommand).not.toBe(hookCommand);
      const light = payload({ command: "ls -la", description: "List files" });
      const heavy = payload({ command: "bun test" });
      const once = async (command: string, input: string): Promise<void> => {
        await runHook(HOST_SHELL, command, input);
      };

      const m = await measureAsync(`queue hook, light command (${HOST_SHELL})`, () => once(hookCommand, light), {
        warmup: 5,
        // 100 — см. ниже про p99 и nearest-rank: комментарий это обещал, а
        // стояло 60, то есть p99 лёгкой команды оставался максимумом прогона.
        iters: 100,
        budgetMs: 30,
        rival: () => once(rivalCommand, light),
        rivalLabel: "the same hook with no prefilter (bun/node on every call)",
      });
      report(m);
      // p99 — это 99-й процент, а не максимум: при 40 замерах на прогон он и
      // был максимумом, то есть одним соседом по процессору. На загруженном
      // ноутбуке (load1 4.9, 2026-09-11) при p50 21 мс одинокий выброс в двух
      // прогонах из трёх дважды ронял полный набор, хотя хук не менялся.
      // 100 замеров на прогон: p99 переживает один выброс в каждом прогоне,
      // медиана трёх прогонов — выбросы в одном из них.
      //
      // Относительного утверждения здесь нет, и это проверено: тяжёлый путь —
      // старт рантайма ПЛЮС чтение правил пользователя, то есть добавка, а не
      // множитель. Против голого старта того же рантайма отношение вышло ×1.35
      // на macOS (bun 15 мс) и ×2.52 на раннере CI (bun 5 мс) при одном и том
      // же коде — отношение мерило платформу, а не хук. Абсолют, как везде,
      // выключается на неоткалиброванном железе (MYC_BENCH_ABSOLUTE=0).
      const h = await measureAsync(`queue hook, heavy command (${HOST_SHELL})`, () => once(hookCommand, heavy), {
        warmup: 3,
        iters: 100,
        budgetMs: 30,
      });
      report(h);
      expectAheadOfRival(m, 2);
      expectWithinBudget(m);
      expectWithinBudget(h);
    },
    120_000,
  );
});
