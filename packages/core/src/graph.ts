/**
 * Доменная модель графа: узлы девяти видов и типизированные рёбра одиннадцати
 * типов. Здесь нет SQL — только то, что обязано совпадать у SQLite, Postgres
 * и любого будущего применятора операций: список полей, семантика рёбер,
 * детерминированные производные (excerpt, content_hash) и чеканка операций
 * оплога.
 *
 * Источники: docs/design/01-core-data-model.md §2 (модель узлов), §4 (рёбра),
 * §9.3 (применение операции); docs/design/ARCHITECTURE.md §10, решения S5, S25.
 */

import { HlcClock, edgeKey, makeOpId } from "./oplog.ts";
import { defineQueries, type DbDriver } from "./sql.ts";
import type {
  EdgeAddOp,
  EdgeDelOp,
  Hlc,
  IncOp,
  JsonValue,
  SetOp,
} from "./oplog.ts";
import type { EdgeKind, Layer, NodeKind } from "./index.ts";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/**
 * Коды выхода — источник истины packages/cli/src/exit.ts (§2.2
 * docs/design/03-interfaces-and-integration.md). core не может зависеть от
 * пакета CLI (scripts/deps-check.ts), поэтому нужные значения продублированы
 * константами — тем же приёмом, что и EXIT_PRECOND в store-sqlite/migrate.ts.
 */
const EXIT_USAGE = 2;
const EXIT_NOTFOUND = 3;
const EXIT_CONFLICT = 4;

export type GraphErrorCode =
  /** Неизвестный kind узла. */
  | "graph.kind"
  /** Статус не разрешён для этого kind (§2.4). */
  | "graph.status"
  /** Неизвестный тип ребра. */
  | "graph.edge_type"
  /** Ребро из узла в себя же — запрещено CHECK (src <> dst). */
  | "graph.self_edge"
  /** Значение поля не того типа, что колонка. */
  | "graph.field_type"
  /** Поле не входит в белый список реплицируемых. */
  | "graph.unknown_field"
  /** Ключ attrs не проходит ATTR_KEY_RE. */
  | "graph.attr_key"
  /** Значение вне допустимого диапазона (layer, priority, confidence, acl). */
  | "graph.range"
  /** Узел не найден. */
  | "graph.not_found"
  /**
   * Неразрешимая ничья часов: пара (hlc, site_id) уже занята записью с ДРУГИМ
   * значением, либо op_id уже в оплоге при свежевыделенном seq. Это нарушение
   * инварианта «один сайт — одна последовательность», а не решение LWW, и
   * молча выбирать победителя здесь нельзя (И2).
   */
  | "graph.clock_collision";

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly exit: number;

  constructor(code: GraphErrorCode, message: string) {
    super(message);
    this.name = "GraphError";
    this.code = code;
    this.exit =
      code === "graph.not_found"
        ? EXIT_NOTFOUND
        : code === "graph.self_edge" || code === "graph.clock_collision"
          ? EXIT_CONFLICT
          : EXIT_USAGE;
  }
}

// ---------------------------------------------------------------------------
// Статусы и слои по kind (§2.4, §2.3)
// ---------------------------------------------------------------------------

/**
 * Единая семантика «закрыто» для счётчика блокеров (§2.4, последняя строка).
 * Тот же набор зашит в триггеры trg_blk_* и trg_st_* — расхождение молча
 * разъедет open_blockers, поэтому набор объявлен ровно один раз здесь и
 * дословно повторён в DDL.
 */
export const CLOSED_STATUSES: readonly string[] = [
  "closed",
  "cancelled",
  "superseded",
  "retracted",
] as const;

export function isClosedStatus(status: string): boolean {
  return CLOSED_STATUSES.includes(status);
}

/** Допустимые status по kind — таблица §2.4 целиком. */
export const NODE_STATUSES: Readonly<Record<NodeKind, readonly string[]>> =
  Object.freeze({
    task: ["open", "in_progress", "blocked", "closed", "cancelled"],
    note: ["active", "superseded", "retracted"],
    doc: ["active", "stale", "retracted"],
    fragment: ["active", "superseded", "retracted"],
    session: ["open", "closed"],
    message: ["active"],
    entity: ["active", "superseded", "retracted"],
    anchor: ["fresh", "drifted", "stale", "lost"],
    skill: ["active", "superseded", "retracted"],
  });

/** Статус по умолчанию — первый допустимый для kind. */
export const DEFAULT_STATUS: Readonly<Record<NodeKind, string>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(NODE_STATUSES) as NodeKind[]).map((k) => [
      k,
      NODE_STATUSES[k][0]!,
    ]),
  ) as Record<NodeKind, string>,
);

/** Слой по умолчанию — колонка «Слой по умолчанию» таблицы §2.3. */
export const DEFAULT_LAYER: Readonly<Record<NodeKind, Layer>> = Object.freeze({
  task: 1,
  note: 1,
  doc: 1,
  fragment: 1,
  session: 0,
  message: 0,
  entity: 2,
  anchor: 1,
  skill: 3,
});

export const ACL_MODES: readonly string[] = [
  "private",
  "team",
  "restricted",
  "agent",
] as const;

export function isNodeKind(value: string): value is NodeKind {
  return Object.prototype.hasOwnProperty.call(NODE_STATUSES, value);
}

export function assertNodeKind(value: string): NodeKind {
  if (!isNodeKind(value)) {
    throw new GraphError(
      "graph.kind",
      `неизвестный kind узла: ${JSON.stringify(value)}; допустимы ${Object.keys(NODE_STATUSES).join(", ")}`,
    );
  }
  return value;
}

export function assertStatus(kind: NodeKind, status: string): string {
  if (!NODE_STATUSES[kind].includes(status)) {
    throw new GraphError(
      "graph.status",
      `status '${status}' недопустим для kind '${kind}'; допустимы ${NODE_STATUSES[kind].join(", ")}`,
    );
  }
  return status;
}

// ---------------------------------------------------------------------------
// Семантика рёбер (§4.1) — читается целиком, типы не взаимозаменяемы
// ---------------------------------------------------------------------------

