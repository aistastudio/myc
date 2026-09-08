import type { SwarmMigration } from "./types.ts";

/**
 * Харнесс `codex` в CHECK схемы (задача memory-7vywv63wma61).
 *
 * `myc wire` ставил конфиг Codex с самого начала, а ростер о таком харнессе
 * не знал: `myc model add … --harness codex` отвергался и доменом, и CHECK
 * схемы. Домен чинится строкой в ../harness.ts; схему строкой не починить —
 * текст применённой миграции заморожен чек-суммой (schema.ts), и править
 * миграции 1 и 3 задним числом значит уронить каждую существующую базу с
 * `schema.checksum`. Поэтому CHECK расширяется единственным способом,
 * который есть у SQLite: таблица ПЕРЕСТРАИВАЕТСЯ.
 *
 * Почему перестраиваются ЧЕТЫРЕ таблицы, а не одна. Внешние ключи здесь —
 * барьеры (см. 002, 003, 006), и соединение держит PRAGMA foreign_keys=ON:
 * swarm_model_price и swarm_attempt ссылаются на swarm_model,
 * swarm_attempt_run — на swarm_attempt. Колонки harness у цены нет, но
 * ссылка есть, и переименование родителя уводит её за собой — значит
 * перестраивается и она. При включённых ключах `DROP TABLE` родителя выполняет
 * неявный DELETE и падает FOREIGN KEY constraint failed, если у ребёнка
 * есть строки (проверено; `PRAGMA defer_foreign_keys` не спасает —
 * счётчик отложенных нарушений не обнуляется появлением новой таблицы с
 * теми же строками). А `ALTER TABLE … RENAME` в SQLite 3.25+ ПЕРЕПИСЫВАЕТ
 * ссылки детей на новое имя — значит ребёнок, оставленный на месте, будет
 * смотреть на переименованную старую таблицу.
 *
 * Отсюда порядок, который единственный проходит:
 *
 *   1. четыре RENAME — старые уезжают в *_pre8, ссылки детей едут за ними;
 *   2. четыре CREATE — новые таблицы, ссылки уже между новыми;
 *   3. четыре INSERT от родителя к ребёнку — иначе немедленный FK-барьер;
 *   4. четыре DROP от ребёнка к родителю — у каждой сбрасываемой таблицы
 *      детей уже нет;
 *   5. три CREATE INDEX — индексы 4, 5 и 7 уезжали вместе со своими
 *      таблицами и погибли на DROP; без них выборка «рука × класс задачи»
 *      снова стала бы полным сканом, и никто бы этого не заметил.
 *
 * Всё это один накат внутри одной транзакции BEGIN IMMEDIATE (schema.ts),
 * поэтому половины состояния не бывает: либо все 19 операторов, либо ни
 * одного. Правило «один оператор на миграцию» здесь и держится буквально —
 * `sql` это МАССИВ операторов, по одному в элементе, и сторож
 * roster.test.ts проверяет каждый элемент отдельно.
 *
 * Данные переносятся `SELECT *`: форма старых таблиц заморожена
 * миграциями 1, 2, 3 и 6 и на момент этого наката совпадает с новой
 * колонка в колонку — новые DDL отличаются ровно списком в CHECK
 * (harness), а у цены не отличаются вовсе.
 */
const HARNESS_CHECK = "CHECK (harness IN ('claude','codex','opencode','kimi'))";

