/**
 * Ре-привязка §7.3 по частям (memory-5c03r9t5n472): отпечаток, окно по
 * отпечатку (шаг 2), кандидаты и проверка в других файлах (шаг 3).
 *
 * Сценарии «через команду» — в packages/cli/src/commands/anchor.rebind.test.ts;
 * здесь то, из чего они собраны, и с числами: оценка Jaccard по 32 хешам
 * обязана держаться около точного Jaccard k-грамм, иначе оба порога (0.60 и
 * 0.50) значили бы не то, что написано в спеке.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import {
  type AnchorLike,
  bestWindow,
  bindAnchor,
  checkAnchor,
  codeShare,
  FP_K,
  FP_SIZE,
  fingerprint,
  fpFromBlob,
  fpToBlob,
  jaccardFp,
  normalizeStream,
  REBIND_LOCAL_MIN,
  REBIND_MIN_CODE_SHARE,
  spanNormText,
} from "./anchors.ts";
import { runCodeIndex } from "./code_index.ts";
import { cruxTerms, declaredNames, type ElsewhereAnchor, REBIND_ELSEWHERE_MIN, rebindElsewhere } from "./rebind.ts";
import { buildSearchUnits } from "./search.ts";

/** Точный Jaccard множеств k-грамм — эталон, с которым сверяется оценка. */
function exactJaccard(a: string, b: string): number {
  const grams = (t: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + FP_K <= t.length; i++) out.add(t.slice(i, i + FP_K));
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

const FN = `export function fuseRanked(lists: number[][], k = 60): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      const prev = score.get(id) ?? 0;
      score.set(id, prev + 1 / (k + rank + 1));
    });
  }
  return score;
}`;

const norm = (src: string): string => normalizeStream(src, "ts").text;

// ---------------------------------------------------------------------------
// Отпечаток
// ---------------------------------------------------------------------------

describe("отпечаток: 32 наименьших хеша winnowing'а", () => {
  test("не больше 32, по возрастанию, без повторов; blob — 4 байта на хеш и обратно", () => {
    const fp = fingerprint(norm(FN));
    expect(fp.length).toBe(FP_SIZE);
    for (let i = 1; i < fp.length; i++) expect(fp[i]!).toBeGreaterThan(fp[i - 1]!);
    const blob = fpToBlob(fp);
    expect(blob.length).toBe(fp.length * 4);
    expect(Array.from(fpFromBlob(blob)!)).toEqual(Array.from(fp));
    expect(fpFromBlob(null)).toBeNull();
    expect(fpFromBlob(new Uint8Array(3))).toBeNull();
  });

  test("тот же текст — 1, ничего общего — 0, пустой — 0 (а не деление на ноль)", () => {
    const fp = fingerprint(norm(FN));
    expect(jaccardFp(fp, fingerprint(norm(FN)))).toBe(1);
    expect(jaccardFp(fp, fingerprint("zzzzzzzzqqqqqqqqwwwwwwwwxxxxxxxx"))).toBe(0);
    expect(jaccardFp(fp, fingerprint("ab"))).toBe(0);
  });

  test("оценка по 32 хешам держится около точного Jaccard k-грамм", () => {
    const variants = [
      FN.replace("fuseRanked", "combineRanks"),
      FN.replace("const prev = score.get(id) ?? 0;\n      score.set(id, prev + 1 / (k + rank + 1));", "score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));"),
      FN.replace(/score/g, "acc").replace(/list/g, "group"),
      `export function unrelated(x: string): string {\n  return x.split(",").map((p) => p.trim()).filter(Boolean).join(";");\n}`,
    ];
    for (const v of variants) {
      const exact = exactJaccard(norm(FN), norm(v));
      const est = jaccardFp(fingerprint(norm(FN)), fingerprint(norm(v)));
      expect(Math.abs(est - exact)).toBeLessThan(0.2);
    }
  });
});

// ---------------------------------------------------------------------------
// Окно по отпечатку и шаг 2 в том же файле
// ---------------------------------------------------------------------------

const PAD = Array.from({ length: 30 }, (_, i) => `export const pad${i} = ${i} * 3 + ${i % 7};`).join("\n");

describe("bestWindow: лучшее окно высоты span ± 40 %", () => {
  test("блок, уехавший в середину большого файла, находится целиком со сходством 1", () => {
    const file = `${PAD}\n\n${FN}\n\n${PAD}\n`;
    const s = normalizeStream(file, "ts");
    const lines = file.split("\n");
    const w = bestWindow(s, lines.length, fingerprint(norm(FN)), FN.split("\n").length, 1)!;
    expect(w.start).toBe(32);
    expect(w.end).toBe(32 + FN.split("\n").length - 1);
    expect(w.score).toBe(1);
  });

  test("из двух одинаковых копий берётся ближайшая к прежнему месту", () => {
    const file = `${FN}\n\n${PAD}\n\n${FN}\n`;
    const s = normalizeStream(file, "ts");
    const n = file.split("\n").length;
    const fp = fingerprint(norm(FN));
    expect(bestWindow(s, n, fp, 10, 1)!.start).toBe(1);
    expect(bestWindow(s, n, fp, 10, 40)!.start).toBe(43);
  });
});

function fileWith(text: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "myc-rebind-unit-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, text);
  return { file, dir };
}

function likeOf(file: string, start: number, end: number): AnchorLike {
  const b = bindAnchor(readFileSync(file, "utf8"), "ts", start, end, statSync(file));
  return { path: "a.ts", lang: "ts", ...b, fp: b.fp, state: "fresh" };
}

describe("доля кода: окно без других улик обязано быть кодом", () => {
  const TEMPLATE = (name: string, text: string): string =>
    `export function ${name}(opts: Options): string {\n  const on = opts.events.includes("x");\n  return \`#!/usr/bin/env node\n${text}\n\${HEADER}\n\${on ? "a" : "b"}\n\`;\n}`;
  const PROSE_A = Array.from({ length: 30 }, (_, i) => `// строка шаблона номер ${i}: какой-то текст про хук и сессию`).join("\n");

  test("codeShare: код — около единицы, шаблон из прозы — меньше четверти", () => {
    const code = normalizeStream(FN, "ts");
    expect(codeShare(code, FN.split("\n"), 1, 10)).toBeGreaterThan(0.9);
    const tpl = TEMPLATE("a", PROSE_A);
    expect(codeShare(normalizeStream(tpl, "ts"), tpl.split("\n"), 1, tpl.split("\n").length)).toBeLessThan(
      REBIND_MIN_CODE_SHARE,
    );
  });

  test("шаг 2 не сажает удалённый шаблон на соседний шаблон; МУТАЦИЯ minCodeShare 0 — сажает", () => {
    const before = TEMPLATE("codexLike", PROSE_A);
    const after = `export const K = 1;\n\n${TEMPLATE("opencodeLike", PROSE_A.replace(/хук/g, "плагин"))}\n`;
    const { file, dir } = fileWith(before);
    try {
      const a = likeOf(file, 1, before.split("\n").length);
      writeFileSync(file, after);
      const healthy = checkAnchor(a, file);
      expect(healthy.state).toBe("stale");
      expect(healthy.reason).toContain("mostly strings/comments");
      const mutated = checkAnchor(a, file, undefined, 4, { minCodeShare: 0 });
      expect(mutated.state).toBe("drifted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkAnchor, шаг 2: нечёткое окно в том же файле", () => {
  const HEAD_CHANGED = FN.replace("(lists: number[][], k = 60)", "(lists: readonly number[][], k = 60, floor = 0)").replace(
    "const prev = score.get(id) ?? 0;",
    "const prev = Math.max(floor, score.get(id) ?? 0);",
  );

  test("сигнатура и строка тела поменялись — drifted, сходство в [0.60, 1)", () => {
    const { file, dir } = fileWith(`${PAD}\n\n${FN}\n`);
    try {
      const a = likeOf(file, 32, 41);
      writeFileSync(file, `${PAD}\n// вставка\n\n${HEAD_CHANGED}\n`);
      const r = checkAnchor(a, file);
      expect(r.state).toBe("drifted");
      expect(r.level).toBe(3);
      expect(r.drift).toBeGreaterThanOrEqual(REBIND_LOCAL_MIN);
      expect(r.drift).toBeLessThan(1);
      expect(r.spanStart).toBe(33);
      expect(r.fp).not.toBeNull();
      expect(r.elsewhere).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("МУТАЦИЯ: порог шага 2 выше единицы — то же место объявляется stale и ищется в других файлах", () => {
    const { file, dir } = fileWith(`${PAD}\n\n${FN}\n`);
    try {
      const a = likeOf(file, 32, 41);
      writeFileSync(file, `${PAD}\n// вставка\n\n${HEAD_CHANGED}\n`);
      const r = checkAnchor(a, file, undefined, 4, { localMin: 1.01 });
      expect(r.state).toBe("stale");
      expect(r.elsewhere).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("окно не добирает высоту комментарием: переписанное тело короткой функции — stale, а не сигнатура", () => {
    const src = `// шапка\n// второй комментарий\nexport function f(a: number): number {\n  return a + 1;\n}\n`;
    const { file, dir } = fileWith(src);
    try {
      const a = likeOf(file, 3, 5);
      writeFileSync(
        file,
        `// шапка\n// второй комментарий\nexport function f(a: number): number {\n  const u = [a, a].map((x) => x * 7).join("-");\n  throw new Error(u);\n}\n`,
      );
      expect(checkAnchor(a, file).state).toBe("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale на НЕИЗМЕНЁННОМ файле остаётся stale и просит искать в других файлах", () => {
    const { file, dir } = fileWith(FN);
    try {
      const st = statSync(file);
      const a: AnchorLike = { ...likeOf(file, 1, 10), state: "stale", mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size };
      const r = checkAnchor(a, file);
      expect(r).toMatchObject({ state: "stale", level: 1, elsewhere: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("файла нет — уровень 0 и поиск в других файлах", () => {
    const { file, dir } = fileWith(FN);
    const a = likeOf(file, 1, 10);
    unlinkSync(file);
    expect(checkAnchor(a, file)).toMatchObject({ state: "stale", level: 0, elsewhere: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Подсказки кандидатов
// ---------------------------------------------------------------------------

describe("имена и слова crux", () => {
  test("имя из объявления в голове crux", () => {
    expect(declaredNames("export function fuseRRF(a: number[]) {")).toEqual(["fuseRRF"]);
    expect(declaredNames("export class Store<T> {")).toEqual(["Store"]);
    expect(declaredNames("  async load(id: string): Promise<void> {")).toEqual(["load"]);
    expect(declaredNames("const handler = async (req) => {")).toEqual(["handler"]);
    expect(declaredNames("if (x) {\n  return y;\n}")).toEqual([]);
  });

  test("слова для поиска: без ключевых слов, длинные — первыми", () => {
    const t = cruxTerms(norm(FN));
    expect(t[0]).toBe("fuseRanked");
    expect(t).not.toContain("const");
    expect(t).not.toContain("return");
    expect(t.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Шаг 3 по настоящему индексу
// ---------------------------------------------------------------------------

describe("rebindElsewhere: кандидаты из индекса, проверка файлом", () => {
  let ws: string;
  let db: Database;

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), "myc-rebind-idx-"));
    mkdirSync(join(ws, "alpha", "src"), { recursive: true });
    db = new Database(join(ws, "myc.db"), { create: true });
    await migrate(db, { migrations, writable: true });
  });

  afterEach(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  /** Индекс ВЛОЖЕННОГО репозитория: ключ `alpha`, пути от его корня. */
  async function indexAlpha(): Promise<void> {
    await runCodeIndex(db, { repoId: "alpha", root: join(ws, "alpha") });
    buildSearchUnits(db, "alpha", join(ws, "alpha"));
  }

  function anchorOn(rel: string, start: number, end: number): ElsewhereAnchor {
    const abs = join(ws, rel);
    const b = bindAnchor(readFileSync(abs, "utf8"), "ts", start, end, statSync(abs));
    return {
      wsPath: rel,
      symbol: "",
      spanStart: b.spanStart,
      spanEnd: b.spanEnd,
      fileHash: b.fileHash,
      crux: b.crux,
      cruxNorm: b.cruxNorm,
      fp: b.fp,
      boundAt: 0,
    };
  }

  test("вынос во вложенном репозитории: путь от корня воркспейса, кандидат по имени из crux", async () => {
    writeFileSync(join(ws, "alpha", "src", "a.ts"), `${FN}\n\nexport const keep = 1;\n`);
    const a = anchorOn("alpha/src/a.ts", 1, 10);
    writeFileSync(join(ws, "alpha", "src", "a.ts"), "export const keep = 1;\n");
    writeFileSync(join(ws, "alpha", "src", "b.ts"), `// перенесено\n${FN}\n`);
    await indexAlpha();
    const src = readFileSync(join(ws, "alpha", "src", "a.ts"), "utf8");
    const r = rebindElsewhere(
      db,
      { ...a, disk: { hash: `wy:${Bun.hash(src).toString(16)}`, mtimeMs: statSync(join(ws, "alpha", "src", "a.ts")).mtimeMs } },
      { wsDir: ws },
    );
    expect(r.found).not.toBeNull();
    expect(r.found!.wsPath).toBe("alpha/src/b.ts");
    expect(r.found!.binding.spanStart).toBe(2);
    expect(r.found!.score).toBe(1);
    expect(r.found!.via).toBe("symbol");
    expect(r.candidates.every((c) => c.wsPath !== "alpha/src/a.ts")).toBe(true);
  });

  test("кандидатов не больше пяти, и ниже порога якорем не становится никто", async () => {
    writeFileSync(join(ws, "alpha", "src", "a.ts"), `${FN}\n`);
    const a = anchorOn("alpha/src/a.ts", 1, 10);
    unlinkSync(join(ws, "alpha", "src", "a.ts"));
    // Семь файлов с тем же словарём (lists, score), но другим кодом.
    for (let i = 0; i < 7; i++) {
      writeFileSync(
        join(ws, "alpha", "src", `n${i}.ts`),
        `export function scoreLists${i}(lists: string[][]): number {\n  return lists.length * ${i + 2};\n}\n`,
      );
    }
    await indexAlpha();
    const r = rebindElsewhere(db, a, { wsDir: ws });
    expect(r.found).toBeNull();
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(5);
    for (const c of r.candidates) expect(c.score).toBeLessThan(REBIND_ELSEWHERE_MIN);
    // Файла нет, строки его в реестре нет, индекс обновлялся после привязки — видел.
    expect(r.indexSaw).toBe(true);
  });

  test("индекса нет — ничего не ищется, и это не «видел»", () => {
    writeFileSync(join(ws, "alpha", "src", "a.ts"), `${FN}\n`);
    const a = anchorOn("alpha/src/a.ts", 1, 10);
    unlinkSync(join(ws, "alpha", "src", "a.ts"));
    const r = rebindElsewhere(db, a, { wsDir: ws });
    expect(r).toMatchObject({ found: null, indexed: false, indexSaw: false });
  });

  test("индекс помнит удалённый файл — не видел удаления: stale, а не lost", async () => {
    writeFileSync(join(ws, "alpha", "src", "a.ts"), `${FN}\n`);
    await indexAlpha();
    const a = anchorOn("alpha/src/a.ts", 1, 10);
    unlinkSync(join(ws, "alpha", "src", "a.ts"));
    const r = rebindElsewhere(db, a, { wsDir: ws });
    expect(r.found).toBeNull();
    expect(r.indexSaw).toBe(false);
  });

  test("окно кандидата — не только точный crux: функция с правкой в теле находится со сходством ниже 1", async () => {
    writeFileSync(join(ws, "alpha", "src", "a.ts"), `${FN}\n`);
    const a = anchorOn("alpha/src/a.ts", 1, 10);
    unlinkSync(join(ws, "alpha", "src", "a.ts"));
    const edited = FN.replace("const prev = score.get(id) ?? 0;", "const prev = score.get(id) ?? k;");
    writeFileSync(join(ws, "alpha", "src", "c.ts"), `import { x } from "./x.ts";\n\n${edited}\n`);
    await indexAlpha();
    const r = rebindElsewhere(db, a, { wsDir: ws });
    expect(r.found!.wsPath).toBe("alpha/src/c.ts");
    expect(r.found!.binding.spanStart).toBe(3);
    expect(r.found!.score).toBeGreaterThanOrEqual(REBIND_ELSEWHERE_MIN);
    expect(r.found!.score).toBeLessThan(1);
    // Отпечаток нового места — снятый с его собственного текста.
    const s = normalizeStream(readFileSync(join(ws, "alpha", "src", "c.ts"), "utf8"), "ts");
    expect(Array.from(r.found!.binding.fp)).toEqual(
      Array.from(fingerprint(spanNormText(s, r.found!.binding.spanStart, r.found!.binding.spanEnd))),
    );
  });
});
