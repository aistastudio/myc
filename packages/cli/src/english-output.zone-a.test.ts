/**
 * Охранный тест зоны A (эпик memory-rc2s0m1e9kpz): всё, что зона печатает
 * человеку или агенту, — по-английски.
 *
 * Зона A — задачи, память, хранилище: команды CLI из CLI_COMMANDS, три файла
 * каркаса из CLI_FILES и весь src пакетов из PACKAGES. Тест разбирает КАЖДЫЙ
 * не-тестовый исходник зоны компилятором TypeScript и находит строковые,
 * шаблонные и regex-литералы с кириллицей. Любой такой литерал вне
 * EXCEPTIONS — падение с путём и строкой.
 *
 * Исключение — это не файл, а объявление в файле (константа, функция, класс)
 * с причиной: русский текст остаётся только там, где он не вывод, а вход —
 * словарь разбора русского текста — или контракт, который нельзя переписать
 * (текст применённой миграции под checksum). Исключение обязано указывать на
 * существующее объявление и покрывать хотя бы один литерал: «исключение на
 * весь файл» и протухшее исключение ловятся здесь же.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../../..");
const CYRILLIC = /[\u0400-\u04FF]/;

/** Команды зоны A в packages/cli/src/commands (без .ts). */
const CLI_COMMANDS = [
  "tasks", "attempt", "import-beads", "retrieve", "dep", "recall", "prime", "show", "move",
  "absorb", "import", "ready", "search", "remember", "roster", "viz", "store", "link",
  "export", "reindex", "embedd", "list", "merge-driver", "move.worker", "show.merge.worker",
  "digest-cache.worker",
] as const;

/** Файлы каркаса CLI, принадлежащие зоне A. */
const CLI_FILES = ["drain.ts", "registry.ts", "net-trap.preload.ts"] as const;

/** Пакеты зоны A целиком (их src). */
const PACKAGES = [
  "core", "store-sqlite", "store-postgres", "retrieval", "embed", "swarm", "server", "bench",
] as const;

interface Exception {
  /** Путь от корня репозитория. */
  readonly file: string;
  /** Объявление: `LEXICON`, `taskNeedle`, `Roster.update` — не файл. */
  readonly symbol: string;
  readonly reason: string;
}

const MIGRATION_REASON =
  "текст применённой миграции под checksum (schema.checksum): правка ломает каждую " +
  "существующую базу; кириллица здесь — SQL-комментарии, в вывод не попадают";

const EXCEPTIONS: readonly Exception[] = [
  // --- словари разбора русского ввода -------------------------------------
  {
    file: "packages/core/src/absorb.ts",
    symbol: "NEGATION_PREFIX",
    reason: "словарь разбора русского ввода: отрицания перед словом (английские формы уже в нём)",
  },
  {
    file: "packages/core/src/absorb.ts",
    symbol: "NEGATION_POSTFIX",
    reason: "словарь разбора русского ввода: отрицания после слова («валидатора нет»); у английского такой формы нет",
  },
  {
    file: "packages/core/src/absorb.ts",
    symbol: "FUNCTION_WORDS",
    reason: "словарь разбора русского ввода: служебные слова, отрицание которых ничего не значит (английские уже в нём)",
  },
  {
    file: "packages/core/src/absorb.ts",
    symbol: "ANTONYM_STEMS",
    reason: "словарь разбора русского ввода: пары-антонимы по основе (английские пары уже в нём)",
  },
  {
    file: "packages/core/src/absorb.ts",
    symbol: "UPDATE_MARKERS",
    reason: "словарь разбора русского ввода: маркеры замены в новом тексте (английские уже в нём)",
  },
  {
    file: "packages/core/src/memory.ts",
    symbol: "SECTION_TYPE_BY_KEYWORD",
    reason: "словарь разбора русского ввода: заголовки секций документа (английские формы уже в regex)",
  },
  {
    file: "packages/swarm/src/taskclass.ts",
    symbol: "LEXICON",
    reason: "словарь разбора русского ввода: основы слов заголовка задачи по классам (английские уже в нём)",
  },
  {
    file: "packages/swarm/src/transcript.ts",
    symbol: "taskNeedle",
    reason: "разбор стенограмм: строка брифа «Задача myc: <id>», которую пишет координатор, — вход, а не вывод",
  },
  {
    file: "packages/embed/src/fixtures/separation-corpus.ts",
    symbol: "RU_PAIRS",
    reason: "корпус русского текста для замера эмбеддингов: вход модели, а не вывод; перевод сменил бы замер",
  },
  {
    file: "packages/embed/src/fixtures/separation-corpus.ts",
    symbol: "RU_UNRELATED",
    reason: "корпус русского текста для замера эмбеддингов: вход модели, а не вывод; перевод сменил бы замер",
  },
  // --- тексты применённых миграций ----------------------------------------
  ...[
    "packages/store-sqlite/src/migrations/001-init.ts",
    "packages/store-sqlite/src/migrations/002-oplog-pending.ts",
    "packages/store-sqlite/src/migrations/003-code-files.ts",
    "packages/store-sqlite/src/migrations/004-code-defs.ts",
    "packages/store-sqlite/src/migrations/005-code-refs.ts",
    "packages/store-sqlite/src/migrations/011-code-ref-sites.ts",
    "packages/store-sqlite/src/migrations/012-code-search.ts",
    "packages/store-sqlite/src/migrations/vec-001-init.ts",
    "packages/store-sqlite/src/migrations/vec-002-rerank-f32.ts",
    "packages/swarm/src/migrations/001-swarm-model.ts",
    "packages/swarm/src/migrations/002-swarm-model-price.ts",
    "packages/swarm/src/migrations/003-swarm-attempt.ts",
    "packages/swarm/src/migrations/006-swarm-attempt-run.ts",
    "packages/swarm/src/migrations/008-harness-codex.ts",
  ].map((file) => ({ file, symbol: "SQL", reason: MIGRATION_REASON })),
];

