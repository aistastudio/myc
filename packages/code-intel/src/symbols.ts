/**
 * Разбор определений через tree-sitter (WASM). Заменил регекспный `defs.ts`
 * целиком — второго парсера не осталось (memory-hrsae2f1mf7a).
 *
 * ПОЧЕМУ ЦЕЛИКОМ, А НЕ ОПЦИЕЙ. Два парсера — два поведения, которые разойдутся
 * молча: «две поверхности, один вопрос, разные ответы» в этом репозитории
 * ловилось шесть раз. Регекспный разбор был втрое быстрее (p50 2.12 мс против
 * 7.56 мс на tasks.ts) и на TS находил РОВНО СТОЛЬКО ЖЕ символов — размен идёт
 * не на качество, а на языки, которых у нас нет: 718 строк ради четырёх
 * языков против грамматик, которые уже написаны. Путь фоновый (`jobs`,
 * `code_index`), не горячий, и лишние 5 мс на файл там не видны.
 *
 * СИНХРОННЫЙ РАЗБОР ПРИ АСИНХРОННОЙ ГРАММАТИКЕ. `listDefs` остался
 * синхронным: сделать его промисом значило бы перекрасить три потребителя и
 * сорок вызовов в тестах ради того, что происходит ОДИН раз за процесс.
 * Загрузка вынесена в `loadLang` — идемпотентную, с общим промисом на
 * параллельные вызовы. Не загрузили — `listDefs` падает ГРОМКО
 * (`GrammarNotLoadedError`), а не отдаёт пустой список: пустой список здесь
 * неотличим от «в файле нет символов», и это была бы ровно та тихая ложь,
 * ради ухода от которой всё затевалось.
 *
 * ГДЕ ГРАММАТИКА ГРУЗИТСЯ НА САМОМ ДЕЛЕ:
 *   - воркер пула (`code_index_worker.ts`) грузит СВОЮ копию один раз и держит
 *     в памяти всю жизнь пула; первый файл каждого языка ждёт ~11 мс
 *     (Parser.init 6.9 + грамматика 4-5), остальные встают за тем же промисом;
 *   - главный поток (`code_index.ts`, `drainBatch`) грузит языки батча перед
 *     разбором — он же разбирает сам, когда пула нет (батч меньше
 *     PARSE_POOL_MIN_FILES) или когда пул погас по сторожу.
 * Ни один путь не оставляет `listDefs` без грамматики, и ни один не платит за
 * неё дважды в одном процессе.
 *
 * ВЕРСИИ ПИНЯТСЯ И СТЕРЕГУТСЯ ТЕСТОМ. web-tree-sitter@0.24.7 работает с
 * tree-sitter-wasms@0.1.13; на 0.27.0 те же грамматики падают на первом файле
 * (`getDylinkMetadata` — ABI разошёлся). Это не ошибка сборки: типы и импорт
 * остаются валидными, ломается рантайм. Сторож — `treesitter_abi.test.ts`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";

// Пин версий живёт в отдельном модуле без импортов — иначе сторож ABI падал бы
// вместе с тем, что он стережёт. См. `treesitter_pin.ts`.
export { PINNED_TREE_SITTER } from "./treesitter_pin.ts";

// ---------------------------------------------------------------------------
// Контракт (тот же, что был у defs.ts)
// ---------------------------------------------------------------------------

export type LangId = "ts" | "tsx" | "js" | "jsx" | "py";

export type DefKind = "function" | "class" | "method" | "type" | "interface" | "enum";

export interface Def {
  readonly name: string;
  readonly kind: DefKind;
  readonly startLine: number;
  readonly endLine: number;
}

export interface DefsOptions {
  /**
   * МУТАЦИЯ замера: конец определения не считается, спан схлопывается в одну
   * строку. Краснеют все проверки многострочных спанов — тем и показывает,
   * что они проверяют конец, а не факт находки.
   */
  readonly naiveEnd?: boolean;
}

/** Грамматика языка не загружена: `loadLang` не звали (или он упал). */
export class GrammarNotLoadedError extends Error {
  constructor(readonly lang: LangId) {
    super(
      `грамматика tree-sitter для "${lang}" не загружена: вызовите await loadLang("${lang}") до listDefs`,
    );
    this.name = "GrammarNotLoadedError";
  }
}

