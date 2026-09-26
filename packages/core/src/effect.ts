/**
 * ОДИН АЛГОРИТМ НА ДВА ДРАЙВЕРА — БЕЗ ВТОРОЙ КОПИИ И БЕЗ ПРОМИСОВ В ГОРЯЧЕМ
 * ПУТИ.
 *
 * Правила слияния myc (оплог, HLC, часы полей, разбор двойников) обязаны
 * существовать в ЕДИНСТВЕННОМ экземпляре: две копии CRDT расходятся тише и
 * опаснее, чем два текста SQL. Но исполнять их приходится двумя способами —
 * `bun:sqlite` синхронен, Postgres асинхронен.
 *
 * Прямой путь — переписать всё на `async` — стоит ~600 мест вызова (77 в коде,
 * 522 в тестах) и промис на каждый оператор пути записи, где сегодня нет ни
 * одного. Поэтому алгоритм пишется ГЕНЕРАТОРОМ: он не исполняет запрос, а
 * ВЫДАЁТ его наружу и получает строки обратно. Гоняют его два коротких
 * исполнителя ниже. Текст алгоритма при этом читается как обычный
 * последовательный код — с `yield*` вместо `await`.
 *
 * Решение и порядок работ: 03-interfaces-and-integration.md §8.1.1.
 */

import type { DbDriver, QueryDef } from "./sql.ts";

/** Запрос, который алгоритм выдал вместо того, чтобы исполнить. */
export type DbRequest =
  | { readonly kind: "one"; readonly query: QueryDef; readonly params: readonly unknown[] }
  | { readonly kind: "all"; readonly query: QueryDef; readonly params: readonly unknown[] }
  | { readonly kind: "run"; readonly query: QueryDef; readonly params: readonly unknown[] };

/**
 * Эффект: генератор, выдающий запросы и возвращающий результат `T`.
 *
 * Третий параметр `Generator` — тип того, что исполнитель ПРИСЫЛАЕТ обратно в
 * `yield`. Он общий для всех трёх видов запроса, поэтому сужают его хелперы
 * `one`/`all`/`run` ниже: вызывающий пишет `yield* one<Row>(…)` и получает
 * типизированный ответ, а не `unknown`.
 */
export type Eff<T> = Generator<DbRequest, T, unknown>;

/** Драйвер, отвечающий промисами (Postgres). Зеркало {@link DbDriver}. */
export interface AsyncDbDriver {
  readonly dialect: "pg";
  one<T>(query: QueryDef, params: readonly unknown[]): Promise<T | undefined>;
  all<T>(query: QueryDef, params: readonly unknown[]): Promise<T[]>;
  run(query: QueryDef, params: readonly unknown[]): Promise<{ changes: number }>;
}

export function* one<T>(query: QueryDef, params: readonly unknown[] = []): Eff<T | undefined> {
  return (yield { kind: "one", query, params }) as T | undefined;
}

export function* all<T>(query: QueryDef, params: readonly unknown[] = []): Eff<T[]> {
  return (yield { kind: "all", query, params }) as T[];
}

export function* run(query: QueryDef, params: readonly unknown[] = []): Eff<{ changes: number }> {
  return (yield { kind: "run", query, params }) as { changes: number };
}

/**
 * Синхронный прогон — путь CLI. Ни одного промиса: генератор дешевле, и
 * бюджеты записи (S21, S59) этого перехода не замечают.
 */
export function runSync<T>(eff: Eff<T>, tx: DbDriver): T {
  let sent: unknown;
  for (;;) {
    const step = eff.next(sent);
    if (step.done === true) return step.value;
    const r = step.value;
    sent =
      r.kind === "one"
        ? tx.one(r.query, r.params)
        : r.kind === "all"
          ? tx.all(r.query, r.params)
          : tx.run(r.query, r.params);
  }
}

/** Асинхронный прогон — путь сервера. Тот же генератор, другой драйвер. */
export async function runAsync<T>(eff: Eff<T>, tx: AsyncDbDriver): Promise<T> {
  let sent: unknown;
  for (;;) {
    const step = eff.next(sent);
    if (step.done === true) return step.value;
    const r = step.value;
    sent =
      r.kind === "one"
        ? await tx.one(r.query, r.params)
        : r.kind === "all"
          ? await tx.all(r.query, r.params)
          : await tx.run(r.query, r.params);
  }
}
