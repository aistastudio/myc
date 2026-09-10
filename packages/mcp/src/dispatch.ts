/**
 * Диспетчер тулов профиля agent: один вызов MCP = одно намерение = один
 * (для чтений — два: текст + структура) вызов движка CLI через run().
 *
 * Мутации идут ОДНИМ --json-прогоном (двойной прогон мутировал бы дважды),
 * их текст собирается в format.ts из того же data. Чтения идут двумя
 * прогонами — человеческий вывод CLI попадает в content дословно, а
 * конверт --json — в structuredContent (решение §4.1: текст дешевле JSON,
 * структура — для клиентов, которые умеют).
 *
 * Деградация не прячется: envelope.meta.degraded и warn[] доезжают до
 * structuredContent.meta.degraded и WARN-строк текстового блока.
 */

import { commentInput } from "@myc/core";
import {
  openMcpStore,
  resolveNode,
  LINK_EDGE_KINDS,
  type McpStoreHandle,
  type OpenMcpStoreResult,
} from "./store.ts";
import {
  claimText,
  closeText,
  depText,
  readyClaimText,
  rememberText,
  updateText,
  warnBlock,
  fmtAge,
  fmtClock,
} from "./format.ts";

export interface CliOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string | undefined;
}

export type RunCli = (argv: readonly string[]) => Promise<CliOutcome>;

export interface DispatchDeps {
  readonly runCli: RunCli;
  /** Подменяется в тестах; по умолчанию — прямой стор (store.ts). */
  readonly openStore?: (() => Promise<OpenMcpStoreResult>) | undefined;
}

export interface ToolContent {
  readonly type: "text";
  readonly text: string;
}

export interface CallToolResult {
  readonly content: readonly ToolContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Неизвестный тул — маппится сервером в JSON-RPC -32602, не в isError. */
export class UnknownToolError extends Error {}

/** Ошибка уровня тула — ответ isError:true по §4.3 (`myc: <code>: <msg>`). */
class ToolError extends Error {
  constructor(
    readonly code: string,
    msg: string,
    readonly hint?: string,
  ) {
    super(msg);
  }
}

interface EnvelopeError {
  code: string;
  msg: string;
  exit: number;
  hint?: string;
}

interface Envelope {
  ok: boolean;
  cmd: string;
  data: (Record<string, unknown> & { took_ms?: number }) | null;
  meta: Record<string, unknown> & { degraded?: string[] };
  warn?: { code: string; msg: string }[];
  error?: EnvelopeError;
}

type Meta = { took_ms: number; degraded: string[]; seq?: number };

function metaOf(env: Envelope, extraDegraded: readonly string[] = []): Meta {
  const degraded = [...(env.meta.degraded ?? []), ...extraDegraded];
  return {
    took_ms:
      typeof env.meta["took_ms"] === "number"
        ? env.meta["took_ms"]
        : (env.data?.took_ms ?? 0),
    degraded,
  };
}

function textResult(text: string, structured: unknown): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function errorResult(
  code: string,
  msg: string,
  hint: string | undefined = undefined,
  opts: { warn?: readonly { code: string; msg: string }[]; structured?: unknown } = {},
): CallToolResult {
  let text = `myc: ${code}: ${msg}`;
  if (hint !== undefined) text += `\nhint: ${hint}`;
  const warns = warnBlock(opts.warn);
  if (warns.length > 0) text = `${warns}${text}`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    ...(opts.structured !== undefined ? { structuredContent: opts.structured } : {}),
  };
}

// ---------------------------------------------------------------------------
// валидация входа (схемы валидирует клиент; здесь — защита движка)
// ---------------------------------------------------------------------------

type Args = Readonly<Record<string, unknown>>;

function reqStr(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new ToolError("usage.missing", `missing parameter '${key}'`);
  }
  return v;
}

function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ToolError("usage.invalid", `'${key}' must be a string`);
  return v;
}

function strList(args: Args, key: string): string[] {
  const v = args[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ToolError("usage.invalid", `'${key}' must be an array of strings`);
  }
  return v as string[];
}

/** Флаги CLI однозначны: массив длиной > 1 честно отклоняется, а не режется молча. */
function singleFlag(list: readonly string[], key: string): string | undefined {
  if (list.length > 1) {
    throw new ToolError(
      "usage.invalid",
      `'${key}': M0 takes a single value, got ${list.length}`,
    );
  }
  return list[0];
}

