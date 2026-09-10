/**
 * `myc list` — выборка узлов (§3.15). Плотные строки «одна сущность — одна
 * строка», футер «N из M · T мс», --count отдаёт голое число.
 */

import type { NodeKind, NodeRecord } from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { Command, CommandFailure } from "../registry.ts";
import {
  flagNum,
  flagStr,
  fmtPriority,
  parseDuration,
  parsePriority,
  tagsOf,
  type StoreDeps,
  realStoreDeps,
} from "./store.ts";
import { nodeType } from "./tasks.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

/** CLI-имя kind'а → core kind (+ опционально attrs.type для задач). */
const KIND_FILTER: Readonly<Record<string, { kind: NodeKind; type?: string }>> = {
  task: { kind: "task", type: "task" },
  bug: { kind: "task", type: "bug" },
  epic: { kind: "task", type: "epic" },
  chore: { kind: "task", type: "chore" },
  memory: { kind: "note" },
  note: { kind: "note" },
  decision: { kind: "note", type: "decision" },
  document: { kind: "doc" },
  doc: { kind: "doc" },
  fragment: { kind: "fragment" },
  session: { kind: "session" },
  message: { kind: "message" },
  entity: { kind: "entity" },
  anchor: { kind: "anchor" },
  skill: { kind: "skill" },
};

const ALL_KINDS: readonly NodeKind[] = [
  "task",
  "note",
  "doc",
  "fragment",
  "session",
  "message",
  "entity",
  "anchor",
  "skill",
];

const FETCH_PER_KIND = 1000;

interface ListRow {
  id: string;
  priority: number;
  kind: string;
  type: string;
  status: string;
  assignee: string;
  title: string;
  updated_at: number;
  created_at: number;
  tags: string[];
}

interface ListData {
  rows: ListRow[];
  shown: number;
  total: number;
  truncated: boolean;
  took_ms: number;
}

function rowOf(n: NodeRecord): ListRow {
  return {
    id: n.id,
    priority: n.priority,
    kind: n.kind,
    type: nodeType(n),
    status: n.status,
    assignee: n.assignee,
    title: n.title,
    updated_at: n.updated_at,
    created_at: n.created_at,
    tags: tagsOf(n),
  };
}

