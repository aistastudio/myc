/**
 * Тесты клиента просмотрщика.
 *
 * Проверяется не исходник, а ровно тот JavaScript, который сервер отдаёт
 * браузеру (`getAsset("/app.js")`): регрессия могла бы спрятаться в
 * транспиляции, и тогда тест на исходник её не увидит.
 *
 * Клиент самодостаточен и не экспортирует ничего — значит, и проверять его
 * надо снаружи, как проверяет браузер: подставляем минимальный DOM, грузим
 * модуль, дёргаем адресную строку и смотрим, какой экран открыт. Каждый
 * сценарий получает свежий экземпляр модуля: `import` в Bun кешируется по
 * пути, поэтому каждый прогон пишется во временный файл со своим именем.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsset } from "./assets.ts";
import type { CardView } from "./types.ts";

// ---------------------------------------------------------------------------
// Минимальный DOM
// ---------------------------------------------------------------------------

/** Заглушка «что угодно»: вызывается, индексируется, приводится к нулю. */
const anything: any = new Proxy(function noop() {} as any, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : anything),
  set: () => true,
  apply: () => anything,
});

interface StubEl {
  readonly id: string;
  readonly tagName: string;
  hidden: boolean;
  textContent: string;
  title: string;
  className: string;
  value: string;
  readonly dataset: Record<string, string>;
  readonly attrs: Map<string, string>;
  readonly listeners: Map<string, Array<(e: any) => void>>;
  fire(type: string, event?: unknown): void;
}

function makeEl(id: string, tag = "div"): StubEl {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<(e: any) => void>>();
  const dataset: Record<string, string> = {};
  const base: Record<string, unknown> = {
    id,
    tagName: tag.toUpperCase(),
    hidden: false,
    textContent: "",
    title: "",
    className: "",
    value: "",
    checked: false,
    width: 0,
    height: 0,
    dataset,
    attrs,
    listeners,
    style: {},
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => undefined,
      contains: () => false,
    },
    append: () => undefined,
    replaceChildren: () => undefined,
    appendChild: () => undefined,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    removeAttribute: (k: string) => void attrs.delete(k),
    hasAttribute: (k: string) => attrs.has(k),
    addEventListener: (type: string, fn: (e: any) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener: () => undefined,
    getContext: () => anything,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    fire: (type: string, event: unknown = {}) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : anything),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
    // `delete chip.dataset["trust"]` идёт мимо этого прокси, а `in` нужен
    // самому прокси, чтобы не проваливать известные поля в `anything`.
    has: (target, key) => key in target,
  }) as unknown as StubEl;
}

interface Dom {
  readonly els: Map<string, StubEl>;
  readonly tabs: StubEl[];
  el(id: string): StubEl;
  /** Какой экран сейчас показан: единственная панель без `hidden`. */
  visibleTab(): string | undefined;
  /** Какая вкладка подсвечена в шапке. */
  selectedTab(): string | undefined;
  hash: string;
  /** Смена адреса «снаружи»: адресная строка, «назад», «вперёд». */
  goto(hash: string): void;
  historyWrites: string[];
  frames: Array<() => void>;
  flushFrames(): void;
  workers: StubWorker[];
  visibility: "visible" | "hidden";
  hide(): void;
  fetches: string[];
  /** Тела POST-запросов записи — доска и опбар шлют их через mutate(). */
  posts: Array<{ path: string; body: unknown }>;
  /** Что было на экране в момент запроса к серверу. */
  tabAtBoot: string | undefined;
  graphNodes: number;
  boardReleased: readonly { id: string; title: string; kind: string; status: string; priority: number; type: string }[];
  /**
   * Все элементы, созданные клиентом через `document.createElement` — не
   * только те, что подставной DOM выдаёт по id. Карточка узла и панель правки
   * строят кнопки и поля БЕЗ id (`el("button", ...)`), и `append()` в этой
   * заглушке не строит настоящее дерево — до них нельзя дотянуться через
   * `dom.el(id)`. `findCreated` ищет среди них напрямую по предикату
   * (обычно — по `textContent` кнопки или `attrs.get("placeholder")` поля).
   */
  created: StubEl[];
  findCreated(pred: (el: StubEl) => boolean): StubEl | undefined;
  /** Фикстуры карточки узла (`GET /api/nodes/:id/card`) — по умолчанию генерируются, тест может подменить. */
  cards: Map<string, CardView>;
  /** Ответ на `GET /api/routing` — тест подменяет, когда нужен другой случай (available:false, no_cost_data, …). */
  routingPayload: unknown;
  /** Ответ на `GET /api/decisions` (W8) — тест подменяет ради цепочек/противоречий. */
  decisionsPayload: unknown;
  /** `data` конверта `GET /api/bootstrap` — тест подменяет ради обрезки/подстановки. */
  bootstrapPreview: unknown;
  /** `data.rows` конверта `GET /api/bootstrap/blocks`. */
  bootstrapBlocks: unknown[];
  /** `data` конверта `GET /api/search` — тест подменяет ради строк выдачи. */
  searchPayload: unknown;
  /** `warn[]` конверта `GET /api/search` — деградация, которую обязан показать экран (И2). */
  searchWarn: { code: string; msg: string }[];
  /** Ответ на `GET /api/kb` — тест подменяет ради строк базы знаний (кандидаты хука сжатия). */
  kbPayload: unknown;
  /**
   * Одноразовая подмена ответа на следующий `POST /api/nodes/:id` — тело
   * записывается в `posts` как обычно, но в ответ уходит это вместо
   * `{ok:true}`. Нужна, чтобы проверить отказ сервера (например
   * `precond.cycle`) текстом, а не выдумывать реакцию клиента.
   */
  nextWriteReply: { status?: number; body: unknown } | null;
}

/** Карточка узла по умолчанию — минимальный валидный CardView, тест переопределяет то, что ему нужно. */
function defaultCardView(id: string, over: Partial<CardView> = {}): CardView {
  return {
    id,
    kind: "task",
    type: "task",
    title: `узел ${id}`,
    body: "",
    status: "open",
    priority: 1,
    assignee: "",
    acl: "team",
    tags: [],
    estimate_min: null,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    open_blockers: 0,
    lease: null,
    layer: 1,
    reach: "project",
    session: "",
    repo: "",
    repo_state: "root",
    parent: null,
    children: [],
    progress: null,
    blocked_by: [],
    blocks: [],
    links: [],
    comments: [],
    ...over,
  };
}

class StubWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  postMessage(msg: unknown): void {
    this.sent.push(msg);
  }
  terminate(): void {
    /* нечего останавливать */
  }
  /** Кадр из воркера так, как его получает главный поток. */
  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: frame });
  }
}

const TAB_NAMES = ["graph", "ready", "kb", "timeline", "health", "board", "search", "routing", "decisions", "bootstrap"] as const;

