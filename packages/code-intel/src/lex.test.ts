/**
 * Лексер `classifyCode` — маска «код / не код». Тело переехало из `defs.ts`
 * без правок (memory-hrsae2f1mf7a), и вместе с ним обязаны переехать те
 * мутации, которые доказывали, что маска что-то считает.
 *
 * Раньше они стояли на спанах `listDefs`: ослабляем лексер — разъезжается
 * конец определения. Разбор символов ушёл в tree-sitter и лексером больше не
 * пользуется, но САМ ЛЕКСЕР ЖИВ: `anchors.ts` нормализует им крукс якоря, и
 * именно от этой маски зависит, попадёт ли в отпечаток содержимое строкового
 * литерала или комментария. Поэтому мутации проверяются здесь — на том, что
 * они на самом деле ломают.
 *
 * МУТАЦИИ:
 *   ignoreStrings        — строки считаются кодом; `"}"` внутри строки
 *                          становится кодом, и якорь начинает зависеть от
 *                          текста литерала;
 *   ignoreTemplateExprs  — текст шаблона не отличается от `${}`.
 */

import { describe, expect, test } from "bun:test";
import { MASK_CODE, classifyCode } from "./lex.ts";

/** Индексы всех символов `ch`, помеченных как код. */
function codeAt(source: string, ch: string, opts = {}): number[] {
  const mask = classifyCode(source, opts).code;
  const out: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === ch && mask[i] === MASK_CODE) out.push(i);
  }
  return out;
}

describe("classifyCode: что считается кодом", () => {
  test("скобка внутри строкового литерала кодом не является", () => {
    const src = 'const s = "}";\n';
    expect(codeAt(src, "}")).toEqual([]);
  });

  test("скобка внутри однострочного комментария кодом не является", () => {
    const src = "// } не скобка\nconst a = 1;\n";
    expect(codeAt(src, "}")).toEqual([]);
  });

  test("скобки внутри блочного комментария на несколько строк не код", () => {
    const src = "/* } {\n   } }}\n*/\nconst a = 1;\n";
    expect(codeAt(src, "}")).toEqual([]);
    expect(codeAt(src, "{")).toEqual([]);
  });

  test("скобка внутри регекспа не код, а деление — не регексп", () => {
    expect(codeAt("const re = /}/;\n", "}")).toEqual([]);
    const div = "const half = x / 2;\nconst t = }\n";
    expect(codeAt(div, "}").length).toBe(1);
  });

  test("текст шаблона не код, а выражение внутри ${} — код", () => {
    const src = "const t = `a { b ${ { k: 1 } } c`;\n";
    // Обе скобки текста шаблона (`{` после `a` и закрывающая в `c`) не код,
    // а объектный литерал внутри ${} — код.
    expect(codeAt(src, "{").length).toBe(2); // ${ и { объектного литерала
    expect(codeAt(src, "}").length).toBe(2);
  });

  test("lineFirstCode: строка без кода помечена -1", () => {
    const mask = classifyCode("// комментарий\nconst a = 1;\n");
    expect(mask.lineFirstCode[0]).toBe(-1);
    expect(mask.lineFirstCode[1]).toBe("// комментарий\n".length);
  });
});

describe("мутации лексера", () => {
  test("мутация ignoreStrings: содержимое строки становится кодом", () => {
    const src = 'const s = "}";\n';
    expect(codeAt(src, "}")).toEqual([]);
    expect(codeAt(src, "}", { ignoreStrings: true }).length).toBe(1);
  });

  test("мутация ignoreTemplateExprs: текст шаблона становится кодом", () => {
    const src = "const t = `row: { col`;\n";
    expect(codeAt(src, "{")).toEqual([]);
    expect(codeAt(src, "{", { ignoreTemplateExprs: true }).length).toBe(1);
  });
});
