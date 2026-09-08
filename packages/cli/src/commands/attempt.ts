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
  isAlive,
  isTaskClass,
  launchContext,
  LIVE_STATE_MEANING,
  liveStateOf,
  overrideLaunch,
  pidAlive,
  readTranscriptUsage,
  Roster,
  RosterError,
  transcriptDir,
  TranscriptError,
  VERDICTS,
  type AttemptRecord,
  type AttemptWithRun,
  type Caveat,
  type ClassAnswer,
  type CompareReport,
  type LaunchContext,
  type LiveState,
  type OrphanContext,
  type RunRecord,
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

/**
 * Всё, что этот файл знает о МИРЕ ЗА ПРЕДЕЛАМИ БАЗЫ: окружение процесса,
 * живость pid, оркестратор, git. Собрано в одну инъекцию по двум причинам.
 *
 * Первая — проверяемость: «запуск записан» и «осиротевшее видно» обязаны
 * проверяться тестом, а не глазами на живой машине.
 *
 * Вторая важнее. Здесь проходит ГРАНИЦА ОТВЕТСТВЕННОСТИ: myc ведёт запись
 * и имеет право только СМОТРЕТЬ на процессы (сигнал 0 по записанному pid)
 * и СПРАШИВАТЬ оркестратор о его собственных записях. Ни одного способа
 * снять процесс в этом интерфейсе нет и не должно появиться: снимает тот,
 * кто запускал. Отдельный тип делает это правило видимым, а не устным.
 */
export interface LaunchProbe {
  env(): Readonly<Record<string, string | undefined>>;
  /** null = pid не записан, спрашивать нечего. */
  alive(pid: number | null): boolean | null;
  /** Диспетчер по терминалу — из записей оркестратора, не поиском по ps. */
  dispatchOf(terminal: string): { dispatchId: string; runId: string | null } | null;
  gitHead(cwd: string): string | null;
  /** Файлы, изменившиеся с указанного коммита, включая неотслеживаемые. */
  filesTouched(cwd: string, sinceHead: string): readonly string[] | null;
  now(): number;
}

export interface AttemptDeps {
  /** Только таблицы роя: `report`/`attempt finish` графа L1 не касаются. */
  openSwarm(ctx: CommandContext, now: () => number): SwarmHandle | CommandFailure;
  /** Граф L1: нужен там, где класс задачи считается из самой задачи. */
  readonly store: StoreDeps;
  readonly probe: LaunchProbe;
}

export function dbPathOf(ctx: CommandContext): string {
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  return ctx.globals.db ?? join(dir, ".myc", "myc.db");
}

/**
 * Открытие повторяет дисциплину roster.ts: STORE_PRAGMAS, без vec0.
 * Часы приходят снаружи и они ОДНИ на команду: время попытки и время
 * наблюдения за процессом обязаны быть одной шкалой, иначе «сколько
 * висит» — разность двух разных часов.
 */
export function openSwarmAt(
  dbPath: string,
  now: () => number = Date.now,
): SwarmHandle | CommandFailure {
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
    roster: new Roster(db, now),
    attribution: new Attribution(db, now),
    close: () => db.close(),
  };
}

