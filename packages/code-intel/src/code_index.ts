/**
 * Фоновый индекс кода: заполнение code_files/code_defs/code_refs через класс
 * работ `code_index` в ОБЩЕЙ очереди jobs (§4.3
 * docs/design/05-code-intelligence.md, решение S52, задача T2).
 *
 * Свой механизм очереди НЕ заводится: работа ставится `jobs.enqueue` с
 * дедупликацией по (kind, entity_id), разбирается `jobs.claim` под арендой и
 * снимается `jobs.complete` с ограждением по holder — все инварианты аренды и
 * аварийного завершения уже держит store-sqlite/jobs.ts между независимыми
 * процессами. Скан только ПОПОЛНЯЕТ очередь, источником истины она не является
 * (тот же расклад, что у векторного `myc reindex`).
 *
 * Инкрементальность — два уровня, как у якорей (01 §7.2):
 *
 *   1. (mtime_ms, size_bytes) из code_files — файл не читается вовсе;
 *   2. wyhash содержимого — mtime-тач без изменения кода не доходит до разбора.
 *
 * Свежестной строкой L1-файла воркер распоряжается ПОСЛЕ разбора: скан не
 * пишет хеш изменённого файла, иначе процесс, умерший между сканом и разбором,
 * оставил бы «свежую» строку над устаревшими дефсами — и файл никогда не
 * переиндексировался бы (mtime уже совпадает). Тач (хеш совпал) и L0-файлы
 * (дефсов у них нет и не будет) безопасно писать сразу: записанное содержание
 * уже соответствует написанному.
 *
 * code_refs (fan_in, T5) — кеш: пересчёт по репозиторию это проход по всему
 * содержимому, несовместимый с бюджетом повторного индекса. Индексатор только
 * ИНВАЛИДИРУЕТ строки имён изменённых файлов; fan_in считает по требованию.
 *
 * `freshness: "mtime"` и `incremental: false` — приёмочные инструменты мутаций
 * (задача T2), а не рабочие режимы: они существуют, чтобы замер мог ПОКАЗАТЬ
 * цену отказа от хеша и от инкрементальности. По умолчанию выключены.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { jobs } from "@myc/store-sqlite";
import { listDefs, type Def, type LangId } from "./defs.ts";

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Класс работ в общей очереди jobs. */
export const CODE_INDEX_JOB_KIND = "code_index";

/**
 * Приоритет класса: фоновая работа, не обгоняет embed (3) и absorb (5),
 * уровнем с sync/export (8). В JOB_PRIORITY (jobs.ts) класса нет — тот файл
 * не нашей редакции, приоритет передаётся явно при каждой постановке.
 */
export const CODE_INDEX_PRIORITY = 8;

/** Языки уровня L1 (§5): определения разбираются только для них. */
export const L1_LANGS: ReadonlySet<string> = new Set(["ts", "tsx", "js", "jsx"]);

/**
 * С какого размера батча разбор идёт в пул воркеров. Ниже порога пул не
 * окупает собственного старта: 10 изменённых файлов разбираются за
 * единицы миллисекунд в этом же потоке.
 */
export const PARSE_POOL_MIN_FILES = 64;

const LANG_BY_EXT: ReadonlyMap<string, string> = new Map([
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".jsx", "jsx"],
  [".mjs", "js"],
  [".cjs", "js"],
]);

/** Каталоги, в которые индекс не входит никогда. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);

/** Файлы крупнее этого не читаются и не индексируются (страховка от OOM). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export interface CodeIndexOptions {
  /** id репозитория (repo из 01 §7.1); он же scope работ в очереди. */
  readonly repoId: string;
  /** Корень репозитория на диске (абсолютный). */
  readonly root: string;
  readonly now?: number;
  /** Разбор дефсов; по умолчанию listDefs. Подмена — для тестов и замеров. */
  readonly parse?: (source: string, lang: LangId) => Def[];
  /**
   * Свежесть: "hash" (умолчание) — уровень 1 это (mtime, size), уровень 2 —
   * хеш; "mtime" — МУТАЦИЯ 2 приёмки: сверяется ТОЛЬКО mtime, ни размера, ни
   * хеша — правка с восстановленным mtime проходит незамеченной, а mtime-тач
   * приводит к разбору.
   */
  readonly freshness?: "hash" | "mtime";
  /**
   * МУТАЦИЯ 1 приёмки: false — инкрементальности нет, в работу становится
   * каждый файл при каждом прогоне.
   */
  readonly incremental?: boolean;
}

