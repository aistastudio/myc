/**
 * Общий движок чтения памяти для `myc recall` и `myc search` — решение D6
 * (docs/design/03-interfaces-and-integration.md §1, строка D6): ОДНА
 * реализация, две обёртки. `recall` — агентская (бюджет символов, дедуп,
 * свёрнутый вывод), `search` — человеческая (полные поля, фильтры,
 * сортировки). Дублировать UX нужно, дублировать логику нельзя, поэтому
 * весь путь «открыть ярусы → federatedSearch → фильтры → гидратация» лежит
 * здесь ровно один раз, а recall.ts/search.ts только выбирают параметры и
 * рисуют.
 *
 * ФЕДЕРАЦИЯ НЕ ПЕРЕИЗОБРЕТАЕТСЯ. Оба яруса читает federatedSearch из
 * @myc/retrieval (S41): личный ярус — ещё один источник той же формы, что
 * fts/vector, слияние тем же RRF, каждый хит несёт `tier`. Здесь только
 * решение «открывать ли ~/.myc вообще» (openPersonalStore ленив по stat) и
 * перенос tier в выдачу CLI.
 *
 * И2 — ГРОМКАЯ ДЕГРАДАЦИЯ. `mode_used` гибрида не сворачивается в
 * «нашлось N»: ветки, реально попавшие в выдачу, печатаются в футере обеих
 * команд (modeLabel), причина решения — по --why, а каждая строка
 * mode_used.degraded уходит в ctx.warn, то есть в WARN-строку, в
 * meta.degraded[] конверта и в exit 6 под --strict. Молчаливое исключение
 * векторной ветки здесь невозможно: она отсутствует в modeLabel и объявлена
 * в WARN одновременно.
 *
 * ЛЕНИВЫЙ ЭМБЕДДИНГ (S31). Гибрид зовёт embedQuery ТОЛЬКО когда сработал
 * триггер, и колбэк обязан быть синхронным, а локальный ONNX — асинхронный.
 * Поэтому проход двухфазный: первый вызов отдаёт null и лишь ФИКСИРУЕТ, что
 * вектор был нужен; если он был нужен и эмбеддер есть — считаем вектор и
 * повторяем проход с готовым вектором. Второй проход стоит один лексический
 * запрос (0.38 мс на 100k), зато цена эмбеддинга (p50 23 мс) не платится
 * ни разу, когда лексики хватило, — ровно то, ради чего условная ветка и
 * заведена. Если эмбеддера нет, второго прохода нет вовсе, а результат
 * первого уже несёт честное `vector: "unavailable"` и degraded-строку.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL_ID, modelManifestPath } from "@myc/embed/model-id";
import type { JsonValue, Layer, NodeKind, ReachInfo, RepoInfo } from "@myc/core";
import { defineQueries, readReach, readRepo, visibleInRepo } from "@myc/core";
import {
  assembleBudgeted,
  DEFAULT_CHAR_BUDGET,
  DEFAULT_HYBRID_CONFIG,
  DEFAULT_TIMEOUT_MS,
  federatedSearch,
  type FederatedHit,
  type FederatedModeUsed,
  type FederationSource,
  type FtsCaller,
  type WorkspaceTier,
} from "@myc/retrieval";
import { ExitCode } from "../exit.ts";
import type { CommandContext, CommandFailure } from "../registry.ts";
import {
  embedSocketPath,
  enqueueWarmJob,
  requestVector,
  spawnEmbedDaemon,
  type DaemonVector,
} from "./embedd.ts";
import {
  openPersonalStore,
  openStore,
  parseWorkspaceToml,
  personalWorkspaceStatus,
  PERSONAL_SLUG,
  repoTarget,
  VECTOR_OPEN,
  type OpenOptions,
  type OpenPersonalResult,
  type OpenStoreResult,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Запрос
// ---------------------------------------------------------------------------

export type RetrieveMode = "hybrid" | "vec" | "bm25";

/** CLI-имя kind'а -> core kind (+ attrs.type). Тот же словарь, что в list.ts. */
const KIND_FILTER: Readonly<Record<string, { kind: NodeKind; type?: string }>> = {
  task: { kind: "task", type: "task" },
  bug: { kind: "task", type: "bug" },
  epic: { kind: "task", type: "epic" },
  chore: { kind: "task", type: "chore" },
  memory: { kind: "note" },
  note: { kind: "note" },
  decision: { kind: "note", type: "decision" },
  document: { kind: "doc" },
  doc: { kind: "doc" },
  fragment: { kind: "fragment" },
  session: { kind: "session" },
  episode: { kind: "session" },
  message: { kind: "message" },
  entity: { kind: "entity" },
  anchor: { kind: "anchor" },
  skill: { kind: "skill" },
};

export const KIND_NAMES: readonly string[] = Object.keys(KIND_FILTER);

export interface RetrieveFilters {
  /** CLI-имена kind'ов (memory, decision, task...). */
  readonly kinds?: readonly string[];
  readonly tags?: readonly string[];
  readonly layerMin?: Layer;
  readonly layerMax?: Layer;
  readonly since?: number;
  readonly until?: number;
  readonly acl?: readonly string[];
  readonly author?: string;
  /** Подстрока пути якоря (attrs.anchors[].path). */
  readonly anchor?: string;
  /**
   * Охват S58: session | project | unknown. Не задан — выдаются ВСЕ, и это
   * намеренно: сессионная память не испаряется, она просто вне контекста по
   * умолчанию, а явный поиск обязан её находить.
   */
  readonly reach?: readonly string[];
  /** Только эта сессия (вместе с reach=session). Пусто — любая. */
  readonly reachSession?: string;
  /**
   * Охват репозитория S59: имя репозитория. Пусто/не задан — фильтра нет.
   * Узлы с общим охватом и узлы без записанного охвата видны под ЛЮБЫМ
   * фильтром: первые — потому что они про всю экосистему, вторые — потому
   * что прятать неизвестное значит терять память старых баз (И2).
   */
  readonly repo?: string;
}

