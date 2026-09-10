/**
 * ОХВАТ ПАМЯТИ (решение S58): у знания, пережившего сжатие контекста, есть
 * охват — «сессия» или «проект».
 *
 * Это ДРУГАЯ ось, чем ярусы S41 (проектный `.myc/` против личного `~/.myc/`).
 * Ярус отвечает «про репозиторий или про меня», охват — «нужно ли это в
 * контексте ДРУГОЙ крупной задачи». Одна сессия обычно равна одной крупной
 * задаче, и накопленное в чужой сессии — чистый шум в этой.
 *
 * Три правила, каждое — решение заказчика, а не вывод реализации:
 *
 * 1. ОХВАТ СЕССИОННЫЙ ПО УМОЛЧАНИЮ. Всё, что рождается из хука сжатия и из
 *    `myc remember`, принадлежит СВОЕЙ сессии. Проектным знание становится
 *    явным решением (`--reach project`) или подъёмом слоя — новый узел плюс
 *    ребро `derived_from`, механизм L0→L2/L3, который уже есть.
 *
 * 2. СЕССИОННАЯ ПАМЯТЬ НЕ ИСПАРЯЕТСЯ. Она остаётся вне контекста по
 *    умолчанию: не попадает в `prime` ЧУЖОЙ сессии, но находится явным
 *    поиском (`myc recall`) и живёт в оплоге. Возврат к тому, что было давно
 *    в сессии, случается регулярно, а восстановить удалённое нечем.
 *
 * 3. НЕОПРЕДЕЛЁННЫЙ ОХВАТ ВИДЕН, А НЕ УГАДАН (И2). Заказчик отдельно отверг
 *    вариант «пусть absorb решает сам по содержанию»: угадывание по тексту
 *    неотличимо от знания, а ошибка угадывания молча уводит знание из
 *    контекста. Поэтому третье состояние — `unknown` — существует явно,
 *    печатается в каждой выдаче и считается в `prime`.
 *
 * ГДЕ ХРАНИТСЯ. В `attrs` узла, не в отдельной колонке: `attrs` уже едет
 * через `createNode`/`updateNode` и оплог как единое JSON-значение, а новая
 * колонка потребовала бы протащить поле через слой запросов, репликацию,
 * импорт/экспорт и все `set`-операции — цена, несоразмерная одному признаку.
 * Скорость возвращает индекс по выражению (миграция 006): он подаёт
 * `json_extract` прямо из индекса, без похода в строку таблицы за отсеянными.
 *
 * ПРОИСХОЖДЕНИЕ ВМЕСТО ГАДАНИЯ. У узлов, записанных ДО этого решения, поля
 * `reach` нет. Один структурный признак у них всё же есть: кандидаты из хука
 * сжатия несут `attrs.episode_id` — они РОДИЛИСЬ в эпизоде, то есть в
 * сессии. Это не догадка о содержании, а факт о происхождении, и он читается
 * тем же выражением. Всё остальное старое — честно `unknown`.
 */

import type { JsonValue } from "./oplog.ts";

/** Записываемые значения охвата. */
export type Reach = "session" | "project";

/** Прочитанный охват: третье состояние — «определить не удалось». */
export type ReachState = Reach | "unknown";

export const REACH_VALUES: readonly Reach[] = ["session", "project"] as const;

/** Ключи в `attrs`. Одно место на всю систему — иначе SQL и JS разъедутся. */
export const REACH_KEY = "reach";
export const SESSION_KEY = "session_id";
/** Пишется хуком сжатия у кандидатов (см. hooks/absorb-session.ts). */
export const EPISODE_KEY = "episode_id";

/** Переменные окружения, из которых берётся личность сессии. */
export const SESSION_ENV_KEYS = [
  "MYC_SESSION_ID",
  "CLAUDE_SESSION_ID",
  // Claude Code 2.1.x кладёт личность сессии именно сюда (проверено на живом
  // окружении: CLAUDE_CODE_SESSION_ID есть, CLAUDE_SESSION_ID нет). Без этой
  // строки `myc remember`, набранный агентом в шелле сессии, писал охват
  // «неизвестно» — и заметка становилась видна всем сессиям сразу.
  "CLAUDE_CODE_SESSION_ID",
] as const;

/**
 * Как определён охват:
 *   recorded — записан явно при создании узла;
 *   episode  — выведен из происхождения (узел рождён в эпизоде сжатия);
 *   absent   — не определён (узел старше решения S58 либо сессия была
 *              неизвестна в момент записи).
 */
