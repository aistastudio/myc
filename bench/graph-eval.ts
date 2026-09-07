#!/usr/bin/env bun
/**
 * ЗАМЕР РАСШИРЕНИЯ ПО ГРАФУ (memory-1md1zhs0w8r0, §2.2).
 *
 *   bun run bench/graph-eval.ts [--out bench/graph-eval.json] [--latency] [--sweep]
 *
 * Зачем отдельный корпус, а не bench/boost-queries.json. Там правильный ответ
 * ЛЕЖИТ В ТЕКСТЕ, и бусты лишь переставляют пул, который лексика уже собрала;
 * измерять на нём обход бессмысленно — обход добавляет узлы, которых в пуле
 * НЕТ. Поэтому в bench/graph-queries.json в группах hop1/hop2/typed правильный
 * ответ не содержит ни одного слова запроса: без обхода метрика там обязана
 * быть нулём, и это само по себе проверка, что мерится именно обход.
 *
 * ТРИ ТОЧКИ НА ОДНОМ КОРПУСЕ (иначе «стало лучше» — слово):
 *   off  — graphMaxHops: 0, расширение выключено накладкой конфига;
 *   hop1 — graphMaxHops: 1, поведение до этой задачи;
 *   hop2 — умолчание, 1–2 хопа с затуханием по глубине.
 *
 * Метрики: MRR@10 и P@1, разбивка по группам. Группа distractor НАКАЗЫВАЕТ
 * обход (правильный ответ старый, P3, L0, а верхний хит свежий, P0, L3 и тащит
 * четырёх соседей): её падение печатается отдельной строкой, чтобы плюс нельзя
 * было получить конструкцией корпуса. Группа lexical — контроль сохранности.
 *
 * Вектор выключен (vectorMode: "never"): измеряется вклад обхода, а не
 * эмбеддера.
 *
 * --latency: цена обхода на 100k узлов в плотном графе (средняя степень ~4 плюс
 * хабы). Отдельно, потому что качество и цена — разные вопросы, и приёмка
 * задачи требует ОБА числа.
 * --sweep: перебор затухания второго хопа и весов типов — то, чем выбраны
 * умолчания DEFAULT_GRAPH_DECAY_BY_HOP и DEFAULT_GRAPH_TYPE_WEIGHTS.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import {
  DEFAULT_HYBRID_CONFIG,
  hybridSearch,
  NO_GRAPH_OVERRIDES,
  ONE_HOP_OVERRIDES,
  SearchResultCache,
  searchCacheKey,
  type FtsCaller,
  type HybridConfig,
  type HybridProfile,
  type HybridResult,
} from "@myc/retrieval";

interface CorpusNode {
  readonly id: string;
  readonly layer: number;
  readonly priority: number;
  readonly ageDays: number;
  readonly title: string;
  readonly body: string;
}
interface CorpusEdge {
  readonly src: string;
  readonly type: string;
  readonly dst: string;
  readonly weight: number;
}
interface CorpusQuery {
  readonly q: string;
  readonly group: string;
  readonly profile: HybridProfile;
  readonly relevant: string;
}
interface Corpus {
  readonly nodes: readonly CorpusNode[];
  readonly edges: readonly CorpusEdge[];
  readonly queries: readonly CorpusQuery[];
}

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };
const LIMIT = 10;

/** Тот же приём, что в bench/boost-eval.ts: id — хеш ключа корпуса, не generateId. */
function nodeIdOf(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 24);
}

