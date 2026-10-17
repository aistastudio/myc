/**
 * Интерактивный мастер `myc init` (задача memory-43q5mmra1cfg).
 *
 * СВОЙСТВО «ZERO QUESTIONS» СОХРАНЯЕТСЯ. Агенты и скрипты запускают init без
 * терминала и не обязаны отвечать ни на один вопрос, поэтому мастер
 * включается ТОЛЬКО когда (а) явно попросили флагом `--interactive`
 * (скрипты и тесты кормят ответы через stdin), или (б) stdin И stdout —
 * терминал, и при этом не заданы `--json`/`--ndjson`/`--quiet`. Любой флаг
 * слага тоже выключает вопросы о слаге — мастер отвечает там, где ответ уже
 * есть.
 *
 * СЕТЬ ТОЛЬКО ПО ЯВНОМУ ВЫБОРУ. Мастер сам ничего не качает: модель и
 * грамматики скачиваются только если человек набрал соответствующий выбор;
 * запись `server`/`sync` в конфиг и `.myc/token` — локальные файлы, сети не
 * требуют. Сбой любого пост-шага НЕ роняет уже созданный воркспейс: он
 * именованно попадает в warnings (И2), а не в отказ.
 *
 * ОТВЕТЫ ПЕРЕДАЮТСЯ ЧЕРЕЗ `ask` — в терминале это readline по stdin, в
 * тестах — подделка с очередью строк. Один код, две среды.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_MODEL_ID, MODELS } from "@myc/embed";
import { HARNESSES } from "@myc/swarm";
import { ExitCode } from "../exit.ts";
import { defaultRegistry, type CommandContext, type CommandResult } from "../registry.ts";
import { flagBool } from "./store.ts";

/** Что выбрал человек. Пусто = не выбиралось; поля применяет applyWizardPlan. */
export interface WizardPlan {
  readonly slug?: string;
  readonly codeIntel?: "builtin" | "auto" | "graft" | "off";
  /** id модели из MODELS; отсутствие — не качать. */
  readonly embedModel?: string;
  readonly grammars?: boolean;
  readonly server?: { readonly url: string; readonly token?: string };
  readonly sync?: "auto" | "manual";
  /** Пустой список — wire не звать. */
  readonly agents?: readonly string[];
  readonly agentsMd?: boolean;
  readonly statusline?: boolean;
  readonly queueHook?: boolean;
}

export type Ask = (
  question: string,
  opts?: { readonly def?: string; readonly hidden?: boolean },
) => Promise<string>;

export interface WizardInput {
  readonly ask: Ask;
  readonly close?: () => void;
  /** Спрашивать slug: только когда ни конфига, ни базы ещё нет. */
  readonly askSlug: boolean;
  readonly defaultSlug: string;
  /** Спрашивать code_intel: в конфиге этой строки ещё нет. */
  readonly askCodeIntel: boolean;
  readonly graftFound: boolean;
}

