# npm-пакет: myc ставится и работает из реестра

Задача `memory-6n60x98qnwry` (P0). Состояние: **пакет собран, упакован и
проверен установкой из тарбола в чистом каталоге**. Ничего не опубликовано —
ни в npm, ни в git, как и требовалось.

Артефакт: `dist/myc-cli-0.1.0.tgz` — **3.16 МБ сжатый** (3 309 207 байт),
11.87 МБ распакованный, **9 файлов**. Собирается одной командой:

```
bun run pack:npm
```

---

## Решение 1. Один пакет с бандлом, а не граф workspace-пакетов

**Публикуется ровно один пакет — `@myc/cli`.** Остальные 12 `@myc/*` вшиты в
`dist/myc.js` (1.11 МБ, 177 модулей) и в реестр не попадают.

Почему не граф:

* Версии. Граф из 13 пакетов надо версионировать синхронно на каждый релиз;
  частично доехавшая публикация даёт установку, которая ставится, но не
  работает. Одна версия — один тарбол — такого состояния не существует.
* Внутренние пакеты — деталь реализации (это же говорит и постановка). Опубликовав
  `@myc/core`, мы обязуемся держать его API: кто-то поставит его напрямую.
* Резолюция. `workspace:*` в реестре не существует; при публикации графа их
  надо переписывать на точные версии — ещё один шаг, который молча
  расходится с реальностью.
* Холодный старт. Один файл вместо сотен разрешаемых модулей.

**Ключевая деталь: манифест пакета ГЕНЕРИРУЕТСЯ**, а не берётся из
`packages/cli/package.json`. У того файла две несовместимые роли: внутри
воркспейса он указывает на исходники (`exports: ./src/index.ts`, зависимости
`workspace:*` — так его видит `@myc/mcp`), а в реестре обязан указывать на
бандл и не иметь ни одной workspace-ссылки. `scripts/pack-npm.ts` собирает
чистый каталог `dist/npm/` и кладёт туда ровно то, что перечислено явно.
Побочный эффект — гигиена тарбола не держится на `.npmignore` и `files`:
тесты, стенды, bench, `.myc`, стенограммы и отчёты **физически не могут** туда
просочиться, потому что их никто не копирует.

### Что лежит в пакете

| файл | байт | зачем |
|---|---:|---|
| `dist/myc.js` | 1 109 527 | весь myc одним бандлом, все `@myc/*` внутри |
| `dist/worker.ts` | 56 725 | воркер батч-пула эмбеддера (см. ниже) |
| `vendor/ort/ort-wasm-simd-threaded.wasm` | 11 246 032 | ONNX-рантайм |
| `vendor/ort/ort-wasm-simd-threaded.mjs` | 24 618 | клеевой модуль к нему |
| `bin/myc.js` | 4 479 | запуск + отказ под Node |
| `bin/preflight.js` | 2 263 | postinstall: сказать про Bun, если его нет |
| `README.md` | 5 892 | из корня, пишет второй агент |
| `package.json` | 673 | сгенерирован |
| `vendor/ort/README-onnxruntime.txt` | 259 | атрибуция MIT |

Два нетривиальных места, оба задокументированы в `scripts/pack-npm.ts`:

* **`dist/worker.ts` с JS внутри.** `packages/embed/src/pool.ts` поднимает
  воркер как `new Worker(new URL("./worker.ts", import.meta.url))`. Бандлер
  Bun такую ссылку не разрешает — проверено обеими формами (в переменной и
  инлайном), отдельного чанка не появляется ни в одной. Поэтому воркер
  собирается вторым входом и кладётся рядом с бандлом под тем именем, которое
  ищет рантайм. Расширение `.ts` на содержимом-JS законно: Bun разбирает такой
  файл как TypeScript, а JS — его подмножество. Альтернатива была бы правкой
  `pool.ts` под нужды упаковщика — она бы не помогла, бандлер не разрешает и
  инлайн-форму.
