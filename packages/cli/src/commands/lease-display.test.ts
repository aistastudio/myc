/**
 * Срок аренды для человека и агента (memory-3a4b6d4hax96).
 *
 * Дефект на живом воркспейсе (задачи ввезены из beads): `myc prime` печатал
 *   cherry-8zrq6scngyaf  P2  Onboarding plate: …  @Alex Zverev  until 00:00:00Z (20707d)
 * Две ошибки в одной строке. У задачи из beads со статусом in_progress аренды
 * нет вовсе (lease_expires = 0, lease_holder пуст) — выходила эпоха 1970. А у
 * настоящей аренды скобка считала время С истечения, но «until 12:00 (3h)»
 * читается как «осталось 3 часа»; для живой аренды скобка была нулём.
 *
 * Здесь — одна функция на три случая (fmtLease) и её применение в prime и
 * show на настоящем SQLite: ввоз из beads, живой claim, истёкший claim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createImportBeadsCommand } from "./import-beads.ts";
import { createPrimeCommand } from "./prime.ts";
import { createShowCommand } from "./show.ts";
import { fmtLease, leaseState } from "./store.ts";
import { createClaimCommand, createReleaseCommand, createTaskCommand } from "./tasks.ts";

// ---------------------------------------------------------------------------
// Функция
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-11T09:30:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("fmtLease: три случая, и только три", () => {
  test("аренды нет: lease_expires = 0 и держатель пуст — как у задачи из beads", () => {
    expect(leaseState("", 0, NOW)).toBe("none");
    expect(fmtLease("", 0, NOW)).toBe("no lease");
  });

  test("срок 0 при записанном держателе — «no lease», а не эпоха 1970", () => {
    const s = fmtLease("alice", 0, NOW);
    expect(s).toBe("no lease");
    expect(s).not.toContain("00:00:00Z");
    expect(s).not.toContain("1970");
  });

  test("держатель пуст при ненулевом сроке — аренды тоже нет: продлить и отпустить её некому", () => {
    expect(fmtLease("", NOW + 25 * MIN, NOW)).toBe("no lease");
  });

  test("отсутствующий или битый срок (null, undefined, NaN, отрицательный) — «no lease»", () => {
    expect(fmtLease("alice", null, NOW)).toBe("no lease");
    expect(fmtLease("alice", undefined, NOW)).toBe("no lease");
    expect(fmtLease("alice", Number.NaN, NOW)).toBe("no lease");
    expect(fmtLease("alice", -5, NOW)).toBe("no lease");
  });

  test("аренда действует: часы как у fmtClock и время ДО истечения со словом in", () => {
    expect(leaseState("alice", NOW + 25 * MIN, NOW)).toBe("active");
    expect(fmtLease("alice", NOW + 25 * MIN, NOW)).toBe("until 09:55:00Z (in 25m)");
    expect(fmtLease("alice", NOW + 3 * HOUR, NOW)).toBe("until 12:30:00Z (in 3h)");
  });

  test("аренда истекла: время С истечения, словами «lease expired … ago», без until", () => {
    expect(leaseState("alice", NOW - 3 * HOUR, NOW)).toBe("expired");
    expect(fmtLease("alice", NOW - 3 * HOUR, NOW)).toBe("lease expired 3h ago");
  });

  // Граница — та же, что у CAS захвата (claim_node: чужой claim проходит при
  // `lease_expires < now`) и у ready_expired_candidates: ровно в момент
  // истечения чужой claim ещё отказывает, значит, аренда ещё действует.
  test("граница: истекает ровно сейчас — ещё действует; миллисекундой раньше — истекла", () => {
    expect(leaseState("alice", NOW, NOW)).toBe("active");
    expect(fmtLease("alice", NOW, NOW)).toBe("until 09:30:00Z (in 0s)");
    expect(leaseState("alice", NOW - 1, NOW)).toBe("expired");
    expect(fmtLease("alice", NOW - 1, NOW)).toBe("lease expired 0s ago");
  });
});

// ---------------------------------------------------------------------------
// prime и show на настоящем SQLite
// ---------------------------------------------------------------------------

let dir: string;
let dbPath: string;
let registry: Registry;

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-lease-display-"));
  mkdirSync(join(dir, ".myc"));
  dbPath = join(dir, ".myc", "myc.db");
  const raw = new Database(dbPath, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createImportBeadsCommand());
  registry.register(createTaskCommand());
  registry.register(createClaimCommand());
  registry.register(createPrimeCommand());
  registry.register(createShowCommand());
  registry.register(createReleaseCommand());
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: dir } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const r = await myc(...args, "--json");
  return (JSON.parse(text(r.stdout)) as { data: Record<string, unknown> }).data;
}

/** Секция IN PROGRESS из человеческого вывода prime — до следующего заголовка. */
function inProgressSection(out: string): string {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# IN PROGRESS"));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("# "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** Строка секции IN PROGRESS для задачи с данным id. */
function primeLine(out: string, id: string): string {
  return inProgressSection(out).split("\n").find((l) => l.startsWith(`${id} `)) ?? "";
}

function showLeaseLine(out: string): string {
  return out.split("\n").find((l) => l.startsWith("lease ")) ?? "";
}

/** Ввоз из beads двух задач in_progress — ровно состояние cherry после import-beads. */
async function importInProgress(): Promise<{ assigned: string; unassigned: string }> {
  const snapshot = join(dir, "beads.json");
  writeFileSync(
    snapshot,
    JSON.stringify({
      issues: [
        {
          id: "cherry-8zrq",
          title: "Onboarding plate",
          status: "in_progress",
          priority: 2,
          issue_type: "task",
          assignee: "Alex Zverev",
        },
        { id: "cherry-free", title: "Никем не взятая", status: "in_progress", priority: 2, issue_type: "task" },
      ],
    }),
  );
  const r = await myc("import-beads", snapshot);
  expect(r.code).toBe(0);
  const raw = new Database(dbPath);
  try {
    const idOf = (ref: string): string =>
      (raw.query("SELECT id FROM nodes WHERE json_extract(attrs, '$.external_ref') = ?1").get(ref) as { id: string })
        .id;
    return { assigned: idOf("cherry-8zrq"), unassigned: idOf("cherry-free") };
  } finally {
    raw.close();
  }
}

async function claimedTask(title: string): Promise<string> {
  const created = await data("task", title, "-p", "P1");
  const id = String(created["id"]);
  expect((await myc("claim", id, "--lease", "30m")).code).toBe(0);
  return id;
}

/** «Прошло время»: срок аренды уезжает в прошлое, держатель и эпоха те же. */
function expireLease(id: string, agoMs: number): void {
  const raw = new Database(dbPath);
  try {
    raw.query("UPDATE nodes SET lease_expires = ?1 WHERE id = ?2").run(Date.now() - agoMs, id);
  } finally {
    raw.close();
  }
}

describe("prime: IN PROGRESS говорит правду о сроке аренды", () => {
  test("задача из beads без аренды: «no lease», ни 1970, ни 00:00:00Z, ни «(20707d)»", async () => {
    const { assigned } = await importInProgress();
    const out = text((await myc("prime")).stdout);
    const section = inProgressSection(out);

    expect(primeLine(out, assigned)).toContain("@Alex Zverev  no lease");
    expect(section).not.toContain("1970");
    expect(section).not.toContain("00:00:00Z");
    expect(section).not.toMatch(/\d+d\)/);
    expect(section).not.toContain("until");
  });

  test("задача без исполнителя в IN PROGRESS — «unassigned», а не «free»", async () => {
    const { unassigned } = await importInProgress();
    const out = text((await myc("prime")).stdout);
    expect(primeLine(out, unassigned)).toContain("unassigned  no lease");
    expect(inProgressSection(out)).not.toContain("free");
  });

  test("действующая аренда: «until HH:MM:SSZ (in …)» — время ДО истечения", async () => {
    const id = await claimedTask("Взятая задача");
    const line = primeLine(text((await myc("prime")).stdout), id);
    expect(line).toContain("@tester");
    expect(line).toMatch(/until \d{2}:\d{2}:\d{2}Z \(in (29|30)m\)$/);
  });

  test("истёкшая аренда: «lease expired 3h ago», без until", async () => {
    const id = await claimedTask("Брошенная задача");
    expireLease(id, 3 * HOUR + 5 * MIN);
    const line = primeLine(text((await myc("prime")).stdout), id);
    expect(line).toContain("@tester  lease expired 3h ago");
    expect(line).not.toContain("until");
  });

  test("--json не ломается: lease_expires остаётся числом, у ввезённой — 0", async () => {
    const { assigned } = await importInProgress();
    const claimed = await claimedTask("Взятая задача");
    const rows = (await data("prime"))["in_progress"] as {
      id: string;
      lease_expires: unknown;
      lease_holder: unknown;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(assigned)!.lease_expires).toBe(0);
    expect(byId.get(assigned)!.lease_holder).toBe("");
    expect(typeof byId.get(claimed)!.lease_expires).toBe("number");
    expect(byId.get(claimed)!.lease_expires as number).toBeGreaterThan(Date.now());
    expect(byId.get(claimed)!.lease_holder).toBe("tester");
  });
});

