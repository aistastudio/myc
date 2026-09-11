# memory-7j8zgjnd0bjz — кандидаты `pending_review` не попадают в выдачу

§6.2 (docs/design/03-interfaces-and-integration.md): хук сжатия пишет строки
«решили/выбрали/потому что» заметками L2 с `attrs.state = 'pending_review'`, и
в выдачу они не попадают, пока их не подтвердит дистилляция или человек. До этой
задачи фильтра не было: кандидата гасила только `salience = 0`, и он доезжал до
recall, search, prime, MCP и счётчика строки статуса.

## Пути выдачи и решение по каждому

| Путь | Где | Решение |
|---|---|---|
| `myc recall`, `myc search` | retrieve.ts → federatedSearch → hybridSearch | исключать, SQL |
| федерация по воркспейсам (R3) | federation.ts зовёт hybridSearch на каждый источник | исключать (тот же SQL) |
| MCP `myc_recall` | CLI `recall` | исключать (через CLI) |
| веб, экран «поиск» | `myc recall --json` | исключать (через CLI) |
| лексический пул гибрида | `hybridLexicalPass`, CTE `matches` | терм до `LIMIT ?9` (пул 100) |
| обход графа на 1–2 хопа | `hybridLexicalPass`, финальный WHERE | терм там же, где ACL: хопы входят через рёбра, а не через `matches` |
| векторная ветка | `vectorKnn` (после KNN, до LIMIT) и `hybridHydrate` | терм в обоих |
| объяснение пустой выдачи | `hybridCorpusSize` | терм: база из одних кандидатов — `store_empty`, а не `no_match` |
| `ftsSearch` (публичный API) | fts.ts | терм |
| `myc prime` CORE/DECISIONS (он же хук SessionStart) | `prime_digest_scan`, `prime_digest_scan_repo` | исключать до LIMIT 60 + число в подвале `N pending review hidden` |
| кеш дайджеста prime | `digest_cache`, вариант | `v3` → `v4`: дайджест, посчитанный до фильтра, после обновления не отдаётся |
| MCP `myc_prime` | это `myc bootstrap`: ручные блоки L3 с `topic=bootstrap` + авто | не путь (кандидат — L2 без topic); закреплено тестом |
| строка статуса, счёт notes | `sl_memory` | исключать: кандидат — не узел знания |
| `myc show <id>`, MCP `myc_show` | явный запрос по id | ПОКАЗЫВАТЬ с пометкой: строка `review    unconfirmed compaction candidate (state pending_review) — recall, search and prime do not return it`, в JSON `review: "pending_review"`; соседи в `--depth 1` — `unconfirmed` |
| веб, «база знаний» | kb.ts + client/app.ts | ПОКАЗЫВАТЬ с пометкой `[кандидат · не подтверждён]` (подсказка: как отклонить); подвал «кандидаты на подтверждение: N» (отклонённые не считаются) |
| `myc remember` того же текста | remember.ts, ветка точного дубликата | ПОДТВЕРЖДЕНИЕ (см. ниже) |
| `myc absorb` | absorb.ts, запросы `knn` и `fts` | кандидат не бывает целью дедупликации |
| спасательный пакет хука (`РЕШЕНО`) | absorb-session | по дизайну §6.2: собственные решения сессии в её же контекст, не ретривал — без изменений |
| `myc list --kind memory` | list.ts (вне границ) | показывает кандидатов без пометки — см. «Открыто» |
| веб: карточка узла, граф, здоровье, лента; здоровье server | web card.ts, graph.ts, health.ts, timeline.ts; server/src/index.ts | инвентарь и визуализация (счёт всех узлов), не выдача знания агенту — без изменений |
| `myc code` (знание по файлу) | через рёбра `touches`/якоря | у кандидата якорей нет — не путь |

## Две регрессии, которые фильтр открывал, — закрыты

Нашёл тест сквозь настоящий хук; границы расширены координатором на
remember.ts и absorb.ts.

