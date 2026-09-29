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
import { collectTop, createReadyCommand, readyQueries } from "./ready.ts";
import {
  createClaimCommand,
  createCreateCommand,
  createEpicCommand,
  createTaskCommand,
} from "./tasks.ts";
import { createDepCommand } from "./dep.ts";
import { createShowCommand } from "./show.ts";
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
      mycDir: join(dir, ".myc"),
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
      mycDir: join(dir, ".myc"),
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
  r.register(createEpicCommand());
  r.register(createClaimCommand());
  r.register(createReadyCommand());
  r.register(createDepCommand());
  r.register(createShowCommand());
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

  /**
   * Наследование блокеров вниз по `parent` (миграция 10). Проверяется не
   * счётчик (это делает store-sqlite/anc-blockers.test.ts), а ПОВЕДЕНИЕ
   * команды: что выдаёт очередь и что она об этом ГОВОРИТ.
   *
   * Числа взяты с настоящего снимка ~/src/cherry (796 задач): там прежнее
   * правило давало 195 задач против 144 у `bd ready`, а все 51 «лишние» —
   * потомки заблокированных эпиков. Здесь та же форма в миниатюре.
   */
  test("эпик не в очереди по умолчанию, но виден по явному --kind epic", async () => {
    // memory-ghbe6hg7xm9e: дверь к вехам закрывать нельзя — по умолчанию
    // очередь отвечает «что взять в работу», а веху взять нельзя.
    const epic = idOf((await myc("agent", "epic", "M0 — веха", "-p", "P0")).stdout);
    const work = idOf((await myc("agent", "task", "настоящая работа", "-p", "P2")).stdout);

    const plain = (await myc("agent", "--json", "ready")).stdout as string;
    const items = (JSON.parse(plain).data.items as Array<{ id: string }>).map((i) => i.id);
    expect(items).toContain(work);
    expect(items).not.toContain(epic);

    // И под ДРУГИМ фильтром его тоже нет: путь с фильтрами отдельный, и
    // «не в очереди» обязано значить одно и то же на обоих.
    const byPri = (await myc("agent", "--json", "ready", "--priority", "P0")).stdout as string;
    expect((JSON.parse(byPri).data.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(
      epic,
    );

    const byKind = (await myc("agent", "--json", "ready", "--kind", "epic")).stdout as string;
    const epics = (JSON.parse(byKind).data.items as Array<{ id: string }>).map((i) => i.id);
    expect(epics).toEqual([epic]);
  });

  test("эпик берётся поимённо: запрета на claim по id нет", async () => {
    const epic = idOf((await myc("agent", "epic", "M1 — веха")).stdout);
    const taken = await myc("agent", "claim", epic);
    expect(taken.code).toBe(ExitCode.OK);
  });

  test("подзадачи заблокированного эпика уходят из очереди, и подвал это НАЗЫВАЕТ", async () => {
    const epic = idOf((await myc("agent", "task", "эпик")).stdout);
    const kid1 = idOf((await myc("agent", "task", "подзадача 1", "--parent", epic)).stdout);
    const kid2 = idOf((await myc("agent", "task", "подзадача 2", "--parent", epic)).stdout);
    const blocker = idOf((await myc("agent", "task", "предусловие эпика")).stdout);

    const before = JSON.parse((await myc("agent", "ready", "--json")).stdout as string) as {
      data: { ready: number; blocked: number; blocked_by_ancestor: number };
    };
    expect(before.data.ready).toBe(4);
    expect(before.data.blocked_by_ancestor).toBe(0);

    expect((await myc("agent", "dep", "add", blocker, "blocks", epic)).code).toBe(ExitCode.OK);

    const after = JSON.parse((await myc("agent", "ready", "--json")).stdout as string) as {
      data: { ready: number; blocked: number; blocked_by_ancestor: number; items: Array<{ id: string }> };
    };
    // Осталась одна задача — сам блокер. Эпик убран своим блокером, обе
    // подзадачи — наследованием.
    expect(after.data.ready).toBe(1);
    expect(after.data.items.map((i) => i.id)).toEqual([blocker]);
    expect(after.data.blocked).toBe(1);
    expect(after.data.blocked_by_ancestor).toBe(2);

    // И2: число обязано быть НАЗВАНО, иначе две задачи исчезают молча.
    const human = (await myc("agent", "ready")).stdout as string;
    expect(human).toContain("3 blocked (2 via ancestor)");

    // А `myc show` обязан назвать виновника: в собственных deps подзадачи
    // блокера нет вовсе, и без этой строки искать его негде.
    const shown = (await myc("agent", "show", kid1)).stdout as string;
    expect(shown).toContain("blocker on ancestor");
    expect(shown).toContain(epic);

    // Снятие блокера возвращает поддерево целиком.
    expect((await myc("agent", "dep", "rm", blocker, "blocks", epic)).code).toBe(ExitCode.OK);
    const back = JSON.parse((await myc("agent", "ready", "--json")).stdout as string) as {
      data: { ready: number; blocked_by_ancestor: number };
    };
    expect(back.data.ready).toBe(4);
    expect(back.data.blocked_by_ancestor).toBe(0);
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
    expect(listedHuman.stdout as string).toContain("ago");

    const claimBack = await myc("rescuer", "ready", "--claim", "--json");
    expect(claimBack.code).toBe(ExitCode.OK);
    const claimedData = JSON.parse(claimBack.stdout as string) as {
      data: { claimed?: { id: string; holder: string } };
    };
    expect(claimedData.data.claimed?.id).toBe(id);
    expect(claimedData.data.claimed?.holder).toBe("rescuer");
  });
});

