/**
 * Общая инфраструктура команд задач: открытие воркспейса, разрешение ID,
 * форматтеры плотного вывода. Вывод этих команд читает языковая модель —
 * одна сущность одна строка, без рамок и украшений.
 *
 * Команды получают `openStore` через deps (как models.ts): тесты подменяют
 * открытие своей базой, не трогаю ФС и процесс.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
// Поиск воркспейса вынесен в ./wsfind.ts и РЕ-ЭКСПОРТИРУЕТСЯ отсюда: его
// импортируют полтора десятка мест, а платить за граф модулей этого файла
// ради одного `existsSync` обязан не всякий, кто ищет корень (см. шапку
// wsfind.ts — цена импорта store.ts в собранном бинаре ~9 мс).
import {
  findWorkspaceDb,
  findWorktreeLink,
  isRepoDir,
  mapIntoMain,
  mapIntoWorktree,
  personalHome,
  readWorktreeLink,
  workspaceDirOfDb,
  type WorkspaceNotFound,
  type WorktreeLink,
} from "./wsfind.ts";

export {
  findWorkspaceDb,
  findWorktreeLink,
  isRepoDir,
  mapIntoMain,
  mapIntoWorktree,
  personalHome,
  readWorktreeLink,
  workspaceDirOfDb,
};
export type { WorkspaceFound, WorkspaceNotFound, WorktreeLink } from "./wsfind.ts";
import { Database, type Statement } from "bun:sqlite";
import {
  generateId,
  prefixRange,
  deriveRepo,
  repoAttrs,
  REPO_ALL,
  GraphError,
  HlcClock,
  unpackHlc,
  REPO_KEY,
} from "@myc/core";
import type {
  DbDriver,
  JsonValue,
  NodeInput,
  NodeRecord,
  QueryDef,
  RepoDerivation,
  TxMode,
} from "@myc/core";
import {
  migrate,
  migrations,
  migrateVectors,
  vectorMigrations,
  VEC_MIGRATIONS_TABLE,
  GraphStore,
  Claims,
  type GraphStoreOptions,
  SchemaError,
  Q,
  STORE_PRAGMAS,
  PROJECTION_CACHE_DIR,
  createWalGuard,
  ensureSqliteRuntime,
  applySqliteRuntime,
  getSqliteRuntimeState,
  type WalGuard,
  type WalGuardOptions,
  ClosureError,
  databaseMeta,
  driverMeta,
  ensureSiteId,
  mintSiteId,
} from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import type { CommandContext, CommandFailure } from "../registry.ts";

// ---------------------------------------------------------------------------
// Лёгкое открытие БД для команд задач
// ---------------------------------------------------------------------------
//
// openSqlite из store-sqlite обязан грузить кастомный SQLite с vec0
// (ensureSqliteRuntime, ~4-7 мс на процесс) — это нужно векторному поиску,
// а командам задач вектора не нужны вовсе. Платить эту цену в каждом
// одноразовом вызове `myc show` (бюджет 3 мс) нельзя, поэтому здесь своё
// соединение поверх встроенного bun:sqlite — GraphStore разницы не видит.
//
// РАНТАЙМ РАСШИРЕНИЙ — ПАРАМЕТР ОТКРЫТИЯ, А НЕ ЧЕТВЁРТЫЙ ПУТЬ (решение S45,
// myc-ye3.8). До этой правки лёгкий драйвер не поднимал рантайм НИКОГДА, и
// вместе с решением S26 («векторные миграции применяются только при
// загруженном vec0») это давало следствие, которого не хотел никто: с
// основной поверхности vec0 не грузился ни разу, `nodes_vec` не создавалась
// ни разу, и векторная ветка `recall` была недостижима при любых настройках.
// Два локально верных решения дали неверное целое.
//
// Поэтому `extensions` — флаг ОДНОГО И ТОГО ЖЕ пути открытия: команды с
// бюджетом 25 мс (`recall`, `search` и будущий `digest` — всё, что реально
// умеет звать векторный поиск) просят его и платят 4-7 мс, то есть четверть
// своего бюджета; команды с бюджетом 3 мс (`show`, `ready`, `claim`,
// `close`) не просят и не платят ничего. Второй функции открытия при этом не
// появилось — реестр путей в store.parity.test.ts остаётся из трёх.
//
// PRAGMA и предохранитель WAL — ровно STORE_PRAGMAS/createWalGuard из
// store-sqlite, не свой список (решение S43, myc-ahy): пути открытия базы
// имеют право отличаться только загрузкой рантайма расширений, ничем
// больше. store.parity.test.ts падает, если это утверждение разойдётся
// с кодом снова, — и отдельным тестом проверяет, что включённый рантайм
// расширений не меняет в соединении ничего, кроме доступности vec0.

export interface CliDriver extends DbDriver {
  readonly database: Database;
  readonly wal: WalGuard;
  /** Загружен ли vec0 в ЭТОМ соединении (S45): факт, а не намерение. */
  readonly vec0: boolean;
  /**
   * Почему расширения ПРОСИЛИ, но не получили. `undefined` — не просили вовсе
   * или получили. Строка есть только когда сам подъём рантайма отказал: это
   * не «vec0 нет на машине» (о том честно говорит сам ретривал), а «поднять
   * не удалось здесь и сейчас», и такое обязано быть названо вслух (И2).
   */
  readonly vec0Reason: string | undefined;
  close(): void;
}

/**
 * Ленивость рантайма расширений как параметр открытия (решение S45).
 * Умолчание — `false`: платит только тот, кому вектор нужен.
 */
export interface OpenOptions {
  /**
   * Поднять рантайм расширений (кастомная libsqlite3 + vec0) для этого
   * соединения. ~4-7 мс на процесс, дальше бесплатно — `ensureSqliteRuntime`
   * идемпотентен и кеширует состояние.
   *
   * ОГРАНИЧЕНИЕ ДВИЖКА: `Database.setCustomSQLite` обязан выполниться до
   * первого `new Database` в процессе. Значит команда, которой нужен вектор,
   * просит расширения на ПЕРВОМ же открытии базы, а не на втором.
   */
  readonly extensions?: boolean;
}

