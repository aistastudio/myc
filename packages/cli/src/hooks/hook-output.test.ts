/**
 * `--hook-output json` держит stdout чистым (memory-mgkkdrbt27fb).
 *
 * Дефект сообщён с живого проекта: в деградированном случае хук печатал JSON,
 * а следом второй строкой `WARN` — в тот же stdout. Claude Code разбирает
 * stdout хука как один документ, спотыкался о вторую строку, и пакет не
 * доходил ВОВСЕ. То есть громкость превращала деградацию в полную потерю.
 *
 * Поэтому здесь запускается СГЕНЕРИРОВАННЫЙ helper целиком, настоящим
 * процессом node, с настоящим `myc absorb-session` на другом конце: unit-мок
 * на `hookJson()` этого дефекта не увидел бы — строку WARN приклеивал не он, а
 * каркас `run()`, и склейка происходила уже после того, как команда отработала.
 *
 * Мутация, вернувшая блок WARN в stdout (убрать `machineStdout` у команды или
 * ветку машинного stdout в index.ts), роняет тесты этого файла.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { ExitCode } from "../exit.ts";
import { createAbsorbSessionCommand } from "./absorb-session.ts";
import { claudeHelper } from "./templates.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const EVENTS = ["session-start", "pre-compact", "post-edit"] as const;

let dir: string;
let registry: Registry;
/** Шим, которым `bin()` внутри helper находит myc: настоящий CLI из исходников. */
let mycBin: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-hookout-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  mycBin = join(dir, "myc-shim.sh");
  writeFileSync(mycBin, `#!/bin/sh\nexec "${process.execPath}" run "${MAIN}" "$@"\n`);
  chmodSync(mycBin, 0o755);
  registry = new Registry();
  registry.register(createAbsorbSessionCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

/** Транскрипт с решениями: здоровый случай, деградации быть не должно. */
function goodTranscript(): string {
  const path = join(dir, "ok.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "user", cwd: dir, sessionId: "s1", message: { role: "user", content: "поехали" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Решили: k=60 в RRF оставляем." }] },
      }),
      "",
    ].join("\n"),
  );
  return path;
}

/**
 * НАСТОЯЩИЙ вызов хука: тот самый .mjs, который кладёт `myc wire`, запущенный
 * node'ом с payload'ом Claude Code на stdin. Возвращаем ровно то, что хост
 * увидел бы как stdout хука.
 */
async function viaHelper(payload: Record<string, unknown>): Promise<{ stdout: string; exitCode: number }> {
  const helper = join(dir, "myc-hooks.mjs");
  writeFileSync(helper, claudeHelper({ events: [...EVENTS], hookOutput: "json" }));
  const proc = Bun.spawn(["node", helper, "pre-compact"], {
    cwd: dir,
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "PreCompact", cwd: dir, ...payload })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MYC_BIN: mycBin, CLAUDE_PROJECT_DIR: dir },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { stdout, exitCode: proc.exitCode ?? -1 };
}

describe("деградация не ломает разбор: настоящий helper", () => {
  test("stdout разбирается JSON.parse БЕЗ ОСТАТКА, хотя хук деградировал", async () => {
    const r = await viaHelper({
      session_id: "s-degraded",
      trigger: "auto",
      transcript_path: join(dir, "нет-такого.jsonl"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);

    // Именно так читает хост: весь stdout как ОДИН документ. Вторая строка
    // здесь — это не «лишний шум», это потеря всего пакета.
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      warn: { code: string; msg: string }[];
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreCompact");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("контекст сжимается");

    // Деградация действительно была — и она в разобранном объекте, а не рядом.
    expect(parsed.warn.map((w) => w.code)).toContain("degraded.transcript");
    expect(parsed.warn.some((w) => w.msg.includes("несуществующий транскрипт"))).toBe(true);

    // Ни одной строки WARN мимо документа: после JSON нет ничего, кроме \n.
    expect(r.stdout.trimEnd().split("\n").length).toBe(1);
    expect(r.stdout).not.toMatch(/^WARN /m);
  });

  test("здоровый случай: тот же документ, warn пуст", async () => {
    const r = await viaHelper({ session_id: "s-ok", trigger: "auto", transcript_path: goodTranscript() });
    const parsed = JSON.parse(r.stdout) as { warn: unknown[] };
    expect(parsed.warn).toEqual([]);
  });
});

describe("каналы разведены: машине — документ, человеку — stderr", () => {
  test("stdout чист, а те же предупреждения видны в stderr", async () => {
    const r = await myc("absorb-session", "--transcript", join(dir, "нет-такого.jsonl"), "--hook-output", "json");
    const stdout = r.stdout as string;

    JSON.parse(stdout); // не бросает — иначе тест падает здесь
    expect(stdout).not.toContain("WARN degraded");

    // Человек, позвавший хук руками, обязан прочитать это словами.
    expect(r.stderr ?? "").toContain("WARN degraded.transcript");
    expect(r.stderr ?? "").toContain("несуществующий транскрипт");
  });

  test("без деградации stderr пуст: тишина остаётся тишиной", async () => {
    const r = await myc("absorb-session", "--transcript", goodTranscript(), "--hook-output", "json");
    JSON.parse(r.stdout as string);
    expect(r.stderr ?? "").toBe("");
  });

  test("--hook-output text не тронут: там stdout читает человек, и WARN на месте", async () => {
    const r = await myc("absorb-session", "--transcript", join(dir, "нет-такого.jsonl"), "--hook-output", "text");
    expect(r.stdout as string).toContain("WARN degraded.transcript");
    expect(r.stderr).toBeUndefined();
  });

  test("диагностика не потеряна: --strict по-прежнему даёт код деградации", async () => {
    // Ловушка «увести WARN в stderr» — вычеркнуть их из diagnostics вовсе.
    // Тогда молча пропадут и код выхода, и конверт --json.
    const r = await myc(
      "absorb-session",
      "--transcript",
      join(dir, "нет-такого.jsonl"),
      "--hook-output",
      "json",
      "--strict",
    );
    expect(r.code).toBe(ExitCode.DEGRADED);
  });

  test("конверт --json продолжает нести warn[] и meta.degraded[]", async () => {
    const r = await myc(
      "absorb-session",
      "--transcript",
      join(dir, "нет-такого.jsonl"),
      "--hook-output",
      "json",
      "--json",
    );
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect((env["warn"] as { code: string }[]).map((w) => w.code)).toContain("degraded.transcript");
    expect((env["meta"] as { degraded: string[] }).degraded).toContain("degraded.transcript");
  });
});
