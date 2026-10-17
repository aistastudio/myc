import type { SwarmMigration } from "./types.ts";

/**
 * Решения роутера (спека: docs/design/04-swarm-learning-and-routing.md §2.2
 * «swarm_route_decision»). Одна строка = «роутер спросил в такой-то момент,
 * вот профиль, веса, кандидаты и выбор» — нужно для офлайн-оценки (§2.11),
 * даже если рекомендацию не приняли.
 *
 * Отличия от спеки, продиктованные стыком S13:
 *
 * - РЕШЕНИЕ НЕ В НЕДЕЛЕЖАЩЕЕ СОЕДИНЕНИЕ: ни FK на задачу, ни FK на снимок
 *   приоров — решение обязано пережить компактирование оплога и чистку
 *   задач (иначе история роутинга обрывается вместе с узлом, ради которой
 *   она и записана). Связь с задачей — task_id строкой, как у попытки.
 * - candidates/weights/constraints — JSON-снимки, а не таблицы: ряд
 *   кандидатов живёт одну строку решения и ни на что не ссылается дальше.
 * - taken NULLABLE:1/0 появляется, когда оркестратор сообщил исход
 *   запуска; NULL = «неизвестно», и это не пропуск, а состояние.
 *
 * Один оператор — один элемент (roster.test.ts проверяет каждый).
 */
const SQL = `CREATE TABLE swarm_route_decision (
  route_id        TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  at              INTEGER NOT NULL,
  fingerprint     TEXT NOT NULL,
  task_class      TEXT NOT NULL,
  profile         TEXT NOT NULL,
  weights         TEXT NOT NULL,
  constraints     TEXT,
  candidates      TEXT NOT NULL,
  chosen_arm      TEXT NOT NULL,
  alt_arm         TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('exploit','explore','forced','control','cascade')),
  prior_snapshot  TEXT NOT NULL,
  taken           INTEGER
)`;

export const migration019SwarmRouteDecision: SwarmMigration = {
  version: 19,
  name: "swarm_route_decision",
  sql: SQL,
  objects: ["swarm_route_decision"],
};
