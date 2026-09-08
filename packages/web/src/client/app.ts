/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Клиент просмотрщика: ванильный TypeScript, ноль зависимостей, ноль CDN.
 *
 * Файл самодостаточен намеренно. Единственный импорт — `import type` из
 * общих типов, а он стирается транспайлером, поэтому браузеру не нужен ни
 * бандлер, ни резолвер модулей: сервер отдаёт этот файл как есть, уже без
 * типов.
 *
 * Четыре экрана, и ровно четыре: граф, очередь ready с раскрытием слагаемых,
 * таймлайн оплога, здоровье. Всё остальное — в M4.
 */

import type {
  BoardColumn,
  BoardPayload,
  BoardRow,
  BootPayload,
  BootstrapBlockRow,
  BootstrapHistoryRow,
  BootstrapPreview,
  CardComment,
  CardRef,
  CardView,
  DecisionChain,
  DecisionContradiction,
  DecisionLink,
  DecisionRef,
  DecisionsPayload,
  GraphNode,
  GraphPayload,
  HealthPayload,
  KbCounts,
  KbPayload,
  KbRow,
  ReadyPayload,
  ReadyRow,
  RoutingArm,
  RoutingClass,
  RoutingPayload,
  SearchPayload,
  SearchRow,
  TimelinePayload,
  VizTab,
} from "../types.ts";

const BOOT_T0 = performance.now();

/**
 * Была ли вкладка скрыта хоть раз с момента старта страницы.
 *
 * Chrome душит фоновую вкладку дважды: `setTimeout` прижимается к секунде, а
 * `requestAnimationFrame` не вызывается вовсе. Поэтому «первый кадр», померенный
 * в фоне, меряет не отрисовку, а время до момента, когда на вкладку посмотрели:
 * на 14 узлах это 7043 мс против 208 мс на активной вкладке при бюджете 400.
 * Флаг монотонный — скрылись один раз, и замер этого прогона уже не отмыть.
 */
let tabWasHidden = document.visibilityState === "hidden";
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") tabWasHidden = true;
});

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtInt(n: number): string {
  return n.toLocaleString("ru-RU");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1048576).toFixed(1)} МБ`;
}

function fmtAge(ms: number): string {
  const abs = Math.max(0, ms);
  const m = Math.floor(abs / 60000);
  if (m < 1) return `${Math.floor(abs / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

let toastTimer = 0;
function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    t.hidden = true;
  }, 6000);
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ msg: res.statusText }))) as {
      msg?: string;
      error?: { msg?: string };
    };
    throw new Error(body.msg ?? body.error?.msg ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * GET-маршруты бутстрапа (`/api/bootstrap`, `/api/bootstrap/blocks`) отдают
 * тот же конверт `{ok,data,…}`, что и запись (mutate.ts): их данные приходят
 * из `runWrite`, а не из прямого чтения БД. `api()` берёт JSON как есть — эта
 * обёртка разворачивает `data`.
 */
async function apiData<T>(path: string): Promise<T> {
  const env = await api<{ ok: boolean; data: T }>(path);
  return env.data;
}

interface Envelope<T> {
  readonly ok: boolean;
  readonly data: T;
  readonly meta?: { degraded?: string[] } & Record<string, unknown>;
  readonly warn?: readonly { code: string; msg: string }[];
  readonly error?: { code: string; msg: string; hint?: string };
}

/**
 * Конверт целиком, включая `warn[]` и `meta.degraded[]` — `apiData` их
 * отбрасывает, а поиск (W6) обязан показать деградацию так же громко, как её
 * печатает `myc recall` (И2): молча срезать предупреждение здесь значило бы
 * сделать интерфейс МЕНЕЕ честным, чем терминал.
 */
async function apiEnvelope<T>(path: string): Promise<Envelope<T>> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || body.ok === false) {
    throw new Error(body.error?.msg ?? `HTTP ${res.status}`);
  }
  return body;
}

/**
 * Запись из интерфейса. Ходит теми же POST-маршрутами, что и любой другой
 * клиент, и НИЧЕГО не решает сама: коды и тексты отказов приходят с сервера,
 * а тот берёт их у общего пути записи. Ошибка и деградация показываются
 * человеку целиком (И2) — молча проглоченный отказ выглядел бы как успешная
 * правка, которой не было.
 */
let writeEnabled = false;

interface WriteReply {
  ok?: boolean;
  error?: { code: string; msg: string; hint?: string };
  warn?: { code: string; msg: string }[];
  data?: Record<string, unknown>;
}

async function mutate(path: string, body: unknown): Promise<boolean> {
  let reply: WriteReply;
  let status: number;
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    reply = (await res.json().catch(() => ({}))) as WriteReply;
  } catch (error) {
    toast(`запись не ушла: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (reply.error !== undefined || reply.ok !== true) {
    const err = reply.error;
    toast(
      err !== undefined
        ? `${err.code}: ${err.msg}${err.hint !== undefined ? ` — ${err.hint}` : ""}`
        : `запись отклонена (HTTP ${status})`,
    );
    return false;
  }
  for (const w of reply.warn ?? []) toast(`WARN ${w.code}: ${w.msg}`);
  return true;
}

function emptyState(
  host: HTMLElement,
  title: string,
  body: string,
  command?: string,
): void {
  host.replaceChildren();
  host.append(el("div", "big", title));
  const p = el("p");
  p.textContent = body;
  host.append(p);
  if (command !== undefined) {
    const c = el("p");
    const code = el("code", undefined, command);
    c.append(code);
    host.append(c);
  }
  host.hidden = false;
}

// ---------------------------------------------------------------------------
// Редактор свойств узла — ОДИН на все экраны и все виды узлов
// ---------------------------------------------------------------------------

/**
 * Правка приоритета, тегов, ACL, оценки и исполнителя одним компонентом.
 * Очередь ready и карточка графа встраивают его, а не отращивают свои: у
 * каждого экрана своя реализация правки — это расползание проверок и UX,
 * которое мы здесь не повторяем.
 *
 * Выпадающие списки лишь ПОДСКАЗЫВАЮТ допустимые значения (приоритет P0–P3,
 * ACL из четырёх режимов) — проверяет не браузер. Подделанный запрос мимо
 * интерфейса попадает в тот же POST-маршрут, и недопустимое значение
 * отвергает общий путь записи: коды и тексты отказов приходят с сервера
 * и показываются человеку как есть (И2).
 *
 * Статуса здесь нет вовсе (S54): он вычисляется или зарабатывается
 * операциями, а не выбирается из списка.
 */

const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const ACL_MODES = ["private", "team", "restricted", "agent"] as const;

/** То, что отдаёт GET /api/nodes/<id> под правку: поля и часы полей. */
interface NodePropsView {
  id: string;
  kind?: string;
  title?: string;
  body?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  acl?: string;
  attrs?: { type?: unknown; tags?: unknown; estimate_min?: number };
  clk?: Record<string, string | null>;
}

/**
 * Видимый тип узла: у задач это attrs.type (task/bug/epic/chore), у остальных
 * — сам kind. Эпик и баг — не отдельные виды ядра: их девять, и «task» среди
 * них один, поэтому интерфейс показывает ОБА значения и не даёт виду притворяться
 * другим видом.
 */
function visibleTypeOf(view: { kind?: string; attrs?: { type?: unknown } }): string {
  if (view.kind === "task") {
    const t = view.attrs?.["type"];
    if (typeof t === "string" && t.length > 0) return t;
  }
  return view.kind ?? "?";
}

async function fetchNodeProps(id: string): Promise<NodePropsView> {
  return api<NodePropsView>(`/api/nodes/${encodeURIComponent(id)}`);
}

/**
 * Запись свойств — тот же POST /api/nodes/<id>, что у любого другого клиента.
 * Часы объявляются только для полей запроса: разные поля двух вкладок сведёт
 * per-field LWW, одно и то же поле даст 409 с именем поля. Имя поля в часах
 * не всегда равно имени поля запроса (теги и оценка живут в attrs), поэтому
 * соответствие берётся из той же таблицы, что держит сервер.
 */
const FIELD_CLOCK: Record<string, string> = {
  title: "title",
  body: "body",
  priority: "priority",
  acl: "acl",
  assignee: "assignee",
  tags: "attrs.tags",
  estimate: "attrs.estimate_min",
};

async function saveNodeProps(
  id: string,
  fields: Record<string, unknown>,
  clk: Record<string, string | null> = {},
  onSaved?: () => void,
): Promise<boolean> {
  const if_match: Record<string, string | null> = {};
  for (const key of Object.keys(fields)) {
    const clock = FIELD_CLOCK[key];
    if (clock === undefined) continue;
    if_match[key] = clk[clock] ?? null;
  }
  const ok = await mutate(`/api/nodes/${encodeURIComponent(id)}`, { ...fields, if_match });
  if (ok && onSaved !== undefined) onSaved();
  return ok;
}

function tagsToInput(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === "string").join(",")
    : "";
}

function inputFromTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Селектор приоритета — часть общего компонента: очередь ready встраивает
 * ровно его, карточка графа — того же через полную панель. Выбор сразу
 * пишется: часы читаются свежими, а отказ или конфликт показывает сервер.
 */
function prioritySelect(
  current: number | undefined,
  id: string,
  onSaved?: () => void,
): HTMLSelectElement {
  const select = el("select", "rprio");
  const now = `P${current ?? 3}`;
  for (const p of PRIORITIES) {
    const o = el("option", undefined, p);
    o.setAttribute("value", p);
    if (now === p) o.setAttribute("selected", "selected");
    select.append(o);
  }
  select.addEventListener("change", () => {
    void (async () => {
      let view: NodePropsView | undefined;
      try {
        view = await fetchNodeProps(id);
      } catch {
        // часы не прочитались — пишем без if_match: CRDT всё равно сведёт
      }
      await saveNodeProps(id, { priority: select.value }, view?.clk ?? {}, onSaved);
    })();
  });
  return select;
}

/** Строка панели: имя, контрол и кнопка записи для свободного ввода. */
function propsRow(
  label: string,
  control: HTMLElement,
  onApply?: () => void,
): HTMLElement {
  const row = el("div", "props-row");
  const name = el("span", "props-name", label);
  row.append(name, control);
  if (onApply !== undefined) {
    const apply = el("button", "rbtn props-apply", "записать");
    apply.addEventListener("click", onApply);
    row.append(apply);
  }
  return row;
}

/**
 * Панель правки одного узла. Встраивается в карточку графа; очередь ready
 * берёт из компонента селектор приоритета. После удачной записи панель
 * перечитывает узел: часы полей обязаны быть свежими, иначе следующая правка
 * тех же полей поймает собственный конфликт.
 */
function nodePropsEditor(id: string, onSaved?: () => void): HTMLElement {
  const root = el("div", "props");
  root.append(el("div", "props-head", "свойства"));

  const render = (view: NodePropsView): void => {
    const type = visibleTypeOf(view);
    root.replaceChildren(
      el(
        "div",
        "props-head",
        // тип рядом с видом: epic — это attrs.type у kind=task, а не другой вид
        `свойства · ${type}${type !== view.kind ? ` (${view.kind})` : ""} · ${view.status ?? "?"}`,
      ),
    );

    const title = el("input", "props-input") as HTMLInputElement;
    title.setAttribute("placeholder", "заголовок");
    title.value = typeof view.title === "string" ? view.title : "";
    const applyTitle = (): void =>
      void saveNodeProps(id, { title: title.value.trim() }, view.clk ?? {}, () => reload());
    title.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") applyTitle();
    });
    root.append(propsRow("заголовок", title, applyTitle));

    const body = el("textarea", "props-input props-body") as HTMLTextAreaElement;
    body.setAttribute("placeholder", "тело: описание, шаги, критерии");
    body.value = typeof view.body === "string" ? view.body : "";
    const applyBody = (): void =>
      void saveNodeProps(id, { body: body.value }, view.clk ?? {}, () => reload());
    root.append(propsRow("тело", body, applyBody));

    root.append(propsRow("приоритет", prioritySelect(view.priority, id, () => reload())));

    const tags = el("input", "props-input") as HTMLInputElement;
    tags.setAttribute("placeholder", "через запятую");
    tags.value = tagsToInput(view.attrs?.tags);
    const applyTags = (): void =>
      void saveNodeProps(id, { tags: inputFromTags(tags.value) }, view.clk ?? {}, () => reload());
    tags.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") applyTags();
    });
    root.append(propsRow("теги", tags, applyTags));

    const acl = el("select", "props-input") as HTMLSelectElement;
    const aclNow = typeof view.acl === "string" ? view.acl : "team";
    for (const mode of ACL_MODES) {
      const o = el("option", undefined, mode);
      o.setAttribute("value", mode);
      if (aclNow === mode) o.setAttribute("selected", "selected");
      acl.append(o);
    }
    acl.addEventListener("change", () => {
      void saveNodeProps(id, { acl: acl.value }, view.clk ?? {}, () => reload());
    });
    root.append(propsRow("доступ", acl));

    const estimate = el("input", "props-input") as HTMLInputElement;
    estimate.setAttribute("placeholder", "30m, 2h, 1d");
    const est = view.attrs?.estimate_min;
    estimate.value = typeof est === "number" ? `${est}m` : "";
    const applyEstimate = (): void =>
      void saveNodeProps(
        id,
        { estimate: estimate.value.trim() },
        view.clk ?? {},
        () => reload(),
      );
    estimate.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") applyEstimate();
    });
    root.append(propsRow("оценка", estimate, applyEstimate));

    const assignee = el("input", "props-input") as HTMLInputElement;
    assignee.setAttribute("placeholder", "исполнитель");
    assignee.value = typeof view.assignee === "string" ? view.assignee : "";
    const applyAssignee = (): void =>
      void saveNodeProps(
        id,
        { assignee: assignee.value.trim() },
        view.clk ?? {},
        () => reload(),
      );
    assignee.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") applyAssignee();
    });
    root.append(propsRow("исполнитель", assignee, applyAssignee));
  };

  const reload = async (): Promise<void> => {
    let view: NodePropsView;
    try {
      view = await fetchNodeProps(id);
    } catch (e) {
      root.replaceChildren(
        el("div", "props-head", "свойства"),
        el("div", "props-error", `узел не прочитан: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    render(view);
  };

  void reload();
  return root;
}

// ---------------------------------------------------------------------------
// Карточка со связями — myc show в интерфейсе
// ---------------------------------------------------------------------------

