/**
 * Проверка обновлений myc: единственное место во всём CLI, откуда уходит
 * запрос в сеть, и единственное, которому это разрешено.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ФУНКЦИЯ В КОМАНДЕ. Инвариант И1 запрещает
 * сеть в горячем пути, а бюджеты, на которых он держится, измерены: prime p99
 * 0.70 мс при потолке 30, чтение 0.011, поиск 9.1. Один синхронный запрос к
 * реестру — это сотни миллисекунд, то есть не «медленнее», а другой порядок:
 * горячий путь перестаёт существовать. Отдельный модуль делает инвариант
 * ПРОВЕРЯЕМЫМ: замыкание импортов команд горячего пути не имеет права его
 * содержать, и это утверждает тест (update-check.hot-path.test.ts), а не
 * обещание в комментарии.
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, ЗАФИКСИРОВАННЫЕ ЗДЕСЬ.
 *
 * 1. КОГДА. Сеть трогает только `myc version --check` — команда, которую
 *    набирает человек. Автоматическая проверка существует, но она (а) по
 *    умолчанию ВЫКЛЮЧЕНА, (б) включается одной переменной `MYC_UPDATE_CHECK=1`,
 *    (в) даже включённой не выполняется в вызвавшем процессе: поднимается
 *    ОТСОЕДИНЁННЫЙ `myc version --check` (приём spawnReindexWorker из drain.ts),
 *    который пишет только в кеш, а вызвавшая команда не ждёт ничего и печатает
 *    то, что лежало в кеше от прошлой проверки. Частота — не чаще раза в сутки
 *    (UPDATE_CHECK_TTL_MS), и точка подключения — только `init` и `wire`,
 *    то есть человеческие церемонии настройки, а не работа агента.
 *
 * 2. КАК СООБЩАТЬ. Никогда в prime/ready/recall/show/list: их читает агент, а
 *    обновление касается человека, и лишняя строка в prime — это ещё и
 *    выброшенные из бюджета символы. Сообщаем в `myc version` (всегда, из
 *    кеша, без сети) и одной хвостовой строкой в человеческом выводе `init`
 *    и `wire`. В `--json` строки нет вовсе: конверт читает агент.
 *
 * 3. АВТООБНОВЛЕНИЯ ЗДЕСЬ НЕТ, и это решение, а не недоделка. Подмена бинаря
 *    под работающим агентом — смена поведения посреди сессии: аренда задачи
 *    взята одной версией, снимать её будет другая, а между ними может лежать
 *    миграция схемы (SCHEMA_VERSION). Проверка печатает точную команду
 *    обновления и на этом останавливается.
 *
 * 4. ОТКЛЮЧАЕМОСТЬ — В ДВЕ СТОРОНЫ, И ОБЕ ОБЯЗАТЕЛЬНЫ. Переменная
 *    `MYC_UPDATE_CHECK=0|off|false|no` запрещает сеть даже явному `--check`
 *    (политика закрытого контура сильнее желания вызывающего), флаг
 *    `--offline` делает то же для одного вызова. Запрет виден как СТАТУС
 *    `disabled` с названной причиной — не как «обновлений нет».
 *
 * И2 (ГРОМКАЯ ДЕГРАДАЦИЯ) — ГЛАВНОЕ ЗДЕСЬ. «Реестр недоступен» и «обновлений
 * нет» — разные новости, и вторая на месте первой это прямая ложь, которую
 * невозможно заметить: она выглядит ровно как хорошая. Поэтому исходов ШЕСТЬ,
 * а не два, и `unreachable` не сворачивается в `up_to_date` ни при таймауте,
 * ни при 404, ни при битом JSON, ни при неразобранной версии.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareSemver } from "@myc/core";

/** Публикуемое имя пакета. Сверяется с манифестом scripts/pack-npm.ts тестом. */
export const PACKAGE_NAME = "@aistastudio/myc";

