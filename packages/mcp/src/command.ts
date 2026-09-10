/**
 * Команда `myc mcp` — регистрируется в CLI одной строкой (main.ts).
 * Команда и весь сервер живут здесь; CLI передаёт свой реестр, чтобы
 * диспетчер ходил в тот же движок команд, что и человек.
 */

import { run, CLI_VERSION } from "@myc/cli";
import type { RunOptions, RunResult } from "@myc/cli";
import { ensureSqliteRuntime } from "@myc/store-sqlite";
import { createDispatcher, type CliOutcome } from "./dispatch.ts";
import { McpServer, serveStdio } from "./server.ts";
import { openMcpStore } from "./store.ts";
import {
  AGENT_TOOLS,
  CODE_TOOLS,
  WORK_TOOLS,
  toolsForProfile,
  type McpToolDef,
  type McpProfile,
} from "./tools.ts";

type Registry = NonNullable<RunOptions["registry"]>;

/** Структурный минимум CommandContext — cli экспортирует только run(). */
interface McpCommandContext {
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  readonly globals: { readonly directory?: string | undefined; readonly db?: string | undefined };
}

const SERVER_RULES =
  "myc — this project's memory and tasks. Rules: start the session with myc_prime " +
  "and repeat it right after context compaction; take work with myc_ready{claim:true} " +
  "(one call — the task is yours, with all its context); before changing code, look " +
  "for context with myc_recall; write conclusions and decisions right away with myc_remember — " +
  "otherwise the next session won't know them. Ask the code tools about the code itself " +
  "instead of reading whole files: myc_code_map — orientation, myc_code_search and " +
  "myc_code_symbol — find, myc_skeleton — a file's API, myc_callers — blast radius " +
  "of an edit, myc_code_grep — every occurrence. WARN/degraded in an answer is not noise, " +
  "it means part of the system is down.";

/** "prime/ready/update" — имена без префикса, тот же вид, что был в справке. */
function toolList(tools: readonly McpToolDef[]): string {
  return tools.map((t) => t.name.replace(/^myc_/, "")).join("/");
}

/** Инструкции initialize: правила + свежий bootstrap-блок воркспейса (§4.4). */
async function buildInstructions(runCli: (argv: readonly string[]) => Promise<CliOutcome>): Promise<string> {
  try {
    const out = await runCli(["bootstrap", "--budget", "1500", "--json"]);
    const env = JSON.parse(out.stdout) as { ok: boolean; data?: { text?: string } };
    if (env.ok && typeof env.data?.text === "string" && env.data.text.trim().length > 0) {
      return `${SERVER_RULES}\n\n${env.data.text}`;
    }
  } catch {
    // без воркспейса агент всё равно обязан получить правила
  }
  return SERVER_RULES;
}

function makeRunCli(
  registry: Registry | undefined,
  globals: { directory?: string | undefined; db?: string | undefined },
): (argv: readonly string[]) => Promise<CliOutcome> {
  // -C/--db внешнего вызова наследуется всеми туловыми прогонами — иначе
  // `myc -C /proj mcp` обслуживал бы чужой cwd
  const prefix: string[] = [];
  if (globals.directory !== undefined) prefix.push("-C", globals.directory);
  if (globals.db !== undefined) prefix.push("--db", globals.db);
  return async (argv) => {
    const result: RunResult = await run([...prefix, ...argv], registry !== undefined ? { registry } : {});
    const stdout =
      typeof result.stdout === "string" ? result.stdout : [...result.stdout].join("");
    return { code: result.code, stdout, stderr: result.stderr };
  };
}