/** Строка выдачи `/api/search` по умолчанию: одна с z-оценкой уверенности, одна без вектора. */
function defaultSearchPayload(): unknown {
  return {
    query: "бюджет prime",
    rows: [
      {
        id: "memory-conf",
        rank: 1,
        score: 0.0217,
        confidence: 1.83,
        kind: "note",
        type: "note",
        layer: 1,
        updated_at: 1,
        title: "бюджет prime считается посимвольно",
        excerpt: "правило запуска про бюджет prime",
        reach: "project",
        reach_session: "",
        repo: "",
        repo_state: "root",
        tier: "project",
        source: "project",
      },
      {
        id: "memory-noconf",
        rank: 2,
        score: 0.019,
        kind: "note",
        type: "note",
        layer: 1,
        updated_at: 1,
        title: "второй хит без векторного сигнала",
        excerpt: "чисто лексическое совпадение",
        reach: "project",
        reach_session: "",
        repo: "",
        repo_state: "root",
        tier: "project",
        source: "project",
      },
    ],
    shown: 2,
    total: 2,
    mode: "bm25 only",
    budget: 2000,
    used_chars: 300,
    took_ms: 3,
    partial: false,
    omitted: 0,
    pool_exhausted: false,
    deduped: 0,
    foreign: 0,
    unknown_reach: 0,
    unknown_repo: 0,
    repo: "",
  };
}

/** Payload по умолчанию для /api/routing — переопределяется по месту, где нужен другой ответ. */
function defaultRoutingPayload(): unknown {
  return {
    available: true,
    classes: [
      {
        taskClass: "fix:module",
        arms: [
          {
            arm: "cheap/high",
            modelId: "cheap/high",
            effort: "high",
            harness: "claude",
            attempts: 6,
            qualityMean: 0.9,
            quality: { lo: 0.55, hi: 0.98 },
            costUsdMean: 0.02,
            costedAttempts: 6,
            costCoverage: 1,
            cleanRate: 0.8,
            enoughData: true,
            isCheapest: true,
            isEqualGroup: true,
          },
          {
            arm: "pricey/high",
            modelId: "pricey/high",
            effort: "high",
            harness: "claude",
            attempts: 6,
            qualityMean: 0.92,
            quality: { lo: 0.57, hi: 0.99 },
            costUsdMean: 0,
            costedAttempts: 6,
            costCoverage: 1,
            cleanRate: 0.9,
            enoughData: true,
            isCheapest: false,
            isEqualGroup: true,
          },
        ],
        qualityLeader: "pricey/high",
        cheapest: "cheap/high",
        separationPending: false,
        answer: "ok",
        why: "2 рук неотличимы по результату, из них дешевле cheap/high",
      },
      {
        taskClass: "feature:cross",
        arms: [
          {
            arm: "opus/high",
            modelId: "opus/high",
            effort: "high",
            harness: "claude",
            attempts: 4,
            qualityMean: 0.91,
            quality: { lo: 0.47, hi: 0.97 },
            costUsdMean: null,
            costedAttempts: 0,
            costCoverage: 0,
            cleanRate: 0.75,
            enoughData: true,
            isCheapest: false,
            isEqualGroup: true,
          },
        ],
        qualityLeader: "opus/high",
        cheapest: null,
        separationPending: false,
        answer: "single_arm",
        why: "наблюдения есть только у opus/high; сравнивать не с чем",
      },
    ],
    coverage: {
      attempts: 16,
      finished: 10,
      withCost: 6,
      arms: 3,
      classes: 2,
      tasksClosed: 103,
      tasksAttributed: 14,
    },
    outcomeVersion: 1,
    minAttempts: 3,
    credibleMass: 0.9,
    degraded: [
      {
        code: "routing.single_arm.feature:cross",
        msg: "feature:cross: сравнивать не с чем — наблюдения есть только у opus/high; сравнивать не с чем",
      },
    ],
    took_ms: 2,
  };
}

/** Payload по умолчанию для /api/decisions (W8): одна цепочка, одно открытое противоречие. */
function defaultDecisionsPayload(): unknown {
  return {
    chains: [
      {
        head: "dec-new",
        links: [
          {
            id: "dec-old",
            title: "Бюджет prime — 1500 символов",
            status: "superseded",
            author: "egor",
            created_at: 1000,
            current: false,
            reason: "старое решение мерило не то дерево",
          },
          {
            id: "dec-new",
            title: "Бюджет prime — 2000 символов",
            status: "active",
            author: "egor",
            created_at: 2000,
            current: true,
          },
        ],
      },
    ],
    contradictions: [
      {
        a: { id: "dec-x", title: "Порог 0.845", status: "active", author: "egor", created_at: 1000 },
        b: { id: "dec-y", title: "Порог 0.9", status: "active", author: "claude", created_at: 2000 },
        reason: "числа разошлись без маркера обновления",
      },
    ],
    total_decisions: 3,
    degraded: [],
    took_ms: 2,
  };
}

/** `data` конверта `GET /api/bootstrap` — та же форма, что `renderBootstrap` (packages/cli). */
function defaultBootstrapPreview(): unknown {
  return {
    text: "# MYC BOOTSTRAP v1 · ws=t · auto 1 · manual 0 · fp deadbeef\n[auto:myc] стенд\n# 40 body chars / 2000 budget · 1 мс · cache off\n",
    chars: 90,
    body_chars: 40,
    budget: 2000,
    truncated: false,
    dropped: [],
    clipped: [],
    fp: "deadbeef",
    cache: "off",
    auto: 1,
    manual: 0,
    tiers: ["project"],
    blocks: [{ key: "myc", source: "auto", tier: "project", chars: 40 }],
    took_ms: 1,
  };
}

let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

function saveGlobals(): void {
  if (savedGlobals.length > 0) return;
  savedGlobals = STUBBED.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
}

function restoreGlobals(): void {
  for (const [key, descriptor] of savedGlobals.splice(0)) {
    if (descriptor === undefined) delete (globalThis as any)[key];
    else Object.defineProperty(globalThis, key, descriptor);
  }
}