/** Реестр npm. Абстрактная метаданными точка — переопределяется переменной. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Раз в сутки — потолок частоты АВТОМАТИЧЕСКОЙ проверки, не явной. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Сколько ждём реестр. Дольше — не «надёжнее», а просто дольше висит. */
export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 3_000;

/** Как обновляются: печатается рядом с вердиктом, чтобы не искать. */
export const UPGRADE_COMMAND = `bun install -g ${PACKAGE_NAME}`;

/**
 * Режим проверки.
 *  * `off`    — сеть запрещена совсем, включая явный `--check`;
 *  * `manual` — УМОЛЧАНИЕ: сеть только по явному `myc version --check`;
 *  * `auto`   — плюс фоновая отсоединённая проверка из `init`/`wire`.
 *
 * ПОЧЕМУ УМОЛЧАНИЕ `manual`, А НЕ `auto`. Три довода, и все три — про цену
 * ошибки в каждую сторону. Первый: `myc` вызывает не человек, а агент, в
 * цикле, десятки раз за сессию, в том числе на CI-раннерах; исходящее
 * соединение, которого никто не просил, из непривязанного к терминалу
 * процесса — ровно то, что закрытый контур запрещает, и заметят его не в
 * тот день, когда включили, а в тот, когда упрётся аудит. Второй: `myc init
 * --help` обещает «zero network calls», и умолчание `auto` сделало бы это
 * обещание ложным. Третий — асимметрия: цена умолчания `manual` это одна
 * команда, которую человек набирает сам (и `myc version` прямо говорит, что
 * проверка не выполнялась и как её выполнить), цена умолчания `auto` —
 * необъявленный сетевой запрос с каждой машины и каждого раннера. Включение
 * стоит одной переменной, и она названа в выводе `myc version`.
 */
export type UpdateMode = "off" | "manual" | "auto";

export function updateCheckMode(env: NodeJS.ProcessEnv = process.env): UpdateMode {
  const raw = (env.MYC_UPDATE_CHECK ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return "off";
  if (raw === "1" || raw === "on" || raw === "true" || raw === "yes" || raw === "auto") {
    return "auto";
  }
  return "manual";
}

/**
 * Шесть исходов, а не два. `unreachable` НИКОГДА не сворачивается в
 * `up_to_date`: это разные новости, и подмена одной другой не находится.
 */
export type UpdateStatus =
  /** В реестре версия строго новее собранной. */
  | "update_available"
  /** Реестр ответил, версия совпала или старше — обновляться некуда. */
  | "up_to_date"
  /** Локальная НОВЕЕ реестра: собрана из исходников, ещё не опубликована. */
  | "ahead"
  /** Не смогли проверить: сеть, таймаут, код ответа, битый JSON, битая версия. */
  | "unreachable"
  /** Запрещено политикой: переменная или флаг. Не «обновлений нет». */
  | "disabled"
  /** Сети не касались и кеша нет. Ровно «не знаем», без домыслов. */
  | "never_checked";

export interface UpdateVerdict {
  readonly status: UpdateStatus;
  readonly current: string;
  /** Версия из реестра. Есть только у трёх «ответивших» исходов. */
  readonly latest?: string;
  /** Откуда вердикт: живой запрос, кеш на диске или ниоткуда. */
  readonly source: "network" | "cache" | "none";
  /** Когда реестр отвечал в последний раз (ms epoch). */
  readonly checked_at?: number;
  readonly age_ms?: number;
  /** Причина — ТОЛЬКО у `unreachable` и `disabled`. Молчаливых отказов нет. */
  readonly reason?: string;
  /** Команда обновления — только когда есть куда обновляться. */
  readonly upgrade?: string;
}

/** Строка кеша на диске. `latest: null` — последняя попытка не удалась. */
export interface UpdateCacheEntry {
  readonly package: string;
  readonly latest: string | null;
  /** Момент ПОПЫТКИ (успешной или нет) — им же меряется TTL. */
  readonly checked_at: number;
  /** Текст отказа последней попытки; null у успешной. */
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Кеш на диске
// ---------------------------------------------------------------------------

/**
 * `~/.myc/update-check.json` (MYC_HOME — override, как у personalHome в
 * wsfind.ts). Кеш ЛИЧНЫЙ, а не проектный: обновляется инструмент, а не
 * воркспейс, и класть его в `.myc/` проекта значило бы ходить в реестр
 * заново из каждой копии и однажды закоммитить.
 */
export function updateCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.MYC_HOME ?? homedir(), ".myc", "update-check.json");
}

