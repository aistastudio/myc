/**
 * ПРИЁМКА ОХВАТА ПАМЯТИ (S58) — сессия против проекта.
 *
 * Формулировка приёмки дословно: знание, записанное как сессионное, живёт в
 * своей сессии и НЕ появляется в `prime` другой; проектное появляется в
 * обеих; в выдаче `recall` охват виден.
 *
 * Здесь это проверяется в одном процессе через публичный run(). Второй
 * половиной приёмки — «переживает сжатие контекста», то есть переживает
 * границу ПРОЦЕССА, — занят ../hooks/reach.session.test.ts: хук сжатия и
 * `prime` живут в разных процессах, и однопоточный тест этого не проверяет.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SESSION_ENV_KEYS } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createPrimeCommand } from "./prime.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand, realRememberDeps, type RememberDeps } from "./remember.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { realStoreDeps } from "./store.ts";

const SESSION_A = "S-alpha";
const SESSION_B = "S-beta";

let dir: string;
let home: string;
let registry: Registry;

function retrieveDeps(): RetrieveDeps {
  return {
    openStore: realStoreDeps.openStore,
    ...realRetrieveExtras,
    // Эмбеддера в тестах нет: охват — свойство узла, а не ветки ретривала.
    resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
  };
}

function rememberDeps(): RememberDeps {
  return { ...realRememberDeps, chatLlm: () => false };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-reach-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  process.env.MYC_HOME = home;
  process.env.MYC_ACTOR = "tester";
  // Список переменных берётся ИЗ РЕЕСТРА, а не переписывается здесь руками:
  // это ровно ловушка S51 — «каждый тест обязан помнить их все» ломается на
  // каждой новой переменной. Она уже сработала: CLAUDE_CODE_SESSION_ID,
  // которую Claude Code кладёт в окружение, протекала внутрь тестов «сессии
  // нет», и «неизвестный охват» переставал быть неизвестным.
  for (const key of SESSION_ENV_KEYS) delete process.env[key];
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createRememberCommand(rememberDeps()));
  registry.register(createPrimeCommand());
  registry.register(createRecallCommand(retrieveDeps()));
});

afterEach(() => {
  delete process.env.MYC_HOME;
  delete process.env.MYC_ACTOR;
  // Список переменных берётся ИЗ РЕЕСТРА, а не переписывается здесь руками:
  // это ровно ловушка S51 — «каждый тест обязан помнить их все» ломается на
  // каждой новой переменной. Она уже сработала: CLAUDE_CODE_SESSION_ID,
  // которую Claude Code кладёт в окружение, протекала внутрь тестов «сессии
  // нет», и «неизвестный охват» переставал быть неизвестным.
  for (const key of SESSION_ENV_KEYS) delete process.env[key];
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

async function env(...args: string[]): Promise<Record<string, unknown>> {
  const r = await myc(...args, "--json");
  return JSON.parse(r.stdout as string) as Record<string, unknown>;
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  return (await env(...args))["data"] as Record<string, unknown>;
}

function titles(rows: unknown): string[] {
  return (rows as Array<{ title: string }>).map((r) => r.title);
}

/**
 * Прямая вставка узла: `myc remember` не умеет задавать salience, а без него
 * не построить окно скана, в котором чужое сессионное вытесняет проектное.
 * Форма строки — та же, что в migrations/schema.test.ts.
 */
function insertNote(args: {
  id: string;
  layer: number;
  salience: number;
  title: string;
  attrs: Record<string, unknown>;
}): void {
  const db = new Database(join(dir, ".myc", "myc.db"));
  // scope берётся из УЖЕ записанного узла, а не угадывается по имени каталога:
  // расхождение здесь дало бы зелёный тест на пустой выборке.
  const scope =
    (db.query<{ scope: string }, []>("SELECT scope FROM nodes LIMIT 1").get()?.scope) ?? "";
  db.query(
    `INSERT INTO nodes (id, kind, scope, layer, salience, status, title, excerpt,
                        content_hash, acl, team_id, attrs, created_at, updated_at)
     VALUES (?1,'note',?2,?3,?4,'active',?5,?5,?6,'team','',?7,1,1)`,
  ).run(
    args.id,
    scope,
    args.layer,
    args.salience,
    args.title,
    `h-${args.id}`,
    JSON.stringify(args.attrs),
  );
  db.close();
}

