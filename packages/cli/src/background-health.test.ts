/**
 * `myc doctor --background` (memory-h5zp5mqcdbay): тревога, когда команды шли,
 * а фон после них — нет. Возраст отметки сам по себе уликой не считается.
 *
 * Три слоя. Порог — чистой функцией на ТЕХ периодах, что стоят в продукте
 * (drain.ts, @myc/code-intel/refresh), точно по границам: запас в
 * OVERDUE_PERIODS периодов и серия записей длиной в период. Сверка по базе —
 * на настоящей базе воркспейса со вписанными в оплог записями нужного
 * времени. Команда — настоящим процессом CLI без тест-раннера в окружении:
 * под `bun test` проверка честно отвечает «n/a», и только спавн видит её
 * боевой путь, код выхода и WARN.
 *
 * Мутации: OVERDUE_PERIODS = 3, `<` на `<=` в серии, `>` на `>=` в SQL
 * просрочки — краснеют граничные тесты; литерал `process.env.NODE_ENV`
 * вместо параметра — node-env-fold.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cliTestEnv } from "@myc/core";
import { CODE_INDEXED_AT_KEY, CODE_REFRESH_AFTER_MS } from "@myc/code-intel/refresh";
import {
  OVERDUE_PERIODS,
  checkBackground,
  judgeMark,
  overdueFrom,
  type BackgroundSection,
} from "./background-health.ts";
import { ANCHOR_SWEEP_PERIOD_MS, ANCHOR_SWEPT_AT_KEY } from "./drain.ts";
import { ExitCode } from "./exit.ts";

const CLI_ENTRY = join(import.meta.dir, "main.ts");
/** Боевой путь проверки: ни тест-раннера, ни выключателей. */
const LIVE = { env: {} as NodeJS.ProcessEnv, processEnv: {} as NodeJS.ProcessEnv };
/** Отметка для чистой функции: сутки до полудня 2026-09-15. */
const S = Date.UTC(2026, 8, 14, 12, 0, 0);

let root: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "myc-bg-health-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

