/**
 * Охват репозитория (S59) от начала до конца: экосистема из корня и двух
 * репозиториев, настоящий SQLite во временном каталоге, команды через
 * публичный run() — как их зовёт main.ts.
 *
 * Приёмка задачи проверяется здесь дословно:
 *   — узел, заведённый ВНУТРИ репозитория, получает его охват без флагов;
 *   — `ready` и `recall` фильтруют по репозиторию;
 *   — задачи и заметки всей экосистемы видны отовсюду;
 *   — невыведенный охват ВИДЕН, а не подменяется общим (И2).
 *
 * И отдельным блоком — независимость трёх осей: ярус (S41), охват сессии
 * (S58) и охват репозитория (S59) не выводятся друг из друга.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { REPO_KEY } from "@myc/core";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createCreateCommand, createTaskCommand } from "./tasks.ts";
import { createReadyCommand } from "./ready.ts";
import { createRecallCommand } from "./recall.ts";
import { createShowCommand } from "./show.ts";
import { createPrimeCommand } from "./prime.ts";
import { realStoreDeps } from "./store.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";

let root: string;
let home: string;
let db: string;
let registry: Registry;

/** Эмбеддера в тестах нет: векторная ветка обязана быть громко выключена. */
function retrieveDeps(): RetrieveDeps {
  return {
    openStore: realStoreDeps.openStore,
    ...realRetrieveExtras,
    resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
  };
}

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createCreateCommand());
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  r.register(createRecallCommand(retrieveDeps()));
  r.register(createShowCommand());
  r.register(createPrimeCommand());
  return r;
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-eco-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  process.env.MYC_HOME = home;
  mkdirSync(join(root, ".myc"));
  db = join(root, ".myc", "myc.db");
  const raw = new Database(db, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  // Экосистема: корень + два самостоятельных репозитория + обычный каталог,
  // который репозиторием НЕ является.
  for (const repo of ["collector", "messaging-server"]) {
    mkdirSync(join(root, repo, "src"), { recursive: true });
    writeFileSync(join(root, repo, ".git"), "gitdir: ../.git/modules/x\n");
  }
  mkdirSync(join(root, "docs"), { recursive: true });
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
});

/** Команда из каталога `where` — именно путь и решает, какой охват запишется. */
function myc(where: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", where, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
  error?: { code: string; exit: number };
}

async function mycJson(where: string, ...args: string[]): Promise<Envelope> {
  const r = await myc(where, ...args, "--json");
  return JSON.parse(text(r.stdout)) as Envelope;
}

/** Охват узла прямо из базы: проверяем ЗАПИСАННОЕ, а не напечатанное. */
function storedRepo(id: string): string | undefined {
  const raw = new Database(db, { readonly: true });
  try {
    const row = raw.query("SELECT attrs FROM nodes WHERE id = ?1").get(id) as
      | { attrs: string }
      | null;
    const attrs = JSON.parse(row!.attrs) as Record<string, unknown>;
    return attrs[REPO_KEY] as string | undefined;
  } finally {
    raw.close();
  }
}

// ===========================================================================
// Присвоение
// ===========================================================================

