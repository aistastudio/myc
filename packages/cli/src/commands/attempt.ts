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
 *   myc attempt reclass [--task <id>] [--dry-run]
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

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { readRepo, type JsonValue } from "@myc/core";
import { STORE_PRAGMAS } from "@myc/store-sqlite";
import {
  Attribution,
  AttributionError,
  CAVEATS,
  classifyTask,
  compareModels,
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
  pathsInText,
  pidAlive,
  readTranscriptUsage,
  Roster,
  RosterError,
  snapshotCheckouts,
  touchedSince,
  transcriptDir,
  TranscriptError,
  VERDICTS,
  type AttemptRecord,
  type AttemptWithRun,
  type Caveat,
  type ClassAnswer,
  type ClassifyResult,
  type CompareReport,
  type GitBase,
  type LaunchContext,
  type LiveState,
  type OrphanContext,
  type RunRecord,
  type TouchedKey,
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
import { wsPathOfKey } from "./anchor.ts";
import { findWorkspaceDb, workspaceDirOfDb } from "./wsfind.ts";

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
  /**
   * Снимок рабочих деревьев на старте (@myc/swarm, touched.ts): корень, где
   * стоит попытка, HEAD и хеши уже грязных файлов, из основного дерева
   * корня — и вложенные репозитории. null — снимать нечего.
   */
  gitBase(cwd: string, wsDir: string): Promise<GitBase | null>;
  /** Что изменилось со снимка, ключами (репозиторий, путь); null — посчитать нечем. */
  touchedSince(base: GitBase): Promise<readonly TouchedKey[] | null>;
  now(): number;
}

export interface AttemptDeps {
  /** Только таблицы роя: `report`/`attempt finish` графа L1 не касаются. */
  openSwarm(ctx: CommandContext, now: () => number): SwarmHandle | CommandFailure;
  /** Граф L1: нужен там, где класс задачи считается из самой задачи. */
  readonly store: StoreDeps;
  readonly probe: LaunchProbe;
}

/**
 * База роя — та же, что у графа: подъём к первому `.myc` (R1) и через ссылку
 * git worktree в основное дерево. Раньше здесь стоял `<cwd>/.myc/myc.db`
 * без подъёма, и `attempt finish` из вложенного репозитория или worktree
 * агента отвечал `ws.not_initialized`, хотя `attempt start` оттуда же
 * проходил: граф поднимался, база роя — нет.
 */
export function dbPathOf(ctx: CommandContext): string {
  if (ctx.globals.db !== undefined) return ctx.globals.db;
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  const found = findWorkspaceDb(dir);
  return "dbPath" in found ? found.dbPath : join(dir, ".myc", "myc.db");
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
      msg: `workspace not initialized: no ${dbPath}`,
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
  gitBase: (cwd, wsDir) => snapshotCheckouts(cwd, wsDir),
  touchedSince: (base) => touchedSince(base),
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
  gitBase: async () => null,
  touchedSince: async () => null,
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
        msg: `model "${input}" not found in the roster; an outcome cannot be recorded without a roster model`,
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
      msg: `"${input}" matches several models: ${hits.join(", ")}`,
      exit: ExitCode.CONFLICT,
      hint: "narrow down the model id",
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
        "no model given: which model ran the task?",
        "--model <id> or the MYC_MODEL environment variable",
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
      "--from-transcript and --from-session together: usage has exactly one source",
    );
  }
  if (file === undefined && session === undefined) return { tokens: tokenArgs(ctx) };

  const manual = MANUAL_TOKEN_FLAGS.filter((f) => flagNum(ctx, f) !== undefined);
  if (manual.length > 0) {
    return usage(
      "usage.token_source",
      `usage given both by a transcript and by flags (${manual.map((f) => `--${f}`).join(", ")}); ` +
        "there must be exactly one source",
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
      `unknown caveat: ${bad.join(", ")}; allowed: ${CAVEATS.join(", ")}`,
    );
  }
  return parts as Caveat[];
}

// ---------------------------------------------------------------------------
// Класс задачи из самой задачи
// ---------------------------------------------------------------------------

interface NodeLike {
  readonly title: string;
  readonly body?: string | null;
  readonly attrs: Readonly<Record<string, JsonValue>>;
}

/**
 * Путь от корня воркспейса для пути, записанного ОТ РЕПОЗИТОРИЯ задачи
 * (`attrs.repo`, S59): намерение якоря в `attrs.anchors` и путь в тексте
 * задачи пишутся так, как их видел автор из своего каталога. Уже полный
 * путь (`<repo>/…`) второй раз не приклеивается; `..` и абсолютный путь
 * ключа не имеют — null.
 */
