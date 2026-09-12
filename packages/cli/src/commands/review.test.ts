/**
 * Разбор кандидатов хука сжатия (`myc review`, memory-79mq6fccg0jm), вектор и
 * классификация подтверждённого (memory-4c24exck23cw) и скрываемые статусы в
 * выдаче (memory-0p3d8n1efwtv) — сквозь настоящий run() и настоящий хук.
 *
 * Кандидата пишет НАСТОЯЩИЙ `myc absorb-session`: писатель, фильтр выдачи и
 * команда разбора обязаны сходиться на одной форме attrs.
 *
 * recall и search склеивают строки с одинаковым заголовком (dedup по kind и
 * title), поэтому «скрыто» проверяется там, где рядом нет одноимённой живой
 * заметки, либо у живой другое тело: иначе снятый фильтр маскировался бы
 * дедупом.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId } from "@myc/core";
import { HIDDEN_STATUSES } from "@myc/retrieval/review";
import { HIDDEN_STATUSES as WEB_HIDDEN_STATUSES } from "@myc/web";
import { GraphStore, migrate, migrations, openSqlite } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAbsorbSessionCommand } from "../hooks/absorb-session.ts";
import { createPrimeCommand } from "./prime.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { createReviewCommand, realReviewDeps, type ReviewActionData, type ReviewListData } from "./review.ts";
import { createSearchCommand } from "./search.ts";
import { createShowCommand } from "./show.ts";
import { createStatuslineCommand, type StatuslineData } from "./statusline.ts";
import { realStoreDeps } from "./store.ts";
import { createUpdateCommand } from "./tasks.ts";

const SESSION = "S-review-own";
const OTHER = "S-review-other";
const DECISION = "Решили: пул лексики гибрида держим равным сотне строк";
const FOREIGN = "Выбрали хранить оплог одним файлом на воркспейс, потому что так проще git";

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
  dir = mkdtempSync(join(tmpdir(), "myc-review-cmd-"));
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
    createUpdateCommand(),
    createReviewCommand({ ...realReviewDeps, chatLlm: () => false }),
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

interface Envelope<T> {
  ok: boolean;
  data: T;
  warn?: { code: string; msg: string }[];
  error?: { code: string; msg: string; exit: number; hint?: string };
}

async function envelope<T = Record<string, unknown>>(...args: string[]): Promise<{ code: number; env: Envelope<T> }> {
  const r = await myc(...args, "--json");
  return { code: r.code, env: JSON.parse(text(r.stdout)) as Envelope<T> };
}

async function data<T = Record<string, unknown>>(...args: string[]): Promise<T> {
  const { env } = await envelope<T>(...args);
  if (!env.ok) throw new Error(`myc ${args.join(" ")}: ${JSON.stringify(env.error)}`);
  return env.data;
}

/** Стенограмма с одним решением в речи модели — ровно то, что ловит хук. */
async function compact(decision: string, session: string): Promise<string> {
  const transcript = join(dir, `t-${generateId()}.jsonl`);
  const rows = [
    { type: "user", message: { role: "user", content: "доделаем выдачу" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: decision }] } },
  ];
  writeFileSync(transcript, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const out = await data<{ candidates: number }>(
    "absorb-session", "--transcript", transcript, "--reason", "manual", "--session", session,
  );
  expect(out.candidates).toBe(1);
  const conn = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return conn
      .query<{ id: string }, [string]>("SELECT id FROM nodes WHERE json_extract(attrs,'$.state')='pending_review' AND title = ?1")
      .get(decision)!.id;
  } finally {
    conn.close();
  }
}

function withStore<T>(fn: (s: GraphStore, d: Database) => T): T {
  const driver = openSqlite(join(dir, ".myc", "myc.db"));
  try {
    return fn(new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "tester" }), driver.database);
  } finally {
    driver.close();
  }
}

function row(id: string): { status: string; salience: number; attrs: Record<string, unknown> } {
  return withStore((_s, d) => {
    const r = d.query<{ status: string; salience: number; attrs: string }, [string]>(
      "SELECT status, salience, attrs FROM nodes WHERE id = ?1",
    ).get(id)!;
    return { status: r.status, salience: r.salience, attrs: JSON.parse(r.attrs) as Record<string, unknown> };
  });
}

