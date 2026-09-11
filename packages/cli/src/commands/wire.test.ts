/**
 * `myc wire` / `myc unwire` (§6.4–6.7, решение D10).
 *
 * Проверяется одно свойство, и оно не про функциональность: чужие файлы не
 * должны пострадать ни при каких условиях. Один испорченный `CLAUDE.md` —
 * и инструмент удаляют вместе с памятью, которую он успел набрать.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAbsorbSessionCommand } from "../hooks/absorb-session.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createPrimeCommand } from "./prime.ts";
import { createUnwireCommand, createWireCommand, readWireJournal, resolveMycBin, type WireDeps } from "./wire.ts";
import { isOurStatusLineCommand } from "../statusline-config.ts";

let dir: string;
let registry: Registry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-wire-"));
  mkdirSync(join(dir, ".myc"), { recursive: true });
  registry = new Registry();
  registry.register(createPrimeCommand());
  registry.register(createAbsorbSessionCommand());
  registry.register(createWireCommand(registry));
  registry.register(createUnwireCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

function write(rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function read(rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

function has(rel: string): boolean {
  return existsSync(join(dir, rel));
}

const FOREIGN_SETTINGS = `{
    "statusLine": {"type": "command", "command": "my-own-statusline"},
    "hooks": {
        "SessionStart": [
            {"hooks": [{"type": "command", "command": "other-tool session-start"}]}
        ]
    }
}
`;

/**
 * Codex: проектный слой хуков. Что именно читает codex, установлено чтением
 * бинаря 0.153.4 и живым прогоном `codex exec` (подробности — в шапке про
 * Codex в hooks/templates.ts). Здесь проверяется только то, что myc пишет
 * ровно эту форму и не портит чужое.
 */
describe("Codex: хуки в .codex/hooks.json", () => {
  const FOREIGN_CODEX = JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "bd codex-hook SessionStart" }] }],
      },
    },
    null,
    2,
  );

  function codexHooks(): Record<string, any> {
    return JSON.parse(read(".codex/hooks.json")) as Record<string, any>;
  }

  /**
   * ЕДИНИЦА ТАЙМАУТА — СЕКУНДЫ У ОБОИХ ХОСТОВ. У Codex это `hook.timeout_sec`,
   * у Claude Code 2.1.267 — «Timeout in seconds for this specific command»
   * (прочитано в бинаре). Прежде этот тест утверждал «у Claude Code —
   * миллисекунды» и закреплял ошибку: 3000 у session-start значило 50 минут.
   * Мутация «взять timeoutMs как есть» роняет этот тест; миграция старых
   * записей — в wire.permissions.test.ts.
   */
  test("таймаут в записи и Codex, и Claude Code — секунды", async () => {
    await myc("wire", "--agents", "claude,codex");
    const codex = codexHooks()["hooks"];
    expect(codex["SessionStart"][0].hooks[0].timeout).toBe(3);
    expect(codex["PreCompact"][0].hooks[0].timeout).toBe(8);
    const claude = (JSON.parse(read(".claude/settings.json")) as Record<string, any>)["hooks"];
    expect(claude["SessionStart"][0].hooks[0].timeout).toBe(3);
  });

  test("команда относительная и защищена проверкой существования helper'а", async () => {
    await myc("wire", "--agents", "codex");
    const cmd = codexHooks()["hooks"]["SessionStart"][0].hooks[0].command as string;
    // Абсолютный путь одного репозитория в конфиге, который человек может
    // унести в другой проект, срабатывал бы в чужой сессии.
    expect(cmd).not.toContain(dir);
    expect(cmd).toContain(".codex/myc-hooks.mjs");
    expect(cmd).toContain("[ -f .codex/myc-hooks.mjs ]");
  });

  test("чужой хук на том же событии — конфликт, и НИЧЕГО не записано", async () => {
    write(".codex/hooks.json", FOREIGN_CODEX);
    const r = await myc("wire", "--agents", "codex");
    expect(r.code).not.toBe(0);
    expect(String(r.stderr)).toContain("bd codex-hook SessionStart");
    expect(codexHooks()).toEqual(JSON.parse(FOREIGN_CODEX));
    expect(has(".codex/myc-hooks.mjs")).toBe(false); // ни одного файла плана
  });

  test("--hook-mode append оставляет чужой хук на месте", async () => {
    write(".codex/hooks.json", FOREIGN_CODEX);
    expect((await myc("wire", "--agents", "codex", "--hook-mode", "append")).code).toBe(0);
    const start = codexHooks()["hooks"]["SessionStart"] as any[];
    expect(start.length).toBe(2);
    expect(JSON.stringify(start)).toContain("bd codex-hook SessionStart");
    expect(JSON.stringify(start)).toContain("myc-hooks.mjs");
  });

  test("unwire снимает наш узел и helper, чужой оставляет", async () => {
    write(".codex/hooks.json", FOREIGN_CODEX);
    await myc("wire", "--agents", "codex", "--hook-mode", "append");
    expect((await myc("unwire")).code).toBe(0);
    expect(has(".codex/myc-hooks.mjs")).toBe(false);
    const start = codexHooks()["hooks"]["SessionStart"] as any[];
    expect(start.length).toBe(1);
    expect(JSON.stringify(start)).toContain("bd codex-hook SessionStart");
  });

  test("повторный wire ничего не меняет", async () => {
    await myc("wire", "--agents", "codex");
    const before = [read(".codex/hooks.json"), read(".codex/myc-hooks.mjs")];
    await myc("wire", "--agents", "codex");
    expect([read(".codex/hooks.json"), read(".codex/myc-hooks.mjs")]).toEqual(before);
  });

  /**
   * Доверие — единственное, чего myc сделать не может, и молчать об этом
   * нельзя: без него хук СТОИТ и НЕ ЗАПУСКАЕТСЯ, причём codex об этом в
   * неинтерактивном режиме не говорит ни слова (проверено живьём).
   */
  test("wire говорит вслух, что хук ждёт согласия человека", async () => {
    const r = await myc("wire", "--agents", "codex", "--json");
    const notes = ((JSON.parse(r.stdout as string).data as Record<string, unknown>)["notes"] as string[]).join(" ");
    expect(notes).toContain("trust_level");
    expect(notes).toContain("hooks are new or changed");
  });
});

