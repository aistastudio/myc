/**
 * `myc doctor` через публичный run() — тот же путь, что видит пользователь.
 *
 * Проверяется не «печатается ли отчёт», а три вещи, ради которых команда и
 * существует:
 *   1. на здоровом воркспейсе выход 0, и ни один пункт не назван «ok» зря;
 *   2. испорченное руками состояние ловится и даёт НЕНУЛЕВОЙ выход;
 *   3. «не проверено» и «не срабатывал» — разные ответы (И2), и разница
 *      зависит не от настроения, а от того, отмечает ли хук себя.
 *
 * Отдельный тест держит границу «doctor не чинит»: сверка замыкания гоняет
 * настоящую applyRebuild в транзакции, и единственное доказательство отката —
 * что база после запуска побайтно та же.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { generateId } from "@myc/core";
import { GraphStore, migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { openDriver, type CliDriver } from "./store.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import type { DoctorData } from "./doctor.ts";
import { generatedFiles, wireHash } from "./wire.ts";
import { HOOK_SPECS } from "../hooks/templates.ts";

let dir: string;
let dbPath: string;
let registry: Registry;

/** Полный реестр: разделу --hooks нужно знать состав ЭТОЙ сборки. */
function makeRegistry(): Registry {
  const r = new Registry();
  registerAll(r);
  return r;
}

function doctor(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, "doctor", ...args], { registry });
}

function text(res: RunResult): string {
  const out = typeof res.stdout === "string" ? res.stdout : [...(res.stdout ?? [])].join("");
  return out + (res.stderr ?? "");
}

interface Envelope {
  readonly ok: boolean;
  readonly data?: DoctorData;
  readonly error?: { code: string; msg: string };
  readonly warn?: Array<{ code: string; msg: string }>;
}

/**
 * Строка отчёта про событие хука — из конверта успеха или из текста отказа.
 * Отчёт печатается одним и тем же рендером в обоих исходах, и читать его
 * одинаково — это и есть проверяемое свойство.
 */
function hookLine(env: Envelope, event: string): string {
  const fromData = env.data?.hooks?.hooks.find((h) => h.event === event);
  if (fromData !== undefined) return `${fromData.verdict}|${fromData.detail}`;
  const line = (env.error?.msg ?? "").split("\n").find((l) => l.includes(`${event}:`));
  return line ?? "";
}

async function envelope(...args: string[]): Promise<Envelope> {
  const res = await doctor(...args, "--json");
  return JSON.parse(String(res.stdout)) as Envelope;
}

/** Журнал `myc wire` с перечисленными событиями хоста Claude. */
/**
 * `ageMs` — сколько назад был позван `myc wire`. По умолчанию давно: почти
 * всякий тест здесь проверяет установившееся состояние, а не первую минуту
 * после настройки, и молодость журнала там только мешала бы.
 */
function writeWireJournal(events: readonly string[], ageMs = 7 * 24 * 60 * 60 * 1000): void {
  writeFileSync(
    join(dir, ".myc", "wire.json"),
    JSON.stringify({
      v: 1,
      written_at: Date.now() - ageMs,
      agents: ["claude"],
      entries: [{ path: ".claude/settings.json", kind: "merge", nodes: events.map((e) => `hooks.${e}`), hash: "x" }],
    }),
  );
}

type CounterSpec = readonly [key: string, count: number, status?: string];

function writeCounters(...entries: readonly CounterSpec[]): void {
  const hooks: Record<string, unknown> = {};
  for (const [key, count, status] of entries) {
    hooks[key] = { count, last_at: 1_700_000_000_000, last_ms: 12, last_status: status ?? "ok" };
  }
  writeFileSync(join(dir, ".myc", "hooks.json"), JSON.stringify({ v: 1, hooks }));
}

