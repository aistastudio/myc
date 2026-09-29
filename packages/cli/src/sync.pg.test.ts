/**
 * ПРИЁМКА ОБМЕНА: ДВЕ БАЗЫ СХОДЯТСЯ, И СХОДЯТСЯ В ОБЕ СТОРОНЫ.
 *
 * Здесь проверяется не «запрос вернул 200», а СВОЙСТВО: что записали локально
 * — видно на сервере, что записали на сервере — видно локально, и повторный
 * обмен ничего не меняет. Слабее проверять бессмысленно: протокол, который
 * довозит операции, но расходится в состоянии, выглядит работающим ровно до
 * первого спора о том, чья версия верна.
 *
 * Стенд честный: НАСТОЯЩАЯ локальная база SQLite, НАСТОЯЩИЙ сервер над
 * Postgres, обмен идёт командой `myc sync` целиком — от разбора флагов до
 * записи в оплог. Подделай здесь хоть одну сторону, и тест перестанет
 * отвечать на вопрос, ради которого написан.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { createListCommand } from "./commands/list.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
const WS = "cherry";

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let srv: MycHttpServer | undefined;
let owner = "";
let member = "";
let root = "";
let local = "";

function registry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createSyncCommand());
  r.register(createTaskCommand());
  r.register(createUpdateCommand());
  r.register(createListCommand());
  return r;
}

/**
 * Вызов CLI. `server` пустой — команда идёт в ЛОКАЛЬНУЮ базу: в этом тесте
 * обе стороны настоящие, и различает их только окружение.
 */
