/**
 * Переезд узла между воркспейсами (R4, memory-v2aht4p11vhm) — ЧИСТАЯ часть:
 * какой набор узлов обязан ехать одним куском и какие зависимости после
 * переезда пересекут границу баз.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ЕСТЬ. `open_blockers` материализуют триггеры ВНУТРИ одной
 * базы (§8.1.11), поэтому ребро `blocks`, у которого концы оказались в разных
 * воркспейсах, не считается нигде: в базе-источнике блокируемого узла уже
 * нет, а в базе-приёмнике нет блокирующего. Итог — задача с живым блокером
 * попадает в `ready` как готовая. Это молчаливо неверный ответ, а не
 * деградация, и И2 требует не допустить его, а не сообщить о нём после.
 *
 * ДВА ЗАКРЫТИЯ, И ОНИ РАЗНЫЕ ПО СИЛЕ:
 *
 *  1. Цепочка версий (`supersedes` + `head_id`) едет ВСЕГДА и без спроса.
 *     Версии одного узла — это один логический объект, разрезанный по базам
 *     он перестаёт собираться (VersionGraph ходит по звеньям, см. решение
 *     memory-zy9ba228m5qv: сборка обязана быть замыканием). «История цела» из
 *     приёмки — это в первую очередь она.
 *
 *  2. Замыкание по живым `blocks` НЕ едет само. Оно может утащить пол-графа,
 *     и решение «сколько работы переезжает» принимает человек, а не эвристика.
 *     Поэтому пересечение границы — ОТКАЗ (`withBlockers: false`, умолчание)
 *     со списком виноватых рёбер, и явное `--with-blockers` — согласие взять
 *     весь связный кусок.
 *
 * Рёбра ОСТАЛЬНЫХ типов (parent, relates, mentions…) границу пересекать
 * могут: они не материализуются ни в один счётчик, и их обрыв ничего не
 * искажает. Такое ребро просто остаётся в базе-источнике, где оба его конца
 * (узел-надгробие и оставшийся сосед) по-прежнему есть.
 *
 * Модуль чистый намеренно: соседей отдаёт оракул, а не драйвер, поэтому
 * закрытие и обнаружение пересечений проверяются без базы, а тесты на
 * настоящих процессах остаются про то, ради чего они и заводятся, — про
 * гонки между двумя базами.
 */

/** Живое ребро `blocks`: src блокирует dst. */
export interface MoveBlockEdge {
  readonly src: string;
  readonly dst: string;
}

/**
 * Оракул соседей. Ленивый: полные карты по всему графу строить нельзя —
 * переезд одной задачи не имеет права стоить обхода базы целиком.
 */
export interface MoveNeighbors {
  /**
   * ВСЯ цепочка версий узла, включая его самого. Это уже замыкание, а не
   * список смежных звеньев: собирать его повторно здесь было бы второй
   * копией обхода `collectVersions`, а копия обхода цепочки в этом проекте
   * уже дважды расходилась с оригиналом (см. history-predicate.test.ts).
   */
  versionChain(id: string): readonly string[];
  /** Живые рёбра `blocks`, у которых узел — один из концов. */
  blockLinks(id: string): readonly MoveBlockEdge[];
}

export interface MoveSetPlan {
  /** Что едет, в стабильном порядке. */
  readonly members: readonly string[];
  /** Живые `blocks`, которые после переезда пересекли бы границу баз. */
  readonly crossing: readonly MoveBlockEdge[];
  /** Набор расширен закрытием по `blocks` (запрошено `withBlockers`). */
  readonly expanded: boolean;
}

export interface PlanMoveSetOptions {
  /** Втянуть связный кусок по живым `blocks` вместо отказа. */
  readonly withBlockers?: boolean;
}

/**
 * Ключ `attrs`, помнящий прежний дом узла. Пишется в ту же транзакцию, что и
 * новый `scope`, и реплицируется как обычное LWW-поле: в обеих базах и у
 * любой третьей стороны значение одно и то же, поэтому сходимости он не
 * мешает, а `myc show` в старом воркспейсе может сказать «переехала», а не
 * показать узел с чужим охватом без объяснения.
 */
export const MOVED_FROM_KEY = "moved_from";

/** Ключ пары (src,dst) для дедупликации рёбер: `|` не встречается в ID. */
function blockKey(e: MoveBlockEdge): string {
  return `${e.src}|${e.dst}`;
}

/** Добор цепочек версий для новых членов набора. */
function closeVersions(
  members: Set<string>,
  frontier: readonly string[],
  n: MoveNeighbors,
): string[] {
  const added: string[] = [];
  for (const id of frontier) {
    for (const link of n.versionChain(id)) {
      if (members.has(link)) continue;
      members.add(link);
      added.push(link);
    }
  }
  return added;
}

/**
 * Набор переезда и пересекающие границу зависимости.
 *
 * Порядок шагов важен: закрытие по версиям идёт и до, и после каждого шага
 * закрытия по `blocks`. Иначе втянутая версия узла-блокера принесла бы новое
 * ребро `blocks`, которое уже никто бы не рассмотрел, и `crossing` соврал бы
 * пустотой — ровно та молчаливая неверность, которую этот модуль и ловит.
 */
export function planMoveSet(
  seed: readonly string[],
  n: MoveNeighbors,
  opts: PlanMoveSetOptions = {},
): MoveSetPlan {
  const members = new Set<string>(seed);
  closeVersions(members, [...members], n);

  const withBlockers = opts.withBlockers === true;
  let expanded = false;
  if (withBlockers) {
    for (;;) {
      const grown: string[] = [];
      for (const id of [...members]) {
        for (const e of n.blockLinks(id)) {
          const other = e.src === id ? e.dst : e.src;
          if (other === id || members.has(other)) continue;
          members.add(other);
          grown.push(other);
        }
      }
      if (grown.length === 0) break;
      expanded = true;
      grown.push(...closeVersions(members, grown, n));
    }
  }

  const crossing = new Map<string, MoveBlockEdge>();
  for (const id of members) {
    for (const e of n.blockLinks(id)) {
      if (members.has(e.src) === members.has(e.dst)) continue;
      crossing.set(blockKey(e), e);
    }
  }

  return {
    members: [...members].sort(),
    crossing: [...crossing.values()].sort((a, b) =>
      a.src === b.src ? a.dst.localeCompare(b.dst) : a.src.localeCompare(b.src),
    ),
    expanded,
  };
}
