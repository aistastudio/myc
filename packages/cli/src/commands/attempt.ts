/**
 * `myc attempt …` и `myc report models` — атрибуция исполнения (W11,
 * docs/design/04-swarm-learning-and-routing.md §2.2, §2.10.1).
 *
 *   myc attempt start  <task-id> [--model <id|часть id>] [--effort] [--harness]
 *                      [--class intent:scope] [--tokens-in N] [--tokens-out N] [--as]
 *   myc attempt finish [<attempt-id>] [--task <id>] --verdict accepted|rework|rejected
 *                      [--caveat coordinator-fixed,tests-weak,…] [--retries N]
 *                      [--from-transcript <файл> | --from-session <uuid>]
 *                      [--tokens-in N] [--tokens-out N] [--note]
 *   myc attempt list   [--task <id>] [--model <id>] [--open] [--since 7d]
 *   myc attempt show   <attempt-id>
 *   myc report models  [--class intent:scope] [--since 30d] [--min N]
 *
 * ПОЧЕМУ ЭТО НЕ ШЕСТЬ ФЛАГОВ НА ЗАКРЫТИЕ. Схема исхода в `myc close`
 * существовала и до W11 — и осталась пустой на всех 85 закрытых задачах
 * этого воркспейса. Причина не в схеме: заполнять руками шесть полей на
 * каждое закрытие — работа, которую не делают. Поэтому знание разнесено
 * туда, где оно уже есть:
 *
 * - модель, харнесс, уровень рассуждений, класс задачи и токены знает
 *   ИСПОЛНИТЕЛЬ — он и открывает попытку (`attempt start`, обычно вообще
 *   без флагов: модель берётся из $MYC_MODEL, харнесс и уровень — из
 *   ростера, класс — из самой задачи);
 * - принято или нет и с какими оговорками знает КООРДИНАТОР — он закрывает
 *   задачу одним флагом `myc close <id> --verdict accepted`.
 *
 * Ни одна сторона не вводит того, чего не знает, и никто не вводит дважды.
 *
 * РАСХОД ТОЖЕ НИКТО НЕ ВВОДИТ РУКАМИ. Четыре числа на попытку — та же
 * работа, которую не делают, и ось цены в `myc report models` осталась
 * пустой (0 попыток со стоимостью из 14). Оркестратор расхода не отдаёт,
 * а сессия отдаёт: `--from-transcript`/`--from-session` читают его из
 * стенограммы Claude Code (packages/swarm/src/transcript.ts). Флаги
 * `--tokens-*` остаются запасным путём — и спорить со стенограммой им не
 * дают: источник ровно один.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { JsonValue } from "@myc/core";
import { STORE_PRAGMAS } from "@myc/store-sqlite";
import {
  Attribution,
  AttributionError,
  CAVEATS,
  compareModels,
  computeTaskClass,
  EFFORTS,
  ensureSwarmSchema,
  findSessionTranscript,
  HARNESSES,
  isTaskClass,
  readTranscriptUsage,
  Roster,
  RosterError,
  transcriptDir,
  TranscriptError,
  VERDICTS,
  type AttemptRecord,
  type Caveat,
  type ClassAnswer,
  type CompareReport,
  type TranscriptUsage,
} from "@myc/swarm";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import {
  flagBool,
  flagNum,
  flagStr,
  parseDuration,
  realStoreDeps,
  resolveActor,
  resolveId,
  type StoreDeps,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Открытие базы роя
// ---------------------------------------------------------------------------

export interface SwarmHandle {
  readonly db: Database;
  readonly roster: Roster;
  readonly attribution: Attribution;
  close(): void;
}

export interface AttemptDeps {
  /** Только таблицы роя: `report`/`attempt finish` графа L1 не касаются. */
  openSwarm(ctx: CommandContext): SwarmHandle | CommandFailure;
  /** Граф L1: нужен там, где класс задачи считается из самой задачи. */
  readonly store: StoreDeps;
}

