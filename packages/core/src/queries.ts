/**
 * РЕЕСТР ЗАПРОСОВ — ОДИН НА ВСЮ СИСТЕМУ (§8.4).
 *
 * Жил в `@myc/store-sqlite`, переехал сюда, и не ради красоты слоёв: правила
 * слияния (оплог, HLC, часы полей, разбор двойников) выносятся в ядро
 * ЕДИНСТВЕННЫМ применителем — тем самым, которым сервер будет писать в
 * Postgres. Применителю нужен реестр, а правило `deps-check` разрешает
 * пакетам `store-*` видеть только ядро: значит реестр обязан жить здесь, иначе
 * применителей станет два, и правила слияния разойдутся тише, чем два текста
 * SQL (решение 2026-09-26, 03-interfaces-and-integration.md §8.1.1).
 *
 * Тексты диалектно-нейтральны: SQLite читает `sql`, Postgres — либо `pg`, либо
 * механический перевод (`toPgDialect` в sql.ts), а расхождения по существу
 * закрыты паритетом на живой базе (packages/cli/src/parity.pg.test.ts).
 */

import { defineQueries, toPgDialectJsonb, type QueryDef } from "./sql.ts";
import { NODE_FIELDS } from "./graph.ts";

export const NODE_COLUMNS = [
  "id",
  "kind",
  "layer",
  "scope",
  "title",
  "body",
  "body_cold",
  "excerpt",
  "status",
  "priority",
  "confidence",
  "salience",
  "seen_count",
  "open_blockers",
  "anc_blockers",
  "head_id",
  "content_hash",
  "acl",
  "owner_id",
  "team_id",
  "agent_id",
  "assignee",
  "actor",
  "created_at",
  "updated_at",
  "accessed_at",
  "due_at",
  "closed_at",
  "compacted_at",
  "deleted_at",
  "hlc",
  "site_id",
  "attrs",
] as const;

export const NODE_SELECT = NODE_COLUMNS.join(", ");
export const EDGE_SELECT =
  "src, type, dst, weight, add_tag, actor, created_at, hlc, site_id, deleted_at, attrs";

/** Колонки INSERT'а узла — все, кроме материализуемых триггерами счётчиков. */
export const NODE_INSERT_COLUMNS: readonly string[] = NODE_COLUMNS.filter(
  (c) => c !== "open_blockers" && c !== "anc_blockers",
);

const NODE_INSERT_SQL = `INSERT INTO nodes (${NODE_INSERT_COLUMNS.join(", ")})
          VALUES (${NODE_INSERT_COLUMNS.map((_, i) => `?${i + 1}`).join(", ")})`;

