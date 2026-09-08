import type { Migration } from "../migrate.ts";

/**
 * Схема, версия 10: `ready` наследует блокеры вниз по `parent` — и делает это
 * СЧЁТЧИКОМ, а не обходом (задача memory-atcm254ry6c7).
 *
 * ЧТО БЫЛО И ПОЧЕМУ ЭТО ДЕФЕКТ. `ready` считал готовой любую открытую задачу
 * с `open_blockers = 0` — то есть смотрел только на СВОИ рёбра `blocks`.
 * Замер на настоящих данных ~/src/cherry (796 задач, 972 зависимости):
 * `myc ready` — 195 задач, `bd ready` на том же графе — 144, расхождение
 * одностороннее (bd ⊆ myc, обратная разность пуста). Все 51 «лишних» —
 * потомки эпиков, у которых блокер висит на предке.
 *
 * Решает дело не совместимость с beads, а то, ЧТО ИМЕННО делал блокер на
 * эпике. В том же снимке: 558 рёбер `blocks`, из них 12 нацелены в узел,
 * у которого есть дети, и все 12 блокеров ещё открыты. Все 11 виновных
 * предков — контейнеры (`issue_type=epic`, вехи M2–M5), СОБСТВЕННОЙ работы
 * ни у одного нет. Значит при старом правиле такое ребро не убирало из
 * очереди ничего: единственный узел, которого оно касалось, — сам эпик,
 * а эпик работой не является. Блокер, не блокирующий ничего, — это неверное
 * определение очереди, а не вопрос вкуса. Разбирает же очередь агент: он не
 * посмотрит вокруг и не заметит, что берёт часть D, пока не сделана часть A
 * (cherry-zgak.2 «Делегированный API» блокируется cherry-zgak.1 — это
 * порядок внутри одной вехи, а не внешняя зависимость).
 *
 * ПОЧЕМУ СЧЁТЧИК, А НЕ ПОДЪЁМ ПО ПРЕДКАМ НА ВЫДАЧУ — ИЗМЕРЕНО, а не по
 * общим соображениям (ready.inherit-latency.test.ts, стенд 100 000 узлов /
 * 4 000 открытых задач / 400 эпиков по 9 детей / 40 заблокировано):
 *
 *   прежнее правило, наследования нет  — p50 10.68 мс (3 960 задач)
 *   наследование СЧЁТЧИКОМ             — p50  9.49 мс (3 600 задач)
 *   наследование ОБХОДОМ               — p50 14.13 мс (3 600 задач)
 *
 * Соперник взят честный: прежняя схема со своим `ix_nodes_ready`, поверх
 * которого `NOT EXISTS (… parent_closure …)`, а не «обход без индекса» (тот
 * даёт 26 мс, но так альтернативу никто бы и не написал). Счётчик на чтении
 * не стоит ничего — он даже дешевле прежнего правила (×0.89), потому что
 * скрытые задачи не доходят до скоринга. Обход стоит +32 % к прежней очереди
 * и +4.6 мс абсолютных, то есть почти весь бюджет И1: `NOT EXISTS` считается
 * для КАЖДОГО кандидата до LIMIT, ведь очередь считает score всем и режет
 * top-k уже после сортировки. Цена обхода растёт вместе с очередью, цена
 * счётчика — нет; поэтому колонка.
 *
 * ЧТО СЧЁТЧИК СТОИТ НА ЗАПИСИ. Блокировка эпика раскладывает ±1 по всему
 * поддереву одним UPDATE по `ix_pc_desc`: лист 0.098 мс, 10 потомков 0.119,
 * 100 — 0.277, 1 000 — 1.96 (бюджет записи 5 мс), 5 000 — 9.37 мс, то есть
 * мимо бюджета. Цена линейна по размеру поддерева (это утверждает тест), и
 * порог тот же, на котором design doc §риск 14 уже отправляет работу с
 * `parent_closure` в `jobs`; отдельная задача на вынос — memory-sj70gctz88y1.
 *
 * ЧТО СЧИТАЕТ КОЛОНКА. `anc_blockers` — число предков узла по `parent`
 * (строки `parent_closure`), у которых `open_blockers > 0`. Готовность
 * становится `open_blockers = 0 AND anc_blockers = 0`, и оба терма лежат в
 * предикате частичного индекса: скан остаётся один, а окно индекса — уже.
 *
 * ЧЕМ ВЕДЁТСЯ. Ровно теми же средствами, что и `open_blockers`, — триггерами
 * в этой же базе, на двух источниках изменений:
 *   - `nodes.open_blockers` пересёк ноль (trg_anc_block / trg_anc_unblock) —
 *     поддерево предка целиком получает ±1 одним UPDATE по `ix_pc_desc`;
 *   - появилась или исчезла строка `parent_closure` (trg_anc_pc_ins /
 *     trg_anc_pc_del) — то есть узел вошёл в поддерево или вышел из него.
 * Второй источник обязателен: `closure.ts` — единственный, кто пишет эту
 * таблицу, и все его пути (вставка ребра, перенос, снятие, полный пересчёт)
 * идут через INSERT/DELETE, поэтому триггер на таблице покрывает их все.
 *
 * Вложенность триггеров тут законна и проверена (`PRAGMA recursive_triggers`
 * = 0 в bun:sqlite): SQLite запрещает повторный вход в ТОТ ЖЕ триггер, а не
 * срабатывание другого; `trg_blk_ins` пишет `open_blockers`, и `trg_anc_*`
 * от этой записи срабатывает. Цикла нет по построению: `trg_anc_*` пишет
 * только `anc_blockers`, которого нет ни в одном UPDATE OF.
 *
 * ЖЁСТКОЕ УДАЛЕНИЕ узлов/рёбер триггерами не покрыто — так же, как и у
 * `open_blockers` (см. §8.1.11): после purge счётчик пересчитывают
 * (`GraphStore.recountAncBlockers`, `myc doctor --recount`).
 *
 * ГРАНИЦА ВОРКСПЕЙСА не нарушена: `parent_closure` живёт внутри одной базы,
 * поэтому предок из ЧУЖОГО воркспейса не наследуется никак — ровно как и
 * `blocks`. Чтобы это не стало молчаливой ложью на переезде, `planMove`
 * отказывает, когда узел уезжает из-под заблокированного предка
 * (код `cross_boundary_parent`, packages/store-sqlite/src/move.ts).
 *
 * НАКАТ НА СУЩЕСТВУЮЩУЮ БАЗУ. Колонка добавляется с DEFAULT 0 и тут же
 * заполняется из `parent_closure`: без этого шага старые базы получили бы
 * нули и наследование включилось бы только для будущих изменений. Оба
 * ready-индекса пересоздаются с новым термом — предикат частичного индекса
 * обязан совпадать с предикатом запроса ДОСЛОВНО, иначе планировщик молча
 * уходит в SCAN (та же ловушка, что в комментарии к ix_nodes_ready).
 * Порядок «заполнить, потом индексы» — чтобы не перестраивать индекс дважды.
 */
