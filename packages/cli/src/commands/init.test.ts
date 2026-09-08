/**
 * `myc init` — воркспейс в одну команду (§3.1, §11). Против настоящего
 * bun:sqlite во временных директориях, без сети: ничего в этом файле не
 * достаёт из интернета, а `git`/`graft` — локальные бинари среды, которые
 * либо есть в PATH, либо детект тихо это отмечает.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createExportCommand } from "./export.ts";
import { createInitCommand } from "./init.ts";
import { createReadyCommand } from "./ready.ts";
import { createRememberCommand } from "./remember.ts";
import { createClaimCommand, createTaskCommand } from "./tasks.ts";

let dir: string;
let homeDir: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createTaskCommand());
  r.register(createReadyCommand());
  r.register(createClaimCommand());
  r.register(createExportCommand());
  r.register(createRememberCommand());
  return r;
}

beforeEach(() => {
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-init-"));
  // MYC_HOME (S41) — переопределяет ~/.myc на время теста, та же конвенция,
  // что MYC_ACTOR: реальный домашний каталог пользователя не трогается.
  homeDir = mkdtempSync(join(tmpdir(), "myc-init-home-"));
  process.env.MYC_HOME = homeDir;
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function myc(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", cwd, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function mycJson(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; env: Record<string, unknown> }> {
  const r = await myc(cwd, ...args, "--json");
  expect(typeof r.stdout).toBe("string");
  return { code: r.code, env: JSON.parse(r.stdout as string) as Record<string, unknown> };
}

describe("init: пустой каталог без сети", () => {
  test("создаёт .myc/, накатывает миграции, пишет site_id и slug", async () => {
    const r = await myc(dir, "init");
    expect(r.code).toBe(ExitCode.OK);
    expect(existsSync(join(dir, ".myc", "myc.db"))).toBe(true);
    expect(existsSync(join(dir, ".myc", "workspace.toml"))).toBe(true);

    const toml = readFileSync(join(dir, ".myc", "workspace.toml"), "utf8");
    expect(toml).toMatch(/^slug = "[a-z][a-z0-9]{1,7}"$/m);

    const { code, env } = await mycJson(dir, "init");
    // повторный вызов без --force не должен пересоздавать; проверяем через
    // прямой конверт первого вызова ниже, здесь просто убеждаемся, что init
    // сам по себе не падает при повторе (идемпотентность — отдельный тест).
    expect(code).toBe(ExitCode.OK);
    expect(env["ok"]).toBe(true);
  });

  test("ровно один JSON-конверт", async () => {
    const r = await myc(dir, "init", "--json");
    const text = r.stdout as string;
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(1);
    const env = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(env["ok"]).toBe(true);
    expect(typeof env["data"]).toBe("object");
  });

  test("после init сразу работают task/ready/claim", async () => {
    const init = await myc(dir, "init");
    expect(init.code).toBe(ExitCode.OK);

    const task = await myc(dir, "task", "Первая задача", "-p", "P1");
    expect(task.code).toBe(ExitCode.OK);
    const id = (task.stdout as string).split(/\s+/)[0]!;
    expect(id).toMatch(/^[a-z][a-z0-9]{1,7}-/);

    const ready = await myc(dir, "ready");
    expect(ready.code).toBe(ExitCode.OK);
    expect(ready.stdout as string).toContain(id);

    const claim = await myc(dir, "claim", id);
    expect(claim.code).toBe(ExitCode.OK);
    expect(claim.stdout as string).toContain(id);
  });

  test("время работы репортится числом", async () => {
    const { env } = await mycJson(dir, "init");
    const data = env["data"] as Record<string, unknown>;
    expect(typeof data["took_ms"]).toBe("number");
    expect(data["took_ms"] as number).toBeGreaterThan(0);
  });

  test("модель эмбеддингов не качается; деградация видна одной строкой в warn/meta.degraded", async () => {
    const { env } = await mycJson(dir, "init");
    expect(env["warn"]).toBeDefined();
    const warn = env["warn"] as { code: string; msg: string }[];
    expect(warn.some((w) => w.code === "degraded.embeddings")).toBe(true);
    const meta = env["meta"] as { degraded: string[] };
    expect(meta.degraded).toContain("degraded.embeddings");
  });
});


// ---------------------------------------------------------------------------
// Код-интеллект (S52, docs/design/05-code-intelligence.md §6.2, §6.3, §12.1)
// ---------------------------------------------------------------------------

describe("init: выбранная реализация код-интеллекта", () => {
  /** PATH без graft: детект обязан не найти бинарь, что бы ни стояло на машине. */
  async function withoutGraft<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "myc-init-nopath-"));
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  }

  test("умолчание builtin: init пишет ключ в workspace.toml и печатает реализацию", async () => {
    const r = await myc(dir, "init");
    expect(r.code).toBe(ExitCode.OK);
    expect(readFileSync(join(dir, ".myc", "workspace.toml"), "utf8")).toContain(
      'code_intel = "builtin"',
    );
    expect(r.stdout as string).toContain("код-интеллект");
    expect(r.stdout as string).toContain("builtin");
  });

  test("выбор виден в JSON и на свежем init, и на повторном", async () => {
    const first = await mycJson(dir, "init");
    const a = (first.env["data"] as Record<string, unknown>)["code_intel"] as Record<string, unknown>;
    expect(a).toMatchObject({ mode: "builtin", id: "builtin", state: "ok" });

    const second = await mycJson(dir, "init");
    const b = (second.env["data"] as Record<string, unknown>)["code_intel"] as Record<
      string,
      unknown
    >;
    expect(b).toMatchObject({ mode: "builtin", id: "builtin", state: "ok" });
  });

  test("graft не найден → builtin, и это не деградация: встроенная реализация обязательна", async () => {
    const { env } = await withoutGraft(() => mycJson(dir, "init"));
    const data = env["data"] as Record<string, unknown>;
    expect(data["graft"]).toBe(false);
    expect((data["code_intel"] as Record<string, unknown>)["id"]).toBe("builtin");
    const meta = env["meta"] as { degraded: string[] };
    // про сам graft говорим, но builtin деградацией не помечаем
    expect(meta.degraded).toContain("degraded.graft");
    expect(meta.degraded).not.toContain("code_intel_builtin");
  });

  test("code_intel=graft без graft: громко missing, а НЕ молчаливый откат к builtin", async () => {
    const { env } = await withoutGraft(async () => {
      await myc(dir, "init");
      writeFileSync(join(dir, ".myc", "config.json"), JSON.stringify({ code_intel: "graft" }));
      return mycJson(dir, "init");
    });
    const data = env["data"] as Record<string, unknown>;
    const ci = data["code_intel"] as Record<string, unknown>;
    expect(ci["id"]).toBe("graft");
    expect(ci["id"]).not.toBe("builtin");
    expect(ci["state"]).toBe("missing");
    const meta = env["meta"] as { degraded: string[] };
    expect(meta.degraded).toContain("code_intel_missing");
    const warn = env["warn"] as { code: string; msg: string }[];
    expect(warn.some((w) => w.code === "code_intel_missing")).toBe(true);
  });

  test("code_intel=auto без graft: builtin, но с кодом code_intel_builtin", async () => {
    const { env } = await withoutGraft(async () => {
      await myc(dir, "init");
      writeFileSync(join(dir, ".myc", "config.json"), JSON.stringify({ code_intel: "auto" }));
      return mycJson(dir, "init");
    });
    const ci = (env["data"] as Record<string, unknown>)["code_intel"] as Record<string, unknown>;
    expect(ci["id"]).toBe("builtin");
    expect((env["meta"] as { degraded: string[] }).degraded).toContain("code_intel_builtin");
  });

  test("кеш детекта .myc/state.json не коммитится", async () => {
    await myc(dir, "init");
    expect(readFileSync(join(dir, ".myc", ".gitignore"), "utf8")).toContain("state.json");
  });
});

