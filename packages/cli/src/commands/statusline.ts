/**
 * `myc statusline` — строка статуса Claude Code: то, чего агент не видит
 * сам, одной компактной строкой, и на КАЖДУЮ отрисовку.
 *
 *   myc │ ctx 42% │ 56 ready · 2 in progress · 31 blocked │ 604 files · 4129 symbols · 12m ago │ 135 notes │ 7/9 useful calls
 *
 * Слева направо: заполнение окна контекста (число хоста, см. ниже), очередь
 * задач (готово / в работе / заблокировано), код-индекс (файлы, символы,
 * давность последней записи — или «нет индекса», или «индексируется»), память
 * проекта (узлы знания в охвате репозитория) и обращения к myc в ЭТОЙ сессии:
 * сколько полезных из скольких. Деградация — маркер `⚠` сразу после `myc`; нет
 * деградации — нет и маркера.
 *
 * Ставит её `myc wire --status-line` (без флага wire statusLine не трогает).
 * Ввод — JSON хоста на stdin (схема прочитана из бинаря Claude Code 2.1.267,
 * см. statusline-config.ts); из него берутся `session_id`, `transcript_path`,
 * `cwd`, `workspace.current_dir` и `context_window.used_percentage`. Те же
 * байты уходят ЧУЖОЙ строке, которая стояла до нас (statusline-passthrough.ts):
 * её не ждём, над нашей строкой печатается вывод её последнего завершённого
 * запуска.
 *
 * КОНТЕКСТ — ЧИСЛО ХОСТА, НЕ НАШЕ. `context_window` в 2.1.267 (справка
 * statusLine в бинаре и функция, что его собирает): `total_input_tokens`,
 * `total_output_tokens`, `context_window_size`, `current_usage` (токены
 * последнего ответа или null) и `used_percentage` / `remaining_percentage` —
 * `Math.round(ввод / окно × 100)`, зажато в 0..100, null до первого ответа.
 * Берём `used_percentage` как есть (округляем и зажимаем — на случай хоста,
 * что пришлёт дробь), ничего не считая: стоимость — ноль лишнего ввода-вывода,
 * значение уже в stdin. Поля нет или оно null (старый хост, терминал, сессия
 * без ответа) — сегмента нет вовсе: это не деградация myc, а отсутствие числа.
 *
 * ОТМЕТКИ ВЫСОКОГО ЗАПОЛНЕНИЯ НЕТ, и это решение. Хост сам предупреждает
 * красным («N% until auto-compact», «Context low (N% remaining)») по своему
 * порогу — окно минус запас на сводку, с учётом CLAUDE_AUTOCOMPACT_PCT_OVERRIDE.
 * Наш порог по `used_percentage` меряет от ПОЛНОГО окна и с порогом хоста не
 * совпадает: 80% у окна 200k и у окна 1M — разное расстояние до сжатия, то
 * есть символ значил бы разное. Число читается и без него.
 *
 * БЮДЖЕТ (И1). Хост зовёт строку на каждое сообщение, отмена прежней
 * отрисовки убивает её дерево — значит, строка обязана быть быстрой, без
 * записи в базу и без побочных процессов. Отсюда три решения:
 *   - транскрипт читается инкрементально (statusline-session.ts);
 *   - счётчики базы кешируются в файле сессии по `max(oplog.seq)` и времени,
 *     а не в `digest_cache`: кеш в базе — это запись, а запись из строки
 *     статуса упиралась бы в чужую блокировку в рое агентов;
 *   - строка сама пишет stdout и выходит: хвост `run()` после успешной
 *     команды — дренаж очереди (index.ts), до 50 мс работы и порождение
 *     фоновых воркеров, — строке статуса противопоказан. Это единственная
 *     команда, которая так делает; причина — не вкус, а бюджет и то, что
 *     Claude Code убивает дерево отменённой строки вместе с её детьми.
 *
 * Код выхода — ВСЕГДА 0: при ненулевом Claude Code не покажет ничего, в том
 * числе вывод чужой строки. Падение нашей части печатается строкой-причиной.
 *
 * СТРОКА ПОЛЬЗОВАТЕЛЬСКОГО СЛОЯ (`--scope user`, ставит `myc wire --scope user
 * --status-line`, memory-6x0ag4p493pc). Её исполняет КАЖДАЯ сессия на машине,
 * у которой нет своей проектной строки, — агенты orca в worktree командных
 * репозиториев, но и проекты без myc вовсе. Поэтому:
 *   - в воркспейсе myc (и в его git worktree — воркспейс находится через общий
 *     git-каталог, как у всего myc) — полная строка, как у проектной;
 *   - вне воркспейса — НИЧЕГО своего, только вывод чужой строки, если он был.
 *     Не «ctx N%», и это решение: (1) до нас там была пустая строка (orca не
 *     печатает ничего), и пользовательский слой обещает, что вне воркспейса
 *     myc не виден — helper выходит сразу, MCP отдаёт ноль инструментов, скилл
 *     говорит «только где есть воркспейс»; (2) ctx — число хоста, а не myc, и
 *     хост сам предупреждает о близком сжатии своим порогом — сегмент в каждом
 *     проекте машины был бы новой функцией там, где myc никто не звал;
 *     (3) это дешевле всего: ни транскрипта, ни проверки модели, ни хранилища
 *     — подъём по каталогам и выход;
 *   - ввод чужой строке — ВСЕГДА, в воркспейсе и вне его. Пользовательская
 *     строка здесь наша, поэтому чужая берётся из журнала пользовательского
 *     слоя (`~/.myc/wire-user.json`, statusline-config.ts), а не из настроек.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";
import { defineQueries, reachPredicate, repoPredicate } from "@myc/core";
import { DEFAULT_MODEL_ID, modelManifestPath } from "@myc/embed/model-id";
// Подпуть, а не "@myc/retrieval": корень пакета тянет гибрид, вектор и кеш —
// модули, за загрузку которых строка статуса платила бы на каждой отрисовке.
import { notPendingPredicate } from "@myc/retrieval/review";
import type { FlagSpec } from "../flags.ts";
import { envelopeLine, okEnvelope } from "../envelope.ts";
import { ExitCode } from "../exit.ts";
import { CLI_VERSION, guardStdio } from "../index.ts";
import type { Command, CommandContext } from "../registry.ts";
import {
  isOurStatusLineCommand,
  NESTED_ENV,
  readStatusLine,
  recordedUserStatusLine,
  statusLineCommand,
  THEN_FLAG,
  userSettingsPath,
} from "../statusline-config.ts";
import { PASS_WINDOW_MS, readForeignResult, runPassthrough, type PassOutcome } from "../statusline-passthrough.ts";
import { MAX_SCAN_BYTES, scanSession, type CallCounts, type SessionState } from "../statusline-session.ts";
import { findWorkspaceDb } from "./wsfind.ts";
// Хранилище и очередь — ТОЛЬКО типами. Сами модули (~9 мс инициализации в
// бинаре, см. шапку wsfind.ts) грузятся в ownPart, ПОСЛЕ запуска чужой
// строки: её цепочка процессов (sh → список → sh -c) идёт, пока грузятся они.
import type { readyQueries as ReadyQueries } from "./ready.ts";
import type { StoreDeps, StoreHandle } from "./store.ts";

// ---------------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------------

export interface QueueStats {
  readonly ready: number;
  readonly in_progress: number;
  readonly blocked: number;
  /** Ушедшие из очереди только по наследованию блокера (как у `myc ready`). */
  readonly blocked_by_ancestor: number;
}

