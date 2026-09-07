# Задача N — supersession, contradicts и режимы истории (memory-hbc42qtv0jvc)

Спека: `docs/design/01-core-data-model.md` §6.3. Запись цепочки (`myc absorb`, класс
`update`) уже была сделана в закрытой `memory-f36rscy00ftr`; здесь появилась **модель
чтения**: два режима истории, симметричный `contradicts` и доказательство, что цепочка
переживает слияние веток оплога.

---

## Гейты — фактические числа

| Гейт | Результат |
|---|---|
| `bun test` (полный прогон) | **1379 pass, 16 skip, 0 fail**, 23 511 expect, 1395 тестов в 95 файлах, 80,55 с |
| `bun run typecheck` | **13 пакетов из 13 — код 0** |
| Затронутые тестовые файлы (core/history, core/absorb, core/graph, cli/show, cli/absorb) | 126 pass, 0 fail, 555 expect |
| vec0 в этой среде | загружен → векторные ветки `cli/absorb.test.ts` реально исполняются |

`bun run deps-check` падает на `@myc/swarm` («may only depend on @myc/core, found extra:
store-sqlite»). Причина — строка `@myc/store-sqlite` в **комментарии**
`packages/swarm/src/schema.ts:12`, которую ловит регулярка сканера. Файл не мой, к моим
правкам отношения не имеет; `core` проверку проходит.

---

## Что сделано

### 1. `packages/core/src/graph.ts` — модель истории (§6.3)

* `HistoryMode = "follow" | "full_history"`, `HISTORY_MODES`, `isHistoryMode`.
* `HISTORY_MODE_ATTR` / `HISTORY_MODE_FULL` + `historyModeOf(attrs)` — режим, объявленный
  самим узлом (`attrs.history_mode='full'`).
* `historyClause(mode, alias)` — **единственное место**, где живёт предикат режима
  `follow`: `AND n.head_id IS NULL`. До этого он жил шестнадцатью копиями по retrieval,
  cli и scripts (перечень ниже), и «полная история по запросу» была нереализуема, не
  правя их все.
* `VersionGraph` — цепочка версий как данные (строки узлов + рёбра `supersedes`), без SQL:
  `chain()`, `head()`, `heads()`, `forked()`, `view(id, mode)`.
* `supersessionPlan(graph, oldId, newId)` — что писать при классе `update`: ребро
  `supersedes` и `head_id` **всей** цепочки на новую голову.

### 2. `packages/core/src/absorb.ts` — класс → ребро таблицей

`ABSORB_EDGE`, `absorbEdgeFor`, `absorbEdges(nodeId, verdict)`. `contradiction →
contradicts` перестал быть веткой `if` внутри применяющего кода и стал проверяемой
записью в таблице: у memora противоречие только помечается и повисает без связи, и
вторую сторону потом нечем найти.

### 3. `packages/cli/src/commands/show.ts` — поверхность обоих режимов

* по умолчанию (**follow**) выводится запрошенный узел и **называется актуальная
  версия**: поле `head` и строка `актуальна <id> <title>`;
* `--chain` (**full_history**) печатает всю цепочку от старой версии к новой, с датами,
  статусами и `reason`/`class` из `attrs.absorb`; актуальная помечена `→`;
* `attrs.history_mode='full'` включает полную историю без флага; флаг запроса сильнее;
* конверт несёт `history: follow | full_history`;
* **`contradicts` читается симметрично** — и `edgesFrom`, и `edgesTo`. До правки ребро
  `contradicts` не попадало в вывод `show` **вообще ни с одной стороны**: список `links`
  собирал только `relates/derived_from/duplicates/supersedes`. Противоречие, которое
  absorb исправно записывал, было ненаходимым на поверхности;
* `forked` — развилка после слияния веток названа, а не замолчана;
* `stale` + строка `ВНИМАНИЕ  head_id не проставлен у …` — звенья цепочки, которые
  ретривал (`head_id IS NULL`) вернёт как актуальные, хотя головой они не являются.

### 4. Тесты

* `packages/core/src/history.test.ts` (новый, 18 тестов) — режимы, цепочка из пяти,
  `supersessionPlan`, слияние двух веток через настоящий `merge()` оплога.
* `packages/core/src/absorb.test.ts` (+6 тестов) — таблица класс→ребро.
* `packages/cli/src/commands/show.test.ts` (новый, 12 тестов) — приёмка на настоящем
  SQLite и **многопроцессное** слияние.
* `packages/cli/src/commands/show.merge.worker.ts` (новый) — воркер для `Bun.spawn`.

