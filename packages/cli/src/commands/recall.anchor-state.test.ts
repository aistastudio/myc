/**
 * Плашка состояния якоря в recall (docs/design/01 §7.3, memory-ndw1r1kch4px).
 *
 * Гибрид понижает знание по состоянию лучшего якоря (drifted × сходство,
 * stale × 0.5, lost × 0.2) и отдаёт HybridHit.anchorState/anchorWeight. Раньше
 * retrieve.ts переносил поля хита в строку поимённо и эти два не переносил:
 * знание стояло ниже живого аналога, а ни текст recall, ни --json, ни MCP не
 * говорили почему.
 *
 * Якоря ставит НАСТОЯЩИЙ `myc anchor add`, состояние — тем же путём, что
 * проверка якорей (applyCheck в anchor.ts): строка `anchors` и статус
 * узла-якоря через GraphStore, то есть в оплог.
 *
 * МУТАЦИИ ПРИЁМКИ:
 *   «не переносить» — в retrieve.ts убрать anchor_state/anchor_weight из
 *                     строки: краснеют «--json» и «текст» (плашки нет);
 *   «без плашки»    — в recall.ts headPrefix без anchorBadge: краснеют
 *                     «текст» и «свёрнутая строка»;
 *   «якорь в счёт»  — anchor_lost считает и строки самих узлов-якорей:
 *                     краснеет «--json» (2 вместо 1) и подвал в «тексте».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { generateId } from "@myc/core";
import { GraphStore, migrate, migrations, openSqlite } from "@myc/store-sqlite";
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

let sandbox: string;
let ws: string;
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

async function raw(...args: string[]): Promise<string> {
  const r = await run(["-C", ws, ...args], { registry: registry(), env: { MYC_ACTOR: "tester", MYC_HOME: home } });
  return typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
}

async function json(...args: string[]): Promise<{ data: any; meta: any }> {
  const env = JSON.parse(await raw(...args, "--json")) as { ok: boolean; data: any; meta: any; error?: unknown };
  if (!env.ok) throw new Error(`${args.join(" ")}: ${JSON.stringify(env.error)}`);
  return env;
}

/**
 * Состояние всех якорей знания `id` — как его пишет проверка якорей
 * (applyCheck): строка `anchors` и статус узла-якоря через GraphStore.
 */
function setAnchorState(id: string, state: "fresh" | "drifted" | "stale" | "lost", drift = 1): void {
  const driver = openSqlite(join(ws, ".myc", "myc.db"));
  try {
    const store = new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "tester" });
    const anchors = driver.database
      .query<{ a: string }, [string]>(
        "SELECT dst AS a FROM edges WHERE src = ?1 AND type = 'touches' AND deleted_at IS NULL",
      )
      .all(id);
    expect(anchors.length).toBeGreaterThan(0);
    for (const { a } of anchors) {
      driver.database.query("UPDATE anchors SET state = ?2, drift = ?3 WHERE node_id = ?1").run(a, state, drift);
      store.updateNode(a, { status: state });
    }
  } finally {
    driver.close();
  }
}

