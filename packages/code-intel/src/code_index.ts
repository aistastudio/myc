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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { jobs } from "@myc/store-sqlite";
import {
  loadLangs,
  treeSitterDirs,
  type Def,
  type LangId,
  type TreeSitterDirs,
} from "./symbols.ts";
import { listDefsAndRefs, type ParsedFile, type Ref } from "./refs.ts";
import { PARSE_WORKER_IN_BINARY } from "./parse_worker_entry.ts";
import { L1_LANGS, langOf, walkFiles } from "./langs.ts";
import { GRAMMAR_BY_LANG, type MissingGrammar, missingGrammars } from "./grammars.ts";

// Языки, обход дерева и список пропускаемых каталогов живут в `./langs.ts`:
// их же читает `select.ts`, которому граф модулей индекса не по карману.
export { L1_LANGS, LANG_BY_EXT, SKIP_DIRS, langOf, walkFiles } from "./langs.ts";

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

/**
 * С какого размера батча разбор идёт в пул воркеров. Ниже порога пул не
 * окупает собственного старта: 10 изменённых файлов разбираются за
 * единицы миллисекунд в этом же потоке.
 */
export const PARSE_POOL_MIN_FILES = 64;

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
  /**
   * Разбор файла; по умолчанию `listDefsAndRefs` — определения И ссылки за
   * один проход дерева. Подмена — для тестов и замеров.
   *
   * Ссылки попали сюда же, а не во вторую функцию, потому что цена — это
   * ПОСТРОЕНИЕ ДЕРЕВА (7.5 мс на 64 КБ против долей миллисекунды на обход):
   * второй вызов удвоил бы фоновую индексацию, купив ровно ничего.
   */
  readonly parse?: (source: string, lang: LangId) => ParsedFile;
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

/** Нехватка одной грамматики: что не скачано, для каких языков, сколько файлов. */
export interface MissingGrammarStat {
  readonly grammar: string;
  readonly langs: readonly string[];
  /** Вес .wasm — цена, которую называет отказ, а не только его причина. */
  readonly bytes: number;
  /** Сколько файлов пропущено из-за неё в этом прогоне. */
  readonly files: number;
}