export interface CodeStats {
  /** none — индекса нет; indexing — воркер держит работы; queued — работы ждут; ok. */
  readonly state: "none" | "indexing" | "queued" | "ok";
  readonly files: number;
  readonly symbols: number;
  /** Когда индекс последний раз записал файл; 0 — никогда. */
  readonly indexed_at: number;
  /**
   * Когда индекс последний раз был СВЕРЕН с деревом целиком — завершённый
   * прогон (`code_indexed_at`); у базы без отметки — последняя запись. Не то
   * же, что `indexed_at`: прогон, не нашедший изменений, ничего не пишет, и
   * «9h ago» по записи значило бы «9 часов никто не менял основные копии», а
   * читалось бы как «индексу 9 часов» (memory-es8qwd555cjt).
   */
  readonly refreshed_at: number;
  /** Давность сверки коротко (fmtAge: 38m, 6h, 2d). */
  readonly age: string;
  /** Старше порога фонового обновления (15m, MYC_CODE_INDEX_PERIOD_MS). */
  readonly stale: boolean;
  /** Фоновое обновление: идёт, ждёт, ждёт повтора, бросило; null — строки нет. */
  readonly refresh: "running" | "queued" | "retry" | "failed" | null;
  readonly queued: number;
}

export interface SessionPart {
  readonly transcript: string | null;
  readonly counts: CallCounts;
  readonly pending: number;
  readonly read_bytes: number;
  /** Не дочитано из-за потолка отрисовки: счёт ещё догоняет. */
  readonly behind_bytes: number;
  readonly files: number;
  readonly took_ms: number;
}

export interface ForeignPart {
  /**
   * Откуда чужая команда: project — `--then`, user — ~/.claude/settings.json,
   * user-previous — пользовательская строка стоит наша, а чужая, которую она
   * заменила, записана в журнале `myc wire --scope user` (~/.myc/wire-user.json).
   */
  readonly source: "project" | "user" | "user-previous" | null;
  readonly started: boolean;
  /** Текущий запуск дождались (только с `--wait-ms`). */
  readonly finished: boolean;
  /**
   * Чей итог показан: current — запуска этой отрисовки (дождались или он
   * успел за нашу работу), previous — прошлого завершённого, null — не было.
   */
  readonly from: "current" | "previous" | null;
  readonly rc: number | null;
  readonly shown: boolean;
  readonly waited_ms: number;
  readonly window_ms: number;
  /** Почему не передавали: nested, ours, none, tty, win32, disabled. */
  readonly skipped?: string;
}

