/**
 * `myc import-beads` (myc-5ie.1): маппинг снапшота beads в граф myc,
 * вербатим текстов, external_ref, идемпотентность.
 *
 * Против настоящего SQLite во временных директориях: импорт через публичный
 * run(), проверки — прямым чтением стора (attrs недоступны через myc show).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import type { CommandContext } from "../registry.ts";
import type { Envelope } from "../envelope.ts";
import { ExitCode } from "../exit.ts";
import { openStore, type StoreHandle } from "./store.ts";
import {
  collectBeadsSnapshot,
  createImportBeadsCommand,
  importBeadsSnapshot,
  parseBeadsSnapshot,
  type BeadsSnapshot,
} from "./import-beads.ts";

let projectDir: string;
let registry: Registry;
let snapshotPath: string;

const SNAPSHOT: BeadsSnapshot = {
  issues: [
    {
      id: "myc-a1",
      title: "Эпик верхнего уровня",
      description: "Описание эпика со ссылкой на myc-a2 — не переписывать.",
      status: "open",
      priority: 0,
      issue_type: "epic",
      labels: ["core", "m0"],
    },
    {
      id: "myc-a2",
      title: "Задача с закрытым блокером",
      description: "Зависит от myc-a3.",
      status: "open",
      priority: 1,
      issue_type: "task",
      dependencies: [
        { id: "myc-a3", dependency_type: "blocks" },
        { id: "myc-a1", dependency_type: "parent-child" },
      ],
    },
    {
      id: "myc-a3",
      title: "Закрытый баг",
      description: "Тело закрытого.",
      status: "closed",
      priority: 1,
      issue_type: "bug",
      close_reason: "починено в myc-a2, ссылка остаётся текстом",
      closed_at: "2026-09-01T10:00:00Z",
      notes: "Заметка приёмщика: смотри myc-a1.",
    },
    {
      id: "myc-a4",
      title: "Фича в работе",
      status: "in_progress",
      priority: 2,
      issue_type: "feature",
      assignee: "agent7",
    },
    {
      id: "myc-a5",
      title: "Задача с открытым блокером",
      status: "open",
      priority: 3,
      issue_type: "task",
      dependencies: [{ id: "myc-a1", dependency_type: "blocks" }],
    },
  ],
  memories: {
    "key-one": "Первая память проекта.\nВторая строка той же памяти.",
  },
};

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  projectDir = mkdtempSync(join(tmpdir(), "myc-import-beads-"));
  mkdirSync(join(projectDir, ".myc"));
  const raw = new Database(join(projectDir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  snapshotPath = join(projectDir, "snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT));

  registry = new Registry();
  registry.register(createImportBeadsCommand());
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(projectDir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", projectDir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function mycJson(...args: string[]): Promise<Envelope> {
  const r = await myc("--json", ...args);
  return JSON.parse(typeof r.stdout === "string" ? r.stdout : "") as Envelope;
}

function fakeCtx(): CommandContext {
  return {
    args: [],
    flags: {},
    globals: { json: false, ndjson: false, strict: false, quiet: false, color: false, directory: projectDir },
    warn: () => {},
    diagnostics: { warnings: [] } as never,
  };
}

async function withStore<T>(fn: (h: StoreHandle) => T): Promise<T> {
  const opened = await openStore(fakeCtx());
  if (!opened.ok) throw new Error(opened.failure.msg);
  try {
    return fn(opened.handle);
  } finally {
    opened.handle.close();
  }
}

/** id узла по external_ref; undefined — узла нет. */
async function idByRef(ref: string): Promise<string | undefined> {
  return withStore((h) => {
    for (const kind of ["task", "note"] as const) {
      for (const n of h.store.listNodes(h.scope, kind, 10000)) {
        if (n.attrs["external_ref"] === ref) return n.id;
      }
    }
    return undefined;
  });
}

