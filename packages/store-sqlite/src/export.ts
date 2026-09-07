/**
 * Экспорт графа в git (решение S42, ARCHITECTURE.md §10).
 *
 * В репозиторий уходит ТОЛЬКО ОПЛОГ — append-only лог неизменяемых записей
 * с уникальным op_id. Для него задача мержа исчезает: слияние двух веток —
 * объединение строк, сортировка и дедупликация по op_id (./merge-driver.ts),
 * а расхождения разрешает не git, а воспроизведение CRDT при импорте
 * (./import.ts), где per-field LWW, OR-Set и G-counter делают свою работу.
 *
 * Проекции узлов и рёбер (nodes-<c>.jsonl, edges-<c>.jsonl) в git НЕ идут.
 * Первая редакция S42 коммитила их ради читаемого диффа; замер это отменил:
 * на 2700 операциях оплог — 420 КБ, проекции добавляли ещё 292 КБ (+70 %
 * места за ноль информации), а пересборка стоит 28 мс (~10 мкс/операцию).
 * Оплог сам читаем — одна операция на строку, и его дифф показывает, что
 * произошло, а не только чем кончилось. Главное же: две закоммиченные
 * версии одного состояния способны разойтись, и обнаружить это нечем.
 * Поэтому проекции — локальный кеш рядом с базой (PROJECTION_CACHE_DIR),
 * который сам себя игнорирует в git и пересобирается `myc import`;
 * прецедент в проекте — graft держит свой граф в .gitignore.
 *
 * Раскладка `.myc/graph/` (коммитится):
 *
 *   .gitattributes                   один драйвер слияния (см. GITATTRIBUTES)
 *   meta.json                        версия формата и схемы
 *   oplog/<site>/<NNNNN>.jsonl       операции сайта, по OPLOG_FILE_OPS в файле
 *
 * Раскладка `.myc/projections/` (кеш, не коммитится):
 *
 *   .gitignore                       «*» — каталог игнорирует сам себя
 *   nodes-<c>.jsonl, edges-<c>.jsonl 32 корзины по первому символу тела ID
 *
 * Почему оплог разбит по site_id и диапазону seq, а не по дате. Две ветки
 * расходятся только между машинами, а машина — это site_id: чужие ветки
 * никогда не пишут в файлы моего сайта, и пересечение по файлам равно нулю
 * везде, кроме хвостового файла ОДНОГО сайта, экспортированного с двух веток
 * (одна база — суперсет другой; объединение по op_id это и закрывает).
 * Диапазон seq детерминирован и монотонен, дата — нет: HLC сайта может
 * прыгнуть на перевод часов, и одна операция «уехала» бы в чужой файл.
 *
 * Почему OPLOG_FILE_OPS = 1000. Строка операции — 120–220 байт (замер в
 * тестах: ~170 байт в среднем), 1000 строк ≈ 170 КБ — под порогом 500 КБ,
 * после которого GitHub перестаёт показывать дифф файла, и на порядок ниже
 * 1 МБ, где он перестаёт показывать файл вовсе. Дифф append-only файла —
 * всегда один хвостовой блок «+N строк», его читаемость от размера файла
 * не зависит. Меньшие файлы (100) дали бы тысячу файлов на сайт за 100k
 * операций и ничего не улучшили: хвостовой файл всё равно один. Большие
 * (10k) переваливали бы за порог рендера и тянули бы 1–2 МБ на каждое
 * `git show`. Создание задачи — 6–9 операций, так что файл вмещает ~130
 * задач или ~2 рабочих дня агента.
 *
 * Экспорт ДЕТЕРМИНИРОВАН: файлы — чистая функция от множества операций.
 * Поэтому в строку оплога не входят actor/scope/origin/seq базы: реплика
 * при applyOps журналирует чужую операцию со своим actor и текущим scope
 * узла, и эти колонки расходятся между машинами, хотя операция одна и та
 * же. Всё, что нужно CRDT, — это Op: op_id, hlc, вид, сущность, поле,
 * значение. Кеш проекций — функция от CRDT-состояния: в него входят только
 * реплицируемые поля (NODE_FIELDS + attrs + счётчики) и часы полей `_clk`;
 * created_at/updated_at/hlc строки и `edges.actor` зависят от порядка
 * применения на конкретной реплике и в кеш не идут — так две реплики с
 * одним оплогом дают побайтово равный кеш, что и проверяют тесты.
 * `nodes.actor` — реплицируемое поле NODE_FIELDS: с myc-9ok createNode
 * минтит для него set-операцию, и колонка сходится между машинами, поэтому
 * в кеш она входит.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  SCHEMA_VERSION,
  defineQueries,
  unpackHlc,
  type DbDriver,
  type JsonValue,
} from "@myc/core";
import type { OplogRow } from "./queries.ts";

// ---------------------------------------------------------------------------
// Константы формата
// ---------------------------------------------------------------------------

/** Операций в одном файле оплога — см. обоснование в шапке. */
export const OPLOG_FILE_OPS = 1000;

