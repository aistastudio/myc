/**
 * Интеграционные тесты `myc remember` / `recall` / `search` против настоящего
 * SQLite во временной директории — через публичный run(), как их зовёт
 * main.ts. Ретривал (@myc/retrieval) здесь не перепроверяется: у него свои
 * тесты; проверяются грамматика, контракт вывода, федерация двух ярусов,
 * бюджет символов и — отдельным блоком — И2: деградация обязана быть видна.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createRememberCommand, realRememberDeps, type RememberDeps } from "./remember.ts";
import { createRecallCommand } from "./recall.ts";
import { createSearchCommand } from "./search.ts";
import {
  embedTimeoutFromEnv,
  modeLabelOf,
  modelLikelyPresent,
  parseKinds,
  parseLayerRange,
  realRetrieveExtras,
  resolveQueryEmbedder,
  type RetrieveDeps,
} from "./retrieve.ts";
import { realStoreDeps } from "./store.ts";

let dir: string;
let home: string;
let registry: Registry;

/** Эмбеддера в тестах нет: векторная ветка обязана быть громко выключена. */
const noEmbedder: Pick<RetrieveDeps, "resolveEmbedder"> = {
  resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
};

function retrieveDeps(): RetrieveDeps {
  return { openStore: realStoreDeps.openStore, ...realRetrieveExtras, ...noEmbedder };
}

function rememberDeps(overrides: Partial<RememberDeps> = {}): RememberDeps {
  return { ...realRememberDeps, chatLlm: () => false, ...overrides };
}

function makeRegistry(deps: Partial<RememberDeps> = {}): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createRememberCommand(rememberDeps(deps)));
  r.register(createRecallCommand(retrieveDeps()));
  r.register(createSearchCommand(retrieveDeps()));
  return r;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-mem-"));
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
  delete process.env.MYC_EMBED_TIMEOUT_MS;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  meta: Record<string, unknown> & { degraded: string[] };
  warn: { code: string; msg: string }[];
  error?: { code: string; exit: number };
}

async function mycJson(
  ...args: string[]
): Promise<{ code: number; env: Envelope; r: RunResult }> {
  const r = await myc(...args, "--json");
  return { code: r.code, env: JSON.parse(text(r.stdout)) as Envelope, r };
}

// ===========================================================================
// remember
// ===========================================================================

