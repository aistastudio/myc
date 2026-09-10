/**
 * Очередь `myc run` в одном процессе: предикат выдачи, FIFO, слоты, уборка
 * мёртвых и устаревших, ограждение держателем. То, что живёт между
 * процессами (SIGKILL держателя, сигналы, коды выхода, два MYC_HOME), — в
 * commands/run.multiprocess.test.ts на настоящих Bun.spawn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueue,
  getTicket,
  heldLanes,
  isValidLane,
  listLane,
  liveness,
  mintHolder,
  openQueue,
  openQueueIfExists,
  queueDbPath,
  QUEUE_SCHEMA_VERSION,
  reap,
  release,
  renew,
  setChild,
  slotsEnvName,
  slotsFor,
  StaleWatch,
  staleWindowMs,
  tryGrant,
  withHeldLane,
  type TicketInput,
  type TicketRow,
} from "./run-queue.ts";
import { commandLine, fmtDuration, parseWait } from "./commands/run.ts";
import { QUEUE_MIGRATIONS } from "./migrations/run-queue.ts";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-run-queue-"));
  db = openQueue(join(dir, ".myc", "queue.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HOST = "test-host";
let nextPid = 50_000;

function input(extra: Partial<TicketInput> = {}): TicketInput {
  return {
    lane: "heavy",
    argv: ["bun", "test"],
    cwd: "/work",
    pid: nextPid++,
    host: HOST,
    session: "",
    terminal: "",
    agentPid: null,
    actor: "",
    ...extra,
  };
}

function put(extra: Partial<TicketInput> = {}, slots = 1, now = 1_000): TicketRow {
  const i = input(extra);
  return enqueue(db, i, mintHolder(i.host, i.pid), slots, 30_000, now);
}

const allAlive = (): boolean => true;

describe("постановка и выдача", () => {
  test("пустая полоса: билет рождается выполняющимся одним стейтментом", () => {
    const t = put();
    expect(t.state).toBe("running");
    expect(t.started_at).toBe(1_000);
    expect(t.lease_expires).toBe(31_000);
  });

  test("слот занят: следующий ждёт, выдача ему — только после снятия держателя", () => {
    const a = put();
    const b = put();
    expect(b.state).toBe("waiting");
    expect(tryGrant(db, b, 1, 30_000, 2_000)).toBeUndefined();
    expect(release(db, a)).toBe(true);
    const granted = tryGrant(db, b, 1, 30_000, 3_000);
    expect(granted?.state).toBe("running");
    expect(granted?.started_at).toBe(3_000);
  });

  test("FIFO: освободившийся слот получает первый в очереди, даже если второй спросил раньше", () => {
    const a = put();
    const b = put();
    const c = put();
    release(db, a);
    // Третий опрашивает первым — и не получает: впереди него ждёт второй.
    expect(tryGrant(db, c, 1, 30_000)).toBeUndefined();
    expect(tryGrant(db, b, 1, 30_000)?.state).toBe("running");
    expect(tryGrant(db, c, 1, 30_000)).toBeUndefined();
    release(db, b);
    expect(tryGrant(db, c, 1, 30_000)?.state).toBe("running");
  });

  test("два слота: двое выполняются, третий ждёт; уход любого пускает третьего", () => {
    const a = put({}, 2);
    const b = put({}, 2);
    const c = put({}, 2);
    expect([a.state, b.state, c.state]).toEqual(["running", "running", "waiting"]);
    release(db, b);
    expect(tryGrant(db, c, 2, 30_000)?.state).toBe("running");
  });

  test("выдача ограждена держателем: чужим holder свой билет не получить", () => {
    const a = put();
    const b = put();
    release(db, a);
    expect(tryGrant(db, { ...b, holder: "someone-else" }, 1, 30_000)).toBeUndefined();
    expect(getTicket(db, b)?.state).toBe("waiting");
  });

  test("полосы независимы: занятая heavy не держит bench", () => {
    put({ lane: "heavy" });
    expect(put({ lane: "bench" }).state).toBe("running");
    expect(put({ lane: "heavy" }).state).toBe("waiting");
  });

  test("снятие и продление ограждены держателем", () => {
    const a = put();
    expect(release(db, { id: a.id, holder: "zombie" })).toBe(false);
    expect(renew(db, { id: a.id, holder: "zombie" }, 5_000)).toBe(false);
    expect(renew(db, a, 5_000)).toBe(true);
    expect(getTicket(db, a)?.lease_expires).toBe(35_000);
    expect(release(db, a)).toBe(true);
    expect(renew(db, a, 6_000)).toBe(false);
  });
});

describe("живость и уборка", () => {
  test("pid этой машины мёртв — билет мёртв сразу, аренда не важна", () => {
    const row = { pid: 1, host: HOST, lease_expires: 99_000 };
    expect(liveness(row, 1_000, HOST, () => false)).toBe("dead");
    expect(liveness(row, 1_000, HOST, allAlive)).toBe("alive");
    expect(liveness(row, 100_000, HOST, allAlive)).toBe("stale");
  });

  test("pid чужой машины не проверяется: только аренда", () => {
    const row = { pid: 1, host: "other", lease_expires: 99_000 };
    expect(liveness(row, 1_000, HOST, () => false)).toBe("alive");
    expect(liveness(row, 100_000, HOST, () => false)).toBe("stale");
  });

  test("уборка снимает мёртвого держателя, и следующий получает слот", () => {
    const a = put();
    const b = put();
    const dead = new Set([a.pid]);
    const { removed, rows } = reap(db, "heavy", { now: 2_000, host: HOST, probe: (pid) => !dead.has(pid) });
    expect(removed.map((r) => [r.id, r.reason])).toEqual([[a.id, "dead"]]);
    expect(rows.map((r) => r.id)).toEqual([b.id]);
    expect(tryGrant(db, b, 1, 30_000)?.state).toBe("running");
  });

  test("мёртвый держатель с живой командой снимается, но помечен сиротой", () => {
    const a = put();
    const b = put();
    setChild(db, a, 777);
    setChild(db, b, 888);
    const alive = new Set([777]); // оба держателя мертвы, жива только команда первого
    const { removed } = reap(db, "heavy", { now: 2_000, host: HOST, probe: (pid) => alive.has(pid) });
    expect(removed.map((r) => [r.id, r.child_pid, r.orphan])).toEqual([
      [a.id, 777, true],
      [b.id, 888, false],
    ]);
  });

  test("свой билет уборка не трогает никогда", () => {
    const a = put();
    const { removed } = reap(db, "heavy", { now: 2_000, host: HOST, probe: () => false, selfId: a.id });
    expect(removed).toEqual([]);
    expect(listLane(db, "heavy").map((r) => r.id)).toEqual([a.id]);
  });

  test("устаревший (аренда вышла, pid жив) без наблюдателя не снимается — только виден", () => {
    const a = put();
    const { removed, rows } = reap(db, "heavy", { now: 100_000, host: HOST, probe: allAlive });
    expect(removed).toEqual([]);
    expect(liveness(rows[0]!, 100_000, HOST, allAlive)).toBe("stale");
    expect(getTicket(db, a)).toBeDefined();
  });

  test("наблюдатель снимает устаревший, только увидев его без продления целое окно", () => {
    const a = put();
    let clock = 0;
    const watch = new StaleWatch(() => clock);
    const opts = { now: 100_000, host: HOST, probe: allAlive, watch };
    expect(reap(db, "heavy", opts).removed).toEqual([]); // начало наблюдения
    clock = staleWindowMs(30_000) - 1;
    expect(reap(db, "heavy", opts).removed).toEqual([]);
    clock = staleWindowMs(30_000);
    expect(reap(db, "heavy", opts).removed.map((r) => [r.id, r.reason])).toEqual([[a.id, "stale"]]);
  });

  test("продлился во время наблюдения (проснулся ноутбук) — наблюдение сначала, билет жив", () => {
    const a = put();
    let clock = 0;
    const watch = new StaleWatch(() => clock);
    reap(db, "heavy", { now: 100_000, host: HOST, probe: allAlive, watch });
    clock = staleWindowMs(30_000) - 5;
    // Держатель проснулся и продлился — но и после продления его аренда в
    // прошлом по часам наблюдателя (часы прыгнули у всех).
    renew(db, a, 60_000);
    clock = staleWindowMs(30_000) + 10;
    expect(reap(db, "heavy", { now: 100_000, host: HOST, probe: allAlive, watch }).removed).toEqual([]);
    clock = 2 * staleWindowMs(30_000) + 10;
    expect(reap(db, "heavy", { now: 100_000, host: HOST, probe: allAlive, watch }).removed).toHaveLength(1);
  });

  test("снятие устаревшего огорожено сроком: продление между чтением и удалением спасает", () => {
    const a = put();
    let clock = 0;
    const watch = new StaleWatch(() => clock);
    reap(db, "heavy", { now: 100_000, host: HOST, probe: allAlive, watch });
    clock = staleWindowMs(30_000);
    // Наблюдатель считает билет досмотренным по СТАРОМУ lease_expires; строка в
    // базе уже продлена — удаление по (id, holder, lease_expires) не проходит.
    const stale = { ...getTicket(db, a)! };
    renew(db, a, 90_000);
    expect(watch.expired(stale)).toBe(true);
    const { removed } = reap(db, "heavy", { now: 100_000, host: HOST, probe: allAlive, watch });
    expect(removed).toEqual([]);
    expect(getTicket(db, a)).toBeDefined();
  });
});

describe("хранилище", () => {
  test("queue.db лежит в личном ярусе: ~/.myc, MYC_HOME переносит", () => {
    expect(queueDbPath("/h")).toBe("/h/.myc/queue.db");
  });

  test("схема версионирована; повторное открытие ничего не ломает", () => {
    const path = join(dir, ".myc", "queue.db");
    const again = openQueue(path);
    expect((again.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      QUEUE_SCHEMA_VERSION,
    );
    again.close();
  });

  test("миграции: версии растут строго, последняя = QUEUE_SCHEMA_VERSION, объекты на месте", () => {
    const versions = QUEUE_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.at(-1)).toBe(QUEUE_SCHEMA_VERSION);
    const objects = db
      .query("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ type: string; name: string }>;
    expect(objects).toEqual([
      { type: "index", name: "ix_run_queue_lane" },
      { type: "table", name: "run_queue" },
    ]);
  });

  test("база новее этой сборки — громкий отказ, а не молчаливая порча", () => {
    const path = join(dir, "newer.db");
    const d = openQueue(path);
    d.exec(`PRAGMA user_version = ${QUEUE_SCHEMA_VERSION + 1}`);
    d.close();
    expect(() => openQueue(path)).toThrow(/newer myc/);
  });

  test("openQueueIfExists не создаёт файл", () => {
    expect(openQueueIfExists(join(dir, "absent", "queue.db"))).toBeUndefined();
  });
});

describe("настройки и разбор", () => {
  test("слоты: MYC_<ПОЛОСА>_SLOTS, умолчание 1, мусор — умолчание с причиной", () => {
    expect(slotsEnvName("heavy")).toBe("MYC_HEAVY_SLOTS");
    expect(slotsEnvName("gpu-bench")).toBe("MYC_GPU_BENCH_SLOTS");
    expect(slotsFor("heavy", {})).toEqual({ slots: 1, source: "default" });
    expect(slotsFor("heavy", { MYC_HEAVY_SLOTS: "3" })).toEqual({ slots: 3, source: "env" });
    expect(slotsFor("heavy", { MYC_HEAVY_SLOTS: "0" }).invalid).toBe("MYC_HEAVY_SLOTS=0");
    expect(slotsFor("heavy", { MYC_HEAVY_SLOTS: "two" }).slots).toBe(1);
  });

  test("имя полосы", () => {
    expect(isValidLane("heavy")).toBe(true);
    expect(isValidLane("gpu-bench2")).toBe(true);
    expect(isValidLane("Heavy")).toBe(false);
    expect(isValidLane("a b")).toBe(false);
    expect(isValidLane("")).toBe(false);
  });

  test("--max-wait: единицы, голое число — секунды, мусор — undefined", () => {
    expect(parseWait("5m")).toBe(300_000);
    expect(parseWait("90s")).toBe(90_000);
    expect(parseWait("1.5h")).toBe(5_400_000);
    expect(parseWait("250ms")).toBe(250);
    expect(parseWait("30")).toBe(30_000);
    expect(parseWait("0")).toBe(0);
    expect(parseWait("-1s")).toBeUndefined();
    expect(parseWait("soon")).toBeUndefined();
  });

  test("вложенный myc run: полоса предка в MYC_RUN_HELD", () => {
    const env = withHeldLane({ MYC_RUN_HELD: "bench" }, "heavy");
    expect([...heldLanes(env)].sort()).toEqual(["bench", "heavy"]);
    expect(heldLanes({}).size).toBe(0);
  });

  test("отрисовка команды и длительности", () => {
    expect(commandLine(["bun", "test", "--timeout", "5000"])).toBe("bun test --timeout 5000");
    expect(commandLine(["sh", "-c", "exit 3"])).toBe("sh -c 'exit 3'");
    expect(commandLine(["/Users/me/.bun/bin/bun", "/private/var/folders/xy/T/build.ts", "--out=dist/"])).toBe(
      "bun …/build.ts --out=dist/",
    );
    expect(commandLine(["bun", "run", "scripts/build.ts"])).toBe("bun run scripts/build.ts");
    expect(commandLine(["x".repeat(100)], 10)).toHaveLength(10);
    expect(fmtDuration(400)).toBe("0.4s");
    expect(fmtDuration(12_000)).toBe("12s");
    expect(fmtDuration(250_000)).toBe("4m10s");
    expect(fmtDuration(300_000)).toBe("5m");
    expect(fmtDuration(3_720_000)).toBe("1h02m");
  });
});
