/**
 * Грамматики tree-sitter — КАТАЛОГ, КЕШ И ЗАГРУЗКА ПО ТРЕБОВАНИЮ.
 *
 * ПОЧЕМУ ИХ НЕТ В ПАКЕТЕ. Все 36 грамматик `tree-sitter-wasms` весят 49 МБ
 * при пакете 12.15 МБ распакованного — вчетверо больше самого продукта ради
 * языков, которых у конкретного репозитория нет. Даже наши четыре
 * (typescript 2.23 МиБ, tsx 2.30, javascript 632 КиБ, python 465 КиБ = 5.61
 * МиБ) — это +46% к пакету за то, что python-проекту не нужно вовсе.
 * Поэтому грамматика приезжает тогда, когда встретился её язык.
 *
 * РАНТАЙМ — ДРУГОЕ ДЕЛО, И ЕГО РЕШЕНИЕ ОБРАТНОЕ. `tree-sitter.wasm`
 * (web-tree-sitter@0.24.7) весит 186 КиБ: JS-часть бандлер вшивает в
 * `dist/myc.js`, а с диска грузится ровно этот один файл. 186 КиБ — 1.5% от
 * пакета, и без него не работает НИ ОДИН язык. Такое качать по требованию
 * незачем: он кладётся в пакет (`vendor/tree-sitter/`, см.
 * `scripts/pack-npm.ts`). Цифра 4.5 МБ в постановке — это вес npm-пакета
 * целиком, вместе с `tree-sitter.js`, который на диск не попадает.
 *
 * МЕХАНИЗМ ВЗЯТ У МОДЕЛИ ЭМБЕДДИНГОВ (`packages/embed/src/fetch.ts`) и
 * повторяет его контракт слово в слово: url + sha256 + bytes в зашитом
 * каталоге, запись через `<файл>.part` с переименованием после проверки,
 * идемпотентность (целый файл не перекачивается), отдельная команда —
 * никакой сети на рабочем пути. Отдельной копией, а не общим модулем, он стал
 * не по замыслу: общее место — `@myc/core`, а границы этой задачи туда не
 * пускают. Разница между этими двумя файлами — ровно каталог ресурсов;
 * сводить их в один `@myc/core/resource.ts` надо, и об этом заведена задача.
 *
 * ЦЕЛОСТНОСТЬ ПРОВЕРЯЕТСЯ ДВАЖДЫ И ПО-РАЗНОМУ.
 *   - при загрузке и в `myc code grammars` — полный sha256 (файл читается);
 *   - на пути индексации — только размер (`statSync`), потому что этот вопрос
 *     задаётся каждым прогоном, а sha256 2.3 МБ стоит ~4 мс на язык, столько
 *     же, сколько сама загрузка грамматики. Побитый файл нужного размера
 *     громко упадёт на `Parser.Language.load` — тихой деградации тут нет
 *     (И2), а есть разделение дешёвого привратника и честной проверки,
 *     ровно как `modelManifestPath` против `checkModelPresence` у моделей.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_TREE_SITTER } from "./treesitter_pin.ts";

/**
 * Языки уровня L1. Тип живёт ЗДЕСЬ, а не в `symbols.ts`, потому что этот
 * модуль обязан грузиться без `web-tree-sitter`: его читает `myc code fetch`,
 * которому парсер не нужен, и путь индексации, который спрашивает «а есть ли
 * грамматика» до того, как решит платить за рантайм. `symbols.ts` тип
 * реэкспортирует, поэтому у потребителей ничего не меняется.
 */
export type LangId = "ts" | "tsx" | "js" | "jsx" | "py";

/** Имя грамматики в `tree-sitter-wasms` (без префикса и расширения). */
export type GrammarName = "typescript" | "tsx" | "javascript" | "python";

export interface GrammarSpec {
  readonly name: GrammarName;
  /** Имя файла на диске — одно и то же в кеше, в node_modules и в пакете. */
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Языки myc, которые обслуживает эта грамматика. */
  readonly langs: readonly LangId[];
}