describe("myc remember", () => {
  test("пишет узел, ставит embed и absorb в очередь и укладывается в бюджет", async () => {
    const { code, env } = await mycJson(
      "remember",
      "RRF k=60 даёт лучший recall@10 на нашем корпусе",
      "--tag",
      "retrieval,rrf",
    );
    expect(code).toBe(ExitCode.OK);
    expect(env.ok).toBe(true);
    expect(env.data["kind"]).toBe("note");
    expect(env.data["tier"]).toBe("project");
    expect(env.data["tags"]).toEqual(["retrieval", "rrf"]);
    expect(env.data["queue"]).toEqual(["embed", "absorb"]);
    // Не бенчмарк (это делает scripts/bench-latency), а страховка от того, что
    // в горячий путь записи once again заедет что-то сетевое или модельное.
    expect(env.data["took_ms"] as number).toBeLessThan(200);

    const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
    const jobs = db.query("SELECT kind, entity_id FROM jobs ORDER BY kind").all() as {
      kind: string;
      entity_id: string;
    }[];
    db.close();
    expect(jobs.map((j) => j.kind)).toEqual(["absorb", "embed"]);
    expect(new Set(jobs.map((j) => j.entity_id))).toEqual(new Set([env.data["id"] as string]));
  });

  test("тяжёлая работа уходит в очередь, а не в горячий путь", async () => {
    // Формальная проверка И1 для этой команды: единственные следы «дорогого» —
    // строки в jobs; никаких эмбеддингов и классификаций в самой записи нет.
    await myc("remember", "факт для очереди");
    const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
    const kinds = (db.query("SELECT kind FROM jobs").all() as { kind: string }[]).map((r) => r.kind);
    const vecTables = db
      .query("SELECT name FROM sqlite_master WHERE name LIKE 'vec_%' OR name LIKE '%_vec'")
      .all() as { name: string }[];
    db.close();
    expect(kinds.sort()).toEqual(["absorb", "embed"]);
    expect(vecTables).toEqual([]);
  });

  test("--no-absorb не ставит absorb", async () => {
    const { env } = await mycJson("remember", "факт без классификации", "--no-absorb");
    expect(env.data["queue"]).toEqual(["embed"]);
    expect(env.data["absorb_heuristic"]).toBe(false);
  });

  test("отсутствие chat-LLM написано в выводе (И2), а не спрятано", async () => {
    const r = await myc("remember", "факт");
    expect(text(r.stdout)).toContain("absorb(heuristic — chat-LLM off)");

    const withLlm = new Registry();
    withLlm.register(createRememberCommand(rememberDeps({ chatLlm: () => true })));
    const r2 = await run(["-C", dir, "remember", "факт с ключом"], {
      registry: withLlm,
      env: { MYC_ACTOR: "tester", MYC_HOME: home },
    });
    expect(text(r2.stdout)).toContain("queue     embed, absorb\n");
    expect(text(r2.stdout)).not.toContain("heuristic");
  });

  test("--anchor ПРИВЯЗЫВАЕТ, а не откладывает: узел, строка anchors, ребро touches", async () => {
    mkdirSync(join(dir, "src", "retrieval"), { recursive: true });
    writeFileSync(
      join(dir, "src", "retrieval", "fuse.ts"),
      `${Array.from({ length: 60 }, (_, i) => `const l${i} = ${i};`).join("\n")}\n`,
    );
    const { env } = await mycJson(
      "remember",
      "факт про слияние",
      "--anchor",
      "src/retrieval/fuse.ts:40-58",
    );
    const anchors = env.data["anchors"] as Array<Record<string, unknown>>;
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!["path"]).toBe("src/retrieval/fuse.ts");
    expect(anchors[0]!["state"]).toBe("fresh");
    const anchorId = anchors[0]!["anchor_id"] as string;
    expect(typeof anchorId).toBe("string");
    // Якорь свеж по построению — работа `anchor_check` на ровном месте не ставится.
    expect(env.data["queue"]).toEqual(["embed", "absorb"]);

    const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
    const node = db.query("SELECT kind, status FROM nodes WHERE id = ?1").get(anchorId) as {
      kind: string;
      status: string;
    };
    const row = db
      .query("SELECT path, span_start, span_end, state FROM anchors WHERE node_id = ?1")
      .get(anchorId) as { path: string; span_start: number; span_end: number; state: string };
    const edge = db
      .query(
        "SELECT count(*) AS n FROM edges WHERE src = ?1 AND dst = ?2 AND type = 'touches' AND deleted_at IS NULL",
      )
      .get(env.data["id"] as string, anchorId) as { n: number };
    db.close();
    expect(node).toEqual({ kind: "anchor", status: "fresh" });
    expect(row.path).toBe("src/retrieval/fuse.ts");
    expect(row.state).toBe("fresh");
    expect(edge.n).toBe(1);
  });

  test("--anchor на несуществующий файл: узел записан, причина названа вслух (И2)", async () => {
    const { env } = await mycJson("remember", "факт про пропажу", "--anchor", "src/нет.ts:1-2");
    const anchors = env.data["anchors"] as Array<Record<string, unknown>>;
    expect(anchors[0]!["anchor_id"]).toBeUndefined();
    expect(anchors[0]!["state"]).toBe("pending");
    expect(String(anchors[0]!["reason"])).toContain("no such file");
    expect(env.warn.map((w) => w.code)).toContain("anchor.unbound");
    // Человеческий вывод — отдельным вызовом: в --json строка не рендерится.
    const human = await myc("remember", "второй факт про пропажу", "--anchor", "src/нет.ts:1-2");
    expect(text(human.stdout)).toContain("@— not bound:");
    expect(text(human.stdout)).toContain("(myc anchor add)");
    expect(text(human.stdout)).not.toContain("anchor bind");
    // Узел записан: опечатка в пути не имеет права стоить текста факта.
    expect(typeof env.data["id"]).toBe("string");
  });

  test("длинный факт: заголовок обрезан, тело сохранено целиком", async () => {
    const long = `первая строка факта\n${"x".repeat(300)}`;
    const { env } = await mycJson("remember", long);
    const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
    const row = db.query("SELECT title, body FROM nodes WHERE id = ?1").get(env.data["id"] as string) as {
      title: string;
      body: string;
    };
    db.close();
    expect(row.title).toBe("первая строка факта");
    expect(row.body).toContain("x".repeat(300));
  });

  test("--layer и --acl доезжают до узла, кривой --layer это usage", async () => {
    const { env } = await mycJson("remember", "решение", "--layer", "L2", "--acl", "private");
    expect(env.data["layer"]).toBe(2);
    expect(env.data["acl"]).toBe("private");

    const bad = await mycJson("remember", "решение", "--layer", "L9");
    expect(bad.code).toBe(ExitCode.USAGE);
    expect(bad.env.error?.code).toBe("usage.invalid");
  });

  test("пустой факт — usage, а не пустой узел", async () => {
    const r = await mycJson("remember");
    expect(r.code).toBe(ExitCode.USAGE);
  });

  test("--global без личного яруса не создаёт его молча", async () => {
    const r = await mycJson("remember", "личный факт", "--global");
    expect(r.code).toBe(ExitCode.NOWS);
    expect(r.env.error?.code).toBe("ws.not_initialized");
  });
});