function optInt(args: Args, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolError("usage.invalid", `'${key}' must be a number`);
  }
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function optBool(args: Args, key: string): boolean {
  return args[key] === true;
}

// ---------------------------------------------------------------------------
// прогоны CLI
// ---------------------------------------------------------------------------

async function runJson(runCli: RunCli, argv: readonly string[]): Promise<Envelope> {
  return runEnvelope(runCli, [...argv, "--json"]);
}

/** Прогон, в argv которого `--json` уже стоит на своём месте. */
async function runEnvelope(runCli: RunCli, argv: readonly string[]): Promise<Envelope> {
  let out: CliOutcome;
  try {
    out = await runCli(argv);
  } catch (e) {
    throw new ToolError("internal.unexpected", e instanceof Error ? e.message : String(e));
  }
  try {
    return JSON.parse(out.stdout) as Envelope;
  } catch {
    throw new ToolError(
      "internal.unexpected",
      `engine returned non-JSON (code ${out.code}): ${out.stderr ?? out.stdout.slice(0, 200)}`,
    );
  }
}

async function runText(runCli: RunCli, argv: readonly string[]): Promise<string> {
  const out = await runCli(argv);
  return out.stdout;
}

/** Конверт-ошибка → isError-ответ; warn[] деградации доезжают в тексте. */
function envelopeFailure(
  env: Envelope,
  extra: { structured?: unknown } = {},
): CallToolResult {
  const e = env.error ?? { code: "internal.unexpected", msg: "engine returned an error without an envelope", exit: 1 };
  return errorResult(e.code, e.msg, e.hint, { warn: env.warn ?? [], structured: extra.structured });
}

// ---------------------------------------------------------------------------
// операции прямого стора (link не-dep, release/extend, note)
// ---------------------------------------------------------------------------

async function withStore<T>(
  deps: DispatchDeps,
  fn: (h: McpStoreHandle) => T | Promise<T>,
): Promise<T> {
  const open = deps.openStore ?? (() => openMcpStore());
  const opened = await open();
  if (!opened.ok) {
    const f = opened.failure;
    throw new ToolError(f.code, f.msg, f.hint);
  }
  try {
    return await fn(opened.handle);
  } finally {
    opened.handle.close();
  }
}

function storeMeta(h: McpStoreHandle, t0: number): Meta {
  return { took_ms: Math.max(1, Math.round(performance.now() - t0)), degraded: [], seq: h.store.lastSeq };
}

async function addNote(
  deps: DispatchDeps,
  targetInput: string,
  text: string,
): Promise<{ noteId: string; targetId: string; meta: Meta }> {
  const t0 = performance.now();
  return withStore(deps, (h) => {
    const target = resolveNode(h, targetInput);
    if (!target.ok) throw new ToolError(target.failure.code, target.failure.msg, target.failure.hint);
    // Форму узла задаёт ЯДРО (commentInput, S64), а не эта функция: три
    // поверхности собирали комментарий каждая по-своему, и ровно так вид
    // разошёлся — MCP писал note+type='comment', CLI kind='message', веб читал
    // по kind='message' и показывал ноль из девяти (memory-1nh192mztcqy).
    // Запись остаётся прямой (тот же процесс, тот же движок, тот же оплог —
    // второго CRDT здесь нет), но форма — общая, и разойтись ей больше нечем.
    const node = h.store.createNode(commentInput({ text, scope: h.scope, actor: h.actor }));
    h.store.addEdge(node.id, "replies_to", target.node.id);
    return { noteId: node.id, targetId: target.node.id, meta: storeMeta(h, t0) };
  });
}

// ---------------------------------------------------------------------------
// тулы
// ---------------------------------------------------------------------------

async function toolPrime(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const budget = optInt(args, "budget", 2000, 200, 8000);
  const env = await runJson(deps.runCli, ["bootstrap", "--budget", String(budget)]);
  if (!env.ok) return envelopeFailure(env);
  const data = env.data as { text?: string };
  const text = `${warnBlock(env.warn ?? [])}${data.text ?? ""}`;
  return textResult(text, { ...env.data, meta: metaOf(env) });
}