export const Q = defineQueries({
  meta_get: {
    name: "meta_get",
    sql: "SELECT value FROM myc_meta WHERE key = ?1",
    params: ["key"],
  },
  meta_set: {
    name: "meta_set",
    sql: `INSERT INTO myc_meta (key, value) VALUES (?1, ?2)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    params: ["key", "value"],
  },

  // ---- оплог -------------------------------------------------------------
  // Дедупликация по op_id живёт здесь, на SQL-слое: сама логика оплога
  // идемпотентна (OplogState.applied), но у долговременного хранилища
  // состояние — это таблицы, и повторную запись обязан отсечь UNIQUE(op_id).
  // changes = 0 ⇒ операция уже применена, проекцию трогать нельзя.
  oplog_insert: {
    name: "oplog_insert",
    sql: `INSERT INTO oplog
            (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id, field, value, scope, origin)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT(op_id) DO NOTHING`,
    params: [
      "op_id",
      "site_id",
      "hlc",
      "ts_ms",
      "actor",
      "op",
      "entity",
      "entity_id",
      "field",
      "value",
      "scope",
      "origin",
    ],
  },
  oplog_since: {
    name: "oplog_since",
    sql: `SELECT seq, op_id, site_id, CAST(hlc AS TEXT) AS hlc, ts_ms, actor,
                 op, entity, entity_id, field, value, scope, origin
            FROM oplog WHERE seq > ?1 ORDER BY seq LIMIT ?2`,
    params: ["seq", "limit"],
  },
  oplog_for_entity: {
    name: "oplog_for_entity",
    sql: `SELECT seq, op_id, site_id, CAST(hlc AS TEXT) AS hlc, ts_ms, actor,
                 op, entity, entity_id, field, value, scope, origin
            FROM oplog WHERE entity_id = ?1
           ORDER BY oplog.hlc, oplog.site_id`,
    params: ["entity_id"],
  },
  oplog_count: {
    name: "oplog_count",
    sql: "SELECT count(*) AS n FROM oplog",
    params: [],
  },
  /**
   * Последняя операция сайта — по хвосту ix_oplog_site(site_id, hlc), два
   * спуска по B-дереву (myc-qie.7). seq в op_id не индексируем, но и не
   * нужен: у одного сайта seq и hlc растут вместе (OpFactory.next выдаёт
   * их одной парой, HlcClock монотонен, syncTail держит это между
   * процессами), поэтому запись с наибольшим hlc несёт и наибольший seq.
   * Прежняя форма `max(CAST(substr(op_id)))` читала все строки сайта —
   * 10 мс на 127k записей в каждом холодном старте. Фильтра по origin нет
   * намеренно: собственная операция, вернувшаяся чужим путём (импорт своего
   * же лога), занимает свой seq так же, как местная.
   */
  oplog_last_local_op_id: {
    name: "oplog_last_local_op_id",
    sql: `SELECT op_id FROM oplog
           WHERE site_id = ?1
             AND hlc = (SELECT max(hlc) FROM oplog WHERE site_id = ?1)
           LIMIT 1`,
    params: ["site_id"],
  },
  /**
   * Хвост индекса ix_oplog_site(site_id, hlc) через min/max-оптимизацию:
   * один спуск по B-дереву. Форма `ORDER BY hlc DESC LIMIT 1` на той же
   * выборке заставляла планировщик строить TEMP B-TREE по всем строкам сайта —
   * 12 мс на 120k записей, и это сидело бы в каждой записи (syncTail) и в
   * каждом холодном старте (seedClock). `hlc` NULL ⇒ записей сайта нет.
   */
  oplog_last_local_hlc: {
    name: "oplog_last_local_hlc",
    sql: `SELECT CAST(max(hlc) AS TEXT) AS hlc FROM oplog WHERE site_id = ?1`,
    params: ["site_id"],
  },
  /** Последняя запись по PK seq: O(log n). */
  oplog_last_row_clock: {
    name: "oplog_last_row_clock",
    sql: `SELECT CAST(hlc AS TEXT) AS hlc, site_id FROM oplog
           ORDER BY seq DESC LIMIT 1`,
    params: [],
  },

  // ---- отложенные операции (myc-qie.9, memory-nvx51d0kgf2t) --------------
  // Повтор op_id — та же операция, приехавшая ещё раз: оставляем первую
  // запись. Её `needs` мог устареть (один конец ребра с тех пор появился), и
  // при прежнем дренаже «только по рождённым в applyOps» строка так и ждала
  // бы узел, который давно есть. Теперь это не ловушка: строка, чей `needs`
  // уже есть в базе, отпускается pending_ready в той же транзакции, и
  // перекладывает ключ сам дренаж. Upsert здесь ничего наблюдаемого не
  // меняет (проверено мутацией) и не нужен.
  pending_insert: {
    name: "pending_insert",
    sql: `INSERT INTO oplog_pending (op_id, needs, origin, op, parked_at)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(op_id) DO NOTHING`,
    params: ["op_id", "needs", "origin", "op", "parked_at"],
  },
  pending_delete: {
    name: "pending_delete",
    sql: "DELETE FROM oplog_pending WHERE op_id = ?1",
    params: ["op_id"],
  },
  pending_any: {
    name: "pending_any",
    sql: "SELECT 1 AS x FROM oplog_pending LIMIT 1",
    params: [],
  },
  /**
   * Готовые к применению: узел, которого операция ждёт, уже есть — КАК БЫ
   * он ни появился (родился в applyOps, создан локально, пришёл переездом).
   * Прежний дренаж смотрел только на узлы, рождённые в той же транзакции
   * applyOps, и всё остальное застревало навсегда. Таблица почти всегда
   * пуста: скан её плюс PK-спуск в nodes на строку.
   */
  pending_ready: {
    name: "pending_ready",
    sql: `SELECT p.op_id, p.needs, p.origin, p.op FROM oplog_pending p
           WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.id = p.needs)
           ORDER BY p.parked_at, p.op_id`,
    params: [],
  },
  /** Фантомы: операция уже в оплоге, а строка ожидания осталась. */
  pending_phantoms_delete: {
    name: "pending_phantoms_delete",
    sql: `DELETE FROM oplog_pending
           WHERE EXISTS (SELECT 1 FROM oplog o WHERE o.op_id = oplog_pending.op_id)`,
    params: [],
  },
  pending_list: {
    name: "pending_list",
    sql: `SELECT op_id, needs, origin, op FROM oplog_pending p
           WHERE NOT EXISTS (SELECT 1 FROM oplog o WHERE o.op_id = p.op_id)
           ORDER BY parked_at, op_id LIMIT ?1`,
    params: ["limit"],
  },
  // Честный счётчик: уже журналированная операция не ждёт ничего, даже если
  // её строка ожидания пережила применение (база старого кода).
  pending_count: {
    name: "pending_count",
    sql: `SELECT count(*) AS n FROM oplog_pending p
           WHERE NOT EXISTS (SELECT 1 FROM oplog o WHERE o.op_id = p.op_id)`,
    params: [],
  },

  // ---- per-field LWW -----------------------------------------------------
  field_clock_get: {
    name: "field_clock_get",
    sql: `SELECT CAST(hlc AS TEXT) AS hlc, site_id FROM field_clock
           WHERE entity_id = ?1 AND field = ?2`,
    params: ["entity_id", "field"],
  },
  field_clock_set: {
    name: "field_clock_set",
    sql: `INSERT INTO field_clock (entity_id, field, hlc, site_id) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(entity_id, field) DO UPDATE
            SET hlc = excluded.hlc, site_id = excluded.site_id`,
    params: ["entity_id", "field", "hlc", "site_id"],
  },

  // ---- G-counter ---------------------------------------------------------
  counter_get: {
    name: "counter_get",
    sql: "SELECT value FROM counters WHERE entity_id = ?1 AND field = ?2 AND site_id = ?3",
    params: ["entity_id", "field", "site_id"],
  },
  counter_set: {
    name: "counter_set",
    // Поэлементный максимум G-counter'а. Двухаргументный `max` — это SQLite;
    // в Postgres скалярный максимум зовут `greatest`, а `max` там только
    // агрегат (§8.3 таблицы расхождений).
    sql: `INSERT INTO counters (entity_id, field, site_id, value) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(entity_id, field, site_id) DO UPDATE
            SET value = max(counters.value, excluded.value)`,
    pg: `INSERT INTO counters (entity_id, field, site_id, value) VALUES ($1, $2, $3, $4)
          ON CONFLICT(tenant_id, entity_id, field, site_id) DO UPDATE
            SET value = greatest(counters.value, excluded.value)`,
    params: ["entity_id", "field", "site_id", "value"],
  },
  counter_sum: {
    name: "counter_sum",
    sql: "SELECT coalesce(sum(value), 0) AS total FROM counters WHERE entity_id = ?1 AND field = ?2",
    params: ["entity_id", "field"],
  },
  node_set_seen_count: {
    name: "node_set_seen_count",
    sql: "UPDATE nodes SET seen_count = ?2 WHERE id = ?1",
    params: ["id", "value"],
  },

  // ---- узлы --------------------------------------------------------------
  node_insert: {
    name: "node_insert",
    sql: NODE_INSERT_SQL,
    // attrs — колонка jsonb в Postgres; см. toPgDialectJsonb.
    pg: toPgDialectJsonb(NODE_INSERT_SQL, NODE_INSERT_COLUMNS.indexOf("attrs") + 1),
    params: [...NODE_INSERT_COLUMNS],
  },
  node_get: {
    name: "node_get",
    sql: `SELECT ${NODE_SELECT} FROM nodes WHERE id = ?1`,
    params: ["id"],
  },
  node_get_live: {
    name: "node_get_live",
    sql: `SELECT ${NODE_SELECT} FROM nodes WHERE id = ?1 AND deleted_at IS NULL`,
    params: ["id"],
  },
  node_head: {
    name: "node_head",
    sql: "SELECT kind, scope, title, body FROM nodes WHERE id = ?1",
    params: ["id"],
  },
  node_refresh_derived: {
    name: "node_refresh_derived",
    sql: "UPDATE nodes SET excerpt = ?2, content_hash = ?3 WHERE id = ?1",
    params: ["id", "excerpt", "content_hash"],
  },

  // ---- контент-дубликаты (memory-0fs4rfa6xmha) ----------------------------
  // Предикат домена ux_nodes_content (миграция 9) повторён дословно: только
  // так планировщик берёт частичный индекс, а не SCAN nodes.
  node_set_content_hash: {
    name: "node_set_content_hash",
    sql: "UPDATE nodes SET content_hash = ?2 WHERE id = ?1",
    params: ["id", "content_hash"],
  },
  node_content_row: {
    name: "node_content_row",
    sql: `SELECT kind, scope, title, body, content_hash,
                 (deleted_at IS NULL AND json_extract(attrs,'$.external_ref') IS NULL) AS indexed
            FROM nodes WHERE id = ?1`,
    pg: `SELECT kind, scope, title, body, content_hash,
                 (deleted_at IS NULL AND attrs->>'external_ref' IS NULL) AS indexed
            FROM nodes WHERE id = $1`,
    params: ["id"],
  },
  /**
   * Группа одного канонического хеша в (scope, kind): держатель канона и
   * пониженные `<канон>:<id>`. Диапазон [канон, канон || ';') ровно их и
   * покрывает: ':' — 0x3A, ';' — 0x3B, а другой 64-символьный hex-канон,
   * больший этого, отличается раньше и выходит за верхнюю границу.
   * Старшинство — часы set(kind), то есть момент создания узла: они
   * реплицируются, и порядок одинаков на всех репликах.
   */
  content_group: {
    name: "content_group",
    sql: `SELECT n.id AS id, n.content_hash AS content_hash,
                 CAST(fc.hlc AS TEXT) AS born_hlc, fc.site_id AS born_site
            FROM nodes n
            LEFT JOIN field_clock fc ON fc.entity_id = n.id AND fc.field = 'kind'
           WHERE n.scope = ?1 AND n.kind = ?2
             AND n.content_hash >= ?3 AND n.content_hash < ?4
             AND n.deleted_at IS NULL AND json_extract(n.attrs,'$.external_ref') IS NULL`,
    pg: `SELECT n.id AS id, n.content_hash AS content_hash,
                 CAST(fc.hlc AS TEXT) AS born_hlc, fc.site_id AS born_site
            FROM nodes n
            LEFT JOIN field_clock fc ON fc.entity_id = n.id AND fc.field = 'kind'
           WHERE n.scope = $1 AND n.kind = $2
             AND n.content_hash >= $3 AND n.content_hash < $4
             AND n.deleted_at IS NULL AND n.attrs->>'external_ref' IS NULL`,
    params: ["scope", "kind", "lo", "hi"],
  },
  /** Все пониженные дубликаты с их каноническим узлом — для doctor и web. */
  content_duplicates: {
    name: "content_duplicates",
    sql: `SELECT l.id AS id, w.id AS "of", l.scope AS scope, l.kind AS kind
            FROM nodes l
            JOIN nodes w
              ON w.scope = l.scope AND w.kind = l.kind
             AND w.content_hash = substr(l.content_hash, 1, instr(l.content_hash, ':') - 1)
             AND w.deleted_at IS NULL AND json_extract(w.attrs,'$.external_ref') IS NULL
           WHERE instr(l.content_hash, ':') > 0
             AND l.deleted_at IS NULL AND json_extract(l.attrs,'$.external_ref') IS NULL
           ORDER BY l.scope, l.kind, l.id`,
    pg: `SELECT l.id AS id, w.id AS "of", l.scope AS scope, l.kind AS kind
            FROM nodes l
            JOIN nodes w
              ON w.scope = l.scope AND w.kind = l.kind
             AND w.content_hash = substr(l.content_hash, 1, position(':' in l.content_hash) - 1)
             AND w.deleted_at IS NULL AND w.attrs->>'external_ref' IS NULL
           WHERE position(':' in l.content_hash) > 0
             AND l.deleted_at IS NULL AND l.attrs->>'external_ref' IS NULL
           ORDER BY l.scope, l.kind, l.id`,
    params: [],
  },
  content_duplicates_count: {
    name: "content_duplicates_count",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE instr(content_hash, ':') > 0
             AND deleted_at IS NULL AND json_extract(attrs,'$.external_ref') IS NULL`,
    pg: `SELECT count(*) AS n FROM nodes
           WHERE position(':' in content_hash) > 0
             AND deleted_at IS NULL AND attrs->>'external_ref' IS NULL`,
    params: [],
  },

  // ---- ввезённые дубликаты (memory-gemeb3d8wj41) --------------------------
  // ux_nodes_external запрещает двум живым узлам держать одну внешнюю
  // ссылку. Ключ индекса — само реплицируемое значение attrs.external_ref,
  // понизить его нельзя (это было бы ложью о записи источника), поэтому
  // конфликт разводит производная колонка ext_dup: '' у держателя, id у
  // понижённого (миграция 13).
  node_set_ext_dup: {
    name: "node_set_ext_dup",
    sql: "UPDATE nodes SET ext_dup = ?2 WHERE id = ?1",
    params: ["id", "ext_dup"],
  },
  node_external_row: {
    name: "node_external_row",
    sql: `SELECT kind, scope, json_extract(attrs,'$.external_ref') AS ref, ext_dup,
                 (deleted_at IS NULL AND json_extract(attrs,'$.external_ref') IS NOT NULL) AS indexed
            FROM nodes WHERE id = ?1`,
    pg: `SELECT kind, scope, attrs->>'external_ref' AS ref, ext_dup,
                 (deleted_at IS NULL AND attrs->>'external_ref' IS NOT NULL) AS indexed
            FROM nodes WHERE id = $1`,
    params: ["id"],
  },
  /**
   * Группа одной внешней ссылки в (scope, kind): держатель и понижённые.
   * Предикат домена ux_nodes_external повторён дословно — только так
   * планировщик берёт частичный индекс, а не SCAN nodes (тест плана).
   * Старшинство — часы set(kind), то есть момент создания узла: они
   * реплицируются, и порядок одинаков на всех репликах.
   */
  external_group: {
    name: "external_group",
    sql: `SELECT n.id AS id, n.ext_dup AS ext_dup,
                 CAST(fc.hlc AS TEXT) AS born_hlc, fc.site_id AS born_site
            FROM nodes n
            LEFT JOIN field_clock fc ON fc.entity_id = n.id AND fc.field = 'kind'
           WHERE n.scope = ?1 AND n.kind = ?2
             AND json_extract(n.attrs,'$.external_ref') = ?3
             AND n.deleted_at IS NULL
             AND json_extract(n.attrs,'$.external_ref') IS NOT NULL`,
    pg: `SELECT n.id AS id, n.ext_dup AS ext_dup,
                 CAST(fc.hlc AS TEXT) AS born_hlc, fc.site_id AS born_site
            FROM nodes n
            LEFT JOIN field_clock fc ON fc.entity_id = n.id AND fc.field = 'kind'
           WHERE n.scope = $1 AND n.kind = $2
             AND n.attrs->>'external_ref' = $3
             AND n.deleted_at IS NULL
             AND n.attrs->>'external_ref' IS NOT NULL`,
    params: ["scope", "kind", "ref"],
  },
  /** Все понижённые ввезённые узлы с их держателем — для doctor и web. */
  external_duplicates: {
    name: "external_duplicates",
    sql: `SELECT l.id AS id, w.id AS "of", l.scope AS scope, l.kind AS kind,
                 json_extract(l.attrs,'$.external_ref') AS ref
            FROM nodes l
            JOIN nodes w
              ON w.scope = l.scope AND w.kind = l.kind
             AND json_extract(w.attrs,'$.external_ref') = json_extract(l.attrs,'$.external_ref')
             AND w.ext_dup = '' AND w.deleted_at IS NULL
           WHERE l.ext_dup <> '' AND l.deleted_at IS NULL
             AND json_extract(l.attrs,'$.external_ref') IS NOT NULL
           ORDER BY l.scope, l.kind, l.id`,
    pg: `SELECT l.id AS id, w.id AS "of", l.scope AS scope, l.kind AS kind,
                 l.attrs->>'external_ref' AS ref
            FROM nodes l
            JOIN nodes w
              ON w.scope = l.scope AND w.kind = l.kind
             AND w.attrs->>'external_ref' = l.attrs->>'external_ref'
             AND w.ext_dup = '' AND w.deleted_at IS NULL
           WHERE l.ext_dup <> '' AND l.deleted_at IS NULL
             AND l.attrs->>'external_ref' IS NOT NULL
           ORDER BY l.scope, l.kind, l.id`,
    params: [],
  },
  external_duplicates_count: {
    name: "external_duplicates_count",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE ext_dup <> '' AND deleted_at IS NULL
             AND json_extract(attrs,'$.external_ref') IS NOT NULL`,
    pg: `SELECT count(*) AS n FROM nodes
           WHERE ext_dup <> '' AND deleted_at IS NULL
             AND attrs->>'external_ref' IS NOT NULL`,
    params: [],
  },
  // myc_health — то, что читают web и /v1/health (И2). Смена состояния
  // двигает since, повтор того же состояния — нет.
  health_set: {
    name: "health_set",
    sql: `INSERT INTO myc_health (component, state, reason, since, detail)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(component) DO UPDATE
            SET reason = excluded.reason, detail = excluded.detail,
                since = CASE WHEN myc_health.state = excluded.state
                             THEN myc_health.since ELSE excluded.since END,
                state = excluded.state`,
    // jsonb-колонка: параметр приводится явно (toPgDialectJsonb).
    pg: toPgDialectJsonb(`INSERT INTO myc_health (component, state, reason, since, detail)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(component) DO UPDATE
            SET reason = excluded.reason, detail = excluded.detail,
                since = CASE WHEN myc_health.state = excluded.state
                             THEN myc_health.since ELSE excluded.since END,
                state = excluded.state`, 5),
    params: ["component", "state", "reason", "since", "detail"],
  },
  node_set_attr: {
    name: "node_set_attr",
    sql: `UPDATE nodes
             SET attrs = json_set(attrs, ?2, json(?3)),
                 updated_at = ?4, hlc = ?5, site_id = ?6
           WHERE id = ?1`,
    // Путь приходит в форме SQLite (`$.key`), и переписывать его у вызывающего
    // значило бы завести диалект в вызывающем коде. Postgres берёт путь
    // массивом, поэтому ключ извлекается здесь же — все пути реестра состоят
    // ровно из одного ключа (сторож — dialect-registries.test.ts).
    pg: `UPDATE nodes
            SET attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), ARRAY[replace($2, '$.', '')], $3::text::jsonb, true),
                updated_at = $4, hlc = $5, site_id = $6
          WHERE id = $1`,
    params: ["id", "path", "value", "updated_at", "hlc", "site_id"],
  },
  node_list_by_kind: {
    name: "node_list_by_kind",
    sql: `SELECT ${NODE_SELECT} FROM nodes
           WHERE scope = ?1 AND kind = ?2 AND deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT ?3`,
    params: ["scope", "kind", "limit"],
  },
  node_count_live: {
    name: "node_count_live",
    sql: "SELECT count(*) AS n FROM nodes WHERE deleted_at IS NULL",
    params: [],
  },

  // ---- рёбра -------------------------------------------------------------
  edge_get: {
    name: "edge_get",
    sql: `SELECT ${EDGE_SELECT} FROM edges WHERE src = ?1 AND type = ?2 AND dst = ?3`,
    params: ["src", "type", "dst"],
  },
  // Отдельный запрос под сравнение часов: hlc обязан приехать точным.
  edge_clock_get: {
    name: "edge_clock_get",
    sql: `SELECT CAST(hlc AS TEXT) AS hlc, site_id, add_tag, deleted_at
            FROM edges WHERE src = ?1 AND type = ?2 AND dst = ?3`,
    params: ["src", "type", "dst"],
  },
  edge_insert: {
    name: "edge_insert",
    sql: `INSERT INTO edges (src, type, dst, weight, add_tag, actor, created_at, hlc, site_id, deleted_at, attrs)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    // jsonb-колонка: параметр приводится явно (toPgDialectJsonb).
    pg: toPgDialectJsonb(`INSERT INTO edges (src, type, dst, weight, add_tag, actor, created_at, hlc, site_id, deleted_at, attrs)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`, 11),
    params: [
      "src",
      "type",
      "dst",
      "weight",
      "add_tag",
      "actor",
      "created_at",
      "hlc",
      "site_id",
      "deleted_at",
      "attrs",
    ],
  },
  // Строка ребра — функция от множества OR-Set (memory-86eqge02q8rd): все
  // реплицируемые колонки переписываются из пересчёта целиком. deleted_at
  // попадает в SET намеренно: триггеры trg_blk_del/trg_blk_res объявлены как
  // UPDATE OF deleted_at, и только присутствие колонки в SET заставляет их
  // сработать. Сами триггеры защищены условиями по old/new, поэтому запись
  // того же значения счётчик не двигает.
  edge_project: {
    name: "edge_project",
    sql: `UPDATE edges
             SET weight = ?4, add_tag = ?5, hlc = ?6, site_id = ?7,
                 created_at = ?8, deleted_at = ?9
           WHERE src = ?1 AND type = ?2 AND dst = ?3`,
    params: [
      "src",
      "type",
      "dst",
      "weight",
      "add_tag",
      "hlc",
      "site_id",
      "created_at",
      "deleted_at",
    ],
  },
  /** Локальные, нереплицируемые колонки ребра — пишет только свой addEdge. */
  edge_set_local: {
    name: "edge_set_local",
    sql: `UPDATE edges SET actor = ?4, attrs = ?5
           WHERE src = ?1 AND type = ?2 AND dst = ?3`,
    // jsonb-колонка: параметр приводится явно (toPgDialectJsonb).
    pg: toPgDialectJsonb(`UPDATE edges SET actor = ?4, attrs = ?5
           WHERE src = ?1 AND type = ?2 AND dst = ?3`, 5),
    params: ["src", "type", "dst", "actor", "attrs"],
  },
  /**
   * Множество add-тегов ребра. Отдельной таблицы у него нет и не нужно:
   * каждое применённое добавление уже лежит в оплоге строкой edge_add с
   * тегом в value (журнал пишется ДО проекции), а оплог — источник истины
   * (S42). Один спуск по ix_oplog_entity(entity_id, hlc); у ребра таких
   * строк единицы. Компактирование оплога (§9.5, не реализовано) обязано
   * сохранять строки edge_add живых тегов — иначе ребро потеряет добавления.
   */
  edge_adds_of: {
    name: "edge_adds_of",
    sql: `SELECT value, CAST(hlc AS TEXT) AS hlc, site_id FROM oplog
           WHERE entity_id = ?1 AND op = 'edge_add'`,
    params: ["entity_id"],
  },
  // Тумбстоун одного тега мог прийти от нескольких удалений. Хранится самое
  // позднее по (hlc, site_id) — не «первое применённое»: DO NOTHING делал
  // deleted_at зависимым от порядка доставки.
  edge_tombstone_insert: {
    name: "edge_tombstone_insert",
    sql: `INSERT INTO edge_tombstones (src, type, dst, tag, hlc, site_id)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(src, type, dst, tag) DO UPDATE
            SET hlc = excluded.hlc, site_id = excluded.site_id
          WHERE excluded.hlc > edge_tombstones.hlc
             OR (excluded.hlc = edge_tombstones.hlc AND excluded.site_id > edge_tombstones.site_id)`,
    params: ["src", "type", "dst", "tag", "hlc", "site_id"],
  },
  /** Реплицируемое состояние строк рёбер — сверка ремонта reprojectEdges. */
  edges_state: {
    name: "edges_state",
    sql: `SELECT src, type, dst, weight, add_tag, CAST(hlc AS TEXT) AS hlc, site_id,
                 created_at, deleted_at
            FROM edges ORDER BY src, type, dst`,
    params: [],
  },
  edge_tombstones_of: {
    name: "edge_tombstones_of",
    sql: `SELECT tag, CAST(hlc AS TEXT) AS hlc FROM edge_tombstones
           WHERE src = ?1 AND type = ?2 AND dst = ?3`,
    params: ["src", "type", "dst"],
  },
  edges_from: {
    name: "edges_from",
    sql: `SELECT ${EDGE_SELECT} FROM edges
           WHERE src = ?1 AND deleted_at IS NULL ORDER BY type, dst`,
    params: ["src"],
  },
  edges_from_typed: {
    name: "edges_from_typed",
    sql: `SELECT ${EDGE_SELECT} FROM edges
           WHERE src = ?1 AND type = ?2 AND deleted_at IS NULL ORDER BY dst`,
    params: ["src", "type"],
  },
  edges_to: {
    name: "edges_to",
    sql: `SELECT ${EDGE_SELECT} FROM edges
           WHERE dst = ?1 AND deleted_at IS NULL ORDER BY type, src`,
    params: ["dst"],
  },
  edges_to_typed: {
    name: "edges_to_typed",
    sql: `SELECT ${EDGE_SELECT} FROM edges
           WHERE dst = ?1 AND type = ?2 AND deleted_at IS NULL ORDER BY src`,
    params: ["dst", "type"],
  },

  // ---- пересчёт материализации ------------------------------------------
  // Жёсткий DELETE ребра триггерами не покрыт by design (модель — мягкие
  // удаления, OR-Set), поэтому после purge счётчик восстанавливается этим
  // запросом. Он же — эталон, с которым сверяется триггерная арифметика.
  recount_open_blockers: {
    name: "recount_open_blockers",
    sql: `UPDATE nodes SET open_blockers = (
            SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
             WHERE e.dst = nodes.id AND e.type = 'blocks' AND e.deleted_at IS NULL
               AND s.status NOT IN ('closed','cancelled','superseded','retracted'))`,
    params: [],
  },
  // Наследование блокеров вниз по parent (миграция 10). Пересчёт идёт ВТОРЫМ,
  // после recount_open_blockers: он читает уже исправленные open_blockers
  // предков, и запись сюда триггеров не будит (в UPDATE OF нет anc_blockers).
  recount_anc_blockers: {
    name: "recount_anc_blockers",
    sql: `UPDATE nodes SET anc_blockers = (
            SELECT count(*) FROM parent_closure pc JOIN nodes a ON a.id = pc.ancestor
             WHERE pc.descendant = nodes.id AND a.open_blockers > 0)`,
    params: [],
  },
  // Сверка идёт с ГРАФОМ, а не с соседним счётчиком: если бы «actual»
  // читался из nodes.open_blockers предка, то разъехавшийся open_blockers
  // делал бы anc_blockers «сходящимся» — две поломки взаимно замаскировались
  // бы, и жёсткое удаление ребра осталось бы незамеченным (проверено
  // мутацией в anc-blockers.test.ts).
  anc_blockers_drift: {
    name: "anc_blockers_drift",
    sql: `SELECT id, anc_blockers AS stored, actual FROM (
            SELECT n.id AS id, n.anc_blockers AS anc_blockers, (
              SELECT count(*) FROM parent_closure pc
               WHERE pc.descendant = n.id
                 AND (SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
                       WHERE e.dst = pc.ancestor AND e.type = 'blocks'
                         AND e.deleted_at IS NULL
                         AND s.status NOT IN ('closed','cancelled','superseded','retracted')
                     ) > 0) AS actual
               FROM nodes n)
            WHERE anc_blockers <> actual`,
    params: [],
  },
  // Кто именно наследует блокировку (И2). `anc_blockers` — число, а человеку
  // нужен виновник: у самой задачи в `deps` нет ни следа, блокер висит на
  // эпике. Не горячий путь — один спуск по ix_pc_desc на показ узла.
  anc_blocking: {
    name: "anc_blocking",
    sql: `SELECT a.id AS id, a.title AS title, a.status AS status,
                 a.open_blockers AS open_blockers, pc.depth AS depth
            FROM parent_closure pc JOIN nodes a ON a.id = pc.ancestor
           WHERE pc.descendant = ?1 AND a.open_blockers > 0
           ORDER BY pc.depth ASC, a.id ASC`,
    params: ["id"],
  },
  open_blockers_drift: {
    name: "open_blockers_drift",
    sql: `SELECT id, open_blockers AS stored, actual FROM (
            SELECT n.id AS id, n.open_blockers AS open_blockers, (
              SELECT count(*) FROM edges e JOIN nodes s ON s.id = e.src
               WHERE e.dst = n.id AND e.type = 'blocks' AND e.deleted_at IS NULL
                 AND s.status NOT IN ('closed','cancelled','superseded','retracted')) AS actual
               FROM nodes n)
            WHERE open_blockers <> actual`,
    params: [],
  },

  // ---- claim: CAS-захват задачи с lease и epoch (§9.4) --------------------
  // Каждый захват/продление/освобождение — ОДИН UPDATE с предикатом в WHERE:
  // условие и запись атомарны, окна «прочитал → решил → записал» не существует.
  // BEGIN IMMEDIATE берёт write-lock сразу (иначе SQLite ушёл бы в SQLITE_BUSY
  // на upgrade и откатил транзакцию). Проигравший гонку видит пустой RETURNING,
  // то есть changes()==0, и идёт за следующей задачей из ready.
  //
  // Ветка re-open: in_progress с просроченным lease считается свободной —
  // «просроченная аренда автоматически переоткрывает задачу для других» (§9.4),
  // отдельного сборщика не нужно. Перехвативший получает epoch+1, поэтому
  // воскресший держатель ничего не может сделать со своей устаревшей эпохой.
  //
  // Время для lease — op.hlc.ts часов OpFactory, а не Date.now: единственная
  // шкала на мутацию, монотонная по построению HLC и подменяемая в тестах.
  claim_node: {
    name: "claim_node",
    sql: `UPDATE nodes
             SET status = 'in_progress', assignee = ?2, lease_holder = ?2,
                 lease_epoch = lease_epoch + 1, lease_expires = ?3,
                 updated_at = ?4, hlc = ?5, site_id = ?6
           WHERE id = ?1
             AND deleted_at IS NULL
             AND open_blockers = 0
             AND (
                   (status = 'open' AND (lease_expires = 0 OR lease_expires < ?4))
                OR (status = 'in_progress' AND lease_expires < ?4)
                 )
         RETURNING id, scope, lease_epoch, lease_expires`,
    params: ["id", "holder", "expires_at", "now_ms", "hlc", "site_id"],
  },
  lease_renew: {
    name: "lease_renew",
    sql: `UPDATE nodes
             SET lease_expires = ?4, updated_at = ?5, hlc = ?6, site_id = ?7
           WHERE id = ?1
             AND status = 'in_progress'
             AND lease_holder = ?2
             AND lease_epoch = ?3
         RETURNING scope`,
    params: ["id", "holder", "epoch", "expires_at", "now_ms", "hlc", "site_id"],
  },
  lease_release: {
    name: "lease_release",
    sql: `UPDATE nodes
             SET status = 'open', assignee = '', lease_holder = '',
                 lease_expires = 0, updated_at = ?4, hlc = ?5, site_id = ?6
           WHERE id = ?1
             AND status = 'in_progress'
             AND lease_holder = ?2
             AND lease_epoch = ?3
         RETURNING scope`,
    params: ["id", "holder", "epoch", "now_ms", "hlc", "site_id"],
  },
  lease_close: {
    name: "lease_close",
    sql: `UPDATE nodes
             SET status = 'closed', closed_at = ?4, lease_holder = '',
                 lease_expires = 0, updated_at = ?5, hlc = ?6, site_id = ?7
           WHERE id = ?1
             AND deleted_at IS NULL
             AND status = 'in_progress'
             AND lease_holder = ?2
             AND lease_epoch = ?3
         RETURNING scope`,
    params: ["id", "holder", "epoch", "closed_at", "now_ms", "hlc", "site_id"],
  },
  lease_get: {
    name: "lease_get",
    sql: `SELECT id, status, lease_holder AS holder,
                 lease_epoch AS epoch, lease_expires AS expires
            FROM nodes WHERE id = ?1`,
    params: ["id"],
  },
  claim_candidates: {
    name: "claim_candidates",
    sql: `SELECT id FROM nodes
           WHERE scope = ?1 AND kind = ?2 AND open_blockers = 0
             AND deleted_at IS NULL
             AND (
                   (status = 'open' AND (lease_expires = 0 OR lease_expires < ?3))
                OR (status = 'in_progress' AND lease_expires < ?3)
                 )
           ORDER BY priority ASC, updated_at ASC, id ASC
           LIMIT ?4`,
    params: ["scope", "kind", "now_ms", "limit"],
  },
  claim_remaining: {
    name: "claim_remaining",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE scope = ?1 AND kind = ?2 AND open_blockers = 0
             AND deleted_at IS NULL
             AND (
                   (status = 'open' AND (lease_expires = 0 OR lease_expires < ?3))
                OR (status = 'in_progress' AND lease_expires < ?3)
                 )`,
    params: ["scope", "kind", "now_ms"],
  },
  /**
   * Бэкфилл закрытий (memory-tvw65jjgaheh): последнее по часам закрытие
   * через claim, которое НЕ выражено LWW-записью status — ни одна запись
   * статуса в field_clock не новее его. До правки closeClaimed журналировал
   * только строку op='claim' (она не реплицируется) и не двигал field_clock,
   * так что это ровно закрытия, до реплик не доехавшие. Узел, чей статус
   * после закрытия поменяла обычная правка, сюда не попадает: закрытие
   * перекрыто, догонять нечего. Полный проход по оплогу (индекса по op нет) —
   * это экспорт, не горячий путь; экспорт и так читает оплог целиком.
   */
  claim_close_unexpressed: {
    name: "claim_close_unexpressed",
    sql: `SELECT c.entity_id AS id, c.scope AS scope, c.ts_ms AS ts_ms, c.value AS value,
                 c.site_id AS site_id
            FROM oplog c
           WHERE c.op = 'claim' AND json_extract(c.value, '$.action') = 'close'
             AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = c.entity_id)
             AND NOT EXISTS (
                   SELECT 1 FROM oplog c2
                    WHERE c2.entity_id = c.entity_id AND c2.op = 'claim'
                      AND json_extract(c2.value, '$.action') = 'close'
                      AND (c2.hlc > c.hlc OR (c2.hlc = c.hlc AND c2.site_id > c.site_id)))
             AND NOT EXISTS (
                   SELECT 1 FROM field_clock fc
                    WHERE fc.entity_id = c.entity_id AND fc.field = 'status'
                      AND (fc.hlc > c.hlc OR (fc.hlc = c.hlc AND fc.site_id >= c.site_id)))
           ORDER BY c.seq`,
    params: [],
  },
  // Анти-паттерн из §9.4 (SELECT → UPDATE без предиката) — живёт в реестре
  // только как эталон поломки для мутационных тестов claim.test.ts.
  claim_twostep_node: {
    name: "claim_twostep_node",
    sql: `UPDATE nodes
             SET status = 'in_progress', assignee = ?2, lease_holder = ?2,
                 lease_epoch = lease_epoch + 1, lease_expires = 0
           WHERE id = ?1`,
    params: ["id", "holder"],
  },
});

/**
 * По одному UPDATE на горячее поле. Тексты собираются из белого списка
 * NODE_FIELDS: имя колонки приходит из замороженной таблицы core, а не из
 * ввода, поэтому правило «никаких конкатенаций SQL вне queries.ts» держится.
 */
export const NODE_SET_QUERIES: Readonly<Record<string, QueryDef>> = (() => {
  const defs: Record<string, QueryDef> = {};
  for (const spec of NODE_FIELDS) {
    const name = `node_set_${spec.field}`;
    defs[name] = {
      name,
      sql: `UPDATE nodes SET ${spec.column} = ?2, updated_at = ?3, hlc = ?4, site_id = ?5 WHERE id = ?1`,
      params: ["id", "value", "updated_at", "hlc", "site_id"],
    };
  }
  return defineQueries(defs);
})();
