/**
 * Тесты команды `myc viz` через публичный run(), как её зовёт main.ts.
 * Сервер поднимается настоящий (порт 0), ожидание сигнала подменяется —
 * иначе тест повис бы навсегда, а не проверил бы команду.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { startVizServer, WRITE_OPS, type VizServer } from "@myc/web";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createVizCommand, VIZ_SCREENS, type VizDeps } from "./viz.ts";

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

  test("--json отдаёт конверт с итогом; read_only — то, что сказал сервер (запись включена)", async () => {
    const res = await run(["--directory", dir, "--json", "viz"], { registry });
    expect(res.code).toBe(ExitCode.OK);
    const env = JSON.parse(text(res.stdout)) as {
      ok: boolean;
      data: { read_only: boolean; requests: number; signal: string };
    };
    expect(env.ok).toBe(true);
    // Раньше здесь стояла константа true при сервере, принимающем POST.
    expect(started?.writable).toBe(true);
    expect(env.data.read_only).toBe(false);
    expect(env.data.signal).toBe("SIGINT");
    // Баннер в машинном режиме не печатается — конверт должен быть один.
    expect(written.join("")).toBe("");
  });

  test("сервер без записи: read_only true, баннер говорит, что правки выключены", async () => {
    const deps = makeDeps();
    deps.start = (o) => {
      started = startVizServer({ ...o, port: 0, readOnly: true });
      return started;
    };
    const r2 = new Registry();
    r2.register(createVizCommand(deps));
    const json = await run(["--directory", dir, "--json", "viz"], { registry: r2 });
    expect((JSON.parse(text(json.stdout)) as { data: { read_only: boolean } }).data.read_only).toBe(true);
    await run(["--directory", dir, "viz"], { registry: r2 });
    expect(written.join("")).toContain("edits are off");
  });

  test("баннер по умолчанию: чтение своим read-only соединением, правки — через запись CLI", async () => {
    await run(["--directory", dir, "viz"], { registry });
    const banner = written.join("");
    expect(banner).toContain("read-only connection for reads");
    expect(banner).toContain("edits go through the CLI's write path");
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

describe("myc viz --help описывает интерфейс, который есть", () => {
  /** Вкладки клиента — `const TABS = [...] as const` в @myc/web client/app.ts. */
  function clientTabs(): string[] {
    const src = readFileSync(join(import.meta.dir, "..", "..", "..", "web", "src", "client", "app.ts"), "utf8");
    const body = /const TABS = \[([\s\S]*?)\] as const;/.exec(src);
    if (body === null) throw new Error("в client/app.ts не найден const TABS = [...] as const");
    return [...body[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
  }

  async function help(): Promise<string> {
    const res = await run(["viz", "--help"], { registry });
    expect(res.code).toBe(ExitCode.OK);
    return text(res.stdout);
  }

  test("VIZ_SCREENS — ровно вкладки клиента, в том же порядке", () => {
    // Справка обещала четыре экрана, когда вкладок было десять: новая вкладка
    // без строки в VIZ_SCREENS обязана ронять этот тест.
    const tabs = clientTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(10);
    expect(VIZ_SCREENS.map(([tab]) => tab)).toEqual(tabs);
  });

  test("справка называет число экранов и каждый из них", async () => {
    const out = await help();
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    expect(out).toContain(`${words[VIZ_SCREENS.length]!.replace(/^./, (c) => c.toUpperCase())} screens — `);
    for (const [, name] of VIZ_SCREENS) expect(out).toContain(name);
    expect(out).not.toMatch(/four screens/i);
  });

  test("справка не называет интерфейс «только на чтение» и перечисляет каждую операцию записи", async () => {
    const out = await help();
    expect(out).not.toMatch(/read-only (web )?viewer/i);
    expect(out).toContain("same command engine as the terminal");
    for (const op of WRITE_OPS) expect(out).toContain(op);
    // Сводка в `myc --help` тоже не про «read-only».
    const top = text((await run(["--help"], { registry })).stdout);
    const line = top.split("\n").find((l) => /^\s+viz\s/.test(l));
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/read-only/i);
  });
});
