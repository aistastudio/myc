/**
 * S65 на уровне CLI: `myc merge-driver` и `myc export` при столкновении
 * op_id. Семантику столкновения проверяет store-sqlite/oplog-collision.test.ts;
 * здесь — коды выхода, конверт и то, что настоящий `git merge`, вызывающий
 * НАСТОЯЩУЮ команду CLI (а не библиотеку напрямую), падает и оставляет
 * конфликт человеку.
 *
 * Копия каталога воркспейса (`cp -R`) уносила `site_id` живой базы: обе копии
 * продолжали нумеровать операции с одного `seq`, и разные операции приезжали
 * под одинаковыми op_id.
 *
 * После подключения перевыпуска (вторая половина S65) свежая копия так больше
 * не делает — она получает свой `site_id` при первом же открытии, и это
 * проверено здесь же, последним тестом. Столкновение осталось достижимым
 * ровно для копий, снятых ДО перехода: у них в `myc_meta` нет записи об
 * экземпляре, и такая база не перевыпускается, а усыновляется (иначе переход
 * раздробил бы `site_id` у всех существующих воркспейсов разом). Именно этот
 * случай и воспроизводит тест про `cp -R` — через `forgetInstance`, а не
 * подкруткой поведения.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand } from "./tasks.ts";
import { createExportCommand } from "./export.ts";
import { createInitCommand } from "./init.ts";
import { createMergeDriverCommand } from "./merge-driver.ts";
import { createImportCommand } from "./import.ts";
import { Database } from "bun:sqlite";

let root: string;
let registry: Registry;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "myc-test",
  GIT_AUTHOR_EMAIL: "myc@test",
  GIT_COMMITTER_NAME: "myc-test",
  GIT_COMMITTER_EMAIL: "myc@test",
  GIT_TERMINAL_PROMPT: "0",
};

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createTaskCommand());
  r.register(createExportCommand());
  r.register(createMergeDriverCommand());
  r.register(createImportCommand());
  return r;
}

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

function text(out: string | Iterable<string> | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : [...out].join("");
}

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} → ${r.code}\n${r.out}`);
  return r.out;
}

beforeEach(() => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-cli-collision-"));
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Сделать базу «дособытийной»: стереть запись о физическом экземпляре, как
 * будто воркспейс создан до S65. Такую базу `decideSiteId` усыновляет —
 * значит копия унесёт тот же `site_id`, и столкновение достижимо. Подделки
 * здесь нет: это ровно состояние всех воркспейсов, живших до перехода.
 */
function forgetInstance(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.query("DELETE FROM myc_meta WHERE key = 'site_instance'").run();
  } finally {
    db.close();
  }
}

function siteIdOf(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT value FROM myc_meta WHERE key='site_id'").get() as { value: string })
      .value;
  } finally {
    db.close();
  }
}

function nodeCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM nodes").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Строка оплога с заданным op_id и содержимым — материал столкновения. */
function line(opId: string, entityId: string, title: string): string {
  return JSON.stringify({
    op_id: opId,
    hlc: [1_700_000_000_000, 0],
    op: "set",
    entity: "node",
    entity_id: entityId,
    field: "title",
    value: title,
  });
}

describe("myc merge-driver: коллизия op_id", () => {
  test("код 4, conflict.op_id, сообщение называет op_id и файл, %A не переписан", async () => {
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    await myc(ws, "init");

    const dir = join(root, "merge");
    mkdirSync(dir);
    const ours = line("local-x-ncross:1825", "myc-aaaaaaaaaaaa", "copyA узел");
    const theirs = line("local-x-ncross:1825", "myc-bbbbbbbbbbbb", "copyB узел");
    writeFileSync(join(dir, "base"), "");
    writeFileSync(join(dir, "ours"), `${ours}\n`);
    writeFileSync(join(dir, "theirs"), `${theirs}\n`);
    const rel = ".myc/graph/oplog/local-x-ncross/00001.jsonl";

    const r = await myc(
      ws,
      "merge-driver",
      join(dir, "base"),
      join(dir, "ours"),
      join(dir, "theirs"),
      "7",
      rel,
      "--json",
    );
    expect(r.code).toBe(ExitCode.CONFLICT);
    const env = JSON.parse(text(r.stdout)) as {
      error?: { code: string; msg: string; hint?: string };
    };
    expect(env.error?.code).toBe("conflict.op_id");
    expect(env.error?.msg).toContain("local-x-ncross:1825");
    expect(env.error?.msg).toContain(rel);
    expect(env.error?.hint).toContain("S65");
    // Файл %A цел: git получает конфликт, а не «слитую» версию.
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe(`${ours}\n`);
  });

  test("те же строки без расхождения — код 0, объединение как раньше", async () => {
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    await myc(ws, "init");

    const dir = join(root, "merge");
    mkdirSync(dir);
    const one = line("local-x-ncross:1", "myc-aaaaaaaaaaaa", "узел");
    const two = line("local-x-ncross:2", "myc-bbbbbbbbbbbb", "второй");
    writeFileSync(join(dir, "base"), `${one}\n`);
    writeFileSync(join(dir, "ours"), `${one}\n`);
    writeFileSync(join(dir, "theirs"), `${one}\n${two}\n`);
    const r = await myc(
      ws,
      "merge-driver",
      join(dir, "base"),
      join(dir, "ours"),
      join(dir, "theirs"),
      "7",
      ".myc/graph/oplog/local-x-ncross/00000.jsonl",
    );
    expect(r.code).toBe(ExitCode.OK);
    expect(text(r.stdout)).toContain("+1 строк");
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe(`${one}\n${two}\n`);
  });

  test("нечитаемая строка — другая причина отказа, тот же код 4", async () => {
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    await myc(ws, "init");
    const dir = join(root, "merge");
    mkdirSync(dir);
    writeFileSync(join(dir, "base"), "");
    writeFileSync(join(dir, "ours"), "not json\n");
    writeFileSync(join(dir, "theirs"), "");
    const r = await myc(
      ws,
      "merge-driver",
      join(dir, "base"),
      join(dir, "ours"),
      join(dir, "theirs"),
      "--json",
    );
    expect(r.code).toBe(ExitCode.CONFLICT);
    const env = JSON.parse(text(r.stdout)) as { error?: { code: string } };
    expect(env.error?.code).toBe("conflict.oplog_line");
  });
});

