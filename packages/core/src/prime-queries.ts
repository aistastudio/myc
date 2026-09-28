/**
 * ДАЙДЖЕСТ ПАМЯТИ ДЛЯ `prime` — ОДИН НА CLI И НА СЕРВЕР.
 *
 * Реестр запросов и сам скан жили в команде; переехали сюда, когда дайджест
 * понадобился серверу (`GET /v1/ws/:ws/prime`). Причина та же, что у очереди:
 * контекст, который агент получает на старте, обязан быть ОДНИМ, кто бы его
 * ни собрал — CLI из локальной базы или сервер из общей.
 *
 * Скан написан генератором (effect.ts): синхронный исполнитель гоняет его над
 * bun:sqlite, асинхронный — над Postgres. Отбор (охват сессии, охват
 * репозитория, кандидаты на разбор, потерянный код) целиком здесь: в SQL до
 * LIMIT и ещё раз в JS как страховка — разъехавшись, предикат и разбор
 * пропустили бы чужое в контекст молча.
 *
 * СБОРКА СЕКЦИЙ ЗДЕСЬ НЕ ЖИВЁТ. Бюджет, порядок секций и человеческий вид —
 * дело поверхности, и у CLI оно своё.
 */

import { all, one, type Eff } from "./effect.ts";
import { historyClause } from "./graph.ts";
import {
  reachColumns,
  reachClause,
  reachFromColumns,
  reachPredicate,
  type ReachInfo,
  unknownReachPredicate,
  visibleInPrime,
} from "./reach.ts";
import {
  repoClause,
  repoColumns,
  repoPredicate,
  repoFromColumns,
  unknownRepoPredicate,
  visibleInRepo,
} from "./repo.ts";
import { defineQueries, toPgDialect } from "./sql.ts";
import { awaitingReviewPredicate, liveStatusPredicate, notPendingClause } from "./review.ts";
import { anchorsAlivePredicate, anchorsAllLostSql, lostAnchorOwnersSql } from "./anchors-predicates.ts";

/**
 * Дайджест на Postgres — ОДИН запрос вместо двухшагового скана.
 *
 * Двухшаговость выше (rowid во внутреннем запросе, терм якорей снаружи) — это
 * лечение конкретной болезни SQLite: там терм якорей внутри WHERE считался бы
 * на каждой строке сортируемых групп слоя. В Postgres нет ни `rowid`, ни этой
 * болезни: планировщик сам решает, когда считать подзапрос, а `LIMIT -1`
 * там и вовсе синтаксическая ошибка. Копировать форму ради сходства значило бы
 * переносить чужое лекарство вместе с диагнозом.
 *
 * Смысл сохранён дословно: те же условия, тот же порядок (layer DESC,
 * salience DESC) и тот же LIMIT — паритет сверяет строки (parity.pg.test.ts).
 */
