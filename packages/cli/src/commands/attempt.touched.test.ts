/**
 * Класс задачи по ФАКТУ (memory-1ax1pmk6mc3q) и один путь на файл
 * (memory-pj163pnxzy3a) — через публичный run() против настоящего git.
 *
 * Воспроизведение cherry в миниатюре: корень воркспейса — git-репозиторий,
 * внутри два самостоятельных (`svc`, `api`), у `svc` есть worktree ВНЕ
 * дерева. Проба git здесь НАСТОЯЩАЯ (снимок и дифф), а окружение, pid и
 * оркестратор — инертные: иначе тест записал бы сессию агента, который его
 * запустил.
 *
 * МУТАЦИИ ПРИЁМКИ (проверены руками, числа — в отчёте задачи):
 *   «пустой список путей»  — `touchedSince` отдаёт [] всегда: краснеют «факт
 *                            правки», «module и cross», «из вложенного и из
 *                            worktree» (класс остаётся `unknown`);
 *   «путь одного ключа»    — `anchorPathsOf` отдаёт `a.path` без `repo_id`:
 *                            краснеет «якорь из корня и из репозитория — один scope»;
 *   «грязь до старта»      — снимок не помнит грязного: краснеет «грязь до старта»;
 *   «дифф в каталоге финиша» — ключ без префикса репозитория: краснеют
 *                            «из вложенного и из worktree».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { Attribution, ensureSwarmSchema } from "@myc/swarm";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand } from "./anchor.ts";
import {
  anchorPathsOf,
  createAttemptCommand,
  inertProbe,
  realAttemptDeps,
  realProbe,
  taskClassOf,
} from "./attempt.ts";
import { createModelCommand } from "./roster.ts";
import { createCloseCommand, createTaskCommand, createUpdateCommand } from "./tasks.ts";

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (!p.success) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function put(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

function repo(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
}

let sandbox: string;
let ws: string;
let svc: string;
let wtSvc: string;
let seq = 0;

function registry(): Registry {
  const r = new Registry();
  // Настоящий git, инертный мир: см. шапку.
  const probe = { ...inertProbe, gitBase: realProbe.gitBase, touchedSince: realProbe.touchedSince };
  r.register(createAttemptCommand({ ...realAttemptDeps, probe }));
  r.register(createTaskCommand());
  r.register(createUpdateCommand());
  r.register(createCloseCommand());
  r.register(createModelCommand());
  r.register(createAnchorCommand());
  return r;
}

interface Envelope {
  ok: boolean;
  data: any;
  meta?: any;
  warn?: Array<{ code: string; msg: string }>;
  error?: { code: string; msg: string };
}

async function myc(dir: string, ...args: string[]): Promise<{ code: number; env: Envelope }> {
  const r = await run(["-C", dir, ...args, "--json"], {
    registry: registry(),
    env: { MYC_ACTOR: "tester", MYC_HOME: join(sandbox, "home") },
  });
  const out = typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
  return { code: r.code, env: JSON.parse(out) as Envelope };
}

async function ok(dir: string, ...args: string[]): Promise<any> {
  const r = await myc(dir, ...args);
  if (!r.env.ok) throw new Error(`${args.join(" ")} from ${dir}: ${JSON.stringify(r.env.error)}`);
  return r.env.data;
}

async function task(dir: string, title: string, ...extra: string[]): Promise<string> {
  return (await ok(dir, "task", `${title} #${++seq}`, ...extra)).id as string;
}

/** Попытка целиком: старт в `dir`, правки, финиш в `finishDir` (по умолчанию там же). */
async function attempt(
  dir: string,
  id: string,
  edit: () => void,
  finishDir: string = dir,
): Promise<any> {
  await ok(dir, "attempt", "start", id, "--model", "p/big");
  edit();
  return ok(finishDir, "attempt", "finish", "--task", id, "--verdict", "accepted");
}

