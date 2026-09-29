/**
 * РЕЕСТР ОЧЕРЕДИ READY — ОДИН НА CLI И НА СЕРВЕР.
 *
 * Жил в `packages/cli/src/commands/ready.ts`, переехал сюда, когда очередь
 * понадобилась серверу (`GET /v1/ws/:ws/ready`): сервер видит только ядро, а
 * два текста одной формулы S21 разошлись бы молча — и «что брать следующим»
 * у человека в терминале и у агента через HTTP стало бы разным ответом.
 *
 * Скоринг живёт в SQL и считается ОДНИМ сканом частичного индекса: через мост
 * уходят только top-k строк. Слагаемые округляются до сотых ДО суммы, как и в
 * JS-скоринге команды, поэтому напечатанный score всегда равен сумме
 * напечатанных слагаемых.
 *
 * Тексты обоих диалектов даёт один генератор: расхождения по существу
 * (round у numeric, least вместо min, trunc вместо CAST) закрыты паритетом на
 * живой базе — packages/cli/src/parity.pg.test.ts.
 */

import { freshnessClockSql } from "./freshness.ts";
import { repoClause, repoPredicate } from "./repo.ts";
import { aclClause } from "./acl.ts";
import { defineQueries, toPgDialect, type Dialect } from "./sql.ts";

export interface ReadyWeights {
  priority: number;
  unblocks: number;
  freshness: number;
  anchors: number;
  type: number;
}

/** Ратифицированные веса сортировки ready (S21); переопределяются в workspace.toml. */
export const DEFAULT_READY_WEIGHTS: ReadyWeights = {
  priority: 0.4,
  unblocks: 0.27,
  freshness: 0.14,
  anchors: 0.1,
  type: 0.09,
};

export interface WorkspaceConfig {
  slug: string;
  weights: ReadyWeights;
  /**
   * Бюджет `myc bootstrap`, символов. Живёт в конфиге ПРОЕКТА, а не в
   * переменной окружения, потому что там же живут и сами блоки: `myc bootstrap
   * set` пишет проектные правила, и умолчание 2000 их не вмещает — замер на
   * пяти закреплённых блоках дал 2863 символа, и первым вытеснялся `[auto:graft]`,
   * самый нужный агенту. Настройка одного разработчика в его окружении не
   * помогает остальным: правила общие, значит и бюджет общий.
   */
  bootstrapBudget?: number;
}

const CLOSED = "('closed','cancelled','superseded','retracted')";

// Слагаемые формулы S21 — в SQL: score считается для всех кандидатов одним
// сканом частичного индекса ix_nodes_ready, через мост уходят только top-k
// строк. Слагаемые округлены до сотых ДО суммы — как и в JS-скоринге ниже,
// поэтому напечатанный score всегда равен сумме напечатанных слагаемых.
const UNBLOCKS_SUBQ = `(SELECT count(*) FROM edges e JOIN nodes d ON d.id = e.dst
      WHERE e.src = n.id AND e.type = 'blocks' AND e.deleted_at IS NULL
        AND d.deleted_at IS NULL AND d.status NOT IN ${CLOSED})`;

const ANCHOR_SUBQ = `COALESCE((SELECT CASE
        WHEN count(*) = 0 THEN 0.5
        WHEN sum(CASE WHEN a.status <> 'fresh' THEN 1 ELSE 0 END) = 0 THEN 1.0
        WHEN sum(CASE WHEN a.status IN ('stale','lost') THEN 1 ELSE 0 END) > 0 THEN 0.2
        ELSE 0.6 END
      FROM edges e JOIN nodes a ON a.id = e.dst
      WHERE e.src = n.id AND e.type = 'touches' AND e.deleted_at IS NULL
        AND a.kind = 'anchor' AND a.deleted_at IS NULL), 0.5)`;

/**
 * ОХВАТ РЕПОЗИТОРИЯ В ИСТОЧНИКЕ (S59, И1). Фильтр стоит в SQL, а не над
 * выдачей: score считается для ВСЕХ кандидатов, а top-k режется уже после
 * сортировки, поэтому отсев в JS пришёл бы после LIMIT и выдавал бы неполную
 * очередь. Вариант с фильтром пинится к ix_nodes_ready_repo (миграция 007):
 * выражение `json_extract(attrs,'$.repo')` лежит там второй колонкой, и
 * SQLite отбрасывает чужой репозиторий, не читая строку таблицы. Вариант без
 * фильтра остаётся на более коротком ix_nodes_ready — за то, чего не просили,
 * платить не надо.
 */