/**
 * Зелёная база: все три самоотмечающихся события сработали. Нужна с тех пор,
 * как себя отмечает не только pre-compact: молчащий счётчик session-start —
 * теперь тоже расхождение, и тест, которому нужен выход 0, обязан сказать это
 * вслух, а не молча опираться на прежнее «про это ничего не известно».
 */
const ALL_FIRED: readonly CounterSpec[] = [
  ["claude:session-start", 4],
  ["claude:pre-compact", 3],
  ["claude:post-edit", 9],
];

/**
 * Настоящий CLI-драйвер, а не самодельный: GraphStore при конструировании
 * читает оплог и метаданные, и подделка контракта драйвера ломается на первом
 * же таком чтении.
 */
function open(): { driver: CliDriver; store: GraphStore } {
  const driver = openDriver(dbPath);
  const store = new GraphStore(driver, { newId: generateId, actor: "t", siteId: "s" });
  return { driver, store };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-doctor-"));
  mkdirSync(join(dir, ".myc"));
  dbPath = join(dir, ".myc", "myc.db");
  const raw = new Database(dbPath, { create: true });
  raw.exec("PRAGMA journal_mode = WAL");
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = makeRegistry();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("myc doctor: здоровый воркспейс", () => {
  test("три раздела и выход 0", async () => {
    const res = await doctor();
    expect(res.code).toBe(ExitCode.OK);
    const out = text(res);
    expect(out).toMatch(/^schema$/m);
    expect(out).toMatch(/^counters$/m);
    expect(out).toMatch(/^hooks$/m);
  });

  test("в конверте — все три раздела и вердикт по каждому пункту", async () => {
    const env = await envelope();
    expect(env.ok).toBe(true);
    expect(env.data?.sections).toEqual(["schema", "recount", "hooks"]);
    expect(env.data?.ok).toBe(true);
    const names = (env.data?.recount?.checks ?? []).map((c) => c.name);
    expect(names).toEqual(["open_blockers", "anc_blockers", "parent_closure"]);
  });

  test("флаг сужает вывод до одного раздела", async () => {
    const env = await envelope("--recount");
    expect(env.data?.sections).toEqual(["recount"]);
    expect(env.data?.schema).toBeUndefined();
  });

  /**
   * Пункт, который НЕ проверяли, не имеет права называться «ok». Векторный и
   * swarm-наборы на свежей базе не накатаны, и это «н/д», а не «в порядке».
   */
  test("непроверенное не называется «ок»", async () => {
    const env = await envelope("--schema");
    const vec = env.data?.schema?.checks.find((c) => c.name === "vectors");
    expect(vec?.verdict).toBe("n/a");
    expect(vec?.detail).toContain("on demand");
  });
});

describe("myc doctor --recount: испорченное состояние", () => {
  test("расхождение open_blockers ловится и даёт ненулевой выход", async () => {
    const { driver, store } = open();
    const a = store.createNode({ kind: "task", scope: "s", title: "жертва" });
    driver.database.run("UPDATE nodes SET open_blockers = 7 WHERE id = ?1", [a.id]);
    driver.close();

    const res = await doctor("--recount");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain(`${a.id}: stored 7, recount 0`);

    const env = await envelope("--recount");
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("precond.drift");
    // Находка обязана быть и в warn[]: конверт отказа несёт только code/msg,
    // и без диагностик агент не узнал бы, ЧТО именно разошлось.
    expect((env.warn ?? []).map((w) => w.code)).toContain("doctor.drift");
  });

  test("расхождение parent_closure ловится, и doctor НЕ чинит базу", async () => {
    const { driver, store } = open();
    const epic = store.createNode({ kind: "task", scope: "s", title: "эпик" });
    const child = store.createNode({ kind: "task", scope: "s", title: "ребёнок" });
    const grand = store.createNode({ kind: "task", scope: "s", title: "внук" });
    store.addEdge(child.id, "parent", epic.id);
    store.addEdge(grand.id, "parent", child.id);
    driver.database.run("DELETE FROM parent_closure WHERE depth = 2");
    const rowsBefore = driver.database
      .query("SELECT count(*) AS n FROM parent_closure")
      .get() as { n: number };
    driver.close();

    const res = await doctor("--recount");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain("parent_closure");
    expect(text(res)).toContain(`${epic.id}→${grand.id}@2`);

    // Сверка гоняет настоящую applyRebuild — единственное доказательство
    // отката в том, что строк осталось столько же, сколько было.
    const after = new Database(dbPath);
    const rowsAfter = after.query("SELECT count(*) AS n FROM parent_closure").get() as { n: number };
    after.close();
    expect(rowsAfter.n).toBe(rowsBefore.n);
  });

  test("здоровое замыкание расхождением не объявляется", async () => {
    const { driver, store } = open();
    const epic = store.createNode({ kind: "task", scope: "s", title: "эпик" });
    const child = store.createNode({ kind: "task", scope: "s", title: "ребёнок" });
    store.addEdge(child.id, "parent", epic.id);
    driver.close();
    const env = await envelope("--recount");
    expect(env.ok).toBe(true);
  });
});

describe("myc doctor --schema", () => {
  /**
   * Ради этого случая команда и написана. Обычный путь открытия базы, которая
   * новее бинаря, отказывает с `precond.schema` и советует `myc doctor
   * --schema`; если бы doctor шёл тем же путём, совет вёл бы в ту же ошибку.
   */
  test("работает на базе НОВЕЕ бинаря — там, куда ведёт подсказка", async () => {
    const db = new Database(dbPath);
    db.run(
      "INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (?1,?2,?3,?4)",
      [999, "из-будущего", "deadbeef", 0],
    );
    db.close();

    const env = await envelope("--schema");
    expect(env.error?.code).toBe("precond.drift"); // а НЕ precond.schema от миграции
    const version = env.data?.schema?.checks.find((c) => c.name === "version");
    expect(env.error?.msg).toContain("database is newer than the binary");
    expect(version ?? env.error?.msg).toBeDefined();
  });

  test("лишний объект в базе назван поимённо", async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE future_thing (id TEXT PRIMARY KEY)");
    db.close();
    const res = await doctor("--schema");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain("extra in the database: table:future_thing");
  });

  test("пропавший объект тоже назван", async () => {
    const db = new Database(dbPath);
    db.exec("DROP TABLE IF EXISTS digest_cache");
    db.close();
    const res = await doctor("--schema");
    expect(res.code).toBe(ExitCode.PRECOND);
    expect(text(res)).toContain("missing from the database: table:digest_cache");
  });
});

