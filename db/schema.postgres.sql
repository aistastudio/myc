-- =============================================================================
-- myc — схема PostgreSQL (M4, docs/design/01-core-data-model.md §8.2)
--
-- ЗАЧЕМ ОТДЕЛЬНЫЙ ДИАЛЕКТ. SQLite — это машина разработчика: один процесс,
-- один файл, синхронный драйвер и бюджеты в микросекундах. Postgres — сервер
-- команды (M4): много арендаторов, много проектов, сеть. Тексты запросов при
-- этом ОБЩИЕ (реестр `defineQueries`, §8.4): совпадение имён колонок здесь —
-- не косметика, а условие приёмки «тот же набор запросов даёт те же
-- результаты». Поэтому переведены типы и полнотекст, а имена — нет.
--
-- АРЕНДАТОР И ПРОЕКТ (решение memory-khj49brcr0q7). `tenant_id` — ведущая
-- колонка КАЖДОГО первичного и уникального ключа и каждого внешнего ключа. В
-- опенсорсе сервер обслуживает одного арендатора, и колонка стоит константой
-- по умолчанию; облако отличается только числом арендаторов в одной базе.
-- Задним числом такой ключ не добавить: идентификаторы узлов человекочитаемы
-- и несут слаг проекта (`cherry-xxxx`), а слаги у разных арендаторов
-- совпадут — двое клиентов заведут «cherry».
--
-- ПРОЕКТ — ЭТО `scope`, А НЕ НОВАЯ КОЛОНКА. В модели `scope` уже и есть
-- воркспейс (slug в myc_meta и nodes.scope — одно и то же значение: проверено
-- на живой базе). Заводить рядом `ws_id` значило бы держать два имени одного
-- поля и переписывать каждый запрос; S17 говорит «ws_id + RLS» про смысл, а
-- не про имя колонки.
--
-- ИЗОЛЯЦИЯ — RLS ПО АРЕНДАТОРУ, ПРОЕКТ — ОБЫЧНЫЙ ПРЕДИКАТ ЗАПРОСА. Политика
-- сравнивает `tenant_id` с `myc_tenant()`; сессия, не назвавшая арендатора,
-- не видит НИЧЕГО (current_setting(..., true) даёт NULL, сравнение с ним
-- ложно) и не может писать (NOT NULL + DEFAULT myc_tenant() даёт внятную
-- ошибку вместо тихой записи в чужие данные). Проект политикой не
-- ограничивается намеренно: федеративный recall читает НЕСКОЛЬКО проектов
-- одного арендатора одной сессией, и политика на один `scope` сломала бы его.
--
-- ЯКОРЬ НА СЕРВЕРЕ — ТОЛЬКО НА ЗАКОММИЧЕННОЕ (решение memory-6fv6xbbfcb9g).
-- У людей разные ветки и worktree, поэтому привязка к файлу рабочего дерева
-- вне машины мертва: `anchors.git_ref` здесь NOT NULL и непустой, то есть
-- сервер принимает якорь, у которого есть идентичность в истории репозитория.
-- Локальный SQLite это не ограничивает: там рабочее дерево и есть контекст.
--
-- ЧЕГО ЗДЕСЬ НЕТ. Учётных записей, тарифов, квот, админского API — S69-style
-- «ключи сейчас, механика потом»: их отсутствие ничего не ломает, а их
-- преждевременная форма ломала бы.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector >= 0.7 (halfvec, HNSW)
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- триграммы для ступени A absorb

-- ============================ 0. Арендатор ==================================

/**
 * Арендатор текущей сессии. `true` вторым аргументом — «нет значения, а не
 * ошибка»: сессия без `SET LOCAL myc.tenant` получает NULL, а не исключение,
 * и политика ниже не пускает её ни к одной строке. Ошибку она получит на
 * ЗАПИСИ — от NOT NULL, и это правильный момент: читать нечего молча,
 * а писать в неизвестного арендатора нельзя вовсе.
 *
 * NULLIF ЗДЕСЬ ОБЯЗАТЕЛЕН, И ЭТО ПОЙМАНО СМОКОМ. `current_setting(..., true)`
 * возвращает NULL только пока переменную НИ РАЗУ не устанавливали в сессии;
 * после `RESET myc.tenant` (и в пуле соединений это обычное дело) она даёт
 * ПУСТУЮ СТРОКУ. Без nullif такая сессия становится арендатором '' — пишет
 * строки, которые потом никому не видны, и читает чужие через политику,
 * сравнивающую '' с ''.
 */