describe("resolveMycBin — команда для .mcp.json", () => {
  const NONE = { PATH: "", HOME: "" } as NodeJS.ProcessEnv;

  test("сборка в репозитории побеждает глобальную из PATH", () => {
    // Порядок неслучаен: если хук возьмёт dist, а MCP — глобальный myc, в одной
    // сессии окажутся две разные версии, молча и с расходящимся поведением.
    const r = resolveMycBin("/repo", { PATH: "/usr/bin", HOME: "/home/u" }, (p) =>
      p === "/repo/dist/myc" || p === "/usr/bin/myc",
    );
    expect(r).toEqual({ command: "./dist/myc", source: "repo" });
  });

  test("найденное в репозитории пишется относительным путём, без домашнего", () => {
    const r = resolveMycBin("/home/u/src/memory", NONE, (p) => p === "/home/u/src/memory/dist/myc");
    expect(r.command.startsWith("./")).toBe(true);
    expect(r.command).not.toContain("/home/u");
  });

  test("MYC_BIN важнее всего остального", () => {
    const r = resolveMycBin("/repo", { MYC_BIN: "/opt/myc", PATH: "/usr/bin", HOME: "/h" }, (p) =>
      p === "/opt/myc" || p === "/repo/dist/myc" || p === "/usr/bin/myc",
    );
    expect(r).toEqual({ command: "/opt/myc", source: "env" });
  });

  test("MYC_BIN, указывающий в никуда, пропускается, а не ломает выбор", () => {
    const r = resolveMycBin("/repo", { MYC_BIN: "/нет/такого", PATH: "/usr/bin", HOME: "" }, (p) =>
      p === "/usr/bin/myc",
    );
    expect(r).toEqual({ command: "myc", source: "path" });
  });

  /**
   * Windows: разделитель PATH — `;`, домашний каталог — USERPROFILE, а
   * исполняемый называется myc.exe/myc.cmd. Жёсткое `:` и голое `myc`
   * означали, что на Windows поиск не находил бинарь НИКОГДА, и `wire`
   * предупреждал `degraded.bin_unresolved` там, где myc стоит в PATH и
   * работает (сообщил агент, работавший на Windows).
   *
   * Проверяется через `exists`, потому что `delimiter` и расширения берутся
   * у платформы: на этой машине они POSIX-ные, и подделать их нельзя — зато
   * можно проверить, что путь с `;` не разбирается как один каталог, а
   * USERPROFILE участвует наравне с HOME.
   */
  test("Windows: USERPROFILE заменяет пустой HOME", () => {
    const r = resolveMycBin(
      "/repo", { PATH: "", HOME: "", USERPROFILE: "C:/Users/u" },
      (p) => p === "C:/Users/u/.myc/bin/myc", "win32",
    );
    expect(r).toEqual({ command: "C:/Users/u/.myc/bin/myc", source: "home" });
  });

  test("Windows: PATH делится по ';', а исполняемый — myc.exe", () => {
    const r = resolveMycBin(
      "C:/repo", { PATH: "C:/nope;C:/tools", HOME: "" },
      (p) => p === "C:/tools/myc.exe", "win32",
    );
    expect(r).toEqual({ command: "myc", source: "path" });
  });

  test("POSIX не начинает делить PATH по ';'", () => {
    // Обратная сторона: путь с точкой с запятой на POSIX — это ОДИН каталог
    // с таким именем, а не два. Без этой проверки правка «делить по обоим»
    // прошла бы молча.
    const r = resolveMycBin(
      "/repo", { PATH: "/a;/b", HOME: "" }, (p) => p === "/b/myc", "linux",
    );
    expect(r.source).toBe("none");
  });

  test("в PATH есть только myc — берём его как переносимый вариант", () => {
    const r = resolveMycBin("/repo", { PATH: "/nope:/usr/local/bin", HOME: "" }, (p) =>
      p === "/usr/local/bin/myc",
    );
    expect(r).toEqual({ command: "myc", source: "path" });
  });

  test("нигде нет — source=none, чтобы wire сказал об этом громко", () => {
    // Ровно этот случай и был багом: в .mcp.json уходило 'myc', MCP-сервер
    // не поднимался, и агент молча оставался без инструментов myc.
    const r = resolveMycBin("/repo", NONE, () => false);
    expect(r.source).toBe("none");
  });
});

