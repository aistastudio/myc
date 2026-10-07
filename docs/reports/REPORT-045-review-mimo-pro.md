# Ревью 0.4.5 — Java в code-intel + бамп · MiMo-V2.6-Pro

Объём: рабочий дифф `release-0.4.5` против `main@0.4.4` (`c27523f`), 14 файлов,
+348/−21. Образец качества — `fd1bab5` («C# индексируется наравне с TypeScript
и Python»). Только чтение и прогоны; коммитов в worktree нет (HEAD = `0.4.4`).

Все замеры — своими прогонами из worktree. Зонды краевых случаев — `bun -e`
против той же грамматики, без правок кода.

---

## 1. Прогоны

| Проверка | Результат |
|---|---|
| `bun test packages/code-intel packages/cli/src/commands/code.test.ts` | **432 pass, 0 fail**, 1455 expect, 16.6 s |
| `bun test packages/cli/src/commands/code-intel.honesty.test.ts` | **17 pass, 0 fail** |
| итого (как в отчёте исполнителя) | **449 pass, 0 fail** |
| `bun run typecheck` | 14/14 пакетов exit 0 |
| sha256/байты `tree-sitter-java.wasm` | `637aac44…91b9a1f` / 430 239 — **побайтово совпали** с `node_modules/.bun/tree-sitter-wasms@0.1.13/.../tree-sitter-java.wasm` |
| контроль `tree-sitter-c_sharp.wasm` | `6266a7e3…` / 3 978 594 — совпал с `grammars.ts` (источник байтов тот же, что у fd1bab5) |
| `grep 0.4.4` по product-файлам | пусто (`packages/cli/package.json`, `packages/core/src/version.ts`, `server.json`) |
| README / site | **не тронуты** — верно |
| git | 14 modified, 0 commits поверх 0.4.4 |

---

## 2. Находки

### P0, P1 — нет.

### P2-1. FQN-аннотация теряет имя типа целиком

`packages/code-intel/src/refs.ts:373-375` (ветка `marker_annotation`/`annotation`)
срабатывает только когда имя аннотики — прямой ребёнок с полем `name`.
У `@java.lang.Deprecated` / `@com.foo.Bar` имя лежит в `scoped_identifier`,
и дальше включается общее правило `fieldIs(parent,"name") → null` (`refs.ts:400`).

Зонд (многострочно, чтобы дедуп не скрыл):

```
@java.lang.Deprecated
void m()
→ java: read   lang: —   Deprecated: —     ← тип аннотации потерян
```

Упрощённая форма `@Deprecated` даёт `type` (протестировано, `refs.test.ts`).
У C# тот же случай работает: `[System.Obsolete]` → `type:System` + `type:Obsolete`.
Это **единственный реальный отрыв от образца fd1bab5** в разборе ссылок.
На практике FQN-аннотации редки (обычно import + простое имя), поэтому не
блокер релиза; в follow-up — обойти `scoped_identifier`/`scoped_type_identifier`
в поле `name` аннотации так же, как C# обходит `qualified_name`.

### P2-2. Параметр лямбды даёт ложную `read` (семейное, не java-специфика)

`refs.ts:135-160` (`BINDING_PARENTS`) не знает java `lambda_expression.parameters`
(и cs-лямбду). Зонд:

```
use(x ->          ← 3: read:x   (объявление)
    calc(x));     ← 4: read:x   (чтение)
```

То же у C# (`x => …`) — поведение унаследовано, не регрессия 0.4.5.
Однострочная лямбда маскируется дедупом (имя+строка+вид+владелец), поэтому
в типичном коде не видна. Оформить задачей на java+cs разом.

### P3

1. **`refs.ts:383` — `field_access` всегда `read`, включая имя поля.**
   `this.root` / `System.out` → `read` на обеих сторонах. У js/ts/py/cs член —
   `prop`. Для Java `prop` не выдаётся вовсе (в языке нет свойств); решение
   зафиксировано тестом (`System.out` → `read:out`) и заявлена в отчёте.
   Шумнее соседей, но осознанно.

2. **Method references `Person::save` → `read:Person` + `read:save`.**
   C# method group даёт `read:Helper` + `prop:Save` — тоже неточно. Оба языка
   не возводят в `call`; паритет по присутствию, вид у java чуть хуже.

3. **`new java.util.Date()` → `type:Date`, а не `new`.** У C# симметрично
   (`new System.Collections.Generic.List<>()` → `type:List`). Простой
   `new ArrayList<>()` даёт `new` корректно. Паритет с образцом.

