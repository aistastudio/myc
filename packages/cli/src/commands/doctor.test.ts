/**
 * `myc doctor` через публичный run() — тот же путь, что видит пользователь.
 *
 * Проверяется не «печатается ли отчёт», а три вещи, ради которых команда и
 * существует:
 *   1. на здоровом воркспейсе выход 0, и ни один пункт не назван «ok» зря;
 *   2. испорченное руками состояние ловится и даёт НЕНУЛЕВОЙ выход;
 *   3. «не проверено» и «не срабатывал» — разные ответы (И2), и разница
 *      зависит не от настроения, а от того, отмечает ли хук себя.
 *
 * Отдельный тест держит границу «doctor не чинит»: сверка замыкания гоняет
 * настоящую applyRebuild в транзакции, и единственное доказательство отката —
 * что база после запуска побайтно та же.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { generateId } from "@myc/core";
import { GraphStore, migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { openDriver, type CliDriver } from "./store.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import type { DoctorData } from "./doctor.ts";

let dir: string;
let dbPath: string;
let registry: Registry;

/** Полный реестр: разделу --hooks нужно знать состав ЭТОЙ сборки. */
function makeRegistry(): Registry {
  const r = new Registry();
  registerAll(r);
  return r;
}

function doctor(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, "doctor", ...args], { registry });
}

function text(res: RunResult): string {
  const out = typeof res.stdout === "string" ? res.stdout : [...(res.stdout ?? [])].join("");
  return out + (res.stderr ?? "");
}

interface Envelope {
  readonly ok: boolean;
  readonly data?: DoctorData;
  readonly error?: { code: string; msg: string };
  readonly warn?: Array<{ code: string; msg: string }>;
}

/**
 * Строка отчёта про событие хука — из конверта успеха или из текста отказа.
 * Отчёт печатается одним и тем же рендером в обоих исходах, и читать его
 * одинаково — это и есть проверяемое свойство.
 */
function hookLine(env: Envelope, event: string): string {
  const fromData = env.data?.hooks?.hooks.find((h) => h.event === event);
  if (fromData !== undefined) return `${fromData.verdict}|${fromData.detail}`;
  const line = (env.error?.msg ?? "").split("\n").find((l) => l.includes(`${event}:`));
  return line ?? "";
}

async function envelope(...args: string[]): Promise<Envelope> {
  const res = await doctor(...args, "--json");
  return JSON.parse(String(res.stdout)) as Envelope;
}

/** Журнал `myc wire` с перечисленными событиями хоста Claude. */
/**
 * `ageMs` — сколько назад был позван `myc wire`. По умолчанию давно: почти
 * всякий тест здесь проверяет установившееся состояние, а не первую минуту
 * после настройки, и молодость журнала там только мешала бы.
 */
function writeWireJournal(events: readonly string[], ageMs = 7 * 24 * 60 * 60 * 1000): void {
  writeFileSync(
    join(dir, ".myc", "wire.json"),
    JSON.stringify({
      v: 1,
      written_at: Date.now() - ageMs,
      agents: ["claude"],
      entries: [{ path: ".claude/settings.json", kind: "merge", nodes: events.map((e) => `hooks.${e}`), hash: "x" }],
    }),
  );
}

function writeCounters(key: string, count: number): void {
  writeFileSync(
    join(dir, ".myc", "hooks.json"),
    JSON.stringify({
      v: 1,
      hooks: { [key]: { count, last_at: 1_700_000_000_000, last_ms: 12, last_status: "ok" } },
    }),
  );
}

/**
 * Настоящий CLI-драйвер, а не самодельный: GraphStore при конструировании
 * читает оплог и метаданные, и подделка контракта драйвера ломается на первом
 * же таком чтении.
 */
