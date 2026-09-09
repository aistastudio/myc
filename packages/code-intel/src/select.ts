/**
 * Выбор реализации код-интеллекта — единственное место, где решается,
 * builtin или graft. См. docs/design/05-code-intelligence.md §6.2 и §12.1.
 *
 * Умолчание — `builtin`, ВЕЗДЕ. Не `auto`: глобальную зависимость убирают
 * ради воспроизводимости, а `auto` возвращает ровно ту болезнь, от которой
 * уходят, — «у меня работает иначе». Поэтому здесь нет и не будет проверки
 * `/.dockerenv`, `CI=true` и прочего определения окружения: поведение
 * одинаково в контейнере, в CI и на ноутбуке, и объяснять нечего.
 *
 * Второе правило — деградация громкая (И2). При `code_intel=graft` и
 * отсутствующем graft выбор НЕ откатывается к builtin: это ошибка
 * конфигурации, `state="missing"`, и команды, которым нужен символ, обязаны
 * отвечать отказом с причиной, а не тихо худшим результатом.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CodeIntelId, CodeIntelState } from "./index.ts";
import { probeL1Files } from "./langs.ts";

// ---------------------------------------------------------------------------
// Режим
// ---------------------------------------------------------------------------

/** Значения ключа `code_intel`. */
export type CodeIntelMode = "auto" | "builtin" | "graft" | "off";

/**
 * Умолчание. Меняется здесь и только здесь; тест сверяет его с §12.1, потому
 * что незаметный дрейф обратно к `auto` — это возврат «у меня работает иначе».
 */
export const DEFAULT_CODE_INTEL_MODE: CodeIntelMode = "builtin";

const MODES: readonly CodeIntelMode[] = ["auto", "builtin", "graft", "off"];

export function isCodeIntelMode(v: unknown): v is CodeIntelMode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

/**
 * Порог версии graft. ЗАГЛУШКА, а не измеренная граница совместимости:
 * документ 05-code-intelligence.md её не называет, и совместимость с ранними
 * версиями никто не проверял. Значение выбрано заведомо мягким — при graft
 * 0.16.0 оно не срабатывает никогда, — чтобы механизм существовал, но не
 * отсекал живых пользователей по выдуманному признаку. Настоящий порог
 * ставится по замеру, когда адаптер graft (memory-5wq6pdexn2wz) будет писаться
 * и станет известно, на какой версии он ломается.
 */
export const MIN_GRAFT_VERSION = "0.1.0";

/** Время жизни кеша детекта (§6.2, `03` §7.4). */
export const DETECT_TTL_MS = 24 * 60 * 60 * 1000;

const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Детект graft
// ---------------------------------------------------------------------------

/**
 * Что нашлось в окружении. Два признака индекса разведены сознательно:
 * бутстрап показывает блок по `graft/INDEX.md` (граф собран), а `init`
 * отвечает «graft найден» и по одному каталогу `graft/` (граф начали
 * собирать). Обёртки ниже сохраняют оба поведения дословно.
 */
export interface GraftProbe {
  /** Путь к бинарю или null. */
  readonly bin: string | null;
  /** Есть `graft/INDEX.md` — граф собран. */
  readonly index: boolean;
  /** Есть каталог `graft/` — сколько бы в нём ни лежало. */
  readonly indexDir: boolean;
  /** Версия бинаря; null — не спрашивали или бинарь не ответил. */
  readonly version: string | null;
}

/**
 * Окружение детекта. Отдельно от `ProbeEnv` бутстрапа: сюда нужны только
 * PATH (по нему сбрасывается кеш) и `which`, а `graftVersion` вызывается
 * лишь при промахе кеша и лишь в режимах, где graft вообще используется.
 */
export interface SelectEnv {
  readonly path: string;
  which(cmd: string): string | null;
  graftVersion?(bin: string): string | null;
  now?(): number;
}

/**
 * PATH читается на каждом обращении, а не защёлкивается при импорте: от него
 * зависит и результат `which`, и хеш, по которому сбрасывается кеш детекта.
 * Захваченное при загрузке модуля значение врало бы в долгоживущем процессе
 * (демон, MCP-сервер) и в тестах, которые PATH подменяют.
 */
