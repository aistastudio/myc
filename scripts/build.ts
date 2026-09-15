#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { cliTestEnv } from "@myc/core";
import {
  PARSE_WORKER_ENTRY_NAMING,
  PARSE_WORKER_SOURCE,
} from "../packages/code-intel/src/parse_worker_entry.ts";
import { BUNDLED_SQLITE_FILE } from "../packages/store-sqlite/src/runtime.ts";

/** Корень репозитория: пути рецепта относительны ему, а не cwd вызвавшего. */
const ROOT = resolve(import.meta.dir, "..");

/** Поставляемый артефакт — на него же смотрят `.mcp.json` и хук очереди. */
const DEFAULT_OUTFILE = "dist/myc";

/**
 * NODE_ENV — ЯВНО, ФЛАГОМ РЕЦЕПТА, а не окружением того, кто собирает
 * (memory-h5zp5mqcdbay).
 *
 * `bun build` подставляет вместо `process.env.NODE_ENV` (и вместо
 * `process.env["NODE_ENV"]`) КОНСТАНТУ — и берёт её из окружения СБОРКИ.
 * `code_index.binary.test.ts` пересобирал `dist/myc` под `bun test`, где
 * NODE_ENV=test, и сторож `NODE_ENV === "test"` в drainAfterCommand
 * сворачивался в безусловный return: бинарь, на который смотрит MCP, ~21 ч
 * молча не делал фона после команд — ни absorb, ни прогона якорей, ни
 * code_refresh.
 *
 * Почему не «убрать NODE_ENV из окружения». Замер на bun 1.3.14: без NODE_ENV
 * в окружении сборки литерал сворачивается в "development" — чтения в рантайме
 * не получается ни при каком окружении, выбирается только запечённое
 * значение. Значит его надо назвать, и назвать production: так поставляется
 * бинарь (help `--compile` обещает «implies --production», а фактически без
 * окружения печёт development), зависимости берут боевые ветки, и артефакт не
 * зависит от того, в какой оболочке его собрали.
 *
 * Почему флагом, а не `env` у spawn. Рецепт спавнит не только buildBinary:
 * launcher.test.ts собирает BUILD_ARGS сам, pack-npm.ts — свой бандл. Define в
 * самом рецепте действует на любого, кто его спавнит, и он сильнее окружения
 * (сборка под NODE_ENV=test с этим флагом печёт production — проверено и
 * пригвождено в scripts/build.test.ts).
 *
 * Собственный код от подстановки не зависит вовсе: сворачиваемого чтения
 * NODE_ENV в исходниках пакетов нет, это сторожит
 * packages/cli/src/node-env-fold.test.ts. Флаг — для зависимостей и для
 * кода, который однажды пропустит сторож.
 */
export const NODE_ENV_DEFINE: readonly string[] = ["--define", 'process.env.NODE_ENV="production"'];

/**
 * ЕДИНСТВЕННОЕ место, где записан рецепт сборки бинаря. Импортируется теми,
 * кто его меряет (scripts/bench-latency.ts, scripts/coldstart.ts), — чтобы
 * измеряемый артефакт был заведомо тем же, что поставляемый.
 *
 * Почему это отдельная функция, а не просто скрипт: `dist/myc`, собранный
 * ВРУЧНУЮ без `--bytecode`, стартует на ~12 мс медленнее (35.7 против 24.1 мс
 * p50, чередующийся A/B на 45 раундов) — половина холодного старта. Бенчмарк
 * мерил такой бинарь трое суток, и сдвиг базовой линии 19 → 35 мс списывали
 * то на reindex, то на команду move, то на шум хоста. Артефакт, о котором
 * никто не может сказать, каким рецептом он собран, мерить нельзя.
 */
export const BUILD_ARGS: readonly string[] = [
  "bun",
  "build",
  "--compile",
  "--minify",
  // --bytecode: JS компилируется в байт-код на сборке, а не при каждом старте.
  // Без него каждый запуск платит за разбор всего бандла — те самые ~12 мс.
  "--bytecode",
  // Бинарь по умолчанию сам грузит .env* и ./bunfig.toml ТОГО каталога, где
  // его запустили, — то есть проекта пользователя: myc зовут хуки и MCP в
  // каждом. Тогда .env проекта попадал бы в process.env myc (и через `myc run`
  // — в команду), а preload из его bunfig.toml исполнялся бы внутри myc. Тот
  // же дефект, что закрывает shebang packages/cli/bin/myc.js для npm-пакета.
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  // Значение NODE_ENV не наследуется от того, кто собирает, — см. NODE_ENV_DEFINE.
  ...NODE_ENV_DEFINE,
  "packages/cli/src/main.ts",
  // ВТОРОЙ ВХОД — воркер пула разбора. Без него в бинаре воркера НЕТ: `bun
  // build` конструкцию `new Worker(new URL(...))` не видит и ничего по ней не
  // вшивает, а сохранённый в бандле `import.meta.url` ведёт на .ts сборочной
  // машины. Отдельным входом воркер попадает в bunfs самодостаточным бандлом,
  // с web-tree-sitter внутри. Путь берётся из `parse_worker_entry.ts` — оттуда
  // же рантайм берёт имя, под которым его искать.
  PARSE_WORKER_SOURCE,
  // Имя воркера в bunfs — не то, что вычислит бандлер по общему предку входов,
  // а то, что рантайм пойдёт искать. Без этой строки имя зависит от места
  // ДРУГОГО входа, и любой переезд гасит пул молча.
  "--entry-naming",
  PARSE_WORKER_ENTRY_NAMING,
  "--outfile",
  DEFAULT_OUTFILE,
];

