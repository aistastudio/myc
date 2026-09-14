/**
 * Запись через HTTP — ОДНИМ ПУТЁМ С CLI.
 *
 * Здесь нет ни одного `UPDATE nodes`. Каждая мутация собирается в argv и
 * уходит в тот же движок команд, который обслуживает человека в терминале
 * (`run()` из @myc/cli) и агента через MCP (dispatch.ts делает ровно это).
 * Причина не в экономии кода: вторая ветка записи — это вторая реализация
 * CRDT, а в этом проекте она дважды кончалась молчаливой потерей данных
 * (решения S38 и S40). Оплог, HLC, per-field LWW, проверка статусов и отчёт
 * о разблокированных существуют в одном месте, и поверхность обязана в него
 * ходить, а не повторять его.
 *
 * СТАТУСЫ НЕ ПРИНИМАЮТСЯ ВОВСЕ (S54). Статус вычисляется или зарабатывается:
 * `in_progress` берётся арендой, `blocked` считается из открытых блокеров,
 * `closed` требует владения и причины, `cancelled` обязан сообщить, кого
 * выпустил в очередь. Поэтому у HTTP, как и у MCP, есть ОПЕРАЦИИ, а поля
 * `status` в теле запроса нет: попытка его прислать — громкий отказ с именем
 * нужной операции. Именно асимметрия поверхностей (у MCP release был, у CLI
 * нет) породила P0 myc-cnka6qyvwc6m; третью асимметрию мы не создаём.
 *
 * И2 — ОШИБКА ЗАПИСИ ГРОМКАЯ. Конверт CLI (`{ok, error:{code,msg,exit,hint},
 * meta.degraded[], warn[]}`) переносится в HTTP один в один: машинный код,
 * человеческое объяснение, подсказка и предупреждения деградации. Ни один
 * отказ не превращается в 200.
 */

import type { ReadOnlyDb } from "./db.ts";

// ---------------------------------------------------------------------------
// путь записи
// ---------------------------------------------------------------------------

export interface CliOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string | undefined;
}

/** Прогон команды CLI. Тесты подменяют его настоящим процессом `myc`. */
export type RunCli = (argv: readonly string[]) => Promise<CliOutcome>;

export interface WriteWarn {
  readonly code: string;
  readonly msg: string;
}

export interface WriteEnvelope {
  ok: boolean;
  cmd: string;
  data: (Record<string, unknown> & { took_ms?: number }) | null;
  meta: Record<string, unknown> & { degraded?: string[] };
  warn?: WriteWarn[];
  error?: { code: string; msg: string; exit: number; hint?: string };
}

