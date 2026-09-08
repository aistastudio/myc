# memory-7vywv63wma61 — один список харнессов, поддержка Kimi, codex в ростере

Ростер знал `claude, opencode, kimi`, `myc wire` ставил `claude, codex, opencode`.
Обе половины кусались: попытку под Codex записать было нельзя, хотя конфиг ему
wire ставил; Kimi числился в ростере, но не настраивался вовсе. Ниже — что
сделано, чем это закрыто и что осталось незакрытым.

## 1. Один список, а не два

Список живёт в **`packages/swarm/src/harness.ts`** — в самом нижнем пакете,
которому он нужен (`swarm` зависит только от `@myc/core`, `cli` зависит от
`swarm`), и читается оттуда всеми: ростером (атрибуция), `myc wire`
(установка), `absorb-session --agent` (кто позвал хук).

```
export const HARNESSES = ["claude", "codex", "opencode", "kimi"] as const;
```

`roster.ts` реэкспортирует его, чтобы `@myc/swarm` по-прежнему отдавал
`HARNESSES` одним импортом. Из `wire.ts` собственный `ALL_AGENTS` убран;
вместо `if (agents.includes("claude")) …` там теперь
`PLANNERS: Record<Harness, …>` и обход по `HARNESSES`.

### Сторож — `packages/cli/src/harness.wiring.test.ts`

Сделан по образцу обоих названных в задаче: корпус СОБИРАЕТСЯ ИЗ ИСХОДНИКА
(как `site-identity.wiring.test.ts`, с вырезанием комментариев), реестр
исключений — поимённо и с причиной (как `register.test.ts`), пустым корпус
себе стать не даёт. Три половины:

1. **Текст.** Ни одна единица верхнего уровня, кроме `swarm/src/harness.ts` и
   замороженных DDL миграций (001, 003, 008), не имеет права содержать два и
   более РАЗНЫХ имени харнесса строковыми литералами. Кавычки в шаблоне не
   украшение: они отделяют перечисление от пути (`.kimi-code/…`) и от ключа
   объекта (`claude: planClaude`) — ключи и без того привязаны к списку типом
   `Record<Harness, …>` и разъехаться молча не могут (это ловит `tsc`).
2. **Wire.** Каждый харнесс обязан давать непустой план (`--agents <имя>`),
   имя вне списка обязано отвергаться до записи, `wire` без флага обязан
   обслуживать РОВНО `HARNESSES`.
3. **Ростер.** `myc model add --harness <имя>` обязан проходить для каждого —
   это ловит забытую миграцию: домен пропустит, а CHECK схемы отвергнет.

Четвёртая половина — в `packages/swarm/src/roster.test.ts`: «CHECK схемы
принимает ровно HARNESSES», прямым INSERT мимо домена.

## 2. Kimi: что он читает — установлено, а не предположено

Источник — сам бинарь `~/.kimi-code/bin/kimi` (сборка 2026-09-04) и живой
конфиг пользователя. Ничего не выдумано; ниже каждый факт с местом, где он
прочитан.

| Что | Где Kimi это читает | Откуда знаем |
|---|---|---|
| MCP | `~/.kimi-code/mcp.json`, `<корень репозитория>/.mcp.json`, `<cwd>/.kimi-code/mcp.json` — последний перекрывает предыдущие по одноимённому ключу | `resolveMcpJsonPaths()` в бинаре |
| форма записи MCP | `{command, args}` без `transport` — stdio выводится препроцессором | `McpServerConfigSchema = preprocess(… if (typeof obj["command"] === "string") return {...obj, transport: "stdio"} …)` |
| скиллы проекта | `.kimi-code/skills/` и `.agents/skills/` | `PROJECT_BRAND_DIRS = [".kimi-code/skills"]`, `PROJECT_GENERIC_DIRS = [".agents/skills"]` |
| формат скилла | `SKILL.md` с фронтматтером, непустые `name` и `description` | `parseSkillText()`; тот же формат, что у Claude Code |
| хуки | **ТОЛЬКО** `<KIMI_CODE_HOME ?? ~/.kimi-code>/config.toml`, секция `[[hooks]]` | `resolveConfigPath() = join(resolveKimiHome(…), "config.toml")`; проектного config.toml нет |
| запись хука | `event` (закрытый список), `matcher` — РЕГУЛЯРКА, `command` — строка через shell, `timeout` — целые **СЕКУНДЫ** 1..600 | `HookDefSchema … .strict()` |
| вход хука | JSON на stdin, ключи snake_case: `hook_event_name`, `session_id`, `cwd` + поля события (`source` у SessionStart, `trigger`/`token_count` у PreCompact) | `runHook()`, `toHookInputData()` (camelCase → snake_case на верхнем уровне) |
| выход хука | код 0 и stdout, **разобранный как JSON**; в контекст идёт `message` или `hookSpecificOutput.message`. Обычный текст молча выбрасывается. Код 2 — блокировка хода | `structuredOutput()`, `HookJsonOutputSchema` |

