/**
 * Приёмка якорей: трёхуровневый детект протухания (memory-ehmatz79210p) и то,
 * из чего он собран.
 *
 * ПРОТУХАНИЕ ПРОВЕРЯЕТСЯ НАСТОЯЩИМ РЕФАКТОРИНГОМ, а не подделкой mtime.
 * Подделка mtime проверяет уровень 1 и ровно ничего не говорит о том, ради
 * чего якоря вообще нужны: переживает ли привязка правку кода. Поэтому файл
 * здесь реально переформатируется (отступ, перенос аргументов, висячая
 * запятая, добавленные комментарии), реально уезжает вниз и реально
 * переписывается — и каждый раз спрашивается состояние.
 *
 * МУТАЦИИ, которые эти тесты обязаны ловить (числа — в отчёте сдачи):
 *   1. снят детект по содержимому (`level: 2`) — якорь начинает ВРАТЬ:
 *      переформатирование объявляется протуханием, переехавший код теряется;
 *   2. сняты уровни 2 и 3 (`level: 1`) — mtime-тач без правки читается как
 *      протухание;
 *   3. снята нормализация висячей запятой и переносов — переформатирование
 *      снова ломает якорь.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindAnchor,
  checkAnchor,
  CRUX_MAX_CHARS,
  CRUX_MAX_LINES,
  findNormalized,
  hashText,
  normalizeStream,
  spanNormText,
  type AnchorLike,
  type CheckIo,
} from "./anchors.ts";

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

const ORIGINAL = `// заголовок файла
import { x } from "./x.ts";

export function fuseRRF(a: number[], b: number[], k = 60): number[] {
  const out: number[] = [];
  for (const v of a) out.push(v / (k + 1));
  for (const v of b) out.push(v / (k + 1));
  return out;
}

export function other(): void {
  console.log("other");
}
`;

/** Тот же код после настоящего переформатирования — ни одной изменённой инструкции. */
const REFORMATTED = `// заголовок файла
import { x } from "./x.ts";

/** Взвешенное слияние двух списков (RRF). */
export function fuseRRF(
    a: number[],
    b: number[],
    k = 60,
): number[] {
    // накопитель
    const out: number[] = [];
    for (const v of a) out.push(v / (k + 1));   // первый список
    for (const v of b) out.push(v / (k + 1));   // второй список
    return out;
}

export function other(): void {
    console.log("other");
}
`;

/** Тело переписано: другой алгоритм под тем же именем. */
const REWRITTEN = `// заголовок файла
import { x } from "./x.ts";

export function fuseRRF(ranked: Map<string, number>[], k = 60): Map<string, number> {
  const acc = new Map<string, number>();
  for (const list of ranked) {
    let rank = 1;
    for (const [id] of list) acc.set(id, (acc.get(id) ?? 0) + 1 / (k + rank++));
  }
  return acc;
}

export function other(): void {
  console.log("other");
}
`;

const SPAN_START = 4;
const SPAN_END = 9;

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  readonly file: string;
  write(source: string): void;
  /**
   * Настоящий тач: файл ПЕРЕЗАПИСЫВАЕТСЯ тем же текстом до тех пор, пока
   * файловая система не отдаст другой mtime. Подставлять mtime руками нельзя —
   * это проверяло бы наш же вызов `statSync`, а не поведение уровня 2.
   */
  rewriteUntilNewMtime(source: string, was: number): void;
  bind(start?: number, end?: number): AnchorLike;
}

