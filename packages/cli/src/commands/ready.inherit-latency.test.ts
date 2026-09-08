/**
 * ЦЕНА НАСЛЕДОВАНИЯ БЛОКЕРОВ (миграция 10, memory-atcm254ry6c7).
 *
 * `ready` перестал отдавать задачу, у которой открытый блокер висит на предке
 * по `parent`. Вопрос был не «наследовать ли», а ЧЕМ: материализованным
 * счётчиком `nodes.anc_blockers`, который ведут триггеры, или подъёмом по
 * `parent_closure` на каждой выдаче.
 *
 * ЗДЕСЬ ИЗМЕРЕНЫ ОБА, и соперник взят ЧЕСТНЫЙ: не «обход без индекса»
 * (18–26 мс, соломенное чучело — так альтернативу никто бы не писал), а
 * лучшая её версия — прежняя схема 9 со СВОИМ частичным индексом
 * `ix_nodes_ready`, поверх которого стоит `NOT EXISTS (… parent_closure …)`.
 * Обе версии дают ОДИН И ТОТ ЖЕ ответ (проверено ниже), различие только в
 * механизме.
 *
 * ЧИСЛА на стенде 100 000 узлов / 4 000 открытых задач / 400 эпиков по 9
 * детей / 40 эпиков заблокировано (медиана трёх прогонов, свободная машина):
 *
 *   прежнее правило, наследования нет  — p50 10.68 мс (3 960 задач в очереди)
 *   наследование СЧЁТЧИКОМ             — p50  9.49 мс (3 600 задач)
 *   наследование ОБХОДОМ               — p50 14.13 мс (3 600 задач)
 *
 * То есть на чтении счётчик не стоит НИЧЕГО: он даже дешевле прежнего правила
 * (×0.89), потому что 360 скрытых задач не доходят до скоринга. Обход стоит
 * +32 % к прежней очереди (×1.49) — это не катастрофа, но цена растёт вместе
 * с числом кандидатов: `NOT EXISTS` выполняется для КАЖДОГО кандидата до
 * LIMIT, потому что очередь считает score всем и режет top-k уже после
 * сортировки. На узкой выдаче (фильтр репозитория S59, ~1/17 очереди) обход
 * стоит ×1.33 (0.85 против 0.64 мс), на широкой — ×1.49 и +4.6 мс, то есть
 * почти весь бюджет И1 целиком.
 *
 * ЧТО СЧЁТЧИК СТОИТ НА ЗАПИСИ — там, где материализация и платит. Блокировка
 * эпика раскладывает ±1 по всему поддереву одним UPDATE по `ix_pc_desc`:
 * лист 0.098 мс, 10 потомков 0.119, 100 — 0.277, 1 000 — 1.96 (бюджет записи
 * 5 мс), 5 000 — 9.37 мс, то есть мимо бюджета. Это тот же порог, на котором
 * design doc §риск 14 уже отправляет работу с `parent_closure` в `jobs`.
 * Линейность (а не квадратичность) этой цены здесь утверждается тестом.
 *
 * Методика — @myc/bench: три утверждения на замер, относительное главное,
 * абсолютное самое слабое. Абсолютный бюджет И1 живёт в соседнем
 * ready.repo-latency.test.ts — он меряет ту же очередь под фильтром
 * репозитория, и после миграции 10 его числа не изменились.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, HlcClock } from "@myc/core";
import {
  GraphStore,
  migrate,
  migrations,
  openSqlite,
  type SqliteDriver,
} from "@myc/store-sqlite";
import { expectAheadOfRival, expectCostAtMost, measure, report } from "@myc/bench";
import { readyQueries } from "./ready.ts";

const N = 100_000;
const SCOPE = "bench";
/** Эпик и девять его детей на каждые десять открытых задач. */
const GROUP = 10;
/** Каждый десятый эпик заблокирован. */
const BLOCK_EVERY = 10;

