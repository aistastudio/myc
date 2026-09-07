# W1 — запись через HTTP (memory-60kc3g7bmf1p)

Просмотрщик перестал быть только для чтения. Правка из интерфейса идёт **тем же
движком команд**, что и терминал: HTTP собирает argv и зовёт `run()` из
`@myc/cli`. Своего слоя мутаций нет — в `packages/web/src` не появилось ни
одного `UPDATE nodes`.

## Файлы

| Файл | Что |
|---|---|
| `packages/web/src/mutate.ts` | **новый**, 615 строк. Путь записи: argv, разбор конверта, exit→HTTP, охрана статусов, if_match по полям, ACL, чтение узла под правку |
| `packages/web/src/server.ts` | POST-маршруты, единый порядок мутации, конверт ответа, `read_only` в boot |
| `packages/web/src/types.ts` | `BootPayload.read_only` стал вычисляемым, добавлены `write_ops[]`, `write_fields[]` |
| `packages/web/src/index.ts` | экспорт записи, шапка пакета |
| `packages/web/src/client/app.ts` | `mutate()` с громким показом ошибок, действия в строке очереди |
| `packages/web/src/client/app.css` | стили действий |
| `packages/web/src/write.test.ts` | **новый**, 18 тестов приёмки |
| `packages/web/src/viz.test.ts` | два теста переписаны под новый контракт |
| `packages/web/package.json` | `@myc/cli` в dependencies |

`packages/server/src` **не тронут** — см. «Не сделано».

## Маршруты

```
POST /api/nodes                → myc create --kind …
POST /api/nodes/<id>           → myc update  (title, body, priority, tags, assignee, acl, estimate)
POST /api/nodes/<id>/op        → claim | release | close | reopen | assign | priority | extend | cancel
GET  /api/nodes/<id>           → поля узла + clk (часы полей под if_match)
```

Соответствие операций командам: `claim`/`extend` → `myc claim --lease` (команда
сама распознаёт продление у держателя), `release` → `myc release`, `close` →
`myc close --reason`, `reopen`/`cancel` → `myc update --status open|cancelled`
(охрана `guardTaskStatus` работает как для человека), `assign`/`priority` →
`myc update`.

## Статусы (S54)

Поля `status` в теле запроса нет вовсе — как у `myc_update` в MCP. Прислали
статус → 422 `precond.use_op` с именем нужной операции:

```
POST {"status":"in_progress"} → 422 precond.use_op
  «статус 'in_progress' не назначается записью: claim — «в работе» берётся
   арендой, иначе задачу считают своей двое»
  hint: POST /api/nodes/<id>/op {"op":"claim"}
```

`cancel` разрешён и печатает `unblocked[]` — тест проверяет, что отменённый
блокер выпускает зависимую задачу.

## Конкурентная правка

Конфликт считается **по полям**, а не по узлу: часы берутся из `field_clock`
(`hlc` читается `CAST(... AS TEXT)` — значение уже за 2^53, число потеряло бы
счётчик). Две вкладки, правящие разные поля, обе проходят и обе видны в оплоге;
две вкладки на одном поле — 409 `conflict.version` со списком полей и текущими
часами. `if_match` разрешён только для полей самого запроса: объявить чужое поле
значило бы получить отказ там, где per-field LWW справляется сам.

## Гейты

```
bun test packages/web/ packages/server/
  57 pass · 0 fail · 1552 expect() · 4 файла · 2.24 s   (из них 18 новых тестов)

bun run typecheck
  13 пакетов, все Exited with code 0

bun run deps-check   → passed for 13 packages
bun run build        → bundle 140 modules, compile dist/myc — ок
```

Живая проверка настоящего `myc viz` (не подмены): `POST /api/nodes/<id>` →
200 за **3 мс**, `myc show` из другого процесса видит правку; тот же сценарий на
скомпилированном `dist/myc` — 200 за **2 мс**. Динамический импорт `@myc/cli`
переживает `bun build --compile`.

## Три мутации

### 1. Обойти общий путь записи — обновить строку узла напрямую

```ts
const direct = new Database(opts.dbPath);
direct.run("UPDATE nodes SET title = ?2 WHERE id = ?1", [target, body["title"]]);
outcome = { ok: true, status: 200, data: { id: target }, degraded: [], warn: [] };
```

**Поймана, 3 теста упали** (51 pass / 3 fail):

```
(fail) приёмка: интерфейс и CLI дают один оплог > правка полей и переходы состояния совпадают операция в операцию
(fail) конкурентная правка > две вкладки правят разные поля — не теряется ни одна
(fail) конкурентная правка > одно поле из двух вкладок — 409 с кодом, а не тихая перезапись
```

Диагностика точная — видно, что операции просто нет:

```
Expected to contain: "set|node|title|\"правка вкладки A\""
Received: [ …, "set|node|title|\"общая задача\"", …, "set|node|body|\"правка вкладки B\"" ]
```

