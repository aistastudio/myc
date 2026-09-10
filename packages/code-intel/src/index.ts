/**
 * @myc/code-intel — код-интеллект myc.
 *
 * Решение S52 и docs/design/05-code-intelligence.md: встроенная реализация
 * обязательна, graft — вторая реализация того же интерфейса, и она
 * опциональна. «Текстовой, без AST» встроенная быть перестала: разбор
 * определений перешёл на tree-sitter (memory-hrsae2f1mf7a), своего парсера
 * больше нет. Текстовым остался `fan_in` — и он по-прежнему подписан
 * источником `text`, чтобы завышение при совпадении имён было видно.
 *
 * Умолчание `builtin` ВЕЗДЕ: определять реализацию по окружению значит
 * вернуть «у меня работает иначе», ради ухода от чего всё и затевалось.
 *
 * Здесь — интерфейс (§6.1) и выбор реализации (`./select.ts`, §6.2). Сами
 * реализации живут отдельно: `BuiltinCodeIntel` поверх `./symbols.ts` (T3) и
 * `GraftAdapter` из `03` §7.2.
 */

// ---------------------------------------------------------------------------
// Возможности и состояние
// ---------------------------------------------------------------------------

/**
 * Что умеет реализация. Разделение не косметическое: `capabilities` — это
 * то, по чему команда решает, отвечать ей или сказать «недоступно и почему»
 * (И2). Молчаливого «пусто» быть не может ни в одном случае.
 */
export type CodeIntelCapability =
  /** file:line, протухание, ре-привязка — есть всегда, даже при `off` нет только этого. */
  | "anchor"
  /** символ → path:span. builtin: языки L1 (см. `langs.ts`); graft: девять языков. */
  | "symbol"
  /** число вхождений. builtin: текст; graft: граф. Источник подписан всегда. */
  | "fan_in"
  /**
   * рёбра вызовов. Был «только graft»; с memory-e34bfse29jdw есть и у
   * builtin — `./refs.ts` поверх `code_ref_sites` (миграция 011):
   * синтаксические вхождения с владельцем, без разрешения импортов.
   */
  | "callers"
  /**
   * ранжированный поиск по коду. Был «только graft»; с memory-5nvk1hwcene2
   * есть и у builtin — `./search.ts` поверх корпуса `code_units`/`code_fts`
   * (миграция 012). Лексический, не векторный, и подписан именно так.
   */
  | "search"
  /**
   * карта репозитория. Тоже был «только graft»; с memory-5nvk1hwcene2 есть у
   * builtin — `./map.ts`, чистый агрегат по уже построенным таблицам, без
   * своего хранения.
   */
  | "map";

/** Две реализации одного интерфейса, третьей не будет. */
export type CodeIntelId = "builtin" | "graft";

/**
 * `ok` — работает; `missing` — запрошена, но не найдена (для graft это
 * ошибка конфигурации, не повод откатиться); `incompatible` — найдена, но
 * версия не та; `stale` — работает, но индекс отстал от кода.
 */
export type CodeIntelState = "ok" | "missing" | "incompatible" | "stale";

/** Репозиторий якоря: `repo` из `01` §7.1 (repo+path+span+blob_hash+crux_text). */
export type RepoId = string;

// ---------------------------------------------------------------------------
// Данные ответов
// ---------------------------------------------------------------------------

/**
 * Найденный символ. `crux` — текст, а не номера строк (идея graft, И3):
 * спан переживает рефакторинг только через ре-привязку по тексту.
 */
export interface SymbolHit {
  readonly repo: RepoId;
  readonly path: string;
  /** 1-based, включительно — как в `file:line`, который агент кликает. */
  readonly startLine: number;
  readonly endLine: number;
  readonly name: string;
  /** Что это по мнению реализации: обе различают по дереву разбора. */
  readonly kind: string;
  /** Расширение файла без точки: ts, tsx, js, jsx, … */
  readonly lang: string;
  /** ≤8 строк сути спана; пусто, если реализация её не считает. */
  readonly crux?: string;
}

/** Ребро вызова. Только graft: у builtin графа нет и не будет (И3). */
export interface CallEdge {
  readonly repo: RepoId;
  readonly from: SymbolRef;
  readonly to: SymbolRef;
  /** Расстояние от запрошенного символа: 1 — прямой вызов. */
  readonly depth: number;
}

export interface SymbolRef {
  readonly name: string;
  readonly path: string;
  readonly line: number;
}

/**
 * Строка ранжированной выдачи поиска по коду в терминах ЭТОГО интерфейса.
 * Встроенная реализация отвечает богаче — файлом со списком совпавших
 * символов (`./search.ts`, `CodeSearchHit`), потому что свёртка в файлы и
 * есть то, что даёт ей качество; сюда она сводится с потерей.
 */
export interface CodeHit {
  readonly repo: RepoId;
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly score: number;
}

/**
 * Кластер карты репозитория в терминах ЭТОГО интерфейса. Встроенная
 * реализация отвечает богаче (`./map.ts`, `MapCluster`): у неё есть ещё слой
 * связности — кто из какого каталога импортирует.
 */
export interface Cluster {
  readonly dir: string;
  readonly files: number;
  readonly hubs: readonly string[];
}

/**
 * `fan_in` с обязательной подписью источника (ответ заказчика §12.2):
 * `text` завышает при совпадении имён, `graph` точен. Пустого признака нет —
 * это была бы потеря сигнала у всех без graft, то есть у большинства.
 */
export interface FanIn {
  readonly n: number;
  readonly source: "text" | "graph";
}

/**
 * Где искали. §6.3: «пустой выдачи без причины не бывает» — команда
 * прикладывает это к ответу, когда символ не нашёлся, чтобы было видно,
 * что просмотрено и на каких языках.
 */
export interface SearchedScope {
  readonly files: number;
  readonly langs: readonly string[];
}

// ---------------------------------------------------------------------------
// Интерфейс (§6.1)
// ---------------------------------------------------------------------------

/**
 * Один интерфейс, две реализации, одно место выбора (`selectCodeIntel`).
 *
 * Необязательные методы — возможности, которых у реализации может не быть
 * (graft без индекса, builtin в дереве без L1-файлов). Проверять их наличие
 * полагается через `capabilities`, а не через
 * `typeof x.callers === "function"`: реализация может быть на месте, а
 * возможность недоступна (`state: "missing"` у graft), и разница между
 * «не умеем» и «сломано» обязана доходить до пользователя.
 */
export interface CodeIntel {
  readonly id: CodeIntelId;
  readonly state: CodeIntelState;
  readonly capabilities: ReadonlySet<CodeIntelCapability>;

  /** Языки, на которых работают `symbol` и `fan_in`. */
  langs(): ReadonlySet<string>;

  resolveSymbol(repo: RepoId, name: string): Promise<SymbolHit[]>;
  fanIn(repo: RepoId, name: string): Promise<FanIn>;
  defsOf(repo: RepoId, path: string): Promise<SymbolHit[]>;

  callers?(
    repo: RepoId,
    name: string,
    o?: { depth?: number | "all" },
  ): Promise<CallEdge[]>;
  search?(repo: RepoId, q: string, o?: { limit?: number }): Promise<CodeHit[]>;
  map?(repo: RepoId): Promise<Cluster[]>;

  /**
   * Что реализация просмотрела бы по этому репозиторию. Нужен для §6.3:
   * пустая выдача обязана прийти вместе с `searched: {files, langs}`.
   */
  scope?(repo: RepoId): Promise<SearchedScope>;
}

export * from "./select.ts";
export * from "./anchors.ts";