const TOPIC = "слияние RRF константа";
const ids: Record<"live" | "moved" | "moved1" | "unverified" | "gone" | "plain", string> = {
  live: "",
  moved: "",
  moved1: "",
  unverified: "",
  gone: "",
  plain: "",
};

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-recall-anchor-state-")));
  home = join(sandbox, "home");
  mkdirSync(home);
  ws = join(sandbox, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  const names = ["live", "moved", "moved1", "unverified", "gone"] as const;
  for (const n of names) {
    // Файлы разные: узел-якорь называется `файл:спан`, и два якоря на один
    // спан — один и тот же узел по content_hash.
    writeFileSync(join(ws, "src", `${n}.ts`), `export function fuse_${n}(a: number[]): number[] {\n  const k = 60;\n  return a.map((x) => x / k);\n}\n`);
  }
  writeFileSync(join(ws, ".gitignore"), ".myc/\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-qm", "init");
  mkdirSync(join(ws, ".myc"));
  const db = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  db.close();

  const text: Record<keyof typeof ids, string> = {
    live: "живой код",
    moved: "код сдвинулся",
    moved1: "код переехал целиком",
    unverified: "требует проверки",
    gone: "код удалён",
    plain: "без якоря",
  };
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) {
    ids[k] = (await json("remember", `Слияние RRF: константа сглаживания шестьдесят — ${text[k]}`, "--reach", "project")).data.id;
  }
  for (const n of names) await json("anchor", "add", ids[n], `src/${n}.ts:1-4`);
  setAnchorState(ids.moved, "drifted", 0.64);
  setAnchorState(ids.moved1, "drifted", 1.0);
  setAnchorState(ids.unverified, "stale");
  setAnchorState(ids.gone, "lost");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("recall: состояние якоря — в строке, в тексте, в подвале", () => {
  test("--json: anchor_state/anchor_weight у понижённых, нет у свежих и без якоря", async () => {
    const env = await json("recall", TOPIC, "--mode", "bm25", "--repo", "all", "-n", "50");
    const rows = env.data.rows as Array<{ id: string; kind: string; score: number; anchor_state?: string; anchor_weight?: number }>;
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const k of Object.keys(ids) as (keyof typeof ids)[]) expect(by.has(ids[k])).toBe(true);
    const pick = (k: keyof typeof ids) => {
      const r = by.get(ids[k])!;
      return { state: r.anchor_state, weight: r.anchor_weight, keys: Object.keys(r).filter((x) => x.startsWith("anchor_")) };
    };
    expect(pick("live")).toEqual({ state: undefined, weight: undefined, keys: [] });
    expect(pick("plain")).toEqual({ state: undefined, weight: undefined, keys: [] });
    expect(pick("moved")).toEqual({ state: "drifted", weight: 0.64, keys: ["anchor_state", "anchor_weight"] });
    // Сдвиг есть, понижения нет: множителя ×1 в строке не бывает.
    expect(pick("moved1")).toEqual({ state: "drifted", weight: undefined, keys: ["anchor_state"] });
    expect(pick("unverified")).toEqual({ state: "stale", weight: 0.5, keys: ["anchor_state", "anchor_weight"] });
    expect(pick("gone")).toEqual({ state: "lost", weight: 0.2, keys: ["anchor_state", "anchor_weight"] });
    // «Почему ниже» сходится с рангом: множитель — тот, которым умножен счёт.
    expect(by.get(ids.gone)!.score).toBeCloseTo(by.get(ids.live)!.score * 0.2, 12);
    // Строка самого узла-якоря тоже несёт своё состояние (он знание о коде)…
    expect(rows.some((r) => r.kind === "anchor" && r.anchor_state === "lost")).toBe(true);
    // …но в счёт «отвязать» идёт только знание: `anchor rm` берёт id знания.
    expect(env.data.anchor_lost).toBe(1);
    expect(env.meta.anchor_lost).toBe(1);
  });

  test("текст: плашка перед заголовком, число и «отвязать» в подвале", async () => {
    const out = await raw("recall", TOPIC, "--mode", "bm25", "--repo", "all", "-n", "50", "--budget", "8000");
    const line = (k: keyof typeof ids): string => out.split("\n").find((l) => l.includes(ids[k]))!;
    expect(line("moved")).toContain("  [code moved ×0.64] Слияние RRF");
    expect(line("moved1")).toContain("  [code moved] Слияние RRF");
    expect(line("unverified")).toContain("  [code unverified ×0.5] Слияние RRF");
    expect(line("gone")).toContain("  [code gone ×0.2] Слияние RRF");
    expect(line("live")).not.toContain("[code ");
    expect(line("plain")).not.toContain("[code ");
    const footer = out.trimEnd().split("\n").at(-1)!;
    expect(footer).toContain("1 code gone — unbind: myc anchor rm <id>");
  });

  test("свёрнутая по бюджету строка плашку сохраняет", async () => {
    // Запрос с единственным словом из заголовка удалённого. Бюджет — на пять
    // символов меньше полной карточки: целиком она не влезает, строка
    // сворачивается с урезанным заголовком, а плашка живёт в префиксе.
    const full = await raw("recall", "удалён", "--mode", "bm25", "--repo", "all", "--budget", "8000");
    const card = full.split("\n").find((l) => l.includes(ids.gone))!;
    const out = await raw("recall", "удалён", "--mode", "bm25", "--repo", "all", "--budget", String(card.length - 5));
    const line = out.split("\n").find((l) => l.includes(ids.gone))!;
    expect(line).toContain("… (collapsed)");
    expect(line).toContain("[code gone ×0.2] ");
  });

  test("свежий якорь снова свеж — плашка и счёт уходят", async () => {
    setAnchorState(ids.gone, "fresh");
    const env = await json("recall", TOPIC, "--mode", "bm25", "--repo", "all", "-n", "50");
    const gone = (env.data.rows as Array<{ id: string; anchor_state?: string }>).find((r) => r.id === ids.gone)!;
    expect(gone.anchor_state).toBeUndefined();
    expect(env.data.anchor_lost).toBe(0);
    const out = await raw("recall", TOPIC, "--mode", "bm25", "--repo", "all", "-n", "50", "--budget", "8000");
    expect(out).not.toContain("code gone");
  });
});
