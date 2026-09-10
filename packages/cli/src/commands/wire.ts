/**
 * `myc wire` / `myc unwire` — установка хуков без порчи чужих файлов
 * (§6.4–6.7, решение D10).
 *
 * Это не косметика. Один испорченный `CLAUDE.md` — и инструмент удаляют
 * вместе с памятью, которую он успел набрать. Поэтому здесь ровно пять
 * правил, и каждое из них проверяется тестом:
 *
 * 1. Целиком myc пишет ТОЛЬКО свои файлы: helper, skill, плагин.
 * 2. Чужие JSON-конфиги мержатся точечно: читаем, добавляем свои узлы, пишем
 *    обратно с сохранённым порядком ключей и отступом. Перед записью — `.bak`.
 * 3. Конфликт (чужой хук на том же событии) — вопрос, а не молчаливая победа:
 *    без `--hook-mode` не записывается НИЧЕГО, ни одного файла.
 * 4. `CLAUDE.md` не трогается никогда; `AGENTS.md` — только блок между
 *    маркерами и только с `--agents-md`. `statusLine` — только с
 *    `--status-line`, и прежняя строка продолжает получать тот же ввод.
 * 5. Повторный `wire` идемпотентен: те же файлы, байт в байт.
 *
 * Всё записанное попадает в журнал `.myc/wire.json` вместе с хешем файла на
 * момент записи — `myc unwire` снимает только то, что поставил, и только если
 * файл с тех пор не изменился.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure, Registry } from "../registry.ts";
import { flagStr } from "./store.ts";
import { maybeSpawnUpdateCheck, updateNoticeFor } from "../update-check.ts";
import { CLI_VERSION } from "../index.ts";
import { HARNESSES, type Harness } from "@myc/swarm";
import {
  isOurStatusLine,
  ourStatusLineCommand,
  readStatusLine,
  STATUSLINE_COMMAND,
  statusLineCommand,
  userSettingsPath,
} from "../statusline-config.ts";
import {
  AGENTS_END,
  AGENTS_START,
  agentsBlock,
  claudeHelper,
  CODEX_EVENTS,
  CODEX_HELPER_REL,
  CODEX_NEEDS_REVIEW,
  CODEX_NO_EPISODE,
  codexHelper,
  codexHookCommand,
  HOOK_SPECS,
  kimiHelper,
  kimiHooksToml,
  opencodePlugin,
  skillMd,
  type HookEvent,
  type HookSpec,
} from "../hooks/templates.ts";

export const WIRE_JOURNAL = "wire.json";
const BAK_SUFFIX = ".myc.bak";
const HELPER_MARK = "myc-hooks.mjs";
const MYC_PERMISSION = "Bash(myc:*)";
const TOML_NOTIFY_START = "# myc:notify:start";
const TOML_NOTIFY_END = "# myc:notify:end";
const CODEX_HOOKS_REL = ".codex/hooks.json";
const TOML_MCP_START = "# myc:mcp:start";
const TOML_MCP_END = "# myc:mcp:end";
/** Схему пишем только в созданный нами opencode.json — и снимаем вместе с ним. */
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/**
 * Кого обслуживаем — ОДИН список на весь myc (@myc/swarm, harness.ts).
 * Своего списка здесь больше нет: до memory-7vywv63wma61 он был вторым и
 * молча разошёлся с ростером — wire ставил конфиг Codex, которого ростер не
 * знал, и не ставил ничего для Kimi, который в ростере был. Сторож —
 * ../harness.wiring.test.ts.
 */
type HookMode = "append" | "replace" | "skip";

// ---------------------------------------------------------------------------
// План: что и как будет записано
// ---------------------------------------------------------------------------

type ActionKind = "new" | "rewrite" | "merge" | "unchanged";

interface Action {
  readonly path: string;
  readonly kind: ActionKind;
  readonly detail: string;
  readonly content: string;
  /** Узлы конфига, которые мы считаем своими — для журнала и `unwire`. */
  readonly nodes: readonly string[];
  /** Существующий файл перед записью копируется в `<file>.myc.bak`. */
  readonly backup: boolean;
  /**
   * Контейнеры JSON, которые были в файле ДО нас (`"hooks": {}` и т.п.):
   * `unwire` оставит их даже пустыми — «ключ был — ключ остаётся».
   */
  readonly preexisting?: readonly string[];
  /** Файла до этого прогона не было: его создаёт wire. */
  readonly created?: boolean;
}

interface Conflict {
  readonly path: string;
  readonly node: string;
  readonly command: string;
}

/**
 * Чужой обработчик, которого убрал `--hook-mode replace`.
 *
 * Отказ ДО выбора режима перечисляет чужие хуки поимённо; отчёт ПОСЛЕ выбора
 * был беднее отказа — «merge +4 узла» и всё (memory-vspyaxt3edvn). Человек
 * соглашался на цену, которой не видел: у заказчика так молча выключились
 * `bd prime` и три хука graft, и graft перестал обновлять граф на правках.
 * Поэтому вытеснение — не побочный эффект записи, а её результат, и он
 * доезжает до вывода отдельным списком.
 */
interface Evicted {
  readonly path: string;
  readonly event: string;
  /** Матчер записи, если был: два хука на одном событии различает он. */
  readonly matcher?: string;
  readonly command: string;
}

interface Plan {
  readonly actions: Action[];
  readonly conflicts: Conflict[];
  readonly evicted: Evicted[];
  readonly untouched: string[];
  readonly notes: string[];
  /** Наша строка статуса и то, что она заменила, — для журнала и unwire. */
  statusLine?: StatusLineRecord;
}

function emptyPlan(): Plan {
  return { actions: [], conflicts: [], evicted: [], untouched: [], notes: [] };
}

/**
 * Что знает журнал о строке статуса. `previous` — проектная `statusLine` ДО
 * нас, дословно, как лежала в файле; `null` — ключа не было. По нему `unwire`
 * возвращает файл побайтно: был ключ — вернётся тот же, не было — не будет.
 */
export interface StatusLineRecord {
  readonly path: string;
  readonly previous: unknown;
  /** Кому наша строка отдаёт ввод: project (`--then`), user или никому. */
  readonly passthrough: "project" | "user" | "none";
}

/** `1 node`, `3 nodes` — отчёт читает человек, а не парсер. */
function countNodes(n: number): string {
  return `${n} ${n === 1 ? "node" : "nodes"}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function fileText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Файл целиком наш (helper, skill, плагин): пишем как есть, но не зря. */
function planOwnFile(plan: Plan, root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  const current = fileText(abs);
  if (current === content) {
    plan.actions.push({ path: rel, kind: "unchanged", detail: "up to date", content, nodes: [], backup: false });
    return;
  }
  plan.actions.push({
    path: rel,
    kind: current === null ? "new" : "rewrite",
    detail: `${(Buffer.byteLength(content, "utf8") / 1024).toFixed(1)} KB`,
    content,
    nodes: [],
    backup: current !== null,
    created: current === null,
  });
}

// ---------------------------------------------------------------------------
// JSON: merge, а не запись
// ---------------------------------------------------------------------------

interface JsonSource {
  readonly exists: boolean;
  readonly value: Record<string, unknown>;
  readonly indent: string;
  /** Файл есть, но не разбирается: писать в него нельзя ни при каких условиях. */
  readonly broken: boolean;
}

function readJsonSource(path: string): JsonSource {
  const text = fileText(path);
  if (text === null) return { exists: false, value: {}, indent: "  ", broken: false };
  const indentMatch = /\n([ \t]+)"/.exec(text);
  const indent = indentMatch?.[1] ?? "  ";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, value: {}, indent, broken: true };
    }
    return { exists: true, value: parsed as Record<string, unknown>, indent, broken: false };
  } catch {
    return { exists: true, value: {}, indent, broken: true };
  }
}

function serializeJson(value: unknown, indent: string): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Наша ли это запись хука — узнаём по имени helper-файла в команде. */
function isOurHookEntry(entry: unknown): boolean {
  const hooks = asArray(asRecord(entry)["hooks"]);
  return hooks.some((h) => {
    const cmd = asRecord(h)["command"];
    return typeof cmd === "string" && cmd.includes(HELPER_MARK);
  });
}

function foreignCommand(entry: unknown): string | null {
  return foreignCommands(entry)[0] ?? null;
}

/**
 * ВСЕ чужие команды одной записи, а не первая. Запись `hooks[Event][i]` —
 * это `{matcher?, hooks: [...]}`, и обработчиков внутри может быть несколько.
 * `foreignCommand` показывает одну, потому что отказу хватает образца; отчёт
 * о вытеснении обязан назвать каждую (memory-vspyaxt3edvn).
 */
function foreignCommands(entry: unknown): string[] {
  const hooks = asArray(asRecord(entry)["hooks"]);
  const out: string[] = [];
  for (const h of hooks) {
    const cmd = asRecord(h)["command"];
    if (typeof cmd === "string" && !cmd.includes(HELPER_MARK)) out.push(cmd);
  }
  return out;
}

/** Матчер записи — часть её адреса: два хука на PostToolUse различает он. */
function entryMatcher(entry: unknown): string | undefined {
  const m = asRecord(entry)["matcher"];
  return typeof m === "string" && m.length > 0 ? m : undefined;
}

function claudeHookEntry(spec: HookSpec): Record<string, unknown> {
  const command = `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs" ${spec.event}`;
  const entry: Record<string, unknown> = {
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    hooks: [{ type: "command", command, timeout: spec.timeoutMs }],
  };
  return entry;
}

