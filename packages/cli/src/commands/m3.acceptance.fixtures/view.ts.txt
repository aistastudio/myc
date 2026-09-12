/**
 * ЧАСТЬ ЧУЖОГО ИНДЕКСА КАК СВОЙ (memory-m0md9fybwrdh).
 *
 * В экосистеме (S59) индекс строится из КОРНЯ воркспейса: одна строка
 * `code_files` на файл, `repo_id = ''`, пути с префиксом вложенного
 * репозитория — `messaging-server/server/src/x.ts`. Агент же стоит во
 * вложенном репозитории или в его git worktree, и охват его вызова —
 * `messaging-server`. Под этим `repo_id` строк нет, и без этого модуля каждый
 * читатель отвечал `precond.no_index`, советуя `myc code index` — то есть
 * построить ВТОРУЮ копию тех же файлов под другим ключом.
 *
 * ВИД — ЭТО ПАРА (чей индекс, какой префикс в нём). Читатель спрашивает строки
 * `repo_id = view.repoId` под `view.prefix`, а наружу отдаёт пути БЕЗ префикса
 * — относительно репозитория, в котором стоит агент. Ключи в базе не меняются:
 * строки не переписываются, и ответ из корня — те же запросы, что были.
 *
 * ПОЧЕМУ НЕ ПЕРЕКЛЮЧЕНИЕ КЛЮЧА (модель «репозиторий + путь от его корня»). Она
 * требовала бы переписать уже построенные индексы (185 МБ у cherry) и якоря, а
 * корень отвечал бы по `repo_id IN (все репозитории)` — то есть ответы из корня
 * менялись бы у всех, а поле `path` корпуса поиска потеряло бы имя репозитория,
 * по которому сейчас находится код. Сравнение — в отчёте задачи и в README.
 *
 * ДИАПАЗОН, А НЕ LIKE. Все таблицы индекса начинают первичный ключ с
 * `(repo_id, path)`, поэтому `path >= 'R/' AND path < 'R0'` — это отрезок того
 * же ключа, а не скан: `'0'` — следующий за `'/'` байт, и все пути `R/…` лежат
 * ровно между границами. LIKE с `_` и `%` в именах каталогов потребовал бы
 * экранирования и индекс бы не взял.
 */

import type { Database } from "bun:sqlite";

/** Какую часть какого индекса читает запрос. */
export interface CodeView {
  /** `repo_id` строк индекса, из которых отвечаем. */
  readonly repoId: string;
  /** Префикс путей внутри того индекса: '' — весь индекс; иначе `R/` со слэшем. */
  readonly prefix: string;
}

/**
 * Что принимает читатель: строка — прежний вызов «весь индекс репозитория»
 * (и прежние запросы байт в байт), вид — часть чужого индекса.
 */
export type RepoRef = string | CodeView;

export function viewOf(ref: RepoRef): CodeView {
  return typeof ref === "string" ? { repoId: ref, prefix: "" } : ref;
}

/** Верхняя граница отрезка путей: `R/` → `R0`. Для пустого префикса не зовётся. */
export function prefixEnd(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/** Путь индекса → путь для выдачи (без префикса вида). */
export function stripPrefix(view: CodeView, path: string): string {
  return view.prefix.length > 0 && path.startsWith(view.prefix) ? path.slice(view.prefix.length) : path;
}

/** Путь из вопроса (относительно репозитория агента) → путь в индексе. */
export function withPrefix(view: CodeView, path: string): string {
  return view.prefix + path;
}

/**
 * Ключ кеша `code_refs` для вида. Кеш fan_in живёт по `(repo_id, name)`, и
 * счёт по ЧАСТИ индекса под ключом всего индекса перетёр бы счёт корня.
 * `` в имени каталога не встречается, и индексатор снимает все такие
 * ключи вместе со своим (`invalidateRefs`), поэтому кеш вида не переживает
 * переиндексации так же, как не переживает её кеш корня.
 */
export function refsCacheKey(view: CodeView): string {
  return view.prefix.length === 0 ? view.repoId : `${view.repoId}${REFS_VIEW_SEP}${view.prefix}`;
}

/** Разделитель ключа кеша вида — один на запись и на инвалидацию. */
export const REFS_VIEW_SEP = "";

/** Есть ли у `repo_id` хоть одна строка — префикс первичного ключа, одна страница. */
export const SQL_HAS_ROWS = "SELECT 1 AS x FROM code_files WHERE repo_id = ?1 LIMIT 1";
/** Есть ли строки под префиксом — отрезок того же ключа. */
const SQL_HAS_PART = "SELECT 1 AS x FROM code_files WHERE repo_id = ?1 AND path >= ?2 AND path < ?3 LIMIT 1";

/**
 * Ближайший индекс, покрывающий репозиторий: свой (префикс пуст) или часть
 * индекса предка. null — ни того, ни другого. Предки — по сегментам имени:
 * `a/b` проверяет `a` с префиксом `b/`, потом корень с `a/b/`; у охвата S59
 * сегмент один, и предок — всегда корень воркспейса.
 */
export function coveringIndex(db: Database, repoId: string): CodeView | null {
  if (db.query(SQL_HAS_ROWS).get(repoId) !== null) return { repoId, prefix: "" };
  return coveringAncestor(db, repoId);
}

/** Часть индекса ПРЕДКА, покрывающая репозиторий, — без оглядки на его собственный. */
export function coveringAncestor(db: Database, repoId: string): CodeView | null {
  const segs = repoId.split("/").filter((s) => s.length > 0);
  for (let i = segs.length - 1; i >= 0; i--) {
    const ancestor = segs.slice(0, i).join("/");
    const prefix = `${segs.slice(i).join("/")}/`;
    if (db.query(SQL_HAS_PART).get(ancestor, prefix, prefixEnd(prefix)) !== null) {
      return { repoId: ancestor, prefix };
    }
  }
  return null;
}