/**
 * Рецепт с выходом в `outfile`; `drop` — флаги, которые выбрасывает мутация
 * (scripts/build.test.ts собирает бинарь без NODE_ENV_DEFINE). Собирает тот
 * bun, что исполняет этот скрипт, а не первый в PATH.
 */
export function recipeArgs(outfile: string, drop: readonly string[] = []): string[] {
  const args = BUILD_ARGS.filter((a) => !drop.includes(a));
  const at = args.indexOf("--outfile");
  if (at < 0) throw new Error("в BUILD_ARGS нет --outfile");
  args[at + 1] = outfile;
  if (args[0] === "bun") args[0] = process.execPath;
  return args;
}

export interface BuildOptions {
  readonly quiet?: boolean;
  /** Куда положить бинарь; по умолчанию dist/myc. Относительный путь — от корня репозитория. */
  readonly outfile?: string;
  /** Окружение поверх смоука. Только для теста, доказывающего, что смоук краснеет. */
  readonly smokeEnv?: Readonly<Record<string, string>>;
}

/**
 * Собрать, проверить смоуком и только потом поставить на место.
 *
 * Бинарь собирается во ВРЕМЕННЫЙ файл рядом с целью и занимает её место
 * переименованием, лишь когда смоук зелёный. Красная сборка не оставляет в
 * `dist/myc` ни отравленного артефакта, ни половины файла: на `dist/myc`
 * смотрит MCP живой сессии, и именно такой артефакт он сутки и исполнял.
 * Переименование в пределах каталога атомарно и не трогает inode, который
 * исполняет уже запущенный процесс.
 */
