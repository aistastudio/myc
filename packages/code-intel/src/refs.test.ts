/**
 * Поведение `listRefs`/`listDefsAndRefs` (memory-e34bfse29jdw).
 *
 * Проверяется ровно то, чем ссылка отличается от текстового счёта
 * (`code_refs`): место, вид и ОХВАТЫВАЮЩИЙ СИМВОЛ. Проверки владельца стоят
 * отдельным набором, и его же роняет мутация `naiveOwner` — иначе «нашли
 * вхождение» и «построили ребро графа» неразличимы, а это и есть вся задача.
 *
 * beforeAll — по той же причине, что в symbols.test.ts: грамматика грузится
 * асинхронно, разбор синхронен и без грамматики падает громко.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { listDefs, loadLangs } from "./symbols.ts";
import { listDefsAndRefs, listRefs, type Ref, type RefKind } from "./refs.ts";

beforeAll(async () => {
  await loadLangs(["ts", "tsx", "js", "py"]);
});

/** Ссылки на одно имя — компактно, чтобы ожидания читались строкой. */
const to = (src: string, lang: "ts" | "tsx" | "js" | "py", name: string): Ref[] =>
  listRefs(src, lang).filter((r) => r.name === name);

const shape = (rs: Ref[]): Array<[number, RefKind, string]> =>
  rs.map((r) => [r.line, r.kind, r.from]);

describe("listRefs: виды вхождений", () => {
  const src = [
    'import { helper, type Shape } from "./m.ts";', // 1
    "const alias = helper;", // 2
    "function use(x: Shape) {", // 3
    "  helper(x);", // 4
    "  obj.method();", // 5
    "  const n = obj.field;", // 6
    "  return new Thing(n);", // 7
    "}", // 8
  ].join("\n");

  test("импорт, чтение, вызов, тип, конструктор и поле различаются", () => {
    expect(shape(to(src, "ts", "helper"))).toEqual([
      [1, "import", ""],
      [2, "read", ""],
      [4, "call", "use"],
    ]);
    expect(shape(to(src, "ts", "Shape"))).toEqual([
      [1, "import", ""],
      [3, "type", "use"],
    ]);
    expect(shape(to(src, "ts", "method"))).toEqual([[5, "call", "use"]]);
    expect(shape(to(src, "ts", "field"))).toEqual([[6, "prop", "use"]]);
    expect(shape(to(src, "ts", "Thing"))).toEqual([[7, "new", "use"]]);
    // Объект вызова — обычное чтение имени: `obj.method()` зовёт `method`,
    // но `obj` при этом читается, и потерять это значит потерять модуль.
    expect(shape(to(src, "ts", "obj"))).toEqual([
      [5, "read", "use"],
      [6, "read", "use"],
    ]);
  });

  test("собственное имя определения ссылкой не становится", () => {
    // `use` объявлен здесь и только здесь: определение уже лежит в code_defs,
    // и считать его ещё и ссылкой значит завысить fan_in вдвое.
    expect(to(src, "ts", "use")).toEqual([]);
  });
});