export type ReachSource = "recorded" | "episode" | "absent";

export interface ReachInfo {
  readonly reach: ReachState;
  /** Ключ сессии-владельца. Пусто у `project` и у `unknown`. */
  readonly session: string;
  readonly by: ReachSource;
}

export const REACH_UNKNOWN: ReachInfo = { reach: "unknown", session: "", by: "absent" };

/** Ключ сессии, выведенный из эпизода сжатия: у узлов до S58 своего нет. */
export function episodeSessionKey(episodeId: string): string {
  return `episode:${episodeId}`;
}

/**
 * UUID где угодно в строке. Claude Code называет стенограмму `<uuid>.jsonl`,
 * Codex — `rollout-<дата>-<uuid>.jsonl`; в обоих случаях uuid и есть личность
 * сессии.
 */
const SESSION_UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Ключ сессии, вычитанный ИЗ ПУТИ СТЕНОГРАММЫ.
 *
 * Зачем он есть. Хук сжатия получает `--session` от хоста, но не всякий хост
 * его кладёт, а без ключа охват выводился из ЭПИЗОДА — и вот тут ломалось
 * само обещание вехи: эпизод по своей природе новый на каждом сжатии, значит
 * и ключ новый, значит заметка, записанная до сжатия, после него оказывалась
 * в чужом охвате и `prime` её не отдавал.
 *
 * Стенограмма же — ровно наоборот. Хост пишет её в ОДИН файл на всю сессию и
 * при сжатии дописывает, а не заводит новый: на настоящей стенограмме этого
 * проекта (37 МБ, два сжатия внутри) `sessionId` во всех строках один и равен
 * basename файла. Поэтому uuid из имени — не догадка о содержании, а тот же
 * самый идентификатор, который хост кладёт в `payload.session_id`: `prime`
 * получает его флагом от SessionStart, хук — отсюда, и они СОВПАДАЮТ.
 *
 * Возвращает пустую строку, если uuid в имени нет (stdin, `-`, чужой формат):
 * выдумывать ключ из произвольного имени файла нельзя — два разных прогона с
 * файлом `transcript.jsonl` слились бы в одну сессию.
 */
export function sessionKeyFromTranscript(path: string | undefined): string {
  if (path === undefined) return "";
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed === "-" || trimmed === "stdin") return "";
  // origin у хука бывает вида `missing:/путь`: пути нет, ключа тоже.
  if (trimmed.startsWith("missing:")) return "";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  const m = SESSION_UUID_RE.exec(base);
  return m === null ? "" : m[0].toLowerCase();
}

