import type { Migration } from "../migrate.ts";

/**
 * Схема, версия 2: очередь операций с неудовлетворёнными зависимостями
 * (myc-qie.9).
 *
 * Пакеты чужих операций приходят в произвольном порядке — это свойство CRDT,
 * а не недоработка транспорта: ребро может приехать раньше своих концов, а
 * `set(title)` — раньше `set(kind)`, без которого строку узла не создать
 * (NOT NULL + CHECK). Вставка такого ребра падала по FOREIGN KEY и откатывала
 * весь пакет; операцию без узла applyOps просто возвращал наверх списком
 * `deferred`, и доставить её повторно обязан был вызывающий.
 *
 * Два пути были на выбор. Разрешить ребро-сироту в схеме (снять FOREIGN KEY
 * и материализовать позже) дешевле в коде, но ломает инварианты, на которых
 * стоят триггеры open_blockers, parent_closure и каждый читатель edges: все
 * они считают, что концы ребра существуют. Поэтому выбран второй путь:
 * applyOps сам откладывает операцию, чьи зависимости не выполнены, в эту
 * таблицу и применяет её в той же транзакции, где появляется недостающий
 * узел. Очередь ДОЛГОВРЕМЕННАЯ намеренно: между пакетами процесс может
 * умереть, и отложенное в памяти пропало бы молча (И2).
 *
 * `needs` — id узла, которого не хватает (для ребра — первый из отсутствующих
 * концов; когда он появится и второго всё ещё нет, строка перекладывается
 * на него). Тело операции хранится как JSON Op (§9.3): оплог она не трогает —
 * журналирование под UNIQUE(op_id) случится только при применении, иначе
 * дедупликация закрыла бы повторную попытку навсегда.
 */
const SQL = `
CREATE TABLE oplog_pending (
  op_id     TEXT    PRIMARY KEY,
  needs     TEXT    NOT NULL,                 -- id узла, без которого не применить
  origin    INTEGER NOT NULL DEFAULT 0,       -- как в oplog: 1 локальная, 0 чужая
  op        TEXT    NOT NULL,                 -- JSON Op (op_id, seq, hlc, site_id, ...)
  parked_at INTEGER NOT NULL,
  CHECK (json_valid(op))
) WITHOUT ROWID;
CREATE INDEX ix_oplog_pending_needs ON oplog_pending(needs);
`;

const OBJECTS = ["oplog_pending", "ix_oplog_pending_needs"] as const;

export const migration002OplogPending: Migration = {
  version: 2,
  name: "oplog-pending",
  sql: SQL,
  objects: OBJECTS,
};
