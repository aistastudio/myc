/**
 * Охранный тест веб-интерфейса (memory-fqeqzp2m376h, продолжение эпика
 * memory-rc2s0m1e9kpz): всё, что `myc viz` показывает человеку в браузере или
 * отдаёт в ответе API, — по-английски, теми же словами, что CLI.
 *
 * Зона — весь не-тестовый src пакета: серверные модули (отказы записи,
 * деградации здоровья и роутинга, подписи слагаемых ready), клиент
 * (client/app.ts, воркер лэйаута) и два статичных ассета, которые сервер
 * отдаёт как есть (client/index.html, client/app.css). Приём — тот же, что у
 * сторожей зон A и B в packages/cli (english-output.zone-*.test.ts): каждый
 * исходник разбирается компилятором TypeScript, строковые, шаблонные (голова,
 * середины, хвост) и regex-литералы с кириллицей — падение с путём, строкой и
 * владельцем. Комментарии не литералы и сюда не попадают: русские комментарии
 * — норма проекта.
 *
 * Кириллица — не единственный путь русского текста в браузер: локаль
 * `toLocaleDateString("ru-RU", {month: "long"})` печатает месяц словом, не
 * имея в исходнике ни одной русской буквы. Поэтому отдельно ловится русская
 * локаль в toLocale* и Intl.* и `lang="ru"` у страницы.
 *
 * Исключение — объявление в файле (константа, функция) с причиной, а не файл:
 * русский текст допустим только там, где он вход, а не вывод (словарь разбора
 * русского ввода). Сейчас таких мест в вебе нет, и список пуст; проверки
 * списка остаются, чтобы первое же исключение было честным.
 *
 * Мутации, на которых тест обязан падать (проверены на приёмке):
 *   1 — вернуть русскую строку в client/app.ts (`"свойства"` вместо
 *       `"properties"`): падает «ни одного литерала…» с путём и строкой;
 *   2 — `toLocaleString("ru-RU")` в fmtInt: падает «русской локали нет»;
 *   3 — `<html lang="ru">` или русская кнопка в index.html: падает «страница…».
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../../..");
const SRC = join(ROOT, "packages/web/src");
const CYRILLIC = /[Ѐ-ӿ]/;
/** Русская локаль: "ru", "ru-RU", "ru_RU" — любая форма, что даст месяц словом. */
const RU_LOCALE = /^ru(?:[-_][A-Za-z]{2,})?$/i;

const HTML = "packages/web/src/client/index.html";
const CSS = "packages/web/src/client/app.css";

interface Exception {
  /** Путь от корня репозитория. */
  readonly file: string;
  /** Объявление: `LEXICON`, `parseQuery` — не файл. */
  readonly symbol: string;
  readonly reason: string;
}

const EXCEPTIONS: readonly Exception[] = [];

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

function zoneFiles(): string[] {
  const files: string[] = [];
  walk(SRC, files);
  return files.map((f) => relative(ROOT, f)).sort();
}

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

