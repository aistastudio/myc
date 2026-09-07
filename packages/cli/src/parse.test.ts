import { describe, expect, test } from "bun:test";
import { levenshtein, parseArgv, suggest } from "./parse.ts";
import { Registry } from "./registry.ts";

function makeRegistry(): Registry {
  const registry = new Registry();
  registry.register({
    name: "dep",
    summary: "dependencies",
    flags: [{ name: "ref", value: "string", description: "referenced node" }],
    subcommands: [
      {
        name: "add",
        summary: "add dependency",
        handler: () => ({ ok: true as const, data: null }),
      },
    ],
  });
  return registry;
}

describe("parseArgv", () => {
  test("globals before command, command flags after", () => {
    const result = parseArgv(
      ["--json", "--db", "x.db", "dep", "add", "--ref", "r1", "extra"],
      makeRegistry(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.argv.commandPath).toEqual(["dep", "add"]);
    expect(result.argv.flags).toEqual({ json: true, db: "x.db", ref: "r1" });
    expect(result.argv.positionals).toEqual(["extra"]);
  });

  test("-- ends flag parsing", () => {
    const result = parseArgv(["dep", "add", "--", "--json"], makeRegistry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.argv.flags).toEqual({});
    expect(result.argv.positionals).toEqual(["--json"]);
  });

  test("unknown global flag fails with nearest suggestion", () => {
    const result = parseArgv(["--jsn"], makeRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.msg).toBe("unknown flag --jsn");
    expect(result.failure.hint).toBe("did you mean --json?");
  });

  test("unknown flag after command suggests command flags", () => {
    const result = parseArgv(["dep", "add", "--rf"], makeRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.hint).toBe("did you mean --ref?");
  });

  test("unknown command fails with suggestion", () => {
    const result = parseArgv(["deq"], makeRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.msg).toBe("unknown command 'deq'");
    expect(result.failure.hint).toBe("did you mean 'dep'?");
  });

  test("unknown subcommand of a pure group fails with suggestion", () => {
    const result = parseArgv(["dep", "ad"], makeRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.msg).toBe("unknown subcommand 'ad' for dep");
    expect(result.failure.hint).toBe("did you mean 'add'?");
  });

  test("--name=value form", () => {
    const result = parseArgv(["--db=x.db"], makeRegistry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.argv.flags.db).toBe("x.db");
  });

  test("short flag with attached and separate value", () => {
    const a = parseArgv(["-C/tmp"], makeRegistry());
    const b = parseArgv(["-C", "/tmp"], makeRegistry());
    expect(a.ok && a.argv.flags.directory).toBe("/tmp");
    expect(b.ok && b.argv.flags.directory).toBe("/tmp");
  });

  test("boolean short flag", () => {
    const result = parseArgv(["-q"], makeRegistry());
    expect(result.ok && result.argv.flags.quiet).toBe(true);
  });

  test("missing value fails", () => {
    expect(parseArgv(["--db"], makeRegistry()).ok).toBe(false);
    expect(parseArgv(["-C"], makeRegistry()).ok).toBe(false);
  });

  test("boolean flag with =value fails", () => {
    const result = parseArgv(["--json=1"], makeRegistry());
    expect(result.ok).toBe(false);
  });

  test("combined short flags rejected", () => {
    const result = parseArgv(["-qx"], makeRegistry());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.msg).toContain("combined short flags");
  });

  test("no args parses to empty", () => {
    const result = parseArgv([], makeRegistry());
    expect(result.ok && result.argv.commandPath).toEqual([]);
  });
});

describe("levenshtein", () => {
  test("distances", () => {
    expect(levenshtein("jsn", "json")).toBe(1);
    expect(levenshtein("clame", "claim")).toBe(2);
    expect(levenshtein("add", "add")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });

  test("suggest returns nearest close candidate", () => {
    expect(suggest("jsn", ["json", "ndjson", "db"])).toBe("json");
    expect(suggest("clame", ["close", "ready", "claim"])).toBe("claim");
  });

  test("suggest stays silent when nothing is close", () => {
    expect(suggest("bogus", ["json", "db"])).toBeUndefined();
    expect(suggest("x", ["json"])).toBeUndefined();
  });
});
