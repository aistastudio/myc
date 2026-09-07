import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import {
  COMPACT_JOB_KIND,
  WAL_JOB_ENTITY,
  dropWalCheckpointJob,
  enqueueWalCheckpointJob,
  walCheckpointJobPending,
} from "./checkpoint.ts";
import {
  DEFAULT_JOB_MAX_ATTEMPTS,
  JOB_BACKOFF_BASE_MS,
  JOB_BACKOFF_CAP_MS,
  JOB_PRIORITY,
  LEASE_EXPIRED_ERROR,
  claim,
  complete,
  enqueue,
  fail,
  get,
  stats,
  sweep,
  type JobRow,
} from "./jobs.ts";

// ---------------------------------------------------------------------------
// Инфраструктура
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

let dir: string;
let driver: SqliteDriver;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-jobs-"));
  driver = openSqlite(join(dir, "jobs.db"));
  await migrate(driver.database, { migrations, writable: true });
});

afterEach(() => {
  try {
    driver?.close();
  } catch {
    // уже закрыт тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

const db = (): import("bun:sqlite").Database => driver.database;

function rows(): JobRow[] {
  return db().query("SELECT * FROM jobs ORDER BY id").all() as JobRow[];
}

// ---------------------------------------------------------------------------
// Постановка
// ---------------------------------------------------------------------------

describe("постановка в очередь", () => {
  test("идемпотентна по (kind, entity_id): вторая постановка возвращает ту же строку", () => {
    const first = enqueue(db(), "embed", { entityId: "n1", scope: "s", now: T0 });
    const second = enqueue(db(), "embed", { entityId: "n1", scope: "s", now: T0 + 5_000 });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(rows()).toHaveLength(1);
    // Повтор не сдвигает ни created_at, ни run_after: очередь уже знает о работе.
    expect(second.row.created_at).toBe(T0);
    expect(second.row.run_after).toBe(T0);
  });

  test("тот же entity_id в другом классе работ — другая строка", () => {
    enqueue(db(), "embed", { entityId: "n1", now: T0 });
    const other = enqueue(db(), "distill", { entityId: "n1", now: T0 });
    expect(other.inserted).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  test("без entity_id дедупликации нет — частичный индекс NULL не покрывает", () => {
    const a = enqueue(db(), "rescore", { now: T0 });
    const b = enqueue(db(), "rescore", { now: T0 });
    expect(a.inserted && b.inserted).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(rows()).toHaveLength(2);
  });

  test("приоритет берётся из класса работ: эмбеддинги > дистилляция > приоры роя (S7)", () => {
    const e = enqueue(db(), "embed", { entityId: "a", now: T0 }).row;
    const d = enqueue(db(), "distill", { entityId: "a", now: T0 }).row;
    const r = enqueue(db(), "rescore", { entityId: "a", now: T0 }).row;
    expect(e.priority).toBeLessThan(d.priority);
    expect(d.priority).toBeLessThan(r.priority);
    expect(e.priority).toBe(JOB_PRIORITY["embed"]!);
    // Явный приоритет перебивает класс.
    expect(enqueue(db(), "embed", { entityId: "b", priority: 0, now: T0 }).row.priority).toBe(0);
  });

  test("payload-объект сериализуется, умолчания совпадают со схемой", () => {
    const row = enqueue(db(), "absorb", {
      entityId: "n7",
      payload: { op: "classify", batch: 8 },
      now: T0,
    }).row;
    expect(JSON.parse(row.payload)).toEqual({ op: "classify", batch: 8 });
    expect(row.max_attempts).toBe(DEFAULT_JOB_MAX_ATTEMPTS);
    expect(row.attempts).toBe(0);
    expect(row.lease_holder).toBe("");
    expect(row.lease_expires).toBe(0);
    expect(row.last_error).toBeNull();
  });

  test("run_after в будущем: работа стоит, но не выдаётся", () => {
    enqueue(db(), "embed", { entityId: "later", runAfter: T0 + 10_000, now: T0 });
    expect(claim(db(), [], "w1", { now: T0 })).toHaveLength(0);
    expect(claim(db(), [], "w1", { now: T0 + 10_000 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Захват
// ---------------------------------------------------------------------------

describe("захват под аренду", () => {
  test("выдача по приоритету, затем по run_after, затем по id", () => {
    enqueue(db(), "rescore", { entityId: "r", now: T0 });
    enqueue(db(), "embed", { entityId: "e2", runAfter: T0 - 1, now: T0 });
    enqueue(db(), "embed", { entityId: "e1", runAfter: T0 - 2, now: T0 });
    enqueue(db(), "distill", { entityId: "d", now: T0 });
    const got = claim(db(), [], "w1", { now: T0, limit: 4 });
    expect(got.map((r) => r.entity_id)).toEqual(["e1", "e2", "d", "r"]);
  });

  test("аренда проставлена, второй захват под живой арендой ничего не даёт", () => {
    enqueue(db(), "embed", { entityId: "n1", now: T0 });
    const got = claim(db(), ["embed"], "w1", { now: T0, leaseMs: 30_000 });
    expect(got).toHaveLength(1);
    expect(got[0]!.lease_holder).toBe("w1");
    expect(got[0]!.lease_expires).toBe(T0 + 30_000);
    expect(got[0]!.attempts).toBe(0);
    expect(claim(db(), ["embed"], "w2", { now: T0 + 29_999 })).toHaveLength(0);
  });

  test("просроченная аренда отдаётся другому и засчитывается как попытка", () => {
    enqueue(db(), "embed", { entityId: "n1", now: T0 });
    claim(db(), ["embed"], "w1", { now: T0, leaseMs: 1_000 });
    const stolen = claim(db(), ["embed"], "w2", { now: T0 + 1_000 });
    expect(stolen).toHaveLength(1);
    expect(stolen[0]!.lease_holder).toBe("w2");
    // Иначе работа, роняющая процесс, каталась бы по кругу вечно.
    expect(stolen[0]!.attempts).toBe(1);
  });

  test("max_attempts=1: просроченная аренда больше не выдаётся, строка остаётся", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", maxAttempts: 1, now: T0 }).id;
    expect(claim(db(), [], "w1", { now: T0, leaseMs: 1_000 })).toHaveLength(1);
    expect(claim(db(), [], "w2", { now: T0 + 5_000 })).toHaveLength(0);
    expect(get(db(), id)).toBeDefined();
  });

  test("фильтр по видам и limit", () => {
    for (let i = 0; i < 5; i++) enqueue(db(), "embed", { entityId: `e${i}`, now: T0 });
    for (let i = 0; i < 5; i++) enqueue(db(), "compact", { entityId: `c${i}`, now: T0 });
    const only = claim(db(), ["compact"], "w1", { now: T0, limit: 10 });
    expect(only).toHaveLength(5);
    expect(only.every((r) => r.kind === "compact")).toBe(true);
    const two = claim(db(), ["embed"], "w2", { now: T0, limit: 2 });
    expect(two).toHaveLength(2);
    expect(claim(db(), ["embed"], "w3", { now: T0, limit: 99 })).toHaveLength(3);
  });

  test("пустой список видов означает «любой», пустой holder запрещён", () => {
    enqueue(db(), "sync", { entityId: "x", now: T0 });
    expect(() => claim(db(), [], "", { now: T0 })).toThrow();
    expect(claim(db(), [], "w1", { now: T0 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Завершение и провал
// ---------------------------------------------------------------------------

describe("завершение и провал", () => {
  test("complete снимает строку; ограждение арендой не даёт зомби снять чужую работу", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", now: T0 }).id;
    claim(db(), [], "w1", { now: T0, leaseMs: 1_000 });
    // w1 «умер», работу забрал w2 — снятие от имени w1 обязано провалиться.
    claim(db(), [], "w2", { now: T0 + 1_000 });
    expect(complete(db(), id, "w1")).toBe(false);
    expect(get(db(), id)).toBeDefined();
    expect(complete(db(), id, "w2")).toBe(true);
    expect(get(db(), id)).toBeUndefined();
    expect(complete(db(), id, "w2")).toBe(false);
  });

  test("fail НЕ удаляет строку: попытка засчитана, ошибка сохранена, аренда снята", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", now: T0 }).id;
    claim(db(), [], "w1", { now: T0, leaseMs: 60_000 });
    const res = fail(db(), id, "эмбеддер недоступен", { now: T0 + 100 })!;
    expect(res.attempts).toBe(1);
    expect(res.dead).toBe(false);
    const row = get(db(), id)!;
    expect(row.last_error).toBe("эмбеддер недоступен");
    expect(row.lease_holder).toBe("");
    expect(row.lease_expires).toBe(0);
    expect(rows()).toHaveLength(1);
  });

  test("откат экспоненциальный и с потолком", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", maxAttempts: 40, now: T0 }).id;
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = fail(db(), id, "boom", { now: T0 })!;
      delays.push(r.runAfter - T0);
    }
    expect(delays.slice(0, 4)).toEqual([
      JOB_BACKOFF_BASE_MS,
      JOB_BACKOFF_BASE_MS * 2,
      JOB_BACKOFF_BASE_MS * 4,
      JOB_BACKOFF_BASE_MS * 8,
    ]);
    expect(delays[delays.length - 1]).toBe(JOB_BACKOFF_CAP_MS);
    expect(delays.every((d, i) => i === 0 || d >= delays[i - 1]!)).toBe(true);
  });

  test("исчерпав попытки, работа мертва: не выдаётся, но строка с ошибкой на месте", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", maxAttempts: 2, now: T0 }).id;
    expect(fail(db(), id, "раз", { now: T0 })!.dead).toBe(false);
    const last = fail(db(), id, "два", { now: T0 })!;
    expect(last.dead).toBe(true);
    expect(last.attempts).toBe(2);
    // Терминальное состояние — но не потеря: диагностировать нечем иначе.
    const row = get(db(), id)!;
    expect(row.last_error).toBe("два");
    expect(claim(db(), [], "w1", { now: T0 + JOB_BACKOFF_CAP_MS * 10 })).toHaveLength(0);
    expect(stats(db(), T0).dead).toBe(1);
  });

  test("fail с чужой арендой не проходит", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", now: T0 }).id;
    claim(db(), [], "w1", { now: T0, leaseMs: 60_000 });
    expect(fail(db(), id, "boom", { holder: "w2", now: T0 })).toBeUndefined();
    expect(get(db(), id)!.attempts).toBe(0);
    expect(fail(db(), id, "boom", { holder: "w1", now: T0 })!.attempts).toBe(1);
  });

  test("повторная постановка после провала не плодит строк и не теряет ошибку", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", now: T0 }).id;
    fail(db(), id, "boom", { now: T0 });
    const again = enqueue(db(), "embed", { entityId: "n1", now: T0 + 1 });
    expect(again.inserted).toBe(false);
    expect(again.row.attempts).toBe(1);
    expect(again.row.last_error).toBe("boom");
    expect(rows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Возврат брошенных аренд
// ---------------------------------------------------------------------------

describe("sweep просроченных аренд", () => {
  test("брошенная аренда возвращается в очередь с попыткой и причиной", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", now: T0 }).id;
    claim(db(), [], "dead-worker", { now: T0, leaseMs: 1_000 });
    expect(sweep(db(), T0 + 500)).toMatchObject({ released: 0, dead: 0 });
    const swept = sweep(db(), T0 + 1_000);
    expect(swept).toMatchObject({ released: 1, dead: 0, ids: [id] });
    const row = get(db(), id)!;
    expect(row.lease_holder).toBe("");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe(LEASE_EXPIRED_ERROR);
    expect(row.run_after).toBe(T0 + 1_000 + JOB_BACKOFF_BASE_MS);
  });

  test("живые аренды и свободные строки sweep не трогает", () => {
    enqueue(db(), "embed", { entityId: "free", now: T0 });
    enqueue(db(), "embed", { entityId: "busy", now: T0 });
    claim(db(), [], "w1", { now: T0, leaseMs: 60_000, limit: 1 });
    expect(sweep(db(), T0 + 1_000).released).toBe(0);
    expect(rows().filter((r) => r.attempts > 0)).toHaveLength(0);
  });

  test("sweep доводит до терминального состояния и не удаляет строку", () => {
    const id = enqueue(db(), "embed", { entityId: "n1", maxAttempts: 1, now: T0 }).id;
    claim(db(), [], "w1", { now: T0, leaseMs: 100 });
    const swept = sweep(db(), T0 + 100);
    expect(swept).toMatchObject({ released: 1, dead: 1 });
    expect(get(db(), id)!.attempts).toBe(1);
    expect(stats(db(), T0 + 100).dead).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Сводка
// ---------------------------------------------------------------------------

describe("сводка очереди", () => {
  test("по видам: ждёт, готово сейчас, в аренде, мертво", () => {
    for (let i = 0; i < 4; i++) enqueue(db(), "embed", { entityId: `e${i}`, now: T0 });
    enqueue(db(), "distill", { entityId: "d1", now: T0 });
    const dead = enqueue(db(), "distill", { entityId: "d2", maxAttempts: 1, now: T0 }).id;
    fail(db(), dead, "boom", { now: T0 });
    claim(db(), ["embed"], "w1", { now: T0, leaseMs: 60_000, limit: 2 });
    const later = enqueue(db(), "embed", { entityId: "later", runAfter: T0 + 60_000, now: T0 }).id;
    expect(later).toBeGreaterThan(0);

    const s = stats(db(), T0 + 10);
    expect(s.total).toBe(7);
    expect(s.leased).toBe(2);
    expect(s.dead).toBe(1);
    expect(s.waiting).toBe(4); // 2 embed + отложенный embed + 1 distill
    expect(s.ready).toBe(3); // отложенный по run_after сюда не входит
    const embed = s.byKind.find((k) => k.kind === "embed")!;
    expect(embed).toMatchObject({ total: 5, leased: 2, ready: 2, waiting: 3, dead: 0 });
    const distill = s.byKind.find((k) => k.kind === "distill")!;
    expect(distill).toMatchObject({ total: 2, dead: 1, ready: 1 });
  });

  test("пустая очередь даёт нули, а не undefined", () => {
    const s = stats(db(), T0);
    expect(s).toMatchObject({ total: 0, waiting: 0, ready: 0, leased: 0, dead: 0 });
    expect(s.byKind).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Совместимость с уже существующими пользователями таблицы
// ---------------------------------------------------------------------------

describe("совместимость: checkpoint.ts и health", () => {
  test("общий API видит и снимает задание WAL-checkpoint, поставленное checkpoint.ts", () => {
    expect(enqueueWalCheckpointJob(db(), T0)).toBe(true);
    expect(enqueueWalCheckpointJob(db(), T0)).toBe(false); // идемпотентно, тот же индекс
    expect(walCheckpointJobPending(db())).toBe(true);

    const got = claim(db(), [COMPACT_JOB_KIND], "worker", { now: T0, leaseMs: 5_000 });
    expect(got).toHaveLength(1);
    expect(got[0]!.entity_id).toBe(WAL_JOB_ENTITY);
    expect(JSON.parse(got[0]!.payload)).toEqual({ op: "wal_checkpoint" });
    expect(complete(db(), got[0]!.id, "worker")).toBe(true);
    expect(walCheckpointJobPending(db())).toBe(false);
  });

  test("dropWalCheckpointJob снимает задание, поставленное общим API", () => {
    enqueue(db(), COMPACT_JOB_KIND, { entityId: WAL_JOB_ENTITY, now: T0 });
    expect(walCheckpointJobPending(db())).toBe(true);
    dropWalCheckpointJob(db());
    expect(walCheckpointJobPending(db())).toBe(false);
  });

  test("запросы /api/health по этой таблице отвечают то же, что stats()", () => {
    for (let i = 0; i < 3; i++) enqueue(db(), "embed", { entityId: `e${i}`, now: T0 });
    const deadId = enqueue(db(), "embed", { entityId: "bad", maxAttempts: 1, now: T0 }).id;
    fail(db(), deadId, "boom", { now: T0 });
    claim(db(), ["embed"], "w1", { now: T0, leaseMs: 60_000, limit: 1 });

    // Дословно запросы packages/web/src/health.ts — граница «мертва» там
    // выражена как attempts >= max_attempts, и общий API обязан её держать.
    const pending = db()
      .query("SELECT count(*) AS n FROM jobs WHERE attempts < max_attempts")
      .get() as { n: number };
    const failed = db()
      .query("SELECT count(*) AS n FROM jobs WHERE attempts >= max_attempts")
      .get() as { n: number };
    const embedPending = db()
      .query("SELECT count(*) AS n FROM jobs WHERE kind = 'embed' AND attempts < max_attempts")
      .get() as { n: number };

    const s = stats(db(), T0);
    expect(failed.n).toBe(s.dead);
    expect(pending.n).toBe(s.waiting + s.leased);
    expect(embedPending.n).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Настоящая конкурентность: отдельные процессы на одну базу
// ---------------------------------------------------------------------------

interface Event {
  readonly ts: number;
  readonly event: string;
  readonly id: number;
  readonly holder: string;
  readonly attempts: number;
  readonly deleted: number;
  /** Аренда, под которой была выдана работа (0 в событиях без выдачи). */
  readonly leaseExpires: number;
}

interface WorkerSpec {
  readonly holder: string;
  readonly leaseMs: number;
  readonly batch: number;
  readonly workMs?: number;
  readonly stallAt?: number;
  readonly deadlineMs?: number;
}

function spawnWorker(
  paths: { db: string; log: string; go: string },
  spec: WorkerSpec,
  goPath: string = paths.go,
) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "jobs.worker.ts"),
      "--db", paths.db,
      "--log", paths.log,
      "--go", goPath,
      "--holder", spec.holder,
      "--lease-ms", String(spec.leaseMs),
      "--batch", String(spec.batch),
      "--work-ms", String(spec.workMs ?? 0),
      "--stall-at", String(spec.stallAt ?? 0),
      "--deadline-ms", String(spec.deadlineMs ?? 30_000),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readEvents(logPath: string): Event[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const [ts, event, id, holder, attempts, deleted, leaseExpires] = line.split(" ");
      return {
        ts: Number(ts),
        event: String(event),
        id: Number(id),
        holder: String(holder),
        attempts: Number(attempts),
        deleted: Number(deleted),
        leaseExpires: Number(leaseExpires),
      };
    });
}

async function setupRace(jobsCount: number): Promise<{
  paths: { db: string; log: string; go: string; goVictim: string };
  seed: SqliteDriver;
}> {
  const raceDir = mkdtempSync(join(tmpdir(), "myc-jobs-race-"));
  const paths = {
    db: join(raceDir, "race.db"),
    log: join(raceDir, "events.log"),
    go: join(raceDir, "go"),
    goVictim: join(raceDir, "go-victim"),
  };
  writeFileSync(paths.log, "");
  const seed = openSqlite(paths.db);
  await migrate(seed.database, { migrations, writable: true });
  const now = Date.now();
  for (let i = 0; i < jobsCount; i++) {
    enqueue(seed.database, "embed", { entityId: `e${i}`, scope: "s", now });
  }
  return { paths, seed };
}

describe("настоящая конкурентность (процессы Bun.spawn на одну базу)", () => {
  test(
    "6 процессов, 300 работ: ровно одна выдача на работу, ноль потерянных",
    async () => {
      const JOBS = 300;
      const PROCESSES = 6;
      const { paths, seed } = await setupRace(JOBS);
      try {
        const procs = Array.from({ length: PROCESSES }, (_, i) =>
          spawnWorker(paths, { holder: `w${i}`, leaseMs: 10_000, batch: 8, workMs: 1 }),
        );
        writeFileSync(paths.go, "go"); // барьер: все уже на дорожке
        const reports = await Promise.all(
          procs.map(async (p, i) => {
            const [out, err] = await Promise.all([
              new Response(p.stdout).text(),
              new Response(p.stderr).text(),
            ]);
            const code = await p.exited;
            if (code !== 0) throw new Error(`воркер w${i} упал с кодом ${code}: ${err}`);
            return JSON.parse(out) as { holder: string; claimed: number; done: number };
          }),
        );

        const events = readEvents(paths.log);
        const claims = events.filter((e) => e.event === "claim");
        const dones = events.filter((e) => e.event === "done");
        const distinctClaimed = new Set(claims.map((e) => e.id));
        const distinctDone = new Set(dones.map((e) => e.id));

        // Ни одна работа не выдана дважды под живой арендой…
        expect(claims.length).toBe(JOBS);
        expect(distinctClaimed.size).toBe(JOBS);
        // …и ни одна не потеряна.
        expect(dones.length).toBe(JOBS);
        expect(distinctDone.size).toBe(JOBS);
        expect(dones.every((e) => e.deleted === 1)).toBe(true);
        expect(stats(seed.database).total).toBe(0);

        console.log(
          `[concurrency] процессов=${PROCESSES}, работ=${JOBS}; выдач=${claims.length}, ` +
            `уникальных=${distinctClaimed.size}, дублей=${claims.length - distinctClaimed.size}; ` +
            `по процессам: ${reports.map((r) => `${r.holder}=${r.claimed}`).join(", ")}`,
        );
      } finally {
        seed.close();
      }
    },
    180_000,
  );
});

describe("аварийное завершение (SIGKILL посреди аренды)", () => {
  test(
    "убитый посреди работы процесс не теряет и не дублирует задачу",
    async () => {
      const JOBS = 40;
      const LEASE_MS = 700;
      const { paths, seed } = await setupRace(JOBS);
      try {
        // Жертва зависает на первой же выданной работе — под ЖИВОЙ арендой.
        const victim = spawnWorker(
          paths,
          { holder: "victim", leaseMs: LEASE_MS, batch: 1, stallAt: 1 },
          paths.goVictim,
        );
        const others = Array.from({ length: 3 }, (_, i) =>
          spawnWorker(paths, { holder: `w${i}`, leaseMs: LEASE_MS, batch: 1 }),
        );

        // Барьер в два шага, иначе тест сам был бы гонкой: соседи успевают
        // разобрать очередь раньше, чем жертва возьмёт хоть что-то, и сценарий
        // «убит посреди аренды» просто не наступает.
        writeFileSync(paths.goVictim, "go");
        const deadline = Date.now() + 20_000;
        let stalled: Event | undefined;
        while (Date.now() < deadline && stalled === undefined) {
          await Bun.sleep(5);
          stalled = readEvents(paths.log).find((e) => e.event === "stall");
        }
        expect(stalled).toBeDefined();

        // Соседи выходят на дорожку, пока аренда жертвы ЖИВА: они обязаны
        // обойти её работу стороной, а не подобрать сразу.
        writeFileSync(paths.go, "go");
        victim.kill("SIGKILL");
        await victim.exited;
        expect(victim.signalCode).toBe("SIGKILL");
        const killedAt = Date.now();

        for (const [i, p] of others.entries()) {
          const err = await new Response(p.stderr).text();
          await new Response(p.stdout).text();
          const code = await p.exited;
          if (code !== 0) throw new Error(`воркер w${i} упал с кодом ${code}: ${err}`);
        }

        const events = readEvents(paths.log);
        const deliveries = events.filter((e) => e.event === "claim" || e.event === "stall");
        const dones = events.filter((e) => e.event === "done");
        const lostJob = stalled!.id;

        // 1. Работа не потеряна: все 40 исполнены, включая ту, что была
        //    в руках у убитого процесса.
        expect(new Set(dones.map((e) => e.id)).size).toBe(JOBS);
        expect(dones).toHaveLength(JOBS);
        expect(dones.some((e) => e.id === lostJob)).toBe(true);
        expect(stats(seed.database).total).toBe(0);

        // 2. Работа не выполнена дважды: единственная повторная ВЫДАЧА —
        //    у работы убитого, и она случилась только после истечения аренды.
        const perJob = new Map<number, Event[]>();
        for (const e of deliveries) perJob.set(e.id, [...(perJob.get(e.id) ?? []), e]);
        const duplicated = [...perJob.entries()].filter(([, es]) => es.length > 1);
        expect(duplicated.map(([id]) => id)).toEqual([lostJob]);

        const retake = perJob.get(lostJob)!.find((e) => e.holder !== "victim")!;
        expect(retake).toBeDefined();
        // Точка отсчёта — сама аренда, а не строка журнала: она проставлена
        // на миллисекунду-другую раньше, чем воркер успел дописать событие.
        expect(retake.ts).toBeGreaterThanOrEqual(stalled!.leaseExpires);
        // Просрочка засчитана попыткой — работа, роняющая процесс, конечна.
        expect(retake.attempts).toBe(1);
        // Исполнил её ровно один процесс, и он же снял её с очереди.
        const doneRows = dones.filter((e) => e.id === lostJob);
        expect(doneRows).toHaveLength(1);
        expect(doneRows[0]!.deleted).toBe(1);

        console.log(
          `[crash] работа ${lostJob} была в аренде у убитого процесса; ` +
            `подобрана процессом ${retake.holder} через ${retake.ts - stalled!.ts} мс ` +
            `(аренда ${LEASE_MS} мс, kill +${killedAt - stalled!.ts} мс); ` +
            `выдач=${deliveries.length}, исполнений=${dones.length}, работ=${JOBS}`,
        );
      } finally {
        seed.close();
      }
    },
    180_000,
  );
});