/** Короткий вызов чужого бинаря: не нашёлся или упал — null, не отказ. */
function capture(cmd: string[], cwd: string, timeoutMs: number): string | null {
  try {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    if (r.exitCode !== 0) return null;
    const out = r.stdout.toString().trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * Диспетчер по терминалу. `worker-list --json` — единственная команда
 * оркестратора, где ctx_* стоит рядом с term_*; pid, токенов и стоимости
 * там нет (проверено 2026-09-07: 30 различных ключей, ни одного
 * token/cost/usage/pid). 174 мс на вызов — это путь ЗАПИСИ, один раз на
 * попытку, и он не обязателен: не ответил — связь просто не записана.
 */
export const realProbe: LaunchProbe = {
  env: () => process.env,
  alive: (pid) => pidAlive(pid),
  dispatchOf: (terminal) => {
    const raw = capture(["orca", "orchestration", "worker-list", "--json"], process.cwd(), 5000);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as {
        result?: { workers?: Array<Record<string, unknown>> };
      };
      const hit = (parsed.result?.workers ?? []).find(
        (w) => w["agentTerminalHandle"] === terminal,
      );
      if (hit === undefined) return null;
      const dispatchId = hit["dispatchId"];
      if (typeof dispatchId !== "string") return null;
      const runId = hit["runId"];
      return { dispatchId, runId: typeof runId === "string" ? runId : null };
    } catch {
      return null;
    }
  },
  gitHead: (cwd) => capture(["git", "rev-parse", "HEAD"], cwd, 3000),
  filesTouched: (cwd, sinceHead) => {
    const changed = capture(["git", "diff", "--name-only", sinceHead], cwd, 5000);
    const untracked = capture(
      ["git", "ls-files", "--others", "--exclude-standard"],
      cwd,
      5000,
    );
    if (changed === null && untracked === null) return null;
    const all = [...(changed ?? "").split("\n"), ...(untracked ?? "").split("\n")]
      .map((l) => l.trim())
      .filter((l) => l !== "");
    return [...new Set(all)].sort();
  },
  now: () => Date.now(),
};

export const realAttemptDeps: AttemptDeps = {
  openSwarm: (ctx, now) => openSwarmAt(dbPathOf(ctx), now),
  store: realStoreDeps,
  probe: realProbe,
};

/**
 * Проба, которая ничего не знает о мире. Нужна тестам и всякому вызову,
 * которому нельзя ни спрашивать оркестратор, ни читать чужое окружение:
 * без неё тест `attempt start` записал бы сессию ТОГО АГЕНТА, который
 * запустил тест, и зелёный тест ничего бы не значил.
 */
export const inertProbe: LaunchProbe = {
  env: () => ({}),
  alive: () => null,
  dispatchOf: () => null,
  gitHead: () => null,
  filesTouched: () => null,
  now: () => Date.now(),
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

/**
 * Пути якорей: заявленные в `attrs` и связанные ребром `touches`.
 *
 * ЗАПРОС ИДЁТ ЧЕРЕЗ РЕБРО, А НЕ ПО `anchors.node_id = <id задачи>`. Якорь —
 * это ОТДЕЛЬНЫЙ узел `kind='anchor'` (первичный ключ `anchors.node_id`
 * допускает ровно одну строку на узел, то есть узел и есть якорь), а задача
 * связана с ним ребром `touches`; ровно так его читает и `ready`
 * (ANCHOR_SUBQ). Пока здесь стояло `WHERE node_id = <id задачи>`, выборка не
 * находила НИ ОДНОГО привязанного якоря, и `scope` класса задачи оставался
 * `unknown` у всех задач разом — а роутинг считается по классу.
 */
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
    .query(
      `SELECT a.path AS path
         FROM edges e JOIN anchors a ON a.node_id = e.dst
        WHERE e.src = ?1 AND e.type = 'touches' AND e.deleted_at IS NULL`,
    )
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

// ---------------------------------------------------------------------------
// Запуск: что записывается в момент старта и как читается потом
// ---------------------------------------------------------------------------

/**
 * Контекст запуска для `attempt start`: окружение процесса, поверх него
 * названное флагами, поверх этого — диспетчер, спрошенный у оркестратора
 * по терминалу.
 *
 * Порядок именно такой, потому что каждый следующий источник ТОЧНЕЕ, а не
 * просто «позже»: окружение знает процесс о себе сам, флаг называет
 * запускающий, а оркестратор — единственный, кто знает ctx_*, и знает
 * его точно. Спрашивается он только если терминал известен и диспетчер
 * не назван: лишний запуск чужого бинаря на ровном месте не нужен.
 */
export function resolveLaunch(
  ctx: CommandContext,
  probe: LaunchProbe,
): { launch: LaunchContext; lookupFailed: boolean } {
  let launch = launchContext(probe.env());
  const sessionFlag = flagStr(ctx, "session");
  const dispatchFlag = flagStr(ctx, "dispatch");
  const pidFlag = flagNum(ctx, "pid");
  launch = overrideLaunch(launch, {
    ...(sessionFlag !== undefined ? { sessionId: sessionFlag } : {}),
    ...(dispatchFlag !== undefined ? { dispatchId: dispatchFlag } : {}),
    ...(pidFlag !== undefined ? { agentPid: pidFlag } : {}),
  });
  if (launch.dispatchId !== null || launch.terminal === null || flagBool(ctx, "no-orca")) {
    return { launch, lookupFailed: false };
  }
  const found = probe.dispatchOf(launch.terminal);
  if (found === null) return { launch, lookupFailed: true };
  return {
    launch: overrideLaunch(launch, {
      dispatchId: found.dispatchId,
      dispatchSource: "lookup",
      ...(found.runId !== null ? { runId: found.runId } : {}),
    }),
    lookupFailed: false,
  };
}

export function runView(r: RunRecord | undefined): Record<string, unknown> | null {
  if (r === undefined) return null;
  return {
    sessionId: r.sessionId,
    sessionSource: r.sessionSource,
    transcriptPath: r.transcriptPath,
    dispatchId: r.dispatchId,
    dispatchSource: r.dispatchSource,
    runId: r.runId,
    terminal: r.terminal,
    paneKey: r.paneKey,
    agentPid: r.agentPid,
    pidSource: r.pidSource,
    harnessBuild: r.harnessBuild,
    procState: r.procState,
    procCheckedAt: r.procCheckedAt === null ? null : new Date(r.procCheckedAt).toISOString(),
    procExitedAt: r.procExitedAt === null ? null : new Date(r.procExitedAt).toISOString(),
    gitHead: r.gitHead,
    filesTouched: r.filesTouched,
    recordedAt: new Date(r.recordedAt).toISOString(),
  };
}

export interface LiveRow {
  readonly attempt: Record<string, unknown>;
  readonly run: Record<string, unknown> | null;
  readonly liveState: LiveState;
  readonly meaning: string;
  /** Сколько прошло с открытия попытки — «сколько висит». */
  readonly ageMs: number;
  /** Сколько процесс живёт ПОСЛЕ приёмки; null, если работа не закрыта. */
  readonly afterFinishMs: number | null;
}

/**
 * Наблюдение над списком попыток. Пробу и часы берём снаружи: без этого
 * «завершено, но живо» проверялось бы только на живой машине, то есть
 * никогда.
 */
export function observe(
  rows: readonly AttemptWithRun[],
  probe: LaunchProbe,
  now: number,
): LiveRow[] {
  // Pid того, кто СЕЙЧАС спрашивает — из его собственного окружения, не из
  // записанного запуска. Один и тот же на все строки: спрашивающий не
  // меняется в середине наблюдения.
  const selfPid = launchContext(probe.env()).agentPid;
  return rows.map(({ attempt, run }) => {
    const orphanCtx: OrphanContext | undefined =
      run === undefined
        ? undefined
        : { dispatchSource: run.dispatchSource, agentPid: run.agentPid, selfPid };
    const state = liveStateOf(attempt, probe.alive(run?.agentPid ?? null), orphanCtx);
    return {
      attempt: attemptView(attempt),
      run: runView(run),
      liveState: state,
      meaning: LIVE_STATE_MEANING[state],
      ageMs: now - attempt.startedAt,
      afterFinishMs:
        attempt.finishedAt === null || !isAlive(state) ? null : now - attempt.finishedAt,
    };
  });
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}ч ${String(m).padStart(2, "0")}м` : `${m}м ${String(s % 60).padStart(2, "0")}с`;
}

/**
 * Плотная строка на запуск. Осиротевшее показывается ВМЕСТЕ с командой
 * снятия — но myc её не выполняет: снимает тот, кто запускал.
 */
export function renderLiveHuman(raw: unknown): string {
  const rows = raw as LiveRow[];
  if (rows.length === 0) return "живых процессов по записи нет\n";
  const lines = rows.map((r) => {
    const run = r.run as Record<string, unknown> | null;
    const pid = run?.["agentPid"];
    const sess = run?.["sessionId"];
    const disp = run?.["dispatchId"];
    return [
      String(r.attempt["attemptId"]).padEnd(16),
      String(r.attempt["taskId"]).padEnd(20),
      `${r.liveState}`.padEnd(8),
      `pid ${pid ?? "—"}`.padEnd(11),
      fmtAge(r.ageMs).padEnd(9),
      r.afterFinishMs === null ? "".padEnd(16) : `висит ${fmtAge(r.afterFinishMs)}`.padEnd(16),
      `сессия ${sess === null || sess === undefined ? "—" : String(sess).slice(0, 8)}`.padEnd(16),
      `${disp ?? "—"}`,
    ].join(" ").trimEnd();
  });
  const orphans = rows.filter((r) => r.liveState === "orphan");
  if (orphans.length > 0) {
    lines.push(
      "",
      `ОСИРОТЕЛО ${orphans.length}: работа принята, процесс жив. ` +
        "worker-release снимает учётную запись терминала, но не процесс.",
      `  kill ${orphans.map((r) => (r.run as Record<string, unknown>)["agentPid"]).join(" ")}`,
      "  (снимает тот, кто запускал: myc ведёт запись, а не процессы)",
    );
  }
  return `${lines.join("\n")}\n`;
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
  if (a["finishedAt"] === null) {
    return `${[head, cls, `open     started ${a["startedAt"]}`, ...runLines(a)].join("\n")}\n`;
  }
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
  lines.push(...runLines(a));
  return `${lines.join("\n")}\n`;
}

/** Строка запуска в человеческом выводе: сессия, диспетчер, процесс. */
function runLines(a: Record<string, unknown>): string[] {
  const r = a["run"] as Record<string, unknown> | null | undefined;
  if (r === null || r === undefined) return [];
  const out = [
    `запуск   сессия ${r["sessionId"] ?? "—"} (${r["sessionSource"]}) · ` +
      `диспетчер ${r["dispatchId"] ?? "—"} (${r["dispatchSource"]})`,
    `процесс  pid ${r["agentPid"] ?? "—"} (${r["pidSource"]}) · ${r["procState"]}` +
      (a["liveState"] === undefined ? "" : ` · ${a["liveState"]}: ${a["meaning"]}`),
  ];
  const files = r["filesTouched"] as string[] | null;
  if (files !== null && files !== undefined) {
    out.push(`тронуто  ${files.length} файлов${files.length > 0 ? `: ${files.slice(0, 3).join(", ")}${files.length > 3 ? " …" : ""}` : ""}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// attempt start / finish / list / show
// ---------------------------------------------------------------------------

/**
 * Флаги запуска. Все — ЗАПАСНОЙ путь: в норме `attempt start` вызывается
 * без единого из них, потому что процесс знает о себе всё сам.
 */
const LAUNCH_FLAGS: readonly FlagSpec[] = [
  {
    name: "session",
    value: "string",
    description: "session/transcript uuid (default $CLAUDE_CODE_SESSION_ID)",
  },
  { name: "dispatch", value: "string", description: "orchestrator dispatch id (ctx_…)" },
  { name: "pid", value: "number", description: "agent process pid (default $CLAUDE_PID)" },
  { name: "no-orca", description: "do not ask the orchestrator for the dispatch id" },
];

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
      ...LAUNCH_FLAGS,
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
      const swarm = swarmOn(h.driver.database, deps.probe.now);
      try {
        const resolved = resolveId(h, idInput);
        if (!resolved.ok) return resolved.failure;
        const node = resolved.node;

        const model = modelArg(ctx, swarm.roster);
        if (!model.ok) return model.failure;

        const taskClass =
          declaredClass ?? taskClassOf(node, h.driver.database, node.id);
        const cwd = resolve(ctx.globals.directory ?? process.cwd());
        const { launch, lookupFailed } = resolveLaunch(ctx, deps.probe);
        const record = swarm.attribution.startAttempt({
          taskId: node.id,
          modelId: model.modelId,
          taskClass,
          classSource: declaredClass === undefined ? "derived" : "declared",
          effort: flagStr(ctx, "effort") as never,
          harness: flagStr(ctx, "harness") as never,
          actor: resolveActor(ctx),
          note: flagStr(ctx, "note"),
          run: { launch, gitHead: deps.probe.gitHead(cwd) },
          ...tokenArgs(ctx),
        });
        // Молчать тут нельзя: связь, которой нет, потом ищут перебором
        // стенограмм — тем самым способом, который уже ломался.
        if (launch.sessionId === null) {
          ctx.warn(
            "launch.no_session",
            `${record.attemptId}: сессия не записана — расход придётся искать перебором ` +
              "(myc attempt start … --session <uuid> или $MYC_SESSION_ID)",
          );
        }
        if (lookupFailed) {
          ctx.warn(
            "launch.no_dispatch",
            `${record.attemptId}: терминал ${launch.terminal} известен, а диспетчер нет — ` +
              "оркестратор не ответил (myc attempt start … --dispatch ctx_…)",
          );
        }
        return {
          ok: true,
          data: { ...attemptView(record), run: runView(swarm.attribution.getRun(record.attemptId)) },
        };
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
export function swarmOn(
  db: Database,
  now: () => number = Date.now,
): { roster: Roster; attribution: Attribution } {
  ensureSwarmSchema(db);
  return { roster: new Roster(db, now), attribution: new Attribution(db, now) };
}

/**
 * Расход из записанной сессии, если руками не назвали ничего другого.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ЯВНОГО --from-session. Явный флаг — просьба
 * прочитать стенограмму, и отказ разбора обязан быть отказом команды:
 * ноль там неотличим от «не смогли прочитать». Здесь стенограмму никто не
 * просил — её нашла запись, — и терять из-за неё ВЕРДИКТ нельзя: вердикт
 * знает только координатор и вводит его один раз. Поэтому отказ разбора
 * тут WARN, а не отказ. Тихого нуля всё равно нет: строка про отказ
 * попадает и в человеческий вывод, и в конверт.
 */
export function recordedSpend(
  ctx: CommandContext,
  attribution: Attribution,
  attemptId: string,
  spend: TokenSource,
): TokenSource & { via: "flags" | "transcript" | "recorded" | "none" } {
  if (spend.transcript !== undefined) return { ...spend, via: "transcript" };
  if (Object.keys(spend.tokens).length > 0) return { ...spend, via: "flags" };
  const run = attribution.getRun(attemptId);
  if (run?.sessionId == null) return { ...spend, via: "none" };
  try {
    const dir = transcriptDir(resolve(ctx.globals.directory ?? process.cwd()));
    const path = run.transcriptPath ?? findSessionTranscript(dir, run.sessionId);
    const read = readTranscriptUsage(path);
    return {
      tokens: {
        tokensIn: read.tokensIn,
        tokensOut: read.tokensOut,
        tokensCacheRead: read.tokensCacheRead,
        tokensCacheWrite: read.tokensCacheWrite,
      },
      transcript: read,
      via: "recorded",
    };
  } catch (e) {
    const code = e instanceof TranscriptError ? e.code : "transcript.unreadable";
    ctx.warn(
      code,
      `расход по записанной сессии ${run.sessionId} не прочитан: ${(e as Error).message}`,
    );
    return { ...spend, via: "none" };
  }
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

      const opened = deps.openSwarm(ctx, deps.probe.now);
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
        // Расход по ЗАПИСАННОЙ сессии, если источник не назван руками.
        // Это и есть ответ на «считать расход без перебора файлов»:
        // стенограмма берётся по uuid из строки запуска, а не ищется по
        // строке брифа, которую человек может написать иначе.
        const recorded = recordedSpend(ctx, opened.attribution, attemptId, spend);
        const record = opened.attribution.finishAttempt(attemptId, {
          verdict,
          caveats,
          retries: flagNum(ctx, "retries"),
          note: flagStr(ctx, "note"),
          ...recorded.tokens,
        });
        const cwd = resolve(ctx.globals.directory ?? process.cwd());
        const run = opened.attribution.getRun(attemptId);
        if (run?.gitHead != null) {
          const touched = deps.probe.filesTouched(cwd, run.gitHead);
          if (touched !== null) opened.attribution.recordFilesTouched(attemptId, touched);
        }
        return {
          ok: true,
          data: {
            ...withTranscript(attemptView(record), recorded.transcript),
            run: runView(opened.attribution.getRun(attemptId)),
            spendVia: recorded.via,
          },
        };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: renderAttemptHuman,
  };
}

/**
 * Поздняя привязка: попытка уже есть, а её сессия/процесс — нет.
 *
 * Нужна ровно двум случаям, и оба реальны. Ретроспективная попытка из
 * `myc close --verdict` процесса не видела вовсе. И — главное — старая
 * дорога, поиск стенограммы перебором по строке брифа
 * (scripts/attempt-cost.ts): она осталась запасной, но её находку
 * теперь можно ЗАПИСАТЬ, пометив `--found`. Тогда угаданное видно как
 * угаданное и не выдаёт себя за записанное при старте.
 */
function buildLinkCommand(deps: AttemptDeps): Command {
  return {
    name: "link",
    summary: "attach session / dispatch / pid to an existing attempt",
    help:
      "Запасной путь: в норме связь пишется при `attempt start`. --found помечает " +
      "источник как 'search' — находку перебором стенограмм, а не запись процесса о себе.",
    flags: [
      { name: "task", value: "string", description: "link the open attempt of this task" },
      { name: "found", description: "mark the session as found by search, not recorded" },
      { name: "transcript", value: "string", description: "exact transcript file" },
      ...LAUNCH_FLAGS,
    ],
    handler: (ctx): CommandResult => {
      const opened = deps.openSwarm(ctx, deps.probe.now);
      if (!("db" in opened)) return opened;
      try {
        let attemptId = ctx.args[0];
        const taskId = flagStr(ctx, "task");
        if (attemptId === undefined) {
          if (taskId === undefined) {
            return usage(
              "usage.invalid",
              "нужен id попытки или --task <id>: myc attempt link <attempt-id> --session <uuid>",
            );
          }
          const open = opened.attribution.openAttemptForTask(taskId);
          if (open === undefined) {
            return {
              ok: false,
              code: "notfound.attempt",
              msg: `у задачи "${taskId}" нет открытой попытки`,
              exit: ExitCode.NOTFOUND,
            };
          }
          attemptId = open.attemptId;
        }
        const existing = opened.attribution.getRun(attemptId);
        const { launch } = resolveLaunch(ctx, deps.probe);
        // Уже записанное не стирается пустотой: дописать диспетчера к
        // строке с сессией — обычное дело, а потерять при этом сессию —
        // ровно та потеря связи, против которой всё писалось.
        const merged = overrideLaunch(launch, {
          ...(launch.sessionId === null && existing?.sessionId != null
            ? { sessionId: existing.sessionId, sessionSource: existing.sessionSource }
            : {}),
          ...(launch.dispatchId === null && existing?.dispatchId != null
            ? { dispatchId: existing.dispatchId, dispatchSource: existing.dispatchSource }
            : {}),
          ...(launch.agentPid === null && existing?.agentPid != null
            ? { agentPid: existing.agentPid }
            : {}),
        });
        const found = flagBool(ctx, "found");
        const run = opened.attribution.attachRun(attemptId, {
          launch:
            found && merged.sessionId !== null
              ? { ...merged, sessionSource: "search" }
              : merged,
          transcriptPath: flagStr(ctx, "transcript") ?? existing?.transcriptPath ?? null,
          gitHead: existing?.gitHead ?? null,
          procState: existing?.procState,
        });
        return { ok: true, data: { attemptId, run: runView(run) } };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as { attemptId: string; run: Record<string, unknown> | null };
      const r = d.run;
      return (
        `${d.attemptId}  сессия ${r?.["sessionId"] ?? "—"} (${r?.["sessionSource"] ?? "—"}) · ` +
        `диспетчер ${r?.["dispatchId"] ?? "—"} · pid ${r?.["agentPid"] ?? "—"}\n`
      );
    },
  };
}

function buildListCommand(deps: AttemptDeps): Command {
  return {
    name: "list",
    summary: "recorded attempts, newest first",
    help:
      "--live отвечает на вопрос «что сейчас работает и сколько висит»: смотрит на " +
      "записанные pid сигналом 0 и показывает ЖИВЫЕ процессы, отличая работающие от " +
      "тех, чья работа уже принята. Снятие — не его дело: myc ведёт запись.",
    flags: [
      { name: "task", value: "string", description: "filter by task id" },
      { name: "model", value: "string", description: "filter by model id" },
      { name: "open", description: "only unfinished attempts" },
      { name: "live", description: "only attempts whose recorded pid is still alive" },
      { name: "since", value: "string", description: "window, e.g. 7d" },
      { name: "limit", value: "number", description: "max rows (default 50)" },
    ],
    handler: (ctx): CommandResult => {
      const opened = deps.openSwarm(ctx, deps.probe.now);
      if (!("db" in opened)) return opened;
      try {
        let since: number | undefined;
        const sinceRaw = flagStr(ctx, "since");
        if (sinceRaw !== undefined) {
          const span = parseDuration(sinceRaw);
          if (span === undefined) return usage("usage.invalid", `--since: не длительность "${sinceRaw}"`);
          since = Date.now() - span;
        }
        const filter = {
          taskId: flagStr(ctx, "task"),
          modelId: flagStr(ctx, "model"),
          open: flagBool(ctx, "open"),
          since,
          limit: flagNum(ctx, "limit") ?? 50,
        };
        if (!flagBool(ctx, "live")) {
          const rows = opened.attribution.listAttempts(filter);
          return { ok: true, data: rows.map(attemptView), meta: { count: rows.length } };
        }

        // Запись процессов ведётся ЗДЕСЬ и только здесь: обычный `list` —
        // чтение и не должен ничего писать. Отметка ставится лишь на
        // расхождение (running в записи, а pid мёртв), поэтому в
        // установившемся состоянии записей не будет вовсе.
        const now = deps.probe.now();
        const seen = observe(
          opened.attribution.listWithRuns({ ...filter, withRun: true }),
          deps.probe,
          now,
        );
        for (const row of seen) {
          const id = String(row.attempt["attemptId"]);
          const state = (row.run as Record<string, unknown> | null)?.["procState"];
          if (isAlive(row.liveState)) {
            if (state === "running") opened.attribution.markSeen(id, now);
          } else if (row.liveState !== "unknown" && state !== "exited") {
            opened.attribution.markExited(id, now);
          }
        }
        const live = seen.filter((r) => isAlive(r.liveState));
        const orphans = live.filter((r) => r.liveState === "orphan").length;
        return {
          ok: true,
          data: live,
          meta: { count: live.length, orphans, scanned: seen.length },
        };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: (data, ctx) =>
      flagBool(ctx, "live") ? renderLiveHuman(data) : renderAttemptListHuman(data),
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
      const opened = deps.openSwarm(ctx, deps.probe.now);
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
        const run = opened.attribution.getRun(attemptId);
        const state = liveStateOf(record, deps.probe.alive(run?.agentPid ?? null));
        return {
          ok: true,
          data: {
            ...attemptView(record),
            run: runView(run),
            liveState: state,
            meaning: LIVE_STATE_MEANING[state],
          },
        };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: renderAttemptHuman,
  };
}

export function createAttemptCommand(deps: AttemptDeps = realAttemptDeps): Command {
  return {
    name: "attempt",
    summary: "execution attribution: who ran the task, with what, to what result",
    subcommands: [
      buildStartCommand(deps),
      buildFinishCommand(deps),
      buildLinkCommand(deps),
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

export function createReportCommand(deps: AttemptDeps = realAttemptDeps): Command {
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
      const opened = deps.openSwarm(ctx, deps.probe.now);
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
