#!/usr/bin/env bun
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  listDefs,
  loadLangs,
  type DefsOptions,
  type LangId,
} from "../packages/code-intel/src/symbols.ts";

// Корпуса задаются снаружи. Прибитые пути к домашнему каталогу автора
// превращают стенд в неповторяемый где-либо ещё и вписывают его имя в
// репозиторий. Первый корпус — сам этот репозиторий; второй нужен побольше и
// задаётся MYC_BENCH_ROOT2, без него часть замера просто пропускается.
const MEMORY_ROOT = process.env["MYC_BENCH_ROOT"] ?? new URL("..", import.meta.url).pathname;
const CHERRY_ROOT = process.env["MYC_BENCH_ROOT2"] ?? "";
const TARGET_FILES = 50;
const OUT_JSON = new URL("./defs-accuracy.json", import.meta.url).pathname;
const OUT_CORPUS = new URL("./defs-corpus.json", import.meta.url).pathname;

const LANG_BY_EXT: Record<string, LangId> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
};

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".expo",
  ".turbo",
  "graft",
  "coverage",
  "vendor",
  "target",
  "assets",
  "static",
  "public",
  "docs",
  "__pycache__",
]);

interface CorpusEntry {
  readonly repo: string;
  readonly root: string;
  readonly rel: string;
  readonly lang: LangId;
}

function collectPool(root: string, relPrefix: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 12 || out.length >= 4000) return;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(full, relPath, depth + 1);
        continue;
      }
      const dot = name.lastIndexOf(".");
      if (dot === -1) continue;
      const lang = LANG_BY_EXT[name.slice(dot)];
      if (lang === undefined) continue;
      if (name.endsWith(".d.ts")) continue;
      out.push(relPrefix + relPath);
    }
  };
  walk(root, "", 0);
  return out;
}

function buildCorpus(target: number): CorpusEntry[] {
  const repos: { name: string; root: string }[] = [{ name: "memory", root: MEMORY_ROOT }];
  // Второй корпус необязателен: без него замер идёт на одном репозитории и
  // говорит об этом. Прежний `catch { repos.pop() }` выбрасывал ПЕРВЫЙ
  // корпус вместе с отсутствующим вторым и оставлял пустой список — то есть
  // отсутствие второго корпуса рушило весь стенд, а не сужало его.
  if (CHERRY_ROOT.length === 0) {
    process.stderr.write("MYC_BENCH_ROOT2 не задан — корпус только из этого репозитория\n");
  } else {
    try {
      for (const name of readdirSync(CHERRY_ROOT).sort()) {
        if (existsSync(join(CHERRY_ROOT, name, "graft"))) {
          repos.push({ name, root: join(CHERRY_ROOT, name) });
        }
      }
    } catch {
      process.stderr.write(`MYC_BENCH_ROOT2 не читается: ${CHERRY_ROOT}\n`);
    }
  }

  const pools = repos
    .map((r) => ({ ...r, files: collectPool(r.root, "") }))
    .filter((p) => p.files.length > 0);

  const corpus: CorpusEntry[] = [];
  const cursors = new Map(pools.map((p) => [p.name, 0]));
  let poolIdx = 0;
  let idle = 0;
  while (corpus.length < target && idle < pools.length) {
    const pool = pools[poolIdx % pools.length]!;
    poolIdx++;
    const cursor = cursors.get(pool.name)!;
    if (cursor >= pool.files.length) {
      idle++;
      continue;
    }
    idle = 0;
    cursors.set(pool.name, cursor + 1);
    const rel = pool.files[cursor]!;
    corpus.push({
      repo: pool.name,
      root: pool.root,
      rel,
      lang: LANG_BY_EXT[rel.slice(rel.lastIndexOf("."))]!,
    });
  }
  return corpus;
}

interface GraftDef {
  readonly name: string;
  readonly kind: string;
  readonly span: string;
  readonly signature?: string;
}

interface SkeletonResult {
  readonly file: string;
  readonly entries: GraftDef[];
  readonly note?: string;
}

const KNOWN_KINDS = new Set(["function", "class", "method", "interface", "type", "enum"]);

