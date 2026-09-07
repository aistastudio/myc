import { describe, expect, test } from "bun:test";
import {
  cosineSimilarity,
  dequantizeInt8,
  normalizeInPlace,
  quantizeInt8,
  QuantizeError,
} from "./quantize.ts";

function unit(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = ((s / 0x7fffffff) * 2 - 1) / Math.sqrt(dim);
  }
  return normalizeInPlace(v);
}

describe("quantizeInt8", () => {
  test("dim сохраняется, значения в [-127, 127]", () => {
    const v = unit(384, 7);
    const { q, scale } = quantizeInt8(v);
    expect(q.length).toBe(384);
    let maxAbs = 0;
    for (const x of v) maxAbs = Math.max(maxAbs, Math.abs(x));
    expect(scale).toBeCloseTo(maxAbs, 5);
    for (const x of q) {
      expect(x).toBeGreaterThanOrEqual(-127);
      expect(x).toBeLessThanOrEqual(127);
    }
  });

  test("max|v| → ровно 127", () => {
    const v = new Float32Array([0.25, -0.5, 1.0]);
    const { q, scale } = quantizeInt8(v);
    expect(scale).toBeCloseTo(1.0);
    expect(q[2]).toBe(127);
    // JS Math.round округляет -63.5 к -63 (к +∞); для косинуса это
    // отклонение одного компонента на 1/127 — не влияет на пороги.
    expect(q[1]).toBe(-63);
  });

  test("нулевой вектор не взрывается", () => {
    const { q, scale } = quantizeInt8(new Float32Array(8));
    expect(scale).toBe(1);
    for (const x of q) expect(x).toBe(0);
  });

  test("не-конечные компоненты отвергаются", () => {
    const bad = new Float32Array([1, Number.NaN]);
    expect(() => quantizeInt8(bad)).toThrow(QuantizeError);
    const inf = new Float32Array([Number.POSITIVE_INFINITY, 1]);
    expect(() => quantizeInt8(inf)).toThrow(QuantizeError);
  });

  test("пустой вектор отвергается", () => {
    expect(() => quantizeInt8(new Float32Array(0))).toThrow(QuantizeError);
  });

  test("roundtrip: косинус q·q / |q|² близок к 1 для unit-вектора", () => {
    for (const seed of [1, 42, 999]) {
      const v = unit(384, seed);
      const dq = dequantizeInt8(quantizeInt8(v));
      expect(cosineSimilarity(v, dq)).toBeGreaterThan(0.9999);
    }
  });
});
