#!/usr/bin/env bun
/**
 * ЗАМЕР БУСТОВ РАНЖИРОВАНИЯ (memory-vhchz7wzfjh9, §2.2).
 *
 *   bun run bench/boost-eval.ts [--out bench/boost-eval.json] [--only both|on|off]
 *
 * Зачем. Бусты приоритета, свежести и слоя переставляют выдачу внутри пула,
 * который лексика уже собрала. Утверждение «стало лучше» о такой перестановке
 * ничего не значит без корпуса, поэтому здесь считается ДВА числа на одном и
 * том же корпусе: без бустов (все коэффициенты обнулены конфигом) и с
 * бустами из §2.2. Разница между ними — единственное, что доказывает, что
 * бусты вообще что-то делают.
 *
 * Корпус — bench/boost-queries.json, 25 тем по 3 узла. Внутри темы узлы
 * лексически почти неразличимы: все слова запроса стоят дословно в title
 * каждого из трёх. Значит BM25 их не разводит, и порядок решают ровно бусты.
 *
 * Вектор выключен (vectorMode: "never") намеренно: измеряется перестановка
 * лексического пула, а не вклад эмбеддера, иначе числа нельзя было бы
 * приписать бустам.
 *
 * Метрики: MRR@10 (средний обратный ранг правильного узла) и P@1 (доля
 * запросов, где правильный узел оказался первым). MRR — основная: он ловит
 * не «нашлось ли», а «на каком месте», то есть ровно то, что меняют бусты.
 *
 * Группа distractor в корпусе НАКАЗЫВАЕТ бусты (правильный ответ там старый,
 * P2 и в нижнем слое, а шум свежий, P0 и L3). Она в корпусе для того, чтобы
 * итог нельзя было получить конструкцией корпуса: по ней метрика с бустами
 * обязана падать, и это падение печатается отдельной строкой, а не тонет в
 * среднем.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import {
  hybridSearch,
  NO_BOOST_OVERRIDES,
  SearchResultCache,
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

interface CorpusQuery {
  readonly q: string;
  readonly group: string;
  readonly profile: HybridProfile;
  readonly relevant: string;
}

interface Corpus {
  readonly nodes: readonly CorpusNode[];
  readonly queries: readonly CorpusQuery[];
}

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };
const LIMIT = 10;

/**
 * «Бусты выключены» — не отдельная ветка в коде, а КОНФИГ, в котором все три
 * коэффициента обнулены. Именно поэтому вынос чисел §2.2 в конфигурацию был
 * условием замера: без него эту точку нельзя получить, не правя исходник.
 */
const BOOSTS_OFF: Partial<HybridConfig> = NO_BOOST_OVERRIDES;


/**
 * Физический id узла — хеш от ключа корпуса, а не generateId().
 *
 * Причина не в красоте, а в воспроизводимости замера. Без бустов узлы одной
 * темы получают ОДИНАКОВЫЙ ранг BM25 (RANK() OVER даёт равным скорам равный
 * ранг), то есть одинаковый RRF, и порядок между ними решает тай-брейк по id.
 * На случайном id точка «без бустов» плавала бы от прогона к прогону, а на
 * алфавитных ключах корпуса (fr1a < fr1b < fr1c) она была бы систематически
 * завышена в пользу правильного ответа — и то и другое врёт о размере сдвига.
 * Хеш даёт порядок, зафиксированный навсегда и не связанный с разметкой.
 */
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
  return { db, idOf };
}

interface GroupStat {
  readonly group: string;
  total: number;
  mrrSum: number;
  firstHits: number;
  rankSum: number;
  found: number;
}

interface VariantResult {
  readonly variant: "off" | "on";
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
  variant: "off" | "on",
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
    const hit = result.hits.find((h) => h.id === target);
    const rank = hit?.rank ?? null;
    ranks[query.q] = rank;