---

## Приёмка

**Цепочка из 5 версий отдаёт актуальную по умолчанию и полную по запросу.**
`show.test.ts` строит цепочку ровно в той форме, какую оставляет `myc absorb` (ребро
`supersedes` + `head_id` всей цепочки). Из **любого** из пяти звеньев:
`myc show <id>` → `current:false`, `head.id = v5`, `chain` отсутствует;
`myc show <id> --chain` → все пять в порядке v1…v5, ровно одна помечена `current`.

**Цепочка переживает СЛИЯНИЕ — настоящими процессами.** Однопоточный тест этот инвариант
не видит (S38, S40), поэтому: общий предок (цепочка из трёх) уезжает на второй сайт через
`exportGraph`/`importGraph`; затем **два отдельных процесса `Bun.spawn`** пишут каждый
свою версию поверх общего предка в свою базу, ничего не зная друг о друге; затем оплоги
обмениваются крест-накрест — у сайтов **разный порядок применения**. Проверяется:

1. ни одна из пяти версий не потеряна ни на одной машине;
2. порядок цепочки на обеих машинах **побайтово одинаков**;
3. актуальная версия одна и та же — реплики не разошлись;
4. развилка названа и одинакова на обеих машинах;
5. `follow` из любого звена на обеих машинах даёт ту же голову;
6. повторный импорт идемпотентен.

---

## Находка: `created_at` не реплицируется — первый прогон теста был КРАСНЫМ

Многопроцессный тест сразу поймал расхождение: состав цепочки совпадал, а **порядок
версий на двух машинах был разным**.

Причина: `GraphStore.materializeNode` (`packages/store-sqlite/src/queries.ts:2020`) ставит
приехавшему по репликации узлу `created_at = this.now()` — **локальное** время
материализации. `created_at` не входит в `NODE_FIELDS` и не едет отдельной операцией.
Прямой замер:

```
created_at: A = 1788603687007  B = 1788603687052  разница = 45 мс
hlc:        A = 117217931231756290  B = 117217931231756290  равны: true
site_id:    A = site-a  B = site-a
```

То есть у одной и той же версии `created_at` на двух машинах разный, а `(hlc, site_id)` —
одинаковые побайтово (их пишет каждый `node_set_<field>`).

Исправлено в модели: `VersionNode` **не содержит `created_at`**, порядок задают только
реплицируемые ключи — структура рёбер `supersedes`, затем `(hlc, site_id)`, затем `id`
(тот же порядок разрешения конфликтов, что у всего оплога). Голова при развилке
выбирается по «голосам» `head_id` — то есть по победителю per-field LWW, который CRDT уже
выбрал одинаково на всех репликах.

Это ограничение стоит держать в голове всем: **сортировка чего угодно межсайтового по
`created_at` даёт молчаливое расхождение реплик.** Записано в память проекта —
`memory-hg9t3nd1hq77`.

---

## Мутационное тестирование

Каждая мутация вносилась в **мою** реализацию, прогонялась и откатывалась
(`git`-чистота проверена: `grep МУТАЦИЯ` не находит следов).

### M1 — обновление затирает узел вместо цепочки → `full_history` обеднел

Мутация: в `show.ts:versionsOf` выборка версий сузилась до `WHERE id = ?1` (без
`OR head_id = ?1`) и снят обход рёбер `supersedes` — прежних версий как будто нет.

```
 6 pass, 4 fail
(fail) --chain отдаёт ПОЛНУЮ цепочку из пяти   Expected -4 / Received +1
(fail) --chain печатает даты, статусы и причину  Expected to contain: "история   5 верс."
                                                 Received: ... "история   2 верс."
(fail) attrs.history_mode='full' включает полную историю   Expected -4 / Received +1
(fail) две машины ... обе сходятся к одной цепочке          Expected -3 / Received +0
```

`follow` при этом остался цел — ровно как и сказано в описании мутации: беднеет именно
полная история.

> Первая редакция M1 (`chain()` возвращает `[head]`) дала бесконечную рекурсию
> `chain → head → heads → chain` и уронила всё подряд. Это не мутация, а падение, поэтому
> она была заменена на хирургическую выше.

### M2 — `head_id` не переносится на новую версию → `follow` отдаёт старую

**M2a**, план записи: `supersessionPlan` возвращает пустой `rehead`.

```
 16 pass, 2 fail
(fail) новая версия становится головой, head_id переезжает ВСЕЙ цепочке
       Expected ["myc-v1","myc-v2","myc-v3","myc-v4"] / Received []
(fail) первое обновление одиночного узла: цепочка из двух
       Expected ["myc-a"] / Received []
```