describe("импорт: узлы, поля, вербатим", () => {
  test("все сущности созданы с верными полями; исходный ID — в external_ref", async () => {
    const env = await mycJson("import-beads", snapshotPath);
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d["issues_total"]).toBe(5);
    expect(d["tasks_created"]).toBe(5);
    expect(d["edges_created"]).toBe(3);
    expect(d["notes_created"]).toBe(1);
    expect(d["memories_created"]).toBe(1);
    expect(d["missing_refs"]).toEqual([]);

    await withStore((h) => {
      const byRef = new Map<string, string>();
      for (const n of h.store.listNodes(h.scope, "task", 10000)) {
        byRef.set(String(n.attrs["external_ref"]), n.id);
      }
      expect(byRef.size).toBe(5);

      const epic = h.store.getNode(byRef.get("myc-a1")!)!;
      expect(epic.kind).toBe("task");
      expect(epic.attrs["type"]).toBe("epic");
      expect(epic.priority).toBe(0);
      expect(epic.status).toBe("open");
      expect(epic.attrs["tags"]).toEqual(["core", "m0"]);
      // вербатим: ссылка myc-a2 в тексте НЕ переписана на новый id
      expect(epic.body).toBe("Описание эпика со ссылкой на myc-a2 — не переписывать.");

      const closedBug = h.store.getNode(byRef.get("myc-a3")!)!;
      expect(closedBug.status).toBe("closed");
      expect(closedBug.closed_at).toBe(Date.parse("2026-09-01T10:00:00Z"));
      expect(closedBug.attrs["outcome"]).toEqual({ reason: "починено в myc-a2, ссылка остаётся текстом" });

      const feature = h.store.getNode(byRef.get("myc-a4")!)!;
      expect(feature.status).toBe("in_progress");
      expect(feature.assignee).toBe("agent7");
      expect(feature.body).toBeNull();
    });
  });

  test("рёбра: blocks — блокер → блокируемый; parent — ребёнок → родитель", async () => {
    await mycJson("import-beads", snapshotPath);
    await withStore((h) => {
      const a1 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a1")!;
      const a2 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a2")!;
      const a3 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a3")!;
      const a5 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a5")!;

      expect(h.store.getEdge(a3.id, "blocks", a2.id)).toBeDefined();
      expect(h.store.getEdge(a2.id, "parent", a1.id)).toBeDefined();
      expect(h.store.getEdge(a1.id, "blocks", a5.id)).toBeDefined();

      // закрытый блокер не держит: a2 ready; открытый — держит: a5 заблокирована
      expect(a2.open_blockers).toBe(0);
      expect(a5.open_blockers).toBe(1);
    });
  });

  test("заметка bd note → note с replies_to; память bd remember → note L3", async () => {
    await mycJson("import-beads", snapshotPath);
    await withStore((h) => {
      const notes = h.store.listNodes(h.scope, "note", 10000);
      const comment = notes.find((n) => n.attrs["external_ref"] === "myc-a3#notes")!;
      expect(comment.attrs["type"]).toBe("comment");
      expect(comment.body).toBe("Заметка приёмщика: смотри myc-a1.");
      const a3 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a3")!;
      expect(h.store.getEdge(comment.id, "replies_to", a3.id)).toBeDefined();

      const memory = notes.find((n) => n.attrs["external_ref"] === "bd-remember:key-one")!;
      expect(memory.kind).toBe("note");
      expect(memory.layer).toBe(3);
      expect(memory.attrs["memory_key"]).toBe("key-one");
      expect(memory.body).toBe("Первая память проекта.\nВторая строка той же памяти.");
    });
  });
});

