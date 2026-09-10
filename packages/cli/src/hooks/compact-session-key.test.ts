/**
 * КЛЮЧ СЕССИИ ПЕРЕЖИВАЕТ СЖАТИЕ (memory-t7wggn9czf5t).
 *
 * Веха M1 обещает: «после каждого сжатия prime возвращает решения, принятые до
 * него». Обещание не выполнялось, и ровно по одной причине: когда хост не
 * называл `--session`, хук выводил ключ охвата ИЗ ЭПИЗОДА, а эпизод новый на
 * каждом сжатии. Заметка, записанная до сжатия под ключом A, после сжатия
 * оказывалась в чужом охвате — `prime` показывал пустой CORE и «чужого скрыто 1».
 *
 * Здесь всё проверяется настоящими процессами (Bun.spawn), потому что сжатие и
 * есть граница процессов: хост зовёт `myc absorb-session` одним процессом, а
 * `myc prime` — другим, и ключ обязан совпасть между ними, не внутри одного.
 *
 * ЧТО ИМЕННО ЛОВЯТ ТЕСТЫ. Мутация «вернуть вывод ключа из эпизода» роняет
 * первый и второй тесты: три сжатия дадут три разных ключа, а решение,
 * записанное до первого, исчезнет из prime после него.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliTestEnv, sessionKeyFromTranscript } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";

const MAIN = join(import.meta.dir, "..", "main.ts");
/** Так Claude Code называет стенограмму: `<uuid сессии>.jsonl` (проверено живьём). */
const SESSION_UUID = "a4814339-819f-40fd-964f-9f054a508e43";

let dir: string;
let home: string;
let transcript: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-compact-key-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  // Стенограмма живёт ТАМ ЖЕ и с тем же именем всю сессию: хост при сжатии
  // дописывает её, а не заводит новую. На этом и держится устойчивость ключа.
  const projects = join(dir, "projects");
  mkdirSync(projects, { recursive: true });
  transcript = join(projects, `${SESSION_UUID}.jsonl`);
  writeTurns(1);
});

