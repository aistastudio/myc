/**
 * `myc wire --queue-hook` (задача memory-sj2h9k235rxs): хук PreToolUse на
 * Bash, отправляющий тяжёлые команды агента через `myc run`.
 *
 * Свойства — те же, что у строки статуса: без флага не ставится ничего
 * (побайтно то же, что давал wire до этой задачи), повторный wire не меняет
 * ни байта, unwire возвращает чужой файл побайтно, а Codex не трогается вовсе —
 * его изменённый хук потребовал бы у человека повторного ревью.
 *
 * Мутация, на которой этот файл обязан краснеть (проверена на приёмке):
 *   «wire ставит хук без флага» — planQueueHook берёт запись и без
 *   `--queue-hook`: падают «без флага хук не ставится» и «без флага и с
 *   флагом — всё, кроме PreToolUse, побайтно одно и то же».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAbsorbSessionCommand } from "../hooks/absorb-session.ts";
import { QUEUE_HELPER_REL, queueHelper, queueHookCommand, QUEUE_HOOK_TIMEOUT_S } from "../hooks/queue-hook.ts";
import { HOOK_EVENTS } from "../hooks/templates.ts";
import { createPrimeCommand } from "./prime.ts";
import {
  createUnwireCommand,
  createWireCommand,
  generatedFiles,
  probeQueueBin,
  readWireJournal,
  type QueueProbe,
  type WireDeps,
} from "./wire.ts";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myc-wire-queue-"));
  dir = join(root, "proj");
  mkdirSync(join(dir, ".myc"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const OK_PROBE: QueueProbe = () => ({ ok: true, bin: { command: "myc", source: "path" } });

function registry(overrides: Partial<WireDeps> = {}): Registry {
  const r = new Registry();
  r.register(createPrimeCommand());
  r.register(createAbsorbSessionCommand());
  r.register(
    createWireCommand(r, {
      probeStatusLine: () => ({ ok: true }),
      probeQueue: OK_PROBE,
      env: { CLAUDE_CONFIG_DIR: join(root, "claude-config") },
      platform: "darwin",
      ...overrides,
    }),
  );
  r.register(createUnwireCommand());
  return r;
}

function myc(r: Registry, at: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", at, ...args], { registry: r, env: { MYC_ACTOR: "tester" } });
}

function write(rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

const read = (rel: string, at = dir): string => readFileSync(join(at, rel), "utf8");
const has = (rel: string, at = dir): boolean => existsSync(join(at, rel));
const settings = (at = dir): Record<string, any> => JSON.parse(read(".claude/settings.json", at)) as Record<string, any>;

/** Все файлы дерева (кроме журнала — в нём время записи), относительные пути → текст. */
function snapshot(at: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(at, abs), readFileSync(abs, "utf8"));
    }
  };
  walk(at);
  out.delete(".myc/wire.json");
  return out;
}

const FOREIGN = `${JSON.stringify({ permissions: { deny: ["Read(./.env)"] }, env: { A: "1" } }, null, 2)}\n`;

