/**
 * Supersession и режимы истории (§6.3 01-core-data-model.md).
 *
 * Проверяется ровно то, что обещает спека:
 *   - обновление НЕ затирает знание, а строит цепочку через head_id;
 *   - режим follow отдаёт одну актуальную версию из любого звена;
 *   - режим full_history отдаёт всю цепочку, от старой к новой;
 *   - цепочка ПЕРЕЖИВАЕТ СЛИЯНИЕ двух веток оплога и не зависит от порядка
 *     применения операций.
 *
 * Последнее — не формальность. head_id это обычное поле, а значит per-field
 * LWW: две ветки, надстроившие свою версию над общим предком, дают развилку,
 * и без детерминированного выбора головы две машины показали бы РАЗНУЮ
 * актуальную версию, каждая считая себя правой. В этом репозитории дважды
 * (S38, S40) молчаливая потеря на гонках проходила мимо однопоточных тестов,
 * поэтому здесь сливаются настоящие операции оплога через merge(), а не
 * имитация.
 */

import { describe, expect, test } from "bun:test";
import {
  HISTORY_MAX_DEPTH,
  HISTORY_MODES,
  HISTORY_MODE_ATTR,
  HISTORY_MODE_FULL,
  VersionGraph,
  historyClause,
  historyModeOf,
  isHistoryMode,
  supersessionPlan,
  type VersionLink,
  type VersionNode,
} from "./graph.ts";
import { OpFactory } from "./graph.ts";
import {
  HlcClock,
  edgeKey,
  emptyState,
  isEdgeAlive,
  merge,
  packHlc,
  readField,
  type Op,
} from "./oplog.ts";

// ---------------------------------------------------------------------------
// Вспомогательное
// ---------------------------------------------------------------------------

function v(id: string, head: string | null, hlc = 0, site = "s"): VersionNode {
  return { id, head_id: head, hlc, site_id: site };
}

/** Цепочка из n версий как её оставляет absorb: голова последняя, остальные на неё. */
function chainOf(n: number): { nodes: VersionNode[]; links: VersionLink[]; head: string } {
  const ids = Array.from({ length: n }, (_, i) => `myc-v${i + 1}`);
  const head = ids[n - 1]!;
  const nodes = ids.map((id, i) => v(id, id === head ? null : head, 1_000 + i));
  const links: VersionLink[] = [];
  for (let i = 1; i < n; i++) links.push({ newer: ids[i]!, older: ids[i - 1]! });
  return { nodes, links, head };
}

// ---------------------------------------------------------------------------
// Режимы
// ---------------------------------------------------------------------------