/** @internal тест паритета (store.parity.test.ts) открывает через wal-опции свои пороги */
export function openDriver(
  path: string,
  walOptions?: WalGuardOptions,
  options?: OpenOptions,
): CliDriver {
  const wantExtensions = options?.extensions === true;
  // Строго до первого `new Database` — иначе setCustomSQLite опоздал.
  //
  // ОТКАЗ ПОДЪЁМА НЕ ИМЕЕТ ПРАВА УБИВАТЬ КОМАНДУ (И2). Не из мягкости: в
  // долгоживущем процессе, который уже открыл своё соединение (MCP-сервер
  // держит стор и прогоняет `recall` этим же процессом), setCustomSQLite
  // отказывает по определению — переставить SQLite после первого соединения
  // невозможно. Это не поломка воркспейса и не ошибка пользователя, а
  // порядок открытия в чужом процессе; `recall` там обязан отработать без
  // вектора и СКАЗАТЬ об этом, а не упасть. Причина сохраняется дословно и
  // доезжает до WARN-строки вызывающего — молчаливого отката не возникает.
  //
  // Полный рантайм-путь (openSqlite: движок, MCP/server на старте) по-прежнему
  // бросает: там расширения не «желательны», а часть контракта открытия.
  let vec0Reason: string | undefined;
  if (wantExtensions) {
    try {
      ensureSqliteRuntime();
    } catch (error) {
      vec0Reason = error instanceof Error ? error.message : String(error);
    }
  }
  const db = new Database(path, { create: true });
  try {
    // Расширения грузятся НА СОЕДИНЕНИЕ, поэтому после каждого открытия.
    if (wantExtensions && vec0Reason === undefined) applySqliteRuntime(db);
    for (const pragma of STORE_PRAGMAS) db.exec(pragma);
  } catch (error) {
    db.close();
    throw error;
  }
  const vec0 =
    wantExtensions && vec0Reason === undefined && getSqliteRuntimeState()?.vec.loaded === true;
  const wal = createWalGuard(db, walOptions);
  const cache = new Map<string, Statement>();
  const stmt = (query: QueryDef): Statement => {
    let s = cache.get(query.name);
    if (s === undefined) {
      s = db.prepare(query.sql);
      cache.set(query.name, s);
    }
    return s;
  };
  let txDepth = 0;
  const driver: CliDriver = {
    dialect: "sqlite",
    database: db,
    wal,
    vec0,
    vec0Reason,
    one<T>(query: QueryDef, params: readonly unknown[]): T | undefined {
      const row = stmt(query).get(...params);
      return (row === null ? undefined : row) as T | undefined;
    },
    all<T>(query: QueryDef, params: readonly unknown[]): T[] {
      return stmt(query).all(...params) as T[];
    },
    run(query: QueryDef, params: readonly unknown[]): { changes: number } {
      const result = stmt(query).run(...params);
      if (txDepth === 0) wal.afterCommit();
      return { changes: Number(result.changes) };
    },
    tx<T>(mode: TxMode, fn: (tx: DbDriver) => T): T {
      if (txDepth > 0) throw new Error("nested transactions are not supported");
      txDepth++;
      db.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const out = fn(driver);
        db.exec("COMMIT");
        wal.afterCommit();
        return out;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // соединение уже откатилось само
        }
        throw error;
      } finally {
        txDepth--;
      }
    },
    close(): void {
      cache.clear();
      db.close();
    },
  };
  return driver;
}

// ---------------------------------------------------------------------------
// workspace.toml — минимальный разбор (slug + [ready] веса, решение S21)
// ---------------------------------------------------------------------------

export interface ReadyWeights {
  priority: number;
  unblocks: number;
  freshness: number;
  anchors: number;
  type: number;
}

/** Ратифицированные веса сортировки ready (S21); переопределяются в workspace.toml. */
export const DEFAULT_READY_WEIGHTS: ReadyWeights = {
  priority: 0.4,
  unblocks: 0.27,
  freshness: 0.14,
  anchors: 0.1,
  type: 0.09,
};

export interface WorkspaceConfig {
  slug: string;
  weights: ReadyWeights;
  /**
   * Бюджет `myc bootstrap`, символов. Живёт в конфиге ПРОЕКТА, а не в
   * переменной окружения, потому что там же живут и сами блоки: `myc bootstrap
   * set` пишет проектные правила, и умолчание 2000 их не вмещает — замер на
   * пяти закреплённых блоках дал 2863 символа, и первым вытеснялся `[auto:graft]`,
   * самый нужный агенту. Настройка одного разработчика в его окружении не
   * помогает остальным: правила общие, значит и бюджет общий.
   */
  bootstrapBudget?: number;
}

/** Крошечный TOML-подset: секции [name], ключ = "строка" | число. Больше нам не нужно. */
export function parseWorkspaceToml(text: string): WorkspaceConfig {
  let slug = "myc";
  const weights = { ...DEFAULT_READY_WEIGHTS };
  let bootstrapBudget: number | undefined;
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sec = /^\[([a-z_]+)\]$/i.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    const kv = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const raw = kv[2]!.trim();
    if (section === "ready" && key in weights) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) {
        weights[key as keyof ReadyWeights] = n;
      }
    } else if (section === "bootstrap" && key === "budget") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) bootstrapBudget = Math.floor(n);
    } else if (section === "" && key === "slug") {
      const s = /^"([a-z][a-z0-9]{1,7})"$/.exec(raw);
      if (s) slug = s[1]!;
    }
  }
  return { slug, weights, ...(bootstrapBudget !== undefined ? { bootstrapBudget } : {}) };
}

// ---------------------------------------------------------------------------
// Открытие хранилища
// ---------------------------------------------------------------------------

export interface StoreHandle {
  readonly driver: CliDriver;
  readonly store: GraphStore;
  readonly claims: Claims;
  readonly actor: string;
  readonly scope: string;
  readonly slug: string;
  /** Корень воркспейса — каталог, содержащий `.myc` (R1). */
  readonly wsDir: string;
  /**
   * Непусто, когда команду позвали из git worktree: `wsDir` тогда — корень
   * ОСНОВНОГО дерева, а файлы, которые агент правит, лежат в worktree. Всё,
   * что и записывает путь, и читает содержимое (якоря), обязано различать эти
   * две стороны — отсюда и ссылка в хендле.
   */
  readonly worktree?: WorktreeLink;
  /**
   * Охват репозитория (S59), выведенный из каталога вызова: он же уходит в
   * `attrs.repo` каждого нового узла и он же — умолчание фильтра `ready`
   * и `recall`. `repo: undefined` — вывести не удалось, и это обязано быть
   * видно в выдаче, а не подменяться общим охватом (И2).
   */
  readonly repo: RepoDerivation;
  readonly weights: ReadyWeights;
  /** Загружен ли vec0 в соединении этого хендла (S45). */
  readonly vec0: boolean;
  /** Почему расширения просили, но не подняли (см. CliDriver.vec0Reason). */
  readonly vec0Reason: string | undefined;
  close(): void;
}

/**
 * Целевой репозиторий фильтра (S59). Пустая строка — фильтра нет, видно всё.
 *
 * Умолчание — охват, выведенный из каталога вызова: `myc ready` из
 * `cherry/collector` показывает задачи collector'а плюс задачи всей
 * экосистемы, из корня — всё. `--repo all` снимает фильтр явно, `--repo
 * <имя>` ставит чужой. Если охват вывести не удалось, фильтра НЕТ: сузить
 * выдачу по неизвестному значению значило бы молча спрятать работу — а И2
 * требует ровно обратного, сказать о неудаче вслух и ничего не прятать.
 *
 * Одна функция на ready и recall: разъехавшиеся умолчания двух поверхностей
 * читались бы как потеря данных в одной из них.
 */
export function repoTarget(h: StoreHandle, explicit?: string): string {
  const raw = (explicit ?? "").trim();
  if (raw === REPO_ALL) return "";
  if (raw.length > 0) return raw;
  return h.repo.repo ?? "";
}

export type OpenStoreResult =
  | { readonly ok: true; readonly handle: StoreHandle }
  | { readonly ok: false; readonly failure: CommandFailure };

/** Аренда claim по умолчанию — 30 минут (§3.5). */
export const DEFAULT_LEASE_MS = 1_800_000;

