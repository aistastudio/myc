/**
 * Доменный уровень поверх graph.ts для шести видов узлов памяти: note, doc,
 * fragment, session, message, entity. Здесь нет SQL — только сборка
 * `NodeInput` с правильными attrs/generated-полями по §2.3 и детерминированный
 * разбор документа на типизированные фрагменты по §2.3, последняя строка.
 *
 * Как и graph.ts, модуль чистый: он не открывает БД и не знает про GraphStore
 * (core не может зависеть от пакета store-sqlite, scripts/deps-check.ts).
 * Вызывающая сторона берёт `NodeInput`/`NodeRecord` отсюда и сама решает,
 * каким `createNode`/`addEdge` их применить.
 *
 * Источники: docs/design/01-core-data-model.md §2.3 (per-kind поля),
 * §2.4 (статусы по kind), §4.1 (replies_to → thread_root, mentions).
 */

import { generateId } from "./id.ts";
import type { NodeInput } from "./graph.ts";
import type { JsonValue } from "./oplog.ts";

// ---------------------------------------------------------------------------
// note — память/факт (§2.3)
// ---------------------------------------------------------------------------

export type NoteSource = "user" | "agent" | "distill" | "import";

export interface NoteInput {
  readonly id?: string;
  readonly scope?: string;
  readonly title: string;
  readonly body?: string | null;
  readonly tags?: readonly string[];
  readonly source?: NoteSource;
  readonly topic?: string;
  readonly layer?: NodeInput["layer"];
}

/** Собирает `NodeInput` для note. `topic` попадает в generated-колонку g_topic. */
export function noteInput(input: NoteInput): NodeInput {
  const attrs: Record<string, JsonValue> = {};
  if (input.tags !== undefined) attrs.tags = [...input.tags];
  if (input.source !== undefined) attrs.source = input.source;
  if (input.topic !== undefined) attrs.topic = input.topic;
  return {
    id: input.id,
    kind: "note",
    scope: input.scope,
    layer: input.layer,
    title: input.title,
    body: input.body ?? null,
    attrs,
  };
}

// ---------------------------------------------------------------------------
// doc + fragment — документ разобран на типизированные куски (§2.3)
// ---------------------------------------------------------------------------

/**
 * `section` — часть документа, которая не распозналась ни под один из четырёх
 * содержательных типов; остальные четыре — идея memora (см. myc-divergences):
 * они защищают содержательные куски от случайного слияния друг с другом или
 * с обычной заметкой при дедупликации, потому что `content_hash` в §2.2
 * считается от `(kind, title, body)` — у фрагмента `kind='fragment'`, у
 * заметки `kind='note'`, и `ux_nodes_content(scope, kind, content_hash)`
 * их физически не может перепутать.
 */
export type FragmentType = "claim" | "plan_item" | "reference" | "risk" | "section";

export const FRAGMENT_TYPES: readonly FragmentType[] = [
  "claim",
  "plan_item",
  "reference",
  "risk",
  "section",
] as const;

export interface DocInput {
  readonly id?: string;
  readonly scope?: string;
  readonly title: string;
  readonly body: string;
  readonly uri?: string;
  readonly mime?: string;
  readonly layer?: NodeInput["layer"];
}

/** attrs.parsed_by — какой парсер породил фрагменты этого doc (§2.3). */
export const PARSED_BY = "core/memory.parseFragments@1";

export interface FragmentDraft {
  readonly frag_type: FragmentType;
  readonly ord: number;
  readonly char_start: number;
  readonly char_end: number;
  readonly title: string;
  readonly body: string;
}

interface HeaderMatch {
  readonly index: number;
  readonly headerEnd: number;
  readonly text: string;
}

const HEADER_RE = /^#{1,6}[ \t]+(.+?)[ \t]*$/gmu;
// Каждая строка-элемент списка ("- ", "* ", "1. ") внутри классифицированной
// секции становится собственным фрагментом — так claims/plan_items/risks
// остаются адресуемыми по отдельности, а не одним блоком текста.
const BULLET_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.+?)[ \t]*$/gmu;

const SECTION_TYPE_BY_KEYWORD: ReadonlyArray<readonly [RegExp, FragmentType]> = [
  [/claim|утвержд/iu, "claim"],
  [/plan|план|todo|задач/iu, "plan_item"],
  [/reference|источник|ссылк|citation/iu, "reference"],
  [/risk|риск/iu, "risk"],
];

function classifyHeader(text: string): FragmentType | null {
  for (const [re, type] of SECTION_TYPE_BY_KEYWORD) {
    if (re.test(text)) return type;
  }
  return null;
}

