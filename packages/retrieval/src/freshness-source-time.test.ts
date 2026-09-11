// Ограждение: ВВЕЗЁННАЯ СЕГОДНЯ ЗАПИСЬ ТРЁХЛЕТНЕЙ ДАВНОСТИ — НЕ СВЕЖАЯ
// (memory-khny4xb612m6).
//
// ЧТО СЛУЧИЛОСЬ. `myc import-beads` переносит задачи трекера одним прогоном, и
// у каждой `nodes.updated_at` — момент ЗАПИСИ, то есть день ввоза. boost(d)
// брал возраст по нему, поэтому 812 задач cherry, созданных с апреля по
// сентябрь, стали в выдаче одинаково «свежими» — наравне с тем, что записано
// вчера руками, и на 90 суток вперёд (τ свежести).
//
// ПОЧЕМУ НЕ РОДНАЯ КОЛОНКА. `updated_at` — время операции: `this.now()` на
// записи и `op.hlc.ts` на реплике. Вписать туда дату источника значило бы
// соврать оплогу о времени записи. Поэтому исходное время лежит в attrs —
// `external_updated_at` у задачи, `external_created_at` у комментария (его
// же читает `myc show`, упорядочивая нить), — и свежесть читает ЕГО.
//
// НО РАБОТА В MYC ОБЯЗАНА ОСВЕЖАТЬ. После переезда работа идёт именно здесь,
// и «время источника навсегда» оставило бы все ввезённые задачи в прошлом.
// Импорт помечает свою запись (`external_synced_at`); `updated_at` позже
// метки больше чем на допуск — узел правили в myc, и часы — `updated_at`.
//
// Мутации, каждая роняет свой тест:
//  - часы без времени источника (снова дата ввоза) — 1, 3, 4;
//  - гидратация векторной ветки без часов — 4;
//  - max вместо min (исходное время «свежее» записи) — 5;
//  - «min навсегда», метка импорта не читается — 8;
//  - допуск 0 (запись импорта сама себя считает правкой) — 9;
//  - SQL и TS разошлись хоть на одном случае — 10.

import { describe, expect, test } from "bun:test";
import { migration001Init, openSqlite } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import {
  FRESHNESS_ATTRS,
  FRESHNESS_QUANTUM_MS,
  IMPORT_WRITE_SLACK_MS,
  freshnessClock,
  freshnessClockSql,
  hybridSearch,
  type HybridVectorSource,
} from "./hybrid.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };
const NOW = Date.UTC(2026, 8, 11);
const DAY = FRESHNESS_QUANTUM_MS;
const HOUR = 3_600_000;

