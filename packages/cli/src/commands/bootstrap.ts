/**
 * `myc bootstrap` — обязательный контекст запуска агента (myc-ye3.5).
 *
 * Это НЕ `myc prime`. `prime` отвечает «что мы уже знаем про проект» и
 * целиком выводится из памяти; `bootstrap` отвечает «как здесь работать» и
 * из памяти не выводится вовсе: на пустом воркспейсе он обязан выдать
 * осмысленный блок, иначе первый же агент в новом репозитории не знает ни
 * команд myc, ни того, какие MCP-серверы и скилы ему доступны.
 *
 * Три источника, в порядке приоритета (решение S41, ARCHITECTURE.md §10):
 *   1. Автодетект — дёшево и при каждом вызове: MCP-серверы, скилы, graft,
 *      уложенные модели, текущие деградации. Кешируется по отпечатку
 *      окружения (см. environmentFingerprint) — пересчёт только при смене.
 *   2. Ручные блоки — `myc bootstrap set <ключ> <текст>`. Хранятся узлами
 *      kind=note слоя L3 с attrs.topic='bootstrap': тот же слой и тот же
 *      частичный индекс ix_nodes_prime, что читает prime, поэтому блок
 *      переживает сжатие контекста и синхронизируется как обычная память.
 *   3. Наследование ярусов — личный ярус `~/.myc` даёт общие правила,
 *      проектный дополняет. Сам ярус — из myc-ye3.6 (`openPersonalStore`);
 *      здесь только чтение через `BootstrapDeps.personalBlocks` и запись
 *      явным `--global`, своего второго яруса не заводится. Наследование
 *      разрешается СЛИЯНИЕМ ПО КЛЮЧУ, а не порядком печати: проектный блок
 *      с тем же ключом вытесняет личный.
 *
 * ИСТОЧНИК КАЖДОГО БЛОКА ВИДЕН В ВЫВОДЕ — `[auto:<ключ>]` против
 * `[manual:<ключ>]`. Без этого через месяц никто не поймёт, почему агенту
 * говорят то, чего никто не писал.
 *
 * Формат плотный: его читает модель, а не человек. Вывод целиком (шапка,
 * блоки, строка обрезки, подвал) укладывается в `--budget` символов;
 * обязательный контекст, который не влезает в окно, бесполезен.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { JsonValue, NodeRecord, QueryDef } from "@myc/core";
import { probeGraftPresence } from "@myc/code-intel";
import { liveStatusPredicate, notPendingPredicate } from "@myc/retrieval/review";
import { ExitCode } from "../exit.ts";
import { CLI_VERSION } from "../index.ts";
import { defaultRegistry } from "../registry.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import type { FlagSpec } from "../flags.ts";
import {
  findMycDir,
  graphFailure,
  openPersonalStore,
  parseWorkspaceToml,
  personalHome,
  personalWorkspaceStatus,
  realStoreDeps,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Модель блока
// ---------------------------------------------------------------------------

/** Версия формата вывода. Входит в отпечаток: правка рендера рвёт старый кеш. */
export const BOOTSTRAP_FORMAT_VERSION = 1;

/**
 * Версия ФАЙЛА кеша автодетекта (`bootstrap.cache.json`, поле `v`). Отдельно
 * от версии формата вывода: вывод не менялся, а менялось то, по чему кешу
 * можно верить.
 *
 * 2 — в отпечаток вошла сборка myc (memory-bn4cs836df52). В 0.3.0 её там не
 * было: отпечаток складывался только из файлов окружения, PATH и списка
 * команд, и блоки, посчитанные старой логикой зондов, переживали обновление
 * бинаря — у пользователя с graft в PATH закешированный `[auto:graft]` без
 * индекса продолжал бы звать агента к инструменту, который ничего не находит.
 * Файл версии 1 целиком считается промахом, какой бы отпечаток в нём ни лежал:
 * так старый кеш не отдаётся даже сборке, собранной из исходников без смены
 * CLI_VERSION.
 *
 * 3 — тексты зондов переведены на английский без смены CLI_VERSION: блоки,
 * посчитанные версией 2, говорили бы агенту по-русски до следующего релиза.
 */
export const BOOTSTRAP_CACHE_VERSION = 3;

/** Слой ручных блоков. L3 — то, что prime отдаёт каждой сессии (§2.3). */
export const BOOTSTRAP_LAYER = 3;

/** Признак ручного блока в attrs; ложится в generated-колонку g_topic. */
export const BOOTSTRAP_TOPIC = "bootstrap";

export const DEFAULT_BUDGET = 2000;
/** Ниже этого бюджета не влезает даже шапка с подвалом — честнее отказать. */
export const MIN_BUDGET = 200;

/** Верхняя граница подвала; на неё резервируется место при сборке тела. */
const FOOTER_MAX = 80;
/** Верхняя граница строки обрезки; резервируется, как только обрезка нужна. */
const CUT_MAX = 120;
/** Короче этого обрезок блока бесполезен — блок выбрасывается целиком. */
const MIN_CLIP = 48;

export type BlockSource = "auto" | "manual";
export type BlockTier = "project" | "personal";

export interface BootstrapBlock {
  readonly key: string;
  readonly source: BlockSource;
  readonly tier: BlockTier;
  readonly text: string;
}

/**
 * Порядок блоков — он же порядок выживания при нехватке бюджета: режется
 * хвост, никогда не середина.
 *
 * `myc` первым: без него агент не знает даже, чем сейчас пользуется.
 * Ручные блоки выше автодетекта, потому что автодетект агент способен
 * пересобрать сам (он смотрит на те же файлы), а написанное человеком
 * правило — нет.
 *
 * Проектный ярус выше личного НЕ по семантике наследования (она разрешена
 * раньше, слиянием по ключу: проектный блок вытесняет одноимённый личный),
 * а по бюджету: специфичное для этого репозитория обязано пережить обрезку.
 */
const RANK: Readonly<Record<string, number>> = {
  "auto:myc": 10,
  "auto:degraded": 20,
  "manual:project": 30,
  "manual:personal": 35,
  "auto:graft": 40,
  "auto:mcp": 50,
  "auto:skills": 60,
  "auto:models": 70,
  "auto:tiers": 80,
};

function rankOf(block: BootstrapBlock): number {
  if (block.source === "manual") return RANK[`manual:${block.tier}`] ?? 39;
  return RANK[`auto:${block.key}`] ?? 90;
}