// ---------------------------------------------------------------------------
// Сбор файлов зоны
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
}

function zoneFiles(): { files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  const explicit = [
    ...CLI_COMMANDS.map((c) => join(ROOT, "packages/cli/src/commands", `${c}.ts`)),
    ...CLI_FILES.map((f) => join(ROOT, "packages/cli/src", f)),
  ];
  for (const path of explicit) (existsSync(path) ? files : missing).push(path);
  for (const pkg of PACKAGES) {
    const src = join(ROOT, "packages", pkg, "src");
    if (existsSync(src)) walk(src, files);
    else missing.push(src);
  }
  return { files: files.map((f) => relative(ROOT, f)).sort(), missing: missing.map((f) => relative(ROOT, f)) };
}

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

interface Literal {
  readonly file: string;
  readonly line: number;
  /** Цепочка объявлений от внешнего к внутреннему: `Roster.update`; `""` — верхний уровень. */
  readonly owner: string;
  readonly text: string;
}

function declName(node: ts.Node): string | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    const name = node.name;
    if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
  }
  return undefined;
}

function ownerOf(node: ts.Node): string {
  const chain: string[] = [];
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    const name = declName(cur);
    if (name !== undefined) chain.unshift(name);
  }
  return chain.join(".");
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) return node.text;
  if (ts.isJsxText(node)) return node.text;
  return undefined;
}

interface Parsed {
  readonly literals: Literal[];
  /** Все цепочки объявлений файла: по ним проверяется, что исключение указывает на настоящее. */
  readonly declarations: Set<string>;
}

function parse(file: string): Parsed {
  const abs = join(ROOT, file);
  const source = readFileSync(abs, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true, kind);
  const literals: Literal[] = [];
  const declarations = new Set<string>();
  const visit = (node: ts.Node): void => {
    const name = declName(node);
    if (name !== undefined) {
      const outer = ownerOf(node);
      declarations.add(outer.length > 0 ? `${outer}.${name}` : name);
    }
    const text = literalText(node);
    if (text !== undefined && CYRILLIC.test(text)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      literals.push({ file, line: line + 1, owner: ownerOf(node), text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, declarations };
}

function covers(ex: Exception, lit: Literal): boolean {
  return ex.file === lit.file && (lit.owner === ex.symbol || lit.owner.startsWith(`${ex.symbol}.`));
}

function show(lit: Literal): string {
  const text = lit.text.replace(/\s+/g, " ").trim();
  return `${lit.file}:${lit.line}  ${lit.owner || "<верхний уровень>"}  "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`;
}

// ---------------------------------------------------------------------------

const zone = zoneFiles();
const parsed = new Map(zone.files.map((f) => [f, parse(f)] as const));
const literals = [...parsed.values()].flatMap((p) => p.literals);

describe("зона A печатает по-английски", () => {
  test("все файлы зоны на месте и разобраны", () => {
    // Переименованная команда или пакет выпали бы из скана молча — это отказ.
    expect(zone.missing).toEqual([]);
    expect(zone.files.length).toBeGreaterThan(100);
    expect(zone.files).toContain("packages/cli/src/commands/tasks.ts");
    expect(zone.files).toContain("packages/core/src/absorb.ts");
    expect(zone.files).toContain("packages/swarm/src/transcript.ts");
  });

  test("ни одного литерала с кириллицей вне исключений", () => {
    const offenders = literals.filter((lit) => !EXCEPTIONS.some((ex) => covers(ex, lit))).map(show);
    expect(offenders).toEqual([]);
  });

  test("каждое исключение указывает на существующее объявление, а не на файл", () => {
    const bad: string[] = [];
    for (const ex of EXCEPTIONS) {
      const p = parsed.get(ex.file);
      if (p === undefined) {
        bad.push(`${ex.file}: файла нет в зоне`);
        continue;
      }
      if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(ex.symbol)) {
        bad.push(`${ex.file}: «${ex.symbol}» — не имя объявления`);
        continue;
      }
      if (!p.declarations.has(ex.symbol)) bad.push(`${ex.file}: объявления ${ex.symbol} нет`);
    }
    expect(bad).toEqual([]);
  });

  test("каждое исключение покрывает хотя бы один литерал и объяснено", () => {
    const stale = EXCEPTIONS.filter((ex) => !literals.some((lit) => covers(ex, lit))).map(
      (ex) => `${ex.file} ${ex.symbol}`,
    );
    expect(stale).toEqual([]);
    const unexplained = EXCEPTIONS.filter((ex) => ex.reason.trim().length < 20).map((ex) => `${ex.file} ${ex.symbol}`);
    expect(unexplained).toEqual([]);
  });
});