function digestScanPgSql(withRepo: boolean): string {
  return `SELECT n.id, n.layer, n.title, n.excerpt, n.updated_at,
                 ${reachColumns("n")}${withRepo ? `, ${repoColumns("n")}` : ""}
            FROM nodes n
           WHERE n.scope = ?1 AND n.layer >= 2${historyClause("follow", "n")}
             AND n.deleted_at IS NULL${reachClause("n", 3)}${withRepo ? repoClause("n", 4) : ""}${notPendingClause("n")}
             AND ${liveStatusPredicate("n")}
             AND ${anchorsAlivePredicate("n")}
           ORDER BY n.layer DESC, n.salience DESC
           LIMIT ?2`;
}

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
  // КАНДИДАТЫ НА ПОДТВЕРЖДЕНИЕ (§6.2, @myc/retrieval review.ts) отсеиваются
  // тем же способом и по той же причине — в SQL, до LIMIT: кандидат пишется
  // L2, и окно из 60 строк иначе доставалось бы им. Индекса под этот терм не
  // нужно: SQLite считает термы, покрытые индексом (охват), ДО похода в
  // строку, а строку прошедших всё равно читает ради title/excerpt — проверка
  // состояния ложится на уже прочитанную строку (замер —
  // prime.pending-latency.test.ts).
  // СКРЫВАЕМЫЕ СТАТУСЫ (memory-0p3d8n1efwtv) — тем же способом, по той же
  // причине и в ту же уже прочитанную строку: отозванная заметка L3 с высокой
  // salience иначе стояла бы в CORE, а сотня таких — в голове окна из 60
  // строк. Список один на систему (HIDDEN_STATUSES, @myc/retrieval review.ts):
  // до него скан статуса не смотрел вовсе, и CORE/DECISIONS отдавали то, что
  // строка статуса уже не считала.
  // ЗНАНИЕ, ЧЕЙ КОД ПОТЕРЯН ЦЕЛИКОМ (§7.3: `lost` — «не попадает в prime»,
  // memory-d81a4d4hn8ef) — тоже до LIMIT окна и по той же причине, но НЕ в
  // том же WHERE. Порядок (layer DESC, salience DESC) индекс (layer ASC,
  // salience DESC) не даёт, и SQLite сортирует каждую группу слоя целиком:
  // все термы внутреннего WHERE считаются на КАЖДОЙ строке нужных групп. Там,
  // где L3 меньше окна (живая база: L3 39, L2 48), это вся L2 — тысячи строк
  // на 100k, а терм якорей — поиск по edges на строку (~1 мкс). Прямым термом
  // замер дал ×3.1 к скану (8.1 против 2.6 мс, L3 40, L2 4960), при L3 200 —
  // ×1.8. Поэтому внутри сортируется только rowid, а терм стоит СНАРУЖИ
  // сопрограммы и считается лишь на строках, дошедших до окна по порядку:
  // ×1.12 и ×1.31 на тех же стендах (prime.lost-latency.test.ts).
  //   `LIMIT -1` внутри — не украшение: подзапрос с LIMIT SQLite не
  // сплющивает во внешний запрос и не выбрасывает его ORDER BY, иначе терм
  // вернулся бы в общий WHERE (правило 19 flattener'а). CROSS JOIN держит
  // порядок цикла «окно снаружи, строка узла внутри», поэтому строки выходят в
  // порядке сортировки; тест сверяет окно с тем же фильтром прямым термом под
  // ORDER BY (тот и есть оракул порядка).
  prime_digest_scan: {
    name: "prime_digest_scan",
    pg: toPgDialect(digestScanPgSql(false)),
    sql: `SELECT n.id, n.layer, n.title, n.excerpt, n.updated_at,
                 ${reachColumns("n")}
            FROM (SELECT nodes.rowid AS rid
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 3)}${notPendingClause("nodes")}
             AND ${liveStatusPredicate("nodes")}
           ORDER BY nodes.layer DESC, nodes.salience DESC LIMIT -1) w
           CROSS JOIN nodes n ON n.rowid = w.rid
           WHERE ${anchorsAlivePredicate("n")}
           LIMIT ?2`,
    params: ["scope", "lim", "session"],
  },
  prime_digest_scan_repo: {
    name: "prime_digest_scan_repo",
    pg: toPgDialect(digestScanPgSql(true)),
    sql: `SELECT n.id, n.layer, n.title, n.excerpt, n.updated_at,
                 ${reachColumns("n")}, ${repoColumns("n")}
            FROM (SELECT nodes.rowid AS rid
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 3)}${repoClause("nodes", 4)}${notPendingClause("nodes")}
             AND ${liveStatusPredicate("nodes")}
           ORDER BY nodes.layer DESC, nodes.salience DESC LIMIT -1) w
           CROSS JOIN nodes n ON n.rowid = w.rid
           WHERE ${anchorsAlivePredicate("n")}
           LIMIT ?2`,
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
  // Сколько кандидатов фильтр ИМЕННО ЭТОГО prime спрятал (И2): те, что
  // прошли бы охват (чужие сессионные уже названы числом выше), но ещё ждут
  // разбора. Отдельным запросом, а не третьей суммой в prime_reach_counts:
  // терм по attrs требует строку таблицы, а prime_reach_counts живёт одним
  // индексом. Здесь строка читается только у прошедших охват — его термы
  // покрыты индексом и считаются первыми. Замер на 100k
  // (prime.pending-latency.test.ts): где 97 % L2/L3 чужие — 0.41 мс против
  // 0.57 у prime_reach_counts; где видимо всё (худший случай) — ≈ 1.2 мс,
  // весь дайджест 1.6 мс p50 при подбюджете 3. Платится раз на версию базы:
  // payload кешируется вместе с дайджестом. Частичный индекс `WHERE
  // json_extract(attrs,'$.state')='pending_review'` снял бы и это (тот же
  // стенд, ≈ 0.05 мс) — ценой миграции, которой один счётчик подвала не стоит.
  prime_pending_count: {
    name: "prime_pending_count",
    sql: `SELECT count(*) AS n
            FROM nodes INDEXED BY ix_nodes_prime_reach
           WHERE nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 2)}
             AND ${awaitingReviewPredicate("nodes")}`,
    params: ["scope", "session"],
  },
  // Сколько знания скан спрятал как потерявшее код целиком (§7.3, И2) — те,
  // что прошли бы охват, фильтр кандидатов и статусов: у каждого скрытого одна
  // причина в подвале, кандидат с потерянным якорем уже назван кандидатом.
  // Счёт идёт ОТ ПОТЕРЯННЫХ ЯКОРЕЙ (ix_anchors_check), а не от всех L2/L3:
  // от узлов это ~1 мкс на каждую видимую строку (5.6 мс на 100k, ×4.2 к
  // prime_pending_count), от якорей — ~2–4 мкс на каждый lost-якорь базы
  // (2.1 мс при 493 lost, ×1.55), а при их отсутствии — один спуск по
  // индексу. Охват репозитория не применяется — как у prime_pending_count:
  // оси считаются независимо (см. prime_repo_counts).
  prime_lost_count: {
    name: "prime_lost_count",
    sql: `SELECT count(*) AS n
            FROM nodes
           WHERE nodes.id IN (${lostAnchorOwnersSql()})
             AND nodes.scope = ?1 AND nodes.layer >= 2${historyClause("follow", "nodes")}
             AND nodes.deleted_at IS NULL${reachClause("nodes", 2)}${notPendingClause("nodes")}
             AND ${liveStatusPredicate("nodes")}
             AND ${anchorsAllLostSql("nodes")} = 1`,
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
    sql: `SELECT id, title, priority, assignee, lease_holder, lease_expires FROM nodes INDEXED BY ix_nodes_lease
           WHERE status = 'in_progress' AND scope = ?1 AND kind = 'task' AND deleted_at IS NULL
           ORDER BY lease_expires DESC LIMIT ?2`,
    params: ["scope", "lim"],
  },
  // Сколько всего в работе — тот же частичный индекс, спрашивается только
  // когда показанные строки упёрлись в лимит. Раньше итогом служило число
  // показанных, и заголовок «IN PROGRESS 3» стоял над 37 задачами в работе.
  prime_inprogress_count: {
    name: "prime_inprogress_count",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_lease
           WHERE status = 'in_progress' AND scope = ?1 AND kind = 'task' AND deleted_at IS NULL`,
    params: ["scope"],
  },
});

export interface DigestItem {
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
export interface ReachSummary {
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
export interface RepoMemSummary {
  /** L2/L3 отсеяно фильтром как принадлежащее чужому репозиторию. */
  readonly hidden: number;
  /** L2/L3 без записанного охвата репозитория. */
  readonly unknown: number;
}

export interface DigestPayload {
  readonly core: readonly DigestItem[];
  readonly decisions: readonly DigestItem[];
  readonly reach: ReachSummary;
  readonly repo: RepoMemSummary;
  /** Кандидаты на подтверждение (§6.2), скрытые из этого дайджеста (И2). */
  readonly pending: number;
  /** Знание, у которого все якоря `lost` (§7.3), скрытое из дайджеста (И2). */
  readonly lost: number;
}

export const DIGEST_SCAN_LIMIT = 60;
export const CORE_LIMIT = 4;
export const DECISIONS_LIMIT = 3;

/**
 * Счётчики приходят из Postgres СТРОКАМИ (`sum`/`count` — BIGINT и numeric),
 * а из bun:sqlite числами. Контракт payload — числа: поймано ws.pg.test.ts,
 * где «скрыто» в подвале оказалось строкой и сравнение с нулём перестало быть
 * сравнением.
 */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

export function* digestScan(
  scope: string,
  tier: "project" | "personal",
  focus: string | undefined,
  session: string,
  repo: string,
): Eff<DigestPayload> {
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
    ? yield* all<Row>(primeQueries.prime_digest_scan_repo, [scope, DIGEST_SCAN_LIMIT, session, repo])
    : yield* all<Row>(primeQueries.prime_digest_scan, [scope, DIGEST_SCAN_LIMIT, session]);
  const counts = yield* one<{ hidden: number | null; unknown: number | null }>(
    primeQueries.prime_reach_counts,
    [scope, session],
  );
  const reach: ReachSummary = {
    hidden: num(counts?.hidden),
    unknown: num(counts?.unknown),
  };
  const repoCounts = withRepo
    ? yield* one<{ repo_hidden: number | null; repo_unknown: number | null }>(
        primeQueries.prime_repo_counts,
        [scope, repo],
      )
    : undefined;
  const repoSummary: RepoMemSummary = {
    hidden: num(repoCounts?.repo_hidden),
    unknown: num(repoCounts?.repo_unknown),
  };
  const pending = num((yield* one<{ n: number }>(primeQueries.prime_pending_count, [scope, session]))?.n);
  const lost = num((yield* one<{ n: number }>(primeQueries.prime_lost_count, [scope, session]))?.n);

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
      updated_at: num(row.updated_at),
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
  return { core, decisions, reach, repo: repoSummary, pending, lost };
}