/** Отметка ребёнка в составе эпика — те же знаки, что печатает `myc show`. */
function childMark(status: string): string {
  return status === "closed" ? "×" : status === "cancelled" ? "—" : "·";
}

function cardRefLine(prefix: string, r: CardRef, withStatus = true): HTMLElement {
  const line = el("div", undefined, `${prefix} ${r.id} ${withStatus ? `P${r.priority}` : ""} ${r.status} ${r.title}`);
  line.classList.add("mono");
  return line;
}

/**
 * Смена эпика у узла — тем же путём, что и остальные поля карточки:
 * POST /api/nodes/<id> с {"parent": "<id>"} переносит, {"parent": ""}
 * отцепляет. `parent` не в FIELDS (это ребро, не поле с часами LWW), поэтому
 * if_match здесь не нужен — как и в форме создания задачи. Отказы
 * (precond.cycle, precond.self_parent и т.д.) показывает `mutate` текстом
 * сервера через toast.
 */
function parentEditRow(id: string, current: CardRef | null, onSaved: () => void): HTMLElement {
  const row = el("div", "props-row");
  const input = el("input", "props-input") as HTMLInputElement;
  input.setAttribute("placeholder", "id эпика");
  input.value = current?.id ?? "";

  const apply = (): void => {
    const val = input.value.trim();
    if (val.length === 0) {
      toast("id эпика пуст — для отцепления жми «выйти из эпика»");
      return;
    }
    void mutate(`/api/nodes/${encodeURIComponent(id)}`, { parent: val }).then(
      (ok) => ok && onSaved(),
    );
  };
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") apply();
  });

  const applyBtn = el("button", "rbtn", "сменить эпик");
  applyBtn.addEventListener("click", apply);
  row.append(el("span", "props-name", "эпик"), input, applyBtn);

  if (current !== null) {
    const detach = el("button", "rbtn", "выйти из эпика");
    detach.addEventListener("click", () => {
      void mutate(`/api/nodes/${encodeURIComponent(id)}`, { parent: "" }).then(
        (ok) => ok && onSaved(),
      );
    });
    row.append(detach);
  }
  return row;
}

/**
 * Строка нити (W13, memory-tje3kp7avp13): kind='message' узел с ребром
 * replies_to. Агент и человек обязаны быть визуально различимы — иначе
 * непонятно, кто что утверждал; различие берётся из attrs.role message-узла
 * (единственное поле роли, которое уже есть в ядре).
 */
function commentLine(c: CardComment): HTMLElement {
  const human = c.role === "user";
  const row = el("div", `card-comment ${human ? "card-comment-human" : "card-comment-agent"}`);
  const head = el("div", "card-comment-head");
  head.append(
    el("span", "card-comment-author", `${human ? "человек" : "агент"} · ${c.author}`),
    el("span", "card-comment-time", fmtTime(c.created_at)),
  );
  row.append(head, el("div", "card-comment-body", c.body));
  return row;
}

/**
 * Запись идёт тем же POST /api/nodes/<id>/op, что и остальные операции
 * карточки (S54, И2): сервер сейчас честно отказывает 501 — создать ребро
 * replies_to общим путём записи нечем (см. OP_GAPS.comment в mutate.ts).
 * Кнопка уже на месте, чтобы заработать без правки клиента, когда у CLI
 * появится команда для произвольного ребра.
 */
function commentComposer(id: string, onSent: () => void): HTMLElement {
  const box = el("div", "card-comment-compose");
  const input = el("textarea", "card-comment-input") as HTMLTextAreaElement;
  input.setAttribute("placeholder", "написать комментарий — markdown, попадёт в оплог");
  input.rows = 2;
  const send = el("button", "rbtn primary", "отправить");
  send.addEventListener("click", () => {
    const text = input.value.trim();
    if (text.length === 0) {
      toast("комментарий пуст");
      return;
    }
    void mutate(`/api/nodes/${encodeURIComponent(id)}/op`, { op: "comment", body: text }).then((ok) => {
      if (ok) {
        input.value = "";
        onSent();
      }
    });
  });
  box.append(input, send);
  return box;
}

function commentsSection(id: string, comments: readonly CardComment[], onSent: () => void): HTMLElement {
  const section = el("div", "card-comments");
  section.append(el("div", "card-comments-title", `нить · ${comments.length}`));
  for (const c of comments) section.append(commentLine(c));
  if (writeEnabled) section.append(commentComposer(id, onSent));
  return section;
}

/**
 * Связи узла тем же разбором, что у `myc show`: «входит в» у ребёнка,
 * «состав N из M закрыто» с отметками у эпика, блокировки и остальные рёбра.
 * Прогресс считает СЕРВЕР (buildCard), и считает закрытыми: отменённые
 * выводятся отдельно, потому что отмена — не сделанная работа.
 */
async function fillCardLinks(host: HTMLElement, id: string): Promise<void> {
  let c: CardView;
  try {
    c = await api<CardView>(`/api/nodes/${encodeURIComponent(id)}/card`);
  } catch (e) {
    host.replaceChildren(
      el("div", "props-error", `связи не прочитаны: ${e instanceof Error ? e.message : String(e)}`),
    );
    return;
  }
  host.replaceChildren();

  // Тип рядом с видом: epic — attrs.type у kind=task, а не отдельный вид ядра.
  if (c.type !== c.kind) {
    host.append(el("div", "card-type", `тип ${c.type} · вид ${c.kind}`));
  }
  if (c.lease !== null) {
    host.append(
      el("div", "mono", `в работе @${c.lease.holder} до ${new Date(c.lease.expires).toLocaleTimeString("ru-RU")}`),
    );
  }
  if (c.parent !== null) {
    host.append(el("div", "mono", `входит в  ${c.parent.id}  ${c.parent.title}`));
  }
  if (writeEnabled) {
    host.append(parentEditRow(id, c.parent, () => void fillCardLinks(host, id)));
  }
  if (c.progress !== null) {
    const tail = c.progress.cancelled > 0 ? `, отменено ${c.progress.cancelled}` : "";
    host.append(
      el("div", "mono", `состав  ${c.progress.done} из ${c.progress.total} закрыто${tail}`),
    );
    for (const child of c.children) {
      host.append(cardRefLine(childMark(child.status), child));
    }
  }
  if (c.blocked_by.length > 0) {
    host.append(el("div", "mono", `blocked-by ${c.blocked_by.map((r) => `${r.id} (${r.status})`).join(", ")}`));
  }
  if (c.blocks.length > 0) {
    host.append(el("div", "mono", `blocks ${c.blocks.map((r) => `${r.id} (${r.status})`).join(", ")}`));
  }
  for (const l of c.links) {
    host.append(el("div", "mono", `${l.type} ${l.id} — ${l.title}`));
  }
  if (c.tags.length > 0) {
    host.append(el("div", "mono", `теги ${c.tags.join(", ")}`));
  }
  // Слои и ОБЕ оси охвата — в каждой карточке, а не только в базе знаний:
  // оси независимы, и карточка не смеет показывать одну вместо другой.
  host.append(el("div", "mono", `слой L${c.layer} · ${reachLine(c)} · ${repoLine(c)}`));
  host.append(commentsSection(id, c.comments, () => void fillCardLinks(host, id)));
}

/** Охват сессии (S58) одной строкой: неизвестный показывается, не прячется. */
function reachLine(c: { reach: string; session: string }): string {
  if (c.reach === "project") return "охват project";
  if (c.reach === "session") {
    return `охват session ${c.session.length > 12 ? `${c.session.slice(0, 12)}…` : c.session || "без ключа"}`;
  }
  return "охват не записан";
}

/** Охват репозитория (S59) одной строкой — рядом с охватом сессии, не вместо. */
function repoLine(c: { repo: string; repo_state: string }): string {
  if (c.repo_state === "repo") return `repo ${c.repo}`;
  if (c.repo_state === "root") return "repo общий";
  return "repo не определён";
}

// ---------------------------------------------------------------------------
// Тема: авто (prefers-color-scheme) → светлая → тёмная
// ---------------------------------------------------------------------------

type Theme = "auto" | "light" | "dark";
const THEME_KEY = "myc.viz.theme";

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  $("theme").textContent = theme === "auto" ? "авто" : theme === "light" ? "светлая" : "тёмная";
}

function initTheme(): void {
  let theme: Theme = "auto";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark" || saved === "auto") theme = saved;
  } catch {
    // приватное окно — остаёмся на системной теме
  }
  applyTheme(theme);
  $("theme").addEventListener("click", () => {
    theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // не смогли запомнить — не беда, тема применилась
    }
    graph.invalidateColors();
  });
  // Смена системной темы при theme=auto обязана перекрасить и канву:
  // цвета узлов читаются из CSS-переменных, а не зашиты в скрипт.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    graph.invalidateColors();
  });
}

// ---------------------------------------------------------------------------
// Граф
// ---------------------------------------------------------------------------

const KINDS = [
  "task",
  "note",
  "doc",
  "fragment",
  "session",
  "message",
  "entity",
  "anchor",
  "skill",
] as const;

/** Толщина ребра по типу связи: структурные — толще, ссылочные — волосок. */
const EDGE_WEIGHT: Record<string, number> = {
  blocks: 2.2,
  parent: 1.8,
  supersedes: 1.8,
  contradicts: 2.0,
  duplicates: 1.3,
  derived_from: 1.2,
  evidence: 1.2,
  touches: 1.0,
  replies_to: 0.9,
  relates: 0.7,
  mentions: 0.6,
};

/** Оговорка на чипе; вынесена, чтобы тест сверял ровно ту строку, что видна. */
const UNTRUSTED_TIMING = "времена недостоверны: вкладка была в фоне";
const UNTRUSTED_TIMING_HINT =
  "Вкладка была скрыта во время замера. Chrome не вызывает requestAnimationFrame " +
  "в фоновой вкладке и прижимает таймеры к секунде, поэтому эти миллисекунды " +
  "меряют время до возвращения на вкладку, а не работу интерфейса. " +
  "Для честного числа откройте страницу активной вкладкой и обновите её.";

interface WorkerFrame {
  type: "seed" | "tick" | "done";
  generation: number;
  positions: Float32Array;
  iter?: number;
  total?: number;
  ms?: number;
}

class GraphView {
  private canvas = $<HTMLCanvasElement>("canvas");
  private ctx = this.canvas.getContext("2d", { alpha: false })!;
  private worker: Worker | undefined;
  private data: GraphPayload | undefined;
  private pos: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private colors = new Map<string, string>();
  private edgeColor = "rgba(0,0,0,.2)";
  private edgeHot = "rgba(0,0,0,.6)";
  private bg = "#fff";
  private fg = "#000";
  private hidden = new Set<string>();
  private tx = 0;
  private ty = 0;
  private scale = 1;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private raf = 0;
  private hover = -1;
  private selected = -1;
  private matches = new Set<number>();
  private query = "";
  private showEdges = true;
  private showLabels = false;
  /** Пользователь трогал вид — значит, авто-вписывание больше не лезет. */
  private userMoved = false;
  private firstFrameMs = 0;
  private layoutMs = 0;
  private layoutIter = 0;
  /** Времена этого прогона сняты при активной вкладке — см. `tabWasHidden`. */
  private timingTrusted = true;
  private ready = false;

  mount(): void {
    this.readColors();
    window.addEventListener("resize", () => this.resize());
    this.bindPointer();
    $("graph-fit").addEventListener("click", () => {
      this.userMoved = false;
      this.fit();
    });
    $("graph-relayout").addEventListener("click", () => {
      this.userMoved = false;
      this.startLayout();
    });
    $<HTMLInputElement>("graph-edges").addEventListener("change", (e) => {
      this.showEdges = (e.target as HTMLInputElement).checked;
      this.draw();
    });
    $<HTMLInputElement>("graph-labels").addEventListener("change", (e) => {
      this.showLabels = (e.target as HTMLInputElement).checked;
      this.draw();
    });
    $<HTMLInputElement>("graph-search").addEventListener("input", (e) => {
      this.search((e.target as HTMLInputElement).value);
    });
    this.resize();
  }

  /** Палитра живёт в CSS — здесь она только считывается, чтобы обе темы
   *  красили канву тем же, чем красят легенду. */
  private readColors(): void {
    const cs = getComputedStyle(document.documentElement);
    this.colors.clear();
    for (const k of KINDS) this.colors.set(k, cs.getPropertyValue(`--kind-${k}`).trim() || "#888");
    this.colors.set("other", cs.getPropertyValue("--kind-other").trim() || "#888");
    this.edgeColor = cs.getPropertyValue("--edge").trim() || "rgba(0,0,0,.2)";
    this.edgeHot = cs.getPropertyValue("--edge-hot").trim() || "rgba(0,0,0,.6)";
    this.bg = cs.getPropertyValue("--bg").trim() || "#fff";
    this.fg = cs.getPropertyValue("--fg").trim() || "#000";
  }

  invalidateColors(): void {
    this.readColors();
    this.renderLegend();
    this.draw();
  }

  private color(kind: string): string {
    return this.colors.get(kind) ?? this.colors.get("other")!;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.draw();
  }

  async load(): Promise<void> {
    const payload = await api<GraphPayload>("/api/graph");
    this.data = payload;
    this.hidden.clear();
    this.renderLegend();
    const stat = $("graph-stat");
    stat.replaceChildren();
    stat.append(
      el("b", undefined, fmtInt(payload.total_nodes)),
      document.createTextNode(" узлов · "),
      el("b", undefined, fmtInt(payload.total_edges)),
      document.createTextNode(` рёбер · выборка ${payload.took_ms} мс`),
    );
    if (payload.truncated) {
      stat.append(document.createTextNode(` · показаны top-${fmtInt(payload.nodes.length)} по степени`));
    }

    if (payload.nodes.length === 0) {
      emptyState(
        $("graph-empty"),
        "Граф пуст",
        "В базе ещё нет узлов. Просмотрщик открыт только на чтение и ничего не создаёт — заведите первый узел через CLI, страница подхватит его при обновлении.",
        'myc task "первая задача"',
      );
      $("graph-layout").textContent = "лэйаут: не нужен";
      this.pos = new Float32Array(0);
      this.ready = true;
      this.draw();
      return;
    }
    $("graph-empty").hidden = true;
    this.startLayout();
  }