describe("show: строка lease — та же функция", () => {
  test("задача из beads в работе без аренды — «lease     no lease»", async () => {
    const { assigned } = await importInProgress();
    const out = text((await myc("show", assigned)).stdout);
    expect(showLeaseLine(out)).toBe("lease     no lease");
    expect(out).not.toContain("00:00:00Z");
  });

  test("действующая аренда — держатель и «until … (in …)»", async () => {
    const id = await claimedTask("Взятая задача");
    const line = showLeaseLine(text((await myc("show", id)).stdout));
    expect(line).toMatch(/^lease {5}tester · until \d{2}:\d{2}:\d{2}Z \(in (29|30)m\)$/);
  });

  test("истёкшая аренда — держатель и «lease expired … ago»", async () => {
    const id = await claimedTask("Брошенная задача");
    expireLease(id, 3 * HOUR + 5 * MIN);
    const line = showLeaseLine(text((await myc("show", id)).stdout));
    expect(line).toBe("lease     tester · lease expired 3h ago");
  });

  test("открытая задача без аренды строки lease не получает: сказать нечего", async () => {
    const created = await data("task", "Открытая", "-p", "P1");
    const out = text((await myc("show", String(created["id"]))).stdout);
    expect(showLeaseLine(out)).toBe("");
  });
});

