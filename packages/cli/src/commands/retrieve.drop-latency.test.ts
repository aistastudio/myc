/**
 * И1: подсчёт отсева ПО ПРИЧИНАМ (memory-f0en6dnkbtmj) не имеет права
 * сломать бюджет `recall` — 25 мс на 100k узлов.
 *
 * Цена размена названа прямо: чтобы подсказка знала, ЧЕЙ это был отсев,
 * постфильтр потерял ранние `return false` и теперь проверяет все фильтры у
 * каждой отсеиваемой строки. Худший случай именно для этого размена —
 * фильтр, который отсекает по ПЕРВОЙ же проверке (`--kind`): раньше строка
 * стоила одно сравнение, теперь — все десять.
 *
 * Меряется ровно тот код, что работает в команде: {@link dropMaskOf} — то же
 * тело постфильтра, которое зовёт `retrieve()` (жанр ready.repo-latency.
 * test.ts, где исполняется тот же текст SQL, что и в `ready`).
 *
 * Тест проверяет три вещи, и третья важнее первых двух:
 *   1. постфильтр на полном пуле стоит доли миллисекунды;
 *   2. `recall` целиком на 100k узлов укладывается в бюджет И1;
 *   3. отсев РЕАЛЬНО произошёл и он посчитан — иначе замер относился бы к
 *      проходу без отсева, и первые два пункта ничего не значили бы.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { REPO_KEY } from "@myc/core";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createRecallCommand } from "./recall.ts";
import { realStoreDeps } from "./store.ts";
import {
  dropMaskOf,
  dropReasonOf,
  realRetrieveExtras,
  type DropCounts,
  type RetrieveDeps,
  type RetrieveFilters,
  type RetrieveRow,
} from "./retrieve.ts";

const N = 100_000;
/** Потолок пула кандидатов у retrieve (POOL_MAX): столько строк видит фильтр. */
const POOL = 100;
/** Бюджет И1 для recall целиком: 25 мс на 100k. */
const RECALL_BUDGET_MS = 25;
/**
 * Потолок для ПОСТФИЛЬТРА на полном пуле. Число выбрано по замеру, а не на
 * глаз. Стенд — 100 строк, отсекаемых ПЕРВОЙ проверкой; сравнивались текущая
 * маска и мутант «ранний выход» (тот же фильтр с `return` после первой же
 * сработавшей проверки — поведение до memory-f0en6dnkbtmj), по 2000 прогонов
 * после прогрева:
 *
 *   маска (сейчас)     p50 1.46–1.50 мкс · p99 1.83–4.08 мкс
 *   ранний выход (до)  p50 0.79 мкс      · p99 1.25–2.29 мкс
 *   строки ПРОХОДЯТ фильтр: 1.50 против 1.67 мкс — неотличимо, обе версии
 *   и так проверяют всё.
 *
 * То есть подсчёт причин стоит +0.7 мкс на весь пул: 0.003 % бюджета recall
 * (25 мс). Порог 1 мс — на три порядка выше замера и на три порядка ниже
 * бюджета: он не краснеет от дрожания тёплой машины, но краснеет от
 * регрессии, которую стоило бы заметить, — например, от второго прохода по
 * выдаче ради тех же счётчиков.
 */
const FILTER_BUDGET_MS = 1;

let dir: string;
let home: string;
let registry: Registry;

function retrieveDeps(): RetrieveDeps {
  return {
    openStore: realStoreDeps.openStore,
    ...realRetrieveExtras,
    resolveEmbedder: async () => ({ ok: false, reason: "в замере эмбеддер отключён" }),
  };
}

