/**
 * Приёмка записи через HTTP (myc-60kc3g7bmf1p).
 *
 * Главный тест здесь сравнивает ОПЛОГ, а не итоговое состояние: одинаковая
 * строка узла при разных операциях — это и есть расхождение, которое всплывёт
 * при синхронизации, когда две реплики применят разные наборы операций. Ради
 * этого путь записи в тестах — настоящий процесс `myc`, а не заглушка: иначе
 * тест сравнивал бы подделку с подделкой.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { startVizServer, type VizServer } from "./server.ts";
import { planUpdate, type RunCli } from "./mutate.ts";
import { makeWorkspace, type Workspace } from "./harness.ts";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const TEST_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  MYC_ACTOR: "web-tester",
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
  meta?: { degraded?: string[] };
  warn?: { code: string; msg: string }[];
  clk?: Record<string, string>;
  conflicts?: { field: string }[];
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

/** Создать задачу через CLI и вернуть её id. */
async function makeTask(run: RunCli, title: string): Promise<string> {
  const out = await run(["task", title, "--json"]);
  if (out.code !== 0) throw new Error(`myc task: код ${out.code}\n${out.stdout}\n${out.stderr ?? ""}`);
  const env = JSON.parse(out.stdout.trim()) as { ok: boolean; data: { id: string } };
  expect(env.ok).toBe(true);
  return env.data.id;
}

interface OpRow {
  op: string;
  entity: string;
  field: string | null;
  value: string | null;
}

/**
 * Операции узла без того, что обязано различаться у двух разных узлов и двух
 * разных моментов времени: id сущности, seq, часы, срок аренды. Всё
 * остальное — op, поле и значение — обязано совпасть до символа.
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
    return `${r.op}|${r.entity}|${r.field ?? ""}|${value}`;
  });
}

// ---------------------------------------------------------------------------

describe("приёмка: интерфейс и CLI дают один оплог", () => {
  /**
   * Тексты двух узлов обязаны различаться: у схемы уникальность
   * (scope, kind, content_hash), и две дословно одинаковые задачи просто не
   * создаются. Различие сведено к одной метке, и она вычищается из операций
   * перед сравнением — сравниваются набор, порядок, поля и значения.
   */
  const mark = (ops: readonly string[], m: string): string[] =>
    ops.map((o) => o.split(` ${m}`).join(" ⟨метка⟩"));

  test("правка полей и переходы состояния совпадают операция в операцию", async () => {
    const { w, run, url } = await ws();
    const viaHttp = await makeTask(run, "одинаковая задача A");
    const viaCli = await makeTask(run, "одинаковая задача B");

    const http = await post(url, `/api/nodes/${viaHttp}`, {
      title: "переименована A",
      body: "новое тело A",
      priority: "P1",
      tags: ["alpha", "beta"],
    });
    expect(http.status).toBe(200);
    expect(http.body.ok).toBe(true);

    const cli = await run([
      "update", viaCli,
      "--title", "переименована B",
      "--body", "новое тело B",
      "--priority", "P1",
      "--tag", "alpha,beta",
      "--json",
    ]);
    expect(cli.code).toBe(0);

    expect(mark(opsOf(w.db, viaHttp), "A")).toEqual(mark(opsOf(w.db, viaCli), "B"));
    // и это не пустое совпадение: правка действительно что-то записала
    expect(opsOf(w.db, viaHttp).length).toBeGreaterThan(4);

    // переходы состояния — тем же сравнением
    expect((await post(url, `/api/nodes/${viaHttp}/op`, { op: "claim" })).status).toBe(200);
    expect((await run(["claim", viaCli, "--lease", "30m", "--json"])).code).toBe(0);
    expect((await post(url, `/api/nodes/${viaHttp}/op`, { op: "close", reason: "готово" })).status).toBe(200);
    expect((await run(["close", viaCli, "--reason", "готово", "--json"])).code).toBe(0);

    const httpOps = mark(opsOf(w.db, viaHttp), "A");
    expect(httpOps).toEqual(mark(opsOf(w.db, viaCli), "B"));
    expect(httpOps.filter((o) => o.startsWith("claim|")).length).toBe(2); // claim и close
  }, 60_000);

  test("создание узла через HTTP пишет тот же набор операций, что myc create", async () => {
    const { w, run, url } = await ws();
    const http = await post(url, "/api/nodes", {
      kind: "bug",
      title: "падает на пустой базе A",
      body: "шаги воспроизведения A",
      tags: ["viz"],
    });
    expect(http.status).toBe(200);
    const httpId = String(http.body.data?.["id"]);

    const cli = await run([
      "create", "падает на пустой базе B",
      "--kind", "bug",
      "--body", "шаги воспроизведения B",
      "--tag", "viz",
      "--json",
    ]);
    expect(cli.code).toBe(0);
    const cliId = (JSON.parse(cli.stdout.trim()) as { data: { id: string } }).data.id;

    expect(mark(opsOf(w.db, httpId), "A")).toEqual(mark(opsOf(w.db, cliId), "B"));
    expect(opsOf(w.db, httpId).length).toBeGreaterThan(3);
  }, 60_000);
});

