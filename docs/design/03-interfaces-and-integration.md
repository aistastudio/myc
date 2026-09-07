# L3 — Поверхности и интеграции

> Лейн L3 дизайн-сессии `myc`. Контекст — `docs/design/00-brief.md`.
> Здесь: грамматика CLI, MCP-поверхность, хуки агентов, адаптер graft,
> абстракция LLM-провайдеров, HTTP API и proxy, командная работа,
> веб-визуализация, онбординг.
>
> Границы лейна: я проектирую **интерфейсы**. Схема хранилища — L1,
> алгоритмы ретривала — L2, роутинг моделей — L4. Там, где я опираюсь на
> их контракт, стоит пометка `[cross:L1]` / `[cross:L2]` / `[cross:L4]`
> и вопрос вынесен в §13.

---

## 1. Решения

| # | Вопрос | Выбор | Почему | Что отвергли |
|---|---|---|---|---|
| D1 | Форма CLI | Плоский набор коротких глаголов (`myc ready`, `myc claim`), без `myc task list`-вложенности глубже 2 | Агент печатает команду по памяти; каждый лишний уровень — лишний токен и лишняя ошибка | `myc node task create` (git-style), интерактивный TUI по умолчанию |
| D2 | Человеческий вывод | Плотный колоночный текст, без рамок/эмодзи/цвета при не-TTY, одна сущность = одна строка | Вывод читает LLM, не человек. Рамки и ANSI — чистые потери токенов | Таблицы с рамками, YAML-подобный вывод, «красивый» вывод по умолчанию |
| D3 | Машинный вывод | `--json` — один объект-конверт `{ok,cmd,data,meta,warn}`; `--ndjson` — поток для больших списков | Конверт даёт место для `warn`/`degraded` без ломания парсеров; NDJSON — стрим без буферизации 100k строк | Голый массив (некуда класть предупреждения), XML, protobuf |
| D4 | Коды выхода | Фиксированные 0–9, никогда не переиспользуются | Скрипты и хуки ветвятся по коду; «всё не 0» — бесполезно | Только 0/1; коды в стиле sysexits (64–78) — агенты их не знают |
| D5 | Деградация | Всегда видна: строка `WARN` в человеческом выводе, `meta.degraded[]` в JSON, поле в записанных данных, ненулевой код только с `--strict` | Прямая контрмера ловушке memora (молчаливый TF-IDF). Молчание = база наполняется мусором | Тихий фолбэк; жёсткая ошибка (сломает работу без ключа, а `$0` — требование §3 брифа) |
| D6 | `recall` vs `search` | Одна реализация, две обёртки: `recall` — агентская (бюджет символов, дедуп, свёрнуто), `search` — человеческая (полные поля, фильтры, сортировки) | Разные потребители, одинаковая семантика. Дублировать логику нельзя, дублировать UX — нужно | Один `search` с 15 флагами; два независимых движка |
| D7 | Профили MCP | `agent` 7 тулов / `leader` 11 / `full` 16, бюджет описаний ≤ 1100 токенов на `agent` | Каждый тул — постоянный налог на все сессии. memora с 43 тулами платит его всегда | Один профиль на 25+ тулов; динамическая регистрация «по надобности» (клиенты её плохо тянут) |
| D8 | Гранулярность MCP-тулов | Один вызов закрывает намерение: `myc_ready{claim:true}` сразу выдаёт и берёт; `myc_update` — все переходы состояния | Три round-trip'а на «взять задачу» — это три инференса. Дороже, чем один толстый тул | Тул на каждый CRUD-глагол (`myc_claim`, `myc_assign`, `myc_close`, …) |
| D9 | Формат ответа MCP | Плотный текст в `content` + тот же объект в `structuredContent` | Текст в 2–3× дешевле JSON по токенам; структура — для клиентов, которые умеют | Только JSON; только текст (клиент не может парсить) |
| D10 | Хуки: куда пишем | Свой helper-файл + свой skill-файл; в `CLAUDE.md`/`AGENTS.md` — только блок между маркерами, и только если пользователь согласился | Урок graft: чужой `CLAUDE.md` — территория пользователя. Переписать = сломать доверие один раз навсегда | Записывать инструкции прямо в CLAUDE.md; переписывать `settings.json` целиком |
| D11 | Ключевой хук | `PreCompact` — обязательный, не «приятный бонус» | Компакт — единственный момент, когда контекст гарантированно теряется. Если myc не встаёт туда, он не память, а записная книжка | Только `SessionStart`; только ручной `myc remember` |
| D12 | `post-edit` | Fire-and-forget: помечает якоря «грязными» в очереди и выходит за < 10 мс, ничего не пересчитывает | Хук стоит в горячем пути редактирования; любая работа там умножается на сотни правок за сессию | Синхронная проверка/перепривязка якорей на каждой правке |
| D13 | graft | Внешняя опциональная зависимость через адаптер-процесс, **никогда** в горячем пути | Вызов graft = 50–300 мс. Бюджет `recall` — 25 мс. Арифметика закрывает вопрос | Встроить graft как библиотеку; сделать graft обязательным; переписать код-граф |
| D14 | Связь код↔узел | Свой якорь `repo+path+span+blob_hash+crux_text`; `graft` — только для резолва символов и blast radius | Идея graft «crux как текст, а не номера строк» переживает рефакторинг. Мы держим её у себя и не зависим от чужого индекса | Хранить только `file:line`; хранить ссылку на graft-узел как единственный ключ |
| D15 | LLM chat | Полностью опционален, только фоновые задачи, отдельная конфигурация от эмбеддингов | Требование `$0` из §3. Chat нужен для absorb-классификации и дистилляции — ни то, ни другое не в горячем пути | Обязательный ключ; один общий провайдер для chat и embed |
| D16 | Валидация embed-пары | На старте сверяем `embed_fingerprint` (backend+provider+model+dim+normalize) с записанным в БД; расхождение — отказ писать, а не тихий mixed-space | Смешанные векторные пространства — тихая порча индекса, которую не видно месяцами | `--allow-mixed` по умолчанию; проверка только «размерность совпала» |
| D17 | HTTP-аутентификация | Bearer-токен → actor+роль+список воркспейсов; OIDC — только внешним прокси | Собственный OAuth в MVP — месяц работы и класс уязвимостей | Собственный OAuth/SSO; отсутствие аутентификации в LAN |
| D18 | Мульти-воркспейс | В URL: `/v1/ws/:ws/...`, альтернатива — заголовок `X-Myc-Workspace` (для proxy) | Явный путь кешируется, логируется и разделяется правами без магии | Воркспейс из тела запроса; поддомены |
| D19 | Proxy-режим | **Делаем, но отдельным режимом `myc proxy`, выключенным по умолчанию, вне MVP-ядра** | Единственный способ дать память клиенту, который нельзя настроить; плюс бесплатный сбор outcome-телеметрии для L4. Но это ещё и точка, через которую течёт весь трафик | Не делать вовсе (теряем закрытые клиенты); включить по умолчанию (риск + ломает prompt-кеш) |
| D20 | Инъекция в proxy | Строго **после** статического префикса промпта, отдельным помеченным блоком; бюджет 1500 симв; при превышении 15 мс — пропускаем без памяти | Правка начала промпта убивает prompt caching провайдера — это дороже, чем польза от памяти | Вставлять в начало system; переписывать сообщения пользователя |
| D21 | ACL | Фильтрация **до** ранжирования (в `WHERE`), 4 уровня `private/team/restricted/agent`, дефолт по типу узла | Пост-фильтр течёт: через `total`, через ранги RRF и через «пустой ответ на видимом месте» | Пост-фильтрация; ACL только на уровне воркспейса |
| D22 | L0 по умолчанию | `episode` (сырые транскрипты) — `private`, в общий граф уходят только дистиллированные атомы | Транскрипт содержит чужие пароли, чужой код, чужие мысли. Делиться им по умолчанию — инцидент | `team` по умолчанию для всего |
| D23 | Редакция секретов | Обязательный детектор на записи (паттерны + энтропия), маскирование + `warn` | Хук pre-compact пишет транскрипты; `.myc/` рядом с git. Без детектора это утечка по расписанию | Полагаться на дисциплину пользователя |
| D24 | Веб-стек | Bun-сервер отдаёт `/v1` + вшитые статические ассеты; фронт — ванильный TS + Vite, граф на Canvas2D/WebGL, лэйаут в Web Worker | 10k узлов в SVG/DOM = смерть. Ноль внешних CDN, ноль рантайм-зависимостей в бинаре | React+Cytoscape/vis-network (SVG), серверный рендер PNG, только Mermaid |
| D25 | Mermaid | Только для маленьких подграфов (digest, цепочка supersession, ≤ 40 узлов) | Mermaid отлично читается человеком и агентом, но не масштабируется | Mermaid как основной рендер графа (путь memora) |
| D26 | Real-time | SSE с дельтами и `Last-Event-ID` = seq oplog, батчинг 100 мс | Однонаправленный поток, переживает прокси, тривиально переподключается | WebSocket (лишняя сложность), поллинг |
| D27 | `myc init` | Одна команда, ноль вопросов по умолчанию, сеть не обязательна; тяжёлое (модель эмбеддингов) — в фоне | Онбординг ломается на первом же вопросе и на первом же таймауте сети | Интерактивный визард; блокирующая загрузка модели 23 МБ |
| D28 | Демон | Не обязателен. Очередь задач на диске в SQLite; хвост подхватывает следующий вызов CLI или MCP-процесс; `myc worker` — опция | «Локально без демона» из §2 брифа. Но фоновая работа должна переживать выход процесса | Обязательный демон; фоновая работа только пока жив CLI-процесс |

---

## 2. CLI: грамматика

### 2.1 Форма

```
myc [глобальные] <команда> [подкоманда] [аргументы] [флаги]
```

Глубина — максимум 2 уровня (`myc dep add`, `myc anchor check`). Третьего нет.

**Глобальные флаги** (работают у каждой команды):

| Флаг | Env | Умолчание | Смысл |
|---|---|---|---|
| `--ws <slug>` | `MYC_WS` | по cwd | воркспейс |
| `--db <url>` | `MYC_DB` | `.myc/myc.db` | `sqlite:путь` / `postgres://…` / `http(s)://сервер` |
| `--as <actor>` | `MYC_ACTOR` | `$USER` или id агента | кто действует (в записи и в claim) |
| `--json` | — | off | конверт-объект в stdout |
| `--ndjson` | — | off | поток объектов (для списков) |
| `--budget <n>` | `MYC_BUDGET` | 2000 | бюджет ответа в **символах** (не токенах) |
| `--timeout <ms>` | — | 5000 | жёсткий дедлайн всей команды |
| `--strict` | — | off | деградация → ненулевой код выхода |
| `--offline` | `MYC_OFFLINE=1` | on локально | запрет любой сети |
| `-q` / `-v` | — | — | тише / подробнее (stderr) |
| `--no-color` | `NO_COLOR` | авто | цвет только при TTY |

Цвет, юникод-рамки и прогресс-бары включаются **только** при `isatty(stdout)`.
Пайп, хук и MCP всегда получают голый текст.

### 2.2 Коды выхода

| Код | Имя | Когда |
|---|---|---|
| 0 | `OK` | успех (в т.ч. с `warn`, если нет `--strict`) |
| 1 | `ERR` | внутренняя ошибка, БД, IO |
| 2 | `USAGE` | неизвестный флаг/аргумент, неверный формат |
| 3 | `NOTFOUND` | узел/файл/воркспейс не существует |
| 4 | `CONFLICT` | claim занят, цикл зависимостей, конфликт версии при sync |
| 5 | `PRECOND` | задача заблокирована, якорь протух, схема требует миграции |
| 6 | `DEGRADED` | операция выполнена, но подсистема деградировала (**только с `--strict`**) |
| 7 | `NOWS` | воркспейс не инициализирован |
| 8 | `DENIED` | ACL/токен |
| 9 | `TIMEOUT` | превышен `--timeout` или бюджет ретривала |

Коды 10–63 зарезервированы, 64+ не используем.

### 2.3 Конверт `--json`

```json
{
  "ok": true,
  "cmd": "ready",
  "ws": "myc",
  "ts": "2026-09-03T10:12:04.221Z",
  "data": [ /* … */ ],
  "meta": { "took_ms": 4, "count": 3, "degraded": [], "seq": 91204 },
  "warn": [ { "code": "anchor.stale", "msg": "3 якоря протухли", "n": 3 } ]
}
```

Ошибка:

```json
{
  "ok": false,
  "cmd": "claim",
  "ws": "myc",
  "ts": "2026-09-03T10:12:44.008Z",
  "error": {
    "code": "conflict.claimed",
    "msg": "myc-a3f8 уже взята codex-2 (аренда до 10:42:44Z)",
    "exit": 4,
    "hint": "myc claim myc-a3f8 --steal — после истечения аренды"
  }
}
```

Пространства кодов ошибок: `usage.*`, `notfound.*`, `conflict.*`, `precond.*`,
`degraded.*`, `auth.*`, `ws.*`, `timeout.*`, `internal.*`. Код — часть публичного
контракта, переименованию не подлежит.

### 2.4 Идентификаторы

`<slug>-<hex4>` для корневых узлов, `.<n>` для потомков: `myc-a3f8`, `myc-a3f8.1.2`.
Хеш-часть — от содержимого+времени+актора, поэтому две ветки не конфликтуют при
мерже. Префикс достаточно уникален внутри воркспейса: `myc show a3f8` работает,
пока префикс однозначен, иначе `exit 4` со списком кандидатов. `[cross:L1]`

Один граф — одно пространство ID. Вид узла (`task` / `memory` / `episode` /
`decision` / `document` / `skill` / `message`) — это поле, а не префикс.

---

## 3. CLI: команды

Ниже — **реальный вывод**, а не описание. Примеры сняты в воркспейсе `myc`
(репозиторий `mycelium`, slug `myc`).

### 3.1 `myc init` — создать воркспейс

```
myc init [dir] [--slug <s>] [--db <url>] [--embed local|api|none]
         [--import beads|jsonl:<file>] [--no-wire] [--yes] [--dry-run]
```

См. §11 «Онбординг» — там полный вывод и разбор первых 60 секунд.

### 3.2 `myc prime` — бутстрап контекста сессии

```
myc prime [--budget <chars>] [--role agent|leader|human] [--focus <тема>]
          [--format agent|md|json]
```

Бюджет: **p99 < 30 мс** (§3 брифа). Всё, что не влезает в `--budget`, режется по
приоритету секций: READY > IN PROGRESS > CORE > DECISIONS > NEXT.

```
$ myc prime
myc 0.4.1 · ws=myc sqlite · 4128 узлов · idx ok · 2026-09-03T10:12:04Z

# READY 3 из 11 открытых
myc-a3f8  P0 task  Гибридный поиск: RRF одним SQL-проходом      unblocks 3  ~2h
myc-c1d0  P1 bug   prime падает на пустом воркспейсе            unblocks 0  ~20m
myc-9e44  P1 task  Адаптер graft: детект протухания якорей      unblocks 1  ~1h

# IN PROGRESS 1
myc-b721  P0 task  SQLite-схема узлов и рёбер   @claude-1  38m  аренда 22m

# CORE L3 4
- Сеть в горячем пути запрещена; всё тяжёлое уходит в фон.
- Эмбеддинги локальные (ONNX в процессе), API — опциональный бэкенд.
- graft не переписываем: только адаптер + свои якоря file:line+blob_hash.
- Деградация ретривала обязана быть громкой (см. myc doctor).

# DECISIONS L2 3
2026-09-01 myc-4411  Отказ от Dolt: отдельный движок, +40 МБ бинаря.
2026-08-29 myc-2f90  Иерархические хеш-ID, мерж-безопасные.
2026-08-27 myc-1c05  Векторный поиск живёт внутри SQLite (sqlite-vec).

# NEXT
myc ready --claim        взять верхнюю задачу атомарно
myc recall "<тема>"      факты и решения по теме
myc remember "<факт>"    записать вывод

1284 симв · 6 мс · cache hit
```

Пустой воркспейс — тоже полезный ответ, а не ошибка:

```
$ myc prime
myc 0.4.1 · ws=myc sqlite · 0 узлов · 2026-09-03T10:12:04Z

Воркспейс пуст. Ничего не помню про этот проект.

# NEXT
myc create "<первая задача>" -p P1
myc remember "<что важно знать о проекте>"
myc import --from beads       найдено .beads/ (94 задачи)

62 симв · 2 мс
```

`--format json` — см. схему `myc_prime` в §4.4 (та же структура).

### 3.3 `myc ready` — очередь готового к работе

Задачи со статусом `open`, у которых нет открытых блокеров. Это граф-запрос, а не
фильтр по полю: агент имеет право взять любую строку отсюда без разбора.

```
myc ready [-n <k>] [--kind task|bug|epic] [--priority P0..P3] [--tag <t>]
          [--assignee <a>|--free] [--claim] [--why] [--json]
```

```
$ myc ready -n 5
myc-a3f8  P0 task  Гибридный поиск: RRF одним SQL-проходом      unblocks 3  ~2h  free
myc-c1d0  P1 bug   prime падает на пустом воркспейсе            unblocks 0  ~20m free
myc-9e44  P1 task  Адаптер graft: детект протухания якорей      unblocks 1  ~1h  free
3 ready · 6 blocked · 1 in_progress · 2 мс
```

`--why` объясняет порядок (важно, чтобы агент не спорил с сортировкой):

```
$ myc ready -n 2 --why
myc-a3f8  P0 task  Гибридный поиск: RRF одним SQL-проходом
  score 0.91 = P0(0.40) + unblocks 3(0.27) + свежесть 2d(0.14) + якоря fresh(0.10)
myc-c1d0  P1 bug   prime падает на пустом воркспейсе
  score 0.63 = P1(0.25) + bug(0.15) + свежесть 6h(0.18) + якоря fresh(0.05)
```

`--claim` — атомарно взять верхнюю (одна операция, без гонки между `ready` и `claim`):

```
$ myc ready --claim
claimed myc-a3f8 by claude-1 · аренда 30m до 10:42:04Z
P0 task · Гибридный поиск: RRF одним SQL-проходом
описание
  Одна SQL-выборка с CTE: bm25-ветвь + vec-ветвь, слияние RRF k=60.
  Не тянуть внешний векторный движок.
deps      blocked-by myc-b721 (closed 2026-09-02)
anchors   src/retrieval/fuse.ts:1-88 @a91c3e fresh
          src/db/schema.sql:120-160 @4d2f01 STALE
notes 2   "RRF k=60 по бенчу memora" · "Qdrant не тянем"
recall    myc-1c05 Векторный поиск внутри SQLite · myc-5d31 RRF k=60 recall@10
```

Пусто — это осмысленный ответ, а не ошибка (exit 0):

```
$ myc ready
0 ready · 6 blocked · 1 in_progress
все открытые задачи заблокированы. верхний блокер:
  myc-b721 P0 SQLite-схема узлов и рёбер  @claude-1 (блокирует 4)
```

### 3.4 `myc create` / `myc task` — создать узел

```
myc create <title> [--kind task|bug|epic|memory|decision|document|skill|message]
           [-p P0|P1|P2|P3] [-b <body>|-] [--tag t1,t2] [--parent <id>]
           [--dep <id>[,<id>]] [--anchor <file>[:<a>-<b>]] [--assign <a>]
           [--estimate 2h] [--acl private|team|restricted|agent]
```

