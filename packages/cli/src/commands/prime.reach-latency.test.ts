/**
 * И1: фильтр охвата (S58) не имеет права сломать бюджет `prime` — p99 30 мс.
 *
 * scripts/bench-latency.ts мерит СВОЮ копию SQL дайджеста и про фильтр охвата
 * не знает; чтобы замер относился к горячему пути, здесь исполняется ТОТ ЖЕ
 * текст запроса, что и в команде (`primeQueries.prime_digest_scan`).
 *
 * Стенд — худший случай для фильтра: 100 000 узлов, из которых 97 % L2/L3
 * принадлежат ЧУЖИМ сессиям. Именно на нём выражения `json_extract` стоят
 * дороже всего: без индекса ix_nodes_prime_reach (миграция 006) SQLite обязан
 * ходить в строку таблицы за каждой отсеиваемой.
 *
 * Тест проверяет три вещи, и первая — самая слабая:
 *   1. p99 запроса укладывается в бюджет с запасом. Стенное время зависит от
 *      загрузки машины, поэтому этот пункт проверяется только при годных
 *      условиях замера (методика — @myc/bench (packages/bench/src/index.ts));
 *   2. запрос ОПЕРЕЖАЕТ соперника — тот же текст, но на старом коротком
 *      ix_nodes_prime, где трёх колонок охвата нет и выражения json_extract
 *      приходится считать по строке таблицы. Оба меряются чередуясь, в одном
 *      процессе: отношение переживает нагрузку, абсолют — нет;
 *   3. план запроса ИСПОЛЬЗУЕТ ix_nodes_prime_reach и не сканирует таблицу —
 *      потеря индекса даёт замедление, которое на тёплой машине можно и не
 *      заметить, а на большой базе оно и есть регрессия.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import {
  expectAheadOfRival,
  expectCostAtMost,
  expectWithinBudget,
  measure,
  report,
} from "@myc/bench";
import { primeQueries } from "./prime.ts";

const N = 100_000;
const SCOPE = "bench";
const OWN = "S-own";
/** Бюджет И1 для prime целиком; дайджест — одна из трёх его частей. */
const PRIME_BUDGET_MS = 30;
/**
 * Потолок для ОДНОГО запроса дайджеста (скан + подсчёт скрытого). Он НЕ
 * равен бюджету команды: на p99 всего prime приходятся ещё ready,
 * in_progress и сборка вывода.
 *
 * Число выбрано мутацией, а не на глаз. Замеры на этом стенде:
 *   полный индекс (reach + session_id + episode_id) — p99 ≈ 1.25 мс;
 *   индекс без двух колонок (мутация)               — p99 ≈ 4.56 мс;
 *   без ix_nodes_prime_reach вовсе                   — ещё хуже и растёт с корпусом.
 * Порог 3 мс лежит между здоровым и деградировавшим: он краснеет на потере
 * колонок индекса и не краснеет от дрожания тёплой машины (запас 2.4×).
 */
const DIGEST_BUDGET_MS = 3;
/**
 * Во сколько раз здоровый запрос обязан опережать соперника (тот же текст на
 * коротком ix_nodes_prime). Измерено:
 *   здоровый, машина свободна   ×4.37 / ×4.44 / ×4.48
 *   здоровый, 20 занятых ядер   ×4.35  (p50 1.22 против 5.30 мс)
 *   МУТАЦИЯ «колонки охвата ушли из индекса», 20 занятых ядер — ×1.71
 *   (p50 3.14 против 5.38 мс; мутация задела только скан, счётчики остались
 *   здоровыми — и порог поймал даже такую половинчатую).
 * Порог 2.0 лежит между 4.35 и 1.71.
 */
const MIN_SLOWDOWN = 2.0;

let dir: string;
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-reach-lat-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });

  const ins = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        content_hash, acl, team_id, salience, attrs, created_at, updated_at)
     VALUES (?1,'note',?2,?3,?4,?5,?6,2,'active',?7,'team','',?8,?9,1,1)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    // Пирамида слоёв как в scripts/bench-latency.ts, но L2/L3 сделано больше
    // (5 %): фильтру нужен корпус, на котором есть что отсеивать.
    const layer = i < N * 0.002 ? 3 : i < N * 0.05 ? 2 : i < N * 0.4 ? 1 : 0;
    // Каждый 40-й — проектный, остальные принадлежат одной из 997 чужих
    // сессий: 97 % окна скана обязано быть отсеяно.
    const attrs =
      i % 40 === 0
        ? JSON.stringify({ reach: "project" })
        : JSON.stringify({ reach: "session", session_id: `s${i % 997}` });
    const title = `узел синтетического графа ${i}`;
    ins.run(
      `n${i}`,
      layer,
      SCOPE,
      title,
      `тело узла ${i}`,
      title.slice(0, 120),
      `h-${i}`,
      1 - (i % 100) / 100,
      attrs,
      );
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
  // Лимит хука — потолок «зациклилось», а не бюджет: стенд под нагрузкой
  // строится секунды, лимит по умолчанию (5 с) ронял бы хук, измерив соседей.
}, 240_000);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("план дайджеста использует ix_nodes_prime_reach и не сканирует таблицу", () => {
  const plan = db
    .query<{ detail: string }, [string, number, string]>(
      `EXPLAIN QUERY PLAN ${primeQueries.prime_digest_scan.sql}`,
    )
    .all(SCOPE, 60, OWN)
    .map((r) => r.detail);
  expect(plan.join(" | ")).toMatch(/USING INDEX ix_nodes_prime_reach/);
  expect(plan.filter((d) => /SCAN nodes/.test(d))).toEqual([]);
});

