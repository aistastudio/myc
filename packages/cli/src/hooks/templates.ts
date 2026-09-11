/**
 * Файлы, которые генерирует `myc wire` (§6.4–6.6, решение D10).
 *
 * Правило D10 одно и оно жёсткое: myc пишет ЦЕЛИКОМ только свои файлы —
 * helper и skill. Чужие конфиги мержатся точечно, `CLAUDE.md` не трогается
 * вообще, `AGENTS.md` — только блок между маркерами и только с согласия
 * пользователя. Урок graft: чужой `CLAUDE.md` — территория пользователя,
 * переписать его значит сломать доверие один раз навсегда.
 *
 * Второе правило — нулевой ущерб при отсутствии myc: helper обязан отработать
 * и выйти с кодом 0, даже если бинаря нет вовсе. Хук, который валит сессию
 * агента, удаляют вместе с инструментом.
 */

export type HookEvent = "session-start" | "pre-compact" | "post-edit" | "stop";

/**
 * Все события списком. Нужен именно список, а не тип: `MYC_HOOK` приходит
 * строкой из окружения, и проверить её принадлежность типу в рантайме нечем —
 * а отметку хука ставит только известное событие (см. hooks/counters.ts).
 */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "session-start",
  "pre-compact",
  "post-edit",
  "stop",
];

export type ClaudeEvent = "SessionStart" | "PreCompact" | "PostToolUse" | "Stop";

export interface HookSpec {
  readonly event: HookEvent;
  readonly claudeEvent: ClaudeEvent;
  readonly matcher?: string;
  /** Таймаут, который видит хост, в мс; в конфиг хоста уходит секундами (все три хоста считают в секундах). */
  readonly timeoutMs: number;
  /** Таймаут внутри helper'а — на 500 мс меньше хостового (§6.4). */
  readonly innerMs: number;
  /** Команда myc; хук не ставится, если её нет в реестре этой сборки. */
  readonly command: string;
  /** Выражение аргументов на JS — подставляется в helper как есть. */
  readonly argsExpr: string;
  /** Блокирует агента и обязан вернуть текст в контекст. */
  readonly injectsContext: boolean;
}

/**
 * Таблица §6.1 целиком. `user-prompt` отсутствует намеренно: он платит
 * латентностью на КАЖДОМ сообщении, а попадает редко, и включается отдельно.
 */
export const HOOK_SPECS: readonly HookSpec[] = [
  {
    event: "session-start",
    claudeEvent: "SessionStart",
    timeoutMs: 3000,
    innerMs: 2500,
    command: "prime",
    // --session: личность сессии хоста (S58). Без неё сессионная память в
    // контекст не попадает вовсе, а prime честно печатает «сессия не указана».
    argsExpr: `["prime", "--budget", "2000", "--format", "agent", "--session", payload.session_id ?? ""]`,
    injectsContext: true,
  },
  {
    event: "pre-compact",
    claudeEvent: "PreCompact",
    matcher: "manual|auto",
    timeoutMs: 8000,
    innerMs: 7500,
    command: "absorb-session",
    argsExpr: `["absorb-session", "--reason", payload.trigger ?? "auto", "--transcript", payload.transcript_path ?? "-", "--budget", payload.trigger === "manual" ? "2000" : "1200", "--agent", "claude", "--session", payload.session_id ?? "", "--hook-output", HOOK_OUTPUT]`,
    injectsContext: true,
  },
  {
    event: "post-edit",
    claudeEvent: "PostToolUse",
    matcher: "Write|Edit|MultiEdit|NotebookEdit",
    timeoutMs: 1500,
    innerMs: 1000,
    command: "anchor",
    argsExpr: `["anchor", "touch", payload?.tool_input?.file_path ?? ""]`,
    injectsContext: false,
  },
  {
    event: "stop",
    claudeEvent: "Stop",
    timeoutMs: 2000,
    innerMs: 1500,
    command: "close-session",
    argsExpr: `["close-session", "--transcript", payload.transcript_path ?? "-"]`,
    injectsContext: false,
  },
];

const GENERATED = "сгенерирован `myc wire`; правки будут перезаписаны";

/** Один и тот же поиск бинаря во всех трёх helper'ах — чтобы не разъехались. */
const BIN_LOOKUP = [
  "function bin() {",
  "  const env = process.env.MYC_BIN;",
  "  if (env && existsSync(env)) return env;",
  '  for (const p of ["node_modules/.bin/myc", "dist/myc", ".myc/bin/myc"]) {',
  "    const abs = join(DIR, p);",
  "    if (existsSync(abs)) return abs;",
  "  }",
  '  const home = join(process.env.HOME ?? "", ".myc/bin/myc");',
  "  if (existsSync(home)) return home;",
  '  return "myc"; // PATH; если и там нет — spawnSync вернёт ошибку, и мы выйдем 0',
  "}",
].join("\n");

export interface HelperOptions {
  readonly events: readonly HookEvent[];
  /** json — структурный вывод для Claude Code; text — обычный stdout (§6.2). */
  readonly hookOutput: "json" | "text";
}

export function claudeHelper(opts: HelperOptions): string {
  const specs = HOOK_SPECS.filter((s) => opts.events.includes(s.event));
  const limits = specs.map((s) => `  "${s.event}": ${s.innerMs},`).join("\n");
  const args = specs.map((s) => `  "${s.event}": ${s.argsExpr},`).join("\n");
  return `#!/usr/bin/env node
// .claude/helpers/myc-hooks.mjs — ${GENERATED}.
//
// Правило одно: myc НИКОГДА не валит сессию агента. Любая ошибка, любой
// таймаут, отсутствие бинаря — выход 0 и пустой stdout.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EV = process.argv[2];
const DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOK_OUTPUT = ${JSON.stringify(opts.hookOutput)};

const LIMIT = {
${limits}
}[EV] ?? 2000;

${BIN_LOOKUP}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}

const ARGS = {
${args}
}[EV];

// post-edit без пути файла — работы нет; выходим до spawn.
if (!ARGS || (EV === "post-edit" && !ARGS[2])) process.exit(0);

try {
  const r = spawnSync(bin(), ARGS, {
    cwd: DIR,
    timeout: LIMIT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MYC_HOOK: EV, MYC_HOOK_AGENT: "claude" },
  });
  if (r.status === 0 && r.stdout) process.stdout.write(r.stdout);
} catch {}

process.exit(0);
`;
}