export const realSelectEnv: SelectEnv = {
  get path(): string {
    return process.env["PATH"] ?? "";
  },
  which: (cmd) => {
    try {
      return Bun.which(cmd, { PATH: process.env["PATH"] ?? "" });
    } catch {
      return null;
    }
  },
  graftVersion: (bin) => {
    try {
      const r = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
      const m = /(\d+\.\d+\.\d+)/.exec(r.stdout.toString());
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  },
};

/**
 * Единый детект присутствия graft (§7.1). Дёшев: два `existsSync` и один
 * `which`, ни одного порождённого процесса — поэтому зовётся напрямую и без
 * кеша из бутстрапа и `init`, которым нужно лишь показать найденное.
 * Версию (единственное, что стоит spawn) спрашивает `selectCodeIntel`.
 */
export function probeGraftPresence(dir: string, env: SelectEnv): GraftProbe {
  return {
    bin: env.which("graft"),
    index: existsSync(join(dir, "graft", "INDEX.md")),
    indexDir: existsSync(join(dir, "graft")),
    version: null,
  };
}

// ---------------------------------------------------------------------------
// Конфиг
// ---------------------------------------------------------------------------

export interface CodeIntelConfig {
  readonly code_intel?: string;
}

/** Откуда взялся режим — идёт в `reason`, чтобы «почему так» не гадали. */
export type CodeIntelConfigSource = "env" | "config.json" | "workspace.toml" | "default";

export interface ResolvedConfig {
  readonly mode: CodeIntelMode;
  readonly source: CodeIntelConfigSource;
  /** Значение, которое лежало в конфиге и оказалось не из списка. */
  readonly invalid?: string;
}

/**
 * Читает `code_intel`. Порядок: переменная окружения `MYC_CODE_INTEL`
 * (перекрывает всё — ею пользуются CI и тесты), затем `.myc/config.json`
 * (место из §6.2), затем ключ верхнего уровня `code_intel` в
 * `.myc/workspace.toml` (файл, который уже коммитится и потому даёт
 * воспроизводимость ради которой умолчание и стало `builtin`).
 *
 * Мусор в конфиге не тихо игнорируется: режим берётся умолчательный, но
 * `invalid` уносит исходное значение наверх, и вызывающий обязан сказать.
 */
export function readCodeIntelConfig(
  dir: string,
  envVars: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedConfig {
  const fromEnv = envVars["MYC_CODE_INTEL"];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (isCodeIntelMode(fromEnv)) return { mode: fromEnv, source: "env" };
    return { mode: DEFAULT_CODE_INTEL_MODE, source: "default", invalid: fromEnv };
  }

  const jsonPath = join(dir, ".myc", "config.json");
  if (existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as CodeIntelConfig;
      const v = raw.code_intel;
      if (typeof v === "string" && v !== "") {
        if (isCodeIntelMode(v)) return { mode: v, source: "config.json" };
        return { mode: DEFAULT_CODE_INTEL_MODE, source: "default", invalid: v };
      }
    } catch {
      // битый config.json — не повод ронять команду; остаётся умолчание
    }
  }

  const tomlPath = join(dir, ".myc", "workspace.toml");
  if (existsSync(tomlPath)) {
    try {
      const m = /^code_intel\s*=\s*"([a-z]+)"/m.exec(readFileSync(tomlPath, "utf8"));
      const v = m?.[1];
      if (v !== undefined) {
        if (isCodeIntelMode(v)) return { mode: v, source: "workspace.toml" };
        return { mode: DEFAULT_CODE_INTEL_MODE, source: "default", invalid: v };
      }
    } catch {
      // как выше
    }
  }

  return { mode: DEFAULT_CODE_INTEL_MODE, source: "default" };
}

// ---------------------------------------------------------------------------
// Кеш детекта: .myc/state.json
// ---------------------------------------------------------------------------

interface DetectCacheEntry {
  readonly at: number;
  readonly path_hash: string;
  readonly bin: string | null;
  readonly index: boolean;
  readonly index_dir: boolean;
  readonly version: string | null;
}

interface StateFile {
  v?: number;
  code_intel?: DetectCacheEntry;
  [k: string]: unknown;
}

export function statePath(dir: string): string {
  return join(dir, ".myc", "state.json");
}

