/**
 * `myc prime` — бутстрап контекста сессии (§3.2, myc-5t1). Отвечает «что мы
 * уже знаем про проект»: очередь ready, активная попытка, недавние
 * решения/заметки из памяти, состояние деградаций. Это НЕ `myc bootstrap`
 * («как здесь работать» — правила/инструменты/скилы, отдельная команда,
 * своего раздела здесь нет ни строки) и НЕ `myc route` (S12: роутинг вызывается
 * отдельно, prime печатает только то, что уже знает граф).
 *
 * БЮДЖЕТ p99 < 30 мс тёплым / < 60 мс холодным (docs/design/00-brief.md §3).
 * Внутри — ТОЛЬКО детерминированные запросы по существующим индексам:
 *
 *   - READY:       collectTop()/readyStats() из ready.ts — та же очередь,
 *                   без дублирования скоринга.
 *   - IN PROGRESS: nodes(status='in_progress') через ix_nodes_lease — тот
 *                   же индекс и тот же паттерн, что ready_stats_in_progress.
 *   - CORE/DECISIONS: один скан ix_nodes_prime (scope, layer>=2, salience
 *                   DESC) — L3 узлы это CORE, L2 узлы это DECISIONS (секции
 *                   названы по слою, design doc §3.2: "CORE L3" / "DECISIONS
 *                   L2" — не по attrs.type). Это ровно то, что ARCHITECTURE.md
 *                   называет "L3/L2 дайджест скоупа (предвычисленная
 *                   digest_cache, инвалидация по seq)" (S4) и что бенчит
 *                   scripts/bench-latency.ts (primeOp) — ни то, ни другое
 *                   не трогается здесь, только СЛОЙ CLI поверх той же схемы.
 *
 * Эмбеддер НЕ вызывается никогда: ни импорта @myc/embed, ни ретривала
 * (@myc/retrieval требует непустой текстовый запрос и в bm25-режиме уже не
 * трогает эмбеддер, но prime не зовёт его вовсе — семантический поиск здесь
 * не нужен, это детерминированный обход графа). `--focus` фильтрует уже
 * выбранные L2/L3 кандидаты подстрокой в JS, а не эмбеддингом или FTS.
 *
 * Кеш дайджеста (S4: "профиль='prime'") — НЕ отдельная таблица: та же
 * generic-таблица `meta` (Q.meta_get/meta_set) и та же инвалидация по
 * oplog.seq, что уже показывает readyStats() в ready.ts. Второго механизма
 * кеширования здесь нет — только L2/L3-скан кешируется (readyStats уже
 * кеширует ready/blocked/in_progress по своей собственной записи).
 *
 * ОХВАТ (S58). Дайджест L2/L3 фильтруется по охвату: проектное видно всегда,
 * сессионное — только в СВОЕЙ сессии, неопределённое видно и пересчитывается
 * числом в подвале (И2 — молча угадывать охват запрещено). Личность сессии
 * приходит `--session`, иначе из MYC_SESSION_ID/CLAUDE_SESSION_ID; без неё
 * сессионное не показывается вовсе, и подвал говорит об этом словом.
 * Кеш дайджеста ключуется сессией — иначе сессия A отдала бы свой дайджест
 * сессии B, и весь фильтр был бы обойдён одним попаданием в кеш.
 *
 * ОХВАТ РЕПОЗИТОРИЯ (S59) фильтрует ту же память, что и очередь READY: без
 * этого `--repo repoX` показывал бы заметки repoY в разделе памяти, пока
 * задачи уже отфильтрованы — ready и prime расходились бы на памяти при
 * согласии на задачах, а пользователю об этом никто не сказал бы (И2).
 * Фильтр — та же ось, что и охват сессии выше, независимая: узел может быть
 * общим по сессии и при этом принадлежать одному репозиторию. Скрытое чужим
 * репозиторием и не имеющее записанного охвата репозитория считается
 * отдельно от чужого сессионного — это разные числа, разные строки в
 * подвале, смешивать их значит вернуть ту же неточность, ради которой
 * заводился S59. Кеш дайджеста ключуется и репозиторием тоже — по той же
 * причине, что и сессией: иначе фильтр обходился бы попаданием в кеш.
 *
 * Личный ярус (S41) читается лениво, как в recall/retrieve: неудача не
 * валит команду, только WARN degraded.personal_tier.
 *
 * Бюджет символов — тот же принцип, что в bootstrap.ts: секции добавляются
 * по приоритету READY > IN PROGRESS > CORE > DECISIONS > NEXT (design doc
 * §3.2), хвост режется предсказуемо и объявляет об этом в подвале.
 */

