// Приёмка myc-ye3.6 (S41) и memory-793taba27tmc (R3):
//   S41 — recall находит факт из личного яруса, записанный из ДРУГОГО проекта,
//         и помечает источник;
//   R3  — источников до шестнадцати, они приходят СПИСКОМ с весами, открываются
//         ЛЕНИВО, отбор ограничен потолком и дедлайном, и каждый пропуск назван
//         в выдаче (И2).

import { describe, expect, test } from "bun:test";
import { generateId } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_SOURCES,
  federatedSearch,
  type FederationSource,
} from "./federation.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

/**
 * Часы, которые стоят. Тесты с ними — про потолок, ленивость, веса,
 * дедупликацию и сломанного соседа, а не про дедлайн; на настоящих часах
 * каждый из них утверждал бы заодно «первые источники в памяти успевают за
 * DEFAULT_DEADLINE_MS (18 мс)». Под нагрузкой (yes × 14, load1 31,
 * 2026-09-11) не успевали: тест потолка открыл меньше DEFAULT_MAX_SOURCES
 * источников и упал, ничего не сказав о потолке. Дедлайн проверяется
 * отдельно — на фальшивых часах, которые идут с известной скоростью (ниже).
 */
const STILL = (): number => 0;

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

interface NodeSeed {
  readonly id?: string;
  readonly scope: string;
  readonly title?: string;
  readonly body?: string;
}

