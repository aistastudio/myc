/**
 * Материализованное замыкание `parent_closure` (§4.2, §4.3 docs/design/01-core-data-model.md).
 *
 * `parent` — единственный тип ребра, чьё транзитивное замыкание живёт в
 * отдельной таблице (не рекурсивный CTE по требованию), потому что поддерево,
 * дотовые пути и наследование `scope`/`acl` — частые операции горячего пути.
 *
 * Инвариант, на котором держится вся арифметика ниже: у узла в любой момент
 * времени не больше одного живого родителя (дерево, а не DAG) — на это прямо
 * указывает §3.2: `path(n) = if parent(n) is null then ... else path(parent(n))`,
 * единственное число. `insertCore` проверяет инвариант явно и отказывает, если
 * у ребёнка уже есть родитель в `parent_closure` — «перенос» обязан сперва
 * снять старое ребро (см. `applyParentMove`).
 *
 * `parent_closure` не хранит строк-петель (ancestor = descendant, depth = 0):
 * формула вставки в §4.2 — `|ancestors(p)|+1 × |descendants(c)|+1` — уже
 * учитывает «+1» для самого узла отдельно от хранимых строк.
 *
 * Разделение на «ядро» (`apply*`, принимает уже открытую транзакцию, ничего
 * не коммитит само) и «вход» (`insertParentEdge` и т.п., открывает
 * `db.tx(...)`) — по образцу `queries.ts` (`projectEdgeAdd`/`projectEdgeDel`
 * против `addEdge`/`removeEdge`): `SqliteDriver.tx` не поддерживает вложенные
 * транзакции, поэтому код, который однажды будет вызываться из чужой
 * транзакции (например, из `GraphStore.addEdge` при вставке ребра `parent`),
 * обязан получить именно `apply*`, а не top-level функцию.
 *
 * Эта таблица тут единственный источник правды для замыкания: модуль не
 * трогает `edges`/`queries.ts` на запись — только читает `edges` при полном
 * пересчёте (`applyRebuild`, аналог `myc doctor --recount`).
 */

import { defineQueries, type DbDriver } from "@myc/core";

/** Предел глубины `parent` из §11 (Таблица констант) — тот же, что и в EDGE_SEMANTICS.parent.maxDepth. */
export const MAX_PARENT_DEPTH = 32;

/**
 * Коды отказов §4.3. Первые два общие для ВСЕХ ацикличных типов рёбер, а не
 * только для `parent`: `blocks` проверяется обходом (cycle.ts), но наружу
 * обязан выходить теми же `precond.cycle` / `precond.depth` — человеку важен
 * характер отказа, а не то, каким механизмом он пойман.
 */
export type ClosureErrorCode =
  /** Вставка/перенос создали бы цикл: в сообщении — путь целиком. */
  | "closure.cycle"
  /** Слишком глубоко: у `parent` — итоговая цепочка длиннее предела, у
   *  `blocks` — обход упёрся в предел, не доказав ацикличности. */
  | "closure.depth"
  /** У ребёнка уже есть живой родитель — сначала снять его (move/remove). */
  | "closure.multiple_parents"
  /** Ожидаемое прямое ребро (родитель, ребёнок) отсутствует в замыкании. */
  | "closure.no_edge";

export class ClosureError extends Error {
  readonly code: ClosureErrorCode;
  /** Путь цикла src → … → src у `closure.cycle`; пуст у остальных кодов. */
  readonly path: readonly string[];
  constructor(code: ClosureErrorCode, message: string, path: readonly string[] = []) {
    super(message);
    this.name = "ClosureError";
    this.code = code;
    this.path = path;
  }
}