function writeTurns(round: number): void {
  const rows = [
    `Решили: очередь jobs разбирает следующий вызов CLI по бюджету времени (круг ${round}).`,
    `Решили: порог dup_cos поднят до 0.9${round} на этой ветке.`,
    `Решили: реплики свести к одному сайту до конца задачи (круг ${round}).`,
  ].map((text) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
  );
  writeFileSync(transcript, `${rows.join("\n")}\n`);
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function myc(args: readonly string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", "run", MAIN, "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // cliTestEnv гасит фоновые механизмы (ловушка S51, сработала дважды).
    env: cliTestEnv({ MYC_ACTOR: "tester", MYC_HOME: home, ...extraEnv }),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

/** Одно сжатие ровно так, как его зовёт хук: без `--session`, но со стенограммой. */
async function compact(): Promise<Record<string, unknown>> {
  const r = await myc([
    "absorb-session",
    "--reason", "compact",
    "--transcript", transcript,
    "--agent", "claude",
    "--json",
  ]);
  expect(r.code).toBe(0);
  const env = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(env["ok"]).toBe(true);
  return env["data"] as Record<string, unknown>;
}

async function primeData(session: string): Promise<Record<string, unknown>> {
  const r = await myc(["prime", "--json", "--budget", "4000", "--session", session]);
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as Record<string, unknown>)["data"] as Record<string, unknown>;
}

function titles(rows: unknown): string[] {
  return (rows as Array<{ title: string }>).map((r) => r.title);
}

test("три сжатия подряд одной сессии дают ОДИН ключ", async () => {
  const keys: string[] = [];
  const episodes: string[] = [];
  for (let round = 1; round <= 3; round++) {
    writeTurns(round);
    const data = await compact();
    keys.push(data["session"] as string);
    episodes.push(data["episode"] as string);
    expect(data["session_source"]).toBe("transcript");
  }

  // Эпизоды РАЗНЫЕ — иначе тест доказывал бы устойчивость там, где её нечем
  // ломать, и мутация «вернуть ключ из эпизода» его бы не уронила.
  expect(new Set(episodes).size).toBe(3);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toBe(SESSION_UUID);

  // И тот же ключ лежит в самих узлах, а не только в выдаче процесса.
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  const rows = db
    .query<{ k: string | null; n: number }, []>(
      `SELECT json_extract(attrs,'$.session_id') AS k, count(*) AS n FROM nodes
        WHERE json_extract(attrs,'$.reach') = 'session' GROUP BY k`,
    )
    .all();
  db.close();
  expect(rows.map((r) => r.k)).toEqual([SESSION_UUID]);
  expect(rows[0]!.n).toBeGreaterThan(3); // три эпизода плюс кандидаты
});

test("prime после каждого сжатия возвращает решение, принятое ДО первого", async () => {
  // Решение записано так, как его пишет агент внутри сессии: без флага, по
  // переменной окружения хоста. Три поверхности обязаны сойтись на одном ключе.
  const remembered = await myc(
    ["remember", "prime обязан укладываться в 30 мс", "--layer", "L3", "--json"],
    { CLAUDE_CODE_SESSION_ID: SESSION_UUID },
  );
  expect(remembered.code).toBe(0);

  const before = await primeData(SESSION_UUID);
  expect(titles(before["core"])).toContain("prime обязан укладываться в 30 мс");

  // Охват записан НАСТОЯЩИЙ, а не «неизвестно»: без переменной окружения
  // хоста remember молча писал бы узел без охвата, и он был бы виден всем
  // сессиям сразу — тест бы этого не заметил, если не спросить чужую.
  const stranger = await primeData("S-чужая");
  expect(titles(stranger["core"])).not.toContain("prime обязан укладываться в 30 мс");
  expect(stranger["reach_hidden"] as number).toBeGreaterThan(0);

  for (let round = 1; round <= 3; round++) {
    writeTurns(round);
    await compact();
    const after = await primeData(SESSION_UUID);
    expect(titles(after["core"])).toContain("prime обязан укладываться в 30 мс");
    // Ничего своего не спрятано: чужого охвата в этой базе просто нет.
    expect(after["reach_hidden"] as number).toBe(0);
  }
});

test("кандидаты первого сжатия остаются в СВОЕЙ сессии после третьего", async () => {
  // Ранжирование prime тут ни при чём: окно секции отдаёт свежие решения, и
  // требовать от него старые значило бы проверять сортировку вместо охвата.
  // Ломалось же именно ПРИНАДЛЕЖНОСТЬ: кандидат первого сжатия уезжал под
  // ключ `episode:<id1>`, а prime после третьего спрашивал `episode:<id3>` —
  // и своё же прятал как чужое.
  writeTurns(1);
  const first = await compact();
  expect(first["candidates"] as number).toBeGreaterThan(0);

  const owners = (): { title: string; session: string | null }[] => {
    const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
    const rows = db
      .query<{ title: string; session: string | null }, []>(
        `SELECT title, json_extract(attrs,'$.session_id') AS session FROM nodes
          WHERE json_extract(attrs,'$.extracted_by') = 'precompact' ORDER BY id`,
      )
      .all();
    db.close();
    return rows;
  };
  const firstOwned = owners();
  expect(firstOwned.length).toBeGreaterThan(0);

  for (const round of [2, 3]) {
    writeTurns(round);
    await compact();
  }

  // Каждый кандидат первого сжатия по-прежнему принадлежит ТОЙ ЖЕ сессии.
  const afterAll = new Map(owners().map((r) => [r.title, r.session]));
  for (const row of firstOwned) {
    expect(afterAll.get(row.title)).toBe(SESSION_UUID);
  }

  // Своей сессии не спрятано ничего; чужой — спрятано всё.
  const mine = await primeData(SESSION_UUID);
  expect(mine["reach_hidden"] as number).toBe(0);
  expect(titles(mine["decisions"]).length).toBeGreaterThan(0);

  const theirs = await primeData("S-чужая");
  expect(titles(theirs["decisions"])).toEqual([]);
  expect(theirs["reach_hidden"] as number).toBeGreaterThanOrEqual(firstOwned.length);
});

test("стенограмма Codex (rollout-<дата>-<uuid>) даёт тот же ключ", () => {
  expect(sessionKeyFromTranscript(`/x/rollout-2026-09-07T10-00-00-${SESSION_UUID}.jsonl`)).toBe(
    SESSION_UUID,
  );
});

test("ключ хоста сильнее ключа из стенограммы", async () => {
  const r = await myc([
    "absorb-session",
    "--reason", "compact",
    "--transcript", transcript,
    "--session", "S-от-хоста",
    "--json",
  ]);
  expect(r.code).toBe(0);
  const data = (JSON.parse(r.stdout) as Record<string, unknown>)["data"] as Record<string, unknown>;
  expect(data["session"]).toBe("S-от-хоста");
  expect(data["session_source"]).toBe("host");
});

test("без uuid в имени остаётся вывод из эпизода — и он назван вслух", async () => {
  const anon = join(dir, "transcript.jsonl");
  writeFileSync(anon, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Решили: ключа взять неоткуда." }] } })}\n`);
  const r = await myc(["absorb-session", "--reason", "compact", "--transcript", anon, "--json"]);
  expect(r.code).toBe(0);
  const data = (JSON.parse(r.stdout) as Record<string, unknown>)["data"] as Record<string, unknown>;
  expect(data["session_source"]).toBe("episode");
  expect(data["session"]).toBe(`episode:${data["episode"] as string}`);
  expect(data["packet"] as string).toContain("reach derived from the episode");
});