/**
 * Источник байтов — jsDelivr по ЗАКРЕПЛЁННОЙ версии пакета: `@0.1.13` в
 * пути делает содержимое неизменным (npm запрещает перепубликацию версии), а
 * sha256 ниже сверен с файлами из `bun install` побайтово. Не «доверяем CDN»:
 * CDN — только транспорт, решает хеш.
 *
 * Версия берётся из `treesitter_pin.ts`, а не пишется здесь второй раз: пин
 * ABI и адрес загрузки обязаны разъезжаться только вместе, иначе `bun
 * install` даст один набор грамматик, а `myc code fetch` — другой, и
 * расхождение выстрелит на первом же файле (`getDylinkMetadata`).
 */
const WASMS_VERSION = PINNED_TREE_SITTER["tree-sitter-wasms"];

function cdnUrl(name: GrammarName): string {
  return `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@${WASMS_VERSION}/out/tree-sitter-${name}.wasm`;
}

function spec(
  name: GrammarName,
  sha256: string,
  bytes: number,
  langs: readonly LangId[],
): GrammarSpec {
  return { name, file: `tree-sitter-${name}.wasm`, url: cdnUrl(name), sha256, bytes, langs };
}

/**
 * КАТАЛОГ РОВНО ТЕХ ГРАММАТИК, КОТОРЫЕ МЫ УМЕЕМ РАЗБИРАТЬ. В
 * `tree-sitter-wasms` их 36, и соблазн перечислить все велик — но правила
 * «какой узел считать определением» есть только для этих четырёх
 * (`LANG_RULES` в `symbols.ts`). Строка каталога для go означала бы команду
 * `myc code fetch go`, которая скачает 231 КиБ и не даст ни одного символа:
 * обещание, которого мы не держим. Языки добавляются парой — правило и
 * строка каталога, — а не одной.
 */
export const GRAMMARS: Readonly<Record<GrammarName, GrammarSpec>> = {
  typescript: spec(
    "typescript",
    "8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f",
    2_342_690,
    ["ts"],
  ),
  tsx: spec(
    "tsx",
    "6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6",
    2_411_272,
    ["tsx"],
  ),
  javascript: spec(
    "javascript",
    "63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5",
    647_334,
    ["js", "jsx"],
  ),
  python: spec(
    "python",
    "9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b",
    476_105,
    ["py"],
  ),
};

/**
 * Язык -> грамматика. Считается ИЗ каталога, а не пишется рядом с ним:
 * второй список — это второе место, где можно забыть язык, и расходиться они
 * будут молча. Сторож совпадения с `L1_LANGS` — в `symbols.test.ts`.
 */
export const GRAMMAR_BY_LANG: Readonly<Record<LangId, GrammarName>> = (() => {
  const out = {} as Record<LangId, GrammarName>;
  for (const s of Object.values(GRAMMARS)) for (const l of s.langs) out[l] = s.name;
  return out;
})();

export function grammarSpecFor(lang: LangId): GrammarSpec {
  const name = GRAMMAR_BY_LANG[lang];
  if (name === undefined) throw new Error(`нет грамматики для языка "${lang}"`);
  return GRAMMARS[name];
}

// ---------------------------------------------------------------------------
// Где грамматики лежат
// ---------------------------------------------------------------------------

/**
 * Кеш загруженных грамматик: `MYC_GRAMMARS_DIR` или `~/.cache/myc/grammars`.
 * Рядом с моделями (`~/.cache/myc/models`) и по тем же правилам: кеш общий на
 * пользователя, а не на репозиторий — одна typescript-грамматика на все
 * проекты, а не по 2.3 МБ в каждом.
 */
export function grammarsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MYC_GRAMMARS_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(homedir(), ".cache", "myc", "grammars");
}

