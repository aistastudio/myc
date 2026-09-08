/**
 * Кто и чем выполняет попытку: контекст запуска и состояние процесса
 * (memory-v3f81y9vfrq0).
 *
 * ТРИ ФАКТА, ПРОВЕРЕННЫЕ 2026-09-07, из которых всё здесь следует.
 *
 * 1. ОРКЕСТРАТОР НЕ ОТДАЁТ НИ РАСХОДА, НИ PID. Замер на orca 1.4.197,
 *    2026-09-07: `worker-show --json` — 91 различный ключ вместе с
 *    конвертом, `worker-list --json` — 31, `terminal show` — 25,
 *    `dispatch-show` — 24. Слов token/cost/usage среди них нет: два
 *    совпадения на все шесть команд, и оба — `launch_token_hash`, хеш
 *    поручения. Строк с pid — ноль. Pid есть ровно в одном месте,
 *    `orca diagnostics memory --json` (27 сессий, у каждой pid+cpu+
 *    memory), и это pid ВЕДУЩЕГО процесса псевдотерминала, а не агента:
 *    проверено на своём процессе, 81259 (login) → 81260 (zsh) → 81610
 *    (claude). То есть даже там pid не тот, который интересен.
 * 2. ЗАТО ПРОЦЕСС ЗНАЕТ О СЕБЕ ВСЁ САМ. В окружении агентского процесса
 *    уже лежат `CLAUDE_CODE_SESSION_ID` (тот самый uuid стенограммы),
 *    `CLAUDE_PID` (pid самого агента), `ORCA_TERMINAL_HANDLE`,
 *    `ORCA_PANE_KEY`. Ничего искать не надо — надо записать.
 * 3. ЗАПИСЬ ДОЛЖНА ЗАМЕНИТЬ ПОИСК, А НЕ ДОПОЛНИТЬ ЕГО. До этой задачи
 *    связь «попытка → сессия» выводилась перебором стенограмм по строке
 *    брифа `Задача myc: <id>`. Это не отказоустойчиво: бриф пишет
 *    человек, и стоит написать иначе — связь молча теряется (так и вышло
 *    для двух агентов). Поэтому источник связи хранится рядом с ней:
 *    'env' и 'flag' — записано, 'search' — угадано.
 *
 * ГРАНИЦА ОТВЕТСТВЕННОСТИ. Здесь нет и не будет ни одного kill: myc ведёт
 * запись, снимает процессы тот, кто их запускал. Всё, что делает этот
 * модуль с живым процессом, — задаёт ядру вопрос «жив ли pid» (сигнал 0)
 * и классифицирует ответ. Даже проба вынесена наружу параметром, чтобы
 * классификация оставалась чистой функцией и проверялась без процессов.
 */

/** Откуда известна связь попытки с сессией. */
export const LINK_SOURCES = ["env", "flag", "search", "none"] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

/** Откуда известен диспетчер. `lookup` — спросили оркестратор по терминалу. */
export const DISPATCH_SOURCES = ["env", "flag", "lookup", "none"] as const;
export type DispatchSource = (typeof DISPATCH_SOURCES)[number];

export const PID_SOURCES = ["env", "flag", "none"] as const;
export type PidSource = (typeof PID_SOURCES)[number];

/** Наблюдаемое состояние процесса. Правится только в сторону exited. */
export const PROC_STATES = ["running", "exited", "unknown"] as const;
export type ProcState = (typeof PROC_STATES)[number];

export interface LaunchContext {
  readonly sessionId: string | null;
  readonly sessionSource: LinkSource;
  readonly agentPid: number | null;
  readonly pidSource: PidSource;
  readonly terminal: string | null;
  readonly paneKey: string | null;
  readonly dispatchId: string | null;
  readonly dispatchSource: DispatchSource;
  readonly runId: string | null;
  readonly harnessBuild: string | null;
}

export const EMPTY_LAUNCH: LaunchContext = {
  sessionId: null,
  sessionSource: "none",
  agentPid: null,
  pidSource: "none",
  terminal: null,
  paneKey: null,
  dispatchId: null,
  dispatchSource: "none",
  runId: null,
  harnessBuild: null,
};

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Переменные, из которых берётся uuid сессии, в порядке доверия.
 * `MYC_SESSION_ID` первым СОЗНАТЕЛЬНО: харнессов трое, а автоопределение
 * сегодня есть только у Claude Code — остальным нужен ручной путь,
 * который не выглядит костылём. Догадок по именам чужих переменных
 * («наверное, у kimi есть KIMI_SESSION_ID») здесь нет: не проверено —
 * не записано.
 */
