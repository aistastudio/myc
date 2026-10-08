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
 * Результат тулзы в строку. Форма 2.x: `state.content` — список блоков, как у
 * MCP; в `state.output` лежит строка у собранных 1.x-тулз, ошибки — в
 * `state.error`. Пустая строка — блока `tool_result` не бывает.
 */
const toolResultText = (state: any): string => {
  if (typeof state?.output === "string") return state.output;
  if (Array.isArray(state?.content)) {
    const parts = state.content
      .filter((p: any) => p != null && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text as string);
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof state?.error === "string") return state.error;
  if (state?.error != null && typeof state.error.message === "string") return state.error.message;
  return "";
};

/**
 * Стенограмма сессии в JSONL, который разбирает `myc absorb-session`.
 * Один узел сообщения — одна строка; блоки `text`/`tool_use`/`tool_result`
 * названы так же, как у Claude Code, потому что их и ждёт parseTranscript.
 *
 * Две формы opencode читаются здесь, и это не осторожность, а факт чтения
 * обоих бинарей: 1.18.31 отдаёт `client.session.messages` → `[{info, parts}]`,
 * 2.0.25 — `ctx.session.context` → ПЛОСКИЕ сообщения `{type, text|content}`,
 * где у tool-блока имя в `name`, а результат в `state.content`.
 */
