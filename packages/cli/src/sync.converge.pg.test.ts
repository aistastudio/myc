/**
 * ПРИЁМКА memory-0sbdhdt7fm36: «три клиента с офлайн-правками сходятся к
 * одному состоянию независимо от порядка синхронизации».
 *
 * Это и есть тот единственный вопрос, ради которого CRDT берут вместо
 * «последний записавший прав по всей записи». Проверять его парой сторон
 * бессмысленно: у двоих любой порядок симметричен, и расхождение, зависящее
 * от очерёдности, просто не возникает. Нужен ТРЕТИЙ, и нужен обмен в
 * заведомо неудобном порядке.
 *
 * Стенд честный: три НАСТОЯЩИЕ локальные базы SQLite, настоящий сервер над
 * Postgres, правки делаются офлайн (без `--server`), обмен идёт командой
 * `myc sync`. Ни одна сторона не подделана — иначе тест отвечал бы не на тот
 * вопрос.
 *
 * ЧТО ИМЕННО УТВЕРЖДАЕТСЯ. Не «выиграл клиент A», а «все четверо согласны», и
 * отдельно — что победителя выбрали ЧАСЫ, а не очерёдность обмена: иначе
 * сходимость держалась бы на удаче расписания и разваливалась при первом
 * ретрае.
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
import { createLinkCommand } from "./commands/link.ts";
import { createListCommand } from "./commands/list.ts";
import { createShowCommand } from "./commands/show.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
const WS = "cherry";

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let srv: MycHttpServer | undefined;
let token = "";
let root = "";
/** Три клиента: у каждого своя база и свой site_id. */
const client: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };

function registry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createSyncCommand());
  r.register(createTaskCommand());
  r.register(createUpdateCommand());
  r.register(createLinkCommand());
  r.register(createListCommand());
  r.register(createShowCommand());
  return r;
}

const call = async (
  dir: string,
  argv: readonly string[],
  opts: { online?: boolean } = {},
) => {
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

/** Обмен до тишины: круг за кругом, пока обе стороны не перестанут что-то везти. */
const syncUntilQuiet = async (dir: string): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    const out = await call(dir, ["sync"], { online: true });
    expect([out.code, out.env.error ?? null]).toEqual([ExitCode.OK, null]);
    if (out.env.data.pushed === 0 && out.env.data.pulled === 0) return;
  }
  throw new Error("обмен не затих за пять кругов");
};

interface Snapshot {
  readonly nodes: ReadonlyArray<{ id: string; title: string; priority: number; status: string }>;
  readonly edges: ReadonlyArray<{ src: string; type: string; dst: string; deleted: number }>;
}

function localSnapshot(dir: string): Snapshot {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return {
      nodes: db
        .query("SELECT id, title, priority, status FROM nodes WHERE deleted_at IS NULL ORDER BY id")
        .all() as Snapshot["nodes"],
      edges: db
        .query(
          "SELECT src, type, dst, CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS deleted FROM edges ORDER BY src, type, dst",
        )
        .all() as Snapshot["edges"],
    };
  } finally {
    db.close();
  }
}

async function serverSnapshot(): Promise<Snapshot> {
  return pg!.withTenant("acme", async (tx) => ({
    nodes: (await tx.all<{ id: string; title: string; priority: number; status: string }>(
      {
        name: "n",
        sql: "SELECT id, title, priority, status FROM nodes WHERE scope = ?1 AND deleted_at IS NULL ORDER BY id",
        params: ["scope"],
      },
      [WS],
    )).map((n) => ({ ...n, priority: Number(n.priority) })),
    edges: await tx.all<{ src: string; type: string; dst: string; deleted: number }>(
      {
        name: "e",
        sql: `SELECT src, type, dst, CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS deleted
                FROM edges ORDER BY src, type, dst`,
        params: [],
      },
      [],
    ),
  }));
}

/** Часы последней правки поля на клиенте — ими и решается ничья (§9.3). */
function clockOf(dir: string, id: string, field: string): { hlc: bigint; site: string } {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    const row = db
      .query(
        `SELECT CAST(hlc AS TEXT) AS hlc, site_id FROM oplog
          WHERE entity_id = ?1 AND field = ?2 AND origin = 1
          ORDER BY oplog.hlc DESC LIMIT 1`,
      )
      .get(id, field) as { hlc: string; site_id: string } | null;
    if (row === null) throw new Error(`нет своей правки ${field} у ${id} в ${dir}`);
    return { hlc: BigInt(row.hlc), site: row.site_id };
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  root = mkdtempSync(join(tmpdir(), "myc-converge-"));
  for (const key of ["A", "B", "C"] as const) {
    // Слаг берётся из имени каталога, а воркспейс сервера — это scope узла:
    // у всех трёх клиентов он обязан быть один и тот же.
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

  for (const key of ["A", "B", "C"] as const) await call(client[key], ["init"]);
});