function open(): { driver: CliDriver; store: GraphStore } {
  const driver = openDriver(dbPath);
  const store = new GraphStore(driver, { newId: generateId, actor: "t", siteId: "s" });
  return { driver, store };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-doctor-"));
  mkdirSync(join(dir, ".myc"));
  dbPath = join(dir, ".myc", "myc.db");
  const raw = new Database(dbPath, { create: true });
  raw.exec("PRAGMA journal_mode = WAL");
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = makeRegistry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("myc doctor: здоровый воркспейс", () => {
  test("три раздела и выход 0", async () => {
    const res = await doctor();
    expect(res.code).toBe(ExitCode.OK);
    const out = text(res);
    expect(out).toContain("схема");
    expect(out).toContain("счётчики");
    expect(out).toContain("хуки");
  });

  test("в конверте — все три раздела и вердикт по каждому пункту", async () => {
    const env = await envelope();
    expect(env.ok).toBe(true);
    expect(env.data?.sections).toEqual(["schema", "recount", "hooks"]);
    expect(env.data?.ok).toBe(true);
    const names = (env.data?.recount?.checks ?? []).map((c) => c.name);
    expect(names).toEqual(["open_blockers", "anc_blockers", "parent_closure"]);
  });

  test("флаг сужает вывод до одного раздела", async () => {
    const env = await envelope("--recount");
    expect(env.data?.sections).toEqual(["recount"]);
    expect(env.data?.schema).toBeUndefined();
  });

  /**
   * Пункт, который НЕ проверяли, не имеет права называться «ok». Векторный и
   * swarm-наборы на свежей базе не накатаны, и это «н/д», а не «в порядке».
   */
  test("непроверенное не называется «ок»", async () => {
    const env = await envelope("--schema");
    const vec = env.data?.schema?.checks.find((c) => c.name === "векторы");
    expect(vec?.verdict).toBe("n/a");
    expect(vec?.detail).toContain("по потребности");
  });
});

describe("myc doctor --recount: испорченное состояние", () => {
  test("расхождение open_blockers ловится и даёт ненулевой выход", async () => {
    const { driver, store } = open();
    const a = store.createNode({ kind: "task", scope: "s", title: "жертва" });
    driver.database.run("UPDATE nodes SET open_blockers = 7 WHERE id = ?1", [a.id]);
    driver.close();

    const res = await doctor("--recount");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain(`${a.id}: в базе 7, пересчёт 0`);

    const env = await envelope("--recount");
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("precond.drift");
    // Находка обязана быть и в warn[]: конверт отказа несёт только code/msg,
    // и без диагностик агент не узнал бы, ЧТО именно разошлось.
    expect((env.warn ?? []).map((w) => w.code)).toContain("doctor.drift");
  });

  test("расхождение parent_closure ловится, и doctor НЕ чинит базу", async () => {
    const { driver, store } = open();
    const epic = store.createNode({ kind: "task", scope: "s", title: "эпик" });
    const child = store.createNode({ kind: "task", scope: "s", title: "ребёнок" });
    const grand = store.createNode({ kind: "task", scope: "s", title: "внук" });
    store.addEdge(child.id, "parent", epic.id);
    store.addEdge(grand.id, "parent", child.id);
    driver.database.run("DELETE FROM parent_closure WHERE depth = 2");
    const rowsBefore = driver.database
      .query("SELECT count(*) AS n FROM parent_closure")
      .get() as { n: number };
    driver.close();

    const res = await doctor("--recount");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain("parent_closure");
    expect(text(res)).toContain(`${epic.id}→${grand.id}@2`);

    // Сверка гоняет настоящую applyRebuild — единственное доказательство
    // отката в том, что строк осталось столько же, сколько было.
    const after = new Database(dbPath);
    const rowsAfter = after.query("SELECT count(*) AS n FROM parent_closure").get() as { n: number };
    after.close();
    expect(rowsAfter.n).toBe(rowsBefore.n);
  });

  test("здоровое замыкание расхождением не объявляется", async () => {
    const { driver, store } = open();
    const epic = store.createNode({ kind: "task", scope: "s", title: "эпик" });
    const child = store.createNode({ kind: "task", scope: "s", title: "ребёнок" });
    store.addEdge(child.id, "parent", epic.id);
    driver.close();
    const env = await envelope("--recount");
    expect(env.ok).toBe(true);
  });
});

describe("myc doctor --schema", () => {
  /**
   * Ради этого случая команда и написана. Обычный путь открытия базы, которая
   * новее бинаря, отказывает с `precond.schema` и советует `myc doctor
   * --schema`; если бы doctor шёл тем же путём, совет вёл бы в ту же ошибку.
   */
  test("работает на базе НОВЕЕ бинаря — там, куда ведёт подсказка", async () => {
    const db = new Database(dbPath);
    db.run(
      "INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (?1,?2,?3,?4)",
      [999, "из-будущего", "deadbeef", 0],
    );
    db.close();

    const env = await envelope("--schema");
    expect(env.error?.code).toBe("precond.drift"); // а НЕ precond.schema от миграции
    const version = env.data?.schema?.checks.find((c) => c.name === "версия");
    expect(env.error?.msg).toContain("база новее бинаря");
    expect(version ?? env.error?.msg).toBeDefined();
  });

  test("лишний объект в базе назван поимённо", async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE future_thing (id TEXT PRIMARY KEY)");
    db.close();
    const res = await doctor("--schema");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain("лишний в базе: table:future_thing");
  });

  test("пропавший объект тоже назван", async () => {
    const db = new Database(dbPath);
    db.exec("DROP TABLE IF EXISTS digest_cache");
    db.close();
    const res = await doctor("--schema");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain("нет в базе: table:digest_cache");
  });
});