/**
 * Запись хука для `.codex/hooks.json`. Форма та же, что у Claude Code, а
 * `timeout` — В СЕКУНДАХ (`hook.timeout_sec` внутри codex). Одно и то же поле
 * с разной единицей в двух конфигах — ровно тот случай, где молчаливая
 * подстановка миллисекунд дала бы хук с таймаутом в 8000 секунд.
 */
function codexHookEntry(spec: HookSpec): Record<string, unknown> {
  return {
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    hooks: [
      {
        type: "command",
        command: codexHookCommand(spec.event),
        timeout: Math.max(1, Math.ceil(spec.timeoutMs / 1000)),
      },
    ],
  };
}

interface SettingsPlan {
  readonly nodes: string[];
  readonly conflicts: Conflict[];
  /** Что убрал `replace`; у планировщиков без хуков — пусто. */
  readonly evicted?: readonly Evicted[];
  /** Что переставил `append`; строка уже готова к печати. */
  readonly notes?: readonly string[];
  readonly value: Record<string, unknown>;
  /** Только у `.claude/settings.json`, когда наша строка там стоит или встаёт. */
  readonly statusLine?: StatusLineRecord;
}

/**
 * Точечный merge массивов `hooks.<Event>` в чужом JSON-конфиге. Общий для
 * Claude Code (`.claude/settings.json`) и Codex (`.codex/hooks.json`): форма
 * записи у них одна, различаются только команда и единица таймаута, и обе
 * приходят параметром `entry`. Две копии этой функции разъехались бы молча —
 * а вытеснение чужих хуков считается самым дорогим, что здесь происходит.
 */
function mergeHookNodes(
  source: JsonSource,
  specs: readonly HookSpec[],
  mode: HookMode | undefined,
  relPath: string,
  entry: (spec: HookSpec) => Record<string, unknown>,
): SettingsPlan {
  const value: Record<string, unknown> = { ...source.value };
  const hooks = asRecord(value["hooks"]);
  const nodes: string[] = [];
  const conflicts: Conflict[] = [];
  const evicted: Evicted[] = [];
  const notes: string[] = [];

  for (const spec of specs) {
    const event = spec.claudeEvent;
    const existing = asArray(hooks[event]);
    const foreign = existing.filter((e) => !isOurHookEntry(e));
    const node = `hooks.${event}`;

    if (foreign.length > 0 && mode === undefined) {
      conflicts.push({ path: relPath, node, command: foreignCommand(foreign[0]) ?? "(unknown)" });
      continue;
    }
    if (foreign.length > 0 && mode === "skip") continue;

    if (mode === "replace") {
      for (const entry of foreign) {
        const matcher = entryMatcher(entry);
        const commands = foreignCommands(entry);
        // Запись без единой команды — тоже потеря, и назвать её надо: молчание
        // здесь ничем не лучше молчания про команду, которую мы прочитали.
        for (const command of commands.length > 0 ? commands : ["(command not readable)"]) {
          evicted.push({ path: relPath, event, ...(matcher !== undefined ? { matcher } : {}), command });
        }
      }
    } else if (foreign.length > 0) {
      // append: чужие сохраняются, но наша запись уходит В КОНЕЦ массива. Если
      // до нас наш же хук стоял выше чужого, чужой сдвигается вверх и порядок
      // запуска меняется. Это тихое изменение чужого файла — значит, вслух.
      const moved = foreign.filter((e, i) => existing.indexOf(e) !== i);
      if (moved.length > 0) {
        notes.push(
          `${relPath}: ${node} — myc's hook moved to the end of the array, foreign hooks moved up and ` +
            `will run before it: ${moved.map((e) => foreignCommands(e).join(", ") || "(command not readable)").join("; ")}`,
        );
      }
    }

    const kept = mode === "replace" ? [] : foreign;
    hooks[event] = [...kept, entry(spec)];
    nodes.push(node);
  }

  if (conflicts.length > 0) return { nodes, conflicts, evicted, notes, value };
  if (nodes.length > 0) value["hooks"] = hooks;
  return { nodes, conflicts, evicted, notes, value };
}

/**
 * `.claude/settings.json`: те же узлы `hooks.<Event>` плюс `permissions.allow`.
 * Всё остальное — включая `statusLine` — не читается и не пишется.
 */
function mergeClaudeSettings(
  source: JsonSource,
  specs: readonly HookSpec[],
  mode: HookMode | undefined,
  relPath: string,
): SettingsPlan {
  const base = mergeHookNodes(source, specs, mode, relPath, claudeHookEntry);
  if (base.conflicts.length > 0) return base;
  const value = { ...base.value };
  const nodes = [...base.nodes];

  const permissions = asRecord(value["permissions"]);
  const allow = asArray(permissions["allow"]);
  if (!allow.some((a) => a === MYC_PERMISSION)) {
    permissions["allow"] = [...allow, MYC_PERMISSION];
    value["permissions"] = permissions;
    nodes.push(`permissions.allow[${MYC_PERMISSION}]`);
  }

  return { ...base, nodes, value };
}

/** `.codex/hooks.json`: только узлы `hooks.<Event>`, без permissions. */
function mergeCodexHooks(
  source: JsonSource,
  specs: readonly HookSpec[],
  mode: HookMode | undefined,
  relPath: string,
): SettingsPlan {
  return mergeHookNodes(source, specs, mode, relPath, codexHookEntry);
}