  private startLayout(): void {
    const data = this.data;
    if (data === undefined || data.nodes.length === 0) return;
    this.worker?.terminate();
    const n = data.nodes.length;
    const kindIndex = new Map<string, number>();
    KINDS.forEach((k, i) => kindIndex.set(k, i));
    const kinds = new Uint8Array(n);
    const deg = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const node = data.nodes[i]!;
      kinds[i] = kindIndex.get(node.kind) ?? KINDS.length;
      deg[i] = Math.min(65535, node.deg);
    }
    const edges = new Int32Array(data.edges.length * 2);
    for (let i = 0; i < data.edges.length; i++) {
      const e = data.edges[i]!;
      edges[i * 2] = e.s;
      edges[i * 2 + 1] = e.d;
    }

    this.worker = new Worker("/layout.worker.js", { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<WorkerFrame>) => this.onFrame(ev.data);
    this.worker.onerror = () => toast("воркер лэйаута не запустился — граф остаётся на засеве");
    $("graph-layout").textContent = "лэйаут: засев…";
    this.worker.postMessage(
      {
        type: "layout",
        n,
        kinds,
        kindCount: KINDS.length + 1,
        deg,
        edges,
        // 25k — потолок локального счёта (решение S18); выше сервер и не отдаст.
        iterations: n > 12000 ? 140 : n > 4000 ? 200 : 300,
      },
      [kinds.buffer, deg.buffer, edges.buffer],
    );
  }

  private onFrame(frame: WorkerFrame): void {
    this.pos = frame.positions;
    this.layoutIter = frame.iter ?? 0;
    this.layoutMs = frame.ms ?? 0;
    // Доверие латчится по кадрам, а не по флагу на момент показа: кадры идут
    // всё время замера, поэтому «вкладку прятали, пока мы мерили» ловится
    // ровно в окне замера, а уход в фон после `done` числа уже не портит.
    if (tabWasHidden) this.timingTrusted = false;
    if (frame.type === "seed") {
      this.fit(false);
      this.ready = true;
      this.draw();
      // Первый кадр меряем от старта страницы до фактической отрисовки —
      // это и есть число из приёмки.
      requestAnimationFrame(() => {
        if (this.firstFrameMs === 0) {
          this.firstFrameMs = Math.round(performance.now() - BOOT_T0);
          if (tabWasHidden) this.timingTrusted = false;
          this.updateLayoutChip("засев");
        }
      });
      return;
    }
    // Пока вид не трогали руками, держим граф вписанным: силы за 200
    // итераций уводят его далеко за первый кадр, и без этого половина
    // узлов уезжает за край.
    if (!this.userMoved) this.fit(false);
    this.draw();
    this.updateLayoutChip(frame.type === "done" ? "готов" : "уточняется");
  }

  /**
   * Числа на чипе — измерения, и они обязаны говорить, когда мерить было
   * нечем. Прятать их в фоне нельзя: по ним же проверяют бюджет, а вкладка
   * может так и не стать активной. Поэтому число остаётся на виду с прямой
   * оговоркой — это честнее, чем показать 7043 мс как настоящие.
   */
  private updateLayoutChip(phase: string): void {
    const total = this.data?.nodes.length ?? 0;
    const parts = [`лэйаут: ${phase}`];
    if (this.layoutIter > 0) parts.push(`${this.layoutIter} итераций`);
    parts.push(`${this.layoutMs} мс на ${fmtInt(total)} узлов`);
    if (this.firstFrameMs > 0) parts.push(`первый кадр ${this.firstFrameMs} мс`);
    if (!this.timingTrusted) parts.push(UNTRUSTED_TIMING);
    const chip = $("graph-layout");
    chip.textContent = parts.join(" · ");
    if (this.timingTrusted) {
      delete chip.dataset["trust"];
      chip.removeAttribute("title");
    } else {
      chip.dataset["trust"] = "low";
      chip.title = UNTRUSTED_TIMING_HINT;
    }
  }

  private renderLegend(): void {
    const host = $("legend");
    host.replaceChildren();
    const data = this.data;
    if (data === undefined) return;
    const counts = new Map<string, number>();
    for (const node of data.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [kind, n] of sorted) {
      const item = el("span", "legend-item");
      if (this.hidden.has(kind)) item.classList.add("off");
      const swatch = el("i");
      swatch.style.background = this.color(kind);
      item.append(swatch, document.createTextNode(`${kind} ${fmtInt(n)}`));
      item.addEventListener("click", () => {
        if (this.hidden.has(kind)) this.hidden.delete(kind);
        else this.hidden.add(kind);
        item.classList.toggle("off");
        this.draw();
      });
      host.append(item);
    }
  }