function pct(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-drop-lat-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  // Экосистема: корень + два репозитория, спрашивать будем из чужого.
  for (const repo of ["collector", "messaging-server"]) {
    mkdirSync(join(dir, repo, "src"), { recursive: true });
    writeFileSync(join(dir, repo, ".git"), "gitdir: ../.git/modules/x\n");
  }

  const db = new Database(join(dir, ".myc", "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });
  const ins = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        content_hash, acl, team_id, salience, attrs, created_at, updated_at)
     VALUES (?1,'note',2,'',?2,?3,?2,2,'active',?4,'team','',0.5,?5,1,1)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    // Запрос обязан совпадать с ДОЛЕЙ корпуса, а не со всем: замер, где
    // лексика поднимает все 100k, мерил бы FTS, а не горячий путь recall.
    const hit = i % 50 === 0;
    const title = hit ? `батч ${i}` : `очередь ${i}`;
    const body = hit
      ? `батч собирается по 500 событий, партия ${i}`
      : `очередь событий, партия ${i}`;
    // Все узлы принадлежат collector'у — из messaging-server не виден ни один.
    ins.run(`n-${i}`, title, body, `h-${i}`, JSON.stringify({ [REPO_KEY]: "collector" }));
  }
  db.exec("COMMIT");
  db.close();

  registry = new Registry();
  registry.register(createRecallCommand(retrieveDeps()));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(where: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", where, ...args], { registry, env: { MYC_ACTOR: "bench", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

test("постфильтр с подсчётом причин стоит микросекунды на полном пуле", () => {
  // Пул худшего случая: строки, которые отсекает ПЕРВАЯ же проверка (--kind),
  // то есть ровно те, на которых ранний выход экономил больше всего.
  const rows: RetrieveRow[] = [];
  for (let i = 0; i < POOL; i++) {
    rows.push({
      id: `n-${i}`,
      rank: i + 1,
      score: 0.01,
      sources: ["fts"],
      source: "project",
      tier: "project",
      kind: "note",
      type: "note",
      layer: 2,
      updated_at: 1,
      title: `батч ${i}`,
      excerpt: `батч ${i}`,
      tags: [],
      anchors: [],
      reach: "project",
      reach_session: "",
      reach_by: "recorded",
      repo: "collector",
      repo_state: "repo",
    } as RetrieveRow);
  }
  const f: RetrieveFilters = { kinds: ["task"], reach: ["project"] };

  let checked = 0;
  // Прогрев: первые сотни проходов меряют JIT, а не фильтр.
  for (let r = 0; r < 500; r++) {
    for (const row of rows) if (dropMaskOf(row, f, "messaging-server") === 0) checked++;
  }
  const runs: number[] = [];
  for (let r = 0; r < 2000; r++) {
    const t = performance.now();
    for (const row of rows) if (dropMaskOf(row, f, "messaging-server") === 0) checked++;
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  const p50 = pct(runs, 50);
  const p99 = pct(runs, 99);
  console.log(
    `постфильтр ${POOL} строк: p50 ${(p50 * 1000).toFixed(1)} мкс · p99 ${(p99 * 1000).toFixed(1)} мкс`,
  );
  // Ни одна строка не прошла — замер про отсев, а не про сквозной проход.
  expect(checked).toBe(0);
  expect(p99).toBeLessThan(FILTER_BUDGET_MS);

  // И причина отсева — та, которая сработала: у строки её три (kind, repo и
  // ничего больше не задано), значит честное «несколько сразу».
  expect(dropReasonOf(dropMaskOf(rows[0]!, { kinds: ["task"] }, ""))).toBe("kind");
  expect(dropReasonOf(dropMaskOf(rows[0]!, {}, "messaging-server"))).toBe("repo");
  expect(dropReasonOf(dropMaskOf(rows[0]!, { kinds: ["task"] }, "messaging-server"))).toBe(
    "several",
  );
});

test("recall на 100k из чужого репозитория укладывается в бюджет И1", async () => {
  const took: number[] = [];
  let drops: DropCounts | undefined;
  for (let i = 0; i < 12; i++) {
    const r = await myc(join(dir, "messaging-server"), "recall", "батч", "--json");
    const env = JSON.parse(text(r.stdout)) as {
      data: { took_ms: number; drops: DropCounts; total: number };
    };
    took.push(env.data.took_ms);
    drops = env.data.drops;
    expect(env.data.total).toBe(0);
  }
  took.sort((a, b) => a - b);
  const p50 = pct(took, 50);
  const p99 = pct(took, 99);
  console.log(`recall на ${N} узлов: p50 ${p50.toFixed(1)} мс · p99 ${p99.toFixed(1)} мс`);
  expect(p99).toBeLessThan(RECALL_BUDGET_MS);

  // Третий и главный пункт: отсев был, он посчитан, и посчитан ОХВАТОМ
  // РЕПОЗИТОРИЯ — замер без отсева ничего не проверял бы.
  expect(drops!.repo).toBeGreaterThan(0);
  expect(drops!.kind).toBe(0);
});

test("подвал этого же прогона называет охват, а не дежурный список флагов", async () => {
  const out = text((await myc(join(dir, "messaging-server"), "recall", "батч")).stdout);
  expect(out).toContain("охват репозитория messaging-server");
  expect(out).toContain("сними: --repo all");
  for (const knob of ["--kind", "--tag", "--layer", "--since"]) {
    expect(out).not.toContain(knob);
  }
});