/** Включён ли мастер. `--interactive` — принудительно (скрипты и тесты). */
export function wizardEnabled(ctx: CommandContext): boolean {
  // Машиночитаемый вывод важнее принудительного флага: под --json промпты
  // испортили бы поток конверта, поэтому --json/--ndjson выключают мастера
  // даже при --interactive.
  if (ctx.globals.json || ctx.globals.ndjson) return false;
  if (flagBool(ctx, "interactive")) return true;
  if (ctx.globals.quiet) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

const SLUG_RE = /^[a-z][a-z0-9]{1,7}$/;
// Имена харнессов — ТОЛЬКО из канонического списка (сторож harness.wiring):
// перечисление вторым местом — ровно тот дефект, который он ловит.
const KNOWN_AGENTS: readonly string[] = HARNESSES;
const CODE_INTEL_MODES = ["builtin", "auto", "graft", "off"] as const;

async function askSlugPlan(i: WizardInput): Promise<string | undefined> {
  if (!i.askSlug) return undefined;
  for (let n = 0; n < 3; n++) {
    const a = (await i.ask(`Slug of this workspace (^[a-z][a-z0-9]{1,7}$)`, {
      def: i.defaultSlug,
    })).trim();
    if (a === "") return i.defaultSlug;
    if (SLUG_RE.test(a)) return a;
    process.stderr.write(`  not a slug: "${a}" — one letter, then letters and digits, max 8\n`);
  }
  return i.defaultSlug;
}

async function askCodeIntelPlan(i: WizardInput): Promise<WizardPlan["codeIntel"]> {
  if (!i.askCodeIntel) return undefined;
  process.stderr.write(
    `Code intelligence${i.graftFound ? " (graft found in this repo)" : ""}:\n` +
      `  1) builtin (default) — symbols and callers in-process\n` +
      `  2) auto — detect per repository    3) graft — external indexer    4) off\n`,
  );
  for (let n = 0; n < 3; n++) {
    const a = (await i.ask("Choice", { def: "1" })).trim().toLowerCase();
    if (a === "" || a === "1") return "builtin";
    if (a === "2" || a === "auto") return "auto";
    if (a === "3" || a === "graft") return "graft";
    if (a === "4" || a === "off") return "off";
    process.stderr.write(`  answer 1-4 (or builtin|auto|graft|off)\n`);
  }
  return "builtin";
}

async function askEmbedPlan(i: WizardInput): Promise<string | undefined> {
  const ids = Object.keys(MODELS);
  process.stderr.write(
    "Embedding model for semantic search (downloads only if you choose it):\n" +
      "  0) none — lexical search only (default)\n" +
      ids
        .map((id, n) => `  ${n + 1}) ${id}${id === DEFAULT_MODEL_ID ? " — multilingual, recommended" : ""}`)
        .join("\n") +
      "\n",
  );
  for (let n = 0; n < 3; n++) {
    const a = (await i.ask("Choice", { def: "0" })).trim().toLowerCase();
    if (a === "" || a === "0") return undefined;
    if (a === String(ids.length + 1) || a === "none") return undefined;
    const byNum = /^\d+$/.test(a) ? ids[Number(a) - 1] : undefined;
    const id = byNum ?? (ids.includes(a) ? a : undefined);
    if (id !== undefined) return id;
    process.stderr.write(`  answer 0-${ids.length} or the model id\n`);
  }
  return undefined;
}

async function askServerPlan(i: WizardInput): Promise<Pick<WizardPlan, "server" | "sync">> {
  for (let n = 0; n < 3; n++) {
    const raw = (await i.ask("Team server URL, Enter to skip (https://host/ws)", {})).trim();
    if (raw === "") return {};
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!/^https?:\/\/[^/\s]+/i.test(url)) {
      process.stderr.write(`  not an http(s) address: "${raw}"\n`);
      continue;
    }
    const token = (await i.ask("Access token (myc_…), Enter to skip", { hidden: true })).trim();
    const auto = (await i.ask("Background sync, exchange automatically", { def: "Y" }))
      .trim()
      .toLowerCase();
    const sync: WizardPlan["sync"] = auto === "" || auto === "y" || auto === "yes" ? "auto" : "manual";
    return { server: token === "" ? { url } : { url, token }, sync };
  }
  process.stderr.write("  no server configured\n");
  return {};
}

async function askAgentsPlan(i: WizardInput): Promise<Pick<WizardPlan, "agents" | "agentsMd" | "statusline" | "queueHook">> {
  process.stderr.write(
    "Wire agent harnesses (hooks, MCP server, skill)?\n" +
      `  1) all six: ${KNOWN_AGENTS.join(",")}\n` +
      "  2) choose    3) skip (default)\n",
  );
  const choice = (await i.ask("Choice", { def: "3" })).trim().toLowerCase();
  let agents: string[] = [];
  if (choice === "1" || choice === "all") {
    agents = [...KNOWN_AGENTS];
  } else if (choice === "2" || choice === "choose") {
    const a = (await i.ask(`Agents from ${KNOWN_AGENTS.join(",")}`, {})).trim().toLowerCase();
    agents = a
      .split(",")
      .map((s) => s.trim())
      .filter((s) => KNOWN_AGENTS.includes(s));
    if (agents.length === 0) {
      process.stderr.write("  none of those names — skipping wire\n");
      return { agents: [] };
    }
  } else {
    return { agents: [] };
  }
  const yes = async (q: string): Promise<boolean> => {
    const a = (await i.ask(q, { def: "N" })).trim().toLowerCase();
    return a === "y" || a === "yes";
  };
  const agentsMd = await yes("Insert the myc block into AGENTS.md?");
  const statusline = await yes("Add myc's status line (Claude Code only)?");
  const queueHook = await yes("Route heavy Bash commands through myc run (queue hook)?");
  return { agents, agentsMd, statusline, queueHook };
}