  private fit(redraw = true): void {
    const n = this.pos.length >>> 1;
    if (n === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = this.pos[i * 2]!;
      const y = this.pos[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const pad = 40;
    const sx = (this.w - pad * 2) / Math.max(1, maxX - minX);
    const sy = (this.h - pad * 2) / Math.max(1, maxY - minY);
    this.scale = Math.min(sx, sy, 4);
    this.tx = this.w / 2 - ((minX + maxX) / 2) * this.scale;
    this.ty = this.h / 2 - ((minY + maxY) / 2) * this.scale;
    if (redraw) this.draw();
  }

  private draw(): void {
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  /**
   * Один проход по рёбрам (сгруппированные в путь по толщине) и один по
   * узлам (сгруппированные в путь по цвету). Никаких DOM-объектов на узел:
   * 10k <circle> в SVG — это десятки тысяч элементов и мёртвый пан.
   */
  private paint(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    const data = this.data;
    if (data === undefined || !this.ready || this.pos.length === 0) return;

    const nodes = data.nodes;
    const n = nodes.length;
    const s = this.scale;
    const tx = this.tx;
    const ty = this.ty;
    const visible = (i: number): boolean => !this.hidden.has(nodes[i]!.kind);

    if (this.showEdges && data.edges.length > 0) {
      const byWeight = new Map<number, Path2D>();
      let drawn = 0;
      for (const e of data.edges) {
        if (!visible(e.s) || !visible(e.d)) continue;
        const w = EDGE_WEIGHT[e.t] ?? 0.8;
        let path = byWeight.get(w);
        if (path === undefined) {
          path = new Path2D();
          byWeight.set(w, path);
        }
        path.moveTo(this.pos[e.s * 2]! * s + tx, this.pos[e.s * 2 + 1]! * s + ty);
        path.lineTo(this.pos[e.d * 2]! * s + tx, this.pos[e.d * 2 + 1]! * s + ty);
        drawn++;
      }
      // 30k линий на экране складываются в белый войлок, из-за которого не
      // видно узлов. Гасим их тем сильнее, чем их больше: связи остаются
      // читаемым фоном, а не главным содержимым кадра.
      ctx.save();
      ctx.globalAlpha = Math.max(0.12, Math.min(1, 2500 / Math.max(1, drawn)));
      ctx.strokeStyle = this.edgeColor;
      for (const [w, path] of byWeight) {
        ctx.lineWidth = Math.max(0.35, w * Math.min(1, s * 1.4));
        ctx.stroke(path);
      }
      ctx.restore();
    }

    const r = Math.max(1.1, Math.min(5.5, 1.4 + s * 1.1));
    const byColor = new Map<string, Path2D>();
    for (let i = 0; i < n; i++) {
      if (!visible(i)) continue;
      const x = this.pos[i * 2]! * s + tx;
      const y = this.pos[i * 2 + 1]! * s + ty;
      if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
      const node = nodes[i]!;
      const c = this.color(node.kind);
      let path = byColor.get(c);
      if (path === undefined) {
        path = new Path2D();
        byColor.set(c, path);
      }
      const rr = r * (1 + Math.min(1.6, node.deg / 14));
      path.moveTo(x + rr, y);
      path.arc(x, y, rr, 0, Math.PI * 2);
    }
    for (const [c, path] of byColor) {
      ctx.fillStyle = c;
      ctx.fill(path);
    }

    if (this.matches.size > 0) {
      ctx.strokeStyle = this.edgeHot;
      ctx.lineWidth = 2;
      const ring = new Path2D();
      for (const i of this.matches) {
        if (!visible(i)) continue;
        const x = this.pos[i * 2]! * s + tx;
        const y = this.pos[i * 2 + 1]! * s + ty;
        ring.moveTo(x + r + 4, y);
        ring.arc(x, y, r + 4, 0, Math.PI * 2);
      }
      ctx.stroke(ring);
    }

    for (const i of [this.hover, this.selected]) {
      if (i < 0 || i >= n || !visible(i)) continue;
      const x = this.pos[i * 2]! * s + tx;
      const y = this.pos[i * 2 + 1]! * s + ty;
      ctx.strokeStyle = this.fg;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.showLabels && s > 0.5) {
      ctx.fillStyle = this.fg;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      let drawn = 0;
      for (let i = 0; i < n && drawn < 400; i++) {
        if (!visible(i)) continue;
        const node = nodes[i]!;
        if (node.deg < 2 && s < 1.4) continue;
        const x = this.pos[i * 2]! * s + tx;
        const y = this.pos[i * 2 + 1]! * s + ty;
        if (x < 0 || y < 0 || x > this.w || y > this.h) continue;
        const label = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title;
        ctx.fillText(label || node.id, x, y - r - 5);
        drawn++;
      }
      ctx.textAlign = "start";
    }
  }

  private pick(cx: number, cy: number): number {
    const data = this.data;
    if (data === undefined || this.pos.length === 0) return -1;
    const s = this.scale;
    const tol = 9;
    let best = -1;
    let bestD = tol * tol;
    for (let i = 0; i < data.nodes.length; i++) {
      if (this.hidden.has(data.nodes[i]!.kind)) continue;
      const dx = this.pos[i * 2]! * s + this.tx - cx;
      const dy = this.pos[i * 2 + 1]! * s + this.ty - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private bindPointer(): void {
    const c = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;

    c.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      c.classList.add("dragging");
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointerup", (e) => {
      dragging = false;
      c.classList.remove("dragging");
      c.releasePointerCapture(e.pointerId);
      if (moved < 4) {
        const rect = c.getBoundingClientRect();
        const i = this.pick(e.clientX - rect.left, e.clientY - rect.top);
        this.selected = i;
        this.showCard(i);
        this.draw();
      }
    });
    c.addEventListener("pointermove", (e) => {
      const rect = c.getBoundingClientRect();
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 4) this.userMoved = true;
        this.tx += dx;
        this.ty += dy;
        lastX = e.clientX;
        lastY = e.clientY;
        this.draw();
        return;
      }
      const i = this.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (i !== this.hover) {
        this.hover = i;
        this.showTooltip(i, e.clientX - rect.left, e.clientY - rect.top);
        this.draw();
      }
    });
    c.addEventListener("pointerleave", () => {
      this.hover = -1;
      $("tooltip").hidden = true;
      this.draw();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        this.userMoved = true;
        const k = Math.exp(-e.deltaY * 0.0015);
        const next = Math.max(0.02, Math.min(30, this.scale * k));
        // Зум вокруг курсора: точка под мышью остаётся на месте.
        this.tx = mx - ((mx - this.tx) * next) / this.scale;
        this.ty = my - ((my - this.ty) * next) / this.scale;
        this.scale = next;
        this.draw();
      },
      { passive: false },
    );
  }

  private showTooltip(i: number, x: number, y: number): void {
    const tip = $("tooltip");
    const data = this.data;
    if (i < 0 || data === undefined) {
      tip.hidden = true;
      return;
    }
    const node = data.nodes[i]!;
    tip.replaceChildren();
    tip.append(
      el("div", undefined, node.title || "(без заголовка)"),
      el("div", "t-id", `${node.id} · ${node.kind} · ${node.status} · связей ${node.deg}`),
    );
    tip.style.left = `${Math.min(x + 14, this.w - 350)}px`;
    tip.style.top = `${Math.min(y + 14, this.h - 70)}px`;
    tip.hidden = false;
  }

  private showCard(i: number): void {
    const card = $("node-card");
    const data = this.data;
    if (i < 0 || data === undefined) {
      card.hidden = true;
      return;
    }
    const node: GraphNode = data.nodes[i]!;
    card.replaceChildren();
    const close = el("button", "close", "×");
    close.addEventListener("click", () => {
      card.hidden = true;
      this.selected = -1;
      this.draw();
    });
    const dl = el("dl", "kv");
    const rows: [string, string][] = [
      ["id", node.id],
      ["вид", node.kind],
      ["статус", node.status],
      ["слой", `L${node.layer}`],
      ["приоритет", `P${node.priority}`],
      ["связей", String(node.deg)],
      ["обновлён", `${fmtAge(Date.now() - node.updated_at)} назад`],
    ];
    for (const [k, v] of rows) {
      dl.append(el("dt", undefined, k), el("dd", undefined, v));
    }
    card.append(close, el("h3", undefined, node.title || node.id), dl);

    // Операции полного цикла: карточка обслуживает и взятую, и закрытую
    // задачу — очередь ready показывает только открытые, поэтому «отпустить»
    // и «вернуть» для всего остального живут здесь.
    let live: HTMLElement | undefined;
    if (writeEnabled) {
      live = el("div", "card-live");
      const refresh = (): void => {
        if (live !== undefined) void fillCardLinks(live, node.id);
      };
      card.append(opBar(node.id, ["claim", "release", "close", "reopen", "cancel"], refresh));
      card.append(live);
    } else {
      live = el("div", "card-live");
      card.append(live);
    }
    void fillCardLinks(live, node.id);

    // Правка свойств — тем же общим компонентом, что и везде: карточка не
    // отращивает свой. Статуса в нём нет: он зарабатывается операциями.
    if (writeEnabled) {
      const root = el("div", "props-host");
      const toggle = el("button", "rbtn props-toggle", "править свойства");
      toggle.addEventListener("click", () => {
        const open = root.classList.toggle("open");
        if (open) {
          // панель сама перечитывает узел после записи; полный перерасчёт
          // лэйаута графа на каждую правку не нужен
          root.append(nodePropsEditor(node.id));
          toggle.textContent = "закрыть правку";
        } else {
          root.replaceChildren();
          toggle.textContent = "править свойства";
        }
      });
      card.append(toggle, root);
    }
    card.hidden = false;
  }

  private search(query: string): void {
    this.query = query.trim().toLowerCase();
    this.matches.clear();
    const data = this.data;
    if (data !== undefined && this.query.length > 0) {
      for (let i = 0; i < data.nodes.length; i++) {
        const node = data.nodes[i]!;
        if (
          node.id.toLowerCase().includes(this.query) ||
          node.title.toLowerCase().includes(this.query)
        ) {
          this.matches.add(i);
        }
      }
    }
    $("graph-hint").textContent =
      this.query.length > 0
        ? `совпадений: ${this.matches.size}`
        : "колесо — зум, перетаскивание — панорама, клик по узлу — карточка";
    this.draw();
  }
}

const graph = new GraphView();

// ---------------------------------------------------------------------------
// Очередь ready
// ---------------------------------------------------------------------------

function renderReadyRow(row: ReadyRow): HTMLElement {
  const box = el("div", "rrow");
  const top = el("div", "rrow-top");
  top.append(
    el("span", "rid", row.id),
    el("span", `badge p${row.priority}`, `P${row.priority}`),
    el("span", "badge", row.type),
    el("span", "rtitle", row.title || "(без заголовка)"),
    el("span", "badge", row.assignee.length > 0 ? `@${row.assignee}` : "free"),
    el("span", "rscore", row.score.toFixed(2)),
  );
  box.append(top);

  const total = row.terms.reduce((s, t) => s + t.value, 0) || 1;
  const bar = el("div", "bar-terms");
  for (const t of row.terms) {
    const seg = el("i", `t-${t.key}`);
    seg.style.width = `${(t.value / total) * 100}%`;
    seg.title = `${t.label}: ${t.weight.toFixed(2)} × ${t.norm.toFixed(2)} = ${t.value.toFixed(2)}`;
    bar.append(seg);
  }
  box.append(bar);

  // Слагаемые числами: вес × норма = вклад, и сумма вкладов равна score.
  const terms = el("div", "terms");
  for (const t of row.terms) {
    const item = el("span", "term");
    const swatch = el("i", `t-${t.key}`);
    item.append(
      swatch,
      document.createTextNode(`${t.label} `),
      el("span", "mul", `${t.weight.toFixed(2)}×${t.norm.toFixed(2)}=`),
      el("span", "num", t.value.toFixed(2)),
    );
    terms.append(item);
  }
  const sum = el("span", "term");
  sum.append(
    el("span", "mul", "сумма = "),
    el("span", "num", row.score.toFixed(2)),
  );
  terms.append(sum);
  box.append(terms);
  if (writeEnabled) box.append(readyActions(row));
  return box;
}

/**
 * Действия над задачей — ОПЕРАЦИИ, а не выбор статуса из списка.
 *
 * Выпадающий список статусов здесь был бы враньём интерфейса: «в работе»
 * берётся арендой, «заблокирована» считается из блокеров, «закрыта» требует
 * причины (S54). Кнопка называет то, что действительно произойдёт, а сервер
 * отказывает, если это сейчас невозможно.
 *
 * Один бар на все экраны: очередь ready и карточка графа встраивают его,
 * а не отращивают свои. Набор кнопок разный — у ready открыты только
 * открытые задачи, карточка обслуживает полный цикл, включая reopen.
 */
const OP_LABELS: readonly (readonly [string, string, boolean])[] = [
  ["взять", "claim", false],
  ["отпустить", "release", false],
  ["закрыть", "close", true],
  ["вернуть", "reopen", true],
  ["отменить", "cancel", true],
];

const LEASE_MINUTES = [30, 60, 120, 240] as const;

function opBar(id: string, ops: readonly string[], onDone: () => void): HTMLElement {
  const bar = el("div", "ractions");
  const reasonBox = el("div", "rreason");
  reasonBox.hidden = true;
  const reason = el("input", "rreason-input");
  reason.setAttribute("placeholder", "причина — её прочитают следующие сессии");
  const confirm = el("button", "rbtn primary", "подтвердить");
  const cancelBtn = el("button", "rbtn", "не надо");
  reasonBox.append(reason, confirm, cancelBtn);

  const send = async (body: Record<string, unknown>): Promise<void> => {
    if (await mutate(`/api/nodes/${encodeURIComponent(id)}/op`, body)) onDone();
  };

  // Аренда «взять» — выбором из разумных, а не ручным вводом: сервер всё
  // равно проверяет границы (5–480 минут), отказ читается в тосте.
  const lease = el("select", "rlease") as HTMLSelectElement;
  for (const m of LEASE_MINUTES) {
    const o = el("option", undefined, `${m}m`);
    o.setAttribute("value", String(m));
    if (m === 30) o.setAttribute("selected", "selected");
    lease.append(o);
  }

  const opButton = (label: string, op: string, needsReason = false): HTMLElement => {
    const b = el("button", "rbtn", label);
    b.addEventListener("click", () => {
      if (!needsReason) {
        void send(op === "claim" ? { op, lease_minutes: Number(lease.value) } : { op });
        return;
      }
      reasonBox.hidden = false;
      reason.value = "";
      reason.focus();
      confirm.onclick = () => {
        const text = reason.value.trim();
        if (text.length === 0) {
          toast(`${op}: без причины нельзя — её читают, когда возвращаются к задаче`);
          return;
        }
        reasonBox.hidden = true;
        void send({ op, reason: text });
      };
    });
    return b;
  };

  cancelBtn.addEventListener("click", () => {
    reasonBox.hidden = true;
  });

  for (const [label, op, needsReason] of OP_LABELS) {
    if (ops.includes(op)) bar.append(opButton(label, op, needsReason));
  }
  if (ops.includes("claim")) bar.append(lease);

  const box = el("div", "ractions-box");
  box.append(bar, reasonBox);
  return box;
}

/** Бар очереди ready: те же операции, что были, плюс приоритет из компонента. */
function readyActions(row: ReadyRow): HTMLElement {
  const bar = opBar(row.id, ["claim", "release", "close", "cancel"], () => void loadReady());
  const bar2 = bar.querySelector(".ractions") as HTMLElement;
  // Приоритет — из общего компонента правки, а не свой селектор: одна
  // реализация записи (POST с часами поля), один набор значений P0–P3.
  bar2.append(prioritySelect(row.priority, row.id, () => void loadReady()));
  return bar;
}

// ---------------------------------------------------------------------------
// Доска задач (W4)
//
// Колонки не выбор из списка, а то же самое правило S54, что у opBar: карточку
// нельзя перетащить КУДА УГОДНО. blocked вычисляется из зависимостей и
// in_progress зарабатывается арендой — перетаскивание в них отклоняется здесь
// же, БЕЗ обращения к серверу, тем же текстом, что объяснил бы сервер. closed
// и cancelled требуют причины и показывают, что освободится — тот же принцип,
// что trg_st_close считает их терминальными одинаково (S54).
// ---------------------------------------------------------------------------

interface BoardDropRejected {
  readonly allowed: false;
  readonly reason: string;
}
interface BoardDropAllowed {
  readonly allowed: true;
  readonly op: "close" | "cancel" | "reopen";
}

/** Единственное место, где «куда бросили карточку» превращается в решение. */
function boardDropDecision(column: BoardColumn): BoardDropRejected | BoardDropAllowed {
  switch (column) {
    case "blocked":
      return {
        allowed: false,
        reason: "blocked вычисляется из зависимостей — задачу блокируют они, а не перетаскивание",
      };
    case "in_progress":
      return {
        allowed: false,
        reason: "in_progress зарабатывается арендой — возьмите задачу кнопкой «взять», не перетаскиванием",
      };
    case "closed":
      return { allowed: true, op: "close" };
    case "cancelled":
      return { allowed: true, op: "cancel" };
    case "open":
      return { allowed: true, op: "reopen" };
  }
}

const BOARD_COLUMNS: readonly { key: BoardColumn; label: string }[] = [
  { key: "open", label: "Открыто" },
  { key: "blocked", label: "Заблокировано" },
  { key: "in_progress", label: "В работе" },
  { key: "closed", label: "Закрыто" },
  { key: "cancelled", label: "Отменено" },
];

let boardDragId: string | null = null;
let boardDragFrom: BoardColumn | null = null;

/**
 * Диалог close/cancel/reopen: причина обязательна, а для close/cancel —
 * поимённый список задач, которые освободятся (S54 требует их показывать
 * ДО подтверждения, а не постфактум). trg_st_close считает closed и
 * cancelled терминальными одинаково, поэтому предпросмотр общий для обоих.
 */
async function showBoardDialog(id: string, op: "close" | "cancel" | "reopen"): Promise<void> {
  const modal = $("board-modal");
  const title = $("board-modal-title");
  const released = $("board-modal-released");
  const reasonInput = $("board-modal-reason") as HTMLInputElement;
  const confirmBtn = $("board-modal-confirm") as HTMLButtonElement;
  const cancelBtn = $("board-modal-cancel") as HTMLButtonElement;

  const OP_TITLE: Record<typeof op, string> = {
    close: `закрыть ${id}`,
    cancel: `отменить ${id}`,
    reopen: `вернуть в открытые ${id}`,
  };
  title.textContent = OP_TITLE[op];
  reasonInput.value = "";
  released.replaceChildren();

  if (op === "close" || op === "cancel") {
    try {
      const preview = await api<{ released: readonly CardRef[] }>(
        `/api/nodes/${encodeURIComponent(id)}/release-preview`,
      );
      released.append(
        el(
          "div",
          "modal-hint",
          preview.released.length === 0
            ? "ничего не освобождает"
            : `освободит из blocked (${preview.released.length}):`,
        ),
      );
      for (const r of preview.released) {
        released.append(el("div", "modal-row", `${r.id} · ${r.title}`));
      }
    } catch (error) {
      released.append(el("div", "modal-hint", error instanceof Error ? error.message : String(error)));
    }
  }

  modal.hidden = false;
  reasonInput.focus();

  await new Promise<void>((resolve) => {
    const close = (): void => {
      modal.hidden = true;
      resolve();
    };
    cancelBtn.onclick = close;
    confirmBtn.onclick = () => {
      const reason = reasonInput.value.trim();
      if (reason.length === 0) {
        toast(`${op}: без причины нельзя — её читают, когда возвращаются к задаче`);
        return;
      }
      void (async () => {
        if (await mutate(`/api/nodes/${encodeURIComponent(id)}/op`, { op, reason })) {
          close();
          await loadBoard();
        }
      })();
    };
  });
}

async function handleBoardDrop(id: string, column: BoardColumn): Promise<void> {
  const decision = boardDropDecision(column);
  if (!decision.allowed) {
    toast(decision.reason);
    return;
  }
  await showBoardDialog(id, decision.op);
}

function boardCard(row: BoardRow, column: BoardColumn): HTMLElement {
  const c = el("div", "board-card");
  c.setAttribute("draggable", writeEnabled ? "true" : "false");
  c.dataset["id"] = row.id;
  c.dataset["column"] = column;
  c.append(
    el("span", "rid", row.id),
    el("span", `badge p${row.priority}`, `P${row.priority}`),
    el("span", "badge", row.type),
    el("span", "rtitle", row.title || "(без заголовка)"),
  );
  if (row.assignee.length > 0) c.append(el("span", "badge", `@${row.assignee}`));
  // Вложенность (W5): задача внутри эпика показывает, куда входит; эпик
  // показывает состав. Прогресс считает СЕРВЕР и считает закрытыми — та же
  // арифметика, что у card.ts и `myc show` (S54): отменённые отдельно.
  if (row.parent !== undefined) {
    c.classList.add("has-parent");
    c.append(el("span", "board-parent", `↳ ${row.parent.title}`));
  }
  if (row.progress !== undefined) {
    const p = row.progress;
    const tail = p.cancelled > 0 ? `, отменено ${p.cancelled}` : "";
    c.append(el("span", "board-progress", `${p.done}/${p.total}${tail}`));
  }
  return c;
}

function boardColumn(key: BoardColumn, label: string, rows: readonly BoardRow[]): HTMLElement {
  const col = el("div", `board-col board-col-${key}`);
  col.dataset["column"] = key;
  const head = el("div", "board-col-head");
  head.append(el("h3", undefined, label), el("span", "badge", String(rows.length)));
  col.append(head);
  const body = el("div", "board-col-body");
  for (const row of rows) body.append(boardCard(row, key));
  col.append(body);
  return col;
}

/**
 * Слушатели — ОДИН раз на статичный контейнер `board-cols`, а не на каждую
 * карточку: карточки перерисовываются при каждом `loadBoard()`, и вешать им
 * новые слушатели заново значило бы копить утечки. Делегирование через
 * `closest` — тот же приём, что у переключения вкладок в `main()`.
 */
let boardBound = false;
function bindBoardEvents(): void {
  if (boardBound) return;
  boardBound = true;
  const host = $("board-cols");
  host.addEventListener("dragstart", (e: Event) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".board-card");
    if (card === null) return;
    boardDragId = card.dataset["id"] ?? null;
    boardDragFrom = (card.dataset["column"] as BoardColumn | undefined) ?? null;
  });
  host.addEventListener("dragend", () => {
    boardDragId = null;
    boardDragFrom = null;
  });
  host.addEventListener("dragover", (e: Event) => {
    if ((e.target as HTMLElement).closest(".board-col") !== null) e.preventDefault();
  });
  host.addEventListener("drop", (e: Event) => {
    const col = (e.target as HTMLElement).closest<HTMLElement>(".board-col");
    if (col === null) return;
    e.preventDefault();
    const id = boardDragId;
    const from = boardDragFrom;
    boardDragId = null;
    boardDragFrom = null;
    const target = col.dataset["column"] as BoardColumn | undefined;
    if (id === null || target === undefined || target === from) return;
    void handleBoardDrop(id, target);
  });
}

async function loadBoard(): Promise<void> {
  bindBoardEvents();
  const payload = await api<BoardPayload>("/api/board");
  const host = $("board-cols");
  host.replaceChildren();
  for (const { key, label } of BOARD_COLUMNS) {
    host.append(boardColumn(key, label, payload.columns[key]));
  }
  $("board-sub").textContent = `собрано за ${payload.took_ms} мс`;
}

/**
 * Заведение задачи — та же POST /api/nodes, что у любого другого клиента:
 * `myc create` с соответствующими флагами. Тип выбирается при создании:
 * task/bug/epic/chore — это attrs.type у kind=task, а не разные виды ядра,
 * и селектор не изображает обратное.
 *
 * Пустые поля НЕ отправляются вовсе, а не пустыми строками: «оценки нет» —
 * это отсутствие флага у CLI, и правка не должна отличаться от команды,
 * которую человек ввёл бы сам.
 */