/**
 * Пользовательский слой Claude Code (`myc wire --scope user`,
 * memory-bh5pbp4nyjwk).
 *
 * ЗАЧЕМ. orca создаёт агентам git worktree вложенных репозиториев вне дерева
 * воркспейса (`~/orca/workspaces/<repo>/<ветка>`). Для Claude Code проект такого
 * агента — сам worktree, а в нём только файлы командного репозитория: ни
 * хуков myc, ни MCP. Единственный слой, который Claude Code читает там и
 * который не принадлежит команде, — пользовательский (`~/.claude`).
 *
 * ЦЕНА ЭТОГО СЛОЯ. Файл отсюда зовёт КАЖДАЯ сессия на машине — и в проектах
 * без myc. Поэтому до всего остального стоит сторож без единого процесса:
 *   1. есть ли здесь воркспейс myc — тот же подъём, что у самого myc
 *      (commands/wsfind.ts): первый `.myc/myc.db` вверх, домашний каталог —
 *      только как стартовый (его `.myc` — личный ярус); из git worktree —
 *      тот же подъём от того же места в основном дереве (`.git` — файл
 *      `gitdir: …`, внутри служебного каталога — `commondir`);
 *   2. не проводит ли проект myc сам: его `.claude/settings.json` (или
 *      `.local`) зовёт СВОЙ `.claude/helpers/<mark>`, и этот helper на месте —
 *      тогда работу делает он, а этот молчит, иначе prime попал бы в контекст
 *      дважды (хуки пользовательского и проектного слоя Claude Code запускает
 *      оба, одинаковые команды схлопывает, а наши разные).
 * Нет воркспейса или проводка своя — выход 0 и пустой вывод, myc не
 * запускается: хук стоит один старт node.
 *
 * Сторож — текст, который вклеивается в начало helper'а: так же он встаёт и
 * перед helper'ом очереди (его текст живёт в queue-hook.ts и здесь не
 * меняется). Импорты и имена — с префиксом `__myc`, чтобы не столкнуться с
 * именами того, перед чем он стоит; импорты ESM поднимаются, так что
 * `process.exit(0)` сторожа срабатывает раньше любого кода helper'а.
 */
export function userScopeGuard(selfDir: string, mark: string): string {
  return `import * as __mycFs from "node:fs";
import * as __mycPath from "node:path";
import { homedir as __mycHomedir } from "node:os";

// ---- user-layer guard: decides first and starts no process ----------------
// This helper lives in the user layer, so every Claude Code session on the
// machine runs it, with myc or without. It goes on only when (1) there is a
// myc workspace here and (2) the project does not wire myc itself.
const __MYC_SELF_DIR = ${JSON.stringify(selfDir)};
const __MYC_MARK = ${JSON.stringify(mark)};

// The walk-up of myc itself: the first .myc/myc.db upwards. The home
// directory counts only as the starting point: its .myc is the personal
// tier, not a project's workspace.
function __mycClimb(start) {
  const boundary = __mycPath.resolve(process.env.MYC_HOME ?? __mycHomedir());
  const dirs = [];
  let dir = __mycPath.resolve(start);
  for (let climbed = false; ; climbed = true) {
    if (climbed && dir === boundary) break;
    dirs.push(dir);
    if (__mycFs.existsSync(__mycPath.join(dir, ".myc", "myc.db"))) return { hit: dir, dirs };
    const parent = __mycPath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { hit: "", dirs };
}

// A git worktree: .git is a file "gitdir: <dir>", and <dir>/commondir names
// the shared .git of the main tree. undefined — not a worktree; "" — the
// worktree's main tree is gone.
function __mycMainTree(dir) {
  let text;
  try {
    text = __mycFs.readFileSync(__mycPath.join(dir, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const m = /^gitdir:\\s*(.+?)\\s*$/m.exec(text);
  if (m === null) return undefined;
  const gitDir = __mycPath.resolve(dir, m[1]);
  let common;
  try {
    common = __mycPath.resolve(gitDir, __mycFs.readFileSync(__mycPath.join(gitDir, "commondir"), "utf8").trim());
  } catch {
    // No commondir: a submodule, or a worktree whose main tree was taken away.
    if (__mycPath.basename(__mycPath.dirname(gitDir)) !== "worktrees") return undefined;
    common = __mycPath.dirname(__mycPath.dirname(gitDir));
    if (__mycPath.basename(common) !== ".git") return undefined;
  }
  const main = __mycPath.dirname(common);
  return __mycFs.existsSync(main) ? main : "";
}

// The same search myc runs: here, else from the same place in the main tree.
function __mycWorkspace(start) {
  const local = __mycClimb(start);
  if (local.hit !== "") return local.hit;
  for (const dir of local.dirs) {
    const main = __mycMainTree(dir);
    if (main === undefined) continue;
    if (main === "") return "";
    const rest = __mycPath.relative(dir, __mycPath.resolve(start));
    const from = rest.startsWith("..") || __mycPath.isAbsolute(rest) ? __mycPath.resolve(start) : rest === "" ? main : __mycPath.join(main, rest);
    return __mycClimb(from).hit;
  }
  return "";
}

// The project's own myc wiring: its settings run its own helper (not this
// file), and that helper exists — then it does the work.
function __mycProjectWired(dir) {
  if (!__mycFs.existsSync(__mycPath.join(dir, ".claude", "helpers", __MYC_MARK))) return false;
  for (const name of ["settings.json", "settings.local.json"]) {
    let settings;
    try {
      settings = JSON.parse(__mycFs.readFileSync(__mycPath.join(dir, ".claude", name), "utf8"));
    } catch {
      continue;
    }
    const hooks = settings !== null && typeof settings === "object" ? settings.hooks : null;
    if (hooks === null || typeof hooks !== "object") continue;
    for (const list of Object.values(hooks)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const handlers = entry !== null && typeof entry === "object" && Array.isArray(entry.hooks) ? entry.hooks : [];
        for (const h of handlers) {
          const cmd = h !== null && typeof h === "object" ? h.command : undefined;
          if (typeof cmd === "string" && cmd.includes(__MYC_MARK) && !cmd.includes(__MYC_SELF_DIR)) return true;
        }
      }
    }
  }
  return false;
}

{
  let go = false;
  try {
    const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    go = __mycWorkspace(dir) !== "" && !__mycProjectWired(dir);
  } catch {}
  if (!go) process.exit(0);
}
// ---- end of the user-layer guard -------------------------------------------
`;
}