export interface DrainStats {
  readonly claimed: number;
  /** Вызовов разбора (инкрементальность видна здесь). */
  readonly parsed: number;
  /**
   * Ссылок записано этим прогоном. Отдельно от `parsed`, потому что отвечает
   * на другой вопрос: разбор мог пройти, а ссылок не дать — и «файлов
   * разобрано 416» это бы не показало.
   */
  readonly refs: number;
  /** Файлов, чьи строки записаны (дефсы и/или code_files). */
  readonly written: number;
  /** Файлов, исчезнувших к моменту разбора: строки убраны. */
  readonly cleaned: number;
  readonly failed: number;
  readonly batches: number;
  /**
   * Файлов, разобранных ПУЛОМ (остальные — в своём потоке). Число здесь не
   * ради отчёта: пул, который молча не завёлся, от пула, который отработал,
   * иначе неотличим — а именно так он и был сломан в бинаре.
   */
  readonly pooled: number;
  /**
   * Файлы, ПРОПУЩЕННЫЕ из-за отсутствия грамматики их языка. Отдельное число,
   * а не слагаемое в `parsed`: пропуск — это отсутствие символов, и он обязан
   * быть виден отдельно от разбора, иначе индекс без половины языков
   * неотличим от полного (И2).
   */
  readonly skipped: number;
  /**
   * Каких грамматик не хватило и скольким файлам. Пустой список — все языки
   * батча разобраны. Непустой — команда обязана НАЗВАТЬ язык и способ его
   * добыть; молчаливого пропуска файлов в этом продукте нет.
   */
  readonly missing: readonly MissingGrammarStat[];
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

function wyhash(data: Uint8Array): string {
  return `wy:${Bun.hash(data).toString(16)}`;
}

/** Имя грамматики, обслуживающей язык — ключ, по которому копится нехватка. */
function grammarOf(lang: string): string {
  return GRAMMAR_BY_LANG[lang as LangId] ?? lang;
}

// ---------------------------------------------------------------------------
// Пул разбора
// ---------------------------------------------------------------------------

/**
 * МУТАЦИИ ПРИЁМКИ пула — единственный способ дотянуться до этой развилки в
 * СОБРАННОМ БИНАРЕ: флага командной строки у неё нет, а тест обязан проверять
 * бинарь, а не исходники (`bun test` видит node_modules, бинарь — нет).
 *
 *   entry-from-source  вход воркера снова берётся из `import.meta.url` —
 *                      резолвинг МОДУЛЯ возвращается за границу потока;
 *   resolve-in-worker  каталоги wasm воркеру не передаются — резолвинг
 *                      КАТАЛОГОВ возвращается за границу потока.
 *
 * Обе роняют бинарь и обе обязаны его ронять: это ровно те два способа, какими
 * пул был сломан до сих пор.
 */
export type PoolMutation = "none" | "entry-from-source" | "resolve-in-worker";

export const POOL_MUTATION_ENV = "MYC_PARSE_POOL_MUTATION";

function poolMutation(): PoolMutation {
  const v = process.env[POOL_MUTATION_ENV];
  return v === "entry-from-source" || v === "resolve-in-worker" ? v : "none";
}

/** Окружение воркера: пути, которые главный поток УЖЕ нашёл. */
function workerEnv(dirs: TreeSitterDirs, mutation: PoolMutation): Record<string, string | undefined> {
  const env = { ...process.env } as Record<string, string | undefined>;
  if (mutation === "resolve-in-worker") {
    // Мутация обязана быть мутацией и у того, кто эти переменные выставил
    // руками, — иначе она молча превратилась бы в пустую проверку.
    delete env.MYC_TREE_SITTER_DIR;
    delete env.MYC_TREE_SITTER_GRAMMAR_DIR;
    return env;
  }
  env.MYC_TREE_SITTER_DIR = dirs.runtime;
  env.MYC_TREE_SITTER_GRAMMAR_DIR = dirs.grammar;
  return env;
}

/**
 * Модуль воркера разбора: то, что получит `new Worker`. null — воркера в этой
 * сборке нет, и пул заводить не на чем.
 *
 * Порядок проверок не косметический. Вшитый в bunfs бандл идёт ПЕРВЫМ: в
 * собранном бинаре `import.meta.url` указывает на .ts сборочной машины, и на
 * ней самой такой воркер запустится — а потом упадёт на первом же импорте,
 * которого standalone-рантайм не резолвит. Развилка обязана решаться по тому,
 * что в сборке ЕСТЬ, а не по тому, что случайно лежит на диске.
 */
export function parseWorkerEntry(mutation: PoolMutation = poolMutation()): string | null {
  const fromSource = new URL("./code_index_worker.ts", import.meta.url).href;
  if (mutation === "entry-from-source") return fromSource;
  if (existsSync(PARSE_WORKER_IN_BINARY)) return PARSE_WORKER_IN_BINARY;
  // Бинарь без вшитого воркера — не место для догадок: разбор идёт в своём
  // потоке, и это честнее восьми воркеров, падающих по очереди.
  return Bun.main.startsWith("/$bunfs/") ? null : fromSource;
}

/**
 * Каталоги wasm для воркеров — или null, если их нет и у главного потока.
 *
 * Молчаливое null здесь не прячет беду: без грамматик тот же `loadLangs`
 * уронит батч в главном потоке и назовёт причину. Пул просто не заводится на
 * том, чего нет.
 */
function safeTreeSitterDirs(): TreeSitterDirs | null {
  try {
    return treeSitterDirs();
  } catch {
    return null;
  }
}

/**
 * Пул воркеров разбора (`listDefsAndRefs`). Один воркер на свободное ядро
 * (потолок 8), живёт
 * ровно столько, сколько идёт большой прогон. Подменный `parse` из опций в
 * воркер не уносится — функция не переходит границу потока; пул включается
 * только для разбора по умолчанию.
 *
 * НИЧТО НЕ РЕЗОЛВИТСЯ ЗА ГРАНИЦЕЙ ПОТОКА. Воркер получает готовыми ОБА пути —
 * модуль (`entry`) и каталоги wasm (`dirs`, через окружение). Так это устроено
 * не из аккуратности: в собранном бинаре у воркера нет ни node_modules, ни
 * каталога, относительно которого искал главный поток, и любой резолвинг там
 * кончается стеком резолвера. См. `parse_worker_entry.ts` — там же замер.
 *
 * ПУЛ — ОПТИМИЗАЦИЯ, НО НЕ ВСЯКИЙ ЕГО ОТКАЗ ОДИНАКОВ.
 *   - сторож (POOL_WATCHDOG_MS) не дождался ответа: под нагрузкой CI воркер
 *     стартует дольше обычного, пул гасится, файл разбирается в своём потоке,
 *     команда об этом молчит — это НЕ дефект;
 *   - воркер УПАЛ (`onerror`): его окружение сломано, и оно сломано у всех
 *     восьми — упадут и они. Работа доделывается в своём потоке (терять файлы
 *     не за что), но причина запоминается и уходит наверх отказом команды.
 *     Тихий неуспех тут хуже громкого: индекс, собранный в один поток вместо
 *     восьми, — полбеды, а сборка, в которой воркера нет вовсе, — беда.
 *
 * ЦЕНА СТАРТА ВЫРОСЛА ВМЕСТЕ С ПЕРЕХОДОМ НА TREE-SITTER, и на восьми воркерах
 * пул на этом репозитории перестал окупаться: 778 мс против 648 мс без пула
 * (400 L1-файлов, машина занята). Каждый воркер теперь платит импорт
 * web-tree-sitter, Parser.init и компиляцию своих грамматик. Размер пула тут
 * НЕ перенастраивается: замер сделан на загруженной машине, а по такому
 * замеру менять формулу нельзя — это отдельная задача memory-eyqdv56a95s5 с
 * перепроверкой на тихой машине. Корректность от этого не зависит.
 */
class ParsePool {
  static readonly WATCHDOG_MS = 2_000;

