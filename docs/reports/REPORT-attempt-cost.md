# memory-jr0r6yd07d5v — расход попытки из стенограммы сессии

## Что сделано

`myc attempt finish --from-transcript <файл>` и `--from-session <uuid>` заполняют
tokens-in/out и обе статьи кеша из стенограммы Claude Code. Ручные `--tokens-*`
остались запасным путём и спорить со стенограммой им не дают: источник ровно один.

Разбор вынесен в `packages/swarm/src/transcript.ts` — тем же кодом пользуется
переписанный `scripts/attempt-cost.ts`, так что у скрипта и у команды одни и те же
числа и одни и те же отказы.

### Главная находка: наивная сумма завышала расход в ~1.6 раза

Прототип складывал usage из каждой записи. Но ОДИН ответ модели лежит в стенограмме
НЕСКОЛЬКИМИ записями (рассуждение, текст, каждый вызов инструмента), и **каждая несёт
копию одного и того же `usage`**. Замер по 397 стенограммам проекта: 16827 записей с
usage дают 9290 настоящих ответов.

| memory-2shvpjay4nx6, сессия 510bfdf4 | наивно | склейка по `message.id` |
|---|---|---|
| output | 119 953 | **68 803** |
| чтения кеша | 18 249 176 | **11 666 149** |

Из 947 групп с различающимися значениями 941 растут монотонно — это частичные записи
стриминга, поэтому по группе берётся **максимум** поля, а не первое и не сумма.

## Ограждения (И2): отказ, а не ноль

Ноль неотличим от «не смогли прочитать» — именно так ось цены осталась бы пустой
МОЛЧА: попытка закрыта, `cost_basis='no_tokens'`, отчёт по-прежнему пуст. Поэтому
каждое расхождение с ожидаемым форматом — отказ команды **до** записи в базу
(попытка остаётся открытой):

| код | когда | exit |
|---|---|---|
| `transcript.missing` / `.dir_missing` / `notfound.session` | файла или каталога нет, сессии по uuid нет | 3 NOTFOUND |
| `transcript.unreadable` | файл не читается | 1 ERR |
| `transcript.empty` | ни одной разобранной записи | 5 PRECOND |
| `transcript.no_usage` | ни в одном сообщении нет `message.usage` | 5 PRECOND |
| `transcript.no_fields` | usage есть, знакомых полей нет | 5 PRECOND |
| `transcript.missing_field` | пропало одно из четырёх полей (переименовали) | 5 PRECOND |
| `transcript.bad_field` | поле есть, но не целое ≥ 0 или вне точных целых | 5 PRECOND |
| `transcript.no_key` | у записи с usage нет ни `message.id`, ни `requestId` — склеить нечем | 5 PRECOND |
| `transcript.overflow` | сумма вышла за 2^53 | 5 PRECOND |
| `transcript.no_tokens` | разобрано, а расход 0 — у настоящей сессии так не бывает | 5 PRECOND |
| `usage.token_source` | расход задан и стенограммой, и флагами | 2 USAGE |

`transcript.missing_field` — не педантизм: если переименуют `cache_read_input_tokens`
(самую крупную статью), тихий ноль по ней занизил бы стоимость в разы.

## Точность больших чисел

Чтения кеша доходят до 2 053 192 236 за сессию. Проверено сквозным путём
(стенограмма → JS → SQLite INTEGER → чтение обратно): до 2^53 точно, за границей —
отказ, а не молча округлённое число. `count()` в `attribution.ts` подтянут с
`Number.isInteger` на `Number.isSafeInteger`: `2**53` — целое, но уже неточное.

## Мутации (13, все ловятся)

База зелёная, `bun test packages/swarm/src/transcript.test.ts
packages/swarm/src/attribution.test.ts packages/cli/src/commands/attempt.test.ts` — 0 падений.

| мутация | падений |
|---|---|
| М1 отказ «нет usage» подменён нулевым расходом | 2 |
| М2 пропавшее поле usage → тихий ноль по нему | 2 |
| М3 usage без единого знакомого поля → ноль | 1 |
| М4 нечисловое значение поля → ноль | 2 |
| М5 склейка копий ответа убрана: наивная сумма | 4 |
| М6 по группе берётся первое значение, а не максимум | 1 |
| М7 запись без ключа склейки считается отдельной | 1 |
| М8 граница точности ослаблена до `Number.isInteger` | 1 |
| М9 разобрано, а расход ноль — пропускаем | 1 |
| М10 отсутствие файла больше не отдельный отказ | 2 |
| М11 CLI: стенограмма и ручные флаги вместе — молча | 1 |
| М12 CLI: отказ разбора превращается в нулевой расход | 4 |
| М13 `count()`: граница точности ослаблена до `Number.isInteger` | 1 |