// ===========================================================================
// recall / search — общий движок, разный UX (D6)
// ===========================================================================

describe("myc recall", () => {
  beforeEach(async () => {
    // Общий терм «ретривал» во всех трёх фактах: FTS5 склеивает термы запроса
    // неявным AND (prepareFtsQuery -> parts.join(" ")), поэтому пересечение
    // выдачи задаётся общим словом, а не перечислением разных.
    // Факты длиннее заголовка: тогда у узла есть body, а значит и excerpt, и
    // recall печатает полную карточку — иначе свёртку по бюджету нечем проверять.
    await myc(
      "remember",
      "ретривал: RRF k=60 даёт лучший recall\nk=20 теряет четыре процентных пункта на нашем корпусе, проверено на наборе из 44 запросов двух видов.",
      "--tag",
      "retrieval",
    );
    await myc(
      "remember",
      "ретривал: отказ от Dolt\nCell-level merge полезен, но это отдельный движок, плюс сорок мегабайт бинаря и второй формат данных.",
      "--tag",
      "dolt",
    );
    await myc(
      "remember",
      "ретривал: векторный поиск внутри SQLite\nsqlite-vec, размерность 384, HNSW не нужен до пятисот тысяч узлов корпуса.",
      "--tag",
      "vector",
    );
  });

  test("находит факт и печатает состав веток в футере", async () => {
    const r = await myc("recall", "Dolt");
    const out = text(r.stdout);
    expect(out).toContain("отказ от Dolt");
    expect(out).toMatch(/1 of 1 · bm25[^·]*· [\d.]+ ms · \d+ chars of 2000/);
  });

  test("mode_used в конверте соответствует напечатанному ярлыку", async () => {
    const { env } = await mycJson("recall", "Dolt");
    const mode = env.meta["mode_used"] as {
      project: { sources: string[]; vector: string };
      personalQueried: boolean;
    };
    expect(mode.project.sources).toContain("fts");
    expect(mode.project.sources).not.toContain("vector");
    expect(env.meta["mode"]).toBe("bm25 only");
    expect(mode.personalQueried).toBe(false);
  });

  test("--mode bm25 выключает вектор явно и это видно в mode_used", async () => {
    const { env } = await mycJson("recall", "sqlite", "--mode", "bm25");
    const mode = env.meta["mode_used"] as { project: { vector: string } };
    expect(mode.project.vector).toBe("disabled");
  });

  test("фильтры --kind и --tag сужают выдачу", async () => {
    const all = await mycJson("recall", "ретривал");
    const tagged = await mycJson("recall", "ретривал", "--tag", "dolt");
    expect((tagged.env.data["rows"] as unknown[]).length).toBeLessThan(
      (all.env.data["rows"] as unknown[]).length,
    );
    const rows = tagged.env.data["rows"] as { tags: string[] }[];
    for (const row of rows) expect(row.tags).toContain("dolt");

    const wrongKind = await mycJson("recall", "Dolt", "--kind", "task");
    expect((wrongKind.env.data["rows"] as unknown[]).length).toBe(0);
  });

  test("неизвестный --kind и --mode — usage", async () => {
    expect((await mycJson("recall", "x", "--kind", "нетакого")).code).toBe(ExitCode.USAGE);
    expect((await mycJson("recall", "x", "--mode", "magic")).code).toBe(ExitCode.USAGE);
  });

  test("бюджет символов: движок режет по узлам, рендер сворачивает, всё в футере", async () => {
    const full = await mycJson("recall", "ретривал");
    expect(full.env.data["collapsed"]).toEqual([]);
    expect(full.env.data["dropped"]).toEqual([]);

    // Средний бюджет: движок (§2.7) оставляет все три узла — crux'ы влезают
    // целиком, — а рендер сворачивает крайнюю карточку: свёртка по-прежнему
    // раньше отказа, и то и другое объявлено в футере. Число поднято с 450
    // до 480 вместе с колонкой охвата репозитория (S59): строка стала на
    // пять символов шире, и на 450 крайняя карточка перестала помещаться
    // даже свёрнутой — тест начал проверять отказ вместо свёртки.
    const midOut = text((await myc("recall", "ретривал", "--budget", "480")).stdout);
    expect(midOut).toContain("(collapsed)");
    expect(midOut).toMatch(/chars of 480/);

    // Тесный бюджет: движок оставляет только узлы, влезающие ЦЕЛИКОМ,
    // остальное объявляет partial — не молча (И2).
    const tight = await myc("recall", "ретривал", "--budget", "260");
    const out = text(tight.stdout);
    expect(out).toMatch(/chars of 260/);
    expect(out).toContain("partial:");
    expect(out).toContain("over budget");

    const tightJson = await mycJson("recall", "ретривал", "--budget", "260");
    const used = tightJson.env.meta["used_chars"] as number;
    expect(used).toBeLessThanOrEqual(260);
    // Ответ движка не превышает бюджет уже на уровне data (§2.7).
    const rows = tightJson.env.data["rows"] as { excerpt: string; body?: string | null }[];
    const engineChars = rows.reduce(
      (s, r) => s + Math.max(r.body?.length ?? 0, r.excerpt.length) + 1,
      0,
    );
    expect(engineChars).toBeLessThanOrEqual(260);
    // Отброшенное объявлено, а не исчезло.
    expect(
      (tightJson.env.data["omitted"] as number) +
        (tightJson.env.data["dropped"] as string[]).length,
    ).toBeGreaterThan(0);
  });

  test("свёртка режет заголовок под остаток бюджета, а не выкидывает строку", async () => {
    // Длинный заголовок не должен стоить агенту всей строки: пока места
    // хватает на осмысленный кусок, печатается он, а не пустота.
    const long = `слияние рангов ${"очень длинный заголовок про слияние рангов ".repeat(4)}`;
    await myc("remember", long);
    const wide = await mycJson("recall", "слияние", "--budget", "5000");
    const usedWide = wide.env.meta["used_chars"] as number;
    expect((wide.env.data["rows"] as unknown[]).length).toBe(1);
    expect(wide.env.data["collapsed"]).toEqual([]);

    const tight = usedWide - 30;
    const clipped = await mycJson("recall", "слияние", "--budget", String(tight));
    expect(clipped.env.data["collapsed"]).toHaveLength(1);
    expect(clipped.env.data["dropped"]).toEqual([]);
    expect(clipped.env.meta["used_chars"] as number).toBeLessThanOrEqual(tight);
    const out = text((await myc("recall", "слияние", "--budget", String(tight))).stdout);
    const line = out.split("\n").find((l) => l.includes("(collapsed)"))!;
    expect(line).toContain("…");
    expect(line.length + 1).toBeLessThanOrEqual(tight);
  });

  test("выдержка не повторяет заголовок", async () => {
    await myc(
      "remember",
      "ретривал: заголовок факта\nтело факта, которое обязано попасть в выдержку целиком и без повтора заголовка",
    );
    const out = text((await myc("recall", "ретривал", "-n", "5")).stdout);
    const body = out.split("\n").find((l) => l.startsWith("     тело факта"));
    expect(body).toBeDefined();
  });

  test("бюджет предсказуем: тот же запрос даёт тот же вывод", async () => {
    const a = text((await myc("recall", "ретривал", "--budget", "300")).stdout);
    const b = text((await myc("recall", "ретривал", "--budget", "300")).stdout);
    expect(a.replace(/[\d.]+ ms/, "")).toBe(b.replace(/[\d.]+ ms/, ""));
  });

  test("бюджет считается по факту напечатанного", async () => {
    const r = await myc("recall", "ретривал", "--budget", "400");
    const out = text(r.stdout);
    const m = /(\d+) chars of 400/.exec(out);
    expect(m).not.toBeNull();
    const declared = Number(m![1]);
    // Всё, кроме футера и WARN-строк, — это то, что бюджет считает.
    const lines = out.split("\n");
    const footerAt = lines.findIndex((l) => l.includes("chars of 400"));
    const body = lines.slice(0, footerAt).map((l) => l.length + 1).reduce((a, b) => a + b, 0);
    expect(body).toBe(declared);
  });

  test("-n ограничивает выдачу", async () => {
    const { env } = await mycJson("recall", "ретривал", "-n", "1");
    expect((env.data["rows"] as unknown[]).length).toBe(1);
  });

  test("--why печатает решение по каждой ветке", async () => {
    const r = await myc("recall", "Dolt", "--why");
    const out = text(r.stdout);
    expect(out).toContain("project   vector=");
    expect(out).toContain("tiers     ");
  });
});