* **`vendor/ort` вместо зависимости `onnxruntime-web`.** JS-часть ort бандлер
  вшивает в `dist/myc.js`, но `.wasm` грузится с диска. Тянуть весь
  `onnxruntime-web` ради двух файлов — это ~180 МБ распакованными на каждую
  установку. Кладём ровно те два файла (11 МБ), а `bin/myc.js` выставляет
  `MYC_ORT_WASM_DIR` на них. Лицензия onnxruntime — MIT, атрибуция рядом.

### Единственная рантайм-зависимость: `sqlite-vec@0.1.9`

Найдено проверкой, а не чтением: в чистом каталоге `myc reindex` падал в
`precond.vec0_unavailable`. Автопоиск vec0 в `@myc/store-sqlite` смотрит рядом
с `process.execPath` (у собранного бинаря это `dist/`, у npm-пакета — каталог
`bun`, не наш) и в кеш `bun install`, которого при установке через npm нет.
Решено без правки исходников: `sqlite-vec` объявлен зависимостью (npm сам
ставит платформенный пакет по `os`/`cpu`, **161 896 байт**), а `bin/myc.js`
резолвит из него точный путь и кладёт в `MYC_SQLITE_VEC`. Явно заданное
пользователем значение не трогается.

---

## Решение 2. Node против Bun: отказ вместо стека

myc требует Bun и это сказано прямо: `engines: { bun: ">=1.3.0" }`, поля
`node` в `engines` нет сознательно.

Без заглушки пользователь получал бы вот это:

```
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data,
and node are supported by the default ESM loader. Received protocol 'bun:'
```

`bin/myc.js` написан голым JS без единого `bun:`-импорта — его обязан уметь
разобрать Node. Проверка рантайма стоит ДО динамического импорта бандла:
статический импорт Node разрешил бы до первой строки тела модуля, и мы бы
снова упали на `bun:sqlite`, не успев ничего сказать.

Проверено обе ветки (полный вывод ниже, раздел «Отказ под Node»): текст
называет причину («хранилище на `bun:sqlite`, которого в Node нет»), и способ —
разный в зависимости от того, есть ли Bun в системе: если есть — `bun x myc`,
если нет — команда установки. Код выхода 1.

Остаётся один случай, который заглушка закрыть не может: если Bun не
установлен ВООБЩЕ, shebang `#!/usr/bin/env bun` даёт `env: bun: No such file or
directory` (код 127) ещё до нашего кода — выполнить его просто некому.
Поэтому добавлен `postinstall` (`bin/preflight.js`, запускается тем же node,
что ставил пакет): он громко говорит про Bun прямо на установке. Установку не
роняет — пакет разложен правильно, не хватает только рантайма, и это чинится
без переустановки.

Альтернатива — shebang `#!/usr/bin/env node` и перезапуск через bun — отвергнута
по цене: старт node ~25 мс на КАЖДЫЙ вызов при бюджете холодного старта 60 мс
(И1).

---

## Решение 3. Модели эмбеддера: ничего не качается при установке

**При `npm install` не скачивается ни одного байта моделей.** Установка — это
3.16 МБ тарбола плюс 188 КБ `sqlite-vec`; сети во время самой установки myc не
касается.

Модель — отдельная явная команда. Числа замерены в чистом окружении:

| | размер | время |
|---|---:|---:|
| `myc models fetch multilingual-e5-small-q8` (по умолчанию) | 129.1 МБ на диске (`model.onnx` 118.3 МБ + `tokenizer.json` 17.1 МБ + config) | **7.3 с** |
| `myc models fetch bge-small-en-v1.5-q8` (английская) | 34.2 МБ | не качал |

Кладётся в `~/.cache/myc/models/<id>/`, а не внутрь пакета: переживает
переустановку и обновление myc.

**Что работает без модели:** всё, кроме векторной ветки поиска. Задачи,
`init`, `prime`, `ready`, `recall` на BM25 — полностью. Деградация громкая
(И2), её видно в трёх местах: `myc init` пишет строку «эмбеддинги — не
скачаны», каждая выдача несёт `WARN degraded.embeddings`, а `myc recall`
дописывает в подвал `bm25 only`.

**Что не работает:** семантический поиск. `myc recall` возвращает только
лексические совпадения и честно говорит «векторная ветка не участвовала».

