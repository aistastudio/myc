import type { Migration } from "../migrate.ts";

/**
 * Схема код-интеллекта, версия 5: кеш fan_in по слову
 * (§4.3 docs/design/05-code-intelligence.md, решение S52, задача T5).
 *
 * `n_files`/`n_hits` — число файлов и вхождений \\bNAME\\b минус строка
 * определения. Это ВЕРХНЯЯ ОЦЕНКА (§4.3): текстовый fan_in путает одноимённые
 * символы, поэтому потребители обязаны подписывать ответ fan_in_source
 * ('text' | 'graft') — таблица сама по себе источник не называет.
 *
 * КЕШ, А НЕ ВЫЧИСЛЕНИЕ: пересчёт по всем символам репозитория означает полный
 * проход по содержимому — сотни миллисекунд, несовместимые с бюджетом
 * повторного индекса ≤ 20 мс. Поэтому индексатор НЕ наполняет таблицу, а
 * только ИНВАЛИДИРУЕТ: строки с именами символов изменённого/удалённого файла
 * удаляются, и fan_in (T5) считает их заново по требованию, возвращая в кеш с
 * вычисленным computed_at.
 *
 * PRIMARY KEY (repo_id, name) — ровно одна оценка на символ репозитория;
 * INVALIDATION идёт по тому же ключу, что и чтение T5.
 */
const SQL = `CREATE TABLE code_refs (
  repo_id     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  n_files     INTEGER NOT NULL,             -- в скольких файлах встретилось имя
  n_hits      INTEGER NOT NULL,             -- сколько всего вхождений \\bNAME\\b
  computed_at INTEGER NOT NULL,             -- когда посчитано, устаревание — через инвалидацию
  PRIMARY KEY (repo_id, name)
) WITHOUT ROWID`;

export const migration005CodeRefs: Migration = {
  version: 5,
  name: "code_refs",
  sql: SQL,
  objects: ["code_refs"],
};
