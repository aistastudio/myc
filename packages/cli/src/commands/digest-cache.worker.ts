/**
 * Воркер кеша дайджестов — НАСТОЯЩИЙ отдельный процесс над той же базой.
 *
 * Инвариант «устаревший дайджест никогда не отдаётся» живёт МЕЖДУ
 * процессами: кеш лежит в таблице, а версия базы читается из оплога, и
 * проверить это может только процесс, который не делил с писателем ни
 * памяти, ни соединения. Однопоточный тест здесь не доказывает ничего —
 * кеш, инвалидирующийся только своими же записями, прошёл бы его целиком
 * и молча отдавал бы вчерашний контекст в MCP-сервере, пока рядом пишет
 * one-shot CLI. В этом проекте молчаливая потеря записей на гонках
 * находилась только на Bun.spawn (S38, S40).
 *
 * Режимы:
 *   --mode prime   — `myc prime --json`: что видит читатель;
 *   --mode ready   — `myc ready --json`: счётчики подвала (profile='ready');
 *   --mode note    — `myc remember --layer L2`: запись, двигающая оплог;
 *   --mode block   — задача + блокер: запись, двигающая ИМЕННО blocked.
 *
 * `--go <файл>` — барьер: ждать появления файла перед работой (пуск нескольких
 * процессов в одну точку). На stdout — одна JSON-строка отчёта.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createPrimeCommand } from "./prime.ts";
import { createReadyCommand } from "./ready.ts";
import { createRememberCommand } from "./remember.ts";
import { createDepCommand } from "./dep.ts";
import { createTaskCommand } from "./tasks.ts";

type Mode = "prime" | "ready" | "note" | "block";

interface Args {
  readonly dir: string;
  readonly mode: Mode;
  readonly text: string;
  readonly session: string | undefined;
  readonly go: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get("dir");
  const mode = get("mode") as Mode | undefined;
  if (dir === undefined || mode === undefined) throw new Error("нужны --dir и --mode");
  return {
    dir,
    mode,
    text: get("text") ?? "текст",
    session: get("session"),
    go: get("go"),
  };
}

async function waitForBarrier(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  for (let i = 0; i < 1000; i++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`барьер ${path} не появился`);
}

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createPrimeCommand());
  r.register(createReadyCommand());
  r.register(createRememberCommand());
  r.register(createTaskCommand());
  r.register(createDepCommand());
  return r;
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

/**
 * Соединение наблюдателя: мимо всего кода команд, прямо в файл.
 *
 * НЕ `readonly`: база в режиме WAL, и открытие только на чтение падает
 * SQLITE_CANTOPEN, когда -shm ещё не создан (init закрыл базу чекпоинтом).
 * `busy_timeout` — потому что это соединение конкурирует с настоящими
 * процессами, и подглядывание не имеет права падать раньше продукта.
 */
function openRaw(dir: string): Database {
  const db = new Database(join(dir, ".myc", "myc.db"));
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

/**
 * Хвост оплога прямым взглядом в файл базы, мимо всего кода команд.
 * Читается ДО работы: если на старте процесса база уже содержала запись,
 * его ответ ОБЯЗАН её отражать — это и есть «устаревший кеш не отдаётся»,
 * сформулированное без гонки с самим собой.
 */
function oplogSeq(dir: string): number {
  const db = openRaw(dir);
  try {
    return Number(
      (db.query(`SELECT coalesce(max(seq), 0) AS s FROM oplog`).get() as { s: number }).s,
    );
  } finally {
    db.close();
  }
}

/** Строки кеша прямым взглядом в базу: чем профиль ключуется на самом деле. */
function cacheRows(dir: string): Array<{ profile: string; variant: string; seq: number }> {
  const db = openRaw(dir);
  try {
    return db
      .query(`SELECT profile, variant, seq FROM digest_cache ORDER BY profile, variant`)
      .all() as Array<{ profile: string; variant: string; seq: number }>;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = makeRegistry();
  const env = { MYC_ACTOR: process.env["MYC_ACTOR"] ?? "worker" };
  const myc = (...argv: string[]) => run(["-C", args.dir, ...argv], { registry, env });

  await waitForBarrier(args.go);
  const seqBefore = oplogSeq(args.dir);
  const startedAt = Date.now();

  const sessionFlags = args.session === undefined ? [] : ["--session", args.session];

  if (args.mode === "prime") {
    const r = await myc("prime", "--json", ...sessionFlags);
    const parsed = JSON.parse(text(r.stdout)) as {
      ok: boolean;
      data?: {
        cache: string;
        blocked: number;
        decisions: Array<{ id: string }>;
        core: Array<{ id: string }>;
        ready: Array<{ id: string }>;
      };
    };
    process.stdout.write(
      `${JSON.stringify({
        ok: r.code === 0 && parsed.ok,
        code: r.code,
        seq_before: seqBefore,
        seq_after: oplogSeq(args.dir),
        took_ms: Date.now() - startedAt,
        cache: parsed.data?.cache ?? "",
        blocked: parsed.data?.blocked ?? -1,
        decisions: (parsed.data?.decisions ?? []).map((d) => d.id),
        core: (parsed.data?.core ?? []).map((d) => d.id),
        ready: (parsed.data?.ready ?? []).map((d) => d.id),
        rows: cacheRows(args.dir),
      })}\n`,
    );
    return;
  }

  if (args.mode === "ready") {
    const r = await myc("ready", "--json");
    const parsed = JSON.parse(text(r.stdout)) as {
      ok: boolean;
      data?: { blocked: number; in_progress: number; ready: number };
    };
    process.stdout.write(
      `${JSON.stringify({
        ok: r.code === 0 && parsed.ok,
        code: r.code,
        seq_before: seqBefore,
        seq_after: oplogSeq(args.dir),
        blocked: parsed.data?.blocked ?? -1,
        in_progress: parsed.data?.in_progress ?? -1,
        ready_count: parsed.data?.ready ?? -1,
        rows: cacheRows(args.dir),
      })}\n`,
    );
    return;
  }

  if (args.mode === "note") {
    const r = await myc("remember", "--layer", "L2", "--reach", "project", args.text);
    const id = text(r.stdout).trim().split(/\s+/)[0] ?? "";
    process.stdout.write(
      `${JSON.stringify({
        ok: r.code === 0,
        code: r.code,
        id,
        seq_before: seqBefore,
        seq_after: oplogSeq(args.dir),
        stderr: r.stderr ?? "",
      })}\n`,
    );
    return;
  }

  // block: задача + блокер. Двигает именно `blocked` в подвале — число,
  // которое кешируется профилем 'ready' и потому обязано протухнуть.
  const a = await myc("task", `${args.text} (цель)`);
  const b = await myc("task", `${args.text} (блокер)`);
  const idA = text(a.stdout).trim().split(/\s+/)[0] ?? "";
  const idB = text(b.stdout).trim().split(/\s+/)[0] ?? "";
  const dep = await myc("dep", "add", idA, "blocked-by", idB);
  process.stdout.write(
    `${JSON.stringify({
      ok: a.code === 0 && b.code === 0 && dep.code === 0,
      code: dep.code,
      id: idA,
      blocker: idB,
      seq_before: seqBefore,
      seq_after: oplogSeq(args.dir),
      stderr: dep.stderr ?? "",
    })}\n`,
  );
}

await main();
