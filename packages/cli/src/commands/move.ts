/**
 * `myc move <id> --to <каталог>` — переезд задачи между воркспейсами (R4).
 *
 * Перенос ИДЕНТИЧНОСТИ, а не копия: id, op_id и вся история те же. Механика
 * и обоснование фаз — в packages/store-sqlite/src/move.ts; здесь только
 * поверхность: открыть две базы, показать план, применить, объяснить отказ.
 *
 * Почему две базы открываются В ОДНОМ процессе. Переезд — единственная
 * операция, которой нужны обе стороны сразу, и разнести её на два вызова
 * («экспортируй там, импортируй тут») значит отдать пользователю ту самую
 * последовательность фаз, порядок которой и есть всё содержание задачи.
 *
 * `--dry-run` печатает план и не пишет ничего: набор переезда может
 * оказаться много больше названного узла (цепочка версий, а с
 * `--with-blockers` — и связный кусок по blocks), и увидеть это нужно ДО.
 */

import { resolve } from "node:path";
import {
  executeMove,
  planMove,
  strandedArrivals,
  type MovePlan,
  type MoveRefusal,
  type MoveResult,
} from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import {
  flagBool,
  flagStr,
  openWorkspaceByDir,
  realStoreDeps,
  resolveId,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

interface MoveData {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly to_dir: string;
  readonly dry_run: boolean;
  readonly members: readonly string[];
  readonly edges: readonly string[];
  readonly staying: readonly string[];
  readonly expanded: boolean;
  readonly ops: number;
  readonly applied?: number;
  readonly duplicate?: number;
  readonly minted?: number;
  readonly resumed?: boolean;
  readonly took_ms: number;
}

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

function refusalToFailure(r: MoveRefusal): CommandFailure {
  if (r.code === "notfound") return failure("notfound.node", r.msg, ExitCode.NOTFOUND);
  if (r.code === "same_workspace") return failure("usage.same_workspace", r.msg, ExitCode.USAGE);
  if (r.code === "chain_truncated") {
    return failure("precond.chain_truncated", r.msg, ExitCode.PRECOND);
  }
  if (r.code === "cross_boundary_parent") {
    return failure(
      "precond.cross_boundary_parent",
      r.msg,
      ExitCode.PRECOND,
      "снимите блокер с эпика, или увезите поддерево целиком, или снимите ребро parent",
    );
  }
  if (r.code === "leased") {
    return failure("precond.leased", r.msg, ExitCode.PRECOND, "дождитесь конца аренды или myc release");
  }
  const list = r.crossing.slice(0, 5).map((e) => `${e.src} blocks ${e.dst}`).join("; ");
  return failure(
    "precond.cross_boundary",
    `${r.msg}: ${list}${r.crossing.length > 5 ? "…" : ""}`,
    ExitCode.PRECOND,
    "--with-blockers увезёт связный кусок целиком, --dry-run покажет его размер",
  );
}

function renderMoveHuman(raw: unknown): string {
  const d = raw as MoveData;
  const lines: string[] = [];
  const head = d.dry_run ? "dry-run: " : "";
  lines.push(
    `${head}${d.id}: ${d.from === "" ? "(без слага)" : d.from} → ${d.to === "" ? "(без слага)" : d.to} (${d.to_dir})`,
  );
  lines.push(
    `  едет ${d.members.length} узлов, ${d.edges.length} рёбер, ${d.ops} операций истории` +
      (d.expanded ? " (набор расширен по blocks)" : ""),
  );
  if (d.members.length > 1) lines.push(`  узлы: ${d.members.join(", ")}`);
  if (d.staying.length > 0) {
    lines.push(
      `  остаётся в источнике ${d.staying.length} рёбер: второй конец не едет, их держит надгробие`,
    );
  }
  if (!d.dry_run) {
    lines.push(
      `  применено ${d.applied ?? 0}, повторов ${d.duplicate ?? 0}, отчеканено переездов ${d.minted ?? 0}` +
        (d.resumed === true ? " (доигран прерванный переезд)" : ""),
    );
  }
  lines.push(`готово за ${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

export function createMoveCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "move",
    summary: "move a task to another workspace, keeping its identity and oplog",
    flags: [
      { name: "to", value: "string", description: "target workspace directory" },
      { name: "dry-run", description: "print the move set, change nothing" },
      {
        name: "with-blockers",
        description: "also move every task connected by live blocks edges",
      },
      { name: "pending", description: "list arrivals whose move never finished here" },
    ],
    help:
      "The node keeps its id and its whole oplog: operations are copied verbatim (same op_id, " +
      "site_id and hlc), so a second run is a no-op and a third party replicating both " +
      "workspaces converges through ordinary per-field LWW. The move itself is two plain set " +
      "operations — scope and attrs.moved_from — and no new operation kind. The source keeps a " +
      "tombstone row: edges that stayed behind still point at it, and hard deletion would " +
      "cascade them away silently. Refuses while a live blocks edge would cross the boundary " +
      "(open_blockers is materialised by triggers inside one database), while the node would " +
      "leave a blocked ancestor behind (anc_blockers is materialised the same way), or while " +
      "the node is under a live lease (leases do not replicate).",
    handler: async (ctx) => {
      const t0 = performance.now();
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const source: StoreHandle = opened.handle;
      let target: StoreHandle | undefined;
      try {
        if (flagBool(ctx, "pending")) {
          const stranded = strandedArrivals(source.driver, source.scope);
          return {
            ok: true,
            data: {
              scope: source.scope,
              stranded,
              took_ms: Math.round(performance.now() - t0),
            },
          };
        }

        const id = ctx.args[0];
        if (id === undefined) {
          return failure("usage.id", "нужен id задачи: myc move <id> --to <каталог>", ExitCode.USAGE);
        }
        const toDir = flagStr(ctx, "to");
        if (toDir === undefined) {
          return failure("usage.to", "нужен каталог приёмника: --to <каталог>", ExitCode.USAGE);
        }
        const resolved = resolveId(source, id);
        if (!resolved.ok) return resolved.failure;

        const openedTarget = await openWorkspaceByDir(resolve(toDir), source.actor);
        if (!openedTarget.ok) return openedTarget.failure;
        target = openedTarget.handle;

        const plan = planMove(source, resolved.node.id, source.scope, target.scope, {
          withBlockers: flagBool(ctx, "with-blockers"),
        });
        if (!plan.ok) return refusalToFailure(plan);

        const dryRun = flagBool(ctx, "dry-run");
        const base = {
          id: resolved.node.id,
          from: plan.from,
          to: plan.to,
          to_dir: target.wsDir,
          dry_run: dryRun,
          members: plan.members,
          edges: plan.edges,
          staying: plan.staying,
          expanded: plan.expanded,
        };
        if (dryRun) {
          return {
            ok: true,
            data: {
              ...base,
              ops: plan.ops.length,
              took_ms: Math.round(performance.now() - t0),
            } satisfies MoveData,
          };
        }

        let result: MoveResult;
        try {
          result = executeMove(source, target, plan as MovePlan);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return failure("precond.move_ingest", msg, ExitCode.PRECOND, "myc move ... повторно доиграет");
        }
        if (result.staying.length > 0) {
          ctx.warn(
            "move.edges_stayed",
            `${result.staying.length} рёбер осталось в источнике: второй конец не переехал`,
          );
        }
        return {
          ok: true,
          data: {
            ...base,
            ops: result.ops,
            applied: result.applied,
            duplicate: result.duplicate,
            minted: result.minted,
            resumed: result.resumed,
            took_ms: Math.round(performance.now() - t0),
          } satisfies MoveData,
        };
      } finally {
        target?.close();
        source.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as { stranded?: unknown };
      if (Array.isArray(d.stranded)) {
        const rows = d.stranded as Array<{ id: string; scope: string }>;
        if (rows.length === 0) return "недоигранных переездов нет\n";
        return `${rows.map((r) => `${r.id}  приехал со scope '${r.scope}' — переезд не доигран`).join("\n")}\n`;
      }
      return renderMoveHuman(raw);
    },
  };
}