describe("wire --queue-hook: только по флагу", () => {
  test("без флага хук не ставится — и сказано, какой флаг его ставит", async () => {
    const r = await myc(registry(), dir, "wire", "--agents", "claude", "--json");
    expect(r.code).toBe(0);
    expect(settings()["hooks"]["PreToolUse"]).toBeUndefined();
    expect(has(QUEUE_HELPER_REL)).toBe(false);
    const data = JSON.parse(r.stdout as string).data as { untouched: string[] };
    expect(data.untouched).toContain(".claude/settings.json:hooks.PreToolUse (needs --queue-hook)");
  });

  test("с флагом: PreToolUse[Bash] на helper очереди, таймаут в секундах; helper — ровно шаблон", async () => {
    expect((await myc(registry(), dir, "wire", "--agents", "claude", "--queue-hook")).code).toBe(0);
    const pre = settings()["hooks"]["PreToolUse"] as any[];
    expect(pre).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: queueHookCommand("myc"), timeout: QUEUE_HOOK_TIMEOUT_S }] },
    ]);
    expect(read(QUEUE_HELPER_REL)).toBe(queueHelper());
    // Команда относительная к проекту: settings.json общий, чужой абсолютный путь в нём не нужен.
    expect(pre[0].hooks[0].command).not.toContain(dir);
  });

  test("повторный wire --queue-hook не меняет ни байта", async () => {
    const r = registry();
    await myc(r, dir, "wire", "--agents", "claude", "--queue-hook");
    const once = snapshot(dir);
    const again = await myc(r, dir, "wire", "--agents", "claude", "--queue-hook", "--json");
    expect((JSON.parse(again.stdout as string).data as { changed: number }).changed).toBe(0);
    expect(snapshot(dir)).toEqual(once);
  });

  /**
   * Главное свойство флага: он добавляет РОВНО свою запись и свой helper. Всё
   * остальное — helper'ы всех харнессов, конфиги, MCP — побайтно то же, что
   * пишет wire без флага, а значит то же, что писал wire до этой задачи.
   * Codex отдельно: изменённый `.codex/myc-hooks.mjs` или `.codex/hooks.json`
   * codex встречает экраном «hooks need review», и хук молча не работает, пока
   * человек его не одобрит.
   */
  test("без флага и с флагом — всё, кроме PreToolUse, побайтно одно и то же; Codex не тронут", async () => {
    const plain = join(root, "plain");
    mkdirSync(join(plain, ".myc"), { recursive: true });
    const r = registry();
    expect((await myc(r, plain, "wire")).code).toBe(0);
    expect((await myc(r, dir, "wire", "--queue-hook")).code).toBe(0);

    const a = snapshot(plain);
    const b = snapshot(dir);
    expect([...b.keys()].filter((k) => !a.has(k))).toEqual([QUEUE_HELPER_REL]);
    for (const [path, text] of a) {
      if (path === ".claude/settings.json") continue;
      expect([path, b.get(path) === text]).toEqual([path, true]);
    }
    expect(b.get(".codex/myc-hooks.mjs")).toBe(a.get(".codex/myc-hooks.mjs")!);
    expect(b.get(".codex/hooks.json")).toBe(a.get(".codex/hooks.json")!);

    const withHook = settings(dir);
    delete withHook["hooks"]["PreToolUse"];
    expect(`${JSON.stringify(withHook, null, 2)}\n`).toBe(a.get(".claude/settings.json")!);
  });

  test("unwire снимает запись и helper; чужой settings.json — побайтно как был", async () => {
    write(".claude/settings.json", FOREIGN);
    const r = registry();
    expect((await myc(r, dir, "wire", "--agents", "claude", "--queue-hook")).code).toBe(0);
    expect(readWireJournal(join(dir, ".myc", "wire.json"))!.entries.map((e) => e.path)).toContain(QUEUE_HELPER_REL);
    expect((await myc(r, dir, "unwire")).code).toBe(0);
    expect(read(".claude/settings.json")).toBe(FOREIGN);
    expect(has(QUEUE_HELPER_REL)).toBe(false);
  });

  test("обычный wire после --queue-hook хук сохраняет — снимает только unwire", async () => {
    write(".claude/settings.json", FOREIGN);
    const r = registry();
    await myc(r, dir, "wire", "--agents", "claude", "--queue-hook");
    const withHook = snapshot(dir);
    const plain = await myc(r, dir, "wire", "--agents", "claude", "--json");
    expect((JSON.parse(plain.stdout as string).data as { changed: number }).changed).toBe(0);
    expect(snapshot(dir)).toEqual(withHook);
    await myc(r, dir, "unwire");
    expect(read(".claude/settings.json")).toBe(FOREIGN);
  });

  test("чужой PreToolUse — конфликт, ничего не записано; append ставит наш вторым", async () => {
    const foreign = `${JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] } },
      null,
      2,
    )}\n`;
    write(".claude/settings.json", foreign);
    const r = registry();
    const refused = await myc(r, dir, "wire", "--agents", "claude", "--queue-hook");
    expect(refused.code).toBe(4);
    expect(String(refused.stderr)).toContain("guard.sh");
    expect(read(".claude/settings.json")).toBe(foreign);
    expect(has(QUEUE_HELPER_REL)).toBe(false);

    expect((await myc(r, dir, "wire", "--agents", "claude", "--queue-hook", "--hook-mode", "append")).code).toBe(0);
    const pre = settings()["hooks"]["PreToolUse"] as any[];
    expect(pre.map((e) => e.hooks[0].command)).toEqual(["guard.sh", queueHookCommand("myc")]);
    await myc(r, dir, "unwire");
    expect(read(".claude/settings.json")).toBe(foreign);
  });

  test("myc без `run` — отказ, не записано ничего", async () => {
    const r = registry({ probeQueue: () => ({ ok: false, why: "no myc here knows `run` — myc run --help: exit 2" }) });
    const res = await myc(r, dir, "wire", "--agents", "claude", "--queue-hook");
    expect(res.code).toBe(5); // PRECOND
    expect(String(res.stderr)).toContain("run --help: exit 2");
    expect(has(".claude/settings.json")).toBe(false);
    expect(has(".myc/wire.json")).toBe(false);
  });

  test("Windows и --agents без claude: хук не ставится, и это сказано вслух", async () => {
    const win = await myc(registry({ platform: "win32" }), dir, "wire", "--agents", "claude", "--queue-hook", "--json");
    expect(win.code).toBe(0);
    expect((JSON.parse(win.stdout as string).data as { notes: string[] }).notes.join("\n")).toContain("queue hook not installed");
    expect(settings()["hooks"]["PreToolUse"]).toBeUndefined();

    const codex = await myc(registry(), join(root, "c"), "wire", "--agents", "codex", "--queue-hook", "--json");
    expect((JSON.parse(codex.stdout as string).data as { notes: string[] }).notes.join("\n")).toContain("only for Claude Code");
  });

  test("путь сборки в проекте — аргументом хука; заметка говорит, когда вопроса не будет", async () => {
    const r = registry({ probeQueue: () => ({ ok: true, bin: { command: "dist/myc", source: "repo" } }) });
    const res = await myc(r, dir, "wire", "--agents", "claude", "--queue-hook", "--json");
    expect(settings()["hooks"]["PreToolUse"][0].hooks[0].command.endsWith(" dist/myc")).toBe(true);
    expect((JSON.parse(res.stdout as string).data as { notes: string[] }).notes.join("\n")).toContain(
      "approved without asking only when your own rules allow the original command",
    );
  });

  test("doctor сверяет свежесть helper'а очереди той же сборкой", () => {
    expect(generatedFiles(dir, HOOK_EVENTS, "json").get(QUEUE_HELPER_REL)).toBe(queueHelper());
  });
});

