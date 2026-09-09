#!/usr/bin/env bun
/**
 * Сборка публикуемого npm-пакета @aistastudio/myc и упаковка его в тарбол.
 *
 * ИМЯ. Область `@myc` в npm НЕДОСТУПНА: организация `myc` там уже существует
 * и владеет пакетом `reactive-gen` (проверка: GET /-/org/myc/package отдаёт
 * `{"reactive-gen":"write"}`). Ответ 404 на `@myc/core` означал лишь
 * отсутствие такого ПАКЕТА, а не свободу области — на этом легко ошибиться.
 * Незанятые имена: `myc`, `myc-cli`, `mycelium-cli` — все заняты; свободна
 * собственная область владельца, `@aistastudio/*`.
 *
 * Внутренние пакеты остаются `@myc/*` и НЕ публикуются: они вшиты в бандл,
 * поэтому переименовывать их не нужно.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ КАТАЛОГ, А НЕ `npm pack packages/cli`.
 * У packages/cli/package.json две несовместимые роли: внутри воркспейса он
 * указывает на исходники (`exports: ./src/index.ts`, зависимости
 * `workspace:*` — так его видит @myc/mcp), а в реестре обязан указывать на
 * бандл и не иметь ни одной workspace-ссылки. Совместить их в одном файле
 * нельзя без publishConfig-трюков, которые молча расходятся с реальностью.
 * Поэтому манифест пакета ГЕНЕРИРУЕТСЯ здесь, а в тарбол попадает ровно то,
 * что этот скрипт положил: тесты, стенды, bench, .myc и отчёты физически не
 * могут туда просочиться — их никто не копирует.
 *
 * ЧТО КЛАДЁТСЯ В ПАКЕТ
 *   bin/myc.js        — запуск + отказ под Node (packages/cli/bin/myc.js)
 *   bin/preflight.js  — postinstall: сказать про Bun, если его нет
 *   dist/myc.js       — весь myc одним бандлом (все @myc/* внутри)
 *   dist/worker.ts    — воркер батч-пула эмбеддера, см. ниже
 *   vendor/ort/       — .wasm ONNX-рантайма, см. ниже
 *   vendor/tree-sitter/ — tree-sitter.wasm, рантайм разбора, см. ниже
 *
 * ПРО dist/worker.ts. packages/embed/src/pool.ts поднимает воркер как
 * `new Worker(new URL("./worker.ts", import.meta.url))`. Бандлер Bun такую
 * ссылку не разрешает (проверено: ни в переменной, ни инлайном отдельного
 * чанка не появляется), поэтому воркер собирается ВТОРЫМ входом и кладётся
 * рядом с бандлом под тем именем, которое ищет рантайм. Расширение .ts на
 * содержимом-JS законно: Bun разбирает такой файл как TypeScript, а JS —
 * его подмножество. Альтернатива — правка pool.ts под нужды упаковщика.
 *
 * ПРО vendor/ort. JS-часть onnxruntime-web бандлер вшивает в dist/myc.js, но
 * .wasm грузится с диска: ort.ts берёт каталог из MYC_ORT_WASM_DIR, иначе
 * резолвит пакет onnxruntime-web в node_modules. Тянуть onnxruntime-web
 * зависимостью ради двух файлов — это ~180 МБ распакованными на каждую
 * установку. Кладём ровно те два файла (~11 МБ), а bin/myc.js выставляет
 * MYC_ORT_WASM_DIR на них. Лицензия onnxruntime — MIT, копируем рядом.
 *
 * ПРО vendor/tree-sitter. Та же развилка, что у ort, и решена так же, но
 * ЧИСЛА здесь другие и они решают дело. JS-часть web-tree-sitter (161 КиБ)
 * бандлер вшивает в dist/myc.js; с диска грузится ровно один файл —
 * tree-sitter.wasm, 186 КиБ. Это 1.5% пакета за то, без чего не работает НИ
 * ОДИН язык, — качать по требованию тут нечего. (В постановке фигурировало
 * 4.5 МБ: это вес npm-пакета web-tree-sitter целиком, с исходниками и
 * .d.ts, которые на диск не попадают.)
 *
 * ГРАММАТИКИ, В ОТЛИЧИЕ ОТ РАНТАЙМА, СЮДА НЕ КЛАДУТСЯ. Все 36 весят 49 МБ
 * при пакете 12 МБ; даже наши четыре — 5.6 МБ, то есть +46% ради языков,
 * которых у конкретного репозитория нет. Они приезжают по требованию:
 * `myc code fetch`, кеш ~/.cache/myc/grammars, sha256 из зашитого каталога
 * (packages/code-intel/src/grammars.ts).
 *
 * Каталог ищется ОТ БАНДЛА (dist/myc.js -> ../vendor/tree-sitter), а не
 * выставляется переменной из bin/myc.js, как у ort: у ort выбора нет —
 * onnxruntime-web вообще не зависимость пакета, — а здесь обе стороны наши,
 * и знание «где лежит мой .wasm» честнее держать рядом с кодом, который его
 * грузит, чем в пусковом скрипте, который придётся держать в согласии.
 */

