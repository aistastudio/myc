/**
 * `myc export` / `myc import` / `myc merge-driver` через публичный run(),
 * как их зовёт main.ts. Семантику CRDT-мержа и настоящие git-репозитории
 * проверяет store-sqlite/git-sync.test.ts; здесь — грамматика, коды выхода,
 * конверты и то, что две реплики через файлы сходятся.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations, Q, GITATTRIBUTES_FILE, GITIGNORE_FILE } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand, createUpdateCommand } from "./tasks.ts";
import { createShowCommand } from "./show.ts";
import { createExportCommand } from "./export.ts";
import { createImportCommand } from "./import.ts";
import { createMergeDriverCommand } from "./merge-driver.ts";

let root: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createTaskCommand());
  r.register(createUpdateCommand());
  r.register(createShowCommand());
  r.register(createExportCommand());
  r.register(createImportCommand());
  r.register(createMergeDriverCommand());
  return r;
}

async function workspace(name: string, siteId: string): Promise<string> {
  const dir = join(root, name);
  mkdirSync(join(dir, ".myc"), { recursive: true });
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.prepare(Q.meta_set.sql).run("site_id", siteId);
  raw.close();
  return dir;
}

beforeEach(() => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-cli-sync-"));
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(root, { recursive: true, force: true });
});

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function mycJson(dir: string, ...args: string[]): Promise<{ code: number; env: Record<string, unknown> }> {
  const r = await myc(dir, ...args, "--json");
  expect(typeof r.stdout).toBe("string");
  return { code: r.code, env: JSON.parse(r.stdout as string) as Record<string, unknown> };
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

function idOf(out: string | Iterable<string>): string {
  return text(out).split("\n")[0]!.split(/\s+/)[0]!;
}

function graphDir(dir: string): string {
  return join(dir, ".myc", "graph");
}

/** Кеш проекций — рядом с базой, не в каталоге графа. */
function cacheDir(dir: string): string {
  return join(dir, ".myc", "projections");
}

function projectionFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => /^(nodes|edges)-/.test(n)).sort() : [];
}

function oplogFiles(dir: string): string[] {
  const root = join(graphDir(dir), "oplog");
  const out: string[] = [];
  for (const site of readdirSync(root)) {
    for (const f of readdirSync(join(root, site))) out.push(`oplog/${site}/${f}`);
  }
  return out.sort();
}

