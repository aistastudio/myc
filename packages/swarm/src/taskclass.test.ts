import { describe, expect, test } from "bun:test";
import {
  classifyTask,
  computeScope,
  computeTaskClass,
  INTENTS,
  isTaskClass,
  pathsInText,
  pickScopePaths,
} from "./taskclass.ts";

/**
 * Классификатор отпечатка. Проверяется не «точность» (её тут ~80 % и
 * этого достаточно), а три свойства, без которых ключ приоров непригоден:
 * детерминизм, порядок источников и то, что отсутствие якорей даёт
 * `unknown`, а не тихий `local`.
 */

describe("intent", () => {
  test("тип bug побеждает лексикон заголовка", () => {
    const r = computeTaskClass({ title: "Добавить поддержку кеша", type: "bug" });
    expect(r.intent).toBe("fix");
    expect(r.intentSource).toBe("type");
  });

  test("явно объявленное намерение побеждает тип", () => {
    const r = computeTaskClass({ title: "что угодно", type: "bug", intent: "docs" });
    expect(r.intent).toBe("docs");
    expect(r.intentSource).toBe("declared");
  });

  test("мусорное объявленное намерение игнорируется, а не записывается", () => {
    const r = computeTaskClass({ title: "Исправить падение импорта", intent: "не-намерение" });
    expect(r.intent).toBe("fix");
    expect(r.intentSource).toBe("title");
  });

  test.each([
    ["Исправить падение импорта на пустом оплоге", "fix"],
    ["Fix crash in oplog import", "fix"],
    ["Добавить команду myc route", "feature"],
    ["Вынести расчёт цены в отдельный модуль", "refactor"],
    ["Покрыть тестами гонку аренды", "test"],
    ["Обновить зависимости и конфиг сборки", "config"],
    ["Разобраться, почему prime тормозит", "investigate"],
  ])("лексикон: %s → %s", (title, expected) => {
    expect(computeTaskClass({ title }).intent).toBe(expected as never);
  });

  test("при конфликте побеждает приоритет: дефект важнее фичи", () => {
    const r = computeTaskClass({ title: "Добавить обработку и исправить падение" });
    expect(r.intent).toBe("fix");
  });

  test("заголовок молчит — решают якоря", () => {
    expect(
      computeTaskClass({ title: "Ыыы", anchorPaths: ["docs/design/04-swarm.md"] }).intent,
    ).toBe("docs");
    expect(
      computeTaskClass({ title: "Ыыы", anchorPaths: ["packages/a/src/x.test.ts"] }).intent,
    ).toBe("test");
    expect(computeTaskClass({ title: "Ыыы", anchorPaths: ["tsconfig.json"] }).intent).toBe(
      "config",
    );
    expect(computeTaskClass({ title: "Ыыы", anchorPaths: ["src/a.ts"] }).intent).toBe(
      "feature",
    );
  });

  test("классификатор детерминирован: сто прогонов дают один ответ", () => {
    const answers = new Set(
      Array.from({ length: 100 }, () =>
        computeTaskClass({
          title: "Исправить падение при импорте",
          anchorPaths: ["packages/core/src/oplog.ts", "packages/core/src/graph.ts"],
        }).taskClass,
      ),
    );
    expect([...answers]).toEqual(["fix:module"]);
  });
});

describe("scope", () => {
  test("без якорей — unknown, а не local", () => {
    expect(computeScope([])).toBe("unknown");
    expect(computeTaskClass({ title: "Исправить" }).taskClass).toBe("fix:unknown");
  });

  test("один файл — local", () => {
    expect(computeScope(["packages/core/src/a.ts"])).toBe("local");
  });

  test("до пяти файлов одного каталога верхнего уровня — module", () => {
    expect(computeScope(["packages/a.ts", "packages/b.ts", "packages/c.ts"])).toBe("module");
  });

  test("два каталога верхнего уровня — cross", () => {
    expect(computeScope(["packages/a.ts", "docs/b.md"])).toBe("cross");
  });

  test("шесть файлов одного каталога — cross", () => {
    expect(computeScope(["p/1", "p/2", "p/3", "p/4", "p/5", "p/6"])).toBe("cross");
  });

  test("повторы путей не раздувают scope", () => {
    expect(computeScope(["p/a.ts", "p/a.ts", "p/a.ts"])).toBe("local");
  });
});

describe("таксономия", () => {
  test("isTaskClass пропускает только intent:scope", () => {
    expect(isTaskClass("fix:module")).toBe(true);
    expect(isTaskClass("fix")).toBe(false);
    expect(isTaskClass("fix:everything")).toBe(false);
    expect(isTaskClass("рефакторинг:local")).toBe(false);
  });

  test("все намерения дают валидный класс", () => {
    for (const intent of INTENTS) {
      expect(isTaskClass(computeTaskClass({ title: "x", intent }).taskClass)).toBe(true);
    }
  });
});

describe("источники путей для scope (memory-1ax1pmk6mc3q)", () => {
  test("факт сильнее якорей, якоря сильнее текста, пустой источник пропускается", () => {
    expect(
      pickScopePaths({ touched: ["a/x.ts"], anchors: ["b/y.ts"], text: ["c/z.ts"] }),
    ).toEqual({ paths: ["a/x.ts"], source: "touched" });
    expect(pickScopePaths({ touched: [], anchors: ["b/y.ts"], text: ["c/z.ts"] })).toEqual({
      paths: ["b/y.ts"],
      source: "anchors",
    });
    expect(pickScopePaths({ touched: null, anchors: [], text: ["c/z.ts"] })).toEqual({
      paths: ["c/z.ts"],
      source: "text",
    });
    expect(pickScopePaths({})).toEqual({ paths: [], source: "none" });
  });

  test("без путей ни в одном источнике — unknown и источник none, а не тихий local", () => {
    const r = classifyTask({ title: "Исправить", sources: { touched: [], anchors: [], text: [] } });
    expect(r.taskClass).toBe("fix:unknown");
    expect(r.scopeSource).toBe("none");
  });

  test("факт решает и scope, и намерение по путям, когда заголовок молчит", () => {
    const r = classifyTask({
      title: "Ыыы",
      sources: { touched: ["packages/a/src/x.test.ts", "packages/a/src/y.test.ts"] },
    });
    expect(r).toMatchObject({ taskClass: "test:module", scopeSource: "touched" });
  });

  test("пути в тексте: с каталогом и расширением; имя, дробь, адрес и абсолютный путь — не пути", () => {
    expect(
      pathsInText(
        "см. packages/cli/src/commands/attempt.ts:509 и `packages/swarm/src/taskclass.ts`, " +
          "а ещё anchor.ts, 1.00/0.99/0.94, https://x.dev/a/b.md, /abs/c.ts, ~/d/e.ts, ../f/g.ts, " +
          "packages/swarm/src/**, @myc/core, bun:sqlite и (.github/workflows/ci.yml).",
      ),
    ).toEqual([
      ".github/workflows/ci.yml",
      "packages/cli/src/commands/attempt.ts",
      "packages/swarm/src/taskclass.ts",
    ]);
  });
});