export function readUpdateCache(
  env: NodeJS.ProcessEnv = process.env,
): UpdateCacheEntry | null {
  const path = updateCachePath(env);
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateCacheEntry>;
    if (typeof raw.checked_at !== "number" || !Number.isFinite(raw.checked_at)) return null;
    if (raw.package !== PACKAGE_NAME) return null; // кеш от другого пакета — не наш
    const latest = typeof raw.latest === "string" ? raw.latest : null;
    const error = typeof raw.error === "string" ? raw.error : null;
    return { package: PACKAGE_NAME, latest, checked_at: raw.checked_at, error };
  } catch {
    // Битый кеш — это «не проверяли», а не «обновлений нет».
    return null;
  }
}

/** Запись кеша НИКОГДА не роняет вызывающего: кеш — удобство, не истина. */
export function writeUpdateCache(
  entry: UpdateCacheEntry,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = updateCachePath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Вердикт из версии реестра
// ---------------------------------------------------------------------------

/**
 * Сравнение — через compareSemver (числами). `null` от него это ТРЕТИЙ исход:
 * версию не прочитали, значит не смогли проверить, а не «всё свежо».
 */
export function verdictFromLatest(
  current: string,
  latest: string,
  base: Omit<UpdateVerdict, "status" | "current" | "latest" | "upgrade">,
): UpdateVerdict {
  const cmp = compareSemver(latest, current);
  if (cmp === null) {
    return {
      ...base,
      status: "unreachable",
      current,
      reason: `реестр вернул версию, которую не удалось разобрать: ${JSON.stringify(latest)}`,
    };
  }
  if (cmp === 1) {
    return { ...base, status: "update_available", current, latest, upgrade: UPGRADE_COMMAND };
  }
  return { ...base, status: cmp === -1 ? "ahead" : "up_to_date", current, latest };
}

// ---------------------------------------------------------------------------
// Запрос к реестру
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface ProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

export type RegistryProbe =
  | { readonly ok: true; readonly latest: string }
  | { readonly ok: false; readonly reason: string };

export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.MYC_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  // Область пакета кодируется: `@scope/name` → `@scope%2fname`.
  return `${base}/${PACKAGE_NAME.replace("/", "%2f")}`;
}

export function updateCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYC_UPDATE_CHECK_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
}

/**
 * Спросить у реестра `dist-tags.latest`. Заголовок `application/vnd.npm.
 * install-v1+json` просит СОКРАЩЁННЫЙ документ: полный пакумент растёт с
 * каждым релизом до сотен килобайт, сокращённый — единицы.
 *
 * Каждый отказ возвращается ПРИЧИНОЙ, а не пустотой: вызывающему нужно
 * напечатать, ЧТО именно не получилось (И2).
 */
