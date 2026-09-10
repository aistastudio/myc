/**
 * Очередь тяжёлых команд на машине (эпик memory-14qyv1gmacef): хранилище,
 * слоты, аренда с живостью. Команды `myc run` и `myc queue` — в
 * commands/run.ts; здесь только то, что обязано держаться между процессами.
 *
 * ГДЕ СОСТОЯНИЕ. `~/.myc/queue.db` (MYC_HOME переносит его в тестах) — один
 * файл SQLite на пользователя машины, общий для всех репозиториев, деревьев и
 * агентов. Не проектный `.myc/`: очередь одна на ядра, а не на репозиторий.
 * Не личная `~/.myc/myc.db`: та появляется только по `myc init --global`
 * (S41, запись в личный ярус — явным действием), и требовать её ради очереди
 * значило бы заставить каждого завести ярус памяти. Схема — версиями в
 * ./migrations/run-queue.ts, применённая версия — `PRAGMA user_version`.
 *
 * ПОЧЕМУ НЕ ТАБЛИЦА `jobs` (packages/store-sqlite/src/jobs.ts). Механизм аренды
 * там проверен SIGKILL'ом, и его ИНВАРИАНТЫ взяты отсюда без изменений: выдача
 * слота — ОДИН стейтмент UPDATE с предикатом (пара SELECT+UPDATE дала бы
 * двойной захват, S38/S40), снятие ограждено держателем. Но сами строки jobs
 * устроены под другую задачу, и натянуть очередь на них — значит сломать обе:
 *
 *  1. Работа jobs ничья: любой исполнитель забирает ГОЛОВУ очереди. Здесь
 *     билет принадлежит процессу, который его поставил, — чужую команду
 *     `myc run` выполнить не может. `jobs.claim` не умеет «выдай МОЮ строку и
 *     только если впереди меньше N».
 *  2. У jobs нет потолка одновременных аренд (семафора) и нет продления: срок
 *     ставится при захвате. Команде на 4 минуты пришлось бы брать аренду на
 *     часы — и тогда SIGKILL держателя вешал бы очередь на те же часы.
 *  3. Просроченная аренда в jobs засчитывается как попытка, и после
 *     `max_attempts` строка «мертва» навсегда: пять упавших держателей — и
 *     слот не выдаётся больше никогда.
 *  4. Строки jobs видят `myc doctor`, /api/health и `sweep`: билеты очереди
 *     считались бы там ждущими и мёртвыми работами проекта.
 *
 * Поэтому здесь своя маленькая таблица `run_queue` в своём файле, а механизм —
 * тот же: выдача одним стейтментом, снятие по держателю, живость по pid
 * (как `pidAlive` в packages/swarm/src/launch.ts: EPERM — жив) плюс аренда с
 * продлением на случай, когда pid ничего не доказывает.
 *
 * ЖИВОСТЬ БИЛЕТА — два независимых вопроса.
 *   pid   на этой машине процесса нет (kill 0 → ESRCH) — билет мёртв СРАЗУ:
 *         SIGKILL держателя освобождает слот за один такт опроса ждущего.
 *   lease держатель продлевает аренду каждые lease/6. Просроченная аренда при
 *         живом pid — «подозрительно», а не «мертво»: pid мог достаться чужому
 *         процессу, но держатель мог и просто спать вместе с ноутбуком. После
 *         пробуждения часы прыгают у всех разом, и снять держателя по одному
 *         взгляду на часы значило бы запустить вторую тяжёлую команду рядом с
 *         первой. Поэтому устаревший билет снимает только тот, кто САМ
 *         наблюдал его без продления целое окно (lease/3 своего монотонного
 *         времени) — проснувшийся держатель за это окно успевает продлиться.
 *
 * ПОРЯДОК — FIFO по времени постановки: `id INTEGER PRIMARY KEY AUTOINCREMENT`
 * выдаётся под замком записи SQLite, то есть порядок id и есть порядок
 * постановки, и id не переиспользуются. Билет получает слот, когда
 * «выполняются + ждут впереди» < слотов.
 *
 * Модуль импортирует только `node:*`, `bun:sqlite` и `@myc/core` (последний
 * всё равно загружен каждым запуском CLI — index.ts). Граф @myc/store-sqlite
 * здесь не нужен и стоил бы ~20 мс в исходниках на каждый `myc run`.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { resolveSession } from "@myc/core";
import { personalHome } from "./commands/wsfind.ts";
import { QUEUE_MIGRATIONS } from "./migrations/run-queue.ts";

// ---------------------------------------------------------------------------
// Константы и окружение
// ---------------------------------------------------------------------------

/** Полоса по умолчанию: всё тяжёлое (полный bun test, сборки, бенчмарки). */
export const DEFAULT_LANE = "heavy";

