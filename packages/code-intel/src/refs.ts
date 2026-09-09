/**
 * ССЫЛКИ: вхождение имени с МЕСТОМ и ВЛАДЕЛЬЦЕМ (memory-e34bfse29jdw).
 *
 * ЧЕГО НЕ ХВАТАЛО. `code_defs` знает, ГДЕ символ объявлен; `code_refs` знает,
 * СКОЛЬКО раз имя встречается в репозитории (`\bNAME\b` по тексту, счётчик без
 * файла и строки). Ни то, ни другое не отвечает на «кто зовёт»: для этого
 * нужна третья вещь — вхождение, у которого есть путь, строка и ИМЯ
 * ОХВАТЫВАЮЩЕГО СИМВОЛА. Именно охватывающий символ превращает список
 * совпадений в граф: `listDefs` ← `drainBatch`, а не `listDefs` ← «строка 721».
 *
 * ГРАНИЦА, КОТОРУЮ ЗДЕСЬ ПРОВЕЛИ. Слева — текстовый счёт (`code_refs`): любое
 * вхождение имени, включая комментарии и строковые литералы. Справа — полная
 * семантика: разрешение импортов, псевдонимы, типы, области видимости. Мы
 * стоим посередине и берём СИНТАКСИЧЕСКИЕ вхождения в позиции ИСПОЛЬЗОВАНИЯ:
 * то, что грамматика назвала идентификатором в выражении, типе или импорте, —
 * и не берём объявления этого же имени (они уже в `code_defs`).
 *
 * Что даёт эта граница по сравнению с текстом, замерено на этом репозитории:
 *   - комментарии и строки отсекаются грамматикой, а не эвристикой; на
 *     `listDefs` graft показывает два вхождения в комментариях как вызовы —
 *     у нас их нет;
 *   - у каждой ссылки есть вид (`call`/`new`/`type`/`import`/`read`/`prop`):
 *     «вызвал» и «упомянул в типе» перестают быть одним числом;
 *   - у каждой ссылки есть владелец, и он согласован с `code_defs` — обе
 *     стороны считает `defAt` из `symbols.ts`, одна таблица правил на двоих.
 *
 * ЧЕГО ЭТОТ РАЗБОР НЕ РАЗЛИЧАЕТ (список честный, а не список забытого):
 *   1. Одноимённые методы разных классов: `a.close()` и `b.close()` — две
 *      ссылки на имя `close`, и чей это `close`, здесь не решается.
 *   2. Импорты и псевдонимы: `import { a as b }` даёт ссылку на `a` (вид
 *      `import`), но последующие `b()` записаны как `b` — связь `b → a` не
 *      восстанавливается.
 *   3. Локальные переменные и параметры от глобальных имён: `const parse =
 *      …; parse(x)` даст ссылку на имя `parse` наравне с вызовом чужой
 *      функции `parse`. Объявление локали при этом не записывается —
 *      записывается только её ЧТЕНИЕ.
 *   4. Строки и комментарии: их здесь нет вовсе. Это отличие ОТ graft, а не
 *      от истины, но в обе стороны: имя, упомянутое только в комментарии,
 *      нашим `callers` не найдётся.
 *   5. Динамику: `obj[name]()`, `eval`, строковые ключи — вне разбора.
 *   6. Два вхождения одного имени на одной строке в одной роли — одна
 *      ссылка (см. дедуп ниже).
 */

import {
  defAt,
  defNameOf,
  defOf,
  parserForLang,
  type Def,
  type DefsOptions,
  type LangId,
  type TSNode,
} from "./symbols.ts";

// ---------------------------------------------------------------------------
// Контракт
// ---------------------------------------------------------------------------

/**
 * Роль вхождения. Не косметика: `callers` без вида не отличает вызов от
 * совпадения имени поля, а это разница между ребром графа и шумом.
 *
 * `read` — имя прочитано как значение (`const p = listDefs`, `arr.map(fn)`);
 * именно этим ссылка отличается от «вызвал», и терять её нельзя: передача
 * функции значением — такое же ребро, просто отложенное.
 * `prop` — обращение к полю без вызова (`obj.field`); самый шумный вид,
 * выделен отдельно ровно чтобы читатель мог его отбросить.
 */