/** Собрать план по очереди вопросов. Поля появляются только при выборе. */
export async function runInitWizard(i: WizardInput): Promise<WizardPlan> {
  try {
    const slug = await askSlugPlan(i);
    const codeIntel = await askCodeIntelPlan(i);
    const embedModel = await askEmbedPlan(i);
    const grammars =
      codeIntel === "off"
        ? false
        : (await (async () => {
            const a = (await i.ask("Download code grammars now (myc code fetch)?", { def: "N" }))
              .trim()
              .toLowerCase();
            return a === "y" || a === "yes";
          })());
    const { server, sync } = await askServerPlan(i);
    const agentsPart = await askAgentsPlan(i);
    const wired = agentsPart.agents !== undefined && agentsPart.agents.length > 0;
    return {
      ...(slug !== undefined ? { slug } : {}),
      ...(codeIntel !== undefined ? { codeIntel } : {}),
      ...(embedModel !== undefined ? { embedModel } : {}),
      ...(grammars ? { grammars: true } : {}),
      ...(server !== undefined ? { server, ...(sync !== undefined ? { sync } : {}) } : {}),
      // Пропуск wire не оставляет пустого списка в плане: пусто — это «не
      // выбиралось», а не «выбирали и отказались».
      ...(wired ? agentsPart : {}),
    };
  } finally {
    i.close?.();
  }
}

/** Readline-вопросник поверх stdin терминала. */
export function terminalAsk(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, opts) => {
    const def = opts?.def;
    const prompt = def !== undefined && def !== "" ? `${question} [${def}]: ` : `${question}: `;
    const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = anyRl._writeToOutput;
    if (opts?.hidden === true && typeof original === "function") {
      anyRl._writeToOutput = () => {}; // не подсказывать эхо токена в терминал
    }
    try {
      const a = await rl.question(prompt);
      return a;
    } finally {
      if (original !== undefined) anyRl._writeToOutput = original;
    }
  };
  return { ask, close: () => rl.close() };
}

/**
 * Вопросник для ПАЙПА (`--interactive` в скриптах и тестах). Readline здесь
 * не работает: пайп отдаёт весь текст и EOF сразу, и к третьему вопросу
 * event loop пустеет — процесс молча завершается, не дочитав ответы. Поэтому
 * stdin читается целиком до EOF, а ответы выдаются построчно; пустой хвост —
 * это умолчания, а не зависание.
 */
export function pipedReader(stdin: ReadableStream<Uint8Array> = Bun.stdin.stream()): {
  ask: Ask;
  close: () => void;
} {
  const reader = stdin.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) text += decoder.decode(value, { stream: true });
    }
  })().catch(() => {});
  let pos = 0;
  const ask: Ask = async (question, opts) => {
    const def = opts?.def;
    process.stdout.write(def !== undefined && def !== "" ? `${question} [${def}]: \n` : `${question}: \n`);
    await pump;
    const nl = text.indexOf("\n", pos);
    const line = (nl === -1 ? text.slice(pos) : text.slice(pos, nl)).trim();
    pos = nl === -1 ? text.length : nl + 1;
    return line;
  };
  return { ask, close: () => {} };
}

function askIo(): { ask: Ask; close: () => void } {
  return process.stdin.isTTY === true ? terminalAsk() : pipedReader();
}

/** Выключателей у мастера нет намеренно: решает только терминал или флаг. */
export async function maybeRunWizard(
  ctx: CommandContext,
  o: {
    readonly priorSlug: string | undefined;
    readonly hadDb: boolean;
    readonly workspaceDir: string;
    readonly defaultSlug: string;
    readonly codeIntelMissing: boolean;
    readonly graftFound: boolean;
  },
): Promise<WizardPlan | undefined> {
  if (!wizardEnabled(ctx)) return undefined;
  if (flagBool(ctx, "global")) return undefined;
  const { ask, close } = askIo();
  return runInitWizard({
    ask,
    close,
    askSlug: o.priorSlug === undefined && !o.hadDb,
    defaultSlug: o.defaultSlug,
    askCodeIntel: o.codeIntelMissing,
    graftFound: o.graftFound,
  });
}

// ---------------------------------------------------------------------------
// Применение плана
// ---------------------------------------------------------------------------

export interface WizardApplied {
  /** Что записано/сделано — попадает в вывод init. */
  readonly applied: string[];
  /** Что делать дальше — к строке `next` вывода. */
  readonly next: string[];
  /** Сбои пост-шагов: называются WARN'ом, воркспейс не трогают. */
  readonly warnings: readonly { readonly code: string; readonly msg: string }[];
}

export interface WizardDeps {
  readonly runModelsFetch: (ctx: CommandContext, modelId: string) => Promise<CommandResult>;
  readonly runCodeFetch: (ctx: CommandContext) => Promise<CommandResult>;
  readonly runWire: (ctx: CommandContext, flags: Record<string, string | boolean>) => Promise<CommandResult>;
}

