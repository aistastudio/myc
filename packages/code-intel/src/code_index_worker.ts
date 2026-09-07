/**
 * Воркер пула разбора для code_index (см. ./code_index.ts).
 *
 * Пул заводится только на большом батче (≥ PARSE_POOL_MIN_FILES работ):
 * полный индекс репозитория — это сотни миллисекунд чистого listDefs, и они
 * честно делятся по ядрам. Пул живёт внутри одного drainCodeIndex и гаснет
 * вместе с ним — это НЕ демон (решение S8), постоянного процесса нет.
 */

import { listDefs, type Def, type LangId } from "./defs.ts";

interface ParseRequest {
  readonly id: number;
  readonly source: string;
  readonly lang: LangId;
}

interface ParseReply {
  readonly id: number;
  readonly defs?: Def[];
  readonly error?: string;
}

// bun-types в этой конфигурации не объявляет self; в воркере Bun это тот же
// globalThis с onmessage/postMessage.
const ctx = globalThis as unknown as {
  onmessage: ((e: MessageEvent<ParseRequest>) => void) | null;
  postMessage: (msg: ParseReply) => void;
};

ctx.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, source, lang } = e.data;
  try {
    ctx.postMessage({ id, defs: listDefs(source, lang) });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
