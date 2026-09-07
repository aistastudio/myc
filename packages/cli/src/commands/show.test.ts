/**
 * `myc show` и режимы истории (§6.3 01-core-data-model.md).
 *
 * ПРИЁМКА задачи: цепочка из ПЯТИ версий отдаёт актуальную по умолчанию и
 * полную по запросу (`--chain`), и та же цепочка ПЕРЕЖИВАЕТ СЛИЯНИЕ двух
 * веток оплога — порядок применения на итог не влияет.
 *
 * Слияние проверяется настоящими процессами (Bun.spawn), а не вызовами в
 * одном: инвариант живёт между машинами, и однопоточный тест его не видит —
 * в этом репозитории так дважды молча терялись записи (S38, S40).
 *
 * Отдельно проверяется, что `contradicts` читается с ОБЕИХ сторон: ребро
 * симметрично и записано один раз, а противоречие, видимое только с одной
 * стороны, — это ровно та ловушка memora, где конфликт помечен, но вторую
 * сторону нечем найти.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { generateId, historyClause } from "@myc/core";
import {
  GraphStore,
  exportGraph,
  migrate,
  migrations,
  openSqlite,
  type SqliteDriver,
} from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createShowCommand } from "./show.ts";

const WORKER = join(import.meta.dir, "show.merge.worker.ts");

let dir: string;
let registry: Registry;
const drivers: SqliteDriver[] = [];

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createShowCommand());
  return r;
}

async function makeWorkspace(root: string): Promise<string> {
  mkdirSync(join(root, ".myc"), { recursive: true });
  const path = join(root, ".myc", "myc.db");
  const raw = new Database(path, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  return path;
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-show-"));
  await makeWorkspace(dir);
  registry = makeRegistry();
});

afterEach(() => {
  for (const d of drivers.splice(0)) {
    try {
      d.close();
    } catch {
      /* уже закрыт */
    }
  }
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function myc(root: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", root, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

interface Envelope<T> {
  ok: boolean;
  data: T;
  meta: Record<string, unknown>;
}

async function showJson<T = Record<string, unknown>>(
  root: string,
  ...args: string[]
): Promise<T> {
  const r = await myc(root, "show", ...args, "--json");
  expect(r.code).toBe(0);
  return (JSON.parse(text(r.stdout)) as Envelope<T>).data;
}

function storeOf(root: string, siteId = "site-main"): { store: GraphStore; driver: SqliteDriver } {
  const driver = openSqlite(join(root, ".myc", "myc.db"));
  drivers.push(driver);
  const store = new GraphStore(driver, {
    newId: () => generateId(),
    siteId,
    actor: "tester",
  });
  return { store, driver };
}

/**
 * Цепочка версий ровно в той форме, в какой её оставляет `myc absorb` при
 * классе `update`: ребро supersedes на предыдущую и head_id всей цепочки на
 * новую голову (§6.2, §6.3).
 */
function buildChain(store: GraphStore, n: number, prefix: string): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const node = store.createNode({
      kind: "note",
      scope: "test",
      title: `${prefix} версия ${i}`,
      body: `${prefix}: редакция номер ${i}`,
    });
    if (i > 1) {
      const prev = ids[i - 2]!;
      store.addEdge(node.id, "supersedes", prev, { weight: 0.97 });
      for (const old of ids) {
        store.updateNode(old, {
          head_id: node.id,
          status: "superseded",
          attrs: { absorb: { class: "update", reason: `версия ${i} заменила ${i - 1}` } },
        });
      }
    }
    ids.push(node.id);
  }
  return ids;
}

interface ChainEntryView {
  id: string;
  status: string;
  created_at: number;
  current: boolean;
  reason?: string;
  absorb_class?: string;
}

interface ShowView {
  id: string;
  title: string;
  status: string;
  current: boolean;
  head?: { id: string; title: string; status: string };
  forked?: string[];
  stale?: string[];
  contradicts: { type: string; id: string }[];
  chain?: ChainEntryView[];
}

