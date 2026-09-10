/**
 * Приёмка экрана «бутстрап» (W9, memory-hxatd6ce2ymn).
 *
 * Главный тест сравнивает `data.text` из HTTP-ответа с тем, что вернул
 * настоящий процесс `myc bootstrap --json` (write.test.ts даёт тот же приём
 * для остальных мутаций) — путь записи и путь чтения здесь оба идут через
 * `run()` из @myc/cli подпроцессом, не через заглушку.
 *
 * Байтовое сравнение НОРМАЛИЗУЕТ два поля подвала — `N мс` и `cache
 * hit|miss|off`: это единственное, что физически не может совпасть между
 * двумя разными вызовами процесса (время исполнения и то, попал ли второй
 * вызов в кеш автодетекта, записанный первым). Всё остальное — шапка,
 * порядок блоков, порезка бюджетом, длина тела — сравнивается посимвольно.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startVizServer, type VizServer } from "./server.ts";
import {
  loadBootstrapHistory,
  planBootstrapRm,
  planBootstrapSet,
} from "./bootstrap.ts";
import type { RunCli } from "./mutate.ts";
import { makeWorkspace, type Workspace } from "./harness.ts";
import { openReadOnly } from "./db.ts";

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

/** Прямой прогон `myc bootstrap --json` тем же подпроцессом, что у сервера. */
async function directBootstrap(
  run: RunCli,
  args: readonly string[] = [],
): Promise<{ text: string; truncated: boolean; dropped: string[]; clipped: string[] }> {
  const out = await run(["bootstrap", ...args, "--json"]);
  const line = out.stdout.trim().split("\n").pop() ?? "";
  const env = JSON.parse(line) as {
    ok: boolean;
    data: { text: string; truncated: boolean; dropped: string[]; clipped: string[] };
  };
  expect(env.ok).toBe(true);
  return env.data;
}

/** Стирает то единственное, что не может совпасть между двумя вызовами процесса. */
function normalizeFooter(text: string): string {
  return text
    .replace(/· \d+ ms/g, "· N ms")
    .replace(/cache (hit|miss|off)/g, "cache X");
}

async function ws(): Promise<{ w: Workspace; run: RunCli; server: VizServer; url: string }> {
  const w = await makeWorkspace();
  cleanups.push(() => w.cleanup());
  const run = cliRunnerFor(w);
  const server = startVizServer({ dbPath: w.dbPath, dir: w.dir, port: 0, runCli: run });
  servers.push(server);
  return { w, run, server, url: server.url.replace(/\/$/, "") };
}

interface Envelope {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; msg: string; hint?: string };
}

async function get(url: string, path: string): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function post(url: string, path: string, body: unknown): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

// ---------------------------------------------------------------------------
// приёмка одной строкой: побайтовое совпадение с `myc bootstrap`
// ---------------------------------------------------------------------------

