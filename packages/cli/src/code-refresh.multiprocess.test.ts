/**
 * Фоновое обновление код-индекса по возрасту (memory-es8qwd555cjt) — на
 * НАСТОЯЩИХ процессах: `myc prime` хука старта сессии, несколько агентов в
 * одном воркспейсе, живой отсоединённый воркер.
 *
 * Однопроцессная половина (порог, условие §4.3, смерть воркера) — в
 * drain.code-index.test.ts. Здесь то, чего однопоточный тест не видит:
 * дедупликация и захват между независимыми процессами, воркер, который
 * переживает позвавшую его команду, и цена всего этого для prime (И1).
 *
 * Процессы — `bun main.ts`, как в бою, с включённым дренажом: `NODE_ENV` в
 * их окружение не попадает (cliTestEnv — белый список), фон включается явно.
 * Воркер в гоночных тестах — заглушка MYC_DRAIN_FAKE=1: постановка и захват
 * боевые, вместо процесса — строка в журнале, работа остаётся под арендой.
 *
 * МУТАЦИИ (проверены при сдаче, числа — в отчёте задачи):
 *   убрать дедупликацию (`entityId` в jobs.enqueue) — «два агента подряд»
 *   видит две строки; убрать порог — «свежий индекс» видит строку на старте;
 *   ждать воркер в prime — «prime не ждёт» краснеет на разнице медиан.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cliTestEnv } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";
import { CODE_INDEXED_AT_KEY, CODE_REFRESH_JOB_KIND } from "@myc/code-intel/refresh";
import { run } from "./index.ts";
import { Registry } from "./registry.ts";
import { createCodeCommand } from "./commands/code.ts";

const CLI_ENTRY = join(import.meta.dir, "main.ts");
const HOUR = 3_600_000;

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Ws {
  readonly root: string;
  readonly ws: string;
  readonly home: string;
  readonly dbPath: string;
  readonly log: string;
}

async function makeWs(): Promise<Ws> {
  const root = mkdtempSync(join(tmpdir(), "myc-code-refresh-"));
  dirs.push(root);
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(join(ws, ".myc"), { recursive: true });
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(ws, "src", "a.ts"), "export function alpha(): number {\n  return 1;\n}\n");
  const dbPath = join(ws, ".myc", "myc.db");
  const raw = new Database(dbPath, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  return { root, ws, home, dbPath, log: join(root, "spawn.log") };
}

/** Индекс построен настоящей командой (в этом процессе: NODE_ENV=test, фона нет). */
async function buildIndex(w: Ws): Promise<void> {
  const registry = new Registry();
  registry.register(createCodeCommand());
  const r = await run(["-C", w.ws, "code", "index"], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: w.home } });
  expect(r.code).toBe(0);
}

function sql<T>(dbPath: string, text: string, ...params: Array<string | number>): T {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.query(text).get(...params) as T;
  } finally {
    db.close();
  }
}

function setStamp(w: Ws, at: number): void {
  sql(w.dbPath, "INSERT INTO myc_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", CODE_INDEXED_AT_KEY, String(at));
}

const stampOf = (w: Ws): number =>
  Number(sql<{ value: string } | null>(w.dbPath, "SELECT value FROM myc_meta WHERE key = ?1", CODE_INDEXED_AT_KEY)?.value ?? 0);

const refreshRows = (w: Ws): number =>
  sql<{ n: number }>(w.dbPath, "SELECT count(*) AS n FROM jobs WHERE kind = ?1", CODE_REFRESH_JOB_KIND).n;

/** Строка журнала заглушки: какой воркер был бы поднят (drain.ts, fakeCodeIndexSpawnFromEnv). */
interface SpawnLine {
  readonly kind: string;
  readonly id: number;
  readonly holder: string;
  readonly db: string;
  readonly pid: number;
}

function spawnLines(w: Ws): SpawnLine[] {
  if (!existsSync(w.log)) return [];
  return readFileSync(w.log, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SpawnLine)
    .filter((l) => l.kind === CODE_REFRESH_JOB_KIND);
}

/**
 * Окружение хука старта сессии: дренаж и фон код-индекса ВКЛЮЧЕНЫ, всё
 * остальное фоновое погашено, HOME — свой (ни личного яруса, ни queue.db
 * настоящего пользователя).
 */
