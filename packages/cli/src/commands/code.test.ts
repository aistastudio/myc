/**
 * Приёмка `myc code` (memory-m30yh8swnm1d): ВХОД и ЧИТАТЕЛЬ код-индекса.
 *
 * До этой задачи `code_files`/`code_defs` не заполняла ни одна команда и не
 * читала ни одна строка кода: пакет был написан, покрыт тестами и мёртв. Оба
 * теста ниже — приёмочные в буквальном смысле мутаций:
 *
 *   МУТАЦИЯ «вход отключён» — убрать `scanCodeIndex`/`drainCodeIndex` из
 *   обработчика `code index` (или вернуть ему `dry_run` всегда): краснеет
 *   «index строит», потому что в таблицах остаются нули.
 *
 *   МУТАЦИЯ «читатель отключён» — заставить `code symbol` не спрашивать
 *   `code_defs` (вернуть пустой список определений): краснеет «symbol
 *   отвечает», причём именно на связке символ↔знание, ради которой читатель
 *   и делался.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { grammarPath } from "@myc/code-intel/symbols";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createCodeCommand } from "./code.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createTaskCommand } from "./tasks.ts";

const FUSE = `// заголовок файла
import { x } from "./x.ts";

export function fuseRRF(a: number[], b: number[], k = 60): number[] {
  const out: number[] = [];
  for (const v of a) out.push(v / (k + 1));
  return out;
}

export function callsFuse(): number[] {
  return fuseRRF([1], [2]);
}
`;

let dir: string;
let home: string;
let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-code-cli-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "fuse.ts"), FUSE);
  writeFileSync(join(dir, "README.md"), "fuseRRF описан здесь\n");
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createCodeCommand());
  registry.register(createAnchorCommand());
  registry.register(createTaskCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const r = await myc(...args, "--json");
  const env = JSON.parse(r.stdout as string) as { ok: boolean; data: Record<string, unknown> };
  expect(env.ok).toBe(true);
  return env.data;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"));
}

function count(table: string): number {
  const d = db();
  try {
    return Number((d.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------

describe("myc code index — вход, которого не было", () => {
  test("в чистом TS-репозитории после команды code_files и code_defs непусты", async () => {
    expect(count("code_files")).toBe(0);
    expect(count("code_defs")).toBe(0);

    const d = await data("code", "index");
    expect(d["files"]).toBeGreaterThan(0);
    expect(d["defs"]).toBeGreaterThan(0);

    // Не «команда сказала», а «в базе лежит»: обещание проверяется таблицей.
    expect(count("code_files")).toBeGreaterThan(0);
    expect(count("code_defs")).toBeGreaterThan(0);

    const rows = db();
    try {
      const names = (
        rows.query("SELECT name, span_start FROM code_defs ORDER BY span_start").all() as Array<{
          name: string;
          span_start: number;
        }>
      ).map((r) => r.name);
      expect(names).toContain("fuseRRF");
      expect(names).toContain("callsFuse");
    } finally {
      rows.close();
    }
  });

  test("L0-файлы в реестре есть, определений у них нет (§5)", async () => {
    await data("code", "index");
    const d = db();
    try {
      const md = d.query("SELECT lang FROM code_files WHERE path = 'README.md'").get() as {
        lang: string;
      } | null;
      expect(md?.lang).toBe("md");
      expect(
        d.query("SELECT count(*) AS n FROM code_defs WHERE path = 'README.md'").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      d.close();
    }
  });

  test("повторный прогон ничего не разбирает: инкрементальность видна в отчёте", async () => {
    await data("code", "index");
    const again = (await data("code", "index"))["drain"] as Record<string, number>;
    expect(again["parsed"]).toBe(0);
    expect(again["claimed"]).toBe(0);
  });

  /**
   * Главное решение этой задачи — «молчаливого пропуска быть не должно» — не
   * было защищено ничем: снятие `ctx.warn` целиком не роняло ни одного теста.
   * Файл, который не разобрали, ничем не отличается от файла без символов, и
   * человек узнаёт об этом только когда `myc code symbol` не находит того, что
   * точно есть.
   *
   * Каталог грамматик подменяется на пустой — это единственный способ увидеть
   * пропуск, не удаляя ничего из пользовательского кеша.
   */
  test("часть языков без грамматики — пропуск НАЗВАН, а не проглочен", async () => {
    // Каталог, где есть ТОЛЬКО typescript: ts разбирается, python — нет.
    // Это и есть интересный случай: пустой каталог даёт другую ветку (отказ
    // «ни одного символа»), и мутация в предупреждении на нём не видна.
    const partial = mkdtempSync(join(tmpdir(), "myc-partial-grammars-"));
    const real = grammarPath("ts");
    copyFileSync(real, join(partial, real.split("/").pop()!));
    writeFileSync(join(dir, "app.py"), "def fuse(a):\n    return a + 1\n");
    const saved = process.env["MYC_TREE_SITTER_GRAMMAR_DIR"];
    process.env["MYC_TREE_SITTER_GRAMMAR_DIR"] = partial;
    try {
      // Проверяется МАШИНОЧИТАЕМЫЙ канал: человеческий рендер печатает ту же
      // строку отдельно, и утверждение по тексту зеленело бы даже со снятым
      // `ctx.warn` — то есть агент, читающий конверт, о пропуске не узнал бы,
      // а тест бы этого не заметил.
      const r = await myc("code", "index", "--json");
      const env = JSON.parse(String(r.stdout ?? "")) as {
        warn?: Array<{ code: string; msg: string }>;
        data?: { missing_grammars?: Array<{ langs: string[]; fetch: string }> };
      };
      const warn = (env.warn ?? []).find((w) => w.code === "code_index.grammar_missing");
      expect(warn).toBeDefined();
      expect(warn!.msg).toContain("py");
      expect(warn!.msg).toContain("myc code fetch");
      // И то же — в данных, чтобы агент не разбирал текст предупреждения.
      expect(env.data?.missing_grammars?.some((m) => m.langs.includes("py"))).toBe(true);
      // При этом TS разобран: пропуск одного языка не отменяет остальных.
      expect(count("code_defs")).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env["MYC_TREE_SITTER_GRAMMAR_DIR"];
      else process.env["MYC_TREE_SITTER_GRAMMAR_DIR"] = saved;
      rmSync(partial, { recursive: true, force: true });
    }
  });

  test("--dry-run считает и не пишет", async () => {
    const d = await data("code", "index", "--dry-run");
    expect((d["scan"] as Record<string, number>)["dirty"]).toBeGreaterThan(0);
    expect(count("code_files")).toBe(0);
    expect(count("code_defs")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Читатель
// ---------------------------------------------------------------------------

describe("myc code symbol — читатель, ради которого индекс и строится", () => {
  test("symbol отвечает спаном И знанием, привязанным к этому участку", async () => {
    const task = (await data("task", "Переписать слияние RRF"))["id"] as string;
    await data("anchor", "add", task, "src/fuse.ts:5-6");
    await data("code", "index");

    const d = await data("code", "symbol", "fuseRRF");
    const defs = d["defs"] as Array<Record<string, unknown>>;
    expect(defs.length).toBe(1);
    expect(defs[0]!["path"]).toBe("src/fuse.ts");
    expect(defs[0]!["span_start"]).toBe(4);

    // Вот ответ, которого без индекса не было: якорь знает file:span, индекс —
    // symbol→span, и пересечение превращает «строки 5-6» в имя функции.
    const knowledge = defs[0]!["knowledge"] as Array<Record<string, unknown>>;
    expect(knowledge.length).toBe(1);
    expect(knowledge[0]!["id"]).toBe(task);
    expect(knowledge[0]!["title"]).toBe("Переписать слияние RRF");
  });

  test("fan_in подписан источником и считается по L1-корпусу", async () => {
    await data("code", "index");
    const d = await data("code", "symbol", "fuseRRF");
    const fan = d["fan_in"] as Record<string, unknown>;
    // README.md упоминает имя, но он L0 — в счёт не идёт; в fuse.ts остаётся
    // один вызов внутри callsFuse (строка определения не в счёт).
    expect(fan["source"]).toBe("text");
    expect(fan["n"]).toBe(1);
    expect(fan["files"]).toBe(1);
  });

  test("--no-fan-in не считает вовсе: чтение корпуса — плата, а не умолчание без выбора", async () => {
    await data("code", "index");
    const d = await data("code", "symbol", "fuseRRF", "--no-fan-in");
    expect(d["fan_in"]).toBeUndefined();
  });

  test("несуществующий символ — отказ, называющий просмотренное (§6.3)", async () => {
    await data("code", "index");
    const r = await myc("code", "symbol", "нетТакого");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.stderr).toContain("scanned");
    expect(r.stderr).toContain("files");
  });

  test("индекс не построен — это ДРУГОЙ ответ, а не «символа нет»", async () => {
    const r = await myc("code", "symbol", "fuseRRF");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("is not built");
    expect(r.stderr).toContain("myc code index");
  });

  test("без имени — usage, а не пустая выдача", async () => {
    const r = await myc("code", "symbol");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Поиск, исчерпывающий откат и карта (memory-5nvk1hwcene2)
// ---------------------------------------------------------------------------
//
//   МУТАЦИЯ «корпус не строится» — убрать `buildSearchUnits` из обработчика
//   `code index`: краснеет «search отвечает», потому что `code_units` пуст и
//   команда честно отказывает по precond.
//
//   МУТАЦИЯ «grep читает индекс» — заменить чтение файлов на выборку из
//   `code_ref_sites`: краснеет «grep находит литерал в markdown», потому что
//   в индексе символов markdown нет вовсе.
//
//   МУТАЦИЯ «рёбра по любому вхождению» — убрать `kind = 'import'` из
//   `SQL_REF_EDGES`: краснеет map-тест в `code-intel/src/map.test.ts`.

describe("myc code search — вопрос без знания имени", () => {
  test("search отвечает файлом и символом, назвав ступени и объём просмотра", async () => {
    await data("code", "index");
    const d = (await data("code", "search", "слияние рангов rrf")) as unknown as {
      hits: { path: string; units: { name: string; line: number }[] }[];
      stages: string[];
      searched: { units: number; files: number };
    };
    expect(d.hits.length).toBeGreaterThan(0);
    expect(d.hits[0]!.path).toBe("src/fuse.ts");
    expect(d.hits[0]!.units.some((u) => u.name === "fuseRRF")).toBe(true);
    expect(d.stages.length).toBeGreaterThan(0);
    expect(d.searched.units).toBeGreaterThan(0);
  });

  test("корпуса нет — это ДРУГОЙ ответ, а не «ничего не нашлось»", async () => {
    const r = await myc("code", "search", "слияние рангов");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("myc code index");
  });

  test("ничего не нашлось — предупреждение называет просмотренное и откат", async () => {
    await data("code", "index");
    const r = await myc("code", "search", "квазистеллар");
    expect(r.code).toBe(ExitCode.OK);
    // В человекочитаемом режиме предупреждения печатаются в stdout — вместе
    // с выдачей, к которой относятся; в stderr они уходят только при --json.
    expect(r.stdout as string).toContain("scanned");
    expect(r.stdout as string).toContain("myc code grep");
  });

  test("без вопроса — usage", async () => {
    const r = await myc("code", "search");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

describe("myc code grep — исчерпывающий откат", () => {
  test("находит литерал там, где индекса символов нет вовсе (markdown)", async () => {
    await data("code", "index");
    const d = (await data("code", "grep", "fuseRRF")) as unknown as {
      hits: number;
      files: number;
      searched: number;
      groups: { path: string; symbol: string; hits: { line: number }[] }[];
    };
    expect(d.groups.some((g) => g.path === "README.md")).toBe(true);
    expect(d.groups.some((g) => g.symbol === "callsFuse")).toBe(true);
    expect(d.hits).toBeGreaterThanOrEqual(3);
    expect(d.searched).toBeGreaterThanOrEqual(2);
  });

  test("вхождения относятся к охватывающему определению, а не к файлу целиком", async () => {
    await data("code", "index");
    const d = (await data("code", "grep", "out.push")) as unknown as {
      groups: { symbol: string; kind: string }[];
    };
    expect(d.groups.some((g) => g.symbol === "fuseRRF" && g.kind === "function")).toBe(true);
  });

  test("реестра файлов нет — precond, а не ноль вхождений", async () => {
    const r = await myc("code", "grep", "fuseRRF");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("myc code index");
  });

  test("без литерала — usage", async () => {
    const r = await myc("code", "grep");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

describe("myc code map — ориентация в незнакомом дереве", () => {
  test("карта печатает итоги, кластеры и СВОЙ размер в знаках", async () => {
    await data("code", "index");
    const d = (await data("code", "map")) as unknown as {
      files: number;
      defs: number;
      imports: number;
      clusters: { dir: string; files: number; defs: number }[];
      render_bytes: number;
    };
    expect(d.files).toBeGreaterThan(0);
    expect(d.defs).toBeGreaterThan(0);
    expect(d.clusters.length).toBeGreaterThan(0);
    // Бюджет контекста назван числом, а не обещанием: без этого карта
    // «помещается» ровно до первого большого репозитория.
    expect(d.render_bytes).toBeGreaterThan(0);
    const human = await myc("code", "map");
    expect(Buffer.byteLength(human.stdout as string, "utf8")).toBeGreaterThanOrEqual(d.render_bytes);
  });

  test("реестра файлов нет — precond, а не пустая карта", async () => {
    const r = await myc("code", "map");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("myc code index");
  });
});
