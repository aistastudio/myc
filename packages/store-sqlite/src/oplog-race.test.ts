import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphError, HlcClock, generateId, type Op } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, rowToOp } from "./queries.ts";

/**
 * myc-4dy: коллизия op_id между процессами одного site_id.
 *
 * CLI и долгоживущий MCP-сервер одного воркспейса пишут под одним site_id из
 * разных процессов, каждый со своим seq и часами в памяти. До исправления
 * одновременные записи выдавали одинаковый op_id = site:seq, ON CONFLICT DO
 * NOTHING отбрасывал вторую как дубликат — молча. Здесь конкурентность
 * настоящая: отдельные процессы Bun.spawn против одной базы.
 */

const SITE = "siteA";
const PROCESSES = 6;
const OPS_PER_PROCESS = 200;
const TARGETS = 8;

interface WorkerReport {
  readonly worker: string;
  readonly ops: number;
  readonly errors: string[];
  readonly collisions: number;
}

interface Fixture {
  readonly dbPath: string;
  readonly owns: string[];
  readonly targets: string[];
  readonly baselineRows: number;
  readonly baselineSeq: number;
}

let dir: string;
let open: SqliteDriver[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-oplog-race-"));
});

afterEach(() => {
  for (const d of open) {
    try {
      d.close();
    } catch {
      // уже закрыто
    }
  }
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

async function openStore(
  dbPath: string,
  opts: { clock?: HlcClock; siteId?: string } = {},
): Promise<{ driver: SqliteDriver; store: GraphStore }> {
  const driver = openSqlite(dbPath);
  open.push(driver);
  await migrate(driver.database, { migrations, writable: true });
  const store = new GraphStore(driver, {
    siteId: opts.siteId ?? SITE,
    actor: "test",
    newId: () => generateId(),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  });
  return { driver, store };
}

/** База с узлами-владельцами (по одному на воркер) и узлами-целями рёбер. */
async function prepare(processes: number): Promise<Fixture> {
  const dbPath = join(dir, "myc.db");
  const { driver, store } = await openStore(dbPath);
  const owns = Array.from(
    { length: processes },
    (_, i) => store.createNode({ kind: "task", scope: "s", title: `own-${i}` }).id,
  );
  const targets = Array.from(
    { length: TARGETS },
    (_, i) => store.createNode({ kind: "note", scope: "s", title: `t-${i}` }).id,
  );
  const baselineRows = store.oplogCount();
  const baselineSeq = store.lastSeq;
  driver.close();
  open.pop();
  return { dbPath, owns, targets, baselineRows, baselineSeq };
}

interface SpawnOpts {
  readonly worker: string;
  readonly own: string;
  readonly ops: number;
  readonly go?: string;
  readonly pauseMs?: number;
  readonly mutant?: "none" | "swallow";
}

function spawnWorker(fx: Fixture, o: SpawnOpts): Promise<WorkerReport> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "oplog-race.worker.ts"),
      "--db",
      fx.dbPath,
      "--site",
      SITE,
      "--worker",
      o.worker,
      "--own",
      o.own,
      "--targets",
      fx.targets.join(","),
      "--ops",
      String(o.ops),
      "--pause-ms",
      String(o.pauseMs ?? 0),
      "--mutant",
      o.mutant ?? "none",
      ...(o.go !== undefined ? ["--go", o.go] : []),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`воркер ${o.worker} упал с кодом ${code}: ${err}`);
    }
    return JSON.parse(out.trim().split("\n").at(-1)!) as WorkerReport;
  })();
}

/** Сверка базы после прогона: ни одной проглоченной и ни одной потерянной строки. */
async function audit(fx: Fixture, expectedOps: number) {
  const { store, driver } = await openStore(fx.dbPath);
  const rows = store.oplogCount() - fx.baselineRows;
  const distinct = (
    driver.database.query("SELECT count(DISTINCT op_id) AS n FROM oplog").get() as {
      n: number;
    }
  ).n;
  const lastSeq = store.lastSeq;
  const owns = fx.owns.map((id) => store.getNode(id)!);
  const edges = fx.owns.map((id) => store.edgesFrom(id, "relates").length);
  driver.close();
  open.pop();
  return { rows, distinct, lastSeq, owns, edges, expectedOps };
}

