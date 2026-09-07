/**
 * Приёмка W7 (memory-b4f910fe7p03): база знаний в интерфейсе.
 *
 * Главный критерий — заметка, заведённая в интерфейсе, неотличима от
 * записанной `myc remember`: тот же оплог (операция в операцию — образец
 * write.test.ts), та же очередь embed+absorb, та же находимость поиском.
 * Заметка идёт в `myc remember`, а не в `create --kind memory`: у второго
 * нет ни очереди, ни происхождения, и при синхронизации это расхождение
 * всплыло бы.
 *
 * Второй критерий — обе оси охвата (S58, S59) показываются в интерфейсе
 * обе и не сведены в одну: сведение — это выбор, какой из двух признаков
 * потерять. Заметка без охвата остаётся в списке с честной пометкой.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";import type { Database } from "bun:sqlite";
import { startVizServer, type VizServer } from "./server.ts";
import type { RunCli } from "./mutate.ts";
import { makeWorkspace, type Workspace } from "./harness.ts";
import { tierOf } from "./workspace.ts";
import type { CardView, KbPayload, KbRow } from "./types.ts";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const TEST_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  MYC_ACTOR: "kb-tester",
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

async function kbOf(url: string, query = ""): Promise<KbPayload> {
  const res = await get(url, `/api/kb${query.length > 0 ? `?${query}` : ""}`);
  expect(res.status).toBe(200);
  return res.body as unknown as KbPayload;
}

async function cardOf(url: string, id: string): Promise<CardView> {
  const res = await get(url, `/api/nodes/${encodeURIComponent(id)}/card`);
  expect(res.status).toBe(200);
  return res.body as unknown as CardView;
}

/** Команда CLI должна пройти; иначе тест падает с её выводом, а не тише. */
async function mustRun(run: RunCli, argv: string[]): Promise<Record<string, unknown>> {
  const out = await run([...argv, "--json"]);
  if (out.code !== 0) throw new Error(`myc ${argv[0]}: код ${out.code}\n${out.stdout}\n${out.stderr ?? ""}`);
  return (JSON.parse(out.stdout.trim()) as { data: Record<string, unknown> }).data;
}

interface OpRow {
  op: string;
  entity: string;
  field: string | null;
  value: string | null;
}

/**
 * Операции узла без того, что обязано различаться у двух разных узлов и двух
 * разных моментов времени: id сущности, seq, часы. Всё остальное — op, поле
 * и значение — обязано совпасть до символа.
 *
 * Побочные записи absorb-работы (attrs.absorb, attrs.degraded_at, inc
 * seen_count) вычищаются: это вывод фонового дистиллятора, зависящий от
 * содержания СОСЕДНИХ фактов и момента запуска очереди, а не путь создания.
 * Близнецы классифицируют друг друга — у A и B кандидаты разные по построению.
 * Мутация «заметка мимо remember» от этого фильтра не прячется: пропажа
 * set attrs.source/tags/reach и очереди embed+absorb остаётся красной.
 */
function opsOf(db: Database, id: string): string[] {
  const rows = db
    .query("SELECT op, entity, field, value FROM oplog WHERE entity_id = ?1 ORDER BY seq")
    .all(id) as OpRow[];
  return rows
    .filter((r) => {
      if (r.field === "attrs.absorb" || r.field === "attrs.degraded_at") return false;
      if (r.op === "inc" && r.field === "seen_count") return false;
      return true;
    })
    .map((r) => `${r.op}|${r.entity}|${r.field ?? ""}|${r.value ?? ""}`);
}

/** Различие двух близнецов сведено к метке в текстах — она вычищается. */
const mark = (ops: readonly string[], m: string): string[] =>
  ops.map((o) => o.split(` ${m}`).join(" ⟨метка⟩"));

/** Прямой посев узла для тестов ЧТЕНИЯ: экран меряет просмотрщик, не движок. */
function seedNode(
  db: Database,
  args: { id: string; kind: string; title: string; layer?: number; attrs?: Record<string, unknown> },
): void {
  db.run(
    `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, open_blockers,
                        content_hash, created_at, updated_at, actor, attrs)
     VALUES (?1, ?2, ?3, '', ?4, 'active', 2, 0, ?5, 1, 1, 'seed', ?6)`,
    [
      args.id,
      args.kind,
      args.layer ?? 1,
      args.title,
      `seed-${args.id}`,
      JSON.stringify(args.attrs ?? {}),
    ],
  );
}

