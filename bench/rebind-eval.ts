#!/usr/bin/env bun
/**
 * ЗАМЕР РЕ-ПРИВЯЗКИ ЯКОРЕЙ НА ИСТОРИИ ЭТОГО РЕПОЗИТОРИЯ (memory-5c03r9t5n472,
 * docs/design/01-core-data-model.md §7.3). Приёмка задачи дословно: «на
 * реальной истории репозитория доля автоматически восстановленных якорей
 * измерена».
 *
 *   bun run bench/rebind-eval.ts [--out bench/rebind-eval.json] [--to <sha>] [--variants full,no-step3,stale-index]
 *
 * СЛУЧАИ НАХОДЯТСЯ В ИСТОРИИ, А НЕ ПРИДУМЫВАЮТСЯ. Для каждого коммита C с
 * одним родителем P (`git rev-list --first-parent`) берутся изменённые
 * TS/JS-файлы (`git diff --name-status -M50%`), и определения родителя
 * (tree-sitter, тот же разбор, что у индекса) сверяются с определениями
 * потомка:
 *   moved          — определения с этим именем в файле X больше нет, а в
 *                    другом изменённом файле Y оно появилось (в Y@P его не было);
 *   file_renamed   — то же, но Y — это X, переименованный git'ом (R);
 *   renamed_symbol — в изменённом файле (в том числе в самом X) появилось
 *                    определение под другим именем с тем же телом: биграммы
 *                    токенов ≥ 0.6 (и имя, если уехало, уехало с переписанным
 *                    кодом — сходство ниже 0.3);
 *   deleted        — ни того ни другого: код удалён или переписан. Здесь
 *                    правильный ответ — НЕ привязываться (lost/stale).
 * Сходство для ground truth — биграммы токенов, мера, независимая от отпечатка
 * якоря (k-граммы символов нормализованного текста): замер не мерит алгоритм
 * им же самим. Переезд, при котором код переписан (сходство с новым
 * определением ниже 0.3), считается отдельно: по тексту его не найти в
 * принципе, и честный ответ там — lost.
 * Определения короче трёх строк не берутся: якорь на однострочник — не то,
 * что ставят агенты, а шум по отпечатку у них честно велик.
 *
 * ПРАВИЛЬНОСТЬ — по ожидаемому месту, не по состоянию. Якорь восстановлен
 * правильно, если он `fresh`/`drifted`, указывает на файл ожидаемого
 * определения и его спан перекрывает спан того определения не меньше чем
 * наполовину (или начинается не дальше двух строк от него). `fresh`/`drifted`
 * в другом месте — ЛОЖНАЯ привязка, она считается отдельно и хуже потери.
 *
 * КАК ИДЁТ ПРОГОН — через настоящие команды, в отдельном клоне (`git clone
 * --shared`, исходный репозиторий не трогается): checkout P → `myc code index`
 * → `myc anchor add` на каждое определение-случай (без --symbol, как ставят
 * агенты; имя символа привязка берёт из индекса сама) → checkout C →
 * `myc code index` → `myc anchor check`. Варианты:
 *   full        — как в бою;
 *   no-step3    — `--level 3`, то есть без поиска в других файлах: база, от
 *                 которой считается вклад ступени 3;
 *   stale-index — индекс после checkout C НЕ обновлён: проверка того, что
 *                 отставший индекс даёт `stale`, а не `lost`.
 * С `--study` — ещё пороги слабой улики (кандидат только по словам crux и окно
 * без других улик): text-0.50/0.60/0.70 против умолчания 0.65, no-code-share
 * (без правила доли кода) и before-weak-evidence-rules (оба правила сняты —
 * поведение, давшее две ложные привязки удалённого кода). Ими выбраны
 * `REBIND_TEXT_MIN` и `REBIND_MIN_CODE_SHARE`.
 */