/**
 * Слияние ярусов (S41): проектный блок вытесняет одноимённый личный —
 * «личный даёт общие правила, проектный дополняет». Затем сортировка по
 * рангу, внутри ранга по ключу, чтобы вывод не плясал между вызовами.
 */
export function mergeBlocks(blocks: readonly BootstrapBlock[]): BootstrapBlock[] {
  const byKey = new Map<string, BootstrapBlock>();
  for (const b of blocks) {
    const id = `${b.source}:${b.key}`;
    const prev = byKey.get(id);
    if (prev === undefined || (prev.tier === "personal" && b.tier === "project")) {
      byKey.set(id, b);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => rankOf(a) - rankOf(b) || a.key.localeCompare(b.key),
  );
}

// ---------------------------------------------------------------------------
// Рендер с бюджетом
// ---------------------------------------------------------------------------

export interface RenderStats {
  readonly tookMs: number;
  readonly cache: "hit" | "miss" | "off";
}

export interface RenderInput {
  readonly blocks: readonly BootstrapBlock[];
  readonly budget: number;
  readonly ws: string;
  readonly fp: string;
  readonly stats: RenderStats;
}

export interface RenderResult {
  readonly text: string;
  /** Символов в теле: шапка + блоки + строка обрезки, без подвала. */
  readonly bodyChars: number;
  /** Символов всего, вместе с подвалом. Гарантированно <= budget. */
  readonly chars: number;
  readonly budget: number;
  readonly truncated: boolean;
  readonly dropped: readonly string[];
  readonly clipped: readonly string[];
}

/** `[manual:style@personal] текст`, продолжение — отступ в два пробела. */
export function renderBlock(block: BootstrapBlock): string {
  const tier = block.tier === "personal" ? "@personal" : "";
  const tag = `[${block.source}:${block.key}${tier}]`;
  const lines = block.text.split("\n");
  const head = `${tag} ${lines[0] ?? ""}`.trimEnd();
  if (lines.length === 1) return head;
  return [head, ...lines.slice(1).map((l) => `  ${l}`.trimEnd())].join("\n");
}

interface Fill {
  readonly parts: string[];
  readonly used: number;
  readonly dropped: string[];
  readonly clipped: string[];
}

/** Один проход набора блоков под предел `limit` символов тела. */
function fillBody(header: string, blocks: readonly BootstrapBlock[], limit: number): Fill {
  const parts: string[] = [header];
  let used = header.length;
  const dropped: string[] = [];
  const clipped: string[] = [];
  let cutting = false;

  for (const block of blocks) {
    const text = renderBlock(block);
    if (cutting) {
      dropped.push(block.key);
      continue;
    }
    // +1 — перевод строки перед блоком.
    if (used + 1 + text.length <= limit) {
      parts.push(text);
      used += 1 + text.length;
      continue;
    }
    const space = limit - used - 2; // место под текст и многоточие
    if (space >= MIN_CLIP) {
      const cut = `${text.slice(0, space)}…`;
      parts.push(cut);
      used += 1 + cut.length;
      clipped.push(block.key);
    } else {
      dropped.push(block.key);
    }
    cutting = true;
  }
  return { parts, used, dropped, clipped };
}

/**
 * Строка обрезки. Ключи — главное в ней, но если они не влезают, лучше
 * честные числа, чем ключ, разрезанный посередине.
 */
function cutLine(fill: Fill, budget: number, max: number): string {
  const bits: string[] = [];
  if (fill.dropped.length > 0) {
    bits.push(`dropped ${fill.dropped.length}(${fill.dropped.join(",")})`);
  }
  if (fill.clipped.length > 0) {
    bits.push(`clipped ${fill.clipped.length}(${fill.clipped.join(",")})`);
  }
  const long = `# CUT ${bits.join(" ")} · budget ${budget}`;
  if (long.length <= max) return long;
  const short = `# CUT dropped ${fill.dropped.length} clipped ${fill.clipped.length} · budget ${budget}`;
  if (short.length <= max) return short;
  return short.slice(0, Math.max(0, max));
}

/**
 * Сборка вывода под бюджет. Обрезка предсказуема и объявлена: блоки идут
 * фиксированным порядком, режется ХВОСТ, первый не влезший блок обрезается
 * по символам (если остаётся хоть {@link MIN_CLIP}), всё следующее
 * выбрасывается целиком, а строка `# CUT …` называет ключи — молча
 * урезанный обязательный контекст хуже отсутствующего.
 *
 * Подвал считается после тела и потому не может ссылаться на собственную
 * длину: под него резервируется {@link FOOTER_MAX}, а число в нём — длина
 * тела, величина самодостаточная. Это дешевле итеративной сходимости и
 * даёт жёсткую верхнюю границу на весь вывод.
 */
export function renderBootstrap(input: RenderInput): RenderResult {
  const blocks = mergeBlocks(input.blocks);
  const auto = blocks.filter((b) => b.source === "auto").length;
  const manual = blocks.length - auto;
  const header =
    `# MYC BOOTSTRAP v${BOOTSTRAP_FORMAT_VERSION} · ws=${input.ws}` +
    ` · auto ${auto} · manual ${manual} · fp ${input.fp}`;

  // -2: перевод строки перед подвалом и перевод строки в конце вывода.
  const room = input.budget - FOOTER_MAX - 2;

  // Первый проход показывает, нужна ли строка обрезки. Она обязана влезть —
  // молча урезанный обязательный контекст хуже отсутствующего, — а её длина
  // зависит от того, что выброшено, то есть от неё самой. Итерируем до
  // неподвижной точки: меньше места ⇒ выброшенных ключей только больше,
  // набор конечен, поэтому сходимость не позже числа блоков (на практике —
  // второй проход).
  let fill = fillBody(header, blocks, room);
  if (fill.dropped.length > 0 || fill.clipped.length > 0) {
    const sets = (f: Fill): string => `${f.dropped.join(",")}|${f.clipped.join(",")}`;
    for (let pass = 0; pass <= blocks.length; pass++) {
      const reserve = Math.min(CUT_MAX, cutLine(fill, input.budget, CUT_MAX).length);
      const next = fillBody(header, blocks, room - 1 - reserve);
      const stable = sets(next) === sets(fill);
      fill = next;
      if (stable) break;
    }
    const cut = cutLine(fill, input.budget, room - fill.used - 1);
    if (cut.length > 0) fill.parts.push(cut);
  }
  const dropped = fill.dropped;
  const clipped = fill.clipped;

  let body = fill.parts.join("\n");
  if (body.length > room) body = body.slice(0, Math.max(0, room));
  let footer =
    `# ${body.length} body chars / ${input.budget} budget` +
    ` · ${input.stats.tookMs} ms · cache ${input.stats.cache}`;
  if (footer.length > FOOTER_MAX) footer = footer.slice(0, FOOTER_MAX);
  const text = `${body}\n${footer}\n`;
  return {
    text,
    bodyChars: body.length,
    chars: text.length,
    budget: input.budget,
    truncated: dropped.length > 0 || clipped.length > 0,
    dropped,
    clipped,
  };
}

// ---------------------------------------------------------------------------
// Отпечаток окружения
// ---------------------------------------------------------------------------

/**
 * FNV-1a в двух 32-битных дорожках. Это детектор изменения, а не
 * криптографический хеш: sha256 через node:crypto стоил бы импорта и
 * лишних микросекунд, а на входе полторы сотни символов и нужен только
 * ответ «то же самое или нет».
 */
export function fingerprint(parts: readonly string[]): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const s = parts.join("");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

type ProbeInputKind = "file" | "dir";

interface ProbeInput {
  readonly kind: ProbeInputKind;
  readonly path: string;
}

/**
 * Из чего складывается отпечаток и почему именно из этого.
 *
 * - Версия формата: правка рендера или набора зондов обязана обесценить
 *   кеш, иначе на диске останется вывод по старым правилам.
 * - Файлы, которые зонды РАЗБИРАЮТ (`.mcp.json`, `opencode.json`) — по
 *   `mtime+size`: содержимое поменялось, значит поменялся и отпечаток.
 *   Хеш содержимого был бы точнее, но это чтение файлов ради проверки
 *   кеша, то есть ровно та работа, которую кеш и экономит.
 * - Каталоги, из которых зонды берут только СПИСОК имён (`.claude/skills`,
 *   `graft/`, каталог моделей) — по `mtime` каталога. Он меняется при
 *   добавлении и удалении записи, то есть ровно тогда, когда меняется
 *   список; правка файла ВНУТРИ скила его не трогает — и правильно, мы
 *   этот файл не читаем.
 * - `PATH` — от него зависит `which("graft")`; пишем сам PATH, а не
 *   результат поиска, чтобы не платить за поиск при проверке кеша.
 * - Список команд CLI — меняется при подключении новой команды, без правки
 *   этого файла и без правки версии формата.
 * - Сборка myc (`CLI_VERSION`) — зонды меняют логику от релиза к релизу, а
 *   окружение при обновлении остаётся тем же. Без версии в отпечатке блок,
 *   посчитанный прошлым релизом, отдавался бы новым как свой (так и было в
 *   0.3.0: memory-bn4cs836df52). Релиз рвёт кеш сам; поднимать
 *   `BOOTSTRAP_CACHE_VERSION` руками нужно только правке зондов, которая
 *   уходит к пользователю без смены `CLI_VERSION`.
 * - Отсутствующий путь кодируется как `-`: появление и исчезновение файла
 *   меняют отпечаток так же, как правка.
 *
 * Чего в отпечатке НЕТ намеренно: содержимого базы. Ручные блоки читаются
 * из графа при каждом вызове и через кеш не проходят вовсе.
 */
export function environmentFingerprint(
  inputs: readonly ProbeInput[],
  extra: readonly string[],
): string {
  const parts: string[] = [`v${BOOTSTRAP_FORMAT_VERSION}`];
  for (const input of inputs) {
    const tag = input.kind === "file" ? "f" : "d";
    try {
      const st = statSync(input.path);
      parts.push(
        input.kind === "file"
          ? `${tag}:${input.path}:${st.mtimeMs}:${st.size}`
          : `${tag}:${input.path}:${st.mtimeMs}`,
      );
    } catch {
      parts.push(`${tag}:${input.path}:-`);
    }
  }
  parts.push(...extra);
  return fingerprint(parts);
}

// ---------------------------------------------------------------------------
// Автодетект
// ---------------------------------------------------------------------------

export interface ProbeEnv {
  readonly home: string;
  /** Родитель личного яруса `~/.myc` (S41); отделён от `home`, потому что
   *  MYC_HOME переносит только воркспейс, а не каталог скилов. */
  readonly mycHome: string;
  /** Каталог уложенных моделей эмбеддинга. */
  readonly modelsDir: string;
  readonly path: string;
  which(cmd: string): string | null;
}

function defaultModelsDirCopy(home: string): string {
  const fromEnv = process.env.MYC_MODELS_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(home, ".cache", "myc", "models");
}

export const realProbeEnv: ProbeEnv = {
  home: homedir(),
  mycHome: personalHome(),
  // Дубль defaultModelsDir() из @myc/embed сознательный: тянуть весь пакет
  // ради одного пути значит грузить рантайм эмбеддингов в горячий путь
  // запуска сессии. Расхождение ловит тест в bootstrap.test.ts.
  modelsDir: defaultModelsDirCopy(homedir()),
  path: process.env.PATH ?? "",
  which: (cmd) => {
    try {
      return Bun.which(cmd);
    } catch {
      return null;
    }
  },
};

function probeInputs(dir: string, env: ProbeEnv): ProbeInput[] {
  const inputs: ProbeInput[] = [
    { kind: "file", path: join(dir, ".mcp.json") },
    { kind: "file", path: join(dir, "opencode.json") },
    { kind: "dir", path: join(dir, ".claude", "skills") },
    { kind: "dir", path: join(env.home, ".claude", "skills") },
    { kind: "dir", path: join(dir, ".orca", "skills") },
    { kind: "dir", path: join(env.home, ".orca", "skills") },
    { kind: "dir", path: join(dir, "graft") },
    { kind: "dir", path: env.modelsDir },
  ];
  // Каталоги моделей поимённо: mtime `models/` меняется только при
  // появлении и пропаже самих каталогов, а нас интересует ещё и manifest.json
  // ВНУТРИ каждого — без этого дозакачанная модель осталась бы в кеше
  // помеченной как неполная.
  for (const id of dirNames(env.modelsDir, 32)) {
    inputs.push({ kind: "dir", path: join(env.modelsDir, id) });
  }
  return inputs;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function dirNames(path: string, limit = 200): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** `1 server`, `2 servers`. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Признак уложенной модели в тексте блока `models`: его ставит probeModels и
 * по нему же печать решает, есть ли деградация `embed.model_absent`.
 */
const MODELS_READY = "with manifest:";

/** Плотный список: не больше `max` имён, остальное числом. */
function names(list: readonly string[], max: number): string {
  if (list.length <= max) return list.join(",");
  return `${list.slice(0, max).join(",")},+${list.length - max}`;
}

function autoBlock(key: string, text: string): BootstrapBlock {
  return { key, source: "auto", tier: "project", text };
}

/** Как пользоваться myc: команды берутся из реестра, а не из комментария. */
function probeMyc(commands: readonly string[]): BootstrapBlock {
  return autoBlock(
    "myc",
    [
      "project memory and tasks; flags: --json|--ndjson|--strict|-C <dir>|--db <path>",
      `cmds: ${commands.join(",")}`,
      "exit 0=ok 1=err 2=usage 3=notfound 4=conflict 5=precond 6=degraded 7=no-ws 8=denied 9=timeout",
      "loop: myc ready --claim -> myc show <id> -> myc close <id>",
      'a launch rule autodetect cannot see: myc bootstrap set <key> "<text>"',
    ].join("\n"),
  );
}

interface McpServer {
  readonly name: string;
  readonly command: string;
  readonly from: string;
}

function probeMcp(dir: string): BootstrapBlock | null {
  const found = new Map<string, McpServer>();
  const claude = readJson(join(dir, ".mcp.json"));
  const servers = claude?.["mcpServers"];
  if (servers !== null && typeof servers === "object") {
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      const cfg = (raw ?? {}) as Record<string, unknown>;
      const cmd = typeof cfg["command"] === "string" ? cfg["command"] : "?";
      found.set(name, { name, command: cmd, from: ".mcp.json" });
    }
  }
  const opencode = readJson(join(dir, "opencode.json"));
  const mcp = opencode?.["mcp"];
  if (mcp !== null && typeof mcp === "object") {
    for (const [name, raw] of Object.entries(mcp as Record<string, unknown>)) {
      if (found.has(name)) continue;
      const cfg = (raw ?? {}) as Record<string, unknown>;
      const c = cfg["command"];
      const cmd = Array.isArray(c)
        ? String(c[0] ?? "?")
        : typeof c === "string"
          ? c
          : "?";
      found.set(name, { name, command: cmd, from: "opencode.json" });
    }
  }
  if (found.size === 0) return null;
  const list = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return autoBlock(
    "mcp",
    [
      `${plural(list.length, "server", "servers")}: ${list.map((s) => `${s.name}(${s.command})`).join(" ")}`,
      // Перечислить ИНСТРУМЕНТЫ каждого сервера дёшево нельзя: список отдаёт
      // только сам сервер по handshake — процесс и сотни миллисекунд против
      // бюджета в 30 мс. Конфиг даёт имена и команды; инструменты агент
      // видит от своего хоста.
      `config: ${[...new Set(list.map((s) => s.from))].join(",")};` +
        " the host lists the tools, not the config",
    ].join("\n"),
  );
}

function probeSkills(dir: string, env: ProbeEnv): BootstrapBlock | null {
  const project = dirNames(join(dir, ".claude", "skills"));
  const user = dirNames(join(env.home, ".claude", "skills"));
  const orca = [
    ...new Set([
      ...dirNames(join(dir, ".orca", "skills")),
      ...dirNames(join(env.home, ".orca", "skills")),
    ]),
  ].sort();
  const orcaBin = env.which("orca");
  if (project.length + user.length + orca.length === 0 && orcaBin === null) return null;
  const lines: string[] = [];
  if (project.length > 0) {
    lines.push(`project .claude/skills ${project.length}: ${names(project, 16)}`);
  }
  if (user.length > 0) {
    lines.push(`personal ~/.claude/skills ${user.length}: ${names(user, 12)}`);
  }
  if (orca.length > 0) lines.push(`orca skills ${orca.length}: ${names(orca, 12)}`);
  else if (orcaBin !== null) {
    lines.push("orca cli present, no skills directory: `orca skills list` gives the full list");
  }
  return autoBlock("skills", lines.join("\n"));
}

/**
 * Блок про graft. Сам детект с S52 живёт в `@myc/code-intel`
 * (`probeGraftPresence`) и общий у бутстрапа, `init` и выбора реализации —
 * раньше это были две почти одинаковые функции, расходившиеся признаком
 * индекса. Блок сообщает агенту, что рядом есть graft и как звать его
 * НАПРЯМУЮ, независимо от того, какую реализацию код-интеллекта выбрал сам
 * myc (по умолчанию — builtin, §12.1).
 *
 * ТОЛЬКО ПРИ ИНДЕКСЕ (memory-bn4cs836df52). До этого блок печатался и при
 * одном бинаре в PATH — `bin=… index=нет` и список команд. Бинарь ставят
 * глобально ради других репозиториев, а в этом графа нет: `graft ask` здесь
 * отвечает `(empty) no matching nodes` с кодом 0, и каждая подсказка вела к
 * следующему пустому вызову — мимо работающего `myc callers`. Совет, по
 * которому инструмент молча ничего не находит, хуже отсутствия совета.
 * Случай «индекс есть, бинаря нет» остаётся: граф в репозитории — это
 * знание, которое можно прочитать и без бинаря.
 */
function probeGraft(dir: string, env: ProbeEnv): BootstrapBlock | null {
  const probe = probeGraftPresence(dir, { path: env.path, which: (cmd) => env.which(cmd) });
  const indexed = probe.index;
  const bin = probe.bin;
  if (!indexed) return null;
  const lines = [
    `bin=${bin ?? "none"} index=graft/`,
    'ask "<task>" --source | grep "<literal>" | skeleton <file> | callers <symbol> [--depth all] | map',
  ];
  if (bin === null) {
    lines.push("graph present, binary missing: install graft or read graft/*.md directly");
  }
  return autoBlock("graft", lines.join("\n"));
}

/**
 * Уложенные модели. Признак — наличие manifest.json, а не имя каталога:
 * прерванная закачка оставляет каталог, и «модель есть» стало бы ровно тем
 * тихим фолбэком, который запрещает И2. Побайтовую сверку (sha256 по 34 МБ)
 * делает `myc models list`; в бюджет запуска сессии она не влезает, и вывод
 * об этом честно говорит.
 */
function probeModels(env: ProbeEnv): BootstrapBlock {
  const dirs = dirNames(env.modelsDir);
  const ready: string[] = [];
  const partial: string[] = [];
  for (const id of dirs) {
    (existsSync(join(env.modelsDir, id, "manifest.json")) ? ready : partial).push(id);
  }
  if (ready.length === 0 && partial.length === 0) {
    return autoBlock("models", `no embedding model installed (${env.modelsDir}); myc models fetch`);
  }
  const bits: string[] = [];
  if (ready.length > 0) bits.push(`${MODELS_READY} ${names(ready, 8)}`);
  if (partial.length > 0) bits.push(`no manifest: ${names(partial, 4)}`);
  return autoBlock(
    "models",
    `embedding models ${bits.join("; ")} (${env.modelsDir}); byte-level check: myc models list`,
  );
}

/**
 * Ярусы (S41). Личный ярус читается, только если он реально создан
 * (`myc init --global`); отсутствующий ~/.myc не ошибка, а обычное
 * состояние — работает один проектный ярус.
 *
 * `project=` печатает каталог БАЗЫ, а не `<cwd>/.myc`: из git worktree это
 * разные каталоги, и напечатать cwd значило бы назвать агенту путь, по
 * которому проектного яруса нет. `mycDir` пуст — воркспейса нет вовсе, и
 * тогда печатается место, где он был бы заведён.
 */
function probeTiers(
  dir: string,
  env: ProbeEnv,
  personal: number,
  mycDir: string | undefined,
): BootstrapBlock {
  const status = personalWorkspaceStatus(env.mycHome);
  const tail = !status.exists
    ? "none (myc init --global); every manual block is a project one"
    : personal > 0
      ? `${plural(personal, "manual block", "manual blocks")};` +
        " a project block with the same key overrides the personal one"
      : "present, no manual blocks";
  return autoBlock(
    "tiers",
    `project=${mycDir ?? join(dir, ".myc")} personal=${status.dir} ${tail}`,
  );
}

export interface Degradation {
  readonly code: string;
  readonly msg: string;
}

function probeDegraded(list: readonly Degradation[]): BootstrapBlock | null {
  if (list.length === 0) return null;
  return autoBlock("degraded", list.map((d) => `${d.code}: ${d.msg}`).join("\n"));
}

/**
 * Блоки, зависящие только от файлов окружения, — ровно то, что кешируется
 * по отпечатку. Деградации и ярусы считаются отдельно: они зависят от
 * состояния воркспейса, и в кеше «база не инициализирована» пережила бы
 * `myc init`.
 */
export function autoBlocks(
  dir: string,
  env: ProbeEnv,
  commands: readonly string[],
): BootstrapBlock[] {
  const out: BootstrapBlock[] = [probeMyc(commands)];
  const mcp = probeMcp(dir);
  if (mcp) out.push(mcp);
  const skills = probeSkills(dir, env);
  if (skills) out.push(skills);
  const graft = probeGraft(dir, env);
  if (graft) out.push(graft);
  out.push(probeModels(env));
  return out;
}

// ---------------------------------------------------------------------------
// Кеш автодетекта
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly fp: string;
  readonly at: number;
  readonly blocks: readonly BootstrapBlock[];
}

