import type { Migration } from "../migrate.ts";

/**
 * Схема, версия 6: индекс охвата памяти (решение S58, packages/core/src/reach.ts).
 *
 * Охват — «сессия» или «проект» — живёт в `attrs` узла, а не в колонке:
 * `attrs` уже едет через оплог одним JSON-значением, а новая колонка стоила
 * бы протаскивания поля через слой запросов, репликацию, импорт/экспорт и
 * каждую `set`-операцию. Цена такого хранения — `json_extract` на каждой
 * отсеиваемой строке, и вот её этот индекс и снимает.
 *
 * ПОЧЕМУ ИНДЕКС ПО ВЫРАЖЕНИЮ. `prime` обязан отсеять чужое сессионное ДО
 * `LIMIT` (иначе окно скана забивается чужим, и проектное знание не доезжает
 * до выдачи вовсе — это отказ, а не медленный запрос). Отсев по `attrs`
 * означал бы поход в строку таблицы за каждой отсеиваемой строкой. Индекс
 * несёт те же три выражения, что стоят в предикате `reachClause`, и SQLite
 * подаёт их прямо из индекса.
 *
 * Замер на 100 000 узлов, где 97 % L2/L3 принадлежат чужим сессиям
 * (worst case для фильтра): p50 фильтра по ix_nodes_prime — 1.77 мс,
 * по этому индексу — 0.375 мс при бюджете prime 30 мс. Без фильтра — 0.076 мс.
 *
 * Ключ и предикат ДОСЛОВНО повторяют ix_nodes_prime из миграции 001: тот же
 * (scope, layer, salience DESC) и тот же частичный WHERE. Расхождение хотя бы
 * в одном терме — и планировщик уходит в TEMP B-TREE по всем L2/L3 скоупа
 * (та же ловушка, что в комментарии primeOp в scripts/bench-latency.ts).
 * Выражения `json_extract` обязаны совпадать с `reachClause`/`reachColumns`
 * СИМВОЛ В СИМВОЛ — SQLite подставляет колонку индекса вместо выражения
 * только при точном совпадении дерева выражения.
 *
 * Старый ix_nodes_prime не удаляется: он короче на три колонки и остаётся
 * дешевле для запросов, которым охват не нужен.
 */
const SQL = `CREATE INDEX ix_nodes_prime_reach ON nodes(
  scope,
  layer,
  salience DESC,
  json_extract(attrs,'$.reach'),
  json_extract(attrs,'$.session_id'),
  json_extract(attrs,'$.episode_id')
) WHERE layer >= 2 AND head_id IS NULL AND deleted_at IS NULL`;

export const migration006NodesReach: Migration = {
  version: 6,
  name: "nodes-reach",
  sql: SQL,
  objects: ["ix_nodes_prime_reach"],
};