describe("идемпотентность и dry-run", () => {
  test("повторный импорт ничего не создаёт и не дублирует", async () => {
    await mycJson("import-beads", snapshotPath);
    const second = await mycJson("import-beads", snapshotPath);
    const d = second.data as Record<string, number>;
    expect(d["tasks_created"]).toBe(0);
    expect(d["edges_created"]).toBe(0);
    expect(d["notes_created"]).toBe(0);
    expect(d["memories_created"]).toBe(0);
    expect(d["tasks_existing"]).toBe(5);
    expect(d["edges_existing"]).toBe(3);
    expect(d["notes_existing"]).toBe(1);
    expect(d["memories_existing"]).toBe(1);

    await withStore((h) => {
      expect(h.store.listNodes(h.scope, "task", 10000)).toHaveLength(5);
      expect(h.store.listNodes(h.scope, "note", 10000)).toHaveLength(2);
    });
  });

  test("--dry-run считает, но не пишет", async () => {
    const env = await mycJson("import-beads", snapshotPath, "--dry-run");
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d["dry_run"]).toBe(true);
    expect(d["tasks_created"]).toBe(5);
    await withStore((h) => {
      expect(h.store.listNodes(h.scope, "task", 10000)).toHaveLength(0);
      expect(h.store.listNodes(h.scope, "note", 10000)).toHaveLength(0);
    });
  });
});

