/**
 * Языки и обход дерева — общее для индекса (`code_index.ts`) и для выбора
 * реализации (`select.ts`).
 *
 * Вынесено из `code_index.ts` не ради красоты: `select.ts` зовёт `init`, а
 * `code_index.ts` тянет за собой `@myc/store-sqlite` и разбор определений.
 * Платить этим графом модулей за одну строку отчёта `init` нельзя (И1,
 * холодный старт), а знать «есть ли в этом дереве ts/tsx/js/jsx» ему
 * обязательно — иначе строка обещает символы репозиторию, в котором их не
 * будет никогда (§5, уровень L0).
 */

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Языки уровня L1 (§5): определения разбираются только для них. */
export const L1_LANGS: ReadonlySet<string> = new Set(["ts", "tsx", "js", "jsx"]);

export const LANG_BY_EXT: ReadonlyMap<string, string> = new Map([
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".jsx", "jsx"],
  [".mjs", "js"],
  [".cjs", "js"],
]);

/**
 * Каталоги, в которые индекс не входит никогда.
 *
 * `.myc` здесь по той же причине, что `node_modules`: это состояние самого
 * myc, а не код репозитория, и в нём лежит база воркспейса — на этом
 * репозитории 41 МБ, которые скан читал бы и хешировал при каждом прогоне
 * ради строки реестра, меняющейся от любой записи в очередь.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".myc",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);

/** Язык файла: L1-идентификатор или расширение без точки (L0). */
export function langOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return LANG_BY_EXT.get(ext) ?? ext.replace(/^\./, "");
}

/** Все файлы дерева относительными POSIX-путями; SKIP_DIRS не обходятся. */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // каталог исчез до обхода — не наша гонка
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
        continue;
      }
      if (!e.isFile()) continue;
      out.push(relative(root, p).split(sep).join("/"));
    }
  }
  return out;
}

/**
 * Есть ли в дереве хоть один файл уровня L1 — и какие расширения встретились
 * по дороге. Не скан индекса: обход обрывается на ПЕРВОМ L1-файле, а в дереве
 * без них ограничен потолком записей, чтобы строка `init` не стоила прохода
 * по чужому монорепозиторию.
 *
 * `langs` заполняется только до обрыва: это подсказка «на чём тут пишут»,
 * а не статистика (её считает `code_files`, §5).
 */
export function probeL1Files(
  root: string,
  maxEntries = 4_000,
): { readonly found: boolean; readonly seen: number; readonly langs: readonly string[]; readonly capped: boolean } {
  const langs = new Set<string>();
  const stack: string[] = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      const lang = langOf(e.name);
      if (L1_LANGS.has(lang)) return { found: true, seen, langs: [...langs, lang], capped: false };
      if (lang.length > 0 && langs.size < 12) langs.add(lang);
      if (seen >= maxEntries) {
        return { found: false, seen, langs: [...langs], capped: true };
      }
    }
  }
  return { found: false, seen, langs: [...langs], capped: false };
}
