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
 * ТРЕТИЙ ПУТЬ — БАТЧЕВЫЙ, и он появился здесь для `anchor_check`. Этот класс
 * не «одна строка очереди = одна работа»: строка означает «вот эти файлы
 * изменились, посмотри туда раньше», а работа — прогон лестницы §7.2 по батчу
 * якорей в порядке `checked_at ASC`. Поэтому anchor_check НЕ в INLINE_JOB_KINDS:
 * все его строки снимаются разом, их payload'ы сливаются с журналом грязных
 * файлов в один набор подсказок, и прогон случается ОДИН. Иначе семь строк в
 * очереди означали бы семь одинаковых прогонов внутри одного бюджета.
 *
 * И у него есть ПЕРИОД: §7.5 требует пере-проверки каждые 300 с даже когда в
 * очереди пусто — файлы меняет не только агент (git checkout, соседний
 * процесс, редактор человека), и ни одна такая правка строки в jobs не
 * ставит. Отметка последнего прогона живёт в `myc_meta.anchor_swept_at`:
 * durable, общая для всех процессов воркспейса и не требующая ни файла, ни
 * демона. Две гонки безвредны — прогон идемпотентен, а строки очереди
 * захватываются атомарно (jobs.claim).
 *
 * ЧЕГО ЗДЕСЬ НЕТ. У класса `distill` исполнителя по-прежнему нет:
 * packages/distiller — заглушка, его работы лежат в очереди незабранными
 * (наблюдаемо через jobs.stats, не молча).
 *
 * БЕЗОПАСНОСТЬ ВЫЗОВА. Дренаж — фон: он не имеет права уронить или заметно
 * задержать команду, ради которой случился. Под команду, уже открывшую базу
 * БЕЗ расширений (`ready`, `show`), vec0 для этого соединения недоступен по
 * правилу движка (setCustomSQLite до первого `new Database`) — openDriver
 * честно вернёт vec0Reason, absorb уйдёт в lexical-режим (его штатная громкая
 * деградация, И2), и это не ошибка дренажа. busy_timeout укорочен до 250 мс:
 * ждать чужой write-lock секундами фон не будет никогда.
 *
 * ПЕРЕМЕННЫЕ (тесты): MYC_DRAIN=0 — выключить дренаж; MYC_ANCHOR_CHECK=0 —
 * выключить ТОЛЬКО фон якорей, оставив разбор очереди (оба — в реестре
 * BACKGROUND_SWITCHES, @myc/core/test-env.ts); MYC_ANCHOR_PERIOD_MS и
 * MYC_ANCHOR_BUDGET_MS — период и бюджет прогона; MYC_DRAIN_BUDGET_MS —
 * бюджет; MYC_DRAIN_FAKE=1 — исполнитель-заглушка (та же механика, что
 * MYC_EMBED_FAKE в reindex.ts): работа не выполняется, а пишется строкой в
 * MYC_DRAIN_FAKE_LOG, чтобы многопроцессный тест считал выполнения по
 * процессам (у код-индекса вместо воркера — строка о нём, а работа остаётся
 * в очереди под арендой); MYC_DRAIN_FAKE_DELAY_MS — пауза на работу (замер
 * бюджета); MYC_CODE_INDEX_PERIOD_MS — порог возраста код-индекса.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_ABSORB_THRESHOLDS,
  generateId,
  HlcClock,
  unpackHlc,
} from "@myc/core";
import {
  CODE_REFRESH_AFTER_MS,
  CODE_REFRESH_ENTITY,
  CODE_REFRESH_JOB_KIND,
  CODE_REFRESH_LEASE_MS,
  CODE_REFRESH_PRIORITY,
  attemptsOf,
  refreshAfterMs,
  refreshStateOf,
} from "@myc/code-intel/refresh";
import {
  Claims,
  driverMeta,
  ensureSiteId,
  GraphStore,
  jobs,
  mintSiteId,
  Q,
  runWalCheckpointJob,
} from "@myc/store-sqlite";
import type { Globals } from "./registry.ts";
import { absorbOne, type Session } from "./commands/absorb.ts";
// Ключ отметки — оттуда же, откуда команда, которая её обновляет: две копии
// строки `code_indexed_at` разъехались бы молча, и период перестал бы
// действовать в одну из сторон. Модуль лёгкий (его собственный граф —
// store.ts, уже здесь), тяжёлое он тянет динамически внутри обработчиков.
import { CODE_INDEXED_AT_KEY } from "./commands/code.ts";
import { modelLikelyPresent } from "./commands/retrieve.ts";
import { findWorkspaceDb, workspaceDirOfDb } from "./commands/wsfind.ts";
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