describe("охват берётся из пути, а не из слага воркспейса", () => {
  test("узел, заведённый внутри репозитория, получает его охват БЕЗ ФЛАГОВ", async () => {
    const inRepo = await mycJson(join(root, "collector", "src"), "task", "сбор метрик");
    expect(inRepo.data["repo"]).toBe("collector");
    expect(storedRepo(inRepo.data["id"] as string)).toBe("collector");
  });

  test("два разных репозитория дают ДВА разных охвата", async () => {
    const a = await mycJson(join(root, "collector"), "task", "а");
    const b = await mycJson(join(root, "messaging-server", "src"), "task", "б");
    expect(a.data["repo"]).toBe("collector");
    expect(b.data["repo"]).toBe("messaging-server");
    expect(a.data["repo"]).not.toBe(b.data["repo"]);
  });

  test("узел из корня — общий охват, и он ЗАПИСАН, а не отсутствует", async () => {
    const e = await mycJson(root, "task", "про экосистему целиком");
    expect(e.data["repo"]).toBe("");
    // Ключ есть и пуст: именно это отличает «общий» от «не определён».
    expect(storedRepo(e.data["id"] as string)).toBe("");
  });

  test("обычный подкаталог корня — тоже общий охват", async () => {
    const e = await mycJson(join(root, "docs"), "task", "правка дизайн-доков");
    expect(e.data["repo"]).toBe("");
  });

  test("заметки идут тем же путём, что и задачи", async () => {
    const note = await mycJson(
      join(root, "collector"),
      "create",
      "--kind",
      "memory",
      "у коллектора своя очередь",
    );
    expect(note.data["repo"]).toBe("collector");
  });

  test("явный --repo сильнее выведенного из пути", async () => {
    const forced = await mycJson(
      join(root, "collector"),
      "task",
      "чужая задача",
      "--repo",
      "messaging-server",
    );
    expect(forced.data["repo"]).toBe("messaging-server");
    expect(storedRepo(forced.data["id"] as string)).toBe("messaging-server");
  });

  test("человеческий вывод называет репозиторий и молчит про общий охват", async () => {
    const inRepo = text((await myc(join(root, "collector"), "task", "видимая строка")).stdout);
    expect(inRepo).toContain("repo      collector");
    const atRoot = text((await myc(root, "task", "общая")).stdout);
    expect(atRoot).not.toContain("repo      ");
  });
});

// ===========================================================================
// И2: невыведенный охват виден
// ===========================================================================

