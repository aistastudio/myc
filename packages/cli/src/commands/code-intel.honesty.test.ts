/**
 * GUARD memory-bn4cs836df52: «возможность есть, её описание — нет».
 *
 * В 0.3.0 builtin отвечал на callers, code search и code map (tree-sitter), а
 * пять поверхностей говорили агенту обратное: `[auto:degraded] graft.absent`
 * в bootstrap, WARN `degraded.graft` в init, причина `selectCodeIntel` в трёх
 * режимах. Bootstrap вдобавок рекламировал graft там, где у graft нет индекса.
 *
 * ПОВЕДЕНЧЕСКИЙ, А НЕ ТЕКСТОВЫЙ. Список «что работает» не записан в тесте —
 * он добывается прогоном: фикстура без graft (git-репозиторий, .ts и .py)
 * проходит `myc code index`, затем callers, code search и code map ОБЯЗАНЫ
 * ответить по обоим языкам. Только после этого собираются тексты всех
 * поверхностей — bootstrap, отчёт init (свежий, повторный, конверт) в режимах
 * builtin / auto без graft / auto со старым graft, причина `selectCodeIntel` и
 * `renderSelection` в тех же режимах, справка и отказы команд кода — и
 * утверждается:
 *   1. ни одна не отрицает возможность, которая только что ответила;
 *   2. каждая, что перечисляет языки, перечисляет ВСЕ из L1_LANGS;
 *   3. отсутствие необязательного graft не пишется в деградации;
 *   4. `[auto:graft]` есть только там, где есть graft/INDEX.md.
 * Вторая фикстура — дерево без L1-файлов: там живут ветки строк, которых
 * первая не печатает (`code_index.no_l1`, подсказка `code symbol`, отказ
 * `code fetch`, причина «файлов … нет»), и там callers с search честно НЕ
 * отвечают — отрицать их можно, отрицать ответившую code map нельзя.
 *
 * Мутации, на которых guard обязан падать (проверены откатом каждой):
 *   M1 — вернуть degraded `graft.absent` с прежним текстом в bootstrap;
 *   M2 — показывать `[auto:graft]` при одном бинаре без индекса;
 *   M3 — вернуть «, callers/search/map недоступны» в reason режима builtin;
 *   M4 — захардкодить «ts/tsx/js/jsx» вместо L1_LANGS_LABEL в одной поверхности.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSelection, selectCodeIntel, type SelectEnv } from "@myc/code-intel";
import { L1_LANGS, L1_LANGS_LABEL } from "@myc/code-intel/langs";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createBootstrapCommand, readPersonalBlocks, type ProbeEnv } from "./bootstrap.ts";
import { createCallersCommand } from "./callers.ts";
import { createCodeCommand } from "./code.ts";
import { createInitCommand } from "./init.ts";
import { createSkeletonCommand } from "./skeleton.ts";
import { realStoreDeps } from "./store.ts";

// ---------------------------------------------------------------------------
// Детекторы. Тексты поверхностей — единственное, что тут текстовое, и у самих
// детекторов есть свой сторож ниже: без него «ничего не нашли» значило бы и
// «лжи нет», и «регулярка сломана».
// ---------------------------------------------------------------------------

type Cap = "callers" | "search" | "map";
const CAPS: readonly Cap[] = ["callers", "search", "map"];

/** Как поверхность могла бы назвать возможность. */
const CAP_WORDS: Readonly<Record<Cap, RegExp>> = {
  callers: /\bcallers\b|кто зовёт|вызывающ/iu,
  search: /\bsearch\b|поиск по коду/iu,
  map: /\bmap\b|карт[аыу] (?:кода|репозитория)/iu,
};

/**
 * Отрицание. `\b` в JS не видит границы у кириллицы (S48), поэтому «нет»
 * ограничено буквами явно, а не `\b`.
 */
const DENIAL =
  /недоступ|не будет|не работа|не поддерж|отсутству|(?<!\p{L})нет(?!\p{L})|unavailable|not available|unsupported|not supported|disabled/iu;

/** Клауза — кусок между разделителями: утверждение и его подлежащее рядом. */
function clauses(text: string): string[] {
  return text
    .split(/[\n,;:—()|]+/u)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function denialsOf(text: string, cap: Cap): string[] {
  return clauses(text).filter((c) => CAP_WORDS[cap].test(c) && DENIAL.test(c));
}

/** Перечисление языков в стиле L1_LANGS_LABEL: `ts/tsx/…`. */
const LANG_LIST = /(?<![\p{L}\d_])(?:ts|tsx|js|jsx|py|mjs|cjs)(?:\/(?:ts|tsx|js|jsx|py|mjs|cjs))+(?![\p{L}\d_])/giu;

function langLists(text: string): string[] {
  return [...text.matchAll(LANG_LIST)].map((m) => m[0]);
}

/** Строки одного блока bootstrap: шапка `[auto:<ключ>]` и её продолжения. */
function blockLines(text: string, tag: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) inside = line.startsWith(`[${tag}]`);
    else if (!line.startsWith("  ")) inside = false;
    if (inside) out.push(line);
  }
  return out;
}

