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
 *    Хук очереди (PreToolUse на Bash) — только с `--queue-hook`.
 * 5. Повторный `wire` идемпотентен: те же файлы, байт в байт.
 *
 * Всё записанное попадает в журнал `.myc/wire.json` вместе с хешем файла на
 * момент записи — `myc unwire` снимает только то, что поставил, и только если
 * файл с тех пор не изменился.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure, CommandResult, Registry } from "../registry.ts";
import { flagStr } from "./store.ts";
import { maybeSpawnUpdateCheck, updateNoticeFor } from "../update-check.ts";
import { CLI_VERSION } from "../index.ts";
import { HARNESSES, type Harness } from "@myc/swarm";
import {
  isOurStatusLine,
  isOurStatusLineCommand,
  ORCA_STATUSLINE_MARK,
  orcaClaimsStatusLine,
  ourStatusLineCommand,
  ourUserStatusLineCommand,
  readStatusLine,
  recordedUserStatusLine,
  shellQuote,
  STATUSLINE_COMMAND,
  statusLineCommand,
  USER_JOURNAL,
  userJournalPath,
  userSettingsPath,
} from "../statusline-config.ts";
import {
  AGENTS_END,
  AGENTS_START,
  agentsBlock,
  claudeHelper,
  claudeUserHelper,
  withUserScopeGuard,
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
import {
  QUEUE_ENV,
  QUEUE_HELPER_MARK,
  QUEUE_HELPER_REL,
  queueHelper,
  queueHookCommand,
  queueHookEntry,
} from "../hooks/queue-hook.ts";
import { ensureMycGitignore } from "../myc-gitignore.ts";

export const WIRE_JOURNAL = "wire.json";
const BAK_SUFFIX = ".myc.bak";
const HELPER_MARK = "myc-hooks.mjs";
/**
 * ПРАВА. Прежде wire писал одно правило — `Bash(myc:*)`, и оно было обходом
 * системы разрешений: `myc run -- X` исполняет ПРОИЗВОЛЬНУЮ команду X, а
 * Claude Code сверяет правило с текстом всей команды, то есть `myc run -- rm
 * -rf …` проходил без вопроса человеку. Порядок проверки в 2.1.267 (прочитано в
 * бинаре, функция разрешений рядом с `Permission to use ${e.name} has been
 * denied.`): deny-правило целиком на инструмент → deny-правила по содержимому →
 * ask целиком на инструмент → проверка самого Bash (allow-правила по префиксу,
 * по подкомандам) → ask-правила по содержимому → режим bypassPermissions →
 * allow целиком на инструмент → иначе вопрос. Префиксное `X:*` совпадает с
 * командой `X` или `X …`, обёрток вроде `myc run` Claude Code не снимает
 * (снимает только time/nohup/timeout/nice/stdbuf/env/command/xargs/sudo…).
 *
 * Поэтому теперь: разрешение на КАЖДУЮ подкоманду из реестра, кроме тех, что
 * исполняют переданную им команду или переписывают права и хуки самого агента
 * (ASK_SUBCOMMANDS), — их Claude Code спрашивает, и в вопросе видна вся
 * команда. Прежнее широкое правило в файле, который ведёт наш журнал, wire
 * снимает сам (миграция); в чужом — не трогает, но говорит о нём вслух.
 */
const LEGACY_PERMISSION = "Bash(myc:*)";

/**
 * Подкоманды, на которые wire разрешения не даёт. Список исключений, а не
 * второй список команд: разрешённые берутся из реестра (mycPermissions), и
 * новая команда получает разрешение сама, если её нет здесь. Каждая строка —
 * с причиной; сторож — wire.permissions.test.ts (имя обязано быть в реестре).
 */
export const ASK_SUBCOMMANDS: ReadonlyMap<string, string> = new Map([
  ["run", "executes the command given to it"],
  ["statusline", "--then executes a shell command"],
  ["wire", "rewrites the agent's own hooks and permissions"],
  ["unwire", "rewrites the agent's own hooks and permissions"],
]);

/** `Bash(myc <команда>:*)` на каждую команду реестра, кроме ASK_SUBCOMMANDS, по алфавиту. */
export function mycPermissions(registry: Registry): string[] {
  return registry.top
    .map((c) => c.name)
    .filter((name) => !ASK_SUBCOMMANDS.has(name))
    .sort()
    .map((name) => `Bash(myc ${name}:*)`);
}

/** Наше ли правило: разрешение на подкоманду myc или прежнее широкое. */
function isOurPermission(rule: unknown): boolean {
  return typeof rule === "string" && (rule === LEGACY_PERMISSION || /^Bash\(myc [a-z][a-z0-9-]*:\*\)$/.test(rule));
}
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

/**
 * Наша ли команда хука — по имени helper-файла в ней. Helper'ов два: общий
 * (`myc-hooks.mjs`) и хука очереди (`myc-queue.mjs`, только с `--queue-hook`).
 */
function isOurCommand(cmd: string): boolean {
  return cmd.includes(HELPER_MARK) || cmd.includes(QUEUE_HELPER_MARK);
}

/** Наша ли это запись хука — узнаём по имени helper-файла в команде. */
function isOurHookEntry(entry: unknown): boolean {
  const hooks = asArray(asRecord(entry)["hooks"]);
  return hooks.some((h) => {
    const cmd = asRecord(h)["command"];
    return typeof cmd === "string" && isOurCommand(cmd);
  });
}

/** Наша запись хука очереди в `hooks.PreToolUse`, как лежит в файле, или null. */
function ourQueueEntry(value: Record<string, unknown>): Record<string, unknown> | null {
  for (const entry of asArray(asRecord(value["hooks"])["PreToolUse"])) {
    const hooks = asArray(asRecord(entry)["hooks"]);
    const ours = hooks.some((h) => {
      const cmd = asRecord(h)["command"];
      return typeof cmd === "string" && cmd.includes(QUEUE_HELPER_MARK);
    });
    if (ours) return asRecord(entry);
  }
  return null;
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
    if (typeof cmd === "string" && !isOurCommand(cmd)) out.push(cmd);
  }
  return out;
}

/** Матчер записи — часть её адреса: два хука на PostToolUse различает он. */
function entryMatcher(entry: unknown): string | undefined {
  const m = asRecord(entry)["matcher"];
  return typeof m === "string" && m.length > 0 ? m : undefined;
}

/**
 * Таймаут записи хука для хоста — В СЕКУНДАХ, и у Claude Code, и у Codex.
 *
 * У Claude Code это прочитано в бинаре 2.1.267: схема записи —
 * `timeout:A().positive().optional().describe("Timeout in seconds for this
 * specific command")`, исполнитель — `yn=e.timeout?e.timeout*1000:Yf`.
 * До этой правки сюда шли миллисекунды (`spec.timeoutMs`), то есть 3000 у
 * session-start значило 50 минут, а 8000 у pre-compact — больше двух часов:
 * хост не оборвал бы зависший хук никогда. Спасал только внутренний LIMIT
 * helper'а. Повторный wire переписывает наши записи целиком (mergeHookNodes),
 * так что старые значения уходят сами, а чужие записи не трогаются.
 */
function hostTimeoutSeconds(spec: HookSpec): number {
  return Math.max(1, Math.ceil(spec.timeoutMs / 1000));
}

function claudeHookEntry(spec: HookSpec): Record<string, unknown> {
  const command = `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/myc-hooks.mjs" ${spec.event}`;
  const entry: Record<string, unknown> = {
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    hooks: [{ type: "command", command, timeout: hostTimeoutSeconds(spec) }],
  };
  return entry;
}

/**
 * Запись хука для `.codex/hooks.json`. Форма та же, что у Claude Code, и
 * `timeout` там тоже в СЕКУНДАХ (`hook.timeout_sec` внутри codex).
 */