Алиасы: `myc task` = `--kind task`, `myc bug` = `--kind bug` (+ `-p P1` по умолчанию),
`myc epic`, `myc msg` (= `--kind message`, для межагентных тредов).

**Бюджет записи p99 < 5 мс** — команда пишет строку и ставит задания в очередь;
эмбеддинг, absorb-классификация, разбор документа выполняются фоном.

```
$ myc task "Адаптер graft: детект протухания якорей" -p P1 \
    --dep myc-b721 --anchor src/anchor/graft.ts --tag graft,anchors
myc-9e44  task P1 open  blocked-by myc-b721
anchor    src/anchor/graft.ts:1-1 @— (файл пуст/не создан, якорь отложен)
embed     queued
3 мс
```

Тело из stdin:

```
$ git log -1 --format=%B | myc bug "Регресс: prime 180 мс на 40k узлов" -b - -p P0
myc-c1d0  bug P0 open  free
body      312 симв из stdin
embed     queued
2 мс
```

### 3.5 `myc claim` — атомарно взять задачу

```
myc claim <id> [--lease <dur>] [--steal] [--as <actor>]
```

Реализация — одна условная запись (`UPDATE … WHERE status='open' AND (lease_until
IS NULL OR lease_until < now())`), число изменённых строк решает исход. Гонка между
агентами невозможна. Аренда по умолчанию **30 минут**, продление — `myc claim <id>`
тем же актором (идемпотентно). `[cross:L1]`

```
$ myc claim myc-9e44
claimed myc-9e44 by claude-1 · аренда 30m до 10:44:12Z
myc-9e44 P1 task open→in_progress
```

```
$ myc claim myc-9e44
error: myc-9e44 уже взята codex-2 в 10:12:44Z (аренда до 10:42:44Z)
hint:  дождаться истечения аренды или myc claim myc-9e44 --steal
exit 4
```

Истёкшая аренда — предупреждение, но не блокировка:

```
$ myc claim myc-9e44 --steal
claimed myc-9e44 by claude-1 (отобрана у codex-2, аренда истекла 18m назад)
WARN предыдущий владелец не закрыл задачу; его правки могут быть в рабочем дереве
```

### 3.6 `myc close` — закрыть

```
myc close <id> [--reason <текст>] [--verify tests|review|human|none]
          [--outcome done|wontfix|duplicate|superseded] [--dup <id>]
          [--cost-in <tok>] [--cost-out <tok>] [--model <id>] [--retries <n>]
```

Флаги `--verify/--cost-*/--model/--retries` — вход для L4 (самообучение роя).
Не обязательны; при вызове через MCP заполняются автоматически. `[cross:L4]`

```
$ myc close myc-a3f8 --reason "RRF одним SQL-проходом, p99 21 мс на 100k" --verify tests
closed myc-a3f8 · in_progress 42m · @claude-1
unblocked myc-b721, myc-9e44   (теперь ready)
episode  l0-8812 записан (3 файла, 1.2k симв)
queue    atoms×2, distill×1
outcome  записан (verify=tests, model=claude-opus-5, in 41k / out 6k)
4 мс
```

### 3.7 `myc dep` — зависимости

```
myc dep add <from> <type> <to>      type: blocks | blocked-by
myc dep rm  <from> <type> <to>
myc dep tree <id> [--depth <n>] [--closed]
myc dep why <id>
```

```
$ myc dep add myc-9e44 blocked-by myc-b721
myc-9e44 blocked-by myc-b721  (myc-9e44 ушла из ready)
```

```
$ myc dep add myc-b721 blocked-by myc-9e44
error: цикл зависимостей: myc-b721 → myc-9e44 → myc-b721
exit 4
```

```
$ myc dep why myc-9e44
myc-9e44 P1 task open — заблокирована 1 открытой зависимостью
└─ myc-b721 P0 task in_progress @claude-1 38m  SQLite-схема узлов и рёбер
   └─ myc-4411 P1 task closed 2026-09-01  Выбор хранилища
критический путь: 1 узел, оценка ~3h
```

```
$ myc dep tree myc-b721 --depth 2
myc-b721 P0 in_progress  SQLite-схема узлов и рёбер
├── blocks myc-9e44 P1 open  Адаптер graft: детект протухания
│   └── blocks myc-7a02 P2 open  myc anchor repair
└── blocks myc-a3f8 P0 open  Гибридный поиск: RRF одним SQL-проходом
3 узла заблокировано этой задачей
```

### 3.8 `myc remember` — записать факт

```
myc remember <текст>|- [--tag t1,t2] [--anchor <file>[:<a>-<b>]]
             [--layer L1|L2|L3] [--acl private|team|restricted|agent]
             [--source <url|file>] [--no-absorb]
```

```
$ myc remember "RRF k=60 даёт лучший recall@10 на нашем корпусе, k=20 теряет 4 п.п." \
    --tag retrieval --anchor src/retrieval/fuse.ts:40-58
myc-5d31  memory L1 · tags retrieval · acl team
anchor    src/retrieval/fuse.ts:40-58 @a91c3e (crux 6 строк сохранён)
queue     embed, absorb
2 мс
```

Без ключа LLM absorb работает на эвристиках, и это **написано в выводе**:

```
queue     embed, absorb(эвристика — chat-LLM выключен)
```

### 3.9 `myc absorb` — записать факт через классификацию

`remember` пишет всегда. `absorb` сначала выясняет, что это за факт относительно
уже известного: `duplicate` / `update` / `contradiction` / `related` / `new`.
Синхронная часть — только векторно-лексический отбор кандидатов (< 20 мс);
классификация LLM — фоном, если ключ есть, иначе порогом.

```
myc absorb <текст>|- [--tag ...] [--anchor ...] [--wait] [--dry-run]
```

```
$ myc absorb "RRF k=20 быстрее на 30% и почти не теряет recall" --tag retrieval
myc-77aa  memory L1 · verdict=contradiction (0.74) ← myc-5d31
  создан узел + ребро contradicts. Ничего не перезаписано.
  разрешить: myc link myc-77aa supersedes myc-5d31 --reason "<почему>"
2 мс (классификация: LLM, 840 мс, фоном — verdict уточнится)
```

```
$ myc absorb "Векторный поиск живёт внутри SQLite" --dry-run
verdict=duplicate (0.97) ← myc-1c05 «Векторный поиск живёт внутри SQLite (sqlite-vec)»
ничего не записано (--dry-run)
```

Без LLM — честно про источник вердикта:

```
verdict=new (эвристика: max cos 0.71 < порог дубля 0.93; chat-LLM выключен)
поле verdict_source=heuristic сохранено в узле
```

### 3.10 `myc recall` — агентский поиск

```
myc recall <запрос> [-n <k>] [--budget <chars>] [--kind ...] [--tag ...]
           [--layer L0..L3] [--since <dur>] [--anchor <file>] [--mode hybrid|vec|bm25]
```

Гибрид (BM25 + вектор, слияние RRF) — **p99 < 25 мс на 100k**. `[cross:L2]`

```
$ myc recall "почему отказались от Dolt" -n 3
0.81 myc-4411 decision L2 2026-09-01  Отказ от Dolt
     Cell-level merge полезен, но это отдельный движок, +40 МБ бинаря и второй
     формат данных. Мерж-безопасность закрываем хеш-ID.
     → myc-2f90 (обосновывает) · ⌖ docs/design/00-brief.md:52-58
0.66 myc-1c05 memory   L1 2026-08-27  Векторный поиск внутри SQLite
     sqlite-vec, dim 384, HNSW не нужен до 500k.
     ⌖ src/db/schema.sql:120-160 @4d2f01 STALE
0.52 myc-0a7d episode  L0 2026-08-26  сессия: выбор хранилища (свёрнуто)
3 из 14 · vec+bm25 rrf(k=60) · 18 мс · 641 симв из 2000
```

Деградация — громко, но работа не останавливается:

```
3 из 14 · bm25 only · 9 мс
WARN degraded.embeddings: модель не загружена (onnx: bge-small-q8 отсутствует).
     Векторная ветвь выключена, качество поиска ниже. → myc doctor
```

С `--strict` та же команда даёт `exit 6`.

### 3.11 `myc search` — человеческий поиск

Тот же движок, другой UX: полные поля, фильтры, сортировки, постраничность.

```
myc search <запрос> [--kind] [--tag] [--author] [--since/--until]
           [--acl] [--sort score|updated|created] [--fields <list>]
           [--limit <n>] [--offset <n>] [--full]
```

```
$ myc search "rrf" --kind memory,decision --since 30d --sort updated --fields id,kind,updated,acl,title
ID        KIND      UPDATED     ACL   TITLE
myc-77aa  memory    2026-09-03  team  RRF k=20 быстрее на 30%
myc-5d31  memory    2026-09-02  team  RRF k=60 даёт лучший recall@10
myc-a3f8  task      2026-09-02  team  Гибридный поиск: RRF одним SQL-проходом
myc-1c05  memory    2026-08-27  team  Векторный поиск внутри SQLite
4 из 4 · 12 мс
```

### 3.12 `myc digest` — пакет по теме

Собирает по теме: факты, открытые действия, противоречия, рёбра, источники.

```
myc digest <тема> [--budget <chars>] [--depth 1|2] [--format md|agent|mermaid|json]
```

```
$ myc digest "ретривал"
# ретривал · 14 узлов · 3 открытых действия · 1 противоречие · 2026-09-03

## Факты
- RRF k=60 даёт лучший recall@10 на нашем корпусе. [myc-5d31 2026-09-02]
- Векторный поиск живёт внутри SQLite (sqlite-vec, dim 384). [myc-1c05 2026-08-27]
- BM25 и вектор сливаются одним SQL с двумя CTE. [myc-a3f8 2026-09-02]

## Открытые действия
myc-a3f8 P0 in_progress @claude-1  Гибридный поиск: RRF одним SQL-проходом
myc-7a02 P2 open  free             Бенч recall@10 на 100k
myc-c1d0 P1 open  free             prime падает на пустом воркспейсе

## Противоречия (1, не разрешено)
myc-77aa «k=20 быстрее на 30%» ↔ myc-5d31 «k=60 лучший recall@10»
  разрешить: myc link <победитель> supersedes <проигравший> --reason "..."

## Источники
src/retrieval/fuse.ts:1-88 @a91c3e · src/db/schema.sql:120-160 @4d2f01 STALE
graft: retrieval/fuse, db/schema

1412 симв · 21 мс
```

`--format mermaid` даёт подграф ≤ 40 узлов для веба и для markdown-отчётов.

### 3.13 `myc link` — рёбра

```
myc link <from> <type> <to> [--reason <текст>] [--weight <0..1>]
myc link rm <from> <type> <to>
myc link ls <id> [--direction in|out|both]
```

Типы рёбер: `blocks`, `blocked-by`, `relates-to`, `duplicates`, `supersedes`,
`contradicts`, `replies-to`, `derived-from`, `part-of`, `anchors`. `[cross:L1]`

```
$ myc link myc-77aa supersedes myc-5d31 --reason "перемерили на 100k, k=20 теряет 4 п.п. recall"
myc-77aa supersedes myc-5d31
myc-5d31 → status=superseded (режим active: убран из выдачи, история сохранена)
противоречие myc-77aa↔myc-5d31 закрыто
```

Режим `full_history` (в `workspace.toml`) оставляет superseded в выдаче с меткой.

### 3.14 `myc show` — раскрыть узел

```
myc show <id>[,<id>…] [--field <name>] [--depth 0|1] [--source] [--json]
```

**p99 < 3 мс** локально. `--source` подтягивает код по якорям (это уже IO — бюджет 15 мс).

```
$ myc show myc-a3f8
myc-a3f8  task P0 in_progress @claude-1  created 2026-08-30  updated 10:12Z  acl team
Гибридный поиск: RRF одним SQL-проходом
────────────────────────────────────────────────────────────────────────
Одна выборка с двумя CTE: bm25-ветвь по fts5 и vec-ветвь по sqlite-vec,
слияние Reciprocal Rank Fusion k=60. Внешний векторный движок не тянем.
────────────────────────────────────────────────────────────────────────
deps      blocked-by myc-b721 (closed) · blocks myc-9e44, myc-c1d0
links     relates-to myc-1c05 · derived-from myc-0a7d
anchors   src/retrieval/fuse.ts:1-88     @a91c3e fresh
          src/db/schema.sql:120-160      @4d2f01 STALE (blob сменился 2026-09-02)
notes     2 · episodes l0-8812 · tags retrieval, sql
lease     до 10:42:04Z (осталось 12m)
```

Батч (один вызов вместо трёх):

```
$ myc show myc-a3f8,myc-b721,myc-9e44 --field title,status,assignee
myc-a3f8  Гибридный поиск: RRF одним SQL-проходом      in_progress  claude-1
myc-b721  SQLite-схема узлов и рёбер                   closed       claude-1
myc-9e44  Адаптер graft: детект протухания якорей      open         —
```

### 3.15 `myc list` — выборка

```
myc list [--kind] [--status] [--priority] [--tag] [--assignee] [--acl]
         [--since/--until] [--sort] [--fields] [-n] [--offset] [--count]
```

```
$ myc list --kind task,bug --status open,in_progress --sort priority -n 20
myc-a3f8  P0 task in_progress @claude-1  Гибридный поиск: RRF одним SQL-проходом
myc-b721  P0 task open        free       Пул соединений Postgres
myc-c1d0  P1 bug  open        free       prime падает на пустом воркспейсе
myc-9e44  P1 task open        free       Адаптер graft: детект протухания якорей
myc-7a02  P2 task open        free       Бенч recall@10 на 100k
5 из 11 · 3 мс
```

```
$ myc list --kind memory --count
2904
```

### 3.16 `myc anchor` — связь с кодом

```
myc anchor add <id> <file>[:<a>-<b>] | --symbol <sym> [--repo <name>]
myc anchor rm  <id> <file>[:<a>-<b>]
myc anchor check [--path <glob>] [--json]
myc anchor repair [--apply] [--threshold 0.85]
myc anchor of <file>[:<line>] | --symbol <sym>
myc anchor touch <file>…            # пометить грязными (хук post-edit)
```

Якорь: `repo + path + span + blob_hash + crux_text + crux_hash`. `crux_text` — до
8 строк содержимого; именно он позволяет перепривязаться после рефакторинга
(идея graft, перенесённая на наши якоря — решение D14 в §1).

```
$ myc anchor check
128 якорей · fresh 124 · stale 3 · orphan 1
myc-a3f8  src/db/schema.sql:120-160   @4d2f01→@8e11ba  crux найден :134-176 (0.94)  → repair
myc-9e44  src/api/serve.ts:10-40      @1b7d22→@c04e18  crux не найден (0.31)        → review
myc-7a02  src/retrieval/bm25.ts:5-30  @9f0a11→@9f0a11  сдвиг ±0 строк, blob тот же  → ok
myc-5d31  src/old/fuse.ts:40-58       файл удалён                                   → orphan
exit 0 (с --strict: 6)
```

```
$ myc anchor repair --apply
repaired 1 · reviewed 0 · orphaned 1
myc-a3f8  src/db/schema.sql:120-160 → :134-176 (crux 0.94, blob @8e11ba)
myc-9e44  оставлен как есть (0.31 < 0.85) — нужен человек
myc-5d31  переведён в orphan, узел помечен needs_anchor
```

Обратная связь код→узел (та самая «в обе стороны»):

```
$ myc anchor of src/retrieval/fuse.ts:44
src/retrieval/fuse.ts:40-58
  myc-5d31  memory  RRF k=60 даёт лучший recall@10
  myc-a3f8  task P0 Гибридный поиск: RRF одним SQL-проходом (in_progress)
src/retrieval/fuse.ts:1-88
  myc-a3f8  task P0 (родительский спан)
2 узла · 1 мс
```

```
$ myc anchor of --symbol fuseRRF
через graft: src/retrieval/fuse.ts:40-58 (fuseRRF)
  myc-5d31, myc-a3f8
+ вызывающие (graft callers, глубина 1): src/api/search.ts:88, src/mcp/recall.ts:34
  узлов myc на вызывающих: myc-c1d0
```

### 3.17 `myc sync` — обмен с сервером/командой

```
myc sync [--push-only|--pull-only] [--since <seq>] [--dry-run]
         [--on-conflict newer|mine|theirs|fork]
```

```
$ myc sync
push 14 op · pull 9 op · conflicts 0 · 240 мс
priors обновлены: routing, 1247 наблюдений, 6 классов задач
seq 91204 → 91227
```

```
$ myc sync
push 14 · pull 9 · conflicts 2 · 310 мс
CONFLICT myc-5d31 body: локальная rev 7 (10:02Z) ↔ удалённая rev 7 (10:04Z)
CONFLICT myc-a3f8 status: in_progress@claude-1 ↔ closed@alice
разрешено политикой newer: обе удалённые версии приняты, локальные сохранены как
  myc-5d31.f1, myc-a3f8.f1 (fork)
exit 4 (с --on-conflict newer: 0)
```

### 3.18 `myc serve` — HTTP-сервер

```
myc serve [--port 7777] [--host 127.0.0.1] [--db <url>] [--ws all|<slug>,…]
          [--auth token|none] [--cors <origin>] [--read-only] [--metrics]
```

```
$ myc serve --port 7777 --db postgres://myc@db/myc --ws all
myc serve 0.4.1 · postgres myc@db/myc pool 10 · schema v7
воркспейсы: myc, orca, cherry-mobile (3)
auth: token (4 активных, 1 истекает через 3d)
слушаю http://127.0.0.1:7777
  /v1/health /v1/health/db /v1/health/index /metrics
  SSE /v1/ws/:ws/events (лимит 50/ws)
готов за 84 мс
```

### 3.19 `myc mcp` — MCP-сервер (stdio)

```
myc mcp [--profile agent|leader|full] [--ws <slug>] [--read-only] [--budget <n>]
```

```
$ myc mcp --profile agent
# stderr:
myc mcp 0.4.1 · profile=agent · 7 тулов · ws=myc sqlite · read-write
описания тулов: 1043 токена
прогрев: prime-кеш готов, onnx загружен (118 мс), готов за 141 мс
```

### 3.20 `myc viz` — веб-визуализация

```
myc viz [--port 7788] [--open] [--read-only] [--share --ttl 24h] [--ws <slug>]
```

```
$ myc viz --open
myc viz 0.4.1 · ws=myc · 4128 узлов / 9013 рёбер
лэйаут: кеш rev 91204 актуален (пересчёт не нужен)
http://127.0.0.1:7788/  (открыт в браузере)
SSE подключён · read-write (вы owner)
```

### 3.21 `myc doctor` — диагностика

Единственное место, где вся деградация собрана вместе. Это контрмера ловушке
memora — состояние индекса нельзя не заметить.

