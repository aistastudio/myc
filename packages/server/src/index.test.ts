/**
 * HTTP API (M0-срез `myc serve`): health-тройка и инвариант И2 на третьей
 * поверхности. Главный тест — приёмочный для задачи: при выключенных
 * эмбеддингах данные не теряются (absorb-кандидаты становятся relates, а не
 * выбрасываются и не сливаются), а деградация видна на всех трёх
 * поверхностях — CLI (meta.degraded конверта), MCP (structuredContent.meta)
 * и HTTP (degraded[] у /v1/health/index).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliTestEnv } from "@myc/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { startHttpServer, type IndexHealth, type MycHttpServer } from "./index.ts";

const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const TEST_ENV: Record<string, string> = cliTestEnv({ MYC_ACTOR: "e2e-http" });


async function cli(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, CLI, "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: TEST_ENV,
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

async function cliJson<T>(dir: string, ...args: string[]): Promise<T> {
  const r = await cli(dir, ...args, "--json");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as T;
}

/** Минимальный JSON-RPC клиент по stdio: запросы строго последовательные. */
class McpClient {
  #proc: Subprocess;
  #reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  #buffer = "";
  #lines: string[] = [];
  #waiters: ((line: string) => void)[] = [];
  #nextId = 0;

  constructor(dir: string) {
    this.#proc = Bun.spawn([process.execPath, CLI, "-C", dir, "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: TEST_ENV,
    });
    this.#reader = (this.#proc.stdout as ReadableStream<Uint8Array>).getReader() as {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
    };
    void this.#pump();
  }

  async #pump(): Promise<void> {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await this.#reader.read();
      if (done) return;
      this.#buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(line);
        else this.#lines.push(line);
      }
    }
  }

  #nextLine(): Promise<string> {
    const buffered = this.#lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = ++this.#nextId;
    const sink = this.#proc.stdin as import("bun").FileSink;
    sink.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`,
    );
    for (;;) {
      const line = JSON.parse(await this.#nextLine()) as Record<string, unknown> & {
        id?: number;
      };
      if (line.id === id) return line;
    }
  }

  async notify(method: string): Promise<void> {
    (this.#proc.stdin as import("bun").FileSink).write(
      `${JSON.stringify({ jsonrpc: "2.0", method })}\n`,
    );
  }

  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    result?: {
      content?: { text: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  }> {
    return (await this.request("tools/call", { name, arguments: args })) as never;
  }

  async close(): Promise<void> {
    try {
      (this.#proc.stdin as import("bun").FileSink).end();
    } catch {
      // уже закрыт
    }
    await this.#proc.exited;
  }
}

interface Envelope {
  ok: boolean;
  data: {
    by_class?: Record<string, number>;
    nodes?: { id: string; class: string; quality: string }[];
    degraded: string | null;
  };
  meta: { degraded: string[] };
  warn: { code: string; msg: string }[];
}

let dir: string;
const servers: MycHttpServer[] = [];

function serve(db: string): MycHttpServer {
  const s = startHttpServer({ port: 0, db });
  servers.push(s);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-http-e2e-"));
});

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("myc serve (HTTP API, M0)", () => {
  test("/v1/health — liveness: 200 всегда, даже без базы; остальные — 503", async () => {
    const s = serve(join(dir, "no-such.db"));
    const health = await fetch(`${s.url}/v1/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; pid: number };
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);

    const dbHealth = await fetch(`${s.url}/v1/health/db`);
    expect(dbHealth.status).toBe(503);
    expect(((await dbHealth.json()) as { error: { code: string } }).error.code).toBe("db.missing");

    const index = await fetch(`${s.url}/v1/health/index`);
    expect(index.status).toBe(503);
    const indexBody = (await index.json()) as { degraded: string[] };
    expect(indexBody.degraded).toContain("db.missing");
  });

  test("неизвестный маршрут — 404 с машинным кодом", async () => {
    const s = serve(join(dir, "no-such.db"));
    const r = await fetch(`${s.url}/v1/nope`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("notfound.route");
  });

  test(
    "И2: эмбеддинги выключены — данные не потеряны, деградация видна в CLI, MCP и HTTP",
    async () => {
      expect((await cli(dir, "init")).code).toBe(0);
      // Два факта в поясе похожести (общий префикс, разное продолжение):
      // с векторами это related, без векторов обязаны стать relates, а не
      // быть слитыми или выброшенными.
      const textA =
        "Синхронизация оплога идёт через git push в refs dolt data на удалённый репозиторий команды";
      const textB =
        "Синхронизация оплога идёт через git push, а граф связности пересобирается локально из памяти";
      // Третий факт нужен, чтобы дойти до ветки ДОПОЛНИТЕЛЬНЫХ relates
      // (`related[]`, потолок max_related). На двух узлах она недостижима:
      // единственный кандидат становится целевым, а список остальных пуст,
      // и ребро приходит из классификации. Проверено мутацией: выброс
      // кандидатов без вектора срезал связи с 6 до 3 на трёх узлах и НЕ
      // ронял этот тест, пока фактов было два. Молчаливая потеря половины
      // связей при отключённых эмбеддингах — ровно то, что запрещает И2.
      const textC =
        "Синхронизация оплога через git push и дедупликация по op_id при слиянии веток";
      await cli(dir, "remember", textA);
      await cli(dir, "remember", textB);
      await cli(dir, "remember", textC);

      // --- поверхность 1: CLI — meta.degraded конверта -------------------
      const env = await cliJson<Envelope>(dir, "absorb", "--no-embed");
      expect(env.meta.degraded).toContain("degraded.embed");
      expect(env.warn.map((w) => w.code)).toContain("degraded.embed");
      expect(env.data.by_class?.related ?? 0).toBeGreaterThanOrEqual(1);

      // Данные не потеряны: оба узла живы и активны, кандидат стал relates,
      // строка узла несёт качество вердикта (lexical) и отметку degraded_at.
      const dbPath = join(dir, ".myc", "myc.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const notes = db
          .query(
            "SELECT id, status, head_id, attrs FROM nodes WHERE kind = 'note' AND deleted_at IS NULL ORDER BY created_at",
          )
          .all() as { id: string; status: string; head_id: string | null; attrs: string }[];
        expect(notes.length).toBe(3);
        for (const n of notes) {
          expect(n.status).toBe("active");
          expect(n.head_id).toBeNull();
        }
        const relates = db
          .query("SELECT src, dst, weight FROM edges WHERE type = 'relates' AND deleted_at IS NULL")
          .all() as { src: string; dst: string; weight: number }[];
        // Не «хотя бы одно»: на трёх похожих фактах без векторов обязаны
        // выжить и дополнительные связи, а не только цель классификации.
        expect(relates.length).toBeGreaterThanOrEqual(6);
        const attrs = notes.map((n) => JSON.parse(n.attrs) as Record<string, unknown>);
        const absorbed = attrs.find((a) => a["absorb"] !== undefined) as {
          absorb: { quality: string; class: string };
          degraded_at?: number;
        };
        expect(absorbed.absorb.quality).toBe("lexical");
        expect(absorbed.absorb.class).toBe("related");
        expect(absorbed.degraded_at).toBeGreaterThan(0);
      } finally {
        db.close();
      }

      // --- поверхность 2: MCP — structuredContent.meta.degraded ----------
      const mcp = new McpClient(dir);
      try {
        await mcp.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e-http", version: "0" },
        });
        await mcp.notify("notifications/initialized");
        const recall = await mcp.call("myc_recall", { query: "синхронизация оплога" });
        expect(recall.result?.isError).toBeUndefined();
        const mcpMeta = recall.result?.structuredContent?.["meta"] as { degraded: string[] };
        expect(mcpMeta.degraded.length).toBeGreaterThan(0);
      } finally {
        await mcp.close();
      }

      // --- поверхность 3: HTTP — degraded[] в ответе ---------------------
      const s = serve(dbPath);
      const dbHealth = await fetch(`${s.url}/v1/health/db`);
      expect(dbHealth.status).toBe(200);
      const dbBody = (await dbHealth.json()) as { ok: boolean; schema: string };
      expect(dbBody.ok).toBe(true);
      expect(dbBody.schema).toMatch(/^v\d+$/);

      const index = await fetch(`${s.url}/v1/health/index`);
      expect(index.status).toBe(200);
      const indexBody = (await index.json()) as IndexHealth;
      // absorb записал в myc_health state='degraded' с причиной — HTTP это отдаёт
      expect(indexBody.degraded).toContain("health.absorb");
      expect(indexBody.degraded).toContain("embeddings.off");
      expect(indexBody.ok).toBe(false);
      const absorbWarn = indexBody.warn.find((w) => w.code === "health.absorb");
      expect(absorbWarn?.msg).toContain("degraded");
      expect(absorbWarn?.msg.length ?? 0).toBeGreaterThan("health.absorb".length);
      const component = indexBody.components.find((c) => c.component === "absorb");
      expect(component?.state).toBe("degraded");
      // тот же запрос показывает и сами данные: узлы на месте, векторов нет
      expect(indexBody.nodes).toBeGreaterThanOrEqual(2);
      expect(indexBody.vectors).toBe(0);
    },
    60_000,
  );
});
