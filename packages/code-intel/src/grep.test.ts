/**
 * Приёмка ИСЧЕРПЫВАЮЩЕГО поиска литерала (memory-5nvk1hwcene2).
 *
 * Главное свойство здесь — «ни одного вхождения не потеряно», и проверяется
 * оно тем, что найти обязано БОЛЬШЕ, чем знает индекс: строковую константу,
 * markdown и слово внутри комментария. Если бы `grep` читал `code_ref_sites`
 * вместо файлов, эти три случая молча исчезли бы — и выдача выглядела бы
 * полной.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { BINARY_PROBE_BYTES, type GrepScope, grepCode, looksBinary, resolveGrepScope } from "./grep.ts";

const A = `// needle в комментарии верхнего уровня
export function alpha(): string {
  const s = "needle внутри строковой константы";
  return s + "needle";
}

export function beta(): number {
  return 1;
}
`;

const B = `export class Gamma {
  run(): string {
    return "NEEDLE в верхнем регистре";
  }
}
`;

const MD = "# Заметка\n\nneedle упомянут в markdown, который парсер не разбирает.\n";

let work: string;
let dir: string;
let db: Database;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "code-grep-"));
  dir = join(work, "tree");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), A);
  writeFileSync(join(dir, "src", "b.ts"), B);
  writeFileSync(join(dir, "NOTES.md"), MD);
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  await runCodeIndex(db, { repoId: "r", root: dir });
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

test("находит ВСЕ вхождения, включая те, которых нет в индексе символов", () => {
  const r = grepCode(db, "r", dir, "needle");
  // 1 комментарий + 2 в строковых константах (одна строка с двумя — считается
  // по вхождениям) + 1 в markdown. Регистр по умолчанию учитывается, поэтому
  // NEEDLE из b.ts сюда не входит.
  expect(r.hits).toBe(4);
  expect(r.files).toBe(2);
  expect(r.searched).toBe(3);
  const paths = r.groups.map((g) => g.path).sort();
  expect(paths).toEqual(["NOTES.md", "src/a.ts", "src/a.ts"]);
});

test("вхождение относится к охватывающему символу, а не просто к файлу", () => {
  const r = grepCode(db, "r", dir, "needle");
  const inAlpha = r.groups.find((g) => g.symbol === "alpha");
  expect(inAlpha).toBeDefined();
  expect(inAlpha!.kind).toBe("function");
  expect(inAlpha!.hits.map((h) => h.line)).toEqual([3, 4]);
  // Комментарий верхнего уровня не принадлежит ни одному определению, и
  // приписывать его соседней функции нельзя.
  const top = r.groups.find((g) => g.path === "src/a.ts" && g.symbol === "");
  expect(top).toBeDefined();
  expect(top!.hits.map((h) => h.line)).toEqual([1]);
});

test("две одинаковых подстроки в одной строке считаются обе", () => {
  const r = grepCode(db, "r", dir, "needle");
  const line4 = r.groups.flatMap((g) => g.hits).find((h) => h.line === 4);
  expect(line4?.count).toBe(1);
  const line3 = r.groups.flatMap((g) => g.hits).find((h) => h.line === 3);
  expect(line3?.count).toBe(1);
  const two = grepCode(db, "r", dir, "e");
  expect(two.hits).toBeGreaterThan(two.groups.flatMap((g) => g.hits).length);
});

test("--ignore-case добавляет ровно верхний регистр, и это видно числом", () => {
  const strict = grepCode(db, "r", dir, "needle");
  const loose = grepCode(db, "r", dir, "needle", { ignoreCase: true });
  expect(loose.hits).toBe(strict.hits + 1);
  expect(loose.groups.some((g) => g.path === "src/b.ts" && g.symbol === "run")).toBe(true);
});

test("--lang сужает просмотр, и объём просмотра называется", () => {
  const all = grepCode(db, "r", dir, "needle");
  const tsOnly = grepCode(db, "r", dir, "needle", { langs: ["ts"] });
  expect(tsOnly.searched).toBe(2);
  expect(all.searched).toBe(3);
  expect(tsOnly.groups.some((g) => g.path === "NOTES.md")).toBe(false);
});

test("файл сверх потолка размера ПРОПУСКАЕТСЯ ПОИМЁННО, а не молча", () => {
  const r = grepCode(db, "r", dir, "needle", { maxFileBytes: 10 });
  expect(r.hits).toBe(0);
  expect(r.skipped.length).toBe(3);
  expect(r.skipped.map((s) => s.path).sort()).toEqual(["NOTES.md", "src/a.ts", "src/b.ts"]);
});

test("файл исчез с диска — он посчитан как отставший индекс, а не как ноль вхождений", () => {
  rmSync(join(dir, "src", "a.ts"));
  const r = grepCode(db, "r", dir, "needle");
  expect(r.missing).toBe(1);
  expect(r.searched).toBe(2);
  expect(r.hits).toBe(1);
});

test("литерала нет — ноль вхождений и просмотр названный", () => {
  const r = grepCode(db, "r", dir, "квазистеллар");
  expect(r.hits).toBe(0);
  expect(r.groups).toEqual([]);
  expect(r.searched).toBe(3);
});

test("потолок групп режет ВЫДАЧУ, но не счёт: обрыв виден", () => {
  const r = grepCode(db, "r", dir, "needle", { limit: 1 });
  expect(r.truncated).toBe(true);
  expect(r.groups.length).toBe(1);
  expect(r.hits).toBe(4);
});

// ---------------------------------------------------------------------------
// Область `--in` и бинарные файлы (memory-3jkvs7g5hkdw)
// ---------------------------------------------------------------------------
//
//   МУТАЦИЯ G1 «область игнорируется» — убрать проверку `inScope` в цикле
//   grepCode: краснеет «каталог сужает просмотр», потому что в выдаче
//   появляется NOTES.md, а просмотр становится 3 вместо 2.
//
//   МУТАЦИЯ G3 «пропуск бинарных выключен» — `looksBinary` всегда false:
//   краснеет «бинарный файл пропущен по содержимому», мусорная строка из
//   файла с NUL оказывается в выдаче.
//
//   МУТАЦИЯ G5 «нет пути — пустой успех» — вернуть область вместо отказа,
//   когда stat упал: краснеет «отказы, а не пустота».

function scopeOf(inputs: readonly string[], cwd?: string): readonly GrepScope[] {
  const r = resolveGrepScope(db, "r", dir, inputs, cwd);
  if (!r.ok) throw new Error(`область не разобралась: ${r.code} ${r.msg}`);
  return r.scopes;
}

describe("область --in", () => {
  test("каталог сужает просмотр, и область НАЗВАНА в ответе", () => {
    const all = grepCode(db, "r", dir, "needle");
    const r = grepCode(db, "r", dir, "needle", { scopes: scopeOf(["src"]) });
    expect(all.scope).toBeNull();
    expect(r.scope).toEqual(["src/"]);
    expect(r.searched).toBe(2);
    expect(r.hits).toBe(3);
    expect(r.groups.length).toBeGreaterThan(0);
    expect(r.groups.every((g) => g.path.startsWith("src/"))).toBe(true);
    // Сужение наблюдаемо: без области markdown в выдаче есть, с ней — нет.
    expect(all.groups.some((g) => g.path === "NOTES.md")).toBe(true);
  });

  // Добавлено на приёмке: мутация «каталог-область сравнивается без слэша» в
  // inScope выживала — утечку в соседа с общим префиксом (src/api и
  // src/api-v2) не наблюдал ни один тест: форма поля path проверялась, а
  // поведение на соседе — нет.
  test("каталог не захватывает соседа с общим префиксом: src ≠ src2", async () => {
    mkdirSync(join(dir, "src2"), { recursive: true });
    writeFileSync(join(dir, "src2", "c.ts"), "needle\n");
    await runCodeIndex(db, { repoId: "r", root: dir });
    const r = grepCode(db, "r", dir, "needle", { scopes: scopeOf(["src"]) });
    expect(r.groups.filter((g) => !g.path.startsWith("src/")).map((g) => g.path)).toEqual([]);
    expect(r.searched).toBe(2);
    // Контроль: сосед проиндексирован и отвечает на свою область.
    const own = grepCode(db, "r", dir, "needle", { scopes: scopeOf(["src2"]) });
    expect(own.groups.map((g) => g.path)).toEqual(["src2/c.ts"]);
  });

  test("файл — тоже область; несколько областей — объединение, каждая названа", () => {
    const r = grepCode(db, "r", dir, "needle", {
      ignoreCase: true,
      scopes: scopeOf(["NOTES.md", "src/b.ts"]),
    });
    expect(r.scope).toEqual(["NOTES.md", "src/b.ts"]);
    expect(r.searched).toBe(2);
    expect([...new Set(r.groups.map((g) => g.path))].sort()).toEqual(["NOTES.md", "src/b.ts"]);
  });

  test("запись пути не меняет область: ./src/, src, абсолютный, обратные слэши, повтор", () => {
    for (const input of ["src", "./src/", "src/", join(dir, "src"), ".\\src", "src/../src"]) {
      expect({ input, scopes: scopeOf([input]) }).toEqual({
        input,
        scopes: [{ label: "src/", path: "src/", dir: true }],
      });
    }
    // Повтор одной области не удваивает просмотр.
    expect(scopeOf(["src", "./src/"]).length).toBe(1);
    // Корень — область «весь репозиторий», и она всё равно названа.
    const root = grepCode(db, "r", dir, "needle", { scopes: scopeOf(["."]) });
    expect(root.scope).toEqual(["."]);
    expect(root.hits).toBe(grepCode(db, "r", dir, "needle").hits);
  });

  test("путь есть, вхождений нет — обычный пустой ответ, область в нём названа", () => {
    const r = grepCode(db, "r", dir, "Gamma", { scopes: scopeOf(["src/a.ts"]) });
    expect({ hits: r.hits, searched: r.searched, scope: r.scope }).toEqual({
      hits: 0,
      searched: 1,
      scope: ["src/a.ts"],
    });
    // Литерал в репозитории есть — пустоту дала именно область.
    expect(grepCode(db, "r", dir, "Gamma").hits).toBe(1);
  });

  test("отказы, а не пустота: нет пути, за корнем, пустой, вне реестра", () => {
    const code = (inputs: readonly string[]): string => {
      const r = resolveGrepScope(db, "r", dir, inputs);
      return r.ok ? `ok ${r.scopes.map((s) => s.label).join(",")}` : r.code;
    };
    expect(code(["src/нет"])).toBe("notfound.path");
    expect(code(["src", "src/нет"])).toBe("notfound.path");
    expect(code(["../"])).toBe("usage.outside_repo");
    expect(code([work])).toBe("usage.outside_repo");
    expect(code(["src/../../tree/src"])).toBe("ok src/");
    expect(code([""])).toBe("usage.invalid");
    expect(code(["  ", ""])).toBe("usage.invalid");
    // На диске есть, в реестре нет: индекс в node_modules не заходит, а
    // файл, созданный после индексации, он ещё не видел. «0 вхождений»
    // значило бы «не искали».
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "i.ts"), "needle\n");
    writeFileSync(join(dir, "src", "late.ts"), "needle\n");
    expect(code(["node_modules"])).toBe("notfound.scope");
    expect(code(["src/late.ts"])).toBe("notfound.scope");
    // Отказ по пути называет введённое, а подсказка — базу пути.
    const r = resolveGrepScope(db, "r", dir, ["src/нет"]);
    expect(r.ok ? null : { msg: r.msg, hint: r.hint }).toEqual({
      msg: "--in src/нет: no such path in the repo",
      hint: "the path is relative to the repo root — the same as paths in grep output",
    });
  });

  test("путь от текущего каталога вместо корня — отказ подсказывает верный", () => {
    const r = resolveGrepScope(db, "r", dir, ["a.ts"], join(dir, "src"));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.hint).toContain("from the current directory that is --in src/a.ts");
  });
});

describe("бинарные файлы", () => {
  test("признак — NUL в окне git в 8000 байт, не дальше", () => {
    expect(BINARY_PROBE_BYTES).toBe(8000);
    const at = (i: number): Buffer => {
      const b = Buffer.alloc(9000, 0x61);
      b[i] = 0;
      return b;
    };
    expect(looksBinary(at(0))).toBe(true);
    expect(looksBinary(at(BINARY_PROBE_BYTES - 1))).toBe(true);
    expect(looksBinary(at(BINARY_PROBE_BYTES))).toBe(false);
    expect(looksBinary(Buffer.from("needle — не ASCII, но текст\n"))).toBe(false);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });

  test("бинарный файл пропущен по СОДЕРЖИМОМУ и назван числом, а не молча", async () => {
    // .md с NUL — бинарный; .darc с чистым текстом — нет: решает содержимое.
    const nul = Buffer.from([0, 1, 2, 0]);
    writeFileSync(
      join(dir, "src", "blob.md"),
      Buffer.concat([Buffer.from("STRT needle\n"), nul, Buffer.from("needle\n")]),
    );
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "plain.darc"), "needle в тексте с чужим расширением\n");
    // NUL дальше окна — файл текстовый, как у git.
    writeFileSync(
      join(dir, "src", "late.md"),
      Buffer.concat([Buffer.from("needle\n"), Buffer.alloc(BINARY_PROBE_BYTES, 0x78), nul]),
    );
    await runCodeIndex(db, { repoId: "r", root: dir });

    const r = grepCode(db, "r", dir, "needle");
    expect(r.binary).toBe(1);
    const paths = new Set(r.groups.map((g) => g.path));
    expect(paths.has("src/blob.md")).toBe(false);
    expect(paths.has("data/plain.darc")).toBe(true);
    expect(paths.has("src/late.md")).toBe(true);
    expect(grepCode(db, "r", dir, "STRT").hits).toBe(0);
    // Бинарный в просмотр не входит: каждый файл реестра учтён ровно раз.
    const registry = Number(
      (db.query("SELECT count(*) AS n FROM code_files WHERE repo_id = 'r'").get() as { n: number }).n,
    );
    expect(r.searched + r.binary + r.skipped.length + r.missing).toBe(registry);
    // Область сужает и счёт бинарных: вне области файл не «пропущен», его не спрашивали.
    expect(grepCode(db, "r", dir, "needle", { scopes: scopeOf(["data"]) }).binary).toBe(0);
    expect(grepCode(db, "r", dir, "needle", { scopes: scopeOf(["src"]) }).binary).toBe(1);
  });
});

// Добавлено memory-rda12hcf2dt1: на корне cherry обход дерева положил бы в
// реестр 2000 файлов testing/keys — и grep вывел бы агенту их содержимое.
// grep читает ТОЛЬКО реестр, а реестр git-репозитория — его `git ls-files`.
describe("игнорируемое git", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"]) saved[k] = process.env[k];
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.XDG_CONFIG_HOME = join(tmpdir(), "code-grep-no-xdg");
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function git(cwd: string, ...args: string[]): void {
    const r = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }

  test("литерал из игнорируемого файла не находится, а литерал кода — находится", async () => {
    const repo = join(work, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), "testing/keys/\n.data/\n");
    writeFileSync(join(repo, "src", "wallet.ts"), "export const KEY_FILE = 'worker-1.json';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    mkdirSync(join(repo, "testing", "keys"), { recursive: true });
    writeFileSync(join(repo, "testing", "keys", "worker-1.json"), '{"secretKey":"PRIVKEY-5b3a9f"}\n');
    mkdirSync(join(repo, ".data"));
    writeFileSync(join(repo, ".data", "dump.json"), '{"note":"PRIVKEY-5b3a9f"}\n');
    await runCodeIndex(db, { repoId: "g", root: repo });

    const leak = grepCode(db, "g", repo, "PRIVKEY-5b3a9f");
    expect({ hits: leak.hits, files: leak.files }).toEqual({ hits: 0, files: 0 });
    // Просмотрено ровно то, что в реестре: .gitignore и src/wallet.ts.
    expect(leak.searched).toBe(2);
    expect(grepCode(db, "g", repo, "worker-1.json").groups.map((g) => g.path)).toEqual(["src/wallet.ts"]);
    // Области под игнорируемым нет — это отказ, а не «0 вхождений».
    const scope = resolveGrepScope(db, "g", repo, ["testing/keys"]);
    expect(scope.ok ? "ok" : scope.code).toBe("notfound.scope");
  });
});
