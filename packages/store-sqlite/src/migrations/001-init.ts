import type { Migration } from "../migrate.ts";

/**
 * Базовая схема myc, версия 1. Источник — db/schema.sqlite.sql, провалидированный
 * запуском против bun:sqlite (docs/design/01a-ddl-validation.md) и §8.1
 * docs/design/01-core-data-model.md.
 *
 * Три отличия от db/schema.sqlite.sql, каждое осознанное:
 *
 * 1. Нет блока PRAGMA. PRAGMA из §8.1.0 — per-connection, их выставляет
 *    openSqlite() при каждом открытии, а не миграция.
 * 2. Нет CREATE TABLE schema_migrations. Таблицу учёта заводит сам раннер
 *    (ensureMigrationsTable в ../migrate.ts) до наката первой миграции;
 *    её повторное создание здесь падало бы с "table already exists".
 *    Колонка by_version из db/schema.sqlite.sql в раннере отсутствует —
 *    источник истины по этой таблице ../migrate.ts, не DDL-файл.
 * 3. Нет объектов vec0. Решение S27 (ARCHITECTURE.md §10): векторные объекты
 *    вынесены в отдельный набор (./vec-001-init.ts) со своей таблицей учёта,
 *    потому что обычные миграции сверяются по checksum и обязаны быть
 *    детерминированными, а условное создание таблиц это ломает. Без расширения
 *    база полноценна — теряется только векторный поиск.
 *
 * Добавлено сверх §8.1: колонка nodes.excerpt (решение S5) — см. комментарий
 * в самом DDL.
 */