Проверено, что после `models fetch` семантика реально поднимается из
установленного пакета — то есть вшитый ort и вендоренный `.wasm` рабочие:
`myc reindex` даёт `fingerprint local:onnx-wasm:multilingual-e5-small-q8:384:l2`,
`myc recall` переключается на `vec rrf(k=60)` за 13.5 мс.

---

## Цена упаковки: холодный старт

Замер `myc --version`, 10 прогонов установленного пакета против 5 прогонов
собранного бинаря `dist/myc` на той же машине:

```
npm-пакет (bun + бандл):  64.5 57.1 59.5 58.7 55.5 59.1 57.0 61.8 57.3 57.8   медиана ~58 мс
dist/myc (--compile --bytecode): 132.5 43.1 47.0 45.8 54.6                    медиана ~47 мс
```

**Пакет стартует примерно на 11 мс медленнее бинаря** и упирается в потолок
бюджета И1 (60 мс). Причина известна и записана в `scripts/build.ts`:
`--bytecode` работает только вместе с `--compile`, то есть только для бинаря;
JS-бандл платит за разбор при каждом старте. Это надо либо принять, либо
публиковать платформенные бинари отдельными пакетами — см. «Что осталось».

---

## Проверка: полный прогон в ЧИСТОМ каталоге

Установка **из тарбола**, не из исходников:

```
npm install --global --prefix <tmp>/prefix dist/myc-cli-0.1.0.tgz
```

`HOME` подменён на пустой каталог, рабочий каталог пустой, `MYC_SQLITE_VEC` и
`MYC_ORT_WASM_DIR` сняты — ничто из репозитория в прогон не протекает.