function wsPathForTask(node: NodeLike, path: string): string | null {
  const clean = path.replace(/^\.\//, "");
  if (clean === "" || clean.startsWith("/") || clean === ".." || clean.startsWith("../")) return null;
  const repo = readRepo(node.attrs).repo ?? "";
  if (repo === "" || clean === repo || clean.startsWith(`${repo}/`)) return clean;
  return wsPathOfKey(repo, clean);
}

/**
 * Пути якорей: заявленные в `attrs` и связанные ребром `touches` — все ОТ
 * КОРНЯ ВОРКСПЕЙСА (memory-pj163pnxzy3a).
 *
 * ЗАПРОС ИДЁТ ЧЕРЕЗ РЕБРО, А НЕ ПО `anchors.node_id = <id задачи>`. Якорь —
 * это ОТДЕЛЬНЫЙ узел `kind='anchor'` (первичный ключ `anchors.node_id`
 * допускает ровно одну строку на узел, то есть узел и есть якорь), а задача
 * связана с ним ребром `touches`; ровно так его читает и `ready`
 * (ANCHOR_SUBQ). Пока здесь стояло `WHERE node_id = <id задачи>`, выборка не
 * находила НИ ОДНОГО привязанного якоря, и `scope` класса задачи оставался
 * `unknown` у всех задач разом — а роутинг считается по классу.
 *
 * ПУТЬ — ИЗ ОБОИХ ПОЛЕЙ КЛЮЧА. Якорь из корня экосистемы лежит ключом
 * `('', 'messaging-server/x.ts')`, из messaging-server на тот же файл —
 * `('messaging-server', 'x.ts')` (anchor.ts, `anchorKeysFor`). Пока отсюда
 * отдавался один `a.path`, scope считался по каталогам верхнего уровня
 * РАЗНЫХ путей, и local/cross одной задачи зависел от того, откуда агент
 * поставил якорь. `wsPathOfKey` сводит оба ключа к одному пути.
 */
export function anchorPathsOf(node: NodeLike, db: Database, nodeId: string): string[] {
  const paths: string[] = [];
  const declared = node.attrs["anchors"];
  if (Array.isArray(declared)) {
    for (const a of declared) {
      if (a !== null && typeof a === "object" && typeof (a as { path?: unknown }).path === "string") {
        const ws = wsPathForTask(node, (a as { path: string }).path);
        if (ws !== null) paths.push(ws);
      }
    }
  }
  const bound = db
    .query(
      `SELECT a.repo_id AS repo_id, a.path AS path
         FROM edges e JOIN anchors a ON a.node_id = e.dst
        WHERE e.src = ?1 AND e.type = 'touches' AND e.deleted_at IS NULL`,
    )
    .all(nodeId) as Array<{ repo_id: string; path: string }>;
  for (const row of bound) paths.push(wsPathOfKey(row.repo_id, row.path));
  return paths;
}

/**
 * Пути файлов, НАЗВАННЫЕ в тексте задачи (заголовок и описание), — только те,
 * что есть в воркспейсе. Проверка на диске не украшение: замер по 307 задачам
 * этого воркспейса — у 17 scope по тексту менялся от путей, которых нет:
 * примеры (`messaging-server/x.ts` в задаче про чужой репозиторий),
 * обрезанные пути (`retrieval/hybrid.ts` вместо `packages/retrieval/src/…`),
 * файлы из временных каталогов. Такой путь дал бы лишний каталог верхнего
 * уровня и сделал бы задачу «cross» на ровном месте.
 *
 * Без корня воркспейса (`wsDir` не известен) проверять не на чем, и текст
 * НЕ используется вовсе: непроверенный путь хуже отсутствующего.
 */
export function textPathsOf(node: NodeLike, wsDir: string | undefined): string[] {
  if (wsDir === undefined) return [];
  const out: string[] = [];
  for (const p of pathsInText(`${node.title}\n${node.body ?? ""}`)) {
    const ws = wsPathForTask(node, p);
    if (ws === null) continue;
    try {
      if (statSync(join(wsDir, ws)).isFile()) out.push(ws);
    } catch {
      /* нет такого файла — не путь задачи */
    }
  }
  return out;
}

function typeOf(node: NodeLike): { readonly type?: string } {
  const type = node.attrs["type"];
  return typeof type === "string" ? { type } : {};
}

/**
 * КЛЮЧ — класс, по которому копится статистика (S67): scope из ФАКТА, если он
 * передан (`touched` — файлы, изменившиеся за попытку, уже от корня
 * воркспейса), иначе из якорей, иначе `unknown`.
 *
 * Пути из ТЕКСТА задачи в ключ не идут, и это решение по замеру, а не вкус.
 * На этом воркспейсе 32 попытки с классом, который координатор назвал руками
 * после приёмки; там, где текст задачи вообще давал scope (10 из 32), он
 * совпал с названным ОДИН раз: задача называет один файл-вход, а работа
 * задевает ещё тесты и соседей, и текст систематически говорит `local` там,
 * где было `module`/`cross`. Ключ из такого источника наполнил бы корзину
 * `local` чужими задачами — это хуже честного `unknown`.
 */
export function keyFromTask(
  node: NodeLike,
  db: Database,
  nodeId: string,
  touched: readonly string[] | null = null,
): ClassifyResult {
  return classifyTask({
    title: node.title,
    ...typeOf(node),
    sources: { touched, anchors: anchorPathsOf(node, db, nodeId) },
  });
}

/**
 * ПРЕДСКАЗАНИЕ — что видел бы роутер на старте: якоря, иначе пути из текста.
 * Пишется в `predicted_class` и не переписывается; ключ на финише сменит
 * факт, и пара `predicted × task_class` покажет, насколько предсказание
 * врёт (§2.1.3). Без `wsDir` текст не проверить на диске, и он не
 * используется (`textPathsOf`).
 */
export function predictFromTask(
  node: NodeLike,
  db: Database,
  nodeId: string,
  wsDir: string | undefined,
): ClassifyResult {
  return classifyTask({
    title: node.title,
    ...typeOf(node),
    sources: { anchors: anchorPathsOf(node, db, nodeId), text: textPathsOf(node, wsDir) },
  });
}

/**
 * Ключ строкой без факта: якоря или `unknown` — ровно как было до S67. Так
 * ключ ретроспективной попытки `myc close --verdict` выглядит на старте; на
 * финише его пересчитывает `finishWithFact`, как у любой попытки.
 */
export function taskClassOf(node: NodeLike, db: Database, nodeId: string): string {
  return keyFromTask(node, db, nodeId).taskClass;
}

/**
 * Задача по id прямо из таблицы узлов — для команд, которые открывают только
 * базу роя (`attempt finish`, `attempt reclass`). Узла нет или таблицы нет
 * (база роя отдельным файлом) — undefined: пересчитывать класс не из чего.
 */
function taskRowOf(db: Database, taskId: string): NodeLike | undefined {
  try {
    const row = db
      .query("SELECT title, body, attrs FROM nodes WHERE id = ?1")
      .get(taskId) as { title: string; body: string | null; attrs: string | null } | null;
    if (row === null) return undefined;
    let attrs: Record<string, JsonValue> = {};
    try {
      const parsed: unknown = JSON.parse(row.attrs ?? "{}");
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        attrs = parsed as Record<string, JsonValue>;
      }
    } catch {
      /* битые attrs — класс считается без них */
    }
    return { title: row.title, body: row.body, attrs };
  } catch {
    return undefined;
  }
}