function codexHookEntry(spec: HookSpec): Record<string, unknown> {
  return {
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    hooks: [
      {
        type: "command",
        command: codexHookCommand(spec.event),
        timeout: hostTimeoutSeconds(spec),
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

/** Что и куда ставим: событие хоста и наша запись для него. */
interface Placement {
  readonly event: string;
  readonly entry: Record<string, unknown>;
}

/**
 * Точечный merge массивов `hooks.<Event>` в чужом JSON-конфиге. Общий для
 * Claude Code (`.claude/settings.json`) и Codex (`.codex/hooks.json`): форма
 * записи у них одна, различаются только команда и единица таймаута, и обе
 * уже в `placements`. Две копии этой функции разъехались бы молча — а
 * вытеснение чужих хуков считается самым дорогим, что здесь происходит.
 */
function mergeHookNodes(
  source: JsonSource,
  placements: readonly Placement[],
  mode: HookMode | undefined,
  relPath: string,
): SettingsPlan {
  const value: Record<string, unknown> = { ...source.value };
  const hooks = asRecord(value["hooks"]);
  const nodes: string[] = [];
  const conflicts: Conflict[] = [];
  const evicted: Evicted[] = [];
  const notes: string[] = [];

  for (const { event, entry: ours } of placements) {
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
    hooks[event] = [...kept, ours];
    nodes.push(node);
  }

  if (conflicts.length > 0) return { nodes, conflicts, evicted, notes, value };
  if (nodes.length > 0) value["hooks"] = hooks;
  return { nodes, conflicts, evicted, notes, value };
}

/** Что `.claude/settings.json` получает в `permissions.allow` (см. LEGACY_PERMISSION). */
interface PermissionPlan {
  /** `Bash(myc <команда>:*)` — из реестра, без ASK_SUBCOMMANDS. */
  readonly rules: readonly string[];
  /** Файл ведёт наш журнал: прежнее `Bash(myc:*)` в нём поставил wire, и wire его снимает. */
  readonly legacyOurs: boolean;
}

/**
 * `.claude/settings.json`: те же узлы `hooks.<Event>` плюс `permissions.allow`.
 * Всё остальное — включая `statusLine` — не читается и не пишется. `extra` —
 * записи не из HOOK_SPECS (хук очереди на PreToolUse): они не зовут команду
 * myc, и таблица событий §6.1 им не место.
 */
function mergeClaudeSettings(
  source: JsonSource,
  specs: readonly HookSpec[],
  mode: HookMode | undefined,
  relPath: string,
  extra: readonly Placement[],
  perms: PermissionPlan,
): SettingsPlan {
  const placements = [...specs.map((s) => ({ event: s.claudeEvent, entry: claudeHookEntry(s) })), ...extra];
  const base = mergeHookNodes(source, placements, mode, relPath);
  if (base.conflicts.length > 0) return base;
  const value = { ...base.value };
  const nodes = [...base.nodes];
  const notes = [...(base.notes ?? [])];

  const permissions = asRecord(value["permissions"]);
  let allow = asArray(permissions["allow"]);
  let changed = false;
  if (allow.includes(LEGACY_PERMISSION)) {
    if (perms.legacyOurs) {
      allow = allow.filter((a) => a !== LEGACY_PERMISSION);
      changed = true;
      notes.push(
        `${relPath}: removed the old permissions.allow[${LEGACY_PERMISSION}] — it let \`myc run -- <any command>\` ` +
          `run without asking; myc subcommands are now allowed one by one, and ${[...ASK_SUBCOMMANDS.keys()].join(", ")} ask`,
      );
    } else {
      notes.push(
        `${relPath}: permissions.allow has ${LEGACY_PERMISSION}, which lets \`myc run -- <any command>\` run without ` +
          "asking — wire did not write it and leaves it alone; remove it by hand",
      );
    }
  }
  const added = perms.rules.filter((r) => !allow.includes(r));
  if (added.length > 0 || changed) {
    permissions["allow"] = [...allow, ...added];
    value["permissions"] = permissions;
  }
  if (added.length > 0) {
    nodes.push(`permissions.allow[${added.length === 1 ? added[0] : `Bash(myc <command>:*) ×${added.length}`}]`);
  }

  return { ...base, nodes, notes, value };
}

/** `.codex/hooks.json`: только узлы `hooks.<Event>`, без permissions. */
function mergeCodexHooks(
  source: JsonSource,
  specs: readonly HookSpec[],
  mode: HookMode | undefined,
  relPath: string,
): SettingsPlan {
  return mergeHookNodes(source, specs.map((s) => ({ event: s.claudeEvent, entry: codexHookEntry(s) })), mode, relPath);
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
    const has = Array.isArray(allow) && allow.some(isOurPermission);
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
  /**
   * `--queue-hook`: myc, проверенный на `run`, — его команду получит хук
   * очереди. null — флага нет (стоящий хук сохраняется как есть).
   */
  readonly queueBin: QueueBinChoice | null;
  /** `Bash(myc <команда>:*)` для `.claude/settings.json` — из реестра (mycPermissions). */
  readonly permissions: readonly string[];
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
  const queue = planQueueHook(plan, o, settings);
  const perms: PermissionPlan = {
    rules: o.permissions,
    legacyOurs: o.previousJournal?.entries.some((e) => e.path === settings) ?? false,
  };
  planJsonMerge(plan, o.root, settings, (source) => {
    const extra = queue === null ? [] : [{ event: "PreToolUse", entry: queue }];
    const base = mergeClaudeSettings(source, specs, o.mode, settings, extra, perms);
    return base.conflicts.length > 0 ? base : withStatusLine(base, o, settings);
  });
  // Пользовательский слой wire не пишет (D10), но широкое правило там —
  // тот же обход, что было наше прежнее, и молчать о нём нельзя.
  const userPath = userSettingsPath(o.env);
  const userAllow = asArray(asRecord(readJsonSource(userPath).value["permissions"])["allow"]);
  const broad = userAllow.find((r) => r === LEGACY_PERMISSION || r === "Bash(myc run:*)");
  if (broad !== undefined) {
    plan.notes.push(
      `${userPath}: permissions.allow has ${String(broad)}, so \`myc run -- <any command>\` runs without asking in ` +
        "every project; with --queue-hook the hook asks instead, otherwise remove it by hand (wire does not write there)",
    );
  }
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

/**
 * Хук очереди (`--queue-hook`, hooks/queue-hook.ts): PreToolUse на Bash,
 * который отправляет тяжёлую команду агента через `myc run`.
 *
 * Как у строки статуса: без флага не ставится, но стоящий — наш, от прежнего
 * `wire --queue-hook` — сохраняется как лежит: иначе обычный `wire`, которым
 * обновляют helper'ы, молча снимал бы выбор человека. Снимает его `unwire`.
 * Helper при этом переписывается под нынешнюю сборку — он от выбора не зависит.
 */
function planQueueHook(plan: Plan, o: WireOptions, settings: string): Record<string, unknown> | null {
  let entry = ourQueueEntry(readJsonSource(join(o.root, settings)).value);
  if (o.queueBin !== null) {
    entry = queueHookEntry(o.queueBin.command);
    plan.notes.push(
      `${settings}: hooks.PreToolUse[Bash] — a heavy command (a full test run, a build) goes through ` +
        `\`myc run -- …\` with ${o.queueBin.command} (${o.queueBin.source}); it is approved without asking only ` +
        "when your own rules allow the original command (e.g. Bash(bun test:*)), otherwise Claude Code asks and " +
        `shows the whole command; the built-in patterns can be replaced with ${QUEUE_ENV}`,
    );
  }
  if (entry === null) {
    plan.untouched.push(`${settings}:hooks.PreToolUse (needs --queue-hook)`);
    return null;
  }
  planOwnFile(plan, o.root, QUEUE_HELPER_REL, queueHelper());
  return entry;
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
  let viaUserLayer = false;
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
    } else if (userCmd !== null) {
      // Пользовательская строка — сама myc (`wire --scope user --status-line`):
      // на отрисовке `myc statusline` отдаёт ввод той, что она заменила, —
      // она записана в журнале пользовательского слоя.
      const recorded = recordedUserStatusLine(o.env)?.previous;
      const recordedCmd = statusLineCommand(recorded);
      if (recordedCmd !== null && !isOurStatusLineCommand(recordedCmd)) {
        passthrough = "user";
        foreignCmd = recordedCmd;
        carrier = recorded;
        viaUserLayer = true;
      }
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
  } else if (passthrough === "user" && viaUserLayer) {
    notes.push(
      `${rel}: statusLine is ours; the user line is myc's too (myc wire --scope user --status-line), and the line it replaced, ` +
        `"${shortCommand(foreignCmd ?? "")}", gets the same stdin (read from ${userJournalPath(o.env) ?? "~/.myc/wire-user.json"} on every redraw), ${wait}`,
    );
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
    // Helper очереди от выбранного myc не зависит (тот едет в settings.json
    // аргументом), поэтому свежесть стоящего сверяется и без проверки бинаря.
    queueBin: { command: "myc", source: "path" },
    permissions: [],
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

const SCOPE_FLAG: FlagSpec = {
  name: "scope",
  value: "string",
  description:
    "project (default) — this tree; user — Claude Code's user layer (~/.claude), for agents in git worktrees " +
    "and nested repos where the project layer has no myc",
};

const WIRE_FLAGS: readonly FlagSpec[] = [
  SCOPE_FLAG,
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
  {
    name: "queue-hook",
    description:
      "also install a Claude Code PreToolUse hook that runs heavy Bash commands (full test runs, builds) through `myc run` (opt-in)",
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

/**
 * Каким myc хук очереди будет оборачивать команды. Выбирается при wire и
 * ПРОВЕРЯЕТСЯ запуском `<myc> run --help`, а не угадывается в каждом вызове
 * хука: myc без `run` превратил бы каждый `bun test` агента в «unknown
 * command 'run'» — тяжёлая команда не выполнилась бы вовсе. В этом
 * репозитории так и есть: `node_modules/.bin/myc` — опубликованный 0.1.0, а
 * `myc` в PATH — 0.3.0, и `run` нет ни у того, ни у другого.
 *
 * Порядок: MYC_BIN (явный выбор человека), затем `myc` из PATH — слово `myc`
 * в начале команды покрывает правило `Bash(myc:*)`, которое ставит сам wire,
 * и команда проходит проверку разрешений так же, как если бы агент набрал её
 * сам; затем сборки в проекте и ~/.myc/bin. Путь в проекте пишется
 * относительным (helper достраивает его от CLAUDE_PROJECT_DIR): settings.json
 * общий для команды, домашнему пути одного разработчика там не место.
 */
export interface QueueBinChoice {
  /** Что получит хук: `myc` (ищется в PATH), путь от корня проекта или абсолютный. */
  readonly command: string;
  readonly source: "env" | "path" | "repo" | "home";
}

export type QueueProbe = (
  root: string,
  env: NodeJS.ProcessEnv,
) => { readonly ok: true; readonly bin: QueueBinChoice } | { readonly ok: false; readonly why: string };

export const probeQueueBin: QueueProbe = (root, env) => {
  const candidates: { command: string; exe: string; source: QueueBinChoice["source"] }[] = [];
  const own = env.MYC_BIN;
  if (own !== undefined && own.length > 0) candidates.push({ command: resolve(root, own), exe: resolve(root, own), source: "env" });
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir.length > 0 && existsSync(join(dir, "myc"))) {
      candidates.push({ command: "myc", exe: join(dir, "myc"), source: "path" });
      break;
    }
  }
  for (const rel of ["node_modules/.bin/myc", "dist/myc", ".myc/bin/myc"]) {
    candidates.push({ command: rel, exe: join(root, rel), source: "repo" });
  }
  if (env.HOME !== undefined && env.HOME.length > 0) {
    const home = join(env.HOME, ".myc/bin/myc");
    candidates.push({ command: home, exe: home, source: "home" });
  }
  const tried: string[] = [];
  for (const c of candidates) {
    if (!existsSync(c.exe)) {
      if (c.source === "env") tried.push(`MYC_BIN=${c.command} (no such file)`);
      continue;
    }
    try {
      const r = Bun.spawnSync([c.exe, "run", "--help"], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (r.exitCode === 0 && r.stdout.toString().includes("myc run")) return { ok: true, bin: { command: c.command, source: c.source } };
      const err = r.stderr.toString().trim().split("\n")[0] ?? "";
      tried.push(`${c.command} run --help: exit ${r.exitCode}${err.length > 0 ? ` (${err})` : ""}`);
    } catch (e) {
      tried.push(`${c.command} does not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    ok: false,
    why:
      tried.length > 0
        ? `no myc here knows \`run\` — ${tried.join("; ")}`
        : "no myc executable found in MYC_BIN, PATH, node_modules/.bin, dist, .myc/bin or ~/.myc/bin",
  };
};

export interface WireDeps {
  readonly probeStatusLine: StatusLineProbe;
  readonly probeQueue: QueueProbe;
  /** `--scope user`: отвечает ли выбранный myc пустым списком инструментов вне воркспейса. */
  readonly probeMcp: McpProbe;
  /** `--scope user --status-line`: знает ли выбранный myc `statusline --scope user`. */
  readonly probeUserStatusLine: UserStatusLineProbe;
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

/** `--scope`: project по умолчанию; null — значение, которого нет. */
function parseScope(ctx: CommandContext): "project" | "user" | null {
  const raw = flagStr(ctx, "scope") ?? "project";
  return raw === "project" || raw === "user" ? raw : null;
}

/**
 * Хук на команду, которой в этой сборке нет, — обещание, которое некому
 * исполнить. Ставим только то, что реально отработает (И2). Один расчёт на
 * оба слоя: проектный и пользовательский ставят одни и те же события.
 */
function availableEvents(registry: Registry): { available: HookEvent[]; skipped: { event: string; reason: string }[] } {
  const available: HookEvent[] = [];
  const skipped: { event: string; reason: string }[] = [];
  for (const spec of HOOK_SPECS) {
    if (registry.hasTop(spec.command)) available.push(spec.event);
    else skipped.push({ event: spec.event, reason: `no \`myc ${spec.command}\` command in this build` });
  }
  return { available, skipped };
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
    probeQueue: probeQueueBin,
    probeMcp: probeUserMcpBin,
    probeUserStatusLine: probeUserStatusLineBin,
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
      "receiving the same stdin, and unwire puts it back byte for byte. --queue-hook adds a " +
      "PreToolUse hook on Bash that rewrites a heavy command (a full test run, a build) into " +
      "`myc run -- <the same command>`, so agents on one machine take turns; without the flag no " +
      "such hook is written, and unwire removes it. --scope user wires Claude Code's user layer " +
      "(~/.claude) instead of the project: for agents in git worktrees and nested repos whose " +
      "project layer has no myc. Its helper exits at once where there is no myc workspace or the " +
      "project wires myc itself; foreign hooks on the same event stay (append is the default, " +
      "replace is refused); statusLine only with --status-line: myc's line (the full line in a myc " +
      "workspace, nothing of its own outside one), the line that was there is kept in the journal and " +
      "keeps getting the same input, and unwire puts it back; the MCP server is registered with " +
      "`claude mcp add --scope user`; the journal is ~/.myc/wire-user.json.",
    handler: (ctx) => {
      // Фоновая проверка обновлений: no-op по умолчанию, при
      // MYC_UPDATE_CHECK=1 — отсоединённый процесс, которого wire не ждёт.
      // `wire` выбран точкой подключения потому, что это церемония ЧЕЛОВЕКА
      // (настройка агента в проекте), а не команда, которую агент зовёт в работе.
      maybeSpawnUpdateCheck();
      const scope = parseScope(ctx);
      if (scope === null) return failure("usage.invalid", "--scope takes project or user", ExitCode.USAGE);
      if (scope === "user") return wireUser(ctx, registry, deps);
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

      const { available, skipped } = availableEvents(registry);
      if (!available.includes("pre-compact")) {
        return failure(
          "precond.missing_command",
          "no `myc absorb-session` command — nothing to install pre-compact on",
          ExitCode.PRECOND,
        );
      }

      const mycBin = resolveMycBin(root);
      const statusLine = ctx.flags["status-line"] === true;

      // Хук очереди — только Claude Code и только на myc, который знает `run`
      // (проверяется запуском): хук на myc без `run` превращал бы каждую
      // тяжёлую команду агента в ошибку. Ничего не записано, пока не выяснено.
      const queueNotes: string[] = [];
      let queueBin: QueueBinChoice | null = null;
      if (ctx.flags["queue-hook"] === true) {
        if (!agents.includes("claude")) {
          queueNotes.push("the queue hook is installed only for Claude Code, which is not in --agents — hooks.PreToolUse left alone");
        } else if (deps.platform === "win32") {
          queueNotes.push(
            "queue hook not installed: its command is a POSIX shell snippet and myc run was not checked on Windows",
          );
        } else {
          const probe = deps.probeQueue(root, deps.env);
          if (!probe.ok) {
            return failure(
              "precond.queue_bin",
              `nowhere to queue heavy commands through: ${probe.why}. A hook on a myc without \`run\` would turn ` +
                "every heavy command into an error — nothing written",
              ExitCode.PRECOND,
              "MYC_BIN=<path to a fresh myc> myc wire --queue-hook",
            );
          }
          queueBin = probe.bin;
        }
      }

      const options: WireOptions = {
        root,
        events: available,
        hookOutput: outRaw,
        mode,
        agentsMd: ctx.flags["agents-md"] === true,
        mycBin,
        statusLine,
        queueBin,
        permissions: mycPermissions(registry),
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
      plan.notes.push(...queueNotes);

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
          // Журнал с абсолютными путями этой машины не должен уехать в git
          // проекта; воркспейсу от старой сборки недостающие строки
          // .gitignore дописывает этот же прогон. Только для `.myc` проекта:
          // каталог за --db — не наше дерево.
          if (dirname(jPath) === join(root, ".myc")) ensureMycGitignore(dirname(jPath), "wire");
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
      if ((data as { scope?: unknown }).scope === "user") return renderWireUser(data as WireUserData);
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
    const allow = (permissions["allow"] as unknown[]).filter((a) => !isOurPermission(a));
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

export function createUnwireCommand(overrides: Partial<Pick<WireDeps, "env" | "platform">> = {}): Command {
  const env = overrides.env ?? process.env;
  return {
    name: "unwire",
    summary: "remove exactly what `myc wire` installed, by the .myc/wire.json journal",
    flags: [{ name: "dry-run", description: "print what would be removed, change nothing" }, SCOPE_FLAG],
    help:
      "Files changed after we wrote them are left alone and reported: a journal hash mismatch " +
      "means a human edited the file, and removing our node blind would be the same trust " +
      "breach as writing it blind. --scope user undoes `myc wire --scope user` by " +
      "~/.myc/wire-user.json: myc's hook entries and the permission rules wire added come out of " +
      "~/.claude/settings.json node by node (everything else stays byte for byte), the helpers " +
      "and the skill are deleted, the MCP server goes through `claude mcp remove --scope user`.",
    handler: (ctx) => {
      const scope = parseScope(ctx);
      if (scope === null) return failure("usage.invalid", "--scope takes project or user", ExitCode.USAGE);
      if (scope === "user") return unwireUser(ctx, env);
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

// ---------------------------------------------------------------------------
// --scope user: пользовательский слой Claude Code (memory-bh5pbp4nyjwk)
// ---------------------------------------------------------------------------
//
// ЗАЧЕМ — в шапке userScopeGuard (hooks/templates.ts): агенты orca живут в git
// worktree командных репозиториев, где проектного слоя myc нет и быть не может
// (командные файлы не наши), а пользовательский слой Claude Code читает всегда.
//
// Правила D10 те же, что у проектного wire: целиком пишутся только свои файлы,
// чужой JSON мержится по узлам, `.myc.bak` рядом, журнал, повтор ничего не
// меняет. Отличий пять, и каждое — из того, что этот слой один на ВСЕ проекты
// и ВСЕ инструменты человека:
//
// 1. Чужой хук на том же событии — НОРМА, а не конфликт: у пользователя
//    SessionStart держат orca, herdr, agent-flow, и работать обязаны все.
//    Режим по умолчанию — append: чужие записи остаются на своих местах байт в
//    байт, наша встаёт в конец массива при первой установке и обновляется НА
//    МЕСТЕ при повторной (гнать её в конец при каждом wire значило бы двигать
//    чужие записи всякий раз, когда их инструмент перепишет себя). `skip` — не
//    ставить наш хук там, где уже есть чужой. `replace` — отказ: он выселил бы
//    глобальные хуки других инструментов из всех проектов разом.
// 2. Файл настроек пишется, только если его раскладка каноническая
//    (`JSON.stringify(v, null, отступ)`): тогда разбор и обратная запись
//    оставляют чужое байт в байт. Иначе — отказ: проектный wire в этом случае
//    переформатирует файл с заметкой, но здесь это глобальные настройки
//    человека, и переписать в них чужие строки, пусть без потери смысла, нельзя.
// 3. `statusLine` — только с `--status-line` (memory-6x0ag4p493pc). Прежде
//    это был отказ: считалось, что глобальная строка принадлежит orca и orca
//    её перезапишет. Чтение кода orca (шапка statusline-config.ts) показало
//    обратное: чужую строку orca не трогает ни установкой, ни снятием, а
//    видимая строка у агентов в worktree была пустой (orca не печатает). Два
//    правила: команда нашей строки не содержит `claude-statusline` (иначе
//    orca сочтёт её своей и при снятии удалит) — и потому прежнюю строку мы
//    не вшиваем в свою (`--then`), а пишем в журнал; `myc statusline --scope
//    user` берёт её оттуда на каждой отрисовке и отдаёт тот же stdin. Стоящая
//    наша строка без флага сохраняется, заменённая кем-то — не трогается
//    (повторный wire с флагом ставит нашу обратно, а новая чужая становится
//    прежней); unwire возвращает прежнюю байт в байт.
// 4. MCP — только через `claude mcp add --scope user`: `~/.claude.json` —
//    файл состояния, который работающие сессии переписывают сами. Сам файл
//    myc только ЧИТАЕТ — узнать, стоит ли уже сервер (повтор — «unchanged»).
// 5. unwire снимает узлы по признаку (путь нашего helper'а в команде, правила
//    из журнала), а не по хешу всего файла: этот файл правят orca и сам Claude
//    Code (`/config`, «always allow»), и сверка хеша запретила бы снимать наше
//    навсегда. Правило, которое стояло у человека ДО wire, журнал не называет
//    нашим, и unwire его не трогает.

export { USER_JOURNAL };
const USER_MCP_NAME = "myc";
const USER_MCP_ARGS: readonly string[] = ["mcp", "--profile", "agent"];

export interface UserPaths {
  readonly home: string;
  readonly claudeDir: string;
  readonly settings: string;
  readonly helpersDir: string;
  readonly helper: string;
  readonly queueHelper: string;
  readonly skill: string;
  /** Куда `claude mcp add --scope user` кладёт сервер — только читаем. */
  readonly claudeJson: string;
  readonly journal: string;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * Пути пользовательского слоя — ТОЛЬКО из переданного окружения, без
 * os.homedir(): тест с подменённым HOME не должен дотянуться до настоящего
 * `~/.claude` ни одной веткой. Нет HOME — null, и wire отказывает.
 *
 * `claudeJson` проверен запуском claude 2.1.268 на изолированном HOME:
 * без CLAUDE_CONFIG_DIR сервер пишется в `$HOME/.claude.json`, с ним — в
 * `$CLAUDE_CONFIG_DIR/.claude.json`, ключ верхнего уровня `mcpServers`.
 */
export function userPaths(env: NodeJS.ProcessEnv): UserPaths | null {
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  if (home === undefined) return null;
  const cfg = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const claudeDir = cfg ?? join(home, ".claude");
  const helpersDir = join(claudeDir, "helpers");
  return {
    home,
    claudeDir,
    settings: join(claudeDir, "settings.json"),
    helpersDir,
    helper: join(helpersDir, HELPER_MARK),
    queueHelper: join(helpersDir, QUEUE_HELPER_MARK),
    skill: join(claudeDir, "skills", "myc", "SKILL.md"),
    claudeJson: join(cfg ?? home, ".claude.json"),
    // Тот же путь, по которому журнал читает строка статуса на отрисовке.
    journal: userJournalPath(env) ?? join(home, ".myc", USER_JOURNAL),
  };
}

/**
 * Какой myc получат helper и MCP-сервер пользовательского слоя. Порядок
 * проектного resolveMycBin без путей от корня проекта (у этого слоя проекта
 * нет), и найденное пишется АБСОЛЮТНЫМ путём: конфиг личный, а сессии,
 * запущенные не из терминала, видят другой PATH.
 */
export function resolveUserMycBin(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): MycBinChoice {
  const own = nonEmpty(env.MYC_BIN);
  if (own !== undefined && exists(resolve(own))) return { command: resolve(own), source: "env" };
  const home = nonEmpty(env.HOME);
  if (home !== undefined && exists(join(home, ".myc/bin/myc"))) return { command: join(home, ".myc/bin/myc"), source: "home" };
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir.length > 0 && isAbsolute(dir) && exists(join(dir, "myc"))) return { command: join(dir, "myc"), source: "path" };
  }
  return { command: "myc", source: "none" };
}

/**
 * Годится ли myc для MCP пользовательского слоя: вне воркспейса он обязан
 * отдать ноль инструментов и не отдать instructions. Сервер этого слоя
 * стартует в КАЖДОЙ сессии на машине; сборка до memory-bh5pbp4nyjwk отдавала
 * там 13 инструментов, каждый отвечал ws.not_initialized, а instructions
 * «myc — this project's memory…» ехали в системный промпт всех проектов.
 * Проверяется запуском в пустом каталоге — церемония человека, не горячий путь.
 */
export type McpProbe = (bin: MycBinChoice, env: NodeJS.ProcessEnv) => { readonly ok: true } | { readonly ok: false; readonly why: string };

export const probeUserMcpBin: McpProbe = (bin, env) => {
  if (bin.source === "none") return { ok: false, why: "no myc executable found (MYC_BIN, ~/.myc/bin/myc, PATH)" };
  const dir = mkdtempSync(join(tmpdir(), "myc-wire-probe-"));
  try {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "myc-wire", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    const r = Bun.spawnSync([bin.command, "mcp", "--profile", "agent"], {
      cwd: dir,
      // Сервер пользовательского слоя Claude Code запускает с cwd = ~/.claude и
      // CLAUDE_PROJECT_DIR = проект; здесь «проект» — пустой каталог.
      env: { ...env, CLAUDE_PROJECT_DIR: dir },
      stdin: Buffer.from(`${requests.map((q) => JSON.stringify(q)).join("\n")}\n`),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const replies = new Map<number, Record<string, unknown>>();
    for (const line of r.stdout.toString().split("\n")) {
      try {
        const msg = JSON.parse(line) as { id?: unknown; result?: unknown };
        if (typeof msg.id === "number") replies.set(msg.id, asRecord(msg.result));
      } catch {
        // не JSON — не ответ
      }
    }
    const list = replies.get(2);
    if (list === undefined || !Array.isArray(list["tools"])) {
      const err = r.stderr.toString().trim().split("\n")[0] ?? "";
      return { ok: false, why: `${bin.command} mcp did not answer tools/list (exit ${r.exitCode}${err.length > 0 ? `: ${err}` : ""})` };
    }
    const tools = (list["tools"] as unknown[]).length;
    const instructions = replies.get(1)?.["instructions"] !== undefined;
    if (tools > 0 || instructions) {
      return {
        ok: false,
        why:
          `${bin.command} mcp outside a myc workspace still serves ${tools} tools${instructions ? " and its instructions" : ""} — ` +
          "an older build; registered for every project, it would put them into every session",
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `${bin.command} mcp does not start: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Годится ли myc для строки статуса пользовательского слоя: знает ли он
 * `statusline --scope user` и молчит ли вне воркспейса (выход 0, пустой
 * вывод). Сборка до memory-6x0ag4p493pc флага не знает — выход 2, и такая
 * строка в каждой сессии машины была бы пустой, а orca не получала бы ввода.
 * Запуск в пустом каталоге и без передачи чужой строке (`--no-pass`) —
 * церемония человека, не горячий путь.
 */
export type UserStatusLineProbe = (
  bin: MycBinChoice,
  env: NodeJS.ProcessEnv,
) => { readonly ok: true } | { readonly ok: false; readonly why: string };

export const probeUserStatusLineBin: UserStatusLineProbe = (bin, env) => {
  if (bin.source === "none") return { ok: false, why: "no myc executable found (MYC_BIN, ~/.myc/bin/myc, PATH)" };
  const dir = mkdtempSync(join(tmpdir(), "myc-wire-probe-sl-"));
  const args = [STATUSLINE_COMMAND, "--scope", "user", "--no-pass"];
  try {
    const r = Bun.spawnSync([bin.command, ...args], {
      cwd: dir,
      env: { ...env, CLAUDE_PROJECT_DIR: dir },
      stdin: Buffer.from(`${JSON.stringify({ session_id: "myc-wire-probe", cwd: dir, workspace: { current_dir: dir } })}\n`),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const shown = `${bin.command} ${args.join(" ")}`;
    if (r.exitCode !== 0) {
      const err = r.stderr.toString().trim().split("\n")[0] ?? "";
      return { ok: false, why: `${shown}: exit ${r.exitCode}${err.length > 0 ? ` (${err})` : ""} — an older build` };
    }
    const out = r.stdout.toString().trim();
    if (out.length > 0) return { ok: false, why: `${shown} prints "${shortCommand(out)}" outside a myc workspace — an older build` };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `${bin.command} does not start: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** `claude` из PATH окружения wire; null — нет. */
function findClaude(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir.length > 0 && existsSync(join(dir, "claude"))) return join(dir, "claude");
  }
  return null;
}

function runClaude(exe: string, args: readonly string[], env: NodeJS.ProcessEnv): { code: number; out: string } {
  try {
    const r = Bun.spawnSync([exe, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim().split("\n").filter((l) => l.length > 0).pop() ?? "";
    return { code: r.exitCode ?? -1, out };
  } catch (e) {
    return { code: -1, out: e instanceof Error ? e.message : String(e) };
  }
}

/** Команда для человека: `claude mcp …` целиком, с кавычками где надо. */
function claudeLine(args: readonly string[]): string {
  return ["claude", ...args].map(shellQuote).join(" ");
}

interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

/** Сервер `myc` пользовательского слоя, как лежит в ~/.claude.json; broken — файл не разобрать. */
function readUserMcpServer(path: string): { readonly value: Record<string, unknown> | undefined; readonly broken: boolean } {
  const text = fileText(path);
  if (text === null) return { value: undefined, broken: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) return { value: undefined, broken: true };
    const server = asRecord(parsed["mcpServers"])[USER_MCP_NAME];
    return { value: isPlainObject(server) ? server : undefined, broken: false };
  } catch {
    return { value: undefined, broken: true };
  }
}

/** Тот же ли это сервер: stdio с той же командой и аргументами (env `{}` claude пишет сам). */
function sameServer(entry: Record<string, unknown> | McpServerEntry, want: McpServerEntry): boolean {
  const rec = entry as Record<string, unknown>;
  const type = rec["type"];
  return (
    (type === undefined || type === "stdio") &&
    rec["command"] === want.command &&
    JSON.stringify(asArray(rec["args"])) === JSON.stringify(want.args)
  );
}

/** Запись хука пользовательского слоя: абсолютный путь и защита от удалённого helper'а. */
function userHookEntry(spec: HookSpec, helper: string): Record<string, unknown> {
  // helper удалили руками — без проверки `node` падал бы с кодом 1, и Claude
  // Code показывал бы ошибку хука в каждой сессии каждого проекта; `cat`
  // вычерпывает stdin, чтобы хост не писал в закрытую трубу.
  const q = shellQuote(helper);
  const command = `if [ -f ${q} ]; then node ${q} ${spec.event}; else cat >/dev/null; fi`;
  return {
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
    hooks: [{ type: "command", command, timeout: hostTimeoutSeconds(spec) }],
  };
}

/**
 * Хук очереди пользовательского слоя: та же запись, что у проекта
 * (queueHookEntry — матчер, таймаут, фильтр на shell хоста), только helper
 * указан абсолютным путём. Форма команды принадлежит queue-hook.ts; если она
 * изменится и подстановка перестанет совпадать — ошибка здесь, а не хук,
 * молча зовущий несуществующий файл.
 */
function userQueueEntry(helper: string, mycCommand: string): Record<string, unknown> {
  const entry = queueHookEntry(mycCommand);
  const from = `f="\${CLAUDE_PROJECT_DIR:-.}/${QUEUE_HELPER_REL}"`;
  const base = queueHookCommand(mycCommand);
  if (!base.startsWith(from)) throw new Error(`queue hook command no longer starts with ${from}: the user-scope path substitution is out of date`);
  const command = `f=${shellQuote(helper)}${base.slice(from.length)}`;
  return { ...entry, hooks: asArray(entry["hooks"]).map((h) => ({ ...asRecord(h), command })) };
}

/** Наша ли запись пользовательского слоя: команда зовёт один из НАШИХ helper'ов (абсолютный путь). */
function isUserEntry(entry: unknown, helpers: readonly string[]): boolean {
  return asArray(asRecord(entry)["hooks"]).some((h) => {
    const cmd = asRecord(h)["command"];
    return typeof cmd === "string" && helpers.some((p) => cmd.includes(p));
  });
}

/** Каноническая ли раскладка: разбор и обратная запись дают тот же текст. */
function sameLayout(text: string, value: unknown, indent: string): { readonly ok: boolean; readonly newline: boolean } {
  const newline = text.endsWith("\n");
  return { ok: `${JSON.stringify(value, null, indent)}${newline ? "\n" : ""}` === text, newline };
}

/**
 * Контейнеры, бывшие в файле ДО нас: пустыми после unwire они остаются.
 * Считается на каждом прогоне и копится в журнале: контейнер без нашего узла
 * внутри — не наш, откуда бы он ни взялся; с нашим — не знаем, и он не
 * добавляется (так же, как у проектного preexistingContainers).
 */
function userPreexisting(value: Record<string, unknown>, helpers: readonly string[], ourRules: readonly string[]): string[] {
  const out: string[] = [];
  const hooks = value["hooks"];
  if (isPlainObject(hooks)) {
    let ours = false;
    for (const [event, list] of Object.entries(hooks)) {
      const has = asArray(list).some((e) => isUserEntry(e, helpers));
      ours = ours || has;
      if (Array.isArray(list) && !has) out.push(`hooks.${event}`);
    }
    if (!ours) out.push("hooks");
  }
  const permissions = value["permissions"];
  if (isPlainObject(permissions)) {
    const allow = permissions["allow"];
    const has = Array.isArray(allow) && allow.some((r) => ourRules.includes(r as string));
    if (Array.isArray(allow) && !has) out.push("permissions.allow");
    if (!has) out.push("permissions");
  }
  return out;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

export interface UserJournal {
  readonly v: 1;
  readonly scope: "user";
  readonly written_at: number;
  readonly hook_output: "json" | "text";
  /** Файлы, которые myc пишет целиком (helper'ы, скилл), и их хеш на момент записи. */
  readonly files: readonly { readonly path: string; readonly hash: string }[];
  /** Каталоги, которых не было до wire: unwire снимает их, если они пусты. */
  readonly dirs: readonly string[];
  readonly settings: {
    readonly path: string;
    /** Файла не было до ПЕРВОГО wire: пустым после unwire он удаляется. */
    readonly created: boolean;
    readonly preexisting: readonly string[];
    /** Правила permissions.allow, которые добавил wire (стоявшие до него сюда не попадают). */
    readonly permissions: readonly string[];
    /** Наши helper'ы: запись хука, чья команда зовёт один из них, — наша. */
    readonly helpers: readonly string[];
    /** `.myc.bak`, записанный последним: снимается, если его не трогали. */
    readonly backup?: { readonly path: string; readonly hash: string };
  } | null;
  /** Сервер `myc` в пользовательском слое; added — его зарегистрировал wire. */
  readonly mcp: { readonly config: string; readonly command: string; readonly args: readonly string[]; readonly added: boolean } | null;
  /**
   * Сборка myc, записавшая журнал (CLI_VERSION), и myc, вшитый в helper и MCP.
   * По ним `myc doctor --hooks` называет, КЕМ записан устаревший helper, и
   * собирает то, что записала бы нынешняя сборка. У журналов 0.3.4 полей нет.
   */
  readonly version?: string;
  readonly bin?: string;
  /** События Claude Code, на которые wire поставил наш хук (с `--hook-mode skip` — не все). */
  readonly events?: readonly string[];
  /** Наша строка статуса и та, что стояла до неё (`--status-line`); нет поля — строку не ставили. */
  readonly status_line?: UserStatusLineRecord;
}

/**
 * Что журнал знает о строке статуса пользовательского слоя. `previous` —
 * `statusLine` ДО нас, дословно; `null` — ключа не было. По нему unwire
 * возвращает файл побайтно, а `myc statusline` отдаёт прежней тот же ввод
 * (statusline-config.ts читает это же поле, не импортируя wire).
 */
export interface UserStatusLineRecord {
  readonly previous: unknown;
}

export function readUserJournal(path: string): UserJournal | null {
  const raw = fileText(path);
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as Partial<UserJournal>;
    if (!isPlainObject(j) || j.scope !== "user" || !Array.isArray(j.files)) return null;
    const sl = (j as Record<string, unknown>)["status_line"];
    return {
      v: 1,
      scope: "user",
      written_at: typeof j.written_at === "number" ? j.written_at : Number.NaN,
      hook_output: j.hook_output === "text" ? "text" : "json",
      files: j.files,
      dirs: Array.isArray(j.dirs) ? j.dirs : [],
      settings: isPlainObject(j.settings) ? (j.settings as UserJournal["settings"]) : null,
      mcp: isPlainObject(j.mcp) ? (j.mcp as UserJournal["mcp"]) : null,
      ...(typeof j.version === "string" ? { version: j.version } : {}),
      ...(typeof j.bin === "string" ? { bin: j.bin } : {}),
      ...(Array.isArray(j.events) ? { events: j.events.filter((e): e is string => typeof e === "string") } : {}),
      ...(isPlainObject(sl) ? { status_line: { previous: sl["previous"] ?? null } } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Файлы пользовательского слоя, которые myc пишет целиком, — ровно то, что
 * записала бы ЭТА сборка. Один источник на запись (wireUser) и на сверку
 * свежести (`myc doctor --hooks`): второй список тех же текстов разошёлся бы
 * с первым молча, и doctor хвалил бы helper, который wire уже не пишет.
 */
export function userGeneratedFiles(
  paths: UserPaths,
  events: readonly HookEvent[],
  hookOutput: "json" | "text",
  mycBin: string,
): { readonly helper: string; readonly queueHelper: string; readonly skill: string } {
  return {
    helper: claudeUserHelper({ events, hookOutput, selfDir: paths.helpersDir, mycBin }),
    queueHelper: withUserScopeGuard(
      queueHelper(),
      paths.helpersDir,
      QUEUE_HELPER_MARK,
      "// User-layer copy, generated by `myc wire --scope user --queue-hook`: the same helper behind a guard that " +
        "lets it act only in a myc workspace whose project does not run its own queue hook.",
    ),
    skill: skillMd(),
  };
}

/** Запись хука пользовательского слоя — наша: её команда зовёт один из наших helper'ов. */
export function isUserHookEntry(entry: unknown, helpers: readonly string[]): boolean {
  return isUserEntry(entry, helpers);
}

/** Сервер `myc` из `~/.claude.json` — только чтение (файл пишет сам claude). */
export function readUserMcp(path: string): { readonly value: Record<string, unknown> | undefined; readonly broken: boolean } {
  return readUserMcpServer(path);
}

/** Путь для человека: домашний каталог — `~`. */
function tilde(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

interface UserFileAction {
  readonly path: string;
  readonly kind: ActionKind;
  readonly content: string;
  readonly detail: string;
}

function planUserFile(files: UserFileAction[], path: string, content: string): void {
  const current = fileText(path);
  if (current === content) {
    files.push({ path, kind: "unchanged", content, detail: "up to date" });
    return;
  }
  files.push({
    path,
    kind: current === null ? "new" : "rewrite",
    content,
    detail: `${(Buffer.byteLength(content, "utf8") / 1024).toFixed(1)} KB`,
  });
}

type McpState = "add" | "replace" | "unchanged" | "foreign" | "refused";

interface UserMcpPlan {
  readonly state: McpState;
  readonly server: McpServerEntry;
  /** Что запустит wire (или человек): `claude mcp add --scope user myc -- …`. */
  readonly add: readonly string[];
  readonly reason?: string;
  /** Сервер уже стоит и его ставил wire (для журнала при unchanged). */
  readonly oursBefore: boolean;
}

function planUserMcp(
  paths: UserPaths,
  bin: MycBinChoice,
  prev: UserJournal | null,
  probe: () => ReturnType<McpProbe>,
  claude: string | null,
): UserMcpPlan {
  const server: McpServerEntry = { command: bin.command, args: USER_MCP_ARGS };
  const add = ["mcp", "add", "--scope", "user", USER_MCP_NAME, "--", bin.command, ...USER_MCP_ARGS];
  const base = { server, add };
  const current = readUserMcpServer(paths.claudeJson);
  if (current.broken) {
    return { ...base, state: "refused", oursBefore: false, reason: `${paths.claudeJson} is not valid JSON — can't tell whether myc is registered` };
  }
  const recorded = prev?.mcp;
  const oursBefore =
    recorded?.added === true && current.value !== undefined && sameServer(current.value, { command: recorded.command, args: recorded.args });
  if (current.value !== undefined && sameServer(current.value, server)) return { ...base, state: "unchanged", oursBefore };
  if (current.value !== undefined && !oursBefore) {
    const cmd = [current.value["command"], ...asArray(current.value["args"])].map(String).join(" ");
    return {
      ...base,
      state: "foreign",
      oursBefore,
      reason: `mcpServers.myc in ${paths.claudeJson} was not registered by myc wire (${cmd}) — left alone`,
    };
  }
  const checked = probe();
  if (!checked.ok) return { ...base, state: "refused", oursBefore, reason: checked.why };
  if (claude === null) return { ...base, state: "refused", oursBefore, reason: "claude is not on PATH" };
  return { ...base, state: current.value === undefined ? "add" : "replace", oursBefore };
}

/**
 * `statusLine` пользовательского слоя (правило 3 в шапке раздела). Меняет
 * `value` на месте: присваивание существующему ключу его не двигает, и чужие
 * байты файла остаются где были.
 *
 * Без флага ключ не пишется: наша строка, если стоит, остаётся с прежней
 * записью журнала; заменённая кем-то — не трогается, запись о нашей
 * забывается (иначе unwire однажды «вернул бы» то, что уже не наше), и об этом
 * сказано вслух. С флагом прежней становится то, что стоит СЕЙЧАС, если это не
 * мы: новая чужая строка (orca поставила свою, человек — свою) не теряется, а
 * продолжает получать ввод; стоим мы или ключ снят — прежняя из журнала.
 */
function planUserStatusLine(
  value: Record<string, unknown>,
  o: {
    readonly want: boolean;
    readonly recorded: UserStatusLineRecord | undefined;
    readonly bin: MycBinChoice;
    readonly rel: string;
    readonly journal: string;
  },
): { readonly record?: UserStatusLineRecord; readonly notes: string[]; readonly node: boolean } | { readonly conflict: string } {
  const current = value["statusLine"];
  const ours = isOurStatusLine(current);
  const notes: string[] = [];
  const who = (v: unknown): string => {
    const cmd = statusLineCommand(v);
    if (cmd === null) return "a line without a command";
    return `"${shortCommand(cmd)}"${orcaClaimsStatusLine(cmd) ? " (orca's line)" : ""}`;
  };
  const noRecord = `${o.rel}: myc's statusLine is there with no record of the previous one in ${o.journal} — unwire will remove it and has nothing to restore`;

  if (!o.want) {
    if (ours) {
      if (o.recorded === undefined) notes.push(noRecord);
      return { record: o.recorded ?? { previous: null }, notes, node: false };
    }
    if (o.recorded !== undefined) {
      notes.push(
        current === undefined
          ? `${o.rel}: myc's statusLine was removed after wire — its record is dropped; \`myc wire --scope user --status-line\` puts it back`
          : `${o.rel}: myc's statusLine was replaced after wire by ${who(current)} — left alone and the record of ours dropped; ` +
              "`myc wire --scope user --status-line` puts ours back, and that line keeps getting the same input as the previous one",
      );
    }
    return { notes, node: false };
  }

  let previous: unknown;
  if (ours) {
    previous = o.recorded?.previous ?? null;
    if (o.recorded === undefined) notes.push(noRecord);
  } else if (current === undefined) {
    previous = o.recorded?.previous ?? null;
    if (o.recorded !== undefined) notes.push(`${o.rel}: myc's statusLine was removed after wire — put back`);
  } else {
    previous = current;
    if (o.recorded !== undefined) {
      notes.push(`${o.rel}: myc's statusLine was replaced after wire by ${who(current)} — ours goes back, and that line becomes the previous one`);
    }
  }

  const command = ourUserStatusLineCommand(o.bin);
  // orca считает своей строку, в команде которой есть `claude-statusline`, и
  // при снятии удаляет её (statusline-config.ts). Наша такой быть не может.
  if (command.includes(ORCA_STATUSLINE_MARK)) {
    return { conflict: `the command "${shortCommand(command)}" contains "${ORCA_STATUSLINE_MARK}", so orca would take it for its own line and remove it` };
  }
  // Свою строку узнаём по `myc statusline` в команде. Бинарь с другим именем
  // дал бы строку, которую повторный wire счёл бы чужой и записал бы прежней.
  if (!isOurStatusLineCommand(command)) {
    return { conflict: `${o.bin.command} is not named myc, so its line could not be told from a foreign one — set MYC_BIN to a myc executable` };
  }
  const next: Record<string, unknown> = { type: "command", command };
  // Раскладку и частоту перерисовки задавала прежняя строка (у orca их нет);
  // стоящей нашей — её собственные, чтобы повтор был байт в байт.
  const carried = asRecord(ours ? current : previous);
  for (const key of ["padding", "refreshInterval"]) {
    if (typeof carried[key] === "number") next[key] = carried[key];
  }
  if (!(ours && JSON.stringify(current) === JSON.stringify(next))) value["statusLine"] = next;

  const prevCmd = statusLineCommand(previous);
  if (prevCmd !== null && !isOurStatusLineCommand(prevCmd)) {
    notes.push(
      `${o.rel}: statusLine is myc's (myc statusline --scope user: the full line in a myc workspace, nothing of its own ` +
        `outside one); the previous line ${who(previous)} is kept in ${o.journal} and gets the same stdin on every redraw — ` +
        "neither awaited nor killed; unwire puts it back",
    );
  } else {
    notes.push(`${o.rel}: statusLine is myc's; there was no previous line — no one to pass input to`);
  }
  return { record: { previous }, notes, node: true };
}

export interface WireUserData {
  readonly scope: "user";
  readonly home: string;
  readonly events: readonly string[];
  readonly skipped_events: readonly { event: string; reason: string }[];
  readonly actions: readonly { path: string; action: ActionKind; detail: string }[];
  readonly mcp: { readonly state: McpState | "added" | "failed"; readonly command: string; readonly reason?: string };
  readonly untouched: readonly string[];
  readonly notes: readonly string[];
  readonly dry_run: boolean;
  readonly changed: number;
  readonly journal: string | null;
}

function wireUser(ctx: CommandContext, registry: Registry, deps: WireDeps): CommandResult {
  const refuse = (msg: string): CommandFailure => failure("usage.scope", msg, ExitCode.USAGE);
  const agentsRaw = flagStr(ctx, "agents");
  if (agentsRaw !== undefined) {
    const agents = parseAgents(agentsRaw);
    if (agents === null) return failure("usage.invalid", `--agents takes ${HARNESSES.join(", ")}`, ExitCode.USAGE);
    const other = agents.filter((a) => a !== "claude");
    if (other.length > 0) {
      return refuse(
        `--scope user wires Claude Code only; ${other.join(", ")} ${other.length === 1 ? "is" : "are"} not implemented ` +
          `in the user layer — wire them per project: myc wire --agents ${other.join(",")}`,
      );
    }
  }
  const wantStatusLine = ctx.flags["status-line"] === true;
  if (ctx.flags["agents-md"] === true) return refuse("--agents-md is not available with --scope user: AGENTS.md is a project file");
  const modeRaw = flagStr(ctx, "hook-mode");
  if (modeRaw === "replace") {
    return refuse(
      "--hook-mode replace is not available with --scope user: it would evict other tools' hooks (orca, herdr, …) " +
        "from every project on the machine. The default, append, keeps them and adds myc's alongside; skip leaves " +
        "an event alone when a foreign hook is there",
    );
  }
  if (modeRaw !== undefined && modeRaw !== "append" && modeRaw !== "skip") {
    return failure("usage.invalid", "--hook-mode takes append or skip with --scope user", ExitCode.USAGE);
  }
  const mode: "append" | "skip" = modeRaw === "skip" ? "skip" : "append";
  const outRaw = flagStr(ctx, "hook-output") ?? "json";
  if (outRaw !== "json" && outRaw !== "text") return failure("usage.invalid", "--hook-output takes json or text", ExitCode.USAGE);
  if (deps.platform === "win32") {
    return failure(
      "precond.platform",
      "--scope user is not implemented on Windows: its hook commands are POSIX shell, checked on macOS and Linux only",
      ExitCode.PRECOND,
    );
  }
  const paths = userPaths(deps.env);
  if (paths === null) return failure("precond.no_home", "HOME is not set: no user layer of Claude Code to wire", ExitCode.PRECOND);
  const { available: events, skipped } = availableEvents(registry);
  if (!events.includes("pre-compact")) {
    return failure("precond.missing_command", "no `myc absorb-session` command — nothing to install pre-compact on", ExitCode.PRECOND);
  }

  const home = paths.home;
  const show = (p: string): string => tilde(p, home);
  const prev = readUserJournal(paths.journal);
  const bin = resolveUserMycBin(deps.env);
  const notes: string[] = [];
  const untouched: string[] = [];
  const files: UserFileAction[] = [];

  let queueBin: QueueBinChoice | null = null;
  if (ctx.flags["queue-hook"] === true) {
    const probe = deps.probeQueue(paths.claudeDir, deps.env);
    if (!probe.ok) {
      return failure(
        "precond.queue_bin",
        `nowhere to queue heavy commands through: ${probe.why}. A hook on a myc without \`run\` would turn every heavy ` +
          "command into an error — nothing written",
        ExitCode.PRECOND,
        "MYC_BIN=<path to a fresh myc> myc wire --scope user --queue-hook",
      );
    }
    queueBin = probe.bin;
  }

  // Строка на myc, который не знает `statusline --scope user`, — хуже, чем
  // никакой: код выхода не 0, Claude Code не покажет ничего, и прежняя строка
  // (orca) не получит ввода вовсе. Проверяется запуском, до записи чего-либо.
  if (wantStatusLine) {
    const probe = deps.probeUserStatusLine(bin, deps.env);
    if (!probe.ok) {
      return failure(
        "precond.statusline_bin",
        `nowhere to install the status line: ${probe.why}. A line on that binary would show nothing and cut the ` +
          "previous line off from its input — nothing written",
        ExitCode.PRECOND,
        "MYC_BIN=<path to a fresh myc> myc wire --scope user --status-line",
      );
    }
  }

  const generated = userGeneratedFiles(paths, events, outRaw, bin.command);
  planUserFile(files, paths.helper, generated.helper);
  planUserFile(files, paths.skill, generated.skill);

  // --- ~/.claude/settings.json ------------------------------------------------
  const settingsText = fileText(paths.settings);
  const source = readJsonSource(paths.settings);
  if (source.broken) {
    return failure("conflict.user_settings", `${paths.settings} is not valid JSON — nothing written`, ExitCode.CONFLICT);
  }
  const layout = settingsText === null ? { ok: true, newline: true } : sameLayout(settingsText, source.value, source.indent);
  if (!layout.ok) {
    return failure(
      "conflict.user_settings",
      `${paths.settings} is not laid out the way JSON.stringify writes it (indent ${JSON.stringify(source.indent)}), so a ` +
        "node-by-node merge would reformat other tools' entries — nothing written",
      ExitCode.CONFLICT,
      "let Claude Code or orca rewrite the file (e.g. change any setting in /config), then run wire again",
    );
  }
  const helpers = [paths.helper, paths.queueHelper];
  const isOurs = (e: unknown): boolean => isUserEntry(e, helpers);
  const placements: Placement[] = HOOK_SPECS.filter((s) => events.includes(s.event)).map((s) => ({
    event: s.claudeEvent,
    entry: userHookEntry(s, paths.helper),
  }));
  // Хук очереди — как у проекта: без флага не ставится, а стоящий наш
  // сохраняется как лежит (обычный wire обновляет helper'ы, а не выбор человека).
  let queueEntry: Record<string, unknown> | null = null;
  for (const entry of asArray(asRecord(source.value["hooks"])["PreToolUse"])) {
    if (isUserEntry(entry, [paths.queueHelper])) queueEntry = asRecord(entry);
  }
  if (queueBin !== null) {
    queueEntry = userQueueEntry(paths.queueHelper, queueBin.command);
    notes.push(
      `${show(paths.settings)}: hooks.PreToolUse[Bash] — in a myc workspace a heavy command goes through \`myc run -- …\` ` +
        `with ${queueBin.command} (${queueBin.source}); approved without asking only when your own rules allow the original command`,
    );
  }
  const hookPlacements = placements.length;
  if (queueEntry !== null) {
    placements.push({ event: "PreToolUse", entry: queueEntry });
    planUserFile(files, paths.queueHelper, generated.queueHelper);
  } else {
    untouched.push(`${show(paths.settings)}:hooks.PreToolUse (needs --queue-hook)`);
  }

  const value: Record<string, unknown> = { ...source.value };
  const hooks = asRecord(value["hooks"]);
  const nodes: string[] = [];
  // События, на которых наш хук стоит после этого прогона: журнал, по нему
  // doctor сверяет, не сняли ли их руками (skip оставляет часть без нашего).
  const placedEvents: string[] = [];
  for (const [i, { event, entry }] of placements.entries()) {
    const existing = asArray(hooks[event]);
    const foreign = existing.filter((e) => !isOurs(e));
    const ours = existing.length > foreign.length;
    if (!ours && foreign.length > 0 && mode === "skip") {
      notes.push(`${show(paths.settings)}: hooks.${event} — a foreign hook is there, myc's not installed (--hook-mode skip)`);
      continue;
    }
    if (i < hookPlacements) placedEvents.push(event);
    let next: unknown[];
    if (ours) {
      // На месте: чужие записи вокруг нашей не двигаются никогда.
      next = [];
      let placed = false;
      for (const e of existing) {
        if (!isOurs(e)) next.push(e);
        else if (!placed) {
          next.push(entry);
          placed = true;
        }
      }
    } else {
      next = [...existing, entry];
      if (foreign.length > 0) {
        notes.push(
          `${show(paths.settings)}: hooks.${event} — ${foreign.length} foreign ${foreign.length === 1 ? "entry stays" : "entries stay"} ` +
            "byte for byte; Claude Code runs them and myc's side by side",
        );
      }
    }
    hooks[event] = next;
    nodes.push(`hooks.${event}`);
  }
  if (nodes.length > 0) value["hooks"] = hooks;

  const rules = mycPermissions(registry);
  const permissions = asRecord(value["permissions"]);
  const allow = asArray(permissions["allow"]);
  const addedRules = rules.filter((r) => !allow.includes(r));
  if (addedRules.length > 0) {
    permissions["allow"] = [...allow, ...addedRules];
    value["permissions"] = permissions;
    nodes.push(`permissions.allow[${addedRules.length === 1 ? addedRules[0] : `Bash(myc <command>:*) ×${addedRules.length}`}]`);
  }
  const broad = allow.find((r) => r === LEGACY_PERMISSION || r === "Bash(myc run:*)");
  if (broad !== undefined) {
    notes.push(
      `${show(paths.settings)}: permissions.allow has ${String(broad)}, so \`myc run -- <any command>\` runs without asking ` +
        "in every project; wire did not write it and leaves it alone — remove it by hand",
    );
  }
  // --- statusLine (только с --status-line; стоящая наша — сохраняется) ---------
  const sl = planUserStatusLine(value, {
    want: wantStatusLine,
    recorded: prev?.status_line,
    bin,
    rel: show(paths.settings),
    journal: show(paths.journal),
  });
  if ("conflict" in sl) {
    return failure("conflict.status_line", `status line not installed, nothing written: ${sl.conflict}`, ExitCode.CONFLICT);
  }
  notes.push(...sl.notes);
  if (sl.node) nodes.push("statusLine");
  if (!wantStatusLine && sl.record === undefined) untouched.push(`${show(paths.settings)}:statusLine (needs --status-line)`);

  const settingsContent = `${JSON.stringify(value, null, source.indent)}${layout.newline ? "\n" : ""}`;
  const settingsKind: ActionKind = settingsText === settingsContent ? "unchanged" : settingsText === null ? "new" : "merge";

  // --- MCP ---------------------------------------------------------------------
  const claude = findClaude(deps.env);
  const mcp = planUserMcp(paths, bin, prev, () => deps.probeMcp(bin, deps.env), claude);
  if (mcp.state !== "unchanged" && mcp.state !== "foreign") {
    notes.push(
      `${show(paths.claudeJson)} is written by \`claude mcp\` itself (it keeps its own backup under ${show(paths.claudeDir)}/backups); ` +
        "running sessions rewrite that file, so myc only reads it",
    );
  }
  if (mcp.state === "foreign" && mcp.reason !== undefined) notes.push(mcp.reason);

  const dryRun = ctx.flags["dry-run"] === true;
  const settingsAction = { path: paths.settings, action: settingsKind, detail: nodes.length > 0 && settingsKind !== "unchanged" ? `+${countNodes(nodes.length)}: ${nodes.join(", ")}` : "up to date" };
  let mcpOutcome: WireUserData["mcp"] = {
    state: mcp.state,
    command: claudeLine(mcp.add),
    ...(mcp.reason !== undefined ? { reason: mcp.reason } : {}),
  };
  let journal: string | null = null;

  if (!dryRun) {
    // Файл настроек мог измениться между чтением и записью (его правят orca и
    // сессии Claude Code): тогда ничего не пишем — свежий прогон спланирует заново.
    if (fileText(paths.settings) !== settingsText) {
      return failure(
        "conflict.user_settings_changed",
        `${paths.settings} changed while wire was planning — nothing written`,
        ExitCode.CONFLICT,
        "myc wire --scope user",
      );
    }
    const wanted = [paths.claudeDir, paths.helpersDir, dirname(dirname(paths.skill)), dirname(paths.skill), dirname(paths.journal)];
    const madeDirs = wanted.filter((d) => !existsSync(d));
    // `.myc.bak` своих файлов — тоже созданные нами файлы: журнал знает их
    // хеш, и unwire снимает их, если их с тех пор не трогали.
    const baks: { path: string; hash: string }[] = [];
    for (const f of files) {
      if (f.kind === "unchanged") continue;
      mkdirSync(dirname(f.path), { recursive: true });
      const before = fileText(f.path);
      if (before !== null) {
        copyFileSync(f.path, `${f.path}${BAK_SUFFIX}`);
        baks.push({ path: `${f.path}${BAK_SUFFIX}`, hash: sha256(before) });
      }
      writeFileSync(f.path, f.content);
    }
    let backup = prev?.settings?.backup;
    if (settingsKind !== "unchanged") {
      mkdirSync(dirname(paths.settings), { recursive: true });
      if (settingsText !== null) {
        const bak = `${paths.settings}${BAK_SUFFIX}`;
        copyFileSync(paths.settings, bak);
        backup = { path: bak, hash: sha256(settingsText) };
      }
      writeFileSync(paths.settings, settingsContent);
    }

    let added = mcp.state === "unchanged" ? mcp.oursBefore : false;
    if ((mcp.state === "add" || mcp.state === "replace") && claude !== null) {
      let ok = true;
      if (mcp.state === "replace") {
        const r = runClaude(claude, ["mcp", "remove", "--scope", "user", USER_MCP_NAME], deps.env);
        if (r.code !== 0) {
          ok = false;
          mcpOutcome = { state: "failed", command: claudeLine(mcp.add), reason: `claude mcp remove: exit ${r.code}${r.out.length > 0 ? ` (${r.out})` : ""}` };
        }
      }
      if (ok) {
        const r = runClaude(claude, mcp.add, deps.env);
        if (r.code === 0) {
          added = true;
          mcpOutcome = { state: "added", command: claudeLine(mcp.add) };
        } else {
          mcpOutcome = { state: "failed", command: claudeLine(mcp.add), reason: `exit ${r.code}${r.out.length > 0 ? ` (${r.out})` : ""}` };
        }
      }
    }

    const rulesOurs = union(prev?.settings?.permissions ?? [], addedRules);
    const doc: UserJournal = {
      v: 1,
      scope: "user",
      written_at: Date.now(),
      hook_output: outRaw,
      files: [
        ...(prev?.files ?? []).filter((e) => !files.some((f) => f.path === e.path) && !baks.some((b) => b.path === e.path)),
        ...files.map((f) => ({ path: f.path, hash: sha256(f.content) })),
        ...baks,
      ],
      dirs: union(prev?.dirs ?? [], madeDirs),
      settings: {
        path: paths.settings,
        created: prev?.settings?.created ?? settingsText === null,
        preexisting: union(prev?.settings?.preexisting ?? [], userPreexisting(source.value, helpers, rulesOurs)),
        permissions: rulesOurs,
        helpers: union(prev?.settings?.helpers ?? [], helpers),
        ...(backup !== undefined ? { backup } : {}),
      },
      mcp:
        added || mcp.state === "unchanged"
          ? { config: paths.claudeJson, command: mcp.server.command, args: mcp.server.args, added }
          : (prev?.mcp ?? null),
      version: CLI_VERSION,
      bin: bin.command,
      events: placedEvents,
      ...(sl.record !== undefined ? { status_line: sl.record } : {}),
    };
    try {
      mkdirSync(dirname(paths.journal), { recursive: true });
      // tmp + rename: журнал читает строка статуса на КАЖДОЙ отрисовке
      // (прежняя строка — отсюда), и половину файла она видеть не должна.
      const tmp = `${paths.journal}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      renameSync(tmp, paths.journal);
      journal = paths.journal;
    } catch (e) {
      ctx.warn(
        "degraded.journal",
        `journal ${paths.journal} not written (${e instanceof Error ? e.message : String(e)}): myc unwire --scope user won't be able to remove the hooks`,
      );
    }
  }

  for (const skip of skipped) ctx.warn("degraded.hook_missing", `hook ${skip.event} not installed: ${skip.reason}`);
  if (bin.source === "none") {
    ctx.warn(
      "degraded.bin_unresolved",
      "no myc executable found: not in MYC_BIN, ~/.myc/bin/myc or PATH — the helper falls back to `myc` on the session's PATH",
    );
  }
  if (mcpOutcome.state === "refused" || mcpOutcome.state === "failed") {
    ctx.warn(
      "degraded.mcp_unregistered",
      `MCP server myc ${dryRun ? "would not be" : "not"} registered in the user layer: ${mcpOutcome.reason ?? "unknown reason"}. ` +
        `Hooks, skill and permissions ${dryRun ? "would be" : "are"} in place; to register it yourself: ${mcpOutcome.command}`,
    );
  }

  const actions = [
    ...files.map((f) => ({ path: f.path, action: f.kind, detail: f.detail })),
    settingsAction,
  ];
  const data: WireUserData = {
    scope: "user",
    home,
    events,
    skipped_events: skipped,
    actions,
    mcp: mcpOutcome,
    untouched,
    notes,
    dry_run: dryRun,
    changed: actions.filter((a) => a.action !== "unchanged").length + (mcp.state === "add" || mcp.state === "replace" ? 1 : 0),
    journal,
  };
  return { ok: true, data };
}

function renderWireUser(d: WireUserData): string {
  const show = (p: string): string => tilde(p, d.home);
  const lines: string[] = [d.dry_run ? "would write (user layer of Claude Code):" : "written (user layer of Claude Code):"];
  const width = Math.max(...d.actions.map((a) => show(a.path).length), 10);
  for (const a of d.actions) lines.push(`  ${a.action.padEnd(9)} ${show(a.path).padEnd(width)}  ${a.detail}`);
  const mcpLine: Record<WireUserData["mcp"]["state"], string> = {
    add: d.dry_run ? `would run: ${d.mcp.command}` : d.mcp.command,
    replace: d.dry_run ? `would re-register: ${d.mcp.command}` : d.mcp.command,
    added: d.mcp.command,
    unchanged: "already registered",
    foreign: "someone else's server named myc — left alone",
    refused: `not registered: ${d.mcp.reason ?? ""}`,
    failed: `failed: ${d.mcp.reason ?? ""}`,
  };
  lines.push(`  ${(d.mcp.state === "added" ? "register" : d.mcp.state).padEnd(9)} ${"MCP server myc (user)".padEnd(width)}  ${mcpLine[d.mcp.state]}`);
  if (d.untouched.length > 0) lines.push(`untouched: ${d.untouched.join(", ")}`);
  for (const note of d.notes) lines.push(`! ${note}`);
  if (d.journal !== null) lines.push(`journal: ${show(d.journal)} (for myc unwire --scope user)`);
  if (d.dry_run) lines.push("nothing written (--dry-run)");
  else if (d.changed === 0) lines.push("everything already in place, no files touched");
  return `${lines.join("\n")}\n`;
}

/**
 * Наши узлы из пользовательских настроек: записи хуков, чья команда зовёт
 * наш helper, и правила, которые добавил wire. Контейнер удаляется, только
 * если опустел ИЗ-ЗА НАС и его не было до первого wire.
 *
 * Строка статуса не удаляется, а ВОЗВРАЩАЕТСЯ — как у проектного unwire:
 * стоит наша — на её место прежняя из журнала (присваивание существующему
 * ключу его не двигает), не было прежней — ключа не будет. Чужая строка,
 * поставленная после нас, не трогается: она не наша.
 */
function stripUserSettings(
  value: Record<string, unknown>,
  rec: NonNullable<UserJournal["settings"]>,
  statusLine: UserStatusLineRecord | undefined,
): { readonly value: Record<string, unknown>; readonly nodes: string[] } {
  const out = { ...value };
  const keep = new Set(rec.preexisting);
  const nodes: string[] = [];
  if (isOurStatusLine(out["statusLine"])) {
    const prev = statusLine?.previous;
    if (prev !== undefined && prev !== null) {
      out["statusLine"] = prev;
      nodes.push("statusLine (previous restored)");
    } else {
      delete out["statusLine"];
      nodes.push("statusLine");
    }
  }
  const hooks = asRecord(out["hooks"]);
  let hooksTouched = false;
  for (const key of Object.keys(hooks)) {
    const list = asArray(hooks[key]);
    const rest = list.filter((e) => !isUserEntry(e, rec.helpers));
    if (rest.length === list.length) continue;
    hooksTouched = true;
    nodes.push(`hooks.${key}`);
    if (rest.length === 0 && !keep.has(`hooks.${key}`)) delete hooks[key];
    else hooks[key] = rest;
  }
  if (hooksTouched) {
    if (Object.keys(hooks).length === 0 && !keep.has("hooks")) delete out["hooks"];
    else out["hooks"] = hooks;
  }
  const permissions = asRecord(out["permissions"]);
  if (Array.isArray(permissions["allow"])) {
    const list = permissions["allow"] as unknown[];
    const allow = list.filter((r) => !rec.permissions.includes(r as string));
    if (allow.length !== list.length) {
      nodes.push(`permissions.allow[${list.length - allow.length}]`);
      if (allow.length === 0 && !keep.has("permissions.allow")) delete permissions["allow"];
      else permissions["allow"] = allow;
      if (Object.keys(permissions).length === 0 && !keep.has("permissions")) delete out["permissions"];
      else out["permissions"] = permissions;
    }
  }
  return { value: out, nodes };
}

function unwireUser(ctx: CommandContext, env: NodeJS.ProcessEnv): CommandResult {
  const paths = userPaths(env);
  if (paths === null) return failure("precond.no_home", "HOME is not set: no user layer of Claude Code to unwire", ExitCode.PRECOND);
  const j = readUserJournal(paths.journal);
  if (j === null) {
    return failure("notfound.journal", `no journal ${paths.journal}: nothing to remove`, ExitCode.NOTFOUND, "myc wire --scope user");
  }
  const dryRun = ctx.flags["dry-run"] === true;
  const removed: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  const gone: string[] = [];

  // 1. settings.json — пока наши записи хуков там, helper'ы обязаны остаться:
  //    удалить файл, который настройки ещё зовут, — ошибка хука в каждой сессии.
  let settingsClean = true;
  const s = j.settings;
  if (s !== null) {
    const text = fileText(s.path);
    if (text === null) {
      gone.push(s.path);
    } else {
      const src = readJsonSource(s.path);
      const layout = src.broken ? { ok: false, newline: true } : sameLayout(text, src.value, src.indent);
      if (!layout.ok) {
        settingsClean = false;
        kept.push({
          path: s.path,
          reason:
            `${src.broken ? "not valid JSON" : "not laid out the way JSON.stringify writes it"} — stripping would reformat ` +
            `other tools' entries; myc's entries left in place (hooks running ${s.helpers.join(", ")}; ` +
            `${s.permissions.length} permissions.allow rules Bash(myc <command>:*))`,
        });
      } else {
        const stripped = stripUserSettings(src.value, s, j.status_line);
        if (stripped.nodes.length === 0) {
          removed.push(`${s.path} (no myc entries left)`);
        } else if (s.created && Object.keys(stripped.value).length === 0) {
          if (!dryRun) rmSync(s.path, { force: true });
          removed.push(`${s.path} (${stripped.nodes.join(", ")}; file created by wire — deleted)`);
        } else {
          if (!dryRun) writeFileSync(s.path, `${JSON.stringify(stripped.value, null, src.indent)}${layout.newline ? "\n" : ""}`);
          removed.push(`${s.path} (${stripped.nodes.join(", ")})`);
        }
      }
    }
    const bak = s.backup;
    if (settingsClean && bak !== undefined) {
      const t = fileText(bak.path);
      if (t !== null && sha256(t) === bak.hash) {
        if (!dryRun) rmSync(bak.path, { force: true });
        removed.push(bak.path);
      }
    }
  }

  // 2. Свои файлы: по хешу, как у проектного unwire.
  for (const f of j.files) {
    if (!settingsClean && s !== null && s.helpers.includes(f.path)) {
      kept.push({ path: f.path, reason: `${s.path} still runs it` });
      continue;
    }
    const text = fileText(f.path);
    if (text === null) {
      gone.push(f.path);
      continue;
    }
    if (sha256(text) !== f.hash) {
      kept.push({ path: f.path, reason: "changed after we wrote it — left alone" });
      continue;
    }
    if (!dryRun) rmSync(f.path, { force: true });
    removed.push(f.path);
  }

  // 3. MCP — только тот, что ставил wire, и только если его с тех пор не меняли.
  const m = j.mcp;
  if (m !== null && m.added) {
    const label = "MCP server myc (user scope)";
    const removeArgs = ["mcp", "remove", "--scope", "user", USER_MCP_NAME];
    const current = readUserMcpServer(m.config);
    if (current.value === undefined && !current.broken) {
      gone.push(label);
    } else if (current.broken || !sameServer(current.value ?? {}, { command: m.command, args: m.args })) {
      kept.push({ path: label, reason: `${current.broken ? `${m.config} is not valid JSON` : "changed after wire registered it"} — left alone` });
    } else {
      const claude = findClaude(env);
      if (claude === null) {
        kept.push({ path: label, reason: `claude is not on PATH — remove it yourself: ${claudeLine(removeArgs)}` });
      } else if (dryRun) {
        removed.push(`${label}: ${claudeLine(removeArgs)}`);
      } else {
        const r = runClaude(claude, removeArgs, env);
        if (r.code === 0) removed.push(`${label}: ${claudeLine(removeArgs)}`);
        else kept.push({ path: label, reason: `${claudeLine(removeArgs)}: exit ${r.code}${r.out.length > 0 ? ` (${r.out})` : ""}` });
      }
    }
  }

  // 4. Журнал и каталоги, которых до wire не было: пустые — долой, глубокие первыми.
  if (!dryRun && kept.length === 0) {
    rmSync(paths.journal, { force: true });
    for (const dir of [...j.dirs].sort((a, b) => b.length - a.length)) {
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        // каталога уже нет или он не пуст — не наше
      }
    }
  }

  const data: UnwireData = { removed, kept, gone, dry_run: dryRun };
  return { ok: true, data };
}
