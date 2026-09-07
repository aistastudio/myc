import { describe, expect, test } from "bun:test";
import { computeScope, computeTaskClass, INTENTS, isTaskClass } from "./taskclass.ts";

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