const SESSION_ENV = ["MYC_SESSION_ID", "CLAUDE_CODE_SESSION_ID"] as const;
const PID_ENV = ["MYC_AGENT_PID", "CLAUDE_PID"] as const;
const TERMINAL_ENV = ["ORCA_TERMINAL_HANDLE"] as const;
const PANE_ENV = ["ORCA_PANE_KEY"] as const;
/**
 * Диспетчера в окружении сегодня НЕТ ни у одного харнесса — проверено
 * полным `env` внутри запущенного агента. Переменная оставлена как
 * договор: если оркестратор начнёт её выставлять, работать станет само.
 */
const DISPATCH_ENV = ["MYC_DISPATCH_ID", "ORCA_DISPATCH_ID"] as const;
const RUN_ENV = ["MYC_RUN_ID", "ORCA_RUN_ID"] as const;
const BUILD_ENV = ["AI_AGENT"] as const;

function pick(env: Env, names: readonly string[]): string | null {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== "") return raw.trim();
  }
  return null;
}

/**
 * Pid из окружения. Мусор — это `null`, а НЕ ноль и не NaN: строка
 * запуска с agent_pid=0 читалась бы как «процесс есть», и `--live`
 * спрашивал бы ядро про pid 0 (у kill(0,0) особый смысл — вся группа
 * процессов), то есть врал бы уверенно.
 */