export type WriteOutcome =
  | {
      readonly ok: true;
      readonly status: number;
      readonly data: Record<string, unknown>;
      readonly degraded: readonly string[];
      readonly warn: readonly WriteWarn[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly msg: string;
      readonly hint?: string | undefined;
      readonly degraded: readonly string[];
      readonly warn: readonly WriteWarn[];
      readonly extra?: Record<string, unknown> | undefined;
    };

function refuse(
  status: number,
  code: string,
  msg: string,
  hint?: string,
  extra?: Record<string, unknown>,
): WriteOutcome {
  return {
    ok: false,
    status,
    code,
    msg,
    hint,
    degraded: [],
    warn: [],
    ...(extra !== undefined ? { extra } : {}),
  };
}

/**
 * Коды выхода CLI (packages/cli/src/exit.ts) в коды HTTP. Таблица здесь
 * числами, а не импортом enum: статический импорт @myc/cli в @myc/web —
 * цикл пакетов (cli зависит от web ради `myc viz`), поэтому движок
 * подтягивается динамически, в момент первой записи.
 */
export function httpStatusFor(exit: number): number {
  switch (exit) {
    case 2:
      return 400; // USAGE
    case 3:
      return 404; // NOTFOUND
    case 4:
      return 409; // CONFLICT
    case 5:
      return 422; // PRECOND
    case 7:
      return 503; // NOWS — воркспейс не инициализирован
    case 8:
      return 403; // DENIED
    case 9:
      return 504; // TIMEOUT
    default:
      return 500; // ERR и всё незнакомое
  }
}

/**
 * Прогон команды и разбор конверта. Мутации идут ОДНИМ прогоном `--json`:
 * второй прогон ради человеческого текста мутировал бы дважды (тот же
 * довод, что в packages/mcp/src/dispatch.ts).
 */
export async function runWrite(
  runCli: RunCli,
  argv: readonly string[],
): Promise<WriteOutcome> {
  let out: CliOutcome;
  try {
    out = await runCli([...argv, "--json"]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return refuse(500, "write.engine", `write path failed: ${msg}`);
  }

  const line = out.stdout.trim().split("\n").filter((l) => l.length > 0).pop() ?? "";
  let env: WriteEnvelope;
  try {
    env = JSON.parse(line) as WriteEnvelope;
  } catch {
    // Молча вернуть 200 здесь было бы ровно тем сокрытием, против которого И2:
    // команда что-то сделала, а мы не знаем что.
    return refuse(
      500,
      "write.envelope",
      `write path returned no envelope (code ${out.code}): ${line.slice(0, 200)}`,
    );
  }

  const degraded = env.meta?.degraded ?? [];
  const warn = env.warn ?? [];
  if (!env.ok || env.error !== undefined) {
    const err = env.error ?? { code: "write.failed", msg: "command refused without a code", exit: 1 };
    return {
      ok: false,
      status: httpStatusFor(err.exit),
      code: err.code,
      msg: err.msg,
      hint: err.hint,
      degraded,
      warn,
    };
  }
  return { ok: true, status: 200, data: env.data ?? {}, degraded, warn };
}

/**
 * Умолчательный движок: `run()` из @myc/cli на том же реестре команд, что и
 * терминал. Импорт динамический — @myc/cli статически зависит от @myc/web
 * (команда `myc viz`), и статический импорт назад замкнул бы цикл на этапе
 * инициализации модулей. К моменту первого POST процесс `myc` уже поднят,
 * реестр заполнен, и `run` видит все команды.
 */
export function cliRunner(dir: string, dbPath: string): RunCli {
  const prefix = ["-C", dir, "--db", dbPath];
  return async (argv) => {
    const { run, defaultRegistry, registerAll } = await import("@myc/cli");
    // Реестр наполняет main.ts, то есть только запуск бинарём `myc`. Сервер,
    // поднятый иначе, получал пустой реестр и ронял КАЖДУЮ запись с «не
    // конверт (код 2)» — отказ без причины. Наполняем сами: register по имени
    // идемпотентен, повторный вызов в бинаре ничего не меняет.
    if (defaultRegistry.top.length === 0) registerAll(defaultRegistry);
    const result = await run([...prefix, ...argv]);
    const stdout =
      typeof result.stdout === "string" ? result.stdout : [...result.stdout].join("");
    return { code: result.code, stdout, stderr: result.stderr };
  };
}

// ---------------------------------------------------------------------------
// поля правки
// ---------------------------------------------------------------------------

/**
 * Поле запроса → флаг CLI → имя поля в оплоге и field_clock. Третья колонка
 * нужна конкурентной правке: часы LWW ведутся по имени операции
 * (`attrs.tags`, а не `tags`).
 */
const FIELDS: Readonly<Record<string, { readonly flag: string; readonly clock: string }>> = {
  title: { flag: "--title", clock: "title" },
  body: { flag: "--body", clock: "body" },
  priority: { flag: "--priority", clock: "priority" },
  assignee: { flag: "--assign", clock: "assignee" },
  acl: { flag: "--acl", clock: "acl" },
  tags: { flag: "--tag", clock: "attrs.tags" },
  estimate: { flag: "--estimate", clock: "attrs.estimate_min" },
};

export const UPDATE_FIELDS: readonly string[] = Object.keys(FIELDS);

/**
 * Операции вместо сырых статусов — по образцу myc_update (MCP), который
 * статуса не принимает вовсе. `cancel` добавлен здесь потому, что отмена по
 * S54 разрешена человеку и обязана отчитаться о разблокированных; у MCP
 * такой операции нет — расхождение зафиксировано в отчёте задачи.
 */
export const WRITE_OPS = [
  "claim",
  "release",
  "close",
  "reopen",
  "assign",
  "priority",
  "extend",
  "cancel",
] as const;
export type WriteOp = (typeof WRITE_OPS)[number];

/**
 * Разбор кандидатов хука сжатия (memory-79mq6fccg0jm) — кнопки карточки
 * кандидата в «базе знаний», тем же путём записи, что у терминала и MCP:
 * `myc review confirm|reject`. Подтверждение ставит embed и absorb, как новой
 * заметке; отклонение пишет причину в сам узел — поэтому, в отличие от
 * reopen/cancel, здесь нет reason.unwritten.
 *
 * ОТДЕЛЬНЫМ СПИСКОМ — ЗАМЫСЕЛ, А НЕ ДОЛГ. Прежняя причина («справка `myc viz`
 * называет только WRITE_OPS») снята: справка строится из обоих списков, и
 * viz.test.ts сверяет каждое имя каждого. Остались причины по коду, и сливать
 * их списки значило бы стереть разницу, которую код держит:
 *
 *   - у операций разный предмет: WRITE_OPS — переходы задачи (аренда, закрытие,
 *     отмена; `switch (op as WriteOp)` в `planOp`, `lease_minutes`), REVIEW_OPS
 *     — решение о кандидате хука сжатия, заметке (`myc review`, `reason` в узел);
 *   - `planUpdate` на попытку записать статус называет WRITE_OPS как пути
 *     перехода; confirm/reject статусом задачи не являются;
 *   - справка `myc viz` называет их разными фразами («…, cancel» и «confirm or
 *     reject a compaction candidate»).
 *
 * Общее у них одно — вход `POST /api/nodes/<id>/op`, и там они уже вместе
 * (`known` в `planOp`). Пересекаться списки не имеют права: имя из обоих
 * `planOp` молча отдал бы разбору кандидата, и ветка WRITE_OPS его не увидела
 * бы (mutate.test.ts, «списки не пересекаются»).
 */
export const REVIEW_OPS = ["confirm", "reject"] as const;
export type ReviewOp = (typeof REVIEW_OPS)[number];

function planReview(id: string, op: ReviewOp, body: Body): WritePlan | WriteOutcome {
  if (op === "confirm") return { argv: ["review", "confirm", id], clockFields: [] };
  const reason = str(body, "reason")?.trim();
  if (reason === undefined || reason.length === 0) {
    return bad("reject requires 'reason'", "the reason is written into the node: whoever meets this candidate again reads it");
  }
  return { argv: ["review", "reject", id, "--reason", reason], clockFields: [] };
}

/** Какой операцией берётся статус, который прислали полем (S54). */
const STATUS_ROUTE: Readonly<Record<string, string>> = {
  in_progress: "claim — in_progress is taken with a lease, otherwise two agents consider the task theirs",
  blocked: "none: blocked is computed from open blockers and cannot be set",
  closed: "close — closing requires a reason and reports what it unblocked",
  open: "release — a task returns to the queue only by dropping its lease",
  cancelled: "cancel — a cancel must report what it released into the queue",
};

/**
 * Операция, которой у общего пути записи ПОКА НЕТ. `note` у MCP собран двумя
 * прямыми вызовами стора (createNode + ребро `replies_to`), а команды CLI,
 * которая ставит произвольное ребро, не существует: `dep add` умеет только
 * blocks/blocked-by. Сделать здесь третий вариант «заметки» значило бы
 * развести поверхности ещё раз, поэтому отказ громкий и с причиной.
 */
const OP_GAPS: Readonly<Record<string, string>> = {
  note: "a note on a node needs a replies_to edge, and the CLI has no command for arbitrary edges; " +
    "MCP writes it bypassing the CLI — the surfaces must be unified there, not with a third branch here",
  /**
   * Комментарий (W13, memory-tje3kp7avp13) — та же дыра, что у note, тем же
   * доводом: узел kind='message' создать можно (`myc create --kind message`
   * уже в CLI_KINDS), а связать его с карточкой ребром replies_to нечем.
   * `myc dep add` умеет только blocks/blocked-by (packages/cli/src/commands/dep.ts),
   * а `create --parent` пишет ребро `parent` — оно попало бы в подсчёт
   * прогресса эпика (board.ts loadHierarchy считает ВСЕХ детей по parent,
   * не по kind), то есть комментарий исказил бы «N из M закрыто» соседней
   * задачи. Подделывать ребро тут — тот же путь, что уже дважды стоил
   * данных (S38/S40, см. шапку файла), поэтому отказ громкий, а не тихий
   * parent. Нужна команда вида `myc dep add <id> replies-to <id>` или
   * `--reply-to` у `myc msg` — это правка packages/cli, не этого файла.
   */
  comment: "a comment on a node needs a replies_to edge, and the CLI has no command for arbitrary edges " +
    "(dep add only knows blocks/blocked-by); create --parent does not fit here — it would distort " +
    "the epic progress in board.ts. A CLI command for the replies_to edge is needed",
};

/**
 * Поля, которые общий путь записи ПОКА НЕ ПИШЕТ. Смена типа существующего
 * узла жила бы в `attrs.type`, но у `myc update` нет флага для него (проверено
 * на живом движке: unknown flag --type) — видов ядра девять, и epic/bug
 * не среди них: это kind='task' с attrs.type, который ставится при создании
 * через --kind. Третью ветку записи ради селектора, который всегда отказывает,
 * мы не строим: отказ громкий, с причиной и именем того, кто может её снять.
 */
const FIELD_GAPS: Readonly<Record<string, string>> = {
  type: "the engine cannot change attrs.type of an existing node: myc update has no such flag; " +
    "the type is chosen at creation (--kind task|bug|epic|chore), and editing it on a live node " +
    "needs a flag in packages/cli — not a third write branch here",
  layer: "the layer of an existing node does not change through the shared write path: myc update has no layer flag; " +
    "the layer is set at creation (--layer on myc remember) or raised L0→L2/L3 — " +
    "by a new node with a derived_from edge, not by editing this one",
  reach: "session reach (S58) is recorded at creation (--reach on myc remember); " +
    "a fact is promoted to project reach by an explicit decision — an exact repeat " +
    "with --reach project; the engine cannot change reach after the fact",
  repo: "repo reach (S59) is written at creation (--repo on myc create) and derived " +
    "from the call path; myc update has no reach flag — it does not change after the fact",
};

/**
 * Виды ядра, у которых НЕТ пути создания в CLI. fragment и entity в ядре
 * есть (видов девять), но `myc create --kind` их не знает — они рождаются
 * агентскими путями (absorb, импорт). Предлагать в интерфейсе кнопку, которая
 * всегда отказывает, можно только отказом с причиной: 400 от движка назвал
 * бы CLI-алиасы (task, bug, memory…), а не суть — вида в пути записи нет.
 */
const KIND_GAPS: Readonly<Record<string, string>> = {
  fragment: "myc create has no --kind fragment: the core kind exists, but the CLI has no write path for it " +
    "(fragments are born on agent paths — absorb, import); " +
    "no third write branch is built here",
  entity: "myc create has no --kind entity: the core kind exists, but the CLI has no write path for it " +
    "(entities are born on agent paths — absorb, import); " +
    "no third write branch is built here",
};

/**
 * Вид ядра → --kind движка. Интерфейс называет виды ЯДРА (их девять), а CLI
 * исторически зовёт документ «document» — это алиас, а не отдельная сущность,
 * и переименование живёт на границе, один раз.
 */
const CREATE_KIND_ARG: Readonly<Record<string, string>> = {
  doc: "document",
};

export interface WritePlan {
  readonly argv: readonly string[];
  /** Поля, чьи часы проверяет if_match; для операций пуст. */
  readonly clockFields: readonly string[];
  /**
   * Предупреждения, которые обязаны доехать до клиента вместе с успехом.
   * Здесь живёт причина reopen/cancel: общий путь записи её сохранить пока
   * не умеет (см. OP_GAPS.note), и молчать об этом нельзя — по тому же
   * образцу, что WARN note.unwritten у MCP.
   */
  readonly warn?: readonly WriteWarn[];
}

type Body = Record<string, unknown>;

/**
 * Причина принята, но записать её общим путём некуда: `myc update` поля для
 * неё не имеет, а заметкой она стать не может (OP_GAPS.note). Тихо потерять
 * человеческое обоснование — ровно то, что запрещает И2, поэтому клиент
 * получает успех ВМЕСТЕ с признанием потери.
 */
function reasonWarn(op: string, reason: string): WriteWarn {
  return {
    code: "reason.unwritten",
    msg: `the ${op} reason is not saved in the graph: "${reason.slice(0, 120)}"`,
  };
}

function str(body: Body, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : undefined;
}

function bad(msg: string, hint?: string): WriteOutcome {
  return refuse(400, "usage.invalid", msg, hint);
}

/** Значение поля в аргумент CLI: числа и списки приводятся здесь, а не в CLI. */
function fieldArg(key: string, value: unknown): { ok: true; text: string } | { ok: false; msg: string } {
  if (key === "tags") {
    if (!Array.isArray(value)) return { ok: false, msg: "'tags' must be an array of strings" };
    const tags = value.map((t) => (typeof t === "string" ? t.trim() : ""));
    if (tags.some((t) => t.length === 0)) return { ok: false, msg: "empty tag in 'tags'" };
    if (tags.some((t) => t.includes(","))) {
      return { ok: false, msg: "a comma inside a tag is indistinguishable from the list separator" };
    }
    return { ok: true, text: tags.join(",") };
  }
  if (key === "priority") {
    if (typeof value === "number") return { ok: true, text: String(value) };
    if (typeof value === "string") return { ok: true, text: value };
    return { ok: false, msg: "'priority' must be P0..P3, 0..3 or a number" };
  }
  if (typeof value !== "string") return { ok: false, msg: `'${key}' must be a string` };
  if (key === "body" && value === "-") {
    // '-' у CLI означает «читать stdin»; в сервере это повисший на stdin
    // процесс, а не правка. Отказ громкий, потому что вариант «молча
    // подставить пустое тело» стёр бы текст узла.
    return { ok: false, msg: "body '-' means stdin for the CLI and makes no sense over HTTP" };
  }
  return { ok: true, text: value };
}

/**
 * Слой при создании: L0–L3, как у parseLayer CLI (ведущая L необязательна).
 * Проверяется здесь, чтобы отказ пришёл до движка с внятной подсказкой.
 */
function layerArg(value: unknown): { ok: true; text: string } | { ok: false; msg: string } {
  if (typeof value !== "string") return { ok: false, msg: "'layer' must be a string L0..L3" };
  const m = /^L?([0-3])$/i.exec(value.trim());
  if (!m) return { ok: false, msg: `invalid layer '${value}'; allowed: L0..L3` };
  return { ok: true, text: `L${m[1]}` };
}

/** Охват сессии (S58): выбор при создании, а не угадывание по содержанию. */
const REACH_CHOICES: readonly string[] = ["session", "project"];

/**
 * Заметка (kind=note) — тем же `myc remember`, что и человек в терминале.
 *
 * Помнить здесь надо не про вид, а про ПОСЛЕДСТВИЯ пути: remember ставит
 * факт в очередь embed+absorb и пишет attrs.source="agent" — то есть заметка
 * из интерфейса попадает в поиск и в absorb-очередь НАРАВНЕ с терминальной.
 * `myc create --kind memory` записал бы тот же вид без очереди и без
 * происхождения: состояние похоже, оплог и дальнейшая судьба — разные, и
 * при синхронизации это расхождение всплыло бы. Заголовок и тело собираются
 * обратно в один факт (первая строка remember берёт в заголовок, весь текст
 * кладёт в тело), поэтому оплог совпадает с `myc remember` до символа.
 *
 * Чего у remember НЕТ — того нет и здесь: приоритет, исполнитель, оценка,
 * родитель и зависимости заметке не вводятся, и молча проглотить их значило
 * бы соврать, что поля записаны.
 */
function planCreateNote(body: Body): WritePlan | WriteOutcome {
  const title = str(body, "title")?.trim();
  if (title === undefined || title.length === 0) {
    return bad("missing 'title'", "POST /api/nodes {kind: 'note', title, body?, tags?…}");
  }
  if (title === "-") {
    // '-' у CLI означает «читать stdin»; заметка с таким текстом повесила бы
    // сервер на stdin вместо записи. Отказ громкий — молча подставить пустое
    // значило бы стереть факт.
    return bad("text '-' means stdin for the CLI and makes no sense over HTTP");
  }
  const bodyText = str(body, "body");
  if (bodyText === "-") {
    return bad("body '-' means stdin for the CLI and makes no sense over HTTP");
  }
  // Помни: splitFact у remember берёт первую строку в заголовок, ВЕСЬ текст —
  // в тело. Собранный здесь текст twin-команда ввела бы сама.
  const text = bodyText !== undefined && bodyText.length > 0 ? `${title}\n${bodyText}` : title;

  const argv: string[] = ["remember", text];
  if (body["status"] !== undefined) {
    return refuse(
      422,
      "precond.use_op",
      "status is not set at creation: a note is born active",
      "note statuses (active/superseded/retracted) are changed by the shared path myc update",
    );
  }
  const tags = body["tags"];
  if (tags !== undefined && tags !== null) {
    const arg = fieldArg("tags", tags);
    if (!arg.ok) return bad(arg.msg);
    argv.push("--tag", arg.text);
  }
  const layer = body["layer"];
  if (layer !== undefined && layer !== null) {
    const arg = layerArg(layer);
    if (!arg.ok) return bad(arg.msg);
    argv.push("--layer", arg.text);
  }
  const acl = body["acl"];
  if (acl !== undefined && acl !== null) {
    const arg = fieldArg("acl", acl);
    if (!arg.ok) return bad(arg.msg);
    argv.push("--acl", arg.text);
  }
  const source = body["source"];
  if (source !== undefined && source !== null) {
    const arg = fieldArg("source", source);
    if (!arg.ok) return bad(arg.msg);
    argv.push("--source", arg.text);
  }
  const anchor = body["anchor"];
  if (anchor !== undefined && anchor !== null) {
    const arg = fieldArg("anchor", anchor);
    if (!arg.ok) return bad(arg.msg);
    argv.push("--anchor", arg.text);
  }
  // Охват — явный выбор; absent = сессионный по умолчанию (S58), ровно как
  // у remember. Проектным знание становится решением, а не догадкой.
  const reach = body["reach"];
  if (reach !== undefined && reach !== null) {
    if (typeof reach !== "string" || !REACH_CHOICES.includes(reach)) {
      return bad(`'reach' must be ${REACH_CHOICES.join(" | ")}`, "session by default; project is an explicit decision");
    }
    argv.push("--reach", reach);
  }
  // Ключ сессии-владельца: из окружения сервера или явный. Пустое окружение
  // не подделывается: у remember охват тогда честно «не записан» + WARN.
  const session = str(body, "session");
  if (session !== undefined) argv.push("--session", session);
  const unknown = Object.keys(body).filter(
    (k) =>
      !["kind", "title", "body", "tags", "layer", "acl", "source", "anchor", "reach", "session", "if_match"].includes(k),
  );
  if (unknown.length > 0) {
    return bad(
      `fields foreign to a note: ${unknown.join(", ")}`,
      "myc remember has no flags for priority, assignee, estimate, parent or dependencies",
    );
  }
  return { argv, clockFields: [] };
}

/** POST /api/nodes — создание узла тем же `myc create`, что и в терминале. */
export function planCreate(body: Body): WritePlan | WriteOutcome {
  const kind = str(body, "kind");
  if (kind === "note") return planCreateNote(body);
  const gap = kind !== undefined ? KIND_GAPS[kind] : undefined;
  if (gap !== undefined) {
    return refuse(501, "unsupported.kind", `kind '${kind}' cannot be created: ${gap}`);
  }
  const title = str(body, "title")?.trim();
  if (title === undefined || title.length === 0) {
    return bad("missing 'title'", "POST /api/nodes {title, kind?, body?, priority?, tags?}");
  }
  if (body["status"] !== undefined) {
    return refuse(
      422,
      "precond.use_op",
      "status is not set at creation: a node is born in the initial status of its scale",
      "status changes go through POST /api/nodes/<id>/op",
    );
  }
  const argv: string[] = ["create", title];
  if (kind !== undefined) argv.push("--kind", CREATE_KIND_ARG[kind] ?? kind);
  for (const key of ["body", "priority", "tags", "assignee", "acl", "estimate"]) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    const arg = fieldArg(key, value);
    if (!arg.ok) return bad(arg.msg);
    argv.push(FIELDS[key]!.flag, arg.text);
  }
  // Охват репозитория (S59): явный --repo сильнее выведенного из пути.
  const repo = str(body, "repo");
  if (repo !== undefined) argv.push("--repo", repo.trim());
  const parent = str(body, "parent");
  if (parent !== undefined) argv.push("--parent", parent);
  const dep = body["dep"];
  if (Array.isArray(dep) && dep.length > 0) argv.push("--dep", dep.join(","));
  const anchor = str(body, "anchor");
  if (anchor !== undefined) argv.push("--anchor", anchor);
  return { argv, clockFields: [] };
}

/** POST /api/nodes/<id> — правка полей тем же `myc update`. */
export function planUpdate(id: string, body: Body): WritePlan | WriteOutcome {
  if (body["status"] !== undefined) {
    const wanted = typeof body["status"] === "string" ? body["status"] : "";
    const route = STATUS_ROUTE[wanted];
    return refuse(
      422,
      "precond.use_op",
      route !== undefined
        ? `status '${wanted}' is not assigned by a write: ${route}`
        : `status is not assigned by a write; operations: ${WRITE_OPS.join(", ")}`,
      `POST /api/nodes/${id}/op {"op":"…"}`,
    );
  }

  const argv: string[] = ["update", id];
  const clockFields: string[] = [];
  let hierarchyTouched = false;
  for (const [key, spec] of Object.entries(FIELDS)) {
    const value = body[key];
    if (value === undefined) continue;
    const arg = fieldArg(key, value);
    if (!arg.ok) return bad(arg.msg);
    argv.push(spec.flag, arg.text);
    clockFields.push(spec.clock);
  }
  for (const key of Object.keys(body)) {
    const gap = FIELD_GAPS[key];
    if (gap !== undefined) {
      return refuse(501, "unsupported.field", `field '${key}' is not written: ${gap}`);
    }
  }
  // Иерархия — РЕБРО, а не поле: у `parent` нет строки в field_clock (рёбра
  // ведутся OR-Set по add_tag), поэтому его нельзя класть в FIELDS — иначе
  // конкурентная правка стала бы сверять часы несуществующего поля. Пустая
  // строка означает «вынуть из эпика»: JSON не различает «не прислали» и
  // «прислали ничего», а --no-parent — отдельный флаг CLI.
  const parentRaw = body["parent"];
  if (parentRaw !== undefined) {
    if (parentRaw === null || (typeof parentRaw === "string" && parentRaw.trim().length === 0)) {
      argv.push("--no-parent");
    } else if (typeof parentRaw === "string") {
      argv.push("--parent", parentRaw.trim());
    } else {
      return bad("'parent' must be an epic id string, or an empty string to leave the epic");
    }
    // Ребро не поле: своих часов у него нет, и в clockFields ему не место.
    // Но проверка «есть ли что делать» ниже смотрит именно туда, поэтому
    // отмечаем работу отдельно.
    hierarchyTouched = true;
  }

  const unknown = Object.keys(body).filter(
    (k) => FIELDS[k] === undefined && k !== "if_match" && k !== "parent",
  );
  if (unknown.length > 0) {
    return bad(
      `unknown fields: ${unknown.join(", ")}`,
      `editable: ${UPDATE_FIELDS.join(", ")}`,
    );
  }
  if (clockFields.length === 0 && !hierarchyTouched) {
    return bad("nothing to update: no fields", `fields: ${UPDATE_FIELDS.join(", ")}, parent`);
  }
  return { argv, clockFields };
}

/** POST /api/nodes/<id>/op — переходы состояния, как у myc_update в MCP. */
export function planOp(id: string, body: Body): WritePlan | WriteOutcome {
  const op = str(body, "op");
  const known = [...WRITE_OPS, ...REVIEW_OPS].join(", ");
  if (op === undefined) return bad("missing 'op'", `operations: ${known}`);
  const gap = OP_GAPS[op];
  if (gap !== undefined) {
    return refuse(501, "unsupported.op", `operation '${op}' is not implemented: ${gap}`);
  }
  if ((REVIEW_OPS as readonly string[]).includes(op)) return planReview(id, op as ReviewOp, body);
  if (!(WRITE_OPS as readonly string[]).includes(op)) {
    return bad(`unknown operation '${op}'`, `allowed: ${known}`);
  }

  const leaseRaw = body["lease_minutes"];
  const lease =
    typeof leaseRaw === "number" && Number.isInteger(leaseRaw) && leaseRaw >= 5 && leaseRaw <= 480
      ? leaseRaw
      : leaseRaw === undefined
        ? 30
        : undefined;
  if (lease === undefined) return bad("'lease_minutes' must be an integer from 5 to 480");

  switch (op as WriteOp) {
    case "claim":
    case "extend": {
      // extend — тот же `myc claim` у нынешнего держателя: команда сама
      // распознаёт продление (renewed) и отказывает чужому конфликтом.
      const argv = ["claim", id, "--lease", `${lease}m`];
      if (body["steal"] === true) argv.push("--steal");
      return { argv, clockFields: [] };
    }
    case "release": {
      const argv = ["release", id];
      if (body["force"] === true) argv.push("--force");
      return { argv, clockFields: [] };
    }
    case "close": {
      const reason = str(body, "reason")?.trim();
      if (reason === undefined || reason.length === 0) {
        return bad("close requires 'reason'", "the reason goes into the project memory");
      }
      const argv = ["close", id, "--reason", reason];
      const outcome = str(body, "outcome");
      if (outcome !== undefined) argv.push("--outcome", outcome);
      const verify = str(body, "verify");
      if (verify !== undefined) argv.push("--verify", verify);
      const dup = str(body, "duplicate_of");
      if (dup !== undefined) argv.push("--dup", dup);
      return { argv, clockFields: [] };
    }
    case "reopen": {
      // Переоткрытие — тот же `update --status open`, что у MCP: охрана
      // guardTaskStatus не пропустит его при живой чужой аренде.
      const reason = str(body, "reason")?.trim();
      if (reason === undefined || reason.length === 0) {
        return bad("reopen requires 'reason'");
      }
      return { argv: ["update", id, "--status", "open"], clockFields: [], warn: [reasonWarn("reopen", reason)] };
    }
    case "cancel": {
      const reason = str(body, "reason")?.trim();
      if (reason === undefined || reason.length === 0) {
        return bad("cancel requires 'reason'", "a cancel is a judgment, and its reason is read later");
      }
      return {
        argv: ["update", id, "--status", "cancelled"],
        clockFields: [],
        warn: [reasonWarn("cancel", reason)],
      };
    }
    case "assign": {
      const assignee = str(body, "assignee");
      if (assignee === undefined) return bad("assign requires 'assignee'");
      return { argv: ["update", id, "--assign", assignee], clockFields: ["assignee"] };
    }
    case "priority": {
      const priority = body["priority"];
      if (priority === undefined) return bad("priority requires 'priority'");
      const arg = fieldArg("priority", priority);
      if (!arg.ok) return bad(arg.msg);
      return { argv: ["update", id, "--priority", arg.text], clockFields: ["priority"] };
    }
  }
}

// ---------------------------------------------------------------------------
// конкурентная правка: CRDT, а не последняя запись
// ---------------------------------------------------------------------------

/**
 * Часы полей узла — основа per-field LWW (`field_clock`, миграция 001).
 *
 * hlc читается CAST-ом в TEXT намеренно: значение (ms << 16 | counter) уже
 * перевалило за 2^53, и bun:sqlite вернул бы его числом с потерей младших
 * разрядов — то есть счётчика, который и разводит две записи одной
 * миллисекунды.
 */
export function nodeClocks(db: ReadOnlyDb, id: string): Record<string, string> {
  const rows = db.all<{ field: string; hlc: string; site_id: string }>(
    "SELECT field, CAST(hlc AS TEXT) AS hlc, site_id FROM field_clock WHERE entity_id = ?1",
    [id],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.field] = `${r.hlc}.${r.site_id}`;
  return out;
}

/**
 * Проверка версии ПО ПОЛЯМ, а не по узлу целиком.
 *
 * Две вкладки, правящие разные поля одного узла, — не конфликт: их сводит
 * per-field LWW движка, обе правки остаются. Конфликт есть только тогда,
 * когда обе тронули ОДНО поле; тогда одна из правок неизбежно исчезнет, и
 * узнать об этом клиент обязан до записи, а не по пропаже текста (И2).
 *
 * Поэтому if_match разрешён только для полей, которые запрос действительно
 * пишет: объявить чужое поле значило бы получить отказ там, где CRDT
 * прекрасно справляется.
 */
export function checkIfMatch(
  db: ReadOnlyDb,
  id: string,
  plan: WritePlan,
  raw: unknown,
): WriteOutcome | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return bad("'if_match' must be an object {field: clock}");
  }
  const declared = raw as Record<string, unknown>;
  const current = nodeClocks(db, id);
  const stale: { field: string; expected: unknown; actual: string | null }[] = [];

  for (const [key, expected] of Object.entries(declared)) {
    const spec = FIELDS[key];
    if (spec === undefined) {
      return bad(`if_match: unknown field '${key}'`, `fields: ${UPDATE_FIELDS.join(", ")}`);
    }
    if (!plan.clockFields.includes(spec.clock)) {
      return bad(
        `if_match: field '${key}' is not written by this request`,
        "clocks are declared only for the request's fields — CRDT merges the rest",
      );
    }
    const actual = current[spec.clock] ?? null;
    if ((expected ?? null) !== actual) stale.push({ field: key, expected: expected ?? null, actual });
  }
  if (stale.length === 0) return undefined;

  return refuse(
    409,
    "conflict.version",
    `node ${id} changed since it was read, fields: ${stale.map((s) => s.field).join(", ")}`,
    "re-read GET /api/nodes/<id>, merge the edit and retry",
    { conflicts: stale, clk: current },
  );
}