export function dbPathOf(ctx: CommandContext): string {
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  return ctx.globals.db ?? join(dir, ".myc", "myc.db");
}

/** Открытие повторяет дисциплину roster.ts: STORE_PRAGMAS, без vec0. */
export function openSwarmAt(dbPath: string): SwarmHandle | CommandFailure {
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      code: "ws.not_initialized",
      msg: `воркспейс не инициализирован: нет ${dbPath}`,
      exit: ExitCode.NOWS,
      hint: "myc init",
    };
  }
  const db = new Database(dbPath);
  for (const pragma of STORE_PRAGMAS) db.exec(pragma);
  ensureSwarmSchema(db);
  return {
    db,
    roster: new Roster(db),
    attribution: new Attribution(db),
    close: () => db.close(),
  };
}

const realDeps: AttemptDeps = {
  openSwarm: (ctx) => openSwarmAt(dbPathOf(ctx)),
  store: realStoreDeps,
};

function usage(code: string, msg: string, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit: ExitCode.USAGE, hint };
}

export function attemptFailure(e: unknown): CommandFailure {
  if (e instanceof RosterError) {
    return {
      ok: false,
      code: e.code,
      msg: e.message,
      exit: e.code === "notfound.model" ? ExitCode.NOTFOUND : ExitCode.USAGE,
      hint: e.code === "notfound.model" ? "myc model list --all" : undefined,
    };
  }
  if (e instanceof AttributionError) {
    const exit =
      e.code === "notfound.attempt"
        ? ExitCode.NOTFOUND
        : e.code === "conflict.finished"
          ? ExitCode.CONFLICT
          : ExitCode.USAGE;
    return { ok: false, code: e.code, msg: e.message, exit };
  }
  throw e;
}

// ---------------------------------------------------------------------------
// Разрешение модели: ростер — единственный источник
// ---------------------------------------------------------------------------

export type ModelResolution =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly failure: CommandFailure };

/**
 * Полный id, иначе однозначная часть id или семейство. Неоднозначность —
 * ошибка со списком кандидатов, а НЕ «возьмём первый»: молча записанная
 * не та модель отравляет ответ на вопрос сильнее, чем отсутствие записи.
 */
export function resolveModelId(roster: Roster, input: string): ModelResolution {
  if (roster.getModel(input) !== undefined) return { ok: true, modelId: input };
  const needle = input.toLowerCase();
  const hits = roster
    .listModels({ includeInactive: true })
    .filter(
      (e) =>
        e.model.modelId.toLowerCase().includes(needle) ||
        e.model.family.toLowerCase() === needle,
    )
    .map((e) => e.model.modelId);
  if (hits.length === 1) return { ok: true, modelId: hits[0]! };
  if (hits.length === 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "notfound.model",
        msg: `модель "${input}" не найдена в ростере; исход без ростерной модели записать нельзя`,
        exit: ExitCode.NOTFOUND,
        hint: "myc model list --all | myc model add <id> …",
      },
    };
  }
  return {
    ok: false,
    failure: {
      ok: false,
      code: "conflict.model",
      msg: `"${input}" подходит нескольким моделям: ${hits.join(", ")}`,
      exit: ExitCode.CONFLICT,
      hint: "уточните id модели",
    },
  };
}