export interface UserHelperOptions extends HelperOptions {
  /** Абсолютный каталог helper'ов пользовательского слоя: по нему сторож отличает себя от проектного. */
  readonly selfDir: string;
  /** myc, выбранный при wire: абсолютный путь или `myc` (PATH). */
  readonly mycBin: string;
}

/**
 * `~/.claude/helpers/myc-hooks.mjs`. Тело — то же, что у проектного helper'а
 * (claudeHelper): те же события, аргументы, внутренние таймауты и правило
 * «myc никогда не валит сессию»; отличий три — сторож (userScopeGuard) в
 * начале, myc, выбранный при wire, и поиск бинаря БЕЗ путей от каталога
 * проекта: в пользовательском слое проект — чужой репозиторий, и его
 * `node_modules/.bin/myc` или `dist/myc` к myc отношения не имеют.
 */
export function claudeUserHelper(opts: UserHelperOptions): string {
  const specs = HOOK_SPECS.filter((s) => opts.events.includes(s.event));
  const limits = specs.map((s) => `  "${s.event}": ${s.innerMs},`).join("\n");
  const args = specs.map((s) => `  "${s.event}": ${s.argsExpr},`).join("\n");
  return `#!/usr/bin/env node
// ${opts.selfDir}/myc-hooks.mjs — generated by \`myc wire --scope user\`; edits will be overwritten.
//
// The rule of every myc hook: myc NEVER breaks the agent's session. Any error,
// any timeout, a missing binary — exit 0 and empty stdout.
${userScopeGuard(opts.selfDir, "myc-hooks.mjs")}
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EV = process.argv[2];
const DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOK_OUTPUT = ${JSON.stringify(opts.hookOutput)};
const WIRED_BIN = ${JSON.stringify(opts.mycBin)};

const LIMIT = {
${limits}
}[EV] ?? 2000;

// MYC_BIN, then the myc chosen by wire, then ~/.myc/bin, then PATH. Nothing
// relative to the project: in the user layer it is someone else's repository.
function bin() {
  const env = process.env.MYC_BIN;
  if (env && existsSync(env)) return env;
  if (WIRED_BIN !== "myc" && existsSync(WIRED_BIN)) return WIRED_BIN;
  const home = join(process.env.HOME ?? "", ".myc/bin/myc");
  if (existsSync(home)) return home;
  return "myc";
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}

const ARGS = {
${args}
}[EV];

// post-edit with no file path has nothing to do: exit before spawning.
if (!ARGS || (EV === "post-edit" && !ARGS[2])) process.exit(0);

try {
  const r = spawnSync(bin(), ARGS, {
    cwd: DIR,
    timeout: LIMIT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MYC_HOOK: EV, MYC_HOOK_AGENT: "claude" },
  });
  if (r.status === 0 && r.stdout) process.stdout.write(r.stdout);
} catch {}

process.exit(0);
`;
}

/**
 * Helper очереди для пользовательского слоя: сторож + текст queueHelper()
 * без изменений (без его первой строки — shebang у файла один). Текст
 * helper'а очереди принадлежит queue-hook.ts; здесь он только оборачивается.
 */
export function withUserScopeGuard(helper: string, selfDir: string, mark: string, header: string): string {
  const nl = helper.indexOf("\n");
  if (!helper.startsWith("#!") || nl === -1) throw new Error("helper text without a shebang line: the user-scope guard has nowhere to go");
  return `${helper.slice(0, nl + 1)}${header}\n${userScopeGuard(selfDir, mark)}${helper.slice(nl + 1)}`;
}