4. **Метка `outer:` → `read:outer` на объявлении** (`labeled_statement` без
   поля `name` падает в общий `read`). Редко, шум мал.

5. **Комментарий `JAVA_KINDS` спутан** — `symbols.ts:156-159` смешивает
   `enum_constant` и `annotation_type_element_declaration` в одну фразу и
   заканчивает «определение есть у самого enum», хотя это относится только к
   `enum_constant` (элемент аннотации, наоборот, **является** определением —
   и код это делает правильно, `JAVA_KINDS.annotation_type_element_declaration
   = "method"`). Код верный, формулировка вводит в заблуждение.

6. **Отчёт исполнителя vs код:** `REPORT-java-support.md:95-97` утверждает,
   что `field_access` «отдельная ветка ему не нужна — обе стороны дают `read`
   общим правилом». В коде ветка есть (`refs.ts:383`). Поведение совпадает,
   объяснение — нет.

---

## 3. Полность: C# (fd1bab5) vs Java (0.4.5)

### Определения

| Роль | C# узел → DefKind | Java узел → DefKind | Паритет |
|---|---|---|---|
| класс | `class_declaration` → class | `class_declaration` → class | да |
| record | `record_declaration` → class | `record_declaration` → class | да (осознанно) |
| интерфейс | `interface_declaration` → interface | `interface_declaration` → interface | да |
| перечисление | `enum_declaration` → enum | `enum_declaration` → enum | да |
| struct / record struct | `struct_declaration`, `record_struct_declaration` → type | — (нет в языке) | n/a |
| delegate | `delegate_declaration` → type | — (нет в языке) | n/a |
| метод | `method_declaration` → method | `method_declaration` → method | да |
| конструктор | `constructor_declaration` → method | `constructor_declaration` → method | да |
| деструктор | `destructor_declaration` → method | — (нет в языке) | n/a |
| локальная функция | `local_function_statement` → function | — (нет в языке; `int local(){}` = ERROR) | n/a |
| элемент аннотации | — (атрибут ≠ def) | `annotation_type_element_declaration` → method | java шире |
| `@interface` | — | `annotation_type_declaration` → interface | java шире |
| **поле / свойство** | **НЕ def** | **НЕ def** | да (решение) |
| **член enum** | **НЕ def** | **НЕ def** | да (решение) |
| **лямбда** | **НЕ def** | **НЕ def** | да (решение) |

Чего у Java нет относительно C# — только то, чего в языке нет. Обратное
направление (аннотации-типы, элементы аннотации) у Java покрыто.

### Ссылки

| Вид / форма | C# | Java | Паритет |
|---|---|---|---|
| вызов | `invocation_expression` → call | `method_invocation` → call | да |
| new | `object_creation_expression.type` → new | то же | да |
| new (обобщённый) | `generic_name` + родитель → new | `javaGenericNameKind` | да |
| import | `using_directive`, `isUsingName` | `import_declaration`, `isImportName` | да |
| package/namespace — не ссылка | `isNamespaceName` → null | `isPackageName` → null | да |
| тип | `qualified_name`, `type_argument_list`, `attribute`, `base_list`, поле `type` | `scoped_type_identifier` (через `type_identifier`), `type_arguments`, `catch_type`, `throws`, `super_interfaces`, `generic_type`, аннотация | да |
| чтение | объект member, и др. | объект `method_invocation`, `field_access`, и др. | да |
| prop | member_access без вызова | **не выдаётся** | осознанный отрыв |
| var подавлен | n/a (`implicit_type`) | `type_identifier=="var"` → null (`refs.ts:395-397`) + тест | решение |
| bind foreach/for-each | `for_each_statement.left` → null | `enhanced_for.name` → null | да |
| bind catch | name-поле / правило | `catch_formal_parameter` → null (`refs.ts:391-393`) | да |
| FQN-аннотация | **работает** (`type`) | **теряется** | **P2-1** |
| method reference | `prop` (неточно) | `read` (неточно) | P3 паритет |
| лямбда-параметр | ложная `read` | ложная `read` | P2-2 паритет |

**Вывод по полноте:** java-ветка `refKindOf` повторяет структуру C#-ветки
файл в файл (import/пакет, аннотация, вызов, new, generic, bind-исключения,
подавление `var`). Единственный дырявый относительно образца узел —
FQN-аннотация. Тесты честности (select / LANG_LIST / treesitter ABI /
сторож «правило ↔ грамматика ↔ L1») добавлены в том же составе, что у C#;
`treesitter_abi` для java — отдельным тестом (в комментарии и отчёте
обосновано: нет функции верхнего уровня + typecheck `as const`).

