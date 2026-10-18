/**
 * ПРИЁМКА retention/3: purge распространяется на другую машину.
 *
 * Стенд честный и взят у sync.converge.pg.test.ts: две НАСТОЯЩИЕ локальные
 * базы SQLite, настоящий сервер над Postgres как узел обмена, правки —
 * офлайн, обмен — `myc sync`. Проверяется ровно то, что требует спека §6.5:
 * op='purge' доезжает до пира как обычная операция, пир стирает узел у себя,
 * сервер (PG) стирает у себя, и повторный purge идемпотентен.
 *
 * Мутации, которые обязан красить этот тест (проверяются вручную при
 * приёмке): REPLICABLE_OPS без 'purge'; parseOp без ветки 'purge';
 * projectPurge, свёрнутый в no-op.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { addToken } from "@myc/server/auth";
import { startHttpServer, type MycHttpServer } from "@myc/server";
import { ExitCode } from "./exit.ts";
import { run } from "./index.ts";
import { Registry } from "./registry.ts";
import { createInitCommand } from "./commands/init.ts";
import { createSyncCommand } from "./commands/sync.ts";
import { createTaskCommand, createUpdateCommand } from "./commands/tasks.ts";
import { createPurgeCommand } from "./commands/purge.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(
  join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"),
  "utf8",
);
const WS = "cherry";

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let srv: MycHttpServer | undefined;
let token = "";
let root = "";
const client: Record<"A" | "B", string> = { A: "", B: "" };

function registry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createSyncCommand());
  r.register(createTaskCommand());
  r.register(createUpdateCommand());
  r.register(createPurgeCommand());
  return r;
}

const call = async (dir: string, argv: readonly string[], opts: { online?: boolean } = {}) => {
  const vars: Record<string, string> = {
    MYC_SERVER: opts.online === true ? `${srv!.url}/${WS}` : "",
    MYC_TOKEN: opts.online === true ? token : "",
    MYC_ACTOR: "anna",
  };
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const out = await run(["--json", "-C", dir, ...argv], { registry: registry() });
    return { code: out.code, env: JSON.parse(out.stdout as string) as Record<string, any> };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const syncUntilQuiet = async (dir: string): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    const out = await call(dir, ["sync"], { online: true });
    expect([out.code, out.env.error ?? null]).toEqual([ExitCode.OK, null]);
    if (out.env.data.pushed === 0 && out.env.data.pulled === 0) return;
  }
  throw new Error("обмен не затих за пять кругов");
};

function nodeExists(dir: string, id: string): boolean {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return ((db.query("SELECT count(*) AS n FROM nodes WHERE id = ?").get(id) as { n: number }).n ?? 0) === 1;
  } finally {
    db.close();
  }
}

function tombstoneCount(dir: string, id: string): number {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return (
      db.query("SELECT count(*) AS n FROM oplog WHERE op = 'purge' AND entity_id = ?").get(id) as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
}

async function serverNodeExists(id: string): Promise<boolean> {
  return pg!.withTenant("acme", async (tx) => {
    const rows = await tx.all<{ n: number }>(
      { name: "n", sql: "SELECT count(*) AS n FROM nodes WHERE id = ?1", params: ["id"] },
      [id],
    );
    return Number(rows[0]?.n ?? 0) === 1;
  });
}

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  root = mkdtempSync(join(tmpdir(), "myc-purge-repl-"));
  for (const key of ["A", "B"] as const) {
    const dir = join(root, key, WS);
    mkdirSync(dir, { recursive: true });
    client[key] = dir;
  }

  admin = new SQL(URL_ENV);
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  await admin.unsafe("INSERT INTO tenants (id, title, created_at) VALUES ('acme','Acme',1000)");
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  pg = openPostgres(u.toString());
  token = (await addToken(pg, "acme", "anna", { role: "owner" })).token;
  srv = startHttpServer({ port: 0, db: join(root, "no-such.db"), pg: u.toString() });

  for (const key of ["A", "B"] as const) await call(client[key], ["init"]);
});

afterAll(async () => {
  srv?.stop();
  await pg?.close();
  await admin?.close();
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

test(
  "purge доезжает до пира и стирает узел на обеих сторонах; повтор идемпотентен",
  async () => {
    if (URL_ENV === undefined) {
      console.log("MYC_PG_URL не задан — пропуск (настоящий обмен без сервера не проверить)");
      return;
    }

    // 1. A создаёт задачу; обе стороны обмениваются — B имеет узел.
    const created = await call(client.A, ["task", "задача на стирание"]);
    expect(created.code).toBe(ExitCode.OK);
    const id = created.env.data.id as string;
    await syncUntilQuiet(client.A);
    await syncUntilQuiet(client.B);
    expect(nodeExists(client.B, id)).toBe(true);
    expect(await serverNodeExists(id)).toBe(true);

    // 2. A стирает узел; обмен; B стирает у себя, тумбстоун дошёл.
    const purged = await call(client.A, ["purge", "--id", id, "--cascade"]);
    expect(purged.code).toBe(ExitCode.OK);
    expect(purged.env.data.purged).toBe(1);
    await syncUntilQuiet(client.A);
    await syncUntilQuiet(client.B);

    expect(nodeExists(client.A, id)).toBe(false);
    expect(nodeExists(client.B, id)).toBe(false);
    expect(await serverNodeExists(id)).toBe(false);
    // Тумбстоун — операция, а не намерение: строка op='purge' лежит в оплоге у обоих.
    expect(tombstoneCount(client.A, id)).toBe(1);
    expect(tombstoneCount(client.B, id)).toBe(1);

    // 3. Повторный purge — идемпотентен: ok, purged=0, новых тумбстоунов нет.
    const again = await call(client.A, ["purge", "--id", id, "--cascade"]);
    expect(again.code).toBe(ExitCode.OK);
    expect(again.env.data.purged).toBe(0);
    expect(tombstoneCount(client.A, id)).toBe(1);

    // 4. Ещё круг обмена — никто ничего не воскресил.
    await syncUntilQuiet(client.A);
    await syncUntilQuiet(client.B);
    expect(nodeExists(client.A, id)).toBe(false);
    expect(nodeExists(client.B, id)).toBe(false);
    expect(await serverNodeExists(id)).toBe(false);
  },
  180_000,
);