describe("конкурентная правка", () => {
  test("две вкладки правят разные поля — не теряется ни одна", async () => {
    const { w, run, url } = await ws();
    const id = await makeTask(run, "общая задача");
    const before = (await get(url, `/api/nodes/${id}`)).body;
    const clk = before.clk ?? {};

    // обе вкладки читали одно и то же состояние и объявляют его часы
    const [a, b] = await Promise.all([
      post(url, `/api/nodes/${id}`, {
        title: "правка вкладки A",
        if_match: { title: clk["title"] ?? null },
      }),
      post(url, `/api/nodes/${id}`, {
        body: "правка вкладки B",
        if_match: { body: clk["body"] ?? null },
      }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const after = (await get(url, `/api/nodes/${id}`)).body;
    expect(after["title"]).toBe("правка вкладки A");
    expect(after["body"]).toBe("правка вкладки B");

    const ops = opsOf(w.db, id);
    expect(ops).toContain('set|node|title|"правка вкладки A"');
    expect(ops).toContain('set|node|body|"правка вкладки B"');
  }, 60_000);

  test("одно поле из двух вкладок — 409 с кодом, а не тихая перезапись", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "спорная задача");
    const stale = (await get(url, `/api/nodes/${id}`)).body.clk ?? {};

    const first = await post(url, `/api/nodes/${id}`, {
      title: "первая правка",
      if_match: { title: stale["title"] ?? null },
    });
    expect(first.status).toBe(200);

    // вторая вкладка всё ещё держит часы, снятые ДО первой правки
    const second = await post(url, `/api/nodes/${id}`, {
      title: "вторая правка",
      if_match: { title: stale["title"] ?? null },
    });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("conflict.version");
    expect(second.body.conflicts?.[0]?.field).toBe("title");

    // проигравшая правка не применена и не потеряна молча — клиент знает
    const now = (await get(url, `/api/nodes/${id}`)).body;
    expect(now["title"]).toBe("первая правка");
  }, 60_000);

  test("if_match разрешён только для полей самого запроса", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "задача");
    const res = await post(url, `/api/nodes/${id}`, {
      title: "новое",
      if_match: { body: null },
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.msg).toContain("не пишется");
  }, 60_000);
});

