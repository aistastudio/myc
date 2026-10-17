/**
 * Приёмка memory-tatk1jg3qjfs: хук post-edit больше не платит за граф
 * модулей дренажа на каждую правку файла.
 *
 * Три утверждения:
 *
 *   1. ЦЕНА: полный процесс `myc anchor touch` не дороже того же запуска с
 *      полностью выключенным фоном (MYC_DRAIN=0) — с фиксом команда дренаж
 *      вообще не импортируется, и отношения ≈1. Мутация, вернувшая дренаж
 *      в touch, добавляет ~7.6 мс p50 (замер в отчёте:43.6 против34.5) и
 *      роняет это отношение.
 *   2. ОЧЕРЕДЬ НЕ ЗАСТАИВАЕТСЯ: touch снимать хвост НЕ обязан — но и не
 *      имеет права разбирать его молча за счёт чужого фона. Строку
 *      anchor_check, лежащую в очереди, touch оставляет на месте, а
 *      СЛЕДУЮЩАЯ обычная команда её подхватывает: агент, который только
 *      правит файлы, не оставляет работу навсегда.
 *
 * Бинарь собирается рецептом scripts/build.ts — как в launcher.test.ts:
 * цена меряется на НАСТОЯЩЕМ бинаре, потому что вся боль — в импорте
 * drain.ts при старте процесса, а не в функции touch.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobs, openSqlite } from "@myc/store-sqlite";
import { cliTestEnv } from "@myc/core";
import { BUILD_ARGS } from "../../../../scripts/build.ts";

let tmp: string;
let bin: string;
let ws: string;

async function spawnMyc(args: readonly string[], extra: Record<string, string>): Promise<number> {
  const t0 = performance.now();
  const proc = Bun.spawn([bin, ...args], {
    cwd: ws,
    env: cliTestEnv({ MYC_SERVER: "", MYC_TOKEN: "", MYC_UPDATE_CHECK: "0", ...extra }),
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  return performance.now() - t0;
}

function p50(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function seedAnchorJob(): number {
  const driver = openSqlite(join(ws, ".myc", "myc.db"));
  try {
    return jobs.enqueue(driver.database, "anchor_check", { entityId: "file.ts" }).id;
  } finally {
    driver.close();
  }
}

function anchorJobs(): number {
  const driver = openSqlite(join(ws, ".myc", "myc.db"));
  try {
    const r = driver.database
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM jobs
          WHERE kind = 'anchor_check' AND attempts < max_attempts
            AND lease_expires <= ${Date.now()} AND run_after <= ${Date.now()}`,
      )
      .get();
    return r?.n ?? -1;
  } finally {
    driver.close();
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "myc-touch-drain-"));
  ws = tmp;
  bin = join(tmp, "myc");
  // Тот же рецепт, что у scripts/build.ts (BUILD_ARGS): ровно его, с одним
  // --outfile, заменённым на наш каталог. Собранный тем же рецептом бинарь
  // и есть предмет замера (импорт drain.ts при старте).
  const recipe = [...BUILD_ARGS];
  const at = recipe.indexOf("--outfile");
  if (at < 0) throw new Error("в BUILD_ARGS нет --outfile");
  recipe[at + 1] = bin;
  if (recipe[0] === "bun") recipe[0] = process.execPath;
  const build = Bun.spawn(recipe, {
    cwd: join(import.meta.dir, "..", "..", "..", ".."),
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(build.stderr).text();
  if ((await build.exited) !== 0) throw new Error(`сборка бинаря провалилась: ${err.slice(0, 400)}`);
  if (!existsSync(bin)) throw new Error(`бинарь ${bin} не появился`);

  const init = Bun.spawn([bin, "init", "--slug", "d"], {
    cwd: tmp,
    env: cliTestEnv({ MYC_SERVER: "", MYC_TOKEN: "", NO_COLOR: "1", MYC_DRAIN: "0" }),
    stdout: "ignore",
    stderr: "pipe",
  });
  const initErr = await new Response(init.stderr).text();
  if ((await init.exited) !== 0) throw new Error(`init провалился: ${initErr.slice(0, 400)}`);
  writeFileSync(join(tmp, "file.ts"), "export const x = 1;\n");
}, 300_000);

afterAll(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
});

describe("цена: полный процесс touch не зависит от дренажа", () => {
  test("touch с включённым фоном ≤ того же запуска с выключенным (×1.15)", async () => {
    const N = 15;
    const on: number[] = [];
    const off: number[] = [];
    await spawnMyc(["anchor", "touch", "file.ts"], { MYC_DRAIN: "1", MYC_ANCHOR_CHECK: "1" }); // прогрев
    for (let i = 0; i < N; i++) on.push(await spawnMyc(["anchor", "touch", "file.ts"], { MYC_DRAIN: "1", MYC_ANCHOR_CHECK: "1" }));
    for (let i = 0; i < N; i++) off.push(await spawnMyc(["anchor", "touch", "file.ts"], { MYC_DRAIN: "0" }));
    const ratio = p50(on) / p50(off);
    // С фиксом ≈1: команда дренажа не импортируется. Мутация «условие
    // снято» добавляет импорт графа + открытие базы (~7.6 мс p50) и уводит
    // отношение к1.2+ — тест обязан покраснеть.
    expect(ratio).toBeLessThan(1.15);
  }, 120_000);
});

describe("очередь: touch не разбирает хвост, обычная команда подхватывает", () => {
  test("после серии touch строка anchor_check ждёт, следующая обычная команда её снимает", async () => {
    const jobId = seedAnchorJob();
    expect(anchorJobs()).toBe(1);

    // Серия правок без ЕДИНОЙ другой команды: хвост обязан ждать, а не
    // разбираться молча внутри touch (и не темпить очередь на каждую правку).
    for (let i = 0; i < 3; i++) {
      const code = await spawnMyc(["anchor", "touch", "file.ts"], { MYC_DRAIN: "1", MYC_ANCHOR_CHECK: "1" });
      expect(code).toBeLessThan(5000);
    }
    expect(anchorJobs()).toBe(1); // живa: touch её не трогал

    // Следующая обычная команда подхватывает хвост — застой невозможен.
    const readyCode = await spawnMyc(["ready"], { MYC_DRAIN: "1", MYC_ANCHOR_CHECK: "1" });
    expect(readyCode).toBeLessThan(10_000);
    expect(anchorJobs()).toBe(0);
    void jobId;
  }, 120_000);
});