/** Версия формата файлов; растёт при несовместимой смене раскладки. */
export const GRAPH_FORMAT = 1;

export const OPLOG_DIR = "oplog";
export const META_FILE = "meta.json";
export const GITATTRIBUTES_FILE = ".gitattributes";
export const GITIGNORE_FILE = ".gitignore";

/**
 * Имя каталога кеша проекций — сосед каталога графа внутри `.myc/`, рядом
 * с базой: `.myc/projections/`.
 */
export const PROJECTION_CACHE_DIR = "projections";

/** Единственный драйвер слияния в git config (merge.<name>.driver). */
export const OPLOG_MERGE_DRIVER = "myc-oplog";

/** Виды операций, которые реплицируются. claim — lease, локальное состояние (§9.4). */
export const REPLICATED_OPS: ReadonlySet<string> = new Set([
  "set",
  "inc",
  "edge_add",
  "edge_del",
]);

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Атрибуты git для каталога графа: один драйвер, только для оплога.
 * meta.json атрибута не получает — это константа формата, одинаковая на
 * обеих сторонах; если она всё же разошлась (разные версии схемы), это
 * настоящий конфликт для человека, а не для драйвера.
 */
export const GITATTRIBUTES = [
  "# myc (S42): в git идёт только оплог, он сливается объединением по op_id;",
  "# проекции — локальный кеш, `myc import` пересобирает их. Драйвер один:",
  `#   git config merge.${OPLOG_MERGE_DRIVER}.driver "myc merge-driver %O %A %B %L %P"`,
  `${OPLOG_DIR}/**/*.jsonl merge=${OPLOG_MERGE_DRIVER}`,
  "",
].join("\n");

/** Кеш проекций игнорирует сам себя — независимо от корневого .gitignore. */
export const PROJECTION_CACHE_GITIGNORE = "# myc (S42): кеш проекций, пересобирается `myc import`\n*\n";

// ---------------------------------------------------------------------------
// Запросы экспорта — свои, потому что читают таблицы целиком в фиксированном
// порядке; в реестре Q таких выборок нет и они не нужны горячему пути.
// ---------------------------------------------------------------------------

const QX = defineQueries({
  oplog_all_replicated: {
    name: "oplog_all_replicated",
    sql: `SELECT seq, op_id, site_id, CAST(hlc AS TEXT) AS hlc, ts_ms, actor,
                 op, entity, entity_id, field, value, scope, origin
            FROM oplog
           WHERE op IN ('set','inc','edge_add','edge_del')
           ORDER BY site_id, seq`,
    params: [],
  },
  nodes_all: {
    name: "nodes_all",
    sql: `SELECT id, kind, layer, scope, title, body, body_cold, status, priority,
                 confidence, salience, seen_count, head_id, acl, owner_id, team_id,
                 agent_id, assignee, actor, due_at, closed_at, compacted_at,
                 deleted_at, attrs
            FROM nodes ORDER BY id`,
    params: [],
  },
  field_clock_all: {
    name: "field_clock_all",
    sql: `SELECT entity_id, field, CAST(hlc AS TEXT) AS hlc, site_id
            FROM field_clock ORDER BY entity_id, field`,
    params: [],
  },
  edges_all: {
    name: "edges_all",
    sql: `SELECT src, type, dst, weight, add_tag, CAST(hlc AS TEXT) AS hlc,
                 site_id, deleted_at
            FROM edges ORDER BY src, type, dst`,
    params: [],
  },
});