function installDom(hash: string, graphNodes = 0, opts: { readOnly?: boolean } = {}): Dom {
  const readOnly = opts.readOnly ?? true;
  const els = new Map<string, StubEl>();
  const created: StubEl[] = [];
  const tabs = TAB_NAMES.map((name) => {
    const btn = makeEl(`tab-${name}`, "button");
    btn.dataset["tab"] = name;
    return btn;
  });

  const dom: Dom = {
    els,
    tabs,
    el(id) {
      let found = els.get(id);
      if (found === undefined) {
        found = makeEl(id);
        els.set(id, found);
      }
      return found;
    },
    visibleTab() {
      return TAB_NAMES.find((name) => els.get(`panel-${name}`)?.hidden === false);
    },
    selectedTab() {
      return tabs.find((b) => b.attrs.get("aria-selected") === "true")?.dataset["tab"];
    },
    hash,
    goto(next) {
      dom.hash = next;
      for (const fn of windowListeners.get("hashchange") ?? []) fn({});
    },
    historyWrites: [],
    frames: [],
    flushFrames() {
      const queue = dom.frames.splice(0);
      for (const fn of queue) fn();
    },
    workers: [],
    visibility: "visible",
    hide() {
      dom.visibility = "hidden";
      for (const fn of docListeners.get("visibilitychange") ?? []) fn({});
    },
    fetches: [],
    posts: [],
    tabAtBoot: undefined,
    graphNodes,
    boardReleased: [],
    created,
    findCreated(pred) {
      return created.find(pred);
    },
    cards: new Map(),
    nextWriteReply: null,
    routingPayload: defaultRoutingPayload(),
    decisionsPayload: defaultDecisionsPayload(),
    bootstrapPreview: defaultBootstrapPreview(),
    bootstrapBlocks: [],
    searchPayload: defaultSearchPayload(),
    searchWarn: [],
    kbPayload: {
      rows: [],
      total: 0,
      shown: 0,
      counts: {
        by_kind: [],
        by_layer: [],
        reach: { project: 0, session: 0, unknown: 0 },
        repo: { root: 0, unknown: 0, by_repo: [] },
      },
      took_ms: 1,
    },
  };

  const docListeners = new Map<string, Array<(e: any) => void>>();
  const windowListeners = new Map<string, Array<(e: any) => void>>();
  const g = globalThis as any;
  // `fetch` и `Worker` в Bun настоящие: подменив их и не вернув, мы сломали бы
  // серверные тесты в соседнем файле — они делят с нами процесс.
  saveGlobals();

  g.document = {
    get visibilityState() {
      return dom.visibility;
    },
    documentElement: makeEl("html"),
    getElementById: (id: string) => dom.el(id),
    querySelectorAll: (sel: string) => (sel === ".tab" ? tabs : []),
    createElement: (tag: string) => {
      const node = makeEl("", tag);
      created.push(node);
      return node;
    },
    createTextNode: (text: string) => ({ textContent: text }),
    addEventListener: (type: string, fn: (e: any) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
  };
  g.window = {
    addEventListener: (type: string, fn: (e: any) => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    matchMedia: () => ({ addEventListener: () => undefined, matches: false }),
    setTimeout: () => 0,
    devicePixelRatio: 1,
  };
  g.location = {
    get hash() {
      return dom.hash;
    },
    set hash(next: string) {
      const normalized = next.startsWith("#") ? next : `#${next}`;
      if (normalized === dom.hash) return;
      dom.goto(normalized);
    },
  };
  g.history = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      dom.historyWrites.push(url);
      dom.hash = url.startsWith("#") ? url : `#${url}`;
    },
    pushState: () => undefined,
  };
  g.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  };
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.requestAnimationFrame = (fn: () => void): number => dom.frames.push(fn);
  g.cancelAnimationFrame = () => undefined;
  g.Path2D = class {
    constructor() {
      return anything;
    }
  };
  g.Worker = class extends StubWorker {
    constructor() {
      super();
      dom.workers.push(this);
    }
  };
  g.fetch = async (path: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    dom.fetches.push(path);
    if (path === "/api/boot") dom.tabAtBoot = dom.visibleTab();
    if (init?.method === "POST") {
      dom.posts.push({ path, body: init.body !== undefined ? JSON.parse(init.body) : undefined });
      if (dom.nextWriteReply !== null) {
        const reply = dom.nextWriteReply;
        dom.nextWriteReply = null;
        return { ok: true, status: reply.status ?? 200, json: async () => reply.body };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    }
    const cardMatch = /^\/api\/nodes\/([^/]+)\/card$/.exec(path);
    if (cardMatch !== null) {
      const id = decodeURIComponent(cardMatch[1]!);
      const view = dom.cards.get(id) ?? defaultCardView(id);
      return { ok: true, status: 200, json: async () => view };
    }
    const releaseMatch = /^\/api\/nodes\/[^/]+\/release-preview$/.exec(path);
    if (releaseMatch !== null) {
      return { ok: true, status: 200, json: async () => ({ released: dom.boardReleased }) };
    }
    if (path === "/api/board") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          columns: {
            open: [{ id: "t-open", title: "открытая", priority: 1, type: "task", assignee: "", updated_at: 1 }],
            blocked: [{ id: "t-blocked", title: "блокирована", priority: 1, type: "task", assignee: "", updated_at: 1 }],
            in_progress: [{ id: "t-wip", title: "в работе", priority: 1, type: "task", assignee: "agent", updated_at: 1 }],
            closed: [],
            cancelled: [],
          },
          took_ms: 1,
        }),
      };
    }
    if (path === "/api/routing") {
      return { ok: true, status: 200, json: async () => dom.routingPayload };
    }
    if (path === "/api/decisions") {
      return { ok: true, status: 200, json: async () => dom.decisionsPayload };
    }
    if (path.startsWith("/api/search")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: dom.searchPayload, meta: { degraded: [] }, warn: dom.searchWarn }),
      };
    }
    if (path === "/api/bootstrap" || path.startsWith("/api/bootstrap?")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: dom.bootstrapPreview }) };
    }
    if (path === "/api/bootstrap/blocks") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { rows: dom.bootstrapBlocks } }),
      };
    }
    if (/^\/api\/bootstrap\/blocks\/[^/]+\/history$/.exec(path) !== null) {
      return { ok: true, status: 200, json: async () => ({ rows: [] }) };
    }
    const body =
      path === "/api/boot"
        ? { slug: "t", nodes: dom.graphNodes, edges: 0, read_only: readOnly, schema_ready: true }
        : path === "/api/graph"
          ? {
              nodes: Array.from({ length: dom.graphNodes }, (_, i) => ({
                id: `n${i}`,
                kind: "task",
                title: `узел ${i}`,
                deg: 1,
              })),
              edges: [],
              total_nodes: dom.graphNodes,
              total_edges: 0,
              took_ms: 1,
              truncated: false,
            }
        : path === "/api/ready"
          ? { rows: [], blocked: 0, weights: {}, took_ms: 1 }
          : path === "/api/kb" || path.startsWith("/api/kb?")
            ? dom.kbPayload
            : path === "/api/oplog"
              ? { rows: [], total: 0, took_ms: 1 }
              : { nodes: 0, edges: 0, degraded: [], took_ms: 1 };
    return { ok: true, status: 200, json: async () => body };
  };
  return dom;
}

const tempDirs: string[] = [];
let moduleSeq = 0;

/** Глобальные имена, которые подменяет заглушка DOM. */
const STUBBED = [
  "document",
  "window",
  "location",
  "history",
  "localStorage",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "Path2D",
  "Worker",
  "fetch",
] as const;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreGlobals();
});

/** Пауза на несколько микро- и макрозадач: `main()` асинхронен. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Загружает клиент так, как это делает браузер: тот же JavaScript, что уходит
 * по `/app.js`, в свежем экземпляре модуля.
 */
async function boot(hash: string, graphNodes = 0, opts: { readOnly?: boolean } = {}): Promise<Dom> {
  const dom = installDom(hash, graphNodes, opts);
  const dir = mkdtempSync(join(tmpdir(), "myc-viz-"));
  tempDirs.push(dir);
  const file = join(dir, `app-${moduleSeq++}.mjs`);
  writeFileSync(file, getAsset("/app.js")!.body);
  await import(file);
  await settle();
  return dom;
}

// ---------------------------------------------------------------------------

