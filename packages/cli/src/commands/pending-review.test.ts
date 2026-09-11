/**
 * Кандидаты хука сжатия (§6.2, memory-7j8zgjnd0bjz) — сквозь все поверхности
 * CLI, где знание уходит агенту: recall, search, prime, строка статуса. И
 * одна поверхность, где кандидат ПОКАЗЫВАЕТСЯ, но помеченным: `show <id>` —
 * явный запрос по id.
 *
 * Кандидата пишет НАСТОЯЩИЙ хук (`myc absorb-session`), а не рука теста:
 * фильтр и писатель обязаны сходиться на одной форме attrs, и расхождение
 * (писатель переименовал ключ — фильтр молча перестал работать) должно ронять
 * этот тест, а не жить до первой жалобы.
 *
 * recall и search склеивают строки с одинаковым заголовком (dedup по kind и
 * title), поэтому «кандидат скрыт» проверяется на базе, где рядом нет
 * одноимённой заметки: иначе снятый фильтр маскировался бы дедупом.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId } from "@myc/core";
import { GraphStore, migrate, migrations, openSqlite } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAbsorbSessionCommand } from "../hooks/absorb-session.ts";
import { createPrimeCommand } from "./prime.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { createSearchCommand } from "./search.ts";
import { createShowCommand } from "./show.ts";
import { createStatuslineCommand, type StatuslineData } from "./statusline.ts";
import { realStoreDeps } from "./store.ts";

const SESSION = "S-review-1";
const DECISION = "Решили: константу сглаживания RRF держим равной шестидесяти";
/**
 * Обычная заметка с ТЕМ ЖЕ заголовком. Вторая строка нужна не для красоты:
 * однострочный `remember` даёт тот же content_hash, что кандидат (заголовок —
 * строка, тела нет), и попадает в ветку точного дубликата — то есть в самого
 * кандидата (см. отдельный блок ниже). С телом это другой узел с тем же
 * заголовком, и запрос совпадает с ним так же дословно.
 */
const NOTE = `${DECISION}\nзаписано осознанно, после сверки с бенчем`;

let dir: string;
let home: string;
let registry: Registry;

function retrieveDeps(): RetrieveDeps {
  return {
    openStore: realStoreDeps.openStore,
    ...realRetrieveExtras,
    resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-review-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "models", "multilingual-e5-small-q8"), { recursive: true });
  writeFileSync(join(dir, "models", "multilingual-e5-small-q8", "manifest.json"), "{}");
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  process.env.MYC_HOME = home;
  process.env.MYC_ACTOR = "tester";
  registry = new Registry();
  for (const c of [
    createAbsorbSessionCommand(),
    createRememberCommand({ ...realRememberDeps, chatLlm: () => false }),
    createRecallCommand(retrieveDeps()),
    createSearchCommand(retrieveDeps()),
    createPrimeCommand(),
    createShowCommand(),
    createStatuslineCommand({
      selfExit: false,
      readStdin: () =>
        new TextEncoder().encode(
          `${JSON.stringify({ session_id: SESSION, cwd: dir, workspace: { current_dir: dir, project_dir: dir } })}\n`,
        ),
      cacheDir: join(dir, "sl-cache"),
      env: { MYC_MODELS_DIR: join(dir, "models"), CLAUDE_CONFIG_DIR: join(dir, "claude") },
    }),
  ]) {
    registry.register(c);
  }
});