```
$ myc doctor
myc 0.4.1 · bun 1.2.19 · darwin-arm64 · /Users/e/src/mycelium

workspace   slug=myc  db=sqlite .myc/myc.db  18.4 МБ  wal  schema v7 (актуальна)
nodes       4128  task 311 / memory 2904 / episode 812 / decision 101
edges       9013  (blocks 402, relates-to 5110, supersedes 88, anchors 3413)
embeddings  4102/4128 · 26 в очереди · bge-small-en-v1.5-q8 onnx dim=384 · 4.1 мс/шт
            fingerprint 7c2a19… совпадает с записанным в БД  OK
index       fts5 OK · vec OK (sqlite-vec 0.1.7) · optimize 2026-09-02 · 3.1 МБ
anchors     3413 · fresh 3409 · stale 3 · orphan 1
graft       OK 0.9.2 · граф свежий · 42 запроса за сессию, кеш-хит 71%
llm.chat    ВЫКЛЮЧЕН (нет ключа) → absorb на эвристиках, дистилляция L1→L2 стоит
llm.embed   local-onnx OK
queue       26 pending / 0 failed / worker: подхват при следующем вызове
hooks       claude-code: session-start 12m назад, pre-compact 2 раза, post-edit 148
            opencode: не вызывался ни разу за 7d  ← проверь плагин
server      не настроен
proxy       выключен

FAIL 0 · WARN 3
WARN anchor.stale       3 якоря протухли          → myc anchor repair
WARN llm.chat.disabled  absorb/дистилляция урезаны → myc config set llm.chat.api_key_env
WARN hooks.silent       opencode-плагин не срабатывал 7d → myc wire --agents opencode --check
exit 0   (с --strict: 6)
```

`myc doctor --probe` дополнительно делает по одному дешёвому реальному вызову к
chat-провайдеру и к серверу (единственное место, где сеть допустима явно).
`myc doctor --fix` выполняет безопасные починки (`anchor repair`, `index optimize`,
`queue drain`), опасные — только печатает.

### 3.22 `myc export` / `myc import`

```
myc export [--format jsonl|md|mermaid] [--kind ...] [--since ...] [--acl ...]
           [--out <path>] [--redact on|off]
myc import <file>|- [--from myc|beads|jsonl] [--on-conflict skip|newer|fork]
           [--dry-run]
```

```
$ myc export --format jsonl --since 2026-08-01 --out backup.jsonl
2841 узлов · 6210 рёбер · 812 эпизодов пропущено (acl=private, --acl не задан)
redact: 3 совпадения замаскированы (2 токена, 1 приватный ключ)
backup.jsonl 14.2 МБ · 1.9 s
```

```
$ myc export --format md --out docs/memory/
docs/memory/decisions.md   101 решение
docs/memory/facts.md      2904 факта, сгруппированы по тегам
docs/memory/tasks.md       311 задач
docs/memory/INDEX.md
человекочитаемый снимок, в git можно коммитить
```

```
$ myc import --from beads .beads/issues.jsonl --dry-run
94 задачи · 141 ребро
маппинг: bd priority 0-3 → P0-P3 · bd blocks/blocked-by → как есть
         bd type message → kind=message · bd assignee → assignee
конфликты 0 · новых ID 94 (bd-a3f8 → myc-a3f8, хеш сохранён)
ничего не записано (--dry-run)
```

### 3.23 `myc prune` — сжатие и уборка

Semantic decay из beads + бюджеты retrieval из TencentDB: старое не удаляем,
а сжимаем, и только то, что уже дистиллировано.

```
myc prune [--apply] [--closed-older <dur>] [--episodes-older <dur>]
          [--unreferenced] [--vacuum]
```

```
$ myc prune
кандидаты (ничего не изменено, применить: myc prune --apply):
  812 закрытых задач старше 30d      → 41 саммари   экономия ~186k симв
  340 эпизодов L0 старше 14d,
      уже дистиллированных в L1      → архив .myc/archive/2026-08.jsonl.zst
   74 memory без ссылок, score<0.1,
      старше 90d                     → удаление
   26 эпизодов L0 БЕЗ дистилляции    → НЕ трогаем (нет ключа LLM, дистилляция не шла)
vacuum освободит ~4.1 МБ
```

Правило безопасности: `prune` **никогда** не удаляет то, что не было
дистиллировано, — иначе выключенный LLM превращает уборку в потерю данных.

### 3.24 Служебное

```
myc status                  # однострочник для statusline
myc config get|set|list     # .myc/workspace.toml и .myc/local.toml
myc ws create|ls|join|use    # воркспейсы (§9)
myc token create|ls|revoke  # токены сервера (§8)
myc wire|unwire             # интеграция с агентами (§6)
myc route <id>              # рекомендация модели  [cross:L4]
myc worker [--once]         # явный прогон фоновой очереди
myc reindex [--embed|--fts] # перестроить индексы
myc version                 # версия + схема + фингерпринт эмбеддингов
```

```
$ myc status
myc:3r/1p/6b · idx ok · q26 · ⚠2
```
(3 ready / 1 in progress / 6 blocked · индекс ок · 26 в очереди · 2 предупреждения)

---

## 4. MCP-поверхность

### 4.1 Принцип: один вызов = одно намерение

Каждый MCP-вызов у агента стоит: описание тула в системном промпте (постоянно),
вход, выход, и — главное — **один инференс на решение вызвать**. Поэтому:

- **Никаких CRUD-тулов.** `myc_update` покрывает claim/close/reopen/assign/
  priority/comment одним входом с полем `op`.
- **Композитные ответы.** `myc_ready{claim:true}` возвращает задачу *и* берёт её
  *и* прикладывает якоря, зависимости и три релевантных факта — чтобы следующий
  шаг агента был «работать», а не «спросить ещё три раза».
- **Бюджет описаний.** Профиль `agent` — не больше **1100 токенов** суммарных
  описаний тулов. Новый тул в профиль добавляется только вместе с удалением
  другого или письменным обоснованием (проверяется тестом
  `mcp.profile.agent.description_tokens <= 1100`).
- **Ответ — плотный текст + `structuredContent`.** Текстовый блок повторяет
  человеческий CLI-вывод (он в 2–3 раза дешевле эквивалентного JSON);
  `structuredContent` содержит тот же объект по `outputSchema` для клиентов,
  которые умеют структуру. Клиенты, которые не умеют, платят только за текст.

### 4.2 Профили

| Тул | agent (7) | leader (11) | full (16) | Почему в этом профиле |
|---|:---:|:---:|:---:|---|
| `myc_prime` | ✓ | ✓ | ✓ | без него агент не знает, где он |
| `myc_ready` | ✓ | ✓ | ✓ | получить и взять работу |
| `myc_update` | ✓ | ✓ | ✓ | все переходы состояния |
| `myc_recall` | ✓ | ✓ | ✓ | вспомнить факт |
| `myc_remember` | ✓ | ✓ | ✓ | записать вывод (внутри — absorb) |
| `myc_show` | ✓ | ✓ | ✓ | раскрыть узел/батч узлов |
| `myc_link` | ✓ | ✓ | ✓ | связать (в т.ч. зависимости) |
| `myc_digest` | | ✓ | ✓ | сборка темы — операция координатора, не исполнителя |
| `myc_anchor` | | ✓ | ✓ | исполнителю якоря ставит хук; ведущий чинит вручную |
| `myc_route` | | ✓ | ✓ | ведущий раздаёт работу и выбирает модель `[cross:L4]` |
| `myc_stats` | | ✓ | ✓ | телеметрия роя — для решений, не для работы |
| `myc_workspace` | | | ✓ | переключение/создание воркспейсов |
| `myc_health` | | | ✓ | doctor через MCP |
| `myc_sync` | | | ✓ | обмен с сервером |
| `myc_admin` | | | ✓ | prune / reindex / import / export |
| `myc_search` | | | ✓ | расширенный поиск с фильтрами (у агента его роль играет `myc_recall`) |

Логика раскладки: **исполнитель** должен уметь ровно четыре вещи — понять
контекст, взять работу, вспомнить, записать. Всё остальное у него — соблазн
потратить инференс. **Ведущий** дополнительно синтезирует (`digest`), чинит
(`anchor`), распределяет (`route`) и меряет (`stats`). **full** — человек и
администрирование.

Профиль задаётся при запуске (`myc mcp --profile agent`) и может быть сужен
токеном сервера: токен с ролью `agent` не получит `full`, даже если попросит.

### 4.3 Общие правила ввода/вывода

Все тулы принимают опциональные `ws` (строка) и `budget` (целое, символы).
Все возвращают в `structuredContent` поля `meta.took_ms`, `meta.degraded[]`,
`meta.seq`. Все ошибки — `isError: true` + текст вида
`myc: <code>: <msg>\nhint: <hint>` (те же коды, что в CLI, §2.3).

`read_only`-режим отклоняет мутирующие тулы кодом `auth.readonly` до валидации
входа.

### 4.4 `myc_prime`

```json
{
  "name": "myc_prime",
  "title": "Стартовый пакет проекта",
  "description": "Что происходит в этом проекте прямо сейчас: очередь готовых задач, что в работе, ядро принятых решений, свежие решения. Вызывай ОДИН раз в начале сессии и ещё раз сразу после сжатия контекста. Заменяет чтение планов, README и истории задач.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "budget":  { "type": "integer", "default": 2000, "minimum": 200, "maximum": 8000,
                   "description": "бюджет ответа в символах" },
      "role":    { "type": "string", "enum": ["agent", "leader", "human"], "default": "agent" },
      "focus":   { "type": "string", "description": "тема, файл или id — подстроить выборку под неё" },
      "ws":      { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["ws", "ts", "ready", "in_progress", "core", "decisions", "counts", "meta"],
    "properties": {
      "ws": { "type": "string" },
      "ts": { "type": "string", "format": "date-time" },
      "ready":       { "type": "array", "items": { "$ref": "#/$defs/taskbrief" } },
      "in_progress": { "type": "array", "items": { "$ref": "#/$defs/taskbrief" } },
      "core": {
        "type": "array",
        "description": "слой L3 — константы проекта, которые не пересматриваются",
        "items": { "type": "object", "required": ["id", "text"],
                   "properties": { "id": {"type":"string"}, "text": {"type":"string"} } }
      },
      "decisions": {
        "type": "array",
        "description": "слой L2 — недавние решения с датой и источником",
        "items": { "type": "object", "required": ["id", "date", "text"],
                   "properties": { "id": {"type":"string"}, "date": {"type":"string","format":"date"},
                                   "text": {"type":"string"}, "supersedes": {"type":"array","items":{"type":"string"}} } }
      },
      "counts": {
        "type": "object",
        "properties": { "nodes": {"type":"integer"}, "open": {"type":"integer"},
                        "ready": {"type":"integer"}, "blocked": {"type":"integer"},
                        "in_progress": {"type":"integer"} }
      },
      "meta": { "$ref": "#/$defs/meta" }
    },
    "$defs": {
      "taskbrief": {
        "type": "object",
        "required": ["id", "kind", "priority", "status", "title"],
        "properties": {
          "id":        { "type": "string" },
          "kind":      { "type": "string", "enum": ["task","bug","epic","message"] },
          "priority":  { "type": "string", "enum": ["P0","P1","P2","P3"] },
          "status":    { "type": "string", "enum": ["open","in_progress","blocked","closed"] },
          "title":     { "type": "string" },
          "assignee":  { "type": ["string","null"] },
          "unblocks":  { "type": "integer", "description": "сколько задач разблокирует закрытие" },
          "estimate":  { "type": ["string","null"], "description": "ISO-8601 duration или h/m" },
          "lease_until": { "type": ["string","null"], "format": "date-time" }
        }
      },
      "meta": {
        "type": "object",
        "required": ["took_ms", "degraded"],
        "properties": {
          "took_ms":  { "type": "number" },
          "seq":      { "type": "integer", "description": "позиция oplog на момент ответа" },
          "chars":    { "type": "integer" },
          "degraded": { "type": "array", "items": { "type": "string" },
                        "description": "коды деградации: embeddings.off, llm.chat.off, graft.missing, index.rebuilding" }
        }
      }
    }
  }
}
```

Текстовый блок ответа — ровно вывод `myc prime` из §3.2.

### 4.5 `myc_ready`

```json
{
  "name": "myc_ready",
  "title": "Взять следующую работу",
  "description": "Задачи без открытых блокеров — то, за что можно браться прямо сейчас. С claim=true атомарно берёт верхнюю (или указанную в id) и сразу отдаёт её описание, зависимости, якоря в коде и релевантные факты — этого достаточно, чтобы начать работать без дополнительных вызовов.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "n":        { "type": "integer", "default": 5, "minimum": 1, "maximum": 50 },
      "claim":    { "type": "boolean", "default": false,
                    "description": "атомарно взять верхнюю задачу и вернуть её полный контекст" },
      "id":       { "type": "string", "description": "взять конкретную задачу вместо верхней (только с claim=true)" },
      "kind":     { "type": "array", "items": { "type": "string", "enum": ["task","bug","epic","message"] } },
      "priority": { "type": "array", "items": { "type": "string", "enum": ["P0","P1","P2","P3"] } },
      "tag":      { "type": "array", "items": { "type": "string" } },
      "lease_minutes": { "type": "integer", "default": 30, "minimum": 5, "maximum": 480 },
      "why":      { "type": "boolean", "default": false, "description": "объяснить порядок сортировки" },
      "ws":       { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["ready", "counts", "meta"],
    "properties": {
      "ready":   { "type": "array", "items": { "$ref": "#/$defs/taskbrief" } },
      "claimed": {
        "type": ["object", "null"],
        "description": "присутствует только при claim=true и успешном захвате",
        "required": ["id", "title", "lease_until"],
        "properties": {
          "id": {"type":"string"}, "kind": {"type":"string"}, "priority": {"type":"string"},
          "title": {"type":"string"}, "body": {"type":"string"},
          "lease_until": {"type":"string","format":"date-time"},
          "deps": { "type": "array", "items": {
            "type": "object",
            "properties": { "id":{"type":"string"}, "type":{"type":"string"},
                            "status":{"type":"string"}, "title":{"type":"string"} } } },
          "anchors": { "type": "array", "items": { "$ref": "#/$defs/anchor" } },
          "notes":   { "type": "array", "items": {"type":"string"} },
          "recall":  { "type": "array", "description": "3 самых релевантных факта из памяти",
                       "items": { "type":"object",
                         "properties": { "id":{"type":"string"}, "score":{"type":"number"},
                                         "text":{"type":"string"} } } }
        }
      },
      "counts": { "type": "object",
        "properties": { "ready":{"type":"integer"}, "blocked":{"type":"integer"},
                        "in_progress":{"type":"integer"} } },
      "top_blocker": { "type": ["object","null"],
        "description": "если ready пуст — что именно всех держит",
        "properties": { "id":{"type":"string"}, "title":{"type":"string"},
                        "assignee":{"type":["string","null"]}, "blocks_n":{"type":"integer"} } },
      "meta": { "$ref": "#/$defs/meta" }
    },
    "$defs": {
      "anchor": {
        "type": "object",
        "required": ["path", "start", "end", "state"],
        "properties": {
          "repo":  { "type": "string" },
          "path":  { "type": "string" },
          "start": { "type": "integer" }, "end": { "type": "integer" },
          "blob":  { "type": "string", "description": "первые 6 hex blob_hash" },
          "symbol":{ "type": ["string","null"] },
          "state": { "type": "string", "enum": ["fresh","stale","orphan","pending"] }
        }
      }
    }
  }
}
```

**Ошибка гонки** возвращается не как исключение, а как полезный ответ:
`isError: true`, код `conflict.claimed`, и в `structuredContent.ready` — следующая
свободная задача. Агент может взять её же следующим вызовом, не переспрашивая.

### 4.6 `myc_update`

Один тул на все переходы. Без него их было бы шесть.

```json
{
  "name": "myc_update",
  "title": "Изменить задачу",
  "description": "Все изменения состояния задачи: взять (claim), закрыть (close), переоткрыть, переназначить, сменить приоритет, добавить заметку, продлить аренду. При close укажи reason — он попадает в память проекта и будет виден следующим сессиям.",
  "inputSchema": {
    "type": "object",
    "required": ["id", "op"],
    "properties": {
      "id": { "type": "string" },
      "op": { "type": "string",
              "enum": ["claim","release","close","reopen","assign","priority","note","extend"] },
      "reason":   { "type": "string", "description": "обязателен для close и reopen" },
      "outcome":  { "type": "string", "enum": ["done","wontfix","duplicate","superseded"], "default": "done" },
      "duplicate_of": { "type": "string" },
      "assignee": { "type": "string" },
      "priority": { "type": "string", "enum": ["P0","P1","P2","P3"] },
      "note":     { "type": "string" },
      "lease_minutes": { "type": "integer", "minimum": 5, "maximum": 480 },
      "steal":    { "type": "boolean", "default": false, "description": "отобрать истёкшую аренду" },
      "verify":   { "type": "string", "enum": ["tests","review","human","none"], "default": "none",
                    "description": "чем подтверждён результат — вход для статистики роя" },
      "cost":     { "type": "object", "description": "заполняется хостом автоматически",
                    "properties": { "tokens_in": {"type":"integer"}, "tokens_out": {"type":"integer"},
                                    "model": {"type":"string"}, "retries": {"type":"integer"} } },
      "ws": { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["id", "status", "meta"],
    "properties": {
      "id":       { "type": "string" },
      "status":   { "type": "string" },
      "previous": { "type": "string" },
      "assignee": { "type": ["string","null"] },
      "lease_until": { "type": ["string","null"], "format": "date-time" },
      "unblocked":   { "type": "array", "items": {"type":"string"},
                       "description": "задачи, ставшие ready после этой операции" },
      "episode_id":  { "type": ["string","null"] },
      "queued":      { "type": "array", "items": {"type":"string"},
                       "description": "фоновые задания: embed, absorb, distill, outcome" },
      "meta": { "$ref": "#/$defs/meta" }
    }
  }
}
```

### 4.7 `myc_recall`

```json
{
  "name": "myc_recall",
  "title": "Вспомнить",
  "description": "Гибридный поиск по памяти проекта: факты, решения, задачи, эпизоды прошлых сессий, привязки к коду. Спрашивай своими словами. Ответ ограничен бюджетом символов и уже отсортирован — читай сверху вниз и останавливайся. Если ответ помечен degraded, часть индекса не работает и качество ниже обычного.",
  "inputSchema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query":  { "type": "string", "minLength": 2 },
      "n":      { "type": "integer", "default": 6, "minimum": 1, "maximum": 50 },
      "budget": { "type": "integer", "default": 2000, "minimum": 200, "maximum": 8000 },
      "kind":   { "type": "array", "items": { "type": "string",
                  "enum": ["task","bug","epic","memory","decision","episode","document","skill","message"] } },
      "layer":  { "type": "array", "items": { "type": "string", "enum": ["L0","L1","L2","L3"] },
                  "description": "по умолчанию L1-L3; L0 (сырые сессии) добавляй только если ищешь «что мы тогда делали»" },
      "tag":    { "type": "array", "items": { "type": "string" } },
      "since":  { "type": "string", "description": "ISO-дата или относительно: 7d, 3w, 2mo" },
      "anchor": { "type": "string", "description": "путь к файлу — сузить до узлов, привязанных к нему" },
      "mode":   { "type": "string", "enum": ["hybrid","vec","bm25"], "default": "hybrid" },
      "ws":     { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["hits", "total", "meta"],
    "properties": {
      "hits": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["id", "kind", "layer", "score", "text"],
          "properties": {
            "id":     { "type": "string" },
            "kind":   { "type": "string" },
            "layer":  { "type": "string", "enum": ["L0","L1","L2","L3"] },
            "score":  { "type": "number", "minimum": 0, "maximum": 1 },
            "date":   { "type": "string", "format": "date" },
            "title":  { "type": "string" },
            "text":   { "type": "string", "description": "обрезано по бюджету" },
            "truncated": { "type": "boolean" },
            "anchors":   { "type": "array", "items": { "$ref": "#/$defs/anchor" } },
            "edges":     { "type": "array", "items": { "type": "object",
                            "properties": { "type": {"type":"string"}, "id": {"type":"string"} } } },
            "superseded_by": { "type": ["string","null"] }
          }
        }
      },
      "total": { "type": "integer", "description": "сколько всего подошло до обрезки по n и бюджету" },
      "meta": {
        "allOf": [ { "$ref": "#/$defs/meta" } ],
        "properties": {
          "mode_used": { "type": "string", "enum": ["hybrid","vec","bm25"] },
          "fusion":    { "type": "string", "description": "например rrf(k=60)" },
          "chars":     { "type": "integer" },
          "budget":    { "type": "integer" }
        }
      }
    }
  }
}
```