import "../packages/store-sqlite/src/runtime-preload.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "../packages/store-sqlite/src/index.ts";
import { listDefs, loadLangs, type LangId } from "../packages/code-intel/src/symbols.ts";
import { REBIND_LOCAL_MIN, REBIND_MIN_CODE_SHARE } from "../packages/code-intel/src/anchors.ts";
import { REBIND_ELSEWHERE_MIN, REBIND_MAX_CANDIDATES, REBIND_TEXT_MIN } from "../packages/code-intel/src/rebind.ts";
import { run } from "../packages/cli/src/index.ts";
import { Registry } from "../packages/cli/src/registry.ts";
import { createAnchorCommand, sweepAnchors } from "../packages/cli/src/commands/anchor.ts";
import { openDrainHandle } from "../packages/cli/src/drain.ts";
import { openDriver } from "../packages/cli/src/commands/store.ts";
import { createCodeCommand } from "../packages/cli/src/commands/code.ts";
import { createTaskCommand } from "../packages/cli/src/commands/tasks.ts";

// Фон CLI (дренаж, фоновый индекс, фон якорей) в замере не нужен: он поднял бы
// отсоединённые процессы в клоне и перемешал бы то, что меряется.
process.env.MYC_DRAIN = "0";
process.env.MYC_ANCHOR_CHECK = "0";
process.env.MYC_CODE_INDEX = "0";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const MIN_LINES = 3;
/** Ниже этого сходства (биграммы токенов) код при переезде считается переписанным. */
const REWRITTEN_BELOW = 0.3;
/** Тот же код под новым именем: сходство биграмм токенов не ниже этого. */
const RENAMED_MIN = 0.6;
/** Удалённых случаев на коммит — не больше: удаление файла дало бы сотни однотипных. */
const DELETED_PER_COMMIT = 6;

const LANG_BY_EXT: Record<string, LangId> = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".cjs": "js" };

type CaseKind = "moved" | "file_renamed" | "renamed_symbol" | "deleted";
type Variant =
  | "full"
  | "no-step3"
  | "stale-index"
  | "text-0.50"
  | "text-0.60"
  | "text-0.70"
  | "no-code-share"
  | "before-weak-evidence-rules";

/**
 * Варианты порогов слабой улики (`--study`): тот же прогон, но проверка идёт
 * прямо через `sweepAnchors` с переопределёнными порогами — у CLI таких флагов
 * нет, и заводить их ради замера не нужно. `before-weak-evidence-rules` —
 * поведение до доработки: слова crux с общим порогом 0.50 и без правила доли кода.
 */
const STUDY: Partial<Record<Variant, { textMin?: number; minCodeShare?: number }>> = {
  "text-0.50": { textMin: 0.5 },
  "text-0.60": { textMin: 0.6 },
  "text-0.70": { textMin: 0.7 },
  "no-code-share": { minCodeShare: 0 },
  "before-weak-evidence-rules": { textMin: 0.5, minCodeShare: 0 },
};

interface Def {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly lines: ReadonlySet<string>;
}

interface Case {
  readonly id: number;
  readonly commit: string;
  readonly parent: string;
  readonly subject: string;
  readonly kind: CaseKind;
  readonly from: { readonly path: string; readonly name: string; readonly start: number; readonly end: number };
  /** Где определение оказалось; пусто у `deleted`. */
  readonly expected: ReadonlyArray<{ readonly path: string; readonly name: string; readonly start: number; readonly end: number }>;
  /** Сходство тела со старым (Jaccard нормализованных строк без имени). */
  readonly body: number;
  /**
   * Сходство старого определения с ожидаемым новым — биграммы токенов, мера,
   * НЕЗАВИСИМАЯ от отпечатка. Ниже 0.3 — код при переезде переписан: по тексту
   * его не найти в принципе, и такой случай считается отдельно («переписан»).
   */
  readonly expectedSim: number;
}