```
=== окружение ===
myc:   /private/tmp/claude-501/-Users-egortaranin-src-memory/1785adaf-654d-4f90-8f2d-cd417e3a5bb2/scratchpad/clean/prefix/bin/myc
bun:   1.3.14    node: v24.16.0    npm: 11.13.0
HOME:  /private/tmp/claude-501/-Users-egortaranin-src-memory/1785adaf-654d-4f90-8f2d-cd417e3a5bb2/scratchpad/clean/home
cwd:   /private/tmp/claude-501/-Users-egortaranin-src-memory/1785adaf-654d-4f90-8f2d-cd417e3a5bb2/scratchpad/clean/work   (пусто до git init: 0 файлов)

$ myc --version
myc 0.1.0 (schema 1)
[exit=0]

$ git init -q .
[exit=0]

$ myc init
myc 0.1.0 · repo /private/tmp/claude-501/-Users-egortaranin-src-memory/1785adaf-654d-4f90-8f2d-cd417e3a5bb2/scratchpad/clean/work (git) · slug=work

  ✓ .myc/myc.db          sqlite, schema v9, wal
  ✓ .myc/workspace.toml  slug=work
  · graft                найден
  · код-интеллект        builtin (code_intel=builtin): символы и fan_in по тексту, callers/search/map недоступны
  · эмбеддинги           не скачаны — модель отдельной командой `myc models fetch`; задачи работают и без неё (BM25)
  · личный ~/.myc        не создан — создать: myc init --global

дальше:
  myc task "<первая задача>" -p P1

готово за 29 мс · сеть не использовалась
WARN degraded.embeddings: модель эмбеддингов не скачана — поиск работает на BM25 до `myc models fetch`
[exit=0]

$ myc task проверить пакет из реестра --priority 1
work-k0dm1h1gvncj  task  P1  open  free
7 мс
[exit=0]

$ myc task второй пункт, чтобы ready не был пустым --priority 2
work-a4j8wwm3jcd6  task  P2  open  free
6 мс
[exit=0]

$ myc ready
work-k0dm1h1gvncj  P1  task  проверить пакет из реестра               unblocks 0  —  free
work-a4j8wwm3jcd6  P2  task  второй пункт, чтобы ready не был пустым  unblocks 0  —  free
2 ready · 0 blocked · 0 in_progress · 4 мс
[exit=0]

$ myc prime
myc 0.1.0 · ws=work sqlite · 2 узлов · idx ok · 2026-09-07T13:58:35.889Z

# READY 2 из 2
work-k0dm1h1gvncj  P1 task  проверить пакет из реестра  unblocks 0
work-a4j8wwm3jcd6  P2 task  второй пункт, чтобы ready не был пустым  unblocks 0

# NEXT
myc ready --claim        взять верхнюю задачу атомарно
myc recall "<тема>"      факты и решения по теме
myc remember "<факт>"    записать вывод

387 симв · 4 мс · cache miss · сессия 1785adaf
[exit=0]

$ myc recall пакет
1.    · work-k0dm1h1gvncj task L1 ?    все  2026-09-07  проверить пакет из реестра
1 из 1 · bm25 only · 245.3 мс · 83 симв из 2000 · 1 без охвата
WARN degraded.embeddings: прогрев эмбеддера выключен (--embed-timeout 0): холодный ONNX стоит ~184 мс при бюджете recall 25 мс — векторная ветка не звалась
WARN degraded.retrieval: project: vector-branch: эмбеддинг запроса недоступен (нет эмбеддера или кеша) — векторная ветка не участвовала
[exit=0]

=== семантика: модель + векторный индекс ===

$ myc models list
ID                        STATUS  DIM  SIZE  FINGERPRINT
multilingual-e5-small-q8  absent  384  -     -
bge-small-en-v1.5-q8      absent  384  -     -
[exit=0]

$ myc models fetch multilingual-e5-small-q8
modelId         multilingual-e5-small-q8
dir             /private/tmp/claude-501/-Users-egortaranin-src-memory/1785adaf-654d-4f90-8f2d-cd417e3a5bb2/scratchpad/clean/home/.cache/myc/models/multilingual-e5-small-q8
downloaded      ["model.onnx","tokenizer.json","config.json"]
skipped         []
alreadyPresent  false
[exit=0]

$ myc models list
ID                        STATUS   DIM  SIZE     FINGERPRINT
multilingual-e5-small-q8  present  384  129.1MB  f80102d3f2a1
bge-small-en-v1.5-q8      absent   384  -        -
[exit=0]

$ myc remember тарбол собирается скриптом scripts/pack-npm.ts и ставится через npm i -g
work-gvkszpnx3pqj memory L1 · охват session 1785adaf-654d-4f90-8f2d-cd417e3a5bb2 · acl team
queue     embed, absorb(эвристика — chat-LLM выключен)
10.7 мс
[exit=0]

$ myc reindex
scans        1
enqueued     0
claimed      0
embedded     0
copied       0
skipped      0
cleaned      0
failed       0
batches      0
vectors      3
fingerprint  local:onnx-wasm:multilingual-e5-small-q8:384:l2
took_ms      60974
[exit=0]

$ myc recall как собирается пакет
0 из 0 · пусто · project: ни один из 3 видимых узлов не совпал с запросом (строгое И и 2 ступ. отката, 3 терминов — не совпало ни на одной); векторная ветка не участвовала (unavailable) · 11.1 мс · 0 симв из 2000
WARN degraded.embeddings: прогрев эмбеддера выключен (--embed-timeout 0): холодный ONNX стоит ~184 мс при бюджете recall 25 мс — векторная ветка не звалась
WARN degraded.embeddings: прогрев эмбеддера запущен в фоне (работа embed_warm в очереди jobs) — эта выдача без вектора, следующая будет с ним
WARN degraded.retrieval: project: vector-branch: эмбеддинг запроса недоступен (нет эмбеддера или кеша) — векторная ветка не участвовала
[exit=0]

=== повторный recall: вектор прогрелся, ветка участвует ===

$ myc recall "как собирается пакет"   (прогон 1)
1. 1.13 work-k0dm1h1gvncj task L1 ?    все  2026-09-07  проверить пакет из реестра
2. 0.17 work-gvkszpnx3pqj memory L1 ses  все  2026-09-07  тарбол собирается скриптом scripts/pack-npm.ts и ставится через npm i -g
3. -1.30 work-a4j8wwm3jcd6 task L1 ?    все  2026-09-07  второй пункт, чтобы ready не был пустым
3 из 3 · vec rrf(k=60) · только вектор, слабо · 37 мс · 311 симв из 2000 · 2 без охвата
WARN degraded.retrieval: project: vector-only: лексика не дала ни одного кандидата — вся выдача построена на одном слабом векторе без подтверждения (S47: MRR ~0.24 на этой модели)
[exit=0]

$ myc recall "как собирается пакет"   (прогон 2)
1. 1.13 work-k0dm1h1gvncj task L1 ?    все  2026-09-07  проверить пакет из реестра
2. 0.17 work-gvkszpnx3pqj memory L1 ses  все  2026-09-07  тарбол собирается скриптом scripts/pack-npm.ts и ставится через npm i -g
3. -1.30 work-a4j8wwm3jcd6 task L1 ?    все  2026-09-07  второй пункт, чтобы ready не был пустым
3 из 3 · vec rrf(k=60) · только вектор, слабо · 14.3 мс · 311 симв из 2000 · 2 без охвата
WARN degraded.retrieval: project: vector-only: лексика не дала ни одного кандидата — вся выдача построена на одном слабом векторе без подтверждения (S47: MRR ~0.24 на этой модели)
[exit=0]
```