interface CacheFile {
  readonly v: number;
  /** Ключ — корень РАБОЧЕГО ДЕРЕВА, из которого собран этот автодетект. */
  readonly trees: Readonly<Record<string, CacheEntry>>;
}

/**
 * Сколько деревьев помнить. Worktree заводят и удаляют; без потолка файл рос
 * бы на каждую ветку и никогда не убывал. Вытесняется самое старое по `at`.
 */
const CACHE_TREES = 8;

/**
 * Кеш автодетекта — обе стороны сразу, и это не компромисс, а состав данных.
 *
 * ЛЕЖИТ он рядом с БАЗОЙ: это side-файл воркспейса, и `<cwd>/.myc` в git
 * worktree — чужой каталог, который исчезнет вместе с веткой (сорить в дереве
 * ветки каталогом `.myc` мы не имеем права: в нём базы нет и не будет).
 *
 * КЛЮЧОМ ему служит корень рабочего дерева, потому что СОДЕРЖИМОЕ у него
 * про дерево: отпечаток окружения складывается из `<cwd>/.mcp.json`,
 * `<cwd>/.claude/skills`, `<cwd>/graft` — и в отпечаток входят сами эти пути,
 * то есть у worktree он ОТЛИЧАЕТСЯ от основного дерева всегда. Держи мы одну
 * запись на файл — два дерева вытесняли бы друг друга на каждом старте
 * сессии, и кеш перестал бы попадать вовсе, оставшись при этом записью.
 */
