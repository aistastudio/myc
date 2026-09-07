/**
 * Точка входа воркера батч-пула Bun Worker. Живёт со своей ONNX-сессией
 * (intra_op = 1), делает только батчи из embed_queue. Протокол:
 *   → { type: "init", core: CoreConfig }
 *   ← { type: "ready" } | { type: "error", reason }
 *   → { type: "embed", id, texts, role }
 *   ← { type: "result", id, vectors, reasons, ms }
 *   → { type: "destroy" }
 *   ← { type: "destroyed" }
 */

import {
  embedManyInSession,
  loadCore,
  type CoreConfig,
  type LoadedCore,
} from "./core.ts";
import type { EmbedRole } from "./types.ts";

type WorkerIncoming =
  | { type: "init"; core: CoreConfig }
  | { type: "embed"; id: number; texts: readonly string[]; role: EmbedRole }
  | { type: "destroy" };

/** Глобальный скоуп Bun-воркера. */
const scope = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: MessageEvent<WorkerIncoming>) => void) | null;
};

let core: LoadedCore | null = null;

async function init(msg: Extract<WorkerIncoming, { type: "init" }>): Promise<void> {
  core = await loadCore({ ...msg.core, intraOpThreads: 1 });
}

scope.onmessage = async (event: MessageEvent<WorkerIncoming>) => {
  const msg = event.data;
  if (msg.type === "init") {
    try {
      await init(msg);
      scope.postMessage({ type: "ready" });
    } catch {
      scope.postMessage({ type: "error", reason: "load_error" });
    }
    return;
  }
  if (msg.type === "embed") {
    if (core === null) {
      scope.postMessage({
        type: "result",
        id: msg.id,
        vectors: msg.texts.map(() => null),
        reasons: msg.texts.map(() => "load_error"),
        ms: 0,
      });
      return;
    }
    const outcome = await embedManyInSession(core, msg.texts, msg.role);
    scope.postMessage({
      type: "result",
      id: msg.id,
      vectors: outcome.vectors,
      reasons: outcome.reasons,
      ms: outcome.ms,
    });
    return;
  }
  if (msg.type === "destroy") {
    core?.loaded.session.release().catch(() => {});
    core = null;
    scope.postMessage({ type: "destroyed" });
  }
};