const TASK_TYPES = ["task", "bug", "epic", "chore"] as const;

function renderTaskNew(): void {
  const host = $("task-new");
  if (!writeEnabled) {
    host.replaceChildren();
    host.hidden = true;
    return;
  }
  const form = el("div", "task-new-form");
  form.hidden = true;

  const title = el("input", "props-input") as HTMLInputElement;
  title.setAttribute("placeholder", "заголовок — о чём задача");
  const type = el("select", "props-input") as HTMLSelectElement;
  for (const t of TASK_TYPES) {
    const o = el("option", undefined, t);
    o.setAttribute("value", t);
    if (t === "task") o.setAttribute("selected", "selected");
    type.append(o);
  }
  const body = el("textarea", "props-input props-body") as HTMLTextAreaElement;
  body.setAttribute("placeholder", "тело: описание, шаги, критерии готовности");
  const priority = el("select", "props-input") as HTMLSelectElement;
  const none = el("option", undefined, "приоритет по умолчанию");
  none.setAttribute("value", "");
  priority.append(none);
  for (const p of PRIORITIES) {
    const o = el("option", undefined, p);
    o.setAttribute("value", p);
    priority.append(o);
  }
  const tags = el("input", "props-input") as HTMLInputElement;
  tags.setAttribute("placeholder", "теги через запятую");
  const estimate = el("input", "props-input") as HTMLInputElement;
  estimate.setAttribute("placeholder", "оценка: 30m, 2h, 1d");
  const assignee = el("input", "props-input") as HTMLInputElement;
  assignee.setAttribute("placeholder", "исполнитель");
  const parent = el("input", "props-input") as HTMLInputElement;
  parent.setAttribute("placeholder", "id эпика, если задача входит в состав");

  const submit = el("button", "rbtn primary", "завести");
  submit.addEventListener("click", () => {
    void (async () => {
      const text = title.value.trim();
      if (text.length === 0) {
        toast("без заголовка нельзя: он виден в очереди, графе и myc list");
        return;
      }
      const fields: Record<string, unknown> = { title: text, kind: type.value };
      const bodyText = body.value;
      if (bodyText.length > 0) fields["body"] = bodyText;
      if (priority.value !== "") fields["priority"] = priority.value;
      const tagList = inputFromTags(tags.value);
      if (tagList.length > 0) fields["tags"] = tagList;
      const est = estimate.value.trim();
      if (est.length > 0) fields["estimate"] = est;
      const who = assignee.value.trim();
      if (who.length > 0) fields["assignee"] = who;
      const epic = parent.value.trim();
      if (epic.length > 0) fields["parent"] = epic;
      if (await mutate("/api/nodes", fields)) {
        toast("задача заведена тем же путём, что myc create");
        title.value = "";
        body.value = "";
        parent.value = "";
        await loadReady();
      }
    })();
  });

  const toggle = el("button", "rbtn task-new-toggle", "завести задачу");
  toggle.addEventListener("click", () => {
    const open = form.classList.toggle("open");
    form.hidden = !open;
    toggle.textContent = open ? "убрать форму" : "завести задачу";
    if (open) title.focus();
  });

  form.append(
    propsRow("заголовок", title),
    propsRow("тип", type),
    propsRow("тело", body),
    propsRow("приоритет", priority),
    propsRow("теги", tags),
    propsRow("оценка", estimate),
    propsRow("исполнитель", assignee),
    propsRow("входит в", parent),
    submit,
  );
  host.replaceChildren(toggle, form);
  host.hidden = false;
}

async function loadReady(): Promise<void> {
  renderTaskNew();
  const payload = await api<ReadyPayload>("/api/ready");
  const w = payload.weights;
  const formula = $("ready-formula");
  formula.replaceChildren();
  formula.append(
    document.createTextNode("score = "),
    el("b", undefined, w.priority.toFixed(2)),
    document.createTextNode("·приоритет + "),
    el("b", undefined, w.unblocks.toFixed(2)),
    document.createTextNode("·разблокирует + "),
    el("b", undefined, w.freshness.toFixed(2)),
    document.createTextNode("·свежесть + "),
    el("b", undefined, w.anchors.toFixed(2)),
    document.createTextNode("·якоря + "),
    el("b", undefined, w.type.toFixed(2)),
    document.createTextNode("·тип   (решение S21; веса из workspace.toml)"),
  );
  $("ready-sub").textContent =
    `${payload.ready} ready · ${payload.blocked} blocked · ${payload.in_progress} in_progress · ${payload.took_ms} мс`;

  const host = $("ready-rows");
  host.replaceChildren();
  if (payload.rows.length === 0) {
    host.hidden = true;
    formula.hidden = true;
    emptyState(
      $("ready-empty"),
      payload.blocked > 0 ? "Всё заблокировано" : "Очередь пуста",
      payload.blocked > 0
        ? `Открытых задач без блокеров нет, но ${payload.blocked} ждут разблокировки. Закройте блокер — задача появится здесь.`
        : "Нет открытых задач без блокеров. Как только появится первая, она встанет сюда вместе с разбором своей оценки.",
      'myc task "первая задача" --priority P1',
    );
    return;
  }
  host.hidden = false;
  formula.hidden = false;
  $("ready-empty").hidden = true;
  for (const row of payload.rows) host.append(renderReadyRow(row));
}

// ---------------------------------------------------------------------------
// База знаний: note, doc, fragment, entity, skill
// ---------------------------------------------------------------------------

/**
 * Всё, что не задача. Видов ядра девять, и здесь ровно пять из них: session,
 * message и anchor — служебные, у них свои экраны жизни. Как и везде,
 * интерфейс называет виды ЯДРА: memory и decision — это note с разными
 * attrs (decision показывается подтипом рядом с видом, а не отдельной
 * строкой легенды), epic и bug — задачи со своим экраном.
 *
 * ДВЕ ОСИ ОХВАТА показываются обе и не сводятся в одну (S58, S59): охват
 * сессии — «нужно ли это в другой крупной задаче», охват репозитория — «про
 * какую часть экосистемы». Заметка без охвата — обычное состояние базы:
 * помечается честно и считается в подвале, но из списка не прячется.
 */

const KB_KINDS = ["note", "doc", "fragment", "entity", "skill"] as const;
const KB_LAYERS = ["L0", "L1", "L2", "L3"] as const;

/** Фильтры экрана. Пустая строка = фильтра нет. */
const kbState = { kind: "", layer: "", reach: "", repo: "", q: "" };

/** Метка охвата сессии — те же слова, что печатает `myc prime` (S58). */
function kbReachMark(row: KbRow): HTMLElement {
  if (row.reach === "session") {
    const short = row.session.length > 12 ? `${row.session.slice(0, 12)}…` : row.session;
    return el("span", "kreach kreach-session", `[@сессия ${short || "без ключа"}]`);
  }
  if (row.reach === "project") return el("span", "kreach kreach-project", "[@проект]");
  // Не определён — не «спрятан»: метка честно говорит, что охвата нет.
  return el("span", "kreach kreach-unknown", "[@без охвата]");
}

/** Метка охвата репозитория — вторая ось, рядом с первой, а не вместо (S59). */
function kbRepoMark(row: KbRow): HTMLElement {
  if (row.repo_state === "repo") return el("span", "krepo", row.repo);
  if (row.repo_state === "root") return el("span", "krepo krepo-root", "все");
  const unknown = el("span", "krepo krepo-unknown", "repo?");
  unknown.title = "охват репозитория не определён: узел старше решения S59 или путь вывода неизвестен";
  return unknown;
}

function kbChip(label: string, on: boolean, onPick: () => void): HTMLElement {
  const chip = el("button", on ? "kchip on" : "kchip", label);
  chip.addEventListener("click", onPick);
  return chip;
}

function kbFilterGroup(label: string, host: HTMLElement): void {
  host.append(el("span", "kfilters-name", label));
}

/** Строка списка: метки обеих осей видны сразу, тело и связи — по раскрытию. */
function renderKbRow(row: KbRow): HTMLElement {
  const box = el("div", "krow");
  const top = el("div", "krow-top");
  top.append(
    el("span", "rid", row.id),
    el("span", "badge", row.subtype !== null ? `${row.subtype} (${row.kind})` : row.kind),
    el("span", "badge", `L${row.layer}`),
    el("span", "ktitle", row.title || "(без заголовка)"),
    kbReachMark(row),
    kbRepoMark(row),
    el("span", "kage", `${fmtAge(Date.now() - row.updated_at)} назад`),
  );
  box.append(top);

  const detail = el("div", "krow-detail");
  detail.hidden = true;
  top.addEventListener("click", () => {
    const open = detail.hidden;
    detail.hidden = !open;
    box.classList.toggle("open", open);
    if (open && detail.childElementCount === 0) void fillKbDetail(detail, row.id);
  });
  box.append(detail);
  return box;
}

