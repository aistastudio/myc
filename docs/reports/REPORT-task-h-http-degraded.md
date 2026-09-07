# Задача H — громкая деградация вместо молчаливого фолбэка (И2)

## Что сделано

Третья поверхность (HTTP) больше не молчит. `packages/server/src/index.ts` был
5-строчным стабом (`TODO(myc-e4v)`) — реализован M0-срез `myc serve` по
docs/design/03 §8.4: health-тройка `GET /v1/health` (liveness, 200 всегда),
`GET /v1/health/db` (readiness: латентность, версия схемы; 503 при
недоступной БД), `GET /v1/health/index` (качество индекса: 200 + `degraded[]`
при WARN, 503 при FAIL). `degraded[]` собирается из базы — того же источника,
что виден запросом: `myc_health` (куда absorb пишет `state='degraded'` с
причиной → код `health.<component>`), `myc_meta.embed_fingerprint` (пуст →
`embeddings.off`), факт наката векторных миграций (нет →
`vector.unavailable`), очередь jobs (`jobs.failed`). Рядом с кодами —
`warn[{code,msg}]` с причиной и следствием, по образцу
`WARN degraded.embeddings` у `myc recall`. База открывается строго readonly
(тот же подход, что packages/web/src/db.ts). Дата-эндпоинты, Bearer и
мульти-воркспейс остаются за myc-e4v — форма ответов им не мешает.

Поведение absorb без эмбеддингов (кандидаты → `relates`, quality='lexical' +
`degraded_at` в строке узла) уже было реализовано в
`packages/core/src/absorb.ts` и `packages/cli/src/commands/absorb.ts` и не
переделывалось; конверт CLI (`meta.degraded` незатираем) и MCP-проброс
(`structuredContent.meta.degraded`, `verdict_source`) тоже уже были на месте.

## Приёмочный тест (эмбеддинги выключены)

`packages/server/src/index.test.ts` → «И2: эмбеддинги выключены — данные не
потеряны, деградация видна в CLI, MCP и HTTP». Один сценарий против
временного воркспейса (спавн настоящего CLI, MYC_EMBED_DAEMON=0):

- **Данные не потеряны**: два факта в поясе похожести после `absorb
  --no-embed` оба живы (status=active, head_id=null), ребро `relates` в
  edges, `attrs.absorb.quality='lexical'`, `degraded_at` проставлен.
- **CLI**: конверт `absorb --no-embed --json` несёт
  `meta.degraded` ⊇ `degraded.embed` и WARN с тем же кодом.
- **MCP**: `myc_recall` по stdio → `structuredContent.meta.degraded` непуст.
- **HTTP**: `/v1/health/index` → 200, `degraded` ⊇ {`health.absorb`,
  `embeddings.off`}, `ok=false`, warn с причиной, components.absorb=degraded,
  nodes ≥ 2, vectors = 0.

Плюс юнит-тесты: liveness без базы (200/503/503), 404 с машинным кодом.

## Мутации (каждая применялась, прогонялась, откачена)

1. **`degraded` убран из ответа HTTP** (`buildIndexHealth` возвращал
   `degraded: []`, `ok: true`). Поймана:
   `(fail) myc serve (HTTP API, M0) > И2: эмбеддинги выключены…` —
   `expect(indexBody.degraded).toContain("health.absorb")` → `Received: []`.
2. **Кандидаты absorb без эмбеддингов выбрасываются** (в
   `verdictFromFeatures` ветка `cos === null` отдавала `new` вместо
   `related`). Поймана двумя тестами:
   `(fail) classifyPair — порядок правил > без векторов: update и
   contradiction не объявляются никогда` — `Expected: "related", Received:
   "new"` (packages/core/src/absorb.test.ts:146) и приёмочным e2e
   `(fail) myc serve … > И2: эмбеддинги выключены…`.
   Замечено (не моё): CLI-тест absorb.test.ts:363 эту мутацию НЕ ловит —
   его пара даёт jac ≥ 0.9, и вердикт `duplicate` удовлетворяет assertion
   `["related","duplicate"]`, а проверка relates-ребра условная.
3. **Команда затирает `meta.degraded`** (в `okEnvelope` порядок spread
   изменён на `{ degraded: diags.codes, ...meta }`). Поймана:
   `(fail) envelope > command meta cannot clobber degraded` — получено
   `["lie"]` вместо кодов диагностики (packages/cli/src/envelope.test.ts:32).

## Гейты (финальные числа, после отката мутаций)

- `bun test`: **1197 pass, 16 skip, 0 fail** — 1213 тестов, 85 файлов, 68 c.
- `bun run typecheck`: **13/13 пакетов exit 0** (включая @myc/server).

В середине работы в общем прогоне было 2 fail (init/code-intel) и 9 ошибок
typecheck в @myc/code-intel/src/defs.ts — чужая in-flight работа агентов
вне моих границ; к финальному прогону сошлось в зелень без моего участия.

## Файлы

- `packages/server/src/index.ts` — реализация (стаб → health-тройка + И2).
- `packages/server/src/index.test.ts` — приёмочный e2e трёх поверхностей +
  юнит-тесты.
- `packages/core/src/absorb.ts`, `packages/cli/src/envelope.ts` — трогались
  только под мутации, откачены в исходное состояние (подтверждено зелёным
  прогоном).

## Нерешённое / замечания

- Полный HTTP API (аутентификация, `/v1/ws/:ws/…`, data-эндпоинты) — задача
  myc-e4v; здесь осознанно только health-тройка, несущая И2.
- `myc_meta.embed_model` не пишется никем (web/health.ts читает его и всегда
  видит «off»); сервер поэтому смотрит на `embed_fingerprint`. Стоит завести
  задачу: либо писать `embed_model` при fetch модели, либо перевести web на
  `embed_fingerprint`.
- Слабое место покрытия (мутация 2, выше): absorb.test.ts:363 принимает и
  duplicate, и related — кандидат для отдельной задачи на ужесточение.
