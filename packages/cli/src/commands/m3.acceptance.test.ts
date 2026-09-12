/**
 * ПРИЁМКА ВЕХИ M3 (memory-apq1h7wra93w): связь код ↔ знание в обе стороны, на
 * реальном коде, с корректным поведением после рефакторинга.
 *
 * ПОЧЕМУ ТЕСТ, А НЕ СКРИПТ В bench/. Приёмка — да/нет с причиной, а не число:
 * «после выноса функции задача снова видна от символа» либо верно, либо нет.
 * Замер доли восстановленных якорей по истории — отдельный вопрос, и он уже
 * отвечен (bench/rebind-eval.ts: 43/49). Тест же гоняется в каждом `bun test`,
 * падает на регрессии любого из шести звеньев цепочки и несёт мутации, которые
 * обязаны его ронять.
 *
 * РЕАЛЬНЫЙ КОД. Временный git-репозиторий собран из исходников ЭТОГО
 * репозитория на a85a510 (m3.acceptance.fixtures/): `src/view.ts` —
 * packages/code-intel/src/view.ts целиком, `src/read.ts` — первые 169 строк
 * packages/code-intel/src/read.ts (читатели, зовущие `prefixEnd`). Снимок, а не
 * чтение живых файлов: иначе правка view.ts ломала бы приёмку без причины.
 *
 * СЦЕНАРИЙ (git — настоящий, индекс и якоря — настоящие команды):
 *   0. `myc code index`; решение D с якорем на `prefixEnd`, задача T с якорем
 *      на её тело, контрольное решение C с якорем на `stripPrefix` — тот же
 *      вопрос, слабее по тексту;
 *   1. код → знание: `code symbol prefixEnd` отдаёт D и T и fan_in из индекса;
 *      знание → код: `anchor of src/view.ts` называет символ, `show T` — место;
 *   2. рефакторинг одним коммитом: `prefixEnd` вынесена в `src/range.ts`,
 *      `view.ts` переименован в `code-view.ts` (git mv), импорты поправлены;
 *   3. индекс обновляет ФОН: дренаж ставит `code_refresh`, исполнитель
 *      (`code index --job`) сверяет дерево и пересчитывает fan_in;
 *   4. `anchor check` — ступень 3 (0403533) переносит якоря D и T в range.ts;
 *   5. связь снова верна с обеих сторон: символ в range.ts → D, T; range.ts →
 *      символ и узлы; `show T` — новое место и откуда переехал; fan_in новый;
 *      C переехал вслед за переименованием и жив;
 *   6. функцию удаляют совсем → индекс (явно) → check: якоря D и T — lost,
 *      рёбра touches — suspect, `recall` находит D, но НИЖЕ живого C (до
 *      удаления D стоял выше).
 *
 * МУТАЦИИ (каждая — отдельный тест ниже, с местом, где рвётся цепочка):
 *   «без ступени 3» (`anchor check --level 3`) — якоря остаются на
 *     исчезнувшем view.ts (stale), символ в range.ts знания не видит;
 *   «фон не обновил индекс» — исполнитель не запущен: индекс не знает range.ts,
 *     якорь stale, `code symbol` отвечает старым местом, fan_in не пересчитан;
 *   «состояние якоря не влияет на ранг» (NO_ANCHOR_WEIGHT_OVERRIDES через
 *     hybrid.anchor.test.ts) — здесь проверяется порядок, который она ломает.
 *
 * `show` задачи печатает путь, состояние и «moved from» — правка агента
 * полировки якорей (show.ts); символа `show` не печатает, его называет
 * `anchor of` (и `code symbol` с обратной стороны).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { drainQueueTail, type ClaimedJob } from "../drain.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createCodeCommand } from "./code.ts";
import { createRecallCommand } from "./recall.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { createShowCommand } from "./show.ts";
import { realStoreDeps } from "./store.ts";
import { createCreateCommand, createTaskCommand } from "./tasks.ts";

const FIXTURES = join(import.meta.dir, "m3.acceptance.fixtures");
const VIEW = readFileSync(join(FIXTURES, "view.ts.txt"), "utf8");
const READ = readFileSync(join(FIXTURES, "read.ts.txt"), "utf8");

/** `prefixEnd` в снимке view.ts: док-комментарий строкой выше, тело — 4 строки. */
const PREFIX_END = `/** Верхняя граница отрезка путей: \`R/\` → \`R0\`. Для пустого префикса не зовётся. */
export function prefixEnd(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}
`;

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