import {
  digestScan,
  primeQueries,
  runSync,
  CORE_LIMIT,
  DECISIONS_LIMIT,
  type DigestItem,
  type DigestPayload,
  DIGEST_PROFILE_PRIME,
  defineQueries,
  digestCached,
  historyClause,
  reachClause,
  reachColumns,
  reachFromColumns,
  reachPredicate,
  repoClause,
  toPgDialect,
  repoColumns,
  repoFromColumns,
  repoPredicate,
  repoReasonText,
  resolveSession,
  unknownReachPredicate,
  unknownRepoPredicate,
  visibleInPrime,
  visibleInRepo,
  type ReachInfo,
} from "@myc/core";
import type { QueryDef } from "@myc/core";
import {
  anchorsAlivePredicate,
  anchorsAllLostSql,
  awaitingReviewPredicate,
  liveStatusPredicate,
  lostAnchorOwnersSql,
  notPendingClause,
} from "@myc/retrieval";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../exit.ts";
import { remoteRun } from "../remote.ts";
import { CLI_VERSION } from "../index.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import type { FlagSpec } from "../flags.ts";
import { collectTop, readyStats, type ReadyItem } from "./ready.ts";
import { markHookCall } from "../hooks/counters.ts";
import {
  flagNum,
  flagStr,
  fmtEstimate,
  fmtLease,
  fmtPriority,
  personalWorkspaceStatus,
  personalHome,
  openPersonalStore,
  realStoreDeps,
  repoTarget,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

export const DEFAULT_BUDGET = 2000;
export const MIN_BUDGET = 200;
const FOOTER_MAX = 90;
/**
 * Место под строку охвата (S58, S59) в подвале. Она НЕ режется вместе с
 * остальным подвалом: «чужого скрыто 7» — это и есть громкость И2, и
 * обрезать её значит вернуть молчаливую фильтрацию. Поэтому под неё
 * резервируется место, а не остаток. Типичный потолок: «session abcdefgh ·
 * 99999 from other sessions hidden · 99999 without reach · 99999 pending
 * review hidden — myc review · repo collector · 99999 from other repos hidden
 * · 99999 without repo reach» — 192 символа (без подсказки `myc review` было
 * 179 при резерве 190; резерв поднят до 195, чтобы потолок с подсказкой и
 * разделителем « · » по-прежнему в него укладывался). Число знания с
 * потерянным кодом (§7.3) — « · 99999 with code gone hidden», ещё 30: потолок
 * 222, резерв 225. Длинное
 * объяснение "путь вне воркспейса: <path>" (repoReasonText) в этот потолок не
 * закладывается — тот же необрезаемый принцип, что и у самой строки охвата.
 */
const REACH_FOOTER_MAX = 225;
/**
 * Команда разбора кандидатов в подвале рядом с их числом — одна короткая
 * строка в уже зарезервированном месте {@link REACH_FOOTER_MAX}, а не новая
 * секция: секции режутся бюджетом, а число скрытого и путь к нему — нет.
 */
const REVIEW_HINT = "myc review";
/** Сколько символов ключа сессии печатать: он бывает и uuid, и путём. */
const SESSION_SHORT = 8;

const ROLES = ["agent", "leader", "human"] as const;
type Role = (typeof ROLES)[number];

// ---------------------------------------------------------------------------
// Запросы
// ---------------------------------------------------------------------------

/**
 * Запросы prime. Экспортированы ради теста бюджета (prime.reach-latency.test.ts):
 * мерить и объяснять план надо ТОТ ЖЕ текст, который исполняет команда, иначе
 * замер относится к своей копии SQL, а не к горячему пути.
 */
// Реестр дайджеста и сам скан живут в ядре (packages/core/src/prime-queries.ts):
// тот же контекст собирает сервер (GET /v1/ws/:ws/prime), а второй его сборки
// быть не должно.
export { primeQueries };

/**
 * Локальный мост к скану: правило и запросы — в ядре, а синхронный прогон над
 * bun:sqlite и хендл воркспейса — дело команды.
 */
function scanDigest(
  h: StoreHandle,
  tier: "project" | "personal",
  focus: string | undefined,
  session: string,
  repo: string,
): DigestPayload {
  return runSync(digestScan(h.scope, tier, focus, session, repo), h.driver);
}

const QP = primeQueries;

// ---------------------------------------------------------------------------
// Модель дайджеста
// ---------------------------------------------------------------------------

/**
 * Вариант кеша дайджеста: чем `prime` в одном скоупе законно РАЗЛИЧАЕТСЯ,
 * не различаясь базой.
 *
 * Сессия И РЕПОЗИТОРИЙ — ЧАСТЬ КЛЮЧА. Без сессии дайджест сессии A
 * отдавался бы сессии B при том же seq оплога; без репозитория `--repo
 * repoX` отдал бы дайджест, посчитанный для repoY. Оба случая — не промах
 * производительности, а обход фильтра охвата (S58/S59) попаданием в кеш.
 *
 * v6 — версия ФОРМЫ И ОТБОРА payload (v3 добавила поле `repo`, v4 — `pending`
 * и фильтр кандидатов, v5 — фильтр скрываемых статусов, v6 — `lost` и фильтр
 * знания с потерянным кодом): при смене формы версия обязана меняться, иначе
 * старая запись подсунет payload без нового поля; при смене отбора — тоже,
 * иначе дайджест, посчитанный ДО фильтра, отдавался бы из кеша, пока в базу
 * никто не пишет (отозванная заметка в CORE после обновления). Версия стоит в
 * варианте, а не в имени профиля: профиль — это стык S4 (`prime` и есть
 * `prime`), его нельзя двигать при каждой правке.
 *
 * Смена состояния якоря кеш инвалидирует сама: проверка якорей пишет новое
 * состояние и в `anchors`, и статусом узла-якоря через GraphStore — то есть в
 * оплог того же скоупа (applyCheck в anchor.ts), и seq дайджеста двигается.
 */
function digestVariant(session: string, repo: string): string {
  return `v6:${session}:${repo}`;
}

/**
 * Кеш дайджеста (S4): при пустом `--focus` результат стабилен на версию
 * базы — берём его из `digest_cache` по (scope, profile='prime', вариант) с
 * инвалидацией по `max(oplog.seq)`, одним statement и кросс-процессно
 * (@myc/core digest-cache.ts). С `--focus` кеш не имеет смысла (запрос
 * каждый раз другой) — сканируем напрямую.
 */
function digestForPrime(
  h: StoreHandle,
  focus: string | undefined,
  session: string,
  repo: string,
): { payload: DigestPayload; cache: "hit" | "miss" } {
  if (focus !== undefined && focus.trim().length > 0) {
    return { payload: scanDigest(h, "project", focus, session, repo), cache: "miss" };
  }
  const got = digestCached<DigestPayload>(
    h.driver,
    {
      scope: h.scope,
      profile: DIGEST_PROFILE_PRIME,
      variant: digestVariant(session, repo),
    },
    () => scanDigest(h, "project", undefined, session, repo),
  );
  return { payload: got.payload, cache: got.cache };
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export interface PrimeReadyRow {
  readonly id: string;
  readonly priority: number;
  readonly type: string;
  readonly title: string;
  readonly unblocks: number;
  readonly estimate_min?: number;
}

export interface PrimeInProgressRow {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly assignee: string;
  /** Держатель аренды; пусто — аренды нет (так ввозятся in_progress из beads). */
  readonly lease_holder: string;
  /** Срок аренды, мс; 0 — аренды нет. Число, как в хранилище: текст — fmtLease. */
  readonly lease_expires: number;
}

export interface PrimeData {
  readonly ws: string;
  readonly node_count: number;
  readonly idx_ok: boolean;
  readonly now: number;
  readonly empty: boolean;
  /**
   * Рядом лежит `.beads/` — есть что импортировать. Считается ТОЛЬКО для
   * пустого воркспейса: совет про импорт печатается лишь новичку, а один
   * `existsSync` в этой ветке горячему пути (бюджет prime 30 мс) не мешает.
   */
  readonly beads: boolean;
  readonly role: Role;
  readonly ready_total: number;
  readonly ready: readonly PrimeReadyRow[];
  readonly blocked: number;
  readonly in_progress_total: number;
  readonly in_progress: readonly PrimeInProgressRow[];
  readonly core: readonly DigestItem[];
  readonly decisions: readonly DigestItem[];
  /** Ключ текущей сессии; пусто — сессия неизвестна (S58, И2). */
  readonly session: string;
  /** Сколько L2/L3 отсеяно как чужое сессионное. */
  readonly reach_hidden: number;
  /** Сколько L2/L3 без записанного охвата. */
  readonly reach_unknown: number;
  /** Целевой репозиторий очереди READY (S59); пусто — фильтра нет. */
  readonly repo: string;
  /** `true` — охват вывести не удалось, фильтра нет и об этом надо сказать. */
  readonly repo_undetermined: boolean;
  /** Почему не удалось. Пусто — удалось. */
  readonly repo_reason: string;
  /** Готовых задач без записанного охвата репозитория. */
  readonly repo_unknown: number;
  /** Готовых задач, скрытых фильтром как чужой репозиторий. */
  readonly repo_foreign: number;
  /**
   * L2/L3 памяти без записанного охвата репозитория. ОТДЕЛЬНОЕ число от
   * {@link repo_unknown} (S59): та же ось, но задачи и память считаются и
   * печатаются раздельно, иначе подвал вернулся бы к смешению, ради
   * устранения которого фильтр памяти и заводился.
   */
  readonly mem_repo_unknown: number;
  /** L2/L3 памяти, скрытых фильтром как чужой репозиторий. */
  readonly mem_repo_foreign: number;
  /**
   * Кандидаты хука сжатия (`attrs.state = 'pending_review'`, §6.2), которые
   * прошли бы охват, но скрыты как неподтверждённые. Отклонённые
   * (`retracted`) не считаются: их разбор уже закончен.
   */
  readonly pending_review: number;
  /**
   * Знание L2/L3, у которого ВСЕ якоря `lost` (§7.3: «код удалён или
   * переписан» — вес × 0.2 в поиске, в prime не попадает), прошедшее бы охват,
   * фильтр кандидатов и статусов. Узел без якорей и с хоть одним живым якорем
   * видно как прежде.
   */
  readonly anchor_lost_hidden: number;
  readonly degraded: readonly string[];
  readonly focus?: string;
  readonly format: "agent" | "md" | "json";
  readonly budget: number;
  readonly chars: number;
  readonly truncated: boolean;
  readonly cut: readonly string[];
  readonly cache: "hit" | "miss";
  readonly took_ms: number;
}

function toReadyRow(it: ReadyItem): PrimeReadyRow {
  return {
    id: it.id,
    priority: it.priority,
    type: it.type,
    title: it.title,
    unblocks: it.unblocks,
    ...(it.estimate_min !== undefined ? { estimate_min: it.estimate_min } : {}),
  };
}

const READY_LIMIT = 3;
const INPROGRESS_LIMIT = 3;

function collectInProgress(h: StoreHandle): { total: number; items: PrimeInProgressRow[] } {
  const rows = h.driver.all<{
    id: string;
    title: string;
    priority: number;
    assignee: string;
    lease_holder: string;
    lease_expires: number;
  }>(QP.prime_inprogress, [h.scope, INPROGRESS_LIMIT]);
  const total =
    rows.length < INPROGRESS_LIMIT
      ? rows.length
      : (h.driver.one<{ n: number }>(QP.prime_inprogress_count, [h.scope])?.n ?? rows.length);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      assignee: r.assignee,
      lease_holder: r.lease_holder,
      lease_expires: r.lease_expires,
    })),
  };
}

