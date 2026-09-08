export const SCHEMA_VERSION = 1;

export type NodeKind =
  | "task"
  | "note"
  | "doc"
  | "fragment"
  | "session"
  | "message"
  | "entity"
  | "anchor"
  | "skill";

export const NODE_KINDS: readonly NodeKind[] = [
  "task",
  "note",
  "doc",
  "fragment",
  "session",
  "message",
  "entity",
  "anchor",
  "skill",
] as const;

export type EdgeKind =
  | "blocks"
  | "parent"
  | "relates"
  | "duplicates"
  | "supersedes"
  | "replies_to"
  | "derived_from"
  | "mentions"
  | "touches"
  | "evidence"
  | "contradicts";

export const EDGE_KINDS: readonly EdgeKind[] = [
  "blocks",
  "parent",
  "relates",
  "duplicates",
  "supersedes",
  "replies_to",
  "derived_from",
  "mentions",
  "touches",
  "evidence",
  "contradicts",
] as const;

export type Layer = 0 | 1 | 2 | 3;

// Публичный API пакета. Подключается координатором при приёмке задач,
// чтобы параллельные агенты не дрались за этот файл.
export * from "./id.ts";
export * from "./sql.ts";
export * from "./oplog.ts";
export * from "./graph.ts";
export * from "./secrets.ts";
export * from "./memory.ts";
// Охват памяти (S58): сессия по умолчанию, проект по решению.
export * from "./reach.ts";
// Охват репозитория (S59): третья ось — к какой части экосистемы относится узел.
export * from "./repo.ts";
// Переезд узла между воркспейсами (R4): что едет вместе и что рвёт границу.
export * from "./move.ts";

// Кеш дайджестов (S4): одна таблица, инвалидация по oplog.seq, кросс-процессно.
export * from "./digest-cache.ts";

export * from "./absorb.ts";
// Сравнение версий (проверка обновлений): числами, не строками — «0.10.0»
// строкой меньше «0.9.0», и на этом ложное «обновлений нет» неотличимо от правды.
export * from "./semver.ts";
// Окружение для тестов, спавнящих настоящий процесс myc: реестр выключателей
// фоновых механизмов плюс сборщик белого списка (ловушка S51, сработала дважды).
export * from "./test-env.ts";