/** Тронутые файлы попытки ключами → пути от корня воркспейса (один файл — один путь). */
export function wsPathsOfTouched(keys: readonly TouchedKey[]): string[] {
  return [...new Set(keys.map((k) => wsPathOfKey(k.prefix, k.path)))].sort();
}

export interface Settled {
  readonly attemptId: string;
  readonly from: string;
  readonly to: string;
  /** Источник scope ключа; `declared` — ключ назван руками и не пересчитывался. */
  readonly scopeSource: string;
  /** Предсказание попытки после пересчёта (записанное раньше не меняется). */
  readonly predicted: string | null;
  /** Сменился ключ или его источник. */
  readonly changed: boolean;
  /** Записано предсказание, которого не было (попытка до миграции 9). */
  readonly predictionFilled: boolean;
  /** Почему ключ не пересчитан. Пусто — пересчитан (или совпал). */
  readonly skipped?: string;
}

/**
 * Ключ попытки по лучшему источнику — на финише и в пересчёте — плюс
 * предсказание там, где его ещё нет. Объявленный руками ключ (`--class`)
 * не трогается. `touched` — факт этой попытки (уже от корня воркспейса) или
 * null.
 */
export function settleAttemptClass(
  db: Database,
  attribution: Attribution,
  attempt: AttemptRecord,
  touched: readonly string[] | null,
  wsDir: string | undefined,
  opts: { readonly dryRun?: boolean } = {},
): Settled {
  const base = { attemptId: attempt.attemptId, from: attempt.taskClass };
  const node = taskRowOf(db, attempt.taskId);
  if (node === undefined) {
    return {
      ...base,
      to: attempt.taskClass,
      scopeSource: attempt.classSource === "declared" ? "declared" : (attempt.scopeSource ?? "—"),
      predicted: attempt.predictedClass,
      changed: false,
      predictionFilled: false,
      skipped: "task not in this database",
    };
  }
  const predicted = attempt.predictedClass ?? predictFromTask(node, db, attempt.taskId, wsDir).taskClass;
  const predictionFilled = attempt.predictedClass === null;
  if (attempt.classSource === "declared") {
    if (predictionFilled && opts.dryRun !== true) attribution.fillPrediction(attempt.attemptId, predicted);
    return {
      ...base,
      to: attempt.taskClass,
      scopeSource: "declared",
      predicted,
      changed: false,
      predictionFilled,
      skipped: "declared by hand",
    };
  }
  const key = keyFromTask(node, db, attempt.taskId, touched);
  if (opts.dryRun === true) {
    const changed = key.taskClass !== attempt.taskClass || key.scopeSource !== attempt.scopeSource;
    return { ...base, to: key.taskClass, scopeSource: key.scopeSource, predicted, changed, predictionFilled };
  }
  const before = attempt.taskClass !== key.taskClass || attempt.scopeSource !== key.scopeSource;
  const r = attribution.settleClass(attempt.attemptId, {
    taskClass: key.taskClass,
    scopeSource: key.scopeSource,
    predictedClass: predicted,
  });
  return {
    ...base,
    to: r.record.taskClass,
    scopeSource: key.scopeSource,
    predicted: r.record.predictedClass,
    changed: before,
    predictionFilled,
  };
}

