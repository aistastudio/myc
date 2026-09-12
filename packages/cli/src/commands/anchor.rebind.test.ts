/**
 * Приёмка ре-привязки якорей после рефакторинга (memory-5c03r9t5n472,
 * docs/design/01-core-data-model.md §7.3): код уехал в ДРУГОЙ файл — вынос
 * функции, переименование файла, разбиение модуля. Ступень 3 ищет его по
 * встроенному код-индексу (`code_files`, `code_units`/`code_fts`) вместо graft.
 *
 * Здесь — поведение через настоящую команду (`run()` по реестру): индекс
 * строит `myc code index`, якорь ставит `myc anchor add`, ре-привязывает
 * `myc anchor check`. Каждый сценарий — с мутацией, которая обязана его
 * ломать: без ступени 3 (`--level 3`) вынос теряется, с порогом 0 якорь уходит
 * на похожий чужой код.
 *
 * Замер доли восстановленных якорей на истории репозитория — отдельно,
 * bench/rebind-eval.ts: там сотни настоящих переездов, здесь — по одному на
 * каждый вид, с понятной причиной провала.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { openDrainHandle } from "../drain.ts";
import { createAnchorCommand, keyAfterMove, sweepAnchors } from "./anchor.ts";
import { createCodeCommand } from "./code.ts";
import { openDriver } from "./store.ts";
import { createTaskCommand } from "./tasks.ts";

const UTIL = `export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
`;

const FUSE_FN = `export function fuseRanked(lists: number[][], k = 60): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      const prev = score.get(id) ?? 0;
      score.set(id, prev + 1 / (k + rank + 1));
    });
  }
  return score;
}`;

const TOP_FN = `export function topN(score: Map<number, number>, n: number): number[] {
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, clamp(n, 1, 100))
    .map(([id]) => id);
}`;

const RANK = `// Ранжирование выдачи: слияние списков и срез верха.
import { clamp } from "./util.ts";

${FUSE_FN}

${TOP_FN}
`;

/**
 * Похожий по форме, но ЧУЖОЙ код: на него якорь уходить не имеет права.
 * Слово `lists` в сигнатуре делает его кандидатом поиска по тексту crux —
 * иначе порог нечем было бы проверить: до сравнения дело бы не дошло.
 * Сходство с fuseRanked — ~0.23 (точный Jaccard k-грамм), ниже порога 0.50.
 */
const OTHER = `// Сводка оценок по спискам.
export function mergeScoreLists(lists: string[][], bias = 40): Map<string, number> {
  const acc = new Map<string, number>();
  for (const group of lists) {
    group.forEach((item, pos) => {
      const was = acc.get(item) ?? 0;
      acc.set(item, was + 2 / (bias + pos + 2));
    });
  }
  return acc;
}

export function describeGroups(groups: string[][]): string {
  return groups.map((g) => g.join(",")).join(";");
}
`;

let dir: string;
let home: string;
let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-anchor-rebind-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "util.ts"), UTIL);
  writeFileSync(join(dir, "src", "rank.ts"), RANK);
  writeFileSync(join(dir, "src", "other.ts"), OTHER);
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createAnchorCommand());
  registry.register(createTaskCommand());
  registry.register(createCodeCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  warn?: Array<{ code: string; msg: string }>;
}

async function env(...args: string[]): Promise<Envelope> {
  const r = await myc(...args, "--json");
  const e = JSON.parse(r.stdout as string) as Envelope;
  expect(e.ok).toBe(true);
  return e;
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  return (await env(...args)).data;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"));
}

