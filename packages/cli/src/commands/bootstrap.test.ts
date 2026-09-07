/**
 * `myc bootstrap` — обязательный контекст запуска (myc-ye3.5).
 *
 * Против настоящего bun:sqlite во временных каталогах и против настоящей ФС:
 * зонды автодетекта смотрят на файлы, поэтому подменяется не файловая
 * система, а `ProbeEnv` — домашний каталог, каталог моделей, PATH и
 * `which`. Сети здесь нет ни в одном тесте, подпроцессов тоже: автодетект
 * обязан укладываться в горячий путь запуска сессии.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { defaultModelsDir } from "@myc/embed";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import {
  autoBlocks,
  createBootstrapCommand,
  environmentFingerprint,
  isBootstrapKey,
  mergeBlocks,
  readPersonalBlocks,
  realProbeEnv,
  renderBootstrap,
  type BootstrapBlock,
  type BootstrapDeps,
  type ProbeEnv,
} from "./bootstrap.ts";
import { createPersonalWorkspace, realStoreDeps } from "./store.ts";

let dir: string;
let home: string;
let registry: Registry;
let env: ProbeEnv;

const COMMANDS = ["bootstrap", "init", "ready", "show"] as const;

function makeEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
  return {
    home,
    mycHome: home,
    modelsDir: join(home, ".cache", "myc", "models"),
    path: "/usr/bin:/bin",
    which: () => null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    store: realStoreDeps,
    env,
    commands: () => COMMANDS,
    personalBlocks: readPersonalBlocks,
    ...overrides,
  };
}

function makeRegistry(deps: BootstrapDeps = makeDeps()): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createBootstrapCommand(deps));
  return r;
}

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function mycJson(...args: string[]): Promise<{ code: number; env: Record<string, unknown> }> {
  const r = await myc(...args, "--json");
  return { code: r.code, env: JSON.parse(r.stdout as string) as Record<string, unknown> };
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const { env: e } = await mycJson(...args);
  return e["data"] as Record<string, unknown>;
}

beforeEach(() => {
  delete process.env.MYC_BOOTSTRAP_BUDGET;
  process.env.MYC_ACTOR = "tester";
  dir = mkdtempSync(join(tmpdir(), "myc-bootstrap-"));
  home = mkdtempSync(join(tmpdir(), "myc-home-"));
  env = makeEnv();
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Чистая машина
// ---------------------------------------------------------------------------

describe("чистая машина: ни воркспейса, ни ручных настроек", () => {
  test("выдаёт осмысленный блок и код 0, а не ошибку", async () => {
    const r = await myc("bootstrap");
    expect(r.code).toBe(ExitCode.OK);
    const text = r.stdout as string;
    expect(text).toContain("# MYC BOOTSTRAP v1");
    // Главное: агент узнаёт, чем он пользуется, даже когда памяти нет.
    expect(text).toContain("[auto:myc]");
    expect(text).toContain(`cmds: ${COMMANDS.join(",")}`);
    expect(text).toContain("[auto:tiers]");
    expect(text).toContain("cache off");
  });

  test("отсутствие воркспейса — громкая деградация, не тишина", async () => {
    const { env: e } = await mycJson("bootstrap");
    expect(e["ok"]).toBe(true);
    expect((e["meta"] as Record<string, unknown>)["degraded"]).toEqual(["ws.absent"]);
    expect((e["data"] as Record<string, unknown>)["text"]).toContain("ws.absent");
  });

  test("--strict превращает деградацию в код 6", async () => {
    const r = await myc("bootstrap", "--strict");
    expect(r.code).toBe(ExitCode.DEGRADED);
  });

  test("отсутствие модели и graft видно в блоке деградаций", async () => {
    const text = (await myc("bootstrap")).stdout as string;
    expect(text).toContain("embed.model_absent");
    expect(text).toContain("graft.absent");
  });
});

// ---------------------------------------------------------------------------
// Источник каждого блока
// ---------------------------------------------------------------------------

describe("источник блока виден в выводе", () => {
  test("каждая строка — шапка, тег источника или продолжение блока", async () => {
    await myc("init");
    await myc("bootstrap", "set", "style", "комментарии по-русски");
    const text = (await myc("bootstrap")).stdout as string;
    const lines = text.trimEnd().split("\n");
    for (const line of lines) {
      const ok =
        line.startsWith("#") || line.startsWith("  ") || /^\[(auto|manual):[a-z0-9_-]+/.test(line);
      expect({ line, ok }).toEqual({ line, ok: true });
    }
    expect(text).toContain("[manual:style] комментарии по-русски");
    expect(text).toContain("[auto:myc]");
  });

  test("личный ярус помечается @personal и вытесняется проектным по ключу", () => {
    const merged = mergeBlocks([
      { key: "style", source: "manual", tier: "personal", text: "общее правило" },
      { key: "style", source: "manual", tier: "project", text: "правило проекта" },
      { key: "tone", source: "manual", tier: "personal", text: "личное" },
    ]);
    expect(merged.map((b) => `${b.key}:${b.tier}`)).toEqual(["style:project", "tone:personal"]);
    const rendered = renderBootstrap({
      blocks: merged,
      budget: 2000,
      ws: "t",
      fp: "0",
      stats: { tookMs: 1, cache: "off" },
    });
    expect(rendered.text).toContain("[manual:tone@personal] личное");
    expect(rendered.text).toContain("[manual:style] правило проекта");
  });
});

// ---------------------------------------------------------------------------
// Ручные блоки
// ---------------------------------------------------------------------------

describe("ручные блоки: L3-заметки, а не файл рядом с кешем", () => {
  beforeEach(async () => {
    await myc("init");
  });

  test("set кладёт узел kind=note layer=3 topic=bootstrap", async () => {
    const set = await data("bootstrap", "set", "style", "комментарии по-русски");
    expect(set["created"]).toBe(true);
    const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
    try {
      const row = db
        .query(
          "SELECT kind, layer, title, body, json_extract(attrs,'$.topic') AS topic FROM nodes WHERE id = ?",
        )
        .get(set["id"] as string) as Record<string, unknown>;
      expect(row["kind"]).toBe("note");
      expect(row["layer"]).toBe(3);
      expect(row["topic"]).toBe("bootstrap");
      expect(row["body"]).toBe("комментарии по-русски");
      // Запись прошла через оплог — значит синхронизируется как обычная память.
      const ops = db
        .query("SELECT count(*) AS n FROM oplog WHERE entity_id = ?")
        .get(set["id"] as string) as { n: number };
      expect(ops.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("повторный set правит тот же узел, а не плодит второй", async () => {
    const first = await data("bootstrap", "set", "style", "первая редакция");
    const second = await data("bootstrap", "set", "style", "вторая редакция");
    expect(second["created"]).toBe(false);
    expect(second["id"]).toBe(first["id"] as string);
    const text = (await myc("bootstrap")).stdout as string;
    expect(text).toContain("вторая редакция");
    expect(text).not.toContain("первая редакция");
  });

  test("блок переживает сброс кеша автодетекта и новый процесс команды", async () => {
    await myc("bootstrap", "set", "style", "правило живёт в графе");
    await myc("bootstrap"); // прогрели кеш автодетекта
    rmSync(join(dir, ".myc", "bootstrap.cache.json"), { force: true });
    registry = makeRegistry(); // новый инстанс команд и новое соединение
    const text = (await myc("bootstrap")).stdout as string;
    expect(text).toContain("[manual:style] правило живёт в графе");
    expect(text).toContain("cache miss");
  });

  test("blocks в конверте называют источник и ярус каждого блока", async () => {
    await myc("bootstrap", "set", "style", "x");
    const d = await data("bootstrap");
    const blocks = d["blocks"] as Array<Record<string, unknown>>;
    const manual = blocks.filter((b) => b["source"] === "manual");
    expect(manual).toHaveLength(1);
    expect(manual[0]!["key"]).toBe("style");
    expect(manual[0]!["tier"]).toBe("project");
    expect(d["tiers"]).toEqual(["project"]);
  });

  test("rm убирает блок; повторный rm — notfound", async () => {
    await myc("bootstrap", "set", "style", "x");
    const r = await myc("bootstrap", "rm", "style");
    expect(r.code).toBe(ExitCode.OK);
    expect((await myc("bootstrap")).stdout as string).not.toContain("[manual:style]");
    const again = await myc("bootstrap", "rm", "style");
    expect(again.code).toBe(ExitCode.NOTFOUND);
  });

  test("list печатает ключи, ярус и размер", async () => {
    await myc("bootstrap", "set", "style", "12345");
    const r = await myc("bootstrap", "list");
    expect(r.stdout as string).toContain("style");
    expect(r.stdout as string).toContain("project");
  });

  test("негодный ключ и пустой текст — код 2", async () => {
    expect((await myc("bootstrap", "set", "Стиль", "x")).code).toBe(ExitCode.USAGE);
    expect((await myc("bootstrap", "set", "style")).code).toBe(ExitCode.USAGE);
  });

  test("set без воркспейса — код 7, а не тихая потеря текста", async () => {
    const clean = mkdtempSync(join(tmpdir(), "myc-nows-"));
    try {
      const r = await run(["-C", clean, "bootstrap", "set", "style", "x"], { registry });
      expect(r.code).toBe(ExitCode.NOWS);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  test("запрос ручных блоков идёт по частичному индексу prime, а не сканом", async () => {
    await myc("bootstrap", "set", "style", "x");
    const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
    try {
      const plan = db
        .query(
          `EXPLAIN QUERY PLAN
           SELECT id, title, coalesce(body,'') AS body, updated_at
             FROM nodes
            WHERE scope = ?1 AND kind = 'note'
              AND layer >= 2 AND layer = 3
              AND head_id IS NULL AND deleted_at IS NULL
              AND g_topic = 'bootstrap'`,
        )
        .all("") as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join(" | ");
      expect(detail).toContain("ix_nodes_prime");
      expect(detail).not.toContain("SCAN nodes");
      expect(detail).not.toContain("TEMP B-TREE");
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Бюджет и обрезка
// ---------------------------------------------------------------------------

describe("бюджет вывода", () => {
  beforeEach(async () => {
    await myc("init");
  });

  test("бюджет берётся из workspace.toml проекта", async () => {
    // Умолчание 2000 не выдерживает нормального использования bootstrap set:
    // пять закреплённых правил дают 2863 символа, и первым вытесняется
    // [auto:graft] — самый нужный агенту блок. Правила общие для команды,
    // значит и бюджет общий: переменная окружения одного разработчика
    // остальным не помогает.
    const toml = join(dir, ".myc", "workspace.toml");
    writeFileSync(toml, `${readFileSync(toml, "utf8")}\n[bootstrap]\nbudget = 4321\n`);
    const d = await data("bootstrap");
    expect((d as { budget: number }).budget).toBe(4321);
  });

  test("флаг сильнее конфига проекта", async () => {
    const toml = join(dir, ".myc", "workspace.toml");
    writeFileSync(toml, `${readFileSync(toml, "utf8")}\n[bootstrap]\nbudget = 4321\n`);
    const d = await data("bootstrap", "--budget", "777");
    expect((d as { budget: number }).budget).toBe(777);
  });

  test("битый конфиг не отказывает в бутстрапе, а падает на умолчание", async () => {
    const toml = join(dir, ".myc", "workspace.toml");
    writeFileSync(toml, "[bootstrap]\nbudget = не-число\n");
    const d = await data("bootstrap");
    expect((d as { budget: number }).budget).toBe(2000);
  });

  test("вывод укладывается в заданный бюджет символов", async () => {
    for (const budget of [200, 400, 800, 2000]) {
      const r = await myc("bootstrap", "--budget", String(budget));
      const text = r.stdout as string;
      expect({ budget, chars: text.length <= budget }).toEqual({ budget, chars: true });
    }
  });

  test("при превышении говорит об обрезке и называет ключи", async () => {
    const d = await data("bootstrap", "--budget", "400");
    expect(d["truncated"]).toBe(true);
    const dropped = d["dropped"] as string[];
    const clipped = d["clipped"] as string[];
    expect(dropped.length + clipped.length).toBeGreaterThan(0);
    const text = d["text"] as string;
    expect(text).toContain("# CUT");
    for (const key of [...dropped, ...clipped]) expect(text).toContain(key);
  });

  test("режется хвост: блок myc выживает всегда, tiers уходит первым", async () => {
    const small = await data("bootstrap", "--budget", "400");
    expect(small["text"] as string).toContain("[auto:myc]");
    expect(small["dropped"] as string[]).toContain("tiers");
  });

  test("обрезка детерминирована: два вызова подряд дают тот же текст", async () => {
    const first = (await data("bootstrap", "--budget", "500"))["text"] as string;
    const second = (await data("bootstrap", "--budget", "500"))["text"] as string;
    const strip = (t: string): string => t.replace(/· \d+ мс · cache \w+/, "");
    expect(strip(second)).toBe(strip(first));
  });

  test("бюджет настраивается флагом и переменной окружения", async () => {
    process.env.MYC_BOOTSTRAP_BUDGET = "600";
    try {
      const d = await data("bootstrap");
      expect(d["budget"]).toBe(600);
      expect((d["text"] as string).length).toBeLessThanOrEqual(600);
    } finally {
      delete process.env.MYC_BOOTSTRAP_BUDGET;
    }
  });

  test("бюджет ниже минимума — код 2, а не молча урезанный вывод", async () => {
    const r = await myc("bootstrap", "--budget", "100");
    expect(r.code).toBe(ExitCode.USAGE);
  });

  test("рендер: не влезающий блок обрезается с многоточием, следующие выброшены", () => {
    const blocks: BootstrapBlock[] = [
      { key: "myc", source: "auto", tier: "project", text: "a".repeat(120) },
      { key: "graft", source: "auto", tier: "project", text: "b".repeat(200) },
      { key: "mcp", source: "auto", tier: "project", text: "c".repeat(200) },
    ];
    const out = renderBootstrap({
      blocks,
      budget: 400,
      ws: "t",
      fp: "0",
      stats: { tookMs: 1, cache: "off" },
    });
    expect(out.chars).toBeLessThanOrEqual(400);
    expect(out.clipped).toEqual(["graft"]);
    expect(out.dropped).toEqual(["mcp"]);
    expect(out.text).toContain("…");
  });
});

// ---------------------------------------------------------------------------
// Кеш и отпечаток окружения
// ---------------------------------------------------------------------------

describe("кеш автодетекта по отпечатку окружения", () => {
  beforeEach(async () => {
    await myc("init");
  });

  test("первый вызов miss, второй hit", async () => {
    expect((await data("bootstrap"))["cache"]).toBe("miss");
    expect((await data("bootstrap"))["cache"]).toBe("hit");
  });

  test("--no-cache не читает и не пишет, --refresh пересчитывает", async () => {
    await myc("bootstrap");
    expect((await data("bootstrap", "--no-cache"))["cache"]).toBe("off");
    expect((await data("bootstrap", "--refresh"))["cache"]).toBe("miss");
    expect((await data("bootstrap"))["cache"]).toBe("hit");
  });

  test("появление .mcp.json меняет отпечаток и роняет кеш", async () => {
    const before = await data("bootstrap");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { graft: { command: "graft" } } }));
    const after = await data("bootstrap");
    expect(after["fp"]).not.toBe(before["fp"]);
    expect(after["cache"]).toBe("miss");
    expect(after["text"] as string).toContain("[auto:mcp]");
    expect(after["text"] as string).toContain("graft(graft)");
  });

  test("кеш переживает перезапуск команды при неизменном окружении", async () => {
    await myc("bootstrap");
    registry = makeRegistry();
    expect((await data("bootstrap"))["cache"]).toBe("hit");
  });

  test("отпечаток ловит появление и исчезновение файла", () => {
    const probe = [{ kind: "file" as const, path: join(dir, "x.json") }];
    const empty = environmentFingerprint(probe, []);
    writeFileSync(join(dir, "x.json"), "{}");
    const present = environmentFingerprint(probe, []);
    expect(present).not.toBe(empty);
    rmSync(join(dir, "x.json"));
    expect(environmentFingerprint(probe, [])).toBe(empty);
  });

  test("отпечаток каталога скилов реагирует на состав, а не на правку внутри", () => {
    const skills = join(dir, ".claude", "skills");
    mkdirSync(join(skills, "one"), { recursive: true });
    const probe = [{ kind: "dir" as const, path: skills }];
    const base = environmentFingerprint(probe, []);

    // Правка файла ВНУТРИ скила: мы его не читаем, отпечаток обязан молчать.
    writeFileSync(join(skills, "one", "SKILL.md"), "правка");
    expect(environmentFingerprint(probe, [])).toBe(base);

    // Новый скил меняет список — отпечаток обязан поменяться.
    mkdirSync(join(skills, "two"));
    expect(environmentFingerprint(probe, [])).not.toBe(base);
  });

  test("отпечаток меняется при подключении новой команды CLI", () => {
    const probe = [{ kind: "dir" as const, path: dir }];
    const a = environmentFingerprint(probe, ["cmds:init,ready"]);
    const b = environmentFingerprint(probe, ["cmds:bootstrap,init,ready"]);
    expect(a).not.toBe(b);
  });

  test("битый кеш не роняет команду, а считается промахом", async () => {
    await myc("bootstrap");
    writeFileSync(join(dir, ".myc", "bootstrap.cache.json"), "{ не json");
    const d = await data("bootstrap");
    expect(d["cache"]).toBe("miss");
    expect(d["text"] as string).toContain("[auto:myc]");
  });
});

// ---------------------------------------------------------------------------
// Автодетект по существу
// ---------------------------------------------------------------------------

describe("автодетект", () => {
  test("видит MCP из .mcp.json и из opencode.json, .mcp.json приоритетнее", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { graft: { command: "graft", args: ["mcp"] } } }),
    );
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { graft: { command: ["other"] }, extra: { command: ["ex"] } } }),
    );
    const mcp = autoBlocks(dir, env, COMMANDS).find((b) => b.key === "mcp");
    expect(mcp?.text).toContain("2 сервера");
    expect(mcp?.text).toContain("graft(graft)");
    expect(mcp?.text).toContain("extra(ex)");
  });

  test("видит скилы проекта и пользователя, длинный список сворачивает числом", () => {
    mkdirSync(join(dir, ".claude", "skills", "alpha"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(home, ".claude", "skills", `s${String(i).padStart(2, "0")}`), {
        recursive: true,
      });
    }
    const skills = autoBlocks(dir, env, COMMANDS).find((b) => b.key === "skills");
    expect(skills?.text).toContain("проектные .claude/skills 1: alpha");
    expect(skills?.text).toContain("личные ~/.claude/skills 20:");
    expect(skills?.text).toContain(",+8");
  });

  test("видит graft: и индекс в репозитории, и бинарь в PATH", () => {
    mkdirSync(join(dir, "graft"), { recursive: true });
    writeFileSync(join(dir, "graft", "INDEX.md"), "# graft");
    const withBin = autoBlocks(dir, makeEnv({ which: () => "/usr/local/bin/graft" }), COMMANDS);
    const graft = withBin.find((b) => b.key === "graft");
    expect(graft?.text).toContain("bin=/usr/local/bin/graft index=graft/");
    expect(graft?.text).toContain("skeleton <файл>");

    const noBin = autoBlocks(dir, env, COMMANDS).find((b) => b.key === "graft");
    expect(noBin?.text).toContain("бинаря нет");
  });

  test("без graft вовсе блока нет — не выдумываем несуществующий инструмент", () => {
    expect(autoBlocks(dir, env, COMMANDS).some((b) => b.key === "graft")).toBe(false);
  });

  test("модель считается уложенной по manifest.json, а не по имени каталога", () => {
    const model = join(env.modelsDir, "bge-small-en-v1.5");
    mkdirSync(model, { recursive: true });
    const partial = autoBlocks(dir, env, COMMANDS).find((b) => b.key === "models");
    expect(partial?.text).toContain("без манифеста: bge-small-en-v1.5");
    expect(partial?.text).not.toContain("по манифесту:");

    writeFileSync(join(model, "manifest.json"), "{}");
    const ready = autoBlocks(dir, env, COMMANDS).find((b) => b.key === "models");
    expect(ready?.text).toContain("по манифесту: bge-small-en-v1.5");
  });

  test("недокачанная модель — деградация, а не тихое 'модель есть'", async () => {
    mkdirSync(join(env.modelsDir, "bge-small-en-v1.5"), { recursive: true });
    await myc("init");
    expect((await myc("bootstrap")).stdout as string).toContain("embed.model_absent");
  });

  test("появление manifest.json в каталоге модели роняет кеш автодетекта", async () => {
    const model = join(env.modelsDir, "bge-small-en-v1.5");
    mkdirSync(model, { recursive: true });
    await myc("init");
    const before = await data("bootstrap");
    expect(before["cache"]).toBe("miss");
    writeFileSync(join(model, "manifest.json"), "{}");
    const after = await data("bootstrap");
    expect(after["fp"]).not.toBe(before["fp"]);
    expect(after["cache"]).toBe("miss");
    expect(after["text"] as string).toContain("по манифесту:");
  });

  test("каталог моделей не разъехался с @myc/embed", () => {
    // Дубль пути в realProbeEnv сознательный (не тянуть embed в горячий
    // путь), но расхождение должно ломать сборку, а не тихо врать агенту.
    expect(realProbeEnv.modelsDir).toBe(defaultModelsDir());
  });

  test("ключи блоков валидируются", () => {
    expect(isBootstrapKey("style")).toBe(true);
    expect(isBootstrapKey("build-and-test_2")).toBe(true);
    expect(isBootstrapKey("Style")).toBe(false);
    expect(isBootstrapKey("2style")).toBe(false);
    expect(isBootstrapKey("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Наследование ярусов — точка расширения myc-ye3.6
// ---------------------------------------------------------------------------

describe("ярусы (S41)", () => {
  test("личный ярус подключается одной функцией и виден в выводе", async () => {
    registry = makeRegistry(
      makeDeps({
        personalBlocks: () =>
          Promise.resolve([
            {
              key: "tone",
              source: "manual" as const,
              tier: "personal" as const,
              text: "общее правило пользователя",
            },
          ]),
      }),
    );
    await myc("init");
    const d = await data("bootstrap");
    expect(d["tiers"]).toEqual(["project", "personal"]);
    expect(d["text"] as string).toContain("[manual:tone@personal] общее правило пользователя");
  });

  test("без личного яруса блок tiers честно говорит, что его нет", async () => {
    await myc("init");
    expect((await myc("bootstrap")).stdout as string).toContain("нет (myc init --global)");
  });

  test("set --global пишет в ~/.myc, вывод помечает ярус, ключ проекта вытесняет личный", async () => {
    await createPersonalWorkspace(home);
    await myc("init");

    const globalSet = await data("bootstrap", "set", "--global", "tone", "личное правило");
    expect(globalSet["tier"]).toBe("personal");
    let text = (await myc("bootstrap")).stdout as string;
    expect(text).toContain("[manual:tone@personal] личное правило");

    // Тот же ключ в проекте: наследование разрешается слиянием, а не порядком.
    await myc("bootstrap", "set", "tone", "правило проекта");
    text = (await myc("bootstrap")).stdout as string;
    expect(text).toContain("[manual:tone] правило проекта");
    expect(text).not.toContain("личное правило");

    // Другой ключ из личного яруса остаётся виден.
    await myc("bootstrap", "set", "--global", "style", "личный стиль");
    text = (await myc("bootstrap")).stdout as string;
    expect(text).toContain("[manual:style@personal] личный стиль");
  });

  test("rm --global снимает блок именно с личного яруса", async () => {
    await createPersonalWorkspace(home);
    await myc("init");
    await myc("bootstrap", "set", "--global", "tone", "личное");
    await myc("bootstrap", "set", "tone", "проектное");
    // Без --global удаляется проектный блок, личный остаётся.
    expect((await myc("bootstrap", "rm", "tone")).code).toBe(ExitCode.OK);
    expect((await myc("bootstrap")).stdout as string).toContain("[manual:tone@personal] личное");
    const rm = await data("bootstrap", "rm", "--global", "tone");
    expect(rm["tier"]).toBe("personal");
    expect((await myc("bootstrap")).stdout as string).not.toContain("[manual:tone");
  });

  test("set --global без личного яруса — код 7 и подсказка, а не тихое создание базы", async () => {
    await myc("init");
    const r = await myc("bootstrap", "set", "--global", "tone", "x");
    expect(r.code).toBe(ExitCode.NOWS);
    expect(existsSync(join(home, ".myc", "myc.db"))).toBe(false);
  });

  test("list показывает оба яруса", async () => {
    await createPersonalWorkspace(home);
    await myc("init");
    await myc("bootstrap", "set", "gates", "проектное");
    await myc("bootstrap", "set", "--global", "tone", "личное");
    const rows = (await mycJson("bootstrap", "list")).env["data"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => `${r["key"]}:${r["tier"]}`).sort()).toEqual([
      "gates:project",
      "tone:personal",
    ]);
  });

  test("блок tiers считает ручные блоки личного яруса", async () => {
    await createPersonalWorkspace(home);
    await myc("init");
    await myc("bootstrap", "set", "--global", "tone", "личное");
    expect((await myc("bootstrap")).stdout as string).toContain("1 ручной блок;");
  });
});

// ---------------------------------------------------------------------------
// Бюджет времени
// ---------------------------------------------------------------------------

describe("бюджет 30 мс", () => {
  test("холодный вызов и вызов с кешем укладываются", async () => {
    await myc("init");
    // Прогрев модулей: первый вызов в процессе платит за импорт bun:sqlite,
    // а бюджет команды — про её работу, а не про старт рантайма.
    await myc("bootstrap", "--refresh");

    const cold = await data("bootstrap", "--refresh");
    const warm = await data("bootstrap");
    expect(warm["cache"]).toBe("hit");
    expect({ phase: "cold", ok: (cold["took_ms"] as number) <= 30 }).toEqual({
      phase: "cold",
      ok: true,
    });
    expect({ phase: "warm", ok: (warm["took_ms"] as number) <= 30 }).toEqual({
      phase: "warm",
      ok: true,
    });
  });

  test("отпечаток окружения считается за микросекунды", () => {
    mkdirSync(join(dir, ".claude", "skills", "one"), { recursive: true });
    const probe = [
      { kind: "file" as const, path: join(dir, ".mcp.json") },
      { kind: "dir" as const, path: join(dir, ".claude", "skills") },
      { kind: "dir" as const, path: join(home, ".claude", "skills") },
    ];
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) environmentFingerprint(probe, ["x"]);
    const per = (performance.now() - t0) / 100;
    expect({ per, ok: per < 1 }).toEqual({ per, ok: true });
  });
});

// ---------------------------------------------------------------------------
// Мелочи каркаса
// ---------------------------------------------------------------------------

describe("каркас", () => {
  test("ровно один конверт в --json", async () => {
    await myc("init");
    const r = await myc("bootstrap", "--json");
    expect((r.stdout as string).trim().split("\n")).toHaveLength(1);
  });

  test("--help перечисляет подкоманды", async () => {
    const r = await myc("bootstrap", "--help");
    const text = r.stdout as string;
    expect(text).toContain("set");
    expect(text).toContain("rm");
    expect(text).toContain("list");
  });

  test("кеш пишется в .myc и не мусорит в корне репозитория", async () => {
    await myc("init");
    await myc("bootstrap");
    const raw = JSON.parse(readFileSync(join(dir, ".myc", "bootstrap.cache.json"), "utf8")) as {
      v: number;
      fp: string;
      blocks: unknown[];
    };
    expect(raw.v).toBe(1);
    expect(raw.fp).toHaveLength(16);
    expect(raw.blocks.length).toBeGreaterThan(0);
  });

  test("устаревшая версия формата в кеше игнорируется", async () => {
    await myc("init");
    const d = await data("bootstrap");
    const path = join(dir, ".myc", "bootstrap.cache.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...raw, v: 0 }));
    // mtime кеша на отпечаток не влияет — промах обязан быть из-за версии.
    utimesSync(path, new Date(), new Date());
    expect((await data("bootstrap"))["cache"]).toBe("miss");
    expect(d["fp"]).toBe((await data("bootstrap"))["fp"] as string);
  });
});
