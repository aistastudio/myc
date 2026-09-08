/**
 * И1: проверка ацикличности `blocks` — часть ЗАПИСИ, бюджет 5 мс (§11).
 * Обход при вставке не имеет права зависеть от размера графа: без предела
 * глубины вставка ребра — это рекурсия по всему достижимому подграфу.
 *
 * Стенд — 100 000 узлов и 100 000 живых blocks-рёбер, среди них длинные
 * цепочки: короткий разреженный граф не отличил бы ограниченный обход от
 * неограниченного.
 *
 * Мерится ТОТ ЖЕ текст запроса, что исполняет движок (`cycleQueries
 * .edge_reach_probe`), плюс сама вставка через `GraphStore.addEdge` — вторая
 * цифра и есть горячий путь целиком.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlcClock, generateId } from "@myc/core";
import { openSqlite, type SqliteDriver } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";
import { checkEdgeAcyclic, MAX_BLOCKS_DEPTH, MAX_BLOCKS_REACH } from "./cycle.ts";

const N = 100_000;
/** Длина цепочек: заметно больше типичной, но в пределах допустимой глубины. */
const CHAIN = 40;
/** Хаб-узел и его степень — худший случай обхода в пределах глубины. */
const HUB = "hub";
const HUB_FANOUT = 500;
/** Бюджет И1 на запись целиком (§11). Проверка цикла — одна её часть. */
const WRITE_BUDGET_MS = 5;
/**
 * Потолок для ОДНОЙ проверки ацикличности. Выбран замером, а не на глаз —
 * числа на этом же стенде (широкий узел, 20 000 достижимых на глубине 40):
 *   обход без бюджета посещённых          — 445 мс;
 *   рекурсивный CTE из §4.3, бюджет 4096  —  9.7 мс;
 *   BFS с бюджетом 4096                   —  6.0 мс;
 *   BFS с бюджетом 512 (наш)              —  0.13 мс.
 * 1 мс лежит между здоровым состоянием и любым из этих ухудшений и
 * оставляет записи 5× запаса до её собственного бюджета.
 */
const PROBE_BUDGET_MS = 1;

/**
 * Абсолютный бюджет проверяется только там, где он откалиброван.
 *
 * Числа выше сняты на рабочей машине (14 ядер, arm64); общий раннер CI даёт
 * 4 ядра x86, и тот же код там честно медленнее — сборка краснела, называя
 * это регрессией. Тот же выключатель, что у `@myc/bench`
 * (`MYC_BENCH_ABSOLUTE=0` в ci.yml), но правило здесь повторено, а не
 * импортировано: `store-sqlite` по архитектуре зависит только от `@myc/core`,
 * и тянуть ради двух строк ещё один пакет дороже, чем повторить их с этой
 * ссылкой. Число печатается всегда — оно и есть предмет наблюдения.
 */
function budgetCheck(actualMs: number, budgetMs: number, label: string): void {
  const calibrated =
    process.env["MYC_BENCH_ABSOLUTE"] !== "0" || process.env["MYC_BENCH_STRICT"] === "1";
  const line = `[bench] ${label}: ${actualMs.toFixed(3)}мс при бюджете ${budgetMs}мс`;
  if (actualMs < budgetMs) {
    console.log(`${line} → в бюджете`);
    return;
  }
  if (!calibrated) {
    console.log(`${line} → НЕ ПРОВЕРЯЕТСЯ (MYC_BENCH_ABSOLUTE=0: бюджет под другое железо)`);
    return;
  }
  throw new Error(`бюджет нарушен: ${line}`);
}

