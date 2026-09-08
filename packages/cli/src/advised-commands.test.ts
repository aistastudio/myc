/**
 * Сторож советов: команда, НАЗВАННАЯ пользователю, обязана существовать.
 *
 * Появился после `myc doctor` (memory-ryk2t5pft1mh). На эту команду вело 24
 * упоминания в 17 файлах — поля `hint` у `precond.schema`, тексты отказов
 * миграции, подсказки `reindex`, — а самой команды не было ни дня. Рядом жил
 * второй такой же: отказ открыть базу, записанную более новой версией,
 * советовал `myc self-update`, и на этот совет CLI отвечал «unknown command
 * 'self-update'; did you mean 'model update'?». Оба совета печатались ровно в
 * тот момент, когда у человека уже что-то сломалось, — то есть худшее место,
 * где можно потратить его попытку.
 *
 * register.test.ts стережёт ОБРАТНОЕ направление: команда написана, но не
 * подключена. Здесь — команда советуется, но не написана. Ни один из двух
 * сторожей не видит находки другого.
 *
 * ЧТО СЧИТАЕТСЯ СОВЕТОМ, А ЧТО НЕТ. Смотрим только на строковые литералы —
 * то, что доедет до вывода. Комментарии и докстроки вырезаются: там `myc
 * doctor` называют, обсуждая замысел, и требовать от замысла существования
 * было бы враньём наоборот. Внутри литерала совет узнаётся по одному из двух
 * признаков, и оба — принятая в этом коде запись команды:
 *   1. обратные кавычки: "…`myc ready --claim` — взять работу";
 *   2. литерал ЦЕЛИКОМ является командной строкой: hint: "myc doctor --schema".
 * Прозе это не мешает: "myc instead of TodoWrite" и "the only network myc
 * makes" не подходят ни под один признак, и `instead`/`makes` командами не
 * объявляются. Проверено на живом корпусе: без этого правила ложных
 * срабатываний было девять.
 *
 * САМ СТОРОЖ ОБЯЗАН ДОКАЗЫВАТЬ, ЧТО ЧТО-ТО НАШЁЛ. Сломанная регулярка даёт
 * пустое множество, пустое множество сходится с «нет пропущенных», и проверка
 * молча превращается в украшение. Поэтому корпус измеряется и снизу
 * ограничен — тремя числами сразу: упоминаний, различных команд, файлов.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SCHEMA_UPGRADE_HINT } from "@myc/store-sqlite";
import { Registry } from "./registry.ts";
import { registerAll } from "./register.ts";
import { UPGRADE_COMMAND } from "./update-check.ts";
import { HOOK_SPECS } from "./hooks/templates.ts";
import { SELF_REPORTING_HOOKS } from "./hooks/counters.ts";

/** Корень монорепозитория: packages/cli/src → ../../.. */
const REPO = join(import.meta.dir, "../../..");

/** Где ищем советы. Тесты исключены: их тексты пользователь не видит. */
const ROOTS = ["packages", "scripts"];

/**
 * Советы, которые СЕЙЧАС называют несуществующую команду, — с причиной и
 * адресом. Каждая строка здесь — незакрытый долг, а не разрешение: пока она
 * тут, продукт обещает пользователю то, чего нет.
 *
 * Ключ — `<команда> @ <файл>`, а не одна команда: то же имя, всплывшее в
 * другом файле, обязано уронить сторож заново.
 */
const KNOWN_MISSING = new Map<string, string>([
  [
    "route @ packages/cli/src/commands/prime.ts",
    "help `myc prime` обещает «`myc route` — отдельная команда (S12)»; команды нет в реестре. " +
      "Файл вне границ задачи memory-ryk2t5pft1mh — правку делает владелец prime/S12.",
  ],
  [
    "link @ packages/cli/src/hooks/templates.ts",
    "SKILL.md, который `myc wire` кладёт КАЖДОМУ агенту, велит писать " +
      "`myc link A supersedes B --reason \"...\"`; команды нет в реестре (ребро supersedes " +
      "ставит absorb сам). Файл вне границ задачи memory-ryk2t5pft1mh.",
  ],
]);

// ---------------------------------------------------------------------------
// Разбор исходника: строковые литералы без комментариев
// ---------------------------------------------------------------------------

interface Literal {
  readonly text: string;
  readonly line: number;
}

