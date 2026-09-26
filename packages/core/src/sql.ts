export type Dialect = "sqlite" | "pg";

export type TxMode = "deferred" | "immediate";

export interface QueryDef {
  readonly name: string;
  readonly sql: string;
  readonly params: readonly string[];
  readonly pg?: string;
}

export type QueryRegistry = Readonly<Record<string, QueryDef>>;

export interface DbDriver {
  readonly dialect: Dialect;
  one<T>(query: QueryDef, params: readonly unknown[]): T | undefined;
  all<T>(query: QueryDef, params: readonly unknown[]): T[];
  run(query: QueryDef, params: readonly unknown[]): { changes: number };
  tx<T>(mode: TxMode, fn: (tx: DbDriver) => T): T;
}

type PlaceholderMap = (n: number) => string | null;

function mapPlaceholders(
  sql: string,
  marker: "?" | "$",
  map: PlaceholderMap,
): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
    } else if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
    } else if (c === "-" && sql[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      if (i < n) i++;
      out += sql.slice(start, i);
    } else if (c === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += sql.slice(start, i);
    } else if (c === marker) {
      let j = i + 1;
      while (j < n && sql[j]! >= "0" && sql[j]! <= "9") j++;
      if (j > i + 1) {
        const num = Number(sql.slice(i + 1, j));
        const rep = map(num);
        out += rep === null ? sql.slice(i, j) : rep;
        i = j;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function toPgPlaceholders(sql: string): string {
  return mapPlaceholders(sql, "?", (n) => `$${n}`);
}

export function placeholderNumbers(sql: string, marker: "?" | "$"): number[] {
  const found: number[] = [];
  mapPlaceholders(sql, marker, (n) => {
    found.push(n);
    return null;
  });
  return found;
}

/**
 * МЕХАНИЧЕСКИЙ ПЕРЕВОД ДИАЛЕКТА.
 *
 * Оверрайд `pg` пишут там, где запросы диалектов расходятся ПО СУЩЕСТВУ.
 * Но два расхождения существа не имеют и встречаются в каждом втором запросе:
 * подсказка индекса и чтение одного ключа из JSON. Написать их руками значило
 * бы держать 27 копий одного SQL, расходящихся молча при первой же правке
 * оригинала, — поэтому они переводятся здесь, один раз, и доказываются
 * паритетом на живой базе (packages/server/src/parity.pg.test.ts).
 *
 *  - `INDEXED BY ix` — в SQLite это ТРЕБОВАНИЕ (запрос упадёт, если индекс не
 *    подходит), им закреплён план горячих путей. В Postgres такого нет вовсе:
 *    план выбирает планировщик. Подсказка снимается, результат от этого не
 *    меняется — меняется только план, и об этом здесь сказано вслух.
 *  - `json_extract(x,'$.k')` → `x->>'k'`: ровно та же операция, один ключ
 *    верхнего уровня, текстом в обоих диалектах. Пути сложнее одного ключа
 *    (массивы, вложенность) НЕ переводятся: их надо писать оверрайдом
 *    осознанно, и сторож в tests ловит их появление в реестрах.
 *
 * Оба образца пишутся по всему тексту, а не по «коду вне строк». Это
 * допущение, и оно проверяется: ни один запрос реестров не содержит этих слов
 * внутри строкового литерала (сторож — packages/core/src/sql.test.ts).
 */
const INDEX_HINT = /\s+INDEXED\s+BY\s+[A-Za-z_][A-Za-z0-9_]*/gi;
const JSON_ONE_KEY = /json_extract\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\$\.([A-Za-z_][A-Za-z0-9_]*)'\s*\)/gi;

export function toPgDialect(sql: string): string {
  return toPgPlaceholders(sql).replace(INDEX_HINT, "").replace(JSON_ONE_KEY, "$1->>'$2'");
}

export function resolveQueryText(def: QueryDef, dialect: Dialect): string {
  if (dialect === "sqlite") return def.sql;
  return def.pg ?? toPgDialect(def.sql);
}

export function validateQueryDef(def: QueryDef): void {
  if (def.name.length === 0) {
    throw new Error("query def: name must not be empty");
  }
  const check = (text: string, marker: "?" | "$", field: string) => {
    const nums = placeholderNumbers(text, marker);
    const max = nums.reduce((m, n) => Math.max(m, n), 0);
    const seen = new Set(nums);
    if (max !== def.params.length || seen.size !== max) {
      throw new Error(
        `query def '${def.name}': ${field} uses placeholders ${[...seen].sort((a, b) => a - b).join(",") || "none"}, ` +
          `expected exactly 1..${def.params.length}`,
      );
    }
  };
  check(def.sql, "?", "sql");
  if (def.pg !== undefined) check(def.pg, "$", "pg");
}

export function defineQueries<T extends QueryRegistry>(defs: T): T {
  for (const key of Object.keys(defs)) {
    const def = defs[key]!;
    if (def.name !== key) {
      throw new Error(
        `query def: registry key '${key}' does not match def name '${def.name}'`,
      );
    }
    validateQueryDef(def);
  }
  return Object.freeze({ ...defs });
}

export class StatementCache<S> {
  private readonly max: number;
  private readonly map = new Map<string, S>();
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(max = 64) {
    this.max = max;
  }

  get size(): number {
    return this.map.size;
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  get evictions(): number {
    return this.evictionCount;
  }

  get(key: string): S | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: S): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
        this.evictionCount++;
      }
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}
