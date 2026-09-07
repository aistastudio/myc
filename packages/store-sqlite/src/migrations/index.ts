import type { Migration } from "../migrate.ts";
import { migration001Init } from "./001-init.ts";
import { migration002OplogPending } from "./002-oplog-pending.ts";
import { migration003CodeFiles } from "./003-code-files.ts";
import { migration004CodeDefs } from "./004-code-defs.ts";
import { migration005CodeRefs } from "./005-code-refs.ts";
import { migration006NodesReach } from "./006-nodes-reach.ts";
import { migration007NodesRepo } from "./007-nodes-repo.ts";
import { migration008DigestCache } from "./008-digest-cache.ts";
import { migration009NodesExternalId } from "./009-nodes-external-id.ts";

/**
 * Базовый набор миграций SQLite. Версия 1 — вся схема §8.1 целиком,
 * версия 2 — очередь отложенных операций репликации (myc-qie.9),
 * версии 3–5 — таблицы код-интеллекта (S52, 05-code-intelligence.md §4.3),
 * версия 6 — индекс охвата памяти (S58, packages/core/src/reach.ts),
 * версия 7 — индекс охвата репозитория (S59, packages/core/src/repo.ts),
 * версия 8 — таблица кеша дайджестов (S4, packages/core/src/digest-cache.ts),
 * версия 9 — идентичность ввезённого узла по attrs.external_ref, а не по
 * содержимому (myc import-beads на данных cherry).
 * Векторные объекты сюда не входят намеренно (решение S26) — см. ./vec.ts.
 */
export const migrations: readonly Migration[] = [
  migration001Init,
  migration002OplogPending,
  migration003CodeFiles,
  migration004CodeDefs,
  migration005CodeRefs,
  migration006NodesReach,
  migration007NodesRepo,
  migration008DigestCache,
  migration009NodesExternalId,
];

export { migration001Init } from "./001-init.ts";
export { migration002OplogPending } from "./002-oplog-pending.ts";
export { migration003CodeFiles } from "./003-code-files.ts";
export { migration004CodeDefs } from "./004-code-defs.ts";
export { migration005CodeRefs } from "./005-code-refs.ts";
export { migration006NodesReach } from "./006-nodes-reach.ts";
export { migration007NodesRepo } from "./007-nodes-repo.ts";
export { migration008DigestCache } from "./008-digest-cache.ts";
export { migration009NodesExternalId } from "./009-nodes-external-id.ts";
export { vecMigration001Init } from "./vec-001-init.ts";
export {
  migrateVectors,
  vectorMigrations,
  VEC_MIGRATIONS_TABLE,
  VEC_DEGRADED_UNAVAILABLE,
  type VectorMigrateOptions,
  type VectorMigrateResult,
} from "./vec.ts";
