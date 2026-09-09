/**
 * Side-файлы базы из git worktree (memory-40dy12kkq6v2).
 *
 * Третье обращение к worktree, и первые два были про то, что всё хорошо: база
 * резолвится в основное дерево через общий git-dir, а конфиги харнесса `wire`
 * ставит в само worktree. Правило было, но применено не везде — эпизоды,
 * счётчик хуков и кеш выводили свой каталог из cwd и потому писались в ветку.
 * Человек удалял worktree — и уходила память о сессии, тогда как ЗАДАЧИ той
 * же сессии оставались в общей базе.
 *
 * Отсюда состав проверок: две стороны разведены и обе названы.
 *   ВОРКСПЕЙС (рядом с базой) — `episodes/`, `hooks.json`, кеш bootstrap;
 *   РАБОЧЕЕ ДЕРЕВО (cwd)      — конфиги харнесса и журнал их установки.
 *
 * Worktree здесь НАСТОЯЩИЙ (`git worktree add`), а не подделанный файл `.git`:
 * связь, по которой мы резолвим базу, создаёт сам git, и подделка проверяла бы
 * наше представление о ней, а не её саму. Главная проверка — эпизод переживает
 * `git worktree remove --force`, потому что именно это и терялось у заказчика.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand } from "../commands/tasks.ts";
import { createDoctorCommand } from "../commands/doctor.ts";
import { createWireCommand } from "../commands/wire.ts";
import { createBootstrapCommand } from "../commands/bootstrap.ts";
import { createAbsorbSessionCommand } from "./absorb-session.ts";
import { EPISODES_DIR } from "./episode.ts";
import { COUNTERS_FILE, type HookCounters } from "./counters.ts";
import { WIRE_JOURNAL } from "../commands/wire.ts";

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
  r.register(createAbsorbSessionCommand());
  r.register(createBootstrapCommand());
  const reg = r;
  reg.register(createWireCommand(reg));
  reg.register(createDoctorCommand(reg));
  return reg;
}

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry: makeRegistry(), env: { MYC_ACTOR: "tester" } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

/** Транскрипт с решением: пустой эпизод не пишется вовсе, а нам нужен файл. */
function makeTranscript(mark: string): string {
  const rows: unknown[] = [
    { type: "user", message: { role: "user", content: "поехали" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Решили: ${mark} — это и есть проверяемое решение.` }],
      },
    },
  ];
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** Файлы эпизодов в каталоге `.myc`; точечные — служебные, не эпизоды. */
function episodeFiles(mycDir: string): string[] {
  const path = join(mycDir, EPISODES_DIR);
  return existsSync(path) ? readdirSync(path).filter((f) => !f.startsWith(".")) : [];
}

function counters(mycDir: string): HookCounters["hooks"] {
  return (JSON.parse(readFileSync(join(mycDir, COUNTERS_FILE), "utf8")) as HookCounters).hooks;
}

let sandbox: string;
let home: string;
let main: string; // основное дерево: здесь база
let wt: string; // git worktree — каталог-СОСЕД, а не вложенный
let mainMyc: string;

beforeEach(async () => {
  // realpath: на macOS /tmp — симлинк на /private/tmp, а git пишет в .git
  // разрешённый путь. Без этого сравнивались бы два написания одного каталога.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-wtside-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "myc-home-")));
  process.env.MYC_HOME = home;

  main = join(sandbox, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "x\n");
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "init");

  mainMyc = join(main, ".myc");
  mkdirSync(mainMyc, { recursive: true });
  const raw = new Database(join(mainMyc, "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();

  wt = join(sandbox, "wt-feature");
  git(main, "worktree", "add", "-q", wt, "-b", "feature");
});

afterEach(() => {
  delete process.env.MYC_HOME;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function absorbIn(dir: string, mark: string): Promise<Record<string, unknown>> {
  const transcript = join(dir, `transcript-${mark}.jsonl`);
  writeFileSync(transcript, makeTranscript(mark));
  const r = await myc(dir, "absorb-session", "--transcript", transcript, "--agent", "claude", "--json");
  const env = JSON.parse(text(r.stdout)) as { ok: boolean; data: Record<string, unknown> };
  expect(env.ok).toBe(true);
  return env.data;
}

describe("эпизод из worktree принадлежит базе, а не ветке", () => {
  test("файл эпизода лежит рядом с базой основного дерева, а не в worktree", async () => {
    const data = await absorbIn(wt, "из-ветки");
    expect(data["episode"]).not.toBeNull();

    expect(episodeFiles(mainMyc)).toHaveLength(1);
    // Каталога `.myc` в самом worktree не должно появиться вовсе: базы там
    // нет, и всё, что ей принадлежит, туда попадать не имеет права.
    expect(existsSync(join(wt, ".myc", EPISODES_DIR))).toBe(false);
  });

  test("worktree удалён — эпизод и его узел на месте и видны из основного дерева", async () => {
    const data = await absorbIn(wt, "переживёт-удаление");
    const id = data["episode"] as string;
    const before = episodeFiles(mainMyc);
    expect(before).toHaveLength(1);

    // Ровно то, что делает человек: закончил ветку и убрал дерево.
    git(main, "worktree", "remove", "--force", wt);
    expect(existsSync(wt)).toBe(false);

    expect(episodeFiles(mainMyc)).toEqual(before);
    const db = new Database(join(mainMyc, "myc.db"), { readonly: true });
    try {
      const row = db.query("SELECT kind, attrs FROM nodes WHERE id = ?1").get(id) as
        | { kind: string; attrs: string }
        | null;
      expect(row?.kind).toBe("session");
      // Путь в узле относительный — значит он читается от каталога базы, и
      // после удаления ветки по нему лежит настоящий файл.
      const rel = (JSON.parse(row!.attrs) as Record<string, string>)["episode_path"]!;
      expect(existsSync(join(mainMyc, rel))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("эпизоды обоих деревьев складываются в один каталог, а не в два", async () => {
    await absorbIn(main, "из-основного");
    await absorbIn(wt, "из-ветки");
    expect(episodeFiles(mainMyc)).toHaveLength(2);
  });
});

describe("hooks.json — один на воркспейс", () => {
  test("срабатывание из worktree видно в doctor --hooks из основного дерева", async () => {
    await absorbIn(wt, "счётчик");

    expect(existsSync(join(wt, ".myc", COUNTERS_FILE))).toBe(false);
    expect(counters(mainMyc)["claude:pre-compact"]?.count).toBe(1);

    const r = await myc(main, "doctor", "--hooks", "--json");
    const env = JSON.parse(text(r.stdout)) as {
      data: { hooks: { hooks: Array<{ event: string; count?: number }> } };
    };
    const pre = env.data.hooks.hooks.find((h) => h.event === "pre-compact");
    expect(pre?.count).toBe(1);
  });

  test("счётчик не раздваивается: два дерева — одна сумма", async () => {
    await absorbIn(main, "раз");
    await absorbIn(wt, "два");
    expect(counters(mainMyc)["claude:pre-compact"]?.count).toBe(2);
  });
});

describe("рабочее дерево остаётся за собой: конфиги харнесса и журнал wire", () => {
  test("wire из worktree ставит конфиги в worktree, а не в основное дерево", async () => {
    const r = await myc(wt, "wire", "--agents", "claude");
    expect(r.code).toBe(0);

    expect(existsSync(join(wt, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(main, ".claude", "settings.json"))).toBe(false);
    // Журнал установки описывает файлы ЭТОГО дерева и лежит вместе с ними.
    expect(existsSync(join(wt, ".myc", WIRE_JOURNAL))).toBe(true);
    expect(existsSync(join(mainMyc, WIRE_JOURNAL))).toBe(false);
  });

  test("doctor --hooks в worktree берёт журнал из дерева, счётчик — из базы, и говорит об этом", async () => {
    await myc(wt, "wire", "--agents", "claude");
    await absorbIn(wt, "оба-источника");

    const r = await myc(wt, "doctor", "--hooks", "--json");
    const env = JSON.parse(text(r.stdout)) as {
      data: { hooks: { journal: boolean; countersDir: string; journalDir: string; split?: string } };
    };
    // Журнал есть — значит прочитан из worktree, где его и поставили.
    expect(env.data.hooks.journal).toBe(true);
    expect(env.data.hooks.countersDir).toBe(mainMyc);
    expect(env.data.hooks.journalDir).toBe(join(wt, ".myc"));
    // Два источника — и это названо вслух, а не смешано молча (И2).
    expect(env.data.hooks.split).toContain(mainMyc);
    expect(env.data.hooks.split).toContain(join(wt, ".myc"));
  });

  test("вне worktree источник один и лишней строки нет", async () => {
    await myc(main, "wire", "--agents", "claude");
    const r = await myc(main, "doctor", "--hooks", "--json");
    const env = JSON.parse(text(r.stdout)) as {
      data: { hooks: { countersDir: string; journalDir: string; split?: string } };
    };
    expect(env.data.hooks.countersDir).toBe(mainMyc);
    expect(env.data.hooks.journalDir).toBe(mainMyc);
    expect(env.data.hooks.split).toBeUndefined();
  });
});

describe("кеш bootstrap: лежит у базы, ключ — рабочее дерево", () => {
  test("файл кеша один и он рядом с базой, а не в ветке", async () => {
    const r = await myc(wt, "bootstrap");
    expect(r.code).toBe(0);
    expect(existsSync(join(mainMyc, "bootstrap.cache.json"))).toBe(true);
    expect(existsSync(join(wt, ".myc", "bootstrap.cache.json"))).toBe(false);
  });

  test("два дерева не вытесняют друг друга: у каждого свой ключ и свой хит", async () => {
    // Прогреваем оба дерева, потом повторяем — обе записи обязаны уцелеть.
    await myc(main, "bootstrap");
    await myc(wt, "bootstrap");

    const raw = JSON.parse(
      readFileSync(join(mainMyc, "bootstrap.cache.json"), "utf8"),
    ) as { trees: Record<string, { fp: string }> };
    expect(Object.keys(raw.trees).sort()).toEqual([main, wt].sort());
    // Отпечатки разные — в них входят пути самих деревьев; на одном ключе
    // эти две записи вытесняли бы друг друга на каждом старте сессии.
    expect(raw.trees[main]!.fp).not.toBe(raw.trees[wt]!.fp);

    for (const dir of [main, wt]) {
      const again = await myc(dir, "bootstrap", "--json");
      const env = JSON.parse(text(again.stdout)) as { data: { cache: string } };
      expect(env.data.cache).toBe("hit");
    }
  });

  test("строка ярусов называет каталог базы, а не cwd", async () => {
    const r = await myc(wt, "bootstrap");
    expect(text(r.stdout)).toContain(`project=${mainMyc}`);
    expect(text(r.stdout)).not.toContain(`project=${join(wt, ".myc")}`);
  });
});