afterAll(async () => {
  srv?.stop();
  await pg?.close();
  await admin?.close();
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("три клиента и сервер", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;
  let shared = "";

  test("общая задача доезжает до всех троих", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const made = await call(client.A, ["task", "общая задача"]);
    expect([made.code, made.env.error ?? null]).toEqual([ExitCode.OK, null]);
    shared = made.env.data.id as string;

    await syncUntilQuiet(client.A);
    await syncUntilQuiet(client.B);
    await syncUntilQuiet(client.C);

    for (const key of ["A", "B", "C"] as const) {
      expect(localSnapshot(client[key]).nodes.map((n) => n.id)).toContain(shared);
    }
  });

  test("офлайн-правки троих сходятся, и порядок обмена на итог не влияет", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);

    // ОФЛАЙН: никто из троих не видит правок остальных.
    await call(client.A, ["task", "своя у A"]);
    await call(client.B, ["task", "своя у B"]);
    await call(client.C, ["task", "своя у C"]);
    // И одно и то же поле общей задачи — у двоих сразу. Это ничья, и её
    // разрешают часы, а не расписание обмена.
    expect((await call(client.A, ["update", shared, "--title", "версия A"])).code).toBe(ExitCode.OK);
    expect((await call(client.B, ["update", shared, "--title", "версия B"])).code).toBe(ExitCode.OK);
    // Третий трогает ДРУГОЕ поле того же узла: per-field LWW обязан сохранить
    // обе правки, а не отдать узел целиком победителю.
    expect((await call(client.C, ["update", shared, "--priority", "0"])).code).toBe(ExitCode.OK);

    const aClock = clockOf(client.A, shared, "title");
    const bClock = clockOf(client.B, shared, "title");

    // ПОРЯДОК НАРОЧНО НЕУДОБНЫЙ: сначала тот, кто правил вторым.
    await syncUntilQuiet(client.B);
    await syncUntilQuiet(client.C);
    await syncUntilQuiet(client.A);
    // Второй проход: то, что каждый узнал от сервера, должно доехать до всех.
    await syncUntilQuiet(client.B);
    await syncUntilQuiet(client.C);
    await syncUntilQuiet(client.A);

    const snaps = [
      localSnapshot(client.A),
      localSnapshot(client.B),
      localSnapshot(client.C),
      await serverSnapshot(),
    ];
    // Сошлись ВСЕ ЧЕТВЕРО и по всем узлам, а не только по спорному полю.
    for (const s of snaps.slice(1)) expect(s).toEqual(snaps[0]!);

    // ПОБЕДИТЕЛЯ ВЫБРАЛИ ЧАСЫ, а не очерёдность обмена: при равных часах —
    // больший site_id (§9.3). Держись сходимость на расписании, она
    // развалилась бы при первом ретрае.
    const winner =
      aClock.hlc > bClock.hlc || (aClock.hlc === bClock.hlc && aClock.site > bClock.site)
        ? "версия A"
        : "версия B";
    expect(snaps[0]!.nodes.map((n) => n.title).sort()).toEqual(
      [winner, "своя у A", "своя у B", "своя у C"].sort(),
    );
    expect(snaps[0]!.nodes.find((n) => n.id === shared)!.title).toBe(winner);

    // Правка ТРЕТЬЕГО поля пережила спор о заголовке: слияние по полям, а не
    // по записи целиком.
    expect(snaps[0]!.nodes.find((n) => n.id === shared)!.priority).toBe(0);
  });

  test("снятие убирает только виденное: ребро, добавленное параллельно, переживает", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // Снятие ребра, которого сторона НИКОГДА НЕ ВИДЕЛА, — не спор, а пустое
    // место: `link --remove` отвечает notfound.edge и не минтит операции.
    // Настоящая гонка OR-Set другая: снятие видело ОДИН тег, а параллельное
    // добавление приехало с ДРУГИМ, и его снятие убрать не вправе.
    const target = (await call(client.A, ["task", "цель ребра"])).env.data.id as string;
    await syncUntilQuiet(client.A);
    // C забирает узлы, но ребра ещё нет ни у кого.
    await syncUntilQuiet(client.C);

    expect((await call(client.A, ["link", shared, "relates-to", target])).code).toBe(ExitCode.OK);
    await syncUntilQuiet(client.A);
    // B забирает ребро и ВИДИТ его тег; C остаётся без ребра.
    await syncUntilQuiet(client.B);

    // ОФЛАЙН: B снимает то добавление, что видел; C заводит своё, о первом
    // не зная, — и получает собственный тег.
    const removed = await call(client.B, ["link", shared, "relates-to", target, "--remove"]);
    expect([removed.code, removed.env.error ?? null]).toEqual([ExitCode.OK, null]);
    const added = await call(client.C, ["link", shared, "relates-to", target]);
    expect([added.code, added.env.error ?? null]).toEqual([ExitCode.OK, null]);

    await syncUntilQuiet(client.B);
    await syncUntilQuiet(client.C);
    await syncUntilQuiet(client.A);
    await syncUntilQuiet(client.B);

    const snaps = [
      localSnapshot(client.A),
      localSnapshot(client.B),
      localSnapshot(client.C),
      await serverSnapshot(),
    ];
    for (const s of snaps.slice(1)) expect(s).toEqual(snaps[0]!);
    const edge = snaps[0]!.edges.find((e) => e.src === shared && e.dst === target);
    expect(edge).toBeDefined();
    // add wins: тег C снятие не видело, значит убрать его оно не могло.
    expect(edge!.deleted).toBe(0);
  });
});