describe("чистая установка", () => {
  test("пишет только свои файлы и журнал", async () => {
    const r = await myc("wire");
    expect(r.code).toBe(0);
    expect(has(".claude/helpers/myc-hooks.mjs")).toBe(true);
    expect(has(".claude/skills/myc/SKILL.md")).toBe(true);
    expect(has(".claude/settings.json")).toBe(true);
    // .codex/myc-notify.mjs больше НЕ пишется: в payload `notify` нет ни
    // стенограммы, ни события сжатия (см. CODEX_NO_EPISODE).
    expect(has(".codex/myc-notify.mjs")).toBe(false);
    expect(has(".opencode/plugin/myc.ts")).toBe(true);
    expect(has(".kimi-code/skills/myc/SKILL.md")).toBe(true);
    expect(has(".kimi-code/myc-hooks.mjs")).toBe(true);
    expect(has(".kimi-code/mcp.json")).toBe(true);
    expect(has(".myc/wire.json")).toBe(true);
    expect(has("CLAUDE.md")).toBe(false);
    expect(has("AGENTS.md")).toBe(false);
  });

  test("PreCompact стоит с таймаутом 8 с и матчером manual|auto", async () => {
    await myc("wire");
    const settings = JSON.parse(read(".claude/settings.json"));
    const pre = settings.hooks.PreCompact[0];
    expect(pre.matcher).toBe("manual|auto");
    expect(pre.hooks[0].timeout).toBe(8);
    expect(pre.hooks[0].command).toContain("myc-hooks.mjs\" pre-compact");
  });

  test("helper режет себя на 500 мс раньше хостового таймаута", async () => {
    await myc("wire");
    const helper = read(".claude/helpers/myc-hooks.mjs");
    expect(helper).toContain('"pre-compact": 7500');
    expect(helper).toContain("process.exit(0)");
  });

  test("хук на несуществующую команду не ставится и говорит об этом", async () => {
    const r = await myc("wire", "--json");
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    const codes = (env["warn"] as { code: string }[]).map((w) => w.code);
    expect(codes).toContain("degraded.hook_missing");
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.hooks.Stop).toBeUndefined();
  });

  test("--dry-run не пишет ничего", async () => {
    await myc("wire", "--dry-run");
    expect(has(".claude/helpers/myc-hooks.mjs")).toBe(false);
    expect(has(".myc/wire.json")).toBe(false);
  });

  test("повторный wire идемпотентен байт в байт", async () => {
    await myc("wire");
    const before = [
      read(".claude/settings.json"),
      read(".claude/helpers/myc-hooks.mjs"),
      read(".mcp.json"),
      read(".codex/config.toml"),
      read("opencode.json"),
      read(".kimi-code/mcp.json"),
      read(".kimi-code/myc-hooks.mjs"),
    ];
    const r = await myc("wire", "--json");
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect((env["data"] as Record<string, unknown>)["changed"]).toBe(0);
    expect([
      read(".claude/settings.json"),
      read(".claude/helpers/myc-hooks.mjs"),
      read(".mcp.json"),
      read(".codex/config.toml"),
      read("opencode.json"),
      read(".kimi-code/mcp.json"),
      read(".kimi-code/myc-hooks.mjs"),
    ]).toEqual(before);
  });

  // Плагин opencode и helper'ы — файлы, которые myc пишет ЦЕЛИКОМ (D10).
  // Проект, настроенный прошлой версией, обязан получить новую при повторном
  // `wire`: именно на устаревшем сгенерированном файле держалась дыра
  // memory-pqtyqnej23b7 — плагин звал absorb-session без стенограммы.
  test("повторный wire заменяет устаревший сгенерированный файл, а не оставляет его", async () => {
    await myc("wire");
    const fresh = {
      plugin: read(".opencode/plugin/myc.ts"),
      claude: read(".claude/helpers/myc-hooks.mjs"),
      kimi: read(".kimi-code/myc-hooks.mjs"),
    };
    const stale = "// старая версия\nexport const MycPlugin = async () => ({});\n";
    write(".opencode/plugin/myc.ts", stale);
    write(".claude/helpers/myc-hooks.mjs", "// старая версия\n");
    write(".kimi-code/myc-hooks.mjs", "// старая версия\n");

    const r = await myc("wire", "--json");
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect((env["data"] as Record<string, unknown>)["changed"]).toBe(3);
    expect(read(".opencode/plugin/myc.ts")).toBe(fresh.plugin);
    expect(read(".claude/helpers/myc-hooks.mjs")).toBe(fresh.claude);
    expect(read(".kimi-code/myc-hooks.mjs")).toBe(fresh.kimi);
    // Старое не выброшено молча: рядом лежит .myc.bak.
    expect(read(".opencode/plugin/myc.ts.myc.bak")).toBe(stale);
    // И новая версия действительно берёт стенограмму, а не зовёт absorb вслепую.
    expect(read(".opencode/plugin/myc.ts")).toContain("client.session.messages");
  });
});