/**
 * ЦЕНА ФОНА ЯКОРЕЙ, названная числом. Прогон ограничен И батчем (256 якорей,
 * §7.5), И временем: 20 мс — это меньше половины бюджета дренажа, то есть
 * даже упёршийся в потолок прогон оставляет absorb'у больше, чем тот тратит
 * на одну работу (~8 мс). Недоразобранный батч не теряется: `checked_at` тех
 * якорей не сдвинулся, и следующий прогон возьмёт их первыми.
 */
export const ANCHOR_SWEEP_BUDGET_MS = 20;

/**
 * Период §7.5: не чаще раза в 300 с на воркспейс. Живёт ЗДЕСЬ, а не рядом с
 * лестницей: «когда проверять» — вопрос расписания, и отвечает на него
 * дренаж; «как проверять» (дебаунс, уровни, батч) — вопрос лестницы, и он
 * остался в commands/anchor.ts.
 */
export const ANCHOR_SWEEP_PERIOD_MS = 300_000;

/** Сколько строк `anchor_check` снимается за раз; все они дают ОДИН прогон. */
export const ANCHOR_JOB_CLAIM_LIMIT = 32;

/** Ключ отметки последнего прогона в `myc_meta`. */
export const ANCHOR_SWEPT_AT_KEY = "anchor_swept_at";

/**
 * ПЕРИОД КОД-ИНДЕКСА — 15 минут, в тридцать раз реже якорей, и это не
 * осторожность, а цена. Прогон лестницы якорей читает десятки файлов по
 * `checked_at ASC`; прогон индекса ОБХОДИТ ВСЁ ДЕРЕВО (замер на этом
 * репозитории: 803 файла, 60 мс только скан с попаданием во все хеши, 0,3 с
 * полная сборка с разбором). Чаще — значит платить обходом дерева за каждый
 * второй вызов CLI ради символов, которые меняются от правки файла, а не от
 * времени. Число живёт в @myc/code-intel/refresh — его же читают строка
 * статуса и WARN код-команд («устарел» там и «пора обновить» здесь — один
 * порог).
 */
export const CODE_INDEX_PERIOD_MS = CODE_REFRESH_AFTER_MS;

/**
 * Включён ли фоновый код-индекс. Выключатель свой, а не общий с MYC_DRAIN:
 * шаг ПОДНИМАЕТ ПРОЦЕСС, который ходит по файлам репозитория, и тесту,
 * правящему дерево под собой, нужно уметь погасить именно его. Имя — в
 * реестре BACKGROUND_SWITCHES (@myc/core/test-env.ts).
 */
export function codeIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "test") return false;
  const raw = (env.MYC_CODE_INDEX ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false" && raw !== "no";
}

/**
 * Включён ли фон якорей. Отдельный выключатель от MYC_DRAIN, а не общий:
 * лестница §7.2 читает ФАЙЛЫ РЕПОЗИТОРИЯ, а не только базу, и тесту, который
 * правит файлы под собой, нужно уметь погасить именно её, оставив разбор
 * очереди. Имя — в реестре BACKGROUND_SWITCHES (@myc/core/test-env.ts):
 * иначе тест на исчерпывающность краснеет, и правильно делает.
 */