### Что из этого делает `myc wire --agents kimi`

Пишет три файла, все под `.kimi-code/`, ни одного чужого:

```
new  .kimi-code/skills/myc/SKILL.md   2.0 КБ
new  .kimi-code/myc-hooks.mjs         2.4 КБ
new  .kimi-code/mcp.json              +1 узла: mcpServers.myc
```

Проектный `.mcp.json` НЕ занимается ради Kimi: это файл Claude Code, а Kimi
прочитает и его, если рядом стоит claude — ключ `myc` один и тот же, дубля не
будет.

### Чего wire для Kimi не делает и почему

**Хук поставить нельзя.** Конфиг хуков у Kimi только пользовательский, а
`myc wire` по правилу D10 за пределы проекта не пишет — и не должен: запись в
`~/.kimi-code/config.toml` включила бы хук во ВСЕХ проектах пользователя.
Поэтому wire ставит исполняемую половину (helper) и печатает готовый блок —
и в `--dry-run`, и в реальном прогоне, и в `--json` (`data.notes`):

```toml
# myc:kimi:start
[[hooks]]
event = "SessionStart"
command = "if [ -f .kimi-code/myc-hooks.mjs ]; then node .kimi-code/myc-hooks.mjs session-start; else cat >/dev/null 2>&1 || true; fi"
timeout = 3

[[hooks]]
event = "PreCompact"
command = "if [ -f .kimi-code/myc-hooks.mjs ]; then node .kimi-code/myc-hooks.mjs pre-compact; else cat >/dev/null 2>&1 || true; fi"
timeout = 8
# myc:kimi:end
```

Команда ОТНОСИТЕЛЬНАЯ и защищена проверкой существования файла: конфиг один
на все проекты, и хук с абсолютным путём одного репозитория срабатывал бы в
каждой чужой сессии. `cat >/dev/null` в ветке else — чтобы Kimi не ждал на
незакрытом stdin (тот же приём, что в чужих hook-блоках этого конфига).

**Событий два, а не четыре.** `session-start` и `pre-compact` — те, чей вход
проверен по коду. Хука на правку файла (`myc anchor touch`) для Kimi нет:
его матчер — имя инструмента Kimi, а форма `tool_input` зависит от схемы
инструмента, и ни того ни другого подтвердить чтением бинаря не удалось.
Хук, который не сработает ни разу, хуже отсутствующего.

**Helper заворачивает вывод в `{"message": …}`** и зовёт `absorb-session` с
`--hook-output text`: форма `hookSpecificOutput.additionalContext`, которую
понимает Claude Code, для Kimi пуста, и пакет молча пропал бы.

### Живая проверка helper'а (не тест — настоящий запуск)

```
$ echo '{"hook_event_name":"SessionStart","session_id":"sess-abc","cwd":"…","source":"startup"}' \
  | node .kimi-code/myc-hooks.mjs session-start
{"message":"myc 0.1.1 · ws=wiredemo sqlite · 2 узлов · idx ok …
 … 367 симв · 76 мс · cache miss · сессия sess-abc\n"}          exit 0
```

`session_id` из полезной нагрузки Kimi дошёл до `myc prime --session`.
PreCompact так же отдал спасательный пакет. Без бинаря myc (пустой PATH, HOME
и `MYC_BIN` в никуда) — пустой stdout и **exit 0**; мусор вместо JSON на
stdin — тоже exit 0. Кодом 2 helper не выходит никогда: у Kimi это блокировка
хода агента.

