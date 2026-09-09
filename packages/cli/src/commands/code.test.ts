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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
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
    expect(r.stderr).toContain("просмотрено");
    expect(r.stderr).toContain("файлов");
  });

  test("индекс не построен — это ДРУГОЙ ответ, а не «символа нет»", async () => {
    const r = await myc("code", "symbol", "fuseRRF");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("не построен");
    expect(r.stderr).toContain("myc code index");
  });

  test("без имени — usage, а не пустая выдача", async () => {
    const r = await myc("code", "symbol");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});
