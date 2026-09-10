/**
 * Задача C — бюджетированный ретривал (§2.7) на живом CLI.
 *
 * Проверяется то, что не видно на чистом модуле @myc/retrieval/budget:
 * ответ recall/search НЕ ПРЕВЫШАЕТ бюджет, обрезка помечена в data/meta
 * и в человеческом футере (И2), а cursor продолжает выдачу тем же
 * механизмом, что --offset. Корпус и запросы детерминированы.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { createRecallCommand } from "./recall.ts";
import { createSearchCommand } from "./search.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { realStoreDeps } from "./store.ts";

let dir: string;
let home: string;
let registry: Registry;

function retrieveDeps(): RetrieveDeps {
  return {
    openStore: realStoreDeps.openStore,
    openPersonal: realRetrieveExtras.openPersonal,
    resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
  };
}

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
  r.register(createRecallCommand(retrieveDeps()));
  r.register(createSearchCommand(retrieveDeps()));
  return r;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-budget-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  process.env.MYC_HOME = home;
  process.env.MYC_ACTOR = "tester";
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_HOME;
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["--directory", dir, ...args], { tty: false, env: process.env as never, registry });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

interface Row {
  id: string;
  title: string;
  excerpt: string;
  content_kind?: "full" | "crux";
  body?: string | null;
}

/** Корпус: N заметок с общим словом «бюджет» и телами разной длины. */
async function seedCorpus(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const size = 30 + ((i * 137) % 900);
    const filler = "ранг слияние оплог мерж ".repeat(Math.ceil(size / 24)).slice(0, size);
    await myc("remember", `бюджет заметка номер ${i}: ${filler}конец тела.`);
  }
}

describe("бюджетированный ретривал на CLI (§2.7)", () => {
  test("ответ recall не превышает бюджет, обрезка помечена в data/meta/футере", async () => {
    await seedCorpus(25);
    // Тесный бюджет: часть узлов обязана не влезть.
    const r = await myc("recall", "бюджет", "--json", "--budget", "1500");
    expect(r.code).toBe(0);
    const env = JSON.parse(text(r.stdout)) as { data: Record<string, unknown>; meta: Record<string, unknown> };
    const rows = env.data["rows"] as Row[];
    expect(rows.length).toBeGreaterThan(0);

    // БЮДЖЕТ: сумма текстов строк (тело или выдержка) — в пределах бюджета.
    const contentChars = rows.reduce(
      (s, row) => s + Math.max(row.body?.length ?? 0, row.excerpt.length) + 1,
      0,
    );
    expect(contentChars).toBeLessThanOrEqual(1500);

    // И2: обрезка помечена, а не молчалива — в data и в meta.
    expect(env.data["partial"]).toBe(true);
    expect((env.data["omitted"] as number) > 0).toBe(true);
    expect(env.meta["partial"]).toBe(true);
    expect(env.meta["omitted"]).toBe(env.data["omitted"]);
    expect(env.meta["budget_chars"]).toBe(1500);

    // Футер человеческого вывода называет partial.
    const human = text((await myc("recall", "бюджет", "--budget", "1500")).stdout);
    expect(human).toContain("partial:");
    expect(human).toMatch(/over budget/);
  });

  test("cursor продолжает выдачу тем же механизмом, что --offset", async () => {
    await seedCorpus(25);
    const first = JSON.parse(text((await myc("recall", "бюджет", "--json", "--limit", "5")).stdout)) as {
      data: { rows: Row[]; cursor?: string; partial: boolean; total: number };
    };
    expect(first.data.rows.length).toBe(5);
    expect(first.data.cursor).toBeDefined();
    expect(first.data.partial).toBe(true);

    const second = JSON.parse(
      text((await myc("recall", "бюджет", "--json", "--limit", "5", "--offset", first.data.cursor!)).stdout),
    ) as { data: { rows: Row[]; cursor?: string } };
    expect(second.data.rows.length).toBe(5);
    const firstIds = new Set(first.data.rows.map((r) => r.id));
    for (const row of second.data.rows) expect(firstIds.has(row.id)).toBe(false);

    // Выдача конечна: рано или поздно cursor исчезает.
    let offset: string | undefined = second.data.cursor;
    let guard = 0;
    let last = second.data;
    while (offset !== undefined && guard++ < 10) {
      last = JSON.parse(
        text((await myc("recall", "бюджет", "--json", "--limit", "5", "--offset", offset)).stdout),
      ).data as { rows: Row[]; cursor?: string };
      offset = last.cursor;
    }
    expect(offset).toBeUndefined();
    expect(last.rows.length).toBeGreaterThan(0);
  });

  test("search --full: тела в бюджете, crux-строки без тела помечены у строки", async () => {
    await seedCorpus(25);
    const r = await myc("search", "бюджет", "--json", "--full", "--limit", "12");
    expect(r.code).toBe(0);
    const env = JSON.parse(text(r.stdout)) as { data: Record<string, unknown> };
    const rows = env.data["rows"] as Row[];
    expect(rows.length).toBeGreaterThan(0);

    const contentChars = rows.reduce((s, row) => s + (row.body?.length ?? row.excerpt.length) + 1, 0);
    expect(contentChars).toBeLessThanOrEqual(12000); // §2.7: char_budget по умолчанию
    // Крупные тела либо целиком (kind full), либо crux без тела.
    for (const row of rows) {
      if (row.content_kind === "crux") expect(row.body ?? null).toBeNull();
      if (row.content_kind === "full") expect(row.body).toBe((row.body ?? "").trim());
    }

    // Человеческий вывод: обрезанные строки помечены у строки, футер — partial.
    const human = text((await myc("search", "бюджет", "--full", "--limit", "12")).stdout);
    if (rows.some((row) => row.content_kind === "crux")) {
      expect(human).toContain("(truncated by budget)");
    }
  });

  test("узкий бюджет не опустошает ответ и не роняет команду", async () => {
    await seedCorpus(6);
    const r = await myc("recall", "бюджет", "--json", "--budget", "200");
    expect(r.code).toBe(0);
    const env = JSON.parse(text(r.stdout)) as { data: Record<string, unknown> };
    const rows = env.data["rows"] as Row[];
    // Что успело — выдано; что не влезло — объявлено.
    const contentChars = rows.reduce((s, row) => s + Math.max(row.body?.length ?? 0, row.excerpt.length) + 1, 0);
    expect(contentChars).toBeLessThanOrEqual(200);
    expect(env.data["partial"]).toBe(true);
  });

  test("маленький корпус без обрезки — partial только из-за продолжения, таймаут не срабатывает", async () => {
    await seedCorpus(3);
    const r = await myc("recall", "бюджет", "--json");
    expect(r.code).toBe(0);
    const env = JSON.parse(text(r.stdout)) as { data: Record<string, unknown>; meta: Record<string, unknown> };
    expect(env.data["budget_timed_out"]).toBe(false);
    expect(env.data["omitted"]).toBe(0);
    // total = 3, страница 12 — продолжения нет.
    expect(env.data["cursor"]).toBeUndefined();
    expect(env.data["partial"]).toBe(false);
  });
});
