/**
 * ПРИЁМКА memory-c1m2apmnhf42: РОЛЬ И ПРАВА ТОКЕНА ЗАДАЮТСЯ ИЗ CLI, И ТОКЕН
 * С `sync` ДЕЙСТВИТЕЛЬНО ОБМЕНИВАЕТСЯ.
 *
 * `serve.ts` читал `--role`, `--scopes` и `--token-ws`, но не объявлял их, и
 * разбор флагов отвергал имена как неизвестные. Следствие было не
 * косметическим: без роли `addToken` выдаёт `member`, у member нет права
 * `sync`, и токена для обмена из CLI выпустить было нельзя вовсе — оставался
 * только путь через MYC_BOOTSTRAP_*, и только для ПЕРВОГО токена арендатора.
 *
 * Поэтому проверка идёт ДО КОНЦА, до обмена: объявить флаг и убедиться, что
 * он принят, — значит проверить разбор строки, а не то, ради чего флаг
 * заведён. Здесь настоящий сервер над Postgres, настоящая локальная база и
 * настоящий `myc sync` тем самым секретом, который напечатал `--add-token`.
 *
 * Мутации, которые этот файл обязан ловить (все три проверены прогоном):
 *   1) убрать объявление `role` — 4 падения из 6: `unknown flag --role`;
 *   2) убрать объявление `scopes` — 1 падение: «права сужаются явно»;
 *   3) отдать `--add-token` роль owner по умолчанию — 2 падения: умолчание
 *      перестаёт быть member, и обмен проходит тем, чем не должен.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { startHttpServer, type MycHttpServer } from "@myc/server";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createServeCommand } from "./serve.ts";
import { createSyncCommand } from "./sync.ts";
import { createTaskCommand } from "./tasks.ts";

const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
const WS = "cherry";

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let srv: MycHttpServer | undefined;
let appUrl = "";
let root = "";
let local = "";

function registry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createServeCommand());
  r.register(createSyncCommand());
  r.register(createTaskCommand());
  return r;
}

/** Вызов CLI с подменённым окружением — как в sync.pg.test.ts. */
async function call(
  argv: readonly string[],
  opts: { server?: string; token?: string } = {},
): Promise<{ code: number; env: Record<string, any> }> {
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
    const out = await run(["--json", "-C", local, ...argv], { registry: registry() });
    return { code: out.code, env: JSON.parse(out.stdout as string) as Record<string, any> };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Выпуск токена ровно тем путём, которым его выпускает человек. */
const mint = (spec: string, ...flags: string[]) =>
  call(["serve", "--pg", appUrl, "--add-token", spec, ...flags]);

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  root = mkdtempSync(join(tmpdir(), "myc-token-scopes-"));
  // Слаг берётся из имени каталога, а scope — из слага: каталог назван как
  // воркспейс сервера, иначе обмен откажет по несовпадению.
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
  appUrl = u.toString();
  pg = openPostgres(appUrl);
  srv = startHttpServer({ port: 0, db: join(root, "no-such.db"), pg: appUrl });

  await call(["init"]);
});

afterAll(async () => {
  srv?.stop();
  await pg?.close();
  await admin?.close();
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("myc serve --add-token: роль, права и воркспейс задаются флагами", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  test("по умолчанию member, и права ровно те, что значит роль", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const r = await mint("acme:boris");
    expect([r.code, r.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(r.env.data.role).toBe("member");
    expect(r.env.data.scopes).toBe("read,write,claim");
  });

  test("--role owner принимается и даёт право обмена", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const r = await mint("acme:anna", "--role", "owner");
    expect([r.code, r.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(r.env.data.role).toBe("owner");
    expect(r.env.data.scopes.split(",")).toContain("sync");
  });

  test("--scopes сужает права роли явно и НАКАПЛИВАЕТСЯ", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const r = await mint("acme:bot", "--role", "owner", "--scopes", "read,sync");
    expect([r.code, r.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(r.env.data.role).toBe("owner");
    expect(r.env.data.scopes).toBe("read,sync");
    // Описание обещает запятую, значит повтор флага складывается, а не съедает
    // первое значение (flags.list.test.ts держит это обещание для всех флагов).
    const twice = await mint("acme:bot2", "--role", "owner", "--scopes", "read", "--scopes", "sync");
    expect([twice.code, twice.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(twice.env.data.scopes).toBe("read,sync");
  });

  test("--token-ws привязывает токен к одному воркспейсу", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const r = await mint("acme:one", "--token-ws", WS);
    expect([r.code, r.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(r.env.data.ws).toBe(WS);
  });

  test("непонятная роль и пустые права — отказ до записи в базу", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const badRole = await mint("acme:x", "--role", "начальник");
    expect(badRole.code).toBe(ExitCode.USAGE);
    expect(badRole.env.error.msg).toContain("unknown role");
    const badScopes = await mint("acme:y", "--scopes", "летать,плавать");
    expect(badScopes.code).toBe(ExitCode.USAGE);
    expect(badScopes.env.error.msg).toContain("--scopes");
    const left = await pg!.raw<{ n: string }>(
      "SELECT count(*) AS n FROM api_tokens WHERE subject IN ('x','y')",
    );
    expect(Number(left[0]?.n ?? 0)).toBe(0);
  });

  /**
   * ГЛАВНОЕ. Флаг доказан не разбором строки, а обменом: тем самым секретом,
   * который напечатал `--add-token`, проходит `myc sync` — и не проходит
   * токеном по умолчанию.
   */
  test("выпущенным из CLI токеном с sync обмен идёт, а токеном по умолчанию — нет", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const owner = (await mint("acme:sync-owner", "--role", "owner")).env.data.token as string;
    const plain = (await mint("acme:sync-member")).env.data.token as string;
    expect(typeof owner).toBe("string");
    expect(owner.length).toBeGreaterThan(0);

    const made = await call(["task", "уедет на сервер выпущенным токеном"]);
    expect([made.code, made.env.error ?? null]).toEqual([ExitCode.OK, null]);

    const denied = await call(["sync"], { server: `${srv!.url}/${WS}`, token: plain });
    expect(denied.code).toBe(ExitCode.DENIED);
    expect(denied.env.error.code).toBe("denied.scope");

    const ok = await call(["sync"], { server: `${srv!.url}/${WS}`, token: owner });
    expect([ok.code, ok.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(ok.env.data.pushed).toBeGreaterThan(0);

    // Задача действительно на сервере — читается мимо CLI, прямым запросом.
    const titles = await pg!.withTenant("acme", async (tx) =>
      (
        await tx.all<{ title: string }>(
          { name: "t", sql: "SELECT title FROM nodes WHERE scope = ?1 AND deleted_at IS NULL", params: ["scope"] },
          [WS],
        )
      ).map((r) => r.title),
    );
    expect(titles).toContain("уедет на сервер выпущенным токеном");
  });
});