import { mkdir, rm, cp, writeFile, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PARSE_WORKER_SOURCE } from "../packages/code-intel/src/parse_worker_entry.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist/npm");

/** Файлы дистрибутива onnxruntime-web, без которых wasm-бэкенд не поднимется. */
const ORT_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];

/** Рантайм tree-sitter: единственный его файл, который грузится с диска. */
const TREE_SITTER_WASM = "tree-sitter.wasm";

async function build(entry: string, outfile: string, minify: boolean): Promise<void> {
  const args = [
    "bun",
    "build",
    "--target=bun",
    ...(minify ? ["--minify"] : []),
    join(ROOT, entry),
    "--outfile",
    outfile,
  ];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "inherit", cwd: ROOT });
  if ((await proc.exited) !== 0) throw new Error(`bun build провалился: ${entry}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * SPDX-идентификатор по тексту лицензии. Узнаём только то, что можем узнать
 * НАДЁЖНО, по характерным строкам самих текстов; всё остальное — отказ с
 * просьбой указать идентификатор явно. Угадывать лицензию нельзя: ошибка
 * здесь — это неверное заявление о правах, а не косметика.
 */
function detectLicense(text: string): string | undefined {
  const t = text.toLowerCase();
  const explicit = /^\s*license:\s*([a-z0-9.\-+]+)\s*$/im.exec(text);
  if (explicit !== null) return explicit[1];
  if (t.includes("apache license") && t.includes("version 2.0")) return "Apache-2.0";
  if (t.includes("permission is hereby granted, free of charge")) return "MIT";
  if (t.includes("gnu general public license") && t.includes("version 3")) return "GPL-3.0-only";
  if (t.includes("mozilla public license") && t.includes("2.0")) return "MPL-2.0";
  if (t.includes("business source license")) return "BUSL-1.1";
  if (t.includes("redistribution and use in source and binary forms")) {
    return t.includes("neither the name") ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  return undefined;
}

async function main(): Promise<void> {
  const cliPkg = JSON.parse(
    await readFile(join(ROOT, "packages/cli/package.json"), "utf8"),
  ) as { version: string };
  const version = cliPkg.version;

  // Версия живёт в двух местах — в манифесте и в CLI_VERSION, который печатает
  // `myc --version`. Разошлись — пакет врёт о себе; ловим на сборке, а не в
  // отчёте пользователя.
  const indexTs = await readFile(join(ROOT, "packages/cli/src/index.ts"), "utf8");
  const m = /export const CLI_VERSION = "([^"]+)"/.exec(indexTs);
  if (m === null) throw new Error("не нашёл CLI_VERSION в packages/cli/src/index.ts");
  if (m[1] !== version) {
    throw new Error(
      `версии разошлись: package.json ${version}, CLI_VERSION ${m[1]}. ` +
        "Правьте оба места.",
    );
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "dist"), { recursive: true });
  await mkdir(join(OUT, "bin"), { recursive: true });
  await mkdir(join(OUT, "vendor/ort"), { recursive: true });
  await mkdir(join(OUT, "vendor/tree-sitter"), { recursive: true });

  await build("packages/cli/src/main.ts", join(OUT, "dist/myc.js"), true);
  await build("packages/embed/src/worker.ts", join(OUT, "dist/worker.ts"), true);
  // Воркер РАЗБОРА — по той же причине и тем же способом, что воркер эмбеддера
  // (см. «ПРО dist/worker.ts» в шапке). Без него `myc code index` из пакета
  // падал: `parseWorkerEntry` резолвит `./code_index_worker.ts` рядом с
  // бандлом, а класть его туда было некому — ModuleNotFound на первом батче.
  // Имя берётся из `parse_worker_entry.ts`, одного на сборку и рантайм.
  await build(PARSE_WORKER_SOURCE, join(OUT, "dist", basename(PARSE_WORKER_SOURCE)), true);

  for (const f of ["myc.js", "preflight.js"]) {
    await cp(join(ROOT, "packages/cli/bin", f), join(OUT, "bin", f));
  }

  const ortDist = join(ROOT, "packages/embed/node_modules/onnxruntime-web/dist");
  for (const f of ORT_FILES) {
    const src = join(ortDist, f);
    if (!(await exists(src))) {
      throw new Error(`нет ${src}: сначала bun install (нужен onnxruntime-web)`);
    }
    await cp(src, join(OUT, "vendor/ort", f));
  }
  await writeFile(
    join(OUT, "vendor/ort/README-onnxruntime.txt"),
    [
      "Файлы ort-wasm-simd-threaded.{wasm,mjs} взяты из пакета onnxruntime-web",
      "(Microsoft, лицензия MIT) и распространяются без изменений.",
      "Исходный проект: https://github.com/microsoft/onnxruntime",
      "",
    ].join("\n"),
  );

  // Рантайм tree-sitter. Ищется РЕЗОЛВЕРОМ от пакета, который объявил
  // зависимость (@myc/code-intel), а не жёстким путём в его node_modules:
  // Bun поднимает часть зависимостей воркспейса наверх, и от раскладки к
  // раскладке файл лежит то там, то там. Резолвер обходит оба случая; жёсткий
  // путь ломался бы от одного `bun install` — молча, оставив пакет без
  // рантайма и вернув `myc code index` ровно в то состояние, ради выхода из
  // которого всё это писалось.
  const tsPkg = Bun.resolveSync("web-tree-sitter/package.json", join(ROOT, "packages/code-intel"));
  const tsWasm = join(dirname(tsPkg), TREE_SITTER_WASM);
  if (!(await exists(tsWasm))) {
    throw new Error(`нет ${tsWasm}: сначала bun install (нужен web-tree-sitter)`);
  }
  await cp(tsWasm, join(OUT, "vendor/tree-sitter", TREE_SITTER_WASM));
  await writeFile(
    join(OUT, "vendor/tree-sitter/README-tree-sitter.txt"),
    [
      "tree-sitter.wasm взят из пакета web-tree-sitter (лицензия MIT) без изменений.",
      "Исходный проект: https://github.com/tree-sitter/tree-sitter",
      "",
      "Грамматики языков в пакет НЕ входят (все 36 весят 49 МБ) и качаются по",
      "требованию: `myc code fetch`. Состояние: `myc code grammars`.",
      "",
    ].join("\n"),
  );

  // README пишет другой агент; если он есть — кладём, нет — пакет соберётся,
  // но npm покажет пустую страницу.
  for (const f of ["README.md", "LICENSE"]) {
    if (await exists(join(ROOT, f))) await cp(join(ROOT, f), join(OUT, f));
  }

  const manifest = {
    name: "@aistastudio/myc",
    version,
    description:
      "Local, fast task-and-memory layer for coding agents: task queue, oplog of decisions, hybrid search. Requires Bun.",
    type: "module",
    bin: { myc: "bin/myc.js" },
    scripts: { postinstall: "node bin/preflight.js" },
    engines: { bun: ">=1.3.0" },
    // Единственная рантайм-зависимость: расширение vec0 для векторного
    // индекса (162 КБ на платформу, ставится по os/cpu). Всё остальное —
    // включая JS-часть onnxruntime-web — вшито в бандл.
    dependencies: { "sqlite-vec": "0.1.9" },
    // Node в списке нет СОЗНАТЕЛЬНО: myc работает только на Bun (bun:sqlite),
    // и bin/myc.js отказывает под Node с объяснением.
    // Ссылки на репозиторий: без них страница пакета в npm не связана с
    // исходниками, и «откуда это взялось» приходится искать поиском.
    repository: { type: "git", url: "git+https://github.com/aistastudio/myc.git" },
    homepage: "https://github.com/aistastudio/myc#readme",
    bugs: { url: "https://github.com/aistastudio/myc/issues" },
    keywords: ["memory", "agents", "tasks", "cli", "bun", "sqlite", "rag"],
    files: ["bin", "dist", "vendor", "README.md", "LICENSE"],
    publishConfig: { access: "public" },
  } as Record<string, unknown>;
  // Идентификатор лицензии ЧИТАЕТСЯ из файла, а не назначается. Раньше здесь
  // стояло `manifest["license"] = "MIT"` при одном лишь наличии файла: положи
  // владелец Apache-2.0 — npm объявил бы MIT, и страница пакета врала бы о
  // правах. Это ровно тот класс ошибки, который дороже отсутствия поля.
  if (await exists(join(ROOT, "LICENSE"))) {
    const text = await readFile(join(ROOT, "LICENSE"), "utf8");
    const spdx = detectLicense(text);
    if (spdx === undefined) {
      throw new Error(
        "LICENSE есть, но какая именно — не распознано. Укажите SPDX-идентификатор " +
          'полем "license" в корневом package.json (например "MIT" или "Apache-2.0").',
      );
    }
    manifest["license"] = spdx;
  }

  await writeFile(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const proc = Bun.spawn(["npm", "pack", "--json", "--pack-destination", join(ROOT, "dist")], {
    cwd: OUT,
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("npm pack провалился");
  const info = JSON.parse(out) as Array<{
    filename: string;
    size: number;
    unpackedSize: number;
    entryCount: number;
  }>;
  const t = info[0];
  if (t === undefined) throw new Error("npm pack ничего не вернул");
  console.log(`тарбол   ${join(ROOT, "dist", t.filename)}`);
  console.log(`сжатый   ${(t.size / 1_048_576).toFixed(2)} МБ`);
  console.log(`распакованный ${(t.unpackedSize / 1_048_576).toFixed(2)} МБ`);
  console.log(`файлов   ${t.entryCount}`);
  if (!(await exists(join(ROOT, "LICENSE")))) {
    console.log("");
    console.log("ВНИМАНИЕ: в корне нет LICENSE — публиковать так нельзя.");
  }
}

await main();
