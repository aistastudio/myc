/**
 * Бюджеты якорей — два, и они про разные вещи.
 *
 * 1. ЗАПРОС ПО ПОЗИЦИИ (memory-3afmdwe7bwyp, приёмка дословно: 50 000 якорей,
 *    ответ меньше чем за 1 мс). Стенд — 50 000 якорей по 2 000 файлам в 7
 *    репозиториях; соперник — тот же запрос с `NOT INDEXED`, то есть ровно
 *    «ix_anchors_file потеряли».
 *
 * 2. ЦЕНА ХУКА post-edit (memory-rw885z6nvatt: пометить и выйти меньше чем за
 *    2 мс). Соперник — «хук пишет в базу»: открыть соединение, поставить
 *    работу в jobs, закрыть. Это не выдуманный соперник, а самый вероятный
 *    способ написать эту команду, и разница между ним и дозаписью в журнал —
 *    единственное, что удерживает хук в бюджете записи (И1, 5 мс).
 *
 * Методика — @myc/bench: абсолютный бюджет утверждается только при годных
 * условиях, преимущество над соперником — всегда, потому что загрузка машины
 * растягивает обе половины чередующегося замера одинаково.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectAheadOfRival, expectWithinBudget, measure, report } from "@myc/bench";
import { jobs, migrate, migrations } from "@myc/store-sqlite";
import { queryAnchorsAt, SQL_OF_LINE } from "./anchor.ts";

const N = 50_000;
const FILES = 2_000;
const REPOS = 7;
const REPO = "repo1";
const PATH = "src/pkg1/file1.ts";
const LINE = 30;

/**
 * Бюджет приёмки: 1 мс на запрос по позиции при 50 000 якорей. Замеры на этом
 * стенде (2000 итераций, три прогона):
 *   ix_anchors_file (repo_id=, path=, span_start<)  p50 0.004  p99 0.013 мс;
 *   МУТАЦИЯ «индекс потеряли» (NOT INDEXED, SCAN)   p50 1.32   p99 27.6  мс.
 * Здоровый план лежит на два порядка ниже бюджета, мутант — выше него уже по
 * p50. Порог поставлен по приёмке, а не по замеру: он обязан ловить именно
 * потерю индекса, а не дрожание машины.
 */
const OF_BUDGET_MS = 1;

/**
 * Во сколько раз здоровый план обязан опережать скан. Измерено ×307 по p50.
 * Порог 20 — с запасом в полтора порядка: он не различает 300× и 400×, но
 * отделяет индексный поиск от скана таблицы при любой загрузке машины.
 */
const OF_MIN_SLOWDOWN = 20;

/**
 * Бюджет хука. Задача требует «меньше чем за 2 мс», И1 даёт записи 5 мс.
 * Замеры (500 настоящих процессов собранного бинаря, число печатает сама
 * команда): p50 0.176, p95 0.217, p99 0.252, max 2.547 мс — в бюджете и по
 * p99, и по одиночному худшему случаю.
 */
const TOUCH_BUDGET_MS = 2;

/**
 * Насколько дозапись в журнал обязана опережать запись в базу. Измерено
 * в одном процессе, 500 вызовов подряд:
 *   открыть базу + jobs.enqueue + закрыть  p50 1.045  p99 19.511  max 37.219 мс
 *   appendFileSync в журнал                p50 0.023  p99  0.123  max 12.702 мс
 * Отношение по p50 — ×45. Порог 5 отделяет «журнал» от «база» и оставляет
 * запас на машину, где открытие соединения дешевле обычного.
 */
