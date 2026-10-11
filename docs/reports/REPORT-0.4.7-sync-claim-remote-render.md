# Отчёт: релиз 0.4.7 — обмен на воркспейсах с захватами и удалённый человеческий вывод

Коммит: `d0be635` (main). Задачи: memory-6js4sp142hvt, memory-fzq0wvd7kgv9.

## Что было

Живые симптомы на машине пользователя (myc 0.4.6):

| Симптом | Причина |
|---|---|
| `myc sync --dry-run` в `~/src/qmatic` → `would push 0` при 2036 строках оплога | сборка пакета падала на первой `op='claim'`-строке (56 из 2036) |
| `myc bug` с `MYC_SERVER` создавал узел и падал на рендере → дубли | удалённая ветка отдавала `answer.data` сервера, рендер ждал `CreateData` |
| `myc prime`, `myc ready` против сервера — `TypeError` | тот же класс: форма сервера в рендере локального вида |

Корень класса: `--json` ветвится в каркасе ДО `renderHuman` (index.ts:356 против 393), поэтому тесты проверяли форму конверта, а рендер — никогда.

## Что сделано

**(1) Обмен** — `packages/core/src/sync.ts`: белый список `REPLICABLE_OPS ('set','inc','edge_add','edge_del')` в `opsForPeerQuery`; тот же набор, что принимает `parseOp`. Список белый намеренно: новый журнальный вид обязан попасть сюда осознанно.

**(2) Удалённые рендеры** — каждая удалённая ветка нормализует ответ в локальную форму: `CreateData`, `UpdateData`, `ClaimData`, `ListData`, `NodeView`, `ReadyData`, `PrimeData`. Create дополнительно перестал молча терять `--tag/--assign/--acl/--estimate/--repo` (теперь передаются) и отвечает отказом на `--parent/--dep/--reply-to/--as` (сервер их не умеет).

**(3) Сервер, аддитивно** (старый клиент новые поля игнорирует): `ws_node_get` + `lease_holder/lease_expires`; `ws_node_edges` + статусы соседей; `ws_nodes_list` + `attrs`; `node_head` + `status/priority/attrs`; `claimTask` → `ClaimAnswer` с `prev_status/type/priority`; `ReadyRow` + `type/estimate_min`; `InProgressRow` (вместо подмены `updated_at`).

**(4) Честность незмеримого** — `ReadyData.blocked/in_progress/repo_*` опциональны: подвал печатает счётчик только когда измерен. Локальный путь их всегда заполняет, удалённый — молчит.

**(5) Сторожи**:

- `callHuman` в `remote.pg.test.ts` — все семь удалённых команд в человеческом режиме обязаны вернуть строку и не бросить (11 pass, 0 fail);
- claim-строка в посеве `sync.test.ts` — отбор к пиру её пропускает; мутация (снятие фильтра) роняет 4 теста;
- `parity.pg.test.ts`: `normalize` разбирает attrs-строку — jsonb сортирует ключи, SQLite держит порядок записи, сравнение строк ловило бы разницу порядка, а не данных.

## Числа приёмки

| Прогон | Результат |
|---|---|
| `bun test` core + server + store-sqlite (юнит) | 808 pass, 0 fail |
| `bun test` cli, чистое окружение + pg | 2043 pass, 7 fail (все 7 — предсуществующие: federation.multirepo и wire-user.statusline, падают и на чистом `622ce0e`, доказано `git stash`) |
| pg-тесты server + cli (`MYC_PG_URL`, pgvector/pg17) | 158 pass, 0 fail |
| sync.test.ts (ядро) | 16 pass; мутация фильтра — 4 fail |
| typecheck | все пакеты, 0 ошибок |
| `myc run -- bun run build` | dist/myc, smoke ok |
| `pack:npm` | dist/aistastudio-myc-0.4.7.tgz, 5.11 МБ |
| Живой смоук: `~/src/qmatic` → myc.aistastudio.tech | `push 1980 op` (2036 − 56 claim), 3 круга; повтор `push 0, pull 0`; сервер: `GET /v1/ws` → qmatic, 134 узла |

## Осталось за релизом (нужен доступ/решение владельца)

1. `npm publish` тарбола `dist/aistastudio-myc-0.4.7.tgz` — credentials у владельца.
2. Пересборка серверного образа на `myc.aistastudio.tech` (git pull + docker compose build server): сервер 0.4.6 упадёт на pull, как только на нём появятся claim-строки от удалённых захватов (серверный `collectForPeer` — тот же код ядра).
3. Задачи memory-6js4sp142hvt / memory-fzq0wvd7kgv9 не закрыты: бинарь main знает swarm-схему v10, база memory — v11 (ветка ade-wave0). Закрыть после merge.
4. `git push origin main` — коммит d0be635 лежит локально.

## Памятка оператору

`MYC_SERVER` в окружении уводит ЛЮБУЮ локальную команду в `precond.no_remote` и роняет юнит-тесты cli (1174 падения — не регрессии). Тесты гонять с `env -u MYC_SERVER -u MYC_TOKEN`; `myc run` — с `MYC_SERVER=`.
