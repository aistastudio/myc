/**
 * КАНДИДАТЫ НА ПОДТВЕРЖДЕНИЕ (§6.2 docs/design/03-interfaces-and-integration.md,
 * memory-7j8zgjnd0bjz).
 *
 * Хук сжатия (`myc absorb-session`, packages/cli/src/hooks/absorb-session.ts)
 * вытаскивает из стенограммы строки вида «решили|выбрали|потому что» и пишет
 * их заметками L2 с `attrs.state = 'pending_review'`, `salience = 0`,
 * `acl = private`. Это НЕ знание, а догадка эвристики по тексту, и §6.2
 * говорит прямо: кандидат в выдачу не попадает, пока его не подтвердит
 * дистилляция или человек.
 *
 * До этого модуля кандидата гасила только нулевая salience — то есть он
 * ранжировался ниже, но доезжал до recall, search, prime, MCP и счётчика
 * заметок statusline, и непроверенное «решение» уходило в контекст агента
 * наравне с записанным осознанно.
 *
 * ПОДТВЕРЖДЕНИЕ = СМЕНА СОСТОЯНИЯ. Фильтр отсекает ровно `state =
 * 'pending_review'`: любое другое значение (или отсутствие ключа) видно. Так
 * подтверждению не нужен второй признак — дистилляция или человек переписывают
 * `attrs.state` ({@link confirmAttrs}), и узел сразу виден лексике, а вектор и
 * классификацию absorb получает из очереди, как новая заметка
 * (memory-4c24exck23cw). Разбирает человек или агент командой `myc review`
 * (packages/cli/src/commands/review.ts: список, `confirm`, `reject`); та же
 * функция подтверждения стоит за явной записью того же факта — `myc remember`
 * с текстом кандидата попадает в ветку точного дубликата (remember.ts). Дистиллятор
 * (packages/distiller) пока заглушка. Отклонение — статус `retracted`
 * ({@link rejectAttrs}): из выдачи узел уходит по статусу
 * ({@link HIDDEN_STATUSES}), из «ждёт разбора» — тоже.
 *
 * ФИЛЬТР СТОИТ В SQL, ДО LIMIT — тот же принцип, что у ACL (§2.2) и охвата
 * S58: постфильтр в JS после LIMIT отдал бы окно скана кандидатам, и обычная
 * заметка не доезжала бы до выдачи вовсе — это отказ, а не медленный запрос.
 *
 * ЦЕНА. Колонки у признака нет — он в `attrs`, как охват S58/S59, и по той же
 * причине (колонку пришлось бы тащить через оплог, репликацию и импорт). И она
 * не нужна: на всех путях выдачи строка узла к моменту проверки уже прочитана
 * (у recall — ради ACL, scope и layer, у prime — ради title/excerpt), и терм
 * добавляет только разбор короткого `attrs`. Замер на 100k узлов, тот же текст
 * запроса со снятым термом как соперник, чередуясь:
 *
 *   лексический проход гибрида, частый терм (~8k совпадений) — ×1.04
 *   он же, откат на ИЛИ трёх терминов                          — ×1.04
 *   скан дайджеста prime (скан + счётчики охвата)              — ×1.08
 *
 * Сокращение через `instr(attrs, '"pending_review"')` (приём freshnessClockSql)
 * проверено и НЕ взято: ×1.00 против голого json_extract — разбор маленького
 * JSON не то место, где уходит время, а лишний терм — лишнее, что читать.
 * Фильтр до LIMIT и каждый путь выдачи — ./review.test.ts; сквозь CLI и
 * настоящий хук — packages/cli/src/commands/pending-review.test.ts; план и
 * цена в prime — packages/cli/src/commands/prime.pending-latency.test.ts.
 */

import type { JsonValue } from "@myc/core";

/** Ключ состояния в `attrs`. Одно место на систему — иначе SQL и JS разъедутся. */
export const REVIEW_STATE_KEY = "state";

/** Значение, которым хук сжатия помечает непроверенного кандидата. */
export const PENDING_REVIEW = "pending_review";

/** Значение после подтверждения. Выдача смотрит только на «не pending_review». */
export const CONFIRMED = "confirmed";

/**
 * Поля подтверждения — КТО и КОГДА (мс эпохи), тем же манером, что
 * `extracted_by`/`external_synced_at` у соседей по attrs. Оплог хранит актора
 * и HLC каждой записи и так, но ответ «почему этот кандидат теперь знание»
 * обязан читаться из самой строки, а не раскопками оплога (И2, §5.6: качество
 * пишется в строку узла). Дистилляция, когда появится, пишет сюда своё имя
 * (`distill:<модель>`, ср. `distilled_by` в §5.6).
 */
export const CONFIRMED_BY_KEY = "confirmed_by";
export const CONFIRMED_AT_KEY = "confirmed_at";

/** Патч attrs, превращающий кандидата в знание. */
export function confirmAttrs(by: string, at: number): Record<string, JsonValue> {
  return { [REVIEW_STATE_KEY]: CONFIRMED, [CONFIRMED_BY_KEY]: by, [CONFIRMED_AT_KEY]: at };
}

/**
 * salience подтверждённого кандидата — умолчание колонки `nodes.salience`
 * (1.0, packages/store-sqlite/src/migrations/001-init.ts), то есть ровно та,
 * с которой рождается новая заметка `myc remember`. Хук пишет кандидата с 0 —
 * «это не факт»; оставь её после подтверждения, и prime (скан по salience
 * DESC, в DECISIONS три строки) ставил бы подтверждённое решение последним
 * среди L2, то есть практически никогда не показывал.
 */
