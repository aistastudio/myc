/**
 * И1: фильтр охвата репозитория (S59) не имеет права сломать бюджет `ready` —
 * 5 мс на 100k узлов, и очередь обязана остаться ОДНИМ сканом частичного
 * индекса.
 *
 * scripts/bench-latency.ts мерит СВОЮ копию SQL очереди и про охват
 * репозитория не знает (ровно как и в случае S58 — см. prime.reach-latency.
 * test.ts); чтобы замер относился к горячему пути, здесь исполняется ТОТ ЖЕ
 * текст запроса, что и в команде (`readyQueries.ready_top_noanchors_repo`).
 *
 * Стенд — худший случай экосистемы: 100 000 узлов, из них 4 000 открытых
 * незаблокированных задач, разложенных по 17 репозиториям, то есть под своим
 * фильтром видно ~1/17 очереди плюс общее и неопределённое. Именно на нём
 * `json_extract` стоит дороже всего: без ix_nodes_ready_repo (миграция 007)
 * SQLite обязан ходить в строку таблицы за КАЖДОЙ отсеиваемой задачей.
 *
 * Тест проверяет три вещи, и третья важнее первых двух:
 *   1. план запроса использует ix_nodes_ready_repo и не сканирует таблицу;
 *   2. запрос опережает соперника — тот же запрос, но с выражением из строки
 *      таблицы, — и укладывается в бюджет;
 *   3. фильтр реально отсеивает — иначе замер относился бы к запросу без
 *      отсева, и оба предыдущих пункта ничего не значили бы.
 *
 * Методика замера — @myc/bench (packages/bench/src/index.ts): абсолютный бюджет проверяется
 * только при годных условиях, преимущество над соперником — всегда.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import {
  expectAheadOfRival,
  expectWithinBudget,
  measure,
  report,
} from "@myc/bench";
import { readyQueries } from "./ready.ts";

const N = 100_000;
const SCOPE = "bench";
const REPOS = 17;
const OWN = "repo7";
/** Бюджет И1 для очереди целиком (§ горячий путь ready — 5 мс на 100k). */
const READY_BUDGET_MS = 5;
/**
 * Потолок для ОДНОГО скоринг-запроса очереди с фильтром. Число выбрано
 * мутацией, а не на глаз. Замеры на этом стенде (три прогона, см. вывод
 * теста):
 *   ix_nodes_ready_repo (выражение подаётся из индекса) — p50 1.21 мс,
 *                                                         p99 1.33–1.65 мс;
 *   ix_nodes_ready с тем же предикатом (мутация «фильтр перестал быть
 *   частью индексного скана», выражение берётся из строки таблицы)
 *                                                       — p50 4.38–4.74 мс,
 *                                                         p99 5.20–6.38 мс.
 * Порог 3 мс лежит между здоровым и деградировавшим планом: запас 1.8× от
 * дрожания тёплой машины и втрое ниже худшего мутантного p99.
 *
 * ЭТОТ ПОРОГ — НЕ ГЛАВНАЯ ПРОВЕРКА. Стенное время меряется на машине, о
 * загрузке которой тест ничего не знает: в общем прогоне этот же замер давал
 * p99 2.43 мс при пороге 3, то есть запас 1.23× — лотерея (memory-ws31ztqgh43c).
 * Главная проверка — MIN_SLOWDOWN ниже: отношение здорового плана к
 * деградировавшему, измеренное чередуясь в одном процессе. Загрузка машины
 * растягивает обоих одинаково и из отношения уходит.
 */
const FILTERED_BUDGET_MS = 3;
/**
 * Во сколько раз здоровый план обязан опережать соперника. Измерено:
 *   здоровый, машина свободна   ×3.80 / ×3.87 / ×3.89 (p50 1.33 против 5.04 мс)
 *   здоровый, 20 занятых ядер   ×3.96  (p50 1.47 против 5.82 мс)
 *   МУТАЦИЯ «ix_nodes_ready_repo снят», 20 занятых ядер — ×0.86
 *   (p50 6.80 против 5.83 мс: здоровый путь стал соперником).
 * Порог 2.0 лежит между 3.80 и 0.86. Он держится под нагрузкой ровно потому,
 * что обе половины меряются чередуясь: машина растягивает их вместе.
 */
const MIN_SLOWDOWN = 2.0;

let dir: string;
let db: Database;

const W = { pri: 0.4, unb: 0.27, fresh: 0.14, anch: 0.1, type: 0.09 };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-repo-lat-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });

  const ins = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        open_blockers, content_hash, acl, team_id, salience, attrs,
                        created_at, updated_at)
     VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,'team','',1,?11,?12,?12)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    // 4 % — открытые незаблокированные задачи (окно частичного индекса):
    // 4 000 готовых задач на 100 000 узлов, на два порядка больше, чем бывает
    // в живой базе, — запас, на котором потеря индекса заметна наверняка.
    // Остальное — шум: закрытые, заблокированные и заметки.
    const open = i % 25 === 0;
    const kind = i % 5 === 4 ? "note" : "task";
    const status = kind === "note" ? "active" : open ? "open" : "closed";
    const blockers = kind === "task" && !open && i % 5 === 3 ? 1 : 0;
    // Каждая 23-я задача — про всю экосистему (общий охват), каждая 29-я
    // записана до S59 и охвата не несёт вовсе; остальные разложены по 17
    // репозиториям. Шаги — простые числа и взаимно просты с шагом открытых
    // задач: на кратных модулях (25 и 16) окно очереди попадало бы лишь в
    // часть репозиториев, и «свой» мог не встретиться в ней ни разу.
    const attrs =
      i % 29 === 0
        ? JSON.stringify({ type: "task" })
        : i % 23 === 0
          ? JSON.stringify({ type: "task", repo: "" })
          : JSON.stringify({ type: "task", repo: `repo${i % REPOS}` });
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
      attrs,
      1_700_000_000_000 + i,
    );
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Args = [string, number, number, number, number, number, number, number, string];
const ARGS: Args = [SCOPE, W.pri, W.unb, W.fresh, W.anch, W.type, 10, Date.now(), OWN];

