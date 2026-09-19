/**
 * Реестр запросов и CRUD узлов и рёбер поверх оплога.
 *
 * Правило §8.4: единственное место в кодовой базе, где живёт текст SQL. Тексты
 * per-field собираются из белого списка NODE_FIELDS (@myc/core/graph) один раз
 * при загрузке модуля — конкатенации со значениями из ввода нет нигде.
 *
 * Каждая мутация — одна транзакция BEGIN IMMEDIATE, в которой лежат и правка
 * проекции (nodes/edges), и записи оплога. Половинчатого состояния не бывает
 * ни при каком падении: либо есть и узел, и его операции, либо нет ничего.
 *
 * Источники: docs/design/01-core-data-model.md §2, §4, §8.4, §9.3;
 * docs/design/ARCHITECTURE.md §10 (S3, S5, S25, S30).
 */

import {
  HlcClock,
  compareClock,
  compareHlc,
  defineQueries,
  packHlc,
  unpackHlc,
  type DbDriver,
  type EdgeAddOp,
  type EdgeDelOp,
  type EdgeKind,
  type Hlc,
  type IncOp,
  type JsonValue,
  type Op,
  type QueryDef,
  type SetOp,
} from "@myc/core";
import {
  EDGE_SEMANTICS,
  GraphError,
  NODE_FIELDS,
  OpFactory,
  assertEdgeEndpoints,
  assertEdgeKind,
  assertNodeField,
  assertNodeKind,
  attrKeyOf,
  coerceNodeFieldValue,
  contentHash,
  makeExcerpt,
  nodeInputFields,
  nodePatchFields,
  type EdgeRecord,
  type NodeInput,
  type NodePatch,
  type NodeRecord,
} from "@myc/core";
import { ancestorsOf, applyParentInsert, applyParentMove, applyParentRemove } from "./closure.ts";
import { checkEdgeAcyclic } from "./cycle.ts";

// ---------------------------------------------------------------------------
// Ключ ребра в SQL
// ---------------------------------------------------------------------------

/** Разделитель ключа ребра в памяти — тот же NUL, что и в oplog.ts. */
const MEMORY_EDGE_SEPARATOR = "\u0000";

/**
 * Lease задачи: TTL аренды и каденция продления (§9.4). Держатель обязан
 * продлевать аренду heartbeat'ом каждые 300 с; просроченная аренда в любом
 * случае не блокирует других — условие `lease_expires < now` в CAS открывает
 * задачу заново, отдельного сборщика не нужно.
 */
export const LEASE_TTL_MS = 900_000;
export const LEASE_RENEW_MS = 300_000;

/**
 * В памяти ключ ребра склеен через NUL (`edgeKey` в oplog.ts) — там это
 * безопасно. В TEXT-колонке SQLite NUL хранить нельзя: `length()` и сравнения
 * обрываются на нём, а часть драйверов молча режет строку. Поэтому в колонке
 * `oplog.entity_id` ключ хранится в виде `src|type|dst`, как и предписывает
 * комментарий к DDL (§8.1.10). Отображение биективно: `|` не встречается ни
 * в каноническом ID (§3.1: slug + Crockford base32), ни в имени типа ребра.
 */
export const EDGE_ENTITY_SEPARATOR = "|";

export function edgeEntityId(src: string, type: string, dst: string): string {
  return `${src}${EDGE_ENTITY_SEPARATOR}${type}${EDGE_ENTITY_SEPARATOR}${dst}`;
}

export function parseEdgeEntityId(value: string): {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
} {
  const parts = value.split(EDGE_ENTITY_SEPARATOR);
  if (parts.length !== 3) {
    throw new GraphError(
      "graph.edge_type",
      `malformed edge key in the oplog: ${JSON.stringify(value)}`,
    );
  }
  return { src: parts[0]!, type: parts[1]!, dst: parts[2]! };
}

/** Ключ ребра из Op.entity_id (NUL-форма) в форму колонки. */
function splitMemoryEdgeKey(key: string): {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
} {
  const parts = key.split(MEMORY_EDGE_SEPARATOR);
  if (parts.length !== 3) {
    throw new GraphError(
      "graph.edge_type",
      `malformed edge key: ${JSON.stringify(key)}`,
    );
  }
  return { src: parts[0]!, type: parts[1]!, dst: parts[2]! };
}

// ---------------------------------------------------------------------------
// Точность HLC в SQLite
// ---------------------------------------------------------------------------

/**
 * packHlc — это `(ms << 16) | counter`, то есть около 1.2e17 при нынешних
 * датах, а Number.MAX_SAFE_INTEGER — 9.0e15. Прочитать колонку `hlc` как JS
 * number значит потерять младшие четыре бита счётчика: две записи в одну и ту
 * же миллисекунду сравнялись бы, и LWW перестал бы различать их порядок.
 *
 * Поэтому в базу часы уходят BigInt'ом (bun:sqlite связывает его точным
 * int64), а обратно читаются через CAST(hlc AS TEXT). Обе стороны проверены
 * на реальном рантайме; безопасного числового пути здесь нет.
 */
function readHlc(text: string | number | bigint): Hlc {
  return unpackHlc(BigInt(text));
}

// ---------------------------------------------------------------------------
// Реестр запросов
// ---------------------------------------------------------------------------

