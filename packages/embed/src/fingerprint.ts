import type { EmbedFingerprint, FingerprintCheck } from "./types.ts";

export type { EmbedFingerprint, FingerprintCheck } from "./types.ts";

/**
 * Отпечаток векторного пространства. Пишется в myc_meta; расхождение
 * с записанным — отказ писать (порчу индекса видно не сразу, а через
 * месяцы, поэтому молчаливое смешивание запрещено архитектурой).
 *
 * Каноническая форма: `backend:provider:model:dim:norm`
 *   local:onnx:bge-small-en-v1.5-q8:384:l2
 *   api:openai-compatible:text-embedding-3-small:1536:none
 */

export function formatEmbedFingerprint(fp: EmbedFingerprint): string {
  const norm = fp.normalize ? "l2" : "none";
  return `${fp.backend}:${fp.provider}:${fp.model}:${fp.dim}:${norm}`;
}

const PATTERN =
  /^(local|api):([a-z0-9-]+):([A-Za-z0-9._/-]+):(\d+):(l2|none)$/;

export function parseEmbedFingerprint(
  s: string,
): EmbedFingerprint | null {
  const m = PATTERN.exec(s);
  if (m === null) return null;
  return {
    backend: m[1] as EmbedFingerprint["backend"],
    provider: m[2]!,
    model: m[3]!,
    dim: Number(m[4]),
    normalize: m[5] === "l2",
  };
}

/**
 * Сверка записанного отпечатка с ожидаемым. Расхождение хоть по одному
 * полю — векторы несовместимы. dim сравнивается точно, normalize —
 * только вместе с совпадением модели (нормализация той же модели
 * меняет пространство не меньше, чем смена модели).
 */
export function checkFingerprint(
  recorded: string | EmbedFingerprint | null | undefined,
  expected: EmbedFingerprint,
): FingerprintCheck {
  if (recorded === null || recorded === undefined || recorded === "") {
    // Пустое поле — не расхождение: пространство ещё не зафиксировано.
    return { compatible: true };
  }
  const rec =
    typeof recorded === "string" ? parseEmbedFingerprint(recorded) : recorded;
  if (rec === null) {
    return {
      compatible: false,
      mismatch: `записанный отпечаток не разбирается: "${String(recorded)}"`,
    };
  }
  const recStr = formatEmbedFingerprint(rec);
  const expStr = formatEmbedFingerprint(expected);
  if (recStr === expStr) return { compatible: true };

  const fields: string[] = [];
  if (rec.backend !== expected.backend) fields.push("backend");
  if (rec.provider !== expected.provider) fields.push("provider");
  if (rec.model !== expected.model) fields.push("model");
  if (rec.dim !== expected.dim) fields.push(`dim (${rec.dim} ≠ ${expected.dim})`);
  if (rec.normalize !== expected.normalize) fields.push("normalize");
  return {
    compatible: false,
    mismatch: `отпечаток в myc_meta "${recStr}" не совпадает с текущим "${expStr}" (поля: ${fields.join(", ")}). Смешивать векторные пространства нельзя; требуется reembed.`,
  };
}

export class FingerprintMismatchError extends Error {
  readonly code = "embed.fingerprint_mismatch";
  readonly check: FingerprintCheck;
  constructor(check: FingerprintCheck) {
    super(check.mismatch ?? "fingerprint mismatch");
    this.name = "FingerprintMismatchError";
    this.check = check;
  }
}

/**
 * Для места записи (индексер, myc-ard): бросает, если записанный
 * отпечаток несовместим. Совместимость с пустым полем — ок.
 */
export function ensureFingerprintCompatible(
  recorded: string | EmbedFingerprint | null | undefined,
  expected: EmbedFingerprint,
): void {
  const check = checkFingerprint(recorded, expected);
  if (!check.compatible) throw new FingerprintMismatchError(check);
}