/**
 * Выбор myc для хука — запуском `<myc> run --help`, а не по наличию файла.
 * Настоящий случай этого репозитория: `node_modules/.bin/myc` — 0.1.0 без
 * `run`, и хук на нём превращал бы каждый `bun test` в ошибку.
 */
describe("probeQueueBin: myc проверяется на run запуском", () => {
  const GOOD = `#!/bin/sh\n[ "$1" = run ] && echo "myc run — run a heavy command through the machine-wide queue" && exit 0\nexit 2\n`;
  const OLD = `#!/bin/sh\necho "myc: usage.invalid: unknown command '$1'" >&2\nexit 2\n`;

  function exe(path: string, text: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, 0o755);
    return path;
  }

  test("старый myc в node_modules пропущен, сборка в dist выбрана — путём от корня", () => {
    exe(join(dir, "node_modules/.bin/myc"), OLD);
    exe(join(dir, "dist/myc"), GOOD);
    const oldOnPath = exe(join(root, "bin/myc"), OLD);
    const probe = probeQueueBin(dir, { PATH: dirname(oldOnPath) });
    expect(probe).toEqual({ ok: true, bin: { command: "dist/myc", source: "repo" } });
  });

  test("myc в PATH, который знает run, — голое слово myc: команда та, что набрал бы агент", () => {
    exe(join(dir, "dist/myc"), GOOD);
    const onPath = exe(join(root, "bin/myc"), GOOD);
    expect(probeQueueBin(dir, { PATH: dirname(onPath) })).toEqual({ ok: true, bin: { command: "myc", source: "path" } });
  });

  test("MYC_BIN — первым, и без run — отказ с перечнем испробованного", () => {
    const own = exe(join(root, "own/myc"), GOOD);
    expect(probeQueueBin(dir, { MYC_BIN: own, PATH: "" })).toEqual({ ok: true, bin: { command: own, source: "env" } });
    exe(join(dir, "node_modules/.bin/myc"), OLD);
    const refused = probeQueueBin(dir, { PATH: "" });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.why).toContain("node_modules/.bin/myc run --help: exit 2");
  });
});
