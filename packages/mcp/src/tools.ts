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
  description: "workspace; M0: single, ignored",
} as const;

export const WORK_TOOLS: readonly McpToolDef[] = [
  {
    name: "myc_prime",
    description:
      "Project start packet: environment, working rules, ready queue state. " +
      "Call ONCE at session start and again right after context compaction — " +
      "replaces reading the README, plans and task history.",
    inputSchema: {
      type: "object",
      properties: {
        budget: { type: "integer", default: 2000, minimum: 200, maximum: 8000, description: "answer budget in chars" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_ready",
    description:
      "Tasks with no open blockers — what you can take right now. " +
      "With claim=true it atomically takes the top one (or the one in id) and returns " +
      "its description, deps and anchors at once — then just work, no extra calls.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "integer", default: 5, minimum: 1, maximum: 50 },
        claim: { type: "boolean", default: false, description: "atomically take a task and return its context" },
        id: { type: "string", description: "take a specific task (only with claim=true)" },
        kind: { type: "array", items: { type: "string", enum: ["task", "bug", "epic", "chore"] }, maxItems: 1 },
        priority: { type: "array", items: { type: "string", enum: ["P0", "P1", "P2", "P3"] }, maxItems: 1 },
        tag: { type: "array", items: { type: "string" }, maxItems: 1 },
        lease_minutes: { type: "integer", default: 30, minimum: 5, maximum: 480 },
        why: { type: "boolean", default: false, description: "explain the sort order" },
        // Разбор кандидатов хука сжатия (memory-79mq6fccg0jm) — не новым
        // инструментом, а режимом очереди: «что ждёт действия» и есть ready,
        // а действие — myc_update. Налог в tools/list — одна строка, не тул.
        review: { type: "boolean", default: false, description: "compaction candidates awaiting myc_update confirm/reject, not tasks" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_update",
    description:
      "Every task state change in one tool: claim, release, close, reopen, " +
      "assign, priority, note, extend; confirm/reject a compaction candidate. " +
      "close, reopen and reject require a reason — " +
      "it goes into project memory and later sessions see it.",
    inputSchema: {
      type: "object",
      required: ["id", "op"],
      properties: {
        id: { type: "string" },
        op: {
          type: "string",
          enum: ["claim", "release", "close", "reopen", "assign", "priority", "note", "extend", "confirm", "reject"],
          // Отмена (cancel) агенту намеренно не выдана: она решает, нужна ли
          // работа вообще, и терминальна — отменённый блокер выпускает зависимые
          // задачи в очередь. Сказано здесь, а не только в отказе, чтобы агент
          // знал это ДО попытки и не искал обход.
          description:
            "cancel is left out on purpose: cancelling is a human judgment, " +
            "say in your report that the work is not needed",
        },
        reason: { type: "string", description: "required for close, reopen, reject" },
        outcome: { type: "string", enum: ["done", "wontfix", "duplicate", "superseded"], default: "done" },
        duplicate_of: { type: "string", description: "canonical node for outcome=duplicate" },
        assignee: { type: "string" },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        note: { type: "string", description: "note text for op=note" },
        lease_minutes: { type: "integer", minimum: 5, maximum: 480 },
        steal: { type: "boolean", default: false, description: "take over an expired lease" },
        verify: { type: "string", enum: ["tests", "review", "human", "none"], default: "none" },
        cost: {
          type: "object",
          description: "filled in by the host: tokens_in, tokens_out, model, retries",
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
      "Search project memory in your own words: facts, decisions, tasks, episodes. " +
      "The answer is ranked and cut to the budget — read from the top and stop. " +
      "WARN/degraded in the answer = part of the index is down, quality is lower than usual.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2 },
        n: { type: "integer", default: 6, minimum: 1, maximum: 50 },
        budget: { type: "integer", default: 2000, minimum: 200, maximum: 8000 },
        kind: { type: "array", items: { type: "string" }, description: "task,bug,epic,memory,decision,document,skill,message" },
        layer: { type: "array", items: { type: "string", enum: ["L0", "L1", "L2", "L3"] }, description: "default L1-L3" },
        tag: { type: "array", items: { type: "string" } },
        since: { type: "string", description: "e.g. 7d, 3w, 12h" },
        anchor: { type: "string", description: "file path — narrow to nodes anchored there" },
        mode: { type: "string", enum: ["hybrid", "vec", "bm25"], default: "hybrid" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_remember",
    description:
      "Record a conclusion, decision or fact so later sessions know it. " +
      "One claim at a time, concrete, with its reason. " +
      "No raw code or secrets. A contradiction gets flagged, it does not overwrite the old one.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 8, maxLength: 8000 },
        tag: { type: "array", items: { type: "string" }, maxItems: 8 },
        anchor: { type: "array", items: { type: "string" }, maxItems: 1, description: "path or path:start-end" },
        layer: { type: "string", enum: ["L1", "L2", "L3"], default: "L1", description: "L1 fact, L2 decision, L3 constant (only with human consent)" },
        source: { type: "string", description: "url, file path, task id" },
        absorb: { type: "boolean", default: true, description: "false — write as is, without checking against what is known" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_show",
    description:
      "Full content of one or more nodes at once: body, deps, " +
      "links, code anchors. Pass the list of ids in one call, not one by one.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        depth: { type: "integer", enum: [0, 1], default: 0, description: "1 — titles of neighbours along edges" },
        source: { type: "boolean", default: false, description: "pull in code from fresh anchors" },
        fields: { type: "array", items: { type: "string" }, description: "limit fields — saves tokens" },
        ws: WS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_link",
    description:
      "Create or remove a link between nodes: blocks/blocked-by (dependency), " +
      "relates-to, duplicates, supersedes, contradicts, replies-to, derived-from, " +
      "part-of. supersedes and duplicates require a reason — history is not rewritten.",
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
        reason: { type: "string", description: "required for supersedes and duplicates" },
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
      "Find code by a question in your own words when you don't know the name: files by rank " +
      "and the symbols matched in them with path:line — read from the top. Search is lexical: " +
      "the closer your words are to the code, the better. Know the name — myc_code_symbol; " +
      "need ALL occurrences — myc_code_grep.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", default: 10, minimum: 1, description: "files" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_code_grep",
    description:
      "Every occurrence of a string in the repo's files, with its owner (function, class) — " +
      "exhaustive, unlike search. For editing a constant, SQL, a key, an error " +
      "text. Reads the disk, so it never lags behind the code; the occurrence count is full even when " +
      "groups are cut.",
    inputSchema: {
      type: "object",
      required: ["literal"],
      properties: {
        literal: { type: "string", minLength: 1 },
        ignore_case: { type: "boolean", default: false },
        lang: { type: "array", items: { type: "string" }, description: "ts, py, md…" },
        in: { type: "array", items: { type: "string" }, description: "dirs/files from the repo root" },
        limit: { type: "integer", default: 60, minimum: 1, description: "groups" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_code_symbol",
    description:
      "Where a symbol with this exact name is defined: path:span, kind, export, mention " +
      "count — and which tasks and memory facts are anchored to that span. " +
      "The cheapest answer when you know the name.",
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
      "Who calls a symbol (in) or what it calls (out): one edge per caller, " +
      "with the code lines inside. depth N or \"all\" — the blast radius of an edit: call it BEFORE " +
      "renaming or changing a signature. The graph is by name: WARN callers.ambiguous — " +
      "same-name symbols are merged.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        direction: { type: "string", enum: ["in", "out"], default: "in" },
        // Без type — как у graft_trace_calls: целое ИЛИ "all", а объединение
        // типов часть клиентов не переваривает.
        depth: { default: 1, description: "1, N or \"all\"" },
        kind: {
          type: "array",
          items: { type: "string", enum: [...CODE_REF_KINDS, "all"] },
          description: "default: all for in, call+new for out",
        },
        limit: { type: "integer", default: 40, minimum: 1, description: "groups" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_skeleton",
    description:
      "A file's API instead of reading it whole: declarations with signatures and spans, " +
      "nesting by indent, and how many times cheaper this is than the file. Then read " +
      "the span you need, not the file. WARN skeleton.stale — the file changed after indexing.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1, description: "from the repo root" },
        exported: { type: "boolean", default: false, description: "only what is visible outside" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "myc_code_map",
    description:
      "Map of an unfamiliar repo: directories by weight, their hub symbols and who " +
      "depends on whom by import. One call to get oriented, then " +
      "myc_code_search and myc_callers.",
    inputSchema: {
      type: "object",
      properties: {
        top: { type: "integer", default: 14, minimum: 1, description: "directories" },
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
    throw new Error(`profile '${profile}' is not implemented yet (myc-zdk); available: agent`);
  }
  return AGENT_TOOLS;
}
