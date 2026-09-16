/**
 * `--db` — это база И её воркспейс (memory-h0d5p1smqb5v, memory-dyjt6fafz8j9).
 *
 * Прежде явный `--db` брал базу из флага, а `workspace.toml` — из каталога
 * `-C`/cwd. Слаг (а с ним id и scope каждого нового узла) приезжал от того
 * воркспейса, ИЗ которого позвали, а не от того, ЧЬЯ база: `import-beads` на
 * копии cherry положил 105 задач в scope '' вместо 'cherry', и проверка «на
 * копии» показывала не то, что сделал бы настоящий прогон.
 *
 * Правило одно для CLI и MCP: конфиг воркспейса — `workspace.toml` рядом с
 * базой (для `<dir>/.myc/myc.db` это `<dir>/.myc/workspace.toml`, как и без
 * `--db`). Рядом его нет — умолчания базы; конфиг чужого воркспейса вокруг
 * `-C`/cwd не подставляется никогда, а если он был бы подставлен прежде и дал
 * бы другой слаг — это сказано вслух (WARN ws.db_config).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createReadyCommand } from "./ready.ts";
import { createTaskCommand } from "./tasks.ts";

let root: string;
let home: string;
let cherry: string; // воркспейс, чья база
let local: string; // воркспейс, из которого зовут

async function initDb(path: string): Promise<void> {
  const raw = new Database(path, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
}

async function initWorkspace(dir: string, slug: string): Promise<void> {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  await initDb(join(dir, ".myc", "myc.db"));
  writeFileSync(join(dir, ".myc", "workspace.toml"), `slug = "${slug}"\n`);
}

function registry(): Registry {
  const r = new Registry();
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  return r;
}

async function json(...argv: string[]): Promise<{ code: number; env: any }> {
  const r = await run([...argv, "--json"], { registry: registry(), env: { MYC_ACTOR: "tester" } });
  return { code: r.code, env: JSON.parse(r.stdout as string) };
}

function scopeOf(dbPath: string, id: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT scope FROM nodes WHERE id = ?1").get(id) as { scope: string } | null)?.scope;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-dbflag-"));
  home = join(root, "home");
  mkdirSync(home);
  process.env.MYC_HOME = home;
  cherry = join(root, "cherry");
  local = join(root, "local");
  mkdirSync(join(cherry, "messaging-server"), { recursive: true });
  await initWorkspace(cherry, "cherry");
  await initWorkspace(local, "local");
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("--db: конфиг воркспейса — рядом с базой", () => {
  test("-C в подкаталог воркспейса базы: узел ложится в слаг базы, а не в ''", async () => {
    const db = join(cherry, ".myc", "myc.db");
    const r = await json("--db", db, "-C", join(cherry, "messaging-server"), "task", "Импорт из beads");
    expect(r.code).toBe(0);
    const id = r.env.data.id as string;
    expect(id.startsWith("cherry-")).toBe(true);
    expect(scopeOf(db, id)).toBe("cherry");
    // и читается тем же слагом: ready из того же каталога видит задачу
    const ready = await json("--db", db, "-C", join(cherry, "messaging-server"), "ready");
    expect((ready.env.data.items as { id: string }[]).map((i) => i.id)).toContain(id);
  });

  test("-C в ЧУЖОЙ воркспейс: слаг всё равно от базы, чужой workspace.toml не читается", async () => {
    const db = join(cherry, ".myc", "myc.db");
    const r = await json("--db", db, "-C", local, "task", "Задача базы cherry");
    expect(r.code).toBe(0);
    expect((r.env.data.id as string).startsWith("cherry-")).toBe(true);
    expect(scopeOf(db, r.env.data.id)).toBe("cherry");
    expect(r.env.warn).toEqual([]);
  });

  test("копия базы файлом где угодно: workspace.toml, лежащий рядом с ней, — её конфиг", async () => {
    const copyDir = join(root, "copy");
    mkdirSync(copyDir);
    const db = join(copyDir, "copy.db");
    await initDb(db);
    writeFileSync(join(copyDir, "workspace.toml"), `slug = "cherry"\n`);
    const r = await json("--db", db, "-C", local, "task", "Проверка на копии");
    expect(r.code).toBe(0);
    expect((r.env.data.id as string).startsWith("cherry-")).toBe(true);
    expect(scopeOf(db, r.env.data.id)).toBe("cherry");
  });

  test("рядом с базой конфига нет: умолчания базы, а подмена слагом cwd названа вслух", async () => {
    const db = join(root, "bare.db");
    await initDb(db);
    const r = await json("--db", db, "-C", local, "task", "Без конфига");
    expect(r.code).toBe(0);
    expect((r.env.data.id as string).startsWith("myc-")).toBe(true);
    expect(scopeOf(db, r.env.data.id)).toBe("");
    const warn = r.env.warn as { code: string; msg: string }[];
    expect(warn.map((w) => w.code)).toEqual(["ws.db_config"]);
    expect(warn[0]!.msg).toContain(`slug "local"`);
    expect(warn[0]!.msg).toContain(join(root, "workspace.toml"));
  });

  test("вокруг нет никакого воркспейса — умолчания молча: спорить не с кем", async () => {
    const db = join(root, "bare.db");
    await initDb(db);
    const plain = join(root, "plain");
    mkdirSync(plain);
    const r = await json("--db", db, "-C", plain, "task", "Совсем без конфига");
    expect(r.code).toBe(0);
    expect((r.env.data.id as string).startsWith("myc-")).toBe(true);
    expect(r.env.warn).toEqual([]);
  });
});
