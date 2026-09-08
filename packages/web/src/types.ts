/**
 * Форма данных между сервером просмотрщика и браузером. Единственный файл,
 * который импортируют обе стороны, — и только как `import type`: в рантайме
 * от него не остаётся ничего, поэтому клиентские модули остаются
 * самодостаточными и не требуют бандлера.
 */

export type VizTab =
  | "graph"
  | "ready"
  | "board"
  | "timeline"
  | "health"
  | "kb"
  | "routing"
  | "bootstrap"
  | "search"
  | "decisions";

// ---------------------------------------------------------------------------
// Граф
// ---------------------------------------------------------------------------

/** Узел в графе: только то, что рисуется или попадает в подсказку. */
export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly layer: number;
  readonly priority: number;
  readonly title: string;
  /** Степень по живым рёбрам — по ней же отбираются top-N при усечении. */
  readonly deg: number;
  readonly updated_at: number;
}

/**
 * Ребро индексами в `GraphPayload.nodes`, а не идентификаторами: на 30k рёбер
 * это разница между ~1.8 МБ JSON и ~340 КБ.
 */
export interface GraphEdge {
  readonly s: number;
  readonly d: number;
  readonly t: string;
}

export interface GraphPayload {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly total_nodes: number;
  readonly total_edges: number;
  /** true — узлов в базе больше лимита, отдан top-N по степени. */
  readonly truncated: boolean;
  readonly limit: number;
  readonly took_ms: number;
}

// ---------------------------------------------------------------------------
// Очередь ready (слагаемые S21)
// ---------------------------------------------------------------------------

export type ReadyTermKey = "priority" | "unblocks" | "freshness" | "anchors" | "type";

/**
 * Одно слагаемое формулы, разобранное до множителей: вес × норма = вклад.
 * Именно ради этой тройки экран очереди и существует — «почему сверху»
 * должно читаться числами, а не словом «важнее».
 */
export interface ReadyTerm {
  readonly key: ReadyTermKey;
  /** Человеческая подпись: «P0», «unblocks 3», «свежесть 6h», «якоря fresh». */
  readonly label: string;
  readonly weight: number;
  readonly norm: number;
  readonly value: number;
}

export interface ReadyRow {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly type: string;
  readonly assignee: string;
  readonly unblocks: number;
  readonly age_ms: number;
  readonly anchors: string;
  readonly score: number;
  readonly terms: readonly ReadyTerm[];
}

export interface ReadyWeights {
  readonly priority: number;
  readonly unblocks: number;
  readonly freshness: number;
  readonly anchors: number;
  readonly type: number;
}

export interface ReadyPayload {
  readonly rows: readonly ReadyRow[];
  readonly ready: number;
  readonly blocked: number;
  readonly in_progress: number;
  readonly weights: ReadyWeights;
  readonly took_ms: number;
}

// ---------------------------------------------------------------------------
// Доска задач (W4)
//
// Колонки здесь — ровно то, что ВЫЧИСЛЯЕТСЯ или ЗАРАБАТЫВАЕТСЯ (S54): open и
// blocked различает open_blockers, in_progress — аренда, closed/cancelled —
// терминальные статусы. Ни одна колонка не хранится как отдельное поле.
// ---------------------------------------------------------------------------

export type BoardColumn = "open" | "blocked" | "in_progress" | "closed" | "cancelled";

export interface BoardRow {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly type: string;
  readonly assignee: string;
  readonly updated_at: number;
  /** Эпик, в который входит задача — вложенность видна прямо в колонке. */
  readonly parent?: { readonly id: string; readonly title: string };
  /** Состав по детям (W5): есть только у узлов, у которых есть дети. */
  readonly progress?: CardProgress;
}

export interface BoardPayload {
  readonly columns: Record<BoardColumn, readonly BoardRow[]>;
  readonly took_ms: number;
}

// ---------------------------------------------------------------------------
// Таймлайн оплога
// ---------------------------------------------------------------------------

export interface OpRow {
  readonly seq: number;
  readonly ts_ms: number;
  readonly actor: string;
  readonly op: string;
  readonly entity: string;
  readonly entity_id: string;
  readonly field: string | null;
  /** Значение уже усечено сервером: в ленту не едут тела заметок. */
  readonly value: string | null;
  readonly scope: string;
  /** 1 — запись этого сайта, 0 — приехала репликацией. */
  readonly origin: number;
  /** Заголовок узла, если он ещё жив, — иначе в ленте только идентификаторы. */
  readonly title: string | null;
}