### Отказ под Node

```
### Bun в системе есть
$ node <installed>/bin/myc.js ready

  myc requires Bun — it cannot run on Node.

  myc запущен под Node 24.16.0, а он работает только на Bun: хранилище
  построено на встроенном в Bun `bun:sqlite`, которого в Node нет.

  Bun у вас установлен — запускайте через него:
      bun x myc <команда>
  либо переустановите пакет средствами bun:
      bun add -g @myc/cli
[exit=1]

### Bun в PATH нет
$ env PATH="/opt/homebrew/bin:/usr/bin:/bin" node <installed>/bin/myc.js ready

  myc requires Bun — it cannot run on Node.

  myc запущен под Node 24.16.0, а он работает только на Bun: хранилище
  построено на встроенном в Bun `bun:sqlite`, которого в Node нет.

  Установите Bun (>= 1.3.0) и повторите:
      curl -fsSL https://bun.sh/install | bash        # macOS, Linux, WSL
      powershell -c "irm bun.sh/install.ps1 | iex"    # Windows

  После установки: myc --version
[exit=1]

### postinstall на машине без Bun

  ┌─ @myc/cli установлен, но запускаться пока не будет ────────────┐
  │ myc работает только на Bun (хранилище на bun:sqlite).          │
  │ Bun в системе не найден.                                       │
  │                                                                │
  │   curl -fsSL https://bun.sh/install | bash                     │
  │                                                                │
  │ После этого: myc --version                                     │
  └────────────────────────────────────────────────────────────────┘
[exit=0]
```

### Гигиена тарбола

Поиск по списку содержимого шаблоном `test|bench|\.myc/|стеног|REPORT|scratch|fixtures|spec` —
**совпадений ноль**. Полное содержимое (все 9 файлов):

```
     4479  package/bin/myc.js
  1109527  package/dist/myc.js
     2263  package/bin/preflight.js
      673  package/package.json
     5892  package/README.md
    24618  package/vendor/ort/ort-wasm-simd-threaded.mjs
    56725  package/dist/worker.ts
      259  package/vendor/ort/README-onnxruntime.txt
 11246032  package/vendor/ort/ort-wasm-simd-threaded.wasm
```

Занимаемое место после `npm i -g`: **12 МБ** пакет + **188 КБ** `sqlite-vec`.
Плюс 129 МБ модели, если пользователь её попросит.

### Тесты репозитория

`bun test` целиком: **2002 pass, 16 skip, 1 fail**, 26 765 проверок, 136 файлов,
151 с.

Единственное падение — `packages/retrieval/src/hybrid.test.ts`, тест
«эксперимент myc-dze.3 — якоря против перефразировок → ОТЧЁТ: recall@10…»:
**таймаут 5000 мс при фактических 7174 мс**. Пакет `@myc/retrieval` я не
трогал; воспроизводится и в одиночном прогоне файла (54 pass, 1 fail), то есть
это медленный эксперимент на этой машине, а не следствие правок. Файлы,
которые я менял, покрыты: `packages/cli/src/index.test.ts` +
`packages/cli/src/commands/init.test.ts` — 79 pass, 0 fail.