function hookEnv(w: Ws, extra: Record<string, string> = {}): Record<string, string> {
  return cliTestEnv({
    HOME: w.home,
    MYC_HOME: w.home,
    MYC_ACTOR: "agent",
    MYC_DRAIN: "1",
    MYC_CODE_INDEX: "1",
    MYC_HOOK: "session-start",
    MYC_HOOK_AGENT: "claude",
    ...extra,
  });
}

const fakeSpawn = (w: Ws): Record<string, string> => ({ MYC_DRAIN_FAKE: "1", MYC_DRAIN_FAKE_LOG: w.log });

interface Out {
  readonly code: number;
  readonly stdout: string;
  readonly ms: number;
}

async function prime(w: Ws, env: Record<string, string>, session = "s1"): Promise<Out> {
  const t0 = performance.now();
  const proc = Bun.spawn(
    [process.execPath, CLI_ENTRY, "-C", w.ws, "prime", "--budget", "2000", "--format", "agent", "--session", session],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", env },
  );
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout, ms: performance.now() - t0 };
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(50);
  }
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe("старт сессии ставит обновление устаревшего индекса", () => {
  test("индекс старше порога: после двух стартов подряд — одна работа и один воркер", async () => {
    const w = await makeWs();
    await buildIndex(w);
    setStamp(w, Date.now() - 9 * HOUR);

    const a = await prime(w, hookEnv(w, fakeSpawn(w)), "agent-1");
    const b = await prime(w, hookEnv(w, fakeSpawn(w)), "agent-2");

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout.length).toBeGreaterThan(0);
    expect(refreshRows(w)).toBe(1);
    expect(spawnLines(w).length).toBe(1);
  }, 60_000);

  test("четыре агента разом: одна работа, один воркер — захват атомарен между процессами", async () => {
    const w = await makeWs();
    await buildIndex(w);
    setStamp(w, Date.now() - 9 * HOUR);

    const outs = await Promise.all([1, 2, 3, 4].map((i) => prime(w, hookEnv(w, fakeSpawn(w)), `agent-${i}`)));

    for (const o of outs) expect(o.code).toBe(0);
    expect(refreshRows(w)).toBe(1);
    const lines = spawnLines(w);
    expect(lines.length).toBe(1);
  }, 60_000);

  test("старт сессии в git worktree и во вложенном каталоге: работа — в базе основного дерева", async () => {
    // Агенты cherry почти все стоят в worktree orca или во вложенных
    // репозиториях. Дренаж искал `<cwd>/.myc/myc.db` и там не случался вовсе:
    // фон не поднимался ни у одного из них.
    const w = await makeWs();
    await buildIndex(w);
    setStamp(w, Date.now() - 9 * HOUR);
    const git = (cwd: string, ...args: string[]): void => {
      const r = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    };
    git(w.ws, "init", "-q", "-b", "main");
    git(w.ws, "add", "src");
    git(w.ws, "commit", "-q", "-m", "init");
    const wt = join(w.root, "wt-feature");
    git(w.ws, "worktree", "add", "-q", "-b", "feature", wt);

    const t0 = performance.now();
    const proc = Bun.spawn(
      [process.execPath, CLI_ENTRY, "-C", wt, "prime", "--budget", "2000", "--format", "agent", "--session", "wt"],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: hookEnv(w, fakeSpawn(w)) },
    );
    expect(await proc.exited).toBe(0);
    expect(performance.now() - t0).toBeLessThan(30_000);

    expect(refreshRows(w)).toBe(1);
    const lines = spawnLines(w);
    expect(lines.length).toBe(1);
    // Воркер поднят на базу основного дерева — а значит, и индекс корня.
    expect(realpathSync(lines[0]!.db)).toBe(realpathSync(w.dbPath));

    // Вложенный каталог (без своей базы) — тот же подъём, та же работа.
    mkdirSync(join(w.ws, "src", "deep"), { recursive: true });
    const nested = await Bun.spawn(
      [process.execPath, CLI_ENTRY, "-C", join(w.ws, "src", "deep"), "prime", "--format", "agent", "--session", "n"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: hookEnv(w, fakeSpawn(w)) },
    ).exited;
    expect(nested).toBe(0);
    expect(refreshRows(w)).toBe(1);
  }, 60_000);

  test("свежий индекс: работа не ставится", async () => {
    const w = await makeWs();
    await buildIndex(w);
    expect(Date.now() - stampOf(w)).toBeLessThan(60_000);

    const r = await prime(w, hookEnv(w, fakeSpawn(w)));

    expect(r.code).toBe(0);
    expect(refreshRows(w)).toBe(0);
    expect(spawnLines(w)).toEqual([]);
  }, 60_000);
});