Строка изменилась, оплог — нет; при синхронизации правка исчезла бы бесследно.

### 2. Сделать ошибку ACL молчаливой (200 и проигнорировать)

```ts
const denied = aclDenial(db, target, principalOf());
if (denied !== undefined) {
  return json({ ok: true, data: { id: target }, meta: { degraded: [] }, warn: [] });
}
```

**Поймана, 1 тест упал** (53 pass / 1 fail):

```
(fail) ошибка записи громкая (И2) > отказ ACL — 403 с кодом, правка не применена
  expect(res.status).toBe(403)   Expected: 403   Received: 200
```

### 3. Разрешить HTTP выставлять `in_progress` записью статуса

```ts
if (typeof body["status"] === "string" && body["status"] === "in_progress") {
  return { argv: ["update", id, "--status", "in_progress"], clockFields: ["status"] };
}
```

**Поймана, 1 тест упал** (53 pass / 1 fail):

```
(fail) статус зарабатывается, а не назначается (S54) > in_progress записью статуса — отказ с именем операции
  expect(res.body.error?.code).toBe("precond.use_op")
  Expected: "precond.use_op"   Received: "precond.use_claim"
```

Отдельно ценно, что видно во втором эшелоне: до записи дело всё равно не дошло —
отказал `guardTaskStatus` в CLI (`precond.use_claim`). То есть охрана статусов
живёт в движке, а HTTP лишь обязан не подводить к ней вслепую; тест ловит именно
это — отказ должен приходить от поверхности и называть операцию.

## Найденные расхождения поверхностей (не правил — вне границ)

1. **`release` у MCP и у CLI пишут разный оплог.** `GraphStore.releaseLease`
   сам ставит `status='open'` одним CAS-стейтментом и журналит ОДНУ операцию
   `claim/release`. MCP (`packages/mcp/src/dispatch.ts`, ветка `release`) после
   этого ещё зовёт `updateNode({status:"open"})` по устаревшему снимку — лишняя
   `set status` в оплоге, которой у `myc release` нет. HTTP взял путь CLI.
2. **`note` есть у MCP и нет у CLI.** MCP собирает заметку двумя прямыми
   вызовами стора (`createNode` + ребро `replies_to`), а команды CLI для
   произвольных рёбер не существует (`dep add` умеет только blocks/blocked-by).
   HTTP отвечает 501 `unsupported.op` с этой причиной, а не изобретает третий
   вариант «заметки».
3. **`cancel` есть у CLI и у HTTP, но нет у MCP.** Это ровно та асимметрия, что
   породила P0 с `release`: у человека способ отменить задачу есть, у агента —
   нет.
4. **Причина `reopen`/`cancel` записывается некуда.** У `myc update` поля нет,
   заметкой она стать не может (п. 2). Причина требуется, но ответ несёт
   `WARN reason.unwritten` и код в `meta.degraded[]` — по образцу
   `note.unwritten` у MCP. Молча терять человеческое обоснование нельзя.
5. **`myc create` на дубликате контента отдаёт `internal.unexpected` (exit 1).**
   `UNIQUE constraint failed: nodes.scope, nodes.kind, nodes.content_hash`
   доезжает до пользователя как внутренняя ошибка и как HTTP 500, хотя это
   штатное «такой узел уже есть». Всплыло при написании приёмки: две дословно
   одинаковые задачи создать нельзя, поэтому тест разводит их одной меткой и
   вычищает её перед сравнением оплогов.

## Не сделано / за границей

* **`packages/cli/src/commands/viz.ts` не тронут** и не понадобился: путь записи
  просмотрщик поднимает сам (`cliRunner` с динамическим импортом `@myc/cli`), и
  `myc viz` получил POST-маршруты без единой правки в CLI. Если нужен флаг
  `myc viz --read-only`, он потребует одной строки там — опция
  `VizServerOptions.readOnly` уже есть и покрыта тестом.
* **`packages/server/src` (`myc serve`) не тронут.** Его собственная шапка
  говорит: data-эндпоинты — задача myc-e4v. Дублировать туда маршруты значило бы
  завести вторую копию контракта до того, как у сервера появятся
  аутентификация и воркспейс в пути. Когда myc-e4v дойдёт до записи, брать надо
  тот же `@myc/web/mutate.ts`, а не писать заново.
* **ACL-проверка включается только при `myc_meta.acl_enforced = 1`** (§10.3,
  локально по умолчанию 0). Иначе HTTP оказался бы строже терминала — та же
  асимметрия, только в другую сторону. Когда появится командный режим, такую же
  проверку надо ставить в CLI и MCP, а не только здесь.
* Правка узла из интерфейса доступна пока в очереди ready (взять / отпустить /
  закрыть / отменить / приоритет). Форма правки текста на экране графа —
  отдельная задача: маршруты и `GET /api/nodes/<id>` с часами полей для неё уже
  готовы.