export interface EdgeSemantics {
  readonly type: EdgeKind;
  /** Как читается тройка (src, type, dst). */
  readonly reads: string;
  /** Имя виртуального обратного ребра; хранится всегда только прямое. */
  readonly inverse: string;
  /** Обратное совпадает с прямым: relates, contradicts. */
  readonly symmetric: boolean;
  /** Транзитивно ли отношение по смыслу. */
  readonly transitive: boolean;
  /** Проверяется ли ацикличность перед вставкой (§4.3). */
  readonly acyclic: boolean;
  /**
   * Предел глубины обхода. Для ацикличных — глубина проверки цикла,
   * для derived_from — предел обхода провенанса. 0 ⇒ обход не определён.
   */
  readonly maxDepth: number;
  /**
   * Что материализуется в той же транзакции, что и ребро (§4.2).
   * Сама материализация — задача myc-182 и myc-9ve; здесь только контракт.
   */
  readonly materializes:
    | "open_blockers"
    | "parent_closure"
    | "head_id"
    | "path_compaction"
    | "thread_root"
    | null;
  /** Участвует ли в расширении выдачи на один хоп (§4.2, последний абзац). */
  readonly expandsRetrieval: boolean;
  /** Кто ставит ребро — колонка «Кто ставит» §4.1. */
  readonly writtenBy: string;
}

/**
 * Полная таблица §4.1. Одиннадцатый тип, `contradicts`, добавлен сверх списка
 * beads/memora: классу `contradiction` из absorb-конвейера (§6.2) иначе некуда
 * писаться, а `relates` теряет смысл «конфликт, нужен человек».
 */
export const EDGE_SEMANTICS: Readonly<Record<EdgeKind, EdgeSemantics>> =
  Object.freeze({
    blocks: {
      type: "blocks",
      reads: "src блокирует dst",
      inverse: "blocked_by",
      symmetric: false,
      transitive: true,
      acyclic: true,
      maxDepth: 64,
      materializes: "open_blockers",
      expandsRetrieval: false,
      writtenBy: "человек/агент",
    },
    parent: {
      type: "parent",
      reads: "src — ребёнок dst",
      inverse: "children",
      symmetric: false,
      transitive: true,
      acyclic: true,
      maxDepth: 32,
      materializes: "parent_closure",
      expandsRetrieval: false,
      writtenBy: "человек/агент/парсер doc",
    },
    relates: {
      type: "relates",
      reads: "src связано с dst",
      inverse: "relates",
      symmetric: true,
      transitive: false,
      acyclic: false,
      maxDepth: 1,
      materializes: null,
      expandsRetrieval: true,
      writtenBy: "absorb, человек",
    },
    duplicates: {
      type: "duplicates",
      reads: "src — дубликат канонического dst",
      inverse: "duplicated_by",
      symmetric: false,
      // Транзитивно по смыслу, но при вставке путь сжимается до корня,
      // поэтому фактическая глубина в базе всегда 1 (§4.1, §4.2).
      transitive: true,
      acyclic: true,
      maxDepth: 1,
      materializes: "path_compaction",
      expandsRetrieval: false,
      writtenBy: "absorb",
    },
    supersedes: {
      type: "supersedes",
      reads: "src заменяет dst",
      inverse: "superseded_by",
      symmetric: false,
      transitive: true,
      acyclic: true,
      maxDepth: 64,
      materializes: "head_id",
      expandsRetrieval: false,
      writtenBy: "absorb, человек",
    },
    replies_to: {
      type: "replies_to",
      reads: "src — ответ на dst",
      inverse: "replies",
      symmetric: false,
      transitive: true,
      acyclic: true,
      maxDepth: 64,
      materializes: "thread_root",
      expandsRetrieval: false,
      writtenBy: "слой сообщений",
    },
    derived_from: {
      type: "derived_from",
      reads: "src выведен из dst",
      inverse: "derives",
      symmetric: false,
      transitive: true,
      acyclic: true,
      // Обход по требованию, рекурсивным CTE; замыкание не материализуется.
      maxDepth: 8,
      materializes: null,
      expandsRetrieval: false,
      writtenBy: "дистиллятор, absorb",
    },
    mentions: {
      type: "mentions",
      reads: "src упоминает сущность dst",
      inverse: "mentioned_by",
      symmetric: false,
      transitive: false,
      acyclic: false,
      maxDepth: 1,
      materializes: null,
      expandsRetrieval: true,
      writtenBy: "извлекатель сущностей",
    },
    touches: {
      type: "touches",
      reads: "src привязан к якорю dst",
      inverse: "touched_by",
      symmetric: false,
      transitive: false,
      acyclic: false,
      maxDepth: 1,
      materializes: null,
      expandsRetrieval: true,
      writtenBy: "myc anchor bind, агент",
    },
    evidence: {
      type: "evidence",
      reads: "src обоснован dst",
      inverse: "evidence_for",
      symmetric: false,
      transitive: false,
      acyclic: false,
      maxDepth: 1,
      materializes: null,
      expandsRetrieval: true,
      writtenBy: "absorb, агент",
    },
    contradicts: {
      type: "contradicts",
      reads: "src противоречит dst",
      inverse: "contradicts",
      symmetric: true,
      transitive: false,
      acyclic: false,
      maxDepth: 1,
      materializes: null,
      expandsRetrieval: true,
      writtenBy: "absorb (класс contradiction)",
    },
  });

export function isEdgeKind(value: string): value is EdgeKind {
  return Object.prototype.hasOwnProperty.call(EDGE_SEMANTICS, value);
}

export function assertEdgeKind(value: string): EdgeKind {
  if (!isEdgeKind(value)) {
    throw new GraphError(
      "graph.edge_type",
      `неизвестный тип ребра: ${JSON.stringify(value)}; допустимы ${Object.keys(EDGE_SEMANTICS).join(", ")}`,
    );
  }
  return value;
}

export function edgeSemantics(type: EdgeKind): EdgeSemantics {
  return EDGE_SEMANTICS[type];
}

/** Типы, расширяющие выдачу на один хоп; предел соседей — §4.2. */
export const RETRIEVAL_EXPANSION_LIMIT = 12;

// ---------------------------------------------------------------------------
// Детерминированные производные: excerpt (S5) и content_hash (§2.2)
// ---------------------------------------------------------------------------

/** CHECK (length(excerpt) <= 300) в DDL. Считаем в кодовых точках. */
export const EXCERPT_MAX = 300;

/**
 * Короткий текст узла для первого прохода сборки выдачи (решение S5).
 *
 * Смысл колонки в том, чтобы ретривал собрал выдачу, НЕ читая `body`; поэтому
 * excerpt считается один раз в момент записи и физически хранится. Функция
 * обязана быть детерминированной: тот же body на другом сайте обязан дать тот
 * же excerpt, иначе реплики разъедутся на производном поле, которое никто
 * не сверяет.
 *
 * Обрезка идёт по кодовым точкам, а не по code unit'ам JS: SQLite `length()`
 * считает символы, и суррогатная пара, разрезанная пополам, дала бы и битый
 * текст, и расхождение с CHECK.
 */
