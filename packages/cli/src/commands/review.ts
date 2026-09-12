/**
 * `myc review` — разбор кандидатов хука сжатия (§6.2, memory-79mq6fccg0jm).
 *
 *   myc review [--this-session] [--limit N] [--session <id>]   кто ждёт разбора
 *   myc review confirm <id>[,<id>…]                             подтвердить: знание
 *   myc review reject <id>[,<id>…] --reason "<почему>"          отклонить
 *
 * Хук сжатия (`myc absorb-session`) пишет строки «решили/выбрали/потому что»
 * заметками L2 с `attrs.state = 'pending_review'`, и выдача (recall, search,
 * prime, MCP) их не отдаёт, пока их не подтвердят (@myc/retrieval review.ts).
 * До этой команды разбирать было нечем: подтвердить — только дословным `myc
 * remember`, отклонить — сырым `myc update --status retracted`, увидеть —
 * только в вебе. Кандидаты копились: в базе этого репозитория их было 24.
 *
 * ПОДТВЕРЖДЕНИЕ — та же функция, что у точного повтора в `remember`
 * (confirmCandidate, remember.ts): state → confirmed, кто и когда, salience
 * новой заметки и работы embed/absorb, как у новой заметки
 * (memory-4c24exck23cw). Лексика находит узел сразу, вектор и классификация
 * приезжают из очереди.
 *
 * ОТКЛОНЕНИЕ — статус `retracted` и кто/когда/почему в attrs (rejectAttrs).
 * Состояние `pending_review` остаётся: снимут отклонение — узел вернётся в
 * очередь разбора, а не в выдачу. Из выдачи его убирает статус
 * (HIDDEN_STATUSES — тот же список, что у recall, prime и строки статуса).
 *
 * ОХВАТ СПИСКА — ВСЕ кандидаты воркспейса, с пометкой сессии, и это решение,
 * а не недосмотр S58. S58 про КОНТЕКСТ: сессионное знание не едет в prime
 * чужой сессии. Список разбора — не контекст и не знание, а очередь работы
 * с явной пометкой «не подтверждено». Сессии кончаются, кандидаты остаются: в
 * списке «только своей сессии» почти все кандидаты базы (все прошлые сессии)
 * были бы неразбираемыми. Поэтому видно всё, своя сессия — первой и своим
 * числом (оно совпадает с `N pending review hidden` в подвале prime этой
 * сессии), `--this-session` сужает до неё.
 *
 * Разбор — явное действие по id: каждый id проверяется ДО первой записи, и
 * неверный id в пачке не оставляет половину пачки разобранной.
 */

