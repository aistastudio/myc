import { describe, expect, test } from "bun:test";
import { Registry } from "./registry.ts";

function makeRegistry(): Registry {
  const registry = new Registry();
  registry.register({
    name: "dep",
    summary: "dependencies",
    flags: [{ name: "ws", value: "string", description: "workspace" }],
    subcommands: [
      {
        name: "add",
        summary: "add dependency",
        flags: [{ name: "ref", value: "string", description: "referenced node" }],
        handler: () => ({ ok: true as const, data: null }),
      },
      {
        name: "rm",
        summary: "remove dependency",
        handler: () => ({ ok: true as const, data: null }),
      },
    ],
  });
  registry.register({
    name: "ready",
    summary: "ready queue",
    handler: () => ({ ok: true as const, data: null }),
  });
  return registry;
}

describe("Registry", () => {
  test("resolve top-level and nested commands", () => {
    const registry = makeRegistry();
    expect(registry.resolve(["ready"])?.name).toBe("ready");
    expect(registry.resolve(["dep"])?.name).toBe("dep");
    expect(registry.resolve(["dep", "add"])?.name).toBe("add");
    expect(registry.resolve(["nope"])).toBeUndefined();
    expect(registry.resolve([])).toBeUndefined();
  });

  test("paths lists every path up to two levels", () => {
    expect(makeRegistry().paths().sort()).toEqual([
      "dep",
      "dep add",
      "dep rm",
      "ready",
    ]);
  });

  test("flagsFor merges inherited and own flags", () => {
    const flags = makeRegistry().flagsFor(["dep", "add"]);
    expect(flags.map((f) => f.name)).toEqual(["ws", "ref"]);
  });

  test("hasTop", () => {
    expect(makeRegistry().hasTop("dep")).toBe(true);
    expect(makeRegistry().hasTop("nope")).toBe(false);
  });
});
