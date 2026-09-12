/**
 * Приёмка ФОНОВОГО fan_in (memory-g79mpkt53yn3, решение S9): число считает
 * прогон индекса и кладёт в `code_refs`, читатель берёт готовое.
 *
 * Что здесь доказывается и какая мутация что красит:
 *
 *   «после индекса в таблице лежит число каждого определённого имени» —
 *     красит мутация «пересчёт не пишет» (убрать INSERT в `recountFanIn`);
 *   «чтение — ноль подсчётов» — корпус удалён с диска, число читается
 *     прежним: красит любая попытка читателя досчитать (он получил бы 0);
 *   «правка файла с упоминанием → новое число», в том числе упоминание ТОЛЬКО
 *     в комментарии — красит «пересчитывать лишь имена изменённых файлов по
 *     синтаксическим ссылкам» (комментарий там не виден);
 *   «умер между разбором и пересчётом → следующий прогон досчитывает» —
 *     красит флаг «изменилось» вместо снятых строк;
 *   «гонка с соседом → ничего не записано» — красит запись без метки;
 *   «совпадает с прежним счётом по регулярке» на реальном коде пакета —
 *     красит любое расхождение семантики (`\b`, строки определений, L0).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { FAN_IN_RECOUNT_MARK, missingFanIn, recountFanIn } from "./fanin.ts";
import { L1_LANGS } from "./langs.ts";
import { storedFanIn } from "./read.ts";
import { refsCacheKey } from "./view.ts";

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
  work = mkdtempSync(join(tmpdir(), "code-fanin-"));
  dir = join(work, "tree");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), A);
  writeFileSync(join(dir, "src", "b.ts"), B);
  writeFileSync(join(dir, "README.md"), "alpha alpha alpha\n");
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

/** Прогон индекса так, как его делает `indexPass`: скан, разбор, пересчёт. */
async function indexRun(now = Date.now()) {
  await runCodeIndex(db, { repoId: "r", root: dir, now });
  return recountFanIn(db, { repoId: "r", root: dir, now });
}

function rows(key = "r"): Array<{ name: string; n_files: number; n_hits: number }> {
  return db
    .query("SELECT name, n_files, n_hits FROM code_refs WHERE repo_id = ?1 ORDER BY name")
    .all(key) as Array<{ name: string; n_files: number; n_hits: number }>;
}

/** Правка файла с гарантированно другим mtime: две записи в одну мс при равном размере — «не менялся». */
function edit(rel: string, text: string, mtime: number): void {
  writeFileSync(join(dir, rel), text);
  utimesSync(join(dir, rel), new Date(mtime), new Date(mtime));
}

describe("прогон индекса кладёт число, читатель берёт готовое", () => {
  test("после индекса у каждого определённого имени строка с числом (ноль — тоже число)", async () => {
    const r = await indexRun();
    expect(r.ran).toBe(true);
    expect(r.reason).toBe("missing");
    const names = (db.query("SELECT DISTINCT name FROM code_defs WHERE repo_id = 'r' ORDER BY name").all() as Array<{
      name: string;
    }>).map((x) => x.name);
    expect(rows().map((x) => x.name)).toEqual(names);
    // a.ts: строка определения не в счёт, два вызова в beta; b.ts: import +
    // вызов; README.md — L0, в счёт не идёт. Ровно то, что считал прежний
    // счёт по требованию.
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 4, files: 2, source: "text" });
    // Никто не зовёт — строка есть, и в ней ноль: «не посчитано» и «ноль» различимы.
    expect(storedFanIn(db, "r", "Gamma")).toMatchObject({ n: 0, files: 0 });
    // Метка пересчёта не остаётся в таблице.
    expect(rows().some((x) => x.name === FAN_IN_RECOUNT_MARK)).toBe(false);
  });

  test("чтение — ноль подсчётов: корпус удалён с диска, число читается прежним", async () => {
    await indexRun();
    rmSync(join(dir, "src"), { recursive: true, force: true });
    // Читатель, который досчитывал бы сам, получил бы здесь 0 (файлов нет).
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 4, files: 2 });
  });

  test("числа нет — null, а не подсчёт: снятые строки читатель не заполняет", async () => {
    await indexRun();
    db.query("DELETE FROM code_refs WHERE repo_id = 'r'").run();
    expect(storedFanIn(db, "r", "alpha")).toBeNull();
    expect(rows()).toEqual([]);
  });

  test("индекс не менялся — второй прогон корпус не читает", async () => {
    await indexRun();
    const again = await indexRun();
    expect(again).toMatchObject({ ran: false, reason: "complete", files: 0, missing: 0 });
  });
});

