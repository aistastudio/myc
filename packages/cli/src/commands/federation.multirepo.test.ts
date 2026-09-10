/**
 * Приёмка R3 (memory-793taba27tmc) на настоящей ФС и настоящем SQLite:
 * `recall` ИЗ КОРНЯ экосистемы находит знание из репозиторных воркспейсов,
 * каждая строка помечена источником, а всё, что опрошено НЕ БЫЛО, названо в
 * подвале числом и причиной (И2).
 *
 * Экосистема здесь построена ровно как в S59: корень со своим `.myc`, внутри
 * — самостоятельные репозитории, часть из которых имеет СВОЙ воркспейс.
 * Репозиторий без `.myc` в федерацию не входит: его знание и так лежит в
 * корневом (R1).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { createSearchCommand } from "./search.ts";
import { discoverRepoWorkspaces, realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { realStoreDeps } from "./store.ts";
import { expectMsWithinBudget } from "@myc/bench";

let root: string;
let home: string;
let registry: Registry;

const noEmbedder: Pick<RetrieveDeps, "resolveEmbedder"> = {
  resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
};

function retrieveDeps(): RetrieveDeps {
  return { openStore: realStoreDeps.openStore, ...realRetrieveExtras, ...noEmbedder };
}

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
  r.register(createRecallCommand(retrieveDeps()));
  r.register(createSearchCommand(retrieveDeps()));
  return r;
}

/** Воркспейс на диске: `.myc/myc.db` с накатанной схемой; `.git` — как у S59. */
async function makeWorkspace(dir: string, opts: { git?: boolean } = {}): Promise<void> {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  if (opts.git !== false) mkdirSync(join(dir, ".git"), { recursive: true });
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
}

function mycAt(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  meta: Record<string, unknown> & { degraded: string[] };
  warn: { code: string; msg: string }[];
}

async function jsonAt(dir: string, ...args: string[]): Promise<Envelope> {
  const r = await mycAt(dir, ...args, "--json");
  return JSON.parse(text(r.stdout)) as Envelope;
}

interface Row {
  readonly id: string;
  readonly source: string;
  readonly tier: string;
  readonly title: string;
}

interface Federation {
  readonly queried: string[];
  readonly skipped: { id: string; why: string }[];
  readonly total: number;
  readonly cap: number;
  readonly took_ms: number;
}

