/**
 * Воркер конкурентного прогона записи под ОДНИМ site_id (myc-4dy).
 *
 * Запускается отдельным ПРОЦЕССОМ (Bun.spawn): так живут CLI и долгоживущий
 * MCP-сервер одного воркспейса — они делят site_id из myc_meta, но держат
 * свои часы и свой seq в памяти. Воркер пишет пачку операций в общую базу и
 * печатает на stdout одну JSON-строку:
 *   { worker, ops, errors: string[], collisions: number }
 *
 * Каждая операция ровно одна строка оплога (updateNode одного поля с новым
 * значением, addEdge нового ребра, bumpCounter), поэтому тест сверяет
 * количество строк оплога с числом операций поштучно.
 *
 * Режимы:
 *   --mutant none     — боевой путь GraphStore;
 *   --mutant swallow  — мутант для мутационной проверки: op_id и hlc выдаются
 *                       вне блокировки записи (syncTail отключён), а
 *                       ON CONFLICT DO NOTHING снова молчит — так код жил до
 *                       myc-4dy. Детектор обязан увидеть проглоченные строки.
 */

import { existsSync } from "node:fs";
import { generateId } from "@myc/core";
import { openSqlite } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";

interface Args {
  db: string;
  site: string;
  worker: string;
  /** Узел, которым владеет воркер: цель updateNode/bumpCounter и src рёбер. */
  own: string;
  /** Узлы-цели рёбер, через запятую. */
  targets: string[];
  ops: number;
  /** Файл-барьер: писать только после его появления. */
  go: string | undefined;
  /** Пауза между операциями, мс (долгоживущий процесс «дышит»). */
  pauseMs: number;
  mutant: "none" | "swallow";
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const db = get("db");
  const own = get("own");
  if (db === undefined || own === undefined) throw new Error("--db and --own are required");
  return {
    db,
    site: get("site") ?? "siteA",
    worker: get("worker") ?? "w",
    own,
    targets: (get("targets") ?? "").split(",").filter((t) => t.length > 0),
    ops: Number(get("ops") ?? 200),
    go: get("go"),
    pauseMs: Number(get("pause-ms") ?? 0),
    mutant: (get("mutant") ?? "none") as "none" | "swallow",
  };
}

const args = parseArgs(Bun.argv.slice(2));
const driver = openSqlite(args.db);
await migrate(driver.database, { migrations, writable: true });
const store = new GraphStore(driver, {
  siteId: args.site,
  actor: args.worker,
  newId: () => generateId(),
});

if (args.mutant === "swallow") {
  // Код до myc-4dy: seq и часы живут только в памяти процесса, второй
  // одинаковый op_id тихо отбрасывается как «уже применённый», ничья по
  // (hlc, site_id) неотличима от обычного проигрыша LWW.
  const raw = store as unknown as Record<string, unknown>;
  raw["syncTail"] = () => {};
  const journal = raw["journal"] as (...a: unknown[]) => boolean;
  raw["journalLocal"] = function (this: unknown, ...a: unknown[]): void {
    journal.apply(this, [...a, 1]);
  };
  const projectSet = raw["projectSet"] as (...a: unknown[]) => string;
  raw["projectSet"] = function (this: unknown, ...a: unknown[]): string {
    const out = projectSet.apply(this, a);
    return out === "collided" ? "stale" : out;
  };
}

if (args.go !== undefined) {
  while (!existsSync(args.go)) Bun.sleepSync(1);
}

const errors: string[] = [];
let collisions = 0;
let done = 0;
for (let k = 0; k < args.ops; k++) {
  try {
    const step = k % 4;
    if (step === 0 || step === 2) {
      store.updateNode(args.own, { title: `${args.worker}-${k}` });
    } else if (step === 1) {
      store.bumpCounter(args.own, "seen_count", 1);
    } else {
      const target = args.targets[Math.floor(k / 4) % args.targets.length];
      if (target === undefined) throw new Error("no target nodes for edges");
      // Повторное добавление живого ребра — новая строка оплога (edge_add
      // журналируется всегда), строка edges при этом обновляется.
      store.addEdge(args.own, "relates", target, { attrs: { k } });
    }
    done++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("clock_collision") || message.includes("is already taken") || message.includes("already in the oplog")) {
      collisions++;
    }
    errors.push(`${args.worker}#${k}: ${message}`);
  }
  if (args.pauseMs > 0) Bun.sleepSync(args.pauseMs);
}

driver.close();
console.log(
  JSON.stringify({ worker: args.worker, ops: done, errors, collisions }),
);
