import type { SwarmMigration } from "./types.ts";

/**
 * Откуда у попытки ось scope и по какому диффу она посчитана, версия 9
 * (memory-1ax1pmk6mc3q). Три колонки, каждая — ответ на измеренную дыру:
 *
 * - `swarm_attempt.scope_source` — чем решён scope ключа `task_class`:
 *   `touched` (факт: файлы, изменившиеся за попытку), `anchors` (якоря
 *   задачи), `text` (пути, названные в тексте задачи — словарь полный, хотя
 *   в ключ по S67 текст сейчас не идёт), `none` (путей нет — scope
 *   `unknown`). NULL — не записано: попытки до этой миграции, объявленный
 *   руками класс (`--class`) и ретроспективная попытка `myc close
 *   --verdict`. Без колонки факт и догадка в `myc report models`
 *   неразличимы, а смешать их — ровно та тихая подмена, против которой
 *   пишется `*_source` у запуска (006).
 * - `swarm_attempt.predicted_class` — что видел бы роутер на старте:
 *   предсказание классификатора (якоря, иначе пути из текста задачи).
 *   §2.1.3 требовал не переписывать ключ попытки фактом, чтобы офлайн-оценка
 *   видела то, что видел роутер; решение S67 ключом делает факт (роутить по
 *   тому, чем задача ОКАЗАЛАСЬ), а взгляд роутера сохраняется здесь и не
 *   переписывается — матрица «предсказано × фактически» остаётся посчитанной.
 * - `swarm_attempt_run.git_base` — JSON-снимок рабочих деревьев на старте
 *   (../touched.ts): корень, ключ репозитория, HEAD и хеши уже грязных
 *   файлов. Одного `git_head` мало: по нему в дифф попадала вся несданная
 *   работа соседей (три задачи — один и тот же список из 46 файлов).
 *
 * CHECK на `scope_source` — барьер того же рода, что `class_source` (003): у
 * колонки четыре значения, и пятое не пишется даже прямым INSERT. Расширить
 * список значит перестроить таблицу, как в 008; сторож — taskclass.test.ts
 * (SCOPE_SOURCES против CHECK схемы).
 *
 * ADD COLUMN, а не перестройка: новые колонки допускают NULL, и старые
 * строки остаются как были — ни вердикт, ни стоимость ни одной закрытой
 * попытки этот накат не трогает. Следующая перестройка таблиц (по образцу
 * 008, `SELECT *`) обязана перечислить и эти колонки.
 *
 * Один оператор на элемент массива (сторож roster.test.ts).
 */
const SQL: readonly string[] = [
  `ALTER TABLE swarm_attempt ADD COLUMN predicted_class TEXT`,
  `ALTER TABLE swarm_attempt ADD COLUMN scope_source TEXT
  CHECK (scope_source IN ('touched','anchors','text','none'))`,
  `ALTER TABLE swarm_attempt_run ADD COLUMN git_base TEXT`,
];

export const migration009SwarmAttemptScope: SwarmMigration = {
  version: 9,
  name: "swarm_attempt_scope",
  sql: SQL,
  objects: ["swarm_attempt", "swarm_attempt_run"],
};
