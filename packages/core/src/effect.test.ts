/**
 * Исполнители эффекта. Проверяется то единственное, ради чего они есть: ОДИН
 * алгоритм даёт ОДИН И ТОТ ЖЕ результат на синхронном и на асинхронном
 * драйвере, и порядок запросов у них совпадает. Разойдись они — и у записи
 * появилось бы две реализации, ровно то, чего вынос применителя избегает.
 */

import { describe, expect, test } from "bun:test";
import { all, one, run, runAsync, runSync, type AsyncDbDriver, type Eff } from "./effect.ts";
import { defineQueries, type DbDriver, type QueryDef, type TxMode } from "./sql.ts";

const Q = defineQueries({
  pick: { name: "pick", sql: "SELECT ?1 AS v", params: ["v"] },
  list: { name: "list", sql: "SELECT ?1 AS v", params: ["v"] },
  poke: { name: "poke", sql: "UPDATE t SET v = ?1", params: ["v"] },
});

/** Журнал вызовов — он и есть доказательство, что порядок одинаков. */
type Call = string;

function syncDriver(log: Call[]): DbDriver {
  return {
    dialect: "sqlite",
    one: <T,>(q: QueryDef, p: readonly unknown[]): T | undefined => {
      log.push(`one ${q.name} ${JSON.stringify(p)}`);
      return { v: p[0] } as T;
    },
    all: <T,>(q: QueryDef, p: readonly unknown[]): T[] => {
      log.push(`all ${q.name} ${JSON.stringify(p)}`);
      return [{ v: p[0] }, { v: p[0] }] as T[];
    },
    run: (q: QueryDef, p: readonly unknown[]): { changes: number } => {
      log.push(`run ${q.name} ${JSON.stringify(p)}`);
      return { changes: 1 };
    },
    tx: <T,>(_mode: TxMode, fn: (tx: DbDriver) => T): T => fn(syncDriver(log)),
  };
}

function asyncDriver(log: Call[]): AsyncDbDriver {
  const s = syncDriver(log);
  return {
    dialect: "pg",
    one: async <T,>(q: QueryDef, p: readonly unknown[]): Promise<T | undefined> => s.one<T>(q, p),
    all: async <T,>(q: QueryDef, p: readonly unknown[]): Promise<T[]> => s.all<T>(q, p),
    run: async (q: QueryDef, p: readonly unknown[]): Promise<{ changes: number }> => s.run(q, p),
  };
}

/** Алгоритм, написанный один раз: ветвление по прочитанному, запись, сумма. */
function* algorithm(seed: number): Eff<string> {
  const head = yield* one<{ v: number }>(Q.pick, [seed]);
  const rows = yield* all<{ v: number }>(Q.list, [(head?.v ?? 0) + 1]);
  if (rows.length > 1) {
    const written = yield* run(Q.poke, [rows.length]);
    return `v=${head?.v ?? "нет"} rows=${rows.length} changes=${written.changes}`;
  }
  return "коротко";
}

describe("эффект: один алгоритм, два исполнителя", () => {
  test("результат и порядок запросов совпадают", async () => {
    const syncLog: Call[] = [];
    const asyncLog: Call[] = [];
    const fromSync = runSync(algorithm(41), syncDriver(syncLog));
    const fromAsync = await runAsync(algorithm(41), asyncDriver(asyncLog));

    expect(fromSync).toBe("v=41 rows=2 changes=1");
    expect(fromAsync).toBe(fromSync);
    expect(asyncLog).toEqual(syncLog);
    // Порядок — часть контракта: применитель зависит от того, что прочитал.
    expect(syncLog).toEqual(["one pick [41]", "all list [42]", "run poke [2]"]);
  });

  test("ответ драйвера ВОЗВРАЩАЕТСЯ в алгоритм, а не теряется", () => {
    // Ветка `if (rows.length > 1)` выбирается по прочитанному: драйвер,
    // отдающий одну строку, уводит алгоритм в другую ветку. Если бы
    // исполнитель не присылал ответ обратно, обе ветки вели бы себя одинаково.
    const short: DbDriver = { ...syncDriver([]), all: <T,>(): T[] => [] as T[] };
    expect(runSync(algorithm(1), short)).toBe("коротко");
  });

  test("ошибка драйвера не проглатывается ни одним из исполнителей", async () => {
    const boom = (): never => {
      throw new Error("драйвер упал");
    };
    const badSync: DbDriver = { ...syncDriver([]), one: boom };
    expect(() => runSync(algorithm(1), badSync)).toThrow("драйвер упал");

    const badAsync: AsyncDbDriver = {
      ...asyncDriver([]),
      one: async (): Promise<never> => {
        throw new Error("драйвер упал");
      },
    };
    await expect(runAsync(algorithm(1), badAsync)).rejects.toThrow("драйвер упал");
  });
});