const SQL = `
-- ============================ 8.1.1 Метаданные =============================
CREATE TABLE myc_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) WITHOUT ROWID;
-- обязательные ключи: schema_version, site_id, id_prefix, id_len,
--                     embed_model, embed_dim, acl_enforced, created_at, myc_version

CREATE TABLE myc_health (
  component TEXT PRIMARY KEY,
  state     TEXT NOT NULL CHECK (state IN ('ok','degraded','down')),
  reason    TEXT NOT NULL DEFAULT '',
  since     INTEGER NOT NULL,
  detail    TEXT NOT NULL DEFAULT '{}'
) WITHOUT ROWID;

-- ============================ 8.1.2 Узлы ===================================
CREATE TABLE nodes (
  id            TEXT    PRIMARY KEY,
  kind          TEXT    NOT NULL,
  layer         INTEGER NOT NULL DEFAULT 1,
  scope         TEXT    NOT NULL DEFAULT '',
  title         TEXT    NOT NULL DEFAULT '',
  body          TEXT,
  body_cold     INTEGER NOT NULL DEFAULT 0,
  -- S5 (ARCHITECTURE.md §10): короткий текст узла для сборки выдачи.
  -- Пишется детерминированно из body в момент записи, не GENERATED: смысл
  -- колонки в том, чтобы первый проход ретривала собрал выдачу, НЕ читая body
  -- (виртуальная generated-колонка потребовала бы читать body на каждом чтении,
  -- то есть ровно то, чего колонка избегает). Это не anchors.crux — тот текст
  -- про код и живёт в другой таблице; одноимённость их бы склеила.
  excerpt       TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'active',
  priority      INTEGER NOT NULL DEFAULT 2,
  confidence    REAL    NOT NULL DEFAULT 1.0,
  salience      REAL    NOT NULL DEFAULT 1.0,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  open_blockers INTEGER NOT NULL DEFAULT 0,
  head_id       TEXT,
  content_hash  TEXT    NOT NULL,
  acl           TEXT    NOT NULL DEFAULT 'team',
  owner_id      TEXT    NOT NULL DEFAULT '',
  team_id       TEXT    NOT NULL DEFAULT '',
  agent_id      TEXT    NOT NULL DEFAULT '',
  assignee      TEXT    NOT NULL DEFAULT '',
  lease_holder  TEXT    NOT NULL DEFAULT '',
  lease_epoch   INTEGER NOT NULL DEFAULT 0,
  lease_expires INTEGER NOT NULL DEFAULT 0,
  actor         TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  accessed_at   INTEGER NOT NULL DEFAULT 0,
  due_at        INTEGER,
  closed_at     INTEGER,
  compacted_at  INTEGER,
  deleted_at    INTEGER,
  hlc           INTEGER NOT NULL DEFAULT 0,
  site_id       TEXT    NOT NULL DEFAULT '',
  attrs         TEXT    NOT NULL DEFAULT '{}',

  -- виртуальные generated-колонки под индексы per-kind (не занимают места)
  g_task_type   TEXT    GENERATED ALWAYS AS (json_extract(attrs,'$.type'))         VIRTUAL,
  g_topic       TEXT    GENERATED ALWAYS AS (json_extract(attrs,'$.topic'))        VIRTUAL,
  g_frag_type   TEXT    GENERATED ALWAYS AS (json_extract(attrs,'$.frag_type'))    VIRTUAL,
  g_session_id  TEXT    GENERATED ALWAYS AS (json_extract(attrs,'$.session_id'))   VIRTUAL,
  g_thread_root TEXT    GENERATED ALWAYS AS (json_extract(attrs,'$.thread_root'))  VIRTUAL,
  g_etype       TEXT    GENERATED ALWAYS AS (json_extract(attrs,'$.etype'))        VIRTUAL,
  g_scen_key    TEXT    GENERATED ALWAYS AS (json_extract(attrs,'$.scenario_key')) VIRTUAL,
  g_pinned      INTEGER GENERATED ALWAYS AS (coalesce(json_extract(attrs,'$.pinned'),0)) VIRTUAL,

  CHECK (kind IN ('task','note','doc','fragment','session','message','entity','anchor','skill')),
  CHECK (layer BETWEEN 0 AND 3),
  CHECK (priority BETWEEN 0 AND 3),
  CHECK (acl IN ('private','team','restricted','agent')),
  CHECK (confidence BETWEEN 0.0 AND 1.0),
  CHECK (length(excerpt) <= 300),
  CHECK (json_valid(attrs))
);

-- дедупликация: точный дубликат невозможен в пределах (scope, kind)
CREATE UNIQUE INDEX ux_nodes_content
    ON nodes(scope, kind, content_hash) WHERE deleted_at IS NULL;

-- ready-очередь: один скан частичного индекса. Предикаты WHERE этого индекса
-- обязаны дословно совпадать с WHERE запроса ready (query ready в слое запросов),
-- иначе планировщик молча уходит в SCAN — покрыто тестом на EXPLAIN QUERY PLAN.
CREATE INDEX ix_nodes_ready
    ON nodes(scope, priority, updated_at)
 WHERE kind='task' AND status='open' AND open_blockers=0 AND deleted_at IS NULL;

-- prime: L2+L3 по scope, по убыванию salience
CREATE INDEX ix_nodes_prime
    ON nodes(scope, layer, salience DESC)
 WHERE layer >= 2 AND head_id IS NULL AND deleted_at IS NULL;

CREATE INDEX ix_nodes_kind_upd  ON nodes(scope, kind, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_nodes_head      ON nodes(head_id)          WHERE head_id IS NOT NULL;
CREATE INDEX ix_nodes_assignee  ON nodes(assignee, status) WHERE assignee <> '';
CREATE INDEX ix_nodes_lease     ON nodes(lease_expires)    WHERE status='in_progress';
CREATE INDEX ix_nodes_decay     ON nodes(closed_at)        WHERE status IN ('closed','cancelled') AND compacted_at IS NULL;
CREATE INDEX ix_nodes_due       ON nodes(due_at)           WHERE due_at IS NOT NULL AND status IN ('open','in_progress');
CREATE INDEX ix_nodes_thread    ON nodes(g_thread_root, created_at)  WHERE kind='message';
CREATE INDEX ix_nodes_session   ON nodes(g_session_id, created_at)   WHERE kind='message';
CREATE INDEX ix_nodes_scen      ON nodes(scope, g_scen_key)          WHERE layer=2;
CREATE INDEX ix_nodes_etype     ON nodes(g_etype, title)             WHERE kind='entity';
-- ACL: покрывающие частичные индексы (см. §10)
CREATE INDEX ix_nodes_acl_team  ON nodes(team_id, scope, layer)  WHERE acl='team'      AND deleted_at IS NULL;
CREATE INDEX ix_nodes_acl_own   ON nodes(owner_id, scope, layer) WHERE acl='private'   AND deleted_at IS NULL;
CREATE INDEX ix_nodes_acl_agent ON nodes(agent_id, scope, layer) WHERE acl='agent'     AND deleted_at IS NULL;

-- ============================ 8.1.3 Рёбра ==================================
CREATE TABLE edges (
  src        TEXT    NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  dst        TEXT    NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  weight     REAL    NOT NULL DEFAULT 1.0,
  add_tag    TEXT    NOT NULL,                 -- op_id добавления (тег OR-Set)
  actor      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  hlc        INTEGER NOT NULL DEFAULT 0,
  site_id    TEXT    NOT NULL DEFAULT '',
  deleted_at INTEGER,
  attrs      TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (src, type, dst),
  CHECK (src <> dst),
  CHECK (type IN ('blocks','parent','relates','duplicates','supersedes',
                  'replies_to','derived_from','mentions','touches','evidence','contradicts')),
  CHECK (json_valid(attrs))
) WITHOUT ROWID;

CREATE INDEX ix_edges_dst  ON edges(dst, type) WHERE deleted_at IS NULL;
CREATE INDEX ix_edges_type ON edges(type, src) WHERE deleted_at IS NULL;

-- тумбстоуны OR-Set: удаление помнит, какие именно теги добавления оно отменяет
CREATE TABLE edge_tombstones (
  src TEXT NOT NULL, type TEXT NOT NULL, dst TEXT NOT NULL,
  tag TEXT NOT NULL, hlc INTEGER NOT NULL, site_id TEXT NOT NULL,
  PRIMARY KEY (src, type, dst, tag)
) WITHOUT ROWID;

-- материализованное замыкание только для parent
CREATE TABLE parent_closure (
  ancestor   TEXT NOT NULL,
  descendant TEXT NOT NULL,
  depth      INTEGER NOT NULL,
  PRIMARY KEY (ancestor, descendant)
) WITHOUT ROWID;
CREATE INDEX ix_pc_desc ON parent_closure(descendant, depth);

-- ============================ 8.1.4 Якоря ==================================
CREATE TABLE anchors (
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  repo_id    TEXT    NOT NULL,
  repo_root  TEXT    NOT NULL DEFAULT '',
  path       TEXT    NOT NULL,
  lang       TEXT    NOT NULL DEFAULT '',
  symbol     TEXT    NOT NULL DEFAULT '',
  span_start INTEGER NOT NULL,
  span_end   INTEGER NOT NULL,
  file_hash  TEXT    NOT NULL,
  span_hash  TEXT    NOT NULL,
  crux       TEXT    NOT NULL,
  crux_norm  TEXT    NOT NULL,
  fp         BLOB,
  state      TEXT    NOT NULL DEFAULT 'fresh',
  drift      REAL    NOT NULL DEFAULT 1.0,
  mtime_ms   INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  bound_at   INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,
  git_ref    TEXT    NOT NULL DEFAULT '',
  CHECK (state IN ('fresh','drifted','stale','lost')),
  CHECK (span_start >= 1 AND span_end >= span_start)
);
CREATE INDEX ix_anchors_file   ON anchors(repo_id, path, span_start);
CREATE INDEX ix_anchors_symbol ON anchors(repo_id, symbol) WHERE symbol <> '';
CREATE INDEX ix_anchors_check  ON anchors(state, checked_at);

-- ============================ 8.1.5 Полнотекст =============================
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  title, body, tags,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'",
  prefix = '2 3',
  content = '', contentless_delete = 1
);

CREATE TRIGGER trg_fts_ai AFTER INSERT ON nodes
WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO nodes_fts(rowid, title, body, tags) VALUES (
    new.rowid, new.title, coalesce(new.body,''),
    coalesce((SELECT group_concat(value,' ')
                FROM json_each(coalesce(json_extract(new.attrs,'$.tags'),'[]'))),''));
END;

CREATE TRIGGER trg_fts_ad AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE rowid = old.rowid;
END;

-- ВАЖНО: только UPDATE OF перечисленных колонок. accessed_at/salience/lease_*
-- меняются на порядок чаще и не должны перестраивать FTS-строку. excerpt в
-- список тоже не входит: он производная от body, а body здесь уже есть.
CREATE TRIGGER trg_fts_au AFTER UPDATE OF title, body, attrs, deleted_at ON nodes BEGIN
  DELETE FROM nodes_fts WHERE rowid = old.rowid;
  INSERT INTO nodes_fts(rowid, title, body, tags)
  SELECT new.rowid, new.title, coalesce(new.body,''),
         coalesce((SELECT group_concat(value,' ')
                     FROM json_each(coalesce(json_extract(new.attrs,'$.tags'),'[]'))),'')
   WHERE new.deleted_at IS NULL;
END;

-- ============================ 8.1.6 Векторы ================================
-- Векторных объектов в этой миграции НЕТ намеренно (решение S26): см.
-- ./vec-001-init.ts и ./vec.ts. Базовая схема о векторах не знает вовсе.

-- ============================ 8.1.7 Очередь фоновых работ ==================
CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,   -- embed|absorb|distill|anchor_check|compact|rescore|export|sync
  entity_id     TEXT,
  scope         TEXT    NOT NULL DEFAULT '',
  priority      INTEGER NOT NULL DEFAULT 5,
  run_after     INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  lease_holder  TEXT    NOT NULL DEFAULT '',
  lease_expires INTEGER NOT NULL DEFAULT 0,
  payload       TEXT    NOT NULL DEFAULT '{}',
  last_error    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX  ix_jobs_pull ON jobs(kind, priority, run_after, lease_expires);
CREATE UNIQUE INDEX ux_jobs_dedup ON jobs(kind, entity_id) WHERE entity_id IS NOT NULL;

-- ============================ 8.1.8 Холодные тела ==========================
CREATE TABLE bodies_cold (
  node_id     TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  algo        TEXT    NOT NULL DEFAULT 'zstd',
  level       INTEGER NOT NULL DEFAULT 6,
  raw_len     INTEGER NOT NULL,
  blob        BLOB    NOT NULL,
  archived_at INTEGER NOT NULL
);
CREATE INDEX ix_cold_age ON bodies_cold(archived_at);

-- ============================ 8.1.9 ACL ====================================
CREATE TABLE acl_grants (
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  principal  TEXT NOT NULL,                -- user:<id> | team:<id> | agent:<id>
  level      TEXT NOT NULL DEFAULT 'read', -- read | write
  granted_by TEXT NOT NULL DEFAULT '',
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, principal),
  CHECK (level IN ('read','write'))
) WITHOUT ROWID;
CREATE INDEX ix_acl_principal ON acl_grants(principal, node_id);

-- ============================ 8.1.10 Репликация ============================
CREATE TABLE oplog (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id     TEXT    NOT NULL UNIQUE,        -- <site_id>:<hlc> — глобально уникален
  site_id   TEXT    NOT NULL,
  hlc       INTEGER NOT NULL,               -- (ms << 16) | counter
  ts_ms     INTEGER NOT NULL,
  actor     TEXT    NOT NULL DEFAULT '',
  op        TEXT    NOT NULL,               -- set|inc|edge_add|edge_del|claim|purge
  entity    TEXT    NOT NULL,               -- node|edge|anchor
  entity_id TEXT    NOT NULL,               -- id узла или "src|type|dst"
  field     TEXT,
  value     TEXT,                           -- JSON-скаляр или объект
  scope     TEXT    NOT NULL DEFAULT '',
  origin    INTEGER NOT NULL DEFAULT 1,     -- 1 локальная, 0 реплицированная
  CHECK (op IN ('set','inc','edge_add','edge_del','claim','purge'))
);
CREATE INDEX ix_oplog_site   ON oplog(site_id, hlc);
CREATE INDEX ix_oplog_entity ON oplog(entity_id, hlc);
CREATE INDEX ix_oplog_scope  ON oplog(scope, seq);

-- часы последней записи по каждому полю — основа per-field LWW
CREATE TABLE field_clock (
  entity_id TEXT NOT NULL,
  field     TEXT NOT NULL,
  hlc       INTEGER NOT NULL,
  site_id   TEXT NOT NULL,
  PRIMARY KEY (entity_id, field)
) WITHOUT ROWID;

-- G-counter: значение поля = SUM(value) по всем сайтам
CREATE TABLE counters (
  entity_id TEXT NOT NULL,
  field     TEXT NOT NULL,
  site_id   TEXT NOT NULL,
  value     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, field, site_id)
) WITHOUT ROWID;

CREATE TABLE sync_state (
  peer_site_id  TEXT PRIMARY KEY,
  last_hlc_seen INTEGER NOT NULL DEFAULT 0,   -- высшая вода принятого от пира
  last_seq_sent INTEGER NOT NULL DEFAULT 0,   -- наш seq, который пир подтвердил
  last_sync_at  INTEGER NOT NULL DEFAULT 0,
  endpoint      TEXT    NOT NULL DEFAULT ''
) WITHOUT ROWID;

-- ============================ 8.1.11 Триггеры счётчика блокеров ============
CREATE TRIGGER trg_blk_ins AFTER INSERT ON edges
WHEN new.type='blocks' AND new.deleted_at IS NULL
 AND (SELECT status FROM nodes WHERE id=new.src)
       NOT IN ('closed','cancelled','superseded','retracted')
BEGIN
  UPDATE nodes SET open_blockers = open_blockers + 1 WHERE id = new.dst;
END;

CREATE TRIGGER trg_blk_del AFTER UPDATE OF deleted_at ON edges
WHEN new.type='blocks' AND old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
 AND (SELECT status FROM nodes WHERE id=new.src)
       NOT IN ('closed','cancelled','superseded','retracted')
BEGIN
  UPDATE nodes SET open_blockers = max(0, open_blockers - 1) WHERE id = new.dst;
END;

-- ПРАВКА (01a, п.2): в спеке §8.1.11 нет триггера на восстановление мягко
-- удалённого ребра (deleted_at: NOT NULL -> NULL) — счётчик open_blockers
-- расходился с пересчётом (сценарий add-softdel-restore давал 0 против 1).
-- Этот триггер закрывает дыру; проверено 1000 случайных мутаций.
CREATE TRIGGER trg_blk_res AFTER UPDATE OF deleted_at ON edges
WHEN new.type='blocks' AND old.deleted_at IS NOT NULL AND new.deleted_at IS NULL
 AND (SELECT status FROM nodes WHERE id=new.src)
       NOT IN ('closed','cancelled','superseded','retracted')
BEGIN
  UPDATE nodes SET open_blockers = open_blockers + 1 WHERE id = new.dst;
END;

-- ВНИМАНИЕ (01a, п.2): жёсткий DELETE ребра (в т.ч. ON DELETE CASCADE при
-- purge узла) триггерами не покрыт by design (модель — мягкие удаления,
-- OR-Set). После любого физического удаления рёбер/узлов счётчики надо
-- пересчитать: UPDATE nodes SET open_blockers =
--   (SELECT count(*) FROM edges e JOIN nodes s ON s.id=e.src
--     WHERE e.dst=nodes.id AND e.type='blocks' AND e.deleted_at IS NULL
--       AND s.status NOT IN ('closed','cancelled','superseded','retracted'));

CREATE TRIGGER trg_st_close AFTER UPDATE OF status ON nodes
WHEN old.status NOT IN ('closed','cancelled','superseded','retracted')
 AND new.status     IN ('closed','cancelled','superseded','retracted')
BEGIN
  UPDATE nodes SET open_blockers = max(0, open_blockers - 1)
   WHERE id IN (SELECT dst FROM edges
                 WHERE src=new.id AND type='blocks' AND deleted_at IS NULL);
END;

CREATE TRIGGER trg_st_reopen AFTER UPDATE OF status ON nodes
WHEN old.status     IN ('closed','cancelled','superseded','retracted')
 AND new.status NOT IN ('closed','cancelled','superseded','retracted')
BEGIN
  UPDATE nodes SET open_blockers = open_blockers + 1
   WHERE id IN (SELECT dst FROM edges
                 WHERE src=new.id AND type='blocks' AND deleted_at IS NULL);
END;
`;