export interface TimelinePayload {
  readonly rows: readonly OpRow[];
  readonly total: number;
  readonly last_seq: number;
  readonly took_ms: number;
}

// ---------------------------------------------------------------------------
// Здоровье
// ---------------------------------------------------------------------------

export interface CountRow {
  readonly key: string;
  readonly n: number;
}

export interface Degradation {
  readonly code: string;
  readonly msg: string;
}

export interface HealthComponent {
  readonly component: string;
  readonly state: string;
  readonly reason: string;
  readonly since: number;
}

export interface HealthPayload {
  readonly workspace: {
    readonly slug: string;
    readonly db_path: string;
    readonly db_bytes: number;
    readonly wal_bytes: number;
    readonly shm_bytes: number;
    readonly journal_mode: string;
    readonly schema_version: number | null;
    readonly site_id: string;
    readonly myc_version: string;
    readonly read_only: true;
  };
  readonly nodes: { readonly total: number; readonly by_kind: readonly CountRow[] };
  readonly edges: { readonly total: number; readonly by_type: readonly CountRow[] };
  readonly embed: {
    readonly model: string;
    readonly dim: number | null;
    readonly rows: number | null;
    readonly pending: number;
    readonly failed: number;
    readonly state: "ok" | "degraded" | "off" | "unknown";
    readonly detail: string;
  };
  readonly vec: {
    /** Схема vec применена (значит, vec0 был доступен пишущему процессу). */
    readonly schema_applied: boolean;
    readonly versions: readonly number[];
    /** vec0 загружен в самом процессе просмотрщика — он его не грузит. */
    readonly loaded_here: boolean;
    readonly detail: string;
  };
  readonly fts: { readonly available: boolean; readonly detail: string };
  readonly jobs: { readonly pending: number; readonly failed: number; readonly by_kind: readonly CountRow[] };
  readonly anchors: { readonly total: number; readonly by_state: readonly CountRow[] };
  readonly oplog: {
    readonly count: number;
    readonly last_seq: number;
    readonly last_ts: number | null;
    readonly actors: readonly CountRow[];
  };
  readonly components: readonly HealthComponent[];
  readonly degraded: readonly Degradation[];
  readonly took_ms: number;
}

// ---------------------------------------------------------------------------
// База знаний: охваты S58/S59
// ---------------------------------------------------------------------------

/**
 * Охват сессии (S58): `session` — знание своей крупной задачи, `project` —
 * поднято явным решением, `unknown` — охват не записан (узел старше решения
 * или сессия была неизвестна). Третье состояние — не дырка, а честный ответ:
 * в рабочей базе таких большинство, и прятать его значило бы терять память.
 */
export type KbReachState = "session" | "project" | "unknown";

/**
 * Охват репозитория (S59): `repo` — узел части экосистемы (`repo` — имя),
 * `root` — общий, `unknown` — не определён. Ось НЕЗАВИСИМА от охвата сессии
 * и от яруса: проектная по S58 задача бывает про один репозиторий, а
 * сессионная заметка — про всю экосистему.
 */
export type KbRepoState = "repo" | "root" | "unknown";

// ---------------------------------------------------------------------------
// База знаний (виды note, doc, fragment, entity, skill)
// ---------------------------------------------------------------------------

/** Строка списка базы знаний — всё, что нужно строке и её меткам осей. */
export interface KbRow {
  readonly id: string;
  /** Вид ядра. Решение — это note с attrs.type, а не отдельный вид. */
  readonly kind: string;
  /** attrs.type, когда он есть (decision у заметки); иначе null. */
  readonly subtype: string | null;
  readonly title: string;
  readonly status: string;
  readonly layer: number;
  readonly acl: string;
  readonly tags: readonly string[];
  /** Охват сессии (S58) и охват репозитория (S59) — два независимых поля. */
  readonly reach: KbReachState;
  readonly session: string;
  readonly repo: string;
  readonly repo_state: KbRepoState;
  readonly updated_at: number;
}

/** Подвальные счётчики — по ним видно, кого фильтр не показал (И2). */
export interface KbCounts {
  readonly by_kind: readonly CountRow[];
  readonly by_layer: readonly CountRow[];
  readonly reach: { readonly project: number; readonly session: number; readonly unknown: number };
  readonly repo: {
    readonly root: number;
    readonly unknown: number;
    readonly by_repo: readonly CountRow[];
  };
}