describe("init: .myc/.gitignore (myc-qie.11)", () => {
  test("свежий init пишет .myc/.gitignore, исключающий базу и кеш проекций", async () => {
    const r = await myc(dir, "init");
    expect(r.code).toBe(ExitCode.OK);

    const path = join(dir, ".myc", ".gitignore");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    const lines = new Set(text.split("\n").map((l) => l.trim()));
    expect(lines.has("myc.db")).toBe(true);
    expect(lines.has("myc.db-wal")).toBe(true);
    expect(lines.has("myc.db-shm")).toBe(true);
    expect(lines.has("myc.db-journal")).toBe(true);
    expect(lines.has("projections/")).toBe(true);
  });

  test("повторный init не дублирует строки и не затирает пользовательские", async () => {
    await myc(dir, "init");
    const path = join(dir, ".myc", ".gitignore");
    const before = readFileSync(path, "utf8");
    const customized = `${before}my-custom-note.txt\n`;
    Bun.write(path, customized);

    const second = await myc(dir, "init");
    expect(second.code).toBe(ExitCode.OK);

    const after = readFileSync(path, "utf8");
    expect(after).toContain("my-custom-note.txt");
    const lines = after.split("\n").filter((l) => l.trim() === "myc.db");
    expect(lines.length).toBe(1);
  });

  test("существующий воркспейс без .myc/.gitignore получает его при следующем init", async () => {
    await myc(dir, "init");
    const path = join(dir, ".myc", ".gitignore");
    rmSync(path, { force: true });
    expect(existsSync(path)).toBe(false);

    const second = await myc(dir, "init");
    expect(second.code).toBe(ExitCode.OK);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("myc.db");
  });

  test("в чистом репозитории без корневого .gitignore git add -A забирает только оплог/meta/gitattributes/workspace.toml", async () => {
    Bun.spawnSync(["git", "init"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.email", "t@example.com"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: dir });

    const init = await myc(dir, "init");
    expect(init.code).toBe(ExitCode.OK);

    for (let i = 0; i < 3; i++) {
      const task = await myc(dir, "task", `задача ${i}`, "-p", "P2");
      expect(task.code).toBe(ExitCode.OK);
    }

    const exportRes = await myc(dir, "export");
    expect(exportRes.code).toBe(ExitCode.OK);

    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir });
    const staged = status.stdout
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.slice(3));

    for (const path of staged) {
      const okPrefixes = [
        ".myc/graph/oplog/",
        ".myc/graph/meta.json",
        ".myc/graph/.gitattributes",
        ".myc/workspace.toml",
        ".myc/.gitignore",
      ];
      expect(okPrefixes.some((p) => path.startsWith(p))).toBe(true);
    }
    expect(staged.some((p) => p.includes("myc.db"))).toBe(false);
    expect(staged.some((p) => p.includes("projections"))).toBe(false);
  });
});

