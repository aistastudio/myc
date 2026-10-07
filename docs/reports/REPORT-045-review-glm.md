# Ревью релиза 0.4.5 (java в code-intel) — GLM-5.3

Объём: рабочий дифф ветки `release-0.4.5` против `main@0.4.4` (c27523f), 14 файлов,
+348/−21. Образцом взят C#-коммит fd1bab5: структура диффа повторяет его файл в файл
(grammars/langs/symbols/refs + honesty-тесты + помощь `code fetch`), версия — как в c27523f.

## 1. Сводка проверок (все — своим прогоном)

| Проверка | Результат |
|---|---|
| `bun test packages/code-intel` | **397 pass, 0 fail** (1247 expect, 13.3 c) |
| `bun test packages/cli/src/commands/code.test.ts` (+ `code-intel.honesty.test.ts`) | **52 pass, 0 fail** |
| `bun run typecheck` | все пакеты exit 0 |
| sha256/байты java-грамматики | `637aac44…91b9a1f` / 430 239 == `node_modules/.bun/tree-sitter-wasms@0.1.13/.../tree-sitter-java.wasm` (сверено побайтово, shasum -a 256). Сторожится тестом `grammars.test.ts:75` («зашитые sha256 и размеры совпадают с файлами сборки») |
| Реальный `fetchGrammar("java")` в temp | скачал 430 239 Б с CDN (пин `@0.1.13` в URL, `grammars.ts:81-85`), sha сошёлся, повторный вызов `already=true` за 0 мс — сеть не тронута |
| Path traversal / сеть | сюрпризов нет: URL собирается только из зашитого каталога `GRAMMARS`; аргументы `code fetch` валидируются по `GRAMMAR_BY_LANG`/`GRAMMARS` (`code.ts:1438-1453`); пишется `tree-sitter-<имя>.wasm` через `.part`+rename. Единственное место с сокетом — fetch, индексация сети не открывает |
| Кросс-языковая безопасность | эмпирически (зонд парсера): python — 0 пересечений java-узлов; ts — `generic_type`/`type_arguments` дают тот же `"type"`, что и старый путь (`object_creation_expression` в ts-грамматике нет); cs — `object_creation_expression` дублирует уже существовавшее правило, `var` в cs — `implicit_type` (правило `refs.ts:397` не задевает). Поведение py/ts/cs НЕ изменилось |
| Бамп версии | ровно 3 файла: `packages/cli/package.json:3`, `packages/core/src/version.ts:13`, `server.json:11,16`. `grep -rn "0.4.4"` по packages/, server.json, package.json — пусто. Совпадение package.json ↔ MYC_VERSION сторожится `scripts/pack-npm.ts:160-170` |
| site/README | не тронуты диффом — как и требует процесс. Остатки "0.4.4" в `README.md:61`, `docs/README.ru.md:60`, `site/data.js:1622` — по прецеденту 0.4.4 обновляются релизным коммитом (c27523f обновлял их ровно там) |

Honesty-поверхность: `code-intel.honesty.test.ts:102` — LANG_LIST и детектор неполных списков
дополнены `java`; `select.honesty.test.ts:101-113` — «java стал L1» пробует настоящий
`selectCodeIntel` на `Repo.java`. Оба honesty-набора прошли в моих прогонах.

## 2. Находки

### P0, P1 — нет.

### P2-1. Ложная `read`-ссылка на объявление параметра многострочной лямбды
`packages/code-intel/src/refs.ts:135-160` (BINDING_PARENTS), проявляется через java-раздел
`refs.ts:361-397`.

`x -> …` без скобок: параметр — голый `identifier` в поле `parameters` узла
`lambda_expression`; эта форма не в `BINDING_PARENTS` (там js/ts `formal_parameters` и
python `lambda_parameters`). Однострочная лямбда маскируется дедупом (имя, строка, вид,
владелец совпадают), многострочная даёт лишнюю ссылку — проверено прогоном:

```
3:        use(x ->
4:            calc(x));
--> 3:read:x | 4:read:x      ← строка 3: объявление, не чтение
```

Не регрессия этого диффа: C# ведёт себя так же с 0.4.3 (проверено тем же зондом,
`3:read | 4:read`), java наследует семейное поведение. Блокером не считаю, но для
симметрии с `formal_parameters` стоит завести задачу (гасить `lambda_expression`-параметры
для java и cs разом).

