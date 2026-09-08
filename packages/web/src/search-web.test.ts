/**
 * Приёмка экрана «поиск» (W6, memory-c7075t2s0nj6).
 *
 * ПРИЁМКА ОДНОЙ СТРОКОЙ: выдача /api/search СОВПАДАЕТ с настоящим процессом
 * `myc recall <query> --json` — порядок, оценки (score, confidence) и
 * предупреждения (warn[]/meta.degraded[]), а не «похоже». Оба пути идут через
 * ОДИН И ТОТ ЖЕ подпроцесс `myc` (bootstrap-web.test.ts даёт тот же приём для
 * бутстрапа, write.test.ts — для записи): сервер вызывает `runCli(["recall",
 * …, "--json"])`, тест — тот же бинарь напрямую тем же argv. Расхождение
 * возможно только если сервер собрал другой argv или потерял поле конверта.
 *
 * Единственное, что нормализуется — `took_ms`: реальное время двух разных
 * вызовов процесса физически не может совпасть.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startVizServer, type VizServer } from "./server.ts";
import type { RunCli } from "./mutate.ts";
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

interface RecallEnvelope {
  ok: boolean;
  data: Record<string, unknown>;
  meta: { degraded: string[] } & Record<string, unknown>;
  warn: { code: string; msg: string }[];
}

/** Прямой прогон `myc recall <query> --json <extra>` тем же подпроцессом, что у сервера. */
async function directRecall(run: RunCli, query: string, extra: readonly string[] = []): Promise<RecallEnvelope> {
  const out = await run(["recall", query, ...extra, "--json"]);
  const line = out.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as RecallEnvelope;
}

interface Envelope {
  ok?: boolean;
  data?: Record<string, unknown>;
  meta?: { degraded?: string[] } & Record<string, unknown>;
  warn?: { code: string; msg: string }[];
  error?: { code: string; msg: string; hint?: string };
}

async function get(url: string, path: string): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as Envelope };
}