import {
  defineQueries,
  episodeSessionKey,
  historyClause,
  readReach,
  readRepo,
  resolveSession,
  visibleInPrime,
  type JsonValue,
  type NodeRecord,
  type ReachInfo,
} from "@myc/core";
// Подпуть: команде нужен предикат и константы, а не гибрид с вектором.
import {
  CONFIRMED,
  CONFIRMED_AT_KEY,
  CONFIRMED_BY_KEY,
  REJECTED_AT_KEY,
  REJECTED_BY_KEY,
  REJECTED_STATUS,
  REJECT_REASON_KEY,
  REVIEW_STATE_KEY,
  awaitingReviewPredicate,
  isAwaitingReview,
  isPendingReview,
  rejectAttrs,
} from "@myc/retrieval/review";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import { confirmCandidate, realRememberDeps } from "./remember.ts";
import {
  flagBool,
  flagNum,
  flagStr,
  fmtDate,
  graphFailure,
  realStoreDeps,
  resolveId,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

/** Сколько символов ключа сессии печатать — как в подвале prime. */
const SESSION_SHORT = 8;
const DEFAULT_LIMIT = 50;
const TITLE_MAX = 100;

/**
 * Кандидаты, ждущие разбора. Индекс (scope, kind, updated_at DESC) отдаёт
 * заметки воркспейса уже в порядке «свежие первыми»; признак кандидата — в
 * attrs, и строка читается у каждой заметки. Это не горячий путь (команду
 * зовут, чтобы разобрать очередь, а не на каждом шаге), и держать ради неё
 * частичный индекс по json_extract — миграция и цена на каждой записи в
 * nodes. Предикат — тот же awaitingReviewPredicate, что у счётчика prime:
 * «ждёт» здесь и там — одно правило.
 */
export const reviewQueries = defineQueries({
  review_awaiting: {
    name: "review_awaiting",
    sql: `SELECT id, layer, title, created_at, updated_at, attrs
            FROM nodes INDEXED BY ix_nodes_kind_upd
           WHERE nodes.scope = ?1 AND nodes.kind = 'note' AND nodes.deleted_at IS NULL${historyClause("follow", "nodes")}
             AND ${awaitingReviewPredicate("nodes")}
           ORDER BY nodes.updated_at DESC`,
    params: ["scope"],
  },
});

// ---------------------------------------------------------------------------
// Список
// ---------------------------------------------------------------------------

export interface ReviewItem {
  readonly id: string;
  readonly layer: number;
  readonly title: string;
  readonly created_at: number;
  /** Охват S58 кандидата: session | project | unknown. */
  readonly reach: ReachInfo["reach"];
  /** Ключ сессии, в которой кандидат родился; пусто у project/unknown. */
  readonly session: string;
  /**
   * Кандидат прошёл бы охват prime ЭТОЙ сессии, то есть он и есть одно из
   * `N pending review hidden` её подвала.
   */
  readonly here: boolean;
  /** Охват репозитория (S59): имя; пусто — общий или не записан (см. repo_state). */
  readonly repo: string;
  readonly repo_state: "repo" | "root" | "unknown";
  /** Хост, из стенограммы которого вытащен кандидат (attrs.agent). */
  readonly agent: string;
  /** Эпизод-источник (attrs.episode_id): `myc show` покажет стенограмму вокруг. */
  readonly episode: string;
}

export interface ReviewListData {
  /** Ключ текущей сессии; пусто — не определён. */
  readonly session: string;
  /** Всего ждут разбора. */
  readonly total: number;
  /** Из них видны охвату этой сессии — совпадает с подвалом prime. */
  readonly here: number;
  /** Из других сессий. */
  readonly other: number;
  /** Сколько прошло фильтр (`--this-session`) — из них напечатано `shown`. */
  readonly listed: number;
  readonly shown: number;
  readonly items: readonly ReviewItem[];
  readonly took_ms: number;
}

interface AwaitingRow {
  readonly id: string;
  readonly layer: number;
  readonly title: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly attrs: string;
}

function parseAttrs(raw: string): Record<string, JsonValue> {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

function strAttr(attrs: Record<string, JsonValue>, key: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : "";
}

/** Все кандидаты воркспейса, свои (охват этой сессии) — первыми. */
export function listCandidates(h: StoreHandle, session: string): ReviewItem[] {
  const rows = h.driver.all<AwaitingRow>(reviewQueries.review_awaiting, [h.scope]);
  const items = rows.map((r): ReviewItem => {
    const attrs = parseAttrs(r.attrs);
    const reach = readReach(attrs);
    const repo = readRepo(attrs);
    return {
      id: r.id,
      layer: r.layer,
      title: r.title,
      created_at: r.created_at,
      reach: reach.reach,
      session: reach.session,
      here: visibleInPrime(reach, session),
      repo: repo.repo,
      repo_state: repo.state,
      agent: strAttr(attrs, "agent"),
      episode: strAttr(attrs, "episode_id"),
    };
  });
  // Стабильная сортировка: внутри группы остаётся порядок индекса (свежие первыми).
  return [...items.filter((i) => i.here), ...items.filter((i) => !i.here)];
}

function reachLabel(it: ReviewItem, session: string): string {
  if (it.reach === "project") return "project";
  if (it.reach === "unknown") return "no reach";
  if (session.length > 0 && it.session === session) return "this session";
  // Ключ, выведенный из эпизода (`episode:<id>`, старые кандидаты без ключа
  // хоста): первые восемь символов — одно слово «episode:» у всех, различает
  // хвост id.
  if (it.session.startsWith(EPISODE_PREFIX)) return `episode …${it.session.slice(-SESSION_SHORT)}`;
  return `session ${it.session.slice(0, SESSION_SHORT)}`;
}

/** Префикс ключа, выведенного из эпизода, — из ядра, а не копией литерала. */
const EPISODE_PREFIX = episodeSessionKey("");

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= TITLE_MAX ? one : `${one.slice(0, TITLE_MAX - 1)}…`;
}

function renderList(raw: unknown): string {
  const d = raw as ReviewListData;
  const who = d.session.length > 0 ? `session ${d.session.slice(0, SESSION_SHORT)}` : "session not specified";
  if (d.total === 0) {
    return `nothing awaits review · ${who} · compaction candidates appear after a context compaction · ${d.took_ms} ms\n`;
  }
  const lines = [
    `PENDING REVIEW ${d.total} · ${d.here} in this session's prime · ${d.other} from other sessions · ${who}`,
  ];
  const labels = d.items.map((it) => reachLabel(it, d.session));
  const width = Math.max(...labels.map((l) => l.length));
  d.items.forEach((it, i) => {
    const repo = it.repo_state === "repo" ? `  repo ${it.repo}` : "";
    lines.push(`${it.id}  L${it.layer}  ${fmtDate(it.created_at)}  ${labels[i]!.padEnd(width)}${repo}  ${clip(it.title)}`);
  });
  if (d.shown < d.listed) lines.push(`… ${d.listed - d.shown} more (--limit)`);
  lines.push(
    "confirm   `myc review confirm <id>`  — becomes knowledge: recall and prime return it",
    'reject    `myc review reject <id> --reason "<why>"`  — retracted, out of this list',
  );
  lines.push(`${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

/**
 * Флаги СПИСКА. Реестр наследует флаги верхнего уровня подкомандам (как у
 * `bootstrap`), поэтому в справке confirm/reject они тоже видны — отсюда
 * «list:» в описании: иначе `--limit` у reject читался бы как «сколько
 * отклонить».
 */
const LIST_FLAGS: readonly FlagSpec[] = [
  { name: "this-session", description: "list: only candidates this session's prime counts (its `pending review hidden`)" },
  { name: "limit", value: "number", description: `list: rows to print (default ${DEFAULT_LIMIT}); counts cover all` },
  {
    name: "session",
    value: "string",
    description: "list: session identity for the reach marks (default $MYC_SESSION_ID/$CLAUDE_SESSION_ID)",
  },
];

// ---------------------------------------------------------------------------
// confirm / reject
// ---------------------------------------------------------------------------

type Outcome = "confirmed" | "already_confirmed" | "rejected" | "already_rejected";

export interface ReviewActionItem {
  readonly id: string;
  readonly title: string;
  readonly outcome: Outcome;
  /** Кто подтвердил/отклонил (у already_* — кто сделал это раньше). */
  readonly by: string;
  readonly at: number;
  /** Поставленные работы (только у confirmed). */
  readonly queue: readonly string[];
  /** Причина отклонения. */
  readonly reason?: string;
}

export interface ReviewActionData {
  readonly action: "confirm" | "reject";
  readonly items: readonly ReviewActionItem[];
  /** Сколько узлов изменено этим вызовом. */
  readonly changed: number;
  /** absorb поставлен на эвристике: chat-LLM выключен (И2, как у remember). */
  readonly absorb_heuristic: boolean;
  readonly took_ms: number;
}

/** id через пробел и/или запятую — как у `myc show a,b`. */
function idsOf(ctx: CommandContext): string[] {
  return ctx.args
    .flatMap((a) => a.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function numAttr(attrs: Readonly<Record<string, JsonValue>>, key: string): number {
  const v = attrs[key];
  return typeof v === "number" ? v : 0;
}

function strOf(attrs: Readonly<Record<string, JsonValue>>, key: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : "";
}

type Planned = { readonly node: NodeRecord; readonly already: boolean };

/**
 * Разрешить и проверить ВСЕ id до первой записи. Отказ по любому — отказ
 * пачки целиком: разобранная наполовину пачка с ошибкой посередине — худший
 * исход для того, кто её повторит.
 */
function planAll(
  h: StoreHandle,
  inputs: readonly string[],
  action: "confirm" | "reject",
): { ok: true; plan: Planned[] } | { ok: false; failure: CommandFailure } {
  const plan: Planned[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const resolved = resolveId(h, input);
    if (!resolved.ok) return { ok: false, failure: resolved.failure };
    const node = resolved.node;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const confirmed = node.attrs[REVIEW_STATE_KEY] === CONFIRMED;
    if (!isPendingReview(node.attrs) && !confirmed) {
      return {
        ok: false,
        failure: failure(
          "precond.not_candidate",
          `${node.id} is not a compaction candidate: nothing to review`,
          ExitCode.PRECOND,
          "myc review",
        ),
      };
    }
    const awaiting = isAwaitingReview(node.attrs, node.status);
    if (action === "confirm") {
      if (confirmed) {
        plan.push({ node, already: true });
        continue;
      }
      if (!awaiting) {
        return {
          ok: false,
          failure:
            node.status === REJECTED_STATUS
              ? failure(
                  "precond.rejected",
                  `${node.id} was rejected (status ${node.status}): confirming it takes lifting the rejection first — ` +
                    "it then returns to the review list",
                  ExitCode.PRECOND,
                  `myc update ${node.id} --status active`,
                )
              : failure(
                  "precond.rejected",
                  `${node.id} is out of review (status ${node.status}): its current version is the one to read`,
                  ExitCode.PRECOND,
                  `myc show ${node.id}`,
                ),
        };
      }
      plan.push({ node, already: false });
    } else {
      if (confirmed) {
        return {
          ok: false,
          failure: failure(
            "precond.confirmed",
            `${node.id} is already confirmed knowledge, not a candidate: withdrawing knowledge is a retraction`,
            ExitCode.PRECOND,
            `myc update ${node.id} --status ${REJECTED_STATUS}`,
          ),
        };
      }
      plan.push({ node, already: !awaiting });
    }
  }
  return { ok: true, plan };
}

function queueWords(d: ReviewActionData, queue: readonly string[]): string {
  return queue.map((k) => (k === "absorb" && d.absorb_heuristic ? "absorb(heuristic — chat-LLM off)" : k)).join(", ");
}

function renderAction(raw: unknown): string {
  const d = raw as ReviewActionData;
  const lines = d.items.map((it) => {
    switch (it.outcome) {
      case "confirmed":
        return (
          `${it.id} confirmed · recall and prime return it now · ` +
          `queue ${it.queue.length > 0 ? queueWords(d, it.queue) : "—"} · ${clip(it.title)}`
        );
      case "already_confirmed":
        return `${it.id} already confirmed by ${it.by || "?"} ${it.at > 0 ? fmtDate(it.at) : ""} · nothing to do`;
      case "rejected":
        return `${it.id} rejected · status ${REJECTED_STATUS} · reason: ${it.reason ?? ""} · ${clip(it.title)}`;
      case "already_rejected":
        return `${it.id} already rejected by ${it.by || "?"} · nothing to do`;
    }
  });
  lines.push(`${d.changed} changed · ${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

export interface ReviewDeps extends StoreDeps {
  /** Признак chat-LLM — для пометки absorb, как у remember; подменяется в тестах. */
  chatLlm(): boolean;
}

export const realReviewDeps: ReviewDeps = {
  openStore: realStoreDeps.openStore,
  chatLlm: () => realRememberDeps.chatLlm(),
};

function buildConfirm(deps: ReviewDeps): Command {
  return {
    name: "confirm",
    summary: "confirm compaction candidates: knowledge from now on, embed and absorb queued",
    help:
      "Turns each candidate into knowledge the way a new note is born: attrs.state = confirmed with " +
      "who and when, the salience of a new note, and embed + absorb jobs queued. Every id is checked " +
      "before the first write; a rejected candidate is refused (lift the rejection first).",
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const inputs = idsOf(ctx);
      if (inputs.length === 0) {
        return failure("usage.missing_arg", "id required: myc review confirm <id>[,<id>…]", ExitCode.USAGE, "myc review");
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const planned = planAll(h, inputs, "confirm");
        if (!planned.ok) return planned.failure;
        const now = Date.now();
        const items: ReviewActionItem[] = [];
        let changed = 0;
        for (const p of planned.plan) {
          if (p.already) {
            items.push({
              id: p.node.id,
              title: p.node.title,
              outcome: "already_confirmed",
              by: strOf(p.node.attrs, CONFIRMED_BY_KEY),
              at: numAttr(p.node.attrs, CONFIRMED_AT_KEY),
              queue: [],
            });
            continue;
          }
          const done = confirmCandidate(h, p.node, h.actor, now, true);
          if (done.queueError !== undefined) {
            ctx.warn("degraded.queue", `background queue unavailable for ${p.node.id}: ${done.queueError}`);
          }
          changed++;
          items.push({
            id: p.node.id,
            title: p.node.title,
            outcome: "confirmed",
            by: h.actor,
            at: now,
            queue: done.queue,
          });
        }
        const data: ReviewActionData = {
          action: "confirm",
          items,
          changed,
          absorb_heuristic: items.some((i) => i.queue.includes("absorb")) && !deps.chatLlm(),
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return { ok: true, data, meta: { took_ms: data.took_ms, changed } };
      } catch (e) {
        return graphFailure(e);
      } finally {
        h.close();
      }
    },
    renderHuman: renderAction,
  };
}

function buildReject(deps: ReviewDeps): Command {
  return {
    name: "reject",
    summary: "reject compaction candidates: retracted, with the reason in the node",
    help:
      "Marks each candidate retracted and records who, when and why in its attrs. Retracted nodes are out " +
      "of recall, search, prime and this list; the candidate state stays, so lifting the rejection " +
      "(`myc update <id> --status active`) returns it to review, not to the agent as knowledge.",
    flags: [{ name: "reason", value: "string", description: "why this is not a decision (required)" }],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const inputs = idsOf(ctx);
      if (inputs.length === 0) {
        return failure("usage.missing_arg", 'id required: myc review reject <id>[,<id>…] --reason "<why>"', ExitCode.USAGE, "myc review");
      }
      const reason = flagStr(ctx, "reason")?.trim() ?? "";
      if (reason.length === 0) {
        return failure(
          "usage.missing_arg",
          "--reason required: a rejection is a judgment, and whoever meets this candidate again reads why",
          ExitCode.USAGE,
        );
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const planned = planAll(h, inputs, "reject");
        if (!planned.ok) return planned.failure;
        const now = Date.now();
        const items: ReviewActionItem[] = [];
        let changed = 0;
        for (const p of planned.plan) {
          if (p.already) {
            items.push({
              id: p.node.id,
              title: p.node.title,
              outcome: "already_rejected",
              by: strOf(p.node.attrs, REJECTED_BY_KEY),
              at: numAttr(p.node.attrs, REJECTED_AT_KEY),
              queue: [],
              reason: strOf(p.node.attrs, REJECT_REASON_KEY),
            });
            continue;
          }
          h.store.updateNode(p.node.id, { status: REJECTED_STATUS, attrs: rejectAttrs(h.actor, now, reason) });
          changed++;
          items.push({
            id: p.node.id,
            title: p.node.title,
            outcome: "rejected",
            by: h.actor,
            at: now,
            queue: [],
            reason,
          });
        }
        const data: ReviewActionData = {
          action: "reject",
          items,
          changed,
          absorb_heuristic: false,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return { ok: true, data, meta: { took_ms: data.took_ms, changed } };
      } catch (e) {
        return graphFailure(e);
      } finally {
        h.close();
      }
    },
    renderHuman: renderAction,
  };
}

export function createReviewCommand(deps: ReviewDeps = realReviewDeps): Command {
  return {
    name: "review",
    summary: "compaction candidates awaiting review: list them, confirm or reject",
    help:
      "The pre-compact hook writes \"we decided / because\" lines as candidates (state pending_review); " +
      "recall, search, prime and MCP do not return them until they are confirmed. Lists every candidate " +
      "of the workspace with its session and repo reach — this session's first (they are the `pending " +
      "review hidden` of its prime footer); --this-session narrows to them. Confirm with `myc review " +
      "confirm <id>`, reject with `myc review reject <id> --reason`.",
    flags: LIST_FLAGS,
    subcommands: [buildConfirm(deps), buildReject(deps)],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const limitRaw = flagNum(ctx, "limit");
      if (limitRaw !== undefined && (!Number.isFinite(limitRaw) || limitRaw < 1)) {
        return failure("usage.invalid", `--limit must be >= 1, got ${limitRaw}`, ExitCode.USAGE);
      }
      const limit = Math.floor(limitRaw ?? DEFAULT_LIMIT);
      const session = resolveSession(flagStr(ctx, "session"));
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const all = listCandidates(h, session);
        const here = all.filter((i) => i.here).length;
        const pool = flagBool(ctx, "this-session") ? all.filter((i) => i.here) : all;
        const items = pool.slice(0, limit);
        const data: ReviewListData = {
          session,
          total: all.length,
          here,
          other: all.length - here,
          listed: pool.length,
          shown: items.length,
          items,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return {
          ok: true,
          data,
          meta: { took_ms: data.took_ms, total: data.total, here, session: session.length > 0 ? session : null },
        };
      } finally {
        h.close();
      }
    },
    renderHuman: renderList,
  };
}