describe("myc search", () => {
  beforeEach(async () => {
    await myc("remember", "ретривал: RRF k=60 даёт лучший recall на корпусе", "--tag", "retrieval");
    await myc("remember", "ретривал: векторный поиск внутри SQLite, sqlite-vec, dim 384", "--tag", "vector");
  });

  test("таблица с полями по умолчанию и футер с ветками", async () => {
    const r = await myc("search", "RRF");
    const out = text(r.stdout);
    expect(out).toContain("ID");
    expect(out).toContain("ACL");
    expect(out).toMatch(/1 of 1 · bm25[^·]*· [\d.]+ ms/);
  });

  test("--fields выбирает колонки, неизвестное поле — usage", async () => {
    const r = await myc("search", "RRF", "--fields", "id,tier,author");
    const out = text(r.stdout);
    expect(out).toContain("TIER");
    expect(out).toContain("AUTHOR");
    expect(out).not.toContain("ACL");
    expect((await mycJson("search", "RRF", "--fields", "нетакого")).code).toBe(ExitCode.USAGE);
  });

  test("--full печатает тело без повтора заголовка, теги и якоря", async () => {
    await myc("remember", "факт с якорем про слияние fuse", "--anchor", "src/fuse.ts:1-9", "--tag", "anchored");
    await myc(
      "remember",
      "заголовок факта про якоря\nтело факта, которое печатается под заголовком ровно один раз",
    );
    const r = await myc("search", "слияние fuse", "--full");
    const out = text(r.stdout);
    expect(out).toContain("tags anchored");
    expect(out).toContain("src/fuse.ts:1-9");

    const r2 = text((await myc("search", "якоря", "--full")).stdout);
    const titleLines = r2.split("\n").filter((l) => l.includes("заголовок факта про якоря"));
    expect(titleLines).toHaveLength(1);
    expect(r2).toContain("  тело факта, которое печатается под заголовком ровно один раз");
  });

  test("--sort меняет порядок показа, а не состав выдачи", async () => {
    const byScore = await mycJson("search", "ретривал");
    const byUpdated = await mycJson("search", "ретривал", "--sort", "updated");
    const ids = (e: Envelope): string[] => (e.data["rows"] as { id: string }[]).map((r) => r.id);
    expect(new Set(ids(byScore.env))).toEqual(new Set(ids(byUpdated.env)));
    expect(byUpdated.env.meta["sort"]).toBe("updated");
  });

  test("--offset листает", async () => {
    const first = await mycJson("search", "ретривал", "--limit", "1");
    const second = await mycJson("search", "ретривал", "--limit", "1", "--offset", "1");
    const idOf = (e: Envelope): string => (e.data["rows"] as { id: string }[])[0]?.id ?? "";
    expect(idOf(first.env)).not.toBe(idOf(second.env));
    expect(second.env.meta["offset"]).toBe(1);
  });

  test("--author фильтрует по тому, кто записал", async () => {
    const mine = await mycJson("search", "RRF", "--author", "tester");
    expect((mine.env.data["rows"] as unknown[]).length).toBe(1);
    const alien = await mycJson("search", "RRF", "--author", "кто-то-другой");
    expect((alien.env.data["rows"] as unknown[]).length).toBe(0);
  });

  test("recall и search — один движок: одинаковый состав выдачи", async () => {
    // Ровно то, что требует D6: разный UX, но не разная семантика.
    const recall = await mycJson("recall", "ретривал", "-n", "10");
    const search = await mycJson("search", "ретривал", "--limit", "10");
    const ids = (e: Envelope): string[] => (e.data["rows"] as { id: string }[]).map((r) => r.id);
    expect(ids(recall.env)).toEqual(ids(search.env));
    expect(recall.env.meta["mode"]).toBe(search.env.meta["mode"]);
  });
});