export function anchorSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "test") return false;
  const raw = (env.MYC_ANCHOR_CHECK ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false" && raw !== "no";
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
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

/**
 * Та же заглушка для воркера код-индекса: вместо процесса — строка в
 * MYC_DRAIN_FAKE_LOG. Постановка и захват при этом НАСТОЯЩИЕ, поэтому
 * многопроцессный тест считает, сколько работ стоит и сколько воркеров было
 * бы поднято, а работа остаётся в очереди под арендой — видимой.
 */
function fakeCodeIndexSpawnFromEnv(env: NodeJS.ProcessEnv): ((dbPath: string, job: ClaimedJob) => void) | null {
  if (env.MYC_DRAIN_FAKE !== "1") return null;
  const logPath = env.MYC_DRAIN_FAKE_LOG;
  return (dbPath: string, job: ClaimedJob): void => {
    if (logPath !== undefined && logPath.length > 0) {
      appendFileSync(logPath, `${JSON.stringify({ kind: CODE_REFRESH_JOB_KIND, id: job.id, holder: job.holder, db: dbPath, pid: process.pid })}\n`);
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
  spawnDetachedCommand(["reindex", "--db", dbPath]);
}

/**
 * Общий спавн отсоединённой подкоманды myc. Одна функция на два дорогих
 * класса (`embed` → `myc reindex`, `code_index` → `myc code index`): argv
 * собирается от process.execPath (в бинаре это сам `myc`, из исходников —
 * `bun` + входной файл), spawn без await, detached + unref.
 *
 * Воркер обязан пережить команду, которая его позвала: иначе дорогая работа
 * снова умрёт вместе с ней — ровно дефект S56. Не поднялся — работы остаются
 * в очереди (наблюдаемо через stats), следующий вызов попробует снова;
 * падать здесь нечему.
 */
function spawnDetachedCommand(
  args: readonly string[],
  opts: { readonly cwd?: string; readonly stderrPath?: string } = {},
): void {
  try {
    const entry = process.argv[1];
    const fromSource = typeof entry === "string" && /\.(ts|js|mjs)$/.test(entry);
    // Через bun со скриптом — те же флаги, что в shebang лаунчера
    // (bin/myc.js): без них bun ДО первой строки myc грузит .env и
    // ./bunfig.toml каталога, из которого его подняли, то есть чужого
    // проекта (preload его тестов исполнялся бы внутри воркера). Бинарю
    // (`dist/myc`) они не нужны — он собран без автозагрузки — и не по
    // карману: он принял бы их за свои флаги.
    const viaBun = fromSource && /^bun/.test(basename(process.execPath));
    const argv = [
      process.execPath,
      ...(fromSource ? [...(viaBun ? ["--no-env-file", "--config=/dev/null"] : []), entry] : []),
      ...args,
    ];
    let stderr: number | "ignore" = "ignore";
    if (opts.stderrPath !== undefined) {
      try {
        stderr = openSync(opts.stderrPath, "w");
      } catch {
        stderr = "ignore";
      }
    }
    try {
      const child = Bun.spawn(argv, {
        ...(opts.cwd !== undefined && existsSync(opts.cwd) ? { cwd: opts.cwd } : {}),
        stdin: "ignore",
        stdout: "ignore",
        stderr,
        detached: true,
      });
      child.unref();
    } finally {
      // Дескриптор файла у ребёнка свой (дубль); наш закрываем сразу.
      if (typeof stderr === "number") closeSync(stderr);
    }
  } catch {
    // см. шапку: отказ спавна — не отказ команды и не потеря работы
  }
}

/** Работа, захваченная дренажом для воркера: её id и держатель аренды. */
export interface ClaimedJob {
  readonly id: number;
  readonly holder: string;
}

/**
 * Куда воркер обновления пишет stderr: файл на базу во временном каталоге,
 * перезаписывается каждым запуском. Не в `.myc/`: там каждый новый файл —
 * строка в `git status` проекта. Упавший воркер сам кладёт причину в
 * `jobs.last_error`; этот файл — для того, что умерло раньше, чем успело.
 */
export function codeRefreshLogPath(dbPath: string): string {
  const id = createHash("sha256").update(resolve(dbPath)).digest("hex").slice(0, 16);
  return join(tmpdir(), `myc-code-refresh-${id}.log`);
}

/**
 * Код-индекс отсоединённым процессом: `myc code index` синхронно стоит
 * СЕКУНДЫ на большом дереве (замер: 803 файла этого репозитория — 0,3 с
 * полный, 0,08 с повторный), а бюджет дренажа — 50 мс. Инлайн он не пойдёт
 * никогда (И1); ровно тот же расклад, что у класса `embed`.
 *
 * Воркер получает УЖЕ ЗАХВАЧЕННУЮ работу (`--job`/`--holder`) и стоит в корне
 * воркспейса (`-C`): обновляется индекс воркспейса целиком, а не часть,
 * в которой случайно стоял агент, чья команда подняла воркер.
 */
export function spawnCodeIndexWorker(dbPath: string, job?: ClaimedJob): void {
  const ws = workspaceDirOfDb(dbPath);
  spawnDetachedCommand(
    [
      ...(ws !== undefined ? ["-C", ws] : []),
      "code",
      "index",
      "--db",
      dbPath,
      ...(job !== undefined ? ["--job", String(job.id), "--holder", job.holder] : []),
    ],
    { ...(ws !== undefined ? { cwd: ws } : {}), stderrPath: codeRefreshLogPath(dbPath) },
  );
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
 *
 * @internal Экспортируется ради сторожа полноты подключения S65
 * (site-identity.wiring.test.ts): точку открытия базы он обязан гонять
 * НАСТОЯЩУЮ, а иначе прувер проверял бы свою копию логики, а не эту.
 */
export function openDrainHandle(
  driver: CliDriver,
  dbPath: string,
  env: NodeJS.ProcessEnv,
): StoreHandle {
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
  // S65 — дословно те же правила, что у openWorkspaceAt: site_id принадлежит
  // физическому экземпляру базы. Дренаж поднимается ФОНОМ и вполне может
  // оказаться первым, кто откроет свежую копию каталога; пропусти проверку
  // здесь — и перевыпуск стал бы зависеть от того, кто успел раньше.
  const { siteId } = ensureSiteId({
    meta: driverMeta(driver),
    dbPath,
    mint: () => mintSiteId(slug),
  });
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
    // А вот каталог базы у него определён точно — он и есть `dir`. Рабочего
    // дерева у дренажа нет вовсе: он фоновый и в дерево не пишет ничего.
    mycDir: dir,
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
      ? "inline drain without an embedder: vector only from nodes_vec, otherwise lexical"
      : (h.vec0Reason ?? "vec0 is not loaded — nodes_vec is unavailable"),
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
  /** Подмена спавна воркера код-индекса (тесты): получает базу и захваченную работу. */
  readonly spawnCodeIndex?: (dbPath: string, job: ClaimedJob) => void;
  readonly now?: () => number;
}

/** Что сделал фон якорей за этот вызов. `null` — не запускался. */
export interface AnchorStepReport {
  /** Что позвало прогон: строки очереди или наступивший период §7.5. */
  readonly triggered: "jobs" | "period";
  /** Снято строк `anchor_check` (все они дают ОДИН прогон). */
  readonly jobs: number;
  readonly checked: number;
  /** Доведено отложенных привязок (S66) — они внутри `checked`. */
  readonly bound: number;
  readonly fresh: number;
  /** Ре-привязано по сходству (§7.3 шаги 2–3) — в том же файле или в другом. */
  readonly drifted: number;
  /** stale + lost: привязка под вопросом (lost — индекс видел изменение и кода не нашёл). */
  readonly stale: number;
  readonly lost: number;
  readonly moved: number;
  /** Найдено в ДРУГОМ файле по код-индексу (ступень 3 §7.3) из стольких, сколько там искали. */
  readonly foundElsewhere: number;
  readonly searchedElsewhere: number;
  readonly fromDirty: number;
  readonly skippedDebounce: number;
  readonly budgetHit: boolean;
  readonly tookMs: number;
}

/** Что сделал шаг код-индекса за этот вызов. `null` — не запускался. */
export interface CodeIndexStepReport {
  /**
   * Что позвало: индекс старше порога (`period`, с последнего ЗАВЕРШЁННОГО
   * прогона) или брошенные строки `code_index` в очереди.
   */
  readonly triggered: "period" | "jobs";
  /** Поднят ли отсоединённый воркер. false — повод был, но условие не сошлось. */
  readonly spawned: boolean;
  /** Строка `code_refresh` поставлена ЭТИМ вызовом (false — уже стояла: дедупликация). */
  readonly queued: boolean;
  /** id строки `code_refresh`; null — до постановки не дошло. */
  readonly job: number | null;
  /** Почему не поднят: уже обновляется, откат после сбоя, попытки исчерпаны, нет индекса и якорей. Пусто — поднят. */
  readonly reason: string;
  /** Якорей в базе: без индекса он строится только там, где к коду привязано знание. */
  readonly anchors: number;
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
  readonly anchor: AnchorStepReport | null;
  readonly codeIndex: CodeIndexStepReport | null;
  readonly skipped: "no_db" | null;
  /** Первые ошибки fail — наблюдаемость без WARN в чужом выводе. */
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Фоновый потребитель jobs(kind='anchor_check') — §7.5
// ---------------------------------------------------------------------------

/**
 * Пути-подсказки из payload'ов снятых работ. Формы две и обе живые:
 * `{paths:[…]}` ставит хук absorb-session (файлы эпизода), `{path,…}` —
 * всё, что знает про один файл. Неразобранный payload не роняет прогон:
 * строка очереди — подсказка, а порядок по `checked_at` есть и без неё.
 */
function hintPathsOf(rows: readonly jobs.JobRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      const many = p["paths"];
      if (Array.isArray(many)) {
        for (const v of many) if (typeof v === "string") out.push(v);
      }
      const one = p["path"];
      if (typeof one === "string") out.push(one);
    } catch {
      // payload не JSON — подсказки нет, работа всё равно будет снята
    }
  }
  return out;
}

interface AnchorStepOptions {
  readonly dbPath: string;
  readonly holder: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: number;
  /** Остаток бюджета дренажа: фон якорей не имеет права его перешагнуть. */
  readonly budgetMs: number;
  readonly leaseMs?: number;
  readonly handle: () => StoreHandle;
}

/**
 * ОДИН ПРОГОН ЛЕСТНИЦЫ НА ВЫЗОВ, и только если есть повод. Повода два:
 * снятые строки `anchor_check` или наступивший период §7.5 (300 с). Нет ни
 * того ни другого — функция стоит один SELECT из `myc_meta` (это и есть цена
 * фона на 99 из 100 вызовов) и уходит.
 */
async function runAnchorStep(driver: CliDriver, opts: AnchorStepOptions): Promise<AnchorStepReport | null> {
  const t0 = performance.now();
  const db = driver.database;
  const periodMs = numFromEnv(opts.env.MYC_ANCHOR_PERIOD_MS, ANCHOR_SWEEP_PERIOD_MS);
  const budgetMs = Math.min(
    numFromEnv(opts.env.MYC_ANCHOR_BUDGET_MS, ANCHOR_SWEEP_BUDGET_MS),
    Math.max(1, Math.floor(opts.budgetMs)),
  );

  const sweptRaw = driver.one<{ value: string }>(Q.meta_get, [ANCHOR_SWEPT_AT_KEY])?.value;
  const sweptAt = Number(sweptRaw ?? 0);
  const periodDue = !Number.isFinite(sweptAt) || opts.now - sweptAt >= periodMs;

  const claimed = jobs.claim(db, ["anchor_check"], opts.holder, {
    limit: ANCHOR_JOB_CLAIM_LIMIT,
    now: opts.now,
    ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
  });
  if (claimed.length === 0 && !periodDue) return null;

  const { sweepAnchors, ANCHOR_DEBOUNCE_MS } = await import("./commands/anchor.ts");
  const { workspaceDirOfDb } = await import("./commands/wsfind.ts");
  const wsDir = workspaceDirOfDb(opts.dbPath) ?? dirname(dirname(opts.dbPath));
  const h = opts.handle();
  const data = await sweepAnchors(h, {
    // Репозиторий не сужается: фон обходит ВЕСЬ воркспейс по `checked_at ASC`,
    // а какому репозиторию принадлежит строка — известно из неё самой
    // (`repo_root` машинозависим и живёт в строке, §7.1).
    repoRoot: wsDir,
    wsDir,
    debounceMs: ANCHOR_DEBOUNCE_MS,
    budgetMs,
    hintPaths: hintPathsOf(claimed),
    now: opts.now,
  });

  // Строки снимаются ПОСЛЕ прогона: упади он — аренда истечёт и работа
  // вернётся в очередь, а не исчезнет тихо (правило S7).
  for (const job of claimed) {
    try {
      jobs.complete(db, job.id, opts.holder);
    } catch {
      // Чужой holder или гонка — строку заберёт следующий прогон.
    }
  }
  try {
    driver.run(Q.meta_set, [ANCHOR_SWEPT_AT_KEY, String(opts.now)]);
  } catch {
    // Отметка не записалась — следующий вызов просто прогонит снова.
  }

  return {
    triggered: claimed.length > 0 ? "jobs" : "period",
    jobs: claimed.length,
    checked: data.checked,
    bound: data.bound,
    fresh: data.fresh,
    drifted: data.drifted,
    stale: data.stale + data.lost,
    lost: data.lost,
    moved: data.moved,
    foundElsewhere: data.found_elsewhere,
    searchedElsewhere: data.searched_elsewhere,
    fromDirty: data.from_dirty,
    skippedDebounce: data.skipped_debounce,
    budgetHit: data.budget_hit,
    tookMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Фоновый вход код-индекса (S52, §4.3): период + отсоединённый воркер
// ---------------------------------------------------------------------------

const SQL_CODE_JOB_READY = `SELECT 1 AS x FROM jobs
  WHERE kind = 'code_index' AND attempts < max_attempts
    AND lease_expires <= ?1 AND run_after <= ?1 LIMIT 1`;
const SQL_CODE_JOB_LEASED = `SELECT 1 AS x FROM jobs
  WHERE kind = 'code_index' AND attempts < max_attempts AND lease_expires > ?1 LIMIT 1`;

/**
 * ВХОД КОД-ИНДЕКСА, КОТОРОГО НЕ БЫЛО. Индекс `code_files/code_defs` был
 * написан и покрыт тестами, а строил его только стенд замера: ни одна команда
 * не звала `runCodeIndex`, и в базе этого репозитория лежали нули
 * (memory-m30yh8swnm1d). Здесь тот же расклад, что у дорогого класса `embed`:
 * инлайн — НИКОГДА (обход дерева стоит сотни миллисекунд при бюджете 50 мс),
 * работа уходит отсоединённому `myc code index`.
 *
 * ПОВОД (memory-es8qwd555cjt): индекс старше порога с последнего ЗАВЕРШЁННОГО
 * прогона (`code_indexed_at`, её пишет только сам прогон), или брошенные
 * строки `code_index` в очереди. Нет повода — шаг стоит поиск по ключу в
 * `myc_meta` и один по индексу jobs, как и прежде.
 *
 * УСЛОВИЕ ИЗ §4.3 — расширено индексом. Код воркспейсу важен, если к коду
 * привязано знание (якорь) ИЛИ индекс уже построен: человек, однажды
 * позвавший `myc code index`, хочет, чтобы индекс не отставал. Нет ни того ни
 * другого — чужое дерево не обходится.
 *
 * ОДНА РАБОТА И ОДИН ИСПОЛНИТЕЛЬ НА ВОРКСПЕЙС, сколько бы агентов ни звали
 * дренаж. Работа — строка `code_refresh` с сущностью `.`: вторая постановка
 * упирается в `ux_jobs_dedup` и возвращает ту же строку. Исполнитель — тот,
 * чей `jobs.claim` (один стейтмент) взял аренду: только он поднимает воркер и
 * передаёт ему id и держателя. Пока аренда жива, следующие дренажи видят
 * «уже обновляется» и уходят; умер воркер — аренда истечёт, строку заберёт
 * следующий дренаж, и попытка засчитается (после пяти — `failed`, громко).
 */
function runCodeIndexStep(
  driver: CliDriver,
  opts: {
    readonly dbPath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly now: number;
    readonly spawn: (dbPath: string, job: ClaimedJob) => void;
  },
): CodeIndexStepReport | null {
  const db = driver.database;
  const periodMs = refreshAfterMs(opts.env);
  const stampRaw = driver.one<{ value: string }>(Q.meta_get, [CODE_INDEXED_AT_KEY])?.value;
  const stamp = Number(stampRaw ?? 0);
  const periodDue = !Number.isFinite(stamp) || stamp <= 0 || opts.now - stamp >= periodMs;
  const jobsReady = db.query(SQL_CODE_JOB_READY).get(opts.now) !== null;
  if (!periodDue && !jobsReady) return null;

  const triggered: CodeIndexStepReport["triggered"] = jobsReady ? "jobs" : "period";
  // Якоря и индекс — признак «этому воркспейсу код важен» (§4.3). Наличие
  // первой строки, а не COUNT(*): на 50k строк разница — два порядка.
  const anchors = db.query("SELECT 1 AS x FROM anchors LIMIT 1").get() === null ? 0 : 1;
  const indexed = db.query("SELECT 1 AS x FROM code_files LIMIT 1").get() !== null;
  const report = (spawned: boolean, queued: boolean, job: number | null, reason: string): CodeIndexStepReport => ({
    triggered,
    spawned,
    queued,
    job,
    reason,
    anchors,
  });
  if (anchors === 0 && !indexed) {
    return report(false, false, null, "no code index and no anchors in the database (§4.3): nothing asks for one");
  }
  if (db.query(SQL_CODE_JOB_LEASED).get(opts.now) !== null) {
    return report(false, false, null, "code_index jobs are under someone else's lease: a `myc code index` is running");
  }

  // ДЕДУПЛИКАЦИЯ — здесь: сущность задана, значит строка на воркспейс одна.
  const put = jobs.enqueue(db, CODE_REFRESH_JOB_KIND, {
    entityId: CODE_REFRESH_ENTITY,
    priority: CODE_REFRESH_PRIORITY,
    payload: { reason: triggered, stamp: stamp > 0 ? stamp : null },
    now: opts.now,
  });
  const row = put.row;
  const state = refreshStateOf(row, opts.now);
  if (state === "failed") {
    return report(
      false,
      put.inserted,
      row.id,
      `the background refresh gave up after ${attemptsOf(row, opts.now)} attempts (${row.last_error ?? "the worker died without a word"}) — ` +
        "`myc code index` shows why and clears it",
    );
  }
  if (state !== "queued") {
    return report(
      false,
      put.inserted,
      row.id,
      state === "running"
        ? "a refresh is already running: the job is under a live lease"
        : "the refresh waits out its backoff after a failed attempt",
    );
  }
  const holder = `code-refresh-${process.pid}-${randomBytes(4).toString("hex")}`;
  const claimed = jobs.claim(db, [CODE_REFRESH_JOB_KIND], holder, {
    leaseMs: CODE_REFRESH_LEASE_MS,
    now: opts.now,
  });
  const mine = claimed[0];
  if (mine === undefined) {
    // Сосед захватил между постановкой и захватом — он и поднимет воркер.
    return report(false, put.inserted, row.id, "a neighbor claimed the job first: it starts the worker");
  }
  opts.spawn(opts.dbPath, { id: mine.id, holder });
  return report(true, put.inserted, mine.id, "");
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
    anchor: null as AnchorStepReport | null,
    codeIndex: null as CodeIndexStepReport | null,
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
    const handleOf = (): StoreHandle => (handle ??= openDrainHandle(driver, opts.dbPath, env));

    // Якоря — ПЕРЕД разбором очереди: шаг дешёвый ровно тогда, когда повода
    // нет (один SELECT), а когда повод есть — его результат нужен `ready` и
    // `prime` этого же вызова, а не следующего.
    if (anchorSweepEnabled(env)) {
      try {
        report.anchor = await runAnchorStep(driver, {
          dbPath: opts.dbPath,
          holder,
          env,
          now: now(),
          budgetMs,
          ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
          handle: handleOf,
        });
      } catch (e) {
        // Лестница ходит по ФАЙЛАМ: битая ссылка, пропавший каталог, гонка с
        // git checkout. Отказ фона не имеет права стать отказом команды.
        report.errors.push(`anchor: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Код-индекс — только постановка работы и воркера, ни одного прочитанного
    // файла в этом процессе. Стоит два поиска по ключу, когда повода нет.
    if (codeIndexEnabled(env)) {
      try {
        report.codeIndex = runCodeIndexStep(driver, {
          dbPath: opts.dbPath,
          env,
          now: now(),
          spawn: opts.spawnCodeIndex ?? fakeCodeIndexSpawnFromEnv(env) ?? spawnCodeIndexWorker,
        });
      } catch (e) {
        report.errors.push(`code_index: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

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
            session ??= drainAbsorbSession(handleOf(), now());
            await absorbOne(session, job.entity_id);
          }
        } else if (job.kind === "compact") {
          // runWalCheckpointJob сам снимает строку при ПОЛНОМ переносе WAL;
          // недоделанный checkpoint обязан остаться в очереди — это fail,
          // а не complete (контракт checkpoint.ts).
          const r = runWalCheckpointJob(db);
          if (!r.complete) throw new Error("WAL not fully checkpointed (busy)");
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
  // База — та же, что открыла команда: подъём к первому `.myc/myc.db`, из git
  // worktree — через основное дерево. Прежде здесь стоял `<cwd>/.myc/myc.db`,
  // и дренаж молча не случался нигде, кроме самого корня воркспейса: агенты
  // во вложенных репозиториях и в worktree orca (cherry — почти все) не
  // разбирали очередь и не поднимали фон вовсе.
  let dbPath = globals.db;
  if (dbPath === undefined) {
    const found = findWorkspaceDb(resolve(globals.directory ?? process.cwd()));
    if (!("dbPath" in found)) return;
    dbPath = found.dbPath;
  }
  try {
    await drainQueueTail({ dbPath, env });
  } catch {
    // дренаж — фон: он уже всё сказал через jobs.last_error и stats
  }
}
