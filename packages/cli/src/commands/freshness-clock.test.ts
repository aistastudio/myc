/**
 * ЧАСЫ СВЕЖЕСТИ — ОДНИ НА ВСЕ ПОВЕРХНОСТИ (memory-khny4xb612m6).
 *
 * После ввоза из beads у задачи два времени: когда её меняли в ИСТОЧНИКЕ
 * (attrs.external_updated_at) и когда её ЗАПИСАЛ myc (nodes.updated_at, день
 * ввоза). Ранжирование выдачи уже считало возраст по первому, а очередь
 * `ready` (слагаемое свежести S21), шапка `myc show` и колонка UPDATED в
 * search/recall — по второму: одна и та же задача в выдаче была трёхлетней,
 * а в очереди и на экране — сегодняшней. Теперь всё читает `freshnessClock`
 * (@myc/retrieval) — одно определение, в TS и в SQL, сверенные тестом.
 *
 * И второе свойство — работа в myc ОСВЕЖАЕТ ввезённую задачу. Импорт помечает
 * свою запись (attrs.external_synced_at); правка или claim позже метки — это
 * работа здесь, и часы идут по ней. Иначе после переезда все 812 задач cherry
 * навсегда остались бы в прошлом, хотя работа идёт именно в myc.
 *
 * Мутации: любая поверхность, читающая сырой `updated_at`, роняет тест
 * согласия; «min навсегда» (метка импорта не читается) роняет тест работы.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import type { Envelope } from "../envelope.ts";
import { createImportBeadsCommand } from "./import-beads.ts";
import { createReadyCommand } from "./ready.ts";
import { createRecallCommand } from "./recall.ts";
import { createSearchCommand } from "./search.ts";
import { createShowCommand } from "./show.ts";
import { createClaimCommand, createUpdateCommand } from "./tasks.ts";
import { fmtDate } from "./store.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let projectDir: string;
let registry: Registry;

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "myc-freshness-clock-"));
  mkdirSync(join(projectDir, ".myc"));
  const raw = new Database(join(projectDir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  for (const c of [
    createImportBeadsCommand(),
    createReadyCommand(),
    createRecallCommand(),
    createSearchCommand(),
    createShowCommand(),
    createUpdateCommand(),
    createClaimCommand(),
  ]) {
    registry.register(c);
  }
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

async function myc(...args: string[]): Promise<string> {
  const r = await run(["-C", projectDir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
  return typeof r.stdout === "string" ? r.stdout : "";
}

async function mycJson(...args: string[]): Promise<Envelope> {
  return JSON.parse(await myc("--json", ...args)) as Envelope;
}

/**
 * Две ОДИНАКОВЫЕ по тексту открытые задачи одного приоритета и типа: у одной
 * источник менялся три года назад, у другой — два часа назад. Всё, чем они
 * различаются, — время источника; значит, любое расхождение в порядке и в
 * показанной дате делают часы, а не текст, приоритет или тайбрейк по id.
 */
const OLD_SRC = Date.parse("2023-05-02T17:00:00Z");

