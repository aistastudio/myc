import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LAYER,
  DEFAULT_STATUS,
  GraphError,
  assertStatus,
  contentHash,
  type NodeInput,
} from "./graph.ts";
import { generateId } from "./id.ts";
import {
  FRAGMENT_TYPES,
  PARSED_BY,
  docInput,
  entityInput,
  entityKey,
  fragmentInput,
  messageInput,
  noteInput,
  parseFragments,
  sessionInput,
  type FragmentDraft,
} from "./memory.ts";

// ---------------------------------------------------------------------------
// Мини-харнесс поверх настоящей схемы (db/schema.sqlite.sql). core не может
// зависеть от пакета store-sqlite (scripts/deps-check.ts) — GraphStore со всем
// оплогом и CRDT-применением уже покрыт своими тестами в store-sqlite.
// Здесь проверяется только то, что напрямую касается этой задачи: что
// NodeInput из memory.ts ложится в реальные колонки/generated-columns/индексы
// схемы так, как описано в §2.3/§2.4/§4.1 — одним `db.exec` всего DDL-файла
// и голыми INSERT в обязательные колонки (остальные берут DEFAULT схемы).
// ---------------------------------------------------------------------------

function openSchema(): Database {
  const sqlPath = join(import.meta.dir, "../../../db/schema.sqlite.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const db = new Database(":memory:");
  db.exec(sql);
  return db;
}

function insertNode(db: Database, input: NodeInput, now: number): string {
  const id = input.id ?? generateId();
  const status = input.status ?? DEFAULT_STATUS[input.kind];
  assertStatus(input.kind, status);
  const layer = input.layer ?? DEFAULT_LAYER[input.kind];
  const title = input.title ?? "";
  const body = input.body ?? null;
  const attrs = JSON.stringify(input.attrs ?? {});
  const hash = contentHash(input.kind, title, body);
  db.run(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, status, content_hash, attrs, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.kind, layer, input.scope ?? "", title, body, status, hash, attrs, now, now],
  );
  return id;
}

// ---------------------------------------------------------------------------
// note
// ---------------------------------------------------------------------------

describe("noteInput", () => {
  test("кладёт tags/source/topic в attrs, topic читается generated-колонкой", () => {
    const db = openSchema();
    const id = insertNode(
      db,
      noteInput({ title: "факт", body: "тело", tags: ["a", "b"], source: "agent", topic: "sqlite" }),
      1,
    );
    const row = db
      .query("SELECT g_topic, attrs FROM nodes WHERE id = ?1")
      .get(id) as { g_topic: string; attrs: string };
    expect(row.g_topic).toBe("sqlite");
    expect(JSON.parse(row.attrs)).toEqual({ tags: ["a", "b"], source: "agent", topic: "sqlite" });
  });
});

// ---------------------------------------------------------------------------
// doc + fragment: разбор на claims/plan_items/references/risks (§2.3)
// ---------------------------------------------------------------------------

const SAMPLE_DOC = `# Обзор

Вводный текст без секции.

## Claims

- SQLite generated columns не занимают места на диске
- attrs — единственный источник per-kind полей

## Plan

- Написать memory.ts
- Написать memory.test.ts
- Прогнать bun test

## References

- docs/design/01-core-data-model.md §2.3
- docs/design/01-core-data-model.md §2.4

## Risks

- Схема разъедется с graph.ts, если типы полей разойдутся
- Парсер фрагментов даст ложную классификацию на нестандартных заголовках

## Заметки

Секция без ключевого слова — остаётся одним фрагментом section.
`;