  readonly #workers: Worker[] = [];
  readonly #pending = new Map<
    number,
    { resolve: (parsed: ParsedFile) => void; reject: (e: Error) => void }
  >();
  #nextId = 0;
  /** true — пул погашен: сторожем или падением воркера. */
  broken = false;
  /**
   * Причина, если пул погас из-за ПАДЕНИЯ воркера, а не по сторожу. null у
   * живого пула и у погашенного сторожем — разница между «медленно» и
   * «сломано» и есть разница между молчанием и отказом команды.
   */
  crash: string | null = null;

  constructor(size: number, entry: string, dirs: TreeSitterDirs, mutation: PoolMutation) {
    const env = workerEnv(dirs, mutation);
    for (let i = 0; i < size; i++) {
      const w = new Worker(entry, { env } as WorkerOptions);
      w.onmessage = (
        e: MessageEvent<{ id: number; defs?: Def[]; refs?: Ref[]; error?: string }>,
      ) => {
        const waiter = this.#pending.get(e.data.id);
        if (waiter === undefined) return;
        this.#pending.delete(e.data.id);
        if (e.data.error !== undefined) waiter.reject(new Error(e.data.error));
        else waiter.resolve({ defs: e.data.defs ?? [], refs: e.data.refs ?? [] });
      };
      w.onerror = (e: unknown) => {
        // Сообщение воркера — единственное, что объясняет причину: без него
        // «воркер разбора 7 упал» не отличает сломанный резолвинг от OOM.
        const why = (e as { message?: string } | null)?.message ?? "без сообщения";
        this.crash ??= `воркер разбора ${i} упал: ${why}`;
        const reason = new Error(this.crash);
        this.broken = true;
        // Гасим ВЕСЬ пул: окружение у восьми воркеров одно, и остальные
        // повторят это же падение на своих файлах.
        this.close();
        for (const [id, waiter] of [...this.#pending]) {
          this.#pending.delete(id);
          waiter.reject(reason);
        }
      };
      this.#workers.push(w);
    }
  }

  parse(source: string, lang: LangId): Promise<ParsedFile> {
    // Пул уже погас: посылать некому. Раньше здесь считался остаток по длине
    // пустого массива, и `#workers[NaN]!` падал TypeError прямо в разборе.
    if (this.broken || this.#workers.length === 0) {
      return Promise.reject(new Error(this.crash ?? "пул разбора погашен"));
    }
    const id = ++this.#nextId;
    return new Promise<ParsedFile>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.broken = true;
        this.close();
        reject(new Error(`пул разбора не ответил за ${ParsePool.WATCHDOG_MS} мс`));
      }, ParsePool.WATCHDOG_MS);
      this.#pending.set(id, {
        resolve: (parsed) => {
          clearTimeout(timer);
          resolve(parsed);
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

      const delFile = db.query("DELETE FROM code_files WHERE repo_id = ?1 AND path = ?2");
      const delDefs = db.query("DELETE FROM code_defs WHERE repo_id = ?1 AND path = ?2");
      // Ссылки исчезнувшего файла уходят вместе с его определениями. Забыть
      // их здесь значило бы оставить `callers` строки на файл, которого нет:
      // ссылка живёт в файле, а не в символе, и пережить его не может.
      const delRefSites = db.query("DELETE FROM code_ref_sites WHERE repo_id = ?1 AND path = ?2");
      for (const path of removed) {
        delDefs.run(opts.repoId, path);
        delRefSites.run(opts.repoId, path);
        delFile.run(opts.repoId, path);
      }
      if (removed.length > 0) invalidateRefs(db, opts.repoId);

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

/**
 * ИНВАЛИДАЦИЯ `code_refs` — ПО РЕПОЗИТОРИЮ, а не по именам изменённого файла.
 *
 * Так было не всегда: раньше снимались строки символов, ОБЪЯВЛЕННЫХ в
 * изменившемся файле. Это неверно ровно там, где fan_in и живёт: счёт
 * `\bNAME\b` меняется от правки ЛЮБОГО файла, где имя УПОМЯНУТО, а
 * упоминание — не объявление. Файл, добавивший десять вызовов `alpha`, не
 * объявляет `alpha` и старую строку кеша не трогал — читатель получал число,
 * которое уже не соответствовало ни одному состоянию дерева.
 *
 * Здесь именно КЕШ, а не данные: строка появляется, только когда кто-то
 * спросил fan_in, и пересчитывается по требованию (`read.ts`, ~90 мс на 400
 * L1-файлах). Снести его целиком дешевле, чем хранить обратный индекс
 * «имя → файлы, где встречается», который пришлось бы поддерживать при
 * каждом разборе.
 */
function invalidateRefs(db: Database, repoId: string): void {
  db.query("DELETE FROM code_refs WHERE repo_id = ?1").run(repoId);
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
      readonly refs: readonly Ref[];
      readonly mtimeMs: number;
      readonly size: number;
      readonly hash: string;
    }
  | { readonly kind: "cleanup"; readonly path: string }
  /**
   * Файл L1, для которого нет грамматики: работа закрывается, но в базу не
   * пишется НИЧЕГО. Ни строки реестра (иначе скан признает файл разобранным
   * и после загрузки грамматики к нему не вернётся), ни удаления старых
   * дефсов (иначе очищенный кеш стирал бы уже собранный индекс).
   */
  | { readonly kind: "skip" };

/**
 * Разбирает очередь `code_index`: claim батчем → разбор всех файлов батча →
 * одна транзакция записи → complete с ограждением по holder. Как в
 * `myc reindex`: чекпойнт — сама транзакция, недоделка остаётся в очереди.
 *
 * Батчи от PARSE_POOL_MIN_FILES работ разбираются пулом воркеров — полный
 * индекс репозитория это чистые сотни миллисекунд разбора, и они делятся по
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
    refs: 0,
    written: 0,
    cleaned: 0,
    failed: 0,
    batches: 0,
    pooled: 0,
    skipped: 0,
    /**
     * Копится по всему прогону, а не по батчу: пользователь спрашивает «чего
     * не хватает этому репозиторию», а не «чего не хватило работам 257-512».
     */
    missing: new Map<string, { grammar: string; langs: Set<string>; bytes: number; files: number }>(),
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
  /** Причина падения воркера — она же причина отказа команды в самом конце. */
  let poolCrash: string | null = null;
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
        poolCrash === null &&
        batchRows.length >= poolMinFiles &&
        opts.parse === undefined &&
        (navigator.hardwareConcurrency ?? 2) > 2
      ) {
        // Воркер и каталоги wasm ищутся ЗДЕСЬ, в главном потоке, и уезжают в
        // воркер готовыми. Не нашлись — пула просто нет: разбор в своём потоке
        // медленнее, но он есть, а восемь падающих воркеров — это ноль.
        const entry = parseWorkerEntry();
        const dirs = entry === null ? null : safeTreeSitterDirs();
        if (entry !== null && dirs !== null) {
          pool = new ParsePool(
            Math.max(2, Math.min(8, (navigator.hardwareConcurrency ?? 2) - 2)),
            entry,
            dirs,
            poolMutation(),
          );
        }
      }

