/**
 * Приёмка W8 (memory-cx00fqk28pgv): экран решений — supersession-цепочки и
 * открытые противоречия.
 *
 * Наполнение прямым INSERT в nodes/edges (как в harness.ts seedGraph), а не
 * через absorb: absorb классифицирует по эмбеддингам/лексике, и воспроизвести
 * его вердикт детерминированно в юнит-тесте значило бы тестировать absorb, а
 * не экран. supersedes/head_id/contradicts здесь расставлены руками ровно
 * так, как их расставляет `applyVerdict` (absorb.ts) — те же поля, тот же
 * инвариант «head_id указывает на голову цепочки».
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openReadOnly, type ReadOnlyDb } from "./db.ts";
import { buildDecisions } from "./decisions.ts";
import { startVizServer, type VizServer } from "./server.ts";
import { makeWorkspace, type Workspace } from "./harness.ts";
import type { DecisionsPayload } from "./types.ts";

const cleanups: Array<() => void> = [];
const servers: VizServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const c of cleanups.splice(0)) c();
});

let seq = 0;

interface NodeSeed {
  id: string;
  title: string;
  status?: string;
  headId?: string | null;
  createdAt?: number;
  attrs?: Record<string, unknown>;
  actor?: string;
  kind?: string;
}

function insNode(db: Database, s: NodeSeed): void {
  db.query(
    `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, open_blockers,
                         head_id, content_hash, created_at, updated_at, actor, hlc, site_id, attrs)
     VALUES (?1, ?2, 1, '', ?3, ?4, 2, 0, ?5, ?6, ?7, ?7, ?8, ?9, 'site-a', ?10)`,
  ).run(
    s.id,
    s.kind ?? "note",
    s.title,
    s.status ?? "active",
    s.headId ?? null,
    `h${seq++}`,
    s.createdAt ?? Date.now(),
    s.actor ?? "tester",
    seq,
    JSON.stringify({ type: "decision", ...s.attrs }),
  );
}

function insEdge(db: Database, src: string, type: string, dst: string): void {
  db.query(
    `INSERT INTO edges (src, type, dst, add_tag, actor, created_at)
     VALUES (?1, ?2, ?3, ?4, 'tester', ?5)`,
  ).run(src, type, dst, `tag-${seq++}`, Date.now());
}

async function ws(): Promise<{ w: Workspace; ro: ReadOnlyDb }> {
  const w = await makeWorkspace();
  cleanups.push(() => w.cleanup());
  const ro = openReadOnly(w.dbPath);
  cleanups.push(() => ro.close());
  return { w, ro };
}

describe("экран решений", () => {
  test("пустая база не роняет экран", async () => {
    const { ro } = await ws();
    const d = buildDecisions(ro);
    expect(d.chains).toEqual([]);
    expect(d.contradictions).toEqual([]);
    expect(d.total_decisions).toBe(0);
  });

  test("supersession-цепочка: голова помечена current, остальные — нет", async () => {
    const { w, ro } = await ws();
    // A superseded первой версией, затем B superseded C — как applyVerdict
    // класса update: node.id supersedes old.id, старая (и вся её цепочка)
    // получает head_id новой головы.
    insNode(w.db, { id: "dec-a", title: "Решение A", status: "superseded", headId: "dec-c", createdAt: 1000 });
    insNode(w.db, {
      id: "dec-b",
      title: "Решение B",
      status: "superseded",
      headId: "dec-c",
      createdAt: 2000,
      attrs: { absorb: { class: "update", target: "dec-a", reason: "A устарело: dec-b уточняет порог" } },
    });
    insNode(w.db, {
      id: "dec-c",
      title: "Решение C",
      status: "active",
      headId: null,
      createdAt: 3000,
      attrs: { absorb: { class: "update", target: "dec-b", reason: "B неверно посчитал бюджет" } },
    });
    insEdge(w.db, "dec-b", "supersedes", "dec-a");
    insEdge(w.db, "dec-c", "supersedes", "dec-b");

    const d = buildDecisions(ro);
    expect(d.chains.length).toBe(1);
    const chain = d.chains[0]!;
    expect(chain.head).toBe("dec-c");
    expect(chain.links.map((l) => l.id)).toEqual(["dec-a", "dec-b", "dec-c"]);
    for (const l of chain.links) {
      expect(l.current).toBe(l.id === "dec-c");
    }
    const c = chain.links.find((l) => l.id === "dec-c")!;
    expect(c.reason).toBe("B неверно посчитал бюджет");
    expect(c.author).toBe("tester");
  });

  test("узел без своей версии — тривиальная цепочка из одного звена, current", async () => {
    const { w, ro } = await ws();
    insNode(w.db, { id: "dec-solo", title: "Решение соло", status: "active" });
    const d = buildDecisions(ro);
    expect(d.chains.length).toBe(1);
    expect(d.chains[0]!.links).toEqual([
      expect.objectContaining({ id: "dec-solo", current: true }),
    ]);
  });

  test("ЖИВЬЁМ ПОДТВЕРЖДЕНО: решение kind='task' (не только 'note') тоже попадает на экран", async () => {
    // На настоящей базе проекта (myc-cx00fqk28pgv) все три существующих
    // решения оказались kind='task' с attrs.type='decision', а не kind='note'
    // из задокументированного alias (list.ts). Фильтр по kind='note' молча
    // выкинул бы их все — этот тест держит фикс, а не только документирует его.
    const { w, ro } = await ws();
    insNode(w.db, { id: "dec-task", title: "РЕШЕНИЕ: контрольная группа", status: "open", kind: "task" });
    const d = buildDecisions(ro);
    expect(d.total_decisions).toBe(1);
    expect(d.chains[0]!.links[0]!.id).toBe("dec-task");
  });

  test("открытое противоречие видно с обеих сторон", async () => {
    const { w, ro } = await ws();
    insNode(w.db, { id: "dec-x", title: "Бюджет 500мс", status: "active", createdAt: 1000 });
    insNode(w.db, {
      id: "dec-y",
      title: "Бюджет 800мс",
      status: "active",
      createdAt: 2000,
      attrs: { absorb: { class: "contradiction", target: "dec-x", reason: "числа разошлись без маркера обновления" } },
    });
    insEdge(w.db, "dec-y", "contradicts", "dec-x");

    const d = buildDecisions(ro);
    expect(d.contradictions.length).toBe(1);
    const c = d.contradictions[0]!;
    const ids = [c.a.id, c.b.id].sort();
    expect(ids).toEqual(["dec-x", "dec-y"]);
    expect(c.reason).toBe("числа разошлись без маркера обновления");
  });

  test("противоречие, закрытое обычным путём (status cancelled), выходит из открытых", async () => {
    const { w, ro } = await ws();
    insNode(w.db, { id: "dec-p", title: "P", status: "active", createdAt: 1000 });
    insNode(w.db, { id: "dec-q", title: "Q", status: "cancelled", createdAt: 2000 });
    insEdge(w.db, "dec-q", "contradicts", "dec-p");

    const d = buildDecisions(ro);
    expect(d.contradictions).toEqual([]);
    // но обе стороны по-прежнему видны как решения — противоречие не стёрто,
    // просто не в списке ОТКРЫТЫХ (аудиторский след остаётся в статусе узла).
    const ids = d.chains.flatMap((c) => c.links.map((l) => l.id));
    expect(ids).toContain("dec-p");
    expect(ids).toContain("dec-q");
  });

  test("МУТАЦИЯ: устаревшее решение не должно быть показано как действующее", async () => {
    const { w, ro } = await ws();
    insNode(w.db, { id: "dec-old", title: "Старое", status: "superseded", headId: "dec-new", createdAt: 1000 });
    insNode(w.db, { id: "dec-new", title: "Новое", status: "active", headId: null, createdAt: 2000 });
    insEdge(w.db, "dec-new", "supersedes", "dec-old");

    const d = buildDecisions(ro);
    const chain = d.chains.find((c) => c.links.some((l) => l.id === "dec-old"))!;
    const old = chain.links.find((l) => l.id === "dec-old")!;
    const fresh = chain.links.find((l) => l.id === "dec-new")!;
    // Инвариант, который эта задача обязана держать: у устаревшего звена
    // current === false, у головы — true. Ломается ровно тем багом, который
    // приёмка называет по имени: «устаревшее решение показано как действующее».
    expect(old.current).toBe(false);
    expect(fresh.current).toBe(true);
    expect(chain.head).toBe("dec-new");
  });

  test("GET /api/decisions отдаёт то же, что buildDecisions напрямую", async () => {
    const { w, ro } = await ws();
    insNode(w.db, { id: "dec-a", title: "A", status: "superseded", headId: "dec-b", createdAt: 1000 });
    insNode(w.db, { id: "dec-b", title: "B", status: "active", createdAt: 2000 });
    insEdge(w.db, "dec-b", "supersedes", "dec-a");

    const server = startVizServer({ dbPath: w.dbPath, dir: w.dir, port: 0, readOnly: true });
    servers.push(server);
    const res = await fetch(`${server.url}api/decisions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DecisionsPayload;
    const expected = buildDecisions(ro);
    expect(body.chains).toEqual(expected.chains as unknown as DecisionsPayload["chains"]);
    expect(body.total_decisions).toBe(2);
  });
});
