/**
 * Тесты просмотрщика. Проверяется ровно то, что записано в приёмке задачи:
 * read-only не мешает записи, четыре экрана дают осмысленные числа, пустая
 * база не роняет ни один из них, ассеты вшиты и не тянут ничего снаружи.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Attribution, ensureSwarmSchema, Roster, type Caveat } from "@myc/swarm";
import { assetBytes, assetPaths, getAsset } from "./assets.ts";
import { openReadOnly, VizDbError } from "./db.ts";
import { buildGraph } from "./graph.ts";
import { buildHealth } from "./health.ts";
import { buildReady, anchorNorm, freshnessNorm, scoreRow, typeNorm } from "./ready.ts";
import { buildRouting } from "./routing.ts";
import { buildTimeline } from "./timeline.ts";
import { startVizServer, type VizServer } from "./server.ts";
import { DEFAULT_READY_WEIGHTS, parseWorkspaceToml } from "./workspace.ts";
import { makeWorkspace, seedGraph, seedOplog, type Workspace } from "./harness.ts";

const cleanups: Array<() => void> = [];
const servers: VizServer[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const c of cleanups.splice(0)) c();
});

async function ws(toml?: string): Promise<Workspace> {
  const w = await makeWorkspace(toml);
  cleanups.push(() => w.cleanup());
  return w;
}

function serve(w: Workspace, nodeLimit?: number): VizServer {
  const s = startVizServer({
    dbPath: w.dbPath,
    dir: w.dir,
    port: 0,
    ...(nodeLimit !== undefined ? { nodeLimit } : {}),
  });
  servers.push(s);
  return s;
}

// ---------------------------------------------------------------------------

describe("read-only", () => {
  test("соединение отвергает запись и не мешает писать другому", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 40 });
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    expect(ro.one<{ n: number }>("SELECT count(*) AS n FROM nodes")?.n).toBe(40);
    expect(() =>
      ro.all("INSERT INTO myc_meta (key, value) VALUES ('x','y')"),
    ).toThrow();

    // Пишущее соединение работает, пока читающее открыто, и читающее видит
    // свежие данные без переоткрытия — это и есть требование «viz не мешает».
    seedGraph(w.db, { nodes: 10, kinds: ["note"], prefix: "m" });
    expect(ro.one<{ n: number }>("SELECT count(*) AS n FROM nodes")?.n).toBe(50);
  });

  test("несуществующая база — понятная ошибка, а не падение", () => {
    expect(() => openReadOnly("/nope/definitely/missing.db")).toThrow(VizDbError);
  });

  test("читающие ручки не пишут, а неизвестные методы не обслуживаются", async () => {
    const w = await ws();
    const s = serve(w);
    // мутирующие маршруты появились (см. write.test.ts), но только свои:
    // POST в читающую ручку — не «метод не тот», а «такого маршрута нет»
    expect((await fetch(`${s.url}api/graph`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${s.url}api/graph`, { method: "DELETE" })).status).toBe(405);
    // соединение самого просмотрщика по-прежнему только на чтение
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());
    expect(() => ro.all("INSERT INTO myc_meta (key, value) VALUES ('x','y')")).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("граф", () => {
  test("узлы, рёбра и индексы рёбер согласованы", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 200, edgesPerNode: 3 });
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const g = buildGraph(ro);
    expect(g.nodes.length).toBe(200);
    expect(g.total_nodes).toBe(200);
    expect(g.edges.length).toBeGreaterThan(300);
    expect(g.truncated).toBe(false);
    for (const e of g.edges) {
      expect(g.nodes[e.s]).toBeDefined();
      expect(g.nodes[e.d]).toBeDefined();
    }
    // Степень посчитана, а не оставлена нулём — по ней идёт отбор при усечении.
    expect(g.nodes.some((n) => n.deg > 0)).toBe(true);
  });

  test("сверх лимита отдаётся top-N по степени и флаг усечения", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 300, edgesPerNode: 2 });
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const g = buildGraph(ro, { nodeLimit: 50 });
    expect(g.nodes.length).toBe(50);
    expect(g.truncated).toBe(true);
    expect(g.total_nodes).toBe(300);
    const degs = g.nodes.map((n) => n.deg);
    expect(degs).toEqual([...degs].sort((a, b) => b - a));
  });

  test("удалённые узлы и их рёбра не показываются", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 20, edgesPerNode: 2 });
    w.db.exec("UPDATE nodes SET deleted_at = 1 WHERE id = 'n-0'");
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const g = buildGraph(ro);
    expect(g.nodes.find((n) => n.id === "n-0")).toBeUndefined();
    expect(g.total_nodes).toBe(19);
  });
});

// ---------------------------------------------------------------------------

describe("очередь ready", () => {
  test("score равен сумме напечатанных слагаемых, веса — S21", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 60 });
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildReady(ro, { scope: "", weights: DEFAULT_READY_WEIGHTS });
    expect(r.weights).toEqual(DEFAULT_READY_WEIGHTS);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.terms.length).toBe(5);
      const sum = row.terms.reduce((s, t) => s + t.value, 0);
      // Слагаемые округлены до сотых ДО суммы — приёмка --why в CLI.
      expect(Math.abs(sum - row.score)).toBeLessThan(1e-9);
      for (const t of row.terms) {
        expect(Math.abs(t.value - Math.round(t.weight * t.norm * 100) / 100)).toBeLessThan(1e-9);
      }
    }
    // Порядок — по убыванию score.
    const scores = r.rows.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("эталонные числа S21: P0 bug, свежий, разблокирует 3, без якорей", () => {
    const now = 1_700_000_000_000;
    const row = scoreRow(
      {
        id: "t-1",
        priority: 0,
        status: "open",
        assignee: "",
        title: "срочно",
        updated_at: now - 1000,
        attrs: JSON.stringify({ type: "bug" }),
      },
      3,
      undefined,
      DEFAULT_READY_WEIGHTS,
      now,
    );
    // 0.40·1 + 0.27·1 + 0.14·1 + 0.10·0.5 + 0.09·1 = 0.40+0.27+0.14+0.05+0.09
    expect(row.terms.map((t) => t.value)).toEqual([0.4, 0.27, 0.14, 0.05, 0.09]);
    expect(row.score).toBe(0.95);
  });

  test("нормировки слагаемых", () => {
    expect(freshnessNorm(0)).toBe(1.0);
    expect(freshnessNorm(2 * 86_400_000)).toBe(0.7);
    expect(freshnessNorm(5 * 86_400_000)).toBe(0.4);
    expect(freshnessNorm(30 * 86_400_000)).toBe(0.15);
    expect(anchorNorm(undefined).norm).toBe(0.5);
    expect(anchorNorm(["fresh", "fresh"]).norm).toBe(1.0);
    expect(anchorNorm(["fresh", "stale"]).norm).toBe(0.2);
    expect(anchorNorm(["drifted"]).norm).toBe(0.6);
    expect(typeNorm("bug")).toBe(1.0);
    expect(typeNorm("task")).toBe(0.5);
    expect(typeNorm("epic")).toBe(0.25);
  });

  test("веса берутся из workspace.toml", () => {
    const parsed = parseWorkspaceToml('slug = "proj"\n\n[ready]\npriority = 0.9\ntype = 0.01\n');
    expect(parsed.slug).toBe("proj");
    expect(parsed.weights.priority).toBe(0.9);
    expect(parsed.weights.type).toBe(0.01);
    expect(parsed.weights.unblocks).toBe(0.27);
  });

  test("заблокированные считаются отдельно и в очередь не попадают", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 30 });
    // n-6 — задача со статусом open (n-0 засев делает in_progress)
    w.db.exec("UPDATE nodes SET open_blockers = 1 WHERE id = 'n-6'");
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildReady(ro, { scope: "", weights: DEFAULT_READY_WEIGHTS });
    expect(r.rows.find((x) => x.id === "n-6")).toBeUndefined();
    expect(r.blocked).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("таймлайн", () => {
  test("хвост оплога в обратном порядке, значения усечены", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 60 });
    seedOplog(w.db, 300);
    w.db.exec(
      `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id, field, value, scope, origin)
       VALUES ('site-a:big', 'site-a', 999999, ${Date.now()}, 'human', 'set', 'node', 'n-1', 'body', '${"x".repeat(900)}', '', 1)`,
    );
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const t = buildTimeline(ro, { limit: 50 });
    expect(t.rows.length).toBe(50);
    expect(t.total).toBe(301);
    expect(t.rows[0]!.seq).toBeGreaterThan(t.rows[49]!.seq);
    expect(t.rows[0]!.value!.length).toBeLessThanOrEqual(161);
    // Заголовок узла подтягивается, когда узел ещё жив.
    expect(t.rows[0]!.title).toBe("узел 1");
  });
});

// ---------------------------------------------------------------------------

describe("здоровье", () => {
  test("считает узлы, рёбра, WAL и кричит о деградации", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 80, edgesPerNode: 2 });
    seedOplog(w.db, 20);
    w.db.exec("INSERT OR REPLACE INTO myc_meta (key, value) VALUES ('site_id','site-a')");
    w.db.exec(
      "INSERT INTO myc_health (component, state, reason, since) VALUES ('hooks','degraded','opencode молчит 7d', 1)",
    );
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const h = buildHealth(ro, { slug: "myc", dbPath: w.dbPath });
    expect(h.nodes.total).toBe(80);
    expect(h.nodes.by_kind.length).toBeGreaterThan(1);
    expect(h.edges.total).toBeGreaterThan(0);
    expect(h.workspace.journal_mode).toBe("wal");
    expect(h.workspace.read_only).toBe(true);
    expect(h.oplog.count).toBe(20);
    expect(h.oplog.actors.length).toBe(2);
    // Версия схемы читается из schema_migrations, а не из myc_meta (там её
    // никогда не было) — реальная миграция даёт число, не null.
    expect(h.workspace.schema_version).not.toBeNull();
    expect(h.workspace.schema_version).toBeGreaterThan(0);

    const codes = h.degraded.map((d) => d.code);
    // Без ключа и без vec0 продукт работает, но обязан говорить об этом вслух.
    expect(codes).toContain("embeddings.off");
    expect(codes).toContain("vector.unavailable");
    expect(codes).toContain("health.hooks");
    expect(codes).not.toContain("schema.version_unknown");
    expect(h.components.find((c) => c.component === "hooks")?.state).toBe("degraded");
  });

  test("протухшие якоря попадают в деградации", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 10, kinds: ["anchor"] });
    w.db.exec(
      `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash,
                            crux, crux_norm, state, bound_at)
       VALUES ('n-0','r','a.ts',1,2,'h','h','c','c','stale',1)`,
    );
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const h = buildHealth(ro, { slug: "myc", dbPath: w.dbPath });
    expect(h.anchors.total).toBe(1);
    expect(h.degraded.map((d) => d.code)).toContain("anchor.stale");
  });
});

// ---------------------------------------------------------------------------

describe("роутинг: модель × класс задачи (W12)", () => {
  /**
   * Приёмка W12 одной строкой: панель показывает достаточную статистику,
   * чтобы координатор выбрал модель, НЕ СПРАШИВАЯ НИКОГО. Проверяется не
   * "числа есть", а то, что каждая оговорка `compareModels` (single_arm,
   * insufficient_attempts, no_cost_data, separationPending) доходит до
   * payload.degraded так же заметно, как экран здоровья, — мутация на
   * каждый случай обязана уронить тест, не только happy path.
   */
  const T0 = Date.parse("2026-09-01T00:00:00Z");
  const HOUR = 3_600_000;

  function setupSwarm(w: Workspace): { roster: Roster; attribution: Attribution; clock: { t: number } } {
    ensureSwarmSchema(w.db);
    const clock = { t: T0 };
    const roster = new Roster(w.db, () => clock.t);
    const attribution = new Attribution(w.db, () => clock.t);
    return { roster, attribution, clock };
  }

  let seq = 0;
  function run(
    attribution: Attribution,
    clock: { t: number },
    input: {
      modelId: string;
      taskClass?: string;
      verdict?: "accepted" | "rework" | "rejected";
      caveats?: readonly Caveat[];
      tokensIn?: number;
      tokensOut?: number;
    },
  ): void {
    seq += 1;
    clock.t += HOUR;
    const a = attribution.startAttempt({
      taskId: `task-${seq}`,
      modelId: input.modelId,
      taskClass: input.taskClass ?? "fix:module",
    });
    attribution.finishAttempt(a.attemptId, {
      verdict: input.verdict ?? "accepted",
      caveats: input.caveats ?? [],
      tokensIn: input.tokensIn ?? 1_000_000,
      tokensOut: input.tokensOut ?? 100_000,
    });
  }

  test("нет таблицы swarm_attempt — available:false, а не пустой список выдуманного успеха", async () => {
    const w = await ws();
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    expect(r.available).toBe(false);
    expect(r.classes).toEqual([]);
    expect(r.degraded.map((d) => d.code)).toContain("swarm.missing");
  });

  test("схема есть, попыток нет — атрибуции нет, сказано вслух", async () => {
    const w = await ws();
    setupSwarm(w);
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    expect(r.available).toBe(true);
    expect(r.classes).toEqual([]);
    expect(r.degraded.map((d) => d.code)).toContain("swarm.no_attribution");
  });

  test("МУТАЦИЯ: single_arm обязан быть виден в degraded — не только внутри карточки класса", async () => {
    const w = await ws();
    const { roster, attribution, clock } = setupSwarm(w);
    roster.addModel({
      modelId: "opus/high",
      family: "opus",
      harness: "claude",
      effort: "high",
      price: { usdPerMIn: 15, usdPerMOut: 75, validFrom: T0 },
    });
    for (let i = 0; i < 4; i++) run(attribution, clock, { modelId: "opus/high", taskClass: "fix:cross" });
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    const cls = r.classes.find((c) => c.taskClass === "fix:cross")!;
    expect(cls.answer).toBe("single_arm");
    // Единственная рука не помечена дешевейшей — cheapest у single_arm равен
    // null: дешевле кого? Сравнивать буквально не с чем.
    expect(cls.arms[0]!.isCheapest).toBe(false);
    // Если это исчезнет из degraded, панель нарисует одну цифру уверенно —
    // и это ровно тот случай, который приёмка запрещает.
    expect(r.degraded.some((d) => d.code === `routing.single_arm.fix:cross`)).toBe(true);
  });

  test("МУТАЦИЯ: insufficient_attempts обязан быть виден в degraded", async () => {
    const w = await ws();
    const { roster, attribution, clock } = setupSwarm(w);
    for (const id of ["a/one", "a/two"]) {
      roster.addModel({
        modelId: id,
        family: id,
        harness: "claude",
        effort: "high",
        price: { usdPerMIn: 1, usdPerMOut: 1, validFrom: T0 },
      });
    }
    run(attribution, clock, { modelId: "a/one", taskClass: "feature:module" });
    run(attribution, clock, { modelId: "a/two", taskClass: "feature:module" });
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    const cls = r.classes.find((c) => c.taskClass === "feature:module")!;
    expect(cls.answer).toBe("insufficient_attempts");
    expect(cls.arms.every((a) => !a.enoughData)).toBe(true);
    expect(
      r.degraded.some((d) => d.code === "routing.insufficient_attempts.feature:module"),
    ).toBe(true);
  });

  test("МУТАЦИЯ: no_cost_data обязан быть виден в degraded, а costUsdMean остаётся null, не 0", async () => {
    const w = await ws();
    const { roster, attribution, clock } = setupSwarm(w);
    for (const id of ["b/one", "b/two"]) {
      roster.addModel({
        modelId: id,
        family: id,
        harness: "claude",
        effort: "high",
        price: { usdPerMIn: 1, usdPerMOut: 1, validFrom: T0 },
      });
    }
    for (let i = 0; i < 4; i++) {
      run(attribution, clock, {
        modelId: "b/one",
        taskClass: "docs:local",
        tokensIn: 0,
        tokensOut: 0,
      });
      run(attribution, clock, {
        modelId: "b/two",
        taskClass: "docs:local",
        tokensIn: 0,
        tokensOut: 0,
      });
    }
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    const cls = r.classes.find((c) => c.taskClass === "docs:local")!;
    expect(cls.answer).toBe("no_cost_data");
    // «Цены нет» — не то же самое, что «цена ноль»: без единого токена стоимость
    // не считалась вовсе, costUsdMean обязан остаться null.
    for (const a of cls.arms) expect(a.costUsdMean).toBeNull();
    expect(r.degraded.some((d) => d.code === "routing.no_cost_data.docs:local")).toBe(true);
  });

  test("цена ноль (посчитана и равна нулю) отличима от цены null (не посчитана)", async () => {
    const w = await ws();
    const { roster, attribution, clock } = setupSwarm(w);
    // Бесплатная модель: цена посчитана (usage есть), но равна нулю.
    roster.addModel({
      modelId: "free/high",
      family: "free",
      harness: "claude",
      effort: "high",
      price: { usdPerMIn: 0, usdPerMOut: 0, validFrom: T0 },
    });
    roster.addModel({
      modelId: "unpriced/high",
      family: "unpriced",
      harness: "claude",
      effort: "high",
      price: { usdPerMIn: 1, usdPerMOut: 1, validFrom: T0 },
    });
    for (let i = 0; i < 4; i++) {
      run(attribution, clock, { modelId: "free/high", taskClass: "fix:local" });
      // tokensIn=0 у второй руки — ветка "нет токенов" в qualityOf/attribution
      // оставляет cost_basis не 'priced', costUsdMean должен остаться null.
      run(attribution, clock, {
        modelId: "unpriced/high",
        taskClass: "fix:local",
        tokensIn: 0,
        tokensOut: 0,
      });
    }
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    const cls = r.classes.find((c) => c.taskClass === "fix:local")!;
    const free = cls.arms.find((a) => a.modelId === "free/high")!;
    const unpriced = cls.arms.find((a) => a.modelId === "unpriced/high")!;
    expect(free.costUsdMean).toBe(0);
    expect(free.costedAttempts).toBe(4);
    expect(unpriced.costUsdMean).toBeNull();
    expect(unpriced.costedAttempts).toBe(0);
  });

  test("happy path: равный результат, дешёвая рука отмечена cheapest, degraded пуст для этого класса", async () => {
    const w = await ws();
    const { roster, attribution, clock } = setupSwarm(w);
    roster.addModel({
      modelId: "cheap/high",
      family: "cheap",
      harness: "claude",
      effort: "high",
      price: { usdPerMIn: 0.1, usdPerMOut: 0.4, validFrom: T0 },
    });
    roster.addModel({
      modelId: "pricey/high",
      family: "pricey",
      harness: "claude",
      effort: "high",
      price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: T0 },
    });
    for (let i = 0; i < 6; i++) {
      run(attribution, clock, { modelId: "cheap/high", taskClass: "fix:module" });
      run(attribution, clock, { modelId: "pricey/high", taskClass: "fix:module" });
    }
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    const cls = r.classes.find((c) => c.taskClass === "fix:module")!;
    expect(cls.answer).toBe("ok");
    expect(cls.separationPending).toBe(false);
    const cheap = cls.arms.find((a) => a.modelId === "cheap/high")!;
    expect(cheap.isCheapest).toBe(true);
    expect(cheap.isEqualGroup).toBe(true);
    // Интервал доверия виден рядом с оценкой, не только средним: границы
    // корректны и не вырождены (qualityMean=1 у Beta(n+1,1) даёт hi<1 — это
    // честная неопределённость апостериора, а не баг сравнения со средним).
    expect(cheap.quality.lo).toBeGreaterThanOrEqual(0);
    expect(cheap.quality.hi).toBeLessThanOrEqual(1);
    expect(cheap.quality.lo).toBeLessThan(cheap.quality.hi);
    expect(
      r.degraded.some((d) => d.code.startsWith("routing.") && d.code.endsWith("fix:module")),
    ).toBe(false);
    expect(r.coverage.attempts).toBe(12);
    expect(r.coverage.withCost).toBe(12);
  });

  test("покрытие задач: tasksClosed/tasksAttributed читаются из nodes и swarm_attempt", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 5, kinds: ["task"] });
    w.db.exec("UPDATE nodes SET status = 'closed'");
    const { roster, attribution, clock } = setupSwarm(w);
    roster.addModel({
      modelId: "m/high",
      family: "m",
      harness: "claude",
      effort: "high",
      price: { usdPerMIn: 1, usdPerMOut: 1, validFrom: T0 },
    });
    for (let i = 0; i < 3; i++) run(attribution, clock, { modelId: "m/high", taskClass: "fix:module" });
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const r = buildRouting(ro);
    expect(r.coverage.tasksClosed).toBe(5);
    expect(r.coverage.tasksAttributed).toBe(3);
  });

  test("HTTP: GET /api/routing отдаёт тот же ответ, что и buildRouting", async () => {
    const w = await ws();
    const { roster, attribution, clock } = setupSwarm(w);
    roster.addModel({
      modelId: "m/high",
      family: "m",
      harness: "claude",
      effort: "high",
      price: { usdPerMIn: 1, usdPerMOut: 1, validFrom: T0 },
    });
    for (let i = 0; i < 4; i++) run(attribution, clock, { modelId: "m/high", taskClass: "fix:module" });
    const s = serve(w);
    const res = await fetch(`${s.url}api/routing`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof buildRouting>;
    expect(body.available).toBe(true);
    expect(body.classes.find((c) => c.taskClass === "fix:module")?.answer).toBe("single_arm");
  });
});