interface Outcome {
  readonly state: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly drift: number;
  readonly via: string;
  /**
   * correct    — ожидаемый файл, спан перекрывает ожидаемое определение;
   * right_file — ожидаемый файл, но спан съехал;
   * copy       — определение с тем же именем и тем же телом в ДРУГОМ файле
   *              (дубль, существовавший и раньше) — код тот же, место не то;
   * wrong      — любое другое место: ложная привязка;
   * unresolved — stale/lost там, где код был;
   * kept_unbound — удалённый код не привязан (lost/stale) — правильный ответ;
   * plausible  — удалённый (по ground truth) код привязан к похожему по
   *              независимой мере (биграммы токенов ≥ 0.5): переименование
   *              с правкой, которое ground truth по строкам не узнаёт;
   * false_bind — удалённый код привязан к непохожему.
   */
  readonly verdict: "correct" | "right_file" | "copy" | "wrong" | "unresolved" | "kept_unbound" | "plausible" | "false_bind";
  /** Сходство найденного места с исходным определением (биграммы токенов). */
  readonly tokenSim: number;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

const showCache = new Map<string, string | null>();
function show(sha: string, path: string): string | null {
  const key = `${sha}:${path}`;
  if (!showCache.has(key)) {
    try {
      showCache.set(key, git(REPO, "show", key));
    } catch {
      showCache.set(key, null);
    }
  }
  return showCache.get(key)!;
}

interface Entry {
  readonly status: string;
  readonly old: string;
  readonly now: string;
}

function diffEntries(p: string, c: string): Entry[] {
  const out: Entry[] = [];
  for (const line of git(REPO, "diff", "--name-status", "-M50%", p, c).split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const st = parts[0]!;
    if (st.startsWith("R") || st.startsWith("C")) out.push({ status: st[0]!, old: parts[1]!, now: parts[2]! });
    else out.push({ status: st[0]!, old: parts[1]!, now: parts[1]! });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Определения и ground truth
// ---------------------------------------------------------------------------

/** Строки тела для сравнения «то же тело»: без пробелов по краям, без комментариев, имя стёрто. */
function bodyLines(text: string, name: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
  for (const raw of text.split("\n")) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length === 0 || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    out.add(t.replace(re, "∅"));
  }
  return out;
}

function lineJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  const u = a.size + b.size - both;
  return u === 0 ? 0 : both / u;
}

const defsCache = new Map<string, Def[]>();
function defsOf(sha: string, path: string): Def[] {
  const key = `${sha}:${path}`;
  const hit = defsCache.get(key);
  if (hit !== undefined) return hit;
  const lang = LANG_BY_EXT[extname(path)];
  const src = lang === undefined ? null : show(sha, path);
  let defs: Def[] = [];
  if (src !== null && lang !== undefined) {
    const lines = src.split("\n");
    try {
      defs = listDefs(src, lang)
        .filter((d) => d.endLine - d.startLine + 1 >= MIN_LINES)
        .map((d) => ({
          path,
          name: d.name,
          kind: d.kind,
          start: d.startLine,
          end: d.endLine,
          lines: bodyLines(lines.slice(d.startLine - 1, d.endLine).join("\n"), d.name),
        }));
    } catch {
      defs = [];
    }
  }
  defsCache.set(key, defs);
  return defs;
}

/** Сходство двух определений по биграммам токенов (имя старого стёрто). */
function simOfDefs(p: string, d: Def, c: string, e: Def): number {
  return tokenSim(sliceAt(p, d.path, d.start, d.end), sliceAt(c, e.path, e.start, e.end), d.name);
}

function findCases(p: string, c: string, subject: string, nextId: () => number): Case[] {
  const entries = diffEntries(p, c).filter((e) => LANG_BY_EXT[extname(e.old)] !== undefined || LANG_BY_EXT[extname(e.now)] !== undefined);
  const src = entries.filter((e) => e.status === "M" || e.status === "D" || e.status === "R");
  const dst = entries.filter((e) => e.status === "A" || e.status === "M" || e.status === "R" || e.status === "C");
  // Новые определения изменённых файлов потомка: имени не было в этом файле у родителя.
  const fresh: Array<{ def: Def; renamedFrom: string | null }> = [];
  for (const y of dst) {
    const before = new Set(y.status === "M" ? defsOf(p, y.now).map((e) => e.name) : []);
    for (const e of defsOf(c, y.now)) if (!before.has(e.name)) fresh.push({ def: e, renamedFrom: y.status === "R" ? y.old : null });
  }
  const out: Case[] = [];
  let deletedHere = 0;
  for (const x of src) {
    const namesXC = new Set(x.status === "M" ? defsOf(c, x.old).map((d) => d.name) : []);
    for (const d of defsOf(p, x.old)) {
      if (namesXC.has(d.name)) continue; // осталось в файле — не переезд
      const from = { path: x.old, name: d.name, start: d.start, end: d.end };
      const scored = fresh.map((f) => ({ ...f, sim: simOfDefs(p, d, c, f.def), line: lineJaccard(d.lines, f.def.lines) }));
      // То же имя в ДРУГОМ файле (в своём — это «осталось», см. выше).
      const byName = scored.filter((f) => f.def.name === d.name && f.def.path !== x.old);
      const kept = byName.filter((f) => f.sim >= REWRITTEN_BELOW);
      // То же тело под другим именем — по независимой мере (биграммы токенов).
      const byBody = scored.filter((f) => f.def.name !== d.name).sort((a, b) => b.sim - a.sim)[0];
      const push = (kind: CaseKind, list: typeof scored): void => {
        out.push({
          id: nextId(),
          commit: c,
          parent: p,
          subject,
          kind,
          from,
          expected: list.map((f) => ({ path: f.def.path, name: f.def.name, start: f.def.start, end: f.def.end })),
          body: Math.max(...list.map((f) => f.line)),
          expectedSim: Math.max(...list.map((f) => f.sim)),
        });
      };
      const renamed = (list: typeof scored): boolean => list.some((f) => f.renamedFrom === x.old);
      if (kept.length > 0) push(renamed(kept) ? "file_renamed" : "moved", kept);
      else if (byBody !== undefined && byBody.sim >= RENAMED_MIN) push("renamed_symbol", [byBody]);
      else if (byName.length > 0) push(renamed(byName) ? "file_renamed" : "moved", byName); // имя уехало, код переписан
      else {
        if (deletedHere >= DELETED_PER_COMMIT) continue;
        deletedHere++;
        out.push({ id: nextId(), commit: c, parent: p, subject, kind: "deleted", from, expected: [], body: byBody?.line ?? 0, expectedSim: 0 });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Прогон через команды
// ---------------------------------------------------------------------------

const registry = new Registry();
registry.register(createAnchorCommand());
registry.register(createTaskCommand());
registry.register(createCodeCommand());

let clone = "";
let home = "";

async function myc(...args: string[]): Promise<Record<string, unknown>> {
  const r = await run(["-C", clone, ...args, "--json"], {
    registry,
    env: { MYC_ACTOR: "rebind-eval", MYC_HOME: home, MYC_DRAIN: "0", MYC_ANCHOR_CHECK: "0", MYC_CODE_INDEX: "0" },
  });
  const env = JSON.parse(r.stdout as string) as { ok: boolean; data: Record<string, unknown>; error?: { msg: string } };
  if (!env.ok) throw new Error(`myc ${args.join(" ")}: ${env.error?.msg ?? r.stdout}`);
  return env.data;
}

function checkout(sha: string): void {
  git(clone, "checkout", "-q", "-f", "--detach", sha);
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1;
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start) + 1;
  return Math.abs(a.start - b.start) <= 2 || (inter > 0 && inter / union >= 0.5);
}

/** Токены кода без комментариев: идентификаторы, числа, знаки. */
function tokens(text: string): string[] {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return stripped.match(/[A-Za-z_$][\w$]*|\d+|[^\s\w]/g) ?? [];
}

const bigramCache = new Map<string, Set<string>>();
function bigrams(text: string, drop: string): Set<string> {
  const key = `${drop}\u0000${text}`;
  let out = bigramCache.get(key);
  if (out === undefined) {
    const t = tokens(text).filter((x) => x !== drop);
    out = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) out.add(`${t[i]} ${t[i + 1]}`);
    bigramCache.set(key, out);
  }
  return out;
}

/**
 * Jaccard биграмм токенов — мера сходства, НЕЗАВИСИМАЯ от отпечатка якоря
 * (там k-граммы символов нормализованного текста). Имя старого определения
 * стёрто: переименование само по себе сходства не отнимает.
 */
function tokenSim(a: string, b: string, nameA: string): number {
  const x = bigrams(a, nameA);
  const y = bigrams(b, "");
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  const u = x.size + y.size - both;
  return u === 0 ? 0 : both / u;
}

function sliceAt(sha: string, path: string, start: number, end: number): string {
  return (show(sha, path) ?? "").split("\n").slice(start - 1, end).join("\n");
}

function judge(
  c: Case,
  row: { state: string; path: string; start: number; end: number },
): { verdict: Outcome["verdict"]; tokenSim: number } {
  const bound = row.state === "fresh" || row.state === "drifted";
  if (!bound) return { verdict: c.kind === "deleted" ? "kept_unbound" : "unresolved", tokenSim: 0 };
  const orig = sliceAt(c.parent, c.from.path, c.from.start, c.from.end);
  const sim = tokenSim(orig, sliceAt(c.commit, row.path, row.start, row.end), c.from.name);
  const r3 = Math.round(sim * 1000) / 1000;
  if (c.kind === "deleted") return { verdict: sim >= 0.5 ? "plausible" : "false_bind", tokenSim: r3 };
  if (c.expected.some((e) => e.path === row.path && overlaps(e, row))) return { verdict: "correct", tokenSim: r3 };
  if (c.expected.some((e) => e.path === row.path)) return { verdict: "right_file", tokenSim: r3 };
  // Дубль: в месте привязки лежит определение с тем же именем и тем же телом.
  const dup = defsOf(c.commit, row.path).find(
    (d) => d.name === c.from.name && overlaps(d, row) && lineJaccard(d.lines, bodyLines(orig, c.from.name)) >= 0.9,
  );
  return { verdict: dup !== undefined ? "copy" : "wrong", tokenSim: r3 };
}

interface PairRun {
  readonly outcomes: Map<number, Outcome>;
  readonly checkMs: number;
}

async function runPair(p: string, c: string, cases: readonly Case[], variant: Variant): Promise<PairRun> {
  checkout(p);
  await myc("code", "index");
  const w = new Database(join(clone, ".myc", "myc.db"));
  w.exec("DELETE FROM anchors");
  w.close();
  const task = (await myc("task", `rebind-eval ${c.slice(0, 7)}`))["id"] as string;
  const byAnchor = new Map<string, Case>();
  for (const k of cases) {
    const added = await myc("anchor", "add", task, `${k.from.path}:${k.from.start}-${k.from.end}`);
    byAnchor.set(added["anchor_id"] as string, k);
  }
  // Якорь до рефакторинга ЖИЛ: фон успел довести отложенные привязки (файлы
  // больше 32 КБ, S66) и снять отпечатки. Без этого прогона привязка файла
  // больше порога доводилась бы уже по содержимому потомка.
  const settled = await myc("anchor", "check", "--limit", "100000");
  if (Number(settled["fresh"]) !== cases.length) {
    throw new Error(`${p.slice(0, 7)}: ${settled["fresh"]}/${cases.length} anchors fresh before the refactor`);
  }
  checkout(c);
  if (variant !== "stale-index") await myc("code", "index");
  const t0 = performance.now();
  const study = STUDY[variant];
  let data: Record<string, unknown>;
  if (study === undefined) {
    data = await myc("anchor", "check", "--limit", "100000", ...(variant === "no-step3" ? ["--level", "3"] : []));
  } else {
    const dbPath = join(clone, ".myc", "myc.db");
    const driver = openDriver(dbPath);
    const h = openDrainHandle(driver, dbPath, { MYC_ACTOR: "rebind-eval" });
    try {
      data = (await sweepAnchors(h, { wsDir: clone, limit: 100000, rebind: study })) as unknown as Record<string, unknown>;
    } finally {
      h.close();
    }
  }
  const checkMs = performance.now() - t0;
  const via = new Map<string, string>();
  for (const line of data["changed"] as Array<{ anchor_id: string; level: number; via?: string }>) {
    via.set(line.anchor_id, line.via !== undefined ? line.via.split(" ")[0]! : line.level === 3 ? "local" : "");
  }
  const r = new Database(join(clone, ".myc", "myc.db"), { readonly: true });
  const rows = r
    .query("SELECT node_id, repo_id, path, span_start AS s, span_end AS e, state, drift FROM anchors")
    .all() as Array<{ node_id: string; repo_id: string; path: string; s: number; e: number; state: string; drift: number }>;
  r.close();
  const outcomes = new Map<number, Outcome>();
  for (const row of rows) {
    const k = byAnchor.get(row.node_id);
    if (k === undefined) continue;
    const path = row.repo_id.length === 0 ? row.path : `${row.repo_id}/${row.path}`;
    const o = { state: row.state, path, start: row.s, end: row.e };
    outcomes.set(k.id, { ...o, drift: row.drift, via: via.get(row.node_id) ?? "", ...judge(k, o) });
  }
  return { outcomes, checkMs };
}

// ---------------------------------------------------------------------------
// Сводка
// ---------------------------------------------------------------------------

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 1000;
}

function summarize(cases: readonly Case[], outcomes: ReadonlyMap<number, Outcome>): Record<string, unknown> {
  const reloc = cases.filter((c) => c.kind !== "deleted");
  const del = cases.filter((c) => c.kind === "deleted");
  const count = (list: readonly Case[], v: Outcome["verdict"]): number => list.filter((c) => outcomes.get(c.id)?.verdict === v).length;
  const byKind: Record<string, unknown> = {};
  for (const kind of ["moved", "file_renamed", "renamed_symbol"] as const) {
    const list = reloc.filter((c) => c.kind === kind);
    byKind[kind] = {
      total: list.length,
      correct: count(list, "correct"),
      right_file: count(list, "right_file"),
      copy: count(list, "copy"),
      wrong: count(list, "wrong"),
      unresolved: count(list, "unresolved"),
      rate: pct(count(list, "correct"), list.length),
    };
  }
  const buckets: Array<[string, number, number]> = [
    ["body ≥ 0.9", 0.9, 1.01],
    ["body 0.6–0.9", 0.6, 0.9],
    ["body < 0.6", -1, 0.6],
  ];
  const byBody: Record<string, unknown> = {};
  for (const [label, lo, hi] of buckets) {
    const list = reloc.filter((c) => c.body >= lo && c.body < hi);
    byBody[label] = { total: list.length, correct: count(list, "correct"), rate: pct(count(list, "correct"), list.length) };
  }
  const byVia: Record<string, number> = {};
  for (const c of reloc) {
    const o = outcomes.get(c.id);
    if (o?.verdict !== "correct") continue;
    const key = o.via.length > 0 ? o.via : o.state === "fresh" ? "local" : "?";
    byVia[key] = (byVia[key] ?? 0) + 1;
  }
  const unresolved = reloc.filter((c) => outcomes.get(c.id)?.verdict === "unresolved");
  const recoverable = reloc.filter((c) => c.expectedSim >= REWRITTEN_BELOW);
  const rewritten = reloc.filter((c) => c.expectedSim < REWRITTEN_BELOW);
  return {
    relocated: {
      total: reloc.length,
      correct: count(reloc, "correct"),
      right_file: count(reloc, "right_file"),
      copy: count(reloc, "copy"),
      wrong: count(reloc, "wrong"),
      unresolved: {
        stale: unresolved.filter((c) => outcomes.get(c.id)!.state === "stale").length,
        lost: unresolved.filter((c) => outcomes.get(c.id)!.state === "lost").length,
      },
      rate: pct(count(reloc, "correct"), reloc.length),
      recoverable: {
        note: `code that kept its text on the move: token-bigram similarity to the expected definition >= ${REWRITTEN_BELOW}`,
        total: recoverable.length,
        correct: count(recoverable, "correct"),
        right_file: count(recoverable, "right_file"),
        copy: count(recoverable, "copy"),
        wrong: count(recoverable, "wrong"),
        unresolved: count(recoverable, "unresolved"),
        rate: pct(count(recoverable, "correct"), recoverable.length),
      },
      rewritten_on_move: {
        total: rewritten.length,
        correct: count(rewritten, "correct"),
        right_file: count(rewritten, "right_file"),
        wrong: count(rewritten, "wrong"),
        unresolved: count(rewritten, "unresolved"),
      },
      by_kind: byKind,
      by_body_similarity: byBody,
      correct_by_candidate: byVia,
    },
    deleted: {
      total: del.length,
      lost: del.filter((c) => outcomes.get(c.id)?.state === "lost").length,
      stale: del.filter((c) => outcomes.get(c.id)?.state === "stale").length,
      bound: count(del, "plausible") + count(del, "false_bind"),
      plausible: count(del, "plausible"),
      false_bind: count(del, "false_bind"),
      false_bind_rate: pct(count(del, "false_bind"), del.length),
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = resolve(arg("out") ?? join(REPO, "bench", "rebind-eval.json"));
  const to = git(REPO, "rev-parse", arg("to") ?? "HEAD").trim();
  const base = "full,no-step3,stale-index";
  const variants = (
    arg("variants") ?? (process.argv.includes("--study") ? `${base},${Object.keys(STUDY).join(",")}` : base)
  ).split(",") as Variant[];
  await loadLangs(["ts", "tsx", "js", "jsx"]);

  const commits = git(REPO, "rev-list", "--reverse", "--first-parent", to).trim().split("\n");
  let id = 0;
  const cases: Case[] = [];
  const pairs: Array<{ p: string; c: string; cases: Case[] }> = [];
  for (const c of commits) {
    const parents = git(REPO, "rev-list", "--parents", "-n", "1", c).trim().split(" ").slice(1);
    if (parents.length !== 1) continue;
    const subject = git(REPO, "log", "-1", "--format=%s", c).trim();
    const found = findCases(parents[0]!, c, subject, () => ++id);
    if (found.length === 0) continue;
    cases.push(...found);
    pairs.push({ p: parents[0]!, c, cases: found });
  }
  const kinds: Record<string, number> = {};
  for (const k of cases) kinds[k.kind] = (kinds[k.kind] ?? 0) + 1;
  console.log(`${commits.length} commits, ${pairs.length} with cases: ${JSON.stringify(kinds)}`);

  const work = mkdtempSync(join(tmpdir(), "myc-rebind-eval-"));
  clone = join(work, "repo");
  home = join(work, "home");
  const results: Record<string, unknown> = {};
  const perVariant = new Map<Variant, Map<number, Outcome>>();
  try {
    git(work, "clone", "-q", "--shared", "--no-checkout", REPO, clone);
    checkout(pairs[0]!.p);
    const dbPath = join(clone, ".myc", "myc.db");
    execFileSync("mkdir", ["-p", join(clone, ".myc"), home]);
    for (const variant of variants) {
      // Своя база на вариант: узлы якорей одного спана совпадают дословно
      // (заголовок и crux), и второй вариант упёрся бы в уникальность узла.
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
      const raw = new Database(dbPath, { create: true });
      await migrate(raw, { migrations, writable: true });
      raw.close();
      const all = new Map<number, Outcome>();
      const checkMs: number[] = [];
      const t0 = performance.now();
      for (const pair of pairs) {
        const r = await runPair(pair.p, pair.c, pair.cases, variant);
        for (const [k, v] of r.outcomes) all.set(k, v);
        checkMs.push(r.checkMs / pair.cases.length);
      }
      perVariant.set(variant, all);
      checkMs.sort((a, b) => a - b);
      results[variant] = {
        ...summarize(cases, all),
        check_ms_per_anchor: {
          p50: Math.round(checkMs[Math.floor(checkMs.length / 2)]! * 100) / 100,
          max: Math.round(checkMs[checkMs.length - 1]! * 100) / 100,
        },
        took_s: Math.round((performance.now() - t0) / 100) / 10,
      };
      const s = results[variant] as {
        relocated: { total: number; correct: number; right_file: number; copy: number; wrong: number; rate: number };
        deleted: { total: number; bound: number; false_bind: number };
      };
      console.log(
        `${variant}: relocated ${s.relocated.correct}/${s.relocated.total} (${s.relocated.rate}), right file ${s.relocated.right_file}, copy ${s.relocated.copy}, wrong ${s.relocated.wrong}; deleted bound ${s.deleted.bound}/${s.deleted.total} (false ${s.deleted.false_bind})`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const full = perVariant.get("full") ?? perVariant.get(variants[0]!)!;
  const doc = {
    task: "memory-5c03r9t5n472",
    spec: "docs/design/01-core-data-model.md §7.3",
    repo_head: to,
    generated_at: new Date().toISOString(),
    command: "bun run bench/rebind-eval.ts",
    thresholds: {
      local: REBIND_LOCAL_MIN,
      elsewhere: REBIND_ELSEWHERE_MIN,
      crux_words_only: REBIND_TEXT_MIN,
      min_code_share: REBIND_MIN_CODE_SHARE,
      candidates: REBIND_MAX_CANDIDATES,
    },
    ground_truth:
      "definitions (tree-sitter, ≥3 lines) of changed TS/JS files at parent vs child: same name newly in another changed file = moved (file_renamed if git R), same body under a new name (line Jaccard ≥ 0.8) = renamed_symbol, neither = deleted (≤6 per commit); correct = fresh/drifted on the expected file with span overlap ≥ 50% or start within 2 lines",
    commits: { scanned: commits.length, with_cases: pairs.length },
    cases: kinds,
    variants: results,
    cases_list: cases.map((c) => {
      const o = full.get(c.id);
      return {
        id: c.id,
        commit: c.commit.slice(0, 7),
        kind: c.kind,
        from: `${c.from.path}:${c.from.start}-${c.from.end} ${c.from.name}`,
        expected: c.expected.map((e) => `${e.path}:${e.start}-${e.end} ${e.name}`),
        body: Math.round(c.body * 1000) / 1000,
        expected_sim: Math.round(c.expectedSim * 1000) / 1000,
        result: o === undefined ? null : `${o.state} ${o.path}:${o.start}-${o.end}${o.via.length > 0 ? ` via ${o.via}` : ""}`,
        drift: o?.drift ?? null,
        token_sim: o?.tokenSim ?? null,
        verdict: o?.verdict ?? null,
        // Остальные варианты — одной строкой на вариант: где оказался якорь и вердикт.
        others: Object.fromEntries(
          [...perVariant.entries()]
            .filter(([v]) => perVariant.get(v) !== full)
            .map(([v, m]) => {
              const x = m.get(c.id);
              return [v, x === undefined ? null : `${x.verdict}: ${x.state} ${x.path}:${x.start}-${x.end}${x.via.length > 0 ? ` via ${x.via}` : ""}`];
            }),
        ),
      };
    }),
  };
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`→ ${out}`);
}

await main();
