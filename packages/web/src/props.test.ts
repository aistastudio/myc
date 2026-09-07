/**
 * Приёмка W2 (myc-fkbed7d549mf): редактор свойств узла.
 *
 * Главный критерий — недопустимое значение отвергается СЕРВЕРОМ, даже если
 * запрос подделан мимо интерфейса: проверка живёт в ядре и общем пути записи,
 * а не в браузере. Поэтому каждый тест здесь бьёт в HTTP напрямую, как curl,
 * с настоящим процессом `myc` в качестве движка записи — браузерная
 * валидация в этой приёмке не считается вовсе.
 *
 * Матрица: приоритет P0–P3, ACL private|team|restricted|agent, оценка в
 * формате 30m/2h/1d, теги массивом строк, статус — никак: он зависит от вида
 * (NODE_STATUSES в packages/core/src/graph.ts) и зарабатывается операциями.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startVizServer, type VizServer } from "./server.ts";
import type { RunCli } from "./mutate.ts";
import { makeWorkspace, type Workspace } from "./harness.ts";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const TEST_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  MYC_ACTOR: "props-tester",
  NO_COLOR: "1",
  MYC_EMBED_DAEMON: "0",
};

const cleanups: Array<() => void> = [];
const servers: VizServer[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const c of cleanups.splice(0)) c();
});

/** Настоящий CLI отдельным процессом — тот же путь, что у человека. */
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

async function ws(): Promise<{ run: RunCli; url: string }> {
  const w = await makeWorkspace();
  cleanups.push(() => w.cleanup());
  const run = cliRunnerFor(w);
  const server = startVizServer({ dbPath: w.dbPath, dir: w.dir, port: 0, runCli: run });
  servers.push(server);
  return { run, url: server.url.replace(/\/$/, "") };
}

interface Reply {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; msg: string; hint?: string };
  clk?: Record<string, string>;
  [k: string]: unknown;
}

/** curl-подобный удар в HTTP: никаких браузерных маршрутов, голый fetch. */
async function post(url: string, path: string, body: unknown): Promise<{ status: number; body: Reply }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Reply };
}

async function get(url: string, path: string): Promise<{ status: number; body: Reply }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as Reply };
}

/** Создать узел через CLI и вернуть его id. */
async function makeNode(
  run: RunCli,
  title: string,
  extra: string[] = [],
): Promise<string> {
  const out = await run(["create", title, ...extra, "--json"]);
  if (out.code !== 0) throw new Error(`myc create: код ${out.code}\n${out.stdout}\n${out.stderr ?? ""}`);
  return (JSON.parse(out.stdout.trim()) as { data: { id: string } }).data.id;
}

/** Значение поля узла после всего — то, что увидит следующий читатель. */
async function fieldOf(url: string, id: string, field: string): Promise<unknown> {
  const res = await get(url, `/api/nodes/${id}`);
  expect(res.status).toBe(200);
  if (field.startsWith("attrs.")) {
    const attrs = (res.body["attrs"] ?? {}) as Record<string, unknown>;
    return attrs[field.slice("attrs.".length)];
  }
  return res.body[field];
}

// ---------------------------------------------------------------------------