CREATE OR REPLACE FUNCTION myc_tenant() RETURNS TEXT
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('myc.tenant', true), '') $$;

-- ============================ 8.1.1 Метаданные ==============================

CREATE TABLE myc_meta (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

/**
 * РЕЕСТР АРЕНДАТОРОВ — СЕРВЕРНЫЙ, без RLS и без колонки tenant_id: это не
 * данные арендатора, а список тех, кто есть. Он нужен админке: аккуратно
 * посчитать арендаторов, не обходя изоляцию, можно только зная их имена
 * заранее — дальше каждый счёт делается ПОД ЕГО арендатором, то есть через ту
 * же политику, что и боевой запрос. Альтернатива — роль с BYPASSRLS у
 * админки — означала бы, что изоляцию обходит ровно та поверхность, которая
 * про неё и рассказывает.
 */
CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

/**
 * ТОКЕНЫ ДОСТУПА — тоже серверные и тоже вне RLS, и по той же причине, что
 * реестр арендаторов: токен не принадлежит арендатору, он его НАЗНАЧАЕТ.
 * Проверка идёт до того, как известен арендатор, — политике здесь не на что
 * опереться.
 *
 * ХРАНИТСЯ ХЕШ, А НЕ ТОКЕН. Утёкшая копия базы не должна давать доступ:
 * `token_hash` — sha256 секрета, самого секрета нет нигде после выдачи. Это
 * не пароль человека, а 256 бит случайности, поэтому медленная функция (bcrypt
 * и родня) ничего не добавит — подбирать тут нечего.
 *
 * `subject` — кто это: имя разработчика или агента. Оно попадает в журнал
 * сервера вместо токена, чтобы «кто ходил» отвечалось без утечки секрета.
 */
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT,
  revoked_at   BIGINT,
  last_used_at BIGINT
);
CREATE UNIQUE INDEX ux_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX ix_api_tokens_tenant ON api_tokens(tenant_id, subject);

-- Учёт миграций — СЕРВЕРНЫЙ, без арендатора: схему накатывает администратор
-- базы, а не арендатор, и версия у неё одна на всех.
CREATE TABLE schema_migrations (
  version    BIGINT PRIMARY KEY,
  name       TEXT   NOT NULL,
  checksum   TEXT   NOT NULL,
  applied_at BIGINT NOT NULL,
  by_version TEXT   NOT NULL
);

CREATE TABLE schema_migrations_compat (
  version       BIGINT PRIMARY KEY,
  name          TEXT   NOT NULL,
  checksum      TEXT   NOT NULL,
  applied_at    BIGINT NOT NULL,
  readable_from BIGINT NOT NULL
);

CREATE TABLE myc_health (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  component TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('ok','degraded','down')),
  reason    TEXT NOT NULL DEFAULT '',
  since     BIGINT NOT NULL,
  detail    JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, component)
);

-- ============================ 8.1.2 Узлы ====================================

