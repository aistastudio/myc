/**
 * Знание, чей код потерян целиком, в prime не попадает (docs/design/01 §7.3:
 * `lost` — «вес × 0.2, не попадает в prime», memory-d81a4d4hn8ef).
 *
 * «Потерян целиком» — ВСЕ якоря узла `lost`. Узел без якорей и узел с хоть
 * одним живым якорем (fresh, drifted, stale) видны как прежде: тот же ответ,
 * что у поиска, где лучший якорь решает (hybrid.anchor.test.ts сверяет
 * предикат с пометкой поиска на всех сочетаниях).
 *
 * Якоря заметок основного стенда ставит НАСТОЯЩИЙ `myc anchor add`, состояние
 * — тем же путём, что проверка якорей (applyCheck в anchor.ts): строка
 * `anchors` и статус узла-якоря через GraphStore, то есть в оплог. Сотня узлов
 * для окна скана собирается той же формой напрямую (узел-якорь, строка
 * anchors, ребро touches) — сто вызовов CLI стоили бы секунд.
 *
 * МУТАЦИИ ПРИЁМКИ:
 *   «без терма»          — снять WHERE anchorsAlivePredicate из prime_digest_scan:
 *                          краснеют «CORE/DECISIONS» и «окно»;
 *   «без терма в repo»   — то же в prime_digest_scan_repo: краснеет «--repo»;
 *   «окно до фильтра»    — внутренний `LIMIT -1` → `LIMIT ?2` (терм после окна
 *                          из 60): краснеет «окно»;
 *   «старый ключ кеша»   — digestVariant остаётся v5: краснеет «кеш до фильтра»;
 *   «двойной счёт»       — prime_lost_count без notPendingClause: краснеет «счёт»;
 *   «молчаливый фильтр»  — подвал без `with code gone hidden`: краснеет
 *                          «CORE/DECISIONS».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { generateId, type Layer } from "@myc/core";
import { GraphStore, migrate, migrations, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createPrimeCommand } from "./prime.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";

const SESSION = "S-anchor-lost";

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
  r.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
  r.register(createPrimeCommand());
  r.register(createAnchorCommand());
  return r;
}

async function raw(...args: string[]): Promise<string> {
  const r = await run(["-C", ws, ...args], { registry: registry(), env: { MYC_ACTOR: "tester", MYC_HOME: home } });
  return typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
}

async function json<T = any>(...args: string[]): Promise<T> {
  const env = JSON.parse(await raw(...args, "--json")) as { ok: boolean; data: T; error?: unknown };
  if (!env.ok) throw new Error(`${args.join(" ")}: ${JSON.stringify(env.error)}`);
  return env.data;
}

interface PrimeView {
  core: { id: string }[];
  decisions: { id: string }[];
  anchor_lost_hidden: number;
  pending_review: number;
  reach_hidden: number;
  repo: string;
  cache: "hit" | "miss";
}

const prime = (...extra: string[]): Promise<PrimeView> => json<PrimeView>("prime", "--session", SESSION, ...extra);
const idsOf = (xs: { id: string }[]): string[] => xs.map((x) => x.id).sort();

function withStore<T>(fn: (store: GraphStore, driver: SqliteDriver) => T): T {
  const driver = openSqlite(join(ws, ".myc", "myc.db"));
  try {
    return fn(new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "tester" }), driver);
  } finally {
    driver.close();
  }
}

function anchorsOf(id: string): string[] {
  return withStore((_, driver) =>
    driver.database
      .query<{ a: string }, [string]>(
        "SELECT dst AS a FROM edges WHERE src = ?1 AND type = 'touches' AND deleted_at IS NULL ORDER BY dst",
      )
      .all(id)
      .map((r) => r.a),
  );
}

/** Состояние якоря — как его пишет applyCheck: строка anchors и статус узла-якоря (оплог). */
function setState(anchorIds: readonly string[], state: "fresh" | "drifted" | "stale" | "lost", drift = 1): void {
  withStore((store, driver) => {
    for (const a of anchorIds) {
      driver.database.query("UPDATE anchors SET state = ?2, drift = ?3 WHERE node_id = ?1").run(a, state, drift);
      store.updateNode(a, { status: state });
    }
  });
}

/**
 * Знание с одним потерянным якорем той же формой, что у `anchor add`: узел-якорь
 * (kind anchor), строка anchors, ребро touches от знания.
 */