// ---------------------------------------------------------------------------
// memory-ghbe6hg7xm9e: эпик — контейнер вехи, а не работа
// ---------------------------------------------------------------------------

/**
 * Приёмка бага: агент захватывал эпик вместо работы, а строка статуса
 * показывала объём очереди больше настоящего. Проверяется именно ЗАХВАТ:
 * эпик свободен, дети свободны, и очередь обязана отдать ребёнка.
 */
describe("очередь не выдаёт эпики", () => {
  let dir: string;
  let driver: CliDriver;
  let handle: StoreHandle;
  let epicId: string;
  let kidId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "myc-ready-epic-"));
    driver = openDriver(join(dir, "myc.db"));
    await migrate(driver.database, { migrations, writable: true });
    const store = new GraphStore(driver, {
      newId: generateId,
      actor: "agent",
      siteId: "siteA",
      clock: new HlcClock(),
    });
    const claims = new Claims(store, { holder: "agent" });
    handle = {
      driver,
      store,
      claims,
      actor: "agent",
      scope: "s",
      slug: "s",
      wsDir: dir,
      mycDir: join(dir, ".myc"),
      repo: { repo: "", reason: "", from: dir },
      weights: DEFAULT_READY_WEIGHTS,
      vec0: driver.vec0,
      vec0Reason: driver.vec0Reason,
      close: () => driver.close(),
    };
    // Эпик стоит ВЫШЕ ребёнка по приоритету: без отсева он и оказывался
    // первым, а балл типа 0.25 его только притормаживал.
    epicId = store.createNode({
      kind: "task",
      scope: "s",
      title: "M0 — веха",
      priority: 0,
      attrs: { type: "epic" },
    }).id;
    kidId = store.createNode({
      kind: "task",
      scope: "s",
      title: "настоящая работа",
      priority: 2,
      attrs: { type: "task" },
    }).id;
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("очередь отдаёт ребёнка, а не контейнер вехи", () => {
    const { items } = collectTop(handle, 10, Date.now());
    expect(items.map((i) => i.id)).toEqual([kidId]);
    expect(items.map((i) => i.id)).not.toContain(epicId);
  });

  test("эпик не входит и в ЧИСЛО готовых — по нему человек читает объём работы", () => {
    const { total } = collectTop(handle, 10, Date.now());
    expect(total).toBe(1);
  });

  test("брошенный эпик не возвращается в очередь арендой", () => {
    const ticket = handle.claims.claim(epicId, 1);
    expect(ticket).toBeDefined();
    const after = Date.now() + 60_000;
    const { items, total } = collectTop(handle, 10, after);
    expect(items.map((i) => i.id)).not.toContain(epicId);
    expect(total).toBe(1);
  });

  test("план запроса очереди по-прежнему индексный, а не скан", () => {
    // Отсев обязан быть БЕСПЛАТНЫМ: он стоит в предикате частичного индекса,
    // и стоит там символ в символ. Разойдись тексты — SQLite уйдёт в скан, и
    // починка станет регрессией (замер 2026-09-25: 4.74 мс против бюджета 3).
    const q = readyQueries.ready_top_noanchors;
    const plan = driver.database
      .query(`EXPLAIN QUERY PLAN ${q.sql.replace(/\?(\d+)/g, "?")}`)
      .all("s", 0.4, 0.27, 0.14, 0.1, 0.09, 10, Date.now()) as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(" | ")).toMatch(
      /SEARCH n USING INDEX ix_nodes_ready_work \(scope=\?\)/,
    );
  });
});