CREATE TABLE nodes (
  tenant_id     TEXT   NOT NULL DEFAULT myc_tenant(),
  id            TEXT   NOT NULL,
  kind          TEXT   NOT NULL,
  layer         SMALLINT NOT NULL DEFAULT 1,
  scope         TEXT   NOT NULL DEFAULT '',
  title         TEXT   NOT NULL DEFAULT '',
  body          TEXT,
  -- Числом, а не BOOLEAN: текст запроса общий с SQLite, где сравнение идёт
  -- с 0/1 (`body_cold = 0`). Один диалект не вправе менять условие другого.
  body_cold     SMALLINT NOT NULL DEFAULT 0,
  excerpt       TEXT   NOT NULL DEFAULT '',
  status        TEXT   NOT NULL DEFAULT 'active',
  priority      SMALLINT NOT NULL DEFAULT 2,
  confidence    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  salience      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  seen_count    BIGINT NOT NULL DEFAULT 1,
  open_blockers BIGINT NOT NULL DEFAULT 0,
  anc_blockers  BIGINT NOT NULL DEFAULT 0,
  head_id       TEXT,
  content_hash  TEXT   NOT NULL,
  ext_dup       TEXT   NOT NULL DEFAULT '',
  acl           TEXT   NOT NULL DEFAULT 'team',
  owner_id      TEXT   NOT NULL DEFAULT '',
  team_id       TEXT   NOT NULL DEFAULT '',
  agent_id      TEXT   NOT NULL DEFAULT '',
  assignee      TEXT   NOT NULL DEFAULT '',
  lease_holder  TEXT   NOT NULL DEFAULT '',
  lease_epoch   BIGINT NOT NULL DEFAULT 0,
  lease_expires BIGINT NOT NULL DEFAULT 0,
  actor         TEXT   NOT NULL DEFAULT '',
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  accessed_at   BIGINT NOT NULL DEFAULT 0,
  due_at        BIGINT,
  closed_at     BIGINT,
  compacted_at  BIGINT,
  deleted_at    BIGINT,
  hlc           BIGINT NOT NULL DEFAULT 0,
  site_id       TEXT   NOT NULL DEFAULT '',
  attrs         JSONB  NOT NULL DEFAULT '{}'::jsonb,
  -- Те же имена, что у generated-колонок SQLite: индексы и запросы общие.
  g_thread_root TEXT GENERATED ALWAYS AS (attrs->>'thread_root') STORED,
  g_session_id  TEXT GENERATED ALWAYS AS (attrs->>'session_id')  STORED,
  g_scen_key    TEXT GENERATED ALWAYS AS (attrs->>'scenario_key') STORED,
  g_etype       TEXT GENERATED ALWAYS AS (attrs->>'etype')       STORED,
  -- Полнотекст живёт в строке (в SQLite — отдельная таблица FTS5, §8.3).
  tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
        setweight(to_tsvector('simple', coalesce(body ,'')), 'B')
      ) STORED,
  -- halfvec, а не vector: половинная точность даёт вдвое меньший индекс при
  -- том же recall на 384 измерениях (задача memory-2xgh8mg2fs24).
  embedding halfvec(384),
  PRIMARY KEY (tenant_id, id),
  CHECK (layer BETWEEN 0 AND 3),
  CHECK (priority BETWEEN 0 AND 3),
  CHECK (acl IN ('private','team','restricted','agent'))
);

-- Идентичность узла: по СОДЕРЖИМОМУ для того, что myc завёл сам, и по ССЫЛКЕ
-- НА ИСТОЧНИК для ввезённого (миграции 9 и 13). Разрешитель ext_dup —
-- четвёртая колонка внешнего индекса, как в SQLite.
CREATE UNIQUE INDEX ux_nodes_content ON nodes(tenant_id, scope, kind, content_hash)
  WHERE deleted_at IS NULL AND (attrs->>'external_ref') IS NULL;
CREATE UNIQUE INDEX ux_nodes_external ON nodes(tenant_id, scope, kind, (attrs->>'external_ref'), ext_dup)
  WHERE deleted_at IS NULL AND (attrs->>'external_ref') IS NOT NULL;

CREATE INDEX ix_nodes_ready ON nodes(tenant_id, scope, priority, updated_at)
  WHERE kind='task' AND status='open' AND open_blockers=0 AND anc_blockers=0 AND deleted_at IS NULL;
CREATE INDEX ix_nodes_ready_repo ON nodes(tenant_id, scope, (attrs->>'repo'), priority, updated_at)
  WHERE kind='task' AND status='open' AND open_blockers=0 AND anc_blockers=0 AND deleted_at IS NULL;
CREATE INDEX ix_nodes_prime ON nodes(tenant_id, scope, layer, salience DESC)
  WHERE layer >= 2 AND head_id IS NULL AND deleted_at IS NULL;
CREATE INDEX ix_nodes_prime_reach ON nodes(
    tenant_id, scope, layer, salience DESC,
    (attrs->>'reach'), (attrs->>'session_id'), (attrs->>'episode_id'))
  WHERE layer >= 2 AND head_id IS NULL AND deleted_at IS NULL;