## 3. codex в ростере: понадобилась миграция

Строкой в `harness.ts` это не чинится: `CHECK (harness IN …)` стоит в схеме,
в миграциях 1 и 3, а текст применённой миграции заморожен чек-суммой
(`schema.ts`) — правка задним числом роняет каждую существующую базу с
`schema.checksum`. У SQLite нет `ALTER TABLE DROP CONSTRAINT`, поэтому
**`008-harness-codex.ts` перестраивает таблицы**.

Перестраиваются ЧЕТЫРЕ: `swarm_model`, `swarm_model_price`, `swarm_attempt`,
`swarm_attempt_run`. У цены колонки `harness` нет, но есть ссылка на
`swarm_model`, а `ALTER TABLE … RENAME` в SQLite 3.25+ переписывает ссылки
детей на новое имя — ребёнок, оставленный на месте, смотрел бы на
переименованную старую таблицу. Проверено вживую: без цены в наборе
`INSERT` в ростер падал с `no such table: main.swarm_model_pre8`.

Два обходных пути отвергнуты по результатам эксперимента, а не по вкусу:

* `defer_foreign_keys=ON` + `DROP`/`RENAME` — **COMMIT падает**
  `FOREIGN KEY constraint failed`: счётчик отложенных нарушений, набранный
  неявным `DELETE FROM` родителя, не обнуляется появлением новой таблицы с
  теми же строками;
* `legacy_alter_table=ON` (чтобы RENAME не трогал ссылки) — **падает на
  `DROP TABLE` старого родителя**, тоже FK.

Проходит только порядок «все RENAME → все CREATE → INSERT от родителя к
ребёнку → DROP от ребёнка к родителю → CREATE INDEX». Индексы 4, 5 и 7
уезжают вместе со своими таблицами и погибают на DROP — они пересоздаются,
иначе выборка «рука × класс задачи» тихо стала бы полным сканом.

Всего 19 операторов. Правило «один оператор на миграцию» не ослаблено, а
уточнено: `SwarmMigration.sql` теперь `string | readonly string[]`, один
оператор на ЭЛЕМЕНТ, и сторож `roster.test.ts` проверяет каждый элемент
отдельно. Чек-сумма строковой миграции считается по той же строке байт в
байт — существующие базы `schema.checksum` не увидят. Весь отстающий хвост
по-прежнему накатывается в одной транзакции `BEGIN IMMEDIATE`, поэтому
половины состояния не бывает.

## Приёмка: живые прогоны

```
$ myc wire --agents kimi --dry-run     # печатает 3 файла + блок [[hooks]]
$ myc wire --agents kimi               # пишет ровно их
$ myc wire --agents kimi               # «всё уже на месте, файлы не тронуты»
$ myc unwire                           # снял 3, mcp.json остался {} , чужого нет

$ myc model add openai/gpt-5-codex --family gpt --harness codex …   → harness codex
$ myc model add moonshot/kimi-for-coding --family kimi --harness kimi … → harness kimi
$ myc attempt start … --model openai/gpt-5-codex     → att_aea73426e75e (codex)
$ myc attempt start … --model moonshot/kimi-for-coding → att_afa5677f82c9 (kimi)
$ myc report models
feature:unknown
    moonshot/kimi-for-coding|medium    n=  1  q=0.50  cost=$0.067/попытка  чисто 0%
fix:unknown
    openai/gpt-5-codex|medium          n=  1  q=1.00  cost=$0.230/попытка  чисто 100%
покрытие  задач закрыто 0, с атрибуцией 2; попыток 2 (закрыто 2, со стоимостью 2)
```

`myc wire --dry-run` и реальный прогон сверяются тестом: списки действий
сравниваются целиком, и для каждого обещанного пути проверяется файл на диске.

## Числа

| Прогон | Тестов | Падений |
|---|---|---|
| `packages/swarm` | 161 | 0 |
| `wire.test.ts` + `harness.wiring.test.ts` + `hooks/` | 81 | 0 |
| `bun test` (весь репозиторий) | 2450 (16 skip) | 4 + 1 error |
| `bun run typecheck` (14 пакетов) | — | 0 |
| `bun run deps-check` | 14 пакетов | 0 |