const noHandler = (name: string): CommandResult => ({
  ok: false,
  code: "internal.unexpected",
  msg: `${name}: no handler wired`,
  exit: ExitCode.ERR,
});

/** Пост-шаги зовутся теми же обработчиками команд, что и прямой запуск. */
export const realWizardDeps: WizardDeps = {
  runModelsFetch: async (ctx, modelId) => {
    const { createModelsCommand } = await import("./models.ts");
    const models = createModelsCommand();
    const fetch = (models.subcommands ?? []).find((c) => c.name === "fetch") ?? models;
    if (fetch.handler === undefined) return noHandler("models fetch");
    return fetch.handler(withArgs(ctx, [modelId], {}));
  },
  runCodeFetch: async (ctx) => {
    const { createCodeCommand } = await import("./code.ts");
    const code = createCodeCommand();
    const fetch = (code.subcommands ?? []).find((c) => c.name === "fetch") ?? code;
    if (fetch.handler === undefined) return noHandler("code fetch");
    return fetch.handler(withArgs(ctx, ["fetch"], {}));
  },
  runWire: async (ctx, flags) => {
    const { createWireCommand } = await import("./wire.ts");
    const wire = createWireCommand(defaultRegistry);
    if (wire.handler === undefined) return noHandler("wire");
    return wire.handler(withArgs(ctx, [], flags));
  },
};

function withArgs(
  ctx: CommandContext,
  args: readonly string[],
  flags: Record<string, string | boolean>,
): CommandContext {
  return { ...ctx, args, flags: { ...ctx.flags, ...flags } as CommandContext["flags"] };
}

/** `key = "value"` в workspace.toml: заменить строку или дописать в конец. */
export function setTomlKey(mycDir: string, key: string, value: string): void {
  const path = join(mycDir, "workspace.toml");
  const line = `${key} = "${value}"`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, "m").test(existing)
    ? existing.replace(new RegExp(`^${key}\\s*=\\s*"[^"]*"`, "m"), line)
    : `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${line}\n`;
  writeFileSync(path, next, "utf8");
}

/**
 * Применить план ПОСЛЕ создания воркспейса (workspace.toml уже существует).
 * Сбои пост-шагов — в warnings, никогда не отказ: база уже создана, и человек
 * получает воркспейс даже если сеть недоступна.
 */
export async function applyWizardPlan(
  ctx: CommandContext,
  plan: WizardPlan,
  o: { readonly mycDir: string },
  deps: WizardDeps = realWizardDeps,
): Promise<WizardApplied> {
  const applied: string[] = [];
  const next: string[] = [];
  const warnings: { code: string; msg: string }[] = [];

  if (plan.server !== undefined) {
    setTomlKey(o.mycDir, "server", plan.server.url);
    applied.push(`server = "${plan.server.url}"`);
    if (plan.server.token !== undefined) {
      try {
        writeFileSync(join(o.mycDir, "token"), `${plan.server.token}\n`, "utf8");
        applied.push(".myc/token");
      } catch (e) {
        warnings.push({
          code: "wizard.token",
          msg: `.myc/token not written: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } else {
      warnings.push({
        code: "wizard.token",
        msg: "no token given — .myc/token not written; myc sync will name the missing token",
      });
    }
    if (plan.sync !== undefined) {
      setTomlKey(o.mycDir, "sync", plan.sync);
      applied.push(`sync = "${plan.sync}"`);
    }
  }

  if (plan.embedModel !== undefined) {
    const r = await deps.runModelsFetch(ctx, plan.embedModel);
    if (r.ok) applied.push(`model ${plan.embedModel}`);
    else warnings.push({ code: "wizard.model", msg: `models fetch: ${r.msg}` });
  }

  if (plan.grammars === true) {
    const r = await deps.runCodeFetch(ctx);
    if (r.ok) applied.push("code grammars");
    else warnings.push({ code: "wizard.grammars", msg: `code fetch: ${r.msg}` });
  }

  if (plan.agents !== undefined && plan.agents.length > 0) {
    const r = await deps.runWire(ctx, {
      agents: plan.agents.join(","),
      ...(plan.agentsMd === true ? { "agents-md": true } : {}),
      ...(plan.statusline === true ? { "status-line": true } : {}),
      ...(plan.queueHook === true ? { "queue-hook": true } : {}),
    });
    if (r.ok) {
      applied.push(`wired: ${plan.agents.join(",")}`);
      next.push("myc ready");
    } else {
      warnings.push({ code: "wizard.wire", msg: `wire: ${r.msg}` });
    }
  }

  if (plan.server !== undefined) next.push("myc sync");
  return { applied, next, warnings };
}