// ---------------------------------------------------------------------------
// ЗАПИСЬ: умолчание сессионное, проектное — по решению
// ---------------------------------------------------------------------------

describe("myc remember — охват при записи", () => {
  test("умолчание СЕССИОННОЕ: без флага факт принадлежит текущей сессии", async () => {
    const d = await data("remember", "порог absorb поднят до 0.99", "--session", SESSION_A);
    expect(d["reach"]).toBe("session");
    expect(d["session"]).toBe(SESSION_A);
  });

  test("--reach project — явное решение, и только оно делает знание проектным", async () => {
    const d = await data("remember", "И1: prime укладывается в 30 мс", "--reach", "project", "--session", SESSION_A);
    expect(d["reach"]).toBe("project");
    expect(d["session"]).toBe("");
  });

  test("сессия из окружения подхватывается без флага", async () => {
    process.env.MYC_SESSION_ID = SESSION_B;
    const d = await data("remember", "GLM держит packages/web");
    expect(d["reach"]).toBe("session");
    expect(d["session"]).toBe(SESSION_B);
  });

  test("сессии нет — охват НЕ выдумывается, а объявляется неизвестным (И2)", async () => {
    const e = await env("remember", "факт без сессии");
    const d = e["data"] as Record<string, unknown>;
    expect(d["reach"]).toBe("unknown");
    expect(d["session"]).toBe("");
    expect((e["warn"] as { code: string }[]).map((w) => w.code)).toContain("degraded.reach");
  });

  test("человеческий вывод называет охват словом", async () => {
    const own = await myc("remember", "видимый охват", "--session", SESSION_A);
    expect(text(own.stdout)).toContain(`reach session ${SESSION_A}`);
    const proj = await myc("remember", "видимый проектный", "--reach", "project");
    expect(text(proj.stdout)).toContain("reach project");
    const none = await myc("remember", "видимый неизвестный");
    expect(text(none.stdout)).toContain("reach UNKNOWN");
  });

  test("неверный --reach — usage-ошибка, а не молчаливое умолчание", async () => {
    const r = await myc("remember", "x", "--reach", "team");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

// ---------------------------------------------------------------------------
// PRIME: своё видно, чужое нет, проектное везде
// ---------------------------------------------------------------------------

describe("myc prime — фильтр охвата", () => {
  beforeEach(async () => {
    await myc("remember", "сессионный вывод альфы", "--layer", "L3", "--session", SESSION_A);
    await myc("remember", "сессионный вывод беты", "--layer", "L3", "--session", SESSION_B);
    await myc("remember", "проектное правило про бюджеты", "--layer", "L3", "--reach", "project");
  });

  test("ПРИЁМКА: сессионное видно в своей сессии и не видно в чужой; проектное — в обеих", async () => {
    const a = titles((await data("prime", "--session", SESSION_A))["core"]);
    const b = titles((await data("prime", "--session", SESSION_B))["core"]);

    expect(a).toContain("сессионный вывод альфы");
    expect(a).not.toContain("сессионный вывод беты");

    expect(b).toContain("сессионный вывод беты");
    expect(b).not.toContain("сессионный вывод альфы");

    expect(a).toContain("проектное правило про бюджеты");
    expect(b).toContain("проектное правило про бюджеты");
  });

  test("без сессии в контекст не идёт НИЧЬЁ сессионное, но проектное идёт", async () => {
    const d = await data("prime");
    const core = titles(d["core"]);
    expect(core).toEqual(["проектное правило про бюджеты"]);
    expect(d["session"]).toBe("");
    expect(d["reach_hidden"]).toBe(2);
  });

  test("скрытое названо числом, а не просто отсутствует (И2)", async () => {
    const d = await data("prime", "--session", SESSION_A);
    expect(d["reach_hidden"]).toBe(1);
    const out = text((await myc("prime", "--session", SESSION_A)).stdout);
    expect(out).toContain(`session ${SESSION_A.slice(0, 8)}`);
    expect(out).toContain("1 from other sessions hidden");
  });

  test("подвал говорит «сессия не указана», когда её не назвали", async () => {
    expect(text((await myc("prime")).stdout)).toContain("session not specified");
  });

  test("строки дайджеста помечены охватом", async () => {
    const out = text((await myc("prime", "--session", SESSION_A)).stdout);
    expect(out).toContain("сессионный вывод альфы [@session]");
    // Проектное — норма в prime, оно не помечается.
    expect(out).toContain("проектное правило про бюджеты\n");
  });

  test("кеш дайджеста ключуется сессией: A не отдаёт свой дайджест B", async () => {
    const first = await env("prime", "--session", SESSION_A);
    expect((first["meta"] as Record<string, unknown>)["cache"]).toBe("miss");
    const again = await env("prime", "--session", SESSION_A);
    expect((again["meta"] as Record<string, unknown>)["cache"]).toBe("hit");

    // Тот же seq оплога, другая сессия — попадание в чужой кеш было бы
    // обходом фильтра целиком.
    const other = await env("prime", "--session", SESSION_B);
    expect((other["meta"] as Record<string, unknown>)["cache"]).toBe("miss");
    expect(titles((other["data"] as Record<string, unknown>)["core"])).not.toContain(
      "сессионный вывод альфы",
    );
  });

  test("старый узел без охвата виден и посчитан, а не выброшен молча", async () => {
    insertNote({
      id: "legacy-1",
      layer: 3,
      salience: 1.0,
      title: "знание до S58",
      attrs: { tags: ["legacy"] },
    });

    const d = await data("prime", "--session", SESSION_A);
    expect(titles(d["core"])).toContain("знание до S58");
    expect(d["reach_unknown"]).toBe(1);
    expect(text((await myc("prime", "--session", SESSION_A)).stdout)).toContain("1 without reach");
  });
});

describe("myc prime — фильтр стоит ДО LIMIT", () => {
  /**
   * Мутация «фильтровать в JS после LIMIT» проходит все тесты выше и рушится
   * ровно здесь: окно скана (60 строк) целиком забито чужим сессионным, и
   * проектное знание, стоящее в порядке ниже, не доезжает до выдачи вовсе.
   * Это не «медленнее», это отказ.
   */
  test("70 чужих сессионных не вытесняют проектное из выдачи", async () => {
    await myc("remember", "затравка", "--reach", "project");
    for (let i = 0; i < 70; i++) {
      insertNote({
        id: `foreign-${i}`,
        layer: 3,
        salience: 1.0,
        title: `чужой вывод ${i}`,
        attrs: { reach: "session", session_id: SESSION_B },
      });
    }
    // Салиентность НИЖЕ всех чужих: без фильтра в источнике эта строка
    // гарантированно не попадёт в окно скана.
    insertNote({
      id: "project-deep",
      layer: 3,
      salience: 0.01,
      title: "проектное правило в хвосте",
      attrs: { reach: "project" },
    });

    const core = titles((await data("prime", "--session", SESSION_A))["core"]);
    expect(core).toContain("проектное правило в хвосте");
    expect(core.filter((t) => t.startsWith("чужой вывод"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RECALL: сессионное не испаряется, охват виден
// ---------------------------------------------------------------------------

describe("myc recall — охват виден и ищется", () => {
  beforeEach(async () => {
    await myc("remember", "кворум реплик держит альфа", "--session", SESSION_A);
    await myc("remember", "кворум реплик держит бета", "--session", SESSION_B);
    await myc("remember", "кворум реплик считается по проекту", "--reach", "project");
  });

  test("ПРИЁМКА: в выдаче recall охват виден у каждой строки", async () => {
    const out = text((await myc("recall", "кворум", "--session", SESSION_A)).stdout);
    expect(out).toMatch(/L1 ses\s.*альфа/);
    expect(out).toMatch(/L1 ses\*\s.*бета/);
    expect(out).toMatch(/L1 prj\s.*по проекту/);
  });

  test("сессионное чужой сессии НЕ испаряется: явный поиск его находит", async () => {
    const d = await data("recall", "кворум", "--session", SESSION_A);
    expect(titles(d["rows"])).toContain("кворум реплик держит бета");
    expect(d["foreign"]).toBe(1);
  });

  test("--reach сужает выдачу до нужного охвата", async () => {
    const proj = titles((await data("recall", "кворум", "--reach", "project"))["rows"]);
    expect(proj).toEqual(["кворум реплик считается по проекту"]);

    const own = titles(
      (await data("recall", "кворум", "--reach", "session", "--session", SESSION_B))["rows"],
    );
    expect(own).toEqual(["кворум реплик держит бета"]);
  });

  /**
   * Расширение списка не имеет права СУЖАТЬ выдачу — а именно это и делал
   * `--reach project,session`: отсев по сессии применялся ко ВСЕМ строкам, а у
   * проектной `reach_session` пуст по определению, и она отбрасывалась. То
   * есть `project,session` возвращал меньше, чем `project`.
   *
   * Найдено прогоном myc на чужом корпусе (LoCoMo, исследование бенчмарков):
   * `--reach project` дал 40 попаданий, `--reach project,session` — ноль, и
   * этот ноль чуть не попал в отчёт как результат myc.
   */
  test("project,session — это ИЛИ: объединение, а не пересечение", async () => {
    const both = titles(
      (await data("recall", "кворум", "--reach", "project,session", "--session", SESSION_B))["rows"],
    );
    expect(both).toContain("кворум реплик считается по проекту");
    expect(both).toContain("кворум реплик держит бета");

    // И то, что ломать нельзя: чужая сессия в объединение не попадает.
    const fromA = titles(
      (await data("recall", "кворум", "--reach", "project,session", "--session", SESSION_A))["rows"],
    );
    expect(fromA).not.toContain("кворум реплик держит бета");
  });

  test("футер называет числом чужое и неопределённое", async () => {
    const out = text((await myc("recall", "кворум", "--session", SESSION_A)).stdout);
    expect(out).toContain("1 from other sessions");
  });

  test("неверный --reach — usage-ошибка", async () => {
    expect((await myc("recall", "кворум", "--reach", "global")).code).toBe(ExitCode.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Подъём: тот же факт из другой сессии
// ---------------------------------------------------------------------------

describe("подъём сессионного до проектного", () => {
  test("повтор факта из чужой сессии не переносит узел молча, а предупреждает", async () => {
    await myc("remember", "один и тот же вывод", "--session", SESSION_A);
    const e = await env("remember", "один и тот же вывод", "--session", SESSION_B);
    const d = e["data"] as Record<string, unknown>;
    expect(d["duplicate_of"]).toBeDefined();
    expect(d["reach"]).toBe("session");
    expect(d["session"]).toBe(SESSION_A);
    expect((e["warn"] as { code: string }[]).map((w) => w.code)).toContain("degraded.reach");
  });

  test("--reach project поднимает существующий узел — решение принято явно", async () => {
    await myc("remember", "вывод, оказавшийся общим", "--session", SESSION_A);
    const d = await data("remember", "вывод, оказавшийся общим", "--reach", "project", "--session", SESSION_B);
    expect(d["reach_promoted"]).toBe(true);
    expect(d["reach"]).toBe("project");

    // И он немедленно виден в prime ОБЕИХ сессий.
    for (const s of [SESSION_A, SESSION_B]) {
      const rows = await data("recall", "оказавшийся", "--reach", "project", "--session", s);
      expect(titles(rows["rows"])).toContain("вывод, оказавшийся общим");
    }
  });
});