/** Строка файла, с которой начинается `needle` (1-based). */
function lineOf(text: string, needle: string): number {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no '${needle}' in fixture`);
  return i + 1;
}

/** Спан функции в тексте: от строки с сигнатурой до её закрывающей скобки. */
function spanOf(text: string, sig: string, body: string): string {
  const start = lineOf(text, sig);
  return `${start}-${start + body.split("\n").length - 1}`;
}

interface Row {
  repo_id: string;
  path: string;
  span_start: number;
  span_end: number;
  state: string;
  drift: number;
  symbol: string;
  fp: Uint8Array | null;
}

function anchorRow(id: string): Row {
  const d = db();
  try {
    return d
      .query("SELECT repo_id, path, span_start, span_end, state, drift, symbol, fp FROM anchors WHERE node_id = ?1")
      .get(id) as Row;
  } finally {
    d.close();
  }
}

interface Line {
  anchor_id: string;
  state: string;
  was: string;
  level: number;
  drift: number;
  from_path?: string;
  to_path?: string;
  via?: string;
  reason: string;
}

function lineFor(d: Record<string, unknown>, id: string): Line | undefined {
  return (d["changed"] as Line[]).find((c) => c.anchor_id === id);
}

/** Задача и якорь на fuseRanked при построенном индексе — начальное состояние всех сценариев. */
async function anchoredFuse(): Promise<{ task: string; anchor: string }> {
  await data("code", "index");
  const task = (await data("task", "Слияние ранжированных списков"))["id"] as string;
  const added = await data("anchor", "add", task, `src/rank.ts:${spanOf(RANK, "export function fuseRanked", FUSE_FN)}`);
  return { task, anchor: added["anchor_id"] as string };
}

// ---------------------------------------------------------------------------
// Привязка: отпечаток и имя символа
// ---------------------------------------------------------------------------

describe("привязка запоминает то, по чему якорь потом ищут", () => {
  test("anchor add пишет отпечаток (≤ 32×u32) и имя символа по код-индексу", async () => {
    const { anchor } = await anchoredFuse();
    const row = anchorRow(anchor);
    expect(row.symbol).toBe("fuseRanked");
    expect(row.fp).not.toBeNull();
    expect(row.fp!.length).toBeGreaterThan(0);
    expect(row.fp!.length).toBeLessThanOrEqual(128);
    expect(row.fp!.length % 4).toBe(0);
  });

  test("без индекса имя не выдумывается: символ пуст, отпечаток есть", async () => {
    const task = (await data("task", "задача"))["id"] as string;
    const added = await data("anchor", "add", task, `src/rank.ts:${spanOf(RANK, "export function fuseRanked", FUSE_FN)}`);
    const row = anchorRow(added["anchor_id"] as string);
    expect(row.symbol).toBe("");
    expect(row.fp).not.toBeNull();
  });

  test("отпечаток якоря, поставленного до этой задачи, досчитывается один раз", async () => {
    const { anchor } = await anchoredFuse();
    const d = db();
    d.query("UPDATE anchors SET fp = NULL WHERE node_id = ?1").run(anchor);
    d.close();
    const first = await data("anchor", "check");
    expect(first["fp_filled"]).toBe(1);
    expect(anchorRow(anchor).fp).not.toBeNull();
    const second = await data("anchor", "check");
    expect(second["fp_filled"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ступень 3: код в другом файле
// ---------------------------------------------------------------------------

/** rank.ts без fuseRanked (она уехала), fuse.ts — с ней. */
function extractFuse(): void {
  writeFileSync(
    join(dir, "src", "rank.ts"),
    `// Ранжирование выдачи: срез верха.\nimport { clamp } from "./util.ts";\nexport { fuseRanked } from "./fuse.ts";\n\n${TOP_FN}\n`,
  );
  writeFileSync(join(dir, "src", "fuse.ts"), `// Слияние ранжированных списков (RRF).\n\n${FUSE_FN}\n`);
}