export interface ScanStats {
  /** Файлов увидено на диске. */
  readonly files: number;
  readonly unchanged: number;
  /** mtime/size изменились, хеш — нет: разбора не было, mtime записан. */
  readonly touched: number;
  /** Содержимое изменилось (или freshness="mtime" и mtime изменился). */
  readonly dirty: number;
  /** Из dirty реально вставлено в очередь (дедуп мог отсечь повтор). */
  readonly enqueued: number;
  /** Файлы, исчезнувшие с диска: строки code_files/code_defs убраны. */
  readonly removed: number;
  /** L0-файлы, чьи строки реестра записаны сканом. */
  readonly l0Written: number;
  /** Пропущено по размеру (MAX_FILE_BYTES). */
  readonly excluded: number;
  readonly scanMs: number;
  readonly enqueueMs: number;
}

export interface DrainStats {
  readonly claimed: number;
  /** Вызовов разбора (инкрементальность видна здесь). */
  readonly parsed: number;
  /** Файлов, чьи строки записаны (дефсы и/или code_files). */
  readonly written: number;
  /** Файлов, исчезнувших к моменту разбора: строки убраны. */
  readonly cleaned: number;
  readonly failed: number;
  readonly batches: number;
  /** Миллисекунды собственно разбора, без чтения и записи. */
  readonly parseMs: number;
  readonly applyMs: number;
  /** Ожидание чужих просроченных аренд. */
  readonly waitedMs: number;
  readonly drainMs: number;
}

export interface IndexRunResult {
  readonly scan: ScanStats;
  readonly drain: DrainStats;
}

// ---------------------------------------------------------------------------
// Служебное
// ---------------------------------------------------------------------------

/** Язык файла: L1-идентификатор или расширение без точки (L0). */
export function langOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return LANG_BY_EXT.get(ext) ?? ext.replace(/^\./, "");
}

function wyhash(data: Uint8Array): string {
  return `wy:${Bun.hash(data).toString(16)}`;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // каталог исчез до обхода — не наша гонка
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
        continue;
      }
      if (!e.isFile()) continue;
      out.push(relative(root, p).split(sep).join("/"));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Пул разбора
// ---------------------------------------------------------------------------

/**
 * Пул воркеров listDefs. Один воркер на свободное ядро (потолок 8), живёт
 * ровно столько, сколько идёт большой прогон. Подменный `parse` из опций в
 * воркер не уносится — функция не переходит границу потока; пул включается
 * только для разбора по умолчанию.
 *
 * Пул — ОПТИМИЗАЦИЯ, а не условие корректности: каждый разбор стоит под
 * сторожевым таймером (POOL_WATCHDOG_MS); не дождались — пул гасится, файл
 * разбирается в своём потоке. Под нагрузкой CI воркер может стартовать
 * дольше обычного, и индексация не имеет права из-за этого застревать.
 */
class ParsePool {
  static readonly WATCHDOG_MS = 2_000;

  readonly #workers: Worker[] = [];
  readonly #pending = new Map<
    number,
    { resolve: (defs: Def[]) => void; reject: (e: Error) => void }
  >();
  #nextId = 0;
  /** true — сторож погасил пул, дальнейшие батчи идут без него. */
  broken = false;

