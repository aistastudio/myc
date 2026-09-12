/**
 * Приёмка ЧИТАТЕЛЯ индекса (memory-m30yh8swnm1d, часть 2).
 *
 * Индекс, который никто не читает, — мёртвый вес: до этой задачи
 * `code_files/code_defs/code_refs` не спрашивала ни одна строка кода, кроме
 * тестов самого индексатора. Здесь проверяется ровно то, ради чего таблицы
 * заполняются: символ → спан, спан → символ (для якорей) и fan_in со счётом
 * по требованию и кешем.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { recountFanIn } from "./fanin.ts";
import { defsInSpan, fileDefs, indexScope, SQL_FAN_IN, SQL_REFS_TO, storedFanIn, symbolDefs } from "./read.ts";

const A = `export function alpha(): number {
  return 1;
}

export function beta(): number {
  return alpha() + alpha();
}
`;

const B = `import { alpha } from "./a.ts";

export class Gamma {
  run(): number {
    return alpha();
  }
}
`;

let work: string;
let dir: string;
let db: Database;

beforeEach(async () => {
  // Дерево и база — РАЗНЫЕ каталоги: база внутри дерева попала бы в реестр
  // файлов сама (в продукте она лежит в `.myc/`, а он в SKIP_DIRS).
  work = mkdtempSync(join(tmpdir(), "code-read-"));
  dir = join(work, "tree");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), A);
  writeFileSync(join(dir, "src", "b.ts"), B);
  writeFileSync(join(dir, "README.md"), "alpha alpha alpha\n");
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  await runCodeIndex(db, { repoId: "r", root: dir });
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

describe("символ → спан", () => {
  test("symbolDefs находит определение по имени", () => {
    const hits = symbolDefs(db, "r", "alpha");
    expect(hits.length).toBe(1);
    expect(hits[0]!.path).toBe("src/a.ts");
    expect(hits[0]!.kind).toBe("function");
    expect(hits[0]!.spanStart).toBe(1);
    expect(hits[0]!.lang).toBe("ts");
  });

  test("чужой репозиторий не отвечает за наш: repo_id участвует в запросе", () => {
    expect(symbolDefs(db, "other-repo", "alpha")).toEqual([]);
  });

  test("несуществующее имя — пусто, а не выдумка", () => {
    expect(symbolDefs(db, "r", "не-символ")).toEqual([]);
  });

  test("fileDefs отдаёт скелет файла в порядке спанов", () => {
    const names = fileDefs(db, "r", "src/a.ts").map((d) => d.name);
    expect(names).toEqual(["alpha", "beta"]);
  });
});

describe("спан → символ: то, чем якорь становится именем", () => {
  test("пересечение, а не вложение: якорь на одну строку тела находит функцию", () => {
    const hit = defsInSpan(db, "r", "src/a.ts", 2, 2);
    expect(hit.map((d) => d.name)).toEqual(["alpha"]);
  });

  test("широкий якорь захватывает все определения участка", () => {
    expect(defsInSpan(db, "r", "src/a.ts", 1, 100).map((d) => d.name)).toEqual(["alpha", "beta"]);
  });

  test("участок вне определений — пусто", () => {
    expect(defsInSpan(db, "r", "src/a.ts", 4, 4)).toEqual([]);
  });
});

describe("охват индекса (§6.3: пустая выдача с причиной)", () => {
  test("indexScope считает файлы, символы и языки", () => {
    const s = indexScope(db, "r");
    expect(s.files).toBe(3);
    expect(s.l1Files).toBe(2);
    expect(s.defs).toBeGreaterThanOrEqual(3);
    expect(s.langs.find((l) => l.lang === "ts")?.files).toBe(2);
    expect(s.langs.find((l) => l.lang === "md")?.files).toBe(1);
    expect(s.indexedAt).toBeGreaterThan(0);
  });

  test("пустой репозиторий виден как пустой, а не как «символа нет»", () => {
    expect(indexScope(db, "empty").files).toBe(0);
  });
});

describe("fan_in: читатель берёт число, которое положил прогон индекса (S9)", () => {
  test("до пересчёта — null (не ноль и не подсчёт), после — число с источником", () => {
    expect(storedFanIn(db, "r", "alpha")).toBeNull();
    recountFanIn(db, { repoId: "r", root: dir });
    // a.ts: строка определения не считается, два вызова в beta;
    // b.ts: import + вызов; README.md — L0, в счёт не идёт.
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 4, files: 2, source: "text" });
  });

  test("индексатор снимает число: после правки файла его нет до следующего пересчёта", async () => {
    recountFanIn(db, { repoId: "r", root: dir });
    writeFileSync(join(dir, "src", "b.ts"), `${B}\nexport const extra = alpha();\n`);
    await runCodeIndex(db, { repoId: "r", root: dir, now: Date.now() + 1000 });
    expect(storedFanIn(db, "r", "alpha")).toBeNull();
    recountFanIn(db, { repoId: "r", root: dir });
    expect(storedFanIn(db, "r", "alpha")!.n).toBe(5);
  });

  test("чтение — поиск по первичному ключу, без скана", async () => {
    const plan = (db.query(`EXPLAIN QUERY PLAN ${SQL_FAN_IN}`).all("r", "alpha") as Array<{ detail: string }>).map(
      (r) => r.detail,
    );
    expect(plan.join(" | ")).toContain("USING PRIMARY KEY");
    expect(plan.join(" | ")).not.toMatch(/SCAN code_refs/);
  });
});

/**
 * План запроса — предмет проверки, а не следствие удачи.
 *
 * `ix_code_ref_sites_name` существовал и раньше, но SQLite шёл сканом по
 * `repo_id`: 7.5 мс на запрос вместо 0.03, и `--depth all` — 13.4 с вместо
 * 62 мс. Лечится это `INDEXED BY`, но лечение держалось ни на чём: снятие
 * подсказки не роняло ни одного теста, и возврат к тринадцати секундам
 * произошёл бы молча.
 *
 * Проверяется ПЛАН, а не время: время меряет машину, план — код. Образец
 * рядом — `packages/cli/src/commands/ready.repo-latency.test.ts`, где так же
 * пришпилен `ix_nodes_ready`.
 */
describe("план запроса ссылок", () => {
  test("поиск по имени идёт индексом, а не сканом таблицы", async () => {
    const db = new Database(":memory:");
    try {
      await migrate(db, { migrations, writable: true });
      const plan = db
        .query(`EXPLAIN QUERY PLAN ${SQL_REFS_TO}`)
        .all("repo", "name") as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(" | ");
      expect(detail).toContain("ix_code_ref_sites_name");
      // И обратная сторона: скана таблицы в плане быть не должно вовсе.
      expect(detail).not.toMatch(/SCAN code_ref_sites(?! USING)/);
    } finally {
      db.close();
    }
  });
});