describe("чужие файлы", () => {
  test("чужой хук на том же событии — конфликт, не записано НИЧЕГО", async () => {
    write(".claude/settings.json", FOREIGN_SETTINGS);
    const r = await myc("wire");
    expect(r.code).toBe(4); // CONFLICT
    expect(read(".claude/settings.json")).toBe(FOREIGN_SETTINGS);
    expect(has(".claude/helpers/myc-hooks.mjs")).toBe(false);
    expect(has(".codex/myc-notify.mjs")).toBe(false);
    expect(r.stderr).toContain("--hook-mode append");
  });

  test("--hook-mode append сохраняет чужой хук и чужой statusLine", async () => {
    write(".claude/settings.json", FOREIGN_SETTINGS);
    await myc("wire", "--hook-mode", "append");
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.statusLine.command).toBe("my-own-statusline");
    expect(settings.hooks.SessionStart.length).toBe(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("other-tool session-start");
    expect(has(".claude/settings.json.myc.bak")).toBe(true);
    expect(read(".claude/settings.json.myc.bak")).toBe(FOREIGN_SETTINGS);
  });

  test("--hook-mode skip не ставит хук на занятое событие", async () => {
    write(".claude/settings.json", FOREIGN_SETTINGS);
    await myc("wire", "--hook-mode", "skip");
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.hooks.SessionStart.length).toBe(1);
    expect(settings.hooks.PreCompact).toBeDefined(); // на PreCompact чужого не было
  });

  test("--hook-mode replace убирает чужой, но сначала кладёт .bak", async () => {
    write(".claude/settings.json", FOREIGN_SETTINGS);
    await myc("wire", "--hook-mode", "replace");
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.hooks.SessionStart.length).toBe(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("myc-hooks.mjs");
    expect(read(".claude/settings.json.myc.bak")).toBe(FOREIGN_SETTINGS);
  });

  /**
   * Конфиг заказчика (memory-vspyaxt3edvn): ДВА чужих обработчика на одном
   * событии и ещё два на другом, с матчерами. `replace` выключил все четыре и
   * назвал ноль — человек согласился на цену, которой не увидел.
   */
  const CUSTOMER_SETTINGS = `{
  "statusLine": {"type": "command", "command": "my-own-statusline"},
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "bd prime --hook-json"}]},
      {"hooks": [{"type": "command", "command": "graft session-start"}]}
    ],
    "PostToolUse": [
      {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "graft post-edit"}]},
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "graft tool-savings"}]}
    ]
  }
}
`;

  test("replace называет КАЖДЫЙ вытесненный обработчик: событие и команда", async () => {
    // PostToolUse ставится, только если `myc anchor` есть в сборке: без него
    // wire честно пропустит событие, и второй пары хуков заказчика не будет.
    registry.register(createAnchorCommand());
    write(".claude/settings.json", CUSTOMER_SETTINGS);
    const r = await myc("wire", "--agents", "claude", "--hook-mode", "replace");
    const out = r.stdout as string;

    // Ровно те четыре, что были у заказчика, — и команда, и событие каждого.
    for (const command of [
      "bd prime --hook-json",
      "graft session-start",
      "graft post-edit",
      "graft tool-savings",
    ]) {
      expect(out).toContain(command);
    }
    expect(out).toContain("SessionStart: bd prime --hook-json");
    expect(out).toContain("SessionStart: graft session-start");
    // Матчер — часть адреса: без него два хука PostToolUse не различить.
    expect(out).toContain("PostToolUse[Edit|Write]: graft post-edit");
    expect(out).toContain("PostToolUse[Bash]: graft tool-savings");

    // И цена названа целиком: сколько, куда сохранено, как вернуть.
    expect(out).toContain("4 foreign handlers");
    expect(out).toContain("cp .claude/settings.json.myc.bak .claude/settings.json");
  });

  test("обещание про .myc.bak исполнено: копия содержит все четыре чужих хука", async () => {
    write(".claude/settings.json", CUSTOMER_SETTINGS);
    await myc("wire", "--agents", "claude", "--hook-mode", "replace");
    const bak = read(".claude/settings.json.myc.bak");
    expect(bak).toBe(CUSTOMER_SETTINGS);
    // Строка «вернуть: cp …» — не украшение: после неё конфиг снова рабочий.
    write(".claude/settings.json", bak);
    const restored = JSON.parse(read(".claude/settings.json"));
    expect(restored.hooks.SessionStart.length).toBe(2);
    expect(restored.hooks.PostToolUse.length).toBe(2);
  });

  test("вытесненное доезжает и до конверта --json, не только до человека", async () => {
    registry.register(createAnchorCommand());
    write(".claude/settings.json", CUSTOMER_SETTINGS);
    const r = await myc("wire", "--agents", "claude", "--hook-mode", "replace", "--json");
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    const evicted = (env["data"] as Record<string, unknown>)["evicted"] as
      { event: string; matcher?: string; command: string }[];
    expect(evicted.map((e) => e.command)).toEqual([
      "bd prime --hook-json",
      "graft session-start",
      "graft post-edit",
      "graft tool-savings",
    ]);
    expect(evicted[2]!.matcher).toBe("Edit|Write");
  });

  test("одна запись с несколькими командами — вытеснены и названы ВСЕ", async () => {
    // Claude Code разрешает несколько обработчиков под одним matcher. Пока
    // отчёт брал из записи первую команду (`foreignCommand`), вторая исчезала
    // молча — ровно тот дефект, что и был, только на уровень глубже.
    write(
      ".claude/settings.json",
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: "bd prime --hook-json" },
                  { type: "command", command: "graft session-start" },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    const r = await myc("wire", "--agents", "claude", "--hook-mode", "replace");
    const out = r.stdout as string;
    expect(out).toContain("SessionStart: bd prime --hook-json");
    expect(out).toContain("SessionStart: graft session-start");
    expect(out).toContain("2 foreign handlers");
  });

  test("без replace вытеснять нечего: список пуст", async () => {
    write(".claude/settings.json", CUSTOMER_SETTINGS);
    const r = await myc("wire", "--agents", "claude", "--hook-mode", "append", "--json");
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect((env["data"] as Record<string, unknown>)["evicted"]).toEqual([]);
    expect(r.stdout as string).not.toContain("evicted by --hook-mode");
  });

  test("append переставляет наш хук в конец — и говорит об этом", async () => {
    // Наш хук стоял ПЕРВЫМ, чужой вторым. После append чужой запускается
    // раньше нашего: порядок чужого файла изменён, значит назван.
    write(
      ".claude/settings.json",
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs" session-start',
                    timeout: 5,
                  },
                ],
              },
              { hooks: [{ type: "command", command: "graft session-start" }] },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    const r = await myc("wire", "--agents", "claude", "--hook-mode", "append");
    const out = r.stdout as string;
    expect(out).toContain("myc's hook moved to the end of the array");
    expect(out).toContain("graft session-start");

    const after = JSON.parse(read(".claude/settings.json"));
    const order = after.hooks.SessionStart.map((e: { hooks: { command: string }[] }) => e.hooks[0]!.command);
    expect(order[0]).toBe("graft session-start");
    expect(order[1]).toContain("myc-hooks.mjs");
  });

  test("append без перестановки молчит о ней", async () => {
    // Чужой хук один и уже первый — append ничего не двигает, и заметки нет.
    write(".claude/settings.json", FOREIGN_SETTINGS);
    const r = await myc("wire", "--agents", "claude", "--hook-mode", "append");
    expect(r.stdout as string).not.toContain("moved to the end");
  });

  test("нечитаемый JSON — конфликт, а не перезапись", async () => {
    write(".claude/settings.json", "{ /* комментарий */ \"hooks\": {} }");
    const r = await myc("wire");
    expect(r.code).toBe(4);
    expect(read(".claude/settings.json")).toContain("комментарий");
    expect(has(".claude/helpers/myc-hooks.mjs")).toBe(false);
  });

  test("CLAUDE.md не трогаем никогда", async () => {
    write("CLAUDE.md", "# мои правила\nне переписывай меня\n");
    await myc("wire", "--agents-md");
    expect(read("CLAUDE.md")).toBe("# мои правила\nне переписывай меня\n");
  });

  test("AGENTS.md без --agents-md не создаётся", async () => {
    await myc("wire");
    expect(has("AGENTS.md")).toBe(false);
  });

  test("AGENTS.md: только блок между маркерами, остальное байт в байт", async () => {
    const own = "# Мой AGENTS\n\nВот мои правила.\nОни важные.\n";
    write("AGENTS.md", own);
    await myc("wire", "--agents-md");
    const after = read("AGENTS.md");
    expect(after.startsWith(own.trimEnd())).toBe(true);
    expect(after).toContain("<!-- myc:start -->");
    await myc("wire", "--agents-md");
    expect(read("AGENTS.md")).toBe(after); // идемпотентно
  });

  test("чужой notify в config.toml не перетирается", async () => {
    write(".codex/config.toml", 'notify = ["node", "other.mjs"]\n\n[mcp_servers.other]\ncommand = "other"\n');
    const r = await myc("wire", "--agents", "codex", "--json");
    expect(r.code).toBe(0);
    const toml = read(".codex/config.toml");
    expect(toml).toContain('notify = ["node", "other.mjs"]');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain("[mcp_servers.myc]");
  });

  // Мутация: вернуть notify-блок в planCodex — и оба теста ниже падают.
  test("Codex: notify не ставится, хуки идут через .codex/hooks.json", async () => {
    const r = await myc("wire", "--agents", "codex", "--json");
    expect(r.code).toBe(0);
    expect(has(".codex/myc-notify.mjs")).toBe(false);
    const toml = read(".codex/config.toml");
    expect(toml).not.toContain("notify");
    expect(toml).toContain("[mcp_servers.myc]"); // MCP работает и остаётся
    // Рабочий путь на месте: helper в проекте и запись в проектном hooks.json.
    expect(has(".codex/myc-hooks.mjs")).toBe(true);
    const hooks = JSON.parse(read(".codex/hooks.json")) as Record<string, any>;
    expect(Object.keys(hooks["hooks"]).sort()).toEqual(["PreCompact", "SessionStart"]);
  });

  test("Codex: прежний наш notify снимается, а не остаётся тикать вхолостую", async () => {
    write(
      ".codex/config.toml",
      '# myc:notify:start\nnotify = ["node", ".codex/myc-notify.mjs"]\n# myc:notify:end\n\n[mcp_servers.other]\ncommand = "other"\n',
    );
    const r = await myc("wire", "--agents", "codex", "--json");
    expect(r.code).toBe(0);
    const toml = read(".codex/config.toml");
    expect(toml).not.toContain("myc-notify.mjs");
    expect(toml).not.toContain("myc:notify:start");
    expect(toml).toContain("[mcp_servers.other]");
  });

  test("свой [mcp_servers.myc] вне маркеров — конфликт", async () => {
    write(".codex/config.toml", '[mcp_servers.myc]\ncommand = "custom-myc"\n');
    const r = await myc("wire", "--agents", "codex");
    expect(r.code).toBe(4);
    expect(read(".codex/config.toml")).toContain("custom-myc");
  });

  test("чужие серверы в opencode.json и .mcp.json сохраняются", async () => {
    write("opencode.json", '{\n  "mcp": {\n    "other": {"type": "local"}\n  }\n}\n');
    write(".mcp.json", '{\n  "mcpServers": {\n    "graft": {"command": "graft"}\n  }\n}\n');
    await myc("wire");
    expect(JSON.parse(read("opencode.json")).mcp.other).toBeDefined();
    expect(JSON.parse(read(".mcp.json")).mcpServers.graft).toBeDefined();
    expect(JSON.parse(read(".mcp.json")).mcpServers.myc).toBeDefined();
  });
});