describe("listRefs: чего в ссылках нет", () => {
  test("комментарии и строковые литералы не дают ссылок", () => {
    const src = [
      "// helper вызывается ниже", // 1
      '/* helper тоже здесь */', // 2
      'const s = "helper";', // 3
      "const t = `helper`;", // 4
      "helper();", // 5
    ].join("\n");
    expect(shape(to(src, "ts", "helper"))).toEqual([[5, "call", ""]]);
  });

  test("выражение внутри шаблонной строки — ссылка, текст вокруг — нет", () => {
    const src = ["const t = `helper: ${helper(1)}`;"].join("\n");
    expect(shape(to(src, "ts", "helper"))).toEqual([[1, "call", ""]]);
  });

  test("параметры и деструктуризация — объявления, а не ссылки", () => {
    const src = [
      "function f(helper, { a: helper2 }, [helper3]) {", // 1
      "  return helper;", // 2
      "}", // 3
    ].join("\n");
    // Параметр `helper` заслоняет чужое имя, а не ссылается на него; ЧТЕНИЕ
    // на строке 2 записывается — различать локаль от импорта этот разбор не
    // умеет и не притворяется (см. шапку refs.ts).
    expect(shape(to(src, "ts", "helper"))).toEqual([[2, "read", "f"]]);
    expect(to(src, "ts", "helper2")).toEqual([]);
    expect(to(src, "ts", "helper3")).toEqual([]);
  });

  test("псевдоним импорта: ссылка на имя источника, не на локальное", () => {
    const src = ['import { listDefs as parse } from "./symbols.ts";', "parse();"].join("\n");
    expect(shape(to(src, "ts", "listDefs"))).toEqual([[1, "import", ""]]);
    // `parse` в чужом файле не существует — но его ВЫЗОВ записан как есть, и
    // связь `parse → listDefs` здесь не восстанавливается (граница задачи).
    expect(shape(to(src, "ts", "parse"))).toEqual([[2, "call", ""]]);
  });

  test("реэкспорт — ссылка на имя ИСТОЧНИКА, а не на псевдоним", () => {
    const src = [
      'export { walkFiles, langOf as lo } from "./langs.ts";', // 1
      "export { local };", // 2
      'export type { Def } from "./symbols.ts";', // 3
    ].join("\n");
    expect(shape(to(src, "ts", "walkFiles"))).toEqual([[1, "import", ""]]);
    expect(shape(to(src, "ts", "langOf"))).toEqual([[1, "import", ""]]);
    expect(to(src, "ts", "lo")).toEqual([]);
    expect(shape(to(src, "ts", "Def"))).toEqual([[3, "import", ""]]);
    // Без `from` реэкспортируется СВОЁ имя: назвать это импортом значит
    // соврать про то, откуда символ взялся.
    expect(shape(to(src, "ts", "local"))).toEqual([[2, "read", ""]]);
  });

  test("catch (e) объявляет имя, а не ссылается на него", () => {
    const src = ["try {", "  go();", "} catch (problem) {", "  log(1);", "}"].join("\n");
    expect(to(src, "ts", "problem")).toEqual([]);
  });

  test("ключ объектного литерала — не обращение к имени", () => {
    const src = ["const o = { helper: 1 };", "const p = { helper };"].join("\n");
    // Строка 1 — ключ, строка 2 — сокращённая запись, то есть ЧТЕНИЕ helper.
    expect(shape(to(src, "ts", "helper"))).toEqual([[2, "read", ""]]);
  });

  test("два вхождения одного имени в одной строке и роли — одна ссылка", () => {
    const src = ["const pair = [helper(1), helper(2)];"].join("\n");
    expect(shape(to(src, "ts", "helper"))).toEqual([[1, "call", ""]]);
  });
});

describe("listRefs: охватывающий символ", () => {
  const src = [
    'import { helper } from "./m.ts";', // 1
    "const top = helper;", // 2
    "function outer() {", // 3
    "  function inner() {", // 4
    "    return helper();", // 5
    "  }", // 6
    "  return inner() + helper();", // 7
    "}", // 8
    "class Repo {", // 9
    "  save() {", // 10
    "    return helper();", // 11
    "  }", // 12
    "}", // 13
    "const arrow = () => helper();", // 14
  ].join("\n");

  test("владелец — САМОЕ ВНУТРЕННЕЕ определение, а не файл и не внешнее", () => {
    expect(shape(to(src, "ts", "helper"))).toEqual([
      [1, "import", ""],
      [2, "read", ""],
      [5, "call", "inner"],
      [7, "call", "outer"],
      [11, "call", "save"],
      [14, "call", "arrow"],
    ]);
  });

  test("fromStart указывает на строку определения-владельца", () => {
    const byLine = new Map(listRefs(src, "ts").map((r) => [`${r.name}:${r.line}`, r]));
    expect(byLine.get("helper:5")!.fromStart).toBe(4); // inner
    expect(byLine.get("helper:7")!.fromStart).toBe(3); // outer
    expect(byLine.get("helper:11")!.fromStart).toBe(10); // save
    expect(byLine.get("helper:2")!.fromStart).toBe(0); // верхний уровень файла
  });

  test("(from, fromStart) совпадает со строкой code_defs", () => {
    const defs = listDefs(src, "ts");
    for (const r of listRefs(src, "ts")) {
      if (r.from === "") continue;
      const owner = defs.find((d) => d.name === r.from && d.startLine === r.fromStart);
      expect(owner).toBeDefined();
      // Владелец обязан СОДЕРЖАТЬ ссылку — иначе привязка врёт молча.
      expect(r.line).toBeGreaterThanOrEqual(owner!.startLine);
      expect(r.line).toBeLessThanOrEqual(owner!.endLine);
    }
  });

  test("МУТАЦИЯ naiveOwner: места на месте, владельцев нет", () => {
    const refs = listRefs(src, "ts", { naiveOwner: true });
    expect(refs.filter((r) => r.name === "helper").length).toBe(6);
    expect(refs.every((r) => r.from === "" && r.fromStart === 0)).toBe(true);
  });
});