/** Раскрытие строки: тело, связи и правка свойств — общий редактор без копий. */
async function fillKbDetail(host: HTMLElement, id: string): Promise<void> {
  let c: CardView;
  try {
    c = await api<CardView>(`/api/nodes/${encodeURIComponent(id)}/card`);
  } catch (e) {
    host.append(el("div", "props-error", `узел не прочитан: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }
  if (c.body.length > 0) {
    const pre = el("pre", "kbody");
    pre.textContent = c.body;
    host.append(pre);
  }
  const links = el("div", "klinks");
  if (c.parent !== null) links.append(el("div", "mono", `входит в ${c.parent.id} ${c.parent.title}`));
  for (const l of c.links) links.append(el("div", "mono", `${l.type} ${l.id} — ${l.title}`));
  if (c.tags.length > 0) links.append(el("div", "mono", `теги ${c.tags.join(", ")}`));
  links.append(el("div", "mono", `слой L${c.layer} · ${reachLine(c)} · ${repoLine(c)}`));
  host.append(links);
  host.append(nodePropsEditor(id, () => void loadKb()));
}

/** Подвал: счётчики по всей базе, а не по выборке — скрытое названо числом. */
function renderKbFooter(counts: KbCounts, host: HTMLElement): void {
  host.replaceChildren();
  const reach = el("span", "kfooter-group");
  reach.append(
    el("span", "kfooter-name", "охват сессии:"),
    el("span", undefined, ` проект ${counts.reach.project} · сессия ${counts.reach.session} · без охвата ${counts.reach.unknown}`),
  );
  const repo = el("span", "kfooter-group");
  const repoBits = [`все ${counts.repo.root}`, `не определён ${counts.repo.unknown}`];
  for (const r of counts.repo.by_repo) repoBits.push(`${r.key} ${r.n}`);
  repo.append(el("span", "kfooter-name", "охват репозитория:"), el("span", undefined, ` ${repoBits.join(" · ")}`));
  host.append(reach, repo);
}

function renderKbFilters(): void {
  const host = $("kb-filters");
  host.replaceChildren();

  kbFilterGroup("виды", host);
  host.append(kbChip("все", kbState.kind === "", () => { kbState.kind = ""; void loadKb(); }));
  for (const k of KB_KINDS) {
    host.append(kbChip(k, kbState.kind === k, () => { kbState.kind = k; void loadKb(); }));
  }

  kbFilterGroup("слои", host);
  host.append(kbChip("все", kbState.layer === "", () => { kbState.layer = ""; void loadKb(); }));
  for (const l of KB_LAYERS) {
    host.append(kbChip(l, kbState.layer === String(Number(l.slice(1))), () => {
      kbState.layer = kbState.layer === String(Number(l.slice(1))) ? "" : String(Number(l.slice(1)));
      void loadKb();
    }));
  }

  kbFilterGroup("охват сессии", host);
  for (const [label, value] of [["все", ""], ["проект", "project"], ["сессия", "session"], ["без охвата", "unknown"]] as const) {
    host.append(kbChip(label, kbState.reach === value, () => { kbState.reach = value; void loadKb(); }));
  }

  const search = el("input", "search ksearch") as HTMLInputElement;
  search.setAttribute("placeholder", "фильтр по заголовку, id и тегам");
  search.value = kbState.q;
  search.addEventListener("input", () => {
    kbState.q = search.value;
    void loadKb();
  });
  host.append(search);
}

/**
 * Заведение знания — теми же командами, что и в терминале, без своей ветки:
 * заметка идёт в `myc remember` (поэтому попадает в очередь embed+absorb и
 * в поиск наравне с терминальной), документ и скилл — в `myc create`.
 * fragment и entity формы не обходят: пути создания в CLI нет, и сервер
 * ответит громким отказом с причиной — интерфейс не изображает обратное.
 */
function renderKbNew(): void {
  const host = $("kb-new");
  if (!writeEnabled) {
    host.replaceChildren();
    host.hidden = true;
    return;
  }
  const form = el("div", "task-new-form");
  form.hidden = true;

  const title = el("input", "props-input") as HTMLInputElement;
  title.setAttribute("placeholder", "заголовок / суть факта");
  const kind = el("select", "props-input") as HTMLSelectElement;
  for (const k of KB_KINDS) {
    const o = el("option", undefined, k);
    o.setAttribute("value", k);
    if (k === "note") o.setAttribute("selected", "selected");
    kind.append(o);
  }
  const body = el("textarea", "props-input props-body") as HTMLTextAreaElement;
  body.setAttribute("placeholder", "тело: у заметки — развёрнутый факт под первой строкой");
  const tags = el("input", "props-input") as HTMLInputElement;
  tags.setAttribute("placeholder", "теги через запятую");
  const layer = el("select", "props-input") as HTMLSelectElement;
  const layerNone = el("option", undefined, "слой по умолчанию");
  layerNone.setAttribute("value", "");
  layer.append(layerNone);
  for (const l of KB_LAYERS) {
    const o = el("option", undefined, l);
    o.setAttribute("value", l);
    layer.append(o);
  }
  const acl = el("select", "props-input") as HTMLSelectElement;
  const aclNone = el("option", undefined, "доступ по умолчанию (team)");
  aclNone.setAttribute("value", "");
  acl.append(aclNone);
  for (const mode of ACL_MODES) {
    const o = el("option", undefined, mode);
    o.setAttribute("value", mode);
    acl.append(o);
  }
  const reach = el("select", "props-input") as HTMLSelectElement;
  const reachSession = el("option", undefined, "охват: сессия (по умолчанию)");
  reachSession.setAttribute("value", "");
  const reachProject = el("option", undefined, "охват: project — явное решение");
  reachProject.setAttribute("value", "project");
  reach.append(reachSession, reachProject);
  const source = el("input", "props-input") as HTMLInputElement;
  source.setAttribute("placeholder", "происхождение: url или файл (заметка)");
  const repo = el("input", "props-input") as HTMLInputElement;
  repo.setAttribute("placeholder", "охват репозитория, пусто — вывести из пути (doc/skill)");

  // Поля, которых у команды создания данного вида нет, скрываются, а не
  // рисуются серыми: интерфейс показывает ровно то, что движок примет.
  const syncKind = (): void => {
    const isNote = kind.value === "note";
    reach.hidden = !isNote;
    source.hidden = !isNote;
    layer.hidden = !isNote; // у myc create флага слоя нет — только remember
    repo.hidden = isNote; // у myc remember флага охвата репозитория нет
  };
  kind.addEventListener("change", syncKind);

  const submit = el("button", "rbtn primary", "завести");
  submit.addEventListener("click", () => {
    void (async () => {
      const text = title.value.trim();
      if (text.length === 0) {
        toast("без заголовка нельзя: он виден в списке, поиске и myc show");
        return;
      }
      const fields: Record<string, unknown> = { title: text, kind: kind.value };
      if (body.value.length > 0) fields["body"] = body.value;
      const tagList = inputFromTags(tags.value);
      if (tagList.length > 0) fields["tags"] = tagList;
      if (kind.value === "note") {
        if (layer.value !== "") fields["layer"] = layer.value;
        if (acl.value !== "") fields["acl"] = acl.value;
        if (reach.value !== "") fields["reach"] = reach.value;
        const src = source.value.trim();
        if (src.length > 0) fields["source"] = src;
      } else {
        if (acl.value !== "") fields["acl"] = acl.value;
        const r = repo.value.trim();
        if (r.length > 0) fields["repo"] = r;
      }
      if (await mutate("/api/nodes", fields)) {
        toast(
          kind.value === "note"
            ? "заметка заведена тем же путём, что myc remember: очередь embed+absorb и поиск"
            : `${kind.value} заведён тем же путём, что myc create`,
        );
        title.value = "";
        body.value = "";
        await loadKb();
      }
    })();
  });

  const toggle = el("button", "rbtn task-new-toggle", "завести знание");
  toggle.addEventListener("click", () => {
    const open = form.classList.toggle("open");
    form.hidden = !open;
    toggle.textContent = open ? "убрать форму" : "завести знание";
    if (open) title.focus();
  });

  form.append(
    propsRow("вид", kind),
    propsRow("заголовок", title),
    propsRow("тело", body),
    propsRow("теги", tags),
    propsRow("слой", layer),
    propsRow("доступ", acl),
    propsRow("охват сессии", reach),
    propsRow("происхождение", source),
    propsRow("охват репозитория", repo),
    submit,
  );
  syncKind();
  host.replaceChildren(toggle, form);
  host.hidden = false;
}

async function loadKb(): Promise<void> {
  renderKbNew();
  const params = new URLSearchParams();
  if (kbState.kind !== "") params.set("kind", kbState.kind);
  if (kbState.layer !== "") params.set("layer", kbState.layer);
  if (kbState.reach !== "") params.set("reach", kbState.reach);
  if (kbState.repo !== "") params.set("repo", kbState.repo);
  if (kbState.q.trim() !== "") params.set("q", kbState.q.trim());
  const qs = params.toString();
  const payload = await api<KbPayload>(`/api/kb${qs.length > 0 ? `?${qs}` : ""}`);

  $("kb-sub").textContent =
    `${payload.shown} из ${fmtInt(payload.total)} знаний · ${payload.took_ms} мс`;
  renderKbFilters();

  const host = $("kb-rows");
  host.replaceChildren();
  if (payload.rows.length === 0) {
    host.hidden = true;
    emptyState(
      $("kb-empty"),
      payload.total === 0 ? "База знаний пуста" : "Под фильтр ничего не попало",
      payload.total === 0
        ? "Знания записывают `myc remember`, агенты и эта страница — каждая заметка попадает в поиск и в absorb-очередь наравне с терминальной."
        : "Фильтр слишком узкий: сбросьте вид, слой или охват, чтобы увидеть остальное.",
      'myc remember "первый факт"',
    );
    renderKbFooter(payload.counts, $("kb-footer"));
    return;
  }
  host.hidden = false;
  $("kb-empty").hidden = true;
  for (const row of payload.rows) host.append(renderKbRow(row));
  renderKbFooter(payload.counts, $("kb-footer"));
}

// ---------------------------------------------------------------------------
// Таймлайн оплога
// ---------------------------------------------------------------------------

async function loadTimeline(): Promise<void> {
  const payload = await api<TimelinePayload>("/api/oplog?n=200");
  $("timeline-sub").textContent =
    `${fmtInt(payload.total)} записей всего · последняя seq ${payload.last_seq} · ${payload.took_ms} мс`;

  const rows = $("timeline-rows");
  const spark = $("timeline-spark");
  rows.replaceChildren();
  spark.replaceChildren();

  if (payload.rows.length === 0) {
    rows.hidden = true;
    spark.hidden = true;
    emptyState(
      $("timeline-empty"),
      "Оплог пуст",
      "Ни одной записи ещё не сделано. Оплог пополняется каждой записью CLI или агента — просмотрщик только читает его.",
      'myc remember "первый факт"',
    );
    return;
  }
  rows.hidden = false;
  spark.hidden = false;
  $("timeline-empty").hidden = true;

  // Гистограмма плотности: 40 корзин от первой до последней записи выборки.
  const times = payload.rows.map((r) => r.ts_ms);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const bins = new Array<number>(40).fill(0);
  const span = Math.max(1, max - min);
  for (const t of times) {
    const b = Math.min(39, Math.floor(((t - min) / span) * 40));
    bins[b] = (bins[b] ?? 0) + 1;
  }
  const peak = Math.max(1, ...bins);
  for (let i = 0; i < bins.length; i++) {
    const bar = el("i");
    bar.style.height = `${Math.max(4, ((bins[i] ?? 0) / peak) * 100)}%`;
    bar.title = `${bins[i] ?? 0} записей`;
    spark.append(bar);
  }

  let day = "";
  for (const r of payload.rows) {
    const d = fmtDay(r.ts_ms);
    if (d !== day) {
      day = d;
      rows.append(el("div", "oday", d));
    }
    const line = el("div", "orow");
    const what = el("span", "owhat");
    what.append(el("span", `op op-${r.op}`, r.op));
    what.append(document.createTextNode(` ${r.entity_id}`));
    if (r.field !== null) what.append(el("span", "ofield", ` .${r.field}`));
    if (r.title !== null && r.title.length > 0) {
      what.append(document.createTextNode(` — ${r.title}`));
    } else if (r.value !== null) {
      what.append(el("span", "oval", ` = ${r.value}`));
    }
    line.append(
      el("span", "oseq", `#${r.seq}`),
      el("span", "ots", fmtTime(r.ts_ms)),
      el("span", "oactor", r.actor.length > 0 ? r.actor : "—"),
      what,
    );
    rows.append(line);
  }
}

// ---------------------------------------------------------------------------
// Здоровье
// ---------------------------------------------------------------------------

function card(title: string, span = false): HTMLElement {
  const c = el("div", span ? "card span" : "card");
  c.append(el("h3", undefined, title));
  return c;
}

function kv(host: HTMLElement, key: string, value: string): void {
  const row = el("div", "row");
  row.append(el("span", undefined, key), el("span", undefined, value));
  host.append(row);
}

function kindBars(host: HTMLElement, rows: readonly { key: string; n: number }[], varName: string): void {
  const box = el("div", "kinds");
  const peak = Math.max(1, ...rows.map((r) => r.n));
  const cs = getComputedStyle(document.documentElement);
  for (const r of rows) {
    const line = el("div", "kindrow");
    const bar = el("div", "kindbar");
    const fill = el("i");
    fill.style.width = `${(r.n / peak) * 100}%`;
    fill.style.background =
      cs.getPropertyValue(`--${varName}-${r.key}`).trim() || cs.getPropertyValue("--accent").trim();
    bar.append(fill);
    line.append(el("em", undefined, r.key), bar, el("b", undefined, fmtInt(r.n)));
    box.append(line);
  }
  host.append(box);
}

// ---------------------------------------------------------------------------
// Роутинг: модель × класс задачи (W12)
//
// Форма ответа копирует то, что печатает `myc report models`: answer/why уже
// посчитаны на сервере (routing.ts зовёт compareModels из @myc/swarm), здесь
// только вёрстка. Единственная логика на клиенте — какой CSS-класс дать
// готовому ответу, текст решения не меняется ни на букву.
// ---------------------------------------------------------------------------

function routingAnswerLabel(answer: RoutingClass["answer"]): string {
  switch (answer) {
    case "ok":
      return "ответ есть";
    case "single_arm":
      return "не с чем сравнить";
    case "insufficient_attempts":
      return "наблюдений не хватает";
    case "no_cost_data":
      return "цена не посчитана";
    default:
      return answer;
  }
}

/** ok только когда есть однозначный ответ И разделение с лидером не «пока не отличили». */
function routingAnswerState(cls: RoutingClass): "ok" | "warn" {
  return cls.answer === "ok" && !cls.separationPending ? "ok" : "warn";
}

/**
 * null — стоимость не посчитана НИ У ОДНОЙ попытки руки: "нет цены".
 * 0 — посчитана и равна нулю: "$0.0000". Один и тот же текст для обоих
 * скрыл бы то, что 0 попыток из N дали стоимость (см. costedAttempts рядом).
 */
function fmtRoutingCost(v: number | null): string {
  return v === null ? "нет цены" : `$${v.toFixed(4)}`;
}

function renderRoutingArm(a: RoutingArm): HTMLElement {
  const row = el("div", a.enoughData ? "arm-row" : "arm-row arm-row-thin");
  const mark = a.isCheapest ? "→" : a.isEqualGroup ? "=" : "";
  row.append(el("span", "arm-mark", mark));
  row.append(el("span", "arm-name mono", a.arm));
  row.append(el("span", "arm-n", `n=${fmtInt(a.attempts)}`));
  row.append(
    el(
      "span",
      "arm-q",
      `q=${a.qualityMean.toFixed(2)} [${a.quality.lo.toFixed(2)}–${a.quality.hi.toFixed(2)}]`,
    ),
  );
  row.append(
    el(
      "span",
      a.costUsdMean === null ? "arm-cost arm-cost-missing" : "arm-cost",
      `${fmtRoutingCost(a.costUsdMean)}/попытка (${a.costedAttempts}/${a.attempts})`,
    ),
  );
  row.append(el("span", "arm-clean", `чисто ${Math.round(a.cleanRate * 100)}%`));
  if (!a.enoughData) row.append(el("span", "state warn", "мало наблюдений"));
  return row;
}

function renderRoutingClass(cls: RoutingClass): HTMLElement {
  const box = card(cls.taskClass, true);
  for (const a of cls.arms) box.append(renderRoutingArm(a));
  const verdict = el("div", "routing-verdict");
  verdict.append(
    el("span", `state ${routingAnswerState(cls)}`, routingAnswerLabel(cls.answer)),
    el("span", "routing-why", cls.why),
  );
  box.append(verdict);
  return box;
}

async function loadRouting(): Promise<void> {
  const payload = await api<RoutingPayload>("/api/routing");
  $("routing-sub").textContent =
    `задач закрыто ${fmtInt(payload.coverage.tasksClosed)}, с атрибуцией ${fmtInt(payload.coverage.tasksAttributed)} · ` +
    `попыток ${fmtInt(payload.coverage.attempts)} (закрыто ${fmtInt(payload.coverage.finished)}, ` +
    `со стоимостью ${fmtInt(payload.coverage.withCost)}) · outcome v${payload.outcomeVersion}, ` +
    `интервал ${Math.round(payload.credibleMass * 100)}%, порог наблюдений ${payload.minAttempts} · ` +
    `${payload.took_ms} мс`;

  // Оговорки — первыми и так же заметно, как на экране «здоровье» (И2):
  // single_arm/insufficient_attempts/no_cost_data не должны потеряться рядом
  // с числами, по которым это вообще-то нельзя решать.
  const degHost = $("routing-degraded");
  degHost.replaceChildren();
  const deg = card(
    payload.degraded.length === 0 ? "оговорок нет" : `оговорки (${payload.degraded.length})`,
    true,
  );
  if (payload.degraded.length === 0) {
    deg.append(el("span", "state ok", "по каждому классу задач есть однозначный ответ"));
  } else {
    for (const d of payload.degraded) {
      const box = el("div", "deg");
      box.append(el("code", undefined, d.code), el("span", undefined, d.msg));
      deg.append(box);
    }
  }
  degHost.append(deg);

  const host = $("routing-classes");
  host.replaceChildren();
  if (!payload.available || payload.classes.length === 0) {
    host.hidden = true;
    emptyState(
      $("routing-empty"),
      "Атрибуции пока нет",
      "Ни одной закрытой попытки с атрибуцией. Панель наполнится, как только `myc attempt finish` закроет первую попытку.",
      "myc report models",
    );
    return;
  }
  host.hidden = false;
  $("routing-empty").hidden = true;
  for (const cls of payload.classes) host.append(renderRoutingClass(cls));
}

// ---------------------------------------------------------------------------
// Бутстрап (W9): предпросмотр — БУКВАЛЬНЫЙ `data.text` с сервера, без
// пересборки в браузере. Подмешивать в него что-либо здесь значило бы
// показать агенту не то, что реально отдаёт `myc bootstrap`.
// ---------------------------------------------------------------------------

let bootstrapHistoryFor: string | null = null;

function renderBootstrapCut(data: BootstrapPreview): void {
  const host = $("bootstrap-cut");
  if (!data.truncated) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  host.replaceChildren();
  host.append(el("b", undefined, "порезано бюджетом"));
  const bits: string[] = [];
  if (data.dropped.length > 0) bits.push(`выброшено: ${data.dropped.join(", ")}`);
  if (data.clipped.length > 0) bits.push(`подрезано: ${data.clipped.join(", ")}`);
  bits.push(`бюджет ${fmtInt(data.budget)} симв · тело ${fmtInt(data.body_chars)} симв`);
  host.append(el("span", undefined, bits.join(" · ")));
}

function renderBootstrapHistory(rows: readonly BootstrapHistoryRow[]): void {
  const host = $("bootstrap-history");
  host.hidden = false;
  host.replaceChildren();
  if (rows.length === 0) {
    host.append(el("div", undefined, "истории нет"));
    return;
  }
  for (const r of rows) {
    const row = el("div", "bootstrap-history-row");
    row.append(el("span", "htime", fmtTime(r.ts_ms)));
    row.append(el("span", "hactor", r.actor || "?"));
    row.append(el("span", "htext", r.text ?? "(пусто)"));
    host.append(row);
  }
}

async function toggleBootstrapHistory(row: BootstrapBlockRow): Promise<void> {
  if (row.id === "-") {
    toast("у блока личного яруса нет id — истории нет (ограничение myc bootstrap list)");
    return;
  }
  if (bootstrapHistoryFor === row.id) {
    bootstrapHistoryFor = null;
    $("bootstrap-history").hidden = true;
    return;
  }
  bootstrapHistoryFor = row.id;
  const payload = await api<{ rows: BootstrapHistoryRow[] }>(`/api/bootstrap/blocks/${row.id}/history`);
  renderBootstrapHistory(payload.rows);
}

function renderBootstrapBlocks(rows: readonly BootstrapBlockRow[]): void {
  const host = $("bootstrap-blocks");
  host.replaceChildren();
  const empty = $("bootstrap-empty");
  if (rows.length === 0) {
    emptyState(empty, "ручных блоков нет", "правило запуска, которого нет в автодетекте — заведите его ниже");
    return;
  }
  empty.hidden = true;
  for (const row of rows) {
    const item = el("div", "bootstrap-block");
    item.append(el("span", "bkey", row.key));
    item.append(el("span", "btier", row.tier === "personal" ? "@personal" : "проектный"));
    item.append(el("span", "bchars", `${fmtInt(row.chars)} симв`));
    const actions = el("div", "bactions");
    const hist = el("button", "rbtn", "история");
    hist.addEventListener("click", () => void toggleBootstrapHistory(row));
    actions.append(hist);
    if (writeEnabled) {
      const edit = el("button", "rbtn", "править");
      edit.addEventListener("click", () => fillBootstrapForm(row));
      actions.append(edit);
      const rm = el("button", "rbtn danger", "снять");
      rm.addEventListener("click", () => {
        void (async () => {
          const ok = await mutate(`/api/bootstrap/${encodeURIComponent(row.key)}/op`, {
            op: "rm",
            global: row.tier === "personal",
          });
          if (ok) await loadBootstrap();
        })();
      });
      actions.append(rm);
    }
    item.append(actions);
    host.append(item);
  }
}

let bootstrapKeyInput: HTMLInputElement | null = null;
let bootstrapTextInput: HTMLTextAreaElement | null = null;
let bootstrapGlobalInput: HTMLInputElement | null = null;

/** Заполняет форму существующим блоком — правка идёт тем же set (upsert). */
function fillBootstrapForm(row: BootstrapBlockRow): void {
  if (bootstrapKeyInput === null || bootstrapTextInput === null || bootstrapGlobalInput === null) return;
  bootstrapKeyInput.value = row.key;
  bootstrapTextInput.value = "";
  bootstrapGlobalInput.checked = row.tier === "personal";
  bootstrapTextInput.focus();
  toast(`правите «${row.key}» — впишите новый текст целиком, он заменит прежний`);
}

function renderBootstrapNew(): void {
  const host = $("bootstrap-new");
  if (!writeEnabled) {
    host.replaceChildren();
    host.hidden = true;
    bootstrapKeyInput = null;
    bootstrapTextInput = null;
    bootstrapGlobalInput = null;
    return;
  }
  host.hidden = false;
  const form = el("div", "task-new-form");
  form.hidden = false;

  const key = el("input", "props-input") as HTMLInputElement;
  key.setAttribute("placeholder", "ключ: a-z0-9_- (напр. style)");
  const text = el("textarea", "props-input props-body") as HTMLTextAreaElement;
  text.setAttribute("placeholder", "текст правила — то, что увидит агент");
  const globalLabel = el("label");
  const global = el("input") as HTMLInputElement;
  global.type = "checkbox";
  globalLabel.append(global, document.createTextNode(" личный ярус (~/.myc)"));

  const submit = el("button", "rbtn primary", "сохранить блок");
  submit.addEventListener("click", () => {
    void (async () => {
      const k = key.value.trim();
      const t = text.value;
      if (k.length === 0) {
        toast("нужен ключ блока");
        return;
      }
      if (t.length === 0) {
        toast("нужен текст блока");
        return;
      }
      const ok = await mutate(`/api/bootstrap/${encodeURIComponent(k)}`, {
        text: t,
        global: global.checked,
      });
      if (ok) {
        key.value = "";
        text.value = "";
        global.checked = false;
        await loadBootstrap();
      }
    })();
  });

  form.append(key, text, globalLabel, submit);
  host.replaceChildren(form);
  bootstrapKeyInput = key;
  bootstrapTextInput = text;
  bootstrapGlobalInput = global;
}

async function loadBootstrap(): Promise<void> {
  const preview = await apiData<BootstrapPreview>("/api/bootstrap");
  $("bootstrap-sub").textContent =
    `auto ${preview.auto} · ручных ${preview.manual} · ${fmtInt(preview.chars)}/${fmtInt(preview.budget)} симв · ` +
    `cache ${preview.cache} · ${preview.took_ms} мс`;
  // БУКВАЛЬНЫЙ текст сервера, символ в символ — приёмка экрана держится на
  // том, что здесь никогда не появляется ничего, кроме `preview.text`.
  $("bootstrap-preview").textContent = preview.text;
  renderBootstrapCut(preview);

  renderBootstrapNew();
  const blocks = await apiData<{ rows: BootstrapBlockRow[] }>("/api/bootstrap/blocks");
  renderBootstrapBlocks(blocks.rows);
}

async function loadHealth(): Promise<void> {
  const h = await api<HealthPayload>("/api/health");
  const schema =
    h.workspace.schema_version !== null
      ? `схема v${h.workspace.schema_version}`
      : "версия схемы неизвестна — нет таблицы schema_migrations или она пуста";
  $("health-sub").textContent =
    `${h.workspace.slug} · ${h.workspace.db_path} · ${schema} · собрано за ${h.took_ms} мс`;

  const host = $("health-cards");
  host.replaceChildren();

  // Деградации — первыми и крупно: молчаливого фолбэка не бывает (И2).
  const deg = card(h.degraded.length === 0 ? "деградаций нет" : `деградации (${h.degraded.length})`, true);
  if (h.degraded.length === 0) {
    const ok = el("span", "state ok", "всё в норме");
    deg.append(ok);
  } else {
    for (const d of h.degraded) {
      const box = el("div", d.code.startsWith("schema") || d.code.endsWith("hard_limit") ? "deg bad" : "deg");
      box.append(el("code", undefined, d.code), el("span", undefined, d.msg));
      deg.append(box);
    }
  }
  host.append(deg);

  const ws = card("воркспейс");
  kv(ws, "база", fmtBytes(h.workspace.db_bytes));
  kv(ws, "WAL", fmtBytes(h.workspace.wal_bytes));
  kv(ws, "shm", fmtBytes(h.workspace.shm_bytes));
  kv(ws, "журнал", h.workspace.journal_mode);
  kv(ws, "site_id", h.workspace.site_id || "—");
  kv(ws, "режим", "только чтение");
  const meter = el("div", "meter");
  const fill = el("i");
  const walPct = Math.min(100, (h.workspace.wal_bytes / (32 * 1024 * 1024)) * 100);
  fill.style.width = `${Math.max(1, walPct)}%`;
  if (walPct > 100 * (8 / 32)) fill.className = walPct > 90 ? "bad" : "warn";
  meter.append(fill);
  ws.append(meter);
  kv(ws, "WAL к потолку 32 МБ", `${walPct.toFixed(1)}%`);
  host.append(ws);

  const nodes = card("узлы");
  nodes.append(el("div", "big", fmtInt(h.nodes.total)));
  if (h.nodes.by_kind.length > 0) kindBars(nodes, h.nodes.by_kind, "kind");
  else nodes.append(el("div", "row", "по видам пока пусто"));
  host.append(nodes);

  const edges = card("рёбра");
  edges.append(el("div", "big", fmtInt(h.edges.total)));
  if (h.edges.by_type.length > 0) {
    for (const r of h.edges.by_type) kv(edges, r.key, fmtInt(r.n));
  } else {
    edges.append(el("div", "row", "связей пока нет"));
  }
  host.append(edges);

  const embed = card("эмбеддер");
  const embedState = el(
    "span",
    `state ${h.embed.state === "ok" ? "ok" : h.embed.state === "off" ? "warn" : "bad"}`,
    h.embed.state === "ok"
      ? "работает"
      : h.embed.state === "off"
        ? "выключен"
        : h.embed.state === "degraded"
          ? "деградация"
          : "неизвестно",
  );
  embed.append(embedState);
  kv(embed, "модель", h.embed.model || "—");
  kv(embed, "размерность", h.embed.dim !== null ? String(h.embed.dim) : "—");
  kv(embed, "в очереди", fmtInt(h.embed.pending));
  kv(embed, "провалено", fmtInt(h.embed.failed));
  const detail = el("div", "row");
  detail.append(el("span", undefined, h.embed.detail));
  embed.append(detail);
  host.append(embed);

  const vec = card("векторное расширение");
  vec.append(
    el("span", `state ${h.vec.schema_applied ? "ok" : "warn"}`, h.vec.schema_applied ? "схема применена" : "не применена"),
  );
  const vd = el("div", "row");
  vd.append(el("span", undefined, h.vec.detail));
  vec.append(vd);
  kv(vec, "векторов", h.embed.rows !== null ? fmtInt(h.embed.rows) : "не читается без vec0");
  kv(vec, "FTS", h.fts.available ? "есть" : "нет");
  host.append(vec);

  const jobs = card("фоновая очередь");
  jobs.append(el("div", "big", fmtInt(h.jobs.pending)));
  kv(jobs, "провалено", fmtInt(h.jobs.failed));
  for (const r of h.jobs.by_kind) kv(jobs, r.key, fmtInt(r.n));
  if (h.jobs.by_kind.length === 0) jobs.append(el("div", "row", "очередь пуста"));
  host.append(jobs);

  const anchors = card("якоря");
  anchors.append(el("div", "big", fmtInt(h.anchors.total)));
  for (const r of h.anchors.by_state) kv(anchors, r.key, fmtInt(r.n));
  if (h.anchors.by_state.length === 0) anchors.append(el("div", "row", "якорей нет"));
  host.append(anchors);

  const op = card("оплог");
  op.append(el("div", "big", fmtInt(h.oplog.count)));
  kv(op, "последний seq", String(h.oplog.last_seq));
  kv(op, "последняя запись", h.oplog.last_ts !== null ? `${fmtAge(Date.now() - h.oplog.last_ts)} назад` : "—");
  for (const a of h.oplog.actors) kv(op, a.key, fmtInt(a.n));
  host.append(op);

  if (h.components.length > 0) {
    const comp = card("компоненты (myc_health)", true);
    for (const c of h.components) {
      const row = el("div", "row");
      row.append(
        el("span", undefined, `${c.component}${c.reason.length > 0 ? ` — ${c.reason}` : ""}`),
        el("span", `state ${c.state === "ok" ? "ok" : c.state === "degraded" ? "warn" : "bad"}`, c.state),
      );
      comp.append(row);
    }
    host.append(comp);
  }
}

// ---------------------------------------------------------------------------
// Поиск (W6, memory-c7075t2s0nj6): гибридный поиск тем же движком, что
// `myc recall` — /api/search вызывает `runCli(["recall", …, "--json"])`
// (search.ts) и отдаёт конверт как есть. Здесь ноль пересчёта: ранг, score,
// z-оценка уверенности, обрезка бюджетом и предупреждения деградации —
// печатаются в точности из того, что вернул движок (И2).
// ---------------------------------------------------------------------------

let searchQueryInput: HTMLInputElement | null = null;
let searchQuery = "";
let searchOffset = 0;
let searchRows: SearchRow[] = [];

/** z-score S47: undefined — вектор не участвовал в ЭТОМ хите, не "0.00" —
 *  ноль читался бы как измеренное низкое качество, а сигнала вовсе нет. */
function fmtConfidence(c: number | undefined): string {
  return c === undefined ? "·" : c.toFixed(2);
}

function searchReachTag(row: SearchRow): string {
  if (row.reach === "unknown") return "?";
  if (row.reach === "session") return row.reach_session.length > 0 ? "ses" : "ses*";
  return "prj";
}

function renderSearchRow(row: SearchRow): HTMLElement {
  const item = el("div", "search-row");
  const head = el("div", "search-row-head");
  head.append(el("span", "search-rank", `${row.rank}.`));
  head.append(
    el(
      "span",
      row.confidence === undefined ? "search-conf search-conf-none" : "search-conf",
      fmtConfidence(row.confidence),
    ),
  );
  head.append(el("span", "search-id mono", row.id));
  head.append(el("span", "search-type", row.type));
  head.append(el("span", "search-layer", `L${row.layer}`));
  head.append(el("span", "search-reach", searchReachTag(row)));
  if (row.repo_state === "unknown") head.append(el("span", "search-repo search-repo-unknown", "?"));
  else if (row.repo.length > 0) head.append(el("span", "search-repo", row.repo));
  head.append(el("span", "search-title", row.title));
  item.append(head);
  const excerpt = row.excerpt.trim();
  if (excerpt.length > 0) item.append(el("div", "search-excerpt", excerpt));
  return item;
}

/** Оговорки поиска — так же заметно, как на «здоровье» и «роутинге» (И2):
 *  `warn[]` конверта, ровно те строки, что печатает CLI под подвалом. */
function renderSearchDegraded(warn: readonly { code: string; msg: string }[]): void {
  const host = $("search-degraded");
  host.replaceChildren();
  if (warn.length === 0) return;
  const box = card(`деградация (${warn.length})`, true);
  for (const w of warn) {
    const row = el("div", "deg");
    row.append(el("code", undefined, w.code), el("span", undefined, w.msg));
    box.append(row);
  }
  host.append(box);
}

function renderSearchFooter(data: SearchPayload): void {
  const host = $("search-footer");
  host.hidden = false;
  host.replaceChildren();
  const bits: string[] = [
    `${fmtInt(data.shown)} из ${fmtInt(data.total)}`,
    data.mode,
    `${data.took_ms} мс`,
    `${fmtInt(data.used_chars)} симв из ${fmtInt(data.budget)}`,
  ];
  if (data.deduped > 0) bits.push(`${fmtInt(data.deduped)} дублей свёрнуто`);
  if (data.foreign > 0) bits.push(`${fmtInt(data.foreign)} из чужих сессий`);
  if (data.unknown_reach > 0) bits.push(`${fmtInt(data.unknown_reach)} без охвата`);
  if (data.unknown_repo > 0) bits.push(`${fmtInt(data.unknown_repo)} без охвата репозитория`);
  if (data.pool_exhausted) bits.push("пул исчерпан, total — нижняя оценка");
  host.append(el("span", "search-footer-line", bits.join(" · ")));
  // partial — ГРОМКО, своей строкой, а не спрятано в подсказку (И2): поиск,
  // который молча отдал не всё, хуже отсутствующего.
  if (data.partial) {
    const why: string[] = [];
    if (data.omitted > 0) why.push(`${fmtInt(data.omitted)} сверх бюджета`);
    host.append(
      el("span", "search-partial state warn", `partial: ${why.length > 0 ? why.join(", ") : "выдано не всё"}`),
    );
  }
  if (data.cursor !== undefined) {
    const more = el("button", "rbtn", "показать ещё");
    more.addEventListener("click", () => {
      void runSearch(searchQuery, Number(data.cursor), true);
    });
    host.append(more);
  }
}

async function runSearch(query: string, offset = 0, append = false): Promise<void> {
  const q = query.trim();
  if (q.length === 0) {
    toast("нужен запрос");
    return;
  }
  searchQuery = q;
  searchOffset = offset;
  $("search-sub").textContent = "ищу…";
  let env: Envelope<SearchPayload>;
  try {
    const params = new URLSearchParams({ q });
    if (offset > 0) params.set("offset", String(offset));
    env = await apiEnvelope<SearchPayload>(`/api/search?${params.toString()}`);
  } catch (error) {
    $("search-sub").textContent = "—";
    toast(error instanceof Error ? error.message : String(error));
    return;
  }
  const data = env.data;
  searchRows = append ? [...searchRows, ...data.rows] : [...data.rows];

  $("search-sub").textContent = `«${data.query}»`;
  renderSearchDegraded(env.warn ?? []);

  const host = $("search-rows");
  const empty = $("search-empty");
  if (searchRows.length === 0) {
    host.replaceChildren();
    host.hidden = true;
    $("search-footer").hidden = true;
    emptyState(empty, "ничего не нашлось", "попробуйте другой запрос или снимите фильтры", "myc recall");
    return;
  }
  empty.hidden = true;
  host.hidden = false;
  host.replaceChildren();
  for (const row of searchRows) host.append(renderSearchRow(row));
  renderSearchFooter(data);
}

function initSearchTab(): void {
  const input = $("search-query") as HTMLInputElement;
  searchQueryInput = input;
  const go = $("search-go");
  const submit = (): void => void runSearch(input.value);
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  void searchQueryInput;
}

// ---------------------------------------------------------------------------
// Решения (W8): supersession-цепочки и открытые противоречия.
//
// Голова цепочки, порядок звеньев и «актуальная версия» посчитаны на сервере
// той же сборкой, что у `myc show` (decisions.ts зовёт collectVersions +
// VersionGraph из @myc/core, §6.3) — здесь только вёрстка, ничего не
// пересчитывается заново.
//
// «Это верное» НЕ решает противоречие само: кнопка отправляет обычную отмену
// (POST /api/nodes/<id>/op, op=cancel) с обязательной причиной — тем же
// путём, что и любая другая кнопка отмены на этом просмотрщике (opBar).
// Отменяется ДРУГАЯ сторона, а не удаляется ребро contradicts: история
// остаётся читаемой в `myc show --chain`, и это не тихое угасание, а запись
// с причиной и автором, которую увидит следующая сессия.
// ---------------------------------------------------------------------------

function decisionPill(l: DecisionLink): HTMLElement {
  return el("span", l.current ? "state ok" : "state warn", l.current ? `${l.status} · актуальна` : l.status);
}

function renderDecisionLink(l: DecisionLink): HTMLElement {
  const row = el("div", l.current ? "arm-row" : "arm-row arm-row-thin");
  row.append(decisionPill(l));
  row.append(el("span", "arm-name mono", l.id));
  row.append(el("span", undefined, l.title));
  row.append(el("span", "arm-n", `@${l.author}`));
  row.append(el("span", "arm-n", fmtDay(l.created_at)));
  if (l.reason !== undefined) row.append(el("span", "routing-why", l.reason));
  return row;
}

function renderDecisionChain(chain: DecisionChain): HTMLElement {
  const box = card(chain.head, true);
  for (const l of chain.links) box.append(renderDecisionLink(l));
  if (chain.forked !== undefined) {
    // Развилка — след слияния двух веток; молчать об этом нельзя (И2), как и
    // в `myc show`, откуда взято то же поле.
    box.append(el("div", "state warn", `развилка цепочки: ${chain.forked.join(", ")}`));
  }
  return box;
}

function decisionRefLine(ref: DecisionRef): HTMLElement {
  const row = el("div", "arm-row");
  row.append(el("span", "arm-name mono", ref.id));
  row.append(el("span", undefined, ref.title));
  row.append(el("span", "arm-n", ref.status));
  row.append(el("span", "arm-n", `@${ref.author}`));
  row.append(el("span", "arm-n", fmtDay(ref.created_at)));
  return row;
}

/**
 * «X верное» отменяет ДРУГУЮ сторону через общий путь записи (mutate ->
 * POST .../op). cancel требует причину на сервере (mutate.ts) — здесь она
 * не спрашивается диалогом, а собирается из самого противоречия: кто кого
 * заменил и почему, и это ровно то, что должна прочитать следующая сессия.
 */
function renderContradiction(c: DecisionContradiction, onDone: () => void): HTMLElement {
  const box = card(`${c.a.id} ↔ ${c.b.id}`, true);
  if (c.reason !== undefined) box.append(el("div", "routing-why", c.reason));

  const resolve = async (verified: DecisionRef, wrong: DecisionRef): Promise<void> => {
    const reason = `противоречило ${verified.id} «${verified.title}» — оно признано верным, эта версия отменена`;
    if (await mutate(`/api/nodes/${encodeURIComponent(wrong.id)}/op`, { op: "cancel", reason })) onDone();
  };

  for (const [side, other] of [[c.a, c.b] as const, [c.b, c.a] as const]) {
    const row = decisionRefLine(side);
    if (writeEnabled) {
      const btn = el("button", "rbtn", "это верное");
      btn.addEventListener("click", () => void resolve(side, other));
      row.append(btn);
    }
    box.append(row);
  }
  return box;
}

async function loadDecisions(): Promise<void> {
  const payload = await api<DecisionsPayload>("/api/decisions");
  $("decisions-sub").textContent =
    `решений ${fmtInt(payload.total_decisions)}, цепочек ${fmtInt(payload.chains.length)}, ` +
    `открытых противоречий ${fmtInt(payload.contradictions.length)} · ${payload.took_ms} мс`;

  const degHost = $("decisions-degraded");
  degHost.replaceChildren();
  if (payload.degraded.length > 0) {
    const deg = card(`оговорки (${payload.degraded.length})`, true);
    for (const d of payload.degraded) {
      const box = el("div", "deg");
      box.append(el("code", undefined, d.code), el("span", undefined, d.msg));
      deg.append(box);
    }
    degHost.append(deg);
  }

  const refresh = (): void => void loadDecisions();

  const contraHost = $("decisions-contradictions");
  contraHost.replaceChildren();
  for (const c of payload.contradictions) contraHost.append(renderContradiction(c, refresh));
  contraHost.hidden = payload.contradictions.length === 0;
  if (payload.contradictions.length === 0) {
    emptyState($("decisions-contradictions-empty"), "Открытых противоречий нет", "Все ребра contradicts либо отсутствуют, либо уже разрешены обычной отменой.");
  } else {
    $("decisions-contradictions-empty").hidden = true;
  }

  const chainsHost = $("decisions-chains");
  chainsHost.replaceChildren();
  for (const c of payload.chains) chainsHost.append(renderDecisionChain(c));
  chainsHost.hidden = payload.chains.length === 0;
  if (payload.chains.length === 0) {
    emptyState($("decisions-empty"), "Решений пока нет", "Ни одного узла с attrs.type='decision'.", "myc create --type decision \"…\"");
  } else {
    $("decisions-empty").hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Вкладки и старт
// ---------------------------------------------------------------------------

const TABS = [
  "graph",
  "ready",
  "board",
  "kb",
  "timeline",
  "search",
  "routing",
  "decisions",
  "bootstrap",
  "health",
] as const;
const DEFAULT_TAB: VizTab = "graph";

const loaded = new Set<VizTab>();

/**
 * Хеш → экран. Всё, что не совпало с именем экрана (пусто, мусор, чужой
 * якорь), даёт экран по умолчанию, а не пустую страницу.
 */
function parseTab(hash: string): VizTab {
  const name = hash.replace(/^#/, "");
  return (TABS as readonly string[]).includes(name) ? (name as VizTab) : DEFAULT_TAB;
}

/** Переключение вкладок и панелей — синхронно и без сети: экран обязан быть
 *  правильным на первой же отрисовке, а не после ответа `/api/boot`. */
function renderRoute(tab: VizTab): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    btn.setAttribute("aria-selected", String(btn.dataset["tab"] === tab));
  }
  for (const name of TABS) {
    $(`panel-${name}`).hidden = name !== tab;
  }
}

/**
 * Единственная точка, где решается, какой экран показан, и решается она по
 * адресу.
 *
 * Хеш — источник истины, и связь односторонняя: клик по вкладке лишь
 * переписывает адрес, а экран меняет уже эта функция. Поэтому клик, ссылка
 * снаружи, «назад» и «вперёд» идут одним и тем же путём и не могут разойтись —
 * раньше расходились: адрес показывал `#graph`, а на экране оставалось
 * «Здоровье», потому что hashchange никто не слушал.
 */
async function applyRoute(): Promise<void> {
  const tab = parseTab(location.hash);
  // Адрес и экран обязаны совпадать в обе стороны: пустой или незнакомый хеш
  // приводим к имени показанного экрана. Через replaceState, а не
  // присваиванием `location.hash`: присваивание завело бы запись в историю, и
  // первое «назад» уводило бы на ту же страницу.
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  renderRoute(tab);
  if (loaded.has(tab)) return;
  loaded.add(tab);
  try {
    if (tab === "graph") await graph.load();
    else if (tab === "ready") await loadReady();
    else if (tab === "board") await loadBoard();
    else if (tab === "kb") await loadKb();
    else if (tab === "timeline") await loadTimeline();
    else if (tab === "search") initSearchTab();
    else if (tab === "routing") await loadRouting();
    else if (tab === "decisions") await loadDecisions();
    else if (tab === "bootstrap") await loadBootstrap();
    else await loadHealth();
  } catch (error) {
    // Снимаем отметку: повторный заход на вкладку должен пробовать снова.
    loaded.delete(tab);
    toast(error instanceof Error ? error.message : String(error));
  }
}

/** Клик по вкладке = переход по адресу. Запись в `location.hash` кладёт запись
 *  в историю, и именно поэтому «назад» возвращает на прошлый экран. */
function navigate(tab: VizTab): void {
  if (parseTab(location.hash) !== tab) location.hash = tab;
  // Событие hashchange придёт следующей задачей; отрисовываем сразу, чтобы
  // клик отзывался мгновенно. Повторный вызов из обработчика идемпотентен.
  void applyRoute();
}

async function main(): Promise<void> {
  initTheme();
  graph.mount();
  $("tabs").addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>(".tab");
    if (target === null) return;
    navigate((target.dataset["tab"] ?? DEFAULT_TAB) as VizTab);
  });
  window.addEventListener("hashchange", () => {
    void applyRoute();
  });

  // Маршрут применяется до `/api/boot`, а не после: иначе страница, открытая
  // по /#health, успевает нарисовать граф и переключиться уже на глазах.
  const routed = applyRoute();

  try {
    const boot = await api<BootPayload>("/api/boot");
    writeEnabled = boot.read_only === false;
    // Ярус (S41) — третья ось, свойство открытой базы целиком: показывается
    // один раз в шапке, а не примешивается к охватам строк (S58, S59).
    const tierMark = boot.tier === "personal" ? "ярус: личный (~/.myc)" : "ярус: проектный (.myc)";
    $("boot").textContent =
      `${boot.slug} · ${tierMark} · ${fmtInt(boot.nodes)} узлов / ${fmtInt(boot.edges)} рёбер` +
      (writeEnabled ? "" : " · только чтение");
    if (!boot.schema_ready) {
      toast("в базе нет схемы myc — показываю пустые экраны, а не падаю; проверьте myc init");
    }
    // Очередь могла нарисоваться раньше ответа /api/boot — тогда она не знала
    // о записи и осталась без кнопок. Перерисовываем ровно этот случай.
    if (writeEnabled && parseTab(location.hash) === "ready") {
      await routed;
      await loadReady();
    }
    // То же для базы знаний: форма заведения появляется только после boot.
    if (writeEnabled && parseTab(location.hash) === "kb") {
      await routed;
      await loadKb();
    }
    // И для доски: без этого карточки нарисовались бы недоступными для
    // перетаскивания (draggable решается по writeEnabled в boardCard).
    if (writeEnabled && parseTab(location.hash) === "board") {
      await routed;
      await loadBoard();
    }
    // И для бутстрапа: форма добавления блока появляется только после boot.
    if (writeEnabled && parseTab(location.hash) === "bootstrap") {
      await routed;
      await loadBootstrap();
    }
    // И для решений: кнопка «это верное» решает по writeEnabled и иначе не
    // рисуется вовсе — открытие прямо на #decisions до ответа /api/boot
    // оставило бы противоречия без единственного пути их разрешить.
    if (writeEnabled && parseTab(location.hash) === "decisions") {
      await routed;
      await loadDecisions();
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }

  await routed;
}

void main();