export interface StatuslineData {
  /** Чья строка: project — проектная (по умолчанию), user — пользовательского слоя (`--scope user`). */
  readonly scope: "project" | "user";
  /**
   * Почему нашей строки нет: nested — нас позвали как чужую строку другой
   * строки myc; no-workspace — строка пользовательского слоя вне воркспейса.
   */
  readonly silent?: "nested" | "no-workspace";
  /** Наша строка. */
  readonly line: string;
  /** Всё, что уходит в stdout: вывод чужой строки (если был) и наша. */
  readonly lines: readonly string[];
  /**
   * Заполнение окна контекста, % — `context_window.used_percentage` хоста,
   * округлённое и зажатое в 0..100. null — хост числа не дал: сегмента нет.
   */
  readonly context_pct: number | null;
  readonly workspace: string | null;
  readonly workspace_error?: string;
  readonly repo: string;
  readonly queue: QueueStats | null;
  readonly code: CodeStats | null;
  readonly memory: number | null;
  readonly degraded: readonly string[];
  readonly session: SessionPart | null;
  readonly foreign: ForeignPart;
  readonly cache: { readonly stats: "hit" | "miss" | "none"; readonly code: "hit" | "miss" | "none" };
  readonly took_ms: number;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Кеш на сессию: курсор транскрипта и счётчики базы
// ---------------------------------------------------------------------------

/** Счётчики базы живут до следующей записи в оплог, но не дольше этого. */
export const STATS_TTL_MS = 30_000;
/** Код-индекс в оплог не пишет — только время; идущая индексация — каждый раз. */
export const CODE_TTL_MS = 60_000;
/** Файлы кеша старше этого убираются при создании нового. */
const CACHE_GC_MS = 7 * 24 * 60 * 60 * 1000;

interface StatsCache {
  readonly key: string;
  readonly seq: number;
  readonly at: number;
  readonly queue: QueueStats;
  readonly memory: number;
  readonly anchors_stale: number;
  readonly jobs_dead: number;
}

interface CodeCache {
  readonly key: string;
  readonly at: number;
  readonly files: number;
  readonly symbols: number;
  readonly l1_files: number;
  readonly indexed_at: number;
}

/**
 * Формат документа кеша сессии. Документ несёт и сборку: сменилась сборка или
 * формат — выбрасывается ЦЕЛИКОМ (состояние транскрипта, счётчики базы и
 * код-индекса), ведь посчитаны они логикой, которой больше нет. Внутри сборки
 * от смены логики защищают: состояние сессии — CLASSIFIER_VERSION
 * (statusline-session.ts), счётчики базы — TTL 30 с и max(oplog.seq),
 * код-индекса — TTL 60 с. 1 — первая сдача (без сборки в документе).
 */
const CACHE_FORMAT = 2;

interface CacheDoc {
  readonly v: typeof CACHE_FORMAT;
  readonly build: string;
  session?: SessionState;
  stats?: StatsCache;
  code?: CodeCache;
}

function cacheFile(dir: string, key: string): string {
  return join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 20)}.json`);
}

/**
 * Итог последнего запуска чужой строки: на сессию (её ввод — её данные) и на
 * команду (сменил человек строку — старый вывод не всплывёт под новой). В нём
 * нет нашей логики — это вывод ЧУЖОЙ команды; наше в нём только формат
 * `код\nвывод`, который пишет обёртка, и его версия входит в имя: сменится
 * формат — старый файл просто не будет прочитан.
 */
const FOREIGN_FORMAT = 1;
function foreignResultFile(dir: string, key: string, command: string): string {
  const id = createHash("sha256").update(`f${FOREIGN_FORMAT}\n${key}\n${command}`).digest("hex").slice(0, 20);
  return join(dir, `${id}.foreign`);
}

function readCache(path: string, build: string): CacheDoc {
  const empty: CacheDoc = { v: CACHE_FORMAT, build };
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as CacheDoc;
    return doc !== null && typeof doc === "object" && doc.v === CACHE_FORMAT && doc.build === build ? doc : empty;
  } catch {
    return empty;
  }
}

/**
 * Запись атомарная (tmp + rename): две отрисовки ОДНОЙ сессии, наложившиеся
 * во времени, считают от одного курсора до одного конца и пишут одинаковое —
 * читатель не должен увидеть половину файла. Разные сессии пишут разные файлы
 * по построению ключа.
 */
function writeCache(dir: string, path: string, doc: CacheDoc, now: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    const fresh = !existsSync(path);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, path);
    if (fresh) sweepCache(dir, now);
  } catch {
    // Кеш — ускорение, а не данные: не записался — следующая отрисовка
    // посчитает заново.
  }
}

function sweepCache(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > CACHE_GC_MS) rmSync(p, { force: true });
    } catch {
      /* соседний процесс уже убрал */
    }
  }
}

/** Каталог кеша; `MYC_STATUSLINE_CACHE` — для тестов и замеров. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MYC_STATUSLINE_CACHE;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  return join(tmpdir(), `myc-statusline-${uid}`);
}

// ---------------------------------------------------------------------------
// Счётчики базы
// ---------------------------------------------------------------------------

/**
 * Узлы знания — память (note, кроме реплик-комментариев) и решения
 * (`attrs.type = 'decision'` у любого вида: на живой базе решения заведены и
 * задачами). Живые: не отозваны и не заменены. Охват — как у `recall` этой
 * сессии: репозиторий вызова и видимость сессии (чужое сессионное не
 * считается). Кандидаты хука сжатия (`attrs.state = 'pending_review'`, §6.2)
 * — не знание, пока их не подтвердили, и узлом знания не считаются: recall
 * их не отдаёт, и счётчик, в котором они есть, обещал бы то, чего нет.
 */
const QS = defineQueries({
  sl_seq: { name: "sl_seq", sql: "SELECT coalesce(max(seq), 0) AS s FROM oplog", params: [] },
  sl_memory: {
    name: "sl_memory",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE scope = ?1 AND kind IN ('note','task') AND deleted_at IS NULL
             AND status NOT IN ('retracted','superseded','cancelled')
             AND CASE kind WHEN 'note' THEN coalesce(json_extract(attrs,'$.type'),'') <> 'comment'
                           ELSE json_extract(attrs,'$.type') = 'decision' END
             AND ${repoPredicate("nodes", 2)}
             AND ${reachPredicate("nodes", 3)}
             AND ${notPendingPredicate("nodes")}`,
    params: ["scope", "repo", "session"],
  },
  sl_anchors_stale: {
    name: "sl_anchors_stale",
    sql: `SELECT count(*) AS n FROM nodes
           WHERE scope = ?1 AND kind = 'anchor' AND status IN ('stale','lost') AND deleted_at IS NULL
             AND ${repoPredicate("nodes", 2)}`,
    params: ["scope", "repo"],
  },
  sl_jobs_dead: {
    name: "sl_jobs_dead",
    sql: "SELECT count(*) AS n FROM jobs WHERE attempts >= max_attempts",
    params: [],
  },
  sl_code_jobs: {
    name: "sl_code_jobs",
    sql: `SELECT count(*) AS queued, coalesce(sum(lease_expires > ?1), 0) AS leased
            FROM jobs WHERE kind = 'code_index' AND attempts < max_attempts`,
    params: ["now"],
  },
});