function findHeaders(body: string): HeaderMatch[] {
  const out: HeaderMatch[] = [];
  HEADER_RE.lastIndex = 0;
  for (const m of body.matchAll(HEADER_RE)) {
    out.push({
      index: m.index,
      headerEnd: m.index + m[0].length,
      text: m[1] ?? "",
    });
  }
  return out;
}

function trimSpan(
  body: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/u.test(body[s] ?? "")) s++;
  while (e > s && /\s/u.test(body[e - 1] ?? "")) e--;
  return { start: s, end: e };
}

function titleOf(text: string, max = 80): string {
  const [first = ""] = text.split(/\r?\n/u);
  const norm = first.replace(/\s+/gu, " ").trim();
  return norm.length <= max ? norm : `${norm.slice(0, max - 1)}…`;
}

/**
 * Разбирает body документа на типизированные фрагменты (§2.3, последняя
 * строка): claims, plan_items, references, risks — по заголовкам markdown,
 * плюс `section` для всего, что не распозналось. Внутри распознанной секции
 * каждый элемент списка — отдельный фрагмент; нераспознанная секция или текст
 * до первого заголовка — один фрагмент `section` целиком.
 *
 * Детерминированно и без обращения к сети/LLM — И1 запрещает и то, и другое
 * в горячем пути (см. myc-i1-speed): один проход regex по `body`.
 */
export function parseFragments(body: string): FragmentDraft[] {
  const headers = findHeaders(body);
  const drafts: FragmentDraft[] = [];
  let ord = 0;

  const pushSection = (start: number, end: number, headerText: string | null): void => {
    const span = trimSpan(body, start, end);
    if (span.end <= span.start) return;
    const sectionText = body.slice(span.start, span.end);
    const fragType = headerText === null ? null : classifyHeader(headerText);

    if (fragType !== null) {
      BULLET_RE.lastIndex = 0;
      const bullets = [...sectionText.matchAll(BULLET_RE)];
      if (bullets.length > 0) {
        for (const b of bullets) {
          const itemBody = b[1] ?? "";
          if (itemBody.trim().length === 0) continue;
          const groupStart = b.index + b[0].indexOf(itemBody);
          drafts.push({
            frag_type: fragType,
            ord: ord++,
            char_start: span.start + groupStart,
            char_end: span.start + groupStart + itemBody.length,
            title: titleOf(itemBody),
            body: itemBody,
          });
        }
        return;
      }
      drafts.push({
        frag_type: fragType,
        ord: ord++,
        char_start: span.start,
        char_end: span.end,
        title: headerText !== null ? titleOf(headerText) : titleOf(sectionText),
        body: sectionText,
      });
      return;
    }

    drafts.push({
      frag_type: "section",
      ord: ord++,
      char_start: span.start,
      char_end: span.end,
      title: headerText !== null ? titleOf(headerText) : titleOf(sectionText),
      body: sectionText,
    });
  };

  if (headers.length === 0) {
    pushSection(0, body.length, null);
    return drafts;
  }

  if (headers[0]!.index > 0) {
    pushSection(0, headers[0]!.index, null);
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const next = headers[i + 1];
    const end = next !== undefined ? next.index : body.length;
    pushSection(h.headerEnd, end, h.text);
  }
  return drafts;
}

/** `NodeInput` для doc; `n_fragments` заполняется после `parseFragments`. */
export function docInput(input: DocInput, fragmentCount: number): NodeInput {
  const attrs: Record<string, JsonValue> = {
    n_fragments: fragmentCount,
    parsed_by: PARSED_BY,
  };
  if (input.uri !== undefined) attrs.uri = input.uri;
  if (input.mime !== undefined) attrs.mime = input.mime;
  return {
    id: input.id,
    kind: "doc",
    scope: input.scope,
    layer: input.layer,
    title: input.title,
    body: input.body,
    attrs,
  };
}

/**
 * `NodeInput` для одного фрагмента. Ребро `parent` (fragment → doc) вызывающая
 * сторона ставит сама через `addEdge` — здесь только узел, без побочных
 * эффектов на граф (см. док-комментарий модуля).
 */
export function fragmentInput(
  doc: { readonly id: string; readonly scope?: string },
  draft: FragmentDraft,
): NodeInput {
  return {
    kind: "fragment",
    scope: doc.scope,
    title: draft.title,
    body: draft.body,
    attrs: {
      frag_type: draft.frag_type,
      ord: draft.ord,
      char_start: draft.char_start,
      char_end: draft.char_end,
    },
  };
}