describe("маршрут по хешу", () => {
  for (const tab of TAB_NAMES) {
    test(`/#${tab} открывает свой экран с первой отрисовки`, async () => {
      const dom = await boot(`#${tab}`);
      expect(dom.visibleTab()).toBe(tab);
      expect(dom.selectedTab()).toBe(tab);
      // Экран выбран до первого запроса к серверу, а не после ответа:
      // иначе человек успевает увидеть чужую панель и её подмену.
      expect(dom.tabAtBoot).toBe(tab);
      expect(dom.hash).toBe(`#${tab}`);
    });
  }

  test("хеша нет — экран по умолчанию, и адрес чинится без записи в историю", async () => {
    const dom = await boot("");
    expect(dom.visibleTab()).toBe("graph");
    // replaceState, а не присваивание hash: лишняя запись сделала бы первое
    // «назад» пустым переходом на ту же страницу.
    expect(dom.historyWrites).toEqual(["#graph"]);
    expect(dom.hash).toBe("#graph");
  });

  test("чужой якорь в адресе не оставляет страницу пустой", async () => {
    const dom = await boot("#нет-такого-экрана");
    expect(dom.visibleTab()).toBe("graph");
    // Адрес чинится под показанный экран: расхождение адреса и экрана — это и
    // есть тот дефект, из-за которого ссылку нельзя было передать другому.
    expect(dom.hash).toBe("#graph");
    expect(dom.historyWrites).toEqual(["#graph"]);
  });

  test("назад и вперёд переключают экраны", async () => {
    const dom = await boot("#graph");
    expect(dom.visibleTab()).toBe("graph");

    // «Вперёд» по истории = хеш сменился снаружи.
    dom.goto("#health");
    await settle();
    expect(dom.visibleTab()).toBe("health");
    expect(dom.selectedTab()).toBe("health");

    dom.goto("#timeline");
    await settle();
    expect(dom.visibleTab()).toBe("timeline");

    // «Назад».
    dom.goto("#health");
    await settle();
    expect(dom.visibleTab()).toBe("health");

    dom.goto("#graph");
    await settle();
    expect(dom.visibleTab()).toBe("graph");
    expect(dom.selectedTab()).toBe("graph");
  });

  test("клик по вкладке переписывает адрес, и экран идёт за ним", async () => {
    const dom = await boot("#graph");
    // tabs[4] — «Здоровье» (graph, ready, kb, timeline, health)
    dom.el("tabs").fire("click", { target: { closest: () => dom.tabs[4] } });
    await settle();
    expect(dom.hash).toBe("#health");
    expect(dom.visibleTab()).toBe("health");
  });

  test("экран и адрес не расходятся после серии переходов", async () => {
    const dom = await boot("#ready");
    for (const tab of ["health", "graph", "timeline", "ready", "health"] as const) {
      dom.goto(`#${tab}`);
      await settle(2);
      expect(dom.visibleTab()).toBe(tab);
      expect(dom.hash).toBe(`#${tab}`);
    }
  });
});

// ---------------------------------------------------------------------------

const UNTRUSTED = "времена недостоверны: вкладка была в фоне";

describe("честность замера первого кадра", () => {
  test("активная вкладка — число как было, без оговорок", async () => {
    const dom = await boot("#graph", 14);
    const worker = dom.workers[0]!;
    expect(worker).toBeDefined();

    worker.emit({ type: "seed", generation: 1, positions: new Float32Array(28), ms: 1 });
    dom.flushFrames();
    dom.flushFrames();

    const chip = dom.el("graph-layout");
    expect(chip.textContent).toContain("первый кадр");
    expect(chip.textContent).not.toContain("недостоверн");
    expect(chip.dataset["trust"]).toBeUndefined();
    expect(chip.title).toBe("");
  });

  test("вкладка была в фоне — число видно, но помечено недостоверным", async () => {
    const dom = await boot("#graph", 14);
    dom.hide();
    const worker = dom.workers[0]!;

    worker.emit({ type: "seed", generation: 1, positions: new Float32Array(28), ms: 1 });
    dom.flushFrames();
    dom.flushFrames();

    const chip = dom.el("graph-layout");
    // Число остаётся на виду: по нему проверяют бюджет, а вкладка может так
    // и не стать активной. Врать оно при этом не должно.
    expect(chip.textContent).toContain("первый кадр");
    expect(chip.textContent).toContain(UNTRUSTED);
    expect(chip.dataset["trust"]).toBe("low");
    expect(chip.title).toContain("requestAnimationFrame");
  });

  test("страница открыта уже скрытой — оговорка есть с первого кадра", async () => {
    const dom = installDom("#graph", 14);
    dom.visibility = "hidden";
    const dir = mkdtempSync(join(tmpdir(), "myc-viz-"));
    tempDirs.push(dir);
    const file = join(dir, `app-${moduleSeq++}.mjs`);
    writeFileSync(file, getAsset("/app.js")!.body);
    await import(file);
    await settle();

    const worker = dom.workers[0]!;
    worker.emit({ type: "seed", generation: 1, positions: new Float32Array(28), ms: 1 });
    dom.flushFrames();
    dom.flushFrames();
    expect(dom.el("graph-layout").textContent).toContain(UNTRUSTED);
  });

  test("уточнение лэйаута в фоне тоже помечается", async () => {
    const dom = await boot("#graph", 14);
    const worker = dom.workers[0]!;
    worker.emit({ type: "seed", generation: 1, positions: new Float32Array(28), ms: 1 });
    dom.flushFrames();
    dom.flushFrames();
    expect(dom.el("graph-layout").textContent).not.toContain("недостоверн");

    dom.hide();
    worker.emit({
      type: "done",
      generation: 1,
      positions: new Float32Array(28),
      iter: 300,
      ms: 7043,
    });
    dom.flushFrames();
    expect(dom.el("graph-layout").textContent).toContain(UNTRUSTED);
  });

  test("уход в фон после последнего кадра число уже не портит", async () => {
    const dom = await boot("#graph", 14);
    const worker = dom.workers[0]!;
    worker.emit({ type: "seed", generation: 1, positions: new Float32Array(28), ms: 1 });
    worker.emit({
      type: "done",
      generation: 1,
      positions: new Float32Array(28),
      iter: 300,
      ms: 166,
    });
    dom.flushFrames();
    dom.flushFrames();

    dom.hide();
    expect(dom.el("graph-layout").textContent).not.toContain("недостоверн");
    expect(dom.el("graph-layout").textContent).toContain("166 мс");
  });
});

// ---------------------------------------------------------------------------
// Доска задач (W4): куда карточку МОЖНО перетащить — не выбор пользователя.
// ---------------------------------------------------------------------------

/**
 * Событие drag* доходит до делегированных слушателей `board-cols` тем же
 * приёмом, что клик по вкладке (`target.closest`) — фейковый DOM здесь не
 * строит настоящее дерево, поэтому `closest` подставляется вручную.
 */
function dragEvent(card: unknown, col: unknown): { target: unknown; preventDefault: () => void } {
  return {
    target: {
      closest: (sel: string) => (sel === ".board-card" ? card : sel === ".board-col" ? col : null),
    },
    preventDefault: () => undefined,
  };
}