CREATE INDEX ix_nodes_kind_upd ON nodes(tenant_id, scope, kind, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_nodes_lease    ON nodes(tenant_id, lease_expires) WHERE status='in_progress';
CREATE INDEX ix_nodes_assignee ON nodes(tenant_id, assignee, status) WHERE assignee <> '';
CREATE INDEX ix_nodes_due      ON nodes(tenant_id, due_at) WHERE due_at IS NOT NULL AND status IN ('open','in_progress');
CREATE INDEX ix_nodes_decay    ON nodes(tenant_id, closed_at) WHERE status IN ('closed','cancelled') AND compacted_at IS NULL;
CREATE INDEX ix_nodes_head     ON nodes(tenant_id, head_id) WHERE head_id IS NOT NULL;
CREATE INDEX ix_nodes_thread   ON nodes(tenant_id, g_thread_root, created_at) WHERE kind='message';
CREATE INDEX ix_nodes_session  ON nodes(tenant_id, g_session_id, created_at)  WHERE kind='message';
CREATE INDEX ix_nodes_scen     ON nodes(tenant_id, scope, g_scen_key) WHERE layer=2;
CREATE INDEX ix_nodes_etype    ON nodes(tenant_id, g_etype, title) WHERE kind='entity';
CREATE INDEX ix_nodes_acl_team  ON nodes(tenant_id, team_id,  scope, layer) WHERE acl='team'    AND deleted_at IS NULL;
CREATE INDEX ix_nodes_acl_own   ON nodes(tenant_id, owner_id, scope, layer) WHERE acl='private' AND deleted_at IS NULL;
CREATE INDEX ix_nodes_acl_agent ON nodes(tenant_id, agent_id, scope, layer) WHERE acl='agent'   AND deleted_at IS NULL;

-- Полнотекст и вектор. GIN по tsv заменяет nodes_fts; HNSW по halfvec —
-- vec0. m и ef_construction из спеки задачи: 1–3 мс на 1M узлов, recall ~0.97.
CREATE INDEX ix_nodes_tsv   ON nodes USING gin(tsv);
CREATE INDEX ix_nodes_attrs ON nodes USING gin(attrs jsonb_path_ops);
CREATE INDEX ix_nodes_vec   ON nodes USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================ 8.1.3 Рёбра ===================================

CREATE TABLE edges (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  src        TEXT NOT NULL,
  type       TEXT NOT NULL,
  dst        TEXT NOT NULL,
  weight     DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  add_tag    TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  hlc        BIGINT NOT NULL DEFAULT 0,
  site_id    TEXT NOT NULL DEFAULT '',
  deleted_at BIGINT,
  attrs      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, src, type, dst),
  FOREIGN KEY (tenant_id, src) REFERENCES nodes(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, dst) REFERENCES nodes(tenant_id, id) ON DELETE CASCADE,
  CHECK (src <> dst)
);
CREATE INDEX ix_edges_dst  ON edges(tenant_id, dst, type) WHERE deleted_at IS NULL;
CREATE INDEX ix_edges_type ON edges(tenant_id, type, src) WHERE deleted_at IS NULL;

CREATE TABLE edge_tombstones (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  src     TEXT NOT NULL,
  type    TEXT NOT NULL,
  dst     TEXT NOT NULL,
  tag     TEXT NOT NULL,
  hlc     BIGINT NOT NULL,
  site_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, src, type, dst, tag)
);

CREATE TABLE parent_closure (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  ancestor   TEXT NOT NULL,
  descendant TEXT NOT NULL,
  depth      BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, ancestor, descendant)
);
CREATE INDEX ix_pc_desc ON parent_closure(tenant_id, descendant, depth);

-- ============================ 8.1.4 Якоря ===================================