---

## Что изменено в репозитории

| файл | что |
|---|---|
| `scripts/pack-npm.ts` | **новый.** Сборка `dist/npm/` + `npm pack`. Единственное место, где записан рецепт пакета |
| `packages/cli/bin/myc.js` | **новый.** Точка входа пакета: отказ под Node, `MYC_ORT_WASM_DIR`, `MYC_SQLITE_VEC` |
| `packages/cli/bin/preflight.js` | **новый.** postinstall-предупреждение про Bun |
| `package.json` (корень) | добавлен скрипт `pack:npm`. Остаётся `private: true` — корень не публикуется |
| `packages/cli/package.json` | версия `0.0.0` → `0.1.0`. Остаётся `private: true`: в реестр идёт сгенерированный манифест |
| `packages/cli/src/index.ts` | `CLI_VERSION` `0.0.0` → `0.1.0` |
| `packages/cli/src/commands/init.ts` | `const version = "0.0.0"` → `CLI_VERSION` |
| `packages/cli/src/index.test.ts` | ожидание `"myc 0.0.0"` → `` `myc ${CLI_VERSION}` `` |

Две последние правки — не косметика: `myc init` печатал версию из **третьего**
захардкоженного места, и в первом прогоне из пакета шапка `init` говорила
`myc 0.0.0`, пока `--version` и `prime` говорили `0.1.0`. Теперь источник один,
а расхождение манифеста с `CLI_VERSION` **роняет сборку пакета** —
`scripts/pack-npm.ts` сверяет их перед бандлингом.

Правок в исходниках вне `packages/cli/**` не потребовалось: и ort, и vec0
настраиваются переменными окружения, которые выставляет `bin/myc.js`.

## Что осталось

1. **LICENSE в корне — блокирует публикацию.** Файла нет, поэтому в манифесте
   нет поля `license`, а это юридически «все права защищены». `pack-npm.ts`
   печатает предупреждение на каждой сборке; как только файл появится, он сам
   попадёт в тарбол и включит `"license": "MIT"`. Корневые `README`/`LICENSE` —
   граница второго агента, я их не трогал.
2. **MCP отдаёт версию `0.0.0`.** `packages/mcp/src/command.ts:134` строит
   `new McpServer({...})` без поля `version`, а `server.ts:106` подставляет
   умолчание `"0.0.0"`. Клиенты MCP видят неправильную версию сервера.
   Однострочная правка `version: CLI_VERSION`, но файл за границей задачи —
   не трогал.
3. **Устаревшая подсказка `myc doctor`.** `myc reindex` при недоступном vec0
   советует `myc doctor`, а такой команды нет (`unknown command 'doctor'`).
   Файл за границей.
4. **Проверено только на darwin-arm64.** Кросс-платформенность заложена
   (`sqlite-vec` ставится по `os`/`cpu`, `.wasm` архитектурно-независим,
   ветки путей в `bin/myc.js` есть для linux и windows), но не проверена.
   Отдельная задача — прогон в linux-контейнере.
5. **На macOS векторный поиск требует Homebrew-сборки sqlite.** Системная
   `/usr/lib/libsqlite3.dylib` не умеет грузить расширения, а через npm её не
   поставишь. В моём прогоне нашлась
   `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`. На Mac без неё vec0 не
   поднимется и поиск уйдёт на BM25 — громко, но уйдёт. Это стоит одной
   строкой в README (граница второго агента). На Linux системная
   `libsqlite3.so.0` расширения обычно умеет.
6. **~11 мс холодного старта против бинаря.** Если это неприемлемо — путь
   известен: публиковать платформенные пакеты с `bun build --compile
   --bytecode` внутри и выбирать их через `optionalDependencies`, как делает
   esbuild. Цена — 5 тарболов по ~70 МБ и кросс-сборка в CI.
7. **Публикация.** `npm publish` не запускался и не будет: сделана готовность.
   Когда решите публиковать: `bun run pack:npm && npm publish dist/npm
   --access public`. Область `@myc` в реестре свободна, имя `myc` — занято.
