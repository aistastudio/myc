/**
 * Охранный тест зоны B (memory-347rah165vkk, эпик memory-rc2s0m1e9kpz): всё,
 * что код-интеллект, интеграция и MCP печатают человеку или агенту, — по-английски.
 *
 * Зона B — команды CLI из CLI_COMMANDS, файлы каркаса из CLI_FILES, каталог
 * хуков CLI_DIRS и весь src пакетов из PACKAGES. Тест разбирает КАЖДЫЙ
 * не-тестовый исходник зоны компилятором TypeScript и находит строковые,
 * шаблонные (голова, середины, хвост) и regex-литералы с кириллицей. Любой
 * такой литерал вне EXCEPTIONS — падение с путём, строкой и владельцем.
 *
 * Исключение — это не файл, а объявление в файле (константа, функция) с
 * причиной. Русский текст остаётся только там, где он не вывод: словарь разбора
 * русского ввода (стенограммы, подвалы старых транскриптов) или комментарии
 * внутри генерируемого helper'а, которые не печатаются, а правка которых меняет
 * файл хука у всех проектов и заставляет Codex снова просить ревью хуков.
 * Исключение обязано указывать на существующее объявление, покрывать хотя бы
 * один литерал и быть объяснено: «исключение на весь файл» и протухшее
 * исключение ловятся здесь же.
 *
 * Сторож доказывает, что видит: детектор проверен на синтетическом исходнике
 * (строка, шаблон, regex — видны; комментарий — нет), а корпус зоны ограничен
 * снизу числом файлов и литералов. Пустой скан не выдаёт себя за чистоту.
 *
 * Мутации, на которых тест обязан падать (проверены на приёмке):
 *   1 — `ctx.warn("x", "проверка")` в любом файле зоны: падает «ни одного
 *       литерала…» с путём и строкой;
 *   2 — исключение на файл (`symbol: "*"`, пустое или имя, которого в файле
 *       нет): падает «каждое исключение указывает на объявление»;
 *   3 — исключение, которое больше ничего не покрывает: падает «покрывает хотя
 *       бы один литерал».
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../../..");
const CYRILLIC = /[Ѐ-ӿ]/;

/** Команды зоны B в packages/cli/src/commands (без .ts). */
const CLI_COMMANDS = [
  "code", "callers", "anchor", "skeleton", "bootstrap", "init", "wire", "doctor", "version",
  "models", "statusline",
] as const;

/** Файлы каркаса CLI, принадлежащие зоне B. */
const CLI_FILES = [
  "update-check.ts",
  "statusline-session.ts",
  "statusline-session.samples.ts",
  "statusline-config.ts",
  "statusline-passthrough.ts",
] as const;

/** Каталоги CLI зоны B целиком. */
const CLI_DIRS = ["hooks"] as const;

/** Пакеты зоны B целиком (их src). */
const PACKAGES = ["code-intel", "mcp"] as const;

interface Exception {
  /** Путь от корня репозитория. */
  readonly file: string;
  /** Объявление: `HUMAN_COUNTERS`, `claudeHelper` — не файл. */
  readonly symbol: string;
  readonly reason: string;
}

const HELPER_REASON =
  "комментарии внутри генерируемого helper'а хуков: не печатаются; правка меняет файл " +
  "helper'а в каждом проекте, и Codex снова требует у человека ревью хуков";

const SAMPLES_REASON =
  "образцы для отпечатка классификатора строки статуса: русские формы вывода из " +
  "транскриптов до перевода — вход разбора, а не вывод";

const EXCEPTIONS: readonly Exception[] = [
  // --- словари разбора русского ввода -------------------------------------
  {
    file: "packages/cli/src/hooks/transcript.ts",
    symbol: "DECISION_RE",
    reason: "словарь разбора русского ввода: маркеры решения в стенограмме (английские формы уже в нём)",
  },
  {
    file: "packages/cli/src/hooks/transcript.ts",
    symbol: "OPEN_RE",
    reason: "словарь разбора русского ввода: маркеры открытого вопроса в стенограмме (английские формы уже в нём)",
  },
  {
    file: "packages/cli/src/statusline-session.ts",
    symbol: "HUMAN_COUNTERS",
    reason: "словарь разбора: русские подвалы команд в транскриптах до перевода CLI (английские формы рядом)",
  },
  { file: "packages/cli/src/statusline-session.samples.ts", symbol: "BASH_SAMPLES", reason: SAMPLES_REASON },
  { file: "packages/cli/src/statusline-session.samples.ts", symbol: "MCP_SAMPLES", reason: SAMPLES_REASON },
  { file: "packages/cli/src/statusline-session.samples.ts", symbol: "CLI_SAMPLES", reason: SAMPLES_REASON },
  // --- тела генерируемых helper'ов: только комментарии ---------------------
  ...["GENERATED", "BIN_LOOKUP", "claudeHelper", "codexHelper", "opencodePlugin", "kimiHelper"].map((symbol) => ({
    file: "packages/cli/src/hooks/templates.ts",
    symbol,
    reason: HELPER_REASON,
  })),
];