function snapshot(newSrc: number, oldUpdated = OLD_SRC): string {
  // Заголовок и описание различаются ОДНИМ словом той же длины и не из
  // запроса: иначе выдача схлопнула бы дубли (deduped), а так bm25 у обеих
  // равен, и разницу даёт только буст свежести.
  const row = (id: string, updated: number): Record<string, unknown> => {
    const tag = id === "demo-old" ? "alpha" : "bravo";
    return {
    id,
    title: `Refuse to unlink the last sign-in method ${tag}`,
    description: `An account with one provider must not be able to lock itself out (${tag}).`,
    status: "open",
    priority: 2,
    issue_type: "task",
    created_by: "alice",
    created_at: "2023-03-14T09:26:53Z",
    updated_at: new Date(updated).toISOString(),
    };
  };
  const p = join(projectDir, `snap-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ issues: [row("demo-old", oldUpdated), row("demo-new", newSrc)] }));
  return p;
}

/** id узла myc по beads-id — через search: он же проверяет, что узел находится. */
async function idOf(ref: string): Promise<string> {
  const raw = new Database(join(projectDir, ".myc", "myc.db"), { readonly: true });
  try {
    const row = raw
      .query("SELECT id FROM nodes WHERE json_extract(attrs,'$.external_ref') = ?1")
      .get(ref) as { id: string } | null;
    if (row === null) throw new Error(`no node for ${ref}`);
    return row.id;
  } finally {
    raw.close();
  }
}

/** Часы узла глазами `myc show --json`: поле updated_at карточки (один узел — сама карточка). */
async function shownClock(id: string): Promise<number> {
  const env = await mycJson("show", id);
  if (!env.ok) throw new Error(`show ${id} failed: ${JSON.stringify(env)}`);
  return (env.data as { updated_at: number }).updated_at;
}

/**
 * Сдвинуть ввоз в прошлое: будто импорт записал узел `ago` назад. Время в
 * тесте не ждёт — поэтому обе величины, которыми часы отличают запись импорта
 * от правки (updated_at строки и метка импорта), сдвигаются согласованно
 * прямо в проекции временной базы. Больше ничего не трогается.
 */
function importedAgo(id: string, ago: number): number {
  const at = Date.now() - ago;
  const raw = new Database(join(projectDir, ".myc", "myc.db"));
  try {
    raw
      .query(
        "UPDATE nodes SET updated_at = ?2, attrs = json_set(attrs, '$.external_synced_at', ?2) WHERE id = ?1",
      )
      .run(id, at);
  } finally {
    raw.close();
  }
  return at;
}

describe("часы свежести: одна функция на все поверхности", () => {
  test("ввезённая задача: порядок выдачи, порядок ready и показанная дата согласны", async () => {
    const newSrc = Date.now() - 2 * HOUR;
    await mycJson("import-beads", snapshot(newSrc));
    const oldId = await idOf("demo-old");
    const newId = await idOf("demo-new");

    // 1. show: карточка показывает время источника, а не день ввоза
    expect(await shownClock(oldId)).toBe(OLD_SRC);
    expect(await shownClock(newId)).toBe(newSrc);
    const card = await myc("show", oldId);
    expect(card).toContain(`updated ${fmtDate(OLD_SRC)}`);
    expect(card).toContain("created 2023-03-14");

    // 2. search: та же дата в строке и тот же порядок, что дают часы
    const s = (await mycJson("search", "unlink sign-in method")).data as {
      rows: { id: string; updated_at: number; created_at?: number; score: number }[];
    };
    const byId = new Map(s.rows.map((r) => [r.id, r]));
    expect(byId.get(oldId)!.updated_at).toBe(OLD_SRC);
    // и «создан» в строке выдачи — тот же, что в карточке: создание в источнике
    expect(byId.get(oldId)!.created_at).toBe(Date.parse("2023-03-14T09:26:53Z"));
    expect(byId.get(newId)!.updated_at).toBe(newSrc);
    expect(byId.get(newId)!.score).toBeGreaterThan(byId.get(oldId)!.score);

    // 3. recall: печатает ту же дату
    const recall = await myc("recall", "unlink sign-in method");
    const oldLine = recall.split("\n").find((l) => l.includes(oldId))!;
    expect(oldLine).toContain(fmtDate(OLD_SRC));

    // 4. ready: слагаемое свежести считает возраст по тем же часам — свежая
    //    впереди, и подпись --why называет возраст источника, а не ввоза
    const r = (await mycJson("ready")).data as {
      items: { id: string; score: number; terms: { freshness: number }; why: { freshness: string } }[];
    };
    const ids = r.items.map((i) => i.id);
    expect(ids.indexOf(newId)).toBeLessThan(ids.indexOf(oldId));
    const oldItem = r.items.find((i) => i.id === oldId)!;
    const newItem = r.items.find((i) => i.id === newId)!;
    // score — из SQL скоринга, слагаемые и подпись — из TS: сверяются ОБА.
    // Порядок сам по себе не доказательство: при равном счёте его решил бы
    // тайбрейк по случайному id узла.
    expect(newItem.score).toBeGreaterThan(oldItem.score);
    expect(newItem.terms.freshness).toBeGreaterThan(oldItem.terms.freshness);
    const days = Number(/^freshness (\d+)d$/.exec(oldItem.why.freshness)?.[1]);
    expect(Math.abs(days - Math.floor((Date.now() - OLD_SRC) / DAY))).toBeLessThanOrEqual(1);
  });

  test("работа в myc освежает ввезённую задачу; повторный импорт с новым временем источника — снова источник", async () => {
    await mycJson("import-beads", snapshot(Date.now() - 2 * HOUR));
    const oldId = await idOf("demo-old");
    const newId = await idOf("demo-new");

    // Ввоз был два часа назад, с тех пор узел не трогали: часы — источник.
    importedAgo(oldId, 2 * HOUR);
    importedAgo(newId, 2 * HOUR);
    expect(await shownClock(oldId)).toBe(OLD_SRC);

    // Правка в myc — это работа здесь: часы — момент правки.
    const t0 = Date.now();
    await mycJson("update", oldId, "--priority", "P1");
    expect(await shownClock(oldId)).toBeGreaterThanOrEqual(t0);
    const s = (await mycJson("search", "unlink sign-in method")).data as {
      rows: { id: string; updated_at: number }[];
    };
    expect(s.rows.find((x) => x.id === oldId)!.updated_at).toBeGreaterThanOrEqual(t0);

    // claim — тоже работа: у второй задачи часы уходят с источника на «сейчас».
    const before = await shownClock(newId);
    expect(before).toBeLessThan(t0);
    await mycJson("claim", newId);
    expect(await shownClock(newId)).toBeGreaterThanOrEqual(t0);

    // Повторный импорт с более новым временем в beads — импорт переписывает
    // факты источника и свою метку: часы снова идут по источнику.
    const newer = Date.now() - 3 * DAY;
    const d = (await mycJson("import-beads", snapshot(Date.now() - 2 * HOUR, newer))).data as Record<string, unknown>;
    expect(d["facts_updated"]).toBeGreaterThanOrEqual(1);
    expect(await shownClock(oldId)).toBe(newer);
  });
});
