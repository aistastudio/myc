/**
 * `myc run` между НАСТОЯЩИМИ процессами (правило manual:multiprocess).
 *
 * Слот, порядок, аренда и сигналы живут между процессами — однопоточный тест
 * их не видит (так дважды пропускалась молчаливая потеря записей, S38/S40).
 * Поэтому каждый сценарий здесь — отдельные `bun main.ts run …`, поставленные
 * в известном порядке, и журнал, который пишут сами команды через
 * appendFileSync (write(2) без буфера — то, что попало в файл, пережило бы
 * SIGKILL): `<ms> <событие> <имя> <pid>`.
 *
 *   (a) три команды «sleep 0.5 + запись времени»: строго по одной и в порядке
 *       постановки — хотя последний опрашивает очередь в 60 раз чаще второго;
 *   (b) SIGKILL держателя посреди работы: следующий получает слот за время ≤
 *       срока аренды; (b′) держатель ОСТАНОВЛЕН (SIGSTOP, pid жив) — слот
 *       уходит только по истечении аренды, а проснувшийся держатель узнаёт
 *       о потере;
 *   (c) код выхода и сигналы пробрасываются: exit 3 → 3, SIGINT/SIGTERM
 *       доходят до команды;
 *   (d) --max-wait истекает: код 9 и текст «кто впереди»;
 *   (e) два MYC_HOME — две разные очереди.
 *
 * Мутации, на которых этот файл обязан краснеть (проверены на приёмке):
 *   «без FIFO» — BLOCKERS в run-queue.ts считает только выполняющихся:
 *       (a) — третий обгоняет второго;
 *   «слот не освобождается при SIGKILL» — reap() ничего не снимает:
 *       (b) — следующий упирается в --max-wait, код 9;
 *   «код выхода не пробрасывается» — outcomeResult отдаёт 1 на любой отказ:
 *       (c) — 1 вместо 3/42/130/143.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { cliTestEnv } from "@myc/core";
import { listAll, openQueue, openQueueIfExists, queueDbPath, type TicketRow } from "../run-queue.ts";

const BUN = process.execPath;
const MAIN = join(import.meta.dir, "..", "main.ts");

let root: string;
let child: string;
let seq = 0;
const spawned: Subprocess[] = [];
const orphans = new Set<number>();

// Команда под очередью: пишет start, ждёт (в режиме gate — ещё и файла-ворот),
// пишет end. В режиме trap ловит SIGINT/SIGTERM, пишет их и выходит с 42/43.
const CHILD = `
import { appendFileSync, existsSync } from "node:fs";
const [log, name, ms, mode, gate] = process.argv.slice(2);
const line = (ev) => appendFileSync(log, Date.now() + " " + ev + " " + name + " " + process.pid + "\\n");
if (mode === "trap") {
  process.on("SIGINT", () => { line("SIGINT"); process.exit(42); });
  process.on("SIGTERM", () => { line("SIGTERM"); process.exit(43); });
}
line("start");
if (mode === "gate") while (!existsSync(gate)) await Bun.sleep(5);
await Bun.sleep(Number(ms));
line("end");
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "myc-run-mp-"));
  child = join(root, "child.ts");
  writeFileSync(child, CHILD);
});

afterEach(() => {
  for (const p of spawned.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) {
      try {
        process.kill(p.pid, "SIGCONT");
        process.kill(p.pid, "SIGKILL");
      } catch {
        // уже вышел
      }
    }
  }
  for (const pid of orphans) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // уже вышел
    }
  }
  orphans.clear();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshHome(): string {
  const home = join(root, `home-${++seq}`);
  mkdirSync(home, { recursive: true });
  return home;
}

interface RunOpts {
  readonly home: string;
  readonly flags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** `myc run [flags] -- <cmd…>` отдельным процессом. */