function incompleteLists(text: string): string[] {
  return langLists(text).flatMap((list) => {
    const named = new Set(list.toLowerCase().split("/"));
    const missing = [...L1_LANGS].filter((l) => !named.has(l));
    return missing.length > 0 ? [`${list} — нет ${missing.join(",")}`] : [];
  });
}

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

const TS = `/** Разбор и печать счёта. */
export function parseInvoice(raw: string): number {
  return Number.parseInt(raw, 10);
}

export function renderInvoice(raw: string): string {
  return \`total: \${parseInvoice(raw)}\`;
}
`;

const PY = `"""Загрузка конфигурации."""


def load_config(path):
    return {"path": path}


def main():
    return load_config("app.toml")
`;

const COMMANDS = ["bootstrap", "callers", "code", "init", "skeleton"] as const;
const FAKE_GRAFT = "/opt/graft/bin/graft";

interface Surface {
  readonly name: string;
  readonly text: string;
}

let root: string;
let home: string;
/** PATH без graft: только git. */
let binNoGraft: string;
/** PATH со «старым» graft: git и скрипт, отвечающий на --version `0.0.1`. */
let binOldGraft: string;
let savedPath: string | undefined;
let savedHome: string | undefined;

function probeEnv(which: (cmd: string) => string | null, path: string): ProbeEnv {
  return { home, mycHome: home, modelsDir: join(home, "models"), path, which };
}

function registryWith(env: ProbeEnv): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(
    createBootstrapCommand({
      store: realStoreDeps,
      env,
      commands: () => COMMANDS,
      personalBlocks: readPersonalBlocks,
    }),
  );
  r.register(createCodeCommand());
  r.register(createCallersCommand());
  r.register(createSkeletonCommand());
  return r;
}

function textOf(r: RunResult): string {
  const out = typeof r.stdout === "string" ? r.stdout : [...r.stdout].join("");
  return `${out}${r.stderr ?? ""}`;
}

async function myc(reg: Registry, cwd: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", cwd, ...args], { registry: reg, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

async function envelope(reg: Registry, cwd: string, ...args: string[]): Promise<Record<string, unknown>> {
  const r = await myc(reg, cwd, ...args, "--json");
  return JSON.parse(textOf(r)) as Record<string, unknown>;
}

async function withPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = path;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
}

function selectEnv(o: { bin: string | null; version?: string; path: string }): SelectEnv {
  return {
    path: o.path,
    which: (cmd) => (cmd === "graft" ? o.bin : null),
    graftVersion: () => o.version ?? null,
    now: () => 1_700_000_000_000,
  };
}

