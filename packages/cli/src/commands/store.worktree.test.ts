/**
 * git worktree (memory-6amwnpb7tbat): один воркспейс на репозиторий.
 *
 * Воспроизведение заказчика дословно — НАСТОЯЩИЙ `git worktree add`, а не
 * подделанный файл `.git`: связь, которую мы читаем, создаёт сам git, и
 * подделка проверяла бы наше представление о ней, а не её саму.
 *
 * Проверяется четыре вещи: воркспейс основного дерева находится из worktree
 * и из его глубины; claim виден с обеих сторон; отказ НАЗЫВАЕТ причину и не
 * советует `myc init` там, где init расколол бы граф; охват репозитория (S59)
 * в worktree не уезжает. Плюс граница: submodule и обычный репозиторий не
 * должны приниматься за worktree, а подъём по каталогам (R1) обязан работать
 * там, где git'а нет вовсе.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { REPO_KEY } from "@myc/core";
import { findWorkspaceDb, readWorktreeLink } from "./store.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand, createClaimCommand } from "./tasks.ts";
import { createReadyCommand } from "./ready.ts";
import { createShowCommand } from "./show.ts";
import { createInitCommand } from "./init.ts";
import { createAnchorCommand, DIRTY_LOG } from "./anchor.ts";

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

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createTaskCommand());
  r.register(createClaimCommand());
  r.register(createReadyCommand());
  r.register(createShowCommand());
  r.register(createInitCommand());
  r.register(createAnchorCommand());
  return r;
}

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry: makeRegistry(), env: { MYC_ACTOR: "tester" } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

/** Охват узла прямо из базы: проверяем ЗАПИСАННОЕ, а не напечатанное. */
function storedRepo(dbPath: string, id: string): string | undefined {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const row = raw.query("SELECT attrs FROM nodes WHERE id = ?1").get(id) as
      | { attrs: string }
      | null;
    return (JSON.parse(row!.attrs) as Record<string, unknown>)[REPO_KEY] as string | undefined;
  } finally {
    raw.close();
  }
}

async function initWorkspace(dir: string): Promise<void> {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
}

let sandbox: string; // общий родитель: основное дерево и worktree — СОСЕДИ
let home: string;
let main: string; // основное дерево с .myc
let wt: string; // git worktree, каталог-сосед

