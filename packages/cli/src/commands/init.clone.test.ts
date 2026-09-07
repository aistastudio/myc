/**
 * Клон на второй машине (memory-hnh8r8304s27). Обмен знанием через git
 * ломался ровно здесь: `workspace.toml` коммитится и несёт общий слаг, а
 * существование воркспейса `init` определял по `myc.db`, которая в
 * `.gitignore`. Клон проваливался в эту щель — `init` переписывал общий
 * конфиг слагом из имени каталога, приехавшие узлы оставались со старым
 * scope и становились невидимыми ниоткуда.
 *
 * Тест — на настоящих каталогах и настоящем git: bare origin, два клона с
 * РАЗНЫМИ именами (иначе slugify даст один и тот же слаг и баг не
 * воспроизведётся), push из первого, clone вторым. «Файл не изменился»
 * проверяется `git status`, а не сравнением строк в памяти: переписать
 * конфиг тем же текстом — тоже допустимо, а вот дёрнуть git-статус общего
 * файла — нет.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createExportCommand } from "./export.ts";
import { createImportCommand } from "./import.ts";
import { createInitCommand } from "./init.ts";
import { createReadyCommand } from "./ready.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand } from "./remember.ts";
import { createTaskCommand } from "./tasks.ts";

let root: string;
let homeDir: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  r.register(createRememberCommand());
  r.register(createRecallCommand());
  r.register(createExportCommand());
  r.register(createImportCommand());
  return r;
}

beforeEach(() => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-clone-"));
  homeDir = mkdtempSync(join(tmpdir(), "myc-clone-home-"));
  process.env.MYC_HOME = homeDir;
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function mycJson(dir: string, ...args: string[]): Promise<{ code: number; env: Record<string, unknown> }> {
  const r = await myc(dir, ...args, "--json");
  expect(typeof r.stdout).toBe("string");
  return { code: r.code, env: JSON.parse(r.stdout as string) as Record<string, unknown> };
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!p.success) {
    throw new Error(`git ${args.join(" ")} в ${cwd}: ${p.stderr.toString()}`);
  }
  return p.stdout.toString();
}

function slugOf(dir: string): string | undefined {
  const path = join(dir, ".myc", "workspace.toml");
  if (!existsSync(path)) return undefined;
  return /^slug\s*=\s*"([a-z][a-z0-9]{1,7})"/m.exec(readFileSync(path, "utf8"))?.[1];
}

/** Bare origin + первый клон `alpha`, где знание создано и отправлено. */
async function originWithKnowledge(): Promise<{ origin: string; alpha: string; taskId: string }> {
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "-b", "main", origin);

  const alpha = join(root, "alpha");
  git(root, "clone", "-q", origin, alpha);
  git(alpha, "config", "user.email", "t@example.com");
  git(alpha, "config", "user.name", "t");

  expect((await myc(alpha, "init")).code).toBe(ExitCode.OK);
  const task = await myc(alpha, "task", "починить обмен через git", "-p", "P1");
  expect(task.code).toBe(ExitCode.OK);
  const taskId = text(task.stdout).split("\n")[0]!.split(/\s+/)[0]!;

  expect((await myc(alpha, "remember", "оплог едет в git, база остаётся локальной")).code).toBe(
    ExitCode.OK,
  );
  expect((await myc(alpha, "export")).code).toBe(ExitCode.OK);

  git(alpha, "add", "-A");
  git(alpha, "commit", "-q", "-m", "myc: первое знание");
  git(alpha, "push", "-q", "origin", "HEAD:main");
  return { origin, alpha, taskId };
}

/** Клон в каталог с ДРУГИМ именем — тот самый бытовой сценарий. */
function cloneAs(origin: string, name: string): string {
  const dir = join(root, name);
  git(root, "clone", "-q", origin, dir);
  git(dir, "config", "user.email", "t2@example.com");
  git(dir, "config", "user.name", "t2");
  return dir;
}

