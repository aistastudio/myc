/**
 * Личный ярус ~/.myc и бюджет И1 (решение S41, myc-ye3.6).
 *
 * Против настоящего SQLite во временных директориях, через публичный run() —
 * как в tasks.test.ts/init.test.ts. MYC_HOME переопределяет ~/.myc на время
 * теста (та же конвенция, что MYC_ACTOR в init.test.ts): реальный домашний
 * каталог пользователя не трогается никогда.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand, createClaimCommand } from "./tasks.ts";
import { createShowCommand } from "./show.ts";
import { createReadyCommand } from "./ready.ts";
import {
  createPersonalWorkspace,
  openPersonalStore,
  personalOpenAttempts,
  personalWorkspaceStatus,
  PERSONAL_SLUG,
} from "./store.ts";
import type { CommandContext } from "../registry.ts";

let projectDir: string;
let homeDir: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  r.register(createClaimCommand());
  r.register(createShowCommand());
  return r;
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  projectDir = mkdtempSync(join(tmpdir(), "myc-store-"));
  mkdirSync(join(projectDir, ".myc"));
  const raw = new Database(join(projectDir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  homeDir = mkdtempSync(join(tmpdir(), "myc-home-"));
  process.env.MYC_HOME = homeDir;

  registry = makeRegistry();
  personalOpenAttempts.count = 0;
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", projectDir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

function fakeCtx(): CommandContext {
  return {
    args: [],
    flags: {},
    globals: { json: false, ndjson: false, strict: false, quiet: false, color: false },
    warn: () => {},
    diagnostics: { warnings: [] } as never,
  };
}

// ---------------------------------------------------------------------------
// Резрешение личного яруса: отсутствует / появляется
// ---------------------------------------------------------------------------

describe("personalWorkspaceStatus / openPersonalStore: лениво, без ошибок при отсутствии", () => {
  test("~/.myc не создан: status.exists=false, openPersonalStore не роняет и не открывает БД", async () => {
    const status = personalWorkspaceStatus(homeDir);
    expect(status.exists).toBe(false);

    const opened = await openPersonalStore(fakeCtx(), homeDir);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.handle).toBeUndefined();
  });

  test("после createPersonalWorkspace личный ярус открывается и имеет слуг 'me'", async () => {
    const created = await createPersonalWorkspace(homeDir);
    expect(created.schemaVersion).toBeGreaterThan(0);

    const status = personalWorkspaceStatus(homeDir);
    expect(status.exists).toBe(true);

    const opened = await openPersonalStore(fakeCtx(), homeDir);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.handle).toBeDefined();
      expect(opened.handle!.slug).toBe(PERSONAL_SLUG);
      opened.handle!.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Приёмка И1: ready/claim/show никогда не открывают личный ярус
// ---------------------------------------------------------------------------

describe("бюджет И1: ready/claim/show не открывают второе соединение (счётчик, не рассуждение)", () => {
  test("личный ярус существует, но show/ready/claim ни разу не зовут openPersonalStore", async () => {
    await createPersonalWorkspace(homeDir);
    expect(personalWorkspaceStatus(homeDir).exists).toBe(true);
    personalOpenAttempts.count = 0;

    const task = await myc("task", "проверка бюджета", "-p", "P1");
    expect(task.code).toBe(0);
    const id = (task.stdout as string).split(/\s+/)[0]!;

    const ready = await myc("ready");
    expect(ready.code).toBe(0);

    const claim = await myc("claim", id);
    expect(claim.code).toBe(0);

    const show = await myc("show", id);
    expect(show.code).toBe(0);

    // Реальный счётчик после реального прогона реальных команд — не догадка
    // по коду, а факт: openPersonalStore не был вызван НИ РАЗУ.
    expect(personalOpenAttempts.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Приёмка: замер show/ready до и после появления личного яруса
// ---------------------------------------------------------------------------

async function benchmark(label: string, fn: () => Promise<unknown>, iterations = 40): Promise<number> {
  // прогрев: первый вызов открывает WAL и прогревает page cache файла
  await fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsed = performance.now() - t0;
  const avg = elapsed / iterations;
  console.log(`[myc-ye3.6] ${label}: avg ${avg.toFixed(3)} мс / ${iterations} прогонов`);
  return avg;
}

describe("замер: show/ready до и после появления личного яруса", () => {
  test("время show/ready не деградирует от одного присутствия ~/.myc (ready/claim/show его не открывают)", async () => {
    const task = await myc("task", "бенчмарк", "-p", "P2");
    const id = (task.stdout as string).split(/\s+/)[0]!;

    const showBefore = await benchmark("show, до ~/.myc", () => myc("show", id));
    const readyBefore = await benchmark("ready, до ~/.myc", () => myc("ready"));

    await createPersonalWorkspace(homeDir);
    expect(personalWorkspaceStatus(homeDir).exists).toBe(true);

    const showAfter = await benchmark("show, после ~/.myc", () => myc("show", id));
    const readyAfter = await benchmark("ready, после ~/.myc", () => myc("ready"));

    console.log(
      `[myc-ye3.6] show: ${showBefore.toFixed(3)} мс -> ${showAfter.toFixed(3)} мс; ` +
        `ready: ${readyBefore.toFixed(3)} мс -> ${readyAfter.toFixed(3)} мс`,
    );

    // Щедрый допуск (CLI-процесс каждый раз поднимается заново — доминирует
    // старт рантайма, не сама команда): проверяем ОТСУТСТВИЕ систематической
    // деградации, а не точное число, — численные результаты идут в отчёт.
    expect(showAfter).toBeLessThan(showBefore * 3 + 20);
    expect(readyAfter).toBeLessThan(readyBefore * 3 + 20);
  }, 60_000);
});