function cachePath(mycDir: string): string {
  return join(mycDir, "bootstrap.cache.json");
}

function readCacheFile(mycDir: string): CacheFile | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(mycDir), "utf8")) as CacheFile;
    if (raw.v !== BOOTSTRAP_CACHE_VERSION) return null;
    if (raw.trees === null || typeof raw.trees !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

function readCache(mycDir: string, treeRoot: string, fp: string): BootstrapBlock[] | null {
  const file = readCacheFile(mycDir);
  const entry = file?.trees[treeRoot];
  if (entry === undefined || entry.fp !== fp || !Array.isArray(entry.blocks)) return null;
  return [...entry.blocks];
}

function writeCache(
  mycDir: string,
  treeRoot: string,
  fp: string,
  blocks: readonly BootstrapBlock[],
): boolean {
  try {
    if (!existsSync(mycDir)) mkdirSync(mycDir, { recursive: true });
    const now = Date.now();
    const kept = Object.entries(readCacheFile(mycDir)?.trees ?? {})
      .filter(([root]) => root !== treeRoot)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_TREES - 1);
    const payload: CacheFile = {
      v: BOOTSTRAP_CACHE_VERSION,
      trees: { ...Object.fromEntries(kept), [treeRoot]: { fp, at: now, blocks } },
    };
    writeFileSync(cachePath(mycDir), JSON.stringify(payload));
    return true;
  } catch {
    return false; // read-only ФС — не повод ронять запуск сессии
  }
}