// ---------------------------------------------------------------------------
// Строка оплога
// ---------------------------------------------------------------------------

/** Одна строка файла оплога — ровно то, что нужно CRDT, и ничего локального. */
export interface OplogLine {
  readonly op_id: string;
  /** [ts_ms, counter] — читаемее упакованного 64-битного числа. */
  readonly hlc: readonly [number, number];
  readonly op: string;
  readonly entity: string;
  readonly entity_id: string;
  readonly field: string | null;
  readonly value: JsonValue;
}

/** op_id = `<site_id>:<seq>`; site_id сам может содержать двоеточие. */
export function splitOpId(opId: string): { siteId: string; seq: number } {
  const at = opId.lastIndexOf(":");
  if (at <= 0) throw new Error(`op_id без разделителя сайта: '${opId}'`);
  const seq = Number(opId.slice(at + 1));
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`op_id с некорректным seq: '${opId}'`);
  }
  return { siteId: opId.slice(0, at), seq };
}

/** Строка файла из строки оплога базы. Ключи — в фиксированном порядке. */
export function rowToLine(row: OplogRow): string {
  const { ts, ctr } = unpackHlc(BigInt(row.hlc));
  const value: JsonValue = row.value === null ? null : (JSON.parse(row.value) as JsonValue);
  const line: OplogLine = {
    op_id: row.op_id,
    hlc: [ts, ctr],
    op: row.op,
    entity: row.entity,
    entity_id: row.entity_id,
    field: row.field,
    value,
  };
  return JSON.stringify(line);
}

/**
 * Строка файла обратно в форму строки оплога — вход `rowToOp`. Локальные
 * колонки (seq базы, actor, scope, origin) заполняются нейтрально: их
 * выставит applyOps на принимающей стороне.
 */
