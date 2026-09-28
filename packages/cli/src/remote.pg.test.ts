/**
 * CLI ПРОТИВ ЖИВОГО СЕРВЕРА.
 *
 * Здесь проверяется то единственное, ради чего клиент написан: человек с
 * `--server` работает с ОБЩЕЙ базой команды, а не со своей. Полный круг —
 * завести задачу, увидеть её в списке и в карточке, взять в работу, поправить
 * — идёт через HTTP, и ни одна строка при этом не появляется в локальной
 * базе.
 *
 * Отдельно проверяется отказ: команда, не умеющая сервер, обязана сказать об
 * этом, а не уйти молча в локальную базу. Молчаливый запасной путь здесь —
 * худшее из возможного: человек увидит свои задачи и решит, что это общие.
 *
 * Без MYC_PG_URL тест говорит об этом и пропускается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SQL } from "bun";
import { openPostgres, type PostgresDriver } from "@myc/store-postgres";
import { addToken } from "@myc/server/auth";
import { startHttpServer, type MycHttpServer } from "@myc/server";
import { ExitCode } from "./exit.ts";
import { run } from "./index.ts";
import { Registry } from "./registry.ts";
import { createClaimCommand, createTaskCommand, createUpdateCommand } from "./commands/tasks.ts";
import { createListCommand } from "./commands/list.ts";
import { createReadyCommand } from "./commands/ready.ts";
import { createPrimeCommand } from "./commands/prime.ts";
import { createShowCommand } from "./commands/show.ts";


const URL_ENV = process.env.MYC_PG_URL;
const DDL = readFileSync(join(import.meta.dir, "..", "..", "..", "db", "schema.postgres.sql"), "utf8");
const WS = "cherry";

let admin: SQL | undefined;
let pg: PostgresDriver | undefined;
let srv: MycHttpServer | undefined;
let token = "";
let dir = "";

function registry(): Registry {
  const r = new Registry();
  r.register(createTaskCommand());
  r.register(createListCommand());
  r.register(createReadyCommand());
  r.register(createPrimeCommand());
  r.register(createShowCommand());
  r.register(createClaimCommand());
  r.register(createUpdateCommand());
  // Команда БЕЗ удалённого режима — пустышка, и это НАМЕРЕННО. Настоящая
  // (statusline) при снятом страже лезет в рабочий воркспейс и уносит вывод
  // теста с собой: мутация тогда срывает прогон вместо того, чтобы уронить
  // проверку. Пустышка отвечает мгновенно и ничего не трогает, поэтому
  // мутация видна как обычное падение.
  r.register({
    name: "локальная",
    summary: "команда, не умеющая сервер (для проверки отказа)",
    handler: () => ({ ok: true as const, data: { local: true } }),
  });
  return r;
}

/**
 * Один вызов CLI с окружением, КАК ЕГО ВИДИТ КОМАНДА. Команды репозитория
 * читают `process.env` (resolveActor и прочие), поэтому и здесь переменные
 * ставятся туда же и снимаются после — иначе тест проверял бы не тот путь,
 * которым ходит человек.
 */