function fx(source: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "myc-anchors-"));
  dirs.push(dir);
  const file = join(dir, "fuse.ts");
  const write = (text: string): void => writeFileSync(file, text);
  write(source);
  return {
    file,
    write,
    rewriteUntilNewMtime(source, was) {
      for (let i = 0; i < 10000; i++) {
        write(source);
        if (Math.floor(statSync(file).mtimeMs) !== was) return;
      }
      throw new Error("mtime не сдвинулся за 10000 перезаписей");
    },
    bind(start = SPAN_START, end = SPAN_END) {
      const b = bindAnchor(readFileSync(file, "utf8"), "ts", start, end, statSync(file));
      return {
        path: "fuse.ts",
        lang: "ts",
        spanStart: b.spanStart,
        spanEnd: b.spanEnd,
        fileHash: b.fileHash,
        spanHash: b.spanHash,
        cruxNorm: b.cruxNorm,
        mtimeMs: b.mtimeMs,
        sizeBytes: b.sizeBytes,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Нормализация
// ---------------------------------------------------------------------------

describe("нормализация: что она обязана съесть, а что обязана сохранить", () => {
  test("комментарии и содержимое строк выброшены", () => {
    const s = normalizeStream(`const a = "секрет"; // хвост\n/* блок */ const b = 1;\n`, "ts");
    expect(s.text).not.toContain("секрет");
    expect(s.text).not.toContain("хвост");
    expect(s.text).not.toContain("блок");
    expect(s.text).toContain("const a=");
    expect(s.text).toContain("const b=1;");
  });

  test("перенос аргументов и висячая запятая не меняют нормализованный текст", () => {
    const oneLine = normalizeStream("f(a: number[], b: number[], k = 60): number[] {\n", "ts");
    const wrapped = normalizeStream(
      "f(\n    a: number[],\n    b: number[],\n    k = 60,\n): number[] {\n",
      "ts",
    );
    expect(wrapped.text).toBe(oneLine.text);
  });

  test("пробел между двумя словами СОХРАНЯЕТСЯ — иначе два токена сливаются в один", () => {
    const s = normalizeStream("const x = 1;\n", "ts");
    expect(s.text).toContain("const x");
    expect(s.text).not.toContain("constx");
  });

  test("ASI-перенос: return\\n  x читается так же, как return x", () => {
    expect(normalizeStream("return\n  x;\n", "ts").text).toBe(
      normalizeStream("return x;\n", "ts").text,
    );
  });

  test("не-L1 язык нормализуется без лексера: комментарии остаются", () => {
    expect(normalizeStream("# коммент\nvalue = 1\n", "py").text).toContain("коммент");
  });

  test("каждый символ потока отображается в строку исходника", () => {
    const s = normalizeStream(ORIGINAL, "ts");
    const at = s.text.indexOf("return out");
    expect(at).toBeGreaterThan(-1);
    expect(s.line[at]).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Привязка
// ---------------------------------------------------------------------------

describe("bindAnchor: что якорь запоминает", () => {
  test("crux ограничен 24 строками и 400 символами", () => {
    const long = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const b = bindAnchor(long, "ts", 1, 200, { mtimeMs: 1, size: long.length });
    expect(b.crux.split("\n").length).toBeLessThanOrEqual(CRUX_MAX_LINES);
    expect(b.cruxNorm.length).toBeLessThanOrEqual(CRUX_MAX_CHARS + 40);
  });

  test("спан за границами файла приводится к файлу, а не записывается как есть", () => {
    const lines = ORIGINAL.split("\n").length;
    const b = bindAnchor(ORIGINAL, "ts", 900, 1000, { mtimeMs: 1, size: 1 });
    expect(b.spanStart).toBeLessThanOrEqual(lines);
    expect(b.spanEnd).toBeGreaterThanOrEqual(b.spanStart);
  });

  test("crux сырой — читаемый код, crux_norm — ключ поиска одной строкой", () => {
    const b = bindAnchor(ORIGINAL, "ts", SPAN_START, SPAN_END, { mtimeMs: 1, size: 1 });
    expect(b.crux).toContain("export function fuseRRF");
    expect(b.crux).toContain("\n");
    expect(b.cruxNorm).not.toContain("\n");
    expect(b.spanHash).toBe(
      hashText(spanNormText(normalizeStream(ORIGINAL, "ts"), SPAN_START, SPAN_END)),
    );
  });
});

// ---------------------------------------------------------------------------
// Три уровня
// ---------------------------------------------------------------------------

describe("три уровня детекта протухания", () => {
  test("уровень 1: ничего не трогали — fresh, файл НЕ читается", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    let reads = 0;
    const io: CheckIo = {
      stat: (p) => {
        const st = statSync(p);
        return { mtimeMs: st.mtimeMs, size: st.size };
      },
      read: (p) => {
        reads++;
        return readFileSync(p, "utf8");
      },
    };
    const r = checkAnchor(a, f.file, io);
    expect(r.state).toBe("fresh");
    expect(r.level).toBe(1);
    expect(reads).toBe(0);
  });

  test("уровень 2: mtime сдвинут, содержимое то же — fresh, разбора нет", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    f.rewriteUntilNewMtime(ORIGINAL, a.mtimeMs);
    const r = checkAnchor(a, f.file);
    expect(r.state).toBe("fresh");
    expect(r.level).toBe(2);
    expect(r.mtimeMs).not.toBe(a.mtimeMs);
  });

  test("уровень 3: ПЕРЕФОРМАТИРОВАНИЕ файла — якорь остаётся валидным", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    f.write(REFORMATTED);
    const r = checkAnchor(a, f.file);
    expect(r.state).toBe("fresh");
    expect(r.level).toBe(3);
    // Над функцией появился doc-комментарий: спан сдвинулся ровно на строку.
    expect(r.spanStart).toBe(5);
    expect(r.moved).toBe(true);
  });

  test("уровень 3: код уехал вниз на 41 строку — якорь едет с ним", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    const pad = Array.from({ length: 40 }, (_, i) => `export const pad${i} = ${i};`).join("\n");
    f.write(`${pad}\n\n${ORIGINAL}`);
    const r = checkAnchor(a, f.file);
    expect(r.state).toBe("fresh");
    expect(r.spanStart).toBe(SPAN_START + 41);
    expect(r.moved).toBe(true);
  });

  test("уровень 3: правка в ДРУГОМ конце файла — спан на месте, moved=false", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    f.write(ORIGINAL.replace("console.log", "globalThis.console.log"));
    const r = checkAnchor(a, f.file);
    expect(r.state).toBe("fresh");
    expect(r.level).toBe(3);
    expect(r.moved).toBe(false);
    expect(r.spanStart).toBe(SPAN_START);
  });

  test("уровень 3: тело переписано — stale, и это единственный честный ответ", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    f.write(REWRITTEN);
    const r = checkAnchor(a, f.file);
    expect(r.state).toBe("stale");
    expect(r.level).toBe(3);
    // `drifted` без меры сходства был бы выдумкой: сходство считает ре-привязка.
    expect(r.drift).toBe(0);
  });

  test("файла нет — уровень 0, отдельная новость от «изменился»", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    rmSync(f.file);
    const r = checkAnchor(a, f.file);
    expect(r.state).toBe("stale");
    expect(r.level).toBe(0);
    expect(r.reason).toContain("не найден");
  });

  test("пустой crux не ищется: пустая игла нашлась бы где угодно", () => {
    const f = fx(ORIGINAL);
    const a: AnchorLike = { ...f.bind(), cruxNorm: "", spanHash: "wy:0" };
    f.write(REWRITTEN);
    const r = checkAnchor(a, f.file);
    expect(r.state).toBe("stale");
    expect(r.reason).toContain("crux пуст");
  });
});