Ключевая деталь контракта: если векторная ветвь недоступна, `mode_used` = `bm25`,
`meta.degraded` содержит `embeddings.off`, и **текстовый блок начинается со строки
`WARN`**. Агент видит деградацию, а не думает, что искал гибридом. `[cross:L2]`

### 4.8 `myc_remember`

```json
{
  "name": "myc_remember",
  "title": "Запомнить",
  "description": "Записать вывод, решение или факт в память проекта, чтобы следующие сессии его знали. Пиши одно утверждение за раз, конкретно, со своей причиной. Новый факт автоматически сверяется с уже известным: дубликат не создаст шума, противоречие будет помечено, а не затрёт старое. Не записывай сюда сырой код и секреты.",
  "inputSchema": {
    "type": "object",
    "required": ["text"],
    "properties": {
      "text":   { "type": "string", "minLength": 8, "maxLength": 8000 },
      "kind":   { "type": "string", "enum": ["memory","decision","document","skill"], "default": "memory" },
      "tag":    { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
      "anchor": { "type": "array", "items": { "type": "string" },
                  "description": "привязки к коду: путь или путь:начало-конец" },
      "layer":  { "type": "string", "enum": ["L1","L2","L3"], "default": "L1",
                  "description": "L1 — факт; L2 — решение или сценарий; L3 — константа проекта (только с явного согласия человека)" },
      "acl":    { "type": "string", "enum": ["private","team","restricted","agent"], "default": "team" },
      "source": { "type": "string", "description": "url, путь к файлу, id задачи" },
      "absorb": { "type": "boolean", "default": true,
                  "description": "false — записать как есть, без сверки с известным" },
      "ws": { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["id", "verdict", "meta"],
    "properties": {
      "id":      { "type": "string" },
      "verdict": { "type": "string", "enum": ["new","duplicate","update","contradiction","related"] },
      "verdict_source": { "type": "string", "enum": ["llm","heuristic","skipped"],
                          "description": "heuristic означает, что chat-LLM выключен" },
      "verdict_confidence": { "type": "number" },
      "related":   { "type": "array", "items": { "type": "object",
                      "properties": { "id":{"type":"string"}, "relation":{"type":"string"},
                                      "title":{"type":"string"} } } },
      "written":   { "type": "boolean", "description": "false при verdict=duplicate — узел не создан" },
      "redacted":  { "type": "integer", "description": "сколько фрагментов замаскировано детектором секретов" },
      "queued":    { "type": "array", "items": {"type":"string"} },
      "meta": { "$ref": "#/$defs/meta" }
    }
  }
}
```

### 4.9 `myc_show`

```json
{
  "name": "myc_show",
  "title": "Раскрыть узлы",
  "description": "Полное содержимое одного или нескольких узлов сразу: тело, зависимости, связи, привязки к коду, заметки. Передавай список id одним вызовом, а не по одному.",
  "inputSchema": {
    "type": "object",
    "required": ["ids"],
    "properties": {
      "ids":    { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 20 },
      "depth":  { "type": "integer", "enum": [0, 1], "default": 0,
                  "description": "1 — включить заголовки соседей по рёбрам" },
      "source": { "type": "boolean", "default": false,
                  "description": "подтянуть код по свежим якорям" },
      "fields": { "type": "array", "items": { "type": "string" },
                  "description": "ограничить набор полей — экономит токены" },
      "budget": { "type": "integer", "default": 4000 },
      "ws": { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["nodes", "meta"],
    "properties": {
      "nodes": { "type": "array", "items": {
        "type": "object",
        "required": ["id", "kind", "title"],
        "properties": {
          "id": {"type":"string"}, "kind": {"type":"string"}, "layer": {"type":"string"},
          "title": {"type":"string"}, "body": {"type":"string"},
          "status": {"type":["string","null"]}, "priority": {"type":["string","null"]},
          "assignee": {"type":["string","null"]}, "acl": {"type":"string"},
          "created": {"type":"string","format":"date-time"},
          "updated": {"type":"string","format":"date-time"},
          "tags": {"type":"array","items":{"type":"string"}},
          "edges": {"type":"array","items":{"type":"object",
            "properties": { "type":{"type":"string"}, "dir":{"type":"string","enum":["in","out"]},
                            "id":{"type":"string"}, "title":{"type":"string"},
                            "status":{"type":["string","null"]} }}},
          "anchors": {"type":"array","items":{"$ref":"#/$defs/anchor"}},
          "source":  {"type":"array","items":{"type":"object",
            "properties": { "path":{"type":"string"}, "start":{"type":"integer"},
                            "end":{"type":"integer"}, "code":{"type":"string"} }}},
          "notes":   {"type":"array","items":{"type":"string"}},
          "superseded_by": {"type":["string","null"]},
          "supersedes":    {"type":"array","items":{"type":"string"}}
        }
      }},
      "missing": { "type": "array", "items": {"type":"string"},
                   "description": "id, которых нет — не ошибка, просто список" },
      "ambiguous": { "type": "array", "items": { "type": "object",
                     "properties": { "prefix": {"type":"string"},
                                     "candidates": {"type":"array","items":{"type":"string"}} } } },
      "meta": { "$ref": "#/$defs/meta" }
    }
  }
}
```

### 4.10 `myc_link`

Зависимости — частный случай ребра, отдельного тула для них нет.

```json
{
  "name": "myc_link",
  "title": "Связать узлы",
  "description": "Создать или удалить связь между двумя узлами: зависимость (blocks/blocked-by), «относится к», «дубликат», «заменяет», «противоречит», «получено из», «часть». Для supersedes обязательно укажи reason — история не переписывается, старый узел остаётся с пометкой.",
  "inputSchema": {
    "type": "object",
    "required": ["from", "type", "to"],
    "properties": {
      "from": { "type": "string" },
      "to":   { "type": "string" },
      "type": { "type": "string",
                "enum": ["blocks","blocked-by","relates-to","duplicates","supersedes",
                         "contradicts","replies-to","derived-from","part-of"] },
      "reason": { "type": "string", "description": "обязателен для supersedes и duplicates" },
      "weight": { "type": "number", "minimum": 0, "maximum": 1, "default": 1 },
      "remove": { "type": "boolean", "default": false },
      "ws": { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["ok", "meta"],
    "properties": {
      "ok": { "type": "boolean" },
      "edge": { "type": "object",
        "properties": { "from":{"type":"string"}, "type":{"type":"string"}, "to":{"type":"string"} } },
      "effects": { "type": "array", "items": {"type":"string"},
        "description": "например: myc-5d31 → superseded; myc-9e44 вышла из ready" },
      "cycle": { "type": ["array","null"], "items": {"type":"string"},
        "description": "при conflict.cycle — сам цикл, чтобы агент не гадал" },
      "meta": { "$ref": "#/$defs/meta" }
    }
  }
}
```

### 4.11 `myc_digest` (leader+)

```json
{
  "name": "myc_digest",
  "title": "Пакет по теме",
  "description": "Собрать по теме всё сразу: факты, открытые действия, неразрешённые противоречия, связи и источники в коде. Используй перед тем, как планировать работу по области, вместо серии отдельных поисков.",
  "inputSchema": {
    "type": "object",
    "required": ["topic"],
    "properties": {
      "topic":  { "type": "string" },
      "budget": { "type": "integer", "default": 3000, "minimum": 500, "maximum": 16000 },
      "depth":  { "type": "integer", "enum": [1, 2], "default": 1,
                  "description": "2 — включить соседей второго порядка (дороже)" },
      "include_closed": { "type": "boolean", "default": false },
      "format": { "type": "string", "enum": ["agent","md","mermaid"], "default": "agent" },
      "ws": { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["topic", "facts", "actions", "contradictions", "sources", "meta"],
    "properties": {
      "topic": { "type": "string" },
      "facts": { "type": "array", "items": { "type": "object",
        "properties": { "id":{"type":"string"}, "date":{"type":"string"},
                        "text":{"type":"string"}, "layer":{"type":"string"} } } },
      "actions": { "type": "array", "items": { "$ref": "#/$defs/taskbrief" } },
      "contradictions": { "type": "array", "items": { "type": "object",
        "properties": { "a":{"type":"string"}, "b":{"type":"string"},
                        "summary":{"type":"string"}, "resolved":{"type":"boolean"} } } },
      "sources": { "type": "array", "items": { "$ref": "#/$defs/anchor" } },
      "mermaid": { "type": ["string","null"], "description": "только при format=mermaid, ≤40 узлов" },
      "node_count": { "type": "integer" },
      "meta": { "$ref": "#/$defs/meta" }
    }
  }
}
```

### 4.12 `myc_anchor` (leader+)

```json
{
  "name": "myc_anchor",
  "title": "Связь памяти с кодом",
  "description": "Привязать узел к участку кода, проверить, не устарели ли привязки, починить их после рефакторинга, или узнать в обратную сторону — какие задачи и факты относятся к этому файлу или символу. Спроси 'of' по файлу, который собираешься менять, прежде чем менять его.",
  "inputSchema": {
    "type": "object",
    "required": ["op"],
    "properties": {
      "op":     { "type": "string", "enum": ["add","remove","check","repair","of"] },
      "id":     { "type": "string", "description": "узел — для add/remove" },
      "path":   { "type": "string", "description": "путь к файлу; для of допустим path:line" },
      "start":  { "type": "integer" },
      "end":    { "type": "integer" },
      "symbol": { "type": "string", "description": "вместо path/start/end — резолвится через graft" },
      "apply":  { "type": "boolean", "default": false, "description": "для repair: реально применить" },
      "threshold": { "type": "number", "default": 0.85, "minimum": 0.5, "maximum": 1,
                     "description": "порог совпадения crux при перепривязке" },
      "ws": { "type": "string" }
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["op", "meta"],
    "properties": {
      "op": { "type": "string" },
      "anchors": { "type": "array", "items": { "$ref": "#/$defs/anchor" } },
      "nodes":   { "type": "array", "description": "для op=of — узлы, привязанные к этому месту",
                   "items": { "type": "object",
                     "properties": { "id":{"type":"string"}, "kind":{"type":"string"},
                                     "title":{"type":"string"}, "status":{"type":["string","null"]} } } },
      "stale":   { "type": "integer" }, "orphan": { "type": "integer" },
      "repaired":{ "type": "integer" }, "needs_review": { "type": "integer" },
      "graft":   { "type": ["object","null"],
                   "properties": { "available": {"type":"boolean"},
                                   "callers": {"type":"array","items":{"type":"string"}},
                                   "cache": {"type":"string","enum":["hit","miss","skipped"]} } },
      "meta": { "$ref": "#/$defs/meta" }
    }
  }
}
```

### 4.13 Остальные тулы (сокращённо)

| Тул | Вход | Выход |
|---|---|---|
| `myc_route` | `{task_id?, description?, class?, size?, langs?[]}` | `{model, effort, expected_cost_usd, expected_p_success, confidence, observations_n, alternatives[]}` `[cross:L4]` |
| `myc_stats` | `{group_by: "model"\|"class"\|"actor", since?, ws?}` | `{rows[]{key, n, success_rate, median_cost_usd, median_minutes, retry_rate}, meta}` |
| `myc_workspace` | `{op: "list"\|"use"\|"create", slug?, db?}` | `{workspaces[]{slug, db, nodes, role, degraded[]}, current}` |
| `myc_health` | `{probe?: bool}` | тот же объект, что `myc doctor --json` |
| `myc_sync` | `{direction?, since_seq?, on_conflict?}` | `{pushed, pulled, conflicts[], seq}` |
| `myc_admin` | `{op: "prune"\|"reindex"\|"import"\|"export", …}` | `{op, dry_run, affected, report}` |
| `myc_search` | как `myc search` из §3.11 | как `myc_recall`, но с полными полями и `offset` |

### 4.14 Бюджет и прогрев MCP-процесса

MCP-сервер — долгоживущий процесс, поэтому холодный старт платится один раз:

| Этап | Стоимость | Когда |
|---|---|---|
| bun-рантайм + модули | 22 мс | при запуске |
| открыть SQLite + WAL | 2 мс | при запуске |
| загрузить onnx-модель эмбеддингов | 118 мс | **лениво**, при первом `recall` (или в фоне через 200 мс после старта) |
| собрать `prime_cache` | 14 мс | в фоне сразу после старта |
| детект graft | 40 мс | в фоне, результат кешируется на 24 ч |

Итог: `myc_prime` на прогретом процессе — **< 5 мс**, `myc_recall` — 12–22 мс,
`myc_show` — < 2 мс.

---

## 5. Абстракция LLM-провайдеров

### 5.1 Зачем myc вообще LLM

Ни одна из этих задач не стоит в горячем пути — все асинхронные, все отменяемые,
все имеют детерминированную замену.

| Задача | Что делает LLM | Замена без ключа | Что теряем |
|---|---|---|---|
| absorb-классификация | решает `duplicate/update/contradiction/related/new` для факта в серой зоне | пороги по косинусу: ≥ 0.93 дубль, ≤ 0.55 new, между — `related` | противоречия не находятся автоматически; больше «related»-шума |
| суммаризация L0 → L1 | из транскрипта сессии вытаскивает атомарные факты | эвристика: реплики после `myc close`/`myc remember` + diff-заголовки становятся атомами | атомов меньше и они грубее |
| дистилляция L1 → L2 | сворачивает группу фактов в сценарий/решение | не выполняется; L2 наполняется только вручную (`myc remember --layer L2`) | prime показывает больше сырых фактов и меньше выводов |
| дистилляция L2 → L3 | выделяет константы проекта | **никогда не автоматическая**, только явное `myc remember --layer L3` человеком | ничего (это и есть желаемое поведение) |
| decay-саммари при `prune` | сжимает 20 закрытых задач в один абзац | `prune` не сжимает такие группы, только архивирует | база растёт быстрее |
| авто-заголовок и теги | придумывает title для узла без заголовка | первые 60 символов + теги по совпадению со словарём тегов воркспейса | косметика |

Правило: **если задача может понадобиться синхронно — она не идёт в LLM.**

### 5.2 Конфигурация: chat и embeddings раздельно

`.myc/workspace.toml` (в git, общее) и `.myc/local.toml` (в `.gitignore`, личное).
Ключи живут **только** в `local.toml` или в env — валидация запрещает
`api_key` в командном файле.

```toml
# .myc/workspace.toml — общее для команды
[llm.chat]
enabled      = true
provider     = "anthropic"          # openai | anthropic
base_url     = "https://api.anthropic.com"
model        = "claude-haiku-4-5-20251001"
api_key_env  = "ANTHROPIC_API_KEY"  # имя переменной, не значение
timeout_ms   = 20000
max_retries  = 2
concurrency  = 2
max_input_chars  = 24000
daily_budget_usd = 1.00

[llm.embed]
backend   = "local"                 # local | api
model     = "bge-small-en-v1.5-q8"
dim       = 384
normalize = true
batch     = 32

# при backend = "api":
# provider    = "openai"
# base_url    = "https://api.openai.com/v1"
# model       = "text-embedding-3-small"
# dim         = 1536
# api_key_env = "OPENAI_API_KEY"
```

Два независимых блока — потому что типичная конфигурация «локальные эмбеддинги +
облачный chat» и обратная («корпоративный embeddings-эндпоинт + никакого chat»)
обе законны, а один общий `provider` их не выражает.

### 5.3 Интерфейс провайдера

```ts
interface ChatProvider {
  readonly wire: "openai" | "anthropic";
  readonly model: string;
  // Один не-стриминговый вызов. Без tools, без стрима — myc не ведёт диалог.
  complete(req: {
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;      // 0 для классификации, 0.3 для саммари
    jsonSchema?: object;      // structured output, если провайдер умеет
    signal: AbortSignal;      // отменяемость обязательна (§4 брифа, TencentDB)
  }): Promise<{ text: string; usage: { in: number; out: number }; ms: number }>;
}

interface EmbedProvider {
  readonly id: string;        // "local:bge-small-en-v1.5-q8" | "openai:text-embedding-3-small"
  readonly dim: number;
  readonly normalize: boolean;
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>;
}
```

Две реализации wire-формата, ничего больше:

- **openai**: `POST {base_url}/chat/completions`, `Authorization: Bearer`.
  Совместимые: LiteLLM, vLLM, Ollama (`/v1`), Together, OpenRouter, Groq, Azure.
- **anthropic**: `POST {base_url}/v1/messages`, `x-api-key` + `anthropic-version`.

Никаких SDK — два `fetch`-адаптера по ~120 строк. SDK тянут зависимости,
привязывают к версиям и увеличивают холодный старт бинаря.

### 5.4 Валидация пары на старте

Главная защищаемая инвариантa: **все векторы в одной таблице живут в одном
пространстве**. Проверка дешёвая и локальная — сеть не нужна.

```
embed_fingerprint = sha1( backend | provider | model | dim | normalize | tokenizer_rev )
```

Псевдокод бутстрапа (выполняется при каждом старте процесса, ~0.2 мс):

```
fp_cfg  = fingerprint(config.llm.embed)
fp_db   = meta.get("embed_fingerprint")        # NULL на пустой базе

if fp_db == NULL:
    if vectors_count == 0: meta.set("embed_fingerprint", fp_cfg)   # первая запись
    else:                  FAIL "precond.embed_unknown"            # база из другой версии

elif fp_db != fp_cfg:
    detail = diff(fp_db, fp_cfg)                # что именно поменялось
    if flags.allow_mixed:  WARN degraded.embed_mixed  # только с явным флагом
    else:                  FAIL "precond.embed_mismatch"

# chat НЕ проверяем сетью на старте — сеть в горячем пути запрещена.
# Валидация chat ленивая: первый реальный фоновый вызов; явная — myc doctor --probe.
```

Вывод при расхождении:

```
$ myc recall "rrf"
error: precond.embed_mismatch — конфигурация эмбеддингов не совпадает с базой
  в базе:      local:bge-small-en-v1.5-q8 dim=384 norm=on   (4102 вектора)
  в конфиге:   openai:text-embedding-3-small dim=1536 norm=on
  смешивать пространства нельзя — поиск даст мусор.
варианты:
  myc reindex --embed            перестроить 4102 вектора (~7 мин локально, $0)
  myc config set llm.embed …     вернуть прежнюю модель
  --allow-mixed                  осознанно смешать (не рекомендуется, всегда WARN)
exit 5
```

Отдельно проверяется **доступность локальной модели**: файл ONNX на месте,
sha256 совпадает, размерность выхода равна `dim`. Проверка — при первой загрузке,
результат кешируется в `.myc/state.json` вместе с mtime файла.

### 5.5 Таймауты, ретраи, автомат защиты