beforeEach(() => {
  process.env.MYC_ACTOR = "tester";
  // realpath: на macOS /tmp — симлинк на /private/tmp, а git пишет в файл
  // .git разрешённый путь. Без этого тест сравнивал бы два написания одного
  // каталога и падал бы не на том, что проверяет.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-wt-")));
  home = mkdtempSync(join(tmpdir(), "myc-home-"));
  process.env.MYC_HOME = home;

  main = join(sandbox, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "x\n");
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "init");

  wt = join(sandbox, "wt-feature");
  git(main, "worktree", "add", "-q", wt, "-b", "feature");
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("readWorktreeLink: что считается worktree, а что нет", () => {
  test("настоящий worktree: файл .git → корень основного дерева", () => {
    const link = readWorktreeLink(wt);
    expect(link).toBeDefined();
    expect(link?.mainRoot).toBe(main);
    expect(link?.worktreeDir).toBe(wt);
    expect(link?.gitDir).toBe(join(main, ".git", "worktrees", "wt-feature"));
  });

  test("обычный репозиторий (.git — КАТАЛОГ) worktree не считается", () => {
    expect(readWorktreeLink(main)).toBeUndefined();
  });

  test("каталог без .git вовсе", () => {
    expect(readWorktreeLink(sandbox)).toBeUndefined();
  });

  test("submodule БЕЗ служебного каталога: форма пути не должна обмануть", () => {
    // Так выглядит подделка из fixture repo.test.ts:75 — файл `.git` есть,
    // каталога `.git/modules/x` нет. Фоллбэк по форме пути обязан отличить
    // `modules` от `worktrees`, иначе корнем «основного дерева» станет
    // произвольный каталог над `.git`.
    const fake = join(sandbox, "fake-sub");
    mkdirSync(fake);
    writeFileSync(join(fake, ".git"), "gitdir: ../.git/modules/x\n");
    expect(readWorktreeLink(fake)).toBeUndefined();
  });

  test("submodule: .git тоже файл, но commondir нет — не worktree", () => {
    const sub = join(sandbox, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main");
    writeFileSync(join(sub, "f"), "y\n");
    git(sub, "add", "f");
    git(sub, "commit", "-qm", "s");
    git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub");
    const nested = join(main, "vendor", "sub");
    // Признак именно тот, что описан в readWorktreeLink: .git — файл,
    // но ведёт в .git/modules/…, где никакого commondir нет.
    expect(existsSync(join(nested, ".git"))).toBe(true);
    expect(readWorktreeLink(nested)).toBeUndefined();
  });
});

describe("findWorkspaceDb: воркспейс основного дерева виден из worktree", () => {
  test("из корня worktree находится база основного дерева", async () => {
    await initWorkspace(main);
    const found = findWorkspaceDb(wt);
    expect("dbPath" in found).toBe(true);
    if ("dbPath" in found) {
      expect(found.dbPath).toBe(join(main, ".myc", "myc.db"));
      expect(found.wsDir).toBe(main);
      expect(found.worktree?.mainRoot).toBe(main);
    }
  });

  test("из глубины worktree — тоже (подъём внутри worktree сам по себе пуст)", async () => {
    await initWorkspace(main);
    const deep = join(wt, "packages", "cli", "src");
    mkdirSync(deep, { recursive: true });
    const found = findWorkspaceDb(deep);
    expect("dbPath" in found).toBe(true);
    if ("dbPath" in found) expect(found.wsDir).toBe(main);
  });

  test("СВОЙ .myc в worktree сильнее ссылки: подъём по каталогам идёт первым", async () => {
    await initWorkspace(main);
    await initWorkspace(wt);
    const found = findWorkspaceDb(wt);
    expect("dbPath" in found).toBe(true);
    if ("dbPath" in found) {
      expect(found.wsDir).toBe(wt);
      expect(found.worktree).toBeUndefined();
    }
  });

  test("основное дерево перенесли: причина названа, второй воркспейс не заводится", async () => {
    await initWorkspace(main);
    renameSync(main, join(sandbox, "main-moved"));
    const found = findWorkspaceDb(wt);
    expect("searched" in found).toBe(true);
    if ("searched" in found) {
      expect(found.worktreeMiss).toBe("main-missing");
      expect(found.worktree?.mainRoot).toBe(main);
    }
  });

  test("основное дерево на месте, но воркспейса нет и там: путь основного в списке", () => {
    const found = findWorkspaceDb(wt);
    expect("searched" in found).toBe(true);
    if ("searched" in found) {
      expect(found.worktreeMiss).toBe("main-no-workspace");
      expect(found.searched).toContain(join(main, ".myc", "myc.db"));
    }
  });

  test("R1 без git вообще: подъём по каталогам работает как прежде", async () => {
    const plain = join(sandbox, "plain");
    const nested = join(plain, "a", "b");
    mkdirSync(nested, { recursive: true });
    await initWorkspace(plain);
    const found = findWorkspaceDb(nested);
    expect("dbPath" in found).toBe(true);
    if ("dbPath" in found) {
      expect(found.wsDir).toBe(plain);
      expect(found.worktree).toBeUndefined();
    }
  });
});

describe("сквозная приёмка: очередь и claim общие для всех worktree", () => {
  test("ready из worktree показывает очередь основного дерева", async () => {
    await initWorkspace(main);
    const created = await myc(main, "task", "починить поиск", "-p", "P1");
    expect(created.code).toBe(0);

    const ready = await myc(wt, "ready");
    expect(ready.code).toBe(0);
    expect(text(ready.stdout)).toContain("починить поиск");
  });

  test("задача, заведённая в worktree, видна из основного дерева", async () => {
    await initWorkspace(main);
    const created = await myc(wt, "task", "из ветки", "-p", "P1");
    expect(created.code).toBe(0);

    const ready = await myc(main, "ready");
    expect(ready.code).toBe(0);
    expect(text(ready.stdout)).toContain("из ветки");
  });

  test("claim из worktree виден из основного дерева и обратно", async () => {
    await initWorkspace(main);
    const created = await myc(main, "task", "общая задача", "-p", "P1", "--json");
    const id = (JSON.parse(text(created.stdout)) as { data: { id: string } }).data.id;

    const claimed = await myc(wt, "claim", id);
    expect(claimed.code).toBe(0);

    // Из основного дерева задача уже занята: чужой claim обязан упереться в
    // ту же аренду, а не завести вторую истину на второй базе.
    const again = await myc(main, "claim", id, "--as", "другой");
    expect(again.code).toBe(4); // ExitCode.CONFLICT
    expect(again.stderr).toContain("tester");

    // И обратно: аренда, взятая в worktree, видна из основного дерева.
    const shown = await myc(main, "show", id);
    expect(text(shown.stdout)).toContain("tester");
    const ready = await myc(main, "ready");
    expect(text(ready.stdout)).not.toContain("общая задача");
  });
});

describe("отказы называют причину и не советуют раскол", () => {
  test("воркспейса нет нигде: подсказка ведёт в ОСНОВНОЕ дерево, не в worktree", async () => {
    const r = await myc(wt, "ready");
    expect(r.code).toBe(7); // ExitCode.NOWS
    expect(r.stderr).toContain("git worktree");
    expect(r.stderr).toContain(main);
    expect(r.stderr).toContain(`myc -C ${main} init`);
  });

  test("основное дерево недоступно: отдельный код и названная причина", async () => {
    await initWorkspace(main);
    renameSync(main, join(sandbox, "main-moved"));
    const r = await myc(wt, "ready");
    expect(r.code).toBe(7);
    expect(r.stderr).toContain("ws.worktree_main_missing");
    expect(r.stderr).toContain(main);
    expect(r.stderr).not.toContain("hint: myc init\n");
  });
});

describe("myc init в worktree: цель — основное дерево", () => {
  test("воркспейс уже есть в основном дереве: init не создаёт второй", async () => {
    await initWorkspace(main);
    const r = await myc(wt, "init");
    expect(r.code).toBe(0);
    expect(existsSync(join(wt, ".myc"))).toBe(false);
    expect(text(r.stdout)).toContain("git worktree");
    expect(text(r.stdout)).toContain(main);
  });

  test("воркспейса нет: init создаёт его в основном дереве, а не в worktree", async () => {
    const r = await myc(wt, "init");
    expect(r.code).toBe(0);
    expect(existsSync(join(main, ".myc", "myc.db"))).toBe(true);
    expect(existsSync(join(wt, ".myc"))).toBe(false);
    // и очередь после этого общая
    await myc(wt, "task", "первая", "-p", "P1");
    const ready = await myc(main, "ready");
    expect(text(ready.stdout)).toContain("первая");
  });

  test("основное дерево недоступно: отказ, а не молчаливый второй воркспейс", async () => {
    renameSync(main, join(sandbox, "main-moved"));
    const r = await myc(wt, "init");
    expect(r.code).toBe(5); // ExitCode.PRECOND
    expect(r.stderr).toContain("precond.worktree_main_missing");
    expect(existsSync(join(wt, ".myc"))).toBe(false);
  });

  test("в обычном репозитории init работает как прежде", async () => {
    const plain = join(sandbox, "plain");
    mkdirSync(plain);
    git(plain, "init", "-q", "-b", "main");
    const r = await myc(plain, "init");
    expect(r.code).toBe(0);
    expect(existsSync(join(plain, ".myc", "myc.db"))).toBe(true);
    expect(text(r.stdout)).not.toContain("git worktree");
  });
});

describe("охват репозитория (S59) в worktree не уезжает", () => {
  /**
   * Экосистема: воркспейс в `~/src/cherry`, внутри — репозиторий `collector`.
   * Форма первая — worktree СНАРУЖИ воркспейса; форма вторая — рядом с самим
   * репозиторием, внутри воркспейса. Обе обязаны дать охват `collector`.
   */
  async function ecosystem(): Promise<{ eco: string; repo: string }> {
    const eco = join(sandbox, "cherry");
    mkdirSync(eco);
    await initWorkspace(eco);
    const repo = join(eco, "collector");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "f"), "z\n");
    git(repo, "add", "f");
    git(repo, "commit", "-qm", "c");
    return { eco, repo };
  }

  test("worktree снаружи воркспейса: охват — имя основного дерева", async () => {
    const { eco, repo } = await ecosystem();
    const outside = join(sandbox, "wt-collector");
    git(repo, "worktree", "add", "-q", outside, "-b", "f1");

    const created = await myc(outside, "task", "из worktree", "-p", "P1", "--json");
    expect(created.code).toBe(0);
    const id = (JSON.parse(text(created.stdout)) as { data: { id: string } }).data.id;
    expect(storedRepo(join(eco, ".myc", "myc.db"), id)).toBe("collector");
  });

  test("worktree внутри воркспейса, рядом с репозиторием: тот же охват", async () => {
    const { eco, repo } = await ecosystem();
    const inside = join(eco, "wt-collector");
    git(repo, "worktree", "add", "-q", inside, "-b", "f2");

    const created = await myc(inside, "task", "соседний worktree", "-p", "P1", "--json");
    expect(created.code).toBe(0);
    const id = (JSON.parse(text(created.stdout)) as { data: { id: string } }).data.id;
    // Без пересчёта здесь был бы охват `wt-collector` — чужой для основного
    // дерева, и задача стала бы невидимой из `collector`.
    expect(storedRepo(join(eco, ".myc", "myc.db"), id)).toBe("collector");
    expect(repo).toBeDefined();
  });
});

