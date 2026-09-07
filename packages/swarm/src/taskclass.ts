/**
 * Отпечаток задачи: ось `intent × scope` — ключ, по которому задаётся
 * вопрос приёмки W11 «какая модель НА КАКОМ КЛАССЕ ЗАДАЧ дешевле».
 * Спецификация — docs/design/04-swarm-learning-and-routing.md §2.1.3–2.1.4.
 *
 * Здесь реализованы обе оси и ничего сверх них: контекстные признаки
 * (size, depth, ctx, langs, …) в ключ приоров не входят, а depth требует
 * graft в горячем пути, что запрещено (И3). fanIn поэтому считается равным
 * нулю, и решение «один файл → local» принимается без графа: разница с
 * полной формулой §2.1.4 только в том, что одиночный файл с fan-in > 3 мы
 * назовём local, а не module.
 *
 * Классификатор ДЕТЕРМИНИРОВАН и версионирован (FP_VERSION). Точность
 * лексикона ~80 % и этого достаточно: ошибка классификации — шум,
 * одинаковый для всех моделей, он не смещает сравнение моделей между
 * собой. Смещает — недетерминизм, поэтому ни сети, ни LLM здесь нет.
 */

export const FP_VERSION = 1;

export const INTENTS = [
  "fix",
  "feature",
  "refactor",
  "test",
  "docs",
  "config",
  "investigate",
] as const;
export type Intent = (typeof INTENTS)[number];

export const SCOPES = ["local", "module", "cross", "unknown"] as const;
export type Scope = (typeof SCOPES)[number];

export type TaskClass = `${Intent}:${Scope}`;

/**
 * Приоритет при конфликте нескольких совпадений в заголовке (§2.1.3):
 * дефект важнее всего, `feature` — остаточный класс.
 */
const INTENT_PRIORITY: readonly Intent[] = [
  "fix",
  "config",
  "test",
  "docs",
  "refactor",
  "feature",
  "investigate",
];

/**
 * Лексикон основ, обрезанных до 5 символов (§2.1.3). Слово заголовка
 * относится к намерению, если основа — его префикс. Обе оси языка: у нас
 * задачи ставятся по-русски, а код и коммиты по-английски.
 */
const LEXICON: Readonly<Record<Intent, readonly string[]>> = {
  fix: [
    "fix", "bug", "crash", "broke", "regre", "fail", "repai", "patch", "hotfi",
    "испра", "почин", "падае", "ошибк", "чинит", "слома", "дефек", "баг",
  ],
  feature: [
    "add", "imple", "suppo", "featu", "creat", "intro", "build", "enabl", "new",
    "добав", "реали", "сдела", "ввест", "завес", "созда", "постр", "научи",
  ],
  refactor: [
    "refac", "extra", "renam", "clean", "simpl", "inlin", "move", "split", "unify",
    "рефак", "вынес", "переи", "упрос", "перен", "разде", "приве", "почис",
  ],
  test: [
    "test", "spec", "cover", "fuzz", "mutat",
    "тест", "покры", "мутац", "прове",
  ],
  docs: [
    "doc", "readm", "comme", "guide", "chang",
    "докум", "описа", "комме", "поясн", "замет",
  ],
  config: [
    "ci", "deps", "bump", "upgra", "confi", "docke", "lint", "build", "relea", "packa",
    "завис", "обнов", "конфи", "сборк", "выкат", "релиз",
  ],
  investigate: [
    "inves", "why", "analy", "expla", "explo", "audit", "check", "resea",
    "разбо", "почем", "выясн", "объяс", "иссле", "понят", "сравн",
  ],
};

const TEST_PATH_RE = /(^|\/)(__tests__|tests?|spec)\//i;
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)test_)/i;
const DOC_EXT_RE = /\.(md|mdx|rst|txt|adoc)$/i;
const CONFIG_EXT_RE = /\.(ya?ml|toml|json|lock|ini|cfg|conf|env)$/i;
const CONFIG_NAME_RE = /(^|\/)(dockerfile|makefile|\.gitignore|\.npmrc)$/i;

