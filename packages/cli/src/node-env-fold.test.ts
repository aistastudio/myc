/**
 * СТОРОЖ: НИ ОДНО ЧТЕНИЕ NODE_ENV В ИСХОДНИКАХ ПАКЕТОВ НЕ СВОРАЧИВАЕТСЯ
 * БАНДЛЕРОМ В КОНСТАНТУ (memory-h5zp5mqcdbay).
 *
 * `bun build` заменяет `process.env.NODE_ENV` значением из окружения СБОРКИ.
 * `code_index.binary.test.ts` пересобирал `dist/myc` под `bun test`
 * (NODE_ENV=test), и сторож `if (process.env.NODE_ENV === "test") return;` в
 * drainAfterCommand становился безусловным return: бинарь, на который
 * смотрит MCP, ~21 ч не делал фона после команд. Все тесты при этом были
 * зелёными — они гоняют исходники, где подстановки нет.
 *
 * ПРОВЕРЯЕТ САМ БАНДЛЕР, А НЕ РЕГУЛЯРКА. Каждый рантайм-исходник
 * packages/<пакет>/src (без тестов и без preload раннера) проходит через
 * Bun.build — изолированно, с внешними импортами и `minify`, как в рецепте, —
 * с define, заменяющим NODE_ENV идентификатором-меткой. Метка в выходе
 * значит: в собранном бинаре это чтение стало бы константой. Регулярка
 * отставала бы от бандлера: `process.env["NODE_ENV"]` и
 * ``process.env[`NODE_ENV`]`` он сворачивает, `process.env?.NODE_ENV` — нет,
 * а комментарии и строки она путала бы с кодом. Метка — идентификатор, а не
 * строка: сравнение строки с "test" минификатор свернул бы вместе с веткой,
 * и метка пропала бы из выхода вместе с уликой.
 *
 * Каким формам верить — пригвождено канарейкой: сворачиваемые обязаны
 * ловиться, а параметр (так тестовый режим узнают drain.ts и update-check.ts)
 * — нет. Сменит bun правила подстановки — покраснеет канарейка, а не молча
 * сторож.
 *
 * Мутация: вернуть `process.env.NODE_ENV === "test"` в drainAfterCommand —
 * первый тест называет packages/cli/src/drain.ts.
 *
 * ЦЕНА ~0,1 с: один Bun.build на все исходники и один на канарейку.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, relative } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const MARK = "__MYC_FOLDED_NODE_ENV__";

/** Preload раннера — из bunfig.toml: исполняется только под `bun test`, в бинарь не попадает. */
function preloads(): Set<string> {
  const cfg = Bun.TOML.parse(readFileSync(join(REPO, "bunfig.toml"), "utf8")) as {
    test?: { preload?: string | string[] };
  };
  const list = cfg.test?.preload ?? [];
  return new Set((Array.isArray(list) ? list : [list]).map((p) => normalize(join(REPO, p))));
}

function walk(dir: string, skip: ReadonlySet<string>, acc: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, skip, acc);
      continue;
    }
    if (!/\.(tsx?|mjs|js)$/.test(e.name) || e.name.endsWith(".d.ts") || e.name.includes(".test.")) continue;
    if (!skip.has(normalize(p))) acc.push(p);
  }
}

/** Рантайм-исходники всех пакетов: без тестов, объявлений типов и preload. */
function runtimeSources(): string[] {
  const skip = preloads();
  const acc: string[] = [];
  for (const pkg of readdirSync(join(REPO, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(REPO, "packages", pkg.name, "src");
    try {
      walk(src, skip, acc);
    } catch {
      // пакет без src — не наш случай
    }
  }
  return acc;
}

/**
 * Каждый файл — сам по себе: импорты внешние. Иначе метка из общего модуля
 * приписалась бы каждому, кто его импортирует, и сторож называл бы не тот файл.
 */
const ISOLATE: BunPlugin = {
  name: "isolate",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (a) =>
      a.kind.startsWith("entry-point") ? undefined : { path: a.path, external: true },
    );
  },
};

const stem = (p: string): string => normalize(p).replace(/\.(tsx?|mjs|js)$/, "");

/** Сколько чтений NODE_ENV бандлер свернул бы в каждом файле: путь от root → число. */
async function foldedReads(files: readonly string[], root: string): Promise<Record<string, number>> {
  const r = await Bun.build({
    entrypoints: [...files],
    target: "bun",
    minify: true,
    root,
    naming: "[dir]/[name].[ext]",
    define: { "process.env.NODE_ENV": MARK },
    plugins: [ISOLATE],
  });
  if (!r.success) throw new AggregateError(r.logs, "Bun.build не собрал исходники — сторож ничего не проверил");
  const byStem = new Map(files.map((f) => [stem(relative(root, f)), relative(root, f)]));
  const out: Record<string, number> = {};
  for (const o of r.outputs) {
    const n = (await o.text()).split(MARK).length - 1;
    if (n > 0) out[byStem.get(stem(o.path)) ?? o.path] = n;
  }
  return out;
}

describe("NODE_ENV не сворачивается в собранном бинаре", () => {
  test("рантайм-исходники: ни одного чтения NODE_ENV, которое бандлер заменит константой", async () => {
    const files = runtimeSources();
    // Сторож, которому нечего сторожить, зелен всегда: оба места прежнего
    // дефекта обязаны быть в выборке, preload раннера — нет.
    const rel = files.map((f) => relative(REPO, f));
    expect(rel).toContain("packages/cli/src/drain.ts");
    expect(rel).toContain("packages/cli/src/update-check.ts");
    expect(rel).not.toContain("packages/store-sqlite/src/runtime-preload.ts");
    expect(await foldedReads(files, REPO)).toEqual({});
  });

  describe("канарейка: сторож видит ровно то, что сворачивает бандлер", () => {
    /** Формы, которые `bun build` заменяет константой (замер на bun 1.3.14 с --compile). */
    const FOLDED: Record<string, string> = {
      dot: "process.env.NODE_ENV",
      spaced: "process . env . NODE_ENV",
      bracket: 'process.env["NODE_ENV"]',
      single: "process.env['NODE_ENV']",
      backtick: "process.env[`NODE_ENV`]",
    };
    /** Формы, которые остаются чтением в рантайме. Первая — та, на которой стоит фикс. */
    const RUNTIME: Record<string, string> = {
      parameter: "((processEnv: NodeJS.ProcessEnv = process.env) => processEnv.NODE_ENV)()",
      reflect: 'Reflect.get(process.env, "NODE_ENV")',
      optional: "process.env?.NODE_ENV",
      destructure: "(() => { const { NODE_ENV } = process.env; return NODE_ENV; })()",
      bunEnv: "Bun.env.NODE_ENV",
    };
    let dir: string | undefined;
    afterAll(() => {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    });

    test("сворачиваемые формы ловятся все, чтения в рантайме — ни одно", async () => {
      dir = mkdtempSync(join(tmpdir(), "myc-node-env-fold-"));
      const files: string[] = [];
      for (const [name, form] of Object.entries({ ...FOLDED, ...RUNTIME })) {
        const f = join(dir, `${name}.ts`);
        // Сравнение с "test" — как в сторожах фона: оно не должно съесть улику.
        writeFileSync(f, `export const underTest = (${form}) === "test";\n`);
        files.push(f);
      }
      const hit = Object.keys(await foldedReads(files, dir)).map((p) => p.replace(/\.ts$/, "")).sort();
      expect(hit).toEqual(Object.keys(FOLDED).sort());
    });
  });
});
