/**
 * Цена кеша дайджеста числами (И1, бюджет prime p99 30 мс).
 *
 * Кеш оправдан только если проверка актуальности НАМНОГО дешевле расчёта:
 * иначе он не ускоряет, а добавляет запрос и риск отдать вчерашнее. Описание
 * задачи заявляет «около 50 мкс» на инвалидацию — здесь это число
 * проверяется, а не повторяется.
 *
 * Стенд повторяет prime.reach-latency.test.ts: 100 000 узлов и, в отличие от
 * него, 100 000 строк оплога — проверка читает ИМЕННО хвост оплога, и на
 * коротком оплоге её цена ни о чём не говорит.
 *
 * Мерятся три вещи, и все три исполняют ТОТ ЖЕ текст запроса, что и команда:
 *   1. проверка актуальности + выдача payload (digest_lookup + JSON.parse);
 *   2. расчёт дайджеста (prime_digest_scan + prime_reach_counts);
 *   3. мутация «хвост оплога без индекса» — во что превращается проверка,
 *      если фильтр по scope перестаёт ложиться на ix_oplog_scope.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectMsWithinBudget, expectWithinBudget, measure, report, type Measured } from "@myc/bench";
import { digestCacheQueries } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";
import { primeQueries } from "./prime.ts";

const N = 100_000;
const OPS = 100_000;
const SCOPE = "bench";
/** Скоуп, чьи операции лежат в начале оплога, — стенд для мутации об индексе. */
const RARE_SCOPE = "rare";
const RARE_OPS = 50;
const DIGEST_SCAN_LIMIT = 60;

/**
 * Потолок проверки актуальности. Заявка задачи — «около 50 мкс»; замер на
 * этом стенде даёт ~15–25 мкс (два спуска по B-деревьям: хвост
 * ix_oplog_scope и PK digest_cache, плюс разбор JSON дайджеста). Порог
 * держится с запасом к заявке и краснеет, если проверка перестанет быть
 * спуском по индексу: мутация «max(seq) без индекса» на этом же стенде
 * даёт единицы миллисекунд, то есть в десятки раз больше.
 */
const LOOKUP_BUDGET_US = 200;
/**
 * Потолок ПОПАДАНИЯ целиком (проверка + разбор дайджеста). Он мягче потолка
 * проверки не потому, что попадание дороже по существу — p50 те же ~30 мкс,
 * — а потому что в его хвост попадает сборка мусора от `JSON.parse` на
 * тысячах итераций подряд. Это шум стенда, а не цена механизма; ограждением
 * служит p50, а p99 держится грубым потолком, всё ещё в 15 раз ниже бюджета
 * prime (30 мс).
 */
const HIT_P50_BUDGET_US = 200;
const HIT_P99_BUDGET_US = 2000;
/** Попадание обязано быть кратно дешевле расчёта, иначе кеш не нужен. */
const MIN_SPEEDUP = 5;

let dir: string;
let db: Database;

/**
 * Замер в микросекундах через @myc/bench: медиана перцентилей по трём
 * независимым прогонам, рядом крутится эталон той же длительности, условия
 * записываются вместе с числом. Абсолютный потолок (если задан) утверждается
 * потом через `expectWithinBudget` — и только при годных условиях: под
 * двадцатью занятыми процессами эта же проверка актуальности давала p99
 * 143.9 мкс при потолке 200, то есть запас всего ×1.4, и следующий сосед по
 * процессору сделал бы её красной, ничего не сломав в коде.
 */