function planJsonMerge(
  plan: Plan,
  root: string,
  rel: string,
  merge: (source: JsonSource) => SettingsPlan,
): void {
  const abs = join(root, rel);
  const source = readJsonSource(abs);
  if (source.broken) {
    plan.conflicts.push({ path: rel, node: "(file)", command: "not valid JSON" });
    return;
  }
  const merged = merge(source);
  plan.conflicts.push(...merged.conflicts);
  if (merged.conflicts.length > 0) return;
  plan.evicted.push(...(merged.evicted ?? []));
  plan.notes.push(...(merged.notes ?? []));
  if (merged.statusLine !== undefined) plan.statusLine = merged.statusLine;

  // Мы мержим через JSON.parse/stringify: порядок ключей и отступ сохраняются,
  // но однострочные объекты разворачиваются. Молчать об этом нельзя — файл
  // чужой. Проверка честная: прогоняем исходник через ту же пару функций и
  // сравниваем с оригиналом.
  const original = fileText(abs);
  if (original !== null && serializeJson(source.value, source.indent) !== original) {
    plan.notes.push(`${rel}: will be reformatted (line breaks change), content is kept; backup — ${rel}${BAK_SUFFIX}`);
  }

  const content = serializeJson(merged.value, source.indent);
  const current = fileText(abs);
  const preexisting = source.exists ? preexistingContainers(source.value) : [];
  if (current === content) {
    plan.actions.push({ path: rel, kind: "unchanged", detail: "up to date", content, nodes: merged.nodes, backup: false, preexisting });
    return;
  }
  plan.actions.push({
    path: rel,
    kind: source.exists ? "merge" : "new",
    detail: merged.nodes.length > 0 ? `+${countNodes(merged.nodes.length)}: ${merged.nodes.join(", ")}` : "no node changes",
    content,
    nodes: merged.nodes,
    backup: source.exists,
    preexisting,
    created: !source.exists,
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Контейнеры, в которые мы кладём свои узлы, — какие из них уже были в файле
 * и не держат ничего нашего. Такие `unwire` оставляет даже пустыми: пустой
 * `"hooks": {}` человека после круга wire+unwire обязан остаться на месте.
 * Контейнер с нашим узлом внутри к «бывшим до нас» не относится: откуда он —
 * не знаем (поставлен прежним wire без этой записи), и пустым он удаляется,
 * как удалялся всегда.
 */
function preexistingContainers(value: Record<string, unknown>): string[] {
  const out: string[] = [];
  const hooks = value["hooks"];
  if (isPlainObject(hooks)) {
    let ours = false;
    for (const [event, list] of Object.entries(hooks)) {
      const has = asArray(list).some(isOurHookEntry);
      ours = ours || has;
      if (Array.isArray(list) && !has) out.push(`hooks.${event}`);
    }
    if (!ours) out.push("hooks");
  }
  const permissions = value["permissions"];
  if (isPlainObject(permissions)) {
    const allow = permissions["allow"];
    const has = Array.isArray(allow) && allow.includes(MYC_PERMISSION);
    if (Array.isArray(allow) && !has) out.push("permissions.allow");
    if (!has) out.push("permissions");
  }
  for (const key of ["mcpServers", "mcp"]) {
    const v = value[key];
    if (isPlainObject(v) && v["myc"] === undefined) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Текстовые файлы с маркерами: AGENTS.md и config.toml
// ---------------------------------------------------------------------------

/**
 * Замена блока между маркерами. Всё вне маркеров сохраняется байт в байт —
 * это единственный способ трогать чужой markdown, не ломая доверие (D10).
 */
function replaceBlock(text: string, start: string, end: string, block: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    const sep = text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${sep}${block}\n`;
  }
  return `${text.slice(0, from)}${block}${text.slice(to + end.length)}`;
}

function hasBlock(text: string, start: string, end: string): boolean {
  const from = text.indexOf(start);
  return from !== -1 && text.indexOf(end) > from;
}

function removeBlock(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) return text;
  return `${text.slice(0, from).replace(/\n+$/, "\n")}${text.slice(to + end.length).replace(/^\n+/, "")}`;
}

// ---------------------------------------------------------------------------
// Планы по агентам
// ---------------------------------------------------------------------------

interface WireOptions {
  readonly root: string;
  readonly events: readonly HookEvent[];
  readonly hookOutput: "json" | "text";
  readonly mode: HookMode | undefined;
  readonly agentsMd: boolean;
  readonly mycBin: MycBinChoice;
  /** `--status-line`: поставить нашу строку статуса Claude Code. */
  readonly statusLine: boolean;
  /** Журнал прошлого wire: в нём прежняя строка статуса, если мы её заменили. */
  readonly previousJournal: Journal | null;
  /** Откуда читать пользовательские настройки Claude Code (HOME, CLAUDE_CONFIG_DIR). */
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

/**
 * Как записать команду myc в конфиг MCP.
 *
 * Порядок ТОТ ЖЕ, что у BIN_LOOKUP в hooks/templates.ts, и это не совпадение:
 * если хук возьмёт сборку из dist, а MCP — глобальную из PATH, в одной сессии
 * будут работать две разные версии myc, молча и с расходящимся поведением.
 *
 * Раньше здесь стояло безусловное "myc". При разработке из исходников, где
 * глобальной установки нет, MCP-сервер не поднимался вовсе: «Executable not
 * found in $PATH: myc», и инструменты myc были недоступны всю сессию.
 *
 * Найденное в репозитории пишется ОТНОСИТЕЛЬНЫМ путём: .mcp.json общий для
 * команды, и домашнему пути одного разработчика там не место.
 */
export interface MycBinChoice {
  readonly command: string;
  /** Откуда взято: env | repo | home | path — для отчёта wire. */
  readonly source: "env" | "repo" | "home" | "path" | "none";
}

export function resolveMycBin(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  // Платформа — АРГУМЕНТ, как у buildLibCandidates в store-sqlite, и по той же
  // причине: иначе Windows-ветку нельзя проверить на macOS, а именно она и
  // была сломана. Мутация «PATH снова по ':'» без этого не краснела.
  platform: NodeJS.Platform = process.platform,
): MycBinChoice {
  const fromEnv = env.MYC_BIN;
  if (fromEnv !== undefined && fromEnv.length > 0 && exists(fromEnv)) {
    return { command: fromEnv, source: "env" };
  }
  for (const rel of ["node_modules/.bin/myc", "dist/myc", ".myc/bin/myc"]) {
    if (exists(join(root, rel))) return { command: `./${rel}`, source: "repo" };
  }
  // Домашний каталог на Windows — USERPROFILE, HOME там обычно пуст.
  const homeDir = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : (env.USERPROFILE ?? "");
  const home = join(homeDir, ".myc/bin/myc");
  if (homeDir.length > 0 && exists(home)) return { command: home, source: "home" };
  // PATH делится по ':' в POSIX и по ';' в Windows, а исполняемый там —
  // myc.exe/myc.cmd. Жёсткое ':' и голое 'myc' означали, что на Windows
  // поиск НИКОГДА не находил бинарь: wire предупреждал `bin_unresolved`
  // даже там, где myc стоит в PATH и прекрасно работает (сообщил агент,
  // работавший на Windows). Ложная тревога в первую минуту знакомства.
  //
  // `delimiter` и `PATHEXT` берём у платформы, а не угадываем по разделителю
  // в строке: пустой PATH тогда молча выбрал бы POSIX-ветку.
  const win = platform === "win32";
  const names = win ? ["myc.exe", "myc.cmd", "myc.bat", "myc"] : ["myc"];
  const sep = win ? ";" : ":";
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(sep)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      if (exists(join(dir, name))) return { command: "myc", source: "path" };
    }
  }
  return { command: "myc", source: "none" };
}

function planClaude(plan: Plan, o: WireOptions): void {
  const specs = HOOK_SPECS.filter((s) => o.events.includes(s.event));
  const settings = ".claude/settings.json";
  planOwnFile(plan, o.root, ".claude/helpers/myc-hooks.mjs", claudeHelper({ events: o.events, hookOutput: o.hookOutput }));
  planOwnFile(plan, o.root, ".claude/skills/myc/SKILL.md", skillMd());
  planJsonMerge(plan, o.root, settings, (source) => {
    const base = mergeClaudeSettings(source, specs, o.mode, settings);
    return base.conflicts.length > 0 ? base : withStatusLine(base, o, settings);
  });
  planJsonMerge(plan, o.root, ".mcp.json", (source) => {
    const value = { ...source.value };
    const servers = asRecord(value["mcpServers"]);
    servers["myc"] = { command: o.mycBin.command, args: ["mcp", "--profile", "agent"] };
    value["mcpServers"] = servers;
    return { nodes: ["mcpServers.myc"], conflicts: [], value };
  });
  plan.untouched.push("CLAUDE.md");
  if (o.statusLine) {
    plan.untouched.push(".claude/settings.local.json", "~/.claude/settings.json (read only)");
  } else if (plan.statusLine === undefined) {
    plan.untouched.push(`${settings}:statusLine (needs --status-line)`);
  }
}

/** Команда для заметки: целиком не печатаем — у orca она на две тысячи знаков. */
function shortCommand(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length <= 60 ? one : `${one.slice(0, 59)}…`;
}

/**
 * Строка статуса в `.claude/settings.json` (после хуков и permissions).
 *
 * Без `--status-line` ключ не трогается вовсе — решение, принятое до этой
 * задачи и оставшееся в силе. Но если НАША строка там уже стоит, запись о
 * прежней обязана пережить перезапись журнала: иначе второй, обычный wire
 * вычеркнул бы её, и `unwire` оставил бы нашу строку или потерял чужую.
 *
 * С флагом: прежняя проектная строка запоминается дословно (для unwire) и
 * уезжает в нашу команду аргументом `--then`; нет проектной — ввод получит
 * пользовательская, которую `myc statusline` читает при каждой отрисовке.
 * Своя строка прежней не бывает никогда: повторный wire берёт прежнюю из
 * журнала, а не из файла, где уже стоим мы.
 */
function withStatusLine(base: SettingsPlan, o: WireOptions, rel: string): SettingsPlan {
  const current = base.value["statusLine"];
  const ours = isOurStatusLine(current);
  const recorded = o.previousJournal?.status_line;
  const notes = [...(base.notes ?? [])];
  const unknownPrevious = `${rel}: our statusLine is set with no record of the previous one (no journal) — unwire will remove it, and there is nothing to restore`;

  if (!o.statusLine) {
    if (!ours) return base;
    if (recorded === undefined) notes.push(unknownPrevious);
    return { ...base, notes, statusLine: recorded ?? { path: rel, previous: null, passthrough: "none" } };
  }

  let previous: unknown;
  if (ours) {
    previous = recorded?.previous ?? null;
    if (recorded === undefined) notes.push(unknownPrevious);
  } else {
    previous = current === undefined ? null : current;
  }

  const projectCmd = statusLineCommand(previous);
  let passthrough: StatusLineRecord["passthrough"] = "none";
  let foreignCmd: string | null = null;
  let carrier: unknown = previous;
  if (projectCmd !== null && !isOurStatusLine(previous)) {
    passthrough = "project";
    foreignCmd = projectCmd;
  } else {
    const userPath = userSettingsPath(o.env);
    const user = readStatusLine(userPath);
    if (user.broken) {
      return {
        ...base,
        conflicts: [
          { path: userPath, node: "statusLine", command: "not valid JSON — can't tell whose line is there, so its input can't be passed on" },
        ],
      };
    }
    const userCmd = statusLineCommand(user.value);
    if (userCmd !== null && !isOurStatusLine(user.value)) {
      passthrough = "user";
      foreignCmd = userCmd;
      carrier = user.value;
    }
  }

  // Передача чужой строке — POSIX (двойной fork, /bin/sh). На Windows её не
  // проверял никто, и поставить нашу строку поверх чужой значило бы молча
  // отрезать чужую — ровно то, чего эта опция обязана не делать.
  if (o.platform === "win32" && foreignCmd !== null) {
    return {
      ...base,
      conflicts: [
        {
          path: rel,
          node: "statusLine",
          command: `passing input to a foreign line is not implemented on Windows — not installing over "${shortCommand(foreignCmd)}"`,
        },
      ],
    };
  }

  const next: Record<string, unknown> = {
    type: "command",
    command: ourStatusLineCommand(o.mycBin, passthrough === "project" ? (foreignCmd ?? undefined) : undefined),
  };
  // Раскладку и частоту перерисовки задавала прежняя строка: orca их не
  // ставит, но строка с часами без refreshInterval перестала бы тикать.
  const carried = asRecord(carrier);
  for (const key of ["padding", "refreshInterval"]) {
    if (typeof carried[key] === "number") next[key] = carried[key];
  }
  const value = { ...base.value, statusLine: next };

  const wait = "it is neither awaited nor killed — its output from the last finished run shows above our line";
  if (passthrough === "project") {
    notes.push(`${rel}: statusLine is ours; the previous project line "${shortCommand(foreignCmd ?? "")}" gets the same stdin (--then), ${wait}`);
  } else if (passthrough === "user") {
    notes.push(
      `${rel}: statusLine is ours; the user line "${shortCommand(foreignCmd ?? "")}" from ${userSettingsPath(o.env)} ` +
        `gets the same stdin (read on every redraw), ${wait}`,
    );
  } else {
    notes.push(`${rel}: statusLine is ours; there was no previous line in the project or user settings — no one to pass input to`);
  }
  const local = readStatusLine(join(o.root, ".claude/settings.local.json"));
  if (local.value !== undefined) {
    notes.push(
      ".claude/settings.local.json: has its own statusLine — local settings override project ones, " +
        "so Claude Code will show that line, not myc's (file left alone)",
    );
  }
  return { ...base, value, nodes: [...base.nodes, "statusLine"], notes, statusLine: { path: rel, previous, passthrough } };
}

/**
 * Codex. Две половины, и обе внутри проекта — D10 соблюдается.
 *
 * 1. `.codex/config.toml` — MCP-сервер между маркерами, как было.
 * 2. `.codex/myc-hooks.mjs` + `.codex/hooks.json` — хуки. Проектный слой хуков
 *    у codex ЕСТЬ (`hooks/list` отдаёт наши записи с `"source": "project"`),
 *    вопреки прежней записи в templates.ts, которая считала конфиг только
 *    пользовательским. Поэтому блок в `$HOME` печатать не нужно, в отличие от
 *    Kimi.
 *
 * Чего wire всё равно не может: доверия. Codex запускает хук лишь после того,
 * как человек доверил проект и просмотрел новый хук, — и об этом сказано в
 * заметке, а не оставлено на догадку (И2).
 */
function planCodex(plan: Plan, o: WireOptions): void {
  const rel = ".codex/config.toml";
  const abs = join(o.root, rel);
  const existed = fileText(abs) !== null;
  const current = fileText(abs) ?? "";
  const mcpBlock = [
    TOML_MCP_START,
    "[mcp_servers.myc]",
    'command = "myc"',
    'args    = ["mcp", "--profile", "agent"]',
    "startup_timeout_sec = 10",
    TOML_MCP_END,
  ].join("\n");
  const nodes: string[] = [];
  let next = current;

  // Таблица безопасна в конце файла; чужая [mcp_servers.myc] вне маркеров —
  // конфликт, потому что переписать её значило бы отобрать чужой сервер.
  if (!hasBlock(next, TOML_MCP_START, TOML_MCP_END) && /^\s*\[mcp_servers\.myc\]/m.test(next)) {
    plan.conflicts.push({ path: rel, node: "[mcp_servers.myc]", command: "the section already exists outside the myc markers" });
  } else {
    next = replaceBlock(next, TOML_MCP_START, TOML_MCP_END, mcpBlock);
    nodes.push("[mcp_servers.myc]");
  }

  // notify БОЛЬШЕ НЕ СТАВИТСЯ (см. шапку про Codex в templates.ts): в его
  // payload нет ни стенограммы, ни события сжатия. Мало перестать писать
  // блок — надо снять свой старый, иначе у всех, кто настроился раньше,
  // на каждом ходу продолжит запускаться хук, который пишет `empty` и
  // выдаёт пустоту за здоровье в `myc doctor`.
  if (hasBlock(next, TOML_NOTIFY_START, TOML_NOTIFY_END)) {
    next = removeBlock(next, TOML_NOTIFY_START, TOML_NOTIFY_END);
    plan.notes.push(
      `${rel}: removed our old notify on .codex/myc-notify.mjs — ${CODEX_NO_EPISODE}. ` +
        "The .codex/myc-notify.mjs file itself is removed by `myc unwire`",
    );
  }

  // Хуки: helper целиком наш, hooks.json — чужой конфиг, значит merge.
  const specs = HOOK_SPECS.filter((sp) => o.events.includes(sp.event) && CODEX_EVENTS.has(sp.event));
  if (specs.length > 0) {
    planOwnFile(plan, o.root, CODEX_HELPER_REL, codexHelper({ events: o.events, hookOutput: o.hookOutput }));
    planJsonMerge(plan, o.root, CODEX_HOOKS_REL, (source) =>
      mergeCodexHooks(source, specs, o.mode, CODEX_HOOKS_REL),
    );
    plan.untouched.push("~/.codex/config.toml (project trust and hook review — by hand only)");
    plan.notes.push(`Codex: ${CODEX_NEEDS_REVIEW}`);
  }

  if (o.statusLine) {
    // Проверено чтением бинаря codex 0.153.4: `tui.status_line` — список
    // встроенных элементов (current-dir, git-branch, context-remaining…),
    // настраиваемый `/statusline`; своей команды он не принимает.
    plan.notes.push(
      "Codex: status line not installed — in codex 0.153.4 tui.status_line is a list of built-in " +
        "items (/statusline), a command can't go there",
    );
  }

  if (plan.conflicts.some((c) => c.path === rel)) return;
  if (next === current) {
    plan.actions.push({ path: rel, kind: "unchanged", detail: "up to date", content: next, nodes, backup: false });
    return;
  }
  plan.actions.push({
    path: rel,
    kind: current.length === 0 ? "new" : "merge",
    detail: `+${countNodes(nodes.length)}: ${nodes.join(", ")}`,
    content: next,
    nodes,
    backup: current.length > 0,
    created: !existed,
  });
}

function planOpencode(plan: Plan, o: WireOptions): void {
  if (o.statusLine) {
    plan.notes.push(
      "opencode: status line not installed — there is no config key for it, the TUI draws its own line",
    );
  }
  planOwnFile(plan, o.root, ".opencode/plugin/myc.ts", opencodePlugin({ events: o.events, hookOutput: o.hookOutput }));
  planJsonMerge(plan, o.root, "opencode.json", (source) => {
    const value = { ...source.value };
    if (!source.exists) value["$schema"] = OPENCODE_SCHEMA;
    const mcp = asRecord(value["mcp"]);
    mcp["myc"] = { type: "local", command: ["myc", "mcp", "--profile", "agent"], enabled: true };
    value["mcp"] = mcp;
    return { nodes: ["mcp.myc"], conflicts: [], value };
  });
}

/**
 * Kimi Code. Что он читает — установлено чтением его же бинаря
 * (`~/.kimi-code/bin/kimi`, сборка 2026-09-04), а не догадкой:
 *
 *   - `resolveMcpJsonPaths()` возвращает ТРИ файла — `~/.kimi-code/mcp.json`,
 *     `<корень репозитория>/.mcp.json` и `<cwd>/.kimi-code/mcp.json`, причём
 *     последний перекрывает предыдущие по одноимённому ключу. Пишем СВОЙ,
 *     `.kimi-code/mcp.json`: проектный `.mcp.json` — файл Claude Code, и
 *     занимать его ради Kimi значило бы трогать чужое (Kimi прочитает и его,
 *     если рядом стоит claude, — ключ `myc` один и тот же, дубля не будет).
 *   - Форма записи — `{command, args}` без `transport`: препроцессор
 *     `McpServerConfigSchema` сам выводит stdio по наличию `command`.
 *   - Скиллы проекта Kimi ищет в `.kimi-code/skills/` (PROJECT_BRAND_DIRS) и
 *     требует у SKILL.md фронтматтер с непустыми `name` и `description` —
 *     тот же формат, что у Claude Code, поэтому skillMd() общий.
 *   - Хуки — ТОЛЬКО пользовательские: `config.toml` резолвится как
 *     `KIMI_CODE_HOME ?? ~/.kimi-code`, проектного нет. `myc wire` за
 *     пределы проекта не выходит (D10), поэтому ставит исполняемую половину
 *     (helper) и печатает готовый блок для человека. Молчать здесь нельзя:
 *     без хука Kimi не получит ни prime на старте, ни эпизода перед сжатием.
 */
function planKimi(plan: Plan, o: WireOptions): void {
  planOwnFile(plan, o.root, ".kimi-code/skills/myc/SKILL.md", skillMd());
  planOwnFile(
    plan,
    o.root,
    ".kimi-code/myc-hooks.mjs",
    kimiHelper({ events: o.events, hookOutput: o.hookOutput }),
  );
  planJsonMerge(plan, o.root, ".kimi-code/mcp.json", (source) => {
    const value = { ...source.value };
    const servers = asRecord(value["mcpServers"]);
    servers["myc"] = { command: o.mycBin.command, args: ["mcp", "--profile", "agent"] };
    value["mcpServers"] = servers;
    return { nodes: ["mcpServers.myc"], conflicts: [], value };
  });
  plan.untouched.push("~/.kimi-code/config.toml (Kimi has a user-level hook config only)");
  if (o.statusLine) {
    plan.notes.push(
      "Kimi: this version of wire does not install the status line — Kimi has a status_line with a command, " +
        "but only in the user's tui.toml, and myc does not write outside the project",
    );
  }
  plan.notes.push(
    "Kimi reads hooks only from ~/.kimi-code/config.toml — it has no project config, " +
      "and myc does not write outside the project. The skill and MCP are already in place; to also get prime at " +
      "startup and an episode before compaction, paste this once:\n" +
      kimiHooksToml(o.events),
  );
}

/**
 * Кто чем настраивается. Ключи — ВЕСЬ список харнессов и ровно он: тип
 * Record<Harness, …> не даст ни забыть нового, ни оставить выдуманного.
 */
const PLANNERS: Record<Harness, (plan: Plan, o: WireOptions) => void> = {
  claude: planClaude,
  codex: planCodex,
  opencode: planOpencode,
  kimi: planKimi,
};

function planAgentsMd(plan: Plan, o: WireOptions): void {
  const rel = "AGENTS.md";
  const abs = join(o.root, rel);
  const current = fileText(abs);
  if (!o.agentsMd) {
    plan.untouched.push(`${rel} (needs --agents-md)`);
    return;
  }
  const next = replaceBlock(current ?? "", AGENTS_START, AGENTS_END, agentsBlock());
  if (current === next) {
    plan.actions.push({ path: rel, kind: "unchanged", detail: "block already in place", content: next, nodes: ["myc-block"], backup: false });
    return;
  }
  plan.actions.push({
    path: rel,
    kind: current === null ? "new" : "merge",
    detail: "block between the myc:start/myc:end markers",
    content: next,
    nodes: ["myc-block"],
    backup: current !== null,
    created: current === null,
  });
}

// ---------------------------------------------------------------------------
// Журнал
// ---------------------------------------------------------------------------

export interface JournalEntry {
  readonly path: string;
  readonly kind: ActionKind;
  readonly nodes: readonly string[];
  /** Хеш файла на момент записи: изменился — `unwire` не трогает файл. */
  readonly hash: string;
  /** Контейнеры, бывшие в файле до ПЕРВОГО wire (см. preexistingContainers). */
  readonly preexisting?: readonly string[];
  /**
   * Файл создал wire (его не было до ПЕРВОЙ записи). Сняв наши узлы и не найдя
   * в нём ничего чужого, `unwire` удаляет файл: «файла не было — файла нет».
   */
  readonly created?: boolean;
}

export interface Journal {
  readonly v: 1;
  readonly written_at: number;
  readonly agents: readonly string[];
  /**
   * `--hook-output`, с которым записывали. Нужен, чтобы сверка «установленное
   * против нынешней сборки» не считала расхождением ЧУЖОЙ выбор человека:
   * helper для `text` и для `json` — разные файлы, и без этого поля один из
   * двух всегда выглядел бы устаревшим. У журналов, записанных до появления
   * поля, его нет, и тогда сверка принимает любой из двух вариантов.
   */
  readonly hook_output?: "json" | "text";
  readonly entries: readonly JournalEntry[];
  /** Наша строка статуса и прежняя, которую она заменила (`--status-line`). */
  readonly status_line?: StatusLineRecord;
}

/**
 * Журнал установки, разобранный. `null` — файла нет или он битый: и то и другое
 * значит «не знаю», а не «не поставлено» (И2).
 */
export function readWireJournal(path: string): Journal | null {
  const raw = fileText(path);
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as Partial<Journal>;
    if (j === null || typeof j !== "object" || !Array.isArray(j.entries)) return null;
    const sl = j.status_line;
    const statusLine =
      sl !== undefined && sl !== null && typeof sl === "object" && typeof sl.path === "string"
        ? { status_line: { path: sl.path, previous: sl.previous ?? null, passthrough: sl.passthrough ?? "none" } }
        : {};
    return {
      v: 1,
      written_at: typeof j.written_at === "number" ? j.written_at : Number.NaN,
      agents: Array.isArray(j.agents) ? j.agents : [],
      ...(j.hook_output === "json" || j.hook_output === "text" ? { hook_output: j.hook_output } : {}),
      entries: j.entries as JournalEntry[],
      ...statusLine,
    };
  } catch {
    return null;
  }
}

/**
 * Файлы, которые myc генерирует ЦЕЛИКОМ, и содержимое, которое дала бы ИМЕННО
 * ЭТА сборка. Собирается теми же планировщиками, что и запись, — второй список
 * тех же путей разошёлся бы с ними молча, а признак «наш файл» здесь ровно тот
 * же, по которому `unwire` их удаляет: у записи нет узлов чужого конфига.
 *
 * Ради этой функции существует `myc doctor --hooks`-сверка устаревших хуков:
 * шаблон helper'а меняется от версии к версии, а на диске у человека лежит
 * файл, сгенерированный месяц назад, и заметить это было нечем
 * (memory-h12hjebzr0he: установленный helper не передавал `--session`, и вся
 * сессионная память была скрыта — принятая функция БЕЗДЕЙСТВОВАЛА).
 */
export function generatedFiles(
  root: string,
  events: readonly HookEvent[],
  hookOutput: "json" | "text",
): ReadonlyMap<string, string> {
  const plan = emptyPlan();
  const options: WireOptions = {
    root,
    events,
    hookOutput,
    mode: undefined,
    agentsMd: false,
    mycBin: { command: "myc", source: "none" },
    statusLine: false,
    previousJournal: null,
    env: {},
    platform: process.platform,
  };
  for (const harness of HARNESSES) PLANNERS[harness](plan, options);
  const out = new Map<string, string>();
  for (const a of plan.actions) if (a.nodes.length === 0) out.set(a.path, a.content);
  return out;
}

/** Хеш файла в том же виде, в каком его пишет журнал. */
export function wireHash(text: string): string {
  return sha256(text);
}

/**
 * Журнал остаётся в РАБОЧЕМ ДЕРЕВЕ, и это единственный side-файл, для
 * которого сторона именно такая.
 *
 * `wire` ставит конфиги харнесса (`.claude/`, `.opencode/`, `.mcp.json`) в то
 * дерево, из которого его позвали, — Claude Code читает `.claude` из СВОЕГО
 * рабочего дерева, общим на репозиторий он быть не может. Журнал перечисляет
 * ровно эти файлы, относительными путями и с хешем каждого, и по нему же
 * `unwire` их снимает. Уедь журнал к базе — в git worktree `unwire` сверял бы
 * хеши чужого дерева и снимал бы не то, что ставил.
 *
 * Всё ОСТАЛЬНОЕ в `.myc` принадлежит базе и живёт рядом с ней
 * (`StoreHandle.mycDir`): эпизоды, счётчик хуков, кеши. `myc doctor --hooks`
 * спрашивает у каждой стороны своё и говорит об этом вслух, когда каталоги
 * разошлись.
 */
function journalPath(root: string, ctx: CommandContext): string {
  const db = ctx.globals.db;
  const dir = db !== undefined ? dirname(resolve(db)) : join(root, ".myc");
  return join(dir, WIRE_JOURNAL);
}

function applyAction(root: string, action: Action): void {
  const abs = join(root, action.path);
  if (action.kind === "unchanged") return;
  mkdirSync(dirname(abs), { recursive: true });
  if (action.backup && existsSync(abs)) copyFileSync(abs, `${abs}${BAK_SUFFIX}`);
  writeFileSync(abs, action.content);
}

/**
 * Журнал после этого прогона — СЛИЯНИЕ с прежним, а не перезапись.
 *
 * Прежде журнал описывал только последний прогон: `myc wire --agents opencode`
 * после полного wire оставлял в нём две записи opencode, и `unwire` снимал бы
 * их, молча оставив хуки Claude, Codex, Kimi (memory-e272e38n0e3v, наступил
 * координатор на живом репозитории). Теперь записи этого прогона заменяют
 * прежние ПО ПУТИ, а прежние, которых план не касался, остаются: файлы других
 * агентов и файлы, которые нынешняя сборка больше не пишет, — `unwire` снимет
 * и их (по хешу, как всё остальное).
 *
 * В журнал идут ВСЕ файлы плана, включая неизменённые: журнал описывает
 * установленное состояние, а не разницу последнего запуска. Контейнеры «до
 * нас» берутся из ПЕРВОЙ записи файла: у повторного прогона наш же `hooks`
 * уже в файле, и назвать его «бывшим до нас» значило бы оставить его после
 * unwire пустым там, где его не было.
 */
function mergeJournal(prev: Journal | null, plan: Plan, agents: readonly Harness[], hookOutput: "json" | "text"): Journal {
  const prevByPath = new Map((prev?.entries ?? []).map((e) => [e.path, e] as const));
  const fresh: JournalEntry[] = plan.actions.map((a) => {
    const before = prevByPath.get(a.path);
    const preexisting = before !== undefined ? (before.preexisting ?? []) : (a.preexisting ?? []);
    // «Создан нами» — тоже из ПЕРВОЙ записи: повторный прогон видит файл уже
    // существующим. Запись без поля (старый журнал) — не знаем, значит не наш.
    const created = before !== undefined ? before.created === true : a.created === true;
    return {
      path: a.path,
      kind: a.kind,
      nodes: a.nodes,
      hash: sha256(a.content),
      ...(preexisting.length > 0 ? { preexisting } : {}),
      ...(created ? { created } : {}),
    };
  });
  const planned = new Set(fresh.map((e) => e.path));
  const kept = (prev?.entries ?? []).filter((e) => !planned.has(e.path));
  const allAgents = HARNESSES.filter((h) => agents.includes(h) || (prev?.agents ?? []).includes(h));
  // Выход хуков — выбор прогона. Разошлись прогоны — журнал честно не знает,
  // и doctor примет оба варианта (как у журналов до появления поля).
  const sameOutput = kept.length === 0 || prev?.hook_output === hookOutput;
  // Наша строка статуса живёт в файле Claude: не планировали Claude — запись о
  // прежней строке переезжает из старого журнала вместе с его записями.
  const statusLine = plan.statusLine ?? (agents.includes("claude") ? undefined : prev?.status_line);
  return {
    v: 1,
    written_at: Date.now(),
    agents: allAgents,
    ...(sameOutput ? { hook_output: hookOutput } : {}),
    entries: [...fresh, ...kept],
    ...(statusLine !== undefined ? { status_line: statusLine } : {}),
  };
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

const WIRE_FLAGS: readonly FlagSpec[] = [
  { name: "agents", value: "string", description: `${HARNESSES.join(",")} (default: all ${HARNESSES.length})` },
  { name: "dry-run", description: "print every file and change, write nothing" },
  { name: "agents-md", description: "also insert the myc block into AGENTS.md (opt-in)" },
  { name: "hook-mode", value: "string", description: "append|replace|skip — what to do when a foreign hook is already there" },
  { name: "hook-output", value: "string", description: "json|text — how the rescue packet reaches the agent (default json)" },
  {
    name: "status-line",
    description:
      "also put myc's line into Claude Code's statusLine; the line that was there keeps getting the same input (opt-in)",
  },
];

/**
 * Понимает ли бинарь из конфига команду `statusline`. Строка статуса,
 * указывающая на бинарь без этой команды, — хуже, чем никакой: код выхода
 * не 0, Claude Code не покажет ничего, и прежняя строка (orca) не получит
 * ввода вовсе. В этом репозитории так и вышло бы: `.mcp.json` смотрит на
 * `./dist/myc`, собранный до появления команды. Проверяется запуском — это
 * церемония человека, не горячий путь.
 */
export type StatusLineProbe = (root: string, bin: MycBinChoice) => { readonly ok: boolean; readonly why?: string };

export const probeStatusLineBin: StatusLineProbe = (root, bin) => {
  if (bin.source === "none") return { ok: false, why: "no myc executable found" };
  const exe = bin.source === "repo" ? join(root, bin.command) : bin.command;
  try {
    const r = Bun.spawnSync([exe, STATUSLINE_COMMAND, "--help"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    if (r.exitCode === 0 && r.stdout.toString().includes(STATUSLINE_COMMAND)) return { ok: true };
    const err = r.stderr.toString().trim().split("\n")[0] ?? "";
    return { ok: false, why: `${bin.command} ${STATUSLINE_COMMAND} --help: exit ${r.exitCode}${err.length > 0 ? ` (${err})` : ""}` };
  } catch (e) {
    return { ok: false, why: `${bin.command} does not start: ${e instanceof Error ? e.message : String(e)}` };
  }
};

export interface WireDeps {
  readonly probeStatusLine: StatusLineProbe;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

export interface WireData {
  readonly root: string;
  readonly agents: readonly string[];
  readonly events: readonly string[];
  readonly skipped_events: readonly { event: string; reason: string }[];
  readonly actions: readonly { path: string; action: ActionKind; detail: string }[];
  /** Чужие обработчики, убранные `--hook-mode replace`: поимённо. */
  readonly evicted: readonly Evicted[];
  readonly untouched: readonly string[];
  readonly notes: readonly string[];
  readonly dry_run: boolean;
  readonly changed: number;
  readonly journal: string | null;
  /** Записей прежних прогонов, сохранённых в журнале (этот прогон их не касался). */
  readonly journal_kept: number;
}

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

function parseAgents(raw: string | undefined): Harness[] | null {
  if (raw === undefined) return [...HARNESSES];
  const out: Harness[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    if (!(HARNESSES as readonly string[]).includes(part)) return null;
    out.push(part as Harness);
  }
  return out.length > 0 ? out : null;
}

export function createWireCommand(registry: Registry, overrides: Partial<WireDeps> = {}): Command {
  const deps: WireDeps = {
    probeStatusLine: probeStatusLineBin,
    env: process.env,
    platform: process.platform,
    ...overrides,
  };
  return {
    name: "wire",
    summary: "install myc hooks and MCP for Claude Code, Codex, opencode and Kimi without touching foreign files",
    flags: WIRE_FLAGS,
    help:
      "Writes only its own files in full (helper, skill, plugin); JSON configs are merged node by " +
      "node with a .myc.bak alongside. CLAUDE.md is never touched and AGENTS.md only with " +
      "--agents-md. A foreign hook on the same event is a conflict: nothing is written until " +
      "--hook-mode says what to do. Running wire twice changes nothing. statusLine is left alone " +
      "unless --status-line is given; then the line that was there (project, else user) keeps " +
      "receiving the same stdin, and unwire puts it back byte for byte.",
    handler: (ctx) => {
      // Фоновая проверка обновлений: no-op по умолчанию, при
      // MYC_UPDATE_CHECK=1 — отсоединённый процесс, которого wire не ждёт.
      // `wire` выбран точкой подключения потому, что это церемония ЧЕЛОВЕКА
      // (настройка агента в проекте), а не команда, которую агент зовёт в работе.
      maybeSpawnUpdateCheck();
      const root = resolve(ctx.globals.directory ?? process.cwd());
      const agents = parseAgents(flagStr(ctx, "agents"));
      if (agents === null) {
        return failure("usage.invalid", `--agents takes ${HARNESSES.join(", ")}`, ExitCode.USAGE);
      }

      const modeRaw = flagStr(ctx, "hook-mode");
      if (modeRaw !== undefined && !["append", "replace", "skip"].includes(modeRaw)) {
        return failure("usage.invalid", `--hook-mode takes append, replace, skip`, ExitCode.USAGE);
      }
      const mode = modeRaw as HookMode | undefined;

      const outRaw = flagStr(ctx, "hook-output") ?? "json";
      if (outRaw !== "json" && outRaw !== "text") {
        return failure("usage.invalid", "--hook-output takes json or text", ExitCode.USAGE);
      }

      // Хук на команду, которой в этой сборке нет, — обещание, которое некому
      // исполнить. Ставим только то, что реально отработает (И2).
      const available: HookEvent[] = [];
      const skipped: { event: string; reason: string }[] = [];
      for (const spec of HOOK_SPECS) {
        if (registry.hasTop(spec.command)) available.push(spec.event);
        else skipped.push({ event: spec.event, reason: `no \`myc ${spec.command}\` command in this build` });
      }
      if (!available.includes("pre-compact")) {
        return failure(
          "precond.missing_command",
          "no `myc absorb-session` command — nothing to install pre-compact on",
          ExitCode.PRECOND,
        );
      }

      const mycBin = resolveMycBin(root);
      const statusLine = ctx.flags["status-line"] === true;
      const options: WireOptions = {
        root,
        events: available,
        hookOutput: outRaw,
        mode,
        agentsMd: ctx.flags["agents-md"] === true,
        mycBin,
        statusLine,
        previousJournal: readWireJournal(journalPath(root, ctx)),
        env: deps.env,
        platform: deps.platform,
      };

      if (statusLine && agents.includes("claude")) {
        const probe = deps.probeStatusLine(root, mycBin);
        if (!probe.ok) {
          return failure(
            "precond.statusline_bin",
            `nowhere to install the status line: ${probe.why ?? "the binary does not answer"}. A line on that ` +
              "binary would show nothing and cut the previous line off from its input — nothing written",
            ExitCode.PRECOND,
            mycBin.source === "repo" ? "bun run build" : "MYC_BIN=<path to a fresh myc> myc wire --status-line",
          );
        }
      }

      // Порядок обхода — порядок HARNESSES, а не порядок в --agents: отчёт
      // должен читаться одинаково при любом написании флага.
      const plan = emptyPlan();
      for (const harness of HARNESSES) {
        if (agents.includes(harness)) PLANNERS[harness](plan, options);
      }
      planAgentsMd(plan, options);
      if (statusLine && !agents.includes("claude")) {
        plan.notes.push("the status line is installed only for Claude Code, which is not in --agents — statusLine left alone");
      }

      const slConflicts = plan.conflicts.filter((c) => c.node === "statusLine");
      if (slConflicts.length > 0) {
        return failure(
          "conflict.status_line",
          ["status line not installed, nothing written:", ...slConflicts.map((c) => `  ${c.path}: ${c.command}`)].join("\n"),
          ExitCode.CONFLICT,
        );
      }

      if (plan.conflicts.length > 0) {
        const lines = plan.conflicts.map((c) => `  ${c.path} → ${c.node}: ${c.command}`);
        return failure(
          "conflict.foreign_hook",
          [
            "foreign nodes where ours go, nothing written:",
            ...lines,
            "",
            "  --hook-mode append   add the myc hook second in the same array (recommended)",
            "  --hook-mode replace  replace it (a .myc.bak is kept)",
            "  --hook-mode skip     don't install this hook (myc loses context on compaction)",
          ].join("\n"),
          ExitCode.CONFLICT,
          "myc wire --hook-mode append",
        );
      }

      const dryRun = ctx.flags["dry-run"] === true;
      const changed = plan.actions.filter((a) => a.kind !== "unchanged").length;
      let journal: string | null = null;
      let journalKept = 0;

      if (!dryRun) {
        for (const action of plan.actions) applyAction(root, action);
        const jPath = journalPath(root, ctx);
        const doc = mergeJournal(options.previousJournal, plan, agents, outRaw);
        journalKept = doc.entries.length - plan.actions.length;
        try {
          mkdirSync(dirname(jPath), { recursive: true });
          writeFileSync(jPath, `${JSON.stringify(doc, null, 2)}\n`);
          journal = relative(root, jPath);
        } catch (e) {
          ctx.warn(
            "degraded.journal",
            `journal ${jPath} not written (${e instanceof Error ? e.message : String(e)}): myc unwire won't be able to remove the hooks`,
          );
        }
      }

      for (const skip of skipped) {
        ctx.warn("degraded.hook_missing", `hook ${skip.event} not installed: ${skip.reason}`);
      }

      // Конфиг записан, но команду в нём запустить нечем: MCP-сервер молча не
      // поднимется, и агент останется без инструментов myc на всю сессию.
      // Молчать здесь нельзя (И2) — сказать надо в момент wire, а не через час.
      if (mycBin.source === "none" && agents.includes("claude")) {
        ctx.warn(
          "degraded.bin_unresolved",
          "no myc executable found: not in MYC_BIN, node_modules/.bin/myc, dist/myc, " +
            ".myc/bin/myc, ~/.myc/bin/myc or PATH. .mcp.json says 'myc' — " +
            "the MCP server won't start until myc is on PATH or in MYC_BIN",
        );
      }

      const data: WireData = {
        root,
        agents,
        events: options.events,
        skipped_events: skipped,
        actions: plan.actions.map((a) => ({ path: a.path, action: a.kind, detail: a.detail })),
        evicted: plan.evicted,
        untouched: plan.untouched,
        notes: plan.notes,
        dry_run: dryRun,
        changed,
        journal,
        journal_kept: journalKept,
      };
      return { ok: true, data };
    },
    renderHuman: (data) => {
      const d = data as WireData;
      const verb = d.dry_run ? "would write:" : "written:";
      const lines: string[] = [verb];
      const width = Math.max(...d.actions.map((a) => a.path.length), 10);
      for (const a of d.actions) {
        lines.push(`  ${a.action.padEnd(9)} ${a.path.padEnd(width)}  ${a.detail}`);
      }
      if (d.untouched.length > 0) lines.push(`untouched: ${d.untouched.join(", ")}`);
      // Вытесненное печатается ПЕРЕД служебными заметками и журналом: это
      // единственная строка отчёта, за которой стоит потеря чужой работы, а не
      // наша собственная запись. Каждый обработчик назван — событие и команда, —
      // иначе человек узнает цену выбора, только когда что-то перестанет
      // работать (memory-vspyaxt3edvn).
      if (d.evicted.length > 0) {
        const paths = [...new Set(d.evicted.map((e) => e.path))];
        lines.push(
          `evicted by --hook-mode replace: ${d.evicted.length} foreign ${d.evicted.length === 1 ? "handler" : "handlers"}`,
        );
        for (const e of d.evicted) {
          const at = e.matcher !== undefined ? `${e.event}[${e.matcher}]` : e.event;
          lines.push(`  ${e.path} → ${at}: ${e.command}`);
        }
        lines.push(
          d.dry_run
            ? `  to restore: they stay in place — nothing written (--dry-run)`
            : `  to restore: ${paths.map((p) => `cp ${p}${BAK_SUFFIX} ${p}`).join(" && ")}`,
        );
      }
      for (const note of d.notes) lines.push(`! ${note}`);
      if (d.journal !== null) {
        const kept = d.journal_kept > 0 ? `; entries kept from earlier runs: ${d.journal_kept}` : "";
        lines.push(`journal: ${d.journal} (for myc unwire${kept})`);
      }
      if (d.dry_run) lines.push("nothing written (--dry-run)");
      else if (d.changed === 0) lines.push("everything already in place, no files touched");
      // Обновление — новость для человека, и только для него: в конверте
      // --json этой строки нет (решение 2). Сети здесь тоже нет — кеш.
      const notice = updateNoticeFor(CLI_VERSION);
      if (notice !== null) lines.push(notice);
      return `${lines.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// unwire
// ---------------------------------------------------------------------------

export interface UnwireData {
  readonly removed: readonly string[];
  readonly kept: readonly { path: string; reason: string }[];
  /** Записи журнала, чьих файлов уже нет: снимать было нечего. */
  readonly gone: readonly string[];
  readonly dry_run: boolean;
}

/**
 * Снимает наши узлы из JSON-конфига, не трогая чужие. Свои узнаём по тем же
 * признакам, по которым ставили: имя helper-файла в команде хука и ключ `myc`
 * в списках серверов. Ключ журнала здесь не нужен — он уже сделал свою работу,
 * подтвердив, что файл с момента записи не менялся.
 *
 * Строка статуса — единственный узел, который не удаляется, а ВОЗВРАЩАЕТСЯ:
 * была до нас проектная — на её место (присваивание существующему ключу не
 * двигает его), не было ключа — ключа не будет. `previous` — из журнала, и
 * только для того файла, куда её ставили; чужая строка без нашей команды не
 * трогается никогда.
 */
function stripJsonNodes(
  value: Record<string, unknown>,
  previousStatusLine?: { readonly previous: unknown },
  keep: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const out = { ...value };
  if (isOurStatusLine(out["statusLine"])) {
    const prev = previousStatusLine?.previous;
    if (prev !== undefined && prev !== null) out["statusLine"] = prev;
    else delete out["statusLine"];
  }
  const hooks = asRecord(out["hooks"]);
  let hooksTouched = false;
  for (const key of Object.keys(hooks)) {
    const rest = asArray(hooks[key]).filter((e) => !isOurHookEntry(e));
    hooksTouched = true;
    if (rest.length === 0 && !keep.has(`hooks.${key}`)) delete hooks[key];
    else hooks[key] = rest;
  }
  if (hooksTouched) {
    if (Object.keys(hooks).length === 0 && !keep.has("hooks")) delete out["hooks"];
    else out["hooks"] = hooks;
  }
  const permissions = asRecord(out["permissions"]);
  if (Array.isArray(permissions["allow"])) {
    const allow = (permissions["allow"] as unknown[]).filter((a) => a !== MYC_PERMISSION);
    if (allow.length === 0 && !keep.has("permissions.allow")) delete permissions["allow"];
    else permissions["allow"] = allow;
    if (Object.keys(permissions).length === 0 && !keep.has("permissions")) delete out["permissions"];
    else out["permissions"] = permissions;
  }
  const servers = asRecord(out["mcpServers"]);
  if (servers["myc"] !== undefined) {
    delete servers["myc"];
    if (Object.keys(servers).length === 0 && !keep.has("mcpServers")) delete out["mcpServers"];
    else out["mcpServers"] = servers;
  }
  const mcp = asRecord(out["mcp"]);
  if (mcp["myc"] !== undefined) {
    delete mcp["myc"];
    if (Object.keys(mcp).length === 0 && !keep.has("mcp")) delete out["mcp"];
    else out["mcp"] = mcp;
  }
  return out;
}

export function createUnwireCommand(): Command {
  return {
    name: "unwire",
    summary: "remove exactly what `myc wire` installed, by the .myc/wire.json journal",
    flags: [{ name: "dry-run", description: "print what would be removed, change nothing" }],
    help:
      "Files changed after we wrote them are left alone and reported: a journal hash mismatch " +
      "means a human edited the file, and removing our node blind would be the same trust " +
      "breach as writing it blind.",
    handler: (ctx) => {
      const root = resolve(ctx.globals.directory ?? process.cwd());
      const jPath = journalPath(root, ctx);
      const raw = fileText(jPath);
      if (raw === null) {
        return failure("notfound.journal", `no journal ${jPath}: nothing to remove`, ExitCode.NOTFOUND, "myc wire");
      }
      let journal: Journal;
      try {
        journal = JSON.parse(raw) as Journal;
      } catch (e) {
        return failure("io.read", `journal can't be parsed: ${e instanceof Error ? e.message : String(e)}`, ExitCode.ERR);
      }

      const dryRun = ctx.flags["dry-run"] === true;
      const removed: string[] = [];
      const kept: { path: string; reason: string }[] = [];
      // Файла уже нет — снимать нечего, и держать журнал ради него незачем:
      // иначе один удалённый руками файл навсегда оставлял бы журнал.
      const gone: string[] = [];

      for (const entry of journal.entries) {
        const abs = join(root, entry.path);
        const current = fileText(abs);
        if (current === null) {
          gone.push(entry.path);
          continue;
        }
        if (sha256(current) !== entry.hash) {
          kept.push({ path: entry.path, reason: "changed after we wrote it — left alone" });
          continue;
        }
        if (entry.nodes.length === 0) {
          if (!dryRun) rmSync(abs, { force: true });
          removed.push(entry.path);
          continue;
        }
        // Файл создал wire, и после снятия наших узлов в нём не осталось
        // ничего чужого — его не было, значит не будет и теперь. Файл, бывший
        // до нас, остаётся даже пустым: удалять чужое — не наше дело.
        const created = entry.created === true;
        const writeOrDrop = (next: string, empty: boolean, label: string): void => {
          if (created && empty) {
            if (!dryRun) rmSync(abs, { force: true });
            removed.push(`${entry.path} (${label}; file created by wire — deleted)`);
          } else {
            if (!dryRun) writeFileSync(abs, next);
            removed.push(`${entry.path} (${label})`);
          }
        };
        if (entry.path.endsWith(".md")) {
          const next = removeBlock(current, AGENTS_START, AGENTS_END);
          writeOrDrop(next, next.trim().length === 0, "the myc block");
          continue;
        }
        if (entry.path.endsWith(".toml")) {
          let next = removeBlock(current, TOML_NOTIFY_START, TOML_NOTIFY_END);
          next = removeBlock(next, TOML_MCP_START, TOML_MCP_END);
          writeOrDrop(next, next.trim().length === 0, "the myc blocks");
          continue;
        }
        const source = readJsonSource(abs);
        if (source.broken) {
          kept.push({ path: entry.path, reason: "not valid JSON" });
          continue;
        }
        const sl = journal.status_line;
        const own = sl !== undefined && sl !== null && sl.path === entry.path ? sl : undefined;
        const keep = new Set(Array.isArray(entry.preexisting) ? entry.preexisting : []);
        const stripped = stripJsonNodes(source.value, own, keep);
        const restored =
          isOurStatusLine(source.value["statusLine"]) && own?.previous !== undefined && own.previous !== null
            ? "; previous statusLine restored"
            : "";
        // В созданный нами opencode.json мы же положили и `$schema` — снимается с ним.
        const rest = { ...stripped };
        if (created && rest["$schema"] === OPENCODE_SCHEMA) delete rest["$schema"];
        writeOrDrop(serializeJson(stripped, source.indent), Object.keys(rest).length === 0, `${entry.nodes.join(", ")}${restored}`);
      }

      if (!dryRun && kept.length === 0) rmSync(jPath, { force: true });

      const data: UnwireData = { removed, kept, gone, dry_run: dryRun };
      return { ok: true, data };
    },
    renderHuman: (data) => {
      const d = data as UnwireData;
      const lines = [d.dry_run ? "would remove:" : "removed:"];
      for (const r of d.removed) lines.push(`  - ${r}`);
      for (const k of d.kept) lines.push(`  ! ${k.path}: ${k.reason}`);
      for (const g of d.gone) lines.push(`  · ${g}: file already gone`);
      if (d.removed.length === 0) lines.push("  (nothing to remove)");
      return `${lines.join("\n")}\n`;
    },
  };
}