/**
 * Те же числа, что у `myc ready`: готовые — его `collectTop().total` (открытые
 * без блокеров плюс брошенные с истёкшей арендой), остальное — его же запросы
 * подвала. Не `readyStats()`: тот кеширует в `digest_cache`, то есть пишет.
 */
async function queueStats(h: StoreHandle, repo: string, now: number): Promise<QueueStats> {
  const { collectTop, readyQueries } = await import("./ready.ts");
  const one = (q: (typeof ReadyQueries)[keyof typeof ReadyQueries]): number =>
    h.driver.one<{ n: number }>(q, [h.scope, repo])?.n ?? 0;
  return {
    ready: collectTop(h, 1, now, repo).total,
    in_progress: one(readyQueries.ready_stats_in_progress),
    blocked: one(readyQueries.ready_stats_blocked),
    blocked_by_ancestor: one(readyQueries.ready_stats_blocked_anc),
  };
}

// ---------------------------------------------------------------------------
// Отрисовка
// ---------------------------------------------------------------------------

export function renderLine(d: Omit<StatuslineData, "line" | "lines" | "took_ms" | "scope" | "silent">): string {
  const parts: string[] = [];
  // Контекст — первым после `myc` и его маркера: он про сессию хоста, а не
  // про воркспейс, и виден даже без воркспейса.
  if (d.context_pct !== null) parts.push(`ctx ${d.context_pct}%`);
  if (d.workspace === null) {
    parts.push(d.workspace_error ?? "no myc workspace — run myc init");
  } else {
    const q = d.queue;
    if (q !== null) {
      const inProgress = q.in_progress > 0 ? ` · ${q.in_progress} in progress` : "";
      const viaParent = q.blocked_by_ancestor > 0 ? ` (+${q.blocked_by_ancestor} via parent)` : "";
      parts.push(`${q.ready} ready${inProgress} · ${q.blocked} blocked${viaParent}`);
    } else {
      parts.push("tasks: ?");
    }
    parts.push(codePart(d.code));
    parts.push(d.memory !== null ? count(d.memory, "note") : "notes: ?");
  }
  parts.push(sessionPartText(d.session));
  const marker = d.degraded.length > 0 ? ` ⚠ ${d.degraded.join(", ")}` : "";
  return `myc${marker} │ ${parts.join(" │ ")}`;
}

/** `1 file`, `2 files` — строка читается человеком, а не парсером. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Код-индекс: счётчики, давность СВЕРКИ и, громко (И2), что с обновлением —
 * `refreshing` (фон сверяет прямо сейчас), `refresh queued`, `refresh
 * retrying` (прошлая попытка упала), `refresh failed` (фон бросил — сам не
 * возьмётся), `stale` (старше порога, а обновления нет вовсе). Свежий —
 * только давность, как было.
 */
function codePart(c: CodeStats | null): string {
  if (c === null) return "code: ?";
  if (c.state === "none") return "no code index";
  const counts = `${count(c.files, "file")} · ${count(c.symbols, "symbol")}`;
  if (c.state === "indexing") return `${counts} · indexing`;
  if (c.state === "queued") return `${counts} · ${count(c.queued, "file")} queued`;
  const tail =
    c.refresh === "running"
      ? " · refreshing"
      : c.refresh === "queued"
        ? " · refresh queued"
        : c.refresh === "retry"
          ? " · refresh retrying"
          : c.refresh === "failed"
            ? " · refresh failed"
            : c.stale
              ? " · stale"
              : "";
  return `${counts} · ${c.age} ago${tail}`;
}

