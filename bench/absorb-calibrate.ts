#!/usr/bin/env bun
/**
 * КАЛИБРОВКА ПОРОГОВ absorb (ступень A, myc-fyq).
 *
 *   bun run bench/absorb-calibrate.ts [--db <путь>] [--out bench/absorb-calibration.json] [--no-grid]
 *
 * Зачем. Спека §6.1 называет пороги cos ≥ 0.95 (duplicate) и 0.82 (кандидат),
 * но это числа для bge-small с широким разбросом косинусов. У рабочей модели
 * multilingual-e5-small косинусы лежат в узком поясе (разделение «своё/чужое»
 * около 0.06), и порог из спеки на таком сигнале даёт либо «всё duplicate»,
 * либо «ничего». Поэтому пороги здесь ПОДБИРАЮТСЯ ЗАМЕРОМ:
 *
 *   1. bench/absorb-pairs.json — размеченные пары на реальных текстах
 *      воркспейса (старый узел из .myc/myc.db, новый факт — текст);
 *   2. каждый текст кодируется настоящим эмбеддером (роль passage, по одному —
 *      ровно как в scripts/reindex-vectors.ts, иначе шум пакета GEMM
 *      сравним с сигналом);
 *   3. по всем парам считаются cos, jac, лексические сигналы;
 *   4. перебор сетки порогов; целевая функция ЛЕКСИКОГРАФИЧЕСКАЯ:
 *        (а) минимум ложных duplicate — этот класс молча теряет знание,
 *        (б) минимум ложных update — прячет старую голову из active,
 *        (в) максимум macro-F1, (г) максимум accuracy;
 *   5. матрица ошибок при выбранных порогах и при умолчаниях из core —
 *      если они разошлись, умолчания пора обновить;
 *   6. отдельно матрица БЕЗ векторов: деградация обязана не сливать ничего.
 *
 * Дополнительно меряется ошибка квантизации: косинус f32↔f32 против
 * f32↔int8 из nodes_vec — именно int8 будет у кандидатов в проде.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openSqlite } from "@myc/store-sqlite";
import { createLocalEmbedder, formatEmbedFingerprint, isModelPresent, DEFAULT_MODEL_ID } from "@myc/embed";
import {
  ABSORB_CLASSES,
  DEFAULT_ABSORB_THRESHOLDS,
  classifyPair,
  pairFeatures,
  verdictFromFeatures,
  type AbsorbClass,
  type PairFeatures,
  type AbsorbText,
  type AbsorbThresholds,
} from "@myc/core";

interface PairSpec {
  readonly label: AbsorbClass;
  readonly old: string;
  readonly new: string | { readonly node: string };
}

interface NodeRow {
  readonly rowid: number;
  readonly id: string;
  readonly title: string | null;
  readonly excerpt: string | null;
  readonly body: string | null;
  readonly created_at: number;
  readonly confidence: number;
}

function parseArgs(argv: readonly string[]) {
  let db = join(resolve("."), ".myc", "myc.db");
  let out = join(resolve("."), "bench", "absorb-calibration.json");
  let grid = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--db") db = resolve(argv[++i] ?? "");
    else if (a === "--out") out = resolve(argv[++i] ?? "");
    else if (a === "--no-grid") grid = false;
    else {
      console.error(`неизвестный аргумент ${a}`);
      process.exit(2);
    }
  }
  return { db, out, grid };
}

/** Тот же выбор текста, что у scripts/reindex-vectors.ts. */
function nodeText(n: NodeRow): string {
  const head = (n.title ?? "").trim().replace(/[.…]+$/u, "").trim();
  const body = (n.body ?? n.excerpt ?? "").trim();
  if (head.length === 0) return body;
  if (body.length === 0) return head;
  if (body.startsWith(head)) return body;
  return `${head}\n${body}`;
}

function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function stats(xs: readonly number[]) {
  return {
    n: xs.length,
    min: quantile(xs, 0),
    p25: quantile(xs, 0.25),
    median: quantile(xs, 0.5),
    p75: quantile(xs, 0.75),
    max: quantile(xs, 1),
  };
}

type Matrix = Record<AbsorbClass, Record<AbsorbClass, number>>;

function emptyMatrix(): Matrix {
  const m = {} as Matrix;
  for (const a of ABSORB_CLASSES) {
    m[a] = {} as Record<AbsorbClass, number>;
    for (const b of ABSORB_CLASSES) m[a][b] = 0;
  }
  return m;
}

interface Scored {
  readonly label: AbsorbClass;
  readonly old: AbsorbText;
  readonly new: AbsorbText;
  readonly cosF32: number;
  readonly cosInt8: number | null;
  readonly features: PairFeatures;
  readonly lexicalFeatures: PairFeatures;
}