      await drainBatch(db, opts, { holder, now }, batchRows, st, pool);
      st.claimed += batchRows.length;
      if (pool !== null && pool.broken) {
        // Сторож погасил — добираем в своём потоке молча. Воркер УПАЛ —
        // добираем так же, но команда об этом скажет (см. ниже).
        poolCrash ??= pool.crash;
        pool = null;
      }
    }
  } finally {
    pool?.close();
  }

  // Очередь разобрана и записана — и только теперь про сломанный пул. Порядок
  // именно такой: файлы не теряются из-за того, что сборка неисправна, но и
  // «готово» про неисправную сборку не говорится. Образец рядом: `drainBatch`
  // уводит работу в fail очереди и не притворяется.
  if (poolCrash !== null) {
    throw new Error(
      `${poolCrash}. Очередь разобрана в один поток, индекс на месте — но пул разбора ` +
        "в этой сборке нерабочий: воркер обязан находить и модуль, и грамматики " +
        "внутри бинаря (см. packages/code-intel/src/parse_worker_entry.ts)",
    );
  }

  return {
    claimed: st.claimed,
    parsed: st.parsed,
    refs: st.refs,
    written: st.written,
    cleaned: st.cleaned,
    failed: st.failed,
    batches: st.batches,
    pooled: st.pooled,
    skipped: st.skipped,
    missing: [...st.missing.values()].map((m) => ({
      grammar: m.grammar,
      langs: [...m.langs].sort(),
      bytes: m.bytes,
      files: m.files,
    })),
    parseMs: st.parseMs,
    applyMs: st.applyMs,
    waitedMs: st.waitedMs,
    drainMs: performance.now() - t0,
  };
}

