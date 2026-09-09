/**
 * Приёмка грамматик по требованию.
 *
 * СЕТИ ЗДЕСЬ НЕТ НИ В ОДНОМ ТЕСТЕ. `fetchGrammar` принимает подменный `fetch`,
 * и байты, которые он «скачивает», берутся с диска — из настоящей грамматики
 * в node_modules. Это не упрощение ради скорости: тест, ходящий в jsDelivr,
 * краснел бы от чужого простоя и зеленел бы, ничего не проверив, если бы CDN
 * начал отдавать другое содержимое. Проверяется НАШ контракт: sha256 решает,
 * частичная загрузка не оставляет файла, повтор не трогает сеть.
 *
 * Совпадение зашитых хешей с реальными файлами проверяется отдельным тестом
 * ниже — по тем же байтам, которые ставит `bun install`. Разъедься каталог с
 * пином версии — покраснеет он, а не пользователь на первой загрузке.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { L1_LANGS } from "./langs.ts";
import {
  FetchGrammarError,
  GRAMMARS,
  GRAMMAR_BY_LANG,
  type GrammarName,
  fetchGrammar,
  findGrammar,
  grammarMutation,
  grammarSearchPath,
  grammarSpecFor,
  grammarStates,
  grammarsCacheDir,
  missingGrammars,
} from "./grammars.ts";
import { DEF_LANGS, GrammarMissingError, MissingResourceError, grammarPath } from "./symbols.ts";

/** Настоящие .wasm из node_modules — источник байтов для подменного fetch. */
function realGrammarBytes(name: GrammarName): Buffer {
  const path = findGrammar(GRAMMARS[name].langs[0]!, {
    // Кеш пользователя из поиска убираем: тесту нужен ИМЕННО файл сборки.
    MYC_TREE_SITTER_GRAMMAR_DIR: grammarSearchPath()
      .filter((d) => !d.startsWith(grammarsCacheDir()))
      .join(delimiter),
  });
  if (path === null) throw new Error(`нет ${name}.wasm в node_modules: сначала bun install`);
  return readFileSync(path);
}

function stubFetch(body: Uint8Array, status = 200): typeof fetch {
  return (async () =>
    new Response(status === 200 ? body : null, {
      status,
      headers: { "content-length": String(body.byteLength) },
    })) as unknown as typeof fetch;
}

describe("каталог грамматик", () => {
  test("каждый язык L1 имеет грамматику, и лишних грамматик нет", () => {
    // Два списка про одно и то же расходятся молча: правило разбора без
    // грамматики даёт «символов нет», грамматика без правила — скачанные
    // мегабайты без единого символа. Оба исхода выглядят как «просто пусто».
    const l1 = [...L1_LANGS].sort();
    expect(Object.keys(GRAMMAR_BY_LANG).sort()).toEqual(l1);
    expect([...DEF_LANGS].map(String).sort()).toEqual(l1);
    const reachable = [...new Set(Object.values(GRAMMAR_BY_LANG))].map(String).sort();
    expect(reachable).toEqual(Object.keys(GRAMMARS).sort());
  });

  test("зашитые sha256 и размеры совпадают с файлами сборки", async () => {
    const { createHash } = await import("node:crypto");
    for (const name of Object.keys(GRAMMARS) as GrammarName[]) {
      const bytes = realGrammarBytes(name);
      expect({ name, bytes: bytes.byteLength }).toEqual({
        name,
        bytes: GRAMMARS[name].bytes,
      });
      expect({ name, sha: createHash("sha256").update(bytes).digest("hex") }).toEqual({
        name,
        sha: GRAMMARS[name].sha256,
      });
    }
  });

  test("адрес загрузки несёт ту же версию, что пин ABI", async () => {
    const { PINNED_TREE_SITTER } = await import("./treesitter_pin.ts");
    const v = PINNED_TREE_SITTER["tree-sitter-wasms"];
    for (const s of Object.values(GRAMMARS)) {
      expect(s.url).toContain(`tree-sitter-wasms@${v}/`);
    }
  });
});

