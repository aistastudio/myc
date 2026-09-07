/**
 * Поиск воркспейса на диске — и БОЛЬШЕ НИЧЕГО.
 *
 * Отдельный модуль не ради опрятности, а ради цены. Эти четыре функции жили в
 * `store.ts`, а тот тянет @myc/core, @myc/store-sqlite и bun:sqlite: в
 * собранном бинаре один только его импорт стоит ~9 мс. Хуку post-edit
 * (`myc anchor touch`) нужен из всего этого один подъём к каталогу `.myc`, а
 * платил бы он за граф модулей целиком — на КАЖДУЮ правку агента, сотни раз
 * за сессию. Замер до и после разделения — в шапке `buildAnchorTouch`.
 *
 * Правило модуля: сюда можно импортировать только `node:*`. Первый же импорт
 * из @myc/* вернёт ту самую цену обратно и молча.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** ~/.myc по умолчанию; MYC_HOME — явный override (тесты, контейнеры, S41). */
export function personalHome(): string {
  return process.env.MYC_HOME ?? homedir();
}

/**
 * Репозиторий экосистемы (S59) — каталог со СВОИМ `.git`. Файл `.git`
 * (submodule, worktree) считается наравне с каталогом: это тот же
 * самостоятельный репозиторий, просто с вынесенным служебным каталогом.
 */
export function isRepoDir(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Корень воркспейса по пути к базе — для явного `--db`, который поиск
 * каталога обходит. `<dir>/.myc/myc.db` даёт `<dir>`; любой другой путь
 * (тесты и бенчи открывают базу файлом где угодно) корня НЕ даёт, и охват
 * репозитория честно остаётся неопределённым вместо выдуманного общего.
 */
export function workspaceDirOfDb(dbPath: string): string | undefined {
  const mycDir = dirname(resolve(dbPath));
  if (mycDir.split("/").pop() !== ".myc") return undefined;
  return dirname(mycDir);
}

/**
 * Подъём от стартового каталога к первому `.myc/myc.db`. Домашний каталог
 * САМ проверяется, только если это стартовый каталог; при подъёме СНИЗУ он из
 * проверки исключается — иначе личный ярус молча подменил бы проектный.
 */
export function findWorkspaceDb(
  startDir: string,
): { readonly dbPath: string; readonly wsDir: string } | { readonly searched: readonly string[] } {
  const boundary = resolve(personalHome());
  const searched: string[] = [];
  let dir = resolve(startDir);
  let climbed = false;
  for (;;) {
    if (climbed && dir === boundary) break;
    const dbPath = join(dir, ".myc", "myc.db");
    searched.push(dbPath);
    if (existsSync(dbPath)) return { dbPath, wsDir: dir };
    const parent = dirname(dir);
    if (parent === dir) break; // корень ФС — дальше подниматься некуда
    dir = parent;
    climbed = true;
  }
  return { searched };
}
