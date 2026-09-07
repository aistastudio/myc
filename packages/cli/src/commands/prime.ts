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
  DIGEST_PROFILE_PRIME,
  defineQueries,
  digestCached,
  historyClause,
  reachClause,
  reachColumns,
  reachFromColumns,
  reachPredicate,
  repoClause,
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
import { ExitCode } from "../exit.ts";
import { CLI_VERSION } from "../index.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import type { FlagSpec } from "../flags.ts";
import { collectTop, readyStats, type ReadyItem } from "./ready.ts";
import {
  flagNum,
  flagStr,
  fmtAge,
  fmtClock,
  fmtEstimate,
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
 * резервируется место, а не остаток. Типичный потолок: «сессия abcdefgh ·
 * чужого скрыто 99999 · без охвата 99999 · repo collector · 99999 из других
 * репозиториев скрыто · 99999 без охвата репозитория». Длинное объяснение
 * "путь вне воркспейса: <path>" (repoReasonText) в этот потолок не
 * закладывается — тот же необрезаемый принцип, что и у самой строки охвата.
 */
const REACH_FOOTER_MAX = 160;
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
export const primeQueries = defineQueries({
  prime_node_count: {
    name: "prime_node_count",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_kind_upd
           WHERE scope = ?1 AND deleted_at IS NULL`,
    params: ["scope"],
  },
  // Один скан ix_nodes_prime: (scope, layer, salience DESC) WHERE layer>=2
  // AND head_id IS NULL AND deleted_at IS NULL — L2 и L3 в одном проходе,
  // без второго round-trip'а. INDEXED BY обязателен (см. комментарий
  // primeOp в scripts/bench-latency.ts): без него планировщик на графе,
  // где почти все узлы в одном scope, уходит в TEMP B-TREE.
  // ФИЛЬТР ОХВАТА СТОИТ В ИСТОЧНИКЕ, ДО LIMIT (S58). Отсеивать чужое
  // сессионное в JS после LIMIT нельзя: окно скана забивается чужим, и
  // проектное знание не доезжает до выдачи вовсе — это отказ, а не медленный
  // запрос. INDEXED BY переключён на ix_nodes_prime_reach (миграция 006): у
  // него тот же ключ и тот же частичный предикат, плюс три выражения
  // json_extract, которыми и живёт фильтр, — SQLite подаёт их из индекса, не
  // ходя в строку таблицы за каждой отсеиваемой (1.77 мс → 0.375 мс на 100k).
  // Охват репозитория (S59) фильтрует ТУ ЖЕ строку, что и охват сессии,
  // одним AND — та же строгость, что у READY: отсев в SQL, до LIMIT, иначе
  // окно скана забивается чужим репозиторием и своё знание не доезжает до
  // выдачи. `json_extract(attrs,'$.repo')` не incl в ix_nodes_prime_reach
  // (индекс несёт только три reach-выражения, S58) — предикат и сумма стоят
  // лишнего похода в строку таблицы. ПОЭТОМУ, как и `ready_top_*_repo` в
  // ready.ts, репозиторный терм — ОТДЕЛЬНАЯ пара запросов, включаемая только
  // когда фильтр реально задан (`repo.length > 0`): без фильтра дайджест не
  // платит за ось, о которой не просили (И1). При заданном фильтре цена —
  // те же лишние обращения к строке, что READY принял до индекса ix_nodes_
  // ready_repo (миграция 007); аналогичного индекса для памяти пока нет —
  // если `prime --repo` станет горячим путём на большом корпусе, это заявка
  // на такую же миграцию, а не тихая деградация здесь.
  prime_digest_scan: {
    name: "prime_digest_scan",
    sql: `SELECT nodes.id, nodes.layer, nodes.title, nodes.excerpt, nodes.updated_at,
                 ${reachColumns("nodes")}
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 3)}
           ORDER BY nodes.layer DESC, nodes.salience DESC LIMIT ?2`,
    params: ["scope", "lim", "session"],
  },
  prime_digest_scan_repo: {
    name: "prime_digest_scan_repo",
    sql: `SELECT nodes.id, nodes.layer, nodes.title, nodes.excerpt, nodes.updated_at,
                 ${reachColumns("nodes")}, ${repoColumns("nodes")}
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 3)}${repoClause("nodes", 4)}
           ORDER BY nodes.layer DESC, nodes.salience DESC LIMIT ?2`,
    params: ["scope", "lim", "session", "repo"],
  },
  // И2: скрытое и неопределённое обязано быть НАЗВАНО ЧИСЛОМ, иначе фильтр
  // неотличим от пустой памяти. Считается по тому же индексу и кешируется
  // вместе с дайджестом, то есть round-trip платится раз на версию базы.
  // Чужой репозиторий и чужая сессия — РАЗНЫЕ числа (S59 не переиспользует
  // S58): смешать их значило бы вернуть ту неточность, ради которой заводился
  // S59. Репозиторные суммы — в отдельном запросе (см. `prime_digest_scan_repo`
  // выше): `sum(CASE ...)` по json_extract бежит по ВСЕМ L2/L3 скоупа, а не
  // только по LIMIT-окну, и платить эту цену без активного `--repo` фильтра
  // не за чем (замер: без разделения p99 дайджеста уходит с ~1.2 мс до ~3.2 мс
  // на 100k даже при пустом фильтре — prime.reach-latency.test.ts).
  prime_reach_counts: {
    name: "prime_reach_counts",
    sql: `SELECT
            sum(CASE WHEN ${reachPredicate("nodes", 2)} THEN 0 ELSE 1 END) AS hidden,
            sum(CASE WHEN ${unknownReachPredicate("nodes")} THEN 1 ELSE 0 END) AS unknown
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL`,
    params: ["scope", "session"],
  },
  prime_repo_counts: {
    name: "prime_repo_counts",
    sql: `SELECT
            sum(CASE WHEN ${repoPredicate("nodes", 2)} THEN 0 ELSE 1 END) AS repo_hidden,
            sum(CASE WHEN ${unknownRepoPredicate("nodes")} THEN 1 ELSE 0 END) AS repo_unknown
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL`,
    params: ["scope", "repo"],
  },
  prime_inprogress: {
    name: "prime_inprogress",
    sql: `SELECT id, title, priority, assignee, lease_expires FROM nodes INDEXED BY ix_nodes_lease
           WHERE status = 'in_progress' AND scope = ?1 AND kind = 'task' AND deleted_at IS NULL
           ORDER BY lease_expires DESC LIMIT ?2`,
    params: ["scope", "lim"],
  },
});

const QP = primeQueries;

// ---------------------------------------------------------------------------
// Модель дайджеста
// ---------------------------------------------------------------------------

interface DigestItem {
  readonly id: string;
  readonly title: string;
  readonly updated_at: number;
  readonly tier: "project" | "personal";
  /** Охват S58: "session" | "project" | "unknown". */
  readonly reach: ReachInfo["reach"];
  /** Как охват определён: recorded | episode | absent. */
  readonly reach_by: ReachInfo["by"];
}

/** Числа охвата (И2): скрытое и неопределённое обязаны быть названы. */
interface ReachSummary {
  /** Отсеяно фильтром как принадлежащее ЧУЖОЙ сессии. */
  readonly hidden: number;
  /** L2/L3 без записанного охвата — их видно, но за них никто не отвечает. */
  readonly unknown: number;
}

/**
 * Числа охвата РЕПОЗИТОРИЯ для памяти (S59, И2) — отдельно от {@link ReachSummary}:
 * это другая ось (см. комментарий модуля), и её счётчики не смешиваются с
 * сессионными, иначе подвал вернулся бы к неточности, ради устранения
 * которой заводилась задача.
 */
interface RepoMemSummary {
  /** L2/L3 отсеяно фильтром как принадлежащее чужому репозиторию. */
  readonly hidden: number;
  /** L2/L3 без записанного охвата репозитория. */
  readonly unknown: number;
}

interface DigestPayload {
  readonly core: readonly DigestItem[];
  readonly decisions: readonly DigestItem[];
  readonly reach: ReachSummary;
  readonly repo: RepoMemSummary;
}

const DIGEST_SCAN_LIMIT = 60;
const CORE_LIMIT = 4;
const DECISIONS_LIMIT = 3;

function scanDigest(
  h: StoreHandle,
  tier: "project" | "personal",
  focus: string | undefined,
  session: string,
  repo: string,
): DigestPayload {
  // Обе оси платятся ТОЛЬКО когда о них реально спросили (И1): без --repo
  // ни скан, ни счётчики не трогают json_extract(attrs,'$.repo') вовсе (см.
  // комментарий у prime_digest_scan_repo/prime_repo_counts).
  const withRepo = repo.length > 0;
  type Row = {
    id: string;
    layer: number;
    title: string;
    excerpt: string;
    updated_at: number;
    reach_raw: string | null;
    session_raw: string | null;
    episode_raw: string | null;
    repo_raw?: string | null;
  };
  const rows = withRepo
    ? h.driver.all<Row>(QP.prime_digest_scan_repo, [h.scope, DIGEST_SCAN_LIMIT, session, repo])
    : h.driver.all<Row>(QP.prime_digest_scan, [h.scope, DIGEST_SCAN_LIMIT, session]);
  const counts = h.driver.one<{ hidden: number | null; unknown: number | null }>(
    QP.prime_reach_counts,
    [h.scope, session],
  );
  const reach: ReachSummary = {
    hidden: counts?.hidden ?? 0,
    unknown: counts?.unknown ?? 0,
  };
  const repoCounts = withRepo
    ? h.driver.one<{ repo_hidden: number | null; repo_unknown: number | null }>(
        QP.prime_repo_counts,
        [h.scope, repo],
      )
    : undefined;
  const repoSummary: RepoMemSummary = {
    hidden: repoCounts?.repo_hidden ?? 0,
    unknown: repoCounts?.repo_unknown ?? 0,
  };

  const needle = focus?.trim().toLowerCase();
  const matches = (title: string, excerpt: string): boolean =>
    needle === undefined || needle.length === 0 ||
    title.toLowerCase().includes(needle) ||
    excerpt.toLowerCase().includes(needle);

  // Секции названы по СЛОЮ (design doc §3.2: "CORE L3" / "DECISIONS L2"),
  // не по attrs.type — kind-агностично, как и сам ix_nodes_prime.
  const core: DigestItem[] = [];
  const decisions: DigestItem[] = [];
  for (const row of rows) {
    if (!matches(row.title, row.excerpt)) continue;
    const info = reachFromColumns(row);
    // Двойная страховка над SQL-фильтром: если предикат и разбор разойдутся,
    // чужое сессионное не должно доехать до контекста молча.
    if (!visibleInPrime(info, session)) continue;
    // Та же страховка для охвата репозитория (S59): чужой repoX не должен
    // доехать до `--repo repoY` молча, если SQL и JS-предикат разойдутся.
    const repoInfo = repoFromColumns(row);
    if (!visibleInRepo(repoInfo, repo)) continue;
    const item: DigestItem = {
      id: row.id,
      title: row.excerpt || row.title,
      updated_at: row.updated_at,
      tier,
      reach: info.reach,
      reach_by: info.by,
    };
    if (row.layer >= 3) {
      if (core.length < CORE_LIMIT) core.push(item);
    } else if (row.layer === 2) {
      if (decisions.length < DECISIONS_LIMIT) decisions.push(item);
    }
    if (core.length >= CORE_LIMIT && decisions.length >= DECISIONS_LIMIT) break;
  }
  return { core, decisions, reach, repo: repoSummary };
}

/**
 * Вариант кеша дайджеста: чем `prime` в одном скоупе законно РАЗЛИЧАЕТСЯ,
 * не различаясь базой.
 *
 * Сессия И РЕПОЗИТОРИЙ — ЧАСТЬ КЛЮЧА. Без сессии дайджест сессии A
 * отдавался бы сессии B при том же seq оплога; без репозитория `--repo
 * repoX` отдал бы дайджест, посчитанный для repoY. Оба случая — не промах
 * производительности, а обход фильтра охвата (S58/S59) попаданием в кеш.
 *
 * v3 — версия ФОРМЫ payload (в неё добавлено поле `repo`): при смене формы
 * версия обязана меняться, иначе старая запись подсунет payload без нового
 * поля. Версия стоит в варианте, а не в имени профиля: профиль — это стык
 * S4 (`prime` и есть `prime`), его нельзя двигать при каждой правке формы.
 */
function digestVariant(session: string, repo: string): string {
  return `v3:${session}:${repo}`;
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
  readonly lease_expires: number;
}

export interface PrimeData {
  readonly ws: string;
  readonly node_count: number;
  readonly idx_ok: boolean;
  readonly now: number;
  readonly empty: boolean;
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
    lease_expires: number;
  }>(QP.prime_inprogress, [h.scope, INPROGRESS_LIMIT]);
  return {
    total: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      assignee: r.assignee,
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
    summary: "session bootstrap: what we already know about the project",
    flags: PRIME_FLAGS,
    help:
      "READY > IN PROGRESS > CORE > DECISIONS > NEXT, in that priority order — the tail is cut " +
      "first and predictably when --budget is too small. Never calls the embedder; --focus filters " +
      "the L2/L3 digest by substring, not by semantic search. `myc route` is a separate command " +
      "(S12) and `myc bootstrap` is a separate command — neither is duplicated here.",
    handler: async (ctx) => {
      const t0 = performance.now();

      const budgetRaw = flagNum(ctx, "budget") ?? DEFAULT_BUDGET;
      if (!Number.isFinite(budgetRaw) || budgetRaw < MIN_BUDGET) {
        return failure(
          "usage.invalid",
          `--budget слишком мал (${budgetRaw}); минимум ${MIN_BUDGET}`,
          ExitCode.USAGE,
        );
      }
      const budget = Math.floor(budgetRaw);

      const role = parseRole(flagStr(ctx, "role"));
      if (role === undefined) {
        return failure("usage.invalid", `неверная --role; допустимы ${ROLES.join("|")}`, ExitCode.USAGE);
      }
      const format = parseFormat(flagStr(ctx, "format"));
      if (format === undefined) {
        return failure("usage.invalid", "неверный --format; допустимы agent|md|json", ExitCode.USAGE);
      }
      const focus = flagStr(ctx, "focus");
      // S58: чья это сессия. Пусто — сессия неизвестна, и тогда сессионное
      // знание в контекст не попадает вовсе; подвал говорит об этом словом,
      // а не молчит (И2).
      const session = resolveSession(flagStr(ctx, "session"));

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const now = Date.now();
        const nodeCount = h.driver.one<{ n: number }>(QP.prime_node_count, [h.scope])?.n ?? 0;
        const empty = nodeCount === 0;

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
              payload: { core: [], decisions: [], reach: { hidden: 0, unknown: 0 }, repo: { hidden: 0, unknown: 0 } },
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

        if (!empty) {
          try {
            const openedPersonal = await deps.openPersonal(ctx);
            if (!openedPersonal.ok) {
              ctx.warn("degraded.personal_tier", `личный ярус не открылся: ${openedPersonal.failure.msg}`);
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
              } finally {
                personal.close();
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.warn("degraded.personal_tier", `личный ярус не открылся: ${msg}`);
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
          degraded,
          ...(focus !== undefined ? { focus } : {}),
          format,
          budget,
          cache: digested.cache,
          took_ms: tookMs,
        };

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
  if (it.reach === "session") out.push("@сессия");
  else if (it.reach === "unknown") out.push("@без охвата");
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
      ? `сессия ${d.session.slice(0, SESSION_SHORT)}`
      : "сессия не указана",
  ];
  if (d.reach_hidden > 0) parts.push(`чужого скрыто ${d.reach_hidden}`);
  if (d.reach_unknown > 0) parts.push(`без охвата ${d.reach_unknown}`);
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
  if (d.repo_undetermined) out.push(`охват репозитория не определён: ${d.repo_reason}`);
  if (d.repo_foreign > 0) out.push(`${d.repo_foreign} из других репозиториев скрыто`);
  if (d.repo_unknown > 0) out.push(`${d.repo_unknown} без охвата репозитория`);
  if (d.mem_repo_foreign > 0) out.push(`${d.mem_repo_foreign} заметок из других репозиториев скрыто`);
  if (d.mem_repo_unknown > 0) out.push(`${d.mem_repo_unknown} заметок без охвата репозитория`);
  return out;
}

function buildSections(d: Omit<PrimeData, "chars" | "truncated" | "cut">, md: boolean): Section[] {
  const h1 = md ? "## " : "# ";
  const sections: Section[] = [];

  if (d.empty) {
    sections.push({ key: "empty", text: "Воркспейс пуст. Ничего не помню про этот проект." });
    sections.push({
      key: "next",
      text: [
        `${h1}NEXT`,
        'myc create "<первая задача>" -p P1',
        'myc remember "<что важно знать о проекте>"',
        "myc import --from beads       найдено .beads/ (если есть)",
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
    text: [`${h1}READY ${d.ready.length} из ${d.ready_total}`, ...readyLines].join("\n"),
  });

  if (d.in_progress.length > 0) {
    const lines = d.in_progress.map((it) => {
      const age = fmtAge(Math.max(0, d.now - it.lease_expires));
      const who = it.assignee.length > 0 ? `@${it.assignee}` : "free";
      return `${it.id}  ${fmtPriority(it.priority)}  ${it.title}  ${who}  до ${fmtClock(it.lease_expires)} (${age})`;
    });
    sections.push({
      key: "in_progress",
      text: [`${h1}IN PROGRESS ${d.in_progress_total}`, ...lines].join("\n"),
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
    "myc ready --claim        взять верхнюю задачу атомарно",
  ];
  if (d.role === "human") nextLines.push("myc --help                список команд");
  else {
    nextLines.push('myc recall "<тема>"      факты и решения по теме');
    nextLines.push('myc remember "<факт>"    записать вывод');
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
  return `myc ${CLI_VERSION} · ws=${d.ws} sqlite · ${d.node_count} узлов · ${idx} · ${new Date(d.now).toISOString()}`;
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
  let footer = `${parts.join("\n\n").length} симв · ${d.took_ms} мс · cache ${d.cache}`;
  if (truncated) footer += ` · cut ${cut.join(",")}`;
  if (footer.length > FOOTER_MAX) footer = footer.slice(0, FOOTER_MAX);
  // Строка охвата дописывается ПОСЛЕ обрезки подвала: она про то, чего в
  // выдаче нет, и молчаливо потерять её — то же, что молчаливо фильтровать.
  footer += ` · ${reachFooter(d)}`;
  const text = `${parts.join("\n\n")}\n\n${footer}\n`;
  return { text, chars: text.length, truncated, cut };
}