/**
 * Codex (`.codex/myc-hooks.mjs` + `.codex/hooks.json`).
 *
 * Всё ниже установлено ЧТЕНИЕМ бинаря codex-cli 0.153.4
 * (`/Applications/ChatGPT.app/Contents/Resources/codex`) И ЖИВЫМ ПРОГОНОМ
 * `codex exec` на изолированном `CODEX_HOME`, а не догадкой. Локальный
 * `/opt/homebrew/bin/codex` сломан (`spawn …/codex-darwin-arm64/vendor/…
 * ENOENT`), рабочий бинарь — только в ChatGPT.app.
 *
 * 1. `notify` МЁРТВ И ОСТАЁТСЯ МЁРТВЫМ. Единственное его событие —
 *    `agent-turn-complete`, а поля payload перечислены в
 *    `hooks/src/legacy_notify.rs` целиком: `thread-id`, `turn-id`, `cwd`,
 *    `client`, `input-messages`, `last-assistant-message`. Ни стенограммы, ни
 *    события сжатия там нет. Хук эпизода через `notify` звал
 *    `absorb-session --transcript "-"` на пустой stdin, получал `empty`, и
 *    единственным его следом был счётчик, выдававший пустоту за здоровье.
 *
 * 2. РАБОЧИЙ ПУТЬ — СИСТЕМА ХУКОВ, и она ЕСТЬ В ПРОЕКТЕ. Прежняя запись в
 *    этом файле утверждала, что конфиг у неё только пользовательский
 *    (`~/.codex/hooks.json`), и это оказалось неверно: `codex` читает ОБА
 *    слоя, и проектный тоже. Живой ответ `hooks/list` app-server'а на проект
 *    с файлом `<проект>/.codex/hooks.json` перечисляет наши записи с
 *    `"source": "project"`, а до доверия проекту тот же codex печатает
 *    `configWarning`: «Project-local config, hooks, and exec policies are
 *    disabled in the following folders until the project is trusted» и
 *    называет `<проект>/.codex`. Значит положение у Codex НЕ как у Kimi:
 *    писать блок человеку в `$HOME` не нужно, D10 соблюдается — файл лежит
 *    внутри проекта.
 *
 * 3. ФОРМА ФАЙЛА — форма Claude Code: `hooks.<Event>[] = {matcher?, hooks:
 *    [{type:"command", command, timeout}]}`. События: `PreToolUse,
 *    PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart,
 *    SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop,
 *    Interrupt`. `timeout` — СЕКУНДЫ (внутри это `hook.timeout_sec`, а
 *    app-server отдаёт его как `timeoutSec`; у Claude Code 2.1.267 то же
 *    поле тоже в секундах — прежде здесь стояло «в миллисекундах», и wire
 *    писал Claude Code хуки с таймаутом в 1000 раз длиннее задуманного,
 *    см. hostTimeoutSeconds в commands/wire.ts). Команда исполняется ЧЕРЕЗ SHELL и с
 *    cwd = каталог проекта — проверено живьём (`cwd=<проект>` в хуке при
 *    относительной команде `node .codex/myc-hooks.mjs`). Подстановка
 *    `\${…}` в команде для SessionStart НЕ работает («hook input placeholder
 *    was not found», хук молча не запускается), поэтому путь относительный.
 *
 * 4. ВХОД — JSON на stdin. Схемы вкомпилированы в бинарь
 *    (`*.command.input`), и живой прогон их подтвердил дословно:
 *    SessionStart — `session_id, transcript_path, cwd, hook_event_name,
 *    model, permission_mode, source(startup|resume|clear|compact)`;
 *    PreCompact — `session_id, turn_id, transcript_path, cwd,
 *    hook_event_name, model, trigger(manual|auto)`.
 *
 * 5. КУДА ВОЗВРАЩАТЬ ПАКЕТ. `session-start.command.output` содержит
 *    `hookSpecificOutput.additionalContext` — и он ДОХОДИТ ДО МОДЕЛИ:
 *    в живом прогоне маркер, отданный хуком, вернулся дословно в ответе
 *    модели и лежит в rollout как `developer`-сообщение. А
 *    `pre-compact.command.output` — это ровно `continue, stopReason,
 *    suppressOutput, systemMessage`, и `additionalContext` там НЕТ. Поэтому
 *    helper печатает пакет только на session-start, а на pre-compact молчит.
 *    Потери нет: codex зовёт SessionStart СНОВА сразу после сжатия, с
 *    `source: "compact"` — это видно в том же прогоне, где PreCompact
 *    сработал дважды. То есть эпизод пишет pre-compact, а отдаёт его в
 *    контекст следующий за ним session-start, через обычный `myc prime`.
 *
 * 6. СТЕНОГРАММА ЕСТЬ И ОНА ФАЙЛОМ: `transcript_path` — путь к rollout JSONL
 *    (`<CODEX_HOME>/sessions/<Y>/<M>/<D>/rollout-*.jsonl`), в живом прогоне
 *    непустой и у SessionStart, и у PreCompact. Формат — свой:
 *    `{"type":"response_item","payload":{…}}`, блоки текста называются
 *    `input_text`/`output_text`, вызовы инструментов —
 *    `custom_tool_call`/`function_call`. Его понимает `parseTranscript`
 *    (см. hooks/transcript.ts): без этого absorb-session разобрал бы ноль
 *    ходов и вернул `empty` — та же тихая пустота, что у notify.
 *
 * 7. ЧЕЛОВЕК ВСЁ РАВНО НУЖЕН, ДВАЖДЫ, и молчать об этом нельзя. Проект
 *    должен быть доверенным (`[projects."<путь>"] trust_level = "trusted"`
 *    в `~/.codex/config.toml` — codex просит это сам при первом запуске), а
 *    новый или изменённый хук — просмотренным: `hooks/list` отдаёт
 *    `trustStatus: "untrusted"` для нового и `"modified"` для изменённого, и
 *    TUI встречает такую сессию экраном «N hooks are new or changed» /
 *    «hooks need review before they can run». До этого хук НЕ ЗАПУСКАЕТСЯ и
 *    ничего об этом не печатает — в `codex exec` он просто молча пропущен
 *    (проверено: тот же файл до доверия не сработал ни разу, после — сработал).
 */
export const CODEX_NEEDS_REVIEW =
  "Codex runs a hook only after two human approvals: the project must be " +
  "trusted (codex asks about it on the first run in the directory; in " +
  "~/.codex/config.toml it is `[projects.\"<path>\"] trust_level = \"trusted\"`), " +
  "and a new or changed hook must be reviewed (codex greets the session with a " +
  "\"hooks are new or changed\" screen; until then the hook silently does not run). Check: " +
  "`myc doctor --hooks` after the first session";

export const CODEX_NO_EPISODE =
  "the Codex episode hook no longer goes through `notify`: the only `notify` event " +
  "is `agent-turn-complete`, and its payload (thread-id, turn-id, cwd, " +
  "client, input-messages, last-assistant-message) has neither a transcript nor a " +
  "compaction event — absorb-session always returned `empty` there. The hooks now " +
  "live in `.codex/hooks.json` (SessionStart and PreCompact events, the transcript " +
  "comes in the `transcript_path` field)";