beforeEach(async () => {
  // Домашний каталог ВНЕ корня экосистемы: иначе личный ярус (~/.myc) попал бы
  // в перечисление соседей — та же база под двумя источниками.
  const box = mkdtempSync(join(tmpdir(), "myc-fed-"));
  root = join(box, "cherry");
  home = join(box, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  await makeWorkspace(root);
  registry = makeRegistry();
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

// ===========================================================================
// Приёмка: знание соседа найдено и помечено
// ===========================================================================

describe("R3: recall из корня видит репозиторные воркспейсы", () => {
  test("факт соседнего репозитория найден и помечен именем его воркспейса", async () => {
    const collector = join(root, "collector");
    await makeWorkspace(collector);
    await mycAt(collector, "remember", "коллектор батчит события по 500 штук перед отправкой");

    await mycAt(root, "remember", "корневая заметка про батчи релизного процесса");

    const env = await jsonAt(root, "recall", "батчит события", "--repo", "all");
    const rows = env.data["rows"] as Row[];
    const fromCollector = rows.find((r) => r.source === "collector");
    expect(fromCollector).toBeDefined();
    expect(fromCollector!.tier).toBe("repo");
    expect(fromCollector!.title).toContain("коллектор батчит события");

    // Каждая строка помечена источником — без исключений.
    for (const r of rows) expect(r.source.length).toBeGreaterThan(0);

    const human = text((await mycAt(root, "recall", "батчит события", "--repo", "all")).stdout);
    expect(human).toContain("@collector");
  });

  test("три соседа — три источника, у каждой строки свой", async () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const dir = join(root, name);
      await makeWorkspace(dir);
      await mycAt(dir, "remember", `в ${name} очередь ретраев экспоненциальная, потолок 30 секунд`);
    }
    await mycAt(root, "remember", "в корне очередь ретраев описана общим решением");

    // Бюджет задан с запасом НАМЕРЕННО: проверяется федерация источников, а
    // не усечение хвоста. С умолчанием (2000 символов) четыре источника
    // умещаются не всегда — на раннере CI выпал `gamma`, и тест сообщил о
    // работающей обрезке как о неработающей федерации.
    const env = await jsonAt(
      root, "recall", "очередь ретраев", "-n", "20", "--repo", "all", "--budget", "20000",
    );
    const rows = env.data["rows"] as Row[];
    const sources = new Set(rows.map((r) => r.source));
    // Если источник всё-таки пропал, отчёт должен назвать, кто пришёл и что
    // сказала федерация, — иначе разбор снова упрётся в голое `false`.
    if (sources.size < 4) {
      console.log(
        `[диагностика] источников ${sources.size}: ${[...sources].join(", ")}; ` +
          `строк ${rows.length}; federation=${JSON.stringify(env.meta["federation"])}`,
      );
    }
    expect(sources.has("project")).toBe(true);
    expect(sources.has("alpha")).toBe(true);
    expect(sources.has("beta")).toBe(true);
    expect(sources.has("gamma")).toBe(true);

    const fed = env.meta["federation"] as Federation;
    expect(fed.queried).toEqual(["project", "alpha", "beta", "gamma"]);
    expect(fed.skipped).toEqual([]);
    expect(fed.total).toBe(4);
  });

  test("репозиторий БЕЗ своего воркспейса источником не становится", async () => {
    const plain = join(root, "no-workspace");
    mkdirSync(join(plain, ".git"), { recursive: true });
    await mycAt(root, "remember", "заметка про воркспейсы и федерацию");

    const env = await jsonAt(root, "recall", "воркспейсы");
    const fed = env.meta["federation"] as Federation;
    expect(fed.total).toBe(1);
    expect(fed.queried).toEqual(["project"]);
  });

  test("из САМОГО репозитория соседей не опрашивают — свой воркспейс один", async () => {
    const collector = join(root, "collector");
    await makeWorkspace(collector);
    await mycAt(collector, "remember", "коллектор пишет метрики в otlp");
    const other = join(root, "portal");
    await makeWorkspace(other);
    await mycAt(other, "remember", "портал пишет метрики в prometheus");

    // R1: `.myc` найден в самом collector, подъём до корня не нужен, и
    // соседи корня в федерацию не входят — иначе `myc recall` в одном
    // репозитории молча читал бы базы всех остальных.
    const env = await jsonAt(collector, "recall", "пишет метрики", "--repo", "all");
    const fed = env.meta["federation"] as Federation;
    expect(fed.queried).toEqual(["project"]);
    const rows = env.data["rows"] as Row[];
    expect(rows.every((r) => r.source === "project")).toBe(true);
    expect(rows.some((r) => r.title.includes("prometheus"))).toBe(false);
  });
});

// ===========================================================================
// И2: потолок объяснён, а не молчалив
// ===========================================================================

describe("R3: пропущенный источник назван в выдаче (И2)", () => {
  test("потолок отсекает хвост, подвал называет число, имена и причину", async () => {
    for (const name of ["r01", "r02", "r03", "r04", "r05"]) {
      const dir = join(root, name);
      await makeWorkspace(dir);
      await mycAt(dir, "remember", `в ${name} инвалидация кеша идёт по oplog.seq`);
    }
    await mycAt(root, "remember", "в корне инвалидация кеша описана решением");

    const env = await jsonAt(root, "recall", "инвалидация кеша", "--sources", "3", "--repo", "all");
    const fed = env.meta["federation"] as Federation;
    expect(fed.cap).toBe(3);
    expect(fed.queried).toEqual(["project", "r01", "r02"]);
    expect(fed.skipped.map((s) => s.id)).toEqual(["r03", "r04", "r05"]);
    for (const s of fed.skipped) expect(s.why).toContain("cap of 3");

    // Пропуск обязан дойти до WARN-строк, а не только до подвала: выдача НЕ
    // полна, и под --strict это деградация, а не успех.
    const warned = env.warn.map((w) => w.msg).join(" ");
    expect(warned).toContain("source r03 not queried");
    expect(warned).toContain("source r05 not queried");
    expect(env.meta.degraded).toContain("degraded.retrieval");

    const human = text(
      (await mycAt(root, "recall", "инвалидация кеша", "--sources", "3", "--repo", "all")).stdout,
    );
    expect(human).toContain("3 of 6 sources");
    expect(human).toContain("r03, r04, r05");
    expect(human).toContain("cap of 3");
  });

  test("--why даёт строку на КАЖДЫЙ источник, включая пропущенные", async () => {
    for (const name of ["r01", "r02"]) {
      const dir = join(root, name);
      await makeWorkspace(dir);
      await mycAt(dir, "remember", `в ${name} аренда клейма живёт 30 минут`);
    }
    await mycAt(root, "remember", "в корне аренда клейма описана решением");

    const human = text(
      (await mycAt(root, "recall", "аренда клейма", "--sources", "2", "--why", "--repo", "all"))
        .stdout,
    );
    expect(human).toContain("project   vector=");
    expect(human).toContain("r01       vector=");
    expect(human).toMatch(/r02\s+skipped · over the cap of 2/);
  });

  test("непрошенный источник попадает в WARN — а значит и в exit 6 под --strict", async () => {
    const dir = join(root, "r01");
    await makeWorkspace(dir);
    await mycAt(dir, "remember", "в r01 дренаж оплога идёт пачками");
    await mycAt(root, "remember", "в корне дренаж оплога описан решением");

    // Прямая проверка exit-кода здесь ничего не доказывает: в тестах нет
    // эмбеддера, и --strict даёт 6 уже из-за него. Доказывает СОСТАВ WARN:
    // без потолка про источники не сказано ничего, с потолком — сказано.
    const full = await jsonAt(root, "recall", "дренаж оплога", "--repo", "all");
    expect(full.warn.some((w) => w.msg.includes("not queried"))).toBe(false);

    const capped = await jsonAt(root, "recall", "дренаж оплога", "--sources", "1", "--repo", "all");
    expect(capped.warn.some((w) => w.msg.includes("source r01 not queried"))).toBe(true);
    const stricted = await mycAt(
      root,
      "--strict",
      "recall",
      "дренаж оплога",
      "--sources",
      "1",
      "--repo",
      "all",
    );
    expect(stricted.code).not.toBe(0);
  });
});

// ===========================================================================
// И1: ленивость — соседей перечисляют, но не открывают
// ===========================================================================

describe("R3: ленивость на настоящей ФС", () => {
  test("перечисление шестнадцати соседей стоит доли миллисекунды и не открывает баз", async () => {
    const names: string[] = [];
    for (let i = 0; i < 16; i++) {
      const name = `repo${String(i).padStart(2, "0")}`;
      names.push(name);
      await makeWorkspace(join(root, name));
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(join(root, name, ".myc", `myc.db${suffix}`), { force: true });
      }
    }

    const t0 = performance.now();
    const found = discoverRepoWorkspaces(root);
    const took = performance.now() - t0;

    expect(found.map((w) => w.id)).toEqual(names);
    // Перечисление — readdir + по одному existsSync: если бы оно открывало
    // базы, стоило бы миллисекунд, а не долей, и оставило бы WAL-файлы.
    expectMsWithinBudget(took, 5, "федерация: опрос соседей");
    for (const name of names) {
      expect(existsSync(join(root, name, ".myc", "myc.db-wal"))).toBe(false);
    }
  });

  test("сосед, который НЕ прошёл потолок, не получает WAL-файла — база не открывалась", async () => {
    const names = ["r01", "r02", "r03"];
    for (const name of names) {
      const dir = join(root, name);
      await makeWorkspace(dir);
      await mycAt(dir, "remember", `в ${name} миграция схемы накатывается при открытии`);
    }
    await mycAt(root, "remember", "в корне миграция схемы описана решением");
    // Записи выше уже оставили WAL; убираем его, чтобы появление файла ниже
    // означало ровно одно — базу открыли этим recall'ом.
    for (const name of names) {
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(join(root, name, ".myc", `myc.db${suffix}`), { force: true });
      }
    }

    await mycAt(root, "recall", "миграция схемы", "--sources", "2", "--repo", "all");

    const walOf = (name: string): boolean =>
      existsSync(join(root, name, ".myc", "myc.db-wal"));
    // Потолок 2 = свой воркспейс + r01. r02 и r03 не открывались вовсе.
    expect(walOf("r01")).toBe(true);
    expect(walOf("r02")).toBe(false);
    expect(walOf("r03")).toBe(false);
  });
});

// ===========================================================================
// Веса: сосед участвует, но при равном ранге уступает своему
// ===========================================================================

describe("R3: веса источников", () => {
  test("при одинаковом тексте свой воркспейс идёт выше соседского", async () => {
    const dir = join(root, "r01");
    await makeWorkspace(dir);
    const fact = "хеш содержимого считается от kind, title и body";
    await mycAt(dir, "remember", fact);
    await mycAt(root, "remember", fact);

    const env = await jsonAt(root, "recall", "хеш содержимого", "-n", "5", "--repo", "all");
    const rows = env.data["rows"] as Row[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.source).toBe("project");
  });
});
