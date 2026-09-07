/**
 * СТОРОЖ ОДНОГО ПРЕДИКАТА (§6.3).
 *
 * «Это актуальная версия» в SQL — `head_id IS NULL`. Условие жило копией в
 * каждом ретривальном запросе: hybrid ×4, fts, vector, reindex ×2, prime,
 * absorb ×2, scripts ×3. Пока копии врозь, `myc show --history` и MCP
 * `include_superseded` реализовать нечем: полная история в ядре есть, а
 * каждая поверхность жёстко фильтрует своей копией. Хуже того, расхождение
 * копий даёт РАЗНУЮ выдачу на разных поверхностях, и заметить это можно
 * только сравнив их руками.
 *
 * Урок S43 буквально тот же: список PRAGMA расползся по трём путям открытия
 * базы, комментарий утверждал паритет, которого не было, и это стоило
 * потерянных записей. Поэтому здесь стоит не комментарий, а механическая
 * проверка — по образцу «CREATE TABLE вне набора миграций не появляется»
 * (packages/store-sqlite/src/migrations/schema.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { historyClause } from "./graph.ts";

// …/packages/core/src → корень репозитория
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Комментарии срезаются: «head_id IS NULL» в прозе — объяснение, а не копия
 * предиката. СТРОКОВЫЕ И ШАБЛОННЫЕ ЛИТЕРАЛЫ НЕ СРЕЗАЮТСЯ — настоящий SQL
 * живёт именно в них, и вырезать их значило бы ослепить сторожа ровно на тот
 * случай, ради которого он стоит.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

/**
 * Обход исходников: packages/ и scripts/ — обе половины, потому что три
 * копии предиката жили именно в scripts/ и обход одних packages их бы не
 * увидел.
 *
 * `*.test.ts` пропускаются намеренно и это осознанная дыра: тест, который
 * проверяет, ЧТО возвращает historyClause, обязан написать строку буквально —
 * иначе он не проверяет ничего. Тот же компромисс и в сторо́же CREATE TABLE.
 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        walk(p);
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      out.push(p.slice(REPO_ROOT.length + 1));
    }
  };
  walk(join(REPO_ROOT, "packages"));
  walk(join(REPO_ROOT, "scripts"));
  return out.sort();
}

function filesMatching(re: RegExp, skipMigrations: boolean): string[] {
  const hits: string[] = [];
  for (const rel of sourceFiles()) {
    if (skipMigrations && rel.includes(`${sep}migrations${sep}`)) continue;
    if (re.test(stripComments(readFileSync(join(REPO_ROOT, rel), "utf8")))) hits.push(rel);
  }
  return hits;
}

describe("предикат актуальной версии живёт в одном месте", () => {
  /**
   * Законные места. Список ТОЧНЫЙ, а не «разрешено хотя бы это»: сторож
   * краснеет и на новой копии, и на протухшем исключении, которое давно
   * пора убрать.
   */
  const ALLOWED = [
    // Единственный дом предиката: historyClause.
    "packages/core/src/graph.ts",
    // ДОЛГ. Копия в дайджесте bootstrap — за границей этой задачи
    // (packages/cli/src/commands/bootstrap.ts правит другой агент), поэтому
    // она внесена явным исключением, а не молча пропущена. Как только её
    // переведут на historyClause, этот тест покраснеет и потребует убрать
    // строку отсюда.
    "packages/cli/src/commands/bootstrap.ts",
  ].sort();

  test("`head_id IS NULL` в исходниках — только в historyClause и в списке исключений", () => {
    expect(filesMatching(/head_id\s+IS\s+NULL/i, true)).toEqual(ALLOWED);
  });

  /**
   * Миграции считаются отдельно и НЕ являются копией.
   *
   * `head_id IS NULL` в 001-init.ts — не запрос, а часть определения
   * частичного индекса `ix_nodes_prime`. Это вторая, схемная половина того же
   * инварианта: SQLite использует частичный индекс, только если WHERE запроса
   * влечёт WHERE индекса, поэтому prime обязан спрашивать ровно то, что индекс
   * обещает. Миграции неизменяемы после выпуска (у набора контрольные суммы),
   * менять эту строку нельзя никак — но и «свести к historyClause» её нельзя:
   * функция вернула бы для full_history пустоту, а индекс — объект схемы, у
   * него режима чтения нет.
   *
   * Тест фиксирует и это: КАЖДОЕ вхождение в наборе миграций обязано быть
   * определением частичного индекса семейства ix_nodes_prime, и ничем иным.
   * Второе вхождение появилось в 006 (S58, охват памяти): фильтр охвата
   * обязан отсеивать до LIMIT, поэтому у него свой частичный индекс с ТЕМ ЖЕ
   * предикатом — иначе SQLite его не выберет. Список файлов зафиксирован
   * поимённо: новый файл с этой строкой краснит тест и требует объяснения.
   */
  test("в наборе миграций предикат — определение частичного индекса, и других нет", () => {
    const inMigrations = sourceFiles().filter((rel) =>
      rel.includes(`${sep}migrations${sep}`),
    );
    const hits = inMigrations.filter((rel) =>
      /head_id\s+IS\s+NULL/i.test(stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"))),
    );
    expect(hits).toEqual([
      "packages/store-sqlite/src/migrations/001-init.ts",
      "packages/store-sqlite/src/migrations/006-nodes-reach.ts",
    ]);

    for (const rel of hits) {
      const sql = readFileSync(join(REPO_ROOT, rel), "utf8");
      // Именно индекс, а не запрос: строка с предикатом принадлежит CREATE INDEX.
      const stmt = sql
        .split(";")
        .find((s) => /head_id\s+IS\s+NULL/i.test(stripComments(s)));
      expect(stmt).toMatch(/CREATE\s+INDEX\s+ix_nodes_prime/i);
    }

    // И запрос prime обязан спрашивать ровно то, что обещает индекс.
    expect(historyClause("follow", "nodes")).toBe(" AND nodes.head_id IS NULL");
  });

  /**
   * Вторая половина той же болезни: обход цепочки версий. `absorb` держал
   * собственный `chain_of` (`WHERE head_id = ?1`) — обрезанную копию запроса
   * `show`, которая не видела сам узел, — и собственный рекурсивный `headOf`,
   * выбиравший голову по указателю, а не детерминированным правилом
   * VersionGraph. Строки версий читает один запрос, и он в ядре.
   */
  test("строки цепочки версий читает один запрос", () => {
    expect(filesMatching(/head_id\s*=\s*\?/i, true)).toEqual(["packages/core/src/graph.ts"]);
  });
});