describe("доска: куда перетащить — вычисляется, не выбирается (S54)", () => {
  test("перетаскивание в blocked отклоняется на клиенте, без обращения к серверу", async () => {
    const dom = await boot("#board");
    const host = dom.el("board-cols");
    host.fire("dragstart", dragEvent({ dataset: { id: "t-open", column: "open" } }, null));
    host.fire("drop", dragEvent(null, { dataset: { column: "blocked" } }));
    await settle();

    expect(dom.el("toast").hidden).toBe(false);
    expect(dom.el("toast").textContent).toContain("blocked вычисляется из зависимостей");
    expect(dom.posts.length).toBe(0);
    // Диалог даже не открывался: отказ решается ДО сети, fetch на предпросмотр не ушёл.
    expect(dom.fetches.some((f) => f.includes("release-preview"))).toBe(false);
  });

  test("перетаскивание в in_progress отклоняется на клиенте, без обращения к серверу", async () => {
    const dom = await boot("#board");
    const host = dom.el("board-cols");
    host.fire("dragstart", dragEvent({ dataset: { id: "t-open", column: "open" } }, null));
    host.fire("drop", dragEvent(null, { dataset: { column: "in_progress" } }));
    await settle();

    expect(dom.el("toast").textContent).toContain("in_progress зарабатывается арендой");
    expect(dom.posts.length).toBe(0);
  });

  test("перетаскивание обратно в свою же колонку — не операция", async () => {
    const dom = await boot("#board");
    const host = dom.el("board-cols");
    host.fire("dragstart", dragEvent({ dataset: { id: "t-open", column: "open" } }, null));
    host.fire("drop", dragEvent(null, { dataset: { column: "open" } }));
    await settle();

    expect(dom.posts.length).toBe(0);
    expect(dom.fetches.some((f) => f.includes("release-preview"))).toBe(false);
  });

  test("перетаскивание в closed открывает диалог, тянет предпросмотр освобождаемых и требует причину", async () => {
    const dom = await boot("#board");
    dom.boardReleased = [
      { id: "dep-1", title: "освободится из blocked", kind: "task", status: "open", priority: 1, type: "task" },
    ];
    const host = dom.el("board-cols");
    host.fire("dragstart", dragEvent({ dataset: { id: "t-blocked", column: "blocked" } }, null));
    host.fire("drop", dragEvent(null, { dataset: { column: "closed" } }));
    await settle();

    // Диалог открылся и сам подтянул поимённый список — до подтверждения.
    expect(dom.el("board-modal").hidden).toBe(false);
    expect(dom.el("board-modal-title").textContent).toContain("t-blocked");
    expect(dom.fetches).toContain("/api/nodes/t-blocked/release-preview");

    // Подтверждение без причины — отказ, без запроса на запись.
    (dom.el("board-modal-confirm") as any).onclick();
    await settle();
    expect(dom.posts.length).toBe(0);
    expect(dom.el("board-modal").hidden).toBe(false);

    // С причиной — уходит ровно та же операция, что у опбара карточки.
    (dom.el("board-modal-reason") as any).value = "готово по факту";
    (dom.el("board-modal-confirm") as any).onclick();
    await settle();

    expect(dom.posts).toEqual([
      { path: "/api/nodes/t-blocked/op", body: { op: "close", reason: "готово по факту" } },
    ]);
    expect(dom.el("board-modal").hidden).toBe(true);
  });

  test("«не надо» закрывает диалог без единого запроса на запись", async () => {
    const dom = await boot("#board");
    const host = dom.el("board-cols");
    host.fire("dragstart", dragEvent({ dataset: { id: "t-blocked", column: "blocked" } }, null));
    host.fire("drop", dragEvent(null, { dataset: { column: "cancelled" } }));
    await settle();
    expect(dom.el("board-modal").hidden).toBe(false);

    (dom.el("board-modal-cancel") as any).onclick();
    await settle();

    expect(dom.el("board-modal").hidden).toBe(true);
    expect(dom.posts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Карточка узла (myc-k7s2f240zkmp): смена эпика.
//
// Карточка открывается ровно так, как её открывает человек — кликом по узлу
// на канве, а не прямым вызовом приватного метода. `pick()` берёт индекс узла
// по расстоянию до лэйаута, поэтому сперва засеваем лэйаут нулевыми позициями
// (тем же приёмом, что и тесты «честности первого кадра») — тогда узел 0
// оказывается ровно в (0, 0), куда бьёт клик по клиентским координатам (0, 0)
// при `getBoundingClientRect` = {left: 0, top: 0}.
// ---------------------------------------------------------------------------

/**
 * Открывает карточку первого узла. С нулевыми позициями `fit()` вписывает
 * единственную точку в центр канвы — стенд всегда даёт 800×600
 * (`getBoundingClientRect`), значит центр строго (400, 300); клик именно
 * туда, а не в (0, 0), где точка была бы без автовписывания.
 */
async function openCard(dom: Dom, graphNodes: number): Promise<void> {
  const canvas = dom.el("canvas");
  const worker = dom.workers[0]!;
  worker.emit({ type: "seed", generation: 1, positions: new Float32Array(graphNodes * 2), ms: 1 });
  dom.flushFrames();
  canvas.fire("pointerdown", { clientX: 400, clientY: 300, pointerId: 1 });
  canvas.fire("pointerup", { clientX: 400, clientY: 300, pointerId: 1 });
  await settle();
}

describe("карточка узла: смена эпика (S… myc-k7s2f240zkmp)", () => {
  test("карточка открывается кликом по узлу и тянет связи с сервера", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0", { title: "первый узел" }));
    await openCard(dom, 3);

    expect(dom.el("node-card").hidden).toBe(false);
    expect(dom.fetches).toContain("/api/nodes/n0/card");
  });

  test("сменить эпик шлёт POST {parent: <id>}", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);

    const input = dom.findCreated((e) => e.attrs.get("placeholder") === "id эпика");
    const apply = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "сменить эпик");
    expect(input).toBeDefined();
    expect(apply).toBeDefined();

    input!.value = "epic-1";
    apply!.fire("click");
    await settle();

    expect(dom.posts).toEqual([{ path: "/api/nodes/n0", body: { parent: "epic-1" } }]);
  });

  test("«выйти из эпика» шлёт POST {parent: \"\"}", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set(
      "n0",
      defaultCardView("n0", { parent: { id: "epic-1", title: "эпик", kind: "task", status: "open", priority: 1, type: "epic" } }),
    );
    await openCard(dom, 3);

    const detach = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "выйти из эпика");
    expect(detach).toBeDefined();

    detach!.fire("click");
    await settle();

    expect(dom.posts).toEqual([{ path: "/api/nodes/n0", body: { parent: "" } }]);
  });

  test("пустой id эпика ничего не шлёт и показывает toast", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);

    const input = dom.findCreated((e) => e.attrs.get("placeholder") === "id эпика");
    const apply = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "сменить эпик");

    input!.value = "   ";
    apply!.fire("click");
    await settle();

    expect(dom.posts.length).toBe(0);
    expect(dom.el("toast").hidden).toBe(false);
    expect(dom.el("toast").textContent).toContain("id эпика пуст");
  });

  test("отказ сервера (precond.cycle) показывается текстом сервера, а не общей фразой", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);

    dom.nextWriteReply = {
      body: { error: { code: "precond.cycle", msg: "узел не может входить в состав своего потомка" } },
    };

    const input = dom.findCreated((e) => e.attrs.get("placeholder") === "id эпика");
    const apply = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "сменить эпик");
    input!.value = "n1";
    apply!.fire("click");
    await settle();

    expect(dom.el("toast").textContent).toBe("precond.cycle: узел не может входить в состав своего потомка");
    expect(dom.el("toast").textContent).not.toContain("что-то пошло не так");
  });
});

// Три случая аренды — те же, что у fmtLease в CLI (memory-3a4b6d4hax96).
// Прежняя строка «в работе @кто до 12:00» печаталась и после истечения, то
// есть называла брошенную задачу занятой, а задача из beads без аренды не
// говорила о ней ничего.
describe("карточка узла: срок аренды (memory-3a4b6d4hax96)", () => {
  async function leaseText(over: Partial<CardView>): Promise<string | undefined> {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0", over));
    await openCard(dom, 3);
    return dom.findCreated((e) => e.className.includes("card-lease"))?.textContent;
  }

  test("аренда действует — держатель, часы и время ДО истечения", async () => {
    const t = await leaseText({ status: "in_progress", lease: { holder: "agent7", expires: Date.now() + 25 * 60_000 } });
    expect(t).toMatch(/^в работе @agent7 до \d{2}:\d{2}:\d{2} \(через 2[45]m\)$/);
  });

  test("аренда истекла — «истекла … назад», а не «в работе до»", async () => {
    const t = await leaseText({
      status: "in_progress",
      lease: { holder: "agent7", expires: Date.now() - 3 * 3_600_000 - 60_000 },
    });
    expect(t).toBe("аренда @agent7 истекла 3h назад");
  });

  test("в работе без аренды (ввоз из beads) — сказано прямо", async () => {
    expect(await leaseText({ status: "in_progress", lease: null })).toBe("в работе без аренды");
  });

  test("срок 0 — не аренда и не полночь 1970", async () => {
    const t = await leaseText({ status: "in_progress", lease: { holder: "agent7", expires: 0 } });
    expect(t).toBe("в работе без аренды");
  });

  test("открытая задача без аренды строки не получает", async () => {
    expect(await leaseText({ status: "open", lease: null })).toBeUndefined();
  });
});