describe("воркер исполняет работу", () => {
  test("новый символ в изменённом файле находится после фонового обновления, работа снята", async () => {
    const w = await makeWs();
    await buildIndex(w);
    writeFileSync(
      join(w.ws, "src", "a.ts"),
      "export function alpha(): number {\n  return 1;\n}\n\nexport function betaAfterRefresh(): number {\n  return 2;\n}\n",
    );
    const old = Date.now() - 9 * HOUR;
    setStamp(w, old);

    const registry = new Registry();
    registry.register(createCodeCommand());
    const before = await run(["-C", w.ws, "code", "symbol", "betaAfterRefresh", "--json"], {
      registry,
      env: { MYC_ACTOR: "tester", MYC_HOME: w.home },
    });
    // До обновления символа нет, и ответ говорит, что индекс устарел (И2).
    expect(String(before.stdout)).not.toContain("src/a.ts:5");
    expect(String(before.stdout)).toContain("code_index.stale");

    // Настоящий спавн: prime выходит, воркер живёт дальше сам.
    const r = await prime(w, hookEnv(w));
    expect(r.code).toBe(0);
    await waitFor(() => stampOf(w) > old && refreshRows(w) === 0, 45_000, "the background worker to finish");

    const after = await run(["-C", w.ws, "code", "symbol", "betaAfterRefresh", "--json"], {
      registry,
      env: { MYC_ACTOR: "tester", MYC_HOME: w.home },
    });
    expect(after.code).toBe(0);
    const env = JSON.parse(String(after.stdout)) as { ok: boolean; warn?: Array<{ code: string }>; data: { defs: Array<{ path: string; span: [number, number] | number[] }> } };
    expect(JSON.stringify(env.data)).toContain("src/a.ts");
    // Свежий индекс — ни слова о возрасте.
    expect((env.warn ?? []).map((x) => x.code)).not.toContain("code_index.stale");
  }, 90_000);
});

describe("prime не ждёт индекс (И1)", () => {
  test("prime с постановкой и без — в пределах шума", async () => {
    // Два воркспейса: в A индекс каждый раунд состарен (дренаж prime ставит
    // работу, захватывает и поднимает НАСТОЯЩИЙ воркер), в B свежий (дренаж
    // prime не делает ничего). Раунды чередуются, порядок внутри раунда —
    // тоже: медленная минута машины достаётся обоим поровну.
    const a = await makeWs();
    const b = await makeWs();
    await buildIndex(a);
    await buildIndex(b);
    const withQueue: number[] = [];
    const without: number[] = [];
    const ROUNDS = 7;
    for (let i = 0; i < ROUNDS; i++) {
      await waitFor(() => refreshRows(a) === 0, 45_000, "the previous worker to finish");
      setStamp(a, Date.now() - 9 * HOUR);
      const order = i % 2 === 0 ? (["a", "b"] as const) : (["b", "a"] as const);
      for (const which of order) {
        const out = await prime(which === "a" ? a : b, hookEnv(which === "a" ? a : b), `r${i}`);
        expect(out.code).toBe(0);
        (which === "a" ? withQueue : without).push(out.ms);
      }
      // Постановка действительно была: работа стоит или уже снята воркером.
      await waitFor(() => stampOf(a) > Date.now() - HOUR, 45_000, "the worker of this round to stamp the index");
    }
    const mA = median(withQueue);
    const mB = median(without);
    console.log(
      `[bench] prime (subprocess, median of ${ROUNDS}): with enqueue+claim+spawn ${mA.toFixed(1)}ms, ` +
        `without ${mB.toFixed(1)}ms, diff ${(mA - mB).toFixed(1)}ms`,
    );
    // Ждать воркер значило бы платить его прогоном (скан, разбор, корпус и
    // его собственный дренаж — сотни миллисекунд из исходников). Постановка
    // и спавн — единицы. Порог — 25 мс: выше шума старта процесса, ниже
    // любого ожидания воркера.
    expect(mA - mB).toBeLessThan(25);
  }, 240_000);
});
