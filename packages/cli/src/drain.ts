/**
 * Дренаж хвоста очереди `jobs` из жизненного цикла CLI-команды — механизм,
 * которого не хватало решению S8 («хвост очереди подхватывает следующий вызов
 * CLI; `myc worker` — опция, не требование», §12.2 D28). До этого модуля
 * обещание не было реализовано ни в одной половине: 227 узлов лежали без
 * векторов, absorb не выполнялся НИКОГДА (S56), и находилось это вопросом в
 * реальной работе, а не тестом.
 *
 * ДВА КЛАССА РАБОТ — ДВА ПУТИ (замеры из постановки задачи):
 *
 *  * ДЕШЁВЫЕ (`absorb` ~8 мс без векторов, `compact` — один PASSIVE
 *    checkpoint) разбираются ИНЛАЙН, но по БЮДЖЕТУ ВРЕМЕНИ, а не «до конца
 *    очереди»: взял работу, выполнил, проверил остаток бюджета, вышел.
 *    Бюджет по умолчанию — 50 мс на вызов (§12.2: «не более 50 мс за раз и
 *    только если очередь непуста»). Проверка остатка — не оптимизация, а
 *    инвариант И1: её удаление (мутация 1 в drain.test.ts) обязано краснеть.
 *  * ДОРОГОЙ `embed` (40-80 мс на узел даже с тёплым эмбеддером; 227 векторов
 *    = 40,4 с) инлайн НЕ разбирается НИКОГДА. Вместо этого поднимается
 *    отсоединённый процесс `myc reindex` — тот же приём, что spawnEmbedDaemon
 *    в commands/embedd.ts: spawn без await, detached + unref, вызвавшая
 *    команда не ждёт ничего. Воркер КОНЕЧЕН (разгрёб очередь — вышел), поэтому
 *    ему не нужен ни TTL демона, ни сторож db_gone: второй утечки, как у
 *    переживавшего воркспейс демона, здесь нет по устройству.
 *
 * ОЧЕРЕДЬ — ТОЛЬКО ЧЕРЕЗ `jobs` из @myc/store-sqlite (стык S7): claim с
 * арендой (захват атомарен, проверен гонкой 8 процессов в jobs.test.ts),
 * complete/fail ограждены holder. Свой захват здесь не пишется — ровно на
 * паре «SELECT кандидатов, потом UPDATE» этот репозиторий дважды терял
 * записи молча (S38, S40).
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Классов `distill` и `anchor_check` здесь НЕТ исполнителей:
 * packages/anchors и packages/distiller — заглушки, их работы в очереди
 * лежат незабранными (наблюдаемо через jobs.stats, не молча). Появится
 * исполнитель — добавится строка в INLINE_JOB_KINDS и executor.
 *
 * БЕЗОПАСНОСТЬ ВЫЗОВА. Дренаж — фон: он не имеет права уронить или заметно
 * задержать команду, ради которой случился. Под команду, уже открывшую базу
 * БЕЗ расширений (`ready`, `show`), vec0 для этого соединения недоступен по
 * правилу движка (setCustomSQLite до первого `new Database`) — openDriver
 * честно вернёт vec0Reason, absorb уйдёт в lexical-режим (его штатная громкая
 * деградация, И2), и это не ошибка дренажа. busy_timeout укорочен до 250 мс:
 * ждать чужой write-lock секундами фон не будет никогда.
 *
 * ПЕРЕМЕННЫЕ (тесты): MYC_DRAIN=0 — выключить дренаж; MYC_DRAIN_BUDGET_MS —
 * бюджет; MYC_DRAIN_FAKE=1 — исполнитель-заглушка (та же механика, что
 * MYC_EMBED_FAKE в reindex.ts): работа не выполняется, а пишется строкой в
 * MYC_DRAIN_FAKE_LOG, чтобы многопроцессный тест считал выполнения по
 * процессам; MYC_DRAIN_FAKE_DELAY_MS — пауза на работу (замер бюджета).
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_ABSORB_THRESHOLDS,
  generateId,
  HlcClock,
  unpackHlc,
} from "@myc/core";
import {
  Claims,
  GraphStore,
  jobs,
  Q,
  runWalCheckpointJob,
} from "@myc/store-sqlite";
import type { Globals } from "./registry.ts";
import { absorbOne, type Session } from "./commands/absorb.ts";
import { modelLikelyPresent } from "./commands/retrieve.ts";
import {
  DEFAULT_READY_WEIGHTS,
  openDriver,
  parseWorkspaceToml,
  type CliDriver,
  type StoreHandle,
} from "./commands/store.ts";

// ---------------------------------------------------------------------------
// Константы и окружение
// ---------------------------------------------------------------------------

/**
 * Бюджет инлайн-разбора на один вызов CLI — 50 мс (§12.2 D28: «не более 50 мс
 * за раз и только если очередь непуста»). Проверяется ПЕРЕД каждым захватом:
 * одна работа может перешагнуть остаток (это ~8 мс), серия — никогда.
 */