/**
 * Потолок аренды, выведенной из оценки задачи. Оценка бывает в неделях, а
 * аренда на неделю — это уже не аренда: задача, брошенная исполнителем,
 * пролежала бы недоступной до самого срока. Сутки — предел, после которого
 * координатор всё равно вмешается сам.
 */
export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

export function flagStr(
  ctx: CommandContext,
  name: string,
): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagNum(
  ctx: CommandContext,
  name: string,
): number | undefined {
  const v = ctx.flags[name];
  return typeof v === "number" ? v : undefined;
}

export function flagBool(ctx: CommandContext, name: string): boolean {
  return ctx.flags[name] === true;
}

/** Кто действует: --as команды, затем MYC_ACTOR, затем $USER. */
export function resolveActor(ctx: CommandContext): string {
  return (
    flagStr(ctx, "as") ??
    process.env.MYC_ACTOR ??
    process.env.USER ??
    "agent"
  );
}

interface OpenedWorkspace {
  readonly driver: CliDriver;
  readonly store: GraphStore;
  readonly claims: Claims;
  readonly actor: string;
  readonly siteId: string;
}

type OpenWorkspaceResult =
  | { readonly ok: true; readonly workspace: OpenedWorkspace }
  | { readonly ok: false; readonly failure: CommandFailure };

