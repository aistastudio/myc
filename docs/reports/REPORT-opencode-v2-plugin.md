# Плагин opencode в v2: отказ default-экспорта (err_0115e516)

Отчёт о расследовании и исправлении интеграции с opencode. Рабочее дерево
`/Users/egortaranin/src/memory-main`, ветка `main` (`060e6dd` 0.4.5); каталог
задачи остался на `ade-wave0`, чтобы не шевелить чужие ветки.

## Симптом

Карточка отказа в сессии: `Server plugin error — Plugin:
~/.config/opencode/plugin/myc.ts — Error: Plugin must export a default
definition with an id and an effect or setup function. Reference: err_0115e516`.

## Причина — из записи сервера, не по номеру ссылки

`~/.local/share/opencode/log/opencode.log`, строка `ref=err_0115e516`:

```
level=WARN message="failed to load plugin" target=~/.config/opencode/plugin/myc.ts
cause="Cause([Fail(PluginModule.LoadError: Plugin must export a default
definition with an id and an effect or setup function. (cause:
SchemaError(Missing key  at ["default"])))])"
```

За сессию таких записей **4** (err_0115e516, err_1d25b80f, err_a4e45135 —
глобальный слой; err_44d3e206 — `.opencode/plugin/myc.ts` проекта), все с одной
причиной: **в модуле нет `export default`**.

`opencode` в PATH — это **v2.0.25** (`/opt/homebrew/Cellar/opencode-v2/2.0.25`).
Загрузчик v2 читает только default-экспорты; именованный
`export const MycPlugin`, который генерирует myc (форма opencode 1.x), он не
смотрит вовсе. Плагин не грузился **вообще** — значит, в v2 не работали ни
prime (системный контекст), ни absorb при сжатии, ни `anchor touch`.

Побочно: `mimo` 0.1.15 (форк v1) и рядом стоящий `opencode` **1.18.31** —
другие загрузчики, см. матрицу ниже.

Секретов и обязательных переменных окружения у плагина нет: он зовёт только
`myc` CLI (`MYC_BIN`/`PATH`), а отсутствие бинаря по договорённости даёт
тишину. Никаких credentials файл не читает.

## Матрица форм default-экспорта — живые прогоны

Изолированные `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`, плагин-проба пишет
вызовы входов в файл; `opencode serve`/`run` против фальшивого проекта.

| Форма модуля | opencode 1.18.31 | opencode 2.0.25 |
|---|---|---|
| только именованный экспорт (форма myc до правки) | грузится | **отказ**: `Missing key at ["default"]` (этот и есть err_0115e516) |
| `default = {id, setup, server}` + именованный (та же функция) | грузится: `server()` **1 раз** (хук system.transform сработал на обоих запросах модели), `setup()` 1 раз СВОИМ контекстом `{options, agent, aisdk, catalog, command, integration, plugin, reference, skill}` — `session.hook` там нет | грузится: `setup(ctx)` отработал, `session.hook("context")` и `tool.hook("execute.after")` зарегистрированы, `server()` не зовётся |
| `default` = функция со свойствами id/setup/server | не проверялась (ненужная) | **отказ**: `Expected object at ["default"]` |

Вывод: обязателен **объектный** default; именованный экспорт оставлен как
`default.server` — одна и та же функция, чтобы 1.x, дедуплицирующий экспорты
по значению, зарегистрировал хуки ровно один раз.

## Формы данных 2.x — сняты живым прогоном на этой сессии

- `ctx.location` = `{directory, project:{id, directory, canonical}}`; `ctx`
  содержит `session`, `tool`, `event` и ещё 21 домен.
- `session.hook("context", cb)` — событие `{sessionID, agent, system, ...}`,
  `system` — **массив объектов** `{type:"text", text}` (не строк): столько же
  объектов и кладётся prime.
- `session.hook("compaction", cb)` — та же система; пакет absorb кладётся туда же.
- `tool.hook("execute.after", cb)` — `{tool, sessionID, agent, messageID, id,
  input, status, result}`; `status: "completed" | "error"`.
- `ctx.session.context({sessionID})` — **плоский** список сообщений
  (61 шт. / 625 869 байт на этой сессии), формы `user` (`{type, text}`),
  `assistant` (`{type, model:{id}, content:[{type:"reasoning"|"text"|"tool"}]}`)
  и `system`; у tool-блока имя в `name`, состояние `{status, input,
  content:[{type:"text"}] | error}` — вместо 1.x `{info, parts}` и
  `state.output` строкой.
- `ctx.event.subscribe({signal})` — асинхронная итерация событий, есть тип
  `session.compacted`; cleanup возвращается из `setup`.

## Исправление

`packages/cli/src/hooks/templates.ts`, шаблоны opencode получают режим
`api: "dual"` (mimo остаётся `"v1"` — его бинарь форк v1, форма не менялась):

1. Генерируется `export default { id, setup, server }` **плюс**
   `export const MycPlugin = server` (одно значение на оба имени).
2. `server()` — прежние возвратные хуки 1.x, без изменений (1.18.31 зовёт их).
3. `setup(ctx)` — хуки 2.x: `session.hook("context")` (prime, кеш на сессию,
   кладётся в каждый запрос, служебный запрос распознаётся по `SYSTEM_PROMPT`),
   `session.hook("compaction")` (пакет в `event.system`),
   `tool.hook("execute.after")` (якорь, только `status: "completed"`),
   страховка `session.compacted` через `ctx.event.subscribe()` с cleanup.
   Первый же `if` — `typeof ctx?.session?.hook !== "function"`, то есть на 1.x,
   который зовёт `setup` своим контекстом, ничего не регистрируется (проверено
   живым прогоном 1.18.31).