function lostKnowledge(
  store: GraphStore,
  driver: SqliteDriver,
  scope: string,
  title: string,
  layer: Layer,
  attrs: Record<string, string>,
): string {
  const k = store.createNode({ kind: "note", layer, salience: 1, scope, title, actor: "tester", attrs });
  const a = store.createNode({ kind: "anchor", scope, status: "lost", title: `gone/${k.id}.ts:1-4`, actor: "tester" });
  driver.database
    .query(
      `INSERT INTO anchors (node_id, repo_id, path, span_start, span_end, file_hash, span_hash, crux, crux_norm, state, drift, bound_at)
       VALUES (?1, '', ?2, 1, 4, 'h', 'h', 'c', 'c', 'lost', 1.0, 1)`,
    )
    .run(a.id, `gone/${k.id}.ts`);
  store.addEdge(k.id, "touches", a.id);
  return k.id;
}

const n: Record<"live" | "plain" | "mixed" | "gone" | "unver" | "moved" | "goneCore", string> = {
  live: "",
  plain: "",
  mixed: "",
  gone: "",
  unver: "",
  moved: "",
  goneCore: "",
};

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-prime-anchor-lost-")));
  home = join(sandbox, "home");
  mkdirSync(home);
  ws = join(sandbox, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  const files = ["live", "mixed1", "mixed2", "gone", "unver", "moved", "goneCore"];
  for (const f of files) {
    writeFileSync(join(ws, "src", `${f}.ts`), `export function f_${f}(a: number): number {\n  const k = 60;\n  return a / k;\n}\n`);
  }
  writeFileSync(join(ws, ".gitignore"), ".myc/\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-qm", "init");
  mkdirSync(join(ws, ".myc"));
  const db = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  db.close();

  const note = async (text: string, layer: "L2" | "L3"): Promise<string> =>
    (await json<{ id: string }>("remember", text, "--layer", layer, "--reach", "project")).id;
  // DECISIONS L2 показывает три — ровно три видимых L2, и один спрятанный.
  n.live = await note("решение с живым кодом", "L2");
  n.plain = await note("решение без якоря вовсе", "L2");
  n.mixed = await note("решение, у которого один якорь потерян, другой жив", "L2");
  n.gone = await note("решение, чей код удалён", "L2");
  // CORE L3 показывает четыре — два видимых L3 (stale, drifted) и спрятанный.
  n.unver = await note("правило, чей код требует проверки", "L3");
  n.moved = await note("правило, чей код сдвинулся", "L3");
  n.goneCore = await note("правило, чей код переписан", "L3");
  await json("anchor", "add", n.live, "src/live.ts:1-4");
  await json("anchor", "add", n.mixed, "src/mixed1.ts:1-4");
  await json("anchor", "add", n.mixed, "src/mixed2.ts:1-4");
  await json("anchor", "add", n.gone, "src/gone.ts:1-4");
  await json("anchor", "add", n.unver, "src/unver.ts:1-4");
  await json("anchor", "add", n.moved, "src/moved.ts:1-4");
  await json("anchor", "add", n.goneCore, "src/goneCore.ts:1-4");
  setState(anchorsOf(n.mixed).slice(0, 1), "lost");
  setState(anchorsOf(n.gone), "lost");
  setState(anchorsOf(n.unver), "stale");
  setState(anchorsOf(n.moved), "drifted", 0.64);
  setState(anchorsOf(n.goneCore), "lost");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("prime: знание с потерянным кодом не попадает в дайджест", () => {
  test("CORE/DECISIONS: все якоря lost — скрыто; без якорей, с живым, stale, drifted — видно; число в подвале", async () => {
    expect(anchorsOf(n.mixed).length).toBe(2);
    const d = await prime();
    expect(idsOf(d.decisions)).toEqual([n.live, n.plain, n.mixed].sort());
    expect(idsOf(d.core)).toEqual([n.unver, n.moved].sort());
    expect(d.anchor_lost_hidden).toBe(2);
    const out = await raw("prime", "--session", SESSION);
    expect(out).not.toContain("чей код удалён");
    expect(out).not.toContain("чей код переписан");
    expect(out).toContain("2 with code gone hidden");
  });

  test("--repo: второй запрос дайджеста фильтрует так же", async () => {
    const d = await prime("--repo", "collector");
    expect(d.repo).toBe("collector");
    expect(idsOf(d.decisions)).toEqual([n.live, n.plain, n.mixed].sort());
    expect(idsOf(d.core)).toEqual([n.unver, n.moved].sort());
    expect(d.anchor_lost_hidden).toBe(2);
  });

  test("--focus (мимо кеша) — тот же фильтр", async () => {
    expect((await prime("--focus", "удалён")).decisions).toEqual([]);
    expect(idsOf((await prime("--focus", "живым")).decisions)).toEqual([n.live]);
  });

  // ОКНО СКАНА — 60 строк в порядке (layer DESC, salience DESC). Сто L3 с
  // потерянным кодом и salience 1 стоят в нём раньше любой L2: терм после
  // окна отдал бы окно им, и DECISIONS осталась бы пустой.
  test("окно: сто L3 с потерянным кодом впереди не вытесняют живые L2", async () => {
    withStore((store, driver) => {
      const scope = store.getNode(n.live)!.scope;
      for (let i = 0; i < 100; i++) lostKnowledge(store, driver, scope, `правило ${i}, код удалён`, 3, { reach: "project" });
    });
    const d = await prime();
    expect(idsOf(d.decisions)).toEqual([n.live, n.plain, n.mixed].sort());
    expect(idsOf(d.core)).toEqual([n.unver, n.moved].sort());
    expect(d.anchor_lost_hidden).toBe(102);
  });

  test("счёт: у каждого скрытого одна причина — кандидат, отозванное и чужое сюда не входят", async () => {
    withStore((store, driver) => {
      const scope = store.getNode(n.live)!.scope;
      // Кандидат хука сжатия своей сессии с потерянным якорем — уже «pending review».
      lostKnowledge(store, driver, scope, "кандидат с потерянным кодом", 2, {
        state: "pending_review",
        reach: "session",
        session_id: SESSION,
      });
      // Чужая сессия — уже «from other sessions».
      lostKnowledge(store, driver, scope, "чужое с потерянным кодом", 2, { reach: "session", session_id: "S-other" });
      // Отозванное — не знание вовсе, его не называют.
      const retracted = lostKnowledge(store, driver, scope, "отозванное с потерянным кодом", 2, { reach: "project" });
      store.updateNode(retracted, { status: "retracted" });
    });
    const d = await prime();
    expect(d.anchor_lost_hidden).toBe(2);
    expect(d.pending_review).toBe(1);
    expect(d.reach_hidden).toBe(1);
  });

  test("якорь потерян после прогретого кеша — prime это видит (оплог двигает seq)", async () => {
    expect(idsOf((await prime()).decisions)).toContain(n.live);
    expect((await prime()).cache).toBe("hit");
    setState(anchorsOf(n.live), "lost");
    const d = await prime();
    expect(d.cache).toBe("miss");
    expect(idsOf(d.decisions)).toEqual([n.plain, n.mixed].sort());
    expect(d.anchor_lost_hidden).toBe(3);
    // Якорь нашёлся снова — знание вернулось.
    setState(anchorsOf(n.live), "fresh");
    expect(idsOf((await prime()).decisions)).toContain(n.live);
  });

  // Дайджест, посчитанный ДО фильтра, лежит под ключом v5 и несёт удалённое в
  // DECISIONS; без смены версии ключа попадание в кеш отдало бы его после
  // обновления, пока в базу никто не пишет.
  test("кеш до фильтра: запись под старым ключом после обновления не отдаётся", async () => {
    const first = await prime();
    withStore((store, driver) => {
      const scope = store.getNode(n.gone)!.scope;
      const seq = driver.database
        .query<{ s: number }, [string]>("SELECT coalesce(max(seq), 0) AS s FROM oplog WHERE scope = ?1")
        .get(scope)!.s;
      const stale = {
        core: [],
        decisions: [{ id: n.gone, title: "решение, чей код удалён", updated_at: 1, tier: "project", reach: "project", reach_by: "recorded" }],
        reach: { hidden: 0, unknown: 0 },
        repo: { hidden: 0, unknown: 0 },
        pending: 0,
      };
      driver.database
        .query(
          `INSERT INTO digest_cache (scope, profile, variant, seq, payload) VALUES (?1, 'prime', ?2, ?3, ?4)
           ON CONFLICT(scope, profile, variant) DO UPDATE SET seq = excluded.seq, payload = excluded.payload`,
        )
        .run(scope, `v5:${SESSION}:${first.repo}`, seq, JSON.stringify(stale));
    });
    const d = await prime();
    expect(idsOf(d.decisions)).not.toContain(n.gone);
    expect(d.anchor_lost_hidden).toBe(2);
  });
});