CREATE TABLE anchors (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  node_id    TEXT NOT NULL,
  repo_id    TEXT NOT NULL,
  repo_root  TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL,
  lang       TEXT NOT NULL DEFAULT '',
  symbol     TEXT NOT NULL DEFAULT '',
  span_start BIGINT NOT NULL,
  span_end   BIGINT NOT NULL,
  file_hash  TEXT NOT NULL,
  span_hash  TEXT NOT NULL,
  crux       TEXT NOT NULL,
  crux_norm  TEXT NOT NULL,
  fp         BYTEA,
  state      TEXT NOT NULL DEFAULT 'fresh',
  drift      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  mtime_ms   BIGINT NOT NULL DEFAULT 0,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  bound_at   BIGINT NOT NULL,
  checked_at BIGINT NOT NULL DEFAULT 0,
  -- Идентичность в истории репозитория. На сервере она ОБЯЗАТЕЛЬНА (решение
  -- memory-6fv6xbbfcb9g): якорь на файл рабочего дерева у соседа с другой
  -- веткой мёртв по построению, и хранить его здесь незачем.
  git_ref    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, node_id),
  FOREIGN KEY (tenant_id, node_id) REFERENCES nodes(tenant_id, id) ON DELETE CASCADE,
  CHECK (state IN ('fresh','drifted','stale','lost')),
  CHECK (span_start >= 1 AND span_end >= span_start),
  CHECK (git_ref <> '')
);
CREATE INDEX ix_anchors_file   ON anchors(tenant_id, repo_id, path, span_start);
CREATE INDEX ix_anchors_symbol ON anchors(tenant_id, repo_id, symbol) WHERE symbol <> '';
CREATE INDEX ix_anchors_check  ON anchors(tenant_id, state, checked_at);

-- ============================ 8.1.5 Очередь работ ===========================

CREATE TABLE jobs (
  tenant_id     TEXT NOT NULL DEFAULT myc_tenant(),
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  kind          TEXT NOT NULL,
  entity_id     TEXT,
  scope         TEXT NOT NULL DEFAULT '',
  priority      BIGINT NOT NULL DEFAULT 5,
  run_after     BIGINT NOT NULL,
  attempts      BIGINT NOT NULL DEFAULT 0,
  max_attempts  BIGINT NOT NULL DEFAULT 5,
  lease_holder  TEXT NOT NULL DEFAULT '',
  lease_expires BIGINT NOT NULL DEFAULT 0,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error    TEXT,
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ix_jobs_pull ON jobs(tenant_id, kind, priority, run_after, lease_expires);
CREATE UNIQUE INDEX ux_jobs_dedup ON jobs(tenant_id, kind, entity_id) WHERE entity_id IS NOT NULL;

-- ============================ 8.1.6 Права ===================================

CREATE TABLE acl_grants (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  node_id    TEXT NOT NULL,
  principal  TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'read',
  granted_by TEXT NOT NULL DEFAULT '',
  granted_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, node_id, principal),
  FOREIGN KEY (tenant_id, node_id) REFERENCES nodes(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_acl_principal ON acl_grants(tenant_id, principal, node_id);

-- ============================ 8.1.7 Оплог и часы ============================

CREATE TABLE oplog (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  seq       BIGINT GENERATED ALWAYS AS IDENTITY,
  op_id     TEXT NOT NULL,
  site_id   TEXT NOT NULL,
  hlc       BIGINT NOT NULL,
  ts_ms     BIGINT NOT NULL,
  actor     TEXT NOT NULL DEFAULT '',
  op        TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field     TEXT,
  value     TEXT,
  scope     TEXT NOT NULL DEFAULT '',
  origin    SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, seq)
);
-- op_id уникален в пределах арендатора: сайт и его счётчик — часть значения.
CREATE UNIQUE INDEX ux_oplog_op ON oplog(tenant_id, op_id);
CREATE INDEX ix_oplog_entity ON oplog(tenant_id, entity_id, hlc);
CREATE INDEX ix_oplog_site   ON oplog(tenant_id, site_id, hlc);
CREATE INDEX ix_oplog_scope  ON oplog(tenant_id, scope, seq);

CREATE TABLE oplog_pending (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  op_id     TEXT NOT NULL,
  needs     TEXT NOT NULL,
  origin    SMALLINT NOT NULL DEFAULT 0,
  op        TEXT NOT NULL,
  parked_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, op_id)
);
CREATE INDEX ix_oplog_pending_needs ON oplog_pending(tenant_id, needs);

CREATE TABLE field_clock (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  entity_id TEXT NOT NULL,
  field     TEXT NOT NULL,
  hlc       BIGINT NOT NULL,
  site_id   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity_id, field)
);

CREATE TABLE counters (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  entity_id TEXT NOT NULL,
  field     TEXT NOT NULL,
  site_id   TEXT NOT NULL,
  value     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, entity_id, field, site_id)
);

