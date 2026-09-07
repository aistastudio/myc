/**
 * `myc move` — поверхность: план без записи, коды выхода, надгробие в `show`.
 * Гонки и обрывы живут в move.multiprocess.test.ts на настоящих процессах.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createMoveCommand } from "./move.ts";
import { createReadyCommand } from "./ready.ts";
import { createShowCommand } from "./show.ts";
import { createTaskCommand } from "./tasks.ts";

let root: string;
let homeDir: string;
let registry: Registry;

beforeEach(() => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-move-cli-"));
  homeDir = mkdtempSync(join(tmpdir(), "myc-move-cli-home-"));
  process.env.MYC_HOME = homeDir;
  registry = new Registry();
  registry.register(createInitCommand());
  registry.register(createTaskCommand());
  registry.register(createReadyCommand());
  registry.register(createShowCommand());
  registry.register(createMoveCommand());
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

async function ws(name: string): Promise<string> {
  const dir = join(root, name);
  Bun.spawnSync(["mkdir", "-p", dir]);
  expect((await myc(dir, "init")).code).toBe(ExitCode.OK);
  return dir;
}

async function task(dir: string, title: string): Promise<string> {
  const r = await myc(dir, "task", title);
  expect(r.code).toBe(ExitCode.OK);
  return text(r.stdout).split("\n")[0]!.split(/\s+/)[0]!;
}

describe("myc move", () => {
  test("--dry-run печатает набор и не пишет ничего", async () => {
    const a = await ws("repoa");
    const b = await ws("rootb");
    const id = await task(a, "кандидат на переезд");

    const dry = await myc(a, "move", id, "--to", b, "--dry-run", "--json");
    expect(dry.code).toBe(ExitCode.OK);
    const env = JSON.parse(dry.stdout as string) as { data: { members: string[]; dry_run: boolean } };
    expect(env.data.dry_run).toBe(true);
    expect(env.data.members).toEqual([id]);

    // Ни в источнике, ни в приёмнике ничего не поменялось.
    expect(text((await myc(a, "ready")).stdout)).toContain(id);
    expect(text((await myc(b, "ready")).stdout)).not.toContain(id);
  });

  test("переезд: очередь приёмника видит задачу, очередь источника — нет", async () => {
    const a = await ws("repoc");
    const b = await ws("rootd");
    const id = await task(a, "уезжает");

    const moved = await myc(a, "move", id, "--to", b);
    expect(moved.code).toBe(ExitCode.OK);
    expect(text(moved.stdout)).toContain("едет 1 узлов");

    expect(text((await myc(b, "ready")).stdout)).toContain(id);
    expect(text((await myc(a, "ready")).stdout)).not.toContain(id);
  });

  test("надгробие в источнике объясняет себя, а не притворяется задачей", async () => {
    const a = await ws("repoe");
    const b = await ws("rootf");
    const id = await task(a, "с надгробием");
    expect((await myc(a, "move", id, "--to", b)).code).toBe(ExitCode.OK);

    const show = await myc(a, "show", id);
    expect(show.code).toBe(ExitCode.OK);
    expect(text(show.stdout)).toContain("переехала в воркспейс");

    // В приёмнике это обычная задача, без всяких надгробий.
    const there = await myc(b, "show", id);
    expect(text(there.stdout)).not.toContain("переехала в воркспейс");
  });

  test("без --to — ошибка употребления, а не догадка о приёмнике", async () => {
    const a = await ws("repog");
    const id = await task(a, "без приёмника");
    const r = await myc(a, "move", id);
    expect(r.code).toBe(ExitCode.USAGE);
  });

  test("приёмник без воркспейса — ws.not_initialized, источник не тронут", async () => {
    const a = await ws("repoh");
    const id = await task(a, "некуда");
    const r = await myc(a, "move", id, "--to", join(root, "пусто"));
    expect(r.code).toBe(ExitCode.NOWS);
    expect(text((await myc(a, "ready")).stdout)).toContain(id);
  });

  test("--pending на чистом воркспейсе молчит", async () => {
    const b = await ws("rooti");
    const r = await myc(b, "move", "--pending");
    expect(r.code).toBe(ExitCode.OK);
    expect(text(r.stdout)).toContain("недоигранных переездов нет");
  });
});