describe("init: идемпотентность", () => {
  test("повторный init не ломает воркспейс и не пересоздаёт", async () => {
    const first = await myc(dir, "init");
    expect(first.code).toBe(ExitCode.OK);
    const dbBefore = readFileSync(join(dir, ".myc", "myc.db"));

    const second = await myc(dir, "init");
    expect(second.code).toBe(ExitCode.OK);
    expect(second.stdout as string).toContain("уже существует");

    const dbAfter = readFileSync(join(dir, ".myc", "myc.db"));
    expect(Buffer.compare(dbBefore, dbAfter)).toBe(0);
  });

  test("--force стирает и пересоздаёт", async () => {
    await myc(dir, "init");
    const task = await myc(dir, "task", "будет стёрта", "-p", "P2");
    expect(task.code).toBe(ExitCode.OK);

    const forced = await myc(dir, "init", "--force");
    expect(forced.code).toBe(ExitCode.OK);

    const ready = await myc(dir, "ready");
    expect(ready.stdout as string).not.toContain("будет стёрта");
  });
});

describe("init: git-корень", () => {
  test("в подкаталоге git-репозитория находит корень", async () => {
    const gitInit = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    if (!gitInit.success) {
      // среды без git — детект gracefully не находит корень, не наш баг
      return;
    }
    const sub = join(dir, "src", "nested");
    mkdirSync(sub, { recursive: true });

    const r = await myc(sub, "init");
    expect(r.code).toBe(ExitCode.OK);
    expect(existsSync(join(dir, ".myc", "myc.db"))).toBe(true);
    expect(existsSync(join(sub, ".myc"))).toBe(false);
  });

  test("не git-репозиторий — всё равно создаёт воркспейс и предупреждает", async () => {
    const { env } = await mycJson(dir, "init");
    const warn = env["warn"] as { code: string; msg: string }[];
    expect(warn.some((w) => w.code === "degraded.git")).toBe(true);
  });
});

