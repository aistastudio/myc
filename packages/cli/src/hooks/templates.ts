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
