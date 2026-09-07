/**
 * R4 между процессами: обрыв посреди переезда и два переезда одновременно.
 *
 * Точка фиксации переезда лежит МЕЖДУ двумя транзакциями в РАЗНЫХ базах —
 * межпроцессного замка на такую пару нет и быть не может. Значит проверять
 * её обязан настоящий процесс, убитый SIGKILL'ом ровно в этой точке: только
 * так видно, что пережили файлы, а не что задумал код. Дважды в этом проекте
 * однопоточные тесты пропускали молчаливую потерю записей на гонках (S38,
 * S40), и оба раза правда обнаруживалась только на Bun.spawn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cliTestEnv } from "@myc/core";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createMoveCommand } from "./move.ts";
import { createReadyCommand } from "./ready.ts";
import { createShowCommand } from "./show.ts";
import { createDepCommand } from "./dep.ts";
import { createTaskCommand } from "./tasks.ts";

let root: string;
let homeDir: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  r.register(createShowCommand());
  r.register(createDepCommand());
  r.register(createMoveCommand());
  return r;
}

beforeEach(() => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-move-mp-"));
  homeDir = mkdtempSync(join(tmpdir(), "myc-move-mp-home-"));
  process.env.MYC_HOME = homeDir;
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

async function makeWorkspace(name: string): Promise<string> {
  const dir = join(root, name);
  Bun.spawnSync(["mkdir", "-p", dir]);
  expect((await myc(dir, "init")).code).toBe(ExitCode.OK);
  return dir;
}

async function makeTask(dir: string, title: string): Promise<string> {
  const r = await myc(dir, "task", title);
  expect(r.code).toBe(ExitCode.OK);
  return text(r.stdout).split("\n")[0]!.split(/\s+/)[0]!;
}

interface WorkerOpts {
  readonly mode: "cli" | "engine";
  readonly break?: "after-ingest" | "after-commit";
  readonly withBlockers?: boolean;
  readonly go?: string;
}

interface WorkerRun {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnMove(
  source: string,
  target: string,
  id: string,
  o: WorkerOpts,
): Promise<WorkerRun> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "move.worker.ts"),
      "--source", source,
      "--target", target,
      "--id", id,
      "--mode", o.mode,
      "--break", o.break ?? "none",
      ...(o.withBlockers === true ? ["--with-blockers"] : []),
      ...(o.go !== undefined ? ["--go", o.go] : []),
    ],
    env: cliTestEnv({ MYC_ACTOR: "worker", MYC_HOME: homeDir }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return {
    code: proc.exitCode,
    signal: proc.signalCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/** Прямой взгляд в файл базы, мимо любого кода команд. */
function inspect(dir: string): {
  ready(scope: string): string[];
  node(id: string): { scope: string; title: string; attrs: string } | undefined;
  ops(id: string): string[];
  scope(): string;
} {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  const slug = /^slug\s*=\s*"([a-z][a-z0-9]{1,7})"/m.exec(
    require("node:fs").readFileSync(join(dir, ".myc", "workspace.toml"), "utf8"),
  )?.[1];
  const scope = slug === undefined || slug === "myc" ? "" : slug;
  return {
    scope: () => scope,
    ready(s: string) {
      return db
        .query(
          `SELECT id FROM nodes WHERE scope=? AND kind='task' AND status='open'
             AND open_blockers=0 AND deleted_at IS NULL ORDER BY id`,
        )
        .all(s)
        .map((r) => (r as { id: string }).id);
    },
    node(id: string) {
      return db.query(`SELECT scope, title, attrs FROM nodes WHERE id=?`).get(id) as
        | { scope: string; title: string; attrs: string }
        | undefined;
    },
    ops(id: string) {
      return db
        .query(`SELECT op_id FROM oplog WHERE entity_id=? ORDER BY op_id`)
        .all(id)
        .map((r) => (r as { op_id: string }).op_id);
    },
  };
}