describe("клон в каталог с другим именем (memory-hnh8r8304s27)", () => {
  test("init + import: задачи и память видны, workspace.toml по git чист", async () => {
    const { origin, alpha, taskId } = await originWithKnowledge();
    const beta = cloneAs(origin, "beta-workstation");
    expect(slugOf(beta)).toBe(slugOf(alpha));

    const init = await myc(beta, "init");
    expect(init.code).toBe(ExitCode.OK);
    const imported = await myc(beta, "import");
    expect(imported.code).toBe(ExitCode.OK);

    // приёмка, главное: всё приехавшее знание ВИДНО. Проверяем это первым —
    // симптом бага именно такой, и мутация обязана краснеть на нём, а не на
    // косвенном признаке.
    const ready = await myc(beta, "ready");
    expect(ready.code).toBe(ExitCode.OK);
    expect(text(ready.stdout)).toContain(taskId);

    const recall = await myc(beta, "recall", "оплог");
    expect(recall.code).toBe(ExitCode.OK);
    expect(text(recall.stdout)).toContain("оплог едет в git");

    // приёмка: слаг не тронут, git-статус общего файла чист
    expect(slugOf(beta)).toBe(slugOf(alpha));
    expect(git(beta, "status", "--porcelain", ".myc/workspace.toml").trim()).toBe("");
    // и вообще ничего отслеживаемого не поехало: база и кеш проекций
    // закрыты .myc/.gitignore, который приехал тем же клоном
    expect(git(beta, "status", "--porcelain").trim()).toBe("");
  });

  test("init в клоне создаёт только недостающее: базу, но не конфиг", async () => {
    const { origin, alpha } = await originWithKnowledge();
    const beta = cloneAs(origin, "beta-workstation");
    expect(existsSync(join(beta, ".myc", "myc.db"))).toBe(false);

    const { code, env } = await mycJson(beta, "init");
    expect(code).toBe(ExitCode.OK);
    const data = env["data"] as Record<string, unknown>;
    // не «уже существует» (базы не было) и не «создал с нуля» (конфиг приехал)
    expect(data["adopted"]).toBe(true);
    expect(data["idempotent"]).toBe(false);
    // отчёт называет ту личность, под которой воркспейс реально работает,
    // а не ту, что вывелась бы из имени каталога
    expect(data["slug"]).toBe(slugOf(alpha));
    expect(data["slug"]).not.toBe("betawork");
    expect(existsSync(join(beta, ".myc", "myc.db"))).toBe(true);
    expect(git(beta, "status", "--porcelain", ".myc/workspace.toml").trim()).toBe("");

    // site_id у клона свой: иначе два участника писали бы в один оплог
    expect(typeof data["siteId"]).toBe("string");
    expect(data["siteId"] as string).not.toBe("");
  });

  test("import в клоне без базы поднимает её сам", async () => {
    const { origin, taskId } = await originWithKnowledge();
    const beta = cloneAs(origin, "gamma-laptop");
    expect(existsSync(join(beta, ".myc", "myc.db"))).toBe(false);

    const imported = await myc(beta, "import");
    expect(imported.code).toBe(ExitCode.OK);
    expect(existsSync(join(beta, ".myc", "myc.db"))).toBe(true);
    expect(git(beta, "status", "--porcelain", ".myc/workspace.toml").trim()).toBe("");

    const ready = await myc(beta, "ready");
    expect(text(ready.stdout)).toContain(taskId);
  });

  test("--force в клоне не меняет общий слаг и не стирает коммитнутый оплог", async () => {
    const { origin, alpha, taskId } = await originWithKnowledge();
    const beta = cloneAs(origin, "beta-workstation");
    await myc(beta, "init");
    await myc(beta, "import");

    const { code, env } = await mycJson(beta, "init", "--force");
    expect(code).toBe(ExitCode.OK);
    const data = env["data"] as Record<string, unknown>;
    expect(data["slug"]).toBe(slugOf(alpha));
    expect(data["slug"]).not.toBe("betawork");
    const warn = (env["warn"] ?? []) as { code: string }[];
    expect(warn.some((w) => w.code === "slug.changed")).toBe(false);
    expect(slugOf(beta)).toBe(slugOf(alpha));

    // --force пересоздаёт локальное состояние, а не общее знание: ни один
    // отслеживаемый файл не тронут, значит закоммитить обвал нечем
    expect(git(beta, "status", "--porcelain").trim()).toBe("");
    // и знание возвращается тем же import, а не пропадает у всех
    const again = await myc(beta, "import");
    expect(again.code).toBe(ExitCode.OK);
    const ready = await myc(beta, "ready");
    expect(text(ready.stdout)).toContain(taskId);
  });

  test("--force --slug: смена личности под --force тоже громкая", async () => {
    const { origin } = await originWithKnowledge();
    const beta = cloneAs(origin, "beta-workstation");
    await myc(beta, "init");

    const { env } = await mycJson(beta, "init", "--force", "--slug", "other");
    const warn = env["warn"] as { code: string; msg: string }[];
    expect(warn.some((w) => w.code === "slug.changed")).toBe(true);
    expect(slugOf(beta)).toBe("other");
  });
});