/**
 * Слагаемое свежести S21 по ЧАСАМ СВЕЖЕСТИ (freshnessClockSql, @myc/retrieval) —
 * тем же, что у выдачи и show; у ввезённой и не тронутой в myc задачи
 * updated_at — день ввоза, и по нему она была бы свежей (memory-khny4xb612m6).
 *
 * Часы вычисляются ОДИН раз на кандидата: база `CASE x WHEN …` считается
 * однажды, а ступени 1/3/7 суток — это целые сутки возраста 0 | 1–2 | 3–6 | 7+.
 * Три `WHEN ?8 - часы < …` вычисляли бы выражение трижды: на стенде, где все
 * 4000 готовых задач ввезены, это +70 % к скорингу.
 */
function freshnessTermSql(dialect: Dialect): string {
  const clock = freshnessClockSql("n", dialect);
  // Возраст в целых сутках. У SQLite это `CAST(… AS INTEGER)` — отсечение
  // дробной части; в Postgres тот же CAST ОКРУГЛЯЕТ (2.6 → 3), поэтому там
  // `trunc`: иначе задача на полтора дня попадала бы в другую ступень
  // свежести. Двухаргументные min/max в Postgres называются least/greatest.
  const days =
    dialect === "pg"
      ? `least(7, greatest(0, trunc((?8 - ${clock}) / 86400000.0)))`
      : `min(7, max(0, CAST((?8 - ${clock}) / 86400000 AS INTEGER)))`;
  return `CASE ${days}
                         WHEN 0 THEN 1.0 WHEN 1 THEN 0.7 WHEN 2 THEN 0.7 WHEN 7 THEN 0.15 ELSE 0.4 END`;
}

/**
 * Текст скоринга для ОБОИХ диалектов из одного генератора.
 *
 * Механическое (плейсхолдеры, `INDEXED BY`, `json_extract` одного ключа)
 * доделывает `toPgDialect` — здесь только то, что механически не переводится:
 *
 *  - `round(x, 2)`: в Postgres round с точностью есть ТОЛЬКО у numeric, а
 *    произведение веса на CASE — double precision, поэтому явное приведение;
 *  - `min(a,b)` → `least(a,b)`: в Postgres min — агрегат, а не скаляр;
 *  - свежесть и отсечение дробной части — см. freshnessTermSql.
 */
/**
 * `acl` — добавить предикат видимости (сервер: смотрящий известен всегда).
 * Локально его нет вовсе: у одного человека со своей базой проверять некого,
 * и лишний терм в горячем пути очереди не нужен (стык S16).
 */
function scoredTopSql(
  anchorTerm: string,
  withRepo: boolean,
  dialect: Dialect = "sqlite",
  acl = false,
): string {
  const round2 = (expr: string): string =>
    dialect === "pg" ? `round((${expr})::numeric, 2)` : `round(${expr}, 2)`;
  const least = (x: string, y: string): string => (dialect === "pg" ? `least(${x}, ${y})` : `min(${x}, ${y})`);
  return `SELECT n.id, n.priority, n.status, n.assignee, n.title,
            n.updated_at, n.created_at, n.attrs,
       ${round2("?2 * CASE n.priority WHEN 0 THEN 1.0 WHEN 1 THEN 0.6667 WHEN 2 THEN 0.3333 ELSE 0.0 END")}
     + ${round2(`?3 * ${least(`COALESCE(${UNBLOCKS_SUBQ}, 0)`, "3")} / 3.0`)}
     + ${round2(`?4 * ${freshnessTermSql(dialect)}`)}
     + ${round2(`?5 * ${anchorTerm}`)}
     + ${round2(`?6 * CASE COALESCE(json_extract(n.attrs,'$.type'),'task')
                       WHEN 'bug' THEN 1.0 WHEN 'task' THEN 0.5 ELSE 0.25 END`)}
       AS score,
       count(*) OVER () AS total_ready
    FROM nodes AS n INDEXED BY ${withRepo ? "ix_nodes_ready_repo" : "ix_nodes_ready"}
   WHERE n.scope = ?1 AND n.kind = 'task' AND n.status = 'open'
     AND n.open_blockers = 0 AND n.anc_blockers = 0
     AND n.deleted_at IS NULL${withRepo ? repoClause("n", 9) : ""}${acl ? aclClause("n", withRepo ? 10 : 9) : ""}
   ORDER BY score DESC, n.priority ASC, n.id ASC
   LIMIT ?7`;
}