export async function buildBinary(opts: BuildOptions = {}): Promise<SmokeReport> {
  const outfile = resolve(ROOT, opts.outfile ?? DEFAULT_OUTFILE);
  await mkdir(dirname(outfile), { recursive: true });
  const staging = join(dirname(outfile), `.${basename(outfile)}.build-${process.pid}`);
  const io = opts.quiet === true ? "ignore" : "inherit";
  try {
    const proc = Bun.spawn(recipeArgs(staging), { cwd: ROOT, stdout: io, stderr: io });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`сборка ${outfile} провалилась (код ${exitCode})`);
    }
    // Своя SQLite (issue #1) — рядом с бинарём: скомпилированный myc ищет её
    // в своём каталоге (<execDir>/libmyc-sqlite3.dylib), модуля пакета у него
    // нет. Кладём ДО смоука, чтобы смоук мерил ту SQLite, с которой бинарь
    // будет жить. Нет библиотеки (Linux, не собрана `scripts/build-sqlite.ts`)
    // — бинарь выбирает сам: Homebrew, системную, или откажет вслух.
    const bundled = join(ROOT, "packages", "store-sqlite", "vendor", "sqlite", BUNDLED_SQLITE_FILE);
    const companion = join(dirname(outfile), BUNDLED_SQLITE_FILE);
    let placedCompanion = false;
    if (process.platform === "darwin" && existsSync(bundled)) {
      placedCompanion = !existsSync(companion);
      copyFileSync(bundled, companion);
    }
    let smoke: SmokeReport;
    try {
      smoke = await smokeBinary(staging, opts.smokeEnv);
    } catch (e) {
      // Красная сборка не оставляет рядом с целью ничего нового — и
      // библиотеку тоже, если её положила она.
      if (placedCompanion) await rm(companion, { force: true });
      throw new Error(`сборка ${outfile} красная, артефакт не заменён. ${e instanceof Error ? e.message : String(e)}`);
    }
    await rename(staging, outfile);
    return { ...smoke, binary: outfile };
  } finally {
    await rm(staging, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Пост-сборочный смоук фона
// ---------------------------------------------------------------------------

export interface SmokeReport {
  readonly binary: string;
  /** `anchor_swept_at` после первой команды (null — фон её не отметил). */
  readonly sweptBefore: number | null;
  /** `anchor_swept_at` после второй команды. */
  readonly sweptAfter: number | null;
  readonly tookMs: number;
}

interface SmokeRun {
  readonly code: number;
  readonly out: string;
}

async function smokeRun(binary: string, args: readonly string[], cwd: string, env: Record<string, string>): Promise<SmokeRun> {
  const proc = Bun.spawn([binary, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}`.trim() };
}

function sweptAt(dbPath: string, key: string): number | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM myc_meta WHERE key = ?1").get(key) as { value: string } | null;
    const n = Number(row?.value);
    return row === null || !Number.isFinite(n) ? null : n;
  } finally {
    db.close();
  }
}

/**
 * ПОСТ-СБОРОЧНЫЙ СМОУК ФОНА (memory-h5zp5mqcdbay): две команды собранным
 * бинарём на временном воркспейсе, и вторая обязана сдвинуть отметку прогона
 * якорей `myc_meta.anchor_swept_at`. Не сдвинула — бинарь не делает фона
 * после команд, и сборка красная.
 *
 * Почему этот признак. Прогон якорей стоит внутри drainAfterCommand, за теми
 * же сторожами, что absorb, embed и code_refresh: отметка двигается, только
 * если после команды фон действительно дошёл до работы. Отравленный бинарь
 * проходил все тесты — они гоняют исходники, а под `bun test` фон выключен
 * намеренно; этот признак не виден ниоткуда, кроме собранного артефакта.
 *
 * Окружение — белый список cliTestEnv: все фоновые механизмы выключены
 * реестром (новый механизм по умолчанию тоже), включены ровно дренаж и
 * якоря. NODE_ENV в нём нет: смоук, запущенный из-под `bun test`, иначе
 * передал бы бинарю NODE_ENV=test, и тот честно погасил бы фон. HOME и
 * MYC_HOME — свои: модели нет, воркер эмбеддера не поднимается, отсоединённых
 * процессов, переживающих каталог, не остаётся. MYC_ANCHOR_PERIOD_MS=0 —
 * прогон на каждом дренаже, иначе вторая команда уложилась бы в период 300 с
 * первой и отметку не тронула бы по праву.
 *
 * ЦЕНА: init и list, по одному процессу. Сразу после сборки ~0,6–1 с — первый
 * запуск свежего 76-мегабайтного файла платит за подкачку страниц и проверку
 * подписи macOS; на прогретом бинаре ~0,14 с (медиана семи).
 */
export async function smokeBinary(
  binary: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SmokeReport> {
  const t0 = performance.now();
  // Ключ — оттуда же, откуда дренаж, который его пишет: копия строки
  // разъехалась бы молча, и смоук мерил бы ключ, которого никто не ставит.
  const { ANCHOR_SWEPT_AT_KEY } = await import("../packages/cli/src/drain.ts");
  const tmp = mkdtempSync(join(tmpdir(), "myc-build-smoke-"));
  const ws = join(tmp, "ws");
  const home = join(tmp, "home");
  mkdirSync(ws);
  mkdirSync(home);
  const env = cliTestEnv({
    HOME: home,
    MYC_HOME: home,
    MYC_ACTOR: "build-smoke",
    MYC_DRAIN: "1",
    MYC_ANCHOR_CHECK: "1",
    MYC_ANCHOR_PERIOD_MS: "0",
    ...extraEnv,
  });
  const dbPath = join(ws, ".myc", "myc.db");
  const fail = (why: string): Error =>
    new Error(
      `смоук фона: ${binary}: ${why}. Бинарь не делает фона после команд — ни absorb, ни embed, ` +
        "ни прогона якорей, ни code_refresh. Первое подозрение — сторож тестового режима, " +
        "свёрнутый бандлером в константу (memory-h5zp5mqcdbay).",
    );
  try {
    const init = await smokeRun(binary, ["init"], ws, env);
    if (init.code !== 0) throw fail(`\`myc init\` вернул ${init.code}: ${init.out}`);
    const before = sweptAt(dbPath, ANCHOR_SWEPT_AT_KEY);
    const t = Date.now();
    const list = await smokeRun(binary, ["list"], ws, env);
    if (list.code !== 0) throw fail(`\`myc list\` вернул ${list.code}: ${list.out}`);
    const after = sweptAt(dbPath, ANCHOR_SWEPT_AT_KEY);
    if (after === null || after < t || (before !== null && after <= before)) {
      throw fail(`${ANCHOR_SWEPT_AT_KEY} не сдвинулся второй командой (после первой ${before ?? "нет"}, после второй ${after ?? "нет"})`);
    }
    return {
      binary,
      sweptBefore: before,
      sweptAfter: after,
      tookMs: Math.round(performance.now() - t0),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const smoke = await buildBinary();
  console.log(`built ${smoke.binary} · smoke ok: background drained (${smoke.tookMs} ms)`);
}