const SQL: readonly string[] = [
  `ALTER TABLE swarm_model RENAME TO swarm_model_pre8`,
  `ALTER TABLE swarm_model_price RENAME TO swarm_model_price_pre8`,
  `ALTER TABLE swarm_attempt RENAME TO swarm_attempt_pre8`,
  `ALTER TABLE swarm_attempt_run RENAME TO swarm_attempt_run_pre8`,

  `CREATE TABLE swarm_model (
  model_id        TEXT PRIMARY KEY,       -- "anthropic/claude-sonnet-5" — всегда с провайдером
  family          TEXT NOT NULL,          -- "claude-sonnet", "glm" — для наследования приоров между версиями
  version         TEXT NOT NULL DEFAULT '', -- "5" или "5.4", пустая строка = не указана
  parent_model_id TEXT,                   -- предыдущая версия семейства
  harness         TEXT NOT NULL ${HARNESS_CHECK},
  effort          TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high')),
  tokens_per_sec  REAL NOT NULL DEFAULT 60,
  strengths       TEXT NOT NULL DEFAULT '[]', -- JSON string[] классов задач, наполняет W11
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,       -- unix ms
  updated_at      INTEGER NOT NULL        -- unix ms
)`,

  `CREATE TABLE swarm_model_price (
  model_id        TEXT NOT NULL REFERENCES swarm_model(model_id),
  valid_from      INTEGER NOT NULL,       -- unix ms, с какого момента цена действует
  usd_per_m_in    REAL NOT NULL CHECK (usd_per_m_in >= 0),  -- $ за 1M входных токенов
  usd_per_m_out   REAL NOT NULL CHECK (usd_per_m_out >= 0), -- $ за 1M выходных
  usd_per_m_cache_read  REAL NOT NULL DEFAULT 0,
  usd_per_m_cache_write REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, valid_from)
) WITHOUT ROWID`,

  `CREATE TABLE swarm_attempt (
  attempt_id      TEXT PRIMARY KEY,       -- "att_" + 12 hex
  task_id         TEXT NOT NULL,          -- id узла задачи L1
  model_id        TEXT NOT NULL REFERENCES swarm_model(model_id),
  effort          TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high')),
  harness         TEXT NOT NULL ${HARNESS_CHECK},
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
)`,

  `CREATE TABLE swarm_attempt_run (
  attempt_id      TEXT PRIMARY KEY REFERENCES swarm_attempt(attempt_id),
  session_id      TEXT,                   -- uuid стенограммы харнесса
  session_source  TEXT NOT NULL DEFAULT 'none'
                  CHECK (session_source IN ('env','flag','search','none')),
  transcript_path TEXT,                   -- файл стенограммы, если известен точно
  dispatch_id     TEXT,                   -- ctx_* оркестратора
  dispatch_source TEXT NOT NULL DEFAULT 'none'
                  CHECK (dispatch_source IN ('env','flag','lookup','none')),
  run_id          TEXT,                   -- run_* оркестратора
  terminal        TEXT,                   -- term_*: ключ соединения с оркестратором
  pane_key        TEXT,                   -- <tab>:<leaf>, ключ к pid у оркестратора
  agent_pid       INTEGER,                -- pid процесса агента
  pid_source      TEXT NOT NULL DEFAULT 'none'
                  CHECK (pid_source IN ('env','flag','none')),
  harness_build   TEXT,                   -- версия харнесса, как он себя назвал
  proc_state      TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (proc_state IN ('running','exited','unknown')),
  proc_checked_at INTEGER,                -- когда последний раз смотрели на pid
  proc_exited_at  INTEGER,                -- когда впервые увидели, что pid мёртв
  git_head        TEXT,                   -- HEAD на момент старта: база для diff
  files_touched   TEXT,                   -- JSON string[] на finish
  recorded_at     INTEGER NOT NULL
)`,

  `INSERT INTO swarm_model SELECT * FROM swarm_model_pre8`,
  `INSERT INTO swarm_model_price SELECT * FROM swarm_model_price_pre8`,
  `INSERT INTO swarm_attempt SELECT * FROM swarm_attempt_pre8`,
  `INSERT INTO swarm_attempt_run SELECT * FROM swarm_attempt_run_pre8`,

  `DROP TABLE swarm_attempt_run_pre8`,
  `DROP TABLE swarm_attempt_pre8`,
  `DROP TABLE swarm_model_price_pre8`,
  `DROP TABLE swarm_model_pre8`,

  `CREATE INDEX swarm_attempt_task ON swarm_attempt (task_id, started_at DESC)`,
  `CREATE INDEX swarm_attempt_arm
  ON swarm_attempt (task_class, model_id, effort, finished_at)`,
  `CREATE INDEX swarm_attempt_run_session
  ON swarm_attempt_run (session_id)
  WHERE session_id IS NOT NULL`,
];

export const migration008HarnessCodex: SwarmMigration = {
  version: 8,
  name: "harness_codex",
  sql: SQL,
  objects: [
    "swarm_model",
    "swarm_model_price",
    "swarm_attempt",
    "swarm_attempt_run",
    "swarm_attempt_task",
    "swarm_attempt_arm",
    "swarm_attempt_run_session",
  ],
};
