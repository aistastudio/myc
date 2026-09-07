import type { SwarmMigration } from "./types.ts";

/**
 * Цены моделей, версия 2. Цена — факт с датой, а не константа в записи
 * модели: она меняется и различается по провайдерам, поэтому хранится
 * история (model_id, valid_from), а «действующая» цена — строка с
 * max(valid_from) ≤ моменту спроса (§2.2: попытка считается по цене,
 * действовавшей на attempt.started_at). Без valid_from первичный ключ не
 * собирается — дата обязательна и на уровне схемы (NOT NULL), и на уровне
 * домена (RosterError usage.price).
 *
 * Устаревание считает читатель: PRICE_STALE_MS в ../roster.ts. Тест на
 * устаревание обязан покраснеть, если цену начнут хранить без даты.
 *
 * Один оператор на миграцию.
 */
const SQL = `CREATE TABLE swarm_model_price (
  model_id        TEXT NOT NULL REFERENCES swarm_model(model_id),
  valid_from      INTEGER NOT NULL,       -- unix ms, с какого момента цена действует
  usd_per_m_in    REAL NOT NULL CHECK (usd_per_m_in >= 0),  -- $ за 1M входных токенов
  usd_per_m_out   REAL NOT NULL CHECK (usd_per_m_out >= 0), -- $ за 1M выходных
  usd_per_m_cache_read  REAL NOT NULL DEFAULT 0,
  usd_per_m_cache_write REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, valid_from)
) WITHOUT ROWID`;

export const migration002SwarmModelPrice: SwarmMigration = {
  version: 2,
  name: "swarm_model_price",
  sql: SQL,
  objects: ["swarm_model_price"],
};