function insertNode(db: SqliteDriver, seed: NodeSeed): string {
  const id = seed.id ?? generateId();
  const now = Date.now();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          head_id, content_hash, acl, owner_id, team_id, agent_id,
                          created_at, updated_at)
       VALUES (?1, 'note', 1, ?2, ?3, ?4, ?5, 2, 'active', NULL, ?6, 'team', '', '', '', ?7, ?7)`,
    )
    .run(id, seed.scope, seed.title ?? "", seed.body ?? "", (seed.body ?? "").slice(0, 120), `hash-${id}`, now);
  return id;
}

/** Источник с ленивым open и счётчиком открытий — им и проверяется ленивость. */
function source(
  id: string,
  kind: FederationSource["kind"],
  db: SqliteDriver,
  scope: string,
  extra: { weight?: number; opens?: { count: number } } = {},
): FederationSource {
  return {
    id,
    kind,
    scopes: [scope],
    ...(extra.weight !== undefined ? { weight: extra.weight } : {}),
    open: () => {
      if (extra.opens !== undefined) extra.opens.count++;
      return db;
    },
  };
}

// ===========================================================================
// S41 — источник виден в выдаче
// ===========================================================================

describe("federatedSearch: только свой воркспейс", () => {
  test("один источник — второго запроса нет, source=project на всех хитах", async () => {
    const project = freshDb();
    insertNode(project, { scope: "projA", title: "деплой сервиса orca", body: "команда для отката релиза" });

    const result = await federatedSearch({
      text: "деплой orca",
      caller: ANON,
      sources: [source("project", "project", project, "projA")],
    });

    expect(result.mode_used.personalQueried).toBe(false);
    expect(result.mode_used.personal).toBeUndefined();
    expect(result.mode_used.queried).toBe(1);
    expect(result.mode_used.skipped).toBe(0);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.source === "project" && h.tier === "project")).toBe(true);
    // Прежняя формулировка S41 обязана уцелеть: её читают поверхности.
    expect(result.mode_used.why).toContain("not open");
  });
});

describe("federatedSearch: факт из личного яруса виден в другом проекте (S41)", () => {
  test("recall находит факт, записанный в личный ярус, и помечает источник", async () => {
    const personal = freshDb();
    const factId = insertNode(personal, {
      scope: "me",
      title: "предпочитаю pnpm вместо npm",
      body: "во всех проектах ставь зависимости через pnpm, не npm install",
    });

    const projectB = freshDb();
    insertNode(projectB, { scope: "projB", title: "починить CI", body: "красный пайплайн на main" });

    const result = await federatedSearch({
      text: "pnpm вместо npm",
      caller: ANON,
      clock: STILL,
      sources: [
        source("project", "project", projectB, "projB"),
        source("me", "personal", personal, "me"),
      ],
    });

    expect(result.mode_used.personalQueried).toBe(true);
    const hit = result.hits.find((h) => h.id === factId);
    expect(hit).toBeDefined();
    expect(hit!.tier).toBe("personal");
    expect(hit!.source).toBe("me");
    expect(hit!.tierRank).toBeGreaterThan(0);
  });

  test("узел, найденный в двух источниках, дедуплицируется и приписан первому", async () => {
    const sharedTitle = "конфигурация graft: --no-global по умолчанию";
    const personal = freshDb();
    const shared = insertNode(personal, { scope: "me", id: `me-${"a".repeat(12)}`, title: sharedTitle, body: sharedTitle });

    const project = freshDb();
    insertNode(project, { scope: "projA", id: shared, title: sharedTitle, body: sharedTitle });

    const result = await federatedSearch({
      text: "конфигурация graft",
      caller: ANON,
      clock: STILL,
      sources: [
        source("project", "project", project, "projA"),
        source("me", "personal", personal, "me"),
      ],
    });

    const matches = result.hits.filter((h) => h.id === shared);
    expect(matches.length).toBe(1);
    expect(matches[0]!.source).toBe("project");
    // И2: то, что узел лежит В ОБОИХ, — факт выдачи, а не деталь слияния.
    expect([...matches[0]!.foundIn].sort()).toEqual(["me", "project"]);
  });

  test("mode_used несёт отчёт по каждому источнику отдельно (И2)", async () => {
    const personal = freshDb();
    insertNode(personal, { scope: "me", title: "заметка о ретро", body: "ретро каждую пятницу в 16:00" });
    const project = freshDb();
    insertNode(project, { scope: "projA", title: "заметка о ретро в проекте", body: "локальная договорённость" });

    const result = await federatedSearch({
      text: "ретро",
      caller: ANON,
      clock: STILL,
      sources: [
        source("project", "project", project, "projA"),
        source("me", "personal", personal, "me"),
      ],
    });

    expect(result.mode_used.project.sources).toBeDefined();
    expect(result.mode_used.personal?.sources).toBeDefined();
    expect(result.mode_used.sources.map((r) => r.id)).toEqual(["project", "me"]);
    for (const r of result.mode_used.sources) {
      expect(r.queried).toBe(true);
      expect(r.mode).toBeDefined();
      expect(r.took_ms).toBeGreaterThanOrEqual(0);
    }
  });
});

// ===========================================================================
// R3 — список источников, ленивость, потолок, веса
// ===========================================================================

/** Экосистема: свой воркспейс + N репозиторных, у каждого свой факт. */
function ecosystem(n: number): {
  readonly sources: FederationSource[];
  readonly opens: { count: number };
  readonly dbs: SqliteDriver[];
  readonly idOf: (i: number) => string;
} {
  const opens = { count: 0 };
  const dbs: SqliteDriver[] = [];
  const ids: string[] = [];
  const sources: FederationSource[] = [];
  for (let i = 0; i < n; i++) {
    const db = freshDb();
    const scope = `repo${String(i).padStart(2, "0")}`;
    ids.push(
      insertNode(db, {
        scope,
        title: `ретрай очереди в ${scope}`,
        body: `в ${scope} ретрай очереди сделан экспоненциальным, потолок 30 секунд`,
      }),
    );
    dbs.push(db);
    sources.push(
      source(scope, i === 0 ? "project" : "repo", db, scope, { opens, ...(i === 0 ? {} : { weight: 0.8 }) }),
    );
  }
  return { sources, opens, dbs, idOf: (i) => ids[i]! };
}

describe("R3: список источников вместо двух именованных полей", () => {
  test("хит из репозиторного воркспейса помечен именем этого воркспейса", async () => {
    const eco = ecosystem(4);
    const result = await federatedSearch({
      text: "ретрай очереди",
      caller: ANON,
      clock: STILL,
      limit: 20,
      sources: eco.sources,
    });

    const names = new Set(result.hits.map((h) => h.source));
    expect(names.has("repo00")).toBe(true);
    expect(names.has("repo03")).toBe(true);
    for (const h of result.hits) {
      expect(h.source.length).toBeGreaterThan(0);
      expect(h.tier).toBe(h.source === "repo00" ? "project" : "repo");
    }
    for (const db of eco.dbs) db.close();
  });

  test("вес меньше единицы уступает при РАВНОМ ранге, но из выдачи не исчезает", async () => {
    // Два источника с одинаковым текстом: ранг в своём источнике у обоих 1,
    // значит порядок решает только вес.
    const mine = freshDb();
    const theirs = freshDb();
    const mineId = insertNode(mine, { scope: "a", title: "кеш инвалидируется по oplog.seq", body: "инвалидация кеша" });
    const theirsId = insertNode(theirs, { scope: "b", title: "кеш инвалидируется по oplog.seq", body: "инвалидация кеша" });

    const heavy = await federatedSearch({
      text: "инвалидация кеша",
      caller: ANON,
      clock: STILL,
      sources: [source("mine", "project", mine, "a", { weight: 1.0 }), source("theirs", "repo", theirs, "b", { weight: 0.8 })],
    });
    expect(heavy.hits[0]!.id).toBe(mineId);

    // Перевернём веса — победитель обязан перевернуться вместе с ними,
    // иначе вес в выдаче не участвует и «список с весами» — только слово.
    const flipped = await federatedSearch({
      text: "инвалидация кеша",
      caller: ANON,
      clock: STILL,
      sources: [source("mine", "project", mine, "a", { weight: 0.5 }), source("theirs", "repo", theirs, "b", { weight: 1.0 })],
    });
    expect(flipped.hits[0]!.id).toBe(theirsId);

    mine.close();
    theirs.close();
  });
});

describe("R3: вес — тайбрейк, а не вытеснение", () => {
  test("сосед с весом 0.99 стоит между первой и второй строкой своего воркспейса", async () => {
    // Вклад ранга r из источника с весом w равен w/(60+r). При w=0.99 сосед
    // ранга 1 проигрывает своему рангу 1 и выигрывает у своего ранга 2 —
    // ровно то, что значит «при РАВНОМ ранге свой главнее». При w=0.8 он
    // проигрывал бы своему рангу 16, то есть при limit 12 не появлялся бы
    // вовсе: вес там уже не тайбрейк, а фильтр.
    const mine = freshDb();
    const theirs = freshDb();
    // Три одинаково релевантных узла у себя и три у соседа.
    for (let i = 0; i < 3; i++) {
      insertNode(mine, { scope: "a", title: `дедлайн опроса источников ${i}`, body: "дедлайн опроса" });
      insertNode(theirs, { scope: "b", title: `дедлайн опроса источников ${i}`, body: "дедлайн опроса" });
    }

    const tiebreak = await federatedSearch({
      text: "дедлайн опроса",
      caller: ANON,
      clock: STILL,
      limit: 6,
      sources: [
        source("mine", "project", mine, "a", { weight: 1.0 }),
        source("theirs", "repo", theirs, "b", { weight: 0.99 }),
      ],
    });
    // Чередование: свой, сосед, свой, сосед, …
    expect(tiebreak.hits.slice(0, 4).map((h) => h.source)).toEqual([
      "mine",
      "theirs",
      "mine",
      "theirs",
    ]);

    // Вытеснение: тот же стенд, вес 0.8 — соседа в первых трёх нет вовсе.
    const crowded = await federatedSearch({
      text: "дедлайн опроса",
      caller: ANON,
      clock: STILL,
      limit: 6,
      sources: [
        source("mine", "project", mine, "a", { weight: 1.0 }),
        source("theirs", "repo", theirs, "b", { weight: 0.8 }),
      ],
    });
    expect(crowded.hits.slice(0, 3).every((h) => h.source === "mine")).toBe(true);

    mine.close();
    theirs.close();
  });
});

describe("R3: ленивость — не прошедший отбор не открывается (И1)", () => {
  test("open() зовётся ровно у опрошенных, а не у всех предложенных", async () => {
    const eco = ecosystem(12);
    const result = await federatedSearch({
      text: "ретрай очереди",
      caller: ANON,
      clock: STILL,
      sources: eco.sources,
      maxSources: 3,
    });

    expect(result.mode_used.queried).toBe(3);
    expect(result.mode_used.skipped).toBe(9);
    // Ровно три открытия на двенадцать предложенных источников.
    expect(eco.opens.count).toBe(3);
    for (const db of eco.dbs) db.close();
  });

  test("потолок по умолчанию МЕНЬШЕ экосистемы — иначе он ничего не ограничивает", () => {
    // ~/src/cherry — пятнадцать репозиториев плюс корень (S59), то есть до
    // шестнадцати источников. Потолок, равный этому числу или большему, —
    // имитация потолка: замер (federation.latency.test.ts) даёт 16 источников
    // p50 13.8 мс против 6.7 мс на восьми, при бюджете recall 25 мс на всё
    // вместе с гидратацией и сборкой.
    expect(DEFAULT_MAX_SOURCES).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_MAX_SOURCES).toBeLessThan(16);
    // Дедлайн обязан лежать ВНУТРИ бюджета recall (И1, 25 мс), иначе он не
    // страхует ничего.
    expect(DEFAULT_DEADLINE_MS).toBeGreaterThan(0);
    expect(DEFAULT_DEADLINE_MS).toBeLessThan(25);
  });

  test("потолок по умолчанию — DEFAULT_MAX_SOURCES, и он открывает ровно столько", async () => {
    const eco = ecosystem(16);
    const result = await federatedSearch({
      text: "ретрай очереди",
      caller: ANON,
      clock: STILL,
      sources: eco.sources,
    });
    expect(result.mode_used.cap).toBe(DEFAULT_MAX_SOURCES);
    expect(eco.opens.count).toBe(DEFAULT_MAX_SOURCES);
    expect(result.mode_used.deadlineMs).toBe(DEFAULT_DEADLINE_MS);
    for (const db of eco.dbs) db.close();
  });
});

describe("R3: пропуск НАЗВАН, а не умолчан (И2)", () => {
  test("у каждого пропущенного источника своя причина, и она в отчёте и в why", async () => {
    const eco = ecosystem(6);
    const result = await federatedSearch({
      text: "ретрай очереди",
      caller: ANON,
      clock: STILL,
      sources: eco.sources,
      maxSources: 2,
    });

    const skipped = result.mode_used.sources.filter((r) => !r.queried);
    expect(skipped.map((r) => r.id)).toEqual(["repo02", "repo03", "repo04", "repo05"]);
    for (const r of skipped) {
      expect(r.skipped).toContain("cap of 2");
      expect(r.mode).toBeUndefined();
      expect(r.hits).toBe(0);
    }
    // Отчёт видит ВСЕХ, а не только опрошенных: «опрошено 2 из 6» — это и есть
    // то, чем выдача признаётся неполной.
    expect(result.mode_used.sources.length).toBe(6);
    expect(result.mode_used.why).toContain("queried 2 of 6");
    expect(result.mode_used.why).toContain("skipped 4");
    for (const id of ["repo02", "repo03", "repo04", "repo05"]) {
      expect(result.mode_used.why).toContain(id);
    }
    for (const db of eco.dbs) db.close();
  });

  test("дедлайн останавливает опрос и называет, на каком источнике", async () => {
    const eco = ecosystem(5);
    // Фальшивые часы: каждый вызов +4 мс. Дедлайн 10 мс — на третьем источнике
    // он обязан быть исчерпан.
    let t = 0;
    const result = await federatedSearch({
      text: "ретрай очереди",
      caller: ANON,
      sources: eco.sources,
      deadlineMs: 10,
      clock: () => (t += 4),
    });

    expect(result.mode_used.queried).toBeLessThan(5);
    expect(result.mode_used.queried).toBeGreaterThan(0);
    const skipped = result.mode_used.sources.filter((r) => !r.queried);
    expect(skipped.length).toBeGreaterThan(0);
    for (const r of skipped) expect(r.skipped).toContain("deadline 10 ms exhausted");
    // Ленивость под дедлайном та же: открыто ровно опрошенное.
    expect(eco.opens.count).toBe(result.mode_used.queried);
    for (const db of eco.dbs) db.close();
  });

  test("первый источник опрашивается даже при нулевом дедлайне — пустота хуже просрочки", async () => {
    const eco = ecosystem(4);
    let t = 0;
    const result = await federatedSearch({
      text: "ретрай очереди",
      caller: ANON,
      sources: eco.sources,
      deadlineMs: 0,
      clock: () => (t += 1),
    });
    expect(result.mode_used.queried).toBe(1);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.mode_used.sources[0]!.queried).toBe(true);
    for (const db of eco.dbs) db.close();
  });
});

describe("R3: сломанный сосед не роняет чтение своего воркспейса", () => {
  test("падение open() соседа уходит в skipped, выдача остаётся", async () => {
    const project = freshDb();
    insertNode(project, { scope: "a", title: "аренда задачи", body: "аренда клейма 30 минут" });
    const alive = freshDb();
    insertNode(alive, { scope: "c", title: "аренда в соседнем репозитории", body: "аренда клейма и оплог" });

    const result = await federatedSearch({
      text: "аренда клейма",
      caller: ANON,
      clock: STILL,
      sources: [
        source("project", "project", project, "a"),
        {
          id: "broken",
          kind: "repo",
          scopes: ["b"],
          open: () => {
            throw new Error("база занята другим процессом");
          },
        },
        source("alive", "repo", alive, "c"),
      ],
    });

    expect(result.hits.length).toBeGreaterThan(0);
    const broken = result.mode_used.sources.find((r) => r.id === "broken")!;
    expect(broken.queried).toBe(false);
    expect(broken.skipped).toContain("failed to open");
    expect(broken.skipped).toContain("база занята другим процессом");
    // Сосед ПОСЛЕ сломанного всё равно опрашивается: одна поломка не обрывает
    // список.
    expect(result.mode_used.sources.find((r) => r.id === "alive")!.queried).toBe(true);
    project.close();
    alive.close();
  });

  test("падение СВОЕГО воркспейса — ошибка наружу, а не тихая пустота", async () => {
    await expect(
      federatedSearch({
        text: "что угодно",
        caller: ANON,
        sources: [
          {
            id: "project",
            kind: "project",
            scopes: ["a"],
            open: () => {
              throw new Error("схема отстала");
            },
          },
        ],
      }),
    ).rejects.toThrow("схема отстала");
  });

  test("пустой список источников — ошибка, а не пустая выдача", async () => {
    await expect(
      federatedSearch({ text: "что угодно", caller: ANON, sources: [] }),
    ).rejects.toThrow("at least one source");
  });
});
