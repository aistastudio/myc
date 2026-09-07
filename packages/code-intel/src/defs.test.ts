import { describe, expect, test } from "bun:test";
import { DEF_RULES, findBlockEnd, listDefs } from "./defs.ts";

const lines = (src: string) => src.split("\n").length;

const spanOf = (src: string, lang: "ts" | "tsx" | "js" | "jsx", name: string) => {
  const defs = listDefs(src, lang);
  const def = defs.find((d) => d.name === name);
  expect(def).toBeDefined();
  return def!;
};

describe("DEF_RULES", () => {
  test("one table per language: ts/tsx carry type forms, js/jsx do not", () => {
    expect(DEF_RULES.ts).toBe(DEF_RULES.tsx);
    expect(DEF_RULES.js).toBe(DEF_RULES.jsx);
    const tsKinds = new Set(DEF_RULES.ts.map((r) => r.kind));
    const jsKinds = new Set(DEF_RULES.js.map((r) => r.kind));
    expect(tsKinds.has("interface")).toBe(true);
    expect(tsKinds.has("enum")).toBe(true);
    expect(tsKinds.has("type")).toBe(true);
    expect(jsKinds.has("interface")).toBe(false);
    expect(jsKinds.has("enum")).toBe(false);
    expect(jsKinds.has("type")).toBe(false);
    expect(jsKinds.has("function")).toBe(true);
    expect(jsKinds.has("class")).toBe(true);
  });
});

