/**
 * `myc purge` (спека design01 §6.5, задача retention/3): физическое стирание
 * со всеми следами — рёбра каскадом, замыкание, field_clock, counters,
 * pending, FTS — и тумбстоуном op='purge' в оплоге. Повтор идемпотентен.
 *
 * Репликация тумбстоуна проверяется отдельно на pg-стенде
 * (purge.replicates.pg.test.ts): здесь — локальная сторона.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createPurgeCommand } from "./purge.ts";

function registry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createPurgeCommand());
  return r;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-purge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Envelope {
  ok: boolean;
  code?: string;
  data?: Record<string, unknown>;
  error?: { code: string; msg: string; exit: number };
}

async function call(argv: readonly string[]): Promise<Envelope> {
  const out = await run(["--json", "-C", dir, ...argv], {
    registry: registry(),
    env: { MYC_SERVER: "", MYC_TOKEN: "", NO_COLOR: "1" },
  });
  const stdout = typeof out.stdout === "string" ? out.stdout : [...out.stdout].join("");
  return JSON.parse(stdout) as Envelope;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"));
}

let hashSeq = 0;

function seedNode(input: {
  id: string;
  createdAt?: number;
  scope?: string;
  body?: string;
  status?: string;
}): void {
  const d = db();
  try {
    d.prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, status,
                          created_at, updated_at)
       VALUES (?1, 'note', 1, ?2, ?3, ?3, ?4, ?5, ?6, ?6)`,
    ).run(
      input.id,
      input.scope ?? "p",
      input.body ?? `тело ${input.id}`,
      `h-${input.id}-${++hashSeq}`,
      input.status ?? "active",
      input.createdAt ?? 1,
    );
  } finally {
    d.close();
  }
}

function seedEdge(src: string, type: string, dst: string): void {
  const d = db();
  try {
    d.prepare(
      "INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES (?1, ?2, ?3, 'tag-1', 1)",
    ).run(src, type, dst);
  } finally {
    d.close();
  }
}

function seedCold(id: string): void {
  const d = db();
  try {
    d.prepare(
      "INSERT INTO bodies_cold (node_id, raw_len, blob, archived_at) VALUES (?1, 4, x'00', 1)",
    ).run(id);
  } finally {
    d.close();
  }
}

function seedClosure(ancestor: string, descendant: string): void {
  const d = db();
  try {
    d.prepare("INSERT INTO parent_closure (ancestor, descendant, depth) VALUES (?1, ?2, 1)").run(
      ancestor,
      descendant,
    );
  } finally {
    d.close();
  }
}

function seedClockAndCounter(id: string): void {
  const d = db();
  try {
    d.prepare(
      "INSERT INTO field_clock (entity_id, field, hlc, site_id) VALUES (?1, 'title', 1, 's1')",
    ).run(id);
    d.prepare("INSERT INTO counters (entity_id, field, site_id, value) VALUES (?1, 'seen_count', 's1', 3)").run(id);
  } finally {
    d.close();
  }
}

function seedPending(opId: string, needs: string): void {
  const d = db();
  try {
    d.prepare(
      "INSERT INTO oplog_pending (op_id, needs, origin, op, parked_at) VALUES (?1, ?2, 0, '{}', 1)",
    ).run(opId, needs);
  } finally {
    d.close();
  }
}

function count(sql: string): number {
  const d = db();
  try {
    return (d.query(sql).get() as { n: number } | undefined)?.n ?? -1;
  } finally {
    d.close();
  }
}

function ftsHits(word: string): number {
  const d = db();
  try {
    return (
      (d.query("SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH ?").get(word) as
        | { n: number }
        | undefined)?.n ?? -1
    );
  } finally {
    d.close();
  }
}

test("purge --id: узел уходит со ВСЕМИ следами, в оплоге появляется тумбстоун", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedNode({ id: "victim", body: "секретное тело victim" });
  seedNode({ id: "other", body: "живой сосед" });
  seedEdge("victim", "relates", "other");
  seedEdge("other", "relates", "victim");
  seedCold("victim");
  seedClosure("victim", "other");
  seedClockAndCounter("victim");
  seedPending("other:9", "victim");

  const r = await call(["purge", "--id", "victim", "--cascade"]);
  expect(r.ok).toBe(true);
  expect((r.data as { purged: number }).purged).toBe(1);

  // Узла нет; рёбра ушли каскадом; холодная копия, замыкание, часы,
  // счётчик и отложенная операция — тоже. Узел-получатель цел.
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM edges WHERE src = 'victim' OR dst = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM bodies_cold WHERE node_id = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM parent_closure WHERE ancestor = 'victim' OR descendant = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM field_clock WHERE entity_id = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM counters WHERE entity_id = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM oplog_pending WHERE needs = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'other'")).toBe(1);

  // FTS: слово тела стёртого узла больше не находится, у живого — находится.
  expect(ftsHits("секретное")).toBe(0);
  expect(ftsHits("живой")).toBe(1);

  // Тумбстоун в оплоге: op='purge', entity='node', entity_id — узел.
  expect(
    count("SELECT count(*) AS n FROM oplog WHERE op = 'purge' AND entity = 'node' AND entity_id = 'victim'"),
  ).toBe(1);
});

test("повторный purge идемпотентен: ok, purged=0, новых строк нет", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedNode({ id: "victim" });
  expect((await call(["purge", "--id", "victim", "--cascade"])).ok).toBe(true);

  const again = await call(["purge", "--id", "victim", "--cascade"]);
  expect(again.ok).toBe(true);
  expect((again.data as { purged: number }).purged).toBe(0);
  expect(count("SELECT count(*) AS n FROM oplog WHERE op = 'purge'")).toBe(1); // одна строка, не две
});

test("живые рёбра требуют --cascade; без него отказ и узел цел", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedNode({ id: "victim" });
  seedNode({ id: "other" });
  seedEdge("victim", "relates", "other");

  const refused = await call(["purge", "--id", "victim"]);
  expect(refused.ok).toBe(false);
  expect(refused.error?.code).toBe("precond.live_edges");
  expect(refused.error?.exit).toBe(5); // PRECOND
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'victim'")).toBe(1);

  const ok = await call(["purge", "--id", "victim", "--cascade"]);
  expect(ok.ok).toBe(true);
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'victim'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM edges WHERE src = 'victim' OR dst = 'victim'")).toBe(0);
});

test("массовая форма: без --yes отказ; с --yes стирает только свой scope и только старое", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  const week = Date.now() - 7 * 86_400_000;
  const year = Date.now() - 365 * 86_400_000;
  seedNode({ id: "old-in", scope: "p", createdAt: year });
  seedNode({ id: "new-in", scope: "p", createdAt: week });
  seedNode({ id: "old-other", scope: "q", createdAt: year });

  const refused = await call(["purge", "--scope", "p", "--before", "30d"]);
  expect(refused.ok).toBe(false);
  expect(refused.error?.exit).toBe(2); // USAGE

  const dry = await call(["purge", "--scope", "p", "--before", "30d", "--yes", "--dry-run"]);
  expect(dry.ok).toBe(true);
  expect((dry.data as { purged: number; matched: number }).matched).toBe(1); // только old-in
  expect((dry.data as { purged: number }).purged).toBe(0);
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'old-in'")).toBe(1);

  const real = await call(["purge", "--scope", "p", "--before", "30d", "--yes"]);
  expect(real.ok).toBe(true);
  expect((real.data as { purged: number }).purged).toBe(1);
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'old-in'")).toBe(0);
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'new-in'")).toBe(1); // срок не истёк
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'old-other'")).toBe(1); // чужой scope
});

test("неизвестный id — честный отказ", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  const r = await call(["purge", "--id", "nope"]);
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe("notfound.node");
});

test("формы не смешиваются: --id и --scope одновременно — отказ", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  const r = await call(["purge", "--id", "a", "--scope", "p", "--before", "1d"]);
  expect(r.ok).toBe(false);
  expect(r.error?.exit).toBe(2);
});
