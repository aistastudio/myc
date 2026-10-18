/**
 * `myc prune` (спека design01 §6.5, задача retention/1): два удаления по
 * возрасту, ни одно не трогает граф, оплог уходит только подтверждённый
 * пирами. Ключевые случаи — из приёмки: недистиллированный эпизод
 * переживает prune (его тело не в bodies_cold, пока его не свернули),
 * неподтверждённый оплог не уходит никогда, без пиров — не уходит вовсе.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createPruneCommand, renderPruneHuman } from "./prune.ts";

const DAY = 86_400_000;

function registry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createPruneCommand());
  return r;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-prune-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Envelope {
  ok: boolean;
  data?: Record<string, number | boolean>;
  error?: { code: string; msg: string };
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

function seedNode(id: string, body: string): void {
  const d = db();
  try {
    d.prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, created_at, updated_at)
       VALUES (?1, 'session', 0, 'p', ?2, ?2, ?3, 1, 1)`,
    ).run(id, body, `h-${id}`);
  } finally {
    d.close();
  }
}

function seedCold(id: string, daysAgo: number): void {
  const d = db();
  try {
    d.prepare("INSERT INTO bodies_cold (node_id, raw_len, blob, archived_at) VALUES (?1, 4, x'00', ?2)").run(
      id,
      Date.now() - daysAgo * DAY,
    );
  } finally {
    d.close();
  }
}

function seedOp(tsDaysAgo: number, hlcBase: number): void {
  const d = db();
  try {
    d.prepare(
      `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, op, entity, entity_id, scope)
       VALUES (?1, 's1', ?2, ?3, 'set', 'node', 'n1', 'p')`,
    ).run(`s1:${hlcBase}`, hlcBase, Date.now() - tsDaysAgo * DAY);
  } finally {
    d.close();
  }
}

function seedPeer(site: string, lastSeqSent: number): void {
  const d = db();
  try {
    d.prepare("INSERT INTO sync_state (peer_site_id, last_seq_sent) VALUES (?1, ?2)").run(site, lastSeqSent);
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

test("приёмка: недистиллированный эпизод переживает prune, старое холодное тело уходит", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedNode("session1", "тело эпизода, которое ещё не свёрнули");
  seedNode("cold1", "давно закрытая задача");
  seedCold("cold1", 181);
  seedNode("cold2", "недавно утёкшее тело");
  seedCold("cold2", 10); // срок не истёк — трогать нельзя

  const r = await call(["prune"]);
  expect(r.ok).toBe(true);
  expect(r.data!.bodies_removed).toBe(1);
  expect(count("SELECT count(*) AS n FROM bodies_cold")).toBe(1); // только cold2 (10 дней)
  // Узлы целы: у эпизода тело на месте, у раскомпактированного — нет, но узел есть.
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'session1' AND body != ''")).toBe(1);
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'cold1'")).toBe(1);
});

test("оплог уходит только подтверждённый всеми пирами и только старый", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  // Свежая ПЕРВОЙ (seq1): подтверждение min(2, 4) = 2 её накрывает, и только
  // возрастная ограждение держит её в живых — снимешь её, и мутация поймана.
  seedOp(1, 900_000); // свежая
  for (let i = 0; i < 6; i++) seedOp(31, (i + 1) * 1000); // все старше срока
  seedPeer("p1", 2);
  seedPeer("p2", 4); // подтверждение обоих — min(2, 4) = 2

  const r = await call(["prune"]);
  expect(r.ok).toBe(true);
  expect(r.data!.peers).toBe(2);
  expect(r.data!.ops_removed).toBe(1); // только seq2: старая и подтверждённая
  expect(count("SELECT count(*) AS n FROM oplog")).toBe(6); // свежая + seq3..7
});

test("без пиров оплог не трогается, и причина называется", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  for (let i = 0; i < 3; i++) seedOp(40, (i + 1) * 1000);

  const r = await call(["prune"]);
  expect(r.ok).toBe(true);
  expect(r.data!.peers).toBe(0);
  expect(r.data!.ops_removed).toBe(0);
  expect(count("SELECT count(*) AS n FROM oplog")).toBe(3);
  const human = renderPruneHuman({ ...r.data, took_ms: 0 });
  expect(human).toContain("no peers in sync_state");
});

test("dry-run считает ровно то, что удалил бы, и ничего не меняет", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedNode("cold1", "x");
  seedCold("cold1", 200);

  const dry = await call(["prune", "--dry-run"]);
  expect(dry.ok).toBe(true);
  expect(dry.data!.dry).toBe(true);
  expect(dry.data!.bodies_removed).toBe(1);
  expect(count("SELECT count(*) AS n FROM bodies_cold")).toBe(1); // не тронуто

  const real = await call(["prune"]);
  expect(real.data!.bodies_removed).toBe(1);
  expect(count("SELECT count(*) AS n FROM bodies_cold")).toBe(0);
});

test("тумбстоуны purge переживают прун: подтверждённые и старые остаются", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  // Три строки: обычная подтверждённая старая (уйдёт), свежая (останется)
  // и тумбстоун purge — старый И подтверждённый, то есть из тех, что уходили
  // бы без исключения §6.5 (retention/3).
  seedOp(31, 1000);
  seedOp(1, 2000);
  const d = db();
  try {
    d.prepare(
      `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, op, entity, entity_id, scope)
       VALUES ('s1:500', 's1', 500, ?1, 'purge', 'node', 'stертый', 'p')`,
    ).run(Date.now() - 31 * DAY);
  } finally {
    d.close();
  }
  seedPeer("p1", 9999); // подтверждение покрывает все seq

  const r = await call(["prune"]);
  expect(r.ok).toBe(true);
  expect(r.data!.ops_removed).toBe(1); // только обычная старая
  expect(count("SELECT count(*) AS n FROM oplog WHERE op = 'purge'")).toBe(1);
  const human = renderPruneHuman({ ...(r.data as object), took_ms: 0 });
  expect(human).toContain("purge tombstone(s) kept");
});

test("свежая база: малая фрагментация — VACUUM не делается", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  const r = await call(["prune"]);
  expect(r.ok).toBe(true);
  expect(r.data!.vacuumed).toBe(false);
});