| Параметр | Значение | Обоснование |
|---|---|---|
| Таймаут одного chat-запроса | 20 000 мс | фон, спешить некуда, но висеть вечно нельзя |
| Таймаут embed-API-запроса | 8 000 мс | батч из 32, ожидаемо < 1 с |
| Ретраи | 2 (итого 3 попытки) | больше — только удлиняет очередь |
| Бэкофф | `250 мс × 2^n + jitter(0..250)`, потолок 4 000 мс | 250 / 750 / 1750 мс |
| Что ретраим | 429, 500–599, сетевые ошибки, таймаут | 4xx (кроме 429) — не ретраим никогда |
| `Retry-After` | уважаем, если ≤ 60 с; иначе открываем автомат | защита от «поспим 15 минут» в очереди |
| Автомат защиты | 5 неудач подряд → `open` на 60 с → `half-open`, один пробный запрос | не долбим упавшего провайдера сотней задач |
| Параллелизм | `concurrency` (умолч. 2) на воркспейс, глобальная очередь FIFO | предсказуемый расход и rate-limit |
| Дневной бюджет | `daily_budget_usd` (умолч. 1.00); при исчерпании — `degraded.llm.budget` | защита от фонового разорения |
| Отмена | каждый job несёт `AbortSignal`; выход процесса, `myc worker --stop`, изменение конфигурации отменяют текущие | требование §4 брифа: дистилляция обязана быть отменяемой |

Неуспевший job **не теряется**: возвращается в очередь с `attempts+1` и
`next_at = now + backoff`. После 3 неудач — `state=failed`, виден в `myc doctor`
(`queue 26 pending / 3 failed`) и в `myc doctor --fix` перезапускается.

### 5.6 Деградация без ключа — громкая по трём каналам

1. **В выводе команды**: `absorb` печатает `verdict_source=heuristic`,
   `remember` — `absorb(эвристика — chat-LLM выключен)`.
2. **В `myc doctor`**: строка `llm.chat ВЫКЛЮЧЕН … → absorb на эвристиках,
   дистилляция L1→L2 стоит`, и `WARN llm.chat.disabled`.
3. **В самих данных**: узел хранит `verdict_source`, `distilled_by`
   (`llm:model` | `heuristic` | `null`). Это ключевой пункт: даже если пользователь
   никогда не смотрел в `doctor`, отличить факты, прошедшие классификацию, от
   пропущенных, можно запросом. Ловушка memora («выглядит здоровой») закрывается
   не UI-предупреждением, а полем в строке.

Плюс `myc prime` дописывает одну строку в конец, если есть деградация:

```
⚠ llm.chat off · 26 фактов ждут классификации · myc doctor
```

---

## 6. Интеграция с агентами: хуки

### 6.1 Модель событий

myc реагирует на четыре момента жизни агентской сессии. Пятый (`UserPromptSubmit`)
поддержан, но **выключен по умолчанию**.

| Событие | Команда | Таймаут | Блокирует агента | Что делает |
|---|---|---|---|---|
| session-start | `myc prime --budget 2000 --format agent` | 3000 мс | да (это его смысл) | впрыскивает очередь + ядро решений в начало контекста |
| **pre-compact** | `myc absorb-session --stdin-transcript --reason compact --budget 1200` | 8000 мс | да | **сохраняет эпизод в L0, поднимает атомы L1 и возвращает спасательный пакет** |
| post-edit | `myc anchor touch <file>` | 1500 мс | нет (fire-and-forget) | помечает якоря файла грязными, ставит job в очередь |
| stop / session-end | `myc close-session --stdin-transcript` | 2000 мс | нет | закрывает эпизод, ставит дистилляцию, пишет outcome для L4 |
| user-prompt (опция) | `myc recall "<prompt>" --budget 600 --quiet-empty` | 1200 мс | да | авто-подмешивание памяти к каждому запросу |

Почему `user-prompt` выключен: он платит латентностью и токенами **на каждом**
сообщении, а попадает в цель редко. Включается явно:
`myc wire --enable-auto-recall`.

### 6.2 `pre-compact` — самый важный хук

Компакт — единственный момент, когда контекст гарантированно теряется. Если myc
туда не встаёт, он не память проекта, а записная книжка.

Что делает `myc absorb-session --reason compact`:

```
1. Читает транскрипт (путь из payload хука или stdin).           ~ 3 мс на 200 КБ
2. Прогоняет детектор секретов, маскирует совпадения.            ~ 8 мс
3. Пишет СЫРОЙ эпизод как файл .myc/episodes/<id>.jsonl.zst
   + строку в таблице узлов (kind=episode, layer=L0, acl=private). ~ 6 мс
4. Дешёвая эвристическая экстракция атомов БЕЗ LLM:              ~ 12 мс
     - все вызовы myc remember/close/link из транскрипта (они уже атомы);
     - заголовки диффов и имена изменённых файлов → кандидаты якорей;
     - строки вида "решили|выбрали|отказались|потому что" → кандидаты L2.
   Кандидаты пишутся со statе=pending_review, в выдачу не попадают,
   пока их не подтвердит LLM-дистилляция или человек.
5. Ставит job distill(episode_id) в очередь (выполнится фоном).
6. Собирает СПАСАТЕЛЬНЫЙ ПАКЕТ (≤ 1200 симв) и печатает его.     ~ 9 мс
                                                          итого ≈ 38 мс
```

Спасательный пакет — то, что переживёт компакт:

```
$ myc absorb-session --reason compact
# myc: контекст сжимается — вот что нельзя потерять
эпизод l0-8814 сохранён (78 КБ, 3 секрета замаскированы)

АКТИВНО   myc-a3f8 P0 Гибридный поиск: RRF одним SQL-проходом @claude-1 аренда 12m
ФАЙЛЫ     src/retrieval/fuse.ts (правлен 6×) · src/db/schema.sql (2×)
РЕШЕНО    k=60 оставляем · vec-ветвь через sqlite-vec · Qdrant не тянем
ОТКРЫТО   бенч на 100k не прогнан · myc-c1d0 всё ещё падает на пустой базе
ДАЛЬШЕ    myc show myc-a3f8 · myc recall "rrf бенч"
1104 симв · 41 мс
```

Формат вывода для Claude Code (структурированный, чтобы попал именно в контекст):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreCompact",
    "additionalContext": "# myc: контекст сжимается — вот что нельзя потерять\n…"
  }
}
```

Если хост не поддерживает `additionalContext` для этого события — деградируем до
обычного stdout (его хосты показывают в транскрипте, чего достаточно). Флаг
`myc wire --hook-output json|text` управляет формой; `myc doctor --hooks`
показывает, дошёл ли пакет.

**Что делаем при `--reason` = `auto` vs `manual`**: одинаково. Разница только в
том, что при `manual` пакет чуть больше (2000 симв) — человек нажал кнопку
сознательно и готов подождать.

### 6.3 `post-edit` — дешёвый до неприличия

Хук вызывается после каждой правки файла. За сессию это сотни вызовов, поэтому
он не имеет права ничего считать.

```
myc anchor touch src/retrieval/fuse.ts
```

```
1. Открыть SQLite (WAL, уже прогрет ОС).                       0.4 мс
2. INSERT OR IGNORE в dirty_paths(ws, path, seen_at).          0.3 мс
3. Выйти.                                                       —
                                                         итого < 2 мс
```

Ни `stat` содержимого, ни хеша, ни graft — всё это делает фоновый воркер,
разгребая `dirty_paths` пачками с дебаунсом **2000 мс** (заимствовано у
socraticode) и коалесцируя повторы по пути.

Если процесс воркера не запущен, очередь разгребёт следующий MCP-вызов или
следующая CLI-команда, у которой есть бюджет (`prime`, `ready`, `doctor`) —
не более **50 мс** за раз, чтобы не съесть чужой бюджет.

### 6.4 Claude Code

**Что myc пишет и куда** (`myc wire --agents claude`):

| Файл | Действие | Существующий файл |
|---|---|---|
| `.claude/skills/myc/SKILL.md` | создаётся целиком | наш файл, перезаписываем |
| `.claude/helpers/myc-hooks.mjs` | создаётся целиком | наш файл, перезаписываем |
| `.claude/settings.json` | **точечный merge только своих узлов** | `.bak` + merge, конфликт → вопрос |
| `.mcp.json` | добавляется `mcpServers.myc` | merge |
| `CLAUDE.md` | **не трогаем** | — |
| `AGENTS.md` | блок между маркерами, только с `--agents-md` | вставка/замена блока |

`.claude/settings.json` после `myc wire` (показан только добавленный фрагмент —
всё остальное сохранено как было):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ {
          "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs\" session-start",
          "timeout": 3000
      } ] }
    ],
    "PreCompact": [
      { "matcher": "manual|auto",
        "hooks": [ {
          "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs\" pre-compact",
          "timeout": 8000
      } ] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [ {
          "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs\" post-edit",
          "timeout": 1500
      } ] }
    ],
    "Stop": [
      { "hooks": [ {
          "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs\" stop",
          "timeout": 2000
      } ] }
    ]
  },
  "permissions": { "allow": [ "Bash(myc:*)" ] }
}
```

`statusLine` **не трогаем по умолчанию** (у пользователя может быть свой —
именно так делает graft, и это правильно). `myc wire --statusline` добавит его
явно; если чужой уже есть — откажемся и предложим `myc status` вставить вручную.

`.claude/helpers/myc-hooks.mjs` — тонкая обёртка, которая:
1. находит бинарь `myc` (PATH → `./node_modules/.bin` → `~/.myc/bin` → выход 0);
2. читает payload хука из stdin, достаёт `transcript_path`/`tool_input.file_path`;
3. запускает `myc` с жёстким таймаутом на **500 мс меньше** хукового;
4. **при любой ошибке молча выходит с кодом 0** — myc никогда не ломает сессию.

```js
#!/usr/bin/env node
// .claude/helpers/myc-hooks.mjs — генерируется `myc wire`, правки перезапишутся
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EV = process.argv[2];
const DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LIMIT = { "session-start": 2500, "pre-compact": 7500, "post-edit": 1000, "stop": 1500 }[EV] ?? 2000;

function bin() {
  for (const p of [join(DIR, "node_modules/.bin/myc"), join(process.env.HOME ?? "", ".myc/bin/myc")])
    if (existsSync(p)) return p;
  return "myc"; // PATH
}

let payload = {};
try { payload = JSON.parse(require("node:fs").readFileSync(0, "utf8") || "{}"); } catch {}

const args = {
  "session-start": ["prime", "--budget", "2000", "--format", "agent"],
  "pre-compact":   ["absorb-session", "--reason", payload.trigger ?? "auto",
                    "--transcript", payload.transcript_path ?? "-", "--budget", "1200",
                    "--hook-output", "json"],
  "post-edit":     ["anchor", "touch", payload?.tool_input?.file_path ?? ""],
  "stop":          ["close-session", "--transcript", payload.transcript_path ?? "-"],
}[EV];

if (!args || (EV === "post-edit" && !args[2])) process.exit(0);

const r = spawnSync(bin(), args, { cwd: DIR, timeout: LIMIT, encoding: "utf8",
                                   env: { ...process.env, MYC_HOOK: EV } });
if (r.status === 0 && r.stdout) process.stdout.write(r.stdout);
process.exit(0); // myc никогда не валит сессию агента
```

`.claude/skills/myc/SKILL.md` — **вся** инструкция для агента живёт здесь, а не в
`CLAUDE.md`. Скилл загружается по требованию и не облагает налогом каждую сессию:

```markdown
---
name: myc
description: Память, задачи и связи проекта. Используй, когда нужно узнать
  состояние проекта, взять следующую задачу, вспомнить прошлое решение, записать
  вывод или понять, какие задачи связаны с файлом, который ты правишь.
---

# myc

Один граф: задачи с зависимостями, память проекта, привязки к коду.

## Порядок работы
1. `myc prime` — что происходит (хук делает это сам в начале сессии).
2. `myc ready --claim` — взять работу атомарно.
3. `myc recall "<вопрос>"` — прежде чем изобретать: возможно, это уже решали.
4. `myc anchor of <файл>` — прежде чем менять файл: какие задачи и факты на нём.
5. `myc remember "<вывод>"` — после каждого нетривиального вывода.
6. `myc close <id> --reason "<что и почему>"` — закрывая, объясни.

## Правила
- Один факт = один `remember`. Не пиши абзацы.
- Не записывай код и секреты — записывай выводы.
- Противоречие не затирает старое: `myc link A supersedes B --reason "..."`.
- Строка `WARN degraded.*` в ответе означает, что часть индекса не работает,
  и поиск неполон — не считай пустой ответ доказательством отсутствия.
```

### 6.5 Codex

Поверхность хуков у Codex тоньше — есть MCP-серверы и `notify`-программа.
Соответственно:

`~/.codex/config.toml` (только с `--global`, по умолчанию **не трогаем**) или
`<repo>/.codex/config.toml`:

```toml
[mcp_servers.myc]
command = "myc"
args    = ["mcp", "--profile", "agent"]
startup_timeout_sec = 10

# notify вызывается на события сессии; myc сам разбирает тип из JSON-аргумента
notify = ["node", ".codex/myc-notify.mjs"]
```

`.codex/myc-notify.mjs` — тот же паттерн, что helper для Claude Code:
разбирает событие, дергает `myc close-session` / `myc absorb-session`, всегда
выходит с 0. Если у установленной версии Codex нет события компакта — используем
периодический `close-session --incremental` по `notify`-событию завершения хода;
это хуже, чем настоящий pre-compact, и `myc doctor` про это честно пишет:

```
hooks  codex: notify ok (14 событий), pre-compact НЕДОСТУПЕН в этой версии
       → эпизоды пишутся по завершении хода, часть контекста может теряться
```

`AGENTS.md` — блок между маркерами, идемпотентно, только если пользователь
согласился (`myc wire --agents-md`):

```markdown
<!-- myc:start -->
## myc — память и задачи проекта

Инструменты `myc_*` (MCP) или CLI `myc`. Порядок: `myc prime` → `myc ready --claim`
→ `myc recall` перед решением → `myc remember` после вывода → `myc close --reason`.
Полная инструкция: `myc --help`, `.claude/skills/myc/SKILL.md`.
<!-- myc:end -->
```

### 6.6 opencode

У opencode есть и MCP, и плагины с событиями — доступны обе половины.

`opencode.json` (merge, существующие серверы сохраняются):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "myc": {
      "type": "local",
      "command": ["myc", "mcp", "--profile", "agent"],
      "enabled": true
    }
  }
}
```

`.opencode/plugin/myc.ts` — наш файл целиком:

```ts
// .opencode/plugin/myc.ts — генерируется `myc wire`, правки перезапишутся
import { $ } from "bun";

