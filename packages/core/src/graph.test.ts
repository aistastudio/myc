import { describe, expect, test } from "bun:test";
import {
  EDGE_KINDS,
  NODE_KINDS,
  HlcClock,
  edgeKey,
  emptyState,
  isEdgeAlive,
  liveTags,
  merge,
  readCounter,
  readField,
  type EdgeKind,
  type NodeKind,
} from "./index.ts";
import {
  ACL_MODES,
  ATTR_KEY_RE,
  CLOSED_STATUSES,
  DEFAULT_LAYER,
  DEFAULT_STATUS,
  EDGE_SEMANTICS,
  EXCERPT_MAX,
  GraphError,
  NODE_FIELDS,
  NODE_STATUSES,
  OpFactory,
  assertEdgeEndpoints,
  assertEdgeKind,
  assertNodeField,
  assertNodeKind,
  assertStatus,
  attrField,
  attrKeyOf,
  coerceNodeFieldValue,
  contentHash,
  edgeSemantics,
  isAttrField,
  isClosedStatus,
  makeExcerpt,
  nodeInputFields,
  nodePatchFields,
  nodeFieldSpec,
} from "./graph.ts";

describe("виды узлов и статусы (§2.3, §2.4)", () => {
  test("таблица статусов покрывает ровно девять kind из NODE_KINDS", () => {
    expect(Object.keys(NODE_STATUSES).sort()).toEqual([...NODE_KINDS].sort());
    expect(Object.keys(DEFAULT_LAYER).sort()).toEqual([...NODE_KINDS].sort());
  });

  test("статус по умолчанию допустим для своего kind", () => {
    for (const kind of NODE_KINDS) {
      expect(NODE_STATUSES[kind]).toContain(DEFAULT_STATUS[kind]);
    }
  });

  test("слои по умолчанию — из таблицы §2.3", () => {
    expect(DEFAULT_LAYER.message).toBe(0);
    expect(DEFAULT_LAYER.session).toBe(0);
    expect(DEFAULT_LAYER.task).toBe(1);
    expect(DEFAULT_LAYER.entity).toBe(2);
    expect(DEFAULT_LAYER.skill).toBe(3);
  });

  test("статус чужого kind отвергается с кодом graph.status", () => {
    expect(() => assertStatus("message", "closed")).toThrow(GraphError);
    try {
      assertStatus("message", "closed");
    } catch (error) {
      expect((error as GraphError).code).toBe("graph.status");
    }
    // message допускает ровно один статус — это не опечатка в §2.4
    expect(NODE_STATUSES.message).toEqual(["active"]);
    expect(assertStatus("message", "active")).toBe("active");
  });

  test("неизвестный kind отвергается", () => {
    expect(() => assertNodeKind("epic")).toThrow(/неизвестный kind/);
    expect(assertNodeKind("fragment")).toBe("fragment");
  });

  test("единая семантика «закрыто» совпадает с триггерами DDL", () => {
    expect([...CLOSED_STATUSES].sort()).toEqual([
      "cancelled",
      "closed",
      "retracted",
      "superseded",
    ]);
    expect(isClosedStatus("closed")).toBe(true);
    expect(isClosedStatus("in_progress")).toBe(false);
  });
});