describe("unwire", () => {
  test("снимает ровно то, что поставил", async () => {
    write(".claude/settings.json", FOREIGN_SETTINGS);
    await myc("wire", "--hook-mode", "append");
    await myc("unwire");

    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.statusLine.command).toBe("my-own-statusline");
    expect(settings.hooks.SessionStart.length).toBe(1);
    expect(settings.hooks.PreCompact).toBeUndefined();
    expect(settings.permissions).toBeUndefined();
    expect(has(".claude/helpers/myc-hooks.mjs")).toBe(false);
    expect(has(".codex/myc-notify.mjs")).toBe(false);
    expect(has(".opencode/plugin/myc.ts")).toBe(false);
    expect(has(".kimi-code/myc-hooks.mjs")).toBe(false);
    expect(has(".kimi-code/skills/myc/SKILL.md")).toBe(false);
  });

  test("файл, изменённый после нас, не трогается", async () => {
    await myc("wire");
    write(".claude/helpers/myc-hooks.mjs", "// я это поправил руками\n");
    const r = await myc("unwire", "--json");
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    const kept = (env["data"] as Record<string, unknown>)["kept"] as { path: string }[];
    expect(kept.some((k) => k.path === ".claude/helpers/myc-hooks.mjs")).toBe(true);
    expect(read(".claude/helpers/myc-hooks.mjs")).toBe("// я это поправил руками\n");
  });

  test("без журнала — честный отказ, а не угадывание", async () => {
    const r = await myc("unwire");
    expect(r.code).toBe(3); // NOTFOUND
  });
});

/**
 * Kimi Code. Что он читает — установлено чтением его бинаря
 * (`~/.kimi-code/bin/kimi`), а не догадкой; здесь закреплены ровно те факты,
 * на которые опирается planKimi, чтобы правка «по памяти» их уронила.
 */
describe("kimi", () => {
  test("--agents kimi пишет только под .kimi-code и не трогает чужого", async () => {
    const r = await myc("wire", "--agents", "kimi");
    expect(r.code).toBe(0);
    expect(has(".kimi-code/skills/myc/SKILL.md")).toBe(true);
    expect(has(".kimi-code/myc-hooks.mjs")).toBe(true);
    expect(has(".kimi-code/mcp.json")).toBe(true);
    // Ни файла Claude Code, ни Codex, ни opencode: попросили одного.
    expect(has(".claude/settings.json")).toBe(false);
    expect(has(".mcp.json")).toBe(false);
    expect(has(".codex/config.toml")).toBe(false);
    expect(has("opencode.json")).toBe(false);
    expect(has("CLAUDE.md")).toBe(false);
    expect(has("AGENTS.md")).toBe(false);
  });

  test("MCP-запись в форме, которую Kimi разбирает без transport", async () => {
    await myc("wire", "--agents", "kimi");
    // McpServerConfigSchema выводит stdio по наличию command; лишний
    // transport здесь не нужен, а вот отсутствие command — молчаливый отказ.
    const mcp = JSON.parse(read(".kimi-code/mcp.json"));
    expect(typeof mcp.mcpServers.myc.command).toBe("string");
    expect(mcp.mcpServers.myc.args).toEqual(["mcp", "--profile", "agent"]);
  });

  test("скилл лежит там, где Kimi ищет проектные, и с обязательным фронтматтером", async () => {
    await myc("wire", "--agents", "kimi");
    // PROJECT_BRAND_DIRS = [".kimi-code/skills"]; у directory-скилла Kimi
    // ТРЕБУЕТ непустые name и description, иначе SkillParseError.
    const skill = read(".kimi-code/skills/myc/SKILL.md");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: myc");
    expect(skill).toContain("description:");
  });

  test("helper заворачивает вывод в {message}: обычный stdout Kimi выбрасывает", async () => {
    await myc("wire", "--agents", "kimi");
    const helper = read(".kimi-code/myc-hooks.mjs");
    expect(helper).toContain('JSON.stringify({ message: r.stdout })');
    // Форма hookSpecificOutput.additionalContext — это Claude Code; для Kimi
    // она пуста, поэтому absorb-session зовётся с текстовым выводом.
    expect(helper).toContain('"--hook-output", "text"');
    expect(helper).toContain('"--agent", "kimi"');
    expect(helper).toContain("process.exit(0)");
    // Кодом 2 Kimi блокирует ход агента — им не выходим никогда.
    expect(helper).not.toContain("process.exit(2)");
  });

  test("про пользовательский config.toml сказано вслух, а не поставлено втихую", async () => {
    const r = await myc("wire", "--agents", "kimi", "--json");
    const data = JSON.parse(r.stdout as string).data as {
      notes: string[];
      untouched: string[];
    };
    const note = data.notes.join("\n");
    expect(note).toContain("~/.kimi-code/config.toml");
    expect(note).toContain("[[hooks]]");
    // Таймаут у Kimi в СЕКУНДАХ (1..600) — как у Claude Code и Codex.
    expect(note).toContain("timeout = 8");
    expect(note).not.toContain("timeout = 8000");
    expect(data.untouched.join(" ")).toContain("~/.kimi-code/config.toml");
  });

  test("--dry-run печатает ровно то, что потом записывается", async () => {
    const dry = await myc("wire", "--dry-run", "--json");
    const planned = (JSON.parse(dry.stdout as string).data as {
      actions: { path: string; action: string }[];
    }).actions;
    expect(has(".kimi-code/mcp.json")).toBe(false);

    const real = await myc("wire", "--json");
    const written = (JSON.parse(real.stdout as string).data as {
      actions: { path: string; action: string }[];
    }).actions;
    expect(written).toEqual(planned);
    // И это не просто совпадение отчётов: каждый обещанный файл на диске.
    for (const a of planned) expect([a.path, has(a.path)]).toEqual([a.path, true]);
  });
});

