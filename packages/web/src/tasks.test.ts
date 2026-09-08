/**
 * Приёмка W3 (memory-snm42rbgehmm): задачи в интерфейсе.
 *
 * Главный критерий — задача, заведённая в интерфейсе, неотличима в базе от
 * заведённой командой `myc create`. «Неотличима» значит ОПЛОГ, а не итоговое
 * состояние: одинаковое состояние при разных операциях — это и есть
 * расхождение, которое всплывает при синхронизации. Поэтому движок записи в
 * тестах — настоящий процесс `myc`, а сравнение — операция в операцию
 * (образец — write.test.ts).
 *
 * Второй критерий — иерархия читается из интерфейса так же, как из терминала:
 * у эпика «состав N из M закрыто» с отменёнными отдельно, у задачи «входит в».
 * Прогресс считает закрытые: отменённая задача — не сделанная работа.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { startVizServer, type VizServer } from "./server.ts";
import type { RunCli } from "./mutate.ts";
import { makeWorkspace, type Workspace } from "./harness.ts";
import { openReadOnly } from "./db.ts";
import { buildCard } from "./card.ts";
import type { CardView } from "./types.ts";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const TEST_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  MYC_ACTOR: "tasks-tester",
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
  warn?: { code: string; msg: string }[];
  clk?: Record<string, string>;
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

async function cardOf(url: string, id: string): Promise<CardView> {
  const res = await get(url, `/api/nodes/${id}/card`);
  expect(res.status).toBe(200);
  return res.body as unknown as CardView;
}

/** Команда CLI должна пройти; иначе тест падает с её выводом, а не тише. */
async function mustRun(run: RunCli, argv: string[]): Promise<Record<string, unknown>> {
  const out = await run([...argv, "--json"]);
  if (out.code !== 0) throw new Error(`myc ${argv[0]}: код ${out.code}\n${out.stdout}\n${out.stderr ?? ""}`);
  return (JSON.parse(out.stdout.trim()) as { data: Record<string, unknown> }).data;
}

async function makeTask(run: RunCli, title: string, extra: string[] = []): Promise<string> {
  const data = await mustRun(run, ["create", title, ...extra]);
  return String(data["id"]);
}

interface OpRow {
  op: string;
  entity: string;
  field: string | null;
  value: string | null;
}

/**
 * Операции узла без того, что обязано различаться у двух разных узлов и двух
 * разных моментов времени: id сущности, seq, часы, срок аренды, момент
 * закрытия. Всё остальное — op, поле и значение — обязано совпасть до символа.
 */
function opsOf(db: Database, id: string): string[] {
  const rows = db
    .query("SELECT op, entity, field, value FROM oplog WHERE entity_id = ?1 ORDER BY seq")
    .all(id) as OpRow[];
  return rows.map((r) => {
    let value = r.value ?? "";
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        const copy = { ...(parsed as Record<string, unknown>) };
        delete copy["expires"]; // момент истечения аренды — время, а не решение
        value = JSON.stringify(copy);
      }
    } catch {
      // не JSON — сравниваем как есть
    }
    // closed_at — тоже время, а не решение: близнецы закрываются в разные
    // миллисекунды, и требует равенства только сам факт операции
    if (r.field === "closed_at") value = "⟨время⟩";
    return `${r.op}|${r.entity}|${r.field ?? ""}|${value}`;
  });
}

/** Различие двух близнецов сведено к метке в заголовке — она вычищается. */
const mark = (ops: readonly string[], m: string): string[] =>
  ops.map((o) => o.split(` ${m}`).join(" ⟨метка⟩"));

// ---------------------------------------------------------------------------

