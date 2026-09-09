/**
 * ПРИЁМКА ПУЛА РАЗБОРА НА СОБРАННОМ БИНАРЕ, а не на исходниках.
 *
 * Это и есть корень пропуска, из-за которого сломанный пул прожил в продукте:
 * `bun test` работает в дереве с node_modules, и воркер, который в бинаре не
 * находит ни своего модуля, ни web-tree-sitter, в тестах находит и то, и
 * другое. Прогон был зелёным, а `./dist/myc code index` на этом репозитории
 * падал восемью воркерами из восьми и завершался то кодом 1, то кодом 0.
 *
 * Приём в репозитории уже был: `scripts/coldstart.ts` и `bench-latency.ts`
 * меряют `dist/myc`, собранный РЕЦЕПТОМ (`scripts/build.ts`), а не собранный
 * руками; `packages/web/src/viz.test.ts` сторожит вшивание ассетов в выход.
 * Здесь то же самое для воркера.
 *
 * Корпус кладётся ВНЕ дерева репозитория и запускается с cwd в нём: рядом с
 * ним нет node_modules, и резолвер не может случайно найти то, чего у
 * скачавшего бинарь не будет.
 *
 * ЦЕНА. Сборка рецептом ~0.2 с (инкрементальная), три прогона бинаря на 80
 * файлах ~0.3 с каждый. Это дороже обычного теста и дешевле продукта, который
 * не работает.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BUILD_ARGS, buildBinary } from "../../../scripts/build.ts";
import { PARSE_POOL_MIN_FILES } from "./code_index.ts";
import {
  PARSE_WORKER_ENTRY_NAMING,
  PARSE_WORKER_IN_BINARY,
  PARSE_WORKER_SOURCE,
} from "./parse_worker_entry.ts";

const BINARY = join(process.cwd(), "dist", "myc");
/** Заведомо выше порога пула: пул обязан завестись, иначе проверять нечего. */
const FILES = PARSE_POOL_MIN_FILES + 16;

let dir: string;
let db: string;

interface Run {
  readonly code: number;
  readonly out: string;
}

async function myc(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([BINARY, ...args], {
    cwd: dir,
    // MYC_DRAIN=0: фоновый дренаж поднимает `myc code index` отсоединённым
    // процессом, и он растащил бы очередь у измеряемого прогона.
    env: { ...process.env, MYC_DRAIN: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

/** Очередь и индекс с нуля: следующий прогон обязан разбирать всё заново. */
function resetIndex(): void {
  const h = new Database(db, { readwrite: true });
  h.run("PRAGMA busy_timeout = 20000");
  h.run("DELETE FROM code_defs");
  h.run("DELETE FROM code_files");
  h.run("DELETE FROM code_refs");
  h.run("DELETE FROM jobs WHERE kind = ?", ["code_index"]);
  h.close();
}

function defsCount(): number {
  const h = new Database(db, { readonly: true });
  const n = (h.query("SELECT count(*) AS n FROM code_defs").get() as { n: number }).n;
  h.close();
  return n;
}

beforeAll(async () => {
  await buildBinary({ quiet: true });
  dir = mkdtempSync(join(tmpdir(), "myc-code-index-bin-"));
  for (let i = 0; i < FILES; i++) {
    writeFileSync(
      join(dir, `f${i}.ts`),
      `export function fn${i}(): number {\n  return ${i};\n}\n\nexport class C${i} {\n  m${i}(): void {}\n}\n`,
    );
  }
  db = join(dir, ".myc", "myc.db");
  const init = await myc(["init"]);
  expect(init.code).toBe(0);
}, 120_000);

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("собранный бинарь: пул разбора", () => {
  test("рецепт сборки вшивает воркер вторым входом и фиксирует его имя", () => {
    // Сторож рецепта: без второго входа воркера в бинаре нет вовсе, без
    // --entry-naming его имя зависит от места ДРУГОГО входа.
    expect(BUILD_ARGS).toContain(PARSE_WORKER_SOURCE);
    expect(BUILD_ARGS).toContain("--entry-naming");
    expect(BUILD_ARGS).toContain(PARSE_WORKER_ENTRY_NAMING);
    expect(PARSE_WORKER_IN_BINARY).toBe("/$bunfs/root/code_index_worker.js");
  });

  test(`индексирует ${FILES} файлов ПУЛОМ: exit 0, отказов нет, символы в базе`, async () => {
    resetIndex();
    const run = await myc(["--json", "code", "index"]);
    expect(run.code).toBe(0);
    const drain = (JSON.parse(run.out) as { data: { drain: Record<string, number> } }).data.drain;
    expect(drain.parsed).toBe(FILES);
    expect(drain.failed).toBe(0);
    // Пул ОБЯЗАН был участвовать. Без этой строки тест зелен и тогда, когда
    // воркера в бинаре нет вовсе: разбор уходит в главный поток, `parsed` тот
    // же. Не `=== FILES`: сторож пула на загруженной машине вправе погасить
    // его посреди батча, и это законный исход — незаконен ноль.
    expect(drain.pooled).toBeGreaterThan(0);
    // По три определения на файл: функция, класс и метод внутри него.
    expect(defsCount()).toBe(FILES * 3);
  }, 120_000);

  test("мутация: вход воркера снова ищется по import.meta.url — бинарь падает", async () => {
    // Это ровно тот дефект, что жил в продукте: `bun build --compile` воркеров
    // не вшивает, и URL из import.meta ведёт на .ts сборочной машины.
    resetIndex();
    const run = await myc(["code", "index"], { MYC_PARSE_POOL_MUTATION: "entry-from-source" });
    expect(run.code).not.toBe(0);
    expect(run.out).toContain("воркер разбора");
    expect(run.out).toContain("web-tree-sitter");
  }, 120_000);

  test("мутация: каталоги wasm ищутся в воркере — бинарь падает", async () => {
    resetIndex();
    const run = await myc(["code", "index"], { MYC_PARSE_POOL_MUTATION: "resolve-in-worker" });
    expect(run.code).not.toBe(0);
    expect(run.out).toContain("MYC_TREE_SITTER_DIR");
  }, 120_000);

  test("падение воркера — отказ команды, а не «готово»", async () => {
    // Обе мутации выше уже оставили в базе полный индекс: очередь разбирается
    // в своём потоке, файлы не теряются. Проверяется ИМЕННО исход команды —
    // прежде он зависел от того, какой воркер упал первым, и бывал нулевым.
    resetIndex();
    const broken = await myc(["code", "index"], { MYC_PARSE_POOL_MUTATION: "entry-from-source" });
    expect(broken.code).not.toBe(0);
    expect(defsCount()).toBe(FILES * 3);
  }, 120_000);
});