async function cli(ws: string, args: readonly string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, "-C", ws, ...args], {
    cwd: ws,
    env: cliTestEnv({ HOME: home, MYC_HOME: home, MYC_ACTOR: "tester", ...extra }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

let seq = 0;

/**
 * Свежий воркспейс настоящим `myc init` (фон выключен — отметок нет) и
 * момент сразу после него: записи самого init лежат не позже, и вписанные
 * тестом времена отсчитываются от него — иначе запись init попала бы в серию.
 */
async function workspace(name: string): Promise<{ db: string; t0: number }> {
  const ws = join(root, name);
  mkdirSync(ws);
  const r = await cli(ws, ["init"]);
  if (r.code !== 0) throw new Error(`myc init: ${r.out}`);
  return { db: join(ws, ".myc", "myc.db"), t0: Date.now() + 1 };
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

/** Локальные записи оплога в заданные моменты — как оставила бы их команда. */
function writesAt(db: Database, times: readonly number[], origin = 1): void {
  for (const t of times) {
    seq++;
    db.run(
      "INSERT INTO oplog (op_id, site_id, hlc, ts_ms, op, entity, entity_id, origin) VALUES (?1, 'bg-test', ?2, ?3, 'set', 'node', 'n', ?4)",
      [`bg-test:${seq}`, t * 65536 + seq, t, origin],
    );
  }
}

function setMeta(db: Database, key: string, value: number): void {
  db.run(
    "INSERT INTO myc_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, String(value)],
  );
}

const byName = (s: BackgroundSection, name: string) => s.checks.find((c) => c.name === name);

describe("порог: запас OVERDUE_PERIODS периодов и серия записей длиной в период", () => {
  const P = ANCHOR_SWEEP_PERIOD_MS;
  const first = S + OVERDUE_PERIODS * P + 1;

  test("периоды — продуктовые, запас — два периода", () => {
    expect(ANCHOR_SWEEP_PERIOD_MS).toBe(300_000);
    expect(CODE_REFRESH_AFTER_MS).toBe(900_000);
    expect(OVERDUE_PERIODS).toBe(2);
    expect(overdueFrom(S, P)).toBe(S + 2 * P);
    expect(overdueFrom(null, P)).toBe(Number.NEGATIVE_INFINITY);
  });

  test("серия ровно в период после просрочки — frozen; на миллисекунду короче — ok", () => {
    expect(judgeMark(S, P, { first, last: first + P, count: 2 })).toBe("frozen");
    expect(judgeMark(S, P, { first, last: first + P - 1, count: 2 })).toBe("ok");
  });

  test("простой: записей после просрочки нет — ok, сколько бы ни было лет отметке", () => {
    expect(judgeMark(S, P, null)).toBe("ok");
  });

  test("отметки нет: записи есть — never, нет и записей — idle", () => {
    expect(judgeMark(null, P, { first: S, last: S, count: 1 })).toBe("never");
    expect(judgeMark(null, P, null)).toBe("idle");
  });
});

describe("сверка по настоящей базе", () => {
  test("anchor_sweep: записи шли период после двойной просрочки — drift с лекарством", async () => {
    const { db, t0: S } = await workspace("frozen");
    const P = ANCHOR_SWEEP_PERIOD_MS;
    const s = withDb(db, (h) => {
      setMeta(h, ANCHOR_SWEPT_AT_KEY, S);
      writesAt(h, [S + 2 * P + 1, S + 3 * P + 1]);
      return checkBackground(h, { ...LIVE, now: S + 10 * ANCHOR_SWEEP_PERIOD_MS });
    });
    const c = byName(s, "anchor_sweep")!;
    expect(c.verdict).toBe("drift");
    expect(c.detail).toContain("commands run, the background after them does not");
    expect(c.detail).toContain("bun run build");
    expect(s.marks.find((m) => m.name === "anchor_sweep")?.verdict).toBe("frozen");
  });

  test("граница SQL: запись ровно в момент просрочки уликой не считается", async () => {
    const { db, t0: S } = await workspace("boundary");
    const P = ANCHOR_SWEEP_PERIOD_MS;
    const s = withDb(db, (h) => {
      setMeta(h, ANCHOR_SWEPT_AT_KEY, S);
      // Первая — ровно на пороге (не просрочена), вторая — через период:
      // в серии остаётся одна запись, её длина ноль.
      writesAt(h, [S + 2 * P, S + 3 * P]);
      return checkBackground(h, { ...LIVE, now: S + 10 * ANCHOR_SWEEP_PERIOD_MS });
    });
    expect(byName(s, "anchor_sweep")!.verdict).toBe("ok");
  });

  test("реплицированные записи — след чужой машины, а не команд здесь", async () => {
    const { db, t0: S } = await workspace("replicated");
    const P = ANCHOR_SWEEP_PERIOD_MS;
    const s = withDb(db, (h) => {
      setMeta(h, ANCHOR_SWEPT_AT_KEY, S);
      writesAt(h, [S + 2 * P + 1, S + 3 * P + 1], 0);
      return checkBackground(h, { ...LIVE, now: S + 10 * ANCHOR_SWEEP_PERIOD_MS });
    });
    expect(byName(s, "anchor_sweep")!.verdict).toBe("ok");
  });

  test("code_index: без якорей и индекса — n/a; с индексом и замёрзшей отметкой — drift", async () => {
    const { db, t0: S } = await workspace("code");
    const Q = CODE_REFRESH_AFTER_MS;
    const bare = withDb(db, (h) => {
      setMeta(h, CODE_INDEXED_AT_KEY, S);
      writesAt(h, [S + 2 * Q + 1, S + 3 * Q + 1]);
      return checkBackground(h, { ...LIVE, now: S + 4 * Q });
    });
    expect(byName(bare, "code_index")!.verdict).toBe("n/a");
    const indexed = withDb(db, (h) => {
      h.run(
        "INSERT INTO code_files (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at) VALUES ('r', 'a.ts', 'ts', 1, 1, 'wy:0', ?1)",
        [S],
      );
      return checkBackground(h, { ...LIVE, now: S + 10 * ANCHOR_SWEEP_PERIOD_MS });
    });
    const c = byName(indexed, "code_index")!;
    expect(c.verdict).toBe("drift");
    expect(c.detail).toContain("myc code index");
    // Период якорей в пятнадцать раз короче: те же записи, что дали drift
    // коду, у якорей тоже далеко за порогом — отметки нет, значит never.
    expect(byName(indexed, "anchor_sweep")!.verdict).toBe("unknown");
  });

  test("фон выключен в этом процессе — n/a, и отметки не читаются", async () => {
    const { db, t0: S } = await workspace("off");
    withDb(db, (h) => {
      setMeta(h, ANCHOR_SWEPT_AT_KEY, S);
      writesAt(h, [S + 2 * ANCHOR_SWEEP_PERIOD_MS + 1, S + 4 * ANCHOR_SWEEP_PERIOD_MS]);
      const runner = checkBackground(h, { env: {}, processEnv: { NODE_ENV: "test" }, now: S + 10 * ANCHOR_SWEEP_PERIOD_MS });
      expect(runner.checks.map((c) => c.verdict)).toEqual(["n/a", "n/a"]);
      expect(runner.marks).toEqual([]);
      const drainOff = checkBackground(h, { env: { MYC_DRAIN: "0" }, processEnv: {}, now: S + 10 * ANCHOR_SWEEP_PERIOD_MS });
      expect(byName(drainOff, "anchor_sweep")!.detail).toContain("MYC_DRAIN=0");
      const sweepOff = checkBackground(h, { env: { MYC_ANCHOR_CHECK: "0" }, processEnv: {}, now: S + 10 * ANCHOR_SWEEP_PERIOD_MS });
      expect(byName(sweepOff, "anchor_sweep")!.verdict).toBe("n/a");
    });
  });
});

describe("myc doctor — настоящим процессом, без тест-раннера в окружении", () => {
  const live = { MYC_DRAIN: "1", MYC_ANCHOR_CHECK: "1" };

  test("замёрзший фон: exit PRECOND, WARN doctor.drift с причиной", async () => {
    const { db } = await workspace("doctor-frozen");
    const now = Date.now();
    withDb(db, (h) => {
      // Картина 2026-09-14: отметка сутки назад, команды шли до последней минуты.
      setMeta(h, ANCHOR_SWEPT_AT_KEY, now - 86_400_000);
      writesAt(h, [now - 3_600_000, now - 60_000]);
    });
    const r = await cli(join(db, "..", ".."), ["--json", "doctor", "--background"], live);
    expect(r.code).toBe(ExitCode.PRECOND);
    const env = JSON.parse(r.out.split("\n")[0]!) as { warn?: Array<{ code: string; msg: string }> };
    const drift = (env.warn ?? []).filter((w) => w.code === "doctor.drift").map((w) => w.msg);
    expect(drift.some((m) => m.startsWith("anchor_sweep:") && m.includes("the background after them does not"))).toBe(true);
  }, 60_000);

  test("живой фон: отметка поспевает за записями — exit 0, раздел в конверте", async () => {
    const { db } = await workspace("doctor-live");
    const now = Date.now();
    withDb(db, (h) => {
      setMeta(h, ANCHOR_SWEPT_AT_KEY, now - 30_000);
      writesAt(h, [now - 3_600_000, now - 60_000]);
    });
    const r = await cli(join(db, "..", ".."), ["--json", "doctor", "--background"], live);
    expect(r.code).toBe(ExitCode.OK);
    const env = JSON.parse(r.out.split("\n")[0]!) as { data: { sections: string[]; background: BackgroundSection } };
    expect(env.data.sections).toEqual(["background"]);
    expect(byName(env.data.background, "anchor_sweep")!.verdict).toBe("ok");
  }, 60_000);
});