  constructor(size: number) {
    const url = new URL("./code_index_worker.ts", import.meta.url);
    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.onmessage = (e: MessageEvent<{ id: number; defs?: Def[]; error?: string }>) => {
        const waiter = this.#pending.get(e.data.id);
        if (waiter === undefined) return;
        this.#pending.delete(e.data.id);
        if (e.data.error !== undefined) waiter.reject(new Error(e.data.error));
        else waiter.resolve(e.data.defs ?? []);
      };
      w.onerror = () => {
        // Воркер умер: его ждущие получат отказ и разберутся фолбэком в своём
        // потоке. Остальные воркеры продолжают.
        for (const [id, waiter] of this.#pending) {
          waiter.reject(new Error(`воркер разбора ${i} упал`));
          this.#pending.delete(id);
        }
      };
      this.#workers.push(w);
    }
  }

  parse(source: string, lang: LangId): Promise<Def[]> {
    const id = ++this.#nextId;
    return new Promise<Def[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.broken = true;
        this.close();
        reject(new Error(`пул разбора не ответил за ${ParsePool.WATCHDOG_MS} мс`));
      }, ParsePool.WATCHDOG_MS);
      this.#pending.set(id, {
        resolve: (defs) => {
          clearTimeout(timer);
          resolve(defs);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#workers[id % this.#workers.length]!.postMessage({ id, source, lang });
    });
  }

  close(): void {
    for (const w of this.#workers) w.terminate();
    this.#workers.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Скан: сверки по code_files + постановка работ
// ---------------------------------------------------------------------------

function loadLedger(db: Database, repoId: string): Map<string, FileRow> {
  const rows = db
    .query("SELECT path, mtime_ms, size_bytes, file_hash FROM code_files WHERE repo_id = ?1")
    .all(repoId) as Array<{
    path: string;
    mtime_ms: number;
    size_bytes: number;
    file_hash: string;
  }>;
  const map = new Map<string, FileRow>();
  for (const r of rows) {
    map.set(r.path, {
      mtime_ms: Number(r.mtime_ms),
      size_bytes: Number(r.size_bytes),
      file_hash: r.file_hash,
    });
  }
  return map;
}

interface FileRow {
  readonly mtime_ms: number;
  readonly size_bytes: number;
  readonly file_hash: string;
}

/**
 * Скан репозитория. Пишет в code_files только безопасное: тачи (дефсы уже
 * соответствуют содержимому), L0-файлы (дефсов нет и не будет) и удаления.
 * Изменённые L1-файлы становятся работами очереди, их строки воркер запишет
 * после разбора. Работа, добившаяся до терминального состояния (dead),
 * дедупом новой не заменит — файл останется на переиндексацию следующей
 * своей правки, как у embed.
 */
export function scanCodeIndex(db: Database, opts: CodeIndexOptions, write = true): ScanStats {
  const now = opts.now ?? Date.now();
  const t0 = performance.now();
  const incremental = opts.incremental !== false;
  const useHash = (opts.freshness ?? "hash") === "hash";

  const paths = walkFiles(opts.root);
  const ledger = loadLedger(db, opts.repoId);
  const dirtyL1: Array<{ path: string; lang: string }> = [];
  const dirtyL0: Array<{ path: string; lang: string; mtimeMs: number; size: number; hash: string }> = [];
  const touched: Array<{ path: string; mtimeMs: number }> = [];
  const removed: string[] = [];
  let unchanged = 0;
  let excluded = 0;

  for (const path of paths) {
    const abs = join(opts.root, path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // исчез во время скана — уйдёт в removed следующего прогона
    }
    if (st.size > MAX_FILE_BYTES) {
      excluded++;
      continue;
    }
    const row = ledger.get(path);
    const mtimeMs = Math.round(st.mtimeMs);
    // Уровень 1: без чтения файла. В режиме мутации 2 ("mtime") размера в
    // сверке нет — это и есть «свежесть только по mtime».
    const level1 =
      opts.freshness === "mtime"
        ? row !== undefined && row.mtime_ms === mtimeMs
        : row !== undefined && row.mtime_ms === mtimeMs && row.size_bytes === st.size;
    if (incremental && level1) {
      unchanged++;
      continue;
    }
    // Уровень 1 не совпал. Без хеша файл сразу грязный; с хешем — читаем и
    // сверяем: тач дешевле разбора.
    let hash = "";
    if (useHash) {
      try {
        hash = wyhash(readFileSync(abs));
      } catch {
        continue;
      }
    }
    const lang = langOf(path);
    if (incremental && row !== undefined && hash !== "" && hash === row.file_hash) {
      touched.push({ path, mtimeMs });
      continue;
    }
    if (L1_LANGS.has(lang)) {
      dirtyL1.push({ path, lang });
    } else {
      // L0: записанная строка и есть весь индекс этого файла — писать можно сразу.
      dirtyL0.push({ path, lang, mtimeMs, size: st.size, hash });
    }
  }

  const seen = new Set(paths);
  for (const path of ledger.keys()) {
    if (!seen.has(path)) removed.push(path);
  }
  const scanMs = performance.now() - t0;

  let enqueued = 0;
  const t1 = performance.now();
  if (write && (touched.length > 0 || removed.length > 0 || dirtyL0.length > 0 || dirtyL1.length > 0)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const touch = db.query(
        "UPDATE code_files SET mtime_ms = ?3, indexed_at = ?4 WHERE repo_id = ?1 AND path = ?2",
      );
      for (const t of touched) touch.run(opts.repoId, t.path, t.mtimeMs, now);

      const upsertL0 = db.query(`
        INSERT INTO code_files (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (repo_id, path) DO UPDATE SET
          lang = excluded.lang, mtime_ms = excluded.mtime_ms,
          size_bytes = excluded.size_bytes, file_hash = excluded.file_hash,
          indexed_at = excluded.indexed_at`);
      for (const f of dirtyL0) {
        upsertL0.run(opts.repoId, f.path, f.lang, f.mtimeMs, f.size, f.hash, now);
      }

      const oldDefNames = db.query("SELECT name FROM code_defs WHERE repo_id = ?1 AND path = ?2");
      const delFile = db.query("DELETE FROM code_files WHERE repo_id = ?1 AND path = ?2");
      const delDefs = db.query("DELETE FROM code_defs WHERE repo_id = ?1 AND path = ?2");
      const delRef = db.query("DELETE FROM code_refs WHERE repo_id = ?1 AND name = ?2");
      const refsPresent = db.query("SELECT 1 FROM code_refs WHERE repo_id = ?1 LIMIT 1");
      const pruneRefs = refsPresent.get(opts.repoId) !== null;
      for (const path of removed) {
        if (pruneRefs) {
          for (const r of oldDefNames.all(opts.repoId, path) as Array<{ name: string }>) {
            delRef.run(opts.repoId, r.name);
          }
        }
        delDefs.run(opts.repoId, path);
        delFile.run(opts.repoId, path);
      }

      for (const f of dirtyL1) {
        const res = jobs.enqueue(db, CODE_INDEX_JOB_KIND, {
          entityId: f.path,
          scope: opts.repoId,
          priority: CODE_INDEX_PRIORITY,
          now,
        });
        if (res.inserted) enqueued++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return {
    files: paths.length,
    unchanged,
    touched: touched.length,
    dirty: dirtyL1.length + dirtyL0.length,
    enqueued,
    removed: removed.length,
    l0Written: dirtyL0.length,
    excluded,
    scanMs,
    enqueueMs: performance.now() - t1,
  };
}

// ---------------------------------------------------------------------------
// Разбор очереди
// ---------------------------------------------------------------------------

export interface DrainOptions {
  readonly holder?: string;
  readonly leaseMs?: number;
  readonly batch?: number;
  readonly now?: number;
  /**
   * Порог батча для включения пула разбора (по умолчанию
   * PARSE_POOL_MIN_FILES). 0 — пул выключен; для тестов — 1.
   */
  readonly poolMinFiles?: number;
}

function defaultHolder(): string {
  return `code-index-${process.pid}`;
}

type Plan =
  | {
      readonly kind: "write";
      readonly path: string;
      readonly lang: string;
      readonly defs: readonly Def[];
      readonly mtimeMs: number;
      readonly size: number;
      readonly hash: string;
    }
  | { readonly kind: "cleanup"; readonly path: string };

/**
 * Разбирает очередь `code_index`: claim батчем → разбор всех файлов батча →
 * одна транзакция записи → complete с ограждением по holder. Как в
 * `myc reindex`: чекпойнт — сама транзакция, недоделка остаётся в очереди.
 *
 * Батчи от PARSE_POOL_MIN_FILES работ разбираются пулом воркеров — полный
 * индекс репозитория это чистые сотни миллисекунд listDefs, и они делятся по
 * ядрам; инкрементальный прогон остаётся в одном потоке.
 *
 * Пустая выдача — не всегда «работы нет»: батч убитого воркера ещё под
 * арендой. Ждём ближайшее истечение, но не дольше двух аренд: дольше — сосед
 * жив и разгребает сам, дублировать его незачем.
 */
export async function drainCodeIndex(
  db: Database,
  opts: CodeIndexOptions,
  drain: DrainOptions = {},
): Promise<DrainStats> {
  const holder = drain.holder ?? defaultHolder();
  const leaseMs = drain.leaseMs ?? 60_000;
  const batch = drain.batch ?? 256;
  const poolMinFiles = drain.poolMinFiles ?? PARSE_POOL_MIN_FILES;

  const st = {
    claimed: 0,
    parsed: 0,
    written: 0,
    cleaned: 0,
    failed: 0,
    batches: 0,
    parseMs: 0,
    applyMs: 0,
    waitedMs: 0,
  };
  const t0 = performance.now();
  const earliestLease = db.query(
    "SELECT min(lease_expires) AS t FROM jobs WHERE kind = ?1 AND lease_expires > ?2 AND attempts < max_attempts",
  );

  // Пул заводится один раз на первый большой батч и живёт до конца очереди:
  // старт воркера — миллисекунды, на инкрементальном прогоне (десяток файлов)
  // он не окупил бы себя, на полном — окупает многократно.
  let pool: ParsePool | null = null;
  try {
    for (;;) {
      const now = opts.now ?? Date.now();
      let batchRows = jobs.claim(db, [CODE_INDEX_JOB_KIND], holder, { leaseMs, limit: batch, now });
      if (batchRows.length === 0) {
        const next = (earliestLease.get(CODE_INDEX_JOB_KIND, now) as { t: number | null }).t;
        if (next === null || st.waitedMs > 2 * leaseMs) break;
        const wait = Math.max(0, Number(next) - now) + 50;
        st.waitedMs += wait;
        await Bun.sleep(wait);
        batchRows = jobs.claim(db, [CODE_INDEX_JOB_KIND], holder, {
          leaseMs,
          limit: batch,
          now: opts.now ?? Date.now(),
        });
        if (batchRows.length === 0) continue;
      }

      if (
        pool === null &&
        batchRows.length >= poolMinFiles &&
        opts.parse === undefined &&
        (navigator.hardwareConcurrency ?? 2) > 2
      ) {
        pool = new ParsePool(Math.max(2, Math.min(8, (navigator.hardwareConcurrency ?? 2) - 2)));
      }

      await drainBatch(db, opts, { holder, now }, batchRows, st, pool);
      st.claimed += batchRows.length;
      if (pool !== null && pool.broken) pool = null; // сторож погасил — добираем в своём потоке
    }
  } finally {
    pool?.close();
  }

  return {
    claimed: st.claimed,
    parsed: st.parsed,
    written: st.written,
    cleaned: st.cleaned,
    failed: st.failed,
    batches: st.batches,
    parseMs: st.parseMs,
    applyMs: st.applyMs,
    waitedMs: st.waitedMs,
    drainMs: performance.now() - t0,
  };
}

/** Разбор и запись одного батча. Работы, чей разбор упал, уходят в fail. */
async function drainBatch(
  db: Database,
  opts: CodeIndexOptions,
  ctx: { holder: string; now: number },
  batchRows: jobs.JobRow[],
  st: {
    claimed: number;
    parsed: number;
    written: number;
    cleaned: number;
    failed: number;
    batches: number;
    parseMs: number;
    applyMs: number;
    waitedMs: number;
  },
  pool: ParsePool | null,
): Promise<void> {
  const holder = ctx.holder;
  const now = ctx.now;
  const parse = opts.parse ?? listDefs;
  const useHash = (opts.freshness ?? "hash") === "hash";

  const upsertFile = db.query(`
    INSERT INTO code_files (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (repo_id, path) DO UPDATE SET
      lang = excluded.lang, mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes, file_hash = excluded.file_hash,
      indexed_at = excluded.indexed_at`);
  const oldDefNames = db.query("SELECT name FROM code_defs WHERE repo_id = ?1 AND path = ?2");
  const delDefs = db.query("DELETE FROM code_defs WHERE repo_id = ?1 AND path = ?2");
  const insDef = db.query(
    "INSERT OR REPLACE INTO code_defs (repo_id, path, name, kind, span_start, span_end, exported) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
  );
  const delFile = db.query("DELETE FROM code_files WHERE repo_id = ?1 AND path = ?2");
  const delRef = db.query("DELETE FROM code_refs WHERE repo_id = ?1 AND name = ?2");

  st.batches++;
  const parseT0 = performance.now();

  // Проход 1: чтение файлов и РАЗОСЛАНЬЕ разбора в пул (не дожидаясь
  // результатов) — иначе await до следующей посылки свёл бы параллелизм на нет.
  const entries: Array<{
    job: jobs.JobRow;
    path: string;
    cleanup: boolean;
    lang: string;
    mtimeMs: number;
    size: number;
    hash: string;
    source: string;
    pending: Promise<Def[]> | null;
  }> = [];
  for (const job of batchRows) {
    const path = job.entity_id;
    if (path === null) {
      // Работа без файла не имеет смысла; ограждённый complete снимет её.
      jobs.complete(db, job.id, holder);
      continue;
    }
    const abs = join(opts.root, path);
    let buf: Buffer;
    let mtimeMs: number;
    let size: number;
    try {
      buf = readFileSync(abs);
      const st2 = statSync(abs);
      mtimeMs = Math.round(st2.mtimeMs);
      size = st2.size;
    } catch {
      entries.push({
        job, path, cleanup: true, lang: "", mtimeMs: 0, size: 0, hash: "", source: "", pending: null,
      });
      continue;
    }
    const lang = langOf(path);
    const hash = useHash ? wyhash(buf) : "";
    const isL1 = L1_LANGS.has(lang);
    const sourceText = isL1 ? buf.toString("utf8") : "";
    entries.push({
      job,
      path,
      cleanup: false,
      lang,
      mtimeMs,
      size,
      hash,
      source: sourceText,
      pending: isL1 && pool !== null ? pool.parse(sourceText, lang as LangId) : null,
    });
  }

  // Проход 2: сбор результатов в порядке работ. Отказ пула — не отказ работы:
  // разбор повторяется в своём потоке; и только собственно ошибка разбора
  // уводит работу в fail очереди.
  const plans: Array<{ job: jobs.JobRow; plan: Plan }> = [];
  for (const e of entries) {
    if (e.cleanup) {
      plans.push({ job: e.job, plan: { kind: "cleanup", path: e.path } });
      continue;
    }
    if (!L1_LANGS.has(e.lang)) {
      // L0 в очереди оказаться не должен; если попал — пишем реестр без дефсов.
      plans.push({ job: e.job, plan: { kind: "write", path: e.path, lang: e.lang, defs: [], mtimeMs: e.mtimeMs, size: e.size, hash: e.hash } });
      continue;
    }
    try {
      let defs: Def[];
      if (e.pending !== null) {
        try {
          defs = await e.pending;
        } catch {
          // Пул не ответил (сторож) или воркер умер — файл не теряем.
          defs = parse(e.source, e.lang as LangId);
        }
      } else {
        defs = parse(e.source, e.lang as LangId);
      }
      st.parsed++;
      plans.push({ job: e.job, plan: { kind: "write", path: e.path, lang: e.lang, defs, mtimeMs: e.mtimeMs, size: e.size, hash: e.hash } });
    } catch (err) {
      st.failed++;
      jobs.fail(db, e.job.id, `разбор ${e.path}: ${err instanceof Error ? err.message : String(err)}`, {
        holder,
        now,
      });
    }
  }
  st.parseMs += performance.now() - parseT0;

  const applyT0 = performance.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const refsPresent = db.query("SELECT 1 FROM code_refs WHERE repo_id = ?1 LIMIT 1");
    const pruneRefs = refsPresent.get(opts.repoId) !== null;
    for (const { job, plan } of plans) {
      if (plan.kind === "cleanup") {
        if (pruneRefs) {
          for (const r of oldDefNames.all(opts.repoId, plan.path) as Array<{ name: string }>) {
            delRef.run(opts.repoId, r.name);
          }
        }
        delDefs.run(opts.repoId, plan.path);
        delFile.run(opts.repoId, plan.path);
        st.cleaned++;
      } else {
        // Инвалидация fan_in: имена до и после — набор изменившихся символов.
        if (pruneRefs) {
          const names = new Set<string>();
          for (const r of oldDefNames.all(opts.repoId, plan.path) as Array<{ name: string }>) {
            names.add(r.name);
          }
          for (const d of plan.defs) names.add(d.name);
          for (const name of names) delRef.run(opts.repoId, name);
        }
        upsertFile.run(opts.repoId, plan.path, plan.lang, plan.mtimeMs, plan.size, plan.hash, now);
        delDefs.run(opts.repoId, plan.path);
        for (const d of plan.defs) {
          insDef.run(opts.repoId, plan.path, d.name, d.kind, d.startLine, d.endLine);
        }
        st.written++;
      }
      jobs.complete(db, job.id, holder);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  st.applyMs += performance.now() - applyT0;
}

// ---------------------------------------------------------------------------
// Полный прогон
// ---------------------------------------------------------------------------

/** Скан + разбор очереди одним вызовом. Для CLI, тестов и замера. */
export async function runCodeIndex(
  db: Database,
  opts: CodeIndexOptions,
  drain: DrainOptions = {},
): Promise<IndexRunResult> {
  const scan = scanCodeIndex(db, opts);
  const drainStats = await drainCodeIndex(db, opts, drain);
  return { scan, drain: drainStats };
}