// ---------------------------------------------------------------------------
// Ручные блоки: узлы kind=note слоя L3, attrs.topic='bootstrap'
// ---------------------------------------------------------------------------

/**
 * `layer >= 2 AND layer = 3` — не тавтология: первый терм дословно повторяет
 * предикат частичного индекса `ix_nodes_prime` (layer >= 2 AND head_id IS
 * NULL AND deleted_at IS NULL), и только тогда планировщик его берёт — тот
 * же приём, что у ready с ix_nodes_ready. Покрыто тестом на EXPLAIN QUERY
 * PLAN: без первого терма запрос уходит в SCAN nodes.
 *
 * ORDER BY нет намеренно: сортировка по не-ведущей колонке индекса дала бы
 * TEMP B-TREE по всем строкам scope (см. память myc-sqlite-tail-query), а
 * блоков тут единицы — дешевле упорядочить в JS.
 *
 * Отозванный, заменённый или отменённый блок (HIDDEN_STATUSES) и кандидат
 * хука сжатия (`pending_review`) — не правило запуска: блок уходит в контекст
 * КАЖДОЙ сессии, и то, что recall и prime уже не отдают, здесь не всплывает
 * тоже. Термы — те же функции @myc/retrieval/review, что у выдачи, а не
 * своя копия литерала (одна такая уже разошлась, memory-0p3d8n1efwtv); оба —
 * фильтры поверх того же индекса, план не меняется (тест на EXPLAIN).
 * `set` по ключу скрытого блока заводит новый живой, `rm` его не видит.
 */