// ---------------------------------------------------------------------------

describe("приёмка W7: заметка из интерфейса = myc remember", () => {
  test("оплог совпадает операция в операцию, очередь embed+absorb на месте", async () => {
    const { w, run, url } = await ws();
    const http = await post(url, "/api/nodes", {
      kind: "note",
      title: "факт из интерфейса A",
      body: "развёрнутое тело факта A",
      tags: ["kb", "приёмка"],
      layer: "L2",
    });
    expect(http.status).toBe(200);
    expect(http.body.ok).toBe(true);
    const httpId = String(http.body.data?.["id"]);
    // очередь — из данных remember: ровно те же работы, что у терминальной
    expect(http.body.data?.["queue"]).toEqual(["embed", "absorb"]);

    const cli = await mustRun(run, [
      "remember", "факт из интерфейса B\nразвёрнутое тело факта B",
      "--tag", "kb,приёмка",
      "--layer", "L2",
    ]);
    const cliId = String(cli["id"]);
    expect(cli["queue"]).toEqual(["embed", "absorb"]);

    // состав узла: kind='note' с происхождением агента, как у remember
    const node = (await get(url, `/api/nodes/${httpId}`)).body;
    expect(node["kind"]).toBe("note");
    expect((node["attrs"] as Record<string, unknown>)["source"]).toBe("agent");

    expect(mark(opsOf(w.db, httpId), "A")).toEqual(mark(opsOf(w.db, cliId), "B"));
    expect(opsOf(w.db, httpId).length).toBeGreaterThan(2);
  }, 90_000);

  test("охват project — тем же решением --reach, что у remember", async () => {
    const { w, run, url } = await ws();
    const http = await post(url, "/api/nodes", {
      kind: "note",
      title: "проектное знание A",
      reach: "project",
    });
    expect(http.status).toBe(200);
    const httpId = String(http.body.data?.["id"]);

    const cli = await mustRun(run, ["remember", "проектное знание B", "--reach", "project"]);
    const cliId = String(cli["id"]);

    const node = (await get(url, `/api/nodes/${httpId}`)).body;
    expect((node["attrs"] as Record<string, unknown>)["reach"]).toBe("project");

    expect(mark(opsOf(w.db, httpId), "A")).toEqual(mark(opsOf(w.db, cliId), "B"));
  }, 90_000);

  test("ключ сессии доходит до remember как --session", async () => {
    const { w, run, url } = await ws();
    const http = await post(url, "/api/nodes", {
      kind: "note",
      title: "сессионное знание A",
      reach: "session",
      session: "kb-sess-2",
    });
    expect(http.status).toBe(200);
    const httpId = String(http.body.data?.["id"]);

    const cli = await mustRun(run, [
      "remember", "сессионное знание B",
      "--reach", "session", "--session", "kb-sess-2",
    ]);
    const cliId = String(cli["id"]);

    const attrs = (await get(url, `/api/nodes/${httpId}`)).body["attrs"] as Record<string, unknown>;
    expect(attrs["reach"]).toBe("session");
    expect(attrs["session_id"]).toBe("kb-sess-2");

    expect(mark(opsOf(w.db, httpId), "A")).toEqual(mark(opsOf(w.db, cliId), "B"));
  }, 90_000);

  test("заметка из интерфейса находится поиском наравне с терминальной", async () => {
    const { run, url } = await ws();
    const http = await post(url, "/api/nodes", {
      kind: "note",
      title: "квантовый маятник кбпоиск A",
      body: "детали про кбпоиск",
    });
    expect(http.status).toBe(200);
    const httpId = String(http.body.data?.["id"]);
    const cliId = String((await mustRun(run, ["remember", "квантовый маятник кбпоиск B"]))["id"]);

    const out = await run(["search", "кбпоиск", "--json"]);
    expect(out.code).toBe(0);
    const found = (
      JSON.parse(out.stdout.trim()) as { data: { rows: { id: string }[] } }
    ).data.rows.map((r) => r.id);
    expect(found).toContain(httpId);
    expect(found).toContain(cliId);
  }, 90_000);

  test("сессия неизвестна — охват честно пуст, WARN доезжает до клиента", async () => {
    const { url } = await ws();
    const http = await post(url, "/api/nodes", { kind: "note", title: "знание без сессии" });
    expect(http.status).toBe(200);
    const id = String(http.body.data?.["id"]);
    // И2: не выдумываем ни сессию, ни проектность — и говорим об этом вслух
    expect((http.body.warn ?? []).map((w) => w.code)).toContain("degraded.reach");

    const kb = await kbOf(url);
    const row = kb.rows.find((r) => r.id === id);
    expect(row?.reach).toBe("unknown");
    expect(kb.counts.reach.unknown).toBeGreaterThanOrEqual(1);
  }, 90_000);
});