describe("myc doctor --hooks: «не знаю» и «не срабатывал» — разные ответы", () => {
  test("без журнала wire про хуки честно сказано «не знаю»", async () => {
    const env = await envelope("--hooks");
    const start = env.data?.hooks?.hooks.find((h) => h.event === "session-start");
    expect(start?.verdict).toBe("unknown");
    expect(start?.detail).toContain("wire.json");
    expect(env.ok).toBe(true); // «не знаю» — не расхождение
  });

  test("сработавший хук назван числом и временем", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    writeCounters(...ALL_FIRED);
    const env = await envelope("--hooks");
    const pre = env.data?.hooks?.hooks.find((h) => h.event === "pre-compact");
    expect(pre?.verdict).toBe("ok");
    expect(pre?.count).toBe(3);
    expect(pre?.detail).toContain("fired 3 times");
  });

  /**
   * ГЛАВНАЯ ПРОВЕРКА РАЗДЕЛА, и она изменилась вместе с задачей. Раньше про
   * session-start сказать было нечего: `myc prime` зовут и хуком, и руками,
   * отличить нечем (memory-q9k2zxfx2mcm). Теперь вызывающий объявляет себя, и
   * молчащий счётчик про поставленный хук — УТВЕРЖДЕНИЕ «не срабатывал», как у
   * pre-compact. Мутация, снимающая session-start из SELF_REPORTING_HOOKS,
   * роняет этот тест.
   */
  test("поставленный, но ни разу не сработавший session-start — расхождение", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    const res = await doctor("--hooks");
    expect(res.code).toBe(ExitCode.PRECOND);
    const env = await envelope("--hooks");
    expect(hookLine(env, "pre-compact")).toContain("never fired");
    expect(hookLine(env, "session-start")).toContain("never fired");
    expect(hookLine(env, "session-start")).not.toContain("does not report itself");
  });

  /**
   * Обратная сторона: сработавший session-start — знание, а не догадка, и в
   * отчёте он назван числом. Это и есть ответ на первый вопрос всякого, кто
   * поставил myc: «а он вообще работает?».
   */
  test("сработавший session-start назван числом, агентом и временем", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    writeCounters(...ALL_FIRED);
    const env = await envelope("--hooks");
    const start = env.data?.hooks?.hooks.find((h) => h.event === "session-start");
    expect(start?.verdict).toBe("ok");
    expect(start?.count).toBe(4);
    expect(start?.detail).toContain("fired 4 times");
    expect(start?.detail).toContain("agents: claude");
  });

  /**
   * Старт сессии, которому хост не назвал сессию, — не здоровье. Это ровно та
   * поломка, из-за которой сессионная память была скрыта в живом потоке
   * (memory-h12hjebzr0he): установленный helper не передавал `--session`.
   */
  test("session-start со статусом no-session — расхождение, названное словами", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    writeCounters(
      ["claude:session-start", 5, "no-session"],
      ["claude:pre-compact", 3],
      ["claude:post-edit", 9],
    );
    expect((await doctor("--hooks")).code).toBe(ExitCode.PRECOND);
    const line = hookLine(await envelope("--hooks"), "session-start");
    expect(line).toContain("no-session");
    expect(line).toContain("the host did not name the session");
    expect(line).toContain("myc wire");
  });

  /**
   * Первая минута после `myc wire` — не расхождение. `pre-compact` ждёт
   * сжатия контекста, оно случается через часы; объявив это расхождением,
   * doctor встречал бы человека ненулевым кодом сразу после настройки.
   * Проверяются ОБЕ стороны порога: молчание молодого хука — «не знаю»,
   * молчание старого — расхождение. Проверка одной стороны пропустила бы
   * мутацию, снимающую порог целиком.
   */
  test("свежепоставленный хук молчит законно, застаревший — уже нет", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"], 60_000);
    expect((await doctor("--hooks")).code).toBe(ExitCode.OK);
    const fresh = await envelope("--hooks");
    expect(hookLine(fresh, "pre-compact")).toContain("unknown: installed");
    expect(hookLine(fresh, "pre-compact")).toContain("had no occasion to happen");

    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"], 2 * 24 * 60 * 60 * 1000);
    expect((await doctor("--hooks")).code).toBe(ExitCode.PRECOND);
    expect(hookLine(await envelope("--hooks"), "pre-compact")).toContain("never fired");
  });

  /**
   * «Срабатывал» и «работал» — разные вещи, и разница видна только в статусе.
   * На живом проекте pre-compact отработал 11 раз со статусом `empty`: эпизод
   * не создан ни разу, память сжатие не пережила, а doctor писал `ok` —
   * подтверждая ровно то обещание, которое не выполнялось.
   */
  test("сработавший, но пустой хук — расхождение, а не здоровье", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    writeCounters(["opencode:session-start", 2], ["opencode:pre-compact", 11, "empty"], ["opencode:post-edit", 5]);
    expect((await doctor("--hooks")).code).toBe(ExitCode.PRECOND);
    const line = hookLine(await envelope("--hooks"), "pre-compact");
    expect(line).toContain("nothing to save");
    expect(line).toContain("empty");
    expect(line).toContain("did no work last time");

    // И обратная сторона: успешный хук по-прежнему здоровье, иначе «починка»
    // свелась бы к тому, что pre-compact не может быть зелёным никогда.
    writeCounters(["opencode:session-start", 2], ["opencode:pre-compact", 11, "ok"], ["opencode:post-edit", 5]);
    expect(hookLine(await envelope("--hooks"), "pre-compact")).toContain("fired 11 times");
    expect(
      (await envelope("--hooks")).data?.hooks?.hooks.find((h) => h.event === "pre-compact")?.verdict,
    ).toBe("ok");
  });

  /**
   * Харнессы делятся на два рода: у Claude Code хуки — узлы чужого JSON, у
   * opencode и Kimi весь обработчик — наш файл, и узлов у него нет по
   * устройству. Читая только узлы, doctor объявлял «не поставлен» про
   * поставленные хуки — ложная тревога в проекте, где стоит один opencode.
   */
  test("плагин без узлов — тоже установка, а не отсутствие хуков", async () => {
    writeFileSync(
      join(dir, ".myc", "wire.json"),
      JSON.stringify({
        v: 1,
        written_at: Date.now() - 7 * 24 * 60 * 60 * 1000,
        agents: ["opencode"],
        entries: [
          { path: ".opencode/plugin/myc.ts", kind: "new", nodes: [], hash: "x" },
          { path: "opencode.json", kind: "merge", nodes: ["mcp.myc"], hash: "y" },
        ],
      }),
    );
    // Счётчик нужен, чтобы pre-compact не покраснел по ДРУГОЙ причине
    // («поставлен, но не срабатывал») и не увёл выдачу в конверт ошибки.
    writeCounters(["opencode:session-start", 2], ["opencode:pre-compact", 3], ["opencode:post-edit", 5]);
    for (const event of ["session-start", "pre-compact", "post-edit"]) {
      const line = hookLine(await envelope("--hooks"), event);
      expect(line).not.toContain("not installed");
      expect(line).not.toContain("drift");
    }
    // Обратная сторона: журнал БЕЗ нашего файла по-прежнему значит «не
    // поставлено», иначе проверка перестала бы что-либо утверждать.
    writeFileSync(
      join(dir, ".myc", "wire.json"),
      JSON.stringify({
        v: 1,
        written_at: Date.now() - 7 * 24 * 60 * 60 * 1000,
        agents: ["opencode"],
        entries: [{ path: "opencode.json", kind: "merge", nodes: ["mcp.myc"], hash: "y" }],
      }),
    );
    // Проверяем на событии БЕЗ счётчика: сработавший хук — знание более
    // твёрдое, чем журнал, и ветка «срабатывал N раз» перекрыла бы вопрос
    // об установке вовсе. Поэтому счётчик post-edit убираем.
    writeCounters(["opencode:session-start", 2], ["opencode:pre-compact", 3]);
    expect(hookLine(await envelope("--hooks"), "post-edit")).toContain("not installed");
  });

  test("не поставленное событие названо не поставленным, а не «не срабатывало»", async () => {
    writeWireJournal(["SessionStart", "PreCompact"]);
    // Счётчика post-edit нет намеренно: сработавший хук перекрыл бы вопрос об
    // установке (ветка «срабатывал N раз» стоит раньше — знание твёрже).
    writeCounters(["claude:session-start", 4], ["claude:pre-compact", 1]);
    const res = await doctor("--hooks");
    expect(res.code).toBe(ExitCode.PRECOND);
    const env = await envelope("--hooks");
    expect(hookLine(env, "post-edit")).toContain("not installed");
    expect(hookLine(env, "post-edit")).toContain("not in the `myc wire` journal");
  });

  /**
   * Хук на команду, которой в сборке нет, `myc wire` не ставит намеренно.
   * Это свойство сборки, а не поломка воркспейса: объяви его расхождением —
   * и ни один воркспейс никогда не даст выход 0.
   */
  test("событие без команды в сборке — «н/д», и оно не портит код выхода", async () => {
    writeWireJournal(["SessionStart", "PreCompact", "PostToolUse"]);
    writeCounters(...ALL_FIRED, ["claude:pre-compact", 1]);
    const env = await envelope("--hooks");
    const stop = env.data?.hooks?.hooks.find((h) => h.event === "stop");
    expect(stop?.verdict).toBe("n/a");
    expect(stop?.detail).toContain("this build has no");
    expect(env.ok).toBe(true);
  });
});