export interface KbPayload {
  readonly rows: readonly KbRow[];
  /** Всего узлов базы знаний без фильтров. */
  readonly total: number;
  readonly shown: number;
  readonly counts: KbCounts;
  readonly took_ms: number;
}

// ---------------------------------------------------------------------------
// Карточка узла со связями (myc show в интерфейсе)
// ---------------------------------------------------------------------------

/** Ссылка на связанный узел — строка карточки. */
export interface CardRef {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly priority: number;
  /** Видимый тип: у задач attrs.type, у остальных — сам kind. */
  readonly type: string;
}

export interface CardProgress {
  /** Закрыто. Отменённые сюда НЕ попадают — это счётчик сделанной работы. */
  readonly done: number;
  /** Отменено отдельно: отмена — суждение, а не результат. */
  readonly cancelled: number;
  readonly total: number;
}

export interface CardLink {
  readonly type: string;
  readonly id: string;
  readonly title: string;
}

/**
 * Комментарий — kind='message' узел с ребром `replies_to` на карточку (W13,
 * memory-tje3kp7avp13). `role` читается из attrs.role того же message-узла
 * (конвенция messageInput в @myc/core: "user" — человек, иначе агент) —
 * отдельного поля для этого в ядре нет, и подделывать его здесь нечем.
 */
export interface CardComment {
  readonly id: string;
  readonly author: string;
  readonly role: string;
  readonly body: string;
  readonly created_at: number;
}

/** GET /api/nodes/<id>/card — то же, что печатает `myc show`, только JSON. */
export interface CardView {
  readonly id: string;
  readonly kind: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly priority: number;
  readonly assignee: string;
  readonly acl: string;
  readonly tags: readonly string[];
  readonly estimate_min: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly closed_at: number | null;
  readonly open_blockers: number;
  readonly lease: { readonly holder: string; readonly expires: number } | null;
  /** Слой L0–L3 — колонка узла. */
  readonly layer: number;
  /** Охват сессии (S58): записан при создании; unknown — честное «не записан». */
  readonly reach: KbReachState;
  readonly session: string;
  /** Охват репозитория (S59) — независимая ось, показывается рядом с охватом сессии. */
  readonly repo: string;
  readonly repo_state: KbRepoState;
  readonly parent: CardRef | null;
  readonly children: readonly CardRef[];
  /** null, когда детей нет: прогресс имеет смысл только для состава. */
  readonly progress: CardProgress | null;
  readonly blocked_by: readonly CardRef[];
  readonly blocks: readonly CardRef[];
  readonly links: readonly CardLink[];
  /** Нить комментариев, старые сверху. Пусто, если ни одного нет. */
  readonly comments: readonly CardComment[];
}

// ---------------------------------------------------------------------------
// Стартовый пакет
// ---------------------------------------------------------------------------

/**
 * Ярус (S41): проектный `.myc/` против личного `~/.myc/` — «про репозиторий
 * или про меня». Физически это РАЗНЫЕ базы, поэтому ось описывает всю
 * открытую базу целиком, а не строку списка: сведение яруса с охватами
 * строки (S58, S59) было бы выбором, какой из трёх признаков потерять.
 */
export type WorkspaceTier = "project" | "personal";

export interface BootPayload {
  readonly slug: string;
  readonly db_path: string;
  /** Ярус открытой базы (S41) — свойство пути, а не узлов. */
  readonly tier: WorkspaceTier;
  readonly nodes: number;
  readonly edges: number;
  readonly node_limit: number;
  /**
   * Просмотрщик поднят без пути записи. Клиент читает это, чтобы не рисовать
   * форму правки там, где POST заведомо ответит 405 — но запрет живёт на
   * сервере, а не в том, спрятана ли кнопка.
   */
  readonly read_only: boolean;
  /** Операции перехода состояния, которые принимает POST /api/nodes/<id>/op. */
  readonly write_ops: readonly string[];
  /** Поля, которые принимает POST /api/nodes/<id>. Статуса среди них нет (S54). */
  readonly write_fields: readonly string[];
  /** База есть, но схема не накатана — интерфейс покажет «пусто», а не упадёт. */
  readonly schema_ready: boolean;
  readonly version: string;
}

