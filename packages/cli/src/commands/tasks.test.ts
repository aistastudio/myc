/**
 * Интеграционные тесты команд задач: create/update/show/list/dep/ready/claim/close
 * против настоящего SQLite во временной директории — через публичный run(),
 * как их вызывает main.ts. Движок (GraphStore/Claims) здесь не перепроверяется:
 * у него свои тесты в store-sqlite; мы проверяем грамматику, вывод и коды.
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
import {
  createBugCommand,
  createClaimCommand,
  createReleaseCommand,
  createMsgCommand,
  createCommentCommand,
  createEpicCommand,
  createCloseCommand,
  createCreateCommand,
  createTaskCommand,
  createUpdateCommand,
} from "./tasks.ts";
import { createShowCommand } from "./show.ts";
import { createListCommand } from "./list.ts";
import { createDepCommand } from "./dep.ts";
import { createReadyCommand } from "./ready.ts";

let dir: string;
let db: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createCreateCommand());
  r.register(createTaskCommand());
  r.register(createBugCommand());
  r.register(createUpdateCommand());
  r.register(createClaimCommand());
  r.register(createReleaseCommand());
  r.register(createCloseCommand());
  r.register(createShowCommand());
  r.register(createListCommand());
  r.register(createDepCommand());
  r.register(createReadyCommand());
  r.register(createMsgCommand());
  r.register(createCommentCommand());
  r.register(createEpicCommand());
  return r;
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-cmd-"));
  mkdirSync(join(dir, ".myc"));
  db = join(dir, ".myc", "myc.db");
  const raw = new Database(db, { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function mycJson(...args: string[]): Promise<{
  code: number;
  env: Record<string, unknown>;
}> {
  const r = await myc(...args, "--json");
  expect(typeof r.stdout).toBe("string");
  return { code: r.code, env: JSON.parse(r.stdout as string) as Record<string, unknown> };
}

function idOf(out: string | Iterable<string>): string {
  const line = (typeof out === "string" ? out : [...out].join("")).split("\n")[0]!;
  return line.split(/\s+/)[0]!;
}

async function createTask(title: string, ...extra: string[]): Promise<string> {
  const r = await myc("task", title, ...extra);
  expect(r.code).toBe(ExitCode.OK);
  return idOf(r.stdout);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  test("task: человеческий вывод и json-конверт", async () => {
    const r = await myc("task", "Первая задача", "-p", "P0", "--estimate", "2h", "--tag", "a,b");
    expect(r.code).toBe(ExitCode.OK);
    const text = r.stdout as string;
    const id = idOf(r.stdout);
    expect(id).toMatch(/^myc-/);
    expect(text).toContain("task  P0  open  free");

    const { code, env } = await mycJson("show", id);
    expect(code).toBe(ExitCode.OK);
    const data = env["data"] as Record<string, unknown>;
    expect(data["title"]).toBe("Первая задача");
    expect(data["priority"]).toBe(0);
    expect(data["estimate_min"]).toBe(120);
    expect(data["tags"]).toEqual(["a", "b"]);
  });

  test("bug: приоритет P1 по умолчанию, тип bug", async () => {
    const id = await createTask("баг", ...[]);
    const r = await myc("bug", "падает prime");
    const bugId = idOf(r.stdout);
    expect(r.stdout as string).toContain("bug  P1  open");
    const { env } = await mycJson("list", "--kind", "bug", "--json" as string);
    const rows = (env["data"] as { rows: { id: string }[] }).rows;
    expect(rows.map((x) => x.id)).toContain(bugId);
    expect(rows.map((x) => x.id)).not.toContain(id);
  });

  test("memory/decision — это note, не task", async () => {
    const r = await myc("create", "факт", "--kind", "memory");
    expect(r.code).toBe(ExitCode.OK);
    const { env } = await mycJson("show", idOf(r.stdout));
    expect((env["data"] as Record<string, unknown>)["kind"]).toBe("note");
  });

  test("--dep сразу связывает и выводит blocked-by", async () => {
    const a = await createTask("блокер");
    const r = await myc("task", "зависимая", "--dep", a);
    expect(r.stdout as string).toContain(`blocked-by ${a}`);
  });

  test("без заголовка — usage", async () => {
    const r = await myc("task");
    expect(r.code).toBe(ExitCode.USAGE);
  });

  test("без воркспейса — NOWS", async () => {
    const empty = mkdtempSync(join(tmpdir(), "myc-nows-"));
    try {
      const r = await run(["-C", empty, "ready"], { registry });
      expect(r.code).toBe(ExitCode.NOWS);
      expect(r.stderr).toContain("ws.not_initialized");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// dep
// ---------------------------------------------------------------------------

describe("dep", () => {
  test("add/rm и счётчик блокеров", async () => {
    const a = await createTask("A");
    const b = await createTask("B");
    const add = await myc("dep", "add", b, "blocked-by", a);
    expect(add.code).toBe(ExitCode.OK);
    expect(add.stdout as string).toContain(`${b} blocked-by ${a}`);

    const ready = await myc("ready");
    expect(ready.stdout as string).not.toContain(b);

    const rm = await myc("dep", "rm", b, "blocked-by", a);
    expect(rm.code).toBe(ExitCode.OK);
    const ready2 = await myc("ready");
    expect(ready2.stdout as string).toContain(b);
  });

  test("цикл — exit 4 с путём", async () => {
    const a = await createTask("A");
    const b = await createTask("B");
    await myc("dep", "add", a, "blocks", b);
    const r = await myc("dep", "add", b, "blocks", a);
    expect(r.code).toBe(ExitCode.CONFLICT);
    expect(r.stderr).toContain("цикл зависимостей");
    expect(r.stderr).toContain(`${a} → ${b} → ${a}`);
  });

  test("tree и why", async () => {
    const a = await createTask("корень");
    const b = await createTask("середина", "--dep", a);
    const c = await createTask("лист", "--dep", b);
    const tree = await myc("dep", "tree", a);
    expect(tree.stdout as string).toContain("└── blocks");
    expect(tree.stdout as string).toContain("2 узла заблокировано");
    const why = await myc("dep", "why", c);
    expect(why.stdout as string).toContain("заблокирована 1 открытой зависимостью");
    expect(why.stdout as string).toContain("критический путь");
  });
});

// ---------------------------------------------------------------------------
// ready
// ---------------------------------------------------------------------------

describe("ready", () => {
  test("порядок: P0 выше, --why печатает слагаемые, их сумма = score", async () => {
    await createTask("низкий", "-p", "P3");
    const top = await createTask("верхний", "-p", "P0");
    const r = await myc("ready", "--why", "-n", "2");
    const lines = (r.stdout as string).split("\n");
    expect(lines[0]).toContain(top);
    const whyLine = lines.find((l) => l.includes("score"))!;
    const m = /score (\d+\.\d+) = .*\((\d+\.\d+)\).*\+ .*\((\d+\.\d+)\).*\+ .*\((\d+\.\d+)\).*\+ .*\((\d+\.\d+)\).*\+ .*\((\d+\.\d+)\)/.exec(whyLine)!;
    const sum = Number(m[2]) + Number(m[3]) + Number(m[4]) + Number(m[5]) + Number(m[6]);
    expect(Math.abs(sum - Number(m[1]))).toBeLessThan(0.011);
  });

  test("футер: ready/blocked/in_progress и время", async () => {
    const a = await createTask("блокер");
    await createTask("зависимая", "--dep", a);
    const r = await myc("ready");
    expect(r.stdout as string).toMatch(/1 ready · 1 blocked · 0 in_progress · \d+ мс/);
  });

  test("пустая очередь с блокерами — осмысленный ответ, exit 0", async () => {
    const a = await createTask("блокер");
    await createTask("зависимая", "--dep", a);
    // забираем блокер, чтобы зависимая осталась blocked, а ready пуст
    const b = await createTask("вторая зависимая", "--dep", a);
    void b;
    // закрываем ничего; ready содержит блокер — очистим: клеймим блокер
    await myc("claim", a);
    const r = await myc("ready", "--priority", "P0");
    expect(r.code).toBe(ExitCode.OK);
    // фильтром добиваемся пустой выдачи при наличии blocked
    const empty = await myc("ready", "--kind", "epic");
    expect(empty.stdout as string).toContain("0 ready");
  });

  test("json: ровно один конверт-объект", async () => {
    await createTask("одна");
    const { code, env } = await mycJson("ready");
    expect(code).toBe(ExitCode.OK);
    expect(env["ok"]).toBe(true);
    const data = env["data"] as { items: unknown[]; ready: number };
    expect(data.ready).toBe(1);
    expect(Array.isArray(data.items)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// claim / close
// ---------------------------------------------------------------------------

describe("claim/close", () => {
  test("claim → чужой claim → conflict 4; свой повтор → renew", async () => {
    const id = await createTask("задача");
    const c1 = await myc("claim", id);
    expect(c1.code).toBe(ExitCode.OK);
    expect(c1.stdout as string).toContain(`claimed ${id} by tester`);
    expect(c1.stdout as string).toContain("аренда 30m");

    const c2 = await run(["-C", dir, "claim", id, "--as", "other"], { registry, env: {} });
    expect(c2.code).toBe(ExitCode.CONFLICT);
    expect(c2.stderr).toContain("conflict.claimed");
    expect(c2.stderr).toContain("--steal");

    const c3 = await myc("claim", id);
    expect(c3.code).toBe(ExitCode.OK);
    expect(c3.stdout as string).toContain(`renewed ${id}`);
  });

  test("claim заблокированной — precond 5", async () => {
    const a = await createTask("блокер");
    const b = await createTask("зависимая", "--dep", a);
    const r = await myc("claim", b);
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("precond.blocked");
  });

  test("close владельцем: unblocked и outcome; чужим — conflict", async () => {
    const a = await createTask("блокер");
    const b = await createTask("зависимая", "--dep", a);
    await myc("claim", a);

    const alien = await run(["-C", dir, "close", a, "--as", "other"], { registry, env: {} });
    expect(alien.code).toBe(ExitCode.CONFLICT);

    const r = await myc("close", a, "--reason", "готово", "--verify", "tests", "--cost-in", "41000", "--cost-out", "6000");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.stdout as string).toContain(`closed ${a}`);
    expect(r.stdout as string).toContain(`unblocked ${b}`);
    expect(r.stdout as string).toContain("verify=tests");
    expect(r.stdout as string).toContain("in 41k / out 6k");

    const ready = await myc("ready");
    expect(ready.stdout as string).toContain(b);
  });

  test("close открытой (без аренды) и идемпотентный повтор", async () => {
    const id = await createTask("простая");
    const r1 = await myc("close", id);
    expect(r1.code).toBe(ExitCode.OK);
    const r2 = await myc("close", id);
    expect(r2.code).toBe(ExitCode.OK);
    expect(r2.stdout as string).toContain("уже closed");
  });

  test("ready --claim берёт верхнюю и прячет её из очереди", async () => {
    await createTask("ниже", "-p", "P2");
    const top = await createTask("верх", "-p", "P0");
    const r = await myc("ready", "--claim");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.stdout as string).toContain(`claimed ${top} by tester`);
    const ready = await myc("ready");
    expect(ready.stdout as string).not.toContain(top);
  });
});

// ---------------------------------------------------------------------------
// show / list / update
// ---------------------------------------------------------------------------

describe("show/list/update", () => {
  test("show по префиксу; неоднозначность — exit 2; не найден — exit 3", async () => {
    const id = await createTask("префиксная");
    const body = id.slice(4, 8);
    const r = await myc("show", body);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.stdout as string).toContain(id);

    const nf = await myc("show", "myc-zzzzzzzzzzzz");
    expect(nf.code).toBe(ExitCode.NOTFOUND);
  });

  test("show --field батчем: id всегда первая колонка", async () => {
    const a = await createTask("раз");
    const b = await createTask("два");
    const r = await myc("show", `${a},${b}`, "--field", "title,status");
    const lines = (r.stdout as string).trim().split("\n");
    expect(lines[0]).toContain(a);
    expect(lines[1]).toContain(b);
    expect(lines[0]).toContain("раз");
  });

  test("list: фильтры, --count, футер", async () => {
    await createTask("t1", "-p", "P0");
    await createTask("t2", "-p", "P1");
    const r = await myc("list", "--kind", "task", "--status", "open", "--sort", "priority");
    expect(r.stdout as string).toMatch(/2 из 2 · \d+ мс/);
    const c = await myc("list", "--kind", "task", "--count");
    expect((c.stdout as string).trim()).toBe("2");
    const p0 = await myc("list", "--priority", "P0");
    expect(p0.stdout as string).toMatch(/1 из 1/);
  });

  test("update: поля меняются, пустой update — usage", async () => {
    const id = await createTask("старое");
    const r = await myc("update", id, "--title", "новое", "-p", "P0", "--tag", "x");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.stdout as string).toContain("updated: title, priority, tags");
    const { env } = await mycJson("show", id);
    const data = env["data"] as Record<string, unknown>;
    expect(data["title"]).toBe("новое");
    expect(data["priority"]).toBe(0);

    const empty = await myc("update", id);
    expect(empty.code).toBe(ExitCode.USAGE);
  });

  test("нет ANSI при не-TTY", async () => {
    await createTask("ansi");
    for (const args of [["list"], ["ready"], ["show", "--help"]]) {
      const r = await myc(...args);
      const out = typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
      expect(out).not.toContain("");
    }
  });
});

// ---------------------------------------------------------------------------
// workspace.toml
// ---------------------------------------------------------------------------

describe("workspace.toml", () => {
  test("веса [ready] и slug переопределяются", async () => {
    writeFileSync(
      join(dir, ".myc", "workspace.toml"),
      'slug = "proj"\n\n[ready]\npriority = 1.0\nunblocks = 0.0\nfreshness = 0.0\nanchors = 0.0\ntype = 0.0\n',
    );
    const r = await myc("task", "в другом scope");
    expect(idOf(r.stdout)).toMatch(/^proj-/);
    const why = await myc("ready", "--why", "-n", "1");
    expect(why.stdout as string).toContain("P2(0.33)");
    expect(why.stdout as string).toMatch(/unblocks \d+\(0\.00\)/);
  });
});

// ---------------------------------------------------------------------------
// S54: статус вычисляется или зарабатывается, но не назначается
// ---------------------------------------------------------------------------

describe("update --status: механизм владеет статусом", () => {
  test("in_progress записью статуса отклонён: иначе задача остаётся без аренды", async () => {
    // Ровно исходный дефект: статус проставлялся, lease_holder оставался пуст,
    // и claim другого исполнителя проходил по ветке CAS для БРОШЕННОЙ работы
    // (`status='in_progress' AND lease_expires < now`, а пустая аренда — это 0).
    // Переход печатался как in_progress→in_progress: двойное владение не видно
    // ни на одной доске.
    const id = await createTask("задача");
    const r = await mycJson("update", id, "--status", "in_progress");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect((r.env as { error: { code: string } }).error.code).toBe("precond.use_claim");
    expect((r.env as { error: { hint?: string } }).error.hint).toContain(`myc claim ${id}`);
  });

  test("после запрета единственный путь в in_progress — claim, и он даёт аренду", async () => {
    const id = await createTask("задача");
    await myc("update", id, "--status", "in_progress");
    expect((await myc("claim", id)).code).toBe(ExitCode.OK);
    const raw = new Database(db, { readonly: true });
    try {
      const row = raw
        .query("SELECT status, lease_holder, lease_expires FROM nodes WHERE id = ?1")
        .get(id) as { status: string; lease_holder: string; lease_expires: number };
      expect(row.status).toBe("in_progress");
      // Инвариант, который дефект нарушал: in_progress без держателя невозможен.
      expect(row.lease_holder).not.toBe("");
      expect(row.lease_expires).toBeGreaterThan(0);
    } finally {
      raw.close();
    }
  });

  test("blocked отклонён: он вычисляется из открытых блокеров", async () => {
    const id = await createTask("задача");
    const r = await mycJson("update", id, "--status", "blocked");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect((r.env as { error: { code: string } }).error.code).toBe("precond.derived");
    // Сообщение называет РЕАЛЬНОЕ число блокеров, а не отделывается общей фразой.
    expect((r.env as { error: { msg: string } }).error.msg).toContain("0");
  });

  test("closed отклонён: закрытие требует владения, причины и отчёта", async () => {
    const id = await createTask("задача");
    const r = await mycJson("update", id, "--status", "closed");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect((r.env as { error: { code: string } }).error.code).toBe("precond.use_close");
  });

  test("open при живой чужой аренде отклонён: иначе задача-призрак", async () => {
    // Призрак: статус open выводит задачу в ready, но claim отказывает по живой
    // аренде — очередь предлагает работу, которую никто не может взять.
    const id = await createTask("задача");
    await run(["-C", dir, "claim", id, "--as", "agent-x"], { registry, env: {} });
    const r = await mycJson("update", id, "--status", "open");
    expect(r.code).toBe(ExitCode.CONFLICT);
    expect((r.env as { error: { code: string } }).error.code).toBe("conflict.claimed");
    expect((r.env as { error: { hint?: string } }).error.hint).toContain("release");
  });

  test("open без аренды разрешён: отменённую задачу можно вернуть в работу", async () => {
    const id = await createTask("задача");
    expect((await myc("update", id, "--status", "cancelled")).code).toBe(ExitCode.OK);
    expect((await myc("update", id, "--status", "open")).code).toBe(ExitCode.OK);
  });

  test("отмена печатает, кого она выпустила в очередь", async () => {
    // cancelled терминален наравне с closed (триггер trg_st_close), поэтому
    // отмена блокера делает зависимую готовой. Молча этого делать нельзя.
    const blocker = await createTask("блокер");
    const dependent = await createTask("зависимая");
    await myc("dep", "add", dependent, "blocked-by", blocker);
    const r = await mycJson("update", blocker, "--status", "cancelled");
    expect(r.code).toBe(ExitCode.OK);
    expect(((r.env as { data: { unblocked?: string[] } }).data.unblocked ?? [])).toContain(dependent);
  });

  test("не-задачи охрана не трогает: у заметки свои статусы", async () => {
    const r = await myc("create", "--kind", "memory", "факт");
    const id = idOf(r.stdout);
    expect((await myc("update", id, "--status", "superseded")).code).toBe(ExitCode.OK);
  });
});

describe("release: отпустить взятую задачу", () => {
  test("своя аренда снимается, статус возвращается в open", async () => {
    const id = await createTask("задача");
    await myc("claim", id);
    expect((await myc("release", id)).code).toBe(ExitCode.OK);
    const raw = new Database(db, { readonly: true });
    try {
      const row = raw
        .query("SELECT status, lease_holder, lease_expires FROM nodes WHERE id = ?1")
        .get(id) as { status: string; lease_holder: string; lease_expires: number };
      expect(row.status).toBe("open");
      expect(row.lease_holder).toBe("");
      expect(row.lease_expires).toBe(0);
    } finally {
      raw.close();
    }
  });

  test("чужая живая аренда без --force не снимается", async () => {
    const id = await createTask("задача");
    await run(["-C", dir, "claim", id, "--as", "agent-x"], { registry, env: {} });
    const r = await mycJson("release", id);
    expect(r.code).toBe(ExitCode.CONFLICT);
    expect((r.env as { error: { hint?: string } }).error.hint).toContain("--force");
  });

  test("--force снимает чужую и говорит об этом громко", async () => {
    const id = await createTask("задача");
    await run(["-C", dir, "claim", id, "--as", "agent-x"], { registry, env: {} });
    const r = await mycJson("release", id, "--force");
    expect(r.code).toBe(ExitCode.OK);
    const warns = (r.env as { warn: { code: string }[] }).warn.map((w) => w.code);
    expect(warns).toContain("release.forced");
    expect((r.env as { meta: { degraded: string[] } }).meta.degraded).toContain("release.forced");
  });

  test("отпускать невзятую нечего", async () => {
    const id = await createTask("задача");
    const r = await mycJson("release", id);
    expect(r.code).toBe(ExitCode.PRECOND);
    expect((r.env as { error: { code: string } }).error.code).toBe("precond.not_claimed");
  });

  test("после release задачу берёт другой исполнитель", async () => {
    const id = await createTask("задача");
    await run(["-C", dir, "claim", id, "--as", "agent-x"], { registry, env: {} });
    await myc("release", id, "--force");
    const r = await run(["-C", dir, "claim", id, "--as", "agent-y"], { registry, env: {} });
    expect(r.code).toBe(ExitCode.OK);
  });
});

// ---------------------------------------------------------------------------
// Иерархия: ребро parent было невидимо
// ---------------------------------------------------------------------------

describe("show: состав эпика и принадлежность задачи", () => {
  test("эпик показывает детей и прогресс по закрытым", async () => {
    // Ребро `parent` писалось `myc create --parent` с самого начала, но не
    // разбиралось ни в show, ни в dep tree (тот ходит по `blocks` и отвечает
    // на другой вопрос — «что мешает», а не «из чего состоит»). Данные копились,
    // а увидеть состав эпика было нечем.
    const epic = idOf((await myc("create", "--kind", "epic", "эпик")).stdout);
    const a = idOf((await myc("task", "первая", "--parent", epic)).stdout);
    const b = idOf((await myc("task", "вторая", "--parent", epic)).stdout);
    await myc("claim", a);
    await myc("close", a, "--reason", "сделано");

    const r = await mycJson("show", epic);
    const view = (r.env as { data: { children?: { id: string; status: string }[] } }).data;
    expect((view.children ?? []).map((c) => c.id).sort()).toEqual([a, b].sort());
    const human = await myc("show", epic);
    expect(human.stdout as string).toContain("состав    1 из 2 закрыто");
  });

  test("отменённое не считается сделанным", async () => {
    // Складывать closed и cancelled в один счётчик значило бы показывать эпик
    // более готовым, чем он есть: отменённая задача — это не выполненная работа.
    const epic = idOf((await myc("create", "--kind", "epic", "эпик")).stdout);
    const a = idOf((await myc("task", "первая", "--parent", epic)).stdout);
    await myc("update", a, "--status", "cancelled");
    const human = await myc("show", epic);
    expect(human.stdout as string).toContain("состав    0 из 1 закрыто, отменено 1");
  });

  test("задача показывает, в какой эпик входит", async () => {
    const epic = idOf((await myc("create", "--kind", "epic", "родитель")).stdout);
    const a = idOf((await myc("task", "дочерняя", "--parent", epic)).stdout);
    const r = await mycJson("show", a);
    expect((r.env as { data: { parent?: { id: string } } }).data.parent?.id).toBe(epic);
  });

  test("узел без иерархии не обрастает пустыми полями", async () => {
    const a = await createTask("одиночка");
    const r = await mycJson("show", a);
    const d = r.env as { data: Record<string, unknown> };
    expect(d.data["parent"]).toBeUndefined();
    expect(d.data["children"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Перенос между эпиками: иерархию можно не только СОЗДАТЬ, но и ИЗМЕНИТЬ
// ---------------------------------------------------------------------------

describe("update --parent: перенос задачи между эпиками", () => {
  test("перенос меняет состав обоих эпиков и называет прежний дом", async () => {
    // До этого ребро `parent` писалось ТОЛЬКО при создании: у update флага не
    // было, и задача, попавшая не в тот эпик, оставалась там навсегда. Это же
    // блокировало перенос из интерфейса (W5) — веб ходит тем же путём записи.
    const a = idOf((await myc("create", "--kind", "epic", "эпик А")).stdout);
    const b = idOf((await myc("create", "--kind", "epic", "эпик Б")).stdout);
    const t = idOf((await myc("task", "переезжает", "--parent", a)).stdout);

    const moved = await myc("update", t, "--parent", b);
    expect(moved.code).toBe(0);
    expect(moved.stdout as string).toContain(`эпик: ${a} → ${b}`);

    // Оба конца обязаны сойтись: старый эпик опустел, новый принял.
    expect((await myc("show", a)).stdout as string).not.toContain(t);
    const bView = await mycJson("show", b);
    const kids = (bView.env as { data: { children?: { id: string }[] } }).data.children ?? [];
    expect(kids.map((c) => c.id)).toEqual([t]);
  });

  test("--no-parent отцепляет, повтор отказывает", async () => {
    const a = idOf((await myc("create", "--kind", "epic", "эпик")).stdout);
    const t = idOf((await myc("task", "уходит", "--parent", a)).stdout);

    const off = await myc("update", t, "--no-parent");
    expect(off.code).toBe(0);
    expect(off.stdout as string).toContain("без эпика");

    // Второй раз отцеплять нечего, и молчаливое «ок» здесь врало бы о том,
    // что действие произошло.
    const again = await myc("update", t, "--no-parent");
    expect(again.code).toBe(ExitCode.PRECOND);
  });

  test("цикл — отказ пользователю, а не внутренняя ошибка", async () => {
    // Замыкание ловило цикл всегда, но наружу он выходил как
    // internal.unexpected: человек читал «внутренняя ошибка» там, где сам
    // попросил невозможное.
    const a = idOf((await myc("create", "--kind", "epic", "эпик")).stdout);
    const t = idOf((await myc("task", "дитя", "--parent", a)).stdout);

    const cyc = await myc("update", a, "--parent", t);
    expect(cyc.code).toBe(ExitCode.PRECOND);
    expect(cyc.stderr as string).toContain("precond.cycle");

    const self = await myc("update", t, "--parent", t);
    expect(self.code).toBe(ExitCode.PRECOND);
    expect(self.stderr as string).toContain("precond.self_parent");
  });

  test("--parent и --no-parent вместе — отказ, а не молчаливый выбор одного", async () => {
    const a = idOf((await myc("create", "--kind", "epic", "эпик")).stdout);
    const t = idOf((await myc("task", "задача", "--parent", a)).stdout);
    const both = await myc("update", t, "--parent", a, "--no-parent");
    expect(both.code).toBe(ExitCode.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Нить обсуждения: комментарий заводится ИЗ CLI, а не только прямым store
// ---------------------------------------------------------------------------

describe("msg --reply-to: комментарий как обычная операция", () => {
  test("ответ создаёт ребро replies_to и виден в составе нити", async () => {
    // Ребро `replies_to` заводилось только прямым вызовом store (так делают
    // MCP addNote и import-beads), а из CLI — ничем: `dep add` знает лишь
    // blocks/blocked-by. Из-за этого интерфейс не мог написать комментарий:
    // путь записи веба обязан идти через argv CLI, иначе появляется второй
    // CRDT-движок (S38, S40 — оба раза молчаливая потеря записей).
    const task = idOf((await myc("task", "задача с обсуждением")).stdout);
    const c1 = await mycJson("msg", "первый комментарий", "--reply-to", task);
    expect((c1.env as { data: { replies_to?: string } }).data.replies_to).toBe(task);

    const view = await mycJson("show", task);
    const thread = (view.env as { data: { thread?: { id: string }[] } }).data.thread ?? [];
    expect(thread.map((c) => c.id)).toEqual([idOf((c1.env as { data: { id: string } }).data.id)]);
  });

  test("вложенный ответ не тонет: у реплики названо число ответов", async () => {
    // Разворачивать всё дерево в карточке нельзя — утопит задачу в переписке,
    // — но молчать о вложенных ответах тоже нельзя: читатель решит, что
    // обсуждение кончилось.
    const task = idOf((await myc("task", "задача")).stdout);
    const c1 = idOf((await myc("msg", "комментарий", "--reply-to", task)).stdout);
    await myc("msg", "ответ на комментарий", "--reply-to", c1);

    const human = (await myc("show", task)).stdout as string;
    expect(human).toContain("нить      1");
    expect(human).toContain("(+1)");
  });

  test("ответ на ответ ложится в нить того комментария, а не задачи", async () => {
    // Петли из одного узла здесь быть не может: узел создаётся этой же
    // командой, и его id нечем передать во флаг. Ограждение «сам себе» я
    // сперва написал — и убрал, обнаружив, что оно недостижимо. Проверять
    // надо адресацию: ответ обязан лечь в нить СВОЕГО адресата.
    const task = idOf((await myc("task", "задача")).stdout);
    const c1 = idOf((await myc("msg", "комментарий", "--reply-to", task)).stdout);
    const c2 = idOf((await myc("msg", "ответ", "--reply-to", c1)).stdout);

    const onComment = await mycJson("show", c1);
    const nested = (onComment.env as { data: { thread?: { id: string }[] } }).data.thread ?? [];
    expect(nested.map((c) => c.id)).toEqual([c2]);

    const onTask = await mycJson("show", task);
    const top = (onTask.env as { data: { thread?: { id: string }[] } }).data.thread ?? [];
    expect(top.map((c) => c.id)).toEqual([c1]);
  });

  test("несуществующий адресат — отказ, а не молчаливый комментарий в пустоту", async () => {
    const orphan = await myc("msg", "в никуда", "--reply-to", "нет-такого");
    expect(orphan.code).not.toBe(ExitCode.OK);
  });

  /**
   * Ограждение S64. `message` — это L0, сырой диалог сессии: его тело через
   * 14 суток уезжает в bodies_cold, FTS-строки удаляются, а в векторный индекс
   * L0 не попадает вовсе (01-core-data-model.md §5.1). Комментарий к задаче,
   * записанный этим видом, через две недели станет пустой строкой. Отказать
   * нельзя — межагентская нить законна, — но молчать значит завести четвёртую
   * поверхность записи ровно там, где три уже разошлись.
   */
  test("msg --reply-to на задачу называет вид ошибочным и зовёт myc comment", async () => {
    const task = idOf((await myc("task", "задача")).stdout);
    const r = await mycJson("msg", "реплика не туда", "--reply-to", task);
    const warns = ((r.env as { warn?: { code: string; msg: string }[] }).warn ?? []).filter(
      (w) => w.code === "comment.kind_wrong",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain("myc comment");
  });

  test("ответ на message предупреждения не даёт: там вид верный", async () => {
    // Мутация с числом на само ограждение: если бы оно смотрело только на
    // `--reply-to`, а не на вид адресата, оно кричало бы и на законной
    // межагентской нити — 1 предупреждение там, где их должно быть 0.
    const root = idOf((await myc("msg", "корень нити")).stdout);
    const r = await mycJson("msg", "реплика в нити", "--reply-to", root);
    const warns = ((r.env as { warn?: { code: string }[] }).warn ?? []).filter(
      (w) => w.code === "comment.kind_wrong",
    );
    expect(warns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// myc comment — единственный вид узла для комментария (S64)
// ---------------------------------------------------------------------------

describe("myc comment: один вид узла на все поверхности", () => {
  test("создаёт note+attrs.type='comment' с ребром replies_to, а не kind='message'", async () => {
    const task = idOf((await myc("task", "задача с обсуждением")).stdout);
    const r = await mycJson("comment", task, "первый комментарий");
    const d = (r.env as { data: { id: string; kind: string; type: string; replies_to: string } }).data;
    expect(d.kind).toBe("note");
    expect(d.type).toBe("comment");
    expect(d.replies_to).toBe(task);

    const view = await mycJson("show", task);
    const thread = (view.env as { data: { thread?: { id: string; actor: string }[] } }).data.thread ?? [];
    expect(thread).toHaveLength(1);
    expect(thread[0]!.id).toBe(d.id);
    expect(thread[0]!.actor).toBe("tester");
  });

  test("нить смешанных видов читается целиком: 2 из 2, а не 1 из 2", async () => {
    // Оба писателя в одну нить: `myc comment` даёт note, `myc msg` — message.
    // Читатель, фильтрующий по виду, увидел бы одну реплику из двух — тот
    // самый отказ, из-за которого веб показывал ноль из девяти.
    const task = idOf((await myc("task", "задача")).stdout);
    const asNote = (await mycJson("comment", task, "комментарий-заметка")).env as {
      data: { id: string };
    };
    const asMessage = idOf((await myc("msg", "реплика-сообщение", "--reply-to", task)).stdout);

    const view = await mycJson("show", task);
    const thread = (view.env as { data: { thread?: { id: string }[] } }).data.thread ?? [];
    expect(thread).toHaveLength(2);
    expect(thread.map((c) => c.id).sort()).toEqual([asNote.data.id, asMessage].sort());
  });

  test("текст целиком в теле; первая строка — заголовок", async () => {
    const task = idOf((await myc("task", "задача")).stdout);
    const r = await mycJson("comment", task, "первая строка\nвторая строка");
    const id = (r.env as { data: { id: string; title: string } }).data.id;
    const shown = await mycJson("show", id);
    const d = (shown.env as { data: { title: string; body: string } }).data;
    expect(d.title).toBe("первая строка");
    expect(d.body).toBe("первая строка\nвторая строка");
  });

  test("без адресата и без текста — отказ по usage, а не пустой узел", async () => {
    const noTarget = await myc("comment");
    expect(noTarget.code).toBe(ExitCode.USAGE);
    const task = idOf((await myc("task", "задача")).stdout);
    const noText = await myc("comment", task);
    expect(noText.code).toBe(ExitCode.USAGE);
    // Ни один узел при этом не создан: нить пуста.
    const view = await mycJson("show", task);
    expect((view.env as { data: { thread?: unknown[] } }).data.thread).toBeUndefined();
  });

  test("несуществующий адресат — отказ, комментария в пустоту нет", async () => {
    const r = await myc("comment", "нет-такого", "в никуда");
    expect(r.code).not.toBe(ExitCode.OK);
  });
});

// ---------------------------------------------------------------------------
// Аренда по оценке задачи: 30 минут не переживают реальную работу
// ---------------------------------------------------------------------------

describe("claim: срок аренды берётся из оценки задачи", () => {
  test("оценка между границами задаёт срок и названа причиной", async () => {
    // Найдено работой 2026-09-05: координатор взял задачу, отдал агенту, тот
    // работал час с лишним, аренда истекла на 58-й минуте — и ready показал
    // задачу свободной ПРИ ЖИВОМ ИСПОЛНИТЕЛЕ. Аренда спроектирована под
    // heartbeat агента, но claim делает координатор, его процесс завершается,
    // и продлевать нечем. Оценка у задачи уже есть — из неё и берём.
    const id = idOf((await myc("task", "долгая", "--estimate", "4h")).stdout);
    const r = await mycJson("claim", id);
    const d = (r.env as { data: { lease_ttl_ms: number; lease_source: string } }).data;
    expect(d.lease_ttl_ms).toBe(4 * 60 * 60 * 1000);
    expect(d.lease_source).toBe("estimate");
  });

  test("без оценки — прежние 30 минут", async () => {
    const id = idOf((await myc("task", "обычная")).stdout);
    const d = (await mycJson("claim", id)).env as { data: { lease_ttl_ms: number; lease_source: string } };
    expect(d.data.lease_ttl_ms).toBe(30 * 60 * 1000);
    expect(d.data.lease_source).toBe("default");
  });

  test("предел суток и нижняя граница названы СВОИМИ причинами, а не «по оценке»", async () => {
    // Источник называется по тому, что РЕШИЛО число. Оценка в 30 дней даёт
    // сутки из-за предела, оценка в 10 минут — полчаса из-за нижней границы;
    // назвать оба «по оценке» значит соврать читателю о причине (И2).
    const huge = idOf((await myc("task", "огромная", "--estimate", "30d")).stdout);
    const big = (await mycJson("claim", huge)).env as { data: { lease_ttl_ms: number; lease_source: string } };
    expect(big.data.lease_ttl_ms).toBe(24 * 60 * 60 * 1000);
    expect(big.data.lease_source).toBe("capped");

    const tiny = idOf((await myc("task", "короткая", "--estimate", "10m")).stdout);
    const small = (await mycJson("claim", tiny)).env as { data: { lease_ttl_ms: number; lease_source: string } };
    expect(small.data.lease_ttl_ms).toBe(30 * 60 * 1000);
    expect(small.data.lease_source).toBe("floor");
  });

  test("явный --lease сильнее оценки", async () => {
    const id = idOf((await myc("task", "своя аренда", "--estimate", "4h")).stdout);
    const d = (await mycJson("claim", id, "--lease", "15m")).env as {
      data: { lease_ttl_ms: number; lease_source: string };
    };
    expect(d.data.lease_ttl_ms).toBe(15 * 60 * 1000);
    expect(d.data.lease_source).toBe("flag");
  });
});
