# REPORT W10 — ростер моделей как данные (memory-vrbf0g4v5vxd)

## Что сделано

Ростер моделей роя — данные + CLI, без интерфейса (интерфейс — отдельная задача).

**Данные (@myc/swarm).** Таблицы `swarm_model` и `swarm_model_price` в общей
`.myc/myc.db`, по схеме docs/design/04 §2.2, с дополнениями задачи:
`harness` (CHECK: claude|opencode|kimi), `effort` (low|medium|high),
`strengths` (JSON — место под классы задач, наполняет атрибуция W11),
`active` (мягкое удаление). Цена — факт с датой: история
`(model_id, valid_from)`, действующая = max(valid_from ≤ now), протухшая
(> 90 дней, PRICE_STALE_MS) помечается `priceStale` при чтении.
Миграции — свои (packages/swarm/src/migrations/), учёт в
`swarm_schema_migrations`, накат в BEGIN IMMEDIATE целиком: гонка двух
процессов сериализуется, дрейф DDL ловится чек-суммой (schema.checksum),
база новее бинаря — schema.newer. Свой мини-движок, не migrate() из
store-sqlite: deps-check разрешает swarm только @myc/core.

**CLI.** `myc model add|update|list|show|disable|enable` (имя `model` —
по §2.10.1; рядом живёт `models` про эмбеддинги). Приёмка пройдена на
боевом бинаре: завести → изменить → прочитать `--json` → disable;
неизвестный харнесс — `usage.harness`, exit 2, записи-призрака нет.
Открытие базы повторяет дисциплину store.ts (STORE_PRAGMAS, ws.not_initialized
→ NOWS 7).

## Файлы

- packages/swarm/src/migrations/{000-bookkeeping,types,001-swarm-model,002-swarm-model-price,index}.ts
- packages/swarm/src/{schema,roster,index}.ts
- packages/swarm/src/{roster.test,roster.race.test,roster.race.worker}.ts
- packages/cli/src/commands/{roster,roster.test}.ts
- packages/cli/src/main.ts (импорт + регистрация), packages/cli/package.json (+@myc/swarm), bun.lock

## Мутации (все пойманы)

1. Произвольный харнесс разрешён → красные: swarm roster.test (2 теста:
   add/update с неизвестным харнессом, призрак ловится count=0) и cli
   roster.test (1 тест). CHECK схемы — второй барьер на прямой INSERT.
2. Цена без даты (valid_from=0) → красные 4 теста: хранимая дата ≠ переданной,
   свежая цена стала «протухшей», история цен схлопнулась.
3. Физический DELETE на disable → красные 2 теста: get/list --all/priceHistory
   после disable пустеют, строки нет в swarm_model.

## Гейты (фактические числа)

- `bun test` (полный): **1379 pass, 16 skip, 0 fail — 1395 тестов, 95 файлов, 78.65 s**
- `bun run typecheck`: **0 ошибок, 13/13 пакетов exit 0**
- `bun run deps-check`: passed for 13 packages

Многопроцессный тест (6×Bun.spawn, гонка миграций и записей): стабилен
15/15 прогонов. Найден и починен реальный дефект гонки: journal_mode=WAL
переключается мимо busy-handler (немедленный «database is locked»), запись
переведена на BEGIN IMMEDIATE (deferred-транзакции давали BUSY_SNAPSHOT).

## Нерешённое / на сведение координатора

- `packages/web/src/write.test.ts` (9 тестов) и drain-бюджет (1 тест) флакают
  под нагрузкой полного прогона: падали в двух запусках из пяти, в изоляции
  зелёные, без моей регистрации в main.ts полный прогон их не воспроизводит.
  Файлы вне моих границ, не чинил — веб-агенту на заметку.
- `family` принимается свободной строкой (семантика схемы §2.2 — «claude-sonnet»
  для наследования приоров), а не enum frontier|mid|small|open из CLI-эскиза
  §2.10.1 — в доке противоречие, выбрал схему.
- Имя команды `model` соседствует с `models` (эмбеддинги) — оставлено по §2.10.1;
  если путает, переименование — одна строка.
- W11: точка записи сил — `Roster.updateModel(id, {strengths})`, чтение —
  `myc model list --json` / таблицы swarm_model(+_price) в .myc/myc.db.