const run = async (args: string[], ms: number) => {
  try {
    const p = Bun.spawn(["myc", ...args], { stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => p.kill(), ms);
    const out = await new Response(p.stdout).text();
    clearTimeout(t);
    return out;
  } catch { return ""; }        // myc никогда не ломает сессию
};

export const MycPlugin = async ({ project, client }) => ({
  event: async ({ event }) => {
    if (event.type === "session.start")
      client.session.appendContext(await run(["prime", "--budget", "2000", "--format", "agent"], 2500));
    if (event.type === "session.compacted" || event.type === "session.compacting")
      client.session.appendContext(await run(["absorb-session", "--reason", "compact", "--budget", "1200"], 7500));
    if (event.type === "session.idle" || event.type === "session.end")
      await run(["close-session"], 1500);
  },
  "tool.execute.after": async ({ tool, args }) => {
    if (["write", "edit", "patch"].includes(tool) && args?.filePath)
      await run(["anchor", "touch", args.filePath], 1000);
  },
});
```

Если у установленной версии opencode нет события компакта — работает та же
деградация, что у Codex, и она видна в `myc doctor`.

### 6.7 Правила невмешательства

Это не косметика. Один испорченный `CLAUDE.md` — и инструмент удаляют.

1. **`CLAUDE.md` / `AGENTS.md` не трогаем без явного согласия.** По умолчанию
   `myc wire` пишет только свои файлы. Флаг `--agents-md` включает вставку блока
   между `<!-- myc:start -->` / `<!-- myc:end -->` — идемпотентно, только своё,
   остальное байт-в-байт сохраняется. Файла нет — создаём минимальный, только с
   нашим блоком.
2. **JSON-конфиги — merge, а не запись.** Читаем, добавляем свои узлы, пишем
   обратно с сохранением порядка ключей и отступов. Перед записью — `.bak`
   рядом (`settings.json.myc.bak`), одна копия, перезаписывается.
3. **Конфликт — вопрос, а не молчаливая победа.** Если в `settings.json` уже есть
   хук `PreCompact` с другой командой, myc не добавляет свой молча:
   ```
   $ myc wire --agents claude
   ! .claude/settings.json уже содержит PreCompact-хук:
       node .claude/helpers/other-tool.cjs pre-compact
     myc не будет его трогать. Варианты:
       --hook-mode append   добавить myc-хук вторым в тот же массив (рекомендую)
       --hook-mode replace  заменить (будет .bak)
       --hook-mode skip     не ставить pre-compact (myc потеряет контекст при сжатии)
   ничего не записано
   ```
4. **`statusLine` не занимаем** — у пользователя может быть свой.
5. **`--dry-run` печатает каждый файл и точный diff.**
6. **`myc unwire` снимает всё, что поставил**, по журналу `.myc/wire.json`
   (список файлов, вставленных узлов и хеш каждого на момент записи). Если файл
   изменён после нас — не удаляем узел, а сообщаем.
7. **Никаких записей за пределы репозитория** без `--global`.
8. **Нулевой ущерб при отсутствии myc**: helper-файлы работают и когда бинаря нет
   (выходят с 0).

```
$ myc wire --agents claude,opencode --dry-run
записал бы:
  new    .claude/skills/myc/SKILL.md                      1.4 КБ
  new    .claude/helpers/myc-hooks.mjs                    1.9 КБ
  merge  .claude/settings.json      +4 узла (hooks.SessionStart, PreCompact,
                                    PostToolUse[Write|Edit|MultiEdit], Stop)
                                    +1 permission Bash(myc:*)   .bak будет создан
  merge  .mcp.json                  +mcpServers.myc
  new    .opencode/plugin/myc.ts                          1.1 КБ
  merge  opencode.json              +mcp.myc
  new    .myc/wire.json             журнал для myc unwire
не тронул бы: CLAUDE.md, AGENTS.md (нужен --agents-md), .claude/settings.json:statusLine
ничего не записано (--dry-run)
```

Проверка, что хуки живые, — часть `doctor` (счётчики последнего срабатывания
пишет сам myc при каждом вызове хука):

```
$ myc doctor --hooks
claude-code   session-start 12m назад · pre-compact 2 · post-edit 148 · stop 3   OK
opencode      ни одного вызова за 7d                                             WARN
              плагин на месте (.opencode/plugin/myc.ts), но события не приходят.
              проверь: opencode --version ≥ 0.4, opencode.json:plugin включён
codex         notify 14 · pre-compact недоступен в этой версии                   WARN
```

---

## 7. Адаптер graft

### 7.1 Что мы у graft берём и чего не берём

graft — **опциональная внешняя зависимость**. myc обязан полностью работать без
неё; с ней работает лучше. Всё, что graft делает хорошо (tree-sitter-разбор,
граф вызовов, свежесть по content-hash), мы не повторяем. Всё, что нам нужно
всегда (якорь `path+span+blob_hash+crux_text`), мы храним у себя.

| Вызов graft | Зачем myc | Когда | Стоимость |
|---|---|---|---|
| `graft ask "<q>" --json -n 5 [--in <scope>]` | обогатить `digest`/`recall` кодовым контекстом по теме | **фон**, job `enrich(node_id)` | 80–300 мс |
| `graft grep "<literal>" --json` | найти все места символа при постановке якоря и при `anchor repair` | по требованию (`anchor add --symbol`, `repair`) | 40–120 мс |
| `graft skeleton <file> --json` | API-поверхность файла при создании задачи «по файлу» | по требованию (`create --anchor <file>`) | 30–80 мс |
| `graft callers <sym> --json [--depth N]` | blast radius: какие ещё узлы myc заденет изменение | по требованию (`anchor of --symbol`, `close --blast`) | 50–200 мс |
| `graft map --json` | первичное наполнение L2-карты репозитория при `myc init` | один раз при init | 200–800 мс |
| `graft check --json` | понять, что граф протух, прежде чем верить его ответам | перед любым фоновым `ask`, кеш 60 с | 5–20 мс |
| MCP-тулы `graft_*` | **не вызываем** | — | — |

**Правило горячего пути (D13).** `myc recall`, `myc prime`, `myc show`,
`myc ready` **никогда** не вызывают graft. Бюджет `recall` — 25 мс, минимальный
вызов graft — 40 мс. Арифметика закрывает вопрос. В горячем пути мы читаем уже
материализованные результаты из таблицы `graft_cache`.

**Правило неудвоения MCP.** Если хост уже подключил graft как MCP-сервер (а это
типично — см. `.mcp.json` этого репозитория), myc **не проксирует** graft-тулы:
агент платил бы за два комплекта описаний. Вместо этого `myc_anchor` возвращает в
`graft.available: true` и в текстовом блоке подсказку вида
`код по этому символу: graft_find_code("fuseRRF")`. Один источник истины на
поверхности агента.

### 7.2 Слой адаптера

```ts
interface GraftAdapter {
  readonly state: "ok" | "missing" | "incompatible" | "stale";
  readonly version: string | null;      // "0.9.2"
  readonly graphRev: string | null;     // см. §7.3

  ask(q: string, o?: {limit?: number; in?: string; source?: boolean}): Promise<GraftHit[]>;
  grep(pattern: string, o?: {in?: string}): Promise<GraftHit[]>;
  skeleton(file: string): Promise<GraftSymbol[]>;
  callers(symbol: string, o?: {direction?: "in"|"out"; depth?: number|"all"}): Promise<GraftEdge[]>;
  map(): Promise<GraftCluster[]>;
}

type GraftHit = {
  node: string;          // "retrieval/fuse"
  path: string;          // "src/retrieval/fuse.ts"
  start: number; end: number;
  symbol?: string;       // "fuseRRF"
  crux?: string;         // ≤ 8 строк текста
  score: number;
};
```

Реализация — `spawn` процесса с `--json`, жёсткий таймаут **1500 мс**,
`AbortSignal`, stderr в лог. Никакого импорта graft как библиотеки: мажорная
версия чужого пакета не должна ломать наш бинарь.

Совместимость по мажору: поддерживаем `>=0.9 <2`. Другая версия → `state =
"incompatible"`, все вызовы возвращают пусто, `doctor` пишет причину.

### 7.3 Кеш

Ключ и инвалидация — самая содержательная часть адаптера.

```
graph_rev = sha1(
    git_head_commit                      // HEAD репозитория
  + dirty_set_hash                       // sha1 отсортированного списка (path, mtime_ns, size)
                                         //   по файлам из `git status --porcelain`
  + graft_index_stamp                    // mtime_ns + size файла graft/INDEX.md
)

cache_key = sha1( subcommand + "\0" + normalized_args + "\0" + graph_rev )
```

Почему так: `graph_rev` меняется ровно тогда, когда ответ graft может измениться —
при коммите, при правке рабочего дерева, при перестройке графа. Правка файла,
которого запрос не касается, тоже сбрасывает кеш; это дешевле, чем вести точный
учёт зависимостей, и происходит редко в фоновом сценарии.

| Уровень | Параметр |
|---|---|
| L1, в памяти | LRU **512** записей, TTL **600 с**, потолок значения 256 КБ |
| L2, на диске | `.myc/cache/graft/<key[0:2]>/<key>.json.zst`, потолок **64 МБ**, вытеснение LRU по `atime`, чистка при `myc prune` |
| `graph_rev` | пересчитывается не чаще раза в **1000 мс** (мемоизация), `git status` — один вызов |
| Негативный кеш | `state=missing` кешируется в `.myc/state.json` на **24 ч**, чтобы не спавнить `graft --version` при каждом запуске |

Наблюдаемость: `myc doctor` печатает `graft OK 0.9.2 · граф свежий · 42 запроса
за сессию, кеш-хит 71%`. Низкий хит-рейт — признак, что `graph_rev` дёргается
слишком часто (обычно из-за генерируемых файлов, не попавших в `.gitignore`).

### 7.4 Если graft не установлен

Детект: `graft --version` с таймаутом **800 мс**, один раз, результат в
`.myc/state.json` вместе с `PATH`-хешем (смена PATH сбрасывает кеш детекта).

Деградация — по функциям, не «всё или ничего»:

| Функция | С graft | Без graft |
|---|---|---|
| Якорь по `file:line` | ✓ | ✓ (полный паритет) |
| Якорь по символу (`--symbol`) | точно, через `grep`/`skeleton` | эвристика: regex `\b<sym>\b` по индексированным файлам + выбор наибольшего блока; при неоднозначности — список кандидатов и `exit 4` |
| Детект протухания | наш `blob_hash` (graft не нужен) | ✓ |
| `anchor repair` | наш `crux_text` + fuzzy (graft не нужен) | ✓ |
| blast radius (`callers`) | точный граф вызовов | **недоступно**, честно сообщаем |
| Обогащение digest кодом | `graft ask` | берём только собственные якоря темы |
| Карта репозитория при init | `graft map` → L2-узлы | пропускаем, предлагаем `graft init` |

```
$ myc anchor of --symbol fuseRRF
WARN graft не установлен — резолв символа эвристикой (regex по 412 индексированным файлам)
src/retrieval/fuse.ts:40-58  fuseRRF (единственный кандидат, 0.88)
  myc-5d31, myc-a3f8
недоступно без graft: список вызывающих (blast radius)
  установить: npm i -g @nanonets/graft && graft build
exit 0
```

`myc doctor` при отсутствии graft печатает `graft не установлен (опционально) —
доступно: якоря, репейр; недоступно: blast radius, обогащение по коду` и
**не считает это ошибкой** (`WARN`, не `FAIL`).

### 7.5 Двусторонняя связь узел ↔ символ

**myc → код** (прямая): якорь.

```
anchor = {
  repo:       "mycelium",            // имя воркспейс-репозитория
  path:       "src/retrieval/fuse.ts",
  start:      40, end: 58,
  blob_hash:  "a91c3e…",             // git blob файла на момент постановки
  crux_text:  "export function fuseRRF(bm, vec, k = 60) {\n  …",  // ≤ 8 строк
  crux_hash:  "4d1f…",               // нормализованный (без пробелов) хеш crux
  symbol:     "fuseRRF",             // опционально
  graft_node: "retrieval/fuse",      // опционально, ссылка, а не ключ
  state:      "fresh" | "stale" | "orphan" | "pending"
}
```

`crux_text` — прямой перенос идеи graft на наши якоря (§2 брифа, D14): номера
строк умирают при первом же рефакторинге, текст — нет.

**код → myc** (обратная): индекс `anchors(repo, path, start, end)` + интервальный
поиск. `myc anchor of <file>:<line>` — один запрос, **< 1 мс**:

```sql
SELECT node_id, start, end, state
  FROM anchors
 WHERE repo = ?1 AND path = ?2 AND start <= ?3 AND end >= ?3
 ORDER BY (end - start) ASC;     -- сначала самый узкий спан
```

`[cross:L1]` — реальный DDL за L1; мне нужен только этот индекс и порядок.

**Через символ** (обе стороны, требует graft): `symbol → path:span` резолвится
`graft grep`/`skeleton`, дальше работает интервальный поиск. Обратно
`node → symbol` берётся из поля `symbol` якоря.

**Алгоритм детекта протухания и репейра** — целиком наш, graft не нужен:

```
для каждого path из dirty_paths (дебаунс 2000 мс, батч 64):
    blob_new = git_hash_object(path)          # 0.2 мс на файл
    если файла нет:
        все якоря path → state=orphan; узлы помечаются needs_anchor; выход

    для каждого anchor на этом path:
        если anchor.blob_hash == blob_new:  state=fresh; continue     # 99% случаев

        # содержимое изменилось — ищем crux заново
        cand = поиск crux_text в новом содержимом:
            1) точное совпадение нормализованного текста        → score 1.00
            2) совпадение первой и последней строки crux        → score 0.90
            3) token-set Jaccard по окну ±200 строк, максимум   → score = J
        если score >= 0.85:
            anchor.start,end сдвигаются на найденный спан
            anchor.blob_hash = blob_new
            state = fresh;  записать audit-строку (было→стало, score)
        иначе:
            state = stale                     # чинит человек или myc anchor repair
```

Стоимость: 0.2 мс хеш + 0.4 мс поиск на якорь. 3413 якорей — 2 с полного прохода,
но полный проход не нужен: работаем только по `dirty_paths`.

**Экспорт связи наружу** (опционально, `myc anchor emit`): пишем
`.myc/links.json` в формате «path:span → [node_id, title, status]». Это позволяет
любому внешнему инструменту (в том числе `graft viz`) показать myc-узлы рядом с
кодом, не завися от нашего API. Обратной зависимости не создаём.

---

## 8. HTTP API сервера

### 8.1 Форма

Base — `/v1`. Всё, что относится к данным, живёт под `/v1/ws/:ws/…`; всё, что к
процессу — над ним. JSON in / JSON out, тот же конверт, что у CLI (§2.3).

```
# без воркспейса
GET    /v1/health                     живость процесса, БД не трогает
GET    /v1/health/db                  соединение, пул, версия схемы, латентность
GET    /v1/health/index               эмбеддинги, fts, vec, очередь, degraded[]
GET    /v1/ws                         воркспейсы, доступные токену
GET    /metrics                       Prometheus
POST   /v1/route                      рекомендация модели            [cross:L4]
POST   /v1/outcomes                   приём исхода задачи            [cross:L4]

# данные воркспейса
POST   /v1/ws/:ws/prime               { budget, role, focus } → см. схему myc_prime
GET    /v1/ws/:ws/ready               ?n=&priority=&tag=&kind=
POST   /v1/ws/:ws/ready/claim         { id?, lease_minutes } → 200 | 409
GET    /v1/ws/:ws/nodes               ?kind=&status=&tag=&since=&limit=&offset=
POST   /v1/ws/:ws/nodes               создать узел
GET    /v1/ws/:ws/nodes/:id           ?depth=0|1&source=true
PATCH  /v1/ws/:ws/nodes/:id           переходы состояния (тело = вход myc_update)
DELETE /v1/ws/:ws/nodes/:id           только owner/maintainer
POST   /v1/ws/:ws/edges               { from, type, to, reason }
DELETE /v1/ws/:ws/edges               { from, type, to }
POST   /v1/ws/:ws/search              { query, n, budget, filters… }
POST   /v1/ws/:ws/absorb              { text, tags, anchors, wait }
GET    /v1/ws/:ws/digest              ?topic=&budget=&depth=
GET    /v1/ws/:ws/anchors             ?path=&line=&symbol=
POST   /v1/ws/:ws/anchors             { node_id, path, start, end } | { node_id, symbol }
POST   /v1/ws/:ws/anchors/check       → { stale, orphan, items[] }
POST   /v1/ws/:ws/sync/pull           { since_seq, limit } → { ops[], seq }
POST   /v1/ws/:ws/sync/push           { ops[], base_seq } → { applied, conflicts[] }
GET    /v1/ws/:ws/events              SSE
GET    /v1/ws/:ws/graph               ?bbox=&zoom=&limit=&kind=  (для viz)
GET    /v1/ws/:ws/stats               ?group_by=&since=
```

Никакого GraphQL и никакого «универсального `/query`»: каждый эндпоинт — это
эндпоинт с известной стоимостью, которую можно нормировать и залогировать.

### 8.2 Аутентификация и авторизация

Bearer-токен. Токен → `actor`, `role`, список воркспейсов с правами.

```
Authorization: Bearer myc_a1b2c3d4…
```

```sql
-- хранение: сам токен не хранится
tokens(
  id           TEXT PRIMARY KEY,       -- "tok_7f2a"
  prefix       TEXT NOT NULL,          -- "myc_a1b2" — для показа в списке
  hash         BLOB NOT NULL,          -- sha256(token), сравнение constant-time
  actor        TEXT NOT NULL,          -- "claude-1" | "alice"
  role         TEXT NOT NULL,          -- owner|maintainer|member|agent|viewer
  ws           TEXT,                   -- NULL = все воркспейсы, доступные роли
  scopes       TEXT NOT NULL,          -- "read,write,claim" — сужение внутри роли
  expires_at   INTEGER,
  last_used_at INTEGER,
  created_by   TEXT NOT NULL
)
```

```
$ myc token create --actor claude-1 --role agent --ws myc --ttl 30d --scopes read,write,claim
tok_7f2a  actor=claude-1 role=agent ws=myc scopes=read,write,claim  истекает 2026-10-03
myc_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5   ← показано один раз, сохрани
```

- Роль сервера **сужает** MCP-профиль: токен `agent` не получит `full`, даже
  запросив `--profile full` (ответ `auth.profile_denied`).
- OIDC/SSO — задача внешнего прокси (`oauth2-proxy`, Cloudflare Access). myc
  принимает `X-Forwarded-User`, **только** если `--trust-proxy <cidr>` задан явно
  и запрос пришёл с этого адреса. Без флага заголовок игнорируется полностью.
- `--auth none` разрешён только при `--host 127.0.0.1`; иначе отказ на старте.
- Все проверки — до чтения тела запроса.

### 8.3 Мульти-workspace

Воркспейс в пути (`/v1/ws/:ws/…`) — явно, кешируемо, логируемо, разделяемо по
правам. Альтернатива для proxy-режима — заголовок `X-Myc-Workspace` (там путь
занят под совместимость с OpenAI/Anthropic API).

Резолв (порядок): путь → заголовок → `ws` токена (если единственный) → 400
`usage.ws_required`.

Изоляция хранилища `[cross:L1]`:

| Бэкенд | Схема | Соединения |
|---|---|---|
| SQLite | файл на воркспейс: `<data>/<ws>/myc.db` | пул на файл, ленивое открытие, LRU **8** открытых БД, закрытие по 300 с бездействия |
| Postgres | одна БД, колонка `ws_id` во всех таблицах, **RLS** по `current_setting('myc.ws_id')` | один пул на процесс (умолч. 10, макс 50), `SET LOCAL myc.ws_id` в начале каждой транзакции |

RLS выбран вместо schema-per-workspace: сотня схем убивает планировщик и делает
миграции O(N). RLS даёт то же изолирующее свойство одним предикатом, и его нельзя
обойти забытым `WHERE`.

### 8.4 Health

```
$ curl -s localhost:7777/v1/health
{"ok":true,"ver":"0.4.1","uptime_s":8241,"pid":4412}          # 200 всегда, если процесс жив
```

```
$ curl -s localhost:7777/v1/health/db
{"ok":true,"db":"postgres","latency_ms":1.8,"schema":"v7",
 "pool":{"size":10,"used":2,"waiting":0},"migrations_pending":0}
# 503 при недоступной БД или pending-миграциях
```

```
$ curl -s localhost:7777/v1/health/index
{"ok":false,"degraded":["embeddings.off"],
 "ws":{"myc":{"nodes":4128,"vectors":4102,"queue":26,"failed":0,
              "fts":"ok","vec":"ok","embed_fingerprint":"7c2a19…","anchors_stale":3},
       "orca":{"nodes":991,"vectors":0,"queue":991,"failed":0,
               "fts":"ok","vec":"empty","embed_fingerprint":null,"anchors_stale":0}}}
# 200 при ok, 503 при FAIL, 200 + degraded[] при WARN
```

Разделение на три эндпоинта не косметическое: `/v1/health` — для k8s liveness
(не должен падать из-за БД), `/v1/health/db` — для readiness,
`/v1/health/index` — для алертов качества. Смешать их — значит либо
перезапускать под из-за медленного индекса, либо не замечать пустую векторную
таблицу.

### 8.5 Лимиты

| Что | Значение | При превышении |
|---|---|---|
| Тело запроса | 1 МБ (`sync/push` — 8 МБ) | 413 `usage.body_too_large` |
| `search.n` | 200 | обрезка + `warn` |
| `search.budget` | 32 000 симв | обрезка + `warn` |
| `digest.budget` | 32 000 симв | обрезка + `warn` |
| `show.ids` | 50 за раз | 400 |
| `sync/push.ops` | 5 000 | 413 |
| Таймаут запроса | 5 000 мс (sync 30 000, SSE ∞) | 504 `timeout.request` |
| Rate limit на токен | token bucket 100 rps, burst 200 | 429 + `Retry-After` |
| Rate limit на IP (без токена) | 10 rps | 429 |
| SSE-подключений | 50 на воркспейс, 200 на процесс | 503 |
| Параллельных поисков | 16 на процесс, очередь 64 | 503 `overload` |
| Размер узла | body 64 КБ, title 512 симв | 400 |

Все лимиты — в конфигурации, все значения выше — умолчания. Каждое отклонение
пишется в `/metrics` (`myc_limit_hits_total{limit=…}`), чтобы было видно, что
кто-то в них живёт.

### 8.6 Proxy-режим (TencentDB Memory Proxy)

**Стоит ли делать: да — как отдельный режим `myc proxy`, выключенный по
умолчанию и не входящий в MVP-ядро.**

За:
- Единственный способ дать память клиенту, который **нельзя настроить**:
  закрытая IDE, чужой CI, SaaS-агент без MCP.
- Бесплатный сбор outcome-телеметрии для L4: usage и модель видны на проходе,
  и не нужно уговаривать агента вызывать `myc close --cost-*`.
- Работает с любым агентом мгновенно: одна переменная `ANTHROPIC_BASE_URL`.

Против (и как закрываем):
- **Через прокси течёт весь трафик и все ключи.** → Прокси **не хранит и не
  логирует** `Authorization`/`x-api-key`, пробрасывает как есть; тело запроса
  не пишется в БД никогда (только `usage` и метаданные).
- **Ломает prompt caching.** Правка начала промпта обнуляет кеш провайдера, и
  это дороже любой пользы от памяти. → Инъекция строго **после** статического
  префикса, отдельным помеченным блоком (D20).
- **Сетевой хоп в горячем пути LLM-запроса.** → Бюджет инъекции **15 мс p99**;
  не уложились — пропускаем запрос без памяти и пишем метрику. Прокси никогда
  не задерживает запрос ради памяти.
- **Меняет поведение агента невидимо.** → В каждый инжектированный блок
  вставляется маркер `<myc-memory ws="…" n="…" budget="…">`, и заголовок ответа
  `x-myc-injected: 3 nodes, 812 chars` — видно и в логах, и в devtools.

```
$ myc proxy --port 7790 --upstream https://api.anthropic.com --ws myc \
            --inject auto --budget 1500 --outcomes on
myc proxy 0.4.1 · upstream api.anthropic.com (anthropic wire)
маршруты: POST /v1/messages · POST /v1/chat/completions (openai wire → тот же upstream)
ws=myc · inject=auto budget=1500 симв · бюджет инъекции 15 мс
ключи НЕ хранятся и НЕ логируются · тела запросов НЕ сохраняются
outcomes: пишем usage+model+latency (без содержимого)
слушаю http://127.0.0.1:7790
```

Использование:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:7790 claude
OPENAI_BASE_URL=http://127.0.0.1:7790/v1 codex
```