export interface RetrieveRequest {
  readonly text: string;
  /** Сколько строк нужно вызывающему ПОСЛЕ фильтров. */
  readonly limit: number;
  /** Сколько строк пропустить (search --offset). */
  readonly offset?: number;
  readonly filters: RetrieveFilters;
  readonly mode: RetrieveMode;
  /** Тянуть полные поля узла (acl, author, body) — search и --full. */
  readonly fullFields: boolean;
  /** Сколько ждать прогрева эмбеддера; 0 — не звать его вовсе (см. ниже). */
  readonly embedTimeoutMs: number;
  /**
   * Дедлайн запроса вектора у прогретого демона (S44); 0 — не спрашивать.
   * Необязательное: по умолчанию берётся из MYC_EMBED_SOCKET_TIMEOUT_MS, то
   * есть все вызывающие получают фоновый прогрев, ничего у себя не меняя.
   */
  readonly embedSocketTimeoutMs?: number;
  /**
   * Бюджетированный ретривал (§2.7): символьный потолок КОНТЕНТА ответа.
   * undefined — DEFAULT_CHAR_BUDGET (12000); recall подставляет свой --budget.
   */
  readonly charBudget?: number;
  /**
   * Дедлайн стадий ПОСЛЕ эмбеддинга запроса (гидратация, фильтры, сборка), мс.
   * При исчерпании отдаётся собранное с partial=true — не пустота и не ошибка.
   * undefined — DEFAULT_TIMEOUT_MS (20).
   */
  readonly budgetTimeoutMs?: number;
  /**
   * Поднимать ли crux → полный контент (pass 2). undefined — как fullFields:
   * агентский recall и search --full получают тела, табличный search — нет.
   */
  readonly upgradeContent?: boolean;
  /**
   * Счётный потолок опрашиваемых воркспейсов (R3); undefined —
   * DEFAULT_MAX_SOURCES из @myc/retrieval. Задаётся тестами и бенчем: в
   * продукте потолок один на все поверхности, разъехавшиеся значения читались
   * бы как потеря знания в одной из них.
   */
  readonly maxSources?: number;
  /** Дедлайн опроса всех воркспейсов, мс (R3); undefined — DEFAULT_DEADLINE_MS. */
  readonly federationDeadlineMs?: number;
  /**
   * Ручки поверхности: имена её флагов, как они объявлены в её же FlagSpec[].
   * Совет при пустой выдаче называет флаг ТОЛЬКО отсюда — придуманный флаг
   * («--repo all» в `myc search`, где его нет) отправляет человека в
   * usage-ошибку и стоит ровно столько же доверия, сколько дежурный список.
   */
  readonly knobs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Выдача
// ---------------------------------------------------------------------------

export interface RetrieveRow {
  readonly id: string;
  readonly rank: number;
  /** Сырой score гибрида (RRF x бусты) — величина порядка 0.01, для машин. */
  readonly score: number;
  /**
   * НЕ уверенность и не ранг — качество ИМЕННО ЭТОГО векторного совпадения:
   * (среднее − дистанция) / стд.откл. по векторному пулу того же запроса, в
   * стандартных отклонениях. Положительное и большое (обычно 1–4) — хит
   * заметно ближе остальных кандидатов; около нуля — неотличим от случайного
   * соседа. undefined, когда вектор вообще не участвовал в этом хите (чисто
   * лексический/графовый источник) — там сравнивать не с чем.
   *
   * ПОЧЕМУ НЕ score_rel (было). Прежнее поле делило score на максимум ВНУТРИ
   * ЭТОЙ ЖЕ выдачи, поэтому верхний результат всегда получал 1.00 — даже
   * когда он оказался первым случайно (myc-ye3.9). confidence нормирован по
   * распределению дистанций в пуле кандидатов запроса, а не по собственному
   * максимуму выдачи, поэтому у случайного топа он низкий, а не единица.
   * Само по себе значение слабое (S47: разделение близких/далёких пар у этой
   * модели ~0.058) — это честный, а не идеальный сигнал.
   */
  readonly confidence?: number;
  readonly sources: readonly string[];
  /**
   * ВОРКСПЕЙС, ИЗ КОТОРОГО ВЗЯТА СТРОКА (R3) — ЧЕТВЁРТАЯ ОСЬ. `project` —
   * воркспейс вызова, `me` — личный ярус, иначе имя репозиторного воркспейса
   * экосистемы. НЕ путать с `repo` ниже: тот — охват узла (S59, «про что
   * знание»), а этот — откуда его прочитали. Узел про collector может лежать
   * в корневом воркспейсе, и наоборот.
   */
  readonly source: string;
  /** Род источника: project | personal | repo. */
  readonly tier: WorkspaceTier;
  /** Все воркспейсы, где нашёлся этот узел (R3); первый из них — `source`. */
  readonly found_in?: readonly string[];
  readonly kind: string;
  /** Видимый тип: attrs.type у задач/решений, иначе kind. */
  readonly type: string;
  readonly layer: number;
  readonly updated_at: number;
  readonly title: string;
  readonly excerpt: string;
  /**
   * И2/§2.7: "full" — текст строки есть ЦЕЛЫЙ контент узла; "crux" — текст
   * усечён до crux (тело либо не влезло в бюджет, либо pass 2 оборвал
   * дедлайн). undefined — поверхность не различает (тело не показывалось).
   */
  readonly content_kind?: "full" | "crux";
  /** Охват памяти S58: session | project | unknown. */
  readonly reach: ReachInfo["reach"];
  /** Ключ сессии-владельца; пусто у project и unknown. */
  readonly reach_session: string;
  /** Как охват определён: recorded | episode | absent. */
  readonly reach_by: ReachInfo["by"];
  /** Охват репозитория S59: имя репозитория; пусто у общего и у неопределённого. */
  readonly repo: string;
  /** Состояние охвата репозитория: repo | root | unknown. */
  readonly repo_state: RepoInfo["state"];
  // --- только при fullFields ---
  readonly created_at?: number;
  readonly acl?: string;
  readonly author?: string;
  readonly status?: string;
  readonly tags?: readonly string[];
  readonly body?: string | null;
  readonly anchors?: readonly string[];
}

export interface RetrieveOutcome {
  readonly rows: readonly RetrieveRow[];
  /** Сколько строк осталось после фильтров во всём пуле. */
  readonly total: number;
  /** Сколько строк выдал ретривал до фильтров. */
  readonly pool: number;
  /** Пул упёрся в потолок: total — нижняя оценка, а не точное число. */
  readonly poolExhausted: boolean;
  readonly mode_used: FederatedModeUsed;
  /** Ветки, реально попавшие в выдачу: "vec+bm25 rrf(k=60)", "bm25 only", ... */
  readonly modeLabel: string;
  /** Почему выдача пуста; undefined — выдача непуста (S44, И2). */
  readonly emptyReason?: string;
  readonly degraded: readonly string[];
  readonly tiers: { readonly project: boolean; readonly personal: boolean };
  /**
   * Федерация по N воркспейсам (R3): что опрошено, что пропущено и почему.
   * Поверхности печатают это ЧИСЛОМ в подвале — молча опросить не всех и
   * отдать результат как полный запрещает И2.
   */
  readonly federation: FederationSummary;
  /**
   * Репозиторий, по которому реально фильтровали (S59); пусто — не
   * фильтровали. Поверхности печатают это число из выдачи, а не выводят
   * заново: одна и та же цель обязана быть у фильтра и у подвала.
   */
  readonly repo: string;
  readonly took_ms: number;
  /** Сколько строк схлопнула дедупликация. */
  readonly deduped: number;
  /**
   * Отсев ПО ПРИЧИНАМ (И2): та же правда, что в тексте `emptyReason`, но
   * числами и для машин. Текст советует одну ручку — самую весомую; здесь
   * видно все, и это то, чем проверяется совет.
   */
  readonly drops: DropCounts;
  // --- бюджетированный ретривал (§2.7, И2: обрезка помечена, а не молчалива) ---
  /**
   * true — вызывающий получил НЕ ВСЁ, что дал ранжир: узлы не влезли в
   * символьный бюджет (omitted), pass 2 оборван дедлайном (budgetTimedOut)
   * или есть продолжение выдачи (cursor). false — получено всё.
   */
  readonly partial: boolean;
  /** Кандидаты страницы, не влезшие в символьный бюджет. */
  readonly omitted: number;
  /** Продолжение выдачи: следующий offset; undefined — выдача исчерпана. */
  readonly cursor?: string;
  /** Pass 2 оборван дедлайном budgetTimeoutMs (бюджет символов остался). */
  readonly budgetTimedOut: boolean;
  /** Символьный бюджет контента и фактический расход на тексты строк. */
  readonly budgetChars: number;
  readonly usedChars: number;
}

/** Компактный отчёт федерации для подвалов и --json (R3). */
export interface FederationSummary {
  /** Имена опрошенных воркспейсов, в порядке опроса. */
  readonly queried: readonly string[];
  /** Пропущенные и ПРИЧИНА у каждого — без причины пропуск не бывает (И2). */
  readonly skipped: readonly { readonly id: string; readonly why: string }[];
  /** Сколько воркспейсов было найдено всего. */
  readonly total: number;
  /** Действующий счётный потолок. */
  readonly cap: number;
  /** Сколько миллисекунд заняли опросы всех источников вместе. */
  readonly took_ms: number;
}

export type RetrieveResult =
  | { readonly ok: true; readonly outcome: RetrieveOutcome }
  | { readonly ok: false; readonly failure: CommandFailure };

// ---------------------------------------------------------------------------
// Гидратация полных полей
// ---------------------------------------------------------------------------

const QR = defineQueries({
  // Лёгкая гидратация для recall: только attrs, только чтобы напечатать
  // видимый тип (decision против memory) и теги. Обходится одним seek'ом по
  // PK на узел — сотые доли миллисекунды против 25 мс бюджета, — и без неё
  // агент видел бы `memory` там, где §3.10 обещает `decision`.
  hydrate_light: {
    name: "hydrate_light",
    sql: `SELECT id, attrs FROM nodes
           WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL`,
    params: ["ids"],
  },
  hydrate_full: {
    name: "hydrate_full",
    sql: `SELECT id, kind, layer, title, body, excerpt, status, acl, actor,
                 created_at, updated_at, attrs
            FROM nodes
           WHERE id IN (SELECT value FROM json_each(?1))
             AND deleted_at IS NULL`,
    params: ["ids"],
  },
});

interface LightRow {
  readonly id: string;
  readonly attrs: string;
}

interface FullRow {
  readonly id: string;
  readonly kind: string;
  readonly layer: number;
  readonly title: string;
  readonly body: string | null;
  readonly excerpt: string;
  readonly status: string;
  readonly acl: string;
  readonly actor: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly attrs: string;
}

function parseAttrs(raw: string): Record<string, JsonValue> {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

function attrTags(attrs: Record<string, JsonValue>): string[] {
  const t = attrs["tags"];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

function attrAnchors(attrs: Record<string, JsonValue>): string[] {
  const a = attrs["anchors"];
  if (!Array.isArray(a)) return [];
  const out: string[] = [];
  for (const entry of a) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, JsonValue>;
    const path = rec["path"];
    if (typeof path !== "string") continue;
    const start = typeof rec["start"] === "number" ? rec["start"] : undefined;
    const end = typeof rec["end"] === "number" ? rec["end"] : undefined;
    const span = start === undefined ? "" : end !== undefined && end !== start ? `:${start}-${end}` : `:${start}`;
    out.push(`${path}${span}`);
  }
  return out;
}

/**
 * Видимый тип. attrs.type выигрывает у kind (задача/решение), а два ядровых
 * kind'а переименованы в то, чем их зовёт §3.10: note → memory,
 * session → episode. Вывод читает агент, и он ищет ровно эти слова.
 */
const DISPLAY_KIND: Readonly<Record<string, string>> = { note: "memory", session: "episode" };

function attrType(kind: string, attrs: Record<string, JsonValue>): string {
  const t = attrs["type"];
  if (typeof t === "string" && t.length > 0) return t;
  return DISPLAY_KIND[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Эмбеддер запроса — только если он реально понадобился (S31)
// ---------------------------------------------------------------------------

export type QueryEmbedder = (text: string) => Promise<Float32Array | null>;

/**
 * Результат попытки получить эмбеддер: либо он есть, либо есть ПРИЧИНА, по
 * которой его нет. Молчаливого `null` не бывает — причина уходит в WARN (И2).
 */
export type EmbedderResolution =
  | { readonly ok: true; readonly embed: QueryEmbedder }
  | { readonly ok: false; readonly reason: string };

/**
 * ПОЧЕМУ ВЕКТОР В ОДНОРАЗОВОМ CLI ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ.
 *
 * Замер на этой машине (packages/cli/src/commands/retrieve.test.ts фиксирует
 * порядок величин, сами числа — из живого прогона):
 *   createEmbedder            0.4 мс
 *   warmup() до state=ok    184.0 мс
 *   embed() уже прогретым    20.5 мс
 * Бюджет recall — 25 мс на 100k (И1). Прогрев ONNX в один разовый процесс
 * не влезает в него на порядок, а `embed()` без прогрева честно возвращает
 * state="warming" и вектора не даёт вовсе — то есть 184 мс были бы потрачены
 * впустую. Поэтому по умолчанию эмбеддер не трогается совсем, а выключенная
 * ветка объявляется вслух: строка WARN и `vector: "unavailable"` в mode_used.
 *
 * Кому вектор нужнее задержки — `--embed-timeout <мс>` (или переменная
 * MYC_EMBED_TIMEOUT_MS): прогрев с дедлайном, не уложился — работаем без
 * вектора и говорим об этом. Долгоживущему хосту (MCP, server) эта развилка
 * не нужна: там эмбеддер прогревается один раз и `embed()` стоит 21 мс.
 */
export const DEFAULT_EMBED_TIMEOUT_MS = 0;

/**
 * ФОНОВЫЙ ПРОГРЕВ (S44, вторая половина). Комментарий выше объясняет, почему в
 * одноразовом процессе прогрев выключен, — и на этом всё и останавливалось:
 * векторная ветка была недоступна ПО УМОЛЧАНИЮ, то есть перефразировка не
 * находила ничего (S32: без вектора recall@10 = 0 на таких запросах).
 *
 * Развязка: 223 мс платит не команда, а фоновый демон `myc embedd`, поднятый
 * работой `embed_warm` из очереди `jobs`. Горячий путь только СПРАШИВАЕТ у
 * него готовый вектор по сокету, с жёстким дедлайном; нет ответа за дедлайн —
 * работаем без вектора и говорим об этом. Ждать демона запрещено: прогрев не
 * имеет права задерживать ни одну команду.
 *
 * Дедлайн 120 мс: прогретый `embed()` стоит 28 мс (замер здесь же), плюс
 * connect/JSON — с запасом на загруженную машину, но заведомо конечный.
 */
export const DEFAULT_EMBED_SOCKET_TIMEOUT_MS = 120;

export function embedSocketTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYC_EMBED_SOCKET_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_EMBED_SOCKET_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_EMBED_SOCKET_TIMEOUT_MS;
}

/**
 * Можно ли поднимать фонового демона.
 *
 * MYC_EMBED_DAEMON=0|off|false|no — выключить явно.
 *
 * NODE_ENV=test выключает его САМ, и это не перестраховка. Прогон тестов —
 * десятки временных воркспейсов, которые создаются и удаляются за секунды;
 * демон, поднятый в таком каталоге, переживает свой воркспейс и держит уже
 * удалённую базу. Найдено прогоном: полный `bun test` дал плавающий отказ в
 * соседнем файле ровно из-за этого. Тест, которому демон нужен, поднимает его
 * сам — явно и в своём каталоге.
 */
export function embedDaemonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "test") return false;
  const raw = (env.MYC_EMBED_DAEMON ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false" && raw !== "no";
}

export function embedTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYC_EMBED_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_EMBED_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_EMBED_TIMEOUT_MS;
}

/**
 * Дешёвый признак «модель скачана» — ОДИН stat, без импорта @myc/embed.
 *
 * Это не дубль isModelPresent (тот сверяет sha256 каждого файла и стоит
 * чтения десятков мегабайт), а привратник перед ним: manifest.json по
 * контракту fetch.ts пишется ПОСЛЕДНИМ, то есть его наличие — необходимое
 * условие целостности модели. Полную проверку делает уже сам @myc/embed,
 * когда его действительно позвали. Замер, ради которого это заведено:
 * динамический import("@myc/embed") на холодном процессе стоил 190 мс при
 * бюджете поиска 25 мс — и платился он на КАЖДОМ запросе без модели, то
 * есть ровно там, где вектора всё равно не будет.
 *
 * Идентификатор модели и путь её каталога сюда НЕ КОПИРУЮТСЯ: их отдаёт
 * `@myc/embed/model-id` — намеренно нищий модуль (node:os + node:path, ни
 * одной зависимости на ONNX), поэтому статический импорт бесплатен. До
 * этого здесь жила копия литерала, и она ломалась бы ТИХО: при смене
 * модели привратник смотрел бы на каталог старой, не находил его и молча
 * не звал вектор (S46; та же болезнь, что S43 со списком PRAGMA).
 */
export function modelLikelyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(modelManifestPath(DEFAULT_MODEL_ID, env));
}