// ---------------------------------------------------------------------------
// Панель роутинга: модель × класс задачи (W12, читает атрибуцию W11)
//
// Форма — прямое отражение CompareReport из @myc/swarm/compare.ts, того же,
// что печатает `myc report models`. Здесь НЕ пересчитывается «дешевле» и
// «равный результат» — answer/why уже посчитаны там, панель их показывает.
// isCheapest/isEqualGroup вынесены на сервер (было cls.cheapest === arm.arm
// в CLI), чтобы клиент оставался немой вёрсткой без своей логики сравнения.
// ---------------------------------------------------------------------------

export interface RoutingInterval {
  readonly lo: number;
  readonly hi: number;
}

/**
 * ok — есть однозначный (или разделённый) ответ;
 * single_arm — наблюдения есть только у одной руки, сравнивать не с чем;
 * insufficient_attempts — ни у одной руки нет нужного числа закрытых попыток;
 * no_cost_data — результат сравним, но стоимость не посчитана ни у одной руки.
 * Каждый код обязан быть виден на экране так же заметно, как сами числа —
 * средняя оценка по одной попытке, нарисованная как уверенный вывод, хуже
 * пустого экрана.
 */
export type RoutingAnswer = "ok" | "insufficient_attempts" | "no_cost_data" | "single_arm";

export interface RoutingArm {
  /** "<model_id>|<effort>". */
  readonly arm: string;
  readonly modelId: string;
  readonly effort: string;
  readonly harness: string;
  readonly attempts: number;
  readonly qualityMean: number;
  /** Интервал доверия 90% по качеству — рядом с оценкой, не в подсказке. */
  readonly quality: RoutingInterval;
  /** null — стоимость не посчитана НИ У ОДНОЙ попытки руки; 0 — посчитана и равна нулю. Эти два не рисуются одинаково. */
  readonly costUsdMean: number | null;
  readonly costedAttempts: number;
  readonly costCoverage: number;
  readonly cleanRate: number;
  /** attempts >= minAttempts — рука вообще участвовала в сравнении. */
  readonly enoughData: boolean;
  readonly isCheapest: boolean;
  readonly isEqualGroup: boolean;
}

export interface RoutingClass {
  readonly taskClass: string;
  readonly arms: readonly RoutingArm[];
  readonly qualityLeader: string | null;
  readonly cheapest: string | null;
  /** true — дешёвая рука в группе равных не потому, что она так же хороша, а потому, что наблюдений пока не хватает её отличить. */
  readonly separationPending: boolean;
  readonly answer: RoutingAnswer;
  readonly why: string;
}

export interface RoutingCoverage {
  readonly attempts: number;
  readonly finished: number;
  readonly withCost: number;
  readonly arms: number;
  readonly classes: number;
  readonly tasksClosed: number;
  readonly tasksAttributed: number;
}

export interface RoutingPayload {
  /** false — таблицы swarm_attempt ещё нет (ни одной попытки не заводилось). */
  readonly available: boolean;
  readonly classes: readonly RoutingClass[];
  readonly coverage: RoutingCoverage;
  readonly outcomeVersion: number;
  readonly minAttempts: number;
  readonly credibleMass: number;
  /** Оговорки видны здесь так же, как на экране «здоровье» (И2) — не только внутри карточки класса. */
  readonly degraded: readonly Degradation[];
  readonly took_ms: number;
}

export interface ApiError {
  readonly error: string;
  readonly msg: string;
}

// ---------------------------------------------------------------------------
// Бутстрап (W9): редактор обязательного контекста запуска агента
// ---------------------------------------------------------------------------

export type BootstrapSource = "auto" | "manual";
export type BootstrapTier = "project" | "personal";

/** Один блок в составе `text` — для подсветки, что именно порезал бюджет. */
export interface BootstrapBlockMeta {
  readonly key: string;
  readonly source: BootstrapSource;
  readonly tier: BootstrapTier;
  readonly chars: number;
}

/**
 * `text` — БУКВАЛЬНЫЙ вывод `myc bootstrap`: то же поле `data.text`
 * JSON-конверта команды, без пересборки на сервере просмотрщика. Приёмка
 * экрана держится на том, что здесь никогда не оказывается шаблон вместо
 * подстановки.
 */
export interface BootstrapPreview {
  readonly text: string;
  readonly chars: number;
  readonly body_chars: number;
  readonly budget: number;
  readonly truncated: boolean;
  readonly dropped: readonly string[];
  readonly clipped: readonly string[];
  readonly fp: string;
  readonly cache: "hit" | "miss" | "off";
  readonly auto: number;
  readonly manual: number;
  readonly tiers: readonly string[];
  readonly blocks: readonly BootstrapBlockMeta[];
  readonly took_ms: number;
}