interface Literal {
  readonly file: string;
  readonly line: number;
  /** Цепочка объявлений от внешнего к внутреннему: `GraphView.load`; `""` — верхний уровень. */
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

/**
 * Первый аргумент вызова, форматирующего по локали: `x.toLocaleString(loc)`,
 * `toLocaleDateString`, `toLocaleTimeString`, `new Intl.DateTimeFormat(loc)` и
 * любой другой `Intl.*`. Возвращает литерал локали или undefined.
 */
function localeArg(node: ts.Node): string | undefined {
  let callee: ts.Expression | undefined;
  let args: ts.NodeArray<ts.Expression> | undefined;
  if (ts.isCallExpression(node)) {
    callee = node.expression;
    args = node.arguments;
  } else if (ts.isNewExpression(node)) {
    callee = node.expression;
    args = node.arguments;
  }
  if (callee === undefined || args === undefined || args.length === 0) return undefined;
  const isLocaleCall =
    (ts.isPropertyAccessExpression(callee) && /^toLocale/.test(callee.name.text)) ||
    (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Intl");
  if (!isLocaleCall) return undefined;
  const first = args[0]!;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  if (ts.isArrayLiteralExpression(first)) {
    const ru = first.elements.find((e) => ts.isStringLiteral(e) && RU_LOCALE.test(e.text));
    return ru !== undefined ? (ru as ts.StringLiteral).text : undefined;
  }
  return undefined;
}

interface Parsed {
  readonly literals: Literal[];
  /** Русская локаль в форматирующих вызовах — `ru-RU` без единой русской буквы. */
  readonly ruLocales: Literal[];
  /** Все литералы файла, с кириллицей и без: корпус, по которому сторож доказывает, что читает. */
  readonly scanned: number;
  /** Все цепочки объявлений файла: по ним проверяется, что исключение указывает на настоящее. */
  readonly declarations: Set<string>;
}

function parseSource(file: string, source: string): Parsed {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const literals: Literal[] = [];
  const ruLocales: Literal[] = [];
  const declarations = new Set<string>();
  let scanned = 0;
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    const name = declName(node);
    if (name !== undefined) {
      const outer = ownerOf(node);
      declarations.add(outer.length > 0 ? `${outer}.${name}` : name);
    }
    const text = literalText(node);
    if (text !== undefined) {
      scanned++;
      if (CYRILLIC.test(text)) literals.push({ file, line: lineOf(node), owner: ownerOf(node), text });
    }
    const loc = localeArg(node);
    if (loc !== undefined && RU_LOCALE.test(loc)) {
      ruLocales.push({ file, line: lineOf(node), owner: ownerOf(node), text: loc });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, ruLocales, scanned, declarations };
}

/**
 * Текст статичного ассета, который видит браузер, — без комментариев:
 * `<!-- … -->` у HTML и `/* … *\/` у CSS. Комментарий в ответе сервера
 * человек не читает, а вот подпись кнопки, placeholder, title и CSS `content:`
 * — читает.
 */
function assetOffenders(file: string, source: string, comment: RegExp): string[] {
  const out: string[] = [];
  // Комментарий может тянуться через строки: он заменяется пробелами, а
  // переводы строк остаются — номер строки находки совпадает с исходником.
  const masked = source.replace(comment, (m) => m.replace(/[^\n]/g, " "));
  masked.split("\n").forEach((line, i) => {
    if (CYRILLIC.test(line)) out.push(`${file}:${i + 1}  "${line.trim().slice(0, 80)}"`);
  });
  return out;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

function covers(ex: Exception, lit: Literal): boolean {
  return ex.file === lit.file && (lit.owner === ex.symbol || lit.owner.startsWith(`${ex.symbol}.`));
}

function show(lit: Literal): string {
  const text = lit.text.replace(/\s+/g, " ").trim();
  return `${lit.file}:${lit.line}  ${lit.owner || "<верхний уровень>"}  "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`;
}

// ---------------------------------------------------------------------------

const files = zoneFiles();
const parsed = new Map(files.map((f) => [f, parseSource(f, readFileSync(join(ROOT, f), "utf8"))] as const));
const literals = [...parsed.values()].flatMap((p) => p.literals);
const ruLocales = [...parsed.values()].flatMap((p) => p.ruLocales);
const scanned = [...parsed.values()].reduce((n, p) => n + p.scanned, 0);
const html = readFileSync(join(ROOT, HTML), "utf8");
const css = readFileSync(join(ROOT, CSS), "utf8");

describe("сторож видит русский текст там, где он может дойти до браузера", () => {
  const probe = parseSource(
    "probe.ts",
    [
      "// комментарий: не литерал, в вывод не идёт",
      "/* и этот: «проверка» */",
      "function render(el: (t: string) => void, n: number, ms: number): string {",
      '  el("свойства");',
      "  const re = /вхожден/;",
      '  const day = new Date(ms).toLocaleDateString("ru-RU", { month: "long" });',
      '  const num = n.toLocaleString("en-US");',
      '  const fmt = new Intl.NumberFormat(["ru"]);',
      "  return `ok ${n} узлов · ${day} ${num} ${fmt} мс`;",
      "}",
      "const PLAIN = 'all English here';",
    ].join("\n"),
  );

  test("строка, шаблон и regex найдены с владельцем и строкой; комментарии — нет", () => {
    expect(probe.literals.map((l) => `${l.line} ${l.owner} ${l.text}`)).toEqual([
      "4 render свойства",
      "5 render.re /вхожден/",
      "9 render  узлов · ",
      "9 render  мс",
    ]);
    expect(probe.declarations.has("render")).toBe(true);
    expect(probe.declarations.has("render.day")).toBe(true);
  });

  test("русская локаль поймана и в строке, и в массиве; английская — нет", () => {
    expect(probe.ruLocales.map((l) => `${l.line} ${l.owner} ${l.text}`)).toEqual([
      "6 render.day ru-RU",
      "8 render.fmt ru",
    ]);
  });

  test("в ассете видна подпись, а комментарий — нет", () => {
    const page = ["<!-- ГРАФ -->", '<button title="тема">auto</button>', "<!--", "  многострочный", "-->", "<h2>Граф</h2>"].join("\n");
    expect(assetOffenders("probe.html", page, HTML_COMMENT)).toEqual([
      'probe.html:2  "<button title="тема">auto</button>"',
      'probe.html:6  "<h2>Граф</h2>"',
    ]);
    const sheet = ["/* палитра */", '.x::after { content: "ещё"; }'].join("\n");
    expect(assetOffenders("probe.css", sheet, CSS_COMMENT)).toEqual(['probe.css:2  ".x::after { content: "ещё"; }"']);
  });
});

describe("веб-интерфейс говорит по-английски", () => {
  test("все файлы зоны на месте и разобраны", () => {
    // Переименованный модуль выпал бы из скана молча — это отказ.
    expect(files.length).toBeGreaterThan(20);
    for (const f of [
      "packages/web/src/client/app.ts",
      "packages/web/src/client/layout.worker.ts",
      "packages/web/src/mutate.ts",
      "packages/web/src/health.ts",
      "packages/web/src/server.ts",
      "packages/web/src/ready.ts",
      "packages/web/src/routing.ts",
    ]) {
      expect(files).toContain(f);
    }
    // Корпус измерен снизу: сломанный разбор дал бы ноль литералов и ноль находок.
    expect(scanned).toBeGreaterThan(2500);
  });

  test("ни одного литерала с кириллицей вне исключений", () => {
    const offenders = literals.filter((lit) => !EXCEPTIONS.some((ex) => covers(ex, lit))).map(show);
    expect(offenders).toEqual([]);
  });

  test("русской локали нет ни в toLocale*, ни в Intl.*: даты и числа — как в CLI", () => {
    expect(ruLocales.map(show)).toEqual([]);
  });

  test("страница index.html: ни русской подписи, ни lang=\"ru\"", () => {
    expect(assetOffenders(HTML, html, HTML_COMMENT)).toEqual([]);
    const lang = /<html[^>]*\blang="([^"]*)"/i.exec(html);
    expect(lang?.[1]).toBe("en");
  });

  test("стили app.css: ни одного русского content: вне комментариев", () => {
    expect(assetOffenders(CSS, css, CSS_COMMENT)).toEqual([]);
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
