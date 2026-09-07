/**
 * И1: федерация по N источникам (R3) не имеет права сломать бюджет `recall` —
 * p99 25 мс на 100 000 узлов.
 *
 * scripts/bench-latency.ts мерит ОДИН источник (`hybridSearch` на одной базе)
 * и про федерацию не знает — ровно как в случае S58 и S59, где по той же
 * причине заведены свои latency-тесты рядом с кодом. Здесь измеряется тот же
 * путь, что исполняет `recall`: `federatedSearch` по списку источников.
 *
 * СТЕНД — экосистема ~/src/cherry: 100 000 узлов, разложенных по 16
 * воркспейсам (корень + пятнадцать репозиториев, решение S59). Именно на нём
 * виден ПОЛ СТОИМОСТИ ИСТОЧНИКА: сам запрос к маленькой базе дёшев, но
 * шестнадцать запросов подряд стоят заметную долю бюджета независимо от
 * размера баз.
 *
 * Тест проверяет три вещи, и третья важнее первых двух:
 *   1. с потолком по умолчанию p99 укладывается в бюджет;
 *   2. без потолка (мутация «опрашиваем все») цена ЗАМЕТНО выше — иначе
 *      потолок был бы бессмысленной сложностью;
 *   3. под потолком выдача РЕАЛЬНО неполна и это названо в mode_used —
 *      иначе первые два пункта мерили бы честный полный опрос.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId, type Layer } from "@myc/core";
import { migrate, migrations, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import {
  DEFAULT_MAX_SOURCES,
  federatedSearch,
  type FederationSource,
} from "./federation.ts";

const TOTAL_NODES = 100_000;
const WORKSPACES = 16;
const PER_WS = TOTAL_NODES / WORKSPACES;
const TEAM = "bench-team";
const CALLER: FtsCaller = { ownerId: "", teamId: TEAM, agentId: "", principals: [] };
const QUERY = "budget";

/** Бюджет И1 для recall целиком. */
const RECALL_BUDGET_MS = 25;
/**
 * Потолок для САМОЙ федерации: 18 мс из 25. Остаток — гидратация страницы,
 * фильтры и бюджетированная сборка ответа, они идут ПОСЛЕ и живут в тех же
 * 25 мс. Это же число — дедлайн по умолчанию (DEFAULT_DEADLINE_MS).
 */
const FEDERATION_BUDGET_MS = 18;

let dir: string;
let drivers: SqliteDriver[] = [];
let sources: FederationSource[] = [];