function db(): Database {
  return new Database(join(ws, ".myc", "myc.db"));
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  delete process.env.MYC_MODEL;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-attempt-touched-")));
  mkdirSync(join(sandbox, "home"));
  ws = join(sandbox, "ws");
  repo(ws, {
    ".gitignore": ".myc/\n",
    "README.md": "root\n",
    "packages/core/a.ts": "a\n",
    "packages/core/b.ts": "b\n",
    "packages/core/c.ts": "c\n",
    "docs/guide.md": "guide\n",
  });
  svc = join(ws, "svc");
  repo(svc, { "x.ts": "x\n", "y.ts": "y\n", "lib/z.ts": "z\n" });
  repo(join(ws, "api"), { "h.ts": "h\n" });
  wtSvc = join(sandbox, "wt-svc");
  git(svc, "worktree", "add", "-q", "-b", "feat", wtSvc);

  mkdirSync(join(ws, ".myc"));
  const raw = new Database(join(ws, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  await ok(
    ws, "model", "add", "p/big", "--family", "big", "--harness", "claude",
    "--effort", "high", "--price-in", "3", "--price-out", "15",
  );
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("класс по факту на attempt finish", () => {
  test("факт правки: класс перестаёт быть unknown, класс на старте сохранён", async () => {
    const id = await task(ws, "Добавить опцию экспорта");
    const d = await attempt(ws, id, () => put(ws, "packages/core/a.ts", "a2\n"));
    expect(d).toMatchObject({
      taskClass: "feature:local",
      scopeSource: "touched",
      predictedClass: "feature:unknown",
      verdict: "accepted",
    });
    expect(d.run.filesTouched).toEqual(["packages/core/a.ts"]);
    expect(d.classSettled).toMatchObject({ from: "feature:unknown", to: "feature:local", changed: true });
  });

  test("module и cross — по каталогам верхнего уровня от корня воркспейса", async () => {
    const one = await task(ws, "Добавить кеш");
    const m = await attempt(ws, one, () => {
      put(ws, "packages/core/a.ts", "m-a\n");
      put(ws, "packages/core/b.ts", "m-b\n");
      put(ws, "packages/core/new.ts", "m-new\n");
    });
    expect(m.taskClass).toBe("feature:module");

    const two = await task(ws, "Добавить главу");
    const c = await attempt(ws, two, () => {
      put(ws, "packages/core/c.ts", "c-c\n");
      put(ws, "docs/guide.md", "c-guide\n");
    });
    expect(c.taskClass).toBe("feature:cross");
    expect(c.run.filesTouched).toEqual(["docs/guide.md", "packages/core/c.ts"]);
  });

  test("грязь до старта — не факт этой попытки", async () => {
    put(ws, "docs/guide.md", "несданная правка соседа\n");
    const id = await task(ws, "Добавить поле");
    const d = await attempt(ws, id, () => put(ws, "packages/core/a.ts", "own\n"));
    expect(d.run.filesTouched).toEqual(["packages/core/a.ts"]);
    expect(d.taskClass).toBe("feature:local");
  });

  test("из корня, из вложенного репозитория и из его worktree — один класс и одни пути", async () => {
    const fromRoot = await task(ws, "Добавить обработчик");
    const a = await attempt(ws, fromRoot, () => {
      put(svc, "x.ts", "root-x\n");
      put(svc, "lib/z.ts", "root-z\n");
    });

    const fromNested = await task(svc, "Добавить обработчик");
    const b = await attempt(svc, fromNested, () => {
      put(svc, "x.ts", "nested-x\n");
      put(svc, "lib/z.ts", "nested-z\n");
    });

    // Координатор финиширует из КОРНЯ, а работа шла в worktree агента:
    // дифф обязан считаться там, где стояла попытка.
    const fromWorktree = await task(wtSvc, "Добавить обработчик");
    const c = await attempt(
      wtSvc,
      fromWorktree,
      () => {
        put(wtSvc, "x.ts", "wt-x\n");
        put(wtSvc, "lib/z.ts", "wt-z\n");
      },
      ws,
    );

    for (const d of [a, b, c]) {
      expect(d.run.filesTouched).toEqual(["svc/lib/z.ts", "svc/x.ts"]);
      expect(d.taskClass).toBe("feature:module");
      expect(d.scopeSource).toBe("touched");
    }
  });

  test("из корня правка двух вложенных репозиториев — cross", async () => {
    const id = await task(ws, "Добавить сквозной заголовок");
    const d = await attempt(ws, id, () => {
      put(svc, "x.ts", "hdr\n");
      put(join(ws, "api"), "h.ts", "hdr\n");
    });
    expect(d.run.filesTouched).toEqual(["api/h.ts", "svc/x.ts"]);
    expect(d.taskClass).toBe("feature:cross");
  });

  test("окно нулевой длины — ключ unknown, а путь из текста остаётся только предсказанием", async () => {
    const named = await task(ws, "Добавить опцию", "-b", "Правка в packages/core/b.ts:1 и в примере other/x.ts");
    const d = await attempt(ws, named, () => {});
    expect(d.run.filesTouched).toEqual([]);
    // Пустой факт — «данных нет», а не local; текст ключом не становится (S67),
    // а несуществующий `other/x.ts` не попадает и в предсказание.
    expect(d).toMatchObject({
      taskClass: "feature:unknown",
      scopeSource: "none",
      predictedClass: "feature:local",
    });

    const silent = await task(ws, "Добавить опцию");
    const e = await attempt(ws, silent, () => {});
    expect(e).toMatchObject({
      taskClass: "feature:unknown",
      scopeSource: "none",
      predictedClass: "feature:unknown",
    });
  });

  test("объявленный руками класс факт не переписывает", async () => {
    const id = await task(ws, "Добавить отчёт");
    await ok(ws, "attempt", "start", id, "--model", "p/big", "--class", "feature:cross");
    put(ws, "packages/core/a.ts", "declared\n");
    const d = await ok(ws, "attempt", "finish", "--task", id, "--verdict", "accepted");
    expect(d.taskClass).toBe("feature:cross");
    expect(d.classSource).toBe("declared");
    expect(d.run.filesTouched).toEqual(["packages/core/a.ts"]);
  });

  test("attempt list: распределение по классам и по источнику класса", async () => {
    const a = await task(ws, "Добавить a");
    await attempt(ws, a, () => put(ws, "packages/core/a.ts", "l-a\n"));
    const b = await task(ws, "Добавить b");
    await attempt(ws, b, () => {});
    const r = await myc(ws, "attempt", "list");
    expect(r.env.meta).toMatchObject({
      count: 2,
      classes: { "feature:local": 1, "feature:unknown": 1 },
      classFrom: { touched: 1, none: 1 },
    });
  });
});

/**
 * memory-pj163pnxzy3a: у якоря на один файл два ключа — из корня
 * `('', 'svc/x.ts')`, из репозитория `('svc', 'x.ts')`. Класс задачи обязан
 * считаться по пути от корня воркспейса, одному на оба ключа.
 */
describe("якорь из корня и из вложенного репозитория", () => {
  test("один файл — один путь, откуда бы ни поставили якорь", async () => {
    const a = await task(ws, "Починить x из корня");
    await ok(ws, "anchor", "add", a, "svc/x.ts:1");
    const b = await task(svc, "Починить x из репозитория");
    await ok(svc, "anchor", "add", b, "x.ts:1");

    const d = db();
    try {
      const node = (id: string) => {
        const row = d.query("SELECT title, attrs FROM nodes WHERE id = ?1").get(id) as {
          title: string;
          attrs: string;
        };
        return { title: row.title, attrs: JSON.parse(row.attrs) };
      };
      expect(anchorPathsOf(node(a), d, a)).toEqual(["svc/x.ts"]);
      expect(anchorPathsOf(node(b), d, b)).toEqual(["svc/x.ts"]);
      expect(taskClassOf(node(a), d, a)).toBe(taskClassOf(node(b), d, b));
    } finally {
      d.close();
    }
  });

  test("якорь из корня и якорь из репозитория на два файла одного репозитория — один scope", async () => {
    const id = await task(ws, "Починить пару файлов");
    await ok(ws, "anchor", "add", id, "svc/x.ts:1");
    await ok(svc, "anchor", "add", id, "y.ts:1");
    const started = await ok(ws, "attempt", "start", id, "--model", "p/big");
    // Путь одного ключа дал бы `svc/x.ts` и `y.ts` — два каталога, «cross».
    expect(started).toMatchObject({ taskClass: "fix:module", scopeSource: "anchors" });
  });
});

describe("myc update --anchor", () => {
  test("привязывает якорь к существующей задаче, и класс берётся из него", async () => {
    const id = await task(ws, "Починить разбор");
    const r = await myc(ws, "update", id, "--anchor", "packages/core/a.ts:1");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.env.data.changed).toEqual(["anchor"]);
    expect(r.env.data.anchors[0]).toMatchObject({ path: "packages/core/a.ts", state: "fresh" });
    const started = await ok(ws, "attempt", "start", id, "--model", "p/big");
    expect(started).toMatchObject({ taskClass: "fix:local", scopeSource: "anchors" });
  });

  test("мусорный путь — отказ, и не записано ничего, даже соседние поля", async () => {
    const id = await task(ws, "Починить разбор");
    put(sandbox, "outside.ts", "вне корня\n");
    const cases: Array<[string, number, string]> = [
      ["packages/core/нет-такого.ts", ExitCode.NOTFOUND, "notfound.file"],
      ["packages/core", ExitCode.USAGE, "usage.invalid"],
      ["../outside.ts", ExitCode.USAGE, "usage.outside_repo"],
      ["", ExitCode.USAGE, "usage.invalid"],
    ];
    for (const [target, code, err] of cases) {
      const r = await myc(ws, "update", id, "--anchor", target, "--title", "не должно записаться");
      expect([target, r.code, r.env.error?.code]).toEqual([target, code, err]);
    }
    const d = db();
    try {
      expect(d.query("SELECT title FROM nodes WHERE id = ?1").get(id)).toMatchObject({
        title: expect.stringContaining("Починить разбор"),
      });
      expect(
        d.query("SELECT count(*) AS n FROM edges WHERE src = ?1 AND type = 'touches'").get(id),
      ).toEqual({ n: 0 });
    } finally {
      d.close();
    }
  });
});

/**
 * Пересчёт уже записанных попыток: меняется только ключ. Старая попытка
 * заводится прямо через домен — ровно так, как её записала бы версия до
 * миграции 9 (без источника scope и без снимка).
 */
describe("myc attempt reclass", () => {
  test("ключ пересчитан, исход и стоимость — байт в байт, объявленное и наивный дифф не в счёт", async () => {
    const named = await task(ws, "Добавить журнал", "-b", "Затрагивает packages/core/a.ts и packages/core/b.ts");
    const naive = await task(ws, "Добавить метрики");
    const declared = await task(ws, "Добавить экспорт", "-b", "packages/core/c.ts");

    const d = db();
    let rows: Array<Record<string, unknown>>;
    try {
      ensureSwarmSchema(d);
      const attr = new Attribution(d);
      const ids = [
        attr.startAttempt({ taskId: named, modelId: "p/big", taskClass: "feature:unknown" }).attemptId,
        attr.startAttempt({
          taskId: naive,
          modelId: "p/big",
          taskClass: "feature:unknown",
          run: { launch: { ...(await import("@myc/swarm")).EMPTY_LAUNCH }, gitHead: "abc" },
        }).attemptId,
        attr.startAttempt({
          taskId: declared,
          modelId: "p/big",
          taskClass: "feature:cross",
          classSource: "declared",
        }).attemptId,
      ];
      for (const id of ids) {
        attr.finishAttempt(id, { verdict: "accepted", caveats: ["tests_weak"], tokensIn: 10, tokensOut: 5 });
      }
      // Так их записала бы версия до миграции 9: ни предсказания, ни источника.
      d.query("UPDATE swarm_attempt SET predicted_class = NULL, scope_source = NULL").run();
      // Наивный список «всё грязное в дереве» — без снимка он не факт.
      attr.recordFilesTouched(ids[1]!, ["packages/core/a.ts", "docs/guide.md", "README.md"]);
      rows = d.query("SELECT * FROM swarm_attempt ORDER BY attempt_id").all() as Array<Record<string, unknown>>;
    } finally {
      d.close();
    }

    const dry = await ok(ws, "attempt", "reclass", "--dry-run");
    expect(dry).toMatchObject({ dryRun: true, scanned: 3, changed: 2, predictionsFilled: 3, declared: 1 });
    const d2 = db();
    try {
      expect(d2.query("SELECT * FROM swarm_attempt ORDER BY attempt_id").all()).toEqual(rows);
    } finally {
      d2.close();
    }

    const done = await ok(ws, "attempt", "reclass");
    expect(done).toMatchObject({
      changed: 2,
      predictionsFilled: 3,
      after: { "feature:unknown": 2, "feature:cross": 1 },
      classFrom: { none: 2, declared: 1 },
      predicted: { "feature:module": 1, "feature:unknown": 1, "feature:local": 1 },
      // Сравнимо одно: названный руками cross против предсказанного по тексту local.
      agreement: { compared: 1, sameScope: 0, sameClass: 0 },
    });
    const d3 = db();
    try {
      const after = d3.query("SELECT * FROM swarm_attempt ORDER BY attempt_id").all() as Array<
        Record<string, unknown>
      >;
      const byTask = new Map(after.map((r) => [r["task_id"], r]));
      // Путь из текста — предсказание, ключом он не становится (S67).
      expect(byTask.get(named)).toMatchObject({
        task_class: "feature:unknown",
        scope_source: "none",
        predicted_class: "feature:module",
      });
      expect(byTask.get(naive)).toMatchObject({
        task_class: "feature:unknown",
        scope_source: "none",
        predicted_class: "feature:unknown",
      });
      expect(byTask.get(declared)).toMatchObject({
        task_class: "feature:cross",
        scope_source: null,
        predicted_class: "feature:local",
      });
      for (const [i, r] of after.entries()) {
        for (const col of Object.keys(r)) {
          if (["task_class", "scope_source", "predicted_class"].includes(col)) continue;
          expect([col, r[col]]).toEqual([col, rows[i]![col]]);
        }
      }
    } finally {
      d3.close();
    }

    // Повтор — холостой: пересчитывать больше нечего.
    expect(await ok(ws, "attempt", "reclass")).toMatchObject({ changed: 0, predictionsFilled: 0 });
  });
});