// ===========================================================================
// Федерация двух ярусов (S41)
// ===========================================================================

describe("два яруса", () => {
  test("recall и search помечают источник факта из личного яруса", async () => {
    await myc("remember", "проектный факт про RRF k=60", "--tag", "proj");
    await myc("init", "--global");
    await myc("remember", "личный факт про RRF и мои предпочтения", "--global", "--tag", "prefs");

    const { env } = await mycJson("recall", "RRF");
    const rows = env.data["rows"] as { id: string; tier: string }[];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.tier).sort()).toEqual(["personal", "project"]);
    const personal = rows.find((r) => r.tier === "personal")!;
    expect(personal.id.startsWith("me-")).toBe(true);

    const mode = env.meta["mode_used"] as { personalQueried: boolean; personal?: unknown };
    expect(mode.personalQueried).toBe(true);
    expect(mode.personal).toBeDefined();

    const human = text((await myc("recall", "RRF")).stdout);
    expect(human).toContain("·me");
    expect(human).toContain("2 tiers");

    const table = text((await myc("search", "RRF", "--fields", "id,tier,title")).stdout);
    expect(table).toContain("personal");
    expect(table).toContain("project");
  });

  test("без личного яруса второй базы не открывают вовсе", async () => {
    await myc("remember", "только проектный факт про RRF");
    const { env } = await mycJson("recall", "RRF");
    const mode = env.meta["mode_used"] as { personalQueried: boolean; why: string };
    expect(mode.personalQueried).toBe(false);
    expect(mode.why).toContain("not open");
  });

  test("дедупликация не показывает один и тот же факт дважды", async () => {
    const fact = "одинаковый факт про RRF в обоих ярусах";
    await myc("remember", fact);
    await myc("init", "--global");
    await myc("remember", fact, "--global");
    const { env } = await mycJson("recall", "RRF");
    expect((env.data["rows"] as unknown[]).length).toBe(1);
    expect(env.data["deduped"]).toBe(1);
  });
});