test("план очереди с фильтром использует ix_nodes_ready_repo и не сканирует таблицу", () => {
  const plan = db
    .query<{ detail: string }, Args>(
      `EXPLAIN QUERY PLAN ${readyQueries.ready_top_noanchors_repo.sql}`,
    )
    .all(...ARGS)
    .map((r) => r.detail);
  expect(plan.join(" | ")).toMatch(/USING INDEX ix_nodes_ready_repo/);
  // Строка проверки, а не украшение: потеря индекса — это SCAN nodes.
  expect(plan.filter((d) => /SCAN nodes/.test(d))).toEqual([]);
});

test("очередь без фильтра осталась на своём коротком индексе", () => {
  const plan = db
    .query<{ detail: string }, [string, number, number, number, number, number, number, number]>(
      `EXPLAIN QUERY PLAN ${readyQueries.ready_top_noanchors.sql}`,
    )
    .all(SCOPE, W.pri, W.unb, W.fresh, W.anch, W.type, 10, Date.now())
    .map((r) => r.detail);
  expect(plan.join(" | ")).toMatch(/USING INDEX ix_nodes_ready\b/);
});

test(`очередь с фильтром укладывается в бюджет (И1, ready ${READY_BUDGET_MS} мс)`, () => {
  const q = db.query<Record<string, unknown>, Args>(readyQueries.ready_top_noanchors_repo.sql);
  // Соперник: тот же предикат, но выражение приходится брать из строки
  // таблицы — так выглядит «фильтр перестал быть частью индексного скана».
  // Меряется ЧЕРЕДУЯСЬ со здоровым, чтобы оба застали одни условия.
  const mutated = db.query<Record<string, unknown>, Args>(
    readyQueries.ready_top_noanchors_repo.sql.replace("ix_nodes_ready_repo", "ix_nodes_ready"),
  );

  const m = measure(`S59 ready @${N}, ${REPOS} репозиториев`, () => void q.all(...ARGS), {
    warmup: 10,
    iters: 50,
    budgetMs: FILTERED_BUDGET_MS,
    rival: () => void mutated.all(...ARGS),
    rivalLabel: "выражение из строки таблицы, не из индекса",
  });
  report(m);
  expectAheadOfRival(m, MIN_SLOWDOWN);
  expectWithinBudget(m);
  // Лимит ниже — потолок «что-то зациклилось», а не бюджет: бюджет проверяют
  // утверждения выше. Стенное время всего замера зависит от загрузки машины
  // так же, как и всё прочее, и лимит по умолчанию (5 с) под нагрузкой даёт
  // ровно ту ложную тревогу, ради которой всё это писалось.
}, 120_000);

test("фильтр РАБОТАЕТ: чужие репозитории отсеяны, общее и неопределённое — нет", () => {
  const rows = db
    .query<{ id: string; attrs: string }, Args>(readyQueries.ready_top_noanchors_repo.sql)
    .all(...([SCOPE, W.pri, W.unb, W.fresh, W.anch, W.type, 50_000, Date.now(), OWN] as Args));
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    const repo = (JSON.parse(r.attrs) as { repo?: string }).repo;
    expect(repo === undefined || repo === "" || repo === OWN).toBe(true);
  }

  const all = db
    .query<{ id: string }, [string, number, number, number, number, number, number, number]>(
      readyQueries.ready_top_noanchors.sql,
    )
    .all(SCOPE, W.pri, W.unb, W.fresh, W.anch, W.type, 50_000, Date.now());
  // Отсев обязан быть заметным, иначе замер выше ничего не значит.
  const filteredTotal = db
    .query<{ n: number }, [string, string]>(
      `SELECT count(*) AS n FROM nodes WHERE scope = ?1 AND kind='task' AND status='open'
         AND open_blockers=0 AND deleted_at IS NULL
         AND (json_extract(attrs,'$.repo') IS NULL OR json_extract(attrs,'$.repo') IN ('', ?2))`,
    )
    .get(SCOPE, OWN)!;
  const allTotal = db
    .query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM nodes WHERE scope = ?1 AND kind='task' AND status='open'
         AND open_blockers=0 AND deleted_at IS NULL`,
    )
    .get(SCOPE)!;
  expect(rows.length).toBeLessThan(all.length);
  expect(rows.length).toBe(filteredTotal.n);
  expect(all.length).toBe(allTotal.n);
  // Своё + общее + неопределённое — заметно меньше трети очереди: отсев
  // настоящий, а значит замер выше относится к запросу, который РАБОТАЕТ.
  expect(filteredTotal.n).toBeLessThan(allTotal.n / 3);
  expect(filteredTotal.n).toBeGreaterThan(0);
});
