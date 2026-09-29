/**
 * ЧЕТЫРЕ УРОВНЯ ДОСТУПА И ОДИН ПРЕДИКАТ (§10, решение из таблицы §1).
 *
 * `private` — виден владельцу; `team` — своей команде; `agent` — своему
 * агенту; `restricted` — только тем, кому выдали право строкой в
 * `acl_grants`. Ролями это не заменяется: роль говорит, что человек может
 * ДЕЛАТЬ, `acl` — кому узел ВИДЕН, и путать их значит однажды показать чужую
 * приватную заметку тому, кто «всего лишь читатель».
 *
 * ФИЛЬТР КОМПИЛИРУЕТСЯ В WHERE, А НЕ НАКЛАДЫВАЕТСЯ ПОСЛЕ. Постфильтр после
 * top-k ломает полноту: окно скана забивается невидимым, и своё знание не
 * доезжает до выдачи вовсе. По той же причине его обязан видеть и счётчик:
 * «всего 12» при трёх видимых — это утечка через число, а не мелочь
 * оформления (приёмка memory-w0r3vhgkxmsw говорит ровно об этом).
 *
 * ЛОКАЛЬНО ЕГО НЕТ. У одного человека со своей базой смотрящий не определён,
 * и предикат вырезается из SQL целиком (95 % запусков — локальные, стык
 * S16): платить за проверку, которой некого проверять, незачем. Поэтому
 * запросы, где ACL нужен, строятся отдельными вариантами — как и у охвата
 * репозитория.
 */

/** Кто смотрит. Пустые поля значат «такой принадлежности нет», а не «любая». */
export interface Viewer {
  /** Владелец: `owner_id` узла. На сервере это subject токена. */
  readonly owner: string;
  /** Команда: `team_id` узла. */
  readonly team: string;
  /** Агент: `agent_id` узла. */
  readonly agent: string;
}

/** Уровни в колонке `acl`. */
export const ACL_LEVELS = ["private", "team", "restricted", "agent"] as const;
export type AclLevel = (typeof ACL_LEVELS)[number];

/**
 * Предикат видимости узла для смотрящего. Три параметра подряд, начиная с
 * `first`: владелец, команда, агент.
 *
 * `restricted` проверяется подзапросом по `acl_grants` — там принципал
 * записан строкой вида `user:<id>` / `team:<id>` / `agent:<id>`, и совпасть
 * должен хотя бы один из трёх.
 *
 * Пустая строка в поле смотрящего НЕ совпадает с пустой строкой в узле: узел
 * без владельца не становится «своим» для того, у кого владельца тоже нет.
 * Иначе первый же узел, созданный без owner_id, стал бы виден всем как
 * приватный «ничей» — то есть тихо утёк.
 */
export function aclPredicate(alias: string, first: number): string {
  const owner = `?${first}`;
  const team = `?${first + 1}`;
  const agent = `?${first + 2}`;
  return `(
      ${alias}.acl = 'team' AND (${team} <> '' AND ${alias}.team_id = ${team} OR ${alias}.team_id = '')
   OR ${alias}.acl = 'private' AND ${owner} <> '' AND ${alias}.owner_id = ${owner}
   OR ${alias}.acl = 'agent'   AND ${agent} <> '' AND ${alias}.agent_id = ${agent}
   OR ${alias}.acl = 'restricted' AND EXISTS (
        SELECT 1 FROM acl_grants g
         WHERE g.node_id = ${alias}.id
           AND (${owner} <> '' AND g.principal = 'user:' || ${owner}
             OR ${team}  <> '' AND g.principal = 'team:' || ${team}
             OR ${agent} <> '' AND g.principal = 'agent:' || ${agent}))
  )`;
}

/** Тот же предикат готовым хвостом WHERE. */
export function aclClause(alias: string, first: number): string {
  return `\n     AND ${aclPredicate(alias, first)}`;
}

/** Параметры предиката в том порядке, в каком он их ждёт. */
export function aclParams(v: Viewer): [string, string, string] {
  return [v.owner, v.team, v.agent];
}

/**
 * Видит ли смотрящий этот узел — зеркало предиката для JS. Нужен там, где
 * строка уже прочитана (проверка после записи, отладка расхождений), и как
 * страховка в тестах: если SQL и JS разойдутся, тест об этом скажет.
 */
export function visibleTo(
  node: {
    readonly acl?: string;
    readonly owner_id?: string;
    readonly team_id?: string;
    readonly agent_id?: string;
  },
  v: Viewer,
  grants: ReadonlySet<string> = new Set(),
): boolean {
  const acl = node.acl ?? "team";
  if (acl === "team") return (v.team !== "" && node.team_id === v.team) || (node.team_id ?? "") === "";
  if (acl === "private") return v.owner !== "" && node.owner_id === v.owner;
  if (acl === "agent") return v.agent !== "" && node.agent_id === v.agent;
  return (
    (v.owner !== "" && grants.has(`user:${v.owner}`)) ||
    (v.team !== "" && grants.has(`team:${v.team}`)) ||
    (v.agent !== "" && grants.has(`agent:${v.agent}`))
  );
}