describe("myc-4dy: процессы одного site_id пишут одновременно", () => {
  test(
    `${PROCESSES} процессов × ${OPS_PER_PROCESS} операций одним залпом: ноль проглоченных, ноль потерянных`,
    async () => {
      const fx = await prepare(PROCESSES);
      const go = join(dir, "go");
      const pending = fx.owns.map((own, i) =>
        spawnWorker(fx, { worker: `w${i}`, own, ops: OPS_PER_PROCESS, go }),
      );
      // Все процессы подняли соединения и ждут барьера — старт.
      await Bun.sleep(300);
      writeFileSync(go, "go");
      const reports = await Promise.all(pending);

      const total = PROCESSES * OPS_PER_PROCESS;
      const errors = reports.flatMap((r) => r.errors);
      const done = reports.reduce((n, r) => n + r.ops, 0);
      const a = await audit(fx, total);
      console.log(
        `[myc-4dy залп] процессов ${PROCESSES}, операций ${total}, выполнено ${done}, ` +
          `строк оплога +${a.rows}, ошибок ${errors.length}, коллизий ${reports.reduce((n, r) => n + r.collisions, 0)}`,
      );

      expect(errors).toEqual([]);
      expect(done).toBe(total);
      expect(a.rows).toBe(total);
      expect(a.distinct).toBe(fx.baselineRows + total);
      expect(a.lastSeq).toBe(fx.baselineSeq + total);
      for (let i = 0; i < PROCESSES; i++) {
        // Последний updateNode — k = 198; bumpCounter — 50 раз поверх стартовой 1.
        expect(a.owns[i]!.title).toBe(`w${i}-${OPS_PER_PROCESS - 2}`);
        expect(a.owns[i]!.seen_count).toBe(1 + OPS_PER_PROCESS / 4);
        expect(a.edges[i]).toBe(TARGETS);
      }
    },
    120_000,
  );

  test(
    "долгоживущий процесс вперемешку с серией одноразовых: ноль проглоченных, ноль потерянных",
    async () => {
      const fx = await prepare(2);
      const LONG_OPS = 400;
      const SHORT_OPS = 10;
      const SHORT_RUNS = 60;
      // Долгоживущий «MCP-сервер»: 400 операций с паузой в 1 мс между ними.
      const long = spawnWorker(fx, {
        worker: "long",
        own: fx.owns[0]!,
        ops: LONG_OPS,
        pauseMs: 1,
      });
      // Серия «CLI-вызовов»: каждый открывает базу, пишет 10 операций, выходит.
      const shorts: WorkerReport[] = [];
      for (let r = 0; r < SHORT_RUNS; r++) {
        shorts.push(
          await spawnWorker(fx, { worker: "cli", own: fx.owns[1]!, ops: SHORT_OPS }),
        );
      }
      const longReport = await long;

      const total = LONG_OPS + SHORT_OPS * SHORT_RUNS;
      const errors = [...longReport.errors, ...shorts.flatMap((r) => r.errors)];
      const done = longReport.ops + shorts.reduce((n, r) => n + r.ops, 0);
      const a = await audit(fx, total);
      console.log(
        `[myc-4dy чередование] долгоживущий ${LONG_OPS} + ${SHORT_RUNS}×${SHORT_OPS} одноразовых = ${total}, ` +
          `выполнено ${done}, строк оплога +${a.rows}, ошибок ${errors.length}`,
      );

      expect(errors).toEqual([]);
      expect(done).toBe(total);
      expect(a.rows).toBe(total);
      expect(a.distinct).toBe(fx.baselineRows + total);
      expect(a.lastSeq).toBe(fx.baselineSeq + total);
      expect(a.owns[0]!.title).toBe(`long-${LONG_OPS - 2}`);
      expect(a.owns[0]!.seen_count).toBe(1 + LONG_OPS / 4);
      // В каждом одноразовом прогоне bumpCounter — на k = 1, 5, 9; последний
      // updateNode — на k = 8.
      expect(a.owns[1]!.title).toBe(`cli-${SHORT_OPS - 2}`);
      expect(a.owns[1]!.seen_count).toBe(1 + SHORT_RUNS * 3);
    },
    120_000,
  );

  test(
    "мутационная проверка: без выделения seq под блокировкой ON CONFLICT DO NOTHING глотает записи, и детектор это видит",
    async () => {
      const fx = await prepare(PROCESSES);
      const go = join(dir, "go");
      const pending = fx.owns.map((own, i) =>
        spawnWorker(fx, {
          worker: `m${i}`,
          own,
          ops: OPS_PER_PROCESS,
          go,
          mutant: "swallow",
        }),
      );
      await Bun.sleep(300);
      writeFileSync(go, "go");
      const reports = await Promise.all(pending);

      const total = PROCESSES * OPS_PER_PROCESS;
      const done = reports.reduce((n, r) => n + r.ops, 0);
      const a = await audit(fx, total);
      const swallowed = done - a.rows;
      console.log(
        `[myc-4dy мутант] операций ${total}, воркеры отчитались об успехе ${done}, ` +
          `строк оплога +${a.rows}, проглочено ${swallowed}`,
      );
      // Мутант отчитывается об успехе, а строк в оплоге меньше — ровно то,
      // что раньше происходило молча. Те же утверждения, что в боевом тесте,
      // здесь обязаны провалиться.
      expect(swallowed).toBeGreaterThan(0);
      expect(a.rows).not.toBe(total);
    },
    120_000,
  );
});