/**
 * Строка статуса Claude Code — опция `--status-line` (без флага statusLine не
 * трогается, решение задачи memory-fbzbw5pexjs7). Прежняя действующая строка
 * — проектная, иначе пользовательская — продолжает получать тот же ввод, а
 * `unwire` возвращает файл побайтно. Пользовательские настройки здесь —
 * временный CLAUDE_CONFIG_DIR, настоящий ~/.claude не читается.
 */
describe("строка статуса: --status-line", () => {
  let cfg: string;

  function slRegistry(overrides: Partial<WireDeps> = {}): Registry {
    const r = new Registry();
    r.register(createPrimeCommand());
    r.register(createAbsorbSessionCommand());
    r.register(
      createWireCommand(r, {
        probeStatusLine: () => ({ ok: true }),
        env: { CLAUDE_CONFIG_DIR: cfg },
        platform: "darwin",
        ...overrides,
      }),
    );
    r.register(createUnwireCommand());
    return r;
  }

  function sl(r: Registry, ...args: string[]): Promise<RunResult> {
    return run(["-C", dir, ...args], { registry: r, env: { MYC_ACTOR: "tester" } });
  }

  function userLine(command: string, extra: Record<string, unknown> = {}): void {
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), `${JSON.stringify({ statusLine: { type: "command", command, ...extra } }, null, 2)}\n`);
  }

  function statusLine(): { type: string; command: string; padding?: number; refreshInterval?: number } {
    return (JSON.parse(read(".claude/settings.json")) as { statusLine: never }).statusLine;
  }

  const ORCA_CMD = '/bin/sh "${HOME}/.orca/agent-hooks/claude-statusline.sh"';
  /** Каноничный JSON: только на нём побайтный круг вообще определён. */
  const PROJECT_WITH_LINE = `${JSON.stringify({ statusLine: { type: "command", command: "my-own-statusline --x 'y'" } }, null, 2)}\n`;

  beforeEach(() => {
    cfg = join(dir, "claude-config");
  });

  test("без флага statusLine не трогается — и сказано, какой флаг его ставит", async () => {
    write(".claude/settings.json", PROJECT_WITH_LINE);
    userLine(ORCA_CMD);
    const r = await sl(slRegistry(), "wire", "--agents", "claude", "--json");
    expect(statusLine().command).toBe("my-own-statusline --x 'y'");
    const data = JSON.parse(r.stdout as string).data as { untouched: string[] };
    expect(data.untouched).toContain(".claude/settings.json:statusLine (needs --status-line)");
  });

  test("проектная чужая: дословно в журнал, её команда — в --then; unwire побайтно (S1, S5)", async () => {
    write(".claude/settings.json", PROJECT_WITH_LINE);
    userLine(ORCA_CMD); // есть и пользовательская — но действует проектная
    const r = slRegistry();
    expect((await sl(r, "wire", "--agents", "claude", "--status-line")).code).toBe(0);
    const ours = statusLine();
    expect(isOurStatusLineCommand(ours.command)).toBe(true);
    expect(ours.command.endsWith(` statusline --then 'my-own-statusline --x '\\''y'\\'''`)).toBe(true);
    const journal = readWireJournal(join(dir, ".myc", "wire.json"));
    expect(journal?.status_line).toEqual({
      path: ".claude/settings.json",
      previous: { type: "command", command: "my-own-statusline --x 'y'" },
      passthrough: "project",
    });
    expect((await sl(r, "unwire")).code).toBe(0);
    expect(read(".claude/settings.json")).toBe(PROJECT_WITH_LINE);
  });

  test("пользовательская (orca): наша без --then, ключа не было — после unwire его нет, байт в байт", async () => {
    const project = `${JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }, null, 2)}\n`;
    write(".claude/settings.json", project);
    userLine(ORCA_CMD);
    const userBefore = readFileSync(join(cfg, "settings.json"), "utf8");
    const r = slRegistry();
    const wired = await sl(r, "wire", "--agents", "claude", "--status-line");
    expect(wired.code).toBe(0);
    expect(statusLine().command).not.toContain("--then");
    expect(String(wired.stdout)).toContain("the user line");
    expect(readWireJournal(join(dir, ".myc", "wire.json"))?.status_line).toEqual({
      path: ".claude/settings.json",
      previous: null,
      passthrough: "user",
    });
    expect((await sl(r, "unwire")).code).toBe(0);
    expect(read(".claude/settings.json")).toBe(project);
    expect(readFileSync(join(cfg, "settings.json"), "utf8")).toBe(userBefore);
  });

  test("повторный wire --status-line не меняет ни байта", async () => {
    write(".claude/settings.json", PROJECT_WITH_LINE);
    const r = slRegistry();
    await sl(r, "wire", "--agents", "claude", "--status-line");
    const once = read(".claude/settings.json");
    const again = await sl(r, "wire", "--agents", "claude", "--status-line", "--json");
    expect(read(".claude/settings.json")).toBe(once);
    expect((JSON.parse(again.stdout as string).data as { changed: number }).changed).toBe(0);
    // И прежней не стала наша собственная строка.
    expect(readWireJournal(join(dir, ".myc", "wire.json"))?.status_line?.previous).toEqual({
      type: "command",
      command: "my-own-statusline --x 'y'",
    });
  });

  test("обычный wire после --status-line строку не трогает и запись о прежней не теряет (S5)", async () => {
    write(".claude/settings.json", PROJECT_WITH_LINE);
    const r = slRegistry();
    await sl(r, "wire", "--agents", "claude", "--status-line");
    const withLine = statusLine();
    await sl(r, "wire", "--agents", "claude");
    expect(statusLine()).toEqual(withLine);
    expect(readWireJournal(join(dir, ".myc", "wire.json"))?.status_line?.passthrough).toBe("project");
    await sl(r, "unwire");
    expect(read(".claude/settings.json")).toBe(PROJECT_WITH_LINE);
  });

  test("никогда сам за себя: пользовательская строка — это myc statusline", async () => {
    userLine("myc statusline");
    const wired = await sl(slRegistry(), "wire", "--agents", "claude", "--status-line");
    expect(wired.code).toBe(0);
    expect(statusLine().command).not.toContain("--then");
    expect(readWireJournal(join(dir, ".myc", "wire.json"))?.status_line?.passthrough).toBe("none");
  });

  test("раскладка и частота прежней строки переезжают в нашу", async () => {
    userLine(ORCA_CMD, { padding: 2, refreshInterval: 5 });
    await sl(slRegistry(), "wire", "--agents", "claude", "--status-line");
    expect(statusLine()).toMatchObject({ padding: 2, refreshInterval: 5 });
  });

  test("codex, opencode, kimi: строку не ставим — и говорим это, а не молчим", async () => {
    const r = await sl(slRegistry(), "wire", "--agents", "codex,opencode,kimi", "--status-line", "--json");
    expect(r.code).toBe(0);
    const notes = (JSON.parse(r.stdout as string).data as { notes: string[] }).notes.join("\n");
    expect(notes).toContain("Codex: status line not installed");
    expect(notes).toContain("opencode: status line not installed");
    expect(notes).toContain("Kimi: this version of wire does not install the status line");
    expect(notes).toContain("only for Claude Code");
    expect(has(".claude/settings.json")).toBe(false);
  });

  test("бинарь без команды statusline — отказ, не записано ничего", async () => {
    userLine(ORCA_CMD);
    const r = await sl(slRegistry({ probeStatusLine: () => ({ ok: false, why: "./dist/myc statusline --help: exit 2" }) }), "wire", "--agents", "claude", "--status-line");
    expect(r.code).toBe(5); // PRECOND
    expect(String(r.stderr)).toContain("statusline --help");
    expect(has(".claude/settings.json")).toBe(false);
    expect(has(".myc/wire.json")).toBe(false);
  });

  test("Windows поверх чужой строки — отказ: передачи там нет, отрезать чужую нельзя", async () => {
    userLine(ORCA_CMD);
    const r = await sl(slRegistry({ platform: "win32" }), "wire", "--agents", "claude", "--status-line");
    expect(r.code).toBe(4); // CONFLICT
    expect(String(r.stderr)).toContain("Windows");
    expect(has(".claude/settings.json")).toBe(false);
  });

  test("своя строка в settings.local.json — сказано, что проектную Claude Code не покажет", async () => {
    write(".claude/settings.local.json", `${JSON.stringify({ statusLine: { type: "command", command: "local-line" } })}\n`);
    const r = await sl(slRegistry(), "wire", "--agents", "claude", "--status-line");
    expect(String(r.stdout)).toContain("settings.local.json: has its own statusLine");
    expect(JSON.parse(read(".claude/settings.local.json")).statusLine.command).toBe("local-line");
  });
});