1. **`myc remember "<строка кандидата>"`.** Хук пишет кандидата с заголовком =
   строка и без тела; однострочный remember даёт тот же `content_hash`,
   попадает в ветку точного дубликата и возвращает id КАНДИДАТА (seen_count++,
   `--reach project` даже поднимал его охват). С фильтром явно записанный факт
   пропадал бы из recall и prime. Теперь явная запись = подтверждение
   человеком: `attrs.state = confirmed`, `confirmed_by` (актор, `--as`),
   `confirmed_at` (мс); ответ CLI — `… duplicate · exact repeat of an
   unconfirmed compaction candidate — confirmed now, recall and prime return
   it`, в JSON/meta `review_confirmed: true`. MCP `myc_remember` отвечал на
   любой повтор `verdict: "new"`, `written: true` — теперь по контракту §4:
   `verdict: "duplicate"`, `written: false`, `review_confirmed: true`.
2. **absorb, класс duplicate.** Канонический — старший, то есть кандидат; новая
   явная заметка уходила в него `superseded` (head_id на кандидата) и пропадала
   целиком. Теперь `knn` и `fts` absorb кандидатов не возвращают: явная заметка
   остаётся самостоятельной, кандидат ждёт разбора.

## SQL и план

Предикат — один на систему, `packages/retrieval/src/review.ts`:

```sql
(json_extract(n.attrs, '$.state') IS NOT 'pending_review')
```

`IS NOT`, а не `<>`: у узла без ключа `json_extract` = NULL. Подтверждение —
любая смена `state` (или удаление ключа), второй признак не нужен.

Колонки и индекса под признак НЕТ, и это решение по замеру. На всех путях
выдачи строка узла к моменту проверки уже прочитана: у recall — ради ACL,
scope и layer (JOIN по rowid из FTS/vec0), у prime — ради title/excerpt, а
термы охвата покрыты `ix_nodes_prime_reach` и SQLite считает их до похода в
строку. Планы с термом и без него ИДЕНТИЧНЫ (prime: `SEARCH nodes USING INDEX
ix_nodes_prime_reach (scope=? AND layer>?)`; гибрид: те же 86 строк плана).

Цена, 100k узлов, тот же текст запроса со снятым термом как соперник, чередуясь:

| Что | Итог |
|---|---|
| лексический проход гибрида, частый терм (~8k совпадений) | ×1.04 |
| он же, откат на ИЛИ трёх терминов | ×1.04 |
| `instr(attrs,'"pending_review"')`-сокращение против голого json_extract | ×1.00 — не взято |
| скан дайджеста prime, 97 % чужих сессий | не дороже: 0.51 против 0.52 мс p50 |
| скан + счётчики, всё видно | ×1.09 (0.61 против 0.56 мс) |

Счётчик кандидатов в подвале prime (`prime_pending_count`) — отдельным
запросом: терм по attrs требует строку, а `prime_reach_counts` живёт одним
индексом. Строку он читает только у прошедших охват: 0.43 мс против 0.59 у
`prime_reach_counts` при 97 % чужих, ≈ 1.2 мс в худшем случае «видно всё» —
весь дайджест тогда 1.67 мс p50 / 1.77 p99 при подбюджете 3 мс (×2.77 к
дайджесту до фильтра), платится раз на версию базы (кешируется). Частичный
индекс `CREATE INDEX … ON nodes(scope, layer) WHERE
json_extract(attrs,'$.state') = 'pending_review' AND head_id IS NULL AND
deleted_at IS NULL` снимает и это: 0.05 мс на обоих стендах (замер на
временной копии). НЕ заведён: ради одного числа в подвале — миграция, строка
в db/schema.sqlite.sql (паритет-тест) и вычисление предиката на каждой записи
в nodes. Если prime на 100k станет горячим промахом кеша — это готовая заявка.

Окно векторного KNN (vec0, k = 200) фильтруется ПОСЛЕ KNN — как ACL; кандидат
с вектором может занять слот окна, но до выдачи не доедет. Корень — не
эмбеддить кандидатов (писатель, вне границ).