const NODE_COLUMNS = [
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

const NODE_SELECT = NODE_COLUMNS.join(", ");
const EDGE_SELECT =
  "src, type, dst, weight, add_tag, actor, created_at, hlc, site_id, deleted_at, attrs";

/** Колонки INSERT'а узла — все, кроме материализуемых триггерами счётчиков. */
const NODE_INSERT_COLUMNS: readonly string[] = NODE_COLUMNS.filter(
  (c) => c !== "open_blockers" && c !== "anc_blockers",
);

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
            FROM oplog WHERE entity_id = ?1 ORDER BY hlc, site_id`,
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
    sql: `INSERT INTO counters (entity_id, field, site_id, value) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(entity_id, field, site_id) DO UPDATE
            SET value = max(counters.value, excluded.value)`,
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
    sql: `INSERT INTO nodes (${NODE_INSERT_COLUMNS.join(", ")})
          VALUES (${NODE_INSERT_COLUMNS.map((_, i) => `?${i + 1}`).join(", ")})`,
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
    params: [],
  },
  content_duplicates_count: {
    name: "content_duplicates_count",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE instr(content_hash, ':') > 0
             AND deleted_at IS NULL AND json_extract(attrs,'$.external_ref') IS NULL`,
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
    params: [],
  },
  external_duplicates_count: {
    name: "external_duplicates_count",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE ext_dup <> '' AND deleted_at IS NULL
             AND json_extract(attrs,'$.external_ref') IS NOT NULL`,
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
    params: ["component", "state", "reason", "since", "detail"],
  },
  node_set_attr: {
    name: "node_set_attr",
    sql: `UPDATE nodes
             SET attrs = json_set(attrs, ?2, json(?3)),
                 updated_at = ?4, hlc = ?5, site_id = ?6
           WHERE id = ?1`,
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

function nodeSetQuery(field: string): QueryDef {
  const def = NODE_SET_QUERIES[`node_set_${field}`];
  if (def === undefined) {
    throw new GraphError(
      "graph.unknown_field",
      `no write query for field '${field}'`,
    );
  }
  return def;
}

/**
 * Счётчики, у которых есть материализующая колонка в nodes. Остальные
 * G-counter'ы живут только в таблице counters — колонки под них нет,
 * и молча писать их в никуда нельзя.
 */
const COUNTER_COLUMNS: Readonly<Record<string, QueryDef>> = Object.freeze({
  seen_count: Q.node_set_seen_count,
});

// ---------------------------------------------------------------------------
// Разбор строк
// ---------------------------------------------------------------------------

type RawRow = Record<string, unknown>;

function parseAttrs(raw: unknown): Record<string, JsonValue> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  return JSON.parse(raw) as Record<string, JsonValue>;
}

export function rowToNode(row: RawRow): NodeRecord {
  return { ...row, attrs: parseAttrs(row["attrs"]) } as unknown as NodeRecord;
}

export function rowToEdge(row: RawRow): EdgeRecord {
  return { ...row, attrs: parseAttrs(row["attrs"]) } as unknown as EdgeRecord;
}

// ---------------------------------------------------------------------------
// Хранилище графа
// ---------------------------------------------------------------------------

export interface GraphStoreOptions {
  /** Генератор ID узла — обычно generateId из @myc/core. */
  readonly newId: () => string;
  /** ID сайта. Если в myc_meta уже записан site_id, побеждает он. */
  readonly siteId?: string;
  /** Кто пишет: человек или агент. Уходит в oplog.actor и edges.actor. */
  readonly actor?: string;
  /** Часы. Для тестов детерминизма подменяются целиком. */
  readonly clock?: HlcClock;
  /** Источник физического времени (мс). По умолчанию Date.now. */
  readonly now?: () => number;
}

export interface ApplyResult {
  /** Спроецированы на таблицы. */
  readonly applied: number;
  /** Отсечены дедупликацией по op_id — уже были применены. */
  readonly duplicate: number;
  /** Записаны в оплог, но проигнорированы LWW: наша версия новее. */
  readonly stale: number;
  /**
   * Не применены и НЕ записаны в оплог: зависимости не выполнены — узла нет,
   * а `kind` в пакете не пришёл, либо у ребра нет одного из концов. Запись
   * в оплог здесь была бы ловушкой — дедупликация по op_id навсегда закрыла
   * бы повторную попытку. Операции лежат в oplog_pending и применятся сами,
   * когда недостающий узел появится (myc-qie.9); молчать об этом всё равно
   * нельзя (инвариант И2), список уезжает наверх.
   */
  readonly deferred: readonly string[];
  /**
   * Отложены ранее (в этом или прошлом вызове) и применены СЕЙЧАС, потому
   * что их зависимости приехали этим пакетом. Уже учтены в `applied`;
   * список нужен вызывающему, который до этого показал их как deferred.
   */
  readonly released: readonly string[];
  /**
   * Записаны в оплог, но столкнулись с уже применённым полем по РАВНОЙ паре
   * (hlc, site_id) при ДРУГОМ значении. Разорвать такую ничью нечем: это не
   * решение LWW, а нарушение инварианта «один сайт — одна последовательность
   * часов». Тихого тай-брейка здесь нет — список обязан попасть в degraded
   * поверхности sync (И2). Локальная запись в той же ситуации бросает
   * GraphError graph.clock_collision.
   */
  readonly collided: readonly string[];
  /**
   * Контент-дубликаты (memory-0fs4rfa6xmha), затронутые этим пакетом: два
   * живых узла с одним (scope, kind, title, body) — обычно один и тот же
   * текст, записанный независимо на двух машинах. Уникальный индекс
   * ux_nodes_content такой пары не пускает, и раньше UNIQUE откатывал весь
   * пакет, а каждая следующая синхронизация падала тем же исключением.
   * Теперь канон остаётся у старшего узла (часы set(kind), одинаково на всех
   * репликах), у младшего производный content_hash понижен до `<канон>:<id>`,
   * данные обоих целы. `of` — узел, держащий канон. Молчать нельзя (И2):
   * список уезжает наверх, итог — в myc_health 'sync.duplicates' и
   * contentDuplicates().
   */
  readonly duplicates: readonly IdentityDuplicate[];
}

export interface IdentityDuplicate {
  /** Пониженный узел. */
  readonly id: string;
  /** Узел, держащий идентичность: канонический content_hash или ссылку. */
  readonly of: string;
  /**
   * Какая идентичность повторилась. `content` — (kind, title, body) в одном
   * scope у узлов, заведённых myc (ux_nodes_content); `external` — одна
   * `attrs.external_ref` у ввезённых (ux_nodes_external). Домены индексов
   * не пересекаются, поэтому один узел не может быть дубликатом обоих.
   */
  readonly by: "content" | "external";
}

/** Ключ группы контента узла до правки в этой транзакции. */
interface ContentKey {
  readonly scope: string;
  readonly kind: string;
  readonly canon: string;
  /** Узел был в домене ux_nodes_content (живой, без external_ref). */
  readonly indexed: boolean;
  /** Держал пониженный хеш — был проигравшим дубликатом до транзакции. */
  readonly demoted: boolean;
}

/** Ключ группы внешней ссылки узла до правки в этой транзакции. */
interface ExternalKey {
  readonly scope: string;
  readonly kind: string;
  readonly ref: string;
  /** Узел был в домене ux_nodes_external (живой, с external_ref). */
  readonly indexed: boolean;
  /** Был понижен — ссылку до транзакции держал кто-то другой. */
  readonly demoted: boolean;
}

/** Счётчики одного вызова applyOps плюс рабочие очереди транзакции. */
interface ApplyTally {
  applied: number;
  duplicate: number;
  stale: number;
  readonly deferred: string[];
  readonly released: string[];
  readonly collided: string[];
  readonly duplicates: IdentityDuplicate[];
  /**
   * Узлы, чьё членство в группе контента могло поменяться (title, body,
   * scope, deleted_at, attrs.external_ref, рождение): ключ группы ДО первой
   * правки, `null` — узел родился в этой транзакции. Пересчёт — settleContent.
   */
  readonly content: Map<string, ContentKey | null>;
  /**
   * То же для ux_nodes_external: узлы, чьё членство в группе внешней ссылки
   * могло поменяться (scope, deleted_at, attrs.external_ref, рождение).
   * Пересчёт — settleExternal.
   */
  readonly external: Map<string, ExternalKey | null>;
  /** В oplog_pending есть строки: применённую операцию надо из неё вычеркнуть. */
  pendingKnown: boolean;
}

/** Поля, от которых зависит членство узла в ux_nodes_content. */
const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "body",
  "scope",
  "deleted_at",
  "attrs.external_ref",
]);

/**
 * Поля, от которых зависит членство узла в ux_nodes_external. Текст узла
 * сюда не входит: идентичность ввезённого даёт ссылка на источник, а не
 * содержимое (миграция 9).
 */
/** Никто не входит в группу этой транзакцией (holdExternal из createNode). */
const NO_IDS: ReadonlySet<string> = new Set();

const EXTERNAL_FIELDS: ReadonlySet<string> = new Set([
  "scope",
  "deleted_at",
  "attrs.external_ref",
]);

/**
 * Производный хеш проигравшего дубликата. ':' в каноне (hex sha256) не
 * встречается, id уникален — значение уникально по построению, и UNIQUE
 * ux_nodes_content с ним столкнуться не может ни в какой момент транзакции.
 */
function demotedContentHash(canon: string, id: string): string {
  return `${canon}:${id}`;
}

function canonOf(stored: string): string {
  const at = stored.indexOf(":");
  return at < 0 ? stored : stored.slice(0, at);
}

/**
 * Старшинство в группе (и контентной, и по внешней ссылке): часы set(kind) —
 * момент создания узла, реплицируемый и одинаковый везде, — затем сайт,
 * затем id. Узел без часов kind (не бывает при целом оплоге) идёт последним.
 */
function olderBorn(a: BornMember, b: BornMember): boolean {
  if (a.born_hlc !== null && b.born_hlc !== null) {
    const c = compareClock(
      readHlc(a.born_hlc),
      a.born_site ?? "",
      readHlc(b.born_hlc),
      b.born_site ?? "",
    );
    if (c !== 0) return c < 0;
  } else if (a.born_hlc !== null) {
    return true;
  } else if (b.born_hlc !== null) {
    return false;
  }
  return a.id < b.id;
}

function newTally(): ApplyTally {
  return {
    applied: 0,
    duplicate: 0,
    stale: 0,
    deferred: [],
    released: [],
    collided: [],
    duplicates: [],
    content: new Map(),
    external: new Map(),
    pendingKnown: false,
  };
}

interface PendingRow {
  readonly op_id: string;
  readonly needs: string;
  readonly origin: number;
  readonly op: string;
}

/** Исход проекции одного LWW-поля или OR-Set-добавления. */
type ProjectOutcome = "applied" | "stale" | "collided";

export interface AddEdgeOptions {
  readonly weight?: number;
  readonly attrs?: Readonly<Record<string, JsonValue>>;
}

interface ClockRow {
  readonly hlc: string;
  readonly site_id: string;
}

interface EdgeClockRow extends ClockRow {
  readonly add_tag: string;
  readonly deleted_at: number | null;
}

/** Одно добавление OR-Set ребра, прочитанное из оплога. */
interface EdgeAdd {
  readonly tag: string;
  readonly weight: number;
  readonly hlc: Hlc;
  readonly site: string;
}

/** Порядок добавлений: часы, сайт, тег — полный и одинаковый на любой реплике. */
function compareEdgeAdd(a: EdgeAdd, b: EdgeAdd): number {
  const c = compareClock(a.hlc, a.site, b.hlc, b.site);
  if (c !== 0) return c;
  return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

interface EdgeRowState {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
}

interface ContentRow {
  readonly kind: string;
  readonly scope: string;
  readonly title: string;
  readonly body: string | null;
  readonly content_hash: string;
  readonly indexed: number;
}

/** Член группы идентичности: id плюс часы рождения (set(kind)). */
interface BornMember {
  readonly id: string;
  readonly born_hlc: string | null;
  readonly born_site: string | null;
}

interface ContentMember extends BornMember {
  readonly content_hash: string;
}

interface ExternalMember extends BornMember {
  readonly ext_dup: string;
}

/** Строка узла в терминах ux_nodes_external. */
interface ExternalRow {
  readonly kind: string;
  readonly scope: string;
  readonly ref: string | null;
  readonly ext_dup: string;
  readonly indexed: number;
}

interface ClaimCloseRow {
  readonly id: string;
  readonly scope: string;
  readonly ts_ms: number;
  readonly value: string;
  readonly site_id: string;
}

interface NodeHeadRow {
  readonly kind: string;
  readonly scope: string;
  readonly title: string;
  readonly body: string | null;
}

export interface OplogRow {
  readonly seq: number;
  readonly op_id: string;
  readonly site_id: string;
  /** CAST(hlc AS TEXT): точное 64-битное значение, см. readHlc. */
  readonly hlc: string;
  readonly ts_ms: number;
  readonly actor: string;
  readonly op: string;
  readonly entity: string;
  readonly entity_id: string;
  readonly field: string | null;
  readonly value: string | null;
  readonly scope: string;
  readonly origin: number;
}

/**
 * Результат успешного CAS-захвата (§9.4). `epoch` монотонно растёт при каждом
 * захвате — держатель с устаревшей эпохой не владеет задачей ни в каком смысле.
 */
export interface ClaimReceipt {
  readonly id: string;
  readonly holder: string;
  readonly epoch: number;
  /** lease_expires, мс по шкале HLC: hlc.ts + TTL. */
  readonly expiresAt: number;
}

/** Срез lease-состояния узла — для чтения, не для решений о захвате. */
export interface NodeLease {
  readonly id: string;
  readonly status: string;
  readonly holder: string;
  readonly epoch: number;
  readonly expires: number;
}

interface ClaimedRow {
  readonly id: string;
  readonly scope: string;
  readonly lease_epoch: number;
  readonly lease_expires: number;
}

type ClaimAction = "claim" | "renew" | "release" | "close";

const META_SITE_ID = "site_id";
const META_LAST_SEQ = "last_seq";
/** Строки рёбер пересобраны из множества OR-Set хотя бы раз (memory-86eqge02q8rd). */
export const META_EDGES_REPROJECTED = "edges_reprojected";

/** seq из op_id = `<site_id>:<seq>` (makeOpId); битый хвост читается как 0. */
function seqOfOpId(opId: string, siteId: string): number {
  const seq = Number(opId.slice(siteId.length + 1));
  return Number.isFinite(seq) ? seq : 0;
}

/** Ничья (hlc, site_id) при разных значениях — локально это ошибка, не выбор. */
function collisionError(op: Op, entityId: string): GraphError {
  return new GraphError(
    "graph.clock_collision",
    `field ${entityId}.${op.field}: the pair (hlc ${op.hlc.ts}:${op.hlc.ctr}, site ${op.site_id}) is already taken by a write with a different value — nothing can break the tie, write rejected`,
  );
}

/**
 * CRUD узлов и рёбер поверх оплога.
 *
 * Инвариант: любая мутация проходит через `journal()` — сначала запись в
 * oplog под UNIQUE(op_id), и только если она новая, применяется проекция.
 * Отсюда идемпотентность повтора и отсутствие расхождения между таблицами.
 */
export class GraphStore {
  readonly driver: DbDriver;
  readonly siteId: string;
  readonly actor: string;
  private readonly ops: OpFactory;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(driver: DbDriver, opts: GraphStoreOptions) {
    this.driver = driver;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId;

    const storedSite = driver.one<{ value: string }>(Q.meta_get, [
      META_SITE_ID,
    ])?.value;
    const siteId = storedSite ?? opts.siteId;
    if (siteId === undefined || siteId.length === 0) {
      throw new GraphError(
        "graph.range",
        "site_id is not set: neither in myc_meta nor in the GraphStore options",
      );
    }
    this.siteId = siteId;
    this.actor = opts.actor ?? "";

    // S3: seq монотонен на воркспейс и доступен как myc_meta.last_seq.
    // Подстраховка через оплог: myc_meta мог не пережить внешнюю правку базы,
    // а выдать второй раз тот же op_id нельзя ни при каких обстоятельствах.
    const metaSeq = Number(
      driver.one<{ value: string }>(Q.meta_get, [META_LAST_SEQ])?.value ?? 0,
    );
    const lastOwn = driver.one<{ op_id: string }>(Q.oplog_last_local_op_id, [
      siteId,
    ]);
    const logSeq = lastOwn === undefined ? 0 : seqOfOpId(lastOwn.op_id, siteId);
    this.ops = new OpFactory(siteId, {
      clock: this.seedClock(driver, siteId, opts.clock),
      lastSeq: Math.max(Number.isFinite(metaSeq) ? metaSeq : 0, logSeq),
    });
  }

  /**
   * S38: часы обязан поднимать движок, а не вызывающий. Новое соединение
   * стартует от последней своей записи в оплоге, иначе две записи одного
   * сайта в одну миллисекунду дают равную пару (hlc, site_id), и LWW молча
   * отбрасывает более позднюю. Оба чтения — хвост индекса и PK, O(log n).
   *
   * Переданные снаружи часы тоже поднимаются (через recv, как при приёме
   * чужой метки): забывший сидировать вызывающий не должен вернуть потерю.
   * Чужая запись в конце оплога подтягивает часы так же, как её сделал бы
   * applyOps в прошлом соединении — иначе следующая локальная правка
   * оказалась бы «старее» уже принятой чужой и отвалилась бы как stale.
   */
  private seedClock(
    driver: DbDriver,
    siteId: string,
    provided: HlcClock | undefined,
  ): HlcClock {
    const own = driver.one<{ hlc: string | null }>(Q.oplog_last_local_hlc, [
      siteId,
    ]);
    const ownHlc = own?.hlc == null ? undefined : readHlc(own.hlc);
    let clock: HlcClock;
    if (provided === undefined) {
      clock = new HlcClock({
        now: this.now,
        ...(ownHlc !== undefined ? { initial: ownHlc } : {}),
      });
    } else {
      clock = provided;
      if (ownHlc !== undefined && compareHlc(ownHlc, clock.state) > 0) {
        clock.recv(ownHlc);
      }
    }
    const last = driver.one<ClockRow>(Q.oplog_last_row_clock, []);
    if (last !== undefined && last.site_id !== siteId) {
      const lastHlc = readHlc(last.hlc);
      if (compareHlc(lastHlc, clock.state) > 0) clock.recv(lastHlc);
    }
    return clock;
  }

  /**
   * myc-4dy: выделять (seq, hlc) можно только под блокировкой записи.
   *
   * Сидирование в конструкторе (S38) выравнивает процесс с оплогом один раз,
   * на старте. Но CLI и долгоживущий MCP-сервер одного воркспейса пишут под
   * ОДНИМ site_id из разных процессов, и каждый держит свой seq и свои часы
   * в памяти. Две одновременные записи выдавали одинаковый op_id = site:seq,
   * ON CONFLICT DO NOTHING отбрасывал вторую как дубликат, и запись исчезала
   * без единого признака — тот же класс, что S38.
   *
   * Поэтому каждая пишущая транзакция BEGIN IMMEDIATE начинается отсюда: пока
   * держим RESERVED-блокировку, никто другой не зафиксирует запись, и
   * прочитанные здесь хвосты — последнее слово. seq берём из myc_meta.last_seq
   * (PK-lookup; каждый коммит его двигает в persistSeq), часы — из хвостов
   * индексов, как в seedClock. Три чтения O(log n) на запись — в бюджете 5 мс.
   *
   * Обязана вызываться ДО минтинга операций через this.ops: op_id и hlc,
   * выданные вне транзакции, могут быть уже заняты соседним процессом.
   */
  private syncTail(tx: DbDriver): void {
    const metaSeq = Number(
      tx.one<{ value: string }>(Q.meta_get, [META_LAST_SEQ])?.value ?? 0,
    );
    this.ops.advanceSeq(metaSeq);
    const clock = this.ops.clock;
    const own = tx.one<{ hlc: string | null }>(Q.oplog_last_local_hlc, [
      this.siteId,
    ]);
    if (own?.hlc != null) {
      const ownHlc = readHlc(own.hlc);
      if (compareHlc(ownHlc, clock.state) > 0) clock.recv(ownHlc);
    }
    const last = tx.one<ClockRow>(Q.oplog_last_row_clock, []);
    if (last !== undefined && last.site_id !== this.siteId) {
      const lastHlc = readHlc(last.hlc);
      if (compareHlc(lastHlc, clock.state) > 0) clock.recv(lastHlc);
    }
  }

  /** Часы сайта — их skew обязан попасть в отчёт sync как degraded (S30). */
  get clock(): HlcClock {
    return this.ops.clock;
  }

  get lastSeq(): number {
    return this.ops.lastSeq;
  }

  // -------------------------------------------------------------------------
  // Чтение
  // -------------------------------------------------------------------------

  getNode(id: string, includeDeleted = false): NodeRecord | undefined {
    const row = this.driver.one<RawRow>(
      includeDeleted ? Q.node_get : Q.node_get_live,
      [id],
    );
    return row === undefined ? undefined : rowToNode(row);
  }

  listNodes(scope: string, kind: string, limit = 100): NodeRecord[] {
    return this.driver
      .all<RawRow>(Q.node_list_by_kind, [scope, assertNodeKind(kind), limit])
      .map(rowToNode);
  }

  getEdge(src: string, type: EdgeKind, dst: string): EdgeRecord | undefined {
    const row = this.driver.one<RawRow>(Q.edge_get, [
      src,
      assertEdgeKind(type),
      dst,
    ]);
    return row === undefined ? undefined : rowToEdge(row);
  }

  /** Исходящие рёбра: прямое направление, как оно и хранится. */
  edgesFrom(src: string, type?: EdgeKind): EdgeRecord[] {
    const rows =
      type === undefined
        ? this.driver.all<RawRow>(Q.edges_from, [src])
        : this.driver.all<RawRow>(Q.edges_from_typed, [
            src,
            assertEdgeKind(type),
          ]);
    return rows.map(rowToEdge);
  }

  /**
   * Входящие рёбра — это и есть обратное отношение из §4.1 (`blocked_by`,
   * `children`, `superseded_by`, …). Обратное ребро виртуально: в базе
   * всегда лежит только прямая тройка.
   */
  edgesTo(dst: string, type?: EdgeKind): EdgeRecord[] {
    const rows =
      type === undefined
        ? this.driver.all<RawRow>(Q.edges_to, [dst])
        : this.driver.all<RawRow>(Q.edges_to_typed, [
            dst,
            assertEdgeKind(type),
          ]);
    return rows.map(rowToEdge);
  }

  /** Операции с seq > since — то, что уходит по `sync --since` и в SSE (S3). */
  opsSince(seq: number, limit = 1000): OplogRow[] {
    return this.driver.all<OplogRow>(Q.oplog_since, [seq, limit]);
  }

  oplogCount(): number {
    return this.driver.one<{ n: number }>(Q.oplog_count, [])?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // Запись
  // -------------------------------------------------------------------------

  /**
   * Создать узел. Одна транзакция: записи оплога, строка узла, часы полей
   * и стартовое значение G-counter'а `seen_count`.
   *
   * `excerpt` и `content_hash` считаются здесь же, детерминированно из body
   * и title (решение S5): ретривал обязан собрать первый проход выдачи, ни
   * разу не прочитав body.
   */
  createNode(input: NodeInput): NodeRecord {
    const id = input.id ?? this.newId();
    const kind = assertNodeKind(input.kind);
    const fields = nodeInputFields(input);
    // myc-9ok: `actor` — реплицируемое поле (NODE_FIELDS), а не колонка
    // журнала. Локально строка получала this.actor без операции в оплоге,
    // и реплика материализовала узел с actor = '' — колонка расходилась
    // между машинами. Ровно одна set-операция на узел, как у любого поля.
    if (!fields.some(([field]) => field === "actor")) {
      fields.push(["actor", this.actor]);
    }
    const ts = this.now();
    const scope = String(input.scope ?? "");

    const columns = new Map<string, string | number | null>();
    const attrs: Record<string, JsonValue> = {};
    for (const [field, value] of fields) {
      const key = attrKeyOf(field);
      if (key !== undefined) {
        attrs[key] = value;
        continue;
      }
      const spec = assertNodeField(field);
      if (spec === "attr") continue;
      columns.set(field, coerceNodeFieldValue(spec, value));
    }

    const title = String(columns.get("title") ?? "");
    const body = (columns.get("body") ?? null) as string | null;

    const row: Record<string, unknown> = {
      id,
      kind,
      layer: columns.get("layer"),
      scope,
      title,
      body,
      body_cold: 0,
      excerpt: makeExcerpt(body),
      status: columns.get("status"),
      priority: columns.get("priority") ?? 2,
      confidence: columns.get("confidence") ?? 1.0,
      salience: columns.get("salience") ?? 1.0,
      seen_count: 1,
      head_id: columns.get("head_id") ?? null,
      content_hash: contentHash(kind, title, body),
      acl: columns.get("acl") ?? "team",
      owner_id: columns.get("owner_id") ?? "",
      team_id: columns.get("team_id") ?? "",
      agent_id: columns.get("agent_id") ?? "",
      assignee: columns.get("assignee") ?? "",
      actor: columns.get("actor") ?? this.actor,
      created_at: ts,
      updated_at: ts,
      accessed_at: 0,
      due_at: columns.get("due_at") ?? null,
      closed_at: columns.get("closed_at") ?? null,
      compacted_at: null,
      deleted_at: null,
      hlc: 0,
      site_id: this.siteId,
      attrs: JSON.stringify(attrs),
    };

    return this.driver.tx("immediate", (tx) => {
      // Операции минтятся под блокировкой записи (myc-4dy), не раньше.
      this.syncTail(tx);
      const setOps = fields.map(([field, value]) =>
        this.ops.set(id, field, value),
      );
      const incOp = this.ops.inc(id, "seen_count", 1);
      row.hlc = packHlc(setOps[0]!.hlc);
      const bound = NODE_INSERT_COLUMNS.map((c) => row[c] ?? null);

      for (const op of setOps) this.journalLocal(tx, op, "node", id, scope);
      this.journalLocal(tx, incOp, "node", id, scope);
      // Новый узел рождается держателем (ext_dup = '') и держится правилом
      // одним UNIQUE. Группа без держателя (holdExternal) его бы пропустила:
      // сначала ссылка достаётся её старшему живому члену.
      const ref = attrs["external_ref"];
      if (typeof ref === "string") this.holdExternal(tx, { scope, kind, ref }, NO_IDS);
      tx.run(Q.node_insert, bound);

      for (const op of setOps) {
        tx.run(Q.field_clock_set, [
          id,
          op.field,
          packHlc(op.hlc),
          op.site_id,
        ]);
      }
      tx.run(Q.counter_set, [id, "seen_count", this.siteId, 1]);
      // memory-nvx51d0kgf2t: узел с явным id мог быть нужен отложенной чужой
      // операции. Её зависимость выполнена здесь и сейчас, а не «когда-нибудь
      // при следующем applyOps» — пустая таблица стоит одного спуска.
      if (tx.one(Q.pending_any, []) !== undefined) {
        const tally = newTally();
        tally.pendingKnown = true;
        this.drainPending(tx, tally);
        this.settleIdentity(tx, tally, false);
      }
      this.persistSeq(tx);

      const created = tx.one<RawRow>(Q.node_get, [id]);
      if (created === undefined) {
        throw new GraphError("graph.not_found", `node ${id} was not written`);
      }
      return rowToNode(created);
    });
  }

  /**
   * Обновить узел. В оплог уходят только реально изменившиеся поля: запись
   * «то же значение» не несёт информации, но стоит строки в оплоге и сдвига
   * часов поля, из-за которого чужая правка потом молча проиграет LWW.
   */
  updateNode(id: string, patch: NodePatch): NodeRecord {
    const current = this.getNode(id, true);
    if (current === undefined) {
      throw new GraphError("graph.not_found", `node ${id} not found`);
    }
    const kind = assertNodeKind(current.kind);
    const changed = nodePatchFields(kind, patch).filter(([field, value]) => {
      const key = attrKeyOf(field);
      if (key !== undefined) {
        return JSON.stringify(current.attrs[key]) !== JSON.stringify(value);
      }
      return (current as unknown as Record<string, unknown>)[field] !== value;
    });
    if (changed.length === 0) return current;

    this.applyLocal(
      () => changed.map(([field, value]) => this.ops.set(id, field, value)),
      id,
      current.scope,
    );
    const after = this.getNode(id, true);
    if (after === undefined) {
      throw new GraphError("graph.not_found", `node ${id} vanished during the write`);
    }
    return after;
  }

  /**
   * Мягкое удаление: одно LWW-поле `deleted_at`. Строка остаётся — на неё
   * ссылаются рёбра и оплог, а FTS-строку снимает триггер trg_fts_au.
   */
  deleteNode(id: string, at?: number): boolean {
    const current = this.getNode(id, true);
    if (current === undefined || current.deleted_at !== null) return false;
    this.applyLocal(
      () => [this.ops.set(id, "deleted_at", at ?? this.now())],
      id,
      current.scope,
    );
    return true;
  }

  /** Обратная операция: узел снова виден. */
  restoreNode(id: string): boolean {
    const current = this.getNode(id, true);
    if (current === undefined || current.deleted_at === null) return false;
    this.applyLocal(() => [this.ops.set(id, "deleted_at", null)], id, current.scope);
    return true;
  }

  /**
   * G-counter: подтверждение факта (§2.2, `seen_count`). В оплог уходит новое
   * накопленное значение ЭТОГО сайта, колонка пересчитывается как сумма по
   * всем сайтам — сложение остаётся идемпотентным и коммутативным.
   */
  bumpCounter(id: string, field: string, delta = 1): number {
    if (!Number.isInteger(delta) || delta <= 0) {
      throw new GraphError(
        "graph.range",
        `G-counter increment must be a positive integer, got ${delta}`,
      );
    }
    const current = this.getNode(id, true);
    if (current === undefined) {
      throw new GraphError("graph.not_found", `node ${id} not found`);
    }
    // Накопленное значение сайта читается под той же блокировкой, что и
    // запись: соседний процесс того же site_id мог поднять его между чтением
    // и записью, и поэлементный максимум G-counter'а потерял бы его дельту.
    this.applyLocal(
      (tx) => {
        const mine =
          tx.one<{ value: number }>(Q.counter_get, [id, field, this.siteId])
            ?.value ?? 0;
        return [this.ops.inc(id, field, mine + delta)];
      },
      id,
      current.scope,
    );
    return (
      this.driver.one<{ total: number }>(Q.counter_sum, [id, field])?.total ?? 0
    );
  }

  /**
   * Добавить ребро. Тип обязан быть одним из одиннадцати (§4.1); семантика
   * типов не взаимозаменяема, поэтому подстановки «похожего» типа здесь нет.
   *
   * Ацикличность (§4.3) проверяется ЗДЕСЬ, до записи в оплог, и по-разному у
   * двух ацикличных типов: `parent` ловится замыканием внутри
   * `applyParentEdgeAdd` (у него есть таблица `parent_closure`), `blocks` —
   * обходом с пределом глубины (cycle.ts), потому что транзитивной таблицы
   * у него нет. Оба отказа бросают до `journalLocal`/`projectEdgeAdd`, то
   * есть транзакция не оставляет следа ни в проекции, ни в оплоге.
   *
   * Чужие операции (`applyOps`) сюда не заходят и проверке не подлежат:
   * §4.3 требует цикл, собранный мержем, помечать, а не отвергать.
   */
  addEdge(
    src: string,
    type: EdgeKind,
    dst: string,
    opts: AddEdgeOptions = {},
  ): EdgeRecord {
    const edgeType = assertEdgeKind(type);
    assertEdgeEndpoints(src, dst);
    const source = this.getNode(src, true);
    if (source === undefined) {
      throw new GraphError("graph.not_found", `src node ${src} not found`);
    }
    if (this.getNode(dst, true) === undefined) {
      throw new GraphError("graph.not_found", `dst node ${dst} not found`);
    }
    const entityId = edgeEntityId(src, edgeType, dst);
    const attrs = JSON.stringify(opts.attrs ?? {});

    this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      // `parent` проверяется ниже, замыканием: там факт «dst уже потомок src»
      // стоит один спуск по parent_closure, а обход был бы лишней работой.
      if (EDGE_SEMANTICS[edgeType].acyclic && edgeType !== "parent") {
        checkEdgeAcyclic(tx, src, edgeType, dst, EDGE_SEMANTICS[edgeType].maxDepth);
      }
      const op = this.ops.edgeAdd(src, edgeType, dst, opts.weight);
      this.journalLocal(tx, op, "edge", entityId, source.scope);
      if (this.projectEdgeAdd(tx, op, { actor: this.actor, attrs }) === "collided") {
        throw collisionError(op, entityId);
      }
      if (edgeType === "parent") this.applyParentEdgeAdd(tx, src, dst);
      this.persistSeq(tx);
    });

    const created = this.getEdge(src, edgeType, dst);
    if (created === undefined) {
      throw new GraphError("graph.not_found", `edge ${entityId} was not written`);
    }
    return created;
  }

  /**
   * Мягкое удаление ребра. В операцию попадают ВСЕ теги, живые в базе НА
   * МОМЕНТ удаления, — добавления, которых этот сайт не видел, переживут
   * удаление. Это add-wins из OR-Set, а не «удалить всё, что похоже».
   * Прежде уходил один тег представителя: второе живое добавление, уже
   * увиденное этим сайтом, удаление переживало, и ребро воскресало на
   * реплике, применившей операции в другом порядке (memory-86eqge02q8rd).
   * Теги читаются под блокировкой записи: соседний процесс мог добавить.
   */
  removeEdge(src: string, type: EdgeKind, dst: string): boolean {
    const edgeType = assertEdgeKind(type);
    const edge = this.getEdge(src, edgeType, dst);
    if (edge === undefined || edge.deleted_at !== null) return false;
    const scope = this.getNode(src, true)?.scope ?? "";
    const entityId = edgeEntityId(src, edgeType, dst);

    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const tags = this.liveEdgeTags(tx, src, edgeType, dst);
      if (tags.length === 0) return false;
      const op = this.ops.edgeDel(src, edgeType, dst, tags);
      this.journalLocal(tx, op, "edge", entityId, scope);
      this.projectEdgeDel(tx, op);
      if (edgeType === "parent") this.applyParentEdgeRemove(tx, src, dst);
      this.persistSeq(tx);
      return true;
    });
  }

  /**
   * Материализовать parent_closure для addEdge(type='parent') внутри той же
   * транзакции. `dst` уже прямой родитель `src` — переигранное (OR-Set) или
   * дублирующее добавление того же ребра, замыкание уже верное, трогать
   * нечего. Другой прямой родитель есть — это перенос поддерева одним
   * публичным вызовом: старое ребро `child→current` обязано погаснуть на
   * уровне edges/oplog в той же транзакции (иначе у ребёнка осталось бы два
   * живых родительских ребра, и `rebuildParentClosure` разошёлся бы с
   * `applyParentMove`), а замыкание переносится одним вызовом
   * applyParentMove, а не парой insert/remove — см. докстрок applyParentMove
   * в closure.ts про то, почему это не два отдельных шага.
   */
  private applyParentEdgeAdd(tx: DbDriver, child: string, parent: string): void {
    const current = ancestorsOf(tx, child).find((a) => a.depth === 1)?.ancestor;
    if (current === parent) return;
    if (current === undefined) {
      applyParentInsert(tx, child, parent);
      return;
    }
    const oldEdge = tx.one<EdgeClockRow>(Q.edge_clock_get, [child, "parent", current]);
    const oldTags = oldEdge?.deleted_at === null ? this.liveEdgeTags(tx, child, "parent", current) : [];
    if (oldTags.length > 0) {
      const scope = tx.one<NodeHeadRow>(Q.node_head, [child])?.scope ?? "";
      const delOp = this.ops.edgeDel(child, "parent", current, oldTags);
      const oldEntityId = edgeEntityId(child, "parent", current);
      this.journalLocal(tx, delOp, "edge", oldEntityId, scope);
      this.projectEdgeDel(tx, delOp);
    }
    applyParentMove(tx, child, parent);
  }

  /**
   * Симметрично applyParentEdgeAdd для removeEdge(type='parent'). `parent` не
   * прямой родитель `child` в замыкании — либо ребро уже небыло материализовано
   * (не должно случаться при консистентном состоянии), либо это тумбстоун
   * старого add_tag поверх edge, который add-wins уже пережил; в обоих случаях
   * замыкание не трогаем, чтобы не снести чужой живой parent.
   */
  private applyParentEdgeRemove(tx: DbDriver, child: string, parent: string): void {
    const current = ancestorsOf(tx, child).find((a) => a.depth === 1)?.ancestor;
    if (current !== parent) return;
    applyParentRemove(tx, child, parent);
  }

  // -------------------------------------------------------------------------
  // Приём чужих операций
  // -------------------------------------------------------------------------

  /**
   * Применить пакет операций (пришедших по sync или перечитанных из оплога).
   *
   * Порядок внутри пакета — по (hlc, site_id) возрастанию (§9.3); каузальная
   * доставка не требуется: LWW, OR-Set и G-counter коммутативны. Часы
   * подтягиваются через recv, который зажимает съехавшую метку порогом,
   * а не отвергает операцию (решение S30).
   *
   * Порядок МЕЖДУ пакетами не гарантирован в принципе (myc-qie.9): ребро
   * может приехать раньше своих концов, `set(title)` — раньше `set(kind)`.
   * Такая операция не падает и не теряется: она паркуется в oplog_pending
   * с именем недостающего узла и применяется в первой транзакции, где этот
   * узел уже есть, — как бы он ни появился (memory-nvx51d0kgf2t). Итог не
   * зависит от нарезки на пакеты: тот же набор операций в любом порядке
   * даёт то же состояние, что и упорядоченный.
   *
   * Контент-дубликат одного узла не роняет пакет (memory-0fs4rfa6xmha): он
   * разрешается детерминированно и попадает в `duplicates`.
   */
  applyOps(ops: readonly Op[], origin: 0 | 1 = 0): ApplyResult {
    const sorted = [...ops].sort((a, b) =>
      compareClock(a.hlc, a.site_id, b.hlc, b.site_id),
    );
    for (const op of sorted) this.clock.recv(op.hlc);

    // kind из самого пакета: строка узла не может появиться без него
    // (NOT NULL + CHECK), а порядок операций внутри пакета произволен.
    const kindInBatch = new Map<string, string>();
    for (const op of sorted) {
      if (op.op === "set" && op.field === "kind" && typeof op.value === "string") {
        kindInBatch.set(op.entity_id, op.value);
      }
    }

    const tally = newTally();

    this.driver.tx("immediate", (tx) => {
      // Локальных op_id здесь не выдаём, но persistSeq в конце не имеет права
      // откатить myc_meta.last_seq ниже того, что уже зафиксировал соседний
      // процесс этого же site_id.
      this.syncTail(tx);
      if (tx.one(Q.pending_any, []) !== undefined) {
        tally.pendingKnown = true;
        // База, где строка ожидания пережила применение своей операции.
        tx.run(Q.pending_phantoms_delete, []);
      }
      for (const op of sorted) {
        const needs = this.applyOne(tx, op, origin, kindInBatch, tally);
        if (needs !== undefined) this.park(tx, op, origin, needs, tally);
      }
      if (tally.pendingKnown) this.drainPending(tx, tally);
      this.settleIdentity(tx, tally, false);
      this.persistSeq(tx);
    });

    return {
      applied: tally.applied,
      duplicate: tally.duplicate,
      stale: tally.stale,
      deferred: tally.deferred,
      released: tally.released,
      collided: tally.collided,
      duplicates: tally.duplicates,
    };
  }

  /**
   * Одна операция внутри транзакции applyOps. Возвращает id узла, без
   * которого операцию применить нельзя, либо undefined — операция учтена
   * в `tally` (applied / duplicate / stale / collided).
   */
  private applyOne(
    tx: DbDriver,
    op: Op,
    origin: 0 | 1,
    kindHint: ReadonlyMap<string, string>,
    tally: ApplyTally,
  ): string | undefined {
    if (op.op === "edge_add" || op.op === "edge_del") {
      const { src, type, dst } = splitMemoryEdgeKey(op.entity_id);
      // Оба конца обязаны существовать: edges ссылается на nodes через
      // FOREIGN KEY, и вставка сироты откатила бы весь пакет.
      const srcHead = tx.one<NodeHeadRow>(Q.node_head, [src]);
      if (srcHead === undefined) return src;
      if (tx.one<NodeHeadRow>(Q.node_head, [dst]) === undefined) return dst;
      const entityId = edgeEntityId(src, type, dst);
      if (!this.journal(tx, op, "edge", entityId, srcHead.scope, origin)) {
        tally.duplicate++;
        this.unpark(tx, op.op_id, tally, false);
        return undefined;
      }
      if (op.op === "edge_add") {
        const outcome = this.projectEdgeAdd(tx, op);
        if (outcome === "collided") tally.collided.push(op.op_id);
        else tally.applied++;
      } else {
        this.projectEdgeDel(tx, op);
        tally.applied++;
      }
      this.unpark(tx, op.op_id, tally, true);
      return undefined;
    }

    // set / inc: проекция невозможна, пока строки узла нет. Такую
    // операцию нельзя и журналировать — дедупликация по op_id закрыла бы
    // повторную попытку навсегда.
    let head = tx.one<NodeHeadRow>(Q.node_head, [op.entity_id]);
    if (head === undefined && op.op === "set") {
      const kind =
        op.field === "kind" && typeof op.value === "string"
          ? op.value
          : kindHint.get(op.entity_id);
      if (this.materializeNode(tx, op.entity_id, kind)) {
        // Родился в этой транзакции: прежних групп — ни контентной, ни по
        // внешней ссылке — у него нет.
        tally.content.set(op.entity_id, null);
        tally.external.set(op.entity_id, null);
        head = tx.one<NodeHeadRow>(Q.node_head, [op.entity_id]);
      }
    }
    if (head === undefined) return op.entity_id;
    if (!this.journal(tx, op, "node", op.entity_id, head.scope, origin)) {
      tally.duplicate++;
      this.unpark(tx, op.op_id, tally, false);
      return undefined;
    }
    if (op.op === "set") {
      const outcome = this.projectSet(tx, op, this.identityTouch(tx, op.field, op.entity_id, tally));
      if (outcome === "applied") {
        tally.applied++;
      } else if (outcome === "stale") {
        tally.stale++;
      } else {
        tally.collided.push(op.op_id);
      }
    } else {
      this.projectInc(tx, op);
      tally.applied++;
    }
    this.unpark(tx, op.op_id, tally, true);
    return undefined;
  }

  /** Отложить операцию до появления узла `needs` (myc-qie.9). */
  private park(
    tx: DbDriver,
    op: Op,
    origin: 0 | 1,
    needs: string,
    tally: ApplyTally,
  ): void {
    tx.run(Q.pending_insert, [
      op.op_id,
      needs,
      origin,
      JSON.stringify(op),
      this.now(),
    ]);
    tally.pendingKnown = true;
    tally.deferred.push(op.op_id);
  }

  /**
   * Операция журналирована — её строка ожидания больше не нужна. Прежде она
   * оставалась, если операцию применила повторная доставка, а не дренаж:
   * фантом навсегда висел в pendingCount(). Применённая сейчас после
   * парковки в прошлом вызове — это `released`: вызывающий показывал её как
   * deferred. Повтор по op_id (`appliedNow = false`) — только уборка.
   */
  private unpark(tx: DbDriver, opId: string, tally: ApplyTally, appliedNow: boolean): void {
    if (!tally.pendingKnown) return;
    if (tx.run(Q.pending_delete, [opId]).changes === 0 || !appliedNow) return;
    const i = tally.deferred.indexOf(opId);
    if (i >= 0) tally.deferred.splice(i, 1);
    if (!tally.released.includes(opId)) tally.released.push(opId);
  }

  /**
   * Применить отложенное, чей недостающий узел уже есть в базе — как бы он
   * ни появился: родился в этой транзакции, создан локально с явным id,
   * приехал переездом, лежал в базе, где строка ожидания застряла при
   * прежнем коде. Прежний дренаж видел только узлы, рождённые в той же
   * транзакции applyOps, остальное ждало вечно (memory-nvx51d0kgf2t).
   * Круги повторяются, пока появляются узлы: цепочки (ребро ждало узел,
   * узел ждал kind) раскручиваются до конца. Операция, которой всё ещё
   * чего-то не хватает (второй конец ребра), перекладывается на новый
   * недостающий узел — которого нет, так что круг конечен.
   */
  private drainPending(tx: DbDriver, tally: ApplyTally): void {
    const none: ReadonlyMap<string, string> = new Map();
    for (;;) {
      const rows = tx.all<PendingRow>(Q.pending_ready, []);
      if (rows.length === 0) return;
      for (const row of rows) {
        tx.run(Q.pending_delete, [row.op_id]);
        const op = JSON.parse(row.op) as Op;
        const origin: 0 | 1 = row.origin === 1 ? 1 : 0;
        this.clock.recv(op.hlc);
        const needs = this.applyOne(tx, op, origin, none, tally);
        if (needs !== undefined) {
          // Один раз она уже в deferred этого или прошлого вызова; здесь
          // важна только смена ключа ожидания.
          tx.run(Q.pending_insert, [row.op_id, needs, origin, row.op, this.now()]);
          if (!tally.deferred.includes(row.op_id)) tally.deferred.push(row.op_id);
          continue;
        }
        const wasDeferredNow = tally.deferred.indexOf(row.op_id);
        if (wasDeferredNow >= 0) tally.deferred.splice(wasDeferredNow, 1);
        if (!tally.released.includes(row.op_id)) tally.released.push(row.op_id);
      }
    }
  }

  /**
   * Сколько операций ждёт своих зависимостей — для doctor и sync (И2).
   * Честно: уже журналированная операция не ждёт ничего, даже если её
   * строка ожидания пережила применение.
   */
  pendingCount(): number {
    return this.driver.one<{ n: number }>(Q.pending_count, [])?.n ?? 0;
  }

  /** Отложенные операции с именем недостающего узла. */
  pendingOps(limit = 1000): Array<{ readonly op: Op; readonly needs: string; readonly origin: 0 | 1 }> {
    return this.driver.all<PendingRow>(Q.pending_list, [limit]).map((row) => ({
      op: JSON.parse(row.op) as Op,
      needs: row.needs,
      origin: row.origin === 1 ? 1 : 0,
    }));
  }

  /**
   * Живые контент-дубликаты с их каноническим узлом (memory-0fs4rfa6xmha) —
   * для doctor и web. Пусто ⇒ дубликатов нет. Полный проход по nodes: это
   * диагностика, не горячий путь.
   */
  contentDuplicates(): Array<{ readonly id: string; readonly of: string; readonly scope: string; readonly kind: string }> {
    return this.driver.all(Q.content_duplicates, []);
  }

  /**
   * Живые ввезённые дубликаты с их держателем ссылки (memory-gemeb3d8wj41) —
   * для doctor и web. `ref` назван явно: две машины, ввёзшие одну запись
   * beads, — это вопрос к источнику, и человеку нужен именно его id.
   */
  externalDuplicates(): Array<{
    readonly id: string;
    readonly of: string;
    readonly scope: string;
    readonly kind: string;
    readonly ref: string;
  }> {
    return this.driver.all(Q.external_duplicates, []);
  }

  /**
   * Пересчитать open_blockers по рёбрам и статусам. Триггеры ведут счётчик
   * при мягких мутациях; жёсткое удаление (purge, ON DELETE CASCADE) ими
   * не покрыто by design, и после него счётчик восстанавливается отсюда.
   * Возвращает число узлов, у которых он до пересчёта расходился.
   */
  recountOpenBlockers(): number {
    return this.driver.tx("immediate", (tx) => {
      // Оба расхождения меряются ДО любого ремонта: пересчёт open_blockers
      // пересекает нули и будит trg_anc_*, и замер после него не увидел бы
      // наследованного расхождения вовсе.
      const drift = tx.all<{ id: string }>(Q.open_blockers_drift, []).length;
      const ancDrift = tx.all<{ id: string }>(Q.anc_blockers_drift, []).length;
      tx.run(Q.recount_open_blockers, []);
      // Наследование пишется ПОСЛЕ и в той же транзакции: оно читает уже
      // исправленные open_blockers предков и перезаписывает счётчик целиком,
      // а не досчитывает то, что успели натворить триггеры.
      tx.run(Q.recount_anc_blockers, []);
      return drift + ancDrift;
    });
  }

  /** Узлы, у которых счётчик разошёлся с пересчётом. Пусто ⇒ сходится. */
  openBlockersDrift(): Array<{ id: string; stored: number; actual: number }> {
    return this.driver.all(Q.open_blockers_drift, []);
  }

  /**
   * То же для наследованного счётчика (миграция 10): узлы, у которых
   * `anc_blockers` разошёлся с пересчётом по `parent_closure`. Пусто ⇒ сходится.
   */
  ancBlockersDrift(): Array<{ id: string; stored: number; actual: number }> {
    return this.driver.all(Q.anc_blockers_drift, []);
  }

  /**
   * Предки узла по `parent`, держащие открытый блокер, ближний первым.
   * Ровно те, из-за кого `anc_blockers > 0` и задача не в очереди.
   */
  blockingAncestors(
    id: string,
  ): Array<{ id: string; title: string; status: string; open_blockers: number; depth: number }> {
    return this.driver.all(Q.anc_blocking, [id]);
  }

  // -------------------------------------------------------------------------
  // Claim: атомарный захват задачи (§9.4, решение S35)
  //
  // Lease-поля не входят в NODE_FIELDS и не идут через per-field LWW:
  // взаимное исключение — не LWW-задача, офлайновый агент с более поздними
  // часами не должен «украсть» задачу. Роль LWW здесь играет CAS-предикат
  // в одном UPDATE плюс монотонный lease_epoch. Операции не теряют оплог:
  // каждая пишется строкой op='claim' (CHECK в DDL разрешает этот kind),
  // значение — {action, holder, epoch, expires}. Проекция чужих claim-операций
  // при синхронизации — правило merge_claim (§9.4), отдельная задача sync.
  // -------------------------------------------------------------------------

  /**
   * Захватить задачу. Один стейтмент: условие и запись атомарны, между
   * чтением и записью окна нет. CAS сначала, journal после: проигравший гонку
   * не должен оставить строку в оплоге, а внутри одной BEGIN IMMEDIATE обе
   * записи коммитятся атомарно — половинчатого состояния не бывает.
   * `undefined` — задачу забрали (или она не открыта): брать следующую из ready.
   */
  claimNode(id: string, holder?: string, ttlMs: number = LEASE_TTL_MS): ClaimReceipt | undefined {
    const who = holder ?? this.actor;
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const meta = this.ops.set(id, "lease", { action: "claim", holder: who });
      const expiresAt = meta.hlc.ts + ttlMs;
      const claimed = tx.one<ClaimedRow>(Q.claim_node, [
        id,
        who,
        expiresAt,
        meta.hlc.ts,
        packHlc(meta.hlc),
        this.siteId,
      ]);
      if (claimed === undefined) return undefined; // changes()==0
      this.journalClaim(
        tx,
        meta,
        id,
        claimed.scope,
        "claim",
        who,
        claimed.lease_epoch,
        expiresAt,
      );
      this.persistSeq(tx);
      return {
        id,
        holder: who,
        epoch: claimed.lease_epoch,
        expiresAt: claimed.lease_expires,
      };
    });
  }

  /**
   * Продлить аренду. Пишет только текущий держатель с текущей эпохой:
   * воскресший держатель (пока он спал, задачу успели перезахватить и эпоха
   * ушла вперёд) получает `undefined` и не продлевает ничего.
   */
  renewLease(
    id: string,
    holder: string,
    epoch: number,
    ttlMs: number = LEASE_TTL_MS,
  ): number | undefined {
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const meta = this.ops.set(id, "lease", { action: "renew", holder, epoch });
      const expiresAt = meta.hlc.ts + ttlMs;
      const row = tx.one<{ scope: string }>(Q.lease_renew, [
        id,
        holder,
        epoch,
        expiresAt,
        meta.hlc.ts,
        packHlc(meta.hlc),
        this.siteId,
      ]);
      if (row === undefined) return undefined;
      this.journalClaim(tx, meta, id, row.scope, "renew", holder, epoch, expiresAt);
      this.persistSeq(tx);
      return expiresAt;
    });
  }

  /**
   * Явное освобождение: задача возвращается в open с пустым lease. Как и
   * продление — только у текущего держателя с текущей эпохой.
   */
  releaseLease(id: string, holder: string, epoch: number): boolean {
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const meta = this.ops.set(id, "lease", { action: "release", holder, epoch });
      const row = tx.one<{ scope: string }>(Q.lease_release, [
        id,
        holder,
        epoch,
        meta.hlc.ts,
        packHlc(meta.hlc),
        this.siteId,
      ]);
      if (row === undefined) return false;
      this.journalClaim(tx, meta, id, row.scope, "release", holder, epoch, 0);
      this.persistSeq(tx);
      return true;
    });
  }

  /**
   * Закрыть взятую задачу: status='closed' (шкала статусов task, §2.2) плюс
   * очистка lease одним CAS-стейтментом. Задача, перехваченная другим агентом,
   * у воскресшего держателя не закроется — эпоха уже не его.
   *
   * memory-tvw65jjgaheh: закрытие — не аренда, а конец задачи, и обязано
   * доехать до реплик. Строка op='claim' локальна (не реплицируется, см.
   * REPLICATED_OPS), а CAS писал status и closed_at мимо field_clock. Итог:
   * на другой машине задача оставалась open и бралась в работу повторно, а
   * здесь любая чужая правка статуса, старшая записи создания, молча
   * переписывала 'closed'. Поэтому в той же транзакции закрытие выражается
   * обычными LWW-записями — status, closed_at и assignee (кто закрыл; claim
   * писал его в колонку без операции) — и реплицируется как любая правка.
   */
  closeClaimed(id: string, holder: string, epoch: number): boolean {
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const meta = this.ops.set(id, "lease", { action: "close", holder, epoch });
      const row = tx.one<{ scope: string }>(Q.lease_close, [
        id,
        holder,
        epoch,
        meta.hlc.ts,
        meta.hlc.ts,
        packHlc(meta.hlc),
        this.siteId,
      ]);
      if (row === undefined) return false;
      this.journalClaim(tx, meta, id, row.scope, "close", holder, epoch, 0);
      this.expressClose(tx, id, row.scope, meta.hlc.ts, holder);
      this.persistSeq(tx);
      return true;
    });
  }

  /**
   * Закрытие как LWW-записи: status='closed', closed_at, assignee. Операции
   * минтятся здесь, под той же блокировкой записи (myc-4dy).
   */
  private expressClose(
    tx: DbDriver,
    id: string,
    scope: string,
    closedAt: number,
    holder: string,
  ): void {
    const sets: SetOp[] = [
      this.ops.set(id, "status", "closed"),
      this.ops.set(id, "closed_at", closedAt),
    ];
    if (holder.length > 0) sets.push(this.ops.set(id, "assignee", holder));
    for (const op of sets) {
      this.journalLocal(tx, op, "node", id, scope);
      if (this.projectSet(tx, op) === "collided") throw collisionError(op, id);
    }
  }

  /**
   * Бэкфилл закрытий, журналированных до правки memory-tvw65jjgaheh только
   * строкой op='claim': такие закрытия не доехали ни до одной реплики. Для
   * каждого узла, где последнее закрытие через claim новее любой LWW-записи
   * статуса (см. Q.claim_close_unexpressed), закрытие выражается сейчас —
   * теми же тремя set, что пишет closeClaimed; closed_at и assignee берутся
   * из самой строки claim. Часы у новых операций свежие, а не часы исходного
   * закрытия: выдать старую метку под новым seq значило бы сломать
   * инвариант «seq и hlc сайта растут вместе» (восстановление seq из хвоста
   * оплога). Цена — окно: чужая правка статуса, сделанная между исходным
   * закрытием и бэкфиллом и ещё не импортированная сюда, проиграет ему.
   *
   * Идемпотентно: после бэкфилла field_clock статуса новее строки claim,
   * второй вызов не находит ничего. `ids` — ограничить узлами (переезд).
   * Возвращает узлы, чьи закрытия выражены.
   */
  backfillClaimCloses(ids?: readonly string[]): string[] {
    const only = ids === undefined ? undefined : new Set(ids);
    const pick = (rows: readonly ClaimCloseRow[]): ClaimCloseRow[] =>
      only === undefined ? [...rows] : rows.filter((r) => only.has(r.id));
    if (pick(this.driver.all<ClaimCloseRow>(Q.claim_close_unexpressed, [])).length === 0) return [];
    return this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      // Перечитать под блокировкой: соседний процесс мог успеть сам.
      const rows = pick(tx.all<ClaimCloseRow>(Q.claim_close_unexpressed, []));
      const done: string[] = [];
      for (const row of rows) {
        let holder = "";
        try {
          const v = JSON.parse(row.value) as { holder?: unknown };
          if (typeof v.holder === "string") holder = v.holder;
        } catch {
          // значение строки claim битое — закрываем без assignee
        }
        this.expressClose(tx, row.id, row.scope, row.ts_ms, holder);
        done.push(row.id);
      }
      this.persistSeq(tx);
      return done;
    });
  }

  /**
   * Пересобрать строки всех рёбер из множества OR-Set (оплог + тумбстоуны) —
   * ремонт реплик, разошедшихся при прежней проекции (memory-86eqge02q8rd).
   * Новые операции чинят только свой ключ; ключ, который больше никто не
   * тронет, остался бы разошедшимся навсегда — дедупликация по op_id
   * переиграть его не даст. Одна транзакция, полный проход по edges: это
   * ремонт (doctor), не горячий путь. open_blockers ведут триггеры на
   * deleted_at. Возвращает, сколько строк отличалось от пересчёта.
   */
  reprojectEdges(): number {
    return this.driver.tx("immediate", (tx) => {
      tx.run(Q.meta_set, [META_EDGES_REPROJECTED, "1"]);
      const before = tx.all<EdgeRowState>(Q.edges_state, []);
      for (const e of before) {
        this.reprojectEdge(tx, e.src, e.type, e.dst, this.readEdgeAdds(tx, edgeEntityId(e.src, e.type, e.dst)));
      }
      const after = new Map(
        tx.all<EdgeRowState>(Q.edges_state, []).map((e) => [`${e.src}|${e.type}|${e.dst}`, JSON.stringify(e)]),
      );
      let changed = 0;
      for (const e of before) {
        if (after.get(`${e.src}|${e.type}|${e.dst}`) !== JSON.stringify(e)) changed++;
      }
      return changed;
    });
  }

  /**
   * Одноразовый ремонт (см. reprojectEdges) для базы, где он ещё не шёл:
   * флаг в myc_meta, не миграция схемы. Зовёт importGraph — точка, где
   * реплика и так сверяется с остальными. `undefined` — ремонт уже был.
   */
  reprojectEdgesOnce(): number | undefined {
    if (this.driver.one<{ value: string }>(Q.meta_get, [META_EDGES_REPROJECTED])?.value === "1") {
      return undefined;
    }
    return this.reprojectEdges();
  }

  /** Срез lease-состояния. Для наблюдения; решения о захвате принимает только CAS. */
  leaseOf(id: string): NodeLease | undefined {
    return this.driver.one(Q.lease_get, [id]);
  }

  /**
   * Оплог-запись lease-мутации — тот же oplog_insert, что у journal(), но с
   * op='claim': lease-поля вне NODE_FIELDS, отдельного типа Op у них нет до
   * задачи sync (rowToOp на 'claim' падает намеренно). Дедуп по op_id здесь
   * недостижим (seq выделен под блокировкой записи от хвоста, syncTail),
   * поэтому changes != 1 — коллизия часов, транзакция откатывается целиком.
   */
  private journalClaim(
    tx: DbDriver,
    meta: SetOp,
    entityId: string,
    scope: string,
    action: ClaimAction,
    holder: string,
    epoch: number,
    expires: number,
  ): void {
    const inserted = tx.run(Q.oplog_insert, [
      meta.op_id,
      meta.site_id,
      packHlc(meta.hlc),
      meta.hlc.ts,
      this.actor,
      "claim",
      "node",
      entityId,
      "lease",
      JSON.stringify({ action, holder, epoch, expires }),
      scope,
      1,
    ]);
    if (inserted.changes !== 1) {
      throw new GraphError(
        "graph.clock_collision",
        `operation ${meta.op_id} is already in the oplog — a repeated journal claim is not allowed`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  /**
   * Записать операцию в оплог. `false` ⇒ op_id уже был: операция применена
   * ранее, и повторять проекцию нельзя. Это и есть дедупликация на SQL-слое,
   * которую чистая логика оплога оставила хранилищу.
   */
  private journal(
    tx: DbDriver,
    op: Op,
    entity: "node" | "edge",
    entityId: string,
    scope: string,
    origin: 0 | 1,
  ): boolean {
    const result = tx.run(Q.oplog_insert, [
      op.op_id,
      op.site_id,
      packHlc(op.hlc),
      op.hlc.ts,
      this.actor,
      op.op,
      entity,
      entityId,
      op.field,
      JSON.stringify(op.value),
      scope,
      origin,
    ]);
    return result.changes > 0;
  }

  /**
   * Журнал ЛОКАЛЬНОЙ операции. Её op_id только что выделен под блокировкой
   * записи (syncTail), поэтому «уже есть» — не повтор, а коллизия: другой
   * процесс этого же site_id выдал тот же seq. Молча пропустить нельзя (И2):
   * раньше именно так запись исчезала без следа (myc-4dy).
   */
  private journalLocal(
    tx: DbDriver,
    op: Op,
    entity: "node" | "edge",
    entityId: string,
    scope: string,
  ): void {
    if (!this.journal(tx, op, entity, entityId, scope, 1)) {
      throw new GraphError(
        "graph.clock_collision",
        `op_id ${op.op_id} is already in the oplog: two processes write under site_id ${op.site_id} with diverging seq — write rejected, not swallowed`,
      );
    }
  }

  /**
   * Одна транзакция на пакет локальных операций над одним узлом. Операции
   * минтит `mint` уже внутри транзакции — после syncTail, иначе их op_id и
   * hlc могли оказаться занятыми соседним процессом (myc-4dy).
   */
  private applyLocal(
    mint: (tx: DbDriver) => readonly Op[],
    entityId: string,
    scope: string,
  ): void {
    this.driver.tx("immediate", (tx) => {
      this.syncTail(tx);
      const ops = mint(tx);
      const tally = newTally();
      for (const op of ops) {
        this.journalLocal(tx, op, "node", entityId, scope);
        if (op.op === "set") {
          const touch = this.identityTouch(tx, op.field, entityId, tally);
          if (this.projectSet(tx, op, touch) === "collided") {
            throw collisionError(op, entityId);
          }
        } else if (op.op === "inc") {
          this.projectInc(tx, op);
        }
      }
      this.settleIdentity(tx, tally, true);
      this.persistSeq(tx);
    });
  }

  /**
   * LWW по полю: пишем, только если наши часы старше пришедших (§9.3).
   *
   * Равная пара (hlc, site_id) при том же значении — безвредный повтор.
   * При ДРУГОМ значении разорвать ничью нечем: два события одного сайта с
   * одними часами — нарушение инварианта, а не конфликт LWW. Тихо оставить
   * «первого» значит скрыть класс ошибок (S38, myc-4dy) — исход `collided`
   * уходит наверх: локально ошибкой, в applyOps списком.
   *
   * `beforeWrite` зовётся ровно тогда, когда запись состоится, и ДО неё:
   * смена scope/deleted_at/external_ref меняет членство узла в уникальном
   * индексе ux_nodes_content, и хеш узла обязан стать уникальным раньше,
   * чем UPDATE колонки упрётся в чужой (см. touchContent).
   */
  private projectSet(tx: DbDriver, op: SetOp, beforeWrite?: () => void): ProjectOutcome {
    const spec = assertNodeField(op.field);
    const guard = tx.one<ClockRow>(Q.field_clock_get, [
      op.entity_id,
      op.field,
    ]);
    if (guard !== undefined) {
      const cmp = compareClock(
        op.hlc,
        op.site_id,
        readHlc(guard.hlc),
        guard.site_id,
      );
      if (cmp < 0) return "stale";
      if (cmp === 0) {
        return this.sameStoredValue(tx, op, spec) ? "stale" : "collided";
      }
    }
    beforeWrite?.();
    const hlc = packHlc(op.hlc);
    if (spec === "attr") {
      const key = attrKeyOf(op.field)!;
      tx.run(Q.node_set_attr, [
        op.entity_id,
        `$.${key}`,
        JSON.stringify(op.value),
        op.hlc.ts,
        hlc,
        op.site_id,
      ]);
    } else {
      tx.run(nodeSetQuery(spec.field), [
        op.entity_id,
        coerceNodeFieldValue(spec, op.value),
        op.hlc.ts,
        hlc,
        op.site_id,
      ]);
    }
    tx.run(Q.field_clock_set, [op.entity_id, op.field, hlc, op.site_id]);
    return "applied";
  }

  /** Совпадает ли значение поля в строке узла с тем, что несёт операция. */
  private sameStoredValue(
    tx: DbDriver,
    op: SetOp,
    spec: ReturnType<typeof assertNodeField>,
  ): boolean {
    const row = tx.one<RawRow>(Q.node_get, [op.entity_id]);
    if (row === undefined) return false;
    if (spec === "attr") {
      const key = attrKeyOf(op.field)!;
      return (
        JSON.stringify(parseAttrs(row.attrs)[key] ?? null) ===
        JSON.stringify(op.value ?? null)
      );
    }
    const stored = row[spec.field] ?? null;
    return stored === coerceNodeFieldValue(spec, op.value);
  }

  /** G-counter: поэлементный максимум по сайтам, колонка — их сумма. */
  private projectInc(tx: DbDriver, op: IncOp): void {
    tx.run(Q.counter_set, [op.entity_id, op.field, op.site_id, op.value]);
    const column = COUNTER_COLUMNS[op.field];
    if (column === undefined) return;
    const total =
      tx.one<{ total: number }>(Q.counter_sum, [op.entity_id, op.field])
        ?.total ?? 0;
    tx.run(column, [op.entity_id, total]);
  }

  /**
   * OR-Set add (§9.3) — memory-86eqge02q8rd. Строка ребра — функция от
   * МНОЖЕСТВА добавлений и тумбстоунов (reprojectEdge), а не от порядка
   * применения. Прежняя проекция держала в колонке `add_tag` одного
   * представителя и гасила ребро, когда удаление видело именно его, забывая
   * про второе, более старое и не удалённое добавление: набор {add a,
   * add b, del[b]} в порядке «a, b, del» давал мёртвое ребро, в порядке
   * «b, del, a» — живое, а дедупликация по op_id не давала разойтись назад.
   *
   * `local` — свой addEdge: только он пишет нереплицируемые actor и attrs.
   * Те же часы и тот же сайт у другого тега — не ничья OR-Set, а нарушение
   * инварианта «один сайт — одна последовательность часов» (см. projectSet):
   * исход `collided`. Проекция при этом всё равно пересчитывается — порядок
   * добавлений полный (часы, сайт, тег), и строка остаётся функцией множества.
   */
  private projectEdgeAdd(
    tx: DbDriver,
    op: EdgeAddOp,
    local?: { readonly actor: string; readonly attrs: string },
  ): ProjectOutcome {
    const { src, type, dst } = splitMemoryEdgeKey(op.entity_id);
    const adds = this.readEdgeAdds(tx, edgeEntityId(src, type, dst));
    const collided = adds.some(
      (a) => a.tag !== op.value.tag && compareClock(a.hlc, a.site, op.hlc, op.site_id) === 0,
    );
    this.reprojectEdge(tx, src, type, dst, adds, local);
    return collided ? "collided" : "applied";
  }

  /**
   * OR-Set remove (§9.3): тумбстоун на каждый увиденный тег, затем пересчёт.
   * Ребро гаснет, только когда не осталось ни одного живого добавления:
   * добавление, которого удаление не видело, его переживает (add wins).
   */
  private projectEdgeDel(tx: DbDriver, op: EdgeDelOp): void {
    const { src, type, dst } = splitMemoryEdgeKey(op.entity_id);
    const hlc = packHlc(op.hlc);
    for (const tag of op.value.tags) {
      tx.run(Q.edge_tombstone_insert, [src, type, dst, tag, hlc, op.site_id]);
    }
    this.reprojectEdge(tx, src, type, dst, this.readEdgeAdds(tx, edgeEntityId(src, type, dst)));
  }

  /** Добавления ребра из оплога (Q.edge_adds_of). */
  private readEdgeAdds(tx: DbDriver, entityId: string): EdgeAdd[] {
    return tx
      .all<{ value: string; hlc: string; site_id: string }>(Q.edge_adds_of, [entityId])
      .map((row) => {
        const v = JSON.parse(row.value) as { tag: string; weight?: number };
        return { tag: v.tag, weight: v.weight ?? 1.0, hlc: readHlc(row.hlc), site: row.site_id };
      });
  }

  /** Живые теги ребра — всё, что обязано уйти в edge_del, чтобы удалить его сейчас. */
  private liveEdgeTags(tx: DbDriver, src: string, type: string, dst: string): string[] {
    const dead = new Set(
      tx.all<{ tag: string }>(Q.edge_tombstones_of, [src, type, dst]).map((t) => t.tag),
    );
    return this.readEdgeAdds(tx, edgeEntityId(src, type, dst))
      .map((a) => a.tag)
      .filter((tag) => !dead.has(tag))
      .sort();
  }

  /**
   * Строка ребра из множества OR-Set — одна и та же на любой реплике с тем
   * же набором операций, в любом порядке их применения:
   *
   *   живо         ⇔ есть добавление, чей тег не покрыт тумбстоуном;
   *   представитель = старшее по (hlc, site_id, tag) среди живых добавлений,
   *                   а у мёртвого ребра — среди всех: его тег, вес и часы
   *                   идут в add_tag, weight, hlc/site_id;
   *   created_at   = самое раннее добавление;
   *   deleted_at   = у мёртвого — самое позднее удаление его тегов, иначе NULL.
   *
   * Добавлений ещё нет (удаление приехало раньше) — строки нет, лежат одни
   * тумбстоуны; они учтутся, когда добавление приедет.
   */
  private reprojectEdge(
    tx: DbDriver,
    src: string,
    type: string,
    dst: string,
    adds: readonly EdgeAdd[],
    local?: { readonly actor: string; readonly attrs: string },
  ): void {
    if (adds.length === 0) return;
    const tombs = new Map<string, number>();
    for (const t of tx.all<{ tag: string; hlc: string }>(Q.edge_tombstones_of, [src, type, dst])) {
      tombs.set(t.tag, readHlc(t.hlc).ts);
    }
    const live = adds.filter((a) => !tombs.has(a.tag));
    const pool = live.length > 0 ? live : adds;
    let rep = pool[0]!;
    for (const a of pool) if (compareEdgeAdd(a, rep) > 0) rep = a;
    let createdAt = adds[0]!.hlc.ts;
    for (const a of adds) if (a.hlc.ts < createdAt) createdAt = a.hlc.ts;
    let deletedAt: number | null = null;
    if (live.length === 0) {
      for (const a of adds) {
        const ts = tombs.get(a.tag)!;
        if (deletedAt === null || ts > deletedAt) deletedAt = ts;
      }
    }
    const hlc = packHlc(rep.hlc);
    if (tx.one<EdgeClockRow>(Q.edge_clock_get, [src, type, dst]) === undefined) {
      tx.run(Q.edge_insert, [
        src,
        type,
        dst,
        rep.weight,
        rep.tag,
        local?.actor ?? this.actor,
        createdAt,
        hlc,
        rep.site,
        deletedAt,
        local?.attrs ?? "{}",
      ]);
      return;
    }
    tx.run(Q.edge_project, [src, type, dst, rep.weight, rep.tag, hlc, rep.site, createdAt, deletedAt]);
    if (local !== undefined) tx.run(Q.edge_set_local, [src, type, dst, local.actor, local.attrs]);
  }

  /**
   * Строка узла, приехавшего по репликации. Без `kind` создать её нельзя
   * (NOT NULL + CHECK), и подставлять «какой-нибудь» kind недопустимо:
   * узел с выдуманным видом выглядел бы здоровым.
   */
  private materializeNode(
    tx: DbDriver,
    id: string,
    kind: string | undefined,
  ): boolean {
    if (kind === undefined) return false;
    assertNodeKind(kind);
    const ts = this.now();
    const row: Record<string, unknown> = {
      id,
      kind,
      layer: 1,
      scope: "",
      title: "",
      body: null,
      body_cold: 0,
      excerpt: "",
      status: "active",
      priority: 2,
      confidence: 1.0,
      salience: 1.0,
      seen_count: 0,
      head_id: null,
      // Уникальный по построению (см. demotedContentHash): узлы, рождённые в
      // одном пакете до своих title/body, не сталкиваются в ux_nodes_content.
      // Настоящий хеш ставит settleContent в конце транзакции.
      content_hash: demotedContentHash(contentHash(kind, "", null), id),
      acl: "team",
      owner_id: "",
      team_id: "",
      agent_id: "",
      assignee: "",
      actor: "",
      created_at: ts,
      updated_at: ts,
      accessed_at: 0,
      due_at: null,
      closed_at: null,
      compacted_at: null,
      deleted_at: null,
      hlc: 0,
      site_id: "",
      attrs: "{}",
    };
    tx.run(
      Q.node_insert,
      NODE_INSERT_COLUMNS.map((c) => row[c] ?? null),
    );
    // То же, что с content_hash строкой выше, и по той же причине: узел
    // родился без attrs, а `set attrs.external_ref` приедет следующей
    // операцией этого же пакета и внесёт его в ux_nodes_external. Держателем
    // ссылки он становиться не вправе, пока не выяснено, кто в группе
    // старший, поэтому рождается понижённым (ext_dup = id — уникально по
    // построению). Настоящее значение ставит settleExternal в конце
    // транзакции: узлу, оставшемуся без ссылки, оно вернёт ''.
    tx.run(Q.node_set_ext_dup, [id, id]);
    return true;
  }

  // -------------------------------------------------------------------------
  // Контент-дубликаты (memory-0fs4rfa6xmha)
  //
  // ux_nodes_content запрещает два живых узла с одним (scope, kind,
  // content_hash). Локально это правило верно и остаётся: createNode и правка
  // текста в дубликат по-прежнему падают. Но два сайта вправе НЕЗАВИСИМО
  // записать один и тот же текст (два агента запомнили один факт, два якоря
  // на одном участке кода), и мерж CRDT не может такую пару отвергнуть.
  // Раньше refreshDerived упирался в UNIQUE и откатывал весь пакет, а каждая
  // следующая синхронизация падала тем же исключением.
  //
  // Правило (одно на всех репликах): в группе живых узлов одного канона
  // канонический content_hash держит СТАРШИЙ — по часам set(kind), то есть по
  // моменту создания, при равенстве по id; остальные держат пониженный
  // `<канон>:<id>`. content_hash — производная, не реплицируемое поле, так
  // что понижение ничего не пишет в оплог и не трогает данных узла. Уходит
  // победитель (удалён, правлен, переехал) — канон переходит к следующему.
  // -------------------------------------------------------------------------

  /**
   * Подготовка обоих уникальных индексов к правке одного поля. Узел держит
   * ДВЕ идентичности (§9.3), и поле `attrs.external_ref` меняет членство
   * сразу в обеих: пока оно NULL, узел спорит содержимым, как только
   * появилось — ссылкой. Поэтому оба «до записи» живут в одном месте:
   * забыть здесь один из них значит вернуть UNIQUE в середину транзакции.
   */
  private identityTouch(
    tx: DbDriver,
    field: string,
    id: string,
    tally: ApplyTally,
  ): (() => void) | undefined {
    const content = CONTENT_FIELDS.has(field);
    const external = EXTERNAL_FIELDS.has(field);
    if (!content && !external) return undefined;
    return () => {
      if (content) this.touchContent(tx, id, tally);
      if (external) this.touchExternal(tx, id, tally);
    };
  }

  /**
   * Первая в транзакции правка поля, от которого зависит членство узла в
   * ux_nodes_content: запомнить группу ДО правки и сразу сделать хеш узла
   * уникальным — последующие UPDATE колонок (scope, deleted_at, attrs) уже
   * не могут упереться в UNIQUE. Окончательный хеш ставит settleContent.
   */
  private touchContent(tx: DbDriver, id: string, tally: ApplyTally): void {
    if (tally.content.has(id)) return;
    const row = tx.one<ContentRow>(Q.node_content_row, [id]);
    if (row === undefined) return;
    const canon = canonOf(row.content_hash);
    tally.content.set(id, {
      scope: row.scope,
      kind: row.kind,
      canon,
      indexed: row.indexed === 1,
      demoted: canon !== row.content_hash,
    });
    tx.run(Q.node_set_content_hash, [id, demotedContentHash(canon, id)]);
  }

  /**
   * Конец транзакции: производные (excerpt, content_hash, решение S5) всех
   * тронутых узлов и перебалансировка их прежних и новых групп.
   *
   * `local` — своя запись: создать дубликат она не вправе, как и прежде.
   * Узел, ВОШЕДШИЙ в чужую группу (новый текст, новый scope, восстановление),
   * занимает канон прямой записью — занятый канон даёт тот же UNIQUE, что и
   * до правки. Прежние группы при этом перебалансируются так же, как при
   * репликации: иначе канон ушедшего узла остался бы ничьим здесь и
   * перешёл бы к следующему на реплике — расхождение того же класса.
   */
  private settleContent(tx: DbDriver, tally: ApplyTally, local: boolean): boolean {
    if (tally.content.size === 0) return false;
    const groups = new Map<string, { scope: string; kind: string; canon: string }>();
    const groupKey = (scope: string, kind: string, canon: string): string => {
      const key = `${scope}\u0000${kind}\u0000${canon}`;
      if (!groups.has(key)) groups.set(key, { scope, kind, canon });
      return key;
    };
    const joined: Array<{ id: string; canon: string; key: string }> = [];
    let dupSeen = false;
    for (const [id, before] of tally.content) {
      const row = tx.one<ContentRow>(Q.node_content_row, [id]);
      if (row === undefined) continue;
      const canon = contentHash(row.kind, row.title, row.body);
      const indexed = row.indexed === 1;
      // Вне домена индекса хеш канонический и ни с кем не сталкивается;
      // в домене — пока уникальный пониженный, решает перебалансировка.
      tx.run(Q.node_refresh_derived, [
        id,
        makeExcerpt(row.body),
        indexed ? demotedContentHash(canon, id) : canon,
      ]);
      if (before !== null && before.indexed) groupKey(before.scope, before.kind, before.canon);
      if (before?.demoted === true) dupSeen = true;
      if (!indexed) continue;
      const key = groupKey(row.scope, row.kind, canon);
      const entered =
        before === null || !before.indexed || before.scope !== row.scope || before.canon !== canon;
      if (local && entered) joined.push({ id, canon, key });
    }
    const joinedKeys = new Set(joined.map((j) => j.key));
    for (const [key, g] of groups) {
      if (joinedKeys.has(key)) continue;
      if (this.rebalanceContent(tx, g, tally)) dupSeen = true;
    }
    for (const j of joined) {
      tx.run(Q.node_set_content_hash, [j.id, j.canon]);
      if (this.rebalanceContent(tx, groups.get(j.key)!, tally)) dupSeen = true;
    }
    return dupSeen;
  }

  /**
   * Обе идентичности узла разом (§9.3): по содержимому для заведённого myc,
   * по ссылке на источник для ввезённого. Считаются они независимо — домены
   * индексов не пересекаются, — но здоровье пишется один раз: 'sync.duplicates'
   * называет одно число, которое человек и увидит.
   */
  private settleIdentity(tx: DbDriver, tally: ApplyTally, local: boolean): void {
    const content = this.settleContent(tx, tally, local);
    const external = this.settleExternal(tx, tally, local);
    if (content || external || tally.duplicates.length > 0) this.recordDuplicatesHealth(tx);
  }

  /**
   * Канон группы — старшему живому узлу, остальным — пониженный хеш.
   * Сначала понижаются все, кроме победителя, и только потом он повышается:
   * ни в какой момент два узла не держат один канон. `true` — в группе был
   * или есть дубликат: тогда пересчитывается myc_health. Пониженный на время
   * этой транзакции (touchContent) дубликатом не считается — иначе полный
   * проход по nodes стоял бы в каждой правке заголовка.
   */
  private rebalanceContent(
    tx: DbDriver,
    g: { readonly scope: string; readonly kind: string; readonly canon: string },
    tally: ApplyTally,
  ): boolean {
    const members = tx.all<ContentMember>(Q.content_group, [g.scope, g.kind, g.canon, `${g.canon};`]);
    if (members.length === 0) return false;
    let winner = members[0]!;
    for (const m of members) if (olderBorn(m, winner)) winner = m;
    const wasDemoted = (m: ContentMember): boolean => {
      if (!tally.content.has(m.id)) return m.content_hash !== g.canon;
      return tally.content.get(m.id)?.demoted === true;
    };
    const touched = members.length > 1 || members.some(wasDemoted);
    for (const m of members) {
      if (m.id === winner.id) continue;
      const want = demotedContentHash(g.canon, m.id);
      if (m.content_hash !== want) tx.run(Q.node_set_content_hash, [m.id, want]);
      if (!tally.duplicates.some((d) => d.id === m.id)) {
        tally.duplicates.push({ id: m.id, of: winner.id, by: "content" });
      }
    }
    if (winner.content_hash !== g.canon) tx.run(Q.node_set_content_hash, [winner.id, g.canon]);
    return touched;
  }

  // -------------------------------------------------------------------------
  // Ввезённые дубликаты (memory-gemeb3d8wj41)
  //
  // Ровно тот же класс, что контент-дубликат выше, и разводится тем же
  // правилом — но понижать здесь нечего. Ключ ux_nodes_content, content_hash,
  // производный: его можно заменить на `<канон>:<id>`, ничего не сказав
  // оплогу. Ключ ux_nodes_external — сама `attrs.external_ref`, значение
  // РЕПЛИЦИРУЕМОЕ: подменив его, мы соврали бы о том, какую запись источника
  // представляет узел, и разослали бы эту ложь дальше. Поэтому миграция 13
  // завела производную колонку-разрешитель `ext_dup` — четвёртую в индексе:
  // '' у держателя ссылки, собственный id у понижённого.
  //
  // Правило (одно на всех репликах): в группе живых узлов одной ссылки
  // (scope, kind, external_ref) ссылку держит СТАРШИЙ — по часам set(kind),
  // при равенстве по id; остальные понижены. Уходит держатель (удалён,
  // сменил scope или ссылку) — ссылка переходит к следующему.
  // -------------------------------------------------------------------------

  /**
   * Первая в транзакции правка поля, от которого зависит членство узла в
   * ux_nodes_external: запомнить группу ДО правки и сразу сделать узел
   * понижённым — тогда последующий UPDATE колонки (scope, deleted_at, attrs)
   * не упрётся в чужую ссылку. Кто держит ссылку, решит settleExternal.
   * `ext_dup = id` уникален по построению: id уникален, а всякий другой член
   * группы держит либо '', либо СВОЙ id.
   */
  private touchExternal(tx: DbDriver, id: string, tally: ApplyTally): void {
    if (tally.external.has(id)) return;
    const row = tx.one<ExternalRow>(Q.node_external_row, [id]);
    if (row === undefined) return;
    tally.external.set(id, {
      scope: row.scope,
      kind: row.kind,
      ref: row.ref ?? "",
      indexed: row.indexed === 1,
      demoted: row.ext_dup !== "",
    });
    if (row.ext_dup !== id) tx.run(Q.node_set_ext_dup, [id, id]);
  }

  /**
   * Конец транзакции: кто держит внешнюю ссылку в каждой тронутой группе.
   * Зеркало settleContent, и `local` значит здесь то же самое: своя запись
   * не вправе завести второго держателя одной ссылки, поэтому вошедший в
   * чужую группу узел берёт `ext_dup = ''` прямой записью — занятая ссылка
   * даёт тот же UNIQUE, что и до правки. Прежние группы при этом
   * перебалансируются так же, как при репликации: иначе ссылка ушедшего
   * узла осталась бы здесь ничьей, а на реплике перешла бы к следующему —
   * расхождение того же класса.
   */
  private settleExternal(tx: DbDriver, tally: ApplyTally, local: boolean): boolean {
    if (tally.external.size === 0) return false;
    const groups = new Map<string, { scope: string; kind: string; ref: string }>();
    const groupKey = (scope: string, kind: string, ref: string): string => {
      const key = `${scope}\u0000${kind}\u0000${ref}`;
      if (!groups.has(key)) groups.set(key, { scope, kind, ref });
      return key;
    };
    const joined: Array<{ id: string; key: string }> = [];
    let dupSeen = false;
    for (const [id, before] of tally.external) {
      const row = tx.one<ExternalRow>(Q.node_external_row, [id]);
      if (row === undefined) continue;
      const indexed = row.indexed === 1;
      // Вне домена индекса разрешитель ни с кем не спорит и обязан быть
      // одинаков на всех репликах — значит пустой.
      if (!indexed && row.ext_dup !== "") tx.run(Q.node_set_ext_dup, [id, ""]);
      if (before !== null && before.indexed) groupKey(before.scope, before.kind, before.ref);
      if (before?.demoted === true) dupSeen = true;
      if (!indexed) continue;
      const ref = row.ref ?? "";
      const key = groupKey(row.scope, row.kind, ref);
      const entered =
        before === null || !before.indexed || before.scope !== row.scope || before.ref !== ref;
      if (local && entered) joined.push({ id, key });
    }
    const joinedKeys = new Set(joined.map((j) => j.key));
    for (const [key, g] of groups) {
      if (joinedKeys.has(key)) continue;
      if (this.rebalanceExternal(tx, g, tally)) dupSeen = true;
    }
    const joinedIds = new Set(joined.map((j) => j.id));
    for (const j of joined) {
      this.holdExternal(tx, groups.get(j.key)!, joinedIds);
      tx.run(Q.node_set_ext_dup, [j.id, ""]);
      if (this.rebalanceExternal(tx, groups.get(j.key)!, tally)) dupSeen = true;
    }
    return dupSeen;
  }

  /**
   * Своя запись входит в группу, где ссылку сейчас не держит никто, хотя
   * живые члены есть — все понижены. Так бывает, когда держатель ушёл той
   * же транзакцией, и когда его удалил бинарь 0.3.11–0.3.13: миграция 13
   * совместима, старый код пишет в эту базу, но групп не перебалансирует.
   * Не отдай здесь ссылку старшему из прежних членов, вошедший узел взял бы
   * её без UNIQUE, и своя запись завела бы второй узел с занятой ссылкой —
   * ровно то, что локально запрещено. Вошедшие этой транзакцией не
   * считаются: они ссылку ещё не держат, а только пробуют взять.
   */
  private holdExternal(
    tx: DbDriver,
    g: { readonly scope: string; readonly kind: string; readonly ref: string },
    joining: ReadonlySet<string>,
  ): void {
    const members = tx
      .all<ExternalMember>(Q.external_group, [g.scope, g.kind, g.ref])
      .filter((m) => !joining.has(m.id));
    if (members.length === 0 || members.some((m) => m.ext_dup === "")) return;
    let winner = members[0]!;
    for (const m of members) if (olderBorn(m, winner)) winner = m;
    tx.run(Q.node_set_ext_dup, [winner.id, ""]);
  }

  /**
   * Ссылка — старшему живому узлу группы, остальным — понижение. Сначала
   * понижаются все, кроме победителя, и только потом он берёт ссылку: ни в
   * какой момент два узла не держат одну. `true` — в группе был или есть
   * дубликат: тогда пересчитывается myc_health. Понижённый на время этой
   * транзакции (touchExternal) дубликатом не считается — иначе полный проход
   * по nodes стоял бы в каждой правке ввезённого узла.
   */
  private rebalanceExternal(
    tx: DbDriver,
    g: { readonly scope: string; readonly kind: string; readonly ref: string },
    tally: ApplyTally,
  ): boolean {
    const members = tx.all<ExternalMember>(Q.external_group, [g.scope, g.kind, g.ref]);
    if (members.length === 0) return false;
    let winner = members[0]!;
    for (const m of members) if (olderBorn(m, winner)) winner = m;
    const wasDemoted = (m: ExternalMember): boolean => {
      if (!tally.external.has(m.id)) return m.ext_dup !== "";
      return tally.external.get(m.id)?.demoted === true;
    };
    const touched = members.length > 1 || members.some(wasDemoted);
    for (const m of members) {
      if (m.id === winner.id) continue;
      if (m.ext_dup !== m.id) tx.run(Q.node_set_ext_dup, [m.id, m.id]);
      if (!tally.duplicates.some((d) => d.id === m.id)) {
        tally.duplicates.push({ id: m.id, of: winner.id, by: "external" });
      }
    }
    if (winner.ext_dup !== "") tx.run(Q.node_set_ext_dup, [winner.id, ""]);
    return touched;
  }

  /**
   * myc_health 'sync.duplicates': сколько живых узлов сейчас понижено — по
   * содержимому и по внешней ссылке. Компонент один на оба случая: человек
   * читает одно число «столько узлов повторяют чужую идентичность», а чем
   * именно — говорят detail и списки contentDuplicates/externalDuplicates.
   */
  private recordDuplicatesHealth(tx: DbDriver): void {
    const content = tx.one<{ n: number }>(Q.content_duplicates_count, [])?.n ?? 0;
    const external = tx.one<{ n: number }>(Q.external_duplicates_count, [])?.n ?? 0;
    const n = content + external;
    const why: string[] = [];
    if (content > 0) {
      why.push(
        `${content} ${content === 1 ? "node repeats" : "nodes repeat"} another node's kind, title and body in the same scope ` +
          "(written independently on two sites); the older node keeps the canonical content_hash",
      );
    }
    if (external > 0) {
      why.push(
        `${external} imported ${external === 1 ? "node repeats" : "nodes repeat"} another node's attrs.external_ref ` +
          "(the same source record imported on two machines); the older node holds the reference",
      );
    }
    tx.run(Q.health_set, [
      "sync.duplicates",
      n > 0 ? "degraded" : "ok",
      why.join("; "),
      this.now(),
      JSON.stringify({ duplicates: n, content, external }),
    ]);
  }

  /** S3: myc_meta.last_seq — локальный порядок, на нём висит инвалидация. */
  private persistSeq(tx: DbDriver): void {
    tx.run(Q.meta_set, [META_LAST_SEQ, String(this.ops.lastSeq)]);
  }
}