export function lineToRow(text: string): OplogRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`строка оплога не JSON: ${text.slice(0, 80)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`строка оплога не объект: ${text.slice(0, 80)}`);
  }
  const l = parsed as Record<string, unknown>;
  const opId = l["op_id"];
  const hlc = l["hlc"];
  if (
    typeof opId !== "string" ||
    !Array.isArray(hlc) ||
    hlc.length !== 2 ||
    typeof hlc[0] !== "number" ||
    typeof hlc[1] !== "number" ||
    typeof l["op"] !== "string" ||
    typeof l["entity"] !== "string" ||
    typeof l["entity_id"] !== "string"
  ) {
    throw new Error(`строка оплога неполна: ${text.slice(0, 80)}`);
  }
  const { siteId } = splitOpId(opId);
  const packed = (BigInt(hlc[0]) << 16n) | BigInt(hlc[1]);
  const field = l["field"];
  return {
    seq: 0,
    op_id: opId,
    site_id: siteId,
    hlc: packed.toString(),
    ts_ms: hlc[0],
    actor: "",
    op: l["op"],
    entity: l["entity"],
    entity_id: l["entity_id"],
    field: typeof field === "string" ? field : null,
    value: l["value"] === undefined ? null : JSON.stringify(l["value"]),
    scope: "",
    origin: 0,
  };
}

/** Файлы оплога: имя каталога сайта безопасно для ФС, сам site_id живёт в op_id. */
export function siteDirName(siteId: string): string {
  return siteId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function oplogBucket(seq: number): number {
  return Math.floor((seq - 1) / OPLOG_FILE_OPS);
}

export function oplogFilePath(siteId: string, seq: number): string {
  return `${OPLOG_DIR}/${siteDirName(siteId)}/${String(oplogBucket(seq)).padStart(5, "0")}.jsonl`;
}

export function isOplogPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return norm.startsWith(`${OPLOG_DIR}/`) || norm.includes(`/${OPLOG_DIR}/`);
}

// ---------------------------------------------------------------------------
// Рендер файлов
// ---------------------------------------------------------------------------

/** Содержимое файлов по относительному пути, без записи на диск. */
export type GraphFiles = Map<string, string>;

/** Текст файла оплога из строк, уже отсортированных по seq. */
export function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function splitLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

/** Файлы оплога: сайт → корзины по seq; внутри файла строки по seq. */
export function renderOplogFiles(driver: DbDriver): GraphFiles {
  const rows = driver.all<OplogRow>(QX.oplog_all_replicated, []);
  const bySite = new Map<string, Array<{ seq: number; line: string }>>();
  for (const row of rows) {
    const { siteId, seq } = splitOpId(row.op_id);
    let list = bySite.get(siteId);
    if (list === undefined) {
      list = [];
      bySite.set(siteId, list);
    }
    list.push({ seq, line: rowToLine(row) });
  }
  const files: GraphFiles = new Map();
  for (const [siteId, list] of bySite) {
    list.sort((a, b) => a.seq - b.seq);
    let current: string[] = [];
    let currentPath = "";
    for (const { seq, line } of list) {
      const path = oplogFilePath(siteId, seq);
      if (path !== currentPath) {
        if (current.length > 0) files.set(currentPath, joinLines(current));
        current = [];
        currentPath = path;
      }
      current.push(line);
    }
    if (current.length > 0) files.set(currentPath, joinLines(current));
  }
  return files;
}

/** Корзина проекции: первый символ тела ID (после слага), 32 значения Crockford. */
export function projectionBucket(id: string): string {
  const dash = id.indexOf("-");
  const ch = (dash >= 0 ? id.charAt(dash + 1) : id.charAt(0)).toLowerCase();
  return CROCKFORD.includes(ch) && ch.length === 1 ? ch : "_";
}

/** JSON с рекурсивно отсортированными ключами: attrs не зависят от порядка json_set. */
export function canonicalJson(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, JsonValue>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

interface NodeExportRow {
  readonly id: string;
  readonly kind: string;
  readonly layer: number;
  readonly scope: string;
  readonly title: string;
  readonly body: string | null;
  readonly body_cold: number;
  readonly status: string;
  readonly priority: number;
  readonly confidence: number;
  readonly salience: number;
  readonly seen_count: number;
  readonly head_id: string | null;
  readonly acl: string;
  readonly owner_id: string;
  readonly team_id: string;
  readonly agent_id: string;
  readonly assignee: string;
  readonly actor: string;
  readonly due_at: number | null;
  readonly closed_at: number | null;
  readonly compacted_at: number | null;
  readonly deleted_at: number | null;
  readonly attrs: string;
}

interface ClockExportRow {
  readonly entity_id: string;
  readonly field: string;
  readonly hlc: string;
  readonly site_id: string;
}

interface EdgeExportRow {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
  readonly weight: number;
  readonly add_tag: string;
  readonly hlc: string;
  readonly site_id: string;
  readonly deleted_at: number | null;
}

function clockTriple(hlc: string, siteId: string): JsonValue {
  const { ts, ctr } = unpackHlc(BigInt(hlc));
  return [ts, ctr, siteId];
}

/**
 * Проекции (кеш): одна строка — один узел/ребро, ключи в алфавитном
 * порядке (`_clk` первым), строки по id / (src,type,dst). Только
 * реплицируемые поля — см. шапку файла.
 */
export function renderProjectionFiles(driver: DbDriver): GraphFiles {
  const clocks = new Map<string, Record<string, JsonValue>>();
  for (const c of driver.all<ClockExportRow>(QX.field_clock_all, [])) {
    let m = clocks.get(c.entity_id);
    if (m === undefined) {
      m = {};
      clocks.set(c.entity_id, m);
    }
    m[c.field] = clockTriple(c.hlc, c.site_id);
  }

  const buckets = new Map<string, string[]>();
  const push = (path: string, line: string): void => {
    let list = buckets.get(path);
    if (list === undefined) {
      list = [];
      buckets.set(path, list);
    }
    list.push(line);
  };

  for (const n of driver.all<NodeExportRow>(QX.nodes_all, [])) {
    let attrs: JsonValue = {};
    try {
      attrs = JSON.parse(n.attrs) as JsonValue;
    } catch {
      attrs = {};
    }
    const rec: Record<string, JsonValue> = {
      _clk: clocks.get(n.id) ?? {},
      acl: n.acl,
      actor: n.actor,
      agent_id: n.agent_id,
      assignee: n.assignee,
      attrs,
      body: n.body,
      body_cold: n.body_cold,
      closed_at: n.closed_at,
      compacted_at: n.compacted_at,
      confidence: n.confidence,
      deleted_at: n.deleted_at,
      due_at: n.due_at,
      head_id: n.head_id,
      id: n.id,
      kind: n.kind,
      layer: n.layer,
      owner_id: n.owner_id,
      priority: n.priority,
      salience: n.salience,
      scope: n.scope,
      seen_count: n.seen_count,
      status: n.status,
      team_id: n.team_id,
      title: n.title,
    };
    push(`nodes-${projectionBucket(n.id)}.jsonl`, canonicalJson(rec));
  }

  for (const e of driver.all<EdgeExportRow>(QX.edges_all, [])) {
    const rec: Record<string, JsonValue> = {
      _clk: clockTriple(e.hlc, e.site_id),
      add_tag: e.add_tag,
      deleted_at: e.deleted_at,
      dst: e.dst,
      src: e.src,
      type: e.type,
      weight: e.weight,
    };
    push(`edges-${projectionBucket(e.src)}.jsonl`, canonicalJson(rec));
  }

  const files: GraphFiles = new Map();
  for (const [path, lines] of buckets) files.set(path, joinLines(lines));
  return files;
}

export function renderMeta(): string {
  return `${JSON.stringify(
    { format: GRAPH_FORMAT, schema_version: SCHEMA_VERSION, oplog_file_ops: OPLOG_FILE_OPS },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Чтение и запись каталога
// ---------------------------------------------------------------------------

/** Все файлы оплога каталога: относительный путь → текст. Каталога нет ⇒ пусто. */
export function readOplogFiles(dir: string): GraphFiles {
  const files: GraphFiles = new Map();
  const root = join(dir, OPLOG_DIR);
  if (!existsSync(root)) return files;
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const nextAbs = join(abs, entry.name);
      const nextRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(nextAbs, nextRel);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.set(nextRel, readFileSync(nextAbs, "utf8"));
      }
    }
  };
  walk(root, OPLOG_DIR);
  return files;
}