function buildDb(corpus: Corpus, now: number): { db: SqliteDriver; idOf: Map<string, string> } {
  const db = openSqlite(":memory:");
  db.database.exec(migration001Init.sql);
  const idOf = new Map<string, string>();
  const insert = db.database.query(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        head_id, content_hash, acl, owner_id, team_id, agent_id,
                        created_at, updated_at)
     VALUES (?1, 'note', ?2, 's1', ?3, ?4, ?5, ?6, 'active', NULL, ?7, 'team', '', '', '', ?8, ?8)`,
  );
  for (const n of corpus.nodes) {
    const id = nodeIdOf(n.id);
    idOf.set(n.id, id);
    const updatedAt = now - n.ageDays * 86_400_000;
    insert.run(id, n.layer, n.title, n.body, n.body.slice(0, 120), n.priority, `hash-${id}`, updatedAt);
  }
  const insEdge = db.database.query(
    `INSERT INTO edges (src, type, dst, weight, add_tag, actor, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'bench', ?6)`,
  );
  for (const [i, e] of corpus.edges.entries()) {
    insEdge.run(idOf.get(e.src)!, e.type, idOf.get(e.dst)!, e.weight, `tag-${i}`, now);
  }
  return { db, idOf };
}

interface GroupStat {
  total: number;
  mrrSum: number;
  firstHits: number;
  found: number;
}

interface VariantResult {
  readonly variant: string;
  readonly mrr: number;
  readonly p1: number;
  readonly found: number;
  readonly total: number;
  readonly byGroup: Record<string, { mrr: number; p1: number; total: number }>;
  /** Ранг правильного узла по каждому запросу — сырьё, по которому всё сошлось. */
  readonly ranks: Record<string, number | null>;
}

function evaluate(
  corpus: Corpus,
  db: SqliteDriver,
  idOf: Map<string, string>,
  now: number,
  overrides: Partial<HybridConfig>,
  variant: string,
  cache?: SearchResultCache<HybridResult>,
): VariantResult {
  const groups = new Map<string, GroupStat>();
  const ranks: Record<string, number | null> = {};
  let mrrSum = 0;
  let firstHits = 0;
  let found = 0;

  for (const query of corpus.queries) {
    const result = hybridSearch(db, {
      text: query.q,
      scopes: ["s1"],
      caller: ANON,
      limit: LIMIT,
      now,
      vectorMode: "never",
      config: { ...overrides, profile: query.profile },
      cache,
    });
    const target = idOf.get(query.relevant)!;
    const rank = result.hits.find((h) => h.id === target)?.rank ?? null;
    ranks[query.q] = rank;

    const g = groups.get(query.group) ?? { total: 0, mrrSum: 0, firstHits: 0, found: 0 };
    g.total += 1;
    if (rank !== null) {
      g.mrrSum += 1 / rank;
      g.found += 1;
      mrrSum += 1 / rank;
      found += 1;
      if (rank === 1) {
        g.firstHits += 1;
        firstHits += 1;
      }
    }
    groups.set(query.group, g);
  }

  const byGroup: Record<string, { mrr: number; p1: number; total: number }> = {};
  for (const [name, g] of groups) {
    byGroup[name] = { mrr: g.mrrSum / g.total, p1: g.firstHits / g.total, total: g.total };
  }
  const total = corpus.queries.length;
  return { variant, mrr: mrrSum / total, p1: firstHits / total, found, total, byGroup, ranks };
}

// ---------------------------------------------------------------------------
// Цена обхода на 100k
// ---------------------------------------------------------------------------

const BIG_N = 100_000;
const BIG_TERM = "расширение";

/**
 * Плотный синтетический граф: средняя степень ~4 плюс сто хабов по 200 рёбер.
 * Хабы здесь не для красоты — именно они делают цену второго хопа зависящей от
 * данных, а не от конфига, и ровно против них стоит потолок graphHop2Seeds.
 */
function seedBig(db: SqliteDriver): void {
  const now = Date.now();
  const ins = db.database.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        content_hash, acl, owner_id, team_id, agent_id, created_at, updated_at)
     VALUES (?1, 'note', ?2, 's1', ?3, ?4, ?5, 2, 'active', ?6, 'team', '', '', '', ?7, ?7)`,
  );
  const insEdge = db.database.prepare(
    `INSERT OR IGNORE INTO edges (src, type, dst, weight, add_tag, actor, created_at)
     VALUES (?1, ?2, ?3, 1.0, ?4, 'bench', ?5)`,
  );
  const id = (i: number): string => `n${String(i).padStart(7, "0")}`;
  db.database.exec("BEGIN");
  for (let i = 0; i < BIG_N; i++) {
    const hasTerm = i % 20 === 0;
    const title = hasTerm
      ? `${BIG_TERM} выдачи по графу узел ${i}`
      : `синтетический узел графа номер ${i}`;
    ins.run(id(i), i % 100 === 0 ? 2 : 1, title, title, title.slice(0, 120), `h-${i}`, now);
  }
  const types = ["relates", "parent", "mentions", "derived_from"];
  for (let i = 1; i < BIG_N; i++) {
    // ~4 ребра на узел: назад по цепи и три «случайных» детерминированных прыжка.
    insEdge.run(id(i), types[i % 4]!, id(i - 1), `e-a-${i}`, now);
    insEdge.run(id(i), types[(i + 1) % 4]!, id((i * 7919) % BIG_N), `e-b-${i}`, now);
    insEdge.run(id(i), types[(i + 2) % 4]!, id((i * 104729) % BIG_N), `e-c-${i}`, now);
  }
  for (let h = 0; h < 100; h++) {
    const hub = id(h * 997);
    for (let k = 1; k <= 200; k++) insEdge.run(hub, "mentions", id((h * 997 + k * 13) % BIG_N), `e-h-${h}-${k}`, now);
  }
  db.database.exec("COMMIT");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function measure(db: SqliteDriver, overrides: Partial<HybridConfig>, iters: number): {
  p50: number;
  p95: number;
  p99: number;
  hits: number;
  graphHits: number;
} {
  const queries = [
    `${BIG_TERM} выдачи по графу`,
    `${BIG_TERM} графу узел 4000`,
    `синтетический узел графа номер 51234`,
    `${BIG_TERM} выдачи узел 77760`,
  ];
  let hits = 0;
  let graphHits = 0;
  for (let i = 0; i < 20; i++) {
    hybridSearch(db, { text: queries[i % queries.length]!, scopes: ["s1"], caller: ANON, vectorMode: "never", config: overrides });
  }
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const q = queries[i % queries.length]!;
    const t0 = performance.now();
    const r = hybridSearch(db, { text: q, scopes: ["s1"], caller: ANON, vectorMode: "never", config: overrides });
    samples.push(performance.now() - t0);
    hits += r.hits.length;
    graphHits += r.mode_used.graph.inHits;
  }
  samples.sort((a, b) => a - b);
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    hits: hits / iters,
    graphHits: graphHits / iters,
  };
}