function readyFilters(args: Args): string[] {
  const argv: string[] = [];
  const kind = singleFlag(strList(args, "kind"), "kind");
  if (kind !== undefined) argv.push("--kind", kind);
  const priority = singleFlag(strList(args, "priority"), "priority");
  if (priority !== undefined) argv.push("--priority", priority);
  const tag = singleFlag(strList(args, "tag"), "tag");
  if (tag !== undefined) argv.push("--tag", tag);
  if (optBool(args, "why")) argv.push("--why");
  return argv;
}

/** Гонка claim проиграна — не исключение, а полезный ответ (§4.5): следующая свободная задача прилагается. */
async function claimConflict(deps: DispatchDeps, env: Envelope): Promise<CallToolResult> {
  const next = await runJson(deps.runCli, ["ready", "--n", "1"]);
  const ready = next.ok ? ((next.data as { items?: unknown[] }).items ?? []) : [];
  return envelopeFailure(env, {
    structured: {
      ready,
      counts: next.ok
        ? {
            ready: (next.data as { ready?: number }).ready ?? 0,
            blocked: (next.data as { blocked?: number }).blocked ?? 0,
            in_progress: (next.data as { in_progress?: number }).in_progress ?? 0,
          }
        : undefined,
      meta: metaOf(env),
    },
  });
}

async function toolReady(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const n = optInt(args, "n", 5, 1, 50);
  const lease = optInt(args, "lease_minutes", 30, 5, 480);
  const claim = optBool(args, "claim");
  const id = optStr(args, "id");
  const filters = readyFilters(args);

  if (!claim) {
    if (id !== undefined) {
      throw new ToolError("usage.invalid", "'id' only makes sense with claim=true");
    }
    const argv = ["ready", "--n", String(n), ...filters];
    const [text, env] = await Promise.all([runText(deps.runCli, argv), runJson(deps.runCli, argv)]);
    if (!env.ok) return envelopeFailure(env);
    return textResult(text, { ...env.data, meta: metaOf(env) });
  }

  if (id !== undefined) {
    // конкретная задача: claim + полный контекст через show (§4.5)
    const claimedEnv = await runJson(deps.runCli, ["claim", id, "--lease", `${lease}m`]);
    if (!claimedEnv.ok) {
      if (claimedEnv.error?.code === "conflict.claimed") return claimConflict(deps, claimedEnv);
      return envelopeFailure(claimedEnv);
    }
    const c = claimedEnv.data as unknown as Parameters<typeof claimText>[0];
    const showArgv = ["show", c.id, "--depth", "1"];
    const [showEnv, showHuman] = await Promise.all([
      runJson(deps.runCli, showArgv),
      runText(deps.runCli, showArgv),
    ]);
    const view = showEnv.ok && showEnv.data !== null ? showEnv.data : undefined;
    const text = `${warnBlock(claimedEnv.warn ?? [])}${claimText(c)}\n${showHuman}`;
    return textResult(text, {
      claimed: {
        ...c,
        lease_until: new Date(c.lease_expires).toISOString(),
        ...(view !== undefined
          ? {
              title: view["title"],
              body: view["body"],
              deps: view["blocked_by"],
              anchors: view["anchors"],
              links: view["links"],
              related: view["related"],
            }
          : {}),
      },
      meta: metaOf(claimedEnv),
    });
  }

  // верхняя задача очереди: один атомарный прогон ready --claim
  const env = await runJson(deps.runCli, ["ready", "--claim", "--lease", `${lease}m`, ...filters]);
  if (!env.ok) return envelopeFailure(env);
  const data = env.data as unknown as Parameters<typeof readyClaimText>[0];
  const text = `${warnBlock(env.warn ?? [])}${readyClaimText(data)}`;
  const claimed = data.claimed;
  return textResult(text, {
    ready: [],
    claimed:
      claimed !== undefined
        ? { ...claimed, lease_until: new Date(claimed.lease_expires).toISOString() }
        : null,
    counts: { ready: data.ready, blocked: data.blocked, in_progress: data.in_progress },
    meta: metaOf(env),
  });
}

const UPDATE_OPS = ["claim", "release", "close", "reopen", "assign", "priority", "note", "extend"] as const;

/**
 * Операции, намеренно НЕ выданные агенту, и причина по каждой.
 *
 * Разница между «нет операции» и «операция человеческая» для агента невидима,
 * если отвечать одним `usage.invalid`: он не может отличить недосмотр от
 * решения и начинает искать обход. Ровно так появился P0 с арендой — там у
 * агента через MCP был `release`, а у человека в CLI не было, и человек
 * тянулся к записи статуса, создавая двойное владение. Здесь асимметрия
 * зеркальная, и лечится она объяснением, а не расширением списка.
 */
