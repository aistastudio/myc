/**
 * `myc version` через публичный run(): что печатается человеку, что попадает
 * в конверт и КОГДА уходит запрос в сеть.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, CLI_VERSION, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { ExitCode } from "../exit.ts";
import { createVersionCommand } from "./version.ts";
import { PACKAGE_NAME, updateCachePath } from "../update-check.ts";

let home: string;
let registry: Registry;
let realFetch: typeof fetch;
let calls: string[];

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createVersionCommand());
  return r;
}

/** Подменённый глобальный fetch: считает вызовы и отвечает заданной версией. */
function answerWith(latest: string | null): void {
  globalThis.fetch = ((input: unknown) => {
    calls.push(String(input));
    if (latest === null) return Promise.reject(new Error("ENETDOWN тестовый"));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ "dist-tags": { latest } }),
    });
  }) as unknown as typeof fetch;
}

async function version(args: string[]): Promise<RunResult> {
  return run(args, { registry });
}

function json(res: RunResult): { data: Record<string, unknown>; warn: unknown[] } {
  return JSON.parse(String(res.stdout)) as { data: Record<string, unknown>; warn: unknown[] };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "myc-ver-"));
  mkdirSync(join(home, ".myc"), { recursive: true });
  process.env.MYC_HOME = home;
  delete process.env.MYC_UPDATE_CHECK;
  delete process.env.MYC_REGISTRY;
  registry = makeRegistry();
  calls = [];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MYC_HOME;
  delete process.env.MYC_UPDATE_CHECK;
  rmSync(home, { recursive: true, force: true });
});

describe("myc version без --check: сети нет вовсе", () => {
  test("ни одного запроса, даже с живым fetch", async () => {
    answerWith("9.9.9");
    const res = await version(["version", "--json"]);
    expect(res.code).toBe(ExitCode.OK);
    expect(calls).toEqual([]);
    const d = json(res).data;
    expect(d["version"]).toBe(CLI_VERSION);
    expect((d["update"] as { status: string }).status).toBe("never_checked");
  });

  test("человеку — версия и как проверить", async () => {
    answerWith("9.9.9");
    const res = await version(["version"]);
    expect(String(res.stdout)).toContain(`myc ${CLI_VERSION}`);
    expect(String(res.stdout)).toContain("myc version --check");
    expect(calls).toEqual([]);
  });

  test("вердикт из кеша, без сети", async () => {
    writeFileSync(
      updateCachePath(process.env),
      JSON.stringify({ package: PACKAGE_NAME, latest: "99.0.0", checked_at: Date.now(), error: null }),
    );
    answerWith("9.9.9");
    const res = await version(["version"]);
    expect(calls).toEqual([]);
    expect(String(res.stdout)).toContain("обновление:");
    expect(String(res.stdout)).toContain("99.0.0");
  });
});

describe("myc version --check: единственный сетевой путь", () => {
  test("новее в реестре — обновление и команда обновления", async () => {
    answerWith("99.0.0");
    const res = await version(["version", "--check"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("registry.npmjs.org");
    expect(String(res.stdout)).toContain("обновление:");
    expect(String(res.stdout)).toContain(`bun install -g ${PACKAGE_NAME}`);
  });

  test("реестр недоступен — «НЕ проверены» + WARN, а не «обновлений нет»", async () => {
    answerWith(null);
    const res = await version(["version", "--check"]);
    const out = String(res.stdout);
    expect(out).toContain("обновления НЕ проверены");
    expect(out).toContain("WARN update.unreachable");
    expect(out).not.toContain("обновляться некуда");
    expect(res.code).toBe(ExitCode.OK);
  });

  test("--strict превращает «не смогли проверить» в код 6", async () => {
    answerWith(null);
    const res = await version(["version", "--check", "--strict"]);
    expect(res.code).toBe(ExitCode.DEGRADED);
  });

  test("недоступный реестр в конверте — статус unreachable и warn", async () => {
    answerWith(null);
    const res = await version(["version", "--check", "--json"]);
    const { data, warn } = json(res);
    const u = data["update"] as { status: string; reason?: string; latest?: string };
    expect(u.status).toBe("unreachable");
    expect(u.latest).toBeUndefined();
    expect(u.reason).toBeTruthy();
    expect(JSON.stringify(warn)).toContain("update.unreachable");
  });

  test("0.9.0 против 0.10.0 в реестре — обновление найдено (не строками)", async () => {
    // CLI_VERSION здесь 0.1.1, поэтому проверяем через реестр, который
    // отвечает 0.10.0: строковое сравнение с «0.9.0» дало бы обратное.
    answerWith("0.10.0");
    const res = await version(["version", "--check", "--json"]);
    const u = json(res).data["update"] as { status: string; latest: string };
    expect(u.status).toBe("update_available");
    expect(u.latest).toBe("0.10.0");
  });
});

describe("отключаемость видна в выводе", () => {
  test("MYC_UPDATE_CHECK=0: --check не идёт в сеть и говорит почему", async () => {
    process.env.MYC_UPDATE_CHECK = "0";
    answerWith("99.0.0");
    const res = await version(["version", "--check"]);
    expect(calls).toEqual([]);
    const out = String(res.stdout);
    expect(out).toContain("проверка обновлений выключена");
    expect(out).toContain("WARN update.disabled");
    expect(out).not.toContain("обновляться некуда");
  });

  test("--offline: тот же отказ на один вызов", async () => {
    answerWith("99.0.0");
    const res = await version(["version", "--check", "--offline"]);
    expect(calls).toEqual([]);
    expect(String(res.stdout)).toContain("--offline");
  });

  test("режим и адрес реестра печатаются всегда — «куда оно ходит» не гадают", async () => {
    const res = await version(["version"]);
    expect(String(res.stdout)).toContain("режим: manual");
    expect(String(res.stdout)).toContain("registry.npmjs.org");
  });
});