/**
 * Что Codex проверяет у записи хука: `timeout` в СЕКУНДАХ (см. пункт 3 выше).
 * Событий два, и это не лень: `post-edit` не ставится, потому что подтвердить
 * чтением форму `tool_input` у правящих инструментов Codex не удалось, а хук,
 * который не сработает ни разу, хуже отсутствующего — он создаёт уверенность.
 * Ровно по той же причине его нет и у Kimi.
 */
export const CODEX_EVENTS: ReadonlyMap<HookEvent, ClaudeEvent> = new Map([
  ["session-start", "SessionStart"],
  ["pre-compact", "PreCompact"],
]);

export const CODEX_HELPER_REL = ".codex/myc-hooks.mjs";

/** Команда записи хука: относительная (cwd хука — проект) и под защитой. */
export function codexHookCommand(event: HookEvent): string {
  return (
    `if [ -f ${CODEX_HELPER_REL} ]; then node ${CODEX_HELPER_REL} ${event}; ` +
    "else cat >/dev/null 2>&1 || true; fi"
  );
}

export function codexHelper(opts: HelperOptions): string {
  const specs = HOOK_SPECS.filter(
    (s) => opts.events.includes(s.event) && CODEX_EVENTS.has(s.event),
  );
  const limits = specs.map((s) => `  "${s.event}": ${s.innerMs},`).join("\n");
  const args = specs
    .map((s) =>
      s.event === "session-start"
        ? `  "session-start": ["prime", "--budget", "2000", "--format", "agent", "--session", payload.session_id ?? ""],`
        : `  "pre-compact": ["absorb-session", "--reason", payload.trigger ?? "auto", "--transcript", payload.transcript_path ?? "-", "--budget", payload.trigger === "manual" ? "2000" : "1200", "--agent", "codex", "--session", payload.session_id ?? "", "--hook-output", "text"],`,
    )
    .join("\n");
  return `#!/usr/bin/env node
// ${CODEX_HELPER_REL} — ${GENERATED}.
//
// Правило то же, что у Claude Code, opencode и Kimi: myc НИКОГДА не валит
// сессию агента. Любая ошибка, любой таймаут, отсутствие бинаря — выход 0 и
// пустой stdout. Кодом 2 Codex блокирует ход, поэтому им мы не выходим никогда.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EV = process.argv[2];

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}

// Codex зовёт хук из каталога проекта и кладёт его же в payload.cwd.
const DIR = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

const LIMIT = {
${limits}
}[EV] ?? 2000;

${BIN_LOOKUP}

const ARGS = {
${args}
}[EV];

if (!ARGS) process.exit(0);

try {
  const r = spawnSync(bin(), ARGS, {
    cwd: DIR,
    timeout: LIMIT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MYC_HOOK: EV, MYC_HOOK_AGENT: "codex" },
  });
  // additionalContext есть ТОЛЬКО у SessionStart: в схеме
  // pre-compact.command.output его нет вовсе (continue, stopReason,
  // suppressOutput, systemMessage — и всё). Печатать туда пакет значило бы
  // отдавать его в /dev/null; за сжатием codex сам зовёт SessionStart с
  // source:"compact", и пакет приходит оттуда.
  if (EV === "session-start" && r.status === 0 && r.stdout && r.stdout.trim()) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: r.stdout },
      }) + "\\n",
    );
  }
} catch {}

process.exit(0);
`;
}

/**
 * opencode (`.opencode/plugin/myc.ts`).
 *
 * Всё ниже установлено ЧТЕНИЕМ opencode 1.18.26 (единый бинарь Bun,
 * `/opt/homebrew/Cellar/opencode/1.18.26/bin/opencode`), его же типов
 * `@opencode-ai/plugin@1.18.21` (`~/.config/opencode/node_modules`) и ЖИВЫМ
 * прогоном `opencode serve` — а не догадкой по имени события. Прошлая версия
 * этого файла была собрана из догадок, и все три её половины молчали:
 *
 * 1. СОБЫТИЙ `session.start`, `session.end` И `session.compacting` У OPENCODE
 *    НЕТ. Полный список типов шины (все определения `{type:"…",schema:…}` в
 *    бинаре) содержит `session.created`, `session.updated`, `session.idle`,
 *    `session.compacted` — и ни одного из тех трёх. Хук на несуществующее имя
 *    не «иногда не срабатывает», он не срабатывает НИКОГДА.
 * 2. `client.session.appendContext` НЕ СУЩЕСТВУЕТ: ноль вхождений строки
 *    `appendContext` в 144-мегабайтном бинаре и ноль в SDK. Прошлая версия
 *    звала его через `?.`, то есть весь вывод myc молча падал на пол.
 *    Единственная дверь в контекст при сжатии — `output.context` хука
 *    `experimental.session.compacting`: opencode подклеивает эти строки к
 *    промпту суммаризации (`to = […qh(previousSummary, context), …Ve.context]`).
 * 3. СТЕНОГРАММА ЕСТЬ, но только через `client`, и её надо просить:
 *    `client.session.messages({path:{id}, query:{directory}})` →
 *    `[{info, parts}]`. Замер на живом сервере (три сообщения, 3145 байт):
 *    4 мс на вызов из хука сжатия и 2 мс из события `session.compacted`.
 *    Бюджет хука 7500 мс — влезает с тысячекратным запасом. Именно этого
 *    вызова здесь не было, и потому `absorb-session` одиннадцать сжатий
 *    подряд получал пустой ввод и писал `empty` (memory-pqtyqnej23b7).
 *
 * ФОРМА ЖИЗНИ. `Plugin.trigger` зовёт хуки как `Effect.promise(() => M(K,U))`
 * — БЕЗ catch и БЕЗ таймаута. Отброшенный промис плагина становится дефектом
 * в файбере сжатия, а зависший — вешает сжатие насмерть. Поэтому здесь всё в
 * `try/catch`, а у каждого вызова myc свой дедлайн и `proc.kill()`.
 *
 * ПОЧЕМУ ДВА ОБРАБОТЧИКА НА ОДНО СЖАТИЕ. `experimental.session.compacting`
 * — основной: он идёт ДО сжатия и умеет вернуть спасательный пакет. Но он
 * экспериментальный, и в сборке без него хук просто не позовут — молча.
 * Поэтому `session.compacted` (событие стабильное, оно и тикало те 11 раз)
 * остаётся страховкой и пишет эпизод, если основной не отработал. Двойной
 * записи нет: страховка смотрит на отметку `handled`.
 */
