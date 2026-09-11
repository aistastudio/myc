/**
 * `.myc/.gitignore` — один список локальных файлов для init и wire.
 *
 * Отдельный модуль, чтобы wire не тянул за собой init со всеми его
 * зависимостями ради двух функций.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * S42/myc-qie.11: `.myc/.gitignore` — только оплог, meta.json, .gitattributes
 * и workspace.toml идут в git; база sqlite (и её -wal/-shm/-journal, S42
 * дискуссия про мержи бинарников) и кеш проекций (уже само-игнорируется, но
 * дублируем здесь — работает и до первого `myc export`) остаются локальными.
 * Список — не markdown-блок с маркерами, а плоские строки: писать в конец
 * недостающие построчно достаточно для идемпотентности и не тянет за собой
 * парсер разметки.
 */
export const MYC_GITIGNORE_LINES = [
  "myc.db",
  "myc.db-wal",
  "myc.db-shm",
  "myc.db-journal",
  "projections/",
  // Кеш детекта код-интеллекта (S52): он про эту машину — какой PATH, где
  // лежит graft. Закоммитить его значит навязать чужому клону свой PATH.
  "state.json",
  // Тоже про эту машину: счётчики хуков, журнал wire с абсолютными путями,
  // кеш бутстрапа, журнал грязных файлов якорей. Без этих строк они висели
  // неотслеживаемыми в `git status` проекта (cherry, 2026-09-11) и уехали бы
  // в первый же `git add -A`.
  "hooks.json",
  "wire.json",
  "bootstrap.cache.json",
  "anchor-dirty.log",
] as const;

function mycGitignoreContent(): string {
  return [
    "# myc (S42): local files — kept out of git",
    "# the oplog, meta.json, .gitattributes and workspace.toml are committed as is",
    ...MYC_GITIGNORE_LINES,
    "",
  ].join("\n");
}

/**
 * Пишет `.myc/.gitignore`, если его ещё нет; иначе дописывает только те
 * строки из MYC_GITIGNORE_LINES, которых не хватает — не трогая остальное
 * содержимое (в т.ч. добавленное пользователем) и не дублируя уже
 * присутствующие строки при повторном `init`. Зовут его init и wire: у
 * воркспейса, созданного старой сборкой, недостающие строки дописывает
 * первый же wire.
 */
export function ensureMycGitignore(mycDir: string, by: "init" | "wire" = "init"): void {
  const path = join(mycDir, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, mycGitignoreContent(), "utf8");
    return;
  }
  const existing = readFileSync(path, "utf8");
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = MYC_GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(
    path,
    `${existing}${sep}# myc: added automatically by ${by}\n${missing.join("\n")}\n`,
    "utf8",
  );
}