// ---------------------------------------------------------------------------

describe("пустая база", () => {
  test("все четыре экрана отвечают осмысленным «пусто»", async () => {
    const w = await ws();
    const ro = openReadOnly(w.dbPath);
    cleanups.push(() => ro.close());

    const g = buildGraph(ro);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.total_nodes).toBe(0);

    const r = buildReady(ro, { scope: "", weights: DEFAULT_READY_WEIGHTS });
    expect(r.rows).toEqual([]);
    expect(r.ready).toBe(0);

    const t = buildTimeline(ro);
    expect(t.rows).toEqual([]);
    expect(t.total).toBe(0);

    const h = buildHealth(ro, { slug: "myc", dbPath: w.dbPath });
    expect(h.nodes.total).toBe(0);
    expect(h.edges.total).toBe(0);
    expect(h.degraded.length).toBeGreaterThan(0);

    const rt = buildRouting(ro);
    expect(rt.available).toBe(false);
    expect(rt.classes).toEqual([]);
  });

  test("база без схемы myc не роняет ни один экран", async () => {
    const w = await ws();
    const bare = `${w.dbPath}.bare`;
    const raw = new Database(bare, { create: true });
    raw.exec("CREATE TABLE unrelated (x INTEGER)");
    raw.close();
    const ro = openReadOnly(bare);
    cleanups.push(() => ro.close());

    expect(buildGraph(ro).total_nodes).toBe(0);
    expect(buildReady(ro, { scope: "", weights: DEFAULT_READY_WEIGHTS }).ready).toBe(0);
    expect(buildTimeline(ro).total).toBe(0);
    expect(buildRouting(ro).available).toBe(false);
    const h = buildHealth(ro, { slug: "myc", dbPath: bare });
    expect(h.degraded.map((d) => d.code)).toContain("schema.missing");
    // Нет таблицы schema_migrations — версия неизвестна, но объяснена, а не
    // молча null без причины.
    expect(h.workspace.schema_version).toBeNull();
    expect(h.degraded.map((d) => d.code)).toContain("schema.version_unknown");
  });
});