4. Стенограмма: общий `transcriptFrom` понимает обе формы (1.x `[{info,parts}]`
   и 2.x плоские сообщения), `absorb` получает готовый JSONL.
5. Пользовательский слой: сторож (воркспейс + проводка проекта) выполняется и
   в `setup`, так что в чужом проекте региструется **ноль** хуков.

## Тесты

- `wire-user.opencode.test.ts` + `harness-transcript.test.ts` +
  `counters.test.ts`: **40 тестов, 0 падений** (раннер переписан под оба
  загрузчика: форма default, `MycPlugin === default.server`, вызов 1.x-хуков,
  вызов `setup` с контекстом 1.x, регистрация и прогон 2.x-хуков, очистка).
- Новый тест в `harness-transcript.test.ts`: 2.x-стенограмма из
  `ctx.session.context` доходит до эпизода (`turns=2, files=1,
  transcript_format=jsonl, session_id=ses_v2`).
- `bun run typecheck`: **14 пакетов, 0 ошибок**.
- Полный прогон — раздел «Полный прогон» ниже.

Мутации, роняющие тесты: убрать `export default` → раннер падает на форме;
`MycPlugin !== default.server` → падает проверка дедупликации; убрать ветку
`state.content` из `transcriptFrom` → падает тест эпизода 2.x; убрать
`session.hook("context")` → падает проверка `v2system`.

## Что перегенерировано и проверено на живой машине

- `~/.config/opencode/plugin/myc.ts` (18.6 КБ) и
  `/Users/egortaranin/src/memory/.opencode/plugin/myc.ts` (16.3 КБ) — перезаписаны
  `myc wire`/`myc wire --scope user` из сборки ветки `main` (журналы `wire.json`
  и `wire-user.json` обновлены, `opencode.json` оба — unchanged, mcp.myc на месте).
- Журнал целиком: **18** записей `message="failed to load plugin"` про файлы
  myc, последняя в **15:20:26.780Z** — то есть все до перегенерации; после
  неё **0**. Загрузок `msg="loading plugin"` для файлов myc — 25, из них 10
  после правки: оба слоя подхватываются сервером и при каждом изменении
  каталога.
- Счётчики `.myc/hooks.json` (время UTC):
  - `opencode:post-edit` — 95 при `last_at 10:25:06` (то есть хуки молчали,
    пока стоял v2) → **97 при `last_at 15:28:47`**;
  - `opencode:session-start` — 27 при `last_at 15:20:32`, то есть первая же
    модельная сессия после перегенерации проектного плагина получила prime;
    дальше счётчик стоит (текст кешируется на сессию, `myc prime` — один
    вызов), `last_status: ok`.
- Служебная проба на два модельных вызова: в системе запроса **5 частей, из них
  1 — вывод prime**, последняя часть начинается с
  `myc 0.4.4 · ws=memory sqlite · 1020 nodes · idx ok` — то есть prime доходит
  до модели на v2, а не только пишется в счётчик.
- `mimo` 0.1.15 в изолированном окружении: новый (v1-шaped) файл
  `.mimocode/plugin/myc.ts` — `service=plugin … myc.ts loading plugin`, отказов
  загрузки **0**.

### `myc doctor --hooks` до релиза этой ветки

Файлы писала сборка 0.4.5 из рабочего дерева `main`, а на машине установлена
**0.4.4** — поэтому doctor честно показывает дрейф по обоим нашим файлам:

- `.opencode/plugin/myc.ts: stale: the file is exactly what myc wire wrote
  (4d6c51037498f9dc), but this build's template produces a different one`;
- `user:~/.config/opencode/plugin/myc.ts: stale: exactly what myc wire
  --scope user --agents opencode wrote (myc 0.4.5, 8acb586e82370b4d), but this
  build (myc 0.4.4) …`.

Это ожидаемо и **не** чинится перегенерацией установленным 0.4.4: он записал бы
назад файл, который v2 снова не грузит. Дрейф снимет релиз, несущий эту ветку.
Установленный myc не заменялся намеренно — правило AGENTS.md запрещает гонять
девелоперскую сборку с новыми миграциями поверх рабочей базы. Прочие дрейфы в
том же выводе (claude settings PreToolUse, permissions, SKILL.md 0.3.11,
statusLine) — прежние и к opencode не относятся.

## Полный прогон

`myc run -- bun test` на ветке `main` с правками: **4211 pass, 16 skip, 9 fail**
(4236 тестов, 277 файлов, 7 мин 25 с). Разбор падений:

- **7 из 9 воспроизводятся на чистом `main`** — те же 4 файла прогонялись
  со снятыми правками (`git stash`): набор падений **один в один**
  (6 × `federation.multirepo` — лишний источник «me» в федерации, и
  `классификатор orca > перенос совпадает с установленным кодом orca`; про
  последнее прямо сказано в коммите `0.4.5`: «существовало до правок»).
  Разница правки/без правки — **0 тестов**.
- **2 из 9** — падения только под нагрузке полного прогона
  (`search-web`: векторная ветка при холодном эмбеддере; `federation.latency`:
  бюджет времени при load1≈7); поштатно в изоляции проходят **оба**.
- Три файла задачи — `wire-user.opencode.test.ts`, `harness-transcript.test.ts`,
  `counters.test.ts`: **40 pass, 0 fail** и в составе полного прогона.

## Состояние веток

- `main`: изменения шаблонов, тестов, design `03-interfaces` §6.6 и этого
  отчёта.
- `ade-wave0` (каталог задачи): `.opencode/plugin/myc.ts` перегенерирован тем же
  генератором и лежит **немодифицированным по содержимому относительно main**
  (файл отслеживается git, поэтому в `git status` он изменён); волна унесёт его
  при слиянии без конфликта — правок в ветке wave под этот файл не было.
