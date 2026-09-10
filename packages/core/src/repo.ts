/**
 * ОХВАТ РЕПОЗИТОРИЯ (решение S59): у узла есть репозиторий экосистемы, к
 * которому он относится. Задача, заведённая в `cherry/collector`, получает
 * охват `collector`; заведённая в корне — общий, и видна отовсюду.
 *
 * ТРЕТЬЯ ОСЬ, А НЕ ПЕРЕИСПОЛЬЗОВАНИЕ ДВУХ ПЕРВЫХ. Осей теперь три, и они
 * независимы:
 *
 *   ярус (S41)           — проектный `.myc/` против личного `~/.myc/`:
 *                          «про репозиторий или про меня». Физически это
 *                          РАЗНЫЕ базы, и различает их колонка `scope`
 *                          (слаг воркспейса), а не эта ось.
 *   охват сессии (S58)   — `attrs.reach`: «кому это нужно дальше», своей
 *                          крупной задаче или проекту целиком.
 *   охват репозитория    — `attrs.repo` (здесь): «к какой части экосистемы
 *   (S59)                  это относится».
 *
 * Соблазн свести их был, и он отклонён дважды:
 *
 *   — НЕ колонка `scope`. Она уже занята слагом воркспейса и стоит в
 *     `WHERE scope = ?` у prime, ready, list, absorb, bootstrap, embedd,
 *     import-beads и федерации ярусов (`scopes: [handle.scope]`). Записать
 *     туда имя репозитория значит слить ось яруса с осью репозитория: любой
 *     из этих запросов начал бы молча терять узлы чужого репозитория, а
 *     починка одной оси ломала бы другую.
 *   — НЕ поле `reach`. Охват сессии отвечает «нужно ли это в контексте
 *     ДРУГОЙ крупной задачи», охват репозитория — «про какой это код».
 *     Задача может быть проектной по S58 и при этом принадлежать одному
 *     репозиторию; сессионная заметка может быть про всю экосистему. Одно
 *     поле на два вопроса — это выбор, какой из двух признаков потерять.
 *
 * ГДЕ ХРАНИТСЯ. В `attrs` узла, как и охват S58, и по той же причине:
 * `attrs` уже едет через `createNode`/`updateNode` и оплог единым JSON, а
 * новая колонка потребовала бы протащить поле через слой запросов,
 * репликацию, импорт/экспорт и все `set`-операции. Скорость возвращает
 * индекс по выражению (миграция 007) — он подаёт `json_extract` прямо из
 * индекса, без похода в строку таблицы за отсеянными.
 *
 * ТРИ СОСТОЯНИЯ, А НЕ ДВА (И2). Ключа `repo` может не быть вовсе, и это НЕ
 * то же самое, что общий охват:
 *
 *   отсутствует  → «не определён»: узел старше решения S59 либо записан из
 *                  пути, который не принадлежит воркспейсу. Виден отовсюду
 *                  (молча уводить из контекста то, чей охват мы не знаем,
 *                  значит терять память старых баз) — но КАЖДАЯ выдача
 *                  обязана назвать его число.
 *   ""           → общий: узел про экосистему целиком. Виден отовсюду.
 *   "collector"  → узел этого репозитория. Виден без фильтра и под своим
 *                  фильтром; под фильтром чужого репозитория — нет.
 *
 * Разница между «не определён» и «общий» держится в SQL на `IS NULL` против
 * `= ''`: `coalesce(...,'')` склеил бы их и превратил невыведенный охват в
 * молчаливый общий — ровно та подмена, которую запрещает И2.
 */

import type { JsonValue } from "./oplog.ts";

/** Ключ в `attrs`. Одно место на всю систему — иначе SQL и JS разъедутся. */
export const REPO_KEY = "repo";

/** Значение фильтра «все репозитории» (`--repo all`). */
export const REPO_ALL = "all";

/**
 * Как охват репозитория попал в узел:
 *   recorded — записан при создании (в том числе пустым: «общий»);
 *   absent   — ключа нет: узел старше S59 либо путь вывести не удалось.
 */
export type RepoSource = "recorded" | "absent";

/** Прочитанное состояние охвата. */
export type RepoState = "repo" | "root" | "unknown";