describe("myc export", () => {
  test("пишет оплог по сайтам, meta.json и .gitattributes с одним драйвером — и ничего производного", async () => {
    const a = await workspace("a", "siteA");
    await myc(a, "task", "первая");
    await myc(a, "task", "вторая");
    const { code, env } = await mycJson(a, "export");
    expect(code).toBe(ExitCode.OK);
    const data = env["data"] as Record<string, unknown>;
    expect(data["sites"]).toBe(1);
    expect(data["pendingImport"]).toBe(0);
    const ops = data["ops"] as number;
    expect(ops).toBeGreaterThan(2);

    expect(oplogFiles(a)).toEqual(["oplog/siteA/00000.jsonl"]);
    const lines = readFileSync(join(graphDir(a), "oplog/siteA/00000.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.length).toBe(ops);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(["op_id", "hlc", "op", "entity", "entity_id", "field", "value"]);
    expect(first["op_id"]).toBe("siteA:1");

    expect(existsSync(join(graphDir(a), "meta.json"))).toBe(true);
    const attrs = readFileSync(join(graphDir(a), GITATTRIBUTES_FILE), "utf8");
    const rules = attrs.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(rules).toEqual(["oplog/**/*.jsonl merge=myc-oplog"]);
    expect(attrs).not.toContain("myc-projection");

    // Каталог графа — только оплог, meta и атрибуты; кеша экспорт не пишет.
    expect(readdirSync(graphDir(a)).sort()).toEqual([GITATTRIBUTES_FILE, "meta.json", "oplog"]);
    expect(existsSync(cacheDir(a))).toBe(false);

    // Повторный экспорт ничего не переписывает.
    const again = await mycJson(a, "export");
    const files = (again.env["data"] as Record<string, unknown>)["files"] as Record<string, string[]>;
    expect(files["written"]).toEqual([]);
  });

  test("человеческий вывод — одна сводка", async () => {
    const a = await workspace("a", "siteA");
    await myc(a, "task", "x");
    const r = await myc(a, "export");
    expect(r.code).toBe(ExitCode.OK);
    expect(text(r.stdout)).toMatch(/операций \(1 сайт, по \d+ в файле\)/);
    expect(text(r.stdout)).not.toMatch(/узлов/);
  });

  test("проекции первой редакции S42 в каталоге графа удаляются", async () => {
    const a = await workspace("a", "siteA");
    await myc(a, "task", "x");
    await myc(a, "export");
    writeFileSync(join(graphDir(a), "nodes-a.jsonl"), "{}\n");
    const { env } = await mycJson(a, "export");
    const files = (env["data"] as Record<string, unknown>)["files"] as Record<string, string[]>;
    expect(files["removed"]).toEqual(["nodes-a.jsonl"]);
    expect(projectionFiles(graphDir(a))).toEqual([]);
  });
});

describe("myc import", () => {
  test("две реплики сходятся через файлы; повтор идемпотентен", async () => {
    const a = await workspace("a", "siteA");
    const b = await workspace("b", "siteB");
    const id = await myc(a, "task", "общая задача").then((r) => idOf(r.stdout));
    await myc(a, "export");

    cpSync(graphDir(a), graphDir(b), { recursive: true });
    const first = await mycJson(b, "import");
    expect(first.code).toBe(ExitCode.OK);
    const d1 = first.env["data"] as Record<string, unknown>;
    expect(d1["fresh"]).toBeGreaterThan(0);
    expect(d1["applied"]).toBe(d1["fresh"]);
    expect(d1["deferred"]).toEqual([]);
    expect(d1["collided"]).toEqual([]);
    const shown = await myc(b, "show", id);
    expect(shown.code).toBe(ExitCode.OK);
    expect(text(shown.stdout)).toContain("общая задача");

    // Конфликт по одному полю: B пишет позже по часам — побеждает на обеих.
    await myc(a, "update", id, "--title", "от A");
    await myc(b, "update", id, "--title", "от B");
    await myc(a, "export");
    await myc(b, "export");
    // «Мерж»: у каждого сайта свой файл, пересечения нет — просто обмен файлами.
    cpSync(join(graphDir(a), "oplog", "siteA"), join(graphDir(b), "oplog", "siteA"), { recursive: true });
    cpSync(join(graphDir(b), "oplog", "siteB"), join(graphDir(a), "oplog", "siteB"), { recursive: true });
    const ra = await mycJson(a, "import");
    const rb = await mycJson(b, "import");
    expect((ra.env["data"] as Record<string, unknown>)["fresh"]).toBe(1);
    expect((rb.env["data"] as Record<string, unknown>)["fresh"]).toBe(1);
    const ta = text((await myc(a, "show", id)).stdout);
    const tb = text((await myc(b, "show", id)).stdout);
    expect(ta).toContain("от B");
    expect(tb).toContain("от B");

    // Кеш проекций — рядом с базой, сам себя игнорирует, на обеих сторонах
    // побайтово равен; в каталоге графа проекций нет.
    const cache = (ra.env["data"] as Record<string, unknown>)["cache"] as Record<string, unknown>;
    expect(cache["dir"]).toBe(cacheDir(a));
    expect(cache["nodes"]).toBe(1);
    expect(readFileSync(join(cacheDir(a), GITIGNORE_FILE), "utf8")).toContain("*\n");
    expect(projectionFiles(cacheDir(a)).length).toBeGreaterThan(0);
    expect(projectionFiles(cacheDir(a))).toEqual(projectionFiles(cacheDir(b)));
    for (const f of projectionFiles(cacheDir(a))) {
      expect(readFileSync(join(cacheDir(b), f), "utf8")).toBe(readFileSync(join(cacheDir(a), f), "utf8"));
    }
    expect(projectionFiles(graphDir(a))).toEqual([]);
    expect(projectionFiles(graphDir(b))).toEqual([]);

    // Идемпотентность.
    const again = await mycJson(a, "import");
    const d2 = again.env["data"] as Record<string, unknown>;
    expect(d2["fresh"]).toBe(0);
    expect(d2["applied"]).toBe(0);
    const cache2 = d2["cache"] as Record<string, unknown>;
    expect((cache2["files"] as Record<string, string[]>)["written"]).toEqual([]);

    // --no-cache и --cache: кеш не пишется / пишется в указанный каталог.
    const noCache = await mycJson(a, "import", "--no-cache");
    expect((noCache.env["data"] as Record<string, unknown>)["cache"]).toBeUndefined();
    const custom = await mycJson(a, "import", "--cache", "cache-x");
    expect(((custom.env["data"] as Record<string, unknown>)["cache"] as Record<string, unknown>)["dir"]).toBe(join(a, "cache-x"));
    expect(projectionFiles(join(a, "cache-x"))).toEqual(projectionFiles(cacheDir(a)));
  });

  test("--dry-run считает, не применяя; каталога нет — exit 3", async () => {
    const a = await workspace("a", "siteA");
    const b = await workspace("b", "siteB");
    await myc(a, "task", "x");
    await myc(a, "export");
    cpSync(graphDir(a), graphDir(b), { recursive: true });
    const dry = await mycJson(b, "import", "--dry-run");
    const d = dry.env["data"] as Record<string, unknown>;
    expect(d["dry_run"]).toBe(true);
    expect(d["fresh"]).toBeGreaterThan(0);
    expect(d["applied"]).toBe(0);
    const still = await mycJson(b, "import", "--dry-run");
    expect((still.env["data"] as Record<string, unknown>)["fresh"]).toBe(d["fresh"]);

    const c = await workspace("c", "siteC");
    const missing = await myc(c, "import");
    expect(missing.code).toBe(ExitCode.NOTFOUND);
  });

  test("битая строка оплога — громкая ошибка, не тихий пропуск", async () => {
    const a = await workspace("a", "siteA");
    await myc(a, "task", "x");
    await myc(a, "export");
    const f = join(graphDir(a), "oplog", "siteA", "00000.jsonl");
    writeFileSync(f, `${readFileSync(f, "utf8")}{"op_id":"siteA:999"}\n`);
    const r = await myc(a, "import");
    expect(r.code).toBe(ExitCode.PRECOND);
  });
});

describe("myc merge-driver", () => {
  test("оплог: объединение по op_id в %A, код 0; другого вида слияния нет", async () => {
    const a = await workspace("a", "siteA");
    await myc(a, "task", "x");
    await myc(a, "export");
    const oplog = join(graphDir(a), "oplog", "siteA", "00000.jsonl");
    const base = readFileSync(oplog, "utf8");
    await myc(a, "task", "y");
    await myc(a, "export");
    const full = readFileSync(oplog, "utf8");
    expect(full.length).toBeGreaterThan(base.length);

    const dir = join(root, "merge");
    mkdirSync(dir);
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "ours"), base);
    writeFileSync(join(dir, "theirs"), full);
    const r = await myc(
      a,
      "merge-driver",
      join(dir, "base"),
      join(dir, "ours"),
      join(dir, "theirs"),
      "7",
      ".myc/graph/oplog/siteA/00000.jsonl",
    );
    expect(r.code).toBe(ExitCode.OK);
    expect(text(r.stdout)).toContain("объединение по op_id");
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe(full);

    // Симметрично: ours=full, theirs=base — тот же результат.
    writeFileSync(join(dir, "ours"), full);
    writeFileSync(join(dir, "theirs"), base);
    await myc(a, "merge-driver", join(dir, "base"), join(dir, "ours"), join(dir, "theirs"), "7", "x/oplog/siteA/00000.jsonl");
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe(full);

    // Драйвер один и знает только оплог: файл не-оплога он не «сливает»
    // молча своей версией, а оставляет конфликт человеку.
    writeFileSync(join(dir, "ours"), "ours-projection\n");
    writeFileSync(join(dir, "theirs"), "theirs-projection\n");
    const p = await myc(a, "merge-driver", join(dir, "base"), join(dir, "ours"), join(dir, "theirs"), "7", ".myc/graph/nodes-0.jsonl");
    expect(p.code).toBe(ExitCode.CONFLICT);
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe("ours-projection\n");

    // Без %P — то же объединение.
    writeFileSync(join(dir, "ours"), base);
    writeFileSync(join(dir, "theirs"), full);
    await myc(a, "merge-driver", join(dir, "base"), join(dir, "ours"), join(dir, "theirs"));
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe(full);
  });

  test("мало аргументов — usage, нечитаемая строка оплога — conflict", async () => {
    const a = await workspace("a", "siteA");
    const usage = await myc(a, "merge-driver", "/x", "/y");
    expect(usage.code).toBe(ExitCode.USAGE);
    const dir = join(root, "merge");
    mkdirSync(dir);
    writeFileSync(join(dir, "base"), "");
    writeFileSync(join(dir, "ours"), "not json\n");
    writeFileSync(join(dir, "theirs"), "");
    const r = await myc(a, "merge-driver", join(dir, "base"), join(dir, "ours"), join(dir, "theirs"), "7", "oplog/s/00000.jsonl");
    expect(r.code).toBe(ExitCode.CONFLICT);
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe("not json\n");
  });
});
