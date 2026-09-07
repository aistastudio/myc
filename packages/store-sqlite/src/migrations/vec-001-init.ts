import type { Migration } from "../migrate.ts";

/**
 * Векторная схема, версия 1. Отдельный набор миграций (решение S26,
 * ARCHITECTURE.md §10) со своей таблицей учёта schema_migrations_vec:
 * применяется только когда рантайм сообщил, что vec0 загружен.
 *
 * Форма таблицы — решение S27 и замеры приложения К
 * (docs/design/01a-ddl-validation.md).
 *
 * ИНВАРИАНТ НАБОРА: `sql` каждой векторной миграции содержит РОВНО ОДИН
 * оператор. bun:sqlite молча пропускает CREATE VIRTUAL TABLE с неизвестным
 * модулем внутри многооператорного Database.exec() (01a §7), а отдельный
 * оператор — бросает `no such module: vec0`. Проверено дословно; сверх этого
 * ./vec.ts после наката сверяет sqlite_master.
 */
const SQL = `-- Векторный индекс узлов (§8.1.6 + решение S27).
--
-- ФОРМА (S27, замеры приложения К docs/design/01a-ddl-validation.md):
--   int8[384] + distance_metric=cosine + partition key (scope, layer).
--   int8 против float32 на 100k: 6.62 мс против 117.75 мс (p50) — 18x,
--   и 39 МБ против 149 МБ на диске.
--
-- ФИЛЬТР ПО (scope, layer) ОБЯЗАТЕЛЕН В КАЖДОМ ЗАПРОСЕ. Это не рекомендация:
--   partition key + метаданные, скан всех 100k БЕЗ фильтра  — 29.95 мс
--   те же, С фильтром scope=? AND layer=? (~5k векторов)    —  1.46 мс
--   минимальная таблица без partition key, скан 100k        —  6.62 мс
-- То есть без фильтра partition key делает ХУЖЕ, чем его отсутствие (4.5x).
-- vec0 такой запрос принимает — он не падает, он просто медленный, поэтому
-- запрет обязан жить в слое запросов: KNN без (scope, layer) — ошибка, а не
-- медленный путь.
--
-- ВСТАВКА И MATCH — ТОЛЬКО ЧЕРЕЗ vec_int8(?). Сырой BLOB длиной, кратной 4,
-- vec0 трактует как float32 и отвергает дословно: 'Query vector for the
-- "embedding" column is expected to be of type int8, but a float32 vector was
-- provided.' Для квантизации на стороне SQL — vec_quantize_int8(?, 'unit').
--
-- scope/layer — partition key: префильтр внутри vec0 (aux-колонки '+scope'
-- для этого непригодны, KNN по ним запрещён движком — 01a §4).
-- kind/head — метаданные: фильтруются, но не режут партицию.
-- Заполняется ТОЛЬКО фоновым воркером embed; горячий путь записи не трогает.
-- L0 (message/session) в индекс не попадает — §5.1.
CREATE VIRTUAL TABLE nodes_vec USING vec0(
  node_rowid INTEGER PRIMARY KEY,
  scope      TEXT    partition key,
  layer      INTEGER partition key,
  kind       TEXT,
  head       INTEGER,
  embedding  int8[384] distance_metric=cosine
)`;

export const vecMigration001Init: Migration = {
  version: 1,
  name: "vec_init",
  sql: SQL,
  objects: ["nodes_vec"],
};