export interface RepoInfo {
  /** Имя репозитория. Пусто у общего охвата и у неопределённого. */
  readonly repo: string;
  readonly state: RepoState;
  readonly by: RepoSource;
}

export const REPO_UNKNOWN: RepoInfo = { repo: "", state: "unknown", by: "absent" };
export const REPO_ROOT: RepoInfo = { repo: "", state: "root", by: "recorded" };

function str(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * Читает охват репозитория из `attrs`. Зеркало {@link repoPredicate}:
 * расхождение между разбором и SQL означало бы, что `ready` фильтрует по
 * одному правилу, а печатает по другому — покрыто таблицей истинности в
 * repo.test.ts.
 */
export function readRepo(attrs: Readonly<Record<string, JsonValue>> | undefined): RepoInfo {
  if (attrs === undefined) return REPO_UNKNOWN;
  const raw = attrs[REPO_KEY];
  // Ключа нет — охват не определён. Ключ есть и пуст — общий: это РАЗНЫЕ
  // новости, и склеивать их нельзя (И2).
  if (raw === undefined || raw === null) return REPO_UNKNOWN;
  const name = str(raw);
  if (name.length === 0) return REPO_ROOT;
  return { repo: name, state: "repo", by: "recorded" };
}

/** Пара полей `attrs` для записи охвата. Пустое имя — общий охват. */
export function repoAttrs(repo: string): Record<string, JsonValue> {
  return { [REPO_KEY]: repo };
}

/**
 * Виден ли узел под фильтром `target` (пустая строка — фильтра нет, видно
 * всё). Общий и неопределённый охваты видны всегда: первый — потому что он
 * про всю экосистему, второй — потому что прятать неизвестное значит терять
 * память старых баз (И2, то же правило, что у S58).
 */
export function visibleInRepo(info: RepoInfo, target: string): boolean {
  if (target.length === 0 || target === REPO_ALL) return true;
  if (info.state === "repo") return info.repo === target;
  return true;
}

/** Короткая метка охвата для плотной выдачи (`myc recall`). */
export function repoTag(info: RepoInfo): string {
  if (info.state === "root") return "all";
  if (info.state === "unknown") return "?";
  return info.repo;
}

// ---------------------------------------------------------------------------
// Вывод охвата из пути
// ---------------------------------------------------------------------------

/**
 * Почему охват вывести не удалось. Пустая строка — удалось.
 * Текст уходит в вывод команды дословно: И2 требует не только числа, но и
 * причины — «не определён» без причины неотличим от бага.
 */
export type RepoDeriveReason = "" | "no-workspace" | "outside-workspace";

export interface RepoDerivation {
  /** `undefined` — вывести не удалось; `""` — общий охват; иначе имя. */
  readonly repo: string | undefined;
  readonly reason: RepoDeriveReason;
  /** Каталог, по которому выводили: он и печатается в объяснении. */
  readonly from: string;
}

/** Человеческое объяснение неудачи — одно на CLI и на MCP. */
export function repoReasonText(d: RepoDerivation): string {
  if (d.reason === "no-workspace") return "workspace root unknown";
  if (d.reason === "outside-workspace") return `path outside the workspace: ${d.from}`;
  return "";
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0 && s !== ".");
}

/**
 * Выводит охват репозитория из пути, откуда запущена команда.
 *
 * Правила, по убыванию:
 *   1. корень воркспейса неизвестен            → не определён;
 *   2. путь вне воркспейса                     → не определён;
 *   3. путь = корень воркспейса                → общий;
 *   4. первый сегмент под корнем — репозиторий → его имя;
 *   5. иначе (обычный подкаталог корня)        → общий.
 *
 * Правило 4 спрашивает `isRepo` о ПЕРВОМ сегменте, а не о ближайшем предке с
 * `.git`: экосистема — это корень и его прямые дети-репозитории, а вложенный
 * `vendor/x/.git` внутри `collector` — часть `collector`, а не отдельный
 * репозиторий экосистемы. Ближайший предок дал бы охват `x`, которого в
 * экосистеме нет.
 *
 * Правило 5 — не угадывание: подкаталог корня (`docs/`, `packages/`) физически
 * принадлежит корневому репозиторию, то есть охват у него ОБЩИЙ, и это
 * определённый ответ, а не неудача вывода. Неудача — только правила 1 и 2,
 * когда о пути неизвестно вообще ничего.
 *
 * Функция чистая: ходить в файловую систему — забота вызывающего
 * (`isRepo`), иначе ядро потянуло бы за собой `node:fs` и стало бы
 * непроверяемым без временных каталогов.
 */