afterEach(() => {
  delete process.env.MYC_HOME;
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

async function data<T = Record<string, unknown>>(...args: string[]): Promise<T> {
  const r = await myc(...args, "--json");
  const env = JSON.parse(text(r.stdout)) as { ok: boolean; data: T; error?: unknown };
  if (!env.ok) throw new Error(`myc ${args.join(" ")}: ${JSON.stringify(env.error)}`);
  return env.data;
}

/** Стенограмма с одним решением в речи модели — ровно то, что ловит хук. */
async function compact(decision = DECISION): Promise<string> {
  const transcript = join(dir, `t-${generateId()}.jsonl`);
  const rows = [
    { type: "user", message: { role: "user", content: "доделаем слияние" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: decision }] } },
  ];
  writeFileSync(transcript, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const out = await data<{ candidates: number }>(
    "absorb-session", "--transcript", transcript, "--reason", "manual", "--session", SESSION,
  );
  expect(out.candidates).toBe(1);
  const conn = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  const row = conn
    .query<{ id: string }, [string]>(
      "SELECT id FROM nodes WHERE json_extract(attrs,'$.state')='pending_review' AND title = ?1",
    )
    .get(decision);
  conn.close();
  expect(row).not.toBeNull();
  return row!.id;
}

function store(): { store: GraphStore; close: () => void } {
  const driver = openSqlite(join(dir, ".myc", "myc.db"));
  return {
    store: new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "tester" }),
    close: () => driver.close(),
  };
}

/**
 * Подтверждение. Команды для него нет (дистиллятор — заглушка, у `myc update`
 * нет правки attrs), поэтому тест делает ровно то, что сделает любой, кто
 * подтверждает: пишет `attrs.state` через GraphStore, то есть в оплог.
 */
function confirm(id: string): void {
  const s = store();
  try {
    s.store.updateNode(id, { attrs: { state: "confirmed" } });
  } finally {
    s.close();
  }
}

type Rows = { rows: { id: string }[] };
const idsOf = (d: Rows): string[] => d.rows.map((r) => r.id);

describe("recall и search: кандидат не отдаётся", () => {
  // Мутации «снять фильтр» в любом из запросов hybridLexicalPass роняют оба.
  test("recall по дословному тексту кандидата — пусто", async () => {
    const cand = await compact();
    const d = await data<Rows>("recall", DECISION);
    expect(idsOf(d)).not.toContain(cand);
    expect(d.rows).toEqual([]);
  });

  test("search по дословному тексту кандидата — пусто", async () => {
    const cand = await compact();
    const d = await data<Rows>("search", DECISION);
    expect(idsOf(d)).not.toContain(cand);
    expect(d.rows).toEqual([]);
  });

  test("обычная заметка с тем же текстом — отдаётся", async () => {
    const cand = await compact();
    const note = (await data<{ id: string }>("remember", NOTE, "--layer", "L2", "--reach", "project")).id;
    expect(note).not.toBe(cand);
    expect(idsOf(await data<Rows>("recall", DECISION))).toEqual([note]);
    expect(idsOf(await data<Rows>("search", DECISION))).toEqual([note]);
  });

  test("после подтверждения кандидат отдаётся", async () => {
    const cand = await compact();
    confirm(cand);
    // Первым — сам кандидат; следом может приехать его эпизод обходом графа
    // (ребро derived_from): до подтверждения кандидат не был сидом обхода.
    expect(idsOf(await data<Rows>("recall", DECISION))[0]).toBe(cand);
    expect(idsOf(await data<Rows>("search", DECISION))[0]).toBe(cand);
  });
});

interface PrimeView {
  decisions: { id: string }[];
  core: { id: string }[];
  pending_review: number;
}

