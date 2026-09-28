/**
 * ПРЕДИКАТЫ ЯКОРЕЙ: «жив ли код, на который смотрит знание».
 *
 * §7.3: знание, чей код потерян целиком, в контекст не попадает. Правило
 * читают и выдача, и дайджест `prime`, чей скан исполняет ещё и сервер, —
 * поэтому оно живёт в ядре, а `@myc/retrieval` его реэкспортирует.
 */

/**
 * «ВСЕ якоря знания потеряны» — строка `lost` таблицы §7.3: «вес × 0.2, не
 * попадает в prime». Скалярное выражение над узлом `alias`: 1 — якоря есть и
 * все `lost`; 0 — есть хоть один не `lost`; NULL — якорей нет. То же соединение,
 * что у {@link anchorStatesSql}, и тот же ответ, что у {@link anchorWeightOf}:
 * лучший якорь решает, поэтому «лучший — lost» и «все — lost» одно и то же, и
 * prime прячет ровно то, что поиск помечает `lost` (hybrid.anchor.test.ts
 * сверяет это на всех сочетаниях состояний).
 *
 * Только знание: у самого узла-якоря (L1) дороги в дайджест prime (L2/L3) нет.
 * Цена — поиск по первичному ключу `edges (src, 'touches')` плюс по ключу
 * `anchors.node_id` на каждого якоря, ~1 мкс на строку, поэтому ставить его
 * туда, где он считается на каждой строке большого скана, нельзя — см.
 * prime_digest_scan (packages/cli/src/commands/prime.ts).
 */
export function anchorsAllLostSql(alias: string): string {
  // `min(CASE … THEN 1 ELSE 0 END)`, а не `min(an.state = 'lost')`: логическое
  // выражение SQLite отдаёт числом и агрегирует, а Postgres агрегировать
  // boolean не умеет вовсе (там bool_and). Целое понимают обе базы — и это
  // один текст на два диалекта вместо двух расходящихся.
  return `(SELECT min(CASE WHEN an.state = 'lost' THEN 1 ELSE 0 END)
              FROM edges t JOIN anchors an ON an.node_id = t.dst
             WHERE t.src = ${alias}.id AND t.type = 'touches' AND t.deleted_at IS NULL)`;
}

/**
 * Предикат «знание НЕ из тех, чей код потерян целиком»: без якорей или с хоть
 * одним живым. Сравнение null-safe, а не `= 0`: у узла без якорей выражение —
 * NULL, и `= 0` отсекло бы почти всю базу. Написано `IS DISTINCT FROM`, а не
 * `IS NOT`: SQLite понимает обе формы (с 3.39, наш пол 3.50.4), Postgres —
 * только первую, и общий текст экономит целый оверрайд.
 */
export function anchorsAlivePredicate(alias: string): string {
  return `(${anchorsAllLostSql(alias)} IS DISTINCT FROM 1)`;
}

/**
 * Узлы, у которых есть хоть один `lost` якорь, — подзапрос для `id IN (…)`.
 * Счётчик скрытого идёт ОТ ПОТЕРЯННЫХ ЯКОРЕЙ по ix_anchors_check (state,
 * checked_at), а не от всех L2/L3: цена — число lost-якорей (~2–4 мкс на
 * якорь), а не размер памяти. Замер на 100k узлов (5000 видимых L2/L3, 2850
 * якорей, 493 lost): от якорей — 2.1 мс, от всех видимых узлов — 5.6 мс (по
 * ~1 мкс на строку, ×2.65 дороже). Нет ни одного lost — один спуск по индексу.
 */
export function lostAnchorOwnersSql(): string {
  return `SELECT t.src FROM anchors an INDEXED BY ix_anchors_check
              JOIN edges t INDEXED BY ix_edges_dst
                ON t.dst = an.node_id AND t.type = 'touches' AND t.deleted_at IS NULL
             WHERE an.state = 'lost'`;
}