/** FNV-1a: PATH бывает длинным, а нужен только признак «сменился». */
function hashPath(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function readState(dir: string): StateFile {
  try {
    const raw = JSON.parse(readFileSync(statePath(dir), "utf8")) as StateFile;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw;
  } catch {
    // нет файла или он битый — детект просто пройдёт заново
  }
  return {};
}

function readDetectCache(dir: string, pathHash: string, now: number): GraftProbe | null {
  const state = readState(dir);
  const e = state.code_intel;
  if (state.v !== STATE_VERSION || e === undefined) return null;
  if (e.path_hash !== pathHash) return null; // PATH сменился — graft мог появиться
  if (!(typeof e.at === "number") || now - e.at >= DETECT_TTL_MS || now < e.at) return null;
  return {
    bin: e.bin ?? null,
    index: e.index === true,
    indexDir: e.index_dir === true,
    version: e.version ?? null,
  };
}

function writeDetectCache(dir: string, pathHash: string, now: number, probe: GraftProbe): boolean {
  try {
    const mycDir = join(dir, ".myc");
    if (!existsSync(mycDir)) return false; // нет воркспейса — некуда и незачем
    // Читаем-сливаем-пишем: state.json общий, ключи соседей затирать нельзя.
    const state = readState(dir);
    state.v = STATE_VERSION;
    state.code_intel = {
      at: now,
      path_hash: pathHash,
      bin: probe.bin,
      index: probe.index,
      index_dir: probe.indexDir,
      version: probe.version,
    };
    mkdirSync(mycDir, { recursive: true });
    writeFileSync(statePath(dir), JSON.stringify(state), "utf8");
    return true;
  } catch {
    return false; // read-only ФС — не повод ронять команду
  }
}

// ---------------------------------------------------------------------------
// Выбор
// ---------------------------------------------------------------------------

/** Коды деградации (§6.3). Уходят в `meta.degraded[]` любой поверхности. */
export const CODE_INTEL_DEGRADED = {
  /** `auto` не нашёл graft и работает на builtin. */
  builtin: "code_intel_builtin",
  /** `graft` запрошен явно и не найден — ошибка конфигурации, не фолбэк. */
  missing: "code_intel_missing",
  /** graft найден, но версия старше минимальной. */
  incompatible: "code_intel_incompatible",
  /** Код-интеллект выключен целиком. */
  off: "code_intel_off",
  /** В конфиге было не то значение. */
  badConfig: "code_intel_bad_config",
} as const;

export interface CodeIntelSelection {
  readonly mode: CodeIntelMode;
  /** Какую реализацию просили; при `off` — null. */
  readonly id: CodeIntelId | null;
  /** `off` отдельным состоянием: это осознанный выбор, а не поломка. */
  readonly state: CodeIntelState | "off";
  /** Откуда взялся режим. */
  readonly source: CodeIntelConfigSource;
  /** Одна строка «почему так» для человека — в `init`, `doctor` и WARN. */
  readonly reason: string;
  /** Коды для `meta.degraded[]`; пустой массив — всё в порядке. */
  readonly degraded: readonly string[];
  /** Что нашли; null — не искали (builtin/off не трогают PATH вовсе). */
  readonly graft: GraftProbe | null;
  readonly cache: "hit" | "miss" | "off";
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * ЧЕСТНАЯ СТРОКА ПРО BUILTIN (И2). До этого здесь стояло «символы и fan_in по
 * тексту» — обещание, которое строка давала ВСЕГДА: и репозиторию на python,
 * где определений не будет никогда (§5, уровень L1 — только ts/tsx/js/jsx), и
 * репозиторию, где индекс ещё не построен (`code_files` пуст, и до
 * `myc code index` символ не найдётся ни один). Обещание, которое читатель
 * проверить не может, — ровно то, что И2 называет ложью.
 *
 * Поэтому строка спрашивает дерево: есть ли в нём хоть один L1-файл. Проба
 * обрывается на ПЕРВОМ таком файле (в TS-репозитории это первые же записи) и
 * ограничена потолком в дереве без них — цена одной строки отчёта, а не скан
 * индекса.
 */
function builtinAbility(dir: string): string {
  const probe = probeL1Files(dir);
  if (probe.found) {
    return "символы и fan_in по тексту для ts/tsx/js/jsx — после `myc code index` (фон собирает сам, когда в репозитории есть якоря)";
  }
  const seen = probe.langs.length > 0 ? ` (видно: ${probe.langs.slice(0, 5).join(", ")})` : "";
  const how = probe.capped ? `в первых ${probe.seen} файлах нет` : "нет";
  return `файлов ts/tsx/js/jsx ${how}${seen} — символов и fan_in не будет (якоря, протухание и ре-привязка работают на любом языке)`;
}

/**
 * Единственное место выбора (§6.2).
 *
 * - `builtin` (умолчание) и `off` не трогают ни PATH, ни `graft/`: graft не
 *   спавнится, даже если установлен, и кеш детекта не пишется.
 * - `auto` детектит (через кеш на 24 ч со сбросом по хешу PATH) и берёт
 *   graft, если найден и совместим; иначе builtin — ГРОМКО, кодом
 *   `code_intel_builtin`.
 * - `graft` детектит и, если не найдено, отдаёт `state="missing"` с id
 *   `graft`. Откат к builtin здесь запрещён: пользователь попросил конкретную
 *   реализацию, и «я тихо дал другую» — ровно то, что И2 называет ложью.
 */
export function selectCodeIntel(
  dir: string,
  env: SelectEnv,
  config?: ResolvedConfig | CodeIntelMode,
): CodeIntelSelection {
  const resolved: ResolvedConfig =
    config === undefined
      ? readCodeIntelConfig(dir)
      : typeof config === "string"
        ? { mode: config, source: "default" }
        : config;
  const { mode, source } = resolved;
  const badConfig = resolved.invalid !== undefined ? [CODE_INTEL_DEGRADED.badConfig] : [];
  const badReason =
    resolved.invalid !== undefined
      ? ` (в конфиге было code_intel="${resolved.invalid}" — не из auto|builtin|graft|off)`
      : "";

  if (mode === "off") {
    return {
      mode,
      id: null,
      state: "off",
      source,
      reason: `код-интеллект выключен (code_intel=off): работает только уровень anchor${badReason}`,
      degraded: [CODE_INTEL_DEGRADED.off, ...badConfig],
      graft: null,
      cache: "off",
    };
  }

  if (mode === "builtin") {
    return {
      mode,
      id: "builtin",
      state: "ok",
      source,
      reason: `builtin (code_intel=builtin${source === "default" ? ", умолчание" : ""}): ${builtinAbility(dir)}, callers/search/map недоступны${badReason}`,
      degraded: badConfig,
      graft: null,
      cache: "off",
    };
  }

  // auto и graft: детектим. Кеш — только здесь.
  const now = env.now?.() ?? Date.now();
  const pathHash = hashPath(env.path);
  let cache: "hit" | "miss" | "off" = "hit";
  let probe = readDetectCache(dir, pathHash, now);
  if (probe === null) {
    const found = probeGraftPresence(dir, env);
    const version =
      found.bin !== null && env.graftVersion !== undefined ? env.graftVersion(found.bin) : null;
    probe = { ...found, version };
    cache = writeDetectCache(dir, pathHash, now, probe) ? "miss" : "off";
  }

  const incompatible =
    probe.bin !== null && probe.version !== null && cmpVersion(probe.version, MIN_GRAFT_VERSION) < 0;

  if (mode === "graft") {
    if (probe.bin === null) {
      return {
        mode,
        id: "graft",
        state: "missing",
        source,
        reason: `graft запрошен (code_intel=graft), но не найден в PATH — это ошибка конфигурации, не повод молча работать на builtin: поставьте graft или смените ключ на builtin/auto${badReason}`,
        degraded: [CODE_INTEL_DEGRADED.missing, ...badConfig],
        graft: probe,
        cache,
      };
    }
    if (incompatible) {
      return {
        mode,
        id: "graft",
        state: "incompatible",
        source,
        reason: `graft ${probe.version} старше минимальной ${MIN_GRAFT_VERSION} (code_intel=graft): обновите graft или смените ключ${badReason}`,
        degraded: [CODE_INTEL_DEGRADED.incompatible, ...badConfig],
        graft: probe,
        cache,
      };
    }
    return {
      mode,
      id: "graft",
      state: probe.index ? "ok" : "stale",
      source,
      reason: probe.index
        ? `graft ${probe.version ?? "?"} (code_intel=graft): все возможности${badReason}`
        : `graft ${probe.version ?? "?"} есть, индекса graft/INDEX.md нет (code_intel=graft): соберите его командой graft build${badReason}`,
      degraded: badConfig,
      graft: probe,
      cache,
    };
  }

  // auto
  if (probe.bin === null) {
    return {
      mode,
      id: "builtin",
      state: "ok",
      source,
      reason: `graft не найден (code_intel=auto) — работаем на builtin: ${builtinAbility(dir)}, callers/search/map недоступны${badReason}`,
      degraded: [CODE_INTEL_DEGRADED.builtin, ...badConfig],
      graft: probe,
      cache,
    };
  }
  if (incompatible) {
    return {
      mode,
      id: "builtin",
      state: "ok",
      source,
      reason: `graft ${probe.version} старше минимальной ${MIN_GRAFT_VERSION} (code_intel=auto) — работаем на builtin: ${builtinAbility(dir)}, callers/search/map недоступны${badReason}`,
      degraded: [CODE_INTEL_DEGRADED.incompatible, CODE_INTEL_DEGRADED.builtin, ...badConfig],
      graft: probe,
      cache,
    };
  }
  return {
    mode,
    id: "graft",
    state: probe.index ? "ok" : "stale",
    source,
    reason: probe.index
      ? `graft ${probe.version ?? "?"} найден (code_intel=auto): все возможности${badReason}`
      : `graft ${probe.version ?? "?"} найден, индекса graft/INDEX.md нет (code_intel=auto): graft build${badReason}`,
    degraded: badConfig,
    graft: probe,
    cache,
  };
}

/** Короткая строка для вывода команды: «какая реализация и почему». */
export function renderSelection(s: CodeIntelSelection): string {
  const label = s.id === null ? "off" : s.id;
  return `${label} · ${s.reason}`;
}
