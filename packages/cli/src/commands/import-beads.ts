/**
 * `myc import-beads [snapshot.json]` — перенос и синхронизация графа задач и
 * памяти из beads в воркспейс myc (веха M0.5, задачи myc-5ie.1/.3/.4).
 *
 * Снимок команда собирает САМА, вызывая `bd export --include-memories`
 * (JSONL: задачи с метками, зависимостями и notes + память `bd remember`),
 * когда путь к файлу не задан (myc-5ie.4); файл остаётся опцией для переноса
 * между машинами. Три ловушки формы вывода bd нормализуются при разборе:
 *  - `bd show --json` возвращает МАССИВ с одним элементом — разворачивается;
 *  - `bd memories --json` несёт служебные ключи с нестроковыми значениями
 *    (schema_version) — игнорируются, а не роняют разбор;
 *  - `bd list --json` отдаёт зависимости как {depends_on_id, type} —
 *    приводятся к форме show ({id, dependency_type}).
 *
 * Задачи (task/bug/feature/epic/decision) ложатся на kind=task с attrs.type,
 * память `bd remember` — на kind=note слоя L3, заметки `bd note` и
 * комментарии `bd comment` — на kind=note с attrs.type='comment' и ребром
 * replies_to к задаче (S64, тот же вид, что пишут mcp addNote и `myc comment`).
 *
 * НАБОР ЧИТАЕМЫХ ПОЛЕЙ ЗАДАЧИ — ЯВНЫЙ (MAPPED_ISSUE_FIELDS). Пока он был
 * неявным — «то, что упоминает код», — незнакомое поле было неотличимо от
 * отсутствующего, и массив `comments` (156 записей на 53 задачах рабочего
 * cherry) не ввозился и не назывался ВООБЩЕ: отчёт печатал «заметки новых
 * 265» и молчал о потере. Теперь всякое поле вне набора идёт в WARN
 * `import.unknown_fields` с числом задач.
 *
 * Два правила, нарушение которых портит данные тихо:
 * 1. Исходный beads-ID каждой сущности сохраняется в attrs.external_ref —
 *    без него перенос не сверить и ссылки не разрешить. На нём же стоит
 *    идемпотентность: повторный импорт находит узлы по external_ref и не
 *    плодит дублей.
 * 2. Тексты описаний/заметок/памятей переносятся ВЕРБАТИМ. Ссылки вида
 *    `myc-qie.7` внутри текстов НЕ переписываются на новые ID: одна ошибка
 *    в регулярке — и описания неверны незаметно. Ссылки разрешаются через
 *    external_ref при чтении.
 *
 * Повторный импорт — СИНХРОНИЗАЦИЯ, а не только «не плодить дублей»
 * (myc-5ie.3): изменившиеся в beads поля существующих узлов (заголовок,
 * описание, статус, приоритет, исполнитель, метки, причина закрытия,
 * родитель, блокеры) доезжают через обычные мутации графа, то есть попадают
 * в оплог и переживают синхронизацию. База для различения сторон —
 * attrs.beads_sync: слепок значений источника на момент прошлого импорта.
 * Если поле узла расходится со снимком:
 *  - менялся только источник → применяем значение снимка;
 *  - менялся только myc → локальная правка сохраняется, расхождение названо
 *    в kept_local;
 *  - менялись обе стороны → конфликт: ничего не применяется, расхождение
 *    названо в conflicts и называется снова на каждом прогоне, пока его не
 *    разрешат руками.
 * Прогон без изменений в источнике не порождает ни одной мутации в оплоге.
 *
 * Порядок важен: сначала создаются все узлы с финальными статусами, потом
 * рёбра — тогда open_blockers считается движком по уже верным статусам.
 * В конце для гарантии зовётся recountOpenBlockers (он чинит и наследованный
 * anc_blockers), и только если счётчики реально разошлись.
 *
 * ОЧЕРЕДЬ ПОСЛЕ ВВОЗА СХОДИТСЯ С `bd ready` ЗАДАЧА В ЗАДАЧУ. До миграции 10
 * не сходилась: на снимке ~/src/cherry (796 задач, 972 зависимости) `myc
 * ready` давал 195 против 144 у `bd ready`, и все 51 «лишних» были потомками
 * заблокированных эпиков. С наследованием блокеров вниз по `parent` оба
 * множества совпадают — 144 против 144, разности в обе стороны пусты.
 *
 * ИДЕНТИЧНОСТЬ ВВЕЗЁННОГО УЗЛА — ССЫЛКА, А НЕ ТЕКСТ. Дедупликация myc по
 * (scope, kind, content_hash) написана под память: одинаковый текст — один
 * и тот же факт. У записи чужого трекера это неверно, и на настоящем cherry
 * неверно буквально: `cherry-ys5o` (in_progress) и `cherry-xxc9` (open) —
 * разные живые задачи с дословно одинаковым текстом, а 265 заметок `bd note`
 * дают 108 повторов («Agent: general-purpose» у двух десятков задач). Импорт
 * падал на первом же совпадении с `UNIQUE constraint failed`. Миграция 9
 * разводит два способа быть уникальным: свои узлы — по содержимому,
 * ввезённые (те, у кого есть attrs.external_ref) — по этой самой ссылке.
 * Побочный выигрыш: идемпотентность повторного импорта, которую до сих пор
 * держал только код ниже, теперь держит и индекс.
 *
 * НИ ОДНА ОТДЕЛЬНАЯ ЗАПИСЬ НЕ ИМЕЕТ ПРАВА ОТМЕНИТЬ ОСТАЛЬНЫЕ. Три блокера
 * этого импорта до текущего (незнакомый issue_type, JSONL-снимок, приоритет
 * P4) были одной ошибкой: одна строка из 796 давала ноль ввезённых. Поэтому
 * всё, что может не получиться на одной записи, — незнакомый тип, приоритет
 * вне шкалы, столкновение с локальным узлом, тип зависимости без ребра myc —
 * называется поимённо в отчёте и в WARN, а импорт идёт дальше.
 */

import { existsSync, readFileSync } from "node:fs";
import { commentInput, contentHash } from "@myc/core";
import type { EdgeKind, JsonValue, NodeInput, NodePatch, NodeRecord } from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { Command, CommandFailure } from "../registry.ts";
import { flagBool, graphFailure, type StoreDeps, type StoreHandle, realStoreDeps } from "./store.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

// ---------------------------------------------------------------------------
// Схема снапшота (форма `bd show --json`: dependencies развёрнуты в объекты
// с id + dependency_type; notes/close_reason/closed_at — поля задачи).
// `bd list --json` отдаёт зависимости иначе ({depends_on_id, type}) — при
// разборе они приводятся к форме show.
// ---------------------------------------------------------------------------

export interface BeadsDependency {
  readonly id: string;
  readonly dependency_type?: string;
}

/**
 * Комментарий beads — САМОСТОЯТЕЛЬНАЯ запись, а не поле задачи: у него свой
 * автор, своё тело и своё время. Поэтому он ложится отдельным узлом с ребром
 * `replies_to` на задачу, а не приклеивается к её описанию.
 */
export interface BeadsComment {
  readonly id: string;
  readonly issue_id?: string;
  readonly author?: string;
  readonly text: string;
  readonly created_at?: string;
}