describe("карточка узла: нить комментариев (W13, memory-tje3kp7avp13)", () => {
  test("комментарии агента и человека рисуются в одной ленте и различимы по классу", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set(
      "n0",
      defaultCardView("n0", {
        comments: [
          { id: "c1", author: "agent", role: "agent", body: "первое агентское", created_at: 1000 },
          { id: "c2", author: "egor", role: "user", body: "ответ человека", created_at: 2000 },
        ],
      }),
    );
    await openCard(dom, 3);

    const title = dom.findCreated((e) => e.className === "card-comments-title");
    expect(title?.textContent).toBe("нить · 2");

    const agentLine = dom.findCreated((e) => e.className.includes("card-comment-agent"));
    const humanLine = dom.findCreated((e) => e.className.includes("card-comment-human"));
    expect(agentLine).toBeDefined();
    expect(humanLine).toBeDefined();
    // Разные классы у разных комментариев — это и есть визуальная различимость.
    expect(agentLine!.className).not.toBe(humanLine!.className);
  });

  test("пустая нить не роняет карточку и показывает счётчик 0", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);

    const title = dom.findCreated((e) => e.className === "card-comments-title");
    expect(title?.textContent).toBe("нить · 0");
  });

  test("composer виден только при writeEnabled и шлёт POST /op {op:'comment'}", async () => {
    const dom = await boot("#graph", 3, { readOnly: true });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);
    expect(dom.findCreated((e) => e.className === "card-comment-input")).toBeUndefined();
  });

  test("отправка комментария шлёт правильный POST", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);

    const input = dom.findCreated((e) => e.className === "card-comment-input");
    const send = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "отправить");
    expect(input).toBeDefined();
    expect(send).toBeDefined();

    input!.value = "новый комментарий";
    send!.fire("click");
    await settle();

    expect(dom.posts).toEqual([{ path: "/api/nodes/n0/op", body: { op: "comment", body: "новый комментарий" } }]);
  });

  test("пустой комментарий ничего не шлёт и показывает toast", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);

    const input = dom.findCreated((e) => e.className === "card-comment-input");
    const send = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "отправить");
    input!.value = "   ";
    send!.fire("click");
    await settle();

    expect(dom.posts.length).toBe(0);
    expect(dom.el("toast").textContent).toContain("комментарий пуст");
  });

  test("отказ сервера (501 unsupported.op) на комментарий показывается текстом сервера, а не молчит", async () => {
    const dom = await boot("#graph", 3, { readOnly: false });
    dom.cards.set("n0", defaultCardView("n0"));
    await openCard(dom, 3);

    dom.nextWriteReply = {
      status: 501,
      body: { error: { code: "unsupported.op", msg: "операция 'comment' не реализована: требует ребра replies_to" } },
    };

    const input = dom.findCreated((e) => e.className === "card-comment-input");
    const send = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "отправить");
    input!.value = "не пройдёт";
    send!.fire("click");
    await settle();

    expect(dom.el("toast").textContent).toContain("unsupported.op");
    expect(dom.el("toast").textContent).toContain("replies_to");
  });
});

// ---------------------------------------------------------------------------

describe("роутинг: модель × класс задачи (W12)", () => {
  test("сводка показывает покрытие: задачи, атрибуция, попытки, формула", async () => {
    const dom = await boot("#routing");
    const sub = dom.el("routing-sub").textContent;
    expect(sub).toContain("103");
    expect(sub).toContain("14");
    expect(sub).toContain("16");
    expect(sub).toContain("outcome v1");
    expect(sub).toContain("порог наблюдений 3");
  });

  test("МУТАЦИЯ: оговорка single_arm обязана быть видна на экране, а не только внутри карточки класса", async () => {
    const dom = await boot("#routing");
    // routing.single_arm.feature:cross из degraded payload'а обязан долететь до DOM.
    const code = dom.findCreated(
      (e) => e.tagName === "CODE" && e.textContent === "routing.single_arm.feature:cross",
    );
    expect(code).toBeDefined();
    const msg = dom.findCreated((e) => e.textContent?.includes("сравнивать не с чем") ?? false);
    expect(msg).toBeDefined();
  });

  test("оговорок нет — экран говорит это явно, а не показывает пустой список молча", async () => {
    const dom = await boot("#graph");
    dom.routingPayload = {
      ...defaultRoutingPayload() as Record<string, unknown>,
      degraded: [],
    };
    dom.goto("#routing");
    await settle();
    const ok = dom.findCreated(
      (e) => e.textContent === "по каждому классу задач есть однозначный ответ",
    );
    expect(ok).toBeDefined();
  });

  test("«цены нет» (null) и «цена ноль» (0) рисуются по-разному, а не одинаковым прочерком", async () => {
    const dom = await boot("#routing");
    // pricey/high в fix:module: costUsdMean=0, посчитана у всех 6 попыток.
    const zero = dom.findCreated((e) => e.textContent?.startsWith("$0.0000/попытка") ?? false);
    expect(zero).toBeDefined();
    // opus/high в feature:cross: costUsdMean=null, посчитана у 0 попыток.
    const missing = dom.findCreated((e) => e.textContent?.startsWith("нет цены/попытка") ?? false);
    expect(missing).toBeDefined();
    expect(zero!.textContent).not.toBe(missing!.textContent);
  });

  test("cheapest помечен стрелкой, единственная рука single_arm — нет", async () => {
    const dom = await boot("#routing");
    const arrow = dom.findCreated((e) => e.className === "arm-mark" && e.textContent === "→");
    expect(arrow).toBeDefined();
    // Среди пометок arm-mark нет второй стрелки не у той руки: у single_arm
    // класса единственная рука не помечена дешевейшей.
    const marks = dom.created.filter((e) => e.className === "arm-mark").map((e) => e.textContent);
    expect(marks.filter((m) => m === "→").length).toBe(1);
  });

  test("атрибуции нет: available:false — пустое состояние с советом, а не молчащий пустой экран", async () => {
    const dom = await boot("#graph");
    dom.routingPayload = {
      available: false,
      classes: [],
      coverage: {
        attempts: 0,
        finished: 0,
        withCost: 0,
        arms: 0,
        classes: 0,
        tasksClosed: 0,
        tasksAttributed: 0,
      },
      outcomeVersion: 0,
      minAttempts: 3,
      credibleMass: 0.9,
      degraded: [{ code: "swarm.missing", msg: "таблицы swarm_attempt нет" }],
      took_ms: 1,
    };
    dom.goto("#routing");
    await settle();

    expect(dom.el("routing-classes").hidden).toBe(true);
    expect(dom.el("routing-empty").hidden).toBe(false);
    const title = dom.findCreated((e) => e.className === "big" && e.textContent === "Атрибуции пока нет");
    expect(title).toBeDefined();
    const swarmMissing = dom.findCreated(
      (e) => e.tagName === "CODE" && e.textContent === "swarm.missing",
    );
    expect(swarmMissing).toBeDefined();
  });
});

