/**
 * ЧАСТЬ ИНДЕКСА КОРНЯ КАК СВОЙ ИНДЕКС (memory-m0md9fybwrdh, `view.ts`).
 *
 * Индекс построен из корня дерева с двумя «репозиториями» — `a/` и соседом
 * `a-b/`, чьё имя начинается так же (граница отрезка путей), плюс `b/` и файл
 * корня. Каждый читатель спрашивается видом `{repoId: '', prefix: 'a/'}` и
 * обязан: (1) отдать только файлы под `a/`, без `a-b/`; (2) отдать пути БЕЗ
 * префикса; (3) не менять ответа на прежний вызов строкой.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex, scanCodeIndex, drainCodeIndex } from "./code_index.ts";
import { grepCode, resolveGrepScope } from "./grep.ts";
import { repoMap } from "./map.ts";
import { recountFanIn } from "./fanin.ts";
import { callGraph, fileDefs, fileSkeleton, indexScope, refsTo, storedFanIn, symbolDefs } from "./read.ts";
import { buildSearchUnits, searchCode, SQL_STAGE_IN } from "./search.ts";
import { type CodeView, prefixEnd, refsCacheKey, stripPrefix, withPrefix } from "./view.ts";

const A_CORE = `export function shared(x: number): number {
  return x + 1;
}

export function onlyInA(): number {
  return shared(1);
}
`;

const A_USE = `import { shared } from "./core.ts";

export function useA(): number {
  return shared(2) + shared(3);
}
`;

// Сосед с общим началом имени. '-' (0x2D) меньше '/' (0x2F), поэтому `a-b/…`
// лежит ДО `a/…` и в отрезок [a/, a0) не попадает — это проверяется ниже, а
// не принимается на веру.
const AB = `export function shared(): string {
  return "a-b";
}
`;

const B = `export function shared(): boolean {
  return true;
}

export function callsB(): boolean {
  return shared();
}
`;

const TOP = `export function topLevel(): number {
  return 0;
}
`;

const A: CodeView = { repoId: "", prefix: "a/" };

let work: string;
let tree: string;
let db: Database;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "code-view-"));
  tree = join(work, "tree");
  for (const d of ["a/src", "a-b/src", "b/src"]) mkdirSync(join(tree, d), { recursive: true });
  writeFileSync(join(tree, "a", "src", "core.ts"), A_CORE);
  writeFileSync(join(tree, "a", "src", "use.ts"), A_USE);
  writeFileSync(join(tree, "a-b", "src", "ab.ts"), AB);
  writeFileSync(join(tree, "b", "src", "b.ts"), B);
  writeFileSync(join(tree, "top.ts"), TOP);
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  await runCodeIndex(db, { repoId: "", root: tree });
  buildSearchUnits(db, "", tree);
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

describe("отрезок путей", () => {
  test("prefixEnd — следующий байт за слэшем; strip/with — взаимно обратны", () => {
    expect(prefixEnd("a/")).toBe("a0");
    expect(prefixEnd("messaging-server/")).toBe("messaging-server0");
    expect(stripPrefix(A, "a/src/core.ts")).toBe("src/core.ts");
    expect(withPrefix(A, "src/core.ts")).toBe("a/src/core.ts");
    expect(stripPrefix({ repoId: "", prefix: "" }, "a/x.ts")).toBe("a/x.ts");
    expect(refsCacheKey({ repoId: "", prefix: "" })).toBe("");
    expect(refsCacheKey(A)).not.toBe("");
    expect(refsCacheKey(A)).not.toBe("a");
  });
});

describe("читатели под видом: только a/, пути без префикса, сосед a-b/ не виден", () => {
  test("symbolDefs и fileDefs", () => {
    expect(symbolDefs(db, A, "shared").map((d) => d.path)).toEqual(["src/core.ts"]);
    // Прежний вызов строкой — весь индекс, пути с префиксом.
    expect(symbolDefs(db, "", "shared").map((d) => d.path)).toEqual([
      "a-b/src/ab.ts",
      "a/src/core.ts",
      "b/src/b.ts",
    ]);
    expect(fileDefs(db, A, "src/core.ts").map((d) => d.name)).toEqual(["shared", "onlyInA"]);
    expect(fileDefs(db, A, "src/ab.ts")).toEqual([]);
  });

  test("indexScope считает только часть", () => {
    expect(indexScope(db, A).files).toBe(2);
    expect(indexScope(db, A).defs).toBe(3);
    expect(indexScope(db, "").files).toBe(5);
  });

  test("refsTo и callGraph — вхождения только из a/", () => {
    const refs = refsTo(db, A, "shared");
    expect(new Set(refs.map((r) => r.path))).toEqual(new Set(["src/core.ts", "src/use.ts"]));
    const g = callGraph(db, A, "shared", { depth: 2 });
    expect(g.edges.every((e) => !e.path.includes("/src/") || e.path.startsWith("src/"))).toBe(true);
    expect(g.edges.map((e) => e.caller)).toContain("useA");
    expect(g.edges.map((e) => e.caller)).not.toContain("callsB");
    const out = callGraph(db, A, "onlyInA", { direction: "out", depth: 2 });
    expect(out.edges.map((e) => e.callee)).toContain("shared");
  });

  test("grepCode: перечень и владельцы из части, файлы — из корня репозитория", () => {
    const r = grepCode(db, A, join(tree, "a"), "shared");
    expect([...new Set(r.groups.map((g) => g.path))].sort()).toEqual(["src/core.ts", "src/use.ts"]);
    expect(r.missing).toBe(0);
    expect(r.groups.find((g) => g.path === "src/use.ts" && g.symbol === "useA")).toBeDefined();
    const scope = resolveGrepScope(db, A, join(tree, "a"), ["src/use.ts"]);
    expect(scope.ok).toBe(true);
    const whole = grepCode(db, "", tree, "shared");
    expect(whole.files).toBe(4);
  });

  test("grepCode: файл, которого нет под корнем, читается из запасного корня и считается", () => {
    const wt = join(work, "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "core.ts"), `// ветка\n${A_CORE}`);
    // use.ts на «ветке» нет — он придёт из основной копии.
    const r = grepCode(db, A, wt, "shared", { fallbackRoot: join(tree, "a") });
    expect(r.fallback).toBe(1);
    expect(r.missing).toBe(0);
    const core = r.groups.filter((g) => g.path === "src/core.ts").flatMap((g) => g.hits);
    expect(core[0]!.line).toBe(2); // строка ветки, а не основной копии
  });

  test("searchCode и repoMap — только часть", () => {
    const s = searchCode(db, A, "shared");
    expect(s.hits.length).toBeGreaterThan(0);
    expect(s.hits.every((h) => h.path.startsWith("src/"))).toBe(true);
    expect(s.hits.map((h) => h.path)).not.toContain("src/ab.ts");
    expect(s.searched.files).toBe(2);
    const m = repoMap(db, A, { depth: 1 });
    expect(m.files).toBe(2);
    expect(m.clusters.map((c) => c.dir)).toEqual(["src"]);
  });

  test("fileSkeleton по пути части и запасной корень", () => {
    const sk = fileSkeleton(db, A, "src/core.ts", join(tree, "a"));
    expect(sk.stale).toBe(false);
    expect(sk.entries.map((e) => e.name)).toEqual(["shared", "onlyInA"]);
    const gone = fileSkeleton(db, A, "src/core.ts", join(work, "nowhere"), join(tree, "a"));
    expect(gone.onDisk).toBe(true);
  });
});

describe("план запроса части — тот же, что у корня", () => {
  test("ступень поиска под префиксом начинается с FTS, а не с единиц репозитория", () => {
    // Мутация: снять `+` у `u.path` — SQLite пойдёт от ix_code_units_file и
    // проверит MATCH на каждой строке (замер: 188 мс против 1.5 мс).
    const plan = (
      db.query(`EXPLAIN QUERY PLAN ${SQL_STAGE_IN}`).all('"shared"', "", 80, "a/", "a0") as Array<{ detail: string }>
    ).map((r) => r.detail);
    expect(plan[0]).toContain("VIRTUAL TABLE");
    expect(plan.join(" | ")).not.toContain("ix_code_units_file");
  });
});

describe("fan_in: у части свой ключ, и индексатор снимает его вместе с ключом корня", () => {
  test("число части не перетирает число корня, снимается переиндексацией и пишется снова", async () => {
    recountFanIn(db, { repoId: "", root: tree, parts: ["a"] });
    const part = storedFanIn(db, A, "shared")!;
    const whole = storedFanIn(db, "", "shared")!;
    expect(part.files).toBe(2);
    expect(whole.files).toBe(3); // a/core, a/use, b/b (a-b/ab.ts — только объявление)
    // a/core: вызов в onlyInA; a/use: import и два вызова. Сосед `a-b/` с
    // общим началом имени в число части не попал, b/ — тоже.
    expect(part.n).toBe(4);
    expect(whole.n).toBe(5);

    writeFileSync(join(tree, "b", "src", "b.ts"), `${B}\nexport const again = shared();\n`);
    await runCodeIndex(db, { repoId: "", root: tree });
    expect(storedFanIn(db, A, "shared")).toBeNull();
    expect(storedFanIn(db, "", "shared")).toBeNull();
    recountFanIn(db, { repoId: "", root: tree, parts: ["a"] });
    expect(storedFanIn(db, A, "shared")!.n).toBe(part.n);
    expect(storedFanIn(db, "", "shared")!.n).toBe(whole.n + 1);
  });
});

describe("скан ЧАСТИ индекса (`subtree`)", () => {
  test("исчезнувшее удаляется только под префиксом части; новое пишется ключом корня", async () => {
    rmSync(join(tree, "a", "src", "use.ts"));
    rmSync(join(tree, "b", "src", "b.ts"));
    writeFileSync(join(tree, "a", "src", "fresh.ts"), "export function freshInA(): number {\n  return 7;\n}\n");
    const scan = await scanCodeIndex(db, { repoId: "", root: tree, subtree: "a" });
    expect(scan.removed).toBe(1); // a/src/use.ts — и НЕ b/src/b.ts
    expect(scan.files).toBe(2); // a/src/core.ts, a/src/fresh.ts
    await drainCodeIndex(db, { repoId: "", root: tree });
    const paths = (db.query("SELECT path FROM code_files WHERE repo_id = '' ORDER BY path").all() as Array<{
      path: string;
    }>).map((r) => r.path);
    expect(paths).toEqual(["a-b/src/ab.ts", "a/src/core.ts", "a/src/fresh.ts", "b/src/b.ts", "top.ts"]);
    expect(symbolDefs(db, "", "freshInA").map((d) => d.path)).toEqual(["a/src/fresh.ts"]);
    expect((db.query("SELECT count(*) AS n FROM code_files WHERE repo_id <> ''").get() as { n: number }).n).toBe(0);
    // Полный скан корня потом снимает и b.
    const full = await scanCodeIndex(db, { repoId: "", root: tree });
    expect(full.removed).toBe(1);
  });

  test("часть корпуса поиска перестраивается, остальной корпус не трогается", async () => {
    writeFileSync(join(tree, "a", "src", "core.ts"), `${A_CORE}\nexport function addedLater(): void {}\n`);
    await runCodeIndex(db, { repoId: "", root: tree, subtree: "a" });
    const r = buildSearchUnits(db, "", tree, "a/");
    expect(r.rebuilt).toBe(1);
    expect(r.removed).toBe(0);
    expect(searchCode(db, "", "added later").hits[0]?.path).toBe("a/src/core.ts");
    expect(searchCode(db, "", "calls b").hits.map((h) => h.path)).toContain("b/src/b.ts");
  });
});
