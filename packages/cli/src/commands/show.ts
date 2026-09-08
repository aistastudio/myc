/**
 * `myc show` — раскрыть узел (§3.14). Батч по запятым, --field для проекции,
 * --depth 1 раскрывает соседей одной строкой, --source читает код по якорям.
 *
 * РЕЖИМЫ ИСТОРИИ (§6.3). Обновление знания не затирает прежнее, а строит
 * цепочку версий через `head_id`, и у чтения два режима:
 *
 *   follow (умолчание) — показан запрошенный узел И названа АКТУАЛЬНАЯ версия
 *                        его цепочки; из любого звена видно, куда смотреть;
 *   --chain            — вся цепочка целиком, от старой версии к новой, с
 *                        датами и причиной из absorb (full_history).
 *
 * Здесь же читаются `contradicts`. Ребро симметрично, хранится одно, поэтому
 * оно собирается в ОБЕ стороны: противоречие, видное только с одной стороны,
 * — это ровно та ловушка memora, где конфликт помечен, но вторую сторону
 * нечем найти.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  HISTORY_MAX_DEPTH,
  MOVED_FROM_KEY,
  VersionGraph,
  collectVersions,
  historyModeOf,
  versionSourceOf,
  type HistoryMode,
  type JsonValue,
  type NodeRecord,
} from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { Command, CommandFailure } from "../registry.ts";
import {
  estimateMin,
  flagStr,
  fmtAge,
  fmtClock,
  fmtDate,
  fmtEstimate,
  fmtPriority,
  resolveId,
  tagsOf,
  type StoreDeps,
  type StoreHandle,
  realStoreDeps,
} from "./store.ts";
import { nodeType } from "./tasks.ts";

const RULE = "─".repeat(72);

// ---------------------------------------------------------------------------
// Цепочка версий (§6.3)
// ---------------------------------------------------------------------------

/**
 * Строки всей цепочки запрошенного узла. Обход, запрос и правило выбора
 * головы — общие с absorb и любой будущей поверхностью: они живут в
 * `collectVersions` (@myc/core). Здесь остаётся только порт к хранилищу.
 *
 * Выборка ограничена HISTORY_MAX_DEPTH: это бюджет чтения одного show, а не
 * предел истории. Упёрлись в него — цепочка помечается усечённой, а не
 * молча обрезается (И2).
 */
function versionsOf(
  h: StoreHandle,
  node: NodeRecord,
): { graph: VersionGraph; truncated: boolean } {
  return collectVersions(
    versionSourceOf(h.driver, h.store),
    { id: node.id, head_id: node.head_id, hlc: node.hlc, site_id: node.site_id },
    HISTORY_MAX_DEPTH + 1,
  );
}

/** Одна версия в выдаче --chain. */
interface ChainEntry {
  id: string;
  status: string;
  created_at: number;
  /** Актуальная версия цепочки. */
  current: boolean;
  /** Класс и причина из absorb — почему эта версия заменила предыдущую. */
  absorb_class?: string;
  reason?: string;
}

function chainEntry(h: StoreHandle, id: string, head: string): ChainEntry {
  const n = h.store.getNode(id, true);
  const absorb = n?.attrs["absorb"];
  const meta = typeof absorb === "object" && absorb !== null && !Array.isArray(absorb)
    ? (absorb as Record<string, JsonValue>)
    : undefined;
  const cls = meta?.["class"];
  const reason = meta?.["reason"];
  return {
    id,
    status: n?.status ?? "unknown",
    created_at: n?.created_at ?? 0,
    current: id === head,
    ...(typeof cls === "string" ? { absorb_class: cls } : {}),
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
  };
}

interface DepRef {
  id: string;
  status: string;
  closed_at: number | null;
}

interface LinkRef {
  type: string;
  id: string;
}

interface AnchorRef {
  path?: string;
  start?: number;
  end?: number;
  state: string;
  node_id?: string;
}

interface ShowData {
  nodes: NodeView[];
  fields?: string[];
  depth: number;
  source: boolean;
  /** Режим истории запроса: follow (умолчание) или full_history (--chain). */
  history: HistoryMode;
  took_ms: number;
}

