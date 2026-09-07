import { describe, expect, test } from "bun:test";
import {
  StatementCache,
  defineQueries,
  placeholderNumbers,
  resolveQueryText,
  toPgPlaceholders,
  validateQueryDef,
  type QueryDef,
} from "./sql.ts";

describe("toPgPlaceholders", () => {
  test("rewrites numbered placeholders outside literals", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ?1 AND b = ?2")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  test("rewrites multi-digit and adjacent placeholders", () => {
    expect(toPgPlaceholders("SELECT ?10, ?1?2")).toBe("SELECT $10, $1$2");
  });

  test("does not touch ?N inside a single-quoted string literal", () => {
    const sql = "SELECT * FROM t WHERE note = 'текст ?1 внутри' AND id = ?1";
    expect(toPgPlaceholders(sql)).toBe(
      "SELECT * FROM t WHERE note = 'текст ?1 внутри' AND id = $1",
    );
  });

  test("handles doubled quotes inside string literals", () => {
    const sql = "SELECT 'it''s ?2 ok' AS x, ?1 FROM t";
    expect(toPgPlaceholders(sql)).toBe("SELECT 'it''s ?2 ok' AS x, $1 FROM t");
  });

  test("does not treat content after an escaped quote as literal end", () => {
    const sql = "SELECT 'a''b ?9 c''d ?3' , ?1";
    expect(toPgPlaceholders(sql)).toBe("SELECT 'a''b ?9 c''d ?3' , $1");
  });

  test("does not touch ?N inside a line comment", () => {
    const sql = "SELECT ?1 -- keep ?2 here\n, ?3";
    expect(toPgPlaceholders(sql)).toBe("SELECT $1 -- keep ?2 here\n, $3");
  });

  test("does not touch ?N inside a block comment", () => {
    const sql = "SELECT /* ?1 stays ?2 */ ?3 FROM t";
    expect(toPgPlaceholders(sql)).toBe("SELECT /* ?1 stays ?2 */ $3 FROM t");
  });

  test("unterminated block comment swallows to the end", () => {
    const sql = "SELECT ?1 /* ?2 never ends";
    expect(toPgPlaceholders(sql)).toBe("SELECT $1 /* ?2 never ends");
  });

  test("does not treat a comment marker inside a literal as a comment", () => {
    const sql = "SELECT '-- not ?1 a comment' , ?2";
    expect(toPgPlaceholders(sql)).toBe("SELECT '-- not ?1 a comment' , $2");
  });

  test("does not touch ?N inside a double-quoted identifier", () => {
    const sql = 'SELECT "weird ?1 col" FROM t WHERE id = ?1';
    expect(toPgPlaceholders(sql)).toBe(
      'SELECT "weird ?1 col" FROM t WHERE id = $1',
    );
  });

  test("handles doubled quotes inside double-quoted identifiers", () => {
    const sql = 'SELECT "say ""hi"" ?1" , ?2 FROM t';
    expect(toPgPlaceholders(sql)).toBe('SELECT "say ""hi"" ?1" , $2 FROM t');
  });

  test("leaves a bare ? without digits untouched", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a IS NOT ?")).toBe(
      "SELECT * FROM t WHERE a IS NOT ?",
    );
  });

  test("string literal is not ended by a quote-looking comment", () => {
    const sql = "SELECT 'a -- b ?1' , ?2";
    expect(toPgPlaceholders(sql)).toBe("SELECT 'a -- b ?1' , $2");
  });
});

describe("placeholderNumbers", () => {
  test("collects numbers from ?N markers only outside literals", () => {
    expect(placeholderNumbers("SELECT ' ?5 ' , ?1, ?3", "?")).toEqual([1, 3]);
  });

  test("collects $N markers for pg texts", () => {
    expect(placeholderNumbers("a = $2 AND b = $1", "$")).toEqual([2, 1]);
  });

  test("empty for placeholder-free text", () => {
    expect(placeholderNumbers("SELECT 1", "?")).toEqual([]);
  });
});

describe("resolveQueryText", () => {
  const def: QueryDef = {
    name: "q",
    sql: "SELECT ?1, ' ?2 '",
    params: ["a", "b"],
    pg: "SELECT $1, $2::text",
  };

  test("sqlite uses the shared text as-is", () => {
    expect(resolveQueryText(def, "sqlite")).toBe("SELECT ?1, ' ?2 '");
  });

  test("pg prefers the explicit override", () => {
    expect(resolveQueryText(def, "pg")).toBe("SELECT $1, $2::text");
  });

  test("pg falls back to rewriting when no override exists", () => {
    const noOverride: QueryDef = { name: "q2", sql: "a = ?1", params: ["a"] };
    expect(resolveQueryText(noOverride, "pg")).toBe("a = $1");
  });
});

describe("defineQueries", () => {
  test("accepts a valid registry and keeps defs readable", () => {
    const Q = defineQueries({
      node_get: { name: "node_get", sql: "SELECT ?1", params: ["id"] },
    });
    expect(Q.node_get!.name).toBe("node_get");
  });

  test("rejects a registry key that does not match the def name", () => {
    expect(() =>
      defineQueries({ node_get: { name: "other", sql: "SELECT 1", params: [] } }),
    ).toThrow(/does not match/);
  });

  test("rejects arity mismatch between params and placeholders", () => {
    expect(() =>
      validateQueryDef({ name: "q", sql: "a = ?1 AND b = ?2", params: ["a"] }),
    ).toThrow(/1\.\.1/);
  });

  test("rejects gaps in placeholder numbering", () => {
    expect(() =>
      validateQueryDef({ name: "q", sql: "a = ?1 AND b = ?3", params: ["a", "b", "c"] }),
    ).toThrow(/1,3/);
  });

  test("rejects a pg override with wrong $N arity", () => {
    expect(() =>
      validateQueryDef({
        name: "q",
        sql: "a = ?1",
        params: ["a"],
        pg: "a = $1 AND b = $2",
      }),
    ).toThrow(/\$N|pg/);
  });
});

describe("StatementCache", () => {
  test("returns undefined on miss and the stored value on hit", () => {
    const cache = new StatementCache<string>(4);
    expect(cache.get("k")).toBeUndefined();
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(1);
  });

  test("evicts the least recently used entry beyond capacity", () => {
    const cache = new StatementCache<string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
    expect(cache.evictions).toBe(1);
    expect(cache.size).toBe(2);
  });

  test("overwriting an existing key does not evict", () => {
    const cache = new StatementCache<string>(2);
    cache.set("a", "1");
    cache.set("a", "1b");
    expect(cache.get("a")).toBe("1b");
    expect(cache.evictions).toBe(0);
  });
});