describe("приёмка W7: decision — не отдельный вид ядра", () => {
  test("решение в списке и карточке — note с attrs.type decision", async () => {
    const { run, url } = await ws();
    const id = String(
      (await mustRun(run, ["create", "считаем охват осью S58", "--kind", "decision"]))["id"],
    );

    const node = (await get(url, `/api/nodes/${id}`)).body;
    expect(node["kind"]).toBe("note");
    expect((node["attrs"] as Record<string, unknown>)["type"]).toBe("decision");

    const kb = await kbOf(url);
    const row = kb.rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    // вид ЯДРА — note; decision показывается подтипом, а не самозваным видом
    expect(row?.kind).toBe("note");
    expect(row?.subtype).toBe("decision");

    const card = await cardOf(url, id);
    expect(card.kind).toBe("note");
    expect(card.type).toBe("note");
  }, 90_000);
});

describe("приёмка W7: две оси охвата независимы (S58, S59)", () => {
  test("строка несёт обе оси, счётчики считают всю базу, фильтры независимы", async () => {
    const { url } = await ws();
    // все четыре состояния заводим путём интерфейса
    const p1 = await post(url, "/api/nodes", {
      kind: "note", title: "проектное знание A", reach: "project",
    });
    expect(p1.status).toBe(200);
    const projId = String(p1.body.data?.["id"]);
    const s1 = await post(url, "/api/nodes", {
      kind: "note", title: "сессионное знание A", reach: "session", session: "kb-sess-1",
    });
    expect(s1.status).toBe(200);
    const sesId = String(s1.body.data?.["id"]);
    const b1 = await post(url, "/api/nodes", { kind: "note", title: "знание без охвата" });
    const bareId = String(b1.body.data?.["id"]);
    const d1 = await post(url, "/api/nodes", { kind: "doc", title: "док общий", repo: "" });
    expect(d1.status).toBe(200);
    const docId = String(d1.body.data?.["id"]);

    const kb = await kbOf(url);
    expect(kb.total).toBe(4);
    const byId = new Map(kb.rows.map((r) => [r.id, r]));
    const proj = byId.get(projId)!;
    const ses = byId.get(sesId)!;
    const bare = byId.get(bareId)!;
    const doc = byId.get(docId)!;

    // ось сессии: решение и ключ видны, third state — в списке с меткой
    expect(proj.reach).toBe("project");
    expect(ses.reach).toBe("session");
    expect(ses.session).toBe("kb-sess-1");
    expect(bare.reach).toBe("unknown");
    // вторая ось у всех заполнена независимо: интерфейс пишет из корня
    // воркспейса, поэтому охват репозитория выведен как общий («все»)
    expect(doc.repo_state).toBe("root");
    expect(proj.repo_state).toBe("root");
    expect(bare.repo_state).toBe("root");

    // счётчики подвала — по всей базе, а не по выборке
    expect(kb.counts.reach).toEqual({ project: 1, session: 1, unknown: 2 });
    expect(kb.counts.repo.root).toBe(4);
    expect(kb.counts.repo.unknown).toBe(0);

    // фильтры осей независимы друг от друга
    expect((await kbOf(url, "reach=project")).rows.map((r) => r.id)).toEqual([projId]);
    expect((await kbOf(url, "reach=session")).rows.map((r) => r.id)).toEqual([sesId]);
    expect((await kbOf(url, "reach=unknown")).rows.length).toBe(2);
    expect((await kbOf(url, "kind=doc")).rows.map((r) => r.id)).toEqual([docId]);
    expect((await kbOf(url, `q=${encodeURIComponent("без охвата")}`)).rows.map((r) => r.id))
      .toEqual([bareId]);

    // карточка показывает слой и обе оси — та же пара полей, что и список
    const card = await cardOf(url, sesId);
    expect(card.reach).toBe("session");
    expect(card.session).toBe("kb-sess-1");
    expect(card.repo_state).toBe("root");
    expect(card.layer).toBe(1);
  }, 120_000);

  test("repo --repo доходит до create, ось repo читается у дока", async () => {
    const { url } = await ws();
    const res = await post(url, "/api/nodes", {
      kind: "doc",
      title: "док про collector",
      repo: "collector",
    });
    expect(res.status).toBe(200);
    const id = String(res.body.data?.["id"]);

    const kb = await kbOf(url);
    const row = kb.rows.find((r) => r.id === id)!;
    // ось repo заполнена, охват сессии при этом остался своим состоянием
    expect(row.repo_state).toBe("repo");
    expect(row.repo).toBe("collector");
    expect(row.reach).toBe("unknown");
    expect(kb.counts.repo.by_repo).toEqual([{ key: "collector", n: 1 }]);
  }, 90_000);

  test("посев attrs читается ядром: обе оси из своих ключей", async () => {
    const { w, url } = await ws();
    seedNode(w.db, {
      id: "kb-seed-1",
      kind: "note",
      title: "посеянная заметка",
      attrs: { reach: "session", session_id: "kb-sess-3", repo: "collector", tags: ["seed"] },
    });
    seedNode(w.db, {
      id: "kb-seed-2",
      kind: "fragment",
      title: "посеянный фрагмент без охвата",
      attrs: {},
    });
    const kb = await kbOf(url);
    expect(kb.total).toBe(2);
    const row: KbRow = kb.rows.find((r) => r.id === "kb-seed-1")!;
    expect(row.kind).toBe("note");
    expect(row.reach).toBe("session");
    expect(row.session).toBe("kb-sess-3");
    // вторая ось со СВОЕГО ключа: repo заполнен, reach при этом сессионный
    expect(row.repo_state).toBe("repo");
    expect(row.repo).toBe("collector");
    // узел без ключей охвата честно считается в обоих подвалах
    const bare = kb.rows.find((r) => r.id === "kb-seed-2")!;
    expect(bare.reach).toBe("unknown");
    expect(bare.repo_state).toBe("unknown");
    expect(kb.counts.repo.by_repo).toEqual([{ key: "collector", n: 1 }]);
    expect(kb.counts.repo.unknown).toBe(1);
    expect(kb.counts.reach.session).toBe(1);
    expect(kb.counts.reach.unknown).toBe(1);
    expect(kb.counts.by_kind).toEqual([{ key: "fragment", n: 1 }, { key: "note", n: 1 }].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)));
  }, 90_000);
});

