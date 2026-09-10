/**
 * R1 (memory-6k8a692mk20w): подъём вверх при поиске воркспейса.
 *
 * Сценарий заказчика: `~/src/cherry` — git-репозиторий из 14 файлов,
 * внутри — 15 самостоятельных репозиториев (свой `.git` у каждого). Живём в
 * корне ради общего контекста, но заходим во вложенные репозитории — там
 * `.myc` искался строго в cwd и терялся (ws.not_initialized).
 *
 * Здесь воспроизводим ту же форму дерева во временном каталоге (в
 * `~/src/cherry` ничего не создаём — только читаем, если понадобится).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { findWorkspaceDb } from "./store.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand } from "./tasks.ts";
import { createReadyCommand } from "./ready.ts";

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  return r;
}

let root: string; // ~/src/cherry
let homeDir: string; // MYC_HOME для теста — личный ярус живёт отдельно
let repoA: string; // вложенный репозиторий без своего .myc
let repoB: string; // вложенный репозиторий СО своим .myc
let deep: string; // repoA/pkg/src — глубокий путь без .git по дороге

async function initWorkspace(dir: string): Promise<void> {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-cherry-"));
  homeDir = mkdtempSync(join(tmpdir(), "myc-home-"));
  process.env.MYC_HOME = homeDir;

  mkdirSync(join(root, ".git"));
  await initWorkspace(root);

  repoA = join(root, "repoA");
  mkdirSync(join(repoA, ".git"), { recursive: true });

  repoB = join(root, "repoB");
  mkdirSync(join(repoB, ".git"), { recursive: true });
  await initWorkspace(repoB);

  deep = join(repoA, "pkg", "src");
  mkdirSync(deep, { recursive: true });
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry: makeRegistry(), env: { MYC_ACTOR: "tester" } });
}

describe("findWorkspaceDb: подъём вверх, первый найденный побеждает", () => {
  test("вложенный репозиторий без своего .myc поднимается до корневого", () => {
    const found = findWorkspaceDb(deep);
    expect("dbPath" in found).toBe(true);
    if ("dbPath" in found) {
      expect(found.dbPath).toBe(join(root, ".myc", "myc.db"));
      expect(found.wsDir).toBe(root);
    }
  });

  test("вложенный репозиторий СО своим .myc обслуживает себя, не поднимается к корню", () => {
    const found = findWorkspaceDb(repoB);
    expect("dbPath" in found).toBe(true);
    if ("dbPath" in found) {
      expect(found.dbPath).toBe(join(repoB, ".myc", "myc.db"));
      expect(found.wsDir).toBe(repoB);
    }
  });

  test("выше домашнего каталога поиск прекращается: не подхватывает личный ярус", async () => {
    // Кладём воркспейс НАД тем деревом, что якобы «дом» — граница обязана
    // остановить подъём до него, а не заглянуть внутрь домашнего каталога.
    const above = mkdtempSync(join(tmpdir(), "myc-above-home-"));
    const home = join(above, "home");
    mkdirSync(home, { recursive: true });
    await initWorkspace(home); // это личный ярус: MYC_HOME указывает сюда
    const nested = join(home, "project", "src");
    mkdirSync(nested, { recursive: true });

    const savedHome = process.env.MYC_HOME;
    process.env.MYC_HOME = home;
    try {
      const found = findWorkspaceDb(nested);
      expect("searched" in found).toBe(true);
      if ("searched" in found) {
        // Проверили project/src и project, но НЕ сам домашний каталог.
        expect(found.searched).toEqual([
          join(nested, ".myc", "myc.db"),
          join(home, "project", ".myc", "myc.db"),
        ]);
      }
    } finally {
      process.env.MYC_HOME = savedHome;
      rmSync(above, { recursive: true, force: true });
    }
  });

  test("сам домашний каталог как стартовый — проверяется (без изменения старого поведения)", async () => {
    await initWorkspace(homeDir);
    try {
      const found = findWorkspaceDb(homeDir);
      expect("dbPath" in found).toBe(true);
      if ("dbPath" in found) expect(found.wsDir).toBe(homeDir);
    } finally {
      rmSync(join(homeDir, ".myc"), { recursive: true, force: true });
    }
  });
});

describe("openStore через CLI: сквозная приёмка R1", () => {
  test("из repoA (без своего .myc) видна корневая очередь", async () => {
    const created = await myc(repoA, "task", "из глубины", "-p", "P1");
    expect(created.code).toBe(0);

    const ready = await myc(root, "ready");
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain("из глубины");
  });

  test("из repoB (со своим .myc) корневая очередь не видна", async () => {
    await myc(repoA, "task", "корневая задача", "-p", "P1");

    const ready = await myc(repoB, "ready");
    expect(ready.code).toBe(0);
    expect(ready.stdout).not.toContain("корневая задача");
  });

  test("выше границы — внятная ошибка ws.not_initialized со списком путей", async () => {
    const orphan = mkdtempSync(join(tmpdir(), "myc-orphan-"));
    const savedHome = process.env.MYC_HOME;
    process.env.MYC_HOME = orphan; // граница = сам orphan, дерево внутри него без .myc
    const nested = join(orphan, "a", "b");
    mkdirSync(nested, { recursive: true });
    try {
      const result = await myc(nested, "ready");
      expect(result.code).toBe(7); // ExitCode.NOWS
      expect(result.stderr).toContain("ws.not_initialized");
      expect(result.stderr).toContain(join(nested, ".myc", "myc.db"));
      expect(result.stderr).toContain(join(orphan, "a", ".myc", "myc.db"));
    } finally {
      process.env.MYC_HOME = savedHome;
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  test("--db сильнее поиска: явный путь используется как есть, даже вложенный", async () => {
    const dbPath = join(root, ".myc", "myc.db");
    const result = await run(["-C", repoA, "--db", dbPath, "ready"], {
      registry: makeRegistry(),
      env: { MYC_ACTOR: "tester" },
    });
    expect(result.code).toBe(0);
  });

  test("--db на несуществующий файл: однопутевая ошибка, без поиска по дереву", async () => {
    const missing = join(repoA, "нет-такого", "myc.db");
    const result = await run(["-C", repoA, "--db", missing, "ready"], {
      registry: makeRegistry(),
      env: { MYC_ACTOR: "tester" },
    });
    expect(result.code).toBe(7);
    expect(result.stderr).toContain(`no ${missing}`);
  });
});
