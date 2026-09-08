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
import { createPrimeCommand } from "./prime.ts";
import { createUnwireCommand, createWireCommand, resolveMycBin } from "./wire.ts";

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
    expect(has(".codex/myc-notify.mjs")).toBe(true);
    expect(has(".opencode/plugin/myc.ts")).toBe(true);
    expect(has(".kimi-code/skills/myc/SKILL.md")).toBe(true);
    expect(has(".kimi-code/myc-hooks.mjs")).toBe(true);
    expect(has(".kimi-code/mcp.json")).toBe(true);
    expect(has(".myc/wire.json")).toBe(true);
    expect(has("CLAUDE.md")).toBe(false);
    expect(has("AGENTS.md")).toBe(false);
  });

  test("PreCompact стоит с таймаутом 8000 и матчером manual|auto", async () => {
    await myc("wire");
    const settings = JSON.parse(read(".claude/settings.json"));
    const pre = settings.hooks.PreCompact[0];
    expect(pre.matcher).toBe("manual|auto");
    expect(pre.hooks[0].timeout).toBe(8000);
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
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    const notes = (env["data"] as Record<string, unknown>)["notes"] as string[];
    expect(notes.join(" ")).toContain("notify");
    const toml = read(".codex/config.toml");
    expect(toml).toContain('notify = ["node", "other.mjs"]');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain("[mcp_servers.myc]");
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
    // Таймаут у Kimi в СЕКУНДАХ (1..600), у Claude Code — в миллисекундах.
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