/** Версия векторного набора в базе; `null` — таблицы учёта ещё нет. */
function vecSchemaVersion(d: CliDriver): number | null {
  try {
    const row = d.database
      .query(`SELECT max(version) AS v FROM ${VEC_MIGRATIONS_TABLE}`)
      .get() as { v: number | null } | null;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

/**
 * Накат векторного набора с терпимостью к ОДНОВРЕМЕННОМУ первому открытию.
 *
 * Векторные миграции по своей природе идут БЕЗ транзакции (vec.ts: откат
 * CREATE VIRTUAL TABLE с shadow-таблицами vec0 движок не гарантирует), а
 * значит проверка «версия отстаёт» и сам накат не атомарны. Пока набор звали
 * только тесты и бенчи, это ничего не стоило. С S45 его зовёт `recall` — то
 * есть команда, которую агенты запускают параллельно десятками процессов, и
 * первое же открытие свежего воркспейса стало гонкой: замер до этой правки —
 * 15 отказов `table nodes_vec already exists` на 36 одновременных recall.
 *
 * Проигравший в гонке не пострадавший: набор у него применит победитель, и
 * достаточно дождаться и перечитать таблицу учёта. Ждём так же, как этажом
 * выше ждут чужой write-lock, — ограниченным числом коротких попыток, а не
 * бесконечно. SchemaError (расхождение версии/контрольной суммы) не гонка и
 * пробрасывается сразу.
 */
async function ensureVectorSchema(d: CliDriver, maxVecKnown: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (vecSchemaVersion(d) === maxVecKnown) return;
    try {
      await migrateVectors(d.database, { vec0Loaded: true, writable: true });
      return;
    } catch (e) {
      if (e instanceof SchemaError) throw e;
      if (attempt === 49) throw e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

// ---------------------------------------------------------------------------
// Присвоение охвата репозитория (S59, packages/core/src/repo.ts)
// ---------------------------------------------------------------------------
//
// Охват берётся ИЗ ПУТИ ВЫЗОВА, а не из слага воркспейса. Слаг один на всю
// базу — присвоить его значило бы выдать всем узлам одно и то же значение и
// потерять само различение, ради которого ось заведена.
//
// Присвоение стоит на ГРАНИЦЕ ВОРКСПЕЙСА, а не в командах. Узлы создают
// create/task/bug/epic, remember, absorb, import-beads, wire — семь разных
// мест, и каждое, забыв про охват, молча вернуло бы базу в состояние «все
// узлы без охвата». Хендл же знает и корень воркспейса, и каталог вызова, то
// есть ровно то, из чего охват выводится; ниже по стеку этого знания нет ни
// у кого. Явный `attrs.repo` во входе всегда сильнее: импорт чужого графа
// несёт свой охват и переписывать его нельзя.
class RepoScopedStore extends GraphStore {
  private readonly repoFields: Readonly<Record<string, JsonValue>>;

  constructor(driver: DbDriver, opts: GraphStoreOptions, repo: string) {
    super(driver, opts);
    this.repoFields = repoAttrs(repo);
  }

  override createNode(input: NodeInput): NodeRecord {
    if (input.attrs !== undefined && REPO_KEY in input.attrs) return super.createNode(input);
    return super.createNode({ ...input, attrs: { ...(input.attrs ?? {}), ...this.repoFields } });
  }
}

/**
 * Открытие+миграция+HLC-join одной базы, общее для проектного и личного
 * яруса (S41: второй ярус — та же механика хранения, не второй движок).
 * Вынесено из openStore, чтобы фикс S38/S40 (часы обязан поднимать движок,
 * а не вызывающий) не пришлось повторять для каждого нового яруса отдельно.
 */
async function openWorkspaceAt(
  dbPath: string,
  opts: {
    readonly slug: string;
    readonly actor: string;
    readonly extensions?: boolean;
    /**
     * Охват репозитория (S59), выведенный из пути вызова. `undefined` —
     * вывести не удалось: тогда ключ `attrs.repo` НЕ пишется вовсе, и узел
     * честно читается как «охват не определён» (И2).
     */
    readonly repo?: string;
  },
): Promise<OpenWorkspaceResult> {
  // Открытие/миграция при конкурентном CLI может упереться в чужой
  // write-lock (PRAGMA journal_mode идёт до busy_timeout): ждём до ~5 с.
  const maxKnown = migrations.reduce((m, mig) => Math.max(m, mig.version), 0);
  const maxVecKnown = vectorMigrations.reduce((m, mig) => Math.max(m, mig.version), 0);
  let driver: CliDriver | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const d = openDriver(dbPath, undefined, { extensions: opts.extensions === true });
      try {
        // migrate на актуальной схеме — холостая ~1 мс на каждый вызов;
        // сверяем версию дёшево и мигрируем только при отставании.
        let appliedVersion: number | null = null;
        try {
          const row = d.database
            .query("SELECT max(version) AS v FROM schema_migrations")
            .get() as { v: number | null } | null;
          appliedVersion = row?.v ?? null;
        } catch {
          appliedVersion = null; // таблицы ещё нет — полная миграция ниже
        }
        if (appliedVersion !== maxKnown) {
          await migrate(d.database, { migrations, writable: true });
        }
        // Векторный набор (S26) — своя таблица учёта и своё условие: только
        // при реально загруженном vec0. Догоняет ЛЮБУЮ существующую базу,
        // созданную без расширения: её базовая схема к векторам не
        // прикасалась, поэтому накат — чистое добавление объектов, без
        // пересоздания и без миграции данных (S45).
        if (d.vec0) await ensureVectorSchema(d, maxVecKnown);
      } catch (e) {
        d.close();
        if (e instanceof SchemaError) {
          return {
            ok: false,
            failure: {
              ok: false,
              code: "precond.schema",
              msg: e.message,
              exit: ExitCode.PRECOND,
              hint: "myc doctor --schema",
            },
          };
        }
        throw e;
      }
      driver = d;
      break;
    } catch (e) {
      lastError = e;
      if (!/locked|busy/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (driver === undefined) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "conflict.busy",
        msg: `база занята другим процессом: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        exit: ExitCode.CONFLICT,
      },
    };
  }

  // site_id живёт в myc_meta (его пишет `myc init`), но принадлежит не
  // воркспейсу, а ФИЗИЧЕСКОМУ экземпляру базы (решение S65): каталог,
  // размноженный `cp -R`, обязан разъехаться по site_id при первом же
  // открытии, иначе обе копии продолжают нумерацию с одного места и два
  // разных набора операций приезжают под одинаковыми op_id. Здесь же
  // покрывается и прежний случай «база создана мимо init»: тогда решение —
  // «minted». Проверка стоит одного statSync (0.59 мкс) и пишет в myc_meta
  // только при изменении.
  const { siteId } = ensureSiteId({
    meta: driverMeta(driver),
    dbPath,
    mint: () => mintSiteId(opts.slug),
  });
  // HLC-join нового одноразового соединения: часы стартуют от последней
  // записи оплога (PK-lookup, бесплатно). Иначе create в одном соединении
  // и update/close в следующем в пределах той же миллисекунды дают равные
  // часы, и LWW в projectSet молча отбрасывает более позднюю запись.
  let clock: HlcClock | undefined;
  const lastOp = driver.one<{ hlc: string }>(QL.oplog_last_hlc, []);
  if (lastOp !== undefined) {
    const { ts, ctr } = unpackHlc(BigInt(lastOp.hlc));
    clock = new HlcClock({ initial: { ts, ctr } });
  }
  const storeOpts: GraphStoreOptions = {
    newId: () => generateId(opts.slug),
    actor: opts.actor,
    siteId,
    ...(clock !== undefined ? { clock } : {}),
  };
  const store =
    opts.repo === undefined
      ? new GraphStore(driver, storeOpts)
      : new RepoScopedStore(driver, storeOpts, opts.repo);
  return {
    ok: true,
    workspace: { driver, store, claims: new Claims(store, { holder: opts.actor }), actor: opts.actor, siteId },
  };
}

// ---------------------------------------------------------------------------
// Подъём вверх при поиске воркспейса (R1, memory-6k8a692mk20w)
// ---------------------------------------------------------------------------
//
// Экосистема из многих репозиториев (решение S59): корень — git-репозиторий,
// внутри — самостоятельные репозитории со своим `.git`. Раньше `.myc` искался
// строго в cwd — `cd` в любой вложенный репозиторий без своего воркспейса
// давал `ws.not_initialized`, хотя воркспейс в корне существовал. Теперь
// поднимаемся по дереву и останавливаемся на ПЕРВОМ найденном `.myc`:
// репозиторий со своим воркспейсом обслуживает себя, остальные попадают в
// корневой.
//
// Граница подъёма — НЕ первый встреченный `.git`: сами вложенные репозитории
// (repoA, repoB, …) — это тоже `.git`-каталоги, и именно из них нужно
// подниматься ВЫШЕ, к корню экосистемы. Граница вместо этого — домашний
// каталог пользователя (`personalHome()`, то есть `MYC_HOME` в тестах):
// подниматься ДО него можно (это и есть путь к корню экосистемы вроде
// `~/src/cherry`), а вот заглядывать НИЖЕ ЭТОЙ ГРАНИЦЫ ВНУТРЬ самого
// домашнего каталога — риск подхватить его собственный `.myc/myc.db`, то
// есть ЛИЧНЫЙ ярус (`~/.myc`, S41) вместо ошибки «воркспейс не
// инициализирован». Личный и проектный ярусы хранятся под одним и тем же
// относительным путём `.myc/myc.db`, поэтому без этого исключения поиск
// молча подменил бы один воркспейс другим. Домашний каталог САМ проверяется,
// только если это стартовый каталог (`cd ~ && myc show` — тот же случай, что
// и раньше, до этой правки); при подъёме СНИЗУ он из проверки исключается.
/**
 * Репозиторий экосистемы (S59) — каталог со СВОИМ `.git`. Файл `.git`
 * (submodule, worktree) считается наравне с каталогом: это тот же
 * самостоятельный репозиторий, просто с вынесенным служебным каталогом.
 */

/**
 * Корень воркспейса по пути к базе — для явного `--db`, который поиск
 * каталога обходит. `<dir>/.myc/myc.db` даёт `<dir>`; любой другой путь
 * (тесты и бенчи открывают базу файлом где угодно) корня НЕ даёт, и охват
 * репозитория честно остаётся неопределённым вместо выдуманного общего.
 */


/**
 * Открытие ВТОРОГО воркспейса по каталогу — приёмник переезда (R4).
 *
 * Отдельная функция, а не второй вызов `openStore`: тот берёт каталог из
 * контекста команды и выводит из него охват репозитория (S59). Приёмнику
 * охват выводить нельзя — узел везёт СВОЙ `attrs.repo` в истории, и
 * переписать его каталогом приёмника значило бы смешать две независимые оси
 * (ярус / охват сессии / охват репозитория, см. memory-jj9nftkkq5qh).
 * Поэтому `repo` здесь не передаётся вовсе: приёмник только применяет
 * операции и не создаёт узлов.
 */
/**
 * Отказ «воркспейса нет» — с ПРИЧИНОЙ, когда старт был внутри git worktree.
 *
 * Молчаливое «искали восемь путей вверх, попробуйте `myc init`» здесь хуже
 * самой ошибки: человек послушается подсказки, заведёт в worktree ВТОРОЙ
 * воркспейс и расколет граф надвое — тот же класс, что memory-6gr1mc91ske3,
 * где клон советовал `init` вместо `import`. Поэтому обе причины называются
 * словами, а подсказка ведёт в ОСНОВНОЕ дерево, а не в текущий каталог.
 */
function noWorkspaceFailure(found: WorkspaceNotFound): CommandFailure {
  const link = found.worktree;
  if (link !== undefined && found.worktreeMiss === "main-missing") {
    return {
      ok: false,
      code: "ws.worktree_main_missing",
      msg:
        `git worktree ${link.worktreeDir}: воркспейс принадлежит репозиторию и живёт в ` +
        `ОСНОВНОМ дереве, но его каталога ${link.mainRoot} нет — перенесли или удалили ` +
        `(файл .git ведёт в ${link.gitDir})`,
      exit: ExitCode.NOWS,
      hint: "git worktree repair <путь к основному дереву>",
    };
  }
  if (link !== undefined) {
    return {
      ok: false,
      code: "ws.not_initialized",
      msg:
        `воркспейс не инициализирован: искали ${found.searched.join(", ")}; ` +
        `${link.worktreeDir} — git worktree, и воркспейс ищется в основном дереве ` +
        `${link.mainRoot}, а не по каталогам вверх`,
      exit: ExitCode.NOWS,
      hint: `myc -C ${link.mainRoot} init`,
    };
  }
  return {
    ok: false,
    code: "ws.not_initialized",
    msg: `воркспейс не инициализирован: искали ${found.searched.join(", ")}`,
    exit: ExitCode.NOWS,
    hint: "myc init",
  };
}

export async function openWorkspaceByDir(
  dir: string,
  actor: string,
): Promise<
  | { readonly ok: true; readonly handle: StoreHandle }
  | { readonly ok: false; readonly failure: CommandFailure }
> {
  const found = findWorkspaceDb(resolve(dir));
  if (!("dbPath" in found)) return { ok: false, failure: noWorkspaceFailure(found) };
  let config: WorkspaceConfig = { slug: "myc", weights: { ...DEFAULT_READY_WEIGHTS } };
  const tomlPath = join(found.wsDir, ".myc", "workspace.toml");
  if (existsSync(tomlPath)) {
    try {
      config = parseWorkspaceToml(readFileSync(tomlPath, "utf8"));
    } catch {
      // битый конфиг не должен ронять открытие — дефолты выше
    }
  }
  const opened = await openWorkspaceAt(found.dbPath, { slug: config.slug, actor });
  if (!opened.ok) return opened;
  const { driver, store, claims } = opened.workspace;
  return {
    ok: true,
    handle: {
      driver,
      store,
      claims,
      actor,
      scope: config.slug === "myc" ? "" : config.slug,
      slug: config.slug,
      wsDir: found.wsDir,
      repo: { repo: undefined, reason: "no-workspace", from: found.wsDir },
      weights: config.weights,
      vec0: driver.vec0,
      vec0Reason: driver.vec0Reason,
      close: () => driver.close(),
    },
  };
}

/** Один и тот же каталог, даже если пути пришли через разные симлинки. */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Охват репозитория (S59), устойчивый к git worktree.
 *
 * Охват выводится из пути ОТНОСИТЕЛЬНО корня воркспейса, а worktree — каталог
 * рядом с основным деревом, а не внутри него. Без пересчёта у обеих форм
 * ломается ровно одно и то же: узлы, заведённые из worktree, получают ЧУЖОЙ
 * охват и перестают быть видимы из основного дерева — раскол графа, только с
 * другой стороны, чем в самом поиске воркспейса.
 *
 * Форма первая — worktree ВНЕ воркспейса (`git worktree add ../wt-feature`).
 * Воркспейс нашёлся через ссылку; путь «откуда позвали» лежит вне его корня и
 * дал бы `outside-workspace`. Переносим путь в основное дерево целиком.
 *
 * Форма вторая — worktree ВНУТРИ воркспейса-экосистемы: `~/src/cherry/.myc`,
 * репозиторий `collector`, рядом с ним его worktree `wt-collector`. Подъём по
 * каталогам нашёл воркспейс сразу, ссылка не понадобилась, и охват вывелся бы
 * из ИМЕНИ КАТАЛОГА — `wt-collector` вместо `collector`. Но это тот же самый
 * репозиторий, и называться охват обязан именем основного дерева.
 *
 * Цена: одна лишняя `statSync` и только когда охват вообще получился
 * непустым, то есть в экосистеме из нескольких репозиториев. В одиночном
 * репозитории (охват «все») и при `--db` не делается ни одной.
 */
function deriveRepoAcrossWorktrees(
  repoRoot: string | undefined,
  startDir: string,
  worktree: WorktreeLink | undefined,
): RepoDerivation {
  const from = worktree !== undefined ? mapIntoMain(worktree, startDir) : startDir;
  const derived = deriveRepo(repoRoot, from, isRepoDir);
  if (repoRoot === undefined || derived.repo === undefined || derived.repo.length === 0) {
    return derived;
  }
  const link = readWorktreeLink(join(repoRoot, derived.repo));
  if (link === undefined) return derived;
  // Сравниваются пути из РАЗНЫХ источников: корень воркспейса пришёл из
  // подъёма по cwd, основное дерево — из файла, который написал git. На macOS
  // это /tmp против /private/tmp у одного и того же каталога, поэтому
  // сравнение идёт по realpath, а не по строкам.
  if (samePath(dirname(link.mainRoot), repoRoot)) return { ...derived, repo: basename(link.mainRoot) };
  return derived;
}

/**
 * Открытие проектного яруса. `options.extensions` поднимает рантайм vec0 —
 * его просят команды, которые умеют звать векторный поиск (S45); остальные
 * не просят и не платят.
 */
export async function openStore(
  ctx: CommandContext,
  options?: OpenOptions,
): Promise<OpenStoreResult> {
  const startDir = resolve(ctx.globals.directory ?? process.cwd());

  let dbPath: string;
  let wsDir: string;
  // Непусто, если сюда пришли из git worktree: воркспейс взят из основного
  // дерева, и путь «откуда позвали» надо пересчитать туда же (S59 ниже).
  let worktree: WorktreeLink | undefined;
  if (ctx.globals.db !== undefined) {
    // Явный `--db` сильнее поиска: ни подъёма, ни альтернативных путей —
    // ровно тот файл, что назвали, с прежним однопутевым сообщением об
    // ошибке.
    dbPath = ctx.globals.db;
    wsDir = startDir;
    if (!existsSync(dbPath)) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "ws.not_initialized",
          msg: `воркспейс не инициализирован: нет ${dbPath}`,
          exit: ExitCode.NOWS,
          hint: "myc init",
        },
      };
    }
  } else {
    const found = findWorkspaceDb(startDir);
    if (!("dbPath" in found)) return { ok: false, failure: noWorkspaceFailure(found) };
    dbPath = found.dbPath;
    wsDir = found.wsDir;
    worktree = found.worktree;
  }

  let config: WorkspaceConfig = { slug: "myc", weights: { ...DEFAULT_READY_WEIGHTS } };
  const tomlPath = join(wsDir, ".myc", "workspace.toml");
  if (existsSync(tomlPath)) {
    try {
      config = parseWorkspaceToml(readFileSync(tomlPath, "utf8"));
    } catch {
      // битый конфиг не должен ронять чтение графа — дефолты выше
    }
  }

  const actor = resolveActor(ctx);
  // Охват репозитория (S59) выводится ОДИН раз, здесь: и запись новых узлов,
  // и умолчание фильтров читают его из хендла, поэтому «откуда позвали» и
  // «что показываем» не могут разъехаться.
  // При явном `--db` поиска каталога не было, и корнем считается каталог над
  // `.myc` самой базы; если база лежит не по этому пути, корня нет вовсе.
  const repoRoot = ctx.globals.db !== undefined ? workspaceDirOfDb(dbPath) : wsDir;
  const repo = deriveRepoAcrossWorktrees(repoRoot, startDir, worktree);
  const opened = await openWorkspaceAt(dbPath, {
    slug: config.slug,
    actor,
    extensions: options?.extensions === true,
    ...(repo.repo !== undefined ? { repo: repo.repo } : {}),
  });
  if (!opened.ok) return opened;
  const { driver, store, claims } = opened.workspace;
  return {
    ok: true,
    handle: {
      driver,
      store,
      claims,
      actor,
      scope: config.slug === "myc" ? "" : config.slug,
      slug: config.slug,
      wsDir: repoRoot ?? wsDir,
      ...(worktree !== undefined ? { worktree } : {}),
      repo,
      weights: config.weights,
      vec0: driver.vec0,
      vec0Reason: driver.vec0Reason,
      close: () => driver.close(),
    },
  };
}

// ---------------------------------------------------------------------------
// Личный ярус ~/.myc (решение S41 — ARCHITECTURE.md §10)
// ---------------------------------------------------------------------------
//
// Проектный .myc/ живёт в репозитории и хранит задачи/якоря — вне репозитория
// они бессмысленны. Личный ~/.myc/ хранит память о пользователе и его
// практиках и не привязан к репозиторию: одна база на человека, а не на
// репозиторий. Слог у него фиксирован ("me"), в отличие от проектного —
// его id не нужно ни выбирать, ни хранить в workspace.toml, личный ярус один.
//
// БЮДЖЕТ (И1): ready/claim/show вызывают только openStore выше и никогда —
// openPersonalStore. Это не рантайм-проверка, а факт по коду: второе
// соединение просто негде открыть внутри этих команд. openPersonalStore же
// сам по себе ленив дважды: (а) существование базы проверяется statSync
// через existsSync — доли микросекунды, не миллисекунда открытия SQLite;
// (б) если базы нет, `new Database` не вызывается вовсе — отсутствующий
// ~/.myc не ломает ничего, работает только проектный ярус.

export const PERSONAL_SLUG = "me";

export interface PersonalWorkspaceStatus {
  readonly dir: string;
  readonly dbPath: string;
  readonly exists: boolean;
}

/** Дешёвая проверка (stat), без открытия соединения — см. заметку о бюджете выше. */
export function personalWorkspaceStatus(home: string = personalHome()): PersonalWorkspaceStatus {
  const dir = join(home, ".myc");
  const dbPath = join(dir, "myc.db");
  return { dir, dbPath, exists: existsSync(dbPath) };
}

export type OpenPersonalResult =
  | { readonly ok: true; readonly handle: StoreHandle | undefined }
  | { readonly ok: false; readonly failure: CommandFailure };

/**
 * Счётчик обращений к личному ярусу — только для приёмки И1 (myc-ye3.6):
 * доказать счётчиком, а не рассуждением, что ready/claim/show никогда не
 * открывают второе соединение. Инкремент — единственный побочный эффект
 * помимо самого открытия; в проде не читается никем, тесты обнуляют перед
 * прогоном.
 */
export const personalOpenAttempts = { count: 0 };

/**
 * Личный ярус — лениво. `handle: undefined` (без ошибки) — валидный ответ,
 * когда ~/.myc ещё не создан: вызывающий (recall/prime) продолжает работать
 * только с проектным ярусом. Звать эту функцию должны ТОЛЬКО команды, для
 * которых запрос действительно про память — см. заметку о бюджете выше.
 */
export async function openPersonalStore(
  ctx: CommandContext,
  home: string = personalHome(),
  options?: OpenOptions,
): Promise<OpenPersonalResult> {
  personalOpenAttempts.count++;
  const status = personalWorkspaceStatus(home);
  if (!status.exists) return { ok: true, handle: undefined };

  const actor = resolveActor(ctx);
  // Личный ярус (S41) хранит память о человеке и его практиках и по своему
  // определению не привязан к репозиторию: охват у него ОБЩИЙ, и это
  // определённый ответ, а не неудача вывода. Выводить его из cwd было бы
  // прямой ошибкой — под ~/ лежит и `src/`, и всё остальное.
  const repo: RepoDerivation = { repo: "", reason: "", from: status.dir };
  const opened = await openWorkspaceAt(status.dbPath, {
    slug: PERSONAL_SLUG,
    actor,
    extensions: options?.extensions === true,
    repo: "",
  });
  if (!opened.ok) return opened;
  const { driver, store, claims } = opened.workspace;
  return {
    ok: true,
    handle: {
      driver,
      store,
      claims,
      actor,
      scope: PERSONAL_SLUG,
      slug: PERSONAL_SLUG,
      wsDir: home,
      repo,
      weights: { ...DEFAULT_READY_WEIGHTS },
      vec0: driver.vec0,
      vec0Reason: driver.vec0Reason,
      close: () => driver.close(),
    },
  };
}

export interface CreatedPersonalWorkspace {
  readonly dir: string;
  readonly dbPath: string;
  readonly schemaVersion: number;
  readonly siteId: string;
}

/**
 * Явное создание личного яруса — только по `myc init --global` (S41: запись
 * в личный ярус идёт явным действием, а не молча). Не переиспользует полный
 * openStore/openWorkspaceAt: тому нужен уже существующий файл, а здесь файла
 * заведомо нет — своя лёгкая PRAGMA+migrate последовательность, как у
 * проектного `myc init` (init.ts), но независимая от него: два разных
 * жизненных цикла (репозиторий создаётся один раз за клон, личный ярус —
 * один раз за машину), совместное абстрагирование дало бы больше кода, чем
 * экономит.
 */
export async function createPersonalWorkspace(
  home: string = personalHome(),
): Promise<CreatedPersonalWorkspace> {
  const status = personalWorkspaceStatus(home);
  mkdirSync(status.dir, { recursive: true });
  const db = new Database(status.dbPath, { create: true });
  let schemaVersion: number;
  let siteId: string;
  try {
    for (const pragma of ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL", "PRAGMA foreign_keys = ON"]) {
      db.exec(pragma);
    }
    await migrate(db, { migrations, writable: true });
    schemaVersion = migrations.reduce((m, mig) => Math.max(m, mig.version), 0);
    // База могла пережить `--force`: он стирает кеши, а память — только по
    // явному `--wipe-memory`. Тогда это не создание, а открытие, и выдавать
    // новый site_id нельзя: под старым уже подписаны операции в оплоге, и
    // смена личности сайта разорвала бы его же историю. Ровно это и решает
    // ensureSiteId (S65) — плюс тот случай, который «взять старый» разбирал
    // неверно: ~/.myc, приехавший с другой машины или из копии, обязан
    // получить свой site_id, а не подписываться чужим.
    const decided = ensureSiteId({
      meta: databaseMeta(db),
      dbPath: status.dbPath,
      mint: () => mintSiteId(PERSONAL_SLUG),
    });
    siteId = decided.siteId;
    if (decided.origin === "minted") db.prepare(Q.meta_set.sql).run("slug", PERSONAL_SLUG);
  } finally {
    db.close();
  }
  return { dir: status.dir, dbPath: status.dbPath, schemaVersion, siteId };
}

// ---------------------------------------------------------------------------
// Что `--force` имеет право стереть в личном ярусе (memory-2shvpjay4nx6)
// ---------------------------------------------------------------------------
//
// Проектный `--force` (init.ts, FORCE_KEEP) отличает восстановимое от
// неустранимого по git: `.myc/graph` и `workspace.toml` коммитятся, и стереть
// их локально значит обнулить знание у всех участников. У личного яруса
// такого признака нет вовсе: он не коммитится никуда, и «восстановимо» здесь
// значит ровно одно — «пересчитывается из оплога, который остаётся на месте».
//
// Отсюда умолчание для НЕИЗВЕСТНОГО файла обратное проектному. Там `--force`
// стирает всё, кроме перечисленного: чего не знает myc, то либо лежит в git,
// либо создастся заново. Здесь стирается ТОЛЬКО перечисленное: у файла под
// ~/.myc источника, из которого он вернётся, нет ни одного, и «я его не
// знаю» — не основание его убить. Так же переживает `--force` и установленный
// бинарь `~/.myc/bin/myc` (wire.ts ищет его там), который старая реализация
// сносила заодно с базой.

/** Кеши личного яруса: пересчитываются из оплога той же базы. */
const PERSONAL_RECOVERABLE: ReadonlySet<string> = new Set([
  PROJECTION_CACHE_DIR,
  "state.json",
  "bootstrap.cache.json",
]);

/**
 * Сама память: база с оплогом, её sqlite-спутники (в `-wal` лежат
 * зафиксированные, но ещё не слитые транзакции — стереть его отдельно от
 * базы значит потерять последние записи) и выгрузка оплога, если она есть.
 */
const PERSONAL_MEMORY: ReadonlySet<string> = new Set([
  "myc.db",
  "myc.db-wal",
  "myc.db-shm",
  "myc.db-journal",
  "graph",
]);

export interface PersonalWipePlan {
  readonly dir: string;
  readonly exists: boolean;
  /** Записи, которые `--force` имеет право стереть сам. */
  readonly recoverable: readonly string[];
  /** Записи с самой памятью: их стирает только явное разрешение. */
  readonly memory: readonly string[];
  /** Чужое: myc этого не создавал и не удаляет (например, `bin/`). */
  readonly kept: readonly string[];
  /** Операций в оплоге и узлов; `undefined` — базу прочитать не удалось. */
  readonly ops: number | undefined;
  readonly nodes: number | undefined;
  /**
   * Есть ли что терять. Нечитаемая база — тоже «есть»: чего мы не смогли
   * прочитать, того мы и не знаем, а стирать по незнанию нельзя.
   */
  readonly hasMemory: boolean;
}

interface PersonalMemoryCounts {
  ops: number | undefined;
  nodes: number | undefined;
  readable: boolean;
}

/** Ничего не прочли: решение по такой базе принимать нельзя (fail-closed). */
function unreadableMemory(): PersonalMemoryCounts {
  return { ops: undefined, nodes: undefined, readable: false };
}

/**
 * Спутники sqlite рядом с базой. Пока на диске лежит хоть один, содержимое
 * базы файлом `myc.db` не исчерпывается: в `-wal` ждут чекпойнта
 * зафиксированные транзакции, в `-journal` — откат незавершённой. Прочитать
 * такую базу в обход журнала значит увидеть её прошлое и решить судьбу
 * памяти по нему.
 */
function sqliteSidecars(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].filter((p) => existsSync(p));
}

/** Путь внутри file:-URI: `?` начинает параметры, `#` — фрагмент, `%` — экранирование. */
function fileUri(path: string): string {
  return `file:${path.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23")}`;
}

function readMemoryCounts(db: Database): { ops: number | undefined; nodes: number | undefined } {
  const ops = (db.query("SELECT count(*) AS n FROM oplog").get() as { n: number } | null)?.n;
  const nodes = (db.query("SELECT count(*) AS n FROM nodes").get() as { n: number } | null)?.n;
  return { ops, nodes };
}

/**
 * Сколько памяти в личной базе — не открывая её на запись НИ В ОДНОЙ ветке.
 *
 * `readonly: true` — обычный путь, но он покрывает не все состояния. База в
 * WAL, из которой писатель вышел начисто, остаётся БЕЗ `-wal`/`-shm`, и
 * readonly-соединению негде построить индекс WAL: первый же prepare падает с
 * SQLITE_CANTOPEN («unable to open database file»). Именно это здесь и
 * произошло — `!readable` подставлялся в `hasMemory`, и `--force` отказывал
 * ВСЕГДА, даже на пустом ярусе. Работал только `--wipe-memory`: безопасный
 * путь умер, остался разрушительный (memory-2shvpjay4nx6).
 *
 * Просмотрщик (packages/web/src/db.ts, openReadOnly) лечит это пересозданием
 * соединения читаемым handle-ом под `PRAGMA query_only`. Здесь так нельзя:
 * закрытие такого соединения делает чекпойнт. Замер на подставном ~/.myc:
 * myc.db 4096 → 274432 байт, myc.db-wal 477952 → 0. То есть функция,
 * решающая, СТИРАТЬ ЛИ память, сама переписала бы её файлы, а отказ перестал
 * бы быть отказом «без единой записи на диск».
 *
 * Поэтому для базы БЕЗ журнала берётся `immutable=1`: SQLite читает сам файл
 * и не создаёт ни `-shm`, ни `-wal` (в том же замере слепок каталога до и
 * после совпадает). Взамен immutable ИГНОРИРУЕТ журнал — поэтому ветка и
 * включается только там, где журнала нет вовсе, и проверяется это дважды: до
 * чтения и после (писатель мог стартовать в промежутке).
 *
 * ПОРЯДОК ВЕТВЕЙ РЕШАЕТ, и это выяснилось на CI (ubuntu-latest), а не здесь.
 * Раньше `readonly` шёл первым, а `immutable` был запасным — и то, что запись
 * на диск не появлялась, держалось на СЛУЧАЙНОСТИ: на macOS с кастомной
 * libsqlite3 первая ветка на базе без спутников падает, и до второй доходило
 * всегда. На Linux она НЕ падает: readonly-соединение открывает WAL-базу и
 * создаёт `-shm` и `-wal`. Функция, решающая, стирать ли память, оставляла
 * на диске два новых файла — ровно то, чего обещала не делать, и тест
 * «не пишет ни байта» краснел там, а не здесь.
 *
 * Поэтому ветка выбирается ПО СОСТОЯНИЮ, а не по тому, упало ли первое
 * открытие: нет спутников — immutable (создать нечего); есть — обычный
 * readonly (журнал учитывается, а файлы и так на диске). Во всех прочих
 * случаях остаётся прежнее fail-closed: чего не прочли, того не стираем.
 */
function countPersonalMemory(dbPath: string): PersonalMemoryCounts {
  if (sqliteSidecars(dbPath).length === 0) {
    try {
      const db = new Database(`${fileUri(dbPath)}?immutable=1`, { readonly: true });
      try {
        const counts = readMemoryCounts(db);
        // Журнал мог появиться, пока мы читали: тогда прочитанное — прошлое.
        if (sqliteSidecars(dbPath).length > 0) return unreadableMemory();
        return { ...counts, readable: true };
      } finally {
        db.close();
      }
    } catch {
      return unreadableMemory();
    }
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return { ...readMemoryCounts(db), readable: true };
    } finally {
      db.close();
    }
  } catch {
    return unreadableMemory();
  }
}

/**
 * Разложить содержимое ~/.myc на восстановимое, неустранимое и чужое. Только
 * чтение: ни одного файла эта функция не создаёт и не трогает — решение
 * «стирать ли вообще» принимается до первой записи на диск.
 */
export function personalWipePlan(home: string = personalHome()): PersonalWipePlan {
  const status = personalWorkspaceStatus(home);
  const dir = status.dir;
  if (!existsSync(dir)) {
    return {
      dir,
      exists: false,
      recoverable: [],
      memory: [],
      kept: [],
      ops: undefined,
      nodes: undefined,
      hasMemory: false,
    };
  }

  const recoverable: string[] = [];
  const memory: string[] = [];
  const kept: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (PERSONAL_MEMORY.has(entry)) memory.push(entry);
    else if (PERSONAL_RECOVERABLE.has(entry)) recoverable.push(entry);
    else kept.push(entry);
  }

  const counted = existsSync(status.dbPath)
    ? countPersonalMemory(status.dbPath)
    : { ops: 0, nodes: 0, readable: true };

  let graphNotEmpty = false;
  if (memory.includes("graph")) {
    try {
      graphNotEmpty = readdirSync(join(dir, "graph")).length > 0;
    } catch {
      graphNotEmpty = true; // не смогли посмотреть — считаем, что там оплог
    }
  }

  const hasMemory =
    graphNotEmpty || !counted.readable || (counted.ops ?? 0) > 0 || (counted.nodes ?? 0) > 0;

  return {
    dir,
    exists: true,
    recoverable,
    memory,
    kept,
    ops: counted.ops,
    nodes: counted.nodes,
    hasMemory,
  };
}

/**
 * Выполнить план. `memory` — то самое разрешение (`--wipe-memory`), и оно
 * обязано доехать сюда параметром, а не подразумеваться: без него стирается
 * ровно восстановимое, а база с оплогом остаётся на месте — в том числе на
 * пустом ярусе, где терять нечего. «Пустая» и «которую не жалко» — разные
 * вещи: у пустой базы есть site_id, под которым уже писали хуки и агенты.
 *
 * Право звать эту функцию проверяется до неё — по `hasMemory` (init.ts):
 * здесь уже не спрашивают, здесь исполняют. Возвращает список удалённых
 * записей: и пользователю, и тесту нужен факт, а не намерение.
 */
export function wipePersonalWorkspace(
  plan: PersonalWipePlan,
  options: { readonly memory: boolean },
): readonly string[] {
  if (!plan.exists) return [];
  const targets = [...plan.recoverable, ...(options.memory ? plan.memory : [])].sort();
  for (const entry of targets) rmSync(join(plan.dir, entry), { recursive: true, force: true });
  return targets;
}

export type StoreDeps = {
  openStore(ctx: CommandContext, options?: OpenOptions): Promise<OpenStoreResult>;
};

/**
 * Что просят команды, умеющие звать векторный поиск (S45). Одна константа на
 * все такие места: список команд, поднимающих рантайм, читается по её
 * использованиям, а не по памяти автора правки.
 */
export const VECTOR_OPEN: OpenOptions = { extensions: true };

export const realStoreDeps: StoreDeps = { openStore };

// ---------------------------------------------------------------------------
// Разрешение ID: полный или однозначный префикс (§2.4)
// ---------------------------------------------------------------------------

const QL = {
  id_prefix: {
    name: "id_prefix",
    sql: `SELECT id FROM nodes
           WHERE id >= ?1 AND id < ?2 AND deleted_at IS NULL
           ORDER BY id LIMIT 4`,
    params: ["lower", "upper"],
  },
  oplog_last_hlc: {
    name: "oplog_last_hlc",
    sql: "SELECT CAST(hlc AS TEXT) AS hlc FROM oplog ORDER BY seq DESC LIMIT 1",
    params: [],
  },
} as const;

export type ResolveResult =
  | { readonly ok: true; readonly node: NodeRecord }
  | { readonly ok: false; readonly failure: CommandFailure };

function prefixCandidates(handle: StoreHandle, prefix: string): string[] {
  const range = prefixRange(prefix);
  return handle.driver
    .all<{ id: string }>(QL.id_prefix, [range.lower, range.upper])
    .map((r) => r.id);
}

export function resolveId(handle: StoreHandle, input: string): ResolveResult {
  const exact = handle.store.getNode(input);
  if (exact !== undefined) return { ok: true, node: exact };

  let candidates = prefixCandidates(handle, input);
  if (candidates.length === 0 && !input.includes("-")) {
    candidates = prefixCandidates(handle, `${handle.slug}-${input}`);
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "notfound.node",
        msg: `узел ${input} не найден`,
        exit: ExitCode.NOTFOUND,
      },
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "usage.ambiguous_id",
        msg: `префикс '${input}' неоднозначен: ${candidates.join(", ")}`,
        exit: ExitCode.USAGE,
        hint: "уточните префикс",
      },
    };
  }
  const node = handle.store.getNode(candidates[0]!);
  if (node === undefined) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "notfound.node",
        msg: `узел ${input} не найден`,
        exit: ExitCode.NOTFOUND,
      },
    };
  }
  return { ok: true, node };
}