describe("myc doctor --hooks: «не знаю» и «не срабатывал» — разные ответы", () => {
  test("без журнала wire про хуки честно сказано «не знаю»", async () => {
    const env = await envelope("--hooks");
    const start = env.data?.hooks?.hooks.find((h) => h.event === "session-start");
    expect(start?.verdict).toBe("unknown");
    expect(start?.detail).toContain("wire.json");
    expect(env.ok).toBe(true); // «не знаю» — не расхождение
  });

  test("сработавший хук назван числом и временем", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    writeCounters("claude:pre-compact", 3);
    const env = await envelope("--hooks");
    const pre = env.data?.hooks?.hooks.find((h) => h.event === "pre-compact");
    expect(pre?.verdict).toBe("ok");
    expect(pre?.count).toBe(3);
    expect(pre?.detail).toContain("срабатывал 3 раз");
  });

  /**
   * ГЛАВНАЯ ПРОВЕРКА РАЗДЕЛА. Счётчика нет в обоих случаях, а ответы разные:
   * pre-compact себя отмечает, значит «не срабатывал» — утверждение; о
   * session-start сказать нечего, потому что `myc prime` зовут и хуком, и
   * руками (memory-q9k2zxfx2mcm). Свести их к одному ответу — соврать.
   */
  test("одинаково пустой счётчик даёт разные вердикты по разным событиям", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    const res = await doctor("--hooks");
    expect(res.code).toBe(ExitCode.PRECOND); // «не срабатывал» — расхождение
    const env = await envelope("--hooks");
    expect(hookLine(env, "pre-compact")).toContain("не срабатывал ни разу");
    expect(hookLine(env, "session-start")).toContain("себя не отмечает");
    expect(hookLine(env, "session-start")).toContain("не знаю");
  });

  /**
   * Первая минута после `myc wire` — не расхождение. `pre-compact` ждёт
   * сжатия контекста, оно случается через часы; объявив это расхождением,
   * doctor встречал бы человека ненулевым кодом сразу после настройки.
   * Проверяются ОБЕ стороны порога: молчание молодого хука — «не знаю»,
   * молчание старого — расхождение. Проверка одной стороны пропустила бы
   * мутацию, снимающую порог целиком.
   */
  test("свежепоставленный хук молчит законно, застаревший — уже нет", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"], 60_000);
    expect((await doctor("--hooks")).code).toBe(ExitCode.OK);
    const fresh = await envelope("--hooks");
    expect(hookLine(fresh, "pre-compact")).toContain("не знаю");
    expect(hookLine(fresh, "pre-compact")).toContain("не было повода случиться");

    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"], 2 * 24 * 60 * 60 * 1000);
    expect((await doctor("--hooks")).code).toBe(ExitCode.PRECOND);
    expect(hookLine(await envelope("--hooks"), "pre-compact")).toContain("не срабатывал ни разу");
  });

  test("не поставленное событие названо не поставленным, а не «не срабатывало»", async () => {
    writeWireJournal(["SessionStart", "PreCompact"]);
    writeCounters("claude:pre-compact", 1);
    const res = await doctor("--hooks");
    expect(res.code).toBe(ExitCode.PRECOND);
    const env = await envelope("--hooks");
    expect(hookLine(env, "post-edit")).toContain("не поставлен");
    expect(hookLine(env, "post-edit")).toContain("нет в журнале");
  });

  /**
   * Хук на команду, которой в сборке нет, `myc wire` не ставит намеренно.
   * Это свойство сборки, а не поломка воркспейса: объяви его расхождением —
   * и ни один воркспейс никогда не даст выход 0.
   */
  test("событие без команды в сборке — «н/д», и оно не портит код выхода", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    writeCounters("claude:pre-compact", 1);
    const env = await envelope("--hooks");
    const stop = env.data?.hooks?.hooks.find((h) => h.event === "stop");
    expect(stop?.verdict).toBe("n/a");
    expect(stop?.detail).toContain("нет в этой сборке");
    expect(env.ok).toBe(true);
  });
});

describe("myc doctor: воркспейса нет", () => {
  test("отказ называет, где искали, и не притворяется здоровьем", async () => {
    const empty = mkdtempSync(join(tmpdir(), "myc-doctor-empty-"));
    process.env.MYC_HOME = empty;
    try {
      const res = await run(["-C", empty, "doctor", "--json"], { registry });
      const env = JSON.parse(String(res.stdout)) as Envelope;
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("ws.not_initialized");
      expect(res.code).toBe(ExitCode.NOWS);
    } finally {
      delete process.env.MYC_HOME;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("отчёт читается одинаково на нуле и на ненуле", () => {
  /**
   * Успех печатает отчёт из data, отказ — из msg. Рендер обязан быть один:
   * два разошлись бы, и «что именно сломано» на ненулевом коде выхода
   * выглядело бы иначе, чем на нулевом.
   */
  test("текст отказа содержит те же строки разделов, что и успешный вывод", async () => {
    const ok = text(await doctor("--recount"));
    const { driver, store } = open();
    const a = store.createNode({ kind: "task", scope: "s", title: "жертва" });
    driver.database.run("UPDATE nodes SET anc_blockers = 3 WHERE id = ?1", [a.id]);
    driver.close();
    const bad = text(await doctor("--recount"));

    for (const line of ["счётчики", "open_blockers", "anc_blockers", "parent_closure"]) {
      expect(ok).toContain(line);
      expect(bad).toContain(line);
    }
    expect(readFileSync(dbPath).length).toBeGreaterThan(0);
  });
});