/**
 * Строковые литералы файла: одинарные, двойные и шаблонные. Разбор посимвольный,
 * а не регуляркой, ровно затем, чтобы отличать `//` внутри строки от начала
 * комментария и `${…}` внутри шаблона от его текста. Подстановка обрывает
 * литерал: в `myc ${cmd}` после «myc » ничего не сказано, и выдумывать имя
 * команды здесь нельзя.
 */
export function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const start = line;
      i++;
      let buf = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          buf += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        buf += src[i];
        i++;
      }
      i++;
      out.push({ text: buf, line: start });
      continue;
    }
    if (c === "`") {
      const start = line;
      i++;
      let buf = "";
      while (i < n) {
        if (src[i] === "\\") {
          buf += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === "`") {
          i++;
          break;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          out.push({ text: buf, line: start });
          buf = "";
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            else if (src[i] === "\n") line++;
            i++;
          }
          continue;
        }
        if (src[i] === "\n") line++;
        buf += src[i];
        i++;
      }
      out.push({ text: buf, line: start });
      continue;
    }
    i++;
  }
  return out;
}

/** `myc <команда> [<подкоманда>]`. Кириллица и флаги не совпадают by design. */
const COMMAND_RE = /myc ([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?/g;
const BACKTICKED_RE = /`([^`]*)`/g;
/** Литерал ЦЕЛИКОМ — командная строка, как в поле `hint`. */
const WHOLE_LINE_RE = /^myc [a-z][a-z0-9-]*(?:[ \t][^\n]*)?$/;

export interface Advice {
  readonly command: string;
  readonly sub: string | undefined;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

function adviceIn(text: string, file: string, line: number): Advice[] {
  const out: Advice[] = [];
  const collect = (fragment: string): void => {
    for (const m of fragment.matchAll(COMMAND_RE)) {
      out.push({
        command: m[1]!,
        sub: m[2],
        file,
        line,
        quote: fragment.trim().slice(0, 80),
      });
    }
  };
  for (const tick of text.matchAll(BACKTICKED_RE)) collect(tick[1]!);
  const whole = text.trim();
  if (!whole.includes("`") && WHOLE_LINE_RE.test(whole)) collect(whole);
  return out;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
      if (path.includes(".test.") || path.endsWith(".d.ts")) continue;
      out.push(path);
    }
  };
  for (const root of ROOTS) walk(join(REPO, root));
  return out;
}