describe("parseFragments", () => {
  test("классифицирует секции по ключевым словам заголовка", () => {
    const drafts = parseFragments(SAMPLE_DOC);
    const byType = new Map<string, FragmentDraft[]>();
    for (const d of drafts) {
      byType.set(d.frag_type, [...(byType.get(d.frag_type) ?? []), d]);
    }
    expect(byType.get("claim")?.length).toBe(2);
    expect(byType.get("plan_item")?.length).toBe(3);
    expect(byType.get("reference")?.length).toBe(2);
    expect(byType.get("risk")?.length).toBe(2);
    expect(byType.get("section")?.length).toBe(2); // вводный текст + "Заметки"
    for (const t of FRAGMENT_TYPES) expect(byType.has(t) || t === "section").toBeTruthy();
  });

  test("char_start/char_end — реальные срезы исходного body", () => {
    const drafts = parseFragments(SAMPLE_DOC);
    for (const d of drafts) {
      expect(SAMPLE_DOC.slice(d.char_start, d.char_end)).toBe(d.body);
    }
  });

  test("пустой документ и документ без заголовков не падают", () => {
    expect(parseFragments("")).toEqual([]);
    expect(parseFragments("просто текст без заголовков")).toHaveLength(1);
  });
});

describe("doc + fragment под реальной схемой", () => {
  test("документ на ~50 КБ разбирается на фрагменты за разумное время", () => {
    const block = SAMPLE_DOC;
    const repeats = Math.ceil(50_000 / block.length);
    const big = Array.from({ length: repeats }, (_, i) => `${block}\n<!-- блок ${i} -->\n`).join("\n");
    expect(big.length).toBeGreaterThanOrEqual(50_000);

    const t0 = performance.now();
    const drafts = parseFragments(big);
    const ms = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(
      `[myc-vsg] parseFragments: ${big.length} байт → ${drafts.length} фрагментов за ${ms.toFixed(2)} мс`,
    );
    expect(drafts.length).toBeGreaterThan(repeats * 5);
    // И1 запрещает дорогие пересчёты в горячем пути (myc-i1-speed); разбор —
    // синхронный regex-проход, порядок мс на 50 КБ — щедрый запас на CI.
    expect(ms).toBeLessThan(500);
  });

  test("doc + фрагменты создаются, читаются, n_fragments совпадает с count", () => {
    const db = openSchema();
    const now = 1;
    const drafts = parseFragments(SAMPLE_DOC);
    const docId = insertNode(db, docInput({ title: "спека", body: SAMPLE_DOC, uri: "file:///spec.md" }, drafts.length), now);

    for (const d of drafts) {
      const fragId = insertNode(db, fragmentInput({ id: docId, scope: "" }, d), now);
      db.run(
        `INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES (?, 'parent', ?, 'test', ?)`,
        [fragId, docId, now],
      );
    }

    const docRow = db.query("SELECT attrs FROM nodes WHERE id = ?1").get(docId) as { attrs: string };
    const docAttrs = JSON.parse(docRow.attrs) as { n_fragments: number; parsed_by: string };
    expect(docAttrs.n_fragments).toBe(drafts.length);
    expect(docAttrs.parsed_by).toBe(PARSED_BY);

    const fragCount = db
      .query("SELECT count(*) AS n FROM nodes JOIN edges ON edges.src = nodes.id WHERE edges.type='parent' AND edges.dst = ?1 AND nodes.kind='fragment'")
      .get(docId) as { n: number };
    expect(fragCount.n).toBe(drafts.length);

    const claimRow = db
      .query("SELECT count(*) AS n FROM nodes WHERE kind='fragment' AND g_frag_type='claim'")
      .get() as { n: number };
    expect(claimRow.n).toBe(2);
  });

  test("фрагмент не участвует в дедупликации наравне с note: тот же текст, разный kind", () => {
    const db = openSchema();
    const text = "SQLite generated columns не занимают места на диске";
    insertNode(db, noteInput({ title: "заметка", body: text }), 1);
    // Тот же текст как фрагмент — не конфликтует по ux_nodes_content(scope,kind,content_hash),
    // потому что kind разный ('note' vs 'fragment'); insert не должен упасть.
    expect(() =>
      insertNode(
        db,
        fragmentInput({ id: "myc-doc00000001", scope: "" }, {
          frag_type: "claim",
          ord: 0,
          char_start: 0,
          char_end: text.length,
          title: text,
          body: text,
        }),
        1,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// session / message: тред одним индекс-сканом (§4.1)
// ---------------------------------------------------------------------------

describe("session + message thread", () => {
  test("корневое сообщение — само себе thread_root", () => {
    const draft = messageInput({ id: "myc-sess0000001" }, { role: "user", ord: 0, body: "привет" });
    expect(draft.threadRoot).toBe(draft.id);
    expect(draft.input.attrs?.thread_root).toBe(draft.id);
  });

  test("ответ наследует thread_root родителя, а не id родителя", () => {
    const root = messageInput({ id: "myc-sess0000001" }, { role: "user", ord: 0 });
    const reply1 = messageInput(
      { id: "myc-sess0000001" },
      { role: "assistant", ord: 1, replyTo: { id: root.id, thread_root: root.threadRoot } },
    );
    const reply2 = messageInput(
      { id: "myc-sess0000001" },
      { role: "user", ord: 2, replyTo: { id: reply1.id, thread_root: reply1.threadRoot } },
    );
    expect(reply1.threadRoot).toBe(root.threadRoot);
    expect(reply2.threadRoot).toBe(root.threadRoot);
  });

  test("тред из 200 сообщений читается одним сканом ix_nodes_thread", () => {
    const db = openSchema();
    const session = sessionInput({ id: "myc-sessabcdef1", agent: "claude", model: "sonnet-5" });
    insertNode(db, session, 1);

    let prev: { id: string; threadRoot: string } | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const draft = messageInput(
        { id: "myc-sessabcdef1" },
        {
          role: i === 0 ? "user" : "assistant",
          ord: i,
          body: `сообщение ${i}`,
          replyTo: prev !== undefined ? { id: prev.id, thread_root: prev.threadRoot } : undefined,
        },
      );
      insertNode(db, draft.input, 100 + i);
      ids.push(draft.id);
      prev = { id: draft.id, threadRoot: draft.threadRoot };
    }

    const rootThread = prev!.threadRoot;
    const rows = db
      .query("SELECT id FROM nodes WHERE kind='message' AND g_thread_root = ?1 ORDER BY created_at")
      .all(rootThread) as Array<{ id: string }>;
    expect(rows).toHaveLength(200);
    expect(rows[0]!.id).toBe(ids[0]!);
    expect(rows[199]!.id).toBe(ids[199]!);

    const plan = db
      .query("EXPLAIN QUERY PLAN SELECT id FROM nodes WHERE kind='message' AND g_thread_root = ?1 ORDER BY created_at")
      .all(rootThread) as Array<{ detail: string }>;
    const planText = plan.map((p) => p.detail).join(" | ");
    // eslint-disable-next-line no-console
    console.log(`[myc-vsg] EXPLAIN QUERY PLAN (тред 200 сообщений): ${planText}`);
    expect(planText).toContain("ix_nodes_thread");
    expect(planText).not.toMatch(/SCAN nodes\b(?!.*USING)/u);
  });
});

// ---------------------------------------------------------------------------
// entity: вход в граф по имени (§4.1 mentions)
// ---------------------------------------------------------------------------

describe("entity", () => {
  test("entityKey нормализует регистр и пробелы для поиска по имени", () => {
    expect(entityKey("Bun")).toBe("bun");
    expect(entityKey("  Bun  ")).toBe("bun");
    expect(entityKey("Claude   Code")).toBe("claude code");
  });

  test("entity создаётся и находится по g_etype", () => {
    const db = openSchema();
    insertNode(db, entityInput({ name: "Bun", etype: "lib" }), 1);
    insertNode(db, entityInput({ name: "Egor", etype: "person" }), 1);
    const libs = db
      .query("SELECT title FROM nodes WHERE kind='entity' AND g_etype='lib'")
      .all() as Array<{ title: string }>;
    expect(libs.map((r) => r.title)).toEqual(["Bun"]);
  });

  test("mentions ставится извлекателем сущностей — здесь только узел и ребро вручную", () => {
    const db = openSchema();
    const entityId = insertNode(db, entityInput({ name: "SQLite", etype: "lib" }), 1);
    const noteId = insertNode(db, noteInput({ title: "заметка про SQLite", body: "..." }), 1);
    db.run(`INSERT INTO edges (src, type, dst, add_tag, created_at) VALUES (?, 'mentions', ?, 'test', 1)`, [
      noteId,
      entityId,
    ]);
    const mentioned = db
      .query("SELECT dst FROM edges WHERE src = ?1 AND type = 'mentions'")
      .all(noteId) as Array<{ dst: string }>;
    expect(mentioned).toEqual([{ dst: entityId }]);
  });
});

// ---------------------------------------------------------------------------
// Кросс-kind: все шесть видов одним запросом (причина, по которой таблица одна)
// ---------------------------------------------------------------------------

describe("кросс-kind чтение и поиск", () => {
  test("все шесть kind создаются и читаются одним запросом по scope", () => {
    const db = openSchema();
    const scope = "proj";
    const now = 1;

    insertNode(db, noteInput({ scope, title: "заметка" }), now);
    const docId = insertNode(db, docInput({ scope, title: "документ", body: "# H\n\ntext" }, 0), now);
    insertNode(
      db,
      fragmentInput({ id: docId, scope }, {
        frag_type: "section",
        ord: 0,
        char_start: 0,
        char_end: 4,
        title: "H",
        body: "H",
      }),
      now,
    );
    insertNode(db, sessionInput({ scope, agent: "claude" }), now);
    insertNode(db, messageInput({ id: "myc-sess0000002", scope }, { role: "user", ord: 0 }).input, now);
    insertNode(db, entityInput({ scope, name: "term", etype: "term" }), now);

    const rows = db
      .query("SELECT DISTINCT kind FROM nodes WHERE scope = ?1 AND deleted_at IS NULL ORDER BY kind")
      .all(scope) as Array<{ kind: string }>;
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(["doc", "entity", "fragment", "message", "note", "session"]);

    // Поиск: тот же кросс-kind скан с фильтром по title/attrs, без UNION по таблицам.
    const found = db
      .query(
        "SELECT kind, title FROM nodes WHERE scope = ?1 AND deleted_at IS NULL AND (title LIKE ?2 OR body LIKE ?2) ORDER BY kind",
      )
      .all(scope, "%документ%") as Array<{ kind: string; title: string }>;
    expect(found.map((r) => r.kind)).toEqual(["doc"]);
  });
});

// ---------------------------------------------------------------------------
// Статусы по kind (§2.4): недопустимый переход отвергается, не проходит молча
// ---------------------------------------------------------------------------

describe("статусы по kind", () => {
  test("допустимые статусы совпадают с §2.4 для всех шести видов задачи", () => {
    expect(DEFAULT_STATUS.note).toBe("active");
    expect(DEFAULT_STATUS.doc).toBe("active");
    expect(DEFAULT_STATUS.fragment).toBe("active");
    expect(DEFAULT_STATUS.session).toBe("open");
    expect(DEFAULT_STATUS.message).toBe("active");
    expect(DEFAULT_STATUS.entity).toBe("active");
  });

  test("недопустимый статус для kind отвергается с внятной ошибкой, не проходит молча", () => {
    expect(() => assertStatus("message", "closed")).toThrow(GraphError);
    try {
      assertStatus("fragment", "in_progress");
      throw new Error("должно было бросить");
    } catch (e) {
      expect(e).toBeInstanceOf(GraphError);
      expect((e as GraphError).code).toBe("graph.status");
      expect((e as GraphError).message).toContain("in_progress");
      expect((e as GraphError).message).toContain("fragment");
    }
  });

  test("допустимые переходы session: open→closed и обратно проходят", () => {
    expect(assertStatus("session", "open")).toBe("open");
    expect(assertStatus("session", "closed")).toBe("closed");
  });

  test("insertNode отвергает создание узла с недопустимым статусом (не проходит молча в БД)", () => {
    const db = openSchema();
    expect(() => insertNode(db, { kind: "message", status: "closed" }, 1)).toThrow(GraphError);
    const rows = db.query("SELECT count(*) AS n FROM nodes").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
