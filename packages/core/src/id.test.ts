import { describe, expect, test } from "bun:test";
import {
  formatDotPath,
  formatId,
  generateId,
  MIN_PREFIX_LEN,
  parseDotPath,
  parseId,
  prefixRange,
  shortestUniquePrefixes,
} from "./id.ts";

describe("generateId", () => {
  test("has canonical shape <slug>-<12 crockford chars>", () => {
    const id = generateId();
    expect(id).toMatch(/^myc-[0-9a-hjkmnp-tv-z]{12}$/);
  });

  test("respects a custom slug", () => {
    const id = generateId("acme");
    expect(id.startsWith("acme-")).toBe(true);
  });

  test("1,000,000 generated IDs: zero collisions", () => {
    const n = 1_000_000;
    const seen = new Set<string>();
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      seen.add(generateId());
    }
    const elapsedMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(
      `generateId: ${n} ids in ${elapsedMs.toFixed(1)}ms (${(
        (elapsedMs * 1000) /
        n
      ).toFixed(3)} us/id)`,
    );
    expect(seen.size).toBe(n);
  });
});

describe("parseId", () => {
  test("round-trips a generated id", () => {
    const id = generateId();
    const result = parseId(id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(formatId(result.value)).toBe(id);
    }
  });

  test("is case-insensitive and normalizes to lowercase", () => {
    const result = parseId("MYC-A3F8B2C4D5E6");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slug).toBe("myc");
      expect(result.value.body).toBe("a3f8b2c4d5e6");
    }
  });

  test("treats I/l as 1 and O as 0 per Crockford", () => {
    const result = parseId("myc-Il0OIl0OIl0O");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toBe("110011001100");
    }
  });

  test("rejects empty input without throwing", () => {
    const result = parseId("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("empty");
  });

  test("rejects input with no separator", () => {
    const result = parseId("nodash12345678");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("missing_separator");
  });

  test("rejects wrong body length", () => {
    const result = parseId("myc-abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_body_length");
  });

  test("rejects invalid body characters (u is excluded)", () => {
    const result = parseId("myc-uuuuuuuuuuuu");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_body_char");
  });

  test("rejects an invalid slug", () => {
    const result = parseId("1bad-a3f8b2c4d5e6");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_slug");
  });
});

describe("prefixRange", () => {
  test("increments the last char within the alphabet", () => {
    const range = prefixRange("myc-a3f8");
    expect(range.lower).toBe("myc-a3f8");
    expect(range.upper).toBe("myc-a3f9");
  });

  test("carries over through a trailing 'z'", () => {
    const range = prefixRange("myc-a3fz");
    expect(range.lower).toBe("myc-a3fz");
    // 'z' is last in the Crockford alphabet -> carry into the previous digit
    expect(range.upper).toBe("myc-a3g");
  });

  test("handles an all-'z' body correctly", () => {
    const range = prefixRange("myc-zzzz");
    expect(range.lower).toBe("myc-zzzz");
    // no successor exists in-alphabet; upper must still exceed every valid body
    expect(range.upper > "myc-zzzz9").toBe(true);
    expect(range.upper.startsWith("myc-zzzz")).toBe(true);
  });

  test("upper strictly bounds every id sharing the prefix", () => {
    const prefix = "myc-a3f8";
    const { lower, upper } = prefixRange(prefix);
    for (const suffix of ["0000", "zzzz", "j9k2"]) {
      const id = prefix + suffix;
      expect(id >= lower).toBe(true);
      expect(id < upper).toBe(true);
    }
  });
});

describe("shortestUniquePrefixes", () => {
  test("never returns a length shorter than MIN_PREFIX_LEN", () => {
    const ids = [generateId(), generateId(), generateId()];
    const lengths = shortestUniquePrefixes(ids);
    for (const len of lengths.values()) {
      expect(len).toBeGreaterThanOrEqual(MIN_PREFIX_LEN);
    }
  });

  test("resolves a hand-crafted collision by extending length", () => {
    const ids = ["myc-abcd00000000", "myc-abcd00000001", "myc-zzzz99999999"];
    const lengths = shortestUniquePrefixes(ids);
    expect(lengths.get("myc-zzzz99999999")).toBe(MIN_PREFIX_LEN);
    expect(lengths.get("myc-abcd00000000")).toBeGreaterThan(MIN_PREFIX_LEN);
    expect(lengths.get("myc-abcd00000001")).toBeGreaterThan(MIN_PREFIX_LEN);

    for (const [id, len] of lengths) {
      const prefix = id.slice(4, 4 + len); // strip "myc-"
      const collisions = ids.filter(
        (other) => other !== id && other.slice(4, 4 + len) === prefix,
      );
      expect(collisions.length).toBe(0);
    }
  });

  test("distribution over 10,000 ids is mostly 4-6 chars", () => {
    const ids = Array.from({ length: 10_000 }, () => generateId());
    const lengths = shortestUniquePrefixes(ids);
    const histogram = new Map<number, number>();
    for (const len of lengths.values()) {
      histogram.set(len, (histogram.get(len) ?? 0) + 1);
    }
    const within4to6 = [4, 5, 6].reduce(
      (sum, len) => sum + (histogram.get(len) ?? 0),
      0,
    );
    // eslint-disable-next-line no-console
    console.log(
      `shortestUniquePrefixes histogram over 10k ids:`,
      Object.fromEntries([...histogram.entries()].sort((a, b) => a[0] - b[0])),
    );
    expect(within4to6 / ids.length).toBeGreaterThan(0.9);
    // 10 000 идентификаторов и построение по ним префиксов — это ~4 с на
    // рабочей машине при умолчании bun в 5 с. Запас ×1.24 не запас, а
    // лотерея: на раннере CI тест упал по таймауту (5.34 с), ничего не
    // проверив. Время здесь не предмет проверки — проверяется распределение.
  }, 60_000);
});

describe("dot path", () => {
  test("formats a multi-level path", () => {
    const path = formatDotPath("myc-a3f8", [{ ordinal: 1 }, { ordinal: 2 }]);
    expect(path).toBe("myc-a3f8.1.2");
  });

  test("formats a root with no ancestry", () => {
    expect(formatDotPath("myc-a3f8", [])).toBe("myc-a3f8");
  });

  test("round-trips through parseDotPath", () => {
    const parsed = parseDotPath("myc-a3f8.1.2");
    expect(parsed).toEqual({ rootShortId: "myc-a3f8", ordinals: [1, 2] });
  });

  test("parses a root-only path", () => {
    expect(parseDotPath("myc-a3f8")).toEqual({
      rootShortId: "myc-a3f8",
      ordinals: [],
    });
  });

  test("rejects malformed segments", () => {
    expect(parseDotPath("myc-a3f8.0.2")).toBeNull();
    expect(parseDotPath("myc-a3f8.")).toBeNull();
    expect(parseDotPath(".1.2")).toBeNull();
  });
});