function spawnRun(o: RunOpts, cmd: readonly string[]): Subprocess<"ignore", "pipe", "pipe"> {
  const proc = Bun.spawn([BUN, MAIN, "run", ...(o.flags ?? []), "--", ...cmd], {
    cwd: root,
    env: cliTestEnv({ MYC_HOME: o.home, MYC_ACTOR: "tester", MYC_RUN_PROGRESS_MS: "300", ...o.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.push(proc);
  return proc;
}

/** Команда-ребёнок: `bun child.ts <log> <name> <ms> [mode] [gate]`. */
function kid(log: string, name: string, ms: number, mode = "plain", gate = ""): string[] {
  return [BUN, child, log, name, String(ms), mode, gate];
}

interface Event {
  readonly t: number;
  readonly ev: string;
  readonly name: string;
  readonly pid: number;
}

function events(log: string): Event[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [t, ev, name, pid] = l.split(" ");
      return { t: Number(t), ev: ev!, name: name!, pid: Number(pid) };
    });
}

function at(log: string, ev: string, name: string): Event | undefined {
  return events(log).find((e) => e.ev === ev && e.name === name);
}

function tickets(home: string): TicketRow[] {
  const db = openQueueIfExists(queueDbPath(home));
  if (db === undefined) return [];
  try {
    return listAll(db);
  } finally {
    db.close();
  }
}

async function until(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(10);
  }
}

async function finished(p: Subprocess<"ignore", "pipe", "pipe">): Promise<{ code: number; stderr: string }> {
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, stderr };
}

const waitingIn = (home: string, pid: number): boolean =>
  tickets(home).some((t) => t.pid === pid && t.state === "waiting");

describe("(a) FIFO и строго по одной", () => {
  test(
    "три команды «sleep 0.5 + запись времени» выполняются по одной в порядке постановки",
    async () => {
      const home = freshHome();
      const log = join(root, "a.log");
      const gate = join(root, "a.gate");

      // Первый занимает слот и держит его до ворот: оба следующих гарантированно
      // встают в очередь, пока он работает.
      const one = spawnRun({ home }, kid(log, "one", 500, "gate", gate));
      await until("one started", () => at(log, "start", "one") !== undefined);
      // Второй опрашивает очередь редко (300 мс), третий — часто (5 мс). Без
      // FIFO освободившийся слот доставался бы тому, кто спросил первым, —
      // то есть третьему.
      const two = spawnRun({ home, env: { MYC_RUN_POLL_MS: "300" } }, kid(log, "two", 500));
      await until("two queued", () => waitingIn(home, two.pid));
      const three = spawnRun({ home, env: { MYC_RUN_POLL_MS: "5" } }, kid(log, "three", 500));
      await until("three queued", () => waitingIn(home, three.pid));

      const ids = tickets(home).map((t) => t.pid);
      expect(ids).toEqual([one.pid, two.pid, three.pid]); // порядок постановки = порядок id

      writeFileSync(gate, "");
      const results = await Promise.all([finished(one), finished(two), finished(three)]);
      expect(results.map((r) => r.code)).toEqual([0, 0, 0]);

      const starts = events(log).filter((e) => e.ev === "start").map((e) => e.name);
      expect(starts).toEqual(["one", "two", "three"]);
      // Строго по одной: следующий стартует не раньше, чем предыдущий закончил.
      const [s2, s3] = [at(log, "start", "two")!, at(log, "start", "three")!];
      const [e1, e2] = [at(log, "end", "one")!, at(log, "end", "two")!];
      expect(s2.t).toBeGreaterThanOrEqual(e1.t);
      expect(s3.t).toBeGreaterThanOrEqual(e2.t);
      // «sleep 0.5» действительно шёл полностью у каждого.
      expect(at(log, "end", "three")!.t - s3.t).toBeGreaterThanOrEqual(490);
      expect(tickets(home)).toEqual([]);
    },
    60_000,
  );
});