// ---------------------------------------------------------------------------
// Правила: тип узла -> вид определения
// ---------------------------------------------------------------------------

/**
 * Одна таблица на семейство грамматик. `js`/`jsx` берут ту же таблицу, что
 * `ts`/`tsx`, и это НЕ «js получил типы»: грамматика javascript узлов
 * `interface_declaration`, `enum_declaration` и `type_alias_declaration` не
 * порождает вовсе. Пропуск типовых форм в js — свойство грамматики, а не
 * второй список, который разойдётся с первым.
 */
const JSTS_KINDS: Readonly<Record<string, DefKind>> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type",
  method_definition: "method",
};

const PY_KINDS: Readonly<Record<string, DefKind>> = {
  function_definition: "function",
  class_definition: "class",
};

/** Значения `const x = …`, которые делают объявление определением функции. */
const JSTS_FUNCTION_VALUES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);

interface LangRule {
  /** Имя .wasm в tree-sitter-wasms (без префикса и расширения). */
  readonly grammar: string;
  readonly kinds: Readonly<Record<string, DefKind>>;
  /**
   * `const f = () => {}` — определение, `const n = 5` — нет. Отдельная ветка
   * потому, что узел один и тот же (`variable_declarator`), а решает значение.
   */
  readonly declarators: boolean;
  /** В python метод — та же `function_definition`, но внутри тела класса. */
  readonly methodByParent: readonly string[];
}

const LANG_RULES: Readonly<Record<LangId, LangRule>> = {
  ts: { grammar: "typescript", kinds: JSTS_KINDS, declarators: true, methodByParent: [] },
  tsx: { grammar: "tsx", kinds: JSTS_KINDS, declarators: true, methodByParent: [] },
  js: { grammar: "javascript", kinds: JSTS_KINDS, declarators: true, methodByParent: [] },
  jsx: { grammar: "javascript", kinds: JSTS_KINDS, declarators: true, methodByParent: [] },
  py: { grammar: "python", kinds: PY_KINDS, declarators: false, methodByParent: ["block"] },
};

/**
 * Языки, для которых у нас есть грамматика. Считается ИЗ таблицы правил, а не
 * пишется рядом с ней: список, объявленный отдельно, — это второе место, где
 * можно забыть язык. Совпадение с `L1_LANGS` (`langs.ts`) сторожит тест.
 */
export const DEF_LANGS: readonly LangId[] = Object.keys(LANG_RULES) as LangId[];

// ---------------------------------------------------------------------------
// Загрузка грамматик
// ---------------------------------------------------------------------------

type TSParser = InstanceType<typeof Parser>;
type TSNode = ReturnType<TSParser["parse"]>["rootNode"];

let runtimeInit: Promise<void> | null = null;
const grammars = new Map<LangId, Promise<TSParser>>();
const ready = new Map<LangId, TSParser>();

/**
 * Каталог web-tree-sitter (там лежит tree-sitter.wasm рантайма).
 *
 * `MYC_TREE_SITTER_DIR` — не отладочный крючок: это КАНАЛ, по которому
 * главный поток передаёт воркеру уже найденный путь (`treeSitterDirs` →
 * `ParsePool`). Резолвер за границей потока не работает — в бинаре у воркера
 * нет ни node_modules, ни того каталога, из которого искал главный поток.
 *
 * Отсутствие каталога обязано называть себя, а не разваливаться стеком
 * резолвера, — ровно как у грамматик ниже.
 */
function runtimeDir(): string {
  const fromEnv = process.env.MYC_TREE_SITTER_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const pkgJson = Bun.resolveSync(
      "web-tree-sitter/package.json",
      dirname(fileURLToPath(import.meta.url)),
    );
    return dirname(pkgJson);
  } catch {
    throw new Error(
      "рантайм tree-sitter не найден: пакета web-tree-sitter нет рядом с @myc/code-intel. " +
        "Укажите каталог с tree-sitter.wasm в MYC_TREE_SITTER_DIR " +
        "или установите зависимости (bun install)",
    );
  }
}