function lineOf(text: string, needle: string): number {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no '${needle}' in text`);
  return i + 1;
}

let dir: string;
let home: string;

function registry(): Registry {
  const r = new Registry();
  const deps: RetrieveDeps = {
    openStore: realStoreDeps.openStore,
    ...realRetrieveExtras,
    resolveEmbedder: async () => ({ ok: false, reason: "в приёмке эмбеддер отключён: ранжирует лексика" }),
  };
  r.register(createCodeCommand());
  r.register(createAnchorCommand());
  r.register(createTaskCommand());
  r.register(createCreateCommand());
  r.register(createShowCommand());
  r.register(createRecallCommand(deps));
  return r;
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  warn?: Array<{ code: string; msg: string }>;
  error?: { code: string; msg: string };
}

async function envOf(...args: string[]): Promise<Envelope> {
  const r = await run(["-C", dir, ...args, "--json"], {
    registry: registry(),
    env: { MYC_ACTOR: "tester", MYC_HOME: home },
  });
  return JSON.parse(String(r.stdout)) as Envelope;
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const e = await envOf(...args);
  if (!e.ok) throw new Error(`${args.join(" ")}: ${JSON.stringify(e.error)}`);
  return e.data;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"));
}

/** Узел якоря, к которому от знания идёт `touches` (у каждого — один). */
function anchorOf(owner: string): string {
  const d = db();
  try {
    return (d.query("SELECT dst FROM edges WHERE src = ?1 AND type = 'touches'").get(owner) as { dst: string }).dst;
  } finally {
    d.close();
  }
}

function anchorRow(anchor: string): { path: string; state: string; drift: number; symbol: string } {
  const d = db();
  try {
    return d.query("SELECT path, state, drift, symbol FROM anchors WHERE node_id = ?1").get(anchor) as {
      path: string;
      state: string;
      drift: number;
      symbol: string;
    };
  } finally {
    d.close();
  }
}

/** Мера сходства, с которой якорь переехал (attrs.moved узла якоря). */
function anchorRowDrift(anchor: string): string {
  const d = db();
  try {
    const row = d.query("SELECT attrs FROM nodes WHERE id = ?1").get(anchor) as { attrs: string };
    const moved = (JSON.parse(row.attrs) as { moved?: { drift?: number; via?: string } }).moved;
    return moved === undefined ? "(no move)" : `${moved.drift} via ${moved.via}`;
  } finally {
    d.close();
  }
}

function suspect(owner: string, anchor: string): unknown {
  const d = db();
  try {
    const row = d.query("SELECT attrs FROM edges WHERE src = ?1 AND dst = ?2 AND type = 'touches'").get(owner, anchor) as {
      attrs: string;
    };
    return (JSON.parse(row.attrs) as Record<string, unknown>)["suspect"];
  } finally {
    d.close();
  }
}

interface Knowledge {
  id: string;
  state: string;
  suspect: boolean;
  anchor: string;
}

async function symbol(name: string): Promise<{ defs: Array<{ path: string; knowledge: Knowledge[] }>; fan_in?: { n: number; files: number } }> {
  return (await data("code", "symbol", name)) as never;
}

interface OfSpan {
  anchor_id: string;
  symbol: string;
  state: string;
  nodes: Array<{ id: string }>;
}

async function anchorsOf(path: string): Promise<OfSpan[]> {
  return (await data("anchor", "of", path))["spans"] as OfSpan[];
}

/** Ранги D и C в выдаче recall по одному и тому же вопросу. */
async function ranks(d: string, c: string): Promise<{ d: number; c: number }> {
  const rows = (await data("recall", "верхняя граница отрезка путей", "--mode", "bm25", "--repo", "all", "-n", "20"))[
    "rows"
  ] as Array<{ id: string; rank: number }>;
  const at = (id: string): number => rows.find((r) => r.id === id)?.rank ?? -1;
  return { d: at(d), c: at(c) };
}

/** Фоновое обновление индекса: дренаж ставит и захватывает `code_refresh`, исполнитель — та же команда с `--job`. */
async function backgroundRefresh(): Promise<Record<string, unknown>> {
  const spawned: ClaimedJob[] = [];
  const r = await drainQueueTail({
    dbPath: join(dir, ".myc", "myc.db"),
    env: { MYC_CODE_INDEX_PERIOD_MS: "0" },
    spawnCodeIndex: (_db, job) => void spawned.push(job),
  });
  expect(r.codeIndex?.spawned).toBe(true);
  expect(spawned.length).toBe(1);
  const job = await data("code", "index", "--job", String(spawned[0]!.id), "--holder", spawned[0]!.holder);
  expect(job["taken"]).toBe(true);
  return (job["runs"] as Array<Record<string, unknown>>)[0]!;
}

interface Start {
  decision: string;
  task: string;
  control: string;
  dAnchor: string;
  tAnchor: string;
  cAnchor: string;
}

/** Шаги 0–1: индекс, знание с якорями, связь в обе стороны на исходном коде. */
async function start(): Promise<Start> {
  await data("code", "index");
  const pe = lineOf(VIEW, "export function prefixEnd");
  const sp = lineOf(VIEW, "export function stripPrefix");
  const decision = (
    await data(
      "create",
      "Диапазон путей префикса: верхняя граница отрезка путей",
      "--kind",
      "decision",
      "-b",
      "верхняя граница отрезка путей — prefixEnd: R/ даёт R0, и отрезок [R/, R0) идёт по ключу, а не LIKE",
      "--anchor",
      `src/view.ts:${pe}-${pe + 3}`,
    )
  )["id"] as string;
  const task = (
    await data("task", "Проверить prefixEnd на последнем символе U+FFFF", "--anchor", `src/view.ts:${pe + 1}-${pe + 2}`)
  )["id"] as string;
  const control = (
    await data(
      "create",
      "Путь без префикса вида",
      "--kind",
      "decision",
      "-b",
      "stripPrefix снимает префикс вида; верхняя граница отрезка путей ему не нужна",
      "--anchor",
      `src/view.ts:${sp}-${sp + 2}`,
    )
  )["id"] as string;
  const s: Start = {
    decision,
    task,
    control,
    dAnchor: anchorOf(decision),
    tAnchor: anchorOf(task),
    cAnchor: anchorOf(control),
  };

  // Код → знание: символ отвечает знанием, привязанным к его спану, и числом fan_in из индекса.
  const sym = await symbol("prefixEnd");
  expect(sym.defs.map((x) => x.path)).toEqual(["src/view.ts"]);
  expect(sym.defs[0]!.knowledge.map((k) => k.id).sort()).toEqual([decision, task].sort());
  expect(sym.defs[0]!.knowledge.every((k) => k.state === "fresh" && !k.suspect)).toBe(true);
  // view.ts: вызов в coveringAncestor; read.ts: import и два вызова. Строка определения не в счёт.
  expect(sym.fan_in).toMatchObject({ n: 4, files: 2 });

  // Знание → код: файл называет символ и узлы; задача — своё место.
  const spans = await anchorsOf("src/view.ts");
  const d = spans.find((x) => x.anchor_id === s.dAnchor)!;
  expect(d.symbol).toBe("prefixEnd");
  expect(d.nodes.map((n) => n.id)).toContain(decision);
  expect(spans.find((x) => x.anchor_id === s.tAnchor)!.nodes.map((n) => n.id)).toContain(task);
  const shown = (await data("show", task))["anchors"] as Array<{ node_id?: string; path?: string; state: string }>;
  expect(shown.find((a) => a.node_id === s.tAnchor)).toMatchObject({ path: "src/view.ts", state: "fresh" });
  return s;
}

/** Шаг 2: вынос функции в range.ts и переименование view.ts → code-view.ts, одним коммитом. */
function refactor(): void {
  git(dir, "mv", "src/view.ts", "src/code-view.ts");
  const view = VIEW.replace(PREFIX_END, 'export { prefixEnd } from "./range.ts";\n').replace(
    'import type { Database } from "bun:sqlite";',
    'import type { Database } from "bun:sqlite";\nimport { prefixEnd } from "./range.ts";',
  );
  expect(view).not.toContain("export function prefixEnd");
  writeFileSync(join(dir, "src", "code-view.ts"), view);
  writeFileSync(join(dir, "src", "range.ts"), `// Отрезок путей по первичному ключу — вынесено из code-view.ts.\n\n${PREFIX_END}`);
  writeFileSync(join(dir, "src", "read.ts"), READ.replace('from "./view.ts"', 'from "./code-view.ts"'));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "extract prefixEnd into range.ts, rename view.ts");
}