describe("синхронизация: повторный импорт сходится со снимком (myc-5ie.3)", () => {
  function writeSnapshot(name: string, snap: BeadsSnapshot): string {
    const p = join(projectDir, name);
    writeFileSync(p, JSON.stringify(snap));
    return p;
  }

  function withIssue(snap: BeadsSnapshot, id: string, patch: Record<string, unknown>): BeadsSnapshot {
    return {
      ...snap,
      issues: snap.issues.map((i) => (i.id === id ? ({ ...i, ...patch } as typeof i) : i)),
    };
  }

  test("закрытие в beads доезжает: статус, closed_at, outcome; блокируемый уходит из blocked", async () => {
    await mycJson("import-beads", snapshotPath);
    // myc-a1 закрыт в beads (он держал myc-a5), у myc-a2 новый приоритет и метки
    let snap2 = withIssue(SNAPSHOT, "myc-a1", {
      status: "closed",
      close_reason: "эпик завершён",
      closed_at: "2026-09-03T12:00:00Z",
    });
    snap2 = withIssue(snap2, "myc-a2", { priority: 3, labels: ["ux", "cli"] });
    const env = await mycJson("import-beads", writeSnapshot("snap2.json", snap2));
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d["tasks_created"]).toBe(0);
    expect(d["tasks_updated"]).toBe(2);
    expect(d["conflicts"]).toEqual([]);

    await withStore((h) => {
      const tasks = h.store.listNodes(h.scope, "task", 10000);
      const byRef = new Map(tasks.map((n) => [String(n.attrs["external_ref"]), n]));
      const a1 = byRef.get("myc-a1")!;
      expect(a1.status).toBe("closed");
      expect(a1.closed_at).toBe(Date.parse("2026-09-03T12:00:00Z"));
      expect(a1.attrs["outcome"]).toEqual({ reason: "эпик завершён" });

      const a2 = byRef.get("myc-a2")!;
      expect(a2.priority).toBe(3);
      expect(a2.attrs["tags"]).toEqual(["cli", "ux"]);

      // закрытый блокер больше не держит: a5 разблокирована движком
      expect(byRef.get("myc-a5")!.open_blockers).toBe(0);
    });
  });

  test("снятая в beads зависимость удаляет ребро; новая — добавляет", async () => {
    await mycJson("import-beads", snapshotPath);
    let snap2 = withIssue(SNAPSHOT, "myc-a5", { dependencies: [] });
    snap2 = withIssue(snap2, "myc-a4", {
      dependencies: [{ id: "myc-a3", dependency_type: "blocks" }],
    });
    const env = await mycJson("import-beads", writeSnapshot("snap2.json", snap2));
    const d = env.data as Record<string, unknown>;
    expect(d["edges_removed"]).toBe(1);
    expect(d["edges_created"]).toBe(1);

    await withStore((h) => {
      const tasks = h.store.listNodes(h.scope, "task", 10000);
      const byRef = new Map(tasks.map((n) => [String(n.attrs["external_ref"]), n]));
      const a1 = byRef.get("myc-a1")!;
      const a3 = byRef.get("myc-a3")!;
      const a4 = byRef.get("myc-a4")!;
      const a5 = byRef.get("myc-a5")!;
      const removed = h.store.getEdge(a1.id, "blocks", a5.id);
      expect(removed === undefined || removed.deleted_at !== null).toBe(true);
      expect(h.store.getEdge(a3.id, "blocks", a4.id)?.deleted_at ?? null).toBeNull();
      expect(a5.open_blockers).toBe(0);
      expect(a4.open_blockers).toBe(0); // a3 закрыта — не держит
    });
  });

  test("узел, изменённый только в myc, не затирается; расхождение названо; оплог не растёт", async () => {
    await mycJson("import-beads", snapshotPath);
    await withStore((h) => {
      const a2 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a2")!;
      h.store.updateNode(a2.id, { title: "Локальное переименование" });
    });
    const opsBefore = await withStore((h) => h.store.oplogCount());
    const env = await mycJson("import-beads", snapshotPath);
    const d = env.data as Record<string, unknown>;
    expect(d["tasks_updated"]).toBe(0);
    expect((d["kept_local"] as string[]).some((s) => s.startsWith("myc-a2.title"))).toBe(true);
    expect(d["conflicts"]).toEqual([]);

    await withStore((h) => {
      const a2 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a2")!;
      expect(a2.title).toBe("Локальное переименование");
      expect(h.store.oplogCount()).toBe(opsBefore);
    });
  });

  test("конфликт: обе стороны изменили поле — не применяется, называется на каждом прогоне", async () => {
    await mycJson("import-beads", snapshotPath);
    await withStore((h) => {
      const a2 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a2")!;
      h.store.updateNode(a2.id, { title: "Локальная версия" });
    });
    const snap2 = withIssue(SNAPSHOT, "myc-a2", { title: "Версия beads" });
    const p2 = writeSnapshot("snap2.json", snap2);

    const first = await mycJson("import-beads", p2);
    const conflicts1 = (first.data as Record<string, unknown>)["conflicts"] as string[];
    expect(conflicts1.some((s) => s.startsWith("myc-a2.title: конфликт"))).toBe(true);

    await withStore((h) => {
      const a2 = h.store.listNodes(h.scope, "task", 10000).find((n) => n.attrs["external_ref"] === "myc-a2")!;
      expect(a2.title).toBe("Локальная версия");
    });

    // слепок при конфликте не двигается — расхождение называется снова
    const second = await mycJson("import-beads", p2);
    const conflicts2 = (second.data as Record<string, unknown>)["conflicts"] as string[];
    expect(conflicts2.some((s) => s.startsWith("myc-a2.title: конфликт"))).toBe(true);
  });

  test("прогон без изменений в источнике не порождает ни одной мутации в оплоге", async () => {
    await mycJson("import-beads", snapshotPath);
    const opsBefore = await withStore((h) => h.store.oplogCount());
    const second = await mycJson("import-beads", snapshotPath);
    const d = second.data as Record<string, unknown>;
    expect(d["tasks_created"]).toBe(0);
    expect(d["tasks_updated"]).toBe(0);
    expect(d["fields_updated"]).toBe(0);
    expect(d["edges_created"]).toBe(0);
    expect(d["edges_removed"]).toBe(0);
    expect(d["notes_created"]).toBe(0);
    expect(d["memories_created"]).toBe(0);
    expect(d["conflicts"]).toEqual([]);
    expect(d["kept_local"]).toEqual([]);
    await withStore((h) => expect(h.store.oplogCount()).toBe(opsBefore));
  });
});