// ---------------------------------------------------------------------------
// Сбор файлов зоны
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
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
  const dirs = [
    ...CLI_DIRS.map((d) => join(ROOT, "packages/cli/src", d)),
    ...PACKAGES.map((p) => join(ROOT, "packages", p, "src")),
  ];
  for (const dir of dirs) {
    if (existsSync(dir)) walk(dir, files);
    else missing.push(dir);
  }
  return { files: files.map((f) => relative(ROOT, f)).sort(), missing: missing.map((f) => relative(ROOT, f)) };
}

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

interface Literal {
  readonly file: string;
  readonly line: number;
  /** Цепочка объявлений от внешнего к внутреннему: `buildRescuePacket.head`; `""` — верхний уровень. */
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

/** Текст литерала, который может дойти до вывода; комментарии сюда не попадают по построению. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) return node.text;
  if (ts.isJsxText(node)) return node.text;
  return undefined;
}

interface Parsed {
  readonly literals: Literal[];
  /** Все литералы файла, с кириллицей и без: корпус, по которому сторож доказывает, что читает. */
  readonly scanned: number;
  /** Все цепочки объявлений файла: по ним проверяется, что исключение указывает на настоящее. */
  readonly declarations: Set<string>;
}

function parseSource(file: string, source: string): Parsed {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const literals: Literal[] = [];
  const declarations = new Set<string>();
  let scanned = 0;
  const visit = (node: ts.Node): void => {
    const name = declName(node);
    if (name !== undefined) {
      const outer = ownerOf(node);
      declarations.add(outer.length > 0 ? `${outer}.${name}` : name);
    }
    const text = literalText(node);
    if (text !== undefined) {
      scanned++;
      if (CYRILLIC.test(text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        literals.push({ file, line: line + 1, owner: ownerOf(node), text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, scanned, declarations };
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
const parsed = new Map(zone.files.map((f) => [f, parseSource(f, readFileSync(join(ROOT, f), "utf8"))] as const));
const literals = [...parsed.values()].flatMap((p) => p.literals);
const scanned = [...parsed.values()].reduce((n, p) => n + p.scanned, 0);

describe("сторож видит кириллицу там, где она может дойти до вывода", () => {
  const probe = parseSource(
    "probe.ts",
    [
      "// комментарий: не литерал, в вывод не идёт",
      "/* и этот: «проверка» */",
      "function report(ctx: { warn(c: string, m: string): void }, n: number): string {",
      '  ctx.warn("x", "проверка");',
      "  const re = /вхожден/;",
      "  return `ok ${n} файлов · ${n} мс`;",
      "}",
      "const PLAIN = 'all English here';",
    ].join("\n"),
  );

  test("строка, шаблон и regex найдены с владельцем и строкой; комментарии — нет", () => {
    expect(probe.literals.map((l) => `${l.line} ${l.owner} ${l.text}`)).toEqual([
      "4 report проверка",
      "5 report.re /вхожден/",
      "6 report  файлов · ",
      "6 report  мс",
    ]);
    expect(probe.scanned).toBe(7);
    expect(probe.declarations.has("report")).toBe(true);
    expect(probe.declarations.has("report.re")).toBe(true);
  });
});

describe("зона B печатает по-английски", () => {
  test("все файлы зоны на месте и разобраны", () => {
    // Переименованная команда или пакет выпали бы из скана молча — это отказ.
    expect(zone.missing).toEqual([]);
    expect(zone.files.length).toBeGreaterThan(40);
    for (const f of [
      "packages/cli/src/commands/code.ts",
      "packages/cli/src/commands/wire.ts",
      "packages/cli/src/hooks/rescue.ts",
      "packages/cli/src/update-check.ts",
      "packages/code-intel/src/select.ts",
      "packages/mcp/src/tools.ts",
    ]) {
      expect(zone.files).toContain(f);
    }
    // Корпус измерен снизу: сломанный разбор дал бы ноль литералов и ноль находок.
    expect(scanned).toBeGreaterThan(4000);
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
    const stale = EXCEPTIONS.filter((ex) => !literals.some((lit) => covers(ex, lit))).map((ex) => `${ex.file} ${ex.symbol}`);
    expect(stale).toEqual([]);
    const unexplained = EXCEPTIONS.filter((ex) => ex.reason.trim().length < 20).map((ex) => `${ex.file} ${ex.symbol}`);
    expect(unexplained).toEqual([]);
    const twice = EXCEPTIONS.map((ex) => `${ex.file} ${ex.symbol}`).filter((k, i, all) => all.indexOf(k) !== i);
    expect(twice).toEqual([]);
  });
});
