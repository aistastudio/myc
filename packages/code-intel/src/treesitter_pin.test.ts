/**
 * СЛОЙ 1 сторожа ABI: пин версий. Второй слой — `treesitter_abi.test.ts`,
 * который грузит настоящую грамматику; см. `treesitter_pin.ts`.
 *
 * Этот файл не импортирует ни `symbols.ts`, ни web-tree-sitter НАРОЧНО: на
 * несовместимой паре импорт падает первым, и тогда единственное, что видно в
 * CI, — «module does not have an export named default». Здесь же красным
 * становится проверка с именем версии, и починка читается из сообщения.
 *
 * МУТАЦИЯ (проверена прогоном): `bun add --exact web-tree-sitter@0.27.0` —
 * краснеет «установлен ровно 0.24.7» и «объявлен точной версией»; после
 * возврата на 0.24.7 всё зелёное.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_TREE_SITTER } from "./treesitter_pin.ts";

const here = dirname(fileURLToPath(import.meta.url));

function installedVersion(pkg: string): string {
  const manifest = Bun.resolveSync(`${pkg}/package.json`, here);
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

function declaredRange(pkg: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies?.[pkg];
}

describe("пин версий tree-sitter", () => {
  for (const [pkg, version] of Object.entries(PINNED_TREE_SITTER)) {
    test(`${pkg} установлен ровно ${version} (иначе ABI грамматик расходится)`, () => {
      expect(installedVersion(pkg)).toBe(version);
    });

    // Диапазон означает, что `bun install` на чистой машине может принести
    // другую пару — и падение придёт не сюда, а к пользователю на первом файле.
    test(`${pkg} объявлен точной версией, а не диапазоном`, () => {
      expect(declaredRange(pkg)).toBe(version);
    });
  }
});