describe("формы вывода bd: три ловушки на фактическом выводе (myc-5ie.4)", () => {
  const FIXTURES = join(import.meta.dir, "import-beads.fixtures");

  test("bd show --json возвращает массив с одним элементом — разворачивается", () => {
    // packages/cli/src/commands/import-beads.fixtures/bd-show-single.json —
    // вербатим `bd show myc-dze.2 --json` этого репозитория
    const raw = JSON.parse(readFileSync(join(FIXTURES, "bd-show-single.json"), "utf8")) as unknown;
    expect(Array.isArray(raw)).toBe(true);
    const snap = parseBeadsSnapshot(JSON.stringify({ issues: [raw] }));
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0]!.id).toBe("myc-dze.2");
    expect(snap.issues[0]!.status).toBe("closed");
    expect(snap.issues[0]!.close_reason).toBeTruthy();
    expect(snap.issues[0]!.dependencies?.[0]?.id).toBe("myc-dze");
  });

  test("bd memories --json: служебный schema_version игнорируется, а не роняет разбор", () => {
    // вербатим `bd memories --json` этого репозитория
    const raw = JSON.parse(readFileSync(join(FIXTURES, "bd-memories.json"), "utf8")) as Record<string, unknown>;
    expect(typeof raw["schema_version"]).not.toBe("string");
    const snap = parseBeadsSnapshot(JSON.stringify({ issues: [], memories: raw }));
    expect(snap.memories?.["schema_version"]).toBeUndefined();
    expect(Object.keys(snap.memories ?? {}).length).toBeGreaterThan(0);
  });

  test("bd list --json: зависимости {depends_on_id, type} приводятся к форме show", () => {
    // вербатим один элемент `bd list --json` этого репозитория
    const entry = JSON.parse(readFileSync(join(FIXTURES, "bd-list-entry.json"), "utf8")) as Record<string, unknown>;
    const deps = entry["dependencies"] as Record<string, unknown>[];
    expect(deps[0]!["depends_on_id"]).toBe("myc-5ie");
    expect(deps[0]!["id"]).toBeUndefined();
    const snap = parseBeadsSnapshot(JSON.stringify({ issues: [entry] }));
    expect(snap.issues[0]!.dependencies).toEqual([{ id: "myc-5ie", dependency_type: "parent-child" }]);
  });

  test("collectBeadsSnapshot собирает снимок этого репозитория без ручных шагов", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    let snap: BeadsSnapshot;
    try {
      snap = collectBeadsSnapshot(repoRoot);
    } catch (e) {
      // bd недоступен в этом окружении — проверять нечего
      if (String(e).includes("bd не запустился")) return;
      throw e;
    }
    expect(snap.issues.length).toBeGreaterThan(0);
    // закрытые тоже в снимке — без них синхронизация закрытий не работает
    expect(snap.issues.some((i) => i.status === "closed")).toBe(true);
    expect(snap.memories?.["schema_version"]).toBeUndefined();
  });
});

describe("ошибки ввода", () => {
  test("без аргумента снимок собирается через bd; вне beads-репозитория — precond", async () => {
    const noArg = await myc("import-beads");
    expect(noArg.code).toBe(ExitCode.PRECOND);

    const missing = await myc("import-beads", join(projectDir, "nope.json"));
    expect(missing.code).toBe(ExitCode.NOTFOUND);

    const badPath = join(projectDir, "bad.json");
    writeFileSync(badPath, "{not json");
    const bad = await myc("import-beads", badPath);
    expect(bad.code).toBe(ExitCode.PRECOND);
  });

  test("parseBeadsSnapshot отвергает невалидные записи", () => {
    expect(() => parseBeadsSnapshot("{}")).toThrow(/issues/);
    expect(() =>
      parseBeadsSnapshot(JSON.stringify({ issues: [{ id: "x", title: "t", status: "weird", priority: 1, issue_type: "task" }] })),
    ).toThrow(/status/);
    // приоритет-НЕ-ЧИСЛО — порча формата, отказ; приоритет ВНЕ ШКАЛЫ —
    // свойство чужих данных (у beads P0..P4), он прижимается и называется
    expect(() =>
      parseBeadsSnapshot(
        JSON.stringify({ issues: [{ id: "x", title: "t", status: "open", priority: "P1", issue_type: "task" }] }),
      ),
    ).toThrow(/приоритет/);
    const clamped = parseBeadsSnapshot(
      JSON.stringify({ issues: [{ id: "x", title: "t", status: "open", priority: 9, issue_type: "task" }] }),
    );
    expect(clamped.issues[0]!.priority).toBe(3);
    expect(clamped.clampedPriorities).toEqual(["x: P9→P3"]);
    expect(() =>
      parseBeadsSnapshot(
        JSON.stringify({
          issues: [
            { id: "x", title: "t", status: "open", priority: 1, issue_type: "task" },
            { id: "x", title: "t2", status: "open", priority: 1, issue_type: "task" },
          ],
        }),
      ),
    ).toThrow(/дубль/);
  });
});