describe("статус зарабатывается, а не назначается (S54)", () => {
  test("in_progress записью статуса — отказ с именем операции", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "задача");
    const res = await post(url, `/api/nodes/${id}`, { status: "in_progress" });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("precond.use_op");
    expect(res.body.error?.msg).toContain("claim");

    const node = (await get(url, `/api/nodes/${id}`)).body;
    expect(node["status"]).toBe("open");
  }, 60_000);

  test("blocked и closed записью статуса тоже отказ", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "задача");
    for (const [status, word] of [["blocked", "блокер"], ["closed", "close"]] as const) {
      const res = await post(url, `/api/nodes/${id}`, { status });
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("precond.use_op");
      expect(res.body.error?.msg.toLowerCase()).toContain(word);
    }
  }, 60_000);

  test("open при живой чужой аренде — конфликт от той же охраны, что в CLI", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "чужая задача");
    expect((await run(["claim", id, "--as", "другой-агент", "--json"])).code).toBe(0);

    const res = await post(url, `/api/nodes/${id}/op`, { op: "reopen", reason: "передумали" });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("conflict.claimed");
  }, 60_000);

  test("cancel разрешён и сообщает, кого выпустил в очередь", async () => {
    const { run, url } = await ws();
    const blocker = await makeTask(run, "блокер");
    const dependent = await makeTask(run, "зависимая");
    expect((await run(["dep", "add", dependent, "blocked-by", blocker, "--json"])).code).toBe(0);

    const res = await post(url, `/api/nodes/${blocker}/op`, { op: "cancel", reason: "не нужно" });
    expect(res.status).toBe(200);
    expect(res.body.data?.["unblocked"]).toEqual([dependent]);
    // причину сохранить общим путём пока некуда — и об этом сказано вслух (И2)
    expect(res.body.meta?.degraded).toContain("reason.unwritten");
  }, 60_000);

  test("claim занятой задачи — 409, а не тихий успех", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "занятая");
    expect((await run(["claim", id, "--as", "другой-агент", "--json"])).code).toBe(0);
    const res = await post(url, `/api/nodes/${id}/op`, { op: "claim" });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("conflict.claimed");
  }, 60_000);
});

describe("ошибка записи громкая (И2)", () => {
  test("отказ ACL — 403 с кодом, правка не применена", async () => {
    const { w, run, url } = await ws();
    const id = await makeTask(run, "приватная задача");
    w.db.run("UPDATE nodes SET acl = 'private', owner_id = 'кто-то-другой' WHERE id = ?1", [id]);
    w.db.run("INSERT OR REPLACE INTO myc_meta (key, value) VALUES ('acl_enforced', '1')");

    const res = await post(url, `/api/nodes/${id}`, { title: "чужая правка" });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("denied.acl");

    const node = (await get(url, `/api/nodes/${id}`)).body;
    expect(node["title"]).toBe("приватная задача");
  }, 60_000);

  test("недопустимое значение acl отвергает общий путь записи, а не HTTP", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "задача");
    const res = await post(url, `/api/nodes/${id}`, { acl: "public" });
    // код и текст приходят из движка (graphFailure), HTTP их не сочиняет
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("usage.invalid");
    expect(res.body.error?.msg).toContain("acl");
  }, 60_000);

  test("несуществующий узел — 404 с кодом от общего пути", async () => {
    const { url } = await ws();
    const res = await post(url, "/api/nodes/нет-такого/op", { op: "claim" });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  }, 60_000);

  test("close без причины не доходит до записи", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "задача");
    const res = await post(url, `/api/nodes/${id}/op`, { op: "close" });
    expect(res.status).toBe(400);
    expect(res.body.error?.msg).toContain("reason");
  }, 60_000);

  test("тело '-' не уводит сервер читать stdin", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "задача");
    const res = await post(url, `/api/nodes/${id}`, { body: "-" });
    expect(res.status).toBe(400);
    expect(res.body.error?.msg).toContain("stdin");
  }, 60_000);

  test("операция note не притворяется сделанной", async () => {
    const { run, url } = await ws();
    const id = await makeTask(run, "задача");
    const res = await post(url, `/api/nodes/${id}/op`, { op: "note", note: "текст" });
    expect(res.status).toBe(501);
    expect(res.body.error?.code).toBe("unsupported.op");
  }, 60_000);
});