describe("init: без сети в пустом каталоге", () => {
  test("не требует MYC_ACTOR/сети, отрабатывает с дефолтами", async () => {
    delete process.env.MYC_ACTOR;
    const r = await run(["-C", dir, "init"], { registry, env: {} });
    expect(r.code).toBe(ExitCode.OK);
    process.env.MYC_ACTOR = "tester";
  });
});

describe("init: личный ярус ~/.myc (S41)", () => {
  test("обычный `myc init` НЕ создаёт ~/.myc и сообщает, что его нет", async () => {
    const { env } = await mycJson(dir, "init");
    const data = env["data"] as { personal: { exists: boolean; dir: string } };
    expect(data.personal.exists).toBe(false);
    expect(existsSync(join(homeDir, ".myc"))).toBe(false);

    const human = await myc(dir, "init", "--force");
    expect(human.stdout as string).toContain("myc init --global");
  });

  test("`myc init --global` создаёт ~/.myc отдельно от проектного .myc/", async () => {
    const r = await myc(dir, "init", "--global");
    expect(r.code).toBe(ExitCode.OK);
    expect(existsSync(join(homeDir, ".myc", "myc.db"))).toBe(true);
    // проектный воркспейс никак не задет
    expect(existsSync(join(dir, ".myc"))).toBe(false);
  });

  test("после `myc init --global` обычный `myc init` видит и сообщает о нём", async () => {
    await myc(dir, "init", "--global");
    const { env } = await mycJson(dir, "init");
    const data = env["data"] as { personal: { exists: boolean } };
    expect(data.personal.exists).toBe(true);

    const human = await myc(dir, "init", "--force");
    expect(human.stdout as string).toContain("личный ~/.myc");
  });

  test("повторный `myc init --global` идемпотентен, не пересоздаёт базу", async () => {
    const first = await myc(dir, "init", "--global");
    expect(first.code).toBe(ExitCode.OK);
    const dbBefore = readFileSync(join(homeDir, ".myc", "myc.db"));

    const second = await myc(dir, "init", "--global");
    expect(second.code).toBe(ExitCode.OK);
    expect(second.stdout as string).toContain("уже существует");
    // Про разрушительный флаг человек узнаёт здесь, а не упёршись в отказ.
    expect(second.stdout as string).toContain("--wipe-memory");

    const dbAfter = readFileSync(join(homeDir, ".myc", "myc.db"));
    expect(Buffer.compare(dbBefore, dbAfter)).toBe(0);
  });
});

/**
 * `myc init --global --force` — разрушительная команда над тем, чего нет в
 * git (memory-2shvpjay4nx6).
 *
 * Проектный `--force` защищён тем, что `.myc/graph` и `workspace.toml`
 * коммитятся: стёртое возвращается из репозитория. У личного яруса такого
 * дна нет — стёртая память не возвращается ниоткуда. Поэтому проверяется не
 * код возврата, а ФАКТ на диске: байты базы, число узлов и операций оплога,
 * состав каталога. Команда, которая «отказалась», но успела снести кеш, —
 * это не отказ.
 */