Четыре падения полного прогона — **не мои**:

* `packages/cli/src/commands/ready.inherit-latency.test.ts` (2 падения) —
  таймаут `beforeAll` на постройке фикстуры. Проверено прямо: со СПРЯТАННЫМИ
  моими правками (`git stash push` по списку файлов) файл падает ровно так же.
  Файл живёт рядом с `ready.ts`, который правит второй агент.
* `packages/store-sqlite/src/cycle.latency.test.ts` — бюджет записи 5 мс,
  зависит от загрузки машины; в отдельном прогоне зелёный.
* `packages/cli/src/commands/show.test.ts` — таймаут хука; в отдельном
  прогоне 15 из 15 зелёных. С ним же связан единственный `error`
  (`SQLITE_READONLY_DBMOVED`: каталог фикстуры убран из-под открытого
  соединения).

## Мутации

Каждая мутация вносилась в дерево, прогонялась и откатывалась.

| # | Мутация | Что покраснело |
|---|---|---|
| 1 | вернуть `const ALL_AGENTS = ["claude","codex","opencode"]` в `wire.ts` | 2 теста; первый называет виновного поимённо: `cli/src/commands/wire.ts::ALL_AGENTS:603` |
| 2 | добавить `"cursor"` в `HARNESSES`, миграцию не писать | `roster.test.ts` ×2 (`CHECK constraint failed: harness IN ('claude','codex','opencode','kimi')`) + `tsc`: `Property 'cursor' is missing in … Record<…, PLANNERS>` |
| 3 | убрать миграцию 8 из набора | `roster.test.ts` ×4, в т.ч. «CHECK схемы принимает ровно HARNESSES» и «после наката codex принимается» |
| 4 | в миграции 8 сбросить таблицы в обратном порядке (родитель раньше ребёнка) | `roster.test.ts` ×2, `FOREIGN KEY constraint failed` — и красным становится ИМЕННО тест обновления старой базы; тесты на свежей базе остаются зелёными, чем и оправдывают своё существование |
| 5 | `planKimi` ничего не ставит | 8 тестов: `harness.wiring` («--agents kimi даёт непустой план») + все 5 kimi-тестов в `wire.test.ts` + идемпотентность |
| 6 | таймаут Kimi-хука в миллисекундах вместо секунд | `wire.test.ts` «про пользовательский config.toml сказано вслух» |
| 7 | helper отдаёт голый stdout вместо `{"message": …}` | `wire.test.ts` «helper заворачивает вывод в {message}» |

## Что осталось / за границей

* **Хук Kimi ставит человек.** Иначе — запись в `~/.kimi-code/config.toml`,
  то есть за пределы проекта и во все проекты сразу. Если решение изменится,
  напрашивается отдельная явная команда (`myc wire --kimi-user-hooks`), а не
  тихое расширение `wire`.
* **`post-edit` для Kimi не предложен** — форма `tool_input` и имена
  инструментов не подтверждены чтением. Когда подтвердятся, добавляется одна
  запись в `KIMI_EVENTS` и одна строка в `kimiHelper`.
* **Документация дизайна не тронута**: `docs/design/03-interfaces-and-integration.md`
  описывает три харнесса и правится другим агентом — координатору стоит свести.
* `myc show memory-7vywv63wma61` в этой сессии недоступен: локальный бинарь
  `myc` отстаёт от схемы базы (`precond.schema`: база 10, бинарь знает 9).
  Работа велась по тексту задачи из спецификации.

## Изменённые файлы

```
новые:    packages/swarm/src/harness.ts
          packages/swarm/src/migrations/008-harness-codex.ts
          packages/cli/src/harness.wiring.test.ts
          docs/reports/REPORT-harness-kimi-codex.md
правлены: packages/swarm/src/roster.ts, schema.ts, index.ts, roster.test.ts
          packages/swarm/src/migrations/{types.ts,index.ts}
          packages/cli/src/commands/{wire.ts,wire.test.ts,roster.ts}
          packages/cli/src/hooks/{templates.ts,absorb-session.ts}
```