**M2b**, сам режим: `historyClause("follow")` перестал возвращать предикат.

```
 28 pass, 2 fail
(fail) предикат head_id IS NULL живёт в одном месте
       Expected " AND n.head_id IS NULL" / Received ""
(fail) follow — это предикат head_id IS NULL: ему соответствует РОВНО одна версия
       Expected -0 / Received +4   (вернулись все пять версий, включая устаревшие)
```

Обе половины красные: и план, который обязан перенести голову, и режим чтения, который на
эту голову опирается.

### M3 — класс `contradiction` не пишет ребро → противоречие ненаходимо

**M3a**, ядро: `ABSORB_EDGE.contradiction = null`.

```
 27 pass, 4 fail
(fail) contradiction — это РЕБРО contradicts, а не пометка на узле
       Expected "contradicts" / Received null
(fail) каждый класс с целью даёт ровно одно главное ребро   Expected length 1 / Received 0
(fail) остальные кандидаты пояса становятся relates
(fail) вес ребра — косинус, без векторов жаккар
```

**M3b**, поверхность: снят обратный проход `edgesTo(node, "contradicts")`.

```
 11 pass, 1 fail
(fail) противоречие видно и с той стороны, где ребра нет   Expected -3 / Received +1
```

---

## Границы: что НЕ трогал и что нужно свести координатору

Разрешённые файлы: `packages/core/src/` + тесты, `packages/cli/src/commands/show.ts`.
Ничего за границей не правил. Открытые хвосты:

1. Предикат режима `follow` повторяется в SQL **шестнадцатью независимыми копиями** вне
   ядра: `retrieval/hybrid.ts` ×4, `retrieval/fts.ts`, `retrieval/vector.ts`,
   `cli/commands/absorb.ts` ×2, `cli/commands/reindex.ts` ×2, `cli/commands/prime.ts`,
   `cli/commands/bootstrap.ts`, `scripts/bench-latency.ts` ×2,
   `scripts/reindex-vectors.ts` (плюс частичный индекс в миграции 001 — там ему и место).
   Пока их не перевести на
   `historyClause(mode)` из ядра, `myc search --history` и MCP-параметр
   `include_superseded: true` из §6.3 реализовать нечем: full_history есть у `show` и
   отсутствует у поиска. Отдельная задача, файлы вне моей границы.

2. **`packages/cli/src/commands/absorb.ts`** (вне границы) держит собственные копии
   логики, которая теперь есть в ядре: `headOf`, запрос `chain_of`, ветки `if` по классу в
   `applyVerdict`. Их стоит заменить на `supersessionPlan` и `absorbEdges` — сейчас есть
   два независимых источника истины про одно и то же правило, и разойтись они могут молча.
   Функциональной ошибки нет: правила совпадают, тесты обеих сторон зелёные.

3. **`packages/store-sqlite/src/queries.ts:2020`** (вне границы) — `materializeNode` ставит
   реплицированному узлу локальный `created_at`. Модель чтения от этого больше не зависит,
   но само поле остаётся ловушкой для любого будущего кода, который решит по нему
   сортировать. Либо реплицировать `created_at` отдельной операцией, либо явно
   задокументировать его как локальное. Отдельная задача.

4. **`packages/swarm/src/schema.ts:12`** (вне границы, чужой агент) — упоминание
   `@myc/store-sqlite` в комментарии роняет `bun run deps-check`. Правится вставкой
   пробела/дефиса в текст комментария.

5. `myc doctor --conflicts` из §6.2 (сбор противоречий списком) не делался — задачи на это
   не было; данные для него теперь читаемы симметрично.

## Файлы

| Файл | Что |
|---|---|
| `packages/core/src/graph.ts` | + модель истории: `HistoryMode`, `historyClause`, `VersionGraph`, `supersessionPlan` |
| `packages/core/src/absorb.ts` | + `ABSORB_EDGE`, `absorbEdgeFor`, `absorbEdges` |
| `packages/core/src/history.test.ts` | новый, 18 тестов |
| `packages/core/src/absorb.test.ts` | + 6 тестов (класс → ребро) |
| `packages/cli/src/commands/show.ts` | `--chain`, `head`/`current`/`forked`/`stale`, симметричный `contradicts` |
| `packages/cli/src/commands/show.test.ts` | новый, 12 тестов, включая многопроцессное слияние |
| `packages/cli/src/commands/show.merge.worker.ts` | новый, воркер для `Bun.spawn` |