/** Объекты, обязанные появиться в sqlite_master после наката версии 1. */
const OBJECTS = [
  // таблицы
  "myc_meta",
  "myc_health",
  "nodes",
  "edges",
  "edge_tombstones",
  "parent_closure",
  "anchors",
  "nodes_fts",
  "jobs",
  "bodies_cold",
  "acl_grants",
  "oplog",
  "field_clock",
  "counters",
  "sync_state",
  // индексы
  "ux_nodes_content",
  "ix_nodes_ready",
  "ix_nodes_prime",
  "ix_nodes_kind_upd",
  "ix_nodes_head",
  "ix_nodes_assignee",
  "ix_nodes_lease",
  "ix_nodes_decay",
  "ix_nodes_due",
  "ix_nodes_thread",
  "ix_nodes_session",
  "ix_nodes_scen",
  "ix_nodes_etype",
  "ix_nodes_acl_team",
  "ix_nodes_acl_own",
  "ix_nodes_acl_agent",
  "ix_edges_dst",
  "ix_edges_type",
  "ix_pc_desc",
  "ix_anchors_file",
  "ix_anchors_symbol",
  "ix_anchors_check",
  "ix_jobs_pull",
  "ux_jobs_dedup",
  "ix_cold_age",
  "ix_acl_principal",
  "ix_oplog_site",
  "ix_oplog_entity",
  "ix_oplog_scope",
  // триггеры
  "trg_fts_ai",
  "trg_fts_ad",
  "trg_fts_au",
  "trg_blk_ins",
  "trg_blk_del",
  "trg_blk_res",
  "trg_st_close",
  "trg_st_reopen",
] as const;

export const migration001Init: Migration = {
  version: 1,
  name: "init",
  sql: SQL,
  objects: OBJECTS,
};