// ---------------------------------------------------------------------------

describe("ассеты", () => {
  test("вшиты в модуль, ни одного внешнего адреса", () => {
    expect(assetPaths()).toEqual(["/", "/index.html", "/app.css", "/app.js", "/layout.worker.js"]);
    const bytes = assetBytes();
    expect(bytes).toBeGreaterThan(10_000);
    // Бюджет §10.2 — 180 КБ; несжатый интерфейс обязан быть заметно меньше.
    expect(bytes).toBeLessThan(180 * 1024);

    for (const path of assetPaths()) {
      const body = getAsset(path)!.body;
      expect(body).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(body).not.toMatch(/\/\/cdn\./);
    }
  });

  test("бандлер вшивает ассеты в выход, а не оставляет ссылку на файл", async () => {
    // Регрессия: спецификатор, который резолвит рантайм, но не резолвит
    // `bun build`, тихо ломает `--compile` — бинарь остаётся без интерфейса.
    const built = await Bun.build({
      entrypoints: [new URL("./assets.ts", import.meta.url).pathname],
      target: "bun",
    });
    expect(built.success).toBe(true);
    const out = await built.outputs[0]!.text();
    expect(out).toContain("myc viz");
    expect(out).toContain("--kind-task");
    expect(out).toContain("class GraphView");
  });

  test("клиентский TypeScript отдаётся уже без типов", () => {
    const js = getAsset("/app.js")!.body;
    expect(js).not.toContain("interface ");
    expect(js).not.toContain("import type");
    expect(js).toContain("class GraphView");
    expect(getAsset("/app.js")!.type).toContain("javascript");
  });
});