// ---------------------------------------------------------------------------
// ПРИЁМКА: пять версий
// ---------------------------------------------------------------------------

describe("цепочка из 5 версий (§6.3)", () => {
  let ids: string[];

  beforeEach(() => {
    const { store, driver } = storeOf(dir);
    ids = buildChain(store, 5, "alpha");
    driver.close();
    drivers.pop();
  });

  test("по умолчанию отдаётся АКТУАЛЬНАЯ версия — из любого звена цепочки", async () => {
    const head = ids[4]!;
    for (const id of ids.slice(0, 4)) {
      const v = await showJson<ShowView>(dir, id);
      expect(v.current).toBe(false);
      expect(v.head?.id).toBe(head);
      expect(v.head?.title).toBe("alpha версия 5");
      // Полной истории по умолчанию нет — она по запросу.
      expect(v.chain).toBeUndefined();
    }
    const top = await showJson<ShowView>(dir, head);
    expect(top.current).toBe(true);
    expect(top.head).toBeUndefined();
  });

  test("--chain отдаёт ПОЛНУЮ цепочку из пяти, от старой к новой", async () => {
    for (const id of ids) {
      const v = await showJson<ShowView>(dir, id, "--chain");
      expect(v.chain).toBeDefined();
      expect(v.chain!.map((c) => c.id)).toEqual(ids);
      expect(v.chain!.filter((c) => c.current).map((c) => c.id)).toEqual([ids[4]!]);
    }
  });

  test("--chain печатает даты, статусы и причину из absorb", async () => {
    const r = await myc(dir, "show", ids[0]!, "--chain");
    const out = text(r.stdout);
    expect(r.code).toBe(0);
    expect(out).toContain("история   5 верс.");
    for (const id of ids) expect(out).toContain(id);
    expect(out).toContain("версия 5 заменила 4");
    expect(out).toContain("superseded");
    // Актуальная помечена стрелкой, остальные — точкой.
    expect(out.split("\n").filter((l) => l.includes("→ myc-"))).toHaveLength(1);
  });

  test("человеческий вывод по умолчанию называет актуальную версию, но не всю историю", async () => {
    const r = await myc(dir, "show", ids[0]!);
    const out = text(r.stdout);
    expect(out).toContain(`актуальна ${ids[4]!}`);
    expect(out).not.toContain("история");
    expect(out).not.toContain(ids[2]!);
  });

  test("конверт называет режим чтения", async () => {
    const r = await myc(dir, "show", `${ids[0]!},${ids[1]!}`, "--json");
    const env = JSON.parse(text(r.stdout)) as Envelope<{ history: string }>;
    expect(env.data.history).toBe("follow");
    const r2 = await myc(dir, "show", `${ids[0]!},${ids[1]!}`, "--chain", "--json");
    expect((JSON.parse(text(r2.stdout)) as Envelope<{ history: string }>).data.history).toBe(
      "full_history",
    );
  });

  test("attrs.history_mode='full' включает полную историю без флага", async () => {
    const { store, driver } = storeOf(dir);
    store.updateNode(ids[0]!, { attrs: { history_mode: "full" } });
    driver.close();
    drivers.pop();
    const v = await showJson<ShowView>(dir, ids[0]!);
    expect(v.chain!.map((c) => c.id)).toEqual(ids);
    // У соседнего звена флага нет — история по-прежнему по запросу.
    expect((await showJson<ShowView>(dir, ids[1]!)).chain).toBeUndefined();
  });

  test("follow — это предикат head_id IS NULL: ему соответствует РОВНО одна версия", async () => {
    const { driver } = storeOf(dir);
    const live = driver.database
      .query(
        `SELECT id FROM nodes WHERE id IN (${ids.map(() => "?").join(",")})${historyClause("follow", "nodes")}`,
      )
      .all(...ids) as { id: string }[];
    driver.close();
    drivers.pop();
    // Не перенеси обновление head_id — здесь оказалось бы пять строк, и
    // ретривал отдавал бы устаревшие версии как актуальные.
    expect(live.map((r) => r.id)).toEqual([ids[4]!]);
    expect((await showJson<ShowView>(dir, ids[0]!)).stale).toBeUndefined();
  });

  test("непроставленный head_id не замалчивается: show кричит про устаревшую выдачу", async () => {
    const { store, driver } = storeOf(dir);
    // Ровно то, что делает обновление, забывшее перенести голову.
    store.updateNode(ids[1]!, { head_id: null });
    driver.close();
    drivers.pop();
    const v = await showJson<ShowView>(dir, ids[0]!, "--chain");
    expect(v.stale).toEqual([ids[1]!]);
    const out = text((await myc(dir, "show", ids[0]!)).stdout);
    expect(out).toContain("ВНИМАНИЕ  head_id не проставлен");
    expect(out).toContain(ids[1]!);
  });

  test("одиночный узел вне цепочки: актуален сам, история из одного", async () => {
    const { store, driver } = storeOf(dir);
    const lone = store.createNode({ kind: "note", scope: "test", title: "сам по себе" });
    driver.close();
    drivers.pop();
    const v = await showJson<ShowView>(dir, lone.id, "--chain");
    expect(v.current).toBe(true);
    expect(v.chain!.map((c) => c.id)).toEqual([lone.id]);
  });
});