/**
 * Слотов по умолчанию — один. Переопределение — `MYC_<ПОЛОСА>_SLOTS`
 * (`MYC_HEAVY_SLOTS=2`). Настройка файлом — следующая задача эпика; жить она
 * будет в `~/.myc/queue.toml` (`[lanes.heavy] slots = 2`) рядом с queue.db:
 * число слотов — свойство машины (её ядер), а не проекта и не человека.
 * Переменная окружения останется старше файла.
 */
export const DEFAULT_SLOTS = 1;

/**
 * Аренда — 30 с, продление каждые 5 с (lease/6). Аренда здесь — запасной путь:
 * SIGKILL держателя ловит pid за такт опроса, а срок нужен только там, где
 * pid ничего не доказывает (pid переиспользован, процесс остановлен SIGSTOP,
 * другая машина на общем ~/.myc). 30 с — чтобы задержка таймеров под
 * нагрузкой 6–7 (ровно та, ради которой очередь) не снимала живых.
 */
export const DEFAULT_LEASE_MS = 30_000;

/** Опрос ждущего: 200 мс. Столько же в среднем вдвое меньше — передача слота. */
export const DEFAULT_POLL_MS = 200;

/** Версия схемы queue.db (PRAGMA user_version) — последняя из миграций. */
export const QUEUE_SCHEMA_VERSION = QUEUE_MIGRATIONS.reduce((v, m) => Math.max(v, m.version), 0);

/** Имя полосы: оно же входит в имя переменной слотов. */
const LANE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function isValidLane(lane: string): boolean {
  return LANE_RE.test(lane);
}

/** `heavy` → `MYC_HEAVY_SLOTS`, `gpu-bench` → `MYC_GPU_BENCH_SLOTS`. */
export function slotsEnvName(lane: string): string {
  return `MYC_${lane.toUpperCase().replace(/-/g, "_")}_SLOTS`;
}

export interface SlotsSetting {
  readonly slots: number;
  /** Откуда число: `env` — переменная, `default` — умолчание. */
  readonly source: "env" | "default";
  /** Переменная задана, но не число ≥ 1 — сказать вслух (И2). */
  readonly invalid?: string;
}

export function slotsFor(lane: string, env: Readonly<Record<string, string | undefined>>): SlotsSetting {
  const name = slotsEnvName(lane);
  const raw = (env[name] ?? "").trim();
  if (raw === "") return { slots: DEFAULT_SLOTS, source: "default" };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 256) {
    return { slots: DEFAULT_SLOTS, source: "default", invalid: `${name}=${raw}` };
  }
  return { slots: n, source: "env" };
}