describe("семантика рёбер (§4.1)", () => {
  test("одиннадцать типов, ровно те же, что в EDGE_KINDS", () => {
    expect(Object.keys(EDGE_SEMANTICS)).toHaveLength(11);
    expect(Object.keys(EDGE_SEMANTICS).sort()).toEqual([...EDGE_KINDS].sort());
    expect(EDGE_SEMANTICS.contradicts).toBeDefined();
  });

  test("каждый тип описан сам собой: type в записи совпадает с ключом", () => {
    for (const key of Object.keys(EDGE_SEMANTICS) as EdgeKind[]) {
      expect(EDGE_SEMANTICS[key].type).toBe(key);
      expect(edgeSemantics(key)).toBe(EDGE_SEMANTICS[key]);
    }
  });

  test("обратные имена — из колонки «Обратное (виртуальное)»", () => {
    const inverses: Record<EdgeKind, string> = {
      blocks: "blocked_by",
      parent: "children",
      relates: "relates",
      duplicates: "duplicated_by",
      supersedes: "superseded_by",
      replies_to: "replies",
      derived_from: "derives",
      mentions: "mentioned_by",
      touches: "touched_by",
      evidence: "evidence_for",
      contradicts: "contradicts",
    };
    for (const [type, inverse] of Object.entries(inverses)) {
      expect(EDGE_SEMANTICS[type as EdgeKind].inverse).toBe(inverse);
    }
  });

  test("симметричны ровно relates и contradicts", () => {
    const symmetric = (Object.keys(EDGE_SEMANTICS) as EdgeKind[]).filter(
      (t) => EDGE_SEMANTICS[t].symmetric,
    );
    expect(symmetric.sort()).toEqual(["contradicts", "relates"]);
    for (const t of symmetric) {
      expect(EDGE_SEMANTICS[t].inverse).toBe(t);
    }
  });

  test("никогда не транзитивны: relates, mentions, touches, evidence, contradicts", () => {
    const nonTransitive = (Object.keys(EDGE_SEMANTICS) as EdgeKind[]).filter(
      (t) => !EDGE_SEMANTICS[t].transitive,
    );
    expect(nonTransitive.sort()).toEqual([
      "contradicts",
      "evidence",
      "mentions",
      "relates",
      "touches",
    ]);
  });

  test("ацикличность проверяется у шести типов, глубины — из §4.1", () => {
    const acyclic = (Object.keys(EDGE_SEMANTICS) as EdgeKind[]).filter(
      (t) => EDGE_SEMANTICS[t].acyclic,
    );
    expect(acyclic.sort()).toEqual([
      "blocks",
      "derived_from",
      "duplicates",
      "parent",
      "replies_to",
      "supersedes",
    ]);
    expect(EDGE_SEMANTICS.blocks.maxDepth).toBe(64);
    expect(EDGE_SEMANTICS.parent.maxDepth).toBe(32);
    expect(EDGE_SEMANTICS.derived_from.maxDepth).toBe(8);
  });

  test("материализация закреплена за теми типами, что её требуют (§4.2)", () => {
    expect(EDGE_SEMANTICS.blocks.materializes).toBe("open_blockers");
    expect(EDGE_SEMANTICS.parent.materializes).toBe("parent_closure");
    expect(EDGE_SEMANTICS.supersedes.materializes).toBe("head_id");
    expect(EDGE_SEMANTICS.duplicates.materializes).toBe("path_compaction");
    expect(EDGE_SEMANTICS.replies_to.materializes).toBe("thread_root");
    expect(EDGE_SEMANTICS.derived_from.materializes).toBeNull();
    expect(EDGE_SEMANTICS.mentions.materializes).toBeNull();
  });

  test("расширяют выдачу на хоп только нетранзитивные ассоциативные типы", () => {
    const expanding = (Object.keys(EDGE_SEMANTICS) as EdgeKind[]).filter(
      (t) => EDGE_SEMANTICS[t].expandsRetrieval,
    );
    expect(expanding.sort()).toEqual([
      "contradicts",
      "evidence",
      "mentions",
      "relates",
      "touches",
    ]);
  });

  test("неизвестный тип и ребро в себя отвергаются", () => {
    expect(() => assertEdgeKind("blocked_by")).toThrow(/неизвестный тип ребра/);
    expect(assertEdgeKind("contradicts")).toBe("contradicts");
    expect(() => assertEdgeEndpoints("a", "a")).toThrow(GraphError);
    expect(() => assertEdgeEndpoints("a", "b")).not.toThrow();
  });
});

