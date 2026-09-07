import type { Migration } from "../migrate.ts";

/**
 * Схема код-интеллекта, версия 4: определения символов по файлам
 * (§4.3 docs/design/05-code-intelligence.md, решение S52).
 *
 * Форма Primary Key повторяет набросок спецификации — (repo_id, path, name,
 * span_start): один и тот же символ может быть объявлен в файле дважды
 * (перегрузка, одинаковые имена метода в разных классах файла), и терять
 * второй спан нельзя — ре-привязка якоря (T6) ищет ПО СПАНУ. WITHOUT ROWID:
 * единственный доступ — от ключа, тело строки крошечное.
 *
 * `exported` — пометка «экспортируется из файла» (§4.1, вариант C:
 * Bun.Transpiler.scan). В первой версии всегда 0: scan — необязательная
 * надстройка, а колонка нужна схеме сразу, чтобы T4/T5 не ловили миграцию
 * позже. CHECK держит колонку честной булевой.
 *
 * Индексов сверх PK не нужно: чтение «дефсы файла» — префикс (repo_id, path)
 * по PK, чистка файла — тот же префикс, поиск символа по репозиторию —
 * (repo_id, name) тоже префикс PK при порядке колонок (repo, path, name, …)
 * только для скана всего файла; символьный поиск (T4) идёт через полный скан
 * по repo_id — допустимо, корпус репозитория в десятки тысяч строк.
 *
 * Строки файла заменяются ЦЕЛИКОМ одной транзакцией воркера (DELETE по
 * префиксу + INSERT заново): частичные обновления спанов скупили бы
 * миллисекунды ценой рассинхрона, который нечем поймать.
 */
const SQL = `CREATE TABLE code_defs (
  repo_id    TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,              -- function|class|method|type|interface|enum
  span_start INTEGER NOT NULL,              -- 1-based, включительно — как file:line
  span_end   INTEGER NOT NULL,              -- включительно, конец по скобочному балансу
  exported   INTEGER NOT NULL DEFAULT 0 CHECK (exported IN (0, 1)),
  PRIMARY KEY (repo_id, path, name, span_start)
) WITHOUT ROWID`;

export const migration004CodeDefs: Migration = {
  version: 4,
  name: "code_defs",
  sql: SQL,
  objects: ["code_defs"],
};