describe("R4 обрыв процесса посреди переезда", () => {
  test(
    "SIGKILL после точки фиксации: ни одна запись не потеряна, повтор доигрывает",
    async () => {
      const a = await makeWorkspace("repoa");
      const b = await makeWorkspace("rootb");
      const id = await makeTask(a, "уезжает в корень");
      const opsBefore = inspect(a).ops(id);
      expect(opsBefore.length).toBeGreaterThan(0);

      const killed = await spawnMove(a, b, id, { mode: "engine", break: "after-commit" });
      expect(killed.signal).toBe("SIGKILL");

      const A = inspect(a);
      const B = inspect(b);
      // Точка фиксации пройдена: источник больше не владеет.
      expect(A.ready(A.scope())).toEqual([]);
      expect(A.node(id)!.scope).toBe(B.scope());
      // Приёмник историю взял, но владения ещё не получил — щель, ради
      // которой выбран именно этот порядок фаз.
      expect(B.node(id)).toBeDefined();
      expect(B.node(id)!.scope).toBe(A.scope());
      expect(B.ready(B.scope())).toEqual([]);
      // Ни одна операция истории не потеряна смертью процесса.
      const opsAfterKill = new Set(B.ops(id));
      for (const op of opsBefore) expect(opsAfterKill.has(op)).toBe(true);

      // Щель обнаружима штатной командой.
      const pending = await myc(b, "move", "--pending", "--json");
      expect(pending.code).toBe(ExitCode.OK);
      expect(text(pending.stdout)).toContain(id);

      // Повтор доигрывает: задача становится обычной в приёмнике.
      const finish = await spawnMove(a, b, id, { mode: "cli" });
      expect(finish.signal).toBeNull();
      const B2 = inspect(b);
      expect(B2.ready(B2.scope())).toEqual([id]);
      expect(B2.node(id)!.scope).toBe(B2.scope());
      expect(JSON.parse(B2.node(id)!.attrs).moved_from).toBe(inspect(a).scope());
      const ready = await myc(b, "ready");
      expect(text(ready.stdout)).toContain(id);
    },
    120_000,
  );

  test(
    "SIGKILL до точки фиксации: источник владеет по-прежнему, повтор доводит до конца",
    async () => {
      const a = await makeWorkspace("repoc");
      const b = await makeWorkspace("rootd");
      const id = await makeTask(a, "обрыв на ввозе");

      const killed = await spawnMove(a, b, id, { mode: "engine", break: "after-ingest" });
      expect(killed.signal).toBe("SIGKILL");

      const A = inspect(a);
      const B = inspect(b);
      expect(A.ready(A.scope())).toEqual([id]);
      expect(B.node(id)!.scope).toBe(A.scope());
      expect(B.ready(B.scope())).toEqual([]);

      const finish = await spawnMove(a, b, id, { mode: "cli" });
      expect(finish.signal).toBeNull();
      const A2 = inspect(a);
      const B2 = inspect(b);
      expect(A2.ready(A2.scope())).toEqual([]);
      expect(B2.ready(B2.scope())).toEqual([id]);
    },
    120_000,
  );

  test(
    "два процесса переезжают одну задачу одним залпом: один дом, ноль потерянных операций",
    async () => {
      const a = await makeWorkspace("repoe");
      const b = await makeWorkspace("rootf");
      const id = await makeTask(a, "гонка переездов");
      const opsBefore = inspect(a).ops(id);
      const go = join(root, "go");

      const pending = [
        spawnMove(a, b, id, { mode: "cli", go }),
        spawnMove(a, b, id, { mode: "cli", go }),
      ];
      await Bun.sleep(400);
      writeFileSync(go, "go");
      const runs = await Promise.all(pending);

      for (const r of runs) {
        expect(r.signal).toBeNull();
        if (r.code !== 0) {
          // Допустим только честный отказ занятой базы, не молчаливая потеря.
          expect(r.stdout + r.stderr).toMatch(/busy|locked|занята/i);
        }
      }
      const A = inspect(a);
      const B = inspect(b);
      expect(A.ready(A.scope())).toEqual([]);
      expect(B.ready(B.scope())).toEqual([id]);
      expect(B.node(id)!.scope).toBe(B.scope());
      const arrived = new Set(B.ops(id));
      for (const op of opsBefore) expect(arrived.has(op)).toBe(true);
      // op_id уникален: сколько бы процессов ни повторили ввоз, копий нет.
      expect(B.ops(id).length).toBe(new Set(B.ops(id)).size);
    },
    120_000,
  );
});

describe("R4 отказы через настоящий процесс", () => {
  test("blocks через границу: отказ, приёмник пуст, задача осталась дома", async () => {
    const a = await makeWorkspace("repog");
    const b = await makeWorkspace("rooth");
    const blocker = await makeTask(a, "блокер остаётся");
    const blocked = await makeTask(a, "хотела уехать");
    expect((await myc(a, "dep", "add", blocked, "blocked-by", blocker)).code).toBe(ExitCode.OK);

    const refused = await spawnMove(a, b, blocked, { mode: "cli" });
    const report = JSON.parse(refused.stdout) as { code: number; out: string };
    expect(report.code).toBe(ExitCode.PRECOND);
    expect(report.out).toContain("cross_boundary");

    const A = inspect(a);
    const B = inspect(b);
    expect(A.node(blocked)!.scope).toBe(A.scope());
    expect(B.node(blocked) ?? undefined).toBeUndefined();

    // --with-blockers увозит связный кусок, и счётчик в приёмнике сходится.
    const moved = await spawnMove(a, b, blocked, { mode: "cli", withBlockers: true });
    expect(JSON.parse(moved.stdout).code).toBe(ExitCode.OK);
    const B2 = inspect(b);
    expect(B2.node(blocked)!.scope).toBe(B2.scope());
    expect(B2.ready(B2.scope())).toEqual([blocker]);
  }, 120_000);
});