describe("excerpt (решение S5)", () => {
  test("пустое тело даёт пустую строку, а не 'null'", () => {
    expect(makeExcerpt(null)).toBe("");
    expect(makeExcerpt(undefined)).toBe("");
    expect(makeExcerpt("")).toBe("");
    expect(makeExcerpt("   \n\t ")).toBe("");
  });

  test("короткое тело нормализуется по пробелам и проходит целиком", () => {
    expect(makeExcerpt("  привет\n\n  мир  ")).toBe("привет мир");
  });

  test("длинное тело режется не длиннее 300 кодовых точек", () => {
    const body = "слово ".repeat(200);
    const excerpt = makeExcerpt(body);
    expect([...excerpt].length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(excerpt.endsWith("…")).toBe(true);
    // откат до границы слова, а не посреди
    expect(excerpt).not.toMatch(/сл…$/);
  });

  test("одно длинное слово не выедает весь excerpt", () => {
    const excerpt = makeExcerpt("a".repeat(500));
    expect([...excerpt].length).toBe(EXCERPT_MAX);
  });

  test("суррогатные пары не разрезаются пополам", () => {
    const excerpt = makeExcerpt("😀".repeat(500));
    expect([...excerpt].length).toBeLessThanOrEqual(EXCERPT_MAX);
    // если бы резали по code unit'ам, тут был бы одинокий суррогат
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test("детерминирован: два вызова на одном теле дают один результат", () => {
    const body = "текст ".repeat(100);
    expect(makeExcerpt(body)).toBe(makeExcerpt(body));
  });
});

describe("content_hash", () => {
  test("детерминирован и устойчив к разнице в пробелах", () => {
    const a = contentHash("note", "Заголовок", "тело  факта");
    const b = contentHash("note", " Заголовок ", "тело\n\nфакта");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("разный kind при том же тексте — разный хеш", () => {
    expect(contentHash("note", "t", "b")).not.toBe(contentHash("doc", "t", "b"));
  });

  test("пустое тело и отсутствующее тело неотличимы намеренно", () => {
    expect(contentHash("note", "t", null)).toBe(contentHash("note", "t", ""));
  });
});

describe("поля: горячие колонками, холодные в attrs", () => {
  test("в белый список не попали производные, метаданные и аренда", () => {
    const names = NODE_FIELDS.map((s) => s.field);
    for (const forbidden of [
      "excerpt",
      "content_hash",
      "created_at",
      "updated_at",
      "accessed_at",
      "hlc",
      "site_id",
      "seen_count",
      "open_blockers",
      "lease_holder",
      "lease_epoch",
      "lease_expires",
      "attrs",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain("title");
    expect(names).toContain("body");
    expect(names).toContain("deleted_at");
  });

  test("attrs адресуются поключево", () => {
    expect(attrField("topic")).toBe("attrs.topic");
    expect(isAttrField("attrs.topic")).toBe(true);
    expect(isAttrField("title")).toBe(false);
    expect(attrKeyOf("attrs.frag_type")).toBe("frag_type");
    expect(attrKeyOf("title")).toBeUndefined();
  });

  test("ключ attrs с точкой или скобкой отвергается — путь json_set обязан быть однозначен", () => {
    expect(() => attrField("a.b")).toThrow(/attrs/);
    expect(() => attrField("a[0]")).toThrow(GraphError);
    expect(() => attrField("$.x")).toThrow(GraphError);
    expect(ATTR_KEY_RE.test("session_id")).toBe(true);
  });

  test("тип значения сверяется с типом колонки", () => {
    const title = nodeFieldSpec("title")!;
    expect(coerceNodeFieldValue(title, "ok")).toBe("ok");
    expect(() => coerceNodeFieldValue(title, 1)).toThrow(/ожидает строку/);
    expect(() => coerceNodeFieldValue(title, null)).toThrow(/не допускает NULL/);

    const body = nodeFieldSpec("body")!;
    expect(coerceNodeFieldValue(body, null)).toBeNull();

    const layer = nodeFieldSpec("layer")!;
    expect(() => coerceNodeFieldValue(layer, 1.5)).toThrow(/ожидает целое/);
  });

  test("неизвестное поле не пролезает в оплог", () => {
    expect(() => assertNodeField("open_blockers")).toThrow(
      /не реплицируется/,
    );
    expect(assertNodeField("attrs.tags")).toBe("attr");
    expect(assertNodeField("status")).toMatchObject({ field: "status" });
  });

  test("диапазоны layer, priority, confidence, acl", () => {
    expect(() => nodeInputFields({ kind: "task", layer: 7 as never })).toThrow(
      /вне диапазона/,
    );
    expect(() => nodeInputFields({ kind: "task", priority: 9 })).toThrow(
      /вне диапазона/,
    );
    expect(() => nodeInputFields({ kind: "note", confidence: 1.5 })).toThrow(
      /вне диапазона/,
    );
    expect(() => nodeInputFields({ kind: "note", acl: "world" })).toThrow(
      /недопустим/,
    );
    expect(ACL_MODES).toContain("restricted");
  });
});

describe("разложение входа на поля", () => {
  test("умолчания по kind подставляются, attrs разъезжаются по ключам", () => {
    const fields = new Map(
      nodeInputFields({
        kind: "note",
        title: "факт",
        attrs: { topic: "db", tags: ["a", "b"] },
      }),
    );
    expect(fields.get("kind")).toBe("note");
    expect(fields.get("layer")).toBe(1);
    expect(fields.get("status")).toBe("active");
    expect(fields.get("scope")).toBe("");
    expect(fields.get("attrs.topic")).toBe("db");
    expect(fields.get("attrs.tags")).toEqual(["a", "b"]);
    // body не задан — операции на него нет, а не set(null)
    expect(fields.has("body")).toBe(false);
  });

  test("body=null пишется явно: это отличается от «не трогать»", () => {
    const fields = new Map(nodeInputFields({ kind: "note", body: null }));
    expect(fields.get("body")).toBeNull();
  });

  test("kind в патче игнорируется — он неизменяем (§2.2)", () => {
    const fields = nodePatchFields("note", {
      title: "новый",
      kind: "task",
    } as never);
    expect(fields.map(([f]) => f)).toEqual(["title"]);
  });

  test("патч валидирует статус по kind узла, а не по kind из патча", () => {
    expect(() => nodePatchFields("message", { status: "closed" })).toThrow(
      /недопустим для kind 'message'/,
    );
    expect(() => nodePatchFields("task", { status: "closed" })).not.toThrow();
  });
});

describe("OpFactory", () => {
  const clock = (): HlcClock => new HlcClock({ now: (() => {
    let t = 1_700_000_000_000;
    return () => (t += 1);
  })() });

  test("seq продолжается с переданного lastSeq, op_id детерминирован", () => {
    const f = new OpFactory("siteA", { clock: clock(), lastSeq: 41 });
    const op = f.set("n1", "title", "x");
    expect(op.seq).toBe(42);
    expect(op.op_id).toBe("siteA:42");
    expect(f.lastSeq).toBe(42);
  });

  test("операции совпадают по форме с Site: merge принимает их без оговорок", () => {
    const f = new OpFactory("siteA", { clock: clock() });
    const ops = [
      f.set("n1", "title", "первый"),
      f.set("n1", "status", "active"),
      f.inc("n1", "seen_count", 3),
      f.edgeAdd("n1", "relates", "n2", 0.7),
    ];
    const state = merge(emptyState(), ops);
    expect(readField(state, "n1", "title")?.value).toBe("первый");
    expect(readCounter(state, "n1", "seen_count")).toBe(3);
    expect(isEdgeAlive(state, edgeKey("n1", "relates", "n2"))).toBe(true);
  });

  test("edgeDel уносит ровно те теги, что ему передали — add-wins", () => {
    const f = new OpFactory("siteA", { clock: clock() });
    const add1 = f.edgeAdd("n1", "blocks", "n2");
    const key = edgeKey("n1", "blocks", "n2");
    let state = merge(emptyState(), [add1]);
    expect(liveTags(state, key)).toEqual([add1.value.tag]);

    // Второй сайт добавил своё, мы о нём не знали и удалили только своё.
    const other = new OpFactory("siteB", { clock: clock() });
    const add2 = other.edgeAdd("n1", "blocks", "n2");
    const del = f.edgeDel("n1", "blocks", "n2", [add1.value.tag]);
    state = merge(state, [add2, del]);
    expect(isEdgeAlive(state, key)).toBe(true);
    expect(liveTags(state, key)).toEqual([add2.value.tag]);
  });

  test("G-counter принимает накопленное значение, а не дельту", () => {
    const f = new OpFactory("siteA", { clock: clock() });
    expect(f.inc("n1", "seen_count", 5).value).toBe(5);
    expect(() => f.inc("n1", "seen_count", -1)).toThrow(/неотрицательным/);
    expect(() => f.inc("n1", "seen_count", 1.5)).toThrow(GraphError);
  });

  test("повторная чеканка не выдаёт тот же op_id", () => {
    const f = new OpFactory("siteA", { clock: clock() });
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(f.set("n1", "title", String(i)).op_id);
    expect(ids.size).toBe(100);
  });

  test("вес ребра не попадает в операцию, если его не задали", () => {
    const f = new OpFactory("siteA", { clock: clock() });
    expect(f.edgeAdd("n1", "mentions", "n2").value).not.toHaveProperty("weight");
    expect(f.edgeAdd("n1", "mentions", "n3", 0.5).value).toMatchObject({
      weight: 0.5,
    });
  });
});

describe("все девять kind проходят разложение", () => {
  test.each(NODE_KINDS as NodeKind[])("kind %s", (kind) => {
    const fields = new Map(nodeInputFields({ kind, title: `узел ${kind}` }));
    expect(fields.get("kind")).toBe(kind);
    expect(NODE_STATUSES[kind]).toContain(String(fields.get("status")));
    expect(fields.get("layer")).toBe(DEFAULT_LAYER[kind]);
  });
});