const HUMAN_ONLY_OPS: Readonly<Record<string, string>> = {
  cancel:
    "cancelling decides whether the work is needed AT ALL — that is a human judgment (S54), " +
    "and it is terminal: a cancelled blocker immediately releases dependent tasks " +
    "into the ready queue. If the work looks unnecessary, say so in your report and leave " +
    "the decision to a human; it can be cancelled from the CLI (`myc update <id> --status cancelled`) " +
    "or from the web UI",
};

async function toolUpdate(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const id = reqStr(args, "id");
  const op = reqStr(args, "op");
  const humanOnly = HUMAN_ONLY_OPS[op];
  if (humanOnly !== undefined) {
    throw new ToolError("precond.human_only", `op '${op}' is not available to agents: ${humanOnly}`);
  }
  if (!(UPDATE_OPS as readonly string[]).includes(op)) {
    throw new ToolError("usage.invalid", `invalid op '${op}'; allowed: ${UPDATE_OPS.join(", ")}`);
  }
  const lease = optInt(args, "lease_minutes", 30, 5, 480);

  switch (op) {
    case "claim": {
      const argv = ["claim", id, "--lease", `${lease}m`];
      if (optBool(args, "steal")) argv.push("--steal");
      const env = await runJson(deps.runCli, argv);
      if (!env.ok) {
        if (env.error?.code === "conflict.claimed") return claimConflict(deps, env);
        return envelopeFailure(env);
      }
      const c = env.data as unknown as Parameters<typeof claimText>[0] & { prev_status: string };
      const text = `${warnBlock(env.warn ?? [])}${claimText(c)}`;
      return textResult(text, {
        id: c.id,
        status: "in_progress",
        previous: c.prev_status,
        assignee: c.holder,
        lease_until: new Date(c.lease_expires).toISOString(),
        meta: metaOf(env),
      });
    }

    case "close": {
      const reason = reqStr(args, "reason");
      const argv = ["close", id, "--reason", reason];
      const outcome = optStr(args, "outcome");
      if (outcome !== undefined) argv.push("--outcome", outcome);
      const verify = optStr(args, "verify");
      if (verify !== undefined) argv.push("--verify", verify);
      const dup = optStr(args, "duplicate_of");
      if (dup !== undefined) argv.push("--dup", dup);
      const cost = args["cost"];
      if (cost !== undefined) {
        if (typeof cost !== "object" || cost === null) {
          throw new ToolError("usage.invalid", "'cost' must be an object");
        }
        const c = cost as Record<string, unknown>;
        if (typeof c["tokens_in"] === "number") argv.push("--cost-in", String(c["tokens_in"]));
        if (typeof c["tokens_out"] === "number") argv.push("--cost-out", String(c["tokens_out"]));
        if (typeof c["model"] === "string") argv.push("--model", c["model"]);
        if (typeof c["retries"] === "number") argv.push("--retries", String(c["retries"]));
      }
      const env = await runJson(deps.runCli, argv);
      if (!env.ok) return envelopeFailure(env);
      const d = env.data as unknown as Parameters<typeof closeText>[0];
      const text = `${warnBlock(env.warn ?? [])}${closeText(d)}`;
      return textResult(text, {
        id: d.id,
        status: d.status,
        previous: "in_progress",
        assignee: d.closed_by,
        unblocked: d.unblocked,
        meta: metaOf(env),
      });
    }

    case "reopen": {
      const reason = reqStr(args, "reason");
      const env = await runJson(deps.runCli, ["update", id, "--status", "open"]);
      if (!env.ok) return envelopeFailure(env);
      const d = env.data as unknown as Parameters<typeof updateText>[0];
      let text = `${warnBlock(env.warn ?? [])}${updateText(d)}`;
      const degraded: string[] = [];
      try {
        const noted = await addNote(deps, id, `reopen: ${reason}`);
        text += `reason saved as note ${noted.noteId}\n`;
      } catch (e) {
        // статус уже переоткрыт; потерять причину молча нельзя — WARN
        degraded.push("note.unwritten");
        text += `WARN note.unwritten: reopen reason not saved: ${e instanceof Error ? e.message : String(e)}\n`;
      }
      return textResult(text, {
        id: d.id,
        status: d.status,
        previous: "closed",
        meta: metaOf(env, degraded),
      });
    }

    case "assign": {
      const assignee = reqStr(args, "assignee");
      const env = await runJson(deps.runCli, ["update", id, "--assign", assignee]);
      if (!env.ok) return envelopeFailure(env);
      const d = env.data as unknown as Parameters<typeof updateText>[0];
      return textResult(`${warnBlock(env.warn ?? [])}${updateText(d)}`, {
        id: d.id,
        status: d.status,
        assignee,
        meta: metaOf(env),
      });
    }

    case "priority": {
      const priority = reqStr(args, "priority");
      const env = await runJson(deps.runCli, ["update", id, "--priority", priority]);
      if (!env.ok) return envelopeFailure(env);
      const d = env.data as unknown as Parameters<typeof updateText>[0];
      return textResult(`${warnBlock(env.warn ?? [])}${updateText(d)}`, {
        id: d.id,
        status: d.status,
        priority,
        meta: metaOf(env),
      });
    }

    case "note": {
      const note = reqStr(args, "note");
      const noted = await addNote(deps, id, note);
      const text = `${noted.noteId} note → ${noted.targetId}\n`;
      return textResult(text, { id: noted.targetId, note_id: noted.noteId, status: "noted", meta: noted.meta });
    }

    case "release": {
      const t0 = performance.now();
      return withStore(deps, (h) => {
        const node = resolveNode(h, id);
        if (!node.ok) throw new ToolError(node.failure.code, node.failure.msg, node.failure.hint);
        const leaseInfo = h.store.leaseOf(node.node.id);
        if (leaseInfo === undefined || leaseInfo.holder.length === 0) {
          throw new ToolError("precond.no_lease", `${node.node.id} has no lease — nothing to release`);
        }
        if (!h.store.releaseLease(node.node.id, leaseInfo.holder, leaseInfo.epoch)) {
          throw new ToolError("conflict.release", `lease on ${node.node.id} changed — retry`);
        }
        if (node.node.status === "in_progress") {
          h.store.updateNode(node.node.id, { status: "open" });
        }
        const text = `released ${node.node.id} · lease of ${leaseInfo.holder} dropped, status open\n`;
        return textResult(text, {
          id: node.node.id,
          status: "open",
          previous: "in_progress",
          assignee: null,
          lease_until: null,
          meta: storeMeta(h, t0),
        });
      });
    }

    case "extend": {
      const t0 = performance.now();
      return withStore(deps, (h) => {
        const node = resolveNode(h, id);
        if (!node.ok) throw new ToolError(node.failure.code, node.failure.msg, node.failure.hint);
        const leaseInfo = h.store.leaseOf(node.node.id);
        if (leaseInfo === undefined || leaseInfo.holder.length === 0) {
          throw new ToolError("precond.no_lease", `${node.node.id} has no lease — nothing to extend`);
        }
        if (leaseInfo.holder !== h.actor) {
          throw new ToolError(
            "conflict.claimed",
            `${node.node.id} is held by ${leaseInfo.holder} — only the holder can extend it`,
            `myc_update {op:"claim", steal:true} once the lease expires`,
          );
        }
        const ttl = lease * 60_000;
        const expires = h.store.renewLease(node.node.id, leaseInfo.holder, leaseInfo.epoch, ttl);
        if (expires === undefined) {
          throw new ToolError("conflict.release", `lease on ${node.node.id} changed — retry`);
        }
        const text = `renewed ${node.node.id} by ${leaseInfo.holder} · lease ${fmtAge(ttl)} until ${fmtClock(expires)}\n`;
        return textResult(text, {
          id: node.node.id,
          status: node.node.status,
          assignee: leaseInfo.holder,
          lease_until: new Date(expires).toISOString(),
          meta: storeMeta(h, t0),
        });
      });
    }
  }
  throw new ToolError("usage.invalid", `op '${op}' is not supported`);
}

