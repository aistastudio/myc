// .opencode/plugin/myc.ts — сгенерирован `myc wire`; правки будут перезаписаны.
//
// Правило то же, что у helper'ов Claude Code, Codex и Kimi: myc НИКОГДА не
// валит сессию агента. Любая ошибка, любой таймаут, отсутствие бинаря —
// тишина и пустая строка, а не исключение из хука.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Каталог проекта: его даёт opencode в PluginInput, cwd сервера тут чужой. */
let DIR = process.cwd();

function bin() {
  const env = process.env.MYC_BIN;
  if (env && existsSync(env)) return env;
  for (const p of ["node_modules/.bin/myc", "dist/myc", ".myc/bin/myc"]) {
    const abs = join(DIR, p);
    if (existsSync(abs)) return abs;
  }
  const home = join(process.env.HOME ?? "", ".myc/bin/myc");
  if (existsSync(home)) return home;
  return "myc"; // PATH; если и там нет — spawnSync вернёт ошибку, и мы выйдем 0
}

/**
 * Один вызов myc: свой дедлайн, свой kill, ни одного проброшенного отказа.
 *
 * `ev` — ИМЯ СОБЫТИЯ, а не имя харнесса, и это не косметика. По `MYC_HOOK`
 * myc ставит отметку срабатывания в `.myc/hooks.json`, и она обязана означать
 * ровно то, что на ней написано. Пока здесь стояло `MYC_HOOK: "opencode"`,
 * `myc doctor --hooks` не мог отличить старт сессии от сжатия — обе отметки
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
 * Стенограмма сессии в JSONL, который разбирает `myc absorb-session`.
 * Один узел сообщения — одна строка; блоки `text`/`tool_use`/`tool_result`
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
    return lines.length === 0 ? "" : lines.join("\n") + "\n";
  } catch {
    return "";
  }
};

/**
 * Эпизод сжатия. `--transcript -` со стенограммой на stdin: без неё
 * absorb-session честно возвращает `empty`, и это ровно та поломка, которую
 * `myc doctor --hooks` показывает как расхождение. Поэтому даже при неудачном
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
      if (!true) return;
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
        if (true && event.type === "session.compacted") {
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
      if (!true) return;
      try {
        const id = input?.sessionID;
        if (typeof id !== "string" || id.length === 0 || primed.has(id)) return;
        primed.add(id);
        const text = await run(["prime", "--budget", "2000", "--format", "agent", "--session", id], 2500, "session-start");
        if (text.trim().length > 0) output.system.push(text);
      } catch {}
    },
    "tool.execute.after": async (input: { tool: string; args?: any }): Promise<void> => {
      if (!true) return;
      try {
        const file = input?.args?.filePath ?? input?.args?.path;
        if (!["write", "edit", "patch"].includes(input?.tool) || typeof file !== "string") return;
        if (file.length === 0) return;
        await run(["anchor", "touch", file], 1000, "post-edit");
      } catch {}
    },
  };
};