export function opencodePlugin(opts: HelperOptions): string {
  const sessionStart = opts.events.includes("session-start");
  const preCompact = opts.events.includes("pre-compact");
  const postEdit = opts.events.includes("post-edit");
  return `// .opencode/plugin/myc.ts — ${GENERATED}.
//
// Правило то же, что у helper'ов Claude Code, Codex и Kimi: myc НИКОГДА не
// валит сессию агента. Любая ошибка, любой таймаут, отсутствие бинаря —
// тишина и пустая строка, а не исключение из хука.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Каталог проекта: его даёт opencode в PluginInput, cwd сервера тут чужой. */
let DIR = process.cwd();

${BIN_LOOKUP}

/**
 * Один вызов myc: свой дедлайн, свой kill, ни одного проброшенного отказа.
 *
 * \`ev\` — ИМЯ СОБЫТИЯ, а не имя харнесса, и это не косметика. По \`MYC_HOOK\`
 * myc ставит отметку срабатывания в \`.myc/hooks.json\`, и она обязана означать
 * ровно то, что на ней написано. Пока здесь стояло \`MYC_HOOK: "opencode"\`,
 * \`myc doctor --hooks\` не мог отличить старт сессии от сжатия — обе отметки
 * назывались бы одинаково.
 */
const run = async (args: string[], ms: number, ev: string, stdin?: string): Promise<string> => {
  try {
    const proc = Bun.spawn([bin(), ...args], {
      cwd: DIR,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, MYC_HOOK: ev, MYC_HOOK_AGENT: "opencode" },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, ms);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return out;
  } catch {
    return "";
  }
};

/**
 * Стенограмма сессии в JSONL, который разбирает \`myc absorb-session\`.
 * Один узел сообщения — одна строка; блоки \`text\`/\`tool_use\`/\`tool_result\`
 * названы так же, как у Claude Code, потому что их и ждёт parseTranscript.
 */
const transcript = async (client: any, sessionID: string): Promise<string> => {
  try {
    const res: any = await client.session.messages({
      path: { id: sessionID },
      query: { directory: DIR },
    });
    const list: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
    const lines: string[] = [];
    for (const m of list) {
      const info: any = m?.info ?? {};
      const content: any[] = [];
      for (const part of m?.parts ?? []) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
          content.push({ type: "text", text: part.text });
        } else if (part?.type === "tool") {
          const state: any = part.state ?? {};
          content.push({ type: "tool_use", name: part.tool ?? "tool", input: state.input ?? {} });
          if (typeof state.output === "string" && state.output.length > 0) {
            content.push({ type: "tool_result", content: state.output });
          }
        }
      }
      if (content.length === 0) continue;
      lines.push(
        JSON.stringify({
          type: info.role ?? "system",
          sessionId: sessionID,
          cwd: DIR,
          message: { role: info.role ?? "system", model: info.modelID, content },
        }),
      );
    }
    return lines.length === 0 ? "" : lines.join("\\n") + "\\n";
  } catch {
    return "";
  }
};

/**
 * Эпизод сжатия. \`--transcript -\` со стенограммой на stdin: без неё
 * absorb-session честно возвращает \`empty\`, и это ровно та поломка, которую
 * \`myc doctor --hooks\` показывает как расхождение. Поэтому даже при неудачном
 * запросе вызов ДЕЛАЕТСЯ: пустой статус видно, тишину — нет.
 */
const absorb = async (client: any, sessionID: string): Promise<string> =>
  run(
    [
      "absorb-session",
      "--reason",
      "compact",
      "--transcript",
      "-",
      "--budget",
      "1200",
      "--agent",
      "opencode",
      "--session",
      sessionID,
      "--hook-output",
      "text",
    ],
    7500,
    "pre-compact",
    await transcript(client, sessionID),
  );

/** Сжатия, уже записанные основным хуком: страховка их не переписывает. */
const handled = new Map<string, number>();
const HANDLED_MS = 60000;
/** Сессии, которым уже отдали prime: он стоит запроса, а не каждого запроса. */
const primed = new Set<string>();

export const MycPlugin = async ({ client, directory }: { client: any; directory?: string }) => {
  if (typeof directory === "string" && directory.length > 0) DIR = directory;
  return {
    // Единственная дверь в контекст при сжатии (см. шапку шаблона).
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[] },
    ): Promise<void> => {
      if (!${preCompact ? "true" : "false"}) return;
      try {
        const packet = await absorb(client, input.sessionID);
        handled.set(input.sessionID, Date.now());
        if (packet.trim().length > 0) output.context.push(packet);
      } catch {}
    },
    event: async ({ event }: { event: { type: string; properties?: any } }): Promise<void> => {
      try {
        // Страховка на сборку без экспериментального хука: событие стабильное,
        // стенограмма после сжатия ещё целиком на месте (замер: 4 сообщения,
        // 6180 байт против 3 и 3145 до сжатия — сводка добавлена, история нет).
        if (${preCompact ? "true" : "false"} && event.type === "session.compacted") {
          const id = event.properties?.sessionID;
          if (typeof id !== "string" || id.length === 0) return;
          const at = handled.get(id);
          if (at !== undefined && Date.now() - at < HANDLED_MS) return;
          await absorb(client, id);
        }
      } catch {}
    },
    /**
     * prime вместо несуществующего session.start. Системный промпт — тот
     * единственный канал, который у плагина есть: событие создания сессии
     * текст доставить некуда.  Один раз на сессию, не на каждый запрос.
     */
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      if (!${sessionStart ? "true" : "false"}) return;
      try {
        const id = input?.sessionID;
        if (typeof id !== "string" || id.length === 0 || primed.has(id)) return;
        primed.add(id);
        const text = await run(["prime", "--budget", "2000", "--format", "agent", "--session", id], 2500, "session-start");
        if (text.trim().length > 0) output.system.push(text);
      } catch {}
    },
    "tool.execute.after": async (input: { tool: string; args?: any }): Promise<void> => {
      if (!${postEdit ? "true" : "false"}) return;
      try {
        const file = input?.args?.filePath ?? input?.args?.path;
        if (!["write", "edit", "patch"].includes(input?.tool) || typeof file !== "string") return;
        if (file.length === 0) return;
        await run(["anchor", "touch", file], 1000, "post-edit");
      } catch {}
    },
  };
};
`;
}

