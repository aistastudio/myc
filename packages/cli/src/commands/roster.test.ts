import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createModelCommand } from "./roster.ts";

/**
 * CLI-конверт `myc model …`. База — настоящая, во временном каталоге,
 * открытие — боевое (realOpenRoster через глобальный --db): так проверяется
 * весь путь «завести → изменить → прочитать машинно → удалить», включая
 * накат схемы ростера.
 */

let dir: string;
let dbPath: string;
let registry: Registry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-roster-cli-"));
  dbPath = join(dir, "myc.db");
  new Database(dbPath, { create: true }).close();
  registry = new Registry();
  registry.register(createModelCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function jsonOf(argv: readonly string[]) {
  const result = await run([...argv, "--db", dbPath, "--json"], { registry });
  return { envelope: JSON.parse(result.stdout as string), code: result.code };
}

const ADD = [
  "model",
  "add",
  "anthropic/claude-sonnet-5",
  "--family",
  "claude-sonnet",
  "--harness",
  "claude",
  "--effort",
  "high",
  "--price-in",
  "3",
  "--price-out",
  "15",
] as const;

describe("model add", () => {
  test("заводит модель, читается машинно через list --json", async () => {
    const added = await jsonOf(ADD);
    expect(added.code).toBe(ExitCode.OK);
    expect(added.envelope).toMatchObject({ ok: true, cmd: "model add" });
    expect(added.envelope.data).toMatchObject({
      modelId: "anthropic/claude-sonnet-5",
      family: "claude-sonnet",
      harness: "claude",
      effort: "high",
      strengths: [],
      active: true,
      priceStale: false,
      priceAgeDays: 0,
    });
    expect(added.envelope.data.price).toMatchObject({ usdPerMIn: 3, usdPerMOut: 15 });

    const listed = await jsonOf(["model", "list"]);
    expect(listed.code).toBe(ExitCode.OK);
    expect(listed.envelope.meta.count).toBe(1);
    expect(listed.envelope.data[0]).toMatchObject({
      modelId: "anthropic/claude-sonnet-5",
      harness: "claude",
    });
  });

  test("неизвестный харнесс отвергается, записи-призрака нет (мутация 1)", async () => {
    const bad = await jsonOf([...ADD.slice(0, 3), "--family", "x", "--harness", "vim",
      "--price-in", "1", "--price-out", "2"]);
    expect(bad.code).toBe(ExitCode.USAGE);
    expect(bad.envelope).toMatchObject({ ok: false, error: { code: "usage.harness" } });

    const listed = await jsonOf(["model", "list"]);
    expect(listed.envelope.meta.count).toBe(0);
  });

  test("без цены — usage.price, а не запись без факта стоимости", async () => {
    const res = await jsonOf(["model", "add", "p/m", "--family", "f", "--harness", "kimi"]);
    expect(res.code).toBe(ExitCode.USAGE);
    expect(res.envelope.error.code).toBe("usage.price");
  });

  test("кривая дата цены — usage.date", async () => {
    const res = await jsonOf([...ADD, "--price-date", "вчера"]);
    expect(res.code).toBe(ExitCode.USAGE);
    expect(res.envelope.error.code).toBe("usage.date");
  });

  test("старая --price-date помечается priceStale (мутация 2)", async () => {
    const res = await jsonOf([...ADD, "--price-date", "2020-01-01"]);
    expect(res.code).toBe(ExitCode.OK);
    expect(res.envelope.data.priceStale).toBe(true);
    expect(res.envelope.data.price.validFrom).toBe("2020-01-01T00:00:00.000Z");
    expect(res.envelope.data.priceAgeDays).toBeGreaterThan(2000);
  });

  test("повторный add той же модели — CONFLICT", async () => {
    await jsonOf(ADD);
    const dup = await jsonOf(ADD);
    expect(dup.code).toBe(ExitCode.CONFLICT);
    expect(dup.envelope.error.code).toBe("conflict.model");
  });
});

describe("model update", () => {
  test("меняет поля и добавляет цену новым фактом с датой", async () => {
    await jsonOf([...ADD, "--price-date", "2026-01-01"]);
    const res = await jsonOf([
      "model", "update", "anthropic/claude-sonnet-5",
      "--effort", "medium",
      "--strengths", "fix:module,docs:local",
      "--price-in", "2.5", "--price-out", "12",
    ]);
    expect(res.code).toBe(ExitCode.OK);
    expect(res.envelope.data).toMatchObject({
      effort: "medium",
      strengths: ["fix:module", "docs:local"],
      priceStale: false,
    });

    const shown = await jsonOf(["model", "show", "anthropic/claude-sonnet-5"]);
    expect(shown.envelope.data.priceHistory.length).toBe(2);
    expect(shown.envelope.data.priceHistory[0].usdPerMIn).toBe(2.5);
    expect(shown.envelope.data.priceHistory[1].validFrom).toBe("2026-01-01T00:00:00.000Z");
  });

  test("без флагов — usage.input", async () => {
    await jsonOf(ADD);
    const res = await jsonOf(["model", "update", "anthropic/claude-sonnet-5"]);
    expect(res.code).toBe(ExitCode.USAGE);
    expect(res.envelope.error.code).toBe("usage.input");
  });

  test("неизвестная модель — NOTFOUND", async () => {
    const res = await jsonOf(["model", "update", "nobody", "--effort", "low"]);
    expect(res.code).toBe(ExitCode.NOTFOUND);
    expect(res.envelope.error.code).toBe("notfound.model");
  });
});

describe("цена кеша (memory-501fa4jp7xpw)", () => {
  const ID = "anthropic/claude-sonnet-5";

  test("флаги пишут ставки кеша в ту же строку цены", async () => {
    const res = await jsonOf([...ADD, "--price-cache-read", "0.3", "--price-cache-write", "3.75"]);
    expect(res.code).toBe(ExitCode.OK);
    expect(res.envelope.data.price).toMatchObject({
      usdPerMIn: 3,
      usdPerMOut: 15,
      usdPerMCacheRead: 0.3,
      usdPerMCacheWrite: 3.75,
    });
    expect(res.envelope.data.cacheUnpriced).toBe(false);
    expect(res.envelope.warn).toEqual([]);
  });

  test("без флагов ставки не нулевые, а умолчание названо в выводе", async () => {
    const res = await jsonOf(ADD);
    expect(res.code).toBe(ExitCode.OK);
    // 10% и 125% от --price-in=3; числа лежат в базе, доли — только ввод.
    expect(res.envelope.data.price).toMatchObject({
      usdPerMCacheRead: 0.3,
      usdPerMCacheWrite: 3.75,
    });
    expect(res.envelope.data.cacheUnpriced).toBe(false);
    const warn = res.envelope.warn as Array<{ code: string; msg: string }>;
    expect(warn.map((w) => w.code)).toEqual(["price.cache_defaulted"]);
    expect(warn[0]!.msg).toContain("read=10%");
    expect(warn[0]!.msg).toContain("write=125%");
    expect(warn[0]!.msg).toContain("--price-cache-read");
  });

  test("отрицательная ставка отвергается до записи", async () => {
    const res = await jsonOf([...ADD, "--price-cache-read", "-1"]);
    expect(res.code).toBe(ExitCode.USAGE);
    expect(res.envelope.error.code).toBe("usage.price");
    expect((await jsonOf(["model", "list"])).envelope.data.length).toBe(0);
  });

  test("update правит одни ставки кеша: in/out берутся из действующей цены", async () => {
    await jsonOf([...ADD, "--price-date", "2026-01-01"]);
    const res = await jsonOf([
      "model", "update", ID,
      "--price-cache-read", "0.31", "--price-cache-write", "3.8",
      "--price-date", "2026-02-01",
    ]);
    expect(res.code).toBe(ExitCode.OK);
    expect(res.envelope.data.price).toMatchObject({
      usdPerMIn: 3,
      usdPerMOut: 15,
      usdPerMCacheRead: 0.31,
      usdPerMCacheWrite: 3.8,
    });
  });

  test("точная дата исправляет уже записанный факт, а не заводит второй", async () => {
    await jsonOf([...ADD, "--price-date", "2026-01-01T09:30:00.000Z"]);
    const res = await jsonOf([
      "model", "update", ID,
      "--price-in", "3", "--price-out", "15",
      "--price-cache-read", "0.3", "--price-cache-write", "3.75",
      "--price-date", "2026-01-01T09:30:00.000Z",
    ]);
    expect(res.code).toBe(ExitCode.OK);
    const shown = await jsonOf(["model", "show", ID]);
    expect(shown.envelope.data.priceHistory.length).toBe(1);
    expect(shown.envelope.data.priceHistory[0]).toMatchObject({
      validFrom: "2026-01-01T09:30:00.000Z",
      usdPerMCacheRead: 0.3,
      usdPerMCacheWrite: 3.75,
    });
  });

  test("нулевые ставки в базе — cacheUnpriced говорит вслух", async () => {
    await jsonOf([...ADD, "--price-cache-read", "0", "--price-cache-write", "0"]);
    const shown = await jsonOf(["model", "show", ID]);
    expect(shown.envelope.data.cacheUnpriced).toBe(true);
  });
});

describe("model disable/enable (мутация 3: история переживает удаление)", () => {
  test("disable прячет из list, но show и история цен читаются", async () => {
    await jsonOf(ADD);
    const disabled = await jsonOf(["model", "disable", "anthropic/claude-sonnet-5"]);
    expect(disabled.code).toBe(ExitCode.OK);
    expect(disabled.envelope.data.active).toBe(false);

    const listed = await jsonOf(["model", "list"]);
    expect(listed.envelope.meta.count).toBe(0);

    const all = await jsonOf(["model", "list", "--all"]);
    expect(all.envelope.meta.count).toBe(1);
    expect(all.envelope.data[0].active).toBe(false);

    const shown = await jsonOf(["model", "show", "anthropic/claude-sonnet-5"]);
    expect(shown.code).toBe(ExitCode.OK);
    expect(shown.envelope.data.active).toBe(false);
    expect(shown.envelope.data.priceHistory.length).toBe(1);

    const enabled = await jsonOf(["model", "enable", "anthropic/claude-sonnet-5"]);
    expect(enabled.envelope.data.active).toBe(true);
    expect((await jsonOf(["model", "list"])).envelope.meta.count).toBe(1);
  });

  test("disable неизвестной — NOTFOUND", async () => {
    const res = await jsonOf(["model", "disable", "nobody"]);
    expect(res.code).toBe(ExitCode.NOTFOUND);
  });
});

describe("воркспейс", () => {
  test("нет базы — NOWS с подсказкой myc init", async () => {
    const result = await run(
      ["model", "list", "--db", join(dir, "absent.db"), "--json"],
      { registry },
    );
    expect(result.code).toBe(ExitCode.NOWS);
    const envelope = JSON.parse(result.stdout as string);
    expect(envelope.error.code).toBe("ws.not_initialized");
  });
});