test(`дайджест с фильтром охвата укладывается в бюджет (И1, prime p99 ${PRIME_BUDGET_MS} мс)`, () => {
  const q = db.query<Record<string, unknown>, [string, number, string]>(
    primeQueries.prime_digest_scan.sql,
  );
  const counts = db.query<Record<string, unknown>, [string, string]>(
    primeQueries.prime_reach_counts.sql,
  );

  // Соперник: тот же текст запроса на старом коротком индексе — так выглядит
  // «колонки охвата ушли из индекса». Меряется чередуясь со здоровым.
  const rivalQ = db.query<Record<string, unknown>, [string, number, string]>(
    primeQueries.prime_digest_scan.sql.replace("ix_nodes_prime_reach", "ix_nodes_prime"),
  );
  const rivalCounts = db.query<Record<string, unknown>, [string, string]>(
    primeQueries.prime_reach_counts.sql.replace("ix_nodes_prime_reach", "ix_nodes_prime"),
  );

  const m = measure(
    `S58 prime digest @${N}, 97% чужих сессий`,
    () => {
      q.all(SCOPE, 60, OWN);
      counts.all(SCOPE, OWN);
    },
    {
      warmup: 30,
      iters: 100,
      budgetMs: DIGEST_BUDGET_MS,
      rival: () => {
        rivalQ.all(SCOPE, 60, OWN);
        rivalCounts.all(SCOPE, OWN);
      },
      rivalLabel: "короткий ix_nodes_prime, охват считается по строке таблицы",
    },
  );
  report(m);
  expectAheadOfRival(m, MIN_SLOWDOWN);
  expectWithinBudget(m);
  // Подбюджет дайджеста обязан оставаться ниже бюджета команды целиком.
  expect(DIGEST_BUDGET_MS).toBeLessThan(PRIME_BUDGET_MS);

  // Фильтр обязан РАБОТАТЬ, а не просто быть быстрым: своё пусто, чужого
  // отсеяно много. Иначе замер относился бы к запросу без отсева.
  const rows = q.all(SCOPE, 60, OWN);
  expect(rows.length).toBeGreaterThan(0);
  const hidden = counts.get(SCOPE, OWN) as { hidden: number };
  expect(hidden.hidden).toBeGreaterThan(1000);
  // 120 с — потолок «что-то зациклилось», а не бюджет: см. комментарий у
  // такого же лимита в ready.repo-latency.test.ts.
}, 120_000);

/**
 * Охват РЕПОЗИТОРИЯ (S59) в памяти — отдельный стенд: `json_extract(attrs,
 * '$.repo')` не incl в ix_nodes_prime_reach (см. комментарий у
 * `prime_digest_scan_repo`/`prime_repo_counts` в prime.ts), поэтому у этого
 * пути нет оптимизации индексом и цена выше, чем у `reach`. Приемлема она
 * ТОЛЬКО потому, что запросы `_repo` включаются исключительно при активном
 * `--repo` (см. `withRepo` в scanDigest) — без фильтра эта цена не платится
 * вовсе, что и проверяет тест выше нулевым доп. параметром.
 */
