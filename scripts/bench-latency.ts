#!/usr/bin/env bun
/**
 * Бюджеты латентности (И1, ARCHITECTURE.md §2 и §10) как тест CI.
 *
 * Меряет пять операций горячего пути ПРЯМЫМИ вызовами библиотек (не через
 * подпроцесс — иначе шум спавна процесса ~10-30 мс съел бы весь бюджет
 * точечного чтения/записи ещё до полезной работы):
 *
 *   prime        — скан ix_nodes_prime (L2+L3) + до 12 якорей + до 8 задач
 *                  ready + сериализация. Ровно то же разбиение стоимости,
 *                  что в docs/design/01-core-data-model.md:1731.
 *   read         — GraphStore.getNode(id): точечное чтение по PK.
 *   search       — hybridSearch (@myc/retrieval) с vectorMode: "never" на
 *                  100k узлах. Бюджет 25 мс — это лексика+граф (решение
 *                  S31/S32: цена самого вектора запроса считается отдельно
 *                  и условна; безусловный пол латентности — то, что здесь
 *                  меряется).
 *   write        — GraphStore.createNode(): полный путь записи с журналом
 *                  оплога (решение S35 — почему это дёшево при
 *                  wal_autocheckpoint=0).
 *   cold_start    — bun run scripts/coldstart.ts (спавн процесса `myc --version`).
 *
 * Методика воспроизводимости: прогрев (WARMUP итераций отбрасывается),
 * фиксированное число замеров (ITERS), медиана + p95 + p99. Один прогон на
 * шумной машине — не замер: красная сборка от лотереи хуже отсутствия
 * проверки, поэтому регрессия сравнивается по p95 с порогом REGRESSION_PCT.
 *
 * Базовая линия — bench/baseline.json, в репозитории. Обновляется явно:
 *   bun run bench:latency:update-baseline
 * Обычный прогон (`bun run bench:latency`) базовую линию не трогает.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, historyClause, type Layer } from "@myc/core";
import { openSqlite, migrate, migrations, GraphStore, type SqliteDriver } from "@myc/store-sqlite";
import { hybridSearch, type FtsCaller } from "@myc/retrieval";
import {
  JITTER_MAX,
  absoluteEnabled,
  isStrict,
  machine,
  measure,
  measureAsync,
  percentile as guardPercentile,
} from "@myc/bench";
import { buildBinary } from "./build.ts";

// --------------------------------------------------------------------------
// Бюджеты И1 (docs/design/00-brief.md §3, ARCHITECTURE.md §2)
// --------------------------------------------------------------------------

export interface Budget {
  readonly p99Ms: number;
}

export const BUDGETS: Record<string, Budget> = {
  prime: { p99Ms: 30 },
  read: { p99Ms: 3 },
  search: { p99Ms: 25 },
  write: { p99Ms: 5 },
  cold_start: { p99Ms: 60 },
};

export const REGRESSION_PCT = 15;

/**
 * ПО КАКОМУ ПЕРЦЕНТИЛЮ сравнивать с базовой линией. По умолчанию p95 — он
 * ловит хвост, ради которого бюджеты и заводились.
 *
 * `cold_start` — исключение, и не из удобства. Он единственный меряется
 * СПАВНОМ ПРОЦЕССА, всего 25 раз, и потому ловит всё, что делает машина
 * рядом: на неизменном бинаре три прогона подряд дали p50 24.07 / 23.97 /
 * 25.23 мс (разброс 1.3) при p95 27.27 / 31.36 / 30.99 (разброс 4.1) и p99
 * 29.71 / 38.49 / 53.98 (разброс 24). p95 на 25 замерах — это 24-й элемент,
 * то есть один сосед по CPU; p99 — просто максимум. Сравнивать линию по
 * такому числу значит ронять сборку жребием, а это хуже отсутствия проверки
 * (та же логика, что у абсолютного пола ниже). Хвост при этом не теряется:
 * p95 и p99 печатаются всегда, и бюджет И1 (p99 < 60 мс) по-прежнему
 * проверяется по p99.
 */
