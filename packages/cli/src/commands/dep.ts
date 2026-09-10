/**
 * `myc dep` — зависимости задач (§3.7): add/rm/tree/why.
 *
 * Детект циклов живёт в движке (`store.addEdge` → `checkEdgeAcyclic`, §4.3):
 * `dep add` — не единственная дверь к ребру `blocks` (есть `myc task
 * --blocked-by`, MCP, `import-beads`), и проверка на уровне одной команды
 * закрывала только её. Здесь остаётся перевод отказа в контракт §3.7: цикл —
 * это exit 4 (conflict), а не 5 (precond), и сообщение движка уже называет
 * путь целиком.
 */

import { ExitCode } from "../exit.ts";
import type { Command, CommandFailure } from "../registry.ts";
import {
  estimateMin,
  flagNum,
  fmtAge,
  fmtDate,
  fmtEstimate,
  fmtPriority,
  graphFailure,
  resolveId,
  type StoreDeps,
  type StoreHandle,
  realStoreDeps,
} from "./store.ts";
import { nodeType } from "./tasks.ts";
import { ClosureError, MAX_BLOCKS_DEPTH } from "@myc/store-sqlite";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

const CLOSED_STATUSES = new Set(["closed", "cancelled", "superseded", "retracted"]);
/** Предел обхода `blocks` — тот же, что у движковой проверки цикла (§11). */
const MAX_DEPTH = MAX_BLOCKS_DEPTH;

/**
 * Перевод отказа движка в контракт §3.7: цикл — exit 4 (conflict), потому что
 * это столкновение с чужим фактом, а не нарушенное предусловие вызова. Отказ
 * по глубине (`closure.depth`) остаётся precond: он говорит «не проверено»,
 * а не «цикл», и путать их — терять новость (И2).
 */
function edgeFailure(e: unknown): CommandFailure {
  if (e instanceof ClosureError && e.code === "closure.cycle") {
    return failure("conflict.dep_cycle", `dependency cycle: ${e.message}`, ExitCode.CONFLICT);
  }
  return graphFailure(e);
}

/** Разложить <from> <type> <to> в (src blocks dst); type: blocks | blocked-by. */
function edgeEnds(
  type: string,
  from: string,
  to: string,
): { src: string; dst: string } | undefined {
  if (type === "blocks") return { src: from, dst: to };
  if (type === "blocked-by") return { src: to, dst: from };
  return undefined;
}

// ---------------------------------------------------------------------------
// dep add / dep rm
// ---------------------------------------------------------------------------

interface DepEdgeData {
  src: string;
  dst: string;
  type: string;
  from_label: string;
  removed?: boolean;
  left_ready?: boolean;
  left_ready_id?: string;
  back_ready?: boolean;
  back_ready_id?: string;
  took_ms: number;
}

function renderDepEdgeHuman(raw: unknown): string {
  const d = raw as DepEdgeData;
  if (d.removed === true) {
    const tail = d.back_ready === true ? `  (${d.back_ready_id} ready again)` : "";
    return `${d.type} ${d.src} → ${d.dst} removed${tail}\n${d.took_ms} ms\n`;
  }
  const tail = d.left_ready === true ? `  (${d.left_ready_id} left ready)` : "";
  return `${d.from_label} ${d.type === "blocks" ? "blocks" : "blocked-by"} ${d.type === "blocks" ? d.dst : d.src}${tail}\n${d.took_ms} ms\n`;
}

