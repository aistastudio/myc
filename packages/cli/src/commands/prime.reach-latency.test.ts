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
 * Тест проверяет две вещи, и вторая важнее первой:
 *   1. p99 запроса укладывается в бюджет с запасом;
 *   2. план запроса ИСПОЛЬЗУЕТ ix_nodes_prime_reach и не сканирует таблицу —
 *      потеря индекса даёт замедление, которое на тёплой машине можно и не
 *      заметить, а на большой базе оно и есть регрессия.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
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
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

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

  // Прогрев отбрасывается: первый прогон платит за подготовку и страницы.
  for (let i = 0; i < 30; i++) {
    q.all(SCOPE, 60, OWN);
    counts.all(SCOPE, OWN);
  }
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    q.all(SCOPE, 60, OWN);
    counts.all(SCOPE, OWN);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p99 = percentile(samples, 99);
  console.log(
    `[S58 prime digest @${N}, 97% чужих сессий] p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
  );
  expect(p99).toBeLessThan(DIGEST_BUDGET_MS);
  expect(p99).toBeLessThan(PRIME_BUDGET_MS);

  // Фильтр обязан РАБОТАТЬ, а не просто быть быстрым: своё пусто, чужого
  // отсеяно много. Иначе замер относился бы к запросу без отсева.
  const rows = q.all(SCOPE, 60, OWN);
  expect(rows.length).toBeGreaterThan(0);
  const hidden = counts.get(SCOPE, OWN) as { hidden: number };
  expect(hidden.hidden).toBeGreaterThan(1000);
});

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
  });

  afterAll(() => {
    repoDb.close();
    rmSync(repoDir, { recursive: true, force: true });
  });

  // Порог выбран мутацией на этом стенде: p99 ~5.1 мс без индекса на 100k,
  // с большим запасом до общего бюджета prime (30 мс, И1). Ужесточать его
  // без покрывающего индекса (аналог ix_nodes_ready_repo, миграция 007, но
  // для памяти его пока нет) смысла нет — он покажет ту же цену.
  const REPO_DIGEST_BUDGET_MS = 8;

  test(`дайджест с фильтром репозитория укладывается в бюджет (${REPO_DIGEST_BUDGET_MS} мс)`, () => {
    const q = repoDb.query<Record<string, unknown>, [string, number, string, string]>(
      primeQueries.prime_digest_scan_repo.sql,
    );
    const counts = repoDb.query<Record<string, unknown>, [string, string]>(
      primeQueries.prime_repo_counts.sql,
    );
    for (let i = 0; i < 30; i++) {
      q.all(SCOPE, 60, OWN, TARGET);
      counts.all(SCOPE, TARGET);
    }
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      q.all(SCOPE, 60, OWN, TARGET);
      counts.all(SCOPE, TARGET);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);
    console.log(
      `[S59 prime digest @${N}, ${REPOS} репозиториев] p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );
    expect(p99).toBeLessThan(REPO_DIGEST_BUDGET_MS);
    expect(p99).toBeLessThan(PRIME_BUDGET_MS);

    // Фильтр обязан реально отсеивать: TARGET видит 1/REPOS своих.
    const rows = q.all(SCOPE, 60, OWN, TARGET);
    expect(rows.length).toBeGreaterThan(0);
    const hidden = counts.get(SCOPE, TARGET) as { repo_hidden: number };
    expect(hidden.repo_hidden).toBeGreaterThan(1000);
  });
});