describe("решения (W8, memory-cx00fqk28pgv): цепочки и открытые противоречия", () => {
  test("сводка показывает счётчики, актуальная версия и старая различимы", async () => {
    const dom = await boot("#decisions");
    const sub = dom.el("decisions-sub").textContent;
    expect(sub).toContain("3");
    expect(sub).toContain("1");

    // МУТАЦИЯ: если клиент забудет прокинуть флаг current с сервера (или
    // инвертирует его), «· актуальна» пропадёт у головы или появится у обеих
    // версий — ровно баг «устаревшее решение показано как действующее».
    // Голова (dec-new, status active) обязана нести пометку «· актуальна»…
    const currentPill = dom.findCreated((e) => e.textContent === "active · актуальна");
    expect(currentPill).toBeDefined();
    // …а устаревшее звено (dec-old, status superseded) — нет, ни в каком виде.
    const stalePill = dom.findCreated((e) => e.textContent === "superseded");
    expect(stalePill).toBeDefined();
    const staleMarkedCurrent = dom.findCreated((e) => e.textContent === "superseded · актуальна");
    expect(staleMarkedCurrent).toBeUndefined();
    const oldLine = dom.findCreated((e) => e.textContent === "dec-old");
    expect(oldLine).toBeDefined();
    const newLine = dom.findCreated((e) => e.textContent === "dec-new");
    expect(newLine).toBeDefined();
  });

  test("read-only: кнопки «это верное» не рисуются вовсе", async () => {
    const dom = await boot("#decisions", 0, { readOnly: true });
    const btn = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "это верное");
    expect(btn).toBeUndefined();
  });

  test("«это верное» отменяет ДРУГУЮ сторону обычным путём (POST .../op, op=cancel) с непустой причиной", async () => {
    const dom = await boot("#decisions", 0, { readOnly: false });
    const buttons = dom.created.filter((e) => e.tagName === "BUTTON" && e.textContent === "это верное");
    // Один на каждую сторону единственного противоречия.
    expect(buttons.length).toBe(2);
    buttons[0]!.fire("click");
    await settle();

    expect(dom.posts.length).toBe(1);
    const post = dom.posts[0]!;
    // Кнопка на строке dec-x отменяет ДРУГУЮ сторону — dec-y, не саму dec-x:
    // тихое погашение своей же стороны было бы противоположностью приёмки.
    expect(post.path).toBe("/api/nodes/dec-y/op");
    expect(post.body).toMatchObject({ op: "cancel" });
    const body = post.body as { op: string; reason: string };
    expect(body.reason.length).toBeGreaterThan(0);
    expect(body.reason).toContain("dec-x");
  });

  test("противоречий нет — экран говорит это явно", async () => {
    const dom = await boot("#graph");
    dom.decisionsPayload = { ...(defaultDecisionsPayload() as Record<string, unknown>), contradictions: [] };
    dom.goto("#decisions");
    await settle();
    expect(dom.el("decisions-contradictions-empty").hidden).toBe(false);
    const title = dom.findCreated((e) => e.className === "big" && e.textContent === "Открытых противоречий нет");
    expect(title).toBeDefined();
  });

  test("оговорки деградации видны, а не проглочены (И2)", async () => {
    const dom = await boot("#graph");
    dom.decisionsPayload = {
      ...(defaultDecisionsPayload() as Record<string, unknown>),
      degraded: [{ code: "decisions.chain_truncated", msg: "у части цепочек версий больше бюджета чтения" }],
    };
    dom.goto("#decisions");
    await settle();
    const code = dom.findCreated(
      (e) => e.tagName === "CODE" && e.textContent === "decisions.chain_truncated",
    );
    expect(code).toBeDefined();
  });
});

describe("поиск (W6, memory-c7075t2s0nj6): гибридный поиск, тот же движок, что myc recall", () => {
  async function search(dom: Dom, query: string): Promise<void> {
    (dom.el("search-query") as unknown as { value: string }).value = query;
    dom.el("search-go").fire("click");
    await settle();
  }

  test("запрос уходит в /api/search с текстом query — ноль своей логики поиска в браузере", async () => {
    const dom = await boot("#search");
    await search(dom, "бюджет prime");
    const call = dom.fetches.find((f) => f.startsWith("/api/search"));
    expect(call).toBeDefined();
    expect(decodeURIComponent(call!.replace(/\+/g, " "))).toContain("q=бюджет prime");
  });

  test("МУТАЦИЯ: z-оценка уверенности (S47) обязана быть видна на экране для каждой строки", async () => {
    const dom = await boot("#search");
    await search(dom, "бюджет prime");
    // Строка с вектором: confidence=1.83 напечатан как есть, не «1» и не «да».
    const conf = dom.findCreated((e) => e.className === "search-conf" && e.textContent === "1.83");
    expect(conf).toBeDefined();
    // Строка БЕЗ вектора: "·", а не "0.00" — ноль читался бы как измеренное
    // низкое качество, а сигнала не было вовсе (см. types.ts, S47).
    const none = dom.findCreated(
      (e) => e.className === "search-conf search-conf-none" && e.textContent === "·",
    );
    expect(none).toBeDefined();
  });

  test("МУТАЦИЯ: предупреждение деградации (warn[]) обязано долететь до экрана, а не потеряться", async () => {
    const dom = await boot("#search");
    dom.searchWarn = [
      { code: "degraded.embeddings", msg: "прогрев эмбеддера выключен — векторная ветка не звалась" },
    ];
    await search(dom, "переезд задачи");
    const code = dom.findCreated((e) => e.tagName === "CODE" && e.textContent === "degraded.embeddings");
    expect(code).toBeDefined();
    const msg = dom.findCreated(
      (e) => e.textContent?.includes("векторная ветка не звалась") ?? false,
    );
    expect(msg).toBeDefined();
  });

  test("деградации нет — предупреждений на экране тоже нет", async () => {
    const dom = await boot("#search");
    dom.searchWarn = [];
    await search(dom, "бюджет prime");
    const code = dom.findCreated((e) => e.tagName === "CODE");
    expect(code).toBeUndefined();
  });

  test("partial и cursor показаны своей строкой, а не спрятаны в подсказку", async () => {
    const dom = await boot("#search");
    dom.searchPayload = {
      ...(defaultSearchPayload() as Record<string, unknown>),
      partial: true,
      omitted: 3,
      cursor: "5",
    };
    await search(dom, "бюджет prime");
    const partial = dom.findCreated((e) => e.textContent?.startsWith("partial:") ?? false);
    expect(partial).toBeDefined();
    expect(partial!.textContent).toContain("3 сверх бюджета");
    const more = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "показать ещё");
    expect(more).toBeDefined();
  });

  test("пустая выдача — явное пустое состояние, а не молчащий пустой список", async () => {
    const dom = await boot("#search");
    dom.searchPayload = { ...(defaultSearchPayload() as Record<string, unknown>), rows: [], shown: 0, total: 0 };
    await search(dom, "нет такого текста");
    expect(dom.el("search-rows").hidden).toBe(true);
    expect(dom.el("search-empty").hidden).toBe(false);
  });
});

