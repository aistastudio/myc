/**
 * Приёмка W4 (memory-mda8bk7q3v04): доска задач.
 *
 * Колонки здесь — не поле, а вычисление (S54): open/blocked различает
 * open_blockers, in_progress — статус, который держится арендой. Тест
 * заводит зависимость настоящим `myc dep add` и настоящим `myc claim`
 * (тот же процесс, что у tasks.test.ts), а не подставляет open_blockers
 * INSERT-ом: иначе тест мог бы разойтись с тем, что действительно
 * поддерживают триггеры схемы.
 *
 * Второй предмет приёмки — release-preview: список задач, которые немедленно
 * освободятся, если узел закрыть ИЛИ отменить. trg_st_close считает
 * закрытие и отмену терминальными ОДИНАКОВО (миграция 001), и тест проверяет
 * ровно это — предпросмотр общий, а после реального close/cancel через HTTP
 * зависимая задача действительно появляется в ready (open_blockers = 0).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startVizServer, type VizServer } from "./server.ts";
import type { RunCli } from "./mutate.ts";
import { makeWorkspace, type Workspace } from "./harness.ts";
import type { BoardPayload } from "./types.ts";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const TEST_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  MYC_ACTOR: "board-tester",
  NO_COLOR: "1",
  MYC_EMBED_DAEMON: "0",
};

const cleanups: Array<() => void> = [];
const servers: VizServer[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const c of cleanups.splice(0)) c();
});

function cliRunnerFor(w: Workspace): RunCli {
  return async (argv) => {
    const proc = Bun.spawn(
      [process.execPath, CLI, "-C", w.dir, "--db", w.dbPath, ...argv],
      { stdout: "pipe", stderr: "pipe", env: TEST_ENV },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, stdout, stderr };
  };
}

async function ws(): Promise<{ w: Workspace; run: RunCli; server: VizServer; url: string }> {
  const w = await makeWorkspace();
  cleanups.push(() => w.cleanup());
  const run = cliRunnerFor(w);
  const server = startVizServer({ dbPath: w.dbPath, dir: w.dir, port: 0, runCli: run });
  servers.push(server);
  return { w, run, server, url: server.url.replace(/\/$/, "") };
}

interface Body {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; msg: string; hint?: string };
  released?: { id: string; title: string }[];
  [k: string]: unknown;
}

async function post(url: string, path: string, body: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function get(url: string, path: string): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as Body };
}

async function mustRun(run: RunCli, argv: string[]): Promise<Record<string, unknown>> {
  const out = await run([...argv, "--json"]);
  if (out.code !== 0) throw new Error(`myc ${argv[0]}: код ${out.code}\n${out.stdout}\n${out.stderr ?? ""}`);
  return (JSON.parse(out.stdout.trim()) as { data: Record<string, unknown> }).data;
}

async function makeTask(run: RunCli, title: string, extra: string[] = []): Promise<string> {
  const data = await mustRun(run, ["create", title, ...extra]);
  return String(data["id"]);
}

async function makeEpic(run: RunCli, title: string, extra: string[] = []): Promise<string> {
  const data = await mustRun(run, ["epic", title, ...extra]);
  return String(data["id"]);
}

async function boardOf(url: string): Promise<BoardPayload> {
  const res = await get(url, "/api/board");
  expect(res.status).toBe(200);
  return res.body as unknown as BoardPayload;
}

// ---------------------------------------------------------------------------

describe("приёмка W4: колонки доски — вычисление, не поле", () => {
  test("open/blocked/in_progress/closed/cancelled расставлены по open_blockers и статусу", async () => {
    const { run, url } = await ws();
    const blocker = await makeTask(run, "блокер доски");
    const blocked = await makeTask(run, "заблокированная доской");
    expect((await run(["dep", "add", blocked, "blocked-by", blocker, "--json"])).code).toBe(0);

    const openTask = await makeTask(run, "открытая доской");
    const wip = await makeTask(run, "в работе доской");
    expect((await run(["claim", wip, "--lease", "30m", "--json"])).code).toBe(0);

    const closed = await makeTask(run, "закрытая доской");
    expect((await run(["close", closed, "--reason", "готово", "--json"])).code).toBe(0);

    const cancelled = await makeTask(run, "отменённая доской");
    expect((await run(["update", cancelled, "--status", "cancelled", "--json"])).code).toBe(0);

    const board = await boardOf(url);
    const ids = (col: keyof BoardPayload["columns"]): string[] => board.columns[col].map((r) => r.id);

    // blocker сам открыт и не блокирован никем — он в open, а не в blocked.
    expect(ids("open")).toEqual(expect.arrayContaining([blocker, openTask]));
    expect(ids("blocked")).toEqual([blocked]);
    expect(ids("in_progress")).toEqual([wip]);
    expect(ids("closed")).toEqual(expect.arrayContaining([closed]));
    expect(ids("cancelled")).toEqual(expect.arrayContaining([cancelled]));

    // Ни одна задача не разложена в две колонки одновременно.
    const all = (Object.keys(board.columns) as (keyof BoardPayload["columns"])[]).flatMap(ids);
    expect(new Set(all).size).toBe(all.length);
  }, 90_000);
});

describe("приёмка W4: release-preview — поимённый список, что освободится", () => {
  test("единственный открытый блокер: close освобождает зависимую задачу", async () => {
    const { run, url } = await ws();
    const blocker = await makeTask(run, "единственный блокер");
    const dependent = await makeTask(run, "зависимая от единственного блокера");
    expect((await run(["dep", "add", dependent, "blocked-by", blocker, "--json"])).code).toBe(0);

    const preview = await get(url, `/api/nodes/${blocker}/release-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.released?.map((r) => r.id)).toEqual([dependent]);

    // Мутация-приёмка: close — не только объявление о намерении, оно И ОСВОБОЖДАЕТ.
    const boardBefore = await boardOf(url);
    expect(boardBefore.columns.blocked.map((r) => r.id)).toContain(dependent);

    const close = await post(url, `/api/nodes/${blocker}/op`, { op: "close", reason: "готово" });
    expect(close.status).toBe(200);

    const boardAfter = await boardOf(url);
    expect(boardAfter.columns.blocked.map((r) => r.id)).not.toContain(dependent);
    expect(boardAfter.columns.open.map((r) => r.id)).toContain(dependent);
  }, 90_000);

  test("cancel считается терминальным ровно как close — тот же предпросмотр освобождает", async () => {
    const { run, url } = await ws();
    const blocker = await makeTask(run, "блокер для отмены");
    const dependent = await makeTask(run, "зависимая от отменяемого блокера");
    expect((await run(["dep", "add", dependent, "blocked-by", blocker, "--json"])).code).toBe(0);

    const preview = await get(url, `/api/nodes/${blocker}/release-preview`);
    expect(preview.body.released?.map((r) => r.id)).toEqual([dependent]);

    const cancel = await post(url, `/api/nodes/${blocker}/op`, { op: "cancel", reason: "не нужно" });
    expect(cancel.status).toBe(200);

    const board = await boardOf(url);
    expect(board.columns.blocked.map((r) => r.id)).not.toContain(dependent);
    expect(board.columns.open.map((r) => r.id)).toContain(dependent);
  }, 90_000);

  test("второй открытый блокер: предпросмотр пуст, closed не освобождает раньше времени", async () => {
    const { run, url } = await ws();
    const blockerA = await makeTask(run, "блокер A из двух");
    const blockerB = await makeTask(run, "блокер B из двух");
    const dependent = await makeTask(run, "зависит от двух блокеров");
    expect((await run(["dep", "add", dependent, "blocked-by", blockerA, "--json"])).code).toBe(0);
    expect((await run(["dep", "add", dependent, "blocked-by", blockerB, "--json"])).code).toBe(0);

    // У blockerA есть сосед-блокер — closing его одного не освободит dependent.
    const preview = await get(url, `/api/nodes/${blockerA}/release-preview`);
    expect(preview.body.released).toEqual([]);

    const close = await post(url, `/api/nodes/${blockerA}/op`, { op: "close", reason: "готово" });
    expect(close.status).toBe(200);
    const board = await boardOf(url);
    expect(board.columns.blocked.map((r) => r.id)).toContain(dependent);
  }, 90_000);
});

describe("приёмка W5: иерархия эпик-задача на доске", () => {
  test("задача под эпиком несёт parent, эпик несёт progress — прогресс по closed, отменённые отдельно", async () => {
    const { run, url } = await ws();
    const epic = await makeEpic(run, "эпик доски");
    const done = await makeTask(run, "закрытая дочерняя", ["--parent", epic]);
    expect((await run(["close", done, "--reason", "готово", "--json"])).code).toBe(0);
    const dropped = await makeTask(run, "отменённая дочерняя", ["--parent", epic]);
    expect((await run(["update", dropped, "--status", "cancelled", "--json"])).code).toBe(0);
    const open = await makeTask(run, "открытая дочерняя", ["--parent", epic]);

    const board = await boardOf(url);
    const all = (Object.keys(board.columns) as (keyof BoardPayload["columns"])[])
      .flatMap((k) => board.columns[k]);

    const openRow = all.find((r) => r.id === open);
    expect(openRow?.parent).toEqual({ id: epic, title: "эпик доски" });

    const epicRow = all.find((r) => r.id === epic);
    // Мутация-приёмка: "отменённые считаются сделанными" ломает это ровно
    // так же, как в CLI (show.ts) — done обязан остаться 1, а не 2.
    expect(epicRow?.progress).toEqual({ done: 1, cancelled: 1, total: 3 });
  }, 90_000);

  test("узел без детей и без родителя не получает лишних полей", async () => {
    const { run, url } = await ws();
    const lone = await makeTask(run, "одинокая задача доски");
    const board = await boardOf(url);
    const all = (Object.keys(board.columns) as (keyof BoardPayload["columns"])[])
      .flatMap((k) => board.columns[k]);
    const row = all.find((r) => r.id === lone);
    expect(row?.parent).toBeUndefined();
    expect(row?.progress).toBeUndefined();
  }, 60_000);
});

describe("приёмка W4: закрытие/отмена доски мимо владения отклоняется тем же путём, что и везде", () => {
  test("close чужой задачи через доску получает тот же conflict.claimed, что и API карточки", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "чужая задача доски");
    expect((await run(["claim", id, "--as", "другой-агент", "--json"])).code).toBe(0);

    // Доска не открывает отдельный путь мутации — это тот же POST .../op,
    // что и опбар карточки (mutate.ts), поэтому охрана владения одна на всех.
    const res = await post(url, `/api/nodes/${id}/op`, { op: "close", reason: "пробуем чужое" });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("conflict.claimed");
  }, 60_000);
});