const TOP_PARAMS = ["scope", "w_pri", "w_unb", "w_fresh", "w_anch", "w_type", "lim", "now"] as const;
const TOP_PARAMS_REPO = [...TOP_PARAMS, "repo"] as const;
const ACL_PARAMS = ["owner", "team", "agent"] as const;

/** Экспортировано для теста бюджета (ready.repo-latency.test.ts): замер обязан
 * идти по ТОМУ ЖЕ тексту SQL, что и горячий путь, а не по его копии. */
export const readyQueries = defineQueries({
  // Горячий путь: без якорных подзапросов, когда touches-рёбер нет вовсе
  // (проверяется один раз за вызов) — типичный случай.
  ready_top_noanchors: {
    name: "ready_top_noanchors",
    sql: scoredTopSql("0.5", false),
    pg: toPgDialect(scoredTopSql("0.5", false, "pg")),
    params: [...TOP_PARAMS],
  },
  ready_top_anchors: {
    name: "ready_top_anchors",
    sql: scoredTopSql(ANCHOR_SUBQ, false),
    pg: toPgDialect(scoredTopSql(ANCHOR_SUBQ, false, "pg")),
    params: [...TOP_PARAMS],
  },
  ready_top_noanchors_repo: {
    name: "ready_top_noanchors_repo",
    sql: scoredTopSql("0.5", true),
    pg: toPgDialect(scoredTopSql("0.5", true, "pg")),
    params: [...TOP_PARAMS_REPO],
  },
  ready_top_anchors_repo: {
    name: "ready_top_anchors_repo",
    sql: scoredTopSql(ANCHOR_SUBQ, true),
    pg: toPgDialect(scoredTopSql(ANCHOR_SUBQ, true, "pg")),
    params: [...TOP_PARAMS_REPO],
  },
  ready_touches_exist: {
    name: "ready_touches_exist",
    sql: `SELECT 1 AS x FROM edges WHERE type = 'touches' AND deleted_at IS NULL LIMIT 1`,
    params: [],
  },
  ready_unblocks_one: {
    name: "ready_unblocks_one",
    sql: `SELECT count(*) AS n FROM edges e JOIN nodes d ON d.id = e.dst
           WHERE e.src = ?1 AND e.type = 'blocks' AND e.deleted_at IS NULL
             AND d.deleted_at IS NULL AND d.status NOT IN ${CLOSED}`,
    params: ["id"],
  },
  ready_anchor_states_one: {
    name: "ready_anchor_states_one",
    sql: `SELECT n.status AS st FROM edges e JOIN nodes n ON n.id = e.dst
           WHERE e.src = ?1 AND e.type = 'touches' AND e.deleted_at IS NULL
             AND n.kind = 'anchor' AND n.deleted_at IS NULL`,
    params: ["id"],
  },
  ready_stats_blocked: {
    name: "ready_stats_blocked",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers > 0 AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  // И2: задачи, ушедшие из очереди ТОЛЬКО по наследованию (миграция 10).
  // Считаются отдельно от blocked, потому что пользователь ищет их у себя в
  // deps и не находит: блокер висит на эпике, а не на самой задаче.
  ready_stats_blocked_anc: {
    name: "ready_stats_blocked_anc",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers > 0 AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  ready_stats_in_progress: {
    name: "ready_stats_in_progress",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_lease
           WHERE status = 'in_progress' AND scope = ?1 AND kind = 'task'
             AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  // И2: два числа, которые обязаны быть НАЗВАНЫ, а не подразумеваться, —
  // сколько готовых задач без записанного охвата репозитория (старше S59
  // либо путь вывести не удалось) и сколько скрыто фильтром как чужое.
  // Оба считаются по тому же частичному индексу, что и сама очередь, и
  // живут в том же кеше футера — на вызов приходится ноль лишних сканов.
  ready_repo_unknown: {
    name: "ready_repo_unknown",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_ready_repo
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers = 0 AND deleted_at IS NULL
             AND json_extract(nodes.attrs,'$.repo') IS NULL`,
    params: ["scope"],
  },
  ready_repo_foreign: {
    name: "ready_repo_foreign",
    sql: `SELECT count(*) AS n FROM nodes INDEXED BY ix_nodes_ready_repo
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers = 0 AND deleted_at IS NULL
             AND NOT ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  ready_candidates: {
    name: "ready_candidates",
    sql: `SELECT id, priority, status, assignee, title, updated_at, created_at, attrs
            FROM nodes
           WHERE scope = ?1 AND kind = 'task' AND status = 'open'
             AND open_blockers = 0 AND anc_blockers = 0 AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  // Задачи, брошенные с истёкшей арендой (§9.4): тот же предикат re-open,
  // что и в claim_node/claim_candidates (queries.ts) — движок и очередь
  // обязаны видеть одно и то же "свободна". Отдельный запрос, а не UNION
  // с ready_candidates/ready_top_*: ix_nodes_lease (status='in_progress')
  // и ix_nodes_ready (status='open') — разные частичные индексы, слияние
  // одним SQL сломало бы план по ix_nodes_ready (см. schema.test.ts).
  ready_expired_candidates: {
    name: "ready_expired_candidates",
    sql: `SELECT id, priority, status, assignee, title, updated_at, created_at, attrs,
                 lease_holder, lease_expires
            FROM nodes INDEXED BY ix_nodes_lease
           WHERE status = 'in_progress' AND lease_expires > 0 AND lease_expires < ?2
             AND scope = ?1 AND kind = 'task' AND open_blockers = 0 AND anc_blockers = 0
             AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 3)}`,
    params: ["scope", "now", "repo"],
  },
  ready_unblocks: {
    name: "ready_unblocks",
    sql: `SELECT e.src AS id, count(*) AS n
            FROM edges e JOIN nodes d ON d.id = e.dst
           WHERE e.type = 'blocks' AND e.deleted_at IS NULL
             AND d.deleted_at IS NULL AND d.status NOT IN ${CLOSED}
           GROUP BY e.src`,
    params: [],
  },
  ready_anchor_states: {
    name: "ready_anchor_states",
    sql: `SELECT e.src AS id, n.status AS st
            FROM edges e JOIN nodes n ON n.id = e.dst
           WHERE e.type = 'touches' AND e.deleted_at IS NULL
             AND n.kind = 'anchor' AND n.deleted_at IS NULL`,
    params: [],
  },
  ready_top_blocker: {
    name: "ready_top_blocker",
    sql: `SELECT e.src AS id, count(*) AS n
            FROM edges e
            JOIN nodes s ON s.id = e.src
            JOIN nodes d ON d.id = e.dst
           WHERE e.type = 'blocks' AND e.deleted_at IS NULL
             AND s.deleted_at IS NULL AND s.status NOT IN ${CLOSED}
             AND d.deleted_at IS NULL AND d.status = 'open'
           GROUP BY e.src ORDER BY n DESC, e.src LIMIT 1`,
    params: [],
  },
});



/**
 * ТОТ ЖЕ РЕЕСТР, НО С ПРЕДИКАТОМ ВИДИМОСТИ. Им пользуется сервер: там
 * смотрящий известен всегда, и очередь обязана считать только видимое —
 * иначе чужая приватная задача займёт место в top-k, а `total_ready`
 * расскажет, сколько её.
 *
 * Отдельный реестр, а не флаг в запросе: у локального пути не должно быть ни
 * одного лишнего терма, а у серверного — ни одной возможности позвать вариант
 * без проверки.
 */
export const readyQueriesAcl = defineQueries({
  ready_top_noanchors_acl: {
    name: "ready_top_noanchors_acl",
    sql: scoredTopSql("0.5", false, "sqlite", true),
    pg: toPgDialect(scoredTopSql("0.5", false, "pg", true)),
    params: [...TOP_PARAMS, ...ACL_PARAMS],
  },
  ready_top_anchors_acl: {
    name: "ready_top_anchors_acl",
    sql: scoredTopSql(ANCHOR_SUBQ, false, "sqlite", true),
    pg: toPgDialect(scoredTopSql(ANCHOR_SUBQ, false, "pg", true)),
    params: [...TOP_PARAMS, ...ACL_PARAMS],
  },
  ready_top_noanchors_repo_acl: {
    name: "ready_top_noanchors_repo_acl",
    sql: scoredTopSql("0.5", true, "sqlite", true),
    pg: toPgDialect(scoredTopSql("0.5", true, "pg", true)),
    params: [...TOP_PARAMS_REPO, ...ACL_PARAMS],
  },
  ready_top_anchors_repo_acl: {
    name: "ready_top_anchors_repo_acl",
    sql: scoredTopSql(ANCHOR_SUBQ, true, "sqlite", true),
    pg: toPgDialect(scoredTopSql(ANCHOR_SUBQ, true, "pg", true)),
    params: [...TOP_PARAMS_REPO, ...ACL_PARAMS],
  },
});