/**
 * Подъём рантайма расширений для долгоживущего сервера (решение S45,
 * дефект myc-6lc).
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ CLI И ПОЧЕМУ. В CLI команда известна заранее и
 * процесс одноразовый: `recall` просит расширения, `show` — нет, и цена
 * 4–7 мс ложится только на бюджет 25 мс. MCP-сервер живёт долго и
 * обслуживает ЛЮБОЙ инструмент своего профиля в любом порядке, а
 * `Database.setCustomSQLite` работает только до первого `new Database` в
 * процессе. Значит «лениво по потребности вызова» здесь физически
 * недостижимо: первый же `myc_prime` открыл бы базу и закрыл дорогу
 * вектору навсегда — ровно это и наблюдалось.
 *
 * Потребность поэтому считается по ПРОФИЛЮ: если среди его инструментов
 * есть хоть один с needsVector, рантайм поднимается один раз, до первого
 * открытия базы кем угодно в процессе (включая команды CLI, которые
 * сервер прогоняет сам). Профиль без таких инструментов не платит ничего.
 *
 * Отказ подъёма сервер не убивает (И2): работа идёт без вектора, причина
 * возвращается вызывающему и попадает в degraded-строку.
 */
export function vectorNeeded(tools: readonly McpToolDef[]): boolean {
  return tools.some((t) => t.needsVector === true);
}

export function raiseVectorRuntime(tools: readonly McpToolDef[]): string | undefined {
  if (!vectorNeeded(tools)) return undefined;
  try {
    ensureSqliteRuntime();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function createMcpCommand(registry?: Registry) {
  return {
    name: "mcp",
    summary: "start MCP server on stdio (agent tool profile)",
    flags: [
      {
        name: "profile",
        value: "string" as const,
        description: "agent (default); leader/full — separate task myc-zdk",
      },
    ],
    help:
      `Starts the MCP server on stdio (NDJSON JSON-RPC 2.0). Profile agent — ` +
      `${AGENT_TOOLS.length} tools: work — ${toolList(WORK_TOOLS)}; ` +
      `code — ${toolList(CODE_TOOLS)} (\`myc code index\` builds the index). ` +
      "Working rules and the bootstrap block reach the client in initialize.instructions.",
    handler: async (ctx: McpCommandContext) => {
      const profileRaw = ctx.flags["profile"];
      const profile = (typeof profileRaw === "string" ? profileRaw : "agent") as McpProfile;
      let tools;
      try {
        tools = toolsForProfile(profile);
      } catch (e) {
        return {
          ok: false as const,
          code: "usage.invalid",
          msg: e instanceof Error ? e.message : String(e),
          exit: 2 as RunResult["code"],
        };
      }

      // СТРОГО ДО первого `new Database` в процессе — до buildInstructions,
      // который прогоняет `bootstrap` и тем самым открывает базу.
      const wantsVector = vectorNeeded(tools);
      const vectorFailure = raiseVectorRuntime(tools);

      const runCli = makeRunCli(registry, ctx.globals);
      const server = new McpServer({
        tools,
        // Версия объявляется клиенту в serverInfo и это ЕДИНСТВЕННОЕ место,
        // где агент видит, какой myc к нему подключён: `myc --version` он не
        // запускает. Без неё сервер представлялся дефолтом "0.0.0" — то есть
        // врал про версию всякому клиенту, включая проверку обновлений.
        version: CLI_VERSION,
        dispatch: createDispatcher({
          runCli,
          openStore: () => openMcpStore(ctx.globals.directory, { extensions: wantsVector }),
        }),
        instructions: () => buildInstructions(runCli),
      });
      // stderr — единственный легальный канал логов в stdio-транспорте
      process.stderr.write(`myc mcp: profile ${profile}, ${tools.length} tools, stdio\n`);
      if (vectorFailure !== undefined) {
        process.stderr.write(
          `myc mcp: extension runtime failed to load, vector search unavailable: ${vectorFailure}\n`,
        );
      }
      await serveStdio(server, Bun.stdin.stream(), (chunk) => {
        process.stdout.write(chunk);
      });
      // stdout — чистый транспорт: после EOF ничего не печатаем (data:null → пустой вывод)
      return { ok: true as const, data: null };
    },
  };
}