/** Ответ пула, уже без отказа: промис от `pool.parse` не остаётся висеть. */
type PoolReply = { readonly ok: true; readonly parsed: ParsedFile } | { readonly ok: false };

function settle(p: Promise<ParsedFile>): Promise<PoolReply> {
  return p.then(
    (parsed) => ({ ok: true, parsed }) as PoolReply,
    () => ({ ok: false }) as PoolReply,
  );
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
    refs: number;
    written: number;
    cleaned: number;
    failed: number;
    batches: number;
    pooled: number;
    skipped: number;
    missing: Map<string, { grammar: string; langs: Set<string>; bytes: number; files: number }>;
    parseMs: number;
    applyMs: number;
    waitedMs: number;
  },
  pool: ParsePool | null,
): Promise<void> {
  const holder = ctx.holder;
  const now = ctx.now;
  const parse = opts.parse ?? listDefsAndRefs;
  const useHash = (opts.freshness ?? "hash") === "hash";

  const upsertFile = db.query(`
    INSERT INTO code_files (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (repo_id, path) DO UPDATE SET
      lang = excluded.lang, mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes, file_hash = excluded.file_hash,
      indexed_at = excluded.indexed_at`);
  const delDefs = db.query("DELETE FROM code_defs WHERE repo_id = ?1 AND path = ?2");
  const insDef = db.query(
    "INSERT OR REPLACE INTO code_defs (repo_id, path, name, kind, span_start, span_end, exported) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
  );
  const delFile = db.query("DELETE FROM code_files WHERE repo_id = ?1 AND path = ?2");
  // Ссылки файла заменяются ЦЕЛИКОМ, как и определения: частичное обновление
  // спанов нечем проверить, а DELETE идёт по префиксу первичного ключа
  // (repo_id, path) — ровно поэтому ключ так и начинается.
  const delRefs = db.query("DELETE FROM code_ref_sites WHERE repo_id = ?1 AND path = ?2");
  const insRef = db.query(
    "INSERT OR REPLACE INTO code_ref_sites (repo_id, path, line, name, kind, from_name, from_start) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  );

  st.batches++;
  const parseT0 = performance.now();

  /**
   * ЧТО ДЕЛАЕТ ИНДЕКСАЦИЯ, КОГДА ГРАММАТИКИ НЕТ: ПРОПУСКАЕТ ФАЙЛ И НАЗЫВАЕТ
   * ЯЗЫК. Не качает.
   *
   * Второй вариант — скачать при первой встрече языка — удобнее ровно один
   * раз и хуже всегда. Эта команда поднимается ФОНОМ, отсоединённым процессом
   * из чужого вызова (`drain.ts`, шаг `code_index`): сеть здесь — это сеть,
   * которой пользователь не просил, в момент, когда он набрал `myc ready`.
   * Продукт обещает не ходить в сеть на рабочем пути и держит это обещание
   * даже для модели эмбеддингов, без которой поиск деградирует до BM25:
   * `myc models fetch` зовёт человек. Второй довод — воспроизводимость:
   * индекс, содержимое которого зависит от того, была ли сеть, нельзя
   * сравнить с индексом соседа.
   *
   * Пропуск НЕ ТИХИЙ и не разрушительный: строка реестра для такого файла НЕ
   * ПИШЕТСЯ вовсе. Из этого следует ровно то, что нужно: файл остаётся
   * «невиданным», следующий скан снова признает его грязным и снова поставит
   * в очередь — то есть после `myc code fetch py` ближайшая индексация даст
   * символы без единого дополнительного флага. Уже найденные когда-то
   * символы при этом не стираются: их строка реестра осталась с прошлого
   * прогона, и скан считает файл неизменившимся.
   */
  const grammarKnown = new Map<string, boolean>();
  const noGrammar = (lang: string): boolean => {
    let known = grammarKnown.get(lang);
    if (known === undefined) {
      const miss: MissingGrammar[] = missingGrammars([lang as LangId]);
      known = miss.length > 0;
      grammarKnown.set(lang, known);
      for (const m of miss) {
        const acc = st.missing.get(m.grammar) ?? {
          grammar: m.grammar,
          langs: new Set<string>(),
          bytes: m.bytes,
          files: 0,
        };
        for (const l of m.langs) acc.langs.add(l);
        st.missing.set(m.grammar, acc);
      }
    }
    return known;
  };

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
    /** Язык L1, но грамматики нет: файл не разбирается и в реестр не пишется. */
    skip: boolean;
    pending: Promise<PoolReply> | null;
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
        job, path, cleanup: true, lang: "", mtimeMs: 0, size: 0, hash: "", source: "",
        skip: false, pending: null,
      });
      continue;
    }
    const lang = langOf(path);
    const hash = useHash ? wyhash(buf) : "";
    // Подмена разбора (тесты, замер) грамматики не спрашивает: она и есть
    // разбор. Спрашивать её значило бы гасить стенды на машине без кеша.
    const skip = L1_LANGS.has(lang) && opts.parse === undefined && noGrammar(lang);
    const isL1 = L1_LANGS.has(lang) && !skip;
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
      skip,
      // Обработчик вешается ЗДЕСЬ, в момент посылки, а не там, где результат
      // понадобится. Иначе падение воркера отклоняет три сотни промисов, до
      // которых очередь ожидания ещё не дошла, — и Bun убивает процесс
      // необработанным отказом, называя случайный номер воркера. Это и был
      // тот самый «exit=1, упал воркер 7» с плавающим номером.
      pending: isL1 && pool !== null ? settle(pool.parse(sourceText, lang as LangId)) : null,
    });
  }

  // Грамматики языков батча. Разбор синхронен, а `.wasm` грузится
  // промисом — ждать его здесь, ПОСЛЕ рассылки в пул: воркеры уже разбирают
  // со своими копиями, и загрузка главного потока идёт с ними параллельно, не
  // добавляя латентности. Главному потоку она нужна всё равно — он разбирает
  // сам, когда пула нет (батч меньше PARSE_POOL_MIN_FILES) или когда пул
  // погас по сторожу. Загрузка идемпотентна: платится один раз за процесс.
  const batchLangs = new Set<LangId>();
  for (const e of entries) {
    if (!e.cleanup && !e.skip && L1_LANGS.has(e.lang)) batchLangs.add(e.lang as LangId);
  }
  if (batchLangs.size > 0) await loadLangs(batchLangs);

  // Проход 2: сбор результатов в порядке работ. Отказ пула — не отказ работы:
  // разбор повторяется в своём потоке; и только собственно ошибка разбора
  // уводит работу в fail очереди.
  const plans: Array<{ job: jobs.JobRow; plan: Plan }> = [];
  for (const e of entries) {
    if (e.cleanup) {
      plans.push({ job: e.job, plan: { kind: "cleanup", path: e.path } });
      continue;
    }
    if (e.skip) {
      // Работа закрывается (иначе она вернётся в этом же прогоне и так по
      // кругу), но строка реестра НЕ пишется — см. `noGrammar` выше.
      st.skipped++;
      const acc = st.missing.get(grammarOf(e.lang));
      if (acc !== undefined) acc.files++;
      plans.push({ job: e.job, plan: { kind: "skip" } });
      continue;
    }
    if (!L1_LANGS.has(e.lang)) {
      // L0 в очереди оказаться не должен; если попал — пишем реестр без дефсов.
      plans.push({ job: e.job, plan: { kind: "write", path: e.path, lang: e.lang, defs: [], refs: [], mtimeMs: e.mtimeMs, size: e.size, hash: e.hash } });
      continue;
    }
    try {
      let parsed: ParsedFile;
      if (e.pending !== null) {
        const reply = await e.pending;
        if (reply.ok) {
          parsed = reply.parsed;
          st.pooled++;
        } else {
          // Пул не ответил (сторож) или воркер умер — файл не теряем.
          parsed = parse(e.source, e.lang as LangId);
        }
      } else {
        parsed = parse(e.source, e.lang as LangId);
      }
      st.parsed++;
      st.refs += parsed.refs.length;
      plans.push({ job: e.job, plan: { kind: "write", path: e.path, lang: e.lang, defs: parsed.defs, refs: parsed.refs, mtimeMs: e.mtimeMs, size: e.size, hash: e.hash } });
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
    for (const { job, plan } of plans) {
      if (plan.kind === "skip") {
        jobs.complete(db, job.id, holder);
        continue;
      }
      if (plan.kind === "cleanup") {
        delDefs.run(opts.repoId, plan.path);
        delRefs.run(opts.repoId, plan.path);
        delFile.run(opts.repoId, plan.path);
        st.cleaned++;
      } else {
        upsertFile.run(opts.repoId, plan.path, plan.lang, plan.mtimeMs, plan.size, plan.hash, now);
        delDefs.run(opts.repoId, plan.path);
        delRefs.run(opts.repoId, plan.path);
        for (const d of plan.defs) {
          insDef.run(opts.repoId, plan.path, d.name, d.kind, d.startLine, d.endLine);
        }
        for (const r of plan.refs) {
          insRef.run(opts.repoId, plan.path, r.line, r.name, r.kind, r.from, r.fromStart);
        }
        st.written++;
      }
      jobs.complete(db, job.id, holder);
    }
    if (plans.length > 0) invalidateRefs(db, opts.repoId);
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
