/**
 * И2 в одной строке отчёта `init` (memory-m30yh8swnm1d, часть 3).
 *
 * Строка «код-интеллект builtin: символы и fan_in по тексту» обещала то, чего
 * не происходило: индекс не строила ни одна команда, а для репозитория без
 * L1-языков определений не будет НИКОГДА (§5, уровень L1). Обещание, которое
 * читатель не может проверить, — ровно то, что И2 называет ложью.
 *
 * ФИКСТУРА «БЕЗ L1» БЫЛА PYTHON И ПЕРЕСТАЛА ЕЮ БЫТЬ. С переходом на
 * tree-sitter (memory-hrsae2f1mf7a) python стал L1: символы по нему теперь
 * есть. Оставить .py в роли «языка, которого мы не разберём никогда» значило
 * бы проверять ложь — тест бы зеленел, утверждая то, чего больше нет.
 * Поэтому фикстура переехала на .rb: грамматика ruby у tree-sitter есть, но в
 * L1 его никто не заводил, и обещания по нему мы не даём. Утверждения не
 * ослаблены: та же строка, та же проверка «не обещано», другой язык.
 *
 * МУТАЦИЯ: заставить `builtinAbility` не смотреть на дерево (вернуть одну и
 * ту же строку про символы) — краснеет «репозиторий без TS».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L1_LANGS_LABEL, probeL1Files } from "./langs.ts";
import { selectCodeIntel, type SelectEnv } from "./select.ts";

let dir: string;

function env(): SelectEnv {
  return {
    path: "/usr/bin:/bin",
    which: () => null,
    graftVersion: () => null,
    now: () => 1_700_000_000_000,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-ci-honesty-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("проба L1", () => {
  test("находит первый ts и обрывается", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    const p = probeL1Files(dir);
    expect(p.found).toBe(true);
    expect(p.langs).toContain("ts");
  });

  test("дерево без L1: found=false, языки названы", () => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "main.rb"), "def f\n  1\nend\n");
    const p = probeL1Files(dir);
    expect(p.found).toBe(false);
    expect(p.langs).toContain("rb");
  });

  test("node_modules и .myc не обходятся: чужое дерево не наша статистика", () => {
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "i.ts"), "export const x = 1;\n");
    mkdirSync(join(dir, ".myc"), { recursive: true });
    writeFileSync(join(dir, ".myc", "state.ts"), "export const s = 1;\n");
    expect(probeL1Files(dir).found).toBe(false);
  });
});

describe("python стал L1", () => {
  test("репозиторий на python: символы ОБЕЩАНЫ, и это правда (грамматика есть)", () => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "main.py"), "def f():\n    return 1\n");
    const p = probeL1Files(dir);
    expect(p.found).toBe(true);
    expect(p.langs).toContain("py");
    const s = selectCodeIntel(dir, env(), "builtin");
    expect(s.reason).toContain("py");
    expect(s.reason).toContain("myc code index");
    expect(s.reason).not.toContain("no symbols");
  });
});

describe("строка init обещает ровно то, что будет", () => {
  test("TS-репозиторий: символы обещаны И названо, чем они появятся", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    const s = selectCodeIntel(dir, env(), "builtin");
    expect(s.reason).toContain(L1_LANGS_LABEL);
    expect(s.reason).toContain("myc code index");
    expect(s.state).toBe("ok");
  });

  test("репозиторий без TS: символов НЕ обещано, и сказано, что работает", () => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "main.rb"), "def f\n  1\nend\n");
    const s = selectCodeIntel(dir, env(), "builtin");
    expect(s.reason).toContain("no symbols");
    expect(s.reason).toContain("anchors");
    expect(s.reason).toContain("rb");
    // Ровно то обещание, которого не должно остаться.
    expect(s.reason).not.toContain("symbols and fan_in by text for");
  });

  test("auto без graft говорит про builtin то же самое, а не своё", () => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "main.rb"), "def f\n  1\nend\n");
    const s = selectCodeIntel(dir, env(), "auto");
    expect(s.id).toBe("builtin");
    expect(s.reason).toContain("no symbols");
    expect(s.reason).toContain("callers");
  });
});

/**
 * ЛОЖЬ В ОБРАТНУЮ СТОРОНУ (memory-bn4cs836df52). В 0.3.0 все три режима,
 * где работает builtin, дописывали к строке «callers/search/map недоступны»,
 * а символы называли разобранными «по тексту» — при tree-sitter и работающих
 * `myc callers`, `myc code search`, `myc code map`. Поведенческая половина
 * (команды на самом деле отвечают) — в guard'е пакета cli,
 * `code-intel.honesty.test.ts`; здесь — сама строка, без чужих пакетов.
 *
 * МУТАЦИЯ: вернуть «, callers/search/map недоступны» в любую из трёх веток
 * `selectCodeIntel` — краснеет строка этого режима.
 */
describe("builtin с L1-файлами: строка называет то, что даёт, и не отрицает этого", () => {
  const withOldGraft = (): SelectEnv => ({
    ...env(),
    which: (cmd) => (cmd === "graft" ? "/usr/local/bin/graft" : null),
    graftVersion: () => "0.0.1",
  });

  for (const [label, pick] of [
    ["builtin", () => selectCodeIntel(dir, env(), "builtin")],
    ["auto без graft", () => selectCodeIntel(dir, env(), "auto")],
    ["auto со старым graft", () => selectCodeIntel(dir, withOldGraft(), "auto")],
  ] as const) {
    test(label, () => {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "src", "b.py"), "def b():\n    return 1\n");
      const s = pick();
      expect(s.id).toBe("builtin");
      expect(s.reason).not.toMatch(/unavailable|not available|недоступ/iu);
      // «символы … по тексту» до первой точки с запятой — прежнее «символы и
      // fan_in по тексту»; текстовым в строке имеет право быть только fan_in.
      expect(s.reason).not.toMatch(/symbols[^;]*(?:by|from|as) text|символы[^;]*по тексту/iu);
      expect(s.reason).toContain("tree-sitter");
      for (const cap of ["callers", "code search", "code map"]) expect(s.reason).toContain(cap);
      expect(s.reason).toContain(L1_LANGS_LABEL);
      expect(s.reason).toContain("myc code index");
    });
  }
});
