import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_SWITCHES, cliTestEnv } from "./test-env.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

/** Все рантайм-исходники монорепозитория: без тестов, сборок и зависимостей. */
function runtimeSources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", ".myc", "graft"].includes(e.name)) continue;
      runtimeSources(p, acc);
      continue;
    }
    if (!e.name.endsWith(".ts") || e.name.includes(".test.")) continue;
    if (statSync(p).size > 2_000_000) continue;
    acc.push(p);
  }
  return acc;
}

describe("выключатели фоновых механизмов перечислены в одном месте", () => {
  test("каждая защита `NODE_ENV === \"test\"` читает переменную из реестра", () => {
    // Признак фонового механизма: функция гасит себя под тестом по NODE_ENV и
    // при этом читает СВОЮ MYC_*-переменную, чтобы её можно было выключить
    // снаружи. Именно такую пару обязан знать спавнящий тест.
    // Ищем не «любую MYC_* в файле», а ту, что читается РЯДОМ с проверкой:
    // выключатель механизма стоит в той же функции, обычно следующей строкой.
    // Более широкий признак ловил бы MYC_ACTOR и настроечные переменные —
    // сторож, который врёт, хуже отсутствующего.
    const WINDOW = 6;
    const missing: string[] = [];
    for (const file of runtimeSources(join(REPO, "packages"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.includes('NODE_ENV === "test"')) continue;
        const near = lines.slice(i, Math.min(lines.length, i + WINDOW)).join("\n");
        for (const m of near.matchAll(/\benv\.(MYC_[A-Z0-9_]+)/g)) {
          const name = m[1]!;
          // Настроечные переменные (бюджеты, интервалы, заглушки) — не выключатели.
          if (/_MS$|_BUDGET|_TIMEOUT|_FAKE/.test(name)) continue;
          if (!BACKGROUND_SWITCHES.includes(name)) {
            missing.push(`${file.slice(REPO.length + 1)}:${i + 1}: ${name}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("сборщик гасит все выключатели реестра", () => {
    const env = cliTestEnv();
    for (const name of BACKGROUND_SWITCHES) expect(env[name]).toBe("0");
  });

  test("extra перекрывает реестр: тест механизма обязан уметь его включить", () => {
    expect(cliTestEnv({ MYC_DRAIN: "1" })["MYC_DRAIN"]).toBe("1");
  });

  test("реестр не пуст и без дублей", () => {
    expect(BACKGROUND_SWITCHES.length).toBeGreaterThan(0);
    expect(new Set(BACKGROUND_SWITCHES).size).toBe(BACKGROUND_SWITCHES.length);
  });
});