/**
 * Каталог грамматик, положенных в сам дистрибутив. Пусть его сегодня не
 * заполняет никто (в пакет кладётся только рантайм), путь существует затем,
 * чтобы сборка, решившая приложить грамматики, не требовала правок кода.
 * Считается ОТ БАНДЛА: в опубликованном пакете этот модуль вшит в
 * `dist/myc.js`, и `../vendor/...` от него ведёт внутрь пакета.
 */
function vendorDir(sub: string): string | null {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", sub);
  } catch {
    return null;
  }
}

/** Каталог `tree-sitter-wasms/out` в node_modules — путь разработчика. */
function nodeModulesGrammarDir(): string | null {
  try {
    const pkgJson = Bun.resolveSync(
      "tree-sitter-wasms/package.json",
      dirname(fileURLToPath(import.meta.url)),
    );
    return join(dirname(pkgJson), "out");
  } catch {
    return null;
  }
}

/**
 * Каталоги, где ищется .wasm грамматики, в порядке приоритета.
 *
 * `MYC_TREE_SITTER_GRAMMAR_DIR` — СПИСОК каталогов через разделитель путей
 * платформы, а не один каталог. Один перестал хватать ровно тогда, когда
 * грамматики стали приезжать по требованию: typescript может лежать в кеше, а
 * javascript — в node_modules разработчика, и одной строкой это не
 * выражается. Одиночный путь остаётся законным значением — это список из
 * одного элемента.
 *
 * Через эту же переменную главный поток передаёт путь ВОРКЕРУ пула: искать
 * заново за границей потока он не может (в бинаре у него нет node_modules).
 */
export function grammarSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = env.MYC_TREE_SITTER_GRAMMAR_DIR;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv.split(delimiter).filter((s) => s.length > 0);
  }
  const dirs: string[] = [grammarsCacheDir(env)];
  const vendor = vendorDir("tree-sitter-grammars");
  if (vendor !== null) dirs.push(vendor);
  const nm = nodeModulesGrammarDir();
  if (nm !== null) dirs.push(nm);
  return dirs;
}

/**
 * Каталоги, где ищется рантайм `tree-sitter.wasm`: явное указание,
 * `vendor/tree-sitter` в пакете, node_modules разработчика. Кеша здесь нет
 * СОЗНАТЕЛЬНО — рантайм едет в пакете и качать его нечем и незачем.
 */
export function runtimeSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = env.MYC_TREE_SITTER_DIR;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv.split(delimiter).filter((s) => s.length > 0);
  }
  const dirs: string[] = [];
  const vendor = vendorDir("tree-sitter");
  if (vendor !== null) dirs.push(vendor);
  try {
    const pkgJson = Bun.resolveSync(
      "web-tree-sitter/package.json",
      dirname(fileURLToPath(import.meta.url)),
    );
    dirs.push(dirname(pkgJson));
  } catch {
    // Пакета рядом нет — это норма для опубликованного дистрибутива.
  }
  return dirs;
}

/** Имя файла рантайма — то, что ищет `Parser.init({ locateFile })`. */
export const RUNTIME_WASM = "tree-sitter.wasm";

/**
 * Первый каталог списка, где файл лежит и имеет ожидаемый размер. null —
 * нигде. Дешёвый привратник: один `statSync` на каталог, без чтения байтов.
 */