/**
 * Kimi Code (`~/.kimi-code/bin/kimi`) — helper и блок хуков.
 *
 * Всё ниже установлено ЧТЕНИЕМ САМОГО БИНАРЯ (сборка 2026-09-04), а не
 * догадкой; выдуманный конфиг здесь хуже отсутствия, потому что молча не
 * работает:
 *
 * 1. КОНФИГ ХУКОВ У KIMI ТОЛЬКО ПОЛЬЗОВАТЕЛЬСКИЙ. `resolveConfigPath()`
 *    внутри kimi — это `join(KIMI_CODE_HOME ?? ~/.kimi-code, "config.toml")`
 *    и ничего больше: проектного config.toml нет. Поэтому `myc wire`, который
 *    по D10 пишет только внутрь проекта, поставить хук Kimi НЕ МОЖЕТ и не
 *    делает вид, что может. Он ставит исполняемую половину — этот helper — и
 *    печатает блок, который человек один раз вставляет себе в
 *    `~/.kimi-code/config.toml`.
 * 2. Схема записи хука (HookDefSchema, strict): `event` из закрытого списка
 *    (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop,
 *    PreCompact, …), необязательный `matcher` — РЕГУЛЯРКА по строке события,
 *    `command` — строка, запускаемая через shell, `timeout` — целые СЕКУНДЫ
 *    1..600 (как у Claude Code и Codex; перепутать с миллисекундами — значит получить хук,
 *    который живёт в 1000 раз дольше или короче задуманного).
 * 3. Вход хука — JSON на stdin, ключи snake_case (`toHookInputData`
 *    приводит camelCase к snake_case на ВЕРХНЕМ уровне): `hook_event_name`,
 *    `session_id`, `cwd`, плюс поля события — `source` у SessionStart,
 *    `trigger` и `token_count` у PreCompact.
 * 4. Выход: код 0 и stdout, РАЗОБРАННЫЙ КАК JSON; в контекст попадает
 *    `message` (или `hookSpecificOutput.message`). Обычный текст на stdout
 *    Kimi молча игнорирует — поэтому helper заворачивает вывод myc в
 *    `{"message": …}` сам и зовёт absorb-session с `--hook-output text`:
 *    форма `hookSpecificOutput.additionalContext`, которую понимает Claude
 *    Code, для Kimi пустая. Код 2 — блокировка, поэтому helper не выходит
 *    им никогда.
 *
 * Событий здесь ДВА, и это не лень. `session-start` и `pre-compact` — те, чей
 * вход проверен по коду. Хук на правку файла (`myc anchor touch`) не ставится:
 * его матчер — имя инструмента Kimi, а форма `tool_input` зависит от схемы
 * инструмента, и ни того ни другого подтвердить чтением не удалось. Хук,
 * который не сработает ни разу, хуже отсутствующего: он создаёт уверенность.
 */
export function kimiHelper(opts: HelperOptions): string {
  const wanted: readonly HookEvent[] = ["session-start", "pre-compact"];
  const specs = HOOK_SPECS.filter((s) => opts.events.includes(s.event) && wanted.includes(s.event));
  const limits = specs.map((s) => `  "${s.event}": ${s.innerMs},`).join("\n");
  const args = specs
    .map((s) =>
      s.event === "session-start"
        ? `  "session-start": ["prime", "--budget", "2000", "--format", "agent", "--session", payload.session_id ?? ""],`
        : `  "pre-compact": ["absorb-session", "--reason", payload.trigger ?? "auto", "--transcript", transcriptPath(payload.session_id) ?? "-", "--budget", payload.trigger === "manual" ? "2000" : "1200", "--agent", "kimi", "--session", payload.session_id ?? "", "--hook-output", "text"],`,
    )
    .join("\n");
  return `#!/usr/bin/env node
// .kimi-code/myc-hooks.mjs — ${GENERATED}.
//
// Правило то же, что у Claude Code и Codex: myc НИКОГДА не валит сессию
// агента. Любая ошибка, таймаут, отсутствие бинаря — выход 0 и пустой
// stdout. Кодом 2 Kimi блокирует ход, поэтому им мы не выходим никогда.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EV = process.argv[2];

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}

// Kimi запускает хук из каталога сессии и кладёт его же в payload.cwd.
const DIR = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

// СТЕНОГРАММА У KIMI: её нет во входе хука, но она есть на диске.
// Прочитано в бинаре (сборка 2026-09-04): PreCompact зовётся как
// \`trigger("PreCompact", {inputData: withSessionFacts({trigger, tokenCount})})\`,
// а \`withSessionFacts\` добавляет ровно \`sessionTitle\`; строка
// \`transcript_path\` не встречается в бинаре НИ РАЗУ. Значит \`--transcript -\`
// читал пустоту: stdin к этому моменту уже вычерпан разбором payload выше.
// Зато сессия лежит файлом: \`~/.kimi-code/session_index.jsonl\` сопоставляет
// \`sessionId\` → \`sessionDir\`, а внутри \`agents/main/wire.jsonl\` — тот самый
// JSONL, где \`{"type":"context.append_message","message":{role,content}}\`
// читается parseTranscript как ход без единой поправки.
function transcriptPath(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const home = process.env.KIMI_CODE_HOME || join(process.env.HOME ?? "", ".kimi-code");
  const index = join(home, "session_index.jsonl");
  if (!existsSync(index)) return null;
  try {
    for (const line of readFileSync(index, "utf8").split("\\n")) {
      if (!line.includes(sessionId)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.sessionId !== sessionId || typeof rec?.sessionDir !== "string") continue;
      const wire = join(rec.sessionDir, "agents", "main", "wire.jsonl");
      return existsSync(wire) ? wire : null;
    }
  } catch {}
  return null;
}

const LIMIT = {
${limits}
}[EV] ?? 2000;

${BIN_LOOKUP}

const ARGS = {
${args}
}[EV];

if (!ARGS) process.exit(0);

try {
  const r = spawnSync(bin(), ARGS, {
    cwd: DIR,
    timeout: LIMIT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MYC_HOOK: EV, MYC_HOOK_AGENT: "kimi" },
  });
  // В контекст Kimi попадает только JSON с полем message — обычный stdout
  // он разбирает и молча выбрасывает.
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    process.stdout.write(JSON.stringify({ message: r.stdout }) + "\\n");
  }
} catch {}

process.exit(0);
`;
}