export interface WriteResult {
  readonly written: string[];
  readonly unchanged: string[];
  readonly removed: string[];
}

/**
 * Записать набор файлов, не трогая совпадающие (mtime — сигнал для git и
 * редакторов). `prune` — шаблон файлов верхнего уровня, которых в наборе
 * больше нет и которые надо удалить: пустые корзины кеша, а в каталоге
 * графа — проекции, закоммиченные первой редакцией S42. Файлы оплога
 * никогда не удаляются и не усекаются — см. exportGraph.
 */
export function writeGraphFiles(
  dir: string,
  files: GraphFiles,
  prune?: (relPath: string) => boolean,
): WriteResult {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  for (const [rel, text] of files) {
    const abs = join(dir, rel);
    if (existsSync(abs) && readFileSync(abs, "utf8") === text) {
      unchanged.push(rel);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    written.push(rel);
  }
  if (prune !== undefined) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (files.has(entry.name) || !prune(entry.name)) continue;
      rmSync(join(dir, entry.name));
      removed.push(entry.name);
    }
  }
  return { written, unchanged, removed };
}

export function isProjectionFile(name: string): boolean {
  return /^(nodes|edges)-[0-9a-z_]\.jsonl$/.test(name);
}

export interface ExportResult {
  readonly dir: string;
  /** реплицируемых операций в файлах после экспорта */
  readonly ops: number;
  readonly sites: number;
  readonly files: WriteResult;
  /**
   * Операции, которые есть в файлах каталога, но ещё не в базе: экспорт
   * их не терял и не переписывал, но база без них неполна — `myc import`.
   */
  readonly pendingImport: number;
}