export const BOOTSTRAP_LIST_SQL = `SELECT id, title, coalesce(body,'') AS body, updated_at
            FROM nodes
           WHERE scope = ?1 AND kind = 'note'
             AND layer >= 2 AND layer = 3
             AND head_id IS NULL AND deleted_at IS NULL
             AND g_topic = 'bootstrap'
             AND ${liveStatusPredicate("nodes")}
             AND ${notPendingPredicate("nodes")}`;

const QL = {
  bootstrap_list: {
    name: "bootstrap_list",
    sql: BOOTSTRAP_LIST_SQL,
    params: ["scope"],
  },
} as const satisfies Record<string, QueryDef>;

interface ManualRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly updated_at: number;
}

function manualRows(handle: StoreHandle): ManualRow[] {
  return handle.driver
    .all<ManualRow>(QL.bootstrap_list, [handle.scope])
    .sort((a, b) => a.title.localeCompare(b.title));
}

function manualBlocks(handle: StoreHandle): BootstrapBlock[] {
  return manualRows(handle).map((r) => ({
    key: r.title,
    source: "manual" as const,
    tier: "project" as const,
    text: r.body,
  }));
}

const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isBootstrapKey(key: string): boolean {
  return KEY_RE.test(key);
}

function badKey(key: string): CommandFailure {
  return {
    ok: false,
    code: "usage.invalid",
    msg: `key '${key}' is not valid: expected ${KEY_RE.source}`,
    exit: ExitCode.USAGE,
  };
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export interface BootstrapDeps {
  readonly store: StoreDeps;
  readonly env: ProbeEnv;
  /** Имена команд верхнего уровня — для блока auto:myc и для отпечатка. */
  commands(): readonly string[];
  /**
   * Сборка myc для отпечатка кеша; по умолчанию `CLI_VERSION`. Поле, а не
   * прямое чтение константы, ради теста «обновление рвёт кеш»: две сборки в
   * одном процессе иначе не получить.
   */
  readonly build?: string;
  /**
   * Личный ярус `~/.myc` (S41, воркспейс от myc-ye3.6). Отдельная функция,
   * а не встроенный вызов: тесты подменяют ярус, не создавая второй базы,
   * а вызывающий платит за второе соединение только здесь.
   */
  personalBlocks(ctx: CommandContext, env: ProbeEnv): Promise<readonly BootstrapBlock[]>;
}

/**
 * Ручные блоки личного яруса. `openPersonalStore` сам ленив: пока ~/.myc
 * не создан, до `new Database` дело не доходит вовсе (existsSync), так что
 * на машине без личного яруса это стоит одного stat.
 */
export async function readPersonalBlocks(
  ctx: CommandContext,
  env: ProbeEnv,
): Promise<readonly BootstrapBlock[]> {
  const opened = await openPersonalStore(ctx, env.mycHome);
  if (!opened.ok || opened.handle === undefined) return [];
  const handle = opened.handle;
  try {
    return manualRows(handle).map((r) => ({
      key: r.title,
      source: "manual" as const,
      tier: "personal" as const,
      text: r.body,
    }));
  } finally {
    handle.close();
  }
}

export const realBootstrapDeps: BootstrapDeps = {
  store: realStoreDeps,
  env: realProbeEnv,
  commands: () => defaultRegistry.top.map((c) => c.name).sort(),
  personalBlocks: readPersonalBlocks,
};

/** Запись идёт в проектный ярус по умолчанию, в личный — явным --global (S41). */
const GLOBAL_FLAG: FlagSpec = {
  name: "global",
  description: "act on the personal tier ~/.myc instead of the project one",
};

type TierOpen =
  | { readonly ok: true; readonly handle: StoreHandle; readonly tier: BlockTier }
  | { readonly ok: false; readonly failure: CommandFailure };

async function openTier(
  ctx: CommandContext,
  deps: BootstrapDeps,
  global: boolean,
): Promise<TierOpen> {
  if (!global) {
    const opened = await deps.store.openStore(ctx);
    return opened.ok
      ? { ok: true, handle: opened.handle, tier: "project" }
      : { ok: false, failure: opened.failure };
  }
  const opened = await openPersonalStore(ctx, deps.env.mycHome);
  if (!opened.ok) return { ok: false, failure: opened.failure };
  if (opened.handle === undefined) {
    // Личный ярус создаётся только явным действием (S41): молча завести
    // вторую базу из-под `bootstrap set` значит завести её мимо init.
    return {
      ok: false,
      failure: {
        ok: false,
        code: "ws.not_initialized",
        msg: `personal tier not created: no ${personalWorkspaceStatus(deps.env.mycHome).dbPath}`,
        exit: ExitCode.NOWS,
        hint: "myc init --global",
      },
    };
  }
  return { ok: true, handle: opened.handle, tier: "personal" };
}

const BUDGET_FLAG: FlagSpec = {
  name: "budget",
  value: "number",
  description: `output cap in chars (default ${DEFAULT_BUDGET}, env MYC_BOOTSTRAP_BUDGET)`,
};

interface BootstrapData {
  text: string;
  chars: number;
  body_chars: number;
  budget: number;
  truncated: boolean;
  dropped: string[];
  clipped: string[];
  fp: string;
  cache: "hit" | "miss" | "off";
  auto: number;
  manual: number;
  tiers: string[];
  blocks: Array<{ key: string; source: BlockSource; tier: BlockTier; chars: number }>;
  took_ms: number;
}

/**
 * Бюджет: флаг → переменная окружения → конфиг ПРОЕКТА → умолчание.
 *
 * Проектный ярус появился потому, что умолчание не выдерживает нормального
 * использования `myc bootstrap set`: пять закреплённых правил дают 2863 символа
 * при умолчании 2000, и первым вытесняется `[auto:graft]` — самый нужный агенту
 * блок. Правила общие для команды, значит и бюджет общий; настройка одного
 * разработчика в его окружении остальным не помогает.
 *
 * Конфиг читается ПО КАТАЛОГУ, а не через хранилище: блок обязан собираться и
 * там, где воркспейса нет вовсе, а хранилище к этому моменту ещё не открыто.
 * Каталог при этом берётся у ВОРКСПЕЙСА, а не из cwd: правила общие для
 * команды, они коммитятся в `workspace.toml` основного дерева, и из git
 * worktree бюджет обязан быть тот же самый.
 */
function resolveBudget(
  ctx: CommandContext,
  dir: string,
  mycDir: string | undefined,
): number | CommandFailure {
  const flag = ctx.flags["budget"];
  const fromEnv = process.env.MYC_BOOTSTRAP_BUDGET;
  let fromProject: number | undefined;
  try {
    const tomlPath = join(mycDir ?? join(dir, ".myc"), "workspace.toml");
    if (existsSync(tomlPath)) {
      fromProject = parseWorkspaceToml(readFileSync(tomlPath, "utf8")).bootstrapBudget;
    }
  } catch {
    // Битый конфиг не повод отказать в бутстрапе — упадём на умолчание.
  }
  const raw =
    typeof flag === "number"
      ? flag
      : fromEnv !== undefined && fromEnv !== ""
        ? Number(fromEnv)
        : (fromProject ?? DEFAULT_BUDGET);
  if (!Number.isFinite(raw) || raw < MIN_BUDGET) {
    return {
      ok: false,
      code: "usage.invalid",
      msg: `--budget ${raw}: minimum is ${MIN_BUDGET} chars, below that not even the header fits`,
      exit: ExitCode.USAGE,
    };
  }
  return Math.floor(raw);
}

function buildPrint(deps: BootstrapDeps): Command {
  return {
    name: "bootstrap",
    summary: "mandatory start-of-session context block for an agent",
    help:
      "Prints a ready-to-paste block: environment autodetect plus manual blocks " +
      "(myc bootstrap set). Every block is tagged with its source — [auto:*] or " +
      "[manual:*]. Autodetect is cached by an environment fingerprint.",
    flags: [
      BUDGET_FLAG,
      { name: "no-cache", description: "ignore and do not write the autodetect cache" },
      { name: "refresh", description: "recompute autodetect and rewrite the cache" },
    ],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      // Две стороны. `dir` — РАБОЧЕЕ ДЕРЕВО: из него собирается автодетект
      // (какие тут скилы, есть ли graft, чем настроен харнесс). `mycDir` —
      // ВОРКСПЕЙС: там база, туда же кеш и оттуда общий для команды бюджет.
      // Вне worktree это один и тот же каталог; внутри — разные, и путать их
      // значит писать кеш в ветку, которая завтра исчезнет.
      const dir = resolve(ctx.globals.directory ?? process.cwd());
      const mycDir = findMycDir(dir, ctx.globals.db);
      const budget = resolveBudget(ctx, dir, mycDir);
      if (typeof budget !== "number") return budget;

      const env = deps.env;
      const commands = deps.commands();
      const noCache = ctx.flags["no-cache"] === true;
      const refresh = ctx.flags["refresh"] === true;
      const fp = environmentFingerprint(probeInputs(dir, env), [
        `path:${env.path}`,
        `cmds:${commands.join(",")}`,
        `myc:${deps.build ?? CLI_VERSION}`,
      ]);

      // Отсутствие воркспейса — не ошибка команды: блок обязан собираться
      // и на чистой машине. Но это деградация, и она громкая (warn + строка
      // в самом блоке), а не молчаливая.
      const opened = await deps.store.openStore(ctx);
      const degraded: Degradation[] = [];
      const handle: StoreHandle | undefined = opened.ok ? opened.handle : undefined;
      if (handle === undefined) {
        ctx.warn("ws.absent", `workspace not initialized, no manual blocks: ${dir}`);
        degraded.push({
          code: "ws.absent",
          msg: "workspace not initialized, no manual blocks: myc init",
        });
      }

      try {
        // Ручные блоки — всегда из графа, никогда из кеша: их правит человек
        // командой set, а отпечаток окружения про базу ничего не знает.
        const manual = handle !== undefined ? manualBlocks(handle) : [];
        let cache: "hit" | "miss" | "off" = "off";
        let auto: BootstrapBlock[] | null = null;
        const cacheable = handle !== undefined && mycDir !== undefined && !noCache;
        if (cacheable && !refresh) {
          auto = readCache(mycDir!, dir, fp);
          if (auto !== null) cache = "hit";
        }
        if (auto === null) {
          auto = autoBlocks(dir, env, commands);
          if (cacheable) cache = writeCache(mycDir!, dir, fp, auto) ? "miss" : "off";
        }

        const personal = await deps.personalBlocks(ctx, env);
        const models = auto.find((b) => b.key === "models");
        if (models !== undefined && !models.text.includes(MODELS_READY)) {
          degraded.push({
            code: "embed.model_absent",
            msg: "embedding model not installed, retrieval runs without vectors: myc models fetch",
          });
        }
        // Отсутствие graft деградацией НЕ считается (memory-bn4cs836df52): он
        // необязателен, а builtin отвечает на callers, code search и code map
        // сам. Прежняя строка `graft.absent` уверяла агента в обратном в
        // каждой сессии. Настоящие ограничения builtin называют сами команды
        // кода: не построенный индекс — `precond.no_index` (exit 5) с
        // подсказкой `myc code index`, дерево без L1-файлов — `code_index.no_l1`.
        const extra: BootstrapBlock[] = [];
        const deg = probeDegraded(degraded);
        if (deg) extra.push(deg);
        extra.push(probeTiers(dir, env, personal.length, mycDir));

        const all = [...auto, ...extra, ...manual, ...personal];
        const took = Math.max(1, Math.round(performance.now() - t0));
        const rendered = renderBootstrap({
          blocks: all,
          budget,
          ws: handle?.slug ?? "-",
          fp,
          stats: { tookMs: took, cache },
        });

        const merged = mergeBlocks(all);
        const data: BootstrapData = {
          text: rendered.text,
          chars: rendered.chars,
          body_chars: rendered.bodyChars,
          budget: rendered.budget,
          truncated: rendered.truncated,
          dropped: [...rendered.dropped],
          clipped: [...rendered.clipped],
          fp,
          cache,
          auto: merged.filter((b) => b.source === "auto").length,
          manual: merged.filter((b) => b.source === "manual").length,
          tiers: personal.length > 0 ? ["project", "personal"] : ["project"],
          blocks: merged.map((b) => ({
            key: b.key,
            source: b.source,
            tier: b.tier,
            chars: renderBlock(b).length,
          })),
          took_ms: took,
        };
        return {
          ok: true,
          data,
          meta: {
            chars: data.chars,
            budget: data.budget,
            cache,
            fp,
            truncated: data.truncated,
          },
        };
      } finally {
        handle?.close();
      }
    },
    renderHuman: (raw) => (raw as BootstrapData).text,
  };
}

