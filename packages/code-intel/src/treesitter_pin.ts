/**
 * Пара версий tree-sitter, на которой всё это ЗАПУСКАЕТСЯ, — и больше ничего.
 *
 * Модуль отдельный и НАМЕРЕННО пустой от импортов: его читает
 * `treesitter_pin.test.ts`, и он обязан грузиться даже тогда, когда
 * `symbols.ts` не грузится вовсе. Именно так выглядит поломка ABI на практике:
 * подняли web-tree-sitter до 0.27.0 — и `import Parser from "web-tree-sitter"`
 * падает ещё до первой строки тела («does not have an export named default»),
 * унося с собой любой тест, который через `symbols.ts` прошёл бы. Сообщение
 * при этом называет синтаксис, а не причину. Здесь причина названа прямо.
 *
 *   web-tree-sitter@0.24.7 + tree-sitter-wasms@0.1.13  РАБОТАЕТ
 *   web-tree-sitter@0.27.0 + те же грамматики          НЕ РАБОТАЕТ
 *
 * Менять эти числа можно только вместе с прогоном `treesitter_abi.test.ts`,
 * который грузит настоящий .wasm и разбирает им настоящий файл.
 */

export const PINNED_TREE_SITTER: Readonly<Record<string, string>> = {
  "web-tree-sitter": "0.24.7",
  "tree-sitter-wasms": "0.1.13",
};