// ---------------------------------------------------------------------------
// session / message — тред через replies_to, корень в attrs.thread_root (§2.3, §4.1)
// ---------------------------------------------------------------------------

export interface SessionInput {
  readonly id?: string;
  readonly scope?: string;
  readonly title?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly started_at?: number;
  readonly cwd?: string;
  readonly git_head?: string;
}

export function sessionInput(input: SessionInput): NodeInput {
  const attrs: Record<string, JsonValue> = {};
  if (input.agent !== undefined) attrs.agent = input.agent;
  if (input.model !== undefined) attrs.model = input.model;
  if (input.started_at !== undefined) attrs.started_at = input.started_at;
  if (input.cwd !== undefined) attrs.cwd = input.cwd;
  if (input.git_head !== undefined) attrs.git_head = input.git_head;
  return {
    id: input.id,
    kind: "session",
    scope: input.scope,
    title: input.title ?? "",
    attrs,
  };
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

/** Минимум, нужный от родительского сообщения, чтобы посчитать thread_root. */
export interface MessageThreadParent {
  readonly id: string;
  /** `attrs.thread_root` родителя; отсутствует ⇒ родитель сам корень треда. */
  readonly thread_root?: string;
}

export interface MessageInput {
  readonly id?: string;
  readonly scope?: string;
  readonly role: MessageRole;
  readonly ord: number;
  readonly body?: string | null;
  readonly title?: string;
  /** Ответ на другое сообщение — ставит слой сообщений (§4.1, "кто ставит"). */
  readonly replyTo?: MessageThreadParent;
  readonly tokens_in?: number;
  readonly tokens_out?: number;
}

export interface MessageDraft {
  readonly id: string;
  readonly input: NodeInput;
  /** Итоговый корень треда — тот же id, что и `attrs.thread_root` в input. */
  readonly threadRoot: string;
}

/**
 * Собирает `NodeInput` сообщения с уже посчитанным `attrs.thread_root`.
 * Id генерируется заранее (children forward-reference из §3.3): без этого
 * корневое сообщение не могло бы сослаться само на себя в attrs без второго
 * `updateNode`. `g_thread_root` — generated column, поэтому тред потом
 * читается одним индекс-сканом `ix_nodes_thread(g_thread_root, created_at)`,
 * а не рекурсивным обходом `replies_to`.
 */
export function messageInput(
  session: { readonly id: string; readonly scope?: string },
  input: MessageInput,
): MessageDraft {
  const id = input.id ?? generateId();
  const threadRoot = input.replyTo?.thread_root ?? input.replyTo?.id ?? id;
  const attrs: Record<string, JsonValue> = {
    session_id: session.id,
    role: input.role,
    ord: input.ord,
    thread_root: threadRoot,
  };
  if (input.tokens_in !== undefined) attrs.tokens_in = input.tokens_in;
  if (input.tokens_out !== undefined) attrs.tokens_out = input.tokens_out;
  return {
    id,
    threadRoot,
    input: {
      id,
      kind: "message",
      scope: input.scope ?? session.scope,
      title: input.title ?? "",
      body: input.body ?? null,
      attrs,
    },
  };
}

// ---------------------------------------------------------------------------
// entity — вход в граф по имени, связь через ребро mentions (§2.3, §4.1)
// ---------------------------------------------------------------------------

export type EntityType = "person" | "repo" | "service" | "model" | "file" | "lib" | "term";

export interface EntityInput {
  readonly id?: string;
  readonly scope?: string;
  readonly name: string;
  readonly etype: EntityType;
  readonly aliases?: readonly string[];
  readonly canonical?: string;
}

/**
 * Ключ для поиска entity по имени — вход в граф по имени (§4.1, `mentions`).
 * Нормализация детерминированная и совпадает по смыслу с `contentHash`:
 * схлопывает пробелы и регистр, чтобы "Bun", "bun", "  Bun " не завели три
 * разных узла-сущности при параллельном упоминании разными агентами.
 */
export function entityKey(name: string): string {
  return name.replace(/\s+/gu, " ").trim().toLowerCase();
}

/** `NodeInput` для entity; `g_etype` — generated column под `ix_nodes_etype`. */
export function entityInput(input: EntityInput): NodeInput {
  const attrs: Record<string, JsonValue> = { etype: input.etype };
  if (input.aliases !== undefined) attrs.aliases = [...input.aliases];
  if (input.canonical !== undefined) attrs.canonical = input.canonical;
  return {
    id: input.id,
    kind: "entity",
    scope: input.scope,
    title: input.name,
    attrs,
  };
}