/** Работы очереди узла: вид → payload.reason. */
function jobsOf(id: string): Record<string, string> {
  return withStore((_s, d) =>
    Object.fromEntries(
      d.query<{ kind: string; payload: string }, [string]>("SELECT kind, payload FROM jobs WHERE entity_id = ?1")
        .all(id)
        .map((j) => [j.kind, String((JSON.parse(j.payload) as Record<string, unknown>)["reason"])]),
    ),
  );
}

type Rows = { rows: { id: string }[] };
const idsOf = (d: Rows): string[] => d.rows.map((r) => r.id);

interface PrimeView {
  decisions: { id: string }[];
  core: { id: string }[];
  pending_review: number;
}

// ---------------------------------------------------------------------------
// Список
// ---------------------------------------------------------------------------

describe("myc review — список", () => {
  // Решение по охвату (шапка review.ts): видно ВСЁ, своя сессия первой и своим
  // числом, чужая — с пометкой. «Своя» = то, что считает подвал prime этой
  // сессии: два числа обязаны совпасть.
  // Своя создаётся ПЕРВОЙ: список идёт по индексу «свежие первыми», и чужая,
  // будучи новее, стояла бы выше — порядок доказывает сортировку «своя
  // первой», а не свежесть. Мутация «вернуть items как есть» роняет тест.
  test("своя сессия первой, чужая помечена; число «здесь» = pending_review prime", async () => {
    const own = await compact(DECISION, SESSION);
    await Bun.sleep(5); // updated_at в мс: чужая строго новее
    const foreign = await compact(FOREIGN, OTHER);
    const d = await data<ReviewListData>("review", "--session", SESSION);
    expect(d.total).toBe(2);
    expect(d.here).toBe(1);
    expect(d.other).toBe(1);
    expect(d.items.map((i) => i.id)).toEqual([own, foreign]);
    expect(d.items[0]!.here).toBe(true);
    expect(d.items[1]!.here).toBe(false);
    expect(d.items[1]!.session).toBe(OTHER);
    const p = await data<PrimeView>("prime", "--session", SESSION);
    expect(p.pending_review).toBe(d.here);

    const out = text((await myc("review", "--session", SESSION)).stdout);
    expect(out).toContain("PENDING REVIEW 2 · 1 in this session's prime · 1 from other sessions");
    expect(out).toMatch(new RegExp(`${own}\\s+L2\\s+\\S+\\s+this session`));
    expect(out).toMatch(new RegExp(`${foreign}\\s+L2\\s+\\S+\\s+session ${OTHER.slice(0, 8)}`));
    expect(out).toContain("myc review confirm <id>");
  });

  test("--this-session: только своя сессия, числа по всей базе", async () => {
    await compact(FOREIGN, OTHER);
    const own = await compact(DECISION, SESSION);
    const d = await data<ReviewListData>("review", "--session", SESSION, "--this-session");
    expect(d.items.map((i) => i.id)).toEqual([own]);
    expect(d.total).toBe(2);
    expect(d.listed).toBe(1);
  });

  test("пусто — сказано словом", async () => {
    const out = text((await myc("review")).stdout);
    expect(out).toContain("nothing awaits review");
    expect((await data<ReviewListData>("review")).total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Подтверждение
// ---------------------------------------------------------------------------

describe("myc review confirm — кандидат становится знанием, как новая заметка", () => {
  // Мутации: «confirmCandidate без enqueueAll» и «без confirmAttrs» роняют
  // этот тест (jobs пусты / recall пуст).
  test("state confirmed, кто и когда, salience новой заметки; embed и absorb в очереди; в выдаче", async () => {
    const cand = await compact(DECISION, SESSION);
    expect(jobsOf(cand)).toEqual({}); // хук кандидату работ не ставит — иначе тест ничего не доказывал бы
    const d = await data<ReviewActionData>("review", "confirm", cand);
    expect(d.changed).toBe(1);
    expect(d.items[0]!.outcome).toBe("confirmed");
    expect(d.items[0]!.queue).toEqual(["embed", "absorb"]);

    const r = row(cand);
    expect(r.attrs["state"]).toBe("confirmed");
    expect(r.attrs["confirmed_by"]).toBe("tester");
    expect(typeof r.attrs["confirmed_at"]).toBe("number");
    expect(r.salience).toBe(1);
    expect(jobsOf(cand)).toEqual({ embed: "review_confirmed", absorb: "review_confirmed" });

    expect(idsOf(await data<Rows>("recall", DECISION))[0]).toBe(cand);
    expect(idsOf(await data<Rows>("search", DECISION))[0]).toBe(cand);
    const p = await data<PrimeView>("prime", "--session", SESSION);
    expect(p.decisions.map((x) => x.id)).toContain(cand);
    expect(p.pending_review).toBe(0);
    expect((await data<ReviewListData>("review")).total).toBe(0);

    const human = text((await myc("review", "confirm", cand)).stdout);
    expect(human).toContain(`${cand} already confirmed by tester`);
  });

  test("повтор — не ошибка и ничего не меняет", async () => {
    const cand = await compact(DECISION, SESSION);
    await data("review", "confirm", cand);
    const again = await data<ReviewActionData>("review", "confirm", cand);
    expect(again.changed).toBe(0);
    expect(again.items[0]!.outcome).toBe("already_confirmed");
  });

  test("пачка с не-кандидатом отказывает целиком: никто не подтверждён", async () => {
    const cand = await compact(DECISION, SESSION);
    const plain = (await data<{ id: string }>("remember", "обычная заметка, не кандидат", "--reach", "project")).id;
    const { code, env } = await envelope("review", "confirm", `${cand},${plain}`);
    expect(code).toBe(5);
    expect(env.error?.code).toBe("precond.not_candidate");
    expect(row(cand).attrs["state"]).toBe("pending_review");
    expect(jobsOf(cand)).toEqual({});
  });

  test("без id — usage", async () => {
    expect((await myc("review", "confirm")).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Отклонение
// ---------------------------------------------------------------------------

describe("myc review reject — отклонённый не в выдаче и не в списке", () => {
  test("retracted, причина и кто — в узле; recall, search, prime, список его не видят", async () => {
    const cand = await compact(DECISION, SESSION);
    const d = await data<ReviewActionData>("review", "reject", cand, "--reason", "это не решение, а пересказ задачи");
    expect(d.items[0]!.outcome).toBe("rejected");
    const r = row(cand);
    expect(r.status).toBe("retracted");
    expect(r.attrs["reject_reason"]).toBe("это не решение, а пересказ задачи");
    expect(r.attrs["rejected_by"]).toBe("tester");
    expect(r.attrs["state"]).toBe("pending_review"); // см. rejectAttrs: снятие отклонения вернёт в разбор

    expect(idsOf(await data<Rows>("recall", DECISION))).not.toContain(cand);
    expect(idsOf(await data<Rows>("search", DECISION))).not.toContain(cand);
    const p = await data<PrimeView>("prime", "--session", SESSION);
    expect(p.decisions.map((x) => x.id)).not.toContain(cand);
    expect(p.pending_review).toBe(0);
    expect((await data<ReviewListData>("review")).total).toBe(0);

    const shown = text((await myc("show", cand)).stdout);
    expect(shown).toContain("review    rejected compaction candidate (status retracted): это не решение");
  });

  // Выдачу отклонённого кандидата держит ТОЛЬКО терм статуса: состояние у
  // него по-прежнему pending_review, но это проверяется и выше. Здесь —
  // что снятое отклонение возвращает в РАЗБОР, а не в выдачу.
  test("снятие отклонения возвращает кандидата в список, а не в recall", async () => {
    const cand = await compact(DECISION, SESSION);
    await data("review", "reject", cand, "--reason", "поспешили");
    await data("update", cand, "--status", "active");
    expect((await data<ReviewListData>("review")).items.map((i) => i.id)).toEqual([cand]);
    expect(idsOf(await data<Rows>("recall", DECISION))).not.toContain(cand);
  });

  test("без --reason — usage; отклонённого не подтвердить; подтверждённого не отклонить", async () => {
    const cand = await compact(DECISION, SESSION);
    expect((await myc("review", "reject", cand)).code).toBe(2);
    await data("review", "reject", cand, "--reason", "шум");
    const confirmRejected = await envelope("review", "confirm", cand);
    expect(confirmRejected.code).toBe(5);
    expect(confirmRejected.env.error?.code).toBe("precond.rejected");

    const other = await compact(FOREIGN, OTHER);
    await data("review", "confirm", other);
    const rejectConfirmed = await envelope("review", "reject", other, "--reason", "передумали");
    expect(rejectConfirmed.code).toBe(5);
    expect(rejectConfirmed.env.error?.code).toBe("precond.confirmed");
  });
});

// ---------------------------------------------------------------------------
// remember дословного текста — та же функция подтверждения
// ---------------------------------------------------------------------------

describe("remember дословного текста кандидата — embed и absorb, как у новой заметки (memory-4c24exck23cw)", () => {
  // Мутация «confirmCandidate без enqueueAll» роняет этот тест: до задачи
  // ветка дубликата очередь не ставила вовсе (queue: []).
  test("подтверждение повтором ставит обе работы и называет их", async () => {
    const cand = await compact(DECISION, SESSION);
    const d = await data<{ id: string; review_confirmed?: boolean; queue: string[] }>("remember", DECISION);
    expect(d.id).toBe(cand);
    expect(d.review_confirmed).toBe(true);
    expect(d.queue).toEqual(["embed", "absorb"]);
    expect(jobsOf(cand)).toEqual({ embed: "review_confirmed", absorb: "review_confirmed" });
    expect(row(cand).salience).toBe(1);
    const human = text((await myc("remember", DECISION)).stdout);
    expect(human).not.toContain("queue"); // второй повтор — обычный дубль, работ не ставит
  });

  test("--no-absorb: только embed", async () => {
    const cand = await compact(DECISION, SESSION);
    await data("remember", DECISION, "--no-absorb");
    expect(jobsOf(cand)).toEqual({ embed: "review_confirmed" });
  });
});

// ---------------------------------------------------------------------------
// Отозванные заметки в выдаче CLI (memory-0p3d8n1efwtv)
// ---------------------------------------------------------------------------

describe("отозванная заметка — не в recall, search, prime и строке статуса", () => {
  const FACT = "Бюджет холодного старта держим в двадцати пяти миллисекундах";

  test("recall и search: отозванная скрыта, живая с тем же заголовком видна", async () => {
    const gone = (await data<{ id: string }>("remember", FACT, "--reach", "project")).id;
    await data("update", gone, "--status", "retracted");
    expect(idsOf(await data<Rows>("recall", FACT))).toEqual([]);
    expect(idsOf(await data<Rows>("search", FACT))).toEqual([]);
    const live = (await data<{ id: string }>("remember", `${FACT}\nпересчитано после замера`, "--reach", "project")).id;
    expect(idsOf(await data<Rows>("recall", FACT))).toEqual([live]);
    expect(idsOf(await data<Rows>("search", FACT))).toEqual([live]);
  });

  // ОКНО СКАНА prime — 60 строк по (layer DESC, salience DESC). Сто отозванных
  // L3 с высокой salience стоят в нём раньше любой L2: терм после LIMIT отдал
  // бы окно им, DECISIONS осталась бы пустой, CORE — полной отозванного.
  // Мутация «снять терм статуса из prime_digest_scan» роняет этот тест.
  test("100 отозванных L3 в голове окна не вытесняют живую L2 и не попадают в CORE", async () => {
    const live = (await data<{ id: string }>("remember", "одна живая заметка слоя L2", "--layer", "L2", "--reach", "project")).id;
    withStore((s) => {
      const scope = s.getNode(live)!.scope;
      for (let i = 0; i < 100; i++) {
        s.createNode({
          kind: "note",
          layer: 3,
          salience: 1,
          status: "retracted",
          scope,
          title: `отозванное константное знание ${i}`,
          actor: "tester",
          attrs: { reach: "project" },
        });
      }
    });
    const d = await data<PrimeView>("prime", "--session", SESSION);
    expect(d.decisions.map((x) => x.id)).toEqual([live]);
    expect(d.core).toEqual([]);
  });

  // С фильтром репозитория prime идёт ДРУГИМ запросом. Мутация «снять терм
  // статуса из prime_digest_scan_repo» роняет этот тест.
  test("--repo: отозванная L3 не в CORE и во втором запросе дайджеста", async () => {
    const gone = (await data<{ id: string }>("remember", "отозванная константа слоя L3", "--layer", "L3", "--reach", "project")).id;
    await data("update", gone, "--status", "retracted");
    const d = await data<PrimeView & { repo: string }>("prime", "--session", SESSION, "--repo", "collector");
    expect(d.repo).toBe("collector");
    expect(d.core.map((x) => x.id)).not.toContain(gone);
    const plain = await data<PrimeView>("prime", "--session", SESSION);
    expect(plain.core.map((x) => x.id)).not.toContain(gone);
  });

  // Дайджест, посчитанный ДО терма, лежит под ключом v4 и несёт отозванную в
  // CORE; без смены версии попадание в кеш отдало бы его, пока в базу никто
  // не пишет. Мутация «оставить v4 в digestVariant» роняет этот тест.
  test("дайджест, посчитанный до терма статуса, после обновления не отдаётся", async () => {
    const gone = (await data<{ id: string }>("remember", "отозванная константа слоя L3", "--layer", "L3", "--reach", "project")).id;
    await data("update", gone, "--status", "retracted");
    const conn = new Database(join(dir, ".myc", "myc.db"));
    try {
      const scope = conn.query<{ scope: string }, [string]>("SELECT scope FROM nodes WHERE id = ?1").get(gone)!.scope;
      const seq = conn
        .query<{ s: number }, [string]>("SELECT coalesce(max(seq), 0) AS s FROM oplog WHERE scope = ?1")
        .get(scope)!.s;
      const stale = {
        core: [{ id: gone, title: "отозванная константа", updated_at: 1, tier: "project", reach: "project", reach_by: "recorded" }],
        decisions: [],
        reach: { hidden: 0, unknown: 0 },
        repo: { hidden: 0, unknown: 0 },
        pending: 0,
      };
      conn
        .query(
          `INSERT INTO digest_cache (scope, profile, variant, seq, payload) VALUES (?1, 'prime', ?2, ?3, ?4)
           ON CONFLICT(scope, profile, variant) DO UPDATE SET seq = excluded.seq, payload = excluded.payload`,
        )
        .run(scope, `v4:${SESSION}:`, seq, JSON.stringify(stale));
    } finally {
      conn.close();
    }
    const d = await data<PrimeView>("prime", "--session", SESSION);
    expect(d.core.map((x) => x.id)).not.toContain(gone);
  });

  test("строка статуса: отозванная не считается (тот же список, что у выдачи)", async () => {
    await data("remember", "первая живая заметка", "--reach", "project");
    const gone = (await data<{ id: string }>("remember", "вторая, её отзовут", "--reach", "project")).id;
    await data("update", gone, "--status", "retracted");
    const r = await run(["-C", dir, "statusline", "--json"], { registry });
    expect((JSON.parse(text(r.stdout)) as { data: StatuslineData }).data.memory).toBe(1);
  });

  // Отозванное выдача больше не отдаёт — точный повтор без WARN «прошёл» бы
  // молча, а факта в recall нет. Воскрешать повтором нельзя (отзыв — решение).
  test("remember точного текста отозванной: WARN со статусом и путём назад, узел не воскрешён", async () => {
    const gone = (await data<{ id: string }>("remember", FACT, "--reach", "project")).id;
    await data("update", gone, "--status", "retracted");
    const { env } = await envelope<{ id: string; hidden_status?: string }>("remember", FACT, "--reach", "project");
    expect(env.data.id).toBe(gone);
    expect(env.data.hidden_status).toBe("retracted");
    expect(env.warn?.map((w) => w.code)).toContain("degraded.hidden");
    expect(env.warn?.find((w) => w.code === "degraded.hidden")?.msg).toContain(`myc update ${gone} --status active`);
    expect(row(gone).status).toBe("retracted");
  });
});

// ---------------------------------------------------------------------------
// Подвал prime
// ---------------------------------------------------------------------------

describe("prime: у числа скрытых кандидатов — команда разбора, в бюджете", () => {
  test("подвал называет `myc review`; вывод укладывается в --budget", async () => {
    await compact(DECISION, SESSION);
    await data("remember", "обычная заметка L2", "--layer", "L2", "--reach", "project");
    const out = text((await myc("prime", "--session", SESSION)).stdout);
    expect(out).toContain("1 pending review hidden — myc review");
    for (const budget of [400, 800]) {
      const b = text((await myc("prime", "--session", SESSION, "--budget", String(budget))).stdout);
      expect(b).toContain("pending review hidden — myc review");
      expect(b.length).toBeLessThanOrEqual(budget);
    }
  });
});

// ---------------------------------------------------------------------------
// Один список скрываемых статусов на все поверхности
// ---------------------------------------------------------------------------

describe("HIDDEN_STATUSES: копия веба = оригинал @myc/retrieval", () => {
  // У веба зависимости от retrieval нет, и kb.ts держит копию списка (подвал
  // «кандидаты на подтверждение»). Сверяет её пакет, зависящий от обоих.
  // Мутация «убрать cancelled из копии веба» роняет этот тест.
  test("поэлементно", () => {
    expect([...WEB_HIDDEN_STATUSES]).toEqual([...HIDDEN_STATUSES]);
  });
});