/**
 * Каталог с .wasm грамматик.
 *
 * `MYC_TREE_SITTER_GRAMMAR_DIR` — не отладочный крючок, а тот же приём, что у
 * `MYC_ORT_WASM_DIR` в эмбеддере: в собранном бинаре node_modules нет, и
 * грамматики придут откуда-то ещё. Пока их туда никто не кладёт (это
 * memory-be3k1np40sag, грамматики по требованию), и здесь важно только одно —
 * чтобы отсутствие каталога называло себя, а не разваливалось стеком резолвера.
 *
 * Через эту же переменную главный поток передаёт путь ВОРКЕРУ пула: искать
 * заново за границей потока он не может и не должен (`treeSitterDirs`).
 */
function grammarDir(): string {
  const fromEnv = process.env.MYC_TREE_SITTER_GRAMMAR_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const pkgJson = Bun.resolveSync(
      "tree-sitter-wasms/package.json",
      dirname(fileURLToPath(import.meta.url)),
    );
    return join(dirname(pkgJson), "out");
  } catch {
    throw new Error(
      "грамматики tree-sitter не найдены: пакета tree-sitter-wasms нет рядом с @myc/code-intel. " +
        "Укажите каталог с файлами tree-sitter-<язык>.wasm в MYC_TREE_SITTER_GRAMMAR_DIR " +
        "или установите зависимости (bun install)",
    );
  }
}

/** Путь к .wasm грамматики языка — он же аргумент для загрузки по требованию. */
export function grammarPath(lang: LangId): string {
  return join(grammarDir(), `tree-sitter-${LANG_RULES[lang].grammar}.wasm`);
}

/** Каталоги рантайма и грамматик — то, что этот поток УЖЕ нашёл. */
export interface TreeSitterDirs {
  /** Каталог с tree-sitter.wasm рантайма. */
  readonly runtime: string;
  /** Каталог с файлами tree-sitter-<язык>.wasm. */
  readonly grammar: string;
}

/**
 * Разрешить оба каталога ЗДЕСЬ И СЕЙЧАС — чтобы отдать их тому, кто разрешить
 * их не может.
 *
 * Единственный вызывающий — `ParsePool`: воркер получает эти строки готовыми
 * (через `MYC_TREE_SITTER_DIR`/`MYC_TREE_SITTER_GRAMMAR_DIR`) и `Bun.resolveSync`
 * за границей потока не зовёт вовсе. В бинаре у него нет ни node_modules, ни
 * каталога, относительно которого искал главный поток: его `import.meta.url`
 * ведёт в bunfs. Бросает — значит грамматик нет и у главного потока тоже, и
 * пул заводить не на чем.
 */
export function treeSitterDirs(): TreeSitterDirs {
  return { runtime: runtimeDir(), grammar: grammarDir() };
}

async function initRuntime(): Promise<void> {
  if (runtimeInit === null) {
    const dir = runtimeDir();
    runtimeInit = Parser.init({ locateFile: (name: string) => join(dir, name) }).catch((e) => {
      runtimeInit = null; // повтор возможен: сбой мог быть в путях, а не в ABI
      throw e;
    });
  }
  return runtimeInit;
}

/**
 * Загрузить грамматику языка. Идемпотентно: повторные и параллельные вызовы
 * ждут один промис, грамматика читается с диска один раз за процесс.
 *
 * Парсер на язык один на процесс — и это безопасно ровно потому, что
 * `parse` синхронен: в Bun между входом и выходом из него ничего чужого не
 * выполнится, так что делить состояние не с кем.
 */
export async function loadLang(lang: LangId): Promise<void> {
  let pending = grammars.get(lang);
  if (pending === undefined) {
    pending = (async () => {
      await initRuntime();
      const language = await Parser.Language.load(grammarPath(lang));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })().catch((e) => {
      grammars.delete(lang);
      throw e;
    });
    grammars.set(lang, pending);
  }
  ready.set(lang, await pending);
}

/** Загрузить несколько языков разом; порядок не важен, ошибки не глотаются. */
export async function loadLangs(langs: Iterable<LangId>): Promise<void> {
  await Promise.all([...new Set(langs)].map(loadLang));
}