describe("приёмка W7: остальные виды базы знаний", () => {
  test("doc: оплог создания совпадает с create --kind document", async () => {
    const { w, run, url } = await ws();
    const http = await post(url, "/api/nodes", {
      kind: "doc",
      title: "гайд по охватам A",
      body: "как читать оси A",
      tags: ["docs"],
    });
    expect(http.status).toBe(200);
    const httpId = String(http.body.data?.["id"]);

    const cli = await mustRun(run, [
      "create", "гайд по охватам B",
      "--kind", "document",
      "--body", "как читать оси B",
      "--tag", "docs",
    ]);
    const cliId = String(cli["id"]);

    const node = (await get(url, `/api/nodes/${httpId}`)).body;
    expect(node["kind"]).toBe("doc");

    expect(mark(opsOf(w.db, httpId), "A")).toEqual(mark(opsOf(w.db, cliId), "B"));
    const kb = await kbOf(url, "kind=doc");
    expect(kb.rows.map((r) => r.id)).toContain(httpId);
  }, 90_000);

  test("skill создаётся тем же create и виден в списке со своим слоем", async () => {
    const { url } = await ws();
    const res = await post(url, "/api/nodes", {
      kind: "skill",
      title: "мутационная проверка сдач",
      body: "сломай свою реализацию трижды",
    });
    expect(res.status).toBe(200);
    const id = String(res.body.data?.["id"]);
    const kb = await kbOf(url);
    const row = kb.rows.find((r) => r.id === id);
    expect(row?.kind).toBe("skill");
    expect(row?.layer).toBe(3); // слой по умолчанию у skill — L3 (ядро)
  }, 90_000);

  test("fragment и entity — громкий отказ: пути создания в CLI нет", async () => {
    const { url } = await ws();
    for (const kind of ["fragment", "entity"] as const) {
      const res = await post(url, "/api/nodes", { kind, title: `пример ${kind}` });
      expect(res.status).toBe(501);
      expect(res.body.ok).toBe(false);
      expect(res.body.error?.code).toBe("unsupported.kind");
      expect(res.body.error?.msg).toContain(kind);
    }
    const kb = await kbOf(url);
    expect(kb.total).toBe(0);
  }, 90_000);
});