describe("изменение файла → фоновый пересчёт даёт новое число", () => {
  test("новый вызов в другом файле: разбор снимает строки, пересчёт пишет новое", async () => {
    await indexRun(1_000_000);
    edit("src/b.ts", `${B}\nexport const extra = alpha();\n`, 9_000_000);
    await runCodeIndex(db, { repoId: "r", root: dir });
    // Между разбором и пересчётом числа нет — честное «ещё не посчитано».
    expect(storedFanIn(db, "r", "alpha")).toBeNull();
    const r = recountFanIn(db, { repoId: "r", root: dir });
    expect(r.ran).toBe(true);
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 5, files: 2 });
  });

  test("упоминание ТОЛЬКО в комментарии ушло — число падает (синтаксические ссылки его не видели)", async () => {
    writeFileSync(join(dir, "src", "c.ts"), "// alpha: см. a.ts, alpha считается дважды\nexport const c = 1;\n");
    await indexRun(1_000_000);
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 6, files: 3 });
    // В `code_ref_sites` у c.ts нет ни одного вхождения alpha: пересчёт «по
    // именам изменённых файлов» его бы не тронул.
    expect(
      (db.query("SELECT count(*) AS n FROM code_ref_sites WHERE repo_id = 'r' AND path = 'src/c.ts' AND name = 'alpha'").get() as {
        n: number;
      }).n,
    ).toBe(0);
    edit("src/c.ts", "// см. a.ts\nexport const c = 1;\n", 9_000_000);
    await indexRun();
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 4, files: 2 });
  });

  test("файл удалён — скан снимает строки, пересчёт пишет без него", async () => {
    await indexRun();
    rmSync(join(dir, "src", "b.ts"));
    await indexRun();
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 2, files: 1 });
    // Имени больше нет среди определений — нет и строки.
    expect(storedFanIn(db, "r", "Gamma")).toBeNull();
  });

  test("процесс умер между разбором и пересчётом — следующий прогон досчитывает по НЕИЗМЕНЁННОМУ дереву", async () => {
    await indexRun(1_000_000);
    edit("src/b.ts", `${B}\nexport const extra = alpha();\n`, 9_000_000);
    await runCodeIndex(db, { repoId: "r", root: dir }); // разбор записан, пересчёта не было
    const scan = await runCodeIndex(db, { repoId: "r", root: dir });
    expect(scan.drain.parsed).toBe(0); // дерево не менялось
    const r = recountFanIn(db, { repoId: "r", root: dir });
    expect(r).toMatchObject({ ran: true, reason: "missing" });
    expect(r.missing).toBeGreaterThan(0);
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 5 });
  });

  test("гонка: сосед переразобрал файл, пока считали, — не записано ничего, досчитывает следующий", async () => {
    await indexRun(1_000_000);
    edit("src/b.ts", `${B}\nexport const extra = alpha();\n`, 9_000_000);
    await runCodeIndex(db, { repoId: "r", root: dir });
    const raced = recountFanIn(db, {
      repoId: "r",
      root: dir,
      beforeWrite: () => {
        // Между чтением корпуса и записью: файл правят, и транзакция разбора
        // СОСЕДА фиксируется — а она снимает все строки индекса
        // (`invalidateRefs`), метку этого пересчёта тоже. Сам разбор соседа
        // дойдёт до базы ниже; здесь — ровно его след в `code_refs`.
        edit("src/b.ts", `${B}\nexport const extra = alpha() + alpha();\n`, 12_000_000);
        db.query("DELETE FROM code_refs WHERE repo_id = 'r'").run();
      },
    });
    expect(raced).toMatchObject({ ran: false, reason: "raced" });
    // Число по СТАРОМУ тексту (5) не легло поверх индекса, который уже новый.
    expect(storedFanIn(db, "r", "alpha")).toBeNull();
    await runCodeIndex(db, { repoId: "r", root: dir }); // разбор соседа
    recountFanIn(db, { repoId: "r", root: dir });
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 6 });
  });

  test("два пересчёта разом: пишет тот, чья метка последняя, второй уходит без записи", async () => {
    await runCodeIndex(db, { repoId: "r", root: dir });
    const first = recountFanIn(db, {
      repoId: "r",
      root: dir,
      beforeWrite: () => {
        // Сосед поставил свою метку поверх этой и досчитал первым.
        expect(recountFanIn(db, { repoId: "r", root: dir, force: true }).ran).toBe(true);
      },
    });
    expect(first).toMatchObject({ ran: false, reason: "raced" });
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 4, files: 2 });
  });
});