function fmt(n: number, w = 6, d = 3): string {
  return n.toFixed(d).padStart(w);
}

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1]! : "bench/graph-eval.json";

  const corpus = JSON.parse(
    readFileSync(resolve(import.meta.dir, "graph-queries.json"), "utf8"),
  ) as Corpus;
  const now = Date.UTC(2026, 8, 7);
  const { db, idOf } = buildDb(corpus, now);

  const off = evaluate(corpus, db, idOf, now, NO_GRAPH_OVERRIDES, "off");
  const hop1 = evaluate(corpus, db, idOf, now, ONE_HOP_OVERRIDES, "hop1");
  const hop2 = evaluate(corpus, db, idOf, now, {}, "hop2");
  const results = [off, hop1, hop2];

  console.log(
    `корпус: ${corpus.nodes.length} узлов, ${corpus.edges.length} рёбер, ` +
      `${corpus.queries.length} запросов, limit ${LIMIT}, вектор выключен`,
  );
  console.log("");
  console.log("  вариант | MRR@10 |   P@1 | найдено");
  for (const r of results) {
    console.log(`  ${r.variant.padEnd(7)} | ${fmt(r.mrr)} | ${r.p1.toFixed(3)} | ${r.found}/${r.total}`);
  }
  console.log("");
  console.log(
    `  СДВИГ MRR@10: ${off.mrr.toFixed(3)} -> ${hop2.mrr.toFixed(3)} ` +
      `(${(hop2.mrr - off.mrr >= 0 ? "+" : "") + (hop2.mrr - off.mrr).toFixed(3)})`,
  );
  console.log(
    `  СДВИГ P@1:    ${off.p1.toFixed(3)} -> ${hop2.p1.toFixed(3)} ` +
      `(${(hop2.p1 - off.p1 >= 0 ? "+" : "") + (hop2.p1 - off.p1).toFixed(3)})`,
  );
  console.log(
    `  ВКЛАД ВТОРОГО ХОПА: ${hop1.mrr.toFixed(3)} -> ${hop2.mrr.toFixed(3)} ` +
      `(${(hop2.mrr - hop1.mrr >= 0 ? "+" : "") + (hop2.mrr - hop1.mrr).toFixed(3)})`,
  );
  console.log("");
  console.log("  группа       | MRR off | MRR hop1 | MRR hop2 | дельта к off");
  for (const name of Object.keys(hop2.byGroup)) {
    const a = off.byGroup[name]!;
    const b = hop1.byGroup[name]!;
    const c = hop2.byGroup[name]!;
    const d = c.mrr - a.mrr;
    console.log(
      `  ${name.padEnd(12)} |   ${a.mrr.toFixed(3)} |    ${b.mrr.toFixed(3)} |    ${c.mrr.toFixed(3)} | ${(d >= 0 ? "+" : "") + d.toFixed(3)}`,
    );
  }

  // --- кеш: расширение обязано попадать в ключ ------------------------------
  //
  // И2 в чистом виде: если graphMaxHops не входит в ключ, кеш начнёт отдавать
  // выдачу БЕЗ расширения на запрос С расширением — тихо и неотличимо.
  const keyParts = {
    text: "q",
    scopes: ["s1"],
    layerMin: 0,
    layerMax: 3,
    limit: 10,
    vectorMode: "never",
    caller: ANON,
  };
  const keyHop2 = searchCacheKey({ ...keyParts, config: { ...DEFAULT_HYBRID_CONFIG } });
  const keyOff = searchCacheKey({ ...keyParts, config: { ...DEFAULT_HYBRID_CONFIG, ...NO_GRAPH_OVERRIDES } });
  const keyHop1 = searchCacheKey({ ...keyParts, config: { ...DEFAULT_HYBRID_CONFIG, ...ONE_HOP_OVERRIDES } });
  const keysDistinct = new Set([keyHop2, keyOff, keyHop1]).size === 3;
  const cache = new SearchResultCache<HybridResult>();
  evaluate(corpus, db, idOf, now, {}, "hop2", cache);
  const cached = evaluate(corpus, db, idOf, now, {}, "hop2", cache);
  let mismatches = 0;
  for (const q of Object.keys(hop2.ranks)) if (hop2.ranks[q] !== cached.ranks[q]) mismatches++;
  console.log("");
  console.log("КЕШ РЕЗУЛЬТАТОВ");
  console.log(
    `  ключи off/hop1/hop2 различны: ${keysDistinct ? "да" : "НЕТ — кеш отдаст выдачу без расширения"}`,
  );
  console.log(
    `  второй прогон целиком из кеша: попаданий ${cache.hits}, промахов ${cache.misses}, ` +
      `рангов разошлось ${mismatches}`,
  );
  if (!keysDistinct || mismatches !== 0) process.exitCode = 1;

  // --- перебор коэффициентов ------------------------------------------------
  let sweep: Record<string, unknown> | undefined;
  if (args.includes("--sweep")) {
    console.log("");
    console.log("ПЕРЕБОР ЗАТУХАНИЯ ВТОРОГО ХОПА (d1 = 0.5 фиксировано, §2.2)");
    console.log("     d2 | MRR@10 |   P@1 | hop2 | distractor");
    const d2Rows: { d2: number; mrr: number; p1: number; hop2: number; distractor: number }[] = [];
    for (const d2 of [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0]) {
      const r = evaluate(corpus, db, idOf, now, { graphDecayByHop: [0.5, d2] }, `d2=${d2}`);
      d2Rows.push({ d2, mrr: r.mrr, p1: r.p1, hop2: r.byGroup.hop2!.mrr, distractor: r.byGroup.distractor!.mrr });
      console.log(
        `  ${d2.toFixed(2)} | ${fmt(r.mrr)} | ${r.p1.toFixed(3)} | ${r.byGroup.hop2!.mrr.toFixed(3)} | ${r.byGroup.distractor!.mrr.toFixed(3)}`,
      );
    }
    console.log("");
    console.log("ВЕСА ТИПОВ РЁБЕР (группа typed: ответ по parent, шум по mentions)");
    const typedOff = evaluate(corpus, db, idOf, now, { graphTypeWeights: {} }, "types=1");
    const typedOn = evaluate(corpus, db, idOf, now, {}, "types=default");
    console.log(`  все типы = 1.0        | MRR ${typedOff.mrr.toFixed(3)} | typed ${typedOff.byGroup.typed!.mrr.toFixed(3)}`);
    console.log(`  mentions/touches 0.5  | MRR ${typedOn.mrr.toFixed(3)} | typed ${typedOn.byGroup.typed!.mrr.toFixed(3)}`);
    sweep = { d2: d2Rows, types: { off: typedOff.mrr, on: typedOn.mrr, typedOff: typedOff.byGroup.typed!.mrr, typedOn: typedOn.byGroup.typed!.mrr } };
  }

  // --- цена обхода ----------------------------------------------------------
  let latency: Record<string, unknown> | undefined;
  if (args.includes("--latency")) {
    console.log("");
    console.log(`ЦЕНА ОБХОДА при ${BIG_N} узлах (плотный граф: ~3 ребра на узел + 100 хабов по 200)`);
    const big = openSqlite(":memory:");
    big.database.exec(migration001Init.sql);
    seedBig(big);
    const edgeCount = big.database.query<{ n: number }, []>("SELECT count(*) AS n FROM edges").get()!.n;
    const ITERS = 200;
    const rows: { variant: string; p50: number; p95: number; p99: number; graphHits: number }[] = [];
    for (const [variant, cfg] of [
      ["off (0 хопов)", NO_GRAPH_OVERRIDES],
      ["hop1 (1 хоп)", ONE_HOP_OVERRIDES],
      ["hop2 (2 хопа)", {} as Partial<HybridConfig>],
      // МУТАЦИЯ: оба потолка сняты. Показывает, что именно они покупают.
      ["hop2 без потолков", { graphHop2Seeds: 100_000, graphHopFanout: 100_000 }],
    ] as const) {
      const m = measure(big, cfg, ITERS);
      rows.push({ variant, p50: m.p50, p95: m.p95, p99: m.p99, graphHits: m.graphHits });
    }
    console.log(`  рёбер в базе: ${edgeCount}, итераций ${ITERS}, вектор выключен`);
    console.log("  вариант           |  p50 мс |  p95 мс |  p99 мс | узлов графа в топ-12");
    for (const r of rows) {
      console.log(
        `  ${r.variant.padEnd(17)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${r.graphHits.toFixed(1)}`,
      );
    }
    const base = rows[0]!;
    console.log("");
    console.log("  ЦЕНА САМОГО ОБХОДА = разница с вариантом «расширение выключено»:");
    for (const r of rows.slice(1)) {
      const d = (x: number, y: number): string => `${x - y >= 0 ? "+" : ""}${(x - y).toFixed(3)}`;
      console.log(
        `    ${r.variant.padEnd(17)} p50 ${d(r.p50, base.p50)} мс, ` +
          `p95 ${d(r.p95, base.p95)} мс, p99 ${d(r.p99, base.p99)} мс`,
      );
    }
    latency = { nodes: BIG_N, edges: edgeCount, iters: ITERS, rows };
    big.close();
  }

  const payload = {
    _: "Замер расширения по графу (memory-1md1zhs0w8r0). Пересчёт: bun run bench/graph-eval.ts --latency --sweep. Числа сверяются тестом packages/retrieval/src/graph.test.ts.",
    corpus: {
      nodes: corpus.nodes.length,
      edges: corpus.edges.length,
      queries: corpus.queries.length,
      limit: LIMIT,
      vector: "never",
    },
    variants: results,
    shift: {
      mrr: { off: off.mrr, hop1: hop1.mrr, hop2: hop2.mrr, delta: hop2.mrr - off.mrr },
      p1: { off: off.p1, hop1: hop1.p1, hop2: hop2.p1, delta: hop2.p1 - off.p1 },
    },
    cache: { keysDistinct, hits: cache.hits, misses: cache.misses, rankMismatches: mismatches },
    ...(sweep ? { sweep } : {}),
    ...(latency ? { latency } : {}),
    generated_at: new Date().toISOString(),
  };
  writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(payload, null, 2)}\n`);
  console.log("");
  console.log(`записано: ${out}`);
  db.close();
}

main();