/**
 * Столкновение идентичностей (memory-7kk9vpa8x3en). Дедупликация myc по
 * (scope, kind, content_hash) написана под память: одинаковый текст — один
 * и тот же факт. У записи чужого трекера идентичность даёт его id, и на
 * настоящих данных ~/src/cherry это ломало ввоз ЦЕЛИКОМ: две живые задачи
 * с дословно одинаковым текстом и 108 повторяющихся заметок `bd note`
 * давали `UNIQUE constraint failed`, ноль ввезённых, `internal.unexpected`.
 */
describe("столкновение по содержимому", () => {
  const CLASH: BeadsSnapshot = {
    issues: [
      {
        id: "myc-c1",
        title: "Admin redesign Phase 1",
        description: "Один и тот же текст у двух разных задач трекера.",
        status: "in_progress",
        priority: 2,
        issue_type: "task",
        notes: "Agent: general-purpose",
      },
      {
        id: "myc-c2",
        title: "Admin redesign Phase 1",
        description: "Один и тот же текст у двух разных задач трекера.",
        status: "open",
        priority: 2,
        issue_type: "task",
        notes: "Agent: general-purpose",
      },
      {
        id: "myc-c3",
        title: "Третья, своим текстом",
        status: "open",
        priority: 2,
        issue_type: "task",
        dependencies: [{ id: "myc-c2", dependency_type: "blocks" }],
      },
    ],
    memories: { "mem-a": "Один и тот же текст памяти.", "mem-b": "Другой текст памяти." },
  };

  test("две задачи с одинаковым текстом ввозятся обе, каждая со своим статусом", async () => {
    const p = join(projectDir, "clash.json");
    writeFileSync(p, JSON.stringify(CLASH));
    const env = await mycJson("import-beads", p);
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d["tasks_created"]).toBe(3);
    expect(d["skipped"]).toEqual([]);

    await withStore((h) => {
      const byRef = new Map(
        h.store.listNodes(h.scope, "task", 10000).map((n) => [String(n.attrs["external_ref"]), n]),
      );
      expect(byRef.size).toBe(3);
      expect(byRef.get("myc-c1")!.status).toBe("in_progress");
      expect(byRef.get("myc-c2")!.status).toBe("open");
      // разные узлы, а не один переиспользованный
      expect(byRef.get("myc-c1")!.id).not.toBe(byRef.get("myc-c2")!.id);
      expect(byRef.get("myc-c1")!.content_hash).toBe(byRef.get("myc-c2")!.content_hash);
    });
  });

  test("одинаковые заметки bd note у разных задач ввозятся обе", async () => {
    const p = join(projectDir, "clash.json");
    writeFileSync(p, JSON.stringify(CLASH));
    const d = (await mycJson("import-beads", p)).data as Record<string, unknown>;
    expect(d["notes_created"]).toBe(2);

    await withStore((h) => {
      const notes = h.store.listNodes(h.scope, "note", 10000);
      const c1 = notes.find((n) => n.attrs["external_ref"] === "myc-c1#notes")!;
      const c2 = notes.find((n) => n.attrs["external_ref"] === "myc-c2#notes")!;
      expect(c1.body).toBe("Agent: general-purpose");
      expect(c2.body).toBe("Agent: general-purpose");
      expect(c1.id).not.toBe(c2.id);
      // каждая висит на СВОЕЙ задаче — иначе заметка приписана чужой работе
      const tasks = h.store.listNodes(h.scope, "task", 10000);
      const t1 = tasks.find((n) => n.attrs["external_ref"] === "myc-c1")!;
      const t2 = tasks.find((n) => n.attrs["external_ref"] === "myc-c2")!;
      expect(h.store.getEdge(c1.id, "replies_to", t1.id)).toBeDefined();
      expect(h.store.getEdge(c2.id, "replies_to", t2.id)).toBeDefined();
    });
  });

  test("дедупликация СВОИХ узлов по содержимому жива: второй такой же не создаётся", async () => {
    await withStore((h) => {
      h.store.createNode({
        kind: "note",
        scope: h.scope,
        layer: 3,
        title: "Свой факт",
        body: "Одинаковый текст — один и тот же факт.",
        actor: "tester",
      });
      expect(() =>
        h.store.createNode({
          kind: "note",
          scope: h.scope,
          layer: 3,
          title: "Свой факт",
          body: "Одинаковый текст — один и тот же факт.",
          actor: "tester",
        }),
      ).toThrow(/UNIQUE constraint failed/);
    });
  });

  test("столкновение с локальным узлом НАЗВАНО и не обрывает ввоз остальных", async () => {
    // локальный узел myc с тем же текстом, что у myc-c2: у своих узлов
    // идентичность по содержимому, и место в индексе уже занято
    const localId = await withStore(
      (h) =>
        h.store.createNode({
          kind: "task",
          scope: h.scope,
          title: "Admin redesign Phase 1",
          body: "Один и тот же текст у двух разных задач трекера.",
          status: "open",
          actor: "tester",
        }).id,
    );

    const p = join(projectDir, "clash.json");
    writeFileSync(p, JSON.stringify(CLASH));
    const env = await mycJson("import-beads", p);
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;

    // столкнулись обе одинаковые задачи и обе их заметки — но не остальное
    const skipped = d["skipped"] as string[];
    expect(skipped).toHaveLength(4);
    expect(skipped.filter((l) => l.startsWith("myc-c1"))).toHaveLength(2);
    expect(skipped.filter((l) => l.startsWith("myc-c2"))).toHaveLength(2);
    // сообщение называет ОБЕ стороны: чья запись и с каким узлом myc
    expect(skipped.find((l) => l.startsWith("myc-c1:"))).toContain(localId);
    // заметка пропущенной задачи названа своей причиной, а не той же
    expect(skipped.find((l) => l.startsWith("myc-c1#notes:"))).toContain("сама задача myc-c1 не ввезена");

    // и ровно это: третья задача, вторая память — на месте
    expect(d["tasks_created"]).toBe(1);
    expect(d["memories_created"]).toBe(2);
    expect(env.warn?.some((w) => w.code === "import.skipped")).toBe(true);

    await withStore((h) => {
      const refs = h.store
        .listNodes(h.scope, "task", 10000)
        .map((n) => n.attrs["external_ref"])
        .filter((r) => typeof r === "string");
      expect(refs).toEqual(["myc-c3"]);
    });
  });

  test("отказ стора на одной записи — тоже одна строка отчёта, а не обрыв", async () => {
    // Предполётная проверка видит только столкновения по содержимому. Всё
    // остальное, чем стор может отказать в уникальности, обязано остаться
    // ОДНОЙ пропущенной записью: три предыдущих блокера этого импорта были
    // ровно тем, что одна строка из 796 отменяла все остальные.
    const opened = await openStore(fakeCtx());
    if (!opened.ok) throw new Error(opened.failure.msg);
    const h = opened.handle;
    try {
      let n = 0;
      const store = new Proxy(h.store, {
        get(target, prop, recv) {
          if (prop !== "createNode") return Reflect.get(target, prop, recv);
          return (input: unknown) => {
            n += 1;
            if (n === 2) throw new Error("UNIQUE constraint failed: nodes.scope, nodes.kind, nodes.content_hash");
            return (target.createNode as (i: never) => unknown)(input as never);
          };
        },
      });
      const data = importBeadsSnapshot({ ...h, store } as typeof h, CLASH, {
        dryRun: false,
        snapshotName: "proxy",
      });
      expect(data.tasks_created).toBe(2);
      expect(data.skipped).toHaveLength(2);
      expect(data.skipped[0]).toContain("myc-c2");
      expect(data.skipped[0]).toContain("нарушение уникальности");
    } finally {
      h.close();
    }
  });
});