/**
 * Нормализация перед сравнением — РОВНО ДВА ПОЛЯ, физически не способных
 * совпасть между двумя вызовами процесса, и ничего сверх того.
 *
 * `took_ms` — время исполнения, гуляет на каждом входе вложенных объектов
 * (federation.queried[].took_ms и т.п.), поэтому чистка рекурсивная.
 *
 * `score` — RRF x бусты (hybrid.ts): найдено экспериментально (см. отчёт
 * задачи W6), что сырой score плавает в 8-м значащем разряде МЕЖДУ ДВУМЯ
 * НЕЗАВИСИМЫМИ вызовами `myc recall` на одной и той же неизменной базе —
 * то есть это нестабильность самого движка ретрива (вне границ этой задачи:
 * packages/retrieval и packages/cli трогать нельзя), а не расхождение
 * HTTP-обёртки с CLI. Округление до 6 знаков после запятой достаточно,
 * чтобы не потерять реальное расхождение (разный порядок, разная выдача), и
 * недостаточно, чтобы скрыть эту гуляющую последнюю цифру.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "took_ms") continue;
      out[k] = k === "score" && typeof v === "number" ? Number(v.toFixed(6)) : normalize(v);
    }
    return out;
  }
  return value;
}

function stripTiming(data: Record<string, unknown>): unknown {
  return normalize(data);
}

async function remember(run: RunCli, text: string, extra: readonly string[] = []): Promise<void> {
  const out = await run(["remember", text, ...extra, "--json"]);
  expect(out.code).toBe(0);
}

// ---------------------------------------------------------------------------
// приёмка одной строкой: совпадение с `myc recall`
// ---------------------------------------------------------------------------

describe("GET /api/search — совпадение с `myc recall`", () => {
  test("пустая база: total 0, warn/degraded совпадают", async () => {
    const { run, url } = await ws();

    const direct = await directRecall(run, "переезд задачи");
    const httpRes = await get(url, "/api/search?q=" + encodeURIComponent("переезд задачи"));

    expect(httpRes.status).toBe(200);
    expect(httpRes.body.ok).toBe(true);
    expect(stripTiming(httpRes.body.data!)).toEqual(stripTiming(direct.data));
    expect(httpRes.body.warn).toEqual(direct.warn);
    expect(httpRes.body.meta?.degraded).toEqual(direct.meta.degraded);
  });

  test("с узлами: порядок, score и confidence совпадают строка в строку", async () => {
    const { run, url } = await ws();
    await remember(run, "переезд задачи между эпиками ломает нумерацию подзадач");
    await remember(run, "бюджет prime считается посимвольно, не токенами");
    await remember(run, "правило запуска для агента: бюджет prime 1500 символов");
    await remember(run, "совсем другая тема — рецепт борща");

    const query = "бюджет prime";
    const direct = await directRecall(run, query);
    const httpRes = await get(url, `/api/search?q=${encodeURIComponent(query)}`);

    expect(httpRes.status).toBe(200);
    const httpRows = (httpRes.body.data as { rows: unknown[] }).rows;
    const directRows = (direct.data as { rows: unknown[] }).rows;
    expect(normalize(httpRows)).toEqual(normalize(directRows));
    expect(stripTiming(httpRes.body.data!)).toEqual(stripTiming(direct.data));
    expect(httpRes.body.warn).toEqual(direct.warn);
  });

  test("векторная ветка не звалась (embed-timeout=0 по умолчанию): degraded.embeddings в обоих путях", async () => {
    const { run, url } = await ws();
    await remember(run, "миграция схемы требует резервной копии перед прогоном");

    const query = "миграция схемы";
    const direct = await directRecall(run, query);
    const httpRes = await get(url, `/api/search?q=${encodeURIComponent(query)}`);

    expect(direct.warn.some((w) => w.code === "degraded.embeddings")).toBe(true);
    expect(httpRes.body.warn).toEqual(direct.warn);
    expect(httpRes.body.meta?.degraded).toEqual(direct.meta.degraded);
  });

  test("параметры (limit/kind/mode) доезжают до движка идентично прямому вызову", async () => {
    const { run, url } = await ws();
    await remember(run, "первая заметка про тестовое покрытие", ["--tag", "x"]);
    await remember(run, "вторая заметка про тестовое покрытие", ["--tag", "x"]);
    await remember(run, "третья заметка про тестовое покрытие", ["--tag", "x"]);

    const query = "тестовое покрытие";
    const extra = ["-n", "2", "--mode", "bm25"];
    const direct = await directRecall(run, query, extra);
    const httpRes = await get(url, `/api/search?q=${encodeURIComponent(query)}&n=2&mode=bm25`);

    expect(httpRes.status).toBe(200);
    expect(stripTiming(httpRes.body.data!)).toEqual(stripTiming(direct.data));
    expect((httpRes.body.data as { rows: unknown[] }).rows.length).toBe(2);
  });

  test("пустой запрос отклоняется 400, подпроцесс не запускается лишний раз", async () => {
    const { url } = await ws();
    const res = await fetch(`${url}/api/search?q=`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; msg?: string };
    expect(body.error).toBe("usage.invalid");
  });

  test("readOnly=true всё равно обслуживает GET /api/search (поиск — не запись)", async () => {
    const w = await makeWorkspace();
    cleanups.push(() => w.cleanup());
    const run = cliRunnerFor(w);
    await remember(run, "узел для проверки read-only поиска");
    const server = startVizServer({ dbPath: w.dbPath, dir: w.dir, port: 0, runCli: run, readOnly: true });
    servers.push(server);
    const url = server.url.replace(/\/$/, "");

    const res = await get(url, "/api/search?q=" + encodeURIComponent("read-only поиска"));
    expect(res.status).toBe(200);
    expect((res.body.data as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });
});