export async function probeRegistry(opts: ProbeOptions = {}): Promise<RegistryProbe> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? updateCheckTimeoutMs(env);
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = registryUrl(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return { ok: false, reason: `реестр ответил ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, reason: `ответ реестра не разобрался как JSON: ${message(e)}` };
    }
    const tags = (body as { "dist-tags"?: Record<string, unknown> } | null)?.["dist-tags"];
    const latest = tags?.["latest"];
    if (typeof latest !== "string" || latest.length === 0) {
      return { ok: false, reason: "в ответе реестра нет dist-tags.latest" };
    }
    return { ok: true, latest };
  } catch (e) {
    const reason =
      e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
        ? `реестр не ответил за ${timeoutMs} мс`
        : `сеть недоступна: ${message(e)}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Вердикты: из кеша (без сети) и живой проверкой
// ---------------------------------------------------------------------------

export interface VerdictOptions {
  readonly current: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: number;
  /** `--offline`: запрет на сеть для ОДНОГО вызова, наравне с переменной. */
  readonly offline?: boolean;
}

/**
 * Вердикт БЕЗ СЕТИ: только чтение кеша. Это то, что печатают `myc version`,
 * `init` и `wire` — единственный путь, разрешённый вне явной проверки.
 * Стоимость — один `existsSync` + чтение нескольких сотен байт.
 */
export function cachedVerdict(opts: VerdictOptions): UpdateVerdict {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const mode = updateCheckMode(env);
  if (opts.offline === true || mode === "off") {
    return { status: "disabled", current: opts.current, source: "none", reason: disabledReason(env, opts.offline === true) };
  }
  const entry = readUpdateCache(env);
  if (entry === null) {
    return { status: "never_checked", current: opts.current, source: "none" };
  }
  const age = Math.max(0, now - entry.checked_at);
  if (entry.latest === null) {
    return {
      status: "unreachable",
      current: opts.current,
      source: "cache",
      checked_at: entry.checked_at,
      age_ms: age,
      reason: entry.error ?? "прошлая попытка не удалась, причина не записана",
    };
  }
  return verdictFromLatest(opts.current, entry.latest, {
    source: "cache",
    checked_at: entry.checked_at,
    age_ms: age,
  });
}

/** Причина запрета — коротко и по имени: её печатают ПОСЛЕ слова «выключена». */
function disabledReason(env: NodeJS.ProcessEnv, offlineFlag: boolean): string {
  if (offlineFlag) return "флаг --offline запрещает сеть в этом вызове";
  return `переменная MYC_UPDATE_CHECK=${JSON.stringify(env.MYC_UPDATE_CHECK ?? "")}`;
}

export interface CheckOptions extends VerdictOptions, ProbeOptions {}

/**
 * ЖИВАЯ проверка: единственная функция во всём CLI, после которой уходит
 * пакет. Зовётся только из обработчика `myc version --check`.
 *
 * Кеш здесь НЕ ЩАДИТСЯ: человек набрал `--check` руками, и отдать ему
 * вчерашний ответ значило бы не сделать то, о чём попросили. Суточный TTL
 * ограничивает АВТОМАТИЧЕСКУЮ проверку (shouldAutoCheck), а не эту.
 */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateVerdict> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const mode = updateCheckMode(env);
  if (opts.offline === true || mode === "off") {
    // Политика сильнее вызывающего, и отказ ГРОМКИЙ: статус `disabled` с
    // названной причиной, а не молчаливое «обновлений нет».
    return {
      status: "disabled",
      current: opts.current,
      source: "none",
      reason: disabledReason(env, opts.offline === true),
    };
  }

  const probe = await probeRegistry(opts);
  if (!probe.ok) {
    writeUpdateCache(
      { package: PACKAGE_NAME, latest: null, checked_at: now, error: probe.reason },
      env,
    );
    return {
      status: "unreachable",
      current: opts.current,
      source: "network",
      checked_at: now,
      age_ms: 0,
      reason: probe.reason,
    };
  }

  const verdict = verdictFromLatest(opts.current, probe.latest, {
    source: "network",
    checked_at: now,
    age_ms: 0,
  });
  writeUpdateCache(
    {
      package: PACKAGE_NAME,
      // Неразобранную версию в кеш не кладём: иначе следующий вызов покажет
      // её как «проверено» — тот же класс молчаливой лжи.
      latest: verdict.status === "unreachable" ? null : probe.latest,
      checked_at: now,
      error: verdict.status === "unreachable" ? (verdict.reason ?? null) : null,
    },
    env,
  );
  return verdict;
}

// ---------------------------------------------------------------------------
// Фоновая проверка: отсоединённый процесс, вызывающий не ждёт ничего
// ---------------------------------------------------------------------------

/** Пора ли автоматической проверке: режим `auto` и кеш старше суток. */
export function shouldAutoCheck(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  if (updateCheckMode(env) !== "auto") return false;
  const entry = readUpdateCache(env);
  if (entry === null) return true;
  return now - entry.checked_at >= UPDATE_CHECK_TTL_MS;
}

/**
 * Поднять ОТСОЕДИНЁННУЮ проверку и немедленно вернуться. Приём дословно тот
 * же, что у spawnReindexWorker в drain.ts: argv от process.execPath, spawn без
 * await, detached + unref. Вызвавшая команда не ждёт ни сети, ни процесса —
 * её латентность не меняется вовсе, а результат увидит СЛЕДУЮЩИЙ человеческий
 * вывод, прочитав кеш.
 *
 * Возвращает true, только если процесс действительно поднят: это же значение
 * читает тест, чтобы отличить «не стали» от «не смогли».
 */
export function maybeSpawnUpdateCheck(
  env: NodeJS.ProcessEnv = process.env,
  spawn: (argv: string[]) => void = spawnDetachedCheck,
): boolean {
  // Под тестом фон не поднимается никогда — ловушка S51: спавнящие тесты
  // собирают окружение белым списком, поэтому выключатель MYC_UPDATE_CHECK
  // внесён в BACKGROUND_SWITCHES (@myc/core/test-env.ts).
  if (process.env.NODE_ENV === "test" && env.MYC_UPDATE_CHECK !== "1") return false;
  if (!shouldAutoCheck(env)) return false;
  try {
    const entry = process.argv[1];
    const fromSource = typeof entry === "string" && /\.(ts|js|mjs)$/.test(entry);
    spawn([
      process.execPath,
      ...(fromSource ? [entry] : []),
      "version",
      "--check",
      "--quiet",
    ]);
    return true;
  } catch {
    // Не поднялся — вердикт останется вчерашним, и это видно по возрасту
    // в выводе `myc version`. Падать здесь нечему.
    return false;
  }
}

function spawnDetachedCheck(argv: string[]): void {
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Проверка обязана пережить команду, которая её позвала, — иначе она
    // умрёт вместе с `myc wire` через 20 мс и не допишет кеш никогда.
    detached: true,
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Человеческая строка
// ---------------------------------------------------------------------------

function ageHuman(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} мин назад`;
  if (h < 48) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

/**
 * Одна строка для человека — или `null`, когда сказать нечего.
 *
 * `up_to_date` и `ahead` молчат ОСОЗНАННО: «у вас всё свежо» это шум в каждом
 * `init` и `wire`. `unreachable` НЕ молчит — «не смогли проверить» человек
 * обязан увидеть, иначе он решит, что проверили.
 */
export function updateNotice(v: UpdateVerdict): string | null {
  const age = v.age_ms !== undefined && v.source === "cache" ? ` (${ageHuman(v.age_ms)})` : "";
  switch (v.status) {
    case "update_available":
      return `обновление: ${v.current} → ${v.latest}${age} · ${UPGRADE_COMMAND}`;
    case "unreachable":
      return `обновления не проверены: ${v.reason}${age}`;
    case "never_checked":
      return "обновления не проверялись — `myc version --check`";
    case "disabled":
    case "up_to_date":
    case "ahead":
      return null;
  }
}

/**
 * Готовая строка для человеческого вывода `init`/`wire`: вердикт из кеша
 * (без сети) плюс его форматирование. Отдельная функция ровно затем, чтобы
 * точка подключения в чужой команде была ОДНОЙ строкой и не расползалась.
 */
export function updateNoticeFor(
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    return updateNotice(cachedVerdict({ current, env }));
  } catch {
    // Уведомление — украшение чужого вывода; уронить его оно не имеет права.
    return null;
  }
}