### P3
- **refs.ts:373-375** — dotted-аннотация `@com.example.Foo`: остаются только `read:com`;
  `example` и `Foo` теряются (вложенные `scoped_identifier` в поле `name` гасятся общим
  правилом `fieldIs(parent,"name")`). Редкая форма (обычно simple name после импорта), но
  ссылка на тип аннотации пропадает целиком.
- **refs.ts:383** — `field_access` всегда `read`, включая ИМЯ поля: `this.root = 1` даёт
  `read:root`. В js/ts/py/cs член — отдельный вид `prop`. Поведение протестировано
  сознательно (`refs.test.ts`, `read:out` для `System.out`) — решение, а не случайность,
  но для java вид `prop` не используется вовсе и `read` зашумленнее, чем у соседей.
- Метки: `outer:` даёт `read:outer` на объявлении метки (`labeled_statement` без поля
  `name` падает в общий `read`). Редко, шум мал.
- `new Outer.Inner()` и `new String[]{…}` дают `type`, а не `new` (квалифицированный/
  массивный тип не попадает в поле `type` как identifier). Согласовано с C#
  (`qualified_name` → `type` там же), симметрично — но упомянуть стоит.
- `docs/design/05-code-intelligence.md:170-185` — таблица L1 всё ещё «ts, tsx, js, jsx» и
  regex-критерий «десятого языка»: устарело ещё до C# (fd1bab5 док тоже не трогал).
  Дизайн — источник истины; долг по документации, не по коду.

## 3. Краевые случаи Java: что покрыто тестами, что — только фактом кода

| Случай | Тест | Факт (проверено прогоном) |
|---|---|---|
| Перегрузки (`run(1)` / `run(1,2)`) | нет | 2 `call`-ссылки на одно имя; граф по именам — заявленное ограничение (`refs.ts:27-29`) |
| Дженерики: `List<Person>`, diamond `new ArrayList<>()`, `type_arguments` | **да** (refs.test.ts, java-блок) | ok |
| Wildcard `? extends Number`, `Collections.<String>emptyList()` | нет | ok: `type:Number`, `type:String` + `call:emptyList` |
| Inner classes — defs | **да** (symbols.test.ts «вложенный класс») | `Outer`+`Inner` отдельными defs |
| Inner classes — refs (`Outer.Inner obj`) | нет | ok: `type:Outer` + `type:Inner` |
| Static import (`import static java.lang.Math.PI`) | **да** | все 4 части — `import`; использование `max(...)` — `call` |
| Text blocks (`"""…Helper…"""`) | нет | содержимое ссылок не даёт (грамматика — string_literal) |
| Switch expressions (`case M -> …`, `yield`) | нет | ok: метки — `read`, цепочка `day.name().length()` — два `call` |
| Комментарии/строки не дают ссылок | **да** | ok |
| Лямбда-параметры | нет | см. P2-1 |
| `instanceof String s` (паттерн) | нет | ok: объявления гасятся, чтения на месте |
| try-with-resources | нет | ok: ресурс-объявление погашено, `open` — `call` |
| Method references (`Person::new`) | нет | `read:Person` — приемлемо |
| Аннотации на параметрах/пакете, enum с телом, анонимный класс, throws | нет | всё ok (зонд 7): `type:NonNull`, `new:Runnable`+`type:Runnable`, `type:IOException` |
| `var` (вывод типа) | нет (правило refs.ts:397) | ok: `var` не даёт ссылок |
| Конструктор — имя дефа | **да** (symbols.test.ts: `Repo:method`) | имя «Repo», не «Repo(String root)» |

Непокрытые тестами строки сверху — кандидаты в доп-тесты, но каждое проверено мной
прогоном на реальной грамматике, и поведение корректно (кроме P2-1/P3).

## 4. Вердикт

# SHIP

- Релизный дифф повторяет проверенный образец C# (fd1bab5) файл в файл; версия поднята
  ровно в 3 местах, как в 0.4.4.
- Безопасность: sha256/байты java сверены с файлом пина и с CDN (реальной загрузкой),
  каталог сторожится тестом; traversal/сети-в-индексации нет.
- Существующие языки не задеты (эмпирически и полным прогоном: 397+52 теста, 0 падений).
- Единственный P2 — унаследованный из C# артефакт лямбда-параметров, симметричный для
  обоих языков, на границы продукта (граф по именам) не влияет; оформить задачей.