const call = async (
  argv: readonly string[],
  opts: { server?: string; token?: string; dir?: string } = {},
) => {
  const vars: Record<string, string> = {
    MYC_SERVER: opts.server ?? "",
    MYC_TOKEN: opts.token ?? "",
    MYC_ACTOR: "anna",
  };
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const out = await run(["--json", "-C", opts.dir ?? local, ...argv], { registry: registry() });
    return { code: out.code, env: JSON.parse(out.stdout as string) as Record<string, any> };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const remote = `${WS}`;
const sync = async (flags: readonly string[] = [], token?: string) =>
  call(["sync", ...flags], { server: `${srv!.url}/${remote}`, token: token ?? owner });

/** Что лежит на сервере — читается мимо CLI, прямым запросом. */
async function serverTitles(): Promise<string[]> {
  return pg!.withTenant("acme", async (tx) => {
    const rows = await tx.all<{ title: string }>(
      { name: "t", sql: "SELECT title FROM nodes WHERE scope = ?1 AND deleted_at IS NULL ORDER BY title", params: ["scope"] },
      [WS],
    );
    return rows.map((r) => r.title);
  });
}

/** Запись сервера о пире — то, что примерка трогать не должна. */
async function peerRow(): Promise<unknown> {
  return pg!.withTenant("acme", async (tx) =>
    tx.all<Record<string, unknown>>(
      { name: "peer", sql: "SELECT peer_site_id, last_sync_at FROM sync_state ORDER BY peer_site_id", params: [] },
      [],
    ),
  );
}

/** Что лежит локально — тоже мимо CLI. */
function localTitles(): string[] {
  const db = new Database(join(local, ".myc", "myc.db"), { readonly: true });
  try {
    return db
      .query("SELECT title FROM nodes WHERE deleted_at IS NULL ORDER BY title")
      .all()
      .map((r) => (r as { title: string }).title);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  root = mkdtempSync(join(tmpdir(), "myc-sync-"));
  // Слаг берётся из имени каталога, а scope воркспейса — из слага: чтобы
  // локальный scope совпал с воркспейсом сервера, каталог так и называется.
  local = join(root, WS);
  mkdirSync(local);

  admin = new SQL(URL_ENV);
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  await admin.unsafe("INSERT INTO tenants (id, title, created_at) VALUES ('acme','Acme',1000)");
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  pg = openPostgres(u.toString());
  owner = (await addToken(pg, "acme", "anna", { role: "owner" })).token;
  member = (await addToken(pg, "acme", "boris", { role: "member" })).token;
  srv = startHttpServer({ port: 0, db: join(root, "no-such.db"), pg: u.toString() });

  await call(["init"]);
});

afterAll(async () => {
  srv?.stop();
  await pg?.close();
  await admin?.close();
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("обмен с сервером", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  test("права: обмен требует своего scope, читателю реплику не отдают", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // У member нет 'sync': реплика полная, и предикат видимости её не
    // фильтрует — отдать её значит отдать и чужое приватное.
    const denied = await sync([], member);
    expect(denied.code).toBe(ExitCode.DENIED);
    expect(denied.env.error.code).toBe("denied.scope");
  });

  test("локальная запись доезжает до сервера, серверная — до локальной базы", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);

    // Одна задача заведена локально, вторая — прямо на сервере.
    const mine = await call(["task", "заведено локально"]);
    expect([mine.code, mine.env.error ?? null]).toEqual([ExitCode.OK, null]);
    const theirs = await call(["task", "заведено на сервере"], {
      server: `${srv!.url}/${remote}`,
      token: owner,
    });
    expect([theirs.code, theirs.env.error ?? null]).toEqual([ExitCode.OK, null]);

    const first = await sync();
    expect([first.code, first.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(first.env.data.pushed).toBeGreaterThan(0);
    expect(first.env.data.pulled).toBeGreaterThan(0);

    // Свойство, ради которого всё написано: обе стороны знают обе задачи.
    expect(await serverTitles()).toEqual(["заведено локально", "заведено на сервере"]);
    expect(localTitles()).toEqual(["заведено локально", "заведено на сервере"]);
  });

  test("повторный обмен не везёт ничего: идемпотентность по op_id", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const again = await sync();
    expect(again.code).toBe(ExitCode.OK);
    expect(again.env.data.pushed).toBe(0);
    expect(again.env.data.pulled).toBe(0);
    // Один круг: спросили, услышали «нечего» и остановились.
    expect(again.env.data.rounds).toBe(1);
  });

  test("правка одного поля приезжает и не тащит за собой весь узел", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const listed = await call(["list", "--kind", "task"]);
    const rows = listed.env.data.rows as Array<{ id: string; title: string }>;
    const id = rows.find((n) => n.title === "заведено на сервере")!.id;

    const patched = await call(["update", id, "--priority", "0"]);
    expect([patched.code, patched.env.error ?? null]).toEqual([ExitCode.OK, null]);

    const out = await sync();
    expect(out.code).toBe(ExitCode.OK);
    expect(out.env.data.pushed).toBeGreaterThan(0);

    const priority = await pg!.withTenant("acme", async (tx) =>
      tx.one<{ priority: number }>(
        { name: "p", sql: "SELECT priority FROM nodes WHERE id = ?1", params: ["id"] },
        [id],
      ),
    );
    expect(Number(priority?.priority)).toBe(0);
  });

  test("--dry-run считает, но не меняет ни одной стороны", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    await call(["task", "только примерка"]);
    const before = await serverTitles();

    const beforeSync = await peerRow();

    const dry = await sync(["--dry-run"]);
    expect(dry.code).toBe(ExitCode.OK);
    expect(dry.env.data.dry).toBe(true);
    expect(dry.env.data.pushed).toBeGreaterThan(0);
    // Сервер не принял ничего: состав узлов тот же, что до примерки.
    expect(await serverTitles()).toEqual(before);
    // И состояние обмена он тоже не тронул: прогон, двигающий воды пира,
    // сухим не является — следующий настоящий обмен считал бы уже принятым
    // то, чего никто не принимал.
    expect(await peerRow()).toEqual(beforeSync);

    // А обычный обмен — принял.
    await sync();
    expect(await serverTitles()).toContain("только примерка");
  });

  test("примерка с операциями — противоречие, и сервер её не принимает", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // «Прислал, но понарошку» означало бы, что отправитель считает пакет
    // доставленным, а получатель — нет. Это отказ, а не режим.
    const res = await fetch(`${srv!.url}/v1/ws/${WS}/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: JSON.stringify({
        site_id: "siteX",
        have: {},
        dry: true,
        ops: [
          {
            op_id: "siteX:1",
            seq: 1,
            hlc: { ts: 1, ctr: 0 },
            site_id: "siteX",
            entity_id: "cherry-zzz",
            field: "kind",
            op: "set",
            value: "task",
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("usage.dry");
  });

  test("--push-only не тянет чужое, --pull-only не шлёт своё", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    await call(["task", "серверная для push-only"], {
      server: `${srv!.url}/${remote}`,
      token: owner,
    });
    await call(["task", "локальная для push-only"]);

    const pushed = await sync(["--push-only"]);
    expect(pushed.code).toBe(ExitCode.OK);
    expect(pushed.env.data.pulled).toBe(0);
    expect(await serverTitles()).toContain("локальная для push-only");
    // Чужая задача НЕ приехала: об этом и просили.
    expect(localTitles()).not.toContain("серверная для push-only");

    const pulled = await sync(["--pull-only"]);
    expect(pulled.code).toBe(ExitCode.OK);
    expect(pulled.env.data.pushed).toBe(0);
    expect(localTitles()).toContain("серверная для push-only");
  });

  test("несовпадение воркспейса — отказ, а не тихий обмен не с тем", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const wrong = await call(["sync"], { server: `${srv!.url}/portal`, token: owner });
    expect(wrong.code).toBe(ExitCode.USAGE);
    expect(wrong.env.error.code).toBe("usage.ws_mismatch");
  });

  test("без сервера обмениваться не с кем, и команда так и говорит", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const alone = await call(["sync"]);
    expect(alone.code).toBe(ExitCode.PRECOND);
    expect(alone.env.error.code).toBe("precond.no_remote");
  });
});