CREATE TABLE sync_state (
  tenant_id     TEXT NOT NULL DEFAULT myc_tenant(),
  peer_site_id  TEXT NOT NULL,
  last_hlc_seen BIGINT NOT NULL DEFAULT 0,
  last_seq_sent BIGINT NOT NULL DEFAULT 0,
  last_sync_at  BIGINT NOT NULL DEFAULT 0,
  endpoint      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, peer_site_id)
);

-- ============================ 8.1.8 Холодные тела ===========================

CREATE TABLE bodies_cold (
  tenant_id   TEXT NOT NULL DEFAULT myc_tenant(),
  node_id     TEXT NOT NULL,
  algo        TEXT NOT NULL DEFAULT 'zstd',
  level       SMALLINT NOT NULL DEFAULT 6,
  raw_len     BIGINT NOT NULL,
  blob        BYTEA NOT NULL,
  archived_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, node_id),
  FOREIGN KEY (tenant_id, node_id) REFERENCES nodes(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_cold_age ON bodies_cold(tenant_id, archived_at);

CREATE TABLE digest_cache (
  tenant_id TEXT NOT NULL DEFAULT myc_tenant(),
  scope     TEXT NOT NULL,
  profile   TEXT NOT NULL,
  variant   TEXT NOT NULL DEFAULT '',
  seq       BIGINT NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, profile, variant)
);

-- ============================ 8.1.9 Код-интеллект ===========================

CREATE TABLE code_files (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  repo_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  lang       TEXT NOT NULL,
  mtime_ms   BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  file_hash  TEXT NOT NULL,
  indexed_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, repo_id, path)
);

CREATE TABLE code_defs (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  repo_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  span_start BIGINT NOT NULL,
  span_end   BIGINT NOT NULL,
  exported   SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, repo_id, path, name, span_start)
);

CREATE TABLE code_refs (
  tenant_id   TEXT NOT NULL DEFAULT myc_tenant(),
  repo_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  n_files     BIGINT NOT NULL,
  n_hits      BIGINT NOT NULL,
  computed_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, repo_id, name)
);

CREATE TABLE code_ref_sites (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  repo_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  line       BIGINT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  from_name  TEXT NOT NULL,
  from_start BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, repo_id, path, line, name, kind, from_start)
);
CREATE INDEX ix_code_ref_sites_name ON code_ref_sites(tenant_id, repo_id, name);

CREATE TABLE code_units (
  tenant_id  TEXT NOT NULL DEFAULT myc_tenant(),
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  repo_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  unit       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  span_start BIGINT NOT NULL,
  span_end   BIGINT NOT NULL,
  file_hash  TEXT NOT NULL,
  -- Корпус поиска по коду: в SQLite это FTS5 code_fts, здесь — колонка.
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(unit,''))) STORED,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ix_code_units_file ON code_units(tenant_id, repo_id, path);
CREATE INDEX ix_code_units_tsv  ON code_units USING gin(tsv);

-- ============================ 8.1.10 Триггеры ===============================
--
-- Та же логика, что у триггеров SQLite (§8.1), на PL/pgSQL. Триггеров
-- полнотекста здесь нет: `tsv` — generated-колонка, её ведёт сама база.

CREATE FUNCTION myc_blk_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'blocks' AND NEW.deleted_at IS NULL
     AND (SELECT status FROM nodes WHERE tenant_id = NEW.tenant_id AND id = NEW.src)
           NOT IN ('closed','cancelled','superseded','retracted') THEN
    UPDATE nodes SET open_blockers = open_blockers + 1
     WHERE tenant_id = NEW.tenant_id AND id = NEW.dst;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_blk_ins AFTER INSERT ON edges FOR EACH ROW EXECUTE FUNCTION myc_blk_ins();

CREATE FUNCTION myc_blk_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'blocks' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND (SELECT status FROM nodes WHERE tenant_id = NEW.tenant_id AND id = NEW.src)
           NOT IN ('closed','cancelled','superseded','retracted') THEN
    UPDATE nodes SET open_blockers = greatest(open_blockers - 1, 0)
     WHERE tenant_id = NEW.tenant_id AND id = NEW.dst;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_blk_del AFTER UPDATE OF deleted_at ON edges FOR EACH ROW EXECUTE FUNCTION myc_blk_del();

