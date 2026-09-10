/**
 * Тулы на прямом сторе (link не-dep, release/extend, note/reopen) — против
 * настоящего SQLite во временной директории. CLI-прогоны подменены: здесь
 * проверяется работа с графом, а не argv (это dispatch.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { createDispatcher, type Dispatch } from "./dispatch.ts";
import { openMcpStore } from "./store.ts";

let dir: string;
let d: Dispatch;

function okEnvelope(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, cmd: "test", data, meta: { took_ms: 1, degraded: [] }, warn: [] });
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "mcp-test";
  dir = mkdtempSync(join(tmpdir(), "myc-mcp-store-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  d = createDispatcher({
    runCli: async (argv) => {
      // единственный CLI-вызов на этих путях — update --status open при reopen
      expect(argv[0]).toBe("update");
      return {
        code: 0,
        stdout: okEnvelope({ id: String(argv[1]), kind: "task", type: "task", status: "open", priority: 2, changed: ["status"], took_ms: 1 }),
      };
    },
    openStore: () => openMcpStore(dir),
  });
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

async function makeTask(title: string): Promise<string> {
  const opened = await openMcpStore(dir);
  if (!opened.ok) throw new Error(opened.failure.msg);
  try {
    const node = opened.handle.store.createNode({ kind: "task", scope: "", title });
    return node.id;
  } finally {
    opened.handle.close();
  }
}

async function withStore<T>(fn: (h: import("./store.ts").McpStoreHandle) => T): Promise<T> {
  const opened = await openMcpStore(dir);
  if (!opened.ok) throw new Error(opened.failure.msg);
  try {
    return fn(opened.handle);
  } finally {
    opened.handle.close();
  }
}

describe("myc_link: не-dep рёбра через прямой стор", () => {
  test("relates-to: ребро создано, дубликат — conflict.edge_exists, remove убирает", async () => {
    const a = await makeTask("А");
    const b = await makeTask("Б");

    const r = await d("myc_link", { from: a, type: "relates-to", to: b });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { edge: { from: string; type: string; to: string }; meta: { seq: number } };
    expect(sc.edge.from).toBe(a);
    expect(sc.edge.type).toBe("relates-to");
    expect(sc.edge.to).toBe(b);
    expect(sc.meta.seq).toBeGreaterThan(0);
    await withStore((h) => {
      expect(h.store.getEdge(a, "relates", b)).toBeDefined();
    });

    const dup = await d("myc_link", { from: a, type: "relates-to", to: b });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toContain("conflict.edge_exists");

    const rm = await d("myc_link", { from: a, type: "relates-to", to: b, remove: true });
    expect(rm.isError).toBeUndefined();
    await withStore((h) => {
      // OR-Set: удаление — надгробие, а не исчезновение строки
      const edge = h.store.getEdge(a, "relates", b);
      expect(edge === undefined || edge.deleted_at !== null).toBe(true);
    });
  });

  test("supersedes: reason обязателен, старый узел помечается superseded_by", async () => {
    const oldNode = await makeTask("старое решение");
    const newNode = await makeTask("новое решение");
    const r = await d("myc_link", { from: newNode, type: "supersedes", to: oldNode, reason: "точнее" });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { effects: string[] };
    expect(sc.effects.join(" ")).toContain(`${oldNode} marked superseded_by ${newNode}`);
    await withStore((h) => {
      const n = h.store.getNode(oldNode);
      expect(n?.attrs["superseded_by"]).toBe(newNode);
    });
  });

  test("префикс id резолвится, неоднозначность — usage.ambiguous_id", async () => {
    const a = await makeTask("А");
    const b = await makeTask("Б");
    const prefix = a.split("-")[1]!.slice(0, 6);
    const r = await d("myc_link", { from: prefix, type: "relates-to", to: b });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { edge: { from: string } };
    expect(sc.edge.from).toBe(a);
  });
});

describe("myc_update: note / release / extend / reopen через прямой стор", () => {
  test("note: заметка создана и связана replies_to с задачей", async () => {
    const a = await makeTask("А");
    const r = await d("myc_update", { id: a, op: "note", note: "промежуточный вывод" });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { note_id: string; id: string };
    expect(sc.id).toBe(a);
    await withStore((h) => {
      const note = h.store.getNode(sc.note_id);
      expect(note?.kind).toBe("note");
      expect(note?.body).toBe("промежуточный вывод");
      expect(h.store.getEdge(sc.note_id, "replies_to", a)).toBeDefined();
    });
  });

  test("release: аренда снята, статус возвращён в open; без аренды — precond.no_lease", async () => {
    const a = await makeTask("А");
    await withStore((h) => {
      const ticket = h.claims.claim(a, 60_000);
      expect(ticket).toBeDefined();
      h.store.updateNode(a, { status: "in_progress" });
    });

    const r = await d("myc_update", { id: a, op: "release" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain(`released ${a}`);
    await withStore((h) => {
      const lease = h.store.leaseOf(a);
      expect(lease === undefined || lease.holder.length === 0).toBe(true);
      expect(h.store.getNode(a)?.status).toBe("open");
    });

    const again = await d("myc_update", { id: a, op: "release" });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain("precond.no_lease");
  });

  test("extend: владелец продлевает аренду", async () => {
    const a = await makeTask("А");
    const before = await withStore((h) => {
      const ticket = h.claims.claim(a, 60_000);
      expect(ticket).toBeDefined();
      return h.store.leaseOf(a)!;
    });

    const r = await d("myc_update", { id: a, op: "extend", lease_minutes: 120 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain(`renewed ${a}`);
    await withStore((h) => {
      const lease = h.store.leaseOf(a)!;
      expect(lease.expires).toBeGreaterThan(before.expires);
    });
  });

  test("reopen: статус через CLI, причина — заметкой с replies_to", async () => {
    const a = await makeTask("А");
    const r = await d("myc_update", { id: a, op: "reopen", reason: "нашёлся ещё случай" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("reason saved as note");
    const sc = r.structuredContent as { status: string; meta: { degraded: string[] } };
    expect(sc.status).toBe("open");
    expect(sc.meta.degraded).toEqual([]);
    await withStore((h) => {
      const notes = h.store.edgesTo(a, "replies_to");
      expect(notes).toHaveLength(1);
      expect(h.store.getNode(notes[0]!.src)?.body).toBe("reopen: нашёлся ещё случай");
    });
  });
});