describe("prime: кандидат не попадает в DECISIONS, скрытое названо числом", () => {
  test("своя сессия: кандидат скрыт, заметка с тем же текстом видна, в подвале 1", async () => {
    const cand = await compact();
    const note = (await data<{ id: string }>("remember", NOTE, "--layer", "L2", "--reach", "project")).id;
    const d = await data<PrimeView>("prime", "--session", SESSION);
    expect(d.decisions.map((x) => x.id)).toContain(note);
    expect(d.decisions.map((x) => x.id)).not.toContain(cand);
    expect(d.pending_review).toBe(1);
    const out = text((await myc("prime", "--session", SESSION)).stdout);
    expect(out).toContain("1 pending review hidden");
  });

  // С фильтром репозитория prime идёт ДРУГИМ запросом (prime_digest_scan_repo),
  // и фильтр кандидатов обязан стоять и в нём: у кандидата охвата
  // репозитория нет, а «без охвата» видно под любым --repo. Мутация «снять
  // фильтр из prime_digest_scan_repo» роняет этот тест.
  test("--repo: тот же фильтр во втором запросе дайджеста", async () => {
    const cand = await compact();
    const note = (await data<{ id: string }>("remember", NOTE, "--layer", "L2", "--reach", "project")).id;
    const d = await data<PrimeView & { repo: string }>("prime", "--session", SESSION, "--repo", "collector");
    expect(d.repo).toBe("collector");
    expect(d.decisions.map((x) => x.id)).toContain(note);
    expect(d.decisions.map((x) => x.id)).not.toContain(cand);
  });

  // Дайджест кешируется по версии базы (digest_cache). Запись, посчитанная
  // ДО фильтра, лежит под ключом v3 и несёт кандидата в DECISIONS; без смены
  // версии ключа попадание в кеш отдало бы её после обновления, пока в базу
  // никто не пишет. Мутация «оставить v3 в digestVariant» роняет этот тест.
  test("дайджест, посчитанный до фильтра, после обновления не отдаётся", async () => {
    const cand = await compact();
    const first = await data<PrimeView & { repo: string }>("prime", "--session", SESSION);
    const conn = new Database(join(dir, ".myc", "myc.db"));
    try {
      const scope = conn.query<{ scope: string }, [string]>("SELECT scope FROM nodes WHERE id = ?1").get(cand)!.scope;
      const seq = conn
        .query<{ s: number }, [string]>("SELECT coalesce(max(seq), 0) AS s FROM oplog WHERE scope = ?1")
        .get(scope)!.s;
      const stale = {
        core: [],
        decisions: [{ id: cand, title: DECISION, updated_at: 1, tier: "project", reach: "session", reach_by: "recorded" }],
        reach: { hidden: 0, unknown: 0 },
        repo: { hidden: 0, unknown: 0 },
      };
      conn
        .query(
          `INSERT INTO digest_cache (scope, profile, variant, seq, payload) VALUES (?1, 'prime', ?2, ?3, ?4)
           ON CONFLICT(scope, profile, variant) DO UPDATE SET seq = excluded.seq, payload = excluded.payload`,
        )
        .run(scope, `v3:${SESSION}:${first.repo}`, seq, JSON.stringify(stale));
    } finally {
      conn.close();
    }
    const d = await data<PrimeView>("prime", "--session", SESSION);
    expect(d.decisions.map((x) => x.id)).not.toContain(cand);
    expect(d.pending_review).toBe(1);
  });

  test("после подтверждения — в DECISIONS, счётчик ноль", async () => {
    const cand = await compact();
    confirm(cand);
    const d = await data<PrimeView>("prime", "--session", SESSION);
    expect(d.decisions.map((x) => x.id)).toContain(cand);
    expect(d.pending_review).toBe(0);
    expect(text((await myc("prime", "--session", SESSION)).stdout)).not.toContain("pending review");
  });

  test("отклонённый кандидат (retracted) разбор прошёл: скрыт, но не «ждёт»", async () => {
    const cand = await compact();
    const s = store();
    try {
      s.store.updateNode(cand, { status: "retracted" });
    } finally {
      s.close();
    }
    const d = await data<PrimeView>("prime", "--session", SESSION);
    expect(d.decisions.map((x) => x.id)).not.toContain(cand);
    expect(d.pending_review).toBe(0);
  });

  // ОКНО СКАНА prime — 60 строк в порядке (layer DESC, salience DESC). Сто
  // кандидатов L3 с высокой salience стоят в нём раньше любой L2-заметки:
  // фильтр после LIMIT отдал бы окно им, и DECISIONS осталась бы пустой.
  // Мутация «снять фильтр из prime_digest_scan» роняет этот тест (и CORE
  // заполняется кандидатами).
  test("100 кандидатов впереди окна не вытесняют обычную заметку", async () => {
    const note = (await data<{ id: string }>("remember", "одна настоящая заметка слоя L2", "--layer", "L2", "--reach", "project")).id;
    const s = store();
    try {
      const scope = s.store.getNode(note)!.scope;
      for (let i = 0; i < 100; i++) {
        s.store.createNode({
          kind: "note",
          layer: 3,
          acl: "private",
          salience: 1,
          scope,
          title: `кандидат ${i}: решили что-то важное`,
          actor: "tester",
          attrs: { state: "pending_review", extracted_by: "precompact", episode_id: "ep-w", reach: "session", session_id: SESSION },
        });
      }
    } finally {
      s.close();
    }
    const d = await data<PrimeView>("prime", "--session", SESSION);
    expect(d.decisions.map((x) => x.id)).toEqual([note]);
    expect(d.core).toEqual([]);
    expect(d.pending_review).toBe(100);
  });
});