// ---------------------------------------------------------------------------
// ACL
// ---------------------------------------------------------------------------

/** Кто пишет. Тот же порядок, что у CLI и MCP: MYC_ACTOR, затем $USER. */
export function principalOf(env: Record<string, string | undefined> = process.env): string {
  return env["MYC_ACTOR"] ?? env["USER"] ?? "agent";
}

/**
 * Отказ ACL — 403 с кодом, а не молчаливое «ок».
 *
 * Проверка включается флагом `myc_meta.acl_enforced` (§10.3): в локальном
 * одно-пользовательском режиме он 0, предикат вырезается целиком, и HTTP
 * ведёт себя ровно как CLI — иначе поверхность оказалась бы строже терминала,
 * то есть опять несимметричной. При acl_enforced=1 узел, невидимый
 * принципалу, не может быть им и изменён: 200 с проглоченной правкой — это
 * ложь клиенту о том, что данные записаны.
 */
export function aclDenial(
  db: ReadOnlyDb,
  id: string,
  principal: string,
): WriteOutcome | undefined {
  if (db.meta("acl_enforced") !== "1") return undefined;
  const row = db.one<{ acl: string; owner_id: string; team_id: string; agent_id: string }>(
    "SELECT acl, owner_id, team_id, agent_id FROM nodes WHERE id = ?1",
    [id],
  );
  if (row === undefined) return undefined; // «нет узла» скажет общий путь записи
  const deny = (why: string): WriteOutcome =>
    refuse(403, "denied.acl", `${id}: ${why} (principal ${principal})`);

  switch (row.acl) {
    case "private":
      return row.owner_id === principal ? undefined : deny("the node is private and owned by someone else");
    case "agent":
      return row.agent_id === principal ? undefined : deny("the node is pinned to another agent");
    case "restricted": {
      const grant = db.one<{ n: number }>(
        "SELECT count(*) AS n FROM acl_grants WHERE node_id = ?1 AND principal = ?2",
        [id, principal],
      );
      return (grant?.n ?? 0) > 0 ? undefined : deny("the node is restricted and there is no grant");
    }
    default:
      return undefined; // team — общий доступ внутри воркспейса
  }
}

// ---------------------------------------------------------------------------
// чтение узла под правку
// ---------------------------------------------------------------------------

export interface NodeView extends Record<string, unknown> {
  readonly id: string;
  readonly clk: Record<string, string>;
}

/** GET /api/nodes/<id> — то, что нужно форме правки: поля и часы полей. */
export function readNodeView(db: ReadOnlyDb, id: string): NodeView | undefined {
  const row = db.one<Record<string, unknown>>(
    `SELECT id, kind, title, body, status, priority, assignee, acl, attrs,
            open_blockers, lease_holder, lease_expires, updated_at, deleted_at
       FROM nodes WHERE id = ?1`,
    [id],
  );
  if (row === undefined) return undefined;
  let attrs: unknown = {};
  try {
    attrs = JSON.parse(String(row["attrs"] ?? "{}"));
  } catch {
    attrs = {};
  }
  return { ...row, id: String(row["id"]), attrs, clk: nodeClocks(db, id) };
}