function str(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * Читает охват узла из его `attrs`. Зеркало {@link reachClause}: расхождение
 * между этим разбором и SQL-предикатом означало бы, что `prime` фильтрует по
 * одному правилу, а печатает по другому — покрыто таблицей истинности в
 * reach.test.ts.
 */
export function readReach(attrs: Readonly<Record<string, JsonValue>> | undefined): ReachInfo {
  const raw = attrs === undefined ? "" : str(attrs[REACH_KEY]);
  if (raw === "project") return { reach: "project", session: "", by: "recorded" };
  if (raw === "session") {
    return { reach: "session", session: attrs === undefined ? "" : str(attrs[SESSION_KEY]), by: "recorded" };
  }
  const episode = attrs === undefined ? "" : str(attrs[EPISODE_KEY]);
  if (episode.length > 0) {
    return { reach: "session", session: episodeSessionKey(episode), by: "episode" };
  }
  return REACH_UNKNOWN;
}

/** Пара полей `attrs` для записи охвата. Сессия обязана быть непустой. */
export function reachAttrs(reach: Reach, session: string): Record<string, JsonValue> {
  if (reach === "project") return { [REACH_KEY]: "project" };
  if (session.length === 0) {
    throw new Error("reachAttrs: session reach requires a session key");
  }
  return { [REACH_KEY]: "session", [SESSION_KEY]: session };
}

/**
 * Личность текущей сессии. Пустая строка — «сессия неизвестна», и это НЕ
 * ошибка: `myc` живёт и вне хоста с сессиями. Но тогда охват записать не из
 * чего, и вызывающая сторона обязана сказать об этом громко (И2).
 */
export function resolveSession(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const direct = (explicit ?? "").trim();
  if (direct.length > 0) return direct;
  for (const key of SESSION_ENV_KEYS) {
    const v = (env[key] ?? "").trim();
    if (v.length > 0) return v;
  }
  return "";
}

/**
 * Видно ли знание в `prime` сессии `current` (пустая строка — сессия
 * неизвестна).
 *
 *   project  — видно всегда (оно про проект);
 *   session  — только в СВОЕЙ сессии; в чужой оно не исчезло, а лежит вне
 *              контекста и находится через `myc recall`;
 *   unknown  — видно, потому что молча уводить из контекста то, чей охват мы
 *              не знаем, значит терять память старых баз; зато `prime`
 *              обязан назвать их число.
 */
export function visibleInPrime(info: ReachInfo, current: string): boolean {
  if (info.reach === "session") return current.length > 0 && info.session === current;
  return true;
}

/** Короткая метка охвата для плотной выдачи (`myc recall`). */
export function reachTag(info: ReachInfo, current: string): string {
  if (info.reach === "project") return "prj";
  if (info.reach === "unknown") return "?";
  return current.length > 0 && info.session === current ? "ses" : "ses*";
}

/**
 * SQL-предикат видимости в `prime`, дословно повторяющий {@link visibleInPrime}
 * и {@link readReach}. Фильтр обязан стоять В ИСТОЧНИКЕ, до LIMIT: иначе окно
 * скана целиком заполняется чужим сессионным, и проектное знание не доезжает
 * до выдачи вовсе — отказ куда хуже медленного запроса.
 *
 * `param` — номер плейсхолдера с ключом текущей сессии ('' — неизвестна).
 * Выражения `json_extract` дословно совпадают с колонками индекса
 * ix_nodes_prime_reach (миграция 006) — только так SQLite подаёт их из
 * индекса, а не из строки таблицы (замер: 1.77 мс против 0.375 мс на 100k
 * узлов, где 97 % L2/L3 принадлежат чужим сессиям).
 */
export function reachPredicate(alias: string, param: number): string {
  const reach = `json_extract(${alias}.attrs,'$.${REACH_KEY}')`;
  const session = `json_extract(${alias}.attrs,'$.${SESSION_KEY}')`;
  const episode = `json_extract(${alias}.attrs,'$.${EPISODE_KEY}')`;
  return `(CASE coalesce(${reach}, '')
             WHEN 'project' THEN 1
             WHEN 'session' THEN (?${param} <> '' AND coalesce(${session}, '') = ?${param})
             ELSE (CASE WHEN coalesce(${episode}, '') <> ''
                        THEN (?${param} <> '' AND 'episode:' || ${episode} = ?${param})
                        ELSE 1 END)
           END)`;
}

/** Тот же предикат готовой строкой WHERE-хвоста. */
export function reachClause(alias: string, param: number): string {
  return `\n      AND ${reachPredicate(alias, param)}`;
}

/**
 * Предикат «охват не определён» — им считается то, что `prime` обязан назвать
 * числом в подвале. Зеркало ветки `absent` в {@link readReach}.
 */
export function unknownReachPredicate(alias: string): string {
  const reach = `json_extract(${alias}.attrs,'$.${REACH_KEY}')`;
  const episode = `json_extract(${alias}.attrs,'$.${EPISODE_KEY}')`;
  return `(coalesce(${reach}, '') NOT IN ('session','project') AND coalesce(${episode}, '') = '')`;
}

/** Колонки охвата для SELECT: тот же разбор, что {@link readReach}, но из SQL. */
export function reachColumns(alias: string): string {
  return (
    `json_extract(${alias}.attrs,'$.${REACH_KEY}') AS reach_raw, ` +
    `json_extract(${alias}.attrs,'$.${SESSION_KEY}') AS session_raw, ` +
    `json_extract(${alias}.attrs,'$.${EPISODE_KEY}') AS episode_raw`
  );
}

/** Разбор строки, выбранной через {@link reachColumns}. */
export function reachFromColumns(row: {
  reach_raw?: string | null;
  session_raw?: string | null;
  episode_raw?: string | null;
}): ReachInfo {
  return readReach({
    ...(row.reach_raw != null ? { [REACH_KEY]: row.reach_raw } : {}),
    ...(row.session_raw != null ? { [SESSION_KEY]: row.session_raw } : {}),
    ...(row.episode_raw != null ? { [EPISODE_KEY]: row.episode_raw } : {}),
  });
}

/** Счётчики охвата для громкого подвала `prime`. */
export interface ReachCounts {
  readonly project: number;
  readonly session: number;
  readonly unknown: number;
  /** Отсеяно фильтром как чужое сессионное. */
  readonly foreign: number;
}