export const REGRESSION_METRIC: Record<string, "p50" | "p95"> = {
  cold_start: "p50",
};

function metricFor(op: string): "p50" | "p95" {
  return REGRESSION_METRIC[op] ?? "p95";
}
const BASELINE_PATH = join(import.meta.dir, "..", "bench", "baseline.json");

const SCOPE = "bench";
const TEAM = "bench-team";
const CALLER: FtsCaller = { ownerId: "", teamId: TEAM, agentId: "", principals: [] };
const N_NODES = 100_000;
const QUERY_TERM = "budget";

// --------------------------------------------------------------------------
// Статистика
// --------------------------------------------------------------------------

export interface Stats {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export const percentile = guardPercentile;

/** Замер вместе с условием, при котором он получен (дрожание эталона). */
export interface Timed extends Stats {
  /** худшее ref.p99/ref.p50 по трейлам; больше JITTER_MAX — машина была занята */
  readonly jitter: number;
}

export function summarize(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * Медиана из нескольких независимых прогонов, а не один прогон — так, как
 * того требует приёмка. Один трейл может словить локальный шум (GC-пауза,
 * соседний процесс на CPU); TRIALS независимых прогонов дают устойчивую
 * оценку p50/p95/p99 через медиану по трейлам, а не через один расчёт
 * перцентиля по одному набору сэмплов.
 *
 * Каждый трейл меряется через @myc/bench (packages/bench/src/index.ts), то есть ЧЕРЕДУЯСЬ с
 * эталонной чисто процессорной работой той же длительности. Из трейлов
 * берётся не только медиана перцентилей, но и ХУДШЕЕ дрожание эталона — это
 * и есть записываемое условие замера: во сколько раз машина в это время
 * растягивала заведомо ровную работу.
 */
function benchTrials(trials: number, warmup: number, iters: number, fn: () => void): Timed {
  const m = measure("trial", fn, { warmup, iters, trials });
  return { ...m.stats, jitter: m.jitter };
}

// --------------------------------------------------------------------------
// Оснастка: воркспейс со 100k узлов
// --------------------------------------------------------------------------

interface Bed {
  readonly dir: string;
  readonly driver: SqliteDriver;
  readonly store: GraphStore;
  readonly primeIds: readonly string[]; // существующие L2/L3 id для чтения
  cleanup(): void;
}

async function makeBed(): Promise<Bed> {
  const dir = mkdtempSync(join(tmpdir(), "myc-bench-"));
  const dbPath = join(dir, "myc.db");
  const driver = openSqlite(dbPath);
  await migrate(driver.database, { migrations, writable: true });

  seedNodes(driver, N_NODES);
  seedAnchorsAndTasks(driver);
  driver.database.exec("ANALYZE");

  const primeIds = driver.database
    .query<{ id: string }, []>(
      `SELECT id FROM nodes WHERE layer >= 2${historyClause("follow", "nodes")} AND deleted_at IS NULL LIMIT 200`,
    )
    .all()
    .map((r) => r.id);

  const store = new GraphStore(driver, {
    siteId: "bench-site",
    actor: "bench",
    newId: () => generateId(),
  });

  return {
    dir,
    driver,
    store,
    primeIds,
    cleanup(): void {
      try {
        driver.close();
      } catch {
        // уже закрыто
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Прямой INSERT в одной транзакции — тест мерит просмотр/чтение/поиск, а не
 * движок записи (тот же приём, что в packages/web/src/harness.ts).
 */
function seedNodes(driver: SqliteDriver, n: number): void {
  const ins = driver.database.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority,
                        status, content_hash, acl, owner_id, team_id, agent_id,
                        salience, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, 'team', '', ?10, '',
             ?11, ?12, ?12, NULL)`,
  );
  const insEdge = driver.database.prepare(
    `INSERT OR IGNORE INTO edges (src, type, dst, add_tag, actor, created_at)
     VALUES (?1, 'relates', ?2, '', 'bench', ?3)`,
  );
  const kinds = ["task", "note", "doc", "fragment", "entity"] as const;
  const now = Date.now();

  driver.database.exec("BEGIN");
  const ids: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const id = generateId();
    ids[i] = id;
    // Пирамида слоёв: большинство узлов L0/L1, малая доля L2/L3 — реалистичное
    // распределение, на котором ix_nodes_prime реально фильтрует, а не сканит всё.
    const layer: Layer = i < n * 0.002 ? 3 : i < n * 0.01 ? 2 : i < n * 0.4 ? 1 : 0;
    const kind = kinds[i % kinds.length]!;
    // Каждый 20-й узел содержит терм запроса — даёт непустую, но не всеобъемлющую
    // лексическую выдачу для гибридного поиска.
    const hasTerm = i % 20 === 0;
    const title = hasTerm ? `latency ${QUERY_TERM} review ${i}` : `узел синтетического графа ${i}`;
    const body = hasTerm
      ? `Обсуждение latency ${QUERY_TERM}: p99 должен укладываться в бюджет на 100k узлов.`
      : `Синтетическое тело узла номер ${i} для нагрузочного набора бенчмарка.`;
    ins.run(id, kind, layer, SCOPE, title, body, title.slice(0, 120), (i % 4), `bench-${id}`, TEAM, 1.0 - (i % 100) / 100, now);
    if (i > 0 && i % 3 === 0) insEdge.run(ids[i - 1]!, id, now);
  }
  driver.database.exec("COMMIT");
}

function seedAnchorsAndTasks(driver: SqliteDriver): void {
  const now = Date.now();
  const anchorNodeIds: string[] = [];
  const insTaskNode = driver.database.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority,
                        status, open_blockers, content_hash, acl, owner_id, team_id,
                        agent_id, created_at, updated_at)
     VALUES (?1, 'task', 1, ?2, ?3, '', ?3, 1, 'open', 0, ?4, 'team', '', ?5, '', ?6, ?6)`,
  );
  driver.database.exec("BEGIN");
  for (let i = 0; i < 8; i++) {
    const id = generateId();
    insTaskNode.run(id, SCOPE, `открытая задача ${i}`, `bench-task-${id}`, TEAM, now);
  }
  const insAnchorNode = driver.database.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority,
                        status, content_hash, acl, owner_id, team_id, agent_id,
                        created_at, updated_at)
     VALUES (?1, 'anchor', 1, ?2, ?3, '', ?3, 2, 'active', ?4, 'team', '', ?5, '', ?6, ?6)`,
  );
  const insAnchor = driver.database.prepare(
    `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash,
                          span_hash, crux, crux_norm, state, bound_at)
     VALUES (?1, 'bench-repo', ?2, 1, 5, 'h', 'h', 'c', 'c', 'fresh', ?3)`,
  );
  for (let i = 0; i < 12; i++) {
    const id = generateId();
    insAnchorNode.run(id, SCOPE, `якорь ${i}`, `bench-anchor-${id}`, TEAM, now);
    insAnchor.run(id, `bench/file-${i}.ts`, now);
    anchorNodeIds.push(id);
  }
  driver.database.exec("COMMIT");
}

// --------------------------------------------------------------------------
// Операции горячего пути
// --------------------------------------------------------------------------

/**
 * `myc prime`: 1 скан ix_nodes_prime (L2+L3, до 88 строк) + до 12 якорей +
 * до 8 открытых задач через ix_nodes_ready + сериализация JSON.
 * docs/design/01-core-data-model.md:1731.
 *
 * `INDEXED BY` обязателен: без него планировщик на этой синтетической базе
 * (все узлы в одном scope) выбирает ix_nodes_kind_upd вместо ix_nodes_prime
 * — тот тоже начинается с scope, но не покрывает layer/salience, и
 * добавляет TEMP B-TREE сортировку. Проверено EXPLAIN QUERY PLAN: без
 * форсирования индекса скан стоит ~3.5 мс на 100k строк вместо ~0.3 мс —
 * тот же паттерн, что и в SQLite tail-query (миграция ix уже задаёт
 * порядок, но планировщик об этом не знает без ANALYZE/подсказки).
 */
function primeOp(driver: SqliteDriver): void {
  const l2l3 = driver.database
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM nodes INDEXED BY ix_nodes_prime
        WHERE scope=? AND layer >= 2${historyClause("follow", "nodes")} AND deleted_at IS NULL
        ORDER BY layer DESC, salience DESC LIMIT 88`,
    )
    .all(SCOPE);
  const anchors = driver.database
    .query<Record<string, unknown>, []>("SELECT * FROM anchors ORDER BY bound_at DESC LIMIT 12")
    .all();
  const ready = driver.database
    .query<Record<string, unknown>, [string]>(
      // `anc_blockers = 0` — не украшение: с миграции 010 частичный индекс
      // ix_nodes_ready включает это условие, и запрос без него ПОД ИНДЕКС НЕ
      // ПОДХОДИТ — SQLite отвечает «no query solution», а не выбирает другой
      // план, потому что индекс здесь навязан через INDEXED BY. Замер горячего
      // пути обязан повторять условия настоящего `ready`
      // (packages/cli/src/commands/ready.ts), иначе он мерит не то.
      `SELECT * FROM nodes INDEXED BY ix_nodes_ready
        WHERE scope=? AND priority >= 0 AND kind='task' AND status='open'
          AND open_blockers=0 AND anc_blockers=0 AND deleted_at IS NULL
        ORDER BY priority DESC, updated_at DESC LIMIT 8`,
    )
    .all(SCOPE);
  JSON.stringify({ l2l3, anchors, ready });
}

function readOp(store: GraphStore, ids: readonly string[], i: number): void {
  store.getNode(ids[i % ids.length]!);
}

function searchOp(driver: SqliteDriver): void {
  hybridSearch(driver, {
    text: QUERY_TERM,
    scopes: [SCOPE],
    caller: CALLER,
    limit: 12,
    vectorMode: "never", // S31/S32: цена вектора запроса считается отдельно
  });
}

function writeOp(store: GraphStore, i: number): void {
  store.createNode({
    kind: "note",
    scope: SCOPE,
    title: `bench write ${i} ${generateId()}`,
    body: "узел, созданный бенчмарком записи",
    acl: "team",
    team_id: TEAM,
  });
}

/**
 * Спавнит бинарь напрямую (как scripts/coldstart.ts), а не через `bun run
 * coldstart.ts`: обёртка в ещё один `bun run` добавила бы запуск самого bun
 * (~300 мс на этой машине) поверх измеряемого спавна `myc --version`, что
 * не имеет отношения к бюджету холодного старта продукта.
 *
 * БИНАРЬ СОБИРАЕТСЯ ЗДЕСЬ ЖЕ, а не берётся готовым. Раньше мерился любой
 * `dist/myc`, какой лежал на диске, — и трое суток мерился собранный вручную,
 * без `--bytecode`: на ~12 мс медленнее того, что даёт `bun run build`
 * (35.7 против 24.1 мс p50). Базовая линия «уехала» с 19 до 35 мс, и причину
 * искали в reindex, в новой команде `move` и в шуме хоста — то есть в коде,
 * которого сдвиг не касался. Сборка стоит 0.3 с и снимает целый класс таких
 * расследований: мерится ровно то, что собирает scripts/build.ts.
 */
async function coldStartOp(): Promise<Timed> {
  const binary = join(import.meta.dir, "..", "dist", "myc");
  console.log("cold_start: пересборка dist/myc рецептом scripts/build.ts…");
  await buildBinary({ quiet: true });
  const file = Bun.file(binary);
  if (!(await file.exists())) {
    throw new Error(`${binary} не собрался`);
  }
  const spawnOnce = async (): Promise<void> => {
    const proc = Bun.spawn([binary, "--version"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  };
  // Через measureAsync — чтобы у холодного старта тоже было записано условие
  // замера: эталон крутится МЕЖДУ спавнами, не отбирая процессор у измеряемого.
  // trials: 1 — 25 спавнов процесса уже стоят секунды, и трейлы здесь платятся
  // временем сборки, а не точностью; хвост cold_start и без того сравнивается
  // по p50 (см. REGRESSION_METRIC).
  const m = await measureAsync("cold_start", spawnOnce, { warmup: 3, iters: 25, trials: 1 });
  return { ...m.stats, jitter: m.jitter };
}

// --------------------------------------------------------------------------
// Baseline + отчёт
// --------------------------------------------------------------------------

export interface BaselineEntry {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly updated_at: string;
  /**
   * УСЛОВИЯ ЗАМЕРА. Без них линия — число без условий: та же сборка на load 4.6
   * и на load 7.5 даёт разный холодный старт, и через сутки уже не
   * восстановить, во что упёрлось расхождение. Ровно на этом сгорело
   * расследование memory-21w8b5x63acn.
   *
   * Отпечаток машины (платформа-архитектура-ядра) — это КЛЮЧ секции файла, а
   * не поле записи: 15 % от числа, снятого на другой машине, не значат ничего,
   * и сравнение с чужой секцией не проводится вовсе.
   * `jitter` — во сколько раз машина растягивала эталонную работу в момент
   * снятия (@myc/bench (packages/bench/src/index.ts)). Линия, снятая при дрожании ×10, — не
   * линия, и это видно прямо в файле.
   */
  readonly load1?: number;
  readonly cpus?: number;
  readonly jitter?: number;
  /** зачем линия сдвинута — для операций, где числа изменились не сами по себе */
  readonly note?: string;
}

/** Секция базовой линии ОДНОЙ машины: операция → числа с условиями. */
export type Baseline = Record<string, BaselineEntry>;

/**
 * Файл базовой линии разложен ПО МАШИНАМ (`machineId()`), а не по операциям.
 * Причина простая: 15 % от числа, снятого на другом железе, не значат ничего.
 * Плоский файл заставлял выбирать между «сравнивать несравнимое» и «выкинуть
 * проверку»; разложенный по машинам позволяет держать линию ноутбука
 * разработчика и линию раннера рядом, и каждая сравнивается со своей.
 * Секции для текущей машины нет — сравнение просто не проводится, и это
 * сказано вслух, а не подразумевается.
 */
export type BaselineFile = Record<string, Baseline>;

function readBaselineFile(): BaselineFile {
  if (!existsSync(BASELINE_PATH)) return {};
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;
  // Плоский файл старого формата (операция → числа) распознаётся по числовому
  // p50 у значения. Такая линия снята неизвестно на чём и не сравнивается ни
  // с чем: сохраняем её под именем машины "неизвестная".
  const flat = Object.values(raw).some(
    (v) => typeof v === "object" && v !== null && typeof (v as { p50?: unknown }).p50 === "number",
  );
  return flat ? { "неизвестная-машина": raw as Baseline } : (raw as BaselineFile);
}

function writeBaselineFile(file: BaselineFile): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

export interface Verdict {
  readonly op: string;
  readonly stats: Timed;
  readonly budgetMs: number;
  readonly budgetOk: boolean;
  /** годны ли условия замера для абсолютного утверждения */
  readonly quiet: boolean;
  /** перцентиль, по которому сравнивается эта операция — см. REGRESSION_METRIC */
  readonly metric: "p50" | "p95";
  readonly baselineValue: number | null;
  readonly currentValue: number;
  readonly regressionPct: number | null;
  readonly regressionOk: boolean;
}

/** Отпечаток машины: сравнивать линии, снятые на разном железе, бессмысленно. */
export function machineId(): string {
  return `${platform()}-${arch()}-${cpus().length}`;
}

export function judge(op: string, stats: Timed, baseline: Baseline): Verdict {
  const budgetMs = BUDGETS[op]!.p99Ms;
  const budgetOk = stats.p99 <= budgetMs;
  const prior = baseline[op];
  const metric = metricFor(op);
  const quiet = stats.jitter <= JITTER_MAX;
  const baselineValue = prior?.[metric] ?? null;
  const currentValue = stats[metric];
  const regressionPct =
    baselineValue !== null ? ((currentValue - baselineValue) / baselineValue) * 100 : null;
  // Абсолютный пол на регрессию: на операциях с базовой линией в доли мс (prime,
  // read на этой синтетике — за пределы бюджета не выходят на порядки) шум
  // планировщика/GC даёт огромный процентный скачок при ничтожной абсолютной
  // разнице. Порог 15% применяется только когда абсолютный прирост
  // существен — не меньше 5% бюджета операции. Иначе красная сборка от
  // лотереи: именно то, чего приёмка требует избежать.
  const absDeltaMs = baselineValue !== null ? currentValue - baselineValue : null;
  const absFloorMs = budgetMs * 0.05;
  const regressionOk =
    regressionPct === null || regressionPct <= REGRESSION_PCT || (absDeltaMs !== null && absDeltaMs < absFloorMs);
  return {
    op,
    stats,
    budgetMs,
    budgetOk,
    quiet,
    metric,
    baselineValue,
    currentValue,
    regressionPct,
    regressionOk,
  };
}

function fmt(n: number): string {
  return n.toFixed(3);
}

/** Роняет ли этот вердикт прогон. Разбор — в комментарии к `main`. */
export function fails(v: Verdict, updateBaseline: boolean): boolean {
  // `absoluteEnabled()` — та же калибровка, что в `bun test`: на общем раннере
  // (4 ядра x86 против 14 arm64, на которых сняты бюджеты) абсолют роняет
  // сборку за то, что машина другая, а не за то, что код медленнее. Регрессия
  // к СВОЕЙ секции baseline при этом остаётся обязательной — она сравнивает
  // раннер с раннером, и калибровка ей не нужна.
  const budgetFails = !v.budgetOk && (v.quiet || isStrict()) && (absoluteEnabled() || isStrict());
  return budgetFails || (!updateBaseline && !v.regressionOk);
}

function printVerdict(v: Verdict, updateBaseline: boolean): void {
  const status = fails(v, updateBaseline) ? "FAIL" : v.budgetOk ? "OK" : "УСЛОВНО";
  console.log(
    `[${status}] ${v.op}: p50=${fmt(v.stats.p50)}ms p95=${fmt(v.stats.p95)}ms p99=${fmt(v.stats.p99)}ms ` +
      `(budget p99<${v.budgetMs}ms) n=${v.stats.n} · дрожание эталона ×${v.stats.jitter.toFixed(2)}`,
  );
  if (!v.budgetOk) {
    const over = (((v.stats.p99 - v.budgetMs) / v.budgetMs) * 100).toFixed(1);
    console.log(
      `       БЮДЖЕТ НАРУШЕН: p99 ${fmt(v.stats.p99)}ms > ${v.budgetMs}ms (+${over}%)` +
        (v.quiet || isStrict()
          ? ""
          : ` — НЕДОСТОВЕРНО: дрожание эталона ×${v.stats.jitter.toFixed(2)} выше ${JITTER_MAX},` +
            " машина была занята; замер не роняет прогон, но и ничего не доказывает"),
    );
  }
  if (v.baselineValue !== null) {
    const sign = (v.regressionPct ?? 0) >= 0 ? "+" : "";
    console.log(
      `       baseline ${v.metric}=${fmt(v.baselineValue)}ms → сейчас ${fmt(v.currentValue)}ms (${sign}${(v.regressionPct ?? 0).toFixed(1)}%, порог ${REGRESSION_PCT}%)`,
    );
    if (!v.regressionOk) {
      const note = updateBaseline ? " (не роняет сборку — базовая линия обновляется явно)" : "";
      console.log(
        `       РЕГРЕССИЯ: ${v.metric} вырос больше чем на ${REGRESSION_PCT}% относительно базовой линии${note}`,
      );
    }
  } else {
    console.log(
      "       нет базовой линии для этой операции НА ЭТОЙ МАШИНЕ" +
        " (снять: bun run bench:latency:update-baseline)",
    );
  }
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const updateBaseline = process.argv.includes("--update-baseline");
  const TRIALS = 5;
  const WARMUP = 20;
  const ITERS = 150;

  console.log(
    `myc: бюджеты латентности (И1) — ${N_NODES.toLocaleString("ru-RU")} узлов, ${TRIALS} трейлов × (warmup=${WARMUP} iters=${ITERS})`,
  );
  // Условия прогона в первой же строке: сравнивать числа, снятые при разной
  // загрузке машины, нельзя, а узнать её задним числом невозможно.
  const mach = machine();
  console.log(
    `машина: ${machineId()}, load ${loadavg().map((n) => n.toFixed(2)).join(" ")}` +
      `${isStrict() ? " · СТРОГИЙ режим: абсолютные бюджеты обязательны при любых условиях" : ""}`,
  );
  void mach;
  const bed = await makeBed();
  const results: Record<string, Timed> = {};
  try {
    results.prime = benchTrials(TRIALS, WARMUP, ITERS, () => primeOp(bed.driver));
    results.read = benchTrials(TRIALS, WARMUP, ITERS, (() => {
      let i = 0;
      return () => readOp(bed.store, bed.primeIds.length > 0 ? bed.primeIds : [bed.primeIds[0] ?? ""], i++);
    })());
    results.search = benchTrials(TRIALS, WARMUP, ITERS, () => searchOp(bed.driver));
    results.write = benchTrials(3, 15, 100, (() => {
      let i = 0;
      return () => writeOp(bed.store, i++);
    })());
  } finally {
    bed.cleanup();
  }
  results.cold_start = await coldStartOp();

  const file = readBaselineFile();
  const mine = machineId();
  const baseline = file[mine] ?? {};
  if (Object.keys(baseline).length === 0) {
    console.log(
      `\nбазовой линии для машины ${mine} нет — сравнение не проводится.` +
        ` В файле есть линии: ${Object.keys(file).join(", ") || "(пусто)"}.` +
        " Снять свою: bun run bench:latency:update-baseline --note=\"зачем\"",
    );
  }
  const verdicts = Object.entries(results).map(([op, stats]) => judge(op, stats, baseline));

  console.log("");
  for (const v of verdicts) printVerdict(v, updateBaseline);

  if (updateBaseline) {
    const next: Baseline = { ...baseline };
    // Секции ДРУГИХ машин не трогаются: линия раннера не должна исчезать
    // оттого, что кто-то снял свою на ноутбуке.
    const now = new Date().toISOString();
    const noteArg = process.argv.find((a) => a.startsWith("--note="));
    const note = noteArg?.slice("--note=".length);
    const load1 = Number(loadavg()[0]!.toFixed(2));
    for (const [op, stats] of Object.entries(results)) {
      next[op] = {
        p50: stats.p50,
        p95: stats.p95,
        p99: stats.p99,
        updated_at: now,
        load1,
        cpus: cpus().length,
        jitter: Number(stats.jitter.toFixed(3)),
        ...(note !== undefined ? { note } : {}),
      };
    }
    writeBaselineFile({ ...file, [mine]: next });
    console.log(`\nбазовая линия машины ${mine} обновлена: ${BASELINE_PATH}`);
  }

  // При явном обновлении базовой линии регрессия к СТАРОЙ линии не повод
  // падать — вы её и обновляете затем, чтобы принять новые числа как норму.
  // Бюджет И1 — другое дело: он не про baseline, а про инвариант, обновление
  // базовой линии его нарушение не извиняет.
  const failed = verdicts.filter((v) => fails(v, updateBaseline));
  if (failed.length > 0) {
    console.log(`\n${failed.length} операций нарушают бюджет или регрессировали: ${failed.map((v) => v.op).join(", ")}`);
    process.exit(1);
  }
  console.log("\nвсе бюджеты латентности в норме.");
}

if (import.meta.main) {
  await main();
}