## Бюджеты И1

`bun test` бюджетных файлов prime/retrieve — 37 pass / 0 fail:

| Замер | p50 | p99 | бюджет |
|---|---|---|---|
| S58 prime digest @100k (скан с фильтром + счётчики охвата) | 1.06 мс | 1.11 мс | 3 мс; ×4.48 к сопернику |
| S59 prime digest @100k, 20 репозиториев | 3.85 мс | 3.96 мс | 8 мс |
| pending: дайджест целиком, всё видно | 1.67 мс | 1.77 мс | 3 мс |
| recall @100k, фильтр чужого репозитория | 4.8 мс | 9.2 мс | 25 мс |
| федерация @100k, 16 воркспейсов, потолок 8 | 8.3 мс | 10.7 мс | 18 мс |

prime p99 30 мс и recall 25 мс держатся с запасом.

## Тесты

| Файл | Итог |
|---|---|
| packages/retrieval/src/review.test.ts (новый) | 16 pass |
| packages/cli/src/commands/pending-review.test.ts (новый, настоящий хук) | 15 pass |
| packages/cli/src/commands/prime.pending-latency.test.ts (новый) | 6 pass |
| packages/mcp/src/pending-review.test.ts (новый) | 4 pass |
| packages/cli/src/commands/absorb.test.ts (+2) | 18 pass |
| packages/web/src/kb.test.ts (+1) | 17 pass |
| packages/cli/src/hooks/reach.session.test.ts + compact-session-key.test.ts (адаптированы, настоящие процессы) | 10 pass |
| packages/cli/src/commands/digest-cache.multiprocess.test.ts (ключ v4) | 7 pass |

Три существующих теста S58 проверяли охват сессии через кандидатов хука
(«prime своей сессии их видит»), то есть закрепляли ровно то, что §6.2
запрещает, — и упали. Смысл сохранён, выражен счётчиками: своей сессии
кандидаты проходят охват и названы `pending_review`, чужой — отсеяны охватом
(`reach_hidden`), `pending_review = 0`; в reach.session.test.ts добавлено
сквозное подтверждение `remember` отдельным процессом — знание появляется в
DECISIONS своей сессии и не появляется в чужой. Файлы:
packages/cli/src/hooks/reach.session.test.ts (2 теста),
packages/cli/src/hooks/compact-session-key.test.ts (1). Ещё один закреплял
строку ключа кеша `v3:…` — теперь `v4:…`
(packages/cli/src/commands/digest-cache.multiprocess.test.ts).

Полный `bun test` с PATH, где есть bun, но нет myc (как на CI): **3438 pass,
16 skip, 0 fail** (3454 теста, 225 файлов, 302.8 с). Первый полный прогон дал
4 fail — ровно три теста S58 и ключ кеша, описанные выше; после правки — 0.

Гейты: `bun run typecheck` — все 14 пакетов 0 ошибок; `bun run deps-check` —
passed (новый импорт `@myc/retrieval/review` — подпуть экспорта пакета, как
`./fts`: строка статуса, remember и absorb не тянут гибрид/вектор/кеш).

Покрыто: кандидат с дословным текстом запроса не отдаётся recall/search/prime/
MCP, обычная заметка с тем же заголовком — отдаётся; после подтверждения —
отдаётся; окно скана: 100 кандидатов с лучшим BM25 и одна заметка — заметка
найдена (гибрид), 100 кандидатов L3 в голове окна prime — заметка в DECISIONS;
вектор (vec0 в дочернем процессе): 20 кандидатов ближе запроса — заметка
найдена.

Мутации — 19 из 19 роняют тесты (прогон в клоне репозитория, чтобы не мешать
параллельному агенту):