let dir: string;
let driver: SqliteDriver;
let store: GraphStore;
let db: Database;
/** Головы цепочек — из них обход уходит на всю доступную глубину. */
const heads: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-cycle-lat-"));
  driver = openSqlite(join(dir, "myc.db"));
  db = driver.database;
  await migrate(db, { migrations, writable: true });
  let t = 1_700_000_000_000;
  store = new GraphStore(driver, {
    siteId: "bench",
    actor: "bench",
    newId: () => generateId(),
    clock: new HlcClock({ now: () => (t += 1) }),
    now: () => 1_700_000_000_000,
  });

  // Узлы и рёбра кладём напрямую: GraphStore на 100k операций — это замер
  // оплога, а не проверки цикла. Форма графа важнее пути записи.
  const insN = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        content_hash, acl, team_id, salience, attrs, created_at, updated_at)
     VALUES (?1,'task',0,'bench',?2,'','',2,'open',?3,'team','',0.5,'{}',1,1)`,
  );
  const insE = db.prepare(
    `INSERT INTO edges (src, type, dst, weight, add_tag, actor, created_at, hlc, site_id, attrs)
     VALUES (?1,'blocks',?2,1.0,?3,'bench',1,0,'bench','{}')`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) insN.run(`n${i}`, `узел ${i}`, `h-${i}`);
  insN.run(HUB, "хаб", "h-hub");
  // Форма: N/CHAIN изолированных цепочек по CHAIN звеньев, внутри каждой —
  // ещё и «через одного» (ромбы), чтобы обход не сводился к линии и на
  // каждом шаге имел выбор. Цепочки НЕ сшиты между собой: сшитая цепочка
  // длиннее предела — это уже отказ по глубине, а не замер.
  for (let i = 0; i + 1 < N; i++) {
    if ((i + 1) % CHAIN !== 0) insE.run(`n${i}`, `n${i + 1}`, `t-${i}`);
    if ((i + 2) % CHAIN !== 0 && (i + 2) % CHAIN > 1) insE.run(`n${i}`, `n${i + 2}`, `s-${i}`);
  }
  // Худший случай в пределах глубины: один узел, из которого достижимо
  // HUB_FANOUT × CHAIN узлов (глубина 1 + CHAIN, всё ещё меньше предела).
  for (let c = 0; c < HUB_FANOUT; c++) insE.run(HUB, `n${c * CHAIN}`, `hub-${c}`);
  db.exec("COMMIT");
  db.exec("ANALYZE");
  for (let i = 0; i < N; i += CHAIN) heads.push(`n${i}`);
});

afterAll(() => {
  try {
    driver.close();
  } catch {
    // уже закрыт
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Замер отказного пути: сама проверка бросает, время всё равно её. */
function measureRefusal(from: string, iters: number): number[] {
  const s: number[] = [];
  for (let i = 0; i < iters + 20; i++) {
    const t0 = performance.now();
    try {
      checkEdgeAcyclic(driver, "нет-такого-узла", "blocks", from);
    } catch {
      // отказ и есть измеряемый исход
    }
    if (i >= 20) s.push(performance.now() - t0);
  }
  return s.sort((a, b) => a - b);
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

test(`проверка ацикличности на графе ${N} узлов укладывается в бюджет записи (И1 ${WRITE_BUDGET_MS} мс)`, () => {
  const edges = (db.query("SELECT count(*) AS n FROM edges").get() as { n: number }).n;

  const measure = (from: string, iters: number): number[] => {
    for (let i = 0; i < 20; i++) checkEdgeAcyclic(driver, "нет-такого-узла", "blocks", from);
    const s: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      checkEdgeAcyclic(driver, "нет-такого-узла", "blocks", from);
      s.push(performance.now() - t0);
    }
    return s.sort((a, b) => a - b);
  };

  // Типичный случай: голова цепочки, достижимо CHAIN узлов.
  const chainSamples: number[] = [];
  for (let i = 0; i < 500; i++) {
    const from = heads[i % heads.length]!;
    const t0 = performance.now();
    checkEdgeAcyclic(driver, "нет-такого-узла", "blocks", from);
    chainSamples.push(performance.now() - t0);
  }
  chainSamples.sort((a, b) => a - b);

  // Худший случай: широкий узел, из которого достижимо HUB_FANOUT × CHAIN.
  // Он обязан упереться в бюджет обхода — иначе замер относился бы не к
  // тому, что защищает горячий путь.
  let hubRefusal: string | undefined;
  try {
    checkEdgeAcyclic(driver, "нет-такого-узла", "blocks", HUB);
  } catch (e) {
    hubRefusal = (e as { code?: string }).code;
  }
  const hub = measureRefusal(HUB, 100);

  console.log(
    `[§4.3 проверка blocks @${N} узлов/${edges} рёбер, цепочки по ${CHAIN}] ` +
      `цепочка (${CHAIN} достижимых): p50=${percentile(chainSamples, 50).toFixed(3)}ms ` +
      `p99=${percentile(chainSamples, 99).toFixed(3)}ms; ` +
      `хаб (${HUB_FANOUT * CHAIN} достижимых, бюджет обхода ${MAX_BLOCKS_REACH}): ` +
      `p50=${percentile(hub, 50).toFixed(3)}ms p99=${percentile(hub, 99).toFixed(3)}ms, отказ=${hubRefusal}`,
  );

  budgetCheck(percentile(chainSamples, 99), PROBE_BUDGET_MS, "цикл: цепочка, p99");
  // Широкий узел упирается в бюджет обхода — это отказ, а не молчаливый
  // пропуск, и он тоже обязан быть дешёвым.
  expect(hubRefusal).toBe("closure.depth");
  budgetCheck(percentile(hub, 99), PROBE_BUDGET_MS, "цикл: хаб, p99");
  budgetCheck(percentile(hub, 99), WRITE_BUDGET_MS, "цикл: хаб против бюджета записи, p99");
});

test(`вставка ребра blocks в графе ${N} узлов укладывается в бюджет записи (И1 ${WRITE_BUDGET_MS} мс)`, () => {
  // Каждая вставка — новое ребро в голову очередной цепочки: проверка цикла
  // на ней проходит всю цепочку, а не отсекается на первом шаге.
  const src: string[] = [];
  for (let i = 0; i < 220; i++) {
    src.push(store.createNode({ kind: "task", scope: "bench", title: `новый ${i}` }).id);
  }
  const samples: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const dst = heads[i % heads.length]!;
    const t0 = performance.now();
    store.addEdge(src[i]!, "blocks", dst);
    const dt = performance.now() - t0;
    if (i >= 20) samples.push(dt); // прогрев отбрасываем
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p99 = percentile(samples, 99);
  console.log(
    `[§4.3 addEdge blocks @${N} узлов] p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms (n=${samples.length})`,
  );
  budgetCheck(p99, WRITE_BUDGET_MS, "вставка ребра blocks, p99");
});
