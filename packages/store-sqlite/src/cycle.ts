/**
 * Ацикличность рёбер, у которых НЕТ материализованного замыкания (§4.3
 * docs/design/01-core-data-model.md).
 *
 * `parent` защищён иначе — таблицей `parent_closure` (closure.ts): там факт
 * «B уже потомок A» стоит один индексный спуск, потому что замыкание нужно
 * горячему пути и без того. У `blocks` замыкания нет и не будет: он
 * материализуется в счётчик `open_blockers`, а не в транзитивную таблицу, —
 * значит цикл ловится обходом при вставке, и цена обхода становится частью
 * бюджета записи (И1, 5 мс).
 *
 * ДВЕ ГРАНИЦЫ ОБХОДА, И ВТОРАЯ ВАЖНЕЕ ПЕРВОЙ.
 *
 * 1. Глубина `MAX_BLOCKS_DEPTH` = 64 — из §11 (таблица констант), то же
 *    число, что `EDGE_SEMANTICS.blocks.maxDepth`. Реальная цепочка
 *    блокировок — единицы звеньев; 64 звена означают граф, который человек
 *    уже не читает.
 *
 * 2. Бюджет обхода `MAX_BLOCKS_REACH` = 512 посещённых узлов. Он здесь
 *    потому, что ОДНА глубина цену не ограничивает — это измерено, а не
 *    предположено (cycle.latency.test.ts, стенд 100k узлов / 193k рёбер):
 *      узел с 500 исходящими рёбрами, из которого достижимо 20 000 узлов
 *      НА ГЛУБИНЕ 40 (то есть предел глубины даже не задет):
 *        обход без бюджета               — 445 мс   (89× бюджета записи);
 *        рекурсивный CTE из §4.3, бюджет 4096 —  9.7 мс (2× бюджета);
 *        BFS с бюджетом 4096             —   6.0 мс;
 *        BFS с бюджетом 512              —   0.13 мс.
 *    Отсюда и число 512: худший случай стоит 2.6 % бюджета записи, а
 *    достижимых блокеров больше пятисот у одной задачи не бывает.
 *
 * ПОЧЕМУ BFS В КОДЕ, А НЕ РЕКУРСИВНЫЙ CTE ИЗ §4.3. CTE в спеке несёт пару
 * (id, глубина) и дедуплицируется по ней целиком: узел, достижимый на пяти
 * разных глубинах, обходится пять раз. На том же стенде это стоило 0.64 мс
 * там, где дедупликация по одному id стоит 0.07 мс, а на широком узле —
 * сотни миллисекунд. Вдобавок CTE материализует достижимое множество и лишь
 * потом обрезает его пределом, тогда как BFS останавливается в тот момент,
 * когда предел достигнут (1.23 мс против 0.09 мс на широком узле). И третье:
 * BFS отдаёт ПУТЬ цикла даром, а CTE потребовал бы второго прохода.
 *
 * ПОЧЕМУ ОТКАЗ ПО ПРЕДЕЛУ — ОТДЕЛЬНАЯ НОВОСТЬ (И2). Упёршись в предел, мы НЕ
 * доказали ацикличность — мы перестали искать. Молча пропустить вставку
 * значило бы завести цикл, молча отклонить под видом цикла — соврать про
 * причину. Поэтому два разных кода: `closure.cycle` (путь найден, вот он) и
 * `closure.depth` (искать дальше дороже бюджета записи); наружу они выходят
 * как `precond.cycle` и `precond.depth`.
 *
 * Класс ошибки — общий с `parent` (`ClosureError` из closure.ts), потому что
 * общий и контракт наружу: у CLI одна ветка `graphFailure` на оба механизма,
 * и заводить второй класс значило бы получить у одного отказа два кода.
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Он не трогает операции, приехавшие по
 * репликации: §4.3 прямо требует цикл, возникший при мерже, ПОМЕЧАТЬ, а не
 * отвергать (операция уже принята другим сайтом). Проверка живёт только на
 * локальной вставке (`GraphStore.addEdge`), а `applyOps` идёт мимо неё.
 */

import { EDGE_SEMANTICS, defineQueries, type DbDriver, type EdgeKind } from "@myc/core";
import { ClosureError } from "./closure.ts";

/**
 * Предел глубины обхода при проверке цикла `blocks` — §11 (таблица констант).
 * Берётся из семантики ребра, а не дублируется числом: разъехавшиеся копии
 * одной константы — это два разных ответа на один вопрос.
 */
export const MAX_BLOCKS_DEPTH = EDGE_SEMANTICS.blocks.maxDepth;

/**
 * Предел ЧИСЛА посещённых узлов. Обоснование числом — в шапке модуля: на
 * широком узле обход без него стоит 445 мс при бюджете записи 5 мс.
 */
