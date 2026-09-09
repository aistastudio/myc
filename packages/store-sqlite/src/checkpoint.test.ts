import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlcClock, generateId } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";
import {
  COMPACT_JOB_KIND,
  WAL_HARD_LIMIT_BYTES,
  WAL_JOB_ENTITY,
  WAL_SOFT_LIMIT_BYTES,
  createWalGuard,
  enqueueWalCheckpointJob,
  runWalCheckpointJob,
  walCheckpoint,
  walCheckpointJobPending,
  walPath,
  walSizeBytes,
} from "./checkpoint.ts";

// Предохранитель роста WAL и фоновый checkpoint — решение S35 (myc-443).

const MB = 1024 * 1024;

let dir: string;
let driver: SqliteDriver;
let store: GraphStore;

async function openAt(
  path: string,
  wal?: { hardLimitBytes?: number; softLimitBytes?: number; enqueueJob?: boolean },
): Promise<{ driver: SqliteDriver; store: GraphStore }> {
  const d = openSqlite(wal === undefined ? { path } : { path, wal });
  await migrate(d.database, { migrations, writable: true });
  const s = new GraphStore(d, {
    siteId: "siteA",
    actor: "tester",
    newId: () => generateId(),
    clock: new HlcClock(),
    now: () => Date.now(),
  });
  return { driver: d, store: s };
}

let seq = 0;
function write(target: GraphStore, n: number): void {
  for (let i = 0; i < n; i++) {
    seq++;
    target.createNode({
      kind: "note",
      scope: "s",
      title: `узел ${seq}`,
      body: `тело ${seq} — достаточно текста, чтобы задеть FTS и производные колонки`,
      attrs: { topic: `t${seq % 16}` },
    });
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-wal-"));
  const opened = await openAt(join(dir, "myc.db"), {
    hardLimitBytes: MB,
    softLimitBytes: MB / 2,
  });
  driver = opened.driver;
  store = opened.store;
});

afterEach(() => {
  try {
    driver?.close();
  } catch {
    // соединение уже закрыто тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("PRAGMA открытия", () => {
  test("авточекпойнт выключен, а WAL усекается после checkpoint", () => {
    const auto = driver.database.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number;
    };
    const limit = driver.database.query("PRAGMA journal_size_limit").get() as {
      journal_size_limit: number;
    };
    expect(auto.wal_autocheckpoint).toBe(0);
    // Без нулевого лимита файл WAL переиспользуется, его размер залипает на
    // максимуме и предохранителю нечего мерить — это и была слепая зона myc-443.
    expect(limit.journal_size_limit).toBe(0);
  });

  test("потолок по умолчанию — 32 МиБ, мягкий порог — 8 МиБ", () => {
    expect(WAL_HARD_LIMIT_BYTES).toBe(32 * MB);
    expect(WAL_SOFT_LIMIT_BYTES).toBe(8 * MB);
  });
});

describe("измерение WAL", () => {
  test("размер растёт при записи и обнуляется после checkpoint", () => {
    const before = walSizeBytes(driver.database);
    write(store, 3);
    const grown = walSizeBytes(driver.database);
    expect(grown).toBeGreaterThan(before);

    const result = walCheckpoint(driver.database, "TRUNCATE");
    expect(result.busy).toBe(false);
    expect(result.complete).toBe(true);
    expect(walSizeBytes(driver.database)).toBe(0);
  });

  test("у базы в памяти WAL нет и предохранитель молчит", () => {
    const mem = openSqlite(":memory:");
    try {
      expect(walPath(mem.database)).toBeNull();
      expect(walSizeBytes(mem.database)).toBe(0);
      mem.wal.afterCommit();
      expect(mem.walStats().checkpoints).toBe(0);
    } finally {
      mem.close();
    }
  });
});