export interface ClosureRow {
  readonly ancestor: string;
  readonly descendant: string;
  readonly depth: number;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const Q = defineQueries({
  pc_direct_parent: {
    name: "pc_direct_parent",
    sql: "SELECT ancestor FROM parent_closure WHERE descendant = ?1 AND depth = 1",
    params: ["child"],
  },
  pc_is_ancestor: {
    name: "pc_is_ancestor",
    sql: "SELECT 1 AS x FROM parent_closure WHERE ancestor = ?1 AND descendant = ?2 LIMIT 1",
    params: ["ancestor", "descendant"],
  },
  pc_max_ancestor_depth: {
    name: "pc_max_ancestor_depth",
    sql: "SELECT COALESCE(MAX(depth), 0) AS d FROM parent_closure WHERE descendant = ?1",
    params: ["node"],
  },
  pc_max_descendant_depth: {
    name: "pc_max_descendant_depth",
    sql: "SELECT COALESCE(MAX(depth), 0) AS d FROM parent_closure WHERE ancestor = ?1",
    params: ["node"],
  },
  // Крест «предки p (плюс p) × потомки c (плюс c)» — ровно формула §4.2.
  // ?1 = parent, ?2 = child, каждый использован дважды по конструкции запроса.
  pc_insert_rows: {
    name: "pc_insert_rows",
    sql: `INSERT INTO parent_closure (ancestor, descendant, depth)
          SELECT a.anc, d.dsc, a.d + 1 + d.d
            FROM (
                   SELECT ancestor AS anc, depth AS d FROM parent_closure WHERE descendant = ?1
                   UNION ALL
                   SELECT ?1 AS anc, 0 AS d
                 ) a,
                 (
                   SELECT descendant AS dsc, depth AS d FROM parent_closure WHERE ancestor = ?2
                   UNION ALL
                   SELECT ?2 AS dsc, 0 AS d
                 ) d`,
    params: ["parent", "child"],
  },
  // Тот же крест — но удаление. Единственный путь предок→потомок в дереве
  // проходит ровно через ребро (parent, child), поэтому вырезание всего
  // прямоугольника «предки parent (плюс parent) × потомки child (плюс child)»
  // не оставляет висячих строк и не задевает то, что снаружи прямоугольника.
  pc_delete_rows: {
    name: "pc_delete_rows",
    sql: `DELETE FROM parent_closure
           WHERE ancestor IN (
                   SELECT ancestor FROM parent_closure WHERE descendant = ?1
                   UNION SELECT ?1
                 )
             AND descendant IN (
                   SELECT descendant FROM parent_closure WHERE ancestor = ?2
                   UNION SELECT ?2
                 )`,
    params: ["parent", "child"],
  },
  // Узел исчезает и как значение колонки ancestor у собственного поддерева —
  // это не покрывает pc_delete_rows (тот режет только записи со «внешними»
  // предками), поэтому отдельный шаг в applyNodeDeleted.
  pc_delete_as_ancestor: {
    name: "pc_delete_as_ancestor",
    sql: "DELETE FROM parent_closure WHERE ancestor = ?1",
    params: ["node"],
  },
  pc_delete_all: {
    name: "pc_delete_all",
    sql: "DELETE FROM parent_closure",
    params: [],
  },
  // Пересчёт с нуля из живых рёбер edges(type='parent') — источник истины для
  // сверки и для `myc doctor --recount`. GROUP BY + MIN(depth) — защита от
  // теоретического нарушения инварианта «один родитель» в самих edges (не
  // проверяется этим модулем на чтении, только на своей записи).
  //
  // `INDEXED BY sqlite_autoindex_edges_1` не косметика: без явного хинта
  // планировщик на рекурсивном шаге выбирает ix_edges_type (только по
  // `type='parent'`) и добирает `e.src = c.ancestor` линейным перебором —
  // на дереве 10k узлов/глубина 10 это ушло в ~95 секунд вместо ~85 мс с
  // хинтом (замерено). `edges` — WITHOUT ROWID с PK (src, type, dst), поэтому
  // автоиндекс `_1` — это и есть кластерный ключ по (src, type, ...), имя
  // стабильно, пока в DDL edges ровно один PRIMARY KEY (миграция 001).
  pc_rebuild_from_edges: {
    name: "pc_rebuild_from_edges",
    sql: `WITH RECURSIVE closure(descendant, ancestor, depth) AS (
            SELECT src, dst, 1 FROM edges INDEXED BY sqlite_autoindex_edges_1
             WHERE type = 'parent' AND deleted_at IS NULL
            UNION ALL
            SELECT c.descendant, e.dst, c.depth + 1
              FROM closure c
              JOIN edges e INDEXED BY sqlite_autoindex_edges_1
                ON e.src = c.ancestor AND e.type = 'parent' AND e.deleted_at IS NULL
             WHERE c.depth < 1000
          )
          INSERT INTO parent_closure (ancestor, descendant, depth)
          SELECT ancestor, descendant, MIN(depth) FROM closure GROUP BY ancestor, descendant`,
    params: [],
  },
  pc_count: {
    name: "pc_count",
    sql: "SELECT count(*) AS n FROM parent_closure",
    params: [],
  },
  pc_dump: {
    name: "pc_dump",
    sql: "SELECT ancestor, descendant, depth FROM parent_closure ORDER BY ancestor, descendant",
    params: [],
  },
  pc_descendants_of: {
    name: "pc_descendants_of",
    sql: "SELECT descendant, depth FROM parent_closure WHERE ancestor = ?1 ORDER BY depth, descendant",
    params: ["ancestor"],
  },
  pc_ancestors_of: {
    name: "pc_ancestors_of",
    sql: "SELECT ancestor, depth FROM parent_closure WHERE descendant = ?1 ORDER BY depth, ancestor",
    params: ["descendant"],
  },
});

// ---------------------------------------------------------------------------
// Внутренние чтения
// ---------------------------------------------------------------------------

function directParent(db: DbDriver, child: string): string | undefined {
  return db.one<{ ancestor: string }>(Q.pc_direct_parent!, [child])?.ancestor;
}

function isAncestor(db: DbDriver, ancestor: string, descendant: string): boolean {
  return db.one<{ x: number }>(Q.pc_is_ancestor!, [ancestor, descendant]) !== undefined;
}

function maxAncestorDepth(db: DbDriver, node: string): number {
  return db.one<{ d: number }>(Q.pc_max_ancestor_depth!, [node])?.d ?? 0;
}

function maxDescendantDepth(db: DbDriver, node: string): number {
  return db.one<{ d: number }>(Q.pc_max_descendant_depth!, [node])?.d ?? 0;
}

// ---------------------------------------------------------------------------
// Проверки (§4.3) — только чтение, ничего не мутируют
// ---------------------------------------------------------------------------

/**
 * Цепочка `from → … → to` вверх по прямым родителям. Замыкание отвечает на
 * вопрос «предок ли» одной строкой, но приёмка §4.3 требует назвать ПУТЬ, а
 * не пару концов: у цикла длины 10 «B уже потомок A» не говорит, какое из
 * девяти рёбер лишнее. Восстановление стоит по спуску на звено и живёт
 * только на дороге отказа — вставка, которую уже решено отклонить.
 *
 * Ограничено MAX_PARENT_DEPTH: в дереве цепочка короче, но если инвариант
 * «один родитель» когда-то нарушится (цикл, собранный мержем), цикл здесь
 * оборвётся счётчиком, а не подвесит процесс.
 */
function chainUp(db: DbDriver, from: string, to: string): string[] | undefined {
  const path = [from];
  let cur = from;
  for (let step = 0; step <= MAX_PARENT_DEPTH; step++) {
    const up = directParent(db, cur);
    if (up === undefined) return undefined;
    path.push(up);
    if (up === to) return path;
    cur = up;
  }
  return undefined;
}

/**
 * Отказывает, если вставка ребра `parent(child → parent)` создала бы цикл
 * или превысила MAX_PARENT_DEPTH. Не проверяет «у ребёнка уже есть родитель»
 * — это инвариант вставки (`insertCore`), а не самого ребра.
 */
export function checkParentInsert(db: DbDriver, child: string, parent: string): void {
  if (child === parent) {
    throw new ClosureError(
      "closure.cycle",
      `node ${child} cannot be its own parent: ${child} → ${child}`,
      [child, child],
    );
  }
  if (isAncestor(db, child, parent)) {
    const up = chainUp(db, parent, child);
    // Цепочка обязана найтись — замыкание только что сказало, что она есть.
    // Если нет (рассинхрон замыкания с рёбрами), называем концы: соврать про
    // путь хуже, чем назвать неполную правду.
    // Как и у `blocks` (cycle.ts): сперва существующая цепочка parent → … →
    // child, затем замыкающее её ребро child → parent.
    const cycle = up === undefined ? [parent, child, parent] : [...up, parent];
    throw new ClosureError(
      "closure.cycle",
      `edge parent(${child} → ${parent}) would create a cycle: ${cycle.join(" → ")}`,
      cycle,
    );
  }
  const depth = maxAncestorDepth(db, parent) + 1 + maxDescendantDepth(db, child);
  if (depth > MAX_PARENT_DEPTH) {
    throw new ClosureError(
      "closure.depth",
      `edge parent(${child} → ${parent}) exceeds the depth limit ${MAX_PARENT_DEPTH}: it would be ${depth}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ядро (принимает уже открытую транзакцию, вызывается композитно)
// ---------------------------------------------------------------------------

/** Материализовать вставку ребра `parent(child → parent)`. Бросает ClosureError, ничего не пишет при отказе. */
export function applyParentInsert(tx: DbDriver, child: string, parent: string): void {
  if (directParent(tx, child) !== undefined) {
    throw new ClosureError(
      "closure.multiple_parents",
      `node ${child} already has a parent in parent_closure — call applyParentRemove/applyParentMove first`,
    );
  }
  checkParentInsert(tx, child, parent);
  tx.run(Q.pc_insert_rows!, [parent, child]);
}

/** Материализовать удаление ребра `parent(child → parent)`. Требует, чтобы оно действительно было прямым родителем. */
export function applyParentRemove(tx: DbDriver, child: string, parent: string): void {
  const current = directParent(tx, child);
  if (current !== parent) {
    throw new ClosureError(
      "closure.no_edge",
      `edge parent(${child} → ${parent}) not found in parent_closure (current parent: ${current ?? "none"})`,
    );
  }
  tx.run(Q.pc_delete_rows!, [parent, child]);
}

/**
 * Перенос: снять текущего родителя ребёнка (если есть) и подвесить под
 * `newParent`. Самый опасный случай (§4.2) — не только строка ребёнка, а всё
 * его поддерево целиком должно переехать под новую цепочку предков.
 *
 * Порядок важен: сперва `applyParentRemove` (режет старый прямоугольник),
 * потом проверка/вставка под новым родителем — так `checkParentInsert` видит
 * состояние уже без старой связи и не спотыкается о неё как о «ложный цикл»,
 * а внутренняя структура поддерева (рёбра между потомками child) вырезание
 * не трогает вообще, потому что она не пересекает границу прямоугольника.
 */
export function applyParentMove(tx: DbDriver, child: string, newParent: string): void {
  const old = directParent(tx, child);
  if (old !== undefined) {
    applyParentRemove(tx, child, old);
  }
  applyParentInsert(tx, child, newParent);
}

/**
 * Узел исчезает из дерева (жёсткое удаление узла, каскад FK на `edges` уже
 * снёс его рёбра). `parent_closure` на `nodes`/`edges` FK не ссылается —
 * висячие строки надо снять руками: сначала разорвать связь с бывшим
 * родителем (если был), потом убрать узел из ancestor-колонки его же
 * бывшего поддерева (то, что applyParentRemove не задевает — см. её докстрок).
 * Поддерево не перевешивается на бывшего дедушку: реюз родителя удалённого
 * узла — решение вызывающей стороны (CRUD), не этого модуля.
 */
export function applyNodeDeleted(tx: DbDriver, nodeId: string): void {
  const parent = directParent(tx, nodeId);
  if (parent !== undefined) {
    applyParentRemove(tx, nodeId, parent);
  }
  tx.run(Q.pc_delete_as_ancestor!, [nodeId]);
}

/** Полный пересчёт из `edges` — источник истины для сверки и для `doctor --recount`. */
export function applyRebuild(tx: DbDriver): void {
  tx.run(Q.pc_delete_all!, []);
  tx.run(Q.pc_rebuild_from_edges!, []);
}

// ---------------------------------------------------------------------------
// Вход: открывает свою транзакцию (для standalone-вызовов — тестов, doctor)
// ---------------------------------------------------------------------------

export function insertParentEdge(db: DbDriver, child: string, parent: string): void {
  db.tx("immediate", (tx) => applyParentInsert(tx, child, parent));
}

export function removeParentEdge(db: DbDriver, child: string, parent: string): void {
  db.tx("immediate", (tx) => applyParentRemove(tx, child, parent));
}

export function moveParentEdge(db: DbDriver, child: string, newParent: string): void {
  db.tx("immediate", (tx) => applyParentMove(tx, child, newParent));
}

export function deleteNodeClosure(db: DbDriver, nodeId: string): void {
  db.tx("immediate", (tx) => applyNodeDeleted(tx, nodeId));
}

export function rebuildParentClosure(db: DbDriver): { rows: number } {
  return db.tx("immediate", (tx) => {
    applyRebuild(tx);
    return { rows: tx.one<{ n: number }>(Q.pc_count!, [])?.n ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Чтения для вызывающей стороны (подъём поддерева, наследование scope/acl)
// ---------------------------------------------------------------------------

export function dumpParentClosure(db: DbDriver): ClosureRow[] {
  return db.all<ClosureRow>(Q.pc_dump!, []);
}

/** Потомки `ancestor`, сам узел не включён (см. докстрок таблицы про self-строки). */
export function descendantsOf(
  db: DbDriver,
  ancestor: string,
): Array<{ descendant: string; depth: number }> {
  return db.all(Q.pc_descendants_of!, [ancestor]);
}

/** Предки `descendant`, сам узел не включён. */
export function ancestorsOf(
  db: DbDriver,
  descendant: string,
): Array<{ ancestor: string; depth: number }> {
  return db.all(Q.pc_ancestors_of!, [descendant]);
}
