import type { SwarmMigration } from "./types.ts";

/**
 * Сигналы исхода (спека: docs/design/04-swarm-learning-and-routing.md §2.2
 * «swarm_signal»). Одна строка = «событие подтвердило или опровергло
 * попытку»: append-only, приходит в любое время, включая недели спустя.
 *
 * Отличия от спеки, продиктованные стыком S13:
 *
 * - СВЯЗЬ только через attempt_id (FK на swarm_attempt): задача у сигнала
 *   через попытку — ровно та денормализация, которую спека держит у
 *   attempt (task_id), и дублировать её здесь значило бы два источника
 *   истины об одном и том же.
 * - CARPALITY — десятки тысяч строк в сутки, срок жизни30 дней (§2.2.1):
 *   поэтому НЕТ ни ребра, ни FTS — ни одна читающая команда не ищет
 *   сигнал текстом, а индексы (017, 018) покрывают оба пути чтения:
 *   по попытке и по времени.
 * - НА СЕРВЕР сигнал не уходит: в обмене участвуют только достаточные
 *   статистики (swarm_outcome/arm), не сырые события — см. §2.2.1.
 *
 * Один оператор — один элемент (roster.test.ts проверяет каждый).
 */
const SQL = `CREATE TABLE swarm_signal (
  signal_id       TEXT PRIMARY KEY,
  attempt_id      TEXT NOT NULL REFERENCES swarm_attempt(attempt_id),
  kind            TEXT NOT NULL CHECK (kind IN (
                    'tests','lint','typecheck','review_ai','review_human',
                    'merged','reverted','reopened','redone','followup_bug',
                    'survived','human_rating','spec_defect')),
  value           REAL,
  weight          REAL NOT NULL,
  source          TEXT NOT NULL,
  observed_at     INTEGER NOT NULL,
  latency_ms      INTEGER NOT NULL,
  payload         TEXT
)`;

export const migration016SwarmSignal: SwarmMigration = {
  version: 16,
  name: "swarm_signal",
  sql: SQL,
  objects: ["swarm_signal"],
};