describe("init --global --force: личная память не стирается молча", () => {
  /** Личный ярус с настоящей записью внутри — то, что нельзя потерять. */
  async function personalWithMemory(): Promise<{ ops: number; nodes: number }> {
    const created = await myc(dir, "init", "--global");
    expect(created.code).toBe(ExitCode.OK);
    const r = await myc(dir, "remember", "--global", "рабочий день начинаю с myc ready");
    expect(r.code).toBe(ExitCode.OK);
    const counts = personalCounts();
    expect(counts.ops).toBeGreaterThan(0);
    expect(counts.nodes).toBeGreaterThan(0);
    return counts;
  }

  /**
   * Слепок ВСЕГО каталога, а не только myc.db: свежие записи лежат в `-wal`
   * до чекпойнта, и сравнение одного файла базы прошло бы даже там, где
   * память успели потерять.
   */
  function personalSnapshot(): string {
    const root = join(homeDir, ".myc");
    const parts: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const next = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next);
        else parts.push(`${next}:${Bun.SHA256.hash(readFileSync(join(root, next))).toString()}`);
      }
    };
    walk("");
    return parts.join("\n");
  }

  /** Личность сайта в оплоге: по ней видно, та же это база или новая. */
  function personalSite(): string | undefined {
    const db = new Database(join(homeDir, ".myc", "myc.db"), { readonly: true });
    try {
      return (db.query("SELECT value FROM myc_meta WHERE key = 'site_id'").get() as
        | { value: string }
        | null)?.value;
    } finally {
      db.close();
    }
  }

  function personalCounts(): { ops: number; nodes: number } {
    const db = new Database(join(homeDir, ".myc", "myc.db"), { readonly: true });
    try {
      const ops = (db.query("SELECT count(*) AS n FROM oplog").get() as { n: number }).n;
      const nodes = (db.query("SELECT count(*) AS n FROM nodes").get() as { n: number }).n;
      return { ops, nodes };
    } finally {
      db.close();
    }
  }

  test("--force при непустой памяти: отказ, и на диске НИЧЕГО не изменилось", async () => {
    const before = await personalWithMemory();
    // Кеш проекций рядом с базой: он восстановим, и именно поэтому соблазн
    // «раз уж отказываем, кеш всё-таки снесём» надо закрыть тестом.
    mkdirSync(join(homeDir, ".myc", "projections"), { recursive: true });
    writeFileSync(join(homeDir, ".myc", "projections", "nodes.jsonl"), "{}\n");
    const snapshotBefore = personalSnapshot();

    const r = await myc(dir, "init", "--global", "--force");

    expect(r.code).toBe(ExitCode.PRECOND);
    const after = personalCounts();
    expect(after.ops).toBe(before.ops);
    expect(after.nodes).toBe(before.nodes);
    // Побайтно: каждый файл каталога, включая -wal со свежими записями.
    expect(personalSnapshot()).toBe(snapshotBefore);
    expect(readFileSync(join(homeDir, ".myc", "projections", "nodes.jsonl"), "utf8")).toBe("{}\n");
  });

  test("отказ не тупик: в нём и цифры потери, и копия, и способ всё-таки стереть", async () => {
    const before = await personalWithMemory();
    const r = await myc(dir, "init", "--global", "--force");
    const text = `${r.stderr ?? ""}`;
    // Цифры потери — настоящие, не «существующие узлы». Склонение при числе
    // тоже часть ответа: «1 узлов» в самом важном сообщении команды читается
    // как сбой, а не как ответ.
    expect(before.nodes).toBe(1);
    expect(text).toContain("1 узел,");
    expect(text).toMatch(new RegExp(`${before.ops} операц\\S+ оплога`));
    expect(text).toContain("cp -R");
    expect(text).toContain("--wipe-memory");
  });

  test("--json: отказ читается агентом кодом, а не разбором текста", async () => {
    await personalWithMemory();
    const r = await myc(dir, "init", "--global", "--force", "--json");
    expect(r.code).toBe(ExitCode.PRECOND);
    const env = JSON.parse(r.stdout as string) as {
      ok: boolean;
      error: { code: string; exit: number; hint?: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("precond.personal_memory");
    expect(env.error.hint).toContain("--wipe-memory");
  });

  test("--force --wipe-memory: стирает по-настоящему и говорит, чего это стоило", async () => {
    const before = await personalWithMemory();

    const r = await myc(dir, "init", "--global", "--force", "--wipe-memory");
    expect(r.code).toBe(ExitCode.OK);
    expect(r.stdout as string).toContain("память стёрта");
    expect(r.stdout as string).toContain(`${before.nodes} узел`);

    const after = personalCounts();
    expect(after.nodes).toBe(0);
    expect(after.ops).toBe(0);

    const { env } = await mycJson(dir, "init", "--global", "--force", "--wipe-memory");
    const wiped = (env["data"] as { wiped: { entries: string[]; memory: boolean } }).wiped;
    expect(wiped.memory).toBe(true);
    expect(wiped.entries).toContain("myc.db");
  });

  test("--wipe-memory без --force: разрешение без действия — ошибка, диск цел", async () => {
    await personalWithMemory();
    const snapshotBefore = personalSnapshot();
    const r = await myc(dir, "init", "--global", "--wipe-memory");
    expect(r.code).toBe(ExitCode.USAGE);
    expect(personalSnapshot()).toBe(snapshotBefore);
  });

  test("пустой ярус: терять нечего, --force пересоздаёт как раньше", async () => {
    await myc(dir, "init", "--global");
    expect(personalCounts()).toEqual({ ops: 0, nodes: 0 });

    const r = await myc(dir, "init", "--global", "--force");
    expect(r.code).toBe(ExitCode.OK);
    expect(existsSync(join(homeDir, ".myc", "myc.db"))).toBe(true);
    expect(r.stdout as string).not.toContain("память стёрта");
  });

  test("нечитаемая база: отказ по незнанию, а не стирание по незнанию", async () => {
    await myc(dir, "init", "--global");
    const dbPath = join(homeDir, ".myc", "myc.db");
    // Без спутников: с живым `-wal` sqlite поднимет схему из него, и база
    // окажется читаемой — «битой» её делает именно отсутствие журнала.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    writeFileSync(dbPath, "это не sqlite");

    const r = await myc(dir, "init", "--global", "--force");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(`${r.stderr ?? ""}`).toContain("база не читается");
    expect(readFileSync(dbPath, "utf8")).toBe("это не sqlite");
  });

  test("--force без --wipe-memory: стирает восстановимое, базу оставляет на месте", async () => {
    await myc(dir, "init", "--global");
    mkdirSync(join(homeDir, ".myc", "projections"), { recursive: true });
    writeFileSync(join(homeDir, ".myc", "projections", "nodes.jsonl"), "{}\n");
    writeFileSync(join(homeDir, ".myc", "state.json"), "{}\n");
    const siteBefore = personalSite();
    expect(typeof siteBefore).toBe("string");

    const { code, env } = await mycJson(dir, "init", "--global", "--force");
    expect(code).toBe(ExitCode.OK);
    const wiped = (env["data"] as { wiped: { entries: string[]; memory: boolean } }).wiped;
    expect([...wiped.entries].sort()).toEqual(["projections", "state.json"]);
    expect(wiped.memory).toBe(false);
    expect(existsSync(join(homeDir, ".myc", "projections"))).toBe(false);
    expect(existsSync(join(homeDir, ".myc", "state.json"))).toBe(false);
    // «Пустая» и «которую не жалко» — разные вещи: база осталась ТА ЖЕ, а не
    // новая с тем же именем. Отличает их site_id: под ним подписаны операции
    // оплога, и смена личности сайта была бы потерей, которую existsSync не
    // видит.
    expect(existsSync(join(homeDir, ".myc", "myc.db"))).toBe(true);
    expect(personalSite()).toBe(siteBefore);
    expect(personalCounts()).toEqual({ ops: 0, nodes: 0 });
  });

  test("спутники базы уходят вместе с ней: осиротевший -wal — ловушка", async () => {
    await personalWithMemory();
    const before = readdirSync(join(homeDir, ".myc")).sort();
    // Предпосылка, а не проверяемое поведение: свежие записи живут в -wal до
    // чекпойнта, и он лежит на диске между запусками.
    expect(before).toContain("myc.db-wal");

    const { env } = await mycJson(dir, "init", "--global", "--force", "--wipe-memory");
    const data = env["data"] as { wiped: { entries: string[] }; kept: string[] };
    // Всё, что было своим, стёрто целиком: база без журнала — не «почти
    // стёртая база», а ловушка для следующего открытия.
    expect([...data.wiped.entries].sort()).toEqual(before);
    expect(data.kept).toEqual([]);
  });

  test("`bin/` и прочее чужое переживает даже --wipe-memory", async () => {
    await personalWithMemory();
    // wire.ts ищет установленный бинарь именно здесь: снести его вместе с
    // базой значило бы порвать хуки во всех репозиториях сразу.
    mkdirSync(join(homeDir, ".myc", "bin"), { recursive: true });
    writeFileSync(join(homeDir, ".myc", "bin", "myc"), "#!/bin/sh\n");

    const r = await myc(dir, "init", "--global", "--force", "--wipe-memory");
    expect(r.code).toBe(ExitCode.OK);
    expect(readFileSync(join(homeDir, ".myc", "bin", "myc"), "utf8")).toBe("#!/bin/sh\n");
    expect(r.stdout as string).toContain("не тронуто");
  });

  test("выгрузка оплога рядом с базой тоже держит --force", async () => {
    await myc(dir, "init", "--global");
    mkdirSync(join(homeDir, ".myc", "graph"), { recursive: true });
    writeFileSync(join(homeDir, ".myc", "graph", "site-a.jsonl"), '{"op":1}\n');

    const r = await myc(dir, "init", "--global", "--force");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(readFileSync(join(homeDir, ".myc", "graph", "site-a.jsonl"), "utf8")).toBe('{"op":1}\n');
  });

  test("проектный --force не задет: он по-прежнему пересоздаёт .myc/", async () => {
    await personalWithMemory();
    await myc(dir, "init");
    const r = await myc(dir, "init", "--force");
    expect(r.code).toBe(ExitCode.OK);
    // и личная память при этом на месте — ярусы не путаются
    expect(personalCounts().nodes).toBeGreaterThan(0);
  });
});


