/**
 * `myc prime` (§3.2, myc-5t1): интеграционные тесты против настоящего
 * SQLite во временной директории, через публичный run() — как tasks.test.ts.
 *
 * Отдельно (не здесь): живой замер p99 на 100k узлов — scripts/bench-latency.ts
 * уже мерит ровно этот горячий путь (primeOp) под budget prime=30мс.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as realEmbed from "@myc/embed";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createCreateCommand, createTaskCommand, createBugCommand } from "./tasks.ts";
import { createReadyCommand } from "./ready.ts";
import { createRememberCommand } from "./remember.ts";
import { createPrimeCommand } from "./prime.ts";

let dir: string;
let db: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createCreateCommand());
  r.register(createTaskCommand());
  r.register(createBugCommand());
  r.register(createReadyCommand());
  r.register(createRememberCommand());
  r.register(createPrimeCommand());
  return r;
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-prime-"));
  mkdirSync(join(dir, ".myc"));
  db = join(dir, ".myc", "myc.db");
  const raw = new Database(db, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], {
    registry,
    env: { MYC_ACTOR: "tester", MYC_HOME: dir }, // MYC_HOME изолирует личный ярус в теста
  });
}

async function mycJson(...args: string[]): Promise<{ code: number; env: Record<string, unknown> }> {
  const r = await myc(...args, "--json");
  expect(typeof r.stdout).toBe("string");
  return { code: r.code, env: JSON.parse(r.stdout as string) as Record<string, unknown> };
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const { env } = await mycJson(...args);
  return env["data"] as Record<string, unknown>;
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

describe("myc prime — пустой воркспейс", () => {
  test("осмысленный ответ, не падение", async () => {
    const r = await myc("prime");
    expect(r.code).toBe(0);
    const out = text(r.stdout);
    expect(out).toContain("Воркспейс пуст");
    expect(out).toContain("NEXT");
  });

  test("data.empty=true в JSON", async () => {
    const d = await data("prime");
    expect(d["empty"]).toBe(true);
    expect(d["node_count"]).toBe(0);
  });
});

describe("myc prime — наполненный воркспейс", () => {
  beforeEach(async () => {
    await myc("task", "P0-задача", "-p", "P0");
    await myc("task", "P2-задача", "-p", "P2");
    await myc("remember", "правило ядра проекта", "--layer", "L3");
    await myc("remember", "решение про хранилище", "--layer", "L2");
  });

  test("READY, CORE и DECISIONS видны в человеческом выводе", async () => {
    const r = await myc("prime");
    const out = text(r.stdout);
    expect(out).toContain("READY");
    expect(out).toContain("CORE L3");
    expect(out).toContain("DECISIONS L2");
    expect(out).toContain("правило ядра проекта");
    expect(out).toContain("решение про хранилище");
    expect(out).toMatch(/\d+ симв · \d+ мс · cache (hit|miss)/);
  });

  test("data содержит ready/core/decisions", async () => {
    const d = await data("prime");
    expect(d["empty"]).toBe(false);
    expect(d["node_count"]).toBeGreaterThan(0);
    const ready = d["ready"] as unknown[];
    expect(ready.length).toBeGreaterThan(0);
    const core = d["core"] as { title: string }[];
    expect(core.some((c) => c.title.includes("правило ядра"))).toBe(true);
    const decisions = d["decisions"] as { title: string }[];
    expect(decisions.some((c) => c.title.includes("решение про хранилище"))).toBe(true);
  });

  test("второй вызов — cache hit (тот же oplog.seq)", async () => {
    await myc("prime"); // прогрев кеша дайджеста
    const d = await data("prime");
    expect(d["cache"]).toBe("hit");
  });

  test("запись в граф инвалидирует кеш (oplog.seq двигается)", async () => {
    await myc("prime");
    await myc("remember", "новое решение", "--layer", "L2");
    const d = await data("prime");
    expect(d["cache"]).toBe("miss");
  });

  test("--focus фильтрует L2/L3 по подстроке, детерминированно", async () => {
    const d = await data("prime", "--focus", "хранилищ");
    const decisions = d["decisions"] as { title: string }[];
    expect(decisions.length).toBe(1);
    const core = d["core"] as { title: string }[];
    expect(core.length).toBe(0);
  });

  test("--budget слишком мал — usage error", async () => {
    const r = await myc("prime", "--budget", "10");
    expect(r.code).toBe(2);
  });

  test("вывод укладывается в --budget и сообщает об обрезке", async () => {
    const r = await myc("prime", "--budget", "220");
    const out = text(r.stdout);
    expect(out.length).toBeLessThanOrEqual(240); // небольшой запас на footer-хвост
    const d = await data("prime", "--budget", "220");
    if (d["truncated"] === true) {
      expect((d["cut"] as string[]).length).toBeGreaterThan(0);
    }
  });

  test("--role проверяется", async () => {
    const r = await myc("prime", "--role", "bogus");
    expect(r.code).toBe(2);
  });

  test("--format json печатает JSON вместо плотного текста", async () => {
    const r = await myc("prime", "--format", "json");
    const out = text(r.stdout);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("IN PROGRESS появляется после claim", async () => {
    await myc("ready", "--claim");
    const r = await myc("prime");
    expect(text(r.stdout)).toContain("IN PROGRESS");
  });
});

describe("myc prime — не зовёт эмбеддер (И1/S4)", () => {
  test("счётчик обращений к @myc/embed остаётся нулевым", async () => {
    // prime.ts не импортирует @myc/embed и не зовёт @myc/retrieval — доказываем
    // счётчиком, а не чтением кода (требование приёмки).
    //
    // myc-22z: раньше здесь стоял mock.module("@myc/embed", ...) с "восстановлением"
    // через mock.module(spec, () => realEmbed) в finally. Под bun 1.3.14 это
    // восстановление не работает по-настоящему: mock.module меняет модуль в
    // ГЛОБАЛЬНОМ кеше на весь процесс bun test, а не только на этот файл, и
    // динамический import() после "restore" продолжал отдавать подменённый
    // модуль другим тестовым файлам (напр. memory.test.ts падал, если
    // запускался ПОСЛЕ этого файла — набор становился зависим от порядка).
    // spyOn точечно подменяет свойства уже импортированного объекта модуля и
    // .mockRestore() надёжно возвращает оригинальную функцию — никакого
    // общепроцессного состояния не остаётся.
    let calls = 0;
    const spies = [
      spyOn(realEmbed, "isModelPresent").mockImplementation(async () => {
        calls++;
        return false;
      }),
      spyOn(realEmbed, "fetchModel").mockImplementation(async () => {
        calls++;
        throw new Error("must not be called by prime");
      }),
      spyOn(realEmbed, "getModelSpec").mockImplementation(() => {
        calls++;
        throw new Error("must not be called by prime");
      }),
      spyOn(realEmbed, "modelDir").mockImplementation(() => {
        calls++;
        return "/nope";
      }),
      spyOn(realEmbed, "sha256File").mockImplementation(async () => {
        calls++;
        return "";
      }),
    ];
    try {
      await myc("task", "задача", "-p", "P0");
      await myc("remember", "факт", "--layer", "L3");
      await myc("prime");
      await myc("prime", "--focus", "факт");
      expect(calls).toBe(0);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// И2: сокрытие обязано быть НАЗВАНО, а не только выполнено
// ---------------------------------------------------------------------------

describe("prime: скрытое по охвату репозитория названо числом", () => {
  /** Проставить узлу охват напрямую: у `remember` флага --repo нет, охват
   *  штампуется из каталога, а временная директория теста не лежит ни в одном
   *  репозитории. Пишем то же, что записал бы штамп в чужом репозитории. */
  function stampRepo(title: string, repo: string): void {
    const raw = new Database(db);
    try {
      raw.run("UPDATE nodes SET attrs = json_set(coalesce(attrs,'{}'),'$.repo',?) WHERE title = ?", [
        repo,
        title,
      ]);
    } finally {
      raw.close();
    }
  }

  test("заметка чужого репозитория скрыта И названа числом в подвале", async () => {
    // Фильтр памяти защищён отдельным тестом, а ОБЪЯВЛЕНИЕ сокрытия не было:
    // счётчик можно было заглушить, и никто бы не заметил. По И2 молчаливое
    // сужение выдачи хуже отсутствия фильтра — пользователь не отличает «нет
    // знания» от «знание спрятали».
    await myc("remember", "--layer", "L3", "--reach", "project", "знание чужого репозитория");
    stampRepo("знание чужого репозитория", "repoY");

    const d = await data("prime", "--budget", "3000", "--repo", "repoX");
    expect(d["mem_repo_foreign"]).toBe(1);
    const human = text((await myc("prime", "--budget", "3000", "--repo", "repoX")).stdout);
    expect(human).toContain("1 заметок из других репозиториев скрыто");

    // И обратная сторона: в своём репозитории она видна и прятать нечего —
    // счётчик, всегда печатающий число, был бы так же бесполезен.
    const own = await data("prime", "--budget", "3000", "--repo", "repoY");
    expect(own["mem_repo_foreign"]).toBe(0);
    const ownHuman = text((await myc("prime", "--budget", "3000", "--repo", "repoY")).stdout);
    expect(ownHuman).not.toContain("из других репозиториев скрыто");
  });
});