/** Часы поля title узла — из оплога, через тот же разбор, что у sync. */
function readTitleHlc(store: GraphStore, nodeId: string) {
  const row = store
    .opsSince(0)
    .find((r) => r.entity_id === nodeId && r.field === "title");
  if (row === undefined) throw new Error("операции title нет в оплоге");
  return rowToOp(row).hlc;
}

describe("myc-4dy: ничья (hlc, site_id) при разных значениях — громкая", () => {
  const T0 = 1_700_000_000_000;

  test("applyOps: чужая операция с равной парой и другим значением попадает в collided, а не в stale", async () => {
    const { store } = await openStore(join(dir, "tie.db"), {
      clock: new HlcClock({ now: () => T0 }),
    });
    const node = store.createNode({ kind: "note", scope: "s", title: "первое" });
    const hlc = readTitleHlc(store, node.id);

    const same: Op = {
      op: "set", seq: 9001, hlc, op_id: `${SITE}:9001`, site_id: SITE,
      entity_id: node.id, field: "title", value: "первое",
    };
    const other: Op = {
      op: "set", seq: 9002, hlc, op_id: `${SITE}:9002`, site_id: SITE,
      entity_id: node.id, field: "title", value: "второе",
    };
    const r1 = store.applyOps([same]);
    expect(r1.collided).toEqual([]);
    expect(r1.stale).toBe(1);

    const r2 = store.applyOps([other]);
    expect(r2.collided).toEqual([`${SITE}:9002`]);
    expect(r2.stale).toBe(0);
    expect(r2.applied).toBe(0);
    // Операция записана в оплог (её нельзя потерять), но не спроецирована.
    expect(store.opsSince(0).some((r) => r.op_id === `${SITE}:9002`)).toBe(true);
    expect(store.getNode(node.id)!.title).toBe("первое");
  });

  test("локальная запись с равной парой и другим значением бросает graph.clock_collision", async () => {
    const dbPath = join(dir, "tie-local.db");
    const { store, driver } = await openStore(dbPath, {
      clock: new HlcClock({ now: () => T0 }),
    });
    const node = store.createNode({ kind: "note", scope: "s", title: "первое" });
    const titleHlc = readTitleHlc(store, node.id);
    driver.close();
    open.pop();

    // Процесс, чьи часы застыли и не поднимаются от хвоста ни в конструкторе
    // (S38), ни в транзакции (syncTail): единственный способ получить пару
    // (hlc, site_id), уже занятую полем title. Следующий now() выдаст ровно
    // titleHlc. Seq уведён вперёд, чтобы столкнулись именно часы, а не op_id.
    const { store: frozen } = await openStore(dbPath);
    const raw = frozen as unknown as Record<string, unknown>;
    raw["syncTail"] = () => {};
    const ops = raw["ops"] as unknown as { clock: HlcClock; advanceSeq(n: number): void };
    ops.clock = new HlcClock({
      now: () => titleHlc.ts,
      initial: { ts: titleHlc.ts, ctr: titleHlc.ctr - 1 },
    });
    ops.advanceSeq(10_000);

    let caught: unknown;
    try {
      frozen.updateNode(node.id, { title: "второе" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphError);
    expect((caught as GraphError).code).toBe("graph.clock_collision");
    // Откат целиком: ни строки оплога, ни смены значения.
    expect(frozen.getNode(node.id)!.title).toBe("первое");
    expect(frozen.opsSince(0).filter((r) => Number(r.op_id.split(":")[1]) > 10_000)).toEqual([]);
  });

  test("занятый op_id при локальной записи — graph.clock_collision, а не тихий false", async () => {
    const dbPath = join(dir, "tie-opid.db");
    const first = await openStore(dbPath);
    const node = first.store.createNode({ kind: "note", scope: "s", title: "a" });
    // Второй процесс стартует с тем же seq и не смотрит на хвост (мутант).
    const second = await openStore(dbPath);
    (second.store as unknown as Record<string, unknown>)["syncTail"] = () => {};
    first.store.updateNode(node.id, { title: "b" });

    let caught: unknown;
    try {
      second.store.updateNode(node.id, { title: "c" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphError);
    expect((caught as GraphError).code).toBe("graph.clock_collision");
    expect(first.store.getNode(node.id)!.title).toBe("b");
  });
});