/** Шаг 6: функцию удаляют совсем — отрезок строится иначе, range.ts больше нет. */
function removePrefixEnd(): void {
  unlinkSync(join(dir, "src", "range.ts"));
  const view = readFileSync(join(dir, "src", "code-view.ts"), "utf8")
    .replace('export { prefixEnd } from "./range.ts";\n', "")
    .replace('import { prefixEnd } from "./range.ts";\n', "")
    .replace("prefixEnd(prefix)", "`${prefix}\\uffff`");
  writeFileSync(join(dir, "src", "code-view.ts"), view);
  const read = readFileSync(join(dir, "src", "read.ts"), "utf8")
    .replace("prefixEnd, ", "")
    .replaceAll("prefixEnd(v.prefix)", "`${v.prefix}\\uffff`");
  expect(read).not.toContain("prefixEnd");
  writeFileSync(join(dir, "src", "read.ts"), read);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "drop prefixEnd: the range ends at U+FFFF");
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "myc-m3-accept-")));
  home = join(dir, ".home");
  mkdirSync(home);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, ".gitignore"), ".myc/\n.home/\n");
  writeFileSync(join(dir, "src", "view.ts"), VIEW);
  writeFileSync(join(dir, "src", "read.ts"), READ);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "real fragment of myc at a85a510");
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("приёмка M3: от символа к решениям и обратно, через рефакторинг и удаление", () => {
  test("сценарий целиком", async () => {
    const s = await start();
    // До всего: D (сильнее по тексту — слова вопроса в заголовке) выше C.
    const before = await ranks(s.decision, s.control);
    expect(before.d).toBeGreaterThan(0);
    expect(before.d).toBeLessThan(before.c);

    // 2–3. Рефакторинг, индекс — фоном; fan_in пересчитан тем же прогоном.
    refactor();
    const pass = await backgroundRefresh();
    expect(pass["fan_in"]).toMatchObject({ ran: true, reason: "missing" });

    // 4. Ступень 3: якоря D и T уехали за функцией в range.ts, C — за переименованием.
    const check = await data("anchor", "check");
    const changed = check["changed"] as Array<{ anchor_id: string; state: string; to_path?: string; via?: string }>;
    for (const a of [s.dAnchor, s.tAnchor]) {
      expect(changed.find((c) => c.anchor_id === a)).toMatchObject({ state: "drifted", to_path: "src/range.ts" });
      expect(anchorRow(a)).toMatchObject({ path: "src/range.ts", state: "drifted" });
    }
    expect(anchorRow(s.cAnchor).path).toBe("src/code-view.ts");
    expect(["fresh", "drifted"]).toContain(anchorRow(s.cAnchor).state);

    // 5. Связь снова верна в обе стороны.
    const sym = await symbol("prefixEnd");
    expect(sym.defs.map((x) => x.path)).toEqual(["src/range.ts"]);
    expect(sym.defs[0]!.knowledge.map((k) => k.id).sort()).toEqual([s.decision, s.task].sort());
    expect(sym.defs[0]!.knowledge.every((k) => !k.suspect)).toBe(true);
    // code-view.ts: import, реэкспорт и вызов; read.ts — прежние три; range.ts — только определение.
    expect(sym.fan_in).toMatchObject({ n: 6, files: 2 });
    const spans = await anchorsOf("src/range.ts");
    expect(spans.map((x) => x.anchor_id).sort()).toEqual([s.dAnchor, s.tAnchor].sort());
    expect(spans.every((x) => x.symbol === "prefixEnd")).toBe(true);
    expect(spans.flatMap((x) => x.nodes.map((n) => n.id)).sort()).toEqual([s.decision, s.task].sort());
    expect((await anchorsOf("src/code-view.ts")).map((x) => x.anchor_id)).toEqual([s.cAnchor]);
    const shown = (await data("show", s.task))["anchors"] as Array<{
      node_id?: string;
      path?: string;
      state: string;
      moved_from?: string;
    }>;
    const tShown = shown.find((a) => a.node_id === s.tAnchor)!;
    expect(tShown).toMatchObject({ path: "src/range.ts", state: "drifted" });
    expect(tShown.moved_from?.startsWith("src/view.ts:")).toBe(true);
    // Переезд не понизил знание: сдвиг с полным совпадением тела — вес 1, D по-прежнему выше C.
    const moved = await ranks(s.decision, s.control);
    expect(moved.d).toBeLessThan(moved.c);

    // 6. Функцию удалили: индекс (явно) видел удаление — lost, suspect, ниже живого аналога.
    removePrefixEnd();
    await data("code", "index");
    await data("anchor", "check");
    for (const [owner, a] of [
      [s.decision, s.dAnchor],
      [s.task, s.tAnchor],
    ] as const) {
      expect(anchorRow(a)).toMatchObject({ path: "src/range.ts", state: "lost" });
      expect(suspect(owner, a)).toBe(1);
    }
    expect(anchorRow(s.cAnchor).path).toBe("src/code-view.ts");
    expect(suspect(s.control, s.cAnchor)).toBeUndefined();
    // Символа больше нет — и `code symbol` так и говорит, а не отдаёт знание про чужой код.
    const gone = await envOf("code", "symbol", "prefixEnd");
    expect(gone.ok).toBe(false);
    expect(gone.error?.code).toBe("notfound.symbol");
    const lostSpans = await anchorsOf("src/range.ts");
    expect(lostSpans.every((x) => x.state === "lost")).toBe(true);
    const tLost = ((await data("show", s.task))["anchors"] as Array<{ node_id?: string; state: string }>).find(
      (a) => a.node_id === s.tAnchor,
    )!;
    expect(tLost.state).toBe("lost");
    // Выдача: D найден, но теперь НИЖЕ живого C (до удаления стоял выше).
    const after = await ranks(s.decision, s.control);
    expect(after.d).toBeGreaterThan(0);
    expect(after.d).toBeGreaterThan(after.c);
    console.log(
      `[m3] recall rank D/C: before ${before.d}/${before.c}, after move ${moved.d}/${moved.c}, after delete ${after.d}/${after.c}; ` +
        `fan_in(prefixEnd) 4 → 6; anchors D,T: view.ts fresh → range.ts drifted ` +
        `${anchorRowDrift(s.dAnchor)} → lost (suspect)`,
    );
  }, 60_000);

  test("МУТАЦИЯ «без ступени 3»: якоря остаются на исчезнувшем view.ts, символ в range.ts знания не видит", async () => {
    const s = await start();
    refactor();
    await backgroundRefresh();
    await data("anchor", "check", "--level", "3");
    expect(anchorRow(s.dAnchor)).toMatchObject({ path: "src/view.ts", state: "stale" });
    const sym = await symbol("prefixEnd");
    expect(sym.defs.map((x) => x.path)).toEqual(["src/range.ts"]);
    expect(sym.defs[0]!.knowledge).toEqual([]);
    expect(await anchorsOf("src/range.ts")).toEqual([]);
  }, 60_000);

  test("МУТАЦИЯ «фон не обновил индекс»: range.ts индексу неизвестен — якорь stale, символ на старом месте, fan_in прежний", async () => {
    const s = await start();
    refactor();
    // Исполнитель фонового обновления не запускался: дренаж поставил работу, но
    // `code index --job` не отработал.
    await data("anchor", "check");
    const row = anchorRow(s.dAnchor);
    expect(row.path).toBe("src/view.ts");
    expect(row.state).toBe("stale");
    const sym = await symbol("prefixEnd");
    expect(sym.defs.map((x) => x.path)).toEqual(["src/view.ts"]);
    expect(sym.fan_in).toMatchObject({ n: 4 });
    expect(await anchorsOf("src/range.ts")).toEqual([]);
  }, 60_000);
});