async function toolRecall(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const query = reqStr(args, "query");
  if (query.trim().length < 2) {
    throw new ToolError("usage.invalid", "query is shorter than two characters");
  }
  const n = optInt(args, "n", 6, 1, 50);
  const budget = optInt(args, "budget", 2000, 200, 8000);
  const argv = ["recall", query, "--limit", String(n), "--budget", String(budget)];
  const kinds = strList(args, "kind");
  if (kinds.length > 0) argv.push("--kind", kinds.join(","));
  const layers = strList(args, "layer");
  if (layers.length > 0) argv.push("--layer", layers.length === 1 ? layers[0]! : `${layers[0]}..${layers[layers.length - 1]}`);
  const tags = strList(args, "tag");
  if (tags.length > 0) argv.push("--tag", tags.join(","));
  const since = optStr(args, "since");
  if (since !== undefined) argv.push("--since", since);
  const anchor = optStr(args, "anchor");
  if (anchor !== undefined) argv.push("--anchor", anchor);
  const mode = optStr(args, "mode");
  if (mode !== undefined) argv.push("--mode", mode);

  // чтение: человеческий вывод (уже с WARN-строками деградации) + конверт
  const [text, env] = await Promise.all([runText(deps.runCli, argv), runJson(deps.runCli, argv)]);
  if (!env.ok) return envelopeFailure(env);
  return textResult(text, { ...env.data, meta: metaOf(env) });
}