describe("И2: охват, который не удалось вывести, ВИДЕН", () => {
  test("путь вне воркспейса: create говорит «не определён» и называет причину", async () => {
    const outside = mkdtempSync(join(tmpdir(), "myc-outside-"));
    try {
      const env = await mycJson(outside, "--db", db, "task", "заведена не пойми откуда");
      expect(env.data["repo"]).toBeNull();
      expect(env.data["repo_reason"]).toContain(outside);
      // В базе ключа НЕТ — узел честно читается как «охват не определён».
      expect(storedRepo(env.data["id"] as string)).toBeUndefined();

      const human = text((await myc(outside, "--db", db, "task", "и ещё одна")).stdout);
      expect(human).toContain("repo      не определён");
      expect(human).toContain("путь вне воркспейса");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("«не определён» не подменяется общим: состояния различимы в выдаче", async () => {
    const outside = mkdtempSync(join(tmpdir(), "myc-outside2-"));
    try {
      const undetermined = await mycJson(outside, "--db", db, "task", "без охвата");
      const general = await mycJson(root, "task", "общая");
      expect(undetermined.data["repo"]).toBeNull();
      expect(general.data["repo"]).toBe("");
      expect(undetermined.data["repo"]).not.toBe(general.data["repo"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("ready называет число задач без охвата репозитория", async () => {
    // Узел, записанный ДО S59: ключа repo у него нет вовсе.
    const raw = new Database(db);
    raw.exec(
      `INSERT INTO nodes (id, kind, layer, scope, title, status, content_hash, attrs,
                          created_at, updated_at)
       VALUES ('myc-old00000001','task',1,'','старая задача','open','h-old',
               '{"type":"task"}',1,1)`,
    );
    raw.close();

    const out = text((await myc(root, "ready")).stdout);
    expect(out).toContain("1 без охвата репозитория");
    const env = await mycJson(root, "ready");
    expect(env.meta["repo_unknown"]).toBe(1);
  });

  test("ready из каталога вне воркспейса говорит, что охват не определён", async () => {
    const outside = mkdtempSync(join(tmpdir(), "myc-outside3-"));
    try {
      const out = text((await myc(outside, "--db", db, "ready")).stdout);
      expect(out).toContain("охват репозитория не определён");
      expect(out).toContain("путь вне воркспейса");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Фильтрация
// ===========================================================================

describe("ready фильтрует по репозиторию", () => {
  beforeEach(async () => {
    await myc(join(root, "collector"), "task", "задача коллектора");
    await myc(join(root, "messaging-server"), "task", "задача мессенджера");
    await myc(root, "task", "задача всей экосистемы");
  });

  test("из репозитория видно своё и общее, чужое скрыто и НАЗВАНО числом", async () => {
    const env = await mycJson(join(root, "collector", "src"), "ready");
    const titles = (env.data["items"] as { title: string }[]).map((i) => i.title);
    expect(titles).toContain("задача коллектора");
    expect(titles).toContain("задача всей экосистемы");
    expect(titles).not.toContain("задача мессенджера");
    expect(env.meta["repo"]).toBe("collector");
    expect(env.meta["repo_foreign"]).toBe(1);

    const out = text((await myc(join(root, "collector"), "ready")).stdout);
    expect(out).toContain("repo collector");
    expect(out).toContain("1 из других репозиториев скрыто");
  });

  test("из корня видно всё: экосистемный корень — не репозиторий", async () => {
    const env = await mycJson(root, "ready");
    const titles = (env.data["items"] as { title: string }[]).map((i) => i.title);
    expect(titles.length).toBe(3);
    expect(env.meta["repo"]).toBeNull();
    expect(env.meta["repo_foreign"]).toBe(0);
  });

  test("--repo <имя> берёт чужой репозиторий из любого места", async () => {
    const env = await mycJson(join(root, "collector"), "ready", "--repo", "messaging-server");
    const titles = (env.data["items"] as { title: string }[]).map((i) => i.title);
    expect(titles).toContain("задача мессенджера");
    expect(titles).toContain("задача всей экосистемы");
    expect(titles).not.toContain("задача коллектора");
  });

  test("--repo all снимает фильтр изнутри репозитория", async () => {
    const env = await mycJson(join(root, "collector"), "ready", "--repo", "all");
    expect((env.data["items"] as unknown[]).length).toBe(3);
    expect(env.meta["repo"]).toBeNull();
  });

  test("фильтр держится и на пути с другими фильтрами (--kind)", async () => {
    const env = await mycJson(join(root, "collector"), "ready", "--kind", "task");
    const titles = (env.data["items"] as { title: string }[]).map((i) => i.title);
    expect(titles).not.toContain("задача мессенджера");
    expect(titles).toContain("задача коллектора");
  });

  test("blocked/in_progress в подвале считаются под тем же фильтром", async () => {
    const other = await mycJson(join(root, "messaging-server"), "task", "ещё одна чужая");
    const raw = new Database(db);
    raw.query("UPDATE nodes SET status='in_progress' WHERE id = ?1").run(other.data["id"] as string);
    raw.close();

    const own = await mycJson(join(root, "collector"), "ready");
    expect(own.data["in_progress"]).toBe(0);
    const all = await mycJson(root, "ready");
    expect(all.data["in_progress"]).toBe(1);
  });

  test("--claim берёт задачу СВОЕГО репозитория, а не чужую", async () => {
    // Чужая задача сделана заведомо приоритетнее: без фильтра выбрали бы её.
    const raw = new Database(db);
    raw.exec("UPDATE nodes SET priority = 0 WHERE title = 'задача мессенджера'");
    raw.close();
    const env = await mycJson(join(root, "collector"), "ready", "--claim");
    const claimed = env.data["claimed"] as { title: string };
    expect(claimed.title).not.toBe("задача мессенджера");
  });
});

describe("recall фильтрует по репозиторию", () => {
  beforeEach(async () => {
    await myc(join(root, "collector"), "create", "--kind", "memory", "очередь ретривала коллектора");
    await myc(
      join(root, "messaging-server"),
      "create",
      "--kind",
      "memory",
      "очередь ретривала мессенджера",
    );
    await myc(root, "create", "--kind", "memory", "очередь ретривала всей экосистемы");
  });

  test("из репозитория выдаётся своё и общее, чужое — нет", async () => {
    const env = await mycJson(join(root, "collector"), "recall", "очередь ретривала");
    const titles = (env.data["rows"] as { title: string }[]).map((r) => r.title);
    expect(titles).toContain("очередь ретривала коллектора");
    expect(titles).toContain("очередь ретривала всей экосистемы");
    expect(titles).not.toContain("очередь ретривала мессенджера");
    expect(env.meta["repo"]).toBe("collector");
  });

  test("из корня — все три", async () => {
    const env = await mycJson(root, "recall", "очередь ретривала");
    expect((env.data["rows"] as unknown[]).length).toBe(3);
    expect(env.meta["repo"]).toBeNull();
  });

  test("--repo all возвращает чужое изнутри репозитория", async () => {
    const env = await mycJson(join(root, "collector"), "recall", "очередь ретривала", "--repo", "all");
    const titles = (env.data["rows"] as { title: string }[]).map((r) => r.title);
    expect(titles).toContain("очередь ретривала мессенджера");
  });

  test("охват репозитория — своя колонка строки и своё число в подвале", async () => {
    const out = text((await myc(root, "recall", "очередь ретривала")).stdout);
    expect(out).toContain("collector");
    expect(out).toContain("все");

    const raw = new Database(db);
    raw.exec(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, status, content_hash,
                          attrs, created_at, updated_at)
       VALUES ('myc-old00000002','note',1,'','очередь ретривала до S59','тело','очередь',
               'active','h-old2','{}',1,1)`,
    );
    raw.close();
    const withOld = text((await myc(root, "recall", "очередь ретривала")).stdout);
    expect(withOld).toContain("1 без охвата репозитория");
  });
});

// ===========================================================================
// Три оси независимы
// ===========================================================================

describe("три оси не сводятся одна к другой", () => {
  test("охват репозитория не выводится из слага воркспейса", async () => {
    // Слаг один на всю базу; охваты у двух узлов разные — значит источник
    // охвата НЕ слаг. Это и есть первая мутация из брифа, поставленная тестом.
    const a = await mycJson(join(root, "collector"), "task", "а");
    const b = await mycJson(root, "task", "б");
    expect(a.data["repo"]).toBe("collector");
    expect(b.data["repo"]).toBe("");
  });

  test("охват сессии (S58) и охват репозитория живут в разных полях", async () => {
    const env = await mycJson(join(root, "collector"), "task", "обе оси сразу");
    const raw = new Database(db, { readonly: true });
    const row = raw.query("SELECT attrs FROM nodes WHERE id = ?1").get(env.data["id"] as string) as {
      attrs: string;
    };
    raw.close();
    const attrs = JSON.parse(row.attrs) as Record<string, unknown>;
    // Ключ охвата репозитория есть; ключ охвата сессии — отдельный и здесь
    // отсутствует. Сложи их в одно поле — этот тест покраснеет.
    expect(attrs["repo"]).toBe("collector");
    expect(attrs["reach"]).toBeUndefined();
  });

  test("колонка scope осталась слагом воркспейса, а не именем репозитория", async () => {
    await mycJson(join(root, "collector"), "task", "в коллекторе");
    await mycJson(root, "task", "в корне");
    const raw = new Database(db, { readonly: true });
    const scopes = raw
      .query("SELECT DISTINCT scope FROM nodes WHERE kind='task'")
      .all() as Array<{ scope: string }>;
    raw.close();
    // Один scope на всю базу: ось яруса (S41) не тронута осью репозитория.
    expect(scopes.length).toBe(1);
  });
});

describe("prime знает про охват репозитория (R5)", () => {
  test("из репозитория prime фильтрует как ready и называет скрытое числом", async () => {
    await myc(join(root, "collector"), "task", "задача коллектора");
    await myc(join(root, "messaging-server"), "task", "задача мессенджера");
    // `prime` теперь читает ту же ось, что `ready` (S59): своя задача видна,
    // чужая скрыта, и подвал НАЗЫВАЕТ скрытое числом — то же самое, что уже
    // умеет `ready`, тем же кодом (collectTop/readyStats), не второй копией.
    const out = text((await myc(join(root, "collector"), "prime")).stdout);
    expect(out).toContain("задача коллектора");
    expect(out).not.toContain("задача мессенджера");
    expect(out).toContain("repo collector");
    expect(out).toContain("1 из других репозиториев скрыто");
  });

  test("из корня воркспейса prime видит всё — общий охват, фильтра нет", async () => {
    await myc(join(root, "collector"), "task", "задача коллектора");
    await myc(join(root, "messaging-server"), "task", "задача мессенджера");
    const out = text((await myc(root, "prime")).stdout);
    expect(out).toContain("задача коллектора");
    expect(out).toContain("задача мессенджера");
  });
});

describe("грамматика", () => {
  test("--repo у create и ready принимается, у recall тоже", async () => {
    expect((await myc(root, "task", "x", "--repo", "collector")).code).toBe(ExitCode.OK);
    expect((await myc(root, "ready", "--repo", "collector")).code).toBe(ExitCode.OK);
    expect((await myc(root, "recall", "x", "--repo", "collector")).code).toBe(ExitCode.OK);
  });
});