export interface PrimeDeps extends StoreDeps {
  openPersonal(ctx: CommandContext): ReturnType<typeof openPersonalStore>;
}

export const realPrimeDeps: PrimeDeps = {
  openStore: realStoreDeps.openStore,
  openPersonal: (ctx) => openPersonalStore(ctx),
};

function parseRole(raw: string | undefined): Role | undefined {
  if (raw === undefined) return "agent";
  return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : undefined;
}

function parseFormat(raw: string | undefined): "agent" | "md" | "json" | undefined {
  if (raw === undefined) return "agent";
  return raw === "agent" || raw === "md" || raw === "json" ? raw : undefined;
}

const PRIME_FLAGS: readonly FlagSpec[] = [
  { name: "budget", value: "number", description: `output character budget (default ${DEFAULT_BUDGET})` },
  { name: "role", value: "string", description: "agent|leader|human (default agent)" },
  { name: "focus", value: "string", description: "filter L2/L3 digest by a substring topic" },
  { name: "format", value: "string", description: "agent|md|json (default agent)" },
  {
    name: "session",
    value: "string",
    description: "session identity for memory reach (default $MYC_SESSION_ID/$CLAUDE_SESSION_ID)",
  },
  {
    name: "repo",
    value: "string",
    description: "repository scope (S59): a repo name, or `all` to drop the filter",
  },
];