    const g = groups.get(query.group) ?? {
      group: query.group,
      total: 0,
      mrrSum: 0,
      firstHits: 0,
      rankSum: 0,
      found: 0,
    };
    g.total += 1;
    if (rank !== null) {
      g.mrrSum += 1 / rank;
      g.rankSum += rank;
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

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1]! : "bench/boost-eval.json";
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1]! : "both";
  const cacheMode = args.includes("--cache");

  const corpusPath = resolve(import.meta.dir, "boost-queries.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

  // now фиксировано на прогон: возраст узлов задан относительно него, поэтому
  // результат воспроизводим и не зависит от даты запуска.
  const now = Date.UTC(2026, 8, 7);
  const { db, idOf } = buildDb(corpus, now);

  const results: VariantResult[] = [];
  if (only === "both" || only === "off") results.push(evaluate(corpus, db, idOf, now, BOOSTS_OFF, "off"));
  if (only === "both" || only === "on") results.push(evaluate(corpus, db, idOf, now, {}, "on"));

  const off = results.find((r) => r.variant === "off");
  const on = results.find((r) => r.variant === "on");

  // --cache: КАЧЕСТВО ПРИ ВКЛЮЧЁННОМ КЕШЕ (memory-spwaw50jxcpw).
  //
  // Кеш обязан быть неотличим от его отсутствия. «Стало быстрее» без этой
  // проверки ничего не стоит: кеш, который отдаёт ЧУЖОЙ или УСТАРЕВШИЙ
  // ответ, тоже быстрый. Поэтому тот же корпус прогоняется второй раз с
  // кешем, и сверяются не только MRR@10 и P@1, а РАНГ КАЖДОГО запроса:
  // совпадение средних можно получить и перемешав выдачу.
  //
  // Корпус зовёт 25 запросов по одному разу, поэтому попаданий в нём нет
  // по построению — второй прогон делает второй проход по тем же запросам,
  // и вот он идёт уже целиком из кеша.
  if (cacheMode) {
    console.log("");
    console.log("КАЧЕСТВО С КЕШЕМ РЕЗУЛЬТАТОВ (--cache)");
    console.log("  вариант | MRR@10 без кеша | MRR@10 с кешем | P@1 без | P@1 с | рангов разошлось");
    let mismatches = 0;
    for (const r of results) {
      const overrides = r.variant === "off" ? BOOSTS_OFF : {};
      const cache = new SearchResultCache<HybridResult>();
      evaluate(corpus, db, idOf, now, overrides, r.variant, cache); // наполняем
      const cached = evaluate(corpus, db, idOf, now, overrides, r.variant, cache); // из кеша
      let diff = 0;
      for (const q of Object.keys(r.ranks)) {
        if (r.ranks[q] !== cached.ranks[q]) diff++;
      }
      mismatches += diff;
      console.log(
        `  ${r.variant.padEnd(7)} | ${r.mrr.toFixed(3).padStart(15)} | ${cached.mrr
          .toFixed(3)
          .padStart(14)} | ${r.p1.toFixed(3).padStart(7)} | ${cached.p1
          .toFixed(3)
          .padStart(5)} | ${String(diff).padStart(16)}`,
      );
      console.log(
        `          попаданий ${cache.hits}, промахов ${cache.misses}, ` +
          `устаревших ${cache.staleDrops}, записей в кеше ${cache.size}`,
      );
    }
    console.log(
      mismatches === 0
        ? "  ИТОГ: кеш не переставил ни одного ранга — качество совпадает точно."
        : `  ИТОГ: РАСХОЖДЕНИЕ на ${mismatches} рангах — кеш меняет выдачу.`,
    );
    if (mismatches !== 0) process.exitCode = 1;
  }

  console.log(`корпус: ${corpus.nodes.length} узлов, ${corpus.queries.length} запросов, limit ${LIMIT}, вектор выключен`);
  console.log("");
  console.log("  вариант | MRR@10 |   P@1 | найдено");
  for (const r of results) {
    console.log(
      `  ${r.variant.padEnd(7)} | ${r.mrr.toFixed(3).padStart(6)} | ${r.p1.toFixed(3)} | ${r.found}/${r.total}`,
    );
  }
  if (off && on) {
    console.log("");
    console.log(`  СДВИГ MRR@10: ${off.mrr.toFixed(3)} -> ${on.mrr.toFixed(3)} (${(on.mrr - off.mrr >= 0 ? "+" : "") + (on.mrr - off.mrr).toFixed(3)})`);
    console.log(`  СДВИГ P@1:    ${off.p1.toFixed(3)} -> ${on.p1.toFixed(3)} (${(on.p1 - off.p1 >= 0 ? "+" : "") + (on.p1 - off.p1).toFixed(3)})`);
    console.log("");
    console.log("  группа       | MRR off | MRR on |  дельта");
    for (const name of Object.keys(on.byGroup)) {
      const a = off.byGroup[name]!;
      const b = on.byGroup[name]!;
      const d = b.mrr - a.mrr;
      console.log(
        `  ${name.padEnd(12)} |  ${a.mrr.toFixed(3)} |  ${b.mrr.toFixed(3)} | ${(d >= 0 ? "+" : "") + d.toFixed(3)}`,
      );
    }
  }

  const payload = {
    _: "Замер бустов ранжирования (memory-vhchz7wzfjh9). Пересчёт: bun run bench/boost-eval.ts. Числа сверяются тестом packages/retrieval/src/boost.test.ts.",
    corpus: { nodes: corpus.nodes.length, queries: corpus.queries.length, limit: LIMIT, vector: "never" },
    variants: results,
    ...(off && on
      ? {
          shift: {
            mrr: { off: off.mrr, on: on.mrr, delta: on.mrr - off.mrr },
            p1: { off: off.p1, on: on.p1, delta: on.p1 - off.p1 },
          },
        }
      : {}),
    generated_at: new Date().toISOString(),
  };
  writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(payload, null, 2)}\n`);
  console.log("");
  console.log(`записано: ${out}`);
  db.close();
}

main();