describe("myc doctor --hooks: устаревший или подменённый файл хука", () => {
  const HELPER = ".claude/helpers/myc-hooks.mjs";

  /** Содержимое, которое дала бы ЭТА сборка, — тем же кодом, что пишет wire. */
  function currentHelper(output: "json" | "text" = "json"): string {
    const events = HOOK_SPECS.filter((sp) => registry.hasTop(sp.command)).map((sp) => sp.event);
    const text = generatedFiles(dir, events, output).get(HELPER);
    expect(text).toBeDefined();
    return text!;
  }

  /**
   * Журнал с записью про НАШ файл целиком (узлов нет — по этому признаку его
   * узнают и `unwire`, и сверка) плюс зелёные счётчики, чтобы расхождение,
   * если оно появится, было ровно тем, что проверяет тест.
   */
  function journalFor(hash: string, output?: "json" | "text"): void {
    writeFileSync(
      join(dir, ".myc", "wire.json"),
      JSON.stringify({
        v: 1,
        written_at: Date.now() - 7 * 24 * 60 * 60 * 1000,
        agents: ["claude"],
        ...(output !== undefined ? { hook_output: output } : {}),
        entries: [
          { path: HELPER, kind: "new", nodes: [], hash },
          {
            path: ".claude/settings.json",
            kind: "merge",
            nodes: ["hooks.SessionStart", "hooks.PreCompact", "hooks.PostToolUse"],
            hash: "x",
          },
        ],
      }),
    );
    writeCounters(...ALL_FIRED);
  }

  function putHelper(text: string): void {
    mkdirSync(join(dir, ".claude", "helpers"), { recursive: true });
    writeFileSync(join(dir, HELPER), text);
  }

  function generatedLine(env: Envelope, path: string): string {
    const g = env.data?.hooks?.generated.find((x) => x.path === path);
    if (g !== undefined) return `${g.verdict}|${g.detail}`;
    return (env.error?.msg ?? "").split("\n").find((l) => l.includes(path)) ?? "";
  }

  test("актуальный файл — здоровье, и оно названо словом", async () => {
    const text = currentHelper();
    putHelper(text);
    journalFor(wireHash(text));
    expect((await doctor("--hooks")).code).toBe(ExitCode.OK);
    expect(generatedLine(await envelope("--hooks"), HELPER)).toContain("up to date");
  });

  /**
   * РАДИ ЭТОГО СЛУЧАЯ СВЕРКА И НАПИСАНА. Файл на диске ровно тот, что записал
   * `myc wire`, — человек ничего не портил, — но шаблон в сборке с тех пор
   * изменился. Именно так установленный helper перестал передавать `--session`,
   * и вся сессионная память была скрыта, пока хук исправно тикал
   * (memory-h12hjebzr0he). Мутация, снимающая сверку хеша, роняет тест.
   */
  test("устаревший файл назван поимённо, и сказано, что он устарел", async () => {
    const stale = currentHelper().replace('"--session"', "");
    expect(stale).not.toBe(currentHelper()); // мутация подмены сработала
    putHelper(stale);
    journalFor(wireHash(stale));
    expect((await doctor("--hooks")).code).toBe(ExitCode.PRECOND);
    const line = generatedLine(await envelope("--hooks"), HELPER);
    expect(line).toContain("stale");
    expect(line).toContain("myc wire");
    expect(line).toContain(wireHash(stale)); // назван хеш журнала
    expect(line).toContain(wireHash(currentHelper())); // и хеш нынешней сборки
  });

  /**
   * Другая болезнь с тем же исходом: файл не тот, что мы писали, И не тот, что
   * пишем сейчас. Смешать её с «устарел» значило бы советовать `myc wire`
   * человеку, который правил файл сам, не сказав, что правка уйдёт в .bak.
   */
  test("подменённый файл отличён от устаревшего", async () => {
    putHelper("// чужая правка\n");
    journalFor(wireHash(currentHelper()));
    expect((await doctor("--hooks")).code).toBe(ExitCode.PRECOND);
    const line = generatedLine(await envelope("--hooks"), HELPER);
    expect(line).toContain("changed after we wrote it");
    expect(line).toContain(".myc.bak");
    expect(line).not.toContain("stale");
  });

  test("пропавший файл — расхождение, а не тишина", async () => {
    journalFor(wireHash(currentHelper()));
    expect((await doctor("--hooks")).code).toBe(ExitCode.PRECOND);
    expect(generatedLine(await envelope("--hooks"), HELPER)).toContain("gone:");
  });

  /**
   * `--hook-output text` — выбор человека, а не признак устаревания. Без
   * записи этого выбора в журнал каждая установка с `text` объявлялась бы
   * устаревшей, то есть сверка кричала бы на исправную настройку.
   */
  test("выбор --hook-output не считается устареванием", async () => {
    const text = currentHelper("text");
    expect(text).not.toBe(currentHelper("json"));
    putHelper(text);
    journalFor(wireHash(text), "text");
    expect((await doctor("--hooks")).code).toBe(ExitCode.OK);
    expect(generatedLine(await envelope("--hooks"), HELPER)).toContain("up to date");
  });

  test("без журнала сверка отвечает «не знаю», а не «ок»", async () => {
    putHelper(currentHelper());
    writeCounters(...ALL_FIRED);
    const env = await envelope("--hooks");
    const g = env.data?.hooks?.generated ?? [];
    expect(g.length).toBe(1);
    expect(g[0]?.verdict).toBe("unknown");
    expect(g[0]?.detail).toContain("wire.json");
    expect(env.ok).toBe(true); // «не знаю» — не расхождение
  });
});

