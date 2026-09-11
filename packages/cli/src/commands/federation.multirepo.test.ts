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
import { expectMsWithinBudget, isStrict, JITTER_MAX, probeJitter } from "@myc/bench";

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

/**
 * ДЕДЛАЙН ФЕДЕРАЦИИ — АБСОЛЮТ ВНУТРИ ПРОДУКТА. `recall` опрашивает соседей,
 * пока не истекли DEFAULT_DEADLINE_MS (18 мс) стенного времени, и остальных
 * пропускает с причиной «deadline … exhausted». Шва, чтобы снять дедлайн в
 * CLI-тесте, нет (`federationDeadlineMs` в retrieve.ts ничем не выставляется;
 * unit-тесты федерации для этого подставляют часы), поэтому утверждение «все
 * соседи опрошены» здесь молча содержало «и уложились в 18 мс на этой машине».
 * 2026-09-11, полный прогон под yes × 14 (load1 до 102): `gamma` пропущен —
 * «deadline 18 ms exhausted at source #3 (spent 18.5 ms)», — тест упал, хотя
 * продукт сделал ровно то, что должен.
 *
 * Правило, как у абсолютов @myc/bench: пропуск по дедлайну допустим, только
 * если он НАЗВАН и машина измеренно занята (проба дрожания эталона); тогда
 * утверждения о пропущенных не проверяются — громко, с перечнем. На свободной
 * машине (в том числе на раннере CI: калибровка тут ни при чём, четыре
 * крошечных воркспейса укладываются в 18 мс и на 4 ядрах x86) и в строгом
 * режиме пропуск по дедлайну — провал: так ловится «дедлайн укоротили».
 * Обнаружение, порядок, потолок и имена проверяются всегда.
 */
function excuse(what: string, detail: string): void {
  if (!isStrict()) {
    const p = probeJitter();
    if (p.jitter > JITTER_MAX) {
      console.log(`[bench] ${what}: ${detail} — допущено: машина занята, дрожание эталона ×${p.jitter.toFixed(2)} > ${JITTER_MAX}`);
      return;
    }
    throw new Error(
      `${what}: ${detail} на свободной машине (дрожание эталона ×${p.jitter.toFixed(2)} <= ${JITTER_MAX}) — это регрессия, а не загрузка`,
    );
  }
  throw new Error(`${what}: ${detail} в строгом режиме`);
}

/** Источники, пропущенные по дедлайну (и только они), — допущенные `excuse`. */
function excusedLate(fed: Federation, what: string): string[] {
  const late = fed.skipped.filter((s) => /^deadline \d+ ms exhausted at source #\d+/.test(s.why));
  if (late.length > 0) excuse(what, `по дедлайну пропущены ${late.map((s) => `${s.id} (${s.why})`).join(", ")}`);
  return late.map((s) => s.id);
}

/** То же для человеческого вывода: причина обязана быть названа в тексте. */
function excuseLateText(human: string, what: string): void {
  expect(human).toContain("deadline");
  excuse(what, "в подвале опрошено меньше, причина — дедлайн");
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
    // Каждая строка помечена источником — без исключений.
    for (const r of rows) expect(r.source.length).toBeGreaterThan(0);
    const fed = env.meta["federation"] as Federation;
    expect([...fed.queried, ...fed.skipped.map((s) => s.id)]).toEqual(["project", "collector"]);
    if (!excusedLate(fed, "факт соседа").includes("collector")) {
      const fromCollector = rows.find((r) => r.source === "collector");
      expect(fromCollector).toBeDefined();
      expect(fromCollector!.tier).toBe("repo");
      expect(fromCollector!.title).toContain("коллектор батчит события");
    }

    const human = text((await mycAt(root, "recall", "батчит события", "--repo", "all")).stdout);
    if (!human.includes("@collector")) excuseLateText(human, "факт соседа, текст");
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
    const fed = env.meta["federation"] as Federation;
    // Обнаружение и порядок — на любой машине: все четыре учтены, свой первым.
    const all = ["project", "alpha", "beta", "gamma"];
    expect([...fed.queried, ...fed.skipped.map((s) => s.id)]).toEqual(all);
    expect(fed.total).toBe(4);
    // Опрошены все, кроме пропущенных по дедлайну — а такой пропуск допустим
    // только на занятой или неоткалиброванной машине (см. `excusedLate`).
    const late = excusedLate(fed, "три соседа");
    expect(fed.queried).toEqual(all.filter((id) => !late.includes(id)));
    for (const id of fed.queried) expect(sources.has(id)).toBe(true);
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
    // Потолок — на любой машине: r03..r05 пропущены ИМЕННО потолком. До
    // потолка — опрошены все, кроме пропущенных по дедлайну на занятой машине.
    const late = excusedLate(fed, "потолок 3");
    expect(fed.queried).toEqual(["project", "r01", "r02"].filter((id) => !late.includes(id)));
    expect(fed.skipped.map((s) => s.id)).toEqual([...late, "r03", "r04", "r05"]);
    for (const s of fed.skipped.filter((x) => !late.includes(x.id))) expect(s.why).toContain("cap of 3");

    // Пропуск обязан дойти до WARN-строк, а не только до подвала: выдача НЕ
    // полна, и под --strict это деградация, а не успех.
    const warned = env.warn.map((w) => w.msg).join(" ");
    expect(warned).toContain("source r03 not queried");
    expect(warned).toContain("source r05 not queried");
    expect(env.meta.degraded).toContain("degraded.retrieval");

    const human = text(
      (await mycAt(root, "recall", "инвалидация кеша", "--sources", "3", "--repo", "all")).stdout,
    );
    // Это отдельный запуск со своим дедлайном: число опрошенных читается из
    // текста, а «меньше трёх» допустимо только по той же причине и при тех же
    // условиях, что выше.
    const shown = Number(/(\d+) of 6 sources/.exec(human)?.[1] ?? -1);
    if (shown !== 3) excuseLateText(human, "потолок 3, текст подвала");
    expect(shown).toBeGreaterThanOrEqual(1);
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
    if (!human.includes("r01       vector=")) excuseLateText(human, "--why, r01");
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
    // Пропуск по дедлайну тоже честно попадает в WARN — он допустим только на
    // занятой машине (`excusedLate`); любой другой пропуск без потолка — провал.
    excusedLate(full.meta["federation"] as Federation, "WARN без потолка");
    expect(full.warn.some((w) => w.msg.includes("not queried") && !w.msg.includes("deadline"))).toBe(false);

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

    const env = await jsonAt(root, "recall", "миграция схемы", "--sources", "2", "--repo", "all");

    const walOf = (name: string): boolean =>
      existsSync(join(root, name, ".myc", "myc.db-wal"));
    // Потолок 2 = свой воркспейс + r01. r02 и r03 не открывались вовсе — на
    // любой машине; r01 открыт, если не пропущен по дедлайну на занятой.
    const late = excusedLate(env.meta["federation"] as Federation, "ленивость, потолок 2");
    expect(walOf("r01")).toBe(!late.includes("r01"));
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