Алгоритм инъекции:

```
on request:
  t0 = now()
  если header x-myc-inject == "off"  → пропустить как есть
  если inject == "auto" и в теле уже есть маркер <myc-memory> → пропустить (идемпотентность)

  query = последнее user-сообщение, обрезанное до 500 симв
  hits  = recall(query, budget, filter: acl >= agent, layer L1..L3)   # локальная БД, 12-22 мс
  если now() - t0 > 15 мс  → пропустить БЕЗ памяти, метрика proxy_inject_skipped_total

  block = "<myc-memory ws=… n=… budget=…>\n" + плотный текст hits + "\n</myc-memory>"

  # anthropic wire: system — массив блоков.
  #   Добавляем НОВЫЙ блок В КОНЕЦ. Существующие блоки, включая cache_control,
  #   не трогаем ни на байт → префиксный кеш провайдера остаётся валидным.
  # openai wire: messages — массив.
  #   Вставляем ОДНО system-сообщение ПОСЛЕ последнего существующего system,
  #   перед первым user. Начало массива не меняется.

  проксировать без буферизации (stream passthrough, byte-for-byte)

on response:
  выдать заголовок x-myc-injected: "<n> nodes, <chars> chars, <ms> ms"
  если outcomes on: записать { model, tokens_in, tokens_out, latency_ms,
                               injected_n, ws, ts } — только метаданные   [cross:L4]
```

Ограничения режима, заявленные явно: не поддерживает tool-use-переписывание,
не модифицирует ответы, не работает как балансировщик, не кеширует ответы.
Он делает ровно одно — добавляет блок памяти и считает usage.

По умолчанию `myc doctor` показывает `proxy выключен`, и это нормальное
состояние. Порядок предпочтения интеграции: **MCP > хуки > proxy**.
Proxy — для случаев, когда первые два недоступны.

---

## 9. Командная работа

### 9.1 Воркспейс

Воркспейс = граф + участники + общие настройки. Обычно один на репозиторий, но
это не обязано совпадать: монорепо может держать один воркспейс, а связанная
пара репозиториев — тоже один.

```
$ myc ws ls
SLUG           DB                          NODES  РОЛЬ         SYNC
myc         *  sqlite .myc/myc.db           4128  owner        server ok, 2m назад
orca           https://myc.team/v1 ws=orca   991  member       server ok, 2m назад
cherry-mobile  sqlite ~/.myc/cherry/myc.db 12043  owner        локальный, без сервера
```

```
$ myc ws create research --db postgres://myc@db/myc --server https://myc.team
воркспейс research создан на https://myc.team · вы owner
пригласить: myc ws invite research alice@… --role member
локальная привязка: myc ws use research
```

Файлы конфигурации:

| Файл | В git | Что в нём |
|---|---|---|
| `.myc/workspace.toml` | **да** | slug, режим supersession, дефолтные ACL по типам, теги, лимиты ретривала, настройки LLM **без ключей**, политика prune |
| `.myc/local.toml` | нет (`.gitignore`) | actor, путь к БД, `api_key` (если не через env), адрес сервера, токен, личные предпочтения вывода |
| `.myc/myc.db*` | нет | локальная база |
| `.myc/cache/`, `.myc/episodes/` | нет | кеши и сырые эпизоды |

Валидация при `myc config set`: попытка положить `api_key` или `token` в
`workspace.toml` отклоняется с `usage.secret_in_shared_config`.

### 9.2 Участники и роли

| Роль | read | write memory | write task | claim | close | link | decide (L3) | admin | видит L0 других |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `owner` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `maintainer` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `member` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `agent` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `viewer` | ✓ | — | — | — | — | — | — | — | — |

`agent` от `member` отличается **не правами записи, а видимостью**: агент не
видит `private`-узлы других акторов и сырые эпизоды L0 (см. 9.4). Это
единственное системное различие; всё остальное — одинаково, потому что агент
должен уметь делать работу целиком.

`decide` (создавать и менять узлы слоя L3 — константы проекта) отделён
сознательно: L3 попадает в `prime` **каждой** сессии каждого участника.
Право дописать туда строку — это право изменить поведение всей команды.
Автоматической дистилляции в L3 нет ни при каких настройках (§5.1).

### 9.3 ACL узла

Четыре уровня (из TencentDB), фильтрация **до ранжирования** (D21):

| Уровень | Кто видит |
|---|---|
| `private` | только автор |
| `team` | все участники воркспейса, включая агентов |
| `restricted` | явный список акторов (`--only @alice,@claude-1`) |
| `agent` | все, включая агентов; помечает узел как «специально для агентов» (инструкции, скиллы) |

Дефолт по типу узла — чтобы никто не проставлял ACL руками:

| Тип узла | ACL по умолчанию | Почему |
|---|---|---|
| `episode` (L0) | `private` | сырой транскрипт: чужие пароли, чужой код, чужие мысли (D22) |
| `memory` (L1) | `team` | факты проекта — общее знание |
| `decision` (L2/L3) | `team` | решения обязаны быть общими |
| `task`/`bug`/`epic` | `team` | работа |
| `skill` | `agent` | исполняемые воркфлоу — для агентов |
| `document` | наследует от источника | импортированный приватный файл не должен «повышаться» |
| телеметрия исходов | `team`, только метаданные | `[cross:L4]` |

Реализация фильтрации — предикат в `WHERE` **до** RRF:

```sql
WHERE ws_id = :ws
  AND ( acl = 'team'
     OR acl = 'agent'
     OR (acl = 'private'    AND author = :actor)
     OR (acl = 'restricted' AND EXISTS (SELECT 1 FROM acl_members
                                         WHERE node_id = n.id AND actor = :actor)) )
  AND (:actor_is_agent = 0 OR layer <> 'L0')     -- агент не видит сырые эпизоды
```

Пост-фильтрация запрещена: она течёт через `total`, через ранги RRF (позиция 1
из 10 и позиция 1 из 3 — разный смысл) и через «пустой результат на видимом
месте», по которому восстанавливается факт существования узла.

### 9.4 Что видит агент, а что человек

| | Агент (`role=agent`) | Человек (`member`+) |
|---|---|---|
| Задачи, зависимости, ready | всё, что `team`/`agent` | то же + `private` свои |
| Факты L1–L3 | всё, что `team`/`agent`/свои | то же |
| Сырые эпизоды L0 | **только свои собственные** | свои; чужие — с `maintainer`+ |
| Авторство | видит `actor` как строку | видит человека, его историю, время |
| История supersession | видит только актуальную версию (режим `active`) | видит цепочку целиком |
| Телеметрия роя | видит только `myc_route` (рекомендацию) | видит распределения, цены, провалы |
| Секреты | замаскированы всегда | замаскированы всегда (маскировка на записи, не на чтении) |
| Мутации | по правам роли | по правам роли |

Причина такого разделения — не безопасность в криптографическом смысле (агент
работает в том же процессе и в том же репозитории), а **гигиена контекста**:
всё, что агент видит, он рано или поздно перескажет в свой ответ, а оттуда — в
чужой транскрипт. Сырые эпизоды чужих сессий — самый дешёвый способ утечки.

### 9.5 Общие решения

Решение — это узел `kind=decision`, `layer=L2` (или `L3` для констант), с
обязательным `reason` и историей.

```
$ myc decide "Векторный поиск живёт внутри SQLite, внешний движок не тянем" \
    --layer L3 --supersedes myc-0d12 --reason "sqlite-vec держит 500k, +0 зависимостей"
myc-1c05  decision L3 acl=team by alice
supersedes myc-0d12 «Рассмотреть Qdrant» → status=superseded (история сохранена)
попадёт в myc prime у всех участников со следующей синхронизацией
```

Правила:
- Решение **никогда не редактируется** — только заменяется через `supersedes`
  с причиной. `myc show --history` показывает цепочку.
- Режим воркспейса `supersession = "active" | "full_history"`: в `active`
  заменённые узлы уходят из выдачи (но остаются в базе и в истории);
  в `full_history` остаются с меткой `[superseded by myc-…]`. Умолчание —
  `active`, потому что агенту нужен один ответ, а не археология.
- Противоречие (`contradicts`) — **не** решение. Оно висит открытым и попадает в
  `digest` и в `myc doctor --conflicts`, пока человек не разрешит его через
  `supersedes`. Автоматически противоречия не закрываются никогда.

### 9.6 Редакция секретов

Обязательный этап записи (D23) — иначе pre-compact-хук превращает `.myc/` в
хранилище чужих ключей рядом с git.

```
детектор(text) → [ (start, end, kind) ]
  паттерны:  AWS AKIA[0-9A-Z]{16} · gh[pousr]_[A-Za-z0-9]{36}
             sk-[A-Za-z0-9]{20,} · sk-ant-[A-Za-z0-9-]{20,}
             -----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----
             eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.       (JWT)
             xox[baprs]-[A-Za-z0-9-]{10,}                      (Slack)
             postgres(ql)?://[^:]+:[^@]+@                       (пароль в DSN)
  энтропийный: токен длиной ≥ 32 из [A-Za-z0-9+/=_-] с энтропией Шеннона ≥ 4.0 бит/симв
               и не являющийся hex-хешем известной длины (32/40/64) — иначе ложные
               срабатывания на git-хешах
замена: <redacted:kind:sha1_8>       # хеш позволяет заметить повтор того же секрета
```

Стоимость — **8 мс на 200 КБ** (один проход, скомпилированные regex). Работает
на записи в `remember`/`absorb`/`absorb-session`/`import`, счётчик попадает в
вывод (`3 секрета замаскированы`) и в `myc doctor`. Отключение —
`--no-redact`, только на `import` и только с подтверждением.

---

## 10. Веб-визуализация

### 10.1 Что показываем

Пять экранов, каждый отвечает на вопрос, на который плохо отвечает CLI.

| Экран | Вопрос | Содержание |
|---|---|---|
| **Граф** | «как это всё связано» | узлы по видам и слоям, рёбра по типам, фильтры (kind, layer, tag, acl, автор, дата), поиск с подсветкой, клик → панель узла |
| **Очередь** | «что делать сейчас» | 4 колонки ready / in_progress / blocked / closed(7d); карточка = id, приоритет, заголовок, исполнитель, аренда, `unblocks N`; drag не нужен — статусы меняет CLI/агент |
| **Таймлайн** | «что происходило» | горизонтальная ось времени: эпизоды сессий (полосы), решения (метки), закрытия задач (точки), деплои/коммиты из git; масштаб час/день/неделя |
| **Решения** | «почему так» | дерево supersession-цепочек, открытые противоречия сверху красным, для каждого решения — причина, автор, дата, что заменило |
| **Здоровье** | «можно ли доверять ответам» | `myc doctor` в вебе: эмбеддинги (покрытие, очередь, fingerprint), fts/vec, протухшие якоря, деградации, хуки (когда срабатывали), фоновая очередь |

Шестым добавляется панель роутинга (модель × класс задачи, цена, доля успеха) —
её содержимое проектирует L4. `[cross:L4]`

### 10.2 Стек

- **Сервер** — тот же Bun-процесс, что `myc serve`: `/v1` + статика.
  Ассеты (`index.html`, один JS-бандл, один CSS) **вшиты в бинарь** через
  `Bun.embeddedFiles`. Ноль CDN, ноль сетевых зависимостей: `myc viz` обязан
  работать в самолёте и в закрытом контуре.
- **Фронт** — TypeScript без фреймворка, сборка Vite, цель < **180 КБ** gzip.
  Причина не в идеологии: бандл едет внутри бинаря, и React+граф-библиотека — это
  +900 КБ к каждому скачиванию `myc`.
- **Граф** — собственный рендер:
  - `< 2 000` узлов — Canvas 2D (проще, тексты дешевле);
  - `≥ 2 000` — WebGL (инстансинг точек и линий, тексты — атлас, только для
    видимых и достаточно крупных узлов).
  - Лэйаут — `d3-force` в **Web Worker**, чтобы не блокировать ввод.
- **Mermaid** — только для маленьких подграфов (D25): `digest --format mermaid`,
  цепочка supersession, дерево зависимостей одной задачи. Порог — **40 узлов**,
  выше него кнопка «открыть в графе».

### 10.3 10k+ узлов

Ключевое решение: **лэйаут не считается в браузере на каждый запрос.**

```
1. Позиции хранятся: layout(ws_id, node_id, x, y, cluster_id, rev)     [cross:L1]
2. Пересчёт — фоновым job'ом, инкрементально:
     - новый узел: помещается в центроид своего кластера + jitter, без глобального
       пересчёта;
     - глобальный пересчёт — при росте графа на 10% с последнего или по кнопке;
     - 10k узлов, d3-force, 300 итераций, alphaDecay 0.02 → ~2.4 с в воркере.
3. Кластеризация — Louvain по рёбрам + приоритет тегов и директорий якорей;
   пересчёт вместе с лэйаутом. Даёт 30-80 кластеров на 10k узлов.
```

Отдача — только видимое:

```
GET /v1/ws/myc/graph?bbox=-1200,-800,1200,800&zoom=0.35&limit=3000&kind=task,decision
```

```
zoom < 0.25   → отдаём ТОЛЬКО кластеры: {id, label, x, y, r, n, kinds{}}   ~80 объектов
0.25 ≤ z < 1  → узлы в bbox, отсортированные по степени, limit 3000 + «жгуты» между
                кластерами (агрегированные рёбра с толщиной = число рёбер)
zoom ≥ 1      → узлы в bbox + все рёбра между ними, limit 3000
```

Бюджеты фронта:

| Что | Цель | Как достигается |
|---|---|---|
| Первый кадр на 10k | **< 400 мс** | позиции приходят готовыми, один буфер Float32Array, один draw call на точки |
| Пан/зум | **60 fps** | никаких реляйаутов при перемещении; только пересчёт матрицы вида |
| Ответ `/graph` | **< 60 мс** p99 | пространственный индекс R-tree по `layout(x,y)`, отдача бинарным Float32 при `Accept: application/octet-stream` |
| Трафик первого экрана | **< 300 КБ** | кластеры вместо узлов при zoom-out |
| Рёбра | ≤ 30 000 на кадр | выше — только жгуты между кластерами |

Панель узла подгружается отдельно (`/v1/ws/:ws/nodes/:id?depth=1`) — в графе
хранятся только `id, x, y, kind, layer, deg`.

### 10.4 Real-time через SSE

```
GET /v1/ws/myc/events
Accept: text/event-stream
Last-Event-ID: 91204
```

```
event: node.updated
id: 91205
data: {"id":"myc-a3f8","status":"closed","assignee":"claude-1","ts":"2026-09-03T10:54:02Z"}

event: batch
id: 91211
data: {"nodes":[{"id":"myc-9e44","status":"open"},{"id":"myc-7a02","status":"open"}],
       "edges":[{"from":"myc-a3f8","type":"blocks","to":"myc-9e44","op":"resolved"}]}

event: health
id: 91212
data: {"degraded":["embeddings.off"],"queue":26,"anchors_stale":3}

: heartbeat 2026-09-03T10:54:17Z
```

| Свойство | Решение |
|---|---|
| Типы событий | `node.created/updated/closed`, `edge.created/removed`, `queue.progress`, `health`, `batch` |
| Дельты | шлём только изменившиеся поля, не узел целиком |
| Батчинг | накопление **100 мс**, затем один `batch` — при массовом импорте это разница между 5000 событий и 12 |
| Переподключение | `Last-Event-ID` = seq oplog; сервер отдаёт хвост с этой позиции `[cross:L1]` |
| Отставание | если клиент отстал больше чем на **5000** событий — шлём `event: resync`, фронт перезагружает вид целиком |
| Heartbeat | комментарий `: heartbeat` каждые **15 с** (переживает прокси с idle-таймаутом) |
| Лимиты | 50 подключений на воркспейс, 200 на процесс |
| Фильтр | `?kind=&layer=` — сервер не шлёт то, что вид всё равно не покажет |

### 10.5 Read-only для команды

```
$ myc viz --read-only --port 7788
myc viz 0.4.1 · ws=myc · READ-ONLY
мутирующие эндпоинты отключены на уровне сервера (не только в UI)
```

```
$ myc viz --share --ttl 24h --scope tasks,decisions
создан viewer-токен tok_9c31 (истекает 2026-09-04T10:54Z, только чтение,
  разделы tasks+decisions, ACL private и L0 исключены)
http://192.168.1.14:7788/#t=myc_v_9c31aa…
отозвать: myc token revoke tok_9c31
```

Три уровня, и запрет всегда на сервере, а не в интерфейсе:

1. **Роль токена** `viewer` — мутирующие маршруты отвечают 403 `auth.readonly`.
2. **Флаг процесса** `--read-only` — маршруты не регистрируются вообще.
3. **UI** прячет кнопки — это удобство, а не защита.

Публичная ссылка дополнительно сужает ACL: `private` и слой L0 не отдаются
никогда, независимо от роли токена.

---

## 11. Онбординг

### 11.1 `myc init` — одна команда

Что автодетектится:

| Сигнал | Что делаем |
|---|---|
| `git rev-parse --show-toplevel` | корень воркспейса; slug = имя директории, урезанный до 12 симв |
| существующий `.myc/` | не трогаем, печатаем состояние и выходим 0 (идемпотентность) |
| `.beads/` | предлагаем `myc import --from beads` (не выполняем без согласия) |
| `graft/` или `graft` в PATH | включаем адаптер, ставим job `graft map` для L2-карты репозитория |
| `.claude/`, `.codex/`, `opencode.json`, `.cursor/`, `AGENTS.md` | список для `myc wire` (не пишем без `--yes` или `myc wire`) |
| `package.json`/`go.mod`/`Cargo.toml`/`pyproject.toml` | язык → стартовый словарь тегов |
| `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` в env | предлагаем включить `llm.chat` (не включаем сами) |
| `.gitignore` | дописываем 4 строки в свой блок с маркерами |
| модель эмбеддингов в `~/.myc/models/` | если нет — качаем **в фоне**, init не ждёт |
| `MYC_SERVER` в env | предлагаем `myc ws join` |

Сеть не обязательна: без неё init отрабатывает полностью, поиск стартует в режиме
BM25, а модель докачается при следующем запуске. `--embed none` фиксирует это
состояние навсегда, если так задумано.

```
$ myc init
myc 0.4.1 · repo /Users/e/src/mycelium (git) · slug=myc

  ✓ .myc/myc.db          sqlite, schema v7, wal            4 мс
  ✓ .myc/workspace.toml  дефолты для команды (в git)       1 мс
  ✓ .myc/local.toml      actor=egor, в .gitignore          1 мс
  ✓ .gitignore           +4 строки в блоке myc             1 мс
  ✓ graft 0.9.2          адаптер включён; карта репозитория ставится в очередь
  ✓ агенты найдены       claude-code, opencode
  ↓ эмбеддинги           bge-small-en-v1.5-q8, 23 МБ — качается в фоне.
                         Поиск станет гибридным примерно через 40 с;
                         до этого работает BM25 (это видно в выводе recall).
  ! llm.chat выключен    нет ключа. absorb пойдёт на эвристиках, дистилляция
                         L1→L2 не будет работать. Включить:
                         myc config set llm.chat.api_key_env ANTHROPIC_API_KEY

  найдено .beads/ — 94 задачи. Перенести: myc import --from beads

дальше:
  myc wire --agents claude,opencode --dry-run   посмотреть, что будет записано
  myc remember "<первый факт о проекте>"
  myc task "<первая задача>" -p P1
  myc prime                                     увидеть то, что увидит агент

готово за 1.9 s · ничего за пределами репозитория не записано
```