export interface BeadsIssue {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: string;
  readonly priority: number;
  readonly issue_type: string;
  readonly assignee?: string;
  readonly labels?: readonly string[];
  readonly dependencies?: readonly BeadsDependency[];
  readonly notes?: string;
  readonly comments?: readonly BeadsComment[];
  readonly close_reason?: string;
  readonly closed_at?: string;
}

export interface BeadsSnapshot {
  readonly issues: readonly BeadsIssue[];
  readonly memories?: Readonly<Record<string, string>>;
  /** Незнакомые myc типы задач и сколько их: ввозятся дословно, но названы. */
  readonly unknownTypes?: Readonly<Record<string, number>>;
  /** Приоритеты, прижатые к шкале myc (у beads P0..P4): «id: P4→P3». */
  readonly clampedPriorities?: readonly string[];
  /**
   * Поля задачи, которых импорт НЕ ЗНАЕТ, и сколько задач их несут. Не повод
   * отказать — повод сказать: см. `KNOWN_ISSUE_FIELDS`.
   */
  readonly unknownFields?: Readonly<Record<string, number>>;
}

/**
 * Типы, которые myc знает по имени. НЕ фильтр: beads — открытый трекер, и
 * пользователь заводит там свои типы. Встреченный незнакомый тип
 * СОХРАНЯЕТСЯ ДОСЛОВНО в `attrs.type` (там и так живёт свободная строка) и
 * называется в отчёте импорта — но импорт не обрывает.
 *
 * Раньше набор был закрытым, и одна задача с типом `chore` рушила ввоз всех
 * 796 задач рабочего репозитория: `недопустимый issue_type 'chore'`, ноль
 * импортировано. Отказ по первой же незнакомой строке ещё и не даёт человеку
 * действовать — он не знает, сколько там таких.
 */
const KNOWN_TASK_TYPES = new Set(["task", "bug", "feature", "epic", "decision"]);
const TASK_STATUSES = new Set(["open", "in_progress", "blocked", "closed", "cancelled"]);

/**
 * Поля задачи beads, которые импорт ЧИТАЕТ. Всё, чего здесь нет, ввозится
 * никуда — и обязано быть НАЗВАНО (И2), а не пропущено молча.
 *
 * Это ограждение написано по цене конкретной потери: массив `comments` — 156
 * записей на 53 задачах рабочего cherry — не упоминался в этом файле ВООБЩЕ,
 * и отчёт про них не говорил ни слова, бодро докладывая «заметки новых 265»
 * (число одних только `notes`). Пока набор известных полей был неявным —
 * «то, что читает код», — незнакомое поле было неотличимо от отсутствующего.
 * Теперь набор явный, и всякое поле вне его попадает в `import.unknown_fields`
 * с числом задач: человек видит, ЧТО именно осталось за бортом, и может
 * решить, дописывать ли ввоз.
 */
const MAPPED_ISSUE_FIELDS = new Set([
  "id",
  "title",
  "description",
  "status",
  "priority",
  "issue_type",
  "assignee",
  "labels",
  "dependencies",
  "notes",
  "comments",
  "close_reason",
  "closed_at",
]);

/**
 * Поля, которые импорт знает и осознанно НЕ ввозит, потому что ввозить нечего:
 * `_type` — тег строки JSONL, а не поле задачи; три счётчика — производные от
 * массивов, которые мы и так ввозим целиком, и после ввоза считаются по ним.
 * Набор держится КОРОТКИМ намеренно: каждое имя здесь — обещание, что за ним
 * нет потери данных. Всё сомнительное (`owner`, `acceptance_criteria`,
 * `design`, времена источника) остаётся незнакомым и называется вслух.
 */
const IGNORED_ISSUE_FIELDS = new Set([
  "_type",
  "comment_count",
  "dependency_count",
  "dependent_count",
]);

/**
 * Комментарий в любой форме bd → {id, text, author?, created_at?}. Запись без
 * текста — не комментарий: ввозить пустое тело значит засорить нить.
 */
