/**
 * Профиль agent — 13 инструментов: 7 работы с памятью и задачами
 * (WORK_TOOLS, docs/design/03 §4.2) и 6 кода (CODE_TOOLS, memory-5h06ty5sz38c).
 * Гранулярность по намерению, не по CRUD (D8): один вызов = одно намерение.
 * Описания сжаты под бюджет (tokens.ts, проверяется тестом) — каждое слово
 * здесь оплачивается в каждой сессии агента.
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

export const WORK_TOOLS: readonly McpToolDef[] = [
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

/**
 * Виды вхождений у `myc callers --kind`. Копия списка из commands/callers.ts
 * (REF_KINDS) — пакет mcp не импортирует команды CLI, — и поэлементное
 * совпадение копий проверяет code.parity.test.ts, а не этот комментарий.
 */
export const CODE_REF_KINDS = ["call", "new", "type", "import", "read", "prop"] as const;

/**
 * Инструменты кода: шесть вопросов, ради которых в .mcp.json стоял graft, —
 * где определён символ, кто зовёт и что зовёт, все вхождения литерала, поиск
 * по вопросу, API файла, карта репозитория (memory-5h06ty5sz38c).
 *
 * ИМЯ = КОМАНДА CLI: `myc code search` → myc_code_search, `myc callers` →
 * myc_callers. Инструмент не считает ничего сам — он и есть команда, с теми же
 * флагами и тем же текстом ответа; расхождение поверхностей в этом репозитории
 * ловили шесть раз, и седьмому здесь неоткуда взяться (code.parity.test.ts).
 *
 * Флаг `--repo` не выдан: сервер отвечает про репозиторий своего каталога,
 * как graft, стоящий в каждом репозитории своим процессом.
 *
 * Бюджет — CODE_DESCRIPTION_TOKEN_BUDGET (tokens.ts): не дороже того, что
 * агент платил за инструменты graft, которые эти заменяют.
 */
export const CODE_TOOLS: readonly McpToolDef[] = [
  {
    name: "myc_code_search",
    description:
      "Найти код по вопросу своими словами, когда имени не знаешь: файлы по рангу " +
      "и совпавшие в них символы с path:line — читай сверху. Поиск лексический: " +
      "чем ближе слова к коду, тем точнее. Имя известно — myc_code_symbol; " +
      "нужны ВСЕ вхождения — myc_code_grep.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", default: 10, minimum: 1, description: "файлов" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_code_grep",
    description:
      "Каждое вхождение строки в файлах репозитория с владельцем (функция, класс) — " +
      "исчерпывающе, в отличие от поиска. Для правки константы, SQL, ключа, текста " +
      "ошибки. Читает диск и от кода не отстаёт; число вхождений полное, даже если " +
      "группы урезаны.",
    inputSchema: {
      type: "object",
      required: ["literal"],
      properties: {
        literal: { type: "string", minLength: 1 },
        ignore_case: { type: "boolean", default: false },
        lang: { type: "array", items: { type: "string" }, description: "ts, py, md…" },
        in: { type: "array", items: { type: "string" }, description: "каталоги/файлы от корня репозитория" },
        limit: { type: "integer", default: 60, minimum: 1, description: "групп" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_code_symbol",
    description:
      "Где определён символ с точным именем: path:span, вид, экспорт, число " +
      "упоминаний — и какие задачи и факты памяти привязаны к этому участку. " +
      "Самый дешёвый ответ, когда имя известно.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_callers",
    description:
      "Кто зовёт символ (in) или что зовёт он сам (out): ребро на каждого зовущего, " +
      "внутри — строки кода. depth N или \"all\" — радиус правки: вызывай ДО " +
      "переименования и смены сигнатуры. Граф по именам: WARN callers.ambiguous — " +
      "одноимённые символы склеены.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        direction: { type: "string", enum: ["in", "out"], default: "in" },
        // Без type — как у graft_trace_calls: целое ИЛИ "all", а объединение
        // типов часть клиентов не переваривает.
        depth: { default: 1, description: "1, N или \"all\"" },
        kind: {
          type: "array",
          items: { type: "string", enum: [...CODE_REF_KINDS, "all"] },
          description: "умолч. все для in, call+new для out",
        },
        limit: { type: "integer", default: 40, minimum: 1, description: "групп" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_skeleton",
    description:
      "API файла вместо чтения целиком: объявления с сигнатурами и спанами, " +
      "вложенность сдвигом, и во сколько раз это дешевле файла. Дальше читай " +
      "нужный спан, а не файл. WARN skeleton.stale — файл изменился после индексации.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1, description: "от корня репозитория" },
        exported: { type: "boolean", default: false, description: "только видимое снаружи" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_code_map",
    description:
      "Карта незнакомого репозитория: каталоги по весу, их хаб-символы и кто от " +
      "кого зависит по import. Один вызов для ориентации, дальше — " +
      "myc_code_search и myc_callers.",
    inputSchema: {
      type: "object",
      properties: {
        top: { type: "integer", default: 14, minimum: 1, description: "каталогов" },
      },
      additionalProperties: false,
    },
  },
];

export const AGENT_TOOLS: readonly McpToolDef[] = [...WORK_TOOLS, ...CODE_TOOLS];

export function toolsForProfile(profile: McpProfile): readonly McpToolDef[] {
  // leader/full — отдельная задача (myc-zdk); сюда они попадут расширением
  // таблицы, а не параметризацией agent.
  if (profile !== "agent") {
    throw new Error(`профиль '${profile}' пока не реализован (myc-zdk); доступен agent`);
  }
  return AGENT_TOOLS;
}