describe("listDefsAndRefs", () => {
  const src = [
    "function outer() {", // 1
    "  const inner = () => helper();", // 2
    "  return inner;", // 3
    "}", // 4
  ].join("\n");

  test("определения те же, что у listDefs — один обход, один ответ", () => {
    expect(listDefsAndRefs(src, "ts").defs).toEqual(listDefs(src, "ts"));
  });

  test("naiveEnd действует на определения и не трогает ссылки", () => {
    const { defs, refs } = listDefsAndRefs(src, "ts", { naiveEnd: true });
    expect(defs.every((d) => d.startLine === d.endLine)).toBe(true);
    expect(refs.some((r) => r.name === "helper" && r.from === "inner")).toBe(true);
  });
});

describe("listRefs: python", () => {
  const src = [
    "from mymod import helper", // 1
    "import os", // 2
    "", // 3
    "def top(a):", // 4
    "    return helper(a)", // 5
    "", // 6
    "class Repo:", // 7
    "    def save(self, p):", // 8
    "        os.path.join(p)", // 9
    "        return helper(p)", // 10
  ].join("\n");

  test("импорт, вызов и владелец-метод", () => {
    expect(shape(to(src, "py", "helper"))).toEqual([
      [1, "import", ""],
      [5, "call", "top"],
      [10, "call", "save"],
    ]);
    expect(shape(to(src, "py", "join"))).toEqual([[9, "call", "save"]]);
  });

  test("except Err as e: класс — ссылка, локальное имя — нет", () => {
    const py = ["try:", "    go()", "except Err as problem:", "    log(1)"].join("\n");
    expect(shape(to(py, "py", "Err"))).toEqual([[3, "read", ""]]);
    expect(to(py, "py", "problem")).toEqual([]);
  });

  test("параметры функции ссылками не считаются", () => {
    expect(to(src, "py", "self")).toEqual([]);
    // `p` — параметр на строке 8 (объявление) и чтение на 9 и 10.
    expect(shape(to(src, "py", "p"))).toEqual([
      [9, "read", "save"],
      [10, "read", "save"],
    ]);
  });
});

describe("listRefs: js и tsx", () => {
  test("js без типовых форм даёт те же вызовы", () => {
    const src = ["const f = () => helper();", "f();"].join("\n");
    expect(shape(to(src, "js", "helper"))).toEqual([[1, "call", "f"]]);
    expect(shape(to(src, "js", "f"))).toEqual([[2, "call", ""]]);
  });

  test("tsx: компонент в разметке — ссылка на имя", () => {
    const src = ["function App() {", "  return <Widget prop={helper()} />;", "}"].join("\n");
    expect(shape(to(src, "tsx", "helper"))).toEqual([[2, "call", "App"]]);
    expect(to(src, "tsx", "Widget").length).toBeGreaterThan(0);
    expect(to(src, "tsx", "Widget")[0]!.from).toBe("App");
  });
});
