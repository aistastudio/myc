import type { SwarmMigration } from "./types.ts";

/**
 * Попытка исполнения задачи, версия 3 (задача W11, атрибуция исполнения;
 * docs/design/04-swarm-learning-and-routing.md §2.2 «swarm_attempt»).
 * Одна строка = «агент взял задачу с моделью M и харнессом H и чем-то
 * кончил». Отличия от каркаса §2.2 продиктованы тем, что заполняется это
 * не телеметрией рантайма, а закрытием задачи координатором:
 *
 * - `model_id` REFERENCES swarm_model — БАРЬЕР, а не украшение. Модель в
 *   исходе обязана быть той же сущностью, что в `myc model`: соединение
 *   держит PRAGMA foreign_keys=ON, поэтому попытка с моделью мимо ростера
 *   не записывается даже прямым INSERT. Без этой связи «дешевле при равном
 *   результате» посчитать нечем: цена живёт в ростере.
 * - `verdict` + `caveats` вместо одного «успех/провал». Приёмка с
 *   оговорками — не успех: координатор доделал сам, тест не ловит мутации,
 *   находка агента не подтвердилась. Свести это к успеху — научить рой,
 *   что оговорки бесплатны, поэтому оговорки хранятся списком и входят в
 *   формулу качества (../attribution.ts, qualityOf).
 * - `quality` колонки НЕТ сознательно: качество — формула над verdict и
 *   caveats, её веса живут в коде и версионируются OUTCOME_VERSION, чтобы
 *   отчёт всегда мог сказать, по какой формуле считал (§2.3.1).
 * - `cost_usd` и `price_valid_from`, наоборот, ЗАМОРОЖЕНЫ на finish: цена —
 *   факт с датой, и правка прайса задним числом не имеет права менять
 *   стоимость уже закрытых попыток. `price_valid_from` называет строку
 *   swarm_model_price, по которой считали, — счёт можно перепроверить.
 * - `task_class` (intent:scope, ../taskclass.ts) денормализован в строку:
 *   это ключ, по которому задаётся вопрос «на каком классе задач».
 *
 * Один оператор на миграцию — сторож набора (store-sqlite/src/migrations/
 * schema.test.ts) краснит миграцию с несколькими операторами.
 */
const SQL = `CREATE TABLE swarm_attempt (
  attempt_id      TEXT PRIMARY KEY,       -- "att_" + 12 hex
  task_id         TEXT NOT NULL,          -- id узла задачи L1
  model_id        TEXT NOT NULL REFERENCES swarm_model(model_id),
  effort          TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high')),
  harness         TEXT NOT NULL CHECK (harness IN ('claude','opencode','kimi')),
  actor           TEXT NOT NULL DEFAULT '', -- кто исполнял: терминал/агент/человек
  task_class      TEXT NOT NULL,          -- intent:scope, ключ вопроса «на каком классе»
  class_source    TEXT NOT NULL DEFAULT 'derived'
                  CHECK (class_source IN ('derived','declared')),
  started_at      INTEGER NOT NULL,       -- unix ms
  finished_at     INTEGER,                -- NULL = попытка открыта
  verdict         TEXT CHECK (verdict IN ('accepted','rework','rejected')),
  caveats         TEXT NOT NULL DEFAULT '[]', -- JSON string[] оговорок приёмки
  retries         INTEGER NOT NULL DEFAULT 0, -- кругов доработки до приёмки
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL,                   -- заморожен на finish, не пересчитывается
  price_valid_from INTEGER,               -- строка swarm_model_price, по которой считали
  cost_basis      TEXT CHECK (cost_basis IN ('priced','no_price','no_tokens')),
  source          TEXT NOT NULL DEFAULT 'cli', -- cli | close | backfill
  note            TEXT
)`;

export const migration003SwarmAttempt: SwarmMigration = {
  version: 3,
  name: "swarm_attempt",
  sql: SQL,
  objects: ["swarm_attempt"],
};
