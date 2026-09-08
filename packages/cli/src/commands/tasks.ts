/**
 * Команды задач: create (+алиасы task/bug/epic/msg), update, claim, close.
 * Грамматика и вывод — docs/design/03-interfaces-and-integration.md §3.4–3.6.
 *
 * CLI-«kind» спеки (bug/epic/memory/decision/document) — не NodeKind ядра:
 * ядро хранит task/note/doc/…, а подтип задачи живёт в attrs.type
 * (docs/design/01-core-data-model.md §2.3). Маппинг — здесь, один раз.
 *
 * Человеческий вывод собирается в renderHuman из data — каркас зовёт его
 * только когда stdout не --json/--ndjson, поэтому data несёт все поля,
 * нужные для строки (включая took_ms).
 */

import { REPO_KEY, commentInput, readRepo, repoReasonText } from "@myc/core";
import type { JsonValue, NodeKind, NodeRecord } from "@myc/core";
import { CAVEATS, VERDICTS, type AttemptRecord, type Caveat } from "@myc/swarm";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import type { FlagSpec } from "../flags.ts";
import {
  anchorFlagLine,
  attachAnchorFlag,
  parseTarget,
  type AnchorFlagResult,
  type AnchorTarget,
} from "./anchor.ts";
import {
  attemptFailure,
  caveatArgs,
  recordedSpend,
  resolveModelId,
  swarmOn,
  taskClassOf,
  tokenArgs,
} from "./attempt.ts";
import {
  flagBool,
  flagStr,
  fmtAge,
  fmtClock,
  fmtPriority,
  graphFailure,
  parseDuration,
  parsePriority,
  resolveId,
  type StoreDeps,
  type StoreHandle,
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  estimateMin,
  realStoreDeps,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Маппинг CLI-типов на ядро
// ---------------------------------------------------------------------------

type CliKind = {
  readonly kind: NodeKind;
  /** attrs.type для kind=task (task/bug/epic/chore) и decision-заметок. */
  readonly type?: string;
  readonly defaultPriority?: number;
};

const CLI_KINDS: Readonly<Record<string, CliKind>> = {
  task: { kind: "task", type: "task" },
  bug: { kind: "task", type: "bug", defaultPriority: 1 },
  epic: { kind: "task", type: "epic" },
  chore: { kind: "task", type: "chore" },
  memory: { kind: "note" },
  decision: { kind: "note", type: "decision" },
  document: { kind: "doc" },
  skill: { kind: "skill" },
  message: { kind: "message" },
};

/** Видимый тип узла: у задач attrs.type, у остальных — kind. */
export function nodeType(node: NodeRecord): string {
  if (node.kind === "task") {
    const t = node.attrs["type"];
    if (typeof t === "string" && t.length > 0) return t;
  }
  return node.kind;
}

// ---------------------------------------------------------------------------
// Флаги и мелочь
// ---------------------------------------------------------------------------

const AS_FLAG: FlagSpec = {
  name: "as",
  value: "string",
  description: "actor for the record and claim (default $MYC_ACTOR/$USER)",
};

const CREATE_FLAGS: readonly FlagSpec[] = [
  { name: "kind", value: "string", description: "task|bug|epic|memory|decision|document|skill|message" },
  { name: "priority", short: "p", value: "string", description: "P0|P1|P2|P3 or 0|1|2|3" },
  { name: "body", short: "b", value: "string", description: "node body; '-' reads stdin" },
  { name: "tag", value: "string", description: "comma-separated tags" },
  { name: "parent", value: "string", description: "parent node id" },
  { name: "dep", value: "string", description: "comma-separated blocker ids" },
  { name: "anchor", value: "string", description: "file[:<a>-<b>] anchor request" },
  { name: "reply-to", value: "string", description: "reply to this node: adds a replies_to edge" },
  { name: "assign", value: "string", description: "assignee" },
  { name: "estimate", value: "string", description: "estimate, e.g. 30m, 2h, 1d" },
  { name: "acl", value: "string", description: "private|team|restricted|agent" },
  {
    name: "repo",
    value: "string",
    description: "repository scope (S59); default is derived from the current directory",
  },
  AS_FLAG,
];

function failure(
  code: string,
  msg: string,
  exit: ExitCode,
  hint?: string,
): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

function splitList(text: string | undefined): string[] {
  if (text === undefined) return [];
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tookMs(t0: number): number {
  return Math.round(performance.now() - t0);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

interface CreateData {
  id: string;
  kind: string;
  type: string;
  title: string;
  status: string;
  priority: number;
  blocked_by: string[];
  anchors: AnchorFlagResult[];
  /** Узел, которому это ответ: нить обсуждения видна сразу при создании. */
  replies_to?: string;
  /**
   * Охват репозитория (S59): имя репозитория, `""` — общий, `null` — вывести
   * не удалось. Три значения, а не два: молча выдать общий вместо
   * невыведенного значит потерять сам факт неудачи (И2).
   */
  repo: string | null;
  /** Почему охват не выведен. Пусто — выведен. */
  repo_reason: string;
  body_stdin_chars?: number;
  took_ms: number;
}

function renderCreateHuman(raw: unknown): string {
  const d = raw as CreateData;
  const head = [d.id, d.type];
  if (d.kind === "task") head.push(fmtPriority(d.priority));
  head.push(d.status);
  head.push(d.blocked_by.length > 0 ? `blocked-by ${d.blocked_by.join(", ")}` : "free");
  const lines = [head.join("  ")];
  for (const a of d.anchors) lines.push(anchorFlagLine(a));
  // Охват репозитория печатается, когда он ОТЛИЧАЕТСЯ от общего или не
  // выведен вовсе. Общий охват — норма для корня экосистемы и строкой в
  // каждой выдаче быть не должен; неудача вывода, наоборот, обязана быть
  // видна ровно там, где случилась (И2).
  if (d.repo === null) {
    lines.push(`repo      не определён — ${d.repo_reason}`);
  } else if (d.repo.length > 0) {
    lines.push(`repo      ${d.repo}`);
  }
  if (d.body_stdin_chars !== undefined) {
    lines.push(`body      ${d.body_stdin_chars} симв из stdin`);
  }
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

function buildCreateCommand(
  name: string,
  summary: string,
  fixed: CliKind | undefined,
  deps: StoreDeps,
): Command {
  const flags =
    fixed === undefined
      ? CREATE_FLAGS
      : CREATE_FLAGS.filter((f) => f.name !== "kind");
  return {
    name,
    summary,
    flags,
    help:
      "Create a node. Title is the positional argument; body via -b or stdin (-b -). " +
      "CLI kinds map onto core kinds: bug/epic are tasks with attrs.type, memory/decision are notes.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const title = ctx.args.join(" ").trim();
      if (title.length === 0) {
        return failure("usage.invalid", "нужен заголовок: myc create <title>", ExitCode.USAGE);
      }

      let spec = fixed;
      if (spec === undefined) {
        const kindName = flagStr(ctx, "kind") ?? "task";
        spec = CLI_KINDS[kindName];
        if (spec === undefined) {
          return failure(
            "usage.invalid",
            `неизвестный --kind '${kindName}'; допустимы ${Object.keys(CLI_KINDS).join(", ")}`,
            ExitCode.USAGE,
          );
        }
      }

      let priority: number | undefined;
      const pRaw = flagStr(ctx, "priority");
      if (pRaw !== undefined) {
        priority = parsePriority(pRaw);
        if (priority === undefined) {
          return failure("usage.invalid", `неверный приоритет '${pRaw}'; допустимы P0..P3 или 0..3`, ExitCode.USAGE);
        }
      } else if (spec.defaultPriority !== undefined) {
        priority = spec.defaultPriority;
      }

      let body: string | undefined;
      const bRaw = flagStr(ctx, "body");
      if (bRaw === "-") {
        body = await new Response(Bun.stdin.stream()).text();
      } else if (bRaw !== undefined) {
        body = bRaw;
      }

      let estimateMin: number | undefined;
      const eRaw = flagStr(ctx, "estimate");
      if (eRaw !== undefined) {
        const dur = parseDuration(eRaw);
        if (dur === undefined) {
          return failure("usage.invalid", `неверная оценка '${eRaw}'; формат 30m, 2h, 1d`, ExitCode.USAGE);
        }
        estimateMin = Math.round(dur / 60_000);
      }

      let anchor: AnchorTarget | undefined;
      const aRaw = flagStr(ctx, "anchor");
      if (aRaw !== undefined) {
        anchor = parseTarget(aRaw);
        if (anchor === undefined || anchor.path.length === 0) {
          return failure("usage.invalid", `неверный якорь '${aRaw}'; формат file[:a-b]`, ExitCode.USAGE);
        }
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const attrs: Record<string, JsonValue> = {};
        if (spec.type !== undefined) attrs["type"] = spec.type;
        // Явный --repo сильнее выведенного из пути: он и уходит в attrs,
        // а RepoScopedStore (store.ts) уже готовый ключ не переписывает.
        const repoFlag = flagStr(ctx, "repo");
        if (repoFlag !== undefined) attrs[REPO_KEY] = repoFlag.trim();
        const tags = splitList(flagStr(ctx, "tag"));
        if (tags.length > 0) attrs["tags"] = tags;
        if (estimateMin !== undefined) attrs["estimate_min"] = estimateMin;

        let node: NodeRecord;
        try {
          node = h.store.createNode({
            kind: spec.kind,
            scope: h.scope,
            title,
            ...(body !== undefined ? { body } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(flagStr(ctx, "assign") !== undefined ? { assignee: flagStr(ctx, "assign")! } : {}),
            ...(flagStr(ctx, "acl") !== undefined ? { acl: flagStr(ctx, "acl")! } : {}),
            actor: h.actor,
            attrs,
          });
        } catch (e) {
          return graphFailure(e);
        }

        // ЯКОРЬ ПРИВЯЗЫВАЕТСЯ ЗДЕСЬ, тем же путём, что `myc anchor add`. Раньше
        // здесь лежала запись `state:'pending'` в attrs и строка «якорь отложен»:
        // `ready` (ANCHOR_SUBQ идёт по рёбрам touches) такой задачи не видел, а
        // ось scope класса держалась только на объявленном пути.
        const anchors: AnchorFlagResult[] =
          anchor === undefined
            ? []
            : [
                await attachAnchorFlag(
                  h,
                  node.id,
                  anchor,
                  ctx.globals.directory ?? process.cwd(),
                  (code, msg) => ctx.warn(code, msg),
                ),
              ];

        const blockedBy: string[] = [];
        for (const depInput of splitList(flagStr(ctx, "dep"))) {
          const target = resolveId(h, depInput);
          if (!target.ok) return target.failure;
          try {
            h.store.addEdge(target.node.id, "blocks", node.id);
          } catch (e) {
            return graphFailure(e);
          }
          blockedBy.push(target.node.id);
        }

        let repliesTo: string | undefined;
        // Нить обсуждения. Ребро `replies_to` заводилось ТОЛЬКО прямым вызовом
        // store — так делают MCP addNote и import-beads, — а из CLI его нельзя
        // было создать ничем: `dep add` знает лишь blocks/blocked-by. Из-за
        // этого интерфейс не мог написать комментарий: путь записи веба обязан
        // идти через argv CLI, иначе появляется второй CRDT-движок (S38, S40 —
        // оба раза молчаливая потеря записей).
        const replyInput = flagStr(ctx, "reply-to");
        if (replyInput !== undefined) {
          const target = resolveId(h, replyInput);
          if (!target.ok) return target.failure;
          try {
            h.store.addEdge(node.id, "replies_to", target.node.id);
          } catch (e) {
            return graphFailure(e);
          }
          repliesTo = target.node.id;
          // Ограждение против повторного расхождения (S64). Вид узла у
          // комментария ровно один — note+attrs.type='comment'; `message` это
          // L0, сырой диалог сессии, и его тело через 14 суток уезжает в
          // bodies_cold, а в векторный индекс L0 не попадает вовсе. Ответ
          // kind='message' на задачу или заметку — это комментарий, записанный
          // в вид, который через две недели станет пустой строкой. Отказать
          // нельзя (нить межагентских сообщений — законное применение), но
          // молчать здесь значит завести четвёртую поверхность записи.
          if (spec.kind === "message" && target.node.kind !== "message" && target.node.kind !== "session") {
            ctx.warn(
              "comment.kind_wrong",
              `ответ на ${target.node.kind} записан как kind='message' — это слой L0, сырой диалог ` +
                `сессии: по проекту его тело через 14 суток уезжает в bodies_cold, а в векторный ` +
                `индекс L0 не попадает. Комментарий — это ` +
                `\`myc comment ${target.node.id} <текст>\`: kind=note, attrs.type='comment' (S64)`,
            );
          }
        }

        const parentInput = flagStr(ctx, "parent");
        if (parentInput !== undefined) {
          const parent = resolveId(h, parentInput);
          if (!parent.ok) return parent.failure;
          try {
            h.store.addEdge(node.id, "parent", parent.node.id);
          } catch (e) {
            return graphFailure(e);
          }
        }

        const data: CreateData = {
          id: node.id,
          ...(repliesTo !== undefined ? { replies_to: repliesTo } : {}),
          kind: node.kind,
          type: spec.type ?? node.kind,
          title: node.title,
          status: node.status,
          priority: node.priority,
          blocked_by: blockedBy,
          anchors,
          repo: readRepo(node.attrs).by === "absent" ? null : readRepo(node.attrs).repo,
          repo_reason: repoReasonText(h.repo),
          ...(bRaw === "-" ? { body_stdin_chars: body!.length } : {}),
          took_ms: tookMs(t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderCreateHuman,
  };
}

export function createCreateCommand(deps: StoreDeps = realStoreDeps): Command {
  return buildCreateCommand("create", "create a node (task, memory, decision, …)", undefined, deps);
}

export function createTaskCommand(deps: StoreDeps = realStoreDeps): Command {
  return buildCreateCommand("task", "create a task (alias of create --kind task)", CLI_KINDS["task"], deps);
}

export function createBugCommand(deps: StoreDeps = realStoreDeps): Command {
  return buildCreateCommand("bug", "create a bug (task, default P1)", CLI_KINDS["bug"], deps);
}

export function createEpicCommand(deps: StoreDeps = realStoreDeps): Command {
  return buildCreateCommand("epic", "create an epic", CLI_KINDS["epic"], deps);
}

export function createMsgCommand(deps: StoreDeps = realStoreDeps): Command {
  return buildCreateCommand("msg", "create a message node (inter-agent threads)", CLI_KINDS["message"], deps);
}

// ---------------------------------------------------------------------------
// myc comment — единственный вид узла для комментария (S64)
// ---------------------------------------------------------------------------

interface CommentData {
  id: string;
  replies_to: string;
  target_title: string;
  kind: string;
  type: string;
  title: string;
  actor: string;
  body_stdin_chars?: number;
  took_ms: number;
}

function renderCommentHuman(raw: unknown): string {
  const d = raw as CommentData;
  const lines = [
    `${d.id}  комментарий  ${d.actor}`,
    `к         ${d.replies_to}  ${d.target_title}`,
    `текст     ${d.title}`,
  ];
  if (d.body_stdin_chars !== undefined) {
    lines.push(`body      ${d.body_stdin_chars} симв из stdin`);
  }
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

/**
 * `myc comment <target> [текст]` — КАНОНИЧЕСКИЙ писатель комментария (S64).
 *
 * Вид узла у комментария ровно один: kind='note', layer=1,
 * attrs.type='comment', ребро `replies_to` на адресата. Это та же форма, что
 * пишет `mcp addNote` и что ввозит `import-beads`, — то есть все писатели
 * сошлись, и читателю не приходится угадывать, какая поверхность оставила
 * запись. Нить при этом определяется РЕБРОМ, а не видом: читатель, который
 * фильтрует по kind, ломается на первой же чужой записи (memory-1nh192mztcqy —
 * веб показывал ноль из девяти существовавших комментариев).
 *
 * Почему НЕ kind='message', хотя имя ближе. `message` — это L0, сырой диалог
 * сессии (docs/design/01-core-data-model.md §5.1): его тело через 14 суток
 * уезжает в bodies_cold, а FTS-строки удаляются; в векторный индекс L0 не
 * попадает вовсе; обязательные attrs — session_id/role/ord/thread_root,
 * которых у комментария к задаче нет; статус допустим ровно один — active.
 * Комментарий к задаче — постоянная история проекта, его ищут через полгода.
 * `note` L1 хранится бессрочно, индексируется и ищется.
 */
export function createCommentCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "comment",
    summary: "comment on a node: a note joined to it by a replies_to edge",
    flags: [
      { name: "body", short: "b", value: "string", description: "comment text; '-' reads stdin" },
      { name: "acl", value: "string", description: "private|team|restricted|agent" },
      AS_FLAG,
    ],
    help:
      "myc comment <target> [text] — the one way to write a comment. Creates kind=note, layer=1, " +
      "attrs.type='comment' and a replies_to edge to the target; the same shape mcp addNote writes " +
      "and import-beads imports. Threads are read by the EDGE, never by node kind. " +
      "Text is the positional argument or -b; '-' reads stdin.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const targetInput = ctx.args[0];
      if (targetInput === undefined || targetInput.trim().length === 0) {
        return failure("usage.invalid", "нужен адресат: myc comment <target> <текст>", ExitCode.USAGE);
      }
      let text = ctx.args.slice(1).join(" ").trim();
      const bRaw = flagStr(ctx, "body");
      let fromStdin = false;
      if (bRaw === "-") {
        text = (await new Response(Bun.stdin.stream()).text()).trim();
        fromStdin = true;
      } else if (bRaw !== undefined) {
        text = bRaw;
      }
      if (text.length === 0) {
        return failure(
          "usage.invalid",
          "нужен текст комментария: myc comment <target> <текст> либо -b -",
          ExitCode.USAGE,
        );
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const target = resolveId(h, targetInput);
        if (!target.ok) return target.failure;
        // Форму узла задаёт ЯДРО (commentInput, S64) — одна на mcp addNote,
        // на эту команду и на import-beads. Собирать её здесь заново значило
        // бы завести четвёртый вид комментария при первой же правке.
        let node: NodeRecord;
        try {
          node = h.store.createNode(
            commentInput({
              text,
              scope: h.scope,
              actor: h.actor,
              ...(flagStr(ctx, "acl") !== undefined ? { acl: flagStr(ctx, "acl")! } : {}),
            }),
          );
        } catch (e) {
          return graphFailure(e);
        }
        try {
          h.store.addEdge(node.id, "replies_to", target.node.id);
        } catch (e) {
          return graphFailure(e);
        }
        const data: CommentData = {
          id: node.id,
          replies_to: target.node.id,
          target_title: target.node.title,
          kind: node.kind,
          type: "comment",
          title: node.title,
          actor: node.actor,
          ...(fromStdin ? { body_stdin_chars: text.length } : {}),
          took_ms: tookMs(t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderCommentHuman,
  };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

interface UpdateData {
  id: string;
  kind: string;
  type: string;
  status: string;
  priority: number;
  changed: string[];
  /** Кого отпустила отмена: у `cancelled` тот же терминальный эффект, что у закрытия. */
  unblocked?: string[];
  /** Прежний и новый эпик, если менялась иерархия: перенос обязан быть виден. */
  parent_from?: string | null;
  parent_to?: string | null;
  took_ms: number;
}

function renderUpdateHuman(raw: unknown): string {
  const d = raw as UpdateData;
  const head = [d.id, d.type];
  if (d.kind === "task") head.push(fmtPriority(d.priority));
  head.push(d.status, `updated: ${d.changed.join(", ")}`);
  const lines = [head.join("  ")];
  if (d.parent_to !== undefined || d.parent_from !== undefined) {
    const from = d.parent_from ?? "без эпика";
    const to = d.parent_to ?? "без эпика";
    lines.push(`эпик: ${from} → ${to}`);
  }
  if (d.unblocked !== undefined && d.unblocked.length > 0) {
    lines.push(`unblocked ${d.unblocked.join(", ")}   (теперь ready)`);
  }
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

/**
 * Статус задачи не назначается, а вычисляется или зарабатывается (S54).
 *
 * `myc update --status` писал статус напрямую, ничего не зная про механизмы,
 * которые этот статус поддерживают. Четыре расхождения, все воспроизведены на
 * живом воркспейсе:
 *
 *  1. `in_progress` без аренды: `lease_holder` пуст, и `claim` другого
 *     исполнителя проходит по ветке CAS «status='in_progress' AND
 *     lease_expires < now» — она задумана для подбора БРОШЕННОЙ работы. Переход
 *     печатается как `in_progress→in_progress`, то есть двойное владение не
 *     видно ни на одной доске.
 *  2. `open` при живой чужой аренде: задача попадает в `ready`, но захватить её
 *     нельзя — CAS отказывает. Призрак: очередь предлагает работу, которую
 *     никто не может взять.
 *  3. `blocked` без блокеров: `open_blockers` = 0, а задача спрятана из `ready`.
 *     Доска врёт, и работоспособная задача теряется.
 *  4. `closed` мимо `myc close`: без проверки владения, без причины и без
 *     отчёта о том, кого разблокировало.
 *
 * Отсюда правило: механизм, который поддерживает статус, и есть единственный
 * путь к нему. `cancelled` — исключение: это человеческое СУЖДЕНИЕ о том, нужна
 * ли работа вообще, и решать его агенту нечем. Но и оно обязано показать
 * последствие, поэтому отчёт о разблокированных печатает сам `update`.
 */
function guardTaskStatus(
  h: StoreHandle,
  node: NodeRecord,
  next: string,
): CommandFailure | undefined {
  if (node.kind !== "task") return undefined;
  if (next === node.status) return undefined;

  if (next === "in_progress") {
    return failure(
      "precond.use_claim",
      `${node.id}: «в работе» берётся арендой, а не записью статуса — иначе задачу одновременно считают своей двое`,
      ExitCode.PRECOND,
      `myc claim ${node.id}`,
    );
  }
  if (next === "blocked") {
    return failure(
      "precond.derived",
      `${node.id}: «заблокирована» вычисляется из открытых блокеров (сейчас их ${node.open_blockers}), а не выставляется вручную`,
      ExitCode.PRECOND,
      `myc dep add ${node.id} blocked-by <id>`,
    );
  }
  if (next === "closed") {
    return failure(
      "precond.use_close",
      `${node.id}: закрытие требует владения и причины и сообщает, кого разблокировало`,
      ExitCode.PRECOND,
      `myc close ${node.id} --reason "…"`,
    );
  }
  if (next === "open") {
    const lease = h.store.leaseOf(node.id);
    if (lease !== undefined && lease.holder.length > 0 && lease.expires > Date.now()) {
      return failure(
        "conflict.claimed",
        `${node.id} взята ${lease.holder} (аренда до ${new Date(lease.expires).toISOString().slice(11, 19)}Z); статус open при живой аренде делает задачу невзятной: она видна в ready, а claim отказывает`,
        ExitCode.CONFLICT,
        `myc release ${node.id}${lease.holder !== h.actor ? " --force" : ""}`,
      );
    }
  }
  return undefined;
}

export function createUpdateCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "update",
    summary: "update fields of a node",
    flags: [
      { name: "title", value: "string", description: "new title" },
      { name: "body", short: "b", value: "string", description: "new body; '-' reads stdin" },
      { name: "status", value: "string", description: "new status (validated per kind)" },
      { name: "priority", short: "p", value: "string", description: "P0|P1|P2|P3 or 0|1|2|3" },
      { name: "tag", value: "string", description: "replace tags (comma-separated)" },
      { name: "assign", value: "string", description: "assignee; empty string unassigns" },
      { name: "estimate", value: "string", description: "estimate, e.g. 30m, 2h" },
      { name: "acl", value: "string", description: "private|team|restricted|agent" },
      { name: "parent", value: "string", description: "move under this epic" },
      { name: "no-parent", description: "detach from the current epic" },
      AS_FLAG,
    ],
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return failure("usage.invalid", "нужен id: myc update <id> [flags]", ExitCode.USAGE);
      }

      const pRaw = flagStr(ctx, "priority");
      let priority: number | undefined;
      if (pRaw !== undefined) {
        priority = parsePriority(pRaw);
        if (priority === undefined) {
          return failure("usage.invalid", `неверный приоритет '${pRaw}'; допустимы P0..P3 или 0..3`, ExitCode.USAGE);
        }
      }
      const eRaw = flagStr(ctx, "estimate");
      let estimateMin: number | undefined;
      if (eRaw !== undefined) {
        const dur = parseDuration(eRaw);
        if (dur === undefined) {
          return failure("usage.invalid", `неверная оценка '${eRaw}'; формат 30m, 2h, 1d`, ExitCode.USAGE);
        }
        estimateMin = Math.round(dur / 60_000);
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;

        const patch: Record<string, unknown> = {};
        const changed: string[] = [];
        const title = flagStr(ctx, "title");
        if (title !== undefined) {
          patch["title"] = title;
          changed.push("title");
        }
        const bRaw = flagStr(ctx, "body");
        let body: string | undefined;
        if (bRaw === "-") body = await new Response(Bun.stdin.stream()).text();
        else if (bRaw !== undefined) body = bRaw;
        if (body !== undefined) {
          patch["body"] = body;
          changed.push("body");
        }
        const status = flagStr(ctx, "status");
        if (status !== undefined) {
          const guard = guardTaskStatus(h, node, status);
          if (guard !== undefined) return guard;
          patch["status"] = status;
          changed.push("status");
        }
        if (priority !== undefined) {
          patch["priority"] = priority;
          changed.push("priority");
        }
        const assign = flagStr(ctx, "assign");
        if (assign !== undefined) {
          patch["assignee"] = assign;
          changed.push("assignee");
        }
        const acl = flagStr(ctx, "acl");
        if (acl !== undefined) {
          patch["acl"] = acl;
          changed.push("acl");
        }

        const attrs: Record<string, JsonValue> = {};
        const tagRaw = flagStr(ctx, "tag");
        if (tagRaw !== undefined) {
          attrs["tags"] = splitList(tagRaw);
          changed.push("tags");
        }
        if (estimateMin !== undefined) {
          attrs["estimate_min"] = estimateMin;
          changed.push("estimate");
        }
        if (Object.keys(attrs).length > 0) patch["attrs"] = attrs;

        // Перенос между эпиками. Ребро `parent` — дерево, а не DAG: у узла в
        // любой момент не больше одного живого родителя. `store.addEdge` сам
        // гасит старое ребро в оплоге и переносит `parent_closure` одним
        // `applyParentMove` ВНУТРИ ОДНОЙ транзакции (`db.tx("immediate")`),
        // поэтому здесь один вызов, а не пара remove+add: пара — это две
        // транзакции, и обрыв между ними оставил бы узел без родителя.
        //
        // Честно: тесты этого файла разницы между одним вызовом и парой НЕ
        // видят — в одном процессе без обрыва конечное состояние и число
        // операций оплога (2) совпадают. Инвариант принадлежит store и
        // проверяется там: closure.test.ts, «перенос поддерева из 500 узлов
        // сходится с независимым пересчётом» и «перенос под собственного
        // потомка отклоняется как цикл, состояние не меняется».
        const parentRaw = flagStr(ctx, "parent");
        const detach = flagBool(ctx, "no-parent");
        if (parentRaw !== undefined && detach) {
          return failure(
            "usage.invalid",
            "--parent и --no-parent взаимно исключают друг друга",
            ExitCode.USAGE,
          );
        }
        let parentFrom: string | null | undefined;
        let parentTo: string | null | undefined;
        if (parentRaw !== undefined || detach) {
          const current = h.store.edgesFrom(node.id, "parent")[0]?.dst ?? null;
          if (detach) {
            if (current === null) {
              return failure(
                "precond.no_parent",
                `${node.id} и так не входит ни в один эпик`,
                ExitCode.PRECOND,
              );
            }
            try {
              h.store.removeEdge(node.id, "parent", current);
            } catch (e) {
              return graphFailure(e);
            }
            parentFrom = current;
            parentTo = null;
            changed.push("parent");
          } else {
            const parent = resolveId(h, parentRaw!);
            if (!parent.ok) return parent.failure;
            if (parent.node.id === node.id) {
              return failure(
                "precond.self_parent",
                `${node.id} не может входить сам в себя`,
                ExitCode.PRECOND,
              );
            }
            if (current === parent.node.id) {
              return failure(
                "precond.same_parent",
                `${node.id} уже входит в ${parent.node.id}`,
                ExitCode.PRECOND,
              );
            }
            try {
              // Цикл и глубину проверяет замыкание (ClosureError
              // closure.cycle/closure.depth) — своей копии обхода здесь нет.
              h.store.addEdge(node.id, "parent", parent.node.id);
            } catch (e) {
              return graphFailure(e);
            }
            parentFrom = current;
            parentTo = parent.node.id;
            changed.push("parent");
          }
        }

        if (changed.length === 0) {
          return failure("usage.invalid", "нечего обновлять: ни одного флага изменения", ExitCode.USAGE);
        }

        let updated: NodeRecord;
        try {
          updated = h.store.updateNode(node.id, patch);
        } catch (e) {
          return graphFailure(e);
        }

        // Отмена терминальна наравне с закрытием (триггер trg_st_close считает
        // closed, cancelled, superseded и retracted одинаково), поэтому она
        // ВЫПУСКАЕТ зависимые задачи в очередь. Молчать об этом нельзя: человек
        // отменяет работу как ненужную, а следом кто-то берётся за то, что на
        // ней стояло, — и не узнает, что основание отменено (S54).
        const unblocked: string[] = [];
        if (updated.status === "cancelled" && updated.kind === "task") {
          for (const edge of h.store.edgesFrom(updated.id, "blocks")) {
            const dependent = h.store.getNode(edge.dst);
            // anc_blockers тоже проверяется: задача, у которой блокер остался
            // на эпике, в очередь НЕ вышла, и называть её разблокированной
            // значило бы обещать работу, которой в `ready` нет (миграция 10).
            if (
              dependent !== undefined &&
              dependent.status === "open" &&
              dependent.open_blockers === 0 &&
              dependent.anc_blockers === 0
            ) {
              unblocked.push(dependent.id);
            }
          }
        }

        const data: UpdateData = {
          id: updated.id,
          kind: updated.kind,
          type: nodeType(updated),
          status: updated.status,
          priority: updated.priority,
          changed,
          ...(unblocked.length > 0 ? { unblocked } : {}),
          ...(parentTo !== undefined ? { parent_from: parentFrom ?? null, parent_to: parentTo } : {}),
          took_ms: tookMs(t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderUpdateHuman,
  };
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

type LeaseSource = "flag" | "estimate" | "capped" | "floor" | "default";

const LEASE_WHY: Record<LeaseSource, string> = {
  flag: "",
  estimate: " по оценке",
  capped: " предел суток",
  floor: " минимум",
  default: "",
};

interface ClaimData {
  id: string;
  holder: string;
  epoch: number;
  lease_expires: number;
  lease_ttl_ms: number;
  /**
   * Что РЕШИЛО срок: явный флаг, оценка задачи, верхний предел суток, нижняя
   * граница в 30 минут или умолчание при отсутствии оценки. Человеку важна
   * причина: «аренда 1d» из оценки в 2 дня и из оценки в 30 дней — разные
   * новости.
   */
  lease_source: LeaseSource;
  status: string;
  prev_status: string;
  type: string;
  priority: number;
  renewed?: boolean;
  stolen_from?: string;
  expired_ago_ms?: number;
  took_ms: number;
}

function renderClaimHuman(raw: unknown): string {
  const d = raw as ClaimData;
  let head: string;
  if (d.renewed === true) {
    head = `renewed ${d.id} by ${d.holder} · аренда ${fmtAge(d.lease_ttl_ms)} до ${fmtClock(d.lease_expires)}`;
    return `${head}\n`;
  }
  head = `claimed ${d.id} by ${d.holder}`;
  if (d.stolen_from !== undefined) {
    head += ` (отобрана у ${d.stolen_from}, аренда истекла ${fmtAge(d.expired_ago_ms ?? 0)} назад)`;
  } else {
    const why = LEASE_WHY[d.lease_source];
    head += ` · аренда ${fmtAge(d.lease_ttl_ms)}${why} до ${fmtClock(d.lease_expires)}`;
  }
  return `${head}\n${d.id} ${fmtPriority(d.priority)} ${d.type} ${d.prev_status}→in_progress\n`;
}

interface ReleaseData {
  readonly id: string;
  readonly status: "open";
  readonly released_from: string;
  readonly forced: boolean;
  readonly took_ms: number;
}

/**
 * Отпустить взятую задачу: аренда снимается, статус возвращается в `open`.
 *
 * Команды не было вовсе, и это делало дыру неизбежной: единственным очевидным
 * способом отдать задачу оставался `myc update --status open`, который снимал
 * статус, но НЕ аренду. Получался призрак — задача в `ready`, взять её нельзя,
 * CAS отказывает по живой аренде. Отказ в `guardTaskStatus` имеет смысл только
 * при наличии этой команды: запрещать путь, не дав другого, — не защита.
 *
 * `--force` отбирает ЖИВУЮ чужую аренду и говорит об этом громко: у прежнего
 * держателя могут остаться правки в рабочем дереве, и молчать здесь нельзя.
 */
export function createReleaseCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "release",
    summary: "give up a claimed task: lease cleared, status back to open",
    flags: [
      { name: "force", description: "take away a LIVE lease held by someone else (WARNs)" },
      AS_FLAG,
    ],
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return failure("usage.invalid", "нужен id: myc release <id>", ExitCode.USAGE);
      }
      const force = ctx.flags["force"] === true;

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;

        const lease = h.store.leaseOf(node.id);
        if (lease === undefined || lease.holder.length === 0) {
          return failure(
            "precond.not_claimed",
            `${node.id} никем не взята — отпускать нечего`,
            ExitCode.PRECOND,
          );
        }
        if (lease.holder !== h.actor && !force) {
          return failure(
            "conflict.claimed",
            `${node.id} взята ${lease.holder} (аренда до ${fmtClock(lease.expires)}); отпустить чужую можно только явно`,
            ExitCode.CONFLICT,
            `myc release ${node.id} --force`,
          );
        }
        if (lease.holder !== h.actor) {
          ctx.warn(
            "release.forced",
            `аренда отобрана у ${lease.holder}; его правки могут быть в рабочем дереве`,
          );
        }
        if (!h.store.releaseLease(node.id, lease.holder, lease.epoch)) {
          return failure(
            "conflict.claimed",
            `${node.id}: владение уже перешло (эпоха устарела) — отпускать нечего`,
            ExitCode.CONFLICT,
          );
        }
        const data: ReleaseData = {
          id: node.id,
          status: "open",
          released_from: lease.holder,
          forced: lease.holder !== h.actor,
          took_ms: tookMs(t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as ReleaseData;
      return `${d.id} отпущена (была у ${d.released_from})${d.forced ? " — принудительно" : ""} → open
`;
    },
  };
}

export function createClaimCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "claim",
    summary: "atomically take a task (CAS lease, §9.4)",
    flags: [
      { name: "lease", value: "string", description: "lease TTL, e.g. 30m (default), 2h" },
      { name: "steal", description: "take over an expired lease (WARNs about the previous owner)" },
      AS_FLAG,
    ],
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return failure("usage.invalid", "нужен id: myc claim <id>", ExitCode.USAGE);
      }

      let ttl: number | undefined;
      const leaseRaw = flagStr(ctx, "lease");
      if (leaseRaw !== undefined) {
        const dur = parseDuration(leaseRaw);
        if (dur === undefined) {
          return failure("usage.invalid", `неверная аренда '${leaseRaw}'; формат 30m, 2h`, ExitCode.USAGE);
        }
        ttl = dur;
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;

        if (node.status === "closed" || node.status === "cancelled") {
          return failure("precond.closed", `${node.id} уже ${node.status}`, ExitCode.PRECOND);
        }
        if (node.open_blockers > 0) {
          return failure(
            "precond.blocked",
            `${node.id} заблокирована ${node.open_blockers} открытыми зависимостями`,
            ExitCode.PRECOND,
            `myc dep why ${node.id}`,
          );
        }
        // НАСЛЕДОВАННАЯ блокировка (миграция 10) захват НЕ запрещает, но
        // обязана быть названа. Разница с прямым блокером не в силе, а в том,
        // кто принимает решение: очередь такую задачу не предлагает (агент её
        // и не увидит), а `myc claim <id>` — это явный приказ человека или
        // координатора «делай именно это», и отменять его молчаливым отказом
        // не за что. Молчать тоже нельзя: в собственных deps задачи блокера
        // нет вовсе, и без этой строки исполнитель не узнает, что работает
        // внутри эпика, который ещё ждёт (И2).
        if (node.anc_blockers > 0) {
          const via = h.store
            .blockingAncestors(node.id)
            .map((a) => `${a.id} (${a.open_blockers})`)
            .join(", ");
          ctx.warn(
            "task.blocked_via_parent",
            `${node.id} не в ready: блокер на предке ${via} — работа встанет на неготовое основание`,
          );
        }

        // Срок аренды по УМОЛЧАНИЮ берётся из оценки задачи, а не из
        // фиксированных 30 минут. Причина найдена работой (2026-09-05): аренда
        // спроектирована под «агент держит задачу и шлёт heartbeat», но в
        // схеме координатор-агент claim делает координатор, процесс завершается,
        // и продлевать нечем. Задача с оценкой 2d показывалась EXPIRED через
        // 58 минут ПРИ ЖИВОМ ИСПОЛНИТЕЛЕ — то есть очередь врала о свободном.
        //
        // Оценка уже есть у задачи и ставится координатором при заведении;
        // магических чисел в голове не требуется. Без оценки поведение
        // прежнее — 30 минут.
        const estimated = estimateMin(node);
        let leaseSource: LeaseSource = "flag";
        if (ttl === undefined) {
          if (estimated === undefined) {
            leaseSource = "default";
            ttl = DEFAULT_LEASE_MS;
          } else {
            const wanted = estimated * 60_000;
            // Источник называется по тому, что РЕШИЛО число, а не по тому, что
            // его предложило: оценка в 10 минут даёт 30-минутную аренду из-за
            // нижней границы, и назвать это «по оценке» значит соврать
            // читателю о причине.
            if (wanted > MAX_LEASE_MS) {
              leaseSource = "capped";
              ttl = MAX_LEASE_MS;
            } else if (wanted < DEFAULT_LEASE_MS) {
              leaseSource = "floor";
              ttl = DEFAULT_LEASE_MS;
            } else {
              leaseSource = "estimate";
              ttl = wanted;
            }
          }
        }

        const now = Date.now();
        const before = h.store.leaseOf(node.id);
        const expiredBy =
          before !== undefined &&
          before.holder.length > 0 &&
          before.holder !== h.actor &&
          before.expires > 0 &&
          before.expires <= now
            ? before
            : undefined;

        const ticket = h.claims.claim(node.id, ttl);
        if (ticket !== undefined) {
          if (expiredBy !== undefined) {
            ctx.warn(
              "claim.stolen",
              "предыдущий владелец не закрыл задачу; его правки могут быть в рабочем дереве",
            );
          }
          const data: ClaimData = {
            id: node.id,
            holder: h.actor,
            epoch: ticket.epoch,
            lease_expires: ticket.expiresAt,
            lease_ttl_ms: ttl,
            lease_source: leaseSource,
            status: "in_progress",
            prev_status: node.status,
            type: nodeType(node),
            priority: node.priority,
            ...(expiredBy !== undefined
              ? { stolen_from: expiredBy.holder, expired_ago_ms: now - expiredBy.expires }
              : {}),
            took_ms: tookMs(t0),
          };
          return { ok: true, data, meta: { took_ms: data.took_ms } };
        }

        // CAS проигран: либо свой продлеваем (идемпотентный повтор), либо конфликт.
        const lease = h.store.leaseOf(node.id);
        if (
          lease !== undefined &&
          lease.holder === h.actor &&
          lease.epoch > 0 &&
          (lease.expires === 0 || lease.expires > now)
        ) {
          const expires = h.store.renewLease(node.id, h.actor, lease.epoch, ttl);
          if (expires !== undefined) {
            const data: ClaimData = {
              id: node.id,
              holder: h.actor,
              epoch: lease.epoch,
              lease_expires: expires,
              lease_ttl_ms: ttl,
              lease_source: leaseSource,
              status: "in_progress",
              prev_status: "in_progress",
              type: nodeType(node),
              priority: node.priority,
              renewed: true,
              took_ms: tookMs(t0),
            };
            return { ok: true, data, meta: { took_ms: data.took_ms } };
          }
        }
        if (lease !== undefined && lease.holder.length > 0) {
          return failure(
            "conflict.claimed",
            `${node.id} уже взята ${lease.holder} (аренда до ${fmtClock(lease.expires)})`,
            ExitCode.CONFLICT,
            `дождаться истечения аренды или myc claim ${node.id} --steal`,
          );
        }
        return failure("conflict.claimed", `${node.id} недоступна для захвата`, ExitCode.CONFLICT);
      } finally {
        h.close();
      }
    },
    renderHuman: renderClaimHuman,
  };
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

const VERIFY_MODES = ["tests", "review", "human", "none"] as const;
const OUTCOMES = ["done", "wontfix", "duplicate", "superseded"] as const;

function fmtTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

/**
 * Атрибуция закрытия (W11). Координатор называет ОДНО — вердикт; модель,
 * харнесс, класс задачи и токены уже лежат в открытой попытке, которую
 * завёл исполнитель (`myc attempt start`). Если попытки нет, а модель
 * названа, попытка заводится и закрывается здесь же — по-прежнему без
 * ручного ввода харнесса, уровня и класса.
 *
 * Ничего не записалось — сказано вслух (`skipped` + WARN), а не молча:
 * ровно на молчании схема исхода и простояла пустой на 85 закрытых
 * задачах этого воркспейса.
 */
interface AttributionData {
  recorded: boolean;
  attempt_id?: string;
  model_id?: string;
  task_class?: string;
  verdict?: string;
  caveats?: string[];
  quality?: number;
  cost_usd?: number | null;
  cost_basis?: string | null;
  /** Откуда взят расход: flags | transcript | recorded | none. */
  spend_via?: string;
  skipped?: string;
}

interface CloseData {
  id: string;
  status: string;
  closed_by: string;
  already?: boolean;
  in_progress_ms?: number;
  unblocked: string[];
  outcome?: Record<string, unknown>;
  attribution?: AttributionData;
  took_ms: number;
}

function renderCloseHuman(raw: unknown): string {
  const d = raw as CloseData;
  if (d.already === true) return `${d.id} уже ${d.status}\n`;
  const headParts = [`closed ${d.id}`];
  if (d.in_progress_ms !== undefined) headParts.push(`in_progress ${fmtAge(d.in_progress_ms)}`);
  headParts.push(`@${d.closed_by}`);
  const lines = [headParts.join(" · ")];
  if (d.unblocked.length > 0) {
    lines.push(`unblocked ${d.unblocked.join(", ")}   (теперь ready)`);
  }
  const oc = d.outcome;
  if (oc !== undefined) {
    const parts: string[] = [];
    if (typeof oc["verify"] === "string") parts.push(`verify=${oc["verify"]}`);
    if (typeof oc["model"] === "string") parts.push(`model=${oc["model"]}`);
    if (typeof oc["cost_in"] === "number" || typeof oc["cost_out"] === "number") {
      const ci = typeof oc["cost_in"] === "number" ? oc["cost_in"] : 0;
      const co = typeof oc["cost_out"] === "number" ? oc["cost_out"] : 0;
      parts.push(`in ${fmtTokens(ci)} / out ${fmtTokens(co)}`);
    }
    if (parts.length > 0) lines.push(`outcome  записан (${parts.join(", ")})`);
  }
  const at = d.attribution;
  if (at !== undefined) {
    if (at.recorded) {
      const caveats = at.caveats ?? [];
      lines.push(
        `атрибуция ${at.model_id} · ${at.task_class} · ${at.verdict}` +
          `${caveats.length > 0 ? ` (оговорки: ${caveats.join(", ")})` : ""}` +
          ` · q=${(at.quality ?? 0).toFixed(2)}`,
      );
    } else if (at.skipped !== undefined) {
      lines.push(`атрибуция НЕ записана: ${at.skipped}`);
    }
  }
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}


// ---------------------------------------------------------------------------
// Атрибуция закрытия (W11)
// ---------------------------------------------------------------------------

type AttributionPlan =
  | { readonly kind: "none"; readonly skipped?: string; readonly warn?: readonly [string, string] }
  | { readonly kind: "finish"; readonly attempt: AttemptRecord }
  | { readonly kind: "retro"; readonly modelId: string; readonly taskClass: string };

interface PreparedAttribution {
  readonly plan: AttributionPlan;
  /** Канонический id модели из ростера — им и заполняется attrs.outcome. */
  readonly canonicalModel?: string;
}

function swarmTableExists(h: StoreHandle): boolean {
  return (
    h.driver.database
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'swarm_attempt'")
      .get() !== null
  );
}

/**
 * Что делать с атрибуцией — решается ДО смены статуса задачи. Неизвестная
 * ростеру модель обязана остановить закрытие целиком: закрытая задача с
 * моделью-самозванкой хуже незакрытой, потому что выглядит учтённой.
 */
function prepareAttribution(
  ctx: CommandContext,
  h: StoreHandle,
  node: NodeRecord,
  verdict: string | undefined,
): PreparedAttribution | CommandFailure {
  // $MYC_MODEL подхватывается ТОЛЬКО когда исход действительно пишется.
  // Иначе переменная окружения, выставленная харнессом, начала бы решать,
  // закроется ли задача вообще, — закрытие не имеет права зависеть от того,
  // есть ли в ростере модель, которой никто не пользовался.
  const modelFlag = flagStr(ctx, "model");
  const modelEnv = verdict === undefined ? undefined : process.env["MYC_MODEL"];
  const modelRaw = modelFlag ?? modelEnv;
  if (verdict === undefined && modelRaw === undefined) {
    if (!swarmTableExists(h)) return { plan: { kind: "none" } };
    const open = swarmOn(h.driver.database).attribution.openAttemptForTask(node.id);
    if (open === undefined) return { plan: { kind: "none" } };
    return {
      plan: {
        kind: "none",
        skipped: `открытая попытка ${open.attemptId} осталась без исхода`,
        warn: [
          "attribution.open",
          `у ${node.id} открыта попытка ${open.attemptId}; закрытие без --verdict оставляет её без исхода`,
        ],
      },
    };
  }

  const swarm = swarmOn(h.driver.database);
  let canonicalModel: string | undefined;
  let modelRejected: string | undefined;
  if (modelRaw !== undefined) {
    const resolved = resolveModelId(swarm.roster, modelRaw);
    if (!resolved.ok) {
      // Названо флагом — ошибка: человек сказал ровно это, и молча писать
      // не ту модель нельзя. Пришло из окружения — громкая деградация:
      // чужая переменная не должна мешать закрыть задачу.
      if (modelFlag !== undefined) return resolved.failure;
      modelRejected = modelRaw;
      ctx.warn(
        "attribution.env_model",
        `$MYC_MODEL="${modelRaw}" мимо ростера: ${resolved.failure.msg}`,
      );
    } else {
      canonicalModel = resolved.modelId;
    }
  }
  if (verdict === undefined) return { plan: { kind: "none" }, canonicalModel };

  const open = swarm.attribution.openAttemptForTask(node.id);
  if (open !== undefined) {
    return { plan: { kind: "finish", attempt: open }, canonicalModel: canonicalModel ?? open.modelId };
  }
  if (canonicalModel === undefined) {
    return {
      plan: {
        kind: "none",
        skipped:
          modelRejected === undefined
            ? "нет открытой попытки и не названа модель"
            : `нет открытой попытки, а модель "${modelRejected}" не из ростера`,
        warn: [
          "attribution.no_model",
          `${node.id}: исход в статистику роя не попал — ` +
            (modelRejected === undefined
              ? "вердикт назван, а модель нет"
              : `модель "${modelRejected}" не из ростера`) +
            " (myc attempt start <id> --model … или --model на закрытии)",
        ],
      },
    };
  }
  return {
    plan: {
      kind: "retro",
      modelId: canonicalModel,
      taskClass: taskClassOf(node, h.driver.database, node.id),
    },
    canonicalModel,
  };
}

/** Исполнение плана: одна запись исхода, стоимость замораживается там же. */
function applyAttribution(
  ctx: CommandContext,
  h: StoreHandle,
  node: NodeRecord,
  plan: AttributionPlan,
  verdict: string,
  caveats: readonly Caveat[],
): AttributionData | CommandFailure {
  const swarm = swarmOn(h.driver.database);
  const tokens = tokenArgs(ctx);
  const legacyIn = ctx.flags["cost-in"];
  const legacyOut = ctx.flags["cost-out"];
  if (tokens.tokensIn === undefined && typeof legacyIn === "number") tokens.tokensIn = legacyIn;
  if (tokens.tokensOut === undefined && typeof legacyOut === "number") tokens.tokensOut = legacyOut;
  const retriesFlag = ctx.flags["retries"];

  try {
    const attemptId =
      plan.kind === "finish"
        ? plan.attempt.attemptId
        : swarm.attribution.startAttempt({
            taskId: node.id,
            modelId: (plan as { modelId: string }).modelId,
            taskClass: (plan as { taskClass: string }).taskClass,
            actor: h.actor,
            source: "close",
            ...tokens,
          }).attemptId;
    // Расход по ЗАПИСАННОЙ сессии попытки, если координатор не назвал
    // числа руками. Ради этого запись и заводилась: закрытие остаётся
    // одним флагом, а ось цены перестаёт быть пустой.
    const spend = recordedSpend(ctx, swarm.attribution, attemptId, { tokens });
    const done = swarm.attribution.finishAttempt(attemptId, {
      verdict,
      caveats,
      retries: typeof retriesFlag === "number" ? retriesFlag : undefined,
      ...spend.tokens,
    });
    return {
      recorded: true,
      attempt_id: done.attemptId,
      model_id: done.modelId,
      task_class: done.taskClass,
      verdict: done.verdict ?? verdict,
      caveats: [...done.caveats],
      quality: done.quality ?? 0,
      cost_usd: done.costUsd,
      cost_basis: done.costBasis,
      spend_via: spend.via,
    };
  } catch (e) {
    return attemptFailure(e);
  }
}

export function createCloseCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "close",
    summary: "close a task",
    flags: [
      { name: "reason", value: "string", description: "why / how it was resolved" },
      { name: "verify", value: "string", description: "tests|review|human|none" },
      { name: "outcome", value: "string", description: "done|wontfix|duplicate|superseded" },
      { name: "dup", value: "string", description: "canonical node id when --outcome duplicate" },
      { name: "cost-in", value: "number", description: "input tokens spent (synonym of --tokens-in)" },
      { name: "cost-out", value: "number", description: "output tokens spent (synonym of --tokens-out)" },
      { name: "tokens-in", value: "number", description: "input tokens spent ($MYC_TOKENS_IN)" },
      { name: "tokens-out", value: "number", description: "output tokens spent ($MYC_TOKENS_OUT)" },
      { name: "cache-read", value: "number", description: "cache-read tokens" },
      { name: "cache-write", value: "number", description: "cache-write tokens" },
      { name: "model", value: "string", description: "roster model that did the work (L4)" },
      {
        name: "verdict",
        value: "string",
        description: `acceptance verdict: ${VERDICTS.join("|")} (L4 attribution)`,
      },
      {
        name: "caveat",
        value: "string",
        description: `accepted-but: ${CAVEATS.join(", ")}`,
      },
      { name: "retries", value: "number", description: "rework rounds before acceptance (L4)" },
      AS_FLAG,
    ],
    handler: async (ctx) => {
      const t0 = performance.now();
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return failure("usage.invalid", "нужен id: myc close <id>", ExitCode.USAGE);
      }
      const verify = flagStr(ctx, "verify");
      if (verify !== undefined && !(VERIFY_MODES as readonly string[]).includes(verify)) {
        return failure(
          "usage.invalid",
          `неверный --verify '${verify}'; допустимы ${VERIFY_MODES.join(", ")}`,
          ExitCode.USAGE,
        );
      }
      const outcome = flagStr(ctx, "outcome");
      if (outcome !== undefined && !(OUTCOMES as readonly string[]).includes(outcome)) {
        return failure(
          "usage.invalid",
          `неверный --outcome '${outcome}'; допустимы ${OUTCOMES.join(", ")}`,
          ExitCode.USAGE,
        );
      }
      const dupInput = flagStr(ctx, "dup");
      if (outcome === "duplicate" && dupInput === undefined) {
        return failure("usage.invalid", "--outcome duplicate требует --dup <id>", ExitCode.USAGE);
      }
      // Вердикт и оговорки разбираются ДО закрытия: опечатка в вердикте не
      // имеет права оставить задачу закрытой без атрибуции.
      const verdict = flagStr(ctx, "verdict");
      if (verdict !== undefined && !(VERDICTS as readonly string[]).includes(verdict)) {
        return failure(
          "usage.verdict",
          `неверный --verdict '${verdict}'; допустимы ${VERDICTS.join(", ")}`,
          ExitCode.USAGE,
        );
      }
      const caveats = caveatArgs(ctx);
      if (!Array.isArray(caveats)) return caveats;
      if (verdict === undefined && caveats.length > 0) {
        return failure(
          "usage.verdict",
          "--caveat без --verdict: оговорка бывает только у вердикта",
          ExitCode.USAGE,
        );
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;

        if (node.status === "closed" || node.status === "cancelled") {
          const data: CloseData = {
            id: node.id,
            status: node.status,
            closed_by: node.assignee || h.actor,
            already: true,
            unblocked: [],
            took_ms: tookMs(t0),
          };
          return { ok: true, data, meta: { took_ms: data.took_ms } };
        }
        if (node.status === "blocked") {
          return failure(
            "precond.blocked",
            `${node.id} заблокирована; сначала закройте зависимости`,
            ExitCode.PRECOND,
            `myc dep why ${node.id}`,
          );
        }

        // План атрибуции готовится ДО смены статуса: неизвестная ростеру
        // модель обязана остановить закрытие, а не оставить задачу закрытой
        // с исходом, который потом не с чем связать.
        const prepared = prepareAttribution(ctx, h, node, verdict);
        if ("ok" in prepared) return prepared;

        const now = Date.now();
        const wasInProgress = node.status === "in_progress";
        const lease = h.store.leaseOf(node.id);
        if (wasInProgress && lease !== undefined && lease.holder.length > 0) {
          if (lease.holder !== h.actor) {
            return failure(
              "conflict.claimed",
              `${node.id} взята ${lease.holder}; закрыть может только владелец`,
              ExitCode.CONFLICT,
              `myc close ${node.id} --as ${lease.holder}`,
            );
          }
          if (!h.store.closeClaimed(node.id, lease.holder, lease.epoch)) {
            return failure(
              "conflict.claimed",
              `${node.id}: владение потеряно (эпоха устарела)`,
              ExitCode.CONFLICT,
            );
          }
        } else {
          try {
            h.store.updateNode(node.id, { status: "closed", closed_at: now });
          } catch (e) {
            return graphFailure(e);
          }
        }

        // L4-исход закрытия — холодные attrs, реплицируются поключево.
        const outcomeAttrs: Record<string, JsonValue> = {};
        const reason = flagStr(ctx, "reason");
        if (reason !== undefined) outcomeAttrs["reason"] = reason;
        if (verify !== undefined) outcomeAttrs["verify"] = verify;
        if (outcome !== undefined) outcomeAttrs["outcome"] = outcome;
        // В attrs пишется КАНОНИЧЕСКИЙ id из ростера, а не то, что набрали
        // руками: иначе строка исхода и ростер расходятся именами.
        if (prepared.canonicalModel !== undefined) {
          outcomeAttrs["model"] = prepared.canonicalModel;
        }
        const costIn = ctx.flags["cost-in"];
        const costOut = ctx.flags["cost-out"];
        const retries = ctx.flags["retries"];
        if (typeof costIn === "number") outcomeAttrs["cost_in"] = costIn;
        if (typeof costOut === "number") outcomeAttrs["cost_out"] = costOut;
        if (typeof retries === "number") outcomeAttrs["retries"] = retries;
        if (Object.keys(outcomeAttrs).length > 0) {
          try {
            h.store.updateNode(node.id, { attrs: { outcome: outcomeAttrs } });
          } catch (e) {
            return graphFailure(e);
          }
        }

        if (dupInput !== undefined) {
          const dup = resolveId(h, dupInput);
          if (!dup.ok) return dup.failure;
          try {
            h.store.addEdge(node.id, "duplicates", dup.node.id);
          } catch (e) {
            return graphFailure(e);
          }
        }

        // Кого разблокировало закрытие: прямые зависимые, для которых это был
        // последний открытый блокер (счётчики уже пересчитаны движком).
        // anc_blockers входит в условие по той же причине, что и в `ready`:
        // задача с блокером на эпике в очередь не вышла, и называть её
        // разблокированной — обещать работу, которой там нет (миграция 10).
        const unblocked: string[] = [];
        for (const edge of h.store.edgesFrom(node.id, "blocks")) {
          const dependent = h.store.getNode(edge.dst);
          if (
            dependent !== undefined &&
            dependent.status === "open" &&
            dependent.open_blockers === 0 &&
            dependent.anc_blockers === 0
          ) {
            unblocked.push(dependent.id);
          }
        }

        let attribution: AttributionData | undefined;
        if (verdict !== undefined && prepared.plan.kind !== "none") {
          const applied = applyAttribution(ctx, h, node, prepared.plan, verdict, caveats);
          if ("ok" in applied) {
            // Задача УЖЕ закрыта: отдать ошибку значило бы сказать, что не
            // произошло ничего. Громкая деградация (И2): закрытие состоялось,
            // исход — нет, причина названа. Под --strict это код выхода 7.
            ctx.warn("attribution.failed", `исход не записан: ${applied.msg}`);
            attribution = { recorded: false, skipped: applied.msg };
          } else {
            attribution = applied;
          }
        } else if (prepared.plan.kind === "none") {
          const skipped =
            prepared.plan.skipped ??
            (verdict !== undefined ? "исход записать не удалось" : undefined);
          if (prepared.plan.warn !== undefined) ctx.warn(...prepared.plan.warn);
          if (skipped !== undefined) attribution = { recorded: false, skipped };
        }

        const holder = lease !== undefined && lease.holder.length > 0 ? lease.holder : h.actor;
        const data: CloseData = {
          id: node.id,
          status: "closed",
          closed_by: holder,
          ...(wasInProgress ? { in_progress_ms: now - node.updated_at } : {}),
          unblocked,
          ...(Object.keys(outcomeAttrs).length > 0 ? { outcome: outcomeAttrs } : {}),
          ...(attribution !== undefined ? { attribution } : {}),
          took_ms: tookMs(t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderCloseHuman,
  };
}