function normalizeComment(raw: unknown, where: string): BeadsComment | undefined {
  if (!isRecord(raw)) throw new Error(`${where}: comment is not an object`);
  const text = raw["text"] ?? raw["body"] ?? raw["comment"];
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const id = raw["id"];
  const author = raw["author"] ?? raw["created_by"];
  const createdAt = raw["created_at"];
  return {
    // id у комментария bd есть всегда; если его нет — идентичность строим по
    // порядковому номеру внутри задачи, иначе повторный импорт удвоит нить.
    id: typeof id === "string" && id.length > 0 ? id : typeof id === "number" ? String(id) : where,
    text,
    ...(typeof author === "string" && author.length > 0 ? { author } : {}),
    ...(typeof createdAt === "string" ? { created_at: createdAt } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Зависимость в любой из двух форм bd → форма show ({id, dependency_type}).
 * `bd show --json`: {id, dependency_type}; `bd list --json`:
 * {issue_id, depends_on_id, type}. Без нормализации импорт молча получал
 * сотни ссылок «X → undefined» (myc-5ie.4).
 */
function normalizeDependency(raw: unknown, where: string): BeadsDependency {
  if (!isRecord(raw)) throw new Error(`${where}: dependency is not an object`);
  const id = raw["id"] ?? raw["depends_on_id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${where}: dependency has no id`);
  }
  const type = raw["dependency_type"] ?? raw["type"];
  return { id, ...(typeof type === "string" ? { dependency_type: type } : {}) };
}

/** Разбор и валидация снапшота; кидает Error с понятным сообщением. */
export function parseBeadsSnapshot(text: string): BeadsSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (whole) {
    // Файл-снимок — это то, что напечатал `bd export`, а он печатает JSONL,
    // а не цельный документ. Прежде такой файл отвергался как «не JSON», и
    // единственный документированный способ перенести граф между машинами
    // не работал вовсе. Разбираем построчно тем же кодом, что и живой bd.
    const rows: unknown[] = [];
    const memories: Record<string, string> = {};
    let n = 0;
    for (const line of text.split("\n")) {
      n += 1;
      if (line.trim().length === 0) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        // Не цельный JSON и не JSONL — сообщаем про ПЕРВУЮ ошибку, она
        // понятнее: «строка 2 не разобралась» уводит от настоящей причины,
        // если файл вообще не в том формате.
        throw new Error(
          `not JSON: ${whole instanceof Error ? whole.message : String(whole)}; ` +
            `and not JSONL either: line ${n} does not parse`,
        );
      }
      if (isRecord(row) && row["_type"] === "memory") {
        if (typeof row["key"] === "string" && typeof row["value"] === "string") {
          memories[row["key"]] = row["value"];
        }
        continue;
      }
      rows.push(row);
    }
    if (rows.length === 0) throw new Error("snapshot is empty: no tasks");
    raw = { issues: rows, memories };
  }
  // голый массив — это `bd show <ids...> --json` целиком: считаем его issues
  if (Array.isArray(raw)) raw = { issues: raw };
  if (!isRecord(raw)) throw new Error("snapshot root is not an object");
  if (!Array.isArray(raw["issues"])) throw new Error("no issues array");
  const issues: BeadsIssue[] = [];
  const seen = new Set<string>();
  /** Незнакомые типы и сколько их: не повод отказать, но повод сказать. */
  const unknownTypes = new Map<string, number>();
  /** Приоритеты, прижатые к шкале myc: у beads она шире. */
  const clampedPriorities: string[] = [];
  /** Поля задач, которых импорт не знает, и сколько задач их несут. */
  const unknownFields = new Map<string, number>();
  for (const [i, entry] of (raw["issues"] as unknown[]).entries()) {
    const where = `issues[${i}]`;
    // `bd show --json` по одной задаче — массив из одного объекта
    const item = Array.isArray(entry) && entry.length === 1 && isRecord(entry[0]) ? entry[0] : entry;
    if (!isRecord(item)) throw new Error(`${where}: not an object`);
    const id = item["id"];
    const title = item["title"];
    const status = item["status"];
    const issueType = item["issue_type"];
    const priority = item["priority"];
    if (typeof id !== "string" || id.length === 0) throw new Error(`${where}: no id`);
    if (seen.has(id)) throw new Error(`${where}: duplicate id '${id}'`);
    seen.add(id);
    if (typeof title !== "string") throw new Error(`${where} (${id}): no title`);
    if (typeof status !== "string" || !TASK_STATUSES.has(status)) {
      throw new Error(`${where} (${id}): invalid status '${String(status)}'`);
    }
    if (typeof issueType !== "string" || issueType.length === 0) {
      throw new Error(`${where} (${id}): no issue_type`);
    }
    if (!KNOWN_TASK_TYPES.has(issueType)) unknownTypes.set(issueType, (unknownTypes.get(issueType) ?? 0) + 1);
    // Нечисло — это порча формата, отказ. А вот ЧИСЛО вне 0..3 — не порча:
    // у beads шкала P0..P4, у myc P0..P3, и одна задача с P4 не повод не
    // ввезти остальные 795. Прижимаем к границе и НАЗЫВАЕМ каждую (И2):
    // молча переписать чужой приоритет значит соврать о его данных.
    if (typeof priority !== "number" || !Number.isInteger(priority)) {
      throw new Error(`${where} (${id}): priority is not an integer`);
    }
    let clampedPriority = priority;
    if (priority < 0 || priority > 3) {
      clampedPriority = priority < 0 ? 0 : 3;
      clampedPriorities.push(`${id}: P${priority}→P${clampedPriority}`);
    }
    const deps = item["dependencies"];
    if (deps !== undefined && !Array.isArray(deps)) {
      throw new Error(`${where} (${id}): dependencies is not an array`);
    }
    const rawComments = item["comments"];
    if (rawComments !== undefined && !Array.isArray(rawComments)) {
      throw new Error(`${where} (${id}): comments is not an array`);
    }
    const comments =
      rawComments === undefined
        ? undefined
        : (rawComments as unknown[])
            .map((c, j) => normalizeComment(c, `${where}.comments[${j}]`))
            .filter((c): c is BeadsComment => c !== undefined);
    // Незнакомые поля считаем ПО ЗАДАЧАМ, а не по вхождениям: человеку важно
    // «сколько задач несут потерю», а не «сколько раз встретилось имя».
    for (const key of Object.keys(item)) {
      if (MAPPED_ISSUE_FIELDS.has(key) || IGNORED_ISSUE_FIELDS.has(key)) continue;
      unknownFields.set(key, (unknownFields.get(key) ?? 0) + 1);
    }
    issues.push({
      ...(item as unknown as BeadsIssue),
      priority: clampedPriority,
      ...(deps !== undefined
        ? { dependencies: (deps as unknown[]).map((d, j) => normalizeDependency(d, `${where}.dependencies[${j}]`)) }
        : {}),
      ...(comments !== undefined ? { comments } : {}),
    });
  }
  const memories = raw["memories"];
  let cleanMemories: Record<string, string> | undefined;
  if (memories !== undefined) {
    if (!isRecord(memories)) throw new Error("memories is not an object");
    // служебные ключи bd (schema_version и т.п.) — не память, игнорируем
    cleanMemories = {};
    for (const [k, v] of Object.entries(memories)) {
      if (typeof v === "string") cleanMemories[k] = v;
    }
  }
  return {
    issues,
    memories: cleanMemories,
    ...(unknownTypes.size > 0 ? { unknownTypes: Object.fromEntries(unknownTypes) } : {}),
    ...(clampedPriorities.length > 0 ? { clampedPriorities } : {}),
    ...(unknownFields.size > 0 ? { unknownFields: Object.fromEntries(unknownFields) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Живой снимок через bd (myc-5ie.4)
// ---------------------------------------------------------------------------

function runBd(cwd: string, args: readonly string[]): string {
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["bd", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new Error(
      `bd failed to start (${e instanceof Error ? e.message : String(e)}); ` +
        "you can build the snapshot by hand and pass it as a file: myc import-beads snapshot.json",
    );
  }
  if (r.exitCode !== 0) {
    const err = r.stderr?.toString().trim() ?? "";
    throw new Error(
      `bd ${args[0]} exited with code ${r.exitCode}${err.length > 0 ? `: ${err}` : ""}; ` +
        "you can build the snapshot by hand and pass it as a file: myc import-beads snapshot.json",
    );
  }
  return r.stdout?.toString() ?? "";
}

/**
 * Собрать снимок из живого beads в каталоге cwd одной командой:
 * `bd export --include-memories` отдаёт JSONL — строка на задачу (включая
 * закрытые, с метками, зависимостями, notes, close_reason/closed_at) и
 * строки {_type:"memory", key, value} для `bd remember`. Зависимости в
 * выводе export — в форме {depends_on_id, type}, их нормализует
 * parseBeadsSnapshot, через него же проходит валидация.
 */
export function collectBeadsSnapshot(cwd: string): BeadsSnapshot {
  const out = runBd(cwd, ["export", "--include-memories"]);
  const issues: unknown[] = [];
  const memories: Record<string, string> = {};
  for (const [n, line] of out.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`bd export: line ${n + 1} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isRecord(row)) throw new Error(`bd export: line ${n + 1} is not an object`);
    if (row["_type"] === "memory") {
      if (typeof row["key"] === "string" && typeof row["value"] === "string") {
        memories[row["key"]] = row["value"];
      }
      continue;
    }
    issues.push(row);
  }
  return parseBeadsSnapshot(JSON.stringify({ issues, memories }));
}

// ---------------------------------------------------------------------------
// Маппинг в форму узлов myc
// ---------------------------------------------------------------------------

function parseClosedAt(issue: BeadsIssue): number | null {
  if (issue.closed_at === undefined) return null;
  const ts = Date.parse(issue.closed_at);
  return Number.isNaN(ts) ? null : ts;
}

/** Задача beads → kind=task; исходный ID — в attrs.external_ref. Тексты вербатим. */
export function issueToNodeInput(issue: BeadsIssue, scope: string, actor: string): NodeInput {
  const attrs: Record<string, JsonValue> = {
    type: issue.issue_type,
    external_ref: issue.id,
  };
  const labels = issue.labels?.filter((l) => l.length > 0) ?? [];
  if (labels.length > 0) attrs["tags"] = [...labels];
  if (issue.status === "closed" && issue.close_reason !== undefined && issue.close_reason.length > 0) {
    // та же форма, что пишет `myc close --reason` (attrs.outcome.reason)
    attrs["outcome"] = { reason: issue.close_reason };
  }
  const body = issue.description !== undefined && issue.description.trim().length > 0
    ? issue.description
    : null;
  const closedAt = issue.status === "closed" ? parseClosedAt(issue) : null;
  return {
    kind: "task",
    scope,
    title: issue.title,
    body,
    status: issue.status,
    priority: issue.priority,
    ...(issue.assignee !== undefined && issue.assignee.length > 0 ? { assignee: issue.assignee } : {}),
    ...(closedAt !== null ? { closed_at: closedAt } : {}),
    actor,
    attrs,
  };
}

const TITLE_MAX = 120;

function titleOf(text: string): string {
  const firstLine = (text.trim().split("\n", 1)[0] ?? "").trim();
  return firstLine.length <= TITLE_MAX ? firstLine : `${firstLine.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** Заметка `bd note` → тот же вид узла, что у комментария (S64); текст вербатим. */
export function noteToNodeInput(issue: BeadsIssue, notes: string, scope: string, actor: string): NodeInput {
  return commentInput({
    text: notes,
    title: titleOf(notes).slice(0, 80),
    scope,
    actor,
    external_ref: `${issue.id}#notes`,
  });
}

/** ISO-время источника → epoch ms; неразбираемое — просто отсутствует. */
function parseAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Комментарий beads → тот же вид узла, что у mcp addNote и у заметки:
 * kind=note, layer=1, attrs.type='comment', ребро `replies_to` на задачу (S64).
 *
 * Автор комментария — СВОЙ, а не автор импорта: в `actor` уходит `author`
 * записи, и только когда его нет, — тот, кто запустил ввоз. Иначе 156 чужих
 * реплик подписались бы одним именем, и нить перестала бы быть разговором.
 *
 * Время источника кладётся в `attrs.external_created_at`: `created_at` узла
 * ставит движок (это время ЗАПИСИ, оно у всех ввезённых одинаковое с точностью
 * до миллисекунд), а нить читается по времени СОБЫТИЯ — иначе порядок реплик
 * внутри задачи определялся бы случайным порядком id.
 */
export function commentToNodeInput(
  issue: BeadsIssue,
  comment: BeadsComment,
  scope: string,
  actor: string,
): NodeInput {
  const at = parseAt(comment.created_at);
  return commentInput({
    text: comment.text,
    title: titleOf(comment.text),
    scope,
    actor: comment.author !== undefined && comment.author.length > 0 ? comment.author : actor,
    external_ref: commentRef(issue, comment),
    ...(at !== undefined ? { external_created_at: at } : {}),
  });
}

/** Идентичность ввезённого комментария: на ней стоит идемпотентность. */
export function commentRef(issue: BeadsIssue, comment: BeadsComment): string {
  return `${issue.id}#comment:${comment.id}`;
}

/** Память `bd remember` → kind=note слоя L3; ключ и исходный ID сохраняются. */
export function memoryToNodeInput(key: string, text: string, scope: string, actor: string): NodeInput {
  return {
    kind: "note",
    scope,
    layer: 3,
    title: titleOf(text),
    body: text,
    actor,
    attrs: { external_ref: `bd-remember:${key}`, memory_key: key },
  };
}

// ---------------------------------------------------------------------------
// Синхронизация существующих узлов (myc-5ie.3)
// ---------------------------------------------------------------------------

/**
 * Атрибут со слепком значений источника на момент прошлого импорта. Без него
 * не отличить «поле поменяли в beads» от «поле поменяли в myc» — а затирать
 * локальные правки молча нельзя.
 */
const BASELINE_ATTR = "beads_sync";

/** Слепок одной стороны. Ключи в фиксированном порядке — JSON стабилен. */
interface BeadsBaseline {
  readonly title: string;
  readonly body: string | null;
  readonly status: string;
  readonly priority: number;
  readonly assignee: string;
  readonly tags: readonly string[];
  readonly outcome: JsonValue;
  readonly closed_at: number | null;
  readonly parent: string | null;
  readonly blocks: readonly string[];
}

const BASELINE_FIELDS = [
  "title", "body", "status", "priority", "assignee", "tags", "outcome", "closed_at", "parent", "blocks",
] as const;
type BaselineField = (typeof BASELINE_FIELDS)[number];

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Значения задачи снимка как слепок; parent/blocks — из зависимостей. */
function snapshotBaseline(issue: BeadsIssue): BeadsBaseline {
  const deps = decomposeDeps(issue);
  const body = issue.description !== undefined && issue.description.trim().length > 0
    ? issue.description
    : null;
  return {
    title: issue.title,
    body,
    status: issue.status,
    priority: issue.priority,
    assignee: issue.assignee ?? "",
    tags: [...(issue.labels?.filter((l) => l.length > 0) ?? [])].sort(),
    outcome:
      issue.status === "closed" && issue.close_reason !== undefined && issue.close_reason.length > 0
        ? { reason: issue.close_reason }
        : null,
    closed_at: issue.status === "closed" ? parseClosedAt(issue) : null,
    parent: deps.parent,
    blocks: deps.blocks,
  };
}

/** Текущие значения узла как слепок; рёбра — в терминах external_ref. */
function localBaseline(
  node: NodeRecord,
  parentRef: string | null,
  blockRefs: readonly string[],
): BeadsBaseline {
  return {
    title: node.title,
    body: node.body,
    status: node.status,
    priority: node.priority,
    assignee: node.assignee,
    tags: [...((node.attrs["tags"] as string[] | undefined) ?? [])].sort(),
    outcome: node.attrs["outcome"] ?? null,
    closed_at: node.closed_at,
    parent: parentRef,
    blocks: [...blockRefs].sort(),
  };
}

/**
 * Типы зависимостей beads, кроме blocks/parent-child, у которых есть точный
 * смысловой аналог среди рёбер myc. Строка beads {issue_id: X,
 * depends_on_id: Y, type: T} читается «Y делает T с X» — так же, как её
 * читают blocks (Y блокирует X) и parent-child (Y родитель X); исключение —
 * discovered-from, где направление обратное по самой формулировке («X
 * обнаружена ИЗ Y»). Поэтому у каждого типа записано, какой конец идёт в src.
 *
 * Без этой таблицы 4 зависимости настоящего cherry (discovered-from ×3,
 * supersedes ×1) не ввозились вовсе, а в отчёте назывались «без цели» —
 * то есть терялись под сообщением о другой беде.
 */
const EXTRA_DEP_EDGES: Readonly<Record<string, { readonly type: EdgeKind; readonly srcIsIssue: boolean }>> = {
  // «X обнаружена при работе над Y» → src=X выведен из dst=Y
  "discovered-from": { type: "derived_from", srcIsIssue: true },
  // `bd supersede X --with=Y` → src=Y заменяет dst=X
  supersedes: { type: "supersedes", srcIsIssue: false },
};

/** Зависимость, для которой ребро myc есть, но она не участвует в слепке. */
interface ExtraDep {
  readonly ref: string;
  readonly type: EdgeKind;
  readonly srcIsIssue: boolean;
}

/** Зависимости задачи, разложенные по смыслу; неизвестные типы — отдельно. */
function decomposeDeps(issue: BeadsIssue): {
  readonly parent: string | null;
  readonly blocks: readonly string[];
  readonly extra: readonly ExtraDep[];
  readonly unknown: readonly { readonly id: string; readonly type: string | undefined }[];
} {
  let parent: string | null = null;
  const blocks: string[] = [];
  const extra: ExtraDep[] = [];
  const unknown: { id: string; type: string | undefined }[] = [];
  for (const dep of issue.dependencies ?? []) {
    const mapped = dep.dependency_type === undefined ? undefined : EXTRA_DEP_EDGES[dep.dependency_type];
    if (dep.dependency_type === "blocks") blocks.push(dep.id);
    else if (dep.dependency_type === "parent-child") parent = dep.id;
    else if (mapped !== undefined) extra.push({ ref: dep.id, ...mapped });
    else unknown.push({ id: dep.id, type: dep.dependency_type });
  }
  return { parent, blocks: blocks.sort(), extra, unknown };
}

type FieldDecision = "sync" | "apply" | "keep" | "conflict";

/**
 * Решение по одному полю. Без слепка (первый прогон после появления
 * синхронизации) источник считается единственной правдой: узел до этого был
 * создан импортом, и расхождение — почти наверняка правка в beads.
 */
function decide(snap: unknown, local: unknown, base: unknown, hasBase: boolean): FieldDecision {
  if (jsonEq(snap, local)) return "sync";
  if (!hasBase) return "apply";
  if (jsonEq(snap, base)) return "keep";
  if (jsonEq(local, base)) return "apply";
  return "conflict";
}

const FMT_MAX = 80;

function fmtVal(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length <= FMT_MAX ? s : `${s.slice(0, FMT_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// Импорт
// ---------------------------------------------------------------------------

export interface ImportBeadsData {
  snapshot: string;
  dry_run: boolean;
  issues_total: number;
  tasks_created: number;
  tasks_existing: number;
  tasks_updated: number;
  fields_updated: number;
  edges_created: number;
  edges_existing: number;
  edges_removed: number;
  notes_created: number;
  notes_existing: number;
  comments_created: number;
  comments_existing: number;
  memories_created: number;
  memories_existing: number;
  blockers_recounted: number;
  missing_refs: string[];
  /** Зависимости, тип которых myc нечем выразить: названы, а не «без цели». */
  unknown_dep_types: string[];
  /**
   * Что не ввезено и ПОЧЕМУ, поимённо. Единственный класс причин здесь —
   * столкновение идентичностей: в scope уже лежит СВОЙ узел myc с тем же
   * содержимым (у своих идентичность по тексту, §ux_nodes_content). Импорт
   * от такой строки не обрывается: одна запись из 796 не имеет права
   * отменить остальные 795.
   */
  skipped: string[];
  conflicts: string[];
  kept_local: string[];
  took_ms: number;
}

const SCAN_LIMIT = 1_000_000;

/**
 * Два индекса за один скан scope — по обоим способам быть уникальным
 * (миграция 9):
 *  - `byRef`: external_ref → id, идентичность ввезённого узла;
 *  - `byContent`: `kind\u0000content_hash` → id по узлам БЕЗ external_ref,
 *    то есть по тем, что myc завёл сам и у которых идентичность по тексту.
 *
 * Второй нужен, чтобы столкновение с локальным узлом было НАЗВАНО заранее и
 * поимённо, а не вылезло как `UNIQUE constraint failed` из глубины стора.
 */
function scopeIndexes(h: StoreHandle): {
  readonly byRef: Map<string, string>;
  readonly byContent: Map<string, string>;
} {
  const byRef = new Map<string, string>();
  const byContent = new Map<string, string>();
  for (const kind of ["task", "note"] as const) {
    for (const n of h.store.listNodes(h.scope, kind, SCAN_LIMIT)) {
      const ref = n.attrs["external_ref"];
      if (typeof ref === "string") {
        if (!byRef.has(ref)) byRef.set(ref, n.id);
        continue;
      }
      const key = contentKey(kind, n.title, n.body);
      if (!byContent.has(key)) byContent.set(key, n.id);
    }
  }
  return { byRef, byContent };
}

/** Ключ индекса содержимого: тот же (kind, content_hash), что в ux_nodes_content. */
function contentKey(kind: string, title: string, body: string | null | undefined): string {
  return `${kind}\u0000${contentHash(kind, title, body)}`;
}

/** Накопленные по узлу решения синхронизации; запись — после разбора рёбер. */
interface NodeSync {
  readonly nodeId: string;
  readonly baselineNew: Record<BaselineField, unknown>;
  readonly columns: Record<string, JsonValue>;
  readonly attrsPatch: Record<string, JsonValue>;
  applied: boolean;
}

export function importBeadsSnapshot(
  h: StoreHandle,
  snapshot: BeadsSnapshot,
  opts: { readonly dryRun: boolean; readonly snapshotName: string },
): ImportBeadsData {
  const t0 = performance.now();
  const dry = opts.dryRun;
  const { byRef: existing, byContent } = scopeIndexes(h);
  const refById = new Map<string, string>();
  for (const [ref, id] of existing) refById.set(id, ref);
  const refOf = (id: string): string => refById.get(id) ?? `myc:${id}`;

  const data: ImportBeadsData = {
    snapshot: opts.snapshotName,
    dry_run: dry,
    issues_total: snapshot.issues.length,
    tasks_created: 0,
    tasks_existing: 0,
    tasks_updated: 0,
    fields_updated: 0,
    edges_created: 0,
    edges_existing: 0,
    edges_removed: 0,
    notes_created: 0,
    notes_existing: 0,
    comments_created: 0,
    comments_existing: 0,
    memories_created: 0,
    memories_existing: 0,
    blockers_recounted: 0,
    missing_refs: [],
    unknown_dep_types: [],
    skipped: [],
    conflicts: [],
    kept_local: [],
    took_ms: 0,
  };

  const resolveRef = (ref: string): string | undefined => idByRef.get(ref) ?? existing.get(ref);

  /**
   * Создать узел, НЕ обрывая ввоз на первой же неудаче. Три починенных до
   * этой блокера были одной и той же ошибкой: одна строка из 796 отменяла
   * все остальные. Поэтому и здесь неудача — это строка отчёта с именем
   * записи и причиной, а не исключение наружу.
   *
   * Столкновение с локальным узлом ловится ДО записи, по индексу содержимого:
   * так в сообщении есть id обеих сторон. `catch` за ним — сеть под сетью:
   * любое иное нарушение уникальности тоже обязано остаться одной пропущенной
   * записью, а не оборвать импорт на середине.
   */
  const createGuarded = (
    input: NodeInput,
    ref: string,
    what: string,
  ): string | undefined => {
    const clash = byContent.get(contentKey(String(input.kind), input.title ?? "", input.body));
    if (clash !== undefined) {
      data.skipped.push(
        `${ref}: ${what} not imported — myc already has its own node ${clash} ` +
          `with the same title and body (native nodes are identified by content); ` +
          `make the texts differ or delete the local duplicate, then re-run the import`,
      );
      return undefined;
    }
    if (dry) return `dry:${ref}`;
    try {
      return h.store.createNode(input).id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE constraint failed/i.test(msg)) throw e;
      data.skipped.push(`${ref}: ${what} not imported — node uniqueness violation (${msg})`);
      return undefined;
    }
  };

  // Проход 1: узлы задач с финальными статусами — до любых рёбер. Для
  // существующих — решения по полям, запись откладывается до прохода 3,
  // чтобы слепок (attrs.beads_sync) ушёл одной мутацией вместе с правками.
  //
  // В сухом прогоне узлы не пишутся, но ИМЕНА им выдаются (`dry:<ref>`):
  // без них ни одна ссылка не разрешалась, и сухой прогон настоящего cherry
  // докладывал «972 зависимости без цели» там, где не было ни одной, —
  // ровно то сообщение, по которому потом ищут потерю графа связей.
  const idByRef = new Map<string, string>();
  const syncs = new Map<string, NodeSync>();
  for (const issue of snapshot.issues) {
    const known = existing.get(issue.id);
    if (known === undefined) {
      const input = issueToNodeInput(issue, h.scope, h.actor);
      const id = createGuarded(
        { ...input, attrs: { ...input.attrs, [BASELINE_ATTR]: snapshotBaseline(issue) as unknown as JsonValue } },
        issue.id,
        "task",
      );
      if (id === undefined) continue;
      idByRef.set(issue.id, id);
      data.tasks_created++;
      continue;
    }
    idByRef.set(issue.id, known);
    data.tasks_existing++;

    const node = h.store.getNode(known);
    if (node === undefined) continue;
    const oldBase = isRecord(node.attrs[BASELINE_ATTR]) ? node.attrs[BASELINE_ATTR] : undefined;
    const hasBase = oldBase !== undefined;
    const snap = snapshotBaseline(issue);
    const local = localBaseline(node, null, []); // рёбра — проход 2
    const baselineNew = {} as Record<BaselineField, unknown>;
    const columns: Record<string, JsonValue> = {};
    const attrsPatch: Record<string, JsonValue> = {};
    const sync: NodeSync = { nodeId: known, baselineNew, columns, attrsPatch, applied: false };

    const field = (
      name: BaselineField,
      put: (value: JsonValue) => void,
    ): void => {
      const d = decide(snap[name], local[name], oldBase?.[name], hasBase);
      if (d === "apply") {
        put(snap[name] as JsonValue);
        sync.applied = true;
        data.fields_updated++;
      } else if (d === "keep") {
        data.kept_local.push(
          `${issue.id}.${name}: local edit kept (in beads: ${fmtVal(snap[name])})`,
        );
      } else if (d === "conflict") {
        data.conflicts.push(
          `${issue.id}.${name}: conflict — beads has '${fmtVal(snap[name])}', myc has '${fmtVal(local[name])}', ` +
            `last import had '${fmtVal(oldBase?.[name])}'`,
        );
      }
      // слепок следует за источником; при конфликте остаётся старым, чтобы
      // расхождение называлось снова на каждом прогоне
      baselineNew[name] = d === "conflict" ? oldBase?.[name] : snap[name];
    };

    field("title", (v) => (columns["title"] = v));
    field("body", (v) => (columns["body"] = v));
    field("status", (v) => (columns["status"] = v));
    field("priority", (v) => (columns["priority"] = v));
    field("assignee", (v) => (columns["assignee"] = v));
    field("tags", (v) => (attrsPatch["tags"] = v));
    field("outcome", (v) => (attrsPatch["outcome"] = v));
    field("closed_at", (v) => (columns["closed_at"] = v));
    syncs.set(issue.id, sync);
  }

  // Проход 2: рёбра. beads: «X зависит от Y (blocks)» — значит Y blocks X;
  // «parent-child» — X parent Y (ребро ребёнок → родитель, как `myc create --parent`).
  // Новые узлы — как раньше, все рёбра снимка. Существующие — синхронизация
  // множеств parent/blocks по тем же правилам, что поля.
  for (const issue of snapshot.issues) {
    const childId = idByRef.get(issue.id);
    const deps = decomposeDeps(issue);
    // Тип зависимости, которому в myc нечего сопоставить, — это НЕ «ссылка
    // без цели»: цель есть, выразить нечем. Общая строка про потерянные цели
    // прятала бы разную беду под одним числом.
    for (const u of deps.unknown) {
      data.unknown_dep_types.push(`${issue.id} → ${u.id}: type '${u.type ?? "?"}' is not imported`);
    }

    // Зависимости со своим ребром myc (derived_from, supersedes). В слепок
    // они не входят: слепок ведёт синхронизацию parent/blocks, а эти рёбра
    // только добавляются — снять их можно и руками, а вот потерять нельзя.
    for (const extra of deps.extra) {
      const otherId = resolveRef(extra.ref);
      if (childId === undefined || otherId === undefined) {
        data.missing_refs.push(`${issue.id} → ${extra.ref}`);
        continue;
      }
      const src = extra.srcIsIssue ? childId : otherId;
      const dst = extra.srcIsIssue ? otherId : childId;
      if (h.store.getEdge(src, extra.type, dst) !== undefined) {
        data.edges_existing++;
        continue;
      }
      if (!dry) h.store.addEdge(src, extra.type, dst);
      data.edges_created++;
    }

    const sync = syncs.get(issue.id);
    if (sync === undefined) {
      // новый узел: рёбра только добавляются
      for (const ref of [deps.parent, ...deps.blocks]) {
        if (ref === null) continue;
        const depId = resolveRef(ref);
        if (childId === undefined || depId === undefined) {
          data.missing_refs.push(`${issue.id} → ${ref}`);
          continue;
        }
        const isParent = ref === deps.parent;
        const src = isParent ? childId : depId;
        const dst = isParent ? depId : childId;
        const type = isParent ? "parent" : "blocks";
        if (h.store.getEdge(src, type, dst) !== undefined) {
          data.edges_existing++;
          continue;
        }
        if (!dry) h.store.addEdge(src, type, dst);
        data.edges_created++;
      }
      continue;
    }

    // существующий узел: локальные рёбра в терминах external_ref
    const liveParent = childId === undefined
      ? undefined
      : h.store.edgesFrom(childId, "parent").find((e) => e.deleted_at === null);
    const localParent = liveParent === undefined ? null : refOf(liveParent.dst);
    const localBlocks = childId === undefined
      ? []
      : h.store.edgesTo(childId, "blocks").filter((e) => e.deleted_at === null).map((e) => refOf(e.src)).sort();
    const baselineNew = sync.baselineNew;
    const node = h.store.getNode(sync.nodeId);
    const storedBase = node !== undefined && isRecord(node.attrs[BASELINE_ATTR])
      ? node.attrs[BASELINE_ATTR]
      : undefined;
    const hasBase = storedBase !== undefined;

    // parent — скаляр
    {
      const d = decide(deps.parent, localParent, storedBase?.["parent"], hasBase);
      if (d === "apply") {
        if (deps.parent === null && liveParent !== undefined) {
          if (!dry) h.store.removeEdge(sync.nodeId, "parent", liveParent.dst);
          data.edges_removed++;
          sync.applied = true;
        } else if (deps.parent !== null) {
          const depId = resolveRef(deps.parent);
          if (depId === undefined) {
            data.missing_refs.push(`${issue.id} → ${deps.parent}`);
          } else {
            if (!dry) h.store.addEdge(sync.nodeId, "parent", depId);
            data.edges_created++;
            sync.applied = true;
          }
        }
      } else {
        if (deps.parent !== null && deps.parent === localParent) data.edges_existing++;
        if (d === "keep" && !jsonEq(deps.parent, localParent)) {
          data.kept_local.push(
            `${issue.id}.parent: local edit kept (in beads: ${fmtVal(deps.parent)})`,
          );
        } else if (d === "conflict") {
          data.conflicts.push(
            `${issue.id}.parent: conflict — beads has '${fmtVal(deps.parent)}', myc has '${fmtVal(localParent)}', ` +
              `last import had '${fmtVal(storedBase?.["parent"])}'`,
          );
        }
      }
      baselineNew["parent"] = d === "conflict" ? storedBase?.["parent"] : deps.parent;
    }

    // blocks — множество
    {
      const snapBlocks = deps.blocks;
      const d = decide(snapBlocks, localBlocks, storedBase?.["blocks"], hasBase);
      if (d === "apply") {
        data.edges_existing += snapBlocks.filter((r) => localBlocks.includes(r)).length;
        for (const ref of snapBlocks.filter((r) => !localBlocks.includes(r))) {
          const depId = resolveRef(ref);
          if (depId === undefined) {
            data.missing_refs.push(`${issue.id} → ${ref}`);
            continue;
          }
          if (!dry) h.store.addEdge(depId, "blocks", sync.nodeId);
          data.edges_created++;
          sync.applied = true;
        }
        for (const ref of localBlocks.filter((r) => !snapBlocks.includes(r))) {
          const depId = resolveRef(ref);
          if (depId === undefined) continue;
          if (!dry) h.store.removeEdge(depId, "blocks", sync.nodeId);
          data.edges_removed++;
          sync.applied = true;
        }
      } else {
        data.edges_existing += snapBlocks.filter((r) => localBlocks.includes(r)).length;
        if (d === "keep" && !jsonEq(snapBlocks, localBlocks)) {
          data.kept_local.push(
            `${issue.id}.blocks: local edit kept (in beads: ${fmtVal(snapBlocks)})`,
          );
        } else if (d === "conflict") {
          data.conflicts.push(
            `${issue.id}.blocks: conflict — beads has '${fmtVal(snapBlocks)}', myc has '${fmtVal(localBlocks)}', ` +
              `last import had '${fmtVal(storedBase?.["blocks"])}'`,
          );
        }
      }
      baselineNew["blocks"] = d === "conflict" ? storedBase?.["blocks"] : snapBlocks;
    }
  }

  // Проход 3: записать накопленные правки и слепки существующих узлов.
  for (const sync of syncs.values()) {
    if (sync.applied) data.tasks_updated++;
    const node = h.store.getNode(sync.nodeId);
    if (node === undefined) continue;
    const hasPatch = Object.keys(sync.columns).length > 0 || Object.keys(sync.attrsPatch).length > 0;
    const baseChanged = !jsonEq(node.attrs[BASELINE_ATTR] ?? undefined, sync.baselineNew);
    if (!hasPatch && !baseChanged) continue;
    if (!dry) {
      h.store.updateNode(sync.nodeId, {
        ...(sync.columns as NodePatch),
        attrs: { ...sync.attrsPatch, [BASELINE_ATTR]: sync.baselineNew as JsonValue },
      });
    }
  }

  // Проход 4: заметки bd note — отдельные note-узлы с replies_to к задаче.
  for (const issue of snapshot.issues) {
    const notes = issue.notes;
    if (notes === undefined || notes.trim().length === 0) continue;
    const ref = `${issue.id}#notes`;
    if (existing.has(ref)) {
      data.notes_existing++;
      continue;
    }
    const taskId = idByRef.get(issue.id);
    if (taskId === undefined) {
      // задача пропущена столкновением — её заметке не к чему прицепиться
      data.skipped.push(`${ref}: note not imported — task ${issue.id} itself was not imported`);
      continue;
    }
    const noteId = createGuarded(noteToNodeInput(issue, notes, h.scope, h.actor), ref, "note");
    if (noteId === undefined) continue;
    if (!dry) h.store.addEdge(noteId, "replies_to", taskId);
    data.notes_created++;
  }

  // Проход 4б: комментарии `bd comment` — отдельные узлы того же вида, что и
  // заметки (S64: комментарий это kind=note + attrs.type='comment'), с ребром
  // `replies_to` на свою задачу и СВОИМ автором в actor.
  //
  // Отдельный проход, а не ветка внутри прохода 4: у задачи бывают и `notes`,
  // и `comments` сразу (в cherry — у 53 задач), это разные сущности beads, и
  // считаются они порознь. Идемпотентность держится на external_ref
  // `<issue>#comment:<id>`, как у всего остального ввезённого.
  for (const issue of snapshot.issues) {
    for (const comment of issue.comments ?? []) {
      const ref = commentRef(issue, comment);
      if (existing.has(ref)) {
        data.comments_existing++;
        continue;
      }
      const taskId = idByRef.get(issue.id);
      if (taskId === undefined) {
        data.skipped.push(`${ref}: comment not imported — task ${issue.id} itself was not imported`);
        continue;
      }
      const id = createGuarded(
        commentToNodeInput(issue, comment, h.scope, h.actor),
        ref,
        "comment",
      );
      if (id === undefined) continue;
      if (!dry) h.store.addEdge(id, "replies_to", taskId);
      data.comments_created++;
    }
  }

  // Проход 5: память bd remember → kind=note L3.
  for (const [key, text] of Object.entries(snapshot.memories ?? {})) {
    const ref = `bd-remember:${key}`;
    if (existing.has(ref)) {
      data.memories_existing++;
      continue;
    }
    if (createGuarded(memoryToNodeInput(key, text, h.scope, h.actor), ref, "memory") === undefined) {
      continue;
    }
    data.memories_created++;
  }

  // Пересчёт — только когда счётчики реально разошлись: лишний UPDATE при
  // чистом прогоне не нужен, а оплог он не трогает в любом случае.
  // Наследованный счётчик (миграция 10) сверяется тоже: рёбра `parent` и
  // `blocks` приезжают вперемешку, и разъехаться он может независимо.
  if (!dry && (h.store.openBlockersDrift().length > 0 || h.store.ancBlockersDrift().length > 0)) {
    data.blockers_recounted = h.store.recountOpenBlockers();
  }
  data.took_ms = Math.round(performance.now() - t0);
  return data;
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

function renderImportBeadsHuman(raw: unknown): string {
  const d = raw as ImportBeadsData;
  const head = d.dry_run ? "dry-run, nothing written: would import" : "imported";
  const lines = [
    `${head} from ${d.snapshot}`,
    `tasks     ${d.issues_total}: new ${d.tasks_created}, existing ${d.tasks_existing}` +
      (d.tasks_updated > 0 ? `, updated ${d.tasks_updated} (${d.fields_updated} fields)` : ""),
    `edges     new ${d.edges_created}, existing ${d.edges_existing}` +
      (d.edges_removed > 0 ? `, removed ${d.edges_removed}` : ""),
    `notes     new ${d.notes_created}, existing ${d.notes_existing}`,
    `comments  new ${d.comments_created}, existing ${d.comments_existing}`,
    `memories  new ${d.memories_created}, existing ${d.memories_existing}`,
  ];
  if (!d.dry_run && d.blockers_recounted > 0) {
    lines.push(
      `open_blockers recounted on ${d.blockers_recounted} ${d.blockers_recounted === 1 ? "node" : "nodes"}`,
    );
  }
  if (d.kept_local.length > 0) {
    lines.push(
      `local edits kept (${d.kept_local.length}): ${d.kept_local.slice(0, 3).join(", ")}` +
        (d.kept_local.length > 3 ? "…" : ""),
    );
  }
  if (d.conflicts.length > 0) {
    lines.push(
      `! conflicts (${d.conflicts.length}), myc applied nothing: ${d.conflicts.slice(0, 3).join(", ")}` +
        (d.conflicts.length > 3 ? "…" : ""),
    );
  }
  if (d.skipped.length > 0) {
    lines.push(
      `! not imported (${d.skipped.length}): ${d.skipped.slice(0, 3).join("; ")}` +
        (d.skipped.length > 3 ? "…" : ""),
    );
  }
  if (d.unknown_dep_types.length > 0) {
    lines.push(
      `! dependency types with no myc edge (${d.unknown_dep_types.length}): ` +
        `${d.unknown_dep_types.slice(0, 3).join(", ")}` + (d.unknown_dep_types.length > 3 ? "…" : ""),
    );
  }
  if (d.missing_refs.length > 0) {
    lines.push(
      `! references with no target (${d.missing_refs.length}): ${d.missing_refs.slice(0, 3).join(", ")}…`,
    );
  }
  lines.push(`done in ${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

export function createImportBeadsCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "import-beads",
    summary: "import and sync tasks, dependencies, notes and memories from beads",
    flags: [
      { name: "dry-run", description: "count what would be imported, change nothing" },
      { name: "as", value: "string", description: "actor for the records (default $MYC_ACTOR/$USER)" },
    ],
    help:
      "Without arguments collects the snapshot itself via bd export --include-memories; a JSON " +
      "file argument remains an option for moving between machines. " +
      "Every beads id is kept in attrs.external_ref; texts are copied verbatim — references like " +
      "myc-qie.7 inside descriptions are NOT rewritten. Re-running is a sync, not just " +
      "deduplication: fields changed in beads (status, priority, labels, close reason, parent, " +
      "blockers) are applied through normal graph mutations. Local myc edits are never silently " +
      "overwritten: one-sided local changes are kept and named in kept_local, two-sided changes " +
      "are named in conflicts and left untouched.",
    handler: async (ctx) => {
      const path = ctx.args[0];
      let snapshot: BeadsSnapshot;
      let snapshotName: string;
      if (path !== undefined) {
        if (!existsSync(path)) {
          return failure("notfound.file", `snapshot not found: ${path}`, ExitCode.NOTFOUND);
        }
        try {
          snapshot = parseBeadsSnapshot(readFileSync(path, "utf8"));
        } catch (e) {
          return failure(
            "precond.snapshot_format",
            `snapshot does not parse: ${e instanceof Error ? e.message : String(e)}`,
            ExitCode.PRECOND,
          );
        }
        snapshotName = path;
      } else {
        const cwd = ctx.globals.directory ?? process.cwd();
        try {
          snapshot = collectBeadsSnapshot(cwd);
        } catch (e) {
          return failure(
            "precond.bd",
            `could not build the snapshot via bd: ${e instanceof Error ? e.message : String(e)}`,
            ExitCode.PRECOND,
          );
        }
        snapshotName = `bd (${cwd})`;
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        let data: ImportBeadsData;
        try {
          data = importBeadsSnapshot(h, snapshot, { dryRun: flagBool(ctx, "dry-run"), snapshotName });
        } catch (e) {
          return graphFailure(e);
        }
        // Незнакомые типы ввезены дословно — но пользователь обязан узнать,
        // что в его трекере есть типы, о которых myc не знает (И2). Молчание
        // здесь превратило бы «сохранили как есть» в «тихо приняли что-то».
        const unknown = snapshot.unknownTypes;
        if (unknown !== undefined) {
          const list = Object.entries(unknown)
            .sort((a, b) => b[1] - a[1])
            .map(([t, n]) => `${t}×${n}`)
            .join(", ");
          ctx.warn(
            "import.unknown_types",
            `types myc does not know were imported verbatim into attrs.type: ${list}`,
          );
        }
        // Незнакомое поле задачи — потеря, и она обязана быть НАЗВАНА. Молчание
        // здесь однажды уже стоило 156 комментариев: их не было ни в отчёте,
        // ни в WARN, а строка «заметки новых 265» звучала как полный успех.
        const unknownFields = snapshot.unknownFields;
        if (unknownFields !== undefined) {
          const list = Object.entries(unknownFields)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([f, n]) => `${f}×${n}`)
            .join(", ");
          ctx.warn(
            "import.unknown_fields",
            `beads task fields the import does not read and did not import anywhere: ${list}`,
          );
        }
        const clamped = snapshot.clampedPriorities;
        if (clamped !== undefined && clamped.length > 0) {
          ctx.warn(
            "import.priority_clamped",
            `${clamped.length} ${clamped.length === 1 ? "priority" : "priorities"} clamped to the myc scale P0..P3: ` +
              `${clamped.slice(0, 5).join(", ")}`,
          );
        }
        // Столкновение идентичностей — свойство ДАННЫХ, а не поломка myc, и
        // оно обязано быть названо поимённо: иначе человек видит только
        // «ввезено на 3 меньше» и не знает, что именно не доехало (И2).
        if (data.skipped.length > 0) {
          ctx.warn(
            "import.skipped",
            `${data.skipped.length} ${data.skipped.length === 1 ? "record" : "records"} not imported: ` +
              `${data.skipped.slice(0, 3).join("; ")}` +
              (data.skipped.length > 3 ? "…" : ""),
          );
        }
        if (data.unknown_dep_types.length > 0) {
          ctx.warn(
            "import.unknown_dep_types",
            `${data.unknown_dep_types.length} ${data.unknown_dep_types.length === 1 ? "dependency" : "dependencies"} ` +
              `of a type that has no myc edge: ` +
              `${data.unknown_dep_types.slice(0, 3).join(", ")}` +
              (data.unknown_dep_types.length > 3 ? "…" : ""),
          );
        }
        if (data.conflicts.length > 0) {
          ctx.warn(
            "import.conflicts",
            `${data.conflicts.length} ${data.conflicts.length === 1 ? "conflict" : "conflicts"}: ` +
              `both sides changed the field, myc applied nothing (${data.conflicts.slice(0, 2).join("; ")}…)`,
          );
        }
        if (data.missing_refs.length > 0) {
          ctx.warn(
            "import.missing_refs",
            `${data.missing_refs.length} ${data.missing_refs.length === 1 ? "dependency" : "dependencies"} ` +
              `with no target in the snapshot or the database (${data.missing_refs.slice(0, 3).join(", ")}…)`,
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderImportBeadsHuman,
  };
}