describe("вынос функции в другой файл", () => {
  test("тело то же — drifted с новым путём, откуда → куда названо", async () => {
    const { task, anchor } = await anchoredFuse();
    extractFuse();
    await data("code", "index");
    const e = await env("anchor", "check");
    const line = lineFor(e.data, anchor);
    expect(line).toMatchObject({ state: "drifted", level: 4, from_path: "src/rank.ts", to_path: "src/fuse.ts" });
    expect(line!.drift).toBe(1);
    expect(line!.via).toBe("symbol fuseRanked");
    expect(e.data["found_elsewhere"]).toBe(1);
    expect((e.warn ?? []).map((w) => w.code)).toContain("anchor.moved");

    const row = anchorRow(anchor);
    const fuse = readFileSync(join(dir, "src", "fuse.ts"), "utf8");
    expect(row).toMatchObject({ path: "src/fuse.ts", state: "drifted", span_start: lineOf(fuse, "export function fuseRanked") });
    // Обратный ход код → знание находит задачу уже по новому месту.
    const of = await data("anchor", "of", `src/fuse.ts:${row.span_start + 1}`);
    const spans = of["spans"] as Array<{ anchor_id: string; nodes: Array<{ id: string }> }>;
    expect(spans.map((s) => s.anchor_id)).toContain(anchor);
    expect(spans.find((s) => s.anchor_id === anchor)!.nodes.map((n) => n.id)).toContain(task);
  });

  test("переезд не тихий: вывод человеку, заголовок узла и attrs.moved", async () => {
    const { anchor } = await anchoredFuse();
    extractFuse();
    await data("code", "index");
    const r = await myc("anchor", "check");
    expect(r.stdout as string).toContain(`moved src/rank.ts:${spanOf(RANK, "export function fuseRanked", FUSE_FN)} → src/fuse.ts:`);
    const d = db();
    try {
      const node = d.query("SELECT title, status, attrs FROM nodes WHERE id = ?1").get(anchor) as {
        title: string;
        status: string;
        attrs: string;
      };
      expect(node.title.startsWith("src/fuse.ts:")).toBe(true);
      expect(node.status).toBe("drifted");
      const moved = (JSON.parse(node.attrs) as { moved: { from: string; to: string; drift: number } }).moved;
      expect(moved.from.startsWith("src/rank.ts:")).toBe(true);
      expect(moved.to.startsWith("src/fuse.ts:")).toBe(true);
      expect(moved.drift).toBe(1);
    } finally {
      d.close();
    }
  });

  test("якорь на ОСТАВШУЮСЯ в файле функцию не трогается ступенью 3", async () => {
    await data("code", "index");
    const task = (await data("task", "срез"))["id"] as string;
    const top = (await data("anchor", "add", task, `src/rank.ts:${spanOf(RANK, "export function topN", TOP_FN)}`))[
      "anchor_id"
    ] as string;
    extractFuse();
    await data("code", "index");
    const d = await data("anchor", "check");
    expect(lineFor(d, top)).toMatchObject({ state: "fresh", level: 3 });
    expect(anchorRow(top).path).toBe("src/rank.ts");
  });

  test("МУТАЦИЯ: без ступени 3 (--level 3) вынос теряется — якорь stale на старом пути", async () => {
    const { anchor } = await anchoredFuse();
    extractFuse();
    await data("code", "index");
    const d = await data("anchor", "check", "--level", "3");
    expect(lineFor(d, anchor)).toMatchObject({ state: "stale" });
    expect(lineFor(d, anchor)!.to_path).toBeUndefined();
    expect(anchorRow(anchor).path).toBe("src/rank.ts");
  });
});