function measureUs(
  label: string,
  iterations: number,
  fn: () => void,
  budgetUs?: number,
): { p50: number; p99: number; m: Measured } {
  const m = measure(label, fn, {
    warmup: 200,
    iters: iterations,
    ...(budgetUs === undefined ? {} : { budgetMs: budgetUs / 1000 }),
  });
  return { p50: m.stats.p50 * 1000, p99: m.stats.p99 * 1000, m };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-digest-lat-"));
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
    const layer = i < N * 0.002 ? 3 : i < N * 0.05 ? 2 : i < N * 0.4 ? 1 : 0;
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
  // Оплог настоящей длины: проверка актуальности читает его хвост, и на
  // пустой таблице её цена не имеет отношения к рабочей.
  const insOp = db.prepare(
    `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id,
                        field, value, scope, origin)
     VALUES (?1,'site',?2,?3,'bench','set','node',?4,'title','"t"',?5,1)`,
  );
  for (let i = 0; i < OPS; i++) {
    // Первые 50 операций — редкий скоуп: его хвост лежит в САМОМ НАЧАЛЕ
    // оплога. На нём и видно, за что платит ix_oplog_scope: без индекса
    // min/max-оптимизация идёт по rowid с конца и отбрасывает 99 950 строк,
    // прежде чем найдёт первую свою. Половина остальных — чужой скоуп.
    const scope = i < RARE_OPS ? RARE_SCOPE : i % 2 === 0 ? SCOPE : "other";
    insOp.run(`site:${i}`, i + 1, i + 1, `n${i % N}`, scope);
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

describe("цена кеша дайджеста", () => {
  test("проверка актуальности дешевле расчёта на порядок и укладывается в заявленные ~50 мкс", () => {
    const scan = db.prepare(primeQueries.prime_digest_scan.sql);
    const counts = db.prepare(primeQueries.prime_reach_counts.sql);
    const lookup = db.prepare(digestCacheQueries.digest_lookup.sql);
    const put = db.prepare(digestCacheQueries.digest_put.sql);

    // Прогреваем кеш ровно тем, что кладёт команда.
    const compute = (): unknown => ({
      rows: scan.all(SCOPE, DIGEST_SCAN_LIMIT, ""),
      counts: counts.get(SCOPE, ""),
    });
    const nowSeq = (
      db.query(`SELECT coalesce(max(seq),0) AS s FROM oplog WHERE scope = ?1`).get(SCOPE) as {
        s: number;
      }
    ).s;
    put.run(SCOPE, "prime", "v3::", nowSeq, JSON.stringify(compute()));

    // Цена ИНВАЛИДАЦИИ — это один statement без разбора payload: ровно то,
    // что задача оценивала в ~50 мкс.
    const check = measureUs("digest_cache: проверка актуальности", 2000, () => {
      const row = lookup.get(SCOPE, "prime", "v3::") as { payload: string | null };
      if (row.payload === null) throw new Error("кеш обязан быть горячим");
    }, LOOKUP_BUDGET_US);
    // Цена ПОПАДАНИЯ целиком: та же проверка плюс разбор дайджеста.
    const hit = measureUs("digest_cache: попадание целиком", 2000, () => {
      const row = lookup.get(SCOPE, "prime", "v3::") as { payload: string | null };
      if (row.payload === null) throw new Error("кеш обязан быть горячим");
      JSON.parse(row.payload);
    }, HIT_P99_BUDGET_US);
    const miss = measureUs("digest_cache: расчёт с нуля", 150, () => {
      compute();
    });

    // Мутация прямо в замере: тот же смысл, тот же скоуп — но хвост оплога
    // ищется без ix_oplog_scope. Меряется на редком скоупе: там видно, что
    // индекс покупает не «чуть-чуть», а порядок.
    const withIndex = db.prepare(
      `SELECT coalesce(max(seq), 0) AS s FROM oplog WHERE scope = ?1`,
    );
    const noIndex = db.prepare(
      `SELECT coalesce(max(seq), 0) AS s FROM oplog NOT INDEXED WHERE scope = ?1`,
    );
    expect(withIndex.get(RARE_SCOPE)).toEqual(noIndex.get(RARE_SCOPE) as never);
    const rareIndexed = measureUs("digest_cache: редкий скоуп по индексу", 300, () => {
      withIndex.get(RARE_SCOPE);
    });
    const blind = measureUs("digest_cache: то же без ix_oplog_scope", 100, () => {
      noIndex.get(RARE_SCOPE);
    });

    console.log(
      `[digest_cache @${N} узлов, ${OPS} операций] проверка актуальности ` +
        `p50=${check.p50.toFixed(1)}мкс p99=${check.p99.toFixed(1)}мкс · ` +
        `попадание целиком p50=${hit.p50.toFixed(1)}мкс p99=${hit.p99.toFixed(1)}мкс · ` +
        `расчёт p50=${miss.p50.toFixed(1)}мкс p99=${miss.p99.toFixed(1)}мкс · ` +
        `выигрыш ×${(miss.p50 / hit.p50).toFixed(1)} · ` +
        `редкий скоуп по индексу p50=${rareIndexed.p50.toFixed(1)}мкс · ` +
        `мутация «то же без ix_oplog_scope» p50=${blind.p50.toFixed(1)}мкс`,
    );

    // Условия замера — вместе с числами, по одной строке на замер.
    report(check.m);
    report(hit.m);

    // Абсолютные потолки — только при годных условиях замера (@myc/bench).
    expectWithinBudget(check.m);
    expectWithinBudget(hit.m);
    // p50 попадания держится и под нагрузкой (30.8 мкс при 20 занятых ядрах
    // против 200 потолка): медиана не хвост, её сосед по процессору не двигает.
    // Но это всё равно АБСОЛЮТ, и потому с гейтами пункта 3: калибровка (не
    // MYC_BENCH_ABSOLUTE=0) и годность условий (проба дрожания). Не `m.quiet`:
    // тот включает шумный хвост (p99/p50), а хвост попадания шумит сборкой
    // мусора от JSON.parse (см. HIT_P99_BUDGET_US) — медиане он не помеха.
    expectMsWithinBudget(hit.p50 / 1000, HIT_P50_BUDGET_US / 1000, "digest_cache: попадание целиком, p50");

    // ОТНОСИТЕЛЬНЫЕ утверждения — обязательные при любой загрузке.
    expect(miss.p50 / hit.p50).toBeGreaterThan(MIN_SPEEDUP);
    // Индекс — не украшение: без него та же проверка на порядок дороже.
    expect(blind.p50).toBeGreaterThan(rareIndexed.p50 * 10);
  }, 120_000);

  test("план проверки: спуск по ix_oplog_scope и PK кеша, без единого скана", () => {
    const plan = db
      .query(`EXPLAIN QUERY PLAN ${digestCacheQueries.digest_lookup.sql}`)
      .all(SCOPE, "prime", "v3::") as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join(" | ");
    expect(text).toContain("ix_oplog_scope");
    expect(text).toContain("SEARCH c USING PRIMARY KEY");
    expect(text).not.toContain("TEMP B-TREE");
    expect(text).not.toContain("SCAN oplog");
  });
});
