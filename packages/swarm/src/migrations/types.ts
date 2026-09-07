/**
 * Свой тип миграции, а не Migration из пакета store-sqlite: deps-check
 * (scripts/deps-check.ts) разрешает swarm зависеть только от @myc/core.
 * Форма сознательно повторяет основную — `objects` перечисляет имена,
 * которые обязаны появиться в sqlite_master после наката.
 */
export interface SwarmMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly objects: readonly string[];
}
