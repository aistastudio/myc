import { describe, expect, test } from "bun:test";
import { Diagnostics } from "./diagnostics.ts";
import { envelopeLine, errorEnvelope, okEnvelope } from "./envelope.ts";

function filledDiagnostics(): Diagnostics {
  const diags = new Diagnostics();
  diags.add("index.partial", "3 anchors stale");
  diags.add("embed.fallback", "model file missing, tf-idf used");
  return diags;
}

describe("envelope", () => {
  test("ok envelope carries data, meta and both degradation projections", () => {
    const envelope = okEnvelope("ready", [{ id: "a" }], { count: 1 }, filledDiagnostics());
    expect(envelope).toEqual({
      ok: true,
      cmd: "ready",
      data: [{ id: "a" }],
      meta: {
        count: 1,
        degraded: ["index.partial", "embed.fallback"],
      },
      warn: [
        { code: "index.partial", msg: "3 anchors stale" },
        { code: "embed.fallback", msg: "model file missing, tf-idf used" },
      ],
    });
  });

  test("command meta cannot clobber degraded", () => {
    const envelope = okEnvelope("c", null, { degraded: ["lie"] }, filledDiagnostics());
    expect(envelope.meta.degraded).toEqual(["index.partial", "embed.fallback"]);
  });

  test("error envelope: data null, error block with exit and hint", () => {
    const envelope = errorEnvelope(
      "claim",
      { code: "conflict.claimed", msg: "taken", exit: 5, hint: "try --steal" },
      new Diagnostics(),
    );
    expect(envelope).toEqual({
      ok: false,
      cmd: "claim",
      data: null,
      meta: { degraded: [] },
      warn: [],
      error: { code: "conflict.claimed", msg: "taken", exit: 5, hint: "try --steal" },
    });
  });

  test("envelopeLine is one compact line with trailing newline", () => {
    const line = envelopeLine(okEnvelope("c", 1, undefined, new Diagnostics()));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter((l) => l !== "").length).toBe(1);
    expect(line).not.toContain("  ");
  });
});