/**
 * Во сколько раз счётчик обязан опережать обход. Измерено ×1.49 на широкой
 * выдаче и ×1.33 на узкой; порог 1.20 лежит под обоими и отделяет
 * «материализация работает» от «материализации нет» (тогда отношение станет
 * ×1.0 или ниже). Обе половины меряются чередуясь, поэтому загрузка машины
 * из отношения уходит.
 */
const MIN_AHEAD = 1.2;
/**
 * Во сколько раз наследование имеет право быть ДОРОЖЕ прежней очереди без
 * него. Измерено ×0.89 (дешевле), порог 1.10 — запас на дрожание. Именно это
 * утверждение и есть ответ на «во что обошлось наследование».
 */
const MAX_COST = 1.1;
/**
 * Потолок отношения «блокировка эпика с 1 000 потомков против эпика со 100».
 * Линейная цена даёт ×7 (0.277 → 1.96 мс), квадратичная дала бы ×70.
 * Порог 20 отделяет одно от другого и не зависит от скорости машины.
 */
const MAX_FANOUT_RATIO = 20;

let dir: string;
let v10: Database;
let v9: Database;

const W = { pri: 0.4, unb: 0.27, fresh: 0.14, anch: 0.1, type: 0.09 };
type Args = [string, number, number, number, number, number, number, number];
const ARGS: Args = [SCOPE, W.pri, W.unb, W.fresh, W.anch, W.type, 10, Date.now()];

/** Очередь со счётчиком — ровно тот SQL, что исполняет команда. */
const SQL_COUNTER = readyQueries.ready_top_noanchors.sql;
/** Прежнее правило: наследования нет вовсе (схема 9). */
const SQL_OLD = SQL_COUNTER.replace(" AND n.anc_blockers = 0", "");
/** Честный соперник: прежний индекс схемы 9 плюс подъём по замыканию. */
const SQL_TRAVERSAL = SQL_OLD.replace(
  "n.open_blockers = 0",
  `n.open_blockers = 0 AND NOT EXISTS (
       SELECT 1 FROM parent_closure pc JOIN nodes a ON a.id = pc.ancestor
        WHERE pc.descendant = n.id AND a.open_blockers > 0)`,
);

/**
 * Один и тот же граф на двух схемах. Замыкание пишется напрямую: здесь
 * проверяется цена ЧТЕНИЯ очереди, путь записи держат closure.test.ts и
 * anc-blockers.test.ts (а его цену — последний тест этого файла).
 */