interface Evaluation {
  readonly matrix: Matrix;
  readonly accuracy: number;
  readonly macroF1: number;
  readonly falseDuplicate: number;
  readonly falseUpdate: number;
  readonly perClass: Record<AbsorbClass, { precision: number; recall: number; f1: number; support: number }>;
}

function evaluate(pairs: readonly Scored[], t: AbsorbThresholds, withVectors: boolean): Evaluation {
  const m = emptyMatrix();
  for (const p of pairs) {
    const v = verdictFromFeatures(withVectors ? p.features : p.lexicalFeatures, t);
    m[p.label][v.class]++;
  }
  let correct = 0;
  let falseDuplicate = 0;
  let falseUpdate = 0;
  const perClass = {} as Evaluation["perClass"];
  let f1Sum = 0;
  for (const c of ABSORB_CLASSES) {
    const tp = m[c][c];
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const o of ABSORB_CLASSES) {
      support += m[c][o];
      if (o !== c) {
        fn += m[c][o];
        fp += m[o][c];
      }
    }
    correct += tp;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = support === 0 ? 1 : tp / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    f1Sum += f1;
    perClass[c] = { precision, recall, f1, support };
    if (c === "duplicate") falseDuplicate = fp;
    if (c === "update") falseUpdate = fp;
  }
  return {
    matrix: m,
    accuracy: correct / pairs.length,
    macroF1: f1Sum / ABSORB_CLASSES.length,
    falseDuplicate,
    falseUpdate,
    perClass,
  };
}

function better(a: Evaluation, b: Evaluation): boolean {
  if (a.falseDuplicate !== b.falseDuplicate) return a.falseDuplicate < b.falseDuplicate;
  if (a.falseUpdate !== b.falseUpdate) return a.falseUpdate < b.falseUpdate;
  // macro-F1 раньше accuracy: related↔new — симметричная и безобидная
  // путаница, и accuracy на ней плато; macro-F1 штрафует за класс,
  // recall которого обнулили ради чистоты соседнего.
  if (a.macroF1 !== b.macroF1) return a.macroF1 > b.macroF1;
  return a.accuracy > b.accuracy;
}

/**
 * При равном качестве — более консервативные пороги duplicate (выше cos и
 * jac): плато одинаково хороших комбинаций широкое, и брать его нижний край
 * значит сливать всё, что чуть похоже, при первом же сдвиге данных.
 */
function preferConservative(a: AbsorbThresholds, b: AbsorbThresholds): boolean {
  if (a.dup_cos !== b.dup_cos) return a.dup_cos > b.dup_cos;
  if (a.dup_jac !== b.dup_jac) return a.dup_jac > b.dup_jac;
  return false;
}