export const CONFIRMED_SALIENCE = 1;

/**
 * ОТКЛОНЕНИЕ — статус `retracted` плюс кто, когда и почему в attrs. Состояние
 * `pending_review` при этом НЕ меняется, и это намеренно: скрывает узел
 * статус ({@link HIDDEN_STATUSES}), а если отклонение снимут (`myc update
 * <id> --status active`), узел вернётся в очередь разбора, а не в выдачу
 * знанием, которого никто не подтверждал. Причина — в строке узла, по тому
 * же правилу, что кто/когда у подтверждения.
 */
export const REJECTED_STATUS = "retracted";
export const REJECTED_BY_KEY = "rejected_by";
export const REJECTED_AT_KEY = "rejected_at";
export const REJECT_REASON_KEY = "reject_reason";

/** Патч attrs отклонения; статус ставится рядом, тем же updateNode. */
export function rejectAttrs(by: string, at: number, reason: string): Record<string, JsonValue> {
  return { [REJECTED_BY_KEY]: by, [REJECTED_AT_KEY]: at, [REJECT_REASON_KEY]: reason };
}

/** Кандидат ли узел — зеркало {@link notPendingPredicate} для JS. */
export function isPendingReview(
  attrs: Readonly<Record<string, JsonValue>> | Readonly<Record<string, unknown>> | undefined,
): boolean {
  return attrs?.[REVIEW_STATE_KEY] === PENDING_REVIEW;
}

// ---------------------------------------------------------------------------
// Статусы, которых нет в выдаче (memory-0p3d8n1efwtv)
// ---------------------------------------------------------------------------

/**
 * СТАТУСЫ, КОТОРЫЕ ВЫДАЧА СКРЫВАЕТ — одним списком на систему. Заменённая
 * версия (`superseded`), отозванная заметка (`retracted` — в том числе
 * отклонённый кандидат) и отменённая задача (`cancelled`) — не знание, которое
 * отдают агенту: recall, search, MCP, CORE/DECISIONS prime, цели absorb и
 * счётчик заметок строки статуса смотрят сюда, а не держат свою копию.
 *
 * До этого списка пути выдачи отсекали только `superseded` (hybrid, vector,
 * fts), дайджест prime статуса не смотрел вовсе, а строка статуса уже
 * считала `NOT IN ('retracted','superseded','cancelled')` — отозванная заметка
 * доезжала до recall и prime, а счётчик её не видел: поверхности расходились
 * ровно тем, что у каждой был свой литерал.
 *
 * `closed` сюда не входит: закрытая задача — история сделанного, её ищут.
 * `stale` у документа и `lost` у якоря — тоже: устаревшее не значит неверное.
 *
 * Терм стоит в SQL ДО LIMIT, как {@link notPendingPredicate}, и по той же
 * причине: сто отозванных с лучшим BM25 иначе забили бы окно скана, и живая
 * заметка не доехала бы вовсе. Цена нулевая сверх уже уплаченной: на каждом
 * пути строка узла к моменту проверки прочитана (ACL, attrs, title).
 */
export const HIDDEN_STATUSES: readonly string[] = Object.freeze(["superseded", "retracted", "cancelled"]);

/** Скрывает ли статус узел из выдачи — зеркало {@link liveStatusPredicate}. */
export function isHiddenStatus(status: string): boolean {
  return HIDDEN_STATUSES.includes(status);
}

const HIDDEN_STATUSES_SQL = HIDDEN_STATUSES.map((s) => `'${s}'`).join(",");

/** SQL-предикат «статус узла не из скрываемых». `alias` — псевдоним nodes. */
export function liveStatusPredicate(alias: string): string {
  return `(${alias}.status NOT IN (${HIDDEN_STATUSES_SQL}))`;
}

/**
 * Ждёт ли узел разбора — зеркало {@link awaitingReviewPredicate} для JS:
 * кандидат, которого ещё не отклонили (и не заменили).
 */
export function isAwaitingReview(
  attrs: Readonly<Record<string, JsonValue>> | Readonly<Record<string, unknown>> | undefined,
  status: string,
): boolean {
  return isPendingReview(attrs) && !isHiddenStatus(status);
}

/**
 * SQL-предикат «узел НЕ кандидат на подтверждение». `alias` — псевдоним
 * таблицы nodes в запросе. `IS NOT`, а не `<>`: у узла без ключа
 * `json_extract` даёт NULL, и `NULL <> '…'` отсёк бы всё, что состояния не
 * имеет, то есть почти всю базу.
 */
export function notPendingPredicate(alias: string): string {
  return `(json_extract(${alias}.attrs, '$.${REVIEW_STATE_KEY}') IS NOT '${PENDING_REVIEW}')`;
}

/** Тот же предикат готовым хвостом WHERE. */
export function notPendingClause(alias: string): string {
  return `\n        AND ${notPendingPredicate(alias)}`;
}

/**
 * Предикат «узел — кандидат, ещё ждущий разбора»: для счётчиков, которые
 * обязаны назвать скрытое числом (И2), и для списка `myc review`. Отклонённый
 * кандидат (`myc review reject`, статус `retracted`) разбор уже прошёл,
 * поэтому в «ждёт» не входит, хотя из выдачи по-прежнему исключён. Статусы —
 * тот же список {@link HIDDEN_STATUSES}, что у выдачи.
 */
export function awaitingReviewPredicate(alias: string): string {
  return (
    `(json_extract(${alias}.attrs, '$.${REVIEW_STATE_KEY}') = '${PENDING_REVIEW}'` +
    ` AND ${liveStatusPredicate(alias)})`
  );
}