interface Row {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

function corpus(rows: readonly Row[]): ReturnType<typeof openSqlite> {
  const db = openSqlite(":memory:");
  db.database.exec(migration001Init.sql);
  const insert = db.database.query(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        head_id, content_hash, acl, owner_id, team_id, agent_id,
                        created_at, updated_at, attrs)
     VALUES (?1, 'task', 1, 's1', ?2, ?2, '', 2, 'open', NULL, ?3, 'team', '', '', '', ?4, ?4, ?5)`,
  );
  for (const r of rows) insert.run(r.id, r.title, `h-${r.id}`, r.updatedAt, JSON.stringify(r.attrs ?? {}));
  return db;
}

function search(
  db: ReturnType<typeof openSqlite>,
  text: string,
  vectorSource?: HybridVectorSource,
): { id: string; score: number; updatedAt: number }[] {
  return hybridSearch(db, {
    text,
    scopes: ["s1"],
    caller: ANON,
    limit: 10,
    now: NOW,
    ...(vectorSource !== undefined
      ? { vectorMode: "always" as const, vectorSource, embedQuery: () => new Float32Array(384).fill(0.1) }
      : { vectorMode: "never" as const }),
  }).hits.map((h) => ({ id: h.id, score: h.score, updatedAt: h.updatedAt }));
}

/**
 * Пара ОДИНАКОВО релевантных задач: текст совпадает дословно, bm25 равен, и
 * порядок решают только бусты. Идентификаторы подобраны так, что при равном
 * счёте тайбрейк по id ставит ВВЕЗЁННУЮ первой: значит, если она оказалась
 * второй, это сделала свежесть, а не алфавит.
 */
const TITLE = "unlink refused for the last sign-in method";
const importedToday = (attrs: Readonly<Record<string, unknown>>): Row => ({
  id: "a-imported",
  title: TITLE,
  updatedAt: NOW - HOUR, // ввезена час назад
  attrs: { external_ref: "cherry-1", ...attrs },
});
const nativeMonthOld: Row = { id: "b-native", title: TITLE, updatedAt: NOW - 30 * DAY };

describe("свежесть ввезённой записи — по времени источника, а не ввоза", () => {
  test("1. ввезённая сегодня задача трёхлетней давности уступает месячной", () => {
    const db = corpus([importedToday({ external_updated_at: NOW - 3 * 365 * DAY }), nativeMonthOld]);
    const hits = search(db, "unlink refused");
    expect(hits.map((h) => h.id)).toEqual(["b-native", "a-imported"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    db.close();
  });

  test("2. контроль: без исходного времени та же пара — ввезённая впереди, как до правки", () => {
    // Ровно поведение до правки, на тех же данных: сегодняшняя запись
    // «свежее» месячной. Если бы порядок в тесте 1 давал не атрибут, а что-то
    // иное, этот тест показал бы тот же порядок, что и тест 1.
    const db = corpus([importedToday({}), nativeMonthOld]);
    expect(search(db, "unlink refused").map((h) => h.id)).toEqual(["a-imported", "b-native"]);
    db.close();
  });

  test("3. комментарий из трекера стареет по external_created_at", () => {
    // У комментария нет «обновлён»: import-beads кладёт только время создания.
    const db = corpus([importedToday({ external_created_at: NOW - 2 * 365 * DAY }), nativeMonthOld]);
    expect(search(db, "unlink refused").map((h) => h.id)).toEqual(["b-native", "a-imported"]);
    db.close();
  });

  test("4. то же в векторной ветке: узел, найденный только вектором, гидратируется с исходным временем", () => {
    // Текст не совпадает с запросом ни словом — FTS их не находит, оба
    // приходят только из вектора (ранги 1 и 2) и гидратируются отдельным
    // запросом. Разница рангов даёт ~1.6 % счёта, свежесть — ~18 %.
    const db = corpus([
      { ...importedToday({ external_updated_at: NOW - 3 * 365 * DAY }), title: "wallet detach guard" },
      { ...nativeMonthOld, title: "provider removal lockout" },
    ]);
    const vector: HybridVectorSource = () => ({
      hits: [
        { id: "a-imported", rank: 1, distance: 0.1 },
        { id: "b-native", rank: 2, distance: 0.11 },
      ],
      degraded: false,
      reranked: false,
      candidates: 2,
    });
    const hits = search(db, "zzqx", vector);
    expect(hits.map((h) => h.id)).toEqual(["b-native", "a-imported"]);
    db.close();
  });

  test("5. исходное время не делает запись свежее её записи (перекос часов источника)", () => {
    // Источник с часами, убежавшими вперёд, не должен давать ввезённой записи
    // больше свежести, чем у записи того же дня: берётся min, а не max.
    const db = corpus([
      { ...importedToday({ external_updated_at: NOW + 10 * DAY }), updatedAt: NOW - 30 * DAY },
      nativeMonthOld,
    ]);
    const hits = search(db, "unlink refused");
    expect(new Set(hits.map((h) => h.score)).size).toBe(1);
    db.close();
  });

  test("6. мусор вместо числа в атрибуте — не свежесть: берётся время записи", () => {
    const db = corpus([
      { ...importedToday({ external_updated_at: "2023-01-01T00:00:00Z" }), updatedAt: NOW - 30 * DAY },
      nativeMonthOld,
    ]);
    const hits = search(db, "unlink refused");
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.score)).size).toBe(1);
    db.close();
  });

  test("7. показываемое updatedAt хита — те же часы, что у буста, а не время записи", () => {
    // Поверхности обязаны согласоваться: дата в search/recall (и их
    // --since/--until, --sort updated) — та же, по которой ранжировали.
    const db = corpus([importedToday({ external_updated_at: NOW - 3 * 365 * DAY }), nativeMonthOld]);
    const byId = new Map(search(db, "unlink refused").map((h) => [h.id, h]));
    expect(byId.get("a-imported")!.updatedAt).toBe(NOW - 3 * 365 * DAY);
    expect(byId.get("b-native")!.updatedAt).toBe(NOW - 30 * DAY);
    db.close();
  });

  test("8. работа в myc после ввоза освежает: updated_at позже метки импорта — часы по нему", () => {
    // Ввезена 2 часа назад, через час после ввоза её правили в myc.
    const synced = NOW - 2 * HOUR;
    const db = corpus([
      {
        ...importedToday({ external_updated_at: NOW - 3 * 365 * DAY, [FRESHNESS_ATTRS.synced]: synced }),
        updatedAt: NOW - HOUR,
      },
      nativeMonthOld,
    ]);
    const hits = search(db, "unlink refused");
    expect(hits.map((h) => h.id)).toEqual(["a-imported", "b-native"]);
    expect(hits[0]!.updatedAt).toBe(NOW - HOUR);
    db.close();
  });

  test("9. запись самого импорта — не правка: updated_at в пределах допуска от метки", () => {
    // Импорт читает часы до выпуска операции; между ними — микросекунды, а при
    // ожидании чужой блокировки записи — секунды (busy_timeout ~5 с). Зазор
    // здесь КОНКРЕТНЫЙ, а не доля допуска: тест, выведенный из самой
    // константы, подстроился бы под любое её значение, включая ноль.
    const lockWait = 5_000;
    expect(IMPORT_WRITE_SLACK_MS).toBeGreaterThan(lockWait);
    const synced = NOW - 2 * HOUR;
    const db = corpus([
      {
        ...importedToday({ external_updated_at: NOW - 3 * 365 * DAY, [FRESHNESS_ATTRS.synced]: synced }),
        updatedAt: synced + lockWait,
      },
      nativeMonthOld,
    ]);
    const hits = search(db, "unlink refused");
    expect(hits.map((h) => h.id)).toEqual(["b-native", "a-imported"]);
    expect(hits[1]!.updatedAt).toBe(NOW - 3 * 365 * DAY);
    db.close();
  });

  test("10. SQL-выражение часов и TS-функция совпадают на каждом случае", () => {
    // Очередь ready считает свежесть в SQL (скоринг идёт одним сканом
    // индекса), show — в TS по записи узла. Одно определение в двух языках
    // держится только этой сверкой: любой расходящийся случай — провал.
    const U = FRESHNESS_ATTRS.sourceUpdated;
    const C = FRESHNESS_ATTRS.sourceCreated;
    const S = FRESHNESS_ATTRS.synced;
    const W = NOW - 5 * DAY; // updated_at узла
    const sources: Record<string, unknown>[] = [
      {},
      { [U]: NOW - 400 * DAY },
      { [C]: NOW - 700 * DAY },
      { [U]: NOW - 400 * DAY, [C]: NOW - 700 * DAY },
      { [U]: "2023-01-01", [C]: NOW - 700 * DAY }, // мусор в updated → берётся created
      { [U]: true },
      { [U]: null, [C]: NOW - 9 * DAY },
      { [U]: NOW + 10 * DAY }, // часы источника убежали вперёд
      { [U]: 1.5e12 + 0.5 }, // дробное — тоже число
      { [C]: { nested: 1 } },
    ];
    const syncs: unknown[] = [undefined, W, W - IMPORT_WRITE_SLACK_MS, W - IMPORT_WRITE_SLACK_MS - 1, "x", null, false];
    const db = openSqlite(":memory:");
    db.database.exec(migration001Init.sql);
    const ins = db.database.query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status, head_id,
                          content_hash, acl, owner_id, team_id, agent_id, created_at, updated_at, attrs)
       VALUES (?1, 'task', 1, 's1', ?1, '', '', 2, 'open', NULL, ?1, 'team', '', '', '', ?2, ?2, ?3)`,
    );
    const cases: { id: string; attrs: Record<string, unknown> }[] = [];
    for (const [i, src] of sources.entries()) {
      for (const [j, sync] of syncs.entries()) {
        const attrs = { type: "task", ...src, ...(sync !== undefined ? { [S]: sync } : {}) };
        const id = `c-${i}-${j}`;
        ins.run(id, W, JSON.stringify(attrs));
        cases.push({ id, attrs: JSON.parse(JSON.stringify(attrs)) as Record<string, unknown> });
      }
    }
    const rows = db.database
      .query(`SELECT n.id AS id, ${freshnessClockSql("n")} AS clock FROM nodes n`)
      .all() as { id: string; clock: number }[];
    const sql = new Map(rows.map((r) => [r.id, r.clock]));
    expect(sql.size).toBe(sources.length * syncs.length);
    for (const c of cases) {
      expect({ id: c.id, clock: sql.get(c.id) }).toEqual({
        id: c.id,
        clock: freshnessClock({ updated_at: W, attrs: c.attrs }),
      });
    }
    // и сверка не вырождена: случаи дают все три исхода часов
    const outcomes = new Set(cases.map((c) => freshnessClock({ updated_at: W, attrs: c.attrs })));
    expect(outcomes.has(W)).toBe(true);
    expect(outcomes.has(NOW - 400 * DAY)).toBe(true);
    expect(outcomes.has(NOW - 700 * DAY)).toBe(true);
    db.close();
  });
});