export const DEFAULT_DRAIN_BUDGET_MS = 50;

/**
 * Классы, разбираемые инлайн. `embed` сюда НЕ ВХОДИТ по стоимости (40-80 мс
 * на узел против всего бюджета в 50) — это и есть мутация 2 при сдаче.
 * Порядок не важен: приоритет задаёт jobs.claim (absorb 5, compact 7).
 */
export const INLINE_JOB_KINDS: readonly string[] = ["absorb", "compact"];

/** Сколько дренаж ждёт чужой write-lock. Фон не ждёт секундами — уходит. */
export const DRAIN_BUSY_TIMEOUT_MS = 250;

/** Включён ли дренаж. Под `bun test` (NODE_ENV=test) выключен по умолчанию — */
export function queueDrainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // тесты поднимают временные воркспейсы десятками, и фон, переживающий
  // вызов, там не нужен никому, кроме тестов самого дренажа — они зовут
  // drainQueueTail напрямую или спавнят процессы с явным окружением (та же
  // договорённость, что у embedDaemonEnabled).
  if (env.NODE_ENV === "test") return false;
  const raw = (env.MYC_DRAIN ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false" && raw !== "no";
}

export function drainBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYC_DRAIN_BUDGET_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_DRAIN_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DRAIN_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// Исполнитель-заглушка для многопроцессных тестов (приём MYC_EMBED_FAKE)
// ---------------------------------------------------------------------------

/**
 * Заглушка исполнителя. Работа через очередь при этом НАСТОЯЩАЯ: claim с
 * арендой, complete/fail — боевые; подменено только ТЕЛО работы. Пауза ДО
 * записи в лог: строка означает «работа завершена», и двойное выполнение
 * видно как повторный id — это измеритель мутации «аренда убрана».
 */
function fakeExecutorFromEnv(
  env: NodeJS.ProcessEnv,
): ((job: jobs.JobRow) => Promise<void>) | null {
  if (env.MYC_DRAIN_FAKE !== "1") return null;
  const logPath = env.MYC_DRAIN_FAKE_LOG;
  const delayMs = Math.max(0, Number(env.MYC_DRAIN_FAKE_DELAY_MS ?? 0) || 0);
  return async (job: jobs.JobRow): Promise<void> => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (logPath !== undefined && logPath.length > 0) {
      appendFileSync(logPath, `${JSON.stringify({ kind: job.kind, id: job.id, pid: process.pid })}\n`);
    }
  };
}

// ---------------------------------------------------------------------------
// Отсоединённый воркер для дорогого класса embed
// ---------------------------------------------------------------------------