describe("приёмка W3: заведённая в интерфейсе неотличима от myc create", () => {
  test("bug: оплог создания совпадает, состав узла — kind task + attrs.type bug", async () => {
    const { w, run, url } = await ws();
    const http = await post(url, "/api/nodes", {
      kind: "bug",
      title: "регресс на пустой базе A",
      body: "шаги воспроизведения A",
      priority: "P1",
      tags: ["viz"],
    });
    expect(http.status).toBe(200);
    expect(http.body.ok).toBe(true);
    const httpId = String(http.body.data?.["id"]);

    const cli = await mustRun(run, [
      "create", "регресс на пустой базе B",
      "--kind", "bug",
      "--body", "шаги воспроизведения B",
      "--priority", "P1",
      "--tag", "viz",
    ]);
    const cliId = String(cli["id"]);

    // Состав узла: epic/bug — НЕ отдельные виды ядра. В базе обязан быть
    // kind='task' с attrs.type, как у заведённого терминалом.
    const node = (await get(url, `/api/nodes/${httpId}`)).body;
    expect(node["kind"]).toBe("task");
    expect((node["attrs"] as Record<string, unknown>)["type"]).toBe("bug");
    expect(mark(opsOf(w.db, httpId), "A")).toEqual(mark(opsOf(w.db, cliId), "B"));
    expect(opsOf(w.db, httpId).length).toBeGreaterThan(3);
  }, 60_000);

  test("epic с родителем: вид task, тип epic, оплог как у create --kind epic --parent", async () => {
    const { w, run, url } = await ws();
    const httpEpic = await makeTask(run, "эпик-приёмка A", ["--kind", "epic"]);
    const cliEpic = await makeTask(run, "эпик-приёмка B", ["--kind", "epic"]);

    const http = await post(url, "/api/nodes", {
      kind: "epic",
      title: "ребёнок из интерфейса A",
      parent: httpEpic,
    });
    expect(http.status).toBe(200);
    const httpId = String(http.body.data?.["id"]);

    const cliId = await makeTask(run, "ребёнок из интерфейса B", [
      "--kind", "epic", "--parent", cliEpic,
    ]);

    const node = (await get(url, `/api/nodes/${httpId}`)).body;
    expect(node["kind"]).toBe("task");
    expect((node["attrs"] as Record<string, unknown>)["type"]).toBe("epic");
    expect(mark(opsOf(w.db, httpId), "A")).toEqual(mark(opsOf(w.db, cliId), "B"));
  }, 60_000);

  test("полный цикл: завести → править поля → взять → отпустить → закрыть, оплог совпадает", async () => {
    const { w, run, url } = await ws();
    const httpId = String(
      (await post(url, "/api/nodes", { kind: "task", title: "цикл A", body: "тело A" }))
        .body.data?.["id"],
    );
    const cliId = await makeTask(run, "цикл B", ["--body", "тело B"]);

    // правка любого поля — заголовок и тело тем же myc update
    expect(
      (await post(url, `/api/nodes/${httpId}`, { title: "переименована A", body: "новое тело A" }))
        .status,
    ).toBe(200);
    expect(
      (await run(["update", cliId, "--title", "переименована B", "--body", "новое тело B", "--json"]))
        .code,
    ).toBe(0);

    // взять в работу (аренда 30m — умолчание обеих поверхностей)…
    expect((await post(url, `/api/nodes/${httpId}/op`, { op: "claim" })).status).toBe(200);
    expect((await run(["claim", cliId, "--lease", "30m", "--json"])).code).toBe(0);
    // …отпустить…
    expect((await post(url, `/api/nodes/${httpId}/op`, { op: "release" })).status).toBe(200);
    expect((await run(["release", cliId, "--json"])).code).toBe(0);
    // …и закрыть с причиной.
    expect(
      (await post(url, `/api/nodes/${httpId}/op`, { op: "close", reason: "готово" })).status,
    ).toBe(200);
    expect((await run(["close", cliId, "--reason", "готово", "--json"])).code).toBe(0);

    const httpOps = mark(opsOf(w.db, httpId), "A");
    expect(httpOps).toEqual(mark(opsOf(w.db, cliId), "B"));
    expect(httpOps.filter((o) => o.startsWith("claim|")).length).toBe(2); // claim и close
    // release записан движком как lease-запись action=release — не тихая правка
    expect(httpOps.some((o) => o.includes('"action":"release"'))).toBe(true);
  }, 90_000);
});

