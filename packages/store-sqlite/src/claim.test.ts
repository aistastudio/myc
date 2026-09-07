import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlcClock, generateId } from "@myc/core";
import type { NodeInput } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, Q } from "./queries.ts";
import {
  Claims,
  ClaimTicket,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
} from "./claim.ts";
import { runClaimWorkers, type WorkerReport } from "./claim.harness.ts";

// ---------------------------------------------------------------------------
// Инфраструктура: ручные часы и хранилище на живой схеме миграций
// ---------------------------------------------------------------------------

/** Часы, которыми тест распоряжается сам: никакой зависимости от Date.now. */
function manualClock(startMs = 1_700_000_000_000) {
  const state = { t: startMs };
  return {
    now: () => state.t,
    advance: (ms: number) => {
      state.t += ms;
    },
  };
}

let dir: string;
let driver: SqliteDriver;
let store: GraphStore;
let clock: ReturnType<typeof manualClock>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-claim-"));
  driver = openSqlite(join(dir, "myc.db"));
  await migrate(driver.database, { migrations, writable: true });
  clock = manualClock();
  store = new GraphStore(driver, {
    siteId: "siteA",
    actor: "tester",
    newId: generateId,
    clock: new HlcClock({ now: clock.now }),
  });
});

afterEach(() => {
  try {
    driver?.close();
  } catch {
    // соединение уже закрыто тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

let taskSeq = 0;

function task(over: Partial<NodeInput> = {}) {
  taskSeq += 1;
  return store.createNode({
    kind: "task",
    scope: "s",
    title: over.title ?? `задача ${taskSeq}`,
    ...over,
  });
}

function claimRows(id: string): Array<{ op: string; field: string; value: string }> {
  return driver.database
    .query(
      "SELECT op, field, value FROM oplog WHERE entity_id = ?1 AND op = 'claim' ORDER BY seq",
    )
    .all(id) as Array<{ op: string; field: string; value: string }>;
}

// ---------------------------------------------------------------------------
// CAS-захват: один стейтмент, lease, epoch
// ---------------------------------------------------------------------------

describe("CAS-захват (§9.4)", () => {
  test("успешный захват одним стейтментом: статус, holder, epoch=1, lease и оплог", () => {
    const node = task();
    const receipt = store.claimNode(node.id, "agentA");
    expect(receipt).toBeDefined();
    expect(receipt!.holder).toBe("agentA");
    expect(receipt!.epoch).toBe(1);
    expect(receipt!.expiresAt - clock.now()).toBe(LEASE_TTL_MS);

    const lease = store.leaseOf(node.id)!;
    expect(lease.status).toBe("in_progress");
    expect(lease.holder).toBe("agentA");
    expect(lease.epoch).toBe(1);
    expect(lease.expires).toBe(receipt!.expiresAt);

    const rows = claimRows(node.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.op).toBe("claim");
    expect(rows[0]!.field).toBe("lease");
    expect(JSON.parse(rows[0]!.value)).toMatchObject({
      action: "claim",
      holder: "agentA",
      epoch: 1,
    });
  });

  test("второй захват под активным lease невозможен: CAS возвращает undefined", () => {
    const node = task();
    expect(store.claimNode(node.id, "agentA")).toBeDefined();
    expect(store.claimNode(node.id, "agentB")).toBeUndefined();
    expect(store.leaseOf(node.id)!.holder).toBe("agentA");
    // провалившийся захват не пишет в оплог
    expect(claimRows(node.id).length).toBe(1);
  });

  test("закрытая, заблокированная и удалённая задачи не захватываются", () => {
    const closed = task({ status: "closed" });
    expect(store.claimNode(closed.id, "agentA")).toBeUndefined();

    const blocked = task();
    const blocker = task({ title: "блокер" });
    store.addEdge(blocker.id, "blocks", blocked.id);
    expect(store.leaseOf(blocked.id)!.status).toBe("open");
    expect(store.claimNode(blocked.id, "agentA")).toBeUndefined();

    const deleted = task();
    store.deleteNode(deleted.id);
    expect(store.claimNode(deleted.id, "agentA")).toBeUndefined();
  });

  test("продление: только держатель с текущей эпохой; lease сдвигается на TTL", () => {
    const node = task();
    const receipt = store.claimNode(node.id, "agentA")!;
    clock.advance(300_000);

    expect(store.renewLease(node.id, "agentB", 1)).toBeUndefined();
    expect(store.renewLease(node.id, "agentA", 99)).toBeUndefined();
    const renewed = store.renewLease(node.id, "agentA", receipt.epoch);
    expect(renewed).toBeDefined();
    expect(renewed! - clock.now()).toBe(LEASE_TTL_MS);
    expect(store.leaseOf(node.id)!.expires).toBe(renewed!);
  });

  test("воскресший держатель с устаревшей эпохой не может ни продлить, ни закрыть, ни освободить", () => {
    const node = task();
    const stale = store.claimNode(node.id, "agentA")!;

    // Пока agentA «спал», lease истёк и задачу перезахватил agentB.
    clock.advance(LEASE_TTL_MS + 1);
    const fresh = store.claimNode(node.id, "agentB")!;
    expect(fresh.epoch).toBe(stale.epoch + 1);

    expect(store.renewLease(node.id, "agentA", stale.epoch)).toBeUndefined();
    expect(store.closeClaimed(node.id, "agentA", stale.epoch)).toBe(false);
    expect(store.releaseLease(node.id, "agentA", stale.epoch)).toBe(false);

    // Задача по-прежнему у agentB, и его операции работают.
    expect(store.leaseOf(node.id)!.holder).toBe("agentB");
    expect(store.renewLease(node.id, "agentB", fresh.epoch)).toBeDefined();
    expect(store.closeClaimed(node.id, "agentB", fresh.epoch)).toBe(true);
    expect(store.leaseOf(node.id)!.status).toBe("closed");
  });

  test("истёкший lease открывает задачу другим без всякого сборщика", () => {
    const node = task();
    store.claimNode(node.id, "agentA");
    expect(store.claimNode(node.id, "agentB")).toBeUndefined();

    clock.advance(LEASE_TTL_MS + 1);
    const stolen = store.claimNode(node.id, "agentB")!;
    expect(stolen.epoch).toBe(2);
    expect(store.leaseOf(node.id)!.holder).toBe("agentB");
  });

  test("явное освобождение: задача снова open, lease пуст, в оплоге action=release", () => {
    const node = task();
    const receipt = store.claimNode(node.id, "agentA")!;
    expect(store.releaseLease(node.id, "agentB", receipt.epoch)).toBe(false);

    expect(store.releaseLease(node.id, "agentA", receipt.epoch)).toBe(true);
    const lease = store.leaseOf(node.id)!;
    expect(lease.status).toBe("open");
    expect(lease.holder).toBe("");
    expect(lease.expires).toBe(0);

    const next = store.claimNode(node.id, "agentB")!;
    expect(next.epoch).toBe(receipt.epoch + 1);
    // release + повторный claim
    const actions = claimRows(node.id).map((r) => JSON.parse(r.value).action);
    expect(actions).toEqual(["claim", "release", "claim"]);
    // освобождение держателем с чужой эпохой в оплог не попадает
    expect(store.releaseLease(node.id, "agentA", receipt.epoch)).toBe(false);
    expect(claimRows(node.id).length).toBe(3);
  });

  test("закрытие задачи держателем: status=closed, lease очищен, повторный захват невозможен", () => {
    const node = task();
    const receipt = store.claimNode(node.id, "agentA")!;
    clock.advance(1000);
    expect(store.closeClaimed(node.id, "agentA", receipt.epoch)).toBe(true);

    const lease = store.leaseOf(node.id)!;
    expect(lease.status).toBe("closed");
    expect(lease.holder).toBe("");
    expect(lease.expires).toBe(0);
    expect(store.claimNode(node.id, "agentB")).toBeUndefined();

    const rows = claimRows(node.id);
    expect(JSON.parse(rows[1]!.value)).toMatchObject({
      action: "close",
      holder: "agentA",
      epoch: receipt.epoch,
    });
  });

  test("claimReady: батч-захват из ready останавливается на limit", () => {
    for (let i = 0; i < 5; i++) task({ title: `t${i}` });
    const claims = new Claims(store, { holder: "agentA" });
    const batch = claims.claimReady("s", 3);
    expect(batch.length).toBe(3);
    expect(new Set(batch.map((t) => t.id)).size).toBe(3);
    for (const t of batch) {
      expect(store.leaseOf(t.id)!.holder).toBe("agentA");
      expect(store.leaseOf(t.id)!.status).toBe("in_progress");
    }
    // вторая порция не пересекается с первой
    const second = claims.claimReady("s", 5).map((t) => t.id);
    expect(second.length).toBe(2);
    expect(second.some((id) => batch.some((t) => t.id === id))).toBe(false);
  });

  test("тикет: renew/release/close работают, пока эпоха наша, и умирают после перехвата", () => {
    const claims = new Claims(store, { holder: "agentA" });
    const ticket = claims.claim(task().id)!;
    expect(ticket).toBeInstanceOf(ClaimTicket);
    expect(ticket.renew()).toBe(true);
    expect(ticket.release()).toBe(true);

    const again = claims.claim(task().id)!;
    // Пока agentA «спал», lease истёк — agentB перехватывает задачу.
    clock.advance(LEASE_TTL_MS + 1);
    const rival = store.claimNode(again.id, "agentB")!;
    expect(rival).toBeDefined();
    expect(again.renew()).toBe(false);
    expect(again.close()).toBe(false);
    expect(again.alive()).toBe(false);
    expect(rival!.epoch).toBe(again.epoch + 1);
  });

  test("keepAlive продлевает lease каденцией LEASE_RENEW_MS и останавливается", async () => {
    // Отдельное хранилище на реальных часах: heartbeat живёт в стенном времени.
    const rtDir = mkdtempSync(join(tmpdir(), "myc-claim-rt-"));
    const rtDriver = openSqlite(join(rtDir, "rt.db"));
    try {
      await migrate(rtDriver.database, { migrations, writable: true });
      const rtStore = new GraphStore(rtDriver, {
        siteId: "siteA",
        actor: "tester",
        newId: generateId,
      });
      const node = rtStore.createNode({ kind: "task", scope: "s", title: "heartbeat" });
      const claims = new Claims(rtStore, { holder: "agentA" });
      const ticket = claims.claim(node.id, 400)!;
      const firstExpiry = ticket.expiresAt;
      const stop = ticket.keepAlive(50);
      await Bun.sleep(600);
      stop();
      expect(ticket.alive()).toBe(true);
      expect(ticket.expiresAt).toBeGreaterThan(firstExpiry);
      // после остановки heartbeat'а lease дотягивает до TTL и умирает
      await Bun.sleep(600);
      expect(ticket.alive()).toBe(false);
      expect(LEASE_RENEW_MS).toBeLessThan(LEASE_TTL_MS);
    } finally {
      rtDriver.close();
      rmSync(rtDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Мутационная проверка: сломанный CAS обязан ловиться
// ---------------------------------------------------------------------------

describe("мутационная проверка (анти-паттерн SELECT → UPDATE)", () => {
  test("двухшаговый захват создаёт двойное владение там, где CAS отказывает", () => {
    const broken = task({ title: "m1" });
    const head = store.getNode(broken.id); // шаг 1 мутанта: чтение и решение
    expect(head!.status).toBe("open");
    expect(store.claimNode(broken.id, "agentB")).toBeDefined(); // в «окне» забрали
    store.driver.tx("immediate", (tx) => {
      tx.run(Q.claim_twostep_node, [broken.id, "agentA"]); // шаг 2: запись без предиката
    });
    // Двойное владение: у задачи держатель agentA, хотя agentB тоже «победил».
    expect(store.leaseOf(broken.id)!.holder).toBe("agentA");
    expect(store.leaseOf(broken.id)!.epoch).toBe(2);

    const guarded = task({ title: "m2" });
    void store.getNode(guarded.id);
    expect(store.claimNode(guarded.id, "agentB")).toBeDefined();
    expect(store.claimNode(guarded.id, "agentA")).toBeUndefined(); // CAS отсекает
  });

  test("конкурентный прогон мутанта 8 процессами ловится детектором дублей", async () => {
    const tasks = 24;
    const { dbPath, store: raceSeeder, close } = await setupRace(tasks);
    try {
      const reports = await runClaimWorkers(dbPath, {
        processes: 8,
        claim: "twostep",
        batchSize: 8,
        go: () => {
          raceSeeder.driver.run(Q.meta_set, ["race_start", String(Date.now())]);
        },
      });
      const audit = auditReports(reports);
      // Мутант гарантированно даёт дубли: все процессы читают один и тот же
      // список кандидатов и пишут без предиката. Детектор обязан это видеть —
      // значит, основной конкурентный тест поймал бы подмену CAS на two-step.
      expect(audit.duplicates).toBeGreaterThan(0);
      console.log(
        `[mutation] twostep: захватов=${audit.totalWon}, уникальных задач=${audit.distinct}, ` +
          `двойных=${audit.duplicates}`,
      );
    } finally {
      close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Настоящая конкурентность: 8 процессов, 1000 задач, одна база
// ---------------------------------------------------------------------------

describe("настоящая конкурентность (8 процессов Bun.spawn, 1000 задач)", () => {
  test("ровно один захват на задачу: ноль потерянных, ноль двойных, p50/p99", async () => {
    const TASKS = 1000;
    const PROCESSES = 8;
    const { dbPath, driver: raceDriver, close } = await setupRace(TASKS);    try {
      const reports = await runClaimWorkers(dbPath, {
        processes: PROCESSES,
        claim: "cas",
        batchSize: 16,
        go: () => {
          raceDriver.run(Q.meta_set, ["race_start", String(Date.now())]);
        },
      });

      const audit = auditReports(reports);
      const wonBy = reports.map((r) => ({ holder: r.holder, won: r.won }));

      expect(audit.totalWon).toBe(TASKS); // ноль потерянных: каждая задача захвачена
      expect(audit.distinct).toBe(TASKS); // и ни одна не захвачена дважды
      expect(audit.duplicates).toBe(0);

      const db = raceDriver.database;
      const inProgress = db
        .query("SELECT count(*) AS n FROM nodes WHERE scope='s' AND status='in_progress'")
        .get() as { n: number };
      const badEpoch = db
        .query("SELECT count(*) AS n FROM nodes WHERE scope='s' AND (lease_epoch <> 1 OR lease_holder = '' OR lease_expires = 0)")
        .get() as { n: number };
      expect(inProgress.n).toBe(TASKS);
      expect(badEpoch.n).toBe(0);

      const latencies = reports.flatMap((r) => r.latencies);
      const p50 = percentile(latencies, 50);
      const p99 = percentile(latencies, 99);
      console.log(
        `[concurrency] процессов=${PROCESSES}, задач=${TASKS}; захватов=${audit.totalWon}, ` +
          `уникальных=${audit.distinct}, двойных=${audit.duplicates}; ` +
          `won by: ${wonBy.map((w) => `${w.holder}=${w.won}`).join(", ")}`,
      );
      console.log(
        `[concurrency] латентность захвата под конкуренцией: ` +
          `p50=${p50.toFixed(3)} мс, p99=${p99.toFixed(3)} мс (n=${latencies.length})`,
      );
    } finally {
      close();
    }
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Хелперы конкурентных прогонов
// ---------------------------------------------------------------------------

async function setupRace(tasks: number): Promise<{
  dir: string;
  dbPath: string;
  driver: SqliteDriver;
  store: GraphStore;
  close: () => void;
}> {
  const raceDir = mkdtempSync(join(tmpdir(), "myc-claim-race-"));
  const dbPath = join(raceDir, "race.db");
  const raceDriver = openSqlite(dbPath);
  await migrate(raceDriver.database, { migrations, writable: true });
  const seeder = new GraphStore(raceDriver, {
    siteId: "siteA",
    actor: "seeder",
    newId: generateId,
  });
  for (let i = 0; i < tasks; i++) {
    seeder.createNode({ kind: "task", scope: "s", title: `t${i}` });
  }
  return {
    dir: raceDir,
    dbPath,
    driver: raceDriver,
    store: seeder,
    close: () => {
      try {
        raceDriver.close();
      } finally {
        rmSync(raceDir, { recursive: true, force: true });
      }
    },
  };
}

function auditReports(reports: readonly WorkerReport[]): {
  totalWon: number;
  distinct: number;
  duplicates: number;
} {
  const ids = reports.flatMap((r) => r.ids);
  const totalWon = reports.reduce((acc, r) => acc + r.won, 0);
  const distinct = new Set(ids).size;
  return { totalWon, distinct, duplicates: totalWon - distinct };
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