async function toolRemember(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const text = reqStr(args, "text");
  if (text.trim().length < 8) {
    throw new ToolError("usage.invalid", "fact is shorter than 8 characters — be more specific");
  }
  const argv = ["remember", text];
  const tags = strList(args, "tag");
  if (tags.length > 0) argv.push("--tag", tags.join(","));
  const anchors = strList(args, "anchor");
  const anchor = singleFlag(anchors, "anchor");
  if (anchor !== undefined) argv.push("--anchor", anchor);
  const layer = optStr(args, "layer");
  if (layer !== undefined) argv.push("--layer", layer);
  const source = optStr(args, "source");
  if (source !== undefined) argv.push("--source", source);
  const absorb = args["absorb"] !== false;
  if (!absorb) argv.push("--no-absorb");

  const env = await runJson(deps.runCli, argv);
  if (!env.ok) return envelopeFailure(env);
  const d = env.data as unknown as Parameters<typeof rememberText>[0];
  const degraded: string[] = [];
  let warns = warnBlock(env.warn ?? []);
  if (d.absorb_heuristic) {
    // absorb без chat-LLM — эвристика; агент обязан это видеть (§5.6)
    degraded.push("llm.chat.off");
    warns += "WARN llm.chat.off: absorb classification is heuristic — chat LLM is off\n";
  }
  return textResult(`${warns}${rememberText(d)}`, {
    id: d.id,
    verdict: "new",
    verdict_source: !absorb ? "skipped" : d.absorb_heuristic ? "heuristic" : "llm",
    written: true,
    redacted: 0,
    queued: d.queue,
    meta: metaOf(env, degraded),
  });
}

async function toolShow(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const ids = strList(args, "ids");
  if (ids.length === 0) throw new ToolError("usage.missing", "missing parameter 'ids' (1..20)");
  if (ids.length > 20) throw new ToolError("usage.invalid", `up to 20 nodes per call, got ${ids.length}`);
  const argv = ["show", ids.join(",")];
  const depthRaw = args["depth"];
  if (depthRaw !== undefined) {
    if (depthRaw !== 0 && depthRaw !== 1) throw new ToolError("usage.invalid", "'depth' takes 0 or 1");
    argv.push("--depth", String(depthRaw));
  }
  if (optBool(args, "source")) argv.push("--source");
  const fields = strList(args, "fields");
  if (fields.length > 0) argv.push("--field", fields.join(","));

  const [text, env] = await Promise.all([runText(deps.runCli, argv), runJson(deps.runCli, argv)]);
  if (!env.ok) return envelopeFailure(env);
  // одиночный show отдаёт NodeView напрямую; нормализуем к nodes[] (§4.9)
  const data = env.data ?? {};
  const nodes = Array.isArray(data["nodes"]) ? data["nodes"] : [data];
  const rest = { ...data };
  delete rest["nodes"];
  delete rest["took_ms"];
  return textResult(text, {
    nodes,
    ...(Array.isArray(data["nodes"]) ? rest : {}),
    meta: metaOf(env),
  });
}

const LINK_TYPES = ["blocks", "blocked-by", ...Object.keys(LINK_EDGE_KINDS)] as const;

