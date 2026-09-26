/**
 * ПРИМЕНЕНИЕ ОПЕРАЦИЙ — ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ.
 *
 * Правила слияния myc обязаны существовать в единственном экземпляре: у
 * SQLite и у Postgres может расходиться текст запроса (это видно и ловится
 * паритетом), но НЕ порядок проверки часов и не решение «применить, отбросить
 * или назвать столкновением». Две копии такого решения расходятся молча.
 *
 * Поэтому код здесь написан генератором (см. effect.ts): он выдаёт запрос и
 * получает строки, а гоняют его синхронный исполнитель CLI и асинхронный
 * исполнитель сервера. Читается как обычный последовательный код, только
 * вместо `await` стоит `yield*`.
 *
 * Переезд идёт по частям, снизу вверх: сначала листья (проекция одной
 * операции), затем всё, что их вызывает. Каждый шаг оставляет полный прогон
 * зелёным — иначе он не шаг.
 */

import {
  assertNodeField,
  attrKeyOf,
  coerceNodeFieldValue,
  GraphError,
} from "./graph.ts";
import {
  compareClock,
  packHlc,
  unpackHlc,
  type Hlc,
  type IncOp,
  type JsonValue,
  type SetOp,
} from "./oplog.ts";
import { one, run, type Eff } from "./effect.ts";
import { NODE_SET_QUERIES, Q } from "./queries.ts";
import type { QueryDef } from "./sql.ts";

/** Часы из колонки: в базе они лежат упакованным целым. */
export function readHlc(text: string | number | bigint): Hlc {
  return unpackHlc(BigInt(text));
}

function parseAttrs(raw: unknown): Record<string, JsonValue> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  return JSON.parse(raw) as Record<string, JsonValue>;
}

/**
 * Счётчики, у которых есть материализующая колонка в nodes. Остальные
 * G-counter'ы живут только в таблице counters — колонки под них нет, и молча
 * писать их в никуда нельзя.
 */
const COUNTER_COLUMNS: Readonly<Record<string, QueryDef>> = Object.freeze({
  seen_count: Q.node_set_seen_count,
});

function nodeSetQuery(field: string): QueryDef {
  const def = NODE_SET_QUERIES[`node_set_${field}`];
  if (def === undefined) {
    throw new GraphError("graph.unknown_field", `no write query for field '${field}'`);
  }
  return def;
}

/** Что случилось с одной операцией поля. */
export type ProjectOutcome = "applied" | "stale" | "collided";

type ClockRow = { readonly hlc: string | number | bigint; readonly site_id: string };
type RawRow = Record<string, unknown>;

/** Совпадает ли значение поля в строке узла с тем, что несёт операция. */
function* sameStoredValue(op: SetOp, spec: ReturnType<typeof assertNodeField>): Eff<boolean> {
  const row = yield* one<RawRow>(Q.node_get, [op.entity_id]);
  if (row === undefined) return false;
  if (spec === "attr") {
    const key = attrKeyOf(op.field)!;
    return JSON.stringify(parseAttrs(row["attrs"])[key] ?? null) === JSON.stringify(op.value ?? null);
  }
  const stored = row[spec.field] ?? null;
  return stored === coerceNodeFieldValue(spec, op.value);
}

/**
 * LWW по паре (hlc, site_id) с одной особенностью, ради которой это не просто
 * «кто позже, тот прав»: НИЧЬЯ ПРИ РАЗНЫХ ЗНАЧЕНИЯХ — столкновение, а не
 * решение. Совпали часы и сайт, а значение другое — значит две машины
 * назначили разное в одну миллисекунду, и молча выбрать одно из них означало
 * бы потерять второе без следа (S38).
 *
 * `beforeWrite` вызывается ТОЛЬКО когда запись действительно будет: вызывающий
 * вешает на него учёт идентичности, и делать его для отброшенной операции
 * значило бы считать то, чего не произошло.
 */
export function* projectSet(op: SetOp, beforeWrite?: () => void): Eff<ProjectOutcome> {
  const spec = assertNodeField(op.field);
  const guard = yield* one<ClockRow>(Q.field_clock_get, [op.entity_id, op.field]);
  if (guard !== undefined) {
    const cmp = compareClock(op.hlc, op.site_id, readHlc(guard.hlc), guard.site_id);
    if (cmp < 0) return "stale";
    if (cmp === 0) {
      return (yield* sameStoredValue(op, spec)) ? "stale" : "collided";
    }
  }
  beforeWrite?.();
  const hlc = packHlc(op.hlc);
  if (spec === "attr") {
    const key = attrKeyOf(op.field)!;
    yield* run(Q.node_set_attr, [
      op.entity_id,
      `$.${key}`,
      JSON.stringify(op.value),
      op.hlc.ts,
      hlc,
      op.site_id,
    ]);
  } else {
    yield* run(nodeSetQuery(spec.field), [
      op.entity_id,
      coerceNodeFieldValue(spec, op.value),
      op.hlc.ts,
      hlc,
      op.site_id,
    ]);
  }
  yield* run(Q.field_clock_set, [op.entity_id, op.field, hlc, op.site_id]);
  return "applied";
}

/** G-counter: поэлементный максимум по сайтам, колонка — их сумма. */
export function* projectInc(op: IncOp): Eff<void> {
  yield* run(Q.counter_set, [op.entity_id, op.field, op.site_id, op.value]);
  const column = COUNTER_COLUMNS[op.field];
  if (column === undefined) return;
  const total = (yield* one<{ total: number }>(Q.counter_sum, [op.entity_id, op.field]))?.total ?? 0;
  yield* run(column, [op.entity_id, total]);
}