describe("myc export: та же коллизия, обнаруженная до git", () => {
  test("экспорт в каталог с чужой операцией под нашим op_id падает и не пишет файлов", async () => {
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    await myc(ws, "init");
    await myc(ws, "task", "первая");
    await myc(ws, "export");

    // Подменяем ОДНУ строку в файле каталога: op_id тот же, содержимое чужое —
    // ровно это приезжает из ветки копии после `git pull` до `myc import`.
    const graph = join(ws, ".myc", "graph", "oplog");
    const siteDir = readdirSync(graph)[0]!;
    const file = join(graph, siteDir, "00000.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const opId = first["op_id"] as string;
    lines[0] = JSON.stringify({ ...first, value: "подменено чужой копией" });
    const poisoned = `${lines.join("\n")}\n`;
    writeFileSync(file, poisoned);

    const r = await myc(ws, "export", "--json");
    // Код тот же, что у драйвера слияния на том же событии: коллизия — это
    // состояние каталога, которое человек разбирает, а не сбой программы.
    // Проверяем именно код, а не «не ноль»: до маппинга здесь стоял
    // internal.unexpected, и «не ноль» его пропускал.
    expect(r.code).toBe(ExitCode.CONFLICT);
    const env = JSON.parse(text(r.stdout)) as { error?: { code: string; msg: string } };
    expect(env.error?.code).toBe("conflict.op_id");
    expect(env.error?.msg).toContain(opId);
    expect(env.error?.msg).toContain("коллизия op_id");
    // Каталог не тронут: подменённый файл остался ровно таким, каким был.
    expect(readFileSync(file, "utf8")).toBe(poisoned);
  });
});

/** Драйвер слияния как ОТДЕЛЬНЫЙ ПРОЦЕСС: та же команда, что у человека. */
function installDriver(root: string, repo: string): void {
  const shim = join(root, "driver.ts");
  writeFileSync(
    shim,
    [
      `import { run } from ${JSON.stringify(join(import.meta.dir, "..", "index.ts"))};`,
      `import { Registry } from ${JSON.stringify(join(import.meta.dir, "..", "registry.ts"))};`,
      `import { createMergeDriverCommand } from ${JSON.stringify(join(import.meta.dir, "merge-driver.ts"))};`,
      "const registry = new Registry();",
      "registry.register(createMergeDriverCommand());",
      "const r = await run(process.argv.slice(2), { registry, env: process.env });",
      'if (typeof r.stdout === "string") process.stdout.write(r.stdout);',
      'else if (r.stdout) for (const c of r.stdout) process.stdout.write(c);',
      'if (typeof r.stderr === "string") process.stderr.write(r.stderr);',
      "process.exit(r.code);",
      "",
    ].join("\n"),
  );
  gitOk(
    repo,
    "config",
    "merge.myc-oplog.driver",
    `${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} merge-driver %O %A %B %L %P`,
  );
}

describe("git merge зовёт настоящую команду myc merge-driver", () => {
  test("копия, снятая ДО S65 (без записи об экземпляре): merge падает, конфликт в дереве, обе версии целы", async () => {
    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    gitOk(root, "init", "-q", "-b", "main", proj);
    await myc(proj, "init");
    await myc(proj, "task", "база");
    await myc(proj, "export");
    gitOk(proj, "add", "-A");
    gitOk(proj, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "база");
    // До S65 записи об экземпляре не существовало — снимаем её ДО копирования,
    // чтобы обе копии унесли одну личность, как это и было раньше.
    forgetInstance(join(proj, ".myc", "myc.db"));

    const copyA = join(root, "copyA");
    const copyB = join(root, "copyB");
    cpSync(proj, copyA, { recursive: true });
    cpSync(proj, copyB, { recursive: true });

    for (const [dir, mark] of [
      [copyA, "copyA"],
      [copyB, "copyB"],
    ] as const) {
      for (let i = 0; i < 3; i++) await myc(dir, "task", `${mark} узел ${i}`);
      await myc(dir, "export");
      gitOk(dir, "add", "-A");
      gitOk(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `работа ${mark}`);
    }

    installDriver(root, copyA);
    gitOk(copyA, "remote", "add", "b", copyB);
    gitOk(copyA, "fetch", "-q", "b");
    const merged = git(copyA, "-c", "commit.gpgsign=false", "merge", "--no-edit", "b/main");

    expect(merged.code).not.toBe(0);
    expect(merged.out).not.toContain("+0 строк");
    expect(merged.out).toContain("КОЛЛИЗИЯ op_id");
    const unmerged = gitOk(copyA, "diff", "--name-only", "--diff-filter=U").trim();
    expect(unmerged).toContain("oplog/");
    // Обе стороны целы в индексе — ни одна операция не пропала.
    for (const path of unmerged.split("\n")) {
      expect(gitOk(copyA, "show", `:2:${path}`).length).toBeGreaterThan(0);
      expect(gitOk(copyA, "show", `:3:${path}`).length).toBeGreaterThan(0);
    }
    expect(gitOk(copyA, "show", `:2:${unmerged.split("\n")[0]!}`)).toContain("copyA узел");
    expect(gitOk(copyA, "show", `:3:${unmerged.split("\n")[0]!}`)).toContain("copyB узел");
  }, 60_000);

  /**
   * Тот же сценарий с ПОДКЛЮЧЁННЫМ перевыпуском — то, ради чего S65 и делался.
   * Проверяется через настоящий CLI, а не через `decideSiteId` напрямую:
   * перевыпуск обязан случиться сам, на первом же открытии копии.
   *
   * Три вопроса сразу, и все три — про потерю данных:
   *   merge код 0 и ни одного незамерженного файла — ветки больше не спорят;
   *   `myc import` даёт 11 = 5 + 3 + 3 — ни одна операция не проглочена;
   *   файл ОБЩЕГО ПРЕФИКСА под ПРЕЖНИМ site_id побайтово одинаков в обеих
   *   копиях — перевыпуск не переписывает уже выписанную историю, он только
   *   меняет, под чьим именем пишется дальнейшее.
   */
  test("cp -R копия после S65: merge код 0, узлов 11 = 5 + 3 + 3, общий префикс не переписан", async () => {
    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    gitOk(root, "init", "-q", "-b", "main", proj);
    await myc(proj, "init");
    for (let i = 0; i < 5; i++) await myc(proj, "task", `общий узел ${i}`);
    await myc(proj, "export");
    gitOk(proj, "add", "-A");
    gitOk(proj, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "база");

    const originSite = siteIdOf(join(proj, ".myc", "myc.db"));
    const prefixRel = join(".myc", "graph", "oplog", originSite, "00000.jsonl");
    const prefixBefore = readFileSync(join(proj, prefixRel));

    const copyA = join(root, "copyA");
    const copyB = join(root, "copyB");
    cpSync(proj, copyA, { recursive: true });
    cpSync(proj, copyB, { recursive: true });

    for (const [dir, mark] of [
      [copyA, "copyA"],
      [copyB, "copyB"],
    ] as const) {
      for (let i = 0; i < 3; i++) await myc(dir, "task", `${mark} узел ${i}`);
      await myc(dir, "export");
      gitOk(dir, "add", "-A");
      gitOk(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `работа ${mark}`);
    }

    // Каждая копия ушла на СВОЙ site_id, и оба отличаются от исходного.
    const siteA = siteIdOf(join(copyA, ".myc", "myc.db"));
    const siteB = siteIdOf(join(copyB, ".myc", "myc.db"));
    expect(siteA).not.toBe(originSite);
    expect(siteB).not.toBe(originSite);
    expect(siteA).not.toBe(siteB);

    // Общая история под ПРЕЖНИМ именем цела и одинакова с обеих сторон.
    expect(readFileSync(join(copyA, prefixRel))).toEqual(prefixBefore);
    expect(readFileSync(join(copyB, prefixRel))).toEqual(prefixBefore);

    installDriver(root, copyA);
    gitOk(copyA, "remote", "add", "b", copyB);
    gitOk(copyA, "fetch", "-q", "b");
    const merged = git(copyA, "-c", "commit.gpgsign=false", "merge", "--no-edit", "b/main");
    expect(merged.out).not.toContain("КОЛЛИЗИЯ op_id");
    expect(merged.code).toBe(0);
    expect(gitOk(copyA, "diff", "--name-only", "--diff-filter=U").trim()).toBe("");

    const imported = await myc(copyA, "import");
    expect(imported.code).toBe(ExitCode.OK);
    expect(nodeCount(join(copyA, ".myc", "myc.db"))).toBe(11);
  }, 60_000);
});