describe("приёмка W2: недопустимое значение отвергает сервер, а не браузер", () => {
  test("приоритет вне P0–P3 — отказ, узел не изменён", async () => {
    const { run, url } = await ws();
    const id = await makeNode(run, "приоритетная", ["--priority", "P2"]);
    for (const bad of ["P9", "9", 1.5, -1, "высокий", true]) {
      const res = await post(url, `/api/nodes/${id}`, { priority: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(res.body.ok).toBe(false);
      expect(res.body.error?.code).toBe("usage.invalid");
      // отказ приходит и от HTTP-поверхности, и от движка — оба называют поле
      expect(/риоритет|priority/.test(res.body.error?.msg ?? "")).toBe(true);
    }
    expect(await fieldOf(url, id, "priority")).toBe(2);
  }, 90_000);

  test("ACL вне private|team|restricted|agent — отказ, узел не изменён", async () => {
    const { run, url } = await ws();
    const id = await makeNode(run, "закрытая");
    const before = await fieldOf(url, id, "acl");
    for (const bad of ["public", "", "TEAM", "read", 42]) {
      const res = await post(url, `/api/nodes/${id}`, { acl: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(res.body.error?.msg).toContain("acl");
    }
    expect(await fieldOf(url, id, "acl")).toEqual(before);
  }, 90_000);

  test("оценка не в формате 30m/2h/1d — отказ, узел не изменён", async () => {
    const { run, url } = await ws();
    const id = await makeNode(run, "оценённая");
    for (const bad of ["abc", "1w", "-5m", "30"]) {
      const res = await post(url, `/api/nodes/${id}`, { estimate: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(res.body.error?.msg).toContain("оценк");
    }
    expect(await fieldOf(url, id, "attrs.estimate_min")).toBeUndefined();
  }, 90_000);

  test("теги не массивом строк — отказ, узел не изменён", async () => {
    const { run, url } = await ws();
    const id = await makeNode(run, "тегированная", ["--tag", "была"]);
    const comma = await post(url, `/api/nodes/${id}`, { tags: ["a", "b,c"] });
    expect(comma.status).toBe(400);
    expect(comma.body.error?.msg).toContain("запятая");
    for (const bad of [42, ["a", ""], "a,b"]) {
      const res = await post(url, `/api/nodes/${id}`, { tags: bad });
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect(await fieldOf(url, id, "attrs.tags")).toEqual(["была"]);
  }, 90_000);

  test("исполнитель не строкой — отказ", async () => {
    const { run, url } = await ws();
    const id = await makeNode(run, "чья-то");
    const res = await post(url, `/api/nodes/${id}`, { assignee: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error?.msg).toContain("assignee");
    expect(await fieldOf(url, id, "assignee")).toBe("");
  }, 90_000);
});

describe("приёмка W2: статус зависит от вида и зарабатывается, а не назначается", () => {
  test("статус полем не назначается ни для какого вида — даже валидный", async () => {
    const { run, url } = await ws();
    const task = await makeNode(run, "задача");
    const note = await makeNode(run, "заметка", ["--kind", "memory"]);
    for (const [id, status] of [
      [task, "closed"],
      [task, "in_progress"],
      [note, "closed"],
      // active для заметки валиден по NODE_STATUSES — но путь к нему всё
      // равно не запись: статусы не назначаются, а зарабатываются (S54)
      [note, "active"],
    ] as const) {
      const res = await post(url, `/api/nodes/${id}`, { status });
      expect([status, res.status]).toEqual([status, 422]);
      expect(res.body.error?.code).toBe("precond.use_op");
    }
    expect(await fieldOf(url, note, "status")).toBe("active");
  }, 90_000);

  test("closed у заметки отвергает движок: допустимые статусы зависят от kind", async () => {
    const { run, url } = await ws();
    const note = await makeNode(run, "заметка", ["--kind", "memory"]);
    for (const op of ["cancel", "reopen"]) {
      const res = await post(url, `/api/nodes/${note}/op`, { op, reason: "хотели как лучше" });
      expect([op, res.status]).toEqual([op, 400]);
      expect(res.body.error?.msg).toContain("kind 'note'");
    }
    expect(await fieldOf(url, note, "status")).toBe("active");
  }, 90_000);

  test("отмена документа и сообщения тоже отвергается по их шкале", async () => {
    const { run, url } = await ws();
    const doc = await makeNode(run, "документ", ["--kind", "document"]);
    const message = await makeNode(run, "сообщение", ["--kind", "message"]);
    for (const id of [doc, message]) {
      const res = await post(url, `/api/nodes/${id}/op`, { op: "cancel", reason: "не то" });
      expect(res.status).toBe(400);
      expect(res.body.error?.msg).toContain("недопустим");
    }
    expect(await fieldOf(url, doc, "status")).toBe("active");
    expect(await fieldOf(url, message, "status")).toBe("active");
  }, 90_000);

  test("контроль: у задачи тот же путь работает — дело в шкале вида, не в поломке", async () => {
    const { run, url } = await ws();
    const task = await makeNode(run, "настоящая задача");
    const res = await post(url, `/api/nodes/${task}/op`, { op: "cancel", reason: "не нужно" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await fieldOf(url, task, "status")).toBe("cancelled");
  }, 90_000);
});

describe("приёмка W2: поверхность правки свойств", () => {
  test("все пять свойств одним запросом — и у задачи, и у заметки", async () => {
    const { run, url } = await ws();
    const edit = { priority: "P1", tags: ["alpha", "beta"], acl: "restricted", estimate: "30m", assignee: "kira" };
    for (const [title, extra] of [
      ["задача со свойствами", []],
      ["заметка со свойствами", ["--kind", "memory"]],
    ] as Array<[string, string[]]>) {
      const id = await makeNode(run, title, extra);
      const res = await post(url, `/api/nodes/${id}`, edit);
      expect([title, res.status]).toEqual([title, 200]);
      expect(res.body.ok).toBe(true);
      expect(await fieldOf(url, id, "priority")).toBe(1);
      expect(await fieldOf(url, id, "acl")).toBe("restricted");
      expect(await fieldOf(url, id, "assignee")).toBe("kira");
      expect(await fieldOf(url, id, "attrs.tags")).toEqual(["alpha", "beta"]);
      expect(await fieldOf(url, id, "attrs.estimate_min")).toBe(30);
      // часы полей выставлены — на них опирается правка из двух вкладок
      const view = (await get(url, `/api/nodes/${id}`)).body;
      for (const clock of ["priority", "acl", "assignee", "attrs.tags", "attrs.estimate_min"]) {
        expect([title, clock, typeof view.clk?.[clock]]).toEqual([title, clock, "string"]);
      }
    }
  }, 120_000);

  test("чужие часы поля — 409 с именем поля, правка не применена", async () => {
    const { run, url } = await ws();
    const id = await makeNode(run, "спорные теги", ["--tag", "первый"]);
    const stale = (await get(url, `/api/nodes/${id}`)).body.clk ?? {};

    const first = await post(url, `/api/nodes/${id}`, {
      tags: ["второй"],
      if_match: { tags: stale["attrs.tags"] ?? null },
    });
    expect(first.status).toBe(200);

    const second = await post(url, `/api/nodes/${id}`, {
      tags: ["третий"],
      if_match: { tags: stale["attrs.tags"] ?? null },
    });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("conflict.version");
    expect(await fieldOf(url, id, "attrs.tags")).toEqual(["второй"]);
  }, 90_000);
});

describe("приёмка W2: у web нет своей ветки записи", () => {
  /**
   * Вторая реализация записи — это вторая реализация CRDT, и кончаются они
   * молчаливой потерей данных (S38, S40). Поверхность веба умеет только
   * собирать argv; ни один рантайм-файл пакета не пишет SQL мимо движка.
   */
  test("в рантайм-исходниках нет прямых записей в таблицы", () => {
    const src = join(import.meta.dir);
    const runtime = readdirSync(src)
      .filter(
        (f) =>
          f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && f !== "harness.ts",
      )
      .concat("client/app.ts", "client/layout.worker.ts")
      .sort();
    // список зафиксирован, чтобы новый файл не проскочил мимо проверки
    expect(runtime).toEqual([
      "assets.ts",
      "board.ts",
      "bootstrap.ts",
      "card.ts",
      "client/app.ts",
      "client/layout.worker.ts",
      "db.ts",
      "graph.ts",
      "health.ts",
      "index.ts",
      "kb.ts",
      "mutate.ts",
      "ready.ts",
      "routing.ts",
      "server.ts",
      "timeline.ts",
      "types.ts",
      "workspace.ts",
    ]);
    const forbidden =
      /UPDATE\s+nodes|INSERT\s+INTO\s+(nodes|oplog|field_clock|edges|acl_grants)|DELETE\s+FROM\s+(nodes|oplog|field_clock|edges)/i;
    for (const file of runtime) {
      // комментарии вычищаются: «здесь нет ни одного UPDATE nodes» — это
      // документация запрета, а не его нарушение
      const text = readFileSync(join(src, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect([file, forbidden.test(text)]).toEqual([file, false]);
    }
  });
});