/** Строка оплога обратно в операцию — вход merge() и sync. */
export function rowToOp(row: OplogRow): Op {
  const hlc = readHlc(row.hlc);
  const seq = Number(row.op_id.slice(row.site_id.length + 1));
  const value = row.value === null ? null : (JSON.parse(row.value) as JsonValue);
  const entityId =
    row.entity === "edge"
      ? (() => {
          const e = parseEdgeEntityId(row.entity_id);
          return [e.src, e.type, e.dst].join(MEMORY_EDGE_SEPARATOR);
        })()
      : row.entity_id;
  const base = {
    op_id: row.op_id,
    seq: Number.isFinite(seq) ? seq : 0,
    hlc,
    site_id: row.site_id,
    entity_id: entityId,
    field: row.field ?? "",
  };

  switch (row.op) {
    case "set":
      return { ...base, op: "set", value } as SetOp;
    case "inc":
      return { ...base, op: "inc", value: Number(value) } as IncOp;
    case "edge_add":
      return {
        ...base,
        op: "edge_add",
        value: value as { tag: string; weight?: number },
      } as EdgeAddOp;
    case "edge_del":
      return {
        ...base,
        op: "edge_del",
        value: value as { tags: string[] },
      } as EdgeDelOp;
    default:
      throw new GraphError(
        "graph.unknown_field",
        `operation '${row.op}' does not project into an Op: claim and purge are separate tasks`,
      );
  }
}
