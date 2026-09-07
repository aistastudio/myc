/**
 * myc-qie.13 — `ready` обязан показывать задачи с истёкшей арендой наравне
 * с открытыми и помечать их: брошенная задача — не "free".
 *
 * Часть 1 (unit, ручные часы): проверяет ровно границу предиката
 * `lease_expires < now` через collectTop() напрямую — свой GraphStore с
 * HlcClock({now: manualClock.now}), время двигает только тест, не Date.now.
 *
 * Часть 2 (интеграция, живой CLI): создаёт задачу, захватывает её с уже
 * истёкшим TTL и прогоняет настоящую команду `ready`/`ready --claim` через
 * publичный run(), как их вызывает main.ts — тот же путь, что видит
 * пользователь.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { generateId, HlcClock } from "@myc/core";
import { migrate, migrations, GraphStore, Claims } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { collectTop, createReadyCommand } from "./ready.ts";
import { createClaimCommand, createCreateCommand, createTaskCommand } from "./tasks.ts";
import {
  openDriver,
  DEFAULT_READY_WEIGHTS,
  type CliDriver,
  type StoreHandle,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Часть 1: граница lease_expires < now, ручные часы
// ---------------------------------------------------------------------------

function manualClock(startMs = 1_700_000_000_000) {
  const state = { t: startMs };
  return {
    now: () => state.t,
    set: (t: number) => {
      state.t = t;
    },
  };
}

describe("collectTop: граница истечения аренды (ручные часы)", () => {
  let dir: string;
  let driver: CliDriver;
  let handle: StoreHandle;
  let clock: ReturnType<typeof manualClock>;
  let taskId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "myc-ready-clock-"));
    driver = openDriver(join(dir, "myc.db"));
    await migrate(driver.database, { migrations, writable: true });
    clock = manualClock();
    const store = new GraphStore(driver, {
      newId: generateId,
      actor: "dead-agent",
      siteId: "siteA",
      clock: new HlcClock({ now: clock.now }),
    });
    const claims = new Claims(store, { holder: "dead-agent" });
    handle = {
      driver,
      store,
      claims,
      actor: "dead-agent",
      scope: "s",
      slug: "s",
      wsDir: dir,
      repo: { repo: "", reason: "", from: dir },
      weights: DEFAULT_READY_WEIGHTS,
      vec0: driver.vec0,
      vec0Reason: driver.vec0Reason,
      close: () => driver.close(),
    };

    const node = store.createNode({ kind: "task", scope: "s", title: "брошенная задача" });
    taskId = node.id;

    // Держатель захватывает задачу на 30 минут и умирает, не отпустив её.
    const ticket = claims.claim(taskId, 30 * 60_000);
    expect(ticket).toBeDefined();
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("за миллисекунду до истечения задачи в ready нет", () => {
    const expiresAt = handle.claims.leaseOf(taskId)!.expires;
    const { items, total } = collectTop(handle, 10, expiresAt - 1);
    expect(items.map((i) => i.id)).not.toContain(taskId);
    expect(total).toBe(0);
  });

  test("ровно в момент истечения задачи в ready ещё нет (lease_expires < now, не <=)", () => {
    const expiresAt = handle.claims.leaseOf(taskId)!.expires;
    const { items } = collectTop(handle, 10, expiresAt);
    expect(items.map((i) => i.id)).not.toContain(taskId);
  });

  test("через миллисекунду после истечения задача появляется в ready, помеченной", () => {
    const expiresAt = handle.claims.leaseOf(taskId)!.expires;
    const { items, total } = collectTop(handle, 10, expiresAt + 1);
    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    expect(item!.expired_lease).toEqual({ holder: "dead-agent", expires_at: expiresAt });
    expect(total).toBe(1);
  });

  test("ready --claim (движок) забирает задачу с истёкшей арендой", () => {
    const expiresAt = handle.claims.leaseOf(taskId)!.expires;
    clock.set(expiresAt + 1);
    const ticket = handle.claims.claim(taskId, 30 * 60_000);
    expect(ticket).toBeDefined();
    expect(ticket!.holder).toBe("dead-agent"); // тот же актёр в этом тесте, но эпоха выросла
    expect(ticket!.epoch).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// myc-qie.14 — lease_expires=0 (импортированная in_progress-задача без
// аренды) не должна читаться как истёкшая. Три случая на ручных часах:
// ноль, будущее, прошлое.
// ---------------------------------------------------------------------------

describe("collectTop: lease_expires=0 — задача в работе без аренды (импорт)", () => {
  let dir: string;
  let driver: CliDriver;
  let handle: StoreHandle;
  let clock: ReturnType<typeof manualClock>;
  let taskId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "myc-ready-lease0-"));
    driver = openDriver(join(dir, "myc.db"));
    await migrate(driver.database, { migrations, writable: true });
    clock = manualClock();
    const store = new GraphStore(driver, {
      newId: generateId,
      actor: "importer",
      siteId: "siteA",
      clock: new HlcClock({ now: clock.now }),
    });
    const claims = new Claims(store, { holder: "importer" });
    handle = {
      driver,
      store,
      claims,
      actor: "importer",
      scope: "s",
      slug: "s",
      wsDir: dir,
      repo: { repo: "", reason: "", from: dir },
      weights: DEFAULT_READY_WEIGHTS,
      vec0: driver.vec0,
      vec0Reason: driver.vec0Reason,
      close: () => driver.close(),
    };

    const node = store.createNode({ kind: "task", scope: "s", title: "импортированная задача" });
    taskId = node.id;
    // Импортированная in_progress-задача: никогда не арендовалась —
    // lease_expires=0, lease_holder='' (не через Claims.claim()).
    driver.database.run(
      "UPDATE nodes SET status = 'in_progress', lease_expires = 0, lease_holder = '' WHERE id = ?1",
      [taskId],
    );
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("ноль: не считается брошенной, не попадает в ready", () => {
    const { items, total } = collectTop(handle, 10, clock.now());
    expect(items.map((i) => i.id)).not.toContain(taskId);
    expect(total).toBe(0);
  });

  test("будущее: lease_expires в будущем — тоже не брошена", () => {
    driver.database.run("UPDATE nodes SET lease_expires = ?1 WHERE id = ?2", [
      clock.now() + 60_000,
      taskId,
    ]);
    const { items, total } = collectTop(handle, 10, clock.now());
    expect(items.map((i) => i.id)).not.toContain(taskId);
    expect(total).toBe(0);
  });

  test("прошлое: настоящая истёкшая аренда (lease_expires > 0) по-прежнему возвращается", () => {
    driver.database.run("UPDATE nodes SET lease_expires = ?1, lease_holder = ?2 WHERE id = ?3", [
      clock.now() - 60_000,
      "dead-agent",
      taskId,
    ]);
    const { items, total } = collectTop(handle, 10, clock.now());
    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    expect(item!.expired_lease).toEqual({ holder: "dead-agent", expires_at: clock.now() - 60_000 });
    expect(total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Часть 2: живой CLI (create → claim → истечение → ready → ready --claim)
// ---------------------------------------------------------------------------

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createCreateCommand());
  r.register(createTaskCommand());
  r.register(createClaimCommand());
  r.register(createReadyCommand());
  return r;
}

describe("ready: интеграция через живой CLI", () => {
  let dir: string;
  let db: string;
  let registry: Registry;

  function myc(actor: string, ...args: string[]): Promise<RunResult> {
    process.env.MYC_ACTOR = actor;
    return run(["-C", dir, ...args], { registry });
  }

  function idOf(out: string | Iterable<string>): string {
    const line = (typeof out === "string" ? out : [...out].join("")).split("\n")[0]!;
    return line.split(/\s+/)[0]!;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "myc-ready-cli-"));
    mkdirSync(join(dir, ".myc"));
    db = join(dir, ".myc", "myc.db");
    const raw = new Database(db, { create: true });
    await migrate(raw, { migrations, writable: true });
    raw.close();
    registry = makeRegistry();
  });

  afterEach(() => {
    delete process.env.MYC_ACTOR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("задача с истёкшей арендой попадает в ready с пометкой и её забирает --claim", async () => {
    const created = await myc("alive-agent", "task", "брошенная задача");
    expect(created.code).toBe(ExitCode.OK);
    const id = idOf(created.stdout);

    const claimed = await myc("dead-agent", "claim", id, "--lease", "1s");
    expect(claimed.code).toBe(ExitCode.OK);

    // Симулируем "аренда истекла два с половиной часа назад" напрямую в
    // базе: быстрее и не хрупко к реальным таймингам CI, чем ждать TTL.
    const raw = new Database(db);
    raw.run("UPDATE nodes SET lease_expires = ?1 WHERE id = ?2", [
      Date.now() - 2.5 * 60 * 60_000,
      id,
    ]);
    raw.close();

    const listedJson = await myc("rescuer", "ready", "--json");
    expect(listedJson.code).toBe(ExitCode.OK);
    const readyOut = JSON.parse(listedJson.stdout as string) as {
      data: { items: Array<{ id: string; expired_lease?: { holder: string; expires_at: number } }> };
    };
    const item = readyOut.data.items.find((i) => i.id === id);
    expect(item).toBeDefined();
    expect(item!.expired_lease?.holder).toBe("dead-agent");

    const listedHuman = await myc("rescuer", "ready");
    expect(listedHuman.stdout as string).toContain("EXPIRED @dead-agent");
    expect(listedHuman.stdout as string).toContain("назад");

    const claimBack = await myc("rescuer", "ready", "--claim", "--json");
    expect(claimBack.code).toBe(ExitCode.OK);
    const claimedData = JSON.parse(claimBack.stdout as string) as {
      data: { claimed?: { id: string; holder: string } };
    };
    expect(claimedData.data.claimed?.id).toBe(id);
    expect(claimedData.data.claimed?.holder).toBe("rescuer");
  });
});