describe("охват репозитория в памяти (S59)", () => {
  const REPOS = 20;
  const TARGET = "repo0";
  let repoDir: string;
  let repoDb: Database;

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "myc-repo-lat-"));
    repoDb = new Database(join(repoDir, "myc.db"), { create: true });
    repoDb.exec("PRAGMA journal_mode = WAL");
    await migrate(repoDb, { migrations, writable: true });
    const ins = repoDb.prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          content_hash, acl, team_id, salience, attrs, created_at, updated_at)
       VALUES (?1,'note',?2,?3,?4,?5,?6,2,'active',?7,'team','',?8,?9,1,1)`,
    );
    repoDb.exec("BEGIN");
    for (let i = 0; i < N; i++) {
      const layer = i < N * 0.002 ? 3 : i < N * 0.05 ? 2 : i < N * 0.4 ? 1 : 0;
      // Каждый узел принадлежит одному из REPOS репозиториев — TARGET видит
      // лишь 1/REPOS своих, остальное обязано отсеяться фильтром.
      const attrs = JSON.stringify({ reach: "project", repo: `repo${i % REPOS}` });
      const title = `узел синтетического графа ${i}`;
      ins.run(`n${i}`, layer, SCOPE, title, `тело узла ${i}`, title.slice(0, 120), `h-${i}`, 1 - (i % 100) / 100, attrs);
    }
    repoDb.exec("COMMIT");
    repoDb.exec("ANALYZE");
    // Лимит хука — потолок «зациклилось», а не бюджет: стенд под нагрузкой
    // строится секунды, лимит по умолчанию (5 с) ронял бы хук, измерив соседей.
  }, 240_000);

  afterAll(() => {
    repoDb.close();
    rmSync(repoDir, { recursive: true, force: true });
  });

  // Порог выбран мутацией на этом стенде: p99 ~5.1 мс без индекса на 100k,
  // с большим запасом до общего бюджета prime (30 мс, И1). Ужесточать его
  // без покрывающего индекса (аналог ix_nodes_ready_repo, миграция 007, но
  // для памяти его пока нет) смысла нет — он покажет ту же цену.
  const REPO_DIGEST_BUDGET_MS = 8;
  /**
   * Потолок ОТНОСИТЕЛЬНОЙ цены фильтра репозитория. У этого пути нет индекса,
   * который можно было бы потерять, — значит нет и деградировавшего близнеца,
   * с которым его сравнивать (замер: тот же запрос на коротком
   * ix_nodes_prime стоит ×1.03, то есть индекс охвата здесь ни при чём).
   * Поэтому эталон — ТОТ ЖЕ дайджест без фильтра репозитория на том же
   * стенде: утверждение «фильтр стоит не больше чем в K раз дороже дайджеста
   * без него» и есть то, ради чего заводился абсолютный порог, только
   * измеренное отношением и потому не зависящее от загрузки машины.
   * Измерено (медиана трёх прогонов в каждом): ×6.21 / ×6.30 / ×6.35 / ×6.39
   * / ×6.45 при 4.01–4.36 мс против 0.62–0.69 мс. Разброс 4 %, причём ×6.21
   * и ×6.39 сняты при 20 занятых ядрах и дрожании эталона ×11.9–13.7:
   * отношение нагрузку не замечает. МУТАЦИЯ «фильтр стал стоить два скана
   * вместо одного» под той же нагрузкой дала ×9.33 и порог покраснел.
   * Порог 8 стоит между 6.45 и 9.33 — он ловит рост цены фильтра на четверть.
   */
  const REPO_MAX_COST_RATIO = 8;

  test(`дайджест с фильтром репозитория укладывается в бюджет (${REPO_DIGEST_BUDGET_MS} мс)`, () => {
    const q = repoDb.query<Record<string, unknown>, [string, number, string, string]>(
      primeQueries.prime_digest_scan_repo.sql,
    );
    const counts = repoDb.query<Record<string, unknown>, [string, string]>(
      primeQueries.prime_repo_counts.sql,
    );
    // Эталон: тот же дайджест на том же стенде, но БЕЗ фильтра репозитория —
    // ровно та работа, к которой фильтр добавляется.
    const baseQ = repoDb.query<Record<string, unknown>, [string, number, string]>(
      primeQueries.prime_digest_scan.sql,
    );
    const baseCounts = repoDb.query<Record<string, unknown>, [string, string]>(
      primeQueries.prime_reach_counts.sql,
    );
    const m = measure(
      `S59 prime digest @${N}, ${REPOS} репозиториев`,
      () => {
        q.all(SCOPE, 60, OWN, TARGET);
        counts.all(SCOPE, TARGET);
      },
      {
        warmup: 30,
        // 100, а не 80: бюджет по p99, а p99 по nearest-rank при n < 100 —
        // максимум прогона (при 80 — 80-й элемент из 80), один выброс решал бы.
        iters: 100,
        budgetMs: REPO_DIGEST_BUDGET_MS,
        rival: () => {
          baseQ.all(SCOPE, 60, OWN);
          baseCounts.all(SCOPE, OWN);
        },
        rivalLabel: "тот же дайджест без фильтра репозитория",
      },
    );
    report(m);
    expectCostAtMost(m, REPO_MAX_COST_RATIO);
    expectWithinBudget(m);
    // Подбюджет дайджеста обязан оставаться ниже бюджета команды целиком.
  expect(DIGEST_BUDGET_MS).toBeLessThan(PRIME_BUDGET_MS);

    // Фильтр обязан реально отсеивать: TARGET видит 1/REPOS своих.
    const rows = q.all(SCOPE, 60, OWN, TARGET);
    expect(rows.length).toBeGreaterThan(0);
    const hidden = counts.get(SCOPE, TARGET) as { repo_hidden: number };
    expect(hidden.repo_hidden).toBeGreaterThan(1000);
  }, 120_000);
});