describe("show: по id кандидат показан, но помечен", () => {
  test("человеческий вывод и JSON называют кандидата кандидатом", async () => {
    const cand = await compact();
    const out = text((await myc("show", cand)).stdout);
    expect(out).toContain("review    unconfirmed compaction candidate (state pending_review)");
    expect((await data<{ review?: string }>("show", cand)).review).toBe("pending_review");
  });

  test("обычная заметка пометки не несёт; подтверждённый кандидат — тоже", async () => {
    const cand = await compact();
    const note = (await data<{ id: string }>("remember", "обычная заметка без состояния", "--reach", "project")).id;
    expect(text((await myc("show", note)).stdout)).not.toContain("review ");
    expect((await data<{ review?: string }>("show", note)).review).toBeUndefined();
    confirm(cand);
    expect((await data<{ review?: string }>("show", cand)).review).toBeUndefined();
  });
});

describe("remember дословного текста кандидата — подтверждение (§6.2)", () => {
  // Однострочный remember даёт тот же content_hash, что кандидат, и попадает
  // в ветку точного дубликата. Без подтверждения там явно записанный факт
  // ушёл бы в скрытого кандидата и пропал из recall и prime. Мутация «убрать
  // подтверждение из exact_dup в remember.ts» роняет этот тест.
  test("id кандидата, ответ называет подтверждение, кто и когда — в узле", async () => {
    const cand = await compact();
    const d = await data<{ id: string; duplicate_of?: string; review_confirmed?: boolean }>("remember", DECISION);
    expect(d.id).toBe(cand);
    expect(d.duplicate_of).toBe(cand);
    expect(d.review_confirmed).toBe(true);

    const s = store();
    let attrs: Record<string, unknown>;
    try {
      attrs = s.store.getNode(cand)!.attrs as Record<string, unknown>;
    } finally {
      s.close();
    }
    expect(attrs["state"]).toBe("confirmed");
    expect(attrs["confirmed_by"]).toBe("tester");
    expect(typeof attrs["confirmed_at"]).toBe("number");

    expect(idsOf(await data<Rows>("recall", DECISION))[0]).toBe(cand);
    const p = await data<PrimeView>("prime", "--session", SESSION);
    expect(p.decisions.map((x) => x.id)).toContain(cand);
    expect(p.pending_review).toBe(0);
  });

  test("человеческий ответ говорит, что подтверждён кандидат; повтор — обычный дубль", async () => {
    await compact();
    const first = text((await myc("remember", DECISION)).stdout);
    expect(first).toContain("exact repeat of an unconfirmed compaction candidate — confirmed now");
    const again = await data<{ review_confirmed?: boolean; seen_count?: number }>("remember", DECISION);
    expect(again.review_confirmed).toBeUndefined();
    expect(again.seen_count).toBe(3);
  });
});

describe("строка статуса: кандидат — не узел знания", () => {
  // Мутация «снять фильтр из sl_memory» роняет этот тест (2 вместо 1).
  test("счёт notes не включает кандидата своей сессии", async () => {
    await compact();
    await data("remember", "обычная заметка своей сессии", "--reach", "project");
    const r = await run(["-C", dir, "statusline", "--json"], { registry });
    const d = (JSON.parse(text(r.stdout)) as { data: StatuslineData }).data;
    expect(d.memory).toBe(1);
  });
});