/** Модель из флага или из $MYC_MODEL. Догадок нет: не назвали — ошибка. */
export function modelArg(ctx: CommandContext, roster: Roster): ModelResolution {
  const raw = flagStr(ctx, "model") ?? process.env.MYC_MODEL;
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      failure: usage(
        "usage.model",
        "не сказано, какой моделью выполнялась задача",
        "--model <id> или переменная окружения MYC_MODEL",
      ),
    };
  }
  return resolveModelId(roster, raw);
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Токены: флаг, иначе окружение харнесса. Нет ни того ни другого — ноль. */
export function tokenArgs(ctx: CommandContext): {
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
} {
  const pick = (flag: string, env: string): number | undefined =>
    flagNum(ctx, flag) ?? envInt(env);
  const out: Record<string, number> = {};
  const map: ReadonlyArray<readonly [string, string, string]> = [
    ["tokens-in", "MYC_TOKENS_IN", "tokensIn"],
    ["tokens-out", "MYC_TOKENS_OUT", "tokensOut"],
    ["cache-read", "MYC_TOKENS_CACHE_READ", "tokensCacheRead"],
    ["cache-write", "MYC_TOKENS_CACHE_WRITE", "tokensCacheWrite"],
  ];
  for (const [flag, env, key] of map) {
    const v = pick(flag, env);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Расход из стенограммы сессии
// ---------------------------------------------------------------------------

/** Флаги источника расхода: они же перечислены в help команды finish. */
const TRANSCRIPT_FLAGS: readonly FlagSpec[] = [
  {
    name: "from-transcript",
    value: "string",
    description: "read token spend from a session transcript file",
  },
  {
    name: "from-session",
    value: "string",
    description: "same, by session uuid in ~/.claude/projects/<project>",
  },
];

/** Ручные флаги расхода — те, что спорят со стенограммой за один и тот же смысл. */
const MANUAL_TOKEN_FLAGS = ["tokens-in", "tokens-out", "cache-read", "cache-write"] as const;

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Отказ разбора стенограммы — это ОТКАЗ КОМАНДЫ, а не нулевой расход.
 * Ноль неотличим от «не смогли прочитать»: попытка закрылась бы с
 * cost_basis='no_tokens', ось цены осталась бы пустой, и никто бы не
 * узнал, что формат сменился.
 */
export function transcriptFailure(e: TranscriptError): CommandFailure {
  const exit =
    e.code === "transcript.missing" ||
    e.code === "transcript.dir_missing" ||
    e.code === "notfound.session" ||
    e.code === "notfound.task_session"
      ? ExitCode.NOTFOUND
      : e.code === "conflict.session"
        ? ExitCode.CONFLICT
        : e.code === "transcript.unreadable"
          ? ExitCode.ERR
          : ExitCode.PRECOND;
  return { ok: false, code: e.code, msg: e.message, exit, hint: e.hint };
}

export type TokenSource = {
  readonly tokens: ReturnType<typeof tokenArgs>;
  readonly transcript?: TranscriptUsage;
};

/**
 * Откуда взять расход попытки: из стенограммы сессии или из флагов.
 * Источник ровно один — просить и то и другое значит не знать, какое из
 * двух чисел правда.
 */
export function tokenSource(ctx: CommandContext): TokenSource | CommandFailure {
  const file = flagStr(ctx, "from-transcript");
  const session = flagStr(ctx, "from-session");
  if (file !== undefined && session !== undefined) {
    return usage(
      "usage.token_source",
      "--from-transcript и --from-session вместе: источник расхода один",
    );
  }
  if (file === undefined && session === undefined) return { tokens: tokenArgs(ctx) };

  const manual = MANUAL_TOKEN_FLAGS.filter((f) => flagNum(ctx, f) !== undefined);
  if (manual.length > 0) {
    return usage(
      "usage.token_source",
      `расход задан и стенограммой, и флагами (${manual.map((f) => `--${f}`).join(", ")}); ` +
        "источник обязан быть один",
    );
  }

  try {
    const path =
      file !== undefined
        ? expandHome(file)
        : findSessionTranscript(
            transcriptDir(resolve(ctx.globals.directory ?? process.cwd())),
            session!,
          );
    const read = readTranscriptUsage(path);
    return {
      tokens: {
        tokensIn: read.tokensIn,
        tokensOut: read.tokensOut,
        tokensCacheRead: read.tokensCacheRead,
        tokensCacheWrite: read.tokensCacheWrite,
      },
      transcript: read,
    };
  } catch (e) {
    if (e instanceof TranscriptError) return transcriptFailure(e);
    throw e;
  }
}

export function caveatArgs(ctx: CommandContext): Caveat[] | CommandFailure {
  const raw = flagStr(ctx, "caveat");
  if (raw === undefined) return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim().replace(/-/g, "_"))
    .filter((s) => s !== "");
  const bad = parts.filter((p) => !(CAVEATS as readonly string[]).includes(p));
  if (bad.length > 0) {
    return usage(
      "usage.caveat",
      `неизвестная оговорка: ${bad.join(", ")}; известно: ${CAVEATS.join(", ")}`,
    );
  }
  return parts as Caveat[];
}

// ---------------------------------------------------------------------------
// Класс задачи из самой задачи
// ---------------------------------------------------------------------------

interface NodeLike {
  readonly title: string;
  readonly attrs: Readonly<Record<string, JsonValue>>;
}

/** Пути якорей: заявленные в attrs и связанные таблицей anchors. */
export function anchorPathsOf(node: NodeLike, db: Database, nodeId: string): string[] {
  const paths: string[] = [];
  const declared = node.attrs["anchors"];
  if (Array.isArray(declared)) {
    for (const a of declared) {
      if (a !== null && typeof a === "object" && typeof (a as { path?: unknown }).path === "string") {
        paths.push((a as { path: string }).path);
      }
    }
  }
  const bound = db
    .query("SELECT path FROM anchors WHERE node_id = ?1")
    .all(nodeId) as Array<{ path: string }>;
  for (const row of bound) paths.push(row.path);
  return paths;
}

export function taskClassOf(node: NodeLike, db: Database, nodeId: string): string {
  const type = node.attrs["type"];
  return computeTaskClass({
    title: node.title,
    type: typeof type === "string" ? type : undefined,
    anchorPaths: anchorPathsOf(node, db, nodeId),
  }).taskClass;
}

// ---------------------------------------------------------------------------
// Вид записи
// ---------------------------------------------------------------------------

export function attemptView(a: AttemptRecord): Record<string, unknown> {
  return {
    attemptId: a.attemptId,
    taskId: a.taskId,
    modelId: a.modelId,
    effort: a.effort,
    harness: a.harness,
    actor: a.actor,
    taskClass: a.taskClass,
    classSource: a.classSource,
    startedAt: new Date(a.startedAt).toISOString(),
    finishedAt: a.finishedAt === null ? null : new Date(a.finishedAt).toISOString(),
    wallMs: a.wallMs,
    verdict: a.verdict,
    caveats: a.caveats,
    quality: a.quality,
    retries: a.retries,
    tokensIn: a.tokensIn,
    tokensOut: a.tokensOut,
    tokensCacheRead: a.tokensCacheRead,
    tokensCacheWrite: a.tokensCacheWrite,
    costUsd: a.costUsd,
    costBasis: a.costBasis,
    priceValidFrom: a.priceValidFrom === null ? null : new Date(a.priceValidFrom).toISOString(),
    source: a.source,
    note: a.note,
  };
}

function fmtUsd(v: number | null): string {
  return v === null ? "—" : `$${v < 0.01 ? v.toFixed(5) : v.toFixed(3)}`;
}

/**
 * Плотная строка на попытку. Дефолтная таблица каркаса вываливает 21
 * колонку и нечитаема — ровно то замечание, что координатор уже сделал по
 * `myc model list`.
 */
function renderAttemptListHuman(raw: unknown): string {
  const rows = raw as Array<ReturnType<typeof attemptView>>;
  if (rows.length === 0) return "попыток нет\n";
  const lines = rows.map((a) => {
    const caveats = a["caveats"] as string[];
    const q = a["quality"] as number | null;
    const state =
      a["verdict"] === null
        ? "open"
        : `${a["verdict"]}${caveats.length > 0 ? `(${caveats.join(",")})` : ""}`;
    const wall = a["wallMs"] as number | null;
    return [
      String(a["attemptId"]).padEnd(16),
      String(a["taskId"]).padEnd(20),
      `${a["modelId"]}@${a["effort"]}`.padEnd(30),
      String(a["taskClass"]).padEnd(17),
      state.padEnd(28),
      (q === null ? "q=—" : `q=${q.toFixed(2)}`).padEnd(8),
      fmtUsd(a["costUsd"] as number | null).padEnd(9),
      wall === null ? "" : `${(wall / 1000).toFixed(1)}s`,
    ].join(" ").trimEnd();
  });
  return `${lines.join("\n")}\n`;
}

/** Провенанс расхода в ответе: откуда взяты числа и сколько ответов учтено. */
export function withTranscript(
  view: Record<string, unknown>,
  usage: TranscriptUsage | undefined,
): Record<string, unknown> {
  if (usage === undefined) return view;
  return {
    ...view,
    transcript: {
      path: usage.path,
      sessionId: usage.sessionId,
      responses: usage.responses,
      usageRecords: usage.usageRecords,
      records: usage.records,
      startedAt: usage.startedAt,
      endedAt: usage.endedAt,
      models: usage.models,
    },
  };
}

function renderAttemptHuman(raw: unknown): string {
  const a = raw as ReturnType<typeof attemptView>;
  const head = `${a["attemptId"]}  ${a["taskId"]}  ${a["modelId"]}@${a["effort"]} (${a["harness"]})`;
  const cls = `class    ${a["taskClass"]}`;
  if (a["finishedAt"] === null) return `${head}\n${cls}\nopen     started ${a["startedAt"]}\n`;
  const caveats = a["caveats"] as string[];
  const verdict = `verdict  ${a["verdict"]}${caveats.length > 0 ? ` · оговорки: ${caveats.join(", ")}` : ""}`;
  const quality = `quality  ${(a["quality"] as number).toFixed(2)}   cost ${fmtUsd(
    a["costUsd"] as number | null,
  )} (${a["costBasis"]})`;
  const lines = [head, cls, verdict, quality];
  const t = a["transcript"] as
    | { sessionId: string | null; responses: number; usageRecords: number }
    | undefined;
  if (t !== undefined) {
    lines.push(
      `расход   in ${a["tokensIn"]} out ${a["tokensOut"]} · ` +
        `сессия ${t.sessionId ?? "?"}, ответов ${t.responses} из ${t.usageRecords} записей`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// attempt start / finish / list / show
// ---------------------------------------------------------------------------

const TOKEN_FLAGS: readonly FlagSpec[] = [
  { name: "tokens-in", value: "number", description: "input tokens spent ($MYC_TOKENS_IN)" },
  { name: "tokens-out", value: "number", description: "output tokens spent ($MYC_TOKENS_OUT)" },
  { name: "cache-read", value: "number", description: "cache-read tokens" },
  { name: "cache-write", value: "number", description: "cache-write tokens" },
];

function buildStartCommand(deps: AttemptDeps): Command {
  return {
    name: "start",
    summary: "open an attempt: who takes the task and with what model",
    help:
      "Модель — из --model или $MYC_MODEL и обязана быть в ростере. Харнесс и уровень " +
      "рассуждений наследуются из ростера, класс задачи считается из самой задачи.",
    flags: [
      { name: "model", value: "string", description: "roster model id or unambiguous part" },
      { name: "effort", value: "string", description: `override roster effort: ${EFFORTS.join("|")}` },
      { name: "harness", value: "string", description: `override roster harness: ${HARNESSES.join("|")}` },
      { name: "class", value: "string", description: "override task class, e.g. fix:module" },
      { name: "note", value: "string", description: "free-form note" },
      { name: "as", value: "string", description: "actor (default $MYC_ACTOR/$USER)" },
      ...TOKEN_FLAGS,
    ],
    handler: async (ctx): Promise<CommandResult> => {
      const idInput = ctx.args[0];
      if (idInput === undefined) {
        return usage("usage.invalid", "нужен id задачи: myc attempt start <id>");
      }
      const declaredClass = flagStr(ctx, "class");
      if (declaredClass !== undefined && !isTaskClass(declaredClass)) {
        return usage("usage.class", `--class обязан быть intent:scope, получено "${declaredClass}"`);
      }

      const opened = await deps.store.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      const swarm = swarmOn(h.driver.database);
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;

        const model = modelArg(ctx, swarm.roster);
        if (!model.ok) return model.failure;

        const taskClass =
          declaredClass ?? taskClassOf(node, h.driver.database, node.id);
        const record = swarm.attribution.startAttempt({
          taskId: node.id,
          modelId: model.modelId,
          taskClass,
          classSource: declaredClass === undefined ? "derived" : "declared",
          effort: flagStr(ctx, "effort") as never,
          harness: flagStr(ctx, "harness") as never,
          actor: resolveActor(ctx),
          note: flagStr(ctx, "note"),
          ...tokenArgs(ctx),
        });
        return { ok: true, data: attemptView(record) };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        h.close();
      }
    },
    renderHuman: renderAttemptHuman,
  };
}

/** Схема роя на уже открытом соединении графа: второй базы не заводим. */
export function swarmOn(db: Database): { roster: Roster; attribution: Attribution } {
  ensureSwarmSchema(db);
  return { roster: new Roster(db), attribution: new Attribution(db) };
}

function buildFinishCommand(deps: AttemptDeps): Command {
  return {
    name: "finish",
    summary: "record the outcome of an attempt",
    help:
      "Расход берётся из стенограммы сессии (--from-transcript/--from-session) либо " +
      "флагами вручную — одно из двух, не оба. Стенограмма — чужой формат: любое " +
      "расхождение с ожидаемым — отказ, а не нулевой расход.",
    flags: [
      { name: "task", value: "string", description: "finish the open attempt of this task" },
      { name: "verdict", value: "string", description: VERDICTS.join("|") },
      {
        name: "caveat",
        value: "string",
        description: `comma-separated: ${CAVEATS.join(", ")}`,
      },
      { name: "retries", value: "number", description: "rework rounds before acceptance" },
      { name: "note", value: "string", description: "free-form note" },
      ...TRANSCRIPT_FLAGS,
      ...TOKEN_FLAGS,
    ],
    handler: (ctx): CommandResult => {
      const verdict = flagStr(ctx, "verdict");
      if (verdict === undefined) {
        return usage("usage.verdict", `нужен --verdict: ${VERDICTS.join("|")}`);
      }
      const caveats = caveatArgs(ctx);
      if (!Array.isArray(caveats)) return caveats;
      const spend = tokenSource(ctx);
      if (!("tokens" in spend)) return spend;

      const opened = deps.openSwarm(ctx);
      if (!("db" in opened)) return opened;
      try {
        let attemptId = ctx.args[0];
        const taskId = flagStr(ctx, "task");
        if (attemptId === undefined) {
          if (taskId === undefined) {
            return usage(
              "usage.invalid",
              "нужен id попытки или --task <id>: myc attempt finish <attempt-id> --verdict …",
            );
          }
          const open = opened.attribution.openAttemptForTask(taskId);
          if (open === undefined) {
            return {
              ok: false,
              code: "notfound.attempt",
              msg: `у задачи "${taskId}" нет открытой попытки`,
              exit: ExitCode.NOTFOUND,
              hint: `myc attempt start ${taskId} --model <id>`,
            };
          }
          attemptId = open.attemptId;
        }
        const record = opened.attribution.finishAttempt(attemptId, {
          verdict,
          caveats,
          retries: flagNum(ctx, "retries"),
          note: flagStr(ctx, "note"),
          ...spend.tokens,
        });
        return { ok: true, data: withTranscript(attemptView(record), spend.transcript) };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: renderAttemptHuman,
  };
}

function buildListCommand(deps: AttemptDeps): Command {
  return {
    name: "list",
    summary: "recorded attempts, newest first",
    flags: [
      { name: "task", value: "string", description: "filter by task id" },
      { name: "model", value: "string", description: "filter by model id" },
      { name: "open", description: "only unfinished attempts" },
      { name: "since", value: "string", description: "window, e.g. 7d" },
      { name: "limit", value: "number", description: "max rows (default 50)" },
    ],
    handler: (ctx): CommandResult => {
      const opened = deps.openSwarm(ctx);
      if (!("db" in opened)) return opened;
      try {
        let since: number | undefined;
        const sinceRaw = flagStr(ctx, "since");
        if (sinceRaw !== undefined) {
          const span = parseDuration(sinceRaw);
          if (span === undefined) return usage("usage.invalid", `--since: не длительность "${sinceRaw}"`);
          since = Date.now() - span;
        }
        const rows = opened.attribution.listAttempts({
          taskId: flagStr(ctx, "task"),
          modelId: flagStr(ctx, "model"),
          open: flagBool(ctx, "open"),
          since,
          limit: flagNum(ctx, "limit") ?? 50,
        });
        return { ok: true, data: rows.map(attemptView), meta: { count: rows.length } };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: renderAttemptListHuman,
  };
}

function buildShowCommand(deps: AttemptDeps): Command {
  return {
    name: "show",
    summary: "one attempt in full",
    handler: (ctx): CommandResult => {
      const attemptId = ctx.args[0];
      if (attemptId === undefined) {
        return usage("usage.invalid", "нужен id попытки: myc attempt show <attempt-id>");
      }
      const opened = deps.openSwarm(ctx);
      if (!("db" in opened)) return opened;
      try {
        const record = opened.attribution.getAttempt(attemptId);
        if (record === undefined) {
          return {
            ok: false,
            code: "notfound.attempt",
            msg: `попытка "${attemptId}" не найдена`,
            exit: ExitCode.NOTFOUND,
          };
        }
        return { ok: true, data: attemptView(record) };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: renderAttemptHuman,
  };
}

export function createAttemptCommand(deps: AttemptDeps = realDeps): Command {
  return {
    name: "attempt",
    summary: "execution attribution: who ran the task, with what, to what result",
    subcommands: [
      buildStartCommand(deps),
      buildFinishCommand(deps),
      buildListCommand(deps),
      buildShowCommand(deps),
    ],
  };
}

// ---------------------------------------------------------------------------
// report models — сам вопрос
// ---------------------------------------------------------------------------

interface ReportData extends CompareReport {
  readonly tasksClosed: number;
  readonly tasksAttributed: number;
}

function renderClass(cls: ClassAnswer): string[] {
  const lines = [`${cls.taskClass}`];
  for (const arm of cls.arms) {
    const mark = cls.cheapest === arm.arm ? "→" : cls.equalGroup.includes(arm.arm) ? "=" : " ";
    lines.push(
      `  ${mark} ${arm.arm.padEnd(34)} n=${String(arm.attempts).padStart(3)}  ` +
        `q=${arm.qualityMean.toFixed(2)} [${arm.quality.lo.toFixed(2)}–${arm.quality.hi.toFixed(2)}]  ` +
        `cost=${fmtUsd(arm.costUsdMean)}/попытка (${arm.costedAttempts}/${arm.attempts})  ` +
        `чисто ${Math.round(arm.cleanRate * 100)}%`,
    );
  }
  lines.push(`    ${cls.answer}${cls.separationPending ? " (не различили)" : ""}: ${cls.why}`);
  return lines;
}

function renderReportHuman(raw: unknown): string {
  const d = raw as ReportData;
  const lines: string[] = [];
  if (d.classes.length === 0) {
    lines.push("атрибуции нет: ни одной закрытой попытки");
  }
  for (const cls of d.classes) lines.push(...renderClass(cls));
  lines.push(
    `покрытие  задач закрыто ${d.tasksClosed}, с атрибуцией ${d.tasksAttributed}; ` +
      `попыток ${d.coverage.attempts} (закрыто ${d.coverage.finished}, со стоимостью ${d.coverage.withCost})`,
  );
  if (d.coverage.costStale > 0) {
    lines.push(
      `ВНИМАНИЕ  ${d.coverage.costStale} из ${d.coverage.withCost} попыток заморожены по числу, ` +
        "которого их же строка цены больше не даёт (цену исправили после заморозки): " +
        "пересчёт — bun run scripts/recost-attempts.ts --apply",
    );
  }
  if (d.coverage.costCacheUnpriced > 0) {
    // Занижение неравномерное: сильнее у той руки, что больше читала и
    // меньше писала. Такой отчёт способен переставить модели местами.
    lines.push(
      `ВНИМАНИЕ  ${d.coverage.costCacheUnpriced} из ${d.coverage.withCost} попыток посчитаны ` +
        "по НУЛЕВОЙ цене кеша при ненулевых кеш-токенах: стоимость занижена и занижена " +
        "неравномерно. Заведите ставки: myc model update <id> --price-cache-read/--price-cache-write",
    );
  }
  lines.push(
    `формула   outcome v${d.outcomeVersion}, интервал ${Math.round(d.credibleMass * 100)}%, ` +
      `порог наблюдений ${d.minAttempts}`,
  );
  return `${lines.join("\n")}\n`;
}

export function createReportCommand(deps: AttemptDeps = realDeps): Command {
  const models: Command = {
    name: "models",
    summary: "which model is cheaper at equal result, per task class",
    help:
      "«Равный результат» — пересечение интервалов доверия по качеству, а не равенство " +
      "средних. Стоимость берётся замороженной на момент попытки.",
    flags: [
      { name: "class", value: "string", description: "one task class, e.g. fix:module" },
      { name: "since", value: "string", description: "window, e.g. 30d" },
      { name: "min", value: "number", description: "min attempts per arm (default 3)" },
    ],
    handler: (ctx): CommandResult => {
      const taskClass = flagStr(ctx, "class");
      if (taskClass !== undefined && !isTaskClass(taskClass)) {
        return usage("usage.class", `--class обязан быть intent:scope, получено "${taskClass}"`);
      }
      const opened = deps.openSwarm(ctx);
      if (!("db" in opened)) return opened;
      try {
        let since: number | undefined;
        const sinceRaw = flagStr(ctx, "since");
        if (sinceRaw !== undefined) {
          const span = parseDuration(sinceRaw);
          if (span === undefined) return usage("usage.invalid", `--since: не длительность "${sinceRaw}"`);
          since = Date.now() - span;
        }
        const report = compareModels(opened.db, {
          taskClass,
          since,
          minAttempts: flagNum(ctx, "min"),
        });
        const closed = opened.db
          .query(
            `SELECT count(*) AS n FROM nodes
              WHERE kind = 'task' AND status = 'closed' AND deleted_at IS NULL`,
          )
          .get() as { n: number } | null;
        const attributed = opened.db
          .query(
            `SELECT count(DISTINCT task_id) AS n FROM swarm_attempt WHERE finished_at IS NOT NULL`,
          )
          .get() as { n: number };
        const data: ReportData = {
          ...report,
          tasksClosed: closed?.n ?? 0,
          tasksAttributed: attributed.n,
        };
        return { ok: true, data, meta: { classes: report.classes.length } };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: renderReportHuman,
  };

  return {
    name: "report",
    summary: "swarm reports over recorded attribution",
    subcommands: [models],
  };
}

export const attemptCommand: Command = createAttemptCommand();
export const reportCommand: Command = createReportCommand();