/** Ошибки движка → конвертные коды, а не internal.unexpected. */
export function graphFailure(e: unknown): CommandFailure {
  // Нарушение инвариантов дерева `parent` — это отказ ПОЛЬЗОВАТЕЛЮ, а не
  // поломка myc. Без этой ветки цикл выходил как `internal.unexpected`, то
  // есть человек читал «внутренняя ошибка» там, где сам попросил невозможное
  // (проверено на живом переносе эпика под собственную задачу).
  if (e instanceof ClosureError) {
    return { ok: false, code: `precond.${e.code.replace("closure.", "")}`, msg: e.message, exit: ExitCode.PRECOND };
  }
  if (e instanceof GraphError) {
    const code = e.code;
    if (code === "graph.not_found") {
      return { ok: false, code: "notfound.node", msg: e.message, exit: ExitCode.NOTFOUND };
    }
    return { ok: false, code: "usage.invalid", msg: e.message, exit: ExitCode.USAGE };
  }
  throw e;
}

// ---------------------------------------------------------------------------
// Форматтеры плотного вывода
// ---------------------------------------------------------------------------

export function fmtPriority(priority: number): string {
  return `P${priority}`;
}

/** Видимый «тип» узла: у задач — attrs.type (task/bug/epic), у остальных — kind. */
export function typeLabel(node: NodeRecord): string {
  if (node.kind === "task") {
    const t = node.attrs["type"];
    if (typeof t === "string" && t.length > 0) return t;
  }
  return node.kind;
}

export function fmtClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Возраст/длительность компактно: 38m, 6h, 2d. */
export function fmtAge(ms: number): string {
  const abs = Math.max(0, ms);
  const m = Math.floor(abs / 60_000);
  if (m < 1) return `${Math.floor(abs / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Оценка из estimate_min: ~20m, ~2h. */
export function fmtEstimate(minutes: number): string {
  return `~${fmtAge(minutes * 60_000)}`;
}

export function estimateMin(node: NodeRecord): number | undefined {
  const v = node.attrs["estimate_min"];
  return typeof v === "number" ? v : undefined;
}

export function tagsOf(node: NodeRecord): string[] {
  const v = node.attrs["tags"];
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

/** Парс длительности флагов: 30m, 2h, 1d, 90s. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

/** Приоритет флага: P0..P3 или 0..3 → 0..3. */
export function parsePriority(text: string): number | undefined {
  const m = /^(?:[pP])?([0-3])$/.exec(text.trim());
  return m ? Number(m[1]) : undefined;
}

export function ms(t0: number): string {
  return `${Math.max(1, Math.round(performance.now() - t0))} мс`;
}

/** Колоночная строка: паддинг всех колонок, кроме последней. */
export function columns(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length)))
    .join("  ")
    .trimEnd();
}