function buildDepAdd(deps: StoreDeps): Command {
  return {
    name: "add",
    summary: "add a dependency: dep add <from> <blocks|blocked-by> <to>",
    handler: async (ctx) => {
      const t0 = performance.now();
      const [fromInput, type, toInput] = ctx.args;
      if (fromInput === undefined || type === undefined || toInput === undefined) {
        return failure("usage.invalid", "usage: myc dep add <from> <blocks|blocked-by> <to>", ExitCode.USAGE);
      }
      const ends = edgeEnds(type, fromInput, toInput);
      if (ends === undefined) {
        return failure("usage.invalid", `invalid type '${type}'; allowed: blocks, blocked-by`, ExitCode.USAGE);
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const from = resolveId(h, fromInput);
        if (!from.ok) return from.failure;
        const to = resolveId(h, toInput);
        if (!to.ok) return to.failure;
        const src = type === "blocks" ? from.node : to.node;
        const dst = type === "blocks" ? to.node : from.node;

        if (src.id === dst.id) {
          return failure("conflict.dep_cycle", `dependency cycle: ${src.id} → ${src.id}`, ExitCode.CONFLICT);
        }
        if (h.store.getEdge(src.id, "blocks", dst.id) !== undefined) {
          return failure(
            "conflict.dep_exists",
            `edge ${src.id} blocks ${dst.id} already exists`,
            ExitCode.CONFLICT,
          );
        }
        try {
          h.store.addEdge(src.id, "blocks", dst.id);
        } catch (e) {
          return edgeFailure(e);
        }

        const after = h.store.getNode(dst.id)!;
        const leftReady = after.open_blockers > 0 && !CLOSED_STATUSES.has(after.status);
        const data: DepEdgeData = {
          src: src.id,
          dst: dst.id,
          type,
          from_label: from.node.id,
          ...(leftReady ? { left_ready: true, left_ready_id: dst.id } : {}),
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderDepEdgeHuman,
  };
}

function buildDepRm(deps: StoreDeps): Command {
  return {
    name: "rm",
    summary: "remove a dependency: dep rm <from> <blocks|blocked-by> <to>",
    handler: async (ctx) => {
      const t0 = performance.now();
      const [fromInput, type, toInput] = ctx.args;
      if (fromInput === undefined || type === undefined || toInput === undefined) {
        return failure("usage.invalid", "usage: myc dep rm <from> <blocks|blocked-by> <to>", ExitCode.USAGE);
      }
      const ends = edgeEnds(type, fromInput, toInput);
      if (ends === undefined) {
        return failure("usage.invalid", `invalid type '${type}'; allowed: blocks, blocked-by`, ExitCode.USAGE);
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const from = resolveId(h, fromInput);
        if (!from.ok) return from.failure;
        const to = resolveId(h, toInput);
        if (!to.ok) return to.failure;
        const src = type === "blocks" ? from.node : to.node;
        const dst = type === "blocks" ? to.node : from.node;

        try {
          if (!h.store.removeEdge(src.id, "blocks", dst.id)) {
            return failure("notfound.edge", `no edge ${src.id} blocks ${dst.id}`, ExitCode.NOTFOUND);
          }
        } catch (e) {
          return graphFailure(e);
        }

        const after = h.store.getNode(dst.id)!;
        // anc_blockers входит в условие: снятие своего блокера не вернёт в
        // очередь задачу, у которой блокер остался на эпике (миграция 10).
        const backReady =
          after.open_blockers === 0 && after.anc_blockers === 0 && after.status === "open";
        const data: DepEdgeData = {
          src: from.node.id,
          dst: to.node.id,
          type,
          from_label: from.node.id,
          removed: true,
          ...(backReady ? { back_ready: true, back_ready_id: dst.id } : {}),
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderDepEdgeHuman,
  };
}

// ---------------------------------------------------------------------------
// dep tree
// ---------------------------------------------------------------------------

interface TreeNode {
  id: string;
  priority: number;
  kind: string;
  status: string;
  title: string;
  children: TreeNode[];
}

interface DepTreeData {
  root: TreeNode;
  blocked_count: number;
  took_ms: number;
}

function buildTree(h: StoreHandle, id: string, depth: number, withClosed: boolean, seen: Set<string>): TreeNode | undefined {
  const node = h.store.getNode(id);
  if (node === undefined) return undefined;
  if (!withClosed && CLOSED_STATUSES.has(node.status)) return undefined;
  const tree: TreeNode = {
    id: node.id,
    priority: node.priority,
    kind: node.kind,
    status: node.status,
    title: node.title,
    children: [],
  };
  if (depth <= 0 || seen.has(id)) return tree;
  seen.add(id);
  for (const e of h.store.edgesFrom(id, "blocks")) {
    const child = buildTree(h, e.dst, depth - 1, withClosed, seen);
    if (child !== undefined) tree.children.push(child);
  }
  seen.delete(id);
  return tree;
}

function countTree(t: TreeNode): number {
  return t.children.reduce((acc, c) => acc + 1 + countTree(c), 0);
}

function renderTreeLines(t: TreeNode, prefix: string, isRoot: boolean, lines: string[]): void {
  const label = `${t.id} ${t.kind === "task" ? `${fmtPriority(t.priority)} ` : ""}${t.status}  ${t.title}`;
  if (isRoot) {
    lines.push(label);
  }
  t.children.forEach((c, i) => {
    const last = i === t.children.length - 1;
    const branch = last ? "└── " : "├── ";
    lines.push(`${prefix}${branch}blocks ${c.id} ${c.kind === "task" ? `${fmtPriority(c.priority)} ` : ""}${c.status}  ${c.title}`);
    renderTreeChildren(c, prefix + (last ? "    " : "│   "), lines);
  });
}

function renderTreeChildren(t: TreeNode, prefix: string, lines: string[]): void {
  t.children.forEach((c, i) => {
    const last = i === t.children.length - 1;
    const branch = last ? "└── " : "├── ";
    lines.push(`${prefix}${branch}blocks ${c.id} ${c.kind === "task" ? `${fmtPriority(c.priority)} ` : ""}${c.status}  ${c.title}`);
    renderTreeChildren(c, prefix + (last ? "    " : "│   "), lines);
  });
}

function renderDepTreeHuman(raw: unknown): string {
  const d = raw as DepTreeData;
  const lines: string[] = [];
  renderTreeLines(d.root, "", true, lines);
  if (d.blocked_count > 0) {
    lines.push(`${plural(d.blocked_count, "node", "nodes")} blocked by this task`);
  } else {
    lines.push("blocks nothing");
  }
  return `${lines.join("\n")}\n`;
}

function buildDepTree(deps: StoreDeps): Command {
  return {
    name: "tree",
    summary: "who is blocked by this node: dep tree <id> [--depth n] [--closed]",
    flags: [
      { name: "depth", value: "number", description: "levels below root (default 4)" },
      { name: "closed", description: "include closed nodes" },
    ],
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return failure("usage.invalid", "usage: myc dep tree <id>", ExitCode.USAGE);
      }
      const depth = flagNum(ctx, "depth") ?? 4;
      if (depth < 1 || depth > MAX_DEPTH) {
        return failure("usage.invalid", `--depth out of range 1..${MAX_DEPTH}`, ExitCode.USAGE);
      }
      const withClosed = ctx.flags["closed"] === true;

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const root = buildTree(h, resolved.node.id, depth, withClosed, new Set());
        if (root === undefined) {
          return failure("precond.closed", `${resolved.node.id} is closed; to show it: --closed`, ExitCode.PRECOND);
        }
        const data: DepTreeData = {
          root,
          blocked_count: countTree(root),
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderDepTreeHuman,
  };
}

// ---------------------------------------------------------------------------
// dep why
// ---------------------------------------------------------------------------

interface WhyChainNode {
  id: string;
  priority: number;
  kind: string;
  status: string;
  assignee: string;
  title: string;
  age_ms: number;
  closed_at: number | null;
  estimate_min?: number;
  children: WhyChainNode[];
}

interface DepWhyData {
  id: string;
  type: string;
  priority: number;
  status: string;
  open_blockers: number;
  /**
   * Предки по `parent`, держащие открытый блокер (миграция 10). Без них
   * `dep why` отвечал бы «не заблокирована» задаче, которой нет в `ready`, —
   * а именно на эту команду ссылается отказ захвата.
   */
  blocked_via: { id: string; title: string; open_blockers: number }[];
  chain: WhyChainNode[];
  critical_path: { open: number; estimate_min: number };
  took_ms: number;
}

function buildChain(h: StoreHandle, id: string, now: number, seen: Set<string>, depth: number): WhyChainNode[] {
  if (depth <= 0 || seen.has(id)) return [];
  seen.add(id);
  const out: WhyChainNode[] = [];
  for (const e of h.store.edgesTo(id, "blocks")) {
    const blocker = h.store.getNode(e.src);
    if (blocker === undefined) continue;
    const node: WhyChainNode = {
      id: blocker.id,
      priority: blocker.priority,
      kind: blocker.kind,
      status: blocker.status,
      assignee: blocker.assignee,
      title: blocker.title,
      age_ms: now - blocker.updated_at,
      closed_at: blocker.closed_at,
      ...(estimateMin(blocker) !== undefined ? { estimate_min: estimateMin(blocker)! } : {}),
      children: buildChain(h, blocker.id, now, seen, depth - 1),
    };
    out.push(node);
  }
  seen.delete(id);
  return out;
}

function criticalPath(chain: WhyChainNode[]): { open: number; estimate_min: number } {
  let open = 0;
  let est = 0;
  const walk = (nodes: WhyChainNode[]): void => {
    for (const n of nodes) {
      if (!CLOSED_STATUSES.has(n.status)) {
        open++;
        est += n.estimate_min ?? 0;
      }
      walk(n.children);
    }
  };
  walk(chain);
  return { open, estimate_min: est };
}

function renderChain(nodes: WhyChainNode[], prefix: string, lines: string[]): void {
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    const branch = last ? "└─ " : "├─ ";
    const parts = [n.id];
    if (n.kind === "task") parts.push(fmtPriority(n.priority));
    parts.push(nodeTypeWord(n));
    if (n.status === "closed" && n.closed_at !== null) {
      parts.push(`closed ${fmtDate(n.closed_at)}`);
    } else {
      parts.push(n.status);
      if (n.assignee.length > 0) parts.push(`@${n.assignee} ${fmtAge(n.age_ms)}`);
    }
    parts.push(` ${n.title}`);
    lines.push(`${prefix}${branch}${parts.join("  ")}`);
    renderChain(n.children, prefix + (last ? "   " : "│  "), lines);
  });
}

function nodeTypeWord(n: WhyChainNode): string {
  return n.kind;
}

/** Число с существительным в нужной форме: 1 ancestor, 2 ancestors. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function renderDepWhyHuman(raw: unknown): string {
  const d = raw as DepWhyData;
  const lines: string[] = [];
  const head = [`${d.id} ${fmtPriority(d.priority)} ${d.type} ${d.status}`];
  if (d.open_blockers > 0) {
    head.push(`— blocked by ${plural(d.open_blockers, "open dependency", "open dependencies")}`);
  } else if (d.blocked_via.length > 0) {
    head.push(`— no blockers of its own, ${plural(d.blocked_via.length, "ancestor holds", "ancestors hold")} an open one`);
  } else {
    head.push("— not blocked");
  }
  lines.push(head.join(" "));
  renderChain(d.chain, "", lines);
  for (const a of d.blocked_via) {
    const n = a.open_blockers;
    lines.push(
      `ancestor  ${a.id} (${plural(n, "open blocker", "open blockers")}) — ${a.title}`,
    );
  }
  if (d.critical_path.open > 0) {
    const est = d.critical_path.estimate_min > 0 ? `, estimate ${fmtEstimate(d.critical_path.estimate_min)}` : "";
    lines.push(`critical path: ${plural(d.critical_path.open, "node", "nodes")}${est}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildDepWhy(deps: StoreDeps): Command {
  return {
    name: "why",
    summary: "why is this node blocked: dep why <id>",
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return failure("usage.invalid", "usage: myc dep why <id>", ExitCode.USAGE);
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;
        const chain = buildChain(h, node.id, Date.now(), new Set(), MAX_DEPTH);
        const data: DepWhyData = {
          id: node.id,
          type: node.kind === "task" ? String(node.attrs["type"] ?? "task") : node.kind,
          priority: node.priority,
          status: node.status,
          open_blockers: node.open_blockers,
          blocked_via: h.store
            .blockingAncestors(node.id)
            .map((a) => ({ id: a.id, title: a.title, open_blockers: a.open_blockers })),
          chain,
          critical_path: criticalPath(chain),
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderDepWhyHuman,
  };
}

export function createDepCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "dep",
    summary: "task dependencies (add, rm, tree, why)",
    subcommands: [buildDepAdd(deps), buildDepRm(deps), buildDepTree(deps), buildDepWhy(deps)],
  };
}