export function collectAdvice(): Advice[] {
  const out: Advice[] = [];
  for (const file of sourceFiles()) {
    const rel = relative(REPO, file);
    for (const lit of stringLiterals(readFileSync(file, "utf8"))) {
      out.push(...adviceIn(lit.text, rel, lit.line));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("советуемые команды существуют", () => {
  test("каждая команда из текстов, подсказок и hint есть в реестре", async () => {
    const registry = new Registry();
    registerAll(registry);
    await registry.materializeAll();

    const advice = collectAdvice();
    const missing: string[] = [];
    const unusedExemptions = new Set(KNOWN_MISSING.keys());

    for (const a of advice) {
      const where = `${a.command} @ ${a.file}`;
      if (!registry.hasTop(a.command)) {
        unusedExemptions.delete(where);
        if (KNOWN_MISSING.has(where)) continue;
        missing.push(`${a.file}:${a.line} — «myc ${a.command}» нет в реестре: «${a.quote}»`);
        continue;
      }
      // Подкоманда проверяется только у команд-групп: у `import-beads` второе
      // слово — позиционный аргумент (`myc import-beads snapshot`), и требовать
      // от него быть подкомандой значило бы ловить собственную выдумку.
      const top = registry.resolve([a.command]);
      const hasChildren = (top?.subcommands ?? []).length > 0;
      if (a.sub !== undefined && hasChildren && registry.resolve([a.command, a.sub]) === undefined) {
        missing.push(
          `${a.file}:${a.line} — «myc ${a.command} ${a.sub}»: у ${a.command} нет такой подкоманды: «${a.quote}»`,
        );
      }
    }

    expect(missing).toEqual([]);
    // Исключение, которое перестало срабатывать, — это исправленный долг:
    // строку надо УБРАТЬ, иначе список исключений копит мусор и однажды
    // спрячет настоящую находку.
    expect([...unusedExemptions]).toEqual([]);
  });

  /**
   * Сторож самого сторожа. Все проверки выше сходятся на пустом множестве, а
   * пустым оно становится от любой мелочи: сломанной регулярки, переименованного
   * каталога, упавшего чтения. Поэтому корпус меряется тремя независимыми
   * числами — одно можно случайно удовлетворить, три сразу нет.
   */
  test("корпус непустой: сторож доказывает, что действительно что-то нашёл", () => {
    const advice = collectAdvice();
    const distinct = new Set(advice.map((a) => a.command));
    const files = new Set(advice.map((a) => a.file));

    expect(advice.length).toBeGreaterThan(60);
    expect(distinct.size).toBeGreaterThan(20);
    expect(files.size).toBeGreaterThan(10);
    // Именованные ориентиры: они приходят из РАЗНЫХ признаков — `myc doctor`
    // ловится полем hint (литерал целиком), `myc ready --claim` — обратными
    // кавычками внутри фразы. Пропажа любого означает, что отвалился признак,
    // а не что текст переписали.
    expect([...distinct]).toContain("doctor");
    expect([...distinct]).toContain("ready");
  });

  test("оба признака совета работают порознь", () => {
    const backticked = adviceIn("сначала `myc doctor --schema`, потом что-то ещё", "x.ts", 1);
    expect(backticked.map((a) => a.command)).toEqual(["doctor"]);

    const whole = adviceIn("myc doctor --recount", "x.ts", 1);
    expect(whole.map((a) => a.command)).toEqual(["doctor"]);

    // Проза командой не объявляется: ни кавычек, ни цельной командной строки.
    expect(adviceIn("use myc instead of TodoWrite for tracking", "x.ts", 1)).toEqual([]);
    // Подстановка обрывает литерал — имя команды из неё не выдумывается.
    expect(stringLiterals("const a = `myc ${cmd} --json`;").map((l) => l.text)).toEqual([
      "myc ",
      " --json",
    ]);
    // Комментарий не совет.
    expect(stringLiterals("// `myc route` когда-нибудь появится\nconst x = 1;")).toEqual([]);
  });
});

describe("совет по обновлению выполним", () => {
  /**
   * Сообщение `schema.newer` — единственное место, где myc просит человека
   * обновиться, и раньше оно называло несуществующую `myc self-update`.
   * Теперь оно называет команду пакетного менеджера, и она обязана совпадать
   * с той, что печатает `myc version`: две разные команды обновления в одном
   * продукте — это вопрос «а какая правильная?» вместо ответа.
   */
  test("текст отказа миграции печатает ровно ту же команду, что и myc version", () => {
    expect(SCHEMA_UPGRADE_HINT).toContain(UPGRADE_COMMAND);
  });

  test("совет про обновление не называет несуществующих команд myc", async () => {
    const registry = new Registry();
    registerAll(registry);
    await registry.materializeAll();
    const named = adviceIn(SCHEMA_UPGRADE_HINT, "migrate.ts", 0);
    expect(named.length).toBeGreaterThan(0); // совет обязан кого-то называть
    for (const a of named) expect(registry.hasTop(a.command)).toBe(true);
  });
});

describe("хуки: список самоотмечающихся событий сверен с кодом", () => {
  /**
   * `myc doctor --hooks` отвечает «не срабатывал» только про события из
   * SELF_REPORTING_HOOKS, а про остальные — «не знаю». Если кто-то добавит
   * recordHook в новый хук и забудет список, doctor продолжит отвечать «не
   * знаю» про событие, о котором данные уже есть; забудет наоборот — начнёт
   * утверждать «не срабатывал» про то, что себя не отмечает. Второе хуже.
   */
  test("recordHook зовут ровно для перечисленных событий", () => {
    const dir = join(import.meta.dir, "hooks");
    const events = new Set(HOOK_SPECS.map((s) => s.event as string));
    const found = new Set<string>();
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
      const src = readFileSync(join(dir, entry), "utf8");
      if (entry === "counters.ts") continue; // сам модуль счётчиков
      for (const call of src.matchAll(/recordHook\(([^)]*)\)/g)) {
        for (const m of call[1]!.matchAll(/:([a-z][a-z0-9-]*)/g)) {
          if (events.has(m[1]!)) found.add(m[1]!);
        }
      }
    }
    expect([...found].sort()).toEqual([...SELF_REPORTING_HOOKS].sort());
    expect(found.size).toBeGreaterThan(0);
  });
});