function sessionPartText(s: SessionPart | null): string {
  if (s === null) return "no session";
  const tail = s.behind_bytes > 0 ? " (counting)" : "";
  return `${s.counts.useful}/${s.counts.total} useful calls${tail}`;
}

// ---------------------------------------------------------------------------
// Ввод хоста
// ---------------------------------------------------------------------------

interface HostInput {
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly current_dir?: string;
  /** `context_window.used_percentage`, округлённое и зажатое в 0..100. */
  readonly context_pct?: number;
}

function parseInput(raw: Uint8Array): HostInput {
  if (raw.length === 0) return {};
  try {
    const v = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    if (v === null || typeof v !== "object") return {};
    const str = (x: unknown): string | undefined => (typeof x === "string" && x.length > 0 ? x : undefined);
    const obj = (x: unknown): Record<string, unknown> | undefined =>
      x !== null && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
    const ws = obj(v["workspace"]);
    const used = obj(v["context_window"])?.["used_percentage"];
    return {
      session_id: str(v["session_id"]),
      transcript_path: str(v["transcript_path"]),
      cwd: str(v["cwd"]),
      current_dir: ws !== undefined ? str(ws["current_dir"]) : undefined,
      context_pct: typeof used === "number" && Number.isFinite(used) ? Math.min(100, Math.max(0, Math.round(used))) : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Весь stdin. `null` — на stdin терминал: строку позвал человек, а не хост,
 * и передавать чужой строке нечего (она получила бы пустоту вместо JSON).
 */
function readStdinReal(): Uint8Array | null {
  if (isatty(0)) return null;
  try {
    return readFileSync(0);
  } catch {
    return new Uint8Array(0);
  }
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export interface StatuslineDeps extends StoreDeps {
  readonly now: () => number;
  readonly env: NodeJS.ProcessEnv;
  /** Байты ввода хоста; `null` — хоста нет (терминал). */
  readonly readStdin: () => Uint8Array | null;
  readonly cacheDir: string;
  /**
   * Напечатать и выйти самим (боевой CLI) или вернуть результат `run()`
   * (тесты в процессе). См. шапку: хвост `run()` строке противопоказан.
   */
  readonly selfExit: boolean;
  readonly platform: NodeJS.Platform;
  /** Потолок чтения транскрипта за отрисовку (MAX_SCAN_BYTES; тесты — меньше). */
  readonly scanBytes: number;
  /** Сборка: часть отпечатка кеша (CLI_VERSION; тесты подменяют). */
  readonly build: string;
}

const realDeps = (): StatuslineDeps => ({
  openStore: async (ctx, options) => (await import("./store.ts")).openStore(ctx, options),
  now: Date.now,
  env: process.env,
  readStdin: readStdinReal,
  cacheDir: defaultCacheDir(),
  selfExit: true,
  platform: process.platform,
  scanBytes: MAX_SCAN_BYTES,
  build: CLI_VERSION,
});

const FLAGS: readonly FlagSpec[] = [
  {
    name: "scope",
    value: "string",
    description:
      "project (default) or user — the line of Claude Code's user layer (myc wire --scope user --status-line): " +
      "outside a myc workspace it prints nothing of its own, and still hands the input on",
  },
  { name: "then", value: "string", description: "the project statusLine command we replaced: gets the same stdin" },
  {
    name: "wait-ms",
    value: "number",
    description: `wait up to N ms for THIS render's foreign output (default ${PASS_WINDOW_MS}: never wait, show its last completed run)`,
  },
  { name: "no-pass", description: "do not hand the input to any foreign statusLine" },
];

/**
 * Чья строка получает наш ввод. `--then` — проектная, которую мы заменили
 * (wire записал её аргументом); иначе — пользовательская, прочитанная СЕЙЧАС:
 * поставь человек orca после нашей строки, orca всё равно получит данные.
 * Пользовательская — сама наша (`myc wire --scope user --status-line`)? Тогда
 * та, которую она заменила, из журнала пользовательского слоя: так ввод
 * доходит до orca и от строки пользовательского слоя, и от проектной строки
 * myc, которая раньше отдавала его пользовательской напрямую.
 * Никогда — мы сами: здесь это отсекает текст команды, а вызов через чужую
 * обёртку — переменная вложенности (см. начало computeStatusline).
 */
function resolveForeign(
  ctx: CommandContext,
  env: NodeJS.ProcessEnv,
): { readonly command: string | null; readonly source: ForeignPart["source"]; readonly skipped?: string } {
  if (ctx.flags["no-pass"] === true) return { command: null, source: null, skipped: "disabled" };
  const raw = ctx.flags["then"];
  const then = typeof raw === "string" ? raw : undefined;
  const pick = (command: string | null, source: NonNullable<ForeignPart["source"]>): ReturnType<typeof resolveForeign> => {
    if (command === null) return { command: null, source: null, skipped: "none" };
    if (isOurStatusLineCommand(command)) return { command: null, source, skipped: "ours" };
    return { command, source };
  };
  if (then !== undefined && then.trim().length > 0) return pick(then, "project");
  const user = statusLineCommand(readStatusLine(userSettingsPath(env)).value);
  if (user !== null && isOurStatusLineCommand(user)) {
    const recorded = recordedUserStatusLine(env);
    if (recorded !== undefined) return pick(statusLineCommand(recorded.previous), "user-previous");
  }
  return pick(user, "user");
}

/** `--scope`: project по умолчанию; null — значение, которого нет. */
function parseScope(ctx: CommandContext): "project" | "user" | null {
  const raw = ctx.flags["scope"];
  if (raw === undefined) return "project";
  return raw === "project" || raw === "user" ? raw : null;
}

export function createStatuslineCommand(overrides: Partial<StatuslineDeps> = {}): Command {
  const deps = { ...realDeps(), ...overrides };
  return {
    name: "statusline",
    summary: "one-line status for Claude Code's statusLine: context fill, queue, code index, memory, useful myc calls",
    flags: FLAGS,
    help:
      "Reads the host's statusLine JSON on stdin and prints one line: the context window fill the host " +
      "reports (ctx N%, from context_window.used_percentage; no segment when the host gives none), tasks ready / in progress / " +
      "blocked, code index files, symbols and age, memory nodes in this repo's reach, and how many " +
      "of THIS session's calls to the tool were useful out of how many (counted from the host's " +
      "transcript, incrementally). The same stdin bytes go to the statusLine that was there before " +
      `(${THEN_FLAG}, the user one, or — when the user line is myc's own — the one it replaced, recorded in ` +
      "~/.myc/wire-user.json), detached: never waited for (unless --wait-ms) and never " +
      "killed; the output of its last completed run is printed above ours. --scope user is the line " +
      "of Claude Code's user layer: in a myc workspace (a git worktree included) it is the full line, " +
      "outside one it prints nothing of its own. " +
      "Always exits 0. Installed by `myc wire --status-line` (or `myc wire --scope user --status-line`).",
    handler: async (ctx) => {
      if (parseScope(ctx) === null) {
        return { ok: false, code: "usage.invalid", msg: "--scope takes project or user", exit: ExitCode.USAGE };
      }
      const data = await computeStatusline(ctx, deps);
      if (deps.selfExit) {
        const text = ctx.globals.json
          ? envelopeLine(okEnvelope("statusline", data, undefined, ctx.diagnostics))
          : humanText(data);
        await writeAndExit(text);
      }
      return { ok: true, data };
    },
    renderHuman: (raw) => humanText(raw as StatuslineData),
  };
}

function humanText(d: StatuslineData): string {
  return d.lines.length > 0 ? `${d.lines.join("\n")}\n` : "";
}

async function writeAndExit(text: string): Promise<never> {
  const io = guardStdio();
  process.exitCode = 0;
  process.stdout.write(text);
  await io.stdout();
  process.exit(0);
}

/** Есть ли воркспейс myc отсюда (или из основного дерева git worktree). Сбой чтения — нет. */
function inWorkspace(dir: string): boolean {
  try {
    return "dbPath" in findWorkspaceDb(dir);
  } catch {
    return false;
  }
}

/** Никогда не бросает: любая беда — строка-причина, а не пустая строка статуса. */
export async function computeStatusline(ctx: CommandContext, deps: StatuslineDeps): Promise<StatuslineData> {
  const t0 = performance.now();
  const now = deps.now();
  const waitRaw = ctx.flags["wait-ms"];
  const windowMs = Math.max(0, typeof waitRaw === "number" ? waitRaw : PASS_WINDOW_MS);
  const scope = parseScope(ctx) ?? "project";

  // Нас позвали как ЧУЖУЮ строку другой строки myc (обёртка пользователя
  // зовёт `myc statusline`): внешняя уже рисует всё то же — молчим, иначе
  // строка myc вышла бы дважды. И дальше ничего не передаём.
  if ((deps.env[NESTED_ENV] ?? "").length > 0) {
    return {
      scope,
      silent: "nested",
      line: "",
      lines: [],
      context_pct: null,
      workspace: null,
      repo: "",
      queue: null,
      code: null,
      memory: null,
      degraded: [],
      session: null,
      foreign: { source: null, started: false, finished: false, from: null, rc: null, shown: false, waited_ms: 0, window_ms: windowMs, skipped: "nested" },
      cache: { stats: "none", code: "none" },
      took_ms: Math.round((performance.now() - t0) * 10) / 10,
    };
  }

  const stdin = deps.readStdin();
  const raw = stdin ?? new Uint8Array(0);
  const input = parseInput(raw);
  const dir = resolve(ctx.globals.directory ?? input.current_dir ?? input.cwd ?? process.cwd());
  // Ключ кеша — транскрипт сессии: у двух сессий разные файлы по построению.
  const cacheKey = input.transcript_path ?? (input.session_id !== undefined ? `session:${input.session_id}` : `dir:${dir}`);

  // Чужая строка стартует ПЕРВОЙ и отсоединённой: её итог ляжет в файл
  // результата этой сессии, а показан будет последний завершённый — наш
  // вывод от её времени не зависит (statusline-passthrough.ts).
  const foreign: ReturnType<typeof resolveForeign> =
    stdin === null ? { command: null, source: null, skipped: "tty" } : resolveForeign(ctx, deps.env);
  const resultFile = foreign.command !== null ? foreignResultFile(deps.cacheDir, cacheKey, foreign.command) : null;
  const pass: Promise<PassOutcome> | null =
    foreign.command !== null && resultFile !== null
      ? runPassthrough({
          command: foreign.command,
          payload: raw,
          windowMs,
          env: deps.env,
          tmpDir: deps.cacheDir,
          resultFile,
          platform: deps.platform,
        })
      : null;

  // Строка пользовательского слоя вне воркспейса молчит (шапка): ни
  // транскрипта, ни модели, ни хранилища — один подъём по каталогам, тот же,
  // что у всего myc (из git worktree — через основное дерево), и только node:fs.
  const silent: StatuslineData["silent"] =
    scope === "user" && ctx.globals.db === undefined && !inWorkspace(dir) ? "no-workspace" : undefined;

  let body: Omit<StatuslineData, "line" | "lines" | "took_ms" | "foreign" | "context_pct" | "scope" | "silent">;
  let error: string | undefined;
  try {
    body =
      silent !== undefined
        ? {
            workspace: null,
            repo: "",
            queue: null,
            code: null,
            memory: null,
            degraded: [],
            session: null,
            cache: { stats: "none", code: "none" },
          }
        : await ownPart(ctx, deps, input, dir, cacheKey, now);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    body = {
      workspace: null,
      workspace_error: `status line failed: ${error}`,
      repo: "",
      queue: null,
      code: null,
      memory: null,
      degraded: [],
      session: null,
      cache: { stats: "none", code: "none" },
    };
  }

  const got = pass !== null ? await pass : null;
  // Итог чужой: дождались текущего (--wait-ms) — его; иначе последний
  // завершённый из файла. Читается ПОСЛЕ нашей работы: быстрая чужая успевает
  // за это время, и её вывод оказывается свежим без всякого ожидания.
  const result = got?.current ?? (resultFile !== null ? readForeignResult(resultFile) : null);
  let from: ForeignPart["from"] = null;
  if (got?.current) from = "current";
  else if (result !== null) from = got !== null && result.at >= got.startedAt ? "current" : "previous";
  const foreignPart: ForeignPart = {
    source: foreign.source,
    started: got?.started ?? false,
    finished: got?.finished ?? false,
    from,
    rc: result?.rc ?? null,
    // Как у самого хоста: вывод показывается только при коде 0.
    shown: result !== null && result.rc === 0 && result.output.trim().length > 0,
    waited_ms: got?.waitedMs ?? 0,
    window_ms: windowMs,
    ...(foreign.skipped !== undefined ? { skipped: foreign.skipped } : got?.error !== undefined ? { skipped: got.error } : {}),
  };
  const context_pct = input.context_pct ?? null;
  const line = silent !== undefined ? "" : renderLine({ ...body, context_pct, foreign: foreignPart });
  const lines = [
    ...(foreignPart.shown && result !== null
      ? result.output.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
      : []),
    ...(line.length > 0 ? [line] : []),
  ];
  return {
    scope,
    ...(silent !== undefined ? { silent } : {}),
    context_pct,
    ...body,
    foreign: foreignPart,
    line,
    lines,
    took_ms: Math.round((performance.now() - t0) * 10) / 10,
    ...(error !== undefined ? { error } : {}),
  };
}

async function ownPart(
  ctx: CommandContext,
  deps: StatuslineDeps,
  input: HostInput,
  dir: string,
  cacheKey: string,
  now: number,
): Promise<Omit<StatuslineData, "line" | "lines" | "took_ms" | "foreign" | "context_pct" | "scope" | "silent">> {
  const cachePath = cacheFile(deps.cacheDir, cacheKey);
  const cache = readCache(cachePath, deps.build);

  // Сессия: только если хост назвал транскрипт. Без него честнее сказать
  // «неизвестна», чем показать ноль.
  let session: SessionPart | null = null;
  if (input.transcript_path !== undefined) {
    const scanned = scanSession(cache.session ?? null, input.transcript_path, deps.scanBytes, deps.build);
    cache.session = scanned.state;
    const r = scanned.report;
    session = {
      transcript: input.transcript_path,
      counts: r.counts,
      pending: r.pending,
      read_bytes: r.readBytes,
      behind_bytes: r.behindBytes,
      files: r.files,
      took_ms: r.tookMs,
    };
  }

  const degraded: string[] = [];
  // Эмбеддер — самый дешёвый признак: наличие манифеста модели на диске.
  if (!existsSync(modelManifestPath(DEFAULT_MODEL_ID, deps.env))) degraded.push("no embedding model");

  let opened: Awaited<ReturnType<StoreDeps["openStore"]>>;
  try {
    opened = await deps.openStore({ ...ctx, globals: { ...ctx.globals, directory: dir } });
  } catch (e) {
    // Битый файл базы бросает, а не возвращает отказ; сессия при этом уже
    // посчитана, и терять её вместе с базой незачем.
    opened = {
      ok: false,
      failure: { ok: false, code: "io.open", msg: e instanceof Error ? e.message : String(e), exit: 1 },
    };
  }
  if (!opened.ok) {
    writeCache(deps.cacheDir, cachePath, cache, now);
    return {
      workspace: null,
      workspace_error: opened.failure.code.startsWith("ws.")
        ? "no myc workspace — run myc init"
        : `database unavailable: ${opened.failure.msg.split("\n")[0]!.slice(0, 60)}`,
      repo: "",
      queue: null,
      code: null,
      memory: null,
      degraded,
      session,
      cache: { stats: "none", code: "none" },
    };
  }
  const h = opened.handle;
  try {
    const { fmtAge, repoTarget } = await import("./store.ts");
    const repo = repoTarget(h);
    const sessionKey = input.session_id ?? "";
    const db = resolve(h.mycDir);
    const statsKey = `${db}|${h.scope}|${repo}|${sessionKey}`;

    let statsHit: "hit" | "miss" = "miss";
    let stats: StatsCache;
    const seq = h.driver.one<{ s: number }>(QS.sl_seq, [])?.s ?? 0;
    const prev = cache.stats;
    if (prev !== undefined && prev.key === statsKey && prev.seq === seq && now - prev.at < STATS_TTL_MS && now >= prev.at) {
      stats = prev;
      statsHit = "hit";
    } else {
      stats = {
        key: statsKey,
        seq,
        at: now,
        queue: await queueStats(h, repo, now),
        memory: h.driver.one<{ n: number }>(QS.sl_memory, [h.scope, repo, sessionKey])?.n ?? 0,
        anchors_stale: h.driver.one<{ n: number }>(QS.sl_anchors_stale, [h.scope, repo])?.n ?? 0,
        jobs_dead: h.driver.one<{ n: number }>(QS.sl_jobs_dead, [])?.n ?? 0,
      };
      cache.stats = stats;
    }

    // Код-индекс: работы воркера — каждый раз (идёт ли индексация), счётчики —
    // из кеша, пока индекс не пишет.
    const jobs = h.driver.one<{ queued: number; leased: number }>(QS.sl_code_jobs, [now]) ?? { queued: 0, leased: 0 };
    const codeKey = `${db}|${repo}`;
    let codeHit: "hit" | "miss" = "miss";
    let code: CodeCache;
    const prevCode = cache.code;
    if (prevCode !== undefined && prevCode.key === codeKey && jobs.queued === 0 && now - prevCode.at < CODE_TTL_MS && now >= prevCode.at) {
      code = prevCode;
      codeHit = "hit";
    } else {
      const { indexScope } = await import("@myc/code-intel/read");
      const { coveringIndex } = await import("@myc/code-intel/view");
      // Из вложенного репозитория и его worktree своего индекса нет — строки
      // лежат в индексе корня под префиксом репозитория (memory-m0md9fybwrdh);
      // без этого строка статуса говорила «no code index» там, где код-команды
      // отвечают.
      const scope = indexScope(h.driver.database, coveringIndex(h.driver.database, repo) ?? repo);
      code = {
        key: codeKey,
        at: now,
        files: scope.files,
        symbols: scope.defs,
        l1_files: scope.l1Files,
        indexed_at: scope.indexedAt,
      };
      cache.code = code;
    }
    // Давность сверки и фоновое обновление — КАЖДУЮ отрисовку, мимо кеша: это
    // два поиска по ключу, а «refreshing» из минутного кеша висел бы после
    // того, как обновление давно кончилось. Та же функция и тот же порог, что
    // у WARN код-команд: строка и ответ не могут разойтись в «свежий/устарел».
    const { indexFreshness, refreshAfterMs } = await import("@myc/code-intel/refresh");
    const fresh = code.files > 0 ? indexFreshness(h.driver.database, now, refreshAfterMs(deps.env)) : null;
    const refreshedAt = fresh !== null && fresh.refreshedAt > 0 ? fresh.refreshedAt : code.indexed_at;
    const codeStats: CodeStats = {
      state:
        jobs.leased > 0 ? "indexing" : jobs.queued > 0 ? "queued" : code.files === 0 ? "none" : "ok",
      files: code.files,
      symbols: code.symbols,
      indexed_at: code.indexed_at,
      refreshed_at: refreshedAt,
      age: fmtAge(now - refreshedAt),
      stale: fresh?.stale ?? false,
      refresh: fresh?.job?.state ?? null,
      queued: jobs.queued,
    };

    // Дешёвые признаки деградации (И2): только то, что уже посчитано.
    if (code.l1_files > 0 && code.symbols === 0 && jobs.leased === 0) degraded.push("no grammars");
    if (stats.anchors_stale > 0) degraded.push(`${stats.anchors_stale} stale anchor${stats.anchors_stale === 1 ? "" : "s"}`);
    if (stats.jobs_dead > 0) degraded.push(`${stats.jobs_dead} failed job${stats.jobs_dead === 1 ? "" : "s"}`);

    writeCache(deps.cacheDir, cachePath, cache, now);
    return {
      workspace: h.wsDir,
      repo,
      queue: stats.queue,
      code: codeStats,
      memory: stats.memory,
      degraded,
      session,
      cache: { stats: statsHit, code: codeHit },
    };
  } finally {
    h.close();
  }
}

/** Для тестов: путь файла кеша той же функцией, что и команда. */
export function statuslineCachePath(cacheDir: string, key: string): string {
  return cacheFile(cacheDir, key);
}