// ---------------------------------------------------------------------------
// Мутации
// ---------------------------------------------------------------------------

describe("МУТАЦИИ: снятый уровень обязан быть виден", () => {
  test("МУТАЦИЯ 1 — детект по содержимому снят: якорь объявляет протухшим нетронутый код", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    f.write(REFORMATTED);
    expect(checkAnchor(a, f.file, undefined, 3).state).toBe("fresh");
    const mutated = checkAnchor(a, f.file, undefined, 2);
    expect(mutated.state).toBe("stale");
    expect(mutated.level).toBe(2);
  });

  test("МУТАЦИЯ 1b — без уровня 3 переехавший код ТЕРЯЕТСЯ: спан указывает на чужое", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    const pad = Array.from({ length: 40 }, (_, i) => `export const pad${i} = ${i};`).join("\n");
    f.write(`${pad}\n\n${ORIGINAL}`);
    // Мутант оставляет спан на 4-9 — а там теперь pad3, чужой код.
    expect(checkAnchor(a, f.file, undefined, 2).spanStart).toBe(SPAN_START);
    expect(checkAnchor(a, f.file, undefined, 3).spanStart).toBe(SPAN_START + 41);
  });

  test("МУТАЦИЯ 2 — сняты уровни 2 и 3: mtime-тач читается как протухание", () => {
    const f = fx(ORIGINAL);
    const a = f.bind();
    f.rewriteUntilNewMtime(ORIGINAL, a.mtimeMs);
    expect(checkAnchor(a, f.file, undefined, 3).state).toBe("fresh");
    expect(checkAnchor(a, f.file, undefined, 1).state).toBe("stale");
  });

  test("МУТАЦИЯ 3 — нормализация переносов и висячей запятой держит переформатирование", () => {
    const oneLine = normalizeStream("f(a, b)\n", "ts").text;
    expect(normalizeStream("f(\n  a,\n  b,\n)\n", "ts").text).toBe(oneLine);
    // Тот же текст без правила висячей запятой отличался бы ровно на неё.
    expect("f(a,b,)").not.toBe(oneLine);
  });
});

// ---------------------------------------------------------------------------
// Поиск переехавшего спана
// ---------------------------------------------------------------------------

describe("findNormalized: дубли разводятся близостью, а не порядком", () => {
  test("из двух одинаковых блоков выбирается ближайший к прежнему спану", () => {
    const body = "function g() {\n  return 1;\n}\n";
    const pad = "const filler = 0;\n".repeat(30);
    const s = normalizeStream(`${body}${pad}${body}`, "ts");
    const needle = spanNormText(s, 1, 3);
    expect(findNormalized(s, needle, 1)).toBe(1);
    expect(findNormalized(s, needle, 40)).toBe(34);
  });

  test("нет совпадения — 0, а не первая строка", () => {
    expect(findNormalized(normalizeStream(ORIGINAL, "ts"), "такогоТекстаНет()", 1)).toBe(0);
  });
});