/**
 * Резолвер эмбеддера. Дорогой импорт @myc/embed делается ДИНАМИЧЕСКИ и
 * только после того, как триггер гибрида запросил вектор: иначе одноразовый
 * `myc recall` платил бы за загрузку ONNX-рантайма на каждом запуске, включая
 * те запросы, где вектор не нужен вовсе.
 *
 * `null` — эмбеддера нет (модель не выкачана). Это не ошибка: гибрид получит
 * embedQuery, вернувший null, и объявит `vector: "unavailable"` с
 * degraded-строкой — то есть деградация будет громкой, а не молчаливой.
 */
export async function resolveQueryEmbedder(timeoutMs: number): Promise<EmbedderResolution> {
  if (timeoutMs <= 0) {
    return {
      ok: false,
      reason:
        "прогрев эмбеддера выключен (--embed-timeout 0): холодный ONNX стоит ~184 мс " +
        "при бюджете recall 25 мс — векторная ветка не звалась",
    };
  }
  if (!modelLikelyPresent()) {
    return { ok: false, reason: "модель эмбеддингов не скачана → myc models fetch" };
  }
  try {
    const embed = await import("@myc/embed");
    const embedder = embed.createEmbedder({ backend: "local" });
    // Прогрев с дедлайном. Гонка, а не отмена: сам warmup прервать нечем, но
    // ждать его дольше отведённого мы не обязаны — вернёмся без вектора и
    // скажем, почему.
    const warmed = await Promise.race([
      embedder.warmup(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
    ]);
    if (warmed !== "ok") {
      void embedder.destroy();
      return {
        ok: false,
        reason:
          warmed === "timeout"
            ? `эмбеддер не прогрелся за ${timeoutMs} мс — векторная ветка пропущена`
            : `эмбеддер в состоянии ${warmed} — векторная ветка пропущена`,
      };
    }
    return {
      ok: true,
      embed: async (text: string) => {
        try {
          const res = await embedder.embed(text);
          return res.state === "ok" ? res.vec : null;
        } finally {
          await embedder.destroy();
        }
      },
    };
  } catch (e) {
    return { ok: false, reason: `эмбеддер не поднялся: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Прогретый эмбеддер, живущий ВНЕ этого процесса (S44). Отдельно от
 * `resolveEmbedder`, потому что это принципиально другая стоимость и другой
 * отказ: здесь нет ни импорта ONNX, ни прогрева — только запрос по сокету с
 * дедлайном, и «нет» означает «демона нет или он не успел», а не «модели нет».
 */
export interface WarmEmbedder {
  /**
   * Вектор запроса от прогретого демона. Отказ РАЗМЕЧЕН: «демона нет» и «демон
   * ещё греется» ведут к разным действиям, и склеивать их в null нельзя.
   */
  vector(text: string, timeoutMs: number): Promise<DaemonVector>;
  /**
   * Разбудить прогрев в фоне: поставить работу в очередь и запустить демона.
   * ОБЯЗАН возвращаться немедленно — прогрев не задерживает команду.
   * Возвращает строку для WARN (что именно предпринято) или undefined.
   */
  warmInBackground(): string | undefined;
}

export interface RetrieveDeps extends StoreDeps {
  openPersonal(ctx: CommandContext, options?: OpenOptions): Promise<OpenPersonalResult>;
  resolveEmbedder(timeoutMs: number): Promise<EmbedderResolution>;
  /**
   * Необязательный — поверхности, которые держат собственный прогретый
   * эмбеддер (MCP, server), и тесты его не подключают, и тогда поведение
   * ровно прежнее.
   */
  warmEmbedder?(ctx: CommandContext, handle: StoreHandle): WarmEmbedder | undefined;
  /**
   * Перечисление соседних репозиторных воркспейсов (R3). Только readdir+stat,
   * НИ ОДНОГО открытия базы: перечислить пятнадцать соседей обязано стоить
   * микросекунды, иначе ленивость теряется ещё до отбора. Необязательный —
   * без него федерация ровно прежняя, два яруса.
   */
  discoverRepos?(wsDir: string): readonly RepoWorkspace[];
  /**
   * Открытие соседнего воркспейса; зовётся ТОЛЬКО для прошедших отбор (R3).
   */
  openRepo?(
    ctx: CommandContext,
    ws: RepoWorkspace,
    options?: OpenOptions,
  ): Promise<OpenStoreResult>;
}

// ---------------------------------------------------------------------------
// Соседние воркспейсы экосистемы (R3, решение S59)
// ---------------------------------------------------------------------------

/** Найденный соседний воркспейс — ОПИСАНИЕ, база ещё не открыта. */
export interface RepoWorkspace {
  /** Имя каталога репозитория; оно же — имя источника в выдаче. */
  readonly id: string;
  readonly dir: string;
  readonly dbPath: string;
  /**
   * Слог воркспейса, прочитанный из его `workspace.toml` (пустой — умолчание
   * `myc`). Читается ЗДЕСЬ, а не при открытии: hybridSearch фильтрует по
   * scope, значит слог обязан быть известен до опроса, а чтение крошечного
   * TOML не требует открывать базу.
   */
  readonly scope: string;
}

/**
 * Каталоги, внутрь которых заглядывать бессмысленно: они не репозитории
 * экосистемы, а их перечисление стоит тех же stat'ов.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor", "coverage"]);

/**
 * Репозиторные воркспейсы экосистемы: непосредственные подкаталоги корня со
 * СВОИМ `.myc/myc.db` (S59 — часть репозиториев публикуется отдельно и потому
 * имеет свой воркспейс). Один readdir + по одному existsSync на подкаталог;
 * ни одного открытия базы — отбор идёт по описаниям, а платится только за
 * прошедших (И1).
 *
 * Только ПЕРВЫЙ уровень. Рекурсия по дереву дала бы неограниченный обход на
 * каждый recall, а экосистема плоская по построению: корень и репозитории в
 * нём. Репозиторий, у которого своего воркспейса нет, сюда не попадает — его
 * знание и так лежит в корневом (R1).
 *
 * Порядок — лексикографический, чтобы отбор под потолком был воспроизводим:
 * один и тот же запрос обязан опрашивать один и тот же набор источников.
 */
/** Слог соседнего воркспейса: тот же разбор, что в openStore, тот же дефолт. */
function slugOf(dir: string): string {
  const tomlPath = join(dir, ".myc", "workspace.toml");
  if (!existsSync(tomlPath)) return "";
  try {
    const slug = parseWorkspaceToml(readFileSync(tomlPath, "utf8")).slug;
    return slug === "myc" ? "" : slug;
  } catch {
    return ""; // битый конфиг соседа не имеет права ронять наше чтение
  }
}

export function discoverRepoWorkspaces(wsDir: string): RepoWorkspace[] {
  const personalDbPath = personalWorkspaceStatus().dbPath;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(wsDir, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
  } catch {
    return []; // корень исчез или недоступен — соседей просто нет
  }
  const out: RepoWorkspace[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const dir = join(wsDir, e.name);
    const dbPath = join(dir, ".myc", "myc.db");
    if (!existsSync(dbPath)) continue;
    // ЛИЧНЫЙ ЯРУС СОСЕДОМ НЕ СЧИТАЕТСЯ. Он лежит под тем же относительным
    // путём `.myc/myc.db` (S41) и, когда домашний каталог оказался ВНУТРИ
    // корня экосистемы (так устроены тесты и так бывает у `~/src` под
    // `MYC_HOME`), попал бы в список дважды: и как личный ярус, и как
    // «репозиторий home». Одна и та же база, открытая двумя источниками, —
    // двойной вес одного факта в RRF и лишнее соединение в бюджете.
    if (dbPath === personalDbPath) continue;
    out.push({ id: e.name, dir, dbPath, scope: slugOf(dir) });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Боевое открытие соседнего воркспейса — тем же openStore, что и свой, только
 * с подменёнными `--db`/`-C`. Второго пути открытия базы не появляется
 * (store.parity.test.ts держит их число), и значит соседний воркспейс
 * мигрируется, чинит site_id и поднимает часы ровно так же, как свой.
 */
export function realOpenRepo(
  ctx: CommandContext,
  ws: RepoWorkspace,
  options?: OpenOptions,
): Promise<OpenStoreResult> {
  return openStore(
    { ...ctx, globals: { ...ctx.globals, db: ws.dbPath, directory: ws.dir } },
    options,
  );
}

/**
 * Боевая реализация прогретого эмбеддера: сокет демона + постановка работы в
 * очередь. Ни один вызов здесь не ждёт прогрева.
 */
export function realWarmEmbedder(
  ctx: CommandContext,
  handle: StoreHandle,
): WarmEmbedder | undefined {
  if (!embedDaemonEnabled()) return undefined;
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  const dbPath = ctx.globals.db ?? join(dir, ".myc", "myc.db");
  const socketPath = embedSocketPath(dbPath);
  return {
    vector: (text, timeoutMs) => requestVector(socketPath, text, timeoutMs),
    warmInBackground: () => {
      // Модели нет — поднимать демона незачем: он умрёт на прогреве и в
      // очереди останется строка с last_error. Причину назовёт resolveEmbedder.
      if (!modelLikelyPresent()) return undefined;
      try {
        if (!enqueueWarmJob(handle.driver, handle.scope)) {
          return "прогрев эмбеддера уже исчерпал попытки — смотри jobs.last_error";
        }
      } catch {
        // Очередь недоступна — демона всё равно поднимаем: она учёт, а не
        // механизм (S7).
      }
      spawnEmbedDaemon(dbPath);
      return (
        "прогрев эмбеддера запущен в фоне (работа embed_warm в очереди jobs) — " +
        "эта выдача без вектора, следующая будет с ним"
      );
    },
  };
}

export const realRetrieveExtras = {
  openPersonal: (ctx: CommandContext, options?: OpenOptions): Promise<OpenPersonalResult> =>
    openPersonalStore(ctx, undefined, options),
  resolveEmbedder: resolveQueryEmbedder,
  warmEmbedder: realWarmEmbedder,
  discoverRepos: discoverRepoWorkspaces,
  openRepo: realOpenRepo,
};

// ---------------------------------------------------------------------------
// Ярлык режима
// ---------------------------------------------------------------------------

/**
 * Ветки, РЕАЛЬНО попавшие в выдачу (hybrid.mode_used.sources — это то, что
 * дошло до хитов, а не то, что звали). "bm25 only" ровно как в §3.10.
 *
 * Пустая выдача возвращает не голое «пусто», а «пусто · <причина>» (S44, И2).
 * Ярлык попадает в футер обеих команд без изменения их рендеров — то есть
 * молчаливая пустота невозможна ни в одном варианте вывода, включая --json,
 * где та же причина лежит структурой в mode_used.
 */
/**
 * Отчёты гибрида по ВСЕМ опрошенным воркспейсам (R3). Один список вместо
 * пары `project`/`personal`: источников до шестнадцати, и ярлык режима,
 * ступень отката и объяснение пустоты обязаны считаться по всем сразу.
 */
function queriedModes(mode: FederatedModeUsed) {
  return mode.sources.filter((r) => r.queried && r.mode !== undefined).map((r) => r.mode!);
}

export function modeLabelOf(
  mode: FederatedModeUsed,
  rrfK: number,
  emptyReason?: string,
): string {
  // Ветки собираются по ВСЕМ опрошенным воркспейсам, а не по двум именованным
  // (R3): иначе `vec` из репозиторного источника не попал бы в ярлык, и футер
  // назвал бы не те ветки, что реально дали выдачу.
  const sources = new Set<string>();
  for (const r of queriedModes(mode)) for (const s of r.sources) sources.add(s);
  const parts: string[] = [];
  if (sources.has("vector")) parts.push("vec");
  if (sources.has("fts")) parts.push("bm25");
  if (sources.has("graph")) parts.push("graph");

  const bareBase =
    parts.length === 0
      ? ""
      : sources.has("vector")
        ? `${parts.join("+")} rrf(k=${rrfK})`
        : parts.length === 1
          ? `${parts.join("+")} only`
          : parts.join("+");

  // Лексика дала ноль, выдача целиком держится на слабом векторе (И2,
  // myc-ye3.9) — сам ярлык уже врёт спокойствием "vec rrf(...)", если это не
  // сказать явно рядом с ним.
  const vectorOnly = queriedModes(mode).some((r) => r.vectorOnly);
  const base = vectorOnly && bareBase.length > 0 ? `${bareBase} · только вектор, слабо` : bareBase;

  if (emptyReason !== undefined) {
    return base.length === 0 ? `пусто · ${emptyReason}` : `${base} · пусто · ${emptyReason}`;
  }
  return base.length === 0 ? "пусто" : base;
}

/**
 * Ступень лексического отката в ярлыке режима (S44). Названа ступень, а не
 * просто «был откат»: «И→префиксы» и «И→без одного слова» — разные вещи, и по
 * первой пользователь сразу понимает, что дело было в форме слова.
 */
const STAGE_LABEL: Readonly<Record<string, string>> = {
  prefix_and: "И→префиксы",
  prefix_relaxed: "И→без одного слова",
  prefix_relaxed2: "И→без двух слов",
  prefix_or: "И→ИЛИ префиксов",
  or: "И→ИЛИ",
};

export function lexicalLabelOf(mode: FederatedModeUsed): string | undefined {
  const tiers = queriedModes(mode);
  const fallback = tiers.find((t) => t.lexical.fallbackUsed);
  if (fallback === undefined) {
    const or = tiers.find((t) => t.lexical.operator !== "and");
    return or === undefined ? undefined : (STAGE_LABEL[or.lexical.operator] ?? "ИЛИ");
  }
  const label = STAGE_LABEL[fallback.lexical.operator] ?? "откат";
  return fallback.lexical.coverageApplied ? `${label}+покрытие` : label;
}

/**
 * ПОЧЕМУ ПУСТО — одной строкой, из трёх разных источников правды.
 *
 * `pool` — сколько строк дал ретривал ДО фильтров, `kept` — сколько осталось
 * после фильтров и дедупа. Различать обязательно: «ничего не нашлось» и
 * «нашлось, но всё отфильтровано твоим же --kind» — разные новости, и вторую
 * пользователь чинит сам, за секунду.
 *
 * ТОЧНОСТЬ, А НЕ ТОЛЬКО ГРОМКОСТЬ (И2). Дежурный список «ослабь
 * --kind/--tag/--layer/--since» был враньём ровно в том случае, ради которого
 * его и печатали: из чужого репозитория выдачу отсекает ОХВАТ РЕПОЗИТОРИЯ
 * (S59), ни один из четырёх названных флагов к делу не относится, и человек,
 * послушавшись, крутит не те ручки и уходит с мыслью «знания нет». Поэтому
 * причина берётся из счётчиков {@link DropCounts}, посчитанных ТАМ ЖЕ, где
 * отсев и происходит, а рядом печатается готовая команда снятия — из ручек
 * той поверхности, что спрашивает ({@link DropKnobs}).
 */
export function emptyReasonOf(
  mode: FederatedModeUsed,
  pool: number,
  kept: number,
  drops: DropCounts,
  knobs: DropKnobs,
): string | undefined {
  if (kept > 0) return undefined;
  if (pool > 0) {
    return `${pool} найдено, но всё отсеяно · ${dropAdviceOf(drops, knobs)}`;
  }
  // Источники объясняются ПО ОТДЕЛЬНОСТИ: «в проекте пусто, а в личном не
  // нашлось» — это две разные причины, и склеивать их в одну было бы враньём.
  // С R3 их до шестнадцати, поэтому имя источника стоит рядом с причиной.
  const parts: string[] = [];
  for (const r of mode.sources) {
    if (!r.queried || r.mode?.emptyReason === undefined) continue;
    parts.push(`${r.id}: ${r.mode.emptyReason.text}`);
  }
  const why = parts.length === 0 ? "ретривал не дал ни одной строки" : parts.join("; ");
  // --layer сужает САМ ЗАПРОС (layerMin/layerMax уходят в SQL гибрида), а не
  // выдачу после него: до постфильтров такие узлы просто не доезжают и в
  // DropCounts их нет. Молчать об этом нельзя — «не совпал» под неснятым
  // ярусом читается как «этого нет в памяти», хотя оно есть слоем ниже.
  return knobs.layer.length === 0 ? why : `${why} · поиск шёл под ${knobs.layer}`;
}

// ---------------------------------------------------------------------------
// Отсев по причинам (S59 + И2)
// ---------------------------------------------------------------------------

/**
 * ПРИЧИНЫ ОТСЕВА — по одной на фильтр, в порядке проверки.
 *
 * Индексы — позиции битов в маске причин: строка помечается битом каждого
 * сработавшего фильтра, и уже маска решает, ЧЕЙ это отсев. Маска, а не первый
 * же `return false`, потому что совет обязан быть проверяемым: строку, у
 * которой сработал ровно один фильтр, снятие этого фильтра ВЕРНЁТ, а строку,
 * которую отсекли двое, — нет, и обещать обратное значит повторить ту же
 * ложь дежурным списком, только адреснее.
 *
 * `layer` в списке нет намеренно: он живёт в SQL гибрида и отсеивает до пула
 * (см. {@link emptyReasonOf}).
 */
const DROP_REASONS = [
  "kind",
  "since",
  "until",
  "tag",
  "acl",
  "author",
  "anchor",
  "reach",
  "session",
  "repo",
  "several",
  "dedup",
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/** Сколько строк отсеяла каждая причина. Сумма ≤ pool. */
export type DropCounts = Readonly<Record<DropReason, number>>;

const D_KIND = 0;
const D_SINCE = 1;
const D_UNTIL = 2;
const D_TAG = 3;
const D_ACL = 4;
const D_AUTHOR = 5;
const D_ANCHOR = 6;
const D_REACH = 7;
const D_SESSION = 8;
const D_REPO = 9;
const D_SEVERAL = 10;
const D_DEDUP = 11;

export function emptyDropCounts(): DropCounts {
  return countsOf(new Array<number>(DROP_REASONS.length).fill(0));
}

function countsOf(raw: readonly number[]): DropCounts {
  const out: Record<string, number> = {};
  for (let i = 0; i < DROP_REASONS.length; i++) out[DROP_REASONS[i]!] = raw[i] ?? 0;
  return out as DropCounts;
}

/**
 * Ручки ТОЙ поверхности, что спрашивает. Совет называет флаг только отсюда:
 * у `myc search` нет `--repo`, и напечатать его там значило бы послать
 * человека в usage-ошибку вместо ответа.
 */
export interface DropKnobs {
  /** Имена флагов команды (без дефисов) — берутся из её же FlagSpec[]. */
  readonly flags: readonly string[];
  /** Репозиторий, по которому реально фильтровали; пусто — не фильтровали. */
  readonly repo: string;
  /** Печатное представление заданного --layer; пусто — ярус не сужали. */
  readonly layer: string;
}

/**
 * МАСКА ПРИЧИН ОТСЕВА одной строки: бит на каждый сработавший фильтр, 0 —
 * строка проходит. Единственное место, где живёт постфильтр recall и search.
 *
 * И1. Ранних `return false` здесь нет намеренно: они экономили несколько
 * сравнений полей уже гидратированной строки (пул ≤ 100) и стоили правды о
 * том, ЧЕЙ это был отсев — а без неё подсказка при пустой выдаче звала
 * крутить не те ручки. Маска — одно целое число на строку, ноль аллокаций;
 * цену этого размена меряет retrieve.drop-latency.test.ts.
 */
export function dropMaskOf(row: RetrieveRow, f: RetrieveFilters, repoWanted: string): number {
  let mask = 0;
  if (f.kinds !== undefined && f.kinds.length > 0 && !matchKind(row, f.kinds)) {
    mask |= 1 << D_KIND;
  }
  if (f.since !== undefined && row.updated_at < f.since) mask |= 1 << D_SINCE;
  if (f.until !== undefined && row.updated_at > f.until) mask |= 1 << D_UNTIL;
  if (f.tags !== undefined && f.tags.length > 0) {
    const own = row.tags ?? [];
    if (!f.tags.some((t) => own.includes(t))) mask |= 1 << D_TAG;
  }
  if (f.acl !== undefined && f.acl.length > 0 && !f.acl.includes(row.acl ?? "")) {
    mask |= 1 << D_ACL;
  }
  if (f.author !== undefined && (row.author ?? "") !== f.author) mask |= 1 << D_AUTHOR;
  if (f.anchor !== undefined) {
    const needle = f.anchor;
    if (!(row.anchors ?? []).some((a) => a.includes(needle))) mask |= 1 << D_ANCHOR;
  }
  if (f.reach !== undefined && f.reach.length > 0 && !f.reach.includes(row.reach)) {
    mask |= 1 << D_REACH;
  }
  if (f.reachSession !== undefined && f.reachSession.length > 0) {
    if (row.reach_session !== f.reachSession) mask |= 1 << D_SESSION;
  }
  // Охват репозитория (S59). Отсев здесь, рядом с охватом сессии, а не в SQL
  // гибрида: у recall бюджет 25 мс, и лишний терм в трёх запросах пула стоил
  // бы дороже, чем проверка поля у сотни уже гидратированных строк. Общее и
  // неопределённое проходят фильтр всегда.
  if (repoWanted.length > 0) {
    if (!visibleInRepo({ repo: row.repo, state: row.repo_state, by: "recorded" }, repoWanted)) {
      mask |= 1 << D_REPO;
    }
  }
  return mask;
}

/** Причина по маске ровно с одним битом — для тестов и разбора выдачи. */
export function dropReasonOf(mask: number): DropReason | undefined {
  if (mask === 0) return undefined;
  return DROP_REASONS[(mask & (mask - 1)) !== 0 ? D_SEVERAL : 31 - Math.clz32(mask)];
}

/**
 * Печатное представление заданного `--layer` — ровно в той форме, в какой
 * человек его набрал бы обратно (`--layer L1`, `--layer L1..L3`). Пусто —
 * ярус не сужали.
 */
export function layerLabelOf(min: Layer | undefined, max: Layer | undefined): string {
  if (min === undefined && max === undefined) return "";
  const lo = min ?? 0;
  const hi = max ?? 3;
  return lo === hi ? `--layer L${lo}` : `--layer L${lo}..L${hi}`;
}

/** Человеческое имя причины — то, что человек ищет глазами в подвале. */
const DROP_LABEL: Readonly<Record<DropReason, string>> = {
  kind: "тип",
  since: "давность",
  until: "верхняя граница даты",
  tag: "теги",
  acl: "acl",
  author: "автор",
  anchor: "якорь",
  reach: "охват памяти",
  session: "охват сессии",
  repo: "охват репозитория",
  several: "несколько фильтров сразу",
  dedup: "дедуп",
};

/** Флаг, которым причина снимается, и значение, которое её снимает. */
const DROP_FIX: Readonly<Record<DropReason, { readonly flag: string; readonly fix: string }>> = {
  kind: { flag: "kind", fix: "убери --kind" },
  since: { flag: "since", fix: "убери --since" },
  until: { flag: "until", fix: "убери --until" },
  tag: { flag: "tag", fix: "убери --tag" },
  acl: { flag: "acl", fix: "убери --acl" },
  author: { flag: "author", fix: "убери --author" },
  anchor: { flag: "anchor", fix: "убери --anchor" },
  reach: { flag: "reach", fix: "убери --reach" },
  session: { flag: "session", fix: "убери --reach session" },
  repo: { flag: "repo", fix: "--repo all" },
  several: { flag: "", fix: "" },
  dedup: { flag: "", fix: "" },
};

/**
 * Причина с НАИБОЛЬШИМ вкладом и готовая команда её снятия.
 *
 * При равенстве вкладов выигрывает причина, стоящая в цепочке ПОЗЖЕ: чем
 * позже фильтр, тем больше проверок строка уже прошла, и тем вернее её
 * возвращает снятие именно этого фильтра.
 */
export function dropAdviceOf(drops: DropCounts, knobs: DropKnobs): string {
  let best: DropReason | undefined;
  let bestN = 0;
  for (const r of DROP_REASONS) {
    const n = drops[r];
    if (n > 0 && n >= bestN) {
      best = r;
      bestN = n;
    }
  }
  if (best === undefined) return "фильтры и дедуп ни при чём — строки потерялись между ними";

  const label = DROP_LABEL[best];
  if (best === "dedup") {
    return `${label} — ${bestN}: одинаковые факты из разных ярусов, снять нечем`;
  }
  if (best === "several") {
    return `${label} — ${bestN}: ослабляй по одному, начиная с самого узкого`;
  }
  const named =
    best === "repo" && knobs.repo.length > 0 ? `${label} ${knobs.repo}` : label;
  const { flag, fix } = DROP_FIX[best];
  if (!knobs.flags.includes(flag)) {
    // Флага у этой поверхности нет — значит фильтр пришёл умолчанием, и
    // единственный честный совет тот, который здесь работает.
    return best === "repo"
      ? `${named} — ${bestN}; сними: позови из корня экосистемы`
      : `${named} — ${bestN}`;
  }
  return `${named} — ${bestN}; сними: ${fix}`;
}

/** Одной строкой: почему режим именно такой — для --why. */
export function whyLines(mode: FederatedModeUsed): string[] {
  const lines: string[] = [];
  for (const r of mode.sources) {
    const name = r.id.slice(0, 9).padEnd(9);
    if (r.queried && r.mode !== undefined) {
      lines.push(`${name} vector=${r.mode.vector} · ${r.mode.why}`);
    } else {
      // Пропущенный источник получает СВОЮ строку в --why, а не отсутствие
      // строки: невидимый пропуск — ровно то, что запрещает И2.
      lines.push(`${name} пропущен · ${r.skipped ?? "без причины"}`);
    }
  }
  lines.push(`tiers     ${mode.why}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Основной путь
// ---------------------------------------------------------------------------

/**
 * Пул кандидатов у ретривала берётся с запасом относительно limit: фильтры
 * (kind/tag/since/acl) применяются ПОСЛЕ ранжирования, и без запаса `-n 3`
 * с фильтром вернул бы 0 строк там, где ответы есть. Запас конечен, поэтому
 * его исчерпание честно помечается poolExhausted, а не выдаётся за точный
 * total.
 */
const POOL_MULTIPLIER = 8;
const POOL_MAX = 100;

/** Имя источника «воркспейс, из которого позвали» — оно же прежний ярус S41. */
const PROJECT_SOURCE = "project";

/**
 * Вес соседнего репозиторного воркспейса в межисточниковом RRF (R3).
 *
 * ПОЧЕМУ 0.99, А НЕ 0.8 — ЭТО СЧИТАЕТСЯ, А НЕ ВЫБИРАЕТСЯ НА ГЛАЗ. Вклад узла
 * ранга r из источника с весом w равен w/(k+r), k=60. Значит вес не «слегка
 * понижает» соседа, а ЗАДВИГАЕТ весь его список ниже первых r* строк своего
 * воркспейса, где r* решает 1/(60+r*) = w/61:
 *
 *   w=0.80 → r*≈16: лучший хит соседа стоит НИЖЕ шестнадцатого своего, то
 *            есть при limit 12 сосед не появляется вовсе, пока у своего
 *            воркспейса есть хоть дюжина совпадений. Замер это и показал:
 *            на 16 одинаковых корпусах вся выдача пришла из одного источника.
 *   w=0.99 → r*≈1.6: свой ранг 1 выигрывает у соседского ранга 1, а соседский
 *            ранг 1 выигрывает у своего ранга 2. Это и есть «при РАВНОМ ранге
 *            свой главнее» — тайбрейк, а не вытеснение.
 *
 * Вся задача R3 — чтобы знание соседа попадало в выдачу; вес, который его
 * оттуда убирает, решал бы обратную задачу.
 */
const REPO_SOURCE_WEIGHT = 0.99;

function callerOf(actor: string): FtsCaller {
  // Узлы, которые пишет myc remember, живут с acl='team' и пустыми
  // owner/team/agent (см. createNode): пустой вызывающий видит ровно такие же
  // анонимные узлы — это документированное поведение FtsCaller, не дыра.
  return { ownerId: "", teamId: "", agentId: "", principals: [actor] };
}

function matchKind(row: { kind: string; type: string }, kinds: readonly string[]): boolean {
  for (const name of kinds) {
    const spec = KIND_FILTER[name];
    if (spec === undefined) continue;
    if (spec.kind !== row.kind) continue;
    if (spec.type !== undefined && spec.type !== row.type) continue;
    return true;
  }
  return false;
}

/** Ключ дедупликации: одинаковый факт из двух ярусов — одна строка. */
function dedupKey(row: RetrieveRow): string {
  return `${row.kind} ${row.title.trim().toLowerCase()}`;
}

export function parseKinds(
  raw: string | undefined,
): { ok: true; kinds: string[] } | { ok: false; bad: string } {
  if (raw === undefined) return { ok: true, kinds: [] };
  const kinds: string[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    if (KIND_FILTER[part] === undefined) return { ok: false, bad: part };
    kinds.push(part);
  }
  return { ok: true, kinds };
}

export function parseLayerRange(
  raw: string | undefined,
): { ok: true; min?: Layer; max?: Layer } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const m = /^L?([0-3])(?:\.\.L?([0-3]))?$/i.exec(raw.trim());
  if (!m) return { ok: false };
  const min = Number(m[1]) as Layer;
  const max = m[2] !== undefined ? (Number(m[2]) as Layer) : min;
  return { ok: true, min, max };
}

export async function retrieve(
  ctx: CommandContext,
  deps: RetrieveDeps,
  req: RetrieveRequest,
): Promise<RetrieveResult> {
  const t0 = performance.now();
  if (req.text.trim().length === 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "usage.invalid",
        msg: "нужен запрос: myc recall <текст> / myc search <текст>",
        exit: ExitCode.USAGE,
      },
    };
  }

  // РАНТАЙМ РАСШИРЕНИЙ ПОДНИМАЕТСЯ ЗДЕСЬ (решение S45, myc-ye3.8).
  //
  // recall/search — единственные команды CLI, которые умеют звать векторный
  // поиск, и единственные, у кого бюджет 25 мс, а не 3 мс. Без этого флага
  // vec0 не грузился ни на одном пути CLI, векторные миграции по S26 не
  // применялись никогда, и `nodes_vec` не появлялась ни в одной базе —
  // векторная ветка была недостижима при любых настройках, сколько бы
  // эмбеддер ни грелся.
  //
  // Просить расширения обязательно на ПЕРВОМ открытии базы в процессе:
  // Database.setCustomSQLite нельзя вызвать после первого соединения.
  // Поэтому проектный ярус открывается с ними, и личный (ниже) — тоже:
  // векторный поиск федеративен, второй ярус ищет тем же способом.
  const opened = await deps.openStore(ctx, VECTOR_OPEN);
  if (!opened.ok) return { ok: false, failure: opened.failure };
  const project = opened.handle;

  // Расширения просили, но не подняли: назвать причину обязаны здесь и
  // дословно (И2). Дальше выдача идёт без вектора — ровно как раньше, но
  // теперь видно, ПОЧЕМУ, а не только что «вектора нет».
  if (project.vec0Reason !== undefined) {
    ctx.warn(
      "degraded.vector_runtime",
      `рантайм расширений не поднялся — векторная ветка недоступна в этом процессе: ${project.vec0Reason}`,
    );
  }

  // ---------------------------------------------------------------------
  // СПИСОК ИСТОЧНИКОВ (R3). Не два именованных поля, а порядок приоритета.
  //
  // Здесь только ОПИСАНИЯ: ни одна база, кроме своей, ещё не открыта.
  // Открытие делает federatedSearch и только для прошедших отбор — открыть
  // шестнадцать баз, чтобы опросить восемь, стоило бы ровно того, от чего
  // уходит ленивость (И1). Каждый открытый хендл оседает в `openedById`:
  // по нему идёт гидратация строк и по нему же всё закрывается в finally.
  // ---------------------------------------------------------------------
  const openedById = new Map<string, StoreHandle>();
  openedById.set(PROJECT_SOURCE, project);
  const federationSources: FederationSource[] = [
    // Свой воркспейс — всегда первый и всегда опрашивается: он уже открыт.
    { id: PROJECT_SOURCE, kind: "project", scopes: [project.scope], weight: 1.0, open: () => project.driver },
  ];

  // Личный ярус: проверка существования — statSync, не открытие (S41).
  // Его нет на диске — источника нет вовсе, и federatedSearch скажет об этом
  // прежней формулировкой «личный ярус не открыт».
  if (personalWorkspaceStatus().exists) {
    federationSources.push({
      id: PERSONAL_SLUG,
      kind: "personal",
      scopes: [PERSONAL_SLUG],
      weight: 1.0,
      open: async () => {
        const openedPersonal = await deps.openPersonal(ctx, VECTOR_OPEN);
        if (!openedPersonal.ok) throw new Error(openedPersonal.failure.msg);
        if (openedPersonal.handle === undefined) throw new Error("личного яруса нет на диске");
        openedById.set(PERSONAL_SLUG, openedPersonal.handle);
        return openedPersonal.handle.driver;
      },
    });
  }

  // Репозиторные воркспейсы экосистемы (S59): readdir + stat, без открытия.
  for (const ws of deps.discoverRepos?.(project.wsDir) ?? []) {
    if (ws.dir === project.wsDir) continue; // сам себя соседом не считает
    if (federationSources.some((f) => f.id === ws.id)) continue;
    federationSources.push({
      id: ws.id,
      kind: "repo",
      scopes: [ws.scope],
      // Соседний репозиторий — контекст, а не текущая работа: при РАВНОМ
      // ранге свой воркспейс обязан выиграть. Вес меньше единицы — то, чем
      // это выражается в RRF, и он виден в mode_used.sources[].weight.
      weight: REPO_SOURCE_WEIGHT,
      open: async () => {
        if (deps.openRepo === undefined) throw new Error("openRepo не подключён");
        const openedRepo = await deps.openRepo(ctx, ws, VECTOR_OPEN);
        if (!openedRepo.ok) throw new Error(openedRepo.failure.msg);
        openedById.set(ws.id, openedRepo.handle);
        return openedRepo.handle.driver;
      },
    });
  }

  try {
    const caller = callerOf(project.actor);
    const poolLimit = Math.min(
      POOL_MAX,
      Math.max(req.limit + (req.offset ?? 0), 1) * POOL_MULTIPLIER,
    );
    const vectorMode = req.mode === "bm25" ? "never" : req.mode === "vec" ? "always" : "auto";

    const searchOnce = (embedQuery: () => Float32Array | null) =>
      federatedSearch({
        text: req.text,
        caller,
        limit: poolLimit,
        vectorMode,
        embedQuery,
        ...(req.filters.layerMin !== undefined ? { layerMin: req.filters.layerMin } : {}),
        ...(req.filters.layerMax !== undefined ? { layerMax: req.filters.layerMax } : {}),
        sources: federationSources,
        ...(req.maxSources !== undefined ? { maxSources: req.maxSources } : {}),
        ...(req.federationDeadlineMs !== undefined
          ? { deadlineMs: req.federationDeadlineMs }
          : {}),
      });

    // Фаза 1: вектор ещё не считался. Колбэк только помечает, что он нужен.
    let vectorWanted = false;
    let result = await searchOnce(() => {
      vectorWanted = true;
      return null;
    });

    // Фаза 2: вектор понадобился — берём его там, где он уже готов, и только
    // потом платим сами.
    //
    // ПОРЯДОК ИСТОЧНИКОВ (S44). Сначала прогретый демон: у него сессия ONNX уже
    // поднята, вектор стоит ~28 мс вместо 223 + 28. Затем — прежний путь с
    // прогревом в процессе, но он по-прежнему выключен по умолчанию
    // (--embed-timeout 0). Если ни один не дал вектора, прогрев ЗАПУСКАЕТСЯ В
    // ФОНЕ и текущая выдача честно идёт без вектора: ждать прогрева нельзя,
    // это ровно те 223 мс, из-за которых ветка и была выключена.
    if (vectorWanted) {
      const warm = deps.warmEmbedder?.(ctx, project);
      const socketTimeoutMs = req.embedSocketTimeoutMs ?? embedSocketTimeoutFromEnv();
      const fromDaemon: DaemonVector | undefined =
        warm !== undefined && socketTimeoutMs > 0
          ? await warm.vector(req.text, socketTimeoutMs)
          : undefined;

      let vec: Float32Array | null = fromDaemon?.ok === true ? fromDaemon.vec : null;

      if (vec === null) {
        if (fromDaemon !== undefined && !fromDaemon.ok && fromDaemon.daemon !== "absent") {
          // Демон есть, но вектора не дал. Говорим это вслух и НЕ поднимаем
          // второго: пока он греется, каждый запрос плодил бы ещё одного.
          ctx.warn(
            "degraded.embeddings",
            `прогретый эмбеддер не дал вектор (${fromDaemon.daemon}: ${fromDaemon.reason}) — ` +
              "эта выдача без вектора",
          );
        }

        const resolved = await deps.resolveEmbedder(req.embedTimeoutMs);
        if (resolved.ok) {
          const own = await resolved.embed(req.text);
          if (own !== null) vec = own;
          else ctx.warn("degraded.embeddings", "эмбеддер не вернул вектор запроса");
        } else {
          ctx.warn("degraded.embeddings", resolved.reason);
          // Прогрев поднимается ровно тогда, когда вектор был НУЖЕН, демона
          // нет вовсе и своего эмбеддера тоже: не на каждой команде и не «на
          // всякий случай».
          if (fromDaemon === undefined || fromDaemon.ok || fromDaemon.daemon === "absent") {
            const started = warm?.warmInBackground();
            if (started !== undefined) ctx.warn("degraded.embeddings", started);
          }
        }
      }

      if (vec !== null) {
        const ready = vec;
        result = await searchOnce(() => ready);
      }
    }

    // Дедлайн бюджетированного ретривала (§2.7) стартует ПОСЛЕ эмбеддинга
    // запроса: гидратация, фильтры, дедуп и сборка ответа живут ВНУТРИ
    // budgetTimeoutMs. Монотонные часы (performance.now).
    const tPost = performance.now();

    // Деградация собирается по ВСЕМ опрошенным воркспейсам с ИМЕНЕМ источника
    // в строке (R3): «vec недоступен» без имени на шестнадцати источниках не
    // говорит ничего.
    const degraded: string[] = [];
    for (const r of result.mode_used.sources) {
      for (const d of r.mode?.degraded ?? []) degraded.push(`${r.id}: ${d}`);
    }
    // Пропущенный воркспейс — тоже деградация выдачи, а не тихая экономия:
    // выдача НЕ полна, и это обязано дойти до WARN, meta.degraded[] и exit 6
    // под --strict, а не только до подвала (И2).
    for (const r of result.mode_used.sources) {
      if (!r.queried) degraded.push(`источник ${r.id} не опрошен: ${r.skipped ?? "без причины"}`);
    }
    for (const d of degraded) ctx.warn("degraded.retrieval", d);

    // --- фильтры и гидратация ---------------------------------------------
    const hits: readonly FederatedHit[] = result.hits;
    // Теги, якоря и видимый тип лежат в attrs и берутся лёгкой гидратацией
    // всегда; тело, acl, автор и даты — только когда их реально показывают
    // или по ним фильтруют.
    const needFull =
      req.fullFields || (req.filters.acl?.length ?? 0) > 0 || req.filters.author !== undefined;

    const fullById = new Map<string, FullRow>();
    const attrsById = new Map<string, Record<string, JsonValue>>();
    if (hits.length > 0) {
      // Гидратация идёт из ТОГО ЖЕ воркспейса, откуда пришёл хит (R3): id
      // уникален внутри воркспейса, но не между ними, и seek не в ту базу
      // молча вернул бы чужую строку или ничего.
      const bySource = new Map<string, string[]>();
      for (const h of hits) {
        const list = bySource.get(h.source);
        if (list === undefined) bySource.set(h.source, [h.id]);
        else list.push(h.id);
      }
      for (const [sourceId, ids] of bySource) {
        const handle = openedById.get(sourceId);
        if (handle === undefined || ids.length === 0) continue;
        const args = [JSON.stringify(ids)];
        if (needFull) {
          for (const row of handle.driver.all<FullRow>(QR.hydrate_full, args)) {
            fullById.set(row.id, row);
            attrsById.set(row.id, parseAttrs(row.attrs));
          }
        } else {
          for (const row of handle.driver.all<LightRow>(QR.hydrate_light, args)) {
            attrsById.set(row.id, parseAttrs(row.attrs));
          }
        }
      }
    }

    const all: RetrieveRow[] = [];
    for (const h of hits) {
      const full = fullById.get(h.id);
      const attrs = attrsById.get(h.id) ?? {};
      const reachInfo = readReach(attrs);
      const repoInfo = readRepo(attrs);
      all.push({
        id: h.id,
        rank: h.rank,
        score: h.score,
        ...(h.vecConfidence !== undefined
          ? { confidence: Math.round(h.vecConfidence * 100) / 100 }
          : {}),
        sources: [...h.sources],
        source: h.source,
        tier: h.tier,
        ...(h.foundIn.length > 1 ? { found_in: [...h.foundIn] } : {}),
        kind: h.kind,
        type: attrType(h.kind, attrs),
        layer: h.layer,
        updated_at: h.updatedAt,
        title: h.title,
        excerpt: h.excerpt,
        tags: attrTags(attrs),
        anchors: attrAnchors(attrs),
        // attrs уже разобраны лёгкой гидратацией — охват достаётся из них
        // бесплатно, без второго round-trip'а и без нового запроса.
        reach: reachInfo.reach,
        reach_session: reachInfo.session,
        reach_by: reachInfo.by,
        repo: repoInfo.repo,
        repo_state: repoInfo.state,
        ...(full !== undefined
          ? {
              created_at: full.created_at,
              acl: full.acl,
              author: full.actor,
              status: full.status,
              body: full.body,
            }
          : {}),
      });
    }

    const f = req.filters;
    // Цель фильтра по репозиторию — то же умолчание, что у `myc ready`:
    // каталог вызова. Явный `--repo` сильнее, `--repo all` снимает фильтр.
    const repoWanted = repoTarget(project, f.repo);
    const dropCount = new Array<number>(DROP_REASONS.length).fill(0);
    const filtered = all.filter((row) => {
      const mask = dropMaskOf(row, f, repoWanted);
      if (mask === 0) return true;
      // Ровно один бит — причина названа адресно и её снятие строку вернёт;
      // больше одного — честное «несколько сразу», потому что снятие любого
      // одного не вернёт ничего.
      const at = (mask & (mask - 1)) !== 0 ? D_SEVERAL : 31 - Math.clz32(mask);
      dropCount[at] = (dropCount[at] ?? 0) + 1;
      return false;
    });

    // Дедупликация одинаковых фактов из двух ярусов. По (kind, заголовку), а
    // не по content_hash: хеш лежит в nodes и потребовал бы ещё одного
    // round-trip'а в recall, чей бюджет 25 мс, — а склеивает он ровно те же
    // строки, потому что сам считается от (kind, title, body).
    const seen = new Set<string>();
    const unique: RetrieveRow[] = [];
    let deduped = 0;
    for (const row of filtered) {
      const key = dedupKey(row);
      if (seen.has(key)) {
        deduped++;
        // Дедуп — такая же причина пустоты, как фильтр, и в советe он обязан
        // называться своим именем: «снять нечем» — тоже ответ, а «ослабь
        // --kind» на схлопнутых дублях было бы ложью.
        dropCount[D_DEDUP] = (dropCount[D_DEDUP] ?? 0) + 1;
        continue;
      }
      seen.add(key);
      unique.push(row);
    }

    const offset = req.offset ?? 0;
    const page = unique
      .slice(offset, offset + req.limit)
      .map((r, i) => ({ ...r, rank: offset + i + 1 }));

    // --- бюджетированная сборка ответа (§2.7) ------------------------------
    // Pass 2 поднимает crux → тело ЦЕЛИКОМ, поэтому странице нужны тела.
    // В лёгком режиме (recall) они не гидратировались: добираем ТОЛЬКО для
    // страницы — один seek по PK на узел, в дедлайне tPost укладывается.
    if (!needFull && page.length > 0) {
      const pageBySource = new Map<string, string[]>();
      for (const r of page) {
        const list = pageBySource.get(r.source);
        if (list === undefined) pageBySource.set(r.source, [r.id]);
        else list.push(r.id);
      }
      for (const [sourceId, ids] of pageBySource) {
        const handle = openedById.get(sourceId);
        if (handle === undefined || ids.length === 0) continue;
        for (const row of handle.driver.all<FullRow>(QR.hydrate_full, [JSON.stringify(ids)])) {
          fullById.set(row.id, row);
        }
      }
    }

    const charBudget = req.charBudget ?? DEFAULT_CHAR_BUDGET;
    const answer = assembleBudgeted(
      page,
      {
        excerpt: (r) => r.excerpt,
        content: (r) => fullById.get(r.id)?.body ?? r.body ?? null,
      },
      {
        charBudget,
        timeoutMs: req.budgetTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        upgradeContent: req.upgradeContent ?? req.fullFields,
        startAt: tPost,
      },
    );

    // И2 + сериализация: у crux-строки тела в ответе НЕТ — иначе full body
    // утащил бы бюджет мимо счётчика уже на конверте JSON.
    const budgetedRows: RetrieveRow[] = answer.items.map(({ item, kind, text }) =>
      kind === "full"
        ? { ...item, body: text, content_kind: "full" }
        : { ...item, body: undefined, excerpt: text, content_kind: "crux" },
    );

    // cursor продолжает выдачу тем же механизмом, что --offset.
    const nextOffset = offset + page.length;
    const cursor = nextOffset < unique.length ? String(nextOffset) : undefined;
    const partial = answer.omitted > 0 || answer.timedOut || cursor !== undefined;

    // Пустая выдача обязана объясниться (S44). Причина идёт в ярлык режима —
    // тот печатается в футере обеих команд и лежит в meta, — а структурно она
    // уже есть в mode_used.*.emptyReason для --json.
    const drops = countsOf(dropCount);
    const emptyReason = emptyReasonOf(result.mode_used, hits.length, unique.length, drops, {
      flags: req.knobs ?? [],
      repo: repoWanted,
      layer: layerLabelOf(f.layerMin, f.layerMax),
    });
    const lexicalLabel = lexicalLabelOf(result.mode_used);
    const baseLabel = modeLabelOf(result.mode_used, DEFAULT_HYBRID_CONFIG.rrfK, emptyReason);
    const modeLabel = lexicalLabel === undefined ? baseLabel : `${baseLabel} · ${lexicalLabel}`;

    return {
      ok: true,
      outcome: {
        rows: budgetedRows,
        total: unique.length,
        pool: hits.length,
        poolExhausted: hits.length >= poolLimit,
        mode_used: result.mode_used,
        modeLabel,
        ...(emptyReason !== undefined ? { emptyReason } : {}),
        degraded,
        tiers: { project: true, personal: result.mode_used.personalQueried },
        federation: {
          queried: result.mode_used.sources.filter((r) => r.queried).map((r) => r.id),
          skipped: result.mode_used.sources
            .filter((r) => !r.queried)
            .map((r) => ({ id: r.id, why: r.skipped ?? "без причины" })),
          total: result.mode_used.sources.length,
          cap: result.mode_used.cap,
          took_ms: result.mode_used.took_ms,
        },
        repo: repoWanted,
        took_ms: Math.round((performance.now() - t0) * 10) / 10,
        deduped,
        drops,
        partial,
        omitted: answer.omitted,
        ...(cursor !== undefined ? { cursor } : {}),
        budgetTimedOut: answer.timedOut,
        budgetChars: charBudget,
        usedChars: answer.usedChars,
      },
    };
  } finally {
    // Закрывается ровно то, что было открыто, — а открыто было ровно то, что
    // прошло отбор (И1): openedById и есть этот список.
    for (const handle of openedById.values()) handle.close();
  }
}

/** Есть ли личный ярус на диске — для подсказки, без открытия базы. */
export function personalTierExists(): boolean {
  return personalWorkspaceStatus().exists;
}