// ===========================================================================
// И2: деградация громкая
// ===========================================================================

describe("И2 — деградация видна", () => {
  beforeEach(async () => {
    await myc("remember", "факт про перефразировку без якорных термов");
  });

  test("выключенная векторная ветка объявлена в WARN и в meta.degraded", async () => {
    // Запрос без якорных термов и с одним попаданием — триггер вектора
    // срабатывает, эмбеддера нет: обязаны сказать об этом дважды.
    const { code, env } = await mycJson("recall", "перефразировка");
    expect(code).toBe(ExitCode.OK);
    expect(env.meta.degraded.length).toBeGreaterThan(0);
    expect(env.warn.map((w) => w.code)).toContain("degraded.embeddings");
    const mode = env.meta["mode_used"] as { project: { vector: string } };
    expect(mode.project.vector).toBe("unavailable");
    expect(env.meta["mode"]).not.toContain("vec");
  });

  test("человеческий вывод печатает WARN-строку", async () => {
    const r = await myc("recall", "перефразировка");
    expect(text(r.stdout)).toContain("WARN degraded.");
  });

  test("--strict превращает деградацию в exit 6", async () => {
    const r = await myc("--strict", "recall", "перефразировка");
    expect(r.code).toBe(ExitCode.DEGRADED);
  });

  test("причина отказа эмбеддера конкретна, а не «что-то пошло не так»", async () => {
    const { env } = await mycJson("recall", "перефразировка");
    const w = env.warn.find((x) => x.code === "degraded.embeddings");
    expect(w?.msg).toBe("в тесте эмбеддер отключён");
  });

  test("ярлык режима не обещает веток, которых не было", async () => {
    const { env } = await mycJson("search", "перефразировка");
    const mode = env.meta["mode_used"] as { project: { sources: string[] } };
    const label = env.meta["mode"] as string;
    for (const s of ["vec", "bm25", "graph"]) {
      const present = { vec: "vector", bm25: "fts", graph: "graph" }[s]!;
      expect(label.includes(s)).toBe(mode.project.sources.includes(present));
    }
  });
});