const call = async (argv: readonly string[], extra: Record<string, string> = {}) => {
  const vars: Record<string, string> = {
    MYC_SERVER: `${srv!.url}/${WS}`,
    MYC_TOKEN: token,
    MYC_ACTOR: "anna",
    ...extra,
  };
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const out = await run(["--json", ...argv], { registry: registry() });
    return { code: out.code, env: JSON.parse(out.stdout as string) as Record<string, any> };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

beforeAll(async () => {
  if (URL_ENV === undefined) return;
  dir = mkdtempSync(join(tmpdir(), "myc-remote-"));
  admin = new SQL(URL_ENV);
  await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.unsafe(DDL);
  await admin.unsafe("ALTER ROLE myc_app LOGIN PASSWORD 'myc_app_test'");
  await admin.unsafe("INSERT INTO tenants (id, title, created_at) VALUES ('acme','Acme',1000)");
  const u = new URL(URL_ENV);
  u.username = "myc_app";
  u.password = "myc_app_test";
  pg = openPostgres(u.toString());
  token = (await addToken(pg, "acme", "anna")).token;
  srv = startHttpServer({ port: 0, db: join(dir, "no-such.db"), pg: u.toString() });
});

afterAll(async () => {
  srv?.stop();
  await pg?.close();
  await admin?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("CLI через сервер команды", () => {
  const skip = URL_ENV === undefined ? "нет MYC_PG_URL — Postgres не поднят" : null;

  test("полный круг: завести, увидеть, взять, поправить — всё на общей базе", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);

    const made = await call(["task", "через клиент"]);
    expect([made.code, made.env.error ?? null]).toEqual([ExitCode.OK, null]);
    const id = made.env.data.id as string;
    expect(id.startsWith(`${WS}-`)).toBe(true);
    // Конверт называет, что работа шла НЕ с локальной базой.
    expect(made.env.meta.remote).toBe(WS);

    const listed = await call(["list", "--kind", "task"]);
    expect(listed.code).toBe(ExitCode.OK);
    expect((listed.env.data as Array<{ id: string }>).map((n) => n.id)).toContain(id);

    const shown = await call(["show", id]);
    expect(shown.code).toBe(ExitCode.OK);
    expect(shown.env.data.title).toBe("через клиент");

    const taken = await call(["claim", id, "--lease", "10m"]);
    expect([taken.code, taken.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(taken.env.data.holder).toBe("anna");

    const edited = await call(["update", id, "--title", "поправлено", "--priority", "P0"]);
    expect([edited.code, edited.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(edited.env.data.title).toBe("поправлено");
    expect(edited.env.data.priority).toBe(0);

    // И, главное: ЛОКАЛЬНОЙ базы всё это не коснулось — её попросту нет.
    const straight = await pg!.withTenant("acme", async (tx) =>
      tx.raw<{ n: string }>("SELECT count(*) AS n FROM nodes WHERE id = $1", [id]),
    );
    expect(Number(straight[0]!.n)).toBe(1);
  });

  test("очередь считает сервер — тем же порядком, что и CLI локально", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    // Три задачи разного приоритета: порядок очереди — это и есть ответ на
    // вопрос «что брать следующим», и он обязан быть один.
    const low = (await call(["task", "мелочь", "--priority", "P3"])).env.data.id as string;
    const top = (await call(["task", "горит", "--priority", "P0"])).env.data.id as string;
    const mid = (await call(["task", "обычная", "--priority", "P2"])).env.data.id as string;

    const queue = await call(["ready", "-n", "20"]);
    expect([queue.code, queue.env.error ?? null]).toEqual([ExitCode.OK, null]);
    const ids = (queue.env.data.items as Array<{ id: string; score: number }>).map((i) => i.id);
    expect(ids.indexOf(top)).toBeLessThan(ids.indexOf(mid));
    expect(ids.indexOf(mid)).toBeLessThan(ids.indexOf(low));
    // Число готовых — не длина выдачи (И2).
    expect(queue.env.data.total).toBeGreaterThanOrEqual(ids.length);
    expect(queue.env.meta.remote).toBe(WS);

    // Взятая задача из очереди уходит: её статус больше не open.
    expect((await call(["claim", top])).code).toBe(ExitCode.OK);
    const after = await call(["ready", "-n", "20"]);
    expect((after.env.data.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(top);
  });

  test("контекст собирается из общей памяти: знание, очередь и число узлов", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const primed = await call(["prime"]);
    expect([primed.code, primed.env.error ?? null]).toEqual([ExitCode.OK, null]);
    expect(primed.env.meta.remote).toBe(WS);
    // Числа про общую базу, а не про пустую локальную.
    expect(primed.env.data.nodes).toBeGreaterThan(0);
    expect(Array.isArray(primed.env.data.ready)).toBe(true);
    expect(primed.env.data.total_ready).toBeGreaterThanOrEqual(primed.env.data.ready.length);
    // Секции знания приходят всегда — пустыми, если знания нет: клиент не
    // должен гадать, отсутствует ли поле или отсутствует память.
    expect(Array.isArray(primed.env.data.core)).toBe(true);
    expect(Array.isArray(primed.env.data.decisions)).toBe(true);
  });

  test("очередь сервера отказывает в том, чего не умеет, а не отдаёт половину", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const why = await call(["ready", "--why"]);
    expect(why.code).toBe(ExitCode.PRECOND);
    expect(why.env.error.code).toBe("precond.no_remote");
    expect(why.env.error.hint).toContain("claim");
  });

  test("вторая попытка взять уже взятую задачу — отказ с кодом, а не тишина", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const id = (await call(["task", "кто успел"])).env.data.id as string;
    expect((await call(["claim", id])).code).toBe(ExitCode.OK);
    const again = await call(["claim", id]);
    expect(again.code).toBe(ExitCode.CONFLICT);
    expect(again.env.error.code).toBe("conflict.claimed");
  });

  test("несуществующий узел отвечает notfound, а не пустой карточкой", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const shown = await call(["show", `${WS}-нет-такого`]);
    expect(shown.code).toBe(ExitCode.NOTFOUND);
    expect(shown.env.error.code).toBe("notfound.node");
  });

  test("то, чего сервер пока не умеет, названо отказом, а не сделано наполовину", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const id = (await call(["task", "частичное"])).env.data.id as string;
    const withTag = await call(["update", id, "--tag", "важное"]);
    expect(withTag.code).toBe(ExitCode.PRECOND);
    expect(withTag.env.error.code).toBe("precond.no_remote");
    expect(withTag.env.error.msg).toContain("--tag");
    // И правка не прошла частично: заголовок на месте.
    expect((await call(["show", id])).env.data.title).toBe("частичное");
  });

  test("команда без удалённого режима ОТКАЗЫВАЕТ, а не уходит в локальную базу", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const out = await call(["локальная"]);
    expect(out.code).toBe(ExitCode.PRECOND);
    expect(out.env.error.code).toBe("precond.no_remote");
    // Подсказка перечисляет те команды, что умеют, — из реестра, а не списком.
    expect(out.env.error.hint).toContain("claim");
  });

  test("сервер без токена и негодный адрес отвечают по-разному", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const noToken = await call(["list"], { MYC_TOKEN: "" });
    expect(noToken.code).toBe(ExitCode.PRECOND);
    expect(noToken.env.error.code).toBe("precond.no_token");

    const badUrl = await call(["list"], { MYC_SERVER: "не адрес" });
    expect(badUrl.code).toBe(ExitCode.USAGE);
    expect(badUrl.env.error.code).toBe("usage.server");

    // Испорченный при копировании токен — ошибка ВВОДА, и она видна до сети:
    // иначе человек читает «сервер не ответил» и чинит не то.
    const mangled = await call(["list"], { MYC_TOKEN: "myc_нет-такого" });
    expect(mangled.code).toBe(ExitCode.USAGE);
    expect(mangled.env.error.code).toBe("usage.token");

    // Правильный по форме, но неизвестный токен — это уже отказ СЕРВЕРА.
    const wrongToken = await call(["list"], { MYC_TOKEN: "myc_00000000000000000000000000" });
    expect(wrongToken.code).toBe(ExitCode.DENIED);
    expect(wrongToken.env.error.code).toBe("denied.bad_token");
  });

  test("сервер не отвечает — деградация с адресом, а не «не найдено»", async () => {
    if (skip !== null) return void console.log(`[skip] ${skip}`);
    const out = await call(["list"], { MYC_SERVER: `http://127.0.0.1:1/${WS}` });
    expect(out.code).toBe(ExitCode.DEGRADED);
    expect(out.env.error.code).toBe("degraded.unreachable");
    expect(out.env.error.msg).toContain("127.0.0.1:1");
  });
});
