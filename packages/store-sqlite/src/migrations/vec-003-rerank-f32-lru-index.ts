import type { Migration } from "../migrate.ts";

/**
 * Векторная схема, версия 3: индекс по accessed_at для дешёвого вытеснения
 * хвоста кеша vec_nodes_f32 (vec-002-rerank-f32.ts). Отдельная миграция, а не
 * второй оператор в vec-002: набор держит ровно один оператор на миграцию
 * (см. комментарий в vec-002-rerank-f32.ts и в ./vec.ts).
 *
 * Обработчик 'embed'-джоба, добавив/обновив строку, читает
 * `SELECT node_id FROM vec_nodes_f32 ORDER BY accessed_at ASC LIMIT ?` поверх
 * этого индекса, чтобы найти кандидатов на удаление, когда строк в кеше
 * становится больше потолка (10 000 — обоснование в vec-002-rerank-f32.ts).
 */
const SQL = `CREATE INDEX ix_vec_f32_accessed ON vec_nodes_f32 (accessed_at)`;

export const vecMigration003RerankF32LruIndex: Migration = {
  version: 3,
  name: "vec_rerank_f32_lru_index",
  sql: SQL,
  objects: ["ix_vec_f32_accessed"],
};