describe("где грамматика ищется", () => {
  test("MYC_TREE_SITTER_GRAMMAR_DIR — СПИСОК каталогов, а не один", () => {
    const a = mkdtempSync(join(tmpdir(), "g-a-"));
    const b = mkdtempSync(join(tmpdir(), "g-b-"));
    try {
      // python во втором каталоге, typescript нигде: с одним каталогом такое
      // состояние выразить было нельзя, а после загрузки по требованию оно
      // штатное — кеш и node_modules сосуществуют.
      writeFileSync(join(b, GRAMMARS.python.file), realGrammarBytes("python"));
      const env = { MYC_TREE_SITTER_GRAMMAR_DIR: [a, b].join(delimiter) };
      expect(findGrammar("py", env)).toBe(join(b, GRAMMARS.python.file));
      expect(findGrammar("ts", env)).toBeNull();
      expect(missingGrammars(["py", "ts"], env).map((m) => m.grammar)).toEqual(["typescript"]);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("файл неверного размера за грамматику не считается", () => {
    const dir = mkdtempSync(join(tmpdir(), "g-trunc-"));
    try {
      writeFileSync(join(dir, GRAMMARS.python.file), realGrammarBytes("python").subarray(0, 1024));
      const env = { MYC_TREE_SITTER_GRAMMAR_DIR: dir };
      expect(findGrammar("py", env)).toBeNull();
      expect(missingGrammars(["py"], env)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("js и jsx делят одну грамматику и просят её один раз", () => {
    const dir = mkdtempSync(join(tmpdir(), "g-empty-"));
    try {
      const miss = missingGrammars(["js", "jsx"], { MYC_TREE_SITTER_GRAMMAR_DIR: dir });
      expect(miss).toHaveLength(1);
      expect(miss[0]!.grammar).toBe("javascript");
      expect([...miss[0]!.langs]).toEqual(["js", "jsx"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("отказ называет ресурс, а не сбой", () => {
  test("нет грамматики — GrammarMissingError с языком, весом и командой", () => {
    const dir = mkdtempSync(join(tmpdir(), "g-none-"));
    const saved = process.env.MYC_TREE_SITTER_GRAMMAR_DIR;
    process.env.MYC_TREE_SITTER_GRAMMAR_DIR = dir;
    try {
      let caught: unknown = null;
      try {
        grammarPath("py");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(GrammarMissingError);
      // Класс, а не текст: на нём ветвится CLI, превращая отказ в
      // `precond.grammar_missing` вместо `internal.unexpected`.
      expect(caught).toBeInstanceOf(MissingResourceError);
      const err = caught as GrammarMissingError;
      expect(err.lang).toBe("py");
      expect(err.hint).toBe("myc code fetch py");
      expect(err.message).toContain("tree-sitter-python.wasm");
      expect(err.message).toContain("464.9 КБ"); // вес назван, а не только факт
    } finally {
      if (saved === undefined) delete process.env.MYC_TREE_SITTER_GRAMMAR_DIR;
      else process.env.MYC_TREE_SITTER_GRAMMAR_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("загрузка", () => {
  test("качает, сверяет sha256, кладёт под нужным именем", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g-fetch-"));
    try {
      const bytes = realGrammarBytes("python");
      let calls = 0;
      const r = await fetchGrammar("python", {
        dir,
        fetchImpl: ((...a: Parameters<typeof fetch>) => {
          calls++;
          return stubFetch(bytes)(...a);
        }) as typeof fetch,
      });
      expect(calls).toBe(1);
      expect(r.alreadyPresent).toBe(false);
      expect(statSync(r.path).size).toBe(GRAMMARS.python.bytes);
      expect(r.path).toBe(join(dir, "tree-sitter-python.wasm"));
      expect(findGrammar("py", { MYC_TREE_SITTER_GRAMMAR_DIR: dir })).toBe(r.path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("идемпотентна: второй вызов сети не касается", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g-idem-"));
    try {
      const bytes = realGrammarBytes("python");
      await fetchGrammar("python", { dir, fetchImpl: stubFetch(bytes) });
      let calls = 0;
      const second = await fetchGrammar("python", {
        dir,
        fetchImpl: ((...a: Parameters<typeof fetch>) => {
          calls++;
          return stubFetch(bytes)(...a);
        }) as typeof fetch,
      });
      expect({ calls, already: second.alreadyPresent }).toEqual({ calls: 0, already: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("хеш не сошёлся — файла нет вовсе, и .part тоже", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g-bad-"));
    try {
      const bytes = realGrammarBytes("python");
      const tampered = Buffer.from(bytes);
      tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);
      let caught: unknown = null;
      try {
        await fetchGrammar("python", { dir, fetchImpl: stubFetch(tampered) });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FetchGrammarError);
      expect((caught as FetchGrammarError).code).toBe("checksum_mismatch");
      // Полуфабрикат на месте грамматики хуже её отсутствия: следующий прогон
      // принял бы его за грамматику и упал бы уже в рантайме tree-sitter.
      expect(existsSync(join(dir, "tree-sitter-python.wasm"))).toBe(false);
      expect(existsSync(join(dir, "tree-sitter-python.wasm.part"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("сети нет — код network_error, а не стек", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g-off-"));
    try {
      const offline = (() => {
        throw new TypeError("Unable to connect");
      }) as unknown as typeof fetch;
      let caught: unknown = null;
      try {
        await fetchGrammar("python", { dir, fetchImpl: offline });
      } catch (e) {
        caught = e;
      }
      expect((caught as FetchGrammarError).code).toBe("network_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HTTP не 200 — http_error, файл не создан", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g-404-"));
    try {
      let caught: unknown = null;
      try {
        await fetchGrammar("python", { dir, fetchImpl: stubFetch(new Uint8Array(), 404) });
      } catch (e) {
        caught = e;
      }
      expect((caught as FetchGrammarError).code).toBe("http_error");
      expect(existsSync(join(dir, "tree-sitter-python.wasm"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("состояние отличает corrupt от absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g-state-"));
    try {
      const bytes = realGrammarBytes("python");
      const tampered = Buffer.from(bytes);
      tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0); // размер тот же, байты другие
      writeFileSync(join(dir, GRAMMARS.python.file), tampered);
      const states = await grammarStates({ MYC_TREE_SITTER_GRAMMAR_DIR: dir });
      const byName: Record<string, string> = {};
      for (const st of states) byName[st.grammar] = st.status;
      expect(byName["python"]).toBe("corrupt");
      expect(byName["typescript"]).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("мутация приёмки", () => {
  test("MYC_GRAMMAR_MUTATION=assume-present снимает проверку наличия", () => {
    const dir = mkdtempSync(join(tmpdir(), "g-mut-"));
    try {
      const env = { MYC_TREE_SITTER_GRAMMAR_DIR: dir };
      // Без мутации нехватка видна…
      expect(grammarMutation(env)).toBe("none");
      expect(missingGrammars(["py"], env)).toHaveLength(1);
      // …с мутацией её не видно, и именно это обязано ронять тесты пропуска
      // в code_index.test.ts (см. там «мутация: проверка наличия снята»).
      const mutated = { ...env, MYC_GRAMMAR_MUTATION: "assume-present" };
      expect(grammarMutation(mutated)).toBe("assume-present");
      expect(missingGrammars(["py"], mutated)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("спецификация языка", () => {
  test("grammarSpecFor отдаёт файл и вес для каждого L1", () => {
    for (const lang of DEF_LANGS) {
      const s = grammarSpecFor(lang);
      expect(s.file).toBe(`tree-sitter-${s.name}.wasm`);
      expect(s.bytes).toBeGreaterThan(0);
      expect(s.langs).toContain(lang);
    }
  });
});