export function createPrimeCommand(deps: PrimeDeps = realPrimeDeps): Command {
  return {
    name: "prime",
    remote: true,
    summary: "session bootstrap: what we already know about the project",
    flags: PRIME_FLAGS,
    help:
      "READY > IN PROGRESS > CORE > DECISIONS > NEXT, in that priority order — the tail is cut " +
      "first and predictably when --budget is too small. Never calls the embedder; --focus filters " +
      "the L2/L3 digest by substring, not by semantic search. Model routing (S12) is called " +
      "separately and ships with M5 — it is not part of this build; `myc bootstrap` is a separate " +
      "command. Neither is duplicated here.",
    handler: async (ctx) => {
      const t0 = performance.now();

      const budgetRaw = flagNum(ctx, "budget") ?? DEFAULT_BUDGET;
      if (!Number.isFinite(budgetRaw) || budgetRaw < MIN_BUDGET) {
        return failure(
          "usage.invalid",
          `--budget too small (${budgetRaw}); minimum ${MIN_BUDGET}`,
          ExitCode.USAGE,
        );
      }
      const budget = Math.floor(budgetRaw);

      const role = parseRole(flagStr(ctx, "role"));
      if (role === undefined) {
        return failure("usage.invalid", `invalid --role; allowed: ${ROLES.join("|")}`, ExitCode.USAGE);
      }
      const format = parseFormat(flagStr(ctx, "format"));
      if (format === undefined) {
        return failure("usage.invalid", "invalid --format; allowed: agent|md|json", ExitCode.USAGE);
      }
      const focus = flagStr(ctx, "focus");
      // S58: чья это сессия. Пусто — сессия неизвестна, и тогда сессионное
      // знание в контекст не попадает вовсе; подвал говорит об этом словом,
      // а не молчит (И2).
      const session = resolveSession(flagStr(ctx, "session"));

      // Сервер команды: контекст собирает он — тем же сканом и теми же
      // правилами отбора. Отдаёт ДАННЫЕ, а секции и бюджет остаются здесь:
      // ширина терминала у каждого своя.
      const remote = await remoteRun(ctx, async (client) => {
        if (focus !== undefined && focus.trim() !== "") {
          return failure(
            "precond.no_remote",
            "--focus is not answered by the server yet",
            ExitCode.PRECOND,
          );
        }
        const answer = await client.prime({ session, repo: flagStr(ctx, "repo") });
        const d = answer.data as {
          digest: { core: DigestItem[]; decisions: DigestItem[]; reach: { hidden: number; unknown: number }; pending: number; lost: number };
          ready: Array<{ id: string; priority: number; title: string; unblocks: number }>;
          in_progress: Array<{ id: string; title: string; assignee: string }>;
          total_ready: number;
          nodes: number;
        };
        return {
          ok: true,
          data: {
            core: d.digest.core,
            decisions: d.digest.decisions,
            ready: d.ready,
            in_progress: d.in_progress,
            total_ready: d.total_ready,
            nodes: d.nodes,
            reach: d.digest.reach,
            pending: d.digest.pending,
            lost: d.digest.lost,
          },
          meta: { ...answer.meta, remote: client.ws, budget },
        };
      });
      if (remote !== undefined) return remote;

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const now = Date.now();
        const nodeCount = h.driver.one<{ n: number }>(QP.prime_node_count, [h.scope])?.n ?? 0;
        const empty = nodeCount === 0;
        // Проверяем, а не советуем «(если есть)»: условие, которое человек
        // должен проверить сам, — это не подсказка, а перекладывание работы.
        const beads = empty && existsSync(join(h.wsDir, ".beads"));

        // Тот же охват репозитория (S59), что и `ready`: своё плюс общее,
        // скрытое названо числом в подвале. Разошедшиеся умолчания двух
        // поверхностей читались бы как потеря данных в одной из них.
        const repo = repoTarget(h, flagStr(ctx, "repo"));
        const stats = readyStats(h, repo);
        const { blocked, inProgress } = stats;
        const readyCollected = empty ? { items: [], total: 0 } : collectTop(h, READY_LIMIT, now, repo);
        const inProgressCollected = empty ? { total: 0, items: [] } : collectInProgress(h);

        const digested = empty
          ? {
              payload: {
                core: [],
                decisions: [],
                reach: { hidden: 0, unknown: 0 },
                repo: { hidden: 0, unknown: 0 },
                pending: 0,
                lost: 0,
              },
              cache: "miss" as const,
            }
          : digestForPrime(h, focus, session, repo);

        const degraded: string[] = [];
        let core = digested.payload.core;
        let decisions = digested.payload.decisions;
        let reachHidden = digested.payload.reach.hidden;
        let reachUnknown = digested.payload.reach.unknown;
        let memRepoHidden = digested.payload.repo.hidden;
        let memRepoUnknown = digested.payload.repo.unknown;
        let pendingReview = digested.payload.pending;
        let anchorLost = digested.payload.lost;

        if (!empty) {
          try {
            const openedPersonal = await deps.openPersonal(ctx);
            if (!openedPersonal.ok) {
              ctx.warn("degraded.personal_tier", `personal tier failed to open: ${openedPersonal.failure.msg}`);
              degraded.push(`personal_tier: ${openedPersonal.failure.msg}`);
            } else if (openedPersonal.handle !== undefined) {
              const personal = openedPersonal.handle;
              try {
                const personalDigest = scanDigest(personal, "personal", focus, session, repo);
                core = [...core, ...personalDigest.core].slice(0, CORE_LIMIT);
                decisions = [...decisions, ...personalDigest.decisions].slice(0, DECISIONS_LIMIT);
                reachHidden += personalDigest.reach.hidden;
                reachUnknown += personalDigest.reach.unknown;
                memRepoHidden += personalDigest.repo.hidden;
                memRepoUnknown += personalDigest.repo.unknown;
                pendingReview += personalDigest.pending;
                anchorLost += personalDigest.lost;
              } finally {
                personal.close();
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.warn("degraded.personal_tier", `personal tier failed to open: ${msg}`);
            degraded.push(`personal_tier: ${msg}`);
          }
        }

        const tookMs = Math.round(performance.now() - t0);
        const dataNoBudget: Omit<PrimeData, "chars" | "truncated" | "cut"> = {
          ws: h.slug,
          node_count: nodeCount,
          idx_ok: true,
          now,
          empty,
          beads,
          role,
          ready_total: readyCollected.total,
          ready: readyCollected.items.map(toReadyRow),
          blocked,
          in_progress_total: inProgressCollected.total,
          in_progress: inProgressCollected.items,
          core,
          decisions,
          session,
          reach_hidden: reachHidden,
          reach_unknown: reachUnknown,
          repo,
          repo_undetermined: h.repo.repo === undefined,
          repo_reason: repoReasonText(h.repo),
          repo_unknown: stats.repoUnknown,
          repo_foreign: stats.repoForeign,
          mem_repo_unknown: memRepoUnknown,
          mem_repo_foreign: memRepoHidden,
          pending_review: pendingReview,
          anchor_lost_hidden: anchorLost,
          degraded,
          ...(focus !== undefined ? { focus } : {}),
          format,
          budget,
          cache: digested.cache,
          took_ms: tookMs,
        };

        // Отметка вызова: до сих пор себя записывал только pre-compact, а он
        // срабатывает лишь при сжатии контекста — то есть через часы после
        // установки. Проверить «подхватил ли харнесс myc» сразу было нечем,
        // и это первый вопрос всякого, кто поставил инструмент. `prime` — то,
        // что зовёт хук старта сессии, поэтому отметка ставится здесь.
        //
        // Отмечается ТОЛЬКО вызов из хука: `markHookCall` требует, чтобы
        // вызывающий объявил себя через MYC_HOOK, и helper это делает, а
        // человек в терминале — нет. Иначе счётчик `session-start` тикал бы и
        // от ручного `myc prime`, то есть означал бы «кто-нибудь запускал
        // prime» — метку, означающую не то, что на ней написано, а это ХУЖЕ
        // отсутствия метки (memory-q9k2zxfx2mcm).
        //
        // Статус: `no-session` — хост не назвал сессию. Это не мелочь, а ровно
        // та поломка, из-за которой сессионная память была скрыта в живом
        // потоке (memory-h12hjebzr0he): установленный helper не передавал
        // `--session`. Отметка называет её вслух, а не выдаёт за здоровье.
        markHookCall(h.mycDir, "session-start", tookMs, session.length > 0 ? "ok" : "no-session");

        const rendered = renderAgent(dataNoBudget, budget);
        const data: PrimeData = { ...dataNoBudget, chars: rendered.chars, truncated: rendered.truncated, cut: rendered.cut };

        return {
          ok: true,
          data,
          meta: {
            took_ms: tookMs,
            cache: digested.cache,
            session: session.length > 0 ? session : null,
            reach_hidden: reachHidden,
            reach_unknown: reachUnknown,
            repo: repo.length > 0 ? repo : null,
            repo_unknown: stats.repoUnknown,
            repo_foreign: stats.repoForeign,
            mem_repo_unknown: memRepoUnknown,
            mem_repo_foreign: memRepoHidden,
            pending_review: pendingReview,
            anchor_lost_hidden: anchorLost,
            degraded: degraded.length > 0 ? degraded : undefined,
          },
        };
      } finally {
        h.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as PrimeData;
      if (d.format === "json") return `${JSON.stringify(raw, null, 2)}\n`;
      return renderAgent(d, d.budget).text;
    },
  };
}

// ---------------------------------------------------------------------------
// Рендер с бюджетом символов
// ---------------------------------------------------------------------------

interface Section {
  readonly key: string;
  readonly text: string;
}

const MIN_CLIP = 40;

/**
 * Пометки строки дайджеста. Проектный охват не помечается — в `prime` он
 * норма; помечается всё, что нормой не является: своя сессия и неопределённый
 * охват. Ярус (S41) — другая ось и своя пометка, они не смешиваются.
 */
function marks(it: DigestItem): string {
  const out: string[] = [];
  if (it.tier === "personal") out.push("@personal");
  if (it.reach === "session") out.push("@session");
  else if (it.reach === "unknown") out.push("@no-reach");
  return out.length > 0 ? ` [${out.join(" ")}]` : "";
}

function bullet(items: readonly DigestItem[]): string[] {
  return items.map((it) => `- ${it.title}${marks(it)}`);
}

function decisionLine(it: DigestItem): string {
  const date = new Date(it.updated_at).toISOString().slice(0, 10);
  return `${date} ${it.id}  ${it.title}${marks(it)}`;
}

/**
 * Строка охвата для подвала (И2). Печатается ВСЕГДА: «сессия не указана»
 * — такая же новость, как «чужого скрыто 7», потому что без сессии из
 * контекста выпадает всё сессионное сразу.
 */
function reachFooter(d: Omit<PrimeData, "chars" | "truncated" | "cut">): string {
  const parts = [
    d.session.length > 0
      ? `session ${d.session.slice(0, SESSION_SHORT)}`
      : "session not specified",
  ];
  if (d.reach_hidden > 0) parts.push(`${d.reach_hidden} from other sessions hidden`);
  if (d.reach_unknown > 0) parts.push(`${d.reach_unknown} without reach`);
  // Кандидаты хука сжатия (§6.2) скрыты как неподтверждённые — это та же
  // громкость И2, что у охвата: фильтр, не названный числом, неотличим от
  // пустой памяти. Рядом — команда разбора: число без пути к действию
  // оставляло кандидатов копиться (в базе этого репозитория их было 24).
  if (d.pending_review > 0) parts.push(`${d.pending_review} pending review hidden — ${REVIEW_HINT}`);
  // Знание, чей код удалён или переписан (все якоря `lost`, §7.3), — та же
  // громкость: его нет в CORE/DECISIONS, но оно не стёрто, recall его находит
  // с пометкой `code gone`, и число здесь говорит, что искать есть что.
  if (d.anchor_lost_hidden > 0) parts.push(`${d.anchor_lost_hidden} with code gone hidden`);
  parts.push(...repoFooterParts(d));
  return parts.join(" · ");
}

/**
 * Хвост про охват репозитория (S59, И2) — тот же принцип, что `repoFooter`
 * в ready.ts: READY и `prime` обязаны показывать согласованную картину, а не
 * изобретать второй способ назвать одно и то же число.
 *
 * Задачи и память считаются и печатаются РАЗДЕЛЬНО (`repo_*` против
 * `mem_repo_*`): фильтр одинаковый, но числа про разные разделы выдачи, и
 * слить их в одно значило бы вернуть ту самую путаницу «сошлись на задачах,
 * разошлись на памяти», ради устранения которой заводился этот фильтр.
 */
function repoFooterParts(d: Omit<PrimeData, "chars" | "truncated" | "cut">): string[] {
  const out: string[] = [];
  if (d.repo.length > 0) out.push(`repo ${d.repo}`);
  if (d.repo_undetermined) out.push(`repo reach undetermined: ${d.repo_reason}`);
  if (d.repo_foreign > 0) out.push(`${d.repo_foreign} from other repos hidden`);
  if (d.repo_unknown > 0) out.push(`${d.repo_unknown} without repo reach`);
  if (d.mem_repo_foreign > 0) {
    out.push(`${d.mem_repo_foreign} ${d.mem_repo_foreign === 1 ? "note" : "notes"} from other repos hidden`);
  }
  if (d.mem_repo_unknown > 0) {
    out.push(`${d.mem_repo_unknown} ${d.mem_repo_unknown === 1 ? "note" : "notes"} without repo reach`);
  }
  return out;
}

function buildSections(d: Omit<PrimeData, "chars" | "truncated" | "cut">, md: boolean): Section[] {
  const h1 = md ? "## " : "# ";
  const sections: Section[] = [];

  if (d.empty) {
    sections.push({ key: "empty", text: "Workspace is empty. Nothing is remembered about this project yet." });
    sections.push({
      key: "next",
      text: [
        `${h1}NEXT`,
        ...(d.beads ? ["myc import --from beads       .beads/ is right here — its tasks can be imported"] : []),
        'myc create "<first task>" -p P1',
        'myc remember "<what matters about this project>"',
      ].join("\n"),
    });
    return sections;
  }

  const readyLines = d.ready.map((it) => {
    const est = it.estimate_min !== undefined ? `  ${fmtEstimate(it.estimate_min)}` : "";
    return `${it.id}  ${fmtPriority(it.priority)} ${it.type}  ${it.title}  unblocks ${it.unblocks}${est}`;
  });
  sections.push({
    key: "ready",
    text: [`${h1}READY ${d.ready.length} of ${d.ready_total}`, ...readyLines].join("\n"),
  });

  if (d.in_progress.length > 0) {
    // «free» здесь читалось бы как «аренда свободна», а задача в работе: у
    // неё просто нет исполнителя. Срок аренды — fmtLease (три случая).
    const lines = d.in_progress.map((it) => {
      const who = it.assignee.length > 0 ? `@${it.assignee}` : "unassigned";
      return `${it.id}  ${fmtPriority(it.priority)}  ${it.title}  ${who}  ${fmtLease(it.lease_holder, it.lease_expires, d.now)}`;
    });
    sections.push({
      key: "in_progress",
      text: [
        `${h1}IN PROGRESS ${d.in_progress_total > d.in_progress.length ? `${d.in_progress.length} of ${d.in_progress_total}` : d.in_progress_total}`,
        ...lines,
      ].join("\n"),
    });
  }

  if (d.core.length > 0) {
    sections.push({ key: "core", text: [`${h1}CORE L3 ${d.core.length}`, ...bullet(d.core)].join("\n") });
  }
  if (d.decisions.length > 0) {
    sections.push({
      key: "decisions",
      text: [`${h1}DECISIONS L2 ${d.decisions.length}`, ...d.decisions.map(decisionLine)].join("\n"),
    });
  }

  const nextLines = [
    `${h1}NEXT`,
    "myc ready --claim        claim the top task atomically",
  ];
  if (d.role === "human") nextLines.push("myc --help                list commands");
  else {
    nextLines.push('myc recall "<topic>"     facts and decisions on the topic');
    nextLines.push('myc remember "<fact>"    record a conclusion');
  }
  sections.push({ key: "next", text: nextLines.join("\n") });

  return sections;
}

/**
 * Заполнение по приоритету READY > IN PROGRESS > CORE > DECISIONS > NEXT
 * (design doc §3.2): секции идут фиксированным порядком, режется ХВОСТ.
 * Первая не влезшая целиком секция обрезается по символам, если остаётся
 * хоть {@link MIN_CLIP}; всё, что после — выбрасывается целиком. Тот же
 * принцип, что bootstrap.ts:fillBody, но единица — целая секция, а не
 * блок-с-тегом: у prime секции семантически разные (READY это НЕ то же,
 * что CORE), в отличие от однородных bootstrap-блоков.
 */
function fillSections(sections: readonly Section[], limit: number): { body: string; cut: string[] } {
  const parts: string[] = [];
  let used = 0;
  const cut: string[] = [];
  let cutting = false;
  for (const s of sections) {
    if (cutting) {
      cut.push(s.key);
      continue;
    }
    const sep = parts.length > 0 ? 2 : 0; // "\n\n" между секциями
    if (used + sep + s.text.length <= limit) {
      parts.push(s.text);
      used += sep + s.text.length;
      continue;
    }
    const space = limit - used - sep - 1;
    if (space >= MIN_CLIP) {
      parts.push(`${s.text.slice(0, space)}…`);
      used = limit;
    } else {
      cut.push(s.key);
    }
    cutting = true;
  }
  return { body: parts.join("\n\n"), cut };
}

function header(d: Omit<PrimeData, "chars" | "truncated" | "cut">): string {
  const idx = d.idx_ok ? "idx ok" : "idx stale";
  return `myc ${CLI_VERSION} · ws=${d.ws} sqlite · ${d.node_count} ${d.node_count === 1 ? "node" : "nodes"} · ${idx} · ${new Date(d.now).toISOString()}`;
}

function renderAgent(
  d: Omit<PrimeData, "chars" | "truncated" | "cut">,
  budget: number,
): { text: string; chars: number; truncated: boolean; cut: string[] } {
  const head = header(d);
  const sections = buildSections(d, d.format === "md");
  const room = Math.max(0, budget - FOOTER_MAX - REACH_FOOTER_MAX - head.length - 4);
  const { body, cut } = fillSections(sections, room);
  const truncated = cut.length > 0;
  const parts = [head, body].filter((p) => p.length > 0);
  let footer = `${parts.join("\n\n").length} chars · ${d.took_ms} ms · cache ${d.cache}`;
  if (truncated) footer += ` · cut ${cut.join(",")}`;
  if (footer.length > FOOTER_MAX) footer = footer.slice(0, FOOTER_MAX);
  // Строка охвата дописывается ПОСЛЕ обрезки подвала: она про то, чего в
  // выдаче нет, и молчаливо потерять её — то же, что молчаливо фильтровать.
  footer += ` · ${reachFooter(d)}`;
  const text = `${parts.join("\n\n")}\n\n${footer}\n`;
  return { text, chars: text.length, truncated, cut };
}