describe("GET /api/bootstrap — побайтовое совпадение", () => {
  test("пустой воркспейс: HTTP-текст совпадает с прямым вызовом CLI", async () => {
    const { run, url } = await ws();

    // Прогреваем кеш автодетекта тем же вызовом, что сделает сервер, — иначе
    // первый вызов увидит "miss", второй "hit", и различие было бы не в
    // подстановке, а в порядке прогрева (не то, что проверяет этот тест).
    await directBootstrap(run);
    const direct = await directBootstrap(run);

    const httpRes = await get(url, "/api/bootstrap");
    expect(httpRes.status).toBe(200);
    const httpText = httpRes.body.data?.["text"] as string;

    expect(normalizeFooter(httpText)).toBe(normalizeFooter(direct.text));
  });

  test("с ручным блоком: подстановка видна в тексте, а не шаблон", async () => {
    const { run, url } = await ws();
    const setRes = await post(url, "/api/bootstrap/style", {
      text: "используй короткие сообщения коммитов",
    });
    expect(setRes.status).toBe(200);
    expect(setRes.body.data?.["created"]).toBe(true);

    const httpRes = await get(url, "/api/bootstrap");
    const httpText = httpRes.body.data?.["text"] as string;

    // РЕЗУЛЬТАТ подстановки: реальный текст блока — не placeholder вроде
    // "{text}" или "<manual:style>".
    expect(httpText).toContain("[manual:style]");
    expect(httpText).toContain("используй короткие сообщения коммитов");
    expect(httpText).not.toContain("{text}");

    const direct = await directBootstrap(run);
    expect(normalizeFooter(httpText)).toBe(normalizeFooter(direct.text));
  });

  test("маленький бюджет: обрезка ПОКАЗАНА в тексте, а не только флагом", async () => {
    const { run, url } = await ws();
    await post(url, "/api/bootstrap/rule-one", { text: "A".repeat(400) });
    await post(url, "/api/bootstrap/rule-two", { text: "B".repeat(400) });

    const httpRes = await get(url, "/api/bootstrap?budget=260");
    expect(httpRes.status).toBe(200);
    const data = httpRes.body.data as {
      text: string;
      truncated: boolean;
      dropped: string[];
      clipped: string[];
      budget: number;
    };

    expect(data.budget).toBe(260);
    expect(data.truncated).toBe(true);
    expect(data.dropped.length + data.clipped.length).toBeGreaterThan(0);
    // Обрезка обязана быть видна В САМОМ ТЕКСТЕ (строка "# CUT …"), не только
    // в структурных полях JSON — предпросмотр это то, что реально увидит
    // агент, а он читает text, а не meta.
    expect(data.text).toContain("# CUT");

    const direct = await directBootstrap(run, ["--budget", "260"]);
    expect(normalizeFooter(data.text)).toBe(normalizeFooter(direct.text));
    expect(direct.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// запись: тем же путём, что и остальные мутации веба
// ---------------------------------------------------------------------------

describe("POST /api/bootstrap/<key> и .../op — запись через общий движок", () => {
  test("set создаёт узел kind=note layer=3 topic=bootstrap; повтор — updated:false", async () => {
    const { run, url, w } = await ws();
    const first = await post(url, "/api/bootstrap/style", { text: "первая версия" });
    expect(first.status).toBe(200);
    expect(first.body.data?.["created"]).toBe(true);
    const id = first.body.data?.["id"] as string;
    expect(typeof id).toBe("string");

    const db = openReadOnly(w.dbPath);
    const row = db.one<{ kind: string; layer: number; attrs: string }>(
      "SELECT kind, layer, attrs FROM nodes WHERE id = ?1",
      [id],
    );
    expect(row?.kind).toBe("note");
    expect(row?.layer).toBe(3);
    expect(JSON.parse(row?.attrs ?? "{}").topic).toBe("bootstrap");

    const second = await post(url, "/api/bootstrap/style", { text: "вторая версия" });
    expect(second.status).toBe(200);
    expect(second.body.data?.["created"]).toBe(false);
    expect(second.body.data?.["id"]).toBe(id);

    const blocksRes = await get(url, "/api/bootstrap/blocks");
    const rows = (blocksRes.body.data as { rows: { key: string; tier: string; id: string }[] }).rows;
    const styleRow = rows.find((r) => r.key === "style");
    expect(styleRow?.tier).toBe("project");
    expect(styleRow?.id).toBe(id);

    void run; // избегаем неиспользуемой переменной при чтении сверху
  });

  test("op rm удаляет блок — не отдаётся списком", async () => {
    const { url } = await ws();
    await post(url, "/api/bootstrap/temp", { text: "снести после проверки" });
    const before = await get(url, "/api/bootstrap/blocks");
    expect((before.body.data as { rows: unknown[] }).rows.length).toBe(1);

    const rm = await post(url, "/api/bootstrap/temp/op", { op: "rm" });
    expect(rm.status).toBe(200);

    const after = await get(url, "/api/bootstrap/blocks");
    expect((after.body.data as { rows: unknown[] }).rows.length).toBe(0);
  });

  test("история блока: оплог хранит обе версии текста", async () => {
    const { url, w } = await ws();
    const first = await post(url, "/api/bootstrap/style", { text: "было" });
    const id = first.body.data?.["id"] as string;
    await post(url, "/api/bootstrap/style", { text: "стало" });

    const histRes = await get(url, `/api/bootstrap/blocks/${id}/history`);
    expect(histRes.status).toBe(200);
    const rows = (histRes.body as unknown as { rows: { text: string | null }[] }).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.text).toBe("стало"); // hlc DESC — новое первым
    expect(rows.some((r) => r.text === "было")).toBe(true);

    void w;
  });
});

// ---------------------------------------------------------------------------
// ограждения: мутация числами на каждую защиту
// ---------------------------------------------------------------------------

describe("ограждения planBootstrapSet/planBootstrapRm — мутация числами", () => {
  test("пустой/отсутствующий text отклоняется (400), 0 узлов не создаётся", () => {
    const missing = planBootstrapSet("style", {});
    expect("argv" in missing).toBe(false);
    if (!("argv" in missing)) expect(missing.status).toBe(400);

    const empty = planBootstrapSet("style", { text: "" });
    expect("argv" in empty).toBe(false);
  });

  test("text '-' отклоняется (сентинел stdin CLI)", () => {
    const dash = planBootstrapSet("style", { text: "-" });
    expect("argv" in dash).toBe(false);
    if (!("argv" in dash) && !dash.ok) expect(dash.code).toBe("usage.invalid");
  });

  test("op, отличный от 'rm', отклоняется (400)", () => {
    const bogus = planBootstrapRm("style", { op: "close" });
    expect("argv" in bogus).toBe(false);
    if (!("argv" in bogus)) expect(bogus.status).toBe(400);

    const missing = planBootstrapRm("style", {});
    expect("argv" in missing).toBe(false);
  });

  test("валидный set/rm даёт ровно ожидаемый argv (0 лишних флагов)", () => {
    const set = planBootstrapSet("style", { text: "текст" });
    expect("argv" in set).toBe(true);
    if ("argv" in set) expect(set.argv).toEqual(["bootstrap", "set", "style", "текст"]);

    const setGlobal = planBootstrapSet("style", { text: "текст", global: true });
    if ("argv" in setGlobal) {
      expect(setGlobal.argv).toEqual(["bootstrap", "set", "--global", "style", "текст"]);
    }

    const rm = planBootstrapRm("style", { op: "rm" });
    if ("argv" in rm) expect(rm.argv).toEqual(["bootstrap", "rm", "style"]);
  });
});

describe("loadBootstrapHistory — личный ярус (S41)", () => {
  test("id '-' (блок личного яруса без id) — пустая история, не ошибка", async () => {
    const { w } = await ws();
    const db = openReadOnly(w.dbPath);
    expect(loadBootstrapHistory(db, "-")).toEqual([]);
    expect(loadBootstrapHistory(db, "")).toEqual([]);
  });
});