describe("(b) падение держателя не вешает очередь", () => {
  test(
    "SIGKILL держателя посреди работы: следующий получает слот за время ≤ срока аренды",
    async () => {
      const home = freshHome();
      const log = join(root, "b.log");
      const LEASE = 4_000;
      const env = { MYC_RUN_LEASE_MS: String(LEASE), MYC_RUN_POLL_MS: "50" };

      const holder = spawnRun({ home, env }, kid(log, "holder", 30_000));
      await until("holder started", () => at(log, "start", "holder") !== undefined);
      orphans.add(at(log, "start", "holder")!.pid); // команда переживёт убитый myc
      const next = spawnRun({ home, env, flags: ["--max-wait", "10s"] }, kid(log, "next", 0));
      await until("next queued", () => waitingIn(home, next.pid));

      const killedAt = Date.now();
      holder.kill("SIGKILL");
      await holder.exited;
      expect(holder.signalCode).toBe("SIGKILL");

      const r = await finished(next);
      expect(r.code).toBe(0);
      const startedAt = at(log, "start", "next")!.t;
      expect(startedAt - killedAt).toBeLessThanOrEqual(LEASE);
      expect(tickets(home)).toEqual([]);
      // SIGKILL убил myc, но не его команду: следующий слышит, что нагрузка осталась.
      expect(r.stderr).toContain(`(pid ${at(log, "start", "holder")!.pid}) is still running outside the queue`);
    },
    60_000,
  );

  test(
    "(b′) держатель остановлен (pid жив): слот уходит только по истечении аренды, держатель узнаёт о потере",
    async () => {
      const home = freshHome();
      const log = join(root, "b2.log");
      const LEASE = 1_500; // продление каждые 250 мс, окно наблюдения 500 мс
      const env = { MYC_RUN_LEASE_MS: String(LEASE), MYC_RUN_POLL_MS: "50" };

      const holder = spawnRun({ home, env }, kid(log, "holder", 30_000));
      await until("holder started", () => at(log, "start", "holder") !== undefined);
      orphans.add(at(log, "start", "holder")!.pid);
      const next = spawnRun({ home, env, flags: ["--max-wait", "20s"] }, kid(log, "next", 0));
      await until("next queued", () => waitingIn(home, next.pid));

      // process.kill, а не holder.kill: Subprocess.kill("SIGSTOP") в Bun 1.3
      // процесс НЕ останавливает (проверено ps: состояние S, а не T).
      const stoppedAt = Date.now();
      process.kill(holder.pid, "SIGSTOP");
      const r = await finished(next);
      expect(r.code).toBe(0);
      const waitedMs = at(log, "start", "next")!.t - stoppedAt;
      // Не раньше истечения аренды (последнее продление ≤ 250 мс до остановки)…
      expect(waitedMs).toBeGreaterThanOrEqual(LEASE - 300);
      // …и не позже аренды + окна наблюдения + запаса на запуск под нагрузкой.
      expect(waitedMs).toBeLessThan(LEASE + 500 + 5_000);

      // Проснувшийся держатель узнаёт, что слот ушёл, и говорит об этом.
      process.kill(holder.pid, "SIGCONT");
      await Bun.sleep(600);
      holder.kill("SIGTERM"); // пересылается команде: та умирает от SIGTERM
      const h = await finished(holder);
      expect(h.stderr).toContain("the slot lease was lost");
      expect(h.code).toBe(143);
    },
    60_000,
  );
});

describe("(c) код выхода и сигналы пробрасываются", () => {
  test(
    "exit 3 → 3; exit 0 → 0; команды нет → 127",
    async () => {
      const home = freshHome();
      const three = await finished(spawnRun({ home }, ["sh", "-c", "exit 3"]));
      expect(three.code).toBe(3);
      expect(three.stderr).toContain("exited with code 3");
      expect((await finished(spawnRun({ home }, ["true"]))).code).toBe(0);
      expect((await finished(spawnRun({ home }, ["myc-no-such-command-zz"]))).code).toBe(127);
      expect(tickets(home)).toEqual([]);
    },
    60_000,
  );

  test(
    "SIGINT и SIGTERM myc доходят до команды; код — её код; слот освобождён",
    async () => {
      const home = freshHome();
      const log = join(root, "c.log");

      // Команда ловит сигнал сама и выходит своим кодом.
      const trapped = spawnRun({ home }, kid(log, "trap", 30_000, "trap"));
      await until("trap started", () => at(log, "start", "trap") !== undefined);
      trapped.kill("SIGINT");
      expect((await finished(trapped)).code).toBe(42);
      expect(at(log, "SIGINT", "trap")).toBeDefined();

      const termed = spawnRun({ home }, kid(log, "term", 30_000, "trap"));
      await until("term started", () => at(log, "start", "term") !== undefined);
      termed.kill("SIGTERM");
      expect((await finished(termed)).code).toBe(43);
      expect(at(log, "SIGTERM", "term")).toBeDefined();

      // Команда без обработчика умирает от пересланного сигнала: 128 + номер.
      const plain = spawnRun({ home }, kid(log, "plain", 30_000));
      await until("plain started", () => at(log, "start", "plain") !== undefined);
      plain.kill("SIGINT");
      const p = await finished(plain);
      expect(p.code).toBe(130);
      expect(p.stderr).toContain("killed by SIGINT");
      expect(at(log, "end", "plain")).toBeUndefined();

      expect(tickets(home)).toEqual([]);
    },
    60_000,
  );

  test(
    "сигнал во время ожидания отменяет постановку: команда не стартует, билет снят",
    async () => {
      const home = freshHome();
      const log = join(root, "c2.log");
      const holder = spawnRun({ home }, kid(log, "holder", 30_000));
      await until("holder started", () => at(log, "start", "holder") !== undefined);
      const waiter = spawnRun({ home }, kid(log, "never", 0));
      await until("waiter queued", () => waitingIn(home, waiter.pid));
      waiter.kill("SIGTERM");
      const w = await finished(waiter);
      expect(w.code).toBe(143);
      expect(w.stderr).toContain("while waiting");
      expect(at(log, "start", "never")).toBeUndefined();
      expect(tickets(home).map((t) => t.pid)).toEqual([holder.pid]);
      holder.kill("SIGTERM");
      expect((await finished(holder)).code).toBe(143);
    },
    60_000,
  );
});