export type RefKind = "call" | "new" | "type" | "import" | "read" | "prop";

export interface Ref {
  /** Имя, на которое ссылаются. */
  readonly name: string;
  /** 1-based строка вхождения — как в `file:line`, который агент кликает. */
  readonly line: number;
  readonly kind: RefKind;
  /**
   * Имя охватывающего определения; пусто — верхний уровень файла (импорты,
   * объявления констант). Пустая строка, а не null: у `code_defs` имени «нет»
   * не бывает, и NULL в ключе поиска был бы третьим состоянием без смысла.
   */
  readonly from: string;
  /**
   * `span_start` охватывающего определения (0 — верхний уровень файла).
   * Вместе с `from` это ТОЧНЫЙ ключ строки `code_defs` (repo, path, name,
   * span_start): одноимённых определений в файле может быть несколько, и без
   * начала спана владелец указывал бы на любое из них.
   */
  readonly fromStart: number;
}

/**
 * Один разобранный файл: определения и ссылки. Тип назван, потому что он
 * едет через границу воркера пула — там форма ответа обязана быть договором,
 * а не выводом типа из места вызова.
 */
export interface ParsedFile {
  readonly defs: Def[];
  readonly refs: Ref[];
}

export interface RefsOptions extends DefsOptions {
  /**
   * МУТАЦИЯ приёмки: владелец не считается — каждая ссылка приписывается
   * файлу. Ровно то, что отличает граф вызовов от `grep -n`: с этим флагом
   * ссылки на месте, места на месте, а «кто зовёт» больше нет. Краснеют все
   * проверки охватывающего символа — тем и показывают, что проверяют его, а
   * не факт находки.
   */
  readonly naiveOwner?: boolean;
}

// ---------------------------------------------------------------------------
// Правила: какой узел считать ссылкой
// ---------------------------------------------------------------------------

/** Узлы-имена, которые вообще могут оказаться ссылкой. */
const NAME_NODES: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
]);

/**
 * Родители, у которых ребёнок-идентификатор — ОБЪЯВЛЕНИЕ локального имени, а
 * не использование: параметры и деструктуризация. `function f(listDefs) {}`
 * не ссылается на `listDefs`, он его заслоняет.
 *
 * Имя, объявленное как поле `name` своего родителя (функция, класс, тип,
 * метод, переменная), отсекается отдельно и без списка — грамматика уже
 * назвала его именем. Здесь только формы, где поля `name` нет.
 */
const BINDING_PARENTS: ReadonlySet<string> = new Set([
  // js/ts
  "formal_parameters",
  "required_parameter",
  "optional_parameter",
  "rest_pattern",
  "object_pattern",
  "array_pattern",
  "pair_pattern",
  "object_assignment_pattern",
  "import_clause", // `import Parser from …` — локальное имя, в источнике его нет
  "namespace_import", // `import * as ns` — то же самое
  // python
  "parameters",
  "lambda_parameters",
  "default_parameter",
  "typed_parameter",
  "typed_default_parameter",
  // Только ЦЕЛЬ псевдонима: в `except Err as e` и `with open(f) as fh`
  // локальное имя объявляет `as_pattern_target`, а сам `as_pattern` держит
  // ещё и то, что переименовывают, — а это обычная ссылка. Пока в списке
  // стоял `as_pattern`, класс исключения из `except Err as e` пропадал.
  "as_pattern_target",
]);

/**
 * Родители, у которых поле `name` — это ССЫЛКА, а не объявление: имя
 * импортируемого символа принадлежит чужому файлу. `import { listDefs }` —
 * такое же вхождение, как вызов, и graft его показывает.
 *
 * `export_specifier` здесь по той же причине и не для симметрии:
 * `export { walkFiles } from "./langs.ts"` — обращение к чужому символу,
 * которое в этом репозитории встречается в каждом барреле. Без него правило
 * «поле name — это объявление» съедало имя, а псевдоним (`langOf as lo`)
 * записывался вместо него — то есть ссылка была не просто потеряна, а
 * заменена на имя, которого в источнике нет.
 */