interface NodeView {
  id: string;
  kind: string;
  type: string;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  assignee: string;
  acl: string;
  created_at: number;
  updated_at: number;
  blocked_by: DepRef[];
  blocks: DepRef[];
  /**
   * Предки по `parent`, держащие открытый блокер (миграция 10). Из-за них
   * задача не попадает в `ready`, а в её собственных `deps` этому нет
   * никакого следа — И2 требует назвать виновника, а не оставить очередь
   * молча короче.
   */
  blocked_via?: { id: string; title: string; open_blockers: number }[];
  /** Эпик, в который входит узел: ребро parent ведёт ОТ ребёнка К родителю. */
  parent?: { id: string; title: string };
  /** Состав узла: дети плюс счётчик закрытых — прогресс эпика виден сразу. */
  children?: { id: string; status: string; priority: number; title: string }[];
  /** Нить обсуждения: прямые ответы на этот узел, старые сверху. */
  thread?: { id: string; actor: string; at: number; title: string; replies: number }[];
  links: LinkRef[];
  anchors: AnchorRef[];
  tags: string[];
  estimate_min?: number;
  lease?: { holder: string; expires: number };
  /** Актуальная версия цепочки: сам узел — голова (§6.3). */
  current: boolean;
  /** Куда переехало знание, если узел уже не актуален (режим follow). */
  head?: { id: string; title: string; status: string };
  /**
   * Развилка цепочки — след слияния двух веток. Голова выбрана
   * детерминированно, но факт развилки обязан быть виден, а не замолчан (И2).
   */
  forked?: string[];
  /**
   * Звенья цепочки, у которых `head_id` НЕ проставлен, хотя головой они не
   * являются. Весь ретривал фильтрует режим follow предикатом
   * `head_id IS NULL`, поэтому такое звено он будет отдавать как актуальное —
   * то есть выдавать устаревшее знание. Молчать об этом нельзя (И2).
   */
  stale?: string[];
  /**
   * `contradicts` в обе стороны: ребро симметрично и хранится одно, а
   * противоречие обязано находиться с любой из сторон.
   */
  contradicts: LinkRef[];
  /**
   * Надгробие переезда (R4): узел уехал в другой воркспейс, здесь осталась
   * строка, которую держат неуехавшие рёбра. Молчать об этом нельзя — иначе
   * `show` показывает нормальную с виду задачу, которой нет ни в одной
   * очереди этого воркспейса (И2).
   */
  moved?: { to: string; from: string };
  /** заполняется при --chain: вся цепочка версий от старой к новой */
  chain?: ChainEntry[];
  /** Цепочка длиннее бюджета чтения — показана не целиком. */
  chain_truncated?: boolean;
  /** заполняется при --depth 1: однострочники соседей */
  related?: string[];
  /** заполняется при --source: код по отложенным якорям */
  sources?: { path: string; start: number; end: number; text: string }[];
}

const CLOSED_STATUSES = new Set(["closed", "cancelled", "superseded", "retracted"]);

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

function depStatus(ref: DepRef): string {
  if (ref.status === "closed" && ref.closed_at !== null) {
    return `closed ${fmtDate(ref.closed_at)}`;
  }
  return ref.status;
}

function oneLine(h: StoreHandle, id: string): string {
  const n = h.store.getNode(id);
  if (n === undefined) return `${id} (удалён)`;
  const parts = [n.id];
  if (n.kind === "task") parts.push(fmtPriority(n.priority));
  parts.push(nodeType(n), n.status);
  if (n.assignee.length > 0) parts.push(`@${n.assignee}`);
  parts.push(n.title);
  return parts.join("  ");
}