/**
 * Совпадение предсказания с ключом там, где у обоих известен scope, — самая
 * дешёвая проверка классификатора: против факта или против класса, который
 * координатор назвал руками после приёмки.
 */
export function predictionAgreement(
  rows: ReadonlyArray<{ readonly taskClass: string; readonly predicted: string | null }>,
): { readonly compared: number; readonly sameClass: number; readonly sameScope: number } {
  let compared = 0;
  let sameClass = 0;
  let sameScope = 0;
  for (const r of rows) {
    if (r.predicted === null) continue;
    const scope = r.taskClass.split(":")[1];
    const predictedScope = r.predicted.split(":")[1];
    if (scope === "unknown" || predictedScope === "unknown") continue;
    compared++;
    if (scope === predictedScope) sameScope++;
    if (r.taskClass === r.predicted) sameClass++;
  }
  return { compared, sameClass, sameScope };
}

/** Распределение по ключу: `класс → число попыток`, по убыванию числа. */
export function classDistribution(
  rows: ReadonlyArray<{ readonly taskClass: string }>,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.taskClass, (counts.get(r.taskClass) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Чем решён класс: `declared` — назван руками, `touched`/`anchors`/`text`/
 * `none` — выведен из этого источника, `unrecorded` — выведен, но источник не
 * записан (попытки до миграции 9 и ретроспектива `myc close --verdict`).
 */
export function scopeDistribution(
  rows: ReadonlyArray<{ readonly classSource: string; readonly scopeSource: string | null }>,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.classSource === "declared" ? "declared" : (r.scopeSource ?? "unrecorded");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([, x], [, y]) => y - x));
}