describe("переименование файла", () => {
  test("функция переименована вместе с файлом — восстановлена по тексту crux", async () => {
    const { anchor } = await anchoredFuse();
    unlinkSync(join(dir, "src", "rank.ts"));
    writeFileSync(
      join(dir, "src", "scoring.ts"),
      RANK.replace("export function fuseRanked", "export function combineRanks"),
    );
    await data("code", "index");
    const d = await data("anchor", "check");
    const line = lineFor(d, anchor);
    expect(line).toMatchObject({ state: "drifted", level: 4, from_path: "src/rank.ts", to_path: "src/scoring.ts" });
    expect(line!.drift).toBeGreaterThanOrEqual(0.5);
    expect(line!.drift).toBeLessThan(1);
    expect(line!.via!.startsWith("text")).toBe(true);
  });

  test("чистое переименование (git mv без правки) — найдено по хешу содержимого", async () => {
    const { anchor } = await anchoredFuse();
    mkdirSync(join(dir, "src", "ranking"));
    renameSync(join(dir, "src", "rank.ts"), join(dir, "src", "ranking", "rank.ts"));
    await data("code", "index");
    const d = await data("anchor", "check");
    expect(lineFor(d, anchor)).toMatchObject({
      state: "drifted",
      from_path: "src/rank.ts",
      to_path: "src/ranking/rank.ts",
      via: "rename",
      drift: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Не нашли: lost против stale
// ---------------------------------------------------------------------------

function deleteFuse(): void {
  writeFileSync(join(dir, "src", "rank.ts"), RANK.replace(`${FUSE_FN}\n\n`, ""));
}

function edgeAttrs(task: string, anchor: string): Record<string, unknown> {
  const d = db();
  try {
    const row = d
      .query("SELECT attrs FROM edges WHERE src = ?1 AND dst = ?2 AND type = 'touches'")
      .get(task, anchor) as { attrs: string };
    return JSON.parse(row.attrs) as Record<string, unknown>;
  } finally {
    d.close();
  }
}

describe("функция удалена", () => {
  test("индекс видел удаление — lost, рёбра touches помечены suspect", async () => {
    const { task, anchor } = await anchoredFuse();
    deleteFuse();
    await data("code", "index");
    const e = await env("anchor", "check");
    expect(lineFor(e.data, anchor)).toMatchObject({ state: "lost" });
    expect((e.warn ?? []).map((w) => w.code)).toContain("anchor.stale");
    expect(edgeAttrs(task, anchor)["suspect"]).toBe(1);
    const d = db();
    expect((d.query("SELECT status FROM nodes WHERE id = ?1").get(anchor) as { status: string }).status).toBe("lost");
    d.close();
  });

  test("индекс ещё не видел правку — stale, а не lost; после обновления индекса — lost", async () => {
    const { task, anchor } = await anchoredFuse();
    deleteFuse();
    const first = await data("anchor", "check");
    expect(lineFor(first, anchor)).toMatchObject({ state: "stale" });
    expect(lineFor(first, anchor)!.reason).toContain("has not seen this change");
    expect(edgeAttrs(task, anchor)["suspect"]).toBe(1);
    // Файл с тех пор не менялся — вердикт «здесь текста нет» в силе.
    const second = await data("anchor", "check");
    expect(second["stale"]).toBe(1);
    expect(second["fresh"]).toBe(0);
    await data("code", "index");
    const third = await data("anchor", "check");
    expect(lineFor(third, anchor)).toMatchObject({ state: "lost", was: "stale" });
  });

  test("индекса нет вовсе — stale с причиной, файл пропал", async () => {
    const task = (await data("task", "задача"))["id"] as string;
    const anchor = (
      await data("anchor", "add", task, `src/rank.ts:${spanOf(RANK, "export function fuseRanked", FUSE_FN)}`)
    )["anchor_id"] as string;
    unlinkSync(join(dir, "src", "rank.ts"));
    const d = await data("anchor", "check");
    expect(lineFor(d, anchor)).toMatchObject({ state: "stale", level: 0 });
    expect(lineFor(d, anchor)!.reason).toContain("no code index");
  });

  test("найден снова — пометка suspect снимается", async () => {
    const { task, anchor } = await anchoredFuse();
    deleteFuse();
    await data("anchor", "check");
    expect(edgeAttrs(task, anchor)["suspect"]).toBe(1);
    writeFileSync(join(dir, "src", "rank.ts"), RANK);
    const d = await data("anchor", "check");
    expect(lineFor(d, anchor)).toMatchObject({ state: "fresh", was: "stale" });
    expect(edgeAttrs(task, anchor)["suspect"]).toBeUndefined();
  });
});

/** Тело fuseRanked переписано примерно на 60 %: сигнатура, `score` и `return` остались. */
const FUSE_60 = `export function fuseRanked(lists: number[][], k = 60): Map<number, number> {
  const score = new Map<number, number>();
  lists.flat().forEach((id, pos) => {
    score.set(id, (score.get(id) ?? 0) + 1 / (k + pos + 1));
  });
  return score;
}`;

describe("порог: ложная привязка хуже потери", () => {
  test("тело изменено на 60 % — к похожему ЧУЖОМУ коду якорь не уходит (lost на прежнем пути)", async () => {
    const { anchor } = await anchoredFuse();
    writeFileSync(join(dir, "src", "rank.ts"), RANK.replace(FUSE_FN, FUSE_60));
    await data("code", "index");
    const d = await data("anchor", "check");
    const line = lineFor(d, anchor);
    expect(line).toMatchObject({ state: "lost" });
    expect(line!.to_path).toBeUndefined();
    expect(anchorRow(anchor).path).toBe("src/rank.ts");
  });

  test("МУТАЦИЯ: пороги ступени 3 сняты (0) — якорь уезжает на чужой mergeScoreLists", async () => {
    const { anchor } = await anchoredFuse();
    writeFileSync(join(dir, "src", "rank.ts"), RANK.replace(FUSE_FN, FUSE_60));
    await data("code", "index");
    const d = await sweepWith({ elsewhereMin: 0, textMin: 0 });
    {
      const line = d.changed.find((c) => c.anchor_id === anchor)!;
      expect(line.state).toBe("drifted");
      expect(line.to_path).toBe("src/other.ts");
      // Сходство, на котором он уехал, — ниже боевого порога: именно его порог и отсекает.
      expect(line.drift).toBeLessThan(0.5);
    }
  });

  /** Та же функция по ИМЕНИ в другом файле, но с чужим телом. */
  const IMPOSTOR = `// Совсем другой код под тем же именем.
export function fuseRanked(input: string): string {
  return input
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0)
    .join(";");
}
`;

  test("то же имя, чужое тело — не привязывается и по имени (lost)", async () => {
    const { anchor } = await anchoredFuse();
    deleteFuse();
    writeFileSync(join(dir, "src", "legacy.ts"), IMPOSTOR);
    await data("code", "index");
    const d = await data("anchor", "check");
    const line = lineFor(d, anchor)!;
    expect(line.state).toBe("lost");
    expect(line.to_path).toBeUndefined();
    expect(line.reason).toContain("candidate");
  });

  test("МУТАЦИЯ: общий порог ступени 3 равен 0 — якорь уезжает к самозванцу по имени", async () => {
    const { anchor } = await anchoredFuse();
    deleteFuse();
    writeFileSync(join(dir, "src", "legacy.ts"), IMPOSTOR);
    await data("code", "index");
    const line = (await sweepWith({ elsewhereMin: 0 })).changed.find((c) => c.anchor_id === anchor)!;
    expect(line).toMatchObject({ state: "drifted", to_path: "src/legacy.ts", via: "symbol fuseRanked" });
    expect(line.drift).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Пойманные замером ложные привязки (bench/rebind-eval.json) — слабая улика
// ---------------------------------------------------------------------------

/**
 * Оба случая взяты из истории репозитория ДОСЛОВНО (anchor.rebind.fixtures/):
 * до правил слабой улики замер привязывал удалённый код к чужому.
 *
 *  grammarDir — 68ccb9b: функцию разнесли по трём в новом grammars.ts, и
 *    ступень 3 по одним словам crux (MYC_TREE_SITTER_GRAMMAR_DIR,
 *    fileURLToPath, resolveSync) сажала якорь на окно через три чужие функции
 *    со сходством 0.594. Правило: кандидат только по словам — от 0.65.
 *  codexNotify — a9982e7: функция из одной шаблонной строки удалена, и шаг 2
 *    в том же файле сажал её на соседний шаблон opencodePlugin со сходством
 *    0.688: после нормализации (строк нет) от обоих остался скелет. Правило:
 *    окно без других улик должно быть кодом — доля кода ≥ 0.25 (здесь 0.07).
 */
const FIXTURES = join(import.meta.dir, "anchor.rebind.fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

async function caughtCase(
  before: Record<string, string>,
  after: Record<string, string>,
  target: string,
): Promise<string> {
  for (const [p, name] of Object.entries(before)) writeFileSync(join(dir, p), fixture(name));
  await data("code", "index");
  const task = (await data("task", "пойманный случай"))["id"] as string;
  const anchor = (await data("anchor", "add", task, target))["anchor_id"] as string;
  for (const [p, name] of Object.entries(after)) writeFileSync(join(dir, p), fixture(name));
  await data("code", "index");
  return anchor;
}

async function sweepWith(rebind: NonNullable<Parameters<typeof sweepAnchors>[1]["rebind"]>) {
  const dbPath = join(dir, ".myc", "myc.db");
  const driver = openDriver(dbPath);
  const h = openDrainHandle(driver, dbPath, { MYC_ACTOR: "tester" });
  try {
    return await sweepAnchors(h, { wsDir: dir, rebind });
  } finally {
    h.close();
  }
}

const GRAMMAR_DIR = {
  before: { "src/symbols.ts": "symbols.before.ts.txt" },
  after: { "src/symbols.ts": "symbols.after.ts.txt", "src/grammars.ts": "grammars.after.ts.txt" },
  // grammarDir — строки 195–211 исходного файла, 31–47 выдержки.
  target: "src/symbols.ts:31-47",
};

const CODEX_NOTIFY = {
  before: { "src/templates.ts": "templates.before.ts.txt" },
  after: { "src/templates.ts": "templates.after.ts.txt" },
  target: "src/templates.ts:1-52",
};

describe("слабая улика: пойманные ложные привязки удалённого кода", () => {
  test("grammarDir: по одним словам crux (0.594 < 0.65) якорь в grammars.ts не уходит — lost", async () => {
    const anchor = await caughtCase(GRAMMAR_DIR.before, GRAMMAR_DIR.after, GRAMMAR_DIR.target);
    const line = lineFor(await data("anchor", "check"), anchor)!;
    expect(line.state).toBe("lost");
    expect(line.to_path).toBeUndefined();
    expect(line.reason).toContain("found only by crux words");
    expect(anchorRow(anchor).path).toBe("src/symbols.ts");
  });

  test("МУТАЦИЯ: порог слов crux 0.50 (как до правила) — grammarDir уезжает на окно чужих функций", async () => {
    const anchor = await caughtCase(GRAMMAR_DIR.before, GRAMMAR_DIR.after, GRAMMAR_DIR.target);
    const line = (await sweepWith({ textMin: 0.5 })).changed.find((c) => c.anchor_id === anchor)!;
    expect(line).toMatchObject({ state: "drifted", level: 4, to_path: "src/grammars.ts" });
    expect(line.via!.startsWith("text")).toBe(true);
    expect(line.drift).toBeGreaterThanOrEqual(0.5);
    expect(line.drift).toBeLessThan(0.65);
  });

  test("codexNotify: шаблон не садится на соседний шаблон (доля кода 0.07 < 0.25) — lost", async () => {
    const anchor = await caughtCase(CODEX_NOTIFY.before, CODEX_NOTIFY.after, CODEX_NOTIFY.target);
    const line = lineFor(await data("anchor", "check"), anchor)!;
    expect(line.state).toBe("lost");
    expect(line.reason).toContain("mostly strings/comments");
    expect(anchorRow(anchor)).toMatchObject({ path: "src/templates.ts", span_start: 1, span_end: 52 });
  });

  test("МУТАЦИЯ: правила доли кода нет — codexNotify шагом 2 садится на opencodePlugin (0.688)", async () => {
    const anchor = await caughtCase(CODEX_NOTIFY.before, CODEX_NOTIFY.after, CODEX_NOTIFY.target);
    const line = (await sweepWith({ minCodeShare: 0 })).changed.find((c) => c.anchor_id === anchor)!;
    expect(line).toMatchObject({ state: "drifted", level: 3 });
    expect(line.drift).toBeGreaterThanOrEqual(0.6);
  });
});

// ---------------------------------------------------------------------------
// stale держится, пока файл не менялся (дефект до этой задачи)
// ---------------------------------------------------------------------------

describe("stale переживает следующий прогон", () => {
  test("тело переписано, файл больше не трогали — второй check не объявляет якорь fresh", async () => {
    const task = (await data("task", "задача"))["id"] as string;
    const anchor = (
      await data("anchor", "add", task, `src/rank.ts:${spanOf(RANK, "export function fuseRanked", FUSE_FN)}`)
    )["anchor_id"] as string;
    writeFileSync(
      join(dir, "src", "rank.ts"),
      RANK.replace(FUSE_FN, "export function fuseRanked(): Map<number, number> {\n  throw new Error('gone');\n}"),
    );
    const first = await data("anchor", "check");
    expect(lineFor(first, anchor)).toMatchObject({ state: "stale" });
    const second = await data("anchor", "check");
    expect(second["stale"]).toBe(1);
    expect(second["fresh"]).toBe(0);
    expect(anchorRow(anchor).state).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// Горячий путь: ре-привязка только в check/фоне
// ---------------------------------------------------------------------------

describe("ре-привязка — вне горячего пути", () => {
  test("модуль ступени 3 не грузится статически: хук touch не платит за его граф модулей", () => {
    // Шапка anchor.ts: всё тяжёлое грузится ВНУТРИ обработчиков — статический
    // импорт тянется в каждый вызов `myc anchor touch` (хук на каждую правку).
    const src = readFileSync(join(import.meta.dir, "anchor.ts"), "utf8");
    expect(src).not.toMatch(/^import[^;]*["']@myc\/code-intel\/rebind["']/m);
    expect(src).not.toMatch(/^import[^;]*["']@myc\/code-intel\/refresh["']/m);
    expect(src).toContain('import("@myc/code-intel/rebind")');
  });

  test("touch и of после выноса функции якорь не двигают: это делает только check", async () => {
    const { anchor } = await anchoredFuse();
    extractFuse();
    await data("code", "index");
    await data("anchor", "touch", "src/rank.ts", "src/fuse.ts");
    await data("anchor", "of", "src/rank.ts");
    await data("anchor", "of", "src/fuse.ts:5");
    expect(anchorRow(anchor)).toMatchObject({ path: "src/rank.ts", state: "fresh" });
    const d = await data("anchor", "check");
    expect(d["from_dirty"]).toBe(1);
    expect(anchorRow(anchor)).toMatchObject({ path: "src/fuse.ts", state: "drifted" });
  });
});

// ---------------------------------------------------------------------------
// Ключ якоря после переезда (вложенные репозитории, S59)
// ---------------------------------------------------------------------------

describe("keyAfterMove: ключ записи сохраняется, пока файл в том же репозитории", () => {
  test("корень остаётся корнем", () => {
    expect(keyAfterMove("", "alpha/src/y.ts")).toEqual({ repoId: "", path: "alpha/src/y.ts" });
  });
  test("внутри того же вложенного репозитория — его ключ", () => {
    expect(keyAfterMove("alpha", "alpha/src/y.ts")).toEqual({ repoId: "alpha", path: "src/y.ts" });
  });
  test("уехал в другой репозиторий — ключ корня, а не чужой префикс", () => {
    expect(keyAfterMove("alpha", "beta/z.ts")).toEqual({ repoId: "", path: "beta/z.ts" });
    expect(keyAfterMove("alpha", "alphabet/z.ts")).toEqual({ repoId: "", path: "alphabet/z.ts" });
  });
});
