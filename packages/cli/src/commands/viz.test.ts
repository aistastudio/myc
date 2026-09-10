/**
 * Тесты команды `myc viz` через публичный run(), как её зовёт main.ts.
 * Сервер поднимается настоящий (порт 0), ожидание сигнала подменяется —
 * иначе тест повис бы навсегда, а не проверил бы команду.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { startVizServer, type VizServer } from "@myc/web";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createVizCommand, type VizDeps } from "./viz.ts";

let dir: string;
let db: string;
let registry: Registry;
let started: VizServer | undefined;
let opened: string[];
let written: string[];

function makeDeps(): VizDeps {
  return {
    start: (o) => {
      // порт 0 — свободный: тесты не должны драться за 7788
      started = startVizServer({ ...o, port: 0 });
      return started;
    },
    wait: () => Promise.resolve("SIGINT"),
    open: (url) => opened.push(url),
    write: (text) => written.push(text),
  };
}

beforeEach(async () => {
  opened = [];
  written = [];
  started = undefined;
  dir = mkdtempSync(join(tmpdir(), "myc-viz-cli-"));
  mkdirSync(join(dir, ".myc"));
  db = join(dir, ".myc", "myc.db");
  const raw = new Database(db, { create: true });
  raw.exec("PRAGMA journal_mode = WAL");
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createVizCommand(makeDeps()));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

describe("myc viz", () => {
  test("поднимает сервер, печатает баннер и останавливается по сигналу", async () => {
    const res = await run(["--directory", dir, "viz"], { registry });
    expect(res.code).toBe(ExitCode.OK);
    const banner = written.join("");
    expect(banner).toContain("read-only");
    expect(banner).toContain("embedded in the binary");
    expect(banner).toContain("http://127.0.0.1:");
    expect(text(res.stdout)).toContain("viz stopped (SIGINT)");
  });

  test("--json отдаёт конверт с итогом и read_only", async () => {
    const res = await run(["--directory", dir, "--json", "viz"], { registry });
    expect(res.code).toBe(ExitCode.OK);
    const env = JSON.parse(text(res.stdout)) as {
      ok: boolean;
      data: { read_only: boolean; requests: number; signal: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.read_only).toBe(true);
    expect(env.data.signal).toBe("SIGINT");
    // Баннер в машинном режиме не печатается — конверт должен быть один.
    expect(written.join("")).toBe("");
  });

  test("без воркспейса — код 7 и подсказка myc init", async () => {
    const empty = mkdtempSync(join(tmpdir(), "myc-viz-nows-"));
    const res = await run(["--directory", empty, "--json", "viz"], { registry });
    rmSync(empty, { recursive: true, force: true });
    expect(res.code).toBe(ExitCode.NOWS);
    const env = JSON.parse(text(res.stdout)) as { error: { code: string; hint: string } };
    expect(env.error.code).toBe("ws.not_initialized");
    expect(env.error.hint).toBe("myc init");
  });

  test("--open зовёт браузер ровно один раз", async () => {
    await run(["--directory", dir, "viz", "--open"], { registry });
    expect(opened.length).toBe(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  test("--limit выше потолка S18 громко урезается", async () => {
    const res = await run(["--directory", dir, "--json", "viz", "--limit", "90000"], { registry });
    const env = JSON.parse(text(res.stdout)) as { meta: { degraded: string[] } };
    expect(env.meta.degraded).toContain("viz.limit_capped");
    expect(started?.assetBytes).toBeGreaterThan(0);
  });

  test("неверный порт — код 2", async () => {
    const res = await run(["--directory", dir, "--json", "viz", "--port", "99999"], { registry });
    expect(res.code).toBe(ExitCode.USAGE);
  });

  test("CLI пишет в базу, пока viz открыт", async () => {
    // Ожидание сигнала подменяем на реальную работу писателя: пока команда
    // «висит», другое соединение делает запись, и она обязана пройти.
    let wrote = 0;
    const deps = makeDeps();
    deps.wait = async () => {
      const writer = new Database(db);
      writer.exec("PRAGMA busy_timeout = 3000");
      writer.exec(
        `INSERT INTO nodes (id, kind, scope, title, status, priority, content_hash, created_at, updated_at)
         VALUES ('w-1','note','','во время viz','active',2,'hh',1,1)`,
      );
      wrote = (writer.query("SELECT count(*) AS n FROM nodes").get() as { n: number }).n;
      writer.close();
      return "SIGTERM";
    };
    const r2 = new Registry();
    r2.register(createVizCommand(deps));
    const res = await run(["--directory", dir, "viz"], { registry: r2 });
    expect(res.code).toBe(ExitCode.OK);
    expect(wrote).toBe(1);
  });
});