---

## 4. Заявления отчёта `REPORT-java-support.md`

| Заявление | Вердикт |
|---|---|
| sha256 `637aac44…91b9a1f`, 430 239 байт | **подтверждено** побайтово из `node_modules` |
| контроль c_sharp `6266a7e3…` / 3 978 594 | **подтверждено** |
| ключ `java` без подчёркивания из-за имени файла | **подтверждено** (`tree-sitter-java.wasm`, `spec` собирает имя из ключа) |
| вес каталога 9.81 МиБ на шесть грамматик | сходится в пределах округления (2.23+2.30+0.63+0.47+3.79+0.42) |
| `record` → `class`, как в C# | **решение**, не случайность: тест `symbols.test.ts` (Person:class) + зеркало `CS_KINDS` |
| `@interface` → `interface` | **решение**, тест (Marker:interface) |
| поля / enum_constant / лямбда — не defs | **решение**, зеркало C#, тест «поля и члены перечисления — не определения» |
| `var` подавлен | **решение**, отдельное правило + тест `to(src,"java","var") == []` |
| `catch`/`for-each` bind гасятся | **подтверждено** зондом и тестами |
| «field_access: отдельная ветка не нужна» | **неточность** (ветка в коде есть) — P3-6 |
| 449 pass / typecheck 14 пакетов | **подтверждено** моим прогоном |
| `grep 0.4.4` только README/docs/site | **подтверждено** (эти файлы вне product-бампа, ритуал релиза отдельно) |

---

## 5. Релиз-часть

| Проверка | Результат |
|---|---|
| лишнего в бампе нет | **да** — ровно 3 файла: `packages/cli/package.json:3`, `packages/core/src/version.ts:13`, `server.json:11` + `server.json:16` (два поля версии) |
| README / site / docs не тронуты | **да** |
| `0.4.4` в product-файлах | **нет** |
| коммиты сверх 0.4.4 | **нет** (HEAD = `c27523f 0.4.4`) |
| `L1_LANGS_LABEL` | авторасчёт `ts/tsx/js/jsx/py/cs/java` — help/сайт не расходятся |
| сторож sha256 | `grammars.test.ts:75-88` обходит `GRAMMARS` целиком, java покрыт автоматически |

---

## 6. Вердикт

# SHIP

Дифф повторяет проверенный образец `fd1bab5` структурно и по полноте: все
java-специфичные узлы определений и ссылок либо разобраны, либо осознанно
отброшены с зеркальным C#-обоснованием. Версия поднята ровно в трёх
product-местах, README/site не тронуты, HEAD чист. Тесты (449) и typecheck
зелёные у меня. Грамматика сверена побайтово.

Единственный относительный отрыв от образца — P2-1 (FQN-аннотация теряет
имя типа); форма редкая, простые аннотации и весь остальной каркас работают.
P2-2 (лямбда-параметр) — семейный артефакт, симметричный C# и не регрессия
этого релиза. Ни один не перекрывает продуктовых границ (граф по именам,
заявленные ограничения `refs.ts:27-42`).

**Рекомендация:** релизить; P2-1 и P2-2 завести follow-up задачами (лямбду —
сразу на java+cs).

---

### Финал

- 14 файлов, +348/−21: java в L1 тем же «правило + каталог + honesty», что C# в fd1bab5.
- Определения полны для языка (class/interface/enum/record/@interface/method/ctor/элемент аннотации); поля, enum_constant и лямбды — осознанно не defs.
- Ссылки: call/new/type/import/read; package и `var` подавлены; bind catch/for-each гасятся. `prop` не выдаётся — решение.
- sha256 и 430 239 байта java-грамматики сошлись с node_modules; контроль c_sharp совпал с fd1bab5.
- Бамп 0.4.5 ровно в cli package.json / version.ts / server.json (два поля); 0.4.4 в product-файлах нет; README/site не тронуты; коммитов поверх 0.4.4 нет.
- 432+17 = 449 тестов зелёные, typecheck 14/14.
- P0/P1 нет; P2-1 — FQN-аннотация теряет имя типа (отрыв от C#); P2-2 — ложная read у параметра лямбды (семейное с C#).
- P3: field_access→read вместо prop, method reference как read, FQN-new как type, метки, формулировка JAVA_KINDS, неточность про field_access в отчёте.

## **SHIP**
