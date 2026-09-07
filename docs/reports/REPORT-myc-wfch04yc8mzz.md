# memory-wfch04yc8mzz — ацикличность `blocks` и `parent` (§4.3)

## Что сделано

**1. `blocks` получил проверку цикла в движке.** Новый модуль
`packages/store-sqlite/src/cycle.ts`: `checkEdgeAcyclic(db, src, type, dst)`,
вызывается из `GraphStore.addEdge` внутри той же транзакции, до `journalLocal`
и `projectEdgeAdd`. Проверка включается по `EDGE_SEMANTICS[type].acyclic`
(и пропускает `parent`, у которого своя, через замыкание), так что она стоит
на ВСЕХ дверях к ребру: `myc dep add`, `myc task --dep`, MCP `link`,
`import-beads`, а не только у одной команды.

**2. Путь называется целиком — у обоих типов.** Раньше `parent` сообщал только
пару концов («B уже потомок A»); теперь у обоих отказ печатает кольцо
`dst → … → src → dst`: сперва цепочка, которая уже есть в графе, потом ребро,
которое её замкнуло. `ClosureError` носит путь и полем `path`.

**3. Два предела обхода, и второй — по замеру.** Предел глубины 64
(`EDGE_SEMANTICS.blocks.maxDepth`, §11) цену НЕ ограничивает: узел с 500
исходящими рёбрами, из которого достижимо 20 000 узлов на глубине 40 (предел
даже не задет), обходится за **445 мс** при бюджете записи 5 мс. Поэтому
добавлен второй предел — **512 посещённых узлов**; обоснование числом ниже.

**4. Отказ по пределу отличим от отказа по циклу (И2).** `closure.cycle`
(путь найден, вот он) против `closure.depth` (искать дальше дороже бюджета);
наружу — `precond.cycle` и `precond.depth`. `myc dep add` переводит цикл в
`conflict.dep_cycle` / exit 4, как требует §3.7; отказ по пределу остаётся
precond, потому что говорит «не проверено», а не «цикл».

**5. `dep.ts` перестал дублировать движок.** Его собственный BFS (неограниченный
по глубине, лимит 4096 узлов «на всякий») снят: теперь одна реализация с одним
пределом, и `dep add` не платит за обход дважды.

## Файлы

| Файл | Что |
|---|---|
| `packages/store-sqlite/src/cycle.ts` | новый: BFS-проверка, два предела, путь |
| `packages/store-sqlite/src/cycle.test.ts` | новый: 14 тестов (циклы 2/3/10, пределы, репликация, план запроса) |
| `packages/store-sqlite/src/cycle.latency.test.ts` | новый: замер на 100k узлов |
| `packages/store-sqlite/src/closure.ts` | путь цикла у `parent` (`chainUp`), `path` в `ClosureError` |
| `packages/store-sqlite/src/closure.test.ts` | тест: цикл `parent` длины 5 назван путём |
| `packages/store-sqlite/src/queries.ts` | вызов проверки в `addEdge` + докстрока |
| `packages/store-sqlite/src/queries.test.ts` | фаззер `open_blockers` учитывает отказы (и требует, чтобы они были) |
| `packages/store-sqlite/src/index.ts` | экспорт `checkEdgeAcyclic`, `MAX_BLOCKS_DEPTH`, `MAX_BLOCKS_REACH`, `cycleQueries` |
| `packages/cli/src/commands/dep.ts` | снят дублирующий BFS, перевод отказа в §3.7 |
| `docs/design/01-core-data-model.md` | §4.3: почему не буквально CTE, замеры; §11: константа 512 |

Миграции не трогались — `db/schema.sqlite.sql` и `schema-parity.test.ts` не задеты.

## Мутации (прогон `bun test packages/core packages/store-sqlite`, база 586 pass / 0 fail)

| Мутация | Упало тестов |
|---|---|
| Снять вызов `checkEdgeAcyclic` в `addEdge` | **8** |
| `MAX_BLOCKS_DEPTH` → `Number.MAX_SAFE_INTEGER` | **3** |
| Убрать предел числа посещённых (строка `cameFrom.size >= maxReach`) | **2** (точечно, 2 файла/16 тестов); худший случай замера 0.19 мс → **46.9 мс**, 9× бюджета записи |
| Путь цикла `blocks` → только концы `[src, dst, src]` | **2** |
| Путь цикла `parent` → только концы (`chainUp` вырезан) | **1** |
| Отказ по пределу выдаётся кодом `closure.cycle` | **3** |

## Замеры (стенд 100 000 узлов / 193 000 рёбер `blocks`, `cycle.latency.test.ts`)

* Проверка ацикличности, типичный случай (цепочка, 40 достижимых):
  **p50 0.066 мс, p99 0.157 мс**.
* Проверка, худший случай (широкий узел, 20 000 достижимых, упирается в бюджет
  512): **p50 0.095 мс, p99 0.190 мс**, отказ `closure.depth`.
* Полная вставка ребра `store.addEdge` (оплог + проекция + проверка):
  **p50 0.155 мс, p99 0.730 мс** при бюджете записи И1 **5 мс**.

Откуда взялось число 512 (тот же худший случай):

| Вариант обхода | p99 |
|---|---|
| без бюджета посещённых | 445 мс |
| рекурсивный CTE из §4.3, бюджет 4096 | 9.7 мс |
| BFS, бюджет 4096 | 6.0 мс |
| **BFS, бюджет 512 (принято)** | **0.13 мс** |

Дедупликация по `id` вместо `(id, глубина)` из спеки — отдельные 9×:
0.64 мс → 0.07 мс на цепочке 40 звеньев с ромбами.

## Прогоны

* `bun test packages/core packages/store-sqlite`: **586 pass, 0 fail**, 1 skip (587 тестов, 33 файла).
* `bun test packages/cli` (менялся `dep.ts`): **669 pass, 0 fail**.
* `tsc --noEmit` по `store-sqlite` и `cli` — чисто; `scripts/deps-check.ts` — passed for 13 packages.

## Что осталось / для координатора

1. **`packages/mcp/src/dispatch.ts` (вне моих границ).** `link` ловит любую
   ошибку `addEdge` и отдаёт `ToolError("usage.invalid", …)`. Сообщение с путём
   до пользователя доходит, но код отказа у MCP будет `usage.invalid`, а не
   `precond.cycle`/`precond.depth`. Нужна ветка на `ClosureError`, как в
   `graphFailure` у CLI.
2. **Отдельного `dep.test.ts` не заводил** — файл вне списка разрешённых.
   Контракт §3.7 (exit 4 + путь) покрыт существующим тестом
   `packages/cli/src/commands/tasks.test.ts` «dep > цикл — exit 4 с путём»;
   он зелёный, и путь в нём совпал с новым форматом сообщения.
3. **Флейк, не связанный с задачей.** При полном прогоне `packages/cli` один
   раз упал `store.parity.test.ts` («предохранитель WAL»): 795 192 против
   порога 786 432. В изоляции и при повторном полном прогоне — зелёный.