function parseSpan(span: string): { start: number; end: number } | null {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function graftSkeleton(entry: CorpusEntry): { defs: GraftDef[]; note?: string } {
  const proc = Bun.spawnSync(["graft", "skeleton", "--json", entry.rel, entry.root], {
    cwd: entry.root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString().trim();
  if (!out.startsWith("{")) return { defs: [], note: out.slice(0, 200) };
  const parsed = JSON.parse(out) as SkeletonResult;
  return { defs: parsed.entries ?? [], note: parsed.note };
}

interface ModeResult {
  readonly mode: string;
  readonly files: number;
  readonly graftDefs: number;
  readonly myDefs: number;
  readonly startOk: number;
  readonly endExact: number;
  readonly endPlus1: number;
  readonly endPlus2: number;
  readonly kindOk: number;
  readonly falsePositives: number;
  readonly startFailures: string[];
  readonly endFailures: string[];
  readonly falsePositiveSamples: string[];
}

function pct(num: number, den: number): string {
  if (den === 0) return "n/a";
  return `${((num / den) * 100).toFixed(1)}% (${num}/${den})`;
}

function measure(corpus: CorpusEntry[], mode: string, opts: DefsOptions): ModeResult {
  const res: ModeResult = {
    mode,
    files: 0,
    graftDefs: 0,
    myDefs: 0,
    startOk: 0,
    endExact: 0,
    endPlus1: 0,
    endPlus2: 0,
    kindOk: 0,
    falsePositives: 0,
    startFailures: [],
    endFailures: [],
    falsePositiveSamples: [],
  };

  for (const entry of corpus) {
    let source: string;
    try {
      source = readFileSync(join(entry.root, entry.rel), "utf8");
    } catch {
      continue;
    }
    const { defs: graftDefs } = graftSkeleton(entry);
    const known = graftDefs.filter((g) => KNOWN_KINDS.has(g.kind));
    if (known.length === 0) continue;
    res.files++;
    const mine = listDefs(source, entry.lang, opts);
    res.graftDefs += known.length;
    res.myDefs += mine.length;

    const matchedMine = new Set<number>();
    for (const g of known) {
      const span = parseSpan(g.span);
      if (!span) continue;
      let idx = -1;
      for (let i = 0; i < mine.length; i++) {
        const m = mine[i]!;
        if (!matchedMine.has(i) && m.name === g.name && m.startLine === span.start) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        if (res.startFailures.length < 20) {
          res.startFailures.push(
            `${entry.repo}/${entry.rel}:${span.start} ${g.kind} ${g.name} — ${(g.signature ?? "").slice(0, 100)}`,
          );
        }
        continue;
      }
      const m = mine[idx]!;
      matchedMine.add(idx);
      res.startOk++;
      const dEnd = Math.abs(m.endLine - span.end);
      if (dEnd === 0) res.endExact++;
      if (dEnd <= 1) res.endPlus1++;
      if (dEnd <= 2) res.endPlus2++;
      if (m.kind === g.kind) {
        res.kindOk++;
      } else if (res.endFailures.length < 20) {
        res.endFailures.push(`kind ${entry.repo}/${entry.rel}:${span.start} graft=${g.kind} mine=${m.kind} ${g.name}`);
      }
      if (dEnd > 0 && res.endFailures.length < 20) {
        res.endFailures.push(
          `end ${entry.repo}/${entry.rel}:L${span.start} ${g.kind} ${g.name}: graft L${span.start}-L${span.end}, mine L${m.startLine}-L${m.endLine}`,
        );
      }
    }
    for (let i = 0; i < mine.length; i++) {
      if (!matchedMine.has(i)) {
        res.falsePositives++;
        if (res.falsePositiveSamples.length < 20) {
          const m = mine[i]!;
          res.falsePositiveSamples.push(
            `fp ${entry.repo}/${entry.rel}:L${m.startLine} ${m.kind} ${m.name} — ${source.split("\n")[m.startLine - 1]?.trim().slice(0, 90)}`,
          );
        }
      }
    }
  }
  return res;
}

/**
 * Мутации стенда. `ignoreStrings` и `ignoreTemplateExprs` ушли вместе с
 * регекспным разбором (memory-hrsae2f1mf7a): это были ослабления ЛЕКСЕРА, а
 * tree-sitter лексером не пользуется — грамматика знает про строки и шаблоны
 * сама. Лексер жив и по-прежнему стережётся этими мутациями, но там, где он
 * работает: `packages/code-intel/src/lex.test.ts` (нормализация якорей).
 */
const MODES: readonly { name: string; opts: DefsOptions }[] = [
  { name: "baseline", opts: {} },
  { name: "m3-naive-end", opts: { naiveEnd: true } },
];

const args = process.argv.slice(2);
const nFlag = args.indexOf("--n");
const target = nFlag !== -1 ? Number(args[nFlag + 1]) : TARGET_FILES;
const corpus = buildCorpus(target);

if (args.includes("--corpus")) {
  for (const c of corpus) console.log(`${c.repo}\t${c.rel}\t${c.lang}`);
  console.error(`${corpus.length} files`);
  process.exit(0);
}

// Грамматики: разбор синхронный, загрузка — нет. Стенд грузит их разом до
// первого замера, чтобы ожидание не попало в измеряемое время.
await loadLangs(new Set(corpus.map((c) => c.lang)));

const results = MODES.map((m) => measure(corpus, m.name, m.opts));

console.log(`corpus: ${corpus.length} files → ${results[0]!.files} with graft defs`);
console.log("");
console.log(
  "mode                      | start accuracy   | end exact        | end ±1           | end ±2           | kind ok          | FP",
);
console.log("-".repeat(132));
for (const r of results) {
  console.log(
    `${r.mode.padEnd(25)} | ${pct(r.startOk, r.graftDefs).padEnd(16)} | ${pct(r.endExact, r.startOk).padEnd(16)} | ${pct(r.endPlus1, r.startOk).padEnd(16)} | ${pct(r.endPlus2, r.startOk).padEnd(16)} | ${pct(r.kindOk, r.startOk).padEnd(16)} | ${r.falsePositives}`,
  );
}

const base = results[0]!;
console.log("");
console.log(`baseline: graft defs ${base.graftDefs}, mine ${base.myDefs}, false positives ${base.falsePositives}`);
if (base.startFailures.length > 0) {
  console.log("");
  console.log("start-span failures (graft def with no match at same line+name):");
  for (const f of base.startFailures) console.log(`  ${f}`);
}
if (base.endFailures.length > 0) {
  console.log("");
  console.log("end-span / kind failures (baseline):");
  for (const f of base.endFailures) console.log(`  ${f}`);
}
if (base.falsePositiveSamples.length > 0) {
  console.log("");
  console.log("false positive samples (baseline):");
  for (const f of base.falsePositiveSamples) console.log(`  ${f}`);
}

writeFileSync(OUT_CORPUS, JSON.stringify(corpus, null, 2) + "\n");
writeFileSync(OUT_JSON, JSON.stringify(results, null, 2) + "\n");