/**
 * Экспорт в каталог графа: оплог, meta.json и .gitattributes — и ничего
 * производного. Оплог пишется МОНОТОННО: существующий файл объединяется с
 * рендером по op_id, поэтому экспорт до импорта после `git pull` не сотрёт
 * чужие операции и не усечёт файл до подмножества. Проекции, оставшиеся в
 * каталоге от первой редакции S42, удаляются: git увидит удаление, и
 * производных файлов в репозитории не останется.
 */
export function exportGraph(driver: DbDriver, dir: string): ExportResult {
  const oplog = renderOplogFiles(driver);
  const existing = readOplogFiles(dir);
  let pendingImport = 0;
  for (const [rel, text] of existing) {
    const rendered = oplog.get(rel);
    if (rendered === undefined) {
      // Файл чужого сайта или корзина, которой в базе нет вовсе — оставляем.
      oplog.set(rel, text);
      pendingImport += splitLines(text).length;
      continue;
    }
    const merged = unionOplogText(rendered, text);
    if (merged.text !== rendered) {
      pendingImport += merged.added;
      oplog.set(rel, merged.text);
    }
  }

  const all: GraphFiles = new Map(oplog);
  all.set(META_FILE, renderMeta());
  all.set(GITATTRIBUTES_FILE, GITATTRIBUTES);
  const files = writeGraphFiles(dir, all, isProjectionFile);

  let ops = 0;
  for (const [rel, text] of all) {
    if (isOplogPath(rel)) ops += splitLines(text).length;
  }
  const sites = new Set([...all.keys()].filter(isOplogPath).map((p) => p.split("/")[1]))
    .size;
  return { dir, ops, sites, files, pendingImport };
}

export interface ProjectionCacheResult {
  readonly dir: string;
  readonly nodes: number;
  readonly edges: number;
  readonly files: WriteResult;
}

/**
 * Пересобрать кеш проекций из базы. Каталог получает `.gitignore` с «*»,
 * так что кеш не попадает в git, где бы ни лежал; пустые корзины удаляются.
 * Кеш — функция от CRDT-состояния: повторный вызов даёт те же байты.
 */
export function writeProjectionCache(driver: DbDriver, dir: string): ProjectionCacheResult {
  const projections = renderProjectionFiles(driver);
  let nodes = 0;
  let edges = 0;
  for (const [rel, text] of projections) {
    if (rel.startsWith("nodes-")) nodes += splitLines(text).length;
    else if (rel.startsWith("edges-")) edges += splitLines(text).length;
  }
  const all: GraphFiles = new Map(projections);
  all.set(GITIGNORE_FILE, PROJECTION_CACHE_GITIGNORE);
  const files = writeGraphFiles(dir, all, isProjectionFile);
  return { dir, nodes, edges, files };
}

/**
 * Объединение двух текстов оплога по op_id: строки `base` идут первыми, из
 * `extra` добавляются только новые; итог отсортирован по (site_id, seq).
 * `added` — сколько строк пришло из `extra`. Используется и экспортом, и
 * драйвером слияния — это и есть весь «мерж» оплога.
 */
export function unionOplogText(
  base: string,
  extra: string,
): { text: string; added: number } {
  const seen = new Map<string, { site: string; seq: number; line: string }>();
  let added = 0;
  const take = (text: string, counting: boolean): void => {
    for (const line of splitLines(text)) {
      const row = lineToRow(line);
      if (seen.has(row.op_id)) continue;
      const { siteId, seq } = splitOpId(row.op_id);
      seen.set(row.op_id, { site: siteId, seq, line });
      if (counting) added++;
    }
  };
  take(base, false);
  take(extra, true);
  const sorted = [...seen.values()].sort((a, b) =>
    a.site < b.site ? -1 : a.site > b.site ? 1 : a.seq - b.seq,
  );
  return { text: joinLines(sorted.map((s) => s.line)), added };
}

/** Размер файла в байтах или 0 — для отчётов и тестов о размере корзины. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