export function makeExcerpt(
  body: string | null | undefined,
  max: number = EXCERPT_MAX,
): string {
  if (body === null || body === undefined) return "";
  const normalized = body.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "";
  const points = [...normalized];
  if (points.length <= max) return normalized;

  // Один символ резервируется под многоточие.
  const head = points.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(" ");
  // Откат до границы слова — но не дальше 80 % длины: одно длинное слово
  // (URL, base64) иначе выело бы почти весь excerpt.
  const cut = lastSpace >= Math.floor((max - 1) * 0.8) ? lastSpace : head.length;
  return `${head.slice(0, cut).join("").trimEnd()}…`;
}

/**
 * blake3 из §2.2 заменён на sha256 — ровно по мотиву решения S25: blake3
 * потребовал бы нативной зависимости в пути установки, а sha256 встроен
 * в Bun и Node. Хеш считается синхронно: он в горячем пути записи, а
 * crypto.subtle асинхронный.
 *
 * Нормализация текста перед хешированием обязана совпадать у всех сайтов —
 * от неё зависит уникальный индекс ux_nodes_content(scope, kind, content_hash).
 */
export function contentHash(
  kind: string,
  title: string,
  body: string | null | undefined,
): string {
  const norm = (s: string): string => s.replace(/\s+/gu, " ").trim();
  const h = createHash("sha256");
  // Разделитель NUL невозможен внутри полей — склейка однозначна.
  h.update(`${kind}\u0000${norm(title)}\u0000${norm(body ?? "")}`, "utf8");
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Поля узла: горячие — колонками, холодные — в attrs
// ---------------------------------------------------------------------------

export type NodeFieldType = "text" | "int" | "real" | "json";

export interface NodeFieldSpec {
  readonly field: string;
  /** Имя колонки; для полей attrs.<key> — всегда 'attrs'. */
  readonly column: string;
  readonly type: NodeFieldType;
  readonly nullable: boolean;
}

/**
 * Горячие поля — те, что лежат отдельными колонками и участвуют в per-field
 * LWW. Порядок фиксирован: он же порядок в INSERT'е узла.
 *
 * Сюда НЕ входят:
 *  - `excerpt` и `content_hash` — производные (см. выше), считаются на обеих
 *    сторонах из body/title и не реплицируются как самостоятельные поля;
 *  - `created_at`/`updated_at`/`accessed_at`/`hlc`/`site_id` — метаданные
 *    движка, они едут в самой записи оплога (ts_ms, hlc, site_id);
 *  - `seen_count` — G-counter, живёт в таблице counters (§9.3, ветка 'inc');
 *  - `open_blockers` — материализация рёбер blocks, её ведут триггеры (§4.2);
 *  - `lease_holder`/`lease_epoch`/`lease_expires` — атомарный claim (§9.4),
 *    отдельная операция 'claim' и отдельная задача.
 */
export const NODE_FIELDS: readonly NodeFieldSpec[] = Object.freeze([
  { field: "kind", column: "kind", type: "text", nullable: false },
  { field: "layer", column: "layer", type: "int", nullable: false },
  { field: "scope", column: "scope", type: "text", nullable: false },
  { field: "title", column: "title", type: "text", nullable: false },
  { field: "body", column: "body", type: "text", nullable: true },
  { field: "body_cold", column: "body_cold", type: "int", nullable: false },
  { field: "status", column: "status", type: "text", nullable: false },
  { field: "priority", column: "priority", type: "int", nullable: false },
  { field: "confidence", column: "confidence", type: "real", nullable: false },
  { field: "salience", column: "salience", type: "real", nullable: false },
  { field: "head_id", column: "head_id", type: "text", nullable: true },
  { field: "acl", column: "acl", type: "text", nullable: false },
  { field: "owner_id", column: "owner_id", type: "text", nullable: false },
  { field: "team_id", column: "team_id", type: "text", nullable: false },
  { field: "agent_id", column: "agent_id", type: "text", nullable: false },
  { field: "assignee", column: "assignee", type: "text", nullable: false },
  { field: "actor", column: "actor", type: "text", nullable: false },
  { field: "due_at", column: "due_at", type: "int", nullable: true },
  { field: "closed_at", column: "closed_at", type: "int", nullable: true },
  { field: "compacted_at", column: "compacted_at", type: "int", nullable: true },
  { field: "deleted_at", column: "deleted_at", type: "int", nullable: true },
] as const);

const NODE_FIELD_BY_NAME: ReadonlyMap<string, NodeFieldSpec> = new Map(
  NODE_FIELDS.map((s) => [s.field, s]),
);

export const NODE_FIELD_NAMES: readonly string[] = Object.freeze(
  NODE_FIELDS.map((s) => s.field),
);

/**
 * Холодные поля живут в JSON-колонке attrs и реплицируются ПОКЛЮЧЕВО:
 * имя поля операции — `attrs.<key>`. Замена attrs целиком одной LWW-записью
 * стирала бы параллельную правку соседнего ключа другим агентом, а per-key
 * LWW стоит ровно один json_set.
 */
export const ATTR_FIELD_PREFIX = "attrs.";

/** Ключ ограничен так, чтобы путь '$.<key>' в json_set был однозначен. */
export const ATTR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function attrField(key: string): string {
  return `${ATTR_FIELD_PREFIX}${assertAttrKey(key)}`;
}

export function isAttrField(field: string): boolean {
  return field.startsWith(ATTR_FIELD_PREFIX);
}

/** Ключ attrs из имени поля, либо undefined если поле не про attrs. */
export function attrKeyOf(field: string): string | undefined {
  if (!isAttrField(field)) return undefined;
  return assertAttrKey(field.slice(ATTR_FIELD_PREFIX.length));
}

export function assertAttrKey(key: string): string {
  if (!ATTR_KEY_RE.test(key)) {
    throw new GraphError(
      "graph.attr_key",
      `ключ attrs ${JSON.stringify(key)} не соответствует ${String(ATTR_KEY_RE)}`,
    );
  }
  return key;
}

/** Спека горячего поля; для attrs.<key> и неизвестных полей — undefined. */
export function nodeFieldSpec(field: string): NodeFieldSpec | undefined {
  return NODE_FIELD_BY_NAME.get(field);
}

export function assertNodeField(field: string): NodeFieldSpec | "attr" {
  if (isAttrField(field)) {
    assertAttrKey(field.slice(ATTR_FIELD_PREFIX.length));
    return "attr";
  }
  const spec = NODE_FIELD_BY_NAME.get(field);
  if (spec === undefined) {
    throw new GraphError(
      "graph.unknown_field",
      `поле ${JSON.stringify(field)} не реплицируется: ни колонка из NODE_FIELDS, ни attrs.<key>`,
    );
  }
  return spec;
}

/** Значение, которое драйвер связывает с плейсхолдером напрямую. */
export type SqlScalar = string | number | null;

/**
 * Привести значение операции к типу колонки. Проверка здесь, а не в SQL:
 * CHECK-констрейнт сообщил бы «constraint failed» без имени поля, а на
 * реплицированной операции это ещё и уронило бы применение всего пакета.
 */
export function coerceNodeFieldValue(
  spec: NodeFieldSpec,
  value: JsonValue,
): SqlScalar {
  if (value === null) {
    if (!spec.nullable) {
      throw new GraphError(
        "graph.field_type",
        `поле '${spec.field}' не допускает NULL`,
      );
    }
    return null;
  }
  switch (spec.type) {
    case "text":
      if (typeof value !== "string") {
        throw new GraphError(
          "graph.field_type",
          `поле '${spec.field}' ожидает строку, получено ${typeof value}`,
        );
      }
      return value;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new GraphError(
          "graph.field_type",
          `поле '${spec.field}' ожидает целое, получено ${JSON.stringify(value)}`,
        );
      }
      return value;
    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new GraphError(
          "graph.field_type",
          `поле '${spec.field}' ожидает число, получено ${JSON.stringify(value)}`,
        );
      }
      return value;
    case "json":
      return JSON.stringify(value);
  }
}