describe("режимы истории (§6.3)", () => {
  test("режимов ровно два и они различимы", () => {
    expect([...HISTORY_MODES]).toEqual(["follow", "full_history"]);
    expect(isHistoryMode("follow")).toBe(true);
    expect(isHistoryMode("full_history")).toBe(true);
    expect(isHistoryMode("full")).toBe(false);
  });

  test("attrs.history_mode='full' включает полную историю на самом узле", () => {
    expect(historyModeOf(undefined)).toBe("follow");
    expect(historyModeOf({})).toBe("follow");
    expect(historyModeOf({ [HISTORY_MODE_ATTR]: HISTORY_MODE_FULL })).toBe("full_history");
    expect(historyModeOf({ [HISTORY_MODE_ATTR]: "active" })).toBe("follow");
  });

  test("предикат head_id IS NULL живёт в одном месте, а не в восьми запросах", () => {
    expect(historyClause("follow")).toBe(" AND n.head_id IS NULL");
    expect(historyClause("follow", "x")).toBe(" AND x.head_id IS NULL");
    // full_history не подменяет предикат «чем-то другим», а снимает его.
    expect(historyClause("full_history")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ПРИЁМКА: цепочка из пяти версий
// ---------------------------------------------------------------------------

describe("цепочка из 5 версий", () => {
  const { nodes, links, head } = chainOf(5);
  const g = new VersionGraph({ nodes, supersedes: links });

  test("по умолчанию (follow) из ЛЮБОГО звена видна одна актуальная версия", () => {
    for (const n of nodes) {
      expect(g.view(n.id, "follow")).toEqual([head]);
      expect(g.head(n.id)).toBe(head);
    }
    expect(g.forked(head)).toBe(false);
  });

  test("по запросу (full_history) видна вся цепочка, от старой к новой", () => {
    const expected = nodes.map((n) => n.id);
    for (const n of nodes) {
      expect(g.view(n.id, "full_history")).toEqual(expected);
    }
    expect(g.chain(head)).toHaveLength(5);
  });

  test("порядок вставки узлов и рёбер на выдачу не влияет", () => {
    const shuffled = new VersionGraph({
      nodes: [...nodes].reverse(),
      supersedes: [links[3]!, links[0]!, links[2]!, links[1]!],
    });
    expect(shuffled.view(nodes[0]!.id, "full_history")).toEqual(nodes.map((n) => n.id));
    expect(shuffled.head(nodes[0]!.id)).toBe(head);
  });

  test("цепочка собирается и по одним head_id, без рёбер (сжатый путь duplicates)", () => {
    const noEdges = new VersionGraph({ nodes });
    expect(noEdges.head(nodes[0]!.id)).toBe(head);
    expect([...noEdges.view(nodes[0]!.id, "full_history")].sort()).toEqual(
      nodes.map((n) => n.id).sort(),
    );
  });

  test("узел вне цепочки остаётся сам себе головой", () => {
    const lone = new VersionGraph({ nodes: [v("myc-alone", null, 1)] });
    expect(lone.view("myc-alone", "follow")).toEqual(["myc-alone"]);
    expect(lone.view("myc-alone", "full_history")).toEqual(["myc-alone"]);
    expect(lone.view("myc-нет-такого", "full_history")).toEqual([]);
  });

  test("цикл в supersedes не вешает обход и не теряет версий", () => {
    const broken = new VersionGraph({
      nodes: chainOf(3).nodes,
      supersedes: [
        { newer: "myc-v2", older: "myc-v1" },
        { newer: "myc-v3", older: "myc-v2" },
        { newer: "myc-v1", older: "myc-v3" },
      ],
    });
    expect(broken.chain("myc-v1")).toHaveLength(3);
    expect(broken.head("myc-v1")).toBe("myc-v3");
  });

  test("длинная цепочка не усекается: бюджет чтения — не предел истории", () => {
    expect(HISTORY_MAX_DEPTH).toBe(64);
    const long = chainOf(HISTORY_MAX_DEPTH + 40);
    const graph = new VersionGraph({ nodes: long.nodes, supersedes: long.links });
    const chain = graph.chain(long.nodes[0]!.id);
    // Ни одной версии не потеряно, порядок сквозной.
    expect(chain).toEqual(long.nodes.map((n) => n.id));
    expect(graph.head(long.nodes[0]!.id)).toBe(long.head);
  });
});

// ---------------------------------------------------------------------------
// План обновления: цепочка, а не затирание
// ---------------------------------------------------------------------------

describe("supersessionPlan — обновление строит цепочку", () => {
  test("новая версия становится головой, head_id переезжает ВСЕЙ цепочке", () => {
    const { nodes, links } = chainOf(4);
    const g = new VersionGraph({ nodes, supersedes: links });
    const plan = supersessionPlan(g, "myc-v4", "myc-v5");
    expect(plan.head).toBe("myc-v5");
    expect(plan.edge).toEqual({ src: "myc-v5", type: "supersedes", dst: "myc-v4" });
    expect([...plan.rehead].sort()).toEqual(["myc-v1", "myc-v2", "myc-v3", "myc-v4"]);
  });

  test("первое обновление одиночного узла: цепочка из двух", () => {
    const g = new VersionGraph({ nodes: [v("myc-a", null, 1)] });
    const plan = supersessionPlan(g, "myc-a", "myc-b");
    expect(plan.rehead).toEqual(["myc-a"]);
  });

  test("применение плана даёт ту же цепочку из пяти, что и absorb", () => {
    let nodes: VersionNode[] = [v("myc-v1", null, 1_000)];
    const links: VersionLink[] = [];
    for (let i = 2; i <= 5; i++) {
      const id = `myc-v${i}`;
      const g = new VersionGraph({ nodes, supersedes: links });
      const plan = supersessionPlan(g, `myc-v${i - 1}`, id);
      nodes = [
        ...nodes.map((n) => (plan.rehead.includes(n.id) ? v(n.id, plan.head, n.hlc) : n)),
        v(id, null, 1_000 + i),
      ];
      links.push({ newer: plan.edge.src, older: plan.edge.dst });
    }
    const g = new VersionGraph({ nodes, supersedes: links });
    expect(g.view("myc-v1", "follow")).toEqual(["myc-v5"]);
    expect(g.view("myc-v1", "full_history")).toEqual([
      "myc-v1",
      "myc-v2",
      "myc-v3",
      "myc-v4",
      "myc-v5",
    ]);
    // Ни одна из четырёх старых версий не потеряна: затирания нет.
    expect(nodes).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// ПРИЁМКА: цепочка переживает слияние двух веток оплога
// ---------------------------------------------------------------------------

/** Операции одной ветки: своя версия поверх общего предка. */
function branchOps(
  site: string,
  startMs: number,
  ancestor: string,
  version: string,
  createdAt: number,
): Op[] {
  let t = startMs;
  const f = new OpFactory(site, { clock: new HlcClock({ now: () => (t += 1) }) });
  return [
    f.set(version, "kind", "note"),
    f.set(version, "created_at", createdAt),
    f.set(version, "head_id", null),
    f.edgeAdd(version, "supersedes", ancestor, 0.97),
    // Голова цепочки переезжает предку — тот самый UPDATE из §6.3.
    f.set(ancestor, "head_id", version),
    f.set(ancestor, "status", "superseded"),
  ];
}

function ancestorOps(site: string, startMs: number, id: string, createdAt: number): Op[] {
  let t = startMs;
  const f = new OpFactory(site, { clock: new HlcClock({ now: () => (t += 1) }) });
  return [
    f.set(id, "kind", "note"),
    f.set(id, "created_at", createdAt),
    f.set(id, "head_id", null),
  ];
}

/** Проекция состояния оплога в цепочку версий — то же, что делает хранилище. */
function graphOf(state: ReturnType<typeof emptyState>, ids: readonly string[]): VersionGraph {
  const nodes: VersionNode[] = [];
  for (const id of ids) {
    const kind = readField(state, id, "kind");
    if (kind === undefined) continue;
    const entry = readField(state, id, "head_id");
    const head = entry?.value ?? null;
    // Ровно то, что кладёт в строку узла хранилище: значение поля плюс часы
    // ПОБЕДИВШЕЙ записи. Локального времени здесь нет и быть не может.
    nodes.push({
      id,
      head_id: typeof head === "string" ? head : null,
      hlc: entry === undefined ? 0 : Number(packHlc(entry.clock.hlc)),
      site_id: entry?.clock.site_id ?? "",
    });
  }
  const links: VersionLink[] = [];
  for (const newer of ids) {
    for (const older of ids) {
      if (newer === older) continue;
      if (isEdgeAlive(state, edgeKey(newer, "supersedes", older))) links.push({ newer, older });
    }
  }
  return new VersionGraph({ nodes, supersedes: links });
}

describe("слияние двух веток оплога (CRDT)", () => {
  const ANCESTOR = "myc-anc";
  const A = "myc-brA";
  const B = "myc-brB";
  const IDS = [ANCESTOR, A, B];

  const base = ancestorOps("site-0", 1_700_000_000_000, ANCESTOR, 1_000);
  // Две машины НЕ видели друг друга: обе надстроили свою версию над общим предком.
  const branchA = branchOps("site-a", 1_700_000_010_000, ANCESTOR, A, 2_000);
  const branchB = branchOps("site-b", 1_700_000_020_000, ANCESTOR, B, 3_000);

  const left = merge(merge(merge(emptyState(), base), branchA), branchB);
  const right = merge(merge(merge(emptyState(), base), branchB), branchA);
  const shuffled = merge(emptyState(), [...branchB, ...base, ...branchA]);

  test("порядок применения не меняет итог: три порядка — одна цепочка", () => {
    const gl = graphOf(left, IDS);
    const gr = graphOf(right, IDS);
    const gs = graphOf(shuffled, IDS);
    expect(gr.view(ANCESTOR, "full_history")).toEqual([...gl.view(ANCESTOR, "full_history")]);
    expect(gs.view(ANCESTOR, "full_history")).toEqual([...gl.view(ANCESTOR, "full_history")]);
    expect(gr.head(ANCESTOR)).toBe(gl.head(ANCESTOR));
    expect(gs.head(ANCESTOR)).toBe(gl.head(ANCESTOR));
  });

  test("ни одна версия не потеряна: full_history отдаёт все три", () => {
    const g = graphOf(left, IDS);
    expect(g.view(ANCESTOR, "full_history")).toEqual([ANCESTOR, A, B]);
    // Из любого звена видна вся семья — иначе вторую ветку нечем найти.
    expect(g.view(A, "full_history")).toEqual([ANCESTOR, A, B]);
    expect(g.view(B, "full_history")).toEqual([ANCESTOR, A, B]);
  });

  test("развилка видна и разрешается одинаково на обеих машинах", () => {
    const gl = graphOf(left, IDS);
    const gr = graphOf(right, IDS);
    expect(gl.forked(ANCESTOR)).toBe(true);
    expect([...gl.heads(ANCESTOR)]).toEqual([...gr.heads(ANCESTOR)]);
    // Актуальной названа та, на которую указывает head_id предка: этот
    // победитель уже выбран per-field LWW, одинаково на обеих машинах.
    expect(gl.head(ANCESTOR)).toBe(B);
    expect(gr.head(ANCESTOR)).toBe(B);
  });

  test("оба ребра supersedes пережили слияние (add-wins), поле head_id — одно", () => {
    expect(isEdgeAlive(left, edgeKey(A, "supersedes", ANCESTOR))).toBe(true);
    expect(isEdgeAlive(left, edgeKey(B, "supersedes", ANCESTOR))).toBe(true);
    expect(isEdgeAlive(right, edgeKey(A, "supersedes", ANCESTOR))).toBe(true);
    expect(isEdgeAlive(right, edgeKey(B, "supersedes", ANCESTOR))).toBe(true);
    // LWW на head_id даёт ОДНО значение — и одинаковое при любом порядке.
    expect(readField(left, ANCESTOR, "head_id")?.value).toBe(
      readField(right, ANCESTOR, "head_id")?.value as string,
    );
  });

  test("слияние идемпотентно: повтор пакета ничего не меняет", () => {
    const again = merge(left, [...branchA, ...branchB, ...base]);
    const g1 = graphOf(left, IDS);
    const g2 = graphOf(again, IDS);
    expect(g2.view(ANCESTOR, "full_history")).toEqual([...g1.view(ANCESTOR, "full_history")]);
    expect(g2.head(ANCESTOR)).toBe(g1.head(ANCESTOR));
  });
});
