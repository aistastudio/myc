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

export type ClaudeEvent = "SessionStart" | "PreCompact" | "PostToolUse" | "Stop";

export interface HookSpec {
  readonly event: HookEvent;
  readonly claudeEvent: ClaudeEvent;
  readonly matcher?: string;
  /** Таймаут, который видит хост. */
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
    env: { ...process.env, MYC_HOOK: EV },
  });
  if (r.status === 0 && r.stdout) process.stdout.write(r.stdout);
} catch {}

process.exit(0);
`;
}

export function codexNotify(opts: HelperOptions): string {
  const preCompact = opts.events.includes("pre-compact");
  return `#!/usr/bin/env node
// .codex/myc-notify.mjs — ${GENERATED}.
//
// У Codex поверхность тоньше: событие приходит одним JSON-аргументом.
// Настоящего pre-compact в части версий нет вовсе — тогда эпизод пишется по
// завершении хода, и \`myc doctor --hooks\` сообщает об этом честно, а не
// делает вид, что контекст защищён.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.CODEX_PROJECT_DIR || process.cwd();

${BIN_LOOKUP}

let ev = {};
try {
  const arg = process.argv[2];
  ev = JSON.parse(arg && arg.trim().startsWith("{") ? arg : readFileSync(0, "utf8") || "{}");
} catch {}

const type = ev.type ?? ev.event ?? "";
const transcript = ev["rollout-path"] ?? ev.rollout_path ?? ev.transcript_path ?? "-";
// S58: чьей сессии принадлежит записанное. Пусто — охват выведется из эпизода.
const session = ev.session_id ?? ev.conversation_id ?? ev.thread_id ?? "";

let args = null;
let limit = 1500;
if (${preCompact ? "true" : "false"} && /compact/i.test(type)) {
  args = ["absorb-session", "--reason", "compact", "--transcript", transcript, "--agent", "codex", "--session", session];
  limit = 7500;
} else if (/turn[-_.]?complete|agent[-_.]?turn|session[-_.]?end/i.test(type)) {
  args = ["absorb-session", "--reason", "auto", "--transcript", transcript, "--agent", "codex", "--session", session];
  limit = 2000;
}

if (!args) process.exit(0);

try {
  spawnSync(bin(), args, {
    cwd: DIR,
    timeout: limit,
    encoding: "utf8",
    env: { ...process.env, MYC_HOOK: "codex-notify" },
  });
} catch {}

process.exit(0);
`;
}

export function opencodePlugin(opts: HelperOptions): string {
  const postEdit = opts.events.includes("post-edit");
  return `// .opencode/plugin/myc.ts — ${GENERATED}.
//
// У opencode есть и MCP, и события плагинов — доступны обе половины. Форма
// та же, что у helper'ов Claude Code и Codex: любая ошибка проглатывается,
// сессия агента не страдает никогда.

const run = async (args: string[], ms: number): Promise<string> => {
  try {
    const proc = Bun.spawn(["myc", ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), ms);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return out;
  } catch {
    return "";
  }
};

export const MycPlugin = async ({ client }: { client: any }) => ({
  event: async ({ event }: { event: { type: string } }) => {
    if (event.type === "session.start") {
      client.session?.appendContext?.(
        await run(["prime", "--budget", "2000", "--format", "agent"], 2500),
      );
    }
    if (event.type === "session.compacting" || event.type === "session.compacted") {
      client.session?.appendContext?.(
        await run(
          ["absorb-session", "--reason", "compact", "--budget", "1200", "--agent", "opencode"],
          7500,
        ),
      );
    }
    if (event.type === "session.idle" || event.type === "session.end") {
      await run(["absorb-session", "--reason", "auto", "--agent", "opencode"], 1500);
    }
  },
  "tool.execute.after": async ({ tool, args }: { tool: string; args: any }) => {
    if (${postEdit ? "true" : "false"} && ["write", "edit", "patch"].includes(tool) && args?.filePath) {
      await run(["anchor", "touch", args.filePath], 1000);
    }
  },
});
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
 *    1..600 (у Claude Code миллисекунды; перепутать — значит получить хук,
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
        : `  "pre-compact": ["absorb-session", "--reason", payload.trigger ?? "auto", "--transcript", "-", "--budget", payload.trigger === "manual" ? "2000" : "1200", "--agent", "kimi", "--session", payload.session_id ?? "", "--hook-output", "text"],`,
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
    env: { ...process.env, MYC_HOOK: EV },
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
description: Память, задачи и связи проекта. Используй, когда нужно узнать
  состояние проекта, взять следующую задачу, вспомнить прошлое решение, записать
  вывод или понять, какие задачи связаны с файлом, который ты правишь.
---

# myc

Один граф: задачи с зависимостями, память проекта, привязки к коду.

## Порядок работы

1. \`myc prime\` — что происходит (хук делает это сам в начале сессии).
2. \`myc ready --claim\` — взять работу атомарно.
3. \`myc recall "<вопрос>"\` — прежде чем изобретать: возможно, это уже решали.
4. \`myc remember "<вывод>"\` — после каждого нетривиального вывода.
5. \`myc close <id> --reason "<что и почему>"\` — закрывая, объясни.

## Правила

- Один факт = один \`remember\`. Не пиши абзацы.
- Не записывай код и секреты — записывай выводы.
- Противоречие не затирает старое: \`myc link A supersedes B --reason "..."\`.
- Строка \`WARN degraded.*\` в ответе означает, что часть индекса не работает
  и поиск неполон — не считай пустой ответ доказательством отсутствия.

## Сжатие контекста

Перед компактом хук \`pre-compact\` сам пишет эпизод и возвращает спасательный
пакет. Если ты видишь блок «myc: контекст сжимается» — это и есть то, что
нельзя потерять; всё остальное восстанавливается из \`myc show <эпизод>\`.
`;
}

export const AGENTS_START = "<!-- myc:start -->";
export const AGENTS_END = "<!-- myc:end -->";

export function agentsBlock(): string {
  return `${AGENTS_START}
## myc — память и задачи проекта

Инструменты \`myc_*\` (MCP) или CLI \`myc\`. Порядок: \`myc prime\` → \`myc ready --claim\`
→ \`myc recall\` перед решением → \`myc remember\` после вывода → \`myc close --reason\`.
Полная инструкция: \`myc --help\`, \`.claude/skills/myc/SKILL.md\`.
${AGENTS_END}`;
}
