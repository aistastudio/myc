/**
 * Плотные текстовые рендеры для мутирующих вызовов.
 *
 * Читающие тулы (prime/ready-список/recall/show) берут текст готовым из
 * человеческого вывода CLI. Мутации (claim/close/update/link/remember)
 * нельзя прогонять дважды, поэтому их текст собирается здесь из того же
 * data-объекта, что уходит в structuredContent — рендеры повторяют форму
 * CLI-вывода (packages/cli/src/commands/*), строки те же.
 */

export function fmtClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

export function fmtAge(ms: number): string {
  const abs = Math.max(0, ms);
  const m = Math.floor(abs / 60_000);
  if (m < 1) return `${Math.floor(abs / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function warnBlock(warn: readonly { code: string; msg: string }[] | undefined): string {
  if (warn === undefined || warn.length === 0) return "";
  return `${warn.map((w) => `WARN ${w.code}: ${w.msg}`).join("\n")}\n`;
}

/** ready --claim: ветка renderReadyHuman с claimed (ready.ts). */
export function readyClaimText(d: {
  claimed?: {
    id: string;
    holder: string;
    lease_expires: number;
    lease_ttl_ms: number;
    type: string;
    priority: number;
    title: string;
    body: string | null;
    blocked_by: string[];
  };
  ready: number;
  blocked: number;
  in_progress: number;
  took_ms: number;
}): string {
  const c = d.claimed;
  if (c === undefined) {
    return (
      `очередь пуста или задача ушла под носом — свободных нет\n` +
      `${d.ready} ready · ${d.blocked} blocked · ${d.in_progress} in_progress · ${d.took_ms} мс\n`
    );
  }
  const lines = [
    `claimed ${c.id} by ${c.holder} · аренда ${fmtAge(c.lease_ttl_ms)} до ${fmtClock(c.lease_expires)}`,
    `P${c.priority} ${c.type} · ${c.title}`,
  ];
  if (c.body !== null && c.body.trim().length > 0) {
    lines.push("описание");
    for (const l of c.body.trimEnd().split("\n")) lines.push(`  ${l}`);
  }
  if (c.blocked_by.length > 0) lines.push(`deps      blocked-by ${c.blocked_by.join(", ")}`);
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

/** claim <id>: renderClaimHuman (tasks.ts). */
export function claimText(d: {
  id: string;
  holder: string;
  lease_expires: number;
  lease_ttl_ms: number;
  prev_status: string;
  type: string;
  priority: number;
  renewed?: boolean;
  stolen_from?: string;
  expired_ago_ms?: number;
}): string {
  if (d.renewed === true) {
    return `renewed ${d.id} by ${d.holder} · аренда ${fmtAge(d.lease_ttl_ms)} до ${fmtClock(d.lease_expires)}\n`;
  }
  let head = `claimed ${d.id} by ${d.holder}`;
  if (d.stolen_from !== undefined) {
    head += ` (отобрана у ${d.stolen_from}, аренда истекла ${fmtAge(d.expired_ago_ms ?? 0)} назад)`;
  } else {
    head += ` · аренда ${fmtAge(d.lease_ttl_ms)} до ${fmtClock(d.lease_expires)}`;
  }
  return `${head}\n${d.id} P${d.priority} ${d.type} ${d.prev_status}→in_progress\n`;
}

/** close <id>: renderCloseHuman (tasks.ts), сокращённая форма. */
export function closeText(d: {
  id: string;
  status: string;
  closed_by: string;
  already?: boolean;
  in_progress_ms?: number;
  unblocked: string[];
  took_ms: number;
}): string {
  if (d.already === true) return `${d.id} уже ${d.status}\n`;
  const head = [`closed ${d.id}`];
  if (d.in_progress_ms !== undefined) head.push(`in_progress ${fmtAge(d.in_progress_ms)}`);
  head.push(`@${d.closed_by}`);
  const lines = [head.join(" · ")];
  if (d.unblocked.length > 0) lines.push(`unblocked ${d.unblocked.join(", ")}   (теперь ready)`);
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

/** update <id>: renderUpdateHuman (tasks.ts). */
export function updateText(d: {
  id: string;
  kind: string;
  type: string;
  status: string;
  priority: number;
  changed: string[];
  took_ms: number;
}): string {
  const head = [d.id, d.type];
  if (d.kind === "task") head.push(`P${d.priority}`);
  head.push(d.status, `updated: ${d.changed.join(", ")}`);
  return `${head.join("  ")}\n${d.took_ms} мс\n`;
}

/** dep add/rm: renderDepEdgeHuman (dep.ts). */
export function depText(d: {
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
}): string {
  if (d.removed === true) {
    const tail = d.back_ready === true ? `  (${d.back_ready_id} снова ready)` : "";
    return `${d.type} ${d.src} → ${d.dst} removed${tail}\n${d.took_ms} мс\n`;
  }
  const tail = d.left_ready === true ? `  (${d.left_ready_id} ушла из ready)` : "";
  return `${d.from_label} ${d.type === "blocks" ? "blocks" : "blocked-by"} ${d.type === "blocks" ? d.dst : d.src}${tail}\n${d.took_ms} мс\n`;
}

/** remember: renderRememberHuman (remember.ts). */
export function rememberText(d: {
  id: string;
  kind: string;
  tier: string;
  layer: number;
  acl: string;
  tags: string[];
  source?: string;
  anchors: { path: string; start: number; end: number }[];
  queue: string[];
  absorb_heuristic: boolean;
  took_ms: number;
}): string {
  const head = [d.id, d.kind === "note" ? "memory" : d.kind, `L${d.layer}`];
  const bits: string[] = [];
  if (d.tier === "personal") bits.push("tier personal (~/.myc)");
  if (d.tags.length > 0) bits.push(`tags ${d.tags.join(",")}`);
  bits.push(`acl ${d.acl}`);
  if (d.source !== undefined) bits.push(`source ${d.source}`);
  const lines = [`${head.join(" ")} · ${bits.join(" · ")}`];
  for (const a of d.anchors) {
    const span = a.start === a.end ? `${a.start}` : `${a.start}-${a.end}`;
    lines.push(`anchor    ${a.path}:${span} @— (якорь отложен до myc anchor bind)`);
  }
  const queue = d.queue.map((k) =>
    k === "absorb" && d.absorb_heuristic ? "absorb(эвристика — chat-LLM выключен)" : k,
  );
  lines.push(`queue     ${queue.length > 0 ? queue.join(", ") : "—"}`);
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}
