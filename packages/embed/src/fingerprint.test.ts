import { describe, expect, test } from "bun:test";
import {
  checkFingerprint,
  ensureFingerprintCompatible,
  FingerprintMismatchError,
  formatEmbedFingerprint,
  parseEmbedFingerprint,
} from "./fingerprint.ts";
import type { EmbedFingerprint } from "./types.ts";

const LOCAL: EmbedFingerprint = {
  backend: "local",
  provider: "onnx",
  model: "bge-small-en-v1.5-q8",
  dim: 384,
  normalize: true,
};

describe("embed fingerprint", () => {
  test("каноническая форма", () => {
    expect(formatEmbedFingerprint(LOCAL)).toBe(
      "local:onnx:bge-small-en-v1.5-q8:384:l2",
    );
  });

  test("parse/format симметричны", () => {
    const s = "api:openai-compatible:text-embedding-3-small:1536:none";
    const fp = parseEmbedFingerprint(s);
    expect(fp).not.toBeNull();
    expect(formatEmbedFingerprint(fp!)).toBe(s);
  });

  test("мусор не разбирается", () => {
    expect(parseEmbedFingerprint("hello")).toBeNull();
    expect(parseEmbedFingerprint("local:onnx:model:notadim:l2")).toBeNull();
  });

  test("пустая запись совместима (пространство ещё не зафиксировано)", () => {
    expect(checkFingerprint(null, LOCAL).compatible).toBe(true);
    expect(checkFingerprint(undefined, LOCAL).compatible).toBe(true);
    expect(checkFingerprint("", LOCAL).compatible).toBe(true);
  });

  test("полное совпадение совместимо", () => {
    expect(checkFingerprint("local:onnx:bge-small-en-v1.5-q8:384:l2", LOCAL).compatible).toBe(true);
    expect(checkFingerprint(LOCAL, LOCAL).compatible).toBe(true);
  });

  test("расхождение по любому полю — отказ", () => {
    const variants = [
      "api:onnx:bge-small-en-v1.5-q8:384:l2",
      "local:openai:bge-small-en-v1.5-q8:384:l2",
      "local:onnx:multilingual-e5-small-q8:384:l2",
      "local:onnx:bge-small-en-v1.5-q8:768:l2",
      "local:onnx:bge-small-en-v1.5-q8:384:none",
    ];
    for (const v of variants) {
      const check = checkFingerprint(v, LOCAL);
      expect(check.compatible).toBe(false);
      expect(check.mismatch).toContain(v);
    }
  });

  test("неразбираемая запись — отказ, не исключение", () => {
    const check = checkFingerprint("мусор", LOCAL);
    expect(check.compatible).toBe(false);
  });

  test("ensureFingerprintCompatible бросает с кодом", () => {
    expect(() => ensureFingerprintCompatible("local:onnx:other:384:l2", LOCAL)).toThrow(
      FingerprintMismatchError,
    );
    expect(() => ensureFingerprintCompatible(LOCAL, LOCAL)).not.toThrow();
  });
});