function buildView(
  h: StoreHandle,
  node: NodeRecord,
  depth: number,
  withSource: boolean,
  mode: HistoryMode,
): NodeView {
  const blockedBy: DepRef[] = [];
  const blocks: DepRef[] = [];
  const links: LinkRef[] = [];
  const contradicts: LinkRef[] = [];
  const anchors: AnchorRef[] = [];

  // Иерархия. Ребро `parent` ведёт от ребёнка к родителю, поэтому родитель
  // ищется через edgesFrom, а состав — через edgesTo. До этой правки тип
  // `parent` не разбирался вовсе: данные копились (`myc create --parent` их
  // пишет), но состав эпика нельзя было увидеть ничем — ни `show`, ни
  // `dep tree`, который ходит только по `blocks` и отвечает на другой вопрос
  // («что мешает», а не «из чего состоит»).
  let parent: { id: string; title: string } | undefined;
  for (const e of h.store.edgesFrom(node.id, "parent")) {
    const dst = h.store.getNode(e.dst);
    if (dst !== undefined) parent = { id: dst.id, title: dst.title };
    break;
  }
  const children: { id: string; status: string; priority: number; title: string }[] = [];
  for (const e of h.store.edgesTo(node.id, "parent")) {
    const src = h.store.getNode(e.src);
    if (src !== undefined) {
      children.push({ id: src.id, status: src.status, priority: src.priority, title: src.title });
    }
  }
  children.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  // Нить обсуждения. Только ПРЯМЫЕ ответы: ребро `replies_to` транзитивно и
  // допускает глубину 64, но разворачивать всё дерево здесь значило бы
  // утопить карточку задачи в переписке. Число вложенных ответов при этом
  // названо у каждой реплики — молчать о них нельзя, иначе читатель решит,
  // что обсуждение кончилось.
  const thread: { id: string; actor: string; at: number; title: string; replies: number }[] = [];
  for (const e of h.store.edgesTo(node.id, "replies_to")) {
    const src = h.store.getNode(e.src);
    if (src === undefined) continue;
    // ВИД УЗЛА ЗДЕСЬ НЕ СПРАШИВАЕТСЯ. Нить определяется РЕБРОМ: комментарии
    // пишут mcp addNote (note), `myc comment` (note) и import-beads (note), а
    // межагентские реплики — `myc msg` (message). Любой фильтр по kind делает
    // читателя зависимым от того, какая поверхность писала, — ровно так веб
    // показывал ноль из девяти существовавших комментариев (memory-1nh192mztcqy).
    //
    // Время реплики — время СОБЫТИЯ, а не записи: у 156 комментариев,
    // ввезённых из beads одним прогоном, created_at совпадает с точностью до
    // миллисекунд, и порядок нити определялся бы случайным порядком id.
    // Источник кладёт исходное время в attrs.external_created_at.
    const external = src.attrs["external_created_at"];
    thread.push({
      id: src.id,
      actor: src.actor,
      at: typeof external === "number" && Number.isFinite(external) ? external : src.updated_at,
      title: src.title,
      replies: h.store.edgesTo(src.id, "replies_to").length,
    });
  }
  thread.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  for (const e of h.store.edgesTo(node.id, "blocks")) {
    const src = h.store.getNode(e.src);
    blockedBy.push({
      id: e.src,
      status: src?.status ?? "unknown",
      closed_at: src?.closed_at ?? null,
    });
  }
  for (const e of h.store.edgesFrom(node.id)) {
    if (e.type === "blocks") {
      const dst = h.store.getNode(e.dst);
      blocks.push({ id: e.dst, status: dst?.status ?? "unknown", closed_at: dst?.closed_at ?? null });
    } else if (e.type === "touches") {
      const dst = h.store.getNode(e.dst);
      if (dst !== undefined) anchors.push({ state: dst.status, node_id: e.dst });
    } else if (e.type === "contradicts") {
      contradicts.push({ type: "contradicts", id: e.dst });
    } else if (e.type === "relates" || e.type === "derived_from" || e.type === "duplicates" || e.type === "supersedes") {
      links.push({ type: e.type === "relates" ? "relates-to" : e.type === "derived_from" ? "derived-from" : e.type, id: e.dst });
    }
  }
  // Вторая сторона конфликта. Ребро симметрично и записано один раз — тем,
  // кто пришёл вторым; без этого прохода противоречие видно только с одной
  // стороны, а с другой его нечем найти (расхождение с memora, §4.1).
  const seenContra = new Set(contradicts.map((c) => c.id));
  for (const e of h.store.edgesTo(node.id, "contradicts")) {
    if (!seenContra.has(e.src)) {
      seenContra.add(e.src);
      contradicts.push({ type: "contradicts", id: e.src });
    }
  }
  contradicts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const pending = node.attrs["anchors"];
  if (Array.isArray(pending)) {
    for (const a of pending) {
      if (typeof a === "object" && a !== null) {
        const r = a as Record<string, unknown>;
        anchors.push({
          path: String(r["path"] ?? ""),
          start: typeof r["start"] === "number" ? r["start"] : 1,
          end: typeof r["end"] === "number" ? r["end"] : 1,
          state: String(r["state"] ?? "pending"),
        });
      }
    }
  }

  const { graph, truncated } = versionsOf(h, node);
  const head = graph.head(node.id);
  const headNode = head === node.id ? undefined : h.store.getNode(head, true);
  const forks = graph.heads(node.id);
  // Звено не голова, а head_id пуст: `head_id IS NULL` в ретривале вернёт его
  // как актуальное. Считается по той же цепочке, что и всё остальное.
  const stale = graph
    .chain(node.id)
    .filter((id) => id !== head && (graph.node(id)?.head_id ?? null) === null);

  const lease = h.store.leaseOf(node.id);
  // Наследованная блокировка спрашивается только у задач: у заметки её нет
  // по построению, а лишний спуск по замыканию платить не за что.
  const blockedVia =
    node.kind === "task"
      ? h.store
          .blockingAncestors(node.id)
          .map((a) => ({ id: a.id, title: a.title, open_blockers: a.open_blockers }))
      : [];
  const view: NodeView = {
    id: node.id,
    kind: node.kind,
    type: nodeType(node),
    title: node.title,
    body: node.body,
    status: node.status,
    priority: node.priority,
    assignee: node.assignee,
    acl: node.acl,
    created_at: node.created_at,
    updated_at: node.updated_at,
    blocked_by: blockedBy,
    blocks,
    ...(blockedVia.length > 0 ? { blocked_via: blockedVia } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(children.length > 0 ? { children } : {}),
    ...(thread.length > 0 ? { thread } : {}),
    links,
    contradicts,
    ...(typeof node.attrs[MOVED_FROM_KEY] === "string" && node.scope !== h.scope
      ? { moved: { to: node.scope, from: String(node.attrs[MOVED_FROM_KEY]) } }
      : {}),
    current: head === node.id,
    ...(headNode !== undefined
      ? { head: { id: headNode.id, title: headNode.title, status: headNode.status } }
      : {}),
    ...(forks.length > 1 ? { forked: [...forks] } : {}),
    ...(stale.length > 0 ? { stale } : {}),
    ...(mode === "full_history"
      ? {
          chain: graph.chain(node.id).map((id) => chainEntry(h, id, head)),
          ...(truncated ? { chain_truncated: true } : {}),
        }
      : {}),
    anchors,
    tags: tagsOf(node),
    ...(estimateMin(node) !== undefined ? { estimate_min: estimateMin(node)! } : {}),
    ...(lease !== undefined && lease.holder.length > 0
      ? { lease: { holder: lease.holder, expires: lease.expires } }
      : {}),
  };

  if (depth >= 1) {
    const related: string[] = [];
    for (const ref of [...blockedBy, ...blocks]) related.push(oneLine(h, ref.id));
    for (const link of links) related.push(oneLine(h, link.id));
    if (related.length > 0) view.related = related;
  }

  if (withSource) {
    const sources: NonNullable<NodeView["sources"]> = [];
    for (const a of anchors) {
      if (a.path === undefined || !existsSync(a.path)) continue;
      try {
        const all = readFileSync(a.path, "utf8").split("\n");
        const start = Math.max(1, a.start ?? 1);
        const end = Math.min(all.length, Math.max(start, a.end ?? start), start + 199);
        sources.push({
          path: a.path,
          start,
          end,
          text: all.slice(start - 1, end).join("\n"),
        });
      } catch {
        // файл пропал между проверками — якорь просто остаётся без source
      }
    }
    if (sources.length > 0) view.sources = sources;
  }

  return view;
}

// ---------------------------------------------------------------------------
// Человеческий вывод
// ---------------------------------------------------------------------------

function renderNodeFull(v: NodeView, now: number): string[] {
  const head = [`${v.id}  ${v.type}`];
  if (v.kind === "task") head.push(fmtPriority(v.priority));
  head.push(v.status);
  if (v.assignee.length > 0) head.push(`@${v.assignee}`);
  head.push(`created ${fmtDate(v.created_at)}`);
  head.push(`updated ${fmtClock(v.updated_at).slice(0, 5)}Z`);
  head.push(`acl ${v.acl}`);
  const lines = [head.join("  "), v.title];

  if (v.body !== null && v.body.trim().length > 0) {
    lines.push(RULE, v.body.trimEnd(), RULE);
  }

  const deps: string[] = [];
  if (v.blocked_by.length > 0) {
    deps.push(`blocked-by ${v.blocked_by.map((r) => `${r.id} (${depStatus(r)})`).join(", ")}`);
  }
  if (v.blocks.length > 0) {
    deps.push(`blocks ${v.blocks.map((r) => (CLOSED_STATUSES.has(r.status) ? `${r.id} (${depStatus(r)})` : r.id)).join(", ")}`);
  }
  if (v.moved !== undefined) {
    lines.push(
      `переехала в воркспейс '${v.moved.to === "" ? "(без слага)" : v.moved.to}' — ` +
        `здесь осталось надгробие, держащее неуехавшие рёбра`,
    );
  }
  if (deps.length > 0) lines.push(`deps      ${deps.join(" · ")}`);
  if (v.blocked_via !== undefined && v.blocked_via.length > 0) {
    const via = v.blocked_via.map((a) => `${a.id} (${a.open_blockers})`).join(", ");
    lines.push(`ждёт      блокер на предке: ${via} — поэтому не в ready`);
  }

  if (v.parent !== undefined) {
    lines.push(`входит в  ${v.parent.id}  ${v.parent.title}`);
  }
  if (v.children !== undefined && v.children.length > 0) {
    // Прогресс считается по ЗАКРЫТЫМ, а не по «не открытым»: отменённая задача
    // это не сделанная работа, и складывать их в один счётчик значило бы
    // показывать эпик более готовым, чем он есть.
    const done = v.children.filter((c) => c.status === "closed").length;
    const dropped = v.children.filter((c) => c.status === "cancelled").length;
    const tail = dropped > 0 ? `, отменено ${dropped}` : "";
    lines.push(`состав    ${done} из ${v.children.length} закрыто${tail}`);
    for (const c of v.children) {
      const mark = c.status === "closed" ? "×" : c.status === "cancelled" ? "—" : "·";
      lines.push(`  ${mark} ${c.id}  ${fmtPriority(c.priority)}  ${c.status.padEnd(11)} ${c.title}`);
    }
  }

  if (v.thread !== undefined && v.thread.length > 0) {
    lines.push(`нить      ${v.thread.length}`);
    for (const c of v.thread) {
      const more = c.replies > 0 ? `  (+${c.replies})` : "";
      lines.push(`  · ${c.id}  ${c.actor}  ${c.title}${more}`);
    }
  }

  if (v.links.length > 0) {
    lines.push(`links     ${v.links.map((l) => `${l.type} ${l.id}`).join(" · ")}`);
  }

  // Актуальная версия — по умолчанию (§6.3). Знание не затёрто: старая версия
  // цела, но читателю сразу сказано, где текущая.
  if (v.head !== undefined) {
    lines.push(`актуальна ${v.head.id}  ${v.head.title}`);
  }
  if (v.forked !== undefined) {
    lines.push(
      `развилка  ${v.forked.join(", ")} — две ветки слились; актуальной выбрана ${v.forked[0]!}`,
    );
  }
  if (v.stale !== undefined) {
    lines.push(
      `ВНИМАНИЕ  head_id не проставлен у ${v.stale.join(", ")}: ретривал вернёт устаревшую версию как актуальную`,
    );
  }
  if (v.contradicts.length > 0) {
    lines.push(`противоречит ${v.contradicts.map((c) => c.id).join(", ")}`);
  }
  if (v.chain !== undefined) {
    lines.push(`история   ${v.chain.length} верс.${v.chain_truncated === true ? " (усечена бюджетом чтения)" : ""}`);
    for (const c of v.chain) {
      const mark = c.current ? "→" : "·";
      const why = c.reason !== undefined ? `  ${c.absorb_class ?? ""} ${c.reason}`.trimEnd() : "";
      lines.push(`  ${mark} ${c.id}  ${fmtDate(c.created_at)}  ${c.status.padEnd(11)}${why}`);
    }
  }

  if (v.anchors.length > 0) {
    const rows = v.anchors.map((a) => {
      if (a.path !== undefined) {
        const span = a.start === a.end ? `${a.start}` : `${a.start}-${a.end}`;
        return `${a.path}:${span} @— ${a.state}`;
      }
      return `${a.node_id} ${a.state}`;
    });
    lines.push(`anchors   ${rows[0]!}`);
    for (const row of rows.slice(1)) lines.push(`          ${row}`);
  }

  const extras: string[] = [];
  if (v.tags.length > 0) extras.push(`tags ${v.tags.join(", ")}`);
  if (v.estimate_min !== undefined) extras.push(`est ${fmtEstimate(v.estimate_min)}`);
  if (extras.length > 0) lines.push(`notes     ${extras.join(" · ")}`);

  if (v.lease !== undefined) {
    const left = v.lease.expires - now;
    const tail = left > 0 ? `осталось ${fmtAge(left)}` : `истекла ${fmtAge(-left)} назад`;
    lines.push(`lease     ${v.lease.holder} до ${fmtClock(v.lease.expires)} (${tail})`);
  }

  if (v.related !== undefined) {
    lines.push("related");
    for (const r of v.related) lines.push(`  ${r}`);
  }

  if (v.sources !== undefined) {
    for (const s of v.sources) {
      lines.push(`source    ${s.path}:${s.start}-${s.end}`);
      for (const l of s.text.split("\n")) lines.push(`  ${l}`);
    }
  }

  return lines;
}

const FIELD_VALUE: Record<string, (v: NodeView) => string> = {
  id: (v) => v.id,
  title: (v) => v.title,
  status: (v) => v.status,
  assignee: (v) => (v.assignee.length > 0 ? v.assignee : "—"),
  priority: (v) => fmtPriority(v.priority),
  kind: (v) => v.type,
  created: (v) => fmtDate(v.created_at),
  updated: (v) => fmtDate(v.updated_at),
  acl: (v) => v.acl,
  tags: (v) => v.tags.join(","),
};

function renderShowHuman(raw: unknown): string {
  const d = raw as ShowData;
  const now = Date.now();
  if (d.fields !== undefined) {
    const unknown = d.fields.filter((f) => !(f in FIELD_VALUE));
    if (unknown.length > 0) return `unknown fields: ${unknown.join(", ")}\n`;
    const rows = d.nodes.map((v) => d.fields!.map((f) => FIELD_VALUE[f]!(v)));
    const widths: number[] = [];
    for (const row of rows) {
      row.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] ?? 0, cell.length);
      });
    }
    return `${rows
      .map((row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd())
      .join("\n")}\n`;
  }
  const out: string[] = [];
  for (const v of d.nodes) out.push(...renderNodeFull(v, now));
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export function createShowCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "show",
    summary: "show a node (batch via commas, --field for projection)",
    flags: [
      { name: "field", value: "string", description: "comma-separated fields for batch projection" },
      { name: "depth", value: "number", description: "0 (default) | 1 — one-line summaries of neighbours" },
      { name: "source", description: "read code for pending anchors (IO budget applies)" },
      { name: "chain", description: "full_history: print the whole version chain (§6.3)" },
    ],
    handler: async (ctx) => {
      const t0 = performance.now();
      const idArg = ctx.args[0];
      if (idArg === undefined) {
        return failure("usage.invalid", "нужен id: myc show <id>[,<id>…]", ExitCode.USAGE);
      }
      const depthRaw = ctx.flags["depth"];
      const depth = typeof depthRaw === "number" ? depthRaw : 0;
      if (depth !== 0 && depth !== 1) {
        return failure("usage.invalid", "--depth принимает 0 или 1", ExitCode.USAGE);
      }
      const fieldsRaw = flagStr(ctx, "field");
      let fields = fieldsRaw !== undefined
        ? fieldsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined;
      if (fields !== undefined && !fields.includes("id")) {
        // id — всегда первая колонка проекции (§3.14)
        fields = ["id", ...fields];
      }
      if (fields !== undefined) {
        const unknown = fields.filter((f) => !(f in FIELD_VALUE));
        if (unknown.length > 0) {
          return failure(
            "usage.invalid",
            `неизвестные поля: ${unknown.join(", ")}; допустимы ${Object.keys(FIELD_VALUE).join(", ")}`,
            ExitCode.USAGE,
          );
        }
      }
      const withSource = ctx.flags["source"] === true;
      const chainAsked = ctx.flags["chain"] === true;

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const views: NodeView[] = [];
        for (const input of idArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
          const resolved = resolveId(h, input);
          if (!resolved.ok) return resolved.failure;
          // Режим запроса сильнее режима узла: --chain включает полную
          // историю всегда, attrs.history_mode='full' — сам по себе (§6.3).
          const mode: HistoryMode = chainAsked
            ? "full_history"
            : historyModeOf(resolved.node.attrs);
          views.push(buildView(h, resolved.node, depth, withSource, mode));
        }
        const data: ShowData = {
          nodes: views,
          ...(fields !== undefined ? { fields } : {}),
          depth,
          source: withSource,
          history: chainAsked ? "full_history" : "follow",
          took_ms: Math.round(performance.now() - t0),
        };
        return {
          ok: true,
          data: views.length === 1 && fields === undefined ? views[0] : data,
          meta: { took_ms: data.took_ms, count: views.length },
        };
      } finally {
        h.close();
      }
    },
    renderHuman: (raw, _ctx) => {
      // одиночный show отдаёт NodeView напрямую; батч — ShowData
      if (typeof raw === "object" && raw !== null && "nodes" in (raw as object)) {
        return renderShowHuman(raw);
      }
      return `${renderNodeFull(raw as NodeView, Date.now()).join("\n")}\n`;
    },
  };
}