/**
 * Журнал — слияние, а не перезапись (memory-e272e38n0e3v). До правки частичный
 * `wire --agents opencode` оставлял в журнале только opencode, и `unwire`
 * молча бросал хуки Claude на месте — координатор наступил на это вживую.
 */
describe("журнал wire: частичный прогон сливается, а не перезаписывает", () => {
  const journal = () => readWireJournal(join(dir, ".myc", "wire.json"))!;

  test("wire claude → wire opencode → unwire снимает оба", async () => {
    expect((await myc("wire", "--agents", "claude")).code).toBe(0);
    expect((await myc("wire", "--agents", "opencode")).code).toBe(0);
    const j = journal();
    expect(j.agents).toEqual(["claude", "opencode"]);
    const paths = j.entries.map((e) => e.path);
    expect(paths).toContain(".claude/helpers/myc-hooks.mjs");
    expect(paths).toContain(".claude/settings.json");
    expect(paths).toContain(".opencode/plugin/myc.ts");

    expect((await myc("unwire")).code).toBe(0);
    expect(has(".claude/helpers/myc-hooks.mjs")).toBe(false);
    expect(has(".claude/skills/myc/SKILL.md")).toBe(false);
    expect(has(".opencode/plugin/myc.ts")).toBe(false);
    // Их создал wire, и ничего чужого в них нет — файлов не было, нет и теперь.
    expect(has(".claude/settings.json")).toBe(false);
    expect(has(".mcp.json")).toBe(false);
    expect(has("opencode.json")).toBe(false);
    expect(has(".myc/wire.json")).toBe(false);
  });

  test("отчёт wire называет, сколько записей прежних прогонов сохранено", async () => {
    await myc("wire", "--agents", "claude");
    const r = await myc("wire", "--agents", "opencode", "--json");
    const kept = (JSON.parse(r.stdout as string).data as { journal_kept: number }).journal_kept;
    expect(kept).toBe(journal().entries.filter((e) => !e.path.startsWith(".opencode") && e.path !== "opencode.json").length);
    expect(kept).toBeGreaterThan(0);
  });

  test("запись о прежней строке статуса переживает wire другого агента", async () => {
    const original = `${JSON.stringify({ statusLine: { type: "command", command: "my-own-statusline" } }, null, 2)}\n`;
    write(".claude/settings.json", original);
    const r = new Registry();
    r.register(createPrimeCommand());
    r.register(createAbsorbSessionCommand());
    r.register(createWireCommand(r, { probeStatusLine: () => ({ ok: true }), env: { CLAUDE_CONFIG_DIR: join(dir, "cfg") }, platform: "darwin" }));
    r.register(createUnwireCommand());
    const sl = (...args: string[]): Promise<RunResult> => run(["-C", dir, ...args], { registry: r, env: { MYC_ACTOR: "tester" } });
    await sl("wire", "--agents", "claude", "--status-line");
    await sl("wire", "--agents", "opencode");
    expect(journal().status_line?.passthrough).toBe("project");
    await sl("unwire");
    expect(read(".claude/settings.json")).toBe(original);
  });

  test("разный --hook-output у прогонов — журнал не выдумывает один на всех", async () => {
    await myc("wire", "--agents", "claude");
    await myc("wire", "--agents", "opencode", "--hook-output", "text");
    expect(journal().hook_output).toBeUndefined();
    await myc("wire", "--hook-output", "text");
    expect(journal().hook_output).toBe("text");
  });

  test("файл, удалённый руками, не держит журнал: остальное снято, журнал убран", async () => {
    await myc("wire", "--agents", "claude");
    rmSync(join(dir, ".claude", "skills", "myc", "SKILL.md"));
    const r = await myc("unwire", "--json");
    const data = JSON.parse(r.stdout as string).data as { gone: string[]; kept: unknown[] };
    expect(data.gone).toEqual([".claude/skills/myc/SKILL.md"]);
    expect(data.kept).toEqual([]);
    expect(has(".claude/helpers/myc-hooks.mjs")).toBe(false);
    expect(has(".myc/wire.json")).toBe(false);
  });
});