// ---------------------------------------------------------------------------
// contradicts — с обеих сторон
// ---------------------------------------------------------------------------

describe("contradicts читается симметрично (§4.1, §6.2)", () => {
  test("противоречие видно и с той стороны, где ребра нет", async () => {
    const { store, driver } = storeOf(dir);
    const a = store.createNode({ kind: "note", scope: "test", title: "цикл проверяем" });
    const b = store.createNode({ kind: "note", scope: "test", title: "цикл не проверяем" });
    store.addEdge(b.id, "contradicts", a.id, { weight: 0.93 });
    driver.close();
    drivers.pop();

    const vb = await showJson<ShowView>(dir, b.id);
    expect(vb.contradicts.map((c) => c.id)).toEqual([a.id]);
    // Ребро записано только b → a; с другой стороны его надо ЧИТАТЬ обратно.
    const va = await showJson<ShowView>(dir, a.id);
    expect(va.contradicts.map((c) => c.id)).toEqual([b.id]);

    const out = text((await myc(dir, "show", a.id)).stdout);
    expect(out).toContain(`противоречит ${b.id}`);
  });

  test("без противоречий строка не печатается", async () => {
    const { store, driver } = storeOf(dir);
    const a = store.createNode({ kind: "note", scope: "test", title: "мирный факт" });
    driver.close();
    drivers.pop();
    const v = await showJson<ShowView>(dir, a.id);
    expect(v.contradicts).toEqual([]);
    expect(text((await myc(dir, "show", a.id)).stdout)).not.toContain("противоречит");
  });
});

// ---------------------------------------------------------------------------
// ПРИЁМКА: цепочка переживает слияние. Настоящие процессы.
// ---------------------------------------------------------------------------

interface WorkerOut {
  mode: string;
  id?: string;
  applied?: number;
}

