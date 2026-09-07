# Задача J — T2: таблицы код-интеллекта и фоновый индекс (memory-8p6p0nwvzhmm)

Отчёт о выполнении. Репозиторий замера: `<repo2>/messaging-server`
(рабочее дерево 1907 git-файлов, из них **1518** файлов L1-языков — число из приёмки;
12 021 определений в базе после полного индекса).

## Что сделано

1. **Миграции** (строгая дисциплина: один оператор на миграцию, версии 3–5 базового набора):
   - `packages/store-sqlite/src/migrations/003-code-files.ts` — `code_files`: реестр свежести
     (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at), PK(repo_id, path) WITHOUT ROWID.
     Все файлы репозитория, не только L1 (§5: доля языков считается из code_files).
   - `packages/store-sqlite/src/migrations/004-code-defs.ts` — `code_defs`: PK(repo_id, path, name, span_start)
     по наброску §4.3; колонка exported (0 по умолчанию, CHECK) для варианта C.
   - `packages/store-sqlite/src/migrations/005-code-refs.ts` — `code_refs`: кеш fan_in по слову, PK(repo_id, name).
   - Подключены в `migrations/index.ts`; `schema.test.ts` — ожидаемые версии `[1,2,3,4,5]`,
     проверки объектов, тест «один оператор на миграцию (версии 3–5)».
2. **Сторож дисциплины схемы** — новый тест в `schema.test.ts`: «CREATE TABLE вне набора
   миграций не появляется» (скан `packages/*/src` вне миграций и тестов, комментарии срезаются,
   строковые литералы НЕ срезаются — настоящая DDL живёт в template-литералах; исключение —
   таблица учёта `schema_migrations` в migrate.ts). Урок vec_embed_meta стал механическим.
3. **Фоновый job `code_index`** — `packages/code-intel/src/code_index.ts`:
   - класс работ в ОБЩЕЙ очереди `jobs` (kind `code_index`, priority 8, дедуп по (kind, entity_id=path),
     scope=repo_id); свой механизм очереди не писался — enqueue/claim/complete/fail/sweep из `@myc/store-sqlite`;
   - `scanCodeIndex`: обход дерева (skip node_modules/.git/dist/…), уровень 1 — (mtime, size) без чтения,
     уровень 2 — wyhash64 содержимого; тач и L0-файлы пишутся сканом, изменённые L1 — только в очередь
     (строку code_files пишет воркер ПОСЛЕ разбора, в одной транзакции с дефсами — смерть между сканом
     и разбором не оставляет «свежую» строку над старыми дефсами); удалённые файлы чистятся сразу
     (code_files + code_defs + инвалидация code_refs);
   - `drainCodeIndex`: claim батчем 256 → разбор → одна транзакция записи (чекпойнт = транзакция,
     как в `myc reindex`) → complete с ограждением по holder; пустая выдача дожидается чужой аренды
     не дольше двух аренд; `BuiltinCodeIntel` (T4) и `fanIn` (T5) потребляют то же самое;
   - батчи ≥ 64 работ разбираются пулом воркеров (`code_index_worker.ts`, listDefs по ядрам, потолок 8);
     пул — строго оптимизация: сторож 2 с на разбор, не ответил/воркер умер — фолбэк в свой поток,
     работа не теряется;
   - инвалидация `code_refs` именами до/после для изменённых файлов (fan_in T5 пересчитает по требованию).
4. **Замер** — `packages/code-intel/src/bench-code-index.ts`, воспроизводимый скрипт: копия репозитория
   по `git ls-files` во временный каталог (оригинал не пишется), базы с production-STORE_PRAGMAS и полным
   набором миграций, детерминированный выбор 10 изменённых файлов (seed 42), обе мутации приёмки
   выполняются скриптом. Запуск: `bun run packages/code-intel/src/bench-code-index.ts`.

## Приёмка — два числа (планка выполнена)

| Прогон | Результат | Планка |
|---|---|---|
| Полный индекс (1907 файлов / разбор 1518) | **189–192 мс** (холодный 189.2, прогретый 186.0; скан 39, разбор 110, запись 22) | ≤ 400 мс ✓ |
| Повторный при 10 изменённых | **14.6 мс** (скан 11.4, разбор 2.5, запись 0.3) | ≤ 20 мс ✓ |
| Повторный без изменений | 10.7 мс | — |

Замечание к первому прогону до пула: однопоточно полный индекс стоил 519 мс (разбор listDefs 443 мс
из 1518 файлов по 0.28 мс). Разбор распараллелен пулом воркеров — это единственное место, где уходило
время; инкрементальный путь пулом не пользуется вовсе.

## Мутации (обязательная часть)

1. **Инкрементальность убрана** (`incremental: false`): повторный прогон **14.0 мс → 191.9 мс (×18)**,
   разбираются все 1518 файлов вместо 10. Второй прогон просел до уровня полного — инкрементальность
   подтверждена.
2. **Свежесть только по mtime** (`freshness: "mtime"` — сверка только mtime, ни размера, ни хеша):
   правка содержимого с восстановленным mtime — прогон 12.6 мс, разобрано 0 файлов, канарейка
   (`export function zz_mutation_canary`) **НЕ долетела** (дефсов в базе не прибавилось). Контроль тем же
   прогоном в рабочем режиме (mtime+hash): 1 файл изменён, 1 разобран, канарейка в базе — правка поймана.
3. **Таблица мимо миграции**: в `code_index.ts` временно добавлен
   `CREATE TABLE IF NOT EXISTS code_files_out_of_band (…)` — тест набора
   «CREATE TABLE вне набора миграций не появляется» **покраснел**:
   `Expected [] → Received ["packages/code-intel/src/code_index.ts"]`. После отката — зелёный.

## Гейты (фактические числа)

- `bun test packages/code-intel/ packages/store-sqlite/` — **320 pass, 0 fail** (1 skip — предсуществующий vec0).
- `bun test` (весь монорепо) — **1302 теста, 0 fail**, 16 skip (предсуществующие).
- `bun run typecheck` — **13/13 пакетов, код 0**.
- `bun run deps-check` — passed (добавлена зависимость `@myc/code-intel → @myc/store-sqlite`).

## Файлы

Новые:
- `packages/store-sqlite/src/migrations/003-code-files.ts`, `004-code-defs.ts`, `005-code-refs.ts`
- `packages/code-intel/src/code_index.ts`, `code_index_worker.ts`, `code_index.test.ts`
- `packages/code-intel/src/bench-code-index.ts`

Изменённые:
- `packages/store-sqlite/src/migrations/index.ts` (подключение версий 3–5)
- `packages/store-sqlite/src/migrations/schema.test.ts` (версии `[1..5]`, объекты, 2 новых сторожевых теста)
- `packages/code-intel/package.json` (dep `@myc/store-sqlite`, export `./code-index`)

Не тронуты (по границам): `packages/code-intel/src/defs.ts`, `index.ts`, `select.ts`,
`packages/store-sqlite/src/jobs.ts`, `packages/web/`, `packages/server/`, `packages/cli/`.