export function parsePid(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Контекст запуска из окружения процесса. Чистая функция над словарём:
 * проверяется без агента, без оркестратора и без процессов.
 */
export function launchContext(env: Env): LaunchContext {
  const sessionId = pick(env, SESSION_ENV);
  const agentPid = parsePid(pick(env, PID_ENV));
  const dispatchId = pick(env, DISPATCH_ENV);
  return {
    sessionId,
    sessionSource: sessionId === null ? "none" : "env",
    agentPid,
    pidSource: agentPid === null ? "none" : "env",
    terminal: pick(env, TERMINAL_ENV),
    paneKey: pick(env, PANE_ENV),
    dispatchId,
    dispatchSource: dispatchId === null ? "none" : "env",
    runId: pick(env, RUN_ENV),
    harnessBuild: pick(env, BUILD_ENV),
  };
}

/**
 * Наложить названное явно поверх взятого из окружения. Явное побеждает —
 * и вместе со значением меняется его источник: запись «сессия такая-то,
 * известна из flag» обязана отличаться от «из env», иначе через неделю
 * никто не скажет, чему в этой таблице можно верить.
 */
export function overrideLaunch(
  base: LaunchContext,
  over: {
    readonly sessionId?: string;
    readonly sessionSource?: LinkSource;
    readonly agentPid?: number;
    readonly dispatchId?: string;
    readonly dispatchSource?: DispatchSource;
    readonly runId?: string;
    readonly terminal?: string;
  },
): LaunchContext {
  return {
    ...base,
    ...(over.sessionId !== undefined
      ? { sessionId: over.sessionId, sessionSource: over.sessionSource ?? "flag" }
      : {}),
    ...(over.agentPid !== undefined
      ? { agentPid: over.agentPid, pidSource: "flag" as const }
      : {}),
    ...(over.dispatchId !== undefined
      ? { dispatchId: over.dispatchId, dispatchSource: over.dispatchSource ?? "flag" }
      : {}),
    ...(over.runId !== undefined ? { runId: over.runId } : {}),
    ...(over.terminal !== undefined ? { terminal: over.terminal } : {}),
  };
}

/** Есть ли в контексте хоть что-то, ради чего заводить строку запуска. */
export function isEmptyLaunch(c: LaunchContext): boolean {
  return (
    c.sessionId === null &&
    c.agentPid === null &&
    c.terminal === null &&
    c.paneKey === null &&
    c.dispatchId === null &&
    c.runId === null
  );
}

// ---------------------------------------------------------------------------
// Живое и завершённое
// ---------------------------------------------------------------------------

/**
 * Четыре состояния — это ПЕРЕСЕЧЕНИЕ двух независимых вопросов, а не одна
 * шкала: «кончилась ли работа» (finished_at попытки) и «жив ли процесс»
 * (сигнал 0 по записанному pid). Именно потому, что их считали одним
 * вопросом, три процесса и провисели почти семь часов после приёмки.
 */
export const LIVE_STATES = ["working", "orphan", "lost", "done", "unknown"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const LIVE_STATE_MEANING: Readonly<Record<LiveState, string>> = {
  /** Работа не закрыта, процесс жив — нормальный ход. */
  working: "работает",
  /** Работа закрыта, а процесс ЖИВ — то, что съедало память. */
  orphan: "завершено, но живо",
  /** Работа не закрыта, а процесса нет — упал или снят на полпути. */
  lost: "процесса нет, работа не закрыта",
  /** Работа закрыта, процесса нет — так и должно быть. */
  done: "завершено",
  /** Pid не записан: сказать нечего, и это видно. */
  unknown: "процесс неизвестен",
};

/**
 * Различение «настоящего сироты» от записи, которую координатор завёл
 * ВРУЧНУЮ постфактум (memory-kgnyph7x367v). У ручной записи `agentPid` и
 * `dispatchId` взяты из окружения того, кто набрал команду, а не из
 * агентского процесса — pid к попытке отношения не имеет.
 *
 * Два независимых признака, оба нужны:
 *   1. `dispatchSource === "none"` — оркестратор не подтвердил диспетчера.
 *      У настоящего агентского запуска он есть ("env"/"flag"/"lookup");
 *      пустой диспетчер на завершённой попытке — сильный признак ручной
 *      записи координатором.
 *   2. `agentPid === selfPid` — pid совпадает с pid ТОГО, КТО СЕЙЧАС
 *      спрашивает. Спрашивающий про себя и так знает, что он не сирота, и
 *      этот признак не ломается, даже если диспетчер оказался проставлен.
 *
 * Первый ломается, если оркестратор не проставил диспетчера настоящему
 * агенту; второй — если спрашивают из другого процесса. Нужны оба.
 */
export interface OrphanContext {
  readonly dispatchSource: DispatchSource;
  readonly agentPid: number | null;
  /** Pid процесса, который сейчас спрашивает — из его собственного окружения. */
  readonly selfPid: number | null;
}

/** true — процесс отвечает за самого себя, а не за чужого сироту. */
export function isSelfAttributed(ctx: OrphanContext): boolean {
  if (ctx.dispatchSource === "none") return true;
  if (ctx.selfPid !== null && ctx.agentPid === ctx.selfPid) return true;
  return false;
}

/**
 * Классификация запуска. `alive === null` значит «спросить было не о чем»
 * (pid не записан) — и тогда ответ `unknown`, а не `done`: молча выдать
 * закрытую попытку без pid за «всё в порядке» значит спрятать ровно те
 * строки, ради которых всё затевалось.
 *
 * `orphan` без `orphanCtx` — старое поведение (обратная совместимость
 * вызовов, которым различение не нужно или недоступно). С `orphanCtx`
 * самоприписанные записи (см. `isSelfAttributed`) классифицируются как
 * `done`: работа закрыта, а тревога о чужом висящем процессе не по адресу.
 */
export function liveStateOf(
  attempt: { readonly finishedAt: number | null },
  alive: boolean | null,
  orphanCtx?: OrphanContext,
): LiveState {
  if (alive === null) return "unknown";
  if (alive) {
    if (attempt.finishedAt === null) return "working";
    if (orphanCtx !== undefined && isSelfAttributed(orphanCtx)) return "done";
    return "orphan";
  }
  return attempt.finishedAt === null ? "lost" : "done";
}

/** Состояния, при которых процесс ЗАНИМАЕТ машину прямо сейчас. */
export function isAlive(state: LiveState): boolean {
  return state === "working" || state === "orphan";
}

/**
 * Проба «жив ли pid»: сигнал 0 не доставляется процессу, а только
 * проверяет право его послать. Это НЕ поход в ps: ищем не процесс по
 * приметам, а спрашиваем ядро про уже записанный номер.
 *
 * EPERM — «процесс есть, но чужой» — это ЖИВ. Свести его к «мёртв» значит
 * потерять ровно тот случай, ради которого всё писалось.
 */
export function pidAlive(pid: number | null): boolean | null {
  if (pid === null || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}