/**
 * Запуск `myc reindex` В ФОНЕ — приём spawnEmbedDaemon: argv от process.execPath
 * (в бинаре это сам `myc`, из исходников — `bun` + входной файл), spawn без
 * await, detached + unref. Воркер конечен: drain в reindex.ts выходит, когда
 * очередь пуста или сосед жив и разгребает сам (ожидание ≤ 2 аренд). Гонка
 * двух спавнов безвредна: захват работ атомарен (jobs.claim), проигравший
 * просто выйдет.
 */
export function spawnReindexWorker(dbPath: string): void {
  try {
    const entry = process.argv[1];
    const fromSource = typeof entry === "string" && /\.(ts|js|mjs)$/.test(entry);
    const argv = [
      process.execPath,
      ...(fromSource ? [entry] : []),
      "reindex",
      "--db",
      dbPath,
    ];
    const child = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // Воркер обязан пережить команду, которая его позвала: иначе хвост
      // очереди снова умрёт вместе с ней — ровно дефект S56.
      detached: true,
    });
    child.unref();
  } catch {
    // Не поднялся — работы останутся в очереди (наблюдаемо через stats), а
    // следующий вызов попробует снова. Падать здесь нечему.
  }
}

const SQL_EMBED_READY = `SELECT 1 AS x FROM jobs
  WHERE kind = 'embed' AND attempts < max_attempts
    AND lease_expires <= ?1 AND run_after <= ?1 LIMIT 1`;
const SQL_EMBED_LEASED = `SELECT 1 AS x FROM jobs
  WHERE kind = 'embed' AND attempts < max_attempts AND lease_expires > ?1 LIMIT 1`;

// ---------------------------------------------------------------------------
// StoreHandle для absorb — то же, что openWorkspaceAt, но без цикла ретраев:
// фон не ждёт чужой lock (busy_timeout укорочен сразу после открытия)
// ---------------------------------------------------------------------------

/**
 * HLC-join и site_id — дословно правила openWorkspaceAt (commands/store.ts):
 * часы обязаны стартовать от последней записи оплога, иначе update одного
 * узла из двух соединений в пределах миллисекунды молча проигрывает LWW
 * (решения S38/S40 — этот класс дефекта здесь недопустим вдвойне, потому что
 * дренаж пишет в теневой зоне видимости).
 */