async function spawnWorker(args: string[]): Promise<WorkerOut> {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`воркер упал с кодом ${code}: ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!) as WorkerOut;
}

describe("слияние двух веток оплога: цепочка цела и порядок не важен", () => {
  test(
    "две машины надстроили свою версию над общим предком — обе сходятся к одной цепочке",
    async () => {
      const A = join(dir, "siteA");
      const B = join(dir, "siteB");
      await makeWorkspace(A);
      await makeWorkspace(B);

      // Общий предок и две версии до расхождения — цепочка из трёх на сайте A.
      const { store, driver } = storeOf(A, "site-a");
      const base = buildChain(store, 3, "общая");
      driver.close();
      drivers.pop();

      // B получает предка целиком: это ОДНА история до расхождения.
      const shared = join(dir, "graph-base");
      const da = openSqlite(join(A, ".myc", "myc.db"));
      exportGraph(da, shared);
      da.close();
      await spawnWorker(["--db", join(B, ".myc", "myc.db"), "--site", "site-b", "--mode", "import", "--from", shared]);

      const ancestor = base[2]!;
      // Два НАСТОЯЩИХ процесса, каждый в своей базе, друг о друге не знают.
      const [va, vb] = await Promise.all([
        spawnWorker([
          "--db", join(A, ".myc", "myc.db"), "--site", "site-a", "--mode", "version",
          "--ancestor", ancestor, "--title", "ветка A",
        ]),
        spawnWorker([
          "--db", join(B, ".myc", "myc.db"), "--site", "site-b", "--mode", "version",
          "--ancestor", ancestor, "--title", "ветка B",
        ]),
      ]);
      expect(va.id).toBeDefined();
      expect(vb.id).toBeDefined();

      // Обмен оплогами. Порядок применения у сайтов РАЗНЫЙ: A видит свою
      // ветку первой, B — свою. Именно это и не должно менять итог.
      const gA = join(dir, "graph-a");
      const gB = join(dir, "graph-b");
      for (const [root, out] of [[A, gA], [B, gB]] as const) {
        const d = openSqlite(join(root, ".myc", "myc.db"));
        exportGraph(d, out);
        d.close();
      }
      await spawnWorker(["--db", join(A, ".myc", "myc.db"), "--site", "site-a", "--mode", "import", "--from", gB]);
      await spawnWorker(["--db", join(B, ".myc", "myc.db"), "--site", "site-b", "--mode", "import", "--from", gA]);

      const all = [...base, va.id!, vb.id!].sort();

      const chainA = await showJson<ShowView>(A, ancestor, "--chain");
      const chainB = await showJson<ShowView>(B, ancestor, "--chain");

      // 1. Ни одна версия не потеряна ни на одной машине.
      expect([...chainA.chain!.map((c) => c.id)].sort()).toEqual(all);
      expect([...chainB.chain!.map((c) => c.id)].sort()).toEqual(all);

      // 2. Порядок применения не изменил итог: обе машины видят одно и то же.
      expect(chainB.chain!.map((c) => c.id)).toEqual(chainA.chain!.map((c) => c.id));

      // 3. Актуальная версия одна и та же — расхождения нет.
      const headA = chainA.chain!.find((c) => c.current)!.id;
      const headB = chainB.chain!.find((c) => c.current)!.id;
      expect(headB).toBe(headA);
      expect([va.id, vb.id]).toContain(headA);

      // 4. Развилка не замолчана: обе ветки названы, на обеих машинах одинаково.
      expect(chainA.forked).toBeDefined();
      expect([...chainA.forked!].sort()).toEqual([va.id!, vb.id!].sort());
      expect(chainB.forked).toEqual(chainA.forked!);

      // 5. Режим follow из любого звена даёт ту же голову.
      for (const id of base) {
        expect((await showJson<ShowView>(A, id)).head?.id ?? id).toBe(headA);
        expect((await showJson<ShowView>(B, id)).head?.id ?? id).toBe(headA);
      }

      // 6. Повторный импорт идемпотентен: ничего не добавилось и не съехало.
      await spawnWorker(["--db", join(A, ".myc", "myc.db"), "--site", "site-a", "--mode", "import", "--from", gB]);
      const again = await showJson<ShowView>(A, ancestor, "--chain");
      expect(again.chain!.map((c) => c.id)).toEqual(chainA.chain!.map((c) => c.id));
    },
    120_000,
  );
});
