/**
 * Свой тип миграции, а не Migration из пакета store-sqlite: deps-check
 * (scripts/deps-check.ts) разрешает swarm зависеть только от @myc/core.
 * Форма сознательно повторяет основную — `objects` перечисляет имена,
 * которые обязаны появиться в sqlite_master после наката.
 */
export interface SwarmMigration {
  readonly version: number;
  readonly name: string;
  /**
   * Один оператор строкой — или МАССИВ операторов, когда одна логическая
   * правка схемы иначе не выражается: у SQLite нет ALTER TABLE DROP
   * CONSTRAINT, и расширение CHECK — это перестройка таблицы
   * (008-harness-codex.ts). Правило «один оператор» при этом не ослаблено,
   * а уточнено: один оператор на ЭЛЕМЕНТ, и roster.test.ts проверяет
   * каждый. Половинчатого наката не бывает — весь отстающий хвост
   * применяется в одной транзакции (../schema.ts).
   */
  readonly sql: string | readonly string[];
  readonly objects: readonly string[];
}

/** Операторы миграции в порядке применения. */
export function migrationStatements(m: SwarmMigration): readonly string[] {
  return typeof m.sql === "string" ? [m.sql] : m.sql;
}

/**
 * Текст, по которому считается чек-сумма. Для строковой миграции это сама
 * строка — байт в байт, как было до появления массивов: иначе каждая
 * существующая база встретила бы `schema.checksum` на ровном месте.
 */
export function migrationText(m: SwarmMigration): string {
  return typeof m.sql === "string" ? m.sql : m.sql.join(";\n");
}