describe("части индекса: у вложенного репозитория своё число", () => {
  test("каталог с .git — ключ части пишется сам; число части не перетирает число корня", async () => {
    mkdirSync(join(dir, "svc", "src"), { recursive: true });
    mkdirSync(join(dir, "svc", ".git"));
    writeFileSync(join(dir, "svc", "src", "use.ts"), `import { alpha } from "../../src/a.ts";\nexport const u = alpha();\nexport function svcOnly(): number {\n  return alpha();\n}\n`);
    await indexRun();
    const part = { repoId: "r", prefix: "svc/" };
    expect(storedFanIn(db, part, "svcOnly")).toMatchObject({ n: 0, files: 0 });
    // alpha определена не в части — у части её строки нет (code symbol из
    // svc/ её и не найдёт: определений под префиксом нет).
    expect(storedFanIn(db, part, "alpha")).toBeNull();
    expect(storedFanIn(db, "r", "alpha")).toMatchObject({ n: 7, files: 3 });
    // `const u` — не определение для индекса (L1 пишет функции, классы, методы).
    expect(rows(refsCacheKey(part)).map((x) => x.name)).toEqual(["svcOnly"]);
    expect(missingFanIn(db, "r", ["svc/"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Семантика числа: та же, что у прежнего счёта по требованию
// ---------------------------------------------------------------------------

/**
 * ПРЕЖНИЙ СЧЁТ ДОСЛОВНО (read.ts до memory-g79mpkt53yn3): регулярка
 * `\bNAME\b` по строкам каждого L1-файла, строки определений этого имени
 * пропускаются целиком. Здесь он — оракул: пересчёт обязан совпасть с ним на
 * каждом имени.
 */
function oracle(name: string): { n: number; files: number } {
  const defLines = new Map<string, Set<number>>();
  for (const d of db.query("SELECT path, span_start FROM code_defs WHERE repo_id = 'r' AND name = ?1").all(name) as Array<{
    path: string;
    span_start: number;
  }>) {
    const s = defLines.get(d.path) ?? new Set<number>();
    s.add(d.span_start);
    defLines.set(d.path, s);
  }
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  let n = 0;
  let files = 0;
  for (const p of db.query("SELECT path, lang FROM code_files WHERE repo_id = 'r'").all() as Array<{ path: string; lang: string }>) {
    if (!L1_LANGS.has(p.lang)) continue;
    const text = readFileSync(join(dir, p.path), "utf8");
    if (!text.includes(name)) continue;
    const skip = defLines.get(p.path);
    let inFile = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (skip?.has(i + 1) === true) continue;
      word.lastIndex = 0;
      inFile += (lines[i]!.match(word) ?? []).length;
    }
    if (inFile > 0) {
      n += inFile;
      files++;
    }
  }
  return { n, files };
}

describe("семантика: совпадает с прежним счётом по регулярке", () => {
  test("на реальном коде этого пакета — каждое имя, число и файлы", async () => {
    // Реальный код: исходники @myc/code-intel как есть (комментарии на двух
    // языках, регулярки, строки, одноимённые методы в разных классах).
    mkdirSync(join(dir, "pkg"), { recursive: true });
    for (const f of readdirSync(import.meta.dir)) {
      if (f.endsWith(".ts") && !f.endsWith(".test.ts")) copyFileSync(join(import.meta.dir, f), join(dir, "pkg", f));
    }
    // Имена вне `[A-Za-z0-9_]` идут прежней регуляркой — и они обязаны совпасть.
    writeFileSync(
      join(dir, "pkg", "odd.ts"),
      [
        "export function $run(): number {",
        "  return 1;",
        "}",
        "export function a$run(): number {",
        "  return $run() + a$run.length + $run();",
        "}",
        "export class K {",
        "  #secret(): number {",
        "    return this.#secret() + $run();",
        "  }",
        "}",
        "export function привет(): number {",
        "  return привет.length + $run();",
        "}",
        "",
      ].join("\n"),
    );
    const r = await indexRun();
    expect(r.ran).toBe(true);
    const names = (db.query("SELECT DISTINCT name FROM code_defs WHERE repo_id = 'r'").all() as Array<{ name: string }>).map(
      (x) => x.name,
    );
    expect(names.length).toBeGreaterThan(300);
    for (const odd of ["$run", "a$run", "#secret", "привет"]) expect(names).toContain(odd);
    const diff: string[] = [];
    for (const name of names) {
      const got = storedFanIn(db, "r", name)!;
      const want = oracle(name);
      if (got.n !== want.n || got.files !== want.files) diff.push(`${name}: ${got.n}/${got.files} vs ${want.n}/${want.files}`);
    }
    expect(diff).toEqual([]);
  });
});