describe("предохранитель", () => {
  test("непрерывная запись при мёртвом фоне не разгоняет WAL", () => {
    const hard = MB;
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      write(store, 1);
      peak = Math.max(peak, walSizeBytes(driver.database));
    }

    const stats = driver.walStats();
    // Фоновый обработчик не запускался ни разу — держит только предохранитель.
    expect(stats.checkpoints).toBeGreaterThan(0);
    expect(stats.degraded).toBe(false);
    // Потолок проверяется ПОСЛЕ коммита, поэтому перелёт — не больше одной
    // записи; удваивать запас не приходится.
    expect(peak).toBeLessThan(hard * 1.5);
  });

  test("без предохранителя тот же объём записи разносит WAL кратно", async () => {
    const loose = await openAt(join(dir, "loose.db"), {
      hardLimitBytes: Number.MAX_SAFE_INTEGER,
      softLimitBytes: Number.MAX_SAFE_INTEGER,
    });
    try {
      write(loose.store, 240);
      const unbounded = walSizeBytes(loose.driver.database);
      expect(loose.driver.walStats().checkpoints).toBe(0);
      expect(unbounded).toBeGreaterThan(MB * 4);
    } finally {
      loose.driver.close();
    }
  });

  test("платит одна запись из многих, а не каждая", () => {
    const writes = 240;
    write(store, writes);
    const stats = driver.walStats();
    expect(stats.checkpoints).toBeGreaterThan(0);
    // Каждое срабатывание отделено от следующего целым потолком WAL.
    expect(stats.checkpoints).toBeLessThan(writes / 4);
  });

  test("не роняет уже закоммиченную запись, если обслуживание WAL сломалось", async () => {
    const broken = await openAt(join(dir, "broken.db"), {
      hardLimitBytes: MB,
      softLimitBytes: 1,
    });
    try {
      broken.driver.database.exec("DROP TABLE jobs");
      write(broken.store, 4);
      const stats = broken.driver.walStats();
      expect(stats.lastError).toContain("jobs");
      // Запись прошла целиком, несмотря на сломанную очередь.
      const n = broken.driver.database.query("SELECT count(*) AS n FROM nodes").get() as {
        n: number;
      };
      expect(n.n).toBe(4);
    } finally {
      broken.driver.close();
    }
  });
});