describe("якоря из worktree: путь общий, содержимое своё", () => {
  /**
   * Якорь — путь плюс содержимое, и в worktree они расходятся. Путь обязан
   * лечь в граф таким же, как из основного дерева: он общий для всех веток.
   * Содержимое читается там, где агент работает, — иначе якорь на файл,
   * которого в основном дереве ещё нет, поставить было бы нельзя вовсе.
   */
  function anchorPaths(id: string): string[] {
    const raw = new Database(join(main, ".myc", "myc.db"), { readonly: true });
    try {
      return (
        raw
          .query("SELECT a.path AS p FROM anchors a JOIN edges g ON g.dst = a.node_id WHERE g.src = ?1")
          .all(id) as Array<{ p: string }>
      ).map((r) => r.p);
    } finally {
      raw.close();
    }
  }

  test("путь якоря — от корня репозитория, а не `../wt-feature/…`", async () => {
    // Файл есть только в основном дереве (создан после `worktree add`) —
    // читается его копия, путь всё равно репозиторный.
    await initWorkspace(main);
    mkdirSync(join(main, "src"), { recursive: true });
    writeFileSync(join(main, "src", "x.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const created = await myc(main, "task", "с якорем", "-p", "P1", "--json");
    const id = (JSON.parse(text(created.stdout)) as { data: { id: string } }).data.id;

    const added = await myc(wt, "anchor", "add", id, "src/x.ts:1-2");
    expect(added.code).toBe(0);
    expect(anchorPaths(id)).toEqual(["src/x.ts"]);
  });

  test("файл есть только в ветке: содержимое читается из worktree", async () => {
    await initWorkspace(main);
    const created = await myc(main, "task", "новый файл", "-p", "P1", "--json");
    const id = (JSON.parse(text(created.stdout)) as { data: { id: string } }).data.id;

    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "new.ts"), "export const n = 1;\n");
    expect(existsSync(join(main, "src", "new.ts"))).toBe(false);

    const added = await myc(wt, "anchor", "add", id, "src/new.ts:1");
    expect(added.code).toBe(0);
    expect(anchorPaths(id)).toEqual(["src/new.ts"]);
  });

  test("хук touch пишет в журнал основного дерева путь основного дерева", async () => {
    await initWorkspace(main);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "y.ts"), "x\n");
    const r = await myc(wt, "anchor", "touch", join(wt, "src", "y.ts"));
    expect(r.code).toBe(0);
    const log = readFileSync(join(main, ".myc", DIRTY_LOG), "utf8");
    expect(log.trim()).toBe(join(main, "src", "y.ts"));
  });
});