function positiveMsFromEnv(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const n = Number((env[name] ?? "").trim());
  return (env[name] ?? "").trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Настройки таймингов: умолчания выше, переопределение — только для тестов. */
export interface QueueTimings {
  readonly leaseMs: number;
  readonly pollMs: number;
}

export function timingsFromEnv(env: Readonly<Record<string, string | undefined>>): QueueTimings {
  return {
    leaseMs: positiveMsFromEnv(env, "MYC_RUN_LEASE_MS", DEFAULT_LEASE_MS),
    pollMs: positiveMsFromEnv(env, "MYC_RUN_POLL_MS", DEFAULT_POLL_MS),
  };
}

/** Период продления аренды: шесть продлений на срок. */
export function heartbeatMs(leaseMs: number): number {
  return Math.max(10, Math.floor(leaseMs / 6));
}

/** Сколько наблюдатель обязан видеть билет без продления, прежде чем снять. */
export function staleWindowMs(leaseMs: number): number {
  return Math.max(20, Math.floor(leaseMs / 3));
}

/** `~/.myc/queue.db`; MYC_HOME переносит его (тесты, контейнеры). */
export function queueDbPath(home: string = personalHome()): string {
  return join(home, ".myc", "queue.db");
}

// ---------------------------------------------------------------------------
// Схема и открытие
// ---------------------------------------------------------------------------

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Накатить миграции queue.db (./migrations/run-queue.ts). Версия читается
 * заново ПОД замком записи: два первых запуска приходят сюда одновременно, и
 * второй обязан увидеть работу первого, а не повторить её.
 */
function migrateQueue(db: Database): void {
  db.transaction(() => {
    const current = userVersion(db);
    for (const m of QUEUE_MIGRATIONS) if (m.version > current) db.exec(m.sql);
    if (QUEUE_SCHEMA_VERSION > current) db.exec(`PRAGMA user_version = ${QUEUE_SCHEMA_VERSION}`);
  }).immediate();
}

/**
 * Открыть (и при первом обращении создать) queue.db.
 *
 * PRAGMA здесь СВОИ, а не STORE_PRAGMAS (S43), и это не расхождение путей
 * одной базы, а другая база: без оплога и графа, в ней десяток строк. Ей не
 * нужны ни рантайм vec0 (4–7 мс на запуск), ни выключенный авточекпойнт с
 * предохранителем WAL — встроенный авточекпойнт SQLite на таком объёме
 * бесплатен. Нужны WAL (читатель `myc queue` не блокирует писателей) и
 * busy_timeout: писателей столько, сколько агентов на машине.
 */
export function openQueue(path: string, options: { readonly create?: boolean } = {}): Database {
  const create = options.create !== false;
  if (create) mkdirSync(dirname(path), { recursive: true });
  // ПЕРВОЕ СОЗДАНИЕ — ГОНКА, и busy_timeout от неё не спасает. Новый файл
  // рождается в режиме rollback-журнала; `journal_mode = WAL` повышает
  // блокировку, и когда два процесса повышают её навстречу друг другу, SQLite
  // отдаёт одному SQLITE_BUSY СРАЗУ, не зовя обработчик ожидания (иначе
  // взаимоблокировка). Замер: пять `myc run` одновременно на пустом
  // MYC_HOME, 30 кругов — 15 из 150 процессов упали с «database is locked»
  // (тест «первое создание queue.db»). Поэтому открытие целиком повторяется
  // на SQLITE_BUSY — со случайной паузой и потолком: победитель к этому
  // времени уже перевёл файл в WAL, и повтор проходит без повышения.
  const deadline = Date.now() + OPEN_BUSY_RETRY_MS;
  for (let attempt = 1; ; attempt++) {
    const db = new Database(path, create ? { create: true } : { readwrite: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      const version = userVersion(db);
      if (version > QUEUE_SCHEMA_VERSION) {
        throw new Error(
          `${path} was created by a newer myc (queue schema ${version}, this build knows ${QUEUE_SCHEMA_VERSION}); ` +
            "upgrade myc or remove the file when no `myc run` is active",
        );
      }
      if (version < QUEUE_SCHEMA_VERSION) migrateQueue(db);
      return db;
    } catch (error) {
      db.close();
      if ((error as { code?: unknown }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      Bun.sleepSync(5 + Math.random() * 20 * Math.min(attempt, 5));
    }
  }
}

/** Потолок повторов открытия на SQLITE_BUSY (см. openQueue). */
const OPEN_BUSY_RETRY_MS = 5_000;

/** Открыть только если файл уже есть: `myc queue` ничего не создаёт. */
export function openQueueIfExists(path: string): Database | undefined {
  return existsSync(path) ? openQueue(path, { create: false }) : undefined;
}

// ---------------------------------------------------------------------------
// Строки
// ---------------------------------------------------------------------------

export type TicketState = "waiting" | "running";

/** Строка `run_queue` как она лежит в базе. */
export interface TicketRow {
  readonly id: number;
  readonly lane: string;
  readonly holder: string;
  readonly pid: number;
  readonly host: string;
  readonly state: TicketState;
  readonly enqueued_at: number;
  readonly started_at: number | null;
  readonly lease_ms: number;
  readonly lease_expires: number;
  readonly renewed_at: number;
  /** JSON-массив argv. */
  readonly argv: string;
  readonly cwd: string;
  readonly session: string;
  readonly terminal: string;
  readonly agent_pid: number | null;
  readonly actor: string;
  /** pid запущенной команды; null — ещё не запущена (или билет ждёт). */
  readonly child_pid: number | null;
}

/** Кто ставит билет: процесс `myc run` и то, что о нём покажет `myc queue`. */
export interface TicketInput {
  readonly lane: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly pid: number;
  readonly host: string;
  readonly session: string;
  readonly terminal: string;
  readonly agentPid: number | null;
  readonly actor: string;
}

/** Уникальный держатель: pid повторяется, держатель — нет (ограждение снятия). */
export function mintHolder(host: string, pid: number): string {
  return `${host}:${pid}:${Math.random().toString(36).slice(2, 10)}`;
}

function envPid(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): number | null {
  for (const name of names) {
    const raw = (env[name] ?? "").trim();
    if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  }
  return null;
}

/**
 * Кто ставит — из окружения процесса: сессия (MYC_SESSION_ID и ключи хоста,
 * тот же порядок, что у `remember`/`prime`), терминал оркестратора и pid
 * агента (те же переменные, что пишет `myc attempt` — packages/swarm/src/launch.ts).
 */
export function ticketInput(
  lane: string,
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): TicketInput {
  return {
    lane,
    argv,
    cwd,
    pid: process.pid,
    host: hostname(),
    session: resolveSession(undefined, env),
    terminal: (env.ORCA_TERMINAL_HANDLE ?? "").trim(),
    agentPid: envPid(env, ["MYC_AGENT_PID", "CLAUDE_PID"]),
    actor: (env.MYC_ACTOR ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// Сколько билетов полосы стоит МЕЖДУ этим билетом и слотом: все
// выполняющиеся плюс ждущие с меньшим id. Это и есть FIFO — порядок id есть
// порядок постановки. ?5 — полоса, ?3 — id билета (для новой строки — число
// больше любого id, то есть «все, кто уже есть»).
const BLOCKERS = `(SELECT count(*) FROM run_queue AS q
                     WHERE q.lane = ?5 AND q.id <> ?3
                       AND (q.state = 'running' OR q.id < ?3))`;

// Постановка и немедленная выдача — ОДИН стейтмент: при пустой очереди билет
// рождается выполняющимся, без второго захода в базу (И1).
const SQL_ENQUEUE = `
INSERT INTO run_queue (lane, holder, pid, host, state, enqueued_at, started_at,
                       lease_ms, lease_expires, renewed_at, argv, cwd,
                       session, terminal, agent_pid, actor)
SELECT ?5, ?4, ?7, ?8,
       CASE WHEN ${BLOCKERS} < ?6 THEN 'running' ELSE 'waiting' END,
       ?1,
       CASE WHEN ${BLOCKERS} < ?6 THEN ?1 END,
       ?2, ?1 + ?2, ?1, ?9, ?10, ?11, ?12, ?13, ?14
RETURNING *`;

// Выдача слота ждущему — ОДИН стейтмент (инвариант jobs.claim): подсчёт
// блокирующих и запись живут в одной неявной транзакции записи, окна для
// соседа между ними нет. Ограждение по holder: чужой билет не выдаётся.
const SQL_GRANT = `
UPDATE run_queue
   SET state = 'running', started_at = ?1, lease_expires = ?1 + ?2, renewed_at = ?1
 WHERE id = ?3 AND holder = ?4 AND state = 'waiting'
   AND ${BLOCKERS} < ?6
RETURNING *`;

const SQL_RENEW = `
UPDATE run_queue SET lease_expires = ?1 + lease_ms, renewed_at = ?1
 WHERE id = ?2 AND holder = ?3`;

const SQL_RELEASE = `DELETE FROM run_queue WHERE id = ?1 AND holder = ?2`;

const SQL_SET_CHILD = `UPDATE run_queue SET child_pid = ?3 WHERE id = ?1 AND holder = ?2`;

// Снятие устаревшего огорожено ещё и сроком: продлился держатель между нашим
// чтением и удалением — lease_expires уже другой, и строка остаётся.
const SQL_REMOVE_STALE = `DELETE FROM run_queue WHERE id = ?1 AND holder = ?2 AND lease_expires = ?3`;

const SQL_LANE = `SELECT * FROM run_queue WHERE lane = ?1 ORDER BY id`;
const SQL_ALL = `SELECT * FROM run_queue ORDER BY lane, id`;
const SQL_GET = `SELECT * FROM run_queue WHERE id = ?1 AND holder = ?2`;

// ---------------------------------------------------------------------------
// Операции
// ---------------------------------------------------------------------------

const NEW_ROW_ID = Number.MAX_SAFE_INTEGER;

/** Поставить билет; при свободном слоте он сразу `running`. */
export function enqueue(
  db: Database,
  input: TicketInput,
  holder: string,
  slots: number,
  leaseMs: number,
  now: number = Date.now(),
): TicketRow {
  return db
    .query(SQL_ENQUEUE)
    .get(
      now,
      leaseMs,
      NEW_ROW_ID,
      holder,
      input.lane,
      slots,
      input.pid,
      input.host,
      JSON.stringify(input.argv),
      input.cwd,
      input.session,
      input.terminal,
      input.agentPid,
      input.actor,
    ) as TicketRow;
}

/** Попытка получить слот; undefined — не сейчас (или билета уже нет). */
export function tryGrant(
  db: Database,
  ticket: Pick<TicketRow, "id" | "holder" | "lane">,
  slots: number,
  leaseMs: number,
  now: number = Date.now(),
): TicketRow | undefined {
  return (
    (db.query(SQL_GRANT).get(now, leaseMs, ticket.id, ticket.holder, ticket.lane, slots) as TicketRow | null) ??
    undefined
  );
}

/** Продлить аренду; false — билета больше нет (его сняли как устаревший). */
export function renew(db: Database, ticket: Pick<TicketRow, "id" | "holder">, now: number = Date.now()): boolean {
  return Number(db.query(SQL_RENEW).run(now, ticket.id, ticket.holder).changes) > 0;
}

/** Записать pid запущенной команды — для `myc queue` и для сирот (см. reap). */
export function setChild(db: Database, ticket: Pick<TicketRow, "id" | "holder">, childPid: number): boolean {
  return Number(db.query(SQL_SET_CHILD).run(ticket.id, ticket.holder, childPid).changes) > 0;
}

/** Снять свой билет. Ограждено держателем: чужой не снимется. */
export function release(db: Database, ticket: Pick<TicketRow, "id" | "holder">): boolean {
  return Number(db.query(SQL_RELEASE).run(ticket.id, ticket.holder).changes) > 0;
}

export function getTicket(db: Database, ticket: Pick<TicketRow, "id" | "holder">): TicketRow | undefined {
  return (db.query(SQL_GET).get(ticket.id, ticket.holder) as TicketRow | null) ?? undefined;
}

export function listLane(db: Database, lane: string): TicketRow[] {
  return db.query(SQL_LANE).all(lane) as TicketRow[];
}

export function listAll(db: Database): TicketRow[] {
  return db.query(SQL_ALL).all() as TicketRow[];
}

// ---------------------------------------------------------------------------
// Живость
// ---------------------------------------------------------------------------

/**
 * Жив ли pid: сигнал 0 не доставляется, а только спрашивает ядро. EPERM —
 * «процесс есть, но чужой» — это ЖИВ (та же семантика, что `pidAlive` в
 * packages/swarm/src/launch.ts; импорт @myc/swarm ради восьми строк стоил
 * бы ~5 мс графа модулей на каждый `myc run`).
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * alive — pid жив (или не проверяем) и аренда в сроке;
 * stale — аренда просрочена, а смерть не доказана (pid жив или чужая машина);
 * dead  — процесса на этой машине нет: слот свободен прямо сейчас.
 */
export type Liveness = "alive" | "stale" | "dead";

export function liveness(
  row: Pick<TicketRow, "pid" | "host" | "lease_expires">,
  now: number,
  host: string,
  probe: (pid: number) => boolean = pidAlive,
): Liveness {
  if (row.host === host && !probe(row.pid)) return "dead";
  return row.lease_expires > now ? "alive" : "stale";
}

/**
 * Наблюдатель устаревших билетов (см. шапку: «сон ноутбука»). Билет снимается,
 * только если ЭТОТ процесс видел один и тот же `lease_expires` целое окно
 * своего монотонного времени. Продлился — наблюдение начинается заново.
 */
export class StaleWatch {
  readonly #seen = new Map<number, { readonly leaseExpires: number; readonly since: number }>();

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** true — билет не продлевался всё окно, пока мы смотрели. */
  expired(row: Pick<TicketRow, "id" | "lease_expires" | "lease_ms">): boolean {
    const now = this.clock();
    const prev = this.#seen.get(row.id);
    if (prev === undefined || prev.leaseExpires !== row.lease_expires) {
      this.#seen.set(row.id, { leaseExpires: row.lease_expires, since: now });
      return false;
    }
    return now - prev.since >= staleWindowMs(row.lease_ms);
  }

  /** Забыть билеты, которых больше нет в полосе. */
  retain(ids: ReadonlySet<number>): void {
    for (const id of this.#seen.keys()) if (!ids.has(id)) this.#seen.delete(id);
  }
}

/**
 * Снятый билет. `orphan` — держатель мёртв, а его команда ЖИВА: SIGKILL
 * убил `myc run`, но не то, что он запустил (на macOS нет PDEATHSIG). Слот
 * всё равно переходит следующему — иначе сирота без срока держала бы очередь
 * (задача: падение держателя не вешает очередь), — но нагрузка на машине
 * осталась, и следующий обязан услышать об этом, а не гадать, почему медленно.
 */
export type RemovedTicket = TicketRow & { readonly reason: "dead" | "stale"; readonly orphan: boolean };

export interface ReapResult {
  /** Живые строки полосы после уборки, в порядке id. */
  readonly rows: TicketRow[];
  /** Снятые этим вызовом: мёртвые и досмотренные устаревшие. */
  readonly removed: RemovedTicket[];
}

/**
 * Уборка полосы перед попыткой получить слот: мёртвые снимаются сразу,
 * устаревшие — через наблюдателя. Свой билет не трогается никогда: если нас
 * самих остановили, это решат другие. Без наблюдателя (`myc queue`, один
 * взгляд) устаревшие не снимаются — только показываются.
 */
export function reap(
  db: Database,
  lane: string | undefined,
  opts: {
    readonly now?: number;
    readonly host?: string;
    readonly probe?: (pid: number) => boolean;
    readonly watch?: StaleWatch;
    readonly selfId?: number;
  } = {},
): ReapResult {
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostname();
  const probe = opts.probe ?? pidAlive;
  const all = lane === undefined ? listAll(db) : listLane(db, lane);
  const rows: TicketRow[] = [];
  const removed: RemovedTicket[] = [];
  const orphan = (row: TicketRow): boolean => row.host === host && row.child_pid !== null && probe(row.child_pid);
  for (const row of all) {
    if (row.id === opts.selfId) {
      rows.push(row);
      continue;
    }
    const state = liveness(row, now, host, probe);
    if (state === "dead") {
      if (release(db, row)) removed.push({ ...row, reason: "dead", orphan: orphan(row) });
      continue;
    }
    if (state === "stale" && opts.watch?.expired(row) === true) {
      const gone = Number(db.query(SQL_REMOVE_STALE).run(row.id, row.holder, row.lease_expires).changes) > 0;
      if (gone) {
        removed.push({ ...row, reason: "stale", orphan: orphan(row) });
        continue;
      }
    }
    rows.push(row);
  }
  opts.watch?.retain(new Set(rows.map((r) => r.id)));
  return { rows, removed };
}

// ---------------------------------------------------------------------------
// Вложенный `myc run`
// ---------------------------------------------------------------------------

/**
 * Полосы, слот которых держит предок. Тяжёлая команда под `myc run` может
 * сама звать `myc run` (скрипт сборки, хук, оборачивающий тяжёлое, — следующая
 * задача эпика); ждать слота, который держит собственный предок, — это
 * взаимоблокировка до --max-wait. Вложенный вызов той же полосы исполняется
 * сразу, в слоте предка.
 */
export const HELD_ENV = "MYC_RUN_HELD";

export function heldLanes(env: Readonly<Record<string, string | undefined>>): Set<string> {
  return new Set((env[HELD_ENV] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
}

export function withHeldLane(
  env: Readonly<Record<string, string | undefined>>,
  lane: string,
): Record<string, string | undefined> {
  const held = heldLanes(env);
  held.add(lane);
  return { ...env, [HELD_ENV]: [...held].join(",") };
}