/**
 * Сухой прогон обязан считать ТО ЖЕ, что сделает настоящий (myc-7kk9, п.5):
 * на снимке cherry он докладывал «972 зависимости без цели» там, где не было
 * ни одной, — потому что ссылки разрешались через ещё не созданные узлы.
 * Ложная тревога ровно того вида, по которому ищут потерю графа связей.
 */
describe("сухой прогон считает то же, что настоящий", () => {
  test("рёбра посчитаны, ссылки разрешены, ничего не записано", async () => {
    const dry = (await mycJson("import-beads", snapshotPath, "--dry-run")).data as Record<string, unknown>;
    expect(dry["edges_created"]).toBe(3);
    expect(dry["missing_refs"]).toEqual([]);
    await withStore((h) => {
      expect(h.store.listNodes(h.scope, "task", 10000)).toHaveLength(0);
    });

    const real = (await mycJson("import-beads", snapshotPath)).data as Record<string, unknown>;
    expect(real["edges_created"]).toBe(dry["edges_created"]);
    expect(real["tasks_created"]).toBe(dry["tasks_created"]);
    expect(real["notes_created"]).toBe(dry["notes_created"]);
    expect(real["memories_created"]).toBe(dry["memories_created"]);
  });
});

describe("зависимости сверх blocks/parent-child", () => {
  const DEPS: BeadsSnapshot = {
    issues: [
      { id: "myc-d1", title: "Находка", status: "closed", priority: 2, issue_type: "bug",
        dependencies: [{ id: "myc-d2", dependency_type: "discovered-from" }] },
      { id: "myc-d2", title: "Работа, при которой нашли", status: "closed", priority: 2, issue_type: "task" },
      { id: "myc-d3", title: "Отменённое решение", status: "closed", priority: 2, issue_type: "task",
        dependencies: [{ id: "myc-d4", dependency_type: "supersedes" }] },
      { id: "myc-d4", title: "Откат", status: "closed", priority: 1, issue_type: "task" },
      { id: "myc-d5", title: "Со связью, которую нечем выразить", status: "open", priority: 2, issue_type: "task",
        dependencies: [{ id: "myc-d1", dependency_type: "smells-like" }] },
    ],
  };

  test("discovered-from → derived_from, supersedes → supersedes, направление сохранено", async () => {
    const p = join(projectDir, "deps.json");
    writeFileSync(p, JSON.stringify(DEPS));
    const d = (await mycJson("import-beads", p)).data as Record<string, unknown>;
    expect(d["edges_created"]).toBe(2);

    await withStore((h) => {
      const byRef = new Map(
        h.store.listNodes(h.scope, "task", 10000).map((n) => [String(n.attrs["external_ref"]), n.id]),
      );
      // «d1 обнаружена при работе над d2» → d1 выведен из d2
      expect(h.store.getEdge(byRef.get("myc-d1")!, "derived_from", byRef.get("myc-d2")!)).toBeDefined();
      // `bd supersede d3 --with=d4` → d4 заменяет d3
      expect(h.store.getEdge(byRef.get("myc-d4")!, "supersedes", byRef.get("myc-d3")!)).toBeDefined();
    });
  });

  test("тип без ребра myc назван отдельно, а не как «ссылка без цели»", async () => {
    const p = join(projectDir, "deps.json");
    writeFileSync(p, JSON.stringify(DEPS));
    const env = await mycJson("import-beads", p);
    const d = env.data as Record<string, unknown>;
    expect(d["missing_refs"]).toEqual([]);
    expect(d["unknown_dep_types"]).toEqual(["myc-d5 → myc-d1: тип 'smells-like' не переносится"]);
    expect(env.warn?.some((w) => w.code === "import.unknown_dep_types")).toBe(true);
  });
});