describe("(d) --max-wait", () => {
  test(
    "истекает: код 9, текст «слот не получен за N, впереди K: …», билет снят",
    async () => {
      const home = freshHome();
      const log = join(root, "d.log");
      const holder = spawnRun({ home, env: { MYC_SESSION_ID: "sess-d-1234567" } }, kid(log, "holder", 30_000));
      await until("holder started", () => at(log, "start", "holder") !== undefined);

      const t0 = Date.now();
      const late = await finished(spawnRun({ home, flags: ["--max-wait", "1s"] }, kid(log, "late", 0)));
      const took = Date.now() - t0;
      expect(late.code).toBe(9);
      expect(late.stderr).toContain("no 'heavy' slot within 1s; 1 ahead");
      expect(late.stderr).toContain("#1 'bun …/child.ts …/d.log holder"); // кто держит: команда…
      expect(late.stderr).toContain("session sess-d-1"); // …чья сессия…
      expect(late.stderr).toContain(`pid ${holder.pid}, running`); // …и сколько идёт
      expect(late.stderr).toContain("waiting for a 'heavy' slot"); // строка ожидания была
      expect(took).toBeGreaterThanOrEqual(1_000);
      expect(at(log, "start", "late")).toBeUndefined();
      expect(tickets(home).map((t) => t.pid)).toEqual([holder.pid]);

      // --max-wait 0 — не ждать вовсе.
      const now = await finished(spawnRun({ home, flags: ["--max-wait", "0"] }, ["true"]));
      expect(now.code).toBe(9);

      holder.kill("SIGTERM");
      expect((await finished(holder)).code).toBe(143);
    },
    60_000,
  );
});

describe("(e) изоляция: MYC_HOME — своя очередь", () => {
  test(
    "занятая очередь одного MYC_HOME не держит команду другого",
    async () => {
      const homeA = freshHome();
      const homeB = freshHome();
      const log = join(root, "e.log");
      const holder = spawnRun({ home: homeA }, kid(log, "a", 30_000));
      await until("a started", () => at(log, "start", "a") !== undefined);

      const busyA = await finished(spawnRun({ home: homeA, flags: ["--max-wait", "0"] }, ["true"]));
      expect(busyA.code).toBe(9);
      const freeB = await finished(spawnRun({ home: homeB, flags: ["--max-wait", "0"] }, kid(log, "b", 0)));
      expect(freeB.code).toBe(0);
      expect(at(log, "end", "b")).toBeDefined();

      expect(tickets(homeA).map((t) => t.pid)).toEqual([holder.pid]);
      expect(tickets(homeB)).toEqual([]);
      holder.kill("SIGTERM");
      await finished(holder);
    },
    60_000,
  );
});