describe("поверхность", () => {
  test("boot объявляет контракт записи", async () => {
    const { url } = await ws();
    const boot = (await get(url, "/api/boot")).body;
    expect(boot["read_only"]).toBe(false);
    expect(boot["write_ops"]).toContain("claim");
    expect(boot["write_fields"]).toContain("title");
    expect(boot["write_fields"]).not.toContain("status");
  }, 60_000);

  test("просмотрщик, поднятый только на чтение, отвечает 405", async () => {
    const w = await makeWorkspace();
    cleanups.push(() => w.cleanup());
    const s = startVizServer({ dbPath: w.dbPath, dir: w.dir, port: 0, readOnly: true });
    servers.push(s);
    const res = await post(s.url.replace(/\/$/, ""), "/api/nodes", { title: "нельзя" });
    expect(res.status).toBe(405);
    expect((await get(s.url.replace(/\/$/, ""), "/api/boot")).body["read_only"]).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Иерархия из интерфейса: ребро, а не поле
// ---------------------------------------------------------------------------

describe("POST /api/nodes/:id — перенос между эпиками", () => {
  test("parent переносит, пустая строка вынимает", async () => {
    // До этого веб не мог менять иерархию вовсе: в CLI не было флага, а FIELDS
    // принимает только поля с часами LWW — у ребра их нет (OR-Set по add_tag),
    // и класть `parent` туда значило бы сверять часы несуществующего поля.
    const plan = planUpdate("n1", { parent: "e2" });
    expect("argv" in plan && plan.argv).toEqual(["update", "n1", "--parent", "e2"]);
    const off = planUpdate("n1", { parent: "" });
    expect("argv" in off && off.argv).toEqual(["update", "n1", "--no-parent"]);
    // Часов у ребра нет — и в clockFields ему не место, иначе конкурентная
    // правка начала бы сверять несуществующее поле.
    expect("clockFields" in plan && plan.clockFields).toEqual([]);
  });

  test("одного parent достаточно: «нечего обновлять» не срабатывает", async () => {
    // Проверка «есть ли работа» смотрела ТОЛЬКО в clockFields, поэтому запрос
    // с одним лишь parent отвергался как пустой.
    const plan = planUpdate("n1", { parent: "e2" });
    expect("argv" in plan).toBe(true);
  });

  test("parent не строкой — отказ, а не молчаливое приведение", async () => {
    const bad = planUpdate("n1", { parent: 42 });
    expect("ok" in bad && bad.ok).toBe(false);
    expect("code" in bad && bad.code).toBe("usage.invalid");
  });
});

describe("движок записи: реестр наполняется сам", () => {
  test("сервер, поднятый не бинарём myc, всё равно пишет", async () => {
    // defaultRegistry наполняет main.ts, то есть ТОЛЬКО запуск бинарём. Сервер,
    // встроенный в чужой процесс (тест, скрипт, встраивание), получал пустой
    // реестр — и каждая запись падала с «путь записи вернул не конверт (код
    // 2)»: отказ, не называющий ни причины, ни лечения. Проверка обязана идти
    // отдельным процессом: внутри этого файла реестр уже наполнен соседями.
    const w = await makeWorkspace();
    cleanups.push(() => w.cleanup());
    const made = Bun.spawnSync(
      [process.execPath, CLI, "-C", w.dir, "--db", w.dbPath, "task", "исходное", "--json"],
      { env: TEST_ENV },
    );
    const id = (JSON.parse(made.stdout.toString()) as { data: { id: string } }).data.id;

    const probe = join(import.meta.dir, "fixtures", "bare-server.ts");
    const proc = Bun.spawnSync([process.execPath, probe, w.dbPath, w.dir, id], { env: TEST_ENV });
    const out = JSON.parse(proc.stdout.toString().trim()) as { ok: boolean; code: string | null };
    expect(out.code).toBe(null);
    expect(out.ok).toBe(true);
  });
});
