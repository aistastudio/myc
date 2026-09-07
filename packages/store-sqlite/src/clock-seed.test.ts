import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlcClock, OpFactory, compareHlc, generateId } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";

/**
 * S38: часы HLC обязан поднимать движок, а не вызывающий.
 *
 * Сценарий потери: два последовательных ОДНОРАЗОВЫХ соединения (так живёт
 * CLI и любой короткий процесс агента). Первое создаёт узел, второе его
 * меняет. Если каждое поднимает GraphStore с часами от нуля, обе записи
 * попадают в одну миллисекунду с одним site_id, пара (hlc, site_id)
 * совпадает — и projectSet молча отбрасывает более позднюю.
 */

const SITE = "siteA";
const PAIRS = 200;

let dir: string;
let open: SqliteDriver[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-clock-seed-"));
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

/** Одноразовое соединение: открыть, сделать одно дело, закрыть. */
async function once<T>(
  fn: (store: GraphStore) => T,
  opts: { clock?: HlcClock; siteId?: string } = {},
): Promise<T> {
  const driver = openSqlite(join(dir, "myc.db"));
  open.push(driver);
  await migrate(driver.database, { migrations, writable: true });
  const store = new GraphStore(driver, {
    siteId: opts.siteId ?? SITE,
    actor: "cli",
    newId: () => generateId(),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  });
  try {
    return fn(store);
  } finally {
    driver.close();
    open.pop();
  }
}

describe("S38: сидирование часов в движке, реальное время", () => {
  test(`${PAIRS} пар create→update через два одноразовых соединения: ноль потерь`, async () => {
    let lost = 0;
    for (let i = 0; i < PAIRS; i++) {
      const id = await once((s) =>
        s.createNode({ kind: "note", scope: "s", title: `v0-${i}` }).id,
      );
      await once((s) => s.updateNode(id, { title: `v1-${i}` }));
      const title = await once((s) => s.getNode(id)?.title);
      if (title !== `v1-${i}`) lost++;
    }
    expect(lost).toBe(0);
  }, 60_000);

  test(`${PAIRS} пар create→close: ноль потерь`, async () => {
    let lost = 0;
    for (let i = 0; i < PAIRS; i++) {
      const id = await once((s) =>
        s.createNode({ kind: "task", scope: "s", title: `t-${i}` }).id,
      );
      await once((s) => s.updateNode(id, { status: "closed" }));
      const status = await once((s) => s.getNode(id)?.status);
      if (status !== "closed") lost++;
    }
    expect(lost).toBe(0);
  }, 60_000);

  test(`${PAIRS} пар update→update по одному полю: ноль потерь`, async () => {
    const id = await once((s) =>
      s.createNode({ kind: "note", scope: "s", title: "seed" }).id,
    );
    let lost = 0;
    for (let i = 0; i < PAIRS; i++) {
      await once((s) => s.updateNode(id, { title: `a-${i}` }));
      await once((s) => s.updateNode(id, { title: `b-${i}` }));
      const title = await once((s) => s.getNode(id)?.title);
      if (title !== `b-${i}`) lost++;
    }
    expect(lost).toBe(0);
  }, 60_000);
});

describe("S38: сидирование часов в движке, детерминированно", () => {
  /** Замороженное физическое время: без сида ничья гарантирована. */
  const FROZEN = 1_700_000_000_000;
  const frozen = () => new HlcClock({ now: () => FROZEN });

  test("создание и правка в одну миллисекунду: правка побеждает", async () => {
    const id = await once(
      (s) => s.createNode({ kind: "note", scope: "s", title: "v0" }).id,
      { clock: frozen() },
    );
    await once((s) => s.updateNode(id, { title: "v1" }), { clock: frozen() });
    const title = await once((s) => s.getNode(id)?.title, { clock: frozen() });
    expect(title).toBe("v1");
  });

  test("новое соединение стартует строго позже последней своей записи", async () => {
    await once((s) => s.createNode({ kind: "note", scope: "s", title: "x" }), {
      clock: frozen(),
    });
    const last = await once((s) => {
      const rows = s.opsSince(0);
      return rows[rows.length - 1]!;
    });
    const next = await once((s) => s.clock.now());
    const lastHlc = { ts: Number(BigInt(last.hlc) >> 16n), ctr: Number(BigInt(last.hlc) & 0xffffn) };
    expect(compareHlc(next, lastHlc)).toBeGreaterThan(0);
  });

  test("чужая запись в конце оплога тоже поднимает часы (HLC-join)", async () => {
    const id = await once(
      (s) => s.createNode({ kind: "note", scope: "s", title: "x" }).id,
    );
    // Чужой сайт с часами чуть впереди наших, в пределах допуска skew.
    const ahead = Date.now() + 5_000;
    const remote = new OpFactory("siteB", { clock: new HlcClock({ now: () => ahead }) });
    await once((s) => s.applyOps([remote.set(id, "title", "remote")]));
    expect(await once((s) => s.getNode(id)?.title)).toBe("remote");
    // Наша следующая локальная правка обязана победить чужую, а не отвалиться как stale.
    await once((s) => s.updateNode(id, { title: "local-after" }));
    expect(await once((s) => s.getNode(id)?.title)).toBe("local-after");
  });
});