const IMPORT_PARENTS: ReadonlySet<string> = new Set([
  "import_specifier",
  "export_specifier",
  "aliased_import",
]);

/**
 * Элементы JSX: `<Widget/>` — обращение к компоненту, а грамматика кладёт его
 * имя в поле `name`, то есть туда же, где у объявлений лежит объявляемое имя.
 * Без этого списка вся разметка молча выпадала бы из ссылок: в tsx-файле это
 * половина обращений к чужим символам.
 */
const JSX_ELEMENTS: ReadonlySet<string> = new Set([
  "jsx_opening_element",
  "jsx_self_closing_element",
  "jsx_closing_element",
]);

/** Узлы вызова: js/ts и python. */
const CALL_NODES: ReadonlySet<string> = new Set(["call_expression", "call"]);

/** Доступ к члену: js/ts (`a.b`) и python (`a.b`). */
const MEMBER_NODES: ReadonlySet<string> = new Set(["member_expression", "attribute"]);

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

function fieldIs(parent: TSNode, field: string, node: TSNode): boolean {
  const f = parent.childForFieldName(field);
  return f !== null && f.id === node.id;
}

/** Есть ли у объявления экспорта источник (`export { x } from "…"`)? */
function hasSource(specifier: TSNode): boolean {
  // export_specifier -> export_clause -> export_statement
  const clause = specifier.parent;
  const stmt = clause === null ? null : clause.parent;
  return stmt !== null && stmt.childForFieldName("source") !== null;
}

/** Вызывается ли ЭТОТ узел-член (`a.b` в `a.b()`)? */
function memberIsCallee(member: TSNode): "call" | "new" | null {
  const gp = member.parent;
  if (gp === null) return null;
  if (CALL_NODES.has(gp.type) && fieldIs(gp, "function", member)) return "call";
  if (gp.type === "new_expression" && fieldIs(gp, "constructor", member)) return "new";
  return null;
}

/**
 * Роль вхождения, или null — это не ссылка (объявление, параметр, ключ
 * объектного литерала).
 */
function refKindOf(node: TSNode): RefKind | null {
  const parent = node.parent;
  if (parent === null) return null;
  const pt = parent.type;

  // `import { a as b }`: `a` — имя в чужом файле (ссылка), `b` — локальный
  // псевдоним, которого там нет (не ссылка).
  if (IMPORT_PARENTS.has(pt)) {
    if (!fieldIs(parent, "name", node)) return null;
    // `export { local }` без `from` — обращение к СВОЕМУ имени, а не к чужому
    // модулю. Вид здесь не украшение: `import` в ответе означает «пришло
    // извне», и повесить его на локальный реэкспорт значит соврать про место.
    return pt === "export_specifier" && !hasSource(parent) ? "read" : "import";
  }
  // Имя элемента JSX — обращение к компоненту, а не объявление.
  if (JSX_ELEMENTS.has(pt)) return fieldIs(parent, "name", node) ? "read" : null;
  // Имя атрибута JSX (`prop=`) — то же, что ключ объектного литерала.
  if (pt === "jsx_attribute") return null;
  if (BINDING_PARENTS.has(pt)) return null;
  // Имя собственного объявления: оно уже в `code_defs`, ссылкой не считается.
  if (fieldIs(parent, "name", node)) return null;
  // Ключ объектного литерала (`{ parse: listDefs }`) — не обращение к имени.
  if (pt === "pair" && fieldIs(parent, "key", node)) return null;
  // Имя аргумента по ключу (`f(limit: 1)` в python) — не ссылка на символ.
  if (pt === "keyword_argument" && fieldIs(parent, "name", node)) return null;
  // `catch (e)` объявляет `e`, а не ссылается на него: поля `name` у этой
  // формы нет, поэтому общее правило её не ловит.
  if (pt === "catch_clause" && fieldIs(parent, "parameter", node)) return null;

  if (CALL_NODES.has(pt) && fieldIs(parent, "function", node)) return "call";
  if (pt === "new_expression" && fieldIs(parent, "constructor", node)) return "new";

  if (MEMBER_NODES.has(pt)) {
    const isMemberName =
      fieldIs(parent, "property", node) || fieldIs(parent, "attribute", node);
    if (isMemberName) return memberIsCallee(parent) ?? "prop";
    // Объект (`jobs` в `jobs.claim()`) — обычное чтение имени.
    return "read";
  }

  if (pt === "dotted_name") return "import";
  if (node.type === "type_identifier") return "type";
  if (pt === "extends_clause" || pt === "implements_clause") return "type";
  if (node.type === "property_identifier") return "prop";
  return "read";
}