export function deriveRepo(
  wsDir: string | undefined,
  startDir: string,
  isRepo: (absolutePath: string) => boolean,
): RepoDerivation {
  const from = startDir;
  if (wsDir === undefined || wsDir.length === 0) {
    return { repo: undefined, reason: "no-workspace", from };
  }
  const ws = segments(wsDir);
  const start = segments(startDir);
  const wsAbsolute = wsDir.startsWith("/");
  const startAbsolute = startDir.startsWith("/");
  if (wsAbsolute !== startAbsolute || start.length < ws.length) {
    return { repo: undefined, reason: "outside-workspace", from };
  }
  for (let i = 0; i < ws.length; i++) {
    if (start[i] !== ws[i]) return { repo: undefined, reason: "outside-workspace", from };
  }
  const rest = start.slice(ws.length);
  if (rest.length === 0) return { repo: "", reason: "", from };
  const head = rest[0]!;
  const candidate = `${wsDir.replace(/\/+$/, "")}/${head}`;
  if (isRepo(candidate)) return { repo: head, reason: "", from };
  return { repo: "", reason: "", from };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Выражение охвата. Дословно повторяется колонкой индекса ix_nodes_ready_repo. */
export function repoExpr(alias: string): string {
  return `json_extract(${alias}.attrs,'$.${REPO_KEY}')`;
}

/**
 * SQL-предикат видимости под фильтром, дословно повторяющий
 * {@link visibleInRepo} и {@link readRepo}.
 *
 * `param` — номер плейсхолдера с именем репозитория ('' — фильтра нет).
 * Выражение `json_extract` обязано совпадать с колонкой индекса
 * ix_nodes_ready_repo (миграция 007) СИМВОЛ В СИМВОЛ — только тогда SQLite
 * подаёт его из индекса, а не из строки таблицы.
 *
 * `IS NULL` отдельной веткой, а не `coalesce(...,'')`: неопределённый охват
 * обязан оставаться отличимым от общего (И2). В ФИЛЬТРЕ они ведут себя
 * одинаково — оба видны, — но считаются и печатаются они по-разному, и
 * склейка здесь развалила бы счётчик в подвале.
 */
export function repoPredicate(alias: string, param: number): string {
  const repo = repoExpr(alias);
  return `(?${param} = '' OR ${repo} IS NULL OR ${repo} = '' OR ${repo} = ?${param})`;
}

/** Тот же предикат готовой строкой WHERE-хвоста. */
export function repoClause(alias: string, param: number): string {
  return `\n     AND ${repoPredicate(alias, param)}`;
}

/**
 * Предикат «охват репозитория не определён» — им считается то, что выдача
 * обязана назвать числом в подвале. Зеркало ветки `unknown` в
 * {@link readRepo}.
 */
export function unknownRepoPredicate(alias: string): string {
  return `${repoExpr(alias)} IS NULL`;
}

/** Колонка охвата для SELECT: тот же разбор, что {@link readRepo}, но из SQL. */
export function repoColumns(alias: string): string {
  return `${repoExpr(alias)} AS repo_raw`;
}

/** Разбор строки, выбранной через {@link repoColumns}. */
export function repoFromColumns(row: { repo_raw?: string | null }): RepoInfo {
  return readRepo(row.repo_raw == null ? {} : { [REPO_KEY]: row.repo_raw });
}

/** Счётчики охвата репозитория для громкого подвала. */
export interface RepoCounts {
  /** Узлы своего репозитория (или всех, если фильтра нет). */
  readonly own: number;
  /** Узлы с общим охватом. */
  readonly root: number;
  /** Узлы без записанного охвата. */
  readonly unknown: number;
  /** Отсеяно фильтром как принадлежащее чужому репозиторию. */
  readonly foreign: number;
}