/** Что Kimi проверяет у записи хука: секунды, не миллисекунды (schema выше). */
const KIMI_EVENTS: ReadonlyMap<HookEvent, string> = new Map([
  ["session-start", "SessionStart"],
  ["pre-compact", "PreCompact"],
]);

/**
 * Блок для `~/.kimi-code/config.toml`. Команда ОТНОСИТЕЛЬНАЯ и защищена
 * проверкой существования файла: конфиг у Kimi один на все проекты, и хук,
 * прибитый к абсолютному пути одного репозитория, срабатывал бы в каждой
 * чужой сессии. `cat >/dev/null` в ветке else — чтобы Kimi не ждал на
 * незакрытом stdin.
 */
export function kimiHooksToml(events: readonly HookEvent[]): string {
  const lines: string[] = ["# myc:kimi:start"];
  for (const [event, kimiEvent] of KIMI_EVENTS) {
    if (!events.includes(event)) continue;
    const spec = HOOK_SPECS.find((s) => s.event === event);
    const seconds = Math.max(1, Math.ceil((spec?.timeoutMs ?? 3000) / 1000));
    lines.push(
      "[[hooks]]",
      `event = "${kimiEvent}"`,
      `command = "if [ -f .kimi-code/myc-hooks.mjs ]; then node .kimi-code/myc-hooks.mjs ${event}; else cat >/dev/null 2>&1 || true; fi"`,
      `timeout = ${seconds}`,
      "",
    );
  }
  lines.push("# myc:kimi:end");
  return lines.join("\n");
}

/** Вся инструкция агенту живёт в скилле, а не в CLAUDE.md (D10). */
export function skillMd(): string {
  return `---
name: myc
description: Project memory, tasks and links. Use it when you need to learn
  the state of the project, take the next task, recall a past decision, record
  a finding, see which tasks relate to the file you are editing, or find where
  code lives and who calls it. Only in projects with a myc workspace (a .myc
  directory here, in a parent, or in the main tree of this git worktree).
---

# myc

One graph: tasks with dependencies, project memory, links to code.

## Workflow

1. \`myc prime\` — what is going on (the hook does this itself at session start).
2. \`myc ready --claim\` — take work atomically.
3. \`myc recall "<question>"\` — before inventing: maybe this was already solved.
4. \`myc remember "<finding>"\` — after every non-trivial finding.
5. \`myc close <id> --reason "<what and why>"\` — when closing, explain.

## Rules

- One fact = one \`remember\`. Don't write paragraphs.
- Don't record code or secrets — record findings.
- A contradiction does not overwrite the old note: \`myc link A supersedes B --reason "..."\`.
- A \`WARN degraded.*\` line in a response means part of the index is not working
  and the search is incomplete — don't treat an empty answer as proof of absence.
- Heavy commands (the full test suite, a build) go through \`myc run -- <cmd>\`:
  agents on one machine take turns instead of fighting for the cores; \`myc queue\` shows who is ahead.
  \`myc run\` runs what it is given, so Claude Code asks about it unless your rules allow the command itself.

## Code

Ask the code index before grepping or reading whole files:

- \`myc code map\` — orientation: directory clusters, their hubs, who depends on them.
- \`myc code search "<question>"\` — ranked, by meaning; \`myc code symbol <name>\` — where it is defined.
- \`myc code grep "<literal>"\` — every occurrence with its owner; \`--in <dir>\` narrows it.
- \`myc skeleton <file>\` — a file's API in a fraction of its bytes.
- \`myc callers <name>\` — who calls it; run it before renaming or changing a signature.

After large changes refresh the index: \`myc code index\` (incremental).

## Context compaction

Before compaction the \`pre-compact\` hook writes an episode itself and returns a rescue
packet. If you see a block starting with "# myc:" that says the context is being
compacted — that is exactly what must not be lost; everything else can be restored
with \`myc show <episode>\`.
`;
}

export const AGENTS_START = "<!-- myc:start -->";
export const AGENTS_END = "<!-- myc:end -->";

export function agentsBlock(): string {
  return `${AGENTS_START}
## myc — project memory and tasks

\`myc_*\` tools (MCP) or the \`myc\` CLI. Order: \`myc prime\` → \`myc ready --claim\`
→ \`myc recall\` before a decision → \`myc remember\` after a finding → \`myc close --reason\`.
Code, before reading whole files: \`myc code map\`, \`myc code search\`, \`myc code grep\`,
\`myc skeleton <file>\`, \`myc callers <name>\`.
Heavy commands (the full test suite, a build): \`myc run -- <cmd>\`, one machine-wide queue.
Full instructions: \`myc --help\`, \`.claude/skills/myc/SKILL.md\`.
${AGENTS_END}`;
}
