import type { Migration } from "../migrate.ts";

/**
 * Векторная схема, версия 4: учёт того, ЧЕМ уже проиндексирован узел.
 *
 * `content_hash` рядом с вектором — единственное, что позволяет индексатору
 * пропустить неизменённый узел, не считая эмбеддинг заново, и переиспользовать
 * чужой вектор при совпадении хеша (в том числе из другой ветки: хеш считается
 * от содержимого, а не от пути).
 *
 * Таблица появилась вместе с `myc reindex` и сначала создавалась прямо в
 * команде через CREATE TABLE IF NOT EXISTS. Это ошибка, и вот почему: объект
 * схемы, созданный в обход набора миграций, не виден ни версии схемы, ни
 * проверке паритета DDL между sqlite и postgres, ни db/schema.sqlite.sql —
 * то есть база молча расходится со своим описанием, и заметить это нечем.
 * Набор держит ровно один оператор на миграцию (см. vec-002-rerank-f32.ts).
 */
const SQL = `CREATE TABLE vec_embed_meta (
  node_id      TEXT    PRIMARY KEY,
  content_hash TEXT    NOT NULL,
  embedded_at  INTEGER NOT NULL
)`;

export const vecMigration004EmbedMeta: Migration = {
  version: 4,
  name: "vec_embed_meta",
  sql: SQL,
  objects: ["vec_embed_meta"],
};