describe("фоновое задание класса compact", () => {
  test("мягкий порог ставит ровно одно задание, дедуп держит его единственным", () => {
    const now = 1_700_000_000_000;
    expect(enqueueWalCheckpointJob(driver.database, now)).toBe(true);
    expect(enqueueWalCheckpointJob(driver.database, now + 1)).toBe(false);

    const rows = driver.database
      .query("SELECT kind, entity_id, priority FROM jobs")
      .all() as Array<{ kind: string; entity_id: string; priority: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(COMPACT_JOB_KIND);
    expect(rows[0]!.entity_id).toBe(WAL_JOB_ENTITY);
    expect(walCheckpointJobPending(driver.database)).toBe(true);
  });

  test("обработчик делает checkpoint и снимает задание", () => {
    write(store, 3);
    enqueueWalCheckpointJob(driver.database);
    const before = walSizeBytes(driver.database);
    expect(before).toBeGreaterThan(0);

    const result = runWalCheckpointJob(driver.database, "TRUNCATE");
    expect(result.complete).toBe(true);
    expect(walCheckpointJobPending(driver.database)).toBe(false);
    // Снятие задания — это тоже запись, поэтому в WAL остаются её кадры;
    // важно, что перенесённый объём ушёл в основной файл.
    expect(walSizeBytes(driver.database)).toBeLessThan(before / 4);
  });

  test("недоделанный checkpoint оставляет задание в очереди", async () => {
    const other = await openAt(join(dir, "myc.db"));
    try {
      write(store, 2);
      enqueueWalCheckpointJob(driver.database);
      // Чужой открытый снимок не даёт перенести кадры целиком.
      other.driver.database.exec("BEGIN");
      other.driver.database.query("SELECT count(*) AS n FROM nodes").get();
      write(store, 2);

      const result = runWalCheckpointJob(driver.database, "TRUNCATE");
      expect(result.complete).toBe(false);
      expect(walCheckpointJobPending(driver.database)).toBe(true);
      other.driver.database.exec("COMMIT");
    } finally {
      other.driver.close();
    }
  });

  test("мягкий порог ставит задание сам, а потолок его снимает", async () => {
    const staged = await openAt(join(dir, "staged.db"), {
      hardLimitBytes: 4 * MB,
      softLimitBytes: 512 * 1024,
    });
    try {
      let enqueuedSeen = false;
      for (let i = 0; i < 12 && !enqueuedSeen; i++) {
        write(staged.store, 1);
        enqueuedSeen = walCheckpointJobPending(staged.driver.database);
      }
      expect(enqueuedSeen).toBe(true);
      expect(staged.driver.walStats().enqueued).toBe(1);
      expect(staged.driver.walStats().checkpoints).toBe(0);

      // Фон так и не пришёл — потолок делает работу сам и снимает задание.
      let fired = false;
      for (let i = 0; i < 200 && !fired; i++) {
        write(staged.store, 1);
        fired = staged.driver.walStats().checkpoints > 0;
      }
      expect(fired).toBe(true);
      expect(walCheckpointJobPending(staged.driver.database)).toBe(false);
    } finally {
      staged.driver.close();
    }
  });
});

describe("аварийное завершение", () => {
  test(
    "убитый посреди записи процесс оставляет базу консистентной",
    async () => {
      const dbPath = join(dir, "crash.db");
      const progressPath = join(dir, "progress.txt");
      writeFileSync(progressPath, "");

      const worker = Bun.spawn({
        cmd: [
          process.execPath,
          join(import.meta.dir, "checkpoint.worker.ts"),
          "--db",
          dbPath,
          "--progress",
          progressPath,
          "--hard",
          String(512 * 1024),
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      // Ждём, пока воркер реально начнёт писать, и убиваем его на ходу.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await Bun.sleep(120);
        const size = statSync(progressPath).size;
        if (size > 4096) break;
      }
      worker.kill("SIGKILL");
      await worker.exited;
      expect(worker.signalCode).toBe("SIGKILL");

      const lines = readFileSync(progressPath, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(32);
      const last = lines[lines.length - 1]!.split(" ");
      const committed = Number(last[0]);
      const lastId = last[1]!;

      // WAL остался неперенесённым — база открывается через recovery.
      const walLeft = statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0;
      expect(walLeft).toBeGreaterThan(0);

      const reopened = openSqlite(dbPath);
      try {
        const integrity = reopened.database.query("PRAGMA integrity_check").get() as {
          integrity_check: string;
        };
        expect(integrity.integrity_check).toBe("ok");
        expect(reopened.database.query("PRAGMA foreign_key_check").all()).toHaveLength(0);

        // Всё, что воркер успел записать в файл прогресса, было закоммичено.
        const n = reopened.database.query("SELECT count(*) AS n FROM nodes").get() as {
          n: number;
        };
        expect(n.n).toBeGreaterThanOrEqual(committed);
        const survivor = reopened.database
          .query("SELECT id FROM nodes WHERE id = ?")
          .get(lastId) as { id: string } | null;
        expect(survivor?.id).toBe(lastId);

        // Оплог не отстал от узлов: у каждого узла есть операция создания.
        const orphan = reopened.database
          .query(
            `SELECT count(*) AS n FROM nodes n
              WHERE NOT EXISTS (SELECT 1 FROM oplog o WHERE o.entity_id = n.id)`,
          )
          .get() as { n: number };
        expect(orphan.n).toBe(0);
      } finally {
        reopened.close();
      }
    },
    60_000,
  );
});

describe("предохранитель отдельно от драйвера", () => {
  test("createWalGuard считает срабатывания и деградацию", () => {
    const guard = createWalGuard(driver.database, {
      hardLimitBytes: 64 * 1024,
      softLimitBytes: 32 * 1024,
      enqueueJob: false,
    });
    // Пишем ДО ПОРОГА, а не «восемь узлов и авось хватит». Фиксированное
    // число записей связывало проверку с размером СХЕМЫ: WAL после миграций
    // лежал чуть ниже жёсткого предела драйвера (1 МБ), восемь узлов его
    // переваливали, драйвер сам делал checkpoint и обрезал журнал — и этот
    // сторож видел пустой WAL. Поймано ровно так: одиннадцатая миграция
    // (code_ref_sites) сдвинула WAL на 29 КБ, и тест покраснел, не изменив
    // ни строки в предохранителе. Условие цикла — то, что проверка на самом
    // деле требует: WAL выше собственного порога этого сторожа.
    while (walSizeBytes(driver.database) < 64 * 1024) write(store, 8);
    guard.afterCommit();
    const stats = guard.stats();
    expect(stats.checkpoints).toBe(1);
    expect(stats.degraded).toBe(false);
    expect(stats.enqueued).toBe(0);
    expect(stats.lastMs).toBeGreaterThan(0);
  });
});