// ===========================================================================
// Мелкие чистые функции
// ===========================================================================

describe("разбор параметров", () => {
  test("parseKinds", () => {
    expect(parseKinds(undefined)).toEqual({ ok: true, kinds: [] });
    expect(parseKinds("memory, decision")).toEqual({ ok: true, kinds: ["memory", "decision"] });
    expect(parseKinds("memory,нетакого")).toEqual({ ok: false, bad: "нетакого" });
  });

  test("parseLayerRange", () => {
    expect(parseLayerRange(undefined)).toEqual({ ok: true });
    expect(parseLayerRange("L2")).toEqual({ ok: true, min: 2, max: 2 });
    expect(parseLayerRange("L1..L3")).toEqual({ ok: true, min: 1, max: 3 });
    expect(parseLayerRange("L4")).toEqual({ ok: false });
  });

  test("modeLabelOf называет ровно те ветки, что дошли до выдачи", () => {
    const mk = (sources: string[]) => {
      const mode = { sources, vector: "skipped", why: "", trigger: {}, roundTrips: 1, vectorRoundTrips: 0, degraded: [], graphSeeds: "lexical" };
      // R3: ветки собираются по СПИСКУ источников, а не по паре именованных
      // полей; `project` остался производным видом для поверхностей S41.
      return {
        sources: [{ id: "project", kind: "project", weight: 1, queried: true, mode, hits: 1 }],
        queried: 1,
        skipped: 0,
        cap: 8,
        deadlineMs: 18,
        took_ms: 0,
        project: mode,
        personalQueried: false,
        why: "",
      } as never;
    };
    expect(modeLabelOf(mk(["fts"]), 60)).toBe("bm25 only");
    expect(modeLabelOf(mk(["fts", "graph"]), 60)).toBe("bm25+graph");
    expect(modeLabelOf(mk(["fts", "vector"]), 60)).toBe("vec+bm25 rrf(k=60)");
    expect(modeLabelOf(mk([]), 60)).toBe("empty");
  });

  test("embedTimeoutFromEnv: по умолчанию 0 — вектор в одноразовом CLI не звался", () => {
    expect(embedTimeoutFromEnv({})).toBe(0);
    expect(embedTimeoutFromEnv({ MYC_EMBED_TIMEOUT_MS: "500" })).toBe(500);
    expect(embedTimeoutFromEnv({ MYC_EMBED_TIMEOUT_MS: "мусор" })).toBe(0);
  });

  test("resolveQueryEmbedder при timeout 0 не трогает @myc/embed и говорит почему", async () => {
    const r = await resolveQueryEmbedder(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("--embed-timeout 0");
  });

  // Сверки литерала модели с реестром здесь больше нет: сверять нечего —
  // идентификатор и путь каталога приходят из @myc/embed/model-id, копии
  // в retrieve.ts не осталось (S46). Проверяем только само поведение
  // привратника: нет манифеста — нет вектора, есть — есть.
  test("modelLikelyPresent — дешёвый stat по манифесту модели по умолчанию", async () => {
    const { DEFAULT_MODEL_ID } = await import("@myc/embed/model-id");
    const empty = join(dir, "models-empty");
    mkdirSync(empty, { recursive: true });
    expect(modelLikelyPresent({ MYC_MODELS_DIR: empty })).toBe(false);
    // Каталог модели по контракту fetch.ts: <base>/<DEFAULT_MODEL_ID>/manifest.json
    const staged = join(dir, "models", DEFAULT_MODEL_ID);
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "manifest.json"), "{}");
    expect(modelLikelyPresent({ MYC_MODELS_DIR: join(dir, "models") })).toBe(true);
  });
});