// ---------------------------------------------------------------------------

describe("сервер", () => {
  test("отдаёт четыре ручки и страницу, чужое — 404", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 50 });
    seedOplog(w.db, 10);
    const s = serve(w);

    const boot = (await (await fetch(`${s.url}api/boot`)).json()) as { nodes: number; read_only: boolean; schema_ready: boolean };
    expect(boot.nodes).toBe(50);
    // запись включена: read_only=true остаётся только у сборки с readOnly
    expect(boot.read_only).toBe(false);
    expect(boot.schema_ready).toBe(true);

    for (const path of ["api/graph", "api/ready", "api/oplog", "api/health"]) {
      const res = await fetch(`${s.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
    }

    const page = await fetch(s.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("myc viz");
    // CSP делает «ноль CDN» проверяемым свойством, а не обещанием.
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");

    expect((await fetch(`${s.url}nope`)).status).toBe(404);
  });

  test("limit ограничивает выдачу графа", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 120 });
    const s = serve(w, 40);
    const g = (await (await fetch(`${s.url}api/graph`)).json()) as { nodes: unknown[]; truncated: boolean };
    expect(g.nodes.length).toBe(40);
    expect(g.truncated).toBe(true);
  });

  test("CLI пишет в базу, пока сервер открыт, и сервер видит запись", async () => {
    const w = await ws();
    seedGraph(w.db, { nodes: 5 });
    const s = serve(w);
    const before = (await (await fetch(`${s.url}api/boot`)).json()) as { nodes: number };
    expect(before.nodes).toBe(5);

    // Отдельное пишущее соединение — как это делает CLI параллельно с viz.
    const writer = new Database(w.dbPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA busy_timeout = 3000");
    seedGraph(writer, { nodes: 7, kinds: ["note"], prefix: "m" });
    writer.close();

    const after = (await (await fetch(`${s.url}api/boot`)).json()) as { nodes: number };
    expect(after.nodes).toBe(12);
  });
});
