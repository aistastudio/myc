/**
 * Квантизация int8 per-vector — та же, что ожидает векторная таблица:
 * `q = round(127 × v / max|v|)`, scale хранится рядом (§2.2
 * 02-retrieval-and-performance.md, приложение К 01a-ddl-validation.md:
 * вставка через `vec_int8(?)`, сырой BLOB vec0 трактует как float32).
 *
 * Векторы на входе считаются L2-нормализованными (после mean-pool/
 * CLS + нормализации), но квантизация корректна и для произвольных.
 */

export interface QuantizedVector {
  /** Целочисленные компоненты в диапазоне [-127, 127], длина = dim. */
  readonly q: Int8Array;
  /** scale = max|v| исходного вектора; 0-вектор даёт scale = 1. */
  readonly scale: number;
}

export class QuantizeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QuantizeError";
    this.code = code;
  }
}

function checkFinite(vec: Float32Array): void {
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    if (!Number.isFinite(v)) {
      throw new QuantizeError(
        "non_finite_input",
        `quantization aborted: component ${i} is not finite (${v})`,
      );
    }
  }
}

/** q = round(127 × v / max|v|); scale = max|v|. */
export function quantizeInt8(vec: Float32Array): QuantizedVector {
  if (vec.length === 0) {
    throw new QuantizeError("empty_vector", "quantization of an empty vector");
  }
  checkFinite(vec);
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]!);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs : 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let r = Math.round((127 * vec[i]!) / scale);
    if (r > 127) r = 127;
    else if (r < -127) r = -127;
    q[i] = r;
  }
  return { q, scale };
}

/** Обратное преобразование: v ≈ q × scale / 127. */
export function dequantizeInt8(qv: QuantizedVector): Float32Array {
  const out = new Float32Array(qv.q.length);
  const k = qv.scale / 127;
  for (let i = 0; i < qv.q.length; i++) out[i] = qv.q[i]! * k;
  return out;
}

/** Косинусное сходство; нулевые векторы дают 0. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {
    throw new QuantizeError("dim_mismatch", "cosine: dimensions do not match");
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** L2-нормализация на месте; нулевой вектор остаётся нулевым. */
export function normalizeInPlace(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  }
  return vec;
}