describe("приёмка W3: карточка со связями — myc show в интерфейсе", () => {
  test("эпик: состав N из M закрыто, отменённые отдельно; ребёнок: входит в", async () => {
    const { run, url } = await ws();
    const epic = await makeTask(run, "эпик с составом", ["--kind", "epic"]);
    const closed1 = await makeTask(run, "ребёнок закрыт один", ["--parent", epic]);
    const closed2 = await makeTask(run, "ребёнок закрыт два", ["--parent", epic]);
    const dropped = await makeTask(run, "ребёнок отменён", ["--parent", epic]);
    const openChild = await makeTask(run, "ребёнок открыт", ["--parent", epic]);

    expect((await run(["close", closed1, "--reason", "сделан", "--json"])).code).toBe(0);
    expect((await run(["close", closed2, "--reason", "сделан", "--json"])).code).toBe(0);
    expect((await run(["update", dropped, "--status", "cancelled", "--json"])).code).toBe(0);

    const card = await cardOf(url, epic);
    expect(card.kind).toBe("task");
    expect(card.type).toBe("epic");
    // Прогресс по ЗАКРЫТЫМ: 2 закрыто из 4, отменён 1 — отдельным числом.
    // «Не открытых» здесь 3, и это была бы ложь про готовность эпика.
    expect(card.progress).toEqual({ done: 2, cancelled: 1, total: 4 });
    // Дети отсортированы как в show: приоритет, затем id (здесь приоритеты равны)
    const byId = (a: string, b: string): number => a.localeCompare(b);
    expect(card.children.map((c) => c.id)).toEqual(
      [closed1, closed2, dropped, openChild].sort(byId),
    );
    expect(card.children.map((c) => c.status).sort()).toEqual([
      "cancelled", "closed", "closed", "open",
    ]);

    const childCard = await cardOf(url, openChild);
    expect(childCard.parent).not.toBeNull();
    expect(childCard.parent?.id).toBe(epic);
    expect(childCard.progress).toBeNull(); // у задачи без детей прогресса нет
  }, 90_000);

  test("карточка показывает аренду и блокировки", async () => {
    const { run, url } = await ws();
    const blocker = await makeTask(run, "блокер карточки");
    const task = await makeTask(run, "задача с арендой");
    // Сначала в работу: у заблокированной задачи движок аренду не даст —
    // open_blockers > 0, и карточка честно покажет и то и другое.
    expect((await run(["claim", task, "--as", "другой-агент", "--lease", "45m", "--json"])).code).toBe(0);
    expect((await run(["dep", "add", task, "blocked-by", blocker, "--json"])).code).toBe(0);

    const card = await cardOf(url, task);
    expect(card.lease?.holder).toBe("другой-агент");
    expect(card.lease?.expires).toBeGreaterThan(Date.now());
    expect(card.blocked_by.map((r) => r.id)).toEqual([blocker]);
    expect(card.blocked_by[0]?.status).toBe("open");
    expect(card.status).toBe("in_progress");
  }, 60_000);
});