interface SetData {
  key: string;
  id: string;
  tier: BlockTier;
  chars: number;
  created: boolean;
  took_ms: number;
}

function buildSet(deps: BootstrapDeps): Command {
  return {
    name: "set",
    summary: "pin a manual bootstrap block (L3 note, survives compaction)",
    help:
      "myc bootstrap set [--global] <key> <text>; text '-' is read from stdin. " +
      "Without --global the block goes to the project tier, with it to the personal one in ~/.myc.",
    flags: [GLOBAL_FLAG],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const key = ctx.args[0];
      if (key === undefined) {
        return {
          ok: false,
          code: "usage.missing_arg",
          msg: "key required: myc bootstrap set <key> <text>",
          exit: ExitCode.USAGE,
        };
      }
      if (!isBootstrapKey(key)) return badKey(key);
      const rest = ctx.args.slice(1).join(" ");
      if (rest.length === 0) {
        return {
          ok: false,
          code: "usage.missing_arg",
          msg: "text required: myc bootstrap set <key> <text> (or '-' for stdin)",
          exit: ExitCode.USAGE,
        };
      }
      const text = rest === "-" ? (await new Response(Bun.stdin.stream()).text()).trim() : rest;
      if (text.length === 0) {
        return { ok: false, code: "usage.empty", msg: "empty block text", exit: ExitCode.USAGE };
      }

      const opened = await openTier(ctx, deps, ctx.flags["global"] === true);
      if (!opened.ok) return opened.failure;
      const handle = opened.handle;
      try {
        const existing = manualRows(handle).find((r) => r.title === key);
        let node: NodeRecord;
        let created: boolean;
        if (existing !== undefined) {
          node = handle.store.updateNode(existing.id, { body: text });
          created = false;
        } else {
          const attrs: Record<string, JsonValue> = {
            topic: BOOTSTRAP_TOPIC,
            source: "user",
            tags: ["bootstrap"],
          };
          node = handle.store.createNode({
            kind: "note",
            layer: BOOTSTRAP_LAYER,
            scope: handle.scope,
            title: key,
            body: text,
            attrs,
          });
          created = true;
        }
        const data: SetData = {
          key,
          id: node.id,
          tier: opened.tier,
          chars: text.length,
          created,
          took_ms: Math.max(1, Math.round(performance.now() - t0)),
        };
        return { ok: true, data };
      } catch (e) {
        return graphFailure(e);
      } finally {
        handle.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as SetData;
      const verb = d.created ? "set" : "updated";
      const tier = d.tier === "personal" ? "@personal" : "";
      return `${verb} [manual:${d.key}${tier}] ${d.id} · ${d.chars} chars · ${d.took_ms} ms\n`;
    },
  };
}