function seed(driver: SqliteDriver, scope: string, n: number): void {
  const ins = driver.database.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority,
                        status, content_hash, acl, owner_id, team_id, agent_id,
                        salience, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, 'team', '', ?10, '',
             ?11, ?12, ?12, NULL)`,
  );
  const kinds = ["task", "note", "doc", "fragment", "entity"] as const;
  const now = Date.now();
  driver.database.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const id = generateId();
    const layer: Layer = i < n * 0.002 ? 3 : i < n * 0.01 ? 2 : i < n * 0.4 ? 1 : 0;
    const kind = kinds[i % kinds.length]!;
    // Каждый 20-й узел содержит терм запроса — непустая, но не всеобъемлющая
    // лексическая выдача, ровно как в scripts/bench-latency.ts.
    const hasTerm = i % 20 === 0;
    const title = hasTerm ? `latency ${QUERY} review ${i}` : `узел синтетического графа ${i}`;
    const body = hasTerm
      ? `Обсуждение latency ${QUERY}: p99 должен укладываться в бюджет на 100k узлов.`
      : `Синтетическое тело узла номер ${i} для нагрузочного набора бенчмарка.`;
    ins.run(id, kind, layer, scope, title, body, title.slice(0, 120), i % 4, `bench-${id}`, TEAM, 1.0 - (i % 100) / 100, now);
  }
  driver.database.exec("COMMIT");
  driver.database.exec("ANALYZE");
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

async function measure(
  cap: number,
  iters = 60,
): Promise<{ p50: number; p95: number; p99: number; queried: number }> {
  const run = () =>
    federatedSearch({
      text: QUERY,
      caller: CALLER,
      limit: 12,
      vectorMode: "never",
      sources,
      maxSources: cap,
      // Дедлайн снят: здесь мерится ЦЕНА, а не защита от неё. Со включённым
      // дедлайном замер «без потолка» показывал бы не стоимость шестнадцати
      // источников, а работу самого предохранителя.
      deadlineMs: Number.MAX_SAFE_INTEGER,
    });
  for (let i = 0; i < 8; i++) await run();
  const samples: number[] = [];
  let queried = 0;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    const r = await run();
    samples.push(performance.now() - t0);
    queried = r.mode_used.queried;
  }
  samples.sort((a, b) => a - b);
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    queried,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-fed-lat-"));
  for (let i = 0; i < WORKSPACES; i++) {
    const scope = `ws${String(i).padStart(2, "0")}`;
    const driver = openSqlite(join(dir, `${scope}.db`));
    await migrate(driver.database, { migrations, writable: true });
    seed(driver, scope, PER_WS);
    drivers.push(driver);
    sources.push({
      id: scope,
      kind: i === 0 ? "project" : "repo",
      scopes: [scope],
      weight: i === 0 ? 1.0 : 0.99,
      open: () => driver,
    });
  }
}, 240_000);

afterAll(() => {
  for (const d of drivers) {
    try {
      d.close();
    } catch {
      // уже закрыт
    }
  }
  drivers = [];
  sources = [];
  rmSync(dir, { recursive: true, force: true });
});

test(
  "потолок по умолчанию укладывается в бюджет recall на 100k узлов в 16 воркспейсах",
  async () => {
    const one = await measure(1);
    const capped = await measure(DEFAULT_MAX_SOURCES);
    const all = await measure(WORKSPACES);

    console.log(
      `[R3 federation @${TOTAL_NODES} узлов / ${WORKSPACES} воркспейсов, по ${PER_WS} в каждом]\n` +
        `  1 источник   p50=${one.p50.toFixed(2)} p95=${one.p95.toFixed(2)} p99=${one.p99.toFixed(2)} мс\n` +
        `  ${DEFAULT_MAX_SOURCES} источников  p50=${capped.p50.toFixed(2)} p95=${capped.p95.toFixed(2)} p99=${capped.p99.toFixed(2)} мс  (потолок по умолчанию)\n` +
        `  ${WORKSPACES} источников p50=${all.p50.toFixed(2)} p95=${all.p95.toFixed(2)} p99=${all.p99.toFixed(2)} мс  (мутация: потолка нет)\n` +
        `  цена источника ≈ ${((all.p50 - one.p50) / (WORKSPACES - 1)).toFixed(2)} мс`,
    );

    expect(capped.queried).toBe(DEFAULT_MAX_SOURCES);
    expect(capped.p99).toBeLessThan(FEDERATION_BUDGET_MS);
    expect(capped.p99).toBeLessThan(RECALL_BUDGET_MS);

    // Потолок обязан ЭКОНОМИТЬ, иначе он — сложность без причины. Порог мягкий
    // (10%): доказывается направление и порядок, а не конкретное число на
    // конкретной машине.
    expect(all.p50).toBeGreaterThan(capped.p50 * 1.1);
  },
  300_000,
);

test("под потолком выдача НЕПОЛНА и это названо — иначе замер выше ничего не значит", async () => {
  const r = await federatedSearch({
    text: QUERY,
    caller: CALLER,
    limit: 12,
    vectorMode: "never",
    sources,
  });
  expect(r.mode_used.queried).toBe(DEFAULT_MAX_SOURCES);
  expect(r.mode_used.skipped).toBe(WORKSPACES - DEFAULT_MAX_SOURCES);
  for (const rep of r.mode_used.sources.filter((x) => !x.queried)) {
    expect(rep.skipped).toContain("потолка");
  }
  // Опрошенные источники реально дали строки: замер относится к работе, а не
  // к восьми пустым запросам.
  const contributing = new Set(r.hits.map((h) => h.source));
  expect(contributing.size).toBeGreaterThan(1);
});