function distLine(label: string, dist: Record<string, unknown>): string {
  const parts = Object.entries(dist).map(([k, n]) => `${k} ${n}`);
  return `${label.padEnd(8)} ${parts.length === 0 ? "—" : parts.join(" · ")}`;
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
    scopeSource: a.scopeSource,
    predictedClass: a.predictedClass,
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
    gitBase:
      r.gitBase === null
        ? null
        : r.gitBase.checkouts.map((c) => ({
            root: c.root,
            prefix: c.prefix,
            head: c.head,
            dirtyAtStart: Object.keys(c.dirty).length,
          })),
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
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Плотная строка на запуск. Осиротевшее показывается ВМЕСТЕ с командой
 * снятия — но myc её не выполняет: снимает тот, кто запускал.
 */
export function renderLiveHuman(raw: unknown): string {
  const rows = raw as LiveRow[];
  if (rows.length === 0) return "no live processes on record\n";
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
      r.afterFinishMs === null ? "".padEnd(16) : `hanging ${fmtAge(r.afterFinishMs)}`.padEnd(16),
      `session ${sess === null || sess === undefined ? "—" : String(sess).slice(0, 8)}`.padEnd(16),
      `${disp ?? "—"}`,
    ].join(" ").trimEnd();
  });
  const orphans = rows.filter((r) => r.liveState === "orphan");
  if (orphans.length > 0) {
    lines.push(
      "",
      `ORPHANED ${orphans.length}: work accepted, process still alive. ` +
        "worker-release drops the terminal's registration, not the process.",
      `  kill ${orphans.map((r) => (r.run as Record<string, unknown>)["agentPid"]).join(" ")}`,
      "  (whoever launched it kills it: myc keeps records, not processes)",
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
  if (rows.length === 0) return "no attempts\n";
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
  // Распределение — ответ на вопрос «по скольким корзинам вообще идёт
  // роутинг»: пока класс был `*:unknown` у всех, это была одна корзина, и
  // увидеть это можно было только перебором строк глазами.
  const views = rows as Array<{ taskClass: string; classSource: string; scopeSource: string | null }>;
  lines.push(
    "",
    distLine("classes", classDistribution(views)),
    distLine("from", scopeDistribution(views)),
  );
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
  const from =
    a["classSource"] === "declared" ? "declared" : `from ${a["scopeSource"] ?? "unrecorded"}`;
  const predicted =
    a["predictedClass"] !== null && a["predictedClass"] !== undefined && a["predictedClass"] !== a["taskClass"]
      ? ` · predicted ${a["predictedClass"]}`
      : "";
  const cls = `class    ${a["taskClass"]} (${from})${predicted}`;
  if (a["finishedAt"] === null) {
    return `${[head, cls, `open     started ${a["startedAt"]}`, ...runLines(a)].join("\n")}\n`;
  }
  const caveats = a["caveats"] as string[];
  const verdict = `verdict  ${a["verdict"]}${caveats.length > 0 ? ` · caveats: ${caveats.join(", ")}` : ""}`;
  const quality = `quality  ${(a["quality"] as number).toFixed(2)}   cost ${fmtUsd(
    a["costUsd"] as number | null,
  )} (${a["costBasis"]})`;
  const lines = [head, cls, verdict, quality];
  const t = a["transcript"] as
    | { sessionId: string | null; responses: number; usageRecords: number }
    | undefined;
  if (t !== undefined) {
    lines.push(
      `usage    in ${a["tokensIn"]} out ${a["tokensOut"]} · ` +
        `session ${t.sessionId ?? "?"}, responses ${t.responses} of ${t.usageRecords} records`,
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
    `launch   session ${r["sessionId"] ?? "—"} (${r["sessionSource"]}) · ` +
      `dispatch ${r["dispatchId"] ?? "—"} (${r["dispatchSource"]})`,
    `process  pid ${r["agentPid"] ?? "—"} (${r["pidSource"]}) · ${r["procState"]}` +
      (a["liveState"] === undefined ? "" : ` · ${a["liveState"]}: ${a["meaning"]}`),
  ];
  const files = r["filesTouched"] as string[] | null;
  if (files !== null && files !== undefined) {
    // Список без снимка на старте записан наивным диффом от HEAD — в нём вся
    // несданная работа соседей, и классу он не факт (S67): это видно здесь же.
    const naive = r["gitBase"] === null || r["gitBase"] === undefined ? " (no start snapshot: not used as fact)" : "";
    out.push(`touched  ${files.length} ${files.length === 1 ? "file" : "files"}${files.length > 0 ? `: ${files.slice(0, 3).join(", ")}${files.length > 3 ? " …" : ""}` : ""}${naive}`);
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
      "The model comes from --model or $MYC_MODEL and must be in the roster. Harness and " +
      "reasoning effort are inherited from the roster; the task class is derived from the task itself.",
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
        return usage("usage.invalid", "task id required: myc attempt start <id>");
      }
      const declaredClass = flagStr(ctx, "class");
      if (declaredClass !== undefined && !isTaskClass(declaredClass)) {
        return usage("usage.class", `--class must be intent:scope, got "${declaredClass}"`);
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

        // Ключ на старте — якоря или `unknown`; факт (тронутые файлы) появится
        // только на финише и заменит ключ там. Предсказание — то, что видел бы
        // роутер (якоря, иначе пути из текста), — пишется рядом и остаётся.
        const key =
          declaredClass === undefined ? keyFromTask(node, h.driver.database, node.id) : undefined;
        const predicted = predictFromTask(node, h.driver.database, node.id, h.wsDir);
        const cwd = resolve(ctx.globals.directory ?? process.cwd());
        const { launch, lookupFailed } = resolveLaunch(ctx, deps.probe);
        const gitBase = await deps.probe.gitBase(cwd, h.wsDir);
        const record = swarm.attribution.startAttempt({
          taskId: node.id,
          modelId: model.modelId,
          taskClass: declaredClass ?? key!.taskClass,
          classSource: declaredClass === undefined ? "derived" : "declared",
          ...(key !== undefined ? { scopeSource: key.scopeSource } : {}),
          predictedClass: predicted.taskClass,
          effort: flagStr(ctx, "effort") as never,
          harness: flagStr(ctx, "harness") as never,
          actor: resolveActor(ctx),
          note: flagStr(ctx, "note"),
          run: { launch, gitHead: gitBase?.checkouts[0]?.head ?? null, gitBase },
          ...tokenArgs(ctx),
        });
        // Молчать тут нельзя: связь, которой нет, потом ищут перебором
        // стенограмм — тем самым способом, который уже ломался.
        if (launch.sessionId === null) {
          ctx.warn(
            "launch.no_session",
            `${record.attemptId}: session not recorded — usage will have to be found by scanning ` +
              "(myc attempt start … --session <uuid> or $MYC_SESSION_ID)",
          );
        }
        if (lookupFailed) {
          ctx.warn(
            "launch.no_dispatch",
            `${record.attemptId}: terminal ${launch.terminal} is known but the dispatch is not — ` +
              "the orchestrator did not answer (myc attempt start … --dispatch ctx_…)",
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
      `usage of recorded session ${run.sessionId} not read: ${(e as Error).message}`,
    );
    return { ...spend, via: "none" };
  }
}

/** Исход попытки, как его назвал координатор. */
export interface FinishOutcome {
  readonly verdict: string;
  readonly caveats: readonly Caveat[];
  readonly retries?: number;
  readonly note?: string;
}

export interface FinishedWithFact {
  /** Попытка ПОСЛЕ пересчёта ключа: класс в ней — уже по факту, если он был. */
  readonly record: AttemptRecord;
  readonly spend: ReturnType<typeof recordedSpend>;
  readonly settled: Settled | { readonly skipped: string };
}

/**
 * ФИНИШ ПОПЫТКИ — ОДИН НА ВСЕ ПУТИ: `myc attempt finish` и `myc close
 * --verdict` (memory-3hz420r5b0c7). Исход, расход, тронутые файлы и ключ
 * класса по факту (S67) — в этом порядке и только здесь.
 *
 * Пока факт считался в теле `attempt finish`, закрытие задачи с вердиктом
 * закрывало ту же попытку голым `finishAttempt`: `files_touched` не
 * писался, ключ оставался стартовым (якоря или `unknown`), и одна и та же
 * работа ложилась в статистику разными классами в зависимости от того,
 * какой командой координатор её принял.
 *
 * ФАКТ — что изменилось со снимка, снятого на старте, в тех деревьях, где
 * стояла попытка (worktree агента, вложенный репозиторий), а не в каталоге
 * того, кто финиширует. Попытка без снимка (открыта до миграции 9 или
 * ретроспективно) факта не имеет: наивный дифф от HEAD записывал всю
 * несданную работу соседей и здесь не зовётся.
 *
 * Вердикт записывается ПЕРВЫМ, и терять его из-за пересчёта ключа нельзя:
 * сбой пересчёта — громкая деградация (И2), а не отказ. Сбой самой записи
 * исхода — бросок, как у `finishAttempt`: вызывающий решает, отказ это или WARN.
 */
export async function finishWithFact(
  ctx: CommandContext,
  swarm: { readonly db: Database; readonly attribution: Attribution },
  probe: Pick<LaunchProbe, "touchedSince">,
  attemptId: string,
  spend: TokenSource,
  outcome: FinishOutcome,
  wsDir: string | undefined,
): Promise<FinishedWithFact> {
  // Расход по ЗАПИСАННОЙ сессии, если источник не назван руками. Это и есть
  // ответ на «считать расход без перебора файлов»: стенограмма берётся по
  // uuid из строки запуска, а не ищется по строке брифа, которую человек
  // может написать иначе.
  const recorded = recordedSpend(ctx, swarm.attribution, attemptId, spend);
  const record = swarm.attribution.finishAttempt(attemptId, {
    verdict: outcome.verdict,
    caveats: outcome.caveats,
    retries: outcome.retries,
    note: outcome.note,
    ...recorded.tokens,
  });
  const run = swarm.attribution.getRun(attemptId);
  let touched: string[] | null = null;
  if (run?.gitBase != null) {
    const keys = await probe.touchedSince(run.gitBase);
    if (keys === null) {
      ctx.warn(
        "attempt.touched_unknown",
        `${attemptId}: files touched not measured — the checkout recorded at start ` +
          `(${run.gitBase.checkouts[0]?.root ?? "?"}) is gone or git did not answer; ` +
          "the class falls back to anchors, then to paths named in the task",
      );
    } else {
      touched = wsPathsOfTouched(keys);
      swarm.attribution.recordFilesTouched(attemptId, touched);
    }
  }
  let settled: Settled | { readonly skipped: string };
  try {
    settled = settleAttemptClass(swarm.db, swarm.attribution, record, touched, wsDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.warn("attempt.class_not_settled", `${attemptId}: class kept as at start — ${msg}`);
    settled = { skipped: msg };
  }
  return { record: swarm.attribution.getAttempt(attemptId) ?? record, spend: recorded, settled };
}

function buildFinishCommand(deps: AttemptDeps): Command {
  return {
    name: "finish",
    summary: "record the outcome of an attempt",
    help:
      "Usage comes from the session transcript (--from-transcript/--from-session) or " +
      "from manual flags — one or the other, not both. The transcript is a foreign format: " +
      "any mismatch with the expected shape is a refusal, not zero usage.",
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
    handler: async (ctx): Promise<CommandResult> => {
      const verdict = flagStr(ctx, "verdict");
      if (verdict === undefined) {
        return usage("usage.verdict", `--verdict required: ${VERDICTS.join("|")}`);
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
              "attempt id or --task <id> required: myc attempt finish <attempt-id> --verdict …",
            );
          }
          const open = opened.attribution.openAttemptForTask(taskId);
          if (open === undefined) {
            return {
              ok: false,
              code: "notfound.attempt",
              msg: `task "${taskId}" has no open attempt`,
              exit: ExitCode.NOTFOUND,
              hint: `myc attempt start ${taskId} --model <id>`,
            };
          }
          attemptId = open.attemptId;
        }
        const done = await finishWithFact(
          ctx,
          opened,
          deps.probe,
          attemptId,
          spend,
          { verdict, caveats, retries: flagNum(ctx, "retries"), note: flagStr(ctx, "note") },
          workspaceDirOfDb(dbPathOf(ctx)),
        );
        return {
          ok: true,
          data: {
            ...withTranscript(attemptView(done.record), done.spend.transcript),
            run: runView(opened.attribution.getRun(attemptId)),
            spendVia: done.spend.via,
            classSettled: done.settled,
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
      "Fallback path: normally the link is written at `attempt start`. --found marks " +
      "the source as 'search' — found by scanning transcripts, not recorded by the process itself.",
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
              "attempt id or --task <id> required: myc attempt link <attempt-id> --session <uuid>",
            );
          }
          const open = opened.attribution.openAttemptForTask(taskId);
          if (open === undefined) {
            return {
              ok: false,
              code: "notfound.attempt",
              msg: `task "${taskId}" has no open attempt`,
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
          gitBase: existing?.gitBase ?? null,
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
        `${d.attemptId}  session ${r?.["sessionId"] ?? "—"} (${r?.["sessionSource"] ?? "—"}) · ` +
        `dispatch ${r?.["dispatchId"] ?? "—"} · pid ${r?.["agentPid"] ?? "—"}\n`
      );
    },
  };
}

function buildListCommand(deps: AttemptDeps): Command {
  return {
    name: "list",
    summary: "recorded attempts, newest first",
    help:
      "--live answers 'what is running now and for how long': it probes the " +
      "recorded pids with signal 0 and shows LIVE processes, telling working ones from " +
      "those whose work is already accepted. Killing them is not its job: myc keeps records.",
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
          if (span === undefined) {
            return usage("usage.invalid", `invalid --since "${sinceRaw}"; format: 30m, 2h, 1d`);
          }
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
          return {
            ok: true,
            data: rows.map(attemptView),
            meta: {
              count: rows.length,
              classes: classDistribution(rows),
              classFrom: scopeDistribution(rows),
            },
          };
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
        return usage("usage.invalid", "attempt id required: myc attempt show <attempt-id>");
      }
      const opened = deps.openSwarm(ctx, deps.probe.now);
      if (!("db" in opened)) return opened;
      try {
        const record = opened.attribution.getAttempt(attemptId);
        if (record === undefined) {
          return {
            ok: false,
            code: "notfound.attempt",
            msg: `attempt "${attemptId}" not found`,
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

/**
 * Пересчёт класса уже записанных попыток (memory-1ax1pmk6mc3q).
 *
 * ЧТО МЕНЯЕТСЯ — ТОЛЬКО КЛАСС. `settleClass` пишет `task_class` и
 * `scope_source`, а `predicted_class` — только там, где его ещё нет;
 * вердикт, оговорки, токены и замороженная стоимость в UPDATE не входят
 * вовсе. Ключ, названный руками (`--class`), не трогается — ему лишь
 * дописывается предсказание, и пара «предсказано × названо координатором»
 * печатается строкой `agree`: это самая дешёвая проверка классификатора.
 *
 * ОТКУДА БЕРЁТСЯ ФАКТ ДЛЯ СТАРЫХ ПОПЫТОК. Только из `files_touched`,
 * посчитанных по снимку (`git_base`, миграция 9). Списки, записанные до неё
 * наивным `git diff <HEAD на старте>`, НЕ используются: у трёх разных задач
 * этого воркспейса там один и тот же список из 46 файлов — рабочее дерево
 * координатора. История git тоже не источник: коммиты здесь не называют
 * задачу и сливают работу нескольких агентов (из 50 отчётов 43 лежат в
 * коммитах, внёсших по 3–33 отчёта). Без факта ключ — якоря или `unknown`.
 */
function buildReclassCommand(deps: AttemptDeps): Command {
  return {
    name: "reclass",
    summary: "recompute the task class of recorded attempts from the best source",
    help:
      "The key (task_class) comes from files touched during the attempt (only when measured by " +
      "the start snapshot), else from task anchors, else it stays unknown. The prediction " +
      "(predicted_class: anchors, else file paths named in the task) is filled only where it is " +
      "missing. Verdicts, caveats, tokens and frozen cost stay as they are; a class declared " +
      "with --class is kept.",
    flags: [
      { name: "task", value: "string", description: "only attempts of this task" },
      { name: "dry-run", description: "show what would change, write nothing" },
    ],
    handler: (ctx): CommandResult => {
      const opened = deps.openSwarm(ctx, deps.probe.now);
      if (!("db" in opened)) return opened;
      try {
        const dryRun = flagBool(ctx, "dry-run");
        const wsDir = workspaceDirOfDb(dbPathOf(ctx));
        const rows = opened.attribution.listWithRuns({
          ...(flagStr(ctx, "task") !== undefined ? { taskId: flagStr(ctx, "task")! } : {}),
          limit: Number.MAX_SAFE_INTEGER,
        });
        const before = rows.map((r) => r.attempt);
        const results: Settled[] = rows.map(({ attempt, run }) =>
          settleAttemptClass(
            opened.db,
            opened.attribution,
            attempt,
            run?.gitBase != null ? (run.filesTouched ?? null) : null,
            wsDir,
            { dryRun },
          ),
        );
        const after = rows.map(({ attempt }, i) => ({
          taskClass: results[i]!.to,
          classSource: attempt.classSource,
          scopeSource:
            results[i]!.skipped === undefined ? results[i]!.scopeSource : attempt.scopeSource,
          predicted: results[i]!.predicted,
        }));
        return {
          ok: true,
          data: {
            dryRun,
            scanned: rows.length,
            changed: results.filter((r) => r.changed).length,
            predictionsFilled: results.filter((r) => r.predictionFilled).length,
            declared: rows.filter((r) => r.attempt.classSource === "declared").length,
            skipped: results.filter((r) => r.skipped !== undefined && r.skipped !== "declared by hand").length,
            before: classDistribution(before),
            after: classDistribution(after),
            classFrom: scopeDistribution(after),
            predicted: classDistribution(
              after.flatMap((a) => (a.predicted === null ? [] : [{ taskClass: a.predicted }])),
            ),
            agreement: predictionAgreement(after),
            changes: results.filter((r) => r.changed),
          },
        };
      } catch (e) {
        return attemptFailure(e);
      } finally {
        opened.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as {
        dryRun: boolean;
        scanned: number;
        changed: number;
        predictionsFilled: number;
        declared: number;
        skipped: number;
        before: Record<string, number>;
        after: Record<string, number>;
        classFrom: Record<string, number>;
        predicted: Record<string, number>;
        agreement: { compared: number; sameClass: number; sameScope: number };
        changes: Settled[];
      };
      const lines = d.changes.map(
        (c) => `${c.attemptId.padEnd(16)} ${c.from.padEnd(17)} → ${c.to.padEnd(17)} (${c.scopeSource})`,
      );
      if (lines.length > 0) lines.push("");
      const verb = d.dryRun ? "would change" : "changed";
      lines.push(
        `${verb} ${d.changed} of ${d.scanned} · predictions ${d.dryRun ? "to fill" : "filled"} ` +
          `${d.predictionsFilled} · declared by hand ${d.declared} (key kept)` +
          (d.skipped > 0 ? ` · task not found ${d.skipped}` : ""),
        distLine("before", d.before),
        distLine("after", d.after),
        distLine("from", d.classFrom),
        distLine("predict", d.predicted),
        `agree    scope ${d.agreement.sameScope} of ${d.agreement.compared}, class ${d.agreement.sameClass} ` +
          `of ${d.agreement.compared} (prediction vs key, both scopes known)`,
      );
      return `${lines.join("\n")}\n`;
    },
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
      buildReclassCommand(deps),
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
        `cost=${fmtUsd(arm.costUsdMean)}/attempt (${arm.costedAttempts}/${arm.attempts})  ` +
        `clean ${Math.round(arm.cleanRate * 100)}%`,
    );
  }
  lines.push(`    ${cls.answer}${cls.separationPending ? " (not separated yet)" : ""}: ${cls.why}`);
  return lines;
}

function renderReportHuman(raw: unknown): string {
  const d = raw as ReportData;
  const lines: string[] = [];
  if (d.classes.length === 0) {
    lines.push("no attribution: not a single closed attempt");
  }
  for (const cls of d.classes) lines.push(...renderClass(cls));
  lines.push(
    `coverage  tasks closed ${d.tasksClosed}, attributed ${d.tasksAttributed}; ` +
      `attempts ${d.coverage.attempts} (closed ${d.coverage.finished}, with cost ${d.coverage.withCost})`,
  );
  if (d.coverage.costStale > 0) {
    lines.push(
      `WARNING   ${d.coverage.costStale} of ${d.coverage.withCost} attempts are frozen at a figure ` +
        "their own price row no longer gives (the price was corrected after freezing): " +
        "recompute — bun run scripts/recost-attempts.ts --apply",
    );
  }
  if (d.coverage.costCacheUnpriced > 0) {
    // Занижение неравномерное: сильнее у той руки, что больше читала и
    // меньше писала. Такой отчёт способен переставить модели местами.
    lines.push(
      `WARNING   ${d.coverage.costCacheUnpriced} of ${d.coverage.withCost} attempts were costed ` +
        "at a ZERO cache price despite nonzero cache tokens: the cost is understated, and " +
        "unevenly. Set the rates: myc model update <id> --price-cache-read/--price-cache-write",
    );
  }
  lines.push(
    `formula   outcome v${d.outcomeVersion}, interval ${Math.round(d.credibleMass * 100)}%, ` +
      `observation threshold ${d.minAttempts}`,
  );
  return `${lines.join("\n")}\n`;
}

export function createReportCommand(deps: AttemptDeps = realAttemptDeps): Command {
  const models: Command = {
    name: "models",
    summary: "which model is cheaper at equal result, per task class",
    help:
      "'Equal result' means overlapping quality credible intervals, not equal " +
      "means. Cost is taken as frozen at the time of the attempt.",
    flags: [
      { name: "class", value: "string", description: "one task class, e.g. fix:module" },
      { name: "since", value: "string", description: "window, e.g. 30d" },
      { name: "min", value: "number", description: "min attempts per arm (default 3)" },
    ],
    handler: (ctx): CommandResult => {
      const taskClass = flagStr(ctx, "class");
      if (taskClass !== undefined && !isTaskClass(taskClass)) {
        return usage("usage.class", `--class must be intent:scope, got "${taskClass}"`);
      }
      const opened = deps.openSwarm(ctx, deps.probe.now);
      if (!("db" in opened)) return opened;
      try {
        let since: number | undefined;
        const sinceRaw = flagStr(ctx, "since");
        if (sinceRaw !== undefined) {
          const span = parseDuration(sinceRaw);
          if (span === undefined) {
            return usage("usage.invalid", `invalid --since "${sinceRaw}"; format: 30m, 2h, 1d`);
          }
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