describe("границы автоподъёма базы в import", () => {
  test("--dry-run не создаёт базу: он обещал ничего не менять", async () => {
    const { origin } = await originWithKnowledge();
    const beta = cloneAs(origin, "delta-box");

    const dry = await myc(beta, "import", "--dry-run");
    expect(dry.code).toBe(ExitCode.NOWS);
    expect(existsSync(join(beta, ".myc", "myc.db"))).toBe(false);
  });

  test("каталог графа без workspace.toml: базы не будет, личность не выдумываем", async () => {
    const { origin } = await originWithKnowledge();
    const beta = cloneAs(origin, "epsilon-box");
    rmSync(join(beta, ".myc", "workspace.toml"));

    const imported = await myc(beta, "import");
    expect(imported.code).toBe(ExitCode.NOWS);
    expect(existsSync(join(beta, ".myc", "myc.db"))).toBe(false);
  });
});

describe("смена слага — явное действие с предупреждением", () => {
  test("--slug на живом воркспейсе меняет слаг, но громко и с числом узлов", async () => {
    const dir = join(root, "solo");
    git(root, "init", "-q", "-b", "main", dir);
    expect((await myc(dir, "init")).code).toBe(ExitCode.OK);
    expect((await myc(dir, "task", "задача перед сменой", "-p", "P1")).code).toBe(ExitCode.OK);

    const { code, env } = await mycJson(dir, "init", "--slug", "renamed");
    expect(code).toBe(ExitCode.OK);
    const warn = env["warn"] as { code: string; msg: string }[];
    const changed = warn.find((w) => w.code === "slug.changed");
    expect(changed).toBeDefined();
    // предупреждение обязано называть судьбу существующих узлов, а не просто
    // констатировать смену: «1 узел перестанет быть видимым»
    expect(changed!.msg).toMatch(/\bsolo\b/);
    expect(changed!.msg).toMatch(/\brenamed\b/);
    expect(changed!.msg).toMatch(/\d/);
    expect((env["meta"] as { degraded: string[] }).degraded).toContain("slug.changed");
    expect(slugOf(dir)).toBe("renamed");
  });

  test("конфиг потеряли, база жива: слаг восстанавливается из базы, а не из каталога", async () => {
    const dir = join(root, "solo");
    git(root, "init", "-q", "-b", "main", dir);
    await myc(dir, "init", "--slug", "chosen");
    rmSync(join(dir, ".myc", "workspace.toml"));

    const r = await myc(dir, "init");
    expect(r.code).toBe(ExitCode.OK);
    expect(slugOf(dir)).toBe("chosen");
  });

  test("без --slug слаг из конфига сильнее имени каталога и предупреждения нет", async () => {
    const dir = join(root, "solo");
    git(root, "init", "-q", "-b", "main", dir);
    await myc(dir, "init", "--slug", "chosen");
    expect(slugOf(dir)).toBe("chosen");

    const { env } = await mycJson(dir, "init");
    expect(slugOf(dir)).toBe("chosen");
    const warn = (env["warn"] ?? []) as { code: string }[];
    expect(warn.some((w) => w.code === "slug.changed")).toBe(false);
  });
});