| Снят фильтр | Падает |
|---|---|
| M1 CTE `matches` гибрида | review: «100 кандидатов … не вытесняют … из пула» |
| M2 финальный WHERE гибрида | review: «кандидат-сосед … не въезжает обходом графа» |
| M3 `hybridHydrate` | review: «кандидат из векторного источника …» |
| M4 `hybridCorpusSize` | review: «база из одних кандидатов — store_empty» |
| M5 `vectorKnn` | review: «двадцать кандидатов ближе запроса …» (vec0) |
| M6 `ftsSearch` | review: «ftsSearch: кандидат скрыт …» |
| M7 `prime_digest_scan` | 5 тестов: pending-review (своя сессия, retracted, окно 100) + latency (мутант, отсев) |
| M8 `prime_digest_scan_repo` | pending-review: «--repo: тот же фильтр во втором запросе» |
| M9 `prime_pending_count` | 6 тестов (подвал, счётчик) |
| M10 `sl_memory` | pending-review: «счёт notes не включает кандидата» |
| M11 пометка show | CLI show + MCP myc_show |
| M12 подтверждение в remember | CLI ×2 + MCP myc_remember |
| M13 absorb `fts` | absorb: «почти дословный повтор …» |
| M14 absorb `knn` | absorb ×2 |
| M15 поле `review` в kb | web kb |
| M16 счёт kb включает retracted | web kb |
| M17 «ждёт разбора» включает retracted | review (таблица) + pending-review (retracted) |
| M18 MCP verdict «new» | MCP myc_remember |
| M19 ключ кеша дайджеста остался v3 | pending-review: «дайджест, посчитанный до фильтра, …» |

## Как человек разбирает кандидатов сейчас

Отдельной команды/вида «на подтверждение» в проекте нет, дистиллятор —
заглушка (packages/distiller: TODO). Поэтому `--include-pending` у recall НЕ
заведён: сценария, где кандидатов ищут по теме, нет, а флаг, открывающий
непроверенное агенту одним словом, — ровно та дыра, которую закрывает задача.

- **Увидеть:** веб «база знаний» (помечены, число в подвале); `myc show <id>`
  (помечен); подвал `myc prime` — `N pending review hidden` (своя сессия);
  `myc list --kind memory` (без пометки).
- **Подтвердить:** `myc remember "<дословный текст кандидата>"` — ветка точного
  дубликата подтверждает (кто и когда — в узле). Перефразировка — отдельная
  заметка, кандидат остаётся ждать.
- **Отклонить:** `myc update <id> --status retracted` — из выдачи исключён по-
  прежнему, из «ждёт разбора» выходит. Так в этой базе отклонены 20 из 24.

## Открыто (вне границ задачи)

Заведено: memory-79mq6fccg0jm (P2, команда разбора), memory-0p3d8n1efwtv (bug
P2, retracted в выдаче), memory-4c24exck23cw (P3, вектор подтверждённого).

- Команды разбора нет: `myc review [--confirm|--reject] <id>` или
  `myc update <id> --confirm`, и `myc list --pending` (list.ts, tasks.ts —
  tasks.ts сейчас правит параллельный агент). Подсказка метки в вебе отсылает
  к `update --status retracted` — единственному пути отклонения сегодня.
- `retracted` не исключается из выдачи вообще: гибрид отсекает только
  `superseded`, дайджест prime статуса не смотрит. Отклонённые кандидаты
  теперь скрыты фильтром состояния, но отозванная обычная заметка по-прежнему
  доезжает до recall и CORE/DECISIONS.
- Подтверждённый через remember кандидат не встаёт в очередь embed/absorb
  (ветка дубликата очередь не ставит): вектора у него нет до переиндексации.
- `myc absorb <id кандидата>` явно по id классифицирует самого кандидата — если
  он старше найденного дубля, заметка уйдёт в него. Хук кандидатов в очередь
  absorb не ставит, путь только ручной.
- Писатель (`absorb-session.ts`) по-прежнему пишет строку `"pending_review"`
  литералом; константа — `PENDING_REVIEW` в `@myc/retrieval/review`.