describe("приёмка W7: правка знаний — тот же общий путь", () => {
  test("текст и теги правятся myc update, чужие поля осей — отказ с причиной", async () => {
    const { url } = await ws();
    const id = String(
      (await post(url, "/api/nodes", { kind: "note", title: "заметка на правку" }))
        .body.data?.["id"],
    );

    // правка текста и тегов — как у задачи, тем же myc update
    const edit = await post(url, `/api/nodes/${id}`, {
      title: "переименованная заметка",
      tags: ["правка"],
    });
    expect(edit.status).toBe(200);
    const node = (await get(url, `/api/nodes/${id}`)).body;
    expect(node["title"]).toBe("переименованная заметка");
    expect((node["attrs"] as Record<string, unknown>)["tags"]).toEqual(["правка"]);

    // слой, охват сессии и охват репозитория задним числом движок не меняет:
    // отказ громкий, с именем того, кто может его снять
    for (const [field, value] of [["layer", "L2"], ["reach", "project"], ["repo", "x"]] as const) {
      const res = await post(url, `/api/nodes/${id}`, { [field]: value });
      expect(res.status).toBe(501);
      expect(res.body.error?.code).toBe("unsupported.field");
      expect(res.body.error?.msg).toContain(field);
    }
    // отказная правка ничего не меняет: слой остался дефолтным
    const card = await cardOf(url, id);
    expect(card.layer).toBe(1);
    expect(card.title).toBe("переименованная заметка");
  }, 90_000);
});

describe("приёмка W7: ярус (S41) — ось открытой базы, а не строки", () => {
  test("проектный ярус: база вне ~/.myc честно названа проектной", async () => {
    const { w, url } = await ws();
    // временный воркспейс живёт в TMPDIR — до ~/.myc не дорастает
    expect(tierOf(w.dbPath, process.env.HOME)).toBe("project");
    expect((await get(url, "/api/boot")).body["tier"]).toBe("project");
  }, 60_000);

  test("личный ярус: база внутри HOME/.myc названа личной, а оси строк при том же узле не изменились", async () => {
    const { w, run, url } = await ws();
    // тот же физический расклад dir/.myc/myc.db — личным его делает HOME
    const personal = startVizServer({
      dbPath: w.dbPath,
      dir: w.dir,
      port: 0,
      runCli: cliRunnerFor(w),
      homeDir: w.dir,
    });
    servers.push(personal);
    const purl = personal.url.replace(/\/$/, "");
    expect((await get(purl, "/api/boot")).body["tier"]).toBe("personal");
    // проектный просмотрщик той же базы — проектный
    expect((await get(url, "/api/boot")).body["tier"]).toBe("project");

    // ярус НЕ примешан к строкам списка: у строки свои оси охвата, ярус —
    // свойство базы. Сведение было бы выбором, какую из трёх осей потерять.
    const id = String((await mustRun(run, ["remember", "факт личного яруса"]))["id"]);
    const row = (await kbOf(purl)).rows.find((r) => r.id === id)!;
    expect(Object.keys(row)).not.toContain("tier");
    expect(row.reach).toBe("unknown");
  }, 90_000);

  test("путь ровно ~/.myc/myc.db — личный; соседний каталог — проектный", () => {
    const home = "/tmp/fake-home";
    expect(tierOf(join(home, ".myc", "myc.db"), home)).toBe("personal");
    expect(tierOf(join(home, ".myc", "nested", "myc.db"), home)).toBe("personal");
    // '.myc2' — не '.myc': префикс по границе каталога, а не по строке
    expect(tierOf(join(home, ".myc2", "myc.db"), home)).toBe("project");
    expect(tierOf(join(home, "repo", ".myc", "myc.db"), home)).toBe("project");
    expect(tierOf("/somewhere/else/myc.db", home)).toBe("project");
    // HOME неизвестен — проектный без догадок
    expect(tierOf("/somewhere/else/myc.db", undefined)).toBe("project");
    expect(tierOf("/somewhere/else/myc.db", "")).toBe("project");
  });
});