const SQL = `
ALTER TABLE nodes ADD COLUMN anc_blockers INTEGER NOT NULL DEFAULT 0;

UPDATE nodes SET anc_blockers = (
  SELECT count(*) FROM parent_closure pc JOIN nodes a ON a.id = pc.ancestor
   WHERE pc.descendant = nodes.id AND a.open_blockers > 0);

DROP INDEX ix_nodes_ready;
CREATE INDEX ix_nodes_ready
    ON nodes(scope, priority, updated_at)
 WHERE kind='task' AND status='open' AND open_blockers=0 AND anc_blockers=0
   AND deleted_at IS NULL;

DROP INDEX ix_nodes_ready_repo;
CREATE INDEX ix_nodes_ready_repo ON nodes(
  scope,
  json_extract(attrs,'$.repo'),
  priority,
  updated_at
) WHERE kind='task' AND status='open' AND open_blockers=0 AND anc_blockers=0
    AND deleted_at IS NULL;

CREATE TRIGGER trg_anc_block AFTER UPDATE OF open_blockers ON nodes
WHEN old.open_blockers = 0 AND new.open_blockers > 0
BEGIN
  UPDATE nodes SET anc_blockers = anc_blockers + 1
   WHERE id IN (SELECT descendant FROM parent_closure WHERE ancestor = new.id);
END;

CREATE TRIGGER trg_anc_unblock AFTER UPDATE OF open_blockers ON nodes
WHEN old.open_blockers > 0 AND new.open_blockers = 0
BEGIN
  UPDATE nodes SET anc_blockers = max(0, anc_blockers - 1)
   WHERE id IN (SELECT descendant FROM parent_closure WHERE ancestor = new.id);
END;

CREATE TRIGGER trg_anc_pc_ins AFTER INSERT ON parent_closure
WHEN (SELECT open_blockers FROM nodes WHERE id = new.ancestor) > 0
BEGIN
  UPDATE nodes SET anc_blockers = anc_blockers + 1 WHERE id = new.descendant;
END;

CREATE TRIGGER trg_anc_pc_del AFTER DELETE ON parent_closure
WHEN (SELECT open_blockers FROM nodes WHERE id = old.ancestor) > 0
BEGIN
  UPDATE nodes SET anc_blockers = max(0, anc_blockers - 1) WHERE id = old.descendant;
END;
`;

export const migration010AncBlockers: Migration = {
  version: 10,
  name: "anc-blockers",
  sql: SQL,
  objects: [
    "ix_nodes_ready",
    "ix_nodes_ready_repo",
    "trg_anc_block",
    "trg_anc_unblock",
    "trg_anc_pc_ins",
    "trg_anc_pc_del",
  ],
};
