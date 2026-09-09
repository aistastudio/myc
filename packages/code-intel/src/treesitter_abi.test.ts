/**
 * СТОРОЖ ABI. web-tree-sitter и грамматики tree-sitter-wasms собираются
 * порознь, и их бинарный интерфейс совпадает не всегда:
 *
 *   web-tree-sitter@0.24.7 + tree-sitter-wasms@0.1.13  РАБОТАЕТ
 *   web-tree-sitter@0.27.0 + те же грамматики          ПАДАЕТ (getDylinkMetadata)
 *
 * Расхождение НЕ ловится ни типами, ни сборкой: импорт валиден, `Parser.init`
 * проходит, падает загрузка первой же грамматики — то есть первый файл в
 * проде. Комментарий «не обновляйте» такое не держит, поэтому здесь тест.
 *
 * Сторож двухслойный, и слои РАЗНЕСЕНЫ ПО ФАЙЛАМ намеренно:
 *   1) ПИН — `treesitter_pin.test.ts`: версии совпадают с PINNED_TREE_SITTER и
 *      объявлены точно, без ^ и ~. Тот файл не импортирует web-tree-sitter,
 *      поэтому переживает несовместимую пару и НАЗЫВАЕТ её.
 *   2) ЗАПУСК — здесь: настоящая загрузка .wasm и разбор, то самое место, где
 *      ABI и расходится. Пин без запуска ловил бы только нашу неаккуратность
 *      в package.json, но не саму несовместимость.
 *
 * МУТАЦИЯ (проверялась прогоном `bun add --exact web-tree-sitter@0.27.0`):
 * этот файл перестаёт грузиться вовсе — `import Parser from "web-tree-sitter"`
 * падает на отсутствии default-экспорта, — а слой 1 краснеет по существу и
 * называет версию. После возврата на 0.24.7 оба зелёные.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DEF_LANGS, grammarPath, listDefs, loadLang } from "./symbols.ts";

describe("грамматики запускаются на этой паре версий", () => {
  test("каждый язык L1 имеет свой .wasm на диске", () => {
    for (const lang of DEF_LANGS) {
      expect({ lang, exists: existsSync(grammarPath(lang)) }).toEqual({ lang, exists: true });
    }
  });

  // Именно здесь падает несовместимая пара: Language.load читает dylink-секцию
  // модуля, и на разошедшемся ABI бросает getDylinkMetadata.
  for (const lang of ["ts", "py"] as const) {
    test(`${lang}: грамматика грузится и даёт символы`, async () => {
      await loadLang(lang);
      const source =
        lang === "ts" ? "export function f(): number {\n  return 1;\n}\n" : "def f():\n    return 1\n";
      const defs = listDefs(source, lang);
      expect(defs.map((d) => [d.name, d.kind])).toEqual([["f", "function"]]);
    });
  }
});