export interface BootstrapBlockRow {
  readonly key: string;
  /** "-" у личного яруса (S41): `myc bootstrap list` не отдаёт id личных блоков. */
  readonly id: string;
  readonly tier: BootstrapTier;
  readonly chars: number;
  readonly updated_at: number;
}

export interface BootstrapBlocksPayload {
  readonly rows: readonly BootstrapBlockRow[];
}

export interface BootstrapHistoryRow {
  readonly seq: number;
  readonly ts_ms: number;
  readonly actor: string;
  readonly text: string | null;
}

export interface BootstrapHistoryPayload {
  readonly rows: readonly BootstrapHistoryRow[];
}

// ---------------------------------------------------------------------------
// Поиск (W6) — форма зеркалит RecallData/RetrieveRow из
// packages/cli/src/commands/recall.ts и retrieve.ts БУКВАЛЬНО: клиент
// показывает то, что вернул `myc recall --json`, а не пересчитывает своё.
// Поля, которых нет здесь, интерфейсу не нужны — remaining проходит через
// `Record<string, unknown>` в SearchPayload, чтобы расхождение схемы не
// уронило рендер, а не потому что оно неважно.
// ---------------------------------------------------------------------------

export interface SearchRow {
  readonly id: string;
  readonly rank: number;
  readonly score: number;
  /** z-оценка уверенности (S47); отсутствует — вектор не участвовал в хите. */
  readonly confidence?: number;
  readonly kind: string;
  readonly type: string;
  readonly layer: number;
  readonly updated_at: number;
  readonly title: string;
  readonly excerpt: string;
  readonly content_kind?: "full" | "crux";
  readonly reach: string;
  readonly reach_session: string;
  readonly repo: string;
  readonly repo_state: string;
  readonly tier: string;
  readonly source: string;
}

export interface SearchPayload extends Record<string, unknown> {
  readonly query: string;
  readonly rows: readonly SearchRow[];
  readonly shown: number;
  readonly total: number;
  readonly mode: string;
  readonly budget: number;
  readonly used_chars: number;
  readonly took_ms: number;
  /** true — выдано не всё: узлы сверх бюджета, таймаут сборки или есть продолжение (§2.7). */
  readonly partial: boolean;
  readonly omitted: number;
  /** Продолжение выдачи: следующий --offset; undefined — выдача исчерпана. */
  readonly cursor?: string;
  readonly pool_exhausted: boolean;
  readonly deduped: number;
  readonly foreign: number;
  readonly unknown_reach: number;
  readonly unknown_repo: number;
  readonly repo: string;
}

// ---------------------------------------------------------------------------
// Решения (W8): supersession-цепочки и открытые противоречия
// ---------------------------------------------------------------------------

/** Одно решение как оно есть — без места в цепочке. */
export interface DecisionRef {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** nodes.actor — тот же автор, что печатает `myc show`. */
  readonly author: string;
  readonly created_at: number;
}

/** Звено цепочки supersession: решение плюс его место в чужой истории. */
export interface DecisionLink extends DecisionRef {
  /** Актуальная версия цепочки — семантика `myc show`, не пересчитана заново. */
  readonly current: boolean;
  /** Причина замены из absorb (attrs.absorb.reason), если она есть у ЭТОГО звена. */
  readonly reason?: string;
}

export interface DecisionChain {
  /** id актуальной версии — DecisionLink с этим id несёт current: true. */
  readonly head: string;
  /** От старой версии к новой — порядок VersionGraph.chain(). */
  readonly links: readonly DecisionLink[];
  /** Развилка цепочки (слияние веток) — больше одной головы; молчать нельзя. */
  readonly forked?: readonly string[];
}

/** Открытое противоречие: обе стороны ребра `contradicts`, ни одна не закрыта. */
export interface DecisionContradiction {
  readonly a: DecisionRef;
  readonly b: DecisionRef;
  /** Причина из absorb.reason той стороны, что была классифицирована contradiction. */
  readonly reason?: string;
}

export interface DecisionsPayload {
  readonly chains: readonly DecisionChain[];
  readonly contradictions: readonly DecisionContradiction[];
  readonly total_decisions: number;
  readonly degraded: readonly Degradation[];
  readonly took_ms: number;
}