/** Причина выбора в трёх режимах, где работает builtin, и её короткая строка. */
function selectionSurfaces(dir: string, tag: string): Surface[] {
  const picks = [
    ["builtin", selectCodeIntel(dir, selectEnv({ bin: null, path: "/honesty-builtin" }), "builtin")],
    ["auto без graft", selectCodeIntel(dir, selectEnv({ bin: null, path: "/honesty-nograft" }), "auto")],
    [
      "auto со старым graft",
      selectCodeIntel(
        dir,
        selectEnv({ bin: FAKE_GRAFT, version: "0.0.1", path: "/honesty-oldgraft" }),
        "auto",
      ),
    ],
  ] as const;
  return picks.flatMap(([mode, s]) => {
    expect({ mode, id: s.id }).toEqual({ mode, id: "builtin" });
    return [
      { name: `${tag}: selectCodeIntel(${mode}).reason`, text: s.reason },
      { name: `${tag}: renderSelection(${mode})`, text: renderSelection(s) },
    ];
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "myc-honesty-"));
  home = join(root, "home");
  binNoGraft = join(root, "bin-nograft");
  binOldGraft = join(root, "bin-oldgraft");
  for (const d of [home, binNoGraft, binOldGraft]) mkdirSync(d, { recursive: true });
  const git = Bun.which("git");
  if (git !== null) {
    symlinkSync(git, join(binNoGraft, "git"));
    symlinkSync(git, join(binOldGraft, "git"));
  }
  writeFileSync(join(binOldGraft, "graft"), '#!/bin/sh\necho "graft 0.0.1"\n');
  chmodSync(join(binOldGraft, "graft"), 0o755);
  savedPath = process.env.PATH;
  savedHome = process.env.MYC_HOME;
  process.env.MYC_HOME = home;
  process.env.MYC_ACTOR = "tester";
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.MYC_HOME;
  else process.env.MYC_HOME = savedHome;
  delete process.env.MYC_ACTOR;
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Сторож детекторов
// ---------------------------------------------------------------------------

describe("детекторы ловят ровно ту ложь, что была в 0.3.0", () => {
  const OLD = [
    "[auto:degraded] graft.absent: graft недоступен: код-интеллект на builtin — символы по тексту для ts/tsx/js/jsx, callers/search/map недоступны",
    "WARN degraded.graft: graft не найден — код-интеллект на builtin (текст), callers/search/map недоступны",
    "builtin (code_intel=builtin, умолчание): символы и fan_in по тексту для ts/tsx/js/jsx/py — после `myc code index` (фон собирает сам, когда в репозитории есть якоря), callers/search/map недоступны",
  ];

  test("каждая прежняя строка отрицает все три возможности", () => {
    for (const line of OLD) {
      for (const cap of CAPS) expect({ line, cap, hit: denialsOf(line, cap).length > 0 }).toEqual({ line, cap, hit: true });
    }
  });

  test("неполный список языков пойман, полный — нет", () => {
    expect(incompleteLists(OLD[0]!)).toEqual(["ts/tsx/js/jsx — нет py"]);
    expect(incompleteLists(`символы для ${L1_LANGS_LABEL}`)).toEqual([]);
    expect(langLists(`символы для ${L1_LANGS_LABEL}`)).toEqual([L1_LANGS_LABEL]);
  });

  // Словарь отрицаний проверен мутацией на приёмке: «callers не поддерживаются»
  // и «callers unsupported» проходили guard, пока в DENIAL не было этих форм.
  test("отрицание другими словами — тоже отрицание", () => {
    for (const line of ["callers не поддерживаются", "code search unsupported", "map is not supported", "callers отсутствуют", "search disabled"]) {
      const cap = CAPS.find((c) => CAP_WORDS[c].test(line))!;
      expect({ line, hit: denialsOf(line, cap).length > 0 }).toEqual({ line, hit: true });
    }
  });

  test("утверждение о возможности без отрицания — не ложь", () => {
    expect(denialsOf("символы, callers, code search и code map для ts/tsx/js/jsx/py", "callers")).toEqual([]);
    expect(denialsOf("cmds: bootstrap,callers,code,init", "callers")).toEqual([]);
    expect(denialsOf("индекса graft/INDEX.md нет", "map")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Фикстура с L1: graft недоступен, builtin отвечает
// ---------------------------------------------------------------------------

describe("репозиторий на ts и py без graft: что ответило, то никто не отрицает", () => {
  let repo: string;
  const answered = new Set<Cap>();
  const surfaces: Surface[] = [];
  let noGraft: Registry;

  beforeAll(async () => {
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "invoice.ts"), TS);
    writeFileSync(join(repo, "src", "config.py"), PY);
    Bun.spawnSync(["git", "init", "-q", repo], { env: { ...process.env, PATH: savedPath ?? "" } });

    noGraft = registryWith(probeEnv(() => null, binNoGraft));

    await withPath(binNoGraft, async () => {
      // --- init: без него нет ни базы, ни индекса ------------------------
      const fresh = await myc(noGraft, repo, "init");
      expect(fresh.code).toBe(ExitCode.OK);
      surfaces.push({ name: "init (свежий отчёт, WARN)", text: textOf(fresh) });

      // --- ПОВЕДЕНИЕ: индекс, затем три вопроса ---------------------------
      const index = await myc(noGraft, repo, "code", "index");
      expect(index.code).toBe(ExitCode.OK);
      surfaces.push({ name: "code index", text: textOf(index) });

      const callersTs = await envelope(noGraft, repo, "callers", "parseInvoice");
      const callersPy = await envelope(noGraft, repo, "callers", "load_config");
      const callerNames = (e: Record<string, unknown>): string[] =>
        (((e["data"] ?? {}) as Record<string, unknown>)["edges"] as Array<{ caller: string }> | undefined)?.map(
          (x) => x.caller,
        ) ?? [];
      if (
        callersTs["ok"] === true &&
        callersPy["ok"] === true &&
        callerNames(callersTs).includes("renderInvoice") &&
        callerNames(callersPy).includes("main")
      ) {
        answered.add("callers");
      }

      const hitPaths = (e: Record<string, unknown>): string[] =>
        (((e["data"] ?? {}) as Record<string, unknown>)["hits"] as Array<{ path: string }> | undefined)?.map(
          (h) => h.path,
        ) ?? [];
      const searchTs = await envelope(noGraft, repo, "code", "search", "invoice");
      const searchPy = await envelope(noGraft, repo, "code", "search", "config");
      if (hitPaths(searchTs).includes("src/invoice.ts") && hitPaths(searchPy).includes("src/config.py")) {
        answered.add("search");
      }

      const map = await envelope(noGraft, repo, "code", "map");
      const md = (map["data"] ?? {}) as { files?: number; defs?: number; clusters?: unknown[] };
      if (map["ok"] === true && (md.files ?? 0) >= 2 && (md.defs ?? 0) >= 4 && (md.clusters?.length ?? 0) > 0) {
        answered.add("map");
      }

      // --- ТЕКСТЫ ПОВЕРХНОСТЕЙ — после того, как возможности ответили ------
      surfaces.push({ name: "bootstrap", text: textOf(await myc(noGraft, repo, "bootstrap")) });
      surfaces.push({ name: "init (повторный отчёт)", text: textOf(await myc(noGraft, repo, "init")) });
      surfaces.push({ name: "init --json", text: textOf(await myc(noGraft, repo, "init", "--json")) });
      for (const help of [["code", "index"], ["code", "fetch"], ["skeleton"], ["callers"]]) {
        surfaces.push({ name: `${help.join(" ")} --help`, text: textOf(await myc(noGraft, repo, ...help, "--help")) });
      }

      // init в режиме auto: graft в PATH нет — выбор объясняет себя в отчёте.
      writeFileSync(join(repo, ".myc", "config.json"), JSON.stringify({ code_intel: "auto" }));
      surfaces.push({ name: "init (auto без graft)", text: textOf(await myc(noGraft, repo, "init")) });
    });

    // init в режиме auto со старым graft: настоящий бинарь в PATH, отвечает 0.0.1.
    await withPath(binOldGraft, async () => {
      surfaces.push({ name: "init (auto со старым graft)", text: textOf(await myc(noGraft, repo, "init")) });
    });
    rmSync(join(repo, ".myc", "config.json"), { force: true });

    surfaces.push(...selectionSurfaces(repo, "ts+py"));
  });

  test("callers, code search и code map ответили по ts и по py", () => {
    // Guard не имеет права быть зелёным ни о чём: если возможность не
    // ответила, утверждать про её описание нечего — и это само по себе провал.
    expect([...answered].sort()).toEqual([...CAPS].sort());
  });

  test("ни одна поверхность не отрицает ответившую возможность", () => {
    expect(surfaces.length).toBeGreaterThanOrEqual(15);
    const lies = surfaces.flatMap((s) =>
      [...answered].flatMap((cap) => denialsOf(s.text, cap).map((c) => `${s.name} ⟶ ${cap}: «${c}»`)),
    );
    expect(lies).toEqual([]);
  });

  test("каждое перечисление языков — все L1_LANGS", () => {
    const withLists = surfaces.filter((s) => langLists(s.text).length > 0);
    // Сторож: перечисления в этой фикстуре есть (причина выбора, справка).
    expect(withLists.length).toBeGreaterThan(0);
    const bad = surfaces.flatMap((s) => incompleteLists(s.text).map((l) => `${s.name} ⟶ ${l}`));
    expect(bad).toEqual([]);
  });

  test("отсутствие необязательного graft не пишется в деградации", () => {
    const boot = surfaces.find((s) => s.name === "bootstrap")!.text;
    // Сторож: блок деградаций здесь есть (модель не уложена) — проверяется
    // содержимое настоящего блока, а не пустота.
    const degraded = blockLines(boot, "auto:degraded");
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.filter((l) => /graft/iu.test(l))).toEqual([]);

    const init = surfaces.find((s) => s.name === "init (свежий отчёт, WARN)")!.text;
    expect(init.split("\n").filter((l) => l.startsWith("WARN") && /graft/iu.test(l))).toEqual([]);
  });

  test("bootstrap без graft не рекламирует graft", () => {
    const boot = surfaces.find((s) => s.name === "bootstrap")!.text;
    expect(boot).not.toContain("[auto:graft]");
  });
});

// ---------------------------------------------------------------------------
// graft в PATH, индекса нет — рекламы нет; индекс есть — блок есть
// ---------------------------------------------------------------------------

describe("[auto:graft] только при graft/INDEX.md", () => {
  test("бинарь в PATH, индекса нет: блока нет — graft здесь ничего не найдёт", async () => {
    const dir = join(root, "bin-only");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "invoice.ts"), TS);
    const reg = registryWith(probeEnv((cmd) => (cmd === "graft" ? FAKE_GRAFT : null), "/opt/graft/bin"));
    const text = textOf(await myc(reg, dir, "bootstrap", "--no-cache"));
    expect(text).toContain("[auto:myc]"); // вывод есть — пустота не выдаётся за честность
    expect(text).not.toContain("[auto:graft]");
    expect(text).not.toContain(FAKE_GRAFT);
  });

  test("контроль: индекс есть — блок есть, с бинарём и без", async () => {
    const dir = join(root, "indexed");
    mkdirSync(join(dir, "graft"), { recursive: true });
    writeFileSync(join(dir, "graft", "INDEX.md"), "# graft\n");
    const withBin = registryWith(probeEnv((cmd) => (cmd === "graft" ? FAKE_GRAFT : null), "/opt/graft/bin"));
    const a = textOf(await myc(withBin, dir, "bootstrap", "--no-cache"));
    expect(a).toContain(`[auto:graft] bin=${FAKE_GRAFT} index=graft/`);

    const noBin = registryWith(probeEnv(() => null, "/usr/bin"));
    const b = textOf(await myc(noBin, dir, "bootstrap", "--no-cache"));
    expect(b).toContain("[auto:graft] bin=нет index=graft/");
    expect(b).toContain("граф есть, бинаря нет");
  });
});

// ---------------------------------------------------------------------------
// Дерево без L1: ветки строк, которых первая фикстура не печатает
// ---------------------------------------------------------------------------

describe("дерево без L1-файлов: перечисления полные, ответившая map не отрицается", () => {
  let repo: string;
  const answered = new Set<Cap>();
  const surfaces: Surface[] = [];

  beforeAll(async () => {
    repo = join(root, "no-l1");
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "main.rb"), "def total\n  1\nend\n");
    writeFileSync(join(repo, "README.md"), "# app\n");
    const reg = registryWith(probeEnv(() => null, binNoGraft));

    await withPath(binNoGraft, async () => {
      surfaces.push({ name: "init (без L1)", text: textOf(await myc(reg, repo, "init")) });
      const index = await myc(reg, repo, "code", "index");
      expect(index.code).toBe(ExitCode.OK);
      surfaces.push({ name: "code index (без L1)", text: textOf(index) });

      // Поведение: здесь callers и search честно не отвечают, map — отвечает.
      const callers = await envelope(reg, repo, "callers", "total");
      if (callers["ok"] === true) answered.add("callers");
      const search = await envelope(reg, repo, "code", "search", "total");
      if (search["ok"] === true) answered.add("search");
      const map = await envelope(reg, repo, "code", "map");
      if (map["ok"] === true && ((map["data"] as { files?: number }).files ?? 0) > 0) answered.add("map");

      surfaces.push({ name: "code symbol (без L1)", text: textOf(await myc(reg, repo, "code", "symbol", "total")) });
      surfaces.push({ name: "code fetch (без L1)", text: textOf(await myc(reg, repo, "code", "fetch")) });
      surfaces.push({ name: "bootstrap (без L1)", text: textOf(await myc(reg, repo, "bootstrap")) });
    });
    surfaces.push(...selectionSurfaces(repo, "без L1"));
  });

  test("отвечает ровно map: callers и search без символов отвечать не обязаны", () => {
    expect([...answered]).toEqual(["map"]);
  });

  test("ни одна поверхность не отрицает code map", () => {
    const lies = surfaces.flatMap((s) =>
      [...answered].flatMap((cap) => denialsOf(s.text, cap).map((c) => `${s.name} ⟶ ${cap}: «${c}»`)),
    );
    expect(lies).toEqual([]);
  });

  test("каждое перечисление языков — все L1_LANGS", () => {
    const withLists = surfaces.filter((s) => langLists(s.text).length > 0).map((s) => s.name);
    // Сторож: все четыре ветки, где список языков единственный смысл строки.
    for (const name of ["code index (без L1)", "code symbol (без L1)", "code fetch (без L1)", "без L1: selectCodeIntel(builtin).reason"]) {
      expect(withLists).toContain(name);
    }
    const bad = surfaces.flatMap((s) => incompleteLists(s.text).map((l) => `${s.name} ⟶ ${l}`));
    expect(bad).toEqual([]);
  });
});