describe("приёмка W13 (memory-tje3kp7avp13): нить комментариев на карточке", () => {
  /**
   * Ребро replies_to комментария CLI пока не умеет ставить (см. OP_GAPS.comment
   * в mutate.ts) — вставляем прямым INSERT, как seedGraph в harness.ts: тест
   * читает карточку, а не проверяет путь записи ребра, которого ещё нет.
   */
  function insertComment(
    db: Database,
    id: string,
    targetId: string,
    opts: { title: string; body?: string; assignee?: string; role?: string; createdAt?: number },
  ): void {
    const now = opts.createdAt ?? Date.now();
    const attrs = opts.role !== undefined ? { role: opts.role } : {};
    db.run(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, status, priority, open_blockers,
                          content_hash, acl, assignee, actor, created_at, updated_at, attrs)
       VALUES (?1, 'message', 1, '', ?2, ?3, 'active', 2, 0, ?1, 'team', ?4, ?4, ?5, ?5, ?6)`,
      [id, opts.title, opts.body ?? "", opts.assignee ?? "agent", now, JSON.stringify(attrs)],
    );
    db.run(
      `INSERT INTO edges (src, type, dst, add_tag, actor, created_at)
       VALUES (?1, 'replies_to', ?2, 'test-tag', 'test', ?3)`,
      [id, targetId, now],
    );
  }

  test("комментарии агента и человека в одной ленте, старые сверху, различимы по role", async () => {
    const { run, url, w } = await ws();
    const task = await makeTask(run, "задача с нитью");

    insertComment(w.db, "cmt-agent-1", task, { title: "первое агентское", createdAt: 1000, assignee: "agent" });
    insertComment(w.db, "cmt-human-1", task, {
      title: "ответ человека",
      body: "смотри вложение",
      role: "user",
      assignee: "egor",
      createdAt: 2000,
    });

    const card = await cardOf(url, task);
    expect(card.comments.map((c) => c.id)).toEqual(["cmt-agent-1", "cmt-human-1"]);
    expect(card.comments[0]?.role).toBe("agent");
    expect(card.comments[0]?.author).toBe("agent");
    expect(card.comments[1]?.role).toBe("user");
    expect(card.comments[1]?.author).toBe("egor");
    expect(card.comments[1]?.body).toBe("ответ человека\nсмотри вложение");
  }, 60_000);

  test("мягкое удаление: комментарий пропадает из нити, но остаётся в базе", async () => {
    const { run, url, w } = await ws();
    const task = await makeTask(run, "задача для мягкого удаления");
    insertComment(w.db, "cmt-soft-del", task, { title: "будет удалён" });

    expect((await cardOf(url, task)).comments.map((c) => c.id)).toEqual(["cmt-soft-del"]);

    w.db.run("UPDATE nodes SET deleted_at = ?1 WHERE id = 'cmt-soft-del'", [Date.now()]);

    expect((await cardOf(url, task)).comments).toEqual([]);
    // История не стёрта — жёсткое удаление здесь уронило бы эту проверку.
    const row = w.db.query("SELECT COUNT(*) AS n FROM nodes WHERE id = 'cmt-soft-del'").get() as { n: number };
    expect(row.n).toBe(1);
  }, 60_000);

  test("комментарий из интерфейса: путь записи честно отказывает 501 — реального ребра CLI ещё не ставит", async () => {
    const { run, url } = await ws();
    const task = await makeTask(run, "задача для попытки записи комментария");
    const res = await post(url, `/api/nodes/${task}/op`, { op: "comment", body: "привет" });
    expect(res.status).toBe(501);
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("unsupported.op");
    expect(res.body.error?.msg).toContain("replies_to");
  }, 60_000);
});

describe("приёмка W3: тип без иллюзии отдельной сущности", () => {
  test("сменить тип существующего узла — громкий отказ, узел не тронут", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "тип не меняется на лету", ["--kind", "epic"]);
    const res = await post(url, `/api/nodes/${id}`, { type: "bug" });
    expect(res.status).toBe(501);
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("unsupported.field");
    expect(res.body.error?.msg).toContain("attrs.type");

    const node = (await get(url, `/api/nodes/${id}`)).body;
    expect((node["attrs"] as Record<string, unknown>)["type"]).toBe("epic");
  }, 60_000);

  test("выдуманный вид при создании отвергает движок, а не интерфейс", async () => {
    const { url } = await ws();
    const res = await post(url, "/api/nodes", { kind: "epic2", title: "несуществующий вид" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("usage.invalid");
    expect(res.body.error?.msg).toContain("--kind");
  }, 60_000);
});

describe("нить читается по ребру, а не по виду узла", () => {
  test("смешанная нить видна целиком: и note, и message", async () => {
    // Три писателя дают РАЗНЫЕ виды: MCP и `myc comment` пишут note с
    // attrs.type='comment', `myc msg --reply-to` — message. Читатель с
    // фильтром по одному виду показывал ноль там, где CLI показывал нить, и
    // после ввоза 156 комментариев из beads невидимыми стали бы все 156.
    // Поэтому в этом тесте нить ОБЯЗАНА содержать оба вида: тест на одном
    // виде прошёл бы и на сломанном фильтре.
    const { w, run } = await ws();
    const made = await run(["task", "узел со смешанной нитью", "--json"]);
    const task = (JSON.parse(made.stdout) as { data: { id: string } }).data.id;
    await run(["comment", task, "видом note"]);
    await run(["msg", "видом message", "--reply-to", task]);

    const kinds = openReadOnly(w.dbPath)
      .all<{ kind: string }>(
        `SELECT n.kind FROM edges e JOIN nodes n ON n.id = e.src
          WHERE e.dst = ?1 AND e.type = 'replies_to' ORDER BY n.kind`,
        [task],
      )
      .map((r) => r.kind);
    expect(kinds).toEqual(["message", "note"]);

    const card = buildCard(openReadOnly(w.dbPath), task);
    expect(card?.comments.length).toBe(2);
  });
});
