import type { Diagnostics } from "./diagnostics.ts";

export type EnvelopeError = {
  code: string;
  msg: string;
  exit: number;
  hint?: string;
};

/**
 * Конверт --json: ровно один объект на вызов (по объекту на строку в --ndjson).
 * meta.degraded[] — громкая деградация; warn[] — её же детали.
 */
export type Envelope = {
  ok: boolean;
  cmd: string;
  data: unknown;
  meta: { degraded: string[] } & Record<string, unknown>;
  warn: { code: string; msg: string }[];
  error?: EnvelopeError;
};

export function okEnvelope(
  cmd: string,
  data: unknown,
  meta: Record<string, unknown> | undefined,
  diags: Diagnostics,
): Envelope {
  return {
    ok: true,
    cmd,
    data,
    // degraded всегда выигрывает: команда не может его затереть
    meta: { ...meta, degraded: diags.codes },
    warn: [...diags.items],
  };
}

export function errorEnvelope(
  cmd: string,
  error: EnvelopeError,
  diags: Diagnostics,
): Envelope {
  return {
    ok: false,
    cmd,
    data: null,
    meta: { degraded: diags.codes },
    warn: [...diags.items],
    error,
  };
}

/** Компактная строка: конверт читает модель, пробелы — потери токенов. */
export function envelopeLine(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}