/** Слова заголовка: буквы и цифры любого алфавита, нижний регистр, ≤ 5 символов. */
function stems(title: string): string[] {
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return words.filter((w) => w.length > 0).map((w) => w.slice(0, 5));
}

function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path) || TEST_PATH_RE.test(path);
}

function isConfigPath(path: string): boolean {
  return CONFIG_EXT_RE.test(path) || CONFIG_NAME_RE.test(path);
}

export interface TaskClassInput {
  /** Заголовок задачи. Описание НЕ используется: оно шумное (§2.1.3). */
  readonly title: string;
  /** Подтип задачи L1 (attrs.type): bug | task | epic | chore. */
  readonly type?: string;
  /** Явно объявленное намерение — оркестратор знает, что делает. */
  readonly intent?: string;
  /** Пути якорей задачи; пусто — scope неизвестен, а не «local». */
  readonly anchorPaths?: readonly string[];
}

export interface TaskClassResult {
  readonly intent: Intent;
  readonly scope: Scope;
  readonly taskClass: TaskClass;
  /** Чем решилось намерение: полезно в отчёте «предсказано × фактически». */
  readonly intentSource: "declared" | "type" | "title" | "anchors";
  readonly fpVersion: number;
}

function declaredIntent(value: string | undefined): Intent | undefined {
  if (value === undefined) return undefined;
  return (INTENTS as readonly string[]).includes(value) ? (value as Intent) : undefined;
}

function intentFromTitle(title: string): Intent | undefined {
  const words = new Set(stems(title));
  const hits = new Set<Intent>();
  for (const intent of INTENTS) {
    for (const stem of LEXICON[intent]) {
      for (const word of words) {
        if (word.startsWith(stem)) {
          hits.add(intent);
          break;
        }
      }
      if (hits.has(intent)) break;
    }
  }
  if (hits.size === 0) return undefined;
  return INTENT_PRIORITY.find((i) => hits.has(i));
}

function intentFromAnchors(paths: readonly string[]): Intent {
  if (paths.length === 0) return "feature";
  if (paths.every(isTestPath)) return "test";
  if (paths.every((p) => DOC_EXT_RE.test(p))) return "docs";
  if (paths.every(isConfigPath)) return "config";
  return "feature";
}

function firstSegment(path: string): string {
  const clean = path.replace(/^\.?\//, "");
  const slash = clean.indexOf("/");
  return slash === -1 ? clean : clean.slice(0, slash);
}

export function computeScope(anchorPaths: readonly string[] = []): Scope {
  const files = [...new Set(anchorPaths.filter((p) => p.trim() !== ""))];
  if (files.length === 0) return "unknown";
  if (files.length === 1) return "local";
  const topdirs = new Set(files.map(firstSegment));
  if (files.length <= 5 && topdirs.size === 1) return "module";
  return "cross";
}

/**
 * Три источника намерения в порядке убывания приоритета; первый, давший
 * ответ, побеждает (§2.1.3). Тип `bug` — это «исправление», и это не
 * ручной ярлык: поле уже заполнено грамматикой `myc bug`.
 */
export function computeTaskClass(input: TaskClassInput): TaskClassResult {
  const anchorPaths = input.anchorPaths ?? [];
  const scope = computeScope(anchorPaths);

  let intent = declaredIntent(input.intent);
  let intentSource: TaskClassResult["intentSource"] = "declared";
  if (intent === undefined && input.type === "bug") {
    intent = "fix";
    intentSource = "type";
  }
  if (intent === undefined) {
    const fromTitle = intentFromTitle(input.title);
    if (fromTitle !== undefined) {
      intent = fromTitle;
      intentSource = "title";
    }
  }
  if (intent === undefined) {
    intent = intentFromAnchors(anchorPaths);
    intentSource = "anchors";
  }

  return {
    intent,
    scope,
    taskClass: `${intent}:${scope}`,
    intentSource,
    fpVersion: FP_VERSION,
  };
}

export function isTaskClass(value: string): value is TaskClass {
  const [intent, scope] = value.split(":");
  return (
    intent !== undefined &&
    scope !== undefined &&
    (INTENTS as readonly string[]).includes(intent) &&
    (SCOPES as readonly string[]).includes(scope)
  );
}