interface RmData {
  key: string;
  id: string;
  tier: BlockTier;
  took_ms: number;
}

function buildRm(deps: BootstrapDeps): Command {
  return {
    name: "rm",
    summary: "remove a manual bootstrap block",
    flags: [GLOBAL_FLAG],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const key = ctx.args[0];
      if (key === undefined) {
        return {
          ok: false,
          code: "usage.missing_arg",
          msg: "key required: myc bootstrap rm <key>",
          exit: ExitCode.USAGE,
        };
      }
      const opened = await openTier(ctx, deps, ctx.flags["global"] === true);
      if (!opened.ok) return opened.failure;
      const handle = opened.handle;
      try {
        const existing = manualRows(handle).find((r) => r.title === key);
        if (existing === undefined) {
          return {
            ok: false,
            code: "notfound.block",
            msg: `no manual block '${key}'`,
            exit: ExitCode.NOTFOUND,
            hint: "myc bootstrap list",
          };
        }
        handle.store.deleteNode(existing.id);
        const data: RmData = {
          key,
          id: existing.id,
          tier: opened.tier,
          took_ms: Math.max(1, Math.round(performance.now() - t0)),
        };
        return { ok: true, data };
      } catch (e) {
        return graphFailure(e);
      } finally {
        handle.close();
      }
    },
    renderHuman: (raw) => {
      const d = raw as RmData;
      const tier = d.tier === "personal" ? "@personal" : "";
      return `removed [manual:${d.key}${tier}] ${d.id} · ${d.took_ms} ms\n`;
    },
  };
}

interface ListRow {
  key: string;
  id: string;
  tier: BlockTier;
  chars: number;
  updated_at: number;
}

function buildList(deps: BootstrapDeps): Command {
  return {
    name: "list",
    summary: "list manual bootstrap blocks",
    handler: async (ctx): Promise<CommandResult> => {
      const opened = await deps.store.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const handle = opened.handle;
      try {
        const rows: ListRow[] = manualRows(handle).map((r) => ({
          key: r.title,
          id: r.id,
          tier: "project" as const,
          chars: r.body.length,
          updated_at: r.updated_at,
        }));
        for (const b of await deps.personalBlocks(ctx, deps.env)) {
          rows.push({
            key: b.key,
            id: "-",
            tier: "personal",
            chars: b.text.length,
            updated_at: 0,
          });
        }
        return { ok: true, data: rows, meta: { count: rows.length } };
      } finally {
        handle.close();
      }
    },
    renderHuman: (raw) => {
      const rows = raw as ListRow[];
      if (rows.length === 0) return "no manual blocks · myc bootstrap set <key> <text>\n";
      const body = rows
        .map(
          (r) =>
            `${r.key.padEnd(16)} ${r.tier.padEnd(8)} ${String(r.chars).padStart(5)} chars  ${r.id}`,
        )
        .join("\n");
      return `${body}\n`;
    },
  };
}

export function createBootstrapCommand(deps: BootstrapDeps = realBootstrapDeps): Command {
  return {
    ...buildPrint(deps),
    subcommands: [buildSet(deps), buildRm(deps), buildList(deps)],
  };
}