function printMatrix(title: string, e: Evaluation): void {
  const w = 14;
  console.log(`\n${title}`);
  console.log(
    `${"метка \\ вердикт".padEnd(w)}${ABSORB_CLASSES.map((c) => c.padStart(w)).join("")}`,
  );
  for (const a of ABSORB_CLASSES) {
    console.log(
      `${a.padEnd(w)}${ABSORB_CLASSES.map((b) => String(e.matrix[a][b]).padStart(w)).join("")}`,
    );
  }
  console.log(
    `accuracy ${(e.accuracy * 100).toFixed(1)} %, macro-F1 ${e.macroF1.toFixed(3)}, ` +
      `ложных duplicate ${e.falseDuplicate}, ложных update ${e.falseUpdate}`,
  );
  for (const c of ABSORB_CLASSES) {
    const pc = e.perClass[c];
    console.log(
      `  ${c.padEnd(14)} precision ${pc.precision.toFixed(2)}  recall ${pc.recall.toFixed(2)}  f1 ${pc.f1.toFixed(2)}  n=${pc.support}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.db)) {
  console.error(`нет базы ${args.db}`);
  process.exit(2);
}
if (!(await isModelPresent(DEFAULT_MODEL_ID))) {
  console.error(`модель ${DEFAULT_MODEL_ID} не скачана → myc models fetch`);
  process.exit(2);
}

const spec = JSON.parse(readFileSync(join(resolve("."), "bench", "absorb-pairs.json"), "utf8")) as {
  pairs: PairSpec[];
};
const pairs = spec.pairs;

const driver = openSqlite({ path: args.db });
const db = driver.database;
const rows = db
  .query(
    "SELECT rowid AS rowid, id, title, excerpt, body, created_at, confidence FROM nodes WHERE deleted_at IS NULL",
  )
  .all() as NodeRow[];
const byId = new Map(rows.map((r) => [r.id, r]));
const int8ByRowid = new Map<number, Int8Array>();
try {
  const vecRows = db.query("SELECT node_rowid AS r, embedding AS e FROM nodes_vec").all() as {
    r: number;
    e: Uint8Array;
  }[];
  for (const v of vecRows) {
    int8ByRowid.set(Number(v.r), new Int8Array(v.e.buffer, v.e.byteOffset, v.e.byteLength));
  }
} catch (e) {
  console.error(`nodes_vec недоступна (${(e as Error).message}) — ошибка квантизации не меряется`);
}
driver.close();

const embedder = createLocalEmbedder({});
const warm = await embedder.warmup();
if (warm !== "ok") {
  console.error(`эмбеддер в состоянии ${warm}`);
  process.exit(3);
}
const fingerprint = formatEmbedFingerprint(embedder.fingerprint);

const vecCache = new Map<string, Float32Array>();
async function embedText(text: string): Promise<Float32Array> {
  const hit = vecCache.get(text);
  if (hit) return hit;
  const res = await embedder.embed(text, "passage");
  if (res.vec === null) throw new Error(`эмбеддинг не посчитан: state=${res.state}`);
  vecCache.set(text, res.vec);
  return res.vec;
}

function resolveSide(side: string | { node: string }): { text: string; node: NodeRow | null } {
  if (typeof side === "string") {
    const n = byId.get(side);
    if (n) return { text: nodeText(n), node: n };
    return { text: side, node: null };
  }
  const n = byId.get(side.node);
  if (!n) throw new Error(`узел ${side.node} не найден в базе`);
  return { text: nodeText(n), node: n };
}

const t0 = performance.now();
const scored: Scored[] = [];
for (const p of pairs) {
  const o = resolveSide(p.old);
  const n = resolveSide(p.new);
  if (o.node === null) throw new Error(`old обязан быть id узла: ${p.old}`);
  const vo = await embedText(o.text);
  const vn = await embedText(n.text);
  const oldT: AbsorbText = {
    id: o.node.id,
    text: o.text,
    vector: vo,
    createdAt: o.node.created_at,
    confidence: o.node.confidence,
  };
  const newT: AbsorbText = { id: n.node?.id, text: n.text, vector: vn };
  const cosF32 = classifyPair(oldT, newT).cos!;
  const q = int8ByRowid.get(o.node.rowid);
  let cosInt8: number | null = null;
  if (q) {
    const deq = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) deq[i] = q[i]!;
    cosInt8 = classifyPair({ ...oldT, vector: deq }, newT).cos!;
  }
  scored.push({
    label: p.label,
    old: oldT,
    new: newT,
    cosF32,
    cosInt8,
    features: pairFeatures(oldT, newT),
    lexicalFeatures: pairFeatures({ ...oldT, vector: null }, { ...newT, vector: null }),
  });
}
await embedder.destroy();
const embedMs = performance.now() - t0;

console.log(`пар        ${scored.length}, текстов закодировано ${vecCache.size}, ${(embedMs / 1000).toFixed(1)} с`);
console.log(`модель     ${fingerprint}`);

// Распределения сигналов по меткам — то, на чём стоят пороги.
const dist: Record<string, { cos: ReturnType<typeof stats>; jac: ReturnType<typeof stats> }> = {};
console.log("\nраспределение сигналов по меткам (cos f32 / jac триграмм):");
for (const c of ABSORB_CLASSES) {
  const sub = scored.filter((s) => s.label === c);
  const cs = stats(sub.map((s) => s.cosF32));
  const js = stats(sub.map((s) => classifyPair(s.old, s.new).jac));
  dist[c] = { cos: cs, jac: js };
  console.log(
    `  ${c.padEnd(14)} n=${String(cs.n).padStart(2)}  cos ${cs.min.toFixed(3)}…${cs.median.toFixed(3)}…${cs.max.toFixed(3)}   jac ${js.min.toFixed(3)}…${js.median.toFixed(3)}…${js.max.toFixed(3)}`,
  );
}

const qErr = scored.filter((s) => s.cosInt8 !== null).map((s) => Math.abs(s.cosF32 - s.cosInt8!));
const quantization = qErr.length > 0 ? { n: qErr.length, mean: qErr.reduce((a, b) => a + b, 0) / qErr.length, max: Math.max(...qErr) } : null;
if (quantization) {
  console.log(
    `\nошибка квантизации |cos(f32,f32) − cos(f32,int8)|: mean ${quantization.mean.toFixed(4)}, max ${quantization.max.toFixed(4)} (n=${quantization.n})`,
  );
}

// Сетка порогов.
const report_extra: Record<string, unknown> = {};
let chosen: AbsorbThresholds = DEFAULT_ABSORB_THRESHOLDS;
let chosenEval = evaluate(scored, chosen, true);
if (args.grid) {
  const range = (from: number, to: number, step: number): number[] => {
    const out: number[] = [];
    for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 1000) / 1000);
    return out;
  };
  let best: { t: AbsorbThresholds; e: Evaluation } | null = null;
  let tried = 0;
  for (const dup_cos of range(0.9, 0.995, 0.005)) {
    for (const dup_jac of range(0.5, 0.95, 0.05)) {
      for (const cand_cos of range(0.8, 0.97, 0.005)) {
        if (cand_cos >= dup_cos) continue;
        for (const cand_jac of range(0.2, 0.6, 0.05)) {
          const t: AbsorbThresholds = { ...DEFAULT_ABSORB_THRESHOLDS, dup_cos, dup_jac, cand_cos, cand_jac };
          const e = evaluate(scored, t, true);
          tried++;
          if (
            best === null ||
            better(e, best.e) ||
            (!better(best.e, e) && preferConservative(t, best.t))
          ) {
            best = { t, e };
          }
        }
      }
    }
  }
  console.log(`\nсетка: ${tried} комбинаций`);
  chosen = best!.t;
  chosenEval = best!.e;
  // Плато: при каких значениях каждого порога (остальные зафиксированы)
  // результат не хуже выбранного. Узкое плато — порог стоит на краю данных.
  const plateau: Record<string, { from: number; to: number }> = {};
  const axes: [keyof AbsorbThresholds, number[]][] = [
    ["dup_cos", range(0.9, 0.995, 0.005)],
    ["dup_jac", range(0.5, 0.95, 0.05)],
    ["cand_cos", range(0.8, 0.97, 0.005)],
    ["cand_jac", range(0.2, 0.6, 0.05)],
  ];
  for (const [key, values] of axes) {
    const ok = values.filter((v) => {
      const e = evaluate(scored, { ...chosen, [key]: v }, true);
      return !better(chosenEval, e);
    });
    plateau[key] = { from: Math.min(...ok), to: Math.max(...ok) };
  }
  console.log(
    "плато (значения порога с тем же качеством при прочих фиксированных): " +
      Object.entries(plateau)
        .map(([k, v]) => `${k} ${v.from}…${v.to}`)
        .join(", "),
  );
  (report_extra as { plateau?: typeof plateau }).plateau = plateau;
  console.log(
    `лучшие пороги: dup_cos ${chosen.dup_cos}, dup_jac ${chosen.dup_jac}, cand_cos ${chosen.cand_cos}, cand_jac ${chosen.cand_jac}`,
  );
}

printMatrix("матрица при выбранных порогах (с векторами)", chosenEval);
const defaultsEval = evaluate(scored, DEFAULT_ABSORB_THRESHOLDS, true);
const same =
  chosen.dup_cos === DEFAULT_ABSORB_THRESHOLDS.dup_cos &&
  chosen.dup_jac === DEFAULT_ABSORB_THRESHOLDS.dup_jac &&
  chosen.cand_cos === DEFAULT_ABSORB_THRESHOLDS.cand_cos &&
  chosen.cand_jac === DEFAULT_ABSORB_THRESHOLDS.cand_jac;
if (!same) {
  printMatrix("матрица при умолчаниях core (DEFAULT_ABSORB_THRESHOLDS) — расходятся с сеткой", defaultsEval);
}
const lexicalEval = evaluate(scored, chosen, false);
printMatrix("матрица БЕЗ векторов (деградация): update/contradiction не объявляются", lexicalEval);

// Спорные пары — чтобы видеть, ГДЕ ошибается ступень, а не только сколько.
console.log("\nошибки при выбранных порогах:");
for (const s of scored) {
  const v = classifyPair(s.old, s.new, chosen);
  if (v.class !== s.label) {
    console.log(
      `  ${s.label.padEnd(13)} → ${v.class.padEnd(13)} ${s.old.id}  cos ${v.cos!.toFixed(3)} jac ${v.jac.toFixed(3)} cov ${v.signals.coverage.toFixed(2)}  ${v.reason}`,
    );
  }
}

const report = {
  generated_at: new Date().toISOString(),
  model: fingerprint,
  db: args.db,
  pairs: scored.length,
  thresholds: chosen,
  matrix: chosenEval.matrix,
  accuracy: chosenEval.accuracy,
  macro_f1: chosenEval.macroF1,
  false_duplicate: chosenEval.falseDuplicate,
  false_duplicate_rate: chosenEval.falseDuplicate / scored.filter((s) => s.label !== "duplicate").length,
  false_update: chosenEval.falseUpdate,
  per_class: chosenEval.perClass,
  distribution: dist,
  quantization,
  ...report_extra,
  lexical: {
    matrix: lexicalEval.matrix,
    accuracy: lexicalEval.accuracy,
    false_duplicate: lexicalEval.falseDuplicate,
    false_update: lexicalEval.falseUpdate,
  },
};
writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nотчёт записан: ${args.out}`);