function renderListHuman(raw: unknown): string {
  if (typeof raw === "number") return `${raw}\n`;
  const d = raw as ListData;
  const lines: string[] = [];
  const widths = [0, 0, 0, 0, 0];
  const cells = d.rows.map((r) => {
    const assignee = r.assignee.length > 0 ? `@${r.assignee}` : "free";
    const pri = r.kind === "task" ? fmtPriority(r.priority) : "";
    const row = [r.id, pri, r.type, r.status, assignee, r.title].filter((_, i) => i !== 1 || pri !== "");
    return row;
  });
  for (const row of cells) {
    row.forEach((c, i) => {
      if (i < widths.length) widths[i] = Math.max(widths[i]!, c.length);
    });
  }
  for (const row of cells) {
    lines.push(
      row
        .map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] ?? c.length)))
        .join("  ")
        .trimEnd(),
    );
  }
  lines.push(`${d.shown} of ${d.total} · ${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

type SortKey = "priority" | "updated" | "created" | "status";

function sortRows(rows: ListRow[], key: SortKey): void {
  switch (key) {
    case "priority":
      rows.sort((a, b) => a.priority - b.priority || a.updated_at - b.updated_at || a.id.localeCompare(b.id));
      break;
    case "created":
      rows.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      break;
    case "status":
      rows.sort((a, b) => a.status.localeCompare(b.status) || a.priority - b.priority || a.id.localeCompare(b.id));
      break;
    default:
      rows.sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  }
}

export function createListCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "list",
    summary: "list nodes with filters",
    flags: [
      { name: "kind", value: "string", description: "comma-separated kinds (task,bug,epic,memory,…)" },
      { name: "status", value: "string", description: "comma-separated statuses" },
      { name: "priority", value: "string", description: "P0|P1|P2|P3 or 0|1|2|3 (comma ok)" },
      { name: "tag", value: "string", description: "must carry this tag" },
      { name: "assignee", value: "string", description: "assignee, or 'free'" },
      { name: "acl", value: "string", description: "acl mode" },
      { name: "since", value: "string", description: "updated after: ISO date or age (2d, 6h)" },
      { name: "until", value: "string", description: "updated before: ISO date or age" },
      { name: "sort", value: "string", description: "priority|updated|created|status (default updated)" },
      { name: "fields", value: "string", description: "comma-separated columns (json/ndjson shape)" },
      { name: "n", short: "n", value: "number", description: "limit (default 20)" },
      { name: "offset", value: "number", description: "skip first N rows" },
      { name: "count", description: "print only the count" },
    ],
    handler: async (ctx) => {
      const t0 = performance.now();

      const kindNames = flagStr(ctx, "kind")
        ?.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (kindNames !== undefined) {
        const unknown = kindNames.filter((k) => !(k in KIND_FILTER));
        if (unknown.length > 0) {
          return failure(
            "usage.invalid",
            `unknown --kind '${unknown.join(",")}'; allowed: ${Object.keys(KIND_FILTER).join(", ")}`,
            ExitCode.USAGE,
          );
        }
      }

      const priorities: number[] = [];
      const pRaw = flagStr(ctx, "priority");
      if (pRaw !== undefined) {
        for (const p of pRaw.split(",")) {
          const parsed = parsePriority(p);
          if (parsed === undefined) {
            return failure("usage.invalid", `invalid priority '${p}'; allowed: P0..P3 or 0..3`, ExitCode.USAGE);
          }
          priorities.push(parsed);
        }
      }

      const sortRaw = flagStr(ctx, "sort") ?? "updated";
      if (!["priority", "updated", "created", "status"].includes(sortRaw)) {
        return failure("usage.invalid", `invalid --sort '${sortRaw}'`, ExitCode.USAGE);
      }

      const parseBound = (raw: string, isSince: boolean): number | undefined => {
        const dur = parseDuration(raw);
        if (dur !== undefined) return isSince ? Date.now() - dur : Date.now() - dur;
        const ts = Date.parse(raw);
        return Number.isNaN(ts) ? undefined : ts;
      };
      let since: number | undefined;
      let until: number | undefined;
      const sinceRaw = flagStr(ctx, "since");
      if (sinceRaw !== undefined) {
        since = parseBound(sinceRaw, true);
        if (since === undefined) return failure("usage.invalid", `invalid --since '${sinceRaw}'`, ExitCode.USAGE);
      }
      const untilRaw = flagStr(ctx, "until");
      if (untilRaw !== undefined) {
        until = parseBound(untilRaw, false);
        if (until === undefined) return failure("usage.invalid", `invalid --until '${untilRaw}'`, ExitCode.USAGE);
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const wanted = kindNames ?? ALL_KINDS;
        const coreKinds = new Set<NodeKind>();
        const typeWanted = new Map<NodeKind, Set<string>>();
        for (const name of wanted) {
          const spec = KIND_FILTER[name]!;
          coreKinds.add(spec.kind);
          if (spec.type !== undefined) {
            const set = typeWanted.get(spec.kind) ?? new Set<string>();
            set.add(spec.type);
            typeWanted.set(spec.kind, set);
          }
        }
        // kind=task без уточнения type не должен отсекать другие type того же kind
        const typeFilterActive = wanted.every((w) => KIND_FILTER[w]!.type !== undefined);

        const statuses = flagStr(ctx, "status")
          ?.split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const tag = flagStr(ctx, "tag");
        const assignee = flagStr(ctx, "assignee");
        const acl = flagStr(ctx, "acl");

        const matched: NodeRecord[] = [];
        let truncated = false;
        for (const kind of coreKinds) {
          const batch = h.store.listNodes(h.scope, kind, FETCH_PER_KIND + 1);
          if (batch.length > FETCH_PER_KIND) truncated = true;
          for (const n of batch.slice(0, FETCH_PER_KIND)) {
            if (typeFilterActive) {
              const types = typeWanted.get(n.kind);
              if (types !== undefined && !types.has(nodeType(n))) continue;
            }
            if (statuses !== undefined && !statuses.includes(n.status)) continue;
            if (priorities.length > 0 && !priorities.includes(n.priority)) continue;
            if (tag !== undefined && !tagsOf(n).includes(tag)) continue;
            if (assignee !== undefined) {
              if (assignee === "free") {
                if (n.assignee.length > 0) continue;
              } else if (n.assignee !== assignee) continue;
            }
            if (acl !== undefined && n.acl !== acl) continue;
            if (since !== undefined && n.updated_at < since) continue;
            if (until !== undefined && n.updated_at > until) continue;
            matched.push(n);
          }
        }

        if (truncated) {
          ctx.warn("list.truncated", `results cut to ${FETCH_PER_KIND} nodes per kind; narrow the filters`);
        }

        let rows = matched.map(rowOf);
        sortRows(rows, sortRaw as SortKey);
        const total = rows.length;

        if (ctx.flags["count"] === true) {
          return {
            ok: true,
            data: total,
            meta: { took_ms: Math.round(performance.now() - t0), count: total },
          };
        }

        const limit = flagNum(ctx, "n") ?? 20;
        const offset = flagNum(ctx, "offset") ?? 0;
        rows = rows.slice(offset, offset + limit);

        const data: ListData = {
          rows,
          shown: rows.length,
          total,
          truncated,
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms, count: rows.length } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderListHuman,
  };
}