const TOUCH_MIN_SLOWDOWN = 5;

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-anchor-lat-"));
  mkdirSync(join(dir, ".myc"));
  db = new Database(join(dir, ".myc", "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });

  const insNode = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, excerpt, status, content_hash,
                        acl, team_id, created_at, updated_at)
     VALUES (?1,'anchor',1,'bench',?2,?2,'fresh',?3,'team','',1,1)`,
  );
  const insAnchor = db.prepare(
    `INSERT INTO anchors (node_id, repo_id, repo_root, path, lang, symbol, span_start, span_end,
                          file_hash, span_hash, crux, crux_norm, state, drift, mtime_ms,
                          size_bytes, bound_at, checked_at)
     VALUES (?1,?2,'/r',?3,'ts','',?4,?5,'h','h','c','c','fresh',1.0,1,1,1,1)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    // 2 000 файлов по 25 якорей: спаны идут лесенкой с перекрытием, то есть
    // на одной строке лежит несколько якорей — иначе замер относился бы к
    // выборке из одной строки, а не к диапазону по span_start.
    const path = `src/pkg${i % 40}/file${i % FILES}.ts`;
    const start = 1 + (i % 500) * 4;
    insNode.run(`a${i}`, `${path}:${start}`, `h${i}`);
    // Треть якорей — общий охват (repo_id = ''): фильтр по репозиторию обязан
    // отсеивать их индексом, а не после чтения строки.
    insAnchor.run(`a${i}`, i % 3 === 0 ? "" : `repo${i % REPOS}`, path, start, start + 30);
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Запрос по позиции
// ---------------------------------------------------------------------------

/**
 * Меряется ТОТ ЖЕ текст запроса, что исполняет команда, — он импортируется из
 * неё, а не переписан здесь. Своя копия SQL в замере — это мутация, которую
 * замер не поймает: `of` можно было бы лишить индекса, и тест остался бы
 * зелёным, меря собственную здоровую копию (проверено — 0 упавших).
 */
const SQL_LINE = SQL_OF_LINE;

test("план запроса по позиции идёт по ix_anchors_file и не сканирует таблицу", () => {
  const plan = db
    .query<{ detail: string }, [string, string, number]>(`EXPLAIN QUERY PLAN ${SQL_LINE}`)
    .all(REPO, PATH, LINE)
    .map((r) => r.detail);
  expect(plan.join(" | ")).toMatch(/USING INDEX ix_anchors_file/);
  expect(plan.filter((d) => /SCAN a\b/.test(d))).toEqual([]);
});

test("выборка НЕПУСТА и отсеивает чужое — иначе замер ничего не значит", () => {
  const rows = queryAnchorsAt(db, REPO, PATH, LINE);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.path).toBe(PATH);
    expect(r.s).toBeLessThanOrEqual(LINE);
    expect(r.e).toBeGreaterThanOrEqual(LINE);
  }
  // Тот же файл в другом репозитории виден только под своим охватом.
  const all = db
    .query<{ n: number }, [string]>("SELECT count(*) AS n FROM anchors WHERE path = ?1")
    .get(PATH)!;
  expect(all.n).toBeGreaterThan(rows.length);
});

test(
  `запрос по file:line укладывается в ${OF_BUDGET_MS} мс на ${N} якорях`,
  () => {
    const healthy = db.query<Record<string, unknown>, [string, string, number]>(SQL_LINE);
    // Соперник — ровно «индекс потеряли»: тот же текст, тот же результат,
    // но SQLite обязан прочитать таблицу целиком.
    const rival = db.query<Record<string, unknown>, [string, string, number]>(
      SQL_LINE.replace("FROM anchors a", "FROM anchors a NOT INDEXED"),
    );
    expect(rival.all(REPO, PATH, LINE).length).toBe(healthy.all(REPO, PATH, LINE).length);

    const m = measure(
      `anchor of ${PATH}:${LINE} @${N} якорей`,
      () => void healthy.all(REPO, PATH, LINE),
      {
        warmup: 50,
        iters: 300,
        budgetMs: OF_BUDGET_MS,
        rival: () => void rival.all(REPO, PATH, LINE),
        rivalLabel: "ix_anchors_file потерян: скан таблицы",
      },
    );
    report(m);
    expectAheadOfRival(m, OF_MIN_SLOWDOWN);
    expectWithinBudget(m);
  },
  180_000,
);

// ---------------------------------------------------------------------------
// Цена хука
// ---------------------------------------------------------------------------

test(
  `хук post-edit укладывается в ${TOUCH_BUDGET_MS} мс и опережает запись в базу`,
  () => {
    const log = join(dir, ".myc", "anchor-dirty.log");
    const dbPath = join(dir, ".myc", "myc.db");
    let i = 0;

    // Соперник — самый вероятный способ написать эту команду: открыть базу и
    // поставить работу в очередь. Открытие соединения (WAL, PRAGMA, схема) в
    // процессе, живущем одну строчку, и есть вся его цена.
    const viaDb = (): void => {
      const conn = new Database(dbPath);
      jobs.enqueue(conn, "anchor_check", {
        entityId: `rival${i % 20}`,
        payload: { path: `src/f${i % 20}.ts` },
      });
      conn.close();
    };

    const m = measure(
      "anchor touch: пометить и выйти",
      () => {
        appendFileSync(log, `${dir}/src/f${i++ % 20}.ts\n`);
      },
      {
        warmup: 50,
        iters: 300,
        budgetMs: TOUCH_BUDGET_MS,
        rival: viaDb,
        rivalLabel: "хук открывает базу и ставит работу в jobs",
      },
    );
    report(m);
    expectAheadOfRival(m, TOUCH_MIN_SLOWDOWN);
    expectWithinBudget(m);
    rmSync(log, { force: true });
  },
  180_000,
);