/**
 * Проверки, которые дублируют CHECK'и DDL. Дублирование намеренное: ошибка
 * должна называть поле и допустимые значения, а не «CHECK constraint failed».
 */
export function validateNodeField(field: string, value: JsonValue): void {
  switch (field) {
    case "kind":
      assertNodeKind(String(value));
      return;
    case "layer":
      assertRange(field, value, 0, 3, true);
      return;
    case "priority":
      assertRange(field, value, 0, 3, true);
      return;
    case "confidence":
      assertRange(field, value, 0, 1, false);
      return;
    case "acl":
      if (typeof value !== "string" || !ACL_MODES.includes(value)) {
        throw new GraphError(
          "graph.range",
          `acl '${String(value)}' недопустим; допустимы ${ACL_MODES.join(", ")}`,
        );
      }
      return;
    default:
      return;
  }
}

function assertRange(
  field: string,
  value: JsonValue,
  min: number,
  max: number,
  integer: boolean,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < min ||
    value > max
  ) {
    throw new GraphError(
      "graph.range",
      `поле '${field}' вне диапазона ${min}..${max}: ${JSON.stringify(value)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Формы записей
// ---------------------------------------------------------------------------

/** То, что принимает создание узла. Всё, кроме kind, имеет умолчание. */
export interface NodeInput {
  readonly id?: string;
  readonly kind: NodeKind;
  readonly layer?: Layer;
  readonly scope?: string;
  readonly title?: string;
  readonly body?: string | null;
  readonly status?: string;
  readonly priority?: number;
  readonly confidence?: number;
  readonly salience?: number;
  readonly head_id?: string | null;
  readonly acl?: string;
  readonly owner_id?: string;
  readonly team_id?: string;
  readonly agent_id?: string;
  readonly assignee?: string;
  readonly actor?: string;
  readonly due_at?: number | null;
  readonly closed_at?: number | null;
  /** Холодные поля; каждый ключ реплицируется отдельным attrs.<key>. */
  readonly attrs?: Readonly<Record<string, JsonValue>>;
}

/** Частичное обновление. `attrs` мержится поключево, а не заменяет объект. */
export interface NodePatch {
  readonly layer?: Layer;
  readonly scope?: string;
  readonly title?: string;
  readonly body?: string | null;
  readonly body_cold?: number;
  readonly status?: string;
  readonly priority?: number;
  readonly confidence?: number;
  readonly salience?: number;
  readonly head_id?: string | null;
  readonly acl?: string;
  readonly owner_id?: string;
  readonly team_id?: string;
  readonly agent_id?: string;
  readonly assignee?: string;
  readonly actor?: string;
  readonly due_at?: number | null;
  readonly closed_at?: number | null;
  readonly compacted_at?: number | null;
  readonly attrs?: Readonly<Record<string, JsonValue>>;
}

/** Строка nodes целиком, как её отдаёт SELECT. */
export interface NodeRecord {
  readonly id: string;
  readonly kind: NodeKind;
  readonly layer: number;
  readonly scope: string;
  readonly title: string;
  readonly body: string | null;
  readonly body_cold: number;
  readonly excerpt: string;
  readonly status: string;
  readonly priority: number;
  readonly confidence: number;
  readonly salience: number;
  readonly seen_count: number;
  readonly open_blockers: number;
  readonly head_id: string | null;
  readonly content_hash: string;
  readonly acl: string;
  readonly owner_id: string;
  readonly team_id: string;
  readonly agent_id: string;
  readonly assignee: string;
  readonly actor: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly accessed_at: number;
  readonly due_at: number | null;
  readonly closed_at: number | null;
  readonly compacted_at: number | null;
  readonly deleted_at: number | null;
  readonly hlc: number;
  readonly site_id: string;
  readonly attrs: Readonly<Record<string, JsonValue>>;
}

export interface EdgeRecord {
  readonly src: string;
  readonly type: EdgeKind;
  readonly dst: string;
  readonly weight: number;
  /** op_id добавления — тег OR-Set. */
  readonly add_tag: string;
  readonly actor: string;
  readonly created_at: number;
  readonly hlc: number;
  readonly site_id: string;
  readonly deleted_at: number | null;
  readonly attrs: Readonly<Record<string, JsonValue>>;
}

/**
 * Разложить вход создания на горячие поля и холодные attrs, подставив
 * умолчания по kind. Возвращает пары (field, value) в виде операций LWW —
 * ровно то, что уйдёт в оплог.
 */
export function nodeInputFields(
  input: NodeInput,
): Array<readonly [string, JsonValue]> {
  const kind = assertNodeKind(input.kind);
  const out: Array<readonly [string, JsonValue]> = [];
  const put = (field: string, value: JsonValue): void => {
    validateNodeField(field, value);
    out.push([field, value]);
  };

  put("kind", kind);
  put("layer", input.layer ?? DEFAULT_LAYER[kind]);
  put("scope", input.scope ?? "");
  put("title", input.title ?? "");
  if (input.body !== undefined) put("body", input.body);
  put("status", assertStatus(kind, input.status ?? DEFAULT_STATUS[kind]));
  if (input.priority !== undefined) put("priority", input.priority);
  if (input.confidence !== undefined) put("confidence", input.confidence);
  if (input.salience !== undefined) put("salience", input.salience);
  if (input.head_id !== undefined) put("head_id", input.head_id);
  if (input.acl !== undefined) put("acl", input.acl);
  if (input.owner_id !== undefined) put("owner_id", input.owner_id);
  if (input.team_id !== undefined) put("team_id", input.team_id);
  if (input.agent_id !== undefined) put("agent_id", input.agent_id);
  if (input.assignee !== undefined) put("assignee", input.assignee);
  if (input.actor !== undefined) put("actor", input.actor);
  if (input.due_at !== undefined) put("due_at", input.due_at);
  if (input.closed_at !== undefined) put("closed_at", input.closed_at);

  for (const [key, value] of Object.entries(input.attrs ?? {})) {
    out.push([attrField(key), value]);
  }
  return out;
}

/** То же для обновления: только присутствующие ключи, без умолчаний. */
export function nodePatchFields(
  kind: NodeKind,
  patch: NodePatch,
): Array<readonly [string, JsonValue]> {
  const out: Array<readonly [string, JsonValue]> = [];
  for (const spec of NODE_FIELDS) {
    if (spec.field === "kind") continue; // kind неизменяем (§2.2)
    const value = (patch as Record<string, unknown>)[spec.field];
    if (value === undefined) continue;
    const jsonValue = value as JsonValue;
    if (spec.field === "status") assertStatus(kind, String(jsonValue));
    validateNodeField(spec.field, jsonValue);
    out.push([spec.field, jsonValue]);
  }
  for (const [key, value] of Object.entries(patch.attrs ?? {})) {
    out.push([attrField(key), value]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Чеканка операций оплога
// ---------------------------------------------------------------------------

export interface OpFactoryOptions {
  readonly clock?: HlcClock;
  /** Последний известный seq (myc_meta.last_seq). Новые начнутся с +1. */
  readonly lastSeq?: number;
  /** Генератор тегов OR-Set. По умолчанию `${site_id}:${seq}`, как у Site. */
  readonly tag?: (siteId: string, seq: number) => string;
}

/**
 * Чеканка операций БЕЗ накопления состояния в памяти.
 *
 * `Site` из oplog.ts — эталонная реализация для мержа и синхронизации: она
 * держит всё сходимое состояние в памяти и на каждой операции клонирует его
 * целиком (cloneState). Для сайта на 100k узлов это O(n) на запись, то есть
 * прямое нарушение бюджета 5 мс. У долговременного хранилища состояние —
 * это сами таблицы (`nodes`, `edges`, `field_clock`, `counters`,
 * `edge_tombstones`), и второй его копии в памяти быть не должно.
 *
 * Поэтому здесь взяты ровно те примитивы оплога, что описывают ФОРМУ
 * операции — HlcClock, makeOpId, edgeKey и типы Op, — а сходимое состояние
 * остаётся в SQL. Формат записи побайтово тот же, что у Site: операции
 * из обоих источников сливаются функцией merge() без оговорок.
 */
export class OpFactory {
  readonly siteId: string;
  readonly clock: HlcClock;
  private seq: number;
  private readonly tagFn: (siteId: string, seq: number) => string;

  constructor(siteId: string, opts: OpFactoryOptions = {}) {
    this.siteId = siteId;
    // Часы от нуля допустимы только для фабрики без хранилища. Поверх
    // оплога их обязан поднять движок (GraphStore.seedClock, S38): иначе две
    // записи одного сайта в одну миллисекунду дают равную пару (hlc, site_id).
    this.clock = opts.clock ?? new HlcClock();
    this.seq = opts.lastSeq ?? 0;
    this.tagFn = opts.tag ?? makeOpId;
  }

  /** myc_meta.last_seq */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Подтянуть seq к хвосту, увиденному в хранилище. Только вперёд: seq
   * монотонен на сайт, и откатить его назад нельзя ни при каких условиях.
   * Нужен движку, который делит site_id с другими процессами (CLI и
   * долгоживущий MCP-сервер одного воркспейса): перед выдачей op_id он
   * читает последний зафиксированный seq под блокировкой записи.
   */
  advanceSeq(seenSeq: number): void {
    if (Number.isFinite(seenSeq) && seenSeq > this.seq) this.seq = seenSeq;
  }

  private next(): { seq: number; hlc: Hlc; op_id: string } {
    const hlc = this.clock.now();
    const seq = this.seq + 1;
    this.seq = seq;
    return { seq, hlc, op_id: makeOpId(this.siteId, seq) };
  }

  set(entityId: string, field: string, value: JsonValue): SetOp {
    return {
      op: "set",
      ...this.next(),
      site_id: this.siteId,
      entity_id: entityId,
      field,
      value,
    };
  }

  /**
   * G-counter. `accumulated` — новое НАКОПЛЕННОЕ значение этого сайта, а не
   * дельта: так слияние сводится к поэлементному максимуму и остаётся
   * идемпотентным (см. комментарий к IncOp). Читает его вызывающий — из
   * таблицы counters, потому что она и есть состояние.
   */
  inc(entityId: string, field: string, accumulated: number): IncOp {
    if (!Number.isInteger(accumulated) || accumulated < 0) {
      throw new GraphError(
        "graph.field_type",
        `G-counter '${field}': накопленное значение должно быть неотрицательным целым, получено ${accumulated}`,
      );
    }
    return {
      op: "inc",
      ...this.next(),
      site_id: this.siteId,
      entity_id: entityId,
      field,
      value: accumulated,
    };
  }

  edgeAdd(
    src: string,
    type: EdgeKind,
    dst: string,
    weight?: number,
  ): EdgeAddOp {
    const meta = this.next();
    const tag = this.tagFn(this.siteId, meta.seq);
    return {
      op: "edge_add",
      ...meta,
      site_id: this.siteId,
      entity_id: edgeKey(src, type, dst),
      field: type,
      value: weight === undefined ? { tag } : { tag, weight },
    };
  }

  /**
   * `tags` — теги добавления, живые в базе НА МОМЕНТ удаления. Добавления,
   * которых этот сайт не видел, переживут удаление: это add-wins.
   */
  edgeDel(
    src: string,
    type: EdgeKind,
    dst: string,
    tags: readonly string[],
  ): EdgeDelOp {
    return {
      op: "edge_del",
      ...this.next(),
      site_id: this.siteId,
      entity_id: edgeKey(src, type, dst),
      field: type,
      value: { tags: [...tags] },
    };
  }
}

/** Ребро само в себя запрещено CHECK (src <> dst) — ловим до SQL. */
export function assertEdgeEndpoints(src: string, dst: string): void {
  if (src === dst) {
    throw new GraphError(
      "graph.self_edge",
      `ребро из узла в себя же запрещено: ${src}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Supersession и режимы истории (§6.3)
// ---------------------------------------------------------------------------

/**
 * Обновление знания НЕ затирает прежнее. Новая версия встаёт головой цепочки,
 * старая остаётся строкой в базе и получает `head_id` головы:
 *
 *     A ←supersedes— B ←supersedes— C
 *     C.head_id = NULL,  A.head_id = B.head_id = C.id
 *
 * Отсюда два режима чтения:
 *
 *   follow        (умолчание) — из любого звена видна ОДНА актуальная версия;
 *                 в SQL это `head_id IS NULL` в каждом ретривальном запросе;
 *   full_history  — видна вся цепочка целиком; включается флагом на узле
 *                 (`attrs.history_mode='full'`), флагом запроса
 *                 (`myc show --chain`, `myc search --history`) или
 *                 MCP-параметром `include_superseded`.
 *
 * ПОЧЕМУ ЭТО НЕ ПРОСТО ОБХОД УКАЗАТЕЛЕЙ. `head_id` — обычное поле, а значит
 * per-field LWW: при слиянии двух веток оплога, где каждая надстроила свою
 * версию над общим предком, побеждает одна метка часов, и цепочка становится
 * РАЗВИЛКОЙ — два звена без входящего `supersedes`. Рёбра при этом не теряются
 * (add-wins OR-Set), теряется только однозначность головы. Поэтому:
 *
 *   - состав цепочки собирается по НЕОРИЕНТИРОВАННОЙ связности рёбер
 *     `supersedes` и указателей `head_id` — ни одна версия не выпадает;
 *   - порядок — устойчивая топологическая сортировка с разрывом ничьих по
 *     (created_at, id), одинаковая на всех машинах;
 *   - голова при развилке выбирается детерминированно (позднейшая по
 *     created_at, при равенстве — меньший id), поэтому две реплики,
 *     применившие один набор операций в разном порядке, показывают одну и ту
 *     же актуальную версию, а не расходятся молча.
 */
export type HistoryMode = "follow" | "full_history";

export const HISTORY_MODES: readonly HistoryMode[] = Object.freeze([
  "follow",
  "full_history",
]);

/** Ключ в attrs, включающий полную историю на самом узле (§6.3). */
export const HISTORY_MODE_ATTR = "history_mode";
/** Значение этого ключа, означающее full_history. */
export const HISTORY_MODE_FULL = "full";

/**
 * Бюджет ЧТЕНИЯ цепочки: сколько строк версий имеет смысл доставать из
 * хранилища за один show/recall. Совпадает с maxDepth ребра supersedes.
 * Это предел выборки, а не предел истории: сама VersionGraph ничего не
 * усекает — иначе full_history молча беднела бы на длинных цепочках.
 */
export const HISTORY_MAX_DEPTH = EDGE_SEMANTICS.supersedes.maxDepth;

export function isHistoryMode(value: string): value is HistoryMode {
  return value === "follow" || value === "full_history";
}

/** Режим, объявленный самим узлом; по умолчанию follow. */
export function historyModeOf(
  attrs: Readonly<Record<string, JsonValue>> | undefined,
): HistoryMode {
  return attrs?.[HISTORY_MODE_ATTR] === HISTORY_MODE_FULL ? "full_history" : "follow";
}

/**
 * Кусок SQL для режима чтения. Ровно одно место, где живёт условие
 * `head_id IS NULL`, — чтобы «полная история по запросу» не превратилась в
 * восемь независимых копий предиката по ретривальным запросам.
 */
export function historyClause(mode: HistoryMode, alias = "n"): string {
  return mode === "follow" ? ` AND ${alias}.head_id IS NULL` : "";
}

/**
 * Минимум, который нужен от строки узла, чтобы построить историю.
 *
 * ЗДЕСЬ НЕТ `created_at` — И ЭТО НАМЕРЕННО. У узла, приехавшего по
 * репликации, `created_at` ставится ЛОКАЛЬНЫМ временем материализации
 * (GraphStore.materializeNode), то есть у одной и той же версии на двух
 * машинах он разный — в замере расхождение 45 мс. Сортировка цепочки по
 * нему давала бы на двух репликах РАЗНЫЙ порядок версий и разную «актуальную»
 * — молчаливое расхождение ровно того рода, которое эта задача обязана
 * закрыть. Поэтому ключи сравнения только реплицируемые: сами рёбра
 * `supersedes`, пара `(hlc, site_id)` последней победившей записи и `id`.
 */
export interface VersionNode {
  readonly id: string;
  readonly head_id: string | null;
  /** nodes.hlc — упакованный HLC победившей записи; одинаков на всех репликах. */
  readonly hlc?: number;
  /** nodes.site_id той же записи — вторая половина ключа сравнения. */
  readonly site_id?: string;
}

/** Ребро supersedes: `newer` заменяет `older`. */
export interface VersionLink {
  readonly newer: string;
  readonly older: string;
}

export interface VersionGraphInput {
  readonly nodes: Iterable<VersionNode>;
  readonly supersedes?: Iterable<VersionLink>;
}

/**
 * Цепочка версий как данные. Строится из строк узлов и рёбер `supersedes`,
 * ничего не знает ни о SQL, ни о хранилище: тот же объект собирается из
 * SQLite, из Postgres и из состояния оплога в тесте.
 */
export class VersionGraph {
  readonly #nodes = new Map<string, VersionNode>();
  /** id → кто его заменяет (входящие supersedes). */
  readonly #newer = new Map<string, Set<string>>();
  /** id → кого он заменяет (исходящие supersedes). */
  readonly #older = new Map<string, Set<string>>();
  /** head_id → кто на него указывает; обратный индекс, чтобы обход был линейным. */
  readonly #pointedBy = new Map<string, Set<string>>();

  constructor(input: VersionGraphInput) {
    for (const n of input.nodes) this.#nodes.set(n.id, n);
    for (const n of this.#nodes.values()) {
      if (n.head_id !== null && n.head_id !== n.id) getOrAdd(this.#pointedBy, n.head_id).add(n.id);
    }
    for (const l of input.supersedes ?? []) {
      if (l.newer === l.older) continue;
      getOrAdd(this.#newer, l.older).add(l.newer);
      getOrAdd(this.#older, l.newer).add(l.older);
    }
  }

  has(id: string): boolean {
    return this.#nodes.has(id);
  }

  node(id: string): VersionNode | undefined {
    return this.#nodes.get(id);
  }

  /**
   * Все версии, связанные с `id`, от старой к новой. Обход
   * неориентированный: и по рёбрам supersedes в обе стороны, и по указателям
   * head_id в обе стороны, — потому что после слияния веток любая из этих
   * связей может оказаться единственной, соединяющей версию с семьёй.
   */
  chain(id: string): readonly string[] {
    if (!this.#nodes.has(id)) return [];
    const seen = new Set<string>([id]);
    const queue = [id];
    // Обход ограничен множеством уже виденных, а НЕ глубиной: усечение по
    // HISTORY_MAX_DEPTH здесь молча выбрасывало бы версии из full_history,
    // то есть делало бы ровно то, ради запрета чего цепочка и заведена.
    // Ввод конечен, поэтому обход конечен; бюджет чтения строк ограничивает
    // тот, кто их достаёт (там HISTORY_MAX_DEPTH и применяется).
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of this.#adjacent(cur)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return this.#ordered(seen);
  }

  /**
   * Актуальная версия (режим follow). При развилке — детерминированный
   * выбор, одинаковый на всех репликах.
   */
  head(id: string): string {
    const heads = this.heads(id);
    return heads[0] ?? id;
  }

  /**
   * Головы цепочки: звенья, которых никто не заменяет. Больше одной — след
   * слияния двух веток; список отсортирован так, что первая — выбранная
   * актуальная.
   */
  heads(id: string): readonly string[] {
    const chain = this.chain(id);
    if (chain.length === 0) return [];
    const members = new Set(chain);
    const heads = chain.filter((m) => !this.#superseded(m, members));
    // Пусто — только при цикле в supersedes, то есть при порче данных:
    // отдаём всю цепочку, чтобы выбор остался детерминированным, а не пустым.
    const pool = heads.length > 0 ? heads : [...chain];
    // Кого цепочка САМА назвала головой: head_id — поле под per-field LWW,
    // и его победитель уже выбран CRDT одинаково на всех репликах. Голоса
    // важнее всего: так выбор головы совпадает с тем, что записано в базе.
    const votes = new Map<string, number>();
    for (const m of members) {
      const h = this.#nodes.get(m)?.head_id ?? null;
      if (h !== null && h !== m) votes.set(h, (votes.get(h) ?? 0) + 1);
    }
    return [...pool].sort((a, b) => {
      const d = (votes.get(b) ?? 0) - (votes.get(a) ?? 0);
      if (d !== 0) return d;
      // Дальше — тот же порядок разрешения конфликтов, что у всего оплога:
      // (hlc, site_id), затем id. Всё реплицируемое, ничего локального.
      return -this.#byClock(a, b);
    });
  }

  /** Развилка — больше одной головы; это состояние обязано быть видимым. */
  forked(id: string): boolean {
    return this.heads(id).length > 1;
  }

  /** Выдача по режиму: follow — одна актуальная, full_history — вся цепочка. */
  view(id: string, mode: HistoryMode): readonly string[] {
    if (!this.#nodes.has(id)) return [];
    return mode === "follow" ? [this.head(id)] : this.chain(id);
  }

  #adjacent(id: string): string[] {
    const out: string[] = [];
    for (const n of this.#newer.get(id) ?? []) if (this.#nodes.has(n)) out.push(n);
    for (const o of this.#older.get(id) ?? []) if (this.#nodes.has(o)) out.push(o);
    const head = this.#nodes.get(id)?.head_id ?? null;
    if (head !== null && head !== id && this.#nodes.has(head)) out.push(head);
    for (const other of this.#pointedBy.get(id) ?? []) if (this.#nodes.has(other)) out.push(other);
    return out;
  }

  /** Звено заменено, если его кто-то заменяет ребром или на кого-то указывает head_id. */
  #superseded(id: string, members: ReadonlySet<string>): boolean {
    for (const n of this.#newer.get(id) ?? []) if (members.has(n)) return true;
    const head = this.#nodes.get(id)?.head_id ?? null;
    return head !== null && head !== id && members.has(head);
  }

  /**
   * Сравнение двух версий там, где рёбра ничего не говорят: (hlc, site_id),
   * затем id. Ровно тот же порядок, которым оплог разрешает конфликты
   * (compareClock), и все три ключа реплицируются побайтово — поэтому две
   * машины с одним набором операций дают одну и ту же цепочку.
   */
  #byClock(a: string, b: string): number {
    const na = this.#nodes.get(a);
    const nb = this.#nodes.get(b);
    const ha = na?.hlc ?? 0;
    const hb = nb?.hlc ?? 0;
    if (ha !== hb) return ha < hb ? -1 : 1;
    const sa = na?.site_id ?? "";
    const sb = nb?.site_id ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * Устойчивый топологический порядок «старое → новое». Порядок задают рёбра
   * `supersedes`; ничьи разрываются по (hlc, site_id, id). Ни один ключ не
   * зависит ни от порядка вставки, ни от порядка применения операций оплога,
   * ни от локальных часов реплики.
   */
  #ordered(members: ReadonlySet<string>): string[] {
    const cmp = (a: string, b: string): number => this.#byClock(a, b);
    const indeg = new Map<string, number>();
    for (const m of members) {
      let d = 0;
      for (const o of this.#older.get(m) ?? []) if (members.has(o)) d++;
      indeg.set(m, d);
    }
    const ready = [...members].filter((m) => indeg.get(m) === 0).sort(cmp);
    const out: string[] = [];
    const done = new Set<string>();
    while (ready.length > 0) {
      const cur = ready.shift()!;
      out.push(cur);
      done.add(cur);
      for (const n of this.#newer.get(cur) ?? []) {
        if (!members.has(n)) continue;
        const left = (indeg.get(n) ?? 0) - 1;
        indeg.set(n, left);
        if (left === 0) {
          ready.push(n);
          ready.sort(cmp);
        }
      }
    }
    // Цикл в supersedes: остаток дописывается по (created_at, id), чтобы
    // ни одна версия не пропала из full_history из-за порчи данных.
    if (out.length < members.size) {
      const left = [...members].filter((m) => !done.has(m)).sort(cmp);
      out.push(...left);
    }
    return out;
  }
}

function getOrAdd(m: Map<string, Set<string>>, k: string): Set<string> {
  let s = m.get(k);
  if (s === undefined) {
    s = new Set<string>();
    m.set(k, s);
  }
  return s;
}

/** Что записать при классе `update` (§6.2, §6.3). */
export interface SupersessionPlan {
  /** Новая голова цепочки. */
  readonly head: string;
  /** Ребро supersedes: новая версия → заменяемая. */
  readonly edge: { readonly src: string; readonly type: "supersedes"; readonly dst: string };
  /** Кому проставить head_id = head: заменяемая версия и вся её цепочка. */
  readonly rehead: readonly string[];
}

/**
 * План обновления. Отдельная чистая функция, а не пять строк внутри записи:
 * «цепочка, а не затирание» — инвариант, и он обязан быть проверяем без БД.
 * `rehead` содержит ВСЮ цепочку заменяемой версии, иначе после третьего
 * звена предки продолжали бы указывать на промежуточную голову.
 */
export function supersessionPlan(
  graph: VersionGraph,
  oldId: string,
  newId: string,
): SupersessionPlan {
  const rehead = graph.chain(oldId).filter((id) => id !== newId);
  if (rehead.length === 0 && graph.has(oldId) && oldId !== newId) rehead.push(oldId);
  return {
    head: newId,
    edge: { src: newId, type: "supersedes", dst: oldId },
    rehead,
  };
}

// ---------------------------------------------------------------------------
// Чтение цепочки: один запрос и один обход на все поверхности
// ---------------------------------------------------------------------------

/**
 * Единственный запрос, которым со стороны хранилища читаются строки версий.
 * Раньше он жил копией в `show` (`version_rows`) и второй, обрезанной копией
 * в `absorb` (`chain_of`, только `head_id = ?1`), и вторая копия не видела
 * сам узел — то есть две поверхности собирали ОДНУ цепочку из разных строк.
 *
 * `(id = ?1 OR head_id = ?1)` — узел и всё, что на него указывает; живые
 * строки, потому что удалённая версия не звено цепочки, а мусор.
 */
export const versionQueries = defineQueries({
  version_rows: {
    name: "version_rows",
    sql: `SELECT id, head_id, hlc, site_id FROM nodes
           WHERE (id = ?1 OR head_id = ?1) AND deleted_at IS NULL
           ORDER BY id LIMIT ?2`,
    params: ["id", "limit"],
  },
});

/**
 * Доступ к хранилищу, нужный сборке цепочки, — и ничего сверх него. Такой
 * порт нужен потому, что core не знает ни о SQLite, ни о CLI: одну и ту же
 * сборку обязаны получать show, absorb и любая будущая поверхность.
 */
export interface VersionSource {
  /** Живые строки, связанные с seed напрямую: сам узел и указывающие на него. */
  rows(seed: string, limit: number): readonly VersionNode[];
  /** Живая строка версии по id; `undefined` — нет такой или удалена. */
  row(id: string): VersionNode | undefined;
  /** Рёбра `supersedes`, инцидентные id, в ОБЕ стороны. */
  supersedes(id: string): readonly VersionLink[];
}

/** Минимум от хранилища рёбер: ровно то, что уже умеет GraphStore. */
export interface VersionEdgeReader {
  edgesFrom(src: string, type?: EdgeKind): readonly { src: string; dst: string }[];
  edgesTo(dst: string, type?: EdgeKind): readonly { src: string; dst: string }[];
  getNode(id: string, includeDeleted?: boolean): { id: string; head_id: string | null; hlc: number; site_id: string; deleted_at: number | null } | undefined;
}

/** Порт поверх драйвера и GraphStore: собирается там, где есть и то и другое. */
export function versionSourceOf(driver: DbDriver, store: VersionEdgeReader): VersionSource {
  return {
    rows: (seed, limit) => driver.all<VersionNode>(versionQueries.version_rows, [seed, limit]),
    row: (id) => {
      const n = store.getNode(id, true);
      if (n === undefined || n.deleted_at !== null) return undefined;
      return { id: n.id, head_id: n.head_id, hlc: n.hlc, site_id: n.site_id };
    },
    supersedes: (id) => {
      const out: VersionLink[] = [];
      for (const e of store.edgesFrom(id, "supersedes")) out.push({ newer: e.src, older: e.dst });
      for (const e of store.edgesTo(id, "supersedes")) out.push({ newer: e.src, older: e.dst });
      return out;
    },
  };
}

export interface VersionCollection {
  readonly graph: VersionGraph;
  /** Строк больше бюджета чтения: цепочка показана не целиком (И2). */
  readonly truncated: boolean;
}

/**
 * Собрать цепочку версий вокруг `self`. Единственная реализация обхода на
 * все поверхности: подъём по указателям `head_id`, добор строк по каждому
 * найденному звену и расширение по рёбрам `supersedes` — потому что после
 * слияния веток любая из этих связей может оказаться единственной,
 * соединяющей версию с семьёй.
 *
 * Бюджет `limit` ограничивает ЧТЕНИЕ строк, а не саму историю: упёрлись —
 * `truncated`, а не молчаливый обрез (§6.3, И2).
 */
export function collectVersions(
  src: VersionSource,
  self: VersionNode,
  limit: number = HISTORY_MAX_DEPTH + 1,
): VersionCollection {
  const rows = new Map<string, VersionNode>([[self.id, self]]);
  const queue: string[] = [self.id];
  const expanded = new Set<string>();

  const add = (n: VersionNode | undefined): void => {
    if (n === undefined || rows.has(n.id) || rows.size > limit) return;
    rows.set(n.id, n);
    queue.push(n.id);
  };

  // ЗАМЫКАНИЕ, А НЕ ОДИН ПРОХОД. Обход раскрывает КАЖДОЕ найденное звено, а
  // не только те, что нашлись от стартового: иначе собранное множество, а
  // с ним и выбранная голова, зависят от того, ИЗ КАКОГО звена спросили, —
  // ровно то расхождение, которое запрещает §6.3 («из любого звена видна
  // одна и та же актуальная версия»). Замер: обход одним проходом ронял
  // тест слияния 2 раза из 25, замыкание — 0 из 50.
  while (queue.length > 0 && rows.size <= limit) {
    const cur = queue.shift()!;
    if (expanded.has(cur)) continue;
    expanded.add(cur);
    // вверх по указателю head_id,
    const head = rows.get(cur)?.head_id ?? null;
    if (head !== null && head !== cur) add(src.row(head));
    // вниз по указателям — всё, что называет головой это звено,
    for (const r of src.rows(cur, limit)) add(r);
    // и по рёбрам supersedes в обе стороны: после слияния веток указатель
    // head_id (LWW) называет головой одну сторону, а ребро (add-wins
    // OR-Set) сохраняется у обеих.
    for (const l of src.supersedes(cur)) {
      for (const side of [l.newer, l.older]) if (!rows.has(side)) add(src.row(side));
    }
  }

  const links: VersionLink[] = [];
  for (const id of rows.keys()) {
    for (const l of src.supersedes(id)) {
      if (l.newer === id && rows.has(l.older)) links.push(l);
    }
  }

  return {
    graph: new VersionGraph({ nodes: [...rows.values()], supersedes: links }),
    truncated: rows.size > limit,
  };
}