export function findInDirs(dirs: readonly string[], file: string, bytes?: number): string | null {
  for (const dir of dirs) {
    const path = join(dir, file);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (bytes !== undefined && st.size !== bytes) continue;
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

/** Путь .wasm грамматики языка, если она на месте; иначе null. Ничего не качает. */
export function findGrammar(lang: LangId, env: NodeJS.ProcessEnv = process.env): string | null {
  const s = grammarSpecFor(lang);
  return findInDirs(grammarSearchPath(env), s.file, s.bytes);
}

/** Путь рантайма, если он на месте; иначе null. */
export function findRuntime(env: NodeJS.ProcessEnv = process.env): string | null {
  return findInDirs(runtimeSearchPath(env), RUNTIME_WASM);
}

/**
 * Языки, для которых грамматики НЕТ, — сгруппированные по грамматике: `ts` и
 * `tsx` берут разные файлы, а `js` и `jsx` один, и просить его дважды глупо.
 */
export interface MissingGrammar {
  readonly grammar: GrammarName;
  readonly langs: readonly LangId[];
  readonly bytes: number;
}

/**
 * МУТАЦИЯ ПРИЁМКИ: проверка наличия грамматики снимается — `missingGrammars`
 * отвечает «всё на месте» независимо от диска.
 *
 * Она здесь потому, что без неё тест на честный пропуск нечем отличить от
 * теста, который просто ничего не проверяет: на машине разработчика
 * грамматики лежат в node_modules ВСЕГДА, и «не хватает грамматики» надо
 * ещё суметь устроить. С мутацией индексация уходит в `loadLang` без файла,
 * падает разбором каждого файла и красит проверки пропуска — то есть
 * показывает, что они проверяют именно проверку, а не совпадение чисел.
 */
export const GRAMMAR_MUTATION_ENV = "MYC_GRAMMAR_MUTATION";

export type GrammarMutation = "none" | "assume-present";

export function grammarMutation(env: NodeJS.ProcessEnv = process.env): GrammarMutation {
  return env[GRAMMAR_MUTATION_ENV] === "assume-present" ? "assume-present" : "none";
}

export function missingGrammars(
  langs: Iterable<LangId>,
  env: NodeJS.ProcessEnv = process.env,
): MissingGrammar[] {
  if (grammarMutation(env) === "assume-present") return [];
  const dirs = grammarSearchPath(env);
  const byGrammar = new Map<GrammarName, LangId[]>();
  for (const lang of new Set(langs)) {
    const s = grammarSpecFor(lang);
    if (findInDirs(dirs, s.file, s.bytes) !== null) continue;
    const list = byGrammar.get(s.name);
    if (list === undefined) byGrammar.set(s.name, [lang]);
    else list.push(lang);
  }
  return [...byGrammar].map(([grammar, ls]) => ({
    grammar,
    langs: ls.sort(),
    bytes: GRAMMARS[grammar].bytes,
  }));
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------

export type FetchGrammarErrorCode =
  | "checksum_mismatch"
  | "network_error"
  | "http_error"
  | "fs_error"
  | "unknown_grammar";

export class FetchGrammarError extends Error {
  readonly code: FetchGrammarErrorCode;
  constructor(code: FetchGrammarErrorCode, message: string) {
    super(message);
    this.name = "FetchGrammarError";
    this.code = code;
  }
}

export interface FetchGrammarProgress {
  readonly grammar: GrammarName;
  readonly phase: "download" | "done";
  readonly loadedBytes: number;
  readonly totalBytes: number | null;
}

export interface FetchGrammarOptions {
  /** Куда класть; по умолчанию кеш пользователя. */
  readonly dir?: string;
  /** Подмена fetch (тесты). */
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (p: FetchGrammarProgress) => void;
  readonly env?: NodeJS.ProcessEnv;
}

export interface FetchGrammarResult {
  readonly grammar: GrammarName;
  readonly path: string;
  readonly bytes: number;
  /** Файл уже лежал целым — сеть не трогали. */
  readonly alreadyPresent: boolean;
  readonly tookMs: number;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Цел ли файл: размер сходится И sha256 сходится. */
async function isIntact(path: string, s: GrammarSpec): Promise<boolean> {
  try {
    if (statSync(path).size !== s.bytes) return false;
  } catch {
    return false;
  }
  try {
    return (await sha256File(path)) === s.sha256;
  } catch {
    return false;
  }
}

/**
 * Скачать грамматику с проверкой sha256. Идемпотентно: целый файл не
 * перекачивается, и повторный вызов на месте сети не касается.
 *
 * Пишется в `<файл>.part` и переименовывается ТОЛЬКО после сходящегося
 * хеша — оборванная загрузка не оставляет файла, который следующий прогон
 * примет за грамматику. То же правило, что у `manifest.json` моделей: на
 * своём месте оказывается только целое.
 */
export async function fetchGrammar(
  name: GrammarName,
  options: FetchGrammarOptions = {},
): Promise<FetchGrammarResult> {
  const t0 = performance.now();
  const s = GRAMMARS[name];
  if (s === undefined) {
    throw new FetchGrammarError(
      "unknown_grammar",
      `неизвестная грамматика "${name}"; известно: ${Object.keys(GRAMMARS).join(", ")}`,
    );
  }
  const dir = options.dir ?? grammarsCacheDir(options.env ?? process.env);
  const dest = join(dir, s.file);
  const report = options.onProgress ?? (() => {});

  if (await isIntact(dest, s)) {
    report({ grammar: name, phase: "done", loadedBytes: s.bytes, totalBytes: s.bytes });
    return {
      grammar: name,
      path: dest,
      bytes: s.bytes,
      alreadyPresent: true,
      tookMs: performance.now() - t0,
    };
  }

  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new FetchGrammarError("fs_error", `не создать ${dir}: ${String(cause)}`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(s.url);
  } catch (cause) {
    throw new FetchGrammarError(
      "network_error",
      `не удалось скачать ${s.url}: ${String(cause)}`,
    );
  }
  if (!response.ok || response.body === null) {
    throw new FetchGrammarError("http_error", `${s.url}: HTTP ${response.status} без тела`);
  }

  const total = Number(response.headers.get("content-length") ?? "0") || null;
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    hash.update(value);
    loaded += value.byteLength;
    report({ grammar: name, phase: "download", loadedBytes: loaded, totalBytes: total });
  }
  const digest = hash.digest("hex");
  if (digest !== s.sha256) {
    throw new FetchGrammarError(
      "checksum_mismatch",
      `sha256 не сошёлся для ${s.file}: ожидалось ${s.sha256}, получено ${digest}`,
    );
  }

  const part = `${dest}.part`;
  try {
    await writeFile(part, Buffer.concat(chunks.map((c) => Buffer.from(c))));
    await rename(part, dest);
  } catch (cause) {
    await rm(part, { force: true }).catch(() => {});
    throw new FetchGrammarError("fs_error", `не записать ${dest}: ${String(cause)}`);
  }
  report({ grammar: name, phase: "done", loadedBytes: s.bytes, totalBytes: s.bytes });
  return {
    grammar: name,
    path: dest,
    bytes: s.bytes,
    alreadyPresent: false,
    tookMs: performance.now() - t0,
  };
}

/** Состояние грамматики на диске — для `myc code grammars`. */
export type GrammarStatus = "present" | "corrupt" | "absent";

export interface GrammarState {
  readonly grammar: GrammarName;
  readonly langs: readonly LangId[];
  readonly status: GrammarStatus;
  readonly bytes: number;
  readonly path: string | null;
}

/**
 * Полная (с чтением байтов) проверка каталога. `corrupt` отличается от
 * `absent` намеренно: побитый файл — это деградация, и показывать её как «не
 * скачано» значит врать про причину, по которой потом упадёт загрузка.
 */
export async function grammarStates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GrammarState[]> {
  const dirs = grammarSearchPath(env);
  const out: GrammarState[] = [];
  for (const s of Object.values(GRAMMARS)) {
    let path: string | null = null;
    for (const dir of dirs) {
      const p = join(dir, s.file);
      if (existsSync(p)) {
        path = p;
        break;
      }
    }
    const status: GrammarStatus =
      path === null ? "absent" : (await isIntact(path, s)) ? "present" : "corrupt";
    out.push({ grammar: s.name, langs: s.langs, status, bytes: s.bytes, path });
  }
  return out;
}

/** Человеку: «2.3 МБ». Один формат на весь код-интеллект. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