async function toolLink(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const from = reqStr(args, "from");
  const to = reqStr(args, "to");
  const type = reqStr(args, "type");
  if (!(LINK_TYPES as readonly string[]).includes(type)) {
    throw new ToolError("usage.invalid", `invalid type '${type}'; allowed: ${LINK_TYPES.join(", ")}`);
  }
  const reason = optStr(args, "reason");
  if ((type === "supersedes" || type === "duplicates") && reason === undefined) {
    throw new ToolError("usage.missing", `${type} requires a reason — history is not rewritten`);
  }
  const remove = optBool(args, "remove");

  // зависимости — частный случай ребра с готовым движком (циклы, ready-очередь)
  if (type === "blocks" || type === "blocked-by") {
    const argv = remove ? ["dep", "rm", from, type, to] : ["dep", "add", from, type, to];
    const env = await runJson(deps.runCli, argv);
    if (!env.ok) return envelopeFailure(env);
    const d = env.data as unknown as Parameters<typeof depText>[0];
    const text = `${warnBlock(env.warn ?? [])}${depText(d)}`;
    return textResult(text, {
      ok: true,
      edge: { from: d.src, type, to: d.dst },
      effects: d.left_ready === true ? [`${d.left_ready_id} left ready`] : d.back_ready === true ? [`${d.back_ready_id} is ready again`] : [],
      meta: metaOf(env),
    });
  }

  const t0 = performance.now();
  return withStore(deps, (h) => {
    const srcNode = resolveNode(h, from);
    if (!srcNode.ok) throw new ToolError(srcNode.failure.code, srcNode.failure.msg, srcNode.failure.hint);
    const dstNode = resolveNode(h, to);
    if (!dstNode.ok) throw new ToolError(dstNode.failure.code, dstNode.failure.msg, dstNode.failure.hint);
    const kind = LINK_EDGE_KINDS[type as keyof typeof LINK_EDGE_KINDS];
    const src = srcNode.node.id;
    const dst = dstNode.node.id;

    const effects: string[] = [];
    if (remove) {
      if (!h.store.removeEdge(src, kind, dst)) {
        throw new ToolError("notfound.edge", `no edge ${src} ${type} ${dst}`);
      }
    } else {
      const existing = h.store.getEdge(src, kind, dst);
      // удалённое ребро остаётся надгробием OR-Set — это не «уже есть»
      if (existing !== undefined && existing.deleted_at === null) {
        throw new ToolError("conflict.edge_exists", `edge ${src} ${type} ${dst} already exists`);
      }
      try {
        h.store.addEdge(src, kind, dst, {
          ...(reason !== undefined ? { attrs: { reason } } : {}),
        });
      } catch (e) {
        throw new ToolError("usage.invalid", e instanceof Error ? e.message : String(e));
      }
      if (type === "supersedes") {
        h.store.updateNode(dst, { attrs: { superseded_by: src } });
        effects.push(`${dst} marked superseded_by ${src}; the old node is kept`);
      }
      if (reason !== undefined) effects.push(`reason: ${reason}`);
    }

    const text = remove
      ? `${type} ${src} → ${dst} removed\n`
      : `${src} ${type} ${dst}${effects.length > 0 ? `\neffects   ${effects.join(" · ")}` : ""}\n`;
    return textResult(text, {
      ok: true,
      edge: { from: src, type, to: dst },
      effects,
      meta: storeMeta(h, t0),
    });
  });
}

// ---------------------------------------------------------------------------
// код: инструмент = команда CLI (memory-5h06ty5sz38c)
// ---------------------------------------------------------------------------

/**
 * Инструмент кода не считает ничего сам: он собирает argv той же команды,
 * которую набрал бы человек, и отдаёт её ответ — текст дословно, конверт в
 * structuredContent. Своего слоя, в котором ответ мог бы разойтись с
 * терминалом, здесь нет; всё, что остаётся на долю этого файла, — перевод
 * аргументов во флаги, и именно его стережёт code.parity.test.ts.
 *
 * Отказ команды доезжает как есть. `precond.no_index` («индекс не построен»,
 * hint `myc code index`) и `notfound.symbol` — два разных ответа с разными
 * кодами, и превращать первый в пустую выдачу здесь нечем.
 *
 * Позиционный аргумент идёт после `--`: литерал `--limit` или имя `-x` иначе
 * съел бы разбор флагов, и grep ответил бы про другой вопрос. `--json` поэтому
 * встаёт ДО разделителя — после него он уже позиционный.
 */
