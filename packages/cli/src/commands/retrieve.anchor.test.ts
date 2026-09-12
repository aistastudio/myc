/**
 * `recall --anchor <file>` видит НАСТОЯЩИЕ якоря (memory-1sw246ajrw5h).
 *
 * Прежний фильтр искал подстроку пути в `attrs.anchors[]`, а туда пишется
 * только НЕУДАВШАЯСЯ привязка (намерение `state=pending`): узел с настоящим
 * якорем (таблица anchors, ребро touches) не находился ни из CLI, ни из MCP
 * `myc_recall`, ни из веба — все они идут через `retrieve()`.
 *
 * Воркспейс — git-репозиторий с вложенным `svc`: у якоря на `svc/x.ts` два
 * ключа — из корня `('', 'svc/x.ts')` и из самого `svc` `('svc', 'x.ts')`.
 * Фильтр обязан видеть оба, откуда бы ни спросили.
 *
 * МУТАЦИИ ПРИЁМКИ:
 *   «фильтр по attrs»  — `dropMaskOf` без `anchored` (прежнее поведение):
 *                        краснеют «оба ключа из корня», «из svc», «по строке»;
 *   «один ключ»        — в `anchoredBySource` только первый ключ
 *                        `anchorKeysFor`: краснеют «оба ключа из корня», «из
 *                        svc» и «по строке» (нет якоря, поставленного из svc);
 *   «без намерений»    — снят фильтр по `attrs.anchors`: краснеет «намерение».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { realStoreDeps } from "./store.ts";

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (!p.success) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function repo(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
}

let sandbox: string;
let ws: string;
let svc: string;
let home: string;

function registry(): Registry {
  const r = new Registry();
  const deps: RetrieveDeps = {
    openStore: realStoreDeps.openStore,
    ...realRetrieveExtras,
    resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
  };
  r.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
  r.register(createRecallCommand(deps));
  r.register(createAnchorCommand());
  return r;
}

interface Envelope {
  ok: boolean;
  data: any;
  error?: { code: string; msg: string };
}

async function myc(dir: string, ...args: string[]): Promise<Envelope> {
  const r = await run(["-C", dir, ...args, "--json"], {
    registry: registry(),
    env: { MYC_ACTOR: "tester", MYC_HOME: home },
  });
  const out = typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
  const env = JSON.parse(out) as Envelope;
  if (!env.ok) throw new Error(`${args.join(" ")} from ${dir}: ${JSON.stringify(env.error)}`);
  return env;
}

async function remember(dir: string, text: string, ...extra: string[]): Promise<string> {
  return (await myc(dir, "remember", text, ...extra)).data.id as string;
}

/** id выдачи recall по запросу «прогрев» с --anchor; сортированы. */
async function recallIds(dir: string, anchor: string): Promise<{ ids: string[]; dropped: number }> {
  const env = await myc(dir, "recall", "прогрев", "--mode", "bm25", "--repo", "all", "--anchor", anchor);
  return {
    ids: (env.data.rows as Array<{ id: string }>).map((r) => r.id).sort(),
    dropped: env.data.drops.anchor as number,
  };
}

let fromRoot: string;
let fromSvc: string;
let neighbour: string;
let intent: string;
let plain: string;

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-recall-anchor-")));
  home = join(sandbox, "home");
  mkdirSync(home);
  ws = join(sandbox, "ws");
  repo(ws, { ".gitignore": ".myc/\nsvc/\n", "README.md": "root\n" });
  svc = join(ws, "svc");
  repo(svc, { "x.ts": "export const x = 1;\nexport const x2 = 2;\n", "y.ts": "export const y = 1;\n" });
  mkdirSync(join(ws, ".myc"));
  const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  fromRoot = await remember(ws, "прогрев ключей держит кеш тёплым");
  await myc(ws, "anchor", "add", fromRoot, "svc/x.ts:1");
  fromSvc = await remember(svc, "прогрев таблиц идёт до первого запроса");
  await myc(svc, "anchor", "add", fromSvc, "x.ts:2");
  neighbour = await remember(ws, "прогрев соседнего файла не про x");
  await myc(ws, "anchor", "add", neighbour, "svc/y.ts:1");
  // Привязка не удалась — намерение осталось в attrs.anchors (state=pending).
  intent = await remember(ws, "прогрев отложенного файла", "--anchor", "svc/later.ts:1");
  plain = await remember(ws, "прогрев без всякого якоря");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("recall --anchor по таблице anchors", () => {
  test("из корня: оба ключа файла — якорь из корня и якорь из svc", async () => {
    const r = await recallIds(ws, "svc/x.ts");
    expect(r.ids).toEqual([fromRoot, fromSvc].sort());
    // Отсев назван числом и своей причиной: всё, что без флага было бы в
    // выдаче (сосед, намерение, узел без якоря и узлы-якоря из графа), кроме двух.
    const all = await myc(ws, "recall", "прогрев", "--mode", "bm25", "--repo", "all", "-n", "50");
    expect(all.data.total).toBeGreaterThanOrEqual(5);
    expect(r.dropped).toBe(all.data.total - 2);
  });

  test("из svc: путь от каталога вызова, те же два узла", async () => {
    expect((await recallIds(svc, "x.ts")).ids).toEqual([fromRoot, fromSvc].sort());
    // Абсолютный путь (так его отдаёт хук) — то же самое.
    expect((await recallIds(svc, join(svc, "x.ts"))).ids).toEqual([fromRoot, fromSvc].sort());
  });

  test("по строке: только спаны, покрывающие её", async () => {
    expect((await recallIds(ws, "svc/x.ts:2")).ids).toEqual([fromSvc]);
    expect((await recallIds(ws, "svc/x.ts:1")).ids).toEqual([fromRoot]);
  });

  test("намерение (неудавшаяся привязка) — по-прежнему находится", async () => {
    expect((await recallIds(ws, "svc/later.ts")).ids).toEqual([intent]);
  });

  test("файл без якорей и файл вне воркспейса — пусто, а не всё подряд", async () => {
    expect((await recallIds(ws, "README.md")).ids).toEqual([]);
    expect((await recallIds(ws, join(sandbox, "elsewhere.ts"))).ids).toEqual([]);
    expect(plain).toBeDefined();
  });
});