export const MAX_BLOCKS_REACH = 512;

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const Q = defineQueries({
  /**
   * Один шаг обхода: живые исходящие рёбра узла данного типа.
   *
   * Без `INDEXED BY` сознательно: на этой форме запроса планировщик берёт
   * кластерный ключ `edges` (src, type, dst) — префиксный спуск ровно по
   * обоим связанным колонкам, — и это оказалось быстрее навязанного
   * частичного `ix_edges_type` (type, src) на замере широкого узла
   * (0.75 мс против 1.23 мс). Тест плана в cycle.test.ts следит, чтобы
   * запрос не сполз в скан таблицы.
   */
  edge_out: {
    name: "edge_out",
    sql: `SELECT dst FROM edges
           WHERE src = ?1 AND type = ?2 AND deleted_at IS NULL
           ORDER BY dst`,
    params: ["src", "type"],
  },
});

/** Тексты запросов наружу — тестам плана и замерам, чтобы мерили ТОТ ЖЕ SQL. */
export const cycleQueries = Q;

// ---------------------------------------------------------------------------
// Обход
// ---------------------------------------------------------------------------

/** Чем кончился обход: путь найден, либо упёрлись в один из двух пределов. */
type WalkResult =
  | { readonly kind: "cycle"; readonly path: string[] }
  | { readonly kind: "clear" }
  | { readonly kind: "depth" }
  | { readonly kind: "reach"; readonly seen: number };

/**
 * BFS `from → … → to` по живым рёбрам типа `type`, с множеством посещённых
 * (каждый узел ровно раз) и двумя пределами. Кратчайший путь — следствие
 * послойного обхода: у цикла длины 10 назвать надо все десять звеньев, а не
 * первые попавшиеся.
 *
 * Множество посещённых — не оптимизация, а условие завершимости: в графе
 * уже может лежать цикл, приехавший мержем (§4.3 такие рёбра помечает, а не
 * удаляет), и обход без него не остановился бы вовсе.
 */
function walk(
  db: DbDriver,
  from: string,
  to: string,
  type: EdgeKind,
  maxDepth: number,
  maxReach: number,
): WalkResult {
  const cameFrom = new Map<string, string | null>([[from, null]]);
  let frontier = [from];
  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontier.length === 0) return { kind: "clear" };
    const next: string[] = [];
    for (const cur of frontier) {
      for (const row of db.all<{ dst: string }>(Q.edge_out!, [cur, type])) {
        if (cameFrom.has(row.dst)) continue;
        cameFrom.set(row.dst, cur);
        if (row.dst === to) {
          const path = [to];
          let p: string | null = cur;
          while (p !== null) {
            path.unshift(p);
            p = cameFrom.get(p) ?? null;
          }
          return { kind: "cycle", path };
        }
        if (cameFrom.size >= maxReach) return { kind: "reach", seen: cameFrom.size };
        next.push(row.dst);
      }
    }
    frontier = next;
  }
  return frontier.length === 0 ? { kind: "clear" } : { kind: "depth" };
}

// ---------------------------------------------------------------------------
// Проверка (§4.3) — только чтение, ничего не мутирует
// ---------------------------------------------------------------------------

/**
 * Отказывает, если вставка ребра `type(src → dst)` замкнула бы цикл, либо
 * если доказать обратное дешевле пределов не вышло. Ничего не пишет.
 *
 * Направление обхода: ищем `src`, стартуя из `dst`. Ребро ведёт src → dst,
 * значит цикл — это уже существующий путь dst → … → src.
 */
export function checkEdgeAcyclic(
  db: DbDriver,
  src: string,
  type: EdgeKind,
  dst: string,
  maxDepth: number = MAX_BLOCKS_DEPTH,
  maxReach: number = MAX_BLOCKS_REACH,
): void {
  if (src === dst) {
    throw new ClosureError(
      "closure.cycle",
      `edge ${type}(${src} → ${dst}) would create a cycle: ${src} → ${src}`,
      [src, src],
    );
  }
  const res = walk(db, dst, src, type, maxDepth, maxReach);
  if (res.kind === "clear") return;
  if (res.kind === "cycle") {
    // Путь начинается и кончается на `dst`: сперва цепочка, которая УЖЕ есть
    // в графе (dst → … → src), затем ребро, которое её замыкает (src → dst).
    // Так читается, какое звено лишнее, а не только то, что кольцо есть.
    const cycle = [...res.path, dst];
    throw new ClosureError(
      "closure.cycle",
      `edge ${type}(${src} → ${dst}) would create a cycle: ${cycle.join(" → ")}`,
      cycle,
    );
  }
  if (res.kind === "depth") {
    throw new ClosureError(
      "closure.depth",
      `the ${type} chain from ${dst} is longer than the depth limit ${maxDepth}: acyclicity ` +
        `of edge ${type}(${src} → ${dst}) not verified, insert rejected`,
    );
  }
  throw new ClosureError(
    "closure.depth",
    `more than ${maxReach} nodes are reachable from ${dst} via ${type} (traversal limit): ` +
      `acyclicity of edge ${type}(${src} → ${dst}) not verified, insert rejected`,
  );
}