async function codeRead(
  deps: DispatchDeps,
  head: readonly string[],
  positional?: string,
): Promise<CallToolResult> {
  const tail = positional !== undefined ? ["--", positional] : [];
  const [text, env] = await Promise.all([
    runText(deps.runCli, [...head, ...tail]),
    runEnvelope(deps.runCli, [...head, "--json", ...tail]),
  ]);
  if (!env.ok) return envelopeFailure(env);
  return textResult(text, { ...env.data, meta: metaOf(env) });
}

/** Непустая строка как есть, без trim: пробелы в литерале grep — часть вопроса. */
function reqRaw(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolError("usage.missing", `missing parameter '${key}'`);
  }
  return v;
}

/**
 * Целое от 1 — строкой для флага CLI. Не зажимается в диапазон, как optInt:
 * зажатый молча лимит — это другой вопрос, чем тот, что задал агент.
 */
function optCount(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new ToolError("usage.invalid", `'${key}' must be an integer >= 1`);
  }
  return String(v);
}

function flagIf(argv: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) argv.push(flag, value);
}

async function toolCodeSearch(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const query = reqStr(args, "query");
  const head = ["code", "search"];
  flagIf(head, "--limit", optCount(args, "limit"));
  return codeRead(deps, head, query);
}

async function toolCodeGrep(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const literal = reqRaw(args, "literal");
  const head = ["code", "grep"];
  if (optBool(args, "ignore_case")) head.push("--ignore-case");
  const langs = strList(args, "lang");
  if (langs.length > 0) head.push("--lang", langs.join(","));
  // Область — тот же `--in` через запятую; пустой массив — «весь репозиторий»,
  // как у lang. Проверку путей ведёт команда: её отказ и есть ответ.
  const scopes = strList(args, "in");
  if (scopes.length > 0) head.push("--in", scopes.join(","));
  flagIf(head, "--limit", optCount(args, "limit"));
  return codeRead(deps, head, literal);
}

async function toolCodeSymbol(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  return codeRead(deps, ["code", "symbol"], reqStr(args, "name"));
}

async function toolCallers(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const name = reqStr(args, "name");
  const head = ["callers"];
  // direction, depth и kind проверяет КОМАНДА: её отказ и есть ответ, а
  // вторая проверка здесь рано или поздно разошлась бы с первой текстом.
  flagIf(head, "--direction", optStr(args, "direction"));
  const depth = args["depth"];
  if (depth !== undefined) {
    if (typeof depth !== "number" && typeof depth !== "string") {
      throw new ToolError("usage.invalid", "'depth' must be an integer >= 1 or \"all\"");
    }
    head.push("--depth", String(depth));
  }
  const kinds = strList(args, "kind");
  if (kinds.length > 0) head.push("--kind", kinds.join(","));
  flagIf(head, "--limit", optCount(args, "limit"));
  return codeRead(deps, head, name);
}

async function toolSkeleton(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const path = reqStr(args, "path");
  const head = ["skeleton"];
  if (optBool(args, "exported")) head.push("--exported");
  return codeRead(deps, head, path);
}

async function toolCodeMap(deps: DispatchDeps, args: Args): Promise<CallToolResult> {
  const head = ["code", "map"];
  flagIf(head, "--top", optCount(args, "top"));
  return codeRead(deps, head);
}

// ---------------------------------------------------------------------------

export type ToolHandler = (deps: DispatchDeps, args: Args) => Promise<CallToolResult>;

const HANDLERS: Readonly<Record<string, ToolHandler>> = {
  myc_prime: toolPrime,
  myc_ready: toolReady,
  myc_update: toolUpdate,
  myc_recall: toolRecall,
  myc_remember: toolRemember,
  myc_show: toolShow,
  myc_link: toolLink,
  myc_code_search: toolCodeSearch,
  myc_code_grep: toolCodeGrep,
  myc_code_symbol: toolCodeSymbol,
  myc_callers: toolCallers,
  myc_skeleton: toolSkeleton,
  myc_code_map: toolCodeMap,
};

export type Dispatch = (name: string, args: Args) => Promise<CallToolResult>;

export function createDispatcher(deps: DispatchDeps): Dispatch {
  return async (name, args) => {
    const handler = HANDLERS[name];
    if (handler === undefined) {
      throw new UnknownToolError(`unknown tool '${name}'`);
    }
    try {
      return await handler(deps, args);
    } catch (e) {
      if (e instanceof ToolError) {
        return errorResult(e.code, e.message, e.hint);
      }
      return errorResult("internal.unexpected", e instanceof Error ? e.message : String(e));
    }
  };
}