/**
 * «Ключ был — ключ остаётся»: пустые контейнеры человека (`"hooks": {}`,
 * `"allow": []`) переживают круг wire+unwire, в том числе через повторный
 * wire, у которого наш же `hooks` уже в файле.
 */
describe("unwire не удаляет контейнеры, бывшие до wire", () => {
  test.each([
    [`${JSON.stringify({ hooks: {} }, null, 2)}\n`],
    [`${JSON.stringify({ hooks: { SessionStart: [] }, permissions: { allow: [] }, env: { A: "1" } }, null, 2)}\n`],
  ])("побайтовый круг: %s", async (original) => {
    write(".claude/settings.json", original);
    expect((await myc("wire", "--agents", "claude")).code).toBe(0);
    expect((await myc("wire", "--agents", "claude")).code).toBe(0); // повторный — тот же итог
    expect(JSON.parse(read(".claude/settings.json")).hooks.PreCompact).toBeDefined();
    expect((await myc("unwire")).code).toBe(0);
    expect(read(".claude/settings.json")).toBe(original);
  });

  test("созданное нами — снимается целиком, как раньше", async () => {
    const original = `${JSON.stringify({ env: { A: "1" } }, null, 2)}\n`;
    write(".claude/settings.json", original);
    await myc("wire", "--agents", "claude");
    await myc("unwire");
    expect(read(".claude/settings.json")).toBe(original);
  });
});

/**
 * «Файла не было — файла нет». Координатор на чистом репозитории: wire claude
 * --status-line + wire opencode + unwire оставляли `.mcp.json = {}` и
 * `opencode.json = {"$schema": …}`, которых до wire не было. Журнал теперь
 * помнит, что файл создал wire (из ПЕРВОЙ записи), и unwire удаляет такой
 * файл, если после снятия наших узлов в нём не осталось чужого.
 */
describe("unwire удаляет файлы, которые создал wire", () => {
  const CREATED = [
    ".claude/settings.json",
    ".mcp.json",
    "opencode.json",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".kimi-code/mcp.json",
    "AGENTS.md",
  ];

  test("чистый репозиторий: wire всех + --status-line + wire opencode + unwire — ни одного созданного файла", async () => {
    const r = new Registry();
    r.register(createPrimeCommand());
    r.register(createAbsorbSessionCommand());
    r.register(createWireCommand(r, { probeStatusLine: () => ({ ok: true }), env: { CLAUDE_CONFIG_DIR: join(dir, "cfg") }, platform: "darwin" }));
    r.register(createUnwireCommand());
    const sl = (...args: string[]): Promise<RunResult> => run(["-C", dir, ...args], { registry: r, env: { MYC_ACTOR: "tester" } });
    expect((await sl("wire", "--status-line", "--agents-md")).code).toBe(0);
    for (const p of CREATED) expect([p, has(p)]).toEqual([p, true]);
    expect((await sl("wire", "--agents", "opencode")).code).toBe(0); // повторный — файл уже есть
    const un = await sl("unwire", "--json");
    expect(un.code).toBe(0);
    for (const p of CREATED) expect([p, has(p)]).toEqual([p, false]);
    expect(String((JSON.parse(un.stdout as string).data as { removed: string[] }).removed)).toContain("file created by wire — deleted");
  });

  test("файл, бывший до wire, остаётся — даже пустым", async () => {
    write(".mcp.json", "{}\n");
    write("AGENTS.md", "");
    await myc("wire", "--agents", "claude", "--agents-md");
    await myc("unwire");
    expect(read(".mcp.json")).toBe("{}\n");
    expect(has("AGENTS.md")).toBe(true);
  });

  test("в созданном файле осталось чужое — файл остаётся с чужим", async () => {
    await myc("wire", "--agents", "claude");
    // Кто-то дописал свой сервер — хеш сменился, файл не наш целиком: unwire
    // его не трогает вовсе (правило журнала), и уж точно не удаляет.
    const mcp = JSON.parse(read(".mcp.json")) as { mcpServers: Record<string, unknown> };
    mcp.mcpServers["other"] = { command: "other" };
    write(".mcp.json", `${JSON.stringify(mcp, null, 2)}\n`);
    await myc("unwire");
    expect(JSON.parse(read(".mcp.json")).mcpServers.other).toEqual({ command: "other" });
  });
});