`--yes` пропускает предложения и делает всё разумное сразу (wire найденных
агентов, импорт beads, запуск graft map). `--dry-run` печатает каждый файл.

### 11.2 Первые 60 секунд

| Сек | Пользователь | Что происходит | Что он видит |
|---|---|---|---|
| 0–2 | `myc init` | база, конфиги, `.gitignore`, детект; модель качается фоном | вывод выше — сразу видно и что работает, и что деградировало |
| 2–8 | `myc wire --agents claude,opencode --dry-run` → `myc wire …` | точечный merge своих узлов, `.bak`, журнал `wire.json` | список файлов и diff **до** записи, `CLAUDE.md` в списке нетронутых |
| 8–20 | `myc import --from beads` | 94 задачи + 141 ребро, ID сохраняют хеш-часть | `94 задачи · 141 ребро · конфликтов 0 · 180 мс` |
| 20–30 | `myc ready` | граф-запрос по свежеимпортированным задачам | **первая настоящая польза**: очередь, которой раньше не было |
| 30–40 | `myc remember "…"` + `myc prime` | запись, `prime` собирается из кеша | видит, что записанное сразу попало в стартовый пакет |
| 40–55 | новая сессия агента | `SessionStart`-хук зовёт `myc prime` | агент **сам** начинает с состояния проекта, ничего не спросив |
| 55–60 | агент вызывает `myc_ready{claim:true}` | атомарный захват, задача + якоря + факты одним ответом | агент работает; человек ничего больше не настраивал |

Три вещи, которые обязаны случиться в эти 60 секунд, иначе онбординг провален:
1. пользователь **увидел свои задачи** в `myc ready` (импорт beads или три
   `myc task`) — иначе инструмент выглядит пустым;
2. агент **сам** получил контекст без напоминания — это доказательство ценности;
3. пользователь **знает про деградацию** (нет ключа, модель качается) и не
   считает, что что-то сломано.

### 11.3 Если что-то пошло не так

```
$ myc init
myc 0.4.1 · /Users/e/tmp/scratch — НЕ git-репозиторий
воркспейс всё равно можно создать (slug=scratch), но:
  - якоря к коду будут без blob_hash (детект протухания не заработает);
  - graft-адаптер выключен.
создать всё равно: myc init --no-git
```

```
$ myc init
error: .myc/ уже существует (slug=myc, schema v7, 4128 узлов)
ничего не изменено. состояние: myc doctor · пересоздать: myc init --force (удалит данные)
exit 0
```

---

## 12. Бюджеты и как их держим

### 12.1 Где тратится латентность

**Холодный старт CLI** (бюджет §3 брифа: < 60 мс до готовности, `prime` p99 < 30 мс):

| Этап | Стоимость | Как держим |
|---|---|---|
| запуск `bun`-бинаря, разбор аргументов | 15–22 мс | не наш; уменьшается только размером бандла → фронт-ассеты и onnx **вне** горячего импорта |
| чтение конфигурации | **0.4 мс** | ровно два файла по известным путям, без обхода директорий вверх дальше корня git; результат мемоизируется в `.myc/state.json` вместе с mtime |
| открыть SQLite (WAL) | **1.2 мс** | одно соединение, `PRAGMA journal_mode=WAL, synchronous=NORMAL, mmap_size=256MB` |
| наша логика `prime` (кеш-хит) | **1.8 мс** | одно чтение строки из `prime_cache` |
| наша логика `prime` (промах) | 12–25 мс | один SQL с 4 CTE, один round-trip, запись кеша после ответа |
| **итого `myc prime` wall** | **~26 мс** p99 | укладываемся |

Жёсткие запреты в модуле запуска, проверяются тестом:

- ни одного `import` тяжёлого модуля на верхнем уровне: onnx-рантайм,
  http-сервер, viz-ассеты, graft-адаптер, mermaid — **только** динамический
  `await import()` внутри команды, которой они нужны;
- ни одного сетевого вызова без явного флага;
- ни одного обхода файловой системы шире, чем `.myc/` и корень git;
- тест `startup.no-heavy-imports` падает, если граф импортов от `main` до любой
  команды из «горячей семёрки» (`prime`, `ready`, `claim`, `show`, `recall`,
  `remember`, `status`) содержит запрещённый модуль.

**`prime_cache`** — таблица `(ws_id, role, budget_bucket) → (payload TEXT, seq INT)`.
Инвалидация: `seq` из oplog `[cross:L1]`. Кеш считается годным, если
`cache.seq == oplog.seq`. Любая запись двигает `seq` — значит после каждой записи
первый `prime` платит 12–25 мс, остальные 1.8 мс. Для агентской сессии это
идеальный профиль: пишем редко, читаем часто.
`budget_bucket` — квантование бюджета до {1000, 2000, 4000, 8000}, чтобы кеш не
размножался по каждому значению `--budget`.

**Запись** (бюджет < 5 мс):

```
myc remember:
  detect_secrets(text)                 0.4 мс (короткий текст)
  INSERT node + tags + anchors         1.1 мс
  INSERT jobs(embed, absorb)           0.3 мс
  bump oplog seq                       0.2 мс
  ответ                                0.2 мс
                                 итого 2.2 мс
фоном (никто не ждёт): эмбеддинг 4.1 мс, absorb-LLM 0.8–3 с, дистилляция минуты
```

**Поиск** — за L2, я только фиксирую контракт: `recall` обязан вернуться за 25 мс
p99 на 100k и обязан сообщить `degraded[]`, если вернулся не гибридом.

**MCP** — процесс живёт, холодный старт платится один раз (§4.14):
`myc_prime` < 5 мс, `myc_show` < 2 мс, `myc_recall` 12–22 мс.

**Хуки** — единственное место, где myc может испортить чужой UX:

| Хук | Наш бюджет | Таймаут helper'а | Таймаут в settings |
|---|---|---|---|
| session-start | 26 мс | 2500 мс | 3000 мс |
| pre-compact | 41 мс | 7500 мс | 8000 мс |
| post-edit | **< 2 мс** | 1000 мс | 1500 мс |
| stop | 30 мс | 1500 мс | 2000 мс |

Разрыв между нашим бюджетом и таймаутом — запас на холодный старт процесса и на
занятый диск. Helper всегда выходит с кодом 0.

**graft** — вне горячего пути по построению (D13). Единственное место, где он
может попасть в интерактивный путь, — `myc anchor add --symbol` и
`myc anchor of --symbol`; там бюджет 1500 мс и это явная команда человека.

**HTTP** — `+ сеть` к локальным бюджетам; ограничения §8.5 не дают одному
клиенту съесть пул.

**Proxy** — 15 мс на инъекцию, дальше пропускаем без памяти. Прокси не имеет
права задержать запрос агента.

**Веб** — первый кадр 10k < 400 мс, `/graph` < 60 мс, пан/зум 60 fps (§10.3).

### 12.2 Что уходит в фон

| Работа | Триггер | Где выполняется | Отменяема |
|---|---|---|---|
| эмбеддинг узла | `remember`/`create`/`import` | очередь `jobs`, батч 32 | да |
| absorb-классификация | `absorb`/`remember` | очередь, LLM | да |
| дистилляция L0→L1→L2 | `close-session`, `absorb-session` | очередь, LLM | да |
| проверка/репейр якорей | `dirty_paths`, дебаунс 2000 мс | очередь, батч 64 | да |
| `graft ask` для обогащения | job `enrich(node)` | очередь, батч 8 | да |
| пересчёт лэйаута графа | +10% узлов или кнопка | воркер, ~2.4 с на 10k | да |
| `prune`-саммари | `myc prune --apply` | очередь, LLM | да |
| outcome-агрегация приоров | `close`, proxy | очередь `[cross:L4]` | да |

**Кто разгребает очередь без демона** (D28): в порядке приоритета —
(1) живой `myc worker`, если запущен; (2) MCP-процесс, у которого есть idle-время
(таймер 2000 мс после последнего запроса, не более 200 мс работы за тик);
(3) любая CLI-команда с запасом бюджета (`prime`, `ready`, `doctor`) — не более
**50 мс** за раз и только если очередь непуста. Так фоновая работа продвигается
даже у пользователя, который никогда не запускал воркер, и при этом никогда не
съедает чужой бюджет.

Блокировка — одна строка в SQLite (`jobs.claimed_by`, `claimed_until`), тот же
механизм, что у `claim` задач: несколько процессов на одну базу безопасны.

---

## 13. Риски и что ломается на масштабе

| # | Риск | Проявление | Митигация |
|---|---|---|---|
| R1 | **Контракты хуков меняются у хостов** | новая версия Claude Code переименовала событие — myc молча перестаёт работать, а пользователь думает, что память есть | myc сам считает вызовы каждого хука; `myc doctor --hooks` показывает «не вызывался N дней» как WARN. Это единственный способ заметить тишину |
| R2 | **Испорченный чужой конфиг** | переписали `settings.json`/`CLAUDE.md` — доверие потеряно навсегда | merge-only, `.bak`, `--dry-run`, отказ при конфликте с вопросом, журнал `wire.json`, `myc unwire`, `CLAUDE.md` не трогаем вообще (D10) |
| R3 | **pre-compact не успевает** | транскрипт 2 МБ, 8 с таймаута, эпизод не сохранён — потеряна вся сессия | сырой эпизод пишется **первым** (файл + строка, 6 мс), спасательный пакет — вторым, дистилляция — фоном. Даже при таймауте на шаге 6 данные уже на диске |
| R4 | **Фоновая работа не доживает** | CLI вышел, воркера нет, очередь стоит месяцами; база «выглядит здоровой», но векторов нет | очередь на диске + три разгребателя (§12.2); `myc doctor` показывает `queue N pending`; `prime` дописывает предупреждение при `pending > 500` |
| R5 | **Секрет в графе** | pre-compact записал `.env` из транскрипта, `.myc/` попал в git | детектор на записи (§9.6), `episode` по умолчанию `private`, `export --redact` по умолчанию on, `.gitignore` пишется в `init` |
| R6 | **Раздувание MCP-поверхности** | через полгода 25 тулов, каждая сессия платит 4k токенов описаний | бюджет 1100 токенов на профиль `agent`, проверяется тестом; новый тул — только вместе с удалением другого (D7) |
| R7 | **Агент не вызывает myc** | тулы есть, но модель предпочитает читать файлы | хуки закрывают самое важное **без участия модели** (prime, pre-compact, post-edit). Инструмент не должен зависеть от доброй воли агента |
| R8 | **Разъезд embed-пространств** | сменили модель, поиск тихо испортился | `embed_fingerprint` сверяется на старте, отказ вместо смешивания (D16, §5.4) |
| R9 | **graft другой версии / сломан** | адаптер спавнит процесс, тот падает, каждый фоновый job горит | pin по мажору, `state=incompatible`, негативный кеш 24 ч, таймаут 1500 мс, деградация по функциям (§7.4) |
| R10 | **Прокси ломает prompt caching** | счёт за API вырос втрое, никто не понял почему | инъекция строго после статического префикса (D20); тест, который сравнивает `cache_read_input_tokens` с прокси и без |
| R11 | **Прокси как точка утечки** | тела запросов в логах прокси | не логируем тела и заголовки авторизации, пишем только usage-метаданные; выключен по умолчанию |
| R12 | **Веб на 50k узлов** | вкладка ест 3 ГБ и висит | кластеры при zoom-out, серверная выборка по bbox, лэйаут в БД, потолок 3000 узлов и 30000 рёбер на кадр (§10.3) |
| R13 | **SSE-шторм** | массовый импорт → 5000 событий в секунду, браузер умирает | батчинг 100 мс, `resync` при отставании > 5000, фильтр по kind на сервере |
| R14 | **Гонки многих агентов** | двое взяли одну задачу | атомарный `UPDATE … WHERE status='open' AND lease` (§3.5); аренда 30 мин; `--steal` только после истечения |
| R15 | **Постгрес: один пул на все воркспейсы** | шумный сосед выел пул, все воркспейсы встали | лимит параллельных поисков 16 на процесс, очередь 64, `statement_timeout` 5 с, метрика `pool_waiting` |
| R16 | **`prune` съел недистиллированное** | LLM был выключен, `prune --apply` удалил эпизоды, из которых ничего не извлекли | правило §3.23: не трогаем то, что не дистиллировано; `--dry-run` по умолчанию |
| R17 | **Кеш graft не попадает** | генерируемые файлы дёргают `graph_rev`, кеш-хит 5%, фон тормозит | `myc doctor` печатает кеш-хит; при < 30% — подсказка проверить `.gitignore` |
| R18 | **Токен-бюджет `prime` растёт с проектом** | 4000 узлов → prime на 12k символов, съедает контекст | жёсткий `--budget` с приоритетом секций и обрезкой; L3 ограничен 12 пунктами (жёстко); decisions — 5 последних |
| R19 | **ACL-протечка через ранги** | пост-фильтр показал «6 из 40», раскрыв существование 34 скрытых | фильтр в `WHERE` до RRF (D21); тест, сравнивающий `total` для акторов с разными правами |
| R20 | **Идентичность агента** | все агенты пишут как `claude`, статистика роя бессмысленна | `--as`/`MYC_ACTOR` обязателен для роли `agent` на сервере; локально по умолчанию `<host>:<pid>:<tool>` |

**Что ломается раньше всего при росте** (по моему лейну):

1. **`prime` на 500+ открытых задач** — ready-выборка растёт, кеш промахивается
   после каждой записи. Порог ≈ 2000 открытых задач; лечится ограничением
   выборки и предрассчитанной таблицей `ready_set`, обновляемой триггером на
   изменении статуса/рёбер. `[cross:L1]`
2. **Веб-граф на 50k** — переход к обязательной кластеризации и отказ от
   отображения отдельных узлов ниже zoom 0.5.
3. **SSE на 200+ зрителей** — потребуется fan-out через один общий поток на
   воркспейс с per-client фильтром (сейчас поток на клиента).
4. **`anchor check` на 50k якорей** — полный проход 30 с; спасает работа только
   по `dirty_paths`, но при `git checkout` большой ветки грязными становятся все.
   Лечится: при `dirty > 20%` файлов — переход в режим «ленивая проверка при
   первом обращении к якорю» вместо массового прохода.

---

## 14. Открытые вопросы координатору

| # | Вопрос | Кому | Почему это блокирует L3 | Моё допущение |
|---|---|---|---|---|
| Q1 | Точный формат ID и правило коротких префиксов | L1 | вся грамматика CLI и все примеры вывода на нём | `<slug>-<hex4>` + `.<n>`; префикс разрешается, пока однозначен, иначе `exit 4` |
| Q2 | Существует ли монотонный `oplog.seq` на воркспейс | L1 | на нём держатся: инвалидация `prime_cache`, `Last-Event-ID` в SSE, `sync --since` | да, монотонный, общий на воркспейс, доступен как `meta.seq` |
| Q3 | Таблица `anchors` и интервальный индекс | L1 | `myc anchor of <file>:<line>` обязан быть < 1 мс | `(ws_id, repo, path, start, end)` + покрывающий индекс; поля `crux_text`, `crux_hash`, `blob_hash`, `state` |
| Q4 | Где живёт `layout(node_id, x, y, cluster_id, rev)` | L1 | лэйаут графа считается вне браузера, иначе 10k не отрисовать | отдельная таблица в той же БД, обновляется фоновым job'ом |
| Q5 | Мульти-воркспейс в Postgres: `ws_id`+RLS или schema-per-ws | L1 | от этого зависит форма пула и `SET LOCAL` в §8.3 | `ws_id` + RLS, один пул |
| Q6 | Контракт `recall`: принимает ли он бюджет **в символах** и возвращает ли `degraded[]` и `mode_used` | L2 | на этом держатся `--budget`, вывод `WARN` и схема `myc_recall` | да; бюджет в символах, обрезка по узлам целиком, а не по середине текста |
| Q7 | Кто владеет порогами absorb (0.93 дубль / 0.55 new) | L2 | я показываю их в выводе как числа | пороги задаёт L2, я только отображаю и кладу в `workspace.toml` |
| Q8 | Формула сортировки `ready` (`--why` печатает её слагаемые) | L1/L2 | `myc ready --why` обязан показывать реальные веса | приоритет 0.40 + unblocks 0.27 + свежесть 0.14 + состояние якорей 0.10 + тип 0.09 |
| Q9 | Схема `myc route` и `POST /v1/outcomes` | L4 | прокси и `myc close` шлют туда данные; мне нужны имена полей | `{model, effort, expected_cost_usd, expected_p_success, confidence}` на выходе; на входе исхода — метаданные без контента |
| Q10 | Кто владеет семантикой `prune` (decay) — L1 или мой CLI | L1 | я описал правило «не трогать недистиллированное» как контракт CLI | правило принадлежит L1, CLI только вызывает и показывает |
| Q11 | Нужен ли `myc skill` как отдельная сущность в MVP (skills из TencentDB) | координатор | если да — это ещё один тул в профиле `leader` и раздел в CLI | в MVP `skill` — просто `kind` узла, отдельной поверхности нет |
| Q12 | Нужен ли `X-Forwarded-User` от внешнего SSO в MVP | координатор | влияет на §8.2 и на модель участников | поддерживаем, но только с явным `--trust-proxy <cidr>` |
| Q13 | Порог, после которого `myc viz` требует сервера | L2/координатор | лэйаут 50k в локальном воркере — 15 с | до 25k считаем локально, выше — только с `myc serve` |

---

## Приложение A. Сводка поверхностей

| Поверхность | Запуск | Профиль/режим | Аутентификация | Горячий путь |
|---|---|---|---|---|
| CLI | `myc <cmd>` | — | локальный пользователь | да (7 команд) |
| MCP stdio | `myc mcp --profile agent` | agent / leader / full | наследует от процесса | да |
| MCP через сервер | `myc mcp --db https://…` | сужается ролью токена | Bearer | да |
| HTTP API | `myc serve` | — | Bearer (+ опц. trusted proxy) | да |
| Proxy | `myc proxy` | выключен по умолчанию | пробрасывает ключ upstream | да, бюджет 15 мс |
| Веб | `myc viz` | read-write / read-only / share | Bearer или локальный | нет |
| Хуки | генерируются `myc wire` | claude / codex / opencode | — | да (post-edit < 2 мс) |

## Приложение B. Сводка бюджетов L3

| Операция | Бюджет | Где живёт |
|---|---|---|
| `myc prime` (кеш-хит) | 26 мс wall / 1.8 мс логики | §12.1 |
| `myc show` | < 3 мс | §3.14 |
| `myc recall` | < 25 мс p99 на 100k | §3.10, `[cross:L2]` |
| `myc remember` | < 5 мс (факт: 2.2 мс) | §12.1 |
| `myc anchor of file:line` | < 1 мс | §7.5 |
| MCP `myc_prime` (прогретый) | < 5 мс | §4.14 |
| хук post-edit | < 2 мс | §6.3 |
| хук pre-compact | 41 мс (таймаут 8000 мс) | §6.2 |
| инъекция в proxy | 15 мс p99, иначе пропуск | §8.6 |
| `/v1/ws/:ws/graph` | < 60 мс p99 | §10.3 |
| первый кадр веб-графа на 10k | < 400 мс | §10.3 |
| детект graft (однократно) | 800 мс, кеш 24 ч | §7.4 |
| вызов graft (фон) | таймаут 1500 мс | §7.2 |