/**
 * Ссылки файла в порядке появления.
 *
 * ВЛАДЕЛЕЦ СЧИТАЕТСЯ ПО СТЕКУ, А НЕ ПО ПОПАДАНИЮ В СПАН ПОСЛЕ РАЗБОРА.
 * Ответ тот же (внутреннее определение, чей спан содержит строку), но стек
 * даёт его за один обход и без второй структуры, которая могла бы разойтись
 * с первой. Вложенность честная: ссылка внутри `inner` внутри `outer`
 * принадлежит `inner` — иначе весь файл схлопнулся бы в один узел.
 *
 * ДЕДУП: одна строка на (имя, строка, вид, владелец). Два вызова одного имени
 * в одной строке — одно вхождение: `callers` показывает СТРОКУ, и вторая
 * копия той же строки читателю не сообщает ничего. Замерено: дедуп снимает
 * ~7% строк.
 */
export function listRefs(source: string, lang: LangId, opts: RefsOptions = {}): Ref[] {
  return listDefsAndRefs(source, lang, opts).refs;
}

/**
 * Определения И ссылки за ОДИН разбор — то, чем пользуется индексатор.
 *
 * Раздельные `listDefs` + `listRefs` строили бы дерево дважды, а построение
 * дерева и есть основная цена (7.5 мс на 64 КБ против долей миллисекунды на
 * обход). Стек охватывающих символов всё равно повторяет список определений —
 * значит второй разбор покупал бы ровно ничего.
 *
 * Порядок определений тот же, что у `listDefs` (обход в глубину, предзаказ):
 * это ОДИН обход по одним правилам (`defAt`), а не два похожих.
 */
export function listDefsAndRefs(
  source: string,
  lang: LangId,
  opts: RefsOptions = {},
): ParsedFile {
  const parser = parserForLang(lang);
  const tree = parser.parse(source);
  // Дерево живёт в куче wasm; не освободить — течь на каждом файле.
  try {
    const defs: Def[] = [];
    const out: Ref[] = [];
    const seen = new Set<string>();
    const owners: Array<{ name: string; start: number }> = [];
    const naive = opts.naiveOwner === true;

    const visit = (node: TSNode): void => {
      let pushed = false;
      const kindOfDef = defAt(node, lang);
      if (kindOfDef !== null) {
        const name = defNameOf(node);
        if (name !== null) {
          defs.push(defOf(name, kindOfDef, node, opts));
          owners.push({ name, start: node.startPosition.row + 1 });
          pushed = true;
        }
      }

      if (NAME_NODES.has(node.type)) {
        const kind = refKindOf(node);
        if (kind !== null) {
          const text = node.text;
          if (text.length > 0) {
            const owner = naive || owners.length === 0 ? null : owners[owners.length - 1]!;
            const line = node.startPosition.row + 1;
            const from = owner === null ? "" : owner.name;
            const fromStart = owner === null ? 0 : owner.start;
            const key = `${text} ${line} ${kind} ${fromStart}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ name: text, line, kind, from, fromStart });
            }
          }
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null) visit(child);
      }
      if (pushed) owners.pop();
    };

    visit(tree.rootNode);
    return { defs, refs: out };
  } finally {
    tree.delete();
  }
}