const transcriptFrom = (list: any, sessionID: string): string => {
  const rows: any[] = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
  const lines: string[] = [];
  for (const m of rows) {
    const content: any[] = [];
    let role = "system";
    let model: string | undefined;
    if (m?.info !== undefined || Array.isArray(m?.parts)) {
      const info: any = m?.info ?? {};
      role = info.role ?? "system";
      model = info.modelID;
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
    } else {
      role = m?.type === "assistant" ? "assistant" : m?.type === "user" ? "user" : "system";
      model = m?.model?.id;
      if (typeof m?.text === "string" && m.text.length > 0) content.push({ type: "text", text: m.text });
      for (const item of m?.content ?? []) {
        if (item?.type === "text" && typeof item.text === "string" && item.text.length > 0) {
          content.push({ type: "text", text: item.text });
        } else if (item?.type === "tool") {
          const state: any = item.state ?? {};
          content.push({ type: "tool_use", name: item.name ?? item.tool ?? "tool", input: state.input ?? {} });
          const out = toolResultText(state);
          if (out.length > 0) content.push({ type: "tool_result", content: out });
        }
      }
    }
    if (content.length === 0) continue;
    lines.push(
      JSON.stringify({
        type: role,
        sessionId: sessionID,
        cwd: DIR,
        message: { role, model, content },
      }),
    );
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
};

/** Стенограмма 1.x: `client.session.messages` с `{path, query}` (замер: 4 мс). */
const transcript = async (client: any, sessionID: string): Promise<string> => {
  try {
    const res: any = await client.session.messages({
      path: { id: sessionID },
      query: { directory: DIR },
    });
    return transcriptFrom(res, sessionID);
  } catch {
    return "";
  }
};

/** Стенограмма 2.x: `ctx.session.context` — та же API-модель, что у клиента. */
const transcriptV2 = async (ctx: any, sessionID: string): Promise<string> => {
  try {
    const res: any = await ctx.session.context({ sessionID });
    return transcriptFrom(res, sessionID);
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
const absorb = async (jsonl: string, sessionID: string): Promise<string> =>
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
    jsonl,
  );

/** Сжатия, уже записанные основным хуком: страховка их не переписывает. */
const handled = new Map<string, number>();
const HANDLED_MS = 60000;
/** Текст prime на сессию: считается один раз, кладётся в каждый запрос. */
const primed = new Map<string, string>();
/**
 * Признак служебного запроса opencode. Отличить его больше нечем: на вход
 * хука приходит только {sessionID, model}. Проверено на настоящем запуске
 * opencode: у генератора заголовка первый системный промпт начинается с
 * "You are a title generator" (memory-synef5yh4xf2).
 */
const SERVICE_PROMPT = /^s*you are a (title|summary)/i;

const __mycServer = async ({ client, directory }: { client: any; directory?: string }) => {
  if (typeof directory === "string" && directory.length > 0) DIR = directory;
  return {
    // Единственная дверь в контекст при сжатии (см. шапку шаблона).
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[] },
    ): Promise<void> => {
      if (!true) return;
      try {
        const packet = await absorb(await transcript(client, input.sessionID), input.sessionID);
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
          await absorb(await transcript(client, id), id);
        }
      } catch {}
    },
    /**
     * prime вместо несуществующего session.start. Системный промпт — тот
     * единственный канал, который у плагина есть.
     *
     * КЛАДЁТСЯ В КАЖДЫЙ ЗАПРОС, А НЕ ОДИН РАЗ НА СЕССИЮ (memory-synef5yh4xf2,
     * замерено на настоящем запуске opencode 1.18.31 с записью тел запросов).
     * opencode зовёт этот хук на КАЖДЫЙ запрос к модели и собирает системный
     * промпт заново — в историю он не пишется. А первым запросом новой
     * сессии идёт ГЕНЕРАТОР ЗАГОЛОВКА, с тем же sessionID: «один раз на
     * сессию» уезжал именно туда, и оба шага основного агента приходили без
     * prime. В TUI агент не видел его практически никогда.
     *
     * Текст считается один раз и кешируется на сессию (запускать myc prime
     * на каждый запрос к модели нельзя), а кладётся всегда.
     */
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      if (!true) return;
      try {
        const id = input?.sessionID;
        if (typeof id !== "string" || id.length === 0) return;
        // Служебный вызов (генератор заголовка, сводка) — не агент: контекст
        // ему не нужен, а прежняя логика уезжала ровно сюда.
        if (SERVICE_PROMPT.test(output?.system?.[0] ?? "")) return;
        let text = primed.get(id);
        if (text === undefined) {
          text = await run(["prime", "--budget", "2000", "--format", "agent", "--session", id], 2500, "session-start");
          primed.set(id, text);
        }
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

/**
 * opencode 2.x. ctx здесь — клиент (ctx.session/ctx.tool/ctx.event), хуки
 * регистрируются, а не возвращаются. На 1.x сюда приходит его собственный
 * контекст без session.hook: выход без единой регистрации.
 */
const __mycSetup = async (ctx: any): Promise<(() => void) | void> => {
  try {
    if (typeof ctx?.session?.hook !== "function") return;
    const where = ctx?.location?.directory;
    if (typeof where === "string" && where.length > 0) DIR = where;
    // prime: opencode 2.x пересобирает систему на КАЖДЫЙ запрос, поэтому
    // кладём каждый раз, а текст кешируем на сессию — как в 1.x.
    await ctx.session.hook("context", async (event: any) => {
      try {
        const id = event?.sessionID;
        if (typeof id !== "string" || id.length === 0) return;
        const head = typeof event?.system?.[0] === "string" ? event.system[0] : (event?.system?.[0]?.text ?? "");
        if (SERVICE_PROMPT.test(head)) return;
        let text = primed.get(id);
        if (text === undefined) {
          text = await run(["prime", "--budget", "2000", "--format", "agent", "--session", id], 2500, "session-start");
          primed.set(id, text);
        }
        if (text.trim().length > 0 && Array.isArray(event.system)) event.system.push({ type: "text", text });
      } catch {}
    });
    // Единственная дверь в контекст при сжатии: opencode приклеивает
    // систему этого запроса к промпту суммаризации.
    await ctx.session.hook("compaction", async (event: any) => {
      try {
        const id = event?.sessionID;
        if (typeof id !== "string" || id.length === 0) return;
        const packet = await absorb(await transcriptV2(ctx, id), id);
        handled.set(id, Date.now());
        if (packet.trim().length > 0 && Array.isArray(event.system)) event.system.push({ type: "text", text: packet });
      } catch {}
    });
    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (typeof event?.status === "string" && event.status !== "completed") return;
        const file = event?.input?.filePath ?? event?.input?.path;
        if (!["write", "edit", "patch"].includes(event?.tool) || typeof file !== "string") return;
        if (file.length === 0) return;
        await run(["anchor", "touch", file], 1000, "post-edit");
      } catch {}
    });
    // Страховка тем же способом, что в 1.x: событие стабильное, стенограмма
    // после сжатия ещё целиком. Поток живёт до выгрузки плагина, чистка — в
    // cleanup, который opencode зовёт при выгрузке.
    const ctrl = new AbortController();
    const stream = ctx?.event?.subscribe?.({ signal: ctrl.signal });
    if (stream != null && typeof stream[Symbol.asyncIterator] === "function") {
      void (async () => {
        for await (const ev of stream as AsyncIterable<any>) {
          try {
            if (ev?.type !== "session.compacted") continue;
            const id = ev?.data?.sessionID ?? ev?.properties?.sessionID;
            if (typeof id !== "string" || id.length === 0) continue;
            const at = handled.get(id);
            if (at !== undefined && Date.now() - at < HANDLED_MS) continue;
            await absorb(await transcriptV2(ctx, id), id);
          } catch {}
        }
      })().catch(() => {});
    }
    return () => {
      try {
        ctrl.abort();
      } catch {}
    };
  } catch {}
};
export default { id: "myc", setup: __mycSetup, server: __mycServer };
export const MycPlugin = __mycServer;