/**
 * Приёмка memory-2shvpjay4nx6 НАСТОЯЩИМИ процессами: `Bun.spawn` того же
 * `main.ts`, что в бою.
 *
 * Внутрипроцессный тест этот отказ увидеть не мог по двум причинам сразу, и
 * именно поэтому баг прожил под зелёным прогоном:
 *   1) `-wal`/`-shm` переживают закрытие соединения внутри процесса —
 *      состояние «писатель вышел начисто, спутников нет» в нём не наступает;
 *   2) под `bun test` предзагружается кастомная libsqlite3 (bunfig.toml →
 *      runtime-preload.ts), а она такую базу readonly открывает без ошибки.
 *      Боевой CLI работает на встроенной в Bun сборке, где тот же вызов
 *      падает с SQLITE_CANTOPEN — и `--force` отказывал ВСЕГДА.
 *
 * Мутация, которую этот describe обязан ловить: вернуть в
 * `countPersonalMemory` (store.ts) одно голое `new Database(path, { readonly:
 * true })` — красным становится «пустой ярус … --force проходит» (exit 5
 * вместо 0) и «память … отказ называет числа» («база не читается» вместо
 * цифр). Проверено прогоном с восстановленной старой реализацией.
 */
describe("init --global --force: писатель вышел начисто (настоящие процессы)", () => {
  const CLI_MAIN = join(import.meta.dir, "..", "main.ts");

  /**
   * NODE_ENV не подменяется: под `bun test` он равен "test", и это выключает
   * фоновый дренаж очереди — иначе фон дописывал бы в тот самый каталог,
   * слепок которого здесь и есть предмет проверки.
   */
  async function spawnMyc(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, CLI_MAIN, "-C", dir, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MYC_HOME: homeDir, MYC_ACTOR: "tester" },
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  }

  /**
   * Довести ярус до состояния «писатель вышел начисто»: WAL слит в базу,
   * спутников на диске нет. Ровно это оставляет после себя процесс, закрывший
   * соединение штатно, — и ровно на этом readonly-открытие спотыкалось.
   */
  function writerExitedClean(): void {
    const dbPath = join(homeDir, ".myc", "myc.db");
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    expect(readdirSync(join(homeDir, ".myc")).filter((f) => f.startsWith("myc.db-"))).toEqual([]);
  }

  /** Слепок каталога целиком: имя файла и хеш содержимого. */
  function snapshot(): string {
    const root = join(homeDir, ".myc");
    return readdirSync(root)
      .sort()
      .map((f) => `${f}:${Bun.SHA256.hash(readFileSync(join(root, f))).toString()}`)
      .join("\n");
  }

  /**
   * Читает `myc_meta` тем же двухступенчатым способом, что и продуктовый
   * `countPersonalMemory` — и по той же причине.
   *
   * База после `wal_checkpoint(TRUNCATE)` не имеет спутников, и голое
   * `new Database(path, { readonly: true })` на ВСТРОЕННОЙ в Bun sqlite
   * падает с `SQLITE_CANTOPEN`; кастомная libsqlite3, которую подгружает
   * preload, открывает её молча. Хелпер, написанный по первому поведению,
   * зелен на машине с Homebrew и красен на голом раннере — что и случилось
   * в CI (ubuntu-latest). Воспроизведено локально подменой preload.
   *
   * Тест, который сам не переживает окружения, проверяемого им же, ничего не
   * проверяет — поэтому здесь та же вторая ступень `immutable=1`.
   */
  function meta(key: string): string | undefined {
    const path = join(homeDir, ".myc", "myc.db");
    const read = (db: Database): string | undefined => {
      try {
        return (db.query("SELECT value FROM myc_meta WHERE key = ?1").get(key) as
          | { value: string }
          | null)?.value;
      } finally {
        db.close();
      }
    };
    try {
      return read(new Database(path, { readonly: true }));
    } catch {
      // Спутников нет — значит журнал не игнорируется, а отсутствует.
      return read(new Database(`file://${path}?immutable=1`, { readonly: true }));
    }
  }

  test("пустой ярус: --force проходит, стирает кеши и оставляет базу", async () => {
    expect((await spawnMyc("init", "--global")).code).toBe(ExitCode.OK);
    writerExitedClean();
    const siteBefore = meta("site_id");
    writerExitedClean(); // чтение выше могло создать спутников — снова начисто
    mkdirSync(join(homeDir, ".myc", "projections"), { recursive: true });
    writeFileSync(join(homeDir, ".myc", "projections", "nodes.jsonl"), "{}\n");

    const r = await spawnMyc("init", "--global", "--force");
    // Терять нечего — и отказ здесь не осторожность, а сломанный безопасный
    // путь: человек, которому --force отказывает всегда, приучается писать
    // --wipe-memory, и защита исчезает ровно там, где нужна.
    expect(`${r.err}${r.out}`).not.toContain("база не читается");
    expect(r.code).toBe(ExitCode.OK);
    expect(existsSync(join(homeDir, ".myc", "projections"))).toBe(false);
    expect(existsSync(join(homeDir, ".myc", "myc.db"))).toBe(true);
    expect(meta("site_id")).toBe(siteBefore);
    expect(r.out).toContain("память не тронута");
  });

  test("память на месте: отказ называет числа потери и не пишет ни байта", async () => {
    expect((await spawnMyc("init", "--global")).code).toBe(ExitCode.OK);
    expect((await spawnMyc("remember", "--global", "рабочий день начинаю с myc ready")).code).toBe(
      ExitCode.OK,
    );
    writerExitedClean();
    const before = snapshot();

    const r = await spawnMyc("init", "--global", "--force");
    // Утверждения ниже сверяют ТЕКСТ отказа, и когда он расходится, голое
    // «expected to contain» не говорит, чем именно. Подпроцесс живёт отдельно
    // и на другой платформе может отвечать иначе — печатаем то, что он
    // ответил на самом деле, иначе разбор упирается в отсутствие фактов.
    if (r.code !== ExitCode.PRECOND || !r.err.includes("1 узел,")) {
      console.log(
        `[диагностика] init --global --force вернул ${r.code} (ожидался ${ExitCode.PRECOND})\n` +
          `stderr: ${r.err.slice(0, 800)}\nstdout: ${r.out.slice(0, 400)}`,
      );
    }
    expect(r.code).toBe(ExitCode.PRECOND);
    // «База не читается» — не ответ, а признак слепоты защиты: файл на месте
    // и прекрасно читается, а человеку нужны цифры того, что он теряет.
    expect(r.err).not.toContain("база не читается");
    expect(r.err).toContain("1 узел,");
    expect(r.err).toMatch(/\d+ операц\S+ оплога/);
    // И чтение не оставляет следов. Лечение из просмотрщика (пересоздать
    // соединение читаемым handle-ом под query_only) здесь бы это уронило:
    // закрытие такого соединения делает чекпойнт — замер на подставном ~/.myc
    // давал myc.db 4096 → 274432 и myc.db-wal 477952 → 0.
    expect(snapshot()).toBe(before);
  });

  test("битый файл без спутников: отказ по незнанию, а не чтение по незнанию", async () => {
    expect((await spawnMyc("init", "--global")).code).toBe(ExitCode.OK);
    writerExitedClean();
    const dbPath = join(homeDir, ".myc", "myc.db");
    writeFileSync(dbPath, "это не sqlite");

    const r = await spawnMyc("init", "--global", "--force");
    // Вторая попытка чтения не смеет быть попыткой «прочитать хоть что-то»:
    // не прочли — не стираем, и так и сказано.
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.err).toContain("база не читается");
    expect(readFileSync(dbPath, "utf8")).toBe("это не sqlite");
  });
});