describe("listDefs: top-level forms", () => {
  test("function, async function, generator; declare function has no body and is excluded", () => {
    const src = [
      "function plain() {}",
      "async function awaited() {}",
      "function* gen() {}",
      "declare function declared(): void;",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => [d.name, d.kind])).toEqual([
      ["plain", "function"],
      ["awaited", "function"],
      ["gen", "function"],
    ]);
    expect(defs.map((d) => [d.startLine, d.endLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  test("export default and export forms keep one line span", () => {
    const src = [
      "export function exported() {}",
      "export default function defed() {}",
      "export async function expAsync() {}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => d.name)).toEqual(["exported", "defed", "expAsync"]);
    expect(defs.every((d) => d.startLine === d.endLine)).toBe(true);
  });

  test("class, abstract class, interface, enum, const enum, type alias", () => {
    const src = [
      "class C {}",
      "abstract class AC {}",
      "interface I { a: string }",
      "enum E { A, B }",
      "const enum CE { X }",
      "type T = { a: number };",
      "type G<T> = Map<string, T>;",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => [d.name, d.kind])).toEqual([
      ["C", "class"],
      ["AC", "class"],
      ["I", "interface"],
      ["E", "enum"],
      ["CE", "enum"],
      ["T", "type"],
      ["G", "type"],
    ]);
    expect(defs.map((d) => [d.startLine, d.endLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 7],
    ]);
  });

  test("multi-line class and interface span to closing brace", () => {
    const src = [
      "class Multi {",
      "  a = 1;",
      "}",
      "interface IMulti {",
      "  b: number;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    const cls = defs.find((d) => d.name === "Multi")!;
    const iface = defs.find((d) => d.name === "IMulti")!;
    expect([cls.startLine, cls.endLine]).toEqual([1, 3]);
    expect([iface.startLine, iface.endLine]).toEqual([4, 6]);
  });
});

describe("listDefs: methods and const-arrows", () => {
  test("methods with modifiers inside a class", () => {
    const src = [
      "class Service {",
      "  run() {",
      "    return 1;",
      "  }",
      "  static build() {",
      "    return 2;",
      "  }",
      "  private async fetchAll() {",
      "    return 3;",
      "  }",
      "  get value() {",
      "    return 4;",
      "  }",
      "  constructor() {",
      "    this.a = 1;",
      "  }",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    const methods = defs.filter((d) => d.kind === "method");
    expect(methods.map((m) => m.name)).toEqual([
      "run",
      "build",
      "fetchAll",
      "value",
      "constructor",
    ]);
    expect(methods.map((m) => [m.startLine, m.endLine])).toEqual([
      [2, 4],
      [5, 7],
      [8, 10],
      [11, 13],
      [14, 16],
    ]);
  });

  test("computed method names: [Ident] and [\"string\"]", () => {
    const src = [
      "const KEY = 'dyn';",
      "class Tricky {",
      "  [KEY](): string {",
      "    return 'x';",
      "  }",
      '  ["lit"](): number {',
      "    return 1;",
      "  }",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    const methods = defs.filter((d) => d.kind === "method");
    expect(methods.map((m) => m.name)).toEqual(["[KEY]", '["lit"]']);
    expect(methods.map((m) => [m.startLine, m.endLine])).toEqual([
      [3, 5],
      [6, 8],
    ]);
  });

  test("function overloads: only the implementation is a definition", () => {
    const src = [
      "export function over(a: string): string;",
      "export function over(a: number): number;",
      "export function over(a: unknown): unknown {",
      "  return a;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => [d.name, d.startLine, d.endLine])).toEqual([
      ["over", 3, 5],
    ]);
  });

  test("declare function ambient signatures are not definitions", () => {
    const src = ["declare function ambient(a: number): void;"].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs).toEqual([]);
  });

  test("const arrow with block body, expression body, and multi-line params", () => {
    const src = [
      "const block = (x: number) => {",
      "  return x + 1;",
      "};",
      "const expr = (x: number) =>",
      "  x * 2;",
      "const multi = (",
      "  a: string,",
      "  b: string,",
      ") => {",
      "  return a + b;",
      "};",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => [d.name, d.kind])).toEqual([
      ["block", "function"],
      ["expr", "function"],
      ["multi", "function"],
    ]);
    const block = defs[0]!;
    const expr = defs[1]!;
    const multi = defs[2]!;
    expect([block.startLine, block.endLine]).toEqual([1, 3]);
    expect([expr.startLine, expr.endLine]).toEqual([4, 5]);
    expect([multi.startLine, multi.endLine]).toEqual([6, 11]);
  });

  test("const with non-function value is not a definition", () => {
    const src = [
      "const num = 5;",
      "const obj = { a: 1 };",
      "const viaCall = wrap(() => g());",
      "const fn = () => g();",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => d.name)).toEqual(["fn"]);
  });

  test("class property arrow is not a method definition", () => {
    const src = [
      "class P {",
      "  handler = () => {",
      "    return 1;",
      "  };",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => [d.name, d.kind])).toEqual([["P", "class"]]);
  });

  test("multi-line method signatures with decorators are found", () => {
    const src = [
      "class AnalyticsController {",
      "  @Get('timeline')",
      "  async getTimeline(",
      "    @Query('projectId') projectId: string,",
      "    @Query('from') from?: Date,",
      "  ) {",
      "    return this.service.getTimeline(projectId, from);",
      "  }",
      "  constructor(",
      "    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,",
      "  ) {}",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    const methods = defs.filter((d) => d.kind === "method");
    expect(methods.map((m) => [m.name, m.startLine, m.endLine])).toEqual([
      ["getTimeline", 3, 8],
      ["constructor", 9, 11],
    ]);
  });

  test("multi-line call statements are not methods", () => {
    const src = [
      "function caller() {",
      "  someLongCall(",
      "    argOne,",
      "    argTwo,",
      "  );",
      "  return 1;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => d.name)).toEqual(["caller"]);
  });

  test("named function expressions inside call arguments are not definitions", () => {
    const src = [
      "const Component = forwardRef(function CherryChatWebView(props, ref) {",
      "  return null;",
      "});",
      "function outer() {",
      "  function inner() {",
      "    return 1;",
      "  }",
      "  return inner;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "tsx");
    expect(defs.map((d) => d.name)).toEqual(["outer", "inner"]);
  });

  test("object literal methods are found", () => {
    const src = [
      "const handlers = {",
      "  onClick() {",
      "    return 1;",
      "  },",
      "};",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => d.name)).toEqual(["onClick"]);
    expect(defs[0]!.kind).toBe("method");
  });
});

describe("listDefs: lexical traps", () => {
  test("brace inside regex literal does not close the block", () => {
    const src = [
      "function trap() {",
      "  const re = /}/;",
      "  return re.test(\"}\");",
      "}",
      "function after() {",
      "  return 1;",
      "}",
    ].join("\n");
    const trap = spanOf(src, "ts", "trap");
    expect([trap.startLine, trap.endLine]).toEqual([1, 4]);
  });

  test("regex character class containing slash and brace", () => {
    const src = [
      "function cls() {",
      "  const re = /[}/]/g;",
      "  return re.source;",
      "}",
    ].join("\n");
    const cls = spanOf(src, "ts", "cls");
    expect([cls.startLine, cls.endLine]).toEqual([1, 4]);
  });

  test("division is not mistaken for a regex", () => {
    const src = [
      "function div(x: number): number {",
      "  const half = x / 2;",
      "  return half / (x > 0 ? 1 : 2);",
      "}",
    ].join("\n");
    const div = spanOf(src, "ts", "div");
    expect([div.startLine, div.endLine]).toEqual([1, 4]);
  });

  test("regex after return keyword", () => {
    const src = [
      "function rx() {",
      "  return /ab+c/.test(\"abc\");",
      "}",
    ].join("\n");
    const rx = spanOf(src, "ts", "rx");
    expect([rx.startLine, rx.endLine]).toEqual([1, 3]);
  });

  test("braces inside strings and line comments are ignored", () => {
    const src = [
      "function str() {",
      "  const s = \"}{ }{\";",
      "  const c = '}}';",
      "  // } not a brace",
      "  return s + c;",
      "}",
    ].join("\n");
    const str = spanOf(src, "ts", "str");
    expect([str.startLine, str.endLine]).toEqual([1, 6]);
  });

  test("braces inside block comments spanning lines are ignored", () => {
    const src = [
      "function commented() {",
      "/* } {",
      "   } }}",
      "*/",
      "  return 1;",
      "}",
    ].join("\n");
    const c = spanOf(src, "ts", "commented");
    expect([c.startLine, c.endLine]).toEqual([1, 6]);
  });

  test("template literal text braces are ignored, expression braces counted", () => {
    const src = [
      "function tpl(a: Record<string, number>): string {",
      "  const inner = `${JSON.stringify({ k: a[\"}\"] })}`;",
      "  return `value {not ${inner} a brace}`;",
      "}",
    ].join("\n");
    const t = spanOf(src, "ts", "tpl");
    expect([t.startLine, t.endLine]).toEqual([1, 4]);
  });

  test("nested template literals inside template expressions", () => {
    const src = [
      "function nested(x: string): string {",
      "  return `a${ `b${ x }c` }d`;",
      "}",
    ].join("\n");
    const nt = spanOf(src, "ts", "nested");
    expect([nt.startLine, nt.endLine]).toEqual([1, 3]);
  });

  test("definition-looking lines inside template text are not definitions", () => {
    const src = [
      "const template = `",
      "function fake() {}",
      "`;",
      "function real() {",
      "  return template;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => d.name)).toEqual(["real"]);
    expect(defs.map((d) => [d.startLine, d.endLine])).toEqual([[4, 6]]);
  });

  test("definitions inside comments are not definitions", () => {
    const src = [
      "// function ghost() {}",
      "/* class Ghost {} */",
      "function real() {",
      "  return 1;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => d.name)).toEqual(["real"]);
  });
});

describe("listDefs: nesting and adjacency", () => {
  test("nested definitions get their own spans", () => {
    const src = [
      "export function outer(): number {",
      "  const inner = (x: number): number => {",
      "    return x * 2;",
      "  };",
      "  return inner(21);",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    const outer = defs.find((d) => d.name === "outer")!;
    const inner = defs.find((d) => d.name === "inner")!;
    expect([outer.startLine, outer.endLine]).toEqual([1, 6]);
    expect([inner.startLine, inner.endLine]).toEqual([2, 4]);
  });

  test("adjacent one-liner blocks do not swallow the next definition", () => {
    const src = [
      "function f() {}",
      "function g() {",
      "  return 1;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    expect(defs.map((d) => [d.name, d.startLine, d.endLine])).toEqual([
      ["f", 1, 1],
      ["g", 2, 4],
    ]);
  });

  test("semicolon-less ASI statements end at the next definition", () => {
    const src = [
      "type Alias = number",
      "function next() {",
      "  return 1;",
      "}",
    ].join("\n");
    const defs = listDefs(src, "ts");
    const alias = defs.find((d) => d.name === "Alias")!;
    expect([alias.startLine, alias.endLine]).toEqual([1, 1]);
  });

  test("annotation braces in signature do not capture the body", () => {
    const src = [
      "function ann(cb: { call: () => void }): { ok: boolean } {",
      "  return { ok: true };",
      "}",
    ].join("\n");
    const ann = spanOf(src, "ts", "ann");
    expect([ann.startLine, ann.endLine]).toEqual([1, 3]);
  });
});

describe("listDefs: languages and JSX", () => {
  test("js skips type-only forms", () => {
    const src = [
      "interface Never { a: 1 }",
      "type Alias = 1;",
      "enum E { A }",
      "function ok() {}",
    ].join("\n");
    const defs = listDefs(src, "js");
    expect(defs.map((d) => d.name)).toEqual(["ok"]);
  });

  test("jsx text with apostrophes and braces does not break spans", () => {
    const src = [
      "export function Badge({ label }: { label: string }) {",
      "  return (",
      "    <div className=\"x\" onClick={() => console.log(\"it's fine\")}>",
      "      Don't panic: {label}",
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const badge = spanOf(src, "tsx", "Badge");
    expect([badge.startLine, badge.endLine]).toEqual([1, 7]);
  });
});

describe("findBlockEnd", () => {
  test("returns the line where brace balance closes", () => {
    const src = [
      "function f() {",
      "  if (x) {",
      "    g();",
      "  }",
      "}",
      "const after = 1;",
    ].join("\n");
    expect(findBlockEnd(src, 1)).toBe(5);
    expect(findBlockEnd(src, 2)).toBe(4);
  });

  test("statement without braces ends on the same line", () => {
    const src = "const x = 1;";
    expect(findBlockEnd(src, 1)).toBe(1);
  });
});

describe("mutations degrade measurement", () => {
  const src = [
    "function f() {",
    "  const s = \"}\";",
    "  const t = `row: { col`;",
    "  const re = /}/;",
    "  return s.length + t.length;",
    "}",
    "function g() {",
    "  return 2;",
    "}",
  ].join("\n");

  test("baseline handles strings, templates and regex", () => {
    const f = spanOf(src, "ts", "f");
    expect([f.startLine, f.endLine]).toEqual([1, 6]);
  });

  test("mutation ignoreStrings miscounts", () => {
    const defs = listDefs(src, "ts", { ignoreStrings: true });
    const f = defs.find((d) => d.name === "f");
    expect(f).toBeDefined();
    expect([f!.startLine, f!.endLine]).not.toEqual([1, 6]);
  });

  test("mutation ignoreTemplateExprs miscounts", () => {
    const defs = listDefs(src, "ts", { ignoreTemplateExprs: true });
    const f = defs.find((d) => d.name === "f");
    expect(f).toBeDefined();
    expect([f!.startLine, f!.endLine]).not.toEqual([1, 6]);
  });

  test("mutation naiveEnd collapses the span", () => {
    const defs = listDefs(src, "ts", { naiveEnd: true });
    const f = defs.find((d) => d.name === "f");
    expect(f).toBeDefined();
    expect(f!.endLine).toBe(f!.startLine);
  });
});

describe("sanity", () => {
  test("no definitions in empty source", () => {
    expect(listDefs("", "ts")).toEqual([]);
    expect(lines("a\nb")).toBe(2);
  });
});