describe("myc doctor: воркспейса нет", () => {
  test("отказ называет, где искали, и не притворяется здоровьем", async () => {
    const empty = mkdtempSync(join(tmpdir(), "myc-doctor-empty-"));
    process.env.MYC_HOME = empty;
    try {
      const res = await run(["-C", empty, "doctor", "--json"], { registry });
      const env = JSON.parse(String(res.stdout)) as Envelope;
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("ws.not_initialized");
      expect(res.code).toBe(ExitCode.NOWS);
    } finally {
      delete process.env.MYC_HOME;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("отчёт читается одинаково на нуле и на ненуле", () => {
  /**
   * Успех печатает отчёт из data, отказ — из msg. Рендер обязан быть один:
   * два разошлись бы, и «что именно сломано» на ненулевом коде выхода
   * выглядело бы иначе, чем на нулевом.
   */
  test("текст отказа содержит те же строки разделов, что и успешный вывод", async () => {
    const ok = text(await doctor("--recount"));
    const { driver, store } = open();
    const a = store.createNode({ kind: "task", scope: "s", title: "жертва" });
    driver.database.run("UPDATE nodes SET anc_blockers = 3 WHERE id = ?1", [a.id]);
    driver.close();
    const bad = text(await doctor("--recount"));

    for (const line of ["counters", "open_blockers", "anc_blockers", "parent_closure"]) {
      expect(ok).toContain(line);
      expect(bad).toContain(line);
    }
    expect(readFileSync(dbPath).length).toBeGreaterThan(0);
  });
});
