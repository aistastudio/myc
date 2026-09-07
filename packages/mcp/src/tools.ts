/**
 * Профиль agent — ровно 7 инструментов (docs/design/03 §4.2).
 * Гранулярность по намерению, не по CRUD (D8): один вызов = одно намерение.
 * Описания сжаты под бюджет 1100 токенов (tokens.ts, проверяется тестом) —
 * каждое слово здесь оплачивается в каждой сессии агента.
 *
 * outputSchema намеренно не объявляется: structuredContent возвращается
 * всегда, а схема ответа стоила бы токены в каждом tools/list.
 */

export type McpProfile = "agent" | "leader" | "full";

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Инструменту нужна векторная ветка ретривала, то есть загруженный vec0
   * (решение S45/S46). Свойство объявлено ЗДЕСЬ, у инструмента, а не
   * зашито списком имён в сервере: список имён разошёлся бы с реальностью
   * ровно так же, как копия литерала модели и копия списка PRAGMA.
   */
  readonly needsVector?: boolean;
}

const WS = {
  type: "string",
  description: "воркспейс; M0: один, параметр игнорируется",
} as const;

export const AGENT_TOOLS: readonly McpToolDef[] = [
  {
    name: "myc_prime",
    description:
      "Стартовый пакет проекта: окружение, правила работы, состояние очереди. " +
      "Вызывай ОДИН раз в начале сессии и ещё раз сразу после сжатия контекста — " +
      "заменяет чтение README, планов и истории задач.",
    inputSchema: {
      type: "object",
      properties: {
        budget: { type: "integer", default: 2000, minimum: 200, maximum: 8000, description: "бюджет ответа в символах" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_ready",
    description:
      "Задачи без открытых блокеров — за что можно браться прямо сейчас. " +
      "С claim=true атомарно берёт верхнюю (или указанную в id) и сразу отдаёт " +
      "описание, зависимости и якоря — дальше работай, лишних вызовов не нужно.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "integer", default: 5, minimum: 1, maximum: 50 },
        claim: { type: "boolean", default: false, description: "атомарно взять задачу и вернуть её контекст" },
        id: { type: "string", description: "взять конкретную задачу (только с claim=true)" },
        kind: { type: "array", items: { type: "string", enum: ["task", "bug", "epic", "chore"] }, maxItems: 1 },
        priority: { type: "array", items: { type: "string", enum: ["P0", "P1", "P2", "P3"] }, maxItems: 1 },
        tag: { type: "array", items: { type: "string" }, maxItems: 1 },
        lease_minutes: { type: "integer", default: 30, minimum: 5, maximum: 480 },
        why: { type: "boolean", default: false, description: "объяснить порядок сортировки" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_update",
    description:
      "Все переходы состояния задачи одним тулом: claim, release, close, reopen, " +
      "assign, priority, note, extend. Для close и reopen обязателен reason — " +
      "он попадает в память проекта и виден следующим сессиям.",
    inputSchema: {
      type: "object",
      required: ["id", "op"],
      properties: {
        id: { type: "string" },
        op: {
          type: "string",
          enum: ["claim", "release", "close", "reopen", "assign", "priority", "note", "extend"],
          // Отмена (cancel) агенту намеренно не выдана: она решает, нужна ли
          // работа вообще, и терминальна — отменённый блокер выпускает зависимые
          // задачи в очередь. Сказано здесь, а не только в отказе, чтобы агент
          // знал это ДО попытки и не искал обход.
          description:
            "cancel в списке нет намеренно: отмена — человеческое суждение, " +
            "сообщите о ненужности работы в отчёте",
        },
        reason: { type: "string", description: "обязателен для close и reopen" },
        outcome: { type: "string", enum: ["done", "wontfix", "duplicate", "superseded"], default: "done" },
        duplicate_of: { type: "string", description: "каноничный узел при outcome=duplicate" },
        assignee: { type: "string" },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        note: { type: "string", description: "текст заметки для op=note" },
        lease_minutes: { type: "integer", minimum: 5, maximum: 480 },
        steal: { type: "boolean", default: false, description: "отобрать истёкшую аренду" },
        verify: { type: "string", enum: ["tests", "review", "human", "none"], default: "none" },
        cost: {
          type: "object",
          description: "заполняется хостом: tokens_in, tokens_out, model, retries",
          properties: {
            tokens_in: { type: "integer" },
            tokens_out: { type: "integer" },
            model: { type: "string" },
            retries: { type: "integer" },
          },
          additionalProperties: false,
        },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_recall",
    needsVector: true,
    description:
      "Поиск по памяти проекта своими словами: факты, решения, задачи, эпизоды. " +
      "Ответ отсортирован и урезан по бюджету — читай сверху и останавливайся. " +
      "WARN/degraded в ответе = часть индекса не работает, качество ниже обычного.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2 },
        n: { type: "integer", default: 6, minimum: 1, maximum: 50 },
        budget: { type: "integer", default: 2000, minimum: 200, maximum: 8000 },
        kind: { type: "array", items: { type: "string" }, description: "task,bug,epic,memory,decision,document,skill,message" },
        layer: { type: "array", items: { type: "string", enum: ["L0", "L1", "L2", "L3"] }, description: "по умолчанию L1-L3" },
        tag: { type: "array", items: { type: "string" } },
        since: { type: "string", description: "например 7d, 3w, 12h" },
        anchor: { type: "string", description: "путь к файлу — сузить до привязанных узлов" },
        mode: { type: "string", enum: ["hybrid", "vec", "bm25"], default: "hybrid" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_remember",
    description:
      "Записать вывод, решение или факт, чтобы следующие сессии его знали. " +
      "Одно утверждение за раз, конкретно, со своей причиной. " +
      "Не пиши сырой код и секреты. Противоречие будет помечено, а не затрёт старое.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 8, maxLength: 8000 },
        tag: { type: "array", items: { type: "string" }, maxItems: 8 },
        anchor: { type: "array", items: { type: "string" }, maxItems: 1, description: "путь или путь:начало-конец" },
        layer: { type: "string", enum: ["L1", "L2", "L3"], default: "L1", description: "L1 факт, L2 решение, L3 константа (только с согласия человека)" },
        source: { type: "string", description: "url, путь к файлу, id задачи" },
        absorb: { type: "boolean", default: true, description: "false — записать как есть, без сверки с известным" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_show",
    description:
      "Полное содержимое одного или нескольких узлов сразу: тело, зависимости, " +
      "связи, якоря в коде. Передавай список id одним вызовом, а не по одному.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        depth: { type: "integer", enum: [0, 1], default: 0, description: "1 — заголовки соседей по рёбрам" },
        source: { type: "boolean", default: false, description: "подтянуть код по свежим якорям" },
        fields: { type: "array", items: { type: "string" }, description: "ограничить поля — экономит токены" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_link",
    description:
      "Создать или удалить связь между узлами: blocks/blocked-by (зависимость), " +
      "relates-to, duplicates, supersedes, contradicts, replies-to, derived-from, " +
      "part-of. Для supersedes и duplicates обязателен reason — история не переписывается.",
    inputSchema: {
      type: "object",
      required: ["from", "type", "to"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        type: {
          type: "string",
          enum: ["blocks", "blocked-by", "relates-to", "duplicates", "supersedes", "contradicts", "replies-to", "derived-from", "part-of"],
        },
        reason: { type: "string", description: "обязателен для supersedes и duplicates" },
        remove: { type: "boolean", default: false },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
];

export function toolsForProfile(profile: McpProfile): readonly McpToolDef[] {
  // leader/full — отдельная задача (myc-zdk); сюда они попадут расширением
  // таблицы, а не параметризацией agent.
  if (profile !== "agent") {
    throw new Error(`профиль '${profile}' пока не реализован (myc-zdk); доступен agent`);
  }
  return AGENT_TOOLS;
}