async function build(maxVersion: number): Promise<Database> {
  const db = new Database(join(dir, `v${maxVersion}.db`), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, {
    migrations: migrations.filter((m) => m.version <= maxVersion),
    writable: true,
  });
  const ins = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        open_blockers, content_hash, acl, team_id, salience, attrs,
                        created_at, updated_at)
     VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,'team','',1,?11,?12,?12)`,
  );
  db.exec("BEGIN");
  const opens: string[] = [];
  for (let i = 0; i < N; i++) {
    // 4 % — открытые незаблокированные задачи (окно частичного индекса), как
    // и в ready.repo-latency.test.ts: числа двух стендов сравнимы.
    const open = i % 25 === 0;
    const kind = i % 5 === 4 ? "note" : "task";
    const status = kind === "note" ? "active" : open ? "open" : "closed";
    const blockers = kind === "task" && !open && i % 5 === 3 ? 1 : 0;
    const title = `узел синтетического графа ${i}`;
    ins.run(
      `n${i}`,
      kind,
      SCOPE,
      title,
      `тело узла ${i}`,
      title.slice(0, 120),
      i % 4,
      status,
      blockers,
      `h-${i}`,
      JSON.stringify({ type: "task" }),
      1_700_000_000_000 + i,
    );
    if (open && kind === "task") opens.push(`n${i}`);
  }
  db.exec("COMMIT");

  db.exec("BEGIN");
  const pc = db.prepare(
    "INSERT INTO parent_closure (ancestor, descendant, depth) VALUES (?1, ?2, 1)",
  );
  const epics: string[] = [];
  for (let g = 0; g + GROUP <= opens.length; g += GROUP) {
    const epic = opens[g]!;
    epics.push(epic);
    for (let k = 1; k < GROUP; k++) pc.run(epic, opens[g + k]!);
  }
  db.exec("COMMIT");

  // Блокируем каждый десятый эпик. На схеме 10 счётчик поддерева разложат
  // триггеры — то есть данные обеих схем получены ОДНИМ И ТЕМ ЖЕ путём.
  db.exec("BEGIN");
  const blk = db.prepare("UPDATE nodes SET open_blockers = 1 WHERE id = ?1");
  for (let e = 0; e < epics.length; e += BLOCK_EVERY) blk.run(epics[e]!);
  db.exec("COMMIT");
  db.exec("ANALYZE");
  return db;
}

// Фикстура — ДВЕ базы по 100 000 узлов; на занятой машине их постройка не
// укладывается в умолчание bun (5 с). Тесты ниже уже стоят с 180 с, а хук
// оставался без своего — и падал именно он, унося за собой afterAll.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-anc-lat-"));
  v10 = await build(10);
  v9 = await build(9);
}, 180_000);

// Хук уборки обязан пережить незавершённый beforeAll: иначе одна медленная
// постройка даёт ВТОРОЕ падение — `undefined is not an object (v9.close)`, —
// и настоящая причина теряется за ним.
afterAll(() => {
  (v10 as Database | undefined)?.close();
  (v9 as Database | undefined)?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("наследование РАБОТАЕТ и совпадает с обходом задача в задачу", () => {
  const hidden = v10
    .query<{ n: number }, []>(
      `SELECT count(*) AS n FROM nodes
        WHERE kind='task' AND status='open' AND open_blockers=0 AND anc_blockers>0
          AND deleted_at IS NULL`,
    )
    .get()!;
  // 40 заблокированных эпиков × 9 детей: счётчик разложили триггеры, а не тест.
  expect(hidden.n).toBe(360);

  const all: Args = [SCOPE, W.pri, W.unb, W.fresh, W.anch, W.type, 50_000, Date.now()];
  const byCounter = v10
    .query<{ id: string }, Args>(SQL_COUNTER)
    .all(...all)
    .map((r) => r.id)
    .sort();
  const byTraversal = v9
    .query<{ id: string }, Args>(SQL_TRAVERSAL)
    .all(...all)
    .map((r) => r.id)
    .sort();
  const byOldRule = v9
    .query<{ id: string }, Args>(SQL_OLD)
    .all(...all)
    .map((r) => r.id);
  // Два механизма — один ответ. Иначе замер сравнивал бы разные запросы.
  expect(byCounter).toEqual(byTraversal);
  // И отсев настоящий: прежнее правило отдавало ровно на 360 задач больше.
  expect(byOldRule.length - byCounter.length).toBe(360);
});

test("план: счётчик остаётся одним сканом ix_nodes_ready, обход добавляет спуск", () => {
  const plan = (db: Database, sql: string): string[] =>
    db
      .query<{ detail: string }, Args>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...ARGS)
      .map((r) => r.detail);

  const healthy = plan(v10, SQL_COUNTER);
  expect(healthy.join(" | ")).toMatch(/USING INDEX ix_nodes_ready\b/);
  expect(healthy.filter((d) => /SCAN nodes/.test(d))).toEqual([]);

  // Соперник тоже на индексе — иначе это было бы чучело, а не альтернатива.
  const rival = plan(v9, SQL_TRAVERSAL);
  expect(rival.join(" | ")).toMatch(/USING INDEX ix_nodes_ready\b/);
  // Но у него есть то, чего нет у счётчика: спуск по замыканию на кандидата.
  expect(rival.join(" | ")).toMatch(/ix_pc_desc/);
  expect(healthy.join(" | ")).not.toMatch(/ix_pc_desc/);
});

test("счётчик против обхода по parent_closure: главное относительное утверждение", () => {
  const q = v10.query<Record<string, unknown>, Args>(SQL_COUNTER);
  const rival = v9.query<Record<string, unknown>, Args>(SQL_TRAVERSAL);
  const m = measure(
    `наследование @${N}: счётчик против обхода`,
    () => void q.all(...ARGS),
    {
      warmup: 10,
      iters: 40,
      rival: () => void rival.all(...ARGS),
      rivalLabel: "подъём по parent_closure на каждой выдаче",
    },
  );
  report(m);
  expectAheadOfRival(m, MIN_AHEAD);
}, 180_000);

test("цена самого наследования: очередь не стала дороже прежней", () => {
  const q = v10.query<Record<string, unknown>, Args>(SQL_COUNTER);
  const before = v9.query<Record<string, unknown>, Args>(SQL_OLD);
  const m = measure(
    `наследование @${N}: против прежнего правила`,
    () => void q.all(...ARGS),
    {
      warmup: 10,
      iters: 40,
      rival: () => void before.all(...ARGS),
      rivalLabel: "прежнее правило, наследования нет",
    },
  );
  report(m);
  expectCostAtMost(m, MAX_COST);
}, 180_000);

test("цена НА ЗАПИСИ линейна по размеру поддерева, а не квадратична", async () => {
  const wdir = mkdtempSync(join(tmpdir(), "myc-anc-write-"));
  const driver: SqliteDriver = openSqlite(join(wdir, "myc.db"));
  try {
    driver.database.exec("PRAGMA journal_mode = WAL");
    await migrate(driver.database, { migrations, writable: true });
    let t = 1_700_000_000_000;
    const store = new GraphStore(driver, {
      siteId: "bench",
      actor: "bench",
      newId: () => generateId(),
      clock: new HlcClock({ now: () => (t += 1) }),
    });
    const mk = (title: string): string =>
      store.createNode({ kind: "task", scope: SCOPE, title }).id;
    const epicWith = (n: number): string => {
      const root = mk(`эпик-${n}`);
      for (let i = 0; i < n; i++) store.addEdge(mk(`k${n}-${i}`), "parent", root);
      return root;
    };
    const small = epicWith(100);
    const big = epicWith(1000);

    const timeBlock = (root: string, tag: string): number => {
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        const b = mk(`b-${tag}-${i}`);
        const t0 = performance.now();
        store.addEdge(b, "blocks", root);
        samples.push(performance.now() - t0);
        store.removeEdge(b, "blocks", root);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)]!;
    };
    // Чередуясь: соседний процесс не должен достаться одному из двух.
    const p100: number[] = [];
    const p1000: number[] = [];
    for (let r = 0; r < 3; r++) {
      p100.push(timeBlock(small, `s${r}`));
      p1000.push(timeBlock(big, `b${r}`));
    }
    p100.sort((a, b) => a - b);
    p1000.sort((a, b) => a - b);
    const med100 = p100[1]!;
    const med1000 = p1000[1]!;
    const ratio = med1000 / med100;
    console.log(
      `[bench] блокировка эпика: 100 потомков p50=${med100.toFixed(3)} мс, ` +
        `1000 потомков p50=${med1000.toFixed(3)} мс → ×${ratio.toFixed(2)} ` +
        `(линейно ≈×7, квадратично было бы ≈×70)`,
    );
    expect(ratio).toBeLessThan(MAX_FANOUT_RATIO);
    // И счётчик действительно разложился по ВСЕМУ поддереву, а не по части.
    store.addEdge(mk("финальный блокер"), "blocks", big);
    const spread = driver.database
      .query<{ n: number }, []>("SELECT count(*) AS n FROM nodes WHERE anc_blockers > 0")
      .get()!;
    expect(spread.n).toBe(1000);
  } finally {
    driver.close();
    rmSync(wdir, { recursive: true, force: true });
  }
}, 180_000);