## Прогоны

- `bun test packages/swarm` — **106 pass, 0 fail** (8 файлов)
- `bun test packages/cli` — **659 pass, 0 fail** (45 файлов, 38.6 с)
- `tsc --noEmit` в `packages/cli` и `packages/swarm` — чисто

Новых тестов: 19 в `transcript.test.ts`, 11 в `attempt.test.ts`, 2 в `attribution.test.ts`.

## Проверено живьём

На копии настоящей базы (`.myc/myc.db` скопирована в scratchpad, проект не тронут) и на
настоящих стенограммах из `~/.claude/projects/-Users-egortaranin-src-memory`:

```
myc attempt finish --task memory-2shvpjay4nx6 --verdict accepted \
  --from-transcript …/510bfdf4-….jsonl
→ verdict accepted · quality 1.00 · cost $5.163 (priced)
  расход in 162 out 68803 · ответов 81 из 131 записей

myc attempt finish --task memory-hbc42qtv0jvc --verdict rework --caveat coordinator-fixed \
  --from-session a43ed0d2-8006-…
→ quality 0.15 · cost $1.239 (priced) · ответов 71 из 128 записей

myc report models --min 1
→ fix:unknown  opus|high  n=1  q=1.00  cost=$5.163/попытка (1/1)   ← ось цены больше не пуста
```

Отказ вживую, на настоящей стенограмме без usage (`agent-a068f6f.jsonl`):

```
myc: transcript.no_usage: ни в одном из 1 сообщений … нет message.usage;
     расход не прочитан — это отказ, а не ноль
код выхода 5; попытка осталась открытой (attempt list --open её показывает)
```

`scripts/attempt-cost.ts` на memory-2shvpjay4nx6 по-прежнему находит ОБЕ попытки
(18:02–18:31 и 19:50–20:16) и печатает готовую команду `attempt finish --from-session …`;
числа теперь без завышения.

## Файлы

- `packages/swarm/src/transcript.ts` — новый, разбор и поиск сессий
- `packages/swarm/src/transcript.test.ts` — новый, 19 тестов
- `packages/swarm/src/index.ts` — экспорт
- `packages/swarm/src/attribution.ts` — `count()` на `Number.isSafeInteger`
- `packages/swarm/src/attribution.test.ts` — +2 теста про огромные числа
- `packages/cli/src/commands/attempt.ts` — флаги источника, `tokenSource`,
  `transcriptFailure`, провенанс в выводе, кеш-токены в `attemptView`
- `packages/cli/src/commands/attempt.test.ts` — +11 тестов
- `scripts/attempt-cost.ts` — переписан на общий разбор

`packages/web/**` не тронут. `tasks.ts` и `show.ts` не тронуты.

## Что осталось

1. **`myc close --verdict` те же флаги не принимает.** Координатор закрывает задачи
   через `close`, а не через `attempt finish`, — там расход по-прежнему только руками.
   Провод тривиален (`tokenSource` вместо `tokenArgs` в `finishAttribution`), но это
   `packages/cli/src/commands/tasks.ts`, который координатор правит прямо сейчас
   (msg --reply-to, показ нити). Оставил за ним, чтобы не ловить конфликт.
2. **Поиск сессии по задаче не в CLI**, а в скрипте: `bun run scripts/attempt-cost.ts
   <task-id> --self <свой uuid>`. Автоподбор «сама найди мою сессию» внутри
   `attempt finish` требует решить, что делать при двух кандидатах (переделка) — по
   уму это отдельный флаг с отказом при неоднозначности.
3. **Цена кеша в ростере — ноль** (memory-501fa4jp7xpw, чужая задача). Токены кеша
   теперь пишутся верно, но в стоимость входят по нулевой цене: $5.163 выше — это
   почти только output. Ничего под это не подгонял.
4. Задачу не закрывал: вердикт ставит координатор.