CREATE FUNCTION myc_blk_res() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'blocks' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
     AND (SELECT status FROM nodes WHERE tenant_id = NEW.tenant_id AND id = NEW.src)
           NOT IN ('closed','cancelled','superseded','retracted') THEN
    UPDATE nodes SET open_blockers = open_blockers + 1
     WHERE tenant_id = NEW.tenant_id AND id = NEW.dst;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_blk_res AFTER UPDATE OF deleted_at ON edges FOR EACH ROW EXECUTE FUNCTION myc_blk_res();

CREATE FUNCTION myc_st_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('closed','cancelled','superseded','retracted')
     AND NEW.status IN ('closed','cancelled','superseded','retracted') THEN
    UPDATE nodes SET open_blockers = greatest(open_blockers - 1, 0)
     WHERE tenant_id = NEW.tenant_id
       AND id IN (SELECT dst FROM edges
                   WHERE tenant_id = NEW.tenant_id AND src = NEW.id
                     AND type = 'blocks' AND deleted_at IS NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_st_close AFTER UPDATE OF status ON nodes FOR EACH ROW EXECUTE FUNCTION myc_st_close();

CREATE FUNCTION myc_st_reopen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('closed','cancelled','superseded','retracted')
     AND NEW.status NOT IN ('closed','cancelled','superseded','retracted') THEN
    UPDATE nodes SET open_blockers = open_blockers + 1
     WHERE tenant_id = NEW.tenant_id
       AND id IN (SELECT dst FROM edges
                   WHERE tenant_id = NEW.tenant_id AND src = NEW.id
                     AND type = 'blocks' AND deleted_at IS NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_st_reopen AFTER UPDATE OF status ON nodes FOR EACH ROW EXECUTE FUNCTION myc_st_reopen();

-- Наследование блокеров вниз по parent (миграция 10) и транзитивное замыкание
-- (parent_closure) — те же правила, что в SQLite; здесь они выражены через
-- рекурсивный CTE в одном месте, а не набором триггеров на каждую операцию.
CREATE FUNCTION myc_pc_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'parent' AND NEW.deleted_at IS NULL THEN
    INSERT INTO parent_closure (tenant_id, ancestor, descendant, depth)
    SELECT NEW.tenant_id, NEW.dst, NEW.src, 1
    ON CONFLICT DO NOTHING;
    INSERT INTO parent_closure (tenant_id, ancestor, descendant, depth)
    SELECT NEW.tenant_id, pc.ancestor, NEW.src, pc.depth + 1
      FROM parent_closure pc
     WHERE pc.tenant_id = NEW.tenant_id AND pc.descendant = NEW.dst
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_anc_pc_ins AFTER INSERT ON edges FOR EACH ROW EXECUTE FUNCTION myc_pc_ins();

CREATE FUNCTION myc_pc_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'parent' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    DELETE FROM parent_closure
     WHERE tenant_id = NEW.tenant_id AND descendant = NEW.src;
    INSERT INTO parent_closure (tenant_id, ancestor, descendant, depth)
    WITH RECURSIVE up(ancestor, depth) AS (
      SELECT e.dst, 1 FROM edges e
       WHERE e.tenant_id = NEW.tenant_id AND e.src = NEW.src
         AND e.type = 'parent' AND e.deleted_at IS NULL
      UNION ALL
      SELECT e.dst, up.depth + 1 FROM edges e JOIN up ON e.src = up.ancestor
       WHERE e.tenant_id = NEW.tenant_id AND e.type = 'parent' AND e.deleted_at IS NULL
    )
    SELECT NEW.tenant_id, ancestor, NEW.src, min(depth) FROM up GROUP BY ancestor
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_anc_pc_del AFTER UPDATE OF deleted_at ON edges FOR EACH ROW EXECUTE FUNCTION myc_pc_del();

-- ============================ 8.1.11 RLS ====================================
--
-- ENABLE плюс FORCE: без FORCE владелец таблицы (а это та же роль, под которой
-- ходит сервер) политику обходит, и изоляция становится декларацией. Политика
-- одна на все операции: `tenant_id = myc_tenant()`. Сессия без
-- `SET LOCAL myc.tenant` не видит ни строки и не пишет ни одной.
--
-- СУПЕРПОЛЬЗОВАТЕЛЬ RLS НЕ СОБЛЮДАЕТ — НИКАКОЙ. Ни ENABLE, ни FORCE на него не
-- действуют, и это не настройка, а устройство Postgres. Поэтому сервер обязан
-- ходить под ОБЫЧНОЙ ролью (роль ниже), а суперпользователь остаётся для
-- накатывания схемы. Поймано смоком: под `postgres` изоляции нет вовсе, и
-- проверка, написанная от суперпользователя, «доказывала» её впустую.
-- Идемпотентно: схему накатывают повторно (обновление, восстановление стенда),
-- и падать на существующей роли ей незачем.
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myc_app') THEN
    CREATE ROLE myc_app NOLOGIN;  -- LOGIN и пароль выдаёт развёртывание
  END IF;
END $role$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'myc_meta','myc_health','nodes','edges','edge_tombstones','parent_closure',
    'anchors','jobs','acl_grants','oplog','oplog_pending','field_clock',
    'counters','sync_state','bodies_cold','digest_cache',
    'code_files','code_defs','code_refs','code_ref_sites','code_units'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY myc_tenant_isolation ON %I USING (tenant_id = myc_tenant()) WITH CHECK (tenant_id = myc_tenant())',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO myc_app', t);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO myc_app;
-- Реестр арендаторов: сервер читает его для админки и ЗАВОДИТ арендаторов сам
-- (`myc serve --add-tenant`), потому что он же и есть инструмент развёртывания
-- — иначе в контейнер пришлось бы класть psql ради одной строки. Граница
-- доступа проходит не здесь, а по паролю этой роли: кто им владеет, тот и
-- администратор сервера (он и так может выдать токен любому арендатору).
-- Отдельная административная роль — следующий шаг, когда появится кто-то,
-- кому нужен доступ к данным, но не к управлению.
GRANT SELECT, INSERT ON tenants TO myc_app;
-- Версию схемы приложение обязано видеть: по ней оно решает, своя ли это база
-- (та же проверка, что у CLI при открытии). Писать в журналы учёта нельзя.
GRANT SELECT ON schema_migrations, schema_migrations_compat TO myc_app;
-- Токены сервер читает на каждом запросе, помечает временем последнего
-- использования и заводит по команде администратора (`myc serve --add-token`).
GRANT SELECT, INSERT, UPDATE ON api_tokens TO myc_app;
-- Последовательности идентичности (jobs.id, oplog.seq, code_units.id).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO myc_app;

-- ═══ БАЗОВАЯ СТРОКА УЧЁТА ═════════════════════════════════════════════════
--
-- Этот файл — не «пустая база»: он даёт РОВНО то состояние, которое SQLite
-- получает после миграции 013. Без записи об этом база не знает своей версии:
-- `myc serve --apply-schema` возвращает schema: null, админка показывает то же
-- самое, а будущая миграция 014 не отличит накатанную базу от нетронутой и
-- накатится поверх. Номер здесь общий с рядом SQLite намеренно — миграции
-- дальше пишутся для обоих диалектов, и разъехавшаяся нумерация означала бы
-- два несравнимых ряда (сторож: packages/server/src/parity.pg.test.ts).
--
-- checksum — отпечаток ПОЛУЧИВШЕЙСЯ схемы, а не текста файла: файл не умеет
-- сосчитать сам себя, а каталог считается и сейчас, и потом — тем же
-- запросом. Поэтому расхождение означает то, что и должно означать: базу
-- правили мимо миграций.
--
-- by_version — кто накатил. Бинарь myc ставит `myc.by_version` перед накатом
-- (packages/cli/src/commands/serve.ts); накат руками через psql честно
-- называется psql, а не выдумывает себе версию.
INSERT INTO schema_migrations (version, name, checksum, applied_at, by_version)
SELECT
  13,
  'postgres-baseline',
  md5(string_agg(sig, E'\n' ORDER BY sig)),
  (extract(epoch FROM now()) * 1000)::BIGINT,
  coalesce(nullif(current_setting('myc.by_version', true), ''), 'psql')
FROM (
  SELECT table_name || '.' || column_name || ':' || data_type AS sig
  FROM information_schema.columns
  WHERE table_schema = 'public'
) s
ON CONFLICT (version) DO NOTHING;