function openDrainHandle(driver: CliDriver, dbPath: string, env: NodeJS.ProcessEnv): StoreHandle {
  const dir = dirname(dbPath);
  let slug = "myc";
  const tomlPath = join(dir, "workspace.toml");
  if (existsSync(tomlPath)) {
    try {
      slug = parseWorkspaceToml(readFileSync(tomlPath, "utf8")).slug;
    } catch {
      // битый конфиг — дефолт, как у openStore
    }
  }
  const actor = env.MYC_ACTOR ?? env.USER ?? "agent";
  let siteId = driver.one<{ value: string }>(Q.meta_get, ["site_id"])?.value;
  if (siteId === undefined) {
    siteId = `local-${slug}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
    driver.run(Q.meta_set, ["site_id", siteId]);
  }
  let clock: HlcClock | undefined;
  const lastOp = driver.database
    .query("SELECT CAST(hlc AS TEXT) AS hlc FROM oplog ORDER BY seq DESC LIMIT 1")
    .get() as { hlc: string } | null;
  if (lastOp !== null) {
    const { ts, ctr } = unpackHlc(BigInt(lastOp.hlc));
    clock = new HlcClock({ initial: { ts, ctr } });
  }
  const store = new GraphStore(driver, {
    newId: () => generateId(slug),
    actor,
    siteId,
    ...(clock !== undefined ? { clock } : {}),
  });
  return {
    driver,
    store,
    claims: new Claims(store, { holder: actor }),
    actor,
    scope: slug === "myc" ? "" : slug,
    slug,
    // Дренаж оплога открывает базу по прямому пути и узлов не создаёт:
    // корня воркспейса у него нет, и охват репозитория (S59) честно
    // неопределён, а не выдуман общим.
    wsDir: dir,
    repo: { repo: undefined, reason: "no-workspace", from: dir },
    weights: { ...DEFAULT_READY_WEIGHTS },
    vec0: driver.vec0,
    vec0Reason: driver.vec0Reason,
    close: () => driver.close(),
  };
}

/**
 * Сессия absorb для инлайн-разбора: эмбеддер НИКОГДА не поднимается (холодный
 * ONNX ~223 мс — четыре бюджета дренажа). Вектор берётся из nodes_vec, если
 * воркер уже досчитал его; иначе — штатная громкая деградация absorb в
 * lexical (quality='lexical' + degraded_at на строке узла, И2): кандидаты
 * становятся relates, ничего не сливается и не выбрасывается.
 */
function drainAbsorbSession(h: StoreHandle, now: number): Session {
  return {
    h,
    thresholds: DEFAULT_ABSORB_THRESHOLDS,
    dryRun: false,
    now,
    embedder: null,
    degradedReason: h.vec0
      ? "инлайн-дренаж без эмбеддера: вектор только из nodes_vec, иначе lexical"
      : (h.vec0Reason ?? "vec0 не загружен — nodes_vec недоступна"),
    fingerprintMismatch: null,
    resolveEmbedder: () => Promise.resolve(null),
  };
}

// ---------------------------------------------------------------------------
// Дренаж
// ---------------------------------------------------------------------------

export interface DrainOptions {
  readonly dbPath: string;
  /** По умолчанию MYC_DRAIN_BUDGET_MS или DEFAULT_DRAIN_BUDGET_MS. */
  readonly budgetMs?: number;
  readonly holder?: string;
  readonly leaseMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Подмена спавна воркера (тесты). */
  readonly spawnWorker?: (dbPath: string) => void;
  readonly now?: () => number;
}

export interface DrainReport {
  readonly dbPath: string;
  readonly budgetMs: number;
  readonly tookMs: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly byKind: Record<string, number>;
  readonly embedWorkerSpawned: boolean;
  readonly skipped: "no_db" | null;
  /** Первые ошибки fail — наблюдаемость без WARN в чужом выводе. */
  readonly errors: readonly string[];
}

/**
 * Разобрать хвост очереди одного воркспейса по бюджету. НИКОГДА не бросает:
 * дренаж — фон команды, и его отказ не имеет права стать отказом команды.
 */
export async function drainQueueTail(opts: DrainOptions): Promise<DrainReport> {
  const t0 = performance.now();
  const env = opts.env ?? process.env;
  const budgetMs = opts.budgetMs ?? drainBudgetFromEnv(env);
  const holder = opts.holder ?? `drain-${process.pid}`;
  const report = {
    dbPath: opts.dbPath,
    budgetMs,
    tookMs: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    byKind: {} as Record<string, number>,
    embedWorkerSpawned: false,
    skipped: null as DrainReport["skipped"],
    errors: [] as string[],
  };
  const finish = (): DrainReport => {
    report.tookMs = Math.round((performance.now() - t0) * 10) / 10;
    return report;
  };
  if (!existsSync(opts.dbPath)) {
    report.skipped = "no_db";
    return finish();
  }

  let driver: CliDriver;
  try {
    driver = openDriver(opts.dbPath, undefined, { extensions: true });
  } catch {
    // База занята или бита — фон уходит, команда уже ответила за себя.
    return finish();
  }
  try {
    driver.database.exec(`PRAGMA busy_timeout = ${DRAIN_BUSY_TIMEOUT_MS}`);
    const db = driver.database;
    const now = opts.now ?? Date.now;

    // Дорогой класс — отсоединённому воркеру. Воркер не плодится, пока жив
    // чужой захват (аренда и есть сигнал «кем-то разбирается»), и не
    // поднимается вовсе без модели: такой воркер умрёт на прогреве, оставив
    // в очереди строку с last_error, — честный отказ вместо бесконечного
    // перезапуска (та же привратность, что у warmInBackground в retrieve.ts).
    try {
      const embedReady = db.query(SQL_EMBED_READY).get(now()) !== null;
      if (embedReady) {
        const embedLeased = db.query(SQL_EMBED_LEASED).get(now()) !== null;
        if (!embedLeased && (modelLikelyPresent(env) || env.MYC_EMBED_FAKE === "1")) {
          (opts.spawnWorker ?? spawnReindexWorker)(opts.dbPath);
          report.embedWorkerSpawned = true;
        }
      }
    } catch {
      // Постановка воркера — шанс, а не обязанность этого вызова.
    }

    const fake = fakeExecutorFromEnv(env);
    let handle: StoreHandle | null = null;
    let session: Session | null = null;
    // БЮДЖЕТ ПРОВЕРЯЕТСЯ ПЕРЕД КАЖДЫМ ЗАХВАТОМ. Убрать условие — значит
    // разбирать до конца очереди ценой чужого вызова (мутация 1 при сдаче).
    while (performance.now() - t0 < budgetMs) {
      let batch: jobs.JobRow[];
      try {
        batch = jobs.claim(db, INLINE_JOB_KINDS, holder, {
          ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
        });
      } catch (e) {
        // База занята дольше busy_timeout — фон уступает без шума.
        report.errors.push(`claim: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      if (batch.length === 0) break;
      const job = batch[0]!;
      report.claimed++;
      try {
        if (fake !== null) {
          await fake(job);
        } else if (job.kind === "absorb") {
          // Работа без сущности — пристрелить немедленно: classify нечего.
          if (job.entity_id !== null) {
            handle ??= openDrainHandle(driver, opts.dbPath, env);
            session ??= drainAbsorbSession(handle, now());
            await absorbOne(session, job.entity_id);
          }
        } else if (job.kind === "compact") {
          // runWalCheckpointJob сам снимает строку при ПОЛНОМ переносе WAL;
          // недоделанный checkpoint обязан остаться в очереди — это fail,
          // а не complete (контракт checkpoint.ts).
          const r = runWalCheckpointJob(db);
          if (!r.complete) throw new Error("WAL не перенесён целиком (busy)");
        }
        jobs.complete(db, job.id, holder);
        report.completed++;
        report.byKind[job.kind] = (report.byKind[job.kind] ?? 0) + 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Попытка засчитана, аренда снята, следующая выдача — с откатом.
        // Строка остаётся в таблице: это единственный след аварии (S7).
        jobs.fail(db, job.id, msg, { holder });
        report.failed++;
        if (report.errors.length < 4) report.errors.push(`${job.kind}#${job.id}: ${msg}`);
      }
    }
  } catch {
    // Любой непредвиденный отказ дренажа — не отказ команды.
  } finally {
    try {
      driver.close();
    } catch {
      /* закрытие фона не шумит */
    }
  }
  return finish();
}

/**
 * Точка подключения к жизненному циклу команды (index.ts): дренаж после
 * успешного обработчика, по флагу окружения, никогда не бросает.
 */
export async function drainAfterCommand(
  globals: Globals,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Тест-раннер узнаётся по process.env, а не по env вызова: харнессы передают
  // вызову белый список без NODE_ENV (absorb.test.ts), и фон внутри чужого
  // теста съедает очередь, которую тест собрался разбирать сам. Боевой
  // CLI-процесс (включая spawned в тестах дренажа) такого NODE_ENV не имеет.
  if (process.env.NODE_ENV === "test") return;
  if (!queueDrainEnabled(env)) return;
  const dir = resolve(globals.directory ?? process.cwd());
  const dbPath = globals.db ?? join(dir, ".myc", "myc.db");
  try {
    await drainQueueTail({ dbPath, env });
  } catch {
    // дренаж — фон: он уже всё сказал через jobs.last_error и stats
  }
}