describe("бутстрап: редактор обязательного контекста (W9, memory-hxatd6ce2ymn)", () => {
  test("предпросмотр — буквальный `data.text` с сервера, не пересборка в браузере", async () => {
    const dom = await boot("#graph", 0, { readOnly: false });
    dom.bootstrapPreview = {
      ...(defaultBootstrapPreview() as Record<string, unknown>),
      text: "# MYC BOOTSTRAP v1 · ws=demo\n[manual:style] короткие коммиты\n# 10 body chars / 2000 budget · 1 мс · cache off\n",
    };
    dom.goto("#bootstrap");
    await settle();

    expect(dom.el("bootstrap-preview").textContent).toBe(
      "# MYC BOOTSTRAP v1 · ws=demo\n[manual:style] короткие коммиты\n# 10 body chars / 2000 budget · 1 мс · cache off\n",
    );
  });

  test("сохранить блок шлёт POST /api/bootstrap/<key> {text, global}", async () => {
    const dom = await boot("#bootstrap", 0, { readOnly: false });
    const key = dom.findCreated((e) => (e.attrs.get("placeholder") ?? "").startsWith("ключ:"));
    const text = dom.findCreated(
      (e) => e.attrs.get("placeholder") === "текст правила — то, что увидит агент",
    );
    const submit = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "сохранить блок");
    expect(key).toBeDefined();
    expect(text).toBeDefined();
    expect(submit).toBeDefined();

    key!.value = "style";
    text!.value = "используй короткие сообщения коммитов";
    submit!.fire("click");
    await settle();

    expect(dom.posts).toEqual([
      {
        path: "/api/bootstrap/style",
        body: { text: "используй короткие сообщения коммитов", global: false },
      },
    ]);
  });

  test("МУТАЦИЯ: пустой ключ ничего не шлёт и показывает toast", async () => {
    const dom = await boot("#bootstrap", 0, { readOnly: false });
    const text = dom.findCreated(
      (e) => e.attrs.get("placeholder") === "текст правила — то, что увидит агент",
    );
    const submit = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "сохранить блок");

    text!.value = "текст без ключа";
    submit!.fire("click");
    await settle();

    expect(dom.posts.length).toBe(0);
    expect(dom.el("toast").hidden).toBe(false);
    expect(dom.el("toast").textContent).toContain("ключ");
  });

  test("снять блок шлёт POST .../op {op:'rm'}", async () => {
    // Хеш при старте — "#graph": "#bootstrap" не должен попасть в `loaded` до
    // того, как фикстура блоков подставлена, иначе повторный заход на
    // вкладку ничего не перерисует (applyRoute кеширует загруженные экраны).
    const dom = await boot("#graph", 0, { readOnly: false });
    dom.bootstrapBlocks = [{ key: "style", id: "n1", tier: "project", chars: 12, updated_at: 1 }];
    dom.goto("#bootstrap");
    await settle();

    const rm = dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === "снять");
    expect(rm).toBeDefined();
    rm!.fire("click");
    await settle();

    expect(dom.posts).toContainEqual({
      path: "/api/bootstrap/style/op",
      body: { op: "rm", global: false },
    });
  });

  test("МУТАЦИЯ: обрезка бюджетом видна явным баннером, а не только числом в шапке", async () => {
    const dom = await boot("#graph", 0, { readOnly: false });
    dom.bootstrapPreview = {
      ...(defaultBootstrapPreview() as Record<string, unknown>),
      truncated: true,
      dropped: ["skills"],
      clipped: ["models"],
    };
    dom.goto("#bootstrap");
    await settle();

    // Заглушка DOM не строит настоящее дерево (append — no-op): текст ищем
    // среди созданных клиентом узлов, как и остальные тесты этого файла.
    expect(dom.el("bootstrap-cut").hidden).toBe(false);
    const banner = dom.findCreated((e) => (e.textContent ?? "").includes("порезано бюджетом"));
    expect(banner).toBeDefined();
    const details = dom.findCreated(
      (e) => (e.textContent ?? "").includes("skills") && (e.textContent ?? "").includes("models"),
    );
    expect(details).toBeDefined();
  });

  test("обрезки нет — баннер скрыт, а не показывает пустые списки", async () => {
    const dom = await boot("#bootstrap", 0, { readOnly: false });
    expect(dom.el("bootstrap-cut").hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// База знаний: разбор кандидата хука сжатия (memory-79mq6fccg0jm)
// ---------------------------------------------------------------------------

describe("база знаний: кнопки кандидата", () => {
  function kbRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      kind: "note",
      subtype: null,
      title: `решили что-то ${id}`,
      status: "active",
      layer: 2,
      acl: "private",
      tags: [],
      reach: "session",
      session: "S-1",
      repo: "",
      repo_state: "unknown",
      review: "pending_review",
      review_open: true,
      updated_at: 1,
      ...over,
    };
  }

  function kbPayload(rows: Record<string, unknown>[]): unknown {
    return {
      rows,
      total: rows.length,
      shown: rows.length,
      counts: {
        by_kind: [{ key: "note", n: rows.length }],
        by_layer: [{ key: "L2", n: rows.length }],
        reach: { project: 0, session: rows.length, unknown: 0 },
        pending_review: rows.filter((r) => r["review_open"] === true).length,
        repo: { root: 0, unknown: rows.length, by_repo: [] },
      },
      took_ms: 1,
    };
  }

  async function kbScreen(rows: Record<string, unknown>[], readOnly: boolean): Promise<Dom> {
    const dom = await boot("#graph", 0, { readOnly });
    dom.kbPayload = kbPayload(rows);
    dom.goto("#kb");
    await settle();
    return dom;
  }

  const button = (dom: Dom, label: string): StubEl | undefined =>
    dom.findCreated((e) => e.tagName === "BUTTON" && e.textContent === label);

  // Мутация «убрать бар разбора из renderKbRow» роняет этот тест.
  test("«принять» шлёт POST /op {op:'confirm'} — тот же путь записи, что `myc review confirm`", async () => {
    const dom = await kbScreen([kbRow("cand-1")], false);
    const accept = button(dom, "принять");
    expect(accept).toBeDefined();
    accept!.fire("click");
    await settle();
    expect(dom.posts).toEqual([{ path: "/api/nodes/cand-1/op", body: { op: "confirm" } }]);
  });

  test("«отклонить» требует причину и шлёт её", async () => {
    const dom = await kbScreen([kbRow("cand-2")], false);
    button(dom, "отклонить")!.fire("click");
    await settle();
    expect(dom.posts.length).toBe(0); // без причины не уходит
    const reason = dom.findCreated((e) => e.tagName === "INPUT" && (e.attrs.get("placeholder") ?? "").startsWith("причина"));
    expect(reason).toBeDefined();
    reason!.value = "пересказ задачи, не решение";
    // Кнопка отправки причины в опбаре вешается через `onclick` (переназначается
    // на каждую операцию), а не addEventListener — зовём его так же, как браузер.
    (button(dom, "подтвердить") as unknown as { onclick: () => void }).onclick();
    await settle();
    expect(dom.posts).toEqual([
      { path: "/api/nodes/cand-2/op", body: { op: "reject", reason: "пересказ задачи, не решение" } },
    ]);
  });

  test("отклонённый кандидат помечен и кнопок не получает; read-only — тоже без кнопок", async () => {
    const dom = await kbScreen([kbRow("cand-3", { status: "retracted", review_open: false })], false);
    expect(button(dom, "принять")).toBeUndefined();
    expect(dom.findCreated((e) => e.textContent === "[кандидат · отклонён]")).toBeDefined();

    const ro = await kbScreen([kbRow("cand-4")], true);
    expect(button(ro, "принять")).toBeUndefined();
    expect(ro.findCreated((e) => e.textContent === "[кандидат · не подтверждён]")).toBeDefined();
  });
});