describe("первое создание queue.db", () => {
  // Без повтора открытия на SQLITE_BUSY (openQueue) каждый процесс здесь падал
  // с «database is locked» примерно в 10% случаев (15 из 150); четыре круга по
  // пять ловят это с вероятностью ~88% за прогон.
  test(
    "пять процессов одновременно на пустом MYC_HOME (4 круга): схема создаётся один раз, все отработали по одной",
    async () => {
      for (let round = 1; round <= 4; round++) {
        const home = freshHome();
        const log = join(root, `m${round}.log`);
        const names = [1, 2, 3, 4, 5].map((i) => `m${i}`);
        const procs = names.map((n) =>
          spawnRun({ home, flags: ["--max-wait", "30s"], env: { MYC_RUN_POLL_MS: "20" } }, kid(log, n, 100)),
        );
        const results = await Promise.all(procs.map((p) => finished(p)));
        expect(results.filter((r) => r.code !== 0).map((r) => r.stderr)).toEqual([]);
        const db = openQueue(queueDbPath(home));
        try {
          expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
        } finally {
          db.close();
        }
        // По одной: интервалы [start, end] не пересекаются.
        const spans = names
          .map((n) => [at(log, "start", n)!.t, at(log, "end", n)!.t] as const)
          .sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
      }
    },
    90_000,
  );
});

describe("myc queue и вложенный run", () => {
  test(
    "queue показывает выполняющегося и ждущего; мёртвую запись показывает снятой и вычищает",
    async () => {
      const home = freshHome();
      const log = join(root, "q.log");
      const holder = spawnRun(
        { home, env: { MYC_SESSION_ID: "sess-q-abcdef", ORCA_TERMINAL_HANDLE: "term_q123" } },
        kid(log, "holder", 30_000),
      );
      await until("holder started", () => at(log, "start", "holder") !== undefined);
      const waiter = spawnRun({ home }, kid(log, "waiter", 0));
      await until("waiter queued", () => waitingIn(home, waiter.pid));

      // Мёртвая запись: процесс, которого уже нет.
      const gone = Bun.spawn(["true"]);
      await gone.exited;
      const db = openQueue(queueDbPath(home));
      db.query(
        `INSERT INTO run_queue (lane, holder, pid, host, state, enqueued_at, lease_ms, lease_expires,
                                renewed_at, argv, cwd)
         VALUES ('heavy', 'dead-holder', ?1, ?2, 'waiting', 1, 30000, ?3, 1, '["dead","cmd"]', '/x')`,
      ).run(gone.pid, (await import("node:os")).hostname(), Date.now() + 60_000);
      db.close();

      const q = Bun.spawnSync([BUN, MAIN, "queue", "--json"], {
        cwd: root,
        env: cliTestEnv({ MYC_HOME: home }),
      });
      expect(q.exitCode).toBe(0);
      const env = JSON.parse(q.stdout.toString()) as {
        data: {
          lanes: Array<{ lane: string; running: number; waiting: number; entries: Array<Record<string, unknown>> }>;
          removed: Array<Record<string, unknown>>;
        };
      };
      const lane = env.data.lanes[0]!;
      expect(lane.lane).toBe("heavy");
      expect([lane.running, lane.waiting]).toEqual([1, 1]);
      const [run, wait] = lane.entries;
      expect(run).toMatchObject({
        state: "running",
        liveness: "alive",
        pid: holder.pid,
        child_pid: at(log, "start", "holder")!.pid,
        session: "sess-q-abcdef",
        terminal: "term_q123",
      });
      expect(wait).toMatchObject({ state: "waiting", liveness: "alive", pid: waiter.pid, position: 1 });
      expect(typeof run!.running_ms).toBe("number");
      expect(env.data.removed.map((e) => [e.pid, e.liveness, e.orphan])).toEqual([[gone.pid, "dead", false]]);
      expect(tickets(home).some((t) => t.pid === gone.pid)).toBe(false);

      const human = Bun.spawnSync([BUN, MAIN, "queue"], { cwd: root, env: cliTestEnv({ MYC_HOME: home }) });
      const text = human.stdout.toString();
      expect(text).toContain("heavy · slots 1 · 1 running · 1 waiting");
      expect(text).toContain("session sess-q-a");

      holder.kill("SIGTERM");
      await Promise.all([finished(holder), finished(waiter)]);
    },
    60_000,
  );

  test(
    "myc run внутри команды, держащей полосу, исполняется сразу в слоте предка",
    async () => {
      const home = freshHome();
      const log = join(root, "n.log");
      const outer = await finished(
        spawnRun({ home }, [BUN, MAIN, "run", "--max-wait", "0", "--", ...kid(log, "inner", 0)]),
      );
      expect(outer.code).toBe(0);
      expect(at(log, "end", "inner")).toBeDefined();
      expect(tickets(home)).toEqual([]);
    },
    60_000,
  );
});