// Итог секции — все задачи в работе, а не показанные: заголовок «IN PROGRESS 3»
// стоял на cherry над 37 задачами в работе (строки режет лимит 3).
describe("prime: IN PROGRESS считает всех, а не показанных", () => {
  test("пять в работе при лимите 3 — «IN PROGRESS 3 of 5», в --json in_progress_total = 5", async () => {
    for (let i = 0; i < 5; i++) await claimedTask(`В работе ${i}`);
    expect(text((await myc("prime")).stdout)).toContain("# IN PROGRESS 3 of 5\n");
    const d = await data("prime");
    expect(d["in_progress_total"]).toBe(5);
    expect(d["in_progress"] as unknown[]).toHaveLength(3);
  });

  test("две в работе — «IN PROGRESS 2», без «of»", async () => {
    for (let i = 0; i < 2; i++) await claimedTask(`В работе ${i}`);
    const out = text((await myc("prime")).stdout);
    expect(out).toContain("# IN PROGRESS 2\n");
    expect(out).not.toContain("IN PROGRESS 2 of");
  });
});

describe("release чужой аренды: срок — та же fmtLease", () => {
  // Актор берётся и из process.env (beforeEach ставит там tester), поэтому
  // «другой» подменяется на время одного вызова в обоих местах.
  const asOther = async (...args: string[]): Promise<RunResult> => {
    process.env.MYC_ACTOR = "someone-else";
    try {
      return await run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "someone-else", MYC_HOME: dir } });
    } finally {
      process.env.MYC_ACTOR = "tester";
    }
  };

  test("истёкшая чужая аренда — «lease expired … ago», а не «lease until»", async () => {
    const id = await claimedTask("Брошенная чужая");
    expireLease(id, 3 * HOUR + 5 * MIN);
    const r = await asOther("release", id);
    expect(r.code).toBe(4); // conflict: чужую аренду отпускают только явно
    const err = `${r.stderr ?? ""}${text(r.stdout)}`;
    expect(err).toContain("is claimed by tester, lease expired 3h ago");
    expect(err).not.toContain("lease until");
  });

  test("живая чужая аренда — «until … (in …)»", async () => {
    const id = await claimedTask("Взятая чужая");
    const r = await asOther("release", id);
    expect(r.code).toBe(4);
    const err = `${r.stderr ?? ""}${text(r.stdout)}`;
    expect(err).toMatch(/is claimed by tester, until \d{2}:\d{2}:\d{2}Z \(in (29|30)m\)/);
  });
});
