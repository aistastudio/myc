import type { SwarmMigration } from "./types.ts";

/**
 * Справочник моделей роя (docs/design/04-swarm-learning-and-routing.md §2.2),
 * версия 1. Отличия от каркаса §2.2 продиктованы задачей W10:
 *
 * - `harness` — чем модель запускается (claude|opencode|kimi). CHECK на
 *   уровне схемы: неизвестный харнесс обязан отвергаться даже мимо
 *   валидации приложения, записи-призраки недопустимы.
 * - `effort` — уровень рассуждений по умолчанию для руки (model_id, effort).
 * - `strengths` — JSON-массив классов задач, на которых модель хороша.
 *   Место под знание, которого пока нет: наполняет атрибуция (W11) по
 *   факту телеметрии, а не человек от руки.
 * - `active` — мягкое удаление. Запись никогда не стирается физически:
 *   на model_id ссылаются закрытые попытки и атрибуция, физический DELETE
 *   уничтожил бы историю.
 *
 * Цена здесь отсутствует сознательно: она — факт с датой и живёт в
 * swarm_model_price (миграция 2), иначе через месяц роутинг считал бы по
 * протухшей константе, и никто бы не заметил.
 *
 * Один оператор на миграцию — сторож набора (schema.test.ts) краснит
 * миграцию с несколькими операторами.
 */
const SQL = `CREATE TABLE swarm_model (
  model_id        TEXT PRIMARY KEY,       -- "anthropic/claude-sonnet-5" — всегда с провайдером
  family          TEXT NOT NULL,          -- "claude-sonnet", "glm" — для наследования приоров между версиями
  version         TEXT NOT NULL DEFAULT '', -- "5" или "5.4", пустая строка = не указана
  parent_model_id TEXT,                   -- предыдущая версия семейства
  harness         TEXT NOT NULL CHECK (harness IN ('claude','opencode','kimi')),
  effort          TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high')),
  tokens_per_sec  REAL NOT NULL DEFAULT 60,
  strengths       TEXT NOT NULL DEFAULT '[]', -- JSON string[] классов задач, наполняет W11
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,       -- unix ms
  updated_at      INTEGER NOT NULL        -- unix ms
)`;

export const migration001SwarmModel: SwarmMigration = {
  version: 1,
  name: "swarm_model",
  sql: SQL,
  objects: ["swarm_model"],
};
