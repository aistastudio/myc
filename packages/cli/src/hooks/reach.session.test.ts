/**
 * ОХВАТ ЧЕРЕЗ ГРАНИЦУ ПРОЦЕССА (S58) — вторая половина приёмки.
 *
 * Приёмка требует, чтобы сессионное знание «пережило сжатие контекста внутри
 * своей сессии». Сжатие — это ЧУЖОЙ процесс: хост запускает `myc
 * absorb-session` отдельным процессом, потом отдельным процессом зовёт `myc
 * prime`. Однопоточный тест этого не проверяет вовсе: он не пересекает ни
 * границу процесса, ни общий кеш дайджеста в самой базе.
 *
 * Здесь всё запускается настоящими Bun.spawn:
 *
 *   1. хук сжатия пишет эпизод и кандидатов от имени сессии A;
 *   2. `prime` сессии A их видит, `prime` сессии B — нет;
 *   3. кеш дайджеста лежит в myc_meta, то есть ОБЩИЙ для процессов: prime A,
 *      отработавший первым, не имеет права отдать свой дайджест prime B;
 *   4. две параллельные записи в разные сессии не перемешивают охват.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliTestEnv } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";

const MAIN = join(import.meta.dir, "..", "main.ts");
const SESSION_A = "S-alpha";
const SESSION_B = "S-beta";

let dir: string;
let home: string;
let transcript: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-reach-proc-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  transcript = join(dir, "t.jsonl");
  const rows = [
    "Решили: очередь jobs разбирает следующий вызов CLI по бюджету времени.",
    "Решили: порог dup_cos поднят до 0.99 на этой ветке.",
    "Решили: реплики свести к одному сайту до конца задачи.",
  ].map((text) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
  );
  writeFileSync(transcript, `${rows.join("\n")}\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function myc(...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", "run", MAIN, "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // cliTestEnv гасит фоновые механизмы (ловушка S51, сработала дважды).
    env: cliTestEnv({ MYC_ACTOR: "tester", MYC_HOME: home }),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

async function primeData(session?: string): Promise<Record<string, unknown>> {
  const args = ["prime", "--json", "--budget", "4000"];
  if (session !== undefined) args.push("--session", session);
  const r = await myc(...args);
  expect(r.code).toBe(0);
  const env = JSON.parse(r.stdout) as Record<string, unknown>;
  return env["data"] as Record<string, unknown>;
}

function titles(rows: unknown): string[] {
  return (rows as Array<{ title: string }>).map((r) => r.title);
}

test("хук сжатия из чужого процесса пишет память своей сессии, и prime чужой сессии её не видит", async () => {
  const hook = await myc(
    "absorb-session",
    "--transcript",
    transcript,
    "--reason",
    "compact",
    "--agent",
    "claude",
    "--session",
    SESSION_A,
    "--json",
  );
  expect(hook.code).toBe(0);
  const absorbed = (JSON.parse(hook.stdout) as Record<string, unknown>)["data"] as Record<
    string,
    unknown
  >;
  expect(absorbed["session"]).toBe(SESSION_A);
  expect(absorbed["session_derived"]).toBe(false);
  expect(absorbed["candidates"] as number).toBeGreaterThan(0);

  // Охват записан в самих узлах, а не в памяти процесса, которого уже нет.
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  const written = db
    .query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM nodes
        WHERE json_extract(attrs,'$.reach') = 'session'
          AND json_extract(attrs,'$.session_id') = ?1`,
    )
    .get(SESSION_A)!.n;
  db.close();
  expect(written).toBeGreaterThan(0);

  const mine = await primeData(SESSION_A);
  const theirs = await primeData(SESSION_B);
  const decisionsA = titles(mine["decisions"]);
  const decisionsB = titles(theirs["decisions"]);

  expect(decisionsA.length).toBeGreaterThan(0);
  expect(decisionsB).toEqual([]);
  expect(theirs["reach_hidden"] as number).toBeGreaterThan(0);
});

test("общий кеш дайджеста в базе не переносит знание между процессами разных сессий", async () => {
  expect(
    (await myc("remember", "альфа держит миграцию 006", "--layer", "L3", "--session", SESSION_A)).code,
  ).toBe(0);
  expect(
    (await myc("remember", "общее правило: бюджет prime 30 мс", "--layer", "L3", "--reach", "project")).code,
  ).toBe(0);

  // Первый процесс прогревает кеш дайджеста (myc_meta) от имени сессии A.
  const warm = await primeData(SESSION_A);
  expect(titles(warm["core"])).toContain("альфа держит миграцию 006");

  // Второй процесс, другая сессия, ТОТ ЖЕ seq оплога: попадание в чужой
  // кеш обошло бы фильтр охвата целиком и молча.
  const other = await primeData(SESSION_B);
  expect(titles(other["core"])).not.toContain("альфа держит миграцию 006");
  expect(titles(other["core"])).toContain("общее правило: бюджет prime 30 мс");

  // И обратно: прогрев B не отобрал у A его собственное знание.
  const again = await primeData(SESSION_A);
  expect(titles(again["core"])).toContain("альфа держит миграцию 006");
});

test("параллельные записи двух сессий не перемешивают охват", async () => {
  const runs = await Promise.all([
    myc("remember", "параллельный вывод альфы", "--layer", "L3", "--session", SESSION_A),
    myc("remember", "параллельный вывод беты", "--layer", "L3", "--session", SESSION_B),
    myc("remember", "параллельное общее", "--layer", "L3", "--reach", "project"),
  ]);
  for (const r of runs) expect(r.code).toBe(0);

  const a = titles((await primeData(SESSION_A))["core"]);
  const b = titles((await primeData(SESSION_B))["core"]);

  expect(a).toContain("параллельный вывод альфы");
  expect(a).not.toContain("параллельный вывод беты");
  expect(b).toContain("параллельный вывод беты");
  expect(b).not.toContain("параллельный вывод альфы");
  expect(a).toContain("параллельное общее");
  expect(b).toContain("параллельное общее");
});

test("без --session хук говорит вслух, что охват выведен из эпизода", async () => {
  const hook = await myc(
    "absorb-session",
    "--transcript",
    transcript,
    "--reason",
    "compact",
    "--json",
  );
  expect(hook.code).toBe(0);
  const env = JSON.parse(hook.stdout) as Record<string, unknown>;
  const data = env["data"] as Record<string, unknown>;
  expect(data["session_derived"]).toBe(true);
  expect(data["session"]).toBe(`episode:${data["episode"] as string}`);
  // Сказано это пакетом, а не WARN-строкой: читателю знание нужно ВНУТРИ
  // контекста — пакет и есть то, что доезжает до агента.
  expect(data["packet"] as string).toContain("охват выведен из эпизода");

  // И такое знание всё равно доступно тому, кто назовёт этот ключ.
  const derived = await primeData(`episode:${data["episode"] as string}`);
  expect(titles(derived["decisions"]).length).toBeGreaterThan(0);
});