function parserFor(lang: LangId): TSParser {
  const p = ready.get(lang);
  if (p === undefined) throw new GrammarNotLoadedError(lang);
  return p;
}

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

function nameOf(node: TSNode): string | null {
  const name = node.childForFieldName("name");
  if (name === null) return null;
  const text = name.text;
  return text.length > 0 ? text : null;
}

/** Значение объявления — функция? `const f = () => {}` да, `const n = 5` нет. */
function declaratorIsFunction(node: TSNode): boolean {
  const value = node.childForFieldName("value");
  return value !== null && JSTS_FUNCTION_VALUES.has(value.type);
}

function isMethodByParent(node: TSNode, parents: readonly string[]): boolean {
  if (parents.length === 0) return false;
  // Декораторы в python оборачивают определение узлом `decorated_definition`;
  // `@property def name(self)` внутри класса — такой же метод, как соседний
  // `__init__`, и разницы в ответе быть не должно.
  let parent = node.parent;
  while (parent !== null && parent.type === "decorated_definition") parent = parent.parent;
  if (parent === null || !parents.includes(parent.type)) return false;
  const grand = parent.parent;
  return grand !== null && grand.type.endsWith("class_definition");
}

/**
 * Определения файла в порядке появления (обход в глубину, предзаказ).
 *
 * Вложенные определения — свои: `inner` внутри `outer` попадёт в список
 * отдельной строкой, ровно как раньше. Сигнатуры без тела (`declare function`,
 * перегрузки) определениями НЕ становятся: грамматика даёт им отдельный тип
 * узла (`function_signature`), и различать их регекспом больше не нужно.
 */
export function listDefs(source: string, lang: LangId, opts: DefsOptions = {}): Def[] {
  const parser = parserFor(lang);
  const rule = LANG_RULES[lang];
  const tree = parser.parse(source);
  // Дерево живёт в куче wasm, и сборщик JS его не трогает: не освободить —
  // значит течь на каждом файле в воркере, который живёт весь прогон.
  try {
    const defs: Def[] = [];

    const visit = (node: TSNode): void => {
      const kind = rule.kinds[node.type];
      if (kind !== undefined) {
        const name = nameOf(node);
        if (name !== null) {
          push(defs, name, isMethodByParent(node, rule.methodByParent) ? "method" : kind, node, opts);
        }
      } else if (rule.declarators && node.type === "variable_declarator" && declaratorIsFunction(node)) {
        const name = nameOf(node);
        if (name !== null) push(defs, name, "function", node, opts);
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null) visit(child);
      }
    };

    visit(tree.rootNode);
    return defs;
  } finally {
    tree.delete();
  }
}

function push(out: Def[], name: string, kind: DefKind, node: TSNode, opts: DefsOptions): void {
  const startLine = node.startPosition.row + 1;
  out.push({
    name,
    kind,
    startLine,
    endLine: opts.naiveEnd === true ? startLine : node.endPosition.row + 1,
  });
}

/**
 * Строка, на которой закрывается блок, начатый на `startLine`. Считается по
 * дереву: берётся самый внешний узел, начинающийся на этой строке.
 * Разбирается как ts — единственный вызывающий (нормализация спанов) работает
 * с ts/js, а js для этой задачи подмножество.
 */
export function findBlockEnd(source: string, startLine: number, opts: DefsOptions = {}): number {
  if (opts.naiveEnd === true) return startLine;
  const parser = parserFor("ts");
  const tree = parser.parse(source);
  try {
    const row = startLine - 1;
    let found: TSNode | null = null;

    const visit = (node: TSNode): boolean => {
      if (node.startPosition.row === row) {
        found = node;
        return true;
      }
      if (node.startPosition.row > row || node.endPosition.row < row) return false;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null && visit(child)) return true;
      }
      return false;
    };

    // Корень (`program`) начинается на первой строке всегда — на нём поиск
    // закончился бы, не начавшись, и любой запрос про строку 1 отдавал бы
    // конец файла. Обход идёт по его детям.
    const root = tree.rootNode;
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (child !== null && visit(child)) break;
    }
    return found === null ? startLine : (found as TSNode).endPosition.row + 1;
  } finally {
    tree.delete();
  }
}
