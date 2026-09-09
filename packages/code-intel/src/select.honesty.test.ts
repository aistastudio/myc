/**
 * И2 в одной строке отчёта `init` (memory-m30yh8swnm1d, часть 3).
 *
 * Строка «код-интеллект builtin: символы и fan_in по тексту» обещала то, чего
 * не происходило: индекс не строила ни одна команда, а для репозитория без
 * ts/tsx/js/jsx определений не будет НИКОГДА (§5, уровень L1). Обещание,
 * которое читатель не может проверить, — ровно то, что И2 называет ложью.
 *
 * МУТАЦИЯ: заставить `builtinAbility` не смотреть на дерево (вернуть одну и
 * ту же строку про символы) — краснеет «репозиторий без TS».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeL1Files } from "./langs.ts";
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
    writeFileSync(join(dir, "app", "main.py"), "def f():\n    return 1\n");
    const p = probeL1Files(dir);
    expect(p.found).toBe(false);
    expect(p.langs).toContain("py");
  });

  test("node_modules и .myc не обходятся: чужое дерево не наша статистика", () => {
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "i.ts"), "export const x = 1;\n");
    mkdirSync(join(dir, ".myc"), { recursive: true });
    writeFileSync(join(dir, ".myc", "state.ts"), "export const s = 1;\n");
    expect(probeL1Files(dir).found).toBe(false);
  });
});

describe("строка init обещает ровно то, что будет", () => {
  test("TS-репозиторий: символы обещаны И названо, чем они появятся", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    const s = selectCodeIntel(dir, env(), "builtin");
    expect(s.reason).toContain("ts/tsx/js/jsx");
    expect(s.reason).toContain("myc code index");
    expect(s.state).toBe("ok");
  });

  test("репозиторий без TS: символов НЕ обещано, и сказано, что работает", () => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "main.py"), "def f():\n    return 1\n");
    const s = selectCodeIntel(dir, env(), "builtin");
    expect(s.reason).toContain("не будет");
    expect(s.reason).toContain("якоря");
    expect(s.reason).toContain("py");
    // Ровно то обещание, которого не должно остаться.
    expect(s.reason).not.toContain("символы и fan_in по тексту для");
  });

  test("auto без graft говорит про builtin то же самое, а не своё", () => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "main.py"), "def f():\n    return 1\n");
    const s = selectCodeIntel(dir, env(), "auto");
    expect(s.id).toBe("builtin");
    expect(s.reason).toContain("не будет");
    expect(s.reason).toContain("callers");
  });
});
